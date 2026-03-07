// src/graph-rag/qdrant.store.ts
//
// Qdrant Vector Storage Layer — encapsulates all Qdrant interactions.
//
// Provides: collection lifecycle, chunk upsert with embeddings, semantic
// similarity search (filtered by repoId), stored-hash retrieval for the
// diff engine, stale-chunk deletion, bulk filter-based repo deletion,
// and full collection teardown.  The GraphRagService talks exclusively
// to this class — never to the Qdrant client directly.

import { QdrantClient } from "@qdrant/js-client-rest";
import { logger } from "../utils/logger";
import { computeHash } from "./diff.engine";
import type { ParsedChunk } from "../interfaces/triage.interface";
import type {
  QdrantChunkPayload,
  EmbedFunction,
  EmbedBatchFunction,
} from "../interfaces/graph-rag.interface";

const LOG_CTX = "QdrantStore";
const UPSERT_BATCH_SIZE = 64;

export class QdrantStore {
  private readonly client: QdrantClient;
  private readonly collectionName: string;
  private readonly embeddingDimension: number;

  constructor(
    url: string,
    embeddingDimension: number,
    collectionName: string = "code_chunks",
    apiKey?: string,
  ) {
    this.client = new QdrantClient({ url, apiKey, checkCompatibility: false });
    this.collectionName = collectionName;
    this.embeddingDimension = embeddingDimension;
  }

  async ensureCollection(): Promise<void> {
    try {
      const { exists } = await this.client.collectionExists(
        this.collectionName,
      );
      if (exists) {
        logger.debug(
          LOG_CTX,
          `Collection "${this.collectionName}" already exists`,
        );
        return;
      }

      await this.client.createCollection(this.collectionName, {
        vectors: { size: this.embeddingDimension, distance: "Cosine" },
        optimizers_config: { memmap_threshold: 20000 },
        on_disk_payload: false,
      });

      await this.client.createPayloadIndex(this.collectionName, {
        field_name: "repoId",
        field_schema: "keyword",
      });
      await this.client.createPayloadIndex(this.collectionName, {
        field_name: "chunkId",
        field_schema: "keyword",
      });
      await this.client.createPayloadIndex(this.collectionName, {
        field_name: "filePath",
        field_schema: "keyword",
      });

      logger.info(
        LOG_CTX,
        `Created collection "${this.collectionName}" (dim=${this.embeddingDimension}, cosine)`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[QdrantStore] Failed to ensure collection: ${msg}`);
    }
  }

  async getStoredHashes(repoId: string): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();

    try {
      let offset: string | number | undefined = undefined;
      let hasMore = true;

      while (hasMore) {
        const response = await this.client.scroll(this.collectionName, {
          filter: { must: [{ key: "repoId", match: { value: repoId } }] },
          with_payload: { include: ["chunkId", "hash"] },
          with_vector: false,
          limit: 1000,
          ...(offset !== undefined ? { offset } : {}),
        });

        const points = response.points ?? [];
        for (const point of points) {
          const payload = point.payload as Partial<QdrantChunkPayload> | null;
          if (payload?.chunkId && payload?.hash) {
            hashes.set(payload.chunkId, payload.hash);
          }
        }

        const rawOffset = response.next_page_offset;
        offset =
          typeof rawOffset === "string" || typeof rawOffset === "number"
            ? rawOffset
            : undefined;
        hasMore = offset !== undefined && points.length > 0;
      }

      logger.info(
        LOG_CTX,
        `Retrieved ${hashes.size} stored hashes for repo="${repoId}"`,
      );
    } catch (err: unknown) {
      logger.warn(
        LOG_CTX,
        `Could not retrieve stored hashes: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return hashes;
  }

  async upsertChunks(
    chunks: ParsedChunk[],
    repoId: string,
    embedFn: EmbedFunction,
    embedBatchFn?: EmbedBatchFunction,
  ): Promise<void> {
    if (chunks.length === 0) {
      logger.debug(LOG_CTX, "No chunks to upsert — skipping.");
      return;
    }

    logger.info(LOG_CTX, `Upserting ${chunks.length} chunks into Qdrant…`);

    for (let i = 0; i < chunks.length; i += UPSERT_BATCH_SIZE) {
      const batch = chunks.slice(i, i + UPSERT_BATCH_SIZE);
      const batchNum = Math.floor(i / UPSERT_BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(chunks.length / UPSERT_BATCH_SIZE);
      logger.debug(
        LOG_CTX,
        `  Batch ${batchNum}/${totalBatches} (${batch.length} chunks)`,
      );

      const texts = batch.map((c) => buildEmbeddingText(c));

      let embeddings: number[][];
      if (embedBatchFn) {
        embeddings = await embedBatchFn(texts);
      } else {
        embeddings = await Promise.all(texts.map((t) => embedFn(t)));
      }

      const points = batch.map((chunk, idx) => {
        const payload: QdrantChunkPayload = {
          chunkId: chunk.id,
          repoId,
          filePath: chunk.filePath,
          hash: computeHash(chunk),
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          cyclomaticComplexity: chunk.cyclomaticComplexity,
          halsteadVolume: chunk.halsteadVolume,
          smellCount: chunk.smells.length,
          smellTypes: [...new Set(chunk.smells.map((s) => s.type))],
          code: chunk.code,
        };

        return {
          id: deterministicPointId(chunk.id),
          vector: embeddings[idx]!,
          payload: payload as unknown as Record<string, unknown>,
        };
      });

      await this.client.upsert(this.collectionName, { wait: true, points });
    }

    logger.info(LOG_CTX, `Upsert complete: ${chunks.length} chunks stored`);
  }

  async search(
    queryVector: number[],
    repoId: string,
    topK: number = 10,
  ): Promise<ParsedChunk[]> {
    logger.debug(
      LOG_CTX,
      `Searching for top ${topK} chunks in repo="${repoId}"`,
    );

    const results = await this.client.search(this.collectionName, {
      vector: queryVector,
      limit: topK,
      filter: { must: [{ key: "repoId", match: { value: repoId } }] },
      with_payload: true,
      with_vector: false,
      score_threshold: 0.3,
    });

    return results.map((hit) =>
      payloadToChunk(hit.payload as Record<string, unknown>),
    );
  }

  async getChunksByIds(chunkIds: string[]): Promise<ParsedChunk[]> {
    if (chunkIds.length === 0) return [];

    const pointIds = chunkIds.map(deterministicPointId);

    try {
      const points = await this.client.retrieve(this.collectionName, {
        ids: pointIds,
        with_payload: true,
        with_vector: false,
      });

      return points.map((p) =>
        payloadToChunk(p.payload as Record<string, unknown>),
      );
    } catch (err: unknown) {
      logger.warn(
        LOG_CTX,
        `Failed to retrieve chunks by IDs: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  async deleteChunks(chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) return;

    logger.info(
      LOG_CTX,
      `Deleting ${chunkIds.length} stale chunks from Qdrant`,
    );
    const pointIds = chunkIds.map(deterministicPointId);
    await this.client.delete(this.collectionName, {
      wait: true,
      points: pointIds,
    });
  }

  async deleteByRepoId(repoId: string): Promise<void> {
    logger.info(LOG_CTX, `Deleting all vectors for repoId="${repoId}"…`);
    try {
      await this.client.delete(this.collectionName, {
        wait: true,
        filter: { must: [{ key: "repoId", match: { value: repoId } }] },
      });
      logger.info(LOG_CTX, `Deleted all vectors for repoId="${repoId}"`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        LOG_CTX,
        `deleteByRepoId failed for "${repoId}" (collection may not exist): ${msg}`,
      );
    }
  }

  async dropCollection(): Promise<void> {
    await this.client.deleteCollection(this.collectionName);
    logger.warn(LOG_CTX, `Dropped collection "${this.collectionName}"`);
  }
}

function buildEmbeddingText(chunk: ParsedChunk): string {
  const smellSummary =
    chunk.smells.length > 0
      ? `Code smells: ${chunk.smells.map((s) => s.type).join(", ")}.`
      : "No code smells.";

  return [
    `File: ${chunk.filePath}`,
    `Lines ${chunk.startLine}-${chunk.endLine}`,
    `Complexity: ${chunk.cyclomaticComplexity}, Halstead: ${chunk.halsteadVolume}`,
    smellSummary,
    `\n${chunk.code}`,
  ].join("\n");
}

function deterministicPointId(chunkId: string): number {
  const hex = chunkId.replace(/[^a-f0-9]/gi, "").slice(0, 15);
  return parseInt(hex, 16);
}

function payloadToChunk(payload: Record<string, unknown>): ParsedChunk {
  return {
    id: (payload["chunkId"] as string) ?? "",
    code: (payload["code"] as string) ?? "",
    filePath: (payload["filePath"] as string) ?? "",
    startLine: (payload["startLine"] as number) ?? 0,
    endLine: (payload["endLine"] as number) ?? 0,
    imports: [],
    resolvedDeps: [],
    cyclomaticComplexity: (payload["cyclomaticComplexity"] as number) ?? 0,
    halsteadVolume: (payload["halsteadVolume"] as number) ?? 0,
    smells: [],
    cfg: { nodes: 0, edges: 0, unreachableCodeDetected: false },
  };
}

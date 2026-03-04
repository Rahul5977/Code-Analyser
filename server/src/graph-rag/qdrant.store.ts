// ─────────────────────────────────────────────────────────────────────────────
// src/graph-rag/qdrant.store.ts
//
// Qdrant Vector Storage Layer.
//
// Responsibilities:
//   1. Collection lifecycle (create/ensure exists)
//   2. Upserting chunk vectors with rich payloads
//   3. Semantic similarity search (filtered by repoId)
//   4. Retrieving stored hashes for the diff engine
//   5. Deleting stale chunks
//
// All Qdrant interactions are encapsulated here — the GraphRagService
// only talks to this class, never directly to the Qdrant client.
// ─────────────────────────────────────────────────────────────────────────────

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

// ── Batch size for upsert operations (Qdrant recommends ≤100 per call) ───────
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
    this.client = new QdrantClient({
      url,
      apiKey,
      checkCompatibility: false,
    });
    this.collectionName = collectionName;
    this.embeddingDimension = embeddingDimension;
  }

  // ─── Collection Lifecycle ──────────────────────────────────────────────────

  /**
   * Ensures the collection exists with the correct vector config.
   * Uses `collectionExists` check first to avoid errors on re-runs.
   */
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
        vectors: {
          size: this.embeddingDimension,
          distance: "Cosine",
        },
        // Optimisers: keep the index in memory for fast search
        optimizers_config: {
          memmap_threshold: 20000,
        },
        // Enable payload indexing for filtered search
        on_disk_payload: false,
      });

      // Create payload indices for the fields we filter on
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

  // ─── Hash Retrieval (for Diff Engine) ──────────────────────────────────────

  /**
   * Retrieves all stored chunk hashes for a given repoId.
   * Returns a Map<chunkId, hash> used by the diff engine.
   *
   * Uses scroll API to handle repos with >10k chunks.
   */
  async getStoredHashes(repoId: string): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();

    try {
      let offset: string | number | undefined = undefined;
      let hasMore = true;

      while (hasMore) {
        const response = await this.client.scroll(this.collectionName, {
          filter: {
            must: [{ key: "repoId", match: { value: repoId } }],
          },
          with_payload: {
            include: ["chunkId", "hash"],
          },
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

        // Qdrant scroll returns next_page_offset when there are more pages
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
      // If collection doesn't exist yet, return empty (first run)
      logger.warn(
        LOG_CTX,
        `Could not retrieve stored hashes: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return hashes;
  }

  // ─── Upsert ────────────────────────────────────────────────────────────────

  /**
   * Embeds and upserts an array of chunks into Qdrant.
   *
   * @param chunks      - The chunks to upsert (new or updated).
   * @param repoId      - Repository identifier for filtering.
   * @param embedFn     - Single-text embedding function.
   * @param embedBatchFn - Optional batch embedding function for efficiency.
   */
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

    // Process in batches to avoid overwhelming the embedding API and Qdrant
    for (let i = 0; i < chunks.length; i += UPSERT_BATCH_SIZE) {
      const batch = chunks.slice(i, i + UPSERT_BATCH_SIZE);
      const batchNum = Math.floor(i / UPSERT_BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(chunks.length / UPSERT_BATCH_SIZE);

      logger.debug(
        LOG_CTX,
        `  Batch ${batchNum}/${totalBatches} (${batch.length} chunks)`,
      );

      // ── Generate embeddings ──
      // Build a summary text for each chunk that captures semantics
      const texts = batch.map((c) => buildEmbeddingText(c));

      let embeddings: number[][];
      if (embedBatchFn) {
        embeddings = await embedBatchFn(texts);
      } else {
        // Fallback: sequential single-embed calls
        embeddings = await Promise.all(texts.map((t) => embedFn(t)));
      }

      // ── Build Qdrant points ──
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
          // Qdrant expects string or integer IDs; use the chunk's SHA-based ID
          id: deterministicPointId(chunk.id),
          vector: embeddings[idx]!,
          payload: payload as unknown as Record<string, unknown>,
        };
      });

      await this.client.upsert(this.collectionName, {
        wait: true,
        points,
      });
    }

    logger.info(LOG_CTX, `Upsert complete: ${chunks.length} chunks stored`);
  }

  // ─── Search ────────────────────────────────────────────────────────────────

  /**
   * Semantic similarity search.
   *
   * @param queryVector - The embedded query vector.
   * @param repoId      - Filter results to this repository.
   * @param topK        - Number of results to return.
   * @returns           Array of ParsedChunk-like objects reconstructed from payloads.
   */
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
      filter: {
        must: [{ key: "repoId", match: { value: repoId } }],
      },
      with_payload: true,
      with_vector: false,
      score_threshold: 0.3, // minimum cosine similarity
    });

    return results.map((hit) =>
      payloadToChunk(hit.payload as Record<string, unknown>),
    );
  }

  // ─── Retrieve Specific Chunks by ID ────────────────────────────────────────

  /**
   * Retrieves full chunk data for a list of chunk IDs.
   * Used by the hybrid search to hydrate graph neighbors.
   */
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

  // ─── Delete ────────────────────────────────────────────────────────────────

  /**
   * Removes stale chunks that no longer exist in the source.
   */
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

  // ─── Teardown ──────────────────────────────────────────────────────────────

  /**
   * Drops the entire collection.  Use only in tests or full re-index.
   */
  async dropCollection(): Promise<void> {
    await this.client.deleteCollection(this.collectionName);
    logger.warn(LOG_CTX, `Dropped collection "${this.collectionName}"`);
  }
}

// ─── Private Helpers ─────────────────────────────────────────────────────────

/**
 * Builds a semantic-rich text representation of a chunk for embedding.
 * This is what the embedding model sees — we include both code and metadata
 * so the vector captures structural meaning, not just lexical similarity.
 */
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

/**
 * Converts a hex chunk ID string into a deterministic unsigned integer
 * suitable for Qdrant's point ID.
 *
 * Qdrant accepts either UUID strings or unsigned 64-bit integers.
 * We take the first 15 hex chars of the chunk ID and parse as an integer
 * (15 hex chars = 60 bits, fits safely in JS Number and Qdrant u64).
 */
function deterministicPointId(chunkId: string): number {
  // Take first 15 hex chars → parse as base-16 integer (up to 2^60 - 1)
  const hex = chunkId.replace(/[^a-f0-9]/gi, "").slice(0, 15);
  return parseInt(hex, 16);
}

/**
 * Reconstructs a minimal ParsedChunk from a Qdrant payload.
 * Not all fields survive the round-trip (e.g., full smells array),
 * but we reconstruct enough for the GraphRagContext.
 */
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

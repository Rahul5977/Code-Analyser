// src/graph-rag/graph-rag.service.ts
//
// Main GraphRAG Service (Orchestrator).
//
// Manages the lifecycle of both Qdrant (vector) and Neo4j (graph) stores.
// Orchestrates: Diff Engine → selective embed/upsert/prune pipeline,
// hybrid search (vector similarity + graph traversal), repo cleanup
// (parallel filter-based Qdrant delete + batched Cypher), and graceful
// shutdown.  All AI embedding is injected as a dependency so the
// service is model-agnostic.

import { logger } from "../utils/logger";
import { computeDiff } from "./diff.engine";
import { QdrantStore } from "./qdrant.store";
import { Neo4jStore } from "./neo4j.store";

import type { ParsedChunk, TriageResult } from "../interfaces/triage.interface";
import type {
  GraphRagConfig,
  GraphRagContext,
  DiffResult,
  EmbedFunction,
  EmbedBatchFunction,
} from "../interfaces/graph-rag.interface";

const LOG_CTX = "GraphRagService";

export interface SyncReport {
  repoId: string;
  totalChunks: number;
  newChunks: number;
  updatedChunks: number;
  unchangedChunks: number;
  deletedChunks: number;
  durationMs: number;
}

export class GraphRagService {
  private readonly _qdrant: QdrantStore;
  private readonly _neo4j: Neo4jStore;
  private readonly _embedFn: EmbedFunction;
  private readonly embedBatchFn?: EmbedBatchFunction;
  private initialised = false;

  get qdrant(): QdrantStore {
    return this._qdrant;
  }
  get neo4j(): Neo4jStore {
    return this._neo4j;
  }
  get embedFn(): EmbedFunction {
    return this._embedFn;
  }

  constructor(
    config: GraphRagConfig,
    embedFn: EmbedFunction,
    embedBatchFn?: EmbedBatchFunction,
  ) {
    this._qdrant = new QdrantStore(
      config.qdrant.url,
      config.embeddingDimension,
      config.qdrant.collectionName ?? "code_chunks",
      config.qdrant.apiKey,
    );
    this._neo4j = new Neo4jStore(
      config.neo4j.uri,
      config.neo4j.username,
      config.neo4j.password,
      config.neo4j.database ?? "neo4j",
    );
    this._embedFn = embedFn;
    this.embedBatchFn = embedBatchFn;
  }

  async init(): Promise<void> {
    if (this.initialised) return;

    logger.info(LOG_CTX, "Initialising GraphRAG stores…");

    const [, ,] = await Promise.allSettled([
      this.qdrant
        .ensureCollection()
        .then(() => logger.info(LOG_CTX, "  ✔ Qdrant collection ready")),
      this.neo4j
        .verifyConnectivity()
        .then(() => this.neo4j.ensureSchema())
        .then(() => logger.info(LOG_CTX, "  ✔ Neo4j schema ready")),
    ]).then((results) => {
      const failures = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      if (failures.length > 0) {
        const msgs = failures.map((f) =>
          f.reason instanceof Error ? f.reason.message : String(f.reason),
        );
        throw new Error(
          `[GraphRagService] Initialisation failed:\n  ${msgs.join("\n  ")}`,
        );
      }
      return results;
    });

    this.initialised = true;
    logger.info(LOG_CTX, "GraphRAG stores initialised successfully");
  }

  async sync(triageResult: TriageResult, repoId: string): Promise<SyncReport> {
    await this.ensureInitialised();

    const t0 = Date.now();
    const { chunks, adjacencyList } = triageResult;

    logger.info(
      LOG_CTX,
      `Starting sync for repo="${repoId}" (${chunks.length} chunks)`,
    );

    const storedHashes = await this.qdrant.getStoredHashes(repoId);
    logger.debug(
      LOG_CTX,
      `  Retrieved ${storedHashes.size} stored hashes from Qdrant`,
    );

    const diff: DiffResult = computeDiff(chunks, storedHashes);

    const chunksToEmbed = [...diff.newChunks, ...diff.updatedChunks];
    if (chunksToEmbed.length > 0) {
      logger.info(
        LOG_CTX,
        `  Embedding & upserting ${chunksToEmbed.length} chunks into Qdrant…`,
      );
      await this.qdrant.upsertChunks(
        chunksToEmbed,
        repoId,
        this.embedFn,
        this.embedBatchFn,
      );
    } else {
      logger.info(LOG_CTX, "  No chunks to embed — all unchanged.");
    }

    logger.info(LOG_CTX, "  Ingesting knowledge graph into Neo4j…");
    await this.neo4j.ingestGraph(chunks, adjacencyList, repoId);

    if (diff.deletedChunkIds.length > 0) {
      logger.info(
        LOG_CTX,
        `  Pruning ${diff.deletedChunkIds.length} deleted chunks…`,
      );
      await Promise.all([
        this.qdrant.deleteChunks(diff.deletedChunkIds),
        this.neo4j.deleteChunks(diff.deletedChunkIds),
      ]);
    }

    const durationMs = Date.now() - t0;
    const report: SyncReport = {
      repoId,
      totalChunks: chunks.length,
      newChunks: diff.newChunks.length,
      updatedChunks: diff.updatedChunks.length,
      unchangedChunks: diff.unchangedChunkIds.length,
      deletedChunks: diff.deletedChunkIds.length,
      durationMs,
    };

    logger.info(
      LOG_CTX,
      `Sync complete for repo="${repoId}" in ${durationMs}ms — ` +
        `${report.newChunks} new, ${report.updatedChunks} updated, ` +
        `${report.unchangedChunks} unchanged, ${report.deletedChunks} deleted`,
    );

    return report;
  }

  async hybridSearch(
    query: string,
    repoId: string,
    topK: number = 10,
    maxDepth: number = 2,
  ): Promise<GraphRagContext> {
    await this.ensureInitialised();

    const t0 = Date.now();
    logger.info(
      LOG_CTX,
      `Hybrid search for repo="${repoId}" | query="${query.slice(0, 80)}…"`,
    );

    const queryVector = await this.embedFn(query);
    const primaryMatches = await this.qdrant.search(queryVector, repoId, topK);
    logger.debug(
      LOG_CTX,
      `  Vector search returned ${primaryMatches.length} primary matches`,
    );

    if (primaryMatches.length === 0) {
      logger.warn(
        LOG_CTX,
        "  No vector matches found — returning empty context",
      );
      return { query, primaryMatches: [], structuralNeighbors: [] };
    }

    const primaryIds = primaryMatches.map((c) => c.id);
    const primaryIdSet = new Set(primaryIds);

    const neighborIds = await this.neo4j.findStructuralNeighbors(
      primaryIds,
      repoId,
      maxDepth,
    );
    const uniqueNeighborIds = neighborIds.filter((id) => !primaryIdSet.has(id));
    logger.debug(
      LOG_CTX,
      `  Graph expansion found ${uniqueNeighborIds.length} unique neighbors`,
    );

    let structuralNeighbors: ParsedChunk[] = [];
    if (uniqueNeighborIds.length > 0) {
      structuralNeighbors = await this.qdrant.getChunksByIds(uniqueNeighborIds);
    }

    const durationMs = Date.now() - t0;
    logger.info(
      LOG_CTX,
      `Hybrid search complete in ${durationMs}ms — ` +
        `${primaryMatches.length} primary + ${structuralNeighbors.length} neighbors`,
    );

    return { query, primaryMatches, structuralNeighbors };
  }

  async hybridSearchRanked(
    query: string,
    repoId: string,
    topK: number = 10,
    maxDepth: number = 2,
  ): Promise<ParsedChunk[]> {
    const context = await this.hybridSearch(query, repoId, topK, maxDepth);
    const ranked: Array<{ chunk: ParsedChunk; score: number }> = [];

    for (let i = 0; i < context.primaryMatches.length; i++) {
      const chunk = context.primaryMatches[i]!;
      const positionScore = 1.0 - i / (context.primaryMatches.length || 1);
      const smellBonus = chunk.smells.length > 0 ? 0.1 : 0;
      ranked.push({ chunk, score: positionScore + smellBonus });
    }

    for (let i = 0; i < context.structuralNeighbors.length; i++) {
      const chunk = context.structuralNeighbors[i]!;
      const baseScore = 0.5;
      const complexityBonus = Math.min(chunk.cyclomaticComplexity / 20, 0.3);
      const smellBonus = chunk.smells.length > 0 ? 0.1 : 0;
      ranked.push({ chunk, score: baseScore + complexityBonus + smellBonus });
    }

    ranked.sort((a, b) => b.score - a.score);
    return ranked.map((r) => r.chunk);
  }

  async dropRepo(repoId: string): Promise<void> {
    await this.ensureInitialised();
    logger.warn(LOG_CTX, `Dropping all data for repo="${repoId}"…`);

    await Promise.all([
      this.qdrant.deleteByRepoId(repoId),
      this.neo4j.dropRepo(repoId),
    ]);

    logger.info(LOG_CTX, `All data dropped for repo="${repoId}"`);
  }

  async close(): Promise<void> {
    logger.info(LOG_CTX, "Shutting down GraphRAG stores…");
    await this.neo4j.close();
    this.initialised = false;
    logger.info(LOG_CTX, "GraphRAG stores shut down");
  }

  private async ensureInitialised(): Promise<void> {
    if (!this.initialised) {
      await this.init();
    }
  }
}

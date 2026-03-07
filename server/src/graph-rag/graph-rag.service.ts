// ─────────────────────────────────────────────────────────────────────────────
// src/graph-rag/graph-rag.service.ts
//
// Phase 3 – Main GraphRAG Service (Orchestrator).
//
// Responsibilities:
//   1. Initialise & lifecycle-manage both Qdrant and Neo4j stores.
//   2. Orchestrate the Diff Engine → selective embed/upsert/prune pipeline.
//   3. Expose `sync()` to ingest a TriageResult with change sensitivity.
//   4. Expose `hybridSearch()` combining vector similarity + graph traversal.
//   5. Expose `dropRepo()` and `close()` for cleanup.
//
// All AI embedding is injected as a dependency (EmbedFunction / EmbedBatchFunction)
// so the service is model-agnostic.
// ─────────────────────────────────────────────────────────────────────────────

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

// ─── Sync Report ─────────────────────────────────────────────────────────────

/**
 * Summary returned after a `sync()` call.  Useful for logging & telemetry.
 */
export interface SyncReport {
  repoId: string;
  totalChunks: number;
  newChunks: number;
  updatedChunks: number;
  unchangedChunks: number;
  deletedChunks: number;
  durationMs: number;
}

// ─── Service Class ───────────────────────────────────────────────────────────

export class GraphRagService {
  private readonly _qdrant: QdrantStore;
  private readonly _neo4j: Neo4jStore;
  private readonly _embedFn: EmbedFunction;
  private readonly embedBatchFn?: EmbedBatchFunction;
  private initialised = false;

  // ── Public accessors for Phase 4 council integration ──
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

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * One-time initialisation: verifies connectivity and ensures
   * collection / schema exist in both stores.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async init(): Promise<void> {
    if (this.initialised) return;

    logger.info(LOG_CTX, "Initialising GraphRAG stores…");

    // Run both in parallel — they are independent
    const [, ,] = await Promise.allSettled([
      this.qdrant
        .ensureCollection()
        .then(() => logger.info(LOG_CTX, "  ✔ Qdrant collection ready")),
      this.neo4j
        .verifyConnectivity()
        .then(() => this.neo4j.ensureSchema())
        .then(() => logger.info(LOG_CTX, "  ✔ Neo4j schema ready")),
    ]).then((results) => {
      // If either store failed, throw a combined error
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

  // ─── Sync (Diff → Embed → Upsert → Graph Ingest → Prune) ─────────────────

  /**
   * Full synchronisation of a TriageResult into the vector + graph stores.
   *
   * Pipeline steps:
   *   1. Retrieve stored hashes from Qdrant (authoritative source).
   *   2. Compute diff (new / updated / unchanged / deleted).
   *   3. Embed & upsert new + updated chunks into Qdrant.
   *   4. Ingest all chunks (new + updated + unchanged) into Neo4j graph.
   *   5. Prune deleted chunks from both stores.
   *
   * @param triageResult - Output from Phase 2 parser.
   * @param repoId       - Unique identifier for the repository.
   * @returns            A SyncReport summarising the operation.
   */
  async sync(triageResult: TriageResult, repoId: string): Promise<SyncReport> {
    await this.ensureInitialised();

    const t0 = Date.now();
    const { chunks, adjacencyList } = triageResult;

    logger.info(
      LOG_CTX,
      `Starting sync for repo="${repoId}" (${chunks.length} chunks)`,
    );

    // ── Step 1: Retrieve stored hashes ──
    const storedHashes = await this.qdrant.getStoredHashes(repoId);
    logger.debug(
      LOG_CTX,
      `  Retrieved ${storedHashes.size} stored hashes from Qdrant`,
    );

    // ── Step 2: Compute diff ──
    const diff: DiffResult = computeDiff(chunks, storedHashes);

    // ── Step 3: Embed & upsert changed chunks into Qdrant ──
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

    // ── Step 4: Ingest full graph into Neo4j (MERGE is idempotent) ──
    // We ingest ALL current chunks (not just changed ones) because
    // the graph relationships may have changed even if code hasn't.
    logger.info(LOG_CTX, "  Ingesting knowledge graph into Neo4j…");
    await this.neo4j.ingestGraph(chunks, adjacencyList, repoId);

    // ── Step 5: Prune deleted chunks from both stores ──
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

  // ─── Hybrid Search ─────────────────────────────────────────────────────────

  /**
   * Combines **vector similarity** (Qdrant) with **structural traversal**
   * (Neo4j) to produce a unified `GraphRagContext`.
   *
   * Algorithm:
   *   1. Embed the query string using the injected embed function.
   *   2. Search Qdrant for the top-K semantically similar chunks.
   *   3. Extract the chunk IDs of the primary matches.
   *   4. Query Neo4j for 1st & 2nd degree structural neighbors.
   *   5. Hydrate neighbor chunk IDs via Qdrant (to get full code/metadata).
   *   6. Deduplicate and return the unified context.
   *
   * @param query     - Natural-language query (e.g., "authentication middleware").
   * @param repoId    - Repository to scope the search.
   * @param topK      - Number of primary vector matches (default: 10).
   * @param maxDepth  - Graph traversal depth for neighbors (default: 2).
   * @returns         A `GraphRagContext` with both semantic matches and structural neighbors.
   */
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

    // ── Step 1: Embed the query ──
    const queryVector = await this.embedFn(query);

    // ── Step 2: Vector similarity search in Qdrant ──
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

    // ── Step 3: Extract primary chunk IDs ──
    const primaryIds = primaryMatches.map((c) => c.id);
    const primaryIdSet = new Set(primaryIds);

    // ── Step 4: Graph expansion — find structural neighbors in Neo4j ──
    const neighborIds = await this.neo4j.findStructuralNeighbors(
      primaryIds,
      repoId,
      maxDepth,
    );

    // Filter out any IDs that are already in the primary set
    const uniqueNeighborIds = neighborIds.filter((id) => !primaryIdSet.has(id));

    logger.debug(
      LOG_CTX,
      `  Graph expansion found ${uniqueNeighborIds.length} unique neighbors`,
    );

    // ── Step 5: Hydrate neighbor chunks from Qdrant ──
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

    // ── Step 6: Return unified context ──
    return {
      query,
      primaryMatches,
      structuralNeighbors,
    };
  }

  // ─── Convenience: Search with Re-ranking ──────────────────────────────────

  /**
   * Extended hybrid search that also scores and re-ranks the combined results
   * by a weighted combination of vector similarity and structural proximity.
   *
   * This is a simplified version — in production you'd add an LLM re-ranker.
   *
   * @param query     - Natural-language query.
   * @param repoId    - Repository scope.
   * @param topK      - Primary vector matches.
   * @param maxDepth  - Graph traversal depth.
   * @returns         Combined, de-duplicated, priority-ordered chunks.
   */
  async hybridSearchRanked(
    query: string,
    repoId: string,
    topK: number = 10,
    maxDepth: number = 2,
  ): Promise<ParsedChunk[]> {
    const context = await this.hybridSearch(query, repoId, topK, maxDepth);

    // Primary matches get higher base relevance (they matched the vector)
    const ranked: Array<{ chunk: ParsedChunk; score: number }> = [];

    for (let i = 0; i < context.primaryMatches.length; i++) {
      const chunk = context.primaryMatches[i]!;
      // Score: position-based decay (1st match = highest) + smell penalty
      const positionScore = 1.0 - i / (context.primaryMatches.length || 1);
      const smellBonus = chunk.smells.length > 0 ? 0.1 : 0; // boost smelly code
      ranked.push({ chunk, score: positionScore + smellBonus });
    }

    for (let i = 0; i < context.structuralNeighbors.length; i++) {
      const chunk = context.structuralNeighbors[i]!;
      // Neighbors get a lower base score but still ordered by complexity
      const baseScore = 0.5;
      const complexityBonus = Math.min(chunk.cyclomaticComplexity / 20, 0.3); // cap at 0.3
      const smellBonus = chunk.smells.length > 0 ? 0.1 : 0;
      ranked.push({ chunk, score: baseScore + complexityBonus + smellBonus });
    }

    // Sort descending by score
    ranked.sort((a, b) => b.score - a.score);

    return ranked.map((r) => r.chunk);
  }

  // ─── Repo Cleanup ──────────────────────────────────────────────────────────

  /**
   * Drops all stored data (vectors + graph) for a specific repository.
   *
   * ★ FIX: The previous implementation called getStoredHashes() to fetch
   *   every chunk ID and then deleted them one-by-one via deleteChunks().
   *   For large repos (1000s of vectors) this meant N+1 Qdrant round-trips.
   *
   *   We now call qdrant.deleteByRepoId() which issues a single Qdrant
   *   filter-based delete (`DELETE WHERE payload.repoId = $repoId`), and
   *   neo4j.dropRepo() which uses label-anchored batched Cypher — no
   *   unbounded [*] traversal.
   *
   *   Both operations are run in parallel since they are independent.
   */
  async dropRepo(repoId: string): Promise<void> {
    await this.ensureInitialised();
    logger.warn(LOG_CTX, `Dropping all data for repo="${repoId}"…`);

    await Promise.all([
      this.qdrant.deleteByRepoId(repoId),
      this.neo4j.dropRepo(repoId),
    ]);

    logger.info(LOG_CTX, `All data dropped for repo="${repoId}"`);
  }

  // ─── Shutdown ──────────────────────────────────────────────────────────────

  /**
   * Gracefully closes connections to both Qdrant and Neo4j.
   * Call this on server shutdown (e.g., SIGTERM handler).
   */
  async close(): Promise<void> {
    logger.info(LOG_CTX, "Shutting down GraphRAG stores…");
    await this.neo4j.close();
    this.initialised = false;
    logger.info(LOG_CTX, "GraphRAG stores shut down");
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  private async ensureInitialised(): Promise<void> {
    if (!this.initialised) {
      await this.init();
    }
  }
}

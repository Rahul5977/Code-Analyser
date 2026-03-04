// ─────────────────────────────────────────────────────────────────────────────
// src/graph-rag/neo4j.store.ts
//
// Neo4j Property Graph Layer — The Knowledge Graph.
//
// Graph Model:
//
//   (:Repo {id})
//       │
//       ├──[:CONTAINS]──▶ (:File {path, repoId})
//       │                      │
//       │                      ├──[:CONTAINS_CHUNK]──▶ (:Chunk {id, hash, …})
//       │                      │
//       │                      └──[:IMPORTS]──▶ (:File)
//       │
//       └──[:CONTAINS]──▶ (:File) …
//
//   (:Chunk)──[:BELONGS_TO]──▶(:File)
//   (:Chunk)──[:CALLS]──▶(:Chunk)         (inferred from resolved deps + line overlap)
//
// All mutations use MERGE to achieve idempotency on re-runs.
// All reads use the Neo4j driver's session/transaction API.
// ─────────────────────────────────────────────────────────────────────────────

import neo4j, { Driver, Session, ManagedTransaction } from "neo4j-driver";
import { logger } from "../utils/logger";
import { computeHash } from "./diff.engine";
import type { ParsedChunk, TriageResult } from "../interfaces/triage.interface";

const LOG_CTX = "Neo4jStore";

// ── Batch size for Cypher UNWIND operations ──────────────────────────────────
const BATCH_SIZE = 200;

export class Neo4jStore {
  private readonly driver: Driver;
  private readonly database: string;

  constructor(
    uri: string,
    username: string,
    password: string,
    database: string = "neo4j",
  ) {
    this.driver = neo4j.driver(uri, neo4j.auth.basic(username, password), {
      maxConnectionPoolSize: 50,
      connectionAcquisitionTimeout: 30_000,
      // Disable encryption for local dev; enable in production
    });
    this.database = database;
  }

  // ─── Connection Verification ───────────────────────────────────────────────

  /**
   * Verifies that we can connect to Neo4j and the target database exists.
   */
  async verifyConnectivity(): Promise<void> {
    try {
      await this.driver.verifyConnectivity({ database: this.database });
      logger.info(LOG_CTX, `Connected to Neo4j (database="${this.database}")`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[Neo4jStore] Failed to connect to Neo4j: ${msg}`);
    }
  }

  // ─── Schema Initialisation ─────────────────────────────────────────────────

  /**
   * Creates indexes and constraints for optimal query performance.
   * Safe to call repeatedly — uses IF NOT EXISTS.
   */
  async ensureSchema(): Promise<void> {
    const session = this.getSession();
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        // Unique constraint on Chunk.id ensures MERGE works correctly
        await tx.run(`
          CREATE CONSTRAINT chunk_id_unique IF NOT EXISTS
          FOR (c:Chunk) REQUIRE c.id IS UNIQUE
        `);

        // Index on File.path for fast lookups
        await tx.run(`
          CREATE INDEX file_path_index IF NOT EXISTS
          FOR (f:File) ON (f.path)
        `);

        // Index on Repo.id
        await tx.run(`
          CREATE CONSTRAINT repo_id_unique IF NOT EXISTS
          FOR (r:Repo) REQUIRE r.id IS UNIQUE
        `);

        // Composite index for filtering chunks by repo
        await tx.run(`
          CREATE INDEX chunk_repo_index IF NOT EXISTS
          FOR (c:Chunk) ON (c.repoId)
        `);
      });
      logger.info(LOG_CTX, "Schema constraints and indexes ensured");
    } finally {
      await session.close();
    }
  }

  // ─── Graph Construction ────────────────────────────────────────────────────

  /**
   * Ingests the full triage result into the knowledge graph.
   *
   * Performs these operations inside a single write transaction:
   *   1. MERGE the :Repo node
   *   2. MERGE :File nodes for every unique file path
   *   3. Create (:Repo)-[:CONTAINS]->(:File) edges
   *   4. MERGE :Chunk nodes with properties (hash, complexity, etc.)
   *   5. Create (:Chunk)-[:BELONGS_TO]->(:File) edges
   *   6. Create (:File)-[:IMPORTS]->(:File) edges from adjacencyList
   *   7. Create (:Chunk)-[:CALLS]->(:Chunk) edges where inferable
   */
  async ingestGraph(
    chunks: ParsedChunk[],
    adjacencyList: Record<string, string[]>,
    repoId: string,
  ): Promise<void> {
    if (chunks.length === 0) {
      logger.debug(
        LOG_CTX,
        "No chunks to ingest — skipping graph construction.",
      );
      return;
    }

    logger.info(
      LOG_CTX,
      `Ingesting ${chunks.length} chunks into Neo4j knowledge graph…`,
    );

    const session = this.getSession();
    try {
      // ── Step 1: MERGE the Repo node ──
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MERGE (r:Repo {id: $repoId})
           ON CREATE SET r.createdAt = datetime()
           ON MATCH SET r.updatedAt = datetime()`,
          { repoId },
        );
      });

      // ── Step 2 & 3: MERGE File nodes + link to Repo ──
      // Collect all unique file paths from chunks + adjacency list
      const allFilePaths = new Set<string>();
      for (const chunk of chunks) {
        allFilePaths.add(chunk.filePath);
      }
      for (const [src, deps] of Object.entries(adjacencyList)) {
        allFilePaths.add(src);
        for (const dep of deps) {
          allFilePaths.add(dep);
        }
      }

      // Batch MERGE file nodes
      const filePathArray = [...allFilePaths];
      for (let i = 0; i < filePathArray.length; i += BATCH_SIZE) {
        const batch = filePathArray.slice(i, i + BATCH_SIZE);
        await session.executeWrite(async (tx: ManagedTransaction) => {
          // UNWIND batches file nodes into a single Cypher operation
          await tx.run(
            `UNWIND $paths AS path
             MERGE (f:File {path: path})
             ON CREATE SET f.repoId = $repoId
             WITH f
             MATCH (r:Repo {id: $repoId})
             MERGE (r)-[:CONTAINS]->(f)`,
            { paths: batch, repoId },
          );
        });
      }

      logger.debug(LOG_CTX, `  Merged ${filePathArray.length} File nodes`);

      // ── Step 4 & 5: MERGE Chunk nodes + BELONGS_TO edges ──
      const chunkData = chunks.map((c) => ({
        id: c.id,
        repoId,
        filePath: c.filePath,
        hash: computeHash(c),
        startLine: c.startLine,
        endLine: c.endLine,
        cyclomaticComplexity: c.cyclomaticComplexity,
        halsteadVolume: c.halsteadVolume,
        smellCount: c.smells.length,
      }));

      for (let i = 0; i < chunkData.length; i += BATCH_SIZE) {
        const batch = chunkData.slice(i, i + BATCH_SIZE);
        await session.executeWrite(async (tx: ManagedTransaction) => {
          await tx.run(
            `UNWIND $chunks AS c
             MERGE (chunk:Chunk {id: c.id})
             SET chunk.repoId           = c.repoId,
                 chunk.filePath         = c.filePath,
                 chunk.hash             = c.hash,
                 chunk.startLine        = c.startLine,
                 chunk.endLine          = c.endLine,
                 chunk.cyclomaticComplexity = c.cyclomaticComplexity,
                 chunk.halsteadVolume   = c.halsteadVolume,
                 chunk.smellCount       = c.smellCount,
                 chunk.updatedAt        = datetime()
             WITH chunk, c
             MATCH (f:File {path: c.filePath})
             MERGE (chunk)-[:BELONGS_TO]->(f)
             MERGE (f)-[:CONTAINS_CHUNK]->(chunk)`,
            { chunks: batch },
          );
        });
      }

      logger.debug(LOG_CTX, `  Merged ${chunks.length} Chunk nodes`);

      // ── Step 6: File-level IMPORTS edges ──
      const importEdges: { source: string; target: string }[] = [];
      for (const [src, deps] of Object.entries(adjacencyList)) {
        for (const dep of deps) {
          importEdges.push({ source: src, target: dep });
        }
      }

      for (let i = 0; i < importEdges.length; i += BATCH_SIZE) {
        const batch = importEdges.slice(i, i + BATCH_SIZE);
        await session.executeWrite(async (tx: ManagedTransaction) => {
          await tx.run(
            `UNWIND $edges AS edge
             MATCH (src:File {path: edge.source})
             MATCH (tgt:File {path: edge.target})
             MERGE (src)-[:IMPORTS]->(tgt)`,
            { edges: batch },
          );
        });
      }

      logger.debug(LOG_CTX, `  Created ${importEdges.length} IMPORTS edges`);

      // ── Step 7: Chunk-level CALLS edges (inferred) ──
      // If chunk A is in file X and file X imports file Y, and chunk B is in file Y,
      // we create a (chunk A)-[:CALLS]->(chunk B) edge.
      // This is a heuristic — a more precise analysis would check call expressions.
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MATCH (c1:Chunk)-[:BELONGS_TO]->(f1:File)-[:IMPORTS]->(f2:File)<-[:BELONGS_TO]-(c2:Chunk)
           WHERE c1.repoId = $repoId AND c2.repoId = $repoId AND c1.id <> c2.id
           MERGE (c1)-[:CALLS]->(c2)`,
          { repoId },
        );
      });

      logger.info(LOG_CTX, `Graph construction complete for repo="${repoId}"`);
    } finally {
      await session.close();
    }
  }

  // ─── Hash Retrieval ────────────────────────────────────────────────────────

  /**
   * Retrieves stored chunk hashes from Neo4j for the diff engine.
   * Complementary to Qdrant's hash retrieval — either can be authoritative.
   */
  async getStoredHashes(repoId: string): Promise<Map<string, string>> {
    const session = this.getSession();
    const hashes = new Map<string, string>();

    try {
      const result = await session.executeRead(
        async (tx: ManagedTransaction) => {
          return tx.run(
            `MATCH (c:Chunk {repoId: $repoId})
           RETURN c.id AS id, c.hash AS hash`,
            { repoId },
          );
        },
      );

      for (const record of result.records) {
        const id = record.get("id") as string | null;
        const hash = record.get("hash") as string | null;
        if (id && hash) {
          hashes.set(id, hash);
        }
      }
    } finally {
      await session.close();
    }

    return hashes;
  }

  // ─── Structural Neighbor Query (for Hybrid Search) ─────────────────────────

  /**
   * Given a set of chunk IDs (the primary vector matches), finds their
   * 1st and 2nd degree structural neighbors in the graph.
   *
   * Traversal pattern:
   *   (matched chunk)─[:BELONGS_TO]─>(file)─[:IMPORTS]─>(neighbor file)
   *                                                       │
   *                                    ┌──────────────────┘
   *                                    ▼
   *                            (neighbor chunk)─[:BELONGS_TO]─>(2nd-degree file)
   *                                                              │
   *                                              ┌───────────────┘
   *                                              ▼
   *                                     (2nd-degree chunk)
   *
   * Returns chunk IDs (deduplicated, excluding the input set).
   */
  async findStructuralNeighbors(
    chunkIds: string[],
    repoId: string,
    maxDepth: number = 2,
  ): Promise<string[]> {
    if (chunkIds.length === 0) return [];

    const session = this.getSession();
    try {
      const result = await session.executeRead(
        async (tx: ManagedTransaction) => {
          // This Cypher query traverses up to 2nd-degree neighbors:
          //
          // 1st degree: chunks in files that are imported by, or import,
          //             the files containing the matched chunks.
          //
          // 2nd degree: extend one more IMPORTS hop.
          //
          // The variable-length relationship [:IMPORTS*1..maxDepth] handles both.
          return tx.run(
            `// Find files containing the matched chunks
           MATCH (matchedChunk:Chunk)-[:BELONGS_TO]->(sourceFile:File)
           WHERE matchedChunk.id IN $chunkIds AND matchedChunk.repoId = $repoId

           // Traverse 1..N degree IMPORTS in either direction
           MATCH (sourceFile)-[:IMPORTS*1..${maxDepth}]-(neighborFile:File)

           // Collect chunks that belong to those neighbor files
           MATCH (neighborChunk:Chunk)-[:BELONGS_TO]->(neighborFile)
           WHERE neighborChunk.repoId = $repoId
             AND NOT neighborChunk.id IN $chunkIds

           RETURN DISTINCT neighborChunk.id AS neighborId`,
            { chunkIds, repoId },
          );
        },
      );

      const neighborIds = result.records
        .map((r) => r.get("neighborId") as string | null)
        .filter((id): id is string => id !== null);

      logger.debug(
        LOG_CTX,
        `Found ${neighborIds.length} structural neighbors for ${chunkIds.length} seed chunks`,
      );

      return neighborIds;
    } finally {
      await session.close();
    }
  }

  // ─── Deletion ──────────────────────────────────────────────────────────────

  /**
   * Removes stale chunk nodes and their relationships.
   */
  async deleteChunks(chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) return;

    const session = this.getSession();
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        // DETACH DELETE removes the node and all its relationships
        await tx.run(
          `MATCH (c:Chunk)
           WHERE c.id IN $chunkIds
           DETACH DELETE c`,
          { chunkIds },
        );
      });
      logger.info(
        LOG_CTX,
        `Deleted ${chunkIds.length} stale chunks from Neo4j`,
      );
    } finally {
      await session.close();
    }
  }

  // ─── Teardown ──────────────────────────────────────────────────────────────

  /**
   * Drops all data for a specific repo.
   */
  async dropRepo(repoId: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MATCH (r:Repo {id: $repoId})
           OPTIONAL MATCH (r)-[*]->(n)
           DETACH DELETE r, n`,
          { repoId },
        );
      });
      logger.warn(LOG_CTX, `Dropped all graph data for repo="${repoId}"`);
    } finally {
      await session.close();
    }
  }

  /**
   * Closes the Neo4j driver connection pool.
   * Call this on server shutdown.
   */
  async close(): Promise<void> {
    await this.driver.close();
    logger.info(LOG_CTX, "Neo4j driver closed");
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  private getSession(): Session {
    return this.driver.session({ database: this.database });
  }
}

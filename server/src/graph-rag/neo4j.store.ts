// src/graph-rag/neo4j.store.ts
//
// Neo4j Property Graph Layer — The Knowledge Graph.
//
// Graph Model:
//   (:Repo {id})─[:CONTAINS]→(:File {path, repoId})─[:CONTAINS_CHUNK]→(:Chunk {id, hash, …})
//   (:Chunk)─[:BELONGS_TO]→(:File)
//   (:Chunk)─[:CALLS]→(:Chunk)     (inferred from resolved deps + line overlap)
//   (:File)─[:IMPORTS]→(:File)
//
// Provides: connectivity verification, schema initialisation (indexes +
// constraints), full graph construction from triage results, hash retrieval
// for the diff engine, structural neighbor queries for hybrid search,
// stale-chunk deletion, repo teardown (batched label-anchored Cypher —
// no unbounded [*] traversal), and driver lifecycle management.
//
// All mutations use MERGE for idempotency on re-runs.

import neo4j, { Driver, Session, ManagedTransaction } from "neo4j-driver";
import { logger } from "../utils/logger";
import { computeHash } from "./diff.engine";
import type { ParsedChunk, TriageResult } from "../interfaces/triage.interface";

const LOG_CTX = "Neo4jStore";
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
    });
    this.database = database;
  }

  async verifyConnectivity(): Promise<void> {
    try {
      await this.driver.verifyConnectivity({ database: this.database });
      logger.info(LOG_CTX, `Connected to Neo4j (database="${this.database}")`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[Neo4jStore] Failed to connect to Neo4j: ${msg}`);
    }
  }

  async ensureSchema(): Promise<void> {
    const session = this.getSession();
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(`
          CREATE CONSTRAINT chunk_id_unique IF NOT EXISTS
          FOR (c:Chunk) REQUIRE c.id IS UNIQUE
        `);
        await tx.run(`
          CREATE INDEX file_path_index IF NOT EXISTS
          FOR (f:File) ON (f.path)
        `);
        await tx.run(`
          CREATE CONSTRAINT repo_id_unique IF NOT EXISTS
          FOR (r:Repo) REQUIRE r.id IS UNIQUE
        `);
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
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MERGE (r:Repo {id: $repoId})
           ON CREATE SET r.createdAt = datetime()
           ON MATCH SET r.updatedAt = datetime()`,
          { repoId },
        );
      });

      const allFilePaths = new Set<string>();
      for (const chunk of chunks) allFilePaths.add(chunk.filePath);
      for (const [src, deps] of Object.entries(adjacencyList)) {
        allFilePaths.add(src);
        for (const dep of deps) allFilePaths.add(dep);
      }

      const filePathArray = [...allFilePaths];
      for (let i = 0; i < filePathArray.length; i += BATCH_SIZE) {
        const batch = filePathArray.slice(i, i + BATCH_SIZE);
        await session.executeWrite(async (tx: ManagedTransaction) => {
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

      const importEdges: { source: string; target: string }[] = [];
      for (const [src, deps] of Object.entries(adjacencyList)) {
        for (const dep of deps) importEdges.push({ source: src, target: dep });
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

  async getStoredHashes(repoId: string): Promise<Map<string, string>> {
    const session = this.getSession();
    const hashes = new Map<string, string>();

    try {
      const result = await session.executeRead(
        async (tx: ManagedTransaction) => {
          return tx.run(
            `MATCH (c:Chunk {repoId: $repoId}) RETURN c.id AS id, c.hash AS hash`,
            { repoId },
          );
        },
      );

      for (const record of result.records) {
        const id = record.get("id") as string | null;
        const hash = record.get("hash") as string | null;
        if (id && hash) hashes.set(id, hash);
      }
    } finally {
      await session.close();
    }

    return hashes;
  }

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
          return tx.run(
            `MATCH (matchedChunk:Chunk)-[:BELONGS_TO]->(sourceFile:File)
           WHERE matchedChunk.id IN $chunkIds AND matchedChunk.repoId = $repoId
           MATCH (sourceFile)-[:IMPORTS*1..${maxDepth}]-(neighborFile:File)
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

  async deleteChunks(chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) return;

    const session = this.getSession();
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(
          `MATCH (c:Chunk) WHERE c.id IN $chunkIds DETACH DELETE c`,
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

  async dropRepo(repoId: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(
        `MATCH (c:Chunk {repoId: $repoId})
         CALL { WITH c DETACH DELETE c } IN TRANSACTIONS OF 500 ROWS`,
        { repoId },
      );
      await session.run(
        `MATCH (f:File {repoId: $repoId})
         CALL { WITH f DETACH DELETE f } IN TRANSACTIONS OF 500 ROWS`,
        { repoId },
      );
      await session.run(`MATCH (r:Repo {id: $repoId}) DETACH DELETE r`, {
        repoId,
      });
      logger.warn(LOG_CTX, `Dropped all graph data for repo="${repoId}"`);
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
    logger.info(LOG_CTX, "Neo4j driver closed");
  }

  private getSession(): Session {
    return this.driver.session({ database: this.database });
  }
}

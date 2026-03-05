// ─────────────────────────────────────────────────────────────────────────────
// src/council/tools/shared.tools.ts
//
// Shared tools used by multiple agents:
//   • fetch_chunk_with_context — hybrid retrieval via GraphRAG
//   • query_knowledge_graph    — graph-only traversal queries
// ─────────────────────────────────────────────────────────────────────────────

import type { AgentTool } from "../../interfaces/council.interface";
import type { GraphRagService } from "../../graph-rag/graph-rag.service";
import type { Neo4jStore } from "../../graph-rag/neo4j.store";
import type { QdrantStore } from "../../graph-rag/qdrant.store";

// ─── Tool Factory Context ────────────────────────────────────────────────────

export interface ToolFactoryDeps {
  graphRag: GraphRagService;
  neo4j: Neo4jStore;
  qdrant: QdrantStore;
  repoId: string;
}

// ─── fetch_chunk_with_context ────────────────────────────────────────────────

/**
 * Pulls a chunk plus its 1st & 2nd degree structural neighbourhood
 * from the hybrid retrieval system (Qdrant + Neo4j).
 */
export function createFetchChunkWithContextTool(
  deps: ToolFactoryDeps,
): AgentTool {
  return {
    name: "fetch_chunk_with_context",
    description:
      "Retrieves a code chunk by ID along with its structural neighbourhood " +
      "(files that import it, sibling chunks, 2nd-degree dependencies). " +
      "Returns the chunk code, metadata, and neighbor summaries.",
    parameters: {
      type: "object",
      properties: {
        chunkId: {
          type: "string",
          description: "The unique ID of the chunk to retrieve.",
        },
      },
      required: ["chunkId"],
    },
    execute: async (args) => {
      const chunkId = args["chunkId"] as string;
      if (!chunkId) return JSON.stringify({ error: "chunkId is required" });

      try {
        // Retrieve the primary chunk from Qdrant
        const chunks = await deps.qdrant.getChunksByIds([chunkId]);
        if (chunks.length === 0) {
          return JSON.stringify({ error: `Chunk "${chunkId}" not found` });
        }

        const primaryChunk = chunks[0]!;

        // Get structural neighbors from Neo4j
        const neighborIds = await deps.neo4j.findStructuralNeighbors(
          [chunkId],
          deps.repoId,
          2,
        );

        // Hydrate neighbor chunks
        const neighbors =
          neighborIds.length > 0
            ? await deps.qdrant.getChunksByIds(neighborIds.slice(0, 20))
            : [];

        return JSON.stringify({
          chunk: {
            id: primaryChunk.id,
            filePath: primaryChunk.filePath,
            startLine: primaryChunk.startLine,
            endLine: primaryChunk.endLine,
            code: primaryChunk.code,
            cyclomaticComplexity: primaryChunk.cyclomaticComplexity,
            halsteadVolume: primaryChunk.halsteadVolume,
            smells: primaryChunk.smells,
            imports: primaryChunk.imports,
          },
          neighbors: neighbors.map((n) => ({
            id: n.id,
            filePath: n.filePath,
            startLine: n.startLine,
            endLine: n.endLine,
            codeSummary:
              n.code.slice(0, 200) + (n.code.length > 200 ? "…" : ""),
            cyclomaticComplexity: n.cyclomaticComplexity,
          })),
          neighborCount: neighborIds.length,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({
          error: `fetch_chunk_with_context failed: ${msg}`,
        });
      }
    },
  };
}

// ─── query_knowledge_graph ───────────────────────────────────────────────────

/**
 * Executes read-only Cypher queries against the Neo4j knowledge graph.
 * Used by the Orchestrator to explore the dependency graph before planning.
 */
export function createQueryKnowledgeGraphTool(
  deps: ToolFactoryDeps,
): AgentTool {
  return {
    name: "query_knowledge_graph",
    description:
      "Runs a pre-defined graph query against the Neo4j knowledge graph. " +
      "Available queries: 'high_complexity_chunks', 'most_imported_files', " +
      "'files_with_smells', 'dependency_fan_out', 'chunk_stats'.",
    parameters: {
      type: "object",
      properties: {
        queryType: {
          type: "string",
          enum: [
            "high_complexity_chunks",
            "most_imported_files",
            "files_with_smells",
            "dependency_fan_out",
            "chunk_stats",
          ],
          description: "The type of graph query to execute.",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 20).",
        },
      },
      required: ["queryType"],
    },
    execute: async (args) => {
      const queryType = args["queryType"] as string;
      const limit = (args["limit"] as number) ?? 20;

      try {
        // We access the Neo4j driver through the store's session helper
        // For safety, we only allow pre-defined read queries
        const result = await executeGraphQuery(deps, queryType, limit);
        return JSON.stringify(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({
          error: `query_knowledge_graph failed: ${msg}`,
        });
      }
    },
  };
}

async function executeGraphQuery(
  deps: ToolFactoryDeps,
  queryType: string,
  limit: number,
): Promise<unknown> {
  // We need direct Neo4j access for custom queries
  // The Neo4jStore exposes getStoredHashes and findStructuralNeighbors,
  // but for the orchestrator we need richer queries.
  // We'll use the public methods and compose results.

  switch (queryType) {
    case "high_complexity_chunks": {
      // Get all chunk hashes, then retrieve full chunks and sort by complexity
      const hashes = await deps.neo4j.getStoredHashes(deps.repoId);
      const chunkIds = [...hashes.keys()].slice(0, 200); // cap for safety
      if (chunkIds.length === 0)
        return { chunks: [], message: "No chunks found" };
      const chunks = await deps.qdrant.getChunksByIds(chunkIds);
      const sorted = chunks
        .sort((a, b) => b.cyclomaticComplexity - a.cyclomaticComplexity)
        .slice(0, limit);
      return {
        query: "high_complexity_chunks",
        results: sorted.map((c) => ({
          id: c.id,
          filePath: c.filePath,
          startLine: c.startLine,
          endLine: c.endLine,
          cyclomaticComplexity: c.cyclomaticComplexity,
          halsteadVolume: c.halsteadVolume,
          codeSummary: c.code.slice(0, 150),
        })),
      };
    }

    case "most_imported_files": {
      // Retrieve hashes and build file -> import count from chunks
      const hashes = await deps.neo4j.getStoredHashes(deps.repoId);
      const chunkIds = [...hashes.keys()].slice(0, 300);
      if (chunkIds.length === 0)
        return { files: [], message: "No chunks found" };
      const chunks = await deps.qdrant.getChunksByIds(chunkIds);
      const fileImportCount = new Map<string, number>();
      for (const chunk of chunks) {
        for (const dep of chunk.resolvedDeps) {
          fileImportCount.set(dep, (fileImportCount.get(dep) ?? 0) + 1);
        }
      }
      const sorted = [...fileImportCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
      return {
        query: "most_imported_files",
        results: sorted.map(([path, count]) => ({
          filePath: path,
          importedByCount: count,
        })),
      };
    }

    case "files_with_smells": {
      const hashes = await deps.neo4j.getStoredHashes(deps.repoId);
      const chunkIds = [...hashes.keys()].slice(0, 300);
      if (chunkIds.length === 0)
        return { files: [], message: "No chunks found" };
      const chunks = await deps.qdrant.getChunksByIds(chunkIds);
      const fileSmells = new Map<string, string[]>();
      for (const chunk of chunks) {
        if (chunk.smells.length > 0) {
          const existing = fileSmells.get(chunk.filePath) ?? [];
          existing.push(...chunk.smells.map((s) => s.type));
          fileSmells.set(chunk.filePath, existing);
        }
      }
      const sorted = [...fileSmells.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, limit);
      return {
        query: "files_with_smells",
        results: sorted.map(([path, smells]) => ({
          filePath: path,
          smellCount: smells.length,
          smellTypes: [...new Set(smells)],
        })),
      };
    }

    case "dependency_fan_out": {
      const hashes = await deps.neo4j.getStoredHashes(deps.repoId);
      const chunkIds = [...hashes.keys()].slice(0, 300);
      if (chunkIds.length === 0)
        return { files: [], message: "No chunks found" };
      const chunks = await deps.qdrant.getChunksByIds(chunkIds);
      const fileDeps = new Map<string, Set<string>>();
      for (const chunk of chunks) {
        const deps = fileDeps.get(chunk.filePath) ?? new Set<string>();
        for (const dep of chunk.resolvedDeps) deps.add(dep);
        fileDeps.set(chunk.filePath, deps);
      }
      const sorted = [...fileDeps.entries()]
        .sort((a, b) => b[1].size - a[1].size)
        .slice(0, limit);
      return {
        query: "dependency_fan_out",
        results: sorted.map(([path, d]) => ({
          filePath: path,
          outgoingDependencies: d.size,
        })),
      };
    }

    case "chunk_stats": {
      const hashes = await deps.neo4j.getStoredHashes(deps.repoId);
      const chunkIds = [...hashes.keys()].slice(0, 500);
      if (chunkIds.length === 0)
        return { totalChunks: 0, message: "No chunks found" };
      const chunks = await deps.qdrant.getChunksByIds(chunkIds);
      const files = new Set(chunks.map((c) => c.filePath));
      const totalComplexity = chunks.reduce(
        (s, c) => s + c.cyclomaticComplexity,
        0,
      );
      const totalSmells = chunks.reduce((s, c) => s + c.smells.length, 0);
      return {
        query: "chunk_stats",
        totalChunks: chunks.length,
        uniqueFiles: files.size,
        avgComplexity: +(totalComplexity / (chunks.length || 1)).toFixed(2),
        totalSmells,
        highComplexityChunks: chunks.filter((c) => c.cyclomaticComplexity > 10)
          .length,
      };
    }

    default:
      return { error: `Unknown query type: "${queryType}"` };
  }
}

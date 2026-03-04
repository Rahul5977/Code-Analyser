// ─────────────────────────────────────────────────────────────────────────────
// src/interfaces/graph-rag.interface.ts
//
// Phase 3 – Canonical type definitions for GraphRAG & Vector Storage.
//
// These types define the contract between the hybrid retrieval system
// (Qdrant + Neo4j) and all downstream AI agents.
// ─────────────────────────────────────────────────────────────────────────────

import type { ParsedChunk } from "./triage.interface";

// ─── Core Output ─────────────────────────────────────────────────────────────

/**
 * The unified retrieval context returned by the hybrid search engine.
 * Combines vector similarity (semantic) with graph traversal (structural).
 */
export interface GraphRagContext {
  /** The original natural-language query that triggered the search */
  query: string;

  /** Chunks found via vector similarity search in Qdrant */
  primaryMatches: ParsedChunk[];

  /** Chunks discovered via 1st & 2nd degree graph traversal in Neo4j */
  structuralNeighbors: ParsedChunk[];
}

// ─── Diffing Engine Types ────────────────────────────────────────────────────

/**
 * Classification of chunks after comparing current run hashes
 * against previously stored hashes.
 */
export interface DiffResult {
  /** Chunks that are completely new (not in the DB) */
  newChunks: ParsedChunk[];

  /** Chunks whose code has changed since last run (hash mismatch) */
  updatedChunks: ParsedChunk[];

  /** Chunks whose code is identical to last run (hash match) — skip embedding */
  unchangedChunkIds: string[];

  /** Chunk IDs that exist in the DB but are no longer in the source (deleted) */
  deletedChunkIds: string[];
}

// ─── Qdrant Payload Schema ───────────────────────────────────────────────────

/**
 * The payload stored alongside each vector in Qdrant.
 * All fields are serialisable (no functions, no circular refs).
 */
export interface QdrantChunkPayload {
  chunkId: string;
  repoId: string;
  filePath: string;
  hash: string;
  startLine: number;
  endLine: number;
  cyclomaticComplexity: number;
  halsteadVolume: number;
  smellCount: number;
  smellTypes: string[]; // e.g., ["LongFunction", "ConsoleLog"]
  code: string; // stored for retrieval without re-reading files
}

// ─── Neo4j Node Metadata ─────────────────────────────────────────────────────

/**
 * Properties stored on a :Chunk node in Neo4j.
 */
export interface Neo4jChunkProps {
  id: string;
  repoId: string;
  filePath: string;
  hash: string;
  startLine: number;
  endLine: number;
  cyclomaticComplexity: number;
  halsteadVolume: number;
  smellCount: number;
}

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * Connection config for the GraphRAG service.
 * All values default to local dev settings if not provided.
 */
export interface GraphRagConfig {
  qdrant: {
    url: string; // e.g., "http://localhost:6333"
    apiKey?: string; // optional, for Qdrant Cloud
    collectionName?: string; // defaults to "code_chunks"
  };
  neo4j: {
    uri: string; // e.g., "bolt://localhost:7687"
    username: string;
    password: string;
    database?: string; // defaults to "neo4j"
  };
  /** Dimensionality of the embedding vectors (must match your model) */
  embeddingDimension: number; // e.g., 1536 for OpenAI, 384 for MiniLM
}

// ─── Embedding Function Signature ────────────────────────────────────────────

/**
 * External embedding function injected into the GraphRAG service.
 * The service does NOT own the embedding model — it receives this as a dependency.
 */
export type EmbedFunction = (text: string) => Promise<number[]>;

/**
 * Batch embedding function for efficiency.
 * Falls back to sequential single-embed calls if not provided.
 */
export type EmbedBatchFunction = (texts: string[]) => Promise<number[][]>;

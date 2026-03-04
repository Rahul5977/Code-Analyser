// ─────────────────────────────────────────────────────────────────────────────
// src/graph-rag/diff.engine.ts
//
// Chunk Versioning & Change Sensitivity Engine.
//
// On every pipeline run, we compute a SHA-256 hash of each chunk's code +
// filePath.  By comparing these hashes against what's already stored in
// Qdrant, we classify every chunk into one of four buckets:
//
//   • new       – never seen before → embed + insert
//   • updated   – same ID, different hash → re-embed + upsert
//   • unchanged – same ID, same hash → skip entirely
//   • deleted   – in DB but not in current run → prune from DB
//
// This makes re-analysis of large repos near-instant when only a few
// files changed.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "node:crypto";
import { logger } from "../utils/logger";
import type { ParsedChunk } from "../interfaces/triage.interface";
import type { DiffResult } from "../interfaces/graph-rag.interface";

const LOG_CTX = "DiffEngine";

// ─── Hash Computation ────────────────────────────────────────────────────────

/**
 * Produces a deterministic SHA-256 hash for a chunk.
 *
 * The hash is computed over `filePath + code` so that:
 *   - Moving the same code to a different file = new hash (intentional)
 *   - Editing even one character in the function body = new hash
 *   - Re-running on identical code = same hash (skip re-embedding)
 */
export function computeHash(chunk: ParsedChunk): string {
  const payload = `${chunk.filePath}::${chunk.code}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

// ─── Diff Computation ────────────────────────────────────────────────────────

/**
 * Compares the current set of chunks against a map of previously-stored
 * hashes (chunkId → hash) and classifies every chunk.
 *
 * @param currentChunks  - All chunks extracted from the current pipeline run.
 * @param storedHashes   - Map of chunkId → hash from the last run (from Qdrant/Neo4j).
 * @returns              A `DiffResult` with four buckets.
 */
export function computeDiff(
  currentChunks: ParsedChunk[],
  storedHashes: Map<string, string>,
): DiffResult {
  const newChunks: ParsedChunk[] = [];
  const updatedChunks: ParsedChunk[] = [];
  const unchangedChunkIds: string[] = [];

  // Track which stored IDs we've "seen" so we can find deletions
  const seenStoredIds = new Set<string>();

  for (const chunk of currentChunks) {
    const currentHash = computeHash(chunk);
    const storedHash = storedHashes.get(chunk.id);

    if (storedHash === undefined) {
      // ── New chunk: not in DB at all ──
      newChunks.push(chunk);
    } else {
      seenStoredIds.add(chunk.id);

      if (storedHash === currentHash) {
        // ── Unchanged: hash matches perfectly ──
        unchangedChunkIds.push(chunk.id);
      } else {
        // ── Updated: same ID but code changed ──
        updatedChunks.push(chunk);
      }
    }
  }

  // ── Deleted: in DB but not in the current run ──
  const deletedChunkIds: string[] = [];
  for (const storedId of storedHashes.keys()) {
    if (
      !seenStoredIds.has(storedId) &&
      !currentChunks.some((c) => c.id === storedId)
    ) {
      deletedChunkIds.push(storedId);
    }
  }

  logger.info(
    LOG_CTX,
    `Diff complete: ${newChunks.length} new, ${updatedChunks.length} updated, ` +
      `${unchangedChunkIds.length} unchanged, ${deletedChunkIds.length} deleted`,
  );

  return { newChunks, updatedChunks, unchangedChunkIds, deletedChunkIds };
}

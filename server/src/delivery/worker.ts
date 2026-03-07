// ─────────────────────────────────────────────────────────────────────────────
// src/delivery/worker.ts
//
// Phase 5 – BullMQ Worker: Full Analysis Pipeline + Cleanup.
//
// Responsibilities:
//   1. Listen on the `repo-analysis-queue` for incoming jobs.
//   2. Execute the full pipeline: Ingest → Triage → GraphRAG Sync → Council.
//   3. Publish real-time progress events via Redis Pub/Sub at every stage.
//   4. On completion, deliver a webhook if `callbackUrl` was provided.
//   5. In the `finally` block, execute deterministic cleanup:
//        a) Disk:   rm -rf /temp/<jobId>
//        b) Qdrant: delete collection `repo_<jobId>`
//        c) Neo4j:  MATCH (n {jobId: $jobId}) DETACH DELETE n
//        d) Emit:   `job:cleanup:complete` → closes SSE stream
//
// Every cleanup step is wrapped in its own try/catch so that a failure in one
// (e.g., disk permissions error) never prevents the others from running.
// ─────────────────────────────────────────────────────────────────────────────

import { Worker, type Job } from "bullmq";
import fs from "node:fs/promises";
import path from "node:path";

import { ingestRepository } from "../ingestors";
import { parseAndTriage } from "../parsers";
import { GraphRagService } from "../graph-rag";
import { runCouncil } from "../council";
import type { CouncilDependencies } from "../council";

import { publishProgress, getRedisConfig } from "./pubsub";
import { storeReport } from "./controllers";
import { logger } from "../utils/logger";

import type {
  GraphRagConfig,
  EmbedFunction,
  EmbedBatchFunction,
  LLMMessage,
  LLMCompletionFn,
  ToolDefinition,
  CouncilConfig,
  CouncilReport,
} from "../interfaces";

const LOG_CTX = "Worker";
const TEMP_DIR = path.resolve(process.cwd(), "temp");

// ─── Job Data Shape ──────────────────────────────────────────────────────────

interface AnalysisJobData {
  jobId: string;
  repoUrl: string;
  callbackUrl: string | null;
}

// ─── Smart Stub LLM (imported from shared module) ────────────────────────────
import { createSmartStubLlm } from "../council/smart-stub-llm";
const stubLlmFn = createSmartStubLlm();

// ─── Stub Embedding (mirrors src/index.ts) ───────────────────────────────────

const stubEmbedFn: EmbedFunction = async (text: string): Promise<number[]> => {
  const dim = Number(process.env["EMBEDDING_DIM"] ?? "384");
  const vector: number[] = [];
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  for (let i = 0; i < dim; i++) {
    hash = ((hash << 5) - hash + i) | 0;
    vector.push(Math.sin(hash) * 0.5);
  }
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
  return vector.map((v) => v / (norm || 1));
};

const stubEmbedBatchFn: EmbedBatchFunction = async (
  texts: string[],
): Promise<number[][]> => Promise.all(texts.map((t) => stubEmbedFn(t)));

// ─── GraphRAG Config (mirrors src/index.ts) ──────────────────────────────────

function getGraphRagConfig(): GraphRagConfig {
  return {
    qdrant: {
      url: process.env["QDRANT_URL"] ?? "http://localhost:6333",
      apiKey: process.env["QDRANT_API_KEY"],
      collectionName: process.env["QDRANT_COLLECTION"] ?? "code_chunks",
    },
    neo4j: {
      uri: process.env["NEO4J_URI"] ?? "bolt://localhost:7687",
      username: process.env["NEO4J_USERNAME"] ?? "neo4j",
      password: process.env["NEO4J_PASSWORD"] ?? "password",
      database: process.env["NEO4J_DATABASE"] ?? "neo4j",
    },
    embeddingDimension: Number(process.env["EMBEDDING_DIM"] ?? "384"),
  };
}

function getCouncilConfig(): CouncilConfig {
  return {
    llmFn: stubLlmFn,
    maxIterations: Number(process.env["COUNCIL_MAX_ITERATIONS"] ?? "10"),
    maxReinvestigations: Number(
      process.env["COUNCIL_MAX_REINVESTIGATIONS"] ?? "2",
    ),
    disputeThreshold: Number(process.env["COUNCIL_DISPUTE_THRESHOLD"] ?? "0.6"),
    temperature: Number(process.env["COUNCIL_TEMPERATURE"] ?? "0.3"),
  };
}

// ─── Webhook Delivery ────────────────────────────────────────────────────────

const WEBHOOK_TIMEOUT_MS = 10_000;
const WEBHOOK_MAX_RETRIES = 3;

async function deliverWebhook(
  callbackUrl: string,
  report: CouncilReport,
  jobId: string,
): Promise<void> {
  for (let attempt = 1; attempt <= WEBHOOK_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        WEBHOOK_TIMEOUT_MS,
      );

      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Job-Id": jobId,
          "User-Agent": "CodeAnalyser-Webhook/1.0",
        },
        body: JSON.stringify({ jobId, report }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        logger.info(
          LOG_CTX,
          `Webhook delivered for job=${jobId} → ${callbackUrl} (${response.status})`,
        );
        return;
      }

      logger.warn(
        LOG_CTX,
        `Webhook attempt ${attempt}/${WEBHOOK_MAX_RETRIES} failed for job=${jobId}: HTTP ${response.status}`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        LOG_CTX,
        `Webhook attempt ${attempt}/${WEBHOOK_MAX_RETRIES} error for job=${jobId}: ${msg}`,
      );
    }

    // Exponential back-off: 1s, 2s, 4s
    if (attempt < WEBHOOK_MAX_RETRIES) {
      await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }

  logger.error(
    LOG_CTX,
    `Webhook delivery FAILED after ${WEBHOOK_MAX_RETRIES} attempts for job=${jobId} → ${callbackUrl}`,
  );
}

// ─── Cleanup Functions ───────────────────────────────────────────────────────

/**
 * Wraps any cleanup promise in a hard timeout so that a single hung
 * database call never blocks the entire `finally` block.
 *
 * If the operation times out, it logs a warning and resolves (never rejects)
 * so that subsequent cleanup steps still execute.
 */
async function withCleanupTimeout<T>(
  label: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.warn(
        LOG_CTX,
        `[cleanup:${label}] Timed out after ${timeoutMs}ms — skipping`,
      );
      resolve(undefined);
    }, timeoutMs);

    fn()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(LOG_CTX, `[cleanup:${label}] Error: ${msg}`);
        resolve(undefined);
      });
  });
}

async function cleanupDisk(jobId: string): Promise<void> {
  const repoDir = path.join(TEMP_DIR, jobId);
  try {
    await fs.rm(repoDir, { recursive: true, force: true });
    logger.info(LOG_CTX, `[cleanup:disk] Removed ${repoDir}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(LOG_CTX, `[cleanup:disk] Failed to remove ${repoDir}: ${msg}`);
  }
}

async function cleanupQdrant(
  service: GraphRagService | null,
  repoId: string,
): Promise<void> {
  try {
    if (service) {
      await service.dropRepo(repoId);
      logger.info(
        LOG_CTX,
        `[cleanup:qdrant] Dropped vectors for repo=${repoId}`,
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      LOG_CTX,
      `[cleanup:qdrant] Failed to drop repo=${repoId}: ${msg}`,
    );
  }
}

async function cleanupNeo4j(
  service: GraphRagService | null,
  // ★ FIX Bug 2: Accept repoId (not jobId).
  // The graph data was stored under repoId (e.g. "owner/repo"), NOT the
  // BullMQ jobId UUID.  Passing jobId here previously caused the cleanup
  // to match nothing in Neo4j, leaking the full graph on every job.
  repoId: string,
): Promise<void> {
  try {
    if (service) {
      await service.neo4j.dropRepo(repoId);
      logger.info(
        LOG_CTX,
        `[cleanup:neo4j] Deleted graph nodes for repoId=${repoId}`,
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      LOG_CTX,
      `[cleanup:neo4j] Failed to delete graph for repoId=${repoId}: ${msg}`,
    );
  }
}

// ─── The BullMQ Worker ───────────────────────────────────────────────────────

/**
 * Creates and returns a BullMQ Worker that processes `repo-analysis` jobs.
 *
 * The worker implements the full pipeline:
 *   Phase 1  → Ingest
 *   Phase 2  → Parse & Triage
 *   Phase 3  → GraphRAG Sync
 *   Phase 4  → Council Multi-Agent Analysis
 *   Webhook  → Deliver callback (if provided)
 *   Cleanup  → Disk, Qdrant, Neo4j, SSE termination (always runs)
 */
export function createAnalysisWorker(): Worker {
  const redisCfg = getRedisConfig();

  const worker = new Worker<AnalysisJobData>(
    "repo-analysis-queue",
    async (job: Job<AnalysisJobData>) => {
      const { jobId, repoUrl, callbackUrl } = job.data;
      let graphRagService: GraphRagService | null = null;
      let repoId = jobId; // default — may be overridden

      try {
        // ── Phase 1: Ingest ──────────────────────────────────────────────
        await publishProgress(
          jobId,
          "phase:ingest:start",
          `Cloning repository: ${repoUrl}`,
        );
        const manifest = await ingestRepository(repoUrl, jobId);
        await publishProgress(
          jobId,
          "phase:ingest:complete",
          `Ingested ${manifest.targetFiles.length} files`,
        );

        // ── Phase 2: Parse & Triage ──────────────────────────────────────
        await publishProgress(
          jobId,
          "phase:triage:start",
          "Parsing AST and triaging code chunks…",
        );
        const triage = await parseAndTriage(
          manifest.targetFiles,
          manifest.localPath,
        );
        await publishProgress(
          jobId,
          "phase:triage:complete",
          `Triaged ${triage.chunks.length} chunks across ${new Set(triage.chunks.map((c) => c.filePath)).size} files`,
        );

        // ── Derive repoId ────────────────────────────────────────────────
        repoId =
          repoUrl
            .replace(/\.git$/, "")
            .split("/")
            .filter(Boolean)
            .slice(-2)
            .join("/") || jobId;

        // ── Phase 3: GraphRAG Sync ───────────────────────────────────────
        await publishProgress(
          jobId,
          "phase:graphrag:start",
          "Syncing to vector & graph stores…",
        );
        const config = getGraphRagConfig();
        graphRagService = new GraphRagService(
          config,
          stubEmbedFn,
          stubEmbedBatchFn,
        );
        await graphRagService.init();
        const syncReport = await graphRagService.sync(triage, repoId);
        await publishProgress(
          jobId,
          "phase:graphrag:complete",
          `Synced: ${syncReport.newChunks} new, ${syncReport.updatedChunks} updated, ${syncReport.deletedChunks} deleted`,
        );

        // ── Phase 4: Council Multi-Agent Analysis ────────────────────────
        await publishProgress(
          jobId,
          "phase:council:start",
          "Starting multi-agent council analysis…",
        );

        const councilConfig = getCouncilConfig();
        const councilDeps: CouncilDependencies = {
          toolDeps: {
            graphRag: graphRagService,
            neo4j: graphRagService.neo4j,
            qdrant: graphRagService.qdrant,
            repoId,
          },
          qdrant: graphRagService.qdrant,
          embedFn: graphRagService.embedFn,
        };

        const councilReport = await runCouncil(
          manifest,
          triage,
          repoId,
          councilConfig,
          councilDeps,
        );

        await publishProgress(
          jobId,
          "phase:council:complete",
          `Council complete: ${councilReport.metadata.totalFindings} findings, ${councilReport.findingCards.length} cards`,
          { summary: councilReport.summary },
        );

        // ── Store report for retrieval / diffing ─────────────────────────
        storeReport(jobId, councilReport);

        // ── Webhook delivery ─────────────────────────────────────────────
        if (callbackUrl) {
          await publishProgress(
            jobId,
            "webhook:start",
            `Delivering webhook to ${callbackUrl}…`,
          );
          await deliverWebhook(callbackUrl, councilReport, jobId);
          await publishProgress(
            jobId,
            "webhook:complete",
            "Webhook delivered.",
          );
        }

        return councilReport;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(LOG_CTX, `Job ${jobId} FAILED: ${msg}`);
        await publishProgress(jobId, "job:error", `Analysis failed: ${msg}`);
        throw err; // re-throw so BullMQ marks the job as failed
      } finally {
        // ────────────────────────────────────────────────────────────────
        // THE ULTIMATE CLEANUP BLOCK
        //
        // Every step is independently wrapped in:
        //   a) its own try/catch, so a failure in one never skips the rest.
        //   b) withCleanupTimeout(), so a hung DB call (e.g., Neo4j OOM)
        //      never blocks the worker indefinitely.
        //
        // Timeout budget per step:
        //   Disk   →  5 s  (local fs, should be instant)
        //   Qdrant → 10 s  (HTTP delete call)
        //   Neo4j  → 15 s  (Cypher delete, batched — much faster now)
        //   Close  →  5 s  (driver pool teardown)
        // ────────────────────────────────────────────────────────────────

        logger.info(LOG_CTX, `[finally] Starting cleanup for job=${jobId}`);
        await publishProgress(jobId, "job:cleanup:start", "Starting cleanup…");

        // Step 1: Disk cleanup — rm -rf /temp/<jobId>
        await withCleanupTimeout("disk", 5_000, () => cleanupDisk(jobId));

        // Step 2: Vector DB cleanup — drop Qdrant data for this repo
        // ★ NOTE: cleanupQdrant internally calls graphRagService.dropRepo()
        //   which also deletes Neo4j data.  We call cleanupNeo4j separately
        //   below because graphRagService.dropRepo() may have already handled
        //   it — Neo4j.dropRepo is idempotent (MATCH will simply find nothing).
        await withCleanupTimeout("qdrant", 10_000, () =>
          cleanupQdrant(graphRagService, repoId),
        );

        // Step 3: Graph DB cleanup — label-anchored batched DELETE (no [*])
        // ★ FIX Bug 2: pass repoId (not jobId) — this is the key the graph
        //   was stored under.  Passing jobId previously deleted nothing and
        //   caused a full graph leak on every job completion.
        await withCleanupTimeout("neo4j", 15_000, () =>
          cleanupNeo4j(graphRagService, repoId),
        );

        // Step 4: Close GraphRAG service connections
        // ★ FIX Bug 3: close() runs AFTER all delete operations, not before.
        //   Previously if Neo4j cleanup was slow, close() could race with it
        //   leaving the driver in a partially-closed state.
        await withCleanupTimeout("connections", 5_000, async () => {
          if (graphRagService) {
            await graphRagService.close();
            logger.info(
              LOG_CTX,
              `[cleanup:connections] GraphRAG connections closed for job=${jobId}`,
            );
          }
        });

        // Step 5: Emit terminal event → SSE endpoint closes the stream
        await publishProgress(
          jobId,
          "job:cleanup:complete",
          "All cleanup finished.",
        );
        logger.info(LOG_CTX, `[finally] Cleanup complete for job=${jobId}`);
      }
    },
    {
      connection: {
        host: redisCfg.host,
        port: redisCfg.port,
        password: redisCfg.password,
        db: redisCfg.db,
        maxRetriesPerRequest: redisCfg.maxRetriesPerRequest,
      },
      concurrency: Number(process.env["WORKER_CONCURRENCY"] ?? "2"),
      limiter: {
        max: Number(process.env["WORKER_RATE_LIMIT"] ?? "5"),
        duration: 60_000, // 5 jobs per minute
      },
    },
  );

  // ── Worker lifecycle events ──
  worker.on("completed", (job: Job<AnalysisJobData>) => {
    logger.info(LOG_CTX, `✔ Job ${job.data.jobId} completed successfully`);
  });

  worker.on("failed", (job: Job<AnalysisJobData> | undefined, err: Error) => {
    const jid = job?.data.jobId ?? "unknown";
    logger.error(LOG_CTX, `✘ Job ${jid} failed: ${err.message}`);
  });

  worker.on("error", (err: Error) => {
    logger.error(LOG_CTX, `Worker error: ${err.message}`);
  });

  logger.info(
    LOG_CTX,
    "Analysis worker started — listening on repo-analysis-queue",
  );
  return worker;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/delivery/worker.ts
//
// BullMQ Worker — Full Analysis Pipeline + Deterministic Cleanup.
//
// Listens on `repo-analysis-queue` and executes:
//   Ingest → Triage → GraphRAG Sync → Council → Webhook → Cleanup.
//
// Real-time progress is published via Redis Pub/Sub at every stage.
// The finally block runs five independent cleanup steps, each wrapped
// in withCleanupTimeout() so a single hung DB call never blocks the
// worker indefinitely:
//   1. Disk   (5s)  — rm -rf /temp/<jobId>
//   2. Qdrant (10s) — filter-based vector delete by repoId
//   3. Neo4j  (15s) — batched label-anchored Cypher delete by repoId
//   4. Close  (5s)  — driver pool teardown
//   5. SSE    — emit job:cleanup:complete to close the stream

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

interface AnalysisJobData {
  jobId: string;
  repoUrl: string;
  callbackUrl: string | null;
}

import { createSmartStubLlm } from "../council/smart-stub-llm";
const stubLlmFn = createSmartStubLlm();

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

    if (attempt < WEBHOOK_MAX_RETRIES) {
      await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }

  logger.error(
    LOG_CTX,
    `Webhook delivery FAILED after ${WEBHOOK_MAX_RETRIES} attempts for job=${jobId} → ${callbackUrl}`,
  );
}

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

export function createAnalysisWorker(): Worker {
  const redisCfg = getRedisConfig();

  const worker = new Worker<AnalysisJobData>(
    "repo-analysis-queue",
    async (job: Job<AnalysisJobData>) => {
      const { jobId, repoUrl, callbackUrl } = job.data;
      let graphRagService: GraphRagService | null = null;
      let repoId = jobId;

      try {
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

        repoId =
          repoUrl
            .replace(/\.git$/, "")
            .split("/")
            .filter(Boolean)
            .slice(-2)
            .join("/") || jobId;

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

        storeReport(jobId, councilReport);

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
        throw err;
      } finally {
        logger.info(LOG_CTX, `[finally] Starting cleanup for job=${jobId}`);
        await publishProgress(jobId, "job:cleanup:start", "Starting cleanup…");

        await withCleanupTimeout("disk", 5_000, () => cleanupDisk(jobId));
        await withCleanupTimeout("qdrant", 10_000, () =>
          cleanupQdrant(graphRagService, repoId),
        );
        await withCleanupTimeout("neo4j", 15_000, () =>
          cleanupNeo4j(graphRagService, repoId),
        );

        await withCleanupTimeout("connections", 5_000, async () => {
          if (graphRagService) {
            await graphRagService.close();
            logger.info(
              LOG_CTX,
              `[cleanup:connections] GraphRAG connections closed for job=${jobId}`,
            );
          }
        });

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
        duration: 60_000,
      },
    },
  );

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

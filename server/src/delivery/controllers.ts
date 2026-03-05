// ─────────────────────────────────────────────────────────────────────────────
// src/delivery/controllers.ts
//
// Phase 5 – Express API Controllers.
//
// Endpoints:
//   1. POST   /api/repo/analyze           – Submit job to BullMQ queue
//   2. GET    /api/repo/stream/:jobId      – SSE real-time progress stream
//   3. GET    /api/repo/diff?jobA=&jobB=   – Report diffing
//   4. GET    /api/repo/report/:jobId      – Retrieve completed report
//
// All controllers are pure functions that receive (req, res) and are mounted
// by the main Express app — no hidden global state.
// ─────────────────────────────────────────────────────────────────────────────

import { Request, Response } from "express";
import { Queue } from "bullmq";
import { v4 as uuidv4 } from "uuid";

import { channelForJob, createSubscriber, getRedisConfig } from "./pubsub";
import { logger } from "../utils/logger";
import type {
  CouncilReport,
  FindingCard,
} from "../interfaces/council.interface";

const LOG_CTX = "Controllers";

// ─── In-Memory Report Store (mock) ───────────────────────────────────────────
//
// In production, replace with a real persistence layer (Postgres, Mongo, S3…).
// The worker writes finished reports here; the diff & report endpoints read.
// ─────────────────────────────────────────────────────────────────────────────

const reportStore = new Map<string, CouncilReport>();

export function storeReport(jobId: string, report: CouncilReport): void {
  reportStore.set(jobId, report);
}

export function getReport(jobId: string): CouncilReport | undefined {
  return reportStore.get(jobId);
}

// ─── BullMQ Queue (lazy singleton) ──────────────────────────────────────────

let analysisQueue: Queue | null = null;

function getAnalysisQueue(): Queue {
  if (!analysisQueue) {
    const cfg = getRedisConfig();
    analysisQueue = new Queue("repo-analysis-queue", {
      connection: {
        host: cfg.host,
        port: cfg.port,
        password: cfg.password,
        db: cfg.db,
        maxRetriesPerRequest: cfg.maxRetriesPerRequest,
      },
    });
  }
  return analysisQueue;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. POST /api/repo/analyze — Job Submission & Webhook Support
// ─────────────────────────────────────────────────────────────────────────────

interface AnalyzeRequestBody {
  repoUrl?: string;
  callbackUrl?: string;
}

/**
 * Accepts a repository URL, enqueues a BullMQ job for the full analysis
 * pipeline, and returns `202 Accepted` with the `jobId`.
 *
 * If `callbackUrl` is provided it is persisted in the job data so the
 * worker can POST the final report as a webhook when processing completes.
 */
export async function analyzeRepo(req: Request, res: Response): Promise<void> {
  const body = req.body as AnalyzeRequestBody;
  const { repoUrl, callbackUrl } = body;

  // ── Validation ──
  if (!repoUrl || typeof repoUrl !== "string") {
    res.status(400).json({
      error: "Bad Request",
      message: "`repoUrl` is required and must be a non-empty string.",
    });
    return;
  }

  if (callbackUrl && typeof callbackUrl !== "string") {
    res.status(400).json({
      error: "Bad Request",
      message: "`callbackUrl` must be a string when provided.",
    });
    return;
  }

  const jobId = uuidv4();

  try {
    const queue = getAnalysisQueue();
    await queue.add(
      "repo-analysis",
      {
        jobId,
        repoUrl,
        callbackUrl: callbackUrl ?? null,
      },
      {
        jobId, // dedup key
        removeOnComplete: { age: 86_400 }, // keep 24 h
        removeOnFail: { age: 172_800 }, // keep 48 h
        attempts: 1, // no auto-retry — analysis is idempotent at the pipeline level
      },
    );

    logger.info(
      LOG_CTX,
      `Job enqueued  jobId=${jobId}  repo=${repoUrl}  callback=${callbackUrl ?? "none"}`,
    );

    res.status(202).json({
      success: true,
      jobId,
      message:
        "Analysis job accepted. Stream progress at GET /api/repo/stream/:jobId.",
      streamUrl: `/api/repo/stream/${jobId}`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(LOG_CTX, `Failed to enqueue job: ${message}`);
    res.status(500).json({ success: false, error: "Queue Error", message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /api/repo/stream/:jobId — Real-Time SSE via Redis Pub/Sub
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sets up a Server-Sent Events connection that pipes Redis Pub/Sub messages
 * for the given `jobId` directly to the client.
 *
 * Handles:
 *   • SSE headers + keep-alive heartbeat.
 *   • Per-client Redis subscriber (avoids cross-talk).
 *   • Automatic cleanup when the client disconnects (`req.on("close")`).
 *   • Graceful close when a `job:cleanup:complete` event is received.
 */
export async function streamProgress(
  req: Request,
  res: Response,
): Promise<void> {
  const jobId = req.params["jobId"];

  if (!jobId || typeof jobId !== "string") {
    res
      .status(400)
      .json({ error: "Bad Request", message: "Missing jobId path parameter." });
    return;
  }

  // ── SSE headers ──
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable Nginx buffering
  });

  // Initial handshake event
  res.write(
    `data: ${JSON.stringify({ event: "connected", jobId, timestamp: new Date().toISOString() })}\n\n`,
  );

  // ── Heartbeat (every 15 s) to keep proxies from timing out ──
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15_000);

  // ── Redis subscriber for this job's channel ──
  const channel = channelForJob(jobId);
  const subscriber = createSubscriber();
  let closed = false;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);

    // Unsubscribe + quit — prevent memory leak
    subscriber.unsubscribe(channel).catch(() => {
      /* swallow */
    });
    subscriber.quit().catch(() => {
      /* swallow */
    });

    logger.debug(LOG_CTX, `SSE stream closed for job=${jobId}`);
  };

  // ── Pipe Redis messages → SSE ──
  subscriber.on("message", (ch: string, rawMessage: string) => {
    if (ch !== channel || closed) return;

    // Forward raw JSON as an SSE "data:" frame
    res.write(`data: ${rawMessage}\n\n`);

    // Check for the terminal event
    try {
      const payload = JSON.parse(rawMessage) as { event?: string };
      if (payload.event === "job:cleanup:complete") {
        // Send a final "done" event and close
        res.write(
          `data: ${JSON.stringify({ event: "stream:end", jobId, timestamp: new Date().toISOString() })}\n\n`,
        );
        res.end();
        cleanup();
      }
    } catch {
      // Not valid JSON — still forwarded, just no event check
    }
  });

  // ── Subscribe ──
  try {
    await subscriber.subscribe(channel);
    logger.info(LOG_CTX, `SSE stream opened for job=${jobId}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(LOG_CTX, `Failed to subscribe to channel ${channel}: ${msg}`);
    res.write(
      `data: ${JSON.stringify({ event: "error", message: "Failed to subscribe to progress channel." })}\n\n`,
    );
    res.end();
    cleanup();
    return;
  }

  // ── Client disconnect (browser tab closed) — critical leak prevention ──
  req.on("close", () => {
    logger.debug(
      LOG_CTX,
      `Client disconnected from SSE stream for job=${jobId}`,
    );
    cleanup();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET /api/repo/diff?jobA=uuid1&jobB=uuid2 — Report Diffing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unique signature for a finding: `filePath::category::startLine`.
 * This is what we use to determine identity across two reports.
 */
function findingSignature(card: FindingCard): string {
  const f = card.finding;
  return `${f.filePath}::${f.category}::${f.startLine}`;
}

export interface DiffReport {
  jobA: string;
  jobB: string;
  resolved: FindingCard[]; // in A but not in B
  newFindings: FindingCard[]; // in B but not in A
  persisting: FindingCard[]; // in both
  summary: {
    resolvedCount: number;
    newCount: number;
    persistingCount: number;
  };
}

/**
 * Compares two council reports and categorises findings as:
 *   • **Resolved** — present in jobA but missing in jobB.
 *   • **New**      — present in jobB but missing in jobA.
 *   • **Persisting** — present in both.
 */
export async function compareReports(
  req: Request,
  res: Response,
): Promise<void> {
  const jobA = req.query["jobA"] as string | undefined;
  const jobB = req.query["jobB"] as string | undefined;

  if (!jobA || !jobB) {
    res.status(400).json({
      error: "Bad Request",
      message: "Both `jobA` and `jobB` query parameters are required.",
    });
    return;
  }

  const reportA = getReport(jobA);
  const reportB = getReport(jobB);

  if (!reportA) {
    res
      .status(404)
      .json({
        error: "Not Found",
        message: `Report for jobA="${jobA}" not found.`,
      });
    return;
  }
  if (!reportB) {
    res
      .status(404)
      .json({
        error: "Not Found",
        message: `Report for jobB="${jobB}" not found.`,
      });
    return;
  }

  // Build signature sets
  const sigA = new Map<string, FindingCard>();
  for (const card of reportA.findingCards) {
    sigA.set(findingSignature(card), card);
  }

  const sigB = new Map<string, FindingCard>();
  for (const card of reportB.findingCards) {
    sigB.set(findingSignature(card), card);
  }

  const resolved: FindingCard[] = [];
  const persisting: FindingCard[] = [];
  const newFindings: FindingCard[] = [];

  // Resolved: in A but not in B
  for (const [sig, card] of sigA) {
    if (sigB.has(sig)) {
      persisting.push(card);
    } else {
      resolved.push(card);
    }
  }

  // New: in B but not in A
  for (const [sig, card] of sigB) {
    if (!sigA.has(sig)) {
      newFindings.push(card);
    }
  }

  const diff: DiffReport = {
    jobA,
    jobB,
    resolved,
    newFindings,
    persisting,
    summary: {
      resolvedCount: resolved.length,
      newCount: newFindings.length,
      persistingCount: persisting.length,
    },
  };

  res.status(200).json({ success: true, data: diff });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET /api/repo/report/:jobId — Retrieve Completed Report
// ─────────────────────────────────────────────────────────────────────────────

export async function getReportEndpoint(
  req: Request,
  res: Response,
): Promise<void> {
  const jobId = req.params["jobId"] as string | undefined;

  if (!jobId || typeof jobId !== "string") {
    res.status(400).json({ error: "Bad Request", message: "Missing jobId." });
    return;
  }

  const report = getReport(jobId);

  if (!report) {
    res.status(404).json({
      error: "Not Found",
      message: `Report for job="${jobId}" not found. The job may still be processing.`,
    });
    return;
  }

  res.status(200).json({ success: true, data: report });
}

// ─── Queue Cleanup ───────────────────────────────────────────────────────────

export async function closeQueue(): Promise<void> {
  if (analysisQueue) {
    await analysisQueue.close();
    analysisQueue = null;
  }
}

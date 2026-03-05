// ─────────────────────────────────────────────────────────────────────────────
// src/delivery/pubsub.ts
//
// Phase 5 – Real-Time Streaming via Redis Pub/Sub.
//
// Responsibilities:
//   1. Manage a singleton Redis publisher for emitting progress events.
//   2. Provide `publishProgress(jobId, payload)` callable from BullMQ workers
//      and LangGraph agent nodes to broadcast real-time updates.
//   3. Provide `createSubscriber()` for SSE consumers to listen on a per-job
//      channel without sharing a connection (Redis limitation: a subscribed
//      connection cannot issue non-Pub/Sub commands).
//   4. Clean lifecycle: `closePubSub()` for graceful shutdown.
//
// Channel naming convention:  `channel:repo-progress:<jobId>`
// ─────────────────────────────────────────────────────────────────────────────

import Redis from "ioredis";
import { logger } from "../utils/logger";

const LOG_CTX = "PubSub";

// ─── Redis Connection Config ─────────────────────────────────────────────────

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  maxRetriesPerRequest?: number | null;
}

export function getRedisConfig(): RedisConfig {
  return {
    host: process.env["REDIS_HOST"] ?? "127.0.0.1",
    port: Number(process.env["REDIS_PORT"] ?? "6379"),
    password: process.env["REDIS_PASSWORD"] ?? undefined,
    db: Number(process.env["REDIS_DB"] ?? "0"),
    maxRetriesPerRequest: null, // required by BullMQ
  };
}

// ─── Channel Naming ──────────────────────────────────────────────────────────

export function channelForJob(jobId: string): string {
  return `channel:repo-progress:${jobId}`;
}

// ─── Publisher Singleton ─────────────────────────────────────────────────────

let publisher: Redis | null = null;

export function getPublisher(): Redis {
  if (!publisher) {
    const cfg = getRedisConfig();
    publisher = new Redis({
      host: cfg.host,
      port: cfg.port,
      password: cfg.password,
      db: cfg.db,
      maxRetriesPerRequest: cfg.maxRetriesPerRequest,
      lazyConnect: true,
    });
    publisher.on("error", (err) =>
      logger.error(LOG_CTX, `Publisher connection error: ${err.message}`),
    );
    // Eagerly connect so first publish isn't slow
    void publisher
      .connect()
      .catch((err) =>
        logger.error(
          LOG_CTX,
          `Publisher initial connect failed: ${err.message}`,
        ),
      );
  }
  return publisher;
}

// ─── Subscriber Factory ──────────────────────────────────────────────────────

/**
 * Creates a **new** Redis connection in subscriber mode.
 *
 * Each SSE client gets its own subscriber so that one `UNSUBSCRIBE` doesn't
 * tear down other clients' channels.  The caller is responsible for calling
 * `subscriber.quit()` when done.
 */
export function createSubscriber(): Redis {
  const cfg = getRedisConfig();
  const sub = new Redis({
    host: cfg.host,
    port: cfg.port,
    password: cfg.password,
    db: cfg.db,
    maxRetriesPerRequest: cfg.maxRetriesPerRequest,
    lazyConnect: false,
  });
  sub.on("error", (err) =>
    logger.error(LOG_CTX, `Subscriber connection error: ${err.message}`),
  );
  return sub;
}

// ─── Progress Message Schema ─────────────────────────────────────────────────

export interface ProgressPayload {
  jobId: string;
  timestamp: string;
  event: string; // e.g., "agent:security:start", "job:cleanup:complete"
  message: string; // Human-readable detail
  data?: unknown; // Optional structured payload
}

// ─── Event Buffering ─────────────────────────────────────────────────────────
//
// Redis Pub/Sub is fire-and-forget: if no subscriber is listening when a
// message is published, the message is lost.  This is the root cause of the
// "stuck streaming" bug — the BullMQ worker processes the job and publishes
// all progress events before the frontend's SSE connection has subscribed.
//
// Solution: alongside every PUBLISH, we also RPUSH each event into a Redis
// list keyed by jobId.  When an SSE client connects, it replays the buffer
// first, then switches to live pub/sub.  The buffer auto-expires after 1 hour.
// ─────────────────────────────────────────────────────────────────────────────

/** Redis key for the event replay buffer of a job. */
export function bufferKeyForJob(jobId: string): string {
  return `buffer:repo-progress:${jobId}`;
}

/** TTL for buffered events (1 hour — plenty for any analysis run). */
const BUFFER_TTL_SECONDS = 3600;

/**
 * Returns all previously buffered events for a job (for replay on SSE connect).
 */
export async function getBufferedEvents(jobId: string): Promise<string[]> {
  try {
    const pub = getPublisher();
    return await pub.lrange(bufferKeyForJob(jobId), 0, -1);
  } catch {
    return [];
  }
}

// ─── Publish Helper ──────────────────────────────────────────────────────────

/**
 * Publishes a progress event on the job's channel AND appends it to a
 * Redis list for replay by late-joining SSE clients.
 *
 * Safe to call from any context (BullMQ worker, agent tool, etc.).
 * If the publisher is unavailable, the error is swallowed with a warning
 * so it never disrupts the analysis pipeline.
 *
 * @param jobId   - The job identifier (maps to a Redis channel).
 * @param event   - Machine-readable event tag.
 * @param message - Human-readable description.
 * @param data    - Optional structured payload (serialised to JSON).
 */
export async function publishProgress(
  jobId: string,
  event: string,
  message: string,
  data?: unknown,
): Promise<void> {
  const payload: ProgressPayload = {
    jobId,
    timestamp: new Date().toISOString(),
    event,
    message,
    data,
  };

  try {
    const pub = getPublisher();
    const serialised = JSON.stringify(payload);
    const bufferKey = bufferKeyForJob(jobId);

    // Atomic: buffer + publish + set TTL in a pipeline
    await pub
      .pipeline()
      .rpush(bufferKey, serialised)
      .expire(bufferKey, BUFFER_TTL_SECONDS)
      .publish(channelForJob(jobId), serialised)
      .exec();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(LOG_CTX, `Failed to publish progress for job=${jobId}: ${msg}`);
  }
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

export async function closePubSub(): Promise<void> {
  if (publisher) {
    logger.info(LOG_CTX, "Closing Redis publisher…");
    await publisher.quit().catch(() => {
      /* already closed */
    });
    publisher = null;
  }
}

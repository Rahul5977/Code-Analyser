// ─────────────────────────────────────────────────────────────────────────────
// src/delivery/index.ts – Barrel export for Phase 5: API Delivery & Cleanup
// ─────────────────────────────────────────────────────────────────────────────

// ── Pub/Sub ──
export {
  publishProgress,
  createSubscriber,
  getPublisher,
  closePubSub,
  channelForJob,
  getRedisConfig,
} from "./pubsub";
export type { RedisConfig, ProgressPayload } from "./pubsub";

// ── Controllers ──
export {
  analyzeRepo,
  streamProgress,
  compareReports,
  getReportEndpoint,
  storeReport,
  getReport,
  closeQueue,
} from "./controllers";
export type { DiffReport } from "./controllers";

// ── Worker ──
export { createAnalysisWorker } from "./worker";

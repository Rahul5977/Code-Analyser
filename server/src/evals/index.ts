// ─────────────────────────────────────────────────────────────────────────────
// src/evals/index.ts – Barrel export for Phase 6: Evaluation Harness
// ─────────────────────────────────────────────────────────────────────────────

// ── Interfaces ──
export type {
  KnownVulnerability,
  GroundTruth,
  MatchClass,
  MatchResult,
  AgentScore,
  EvalRunResult,
  EvalRunRow,
  EvalSummary,
  RegressionAlert,
  MatcherConfig,
} from "./eval.interfaces";
export { DEFAULT_MATCHER_CONFIG } from "./eval.interfaces";

// ── Scorer ──
export {
  matchFindings,
  extractFindings,
  computeAgentScores,
  macroAverage,
} from "./eval.scorer";

// ── Store (SQLite) ──
export {
  initEvalDb,
  insertEvalRun,
  insertRegressions,
  getPreviousScores,
  getHistoricalTrend,
  closeEvalDb,
} from "./eval.store";

// ── Runner ──
export {
  runEvalSuite,
  evaluateSingleRepo,
  loadGroundTruths,
  getSmokeTruth,
} from "./eval.runner";
export type { PipelineFn } from "./eval.runner";

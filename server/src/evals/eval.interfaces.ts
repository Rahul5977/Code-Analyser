// ─────────────────────────────────────────────────────────────────────────────
// src/evals/eval.interfaces.ts
//
// Phase 6 – Canonical type definitions for the Evaluation Harness.
//
// Defines:
//   • GroundTruth — what MUST be found in a golden repo
//   • MatchResult — per-finding match verdict (TP / FP / FN)
//   • AgentScore  — Precision, Recall, F1 for a single agent
//   • EvalRunRow  — shape of a row persisted into the eval_runs table
//   • EvalSummary — the top-level output of a full eval run
// ─────────────────────────────────────────────────────────────────────────────

import type { AgentId, Severity } from "../interfaces/council.interface";

// ─── Ground Truth ────────────────────────────────────────────────────────────

/**
 * A single known vulnerability in a golden repo.
 *
 * The `ruleId` field is the canonical identifier used to match against
 * agent findings.  It corresponds to the `category` field on a `Finding`.
 *
 * Example:
 * ```json
 * { "filePath": "src/auth.js", "ruleId": "SQL_INJECTION", "line": 42, "severity": "HIGH" }
 * ```
 */
export interface KnownVulnerability {
  /** Relative file path within the repo (e.g. "src/auth.js") */
  filePath: string;

  /** Canonical rule / vulnerability type (e.g. "SQL_INJECTION", "XSS", "quadratic-complexity") */
  ruleId: string;

  /** 1-based line number where the vulnerability exists */
  line: number;

  /** Expected severity (used for severity-accuracy scoring, not for matching) */
  severity: Severity;

  /** Which agent is expected to catch this (optional — allows per-agent scoring) */
  expectedAgent?: AgentId;

  /** Human description for debugging / reporting */
  description?: string;
}

/**
 * Complete ground truth for a single golden repository.
 *
 * This is the "answer key" against which agent output is scored.
 */
export interface GroundTruth {
  /** Human-readable label (e.g. "OWASP WebGoat 2024") */
  name: string;

  /** Git clone URL */
  repoUrl: string;

  /** Git commit hash that the ground truth was authored against */
  commitHash: string;

  /** All known vulnerabilities in this repo */
  vulnerabilities: KnownVulnerability[];
}

// ─── Matching ────────────────────────────────────────────────────────────────

/**
 * The classification of a single agent finding after comparison with ground truth.
 */
export type MatchClass = "TP" | "FP" | "FN";

/**
 * Result of matching one agent finding (or one expected vulnerability).
 */
export interface MatchResult {
  /** TP, FP, or FN */
  matchClass: MatchClass;

  /** The agent-generated finding (present for TP and FP) */
  findingId?: string;

  /** The ground-truth vulnerability (present for TP and FN) */
  groundTruthIdx?: number;

  /** File path involved */
  filePath: string;

  /** Rule / category */
  ruleId: string;

  /** Agent line vs ground truth line (undefined for FP/FN) */
  lineDelta?: number;

  /** Which agent produced this (for FP it's the agent that hallucinated) */
  agentId: AgentId;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Precision / Recall / F1 for one agent.
 */
export interface AgentScore {
  agentId: AgentId;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number; // TP / (TP + FP)  — NaN-safe → 0.0
  recall: number; // TP / (TP + FN)  — NaN-safe → 0.0
  f1: number; // 2 * (P * R) / (P + R) — NaN-safe → 0.0
  /** Optional: % of TPs where severity matched ground truth exactly */
  severityAccuracy?: number;
}

/**
 * Aggregate score across all agents in a single eval run.
 */
export interface EvalRunResult {
  /** ISO timestamp of the run */
  timestamp: string;

  /** Git commit hash of the platform code being evaluated */
  platformCommitHash: string;

  /** The golden repo that was evaluated */
  groundTruthName: string;

  /** Per-agent scores */
  agentScores: AgentScore[];

  /** Macro-averaged precision across all agents */
  macroPrecision: number;

  /** Macro-averaged recall across all agents */
  macroRecall: number;

  /** Macro-averaged F1 across all agents */
  macroF1: number;

  /** Total wall-clock time for the pipeline run (ms) */
  durationMs: number;

  /** Raw match details (for drill-down debugging) */
  matches: MatchResult[];
}

// ─── Database Row ────────────────────────────────────────────────────────────

/**
 * Shape of a single row in the `eval_runs` SQLite table.
 */
export interface EvalRunRow {
  id?: number;
  timestamp: string;
  commit_hash: string;
  ground_truth_name: string;
  agent_name: string;
  precision: number;
  recall: number;
  f1_score: number;
  true_positives: number;
  false_positives: number;
  false_negatives: number;
  severity_accuracy: number | null;
  duration_ms: number;
}

// ─── Eval Summary (top-level output) ─────────────────────────────────────────

/**
 * The final output of a complete eval pass across multiple golden repos.
 */
export interface EvalSummary {
  runs: EvalRunResult[];
  overall: {
    macroPrecision: number;
    macroRecall: number;
    macroF1: number;
    totalGroundTruths: number;
    totalFindings: number;
    totalTP: number;
    totalFP: number;
    totalFN: number;
  };
  regressions: RegressionAlert[];
}

/**
 * Fired when a metric drops below a threshold or below the previous run.
 */
export interface RegressionAlert {
  agentId: AgentId;
  metric: "precision" | "recall" | "f1";
  previousValue: number;
  currentValue: number;
  delta: number;
  severity: "WARNING" | "CRITICAL";
}

// ─── Fuzzy Match Config ──────────────────────────────────────────────────────

/**
 * Tuning knobs for the matcher.
 */
export interface MatcherConfig {
  /**
   * Maximum allowed line number delta for a match to count as a TP.
   * Default: 3 — the agent found the bug on line 43 instead of 42? Still a TP.
   */
  lineToleranceDelta: number;

  /**
   * Whether to normalise file paths before comparison (strip leading ./ etc).
   * Default: true.
   */
  normaliseFilePaths: boolean;
}

export const DEFAULT_MATCHER_CONFIG: MatcherConfig = {
  lineToleranceDelta: 3,
  normaliseFilePaths: true,
};

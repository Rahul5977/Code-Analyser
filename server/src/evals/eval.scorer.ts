// ─────────────────────────────────────────────────────────────────────────────
// src/evals/eval.scorer.ts
//
// Phase 6 – Scoring Engine: Precision, Recall, F1 with Fuzzy Matching.
//
// The core matching algorithm:
//   1. Normalise file paths on both sides (strip leading `./`, `src/../` etc).
//   2. Build a lookup index from ground truth: Map<normPath::ruleId, GT[]>.
//   3. For each agent finding, look up by normPath::category.
//      - If a GT exists within ±lineToleranceDelta → TP (mark GT as consumed).
//      - Otherwise → FP (hallucination).
//   4. Any GT not consumed → FN (missed vulnerability).
//   5. Calculate per-agent Precision, Recall, F1.
//
// Partial matches (e.g., line 43 vs line 42) are full TPs within the
// tolerance window.  The `lineDelta` field on MatchResult records exactly
// how far off the agent was for later analysis.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  AgentId,
  Finding,
  FindingCard,
  Severity,
} from "../interfaces/council.interface";
import type { CouncilReport } from "../interfaces/council.interface";
import type {
  KnownVulnerability,
  GroundTruth,
  MatchResult,
  MatchClass,
  AgentScore,
  MatcherConfig,
} from "./eval.interfaces";
import { DEFAULT_MATCHER_CONFIG } from "./eval.interfaces";

// ─── File Path Normalisation ─────────────────────────────────────────────────

/**
 * Canonicalise a file path for comparison:
 *   • Forward slashes only
 *   • Strip leading `./` or `/`
 *   • Collapse `foo/../bar` → `bar`
 *   • Lowercase (case-insensitive FS)
 */
function normalisePath(raw: string): string {
  let p = raw.replace(/\\/g, "/");
  p = p.replace(/^\.\//, "");
  p = p.replace(/^\//, "");
  // Collapse parent references
  const parts = p.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== ".") {
      resolved.push(part);
    }
  }
  return resolved.join("/").toLowerCase();
}

// ─── Signature Key ───────────────────────────────────────────────────────────

/**
 * Builds a lookup key from a file path + rule ID.
 * This is the coarse-grained match — line number is the fine-grained tiebreaker.
 */
function signatureKey(
  filePath: string,
  ruleId: string,
  normalise: boolean,
): string {
  const fp = normalise ? normalisePath(filePath) : filePath;
  return `${fp}::${ruleId.toLowerCase()}`;
}

// ─── Extract Findings from CouncilReport ─────────────────────────────────────

/**
 * Flattens a CouncilReport into an array of Findings for scoring.
 * Uses the FindingCard → finding path to extract all findings.
 */
export function extractFindings(report: CouncilReport): Finding[] {
  return report.findingCards.map((card: FindingCard) => card.finding);
}

// ─── Core Matcher ────────────────────────────────────────────────────────────

/**
 * Matches agent findings against ground truth vulnerabilities.
 *
 * Algorithm:
 *   1. Index GT by `normPath::ruleId` → GT entries (with line numbers).
 *   2. For each finding: look up by `normPath::category`.
 *      - Find the closest GT line within ±tolerance.
 *      - If found → TP, consume that GT entry.
 *      - If not → FP.
 *   3. Unconsumed GT entries → FN.
 *
 * Returns the full list of MatchResults (TPs + FPs + FNs).
 */
export function matchFindings(
  findings: Finding[],
  groundTruth: GroundTruth,
  config: MatcherConfig = DEFAULT_MATCHER_CONFIG,
): MatchResult[] {
  const results: MatchResult[] = [];
  const norm = config.normaliseFilePaths;
  const tolerance = config.lineToleranceDelta;

  // ── Build GT index ──
  // Map<signatureKey, Array<{ idx, vuln, consumed }>>
  const gtIndex = new Map<
    string,
    Array<{ idx: number; vuln: KnownVulnerability; consumed: boolean }>
  >();

  for (let i = 0; i < groundTruth.vulnerabilities.length; i++) {
    const vuln = groundTruth.vulnerabilities[i]!;
    const key = signatureKey(vuln.filePath, vuln.ruleId, norm);
    const arr = gtIndex.get(key) ?? [];
    arr.push({ idx: i, vuln, consumed: false });
    gtIndex.set(key, arr);
  }

  // ── Match each finding ──
  for (const finding of findings) {
    const key = signatureKey(finding.filePath, finding.category, norm);
    const candidates = gtIndex.get(key);

    if (!candidates || candidates.length === 0) {
      // FP — no ground truth for this file + rule combo
      results.push({
        matchClass: "FP",
        findingId: finding.id,
        filePath: finding.filePath,
        ruleId: finding.category,
        agentId: finding.agentId,
      });
      continue;
    }

    // Find the closest unconsumed GT within the line tolerance window
    let bestMatch: {
      idx: number;
      vuln: KnownVulnerability;
      consumed: boolean;
      delta: number;
    } | null = null;

    for (const candidate of candidates) {
      if (candidate.consumed) continue;
      const delta = Math.abs(finding.startLine - candidate.vuln.line);
      if (delta <= tolerance) {
        if (!bestMatch || delta < bestMatch.delta) {
          bestMatch = { ...candidate, delta };
        }
      }
    }

    if (bestMatch) {
      // TP — mark GT as consumed
      const original = candidates.find((c) => c.idx === bestMatch!.idx);
      if (original) original.consumed = true;

      results.push({
        matchClass: "TP",
        findingId: finding.id,
        groundTruthIdx: bestMatch.idx,
        filePath: finding.filePath,
        ruleId: finding.category,
        lineDelta: bestMatch.delta,
        agentId: finding.agentId,
      });
    } else {
      // FP — candidates exist but none within line tolerance (or all consumed)
      results.push({
        matchClass: "FP",
        findingId: finding.id,
        filePath: finding.filePath,
        ruleId: finding.category,
        agentId: finding.agentId,
      });
    }
  }

  // ── Remaining unconsumed GT → FN ──
  for (const [, candidates] of gtIndex) {
    for (const candidate of candidates) {
      if (!candidate.consumed) {
        results.push({
          matchClass: "FN",
          groundTruthIdx: candidate.idx,
          filePath: candidate.vuln.filePath,
          ruleId: candidate.vuln.ruleId,
          agentId: candidate.vuln.expectedAgent ?? "security",
        });
      }
    }
  }

  return results;
}

// ─── Per-Agent Scoring ───────────────────────────────────────────────────────

/**
 * Groups MatchResults by agent and computes Precision / Recall / F1.
 *
 * Agents that produced zero findings AND had zero expected FNs are omitted
 * (they simply weren't relevant for this repo).
 */
export function computeAgentScores(
  matches: MatchResult[],
  findings: Finding[],
  groundTruth: GroundTruth,
): AgentScore[] {
  // Collect all relevant agent IDs
  const agentIds = new Set<AgentId>();
  for (const m of matches) agentIds.add(m.agentId);

  const scores: AgentScore[] = [];

  for (const agentId of agentIds) {
    const agentMatches = matches.filter((m) => m.agentId === agentId);

    const tp = agentMatches.filter((m) => m.matchClass === "TP").length;
    const fp = agentMatches.filter((m) => m.matchClass === "FP").length;
    const fn = agentMatches.filter((m) => m.matchClass === "FN").length;

    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 =
      precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : 0;

    // Severity accuracy: of the TPs, what fraction had the right severity?
    const tpMatches = agentMatches.filter((m) => m.matchClass === "TP");
    let severityHits = 0;
    for (const m of tpMatches) {
      if (m.groundTruthIdx === undefined || m.findingId === undefined) continue;
      const gt = groundTruth.vulnerabilities[m.groundTruthIdx];
      const finding = findings.find((f) => f.id === m.findingId);
      if (gt && finding && gt.severity === finding.severity) severityHits++;
    }
    const severityAccuracy =
      tpMatches.length > 0 ? severityHits / tpMatches.length : undefined;

    scores.push({
      agentId,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      precision: round4(precision),
      recall: round4(recall),
      f1: round4(f1),
      severityAccuracy:
        severityAccuracy !== undefined ? round4(severityAccuracy) : undefined,
    });
  }

  // Sort by F1 descending for readability
  scores.sort((a, b) => b.f1 - a.f1);
  return scores;
}

// ─── Macro Averages ──────────────────────────────────────────────────────────

export function macroAverage(scores: AgentScore[]): {
  precision: number;
  recall: number;
  f1: number;
} {
  if (scores.length === 0) return { precision: 0, recall: 0, f1: 0 };
  const sum = scores.reduce(
    (acc, s) => ({
      precision: acc.precision + s.precision,
      recall: acc.recall + s.recall,
      f1: acc.f1 + s.f1,
    }),
    { precision: 0, recall: 0, f1: 0 },
  );
  return {
    precision: round4(sum.precision / scores.length),
    recall: round4(sum.recall / scores.length),
    f1: round4(sum.f1 / scores.length),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

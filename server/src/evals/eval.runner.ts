// ─────────────────────────────────────────────────────────────────────────────
// src/evals/eval.runner.ts
//
// Phase 6 – Evaluation Runner: Golden Repo Regression Harness.
//
// This is the top-level orchestrator for the eval harness.  It:
//   1. Loads ground truth definitions (from a JSON file or programmatic list).
//   2. For each golden repo, runs the full analysis pipeline (Ingest → Triage
//      → GraphRAG Sync → Council) — reusing the same BullMQ worker logic.
//   3. Extracts findings from the CouncilReport.
//   4. Runs the scorer (fuzzy matching, per-agent P/R/F1).
//   5. Detects regressions against previous runs in the eval DB.
//   6. Persists results to SQLite.
//   7. Prints rich CLI summary tables.
//
// Usage:
//   npx ts-node src/evals/eval.runner.ts [ground-truth.json]
//   — or —
//   import { runEvalSuite } from './evals';
//   const summary = await runEvalSuite(groundTruths, pipelineFn);
// ─────────────────────────────────────────────────────────────────────────────

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { logger } from "../utils/logger";
import type { CouncilReport, Finding, AgentId } from "../interfaces";

import type {
  GroundTruth,
  EvalRunResult,
  EvalSummary,
  RegressionAlert,
  AgentScore,
  MatchResult,
} from "./eval.interfaces";
import {
  matchFindings,
  extractFindings,
  computeAgentScores,
  macroAverage,
} from "./eval.scorer";
import {
  initEvalDb,
  insertEvalRun,
  insertRegressions,
  getPreviousScores,
  closeEvalDb,
} from "./eval.store";

const LOG_CTX = "EvalRunner";

// ─── Pipeline Function Signature ─────────────────────────────────────────────

/**
 * Signature for the pipeline function that the runner invokes for each repo.
 * In production this wraps the full Ingest → Triage → GraphRAG → Council flow.
 * For unit/integration testing, callers can inject a mock.
 */
export type PipelineFn = (repoUrl: string) => Promise<CouncilReport>;

// ─── Regression Detection ────────────────────────────────────────────────────

/**
 * Thresholds for regression alerts.
 *   • WARNING:  metric dropped >5pp (percentage points)
 *   • CRITICAL: metric dropped >15pp
 */
const REGRESSION_WARN_THRESHOLD = 0.05;
const REGRESSION_CRITICAL_THRESHOLD = 0.15;

function detectRegressions(
  groundTruthName: string,
  commitHash: string,
  currentScores: AgentScore[],
): RegressionAlert[] {
  const previous = getPreviousScores(groundTruthName, commitHash);
  if (previous.size === 0) return []; // First run — nothing to compare

  const alerts: RegressionAlert[] = [];

  for (const score of currentScores) {
    const prev = previous.get(score.agentId);
    if (!prev) continue; // New agent — no historical baseline

    const metrics: Array<{
      key: "precision" | "recall" | "f1";
      prev: number;
      curr: number;
    }> = [
      { key: "precision", prev: prev.precision, curr: score.precision },
      { key: "recall", prev: prev.recall, curr: score.recall },
      { key: "f1", prev: prev.f1, curr: score.f1 },
    ];

    for (const m of metrics) {
      const delta = m.curr - m.prev;
      if (delta < -REGRESSION_CRITICAL_THRESHOLD) {
        alerts.push({
          agentId: score.agentId,
          metric: m.key,
          previousValue: m.prev,
          currentValue: m.curr,
          delta: round4(delta),
          severity: "CRITICAL",
        });
      } else if (delta < -REGRESSION_WARN_THRESHOLD) {
        alerts.push({
          agentId: score.agentId,
          metric: m.key,
          previousValue: m.prev,
          currentValue: m.curr,
          delta: round4(delta),
          severity: "WARNING",
        });
      }
    }
  }

  return alerts;
}

// ─── Get Platform Commit Hash ────────────────────────────────────────────────

function getPlatformCommitHash(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

// ─── Single Repo Evaluation ──────────────────────────────────────────────────

/**
 * Evaluates a single golden repository:
 *   1. Run the pipeline.
 *   2. Extract findings.
 *   3. Match against ground truth.
 *   4. Score agents.
 *   5. Return an EvalRunResult.
 */
export async function evaluateSingleRepo(
  groundTruth: GroundTruth,
  pipelineFn: PipelineFn,
  commitHash: string,
): Promise<EvalRunResult> {
  const startTime = Date.now();

  logger.info(
    LOG_CTX,
    `▶ Evaluating "${groundTruth.name}" (${groundTruth.vulnerabilities.length} known vulns)`,
  );

  // ── Run the full pipeline ──
  let report: CouncilReport;
  try {
    report = await pipelineFn(groundTruth.repoUrl);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(LOG_CTX, `Pipeline failed for "${groundTruth.name}": ${msg}`);

    // Return a zero-score result so the run is still recorded
    return {
      timestamp: new Date().toISOString(),
      platformCommitHash: commitHash,
      groundTruthName: groundTruth.name,
      agentScores: [],
      macroPrecision: 0,
      macroRecall: 0,
      macroF1: 0,
      durationMs: Date.now() - startTime,
      matches: [],
    };
  }

  const durationMs = Date.now() - startTime;

  // ── Extract findings from the council report ──
  const findings: Finding[] = extractFindings(report);

  logger.info(
    LOG_CTX,
    `  Pipeline returned ${findings.length} findings in ${durationMs}ms`,
  );

  // ── Match against ground truth (fuzzy) ──
  const matches: MatchResult[] = matchFindings(findings, groundTruth);

  // ── Score each agent ──
  const agentScores = computeAgentScores(matches, findings, groundTruth);
  const macro = macroAverage(agentScores);

  const result: EvalRunResult = {
    timestamp: new Date().toISOString(),
    platformCommitHash: commitHash,
    groundTruthName: groundTruth.name,
    agentScores,
    macroPrecision: macro.precision,
    macroRecall: macro.recall,
    macroF1: macro.f1,
    durationMs,
    matches,
  };

  return result;
}

// ─── Full Eval Suite ─────────────────────────────────────────────────────────

/**
 * Runs the complete eval harness across all golden repos.
 *
 * @param groundTruths - Array of golden repo ground truth definitions
 * @param pipelineFn   - The function to execute the analysis pipeline
 * @param options      - Optional: skip DB persistence, custom commit hash
 * @returns EvalSummary with per-repo results, regressions, and overall metrics
 */
export async function runEvalSuite(
  groundTruths: GroundTruth[],
  pipelineFn: PipelineFn,
  options: {
    skipDb?: boolean;
    commitHash?: string;
  } = {},
): Promise<EvalSummary> {
  const commitHash = options.commitHash ?? getPlatformCommitHash();
  const skipDb = options.skipDb ?? false;

  logger.info(
    LOG_CTX,
    `═══════════════════════════════════════════════════════`,
  );
  logger.info(LOG_CTX, ` Eval Harness — ${groundTruths.length} golden repo(s)`);
  logger.info(LOG_CTX, ` Platform commit: ${commitHash.slice(0, 12)}`);
  logger.info(
    LOG_CTX,
    `═══════════════════════════════════════════════════════`,
  );

  // Initialise DB
  if (!skipDb) {
    initEvalDb();
  }

  const runs: EvalRunResult[] = [];
  const allRegressions: RegressionAlert[] = [];

  // ── Evaluate each golden repo sequentially ──
  for (const gt of groundTruths) {
    const result = await evaluateSingleRepo(gt, pipelineFn, commitHash);
    runs.push(result);

    // Persist to DB
    if (!skipDb && result.agentScores.length > 0) {
      insertEvalRun(result);
    }

    // Regression detection
    if (!skipDb) {
      const regressions = detectRegressions(
        gt.name,
        commitHash,
        result.agentScores,
      );
      if (regressions.length > 0) {
        insertRegressions(commitHash, regressions);
        allRegressions.push(...regressions);
      }
    }
  }

  // ── Compute overall aggregates ──
  const allMatches = runs.flatMap((r) => r.matches);
  const totalTP = allMatches.filter((m) => m.matchClass === "TP").length;
  const totalFP = allMatches.filter((m) => m.matchClass === "FP").length;
  const totalFN = allMatches.filter((m) => m.matchClass === "FN").length;
  const totalGroundTruths = groundTruths.reduce(
    (sum, gt) => sum + gt.vulnerabilities.length,
    0,
  );
  const totalFindings = runs.reduce(
    (sum, r) => sum + r.matches.filter((m) => m.matchClass !== "FN").length,
    0,
  );

  // Macro averages across all runs
  const allAgentScores = runs.flatMap((r) => r.agentScores);
  const overallMacro = macroAverage(allAgentScores);

  const summary: EvalSummary = {
    runs,
    overall: {
      macroPrecision: overallMacro.precision,
      macroRecall: overallMacro.recall,
      macroF1: overallMacro.f1,
      totalGroundTruths,
      totalFindings,
      totalTP,
      totalFP,
      totalFN,
    },
    regressions: allRegressions,
  };

  // ── Print summary tables ──
  printSummaryTables(summary);

  // Close DB
  if (!skipDb) {
    closeEvalDb();
  }

  return summary;
}

// ─── CLI Summary Printing ────────────────────────────────────────────────────

function printSummaryTables(summary: EvalSummary): void {
  const SEP = "─".repeat(80);

  console.log("\n" + SEP);
  console.log("  📊  EVAL HARNESS RESULTS");
  console.log(SEP);

  // ── Per-Repo Results ──
  for (const run of summary.runs) {
    console.log(`\n  🔍 ${run.groundTruthName}`);
    console.log(
      `     Duration: ${run.durationMs}ms | Commit: ${run.platformCommitHash.slice(0, 8)}`,
    );
    console.log("");

    if (run.agentScores.length === 0) {
      console.log(
        "     ⚠️  No findings produced (pipeline error or zero output)",
      );
      continue;
    }

    // Agent table header
    console.log(
      "     " +
        padRight("Agent", 18) +
        padRight("Prec", 8) +
        padRight("Recall", 8) +
        padRight("F1", 8) +
        padRight("TP", 5) +
        padRight("FP", 5) +
        padRight("FN", 5) +
        "SevAcc",
    );
    console.log("     " + "─".repeat(62));

    for (const s of run.agentScores) {
      console.log(
        "     " +
          padRight(s.agentId, 18) +
          padRight(pct(s.precision), 8) +
          padRight(pct(s.recall), 8) +
          padRight(pct(s.f1), 8) +
          padRight(String(s.truePositives), 5) +
          padRight(String(s.falsePositives), 5) +
          padRight(String(s.falseNegatives), 5) +
          (s.severityAccuracy !== undefined ? pct(s.severityAccuracy) : "N/A"),
      );
    }

    console.log("");
    console.log(
      `     Macro: Prec=${pct(run.macroPrecision)}  Recall=${pct(run.macroRecall)}  F1=${pct(run.macroF1)}`,
    );
  }

  // ── Overall Aggregates ──
  console.log("\n" + SEP);
  console.log("  📈  OVERALL AGGREGATES");
  console.log(SEP);
  const o = summary.overall;
  console.log(`     Ground Truth Vulns:  ${o.totalGroundTruths}`);
  console.log(`     Agent Findings:      ${o.totalFindings}`);
  console.log(`     True Positives:      ${o.totalTP}`);
  console.log(`     False Positives:     ${o.totalFP}`);
  console.log(`     False Negatives:     ${o.totalFN}`);
  console.log(`     Macro Precision:     ${pct(o.macroPrecision)}`);
  console.log(`     Macro Recall:        ${pct(o.macroRecall)}`);
  console.log(`     Macro F1:            ${pct(o.macroF1)}`);

  // ── Regressions ──
  if (summary.regressions.length > 0) {
    console.log("\n" + SEP);
    console.log("  🚨  REGRESSIONS DETECTED");
    console.log(SEP);

    for (const r of summary.regressions) {
      const icon = r.severity === "CRITICAL" ? "🔴" : "🟡";
      console.log(
        `     ${icon} [${r.severity}] ${r.agentId}.${r.metric}: ` +
          `${pct(r.previousValue)} → ${pct(r.currentValue)} (${r.delta > 0 ? "+" : ""}${pct(r.delta)})`,
      );
    }
  } else {
    console.log("\n     ✅  No regressions detected.");
  }

  console.log("\n" + SEP + "\n");
}

// ─── Load Ground Truth from JSON ─────────────────────────────────────────────

/**
 * Loads ground truth definitions from a JSON file.
 *
 * Expected file structure:
 * ```json
 * [
 *   {
 *     "name": "OWASP Juice Shop",
 *     "repoUrl": "https://github.com/juice-shop/juice-shop.git",
 *     "commitHash": "abc123...",
 *     "vulnerabilities": [
 *       { "filePath": "routes/login.ts", "ruleId": "SQL_INJECTION", "line": 42, "severity": "CRITICAL" },
 *       ...
 *     ]
 *   }
 * ]
 * ```
 */
export function loadGroundTruths(filePath: string): GroundTruth[] {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Ground truth file not found: ${absPath}`);
  }

  const raw = fs.readFileSync(absPath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error(
      "Ground truth file must contain a JSON array of GroundTruth objects",
    );
  }

  // Basic validation
  for (let i = 0; i < parsed.length; i++) {
    const gt = parsed[i] as Record<string, unknown>;
    if (
      !gt["name"] ||
      !gt["repoUrl"] ||
      !gt["commitHash"] ||
      !Array.isArray(gt["vulnerabilities"])
    ) {
      throw new Error(
        `Ground truth entry [${i}] is missing required fields: name, repoUrl, commitHash, vulnerabilities`,
      );
    }
  }

  return parsed as GroundTruth[];
}

// ─── Built-in Example Ground Truth (for smoke testing) ──────────────────────

/**
 * Returns a tiny built-in ground truth for smoke-testing the harness.
 * This allows `npx ts-node src/evals/eval.runner.ts --smoke` to work
 * without an external JSON file.
 */
export function getSmokeTruth(): GroundTruth {
  return {
    name: "Smoke Test (synthetic)",
    repoUrl: "https://github.com/OWASP/NodeGoat.git",
    commitHash: "smoke-test",
    vulnerabilities: [
      {
        filePath: "app/routes/index.js",
        ruleId: "SQL_INJECTION",
        line: 50,
        severity: "CRITICAL",
        expectedAgent: "security",
        description: "NoSQL injection in user login",
      },
      {
        filePath: "app/routes/index.js",
        ruleId: "XSS",
        line: 120,
        severity: "HIGH",
        expectedAgent: "security",
        description: "Reflected XSS in search endpoint",
      },
      {
        filePath: "app/data/user-dao.js",
        ruleId: "INSECURE_AUTH",
        line: 30,
        severity: "HIGH",
        expectedAgent: "security",
        description: "Password stored in plain text",
      },
    ],
  };
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

/**
 * When this file is executed directly, it runs the eval harness as a CLI tool.
 *
 * Usage:
 *   npx ts-node src/evals/eval.runner.ts path/to/ground-truth.json
 *   npx ts-node src/evals/eval.runner.ts --smoke
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isSmoke = args.includes("--smoke");
  const jsonArg = args.find((a) => a.endsWith(".json"));

  let groundTruths: GroundTruth[];

  if (isSmoke) {
    logger.info(LOG_CTX, "🧪 Running smoke test with built-in ground truth…");
    groundTruths = [getSmokeTruth()];
  } else if (jsonArg) {
    logger.info(LOG_CTX, `Loading ground truths from: ${jsonArg}`);
    groundTruths = loadGroundTruths(jsonArg);
  } else {
    console.log("Usage:");
    console.log(
      "  npx ts-node src/evals/eval.runner.ts path/to/ground-truth.json",
    );
    console.log("  npx ts-node src/evals/eval.runner.ts --smoke");
    process.exit(1);
  }

  // ── Build the pipeline function ──
  // Dynamically import to avoid circular deps and keep this file independently runnable
  const pipelineFn: PipelineFn = await buildDefaultPipelineFn();

  const summary = await runEvalSuite(groundTruths, pipelineFn);

  // Exit code: non-zero if there are CRITICAL regressions
  const criticalCount = summary.regressions.filter(
    (r) => r.severity === "CRITICAL",
  ).length;
  if (criticalCount > 0) {
    logger.error(
      LOG_CTX,
      `🔴 ${criticalCount} CRITICAL regression(s) detected. Failing CI.`,
    );
    process.exit(2);
  }

  process.exit(0);
}

// ─── Default Pipeline Function Builder ───────────────────────────────────────

/**
 * Constructs the default pipeline function that wires together:
 *   Ingest → Triage → GraphRAG Sync → Council
 *
 * This mirrors the BullMQ worker logic but runs synchronously in-process
 * (no Redis/BullMQ dependency) — ideal for eval harness execution.
 */
async function buildDefaultPipelineFn(): Promise<PipelineFn> {
  // Lazy imports to keep the file lightweight when used as a library
  const { ingestRepository } = await import("../ingestors");
  const { parseAndTriage } = await import("../parsers");
  const { GraphRagService } = await import("../graph-rag");
  const { runCouncil } = await import("../council");

  return async (repoUrl: string): Promise<CouncilReport> => {
    const jobId = `eval-${Date.now()}`;

    // Phase 1: Ingest
    logger.info(LOG_CTX, `  [ingest] Cloning ${repoUrl}…`);
    const manifest = await ingestRepository(repoUrl, jobId);

    // Phase 2: Parse & Triage
    logger.info(
      LOG_CTX,
      `  [triage] Parsing ${manifest.targetFiles.length} files…`,
    );
    const triage = await parseAndTriage(
      manifest.targetFiles,
      manifest.localPath,
    );

    // Derive repoId from URL
    const repoId =
      repoUrl
        .replace(/\.git$/, "")
        .split("/")
        .filter(Boolean)
        .slice(-2)
        .join("/") || jobId;

    // Phase 3: GraphRAG (optional — skip if Qdrant/Neo4j not available)
    let graphRagService: InstanceType<typeof GraphRagService> | null = null;
    try {
      const config = {
        qdrant: {
          url: process.env["QDRANT_URL"] ?? "http://localhost:6333",
          apiKey: process.env["QDRANT_API_KEY"],
          collectionName: `eval_${jobId}`,
        },
        neo4j: {
          uri: process.env["NEO4J_URI"] ?? "bolt://localhost:7687",
          username: process.env["NEO4J_USERNAME"] ?? "neo4j",
          password: process.env["NEO4J_PASSWORD"] ?? "password",
          database: process.env["NEO4J_DATABASE"] ?? "neo4j",
        },
        embeddingDimension: Number(process.env["EMBEDDING_DIM"] ?? "384"),
      };

      // Stub embedding for eval (mirrors server/src/index.ts)
      const embedFn = async (text: string): Promise<number[]> => {
        const dim = config.embeddingDimension;
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
      const embedBatchFn = async (texts: string[]): Promise<number[][]> =>
        Promise.all(texts.map((t) => embedFn(t)));

      graphRagService = new GraphRagService(config, embedFn, embedBatchFn);
      await graphRagService.init();
      await graphRagService.sync(triage, repoId);
      logger.info(LOG_CTX, `  [graphrag] Sync complete for ${repoId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(LOG_CTX, `  [graphrag] Skipped (not available): ${msg}`);
    }

    // Phase 4: Council
    logger.info(LOG_CTX, `  [council] Running multi-agent analysis…`);

    // Stub LLM (eval harness doesn't need a real LLM unless configured)
    const stubLlmFn = async (
      messages: Array<{ role: string; content: string }>,
    ): Promise<{ role: "assistant"; content: string }> => {
      const systemMsg = messages.find((m) => m.role === "system");
      const lastUser = messages.filter((m) => m.role === "user").pop();
      const content = lastUser?.content ?? "";
      const isJson = systemMsg?.content.includes("JSON") ?? false;

      if (isJson && content.includes("analysis plan")) {
        return {
          role: "assistant",
          content: JSON.stringify({
            securityTargets: [],
            performanceTargets: [],
            architectureScope: { focusModules: [] },
            testCoverageEnabled: false,
            crossReferences: [],
          }),
        };
      }
      if (isJson && content.includes("findings")) {
        return { role: "assistant", content: "[]" };
      }
      if (isJson && content.includes("architectural")) {
        return {
          role: "assistant",
          content: JSON.stringify({
            circularDependencies: [],
            couplingScores: [],
            godClasses: [],
            layerViolations: [],
            detectedPattern: "Unknown",
            summary: "Eval stub LLM.",
          }),
        };
      }
      return { role: "assistant", content: "Eval stub LLM response." };
    };

    const councilConfig = {
      llmFn: stubLlmFn as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      maxIterations: Number(process.env["COUNCIL_MAX_ITERATIONS"] ?? "10"),
      maxReinvestigations: Number(
        process.env["COUNCIL_MAX_REINVESTIGATIONS"] ?? "2",
      ),
      disputeThreshold: Number(
        process.env["COUNCIL_DISPUTE_THRESHOLD"] ?? "0.6",
      ),
      temperature: Number(process.env["COUNCIL_TEMPERATURE"] ?? "0.3"),
    };

    const councilDeps: Record<string, unknown> = {
      toolDeps: {
        graphRag: graphRagService,
        neo4j: graphRagService?.neo4j ?? null,
        qdrant: graphRagService?.qdrant ?? null,
        repoId,
      },
      qdrant: graphRagService?.qdrant ?? null,
      embedFn: graphRagService?.embedFn ?? null,
    };

    const councilReport = await runCouncil(
      manifest,
      triage,
      repoId,
      councilConfig,
      councilDeps as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    );

    // Cleanup
    if (graphRagService) {
      try {
        await graphRagService.dropRepo(repoId);
        await graphRagService.close();
      } catch {
        // Best-effort cleanup
      }
    }

    // Cleanup temp directory
    const tempDir = path.resolve(process.cwd(), "temp", jobId);
    try {
      const fsPromises = await import("node:fs/promises");
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }

    return councilReport;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

function pct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ─── Auto-run when executed directly ─────────────────────────────────────────

// Check if this file is the entry point (CommonJS compatible)
const isMainModule = typeof require !== "undefined" && require.main === module;

if (isMainModule) {
  main().catch((err) => {
    logger.error(
      LOG_CTX,
      `Fatal error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}

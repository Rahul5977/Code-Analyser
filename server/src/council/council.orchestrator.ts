// ─────────────────────────────────────────────────────────────────────────────
// src/council/council.orchestrator.ts
//
// Phase 4 – The Council Orchestrator (Graph Topology)
//
// Implements the full multi-agent pipeline:
//
//   Orchestrator → [Security, Performance, Architecture, TestCoverage] (parallel)
//                ↓
//             Debate/Critique Agent
//                ↓
//             Synthesis Agent
//                ↓
//             Final Report
//
// The Critique Agent acts as a join node with a conditional edge — if it
// disputes more than 60% of findings, it routes back to the Orchestrator
// with a "re-investigate" signal rather than producing a low-confidence report.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "../utils/logger";
import {
  runOrchestratorAgent,
  runSecurityAgent,
  runPerformanceAgent,
  runArchitectureAgent,
  runTestCoverageAgent,
  runCritiqueAgent,
  runSynthesisAgent,
} from "./agents";
import type { ToolFactoryDeps } from "./tools";
import type { QdrantStore } from "../graph-rag/qdrant.store";
import type { EmbedFunction } from "../interfaces/graph-rag.interface";
import type {
  CouncilState,
  CouncilConfig,
  CouncilReport,
  Finding,
  AgentId,
} from "../interfaces/council.interface";
import type { RepoManifest } from "../interfaces/repo-manifest.interface";
import type { TriageResult } from "../interfaces/triage.interface";

const LOG_CTX = "CouncilOrchestrator";

// ─── Council Orchestrator ────────────────────────────────────────────────────

export interface CouncilDependencies {
  toolDeps: ToolFactoryDeps;
  qdrant: QdrantStore;
  embedFn: EmbedFunction;
}

/**
 * Executes the full LangGraph Council pipeline.
 *
 * Graph topology:
 *   1. Orchestrator (Planner) — produces an AnalysisPlan.
 *   2. Fan-out: Security, Performance, Architecture, TestCoverage (parallel).
 *   3. Join: Critique Agent verifies all findings.
 *   4. Conditional: if disputeRate > threshold → re-investigate (up to N cycles).
 *   5. Synthesis Agent produces FindingCards from confirmed/plausible findings.
 *   6. Final Report assembly.
 */
export async function runCouncil(
  manifest: RepoManifest,
  triage: TriageResult,
  repoId: string,
  config: CouncilConfig,
  deps: CouncilDependencies,
): Promise<CouncilReport> {
  const t0 = Date.now();

  // ── Initialise shared state ──
  const state: CouncilState = {
    repoId,
    manifest,
    triage,
    securityFindings: [],
    performanceFindings: [],
    critiquedFindings: [],
    disputeRate: 0,
    reinvestigationRequested: false,
    reinvestigationCount: 0,
    findingCards: [],
    errors: [],
    startedAt: new Date().toISOString(),
  };

  logger.info(
    LOG_CTX,
    "═══════════════════════════════════════════════════════════",
  );
  logger.info(
    LOG_CTX,
    "  Phase 4: LangGraph Council — Starting Multi-Agent Pipeline",
  );
  logger.info(LOG_CTX, `  Repo: ${repoId} | Chunks: ${triage.chunks.length}`);
  logger.info(
    LOG_CTX,
    "═══════════════════════════════════════════════════════════",
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Node 1: Orchestrator Agent (Planner)
  // ──────────────────────────────────────────────────────────────────────────

  logger.info(LOG_CTX, "┌─ Node 1: Orchestrator Agent (Planner)");
  try {
    state.analysisPlan = await runOrchestratorAgent(
      state,
      deps.toolDeps,
      config.llmFn,
      config.maxIterations,
      config.temperature,
    );
    logger.info(
      LOG_CTX,
      `└─ Plan: ${state.analysisPlan.securityTargets.length} security targets, ` +
        `${state.analysisPlan.performanceTargets.length} performance targets, ` +
        `testCoverage=${state.analysisPlan.testCoverageEnabled}`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(LOG_CTX, `└─ Orchestrator failed: ${msg}`);
    recordError(state, "orchestrator", msg);
    // Generate a default plan so downstream agents can still run
    state.analysisPlan = generateEmergencyPlan(state);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Node 2: Parallel Fan-Out — Security, Performance, Architecture, TestCoverage
  // ──────────────────────────────────────────────────────────────────────────

  let investigationCycle = 0;
  const maxReinvestigations = config.maxReinvestigations ?? 2;

  do {
    investigationCycle++;
    logger.info(
      LOG_CTX,
      `┌─ Node 2: Parallel Fan-Out (cycle ${investigationCycle}/${maxReinvestigations + 1})`,
    );

    const plan = state.analysisPlan!;
    const parallelResults = await executeParallelAgents(
      state,
      plan,
      config,
      deps,
    );

    // Merge results into state
    state.securityFindings = parallelResults.securityFindings;
    state.performanceFindings = parallelResults.performanceFindings;
    if (parallelResults.architectureReport) {
      state.architectureReport = parallelResults.architectureReport;
    }
    if (parallelResults.coverageReport) {
      state.coverageReport = parallelResults.coverageReport;
    }
    for (const err of parallelResults.errors) {
      recordError(state, err.agentId, err.message);
    }

    const totalFindings =
      state.securityFindings.length + state.performanceFindings.length;
    logger.info(
      LOG_CTX,
      `└─ Fan-out complete: ${state.securityFindings.length} security + ` +
        `${state.performanceFindings.length} performance = ${totalFindings} findings`,
    );

    // ────────────────────────────────────────────────────────────────────────
    // Node 3: Critique / Debate Agent (Join Node)
    // ────────────────────────────────────────────────────────────────────────

    const allFindings: Finding[] = [
      ...state.securityFindings,
      ...state.performanceFindings,
    ];

    if (allFindings.length === 0) {
      logger.info(
        LOG_CTX,
        "┌─ Node 3: Critique Agent — No findings to critique",
      );
      state.critiquedFindings = [];
      state.disputeRate = 0;
      state.reinvestigationRequested = false;
      break;
    }

    logger.info(
      LOG_CTX,
      `┌─ Node 3: Critique Agent (${allFindings.length} findings)`,
    );
    try {
      const critiqueResult = await runCritiqueAgent(
        allFindings,
        deps.qdrant,
        config.llmFn,
        config.maxIterations,
        config.temperature,
      );

      state.critiquedFindings = critiqueResult.findings;
      state.disputeRate = critiqueResult.disputeRate;

      logger.info(
        LOG_CTX,
        `└─ Critique: dispute rate = ${(state.disputeRate * 100).toFixed(1)}% ` +
          `(threshold: ${(config.disputeThreshold * 100).toFixed(1)}%)`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(LOG_CTX, `└─ Critique Agent failed: ${msg}`);
      recordError(state, "critique", msg);
      // Fallback: keep findings as-is, mark as PLAUSIBLE
      state.critiquedFindings = allFindings.map((f) => ({
        ...f,
        critiqueVerdict: "PLAUSIBLE" as const,
        critiqueReason: "Critique agent failed — defaulting to PLAUSIBLE.",
      }));
      state.disputeRate = 0;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Conditional Edge: Re-investigate if dispute rate > threshold
    // ────────────────────────────────────────────────────────────────────────

    if (
      state.disputeRate > config.disputeThreshold &&
      state.reinvestigationCount < maxReinvestigations
    ) {
      state.reinvestigationRequested = true;
      state.reinvestigationCount++;
      logger.warn(
        LOG_CTX,
        `⚠ Dispute rate ${(state.disputeRate * 100).toFixed(1)}% exceeds threshold — ` +
          `re-investigating (cycle ${state.reinvestigationCount}/${maxReinvestigations})`,
      );

      // Refine the analysis plan: focus only on disputed findings
      const disputedFindings = state.critiquedFindings.filter(
        (f) => f.critiqueVerdict === "DISPUTED",
      );
      state.analysisPlan = refineAnalysisPlan(
        state.analysisPlan!,
        disputedFindings,
      );
    } else {
      state.reinvestigationRequested = false;
    }
  } while (state.reinvestigationRequested);

  // ──────────────────────────────────────────────────────────────────────────
  // Node 4: Synthesis / Pedagogical Agent
  // ──────────────────────────────────────────────────────────────────────────

  logger.info(
    LOG_CTX,
    `┌─ Node 4: Synthesis Agent (${state.critiquedFindings.length} critiqued findings)`,
  );
  try {
    state.findingCards = await runSynthesisAgent(
      state.critiquedFindings,
      config.llmFn,
      config.maxIterations,
      config.temperature,
    );
    logger.info(
      LOG_CTX,
      `└─ Synthesis: ${state.findingCards.length} finding card(s) produced`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(LOG_CTX, `└─ Synthesis Agent failed: ${msg}`);
    recordError(state, "synthesis", msg);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Node 5: Final Report Assembly
  // ──────────────────────────────────────────────────────────────────────────

  const durationMs = Date.now() - t0;
  state.completedAt = new Date().toISOString();
  state.totalDurationMs = durationMs;

  const report = assembleReport(state, durationMs);

  logger.info(
    LOG_CTX,
    "═══════════════════════════════════════════════════════════",
  );
  logger.info(LOG_CTX, `  Council Complete in ${durationMs}ms`);
  logger.info(
    LOG_CTX,
    `  Findings: ${report.metadata.totalFindings} total, ` +
      `${report.metadata.confirmedFindings} confirmed, ` +
      `${report.metadata.plausibleFindings} plausible, ` +
      `${report.metadata.disputedFindings} disputed`,
  );
  logger.info(
    LOG_CTX,
    `  Re-investigation cycles: ${report.metadata.reinvestigationCycles}`,
  );
  logger.info(LOG_CTX, `  Errors: ${state.errors.length}`);
  logger.info(
    LOG_CTX,
    "═══════════════════════════════════════════════════════════",
  );

  return report;
}

// ─── Parallel Agent Execution ────────────────────────────────────────────────

interface ParallelResults {
  securityFindings: Finding[];
  performanceFindings: Finding[];
  architectureReport?: import("../interfaces/council.interface").ArchitectureReport;
  coverageReport?: import("../interfaces/council.interface").CoverageReport;
  errors: Array<{ agentId: AgentId; message: string }>;
}

async function executeParallelAgents(
  state: CouncilState,
  plan: import("../interfaces/council.interface").AnalysisPlan,
  config: CouncilConfig,
  deps: CouncilDependencies,
): Promise<ParallelResults> {
  const errors: Array<{ agentId: AgentId; message: string }> = [];

  // Build all agent promises
  const securityPromise =
    plan.securityTargets.length > 0
      ? runSecurityAgent(
          plan.securityTargets,
          deps.toolDeps,
          config.llmFn,
          config.maxIterations,
          config.temperature,
        ).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ agentId: "security", message: msg });
          return [] as Finding[];
        })
      : Promise.resolve([] as Finding[]);

  const performancePromise =
    plan.performanceTargets.length > 0
      ? runPerformanceAgent(
          plan.performanceTargets,
          {
            toolDeps: deps.toolDeps,
            qdrant: deps.qdrant,
            embedFn: deps.embedFn,
            repoId: state.repoId,
          },
          config.llmFn,
          config.maxIterations,
          config.temperature,
        ).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ agentId: "performance", message: msg });
          return [] as Finding[];
        })
      : Promise.resolve([] as Finding[]);

  const architecturePromise = runArchitectureAgent(
    state,
    config.llmFn,
    config.maxIterations,
    config.temperature,
  ).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push({ agentId: "architecture", message: msg });
    return undefined;
  });

  const coveragePromise = plan.testCoverageEnabled
    ? runTestCoverageAgent(
        state,
        deps.toolDeps,
        config.llmFn,
        config.maxIterations,
        config.temperature,
      ).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ agentId: "test-coverage", message: msg });
        return undefined;
      })
    : Promise.resolve(undefined);

  // Execute all in parallel (fan-out)
  const [
    securityFindings,
    performanceFindings,
    architectureReport,
    coverageReport,
  ] = await Promise.all([
    securityPromise,
    performancePromise,
    architecturePromise,
    coveragePromise,
  ]);

  return {
    securityFindings,
    performanceFindings,
    architectureReport: architectureReport ?? undefined,
    coverageReport: coverageReport ?? undefined,
    errors,
  };
}

// ─── Plan Refinement (for re-investigation cycles) ───────────────────────────

function refineAnalysisPlan(
  originalPlan: import("../interfaces/council.interface").AnalysisPlan,
  disputedFindings: Finding[],
): import("../interfaces/council.interface").AnalysisPlan {
  // Create refined targets focused on files/chunks from disputed findings
  const securityDisputed = disputedFindings.filter(
    (f) => f.agentId === "security",
  );
  const performanceDisputed = disputedFindings.filter(
    (f) => f.agentId === "performance",
  );

  return {
    securityTargets:
      securityDisputed.length > 0
        ? [
            {
              chunkIds: securityDisputed.flatMap((f) => f.chunkIds),
              filePaths: [...new Set(securityDisputed.map((f) => f.filePath))],
              reason:
                "Re-investigation: previous findings were disputed by the Critique Agent",
              priority: "HIGH" as const,
            },
          ]
        : originalPlan.securityTargets.slice(0, 3), // retry with fewer targets
    performanceTargets:
      performanceDisputed.length > 0
        ? [
            {
              chunkIds: performanceDisputed.flatMap((f) => f.chunkIds),
              filePaths: [
                ...new Set(performanceDisputed.map((f) => f.filePath)),
              ],
              reason:
                "Re-investigation: previous findings were disputed by the Critique Agent",
              priority: "HIGH" as const,
            },
          ]
        : originalPlan.performanceTargets.slice(0, 3),
    architectureScope: originalPlan.architectureScope,
    testCoverageEnabled: originalPlan.testCoverageEnabled,
    crossReferences: originalPlan.crossReferences,
  };
}

// ─── Report Assembly ─────────────────────────────────────────────────────────

function assembleReport(
  state: CouncilState,
  durationMs: number,
): CouncilReport {
  const allCritiqued = state.critiquedFindings;
  const confirmed = allCritiqued.filter(
    (f) => f.critiqueVerdict === "CONFIRMED",
  );
  const plausible = allCritiqued.filter(
    (f) => f.critiqueVerdict === "PLAUSIBLE",
  );
  const disputed = allCritiqued.filter((f) => f.critiqueVerdict === "DISPUTED");

  // Build executive summary
  const summaryParts: string[] = [];

  if (confirmed.length > 0) {
    const critical = confirmed.filter(
      (f) => f.severity === "CRITICAL" || f.severity === "HIGH",
    );
    summaryParts.push(
      `${confirmed.length} confirmed finding(s)` +
        (critical.length > 0
          ? ` (${critical.length} critical/high severity)`
          : ""),
    );
  }
  if (plausible.length > 0) {
    summaryParts.push(
      `${plausible.length} plausible finding(s) requiring review`,
    );
  }
  if (state.architectureReport) {
    const archIssues =
      state.architectureReport.circularDependencies.length +
      state.architectureReport.godClasses.length +
      state.architectureReport.layerViolations.length;
    if (archIssues > 0) {
      summaryParts.push(`${archIssues} architectural issue(s) detected`);
    }
  }
  if (state.coverageReport) {
    const tier1Gaps = state.coverageReport.gaps.filter(
      (g) => g.riskTier === 1,
    ).length;
    if (tier1Gaps > 0) {
      summaryParts.push(`${tier1Gaps} tier-1 test coverage gap(s)`);
    }
  }
  if (state.errors.length > 0) {
    summaryParts.push(`${state.errors.length} agent error(s) encountered`);
  }

  const summary =
    summaryParts.length > 0
      ? `Council analysis of "${state.repoId}" completed in ${durationMs}ms. ` +
        summaryParts.join(". ") +
        "."
      : `Council analysis of "${state.repoId}" completed in ${durationMs}ms. No significant issues found.`;

  return {
    repoId: state.repoId,
    summary,
    findingCards: state.findingCards,
    architectureReport: state.architectureReport,
    coverageReport: state.coverageReport,
    metadata: {
      totalFindings: allCritiqued.length,
      confirmedFindings: confirmed.length,
      plausibleFindings: plausible.length,
      disputedFindings: disputed.length,
      reinvestigationCycles: state.reinvestigationCount,
      durationMs,
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function recordError(
  state: CouncilState,
  agentId: AgentId,
  message: string,
): void {
  state.errors.push({
    agentId,
    message,
    timestamp: new Date().toISOString(),
  });
}

/** Emergency fallback plan when the Orchestrator agent completely fails */
function generateEmergencyPlan(
  state: CouncilState,
): import("../interfaces/council.interface").AnalysisPlan {
  const topChunks = state.triage.chunks
    .sort((a, b) => b.cyclomaticComplexity - a.cyclomaticComplexity)
    .slice(0, 10);

  const hasTests = state.manifest.targetFiles.some(
    (f) =>
      f.includes(".test.") || f.includes(".spec.") || f.includes("__tests__"),
  );

  return {
    securityTargets: [
      {
        chunkIds: topChunks.map((c) => c.id),
        filePaths: [...new Set(topChunks.map((c) => c.filePath))],
        reason: "Emergency plan: top complexity chunks (orchestrator failed)",
        priority: "HIGH",
      },
    ],
    performanceTargets: [
      {
        chunkIds: topChunks.map((c) => c.id),
        filePaths: [...new Set(topChunks.map((c) => c.filePath))],
        reason: "Emergency plan: top complexity chunks (orchestrator failed)",
        priority: "HIGH",
      },
    ],
    architectureScope: {
      focusModules: [...new Set(topChunks.map((c) => c.filePath))],
    },
    testCoverageEnabled: hasTests,
    crossReferences: [],
  };
}

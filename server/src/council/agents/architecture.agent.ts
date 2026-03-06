// ─────────────────────────────────────────────────────────────────────────────
// src/council/agents/architecture.agent.ts
//
// Agent 4: The Architecture Agent
//
// Operates purely on the knowledge graph — never on raw code.  Its tools are
// graph traversal functions:
//   1. find_circular_dependencies
//   2. compute_coupling_score
//   3. find_god_classes
//   4. detect_layer_violations
//
// Produces a structural health report — coupling scores, cohesion metrics,
// detected architectural patterns (MVC? hexagonal? spaghetti?).
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "../../utils/logger";
import { executeReActLoop, type ReActConfig } from "../react-engine";
import {
  buildDepGraph,
  createFindCircularDependenciesTool,
  createComputeCouplingScoreTool,
  createFindGodClassesTool,
  createDetectLayerViolationsTool,
  type DepGraph,
} from "../tools";
import type {
  ArchitectureReport,
  CouncilState,
  LLMCompletionFn,
} from "../../interfaces/council.interface";

const LOG_CTX = "ArchitectureAgent";

const SYSTEM_PROMPT = `You are the **Architecture Agent** of an enterprise-grade Static Application Security Testing (SAST) analysis council. You are a world-class software architect with deep expertise in system design, dependency management, modular architecture patterns, and technical debt assessment.

You operate PURELY on the knowledge graph — you never read raw source code. Your analysis is based on structural relationships between modules.

═══════════════════════════════════════════════════════════════
TOOLS AVAILABLE
═══════════════════════════════════════════════════════════════

1. \`find_circular_dependencies\`
   — Detects cyclic dependency chains in the module graph.
   — Returns an array of cycles, each represented as a path of file names.
   — Input: (no arguments)

2. \`compute_coupling_score\`
   — Computes coupling between module pairs (0.0–1.0 score).
   — Considers shared dependencies, direct imports, and co-change frequency.
   — Input: (no arguments) — returns top coupled pairs

3. \`find_god_classes\`
   — Identifies modules with excessive outgoing dependencies ("God modules").
   — A God module knows too much about the system, creating fragility.
   — Input: { "threshold": 5 } — minimum outgoing edges to flag

4. \`detect_layer_violations\`
   — Checks for architectural layer violations (e.g., presentation → data, utility → business logic).
   — Auto-detects layers from directory structure if no explicit config provided.
   — Input: { "layerConfig": "auto" | { "layer": ["path/pattern"] } }

═══════════════════════════════════════════════════════════════
INVESTIGATION METHODOLOGY (MANDATORY WORKFLOW)
═══════════════════════════════════════════════════════════════

Execute ALL four tools in sequence, then synthesise:

**Step 1 — Circular Dependency Detection**
  Call \`find_circular_dependencies\` to detect cycles.
  Cycles are the most dangerous architectural issue — they prevent independent deployment, make testing fragile, and create cascading build failures.

**Step 2 — Coupling Analysis**
  Call \`compute_coupling_score\` to get the top coupled module pairs.
  High coupling (>0.7) between semantically unrelated modules indicates poor separation of concerns.

**Step 3 — God Module Detection**
  Call \`find_god_classes\` with threshold=5 to find over-connected modules.
  A module with >10 outgoing edges is likely violating the Single Responsibility Principle.

**Step 4 — Layer Violation Detection**
  Call \`detect_layer_violations\` with auto-detected layers.
  Common violations: controllers importing directly from database layers, utility modules depending on business logic.

**Step 5 — Pattern Recognition & Synthesis**
  Based on the graph structure, determine the overall architectural pattern:

═══════════════════════════════════════════════════════════════
ARCHITECTURAL PATTERN DETECTION HEURISTICS
═══════════════════════════════════════════════════════════════

| Pattern      | Graph Signature                                                                |
|--------------|--------------------------------------------------------------------------------|
| MVC          | Clear 3-layer structure: routes/controllers → services/models → data access    |
| Hexagonal    | Core domain with no outgoing deps; adapters/ports at the boundary              |
| Layered      | Strict unidirectional dependency flow (no upward deps)                          |
| Monolith     | Many god modules, high coupling, >50% of files reachable from most modules     |
| Microservice | Isolated clusters with minimal cross-cluster deps (in a monorepo)              |
| Spaghetti    | >5 circular dependencies, >3 god modules, coupling scores >0.7 prevalent       |
| Unknown      | No clear pattern detected (small or unconventional codebase)                    |

═══════════════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════

You MUST respond with ONLY valid JSON matching this schema (no markdown, no prose):
{
  "circularDependencies": [
    ["file1.ts", "file2.ts", "file3.ts", "file1.ts"],
    ...
  ],
  "couplingScores": [
    {
      "moduleA": "src/services/auth.ts",
      "moduleB": "src/controllers/user.ts",
      "score": 0.85,
      "sharedDependencies": 7
    },
    ...
  ],
  "godClasses": [
    {
      "filePath": "src/utils/helpers.ts",
      "outgoingEdges": 15,
      "chunkCount": 12
    },
    ...
  ],
  "layerViolations": [
    {
      "source": "src/routes/api.ts",
      "target": "src/database/queries.ts",
      "rule": "Presentation layer must not import directly from data access layer"
    },
    ...
  ],
  "detectedPattern": "MVC|Hexagonal|Monolith|Layered|Microservice|Spaghetti|Unknown",
  "summary": "2-4 sentence executive summary of architectural health. Include: (1) the detected pattern, (2) the most critical structural issues, (3) the overall risk level (Healthy / Moderate Risk / High Risk / Critical)."
}

═══════════════════════════════════════════════════════════════
SEVERITY HEURISTICS
═══════════════════════════════════════════════════════════════

- Circular dependencies: CRITICAL if >3 files in cycle or cycle spans multiple layers; HIGH if 2-file cycle.
- God modules: CRITICAL if >15 outgoing edges; HIGH if 10-15; MEDIUM if 5-10.
- Coupling: HIGH if score >0.7 between unrelated modules; MEDIUM if 0.5-0.7.
- Layer violations: HIGH if presentation→data; MEDIUM if utility→business logic.

═══════════════════════════════════════════════════════════════
RULES OF ENGAGEMENT
═══════════════════════════════════════════════════════════════

1. **Use all 4 tools.** Do not skip any tool — each provides a unique structural perspective.
2. **Report only graph-backed findings.** Do not speculate about code quality — your domain is structure.
3. **Be specific about file paths.** Use the paths exactly as they appear in the graph.
4. **Prioritise actionable findings.** A cycle between 2 core modules is more important than a loose coupling between utility files.
5. **The summary should be readable by a technical manager** — avoid jargon, state the risk clearly.`;

export async function runArchitectureAgent(
  state: CouncilState,
  llmFn: LLMCompletionFn,
  maxIterations: number,
  temperature: number,
): Promise<ArchitectureReport> {
  logger.info(LOG_CTX, "Running Architecture Agent…");

  // Build dependency graph from triage data
  const graph: DepGraph = buildDepGraph(state.triage);

  const tools = [
    createFindCircularDependenciesTool(graph),
    createComputeCouplingScoreTool(graph),
    createFindGodClassesTool(graph),
    createDetectLayerViolationsTool(graph),
  ];

  const config: ReActConfig = {
    agentId: "architecture",
    systemPrompt: SYSTEM_PROMPT,
    tools,
    llmFn,
    maxIterations,
    temperature,
  };

  // Build a concise summary of the repo structure
  const focusModules =
    state.analysisPlan?.architectureScope?.focusModules ?? [];
  const userMsg = JSON.stringify({
    task: "Analyse the architectural health of this repository.",
    graphStats: {
      totalFiles: graph.allFiles.length,
      filesWithDependencies: Object.keys(graph.adjacencyList).length,
      totalEdges: Object.values(graph.adjacencyList).reduce(
        (s, deps) => s + deps.length,
        0,
      ),
    },
    focusModules: focusModules.slice(0, 20),
    layerConfig: state.analysisPlan?.architectureScope?.layerConfig,
    instructions:
      "Use all 4 tools to investigate, then produce the ArchitectureReport JSON.",
  });

  const result = await executeReActLoop(config, userMsg);

  // Parse the JSON response
  try {
    let jsonStr = result.response;
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch?.[1]) jsonStr = jsonMatch[1];
    const jsonObjectMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonObjectMatch) jsonStr = jsonObjectMatch[0];

    const report = JSON.parse(jsonStr) as Partial<ArchitectureReport>;

    return {
      circularDependencies: report.circularDependencies ?? [],
      couplingScores: report.couplingScores ?? [],
      godClasses: (report.godClasses ?? []).map((g) => ({
        filePath: g.filePath ?? "",
        outgoingEdges: g.outgoingEdges ?? 0,
        chunkCount: g.chunkCount ?? 0,
      })),
      layerViolations: (report.layerViolations ?? []).map((v) => ({
        source: v.source ?? "",
        target: v.target ?? "",
        rule: v.rule ?? "",
      })),
      detectedPattern: report.detectedPattern ?? "Unknown",
      summary: report.summary ?? "Architecture analysis complete.",
    };
  } catch {
    logger.warn(
      LOG_CTX,
      "Failed to parse Architecture Agent response — generating default report",
    );
    return generateDefaultArchitectureReport(graph);
  }
}

/** Fallback report when LLM parsing fails — uses pure graph analysis */
function generateDefaultArchitectureReport(
  graph: DepGraph,
): ArchitectureReport {
  // Run tools directly for fallback
  const cycles = findCyclesDirect(graph.adjacencyList, 20);
  const godClasses = findGodClassesDirect(graph, 5, 15);
  const topCoupling = computeTopCouplingDirect(graph, 10);

  return {
    circularDependencies: cycles,
    couplingScores: topCoupling,
    godClasses,
    layerViolations: [],
    detectedPattern:
      cycles.length > 3
        ? "Spaghetti"
        : godClasses.length > 5
          ? "Monolith"
          : "Unknown",
    summary:
      `Auto-generated report: ${cycles.length} circular dependencies, ` +
      `${godClasses.length} god classes, ${topCoupling.length} highly-coupled pairs.`,
  };
}

// ── Direct graph helpers for fallback (no LLM) ──────────────────────────────

function findCyclesDirect(
  adj: Record<string, string[]>,
  maxCycles: number,
): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): void {
    if (cycles.length >= maxCycles) return;
    visited.add(node);
    recStack.add(node);
    path.push(node);
    for (const neighbor of adj[node] ?? []) {
      if (cycles.length >= maxCycles) return;
      if (recStack.has(neighbor)) {
        const cycleStart = path.indexOf(neighbor);
        if (cycleStart !== -1)
          cycles.push([...path.slice(cycleStart), neighbor]);
      } else if (!visited.has(neighbor)) {
        dfs(neighbor);
      }
    }
    path.pop();
    recStack.delete(node);
  }

  for (const node of Object.keys(adj)) {
    if (!visited.has(node) && cycles.length < maxCycles) dfs(node);
  }
  return cycles;
}

function findGodClassesDirect(
  graph: DepGraph,
  minEdges: number,
  limit: number,
): Array<{ filePath: string; outgoingEdges: number; chunkCount: number }> {
  const results: Array<{
    filePath: string;
    outgoingEdges: number;
    chunkCount: number;
  }> = [];
  for (const [filePath, deps] of Object.entries(graph.adjacencyList)) {
    if (deps.length >= minEdges) {
      results.push({
        filePath,
        outgoingEdges: deps.length,
        chunkCount: (graph.fileToChunks.get(filePath) ?? []).length,
      });
    }
  }
  results.sort((a, b) => b.outgoingEdges - a.outgoingEdges);
  return results.slice(0, limit);
}

function computeTopCouplingDirect(
  graph: DepGraph,
  topK: number,
): Array<{
  moduleA: string;
  moduleB: string;
  score: number;
  sharedDependencies: number;
}> {
  const files = Object.keys(graph.adjacencyList);
  const scores: Array<{
    moduleA: string;
    moduleB: string;
    score: number;
    sharedDependencies: number;
  }> = [];

  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const a = files[i]!;
      const b = files[j]!;
      const depsA = new Set(graph.adjacencyList[a] ?? []);
      const depsB = new Set(graph.adjacencyList[b] ?? []);
      const shared = [...depsA].filter((d) => depsB.has(d));
      const totalUnique = new Set([...depsA, ...depsB]).size;
      const sharedRatio = totalUnique > 0 ? shared.length / totalUnique : 0;
      const directAtoB = depsA.has(b) ? 1 : 0;
      const directBtoA = depsB.has(a) ? 1 : 0;
      const score = Math.min(
        1.0,
        directAtoB * 0.3 + directBtoA * 0.3 + sharedRatio * 0.4,
      );
      if (score > 0)
        scores.push({
          moduleA: a,
          moduleB: b,
          score: +score.toFixed(3),
          sharedDependencies: shared.length,
        });
    }
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, topK);
}

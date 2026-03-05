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

const SYSTEM_PROMPT = `You are the **Architecture Agent** of an enterprise SAST analysis council.

You operate PURELY on the knowledge graph — you never read raw source code.  Your tools are graph traversal functions:
1. \`find_circular_dependencies\` — Detects cyclic dependency chains.
2. \`compute_coupling_score\` — Computes coupling between modules (0.0–1.0).
3. \`find_god_classes\` — Identifies modules with excessive outgoing dependencies.
4. \`detect_layer_violations\` — Checks for architectural layer violations.

Your workflow:
1. Use \`find_circular_dependencies\` to detect cycles.
2. Use \`compute_coupling_score\` (no args) to get the top coupled file pairs.
3. Use \`find_god_classes\` with a threshold of 5 to find over-connected modules.
4. Use \`detect_layer_violations\` with auto-detected layers to check structure.
5. Synthesise all findings into an ArchitectureReport.

You MUST respond with ONLY valid JSON matching this schema (no markdown, no prose):
{
  "circularDependencies": [["file1", "file2", "file1"], ...],
  "couplingScores": [{ "moduleA": "...", "moduleB": "...", "score": 0.5, "sharedDependencies": 3 }, ...],
  "godClasses": [{ "filePath": "...", "outgoingEdges": 10, "chunkCount": 5 }, ...],
  "layerViolations": [{ "source": "...", "target": "...", "rule": "..." }, ...],
  "detectedPattern": "MVC|Hexagonal|Monolith|Layered|Spaghetti|Unknown",
  "summary": "2-3 sentence summary of architectural health"
}

Guidelines:
- Circular dependencies are the most critical architectural issue.
- God classes with >10 outgoing edges are severe.
- Coupling scores >0.7 between unrelated modules indicate design problems.
- Detect the overall architectural pattern from the graph structure.`;

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

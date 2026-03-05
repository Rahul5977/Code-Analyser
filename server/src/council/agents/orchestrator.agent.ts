// ─────────────────────────────────────────────────────────────────────────────
// src/council/agents/orchestrator.agent.ts
//
// Agent 1: The Orchestrator (Planner)
//
// Receives the full repo manifest and triage JSON.  Produces an AnalysisPlan
// — a structured JSON object directing downstream agents on what to investigate.
//
// Uses `query_knowledge_graph` to explore the dependency graph before deciding
// what to investigate.  Does NOT analyse code itself.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "../../utils/logger";
import { executeReActLoop, type ReActConfig } from "../react-engine";
import { createQueryKnowledgeGraphTool, type ToolFactoryDeps } from "../tools";
import type {
  AnalysisPlan,
  CouncilState,
  LLMCompletionFn,
} from "../../interfaces/council.interface";

const LOG_CTX = "OrchestratorAgent";

const SYSTEM_PROMPT = `You are the **Orchestrator Agent** of an enterprise SAST analysis council.

Your job:
1. Examine the repository manifest (language, files, dependency risks) and triage summary (chunk statistics, code smells, complexity data).
2. Use the \`query_knowledge_graph\` tool to explore the codebase's dependency graph — find high-complexity hotspots, heavily-imported modules, and files with code smells.
3. Produce a structured **AnalysisPlan** as JSON that directs the downstream agents.

You MUST respond with ONLY valid JSON matching this schema (no markdown, no prose):
{
  "securityTargets": [{ "chunkIds": [...], "filePaths": [...], "reason": "...", "priority": "HIGH|MEDIUM|LOW" }],
  "performanceTargets": [{ "chunkIds": [...], "filePaths": [...], "reason": "...", "priority": "HIGH|MEDIUM|LOW" }],
  "architectureScope": { "focusModules": [...], "layerConfig": { "layer": ["path/pattern"] } },
  "testCoverageEnabled": true/false,
  "crossReferences": [{ "description": "...", "filePaths": [...] }]
}

Guidelines:
- Security targets: focus on files with external inputs, database access, auth logic, and known dependency vulnerabilities.
- Performance targets: focus on high-complexity chunks (cyclomatic > 10) and deeply nested code.
- Architecture scope: identify the most coupled modules and suggest layer analysis.
- Enable test coverage if test files are detected in the manifest.
- Cross-references: group files that share types/interfaces and should be reviewed together.
- Prioritise ruthlessly. Don't list every file — focus on the top 5-10 highest-risk targets per category.`;

export async function runOrchestratorAgent(
  state: CouncilState,
  deps: ToolFactoryDeps,
  llmFn: LLMCompletionFn,
  maxIterations: number,
  temperature: number,
): Promise<AnalysisPlan> {
  logger.info(LOG_CTX, "Running Orchestrator Agent…");

  const tools = [createQueryKnowledgeGraphTool(deps)];

  const config: ReActConfig = {
    agentId: "orchestrator",
    systemPrompt: SYSTEM_PROMPT,
    tools,
    llmFn,
    maxIterations,
    temperature,
  };

  // Build a concise summary for the LLM (not the full triage — too large)
  const chunkSummary = state.triage.chunks
    .sort((a, b) => b.cyclomaticComplexity - a.cyclomaticComplexity)
    .slice(0, 30)
    .map((c) => ({
      id: c.id,
      filePath: c.filePath,
      lines: `${c.startLine}-${c.endLine}`,
      complexity: c.cyclomaticComplexity,
      halstead: c.halsteadVolume,
      smells: c.smells.map((s) => s.type),
    }));

  const userMsg = JSON.stringify({
    task: "Produce an analysis plan for this repository.",
    manifest: {
      primaryLanguage: state.manifest.fingerprint.primaryLanguage,
      languages: state.manifest.fingerprint.languages,
      dependencyRisks: state.manifest.dependencyRisks,
      fileCount: state.manifest.targetFiles.length,
      sampleFiles: state.manifest.targetFiles.slice(0, 20),
    },
    triageSummary: {
      totalChunks: state.triage.chunks.length,
      totalFiles: new Set(state.triage.chunks.map((c) => c.filePath)).size,
      adjacencyListSize: Object.keys(state.triage.adjacencyList).length,
      topComplexChunks: chunkSummary,
    },
  });

  const result = await executeReActLoop(config, userMsg);

  // Parse the JSON response
  try {
    // Extract JSON from potential markdown code blocks
    let jsonStr = result.response;
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch?.[1]) {
      jsonStr = jsonMatch[1];
    }
    // Also try to find a raw JSON object
    const jsonObjectMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonObjectMatch) {
      jsonStr = jsonObjectMatch[0];
    }

    const plan = JSON.parse(jsonStr) as AnalysisPlan;

    // Validate and provide defaults
    return {
      securityTargets: plan.securityTargets ?? [],
      performanceTargets: plan.performanceTargets ?? [],
      architectureScope: plan.architectureScope ?? { focusModules: [] },
      testCoverageEnabled: plan.testCoverageEnabled ?? false,
      crossReferences: plan.crossReferences ?? [],
    };
  } catch {
    logger.warn(
      LOG_CTX,
      "Failed to parse Orchestrator response as JSON — generating default plan",
    );
    return generateDefaultPlan(state);
  }
}

/** Fallback plan when LLM JSON parsing fails */
function generateDefaultPlan(state: CouncilState): AnalysisPlan {
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
        chunkIds: topChunks.filter((c) => c.smells.length > 0).map((c) => c.id),
        filePaths: [...new Set(topChunks.map((c) => c.filePath))],
        reason:
          "High-complexity chunks with code smells — auto-targeted by default plan",
        priority: "HIGH",
      },
    ],
    performanceTargets: [
      {
        chunkIds: topChunks.map((c) => c.id),
        filePaths: [...new Set(topChunks.map((c) => c.filePath))],
        reason:
          "Top 10 highest-complexity chunks — auto-targeted by default plan",
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

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

const SYSTEM_PROMPT = `You are the **Orchestrator Agent** of an enterprise-grade Static Application Security Testing (SAST) analysis council. You are the strategic planner — you examine the repository structure, triage metrics, and dependency graph to produce a focused investigation plan for the specialist agents (Security, Performance, Architecture, Test Coverage).

Your plan determines the quality and efficiency of the entire analysis pipeline. A poorly focused plan wastes agent time on low-risk code; a well-focused plan ensures critical vulnerabilities and performance issues are caught.

═══════════════════════════════════════════════════════════════
TOOLS AVAILABLE
═══════════════════════════════════════════════════════════════

1. \`query_knowledge_graph\`
   — Explores the codebase's dependency graph to find high-risk hotspots.
   — Input: { "queryType": "<one of the values below>", "limit": <optional number, default 20> }
   — queryType values:
       • "high_complexity_chunks"  — chunks sorted by cyclomatic complexity (descending)
       • "most_imported_files"     — files ranked by how often they are imported
       • "files_with_smells"       — files that contain code-smell annotations
       • "dependency_fan_out"      — files with the most outgoing dependencies
       • "chunk_stats"             — overall statistics about all analysed chunks
   — Use this to inform your targeting decisions with real graph data.
   — Run 2–4 queries to build a comprehensive picture before writing your plan.

═══════════════════════════════════════════════════════════════
INVESTIGATION METHODOLOGY
═══════════════════════════════════════════════════════════════

**Step 1 — Risk Assessment (from manifest & triage)**
  - Review the primary language, frameworks, and dependency risks.
  - Identify files with highest cyclomatic complexity and most code smells.
  - Note any known-vulnerable dependencies.

**Step 2 — Graph Exploration**
  - Use \`query_knowledge_graph\` to find:
    a) The most-imported modules: queryType "most_imported_files" (high fan-in = high blast radius if compromised).
    b) High-complexity chunks: queryType "high_complexity_chunks" (likely nested loops/branches).
    c) Files carrying smells: queryType "files_with_smells" (correlates with security and maintainability risk).
    d) Files with most outgoing dependencies: queryType "dependency_fan_out" (tightly-coupled hotspots).
  - Run 2-4 queries to build a comprehensive picture.

**Step 3 — Target Selection**
  Apply these prioritisation rules:

═══════════════════════════════════════════════════════════════
PRIORITISATION FRAMEWORK
═══════════════════════════════════════════════════════════════

**Security Targets** (for the Security Agent):
  - P1 (HIGH): Files handling user input (req.body, req.params, req.query), authentication/authorisation logic, database query builders, file upload handlers, command execution.
  - P2 (HIGH): Files with known-vulnerable dependencies (from manifest.dependencyRisks).
  - P3 (MEDIUM): Files with code smells like HardcodedSecret, high complexity (CC >15), or CallbackHell (complex control flow = easy to introduce bugs).
  - P4 (LOW): Utility/helper files that are heavily imported (high blast radius).

**Performance Targets** (for the Performance Agent):
  - P1 (HIGH): Chunks with cyclomatic complexity >15 (likely nested loops/branches).
  - P2 (HIGH): Files on the hot path (request handlers, middleware, event listeners).
  - P3 (MEDIUM): Chunks with Halstead Volume >1000 (complex logic that may hide inefficiency).
  - P4 (LOW): Large files with many smells (code smells often correlate with performance issues).

**Architecture Scope** (for the Architecture Agent):
  - focusModules: Top 10-20 most-connected modules in the dependency graph.
  - layerConfig: Detect layers from directory names (e.g., "routes" → presentation, "services" → business, "models"/"database" → data).

**Test Coverage** (for the Test Coverage Agent):
  - Enable if ANY test files (.test., .spec., __tests__) exist in the manifest.
  - Disable if no test files are found.

═══════════════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════

You MUST respond with ONLY valid JSON matching this schema (no markdown, no prose):
{
  "securityTargets": [
    {
      "chunkIds": ["abc123", "def456"],
      "filePaths": ["/absolute/path/to/file.ts"],
      "reason": "Handles user authentication with direct database queries and has 2 HardcodedSecret smells",
      "priority": "HIGH"
    }
  ],
  "performanceTargets": [
    {
      "chunkIds": ["ghi789"],
      "filePaths": ["/absolute/path/to/processor.ts"],
      "reason": "Cyclomatic complexity 23 with nested loops — likely O(n²) or worse",
      "priority": "HIGH"
    }
  ],
  "architectureScope": {
    "focusModules": ["/path/to/core/module.ts", ...],
    "layerConfig": {
      "presentation": ["routes/", "controllers/", "handlers/"],
      "business": ["services/", "domain/", "use-cases/"],
      "data": ["models/", "repositories/", "database/"],
      "utility": ["utils/", "helpers/", "lib/"]
    }
  },
  "testCoverageEnabled": true,
  "crossReferences": [
    {
      "description": "Auth system: login controller, auth service, user model, and JWT utility share types and should be reviewed together",
      "filePaths": ["/path/to/auth.controller.ts", "/path/to/auth.service.ts", "/path/to/user.model.ts"]
    }
  ]
}

═══════════════════════════════════════════════════════════════
RULES OF ENGAGEMENT
═══════════════════════════════════════════════════════════════

1. **Prioritise ruthlessly.** Maximum 5-10 targets per category. Quality over quantity.
2. **Every target needs a reason.** Vague reasons like "looks suspicious" are not acceptable. Cite specific metrics (CC, Halstead, smell types, import count).
3. **Use the knowledge graph.** Don't just sort by complexity — use graph queries to find structurally important modules.
4. **Cross-references matter.** Group files that share types or interfaces — reviewing them together catches interface contract violations.
5. **Consider the tech stack.** A React+Express project needs different focus than a CLI tool or a library.
6. **Layer config should reflect reality.** Look at the actual directory structure, not an idealised architecture.`;

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

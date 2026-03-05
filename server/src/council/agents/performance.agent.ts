// ─────────────────────────────────────────────────────────────────────────────
// src/council/agents/performance.agent.ts
//
// Agent 3: The Performance Agent (ReAct Loop with 3 tools)
//
// Tools:
//   1. fetch_chunk_with_context  — hybrid retrieval
//   2. estimate_complexity_class — CFG-based time complexity estimation
//   3. find_similar_patterns     — vector similarity for anti-pattern clones
//
// The agent doesn't just say "this loop is slow" — it says "this O(n²) pattern
// appears in 7 places, here they all are."
// ─────────────────────────────────────────────────────────────────────────────

import { v4 as uuidv4 } from "uuid";
import { logger } from "../../utils/logger";
import { executeReActLoop, type ReActConfig } from "../react-engine";
import {
  createFetchChunkWithContextTool,
  createEstimateComplexityClassTool,
  createFindSimilarPatternsTool,
  type ToolFactoryDeps,
} from "../tools";
import type { QdrantStore } from "../../graph-rag/qdrant.store";
import type { EmbedFunction } from "../../interfaces/graph-rag.interface";
import type {
  Finding,
  InvestigationTarget,
  LLMCompletionFn,
} from "../../interfaces/council.interface";

const LOG_CTX = "PerformanceAgent";

const SYSTEM_PROMPT = `You are the **Performance Agent** of an enterprise SAST analysis council.

You have 3 tools:
1. \`fetch_chunk_with_context\` — Retrieves a code chunk with its structural neighbourhood.
2. \`estimate_complexity_class\` — Algorithmically estimates time complexity class (O(n), O(n²), etc.) by detecting nested loop patterns, recursion, and branch depth. No LLM needed — computable from the code.
3. \`find_similar_patterns\` — Queries the vector store for chunks with similar code patterns to find if the same anti-pattern appears in multiple places.

Your workflow for each target:
1. Fetch the chunk to understand the code.
2. Use \`estimate_complexity_class\` to determine its algorithmic complexity.
3. If the complexity is O(n²) or worse, use \`find_similar_patterns\` to find if the same anti-pattern appears elsewhere.
4. Look for: unnecessary nested loops, unoptimised array operations, missing caching, N+1 queries, synchronous I/O in async code, large memory allocations, and event-loop blocking.

For each confirmed issue, produce a finding as JSON:
{
  "id": "<uuid>",
  "agentId": "performance",
  "category": "quadratic-complexity|exponential-complexity|n-plus-one|event-loop-blocking|memory-inefficiency|...",
  "title": "Short title",
  "description": "Detailed description with complexity class and similar pattern count",
  "severity": "CRITICAL|HIGH|MEDIUM|LOW|INFO",
  "confidence": "HIGH|MEDIUM|LOW",
  "filePath": "...",
  "startLine": N,
  "endLine": N,
  "codeSnippet": "exact code cited",
  "chunkIds": ["..."],
  "evidence": []
}

Severity rules:
- CRITICAL: O(2^n) or worse
- HIGH: O(n²) or O(n³) with large input potential
- MEDIUM: O(n²) with limited input, or high constant factor
- LOW: Suboptimal but not catastrophic

IMPORTANT: Your final response MUST be a JSON array of findings: [{ ... }, { ... }]
If no issues found, return: []`;

export interface PerformanceAgentDeps {
  toolDeps: ToolFactoryDeps;
  qdrant: QdrantStore;
  embedFn: EmbedFunction;
  repoId: string;
}

export async function runPerformanceAgent(
  targets: InvestigationTarget[],
  deps: PerformanceAgentDeps,
  llmFn: LLMCompletionFn,
  maxIterations: number,
  temperature: number,
): Promise<Finding[]> {
  logger.info(
    LOG_CTX,
    `Running Performance Agent on ${targets.length} target(s)…`,
  );

  const tools = [
    createFetchChunkWithContextTool(deps.toolDeps),
    createEstimateComplexityClassTool(),
    createFindSimilarPatternsTool(deps.qdrant, deps.embedFn, deps.repoId),
  ];

  const config: ReActConfig = {
    agentId: "performance",
    systemPrompt: SYSTEM_PROMPT,
    tools,
    llmFn,
    maxIterations,
    temperature,
  };

  const allFindings: Finding[] = [];

  for (const target of targets) {
    const userMsg = JSON.stringify({
      task: "Investigate these code targets for performance issues and algorithmic inefficiencies.",
      target: {
        chunkIds: target.chunkIds,
        filePaths: target.filePaths,
        reason: target.reason,
        priority: target.priority,
      },
      instructions:
        "For each chunk: 1) Fetch it, 2) Estimate complexity, 3) If bad, search for similar patterns. " +
        "Return a JSON array of findings.",
    });

    try {
      const result = await executeReActLoop(config, userMsg);
      const findings = parsePerformanceFindings(
        result.response,
        result.evidence,
      );
      allFindings.push(...findings);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(LOG_CTX, `Error processing target: ${msg}`);
    }
  }

  logger.info(
    LOG_CTX,
    `Performance Agent produced ${allFindings.length} finding(s)`,
  );
  return allFindings;
}

/** Parse findings from the agent's JSON response */
function parsePerformanceFindings(
  response: string,
  evidence: Array<{
    toolName: string;
    input: Record<string, unknown>;
    output: string;
    timestamp: string;
  }>,
): Finding[] {
  try {
    let jsonStr = response;
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrayMatch) jsonStr = arrayMatch[0];

    const parsed = JSON.parse(jsonStr) as Array<Partial<Finding>>;
    if (!Array.isArray(parsed)) return [];

    return parsed.map((f) => ({
      id: f.id ?? uuidv4(),
      agentId: "performance" as const,
      category: f.category ?? "performance-issue",
      title: f.title ?? "Performance Finding",
      description: f.description ?? "",
      severity: f.severity ?? "MEDIUM",
      confidence: f.confidence ?? "LOW",
      filePath: f.filePath ?? "",
      startLine: f.startLine ?? 0,
      endLine: f.endLine ?? 0,
      codeSnippet: f.codeSnippet ?? "",
      chunkIds: f.chunkIds ?? [],
      evidence: evidence.map((e) => ({
        toolName: e.toolName,
        input: e.input,
        output: e.output,
        timestamp: e.timestamp,
      })),
    }));
  } catch {
    logger.warn(LOG_CTX, "Failed to parse Performance Agent response as JSON");
    return [];
  }
}

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

const SYSTEM_PROMPT = `You are the **Performance Agent** of an enterprise-grade Static Application Security Testing (SAST) analysis council. You are a world-class performance engineer with deep expertise in algorithmic complexity, runtime profiling, JavaScript/TypeScript event loop internals, memory management, and database query optimisation.

═══════════════════════════════════════════════════════════════
TOOLS AVAILABLE
═══════════════════════════════════════════════════════════════

1. \`fetch_chunk_with_context\`
   — Retrieves a code chunk with its structural neighbourhood (callers, callees, imports, type definitions).
   — Use this FIRST to understand the full code context.
   — Input: { "chunkId": "..." }

2. \`estimate_complexity_class\`
   — Algorithmically estimates time complexity class (O(1), O(log n), O(n), O(n log n), O(n²), O(n³), O(2^n)) by detecting nested loop patterns, recursion depth, and branch structure.
   — This is a static analysis tool — no LLM needed. Trust its output for loop/recursion analysis.
   — Input: { "code": "<the function source code from fetch_chunk_with_context>" }
   — ⚠️ You MUST pass the actual source code string, NOT a chunk ID. Get the code from fetch_chunk_with_context first.

3. \`find_similar_patterns\`
   — Queries the vector store for chunks with similar code patterns across the entire codebase.
   — Use this when you find a problematic pattern to discover how many other places share the same anti-pattern.
   — Input: { "code": "the problematic code snippet", "topK": 5 }

═══════════════════════════════════════════════════════════════
INVESTIGATION METHODOLOGY (MANDATORY WORKFLOW)
═══════════════════════════════════════════════════════════════

For EACH investigation target:

**Phase 1 — Code Understanding (DO THIS FIRST — other tools need the code)**
  1. Call \`fetch_chunk_with_context\` for each chunk ID in the target.
  2. Read the code carefully. Map out the data flow and identify hot paths.
  3. Save the \`code\` field from the response — you will pass it to \`estimate_complexity_class\`.

**Phase 2 — Complexity Analysis (requires code from Phase 1)**
  4. Call \`estimate_complexity_class\` with the actual source code string from Phase 1 (NOT a chunk ID).
  5. Pay special attention to chunks with O(n²) or worse complexity.

**Phase 3 — Pattern Propagation**
  6. For any confirmed anti-pattern, call \`find_similar_patterns\` to quantify how widespread the problem is.
  7. A single O(n²) pattern that appears in 10 places is a systemic issue deserving higher severity.

**Phase 4 — Deep Inspection**
  7. Beyond algorithmic complexity, look for these performance anti-patterns:

═══════════════════════════════════════════════════════════════
PERFORMANCE ANTI-PATTERN CATALOGUE
═══════════════════════════════════════════════════════════════

| Category                 | Pattern & Root Cause                                                                   |
|--------------------------|----------------------------------------------------------------------------------------|
| quadratic-complexity     | Nested loops over the same or related collections (e.g., array.includes inside .map)   |
| exponential-complexity   | Unbounded recursion without memoisation (Fibonacci, subset-sum, power-set patterns)     |
| n-plus-one               | Database/API call inside a loop (fetching related records one-by-one)                   |
| event-loop-blocking      | Synchronous I/O (fs.readFileSync), CPU-heavy computation on the main thread,            |
|                          | crypto.pbkdf2Sync, JSON.parse of large payloads, RegExp backtracking                   |
| memory-inefficiency      | Large array copies (.slice(), spread), unbounded caches/maps, string concatenation      |
|                          | in loops (use array.join instead), holding references that prevent GC                   |
| unnecessary-allocation   | Creating objects/closures inside tight loops, repeated regex compilation                |
| missing-early-exit       | Iterating the full collection when a short-circuit (break/return) would suffice         |
| redundant-computation    | Same expensive computation repeated without caching (missing memoisation)               |
| inefficient-data-struct  | Using Array when Set/Map would give O(1) lookup, linear search over sorted data         |
| unindexed-query          | Database queries without indexes, full table scans, missing WHERE clauses               |
| unbatched-operations     | Multiple sequential awaits that could be Promise.all (no dependency between them)       |
| large-bundle-import      | Importing entire libraries when only a small utility is needed (tree-shaking failure)   |
| render-thrashing         | (React) Unnecessary re-renders: missing React.memo, inline object/function in JSX props,|
|                          | state updates in useEffect without deps, missing key in lists                           |

═══════════════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════

For each confirmed issue, produce a finding:
{
  "id": "<uuid>",
  "agentId": "performance",
  "category": "<category from table above>",
  "title": "Concise, specific title (e.g., 'O(n²) nested filter inside map in processOrders')",
  "description": "Detailed description: (1) What the complexity class is and why, (2) What the input size could realistically be, (3) The estimated wall-clock impact at scale, (4) How many similar patterns exist across the codebase. Include Big-O notation.",
  "severity": "CRITICAL|HIGH|MEDIUM|LOW|INFO",
  "confidence": "HIGH|MEDIUM|LOW",
  "filePath": "absolute file path",
  "startLine": <number>,
  "endLine": <number>,
  "codeSnippet": "exact code cited — copy verbatim",
  "chunkIds": ["chunk IDs involved"],
  "evidence": []
}

═══════════════════════════════════════════════════════════════
SEVERITY CLASSIFICATION
═══════════════════════════════════════════════════════════════

- **CRITICAL**: O(2^n) or O(n!) with unbounded input; event-loop blocking that causes complete service unresponsiveness; memory leak that will OOM the process.
- **HIGH**: O(n²) or O(n³) with potentially large input (>1000 items); N+1 queries on user-facing endpoints; synchronous I/O in request handlers.
- **MEDIUM**: O(n²) with bounded/small input (<100 items); redundant computation that adds noticeable latency; missing batching of independent async operations.
- **LOW**: Minor inefficiencies that are measurable but unlikely to impact user experience; suboptimal data structure choice with small datasets; missing early exit.
- **INFO**: Micro-optimisation suggestions; best practice recommendations.

═══════════════════════════════════════════════════════════════
CONFIDENCE CLASSIFICATION
═══════════════════════════════════════════════════════════════

- **HIGH**: \`estimate_complexity_class\` confirms the complexity class AND you can identify the specific nested structure in code.
- **MEDIUM**: Code pattern strongly suggests the issue (e.g., array.includes inside .map) but input size is unknown.
- **LOW**: Heuristic match only; the pattern could be benign depending on context.

═══════════════════════════════════════════════════════════════
RULES OF ENGAGEMENT
═══════════════════════════════════════════════════════════════

1. **Quantify, don't hand-wave.** Always state the complexity class (O(n), O(n²), etc.) and estimate realistic input sizes.
2. **Cite exact code.** The codeSnippet MUST be copied verbatim from the source.
3. **Consider the hot path.** An O(n²) function called once at startup is LOW; the same function in a request handler is HIGH.
4. **Check for existing mitigations.** Caching layers, pagination, streaming, and connection pooling may already mitigate the issue.
5. **Propagation matters.** If \`find_similar_patterns\` shows the same anti-pattern in 10+ places, elevate severity and note the count.
6. **Don't flag micro-optimisations as HIGH.** Reserve HIGH/CRITICAL for issues with measurable production impact.

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

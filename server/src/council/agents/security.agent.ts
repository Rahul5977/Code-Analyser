// ─────────────────────────────────────────────────────────────────────────────
// src/council/agents/security.agent.ts
//
// Agent 2: The Security Agent (ReAct Loop with 4 tools)
//
// Tools:
//   1. fetch_chunk_with_context — hybrid retrieval
//   2. check_cve_database      — OSV API lookup
//   3. run_semgrep_rule        — SAST rule execution
//   4. trace_data_flow         — AST-based taint tracking
//
// Uses tools iteratively: fetch chunk → spot suspicious pattern →
// trace data flow → cross-validate with Semgrep → produce finding.
// ─────────────────────────────────────────────────────────────────────────────

import { v4 as uuidv4 } from "uuid";
import { logger } from "../../utils/logger";
import { executeReActLoop, type ReActConfig } from "../react-engine";
import {
  createFetchChunkWithContextTool,
  createCheckCveDatabaseTool,
  createRunSemgrepRuleTool,
  createTraceDataFlowTool,
  type ToolFactoryDeps,
} from "../tools";
import type {
  Finding,
  InvestigationTarget,
  LLMCompletionFn,
} from "../../interfaces/council.interface";

const LOG_CTX = "SecurityAgent";

const SYSTEM_PROMPT = `You are the **Security Agent** of an enterprise SAST analysis council.

You have 4 tools:
1. \`fetch_chunk_with_context\` — Retrieves a code chunk with its structural neighbourhood.
2. \`check_cve_database\` — Queries the OSV API for known CVEs of a dependency.
3. \`run_semgrep_rule\` — Runs a Semgrep SAST rule against code (use ruleId "auto" for broad scan).
4. \`trace_data_flow\` — Traces where a variable comes from and where it goes.

Your workflow for each target:
1. Fetch the chunk with context to understand the code.
2. Look for suspicious patterns (SQL concatenation, eval, unvalidated inputs, hardcoded secrets).
3. If you spot something, use \`trace_data_flow\` to confirm the variable is user-controlled.
4. Use \`run_semgrep_rule\` to cross-validate with static analysis.
5. If dependency risks are mentioned, use \`check_cve_database\` to get real CVE data.

For each confirmed issue, produce a finding as JSON:
{
  "id": "<uuid>",
  "agentId": "security",
  "category": "sql-injection|xss|command-injection|hardcoded-secret|cve|...",
  "title": "Short title",
  "description": "Detailed description with evidence",
  "severity": "CRITICAL|HIGH|MEDIUM|LOW|INFO",
  "confidence": "HIGH|MEDIUM|LOW",
  "filePath": "...",
  "startLine": N,
  "endLine": N,
  "codeSnippet": "exact code cited",
  "chunkIds": ["..."],
  "evidence": []
}

Confidence rules:
- HIGH: ≥3 tools corroborate the issue
- MEDIUM: 2 tools corroborate
- LOW: 1 tool or heuristic only

IMPORTANT: Your final response MUST be a JSON array of findings: [{ ... }, { ... }]
If no issues found, return: []`;

export async function runSecurityAgent(
  targets: InvestigationTarget[],
  deps: ToolFactoryDeps,
  llmFn: LLMCompletionFn,
  maxIterations: number,
  temperature: number,
): Promise<Finding[]> {
  logger.info(
    LOG_CTX,
    `Running Security Agent on ${targets.length} target(s)…`,
  );

  const tools = [
    createFetchChunkWithContextTool(deps),
    createCheckCveDatabaseTool(),
    createRunSemgrepRuleTool(),
    createTraceDataFlowTool(),
  ];

  const config: ReActConfig = {
    agentId: "security",
    systemPrompt: SYSTEM_PROMPT,
    tools,
    llmFn,
    maxIterations,
    temperature,
  };

  const allFindings: Finding[] = [];

  // Process each investigation target
  for (const target of targets) {
    const userMsg = JSON.stringify({
      task: "Investigate these code targets for security vulnerabilities.",
      target: {
        chunkIds: target.chunkIds,
        filePaths: target.filePaths,
        reason: target.reason,
        priority: target.priority,
      },
      instructions:
        "Use your tools iteratively to investigate each chunk. " +
        "Return a JSON array of findings.",
    });

    try {
      const result = await executeReActLoop(config, userMsg);
      const findings = parseFindings(result.response, result.evidence);
      allFindings.push(...findings);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(LOG_CTX, `Error processing target: ${msg}`);
    }
  }

  logger.info(
    LOG_CTX,
    `Security Agent produced ${allFindings.length} finding(s)`,
  );
  return allFindings;
}

/** Parse findings from the agent's JSON response, with robust fallback */
function parseFindings(
  response: string,
  evidence: Array<{
    toolName: string;
    input: Record<string, unknown>;
    output: string;
    timestamp: string;
  }>,
): Finding[] {
  try {
    // Try extracting JSON array
    let jsonStr = response;
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrayMatch) jsonStr = arrayMatch[0];

    const parsed = JSON.parse(jsonStr) as Array<Partial<Finding>>;
    if (!Array.isArray(parsed)) return [];

    return parsed.map((f) => ({
      id: f.id ?? uuidv4(),
      agentId: "security" as const,
      category: f.category ?? "unknown",
      title: f.title ?? "Security Finding",
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
    logger.warn(LOG_CTX, "Failed to parse Security Agent response as JSON");
    return [];
  }
}

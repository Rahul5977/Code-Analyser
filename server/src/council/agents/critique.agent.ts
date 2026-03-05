// ─────────────────────────────────────────────────────────────────────────────
// src/council/agents/critique.agent.ts
//
// Agent 6: The Debate / Critique Agent
//
// After Security and Performance agents produce their findings, this agent
// acts as a devil's advocate.  Its system context includes the raw evidence
// each agent cited.  It has one tool:
//
//   verify_finding(finding, originalChunk) — re-fetches the original code
//   and checks whether the cited line numbers and code snippets actually
//   match the claim.
//
// Flags findings as CONFIRMED, PLAUSIBLE, or DISPUTED.
// Catches LLM hallucinations before they reach the final report.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "../../utils/logger";
import { executeReActLoop, type ReActConfig } from "../react-engine";
import { createVerifyFindingTool } from "../tools";
import type { QdrantStore } from "../../graph-rag/qdrant.store";
import type {
  Finding,
  CritiqueVerdict,
  LLMCompletionFn,
} from "../../interfaces/council.interface";

const LOG_CTX = "CritiqueAgent";

const SYSTEM_PROMPT = `You are the **Debate / Critique Agent** of an enterprise SAST analysis council.

Your job is to act as a devil's advocate.  You receive findings from Security and Performance agents and VERIFY each one.

You have 1 tool:
1. \`verify_finding\` — Re-fetches the original code chunk and checks whether the cited line numbers, code snippets, and claims are accurate.

Your workflow for EACH finding:
1. Read the finding carefully (title, description, code snippet, line numbers, evidence).
2. Call \`verify_finding\` with the finding's ID, chunk ID, cited code snippet, cited line numbers, and the specific claim.
3. Based on the verification result, assign a verdict:
   - **CONFIRMED**: The code, line numbers, and claim all match. Evidence is solid.
   - **PLAUSIBLE**: Most details match, but some minor discrepancies (e.g., off-by-one line numbers).
   - **DISPUTED**: Significant discrepancies — code snippet doesn't match, wrong line numbers, or claim is unsupported.

You MUST respond with ONLY a JSON array of critiqued findings:
[
  {
    "findingId": "...",
    "verdict": "CONFIRMED|PLAUSIBLE|DISPUTED",
    "reason": "Brief explanation of why this verdict was chosen"
  },
  ...
]

Be rigorous but fair.  Don't dispute a finding just because the evidence is thin — dispute it only if there's a concrete discrepancy.  The goal is to catch hallucinations, not to be contrarian.`;

export interface CritiqueResult {
  findings: Finding[];
  disputeRate: number;
}

export async function runCritiqueAgent(
  findings: Finding[],
  qdrant: QdrantStore,
  llmFn: LLMCompletionFn,
  maxIterations: number,
  temperature: number,
): Promise<CritiqueResult> {
  logger.info(
    LOG_CTX,
    `Running Critique Agent on ${findings.length} finding(s)…`,
  );

  if (findings.length === 0) {
    return { findings: [], disputeRate: 0 };
  }

  const tools = [createVerifyFindingTool(qdrant)];

  const config: ReActConfig = {
    agentId: "critique",
    systemPrompt: SYSTEM_PROMPT,
    tools,
    llmFn,
    maxIterations,
    temperature,
  };

  // Build the user message with all findings to critique
  const findingSummaries = findings.map((f) => ({
    id: f.id,
    agentId: f.agentId,
    title: f.title,
    category: f.category,
    description: f.description,
    severity: f.severity,
    confidence: f.confidence,
    filePath: f.filePath,
    startLine: f.startLine,
    endLine: f.endLine,
    codeSnippet: f.codeSnippet.slice(0, 500),
    chunkIds: f.chunkIds,
    evidenceCount: f.evidence.length,
    firstEvidence: f.evidence[0]
      ? {
          toolName: f.evidence[0].toolName,
          outputPreview: f.evidence[0].output.slice(0, 200),
        }
      : null,
  }));

  const userMsg = JSON.stringify({
    task: "Verify each of these findings by re-fetching the original code and checking claims.",
    findings: findingSummaries,
    instructions:
      "For EACH finding, call verify_finding with the finding's ID, first chunkId, " +
      "cited code snippet, cited line numbers, and description as the claim. " +
      "Return a JSON array of verdicts.",
  });

  try {
    const result = await executeReActLoop(config, userMsg);
    const verdicts = parseVerdicts(result.response);

    // Apply verdicts to findings
    const critiquedFindings = findings.map((f) => {
      const verdict = verdicts.get(f.id);
      return {
        ...f,
        critiqueVerdict: verdict?.verdict ?? ("PLAUSIBLE" as CritiqueVerdict),
        critiqueReason:
          verdict?.reason ??
          "No explicit critique provided — defaulting to PLAUSIBLE.",
      };
    });

    const disputedCount = critiquedFindings.filter(
      (f) => f.critiqueVerdict === "DISPUTED",
    ).length;
    const disputeRate =
      findings.length > 0 ? disputedCount / findings.length : 0;

    logger.info(
      LOG_CTX,
      `Critique complete: ${critiquedFindings.filter((f) => f.critiqueVerdict === "CONFIRMED").length} confirmed, ` +
        `${critiquedFindings.filter((f) => f.critiqueVerdict === "PLAUSIBLE").length} plausible, ` +
        `${disputedCount} disputed (rate: ${(disputeRate * 100).toFixed(1)}%)`,
    );

    return { findings: critiquedFindings, disputeRate };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(LOG_CTX, `Critique Agent failed: ${msg}`);

    // Fallback: mark all as PLAUSIBLE
    const fallbackFindings = findings.map((f) => ({
      ...f,
      critiqueVerdict: "PLAUSIBLE" as CritiqueVerdict,
      critiqueReason: `Critique agent encountered an error: ${msg}`,
    }));

    return { findings: fallbackFindings, disputeRate: 0 };
  }
}

// ── Parse verdicts from agent response ───────────────────────────────────────

interface VerdictEntry {
  verdict: CritiqueVerdict;
  reason: string;
}

function parseVerdicts(response: string): Map<string, VerdictEntry> {
  const verdicts = new Map<string, VerdictEntry>();

  try {
    let jsonStr = response;
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrayMatch) jsonStr = arrayMatch[0];

    const parsed = JSON.parse(jsonStr) as Array<{
      findingId?: string;
      verdict?: string;
      reason?: string;
    }>;

    if (!Array.isArray(parsed)) return verdicts;

    for (const entry of parsed) {
      if (!entry.findingId) continue;

      const verdict = normaliseVerdict(entry.verdict ?? "PLAUSIBLE");
      verdicts.set(entry.findingId, {
        verdict,
        reason: entry.reason ?? "No reason provided.",
      });
    }
  } catch {
    logger.warn(LOG_CTX, "Failed to parse Critique Agent response as JSON");
  }

  return verdicts;
}

function normaliseVerdict(raw: string): CritiqueVerdict {
  const upper = raw.toUpperCase().trim();
  if (upper === "CONFIRMED") return "CONFIRMED";
  if (upper === "DISPUTED") return "DISPUTED";
  return "PLAUSIBLE";
}

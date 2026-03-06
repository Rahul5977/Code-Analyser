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

const SYSTEM_PROMPT = `You are the **Debate / Critique Agent** of an enterprise-grade Static Application Security Testing (SAST) analysis council. You are the quality gate — the last line of defence against false positives, hallucinations, and inaccurate findings before they reach the final report.

Your role is critical: false positives erode developer trust in the tool. A single hallucinated finding that cites wrong line numbers or non-existent code will make developers ignore ALL findings. You must be rigorous but fair.

═══════════════════════════════════════════════════════════════
TOOLS AVAILABLE
═══════════════════════════════════════════════════════════════

1. \`verify_finding\`
   — Re-fetches the original code chunk from the vector store and cross-checks whether the finding's cited evidence is accurate.
   — Checks: (a) Does the cited code snippet actually exist at the stated line numbers? (b) Does the file path exist? (c) Is the described vulnerability/issue actually present in the code?
   — Input: { "findingId": "...", "chunkId": "...", "citedCode": "...", "citedStartLine": N, "citedEndLine": N, "claim": "description of the claimed issue" }
   — Output: { "codeMatch": true/false, "lineMatch": true/false, "claimSupported": true/false, "actualCode": "...", "discrepancies": "..." }

═══════════════════════════════════════════════════════════════
VERIFICATION METHODOLOGY (MANDATORY FOR EACH FINDING)
═══════════════════════════════════════════════════════════════

For EVERY finding you receive, execute this verification protocol:

**Step 1 — Evidence Gathering**
  Call \`verify_finding\` with:
  - The finding's ID
  - The first chunk ID from the finding's chunkIds array
  - The cited code snippet (first 300 characters if long)
  - The cited start/end line numbers
  - The finding's description as the "claim"

**Step 2 — Verdict Determination**
  Apply these criteria strictly:

═══════════════════════════════════════════════════════════════
VERDICT CRITERIA
═══════════════════════════════════════════════════════════════

**CONFIRMED** — All three checks pass:
  ✓ Code snippet matches the actual code at the cited location (exact or near-exact match)
  ✓ Line numbers are accurate (within ±3 lines tolerance for minor reformatting)
  ✓ The described vulnerability/issue is genuinely present in the code (the claim is supportable)
  → Use CONFIRMED when evidence is solid and the finding is actionable.

**PLAUSIBLE** — Mostly accurate with minor discrepancies:
  ✓ The code and issue broadly match, but:
  ~ Line numbers are off by >3 lines but the code is still in the same function
  ~ Code snippet is a paraphrase rather than verbatim copy
  ~ The vulnerability exists but severity may be overstated
  ~ Evidence is thin (single tool corroboration) but the pattern is a known risk
  → Use PLAUSIBLE as the default when you can't fully verify but nothing is clearly wrong.

**DISPUTED** — Significant factual errors:
  ✗ Code snippet does NOT match the actual code at the cited location
  ✗ File path does not exist or points to wrong file
  ✗ The claimed vulnerability is not present (e.g., "SQL injection" but the code uses parameterised queries)
  ✗ Line numbers are completely wrong (off by >20 lines or pointing to a different function)
  ✗ The finding is a duplicate of another finding with a different ID
  → Use DISPUTED ONLY when there is a concrete, provable discrepancy. The goal is to catch hallucinations, not to be contrarian.

═══════════════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════

You MUST respond with ONLY a JSON array of verdicts:
[
  {
    "findingId": "the-original-finding-id",
    "verdict": "CONFIRMED",
    "reason": "Code snippet matches exactly at lines 45-52. The exec() call with unsanitised req.body.command is confirmed by verify_finding. High confidence."
  },
  {
    "findingId": "another-finding-id",
    "verdict": "DISPUTED",
    "reason": "The cited code snippet 'db.query(sql)' does not appear at lines 30-35. Actual code at those lines is a comment block. The finding appears to be hallucinated."
  },
  {
    "findingId": "third-finding-id",
    "verdict": "PLAUSIBLE",
    "reason": "Code snippet is a close match (minor whitespace differences). The SQL concatenation pattern exists but the input comes from an internal config, not user input. Severity may be overstated."
  }
]

═══════════════════════════════════════════════════════════════
RULES OF ENGAGEMENT
═══════════════════════════════════════════════════════════════

1. **Verify EVERY finding.** Do not skip any finding — call verify_finding for each one.
2. **Be rigorous but fair.** The goal is to catch hallucinations and factual errors, NOT to be contrarian.
3. **Default to PLAUSIBLE, not DISPUTED.** If evidence is thin but nothing is provably wrong, use PLAUSIBLE.
4. **Provide specific reasons.** "Looks fine" is not acceptable. State what was checked and what matched/didn't match.
5. **Don't re-analyse the vulnerability.** Your job is verification, not re-assessment. Don't change severity or category — just verify the evidence.
6. **Duplicate detection.** If two findings describe the same issue in the same code location, mark the less-detailed one as DISPUTED with reason "Duplicate of finding <id>".
7. **A high dispute rate (>40%) suggests upstream agent issues** — but don't artificially lower the rate. Report honestly.`;

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

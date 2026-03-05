// ─────────────────────────────────────────────────────────────────────────────
// src/council/agents/synthesis.agent.ts
//
// Agent 7: The Synthesis / Pedagogical Agent
//
// Receives only CONFIRMED and PLAUSIBLE findings from the Critique Agent.
// Has two tools:
//   1. generate_fixed_code_snippet(originalCode, findingDescription)
//   2. fetch_documentation_reference(technology, conceptName)
//
// Output: a FindingCard for each finding — the vulnerable code, the fixed code,
// a plain-English explanation at three reading levels (junior dev, senior dev,
// technical manager), and external references.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "../../utils/logger";
import { executeReActLoop, type ReActConfig } from "../react-engine";
import {
  createGenerateFixedCodeSnippetTool,
  createFetchDocumentationReferenceTool,
} from "../tools";
import type {
  Finding,
  FindingCard,
  LLMCompletionFn,
} from "../../interfaces/council.interface";

const LOG_CTX = "SynthesisAgent";

const SYSTEM_PROMPT = `You are the **Synthesis / Pedagogical Agent** of an enterprise SAST analysis council.

You receive CONFIRMED and PLAUSIBLE findings from the Critique Agent.  Your job is to transform each finding into a comprehensive, educational **FindingCard**.

You have 2 tools:
1. \`generate_fixed_code_snippet\` — Calls the LLM to produce a corrected version of the flagged code.
2. \`fetch_documentation_reference\` — Queries a curated docs index (OWASP, MDN, Node.js docs) for authoritative references.

Your workflow for EACH finding:
1. Call \`generate_fixed_code_snippet\` with the original code and finding description.
2. Call \`fetch_documentation_reference\` with the relevant technology and concept.
3. Write three explanations at different reading levels.

You MUST respond with ONLY a JSON array of FindingCards:
[
  {
    "findingId": "...",
    "fixedCode": "corrected code here",
    "explanations": {
      "junior": "Plain-English explanation for a junior developer (2-3 sentences, no jargon).",
      "senior": "Technical explanation for a senior developer (include patterns, trade-offs, alternatives).",
      "manager": "Business-impact explanation for a technical manager (risk, effort, priority)."
    },
    "references": [{ "title": "...", "url": "..." }]
  },
  ...
]

Guidelines:
- The fixed code MUST be complete and compilable — not pseudocode.
- Junior explanation: "This code does X, which means Y can go wrong. The fix does Z."
- Senior explanation: Include specific vulnerability class (CWE-xxx), mitigation patterns, and alternatives.
- Manager explanation: "This vulnerability could lead to [impact]. Fixing it takes [effort]. Priority: [level]."
- Always include at least 1 reference (OWASP, MDN, or language docs).`;

export async function runSynthesisAgent(
  findings: Finding[],
  llmFn: LLMCompletionFn,
  maxIterations: number,
  temperature: number,
): Promise<FindingCard[]> {
  logger.info(
    LOG_CTX,
    `Running Synthesis Agent on ${findings.length} finding(s)…`,
  );

  // Filter to only CONFIRMED and PLAUSIBLE findings
  const eligibleFindings = findings.filter(
    (f) =>
      f.critiqueVerdict === "CONFIRMED" || f.critiqueVerdict === "PLAUSIBLE",
  );

  if (eligibleFindings.length === 0) {
    logger.info(LOG_CTX, "No eligible findings to synthesise");
    return [];
  }

  logger.info(
    LOG_CTX,
    `${eligibleFindings.length} eligible findings (${findings.length - eligibleFindings.length} disputed, skipped)`,
  );

  const tools = [
    createGenerateFixedCodeSnippetTool(llmFn),
    createFetchDocumentationReferenceTool(),
  ];

  const config: ReActConfig = {
    agentId: "synthesis",
    systemPrompt: SYSTEM_PROMPT,
    tools,
    llmFn,
    maxIterations,
    temperature,
  };

  // Process findings in batches to avoid overly long conversations
  const BATCH_SIZE = 5;
  const allCards: FindingCard[] = [];

  for (let i = 0; i < eligibleFindings.length; i += BATCH_SIZE) {
    const batch = eligibleFindings.slice(i, i + BATCH_SIZE);

    const findingSummaries = batch.map((f) => ({
      id: f.id,
      agentId: f.agentId,
      category: f.category,
      title: f.title,
      description: f.description,
      severity: f.severity,
      filePath: f.filePath,
      startLine: f.startLine,
      endLine: f.endLine,
      codeSnippet: f.codeSnippet.slice(0, 800),
      critiqueVerdict: f.critiqueVerdict,
    }));

    const userMsg = JSON.stringify({
      task: "Generate FindingCards for these confirmed/plausible findings.",
      findings: findingSummaries,
      instructions:
        "For EACH finding: 1) call generate_fixed_code_snippet, 2) call fetch_documentation_reference, " +
        "3) write explanations at 3 levels. Return a JSON array of FindingCards.",
    });

    try {
      const result = await executeReActLoop(config, userMsg);
      const cards = parseCards(result.response, batch);
      allCards.push(...cards);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(LOG_CTX, `Error processing synthesis batch: ${msg}`);
      // Generate minimal cards for failed batch
      allCards.push(...batch.map((f) => generateFallbackCard(f)));
    }
  }

  logger.info(
    LOG_CTX,
    `Synthesis Agent produced ${allCards.length} finding card(s)`,
  );
  return allCards;
}

/** Parse finding cards from the agent's JSON response */
function parseCards(
  response: string,
  originalFindings: Finding[],
): FindingCard[] {
  try {
    let jsonStr = response;
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrayMatch) jsonStr = arrayMatch[0];

    const parsed = JSON.parse(jsonStr) as Array<{
      findingId?: string;
      fixedCode?: string;
      explanations?: {
        junior?: string;
        senior?: string;
        manager?: string;
      };
      references?: Array<{ title?: string; url?: string }>;
    }>;

    if (!Array.isArray(parsed))
      return originalFindings.map(generateFallbackCard);

    const findingMap = new Map(originalFindings.map((f) => [f.id, f]));
    const cards: FindingCard[] = [];

    for (const entry of parsed) {
      const finding = entry.findingId
        ? findingMap.get(entry.findingId)
        : undefined;
      if (!finding) continue;

      cards.push({
        finding,
        fixedCode:
          entry.fixedCode ??
          "// Fix generation failed — please review manually.",
        explanations: {
          junior:
            entry.explanations?.junior ??
            "This code has an issue that needs to be fixed.",
          senior:
            entry.explanations?.senior ??
            `${finding.category}: ${finding.description}`,
          manager:
            entry.explanations?.manager ??
            `A ${finding.severity} issue was found. Please review.`,
        },
        references: (entry.references ?? [])
          .filter((r) => r.title && r.url)
          .map((r) => ({ title: r.title!, url: r.url! })),
      });

      // Remove matched finding to handle remaining
      findingMap.delete(finding.id);
    }

    // Generate fallback cards for unmatched findings
    for (const [, remaining] of findingMap) {
      cards.push(generateFallbackCard(remaining));
    }

    return cards;
  } catch {
    logger.warn(
      LOG_CTX,
      "Failed to parse Synthesis Agent response — generating fallback cards",
    );
    return originalFindings.map(generateFallbackCard);
  }
}

/** Generate a minimal fallback FindingCard when LLM synthesis fails */
function generateFallbackCard(finding: Finding): FindingCard {
  return {
    finding,
    fixedCode:
      "// Automated fix generation was not available. Please review manually.",
    explanations: {
      junior: `A ${finding.severity.toLowerCase()} ${finding.category} issue was found in ${finding.filePath}. ${finding.description}`,
      senior: `[${finding.category}] ${finding.description} (${finding.filePath}:${finding.startLine}-${finding.endLine}). Confidence: ${finding.confidence}. Verdict: ${finding.critiqueVerdict ?? "N/A"}.`,
      manager: `A ${finding.severity} severity ${finding.category} issue was identified. This should be reviewed and addressed based on team priorities.`,
    },
    references: [],
  };
}

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
  extractWindow,
} from "../tools";
import type {
  Finding,
  FindingCard,
  LLMCompletionFn,
} from "../../interfaces/council.interface";

const LOG_CTX = "SynthesisAgent";

const SYSTEM_PROMPT = `You are the **Synthesis / Pedagogical Agent** of an enterprise-grade Static Application Security Testing (SAST) analysis council. You are the final stage of the pipeline — you transform raw security and performance findings into comprehensive, educational, and actionable **FindingCards** that developers at all levels can understand and act upon.

Your output is what developers and managers will READ. Quality, clarity, and accuracy of your output directly determines whether findings get fixed or ignored.

═══════════════════════════════════════════════════════════════
TOOLS AVAILABLE
═══════════════════════════════════════════════════════════════

1. \`generate_fixed_code_snippet\`
   — Generates a corrected version of ONLY the vulnerable code window (not the whole file).
   — YOU MUST provide the vulnerability's exact startLine / endLine AND the finding's category so the tool can choose the right fix strategy.
   — Input: { "originalCode": "full chunk code", "findingDescription": "...", "findingCategory": "high-complexity", "chunkStartLine": N, "vulnStartLine": N, "vulnEndLine": N, "language": "typescript" }
   — The tool has THREE internal strategies:
     • **Windowed Diff** (finding <30 lines): extracts only the vulnerable lines ± 5 lines context.
     • **Architectural Warning** (finding >50 lines AND structural category like "high-complexity"): bypasses LLM, returns a refactor stub.
     • **Bounded Rewrite** (everything else): caps at 60 lines.
   — The tool uses <fixed_code> XML tags internally — you do NOT need to parse them. Just use the returned fixedCode.

2. \`fetch_documentation_reference\`
   — Queries a curated documentation index (OWASP, CWE, MDN, Node.js docs, React docs) for authoritative references.
   — Input: { "technology": "node|react|express|sql|crypto|general", "conceptName": "sql-injection|xss|complexity|..." }

═══════════════════════════════════════════════════════════════
WORKFLOW (FOR EACH FINDING)
═══════════════════════════════════════════════════════════════

**Step 1 — Generate Fix**
  Call \`generate_fixed_code_snippet\` with:
  - originalCode: the finding's codeSnippet (the full chunk code)
  - findingDescription: a clear description of what's wrong
  - findingCategory: the finding's category (e.g., "sql-injection", "high-complexity")
  - chunkStartLine: the finding's startLine
  - vulnStartLine: the finding's startLine (the EXACT start of the vulnerability)
  - vulnEndLine: the finding's endLine (the EXACT end of the vulnerability)
  - language: inferred from file extension

  ⚠️ CRITICAL: Always pass ALL line numbers AND findingCategory. The tool uses these to:
  (a) Choose the correct strategy (windowed diff vs architectural warning vs bounded rewrite)
  (b) Extract only a narrow code window so the LLM doesn't run out of tokens
  
  The tool will NEVER return an empty array []. It always returns valid fixedCode.

**Step 2 — Fetch References**
  Call \`fetch_documentation_reference\` with:
  - The relevant technology (infer from file extension and imports)
  - The vulnerability/issue concept

**Step 3 — Write Explanations**
  Write three explanations at different reading levels (see below).

═══════════════════════════════════════════════════════════════
EXPLANATION GUIDELINES
═══════════════════════════════════════════════════════════════

**Junior Developer Explanation** (2-4 sentences, zero jargon):
  - Start with WHAT the code does wrong in plain English.
  - Explain WHY it's dangerous with a concrete, relatable example.
  - State WHAT the fix does.
  - Example: "This code builds a database query by pasting user input directly into the SQL string. An attacker could type something like ' OR 1=1 -- into the login form and see everyone's data. The fix uses parameterised queries, which treat user input as data, never as SQL commands."

**Senior Developer Explanation** (3-5 sentences, technical depth):
  - Reference the specific vulnerability class (CWE-ID, OWASP category).
  - Describe the attack vector and exploitation complexity.
  - Discuss the fix pattern, trade-offs, and alternatives.
  - Mention related mitigations (WAF rules, CSP headers, rate limiting).

**Technical Manager Explanation** (2-3 sentences, business impact):
  - State the business risk in non-technical terms (data breach, downtime, compliance).
  - Estimate fix effort (trivial/small/medium/large).
  - Recommend priority relative to other findings.

═══════════════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════

You MUST respond with ONLY a JSON array of FindingCards:
[
  {
    "findingId": "the-original-finding-id",
    "fixedCode": "// The code returned by generate_fixed_code_snippet",
    "explanations": {
      "junior": "Plain-English explanation...",
      "senior": "Technical explanation with CWE/OWASP references...",
      "manager": "Business impact explanation..."
    },
    "references": [
      { "title": "OWASP SQL Injection Prevention Cheat Sheet", "url": "https://..." }
    ]
  }
]

⚠️ CRITICAL OUTPUT RULES:
- NEVER output an empty array []. If you cannot generate a card, still produce one with a fallback explanation.
- NEVER skip a finding. Every finding in the input MUST have a corresponding card.
- The fixedCode field should contain EXACTLY what generate_fixed_code_snippet returned.
- Every FindingCard MUST have a findingId matching the original finding's id.

═══════════════════════════════════════════════════════════════
REFERENCE REQUIREMENTS
═══════════════════════════════════════════════════════════════

Always include at least 1 reference from these authoritative sources:
- **Security**: OWASP Cheat Sheets, CWE database, Node.js security best practices
- **Performance**: MDN Web Docs, Node.js docs, V8 blog posts
- **React**: React docs (react.dev), Kent C. Dodds blog
- **General**: Language/framework official documentation

Use real, valid URLs. Do NOT invent URLs.

═══════════════════════════════════════════════════════════════
RULES OF ENGAGEMENT
═══════════════════════════════════════════════════════════════

1. **Every FindingCard must have a findingId matching the original finding.** Missing IDs break the pipeline.
2. **Junior explanations must be jargon-free.** No CWE numbers, no "taint propagation", no "attack surface".
3. **Manager explanations must quantify impact.** "Could cause a data breach" is better than "is a vulnerability".
4. **Don't skip references.** Every finding type has an OWASP or CWE entry — find it.
5. **Process ALL findings.** Don't skip any — each finding in the input must have a corresponding card in the output.
6. **NEVER output an empty array [].** This is the #1 cause of pipeline failures.`;

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
      // ★ Send the FULL codeSnippet — DO NOT truncate.
      // The generate_fixed_code_snippet tool needs the real line count to
      // correctly choose between windowed-diff / architectural-warning /
      // bounded-rewrite.  Truncating to 800 chars caused the tool to
      // see ~15 lines instead of ~271, bypassing the architectural guardrail
      // and producing a broken diff.  The tool internally caps what it sends
      // to the LLM (MAX_LLM_LINES = 60), so token overflow is already handled.
      codeSnippet: f.codeSnippet,
      critiqueVerdict: f.critiqueVerdict,
    }));

    const userMsg = JSON.stringify({
      task: "Generate FindingCards for these confirmed/plausible findings.",
      findings: findingSummaries,
      instructions:
        "For EACH finding: " +
        "1) call generate_fixed_code_snippet with originalCode=codeSnippet, " +
        "chunkStartLine=startLine, vulnStartLine=startLine, vulnEndLine=endLine, " +
        "findingDescription=description. " +
        "2) call fetch_documentation_reference with the relevant technology and concept. " +
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

    if (!Array.isArray(parsed) || parsed.length === 0)
      return originalFindings.map(generateFallbackCard);

    const findingMap = new Map(originalFindings.map((f) => [f.id, f]));
    const cards: FindingCard[] = [];

    for (const entry of parsed) {
      const finding = entry.findingId
        ? findingMap.get(entry.findingId)
        : undefined;
      if (!finding) continue;

      // Compute the narrow vulnerable window for the UI diff
      let vulnerableWindow: FindingCard["vulnerableWindow"];
      if (finding.codeSnippet && finding.startLine > 0 && finding.endLine > 0) {
        const win = extractWindow(
          finding.codeSnippet,
          finding.startLine,
          finding.startLine,
          finding.endLine,
          5,
        );
        vulnerableWindow = {
          code: win.windowCode,
          startLine: win.windowStartLine,
          endLine: win.windowEndLine,
        };
      }

      // ★ Harden fixedCode — NEVER allow empty, "[]", or undefined through
      //   to the diff viewer.  Detect strategy from the fix content.
      let fixedCode =
        entry.fixedCode ?? "// Fix generation failed — please review manually.";

      // Guard against LLM returning literal "[]" or empty string
      if (
        !fixedCode ||
        fixedCode.trim() === "" ||
        fixedCode.trim() === "[]" ||
        fixedCode.trim() === "undefined" ||
        fixedCode.trim() === "null"
      ) {
        fixedCode =
          `// ⚠️ Auto-fix generation was not available for this finding.\n` +
          `// Issue: ${finding.description.slice(0, 200)}\n` +
          `// Please review and fix this issue manually.`;
      }

      // Detect fix strategy from the content
      const isArchitecturalWarning = fixedCode.includes(
        "ARCHITECTURAL REFACTOR REQUIRED",
      );
      const fixStrategy: FindingCard["fixStrategy"] = isArchitecturalWarning
        ? "architectural-warning"
        : undefined;

      cards.push({
        finding,
        fixedCode,
        vulnerableWindow,
        fixStrategy,
        isArchitecturalWarning,
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

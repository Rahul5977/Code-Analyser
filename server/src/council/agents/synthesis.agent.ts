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

const SYSTEM_PROMPT = `You are the **Synthesis / Pedagogical Agent** of an enterprise-grade Static Application Security Testing (SAST) analysis council. You are the final stage of the pipeline — you transform raw security and performance findings into comprehensive, educational, and actionable **FindingCards** that developers at all levels can understand and act upon.

Your output is what developers and managers will READ. Quality, clarity, and accuracy of your output directly determines whether findings get fixed or ignored.

═══════════════════════════════════════════════════════════════
TOOLS AVAILABLE
═══════════════════════════════════════════════════════════════

1. \`generate_fixed_code_snippet\`
   — Calls the LLM to produce a corrected version of the flagged code.
   — The fix MUST be complete, compilable, and drop-in replaceable.
   — Input: { "originalCode": "the vulnerable/inefficient code", "findingDescription": "what's wrong and how to fix it" }

2. \`fetch_documentation_reference\`
   — Queries a curated documentation index (OWASP, CWE, MDN, Node.js docs, React docs) for authoritative references.
   — Input: { "technology": "node|react|express|sql|crypto|general", "concept": "sql-injection|xss|prototype-pollution|..." }

═══════════════════════════════════════════════════════════════
WORKFLOW (FOR EACH FINDING)
═══════════════════════════════════════════════════════════════

**Step 1 — Generate Fix**
  Call \`generate_fixed_code_snippet\` with:
  - The original vulnerable/inefficient code from the finding's codeSnippet
  - A clear description of what's wrong and what the fix should achieve

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
  - Example: "CWE-89 SQL Injection via string concatenation in a Knex raw query. The tainted source is req.body.email (line 34), which flows unsanitised into a raw SQL template literal (line 41). Fix: use Knex's parameterised query builder (.where({ email })) instead of .raw(). Alternative: add express-validator middleware for input validation as defence-in-depth. Consider also enabling SQL query logging in staging to detect injection attempts."

**Technical Manager Explanation** (2-3 sentences, business impact):
  - State the business risk in non-technical terms (data breach, downtime, compliance).
  - Estimate fix effort (trivial/small/medium/large).
  - Recommend priority relative to other findings.
  - Example: "This SQL injection vulnerability could allow an attacker to read, modify, or delete all customer data, potentially triggering a GDPR breach notification. The fix is a small, localised code change (~5 minutes). This should be the highest-priority fix in this report."

═══════════════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════

You MUST respond with ONLY a JSON array of FindingCards:
[
  {
    "findingId": "the-original-finding-id",
    "fixedCode": "// Complete, compilable fixed code\\nconst result = await db.select('*').from('users').where({ email });",
    "explanations": {
      "junior": "Plain-English explanation...",
      "senior": "Technical explanation with CWE/OWASP references...",
      "manager": "Business impact explanation..."
    },
    "references": [
      { "title": "OWASP SQL Injection Prevention Cheat Sheet", "url": "https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html" },
      { "title": "CWE-89: SQL Injection", "url": "https://cwe.mitre.org/data/definitions/89.html" }
    ]
  }
]

═══════════════════════════════════════════════════════════════
FIXED CODE REQUIREMENTS
═══════════════════════════════════════════════════════════════

- MUST be complete and compilable — not pseudocode or fragments.
- MUST be a drop-in replacement for the original code (same function signature, same return type).
- MUST preserve the original code's functionality while fixing the issue.
- MUST include necessary imports if new libraries are used.
- Add inline comments explaining the security/performance improvement.
- Follow the project's existing code style (TypeScript strictness, async/await patterns, etc.).

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
2. **Fixed code must compile.** If you're unsure about types or imports, include a comment like "// Ensure X is imported".
3. **Junior explanations must be jargon-free.** No CWE numbers, no "taint propagation", no "attack surface".
4. **Manager explanations must quantify impact.** "Could cause a data breach" is better than "is a vulnerability".
5. **Don't skip references.** Every finding type has an OWASP or CWE entry — find it.
6. **Process ALL findings.** Don't skip any — each finding in the input must have a corresponding card in the output.`;

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

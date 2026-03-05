// ─────────────────────────────────────────────────────────────────────────────
// src/council/tools/synthesis.tools.ts
//
// Synthesis / Pedagogical Agent Tools:
//   1. generate_fixed_code_snippet — LLM-powered code fix generation
//   2. fetch_documentation_reference — curated docs index lookup
// ─────────────────────────────────────────────────────────────────────────────

import type {
  AgentTool,
  LLMCompletionFn,
} from "../../interfaces/council.interface";

// ─── generate_fixed_code_snippet ─────────────────────────────────────────────

/**
 * Calls the LLM to produce a corrected version of flagged code.
 */
export function createGenerateFixedCodeSnippetTool(
  llmFn: LLMCompletionFn,
): AgentTool {
  return {
    name: "generate_fixed_code_snippet",
    description:
      "Generates a corrected version of flagged code based on a finding description. " +
      "Returns the fixed code along with a diff summary of changes made.",
    parameters: {
      type: "object",
      properties: {
        originalCode: {
          type: "string",
          description: "The original vulnerable or problematic code.",
        },
        findingDescription: {
          type: "string",
          description:
            "Description of the issue found and what needs to be fixed.",
        },
        language: {
          type: "string",
          description: "Programming language (default: 'typescript').",
        },
      },
      required: ["originalCode", "findingDescription"],
    },
    execute: async (args) => {
      const originalCode = args["originalCode"] as string;
      const findingDescription = args["findingDescription"] as string;
      const language = (args["language"] as string) ?? "typescript";

      if (!originalCode || !findingDescription) {
        return JSON.stringify({
          error: "originalCode and findingDescription are required",
        });
      }

      try {
        const response = await llmFn(
          [
            {
              role: "system",
              content:
                `You are a senior ${language} developer. Fix the code issue described below. ` +
                "Return ONLY the corrected code in a single code block, followed by a brief " +
                "summary of changes (2-3 sentences). No extra commentary.",
            },
            {
              role: "user",
              content:
                `## Issue\n${findingDescription}\n\n## Original Code\n\`\`\`${language}\n${originalCode}\n\`\`\`\n\n` +
                "Please provide the fixed code and a brief summary of changes.",
            },
          ],
          undefined,
          0.2,
        );

        const content = response.content;

        // Parse the response: extract code block and summary
        const codeBlockMatch = content.match(/```[\w]*\n([\s\S]*?)```/);
        const fixedCode = codeBlockMatch?.[1]?.trim() ?? content;

        // Everything after the code block is the summary
        const afterCodeBlock = codeBlockMatch
          ? content
              .slice(
                content.indexOf("```", (codeBlockMatch.index ?? 0) + 3) + 3,
              )
              .trim()
          : "";

        return JSON.stringify({
          fixedCode,
          changeSummary:
            afterCodeBlock ||
            "Code has been updated to address the described issue.",
          language,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `Code fix generation failed: ${msg}` });
      }
    },
  };
}

// ─── fetch_documentation_reference ───────────────────────────────────────────

/**
 * Looks up authoritative documentation references for technologies and concepts.
 * Uses a curated mapping of common security, performance, and best-practice resources.
 */
export function createFetchDocumentationReferenceTool(): AgentTool {
  return {
    name: "fetch_documentation_reference",
    description:
      "Fetches authoritative documentation references for a given technology " +
      "and concept (e.g., OWASP for SQL injection, MDN for fetch API). " +
      "Returns titles and URLs for inclusion in finding cards.",
    parameters: {
      type: "object",
      properties: {
        technology: {
          type: "string",
          description:
            "The technology area (e.g., 'node.js', 'express', 'react', 'security').",
        },
        conceptName: {
          type: "string",
          description:
            "The specific concept (e.g., 'sql-injection', 'xss', 'memory-leak').",
        },
      },
      required: ["technology", "conceptName"],
    },
    execute: async (args) => {
      const technology = (args["technology"] as string).toLowerCase();
      const conceptName = (args["conceptName"] as string).toLowerCase();

      try {
        const references = lookupReferences(technology, conceptName);
        return JSON.stringify({
          technology,
          conceptName,
          references,
          message:
            references.length > 0
              ? `Found ${references.length} reference(s).`
              : "No curated references found — consider a web search.",
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `Documentation lookup failed: ${msg}` });
      }
    },
  };
}

interface DocReference {
  title: string;
  url: string;
}

/** Curated documentation reference index */
function lookupReferences(technology: string, concept: string): DocReference[] {
  const refs: DocReference[] = [];
  const key = `${technology}:${concept}`;

  // ── Security references (OWASP, CWE) ──
  const securityRefs: Record<string, DocReference[]> = {
    "sql-injection": [
      {
        title: "OWASP: SQL Injection",
        url: "https://owasp.org/www-community/attacks/SQL_Injection",
      },
      {
        title: "CWE-89: SQL Injection",
        url: "https://cwe.mitre.org/data/definitions/89.html",
      },
      {
        title: "OWASP: SQL Injection Prevention Cheat Sheet",
        url: "https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html",
      },
    ],
    xss: [
      {
        title: "OWASP: Cross Site Scripting (XSS)",
        url: "https://owasp.org/www-community/attacks/xss/",
      },
      {
        title: "CWE-79: Cross-site Scripting",
        url: "https://cwe.mitre.org/data/definitions/79.html",
      },
      {
        title: "OWASP: XSS Prevention Cheat Sheet",
        url: "https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html",
      },
    ],
    "command-injection": [
      {
        title: "OWASP: Command Injection",
        url: "https://owasp.org/www-community/attacks/Command_Injection",
      },
      {
        title: "CWE-78: OS Command Injection",
        url: "https://cwe.mitre.org/data/definitions/78.html",
      },
    ],
    "code-injection": [
      {
        title: "OWASP: Code Injection",
        url: "https://owasp.org/www-community/attacks/Code_Injection",
      },
      {
        title: "CWE-94: Code Injection",
        url: "https://cwe.mitre.org/data/definitions/94.html",
      },
    ],
    "hardcoded-secret": [
      {
        title: "OWASP: Hard-coded Credentials",
        url: "https://owasp.org/www-community/vulnerabilities/Use_of_hard-coded_password",
      },
      {
        title: "CWE-798: Hard-coded Credentials",
        url: "https://cwe.mitre.org/data/definitions/798.html",
      },
    ],
    "path-traversal": [
      {
        title: "OWASP: Path Traversal",
        url: "https://owasp.org/www-community/attacks/Path_Traversal",
      },
      {
        title: "CWE-22: Path Traversal",
        url: "https://cwe.mitre.org/data/definitions/22.html",
      },
    ],
    "open-redirect": [
      {
        title: "CWE-601: Open Redirect",
        url: "https://cwe.mitre.org/data/definitions/601.html",
      },
    ],
  };

  // ── Performance references ──
  const perfRefs: Record<string, DocReference[]> = {
    "memory-leak": [
      {
        title: "Node.js: Debugging Memory Leaks",
        url: "https://nodejs.org/en/docs/guides/diagnostics/memory/using-heap-profiler",
      },
    ],
    "event-loop": [
      {
        title: "Node.js: The Event Loop",
        url: "https://nodejs.org/en/docs/guides/event-loop-timers-and-nexttick",
      },
    ],
    complexity: [
      { title: "Big-O Cheat Sheet", url: "https://www.bigocheatsheet.com/" },
    ],
  };

  // ── Node.js / Express references ──
  const nodeRefs: Record<string, DocReference[]> = {
    "error-handling": [
      {
        title: "Express: Error Handling",
        url: "https://expressjs.com/en/guide/error-handling.html",
      },
      { title: "Node.js: Errors", url: "https://nodejs.org/api/errors.html" },
    ],
    authentication: [
      {
        title: "OWASP: Authentication Cheat Sheet",
        url: "https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html",
      },
    ],
    "input-validation": [
      {
        title: "OWASP: Input Validation Cheat Sheet",
        url: "https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html",
      },
    ],
  };

  // Match by concept name (fuzzy)
  for (const [pattern, docRefs] of Object.entries(securityRefs)) {
    if (concept.includes(pattern) || pattern.includes(concept)) {
      refs.push(...docRefs);
    }
  }

  if (
    technology.includes("node") ||
    technology.includes("express") ||
    technology.includes("javascript") ||
    technology.includes("typescript")
  ) {
    for (const [pattern, docRefs] of Object.entries(nodeRefs)) {
      if (concept.includes(pattern) || pattern.includes(concept)) {
        refs.push(...docRefs);
      }
    }
  }

  for (const [pattern, docRefs] of Object.entries(perfRefs)) {
    if (concept.includes(pattern) || pattern.includes(concept)) {
      refs.push(...docRefs);
    }
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  return refs.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

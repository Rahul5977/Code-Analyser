// ─────────────────────────────────────────────────────────────────────────────
// src/council/tools/synthesis.tools.ts
//
// Synthesis / Pedagogical Agent Tools:
//   1. generate_fixed_code_snippet — LLM-powered TARGETED code fix generation
//   2. fetch_documentation_reference — curated docs index lookup
//
// ★ Key design choice: we NEVER send the full 500-line chunk to the LLM for
//   fix generation.  Instead we use `extractWindow()` to isolate the exact
//   vulnerable lines ± a configurable buffer (default 10 lines), send only
//   that ~20-line window, and get back a focused, compilable fix.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  AgentTool,
  LLMCompletionFn,
} from "../../interfaces/council.interface";

// ─── extractWindow — Surgical Code Windowing ─────────────────────────────────

/**
 * Extracts a narrow window of code around the vulnerable lines.
 *
 * @param code       The full chunk's source code.
 * @param chunkStart The 1-based start line of the chunk in the original file.
 * @param vulnStart  The 1-based start line of the vulnerability in the original file.
 * @param vulnEnd    The 1-based end line of the vulnerability in the original file.
 * @param buffer     Number of context lines above and below (default: 10).
 * @returns          The extracted window with its absolute line range.
 *
 * Example:
 *   Chunk covers lines 20-501 of EditListing.jsx.
 *   Finding says the issue is on lines 45-55.
 *   extractWindow(code, 20, 45, 55, 10)
 *   → returns lines 35-65 of the file (lines 16-46 of the chunk), i.e., a 30-line window.
 */
export function extractWindow(
  code: string,
  chunkStart: number,
  vulnStart: number,
  vulnEnd: number,
  buffer: number = 10,
): { windowCode: string; windowStartLine: number; windowEndLine: number } {
  const lines = code.split("\n");
  const totalLines = lines.length;

  // Convert absolute file lines → 0-based chunk-local indices
  const localVulnStart = Math.max(0, vulnStart - chunkStart);
  const localVulnEnd = Math.min(totalLines - 1, vulnEnd - chunkStart);

  // Apply buffer, clamped to chunk bounds
  const windowLocalStart = Math.max(0, localVulnStart - buffer);
  const windowLocalEnd = Math.min(totalLines - 1, localVulnEnd + buffer);

  const windowCode = lines
    .slice(windowLocalStart, windowLocalEnd + 1)
    .join("\n");
  const windowStartLine = chunkStart + windowLocalStart;
  const windowEndLine = chunkStart + windowLocalEnd;

  return { windowCode, windowStartLine, windowEndLine };
}

// ─── generate_fixed_code_snippet ─────────────────────────────────────────────

/**
 * Generates a targeted fix for ONLY the vulnerable code window, not the
 * entire chunk.  Prevents LLM token overflow and hallucination.
 */
export function createGenerateFixedCodeSnippetTool(
  llmFn: LLMCompletionFn,
): AgentTool {
  return {
    name: "generate_fixed_code_snippet",
    description:
      "Generates a corrected version of flagged code. IMPORTANT: Provide " +
      "the vulnerability's exact startLine and endLine so the tool can " +
      "extract only the relevant code window (~20 lines) for the LLM. " +
      "Returns the fixed code window and its line range.",
    parameters: {
      type: "object",
      properties: {
        originalCode: {
          type: "string",
          description:
            "The full chunk source code. The tool will automatically extract " +
            "a narrow window around the vulnerability.",
        },
        findingDescription: {
          type: "string",
          description:
            "Description of the issue: what's wrong and how to fix it.",
        },
        chunkStartLine: {
          type: "number",
          description:
            "The 1-based start line of the chunk in the original file.",
        },
        vulnStartLine: {
          type: "number",
          description:
            "The 1-based start line of the specific vulnerability in the original file.",
        },
        vulnEndLine: {
          type: "number",
          description:
            "The 1-based end line of the specific vulnerability in the original file.",
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
      const chunkStartLine = (args["chunkStartLine"] as number) ?? 1;
      const vulnStartLine = (args["vulnStartLine"] as number) ?? 0;
      const vulnEndLine = (args["vulnEndLine"] as number) ?? 0;

      if (!originalCode || !findingDescription) {
        return JSON.stringify({
          error: "originalCode and findingDescription are required",
        });
      }

      try {
        // ── Determine what code to send to the LLM ──
        // If the agent provided vulnerability line numbers, extract a narrow
        // window.  Otherwise, if the whole chunk is small (≤60 lines), send
        // it in full.  If it's large and we have no line numbers, truncate
        // to the first 60 lines + a comment.
        let codeForLLM: string;
        let windowStartLine: number;
        let windowEndLine: number;
        const codeLines = originalCode.split("\n");

        if (vulnStartLine > 0 && vulnEndLine > 0) {
          // Targeted window extraction
          const window = extractWindow(
            originalCode,
            chunkStartLine,
            vulnStartLine,
            vulnEndLine,
            10,
          );
          codeForLLM = window.windowCode;
          windowStartLine = window.windowStartLine;
          windowEndLine = window.windowEndLine;
        } else if (codeLines.length <= 60) {
          // Small chunk — send in full
          codeForLLM = originalCode;
          windowStartLine = chunkStartLine;
          windowEndLine = chunkStartLine + codeLines.length - 1;
        } else {
          // Large chunk with no line numbers — take first 60 lines as best effort
          codeForLLM =
            codeLines.slice(0, 60).join("\n") +
            "\n// ... (remaining code omitted for brevity)";
          windowStartLine = chunkStartLine;
          windowEndLine = chunkStartLine + 59;
        }

        const response = await llmFn(
          [
            {
              role: "system",
              content:
                `You are a senior ${language} developer performing a surgical code fix.\n\n` +
                "RULES:\n" +
                "1. You are given ONLY the vulnerable code window (~10-30 lines), NOT the full file.\n" +
                "2. Fix ONLY the specific issue described. Do NOT restructure or rewrite unrelated code.\n" +
                "3. Your output MUST be a drop-in replacement for the window — same indentation, same structure.\n" +
                "4. Return ONLY the fixed code in a single code block, then a 1-2 sentence summary.\n" +
                "5. If the fix requires a new import, add a comment at the top: `// REQUIRES IMPORT: <import statement>`.\n" +
                "6. Preserve all existing functionality that isn't part of the vulnerability.",
            },
            {
              role: "user",
              content:
                `## Issue (lines ${vulnStartLine || "?"}–${vulnEndLine || "?"} of original file)\n${findingDescription}\n\n` +
                `## Code Window (lines ${windowStartLine}–${windowEndLine})\n\`\`\`${language}\n${codeForLLM}\n\`\`\`\n\n` +
                "Provide the fixed code window and a brief summary of changes.",
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
          window: {
            startLine: windowStartLine,
            endLine: windowEndLine,
            linesInWindow: codeForLLM.split("\n").length,
          },
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

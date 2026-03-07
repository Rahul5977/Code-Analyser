// src/council/tools/synthesis.tools.ts
//
// Synthesis Agent Tools:
//   1. generate_fixed_code_snippet — LLM-powered code fix with hard size guardrails
//   2. fetch_documentation_reference — curated docs index lookup
//
// Fix Strategy (strictly enforced BEFORE any LLM call):
//   • >100 lines             → ALWAYS bypass, chunk too large for any auto-fix
//   • >50 lines + complexity → bypass, architectural refactor stub returned
//   • ≤30 lines + line nums  → windowed diff (narrow ±5 line extract)
//   • everything else ≤100   → bounded rewrite (capped at 60 lines to LLM)
//
// The LLM is forced to use <fixed_code>…</fixed_code> XML tags for output.
// A 3-tier parser extracts the fix (XML → fenced code block → raw content).
// We NEVER return [] or empty — worst case returns a human-readable stub.

import type {
  AgentTool,
  LLMCompletionFn,
} from "../../interfaces/council.interface";

const WINDOWED_DIFF_LINE_THRESHOLD = 30;
const MAX_LLM_LINES = 60;
const WINDOW_BUFFER = 5;

export function extractWindow(
  code: string,
  chunkStart: number,
  vulnStart: number,
  vulnEnd: number,
  buffer: number = WINDOW_BUFFER,
): { windowCode: string; windowStartLine: number; windowEndLine: number } {
  const lines = code.split("\n");
  const totalLines = lines.length;

  const localVulnStart = Math.max(0, vulnStart - chunkStart);
  const localVulnEnd = Math.min(totalLines - 1, vulnEnd - chunkStart);
  const windowLocalStart = Math.max(0, localVulnStart - buffer);
  const windowLocalEnd = Math.min(totalLines - 1, localVulnEnd + buffer);

  const windowCode = lines
    .slice(windowLocalStart, windowLocalEnd + 1)
    .join("\n");
  const windowStartLine = chunkStart + windowLocalStart;
  const windowEndLine = chunkStart + windowLocalEnd;

  return { windowCode, windowStartLine, windowEndLine };
}

function generateArchitecturalStub(
  lineCount: number,
  description: string,
  category: string,
): string {
  const hints: string[] = [];

  if (/complex/i.test(category) || /complex/i.test(description)) {
    hints.push(
      "Extract each branch of complex switch/if-else chains into named handler functions.",
      "Use a strategy map (Record<string, Handler>) instead of long switch statements.",
      "Split data-fetching logic into a custom hook (e.g., useListingData).",
    );
  }
  if (/callback/i.test(category) || /nesting/i.test(description)) {
    hints.push(
      "Replace nested callbacks with async/await.",
      "Extract each nesting level into a named function with a clear responsibility.",
    );
  }
  if (/god/i.test(category) || /long/i.test(category)) {
    hints.push(
      "Apply the Single Responsibility Principle — each function should do one thing.",
      "Extract reusable logic into separate modules/hooks.",
      "Use composition (smaller components/functions) instead of one monolithic block.",
    );
  }
  if (/render/i.test(category) || /react/i.test(description)) {
    hints.push(
      "Wrap child components with React.memo() to prevent unnecessary re-renders.",
      "Move inline object/function creation out of JSX props (use useMemo/useCallback).",
      "Extract complex rendering logic into dedicated sub-components.",
    );
  }

  if (hints.length === 0) {
    hints.push(
      "Break this function into smaller, single-responsibility functions.",
      "Extract reusable logic into utility modules.",
      "Add unit tests for each extracted function before refactoring.",
    );
  }

  const ccMatch = description.match(/complexity\s*(?:of|:)\s*(\d+)/i);
  const ccLine = ccMatch ? `// Cyclomatic Complexity: ${ccMatch[1]}\n` : "";

  return (
    `// ⚠️ ARCHITECTURAL REFACTOR REQUIRED\n` +
    `//\n` +
    `// This function (${lineCount} lines) is too complex to safely auto-fix.\n` +
    `// Category: ${category || "structural-issue"}\n` +
    ccLine +
    `// ${description.slice(0, 200)}${description.length > 200 ? "…" : ""}\n` +
    `//\n` +
    `// ── Recommended Actions ──────────────────────────────────────\n` +
    hints.map((h) => `// • ${h}`).join("\n") +
    `\n//\n` +
    `// ── How to approach this refactor ────────────────────────────\n` +
    `// a) Write characterisation tests for the current behaviour FIRST.\n` +
    `// b) Extract one small function at a time, re-run tests after each.\n` +
    `// c) Use IDE "Extract Function" refactoring to maintain correctness.\n` +
    `// d) Target: no single function should exceed 50 lines or CC > 10.`
  );
}

function parseFixedCodeFromLLMResponse(content: string): {
  fixedCode: string;
  changeSummary: string;
} {
  const xmlMatch = content.match(/<fixed_code>([\s\S]*?)<\/fixed_code>/i);
  if (xmlMatch?.[1]?.trim()) {
    const fixedCode = xmlMatch[1].trim();
    const summary = content
      .replace(/<fixed_code>[\s\S]*?<\/fixed_code>/i, "")
      .trim();
    return {
      fixedCode,
      changeSummary:
        summary || "Code has been updated to address the described issue.",
    };
  }

  const codeBlockMatch = content.match(/```[\w]*\n([\s\S]*?)```/);
  if (codeBlockMatch?.[1]?.trim()) {
    const fixedCode = codeBlockMatch[1].trim();
    const afterBlock = content
      .slice(content.indexOf("```", (codeBlockMatch.index ?? 0) + 3) + 3)
      .trim();
    return {
      fixedCode,
      changeSummary:
        afterBlock || "Code has been updated to address the described issue.",
    };
  }

  const trimmed = content.trim();
  if (trimmed.length > 0 && trimmed !== "[]") {
    return {
      fixedCode: trimmed,
      changeSummary: "Fix extracted from raw LLM response (no tags detected).",
    };
  }

  return {
    fixedCode:
      "// ⚠️ LLM returned an empty response. Please fix this issue manually.",
    changeSummary: "LLM failed to generate a fix.",
  };
}

export function createGenerateFixedCodeSnippetTool(
  llmFn: LLMCompletionFn,
): AgentTool {
  return {
    name: "generate_fixed_code_snippet",
    description:
      "Generates a corrected version of flagged code. Provide the " +
      "vulnerability's exact startLine and endLine so the tool can apply " +
      "the correct fix strategy. Returns fixed code for the diff viewer.",
    parameters: {
      type: "object",
      properties: {
        originalCode: {
          type: "string",
          description: "The full chunk source code.",
        },
        findingDescription: {
          type: "string",
          description: "Description of the issue.",
        },
        findingCategory: {
          type: "string",
          description: "The finding's category slug.",
        },
        chunkStartLine: {
          type: "number",
          description: "1-based start line of the chunk in the original file.",
        },
        vulnStartLine: {
          type: "number",
          description: "1-based start line of the vulnerability.",
        },
        vulnEndLine: {
          type: "number",
          description: "1-based end line of the vulnerability.",
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
      const findingCategory = (
        (args["findingCategory"] as string) ?? ""
      ).toLowerCase();
      const language = (args["language"] as string) ?? "typescript";
      const chunkStartLine = (args["chunkStartLine"] as number) ?? 1;
      const vulnStartLine = (args["vulnStartLine"] as number) ?? 0;
      const vulnEndLine = (args["vulnEndLine"] as number) ?? 0;

      if (!originalCode || !findingDescription) {
        return JSON.stringify({
          error: "originalCode and findingDescription are required",
        });
      }

      const lineCount = originalCode.split("\n").length;
      const descLower = findingDescription.toLowerCase();
      const catLower = findingCategory;

      const isComplexityIssue =
        descLower.includes("complexity") ||
        descLower.includes("large") ||
        descLower.includes("too many") ||
        descLower.includes("god class") ||
        descLower.includes("god module") ||
        descLower.includes("callback hell") ||
        descLower.includes("deep nesting") ||
        catLower.includes("complex") ||
        catLower.includes("god") ||
        catLower.includes("long") ||
        catLower.includes("nesting") ||
        catLower.includes("callback") ||
        catLower.includes("spaghetti") ||
        catLower.includes("render-thrashing");

      if (lineCount > 100) {
        const stub =
          `// ⚠️ CHUNK TOO LARGE FOR AUTO-FIX (${lineCount} lines)\n` +
          `// This file exceeds the safe threshold for automated refactoring.\n` +
          `// Please review the finding: ${findingDescription.slice(0, 200)}\n` +
          `// Recommended: Break this component into smaller modules.`;

        return JSON.stringify({
          fixedCode: stub,
          changeSummary: `Chunk is ${lineCount} lines — too large to auto-fix safely.`,
          language,
          strategy: "hard-bypass-too-large",
          window: {
            startLine: vulnStartLine || chunkStartLine,
            endLine: vulnEndLine || chunkStartLine + lineCount - 1,
            linesInWindow: lineCount,
          },
        });
      }

      if (lineCount > 50 && isComplexityIssue) {
        const stub = generateArchitecturalStub(
          lineCount,
          findingDescription,
          findingCategory,
        );

        return JSON.stringify({
          fixedCode: stub,
          changeSummary:
            `Architectural refactor stub generated (${lineCount}-line chunk, ` +
            `${findingCategory || "structural"} issue). Auto-fix bypassed.`,
          language,
          strategy: "architectural-warning",
          window: {
            startLine: vulnStartLine || chunkStartLine,
            endLine: vulnEndLine || chunkStartLine + lineCount - 1,
            linesInWindow: lineCount,
          },
        });
      }

      const vulnSpan =
        vulnStartLine > 0 && vulnEndLine > 0
          ? vulnEndLine - vulnStartLine + 1
          : lineCount;

      let codeForLLM: string;
      let windowStartLine: number;
      let windowEndLine: number;
      let strategy: string;

      if (
        vulnStartLine > 0 &&
        vulnEndLine > 0 &&
        vulnSpan <= WINDOWED_DIFF_LINE_THRESHOLD
      ) {
        const win = extractWindow(
          originalCode,
          chunkStartLine,
          vulnStartLine,
          vulnEndLine,
          WINDOW_BUFFER,
        );
        codeForLLM = win.windowCode;
        windowStartLine = win.windowStartLine;
        windowEndLine = win.windowEndLine;
        strategy = "windowed-diff";
      } else if (lineCount <= MAX_LLM_LINES) {
        codeForLLM = originalCode;
        windowStartLine = chunkStartLine;
        windowEndLine = chunkStartLine + lineCount - 1;
        strategy = "bounded-rewrite-full";
      } else {
        const codeLines = originalCode.split("\n");
        codeForLLM =
          codeLines.slice(0, MAX_LLM_LINES).join("\n") +
          "\n// ... (remaining code omitted — fix only the code above)";
        windowStartLine = chunkStartLine;
        windowEndLine = chunkStartLine + MAX_LLM_LINES - 1;
        strategy = "bounded-rewrite-truncated";
      }

      try {
        const response = await llmFn(
          [
            {
              role: "system",
              content:
                `You are a senior ${language} developer performing a surgical code fix.\n\n` +
                "OUTPUT FORMAT — YOU MUST FOLLOW THIS EXACTLY:\n" +
                "1. Wrap your fixed code inside XML tags: <fixed_code>…your code…</fixed_code>\n" +
                "2. After the closing tag, write a 1-2 sentence summary of what you changed.\n" +
                "3. Do NOT use markdown code blocks. Use ONLY the XML tags.\n" +
                "4. Do NOT output an empty array [] or empty string.\n\n" +
                "RULES:\n" +
                "1. You are given ONLY the vulnerable code window, NOT the full file.\n" +
                "2. Fix ONLY the specific issue described. Do NOT restructure unrelated code.\n" +
                "3. Your output MUST be a drop-in replacement for the window — same indentation.\n" +
                "4. If the fix needs a new import, add a comment: // REQUIRES IMPORT: <stmt>\n" +
                "5. Preserve all existing functionality that isn't part of the vulnerability.\n\n" +
                "EXAMPLE OUTPUT:\n" +
                "<fixed_code>\n" +
                "const result = await db.select('*').from('users').where({ email });\n" +
                "</fixed_code>\n" +
                "Replaced raw SQL concatenation with parameterised query builder.",
            },
            {
              role: "user",
              content:
                `## Issue (lines ${vulnStartLine || "?"}–${vulnEndLine || "?"} of original file)\n` +
                `${findingDescription}\n\n` +
                `## Code Window (lines ${windowStartLine}–${windowEndLine}, strategy: ${strategy})\n` +
                `<original_code>\n${codeForLLM}\n</original_code>\n\n` +
                "Produce the fixed code inside <fixed_code> tags, then a brief summary.",
            },
          ],
          undefined,
          0.2,
        );

        const { fixedCode, changeSummary } = parseFixedCodeFromLLMResponse(
          response.content,
        );

        return JSON.stringify({
          fixedCode,
          changeSummary,
          language,
          strategy,
          window: {
            startLine: windowStartLine,
            endLine: windowEndLine,
            linesInWindow: codeForLLM.split("\n").length,
          },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({
          fixedCode:
            `// ⚠️ Auto-fix generation failed: ${msg}\n` +
            "// Please review and fix this issue manually.\n" +
            `// Issue: ${findingDescription.slice(0, 200)}`,
          changeSummary: `Code fix generation failed: ${msg}`,
          language,
          strategy: "error-fallback",
          window: {
            startLine: windowStartLine!,
            endLine: windowEndLine!,
            linesInWindow: 0,
          },
        });
      }
    },
  };
}

export function createFetchDocumentationReferenceTool(): AgentTool {
  return {
    name: "fetch_documentation_reference",
    description:
      "Fetches authoritative documentation references for a given technology " +
      "and concept. Returns titles and URLs for inclusion in finding cards.",
    parameters: {
      type: "object",
      properties: {
        technology: {
          type: "string",
          description: "The technology area (e.g., 'node.js', 'react').",
        },
        conceptName: {
          type: "string",
          description: "The specific concept (e.g., 'sql-injection', 'xss').",
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

function lookupReferences(technology: string, concept: string): DocReference[] {
  const refs: DocReference[] = [];

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

  const seen = new Set<string>();
  return refs.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

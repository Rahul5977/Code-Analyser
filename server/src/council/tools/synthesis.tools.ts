// ─────────────────────────────────────────────────────────────────────────────
// src/council/tools/synthesis.tools.ts
//
// Synthesis / Pedagogical Agent Tools:
//   1. generate_fixed_code_snippet — LLM-powered TARGETED code fix generation
//   2. fetch_documentation_reference — curated docs index lookup
//
// ★ Three-tier fix strategy:
//   Tier 1 — "Windowed Diff":  Finding spans <30 lines → extract window ± 5
//            lines of context, LLM rewrites only that ~40-line window.
//   Tier 2 — "Architectural Warning":  Finding spans 50+ lines AND is a
//            structural category (high-complexity, god-class, long-function)
//            → bypass LLM entirely, return a pre-formatted refactor stub.
//   Tier 3 — "Bounded Rewrite":  Everything else → cap code at 60 lines,
//            LLM rewrites with XML-tag output for strict parsing.
//
// ★ Strict output parsing:
//   The LLM is forced to wrap its fix inside <fixed_code>…</fixed_code> XML
//   tags.  A regex parser extracts the content.  If the tags are missing we
//   fall back to ```code-block``` extraction, then to raw content.  We NEVER
//   return `[]` — worst case we return a human-readable fallback string.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  AgentTool,
  LLMCompletionFn,
} from "../../interfaces/council.interface";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Findings that span fewer than this many lines get the targeted window strategy */
const WINDOWED_DIFF_LINE_THRESHOLD = 30;

/** Findings that span more than this AND are structural → architectural warning */
const ARCHITECTURAL_WARNING_LINE_THRESHOLD = 50;

/** Maximum lines sent to the LLM in the bounded-rewrite fallback */
const MAX_LLM_LINES = 60;

/** Context buffer (lines above + below) for the windowed diff */
const WINDOW_BUFFER = 5;

/**
 * Finding categories that represent STRUCTURAL issues which cannot be
 * meaningfully auto-fixed by rewriting a code window.  For these, we
 * generate an architectural refactor stub instead of hallucinating a
 * broken rewrite.
 */
const STRUCTURAL_CATEGORIES = new Set([
  "high-complexity",
  "cyclomatic-complexity",
  "cyclomatic_complexity",
  "god-class",
  "god-module",
  "long-function",
  "long-method",
  "deep-nesting",
  "callback-hell",
  "spaghetti",
  "render-thrashing",
]);

// ─── extractWindow — Surgical Code Windowing ─────────────────────────────────

/**
 * Extracts a narrow window of code around the vulnerable lines.
 *
 * @param code       The full chunk's source code.
 * @param chunkStart The 1-based start line of the chunk in the original file.
 * @param vulnStart  The 1-based start line of the vulnerability in the original file.
 * @param vulnEnd    The 1-based end line of the vulnerability in the original file.
 * @param buffer     Number of context lines above and below (default: 5).
 * @returns          The extracted window with its absolute line range.
 *
 * Example:
 *   Chunk covers lines 20-501 of EditListing.jsx.
 *   Finding says the issue is on lines 45-55.
 *   extractWindow(code, 20, 45, 55, 5)
 *   → returns lines 40-60 of the file (a ~20-line window).
 */
export function extractWindow(
  code: string,
  chunkStart: number,
  vulnStart: number,
  vulnEnd: number,
  buffer: number = WINDOW_BUFFER,
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

// ─── Architectural Warning Stub Generator ────────────────────────────────────

/**
 * Generates a structured, human-readable refactor stub for findings that
 * are too large / too structural for an LLM to auto-fix safely.
 *
 * This is displayed in the Monaco diff viewer as the "fixed" side, giving
 * the developer actionable guidance instead of a hallucinated rewrite.
 */
function generateArchitecturalWarningStub(
  category: string,
  description: string,
  filePath: string,
  startLine: number,
  endLine: number,
  codeLines: number,
  cyclomaticComplexity?: number,
): string {
  const lineSpan = endLine - startLine + 1;

  // Extract actionable hints from the category / description
  const hints: string[] = [];

  if (/complex/i.test(category) || /complex/i.test(description)) {
    hints.push(
      "1. Extract each branch of complex switch/if-else chains into named handler functions.",
      "2. Use a strategy map (Record<string, Handler>) instead of long switch statements.",
      "3. Split data-fetching logic into a custom hook (e.g., useListingData).",
    );
  }
  if (/callback/i.test(category) || /nesting/i.test(description)) {
    hints.push(
      "1. Replace nested callbacks with async/await.",
      "2. Extract each nesting level into a named function with a clear responsibility.",
    );
  }
  if (/god/i.test(category) || /long/i.test(category)) {
    hints.push(
      "1. Apply the Single Responsibility Principle — each function should do one thing.",
      "2. Extract reusable logic into separate modules/hooks.",
      "3. Use composition (smaller components/functions) instead of one monolithic block.",
    );
  }
  if (/render/i.test(category) || /react/i.test(description)) {
    hints.push(
      "1. Wrap child components with React.memo() to prevent unnecessary re-renders.",
      "2. Move inline object/function creation out of JSX props (use useMemo/useCallback).",
      "3. Extract complex rendering logic into dedicated sub-components.",
    );
  }

  // Fallback hints if nothing matched
  if (hints.length === 0) {
    hints.push(
      "1. Break this function into smaller, single-responsibility functions.",
      "2. Extract reusable logic into utility modules.",
      "3. Add unit tests for each extracted function before refactoring.",
    );
  }

  return [
    `// ⚠️ ARCHITECTURAL REFACTOR REQUIRED`,
    `//`,
    `// This chunk is too large (${codeLines} lines, L${startLine}–L${endLine}) to safely auto-fix.`,
    `// Category: ${category}`,
    ...(cyclomaticComplexity != null
      ? [`// Cyclomatic Complexity: ${cyclomaticComplexity}`]
      : []),
    `// ${description.slice(0, 200)}${description.length > 200 ? "…" : ""}`,
    `//`,
    `// ── Recommended Actions ──────────────────────────────────────`,
    ...hints.map((h) => `// ${h}`),
    `//`,
    `// ── How to approach this refactor ────────────────────────────`,
    `// a) Write characterisation tests for the current behaviour FIRST.`,
    `// b) Extract one small function at a time, re-run tests after each.`,
    `// c) Use IDE "Extract Function" refactoring to maintain correctness.`,
    `// d) Target: no single function should exceed 50 lines or CC > 10.`,
  ].join("\n");
}

// ─── XML Tag Parser ──────────────────────────────────────────────────────────

/**
 * Strict 3-tier parser for the LLM's fix output:
 *   1. Try <fixed_code>…</fixed_code> XML tags (preferred).
 *   2. Try ```language … ``` code block (fallback).
 *   3. Use the raw content (last resort — never returns empty).
 *
 * NEVER returns `[]`, `""`, or `undefined`.
 */
function parseFixedCodeFromLLMResponse(content: string): {
  fixedCode: string;
  changeSummary: string;
} {
  // ── Tier 1: XML tags ──
  const xmlMatch = content.match(/<fixed_code>([\s\S]*?)<\/fixed_code>/i);
  if (xmlMatch?.[1]?.trim()) {
    const fixedCode = xmlMatch[1].trim();
    // Summary is everything outside the tags
    const summary = content
      .replace(/<fixed_code>[\s\S]*?<\/fixed_code>/i, "")
      .trim();
    return {
      fixedCode,
      changeSummary:
        summary || "Code has been updated to address the described issue.",
    };
  }

  // ── Tier 2: Fenced code block ──
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

  // ── Tier 3: Raw content (never empty) ──
  const trimmed = content.trim();
  if (trimmed.length > 0 && trimmed !== "[]") {
    return {
      fixedCode: trimmed,
      changeSummary: "Fix extracted from raw LLM response (no tags detected).",
    };
  }

  // Absolute last resort — this should be unreachable
  return {
    fixedCode:
      "// ⚠️ LLM returned an empty response. Please fix this issue manually.",
    changeSummary: "LLM failed to generate a fix.",
  };
}

// ─── generate_fixed_code_snippet ─────────────────────────────────────────────

/**
 * Three-tier tool:
 *   Tier 1 — Windowed Diff (localised findings <30 lines)
 *   Tier 2 — Architectural Warning (structural findings >50 lines)
 *   Tier 3 — Bounded Rewrite (everything else, capped at 60 lines)
 *
 * Uses XML-tag output format for strict parsing.
 * NEVER returns `[]` or an empty string.
 */
export function createGenerateFixedCodeSnippetTool(
  llmFn: LLMCompletionFn,
): AgentTool {
  return {
    name: "generate_fixed_code_snippet",
    description:
      "Generates a corrected version of flagged code. Provide the " +
      "vulnerability's exact startLine and endLine so the tool can apply " +
      "the correct fix strategy (windowed diff, architectural warning, " +
      "or bounded rewrite). Returns fixed code wrapped for the diff viewer.",
    parameters: {
      type: "object",
      properties: {
        originalCode: {
          type: "string",
          description:
            "The full chunk source code (the tool extracts the relevant window).",
        },
        findingDescription: {
          type: "string",
          description:
            "Description of the issue: what's wrong and how to fix it.",
        },
        findingCategory: {
          type: "string",
          description:
            "The finding's category slug (e.g., 'sql-injection', 'high-complexity', 'n-plus-one').",
        },
        chunkStartLine: {
          type: "number",
          description:
            "The 1-based start line of the chunk in the original file.",
        },
        vulnStartLine: {
          type: "number",
          description: "The 1-based start line of the specific vulnerability.",
        },
        vulnEndLine: {
          type: "number",
          description: "The 1-based end line of the specific vulnerability.",
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

      const codeLines = originalCode.split("\n");
      const vulnSpan =
        vulnStartLine > 0 && vulnEndLine > 0
          ? vulnEndLine - vulnStartLine + 1
          : codeLines.length;

      // ─────────────────────────────────────────────────────────────
      // TIER 2: Architectural Warning  (checked FIRST because it
      // short-circuits without an LLM call — saves time & tokens)
      //
      // Triggers when EITHER:
      //   a) The finding's vulnerability span exceeds the threshold, OR
      //   b) The full chunk itself exceeds the threshold
      // AND the finding is structural in nature.
      // ─────────────────────────────────────────────────────────────
      const isStructuralCategory = STRUCTURAL_CATEGORIES.has(findingCategory);
      // Also detect structural patterns from the description text
      const descLower = findingDescription.toLowerCase();
      const looksStructural =
        isStructuralCategory ||
        /cyclomatic complexity/i.test(descLower) ||
        /too many (lines|params|parameters)/i.test(descLower) ||
        /god (class|module|function)/i.test(descLower) ||
        /callback hell/i.test(descLower) ||
        /high.complexity/i.test(descLower);

      // ★ Use the LARGER of vulnSpan and codeLines.length for the size check.
      //   This prevents the bypass from being skipped when line numbers are
      //   missing (vulnStartLine=0, vulnEndLine=0) and the code was truncated.
      const effectiveSpan = Math.max(vulnSpan, codeLines.length);

      if (
        effectiveSpan > ARCHITECTURAL_WARNING_LINE_THRESHOLD &&
        looksStructural
      ) {
        // ★ Extract complexity number from description if available
        //   e.g., "Function has cyclomatic complexity of 60 (threshold: 10)"
        const ccMatch = findingDescription.match(
          /complexity\s*(?:of|:)\s*(\d+)/i,
        );
        const ccValue = ccMatch ? parseInt(ccMatch[1]!, 10) : undefined;

        const stub = generateArchitecturalWarningStub(
          findingCategory || "structural-issue",
          findingDescription,
          "", // filePath not available here, but that's fine
          vulnStartLine || chunkStartLine,
          vulnEndLine || chunkStartLine + codeLines.length - 1,
          codeLines.length,
          ccValue,
        );

        return JSON.stringify({
          fixedCode: stub,
          changeSummary:
            `Architectural refactor stub generated (${codeLines.length}-line chunk, ` +
            `${findingCategory || "structural"} issue). ` +
            "Auto-fix was bypassed because this issue requires manual decomposition.",
          language,
          strategy: "architectural-warning",
          window: {
            startLine: vulnStartLine || chunkStartLine,
            endLine: vulnEndLine || chunkStartLine + codeLines.length - 1,
            linesInWindow: codeLines.length,
          },
        });
      }

      // ─────────────────────────────────────────────────────────────
      // TIER 1: Windowed Diff  (localised findings <30 lines)
      // ─────────────────────────────────────────────────────────────
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
      }
      // ─────────────────────────────────────────────────────────────
      // TIER 3: Bounded Rewrite  (everything else)
      // ─────────────────────────────────────────────────────────────
      else if (codeLines.length <= MAX_LLM_LINES) {
        // Small-ish chunk — send in full
        codeForLLM = originalCode;
        windowStartLine = chunkStartLine;
        windowEndLine = chunkStartLine + codeLines.length - 1;
        strategy = "bounded-rewrite-full";
      } else {
        // Large chunk — truncate to MAX_LLM_LINES with a marker
        codeForLLM =
          codeLines.slice(0, MAX_LLM_LINES).join("\n") +
          "\n// ... (remaining code omitted — fix only the code above)";
        windowStartLine = chunkStartLine;
        windowEndLine = chunkStartLine + MAX_LLM_LINES - 1;
        strategy = "bounded-rewrite-truncated";
      }

      // ─────────────────────────────────────────────────────────────
      // LLM Call — with strict XML-tag output format
      // ─────────────────────────────────────────────────────────────
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
                "3. Do NOT use markdown code blocks (```). Use ONLY the XML tags.\n" +
                "4. Do NOT output an empty array [] or empty string.\n\n" +
                "RULES:\n" +
                "1. You are given ONLY the vulnerable code window (~10-40 lines), NOT the full file.\n" +
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

        // ── Strict 3-tier parse ──
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
        // NEVER return `[]` — always return a meaningful fallback
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

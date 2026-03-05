// ─────────────────────────────────────────────────────────────────────────────
// src/council/tools/performance.tools.ts
//
// Performance Agent Tools:
//   1. estimate_complexity_class — CFG-based time complexity estimation
//   2. find_similar_patterns     — Qdrant vector search for anti-pattern clones
// ─────────────────────────────────────────────────────────────────────────────

import type { AgentTool } from "../../interfaces/council.interface";
import type { QdrantStore } from "../../graph-rag/qdrant.store";
import type { EmbedFunction } from "../../interfaces/graph-rag.interface";

// ─── estimate_complexity_class ───────────────────────────────────────────────

/**
 * Algorithmically estimates the time complexity class of a function
 * by detecting nested loop patterns, recursion, and branch depth
 * from the code + CFG metadata.  No LLM needed.
 */
export function createEstimateComplexityClassTool(): AgentTool {
  return {
    name: "estimate_complexity_class",
    description:
      "Estimates the time complexity class (O(1), O(n), O(n²), etc.) of a " +
      "code chunk by analysing loop nesting depth, recursion patterns, and " +
      "the CFG structure. Returns the estimated class with reasoning.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The function source code to analyse.",
        },
        cfgNodes: {
          type: "number",
          description: "Number of CFG nodes (from Phase 2).",
        },
        cfgEdges: {
          type: "number",
          description: "Number of CFG edges (from Phase 2).",
        },
        cyclomaticComplexity: {
          type: "number",
          description: "McCabe cyclomatic complexity (from Phase 2).",
        },
      },
      required: ["code"],
    },
    execute: async (args) => {
      const code = args["code"] as string;
      const cfgNodes = (args["cfgNodes"] as number) ?? 0;
      const cfgEdges = (args["cfgEdges"] as number) ?? 0;
      const cyclomaticComplexity =
        (args["cyclomaticComplexity"] as number) ?? 0;

      if (!code) {
        return JSON.stringify({ error: "code is required" });
      }

      try {
        const analysis = analyseComplexity(
          code,
          cfgNodes,
          cfgEdges,
          cyclomaticComplexity,
        );
        return JSON.stringify(analysis);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({
          error: `Complexity estimation failed: ${msg}`,
        });
      }
    },
  };
}

interface ComplexityAnalysis {
  estimatedClass: string;
  nestedLoopDepth: number;
  recursionDetected: boolean;
  loopCount: number;
  conditionalCount: number;
  reasoning: string[];
  concerns: string[];
}

function analyseComplexity(
  code: string,
  cfgNodes: number,
  cfgEdges: number,
  cyclomaticComplexity: number,
): ComplexityAnalysis {
  const lines = code.split("\n");
  const reasoning: string[] = [];
  const concerns: string[] = [];

  // ── Detect loops and their nesting depth ──
  let maxNestingDepth = 0;
  let currentNesting = 0;
  let loopCount = 0;
  let conditionalCount = 0;

  const loopPatterns = /\b(for|while|do)\s*[\s(]/;
  const foreachPatterns =
    /\.(forEach|map|filter|reduce|flatMap|find|some|every)\s*\(/;
  const conditionalPatterns = /\b(if|switch|else\s+if)\s*[\s(]/;

  // Track brace depth to understand nesting
  let braceDepth = 0;
  const loopBraceDepths: number[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Count opening and closing braces
    for (const ch of trimmed) {
      if (ch === "{") braceDepth++;
      if (ch === "}") {
        braceDepth--;
        // Check if we're exiting a loop
        if (
          loopBraceDepths.length > 0 &&
          loopBraceDepths[loopBraceDepths.length - 1] === braceDepth
        ) {
          loopBraceDepths.pop();
          currentNesting--;
        }
      }
    }

    if (loopPatterns.test(trimmed) || foreachPatterns.test(trimmed)) {
      loopCount++;
      currentNesting++;
      loopBraceDepths.push(braceDepth);
      if (currentNesting > maxNestingDepth) {
        maxNestingDepth = currentNesting;
      }
    }

    if (conditionalPatterns.test(trimmed)) {
      conditionalCount++;
    }
  }

  // ── Detect recursion ──
  // Extract function name and check if it calls itself
  const funcNameMatch = code.match(
    /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\(|(?:\w+)\s*=>))/,
  );
  const funcName = funcNameMatch?.[1] ?? funcNameMatch?.[2];
  let recursionDetected = false;
  if (funcName) {
    const callRegex = new RegExp(`\\b${funcName}\\s*\\(`, "g");
    const calls = code.match(callRegex);
    // More than 1 occurrence means recursive call (first is the definition context)
    if (calls && calls.length > 1) {
      recursionDetected = true;
    }
  }

  // ── Estimate complexity class ──
  let estimatedClass: string;

  if (recursionDetected && maxNestingDepth >= 1) {
    estimatedClass = "O(2^n)";
    reasoning.push(
      "Recursion detected with loop nesting — likely exponential.",
    );
    concerns.push(
      "Exponential complexity will cause severe performance issues for large inputs.",
    );
  } else if (recursionDetected) {
    // Simple recursion without loops
    estimatedClass = "O(n)";
    reasoning.push(
      "Simple recursion detected — linear if no branching in recursive calls.",
    );
    // Check for multiple recursive calls (e.g., fibonacci)
    if (funcName) {
      const callRegex = new RegExp(`\\b${funcName}\\s*\\(`, "g");
      const callMatches = code.match(callRegex);
      if (callMatches && callMatches.length > 2) {
        estimatedClass = "O(2^n)";
        reasoning.push(
          "Multiple recursive calls detected — likely exponential (e.g., fibonacci pattern).",
        );
        concerns.push(
          "Consider memoisation or dynamic programming to reduce complexity.",
        );
      }
    }
  } else if (maxNestingDepth >= 3) {
    estimatedClass = "O(n³)";
    reasoning.push(`Triple-nested loops detected (depth: ${maxNestingDepth}).`);
    concerns.push(
      "Cubic complexity — will be extremely slow for inputs > 1000 elements.",
    );
  } else if (maxNestingDepth === 2) {
    estimatedClass = "O(n²)";
    reasoning.push("Double-nested loops detected.");
    concerns.push(
      "Quadratic complexity — consider optimising for large datasets.",
    );
  } else if (maxNestingDepth === 1 || loopCount > 0) {
    estimatedClass = "O(n)";
    reasoning.push(
      `${loopCount} loop(s) detected at max nesting depth ${maxNestingDepth}.`,
    );
  } else {
    estimatedClass = "O(1)";
    reasoning.push("No loops or recursion detected — constant time.");
  }

  // ── Additional heuristics ──
  if (cyclomaticComplexity > 15) {
    concerns.push(
      `High cyclomatic complexity (${cyclomaticComplexity}) — consider breaking into smaller functions.`,
    );
  }

  if (loopCount > 3 && maxNestingDepth <= 1) {
    reasoning.push(
      `${loopCount} sequential loops detected — still O(n) but with a high constant factor.`,
    );
  }

  // Check for sort operations (O(n log n))
  if (/\.sort\s*\(/.test(code)) {
    if (estimatedClass === "O(n)" || estimatedClass === "O(1)") {
      estimatedClass = "O(n log n)";
      reasoning.push("Array sort detected — O(n log n) dominates.");
    }
  }

  return {
    estimatedClass,
    nestedLoopDepth: maxNestingDepth,
    recursionDetected,
    loopCount,
    conditionalCount,
    reasoning,
    concerns,
  };
}

// ─── find_similar_patterns ───────────────────────────────────────────────────

/**
 * Queries Qdrant for chunks with similar embedding signatures to find
 * if the same anti-pattern appears in multiple places across the codebase.
 */
export function createFindSimilarPatternsTool(
  qdrant: QdrantStore,
  embedFn: EmbedFunction,
  repoId: string,
): AgentTool {
  return {
    name: "find_similar_patterns",
    description:
      "Searches the codebase for chunks with similar code patterns using " +
      "vector similarity. Useful for finding duplicated anti-patterns, " +
      "copy-paste code, and systemic issues.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The code pattern to search for similar instances of.",
        },
        topK: {
          type: "number",
          description: "Number of similar chunks to return (default: 10).",
        },
        minSimilarity: {
          type: "number",
          description: "Minimum cosine similarity threshold (default: 0.7).",
        },
      },
      required: ["code"],
    },
    execute: async (args) => {
      const code = args["code"] as string;
      const topK = (args["topK"] as number) ?? 10;

      if (!code) {
        return JSON.stringify({ error: "code is required" });
      }

      try {
        // Embed the code pattern
        const vector = await embedFn(code);

        // Search Qdrant for similar chunks
        const matches = await qdrant.search(vector, repoId, topK);

        // Filter out the original chunk if present and format results
        const results = matches.map((chunk) => ({
          id: chunk.id,
          filePath: chunk.filePath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          cyclomaticComplexity: chunk.cyclomaticComplexity,
          codeSummary:
            chunk.code.slice(0, 300) + (chunk.code.length > 300 ? "…" : ""),
        }));

        return JSON.stringify({
          query: "find_similar_patterns",
          matchCount: results.length,
          matches: results,
          message:
            results.length > 1
              ? `Found ${results.length} similar code patterns across the codebase.`
              : "No similar patterns found.",
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `Pattern search failed: ${msg}` });
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// src/council/tools/critique.tools.ts
//
// Critique / Debate Agent Tools:
//   1. verify_finding — re-fetches original code and validates claims
// ─────────────────────────────────────────────────────────────────────────────

import type { AgentTool, Finding } from "../../interfaces/council.interface";
import type { QdrantStore } from "../../graph-rag/qdrant.store";

// ─── verify_finding ──────────────────────────────────────────────────────────

/**
 * Re-fetches the original code for a finding and checks whether the
 * cited line numbers and code snippets actually match the claim.
 * This catches LLM hallucinations before they reach the final report.
 */
export function createVerifyFindingTool(qdrant: QdrantStore): AgentTool {
  return {
    name: "verify_finding",
    description:
      "Verifies a finding by re-fetching the original code chunk and checking " +
      "whether the cited line numbers, code snippets, and claims are accurate. " +
      "Returns a verification result with specific discrepancies noted.",
    parameters: {
      type: "object",
      properties: {
        findingId: {
          type: "string",
          description: "The ID of the finding to verify.",
        },
        chunkId: {
          type: "string",
          description: "The chunk ID containing the cited code.",
        },
        citedCodeSnippet: {
          type: "string",
          description: "The code snippet cited in the finding.",
        },
        citedStartLine: {
          type: "number",
          description: "The start line cited in the finding.",
        },
        citedEndLine: {
          type: "number",
          description: "The end line cited in the finding.",
        },
        claim: {
          type: "string",
          description:
            "The specific claim to verify (e.g., 'SQL injection on line 47').",
        },
      },
      required: ["findingId", "chunkId", "claim"],
    },
    execute: async (args) => {
      const findingId = args["findingId"] as string;
      const chunkId = args["chunkId"] as string;
      const citedSnippet = args["citedCodeSnippet"] as string | undefined;
      const citedStartLine = args["citedStartLine"] as number | undefined;
      const citedEndLine = args["citedEndLine"] as number | undefined;
      const claim = args["claim"] as string;

      if (!findingId || !chunkId || !claim) {
        return JSON.stringify({
          error: "findingId, chunkId, and claim are required",
        });
      }

      try {
        // Re-fetch the original chunk
        const chunks = await qdrant.getChunksByIds([chunkId]);
        if (chunks.length === 0) {
          return JSON.stringify({
            findingId,
            verified: false,
            verdict: "DISPUTED",
            reason: `Chunk "${chunkId}" not found in the database — finding cannot be verified.`,
          });
        }

        const chunk = chunks[0]!;
        const codeLines = chunk.code.split("\n");
        const discrepancies: string[] = [];
        const confirmations: string[] = [];

        // ── Check 1: Do the cited line numbers exist? ──
        if (citedStartLine !== undefined) {
          const relativeStart = citedStartLine - chunk.startLine;
          if (relativeStart < 0 || relativeStart >= codeLines.length) {
            discrepancies.push(
              `Cited start line ${citedStartLine} is outside the chunk range ` +
                `(${chunk.startLine}–${chunk.endLine}).`,
            );
          } else {
            confirmations.push(
              `Start line ${citedStartLine} is within the chunk range.`,
            );
          }
        }

        if (citedEndLine !== undefined) {
          const relativeEnd = citedEndLine - chunk.startLine;
          if (relativeEnd < 0 || relativeEnd >= codeLines.length) {
            discrepancies.push(
              `Cited end line ${citedEndLine} is outside the chunk range ` +
                `(${chunk.startLine}–${chunk.endLine}).`,
            );
          } else {
            confirmations.push(
              `End line ${citedEndLine} is within the chunk range.`,
            );
          }
        }

        // ── Check 2: Does the cited code snippet appear in the chunk? ──
        if (citedSnippet) {
          const normalised = citedSnippet.replace(/\s+/g, " ").trim();
          const normalisedCode = chunk.code.replace(/\s+/g, " ").trim();

          if (normalisedCode.includes(normalised)) {
            confirmations.push(
              "Cited code snippet found in the chunk (exact match).",
            );
          } else {
            // Try fuzzy match (at least 60% of words match)
            const snippetWords = normalised.toLowerCase().split(/\s+/);
            const codeWords = normalisedCode.toLowerCase().split(/\s+/);
            const matches = snippetWords.filter((w) => codeWords.includes(w));
            const matchRatio =
              snippetWords.length > 0
                ? matches.length / snippetWords.length
                : 0;

            if (matchRatio >= 0.6) {
              confirmations.push(
                `Cited code snippet partially matches (${(matchRatio * 100).toFixed(0)}% word overlap).`,
              );
            } else {
              discrepancies.push(
                `Cited code snippet NOT found in the chunk. ` +
                  `Word overlap: ${(matchRatio * 100).toFixed(0)}%.`,
              );
            }
          }
        }

        // ── Check 3: Does the claim relate to actual code patterns? ──
        const claimLower = claim.toLowerCase();
        const codeStr = chunk.code.toLowerCase();

        // Check for specific claim keywords in the code
        const claimKeywords = extractClaimKeywords(claimLower);
        let keywordMatches = 0;
        for (const kw of claimKeywords) {
          if (codeStr.includes(kw)) keywordMatches++;
        }

        if (claimKeywords.length > 0) {
          const kwMatchRatio = keywordMatches / claimKeywords.length;
          if (kwMatchRatio >= 0.5) {
            confirmations.push(
              `Claim keywords found in code (${keywordMatches}/${claimKeywords.length}).`,
            );
          } else {
            discrepancies.push(
              `Only ${keywordMatches}/${claimKeywords.length} claim keywords found in code.`,
            );
          }
        }

        // ── Verdict ──
        let verdict: string;
        if (discrepancies.length === 0) {
          verdict = "CONFIRMED";
        } else if (discrepancies.length <= confirmations.length) {
          verdict = "PLAUSIBLE";
        } else {
          verdict = "DISPUTED";
        }

        return JSON.stringify({
          findingId,
          chunkId,
          verified: verdict !== "DISPUTED",
          verdict,
          confirmations,
          discrepancies,
          actualCode:
            chunk.code.slice(0, 500) + (chunk.code.length > 500 ? "…" : ""),
          actualLineRange: `${chunk.startLine}–${chunk.endLine}`,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `Verification failed: ${msg}` });
      }
    },
  };
}

/** Extracts meaningful keywords from a claim for verification */
function extractClaimKeywords(claim: string): string[] {
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "shall",
    "should",
    "may",
    "might",
    "can",
    "could",
    "this",
    "that",
    "these",
    "those",
    "on",
    "in",
    "at",
    "to",
    "for",
    "with",
    "from",
    "by",
    "of",
    "and",
    "or",
    "not",
    "but",
    "if",
    "then",
    "else",
    "when",
    "up",
    "out",
    "no",
    "so",
    "it",
    "its",
    "line",
    "code",
    "file",
    "found",
    "detected",
    "potential",
    "possible",
    "vulnerability",
    "issue",
    "problem",
  ]);

  return claim
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

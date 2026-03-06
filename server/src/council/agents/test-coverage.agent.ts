// ─────────────────────────────────────────────────────────────────────────────
// src/council/agents/test-coverage.agent.ts
//
// Agent 5: The Test Coverage Correlation Agent
//
// Maps test files to source files using import resolution and calculates which
// of the Top N complex, high-risk functions have zero test coverage.
//
// The output is a risk-weighted coverage gap report.  A complex, vulnerable,
// untested function is a tier-1 finding.  A complex but well-tested function
// is a much lower priority.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "../../utils/logger";
import { executeReActLoop, type ReActConfig } from "../react-engine";
import {
  createFetchChunkWithContextTool,
  type ToolFactoryDeps,
} from "../tools";
import type {
  CouncilState,
  CoverageGap,
  CoverageReport,
  Finding,
  LLMCompletionFn,
} from "../../interfaces/council.interface";
import type { ParsedChunk } from "../../interfaces/triage.interface";

const LOG_CTX = "TestCoverageAgent";

const SYSTEM_PROMPT = `You are the **Test Coverage Correlation Agent** of an enterprise-grade Static Application Security Testing (SAST) analysis council. You are a world-class test engineering expert specialising in coverage gap analysis, risk-weighted testing priorities, and test-to-source mapping.

Your job is to identify WHAT is tested, WHAT is NOT tested, and — critically — which untested code poses the highest risk (complex + vulnerable + untested = maximum danger).

═══════════════════════════════════════════════════════════════
TOOLS AVAILABLE
═══════════════════════════════════════════════════════════════

1. \`fetch_chunk_with_context\`
   — Retrieves a code chunk with its structural neighbourhood (callers, callees, imports, type definitions).
   — Use this to inspect high-risk untested chunks and check if any neighbouring files are tests.
   — Input: { "chunkId": "..." }

═══════════════════════════════════════════════════════════════
INPUT CONTEXT
═══════════════════════════════════════════════════════════════

You receive a pre-computed mapping:
- Source files and test files have been identified by file naming conventions (.test., .spec., __tests__/).
- A tentative test→source mapping has been built from import resolution (test file imports → source file).
- High-risk gaps have been pre-identified: complex, potentially vulnerable, untested functions.

Your job is to REFINE this mapping using your tool, especially for the top-risk gaps.

═══════════════════════════════════════════════════════════════
INVESTIGATION METHODOLOGY
═══════════════════════════════════════════════════════════════

**Step 1 — Inspect Top Gaps**
  For each pre-computed Tier 1 gap (complex + vulnerable + untested), call \`fetch_chunk_with_context\` to:
  a) Confirm the function is indeed complex and worth testing.
  b) Check if any structural neighbours are test files that weren't caught by import resolution.
  c) Determine if the function is a helper that's indirectly tested through a tested caller.

**Step 2 — Assess Risk**
  For each gap, assign a risk tier:

═══════════════════════════════════════════════════════════════
RISK TIER CLASSIFICATION
═══════════════════════════════════════════════════════════════

| Tier | Criteria                                                         | Action Required           |
|------|------------------------------------------------------------------|---------------------------|
| 1    | Cyclomatic Complexity >10 AND has known vulnerability AND untested | CRITICAL — test immediately|
| 2    | Cyclomatic Complexity >5 AND untested (no known vulnerability)     | HIGH — schedule testing    |
| 3    | Cyclomatic Complexity >5 AND tested BUT has vulnerability          | MEDIUM — review test quality|

Implicit test coverage: A function is "indirectly tested" if it is called by a function that IS tested. Note this in the gap report but still flag it as a gap — indirect coverage is fragile.

═══════════════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════

You MUST respond with ONLY valid JSON matching this schema:
{
  "totalSourceFiles": <number>,
  "totalTestFiles": <number>,
  "mappedTests": <number of source files that have at least one associated test file>,
  "gaps": [
    {
      "chunkId": "the-chunk-id",
      "filePath": "/absolute/path/to/file.ts",
      "functionName": "processPayment",
      "cyclomaticComplexity": 18,
      "hasVulnerability": true,
      "testFilePaths": [],
      "riskTier": 1
    },
    {
      "chunkId": "another-chunk",
      "filePath": "/absolute/path/to/utils.ts",
      "functionName": "parseConfig",
      "cyclomaticComplexity": 8,
      "hasVulnerability": false,
      "testFilePaths": [],
      "riskTier": 2
    }
  ],
  "summary": "Concise 2-4 sentence summary: (1) Overall test coverage health (X of Y source files have tests). (2) Number of tier-1 critical gaps. (3) Most important recommendation."
}

═══════════════════════════════════════════════════════════════
RULES OF ENGAGEMENT
═══════════════════════════════════════════════════════════════

1. **Focus on risk, not completeness.** A 100-line utility with CC=2 doesn't need a dedicated gap entry. Focus on complex, vulnerable, untested code.
2. **Respect the pre-computed mapping.** Only override it if your tool call reveals new information (e.g., a test file that imports the source indirectly).
3. **Don't invent test files.** If fetch_chunk_with_context doesn't show test neighbours, the function is untested.
4. **The summary should be actionable.** "Write tests for processPayment and validateAuth first — they handle user payments and have SQL injection risks" is better than "coverage is low".
5. **Limit to 30 gaps maximum**, sorted by risk tier then complexity (descending).`;

export async function runTestCoverageAgent(
  state: CouncilState,
  deps: ToolFactoryDeps,
  llmFn: LLMCompletionFn,
  maxIterations: number,
  temperature: number,
): Promise<CoverageReport> {
  logger.info(LOG_CTX, "Running Test Coverage Correlation Agent…");

  const { chunks, adjacencyList } = state.triage;
  const allFiles = state.manifest.targetFiles;

  // ── Step 1: Identify test files and source files ──
  const testFilePatterns = [
    ".test.",
    ".spec.",
    "__tests__",
    "_test.",
    "_spec.",
    "test/",
    "tests/",
  ];
  const testFiles = allFiles.filter((f) =>
    testFilePatterns.some((p) => f.toLowerCase().includes(p)),
  );
  const sourceFiles = allFiles.filter(
    (f) => !testFilePatterns.some((p) => f.toLowerCase().includes(p)),
  );

  if (testFiles.length === 0) {
    logger.info(
      LOG_CTX,
      "No test files detected — returning empty coverage report",
    );
    return {
      totalSourceFiles: sourceFiles.length,
      totalTestFiles: 0,
      mappedTests: 0,
      gaps: buildGapsFromChunks(chunks, [], state.securityFindings),
      summary:
        "No test files detected in the repository. All complex functions are untested.",
    };
  }

  // ── Step 2: Build test → source mapping using import resolution ──
  const testToSource = new Map<string, string[]>();
  const sourceToTests = new Map<string, string[]>();

  for (const testFile of testFiles) {
    const imports = adjacencyList[testFile] ?? [];
    const sourceImports = imports.filter(
      (imp) => !testFilePatterns.some((p) => imp.toLowerCase().includes(p)),
    );
    testToSource.set(testFile, sourceImports);

    for (const src of sourceImports) {
      const existing = sourceToTests.get(src) ?? [];
      existing.push(testFile);
      sourceToTests.set(src, existing);
    }
  }

  // ── Step 3: Compute coverage gaps ──
  const gaps = buildGapsFromChunks(
    chunks,
    [...sourceToTests.entries()],
    state.securityFindings,
  );

  // ── Step 4: Use LLM to refine top gaps via tool calls ──
  const topGaps = gaps.filter((g) => g.riskTier === 1).slice(0, 5);

  if (topGaps.length > 0) {
    const tools = [createFetchChunkWithContextTool(deps)];
    const config: ReActConfig = {
      agentId: "test-coverage",
      systemPrompt: SYSTEM_PROMPT,
      tools,
      llmFn,
      maxIterations: Math.min(maxIterations, 6), // less iteration needed
      temperature,
    };

    const userMsg = JSON.stringify({
      task: "Refine the test coverage gap analysis for these high-risk untested chunks.",
      preComputedMapping: {
        totalSourceFiles: sourceFiles.length,
        totalTestFiles: testFiles.length,
        mappedTests: sourceToTests.size,
        topGaps: topGaps.map((g) => ({
          chunkId: g.chunkId,
          filePath: g.filePath,
          functionName: g.functionName,
          cyclomaticComplexity: g.cyclomaticComplexity,
          hasVulnerability: g.hasVulnerability,
          testFilePaths: g.testFilePaths,
          riskTier: g.riskTier,
        })),
      },
      instructions:
        "Use fetch_chunk_with_context on the top gap chunks to check if any " +
        "structural neighbours are test files. Return the refined CoverageReport JSON.",
    });

    try {
      const result = await executeReActLoop(config, userMsg);
      const refined = parseCoverageReport(result.response);
      if (refined) {
        logger.info(
          LOG_CTX,
          `Test Coverage Agent refined report: ${refined.gaps.length} gaps`,
        );
        return refined;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        LOG_CTX,
        `LLM refinement failed, using pre-computed report: ${msg}`,
      );
    }
  }

  // Fallback: return pre-computed report
  const report: CoverageReport = {
    totalSourceFiles: sourceFiles.length,
    totalTestFiles: testFiles.length,
    mappedTests: sourceToTests.size,
    gaps,
    summary:
      `Found ${testFiles.length} test files covering ${sourceToTests.size} source files. ` +
      `${gaps.filter((g) => g.riskTier === 1).length} tier-1 gaps (complex + vulnerable + untested), ` +
      `${gaps.filter((g) => g.riskTier === 2).length} tier-2 gaps (complex + untested).`,
  };

  logger.info(
    LOG_CTX,
    `Test Coverage Agent produced ${gaps.length} coverage gap(s)`,
  );
  return report;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildGapsFromChunks(
  chunks: ParsedChunk[],
  sourceToTestEntries: Array<[string, string[]]>,
  securityFindings: Finding[],
): CoverageGap[] {
  const sourceToTests = new Map(sourceToTestEntries);
  const vulnerableFiles = new Set(securityFindings.map((f) => f.filePath));

  // Focus on complex chunks
  const complexChunks = chunks
    .filter((c) => c.cyclomaticComplexity > 5)
    .sort((a, b) => b.cyclomaticComplexity - a.cyclomaticComplexity);

  const gaps: CoverageGap[] = [];

  for (const chunk of complexChunks) {
    const testFilePaths = sourceToTests.get(chunk.filePath) ?? [];
    const hasVulnerability = vulnerableFiles.has(chunk.filePath);
    const isUntested = testFilePaths.length === 0;

    // Extract function name from code
    const funcNameMatch = chunk.code.match(
      /(?:function\s+(\w+)|(?:const|let|var|export\s+(?:const|let|var|function))\s+(\w+)|(\w+)\s*\(.*\)\s*(?::\s*\w+)?\s*\{)/,
    );
    const functionName =
      funcNameMatch?.[1] ??
      funcNameMatch?.[2] ??
      funcNameMatch?.[3] ??
      "anonymous";

    let riskTier: 1 | 2 | 3;
    if (chunk.cyclomaticComplexity > 10 && hasVulnerability && isUntested) {
      riskTier = 1;
    } else if (chunk.cyclomaticComplexity > 5 && isUntested) {
      riskTier = 2;
    } else {
      riskTier = 3;
    }

    // Only include tier 1 and 2 in gaps (tier 3 is lower priority)
    if (riskTier <= 2 || (riskTier === 3 && hasVulnerability)) {
      gaps.push({
        chunkId: chunk.id,
        filePath: chunk.filePath,
        functionName,
        cyclomaticComplexity: chunk.cyclomaticComplexity,
        hasVulnerability,
        testFilePaths,
        riskTier,
      });
    }
  }

  // Limit to top 30 gaps
  return gaps
    .sort(
      (a, b) =>
        a.riskTier - b.riskTier ||
        b.cyclomaticComplexity - a.cyclomaticComplexity,
    )
    .slice(0, 30);
}

function parseCoverageReport(response: string): CoverageReport | null {
  try {
    let jsonStr = response;
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch?.[1]) jsonStr = jsonMatch[1];
    const jsonObjectMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonObjectMatch) jsonStr = jsonObjectMatch[0];

    const report = JSON.parse(jsonStr) as Partial<CoverageReport>;
    if (!report.gaps || !Array.isArray(report.gaps)) return null;

    return {
      totalSourceFiles: report.totalSourceFiles ?? 0,
      totalTestFiles: report.totalTestFiles ?? 0,
      mappedTests: report.mappedTests ?? 0,
      gaps: report.gaps.map((g) => ({
        chunkId: g.chunkId ?? "",
        filePath: g.filePath ?? "",
        functionName: g.functionName ?? "unknown",
        cyclomaticComplexity: g.cyclomaticComplexity ?? 0,
        hasVulnerability: g.hasVulnerability ?? false,
        testFilePaths: g.testFilePaths ?? [],
        riskTier: (g.riskTier ?? 3) as 1 | 2 | 3,
      })),
      summary: report.summary ?? "Coverage analysis complete.",
    };
  } catch {
    return null;
  }
}

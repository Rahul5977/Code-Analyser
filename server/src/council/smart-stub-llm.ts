// ─────────────────────────────────────────────────────────────────────────────
// src/council/smart-stub-llm.ts
//
// Intelligent Stub LLM — drives the full agent pipeline without an API key.
//
// Instead of returning empty/canned JSON, this stub:
//   1. Emits `toolCalls` on the first iteration so real analysis tools execute.
//   2. On subsequent iterations, synthesises findings from actual tool output.
//
// This means every agent actually exercises its full tool chain, producing
// real security/performance/architecture findings from the code's static
// metrics, AST, and dependency graph.
//
// In production, replace with OpenAI / Anthropic / Ollama by supplying a real
// LLMCompletionFn in the CouncilConfig.
// ─────────────────────────────────────────────────────────────────────────────

import { v4 as uuidv4 } from "uuid";
import type {
  LLMMessage,
  LLMCompletionFn,
  ToolDefinition,
  ToolCall,
} from "../interfaces/council.interface";

// Re-export for convenience
export { createSmartStubLlm };

/**
 * Creates the smart-stub LLM function.
 * Stateless — all context comes from the `messages` array.
 */
function createSmartStubLlm(): LLMCompletionFn {
  return async (
    messages: LLMMessage[],
    tools?: ToolDefinition[],
    _temperature?: number,
  ): Promise<LLMMessage> => {
    const systemMsg = messages.find((m) => m.role === "system");
    const systemContent = systemMsg?.content ?? "";
    const lastUserMsg = messages.filter((m) => m.role === "user").pop();
    const userContent = lastUserMsg?.content ?? "";

    const assistantTurns = messages.filter(
      (m) => m.role === "assistant",
    ).length;
    const toolResults = messages
      .filter((m) => m.role === "tool")
      .map((m) => m.content);
    const availableTools = tools ?? [];

    // ── ORCHESTRATOR AGENT ────────────────────────────────────────────────
    if (systemContent.includes("Orchestrator Agent")) {
      if (
        assistantTurns === 0 &&
        availableTools.some((t) => t.name === "query_knowledge_graph")
      ) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: uuidv4(),
              name: "query_knowledge_graph",
              arguments: {
                query: "high complexity files with code smells",
                topK: 20,
              },
            },
          ],
        };
      }
      return buildOrchestratorPlan(userContent);
    }

    // ── SECURITY AGENT ────────────────────────────────────────────────────
    if (systemContent.includes("Security Agent")) {
      if (assistantTurns === 0) {
        const calls = buildSecurityToolCalls(userContent, availableTools);
        if (calls.length > 0)
          return { role: "assistant", content: "", toolCalls: calls };
      }
      if (assistantTurns === 1 && toolResults.length > 0) {
        const calls = buildSecurityTraceCalls(toolResults, availableTools);
        if (calls.length > 0)
          return { role: "assistant", content: "", toolCalls: calls };
      }
      return buildSecurityFindings(toolResults);
    }

    // ── PERFORMANCE AGENT ─────────────────────────────────────────────────
    if (systemContent.includes("Performance Agent")) {
      if (assistantTurns === 0) {
        const calls = buildPerformanceToolCalls(userContent, availableTools);
        if (calls.length > 0)
          return { role: "assistant", content: "", toolCalls: calls };
      }
      if (assistantTurns === 1 && toolResults.length > 0) {
        const calls = buildSimilarPatternCalls(toolResults, availableTools);
        if (calls.length > 0)
          return { role: "assistant", content: "", toolCalls: calls };
      }
      return buildPerformanceFindings(toolResults);
    }

    // ── ARCHITECTURE AGENT ────────────────────────────────────────────────
    if (systemContent.includes("Architecture Agent")) {
      if (assistantTurns === 0) {
        const calls = buildArchitectureToolCalls(availableTools);
        if (calls.length > 0)
          return { role: "assistant", content: "", toolCalls: calls };
      }
      return buildArchitectureReport(toolResults);
    }

    // ── CRITIQUE / DEBATE AGENT ───────────────────────────────────────────
    if (
      systemContent.includes("Critique Agent") ||
      systemContent.includes("Debate")
    ) {
      if (assistantTurns === 0) {
        const calls = buildCritiqueToolCalls(userContent, availableTools);
        if (calls.length > 0)
          return { role: "assistant", content: "", toolCalls: calls };
      }
      return buildCritiqueVerdicts(toolResults, userContent);
    }

    // ── SYNTHESIS / PEDAGOGICAL AGENT ─────────────────────────────────────
    if (
      systemContent.includes("Synthesis") ||
      systemContent.includes("Pedagogical")
    ) {
      if (assistantTurns === 0) {
        const calls = buildSynthesisToolCalls(userContent, availableTools);
        if (calls.length > 0)
          return { role: "assistant", content: "", toolCalls: calls };
      }
      return buildFindingCards(toolResults, userContent);
    }

    // ── TEST COVERAGE AGENT ───────────────────────────────────────────────
    if (systemContent.includes("Test Coverage")) {
      if (assistantTurns === 0) {
        const calls = buildCoverageToolCalls(userContent, availableTools);
        if (calls.length > 0)
          return { role: "assistant", content: "", toolCalls: calls };
      }
      return buildCoverageReport(userContent);
    }

    // ── FALLBACK ──────────────────────────────────────────────────────────
    return { role: "assistant", content: "[]" };
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tool-call builders  (iteration 1 — tell the ReAct loop which tools to call)
// ═══════════════════════════════════════════════════════════════════════════════

function hasTool(tools: ToolDefinition[], name: string): boolean {
  return tools.some((t) => t.name === name);
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

function buildOrchestratorPlan(userContent: string): LLMMessage {
  try {
    const parsed = JSON.parse(userContent);
    const topChunks: Array<{
      id: string;
      filePath: string;
      smells: string[];
      complexity?: number;
    }> = parsed.triageSummary?.topComplexChunks ?? [];
    const sampleFiles: string[] = parsed.manifest?.sampleFiles ?? [];

    const secChunks = topChunks.filter(
      (c) =>
        c.smells?.length > 0 ||
        /auth|login|session|token|secret|password|crypto|sql|query|db|middleware/i.test(
          c.filePath ?? "",
        ),
    );
    const perfChunks = topChunks.filter((c) => (c.complexity ?? 0) >= 5);
    const hasTests = sampleFiles.some(
      (f) =>
        f.includes(".test.") || f.includes(".spec.") || f.includes("__tests__"),
    );

    const fallbackChunks = topChunks.slice(0, 10);

    const securityTargets =
      secChunks.length > 0
        ? [
            {
              chunkIds: secChunks.map((c) => c.id),
              filePaths: [...new Set(secChunks.map((c) => c.filePath))],
              reason:
                "High-complexity chunks with code smells or security-sensitive paths",
              priority: "HIGH",
            },
          ]
        : [
            {
              chunkIds: fallbackChunks.map((c) => c.id),
              filePaths: [...new Set(fallbackChunks.map((c) => c.filePath))],
              reason: "Top complexity chunks — auto-targeted for security scan",
              priority: "HIGH",
            },
          ];

    const performanceTargets =
      perfChunks.length > 0
        ? [
            {
              chunkIds: perfChunks.map((c) => c.id),
              filePaths: [...new Set(perfChunks.map((c) => c.filePath))],
              reason: "High cyclomatic complexity chunks (≥5)",
              priority: "HIGH",
            },
          ]
        : [
            {
              chunkIds: fallbackChunks.map((c) => c.id),
              filePaths: [...new Set(fallbackChunks.map((c) => c.filePath))],
              reason:
                "Top complexity chunks — auto-targeted for performance scan",
              priority: "HIGH",
            },
          ];

    return {
      role: "assistant",
      content: JSON.stringify({
        securityTargets,
        performanceTargets,
        architectureScope: {
          focusModules: [...new Set(topChunks.map((c) => c.filePath))],
        },
        testCoverageEnabled: hasTests,
        crossReferences: [],
      }),
    };
  } catch {
    return { role: "assistant", content: "{}" };
  }
}

// ── Security ─────────────────────────────────────────────────────────────────

function buildSecurityToolCalls(
  userContent: string,
  tools: ToolDefinition[],
): ToolCall[] {
  let target: { target?: { chunkIds?: string[]; filePaths?: string[] } } = {};
  try {
    target = JSON.parse(userContent);
  } catch {
    /* ignore */
  }
  const chunkIds = target.target?.chunkIds ?? [];
  const filePaths = target.target?.filePaths ?? [];
  const calls: ToolCall[] = [];

  for (const chunkId of chunkIds.slice(0, 3)) {
    if (hasTool(tools, "fetch_chunk_with_context")) {
      calls.push({
        id: uuidv4(),
        name: "fetch_chunk_with_context",
        arguments: { chunkId },
      });
    }
  }
  if (filePaths[0] && hasTool(tools, "run_semgrep_rule")) {
    calls.push({
      id: uuidv4(),
      name: "run_semgrep_rule",
      arguments: { ruleId: "auto", targetCode: `// file: ${filePaths[0]}` },
    });
  }
  return calls;
}

function buildSecurityTraceCalls(
  toolResults: string[],
  tools: ToolDefinition[],
): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const result of toolResults.slice(0, 2)) {
    try {
      const parsed = JSON.parse(result);
      const code: string = parsed.code ?? parsed.chunk?.code ?? "";
      const patterns = [
        { regex: /eval\s*\(/, name: "eval_input" },
        { regex: /\.query\s*\(/, name: "query_input" },
        { regex: /exec\s*\(/, name: "exec_input" },
        { regex: /password|secret|token|apiKey/i, name: "sensitive_var" },
        { regex: /req\.(body|params|query|headers)/, name: "user_input" },
        { regex: /innerHTML|dangerouslySetInnerHTML/, name: "xss_sink" },
      ];
      for (const p of patterns) {
        if (p.regex.test(code) && hasTool(tools, "trace_data_flow")) {
          calls.push({
            id: uuidv4(),
            name: "trace_data_flow",
            arguments: {
              variableName: p.name,
              filePath: parsed.filePath ?? parsed.chunk?.filePath ?? "",
              startLine: parsed.startLine ?? parsed.chunk?.startLine ?? 1,
            },
          });
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return calls;
}

// ── Performance ──────────────────────────────────────────────────────────────

function buildPerformanceToolCalls(
  userContent: string,
  tools: ToolDefinition[],
): ToolCall[] {
  let target: { target?: { chunkIds?: string[] } } = {};
  try {
    target = JSON.parse(userContent);
  } catch {
    /* ignore */
  }
  const chunkIds = target.target?.chunkIds ?? [];
  const calls: ToolCall[] = [];

  for (const chunkId of chunkIds.slice(0, 5)) {
    if (hasTool(tools, "fetch_chunk_with_context")) {
      calls.push({
        id: uuidv4(),
        name: "fetch_chunk_with_context",
        arguments: { chunkId },
      });
    }
    if (hasTool(tools, "estimate_complexity_class")) {
      calls.push({
        id: uuidv4(),
        name: "estimate_complexity_class",
        arguments: { chunkId },
      });
    }
  }
  return calls;
}

function buildSimilarPatternCalls(
  toolResults: string[],
  tools: ToolDefinition[],
): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const result of toolResults) {
    try {
      const parsed = JSON.parse(result);
      const complexity = parsed.estimatedClass ?? "";
      if (
        (complexity.includes("n²") ||
          complexity.includes("n³") ||
          complexity.includes("2^n")) &&
        hasTool(tools, "find_similar_patterns")
      ) {
        calls.push({
          id: uuidv4(),
          name: "find_similar_patterns",
          arguments: {
            codeSnippet: parsed.code ?? parsed.chunk?.code ?? "function()",
            topK: 5,
          },
        });
        break;
      }
    } catch {
      /* ignore */
    }
  }
  return calls;
}

// ── Architecture ─────────────────────────────────────────────────────────────

function buildArchitectureToolCalls(tools: ToolDefinition[]): ToolCall[] {
  const calls: ToolCall[] = [];
  if (hasTool(tools, "find_circular_dependencies"))
    calls.push({
      id: uuidv4(),
      name: "find_circular_dependencies",
      arguments: {},
    });
  if (hasTool(tools, "compute_coupling_score"))
    calls.push({
      id: uuidv4(),
      name: "compute_coupling_score",
      arguments: {},
    });
  if (hasTool(tools, "find_god_classes"))
    calls.push({
      id: uuidv4(),
      name: "find_god_classes",
      arguments: { threshold: 5 },
    });
  if (hasTool(tools, "detect_layer_violations"))
    calls.push({
      id: uuidv4(),
      name: "detect_layer_violations",
      arguments: { layers: "auto" },
    });
  return calls;
}

// ── Critique ─────────────────────────────────────────────────────────────────

function buildCritiqueToolCalls(
  userContent: string,
  tools: ToolDefinition[],
): ToolCall[] {
  let findingsData: Array<{
    id?: string;
    chunkIds?: string[];
    codeSnippet?: string;
    startLine?: number;
    endLine?: number;
    title?: string;
  }> = [];
  try {
    const parsed = JSON.parse(userContent);
    findingsData = parsed.findings ?? [];
  } catch {
    /* ignore */
  }

  const calls: ToolCall[] = [];
  for (const f of findingsData.slice(0, 5)) {
    if (hasTool(tools, "verify_finding")) {
      calls.push({
        id: uuidv4(),
        name: "verify_finding",
        arguments: {
          findingId: f.id ?? "",
          chunkId: (f.chunkIds ?? [])[0] ?? "",
          citedCode: f.codeSnippet ?? "",
          citedStartLine: f.startLine ?? 0,
          citedEndLine: f.endLine ?? 0,
          claim: f.title ?? "",
        },
      });
    }
  }
  return calls;
}

// ── Synthesis ────────────────────────────────────────────────────────────────

function buildSynthesisToolCalls(
  userContent: string,
  tools: ToolDefinition[],
): ToolCall[] {
  let findingsData: Array<{
    codeSnippet?: string;
    description?: string;
    category?: string;
  }> = [];
  try {
    const parsed = JSON.parse(userContent);
    findingsData = parsed.findings ?? [];
  } catch {
    /* ignore */
  }

  const calls: ToolCall[] = [];
  for (const f of findingsData.slice(0, 5)) {
    if (hasTool(tools, "generate_fixed_code_snippet")) {
      calls.push({
        id: uuidv4(),
        name: "generate_fixed_code_snippet",
        arguments: {
          originalCode: f.codeSnippet ?? "",
          findingDescription: f.description ?? f.category ?? "code issue",
        },
      });
    }
    if (hasTool(tools, "fetch_documentation_reference")) {
      calls.push({
        id: uuidv4(),
        name: "fetch_documentation_reference",
        arguments: {
          technology: "node.js",
          conceptName: f.category ?? "security best practices",
        },
      });
    }
  }
  return calls;
}

// ── Test Coverage ────────────────────────────────────────────────────────────

function buildCoverageToolCalls(
  userContent: string,
  tools: ToolDefinition[],
): ToolCall[] {
  let gapData: Array<{ chunkId?: string }> = [];
  try {
    const parsed = JSON.parse(userContent);
    gapData = parsed.tentativeGaps ?? parsed.gaps ?? [];
  } catch {
    /* ignore */
  }

  const calls: ToolCall[] = [];
  for (const g of gapData.slice(0, 3)) {
    if (g.chunkId && hasTool(tools, "fetch_chunk_with_context")) {
      calls.push({
        id: uuidv4(),
        name: "fetch_chunk_with_context",
        arguments: { chunkId: g.chunkId },
      });
    }
  }
  return calls;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Response builders  (final iteration — synthesise tool outputs into findings)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Security findings ────────────────────────────────────────────────────────

const SECURITY_CHECKS: Array<{
  regex: RegExp;
  category: string;
  title: string;
  severity: string;
  description: string;
}> = [
  {
    regex: /eval\s*\(/,
    category: "code-injection",
    title: "Use of eval() detected",
    severity: "CRITICAL",
    description:
      "eval() executes arbitrary code and can lead to Remote Code Execution (RCE) if user input reaches it.",
  },
  {
    regex: /req\.(body|params|query)\s*\[/,
    category: "input-validation",
    title: "Unvalidated user input access",
    severity: "HIGH",
    description:
      "Direct access to request parameters without validation or sanitization may allow injection attacks.",
  },
  {
    regex: /(password|secret|api_?key|token)\s*[:=]\s*["'][^"']+["']/i,
    category: "hardcoded-secret",
    title: "Potential hardcoded secret",
    severity: "HIGH",
    description:
      "Hardcoded credentials in source code can be extracted from version control and used for unauthorized access.",
  },
  {
    regex: /\.query\s*\(\s*[`"'].*\$\{/,
    category: "sql-injection",
    title: "Potential SQL injection via template literal",
    severity: "CRITICAL",
    description:
      "String interpolation in SQL queries allows attackers to inject arbitrary SQL commands.",
  },
  {
    regex: /dangerouslySetInnerHTML|\.innerHTML\s*=/,
    category: "xss",
    title: "Potential Cross-Site Scripting (XSS)",
    severity: "HIGH",
    description:
      "Setting innerHTML or dangerouslySetInnerHTML with unescaped content enables XSS attacks.",
  },
  {
    regex: /child_process|exec\(|execSync\(|spawn\(/,
    category: "command-injection",
    title: "Shell command execution detected",
    severity: "HIGH",
    description:
      "Executing shell commands with user-influenced input can lead to OS command injection.",
  },
  {
    regex: /console\.(log|error|warn|debug)\s*\(/,
    category: "info-leak",
    title: "Console logging in production code",
    severity: "LOW",
    description:
      "Console logging may leak sensitive information in production environments.",
  },
  {
    regex: /TODO|FIXME|HACK|XXX/i,
    category: "code-quality",
    title: "Unresolved TODO/FIXME marker",
    severity: "INFO",
    description:
      "Unresolved markers indicate incomplete implementations that may harbor security issues.",
  },
  {
    regex: /new\s+Function\s*\(/,
    category: "code-injection",
    title: "Dynamic Function constructor",
    severity: "HIGH",
    description:
      "The Function constructor is equivalent to eval() and can execute arbitrary code.",
  },
  {
    regex: /\.readFileSync|\.readFile\s*\(\s*(?:req|user|input)/i,
    category: "path-traversal",
    title: "Potential path traversal",
    severity: "HIGH",
    description:
      "Reading files based on user input without path validation allows directory traversal attacks.",
  },
];

function buildSecurityFindings(toolResults: string[]): LLMMessage {
  const findings: Array<Record<string, unknown>> = [];

  for (const result of toolResults) {
    try {
      const parsed = JSON.parse(result);
      const code: string = parsed.code ?? parsed.chunk?.code ?? "";
      const filePath: string = parsed.filePath ?? parsed.chunk?.filePath ?? "";
      const startLine: number =
        parsed.startLine ?? parsed.chunk?.startLine ?? 0;
      const endLine: number = parsed.endLine ?? parsed.chunk?.endLine ?? 0;
      const chunkId: string =
        parsed.id ?? parsed.chunkId ?? parsed.chunk?.id ?? "";

      if (!code || !filePath) continue;

      for (const check of SECURITY_CHECKS) {
        if (check.regex.test(code)) {
          const matchLine = findMatchLine(code, check.regex, startLine);
          findings.push({
            id: uuidv4(),
            agentId: "security",
            category: check.category,
            title: check.title,
            description: `${check.description} Found in \`${filePath}\` at line ${matchLine}.`,
            severity: check.severity,
            confidence: "MEDIUM",
            filePath,
            startLine: matchLine,
            endLine: Math.min(matchLine + 3, endLine),
            codeSnippet: extractSnippetAroundMatch(code, check.regex, 3),
            chunkIds: chunkId ? [chunkId] : [],
            evidence: [],
          });
        }
      }
    } catch {
      /* skip */
    }
  }

  return {
    role: "assistant",
    content: JSON.stringify(dedup(findings).slice(0, 20)),
  };
}

// ── Performance findings ─────────────────────────────────────────────────────

const PERF_CHECKS: Array<{
  regex: RegExp;
  category: string;
  title: string;
  severity: string;
  description: string;
}> = [
  {
    regex: /for\s*\(.*\)\s*\{[^}]*for\s*\(/s,
    category: "nested-loops",
    title: "Nested loops detected",
    severity: "MEDIUM",
    description:
      "Nested loops can result in O(n²) time complexity. Consider using a Map/Set for lookups.",
  },
  {
    regex: /\.forEach\([^)]*\.forEach\(/s,
    category: "nested-iteration",
    title: "Nested array iteration",
    severity: "MEDIUM",
    description:
      "Nested forEach calls create O(n²) complexity. Consider restructuring with index maps.",
  },
  {
    regex: /await\s+.*(?:for|while)\s*\(/s,
    category: "sequential-async",
    title: "Sequential async in loop",
    severity: "HIGH",
    description:
      "Awaiting inside a loop serialises requests. Use Promise.all() for parallel execution.",
  },
  {
    regex: /JSON\.parse\(JSON\.stringify\(/,
    category: "deep-clone",
    title: "JSON-based deep clone",
    severity: "LOW",
    description:
      "JSON.parse(JSON.stringify()) is slow for deep cloning. Use structuredClone() or a library.",
  },
  {
    regex: /\.filter\(.*\)\.map\(|\.map\(.*\)\.filter\(/,
    category: "chained-array-ops",
    title: "Chained array operations",
    severity: "LOW",
    description:
      "Chained filter().map() iterates the array twice. Consider a single reduce() pass.",
  },
];

function buildPerformanceFindings(toolResults: string[]): LLMMessage {
  const findings: Array<Record<string, unknown>> = [];

  for (const result of toolResults) {
    try {
      const parsed = JSON.parse(result);

      // From estimate_complexity_class results
      if (parsed.estimatedClass) {
        const cls = parsed.estimatedClass as string;
        const isExpensive =
          cls.includes("n²") ||
          cls.includes("n³") ||
          cls.includes("2^n") ||
          cls.includes("n log n");
        const isModerate =
          cls.includes("O(n)") && (parsed.nestedLoopDepth ?? 0) >= 2;

        if (isExpensive || isModerate) {
          findings.push({
            id: uuidv4(),
            agentId: "performance",
            category: "algorithmic-complexity",
            title: `${cls} algorithmic complexity detected`,
            description:
              `Function has estimated ${cls} time complexity` +
              (parsed.recursionDetected ? " with recursion" : "") +
              `. Nested loop depth: ${parsed.nestedLoopDepth ?? "unknown"}. ${parsed.reasoning ?? ""}`,
            severity: cls.includes("2^n")
              ? "CRITICAL"
              : cls.includes("n³")
                ? "HIGH"
                : "MEDIUM",
            confidence: "HIGH",
            filePath: parsed.filePath ?? "",
            startLine: parsed.startLine ?? 0,
            endLine: parsed.endLine ?? 0,
            codeSnippet: (parsed.code ?? "").slice(0, 300),
            chunkIds: parsed.chunkId ? [parsed.chunkId] : [],
            evidence: [],
          });
        }
        continue;
      }

      // From fetch_chunk_with_context — check for patterns
      const code: string = parsed.code ?? parsed.chunk?.code ?? "";
      const filePath: string = parsed.filePath ?? parsed.chunk?.filePath ?? "";
      const startLine: number =
        parsed.startLine ?? parsed.chunk?.startLine ?? 0;
      const endLine: number = parsed.endLine ?? parsed.chunk?.endLine ?? 0;
      const chunkId: string =
        parsed.id ?? parsed.chunkId ?? parsed.chunk?.id ?? "";
      const complexity: number =
        parsed.cyclomaticComplexity ?? parsed.chunk?.cyclomaticComplexity ?? 0;

      if (!code || !filePath) continue;

      for (const check of PERF_CHECKS) {
        if (check.regex.test(code)) {
          findings.push({
            id: uuidv4(),
            agentId: "performance",
            category: check.category,
            title: check.title,
            description: `${check.description} Found in \`${filePath}\`.`,
            severity: check.severity,
            confidence: "MEDIUM",
            filePath,
            startLine,
            endLine,
            codeSnippet: extractSnippetAroundMatch(code, check.regex, 3),
            chunkIds: chunkId ? [chunkId] : [],
            evidence: [],
          });
        }
      }

      if (complexity >= 10) {
        findings.push({
          id: uuidv4(),
          agentId: "performance",
          category: "high-complexity",
          title: `High cyclomatic complexity (${complexity})`,
          description:
            `Function has cyclomatic complexity of ${complexity} (threshold: 10). ` +
            `Consider breaking it into smaller functions.`,
          severity: complexity >= 20 ? "HIGH" : "MEDIUM",
          confidence: "HIGH",
          filePath,
          startLine,
          endLine,
          codeSnippet: code.split("\n").slice(0, 5).join("\n") + "\n// ...",
          chunkIds: chunkId ? [chunkId] : [],
          evidence: [],
        });
      }
    } catch {
      /* skip */
    }
  }

  return {
    role: "assistant",
    content: JSON.stringify(dedup(findings).slice(0, 20)),
  };
}

// ── Architecture report ──────────────────────────────────────────────────────

function buildArchitectureReport(toolResults: string[]): LLMMessage {
  let circularDependencies: string[][] = [];
  let couplingScores: Array<Record<string, unknown>> = [];
  let godClasses: Array<Record<string, unknown>> = [];
  let layerViolations: Array<Record<string, unknown>> = [];

  for (const result of toolResults) {
    try {
      const parsed = JSON.parse(result);
      if (Array.isArray(parsed.cycles)) circularDependencies = parsed.cycles;
      if (Array.isArray(parsed.topPairs)) couplingScores = parsed.topPairs;
      if (Array.isArray(parsed.godClasses)) godClasses = parsed.godClasses;
      if (Array.isArray(parsed.violations)) layerViolations = parsed.violations;
    } catch {
      /* ignore */
    }
  }

  const highCoupling = couplingScores.filter(
    (c) => typeof c["score"] === "number" && (c["score"] as number) > 0.7,
  );

  let pattern = "Unknown";
  if (layerViolations.length === 0 && godClasses.length === 0)
    pattern = "Clean Modular";
  else if (godClasses.length >= 3) pattern = "Monolith";
  else if (circularDependencies.length >= 2) pattern = "Spaghetti";
  else pattern = "Layered";

  const summaryParts: string[] = [];
  if (circularDependencies.length > 0)
    summaryParts.push(
      `${circularDependencies.length} circular dependency chain(s) detected`,
    );
  if (godClasses.length > 0)
    summaryParts.push(
      `${godClasses.length} god class(es) with excessive dependencies`,
    );
  if (highCoupling.length > 0)
    summaryParts.push(`${highCoupling.length} tightly-coupled module pair(s)`);
  if (layerViolations.length > 0)
    summaryParts.push(`${layerViolations.length} layer violation(s)`);

  const summary =
    summaryParts.length > 0
      ? `Architecture analysis: ${summaryParts.join(". ")}. Detected pattern: ${pattern}.`
      : `Architecture is healthy with no critical structural issues. Detected pattern: ${pattern}.`;

  return {
    role: "assistant",
    content: JSON.stringify({
      circularDependencies,
      couplingScores,
      godClasses,
      layerViolations,
      detectedPattern: pattern,
      summary,
    }),
  };
}

// ── Critique verdicts ────────────────────────────────────────────────────────

function buildCritiqueVerdicts(
  toolResults: string[],
  userContent: string,
): LLMMessage {
  let findingsData: Array<{ id?: string }> = [];
  try {
    const parsed = JSON.parse(userContent);
    findingsData = parsed.findings ?? [];
  } catch {
    /* ignore */
  }

  const verdicts: Array<Record<string, unknown>> = [];
  for (let i = 0; i < findingsData.length; i++) {
    const f = findingsData[i]!;
    const verifyResult = toolResults[i];
    let verdict = "PLAUSIBLE";
    let reason = "Finding appears plausible based on available evidence.";

    if (verifyResult) {
      try {
        const parsed = JSON.parse(verifyResult);
        if (
          parsed.codeMatch === true ||
          parsed.match === true ||
          parsed.verified === true
        ) {
          verdict = "CONFIRMED";
          reason =
            "Code snippet and line numbers verified against source. Evidence matches the claim.";
        } else if (parsed.codeMatch === false || parsed.match === false) {
          verdict = "DISPUTED";
          reason =
            parsed.reason ??
            "Code snippet or line numbers do not match the source.";
        }
      } catch {
        verdict = "PLAUSIBLE";
        reason = "Verification inconclusive — defaulting to PLAUSIBLE.";
      }
    }
    verdicts.push({ findingId: f.id, verdict, reason });
  }

  return { role: "assistant", content: JSON.stringify(verdicts) };
}

// ── Finding cards (Synthesis) ────────────────────────────────────────────────

function buildFindingCards(
  toolResults: string[],
  userContent: string,
): LLMMessage {
  let findingsData: Array<{
    id?: string;
    title?: string;
    description?: string;
    codeSnippet?: string;
    category?: string;
    severity?: string;
    filePath?: string;
  }> = [];
  try {
    const parsed = JSON.parse(userContent);
    findingsData = parsed.findings ?? [];
  } catch {
    /* ignore */
  }

  const cards: Array<Record<string, unknown>> = [];
  let toolIdx = 0;

  for (const f of findingsData) {
    const fixResult = toolResults[toolIdx] ?? "";
    const docResult = toolResults[toolIdx + 1] ?? "";
    toolIdx += 2;

    let fixedCode = "";
    try {
      const parsed = JSON.parse(fixResult);
      fixedCode = parsed.fixedCode ?? parsed.code ?? fixResult;
    } catch {
      fixedCode =
        fixResult ||
        `// Fixed version of: ${f.title ?? "issue"}\n// TODO: Apply recommended fix`;
    }

    let references: Array<{ title: string; url: string }> = [];
    try {
      const parsed = JSON.parse(docResult);
      references = parsed.references ?? (parsed.title ? [parsed] : []);
    } catch {
      /* ignore */
    }
    if (references.length === 0) {
      references = [
        {
          title: `OWASP: ${f.category ?? "Security Best Practices"}`,
          url: "https://owasp.org/www-project-top-ten/",
        },
      ];
    }

    cards.push({
      findingId: f.id,
      fixedCode,
      explanations: {
        junior:
          `This code has a ${f.category ?? "potential issue"} problem. ` +
          `${f.description ?? "It could cause unexpected behavior."} ` +
          `The fix applies secure coding practices to prevent this.`,
        senior:
          `[${f.severity ?? "MEDIUM"}] ${f.title ?? "Finding"} in \`${f.filePath ?? "unknown"}\`. ` +
          `${f.description ?? ""} ` +
          `Mitigation: Apply the recommended fix or refactor using established patterns. ` +
          `See references for authoritative guidance.`,
        manager:
          `A ${(f.severity ?? "medium").toLowerCase()}-severity ${f.category ?? "code quality"} issue ` +
          `was detected. If exploited, it could impact system reliability or security. ` +
          `Estimated fix effort: 30 minutes. Recommended priority: ${f.severity === "CRITICAL" ? "immediate" : f.severity === "HIGH" ? "this sprint" : "next sprint"}.`,
      },
      references,
    });
  }

  return { role: "assistant", content: JSON.stringify(cards) };
}

// ── Coverage report ──────────────────────────────────────────────────────────

function buildCoverageReport(userContent: string): LLMMessage {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(userContent);
  } catch {
    /* ignore */
  }

  const totalSourceFiles = (data["totalSourceFiles"] as number) ?? 0;
  const totalTestFiles = (data["totalTestFiles"] as number) ?? 0;
  const mappedTests = (data["mappedTests"] as number) ?? 0;
  const gaps = (
    (data["tentativeGaps"] ?? data["gaps"] ?? []) as Array<
      Record<string, unknown>
    >
  ).slice(0, 10);

  return {
    role: "assistant",
    content: JSON.stringify({
      totalSourceFiles,
      totalTestFiles,
      mappedTests,
      gaps,
      summary:
        `Test coverage analysis: ${totalSourceFiles} source files, ${totalTestFiles} test files, ` +
        `${mappedTests} mapped. ${gaps.length} coverage gap(s) identified.`,
    }),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function findMatchLine(
  code: string,
  regex: RegExp,
  baseStartLine: number,
): number {
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i]!)) return baseStartLine + i;
  }
  return baseStartLine;
}

function extractSnippetAroundMatch(
  code: string,
  regex: RegExp,
  contextLines: number,
): string {
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i]!)) {
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length, i + contextLines + 1);
      return lines.slice(start, end).join("\n");
    }
  }
  return lines.slice(0, 2 * contextLines + 1).join("\n");
}

function dedup(
  findings: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f["filePath"]}::${f["category"]}::${f["startLine"]}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

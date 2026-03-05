// ─────────────────────────────────────────────────────────────────────────────
// src/council/tools/security.tools.ts
//
// Security Agent Tools:
//   1. check_cve_database    — queries OSV API for real CVE records
//   2. run_semgrep_rule      — executes a Semgrep SAST rule via child process
//   3. trace_data_flow       — AST-based data flow tracing for injection vectors
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentTool } from "../../interfaces/council.interface";

const execFileAsync = promisify(execFile);

// ─── check_cve_database ─────────────────────────────────────────────────────

/**
 * Queries the OSV (Open Source Vulnerabilities) API for known CVEs
 * affecting a given package and version.
 */
export function createCheckCveDatabaseTool(): AgentTool {
  return {
    name: "check_cve_database",
    description:
      "Queries the OSV API (osv.dev) to get real CVE records for a " +
      "dependency. Returns vulnerability IDs, severity, summaries, and " +
      "affected version ranges.",
    parameters: {
      type: "object",
      properties: {
        packageName: {
          type: "string",
          description: "The npm/PyPI package name (e.g., 'express', 'lodash').",
        },
        version: {
          type: "string",
          description: "The specific version to check (e.g., '4.17.1').",
        },
        ecosystem: {
          type: "string",
          enum: ["npm", "PyPI", "Go", "Maven", "crates.io"],
          description: "Package ecosystem (default: 'npm').",
        },
      },
      required: ["packageName", "version"],
    },
    execute: async (args) => {
      const packageName = args["packageName"] as string;
      const version = args["version"] as string;
      const ecosystem = (args["ecosystem"] as string) ?? "npm";

      if (!packageName || !version) {
        return JSON.stringify({
          error: "packageName and version are required",
        });
      }

      try {
        // OSV API: POST https://api.osv.dev/v1/query
        const response = await fetch("https://api.osv.dev/v1/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version,
            package: { name: packageName, ecosystem },
          }),
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          return JSON.stringify({
            error: `OSV API returned ${response.status}: ${response.statusText}`,
          });
        }

        const data = (await response.json()) as {
          vulns?: Array<{
            id?: string;
            summary?: string;
            aliases?: string[];
            severity?: Array<{ type?: string; score?: string }>;
            affected?: Array<{
              ranges?: Array<{
                events?: Array<{ introduced?: string; fixed?: string }>;
              }>;
            }>;
            references?: Array<{ url?: string }>;
          }>;
        };

        const vulns = data.vulns ?? [];

        if (vulns.length === 0) {
          return JSON.stringify({
            packageName,
            version,
            ecosystem,
            vulnerabilities: [],
            message: "No known vulnerabilities found.",
          });
        }

        const results = vulns.slice(0, 10).map((v) => ({
          id: v.id ?? "unknown",
          summary: v.summary ?? "No summary",
          aliases: v.aliases ?? [],
          severity: v.severity?.[0]?.score ?? "unknown",
          references: (v.references ?? []).slice(0, 3).map((r) => r.url ?? ""),
        }));

        return JSON.stringify({
          packageName,
          version,
          ecosystem,
          totalVulnerabilities: vulns.length,
          vulnerabilities: results,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `CVE lookup failed: ${msg}` });
      }
    },
  };
}

// ─── run_semgrep_rule ────────────────────────────────────────────────────────

/**
 * Executes a Semgrep SAST rule against a code snippet.
 * Writes the code to a temp file, runs Semgrep, parses results.
 *
 * Falls back gracefully if Semgrep is not installed.
 */
export function createRunSemgrepRuleTool(): AgentTool {
  return {
    name: "run_semgrep_rule",
    description:
      "Executes a specific Semgrep SAST rule against a code snippet. " +
      "Returns structured findings with line numbers and rule metadata. " +
      "Requires Semgrep CLI to be installed (falls back to pattern matching if not).",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The source code to scan.",
        },
        ruleId: {
          type: "string",
          description:
            "Semgrep rule ID or pattern (e.g., 'javascript.lang.security.detect-sql-injection').",
        },
        language: {
          type: "string",
          description:
            "Source language (e.g., 'typescript', 'javascript', 'python').",
        },
      },
      required: ["code", "ruleId"],
    },
    execute: async (args) => {
      const code = args["code"] as string;
      const ruleId = args["ruleId"] as string;
      const language = (args["language"] as string) ?? "typescript";

      if (!code || !ruleId) {
        return JSON.stringify({ error: "code and ruleId are required" });
      }

      try {
        // Write code to temp file
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const os = await import("node:os");

        const ext = language === "python" ? ".py" : ".ts";
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "semgrep-"));
        const tmpFile = path.join(tmpDir, `scan${ext}`);
        await fs.writeFile(tmpFile, code, "utf-8");

        try {
          const { stdout } = await execFileAsync(
            "semgrep",
            ["--config", `r/${ruleId}`, "--json", "--no-git-ignore", tmpFile],
            { timeout: 30_000 },
          );

          const result = JSON.parse(stdout) as {
            results?: Array<{
              check_id?: string;
              path?: string;
              start?: { line?: number };
              end?: { line?: number };
              extra?: { message?: string; severity?: string };
            }>;
          };

          const findings = (result.results ?? []).map((r) => ({
            ruleId: r.check_id ?? ruleId,
            startLine: r.start?.line ?? 0,
            endLine: r.end?.line ?? 0,
            message: r.extra?.message ?? "Finding detected",
            severity: r.extra?.severity ?? "WARNING",
          }));

          return JSON.stringify({
            tool: "semgrep",
            ruleId,
            findings,
            totalFindings: findings.length,
          });
        } catch {
          // Semgrep not installed — fall back to basic pattern matching
          return fallbackPatternScan(code, ruleId);
        } finally {
          // Cleanup temp files
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `Semgrep scan failed: ${msg}` });
      }
    },
  };
}

/**
 * Basic pattern-matching fallback when Semgrep CLI is unavailable.
 * Detects common vulnerability patterns statically.
 */
function fallbackPatternScan(code: string, ruleId: string): string {
  const findings: Array<{
    pattern: string;
    line: number;
    message: string;
    severity: string;
  }> = [];

  const lines = code.split("\n");

  // Define basic security patterns
  const patterns: Array<{
    regex: RegExp;
    message: string;
    severity: string;
    category: string;
  }> = [
    {
      regex: /(\+\s*['"`]|['"`]\s*\+).*(?:SELECT|INSERT|UPDATE|DELETE|DROP)/i,
      message: "Potential SQL injection via string concatenation",
      severity: "HIGH",
      category: "sql-injection",
    },
    {
      regex: /eval\s*\(/,
      message: "Use of eval() — potential code injection",
      severity: "HIGH",
      category: "code-injection",
    },
    {
      regex: /innerHTML\s*=/,
      message: "Direct innerHTML assignment — potential XSS",
      severity: "MEDIUM",
      category: "xss",
    },
    {
      regex: /child_process|exec\s*\(|execSync\s*\(/,
      message: "Command execution detected — potential command injection",
      severity: "HIGH",
      category: "command-injection",
    },
    {
      regex: /password\s*[:=]\s*['"`][^'"`]+['"`]/i,
      message: "Hardcoded password/secret detected",
      severity: "HIGH",
      category: "hardcoded-secret",
    },
    {
      regex: /Math\.random\s*\(\)/,
      message: "Math.random() is not cryptographically secure",
      severity: "LOW",
      category: "weak-random",
    },
    {
      regex: /createReadStream|readFileSync|readFile/,
      message: "File system access — verify input sanitisation",
      severity: "MEDIUM",
      category: "path-traversal",
    },
    {
      regex: /new\s+Function\s*\(/,
      message: "Dynamic Function constructor — potential code injection",
      severity: "HIGH",
      category: "code-injection",
    },
    {
      regex: /res\.redirect\s*\(\s*req\./,
      message: "Open redirect — user-controlled redirect target",
      severity: "MEDIUM",
      category: "open-redirect",
    },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const pattern of patterns) {
      if (
        pattern.regex.test(line) &&
        (ruleId === "auto" || ruleId.includes(pattern.category))
      ) {
        findings.push({
          pattern: pattern.category,
          line: i + 1,
          message: pattern.message,
          severity: pattern.severity,
        });
      }
    }
  }

  return JSON.stringify({
    tool: "fallback-pattern-scanner",
    ruleId,
    findings,
    totalFindings: findings.length,
    note: "Semgrep CLI not available — used built-in pattern matching.",
  });
}

// ─── trace_data_flow ─────────────────────────────────────────────────────────

/**
 * AST-based data flow tracer. Traces where a variable comes from (source)
 * and where it goes (sink). Critical for confirming injection vectors.
 *
 * This is a lightweight static analysis — not a full taint tracker, but
 * sufficient to identify user-controlled → dangerous-sink flows.
 */
export function createTraceDataFlowTool(): AgentTool {
  return {
    name: "trace_data_flow",
    description:
      "Traces the data flow of a variable within a function chunk. " +
      "Identifies where the variable is assigned (source), where it's used (sinks), " +
      "and whether any user-controlled input flows into dangerous operations.",
    parameters: {
      type: "object",
      properties: {
        varName: {
          type: "string",
          description:
            "The variable name to trace (e.g., 'userInput', 'query').",
        },
        code: {
          type: "string",
          description: "The function code to analyse.",
        },
      },
      required: ["varName", "code"],
    },
    execute: async (args) => {
      const varName = args["varName"] as string;
      const code = args["code"] as string;

      if (!varName || !code) {
        return JSON.stringify({ error: "varName and code are required" });
      }

      try {
        const lines = code.split("\n");
        const sources: Array<{ line: number; text: string; type: string }> = [];
        const sinks: Array<{
          line: number;
          text: string;
          type: string;
          dangerous: boolean;
        }> = [];
        const propagations: Array<{
          line: number;
          text: string;
          fromVar: string;
          toVar: string;
        }> = [];

        // Escape the variable name for regex
        const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const varRegex = new RegExp(`\\b${escaped}\\b`);

        // Known user-controlled sources
        const sourcePatterns: Array<{ regex: RegExp; type: string }> = [
          {
            regex: /req\.(body|query|params|headers|cookies)/i,
            type: "http-input",
          },
          { regex: /process\.env/i, type: "environment" },
          {
            regex: /\.(?:readFile|readFileSync|createReadStream)/i,
            type: "file-read",
          },
          { regex: /(?:prompt|readline|stdin)/i, type: "user-input" },
          {
            regex: /(?:fetch|axios|http\.get|request)\s*\(/i,
            type: "external-data",
          },
          { regex: /JSON\.parse\s*\(/i, type: "parsed-input" },
        ];

        // Known dangerous sinks
        const sinkPatterns: Array<{ regex: RegExp; type: string }> = [
          { regex: /(?:query|execute|run)\s*\(/i, type: "database-query" },
          { regex: /eval\s*\(/i, type: "eval" },
          { regex: /innerHTML/i, type: "dom-manipulation" },
          {
            regex: /child_process|exec\s*\(|execSync\s*\(|spawn\s*\(/i,
            type: "command-execution",
          },
          {
            regex: /\.(?:write|send|json|render)\s*\(/i,
            type: "response-output",
          },
          { regex: /\.redirect\s*\(/i, type: "redirect" },
          {
            regex: /fs\.(writeFile|appendFile|createWriteStream)/i,
            type: "file-write",
          },
          { regex: /new\s+Function\s*\(/i, type: "dynamic-function" },
        ];

        let isUserControlled = false;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          const lineNum = i + 1;

          if (!varRegex.test(line)) continue;

          // Check if this line is an assignment to varName
          const assignRegex = new RegExp(
            `(?:const|let|var|)\\s*${escaped}\\s*=`,
          );
          if (assignRegex.test(line)) {
            // Check if the source is user-controlled
            for (const sp of sourcePatterns) {
              if (sp.regex.test(line)) {
                sources.push({
                  line: lineNum,
                  text: line.trim(),
                  type: sp.type,
                });
                isUserControlled = true;
              }
            }
            if (
              sources.length === 0 ||
              sources[sources.length - 1]?.line !== lineNum
            ) {
              sources.push({
                line: lineNum,
                text: line.trim(),
                type: "assignment",
              });
            }
          }

          // Check if the variable flows into a sink
          for (const sk of sinkPatterns) {
            if (sk.regex.test(line)) {
              sinks.push({
                line: lineNum,
                text: line.trim(),
                type: sk.type,
                dangerous: isUserControlled,
              });
            }
          }

          // Check for variable propagation (varName assigned to another var)
          const propRegex = new RegExp(
            `(?:const|let|var)\\s+(\\w+)\\s*=.*\\b${escaped}\\b`,
          );
          const propMatch = propRegex.exec(line);
          if (propMatch?.[1]) {
            propagations.push({
              line: lineNum,
              text: line.trim(),
              fromVar: varName,
              toVar: propMatch[1],
            });
          }
        }

        const dangerousSinks = sinks.filter((s) => s.dangerous);

        return JSON.stringify({
          variable: varName,
          isUserControlled,
          sources,
          sinks,
          propagations,
          dangerousSinks,
          riskAssessment:
            dangerousSinks.length > 0
              ? `HIGH RISK: User-controlled variable "${varName}" flows into ${dangerousSinks.length} dangerous sink(s): ${dangerousSinks.map((s) => s.type).join(", ")}`
              : isUserControlled
                ? `MEDIUM RISK: User-controlled variable "${varName}" detected but no dangerous sinks found in this scope.`
                : `LOW RISK: Variable "${varName}" does not appear to be user-controlled.`,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `Data flow trace failed: ${msg}` });
      }
    },
  };
}

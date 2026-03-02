// ─────────────────────────────────────────────────────────────────────────────
// src/parsers/helpers/smells.helper.ts
//
// Rule-Based Code Smell Detection (no AI).
//
// Checks performed per function/method:
//   1. LongFunction      – body exceeds 80 lines
//   2. TooManyParams     – formal parameters > 7
//   3. CallbackHell      – arrow/function expressions nested > 3 levels deep
//   4. ConsoleLog        – console.log/warn/error/info/debug usage
//                          (skipped if filePath contains 'utils' or 'logger')
//   5. HardcodedSecret   – string literals matching secret/credential patterns
// ─────────────────────────────────────────────────────────────────────────────

import type { SyntaxNode } from "tree-sitter";
import type { CodeSmell } from "../../interfaces/triage.interface";

// ── Thresholds ───────────────────────────────────────────────────────────────
const MAX_FUNCTION_LINES = 80;
const MAX_PARAMS = 7;
const MAX_CALLBACK_NESTING = 3;

// ── Console methods we flag ──────────────────────────────────────────────────
const CONSOLE_METHODS = new Set([
  "log",
  "warn",
  "error",
  "info",
  "debug",
  "trace",
]);

// ── Secret detection patterns ────────────────────────────────────────────────
// Matches assignments like: api_key = "AKIAIOSFODNN7EXAMPLE"
const SECRET_ASSIGNMENT_RE =
  /(api[_-]?key|secret|password|passwd|token|auth|credential|private[_-]?key|access[_-]?key)[\s"'`:=]+[A-Za-z0-9_\-/+]{16,}/i;

// Matches raw IP addresses (v4)
const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;

// Matches URLs with credentials  e.g. https://user:pass@host
const CRED_URL_RE = /https?:\/\/[^:]+:[^@]+@/i;

// High-entropy heuristic: 20+ chars of base64-ish data that isn't a common word
const HIGH_ENTROPY_RE = /^[A-Za-z0-9+/=_\-]{20,}$/;

// ─────────────────────────────────────────────────────────────────────────────
// 1. LongFunction
// ─────────────────────────────────────────────────────────────────────────────
function checkLongFunction(node: SyntaxNode, smells: CodeSmell[]): void {
  const lines = node.endPosition.row - node.startPosition.row + 1;
  if (lines > MAX_FUNCTION_LINES) {
    smells.push({
      type: "LongFunction",
      message: `Function spans ${lines} lines (threshold: ${MAX_FUNCTION_LINES}).`,
      line: node.startPosition.row + 1, // convert 0-based → 1-based
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. TooManyParams
// ─────────────────────────────────────────────────────────────────────────────
function checkTooManyParams(node: SyntaxNode, smells: CodeSmell[]): void {
  // Find the `formal_parameters` child
  const params = node.childForFieldName("parameters");
  if (!params) return;

  // Count only named children that are actual parameter definitions
  const paramCount = params.namedChildren.filter(
    (c) =>
      c.type === "required_parameter" ||
      c.type === "optional_parameter" ||
      c.type === "rest_pattern" ||
      c.type === "identifier" ||
      c.type === "assignment_pattern" ||
      c.type === "object_pattern" ||
      c.type === "array_pattern",
  ).length;

  if (paramCount > MAX_PARAMS) {
    smells.push({
      type: "TooManyParams",
      message: `Function has ${paramCount} parameters (threshold: ${MAX_PARAMS}).`,
      line: params.startPosition.row + 1,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. CallbackHell
// ─────────────────────────────────────────────────────────────────────────────
const CALLBACK_TYPES = new Set([
  "arrow_function",
  "function_expression",
  "function",
]);

function measureCallbackDepth(node: SyntaxNode, currentDepth: number): number {
  let maxDepth = currentDepth;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    if (CALLBACK_TYPES.has(child.type)) {
      const childMax = measureCallbackDepth(child, currentDepth + 1);
      if (childMax > maxDepth) maxDepth = childMax;
    } else {
      const childMax = measureCallbackDepth(child, currentDepth);
      if (childMax > maxDepth) maxDepth = childMax;
    }
  }

  return maxDepth;
}

function checkCallbackHell(node: SyntaxNode, smells: CodeSmell[]): void {
  // Start counting from depth 0 (the function itself is depth 0, nested callbacks add)
  const maxDepth = measureCallbackDepth(node, 0);

  if (maxDepth > MAX_CALLBACK_NESTING) {
    smells.push({
      type: "CallbackHell",
      message: `Callback nesting depth of ${maxDepth} detected (threshold: ${MAX_CALLBACK_NESTING}).`,
      line: node.startPosition.row + 1,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ConsoleLog
// ─────────────────────────────────────────────────────────────────────────────
function findConsoleUsages(
  node: SyntaxNode,
  filePath: string,
  smells: CodeSmell[],
): void {
  // Skip if the file is a logger/utility itself
  const lowerPath = filePath.toLowerCase();
  if (lowerPath.includes("utils") || lowerPath.includes("logger")) {
    return;
  }

  walkForConsole(node, smells);
}

function walkForConsole(node: SyntaxNode, smells: CodeSmell[]): void {
  if (node.type === "call_expression") {
    const fn = node.childForFieldName("function");
    if (fn?.type === "member_expression") {
      const obj = fn.childForFieldName("object");
      const prop = fn.childForFieldName("property");
      if (obj?.text === "console" && prop && CONSOLE_METHODS.has(prop.text)) {
        smells.push({
          type: "ConsoleLog",
          message: `console.${prop.text}() detected — use a structured logger instead.`,
          line: node.startPosition.row + 1,
        });
      }
    }
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walkForConsole(child, smells);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. HardcodedSecret
// ─────────────────────────────────────────────────────────────────────────────
function findHardcodedSecrets(node: SyntaxNode, smells: CodeSmell[]): void {
  walkForSecrets(node, smells);
}

function walkForSecrets(node: SyntaxNode, smells: CodeSmell[]): void {
  // Check string and template_string nodes
  if (node.type === "string" || node.type === "template_string") {
    const text = node.text;

    if (SECRET_ASSIGNMENT_RE.test(text)) {
      smells.push({
        type: "HardcodedSecret",
        message: `Potential hardcoded secret/credential detected: "${truncate(text, 40)}".`,
        line: node.startPosition.row + 1,
      });
      return; // avoid double-flagging the same node
    }

    if (CRED_URL_RE.test(text)) {
      smells.push({
        type: "HardcodedSecret",
        message: `URL with embedded credentials detected: "${truncate(text, 40)}".`,
        line: node.startPosition.row + 1,
      });
      return;
    }

    if (IPV4_RE.test(text)) {
      // Only flag if it's not a common localhost/loopback
      const match = IPV4_RE.exec(text);
      if (match && !isCommonLocalIp(match[0])) {
        smells.push({
          type: "HardcodedSecret",
          message: `Hardcoded IP address detected: "${match[0]}".`,
          line: node.startPosition.row + 1,
        });
        return;
      }
    }

    // High-entropy string check — only for string content inside quotes
    const inner = stripQuotes(text);
    if (
      inner.length >= 20 &&
      HIGH_ENTROPY_RE.test(inner) &&
      computeEntropy(inner) > 4.0
    ) {
      smells.push({
        type: "HardcodedSecret",
        message: `High-entropy string detected (possible secret): "${truncate(inner, 30)}".`,
        line: node.startPosition.row + 1,
      });
    }
  }

  // ── Also check the LHS=RHS pattern in variable_declarator ──
  // e.g., const apiKey = "sk-1234..."
  if (
    node.type === "variable_declarator" ||
    node.type === "assignment_expression" ||
    node.type === "pair" // object property
  ) {
    const fullText = node.text;
    if (SECRET_ASSIGNMENT_RE.test(fullText)) {
      smells.push({
        type: "HardcodedSecret",
        message: `Potential hardcoded secret in assignment: "${truncate(fullText, 50)}".`,
        line: node.startPosition.row + 1,
      });
      // Don't recurse further into this node to avoid double-hits
      return;
    }
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walkForSecrets(child, smells);
  }
}

// ── Utility helpers ──────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  if (s.startsWith("`") && s.endsWith("`")) {
    return s.slice(1, -1);
  }
  return s;
}

function isCommonLocalIp(ip: string): boolean {
  return (
    ip === "127.0.0.1" ||
    ip === "0.0.0.0" ||
    ip.startsWith("192.168.") ||
    ip.startsWith("10.")
  );
}

/** Shannon entropy of a string (bits per character). */
function computeEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  const len = s.length;
  for (const count of freq.values()) {
    const p = count / len;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — Run all smell checks on a function node
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs all 5 rule-based smell detectors on a single function/method AST node.
 */
export function detectSmells(
  functionNode: SyntaxNode,
  filePath: string,
): CodeSmell[] {
  const smells: CodeSmell[] = [];

  checkLongFunction(functionNode, smells);
  checkTooManyParams(functionNode, smells);
  checkCallbackHell(functionNode, smells);
  findConsoleUsages(functionNode, filePath, smells);
  findHardcodedSecrets(functionNode, smells);

  return smells;
}

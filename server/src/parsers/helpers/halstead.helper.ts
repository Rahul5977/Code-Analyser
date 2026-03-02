// ─────────────────────────────────────────────────────────────────────────────
// src/parsers/helpers/halstead.helper.ts
//
// Halstead Software Science Metrics (1977).
//
// Definitions:
//   η₁ = unique operators    η₂ = unique operands
//   N₁ = total operators     N₂ = total operands
//   N  = N₁ + N₂  (program length)
//   n  = η₁ + η₂  (vocabulary size)
//   V  = N × log₂(n)  (volume)
//
// Operators:  keywords that perform actions (function, return, if, for, …)
//             assignment/comparison/arithmetic operators (+, -, =, ==, …)
//             punctuation that affects flow (; , { } ( ))
//
// Operands:   identifiers, literals (numbers, strings, booleans, null/undefined)
// ─────────────────────────────────────────────────────────────────────────────

import type { SyntaxNode } from "tree-sitter";

// ── AST node types classified as OPERATORS ───────────────────────────────────
const OPERATOR_NODE_TYPES = new Set([
  // Keywords that act as operators
  "function",
  "async",
  "await",
  "return_statement",
  "if_statement",
  "else_clause",
  "switch_statement",
  "switch_case",
  "switch_default",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "try_statement",
  "catch_clause",
  "throw_statement",
  "new_expression",
  "yield_expression",
  "break_statement",
  "continue_statement",
  "export_statement",
  "import_statement",
  "class_declaration",
  "class_body",
  "arrow_function",
  "ternary_expression",
  "type_assertion",
  "as_expression",
  "satisfies_expression",

  // Call / member access
  "call_expression",
  "member_expression",
  "subscript_expression",
  "spread_element",
  "rest_pattern",
]);

// ── AST node types classified as OPERANDS ────────────────────────────────────
const OPERAND_NODE_TYPES = new Set([
  "identifier",
  "property_identifier",
  "shorthand_property_identifier",
  "shorthand_property_identifier_pattern",
  "type_identifier",
  "number",
  "string",
  "string_fragment",
  "template_string",
  "template_substitution",
  "regex",
  "true",
  "false",
  "null",
  "undefined",
  "this",
  "super",
]);

// ── Leaf token types that are operators (binary_expression children, etc.) ───
const OPERATOR_TOKENS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**=",
  "==",
  "===",
  "!=",
  "!==",
  "<",
  ">",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "!",
  "~",
  "typeof",
  "void",
  "delete",
  "instanceof",
  "in",
  "&",
  "|",
  "^",
  "<<",
  ">>",
  ">>>",
  "&=",
  "|=",
  "^=",
  "<<=",
  ">>=",
  ">>>=",
  "??=",
  "&&=",
  "||=",
  "++",
  "--",
  ".",
  "?.",
  "...",
  "=>",
  "?",
  ":",
]);

export interface HalsteadMetrics {
  uniqueOperators: number;
  uniqueOperands: number;
  totalOperators: number;
  totalOperands: number;
  vocabulary: number;
  length: number;
  volume: number;
}

/**
 * Recursively walks the function AST and classifies every meaningful
 * token as either an operator or an operand.
 */
function collectHalstead(
  node: SyntaxNode,
  operators: { unique: Set<string>; total: number },
  operands: { unique: Set<string>; total: number },
): void {
  const type = node.type;

  // ── Structural operator nodes ──
  if (OPERATOR_NODE_TYPES.has(type)) {
    operators.unique.add(type);
    operators.total++;
  }

  // ── Leaf operator tokens (inside binary_expression, unary_expression, etc.) ──
  if (node.childCount === 0 && OPERATOR_TOKENS.has(node.text)) {
    operators.unique.add(node.text);
    operators.total++;
  }

  // ── Operand nodes ──
  if (OPERAND_NODE_TYPES.has(type)) {
    // Use the actual text for operand uniqueness (different variable names = different operands)
    const key = `${type}:${node.text}`;
    operands.unique.add(key);
    operands.total++;
  }

  // Recurse
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      collectHalstead(child, operators, operands);
    }
  }
}

/**
 * Computes Halstead metrics for a single function/method AST node.
 */
export function computeHalstead(functionNode: SyntaxNode): HalsteadMetrics {
  const operators = { unique: new Set<string>(), total: 0 };
  const operands = { unique: new Set<string>(), total: 0 };

  collectHalstead(functionNode, operators, operands);

  const eta1 = operators.unique.size; // η₁
  const eta2 = operands.unique.size; // η₂
  const N1 = operators.total; // N₁
  const N2 = operands.total; // N₂

  const n = eta1 + eta2; // vocabulary
  const N = N1 + N2; // length

  // Volume = N × log₂(n).  Guard against log₂(0).
  const volume = n > 0 ? Math.round(N * Math.log2(n) * 100) / 100 : 0;

  return {
    uniqueOperators: eta1,
    uniqueOperands: eta2,
    totalOperators: N1,
    totalOperands: N2,
    vocabulary: n,
    length: N,
    volume,
  };
}

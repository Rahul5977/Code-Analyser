// ─────────────────────────────────────────────────────────────────────────────
// src/parsers/helpers/cfg.helper.ts
//
// Control Flow Graph construction & Cyclomatic Complexity calculation.
//
// Cyclomatic Complexity (McCabe, 1976):
//   M = 1 + (number of branching decision points)
//
// Branching nodes counted:
//   if, else if, switch case, for, for...in, for...of, while, do...while,
//   catch, ternary (?:), logical AND (&&), logical OR (||),
//   nullish coalescing (??), optional chaining (?.)
//
// Lightweight CFG:
//   nodes  = branch points found
//   edges  = complexity + 1 (each branch adds one extra path)
//   unreachableCodeDetected = statements after return/throw/break in same block
// ─────────────────────────────────────────────────────────────────────────────

import type { SyntaxNode } from "tree-sitter";
import type { CFG } from "../../interfaces/triage.interface";

// ── Node types that represent decision / branching points ────────────────────
const BRANCH_NODE_TYPES = new Set([
  "if_statement",
  "else_clause", // counts "else if" and standalone "else"
  "switch_case", // each `case:` is a branch
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "catch_clause",
  "ternary_expression",
]);

// ── Binary expressions that introduce short-circuit branching ────────────────
const BRANCH_OPERATORS = new Set(["&&", "||", "??"]);

// ── Statements that terminate control flow within a block ────────────────────
const TERMINAL_STATEMENTS = new Set([
  "return_statement",
  "throw_statement",
  "break_statement",
  "continue_statement",
]);

/**
 * Recursively walks the AST rooted at `node`, counting branch points
 * and detecting unreachable code.
 */
function walkCfg(
  node: SyntaxNode,
  state: { branchCount: number; unreachable: boolean },
): void {
  // Count branching node types
  if (BRANCH_NODE_TYPES.has(node.type)) {
    state.branchCount++;
  }

  // Count short-circuit operators in binary expressions
  if (
    node.type === "binary_expression" ||
    node.type === "augmented_assignment_expression"
  ) {
    const op = node.childForFieldName("operator");
    if (op && BRANCH_OPERATORS.has(op.text)) {
      state.branchCount++;
    }
  }

  // Optional chaining is a hidden branch
  if (node.type === "optional_chain_expression") {
    state.branchCount++;
  }

  // ── Unreachable code detection ──
  // If we're inside a statement_block, check if a terminal statement
  // is followed by more sibling statements at the same level.
  if (node.type === "statement_block") {
    let foundTerminal = false;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;

      if (foundTerminal) {
        // Any statement after a terminal is unreachable
        state.unreachable = true;
        break;
      }
      if (TERMINAL_STATEMENTS.has(child.type)) {
        foundTerminal = true;
      }
    }
  }

  // Recurse into children
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) {
      walkCfg(child, state);
    }
  }
}

/**
 * Computes cyclomatic complexity and builds a lightweight CFG summary
 * for a single function/method AST node.
 */
export function computeCfgAndComplexity(functionNode: SyntaxNode): {
  cyclomaticComplexity: number;
  cfg: CFG;
} {
  const state = { branchCount: 0, unreachable: false };

  walkCfg(functionNode, state);

  // McCabe: M = 1 + branch_count
  const cyclomaticComplexity = 1 + state.branchCount;

  const cfg: CFG = {
    nodes: state.branchCount,
    edges: cyclomaticComplexity + 1, // each decision adds one edge over the baseline path
    unreachableCodeDetected: state.unreachable,
  };

  return { cyclomaticComplexity, cfg };
}

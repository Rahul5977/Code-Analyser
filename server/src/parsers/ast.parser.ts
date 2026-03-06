// ─────────────────────────────────────────────────────────────────────────────
// src/parsers/ast.parser.ts
//
// Phase 2 – AST Parsing & Triage Orchestrator
//
// Pipeline (per file):
//   1. Read source → parse with tree-sitter (TS grammar)
//   2. Extract all function/method/arrow nodes as discrete chunks
//      ★ Inner functions in React components (.jsx/.tsx) are extracted as
//        separate chunks; the parent component chunk has inner bodies replaced
//        with placeholder comments so analysis doesn't double-count code.
//   3. For each chunk:
//      a. Compute Cyclomatic Complexity & CFG
//      b. Compute Halstead Volume
//      c. Detect Code Smells
//   4. Extract & resolve cross-file imports (file-level)
//   5. Assemble ParsedChunk[] + adjacencyList → TriageResult
//
// The main export is:
//   parseAndTriage(filePaths, repoRoot) → Promise<TriageResult>
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

import Parser, { SyntaxNode } from "tree-sitter";
import TypeScriptLanguage from "tree-sitter-typescript";

import { logger } from "../utils/logger";
import type { ParsedChunk, TriageResult } from "../interfaces/triage.interface";

import {
  computeCfgAndComplexity,
  computeHalstead,
  detectSmells,
  extractRawImports,
  resolveImports,
} from "./helpers";

// ─── Constants ───────────────────────────────────────────────────────────────

const LOG_CTX = "ASTParser";

/**
 * AST node types that represent extractable function/method chunks.
 *
 * tree-sitter-typescript uses:
 *   - function_declaration       →  function foo() {}
 *   - function                   →  (anonymous) function() {}
 *   - generator_function_declaration → function* gen() {}
 *   - arrow_function             →  () => {}
 *   - method_definition          →  class { method() {} }
 */
const EXTRACTABLE_NODE_TYPES = new Set([
  "function_declaration",
  "function",
  "generator_function_declaration",
  "generator_function",
  "arrow_function",
  "method_definition",
]);

/** File extensions parsed with the TypeScript grammar (covers JS too) */
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** Extensions that may contain JSX / React components */
const REACT_EXTENSIONS = new Set([".tsx", ".jsx"]);

// ─── Parser Singleton ────────────────────────────────────────────────────────
// tree-sitter Parser is safe to reuse across files.

const tsParser = new Parser();
// TypeScriptLanguage exports { typescript, tsx }
tsParser.setLanguage(TypeScriptLanguage.typescript);

const tsxParser = new Parser();
tsxParser.setLanguage(TypeScriptLanguage.tsx);

/**
 * Returns the correct parser for a given file extension.
 */
function getParser(ext: string): Parser {
  return ext === ".tsx" || ext === ".jsx" ? tsxParser : tsParser;
}

// ─── Deterministic Chunk ID ──────────────────────────────────────────────────

/**
 * Produces a deterministic SHA-256 hash for a chunk, based on its
 * file path, start line, and source code.  This ensures the same
 * code always gets the same ID across runs.
 */
function computeChunkId(
  filePath: string,
  startLine: number,
  code: string,
): string {
  const payload = `${filePath}:${startLine}:${code}`;
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// ─── Function Name Extraction (for logging) ──────────────────────────────────

/**
 * Attempts to extract a human-readable name for a function node.
 * Falls back to "<anonymous>" for arrow functions assigned to variables.
 */
function extractFunctionName(node: SyntaxNode): string {
  // function_declaration / generator_function_declaration → has a `name` field
  const nameNode = node.childForFieldName("name");
  if (nameNode) return nameNode.text;

  // method_definition → name is the first named child
  if (node.type === "method_definition") {
    const methodName = node.childForFieldName("name");
    if (methodName) return methodName.text;
  }

  // arrow_function assigned to a variable:  const foo = () => {}
  // Walk up to find the variable_declarator
  if (
    node.type === "arrow_function" &&
    node.parent?.type === "variable_declarator"
  ) {
    const varName = node.parent.childForFieldName("name");
    if (varName) return varName.text;
  }

  return "<anonymous>";
}

// ─── Inner-function-aware AST Walker ─────────────────────────────────────────

/**
 * A node paired with the list of its direct inner function children, so
 * the parent's code can be de-duplicated.
 */
interface FunctionNodeEntry {
  node: SyntaxNode;
  /** Direct child function nodes (one level deep) */
  innerFunctions: SyntaxNode[];
  /** The parent function node, if this is an inner function */
  parentNode: SyntaxNode | null;
}

/**
 * Recursively walks the AST and collects all function/method nodes,
 * recording parent→child relationships so inner functions can be
 * extracted separately and the parent chunk can have its body de-duped.
 */
function extractFunctionNodesWithHierarchy(
  rootNode: SyntaxNode,
): FunctionNodeEntry[] {
  const entries: FunctionNodeEntry[] = [];
  /** Map from node id → entry for quick parent lookup */
  const entryMap = new Map<number, FunctionNodeEntry>();

  function walk(node: SyntaxNode, parentFn: SyntaxNode | null): void {
    if (EXTRACTABLE_NODE_TYPES.has(node.type)) {
      const entry: FunctionNodeEntry = {
        node,
        innerFunctions: [],
        parentNode: parentFn,
      };
      entries.push(entry);
      entryMap.set(node.id, entry);

      // Register this node as an inner function of its parent
      if (parentFn) {
        const parentEntry = entryMap.get(parentFn.id);
        if (parentEntry) {
          parentEntry.innerFunctions.push(node);
        }
      }

      // Recurse into children with this node as the new parent function
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) walk(child, node);
      }
      return; // don't fall through to generic child walk
    }

    // Non-function node: keep walking with the same parent function
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child, parentFn);
    }
  }

  walk(rootNode, null);
  return entries;
}

/**
 * Given a parent function's source code and its inner function nodes,
 * replace each inner function body with a placeholder comment.
 *
 * This ensures the parent chunk only contains its own logic + signatures
 * of the inner functions, not their full bodies.
 */
function deduplicateParentCode(
  parentNode: SyntaxNode,
  innerFunctions: SyntaxNode[],
  sourceCode: string,
): string {
  if (innerFunctions.length === 0) return parentNode.text;

  // Work in the file-coordinate space, then extract the parent range
  const parentStart = parentNode.startIndex;
  const parentEnd = parentNode.endIndex;
  let parentCode = sourceCode.slice(parentStart, parentEnd);

  // Sort inner functions by their offset within the parent (descending) so
  // that replacements don't shift earlier offsets
  const sorted = [...innerFunctions].sort(
    (a, b) => b.startIndex - a.startIndex,
  );

  for (const inner of sorted) {
    const innerStart = inner.startIndex - parentStart;
    const innerEnd = inner.endIndex - parentStart;
    if (innerStart < 0 || innerEnd > parentCode.length) continue;

    const name = extractFunctionName(inner);
    const placeholder = `/* [inner function: ${name}] — extracted as separate chunk */`;
    parentCode =
      parentCode.slice(0, innerStart) +
      placeholder +
      parentCode.slice(innerEnd);
  }

  return parentCode;
}

// ─── React Component Detection ───────────────────────────────────────────────

/**
 * Heuristic: returns true if the function node likely represents a React
 * component (returns JSX, or its name starts with an uppercase letter).
 */
function isLikelyReactComponent(node: SyntaxNode, ext: string): boolean {
  if (!REACT_EXTENSIONS.has(ext)) return false;

  const name = extractFunctionName(node);

  // React convention: component names start with uppercase
  if (name !== "<anonymous>" && /^[A-Z]/.test(name)) return true;

  // Check if the function body contains a jsx_element or jsx_fragment return
  return containsJSX(node);
}

/** Recursively check if a node contains any JSX elements */
function containsJSX(node: SyntaxNode): boolean {
  if (
    node.type === "jsx_element" ||
    node.type === "jsx_self_closing_element" ||
    node.type === "jsx_fragment"
  ) {
    return true;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && containsJSX(child)) return true;
  }
  return false;
}

// ─── Single File Processing ──────────────────────────────────────────────────

interface FileParseResult {
  chunks: ParsedChunk[];
  rawImports: string[];
  resolvedDeps: string[];
}

/**
 * Parses a single source file and extracts all function chunks with
 * full metrics.  For React files (.tsx/.jsx), inner functions within
 * components are extracted as their own chunks, and the parent component
 * chunk has the inner bodies replaced with placeholders to avoid
 * double-counting code.
 */
async function processFile(
  filePath: string,
  repoRoot: string,
): Promise<FileParseResult> {
  const ext = path.extname(filePath).toLowerCase();

  // Only process files we can parse
  if (!TS_EXTENSIONS.has(ext)) {
    logger.debug(LOG_CTX, `Skipping non-JS/TS file: ${filePath}`);
    return { chunks: [], rawImports: [], resolvedDeps: [] };
  }

  const source = await fs.readFile(filePath, "utf-8");
  const parser = getParser(ext);
  const tree = parser.parse(source);

  // ── 1. Extract raw imports (file-level) ──
  const rawImports = extractRawImports(tree.rootNode);

  // ── 2. Resolve imports to absolute paths ──
  const fileDir = path.dirname(filePath);
  const resolvedDeps = resolveImports(rawImports, fileDir, repoRoot);

  // ── 3. Extract function nodes with parent/child hierarchy ──
  const functionEntries = extractFunctionNodesWithHierarchy(tree.rootNode);

  const isReactFile = REACT_EXTENSIONS.has(ext);

  logger.debug(
    LOG_CTX,
    `${path.relative(repoRoot, filePath)}: ${functionEntries.length} functions (react=${isReactFile}), ${rawImports.length} imports`,
  );

  // ── 4. Build a ParsedChunk for each function ──
  const chunks: ParsedChunk[] = functionEntries.map((entry) => {
    const { node: fnNode, innerFunctions, parentNode } = entry;

    // Determine code: if this node has inner functions, de-duplicate
    const hasInnerFns = innerFunctions.length > 0;
    const code = hasInnerFns
      ? deduplicateParentCode(fnNode, innerFunctions, source)
      : fnNode.text;

    const startLine = fnNode.startPosition.row + 1; // tree-sitter is 0-based
    const endLine = fnNode.endPosition.row + 1;

    // 4a. Cyclomatic complexity & CFG (use original node for accurate analysis)
    const { cyclomaticComplexity, cfg } = computeCfgAndComplexity(fnNode);

    // 4b. Halstead volume
    const halstead = computeHalstead(fnNode);

    // 4c. Code smells
    const smells = detectSmells(fnNode, filePath);

    // 4d. Deterministic chunk ID
    const id = computeChunkId(filePath, startLine, code);

    const name = extractFunctionName(fnNode);
    const isReactComp = isReactFile && isLikelyReactComponent(fnNode, ext);
    const isInner = parentNode !== null;

    logger.debug(
      LOG_CTX,
      `  → ${name}  lines=${startLine}-${endLine}  CC=${cyclomaticComplexity}  HV=${halstead.volume}  smells=${smells.length}` +
        (isReactComp ? "  [React Component]" : "") +
        (isInner ? "  [inner function]" : "") +
        (hasInnerFns
          ? `  [${innerFunctions.length} inner fn(s) extracted]`
          : ""),
    );

    return {
      id,
      code,
      filePath,
      startLine,
      endLine,
      imports: rawImports,
      resolvedDeps,
      cyclomaticComplexity,
      halsteadVolume: halstead.volume,
      smells,
      cfg,
    };
  });

  return { chunks, rawImports, resolvedDeps };
}

// ─── Main Export ─────────────────────────────────────────────────────────────

/**
 * **parseAndTriage** — the single public entry point for Phase 2.
 *
 * Processes an array of source file paths, extracts every function/method
 * as a `ParsedChunk` with full complexity metrics, code smells, and a
 * cross-file dependency adjacency list.
 *
 * @param filePaths  Absolute paths to the source files (from Phase 1 manifest).
 * @param repoRoot   Absolute path to the root of the cloned repository.
 * @returns          A `TriageResult` containing all chunks and the adjacency list.
 */
export const parseAndTriage = async (
  filePaths: string[],
  repoRoot: string,
): Promise<TriageResult> => {
  logger.info(LOG_CTX, `════════════════════════════════════════════════════`);
  logger.info(
    LOG_CTX,
    `Starting AST Parsing & Triage  files=${filePaths.length}`,
  );
  logger.info(LOG_CTX, `════════════════════════════════════════════════════`);

  const startTime = Date.now();

  const allChunks: ParsedChunk[] = [];
  const adjacencyList: Record<string, string[]> = {};

  // ── Process files sequentially to keep memory bounded ──
  // (tree-sitter parses are CPU-bound; parallelism here would just
  //  increase peak RSS without meaningful speedup)
  for (const filePath of filePaths) {
    try {
      const result = await processFile(filePath, repoRoot);

      allChunks.push(...result.chunks);

      // Build the adjacency list entry for this file
      if (result.resolvedDeps.length > 0) {
        adjacencyList[filePath] = result.resolvedDeps;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(LOG_CTX, `Failed to parse ${filePath}: ${message}`);
      // Continue with remaining files — don't let one bad file crash the pipeline
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  // ── Summary stats ──
  const totalSmells = allChunks.reduce((sum, c) => sum + c.smells.length, 0);
  const avgComplexity =
    allChunks.length > 0
      ? (
          allChunks.reduce((sum, c) => sum + c.cyclomaticComplexity, 0) /
          allChunks.length
        ).toFixed(1)
      : "0";

  logger.info(LOG_CTX, `Triage complete in ${elapsed}s`);
  logger.info(LOG_CTX, `  Chunks extracted: ${allChunks.length}`);
  logger.info(
    LOG_CTX,
    `  Files in dep graph: ${Object.keys(adjacencyList).length}`,
  );
  logger.info(LOG_CTX, `  Total smells: ${totalSmells}`);
  logger.info(LOG_CTX, `  Avg cyclomatic complexity: ${avgComplexity}`);

  return { chunks: allChunks, adjacencyList };
};

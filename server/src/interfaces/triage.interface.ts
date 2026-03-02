// ─────────────────────────────────────────────────────────────────────────────
// src/interfaces/triage.interface.ts
//
// Phase 2 – Canonical type definitions for AST Parsing & Triage.
// These types flow from the parser into every downstream analysis agent.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A statically-detected code smell found within a single function/method.
 * Each smell is rule-based (no AI) and pinpointed to a line number.
 */
export interface CodeSmell {
  type:
    | "LongFunction"
    | "TooManyParams"
    | "CallbackHell"
    | "ConsoleLog"
    | "HardcodedSecret";
  message: string;
  line: number;
}

/**
 * Lightweight Control Flow Graph derived from AST branch analysis.
 * `nodes` = basic blocks / branch nodes, `edges` = paths between them.
 */
export interface CFG {
  nodes: number;
  edges: number;
  unreachableCodeDetected: boolean;
}

/**
 * A discrete "chunk" of analysable code — one function, method, or arrow fn.
 * Carries all static metrics needed for downstream AI agents.
 */
export interface ParsedChunk {
  /** Deterministic content-hash (SHA-256 of filePath + startLine + code) */
  id: string;

  /** The raw source code of the function/method */
  code: string;

  /** Absolute path of the file this chunk was extracted from */
  filePath: string;

  /** 1-based start line in the original file */
  startLine: number;

  /** 1-based end line in the original file */
  endLine: number;

  /** Raw import specifiers found in the enclosing file (e.g., '@utils/math') */
  imports: string[];

  /** Absolute file paths those imports resolve to (via enhanced-resolve) */
  resolvedDeps: string[];

  /** McCabe cyclomatic complexity of this chunk */
  cyclomaticComplexity: number;

  /** Halstead Volume: N × log₂(n) */
  halsteadVolume: number;

  /** Rule-based code smells detected in this chunk */
  smells: CodeSmell[];

  /** Lightweight control-flow graph summary */
  cfg: CFG;
}

/**
 * The complete output of the Phase 2 triage pass over a set of source files.
 */
export interface TriageResult {
  /** Every extracted function/method as a ParsedChunk */
  chunks: ParsedChunk[];

  /** File-level dependency graph: filePath → array of resolved absolute paths it imports */
  adjacencyList: Record<string, string[]>;
}

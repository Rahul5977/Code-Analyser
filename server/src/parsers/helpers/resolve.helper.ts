// ─────────────────────────────────────────────────────────────────────────────
// src/parsers/helpers/resolve.helper.ts
//
// Cross-File Dependency Resolution using `enhanced-resolve`.
//
// Responsibilities:
//   1. Walk the file-level AST to extract raw import specifiers
//      (ES `import` and CommonJS `require()`)
//   2. Resolve each specifier to an absolute file path on disk
//   3. Ignore Node.js built-in modules (fs, path, http, etc.)
//   4. Gracefully skip unresolvable specifiers (external npm packages)
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path";
import module from "node:module";
import { SyntaxNode } from "tree-sitter";
import { create } from "enhanced-resolve";
import { logger } from "../../utils/logger";

const LOG_CTX = "DependencyResolver";

// ── Node.js built-in modules (skip these) ────────────────────────────────────
const NODE_BUILTINS = new Set(
  module.builtinModules.flatMap((m) => [m, `node:${m}`]),
);

// ─── Create a cached synchronous resolver ────────────────────────────────────

/**
 * Builds a synchronous resolver configured for TypeScript / JavaScript
 * projects.  Honours tsconfig paths indirectly by checking common extensions.
 */
function buildSyncResolver(
  repoRoot: string,
): (
  context: Record<string, unknown>,
  dir: string,
  specifier: string,
) => string | false {
  const resolveSync = create.sync({
    // File extensions to probe (in priority order)
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],

    // Honour "main" / "module" / "types" fields in package.json
    mainFields: ["main", "module", "types"],

    // Support directory imports (index.ts, index.js, etc.)
    mainFiles: ["index"],

    // Where to look for node_modules (walk up from repoRoot)
    modules: ["node_modules", path.resolve(repoRoot, "node_modules")],

    // Alias mapping — could be extended to read tsconfig.paths
    alias: {},

    // Symlinks
    symlinks: true,
  });

  // enhanced-resolve's runtime signature is (context, path, request) → string | false
  // but the shipped type declarations only expose (path, request).
  // We cast to the correct 3-arity signature.
  return resolveSync as unknown as (
    context: Record<string, unknown>,
    dir: string,
    specifier: string,
  ) => string | false;
}

// ─── AST Import Extraction ───────────────────────────────────────────────────

/**
 * Extracts raw import specifier strings from the file-level AST.
 *
 * Handles:
 *   - `import X from 'specifier'`
 *   - `import { X } from 'specifier'`
 *   - `import 'specifier'`  (side-effect imports)
 *   - `export { X } from 'specifier'`
 *   - `const X = require('specifier')`
 *   - `import('specifier')`  (dynamic imports)
 */
export function extractRawImports(rootNode: SyntaxNode): string[] {
  const specifiers: string[] = [];

  function walk(node: SyntaxNode): void {
    // ── ES import / export ──
    if (node.type === "import_statement" || node.type === "export_statement") {
      const source = node.childForFieldName("source");
      if (
        source &&
        (source.type === "string" || source.type === "template_string")
      ) {
        const raw = stripQuotes(source.text);
        if (raw) specifiers.push(raw);
      }
    }

    // ── CommonJS require('…') ──
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn?.text === "require") {
        const args = node.childForFieldName("arguments");
        const firstArg = args?.namedChild(0);
        if (firstArg && firstArg.type === "string") {
          const raw = stripQuotes(firstArg.text);
          if (raw) specifiers.push(raw);
        }
      }

      // ── Dynamic import('…') ──
      if (fn?.type === "import") {
        const args = node.childForFieldName("arguments");
        const firstArg = args?.namedChild(0);
        if (firstArg && firstArg.type === "string") {
          const raw = stripQuotes(firstArg.text);
          if (raw) specifiers.push(raw);
        }
      }
    }

    // Recurse — but no need to go deep into function bodies for file-level imports
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child);
    }
  }

  walk(rootNode);

  // Deduplicate while preserving order
  return [...new Set(specifiers)];
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolves an array of raw import specifiers to absolute file paths.
 *
 * - Node built-ins are silently skipped.
 * - Bare specifiers that point into node_modules are silently skipped
 *   (we only care about local cross-file deps).
 * - Unresolvable specifiers emit a debug log and are skipped.
 */
export function resolveImports(
  rawImports: string[],
  fileDir: string,
  repoRoot: string,
): string[] {
  const resolveSync = buildSyncResolver(repoRoot);
  const resolved: string[] = [];

  for (const specifier of rawImports) {
    // Skip Node.js built-ins
    if (NODE_BUILTINS.has(specifier)) continue;

    // Skip bare specifiers that clearly point to npm packages
    // (they don't start with . or /)
    const isRelative = specifier.startsWith(".") || specifier.startsWith("/");

    try {
      const result = resolveSync({}, fileDir, specifier);
      if (result && typeof result === "string") {
        // Only include files within the repo (skip node_modules unless relative)
        const isInsideRepo = result.startsWith(repoRoot);
        const isInNodeModules = result.includes("node_modules");

        if (isInsideRepo && !isInNodeModules) {
          resolved.push(result);
        } else if (isRelative && !isInNodeModules) {
          // Relative import that resolved outside the repo? Include anyway.
          resolved.push(result);
        }
        // Otherwise it's an npm package — skip silently
      }
    } catch {
      logger.debug(
        LOG_CTX,
        `Could not resolve "${specifier}" from ${fileDir} — skipping.`,
      );
    }
  }

  return [...new Set(resolved)];
}

// ── Utility ──────────────────────────────────────────────────────────────────

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith("`") && s.endsWith("`"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// src/council/tools/architecture.tools.ts
//
// Architecture Agent Tools — all graph-based, no raw code analysis:
//   1. find_circular_dependencies
//   2. compute_coupling_score
//   3. find_god_classes
//   4. detect_layer_violations
// ─────────────────────────────────────────────────────────────────────────────

import type {
  AgentTool,
  CouplingScore,
} from "../../interfaces/council.interface";
import type {
  TriageResult,
  ParsedChunk,
} from "../../interfaces/triage.interface";

// ─── Dependency Graph Helper ─────────────────────────────────────────────────

/** Pre-computed graph structures derived from the TriageResult */
export interface DepGraph {
  adjacencyList: Record<string, string[]>;
  reverseAdj: Record<string, string[]>;
  fileToChunks: Map<string, ParsedChunk[]>;
  allFiles: string[];
}

export function buildDepGraph(triage: TriageResult): DepGraph {
  const { chunks, adjacencyList } = triage;
  const fileToChunks = new Map<string, ParsedChunk[]>();
  for (const chunk of chunks) {
    const arr = fileToChunks.get(chunk.filePath) ?? [];
    arr.push(chunk);
    fileToChunks.set(chunk.filePath, arr);
  }

  // Build reverse adjacency (who imports me?)
  const reverseAdj: Record<string, string[]> = {};
  for (const [src, deps] of Object.entries(adjacencyList)) {
    for (const dep of deps) {
      const arr = reverseAdj[dep] ?? [];
      arr.push(src);
      reverseAdj[dep] = arr;
    }
  }

  const allFiles = [
    ...new Set([
      ...Object.keys(adjacencyList),
      ...Object.values(adjacencyList).flat(),
      ...chunks.map((c) => c.filePath),
    ]),
  ];

  return { adjacencyList, reverseAdj, fileToChunks, allFiles };
}

// ─── find_circular_dependencies ──────────────────────────────────────────────

export function createFindCircularDependenciesTool(graph: DepGraph): AgentTool {
  return {
    name: "find_circular_dependencies",
    description:
      "Detects circular (cyclic) dependency chains in the file import graph. " +
      "Returns all cycles found as arrays of file paths.",
    parameters: {
      type: "object",
      properties: {
        maxCycles: {
          type: "number",
          description: "Maximum number of cycles to return (default: 20).",
        },
      },
    },
    execute: async (args) => {
      const maxCycles = (args["maxCycles"] as number) ?? 20;

      try {
        const cycles = findCycles(graph.adjacencyList, maxCycles);
        return JSON.stringify({
          tool: "find_circular_dependencies",
          cycleCount: cycles.length,
          cycles: cycles.map((c) => ({
            files: c,
            length: c.length,
          })),
          message:
            cycles.length > 0
              ? `Found ${cycles.length} circular dependency chain(s).`
              : "No circular dependencies detected.",
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `Cycle detection failed: ${msg}` });
      }
    },
  };
}

function findCycles(
  adj: Record<string, string[]>,
  maxCycles: number,
): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): void {
    if (cycles.length >= maxCycles) return;

    visited.add(node);
    recStack.add(node);
    path.push(node);

    const neighbors = adj[node] ?? [];
    for (const neighbor of neighbors) {
      if (cycles.length >= maxCycles) return;

      if (recStack.has(neighbor)) {
        // Found a cycle — extract it
        const cycleStart = path.indexOf(neighbor);
        if (cycleStart !== -1) {
          cycles.push([...path.slice(cycleStart), neighbor]);
        }
      } else if (!visited.has(neighbor)) {
        dfs(neighbor);
      }
    }

    path.pop();
    recStack.delete(node);
  }

  for (const node of Object.keys(adj)) {
    if (!visited.has(node) && cycles.length < maxCycles) {
      dfs(node);
    }
  }

  return cycles;
}

// ─── compute_coupling_score ──────────────────────────────────────────────────

export function createComputeCouplingScoreTool(graph: DepGraph): AgentTool {
  return {
    name: "compute_coupling_score",
    description:
      "Computes the coupling score between two modules (files/directories). " +
      "Score ranges from 0.0 (no coupling) to 1.0 (highly coupled). " +
      "If no specific modules given, returns the top coupled pairs.",
    parameters: {
      type: "object",
      properties: {
        moduleA: {
          type: "string",
          description: "First module path or directory prefix (optional).",
        },
        moduleB: {
          type: "string",
          description: "Second module path or directory prefix (optional).",
        },
        topK: {
          type: "number",
          description:
            "Number of top coupled pairs to return if no specific modules given (default: 10).",
        },
      },
    },
    execute: async (args) => {
      const moduleA = args["moduleA"] as string | undefined;
      const moduleB = args["moduleB"] as string | undefined;
      const topK = (args["topK"] as number) ?? 10;

      try {
        if (moduleA && moduleB) {
          const score = computeCoupling(graph, moduleA, moduleB);
          return JSON.stringify(score);
        }

        // Compute coupling for all pairs of files with shared dependencies
        const scores = computeAllCouplingScores(graph, topK);
        return JSON.stringify({
          tool: "compute_coupling_score",
          topCoupledPairs: scores,
          message: `Computed coupling for top ${scores.length} file pairs.`,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `Coupling computation failed: ${msg}` });
      }
    },
  };
}

function computeCoupling(
  graph: DepGraph,
  moduleA: string,
  moduleB: string,
): CouplingScore {
  const depsA = new Set(graph.adjacencyList[moduleA] ?? []);
  const depsB = new Set(graph.adjacencyList[moduleB] ?? []);

  // Shared dependencies
  const shared = [...depsA].filter((d) => depsB.has(d));

  // Direct coupling (A imports B or B imports A)
  const directAtoB = depsA.has(moduleB) ? 1 : 0;
  const directBtoA = depsB.has(moduleA) ? 1 : 0;

  const totalUniqueDeps = new Set([...depsA, ...depsB]).size;
  const sharedRatio = totalUniqueDeps > 0 ? shared.length / totalUniqueDeps : 0;

  // Score = weighted combination of direct coupling and shared deps
  const score = Math.min(
    1.0,
    directAtoB * 0.3 + directBtoA * 0.3 + sharedRatio * 0.4,
  );

  return {
    moduleA,
    moduleB,
    score: +score.toFixed(3),
    sharedDependencies: shared.length,
  };
}

function computeAllCouplingScores(
  graph: DepGraph,
  topK: number,
): CouplingScore[] {
  const filesWithDeps = Object.keys(graph.adjacencyList);
  const scores: CouplingScore[] = [];

  for (let i = 0; i < filesWithDeps.length; i++) {
    for (let j = i + 1; j < filesWithDeps.length; j++) {
      const a = filesWithDeps[i]!;
      const b = filesWithDeps[j]!;
      const score = computeCoupling(graph, a, b);
      if (score.score > 0) {
        scores.push(score);
      }
    }
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, topK);
}

// ─── find_god_classes ────────────────────────────────────────────────────────

export function createFindGodClassesTool(graph: DepGraph): AgentTool {
  return {
    name: "find_god_classes",
    description:
      "Identifies 'god classes' / 'god files' — modules with an excessive " +
      "number of outgoing dependencies and chunks, indicating they do too much.",
    parameters: {
      type: "object",
      properties: {
        minOutgoingEdges: {
          type: "number",
          description:
            "Minimum outgoing dependency count to flag as 'god class' (default: 5).",
        },
        limit: {
          type: "number",
          description: "Max results (default: 15).",
        },
      },
    },
    execute: async (args) => {
      const minOutgoingEdges = (args["minOutgoingEdges"] as number) ?? 5;
      const limit = (args["limit"] as number) ?? 15;

      try {
        const results: Array<{
          filePath: string;
          outgoingEdges: number;
          chunkCount: number;
          totalComplexity: number;
        }> = [];

        for (const [filePath, deps] of Object.entries(graph.adjacencyList)) {
          if (deps.length >= minOutgoingEdges) {
            const chunks = graph.fileToChunks.get(filePath) ?? [];
            results.push({
              filePath,
              outgoingEdges: deps.length,
              chunkCount: chunks.length,
              totalComplexity: chunks.reduce(
                (s, c) => s + c.cyclomaticComplexity,
                0,
              ),
            });
          }
        }

        results.sort((a, b) => b.outgoingEdges - a.outgoingEdges);
        const limited = results.slice(0, limit);

        return JSON.stringify({
          tool: "find_god_classes",
          threshold: minOutgoingEdges,
          found: limited.length,
          godClasses: limited,
          message:
            limited.length > 0
              ? `Found ${limited.length} file(s) with ≥${minOutgoingEdges} outgoing dependencies.`
              : "No god classes detected at this threshold.",
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `God class detection failed: ${msg}` });
      }
    },
  };
}

// ─── detect_layer_violations ─────────────────────────────────────────────────

export function createDetectLayerViolationsTool(graph: DepGraph): AgentTool {
  return {
    name: "detect_layer_violations",
    description:
      "Detects architectural layer violations based on a layer configuration. " +
      "For example, if 'controllers' should not import from 'routes', this tool " +
      "will flag such violations. Auto-detects common patterns if no config given.",
    parameters: {
      type: "object",
      properties: {
        layerConfig: {
          type: "object",
          description:
            "A map of layer names to path patterns. " +
            'Example: {"controllers": ["src/controllers"], "services": ["src/services"]}',
        },
        rules: {
          type: "array",
          items: { type: "string" },
          description:
            "Layer dependency rules as 'A -> B' (A can import B). " +
            'Example: ["controllers -> services", "services -> models"]',
        },
      },
    },
    execute: async (args) => {
      try {
        const layerConfig =
          (args["layerConfig"] as Record<string, string[]>) ??
          autoDetectLayers(graph.allFiles);
        const rules = (args["rules"] as string[]) ?? [];

        const violations: Array<{
          source: string;
          target: string;
          sourceLayer: string;
          targetLayer: string;
          rule: string;
        }> = [];

        // Build layer membership
        const fileToLayer = new Map<string, string>();
        for (const [layer, patterns] of Object.entries(layerConfig)) {
          for (const file of graph.allFiles) {
            for (const pattern of patterns) {
              if (file.includes(pattern)) {
                fileToLayer.set(file, layer);
              }
            }
          }
        }

        // Parse rules into allowed edges
        const allowedEdges = new Set<string>();
        for (const rule of rules) {
          const [from, to] = rule.split("->").map((s) => s.trim());
          if (from && to) allowedEdges.add(`${from}->${to}`);
        }

        // Check each import edge against rules
        for (const [source, deps] of Object.entries(graph.adjacencyList)) {
          const sourceLayer = fileToLayer.get(source);
          if (!sourceLayer) continue;

          for (const target of deps) {
            const targetLayer = fileToLayer.get(target);
            if (!targetLayer || targetLayer === sourceLayer) continue;

            // If rules are defined, check if the edge is allowed
            if (rules.length > 0) {
              const edgeKey = `${sourceLayer}->${targetLayer}`;
              if (!allowedEdges.has(edgeKey)) {
                violations.push({
                  source,
                  target,
                  sourceLayer,
                  targetLayer,
                  rule: `${sourceLayer} should not import from ${targetLayer}`,
                });
              }
            }
          }
        }

        return JSON.stringify({
          tool: "detect_layer_violations",
          detectedLayers: layerConfig,
          violationCount: violations.length,
          violations: violations.slice(0, 30),
          message:
            violations.length > 0
              ? `Found ${violations.length} layer violation(s).`
              : "No layer violations detected.",
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({
          error: `Layer violation detection failed: ${msg}`,
        });
      }
    },
  };
}

/** Auto-detect common project structure layers from file paths */
function autoDetectLayers(files: string[]): Record<string, string[]> {
  const layers: Record<string, string[]> = {};
  const knownLayers = [
    "controllers",
    "routes",
    "services",
    "models",
    "middleware",
    "utils",
    "helpers",
    "config",
    "lib",
    "core",
    "api",
    "handlers",
    "repositories",
    "domain",
    "infrastructure",
    "presentation",
    "application",
  ];

  for (const layer of knownLayers) {
    const matching = files.filter(
      (f) => f.includes(`/${layer}/`) || f.includes(`\\${layer}\\`),
    );
    if (matching.length > 0) {
      layers[layer] = [`/${layer}/`];
    }
  }

  return layers;
}

// ─────────────────────────────────────────────────────────────────────────────
// src/council/tools/index.ts – Barrel export for all agent tools
// ─────────────────────────────────────────────────────────────────────────────

export {
  createFetchChunkWithContextTool,
  createQueryKnowledgeGraphTool,
} from "./shared.tools";
export type { ToolFactoryDeps } from "./shared.tools";

export {
  createCheckCveDatabaseTool,
  createRunSemgrepRuleTool,
  createTraceDataFlowTool,
} from "./security.tools";

export {
  createEstimateComplexityClassTool,
  createFindSimilarPatternsTool,
} from "./performance.tools";

export {
  buildDepGraph,
  createFindCircularDependenciesTool,
  createComputeCouplingScoreTool,
  createFindGodClassesTool,
  createDetectLayerViolationsTool,
} from "./architecture.tools";
export type { DepGraph } from "./architecture.tools";

export { createVerifyFindingTool } from "./critique.tools";

export {
  createGenerateFixedCodeSnippetTool,
  createFetchDocumentationReferenceTool,
} from "./synthesis.tools";

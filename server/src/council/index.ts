// ─────────────────────────────────────────────────────────────────────────────
// src/council/index.ts – Barrel export for Phase 4: LangGraph Council
// ─────────────────────────────────────────────────────────────────────────────

// ── LLM Providers ──
export { createOpenAiLlm } from "./openai-llm";
export { createSmartStubLlm } from "./smart-stub-llm";

// ── Council Orchestrator (main entry point) ──
export { runCouncil } from "./council.orchestrator";
export type { CouncilDependencies } from "./council.orchestrator";

// ── ReAct Engine ──
export { executeReActLoop } from "./react-engine";
export type { ReActConfig, ReActResult } from "./react-engine";

// ── Agents ──
export {
  runOrchestratorAgent,
  runSecurityAgent,
  runPerformanceAgent,
  runArchitectureAgent,
  runTestCoverageAgent,
  runCritiqueAgent,
  runSynthesisAgent,
} from "./agents";
export type { PerformanceAgentDeps, CritiqueResult } from "./agents";

// ── Tools ──
export {
  createFetchChunkWithContextTool,
  createQueryKnowledgeGraphTool,
  createCheckCveDatabaseTool,
  createRunSemgrepRuleTool,
  createTraceDataFlowTool,
  createEstimateComplexityClassTool,
  createFindSimilarPatternsTool,
  createFindCircularDependenciesTool,
  createComputeCouplingScoreTool,
  createFindGodClassesTool,
  createDetectLayerViolationsTool,
  createVerifyFindingTool,
  createGenerateFixedCodeSnippetTool,
  createFetchDocumentationReferenceTool,
  buildDepGraph,
} from "./tools";
export type { ToolFactoryDeps, DepGraph } from "./tools";

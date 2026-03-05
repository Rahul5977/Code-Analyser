// ─────────────────────────────────────────────────────────────────────────────
// src/council/agents/index.ts – Barrel export for all council agents
// ─────────────────────────────────────────────────────────────────────────────

export { runOrchestratorAgent } from "./orchestrator.agent";
export { runSecurityAgent } from "./security.agent";
export { runPerformanceAgent } from "./performance.agent";
export type { PerformanceAgentDeps } from "./performance.agent";
export { runArchitectureAgent } from "./architecture.agent";
export { runTestCoverageAgent } from "./test-coverage.agent";
export { runCritiqueAgent } from "./critique.agent";
export type { CritiqueResult } from "./critique.agent";
export { runSynthesisAgent } from "./synthesis.agent";

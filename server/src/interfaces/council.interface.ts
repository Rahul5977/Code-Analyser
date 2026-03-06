// ─────────────────────────────────────────────────────────────────────────────
// src/interfaces/council.interface.ts
//
// Phase 4 – Canonical type definitions for the LangGraph Council.
//
// Defines the contracts for:
//   • Agent state machine (graph topology)
//   • Tool definitions (ReAct loop)
//   • Finding / report data structures
//   • LLM abstraction (model-agnostic)
// ─────────────────────────────────────────────────────────────────────────────

import type { ParsedChunk, TriageResult } from "./triage.interface";
import type { RepoManifest } from "./repo-manifest.interface";
import type { GraphRagContext } from "./graph-rag.interface";

// ─── LLM Abstraction ────────────────────────────────────────────────────────

/**
 * A single message in a conversation with an LLM.
 */
export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** When role === "tool", this is the tool_call_id */
  toolCallId?: string;
  /** When role === "assistant" and it wants to call tools */
  toolCalls?: ToolCall[];
}

/**
 * An LLM's request to invoke a tool.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Model-agnostic LLM completion function.
 * Inject OpenAI, Anthropic, Ollama, or any provider.
 */
export type LLMCompletionFn = (
  messages: LLMMessage[],
  tools?: ToolDefinition[],
  temperature?: number,
) => Promise<LLMMessage>;

/**
 * JSON Schema-style tool definition passed to the LLM.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
}

// ─── Agent Tool Contract ─────────────────────────────────────────────────────

/**
 * A callable tool available to an agent during its ReAct loop.
 */
export interface AgentTool {
  /** Unique name matching the ToolDefinition.name */
  name: string;
  /** Human-readable description for the LLM */
  description: string;
  /** JSON Schema for the parameters */
  parameters: Record<string, unknown>;
  /** The actual implementation */
  execute: (args: Record<string, unknown>) => Promise<string>;
}

// ─── Severity & Confidence ───────────────────────────────────────────────────

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type CritiqueVerdict = "CONFIRMED" | "PLAUSIBLE" | "DISPUTED";

// ─── Finding (output of Security / Performance / Architecture agents) ────────

/**
 * A single structured finding produced by an analysis agent.
 */
export interface Finding {
  /** Unique ID for this finding */
  id: string;
  /** Which agent produced this finding */
  agentId: AgentId;
  /** Category of the issue */
  category: string;
  /** Short title */
  title: string;
  /** Detailed description */
  description: string;
  /** Severity classification */
  severity: Severity;
  /** Agent's self-assessed confidence */
  confidence: Confidence;
  /** File path where the issue was found */
  filePath: string;
  /** Start line (1-based) */
  startLine: number;
  /** End line (1-based) */
  endLine: number;
  /** The exact code snippet cited as evidence */
  codeSnippet: string;
  /** IDs of chunks involved */
  chunkIds: string[];
  /** Tool calls that corroborated this finding (audit trail) */
  evidence: EvidenceItem[];
  /** Critique verdict (filled by Debate agent) */
  critiqueVerdict?: CritiqueVerdict;
  /** Critique reasoning */
  critiqueReason?: string;
}

/**
 * An audit trail entry — records which tool was called and what it returned.
 */
export interface EvidenceItem {
  toolName: string;
  input: Record<string, unknown>;
  output: string;
  timestamp: string;
}

// ─── CVE Record (from OSV API) ──────────────────────────────────────────────

export interface CVERecord {
  id: string;
  summary: string;
  severity: Severity;
  aliases: string[];
  affectedVersions: string[];
  references: string[];
}

// ─── Complexity Estimation ───────────────────────────────────────────────────

export interface ComplexityEstimate {
  chunkId: string;
  estimatedClass: string; // "O(1)" | "O(n)" | "O(n²)" | "O(n³)" | "O(2^n)" etc.
  reasoning: string;
  nestedLoopDepth: number;
  recursionDetected: boolean;
}

// ─── Architecture Metrics ────────────────────────────────────────────────────

export interface CouplingScore {
  moduleA: string;
  moduleB: string;
  score: number; // 0.0 – 1.0
  sharedDependencies: number;
}

export interface ArchitectureReport {
  circularDependencies: string[][];
  couplingScores: CouplingScore[];
  godClasses: { filePath: string; outgoingEdges: number; chunkCount: number }[];
  layerViolations: { source: string; target: string; rule: string }[];
  detectedPattern: string; // "MVC" | "Hexagonal" | "Monolith" | "Microservice" etc.
  summary: string;
}

// ─── Test Coverage Correlation ───────────────────────────────────────────────

export interface CoverageGap {
  chunkId: string;
  filePath: string;
  functionName: string;
  cyclomaticComplexity: number;
  hasVulnerability: boolean;
  testFilePaths: string[];
  riskTier: 1 | 2 | 3; // 1 = highest risk (complex + vulnerable + untested)
}

export interface CoverageReport {
  totalSourceFiles: number;
  totalTestFiles: number;
  mappedTests: number;
  gaps: CoverageGap[];
  summary: string;
}

// ─── Finding Card (output of Synthesis agent) ────────────────────────────────

export interface FindingCard {
  finding: Finding;
  fixedCode: string;
  /** The narrow code window (vulnerable lines ± buffer) that was actually sent to the LLM for fixing */
  vulnerableWindow?: {
    code: string;
    startLine: number;
    endLine: number;
  };
  explanations: {
    junior: string;
    senior: string;
    manager: string;
  };
  references: { title: string; url: string }[];
}

// ─── Analysis Plan (output of Orchestrator agent) ────────────────────────────

export interface InvestigationTarget {
  chunkIds: string[];
  filePaths: string[];
  reason: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
}

export interface AnalysisPlan {
  securityTargets: InvestigationTarget[];
  performanceTargets: InvestigationTarget[];
  architectureScope: {
    focusModules: string[];
    layerConfig?: Record<string, string[]>;
  };
  testCoverageEnabled: boolean;
  crossReferences: {
    description: string;
    filePaths: string[];
  }[];
}

// ─── Agent IDs ───────────────────────────────────────────────────────────────

export type AgentId =
  | "orchestrator"
  | "security"
  | "performance"
  | "architecture"
  | "test-coverage"
  | "critique"
  | "synthesis";

// ─── Council State (the shared state passed through the graph) ───────────────

/**
 * The mutable state object that flows through every node in the council graph.
 * Each agent reads from and writes to specific fields.
 */
export interface CouncilState {
  // ── Inputs (set at the start) ──
  repoId: string;
  manifest: RepoManifest;
  triage: TriageResult;

  // ── Orchestrator output ──
  analysisPlan?: AnalysisPlan;

  // ── Agent outputs ──
  securityFindings: Finding[];
  performanceFindings: Finding[];
  architectureReport?: ArchitectureReport;
  coverageReport?: CoverageReport;

  // ── Critique output ──
  critiquedFindings: Finding[];
  disputeRate: number; // 0.0 – 1.0
  reinvestigationRequested: boolean;
  reinvestigationCount: number;

  // ── Synthesis output ──
  findingCards: FindingCard[];

  // ── Metadata ──
  errors: { agentId: AgentId; message: string; timestamp: string }[];
  startedAt: string;
  completedAt?: string;
  totalDurationMs?: number;
}

// ─── Council Config ──────────────────────────────────────────────────────────

export interface CouncilConfig {
  /** The LLM completion function to inject into all agents */
  llmFn: LLMCompletionFn;
  /** Max ReAct iterations per agent (prevent infinite loops) */
  maxIterations: number;
  /** Max re-investigation cycles if critique disputes >60% */
  maxReinvestigations: number;
  /** Dispute rate threshold to trigger re-investigation */
  disputeThreshold: number;
  /** Temperature for LLM calls */
  temperature: number;
}

// ─── Final Report ────────────────────────────────────────────────────────────

export interface CouncilReport {
  repoId: string;
  summary: string;
  findingCards: FindingCard[];
  architectureReport?: ArchitectureReport;
  coverageReport?: CoverageReport;
  metadata: {
    totalFindings: number;
    confirmedFindings: number;
    plausibleFindings: number;
    disputedFindings: number;
    reinvestigationCycles: number;
    durationMs: number;
  };
}

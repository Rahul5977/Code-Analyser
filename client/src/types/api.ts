// ─────────────────────────────────────────────────────────────────────────────
// src/types/api.ts — Frontend type mirrors of backend contracts
// ─────────────────────────────────────────────────────────────────────────────

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type CritiqueVerdict = "CONFIRMED" | "PLAUSIBLE" | "DISPUTED";

export type AgentId =
  | "orchestrator"
  | "security"
  | "performance"
  | "architecture"
  | "test-coverage"
  | "critique"
  | "synthesis";

// ─── Finding ─────────────────────────────────────────────────────────────────

export interface EvidenceItem {
  toolName: string;
  input: Record<string, unknown>;
  output: string;
  timestamp: string;
}

export interface Finding {
  id: string;
  agentId: AgentId;
  category: string;
  title: string;
  description: string;
  severity: Severity;
  confidence: Confidence;
  filePath: string;
  startLine: number;
  endLine: number;
  codeSnippet: string;
  chunkIds: string[];
  evidence: EvidenceItem[];
  critiqueVerdict?: CritiqueVerdict;
  critiqueReason?: string;
}

// ─── Finding Card ────────────────────────────────────────────────────────────

export interface FindingCard {
  finding: Finding;
  fixedCode: string;
  /** The narrow code window that was actually analysed / sent to the LLM */
  vulnerableWindow?: {
    code: string;
    startLine: number;
    endLine: number;
  };
  /** Which fix strategy was used (windowed-diff, architectural-warning, etc.) */
  fixStrategy?:
    | "windowed-diff"
    | "bounded-rewrite-full"
    | "bounded-rewrite-truncated"
    | "architectural-warning"
    | "error-fallback"
    | "fallback";
  /** True when the finding was too large/structural for auto-fix */
  isArchitecturalWarning?: boolean;
  explanations: {
    junior: string;
    senior: string;
    manager: string;
  };
  references: { title: string; url: string }[];
}

// ─── Architecture ────────────────────────────────────────────────────────────

export interface CouplingScore {
  moduleA: string;
  moduleB: string;
  score: number;
  sharedDependencies: number;
}

export interface ArchitectureReport {
  circularDependencies: string[][];
  couplingScores: CouplingScore[];
  godClasses: { filePath: string; outgoingEdges: number; chunkCount: number }[];
  layerViolations: { source: string; target: string; rule: string }[];
  detectedPattern: string;
  summary: string;
}

// ─── Coverage ────────────────────────────────────────────────────────────────

export interface CoverageGap {
  chunkId: string;
  filePath: string;
  functionName: string;
  cyclomaticComplexity: number;
  hasVulnerability: boolean;
  testFilePaths: string[];
  riskTier: 1 | 2 | 3;
}

export interface CoverageReport {
  totalSourceFiles: number;
  totalTestFiles: number;
  mappedTests: number;
  gaps: CoverageGap[];
  summary: string;
}

// ─── Council Report (final output) ──────────────────────────────────────────

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

// ─── SSE Progress Event ─────────────────────────────────────────────────────

export interface ProgressPayload {
  jobId: string;
  timestamp: string;
  event: string;
  message: string;
  data?: unknown;
}

// ─── API Responses ───────────────────────────────────────────────────────────

export interface AnalyzeResponse {
  success: boolean;
  jobId: string;
  message: string;
  streamUrl: string;
}

export interface ReportResponse {
  success: boolean;
  data: CouncilReport;
}

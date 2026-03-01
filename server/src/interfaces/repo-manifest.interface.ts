// ─────────────────────────────────────────────────────────────────────────────
// src/interfaces/repo-manifest.interface.ts
// Canonical type definitions for the Smart Ingestor output.
// Every downstream agent in the SAST pipeline depends on these shapes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Represents a single dependency that carries known vulnerabilities.
 * Mapped directly from OSV-Scanner JSON output.
 */
export interface DependencyRisk {
  package: string;
  version: string;
  vulnerabilities: {
    cveId: string;
    severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    summary: string;
  }[];
}

/**
 * The complete manifest produced by the Ingestor for a given repository job.
 * This is the single "contract" handed to every subsequent analysis agent.
 */
export interface RepoManifest {
  /** Unique identifier for this ingestion job */
  jobId: string;

  /** Absolute path to the cloned repository on disk */
  localPath: string;

  /** Tech-stack fingerprint derived from linguist-js */
  fingerprint: {
    primaryLanguage: string;
    languages: Record<string, number>; // e.g., { "TypeScript": 85, "HTML": 15 }
  };

  /** Supply-chain vulnerabilities detected by osv-scanner */
  dependencyRisks: DependencyRisk[];

  /** Absolute paths to the cleaned, filtered source files eligible for analysis */
  targetFiles: string[];
}

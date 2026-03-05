// ─────────────────────────────────────────────────────────────────────────────
// src/hooks/useAnalysis.ts — Orchestrates the entire analysis lifecycle
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useCallback } from "react";
import type {
  CouncilReport,
  AnalyzeResponse,
  ReportResponse,
} from "../types/api";
import { useSSE } from "./useSSE";

export type AppPhase = "input" | "streaming" | "report";

export function useAnalysis() {
  const [phase, setPhase] = useState<AppPhase>("input");
  const [jobId, setJobId] = useState<string | null>(null);
  const [report, setReport] = useState<CouncilReport | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const sse = useSSE();

  const submitRepo = useCallback(
    async (url: string) => {
      setError(null);
      setSubmitting(true);
      setRepoUrl(url);

      try {
        const res = await fetch("/api/repo/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoUrl: url }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { message?: string }).message ?? `HTTP ${res.status}`,
          );
        }

        const data = (await res.json()) as AnalyzeResponse;
        setJobId(data.jobId);
        setPhase("streaming");
        sse.connect(data.jobId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [sse],
  );

  const fetchReport = useCallback(async () => {
    if (!jobId) return;

    try {
      const res = await fetch(`/api/repo/report/${jobId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ReportResponse;
      setReport(data.data);
      setPhase("report");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [jobId]);

  const reset = useCallback(() => {
    sse.disconnect();
    setPhase("input");
    setJobId(null);
    setReport(null);
    setRepoUrl("");
    setError(null);
  }, [sse]);

  return {
    phase,
    jobId,
    report,
    repoUrl,
    error,
    submitting,
    sse,
    submitRepo,
    fetchReport,
    reset,
  };
}

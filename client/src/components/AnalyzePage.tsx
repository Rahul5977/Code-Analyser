// ─────────────────────────────────────────────────────────────────────────────
// src/components/AnalyzePage.tsx — Top-Level Page Orchestrator
//
// Manages the 3 UI phases:
//   1. Input   — HeroDashboard (repo URL entry)
//   2. Stream  — LiveTerminal (SSE consumer)
//   3. Report  — ReportDashboard (final analysis results)
// ─────────────────────────────────────────────────────────────────────────────

import { AnimatePresence, motion } from "framer-motion";
import { useAnalysis } from "../hooks/useAnalysis";
import { HeroDashboard } from "./HeroDashboard";
import { LiveTerminal } from "./LiveTerminal";
import { ReportDashboard } from "./ReportDashboard";

export function AnalyzePage() {
  const {
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
  } = useAnalysis();

  return (
    <AnimatePresence mode="wait">
      {phase === "input" && (
        <motion.div
          key="input"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        >
          <HeroDashboard
            onSubmit={submitRepo}
            submitting={submitting}
            error={error}
          />
        </motion.div>
      )}

      {phase === "streaming" && (
        <motion.div
          key="streaming"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        >
          <LiveTerminal
            events={sse.events}
            status={sse.status}
            activeNode={sse.activeNode}
            jobId={jobId}
            onComplete={fetchReport}
          />
        </motion.div>
      )}

      {phase === "report" && report && (
        <motion.div
          key="report"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        >
          <ReportDashboard report={report} repoUrl={repoUrl} onReset={reset} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// src/components/FindingCard.tsx — Finding Detail Card with Monaco Diff Editor
//
// Displays:
//   • Finding metadata (severity, agent, file path, confidence)
//   • 3-tab explanation component (Junior / Senior / Manager)
//   • Monaco Diff Editor showing original → fixed code side-by-side
//   • Evidence / audit trail
//   • Critique verdict
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { DiffEditor } from "@monaco-editor/react";
import {
  FileCode2,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  BookOpen,
} from "lucide-react";
import type {
  FindingCard as FindingCardType,
  CritiqueVerdict,
} from "../types/api";
import { SeverityBadge } from "./ui/SeverityBadge";
import { AgentIcon, AGENT_META } from "./ui/AgentIcon";

// ─── Tab IDs for the explanation switcher ────────────────────────────────────

type ExplanationTab = "junior" | "senior" | "manager";

const TABS: { id: ExplanationTab; label: string; description: string }[] = [
  {
    id: "junior",
    label: "Junior Dev",
    description: "Plain-language explanation",
  },
  { id: "senior", label: "Senior Dev", description: "Technical deep-dive" },
  { id: "manager", label: "Manager", description: "Business impact summary" },
];

// ─── Verdict Badge ───────────────────────────────────────────────────────────

const VERDICT_STYLES: Record<CritiqueVerdict, string> = {
  CONFIRMED: "bg-green-500/15 text-green-400 border-green-500/30",
  PLAUSIBLE: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  DISPUTED: "bg-red-500/15 text-red-400 border-red-500/30",
};

// ─── Component ───────────────────────────────────────────────────────────────

interface FindingCardProps {
  card: FindingCardType;
  index: number;
}

export function FindingCard({ card, index }: FindingCardProps) {
  const { finding } = card;
  const [activeTab, setActiveTab] = useState<ExplanationTab>("junior");
  const [expanded, setExpanded] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);

  const agentMeta = AGENT_META[finding.agentId];

  // Infer Monaco language from file extension
  const language = useMemo(() => {
    const ext = finding.filePath.split(".").pop()?.toLowerCase() ?? "";
    const langMap: Record<string, string> = {
      ts: "typescript",
      tsx: "typescript",
      js: "javascript",
      jsx: "javascript",
      py: "python",
      rb: "ruby",
      go: "go",
      rs: "rust",
      java: "java",
      cs: "csharp",
      cpp: "cpp",
      c: "c",
      php: "php",
      swift: "swift",
      kt: "kotlin",
      sql: "sql",
      yaml: "yaml",
      yml: "yaml",
      json: "json",
      html: "html",
      css: "css",
    };
    return langMap[ext] ?? "plaintext";
  }, [finding.filePath]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      className="bg-surface-secondary border border-border-subtle rounded-2xl overflow-hidden"
    >
      {/* ─── Header ─────────────────────────────────────────────────── */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-4 p-5 text-left hover:bg-surface-elevated/30 transition-colors"
      >
        {/* Agent Icon */}
        <div
          className={`shrink-0 flex items-center justify-center w-10 h-10 rounded-xl ${agentMeta?.bgColor ?? "bg-surface-elevated"}`}
        >
          <AgentIcon agentId={finding.agentId} size={20} />
        </div>

        {/* Title + Metadata */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <SeverityBadge severity={finding.severity} />
            {finding.critiqueVerdict && (
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${VERDICT_STYLES[finding.critiqueVerdict]}`}
              >
                {finding.critiqueVerdict}
              </span>
            )}
            <span className="text-xs text-text-muted font-mono">
              {finding.category}
            </span>
          </div>
          <h3 className="text-base font-semibold text-text-primary truncate">
            {finding.title}
          </h3>
          <div className="flex items-center gap-3 mt-1 text-xs text-text-muted">
            <span className="flex items-center gap-1">
              <FileCode2 size={12} />
              {finding.filePath}
            </span>
            <span>
              L{finding.startLine}–{finding.endLine}
            </span>
            <span className="text-text-muted/60">
              {agentMeta?.label ?? finding.agentId}
            </span>
          </div>
        </div>

        {/* Expand Chevron */}
        <div className="shrink-0 text-text-muted">
          {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </div>
      </button>

      {/* ─── Expanded Content ───────────────────────────────────────── */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="border-t border-border-subtle">
              {/* Description */}
              <div className="px-5 py-4">
                <p className="text-sm text-text-secondary leading-relaxed">
                  {finding.description}
                </p>
              </div>

              {/* Critique Reason */}
              {finding.critiqueReason && (
                <div className="px-5 pb-4">
                  <div className="flex items-center gap-2 mb-2 text-xs font-medium text-orange-400">
                    <MessageSquare size={12} />
                    Critique Reasoning
                  </div>
                  <p className="text-sm text-text-secondary bg-orange-500/5 border border-orange-500/10 rounded-lg p-3">
                    {finding.critiqueReason}
                  </p>
                </div>
              )}

              {/* ─── 3-Tab Explanation Switcher ─────────────────────── */}
              <div className="px-5 pb-4">
                <div className="flex items-center gap-2 mb-3 text-xs font-medium text-text-muted">
                  <BookOpen size={12} />
                  Explanation
                </div>

                {/* Tab Bar */}
                <div className="flex gap-1 mb-3 p-1 bg-surface-elevated rounded-lg">
                  {TABS.map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`flex-1 px-3 py-2 rounded-md text-xs font-medium transition-all ${
                        activeTab === tab.id
                          ? "bg-accent-blue text-white shadow-sm"
                          : "text-text-muted hover:text-text-secondary"
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* Tab Content */}
                <AnimatePresence mode="wait">
                  <motion.div
                    key={activeTab}
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    transition={{ duration: 0.15 }}
                    className="text-sm text-text-secondary leading-relaxed bg-surface-elevated/50 rounded-lg p-4"
                  >
                    {card.explanations[activeTab]}
                  </motion.div>
                </AnimatePresence>
              </div>

              {/* ─── Monaco Diff Editor ─────────────────────────────── */}
              <div className="px-5 pb-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-text-muted flex items-center gap-2">
                    <FileCode2 size={12} />
                    Code Diff — Original → Fixed
                  </span>
                  <span className="text-xs text-text-muted font-mono">
                    {language}
                  </span>
                </div>

                <div className="rounded-xl overflow-hidden border border-border-subtle">
                  <DiffEditor
                    height="280px"
                    language={language}
                    original={finding.codeSnippet}
                    modified={card.fixedCode}
                    theme="vs-dark"
                    options={{
                      readOnly: true,
                      minimap: { enabled: false },
                      fontSize: 13,
                      lineNumbers: "on",
                      scrollBeyondLastLine: false,
                      wordWrap: "on",
                      renderSideBySide: true,
                      originalEditable: false,
                      padding: { top: 12, bottom: 12 },
                    }}
                  />
                </div>
              </div>

              {/* ─── Evidence Trail (collapsible) ──────────────────── */}
              {finding.evidence.length > 0 && (
                <div className="px-5 pb-4">
                  <button
                    onClick={() => setShowEvidence(!showEvidence)}
                    className="flex items-center gap-2 text-xs font-medium text-text-muted hover:text-text-secondary transition-colors"
                  >
                    {showEvidence ? (
                      <ChevronUp size={12} />
                    ) : (
                      <ChevronDown size={12} />
                    )}
                    Evidence Trail ({finding.evidence.length} tool calls)
                  </button>

                  <AnimatePresence>
                    {showEvidence && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="mt-2 space-y-2 overflow-hidden"
                      >
                        {finding.evidence.map((ev, i) => (
                          <div
                            key={i}
                            className="text-xs bg-surface-elevated rounded-lg p-3 border border-border-subtle"
                          >
                            <div className="flex items-center justify-between mb-1">
                              <span className="font-mono text-accent-cyan">
                                {ev.toolName}
                              </span>
                              <span className="text-text-muted">
                                {new Date(ev.timestamp).toLocaleTimeString()}
                              </span>
                            </div>
                            <pre className="text-text-secondary whitespace-pre-wrap wrap-break-word mt-1 max-h-24 overflow-y-auto">
                              {ev.output.slice(0, 500)}
                              {ev.output.length > 500 ? "…" : ""}
                            </pre>
                          </div>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}

              {/* ─── References ─────────────────────────────────────── */}
              {card.references.length > 0 && (
                <div className="px-5 pb-5">
                  <div className="flex flex-wrap gap-2">
                    {card.references.map((ref, i) => (
                      <a
                        key={i}
                        href={ref.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-surface-elevated border border-border-subtle rounded-lg text-xs text-accent-blue hover:border-accent-blue/30 transition-colors"
                      >
                        <ExternalLink size={10} />
                        {ref.title}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

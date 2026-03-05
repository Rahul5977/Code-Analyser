// ─────────────────────────────────────────────────────────────────────────────
// src/components/ReportDashboard.tsx — Final Report Dashboard
//
// Displayed after SSE stream completes.  Contains:
//   • Top bar — Repo health score, tech stack fingerprint, vuln counts
//   • Left sidebar — Navigation grouped by agent
//   • Main content — Finding cards
//   • Architecture tab — Coupling scores, dependency health
//   • Critique Log — Full debate transparency
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  BarChart3,
  ArrowLeft,
  Clock,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Boxes,
  ScrollText,
  Filter,
} from "lucide-react";
import type {
  CouncilReport,
  AgentId,
  FindingCard as FindingCardType,
} from "../types/api";
import { FindingCard } from "./FindingCard";
import { AgentIcon, AGENT_META } from "./ui/AgentIcon";
import { SeverityBadge } from "./ui/SeverityBadge";

// ─── Sidebar Tabs ────────────────────────────────────────────────────────────

type SidebarTab = AgentId | "all" | "architecture" | "critique-log";

// ─── Component ───────────────────────────────────────────────────────────────

interface ReportDashboardProps {
  report: CouncilReport;
  repoUrl: string;
  onReset: () => void;
}

export function ReportDashboard({
  report,
  repoUrl,
  onReset,
}: ReportDashboardProps) {
  const [activeTab, setActiveTab] = useState<SidebarTab>("all");

  // ── Group findings by agent ──
  const findingsByAgent = useMemo(() => {
    const map = new Map<AgentId, FindingCardType[]>();
    for (const card of report.findingCards) {
      const agent = card.finding.agentId;
      const arr = map.get(agent) ?? [];
      arr.push(card);
      map.set(agent, arr);
    }
    return map;
  }, [report.findingCards]);

  // ── Filtered findings for current tab ──
  const filteredCards = useMemo(() => {
    if (
      activeTab === "all" ||
      activeTab === "architecture" ||
      activeTab === "critique-log"
    ) {
      return report.findingCards;
    }
    return findingsByAgent.get(activeTab) ?? [];
  }, [activeTab, report.findingCards, findingsByAgent]);

  // ── Severity counts ──
  const severityCounts = useMemo(() => {
    const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
    for (const card of report.findingCards) {
      counts[card.finding.severity]++;
    }
    return counts;
  }, [report.findingCards]);

  // ── Health score (simple heuristic) ──
  const healthScore = useMemo(() => {
    const total = report.metadata.totalFindings;
    if (total === 0) return 100;
    const penalty =
      severityCounts.CRITICAL * 15 +
      severityCounts.HIGH * 8 +
      severityCounts.MEDIUM * 3 +
      severityCounts.LOW * 1;
    return Math.max(0, Math.min(100, 100 - penalty));
  }, [report.metadata.totalFindings, severityCounts]);

  const healthColor =
    healthScore >= 80
      ? "text-green-400"
      : healthScore >= 50
        ? "text-amber-400"
        : "text-red-400";

  // ── Critique log entries ──
  const critiqueEntries = useMemo(() => {
    return report.findingCards
      .filter((c) => c.finding.critiqueVerdict)
      .map((c) => ({
        card: c,
        verdict: c.finding.critiqueVerdict!,
        reason: c.finding.critiqueReason ?? "No reasoning provided.",
      }));
  }, [report.findingCards]);

  // ── Agents that produced findings ──
  const agentList = useMemo(() => {
    const agents: AgentId[] = [];
    const seen = new Set<AgentId>();
    for (const card of report.findingCards) {
      if (!seen.has(card.finding.agentId)) {
        seen.add(card.finding.agentId);
        agents.push(card.finding.agentId);
      }
    }
    return agents;
  }, [report.findingCards]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* ─── Top Bar ──────────────────────────────────────────────────── */}
      <motion.header
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="sticky top-0 z-20 bg-surface/80 backdrop-blur-xl border-b border-border-subtle"
      >
        <div className="max-w-400 mx-auto px-6 py-4 flex items-center justify-between gap-6">
          {/* Left: Back + Repo Info */}
          <div className="flex items-center gap-4 min-w-0">
            <button
              onClick={onReset}
              className="shrink-0 p-2 rounded-lg hover:bg-surface-elevated transition-colors"
            >
              <ArrowLeft size={18} className="text-text-muted" />
            </button>
            <div className="min-w-0">
              <h1 className="text-lg font-bold truncate">{report.repoId}</h1>
              <p className="text-xs text-text-muted truncate">{repoUrl}</p>
            </div>
          </div>

          {/* Center: Stats */}
          <div className="hidden md:flex items-center gap-6">
            {/* Health Score */}
            <div className="text-center">
              <div className={`text-2xl font-bold ${healthColor}`}>
                {healthScore}
              </div>
              <div className="text-xs text-text-muted">Health</div>
            </div>

            {/* Severity Breakdown */}
            <div className="flex items-center gap-3">
              {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map((sev) => (
                <div key={sev} className="text-center">
                  <div className="text-sm font-semibold">
                    {severityCounts[sev]}
                  </div>
                  <SeverityBadge severity={sev} />
                </div>
              ))}
            </div>

            {/* Meta */}
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <Clock size={12} />
              {(report.metadata.durationMs / 1000).toFixed(1)}s
            </div>
          </div>

          {/* Right: Pattern Badge */}
          {report.architectureReport && (
            <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 bg-cyan-500/10 border border-cyan-500/20 rounded-lg text-xs text-cyan-400">
              <Boxes size={12} />
              {report.architectureReport.detectedPattern}
            </div>
          )}
        </div>
      </motion.header>

      {/* ─── Body ─────────────────────────────────────────────────────── */}
      <div className="flex-1 flex max-w-400 mx-auto w-full">
        {/* ─── Left Sidebar ───────────────────────────────────────── */}
        <motion.aside
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.1 }}
          className="w-56 shrink-0 border-r border-border-subtle p-4 hidden lg:block"
        >
          <div className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
            Filter by Agent
          </div>

          <nav className="space-y-1">
            {/* All Findings */}
            <SidebarButton
              active={activeTab === "all"}
              onClick={() => setActiveTab("all")}
              icon={<Filter size={14} />}
              label="All Findings"
              count={report.findingCards.length}
            />

            {/* Per-Agent */}
            {agentList.map((agentId) => {
              const meta = AGENT_META[agentId];
              return (
                <SidebarButton
                  key={agentId}
                  active={activeTab === agentId}
                  onClick={() => setActiveTab(agentId)}
                  icon={<AgentIcon agentId={agentId} size={14} />}
                  label={meta?.label ?? agentId}
                  count={findingsByAgent.get(agentId)?.length ?? 0}
                />
              );
            })}

            {/* Architecture View */}
            {report.architectureReport && (
              <>
                <div className="pt-3 pb-1 text-xs font-semibold text-text-muted uppercase tracking-wider">
                  Views
                </div>
                <SidebarButton
                  active={activeTab === "architecture"}
                  onClick={() => setActiveTab("architecture")}
                  icon={<Boxes size={14} className="text-cyan-400" />}
                  label="Architecture"
                />
              </>
            )}

            {/* Critique Log */}
            {critiqueEntries.length > 0 && (
              <SidebarButton
                active={activeTab === "critique-log"}
                onClick={() => setActiveTab("critique-log")}
                icon={<ScrollText size={14} className="text-orange-400" />}
                label="Critique Log"
                count={critiqueEntries.length}
              />
            )}
          </nav>
        </motion.aside>

        {/* ─── Main Content ───────────────────────────────────────── */}
        <main className="flex-1 p-6 overflow-y-auto">
          <AnimatePresence mode="wait">
            {activeTab === "architecture" && report.architectureReport ? (
              <ArchitectureView key="arch" report={report.architectureReport} />
            ) : activeTab === "critique-log" ? (
              <CritiqueLog key="critique" entries={critiqueEntries} />
            ) : (
              <motion.div
                key={activeTab}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-4"
              >
                {/* Summary */}
                <div className="bg-surface-secondary border border-border-subtle rounded-2xl p-5 mb-6">
                  <div className="flex items-center gap-2 mb-2">
                    <BarChart3 size={16} className="text-accent-blue" />
                    <span className="text-sm font-semibold">
                      Analysis Summary
                    </span>
                  </div>
                  <p className="text-sm text-text-secondary leading-relaxed">
                    {report.summary}
                  </p>
                  <div className="flex items-center gap-4 mt-3 text-xs text-text-muted">
                    <span className="flex items-center gap-1">
                      <CheckCircle2 size={12} className="text-green-400" />
                      {report.metadata.confirmedFindings} confirmed
                    </span>
                    <span className="flex items-center gap-1">
                      <HelpCircle size={12} className="text-amber-400" />
                      {report.metadata.plausibleFindings} plausible
                    </span>
                    <span className="flex items-center gap-1">
                      <XCircle size={12} className="text-red-400" />
                      {report.metadata.disputedFindings} disputed
                    </span>
                    <span>
                      {report.metadata.reinvestigationCycles} reinvestigation
                      cycle(s)
                    </span>
                  </div>
                </div>

                {/* Finding Cards */}
                {filteredCards.length > 0 ? (
                  filteredCards.map((card, i) => (
                    <FindingCard key={card.finding.id} card={card} index={i} />
                  ))
                ) : (
                  <div className="text-center py-16 text-text-muted">
                    <AlertTriangle
                      size={32}
                      className="mx-auto mb-3 opacity-40"
                    />
                    <p>No findings for this filter.</p>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}

// ─── Sidebar Button ──────────────────────────────────────────────────────────

function SidebarButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-all ${
        active
          ? "bg-accent-blue/10 text-accent-blue border border-accent-blue/20"
          : "text-text-secondary hover:bg-surface-elevated hover:text-text-primary border border-transparent"
      }`}
    >
      {icon}
      <span className="flex-1 text-left truncate">{label}</span>
      {count !== undefined && (
        <span
          className={`text-xs px-1.5 py-0.5 rounded-full ${
            active
              ? "bg-accent-blue/20 text-accent-blue"
              : "bg-surface-elevated text-text-muted"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ─── Architecture View ───────────────────────────────────────────────────────

function ArchitectureView({
  report,
}: {
  report: NonNullable<CouncilReport["architectureReport"]>;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="space-y-6"
    >
      {/* Pattern + Summary */}
      <div className="bg-surface-secondary border border-border-subtle rounded-2xl p-5">
        <div className="flex items-center gap-3 mb-3">
          <Boxes size={18} className="text-cyan-400" />
          <h3 className="font-semibold">Architecture Health</h3>
          <span className="px-2 py-0.5 bg-cyan-500/10 border border-cyan-500/20 rounded-full text-xs text-cyan-400">
            {report.detectedPattern}
          </span>
        </div>
        <p className="text-sm text-text-secondary">{report.summary}</p>
      </div>

      {/* Circular Dependencies */}
      {report.circularDependencies.length > 0 && (
        <div className="bg-surface-secondary border border-border-subtle rounded-2xl p-5">
          <h4 className="text-sm font-semibold mb-3 text-red-400">
            🔄 Circular Dependencies ({report.circularDependencies.length})
          </h4>
          <div className="space-y-2">
            {report.circularDependencies.map((cycle, i) => (
              <div
                key={i}
                className="flex items-center gap-2 text-xs font-mono text-text-secondary bg-surface-elevated rounded-lg p-2 flex-wrap"
              >
                {cycle.map((mod, j) => (
                  <span key={j} className="flex items-center gap-1">
                    <span className="text-red-400">{mod}</span>
                    {j < cycle.length - 1 && (
                      <span className="text-text-muted">→</span>
                    )}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Coupling Scores */}
      {report.couplingScores.length > 0 && (
        <div className="bg-surface-secondary border border-border-subtle rounded-2xl p-5">
          <h4 className="text-sm font-semibold mb-3">📊 Coupling Scores</h4>
          <div className="space-y-2">
            {report.couplingScores.map((c, i) => (
              <div key={i} className="flex items-center gap-3 text-sm">
                <span className="font-mono text-xs text-text-secondary flex-1 truncate">
                  {c.moduleA}
                </span>
                <span className="text-text-muted">↔</span>
                <span className="font-mono text-xs text-text-secondary flex-1 truncate">
                  {c.moduleB}
                </span>
                <CouplingBar score={c.score} />
                <span className="text-xs text-text-muted w-12 text-right">
                  {(c.score * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* God Classes */}
      {report.godClasses.length > 0 && (
        <div className="bg-surface-secondary border border-border-subtle rounded-2xl p-5">
          <h4 className="text-sm font-semibold mb-3 text-amber-400">
            ⚠️ God Classes ({report.godClasses.length})
          </h4>
          <div className="grid gap-2">
            {report.godClasses.map((gc, i) => (
              <div
                key={i}
                className="flex items-center justify-between text-sm bg-surface-elevated rounded-lg p-3 border border-border-subtle"
              >
                <span className="font-mono text-xs text-text-secondary truncate">
                  {gc.filePath}
                </span>
                <div className="flex items-center gap-4 text-xs text-text-muted shrink-0">
                  <span>{gc.outgoingEdges} edges</span>
                  <span>{gc.chunkCount} chunks</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Layer Violations */}
      {report.layerViolations.length > 0 && (
        <div className="bg-surface-secondary border border-border-subtle rounded-2xl p-5">
          <h4 className="text-sm font-semibold mb-3 text-orange-400">
            🚫 Layer Violations ({report.layerViolations.length})
          </h4>
          <div className="space-y-2">
            {report.layerViolations.map((v, i) => (
              <div
                key={i}
                className="flex items-center gap-3 text-xs bg-surface-elevated rounded-lg p-3 border border-border-subtle"
              >
                <span className="font-mono text-orange-400">{v.source}</span>
                <span className="text-text-muted">→</span>
                <span className="font-mono text-orange-400">{v.target}</span>
                <span className="text-text-muted ml-auto">{v.rule}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
}

// ─── Coupling Bar ────────────────────────────────────────────────────────────

function CouplingBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color =
    pct > 70 ? "bg-red-500" : pct > 40 ? "bg-amber-500" : "bg-green-500";

  return (
    <div className="w-24 h-1.5 bg-surface-elevated rounded-full overflow-hidden">
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className={`h-full rounded-full ${color}`}
      />
    </div>
  );
}

// ─── Critique Log ────────────────────────────────────────────────────────────

function CritiqueLog({
  entries,
}: {
  entries: {
    card: FindingCardType;
    verdict: NonNullable<FindingCardType["finding"]["critiqueVerdict"]>;
    reason: string;
  }[];
}) {
  const verdictIcon = {
    CONFIRMED: <CheckCircle2 size={14} className="text-green-400" />,
    PLAUSIBLE: <HelpCircle size={14} className="text-amber-400" />,
    DISPUTED: <XCircle size={14} className="text-red-400" />,
  };

  const verdictBg = {
    CONFIRMED: "border-green-500/20 bg-green-500/5",
    PLAUSIBLE: "border-amber-500/20 bg-amber-500/5",
    DISPUTED: "border-red-500/20 bg-red-500/5",
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="space-y-4"
    >
      <div className="flex items-center gap-2 mb-2">
        <ScrollText size={18} className="text-orange-400" />
        <h3 className="font-semibold">Critique & Debate Log</h3>
        <span className="text-xs text-text-muted">
          Transparency into the council's deliberation process
        </span>
      </div>

      {entries.map((entry, i) => (
        <motion.div
          key={entry.card.finding.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05 }}
          className={`border rounded-2xl p-5 ${verdictBg[entry.verdict]}`}
        >
          <div className="flex items-start gap-3">
            <div className="shrink-0 mt-0.5">{verdictIcon[entry.verdict]}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-sm font-semibold">
                  {entry.card.finding.title}
                </span>
                <SeverityBadge severity={entry.card.finding.severity} />
                <span className="text-xs text-text-muted">
                  by{" "}
                  {AGENT_META[entry.card.finding.agentId]?.label ??
                    entry.card.finding.agentId}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-text-muted mb-2">
                <span className="font-mono">{entry.card.finding.filePath}</span>
                <span>L{entry.card.finding.startLine}</span>
              </div>
              <div className="text-sm text-text-secondary leading-relaxed">
                <span className="font-medium text-orange-400">Critique:</span>{" "}
                {entry.reason}
              </div>
              <div className="mt-2 text-xs">
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-semibold ${
                    entry.verdict === "CONFIRMED"
                      ? "bg-green-500/15 text-green-400"
                      : entry.verdict === "PLAUSIBLE"
                        ? "bg-amber-500/15 text-amber-400"
                        : "bg-red-500/15 text-red-400"
                  }`}
                >
                  {verdictIcon[entry.verdict]}
                  {entry.verdict}
                </span>
              </div>
            </div>
          </div>
        </motion.div>
      ))}

      {entries.length === 0 && (
        <div className="text-center py-16 text-text-muted">
          <ScrollText size={32} className="mx-auto mb-3 opacity-40" />
          <p>No critique entries available.</p>
        </div>
      )}
    </motion.div>
  );
}

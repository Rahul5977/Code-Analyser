// ─────────────────────────────────────────────────────────────────────────────
// src/components/LiveTerminal.tsx — Real-time Agent Terminal (SSE Consumer)
//
// Displays a scrolling timeline of LangGraph agent events with animated
// node indicators.  Memory-leak-safe: the EventSource lifecycle is managed
// entirely by the useSSE hook.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Terminal,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ArrowRight,
} from "lucide-react";
import type { ProgressPayload } from "../types/api";
import type { SSEStatus } from "../hooks/useSSE";

// ─── Agent Node Graph ────────────────────────────────────────────────────────

const PIPELINE_NODES = [
  { id: "ingest", label: "Ingest", color: "bg-blue-500" },
  { id: "triage", label: "Triage", color: "bg-indigo-500" },
  { id: "graphrag", label: "GraphRAG", color: "bg-cyan-500" },
  { id: "council", label: "Council", color: "bg-purple-500" },
  { id: "security", label: "Security", color: "bg-red-500" },
  { id: "performance", label: "Performance", color: "bg-amber-500" },
  { id: "architecture", label: "Architecture", color: "bg-teal-500" },
  { id: "critique", label: "Critique", color: "bg-orange-500" },
  { id: "synthesis", label: "Synthesis", color: "bg-emerald-500" },
];

function getActiveNodeId(event: string): string | null {
  for (const node of PIPELINE_NODES) {
    if (event.includes(node.id)) return node.id;
  }
  return null;
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface LiveTerminalProps {
  events: ProgressPayload[];
  status: SSEStatus;
  activeNode: string | null;
  jobId: string | null;
  onComplete: () => void;
}

export function LiveTerminal({
  events,
  status,
  activeNode,
  jobId,
  onComplete,
}: LiveTerminalProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new events
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [events.length]);

  // Trigger report fetch when stream completes
  useEffect(() => {
    if (status === "complete") {
      const timer = setTimeout(onComplete, 800);
      return () => clearTimeout(timer);
    }
  }, [status, onComplete]);

  // Determine the last-seen active phase from events
  const completedNodes = new Set<string>();
  let currentNodeId: string | null = null;
  for (const ev of events) {
    const nid = getActiveNodeId(ev.event);
    if (nid && ev.event.includes(":complete")) {
      completedNodes.add(nid);
    }
    if (nid && ev.event.includes(":start")) {
      currentNodeId = nid;
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center pt-8 px-4">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-4xl mb-6"
      >
        <div className="flex items-center gap-3 mb-1">
          <Terminal size={20} className="text-accent-cyan" />
          <h2 className="text-xl font-semibold">Live Analysis</h2>
          <StatusPill status={status} />
        </div>
        <p className="text-text-muted text-sm">
          Job{" "}
          <code className="text-accent-cyan font-mono">
            {jobId?.slice(0, 8) ?? "—"}
          </code>
        </p>
      </motion.div>

      {/* Pipeline Node Graph */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="w-full max-w-4xl mb-6 overflow-x-auto"
      >
        <div className="flex items-center gap-1 min-w-max px-2 py-3">
          {PIPELINE_NODES.map((node, i) => {
            const isComplete = completedNodes.has(node.id);
            const isCurrent = currentNodeId === node.id && !isComplete;

            return (
              <div key={node.id} className="flex items-center gap-1">
                <motion.div
                  animate={isCurrent ? { scale: [1, 1.1, 1] } : {}}
                  transition={
                    isCurrent ? { repeat: Infinity, duration: 1.5 } : {}
                  }
                  className={`
                    relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-300
                    ${
                      isComplete
                        ? "bg-green-500/15 text-green-400 border border-green-500/30"
                        : isCurrent
                          ? `${node.color}/20 text-white border border-white/20 animate-pulse-glow`
                          : "bg-surface-elevated text-text-muted border border-border-subtle"
                    }
                  `}
                >
                  {isComplete && (
                    <CheckCircle2 size={12} className="text-green-400" />
                  )}
                  {isCurrent && <Loader2 size={12} className="animate-spin" />}
                  {node.label}
                </motion.div>
                {i < PIPELINE_NODES.length - 1 && (
                  <ArrowRight
                    size={12}
                    className={`mx-0.5 ${
                      isComplete ? "text-green-500/50" : "text-border-subtle"
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </motion.div>

      {/* Terminal Output */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="w-full max-w-4xl flex-1 bg-surface-secondary border border-border-subtle rounded-2xl overflow-hidden"
      >
        {/* Terminal Chrome */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle bg-surface-elevated/50">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/60" />
            <div className="w-3 h-3 rounded-full bg-amber-500/60" />
            <div className="w-3 h-3 rounded-full bg-green-500/60" />
          </div>
          <span className="text-text-muted text-xs font-mono ml-2">
            agent-terminal — {activeNode ?? "idle"}
          </span>
        </div>

        {/* Scrollable Event Log */}
        <div
          ref={scrollRef}
          className="p-4 h-[55vh] overflow-y-auto font-mono text-sm space-y-1"
        >
          <AnimatePresence initial={false}>
            {events.map((ev, i) => (
              <EventLine key={`${ev.timestamp}-${i}`} event={ev} />
            ))}
          </AnimatePresence>

          {status === "complete" && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex items-center gap-2 pt-3 text-green-400"
            >
              <CheckCircle2 size={14} />
              <span>Analysis complete. Loading report…</span>
            </motion.div>
          )}
        </div>
      </motion.div>
    </div>
  );
}

// ─── Sub-Components ──────────────────────────────────────────────────────────

function EventLine({ event }: { event: ProgressPayload }) {
  const isError = event.event.includes("error");
  const isComplete = event.event.includes("complete");
  const isStart = event.event.includes("start");
  const time = new Date(event.timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2 }}
      className="flex items-start gap-3 py-0.5"
    >
      <span className="text-text-muted shrink-0 text-xs mt-0.5">{time}</span>
      <span
        className={`shrink-0 w-1.5 h-1.5 rounded-full mt-1.5 ${
          isError
            ? "bg-red-400"
            : isComplete
              ? "bg-green-400"
              : isStart
                ? "bg-blue-400"
                : "bg-text-muted"
        }`}
      />
      <span
        className={`text-xs ${
          isError
            ? "text-red-400"
            : isComplete
              ? "text-green-400"
              : "text-text-secondary"
        }`}
      >
        <span className="text-text-muted">[{event.event}]</span> {event.message}
      </span>
    </motion.div>
  );
}

function StatusPill({ status }: { status: SSEStatus }) {
  const config: Record<
    SSEStatus,
    { label: string; color: string; icon: typeof Loader2 }
  > = {
    idle: {
      label: "Idle",
      color: "text-text-muted bg-surface-elevated",
      icon: Terminal,
    },
    connecting: {
      label: "Connecting…",
      color: "text-amber-400 bg-amber-500/10",
      icon: Loader2,
    },
    connected: {
      label: "Streaming",
      color: "text-cyan-400 bg-cyan-500/10",
      icon: Loader2,
    },
    complete: {
      label: "Complete",
      color: "text-green-400 bg-green-500/10",
      icon: CheckCircle2,
    },
    error: {
      label: "Error",
      color: "text-red-400 bg-red-500/10",
      icon: AlertCircle,
    },
  };

  const { label, color, icon: Icon } = config[status];

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${color}`}
    >
      <Icon
        size={12}
        className={
          status === "connecting" || status === "connected"
            ? "animate-spin"
            : ""
        }
      />
      {label}
    </span>
  );
}

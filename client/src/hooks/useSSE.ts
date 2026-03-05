// ─────────────────────────────────────────────────────────────────────────────
// src/hooks/useSSE.ts — Memory-leak-safe EventSource hook
//
// Opens a single SSE connection per jobId.  Correctly handles:
//   • Re-renders (stable ref via useRef)
//   • Unmount cleanup (EventSource.close())
//   • Terminal event detection (auto-close on "stream:end")
//   • Reconnection guard (no duplicate connections)
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useCallback } from "react";
import type { ProgressPayload } from "../types/api";

export type SSEStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "complete"
  | "error";

export interface UseSSEReturn {
  events: ProgressPayload[];
  status: SSEStatus;
  activeNode: string | null;
  connect: (jobId: string) => void;
  disconnect: () => void;
}

export function useSSE(baseUrl: string = "/api/repo/stream"): UseSSEReturn {
  const [events, setEvents] = useState<ProgressPayload[]>([]);
  const [status, setStatus] = useState<SSEStatus>("idle");
  const [activeNode, setActiveNode] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);
  const jobIdRef = useRef<string | null>(null);

  const disconnect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    jobIdRef.current = null;
  }, []);

  const connect = useCallback(
    (jobId: string) => {
      // Prevent duplicate connections to the same job
      if (jobIdRef.current === jobId && esRef.current) return;

      // Close any existing connection
      disconnect();

      jobIdRef.current = jobId;
      setEvents([]);
      setStatus("connecting");

      const es = new EventSource(`${baseUrl}/${jobId}`);
      esRef.current = es;

      es.onopen = () => {
        setStatus("connected");
      };

      es.onmessage = (e: MessageEvent) => {
        try {
          const payload: ProgressPayload = JSON.parse(e.data);

          // Track active LangGraph node from event names
          if (payload.event?.includes(":start")) {
            const nodeName = extractNodeName(payload.event);
            if (nodeName) setActiveNode(nodeName);
          } else if (payload.event?.includes(":complete")) {
            setActiveNode(null);
          }

          setEvents((prev) => [...prev, payload]);

          // Terminal events — mark stream as complete
          if (
            payload.event === "stream:end" ||
            payload.event === "job:cleanup:complete"
          ) {
            setStatus("complete");
            es.close();
            esRef.current = null;
          }
        } catch {
          // Non-JSON messages (heartbeats) — ignore
        }
      };

      es.onerror = () => {
        // EventSource auto-reconnects, but if the server has
        // explicitly closed the stream, readyState becomes CLOSED.
        if (es.readyState === EventSource.CLOSED) {
          setStatus((prev) => (prev === "complete" ? "complete" : "error"));
          es.close();
          esRef.current = null;
        }
      };
    },
    [baseUrl, disconnect],
  );

  // Cleanup on unmount — the critical leak prevention
  useEffect(() => {
    return () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, []);

  return { events, status, activeNode, connect, disconnect };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extracts a human-readable node name from an SSE event tag. */
function extractNodeName(event: string): string | null {
  // "phase:council:start" → "Council"
  // "agent:security:start" → "Security Agent"
  const parts = event.split(":");
  if (parts.length < 2) return null;

  const namespace = parts[0];
  const name = parts[1];
  if (!name) return null;

  const capitalised = name.charAt(0).toUpperCase() + name.slice(1);

  if (namespace === "agent") return `${capitalised} Agent`;
  if (namespace === "phase") return capitalised;
  return capitalised;
}

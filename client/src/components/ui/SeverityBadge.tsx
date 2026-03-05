// ─────────────────────────────────────────────────────────────────────────────
// src/components/ui/SeverityBadge.tsx
// ─────────────────────────────────────────────────────────────────────────────

import type { Severity } from "../../types/api";

const SEVERITY_STYLES: Record<Severity, string> = {
  CRITICAL: "bg-red-500/15 text-red-400 border-red-500/30",
  HIGH: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  MEDIUM: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  LOW: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  INFO: "bg-slate-500/15 text-slate-400 border-slate-500/30",
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${SEVERITY_STYLES[severity]}`}
    >
      {severity}
    </span>
  );
}

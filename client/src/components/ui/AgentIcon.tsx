// ─────────────────────────────────────────────────────────────────────────────
// src/components/ui/AgentIcon.tsx — Maps agent IDs to icons and colours
// ─────────────────────────────────────────────────────────────────────────────

import {
  Shield,
  Gauge,
  Boxes,
  TestTubeDiagonal,
  Scale,
  Sparkles,
  Brain,
} from "lucide-react";
import type { AgentId } from "../../types/api";
import type { LucideProps } from "lucide-react";
import type { ComponentType } from "react";

interface AgentMeta {
  icon: ComponentType<LucideProps>;
  label: string;
  color: string;
  bgColor: string;
}

export const AGENT_META: Record<AgentId, AgentMeta> = {
  orchestrator: {
    icon: Brain,
    label: "Orchestrator",
    color: "text-purple-400",
    bgColor: "bg-purple-500/15",
  },
  security: {
    icon: Shield,
    label: "Security",
    color: "text-red-400",
    bgColor: "bg-red-500/15",
  },
  performance: {
    icon: Gauge,
    label: "Performance",
    color: "text-amber-400",
    bgColor: "bg-amber-500/15",
  },
  architecture: {
    icon: Boxes,
    label: "Architecture",
    color: "text-cyan-400",
    bgColor: "bg-cyan-500/15",
  },
  "test-coverage": {
    icon: TestTubeDiagonal,
    label: "Test Coverage",
    color: "text-green-400",
    bgColor: "bg-green-500/15",
  },
  critique: {
    icon: Scale,
    label: "Critique",
    color: "text-orange-400",
    bgColor: "bg-orange-500/15",
  },
  synthesis: {
    icon: Sparkles,
    label: "Synthesis",
    color: "text-blue-400",
    bgColor: "bg-blue-500/15",
  },
};

export function AgentIcon({
  agentId,
  size = 16,
  className = "",
}: {
  agentId: AgentId;
  size?: number;
  className?: string;
}) {
  const meta = AGENT_META[agentId];
  if (!meta) return null;
  const Icon = meta.icon;
  return <Icon size={size} className={`${meta.color} ${className}`} />;
}

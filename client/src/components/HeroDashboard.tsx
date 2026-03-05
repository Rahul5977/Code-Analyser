// ─────────────────────────────────────────────────────────────────────────────
// src/components/HeroDashboard.tsx — Ingestion Entry Point
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { motion } from "framer-motion";
import {
  GitBranch,
  ArrowRight,
  Loader2,
  Zap,
  Shield,
  Boxes,
} from "lucide-react";

interface HeroDashboardProps {
  onSubmit: (repoUrl: string) => void;
  submitting: boolean;
  error: string | null;
}

export function HeroDashboard({
  onSubmit,
  submitting,
  error,
}: HeroDashboardProps) {
  const [url, setUrl] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (url.trim()) onSubmit(url.trim());
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4">
      {/* Background Grid Effect */}
      <div className="fixed inset-0 opacity-[0.03] pointer-events-none">
        <div
          className="w-full h-full"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)",
            backgroundSize: "60px 60px",
          }}
        />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="relative z-10 w-full max-w-2xl"
      >
        {/* Logo / Title */}
        <div className="text-center mb-12">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
            className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent-blue/10 border border-accent-blue/20 mb-6"
          >
            <Zap className="w-8 h-8 text-accent-blue" />
          </motion.div>

          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
            <span className="bg-linear-to-r from-accent-blue via-accent-cyan to-accent-purple bg-clip-text text-transparent">
              Code Analyser
            </span>
          </h1>
          <p className="text-text-secondary text-lg max-w-lg mx-auto">
            Enterprise multi-agent static analysis powered by LangGraph. Paste a
            GitHub URL to begin deep analysis.
          </p>
        </div>

        {/* Input Form */}
        <form onSubmit={handleSubmit} className="relative group">
          <div className="absolute -inset-0.5 bg-linear-to-r from-accent-blue/50 via-accent-cyan/50 to-accent-purple/50 rounded-2xl opacity-0 group-focus-within:opacity-100 transition-opacity duration-300 blur-sm" />

          <div className="relative flex items-center gap-3 bg-surface-elevated border border-border-subtle rounded-2xl p-2 focus-within:border-accent-blue/50 transition-colors">
            <div className="flex items-center gap-2 pl-3 text-text-muted">
              <GitBranch size={20} />
            </div>

            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo.git"
              className="flex-1 bg-transparent text-text-primary placeholder-text-muted text-base py-3 px-1 outline-none"
              disabled={submitting}
              required
            />

            <motion.button
              type="submit"
              disabled={submitting || !url.trim()}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className="flex items-center gap-2 px-6 py-3 bg-accent-blue hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors"
            >
              {submitting ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <>
                  Analyze
                  <ArrowRight size={16} />
                </>
              )}
            </motion.button>
          </div>
        </form>

        {/* Error */}
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm text-center"
          >
            {error}
          </motion.div>
        )}

        {/* Feature Pills */}
        <div className="flex items-center justify-center gap-4 mt-10 flex-wrap">
          {[
            { icon: Shield, label: "Security", color: "text-red-400" },
            { icon: Boxes, label: "Architecture", color: "text-cyan-400" },
            { icon: Zap, label: "Performance", color: "text-amber-400" },
          ].map(({ icon: Icon, label, color }, i) => (
            <motion.div
              key={label}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4 + i * 0.1 }}
              className="flex items-center gap-2 px-4 py-2 bg-surface-elevated border border-border-subtle rounded-full text-sm text-text-secondary"
            >
              <Icon size={14} className={color} />
              {label}
            </motion.div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// src/evals/eval.store.ts
//
// Phase 6 – SQLite Time-Series Eval Database.
//
// Uses `better-sqlite3` — a synchronous, zero-dependency embedded SQLite driver.
// Perfect for a local eval harness where we want atomic writes without the
// overhead of a Postgres connection.
//
// Schema: `eval_runs` table
//   id                INTEGER PRIMARY KEY AUTOINCREMENT
//   timestamp         TEXT    NOT NULL
//   commit_hash       TEXT    NOT NULL
//   ground_truth_name TEXT    NOT NULL
//   agent_name        TEXT    NOT NULL
//   precision         REAL    NOT NULL
//   recall            REAL    NOT NULL
//   f1_score          REAL    NOT NULL
//   true_positives    INTEGER NOT NULL
//   false_positives   INTEGER NOT NULL
//   false_negatives   INTEGER NOT NULL
//   severity_accuracy REAL
//   duration_ms       INTEGER NOT NULL
//
// Additional tables:
//   eval_regressions — stores regression alerts for trend monitoring.
// ─────────────────────────────────────────────────────────────────────────────

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { logger } from "../utils/logger";
import type {
  AgentScore,
  EvalRunResult,
  EvalRunRow,
  RegressionAlert,
} from "./eval.interfaces";
import type { AgentId } from "../interfaces/council.interface";

const LOG_CTX = "EvalStore";

// ─── Database Singleton ──────────────────────────────────────────────────────

let db: Database.Database | null = null;

/**
 * Returns (or creates) the singleton SQLite database.
 *
 * The DB file lives at `<projectRoot>/eval_data/eval.db`.  The directory is
 * created automatically on first use.
 */
function getDb(): Database.Database {
  if (db) return db;

  const evalDir = path.resolve(process.cwd(), "eval_data");
  if (!fs.existsSync(evalDir)) {
    fs.mkdirSync(evalDir, { recursive: true });
  }

  const dbPath = path.join(evalDir, "eval.db");
  db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");

  return db;
}

// ─── Schema Initialisation ───────────────────────────────────────────────────

/**
 * Creates the eval tables if they don't already exist.
 * Idempotent — safe to call on every startup.
 */
export function initEvalDb(): void {
  const conn = getDb();

  conn.exec(`
    CREATE TABLE IF NOT EXISTS eval_runs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp         TEXT    NOT NULL,
      commit_hash       TEXT    NOT NULL,
      ground_truth_name TEXT    NOT NULL,
      agent_name        TEXT    NOT NULL,
      precision         REAL    NOT NULL,
      recall            REAL    NOT NULL,
      f1_score          REAL    NOT NULL,
      true_positives    INTEGER NOT NULL,
      false_positives   INTEGER NOT NULL,
      false_negatives   INTEGER NOT NULL,
      severity_accuracy REAL,
      duration_ms       INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_eval_runs_timestamp ON eval_runs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_eval_runs_agent     ON eval_runs(agent_name);
    CREATE INDEX IF NOT EXISTS idx_eval_runs_commit    ON eval_runs(commit_hash);

    CREATE TABLE IF NOT EXISTS eval_regressions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp      TEXT    NOT NULL,
      commit_hash    TEXT    NOT NULL,
      agent_name     TEXT    NOT NULL,
      metric         TEXT    NOT NULL,
      previous_value REAL    NOT NULL,
      current_value  REAL    NOT NULL,
      delta          REAL    NOT NULL,
      severity       TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_eval_regressions_ts ON eval_regressions(timestamp);
  `);

  logger.info(LOG_CTX, "Eval database initialised (eval_data/eval.db)");
}

// ─── Insert Eval Run ─────────────────────────────────────────────────────────

/**
 * Persists a single eval run result (one row per agent).
 * Uses a transaction for atomicity.
 */
export function insertEvalRun(result: EvalRunResult): void {
  const conn = getDb();

  const stmt = conn.prepare(`
    INSERT INTO eval_runs
      (timestamp, commit_hash, ground_truth_name, agent_name,
       precision, recall, f1_score,
       true_positives, false_positives, false_negatives,
       severity_accuracy, duration_ms)
    VALUES
      (@timestamp, @commit_hash, @ground_truth_name, @agent_name,
       @precision, @recall, @f1_score,
       @true_positives, @false_positives, @false_negatives,
       @severity_accuracy, @duration_ms)
  `);

  const insertMany = conn.transaction((scores: AgentScore[]) => {
    for (const score of scores) {
      stmt.run({
        timestamp: result.timestamp,
        commit_hash: result.platformCommitHash,
        ground_truth_name: result.groundTruthName,
        agent_name: score.agentId,
        precision: score.precision,
        recall: score.recall,
        f1_score: score.f1,
        true_positives: score.truePositives,
        false_positives: score.falsePositives,
        false_negatives: score.falseNegatives,
        severity_accuracy: score.severityAccuracy ?? null,
        duration_ms: result.durationMs,
      });
    }
  });

  insertMany(result.agentScores);

  logger.info(
    LOG_CTX,
    `Inserted ${result.agentScores.length} eval rows for "${result.groundTruthName}" ` +
      `(commit: ${result.platformCommitHash.slice(0, 8)})`,
  );
}

// ─── Insert Regressions ──────────────────────────────────────────────────────

export function insertRegressions(
  commitHash: string,
  alerts: RegressionAlert[],
): void {
  if (alerts.length === 0) return;

  const conn = getDb();
  const stmt = conn.prepare(`
    INSERT INTO eval_regressions
      (timestamp, commit_hash, agent_name, metric,
       previous_value, current_value, delta, severity)
    VALUES
      (@timestamp, @commit_hash, @agent_name, @metric,
       @previous_value, @current_value, @delta, @severity)
  `);

  const ts = new Date().toISOString();
  const insertAll = conn.transaction((items: RegressionAlert[]) => {
    for (const a of items) {
      stmt.run({
        timestamp: ts,
        commit_hash: commitHash,
        agent_name: a.agentId,
        metric: a.metric,
        previous_value: a.previousValue,
        current_value: a.currentValue,
        delta: a.delta,
        severity: a.severity,
      });
    }
  });

  insertAll(alerts);
  logger.warn(LOG_CTX, `Recorded ${alerts.length} regression alert(s)`);
}

// ─── Query: Previous Run for Regression Detection ────────────────────────────

/**
 * Returns the most recent eval scores for each agent on a given ground truth,
 * excluding the current commit.  Used to detect regressions.
 */
export function getPreviousScores(
  groundTruthName: string,
  excludeCommit: string,
): Map<AgentId, { precision: number; recall: number; f1: number }> {
  const conn = getDb();

  const rows = conn
    .prepare(
      `
      SELECT agent_name, precision, recall, f1_score
      FROM eval_runs
      WHERE ground_truth_name = @gt
        AND commit_hash != @commit
      ORDER BY timestamp DESC
      LIMIT 20
    `,
    )
    .all({ gt: groundTruthName, commit: excludeCommit }) as Array<{
    agent_name: string;
    precision: number;
    recall: number;
    f1_score: number;
  }>;

  // Take only the first (most recent) row per agent
  const seen = new Set<string>();
  const result = new Map<
    AgentId,
    { precision: number; recall: number; f1: number }
  >();

  for (const row of rows) {
    if (seen.has(row.agent_name)) continue;
    seen.add(row.agent_name);
    result.set(row.agent_name as AgentId, {
      precision: row.precision,
      recall: row.recall,
      f1: row.f1_score,
    });
  }

  return result;
}

// ─── Query: Historical Trend ─────────────────────────────────────────────────

/**
 * Returns the last N eval runs for a given agent + ground truth.
 * Useful for plotting trend charts.
 */
export function getHistoricalTrend(
  agentName: string,
  groundTruthName: string,
  limit: number = 20,
): EvalRunRow[] {
  const conn = getDb();

  return conn
    .prepare(
      `
      SELECT *
      FROM eval_runs
      WHERE agent_name = @agent
        AND ground_truth_name = @gt
      ORDER BY timestamp DESC
      LIMIT @limit
    `,
    )
    .all({ agent: agentName, gt: groundTruthName, limit }) as EvalRunRow[];
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function closeEvalDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info(LOG_CTX, "Eval database closed");
  }
}

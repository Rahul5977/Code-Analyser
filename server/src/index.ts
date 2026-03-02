// POST /api/v1/ingest  →  { repoUrl, jobId? }  →  RepoManifest
// POST /api/v1/analyse →  { repoUrl, jobId? }  →  Full Pipeline (Ingest + Triage)
// POST /api/v1/triage  →  { filePaths, repoRoot } →  TriageResult

import express, { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";

import { ingestRepository } from "./ingestors";
import { parseAndTriage } from "./parsers";
import { logger } from "./utils/logger";

const app = express();
const PORT = process.env["PORT"] ?? 3001;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());

// ── Health Check ─────────────────────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "code-analyser",
    timestamp: new Date().toISOString(),
  });
});

// ── Ingest Endpoint ──────────────────────────────────────────────────────────

interface IngestRequestBody {
  repoUrl?: string;
  jobId?: string;
}

app.post(
  "/api/v1/ingest",
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as IngestRequestBody;
    const { repoUrl, jobId: providedJobId } = body;

    // ── Validation ──
    if (!repoUrl || typeof repoUrl !== "string") {
      res.status(400).json({
        error: "Bad Request",
        message: "`repoUrl` is required and must be a non-empty string.",
      });
      return;
    }

    // Accept a client-provided jobId or auto-generate one
    const jobId = providedJobId ?? uuidv4();

    logger.info(
      "Server",
      `Received ingest request  jobId=${jobId}  repo=${repoUrl}`,
    );

    try {
      const manifest = await ingestRepository(repoUrl, jobId);

      res.status(200).json({
        success: true,
        data: manifest,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Server", `Ingestion failed for jobId=${jobId}: ${message}`);

      res.status(500).json({
        success: false,
        error: "Ingestion Failed",
        message,
        jobId,
      });
    }
  },
);

// ── Triage Endpoint (standalone) ─────────────────────────────────────────────

interface TriageRequestBody {
  filePaths?: string[];
  repoRoot?: string;
}

app.post(
  "/api/v1/triage",
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as TriageRequestBody;
    const { filePaths, repoRoot } = body;

    if (!filePaths || !Array.isArray(filePaths) || filePaths.length === 0) {
      res.status(400).json({
        error: "Bad Request",
        message:
          "`filePaths` must be a non-empty array of absolute file paths.",
      });
      return;
    }

    if (!repoRoot || typeof repoRoot !== "string") {
      res.status(400).json({
        error: "Bad Request",
        message: "`repoRoot` is required and must be a non-empty string.",
      });
      return;
    }

    try {
      const result = await parseAndTriage(filePaths, repoRoot);
      res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Server", `Triage failed: ${message}`);
      res.status(500).json({ success: false, error: "Triage Failed", message });
    }
  },
);

// ── Full Pipeline Endpoint (Ingest → Triage) ────────────────────────────────

app.post(
  "/api/v1/analyse",
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as IngestRequestBody;
    const { repoUrl, jobId: providedJobId } = body;

    if (!repoUrl || typeof repoUrl !== "string") {
      res.status(400).json({
        error: "Bad Request",
        message: "`repoUrl` is required and must be a non-empty string.",
      });
      return;
    }

    const jobId = providedJobId ?? uuidv4();

    logger.info(
      "Server",
      `Full analysis pipeline  jobId=${jobId}  repo=${repoUrl}`,
    );

    try {
      // Phase 1 – Ingest
      const manifest = await ingestRepository(repoUrl, jobId);

      // Phase 2 – Parse & Triage
      const triage = await parseAndTriage(
        manifest.targetFiles,
        manifest.localPath,
      );

      res.status(200).json({
        success: true,
        data: { manifest, triage },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        "Server",
        `Full analysis failed for jobId=${jobId}: ${message}`,
      );
      res
        .status(500)
        .json({ success: false, error: "Analysis Failed", message, jobId });
    }
  },
);

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(Number(PORT), () => {
  logger.info(
    "Server",
    `🚀 Code Analyser Service listening on http://localhost:${PORT}`,
  );
  logger.info("Server", `   POST /api/v1/ingest   { repoUrl, jobId? }`);
  logger.info("Server", `   POST /api/v1/triage   { filePaths, repoRoot }`);
  logger.info("Server", `   POST /api/v1/analyse  { repoUrl, jobId? }`);
  logger.info("Server", `   GET  /health`);
});

export default app;

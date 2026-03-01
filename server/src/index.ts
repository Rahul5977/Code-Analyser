// ─────────────────────────────────────────────────────────────────────────────
// src/index.ts
//
// Minimal Express server that exposes the Smart Ingestor as a REST endpoint.
// POST /api/v1/ingest  →  { repoUrl, jobId? }  →  RepoManifest
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";

import { ingestRepository } from "./ingestors";
import { logger } from "./utils/logger";

const app = express();
const PORT = process.env["PORT"] ?? 3001;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());

// ── Health Check ─────────────────────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "smart-ingestor",
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

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(Number(PORT), () => {
  logger.info(
    "Server",
    `🚀 Smart Ingestor Service listening on http://localhost:${PORT}`,
  );
  logger.info("Server", `   POST /api/v1/ingest  { repoUrl, jobId? }`);
  logger.info("Server", `   GET  /health`);
});

export default app;

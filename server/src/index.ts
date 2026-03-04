// POST /api/v1/ingest  →  { repoUrl, jobId? }  →  RepoManifest
// POST /api/v1/analyse →  { repoUrl, jobId? }  →  Full Pipeline (Ingest + Triage)
// POST /api/v1/triage  →  { filePaths, repoRoot } →  TriageResult
// POST /api/v1/graph-rag/sync    →  { repoUrl }   →  SyncReport (Ingest + Triage + Sync)
// POST /api/v1/graph-rag/search  →  { query, repoId, topK?, maxDepth? }  →  GraphRagContext
// DELETE /api/v1/graph-rag/repo  →  { repoId }    →  OK

import express, { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";

import { ingestRepository } from "./ingestors";
import { parseAndTriage } from "./parsers";
import { GraphRagService } from "./graph-rag";
import { logger } from "./utils/logger";
import type {
  GraphRagConfig,
  EmbedFunction,
  EmbedBatchFunction,
} from "./interfaces";

// ── Server Setup ──────────────────────────────────────────────────────────────
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

// ─── GraphRAG Service (Lazy-initialised) ─────────────────────────────────────
//
// The service is created lazily on first use.  This allows the server to start
// even if Qdrant / Neo4j are not available (Phase 1 & 2 endpoints still work).
//
// In production, replace the stub embedFn with a real embedding model call
// (e.g., OpenAI text-embedding-3-small or a local sentence-transformers model).
// ─────────────────────────────────────────────────────────────────────────────

let graphRagService: GraphRagService | null = null;

function getGraphRagConfig(): GraphRagConfig {
  return {
    qdrant: {
      url: process.env["QDRANT_URL"] ?? "http://localhost:6333",
      apiKey: process.env["QDRANT_API_KEY"],
      collectionName: process.env["QDRANT_COLLECTION"] ?? "code_chunks",
    },
    neo4j: {
      uri: process.env["NEO4J_URI"] ?? "bolt://localhost:7687",
      username: process.env["NEO4J_USERNAME"] ?? "neo4j",
      password: process.env["NEO4J_PASSWORD"] ?? "password",
      database: process.env["NEO4J_DATABASE"] ?? "neo4j",
    },
    embeddingDimension: Number(process.env["EMBEDDING_DIM"] ?? "384"),
  };
}

/**
 * Stub embedding function that generates deterministic random vectors.
 * Replace with a real embedding provider (OpenAI, Cohere, local model, etc.).
 */
const stubEmbedFn: EmbedFunction = async (text: string): Promise<number[]> => {
  // Simple hash-based deterministic vector for development/testing
  const dim = Number(process.env["EMBEDDING_DIM"] ?? "384");
  const vector: number[] = [];
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  for (let i = 0; i < dim; i++) {
    // Generate pseudo-random but deterministic values in [-1, 1]
    hash = ((hash << 5) - hash + i) | 0;
    vector.push(Math.sin(hash) * 0.5);
  }
  // Normalise to unit vector (cosine similarity requires it)
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
  return vector.map((v) => v / (norm || 1));
};

const stubEmbedBatchFn: EmbedBatchFunction = async (
  texts: string[],
): Promise<number[][]> => {
  return Promise.all(texts.map((t) => stubEmbedFn(t)));
};

async function getGraphRagService(): Promise<GraphRagService> {
  if (!graphRagService) {
    const config = getGraphRagConfig();
    graphRagService = new GraphRagService(
      config,
      stubEmbedFn,
      stubEmbedBatchFn,
    );
    await graphRagService.init();
  }
  return graphRagService;
}

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

// ─── Phase 3: GraphRAG Endpoints ─────────────────────────────────────────────

// ── Sync: Full pipeline (Ingest → Triage → Vector+Graph Sync) ───────────────

interface GraphRagSyncBody {
  repoUrl?: string;
  repoId?: string;
  jobId?: string;
}

app.post(
  "/api/v1/graph-rag/sync",
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as GraphRagSyncBody;
    const { repoUrl, jobId: providedJobId } = body;

    if (!repoUrl || typeof repoUrl !== "string") {
      res.status(400).json({
        error: "Bad Request",
        message: "`repoUrl` is required and must be a non-empty string.",
      });
      return;
    }

    const jobId = providedJobId ?? uuidv4();
    // Derive repoId from the URL (last path segment) or use provided
    const repoId =
      body.repoId ??
      repoUrl
        .replace(/\.git$/, "")
        .split("/")
        .filter(Boolean)
        .slice(-2)
        .join("/") ??
      jobId;

    logger.info(
      "Server",
      `GraphRAG sync  jobId=${jobId}  repo=${repoUrl}  repoId=${repoId}`,
    );

    try {
      // Phase 1 – Ingest
      const manifest = await ingestRepository(repoUrl, jobId);

      // Phase 2 – Parse & Triage
      const triage = await parseAndTriage(
        manifest.targetFiles,
        manifest.localPath,
      );

      // Phase 3 – Vector + Graph Sync
      const service = await getGraphRagService();
      const syncReport = await service.sync(triage, repoId);

      res.status(200).json({
        success: true,
        data: {
          manifest,
          triage: { chunkCount: triage.chunks.length },
          syncReport,
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        "Server",
        `GraphRAG sync failed for jobId=${jobId}: ${message}`,
      );
      res.status(500).json({
        success: false,
        error: "GraphRAG Sync Failed",
        message,
        jobId,
      });
    }
  },
);

// ── Hybrid Search ────────────────────────────────────────────────────────────

interface GraphRagSearchBody {
  query?: string;
  repoId?: string;
  topK?: number;
  maxDepth?: number;
  ranked?: boolean;
}

app.post(
  "/api/v1/graph-rag/search",
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as GraphRagSearchBody;
    const { query, repoId, topK, maxDepth, ranked } = body;

    if (!query || typeof query !== "string") {
      res.status(400).json({
        error: "Bad Request",
        message: "`query` is required and must be a non-empty string.",
      });
      return;
    }

    if (!repoId || typeof repoId !== "string") {
      res.status(400).json({
        error: "Bad Request",
        message: "`repoId` is required and must be a non-empty string.",
      });
      return;
    }

    try {
      const service = await getGraphRagService();

      if (ranked) {
        const chunks = await service.hybridSearchRanked(
          query,
          repoId,
          topK ?? 10,
          maxDepth ?? 2,
        );
        res
          .status(200)
          .json({ success: true, data: { query, ranked: true, chunks } });
      } else {
        const context = await service.hybridSearch(
          query,
          repoId,
          topK ?? 10,
          maxDepth ?? 2,
        );
        res.status(200).json({ success: true, data: context });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Server", `Hybrid search failed: ${message}`);
      res.status(500).json({
        success: false,
        error: "Hybrid Search Failed",
        message,
      });
    }
  },
);

// ── Drop Repo Data ───────────────────────────────────────────────────────────

app.delete(
  "/api/v1/graph-rag/repo",
  async (req: Request, res: Response): Promise<void> => {
    const repoId =
      (req.query["repoId"] as string | undefined) ??
      (req.body as { repoId?: string }).repoId;

    if (!repoId || typeof repoId !== "string") {
      res.status(400).json({
        error: "Bad Request",
        message: "`repoId` is required (query param or body).",
      });
      return;
    }

    try {
      const service = await getGraphRagService();
      await service.dropRepo(repoId);
      res
        .status(200)
        .json({ success: true, message: `Repo "${repoId}" data dropped` });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Server", `Drop repo failed: ${message}`);
      res.status(500).json({ success: false, error: "Drop Failed", message });
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
  logger.info(
    "Server",
    `   POST /api/v1/graph-rag/sync    { repoUrl, repoId?, jobId? }`,
  );
  logger.info(
    "Server",
    `   POST /api/v1/graph-rag/search  { query, repoId, topK?, maxDepth?, ranked? }`,
  );
  logger.info("Server", `   DELETE /api/v1/graph-rag/repo  { repoId }`);
  logger.info("Server", `   GET  /health`);
});

// ── Graceful Shutdown ────────────────────────────────────────────────────────
const gracefulShutdown = async (signal: string): Promise<void> => {
  logger.info("Server", `Received ${signal} — shutting down gracefully…`);
  if (graphRagService) {
    await graphRagService.close();
  }
  process.exit(0);
};

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

export default app;

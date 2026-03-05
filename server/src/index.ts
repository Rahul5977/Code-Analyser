// POST /api/v1/ingest  →  { repoUrl, jobId? }  →  RepoManifest
// POST /api/v1/analyse →  { repoUrl, jobId? }  →  Full Pipeline (Ingest + Triage)
// POST /api/v1/triage  →  { filePaths, repoRoot } →  TriageResult
// POST /api/v1/graph-rag/sync    →  { repoUrl }   →  SyncReport (Ingest + Triage + Sync)
// POST /api/v1/graph-rag/search  →  { query, repoId, topK?, maxDepth? }  →  GraphRagContext
// DELETE /api/v1/graph-rag/repo  →  { repoId }    →  OK
// POST /api/v1/council/analyse   →  { repoUrl, repoId?, jobId? }  →  CouncilReport

import express, { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";

import { ingestRepository } from "./ingestors";
import { parseAndTriage } from "./parsers";
import { GraphRagService } from "./graph-rag";
import { runCouncil } from "./council";
import {
  analyzeRepo,
  streamProgress,
  compareReports,
  getReportEndpoint,
  createAnalysisWorker,
  closePubSub,
  closeQueue,
} from "./delivery";
import { logger } from "./utils/logger";
import type {
  GraphRagConfig,
  EmbedFunction,
  EmbedBatchFunction,
  CouncilConfig,
} from "./interfaces";
import { createSmartStubLlm } from "./council/smart-stub-llm";

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

// ─── LLM Completion Function ─────────────────────────────────────────────────
//
// Uses the smart stub LLM that drives real tool chains when no API key is set.
// In production, replace with a real LLM provider (OpenAI, Anthropic, etc.).
// ─────────────────────────────────────────────────────────────────────────────

const stubLlmFn = createSmartStubLlm();

/** Returns the default council configuration */
function getCouncilConfig(): CouncilConfig {
  return {
    llmFn: stubLlmFn,
    maxIterations: Number(process.env["COUNCIL_MAX_ITERATIONS"] ?? "10"),
    maxReinvestigations: Number(
      process.env["COUNCIL_MAX_REINVESTIGATIONS"] ?? "2",
    ),
    disputeThreshold: Number(process.env["COUNCIL_DISPUTE_THRESHOLD"] ?? "0.6"),
    temperature: Number(process.env["COUNCIL_TEMPERATURE"] ?? "0.3"),
  };
}

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

// ─── Phase 4: Council Endpoints ──────────────────────────────────────────────

interface CouncilAnalyseRequestBody {
  repoUrl?: string;
  repoId?: string;
  jobId?: string;
}

app.post(
  "/api/v1/council/analyse",
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CouncilAnalyseRequestBody;
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
      `Council analysis pipeline  jobId=${jobId}  repo=${repoUrl}`,
    );

    try {
      // Phase 1 – Ingest
      const manifest = await ingestRepository(repoUrl, jobId);

      // Phase 2 – Parse & Triage
      const triage = await parseAndTriage(
        manifest.targetFiles,
        manifest.localPath,
      );

      // Derive repoId
      const repoId =
        body.repoId ??
        repoUrl
          .replace(/\.git$/, "")
          .split("/")
          .filter(Boolean)
          .slice(-2)
          .join("/") ??
        jobId;

      // Phase 3 – Vector + Graph Sync
      const service = await getGraphRagService();
      await service.sync(triage, repoId);

      // Phase 4 – Council Analysis
      const councilConfig = getCouncilConfig();
      const councilDeps = {
        toolDeps: {
          graphRag: service,
          neo4j: service.neo4j,
          qdrant: service.qdrant,
          repoId,
        },
        qdrant: service.qdrant,
        embedFn: service.embedFn,
      };

      const councilReport = await runCouncil(
        manifest,
        triage,
        repoId,
        councilConfig,
        councilDeps,
      );

      res.status(200).json({
        success: true,
        data: {
          manifest: {
            jobId: manifest.jobId,
            primaryLanguage: manifest.fingerprint.primaryLanguage,
            fileCount: manifest.targetFiles.length,
            dependencyRisks: manifest.dependencyRisks.length,
          },
          triageSummary: {
            chunkCount: triage.chunks.length,
            fileCount: new Set(triage.chunks.map((c) => c.filePath)).size,
          },
          councilReport,
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        "Server",
        `Council analysis failed for jobId=${jobId}: ${message}`,
      );
      res
        .status(500)
        .json({ success: false, error: "Council Analysis Failed", message });
    }
  },
);

// ─── Phase 5: API Delivery Routes ────────────────────────────────────────────

app.post("/api/repo/analyze", analyzeRepo);
app.get("/api/repo/stream/:jobId", streamProgress);
app.get("/api/repo/diff", compareReports);
app.get("/api/repo/report/:jobId", getReportEndpoint);

// ─── BullMQ Worker (optional — start only if ENABLE_WORKER=true) ─────────────
//
// In production the worker typically runs as a separate process.  Setting
// ENABLE_WORKER=true starts it in-process for development convenience.
// ─────────────────────────────────────────────────────────────────────────────

let analysisWorker: ReturnType<typeof createAnalysisWorker> | null = null;

if (process.env["ENABLE_WORKER"] === "true") {
  analysisWorker = createAnalysisWorker();
}

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(Number(PORT), () => {
  logger.info(
    "Server",
    `🚀 Code Analyser Service listening on http://localhost:${PORT}`,
  );
  logger.info("Server", "");
  logger.info("Server", "  Phase 1–2 (Ingest & Triage):");
  logger.info("Server", `   POST /api/v1/ingest   { repoUrl, jobId? }`);
  logger.info("Server", `   POST /api/v1/triage   { filePaths, repoRoot }`);
  logger.info("Server", `   POST /api/v1/analyse  { repoUrl, jobId? }`);
  logger.info("Server", "");
  logger.info("Server", "  Phase 3 (GraphRAG):");
  logger.info(
    "Server",
    `   POST /api/v1/graph-rag/sync    { repoUrl, repoId?, jobId? }`,
  );
  logger.info(
    "Server",
    `   POST /api/v1/graph-rag/search  { query, repoId, topK?, maxDepth?, ranked? }`,
  );
  logger.info("Server", `   DELETE /api/v1/graph-rag/repo  { repoId }`);
  logger.info("Server", "");
  logger.info("Server", "  Phase 4 (Council):");
  logger.info(
    "Server",
    `   POST /api/v1/council/analyse   { repoUrl, repoId?, jobId? }`,
  );
  logger.info("Server", "");
  logger.info("Server", "  Phase 5 (Delivery):");
  logger.info(
    "Server",
    `   POST /api/repo/analyze         { repoUrl, callbackUrl? }`,
  );
  logger.info("Server", `   GET  /api/repo/stream/:jobId   (SSE)`);
  logger.info("Server", `   GET  /api/repo/diff?jobA=&jobB= (Report Diff)`);
  logger.info("Server", `   GET  /api/repo/report/:jobId   (Fetch Report)`);
  logger.info("Server", "");
  logger.info("Server", `   GET  /health`);
  logger.info(
    "Server",
    `   Worker: ${analysisWorker ? "RUNNING (in-process)" : "DISABLED (set ENABLE_WORKER=true)"}`,
  );
});

// ── Graceful Shutdown ────────────────────────────────────────────────────────
const gracefulShutdown = async (signal: string): Promise<void> => {
  logger.info("Server", `Received ${signal} — shutting down gracefully…`);

  // Phase 5 teardown
  if (analysisWorker) {
    await analysisWorker.close();
  }
  await closeQueue();
  await closePubSub();

  // Phase 3 teardown
  if (graphRagService) {
    await graphRagService.close();
  }

  process.exit(0);
};

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

export default app;

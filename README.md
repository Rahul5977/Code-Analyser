# Code-Analyser

**Enterprise-Grade Multi-Agent Static Analysis (SAST) Platform**

Built with Node.js, TypeScript, LangGraph, BullMQ, React, and a ReAct-loop Council of specialised AI agents.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           React Frontend (Vite)                             │
│  HeroDashboard → LiveTerminal (SSE) → ReportDashboard (Monaco Diff)        │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ POST /api/repo/analyze
                                │ GET  /api/repo/stream/:jobId  (SSE)
                                │ GET  /api/repo/report/:jobId
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Express API  (Phase 5)                               │
│  Controllers ─── BullMQ Queue ─── Redis Pub/Sub ─── Webhook Delivery        │
└──────────────────────┬──────────────────────────────────────────────────────┘
                       │ Job Processing
                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                  BullMQ Worker — Full Analysis Pipeline                      │
│                                                                              │
│  Phase 1: Ingest ──→ Phase 2: AST Parse & Triage ──→ Phase 3: GraphRAG Sync │
│                                                                              │
│  Phase 4: LangGraph Council ────────────────────────────────────────────────│
│  ┌─────────────┐  ┌──────────┐  ┌─────────┐  ┌──────────────┐              │
│  │ Orchestrator │→│ Security │→│ Perf    │→│ Architecture │              │
│  └──────┬──────┘  └──────────┘  └─────────┘  └──────────────┘              │
│         │          ┌──────────┐  ┌───────────┐  ┌───────────┐              │
│         └────────→│ Test Cov │→│ Critique  │→│ Synthesis │              │
│                    └──────────┘  └───────────┘  └───────────┘              │
│                                                                              │
│  Phase 6: Eval Harness (offline regression testing against golden repos)     │
└──────────────────────────────────────────────────────────────────────────────┘
         │                    │                     │
         ▼                    ▼                     ▼
    ┌─────────┐         ┌─────────┐           ┌─────────┐
    │ Qdrant  │         │ Neo4j   │           │ Redis   │
    │ (Vector)│         │ (Graph) │           │ (Queue) │
    └─────────┘         └─────────┘           └─────────┘
```

---

## Full-Stack Directory Structure

```
CodeAnalyser/
│
├── .env.example                          # ← Master env template (all 6 phases)
├── .gitignore
├── docker-compose.yml                    # ← Redis + Qdrant + Neo4j (local dev)
├── README.md                             # ← This file
│
├── server/                               # ═══ Node.js Backend ═══
│   ├── package.json
│   ├── tsconfig.json
│   ├── index.js                          # CommonJS entry (loads dist/)
│   │
│   ├── eval_data/                        # Phase 6 — Eval artifacts
│   │   ├── sample-ground-truth.json      #   Golden repo definitions
│   │   └── eval.db                       #   SQLite time-series DB (auto-created)
│   │
│   └── src/
│       ├── index.ts                      # Express app — all routes, graceful shutdown
│       │
│       │── interfaces/                   # ═══ Shared Type Contracts ═══
│       │   ├── index.ts                  #   Barrel export
│       │   ├── repo-manifest.interface.ts
│       │   ├── triage.interface.ts
│       │   ├── graph-rag.interface.ts
│       │   └── council.interface.ts      #   Finding, FindingCard, CouncilReport, AgentId
│       │
│       ├── utils/
│       │   └── logger.ts                 #   Structured colour logger
│       │
│       │── ingestors/                    # ═══ Phase 1: Repository Ingestion ═══
│       │   ├── index.ts
│       │   └── repo.ingestor.ts          #   Git clone, language detection, manifest
│       │
│       │── parsers/                      # ═══ Phase 2: AST Parsing & Triage ═══
│       │   ├── index.ts
│       │   ├── ast.parser.ts             #   Tree-sitter AST chunking
│       │   └── helpers/
│       │       ├── index.ts
│       │       ├── cfg.helper.ts         #   Control-flow graph construction
│       │       ├── halstead.helper.ts    #   Halstead complexity metrics
│       │       ├── resolve.helper.ts     #   Module resolution
│       │       └── smells.helper.ts      #   Code smell detection heuristics
│       │
│       │── graph-rag/                    # ═══ Phase 3: GraphRAG (Vector + Graph) ═══
│       │   ├── index.ts
│       │   ├── graph-rag.service.ts      #   Orchestrator — sync, search, hybrid retrieval
│       │   ├── qdrant.store.ts           #   Qdrant vector store adapter
│       │   ├── neo4j.store.ts            #   Neo4j graph store adapter
│       │   └── diff.engine.ts            #   Incremental sync — add/update/delete vectors
│       │
│       │── council/                      # ═══ Phase 4: LangGraph Multi-Agent Council ═══
│       │   ├── index.ts                  #   Barrel — runCouncil(), agents, tools
│       │   ├── council.orchestrator.ts   #   LangGraph state machine & graph topology
│       │   ├── react-engine.ts           #   Generic ReAct loop (Reason → Act → Observe)
│       │   ├── agents/
│       │   │   ├── index.ts
│       │   │   ├── orchestrator.agent.ts #   Plans investigation targets
│       │   │   ├── security.agent.ts     #   SQL injection, XSS, IDOR, crypto flaws
│       │   │   ├── performance.agent.ts  #   O(n²) loops, memory leaks, blocking I/O
│       │   │   ├── architecture.agent.ts #   Coupling, circular deps, god classes
│       │   │   ├── test-coverage.agent.ts#   Test coverage gap correlation
│       │   │   ├── critique.agent.ts     #   Adversarial verification (dispute/confirm)
│       │   │   └── synthesis.agent.ts    #   Fix generation, 3-audience explanations
│       │   └── tools/
│       │       ├── index.ts
│       │       ├── shared.tools.ts       #   fetchChunkWithContext, queryKnowledgeGraph
│       │       ├── security.tools.ts     #   checkCVE, runSemgrepRule, traceDataFlow
│       │       ├── performance.tools.ts  #   estimateComplexityClass, findSimilarPatterns
│       │       ├── architecture.tools.ts #   findCircularDeps, computeCoupling, godClasses
│       │       ├── critique.tools.ts     #   verifyFinding (re-check evidence)
│       │       └── synthesis.tools.ts    #   generateFixedCode, fetchDocumentation
│       │
│       │── delivery/                     # ═══ Phase 5: API Delivery & Cleanup ═══
│       │   ├── index.ts                  #   Barrel — controllers, pubsub, worker
│       │   ├── controllers.ts            #   POST analyze, GET stream (SSE), GET report, GET diff
│       │   ├── pubsub.ts                 #   Redis Pub/Sub — publisher singleton, subscriber factory
│       │   └── worker.ts                 #   BullMQ worker — full pipeline + webhook + cleanup
│       │
│       └── evals/                        # ═══ Phase 6: Evaluation Harness ═══
│           ├── index.ts                  #   Barrel — runner, scorer, store
│           ├── eval.interfaces.ts        #   GroundTruth, MatchResult, AgentScore, RegressionAlert
│           ├── eval.scorer.ts            #   Fuzzy matching, per-agent P/R/F1, severity accuracy
│           ├── eval.store.ts             #   SQLite DB — eval_runs, eval_regressions tables
│           └── eval.runner.ts            #   CLI harness — run pipeline, score, detect regressions
│
│
├── client/                               # ═══ React Frontend (Vite + Tailwind v4) ═══
│   ├── package.json
│   ├── tsconfig.json
│   ├── tsconfig.app.json
│   ├── tsconfig.node.json
│   ├── vite.config.ts                    #   Tailwind plugin, /api proxy → :3001
│   ├── eslint.config.js
│   ├── index.html                        #   SPA entry — Inter + JetBrains Mono fonts
│   │
│   ├── public/
│   │   └── vite.svg
│   │
│   └── src/
│       ├── main.tsx                      #   React DOM bootstrap
│       ├── App.tsx                       #   Root → AnalyzePage
│       ├── index.css                     #   Tailwind v4 @import + custom design tokens
│       │
│       ├── types/
│       │   └── api.ts                    #   Frontend mirrors of backend contracts
│       │
│       ├── hooks/
│       │   ├── useSSE.ts                 #   Memory-leak-safe EventSource hook
│       │   └── useAnalysis.ts            #   Phase state machine (input → stream → report)
│       │
│       └── components/
│           ├── AnalyzePage.tsx            #   Top-level router across 3 UI phases
│           ├── HeroDashboard.tsx          #   Repo URL input, feature pills, gradient hero
│           ├── LiveTerminal.tsx           #   SSE consumer, pipeline node graph, scrolling log
│           ├── FindingCard.tsx            #   Monaco Diff Editor, 3-tab explanation, evidence trail
│           ├── ReportDashboard.tsx        #   Sidebar nav, architecture view, critique log
│           └── ui/
│               ├── AgentIcon.tsx          #   Agent → icon + colour mapping
│               └── SeverityBadge.tsx      #   CRITICAL/HIGH/MEDIUM/LOW/INFO badges
```

---

## Quick Start

### Prerequisites

| Service      | How to Run                                                        | Purpose              |
| ------------ | ----------------------------------------------------------------- | -------------------- |
| Node.js ≥ 18 | `brew install node`                                               | Runtime              |
| Docker       | [Docker Desktop](https://www.docker.com/products/docker-desktop/) | Infrastructure stack |

### Start Infrastructure (Redis + Qdrant + Neo4j)

```bash
# From the project root — starts all 3 services in the background
docker compose up -d

# Verify everything is healthy
docker compose ps
```

| Service | Endpoint                                | UI                                                                |
| ------- | --------------------------------------- | ----------------------------------------------------------------- |
| Redis   | `localhost:6379`                        | —                                                                 |
| Qdrant  | `localhost:6333` (REST) / `6334` (gRPC) | [Dashboard](http://localhost:6333/dashboard)                      |
| Neo4j   | `localhost:7687` (Bolt)                 | [Browser UI](http://localhost:7474) — login: `neo4j` / `password` |

> **Tip:** Open http://localhost:7474 in your browser once the agents start mapping
> repositories. Run a Cypher query like `MATCH (n) RETURN n LIMIT 50` to visually
> inspect the Knowledge Graph of file dependencies and chunk relationships.

### Setup

```bash
# 1. Clone & configure
git clone <repo-url> && cd CodeAnalyser
cp .env.example server/.env

# 2. Server
cd server
npm install
npm run build        # Compile TypeScript → dist/
npm run dev          # Dev mode with ts-node (hot reload)

# 3. Client (separate terminal)
cd client
npm install
npm run dev          # Vite dev server on :5173 (proxies /api → :3001)
```

### Run the Eval Harness (Phase 6)

```bash
cd server
npx ts-node src/evals/eval.runner.ts eval_data/sample-ground-truth.json
npx ts-node src/evals/eval.runner.ts --smoke   # Built-in synthetic test
```

---

## API Reference

| Method   | Endpoint                     | Phase | Description                                |
| -------- | ---------------------------- | ----- | ------------------------------------------ |
| `GET`    | `/health`                    | —     | Health check                               |
| `POST`   | `/api/v1/ingest`             | 1     | Clone & manifest a repo                    |
| `POST`   | `/api/v1/triage`             | 2     | Parse AST & triage code chunks             |
| `POST`   | `/api/v1/analyse`            | 1+2   | Full ingest → triage pipeline              |
| `POST`   | `/api/v1/graph-rag/sync`     | 3     | Ingest → triage → vector+graph sync        |
| `POST`   | `/api/v1/graph-rag/search`   | 3     | Hybrid vector + graph search               |
| `DELETE` | `/api/v1/graph-rag/repo`     | 3     | Drop all data for a repo                   |
| `POST`   | `/api/v1/council/analyse`    | 4     | Full pipeline including council            |
| `POST`   | `/api/repo/analyze`          | 5     | Submit async job (returns jobId)           |
| `GET`    | `/api/repo/stream/:jobId`    | 5     | SSE real-time progress stream              |
| `GET`    | `/api/repo/report/:jobId`    | 5     | Retrieve completed report                  |
| `GET`    | `/api/repo/diff?jobA=&jobB=` | 5     | Diff two reports (resolved/new/persisting) |

---

## Advanced System Design Escalations

### 1. Worker Autoscaling (1000 concurrent repo uploads)

**Problem:** A fixed `WORKER_CONCURRENCY=2` collapses under burst traffic.

**Solution — KEDA + BullMQ Metrics:**

- Deploy workers as a Kubernetes `Deployment` (or ECS Task).
- Expose BullMQ queue depth via a Prometheus `/metrics` endpoint:
  ```
  bullmq_queue_waiting{queue="repo-analysis-queue"} 847
  ```
- Use **KEDA** (Kubernetes Event-Driven Autoscaler) with a `ScaledObject` that
  watches the Redis list length for the queue. Scale workers from 2 → 50 pods
  based on queue depth, with a 30 s cooldown to prevent thrash.
- Each worker pod is stateless — it clones into ephemeral disk, processes, cleans up.
- **Ceiling:** Qdrant and Neo4j become the bottleneck at ~200 concurrent syncs.
  Solution: partition vector collections per-tenant (multi-tenancy) and use
  Neo4j Aura (managed) with read replicas.

### 2. LLM Circuit Breaker (Resilience against API outages)

**Problem:** If OpenAI returns 429/503 for 30 seconds, every in-flight council
analysis stalls and consumes worker slots.

**Solution — Opossum Circuit Breaker + Fallback Chain:**

```
Primary: GPT-4o (OpenAI)
  ↓ circuit open after 5 failures in 30 s
Fallback 1: Claude Sonnet (Anthropic)
  ↓ circuit open
Fallback 2: Ollama llama3.1:70b (local, lower quality)
  ↓ circuit open
Fallback 3: Graceful degradation — return partial report with
             "LLM unavailable" status on unanalysed agents.
```

- Wrap every `LLMCompletionFn` call in an **opossum** circuit breaker instance
  (npm package `opossum`), configured per-provider:
  - `timeout: 30_000` (30 s per call)
  - `errorThresholdPercentage: 50` (open after 50% failures)
  - `resetTimeout: 60_000` (half-open probe after 60 s)
- The `CouncilConfig.llmFn` becomes a cascading wrapper that tries each
  provider in order. This is invisible to the agents — they just call `llmFn()`.
- Emit circuit state changes as SSE events so the frontend can show
  "⚠️ Primary LLM degraded — using fallback" in the LiveTerminal.

### 3. Webhook Delivery Guarantees (at-least-once)

**Problem:** The current `deliverWebhook()` retries 3× with backoff, but if
the worker process crashes mid-delivery, the webhook is lost forever.

**Solution — Outbox Pattern + Dedicated Delivery Queue:**

```
Worker completes analysis
  → INSERT into `webhook_outbox` table (Postgres/SQLite)
      { jobId, callbackUrl, payload_json, status: "PENDING", attempts: 0 }
  → Enqueue a lightweight `webhook-delivery` job in a *separate* BullMQ queue.

Webhook Worker (separate process):
  → Read from `webhook-delivery` queue.
  → POST to callbackUrl.
  → On success: UPDATE outbox SET status = "DELIVERED".
  → On failure: BullMQ auto-retries with exponential backoff (up to 10 attempts
    over 24 hours: 1m, 5m, 15m, 1h, 4h, 8h…).
  → After 10 failures: UPDATE outbox SET status = "DEAD_LETTER".
  → Expose a `GET /api/repo/webhook-status/:jobId` endpoint so clients
    can poll if their webhook server was down.
```

- The outbox table is the source of truth. Even if the worker process crashes
  between INSERT and enqueue, a periodic sweep job (`*/5 * * * *`) picks up
  orphaned `PENDING` rows and re-enqueues them.
- This guarantees **at-least-once delivery** with full auditability.

### 4. Commit-Level Cache (avoid re-analysing identical code)

**Problem:** If 10 users submit the same public repo at the same commit SHA,
we clone, parse, embed, and run the council 10 times — identical work.

**Solution — Redis Cache Keyed by `repoUrl + commitHash`:**

```
Cache Key:  `report:cache:<sha256(repoUrl)>:<commitHash>`
Cache TTL:  24 hours (configurable via CACHE_REPORT_TTL_S)
```

- **Layer 1 — Pre-queue check** (in `analyzeRepo` controller):
  1. `git ls-remote <repoUrl> HEAD` → get the remote HEAD commit hash.
  2. Check `Redis.GET(cacheKey)` → if cache hit, return the report immediately
     (skip BullMQ entirely). Respond with `200` instead of `202`.
  3. If cache miss → enqueue as normal.
- **Layer 2 — Post-analysis write** (in the worker `finally` block):
  1. After `storeReport(jobId, report)`, also `Redis.SET(cacheKey, JSON.stringify(report), 'EX', ttl)`.
- **Layer 3 — GraphRAG dedup** (in the diff engine):
  The `diff.engine.ts` already does incremental sync — if the Qdrant collection
  for a repo already has vectors from the same commit, the sync is a no-op.
- **Cache invalidation:** The cache key includes the exact commit hash, so a
  new push to the repo naturally creates a new key. No manual invalidation needed.
- **Estimated savings:** For popular repos (OWASP projects, framework starters),
  this eliminates >80% of redundant pipeline runs.

---

## Tech Stack Summary

| Layer           | Technology                                 | Phase |
| --------------- | ------------------------------------------ | ----- |
| Frontend        | React 19, Vite 7, Tailwind CSS 4           | UI    |
| Animations      | framer-motion                              | UI    |
| Code Diff       | @monaco-editor/react                       | UI    |
| Icons           | lucide-react                               | UI    |
| API Server      | Express 5, TypeScript 5                    | 5     |
| Job Queue       | BullMQ + Redis                             | 5     |
| Real-time       | Server-Sent Events (SSE) via Redis Pub/Sub | 5     |
| Git Integration | simple-git                                 | 1     |
| AST Parsing     | tree-sitter + tree-sitter-typescript       | 2     |
| Complexity      | Halstead metrics, cyclomatic complexity    | 2     |
| Vector DB       | Qdrant                                     | 3     |
| Graph DB        | Neo4j                                      | 3     |
| Agent Framework | LangGraph-style state machine (custom)     | 4     |
| Agent Loop      | ReAct (Reason → Act → Observe)             | 4     |
| Eval Storage    | better-sqlite3                             | 6     |
| Eval Scoring    | Precision / Recall / F1 + fuzzy matching   | 6     |

---

## Scripts

### Server (`cd server/`)

| Command                                        | Description                      |
| ---------------------------------------------- | -------------------------------- |
| `npm run dev`                                  | Start with ts-node (development) |
| `npm run build`                                | Compile TypeScript to `dist/`    |
| `npm start`                                    | Run compiled production build    |
| `npm run clean`                                | Remove `dist/` and `temp/`       |
| `npx tsc --noEmit`                             | Type-check without emitting      |
| `npx ts-node src/evals/eval.runner.ts --smoke` | Run eval smoke test              |

### Client (`cd client/`)

| Command           | Description                           |
| ----------------- | ------------------------------------- |
| `npm run dev`     | Vite dev server on :5173 (hot reload) |
| `npm run build`   | Production build to `dist/`           |
| `npm run preview` | Preview production build locally      |
| `npm run lint`    | ESLint check                          |

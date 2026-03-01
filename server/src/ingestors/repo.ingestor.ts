// ─────────────────────────────────────────────────────────────────────────────
// src/ingestors/repo.ingestor.ts
//
// Phase 1 – "The Smart Ingestor Service"
//
// Pipeline:
//   1. Sandboxed Clone      – clone the repo into ./temp/<jobId>
//   2. Smart Exclusion       – .gitignore + baseline rules + 1 MB cap
//   3. Repo Fingerprinting   – linguist-js language breakdown
//   4. Supply-Chain Scan     – osv-scanner → DependencyRisk[]
//   5. Assemble & Return     – typed RepoManifest
//
// Every step is isolated in its own function so it can be unit-tested,
// retried, or replaced independently.
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path";
import fs from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import simpleGit, { GitError } from "simple-git";
import ignore, { Ignore } from "ignore";
import fg from "fast-glob";
import linguist from "linguist-js";

import { logger } from "../utils/logger";
import type {
  DependencyRisk,
  RepoManifest,
} from "../interfaces/repo-manifest.interface";

// ─── Constants ───────────────────────────────────────────────────────────────

const LOG_CTX = "RepoIngestor";

/** Root temp directory – every job gets its own subdirectory */
const TEMP_ROOT = path.resolve(process.cwd(), "temp");

/** Hard cap: any file above this size (bytes) is excluded from analysis */
const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB

/** Clone depth – shallow clone keeps ingestion fast & lean on disk */
const CLONE_DEPTH = 1;

/**
 * Baseline ignore patterns that are ALWAYS applied regardless of the
 * repository's own .gitignore.  These cover build artefacts, vendored
 * dependencies, binaries, and other non-source noise.
 */
const BASELINE_IGNORE_PATTERNS: readonly string[] = [
  // ── Directories ──
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  "coverage/",
  "__pycache__/",
  ".venv/",
  "venv/",
  "vendor/",
  ".idea/",
  ".vscode/",
  ".terraform/",

  // ── Lock / generated files ──
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "composer.lock",
  "Pipfile.lock",
  "poetry.lock",
  "Gemfile.lock",
  "Cargo.lock",

  // ── Minified / bundled JS ──
  "*.min.js",
  "*.min.css",
  "*.bundle.js",
  "*.chunk.js",

  // ── Images / Fonts / Binaries ──
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.ico",
  "*.svg",
  "*.webp",
  "*.bmp",
  "*.tiff",
  "*.woff",
  "*.woff2",
  "*.ttf",
  "*.eot",
  "*.otf",
  "*.mp3",
  "*.mp4",
  "*.avi",
  "*.mov",
  "*.zip",
  "*.tar",
  "*.gz",
  "*.rar",
  "*.7z",
  "*.exe",
  "*.dll",
  "*.so",
  "*.dylib",
  "*.o",
  "*.a",
  "*.class",
  "*.jar",
  "*.war",
  "*.pyc",
  "*.pyo",
  "*.wasm",
  "*.pdf",
  "*.doc",
  "*.docx",
  "*.xls",
  "*.xlsx",
  "*.ppt",
  "*.pptx",

  // ── Miscellaneous ──
  ".DS_Store",
  "Thumbs.db",
  "*.map", // source maps
  "*.d.ts", // type declarations (generated)
  ".env",
  ".env.*",
];

const execAsync = promisify(exec);

// ─── 1. Sandboxed Clone ─────────────────────────────────────────────────────

/**
 * Clones the target repository into `./temp/<jobId>`.
 * Uses a shallow clone (depth 1) to minimise bandwidth and disk usage.
 *
 * @returns The absolute path to the cloned directory.
 * @throws  A descriptive error if the clone fails.
 */
async function cloneRepository(
  repoUrl: string,
  jobId: string,
): Promise<string> {
  const targetDir = path.join(TEMP_ROOT, jobId);

  // Ensure the target directory exists (and is empty)
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });

  logger.info(
    LOG_CTX,
    `Cloning ${repoUrl} → ${targetDir}  (depth=${CLONE_DEPTH})`,
  );

  const git = simpleGit();

  try {
    await git.clone(repoUrl, targetDir, [
      "--depth",
      String(CLONE_DEPTH),
      "--single-branch",
    ]);
  } catch (err: unknown) {
    // simple-git wraps failures in GitError – extract a human-friendly message
    const message =
      err instanceof GitError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);

    // Detect common failure modes and give actionable messages
    if (
      /not found/i.test(message) ||
      /repository.*does not exist/i.test(message)
    ) {
      throw new Error(
        `[Ingestor] Repository not found: "${repoUrl}". Verify the URL and that the repo is public (or credentials are provided).`,
      );
    }
    if (/authentication/i.test(message) || /permission denied/i.test(message)) {
      throw new Error(
        `[Ingestor] Authentication failed for "${repoUrl}". Ensure a valid token/SSH key is configured.`,
      );
    }
    throw new Error(`[Ingestor] Git clone failed: ${message}`);
  }

  logger.info(LOG_CTX, `Clone complete → ${targetDir}`);
  return targetDir;
}

// ─── 2. Smart Exclusion (The Filter) ────────────────────────────────────────

/**
 * Builds an `ignore` instance from the repo's `.gitignore` merged with our
 * hardened baseline patterns.
 */
async function buildIgnoreFilter(repoRoot: string): Promise<Ignore> {
  const ig = ignore();

  // Always apply baseline patterns first
  ig.add(BASELINE_IGNORE_PATTERNS as string[]);

  // Layer on the repo's own .gitignore (if present)
  const gitignorePath = path.join(repoRoot, ".gitignore");
  try {
    const content = await fs.readFile(gitignorePath, "utf-8");
    ig.add(content);
    logger.info(
      LOG_CTX,
      `Loaded .gitignore (${content.split("\n").length} rules)`,
    );
  } catch {
    logger.debug(
      LOG_CTX,
      "No .gitignore found – relying on baseline patterns only",
    );
  }

  return ig;
}

/**
 * Walks the cloned repo, applies ignore rules, enforces the 1 MB size cap,
 * and returns absolute paths to every file eligible for static analysis.
 */
async function filterFiles(repoRoot: string): Promise<string[]> {
  const ig = await buildIgnoreFilter(repoRoot);

  // fast-glob returns paths relative to `cwd` when `cwd` is set
  const allRelativePaths: string[] = await fg("**/*", {
    cwd: repoRoot,
    dot: true, // include dotfiles so we can explicitly ignore them
    onlyFiles: true,
    absolute: false, // we need relative paths for the ignore filter
    followSymbolicLinks: false,
  });

  logger.info(LOG_CTX, `Discovered ${allRelativePaths.length} raw files`);

  // Phase A: apply ignore rules
  const afterIgnore: string[] = allRelativePaths.filter(
    (rel: string) => !ig.ignores(rel),
  );
  logger.info(
    LOG_CTX,
    `After ignore filter: ${afterIgnore.length} files remain`,
  );

  // Phase B: enforce size limit (parallel stat calls for speed)
  const sizeChecks: { abs: string; size: number }[] = await Promise.all(
    afterIgnore.map(async (rel: string) => {
      const abs = path.join(repoRoot, rel);
      try {
        const stat = await fs.stat(abs);
        return { abs, size: stat.size };
      } catch {
        // File disappeared between glob and stat (race condition) – skip
        return { abs, size: Infinity };
      }
    }),
  );

  const targetFiles = sizeChecks
    .filter(({ size }) => size <= MAX_FILE_SIZE_BYTES)
    .map(({ abs }) => abs);

  logger.info(
    LOG_CTX,
    `After 1 MB size cap: ${targetFiles.length} files eligible for analysis`,
  );

  return targetFiles;
}

// ─── 3. Repo Fingerprinting ─────────────────────────────────────────────────

/**
 * Runs `linguist-js` over the cloned repository to determine the tech stack.
 * Returns the primary language and a percentage breakdown.
 */
async function fingerprintRepo(
  repoRoot: string,
): Promise<RepoManifest["fingerprint"]> {
  logger.info(LOG_CTX, "Running language fingerprinting…");

  try {
    const result = await linguist(repoRoot, { childLanguages: false });

    // linguist-js shape:
    //   result.languages.results → Record<lang, { type, bytes, lines, color }>
    //   result.languages.bytes   → total bytes across all languages
    //   result.languages.count   → number of distinct languages detected
    const langResults = result.languages?.results ?? {};
    const totalBytes: number =
      (result.languages as { bytes?: number })?.bytes ?? 0;

    // Build a percentage map
    const languages: Record<string, number> = {};
    let primaryLanguage = "Unknown";
    let maxBytes = 0;

    for (const [lang, info] of Object.entries(langResults)) {
      const entry = info as { bytes?: number } | undefined;
      const bytes = entry?.bytes ?? 0;
      const pct =
        totalBytes > 0 ? Math.round((bytes / totalBytes) * 10000) / 100 : 0;
      languages[lang] = pct;

      if (bytes > maxBytes) {
        maxBytes = bytes;
        primaryLanguage = lang;
      }
    }

    logger.info(LOG_CTX, `Primary language: ${primaryLanguage}`);
    return { primaryLanguage, languages };
  } catch (err: unknown) {
    logger.warn(
      LOG_CTX,
      `Linguist analysis failed – returning "Unknown". Error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { primaryLanguage: "Unknown", languages: {} };
  }
}

// ─── 4. Supply-Chain Scanning (osv-scanner) ─────────────────────────────────

/**
 * Normalises the severity string returned by OSV into our strict union type.
 * OSV may return CVSS-style labels or UPPERCASE/lowercase variants.
 */
function normaliseSeverity(
  raw: string | undefined,
): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  const upper = (raw ?? "MEDIUM").toUpperCase();
  if (upper === "CRITICAL") return "CRITICAL";
  if (upper === "HIGH") return "HIGH";
  if (upper === "LOW") return "LOW";
  return "MEDIUM";
}

/**
 * OSV-Scanner JSON output shape (simplified to what we need).
 * The full spec is at: https://google.github.io/osv-scanner/output
 */
interface OsvResult {
  results?: {
    packages?: {
      package?: { name?: string; version?: string };
      vulnerabilities?: {
        id?: string;
        summary?: string;
        database_specific?: { severity?: string };
        severity?: { type?: string; score?: string }[];
      }[];
    }[];
  }[];
}

/**
 * Executes `osv-scanner` in recursive mode and maps the output to
 * `DependencyRisk[]`.
 *
 * IMPORTANT:  osv-scanner exits with code 1 when vulnerabilities are found.
 * We deliberately catch the error, extract stdout, and parse it.
 * If the binary is missing entirely we degrade gracefully.
 */
async function scanDependencies(repoRoot: string): Promise<DependencyRisk[]> {
  logger.info(
    LOG_CTX,
    "Starting supply-chain vulnerability scan (osv-scanner)…",
  );

  let rawJson: string;

  try {
    // osv-scanner exits 0 = no vulns, 1 = vulns found (but valid JSON in stdout)
    const { stdout } = await execAsync(`osv-scanner -r "${repoRoot}" --json`, {
      maxBuffer: 10 * 1024 * 1024, // 10 MB buffer for large repos
      timeout: 120_000, // 2-minute timeout
    });
    rawJson = stdout;
  } catch (err: unknown) {
    // ── Case A: osv-scanner found vulnerabilities (exit code 1) ──
    // Node wraps this in an error object that still contains stdout.
    const execErr = err as {
      stdout?: string;
      stderr?: string;
      code?: number;
      message?: string;
    };
    if (execErr.stdout && execErr.stdout.trim().startsWith("{")) {
      rawJson = execErr.stdout;
    } else {
      // ── Case B: binary not installed / other hard failure ──
      logger.warn(
        LOG_CTX,
        `osv-scanner unavailable or failed – skipping supply-chain scan. ` +
          `(${execErr.message ?? "unknown error"})`,
      );
      return [];
    }
  }

  // Parse the JSON output
  let osvData: OsvResult;
  try {
    osvData = JSON.parse(rawJson) as OsvResult;
  } catch {
    logger.warn(LOG_CTX, "Failed to parse osv-scanner JSON output – skipping.");
    return [];
  }

  // ── Map OSV output → DependencyRisk[] ──
  const risks: DependencyRisk[] = [];

  for (const result of osvData.results ?? []) {
    for (const pkg of result.packages ?? []) {
      const pkgName = pkg.package?.name ?? "unknown";
      const pkgVersion = pkg.package?.version ?? "unknown";

      const vulnerabilities = (pkg.vulnerabilities ?? []).map((vuln) => {
        // Prefer database_specific.severity, fall back to the first CVSS entry
        const severityRaw =
          vuln.database_specific?.severity ??
          vuln.severity?.[0]?.score ??
          "MEDIUM";

        return {
          cveId: vuln.id ?? "N/A",
          severity: normaliseSeverity(severityRaw),
          summary: vuln.summary ?? "No summary provided.",
        };
      });

      if (vulnerabilities.length > 0) {
        risks.push({ package: pkgName, version: pkgVersion, vulnerabilities });
      }
    }
  }

  logger.info(
    LOG_CTX,
    `Supply-chain scan complete: ${risks.length} vulnerable packages detected`,
  );

  return risks;
}

// ─── 5. Main Orchestrator ───────────────────────────────────────────────────

/**
 * **ingestRepository** – the single public entry point for Phase 1.
 *
 * Orchestrates the full ingestion pipeline:
 *   clone → filter → fingerprint → scan → manifest
 *
 * @param repoUrl  HTTPS or SSH URL of the target GitHub repository.
 * @param jobId    Unique identifier for this analysis job (typically a UUID).
 * @returns        A fully-populated `RepoManifest`.
 */
export const ingestRepository = async (
  repoUrl: string,
  jobId: string,
): Promise<RepoManifest> => {
  logger.info(LOG_CTX, `════════════════════════════════════════════════════`);
  logger.info(LOG_CTX, `Starting ingestion  jobId=${jobId}  repo=${repoUrl}`);
  logger.info(LOG_CTX, `════════════════════════════════════════════════════`);

  const startTime = Date.now();

  // Step 1 – Clone
  const localPath = await cloneRepository(repoUrl, jobId);

  // Steps 2–4 run concurrently – they are independent of each other
  const [targetFiles, fingerprint, dependencyRisks] = await Promise.all([
    filterFiles(localPath), // Step 2
    fingerprintRepo(localPath), // Step 3
    scanDependencies(localPath), // Step 4
  ]);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  logger.info(
    LOG_CTX,
    `Ingestion complete in ${elapsed}s  files=${targetFiles.length}`,
  );

  // Assemble the manifest
  const manifest: RepoManifest = {
    jobId,
    localPath,
    fingerprint,
    dependencyRisks,
    targetFiles,
  };

  return manifest;
};

// ═══════════════════════════════════════════════════════════════════════════════
//
// LLM API CALL DIAGNOSIS & SOLUTION REPORT
// Code-Analyser Platform
//
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ISSUE SUMMARY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * When running the server and uploading a repository for analysis, NO external
 * LLM API calls were being made—even though OPENAI_API_KEY was set in .env.
 *
 * ROOT CAUSE:
 * -----------
 * The codebase was ALWAYS using a built-in "smart stub LLM" function, regardless
 * of whether a real API key was present. The initialization code did not check
 * the environment variables before deciding which LLM provider to use.
 *
 * EVIDENCE:
 * ---------
 * 1. In /src/index.ts (line 101):
 *    const stubLlmFn = createSmartStubLlm();
 *
 * 2. In /src/delivery/worker.ts (line 52):
 *    const stubLlmFn = createSmartStubLlm();
 *
 * 3. Both files then pass stubLlmFn unconditionally to the council agents:
 *    getCouncilConfig() returns { llmFn: stubLlmFn, ... }
 *
 * 4. The smart stub LLM (smart-stub-llm.ts) is a stateless function that:
 *    - Returns synthetic "tool calls" on the first iteration.
 *    - Synthesizes findings from tool output on subsequent iterations.
 *    - Never makes any external API calls.
 *
 * 5. The .env file has OPENAI_API_KEY set, but the code never reads it to
 *    conditionally choose between real vs. stub LLM.
 *
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SOLUTION IMPLEMENTED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Created a new module: /src/council/openai-llm.ts
 *
 * This module implements:
 * 1. createOpenAiLlm() function that:
 *    - Checks if OPENAI_API_KEY is set and non-empty.
 *    - If present: uses the real OpenAI API (https://api.openai.com/v1/chat/completions).
 *    - If absent: falls back to the smart stub LLM.
 *
 * 2. Proper message format conversion between internal format and OpenAI format.
 *
 * 3. Tool definition conversion (internal ToolDefinition → OpenAI function schema).
 *
 * 4. Tool call parsing (OpenAI tool_calls → internal ToolCall format).
 *
 * 5. Error handling with automatic fallback to stub LLM if the API call fails.
 *
 * Updated Files:
 * ===============
 * - /src/index.ts              (line 46): Import createOpenAiLlm instead of createSmartStubLlm
 * - /src/index.ts              (line 101): Create llmFn = createOpenAiLlm()
 * - /src/delivery/worker.ts    (line 52): Import createOpenAiLlm instead of createSmartStubLlm
 * - /src/delivery/worker.ts    (line 53): Create llmFn = createOpenAiLlm()
 * - /src/council/openai-llm.ts (NEW FILE): Full OpenAI provider implementation
 *
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY AGENT ANALYSIS PROCESS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * When a repository is uploaded and analyzed, the Security Agent executes this
 * workflow:
 *
 * PHASE 1: Initial Tool Calls (First Iteration)
 * ==============================================
 * The agent's first response is to call these security tools in parallel:
 *
 * 1. query_knowledge_graph
 *    - Query: "security vulnerabilities, injection risks, authentication issues"
 *    - Retrieves the top 20 most relevant code chunks.
 *    - Uses hybrid retrieval (vector + keyword) from Qdrant vector DB.
 *
 * 2. check_cve_database
 *    - Scans extracted package dependencies (from package.json, requirements.txt, etc).
 *    - Cross-references against a CVE database or known vulnerability list.
 *    - Returns matching CVE entries with severity levels.
 *
 * 3. run_semgrep_rule
 *    - Executes static pattern matching rules (Semgrep-style rules).
 *    - Detects common security anti-patterns:
 *      * SQL injection vulnerabilities
 *      * XSS vulnerabilities
 *      * Insecure deserialization
 *      * Hardcoded secrets and API keys
 *      * Insecure cryptography
 *      * XXE (XML External Entity) issues
 *    - Returns matched code locations and patterns.
 *
 * PHASE 2: Secondary Analysis (Second Iteration)
 * ===============================================
 * Based on tool results from Phase 1, the agent may call:
 *
 * 4. trace_data_flow
 *    - For findings suggesting user input reaching dangerous sinks:
 *      * Input → Dangerous Function (SQL query, HTML output, etc)
 *    - Traces variable assignments and function calls through the AST.
 *    - Confirms whether untrusted data can reach vulnerable code paths.
 *
 * 5. query_knowledge_graph (second call)
 *    - If initial findings suggest a vulnerability type, queries for similar
 *      patterns (e.g., "all SQL query constructions in this codebase").
 *    - Determines if the issue is widespread or isolated.
 *
 * PHASE 3: Synthesis (Final Iteration)
 * ====================================
 * The Security Agent compiles all findings into structured output:
 *
 * {
 *   securityFindings: [
 *     {
 *       category: "INJECTION",
 *       severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
 *       title: "SQL Injection in User Search",
 *       description: "User input directly interpolated into SQL query",
 *       locations: [
 *         { filePath: "src/db.ts", line: 42, column: 10 }
 *       ],
 *       remediation: "Use parameterized queries or prepared statements"
 *     },
 *     // ... more findings
 *   ]
 * }
 *
 * WHAT THE SECURITY AGENT WILL FIND (Examples)
 * =============================================
 *
 * Category: AUTHENTICATION & SECRETS
 * ----------------------------------
 * - Hardcoded API keys, passwords, or private keys
 * - Unprotected admin endpoints
 * - Missing rate limiting on auth endpoints
 * - Weak password hashing algorithms
 *
 * Category: INJECTION ATTACKS
 * ---------------------------
 * - SQL injection (user input in SQL queries)
 * - NoSQL injection (MongoDB query manipulation)
 * - Command injection (shell command execution)
 * - Template injection (server-side template rendering)
 * - LDAP injection (directory lookup queries)
 *
 * Category: SENSITIVE DATA EXPOSURE
 * ---------------------------------
 * - Sensitive data logged to console or files
 * - Unencrypted database connections
 * - Exposed API endpoints returning PII
 * - Weak TLS/SSL configurations
 *
 * Category: CRYPTOGRAPHIC FAILURES
 * --------------------------------
 * - Use of deprecated crypto algorithms (MD5, SHA1)
 * - Weak random number generation (Math.random)
 * - Hardcoded encryption keys
 * - Inadequate key derivation functions
 *
 * Category: DEPENDENCY VULNERABILITIES
 * ------------------------------------
 * - Outdated npm/pip packages with known CVEs
 * - Direct dependencies on unmaintained libraries
 * - Transitive dependency vulnerabilities
 *
 * Category: BROKEN ACCESS CONTROL
 * --------------------------------
 * - Missing authentication checks
 * - Insufficient authorization validation
 * - Direct object reference (IDOR) vulnerabilities
 * - Privilege escalation paths
 *
 * Category: SECURITY MISCONFIGURATION
 * -----------------------------------
 * - Debugging features left enabled in production
 * - Exposed .env files or configuration
 * - Missing security headers (CSP, HSTS, etc)
 * - Overpermissive CORS policies
 *
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW THE STUB LLM WORKS (When API Key Is Absent)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The "smart stub LLM" (createSmartStubLlm) is designed to:
 *
 * 1. Detect which agent is running based on the system prompt:
 *    - if systemMsg.includes("Security Agent") → emit security tool calls
 *    - if systemMsg.includes("Performance Agent") → emit performance tool calls
 *    - etc.
 *
 * 2. On first iteration (assistantTurns === 0):
 *    - Return synthetic tool calls with realistic parameters.
 *    - This ensures the real analysis tools execute, producing actual findings.
 *
 * 3. On subsequent iterations (after tool results arrive):
 *    - Parse the tool output and synthesize findings from it.
 *    - Build structured findings JSON from the real data collected.
 *
 * EXAMPLE: Security Agent with Stub LLM
 * ======================================
 *
 * Iteration 1 (Stub LLM Returns):
 * {
 *   role: "assistant",
 *   content: "",
 *   toolCalls: [
 *     {
 *       name: "check_cve_database",
 *       arguments: { dependencies: ["lodash", "express", ...] }
 *     },
 *     {
 *       name: "run_semgrep_rule",
 *       arguments: { patterns: ["injection", "auth", ...] }
 *     }
 *   ]
 * }
 *
 * (Tools execute, real vulnerabilities are found...)
 *
 * Iteration 2 (Stub LLM Reads Tool Results):
 * - Parses the JSON output from each tool
 * - Constructs JSON findings from the actual data
 * - Returns:
 * {
 *   role: "assistant",
 *   content: "{\"securityFindings\": [...actual findings...]}"
 * }
 *
 * KEY DIFFERENCE: Stub vs. Real LLM
 * ==================================
 *
 * STUB LLM (No API Key):
 * ├─ Deterministic tool call generation
 * ├─ Synthesizes findings from tool output using hardcoded rules
 * └─ Fast, no API latency, no costs
 *
 * REAL LLM (With OpenAI API Key):
 * ├─ LLM decides which tools to call based on the code and prompts
 * ├─ LLM synthesizes findings using natural language understanding
 * ├─ More flexible, adaptive, can discover novel issues
 * ├─ Higher latency (~5-15s per iteration), costs $$ per call
 * └─ Can reason about complex security patterns and context
 *
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VERIFICATION: Is Your API Key Working?
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * After applying this fix, verify the real LLM is being used:
 *
 * 1. Check server logs during startup:
 *    [INFO] OpenAI-LLM: Using OpenAI API with model: gpt-4-turbo
 *    (or: No OPENAI_API_KEY present — using smart stub LLM instead)
 *
 * 2. Monitor API logs:
 *    - Each agent iteration should make a POST to https://api.openai.com/v1/chat/completions
 *    - Check your OpenAI account dashboard for API usage
 *
 * 3. Observe timing:
 *    - Real LLM: 5-15 seconds per agent iteration
 *    - Stub LLM: ~100ms per iteration
 *
 * 4. Check response quality:
 *    - Real LLM: More nuanced findings, context-aware explanations
 *    - Stub LLM: Findings based on tool output only, formulaic explanations
 *
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TROUBLESHOOTING
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * If API calls are still not working:
 *
 * 1. Verify .env file:
 *    ✓ OPENAI_API_KEY=sk-proj-... (not empty)
 *    ✓ OPENAI_MODEL=gpt-4-turbo (or another valid model)
 *    ✗ Do NOT commit .env to git; it should be in .gitignore
 *
 * 2. Check API key validity:
 *    curl -H "Authorization: Bearer $OPENAI_API_KEY" \
 *         https://api.openai.com/v1/models
 *
 * 3. Verify server is reading .env:
 *    Add logging in openai-llm.ts at line ~32:
 *    logger.info(LOG_CTX, `API Key present: ${!!apiKey}`);
 *
 * 4. Check for network issues:
 *    - Firewall/proxy blocking api.openai.com?
 *    - VPN interfering with requests?
 *
 * 5. Monitor API errors in logs:
 *    If "OpenAI-LLM: OpenAI API call failed" appears, check:
 *    - API key still valid (wasn't revoked)
 *    - Account has credits/billing enabled
 *    - Model name matches an available model
 *
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FILE STRUCTURE (Post-Fix)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * /src/council/
 * ├── openai-llm.ts (NEW)      ← Real LLM provider
 * ├── smart-stub-llm.ts        ← Fallback stub provider
 * ├── council.orchestrator.ts  ← Uses llmFn from config
 * ├── agents/
 * │   ├── security.agent.ts    ← Calls llmFn for each iteration
 * │   ├── performance.agent.ts
 * │   ├── architecture.agent.ts
 * │   └── ...
 * └── ...
 *
 * /src/index.ts
 * └── imports createOpenAiLlm → passes to getCouncilConfig() → used by all agents
 *
 * /src/delivery/worker.ts
 * └── imports createOpenAiLlm → same flow for background job processing
 *
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

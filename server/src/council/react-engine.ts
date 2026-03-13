// ─────────────────────────────────────────────────────────────────────────────
// src/council/react-engine.ts
//
// ReAct (Reason + Act) Loop Engine.
//
// Every agent in the council is powered by this engine:
//   1. Send messages + tool definitions to the LLM.
//   2. If the LLM returns tool calls, execute them.
//   3. Feed tool results back as "tool" role messages.
//   4. Repeat until the LLM responds without tool calls or max iterations hit.
//   5. Return the final assistant message.
//
// This is the TypeScript equivalent of LangGraph's ToolNode + agent executor,
// built from scratch to avoid heavy framework dependencies.
// ─────────────────────────────────────────────────────────────────────────────

import { v4 as uuidv4 } from "uuid";
import { logger } from "../utils/logger";
import type {
  LLMMessage,
  LLMCompletionFn,
  ToolDefinition,
  AgentTool,
  EvidenceItem,
} from "../interfaces/council.interface";

const LOG_CTX = "ReActEngine";

// ─── ReAct Loop Configuration ────────────────────────────────────────────────

export interface ReActConfig {
  /** Agent identifier for logging */
  agentId: string;
  /** System prompt for the agent */
  systemPrompt: string;
  /** Tools available to this agent */
  tools: AgentTool[];
  /** LLM completion function */
  llmFn: LLMCompletionFn;
  /** Maximum reasoning iterations (default: 10) */
  maxIterations: number;
  /** Temperature for LLM calls */
  temperature: number;
}

// ─── ReAct Loop Result ───────────────────────────────────────────────────────

export interface ReActResult {
  /** The final text response from the agent */
  response: string;
  /** All tool calls made during the loop (audit trail) */
  evidence: EvidenceItem[];
  /** Number of iterations used */
  iterations: number;
  /** Whether max iterations was reached */
  maxIterationsReached: boolean;
}

// ─── The ReAct Loop ──────────────────────────────────────────────────────────

/**
 * Executes a ReAct (Reason + Act) loop:
 *   Reason → (optional) Act → Observe → Reason → … → Final Answer
 *
 * @param config   - Agent configuration (system prompt, tools, LLM fn).
 * @param userMsg  - The user/task message to send to the agent.
 * @returns        The final response and evidence trail.
 */
export async function executeReActLoop(
  config: ReActConfig,
  userMsg: string,
): Promise<ReActResult> {
  const { agentId, systemPrompt, tools, llmFn, maxIterations, temperature } =
    config;

  // Build tool definitions from AgentTool objects for the LLM
  const toolDefs: ToolDefinition[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  // Build the tool executor map
  const toolMap = new Map<string, AgentTool>();
  for (const tool of tools) {
    toolMap.set(tool.name, tool);
  }

  // Initialise conversation
  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMsg },
  ];

  const evidence: EvidenceItem[] = [];
  let iterations = 0;

  logger.info(
    LOG_CTX,
    `[${agentId}] Starting ReAct loop (max ${maxIterations} iterations)`,
  );

  while (iterations < maxIterations) {
    iterations++;
    logger.debug(
      LOG_CTX,
      `[${agentId}] Iteration ${iterations}/${maxIterations}`,
    );

    // ── Reason: Ask the LLM ──
    let response: LLMMessage;
    try {
      response = await llmFn(
        messages,
        toolDefs.length > 0 ? toolDefs : undefined,
        temperature,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(LOG_CTX, `[${agentId}] LLM call failed: ${msg}`);
      return {
        response: `Agent "${agentId}" encountered an LLM error: ${msg}`,
        evidence,
        iterations,
        maxIterationsReached: false,
      };
    }

    // Add the assistant response to conversation history
    messages.push(response);

    // ── Check: Does the LLM want to call tools? ──
    if (!response.toolCalls || response.toolCalls.length === 0) {
      // No tool calls → final answer
      logger.info(
        LOG_CTX,
        `[${agentId}] Completed in ${iterations} iteration(s), ${evidence.length} tool call(s)`,
      );
      return {
        response: response.content,
        evidence,
        iterations,
        maxIterationsReached: false,
      };
    }

    // ── Act: Execute each tool call ──
    for (const toolCall of response.toolCalls) {
      const tool = toolMap.get(toolCall.name);
      const callId = toolCall.id || uuidv4();
      // Normalise id in-place: if the LLM didn't supply one, write the
      // generated id back so the stored assistant message's toolCalls[].id
      // always matches the tool_call_id of the corresponding tool-result
      // message sent to the API on the next iteration.
      if (!toolCall.id) {
        toolCall.id = callId;
      }

      if (!tool) {
        // Unknown tool — feed back an error
        const errMsg = `Unknown tool "${toolCall.name}". Available: ${[...toolMap.keys()].join(", ")}`;
        logger.warn(LOG_CTX, `[${agentId}] ${errMsg}`);
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: errMsg }),
          toolCallId: callId,
        });
        continue;
      }

      logger.debug(
        LOG_CTX,
        `[${agentId}] Calling tool "${toolCall.name}" with args: ${JSON.stringify(toolCall.arguments).slice(0, 200)}`,
      );

      // Execute the tool
      let toolResult: string;
      try {
        toolResult = await tool.execute(toolCall.arguments);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toolResult = JSON.stringify({ error: `Tool execution failed: ${msg}` });
        logger.error(
          LOG_CTX,
          `[${agentId}] Tool "${toolCall.name}" failed: ${msg}`,
        );
      }

      // Record evidence
      evidence.push({
        toolName: toolCall.name,
        input: toolCall.arguments,
        output: toolResult.slice(0, 2000), // cap for storage
        timestamp: new Date().toISOString(),
      });

      // ── Observe: Feed tool result back to the LLM ──
      messages.push({
        role: "tool",
        content: toolResult,
        toolCallId: callId,
      });
    }
  }

  // Max iterations reached — return whatever we have
  logger.warn(
    LOG_CTX,
    `[${agentId}] Max iterations (${maxIterations}) reached — returning partial result`,
  );

  const lastAssistant = messages.filter((m) => m.role === "assistant").pop();

  return {
    response:
      lastAssistant?.content ??
      `Agent "${agentId}" reached max iterations without a final answer.`,
    evidence,
    iterations,
    maxIterationsReached: true,
  };
}

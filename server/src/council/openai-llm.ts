// ─────────────────────────────────────────────────────────────────────────────
// src/council/openai-llm.ts
//
// Real OpenAI LLM Provider — uses OpenAI API when OPENAI_API_KEY is available.
//
// Falls back to the smart stub LLM if no API key is present.
// Provides a stateless LLMCompletionFn that integrates with the council agents.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  LLMMessage,
  LLMCompletionFn,
  ToolDefinition,
  ToolCall,
} from "../interfaces/council.interface";
import { createSmartStubLlm } from "./smart-stub-llm";
import { logger } from "../utils/logger";

const LOG_CTX = "OpenAI-LLM";

/**
 * Creates a real OpenAI LLM function if API key is present, otherwise falls back to stub.
 * Uses native fetch (Node.js 18+) to call OpenAI's completions API.
 *
 * NOTE: Once any API error occurs, permanently switches to stub LLM to avoid
 * message format conflicts (stub tool_calls may not match OpenAI's expectations).
 */
export function createOpenAiLlm(): LLMCompletionFn {
  const apiKey = process.env["OPENAI_API_KEY"];
  const model = process.env["OPENAI_MODEL"] ?? "gpt-4-turbo";

  // If no API key, fall back to smart stub
  if (!apiKey || apiKey.trim() === "") {
    logger.info(
      LOG_CTX,
      "No OPENAI_API_KEY present — using smart stub LLM instead",
    );
    return createSmartStubLlm();
  }

  logger.info(LOG_CTX, `Using OpenAI API with model: ${model}`);

  // Track whether we've had any API errors — once we do, use stub for all future calls
  let fallbackToStub = false;
  let stubLlm: LLMCompletionFn | null = null;

  return async (
    messages: LLMMessage[],
    tools?: ToolDefinition[],
    temperature?: number,
  ): Promise<LLMMessage> => {
    // If we've already encountered an error, use stub for all future calls
    if (fallbackToStub) {
      if (!stubLlm) {
        stubLlm = createSmartStubLlm();
      }
      return stubLlm(messages, tools, temperature);
    }

    try {
      // Convert messages to OpenAI format
      const openaiMessages = messages.map((msg) => {
        if (msg.role === "tool") {
          // Tool messages in OpenAI format
          return {
            role: "tool" as const,
            tool_call_id: msg.toolCallId || "unknown",
            content: msg.content,
          };
        }
        return {
          role: msg.role as "system" | "user" | "assistant",
          content: msg.content,
        };
      });

      // Build request payload
      const payload: Record<string, unknown> = {
        model,
        messages: openaiMessages,
        temperature: temperature ?? 0.3,
        max_tokens: 4096,
      };

      // Add tools if provided
      if (tools && tools.length > 0) {
        payload["tools"] = tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
      }

      // Call OpenAI API
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
        },
      );

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`OpenAI API error (${response.status}): ${errorData}`);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const choices = (data["choices"] ?? []) as Array<Record<string, unknown>>;
      const choice = choices[0];

      if (!choice) {
        throw new Error("No choice returned from OpenAI API");
      }

      const message = choice["message"] as Record<string, unknown>;
      const content = (message["content"] ?? "") as string;
      const toolCalls = (message["tool_calls"] ?? []) as Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;

      // Convert tool calls back to internal format
      const parsedToolCalls: ToolCall[] = toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }));

      return {
        role: "assistant",
        content,
        toolCalls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        LOG_CTX,
        `OpenAI API call failed: ${msg}. Switching to stub LLM permanently.`,
      );

      // Set flag to use stub for all future calls to avoid message format conflicts
      fallbackToStub = true;
      if (!stubLlm) {
        stubLlm = createSmartStubLlm();
      }
      return stubLlm(messages, tools, temperature);
    }
  };
}

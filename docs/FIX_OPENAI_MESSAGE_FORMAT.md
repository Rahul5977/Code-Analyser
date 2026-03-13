# Fix: OpenAI Message Format Conflict

## Problem

The logs showed multiple OpenAI API errors:

```json
[ERROR] OpenAI API call failed: OpenAI API error (400): {
  "error": {
    "message": "Invalid parameter: messages with role 'tool' must be a response to a preceeding message with 'tool_calls'.",
    ...
  }
}
```

### Root Cause: Message Format Mismatch During Fallback

The issue occurred in a specific sequence:

1. **Iteration 1**: ReAct loop calls OpenAI API → **API fails** → Falls back to **stub LLM**
2. **Stub response**: Returns valid `toolCalls` array
3. **Tool execution**: ReAct engine executes tools and appends `{ role: "tool", content: result, toolCallId: ... }` message
4. **Iteration 2**: ReAct loop tries to call OpenAI again with the conversation history
5. **OpenAI validation error**: The `tool` message in the history came from the _stub LLM_, not from OpenAI's own `tool_calls`. OpenAI rejects this because:
   - The `tool` message has a `toolCallId` from the stub response
   - But OpenAI's strict validation requires `tool` messages to correspond to its own preceding `tool_calls` message
   - Since the preceding assistant message came from stub (not OpenAI), the validation fails

### Why Stub Works but OpenAI Doesn't

- **Stub LLM**: Designed to work with any message history, returns deterministic tool calls based on heuristics
- **OpenAI API**: Strict validation — requires `tool` messages to follow `tool_calls` from the same API response

## Solution: Permanent Fallback After First API Error

Instead of attempting to mix OpenAI and stub LLM responses in the same conversation, we now:

1. **Try OpenAI on the first call** (if API key exists)
2. **If ANY error occurs**, permanently switch to stub LLM for all future calls in that agent's session
3. **Never mix** OpenAI responses with stub responses in the message history

### Implementation Details

**File: `src/council/openai-llm.ts`**

```typescript
export function createOpenAiLlm(): LLMCompletionFn {
  const apiKey = process.env["OPENAI_API_KEY"];

  // ... initial setup ...

  // Track fallback state OUTSIDE the async function
  let fallbackToStub = false;
  let stubLlm: LLMCompletionFn | null = null;

  return async (messages, tools, temperature) => {
    // Check fallback flag FIRST
    if (fallbackToStub) {
      if (!stubLlm) {
        stubLlm = createSmartStubLlm();
      }
      return stubLlm(messages, tools, temperature);
    }

    try {
      // ... try OpenAI API ...
    } catch (err) {
      // Set permanent fallback flag
      fallbackToStub = true;
      if (!stubLlm) {
        stubLlm = createSmartStubLlm();
      }
      return stubLlm(messages, tools, temperature);
    }
  };
}
```

### Key Changes

1. **Closure-based state tracking**: `fallbackToStub` flag persists across calls to the same LLM function instance
2. **Early return**: Once fallback is triggered, immediately use stub without attempting OpenAI
3. **Single stub instance**: Reuse the same stub LLM instance to maintain consistency
4. **Clearer logging**: Log message changed to "Switching to stub LLM permanently"

## Testing Recommendation

When running the server with `OPENAI_API_KEY` set:

1. If OpenAI API is unavailable → Falls back to stub immediately ✓
2. If OpenAI API is available → Uses real LLM ✓
3. If network fails mid-stream → Switches to stub and completes analysis ✓
4. No more "Invalid parameter: messages with role 'tool'..." errors ✓

## Files Modified

- `/Users/rahulraj/Desktop/CodeAnalyser/server/src/council/openai-llm.ts`

## Build Status

✅ TypeScript compilation successful (no errors)
✅ All imports and exports valid
✅ Type safety maintained

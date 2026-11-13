/**
 * Message-format adapter between OpenAI-style and Anthropic-style messages.
 *
 * Used by the chat agent (agent.js) and NL query (nlQuery.js) so they can run
 * against either provider without the caller knowing which one is active.
 *
 * Key differences between the two formats:
 *
 *   OpenAI                            Anthropic
 *   ------                            ---------
 *   system role on messages           separate `system` string parameter
 *   tool_calls array on assistant msg content blocks with type "tool_use"
 *   tool role for results             content blocks with type "tool_result"
 *   function.name / function.args     name / input (parsed JSON object)
 *   response_format: json_object      prompt-level JSON instruction
 *
 * This module is a pure data converter. It must never modify message content
 * — doing so would be a prompt-injection vector.
 */

// ---------------------------------------------------------------------------
// Messages: OpenAI → Anthropic
// ---------------------------------------------------------------------------

/**
 * Extract the system prompt from OpenAI-format messages.
 * Returns a concatenated string (Anthropic uses a single system parameter).
 */
function extractSystemPrompt(messages) {
  const system = messages.filter((m) => m.role === 'system');
  if (!system.length) return '';
  return system.map((m) => m.content).join('\n\n');
}

/**
 * Convert an array of OpenAI-format messages to Anthropic format.
 * System messages are stripped out — call extractSystemPrompt() separately.
 */
function messagesToAnthropic(messages) {
  const rest = messages.filter((m) => m.role !== 'system');

  return rest.map((msg) => {
    // User message: content is always a string in this codebase.
    if (msg.role === 'user') {
      return { role: 'user', content: msg.content || '' };
    }

    // Tool result: OpenAI uses role "tool" with tool_call_id;
    // Anthropic uses a user message with tool_result content blocks.
    if (msg.role === 'tool') {
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          },
        ],
      };
    }

    // Assistant message: may have text content, tool_use blocks, or both.
    if (msg.role === 'assistant') {
      const content = [];

      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          let input;
          try {
            input = typeof tc.function.arguments === 'string'
              ? JSON.parse(tc.function.arguments || '{}')
              : (tc.function.arguments || {});
          } catch (_) {
            input = {};
          }
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }

      return { role: 'assistant', content: content.length > 0 ? content : [{ type: 'text', text: '' }] };
    }

    // Fallthrough: pass as-is (shouldn't happen with well-formed messages).
    return msg;
  });
}

// ---------------------------------------------------------------------------
// Tools: OpenAI → Anthropic
// ---------------------------------------------------------------------------

/**
 * Convert OpenAI tool definitions to Anthropic tool definitions.
 *
 * OpenAI:  { type: 'function', function: { name, description, parameters } }
 * Anthropic: { name, description, input_schema }
 */
function toAnthropicTools(openaiTools) {
  if (!openaiTools || openaiTools.length === 0) return undefined;
  return openaiTools.map((t) => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: t.function.parameters || { type: 'object', properties: {} },
  }));
}

// ---------------------------------------------------------------------------
// Anthropic streaming → OpenAI-compatible deltas
// ---------------------------------------------------------------------------

/**
 * Stream Anthropic messages and emit OpenAI-compatible delta events.
 *
 * Anthropic streaming event types (SDK v0.61):
 *   content_block_start  — a new content block (text or tool_use) begins
 *   content_block_delta  — a chunk of text_delta or input_json_delta
 *   content_block_stop   — a content block is complete
 *   message_delta        — stop_reason + usage
 *   message_stop         — final event
 *
 * Returns { content, toolCalls, usage } in the same shape as the OpenAI path.
 */
async function streamAnthropic(client, model, systemPrompt, messages, tools, maxTokens, onDelta, signal) {
  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens || 4096,
    system: systemPrompt || undefined,
    messages,
    tools,
  }, signal ? { signal } : undefined);

  let content = '';
  const toolCallsAcc = [];
  let usage = null;

  for await (const event of stream) {
    switch (event.type) {
      case 'content_block_start': {
        if (event.content_block?.type === 'tool_use') {
          // Keyed by the stream's own content-block index (event.index), the
          // same index `content_block_delta` uses below — NOT a separate
          // tool-only counter. Anthropic assigns indices across ALL content
          // blocks in the message (text blocks included), so a text block
          // preceding a tool_use block (the model explaining itself before
          // calling a tool, which it does routinely) shifts the tool_use
          // block's real index away from a simple 0,1,2... counter. Keying
          // on a separate counter left every input_json_delta looking up the
          // wrong slot — silently dropped since it found nothing there — so
          // the tool call reached executeTool with empty arguments. For a
          // tool like get_financial_summary that didn't error, it just
          // returned an unhelpful default result, and the model retried the
          // same tool again next step — repeating until the step budget was
          // exhausted and flooding ai_audit_log with dozens of identical
          // "AI Action" rows for one user turn.
          toolCallsAcc[event.index] = {
            id: event.content_block.id,
            function: { name: event.content_block.name, arguments: '' },
            type: 'function',
          };
        }
        break;
      }

      case 'content_block_delta': {
        if (event.delta?.type === 'text_delta') {
          content += event.delta.text;
          if (onDelta) onDelta(event.delta.text);
        }
        if (event.delta?.type === 'input_json_delta') {
          const idx = event.index;
          if (toolCallsAcc[idx]) {
            toolCallsAcc[idx].function.arguments += event.delta.partial_json;
          }
        }
        break;
      }

      case 'message_delta': {
        if (event.usage) {
          usage = {
            prompt_tokens: event.usage.input_tokens || 0,
            completion_tokens: event.usage.output_tokens || 0,
            total_tokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0),
          };
        }
        break;
      }

      case 'message_stop':
      case 'error':
        break;

      default:
        // Ignore other event types (ping, etc.)
        break;
    }
  }

  return {
    content,
    toolCalls: toolCallsAcc.filter(Boolean),
    messageExtra: {},
    model,
    usage,
  };
}

module.exports = {
  extractSystemPrompt,
  messagesToAnthropic,
  toAnthropicTools,
  streamAnthropic,
};

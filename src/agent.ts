export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_start" }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_stop" }
  | { type: "tool_use_start"; name: string; id: string }
  | { type: "tool_use_delta"; input_json: string }
  | { type: "tool_use_stop" }
  | { type: "tool_progress"; progress: string }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "tool_use_summary"; summary: string }
  | { type: "assistant_message"; text: string }
  | { type: "result"; session_id?: string; duration_ms?: number }
  | { type: "system"; message: string; subtype?: string }
  | { type: "session_id"; id: string }
  | { type: "ack" }
  | { type: "unknown"; raw: any };

export interface AgentStreamResult {
  text: string;
  sessionId: string | null;
  model: string | null;
}

export function processStreamDelta(
  accumulated: string,
  deltaText: string
): { text: string; accumulated: string } | null {
  let text = deltaText;
  if (!accumulated) {
    text = text.replace(/^[\n\r]+/, "");
    if (!text) return null;
  }
  return { text, accumulated: accumulated + text };
}

export function extractAssistantText(
  content: Array<{ type: string; text?: string }>
): string {
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("");
}

function processStreamEvent(
  event: any,
  blockTypes: Map<number, string>,
  accumulatedText: string,
  onEvent: (event: AgentEvent) => void
): string {
  if (!event) return accumulatedText;

  const eventType = event.type as string | undefined;

  if (eventType === "content_block_start" && event.index != null) {
    const blockType = event.content_block?.type as string | undefined;
    if (blockType) blockTypes.set(event.index, blockType);

    if (blockType === "thinking") {
      onEvent({ type: "thinking_start" });
    } else if (blockType === "tool_use") {
      onEvent({
        type: "tool_use_start",
        name: event.content_block.name ?? "",
        id: event.content_block.id ?? "",
      });
    }
    return accumulatedText;
  }

  if (eventType === "content_block_delta" && event.delta) {
    const deltaType = event.delta.type as string | undefined;

    if (deltaType === "thinking_delta" && event.delta.thinking) {
      onEvent({ type: "thinking_delta", text: event.delta.thinking });
      return accumulatedText;
    }

    if (deltaType === "text_delta" && event.delta.text) {
      const result = processStreamDelta(accumulatedText, event.delta.text);
      if (result) {
        onEvent({ type: "text_delta", text: result.text });
        return result.accumulated;
      }
      return accumulatedText;
    }

    if (deltaType === "input_json_delta" && event.delta.partial_json) {
      onEvent({ type: "tool_use_delta", input_json: event.delta.partial_json });
      return accumulatedText;
    }

    return accumulatedText;
  }

  if (eventType === "content_block_stop" && event.index != null) {
    const blockType = blockTypes.get(event.index);
    if (blockType === "thinking") {
      onEvent({ type: "thinking_stop" });
    } else if (blockType === "tool_use") {
      onEvent({ type: "tool_use_stop" });
    }
    return accumulatedText;
  }

  return accumulatedText;
}

export async function processAgentStream(
  messages: AsyncIterable<any>,
  onEvent: (event: AgentEvent) => void
): Promise<AgentStreamResult> {
  let accumulatedText = "";
  let sessionId: string | null = null;
  let model: string | null = null;
  const blockTypes = new Map<number, string>();

  for await (const message of messages) {
    if ("session_id" in message && message.session_id) {
      sessionId = message.session_id;
      onEvent({ type: "session_id", id: message.session_id });
    }

    if (message.type === "stream_event") {
      accumulatedText = processStreamEvent(
        message.event,
        blockTypes,
        accumulatedText,
        onEvent
      );
      continue;
    }

    if (message.type === "assistant" && "message" in message) {
      if (!model && message.message.model) {
        model = message.message.model;
      }
      const content = message.message.content as Array<{
        type: string;
        text?: string;
      }>;
      const fullText = extractAssistantText(content);
      if (fullText) {
        accumulatedText = fullText;
        onEvent({ type: "assistant_message", text: fullText });
      }
      continue;
    }

    if (message.type === "user" && message.tool_use_result != null) {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result") {
            onEvent({
              type: "tool_result",
              tool_use_id: block.tool_use_id ?? "",
              content:
                typeof block.content === "string"
                  ? block.content
                  : JSON.stringify(block.content ?? ""),
            });
          }
        }
      }
      continue;
    }

    if (message.type === "tool_progress") {
      onEvent({
        type: "tool_progress",
        progress: message.tool_name ?? "",
      });
      continue;
    }

    if (message.type === "tool_use_summary") {
      onEvent({
        type: "tool_use_summary",
        summary:
          typeof message.summary === "string"
            ? message.summary
            : JSON.stringify(message.summary ?? ""),
      });
      continue;
    }

    if (message.type === "system") {
      onEvent({
        type: "system",
        message: message.message ?? "",
        subtype: message.subtype,
      });
      continue;
    }

    if (message.type === "result") {
      onEvent({
        type: "result",
        session_id: message.session_id ?? sessionId ?? undefined,
        duration_ms: message.duration_ms,
      });
      break;
    }

    // Passthrough for anything we don't recognize
    if (message.type && !["stream_event", "assistant"].includes(message.type)) {
      onEvent({ type: "unknown", raw: message });
    }
  }

  return { text: accumulatedText, sessionId, model };
}

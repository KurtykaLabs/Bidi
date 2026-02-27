export interface AgentCallbacks {
  onToken: (token: string) => void;
  onSessionId: (sessionId: string) => void;
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

export async function processAgentStream(
  messages: AsyncIterable<any>,
  callbacks: AgentCallbacks
): Promise<string> {
  let accumulatedText = "";

  for await (const message of messages) {
    if ("session_id" in message && message.session_id) {
      callbacks.onSessionId(message.session_id);
    }

    if (message.type === "stream_event") {
      const event = message.event as {
        type?: string;
        delta?: { type?: string; text?: string };
      } | undefined;
      if (
        event?.type === "content_block_delta" &&
        event.delta?.type === "text_delta" &&
        event.delta.text
      ) {
        const result = processStreamDelta(accumulatedText, event.delta.text);
        if (result) {
          accumulatedText = result.accumulated;
          callbacks.onToken(result.text);
        }
      }
      continue;
    }

    if (message.type === "assistant" && "message" in message) {
      const content = message.message.content as Array<{
        type: string;
        text?: string;
      }>;
      const fullText = extractAssistantText(content);
      if (fullText) {
        accumulatedText = fullText;
      }
      continue;
    }

    if (message.type === "result") {
      break;
    }
  }

  return accumulatedText;
}

import { describe, it, expect, vi } from "vitest";
import {
  processStreamDelta,
  extractAssistantText,
  processAgentStream,
} from "./agent.js";

describe("processStreamDelta", () => {
  it("trims leading newlines when accumulated is empty", () => {
    const result = processStreamDelta("", "\n\nHello");
    expect(result).toEqual({ text: "Hello", accumulated: "Hello" });
  });

  it("passes through text when accumulated is non-empty", () => {
    const result = processStreamDelta("Hello", "\n\nworld");
    expect(result).toEqual({
      text: "\n\nworld",
      accumulated: "Hello\n\nworld",
    });
  });

  it("returns null when delta is only newlines and accumulated is empty", () => {
    const result = processStreamDelta("", "\n\n");
    expect(result).toBeNull();
  });

  it("handles plain text with empty accumulated", () => {
    const result = processStreamDelta("", "Hello");
    expect(result).toEqual({ text: "Hello", accumulated: "Hello" });
  });
});

describe("extractAssistantText", () => {
  it("joins multiple text blocks", () => {
    const result = extractAssistantText([
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ]);
    expect(result).toBe("Hello world");
  });

  it("skips non-text blocks", () => {
    const result = extractAssistantText([
      { type: "text", text: "Hello" },
      { type: "tool_use" },
      { type: "text", text: " world" },
    ]);
    expect(result).toBe("Hello world");
  });

  it("returns empty string for empty content", () => {
    expect(extractAssistantText([])).toBe("");
  });

  it("returns empty string when no text blocks exist", () => {
    const result = extractAssistantText([
      { type: "tool_use" },
      { type: "tool_result" },
    ]);
    expect(result).toBe("");
  });
});

describe("processAgentStream", () => {
  async function* makeStream(messages: any[]): AsyncIterable<any> {
    for (const msg of messages) {
      yield msg;
    }
  }

  it("accumulates text from stream_event deltas and calls onToken", async () => {
    const onToken = vi.fn();
    const onSessionId = vi.fn();

    const messages = [
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "\n\nHello" },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: " world" },
        },
      },
      { type: "result" },
    ];

    const result = await processAgentStream(makeStream(messages), {
      onToken,
      onSessionId,
    });

    expect(result).toBe("Hello world");
    expect(onToken).toHaveBeenCalledTimes(2);
    expect(onToken).toHaveBeenNthCalledWith(1, "Hello");
    expect(onToken).toHaveBeenNthCalledWith(2, " world");
  });

  it("captures session_id and calls onSessionId", async () => {
    const onToken = vi.fn();
    const onSessionId = vi.fn();

    const messages = [
      { type: "stream_event", session_id: "sess-123", event: {} },
      { type: "result" },
    ];

    await processAgentStream(makeStream(messages), { onToken, onSessionId });

    expect(onSessionId).toHaveBeenCalledWith("sess-123");
  });

  it("returns final text from assistant message", async () => {
    const onToken = vi.fn();
    const onSessionId = vi.fn();

    const messages = [
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "partial" },
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Final complete response" }],
        },
      },
      { type: "result" },
    ];

    const result = await processAgentStream(makeStream(messages), {
      onToken,
      onSessionId,
    });

    expect(result).toBe("Final complete response");
  });

  it("stops processing on result message", async () => {
    const onToken = vi.fn();
    const onSessionId = vi.fn();

    const messages = [
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello" },
        },
      },
      { type: "result" },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: " should not appear" },
        },
      },
    ];

    const result = await processAgentStream(makeStream(messages), {
      onToken,
      onSessionId,
    });

    expect(result).toBe("Hello");
    expect(onToken).toHaveBeenCalledTimes(1);
  });

  it("returns empty string when stream has no content", async () => {
    const onToken = vi.fn();
    const onSessionId = vi.fn();

    const result = await processAgentStream(makeStream([{ type: "result" }]), {
      onToken,
      onSessionId,
    });

    expect(result).toBe("");
    expect(onToken).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  processStreamDelta,
  extractAssistantText,
  processAgentStream,
  type AgentEvent,
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

  function collectEvents(messages: any[]): Promise<{ result: any; events: AgentEvent[] }> {
    const events: AgentEvent[] = [];
    const onEvent = (event: AgentEvent) => events.push(event);
    return processAgentStream(makeStream(messages), onEvent).then((result) => ({
      result,
      events,
    }));
  }

  it("accumulates text from stream_event deltas and emits text_delta events", async () => {
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

    const { result, events } = await collectEvents(messages);

    expect(result.text).toBe("Hello world");
    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0]).toEqual({ type: "text_delta", text: "Hello" });
    expect(textDeltas[1]).toEqual({ type: "text_delta", text: " world" });
  });

  it("captures session_id and emits session_id event", async () => {
    const messages = [
      { type: "stream_event", session_id: "sess-123", event: {} },
      { type: "result" },
    ];

    const { result, events } = await collectEvents(messages);

    expect(result.sessionId).toBe("sess-123");
    expect(events).toContainEqual({ type: "session_id", id: "sess-123" });
  });

  it("returns final text from assistant message and emits assistant_message", async () => {
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

    const { result, events } = await collectEvents(messages);

    expect(result.text).toBe("Final complete response");
    expect(events).toContainEqual({
      type: "assistant_message",
      text: "Final complete response",
    });
  });

  it("stops processing on result message", async () => {
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

    const { result, events } = await collectEvents(messages);

    expect(result.text).toBe("Hello");
    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas).toHaveLength(1);
  });

  it("returns empty string when stream has no content", async () => {
    const { result, events } = await collectEvents([{ type: "result" }]);

    expect(result.text).toBe("");
    expect(events.filter((e) => e.type === "text_delta")).toHaveLength(0);
  });

  it("emits thinking events", async () => {
    const messages = [
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking" },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Let me think..." },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_stop",
          index: 0,
        },
      },
      { type: "result" },
    ];

    const { events } = await collectEvents(messages);

    expect(events).toContainEqual({ type: "thinking_start" });
    expect(events).toContainEqual({ type: "thinking_delta", text: "Let me think..." });
    expect(events).toContainEqual({ type: "thinking_stop" });
  });

  it("emits tool_use events", async () => {
    const messages = [
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", name: "read_file", id: "tool-1" },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"path":' },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_stop",
          index: 0,
        },
      },
      { type: "result" },
    ];

    const { events } = await collectEvents(messages);

    expect(events).toContainEqual({
      type: "tool_use_start",
      name: "read_file",
      id: "tool-1",
    });
    expect(events).toContainEqual({
      type: "tool_use_delta",
      input_json: '{"path":',
    });
    expect(events).toContainEqual({ type: "tool_use_stop" });
  });

  it("emits tool_progress events", async () => {
    const messages = [
      { type: "tool_progress", content: "Running..." },
      { type: "result" },
    ];

    const { events } = await collectEvents(messages);

    expect(events).toContainEqual({ type: "tool_progress", progress: "Running..." });
  });

  it("emits tool_result events", async () => {
    const messages = [
      { type: "tool_result", tool_use_id: "tool-1", content: "file contents" },
      { type: "result" },
    ];

    const { events } = await collectEvents(messages);

    expect(events).toContainEqual({
      type: "tool_result",
      tool_use_id: "tool-1",
      content: "file contents",
    });
  });

  it("emits tool_use_summary events", async () => {
    const messages = [
      { type: "tool_use_summary", summary: "Read the file" },
      { type: "result" },
    ];

    const { events } = await collectEvents(messages);

    expect(events).toContainEqual({
      type: "tool_use_summary",
      summary: "Read the file",
    });
  });

  it("emits result event with metadata", async () => {
    const messages = [
      { type: "result", session_id: "sess-1", duration_ms: 1234 },
    ];

    const { events } = await collectEvents(messages);

    expect(events).toContainEqual({
      type: "result",
      session_id: "sess-1",
      duration_ms: 1234,
    });
  });

  it("emits system events", async () => {
    const messages = [
      { type: "system", message: "Rate limited", subtype: "warning" },
      { type: "result" },
    ];

    const { events } = await collectEvents(messages);

    expect(events).toContainEqual({
      type: "system",
      message: "Rate limited",
      subtype: "warning",
    });
  });

  it("passes through unknown message types", async () => {
    const messages = [
      { type: "something_new", data: "test" },
      { type: "result" },
    ];

    const { events } = await collectEvents(messages);

    expect(events).toContainEqual({
      type: "unknown",
      raw: { type: "something_new", data: "test" },
    });
  });
});

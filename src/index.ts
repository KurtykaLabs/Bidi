import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { RealtimeListener, type MessageRow } from "./realtime.js";
import {
  createMessage,
  persistEvent,
  getMessageText,
  getThreadSessionId,
  getChannelSummary,
  updateMessageSessionId,
  updateThreadActivity,
  type HumanMessage,
} from "./db.js";
import { processAgentStream, type AgentEvent } from "./agent.js";

const MILESTONE_TYPES = new Set([
  "assistant_message",
  "tool_use_start",
  "tool_result",
  "tool_use_summary",
  "result",
]);

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey, {
  realtime: {
    heartbeatIntervalMs: 5_000,
    heartbeatCallback: (status: string) => {
      if (status === "disconnected") {
        console.warn("[realtime] heartbeat disconnected, reconnecting...");
        supabase.realtime.connect();
      } else if (status !== "ok") {
        console.warn(`[realtime] heartbeat ${status}`);
      }
    },
  },
});
const listener = new RealtimeListener(supabase);

const responding = new Set<string>();

async function getAgentResponse(msg: HumanMessage) {
  const key = msg.threadId ?? msg.id;
  if (responding.has(key)) return;
  responding.add(key);

  console.log(`[agent] thinking (channel: ${msg.channelId})...`);

  try {
    let sessionId: string | null = null;
    if (msg.threadId) {
      sessionId = await getThreadSessionId(supabase, msg.threadId);
    }

    const agentMessageId = await createMessage(
      supabase,
      msg.channelId,
      "agent",
      msg.threadId
    );

    let prompt = msg.text;
    if (msg.threadId && !sessionId) {
      const summary = await getChannelSummary(supabase, msg.channelId);
      if (summary) {
        prompt = `[Channel context]\n${summary}\n\n[Thread message]\n${msg.text}`;
      }
    }

    const queryInstance = query({
      prompt,
      options: {
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        ...(sessionId && { resume: sessionId }),
      },
    });

    const onEvent = (event: AgentEvent) => {
      listener.broadcastAgentEvent(msg.channelId, event, agentMessageId);

      if (MILESTONE_TYPES.has(event.type)) {
        const { type, ...payload } = event;
        persistEvent(supabase, agentMessageId, type, payload).catch((err) => {
          console.error(`[error] Persist: ${err.message}`);
        });
      }

      if (event.type === "text_delta") {
        process.stdout.write(event.text);
      }
    };

    const result = await processAgentStream(queryInstance, onEvent);

    if (result.sessionId) {
      await updateMessageSessionId(supabase, agentMessageId, result.sessionId);
    }
    if (msg.threadId) {
      await updateThreadActivity(supabase, msg.threadId);
    }
    if (result.text) {
      process.stdout.write("\n");
    }
  } catch (err: any) {
    console.error(`[error] Agent: ${err.message}`);
  } finally {
    responding.delete(key);
  }
}

listener.subscribe(async (row: MessageRow) => {
  let text: string | null = null;
  for (let i = 0; i < 3; i++) {
    text = await getMessageText(supabase, row.id);
    if (text?.trim()) break;
    await new Promise((r) => setTimeout(r, 200 * (i + 1)));
  }
  if (!text?.trim()) return;

  const msg: HumanMessage = {
    id: row.id,
    text,
    channelId: row.channel_id,
    threadId: row.thread_id,
  };

  console.log(`[user] (channel: ${msg.channelId}) ${msg.text}`);
  getAgentResponse(msg);
});

console.log("\nConnected (Agent mode). Listening for messages...\n");

process.on("SIGINT", () => {
  console.log("\nBye!");
  listener.unsubscribe();
  process.exit();
});

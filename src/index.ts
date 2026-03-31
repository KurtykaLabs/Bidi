import "dotenv/config";
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { RealtimeListener, type MessageRow } from "./realtime.js";
import {
  createMessage,
  persistEvent,
  getMessageText,
  getChannelSessionId,
  getChannelSummary,
  updateChannelName,
  updateChannelSessionId,
  updateAgentHeartbeat,
  updateAgentModel,
  type HumanMessage,
} from "./db.js";
import { processAgentStream, type AgentEvent } from "./agent.js";
import {
  createAuthenticatedClient,
  authenticate,
  ensureProfile,
  ensureAgentAndSpace,
} from "./auth.js";

const MILESTONE_TYPES = new Set([
  "assistant_message",
  "tool_use_start",
  "tool_result",
  "tool_use_summary",
  "result",
]);

const supabase = createAuthenticatedClient();
let agentId: string;
let listener: RealtimeListener;

const responding = new Set<string>();

async function generateChannelName(messageText: string): Promise<string> {
  const nameQuery = query({
    prompt: `Generate a brief channel name (2-5 words) that captures the topic of this message. Use lowercase with underscores, no spaces. Example: "project_setup_help". Reply with only the name, nothing else.\n\nMessage: ${messageText}`,
    options: {
      model: "haiku",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  });

  const result = await processAgentStream(nameQuery, () => {});
  const name = result.text.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  if (!name || name.length > 50) throw new Error("Generated name invalid");
  return name;
}

async function getAgentResponse(msg: HumanMessage) {
  const key = msg.parentMessageId ?? msg.id;
  if (responding.has(key)) return;
  responding.add(key);

  console.log(`[agent] thinking (channel: ${msg.channelId})...`);

  try {
    const sessionId = await getChannelSessionId(supabase, msg.channelId);

    if (!sessionId) {
      generateChannelName(msg.text)
        .then(async (name) => {
          const updated = await updateChannelName(supabase, msg.channelId, name);
          if (updated) {
            listener.broadcastChannelEvent(msg.channelId, "channel_renamed", { name });
          }
        })
        .catch((err) => console.error(`[error] Channel name: ${err.message}`));
    }

    const agentMessageId = await createMessage(
      supabase,
      msg.channelId,
      "agent",
      msg.id,
      { agentId }
    );

    listener.broadcastAgentEvent(msg.channelId, { type: "ack" }, agentMessageId);

    let prompt = msg.text;
    if (msg.parentMessageId && !sessionId) {
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
      const eventId = MILESTONE_TYPES.has(event.type) ? randomUUID() : undefined;
      listener.broadcastAgentEvent(msg.channelId, event, agentMessageId, eventId);

      if (eventId) {
        const { type, ...payload } = event;
        persistEvent(supabase, eventId, agentMessageId, type, payload).catch((err) => {
          console.error(`[error] Persist: ${err.message}`);
        });
      }

      if (event.type === "text_delta") {
        process.stdout.write(event.text);
      }
    };

    const result = await processAgentStream(queryInstance, onEvent);

    if (result.model) {
      updateAgentModel(supabase, agentId, result.model).catch(() => {});
    }
    if (result.sessionId) {
      await updateChannelSessionId(supabase, msg.channelId, result.sessionId);
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

async function main() {
  const userId = await authenticate(supabase);
  const profile = await ensureProfile(supabase);
  const { agent, space } = await ensureAgentAndSpace(supabase, profile);
  agentId = agent.id;

  // Heartbeat: update agent health every 30s
  await updateAgentHeartbeat(supabase, agentId);
  const heartbeat = setInterval(() => updateAgentHeartbeat(supabase, agentId), 30_000);

  listener = new RealtimeListener(supabase);

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
      parentMessageId: row.parent_message_id,
    };

    console.log(`[user] (channel: ${msg.channelId}) ${msg.text}`);
    getAgentResponse(msg);
  });

  console.log(`\nAgent "${agent.name}" online in "${space.name}". Listening for messages...\n`);

  process.on("SIGINT", () => {
    console.log("\nBye!");
    clearInterval(heartbeat);
    listener.unsubscribe();
    process.exit();
  });
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
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
  fetchProfileKeys,
  type HumanMessage,
} from "./db.js";
import { processAgentStream, type AgentEvent } from "./agent.js";
import {
  createAuthenticatedClient,
  authenticate,
  ensureProfile,
  findExistingAgent,
  promptAgentName,
  createAgent,
  findSpaceForAgent,
  type Agent,
  type Space,
} from "./auth.js";
import { Keyring, type AcquireBootDeps } from "./keyring.js";
import { decryptString, encryptString, type Keypair, wipe } from "./crypto.js";
import { promptExistingPassphrase, promptVisible } from "./passphrase.js";
import {
  initAnalytics,
  setDistinctId,
  trackEvent,
  captureError,
  shutdownAnalytics,
} from "./analytics.js";

const MILESTONE_TYPES = new Set([
  "assistant_message",
  "tool_use_start",
  "tool_result",
  "tool_use_summary",
  "result",
]);

// Sandbox directory for Claude Agent SDK — empty per-agent cwd so any tool call
// that slips through has no pre-existing files to read.
const SANDBOX_DIR = join(tmpdir(), "bidi-sandbox", randomUUID());
mkdirSync(SANDBOX_DIR, { recursive: true });

function cleanupSandbox(): void {
  try {
    rmSync(SANDBOX_DIR, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// Tools blocked to prevent prompt-injected exfiltration of ~/.bidi/space_key.json.
// Claude Agent SDK options (verified in sdk.d.ts:585,605,787).
const DISALLOWED_TOOLS = [
  "Read",
  "Bash",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "NotebookEdit",
  "BashOutput",
  "KillShell",
];

const supabase = createAuthenticatedClient();
let agentId: string;
let keyring: Keyring;
let listener: RealtimeListener;

const bootDeps: AcquireBootDeps = {
  promptPassphrase: () => promptExistingPassphrase(),
  askRetryOrRecover: async (remaining) => {
    const choice = (
      await promptVisible(
        `\n[r] recover with code, [enter] try again (${remaining} attempt${remaining === 1 ? "" : "s"} left): `,
      )
    ).trim().toLowerCase();
    return choice === "r" ? "recover" : "retry";
  },
  onWrongPassphrase: (err) => console.error(`\nUnable to unlock: ${err.message}`),
  onWrongRecoveryCode: (err, remaining) =>
    console.error(`\nRecovery failed: ${err.message}${remaining > 0 ? ` (${remaining} attempt${remaining === 1 ? "" : "s"} left)` : ""}`),
};

const responding = new Set<string>();

async function fetchSpace(supabase: ReturnType<typeof createAuthenticatedClient>, spaceId: string): Promise<Space> {
  const { data, error } = await supabase.from("spaces").select("id, agent_id").eq("id", spaceId).single();
  if (error) throw new Error(`Failed to fetch space ${spaceId}: ${error.message}`);
  return data;
}

async function generateChannelName(messageText: string): Promise<string> {
  const nameQuery = query({
    prompt: `Generate a brief channel name (2-5 words) that captures the topic of this message. Use lowercase with underscores, no spaces. Example: "project_setup_help". Reply with only the name, nothing else.\n\nMessage: ${messageText}`,
    options: {
      model: "haiku",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      disallowedTools: DISALLOWED_TOOLS,
      cwd: SANDBOX_DIR,
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
    trackEvent("agent_response_started", {
      channelId: msg.channelId,
      hasSession: !!sessionId,
      hasParentMessage: !!msg.parentMessageId,
    });

    if (!sessionId) {
      generateChannelName(msg.text)
        .then(async (name) => {
          const encName = await encryptString(keyring.getSpaceKey(), name);
          const updated = await updateChannelName(supabase, msg.channelId, encName);
          if (updated) {
            trackEvent("channel_named", { channelId: msg.channelId });
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
      const summary = await getChannelSummary(supabase, msg.channelId, keyring);
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
        disallowedTools: DISALLOWED_TOOLS,
        cwd: SANDBOX_DIR,
        ...(sessionId && { resume: sessionId }),
      },
    });

    const onEvent = (event: AgentEvent) => {
      const eventId = MILESTONE_TYPES.has(event.type) ? randomUUID() : undefined;
      listener.broadcastAgentEvent(msg.channelId, event, agentMessageId, eventId);

      if (eventId) {
        const { type, ...payload } = event;
        persistEvent(supabase, eventId, agentMessageId, type, payload, keyring).catch((err) => {
          console.error(`[error] Persist: ${err.message}`);
        });
      }

      if (event.type === "tool_use_start" && "name" in event) {
        trackEvent("tool_used", { channelId: msg.channelId, toolName: event.name });
      }
      if (event.type === "text_delta") {
        process.stdout.write(event.text);
      }
    };

    const result = await processAgentStream(queryInstance, onEvent);
    trackEvent("agent_response_completed", {
      channelId: msg.channelId,
      model: result.model,
      responseLength: result.text.length,
    });

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
    captureError(err, { channelId: msg.channelId });
    console.error(`[error] Agent: ${err.message}`);
  } finally {
    responding.delete(key);
  }
}

async function main() {
  initAnalytics();
  const userId = await authenticate(supabase);
  setDistinctId(userId);
  const profile = await ensureProfile(supabase);

  keyring = new Keyring();
  let profileKeys = await fetchProfileKeys(supabase, profile.id);

  // Phase 1: profile keypair. If this is a brand-new user, bootstrap returns
  // the keypair we just generated so phase 3 doesn't have to re-prompt the
  // passphrase. Otherwise the keypair is derived lazily below only when needed.
  let bootstrapKeypair: Keypair | null = null;
  if (!profileKeys.passphrase_blob) {
    bootstrapKeypair = await keyring.bootstrapProfileKeys(supabase, profile);
    profileKeys = await fetchProfileKeys(supabase, profile.id);
  }

  let space: Space;
  let agent: Agent;
  try {
    // Phase 2: locate the agent. If a row already exists, take it as-is — its
    // name is already encrypted (or will pass through decryptString as legacy
    // plaintext). If not, defer creation until phase 3 has a space key so the
    // first INSERT carries the ciphertext, leaving no plaintext window in WAL
    // or audit logs.
    const existingAgent = await findExistingAgent(supabase, profile);

    if (existingAgent) {
      agent = existingAgent;
      agentId = agent.id;

      const existingSpace = await findSpaceForAgent(supabase, agent);
      if (!existingSpace) {
        // Legacy: agent predates spaces. Mint a space + key for them now.
        const keypair = bootstrapKeypair ?? (await keyring.deriveKeypair(supabase, profile, profileKeys));
        try {
          const { spaceId } = await keyring.bootstrapSpaceAndKey(supabase, agent, keypair);
          space = await fetchSpace(supabase, spaceId);
          trackEvent("space_created");
        } finally {
          if (keypair !== bootstrapKeypair) wipe(keypair.secretKey);
        }
      } else {
        await keyring.acquireAtBoot(supabase, profile, existingSpace, profileKeys, bootDeps);
        space = existingSpace;
      }
    } else {
      // Phase 2/3 fused: prompt name, generate space key in memory, encrypt
      // name, insert agent (already encrypted), then commit the space with the
      // same key. The agent row never exists with a plaintext name.
      const plaintextName = await promptAgentName();
      const keypair = bootstrapKeypair ?? (await keyring.deriveKeypair(supabase, profile, profileKeys));
      try {
        const spaceKey = await keyring.generateSpaceKey();
        let committed = false;
        try {
          const encName = await encryptString(spaceKey, plaintextName);
          agent = await createAgent(supabase, profile, encName);
          agentId = agent.id;

          const { spaceId } = await keyring.commitSpace(supabase, agent, keypair, spaceKey);
          committed = true;
          space = await fetchSpace(supabase, spaceId);
          trackEvent("space_created");
        } finally {
          if (!committed) wipe(spaceKey);
        }
      } finally {
        if (keypair !== bootstrapKeypair) wipe(keypair.secretKey);
      }
    }
  } finally {
    if (bootstrapKeypair) wipe(bootstrapKeypair.secretKey);
  }

  setDistinctId(agentId);
  trackEvent("agent_started", { agentId: agent.id });

  const displayName = await decryptString(keyring.getSpaceKey(), agent.name);

  await updateAgentHeartbeat(supabase, agentId);
  const heartbeat = setInterval(() => updateAgentHeartbeat(supabase, agentId), 30_000);

  listener = new RealtimeListener(supabase, keyring);

  listener.subscribe(async (row: MessageRow) => {
    let text: string | null = null;
    for (let i = 0; i < 3; i++) {
      text = await getMessageText(supabase, row.id, keyring);
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

  console.log(`\nAgent "${displayName}" online. Listening for messages...`);
  console.log(`Type /help for commands.\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input.startsWith("/")) return;

    const [cmd, ...args] = input.slice(1).split(/\s+/);
    try {
      switch (cmd) {
        case "rename": {
          const newName = args.join(" ");
          if (!newName) {
            console.log("Usage: /rename <name>");
            break;
          }
          const encName = await encryptString(keyring.getSpaceKey(), newName);
          const { error } = await supabase.rpc("update_agent", {
            p_agent_id: agentId,
            p_name: encName,
          });
          if (error) {
            captureError(new Error(error.message), { cmd: "rename" });
            console.error(`Failed to rename: ${error.message}`);
          } else {
            trackEvent("command_rename", { agentId });
            console.log(`Agent renamed.`);
          }
          break;
        }
        case "logout": {
          trackEvent("command_logout");
          console.log("Logging out...");
          keyring.clear();
          const { error } = await supabase.auth.signOut({ scope: "local" });
          if (error) {
            captureError(new Error(error.message), { cmd: "logout" });
            console.error(`Failed to log out: ${error.message}`);
            break;
          }
          trackEvent("agent_shutdown", { reason: "logout" });
          clearInterval(heartbeat);
          listener.unsubscribe();
          await shutdownAnalytics();
          cleanupSandbox();
          rl.close();
          process.exit(0);
          break;
        }
        case "recover": {
          try {
            await keyring.recover(supabase, profile, space);
            console.log("Passphrase reset. You may now use the new passphrase.");
          } catch (err: any) {
            captureError(err, { cmd: "recover" });
            console.error(`Recovery failed: ${err.message}`);
          }
          break;
        }
        case "help":
          trackEvent("command_help");
          console.log("Commands:");
          console.log("  /rename <name>  — Rename your agent");
          console.log("  /recover        — Reset passphrase using recovery code");
          console.log("  /logout         — Sign out and exit");
          console.log("  /help           — Show this message");
          break;
        default:
          trackEvent("command_unknown", { cmd });
          console.log(`Unknown command: /${cmd}. Type /help for commands.`);
      }
    } catch (err: any) {
      captureError(err, { cmd });
      console.error(`Command failed: ${err.message}`);
    }
  });

  async function shutdown() {
    console.log("\nBye!");
    trackEvent("agent_shutdown", { reason: "SIGINT" });
    clearInterval(heartbeat);
    listener.unsubscribe();
    await shutdownAnalytics();
    cleanupSandbox();
    rl.close();
    process.exit();
  }

  process.on("SIGINT", () => {
    void shutdown().catch((err: any) => {
      console.error(`Shutdown failed: ${err.message}`);
      process.exit(1);
    });
  });
}

process.on("uncaughtException", async (err) => {
  captureError(err, { fatal: true });
  await shutdownAnalytics();
  cleanupSandbox();
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  captureError(reason, { fatal: true });
  await shutdownAnalytics();
  cleanupSandbox();
  process.exit(1);
});

main().catch(async (err) => {
  captureError(err, { fatal: true });
  console.error(`\nFatal: ${err.message}`);
  await shutdownAnalytics();
  cleanupSandbox();
  process.exit(1);
});

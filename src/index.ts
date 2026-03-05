import "dotenv/config";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Chat } from "./chat.js";
import { processAgentStream, type AgentEvent } from "./agent.js";

const chat = new Chat(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

let currentSessionId: string | null = null;
let isAgentResponding = false;

async function getAgentResponse(userText: string) {
  isAgentResponding = true;
  console.log("[agent] thinking...");

  try {
    const queryInstance = query({
      prompt: userText,
      options: {
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        ...(currentSessionId && { resume: currentSessionId }),
      },
    });

    const onEvent = (event: AgentEvent) => {
      chat.broadcastAgentEvent(event, "agent");
      chat.persistAgentEvent(event).catch((err) => {
        console.error(`[error] Persist: ${err.message}`);
      });

      if (event.type === "session_id") {
        currentSessionId = event.id;
      }
      if (event.type === "text_delta") {
        process.stdout.write(event.text);
      }
    };

    const result = await processAgentStream(queryInstance, onEvent);

    if (result.sessionId) {
      currentSessionId = result.sessionId;
    }
    if (result.text) {
      process.stdout.write("\n");
    }
  } catch (err: any) {
    console.error(`[error] Agent: ${err.message}`);
  } finally {
    isAgentResponding = false;
  }
}

chat.subscribe((text) => {
  console.log(`[user] ${text}`);
  if (!isAgentResponding) {
    getAgentResponse(text);
  }
});

console.log("Connected (Agent mode). Listening for messages...\n");
process.on("SIGINT", () => {
  console.log("\nBye!");
  chat.unsubscribe();
  process.exit();
});

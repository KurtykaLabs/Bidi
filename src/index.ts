import "dotenv/config";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Chat } from "./chat.js";
import { processAgentStream } from "./agent.js";

const cliMode = process.argv.includes("--cli");

const chat = new Chat(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

let currentLine = "";
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

    let accumulatedText = "";
    const fullText = await processAgentStream(queryInstance, {
      onToken: (token) => {
        accumulatedText += token;
        process.stdout.write(token);
        chat.broadcastTyping(accumulatedText, "agent");
      },
      onSessionId: (id) => {
        currentSessionId = id;
      },
    });

    if (fullText) {
      process.stdout.write("\n");
      await chat.sendMessage(fullText, "agent");
    }
  } catch (err: any) {
    console.error(`[error] Agent: ${err.message}`);
  } finally {
    isAgentResponding = false;
  }
}

chat.subscribe((text, sender) => {
  if (cliMode) {
    process.stdout.write(`\r\x1b[K[${sender}] ${text}\n> ${currentLine}`);
  } else {
    console.log(`[${sender}] ${text}`);
    if (sender === "user" && !isAgentResponding) {
      getAgentResponse(text);
    }
  }
});

if (cliMode) {
  console.log("Connected (CLI mode). Start typing...\n");
  process.stdout.write("> ");

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", async (key: string) => {
    if (key === "\u0003") {
      console.log("\nBye!");
      chat.unsubscribe();
      process.exit();
    }

    if (key === "\r" || key === "\n") {
      if (currentLine.length > 0) {
        const text = currentLine;
        currentLine = "";
        process.stdout.write("\n");
        try {
          await chat.sendMessage(text, "user");
          console.log(`[sent] ${text}`);
        } catch (error: any) {
          process.stdout.write(`[error] ${error.message}\n`);
        }
        process.stdout.write("> ");
      }
      return;
    }

    if (key === "\u007f" || key === "\b") {
      if (currentLine.length > 0) {
        currentLine = currentLine.slice(0, -1);
        process.stdout.write("\b \b");
        chat.broadcastTyping(currentLine, "user");
      }
      return;
    }

    currentLine += key;
    process.stdout.write(key);
    chat.broadcastTyping(currentLine, "user");
  });
} else {
  console.log("Connected (Agent mode). Listening for messages...\n");
  process.on("SIGINT", () => {
    console.log("\nBye!");
    chat.unsubscribe();
    process.exit();
  });
}

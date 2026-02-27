import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { query } from "@anthropic-ai/claude-agent-sdk";

const cliMode = process.argv.includes("--cli");

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

const sentMessages = new Set<string>();
let currentLine = "";
let currentSessionId: string | null = null;
let isAgentResponding = false;

function broadcastTyping(text: string, sender: string = "user") {
  channel.send({
    type: "broadcast",
    event: "typing",
    payload: { currentLine: text, sender },
  });
}

async function getAgentResponse(userText: string) {
  let accumulatedText = "";
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

    for await (const message of queryInstance) {
      if ("session_id" in message && message.session_id) {
        currentSessionId = message.session_id;
      }

      if (message.type === "stream_event") {
        const event = (
          message as {
            event?: {
              type?: string;
              delta?: { type?: string; text?: string };
            };
          }
        ).event;
        if (
          event?.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          event.delta.text
        ) {
          let text = event.delta.text;
          // Trim leading whitespace before any real content
          if (!accumulatedText) {
            text = text.replace(/^[\n\r]+/, "");
            if (!text) continue;
          }
          accumulatedText += text;
          process.stdout.write(text);
          broadcastTyping(accumulatedText, "agent");
        }
        continue;
      }

      if (message.type === "assistant" && "message" in message) {
        const content = (message.message as { content: unknown[] })
          .content as Array<{ type: string; text?: string }>;
        const fullText = content
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text)
          .join("");
        if (fullText) {
          accumulatedText = fullText;
        }
        continue;
      }

      if (message.type === "result") {
        break;
      }
    }

    if (accumulatedText) {
      process.stdout.write("\n");
      sentMessages.add(accumulatedText);
      await supabase
        .from("messages")
        .insert({ text: accumulatedText, sender: "agent" });
      channel.send({
        type: "broadcast",
        event: "message",
        payload: { text: accumulatedText, sender: "agent" },
      });
    }
  } catch (err: any) {
    console.error(`[error] Agent: ${err.message}`);
  } finally {
    isAgentResponding = false;
  }
}

const channel = supabase
  .channel("chat")
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "messages" },
    (payload) => {
      const text = payload.new.text as string;
      const sender = payload.new.sender as string;

      // Skip messages we sent ourselves
      if (sentMessages.delete(text)) return;

      if (cliMode) {
        // CLI mode: just display received messages
        process.stdout.write(`\r\x1b[K[${sender}] ${text}\n> ${currentLine}`);
      } else {
        // Agent mode: display and respond to user messages
        console.log(`[${sender}] ${text}`);
        if (sender === "user" && !isAgentResponding) {
          getAgentResponse(text);
        }
      }
    }
  );

channel.subscribe((status) => {
  if (status === "SUBSCRIBED") {
    if (cliMode) {
      console.log("Connected (CLI mode). Start typing...\n");
      process.stdout.write("> ");
    } else {
      console.log("Connected (Agent mode). Listening for messages...\n");
    }
  }
});

if (cliMode) {
  // CLI mode: raw stdin for character-by-character typing + broadcast
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", async (key: string) => {
    if (key === "\u0003") {
      console.log("\nBye!");
      channel.unsubscribe();
      process.exit();
    }

    if (key === "\r" || key === "\n") {
      if (currentLine.length > 0) {
        const text = currentLine;
        currentLine = "";
        process.stdout.write("\n");
        sentMessages.add(text);
        const { error } = await supabase
          .from("messages")
          .insert({ text, sender: "user" });
        if (error) {
          sentMessages.delete(text);
          process.stdout.write(`[error] ${error.message}\n> `);
          return;
        }
        channel.send({
          type: "broadcast",
          event: "message",
          payload: { text, sender: "user" },
        });
        console.log(`[sent] ${text}`);
        process.stdout.write("> ");
      }
      return;
    }

    if (key === "\u007f" || key === "\b") {
      if (currentLine.length > 0) {
        currentLine = currentLine.slice(0, -1);
        process.stdout.write("\b \b");
        broadcastTyping(currentLine);
      }
      return;
    }

    currentLine += key;
    process.stdout.write(key);
    broadcastTyping(currentLine);
  });
} else {
  // Agent mode: just keep the process alive, Ctrl+C to exit
  process.on("SIGINT", () => {
    console.log("\nBye!");
    channel.unsubscribe();
    process.exit();
  });
}

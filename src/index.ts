import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

const sentMessages = new Set<string>();
let currentLine = "";

const channel = supabase
  .channel("chat")
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "messages" },
    (payload) => {
      const text = payload.new.text as string;
      if (sentMessages.delete(text)) return;
      process.stdout.write(`\r\x1b[K[received] ${text}\n> ${currentLine}`);
    }
  );

async function sendMessage(text: string) {
  sentMessages.add(text);
  const { error } = await supabase.from("messages").insert({ text });
  if (error) {
    sentMessages.delete(text);
    process.stdout.write(`\n[error] ${error.message}\n> `);
    return;
  }
  channel.send({
    type: "broadcast",
    event: "message",
    payload: { text },
  });
}

function broadcastTyping() {
  channel.send({
    type: "broadcast",
    event: "typing",
    payload: { currentLine },
  });
}

channel.subscribe((status) => {
  if (status === "SUBSCRIBED") {
    console.log("Connected to Supabase Realtime. Start typing...\n");
    process.stdout.write("> ");
  }
});

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

process.stdin.on("data", async (key: string) => {
  // Ctrl+C
  if (key === "\u0003") {
    console.log("\nBye!");
    channel.unsubscribe();
    process.exit();
  }

  // Enter
  if (key === "\r" || key === "\n") {
    if (currentLine.length > 0) {
      process.stdout.write("\n");
      await sendMessage(currentLine);
      console.log(`[sent] ${currentLine}`);
      currentLine = "";
      process.stdout.write("> ");
    }
    return;
  }

  // Backspace
  if (key === "\u007f" || key === "\b") {
    if (currentLine.length > 0) {
      currentLine = currentLine.slice(0, -1);
      process.stdout.write("\b \b");
      broadcastTyping();
    }
    return;
  }

  // Regular character
  currentLine += key;
  process.stdout.write(key);
  broadcastTyping();
});

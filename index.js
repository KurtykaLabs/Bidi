require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const channel = supabase.channel("chat");
let currentLine = "";

async function sendMessage(text) {
  const { error } = await supabase.from("messages").insert({ text });
  if (error) {
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

process.stdin.on("data", async (key) => {
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

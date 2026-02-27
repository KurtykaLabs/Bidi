import { createClient, type SupabaseClient, type RealtimeChannel } from "@supabase/supabase-js";

export class Chat {
  private supabase: SupabaseClient;
  private channel: RealtimeChannel;
  private sentMessages = new Set<string>();

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.supabase = createClient(supabaseUrl, supabaseKey);
    this.channel = this.supabase.channel("chat");
  }

  subscribe(onMessage: (text: string, sender: string) => void): void {
    this.channel
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          const text = payload.new.text as string;
          const sender = payload.new.sender as string;

          if (this.sentMessages.delete(text)) return;

          onMessage(text, sender);
        }
      )
      .subscribe((status, err) => {
        if (status === "SUBSCRIBED") {
          console.log("Realtime channel connected");
        } else if (status === "TIMED_OUT" || status === "CHANNEL_ERROR" || status === "CLOSED") {
          console.error(`Realtime channel ${status}`, err);
          this.reconnect(onMessage);
        }
      });
  }

  private reconnect(onMessage: (text: string, sender: string) => void): void {
    setTimeout(() => {
      console.log("Attempting to reconnect...");
      this.channel.unsubscribe();
      this.channel = this.supabase.channel("chat");
      this.subscribe(onMessage);
    }, 3000);
  }

  broadcastTyping(text: string, sender: string): void {
    this.channel.send({
      type: "broadcast",
      event: "typing",
      payload: { currentLine: text, sender },
    });
  }

  async sendMessage(text: string, sender: string): Promise<void> {
    this.sentMessages.add(text);
    const { error } = await this.supabase
      .from("messages")
      .insert({ text, sender });
    if (error) {
      this.sentMessages.delete(text);
      throw error;
    }
    this.channel.send({
      type: "broadcast",
      event: "message",
      payload: { text, sender },
    });
  }

  unsubscribe(): void {
    this.channel.unsubscribe();
  }
}

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { trackEvent, captureError } from "./analytics.js";

const DEFAULT_SUPABASE_URL = "https://vikrckqkpxfltoodrpui.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZpa3Jja3FrcHhmbHRvb2RycHVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1NDU4ODcsImV4cCI6MjA4NzEyMTg4N30." +
  "ZFrrHQvknY4sxu65vh7sQ6qkXynMDYNQdZus_Jk1Cdw";

const BIDI_DIR = join(homedir(), ".bidi");
const SESSION_FILE = join(BIDI_DIR, "session.json");

export interface Profile {
  id: string;
  username: string | null;
  email: string;
}

export interface Agent {
  id: string;
  name: string;
  owner_id: string;
}

export interface Space {
  id: string;
  agent_id: string;
}

// File-based storage adapter for Supabase auth session persistence
class FileStorage {
  private ensureDir(): void {
    if (!existsSync(BIDI_DIR)) {
      mkdirSync(BIDI_DIR, { recursive: true, mode: 0o700 });
    }
  }

  getItem(key: string): string | null {
    try {
      const data = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
      return data[key] ?? null;
    } catch {
      return null;
    }
  }

  setItem(key: string, value: string): void {
    this.ensureDir();
    let data: Record<string, string> = {};
    try {
      data = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
    } catch {
      // fresh file
    }
    data[key] = value;
    writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  removeItem(key: string): void {
    try {
      const data = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
      delete data[key];
      writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch {
      // nothing to remove
    }
  }
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function createAuthenticatedClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? DEFAULT_SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY ?? DEFAULT_SUPABASE_ANON_KEY;

  return createClient(url, key, {
    auth: {
      storage: new FileStorage(),
      autoRefreshToken: true,
      persistSession: true,
    },
    realtime: {
      worker: false,
      heartbeatIntervalMs: 5_000,
      heartbeatCallback: (status: string) => {
        if (status !== "ok" && status !== "sent") {
          console.warn(`[realtime] heartbeat ${status}`);
        }
      },
    },
  });
}

export async function authenticate(supabase: SupabaseClient): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();

  if (session?.user) {
    console.log(`\nWelcome back, ${session.user.email}!`);
    trackEvent("auth_session_resumed", { userId: session.user.id });
    return session.user.id;
  }

  console.log("\nNo session found. Let's get you authenticated.\n");
  const email = await prompt("Email: ");

  const { error: otpError } = await supabase.auth.signInWithOtp({ email });
  if (otpError) {
    captureError(new Error(otpError.message), { step: "otp_send" });
    throw new Error(`Failed to send OTP: ${otpError.message}`);
  }
  trackEvent("auth_otp_requested");

  console.log(`\nCheck your email for a 6-digit code.`);
  const code = await prompt("Code: ");

  const { data, error: verifyError } = await supabase.auth.verifyOtp({
    email,
    token: code,
    type: "email",
  });
  if (verifyError) {
    captureError(new Error(verifyError.message), { step: "otp_verify" });
    throw new Error(`Verification failed: ${verifyError.message}`);
  }
  if (!data.session) throw new Error("No session returned after verification");

  trackEvent("auth_otp_verified");
  console.log(`\nAuthenticated as ${email}!`);
  return data.session.user.id;
}

export async function ensureProfile(supabase: SupabaseClient): Promise<Profile> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, username, email")
    .eq("id", user.id)
    .single();

  if (error) throw new Error(`Failed to fetch profile: ${error.message}`);

  if (!profile.username) {
    console.log("\nNo username set. Choose a username.");
    const username = await prompt("Username: ");

    const { error: updateError } = await supabase
      .from("profiles")
      .update({ username })
      .eq("id", user.id);
    if (updateError) throw new Error(`Failed to set username: ${updateError.message}`);

    profile.username = username;
    trackEvent("profile_username_set");
    console.log(`Username set to "${username}".`);
  }

  return profile;
}

export async function findExistingAgent(
  supabase: SupabaseClient,
  profile: Profile
): Promise<Agent | null> {
  const { data: agents, error } = await supabase
    .from("agents")
    .select("id, name, owner_id")
    .eq("owner_id", profile.id);
  if (error) throw new Error(`Failed to fetch agents: ${error.message}`);
  return agents && agents.length > 0 ? agents[0] : null;
}

export async function promptAgentName(): Promise<string> {
  const agentName = await prompt("Agent name: ");
  if (!agentName) throw new Error("Agent name is required");
  return agentName;
}

/**
 * Insert a new agent row with a pre-encrypted name. Encryption happens upstream
 * so the plaintext name never reaches the database — even briefly — and so
 * Postgres WAL, audit logs, and replicas only ever observe the ciphertext.
 */
export async function createAgent(
  supabase: SupabaseClient,
  profile: Profile,
  encryptedName: string,
): Promise<Agent> {
  const { data: newAgent, error } = await supabase
    .from("agents")
    .insert({ owner_id: profile.id, name: encryptedName, model: "unknown" })
    .select("id, name, owner_id")
    .single();
  if (error) throw new Error(`Failed to create agent: ${error.message}`);

  trackEvent("agent_created", { agentId: newAgent.id });
  console.log("Agent created.");
  return newAgent;
}

export async function findSpaceForAgent(
  supabase: SupabaseClient,
  agent: Agent
): Promise<Space | null> {
  const { data, error } = await supabase
    .from("spaces")
    .select("id, agent_id")
    .eq("agent_id", agent.id);
  if (error) throw new Error(`Failed to fetch spaces: ${error.message}`);
  return data && data.length > 0 ? data[0] : null;
}

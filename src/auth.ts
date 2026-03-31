import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

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
  name: string;
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
    return session.user.id;
  }

  console.log("\nNo session found. Let's get you authenticated.\n");
  const email = await prompt("Email: ");

  const { error: otpError } = await supabase.auth.signInWithOtp({ email });
  if (otpError) throw new Error(`Failed to send OTP: ${otpError.message}`);

  console.log(`\nCheck your email for a 6-digit code.`);
  const code = await prompt("Code: ");

  const { data, error: verifyError } = await supabase.auth.verifyOtp({
    email,
    token: code,
    type: "email",
  });
  if (verifyError) throw new Error(`Verification failed: ${verifyError.message}`);
  if (!data.session) throw new Error("No session returned after verification");

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
    console.log(`Username set to "${username}".`);
  }

  return profile;
}

export async function ensureAgentAndSpace(
  supabase: SupabaseClient,
  profile: Profile
): Promise<{ agent: Agent; space: Space }> {
  // Check for existing agent
  const { data: agents, error: agentError } = await supabase
    .from("agents")
    .select("id, name, owner_id")
    .eq("owner_id", profile.id);
  if (agentError) throw new Error(`Failed to fetch agents: ${agentError.message}`);

  let agent: Agent;
  if (agents && agents.length > 0) {
    agent = agents[0];
  } else {
    const agentName = `${profile.username}'s agent`;
    const { data: newAgent, error: createError } = await supabase
      .from("agents")
      .insert({ owner_id: profile.id, name: agentName })
      .select("id, name, owner_id")
      .single();
    if (createError) throw new Error(`Failed to create agent: ${createError.message}`);
    agent = newAgent;
    console.log(`Created agent "${agentName}".`);
  }

  // Check for existing space
  const { data: spaces, error: spaceError } = await supabase
    .from("spaces")
    .select("id, name, agent_id")
    .eq("agent_id", agent.id);
  if (spaceError) throw new Error(`Failed to fetch spaces: ${spaceError.message}`);

  let space: Space;
  if (spaces && spaces.length > 0) {
    space = spaces[0];
  } else {
    const spaceName = `${profile.username}'s space`;
    const { data: spaceId, error: createError } = await supabase
      .rpc("create_space", { p_agent_id: agent.id, p_name: spaceName });
    if (createError) throw new Error(`Failed to create space: ${createError.message}`);

    const { data: newSpace, error: fetchError } = await supabase
      .from("spaces")
      .select("id, name, agent_id")
      .eq("id", spaceId)
      .single();
    if (fetchError) throw new Error(`Failed to fetch new space: ${fetchError.message}`);
    space = newSpace;
    console.log(`Created space "${spaceName}" with #general channel.`);
  }

  return { agent, space };
}

import { PostHog } from "posthog-node";

const POSTHOG_API_KEY = "phc_60o4SAtAeYazK4cgt2bdp7A9Az7Sg9tTutESlevffp9";
const POSTHOG_HOST = "https://us.i.posthog.com";

let client: PostHog | null = null;
let distinctId = "bidi-agent";

export function initAnalytics(): void {
  if (process.env.BIDI_TELEMETRY === "off") {
    console.log("[analytics] Telemetry disabled (BIDI_TELEMETRY=off)");
    return;
  }
  client = new PostHog(POSTHOG_API_KEY, {
    host: POSTHOG_HOST,
    flushAt: 20,
    flushInterval: 10_000,
  });
}

export function setDistinctId(id: string): void {
  distinctId = id;
}

export function trackEvent(event: string, properties?: Record<string, unknown>): void {
  client?.capture({ distinctId, event, properties });
}

export function captureError(error: unknown, properties?: Record<string, unknown>): void {
  if (!client) return;
  if (error instanceof Error) {
    client.captureException(error, distinctId, properties);
  } else {
    client.capture({
      distinctId,
      event: "$exception",
      properties: { $exception_message: String(error), ...properties },
    });
  }
}

export async function shutdownAnalytics(): Promise<void> {
  await client?.shutdown();
}

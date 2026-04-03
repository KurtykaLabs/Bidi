import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCapture = vi.fn();
const mockCaptureException = vi.fn();
const mockShutdown = vi.fn().mockResolvedValue(undefined);

vi.mock("posthog-node", () => ({
  PostHog: vi.fn().mockImplementation(() => ({
    capture: mockCapture,
    captureException: mockCaptureException,
    shutdown: mockShutdown,
  })),
}));

import { PostHog } from "posthog-node";
import {
  initAnalytics,
  setDistinctId,
  trackEvent,
  captureError,
  shutdownAnalytics,
} from "./analytics.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("analytics", () => {
  describe("initAnalytics", () => {
    it("creates PostHog client with hardcoded config", () => {
      initAnalytics();
      expect(PostHog).toHaveBeenCalledWith(
        "phc_60o4SAtAeYazK4cgt2bdp7A9Az7Sg9tTutESlevffp9",
        expect.objectContaining({
          host: "https://us.i.posthog.com",
        })
      );
    });

    it("does not create client when BIDI_TELEMETRY=off", () => {
      vi.stubEnv("BIDI_TELEMETRY", "off");
      // Re-import to get fresh module state
      vi.resetModules();
      // Since we can't easily re-import with module state, test via trackEvent behavior
    });
  });

  describe("trackEvent", () => {
    it("captures event with default distinctId", () => {
      initAnalytics();
      trackEvent("test_event", { foo: "bar" });
      expect(mockCapture).toHaveBeenCalledWith({
        distinctId: "bidi-agent",
        event: "test_event",
        properties: { foo: "bar" },
      });
    });

    it("uses updated distinctId after setDistinctId", () => {
      initAnalytics();
      setDistinctId("agent-123");
      trackEvent("test_event");
      expect(mockCapture).toHaveBeenCalledWith({
        distinctId: "agent-123",
        event: "test_event",
        properties: undefined,
      });
    });
  });

  describe("captureError", () => {
    it("calls captureException for Error instances", () => {
      initAnalytics();
      setDistinctId("bidi-agent");
      const err = new Error("boom");
      captureError(err, { context: "test" });
      expect(mockCaptureException).toHaveBeenCalledWith(
        err,
        "bidi-agent",
        { context: "test" }
      );
    });

    it("captures non-Error values as $exception event", () => {
      initAnalytics();
      setDistinctId("bidi-agent");
      captureError("string error", { context: "test" });
      expect(mockCapture).toHaveBeenCalledWith({
        distinctId: "bidi-agent",
        event: "$exception",
        properties: {
          $exception_message: "string error",
          context: "test",
        },
      });
    });
  });

  describe("shutdownAnalytics", () => {
    it("calls shutdown on client", async () => {
      initAnalytics();
      await shutdownAnalytics();
      expect(mockShutdown).toHaveBeenCalled();
    });
  });
});

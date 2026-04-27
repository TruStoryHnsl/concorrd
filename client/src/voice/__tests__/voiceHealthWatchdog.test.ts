/**
 * Regression tests for the 2026-04-26 incident: a remote audio track
 * remained "subscribed + unmuted" while the SFU stopped delivering RTP,
 * causing the local decoder to emit distorted PLC output.
 *
 * These cover the pure-function evaluator. The full
 * VoiceHealthWatchdog class (which wires real LiveKit Room +
 * RTCRtpReceiver.getStats) is exercised in the cold-reader
 * integration session — see CLAUDE.md testing rules.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateTrackHealth,
  WATCHDOG_L2_AFTER_MS,
  WATCHDOG_STALE_AFTER_MS,
  type TrackHealthState,
} from "../voiceHealthWatchdog";

const baseSample = {
  publicationSid: "TR_123",
  participantIdentity: "@alice:example.com",
};

describe("evaluateTrackHealth", () => {
  it("seeds state on first sample with no action", () => {
    const { next, action } = evaluateTrackHealth(undefined, {
      ...baseSample,
      bytesReceived: 1024,
      sampleAtMs: 1000,
    });
    expect(action.kind).toBe("noop");
    expect(next.lastBytesReceived).toBe(1024);
    expect(next.lastProgressMs).toBe(1000);
    expect(next.lastL1AttemptMs).toBeNull();
    expect(next.lastL2AttemptMs).toBeNull();
  });

  it("resets progress timer when bytes increase", () => {
    const prev: TrackHealthState = {
      ...baseSample,
      lastBytesReceived: 1024,
      lastProgressMs: 1000,
      lastL1AttemptMs: null,
      lastL2AttemptMs: null,
    };
    const { next, action } = evaluateTrackHealth(prev, {
      ...baseSample,
      bytesReceived: 2048,
      sampleAtMs: 3000,
    });
    expect(action.kind).toBe("noop");
    expect(next.lastProgressMs).toBe(3000);
    expect(next.lastBytesReceived).toBe(2048);
  });

  it("does not escalate before STALE_AFTER_MS elapses", () => {
    const prev: TrackHealthState = {
      ...baseSample,
      lastBytesReceived: 1024,
      lastProgressMs: 1000,
      lastL1AttemptMs: null,
      lastL2AttemptMs: null,
    };
    const { action } = evaluateTrackHealth(prev, {
      ...baseSample,
      bytesReceived: 1024,
      sampleAtMs: 1000 + WATCHDOG_STALE_AFTER_MS - 100,
    });
    expect(action.kind).toBe("noop");
  });

  it("L1: restarts subscription after STALE_AFTER_MS of zero progress", () => {
    const prev: TrackHealthState = {
      ...baseSample,
      lastBytesReceived: 1024,
      lastProgressMs: 1000,
      lastL1AttemptMs: null,
      lastL2AttemptMs: null,
    };
    const { next, action } = evaluateTrackHealth(prev, {
      ...baseSample,
      bytesReceived: 1024,
      sampleAtMs: 1000 + WATCHDOG_STALE_AFTER_MS + 100,
    });
    expect(action.kind).toBe("restart-subscription");
    if (action.kind === "restart-subscription") {
      expect(action.publicationSid).toBe("TR_123");
      expect(action.participantIdentity).toBe("@alice:example.com");
    }
    expect(next.lastL1AttemptMs).not.toBeNull();
  });

  it("L2: forces full reconnect if still stale L2_AFTER_MS after L1", () => {
    const l1At = 6000;
    const prev: TrackHealthState = {
      ...baseSample,
      lastBytesReceived: 1024,
      lastProgressMs: 1000,
      lastL1AttemptMs: l1At,
      lastL2AttemptMs: null,
    };
    const { next, action } = evaluateTrackHealth(prev, {
      ...baseSample,
      bytesReceived: 1024,
      sampleAtMs: l1At + WATCHDOG_L2_AFTER_MS + 100,
    });
    expect(action.kind).toBe("reconnect-room");
    expect(next.lastL2AttemptMs).not.toBeNull();
  });

  it("does not double-fire L2 once already attempted", () => {
    const prev: TrackHealthState = {
      ...baseSample,
      lastBytesReceived: 1024,
      lastProgressMs: 1000,
      lastL1AttemptMs: 6000,
      lastL2AttemptMs: 11_500,
    };
    const { action } = evaluateTrackHealth(prev, {
      ...baseSample,
      bytesReceived: 1024,
      sampleAtMs: 30_000,
    });
    expect(action.kind).toBe("noop");
  });

  it("clears escalation state when bytes resume flowing", () => {
    const prev: TrackHealthState = {
      ...baseSample,
      lastBytesReceived: 1024,
      lastProgressMs: 1000,
      lastL1AttemptMs: 6000,
      lastL2AttemptMs: 11_500,
    };
    const { next, action } = evaluateTrackHealth(prev, {
      ...baseSample,
      bytesReceived: 4096,
      sampleAtMs: 12_000,
    });
    expect(action.kind).toBe("noop");
    expect(next.lastL1AttemptMs).toBeNull();
    expect(next.lastL2AttemptMs).toBeNull();
    expect(next.lastBytesReceived).toBe(4096);
  });
});

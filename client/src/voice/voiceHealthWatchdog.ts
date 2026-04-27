/**
 * Voice health watchdog.
 *
 * Detects the failure mode that bit us in production on 2026-04-26: a
 * remote audio track stays "subscribed" and "unmuted" but the SFU has
 * stopped delivering RTP for it (sender died, container killed, peer
 * disconnect didn't propagate). The decoder runs packet-loss
 * concealment forever and either emits silence or — worse — gets
 * confused by a trailing partial frame and emits distorted noise that
 * everyone in the room hears.
 *
 * Strategy:
 *   - Sample LiveKit's per-publication WebRTC stats every
 *     ``SAMPLE_INTERVAL_MS``.
 *   - For each remote audio publication that is subscribed, track the
 *     ``bytesReceived`` delta over the rolling window.
 *   - If a track's delta is zero for ``STALE_AFTER_MS`` while the
 *     publication is still nominally subscribed, escalate:
 *       L1: restart the subscription (unsubscribe + subscribe).
 *       L2: if still stale ``L2_AFTER_MS`` later, force a full room
 *           reconnect.
 *   - L1 is silent. L2 surfaces a brief "voice reconnecting…" toast
 *     because the user will perceive ~1 s of silence during the room
 *     handshake.
 *
 * The watchdog is a pure function over a stats sample stream so the
 * detection logic is testable without a live LiveKit room. The
 * ``WatchdogState`` carries the rolling history; ``evaluate`` returns
 * the action to take. Wiring lives in ``VoiceChannel.tsx``.
 */
import type { Room, RemoteParticipant, RemoteTrackPublication } from "livekit-client";
import { Track } from "livekit-client";

export const WATCHDOG_SAMPLE_INTERVAL_MS = 2000;
export const WATCHDOG_STALE_AFTER_MS = 5000;
export const WATCHDOG_L2_AFTER_MS = 5000;

export interface TrackHealthSample {
  publicationSid: string;
  participantIdentity: string;
  bytesReceived: number;
  jitter?: number;
  packetsLost?: number;
  sampleAtMs: number;
}

export interface TrackHealthState {
  publicationSid: string;
  participantIdentity: string;
  /** Last sample where bytes were observed strictly increasing. */
  lastProgressMs: number;
  lastBytesReceived: number;
  /** When L1 (subscription restart) was last attempted. */
  lastL1AttemptMs: number | null;
  /** When L2 (full reconnect) was last attempted. */
  lastL2AttemptMs: number | null;
}

export type WatchdogAction =
  | { kind: "noop" }
  | { kind: "restart-subscription"; publicationSid: string; participantIdentity: string }
  | { kind: "reconnect-room"; reason: string };

/**
 * Pure-function evaluator. Given the prior state for a track and the
 * latest sample, returns the next state plus the action to take.
 *
 * Decision table:
 *   - bytes increased → reset progress timer, no action.
 *   - bytes unchanged && < STALE_AFTER_MS since last progress → no action.
 *   - bytes unchanged && >= STALE_AFTER_MS && L1 not yet attempted →
 *       restart subscription, record L1 attempt time.
 *   - bytes unchanged && L1 attempted >= L2_AFTER_MS ago && L2 not yet
 *       attempted → reconnect room, record L2 attempt time.
 *   - otherwise → no action (we already escalated).
 */
export function evaluateTrackHealth(
  prev: TrackHealthState | undefined,
  sample: TrackHealthSample,
): { next: TrackHealthState; action: WatchdogAction } {
  if (!prev) {
    return {
      next: {
        publicationSid: sample.publicationSid,
        participantIdentity: sample.participantIdentity,
        lastProgressMs: sample.sampleAtMs,
        lastBytesReceived: sample.bytesReceived,
        lastL1AttemptMs: null,
        lastL2AttemptMs: null,
      },
      action: { kind: "noop" },
    };
  }

  if (sample.bytesReceived > prev.lastBytesReceived) {
    return {
      next: {
        ...prev,
        lastProgressMs: sample.sampleAtMs,
        lastBytesReceived: sample.bytesReceived,
        lastL1AttemptMs: null,
        lastL2AttemptMs: null,
      },
      action: { kind: "noop" },
    };
  }

  const stallMs = sample.sampleAtMs - prev.lastProgressMs;

  if (stallMs < WATCHDOG_STALE_AFTER_MS) {
    return { next: prev, action: { kind: "noop" } };
  }

  if (prev.lastL1AttemptMs === null) {
    return {
      next: { ...prev, lastL1AttemptMs: sample.sampleAtMs },
      action: {
        kind: "restart-subscription",
        publicationSid: sample.publicationSid,
        participantIdentity: sample.participantIdentity,
      },
    };
  }

  const sinceL1 = sample.sampleAtMs - prev.lastL1AttemptMs;
  if (sinceL1 >= WATCHDOG_L2_AFTER_MS && prev.lastL2AttemptMs === null) {
    return {
      next: { ...prev, lastL2AttemptMs: sample.sampleAtMs },
      action: {
        kind: "reconnect-room",
        reason: `track ${sample.publicationSid} stalled ${stallMs}ms after L1 restart`,
      },
    };
  }

  return { next: prev, action: { kind: "noop" } };
}

export interface WatchdogContext {
  room: Room;
  /** Optional callback fired on every action so the UI can surface toasts. */
  onAction?: (action: WatchdogAction) => void;
}

/**
 * Mounted watchdog. Holds the rolling state map and the sample timer.
 * Construct with the active LiveKit Room; call ``stop()`` on disconnect.
 */
export class VoiceHealthWatchdog {
  private states = new Map<string, TrackHealthState>();
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;
  private readonly room: Room;
  private readonly onAction?: (action: WatchdogAction) => void;

  constructor(ctx: WatchdogContext) {
    this.room = ctx.room;
    this.onAction = ctx.onAction;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = globalThis.setInterval(
      () => void this.tick(),
      WATCHDOG_SAMPLE_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.timer !== null) {
      globalThis.clearInterval(this.timer);
      this.timer = null;
    }
    this.states.clear();
  }

  /** Drop watchdog state for a publication (used when participant leaves). */
  forget(publicationSid: string): void {
    this.states.delete(publicationSid);
  }

  private async tick(): Promise<void> {
    const samples = await this.collectSamples();
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    for (const sample of samples) {
      const prev = this.states.get(sample.publicationSid);
      const { next, action } = evaluateTrackHealth(prev, {
        ...sample,
        sampleAtMs: now,
      });
      this.states.set(sample.publicationSid, next);
      if (action.kind !== "noop") {
        await this.executeAction(action);
      }
    }
    // Drop state for publications that no longer exist on the room
    // — participant left, track unsubscribed manually, etc.
    const liveSids = new Set(samples.map((s) => s.publicationSid));
    for (const sid of [...this.states.keys()]) {
      if (!liveSids.has(sid)) this.states.delete(sid);
    }
  }

  private async collectSamples(): Promise<Omit<TrackHealthSample, "sampleAtMs">[]> {
    const out: Omit<TrackHealthSample, "sampleAtMs">[] = [];
    const remotes: RemoteParticipant[] = [...this.room.remoteParticipants.values()];
    for (const participant of remotes) {
      const audioPubs: RemoteTrackPublication[] = [
        ...participant.audioTrackPublications.values(),
      ];
      for (const pub of audioPubs) {
        if (pub.kind !== Track.Kind.Audio) continue;
        if (!pub.isSubscribed) continue;
        if (pub.isMuted) continue;
        const track = pub.track;
        if (!track) continue;
        const stats = await safeGetReceiverStats(track);
        if (stats === null) continue;
        out.push({
          publicationSid: pub.trackSid,
          participantIdentity: participant.identity,
          bytesReceived: stats.bytesReceived,
          jitter: stats.jitter,
          packetsLost: stats.packetsLost,
        });
      }
    }
    return out;
  }

  private async executeAction(action: WatchdogAction): Promise<void> {
    this.onAction?.(action);
    if (action.kind === "restart-subscription") {
      const participant = this.room.remoteParticipants.get(
        action.participantIdentity,
      );
      const pub = participant?.audioTrackPublications.get(action.publicationSid);
      if (pub) {
        try {
          pub.setSubscribed(false);
          pub.setSubscribed(true);
        } catch {
          // Best-effort; failures fall through to L2 on next stall window.
        }
      }
    } else if (action.kind === "reconnect-room") {
      try {
        await this.room.disconnect();
        // Reconnect path: caller (VoiceChannel) listens for the
        // disconnect event and re-runs the join flow.
      } catch {}
    }
  }
}

interface ReceiverStats {
  bytesReceived: number;
  jitter?: number;
  packetsLost?: number;
}

/**
 * Read inbound-rtp stats for a remote audio track. Returns null on
 * any error (browser doesn't expose getStats on this track, no
 * inbound-rtp report yet, etc.). Pure best-effort — the watchdog
 * tolerates missing samples and will simply skip the track until
 * stats become available.
 */
async function safeGetReceiverStats(
  track: { receiver?: RTCRtpReceiver } & object,
): Promise<ReceiverStats | null> {
  try {
    const receiver = track.receiver;
    if (!receiver || typeof receiver.getStats !== "function") return null;
    const report: RTCStatsReport = await receiver.getStats();
    let bytesReceived = 0;
    let jitter: number | undefined;
    let packetsLost: number | undefined;
    report.forEach((stat) => {
      // RTCInboundRtpStreamStats has bytesReceived; older browsers used
      // ``bytesReceived`` on the receiver-level stat too.
      if ((stat as { type?: string }).type === "inbound-rtp") {
        const s = stat as {
          bytesReceived?: number;
          jitter?: number;
          packetsLost?: number;
        };
        if (typeof s.bytesReceived === "number") {
          bytesReceived = s.bytesReceived;
        }
        if (typeof s.jitter === "number") jitter = s.jitter;
        if (typeof s.packetsLost === "number") packetsLost = s.packetsLost;
      }
    });
    return { bytesReceived, jitter, packetsLost };
  } catch {
    return null;
  }
}

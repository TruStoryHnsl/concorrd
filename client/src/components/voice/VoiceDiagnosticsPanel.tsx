/**
 * Voice diagnostics overlay.
 *
 * Renders live WebRTC stats for the active LiveKit room: per-publication
 * bytes/sec, jitter, packet loss, RTT, codec, sample rate. Lets the
 * next "audio sounds weird" report start with numbers instead of
 * vibes.
 *
 * Gated behind ``localStorage.concordVoiceDebug = "1"``. Stays mounted
 * silently when the flag is missing — no UI, no polling, no overhead.
 */
import { useEffect, useRef, useState } from "react";
import type { Room, RemoteTrackPublication } from "livekit-client";
import { Track } from "livekit-client";

interface PerTrackStats {
  participantIdentity: string;
  trackSid: string;
  source: "local" | "remote";
  kind: string;
  bytesPerSec: number | null;
  jitter: number | null;
  packetsLost: number | null;
  rttMs: number | null;
  codec: string | null;
  sampleRate: number | null;
}

const POLL_INTERVAL_MS = 1000;

function isDebugFlagOn(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      window.localStorage?.getItem("concordVoiceDebug") === "1"
    );
  } catch {
    return false;
  }
}

export function VoiceDiagnosticsPanel({ room }: { room: Room | null }) {
  const [enabled, setEnabled] = useState(() => isDebugFlagOn());
  const [stats, setStats] = useState<PerTrackStats[]>([]);
  const lastBytesRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    // Re-check the flag on every storage event so toggling
    // ``localStorage.concordVoiceDebug`` from DevTools shows/hides the
    // panel without a page reload.
    const onStorage = () => setEnabled(isDebugFlagOn());
    if (typeof window !== "undefined") {
      window.addEventListener("storage", onStorage);
      return () => window.removeEventListener("storage", onStorage);
    }
    return undefined;
  }, []);

  useEffect(() => {
    if (!enabled || !room) return;
    let cancelled = false;
    const tick = async () => {
      const collected: PerTrackStats[] = [];
      // Local publications.
      for (const pub of room.localParticipant.audioTrackPublications.values()) {
        const sender = pub.track?.sender;
        const senderStats = sender ? await safeGetStats(sender) : null;
        collected.push({
          participantIdentity: room.localParticipant.identity || "(me)",
          trackSid: pub.trackSid,
          source: "local",
          kind: pub.kind,
          bytesPerSec: senderStats
            ? bytesPerSecond(`local:${pub.trackSid}`, senderStats.bytesSent ?? 0, lastBytesRef.current)
            : null,
          jitter: null,
          packetsLost: null,
          rttMs: senderStats?.rttMs ?? null,
          codec: senderStats?.codec ?? null,
          sampleRate: senderStats?.sampleRate ?? null,
        });
      }
      // Remote publications.
      for (const remote of room.remoteParticipants.values()) {
        const pubs: RemoteTrackPublication[] = [
          ...remote.audioTrackPublications.values(),
          ...remote.videoTrackPublications.values(),
        ];
        for (const pub of pubs) {
          if (pub.kind !== Track.Kind.Audio && pub.kind !== Track.Kind.Video) continue;
          if (!pub.isSubscribed) continue;
          const receiver = pub.track?.receiver;
          const recvStats = receiver ? await safeGetStats(receiver) : null;
          collected.push({
            participantIdentity: remote.identity,
            trackSid: pub.trackSid,
            source: "remote",
            kind: pub.kind,
            bytesPerSec: recvStats
              ? bytesPerSecond(
                  `remote:${pub.trackSid}`,
                  recvStats.bytesReceived ?? 0,
                  lastBytesRef.current,
                )
              : null,
            jitter: recvStats?.jitter ?? null,
            packetsLost: recvStats?.packetsLost ?? null,
            rttMs: recvStats?.rttMs ?? null,
            codec: recvStats?.codec ?? null,
            sampleRate: recvStats?.sampleRate ?? null,
          });
        }
      }
      if (!cancelled) setStats(collected);
    };
    void tick();
    const id = globalThis.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      globalThis.clearInterval(id);
    };
  }, [enabled, room]);

  if (!enabled || !room) return null;

  return (
    <div
      className="fixed bottom-2 right-2 z-50 max-w-md max-h-[60vh] overflow-y-auto rounded-lg bg-black/80 p-3 text-[11px] font-mono text-emerald-300 shadow-xl ring-1 ring-emerald-400/30"
      data-testid="voice-diagnostics-panel"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-emerald-400 font-bold">voice diagnostics</span>
        <button
          type="button"
          onClick={() => {
            try {
              window.localStorage.removeItem("concordVoiceDebug");
            } catch {}
            setEnabled(false);
          }}
          className="text-emerald-400/60 hover:text-emerald-400"
          title="Hide. Re-enable with localStorage.concordVoiceDebug='1'"
        >
          ×
        </button>
      </div>
      {stats.length === 0 && (
        <div className="text-emerald-400/50">no active publications</div>
      )}
      {stats.map((s) => (
        <div
          key={`${s.source}:${s.trackSid}`}
          className="mb-2 border-l-2 border-emerald-400/30 pl-2"
        >
          <div className="text-emerald-200">
            {s.source} · {s.kind} · {s.participantIdentity}
          </div>
          <div className="text-emerald-300/80">
            sid: {s.trackSid.slice(0, 16)}…
          </div>
          <div>
            {s.bytesPerSec !== null
              ? `${(s.bytesPerSec / 1024).toFixed(1)} KiB/s`
              : "bps: —"}
            {" · "}
            jitter: {s.jitter !== null ? `${(s.jitter * 1000).toFixed(1)}ms` : "—"}
            {" · "}
            loss: {s.packetsLost ?? "—"}
          </div>
          <div>
            rtt: {s.rttMs !== null ? `${s.rttMs.toFixed(0)}ms` : "—"}
            {" · "}
            codec: {s.codec ?? "—"}
            {" · "}
            sr: {s.sampleRate ?? "—"}
          </div>
        </div>
      ))}
    </div>
  );
}

interface ResolvedStats {
  bytesSent?: number;
  bytesReceived?: number;
  jitter?: number;
  packetsLost?: number;
  rttMs?: number;
  codec?: string;
  sampleRate?: number;
}

async function safeGetStats(
  endpoint: RTCRtpSender | RTCRtpReceiver,
): Promise<ResolvedStats | null> {
  try {
    if (typeof endpoint.getStats !== "function") return null;
    const report: RTCStatsReport = await endpoint.getStats();
    let out: ResolvedStats = {};
    const codecPayloadIds = new Map<string, string>();
    report.forEach((stat) => {
      const t = (stat as { type?: string }).type;
      const s = stat as Record<string, unknown>;
      if (t === "codec") {
        const id = String(s.id ?? "");
        const mime = String(s.mimeType ?? "");
        if (id && mime) codecPayloadIds.set(id, mime);
      } else if (t === "outbound-rtp") {
        if (typeof s.bytesSent === "number") out.bytesSent = s.bytesSent;
        if (typeof s.codecId === "string") {
          const mime = codecPayloadIds.get(s.codecId);
          if (mime) out.codec = mime;
        }
      } else if (t === "inbound-rtp") {
        if (typeof s.bytesReceived === "number") out.bytesReceived = s.bytesReceived;
        if (typeof s.jitter === "number") out.jitter = s.jitter;
        if (typeof s.packetsLost === "number") out.packetsLost = s.packetsLost;
        if (typeof s.codecId === "string") {
          const mime = codecPayloadIds.get(s.codecId);
          if (mime) out.codec = mime;
        }
      } else if (t === "remote-inbound-rtp") {
        if (typeof s.roundTripTime === "number") {
          out.rttMs = s.roundTripTime * 1000;
        }
      } else if (t === "media-source") {
        if (typeof s.audioLevel === "number" && typeof s.totalSamplesDuration === "number" && !out.sampleRate) {
          // Some browsers don't expose sampleRate directly — leave it undefined.
        }
      } else if (t === "track") {
        if (typeof s.sampleRate === "number") out.sampleRate = s.sampleRate;
      }
    });
    return out;
  } catch {
    return null;
  }
}

function bytesPerSecond(
  key: string,
  currentBytes: number,
  lastBytes: Map<string, number>,
): number | null {
  const prev = lastBytes.get(key);
  lastBytes.set(key, currentBytes);
  if (prev === undefined) return null;
  return Math.max(0, currentBytes - prev);
}

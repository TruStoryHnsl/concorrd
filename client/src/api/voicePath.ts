/**
 * Phase 8 (INS-019b) — voice path selection wrapper.
 *
 * The native servitude layer decides per-call whether voice runs as a
 * full libp2p WebRTC mesh or falls back to the LiveKit SFU. This
 * module bridges the React voice-join flow to the Rust
 * `select_voice_path` Tauri command (see
 * `src-tauri/src/lib.rs::select_voice_path`).
 *
 * Decision rules (Phase 8 design doc, restated for the TS side):
 *   - >8 participants → SFU (`"above_cap_8"`).
 *   - Any participant with `peerId === null` → SFU
 *     (`"web_only_participant_present"`).
 *   - Otherwise → mesh (`"all_native_under_cap"`).
 *
 * Browser builds short-circuit to SFU regardless — browsers cannot
 * participate in the libp2p mesh until Phase 9 ships js-libp2p.
 * Until then the web client always rides LiveKit, and the reason
 * string `"browser_or_web_build"` makes that explicit on the wire.
 *
 * Phase 8 ships the DECISION + the signaling-protocol scaffolding;
 * full mesh-MEDIA over libp2p (real audio frames) is queued as a
 * Phase 8 follow-up — the integration of `webrtc-rs` for audio
 * capture / opus encoding / RTP is a sizable separate piece of
 * work. Today the selector returns `libp2p_mesh` but the
 * `joinVoiceSession` consumer logs the decision and falls through
 * to LiveKit so the working voice path stays the default behavior.
 */

import { isTauri } from "./servitude";

/** Stable wire form of the chosen path. */
export type VoicePath = "libp2p_mesh" | "livekit_sfu";

/**
 * Frontend-supplied participant descriptor. Mirrors the Rust
 * `VoiceParticipantInput` struct.
 *
 * `peer_id` is the libp2p PeerId in base58 form if the local peer-
 * store has a resolved entry for this Matrix user, else `null`. The
 * Rust side reads `null` as web-only.
 */
export interface VoiceParticipant {
  matrix_user_id: string;
  peer_id: string | null;
}

/**
 * Result returned by {@link selectVoicePath}. `path` is the chosen
 * voice plane; `reason` is a stable snake_case classification of
 * why.
 *
 * `reason` values:
 *   - `"above_cap_8"` — >8 participants, SFU forced.
 *   - `"web_only_participant_present"` — at least one participant
 *     reachable only via the web plane, SFU forced.
 *   - `"all_native_under_cap"` — pure mesh case.
 *   - `"browser_or_web_build"` — web build short-circuit. The
 *     selector never invoked the native layer.
 */
export interface VoicePathSelection {
  path: VoicePath;
  reason: string;
}

/**
 * Ask the native servitude layer which voice path to use.
 *
 * Native build: invokes the Tauri command. The Rust side resolves
 * the path via the same selector that backs the integration tests
 * (see `src-tauri/src/servitude/voice/selector.rs`).
 *
 * Web build: short-circuits to LiveKit. Browsers cannot be libp2p
 * mesh peers until Phase 9.
 *
 * If the Tauri invocation fails for any reason (e.g. the command
 * is unregistered on an older native build, or the Rust side
 * returned an error), the wrapper falls back to LiveKit so the
 * voice flow never blocks on a degraded path-selection layer.
 * `reason` carries the failure shape for diagnostics.
 */
export async function selectVoicePath(
  participants: VoiceParticipant[],
): Promise<VoicePathSelection> {
  // Web build / pre-Tauri-init short-circuit. The selector never
  // invokes the native layer; LiveKit is the only path the browser
  // can use until Phase 9.
  if (!isTauri()) {
    return { path: "livekit_sfu", reason: "browser_or_web_build" };
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const raw = await invoke<VoicePathSelection>("select_voice_path", {
      participants,
    });
    return {
      path: raw.path,
      reason: raw.reason,
    };
  } catch (err) {
    // Path selection failing must NOT take the voice flow down with
    // it. Fall back to the working LiveKit path and surface the
    // failure shape via the reason string so callers can log it.
    const reason =
      err instanceof Error
        ? `select_voice_path_error: ${err.message}`
        : `select_voice_path_error: ${String(err)}`;
    return { path: "livekit_sfu", reason };
  }
}

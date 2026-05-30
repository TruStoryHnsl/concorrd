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
 * Phase 9 update: browsers ARE now mesh-eligible when they have a
 * running js-libp2p node (per the Phase 9 design — js-libp2p in the
 * browser client makes the browser a real Concord peer). The web
 * build replicates the same selector locally:
 *
 *   - No browser libp2p node started → SFU (`"browser_libp2p_not_running"`).
 *   - Any participant with `peer_id === null` → SFU.
 *   - >8 participants → SFU.
 *   - Otherwise → mesh.
 *
 * Phase 8 shipped the path-selection + signaling-protocol scaffolding;
 * the audio-MEDIA layer (real WebRTC tracks over the libp2p WebRTC
 * transport, opus encoding, RTP) is a coordinated Phase 8/9 follow-up.
 * Until that lands, `joinVoiceSession` still rides LiveKit even when
 * the selector returns `libp2p_mesh` — the decision flips to "the
 * selector says mesh is viable", but the media plane stays on the
 * proven LiveKit code path until the audio half is real.
 */

import { isTauri } from "./servitude";
import { getNode } from "../libp2p/node";

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
 *   - `"browser_libp2p_not_running"` — web build with no js-libp2p
 *     node started; the browser can't mesh until Phase 9's hook
 *     finishes mounting.
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
  if (isTauri()) {
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
  // Browser build (Phase 9): replicate the native selector locally.
  // The browser is mesh-eligible ONLY when a libp2p node is running
  // AND every participant has a resolved peerId AND the room is at or
  // under the 8-peer cap. Otherwise — SFU.
  const node = getNode();
  if (!node) {
    return { path: "livekit_sfu", reason: "browser_libp2p_not_running" };
  }
  if (participants.length > 8) {
    return { path: "livekit_sfu", reason: "above_cap_8" };
  }
  if (participants.some((p) => !p.peer_id)) {
    return { path: "livekit_sfu", reason: "web_only_participant_present" };
  }
  return { path: "libp2p_mesh", reason: "all_native_under_cap" };
}

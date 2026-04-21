import { useCallback, useMemo, useState } from "react";
import { useTracks, VideoTrack } from "@livekit/components-react";
import { Track } from "livekit-client";
import { useVoiceStore } from "../../stores/voice";
import { useServerStore } from "../../stores/server";
import { useDMStore } from "../../stores/dm";
import { useSettingsStore } from "../../stores/settings";

/**
 * Floating picture-in-picture video tiles (Issue E, 2026-04-18).
 *
 * When a user is in a voice/place channel with published camera or
 * screen-share tracks and navigates away (different channel, DMs,
 * settings, another server), the tracks must NOT disappear — the
 * LiveKitRoom in App.tsx stays connected, but VoiceChannel.tsx unmounts
 * its video grid when the user isn't viewing the owning channel.
 *
 * This component lives INSIDE the LiveKitRoom (as a sibling of
 * CustomAudioRenderer in App.tsx). It subscribes to Camera +
 * ScreenShare tracks via LiveKit hooks and:
 *
 *   • Renders NOTHING when the user is currently viewing the voice
 *     channel's UI — that UI already shows the tiles docked. This
 *     prevents duplicate-tile rendering and double WebRTC attach.
 *   • Renders a fixed bottom-right overlay of tiles when the user
 *     has navigated away, so they can keep watching / keep the
 *     stream alive while they browse.
 *
 * The overlay also exposes:
 *   • "Return to channel" — navigates back to the voice channel.
 *   • "Close overlay" — hides the float without disconnecting (the
 *     audio stays alive via CustomAudioRenderer so the user can still
 *     hear voice even with the tiles hidden). A reopen is only
 *     possible by navigating back to the channel.
 *
 * Instrumentation: mount / unmount / visibility transitions are
 * console.info'd under a [floating-video] tag so Playwright traces
 * and manual QA can observe the lifecycle without having to insert
 * probes in the middle of a test.
 */
export function FloatingVideoTiles() {
  // LiveKit hooks — safe to call unconditionally because this component
  // only ever renders inside LiveKitRoom.
  const allCameraTracks = useTracks([Track.Source.Camera]);
  const allScreenTracks = useTracks([Track.Source.ScreenShare]);

  // Only keep tracks with a live, unmuted publication. LiveKit often
  // reports publications after the user has toggled them off; rendering
  // those produces an empty black tile.
  const cameraTracks = useMemo(
    () => allCameraTracks.filter((t) => t.publication && !t.publication.isMuted && t.publication.track),
    [allCameraTracks],
  );
  const screenTracks = useMemo(
    () => allScreenTracks.filter((t) => t.publication && !t.publication.isMuted && t.publication.track),
    [allScreenTracks],
  );

  // Voice/UI state used to decide whether to float.
  const voiceConnected = useVoiceStore((s) => s.connected);
  const voiceChannelId = useVoiceStore((s) => s.channelId);
  const activeServerId = useVoiceStore((s) => s.serverId);
  const activeChannelId = useServerStore((s) => s.activeChannelId);
  const serverStoreActiveServerId = useServerStore((s) => s.activeServerId);
  const dmActive = useDMStore((s) => s.dmActive);
  const settingsOpen = useSettingsStore((s) => s.settingsOpen);
  const serverSettingsId = useSettingsStore((s) => s.serverSettingsId);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const setActiveChannel = useServerStore((s) => s.setActiveChannel);
  const setDMActive = useDMStore((s) => s.setDMActive);
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const closeServerSettings = useSettingsStore((s) => s.closeServerSettings);

  // User-controlled local close of the overlay. Keyed by voice channel
  // so joining a fresh room re-shows the float even if the previous
  // session's float was closed.
  const [dismissedForChannelId, setDismissedForChannelId] = useState<string | null>(null);

  // Are we currently viewing the voice channel? If so, the docked UI in
  // VoiceChannel.tsx is already showing the same tiles — don't duplicate.
  const viewingVoiceChannel =
    voiceChannelId !== null &&
    !dmActive &&
    !settingsOpen &&
    !serverSettingsId &&
    activeChannelId === voiceChannelId &&
    serverStoreActiveServerId === activeServerId;

  const hasVideo = cameraTracks.length + screenTracks.length > 0;

  const shouldFloat =
    voiceConnected &&
    voiceChannelId !== null &&
    hasVideo &&
    !viewingVoiceChannel &&
    dismissedForChannelId !== voiceChannelId;

  // Lifecycle instrumentation: fires on each transition of shouldFloat.
  // Uses ref-ish memoization so we only log when the boolean flips, not
  // on every render.
  const prevShouldFloatRef = useMemoRef(shouldFloat);
  if (prevShouldFloatRef.previous !== shouldFloat) {
    console.info("[floating-video] transition", {
      now: shouldFloat,
      viewingVoiceChannel,
      voiceChannelId,
      activeChannelId,
      cameraTracks: cameraTracks.length,
      screenTracks: screenTracks.length,
      dmActive,
      settingsOpen,
    });
    prevShouldFloatRef.previous = shouldFloat;
  }

  const handleReturn = useCallback(() => {
    if (!voiceChannelId || !activeServerId) return;
    console.info("[floating-video] return-to-channel", { voiceChannelId, activeServerId });
    // Close any overlays that would hide the chat view.
    closeSettings();
    closeServerSettings();
    setDMActive(false);
    setActiveServer(activeServerId);
    setActiveChannel(voiceChannelId);
    // Clear dismissed state so if they leave again, the float reappears.
    setDismissedForChannelId(null);
  }, [
    voiceChannelId,
    activeServerId,
    closeSettings,
    closeServerSettings,
    setDMActive,
    setActiveServer,
    setActiveChannel,
  ]);

  const handleDismiss = useCallback(() => {
    if (!voiceChannelId) return;
    console.info("[floating-video] dismiss", { voiceChannelId });
    setDismissedForChannelId(voiceChannelId);
  }, [voiceChannelId]);

  if (!shouldFloat) return null;

  return (
    <div
      className="fixed right-4 bottom-20 z-40 flex flex-col gap-2"
      data-testid="floating-video-tiles"
      aria-label="Floating video overlay from active voice session"
    >
      {/* Screen tiles first so large shared screens take priority. */}
      {screenTracks.map((t) => (
        <FloatingTile
          key={`screen-${t.participant.identity}`}
          label={`${displayNameFor(t.participant)} screen`}
          kind="screen"
        >
          <VideoTrack
            trackRef={t}
            className="w-full h-full object-contain bg-black"
          />
        </FloatingTile>
      ))}
      {cameraTracks.map((t) => (
        <FloatingTile
          key={`cam-${t.participant.identity}`}
          label={displayNameFor(t.participant)}
          kind="camera"
        >
          <VideoTrack
            trackRef={t}
            className="w-full h-full object-cover bg-black"
          />
        </FloatingTile>
      ))}
      <div className="flex items-center justify-end gap-1.5 rounded-xl bg-surface-container/90 backdrop-blur px-2 py-1 shadow-lg">
        <button
          type="button"
          onClick={handleReturn}
          className="btn-press px-2 py-1 rounded-md text-xs text-primary hover:bg-primary/10"
          data-testid="floating-video-return"
          title="Return to the voice channel"
        >
          <span className="material-symbols-outlined text-sm align-middle mr-1">open_in_full</span>
          Return
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="btn-press px-2 py-1 rounded-md text-xs text-on-surface-variant hover:bg-surface-container-highest"
          data-testid="floating-video-close"
          title="Hide overlay (voice stays connected)"
        >
          <span className="material-symbols-outlined text-sm align-middle">close</span>
        </button>
      </div>
    </div>
  );
}

function FloatingTile({
  label,
  kind,
  children,
}: {
  label: string;
  kind: "camera" | "screen";
  children: React.ReactNode;
}) {
  return (
    <div
      className={`relative rounded-xl overflow-hidden shadow-2xl ring-1 ring-outline-variant/30 ${
        kind === "screen" ? "w-[360px] h-[202px]" : "w-[240px] h-[135px]"
      }`}
    >
      {children}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-2 py-1">
        <span className="text-[11px] text-white/90 font-label truncate block">{label}</span>
      </div>
    </div>
  );
}

function displayNameFor(p: { identity: string; name?: string }): string {
  return p.name && p.name.trim() !== "" ? p.name : p.identity.split(":")[0].replace("@", "");
}

/** Internal helper — a ref-like memoiser that returns the same mutable
 *  object across renders. Saves adding a separate useRef import for the
 *  single lifecycle instrumentation site. */
function useMemoRef<T>(value: T): { previous: T } {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const obj = useMemo(() => ({ previous: value }), []);
  return obj;
}

import { useEffect, useRef, useCallback, useState } from "react";
import { LiveKitRoom } from "@livekit/components-react";
import { useAuthStore } from "./stores/auth";
import { useServerStore } from "./stores/server";
import { useToastStore } from "./stores/toast";
import { useVoiceStore, getPendingVoiceSession, clearPendingVoiceSession, MAX_RECONNECT_ATTEMPTS, RECONNECT_BASE_DELAY_MS } from "./stores/voice";
import { useSettingsStore } from "./stores/settings";
import { useServerConfigStore } from "./stores/serverConfig";
import { isDesktopMode } from "./api/serverUrl";
import { joinVoiceSession } from "./components/voice/joinVoiceSession";
import { usePlatform } from "./hooks/usePlatform";
import { useServitudeLifecycle } from "./hooks/useServitudeLifecycle";
import { runStartupCheck as runUpdaterStartupCheck } from "./lib/updater";
import { computeInitialServerConnected } from "./serverPickerGate";
import { redeemInvite, getInstanceInfo } from "./api/concord";
import { showBootSplash } from "./bootSplash";
import { LoginForm } from "./components/auth/LoginForm";
import { ServerPickerScreen } from "./components/auth/ServerPickerScreen";
import { DockerFirstBootScreen } from "./components/auth/DockerFirstBootScreen";
import { SubmitPage } from "./components/public/SubmitPage";
import { ChatLayout } from "./components/layout/ChatLayout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LaunchAnimation } from "./components/LaunchAnimation";
import { MarkReady } from "./components/MarkReady";
import { ToastContainer } from "./components/ui/Toast";
import { VoiceConnectionBar } from "./components/voice/VoiceConnectionBar";
import { DirectInviteBanner } from "./components/DirectInviteBanner";
import { CustomAudioRenderer } from "./components/voice/CustomAudioRenderer";
import { classifyVoiceError } from "./components/voice/classifyVoiceError";
import { FloatingVideoTiles } from "./components/voice/FloatingVideoTiles";
import { buildLiveKitAudioCaptureOptions } from "./voice/noiseGate";

// Capture invite token immediately at module load — before React mounts,
// before session restoration, before anything can clear the URL.
const INVITE_STORAGE_KEY = "concord_pending_invite";
const urlParams = new URLSearchParams(window.location.search);
const initialInviteToken = urlParams.get("invite");
if (initialInviteToken) {
  sessionStorage.setItem(INVITE_STORAGE_KEY, initialInviteToken);
}

export { INVITE_STORAGE_KEY };

export default function App() {
  const hasNewConfig = useServerConfigStore((s) => s.config !== null);
  const { isTauri, isTV } = usePlatform();

  // INS-022: pause/resume the embedded servitude on Tauri window
  // blur/focus so a backgrounded app doesn't advertise an unreachable
  // relay. No-op outside Tauri. The hook attaches its own event
  // listeners and tears them down on unmount.
  useServitudeLifecycle();

  // Phase 9 (bundle split): the per-tab js-libp2p node is no longer
  // eagerly started on App mount. The ~600 KB libp2p stack is loaded
  // lazily via `client/src/libp2p/lazyNode.ts` the first time a
  // surface that actually needs it mounts (voice room with
  // mesh-eligible participants, or the Paired Peers section in
  // Settings → Profile). Sessions that never hit one of those
  // surfaces pay zero libp2p cost. The `useBrowserLibp2p({ enabled:
  // true })` opt-in from VoiceChannel / ProfileTab drives the lazy
  // start path through the shared singleton node.

  // In-app updater: native builds poll the GitHub releases listing on
  // launch (6h debounce via localStorage) and prompt if a newer per-
  // platform release is available. No-op outside Tauri. Manual
  // re-check lives in Settings → About → "Check for updates".
  useEffect(() => {
    runUpdaterStartupCheck();
  }, []);

  const [serverConnected, setServerConnected] = useState(() =>
    computeInitialServerConnected({
      isNative: isTauri,
      hasNewConfig,
    }),
  );

  // INS-050: Docker first-boot Host/Join picker state.
  // "pending" = waiting to show picker; "join" = user chose join, show server picker;
  // "done" = picker resolved (host path or join completed), proceed normally.
  // Only triggers on web/Docker (non-native) builds where first_boot is true.
  type DockerBootState = "checking" | "pending" | "join" | "done";
  const [dockerBootState, setDockerBootState] = useState<DockerBootState>("checking");
  const [instanceDomain, setInstanceDomain] = useState("");

  useEffect(() => {
    if (isTauri) {
      // Native builds have their own server picker; skip Docker flow.
      setDockerBootState("done");
      return;
    }
    getInstanceInfo()
      .then((info) => {
        if (info.first_boot) {
          setInstanceDomain(info.instance_domain ?? "");
          setDockerBootState("pending");
        } else {
          setDockerBootState("done");
        }
      })
      .catch(() => {
        // If the instance info fetch fails, skip the picker.
        setDockerBootState("done");
      });
  }, [isTauri]);

  // INS-023 launch animation: a cross-platform boot splash that
  // covers the first-paint gap and any subsequent isLoading window.
  // `launchDone` flips true once the `<LaunchAnimation/>` has
  // finished its dismiss animation; the overlay then unmounts so
  // interactive elements underneath stop sitting beneath a z-9999
  // invisible layer. The `index.html` inline <style> block paints
  // the dark background before React even boots, so the splash
  // merely sits on top of a dark page instead of over a white flash.
  const [launchDone, setLaunchDone] = useState(false);

  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);
  const isLoading = useAuthStore((s) => s.isLoading);
  const restoreSession = useAuthStore((s) => s.restoreSession);
  const accessToken = useAuthStore((s) => s.accessToken);
  const loadServers = useServerStore((s) => s.loadServers);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const addToast = useToastStore((s) => s.addToast);
  const inviteHandled = useRef(false);

  // Voice state
  const voiceConnected = useVoiceStore((s) => s.connected);
  const voiceToken = useVoiceStore((s) => s.token);
  const livekitUrl = useVoiceStore((s) => s.livekitUrl);
  const iceServers = useVoiceStore((s) => s.iceServers);
  const micGranted = useVoiceStore((s) => s.micGranted);
  const voiceDisconnect = useVoiceStore((s) => s.disconnect);

  const echoCancellation = useSettingsStore((s) => s.echoCancellation);
  const noiseSuppression = useSettingsStore((s) => s.noiseSuppression);
  const autoGainControl = useSettingsStore((s) => s.autoGainControl);
  const preferredInputDeviceId = useSettingsStore((s) => s.preferredInputDeviceId);
  const masterInputVolume = useSettingsStore((s) => s.masterInputVolume);
  const inputNoiseGateEnabled = useSettingsStore((s) => s.inputNoiseGateEnabled);
  const inputNoiseGateThresholdDb = useSettingsStore((s) => s.inputNoiseGateThresholdDb);

  // Appearance — mirror the persisted chatFontSize preference into the
  // `--concord-chat-font-size` CSS variable so `.concord-message-body`
  // picks it up without every <MessageContent> needing to re-render.
  // Runs once on mount (with the hydrated value from localStorage) and
  // again whenever the user moves the slider in Settings → Appearance.
  const chatFontSize = useSettingsStore((s) => s.chatFontSize);
  const themePreset = useSettingsStore((s) => s.themePreset);
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.style.setProperty(
      "--concord-chat-font-size",
      `${chatFontSize}px`,
    );
  }, [chatFontSize]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute("data-theme", themePreset);
  }, [themePreset]);

  // Mirror the theme's surface colour into the <meta name="theme-color">
  // tag so mobile browser chrome matches the active palette. The
  // runtime favicon rewrite that used to live here has been removed:
  // the tab icon now comes exclusively from the PNG links declared
  // in index.html (regenerated from the raster master by the branding
  // pipeline). That way changing logo.png propagates to the tab icon
  // without any JS participation.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const styles = window.getComputedStyle(document.documentElement);
    const surface = styles.getPropertyValue("--color-surface").trim() || "#0c0e11";
    const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (themeMeta) themeMeta.content = surface;
  }, [themePreset]);

  // TV mode: set the data-tv attribute on <html> so all TV CSS rules
  // in styles/tv.css and the focus ring styles in index.css activate.
  // Removed when the flag flips false (e.g. window resize in dev tools).
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (isTV) {
      document.documentElement.setAttribute("data-tv", "true");
    } else {
      document.documentElement.removeAttribute("data-tv");
    }
    return () => {
      document.documentElement.removeAttribute("data-tv");
    };
  }, [isTV]);

  useEffect(() => {
    restoreSession();
  }, [restoreSession]);

  // Handle ?invite=TOKEN auto-join for logged-in users
  useEffect(() => {
    if (!isLoggedIn || !accessToken || inviteHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const inviteToken =
      params.get("invite") || sessionStorage.getItem(INVITE_STORAGE_KEY);
    if (!inviteToken) return;

    inviteHandled.current = true;

    (async () => {
      try {
        const result = await redeemInvite(inviteToken, accessToken);
        // Only clear after successful redemption
        sessionStorage.removeItem(INVITE_STORAGE_KEY);
        const url = new URL(window.location.href);
        url.searchParams.delete("invite");
        window.history.replaceState({}, "", url.toString());

        if (result.status === "already_member") {
          addToast(`Already a member of ${result.server_name}`, "info");
        } else {
          addToast(`Joined ${result.server_name}!`, "success");
        }
        await loadServers(accessToken);
        setActiveServer(result.server_id);
      } catch (err) {
        // Don't clear the invite — if the session is stale and the user
        // gets logged out, LoginForm can still pick it up from sessionStorage
        addToast(
          err instanceof Error ? err.message : "Failed to redeem invite",
        );
      }
    })();
  }, [isLoggedIn, accessToken, loadServers, setActiveServer, addToast]);

  // Track whether we're in a page unload so we can skip the disconnect handler
  // and preserve the voice session for auto-reconnect after refresh.
  const isUnloadingRef = useRef(false);

  const handleVoiceDisconnect = useCallback(() => {
    if (isUnloadingRef.current) return; // page refreshing — keep session for reconnect
    voiceDisconnect();
  }, [voiceDisconnect]);

  const handleVoiceError = useCallback((error: Error) => {
    console.error("LiveKit connection error:", error);
    addToast(`Voice failed: ${classifyVoiceError(error)}`, "error");
    voiceDisconnect();
  }, [voiceDisconnect, addToast]);

  const handleMediaDeviceFailure = useCallback(() => {
    console.warn("LiveKit media device failure — continuing without mic");
    addToast("Microphone unavailable — you'll join muted", "info");
  }, [addToast]);

  // Warn user before closing/refreshing if voice is active
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      showBootSplash();
      isUnloadingRef.current = true;
      if (useVoiceStore.getState().connected) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // One-shot orphan-room cleanup. Runs the first time a user logs in
  // on this browser after the fix landed; leaves any local-homeserver
  // rooms they're still joined to but which aren't part of any
  // Concord-managed server. These are ghosts from deleted servers
  // that flood the sidebar otherwise. Guarded by a per-user
  // localStorage flag so it never runs twice.
  const cleanupHandled = useRef(false);
  const cleanupUserId = useAuthStore((s) => s.userId);
  useEffect(() => {
    if (!isLoggedIn || !cleanupUserId || cleanupHandled.current) return;
    const flagKey = `concord_orphan_cleanup_v1:${cleanupUserId}`;
    if (typeof window !== "undefined" && window.localStorage.getItem(flagKey)) {
      cleanupHandled.current = true;
      return;
    }
    const client = useAuthStore.getState().client;
    if (!client) return;
    cleanupHandled.current = true;

    (async () => {
      // Let the Matrix client finish its initial sync before we start
      // leaving rooms — leaveOrphanRooms reads `client.getRooms()` and
      // we want the full joined-room set, not whatever happened to be
      // in the cache half a second after login. 3 seconds is plenty on
      // a warm client and harmless on a cold one (we only run once
      // per user ever).
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const left = await useServerStore
          .getState()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .leaveOrphanRooms(client as any);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(flagKey, String(Date.now()));
        }
        if (left.length > 0) {
          addToast(
            `Cleaned up ${left.length} ghost room${left.length === 1 ? "" : "s"} from deleted servers`,
            "success",
          );
        }
      } catch (err) {
        console.warn("Orphan room cleanup failed:", err);
      }
    })();
  }, [isLoggedIn, cleanupUserId, addToast]);

  // Auto-reconnect to voice after page refresh.
  // Retries up to MAX_RECONNECT_ATTEMPTS with exponential backoff
  // (1s, 2s, 4s) before giving up and clearing the pending session.
  // Routes through joinVoiceSession() so the implementation is shared
  // with the manual-join path — both paths hold the same connect-attempt
  // lock so they can't run concurrently.
  const voiceReconnectHandled = useRef(false);
  useEffect(() => {
    if (!isLoggedIn || !accessToken || voiceReconnectHandled.current) return;
    if (voiceConnected) return; // already connected

    const session = getPendingVoiceSession();
    if (!session) return;

    voiceReconnectHandled.current = true;

    const attemptReconnect = async (attempt: number): Promise<void> => {
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        console.warn(`Voice reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts`);
        clearPendingVoiceSession();
        useVoiceStore.getState().setConnectionState("failed");
        addToast("Voice reconnection failed. Join manually when ready.", "error");
        return;
      }

      if (attempt > 0) {
        const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        useVoiceStore.getState().incrementReconnectAttempt();
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        await joinVoiceSession({
          roomId: session.channelId,
          channelName: session.channelName,
          serverId: session.serverId,
          accessToken,
          serverName: session.serverName ?? null,
          returnChannelId: session.returnChannelId ?? null,
          returnChannelName: session.returnChannelName ?? null,
          reconnecting: attempt > 0,
        });

        // Restore the associated text channel when we have one.
        setActiveServer(session.serverId);
        useServerStore.getState().setActiveChannel(
          session.returnChannelId ?? session.channelId,
        );
      } catch (err) {
        console.error(`Voice reconnect attempt ${attempt + 1} failed:`, err);
        return attemptReconnect(attempt + 1);
      }
    };

    attemptReconnect(0);
  }, [isLoggedIn, accessToken, voiceConnected, addToast]);

  // The launch splash is a curtain: the app mounts and does its work
  // underneath while the splash covers it. The splash is isolated into
  // its own GPU compositor layer via CSS in index.html so app-side
  // render activity (auth restore, store subscriptions, StrictMode
  // double-mount) can't invalidate the splash's paint and interrupt
  // the animated WebP.
  // Stabilize the onDone callback reference. Inline arrow functions
  // create a new ref every render of App, which flips the dep array
  // of LaunchAnimation's gate-check useEffect on every parent render.
  // The gate inside short-circuits, but if anything in the dep chain
  // ever causes a setState->re-render cycle, the unstable ref turns
  // it into an infinite loop. Memoizing keeps the dep stable.
  const handleLaunchDone = useCallback(() => setLaunchDone(true), []);
  // Native builds get a longer splash-visibility floor so the
  // animation plays as a proper launch animation rather than a
  // sub-second flash. Web sessions keep the brief 1.5s floor so
  // the chat is in the user's face fast; native users have a real
  // "I just opened the app" moment that the animation should fill.
  const launchMinDurationMs = isTauri ? 3000 : 1500;
  const launchOverlay = !launchDone ? (
    <LaunchAnimation
      isLoading={isLoading}
      onDone={handleLaunchDone}
      minDurationMs={launchMinDurationMs}
    />
  ) : null;

  // Public submit page — no auth required
  const path = window.location.pathname;
  if (path.startsWith("/submit/")) {
    const webhookId = path.slice("/submit/".length);
    return (
      <>
        <SubmitPage webhookId={webhookId} />
        <MarkReady />
        {launchOverlay}
      </>
    );
  }

  // INS-050: Docker first-boot Host/Join picker.
  // Show while we're still checking, or when the picker is actively displayed.
  if (dockerBootState === "checking") {
    // NOT a terminal screen — splash must stay up. No <MarkReady />.
    return (
      <>
        <div className="h-full w-full bg-surface mesh-background" aria-hidden="true" />
        {launchOverlay}
      </>
    );
  }

  if (dockerBootState === "pending") {
    return (
      <>
        <DockerFirstBootScreen
          instanceDomain={instanceDomain}
          onHost={() => setDockerBootState("done")}
          onJoin={() => setDockerBootState("join")}
        />
        <MarkReady />
        {launchOverlay}
      </>
    );
  }

  if (dockerBootState === "join") {
    return (
      <>
        <ServerPickerScreen
          onConnected={() => {
            setDockerBootState("done");
            setServerConnected(true);
          }}
        />
        <MarkReady />
        {launchOverlay}
      </>
    );
  }

  if (isLoading) {
    // NOT a terminal screen — auth restore is still in flight.
    // Splash must stay up. No <MarkReady />.
    return (
      <>
        <div className="h-full w-full bg-surface mesh-background" aria-hidden="true" />
        {launchOverlay}
      </>
    );
  }

  // Native installs drop straight into ChatLayout — no Welcome, no
  // wizard, no LoginForm on first launch. The local porch is the
  // user's device-local source; it's intrinsic, requires no account,
  // and is reachable the moment the libp2p swarm comes up. Matrix
  // accounts are only created the moment the user tries to add a
  // remote auth-required source (Matrix homeserver, peer Concord),
  // and that flow has its own embedded sign-in surface.
  //
  // Web builds still route through the existing ServerPickerScreen +
  // LoginForm because docker stacks always have an external homeserver
  // and the browser entry point has no local porch to land in.
  if (!isTauri) {
    if (!serverConnected) {
      return (
        <>
          <ServerPickerScreen onConnected={() => setServerConnected(true)} />
          <MarkReady />
          {launchOverlay}
        </>
      );
    }
    if (!isLoggedIn) {
      return (
        <>
          <LoginForm />
          <MarkReady />
          {launchOverlay}
        </>
      );
    }
  }

  // NOTE: <MarkReady /> intentionally NOT here. ChatLayout is the
  // logged-in path; data loads cascade in (servers → channels →
  // messages) AFTER the shell mounts. Dropping MarkReady at mount
  // dismisses the splash while the user can still see channel tiles
  // and messages popping into place. ChatLayout owns its own
  // MarkReady call gated on its initial-data loaded signal — see
  // the useEffect near the bottom of ChatLayout that watches
  // `serversLoaded`.
  const shellContent = (
    <div className="h-full w-full min-h-0 min-w-0 flex flex-col overflow-hidden">
      <div className="flex-1 min-h-0">
        <ChatLayout />
      </div>
      <VoiceConnectionBar />
      <DirectInviteBanner />
    </div>
  );

  return (
    <>
      <ErrorBoundary>
        {voiceConnected && voiceToken && livekitUrl ? (
          <LiveKitRoom
            token={voiceToken}
            serverUrl={livekitUrl}
            connectOptions={{
              autoSubscribe: true,
              ...(iceServers.length > 0 && {
                rtcConfig: {
                  iceServers: [
                    { urls: "stun:stun.l.google.com:19302" },
                    ...iceServers,
                  ],
                },
              }),
            }}
            audio={
              micGranted && !isDesktopMode()
                ? buildLiveKitAudioCaptureOptions({
                    masterInputVolume,
                    preferredInputDeviceId,
                    echoCancellation,
                    noiseSuppression,
                    autoGainControl,
                    inputNoiseGateEnabled,
                    inputNoiseGateThresholdDb,
                  })
                : false
            }
            video={false}
            options={{
              // Do NOT set ``webAudioMix: true``. It was added in v0.2.4 on
              // a wrong premise (it is NOT required for the local-mic
              // processor — ``Room.acquireAudioContext`` always creates a
              // room AudioContext, and both ``LocalParticipant.createTracks``
              // and ``publishOrRepublishTrack`` call
              // ``LocalAudioTrack.setAudioContext`` unconditionally). Its
              // actual effect is to also propagate the room AudioContext to
              // every REMOTE audio track — which then hits
              // ``RemoteAudioTrack.attach``'s ``connectWebAudio`` branch and
              // pipes the remote stream through ``ctx.destination`` in
              // PARALLEL with our ``CustomAudioRenderer`` Tier 2 cloned-
              // track chain. Two simultaneous outputs of the same track
              // create comb-filter coloration that users perceive as a
              // tinny / "two streams overlapping" sound. Leave it off and
              // let CustomAudioRenderer be the sole remote-playback path.
              audioCaptureDefaults: {
                ...buildLiveKitAudioCaptureOptions({
                  masterInputVolume,
                  preferredInputDeviceId,
                  echoCancellation,
                  noiseSuppression,
                  autoGainControl,
                  inputNoiseGateEnabled,
                  inputNoiseGateThresholdDb,
                }),
              },
            }}
            onDisconnected={handleVoiceDisconnect}
            onError={handleVoiceError}
            onMediaDeviceFailure={handleMediaDeviceFailure}
            style={{ display: "contents" }}
          >
            <CustomAudioRenderer />
            {/* Issue E (2026-04-18): floating picture-in-picture tiles so
             *  camera/screen streams stay visible when the user navigates
             *  away from the voice channel. Renders null when the user is
             *  viewing the voice channel's docked UI. */}
            <FloatingVideoTiles />
            {shellContent}
          </LiveKitRoom>
        ) : (
          shellContent
        )}
        <ToastContainer />
      </ErrorBoundary>
      {launchOverlay}
    </>
  );
}

import { useEffect, useRef, useCallback, useState } from "react";
import { LiveKitRoom } from "@livekit/components-react";
import { useAuthStore } from "./stores/auth";
import { useServerStore } from "./stores/server";
import { useToastStore } from "./stores/toast";
import { useVoiceStore, getPendingVoiceSession, clearPendingVoiceSession, MAX_RECONNECT_ATTEMPTS, RECONNECT_BASE_DELAY_MS } from "./stores/voice";
import { useSettingsStore } from "./stores/settings";
import { useServerConfigStore } from "./stores/serverConfig";
import { isDesktopMode, getHomeserverUrl } from "./api/serverUrl";
import { usePlatform } from "./hooks/usePlatform";
import { useServitudeLifecycle } from "./hooks/useServitudeLifecycle";
import { computeInitialServerConnected } from "./serverPickerGate";
import { redeemInvite, getInstanceInfo } from "./api/concord";
import { getVoiceToken } from "./api/livekit";
import { showBootSplash } from "./bootSplash";
import { LoginForm } from "./components/auth/LoginForm";
import { ServerPickerScreen } from "./components/auth/ServerPickerScreen";
import { DockerFirstBootScreen } from "./components/auth/DockerFirstBootScreen";
import { Welcome } from "./components/Welcome";
import { useSourcesStore } from "./stores/sources";
import { SubmitPage } from "./components/public/SubmitPage";
import { ChatLayout } from "./components/layout/ChatLayout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LaunchAnimation } from "./components/LaunchAnimation";
import { MarkReady } from "./components/MarkReady";
import { ToastContainer } from "./components/ui/Toast";
import { VoiceConnectionBar } from "./components/voice/VoiceConnectionBar";
import { DirectInviteBanner } from "./components/DirectInviteBanner";
import { CustomAudioRenderer } from "./components/voice/CustomAudioRenderer";
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
    addToast(`Voice failed: ${error.message}`, "error");
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
  const voiceReconnectHandled = useRef(false);
  const voiceConnect = useVoiceStore((s) => s.connect);
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
        useVoiceStore.getState().setConnectionState("reconnecting");
        useVoiceStore.getState().incrementReconnectAttempt();
        await new Promise((r) => setTimeout(r, delay));
      } else {
        useVoiceStore.getState().setConnectionState("connecting");
      }

      try {
        // Request mic permission (guard for webviews where mediaDevices
        // may be undefined outside a secure context).
        let micGrantedLocal = false;
        if (navigator.mediaDevices?.getUserMedia) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach((t) => t.stop());
            micGrantedLocal = true;
          } catch {
            // Continue without mic
          }
        }

        const result = await getVoiceToken(session.channelId, accessToken);

        // Same well-known-first resolution as VoiceChannel.tsx.
        // Trailing slash is critical — see VoiceChannel.tsx comment.
        const wkLivekit = useServerConfigStore.getState().config?.livekit_url;
        const rawUrl = wkLivekit
          || result.livekit_url
          || `${getHomeserverUrl().replace(/^http/, "ws")}/livekit/`;
        const lkUrl = rawUrl.endsWith("/") ? rawUrl : `${rawUrl}/`;

        voiceConnect({
          token: result.token,
          livekitUrl: lkUrl,
          iceServers: result.ice_servers?.length ? result.ice_servers : [],
          serverId: session.serverId,
          serverName: session.serverName ?? null,
          channelId: session.channelId,
          channelName: session.channelName,
          roomName: session.roomName,
          returnChannelId: session.returnChannelId ?? null,
          returnChannelName: session.returnChannelName ?? null,
          micGranted: micGrantedLocal,
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
  }, [isLoggedIn, accessToken, voiceConnected, voiceConnect, addToast]);

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
  const launchOverlay = !launchDone ? (
    <LaunchAnimation isLoading={isLoading} onDone={handleLaunchDone} />
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

  if (!serverConnected) {
    // W2-05 / INS-058: native first launch with no sources → Welcome.
    // Existing-source path (e.g. user previously connected on a fresh
    // install) falls through to the legacy ServerPickerScreen so the
    // already-locked-in W-04 test plus existing INS-027 flow keep
    // working. The Welcome → onboarding flows route back through
    // `setServerConnected(true)` once a source is persisted.
    const hasAnySource =
      isTauri && useSourcesStore.getState().sources.length > 0;
    if (isTauri && !hasAnySource) {
      return (
        <>
          <Welcome onConnected={() => setServerConnected(true)} />
          <MarkReady />
          {launchOverlay}
        </>
      );
    }
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
              // webAudioMix=true makes LiveKit set up an AudioContext at
              // room level, so later ``track.setAudioContext(ctx)`` (which
              // fires AFTER createLocalTracks in 26604 of the esm bundle)
              // has something to hand the track. It does NOT help the
              // createLocalTracks → setProcessor path that bit us in the
              // three-toast pileup — see buildLiveKitAudioCaptureOptions
              // for why we don't attach the processor via capture defaults
              // at all. Keeping webAudioMix on is still useful for the
              // per-track audioContext pipeline once attachments land, and
              // makes setSinkId-style output device switching work.
              webAudioMix: true,
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

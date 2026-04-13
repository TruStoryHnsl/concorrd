import { useEffect, useRef, useCallback, useState } from "react";
import { LiveKitRoom } from "@livekit/components-react";
import { useAuthStore } from "./stores/auth";
import { useServerStore } from "./stores/server";
import { useSourcesStore } from "./stores/sources";
import { useToastStore } from "./stores/toast";
import { useVoiceStore, getPendingVoiceSession, clearPendingVoiceSession, MAX_RECONNECT_ATTEMPTS, RECONNECT_BASE_DELAY_MS } from "./stores/voice";
import { useSettingsStore } from "./stores/settings";
import { useServerConfigStore } from "./stores/serverConfig";
import { isDesktopMode, getHomeserverUrl } from "./api/serverUrl";
import { usePlatform } from "./hooks/usePlatform";
import { computeInitialServerConnected } from "./serverPickerGate";
import { redeemInvite } from "./api/concord";
import { getVoiceToken } from "./api/livekit";
import { LoginForm } from "./components/auth/LoginForm";
import { ServerPickerScreen } from "./components/auth/ServerPickerScreen";
import { SubmitPage } from "./components/public/SubmitPage";
import { ChatLayout } from "./components/layout/ChatLayout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LaunchAnimation } from "./components/LaunchAnimation";
import { ToastContainer } from "./components/ui/Toast";
import { VoiceConnectionBar } from "./components/voice/VoiceConnectionBar";
import { DirectInviteBanner } from "./components/DirectInviteBanner";
import { CustomAudioRenderer } from "./components/voice/CustomAudioRenderer";

// Capture invite token immediately at module load — before React mounts,
// before session restoration, before anything can clear the URL.
const INVITE_STORAGE_KEY = "concord_pending_invite";
const urlParams = new URLSearchParams(window.location.search);
const initialInviteToken = urlParams.get("invite");
if (initialInviteToken) {
  sessionStorage.setItem(INVITE_STORAGE_KEY, initialInviteToken);
}

export { INVITE_STORAGE_KEY };

function buildConcordFavicon(primary: string, secondary: string): string {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
      <defs>
        <mask id="primary-mask">
          <rect x="0" y="0" width="512" height="512" fill="white" />
          <circle cx="192" cy="320" r="168" fill="black" />
          <rect x="0" y="0" width="512" height="256" fill="white" />
        </mask>
        <mask id="secondary-mask">
          <rect x="0" y="0" width="512" height="512" fill="white" />
          <circle cx="320" cy="192" r="168" fill="black" />
          <rect x="0" y="256" width="512" height="256" fill="white" />
        </mask>
      </defs>
      <g mask="url(#primary-mask)">
        <circle cx="320" cy="192" r="120" fill="none" stroke="${primary}" stroke-width="48" />
      </g>
      <circle cx="288" cy="172" r="28" fill="${primary}" />
      <g mask="url(#secondary-mask)">
        <circle cx="192" cy="320" r="120" fill="none" stroke="${secondary}" stroke-width="48" />
      </g>
      <circle cx="224" cy="340" r="28" fill="${secondary}" />
    </svg>
  `.trim();
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export default function App() {
  // Desktop/native mode: require a server picker pass before anything
  // else. Native apps ALWAYS start hollow — no pre-configured server,
  // no "implicit" target. The picker is the first thing a Tauri build
  // sees on first launch, and the only way to skip it is to have
  // completed the picker in a previous session (persisted via the
  // zustand `serverConfig` store, NOT via the legacy Tauri
  // plugin-store `server_url` slot, which has been retired because it
  // could silently skip the picker forever if a stale value leaked
  // through Syncthing or a prior install).
  //
  // Mobile web also goes through the picker — it has no implicit
  // origin-based server association either. Desktop web (non-Tauri,
  // non-mobile) is the one case that boots straight into the chat
  // shell because its origin IS the server.
  const hasNewConfig = useServerConfigStore((s) => s.config !== null);
  const { isMobile, isTV } = usePlatform();
  const [serverConnected, setServerConnected] = useState(() =>
    computeInitialServerConnected({
      isDesktop: isDesktopMode(),
      isMobile,
      hasNewConfig,
    }),
  );

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

  useEffect(() => {
    if (typeof document === "undefined") return;
    const styles = window.getComputedStyle(document.documentElement);
    const primary = styles.getPropertyValue("--color-logo-primary").trim() || "#a4a5ff";
    const secondary = styles.getPropertyValue("--color-logo-secondary").trim() || "#afefdd";
    const surface = styles.getPropertyValue("--color-surface").trim() || "#0c0e11";
    const faviconHref = buildConcordFavicon(primary, secondary);

    document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]').forEach((link) => {
      link.href = faviconHref;
      link.type = "image/svg+xml";
    });

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
      if (useVoiceStore.getState().connected) {
        isUnloadingRef.current = true;
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
          channelId: session.channelId,
          channelName: session.channelName,
          roomName: session.roomName,
          micGranted: micGrantedLocal,
        });

        // Navigate back to the voice channel
        setActiveServer(session.serverId);
        useServerStore.getState().setActiveChannel(session.channelId);
      } catch (err) {
        console.error(`Voice reconnect attempt ${attempt + 1} failed:`, err);
        return attemptReconnect(attempt + 1);
      }
    };

    attemptReconnect(0);
  }, [isLoggedIn, accessToken, voiceConnected, voiceConnect, addToast]);

  // Compose the launch splash overlay once so every early return
  // path below can reuse it. Must be emitted as a Fragment sibling
  // of the actual screen so it stays layered on top via its own
  // position:fixed styling.
  const launchOverlay = !launchDone ? (
    <LaunchAnimation
      isLoading={isLoading}
      onDone={() => setLaunchDone(true)}
    />
  ) : null;

  // Hollow-shell-first contract (2026-04-10 user spec): native builds
  // ALWAYS render the full ChatLayout on boot, regardless of whether a
  // server has been picked or the user is logged in. The "add source"
  // flow lives inside the Sources column's `+` tile and opens the
  // ServerPickerScreen as a modal overlay. The old boot-time gate
  // (`if (!serverConnected) return <ServerPickerScreen />`) has been
  // retired — the picker is no longer a pre-shell modal.
  //
  // `addSourceModalOpen` drives the modal. ChatLayout's SourcesPanel
  // calls back into `openAddSourceModal` when the user clicks `+`.
  //
  // `serverConnected` and `setServerConnected` remain as state so the
  // existing modal-success path can still flip App out of any transient
  // states — but they no longer gate ChatLayout visibility.
  // Cold-launch picker: native builds with zero connected sources
  // auto-open the picker modal on first render. The user can either
  // pick one of the source types (Concord / Matrix / Discord / Host)
  // or hit Skip to dismiss and reach the hollow shell. Returning
  // users (with at least one persisted source) skip this auto-open
  // and go straight to their existing shell.
  //
  // The auto-open lives in the useState initializer so it only fires
  // on the first render of this component instance. Subsequent
  // re-opens happen via the explicit `+ Add Source` tile in the
  // Sources column.
  const [addSourceModalOpen, setAddSourceModalOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    if (!("__TAURI_INTERNALS__" in window)) return false;
    return useSourcesStore.getState().sources.length === 0;
  });
  const openAddSourceModal = useCallback(() => setAddSourceModalOpen(true), []);
  // Cancelling the modal must also reset `serverConnected` back to
  // `false`. Without this, the modal's internal ternary —
  //   !isLoggedIn && !serverConnected → ServerPickerScreen
  //   !isLoggedIn                     → LoginForm
  // — would open directly to LoginForm on the NEXT `+` tile click,
  // because the earlier picker run had already flipped the flag true.
  // Resetting on close means every re-open starts at the picker,
  // which is what the user expects when they abort mid-wizard and
  // come back later.
  const closeAddSourceModal = useCallback(() => {
    setAddSourceModalOpen(false);
    setServerConnected(false);
  }, []);

  // Auto-close the add-source modal once the user is authenticated.
  // `isLoggedIn` flips true from inside LoginForm's successful-login
  // path. This effect MUST be declared before the early returns below
  // (`if (isLoading) return ...`, `if (path.startsWith("/submit/"))
  // return ...`) — React's rules of hooks require a consistent hook
  // call order between renders, and an early return followed by a
  // useEffect trips "Rendered more hooks than during the previous
  // render" the instant `isLoading` flips, which ErrorBoundary catches
  // and renders as a blank surface.
  useEffect(() => {
    if (isLoggedIn && addSourceModalOpen) {
      closeAddSourceModal();
    }
  }, [isLoggedIn, addSourceModalOpen, closeAddSourceModal]);

  // Public submit page — no auth required
  const path = window.location.pathname;
  if (path.startsWith("/submit/")) {
    const webhookId = path.slice("/submit/".length);
    return (
      <>
        <SubmitPage webhookId={webhookId} />
        {launchOverlay}
      </>
    );
  }

  if (isLoading) {
    // No inline spinner — the LaunchAnimation below handles the
    // "we're booting" affordance uniformly across every platform.
    return (
      <>
        <div className="h-full bg-surface mesh-background" aria-hidden="true" />
        {launchOverlay}
      </>
    );
  }

  // Shell content. Rendered at all times per the hollow-shell-first
  // contract (2026-04-10). The child components — SourcesPanel,
  // ServerSidebar, ChannelSidebar, main content area — each handle
  // their own empty states when there is no source / no server / no
  // authenticated Matrix client, so this tree renders cleanly even
  // during the first-launch hollow state.
  const shellContent = (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-1 min-h-0">
        <ChatLayout onAddSource={openAddSourceModal} />
      </div>
      <VoiceConnectionBar />
      <DirectInviteBanner />
    </div>
  );

  // The "add source" wizard modal. Opened by the `+` tile in
  // SourcesPanel; advances through the existing ServerPickerScreen and
  // (if the user is not already authenticated on the picked instance)
  // the LoginForm. Both sub-components stay fullscreen-shaped but are
  // displayed as a centred overlay inside the modal container. On
  // successful picker connection the flow falls through to LoginForm;
  // when `isLoggedIn` flips true the modal auto-closes via the effect
  // below.
  const addSourceModal = addSourceModalOpen ? (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center">
      <div className="relative w-full h-full overflow-auto">
        <button
          type="button"
          onClick={closeAddSourceModal}
          className="absolute top-4 right-4 z-10 w-10 h-10 rounded-full bg-surface-container hover:bg-surface-container-high flex items-center justify-center transition-colors"
          title="Cancel"
          aria-label="Cancel add source"
        >
          <span className="material-symbols-outlined text-on-surface">close</span>
        </button>
        {/* Wizard stages keyed only on `serverConnected` so the modal
            renders the picker even when the user is already logged in
            on a prior source (add-second-source flow). Previously the
            ternary checked `!isLoggedIn && !serverConnected` which
            fell through to `null` for an already-authed user, leaving
            the modal visually empty. Stage 3 (`serverConnected &&
            isLoggedIn`) is handled by the useEffect above which
            auto-closes the modal. */}
        {!serverConnected ? (
          <ServerPickerScreen
            onConnected={() => setServerConnected(true)}
            onSkip={closeAddSourceModal}
          />
        ) : !isLoggedIn ? (
          <LoginForm />
        ) : null}
      </div>
    </div>
  ) : null;

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
            audio={micGranted && !isDesktopMode()}
            video={false}
            options={{
              audioCaptureDefaults: {
                echoCancellation,
                noiseSuppression,
                autoGainControl,
                ...(preferredInputDeviceId && { deviceId: preferredInputDeviceId }),
              },
            }}
            onDisconnected={handleVoiceDisconnect}
            onError={handleVoiceError}
            onMediaDeviceFailure={handleMediaDeviceFailure}
            style={{ display: "contents" }}
          >
            <CustomAudioRenderer />
            {shellContent}
          </LiveKitRoom>
        ) : (
          shellContent
        )}
        {addSourceModal}
        <ToastContainer />
      </ErrorBoundary>
      {launchOverlay}
    </>
  );
}

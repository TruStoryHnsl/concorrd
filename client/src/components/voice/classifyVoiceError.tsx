/**
 * classifyVoiceError — rewrite raw LiveKit / browser-WebRTC error
 * messages into something that's actually useful given which build
 * we're running in.
 *
 * The thing this exists to fix: LiveKit's SDK throws "LiveKit doesn't
 * seem to be supported on this browser. Try to update your browser
 * and make sure no browser extensions are disabling webRTC." That
 * message is fine in Chrome / Firefox; it is **actively misleading**
 * in a Tauri shell where:
 *   - the user has no "browser" to update,
 *   - the WebKitGTK runtime is what's incomplete, and
 *   - the right move is usually to use the libp2p mesh path (when
 *     paired with a peer that supports it) or to call from a real
 *     browser tab pointed at the docker stack.
 *
 * The classifier:
 *   1. Detects the Tauri shell via `__TAURI_INTERNALS__`.
 *   2. Looks for the unsupported-browser marker phrasing in the raw
 *      message.
 *   3. Rewrites to a build-aware message if we matched both.
 *   4. Falls through to the raw message for every other error so we
 *      don't accidentally hide useful diagnostics.
 */

function isTauriShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const LIVEKIT_BROWSER_UNSUPPORTED_RE =
  /LiveKit\s+doesn'?t\s+seem\s+to\s+be\s+supported\s+on\s+this\s+browser/i;

export function classifyVoiceError(error: Error): string {
  const raw = error.message ?? String(error);

  if (LIVEKIT_BROWSER_UNSUPPORTED_RE.test(raw)) {
    if (isTauriShell()) {
      return (
        "WebRTC isn't fully available in this native build's WebView " +
        "runtime. You can still receive paired-peer mesh calls " +
        "(Settings → Connections → Peer connections). To join LiveKit-" +
        "hosted voice rooms, open the same instance in a desktop " +
        "browser tab."
      );
    }
    // Real browser. Keep the SDK's message — it's accurate there.
    return raw;
  }

  return raw;
}

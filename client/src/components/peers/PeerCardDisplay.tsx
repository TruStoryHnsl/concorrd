/**
 * PeerCardDisplay (Phase 5 — peer pairing).
 *
 * Shows the user's own peer card so another install can pair with this
 * one. Renders three artefacts in order:
 *   1. A QR code encoding the `concord://peer/<base64url>` deeplink URL.
 *   2. The same URL as a click-to-copy monospaced string.
 *   3. A "Post to Matrix room" affordance that drops a peer-card event
 *      into a joined Matrix room so other installs already in that room
 *      can pick it up via the `useMatrixPeerCards` hook.
 *
 * The card is composed from two existing sources: the Phase 2
 * `useIdentityStore.publicKeyHex` (Ed25519 fingerprint root) and the
 * Phase 3 `useIdentityStore.swarmPeerId` / `swarmMultiaddrs` (libp2p
 * surface). If any of those are missing — typical for a fresh install
 * or while the swarm is still spinning up — we render a "preparing your
 * card…" placeholder instead of a half-empty card.
 *
 * Web build: same pattern as `PeerIdentitySection` — we render a
 * native-only placeholder block so the section still has visible
 * structure on the web UI.
 */

import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import type { MatrixClient, Room } from "matrix-js-sdk";
import { EventType } from "matrix-js-sdk";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events";
import { useIdentityStore } from "../../stores/identity";
import { useAuthStore } from "../../stores/auth";
import { useToastStore } from "../../stores/toast";
import { isTauri } from "../../api/servitude";
import {
  encodeToDeeplink,
  encodeToQrPayload,
  type PeerCard,
} from "../../lib/peerCard";
import { getBrowserIdentity } from "../../libp2p/identity";
import { getBrowserNodeIfStarted } from "../../libp2p/lazyNode";
import { useBrowserLibp2p } from "../../hooks/useBrowserLibp2p";

/**
 * Matrix msgtype we use to broadcast a peer card into a room. The
 * `m.room.message` event type keeps it routable through all standard
 * Matrix infrastructure (federation, retention policies, etc.) while
 * the custom `msgtype` lets receivers detect it without inspecting
 * every body. Listeners live in `useMatrixPeerCards` and the
 * deeplink-handler in `src-tauri/src/lib.rs`.
 */
const PEER_CARD_MSGTYPE = "concord.peer_card";

/**
 * Render a QR code into an inline <img> via the `qrcode` library's
 * `toDataURL` path. We deliberately do NOT use `toCanvas` because a
 * canvas inside React's reconciler is awkward to manage — the data URL
 * just gets handed off as a normal image src and the browser handles
 * the rest.
 */
function useQrDataUrl(payload: string | null): {
  dataUrl: string | null;
  error: string | null;
} {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!payload) {
      setDataUrl(null);
      setError(null);
      return;
    }
    // 300px is enough to scan with a phone at 30+ cm; M-level ECC is the
    // sweet spot between density and damage tolerance for an indoor scan.
    QRCode.toDataURL(payload, {
      margin: 1,
      width: 300,
      errorCorrectionLevel: "M",
    })
      .then((url) => {
        if (cancelled) return;
        setDataUrl(url);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDataUrl(null);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [payload]);

  return { dataUrl, error };
}

/**
 * Tiny modal/dropdown helper for picking a Matrix room to broadcast the
 * card into. Reads the joined-room list straight off the Matrix client
 * via `client.getRooms()` — same source `useRooms()` uses but rendered
 * inline because the dropdown closes immediately on selection and a
 * full hook subscription would be overkill for a one-shot picker.
 */
function MatrixRoomPicker({
  client,
  onPick,
  onCancel,
}: {
  client: MatrixClient;
  onPick: (room: Room) => void;
  onCancel: () => void;
}) {
  const rooms = useMemo(
    () =>
      client
        .getRooms()
        .filter((r) => r.getMyMembership() === "join")
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    [client],
  );

  return (
    <div
      className="absolute right-0 top-full mt-2 z-10 w-72 max-h-72 overflow-y-auto bg-surface-container border border-outline-variant rounded-md shadow-lg"
      role="listbox"
      aria-label="Select a Matrix room"
    >
      {rooms.length === 0 ? (
        <p className="text-xs text-on-surface-variant p-3">
          You're not in any rooms yet.
        </p>
      ) : (
        <ul>
          {rooms.map((room) => (
            <li key={room.roomId}>
              <button
                type="button"
                onClick={() => onPick(room)}
                className="w-full text-left px-3 py-2 hover:bg-surface-container-high text-sm text-on-surface truncate"
                title={room.name ?? room.roomId}
              >
                {room.name ?? room.roomId}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-outline-variant/20 px-3 py-2">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-on-surface-variant hover:text-on-surface"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function PeerCardDisplay() {
  const publicKeyHex = useIdentityStore((s) => s.publicKeyHex);
  const swarmPeerId = useIdentityStore((s) => s.swarmPeerId);
  const swarmMultiaddrs = useIdentityStore((s) => s.swarmMultiaddrs);
  const client = useAuthStore((s) => s.client);
  const addToast = useToastStore((s) => s.addToast);

  const [pickerOpen, setPickerOpen] = useState(false);

  // Phase 9 (browser P2P UI surface): on web, derive the card from the
  // browser libp2p identity + the running libp2p node's multiaddrs.
  //
  // Self-trigger swarm startup. The hook is idempotent; mounting this
  // surface is itself a signal that the user wants to see / share
  // their card. Without the self-trigger, the card stays in
  // "preparing…" forever on any surface that doesn't separately call
  // `useBrowserLibp2p({ enabled: true })`.
  const {
    status: browserLibp2pStatus,
    error: browserLibp2pError,
  } = useBrowserLibp2p({ enabled: true });

  const [browserCard, setBrowserCard] = useState<PeerCard | null>(null);

  useEffect(() => {
    if (isTauri()) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const identity = await getBrowserIdentity();
        const node = await getBrowserNodeIfStarted();
        if (cancelled) return;
        if (!node) {
          // Node not running yet — keep waiting; the hook above
          // (useBrowserLibp2p enabled) is bringing it up.
          setBrowserCard(null);
          return;
        }
        // Browser libp2p nodes typically have ZERO listen multiaddrs:
        // the WebRTC transport is dial-only by design (no inbound
        // dials without a relay), and the WebSockets transport
        // doesn't listen from a tab either. That's not a failure —
        // browsers are clients in the mesh. The card still
        // identifies the peer (peerId + publicKeyHex) so a paired
        // native peer knows who's calling it; the browser dials OUT
        // when it wants to talk to a known peer.
        const multiaddrs = node.getMultiaddrs().map((m) => m.toString());
        setBrowserCard({
          peerId: identity.peerId,
          publicKeyHex: identity.publicKeyHex,
          multiaddrs,
        });
      } catch (err) {
        console.debug(
          "[peer-card-display] browser card refresh failed",
          err,
        );
      }
    };

    void refresh();
    // Poll fast at first so the UI catches the swarm coming online
    // without making the user wait a full 5-second cycle. Then
    // settle into the steady 5s cadence.
    let fastPolls = 0;
    let intervalId: ReturnType<typeof setInterval>;
    const schedule = (delay: number) => {
      intervalId = setInterval(() => {
        void refresh();
        fastPolls += 1;
        if (fastPolls === 10) {
          clearInterval(intervalId);
          schedule(5000);
        }
      }, delay);
    };
    schedule(1000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  // Assemble the public peer card. On native: read from the identity
  // store (Phase 2 + 3). On web: use the browser-derived card above.
  // All three components have to be present and non-empty — a card with
  // no multiaddrs is unreachable and a card with no peerId can't be
  // dialled.
  const card: PeerCard | null = useMemo(() => {
    if (!isTauri()) return browserCard;
    if (!publicKeyHex) return null;
    if (!swarmPeerId) return null;
    if (!swarmMultiaddrs || swarmMultiaddrs.length === 0) return null;
    return {
      peerId: swarmPeerId,
      publicKeyHex,
      multiaddrs: swarmMultiaddrs,
    };
  }, [publicKeyHex, swarmPeerId, swarmMultiaddrs, browserCard]);

  const deeplinkUrl = useMemo(
    () => (card ? encodeToDeeplink(card) : null),
    [card],
  );
  const qrPayload = useMemo(
    () => (card ? encodeToQrPayload(card) : null),
    [card],
  );
  const { dataUrl: qrDataUrl, error: qrError } = useQrDataUrl(qrPayload);

  const handleCopy = async () => {
    if (!deeplinkUrl) return;
    try {
      await navigator.clipboard.writeText(deeplinkUrl);
      addToast("Peer card link copied", "success");
    } catch {
      addToast("Couldn't copy to clipboard");
    }
  };

  const handlePostToRoom = async (room: Room) => {
    if (!card || !client) return;
    setPickerOpen(false);
    try {
      // Custom `msgtype` keeps the event detectable on the receiving
      // side without polluting the message body — see
      // `useMatrixPeerCards`. We deliberately do NOT embed the deeplink
      // URL in `body` (which a federated client without our msgtype
      // handler would render as raw text); instead the `body` is a
      // human-readable label so the worst-case fallback is informative
      // rather than a wall of base64.
      // Custom-msgtype event on `m.room.message` — Matrix permits
      // namespaced custom fields, so the peer-card payload rides
      // alongside the human-readable body. We cast through
      // `RoomMessageEventContent` to satisfy matrix-js-sdk's typed
      // `sendEvent` signature; the SDK passes the content through
      // verbatim so the receiver sees every custom field.
      const content = {
        msgtype: PEER_CARD_MSGTYPE,
        body: "Concord peer card",
        peer_id: card.peerId,
        public_key_hex: card.publicKeyHex,
        multiaddrs: card.multiaddrs,
      } as unknown as RoomMessageEventContent;
      await client.sendEvent(room.roomId, EventType.RoomMessage, content);
      addToast(`Peer card posted to ${room.name ?? room.roomId}`, "success");
    } catch (err) {
      addToast(
        err instanceof Error ? err.message : "Failed to post peer card",
      );
    }
  };

  // ── Card not yet assembled (loading / swarm starting up) ────────
  if (!card) {
    // Surface real status so the user sees what's happening instead
    // of a generic "waiting…" that hides a chunk-load failure or a
    // libp2p init error.
    let detail: string;
    let detailClass = "text-on-surface-variant italic";
    if (!isTauri()) {
      if (browserLibp2pStatus === "starting") {
        detail = "Starting browser swarm…";
      } else if (browserLibp2pStatus === "error") {
        detail = `Swarm start failed: ${browserLibp2pError ?? "unknown error"}`;
        detailClass = "text-error";
      } else if (browserLibp2pStatus === "running") {
        detail = "Browser swarm up — generating your peer card…";
      } else {
        detail = "Preparing your peer card…";
      }
    } else {
      detail = "Preparing your peer card… (waiting for the swarm to come up)";
    }
    return (
      <div
        className="border-t border-outline-variant/15 pt-6 space-y-2"
        data-testid="peer-card-display"
      >
        <h4 className="text-sm font-medium text-on-surface">Your Peer Card</h4>
        <p className={`text-xs ${detailClass}`}>{detail}</p>
      </div>
    );
  }

  return (
    <div
      className="border-t border-outline-variant/15 pt-6 space-y-3"
      data-testid="peer-card-display"
    >
      <div>
        <h4 className="text-sm font-medium text-on-surface">Your Peer Card</h4>
        <p className="text-xs text-on-surface-variant">
          Share this with another Concord install to pair directly without a
          server in the middle.
        </p>
        {/* Phase 9 (browser P2P UI surface): make the ephemeral nature
            of the browser session card explicit so users don't hand it
            to a friend, close the tab, and wonder why pairing fails. */}
        {!isTauri() && (
          <p
            className="text-xs text-on-surface-variant italic"
            data-testid="peer-card-session-subtitle"
          >
            (session card — recipients can dial you while this tab is open)
          </p>
        )}
      </div>

      {/* QR code */}
      <div className="flex justify-center">
        {qrError ? (
          <div className="w-48 h-48 rounded-lg bg-surface-container flex items-center justify-center text-xs text-error p-4 text-center">
            QR render failed: {qrError}
          </div>
        ) : qrDataUrl ? (
          <img
            src={qrDataUrl}
            alt="Peer card QR code"
            className="w-48 h-48 rounded-lg bg-white p-2"
          />
        ) : (
          <div className="w-48 h-48 rounded-lg bg-surface-container animate-pulse" />
        )}
      </div>

      {/* Copyable deeplink */}
      <div className="space-y-1">
        <span className="text-xs text-on-surface-variant">Link</span>
        <div className="flex items-center gap-2 bg-surface-container rounded p-2">
          <span
            className="text-xs text-on-surface-variant font-mono truncate flex-1"
            title={deeplinkUrl ?? ""}
          >
            {deeplinkUrl}
          </span>
          <button
            type="button"
            onClick={handleCopy}
            className="btn-press inline-flex items-center justify-center px-2 py-1 rounded-md text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors"
            aria-label="Copy peer card link"
            title="Copy peer card link"
          >
            <span
              className="material-symbols-outlined text-base leading-none"
              style={{
                fontVariationSettings:
                  '"FILL" 0, "wght" 500, "GRAD" 0, "opsz" 24',
              }}
            >
              content_copy
            </span>
          </button>
        </div>
      </div>

      {/* Post-to-room affordance */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          disabled={!client}
          className="px-4 py-2 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm rounded-md transition-colors"
        >
          Post to Matrix room…
        </button>
        {pickerOpen && client && (
          <MatrixRoomPicker
            client={client}
            onPick={handlePostToRoom}
            onCancel={() => setPickerOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

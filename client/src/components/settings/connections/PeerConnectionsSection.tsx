/**
 * Peer connections (P2P) — Settings → Connections subsection.
 *
 * Moved out of `ProfileTab` 2026-05-30 because peer identity / swarm
 * status / paired peers are connectivity concerns, not user-profile
 * concerns. Lives under `connections/` so the file colocates with the
 * tab that renders it.
 *
 * Section composition:
 *   - `PeerIdentitySection` / `BrowserSessionIdentityRow` — native
 *     fingerprint or web ephemeral session identity (one renders per
 *     `isTauri()`).
 *   - `SwarmStatusSection` / `BrowserSwarmStatusBlock` — live swarm
 *     status (PeerId / Listening on / Peers connected / Last event).
 *   - `PairedPeersSection` — peer card display, Add-a-peer launcher,
 *     known peers list, and (native only) LAN peers subsection.
 *
 * The original ProfileTab.tsx history holds the per-component
 * docstrings preserved verbatim below for ease of git-blame archaeology.
 */

import { useEffect, useState } from "react";
import type { Libp2p } from "@libp2p/interface";

import { useIdentityStore, IDENTITY_ERROR_NATIVE_ONLY } from "../../../stores/identity";
import { useToastStore } from "../../../stores/toast";
import { usePeerStore } from "../../../stores/peerStore";
import { isTauri } from "../../../api/servitude";
import { subscribeToLanPeers, type LanPeer } from "../../../api/lanPeers";
import { getBrowserIdentity } from "../../../libp2p/identity";
import { getBrowserNodeIfStarted } from "../../../libp2p/lazyNode";
import { fingerprintForHex } from "../../../libp2p/fingerprint";

import { PeerCardDisplay } from "../../peers/PeerCardDisplay";
import { PeerCardScanner } from "../../peers/PeerCardScanner";
import { KnownPeersList } from "../../peers/KnownPeersList";

/**
 * Outer wrapper rendered by `UserConnectionsTab`. Bundles the three
 * P2P-status surfaces into one labeled "Peer connections (P2P)" block
 * so the tab's existing connection-card list stays visually grouped
 * separately from the libp2p mesh state.
 */
export function PeerConnectionsSection() {
  return (
    <div
      className="border-t border-outline-variant/20 pt-6 space-y-4"
      data-testid="peer-connections-section"
    >
      <div>
        <h4 className="text-sm font-headline font-semibold text-on-surface">
          Peer connections (P2P)
        </h4>
        <p className="text-xs text-on-surface-variant mt-1">
          Your libp2p swarm identity and the direct peer pairings you've
          collected. Each pairing is server-less — direct device-to-device.
        </p>
      </div>

      <PeerIdentitySection />
      <SwarmStatusSection />
      <PairedPeersSection />
    </div>
  );
}

/**
 * Peer identity surface (Phase 2 — Ed25519 device identity).
 *
 * Renders the fingerprint string returned by the Tauri `peer_identity`
 * command, with a copy-to-clipboard control alongside it. The private key
 * never enters this component — see `../../../stores/identity.ts` and
 * `../../../api/peerIdentity.ts` for the wire-contract guards.
 *
 * Web build (no `__TAURI_INTERNALS__`): renders the per-tab ephemeral
 * browser identity via `BrowserSessionIdentityRow`.
 */
export function PeerIdentitySection() {
  const fingerprint = useIdentityStore((s) => s.fingerprint);
  const isLoading = useIdentityStore((s) => s.isLoading);
  const error = useIdentityStore((s) => s.error);
  const addToast = useToastStore((s) => s.addToast);

  useEffect(() => {
    // Pull `load` off the store imperatively so it isn't a hook dep — the
    // function identity is stable inside zustand but lint can't see that
    // and we don't want re-fires if any state slice mutates.
    useIdentityStore.getState().load();
  }, []);

  const handleCopy = async () => {
    if (!fingerprint) return;
    try {
      await navigator.clipboard.writeText(fingerprint);
      addToast("Peer fingerprint copied", "success");
    } catch {
      addToast("Couldn't copy to clipboard", "error");
    }
  };

  // Phase 9 (browser P2P UI surface): on web, render the per-tab
  // ephemeral identity instead of a native-only placeholder.
  if (!isTauri() || error === IDENTITY_ERROR_NATIVE_ONLY) {
    return <BrowserSessionIdentityRow handleCopy={handleCopy} />;
  }

  return (
    <div className="flex items-center justify-between py-2 gap-3">
      <span className="text-sm text-on-surface-variant">Peer Identity</span>
      <div className="flex items-center gap-2 min-w-0">
        {isLoading && !fingerprint ? (
          <span className="text-sm text-on-surface-variant italic">Loading…</span>
        ) : error && !fingerprint ? (
          <span
            className="text-sm text-error truncate"
            title={error}
          >
            Failed to load
          </span>
        ) : fingerprint ? (
          <>
            <span
              className="text-sm text-on-surface-variant font-mono truncate"
              title={fingerprint}
            >
              {fingerprint}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              className="btn-press inline-flex items-center justify-center px-2 py-1 rounded-md text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors"
              aria-label="Copy peer fingerprint"
              title="Copy peer fingerprint"
            >
              <span
                className="material-symbols-outlined text-base leading-none"
                style={{ fontVariationSettings: '"FILL" 0, "wght" 500, "GRAD" 0, "opsz" 24' }}
              >
                content_copy
              </span>
            </button>
          </>
        ) : (
          <span className="text-sm text-on-surface-variant italic">—</span>
        )}
      </div>
    </div>
  );
}

/**
 * Phase 9 (browser P2P UI surface) — web variant of the peer-identity
 * row. Shows the per-tab ephemeral Ed25519 fingerprint derived from the
 * browser libp2p identity, plus a tooltip explaining the ephemeral
 * nature.
 */
export function BrowserSessionIdentityRow(_props: { handleCopy: () => void }) {
  void _props;
  const addToast = useToastStore((s) => s.addToast);
  const [localFingerprint, setLocalFingerprint] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const identity = await getBrowserIdentity();
        const fp = await fingerprintForHex(identity.publicKeyHex);
        if (!cancelled) setLocalFingerprint(fp);
      } catch (err) {
        if (!cancelled) {
          setIdentityError(
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLocalCopy = async () => {
    if (!localFingerprint) return;
    try {
      await navigator.clipboard.writeText(localFingerprint);
      addToast("Session fingerprint copied", "success");
    } catch {
      addToast("Couldn't copy to clipboard", "error");
    }
  };

  const tooltipText =
    "Your browser tab gets a fresh peer identity each load. " +
    "Native installs (Settings → About → Download) get a persistent " +
    "identity tied to your install. To carry the same identity across " +
    "reloads, install Concord.";

  return (
    <div className="flex items-center justify-between py-2 gap-3">
      <div className="flex items-center gap-1.5">
        <span className="text-sm text-on-surface-variant">
          Session identity (ephemeral)
        </span>
        <span
          className="material-symbols-outlined text-sm leading-none text-on-surface-variant cursor-help"
          style={{
            fontVariationSettings:
              '"FILL" 0, "wght" 500, "GRAD" 0, "opsz" 20',
          }}
          title={tooltipText}
          aria-label={tooltipText}
          role="img"
        >
          info
        </span>
      </div>
      <div className="flex items-center gap-2 min-w-0">
        {identityError ? (
          <span
            className="text-sm text-error truncate"
            title={identityError}
          >
            Failed to load
          </span>
        ) : localFingerprint ? (
          <>
            <span
              className="text-sm text-on-surface-variant font-mono truncate"
              title={localFingerprint}
            >
              {localFingerprint}
            </span>
            <button
              type="button"
              onClick={handleLocalCopy}
              className="btn-press inline-flex items-center justify-center px-2 py-1 rounded-md text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors"
              aria-label="Copy session fingerprint"
              title="Copy session fingerprint"
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
          </>
        ) : (
          <span className="text-sm text-on-surface-variant italic">
            Loading…
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Phase 3 — libp2p swarm status row.
 *
 * Renders directly beneath the Phase 2 [`PeerIdentitySection`] because
 * the two surfaces are derived from the same per-install Ed25519 seed
 * (see `src-tauri/src/servitude/identity.rs` for the architectural
 * unification note).
 */
export function SwarmStatusSection() {
  const peerId = useIdentityStore((s) => s.swarmPeerId);
  const multiaddrs = useIdentityStore((s) => s.swarmMultiaddrs);
  const peerCount = useIdentityStore((s) => s.swarmPeerCount);
  const lastEvent = useIdentityStore((s) => s.swarmLastEvent);
  const isLoading = useIdentityStore((s) => s.swarmLoading);
  const error = useIdentityStore((s) => s.swarmError);

  useEffect(() => {
    // Initial fetch, then poll on a 5 s cadence while the tab is mounted.
    useIdentityStore.getState().loadSwarm();
    if (!isTauri()) return;
    const id = setInterval(() => {
      useIdentityStore.getState().loadSwarm();
    }, 5000);
    return () => clearInterval(id);
  }, []);

  // Phase 9 (browser P2P UI surface): on web, render the browser
  // swarm status instead of the native-only placeholder.
  if (!isTauri() || error === IDENTITY_ERROR_NATIVE_ONLY) {
    return <BrowserSwarmStatusBlock />;
  }

  return (
    <div className="space-y-2 py-2">
      {/* Our PeerId */}
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm text-on-surface-variant pt-0.5">
          Our PeerId
        </span>
        <div className="flex items-center gap-2 min-w-0">
          {isLoading && !peerId ? (
            <span className="text-sm text-on-surface-variant italic">
              Loading…
            </span>
          ) : error && !peerId ? (
            <span
              className="text-sm text-error truncate"
              title={error}
            >
              Failed to load
            </span>
          ) : peerId ? (
            <span
              className="text-sm text-on-surface-variant font-mono truncate"
              title={peerId}
            >
              {peerId}
            </span>
          ) : (
            <span className="text-sm text-on-surface-variant italic">
              swarm not started
            </span>
          )}
        </div>
      </div>

      {/* Listening multiaddrs */}
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm text-on-surface-variant pt-0.5">
          Listening on
        </span>
        <div className="flex flex-col items-end gap-0.5 min-w-0">
          {multiaddrs.length === 0 ? (
            <span className="text-sm text-on-surface-variant italic">—</span>
          ) : (
            multiaddrs.map((addr) => (
              <span
                key={addr}
                className="text-xs text-on-surface-variant font-mono truncate"
                title={addr}
              >
                {addr}
              </span>
            ))
          )}
        </div>
      </div>

      {/* Peer count */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-on-surface-variant">
          Peers connected
        </span>
        <span className="text-sm text-on-surface-variant font-mono">
          {peerCount}
        </span>
      </div>

      {/* Last event */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-on-surface-variant">Last event</span>
        <span
          className="text-xs text-on-surface-variant truncate"
          title={lastEvent ?? undefined}
        >
          {lastEvent ?? "—"}
        </span>
      </div>
    </div>
  );
}

/**
 * Paired Peers (Phase 5 — peer pairing UX).
 *
 * Bundles the three pairing surfaces — display your card, add a peer,
 * list paired peers — into one section.
 *
 * Native-only — but each child component handles its own web-build
 * placeholder so the section's outer chrome stays consistent.
 */
export function PairedPeersSection() {
  const [scannerOpen, setScannerOpen] = useState(false);

  return (
    <div className="border-t border-outline-variant/15 pt-6 space-y-4">
      <div>
        <h4 className="text-sm font-medium text-on-surface">Paired Peers</h4>
        <p className="text-xs text-on-surface-variant">
          Direct, server-less connections to other Concord installs.
        </p>
      </div>

      {/* Your card — QR + copyable link + post-to-room. */}
      <PeerCardDisplay />

      {/* Add-a-peer launcher. */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setScannerOpen(true)}
          className="px-4 py-2 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm rounded-md transition-colors"
        >
          Add a peer…
        </button>
      </div>

      {/* List of currently paired peers. */}
      <KnownPeersList />

      {/* Peers on your LAN — native only (no portable mDNS in browser). */}
      {isTauri() && <LanPeersSection />}

      {/* Scanner modal — mounted only while open so the camera
          permission prompt fires on demand, not on every tab render. */}
      {scannerOpen && (
        <PeerCardScanner onClose={() => setScannerOpen(false)} />
      )}
    </div>
  );
}

/**
 * Peers on your LAN (post-2026-05-29 redirect).
 *
 * Subscribes to the `peer_lan_discovered` Tauri event via
 * `subscribeToLanPeers` and renders the mDNS-discovered peer list.
 * Session-scoped (resets each launch); persistent pairing happens via
 * the per-row "Pair" action.
 *
 * Native-only — browsers can't observe LAN peers from a tab.
 */
export function LanPeersSection() {
  const [lanPeers, setLanPeers] = useState<LanPeer[]>([]);
  const addFromCard = usePeerStore((s) => s.addFromCard);
  const addToast = useToastStore((s) => s.addToast);

  useEffect(() => {
    const unsub = subscribeToLanPeers((peers) => setLanPeers(peers));
    return unsub;
  }, []);

  const handlePair = async (peer: LanPeer) => {
    const added = await addFromCard(
      {
        peerId: peer.peerId,
        publicKeyHex: "",
        multiaddrs: peer.multiaddrs,
      },
      "deeplink",
    );
    if (added) {
      addToast("LAN peer paired", "success");
    } else {
      addToast("Could not pair LAN peer");
    }
  };

  if (!isTauri()) {
    return null;
  }

  return (
    <div className="space-y-1.5">
      <div className="text-xs text-on-surface-variant uppercase tracking-wide">
        Peers on your LAN
      </div>
      {lanPeers.length === 0 ? (
        <p className="text-xs text-on-surface-variant italic">
          No LAN peers discovered yet.
        </p>
      ) : (
        <ul className="space-y-1">
          {lanPeers.map((peer) => (
            <li
              key={peer.peerId}
              className="flex items-center justify-between gap-3 py-1.5 px-2 rounded hover:bg-surface-container-high"
            >
              <span
                className="text-sm text-on-surface-variant font-mono truncate flex-1 min-w-0"
                title={peer.peerId}
              >
                {peer.peerId.slice(0, 12)}…
              </span>
              <button
                type="button"
                onClick={() => void handlePair(peer)}
                className="px-3 py-1 text-xs rounded-md primary-glow hover:brightness-110 text-on-surface transition-colors whitespace-nowrap"
              >
                Pair this peer
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Phase 9 (browser P2P UI surface) — web variant of the swarm status
 * block. Mirrors the four-row layout of the native version but reads
 * from the browser libp2p singleton via `getBrowserNodeIfStarted()`
 * instead of the `peer_swarm_status` Tauri command.
 */
export function BrowserSwarmStatusBlock() {
  const [node, setNode] = useState<Libp2p | null>(null);
  const [peerId, setPeerId] = useState<string | null>(null);
  const [multiaddrs, setMultiaddrs] = useState<string[]>([]);
  const [peerCount, setPeerCount] = useState<number>(0);
  const [lastEvent, setLastEvent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const running = await getBrowserNodeIfStarted();
      if (cancelled) return;
      setNode(running);
      if (!running) {
        setPeerId(null);
        setMultiaddrs([]);
        setPeerCount(0);
        return;
      }
      try {
        setPeerId(running.peerId.toString());
        setMultiaddrs(
          running.getMultiaddrs().map((m) => m.toString()),
        );
        setPeerCount(running.getPeers().length);
      } catch (err) {
        console.debug("[swarm-status] refresh failed", err);
      }
    };

    void refresh();
    const intervalId = setInterval(() => {
      void refresh();
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!node) return;
    const connectHandler = (e: CustomEvent<{ toString(): string }>) => {
      const remote = e.detail?.toString() ?? "<unknown>";
      setLastEvent(`connected: ${remote}`);
      setPeerCount((c) => c + 1);
    };
    const disconnectHandler = (
      e: CustomEvent<{ toString(): string }>,
    ) => {
      const remote = e.detail?.toString() ?? "<unknown>";
      setLastEvent(`disconnected: ${remote}`);
      setPeerCount((c) => Math.max(0, c - 1));
    };
    node.addEventListener(
      "peer:connect",
      connectHandler as EventListener,
    );
    node.addEventListener(
      "peer:disconnect",
      disconnectHandler as EventListener,
    );
    return () => {
      node.removeEventListener(
        "peer:connect",
        connectHandler as EventListener,
      );
      node.removeEventListener(
        "peer:disconnect",
        disconnectHandler as EventListener,
      );
    };
  }, [node]);

  if (!node) {
    return (
      <div className="space-y-2 py-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-on-surface-variant">Swarm</span>
          <span
            className="text-xs text-on-surface-variant italic text-right"
            title="The browser libp2p swarm is started on demand. Open a voice channel or paired-peers section to spin it up."
          >
            Browser swarm not started — open a voice channel or
            paired-peers section to start it.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 py-2">
      {/* Our PeerId */}
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm text-on-surface-variant pt-0.5">
          Our PeerId
        </span>
        <div className="flex items-center gap-2 min-w-0">
          {peerId ? (
            <span
              className="text-sm text-on-surface-variant font-mono truncate"
              title={peerId}
            >
              {peerId}
            </span>
          ) : (
            <span className="text-sm text-on-surface-variant italic">
              starting…
            </span>
          )}
        </div>
      </div>

      {/* Listening multiaddrs */}
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm text-on-surface-variant pt-0.5">
          Listening on
        </span>
        <div className="flex flex-col items-end gap-0.5 min-w-0">
          {multiaddrs.length === 0 ? (
            <span className="text-sm text-on-surface-variant italic">—</span>
          ) : (
            multiaddrs.map((addr) => (
              <span
                key={addr}
                className="text-xs text-on-surface-variant font-mono truncate"
                title={addr}
              >
                {addr}
              </span>
            ))
          )}
        </div>
      </div>

      {/* Peer count */}
      <div
        className="flex items-center justify-between gap-3"
        data-testid="swarm-peers-row"
      >
        <span className="text-sm text-on-surface-variant">
          Peers connected
        </span>
        <span className="text-sm text-on-surface-variant font-mono">
          {peerCount}
        </span>
      </div>

      {/* Last event */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-on-surface-variant">Last event</span>
        <span
          className="text-xs text-on-surface-variant truncate"
          title={lastEvent ?? undefined}
        >
          {lastEvent ?? "—"}
        </span>
      </div>
    </div>
  );
}

/**
 * Phase 9 — browser-side libp2p node factory.
 *
 * Spins up a js-libp2p instance with the minimum protocol set the
 * browser needs to be a real Concord peer:
 *
 * - **Transports**: WebRTC (peer-to-peer in the browser) + WebSockets
 *   (for dialing peer multiaddrs that advertise `/wss`). QUIC is
 *   intentionally absent — the browser stack does not speak QUIC.
 *
 * - **Encryption**: Noise (matches the Rust Phase 3 swarm so a browser
 *   ↔ native handshake is symmetric).
 *
 * - **Muxer**: Yamux (matches Rust Phase 3).
 *
 * - **Services**: Identify (peer-info exchange so both ends learn each
 *   other's protocols), Ping (liveness probe).
 *
 * ## 2026-05-29 architecture redirect
 *
 * The prior browser stack also wired `kadDHT` and dialed a hardcoded
 * bootstrap list at startup. Both are gone. The native build uses mDNS
 * for LAN-local discovery; browsers can't speak mDNS in any portable way
 * (no Multicast UDP from a tab), so **the browser swarm has zero
 * automatic discovery**. Every peer the browser talks to has to come
 * from the Phase-5 peer-card flow (QR / `concord://` deeplink /
 * Matrix-room exchange) and be dialed explicitly.
 *
 * Tradeoff (user-acknowledged): no random-peer discovery from a browser
 * tab. That's by design — pairing is always intentional.
 *
 * Heavyweight pieces explicitly NOT in the browser stack:
 *
 * - **Kad DHT** — removed 2026-05-29 alongside the project-run VPS
 *   bootstrap fleet.
 * - **Gossipsub** — the browser is a leaf, not a pubsub fanout point.
 * - **Circuit Relay v2 server** — browsers can't be relays.
 * - **Stream behaviour for arbitrary subprotocol routing** — js-libp2p
 *   v3's `handle()` + `dialProtocol()` cover the Phase 6 federation
 *   stream + Phase 8 voice signaling stream without a separate
 *   behaviour layer.
 *
 * Spec pointer: `docs/architecture/p2p-design.md` § Phase 9 +
 * § "Discovery" (post-redirect).
 */

import { createLibp2p } from "libp2p";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";
import type { Libp2p } from "@libp2p/interface";
import { getBrowserIdentity } from "./identity";

/**
 * Concord Matrix-federation libp2p protocol. MUST match the Rust
 * constant `CONCORD_MATRIX_FEDERATION_PROTOCOL` in
 * `src-tauri/src/servitude/federation/matrix.rs`.
 */
export const CONCORD_MATRIX_FEDERATION_PROTOCOL =
  "/concord/matrix-federation/1.0.0";

/**
 * Concord voice-signaling libp2p protocol. MUST match the Rust
 * constant in `src-tauri/src/servitude/voice/signaling.rs`.
 */
export const CONCORD_VOICE_SIGNALING_PROTOCOL =
  "/concord/voice-signaling/1.0.0";

let node: Libp2p | null = null;
let starting: Promise<Libp2p> | null = null;

/**
 * Test seam — allows `node.test.ts` to inject a mock `createLibp2p`
 * implementation without paying the cost of spinning up the real
 * stack inside jsdom (which is multi-second and not what these unit
 * tests should be measuring). Production code never sets this.
 */
type CreateLibp2pFn = typeof createLibp2p;
let createLibp2pImpl: CreateLibp2pFn = createLibp2p;

/**
 * Override the libp2p factory. Test-only — production code MUST NOT
 * touch this. Returns a restore function to undo the override.
 */
export function __setCreateLibp2pForTests(fn: CreateLibp2pFn): () => void {
  const previous = createLibp2pImpl;
  createLibp2pImpl = fn;
  return () => {
    createLibp2pImpl = previous;
  };
}

/**
 * Start (or return the running) browser libp2p node.
 *
 * The node is a singleton — calling `startBrowserNode` twice in a
 * row returns the same `Libp2p` handle. If a start is in-flight, the
 * second caller awaits the same promise so two concurrent `useEffect`
 * mounts don't race two nodes into existence.
 *
 * **No automatic discovery.** The browser swarm boots with zero peers
 * known and stays that way until the caller dials something explicitly
 * (Phase-5 peer card scan, `concord://` deeplink click, or a manual
 * `node.dial(multiaddr)` against a peer learned through a Matrix-room
 * peer card). This matches the post-2026-05-29 architecture: WAN
 * pairing is always intentional, never ambient.
 */
export async function startBrowserNode(): Promise<Libp2p> {
  if (node) return node;
  if (starting) return starting;
  starting = (async () => {
    const identity = await getBrowserIdentity();
    // Type inference takes over the services map here — annotating
    // with `Libp2pInit` widens the components type passed to each
    // service factory and breaks the service factory signatures.
    // `createLibp2p` infers the right `ServiceMap` from the literal.
    const created = await createLibp2pImpl({
      privateKey: identity.privateKey,
      transports: [webRTC(), webSockets()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        ping: ping(),
      },
    });
    // js-libp2p v3 auto-starts the node when `createLibp2p` resolves
    // unless `start: false` was passed. We rely on that default — no
    // separate `.start()` call needed here.
    node = created;
    return created;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/**
 * Stop the running browser libp2p node (if any) and drop the
 * singleton handle. After `stopBrowserNode()` returns, the next call
 * to `startBrowserNode()` creates a fresh swarm.
 */
export async function stopBrowserNode(): Promise<void> {
  if (!node) return;
  const handle = node;
  node = null;
  try {
    await handle.stop();
  } catch (err) {
    // The node may already be stopping/stopped; we always clear the
    // singleton so the next start is clean regardless.
    console.debug("[libp2p] stop error (ignored)", err);
  }
}

/**
 * Return the running node, or `null` if not started. Consumers that
 * want a strict assertion-style accessor can wrap this with their
 * own throw.
 */
export function getNode(): Libp2p | null {
  return node;
}

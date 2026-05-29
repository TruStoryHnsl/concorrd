/**
 * Phase 9 — browser-side libp2p node factory.
 *
 * Spins up a js-libp2p instance with the minimum protocol set the
 * browser needs to be a real Concord peer:
 *
 * - **Transports**: WebRTC (peer-to-peer in the browser) + WebSockets
 *   (for dialing relay / bootstrap nodes that advertise `/wss`).
 *   QUIC is intentionally absent — the browser stack does not speak
 *   QUIC, so the Phase 4 bootstrap multiaddrs that only advertise
 *   `/quic-v1` will fail-to-dial silently. That's fine; the dials are
 *   best-effort and the Kad DHT seeds itself the moment any single
 *   bootstrap responds.
 *
 * - **Encryption**: Noise (matches the Rust Phase 3 swarm so a browser
 *   ↔ native handshake is symmetric).
 *
 * - **Muxer**: Yamux (matches Rust Phase 3).
 *
 * - **Services**: Identify (peer-info exchange so both ends learn
 *   each other's protocols), Ping (liveness probe), Kad-DHT in
 *   `clientMode: true` (browser never serves DHT records, only
 *   queries — matches the native default which is also `Client` mode
 *   on non-docker profiles).
 *
 * Heavyweight pieces explicitly NOT in the browser stack:
 *
 * - **Gossipsub** — the browser is a leaf, not a pubsub fanout point.
 * - **Circuit Relay v2 server** — browsers can't be relays.
 * - **Stream behaviour for arbitrary subprotocol routing** — js-libp2p
 *   v3's `handle()` + `dialProtocol()` cover the Phase 6 federation
 *   stream + Phase 8 voice signaling stream without a separate
 *   behaviour layer.
 *
 * Spec pointer: `docs/architecture/p2p-design.md` § Phase 9.
 */

import { createLibp2p } from "libp2p";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { kadDHT } from "@libp2p/kad-dht";
import { ping } from "@libp2p/ping";
import { multiaddr } from "@multiformats/multiaddr";
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
 * Bootstrap dials are best-effort, mirroring the Rust Phase 4
 * `seed_kad_bootstrap` semantics: a transient network drop or a
 * single unreachable bootstrap node MUST NOT take the swarm down.
 * Each failure is logged at debug level only.
 */
export async function startBrowserNode(
  bootstrapMultiaddrs: readonly string[],
): Promise<Libp2p> {
  if (node) return node;
  if (starting) return starting;
  starting = (async () => {
    const identity = await getBrowserIdentity();
    // Type inference takes over the services map here — annotating
    // with `Libp2pInit` widens the components type passed to each
    // service factory and breaks the `kadDHT()` factory signature.
    // `createLibp2p` infers the right `ServiceMap` from the literal.
    const created = await createLibp2pImpl({
      privateKey: identity.privateKey,
      transports: [webRTC(), webSockets()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        ping: ping(),
        kadDHT: kadDHT({ clientMode: true }),
      },
    });
    // js-libp2p v3 auto-starts the node when `createLibp2p` resolves
    // unless `start: false` was passed. We rely on that default — no
    // separate `.start()` call needed here.
    for (const addr of bootstrapMultiaddrs) {
      try {
        await created.dial(multiaddr(addr));
      } catch (err) {
        // Best-effort. Identical posture to the Rust Phase 4 bootstrap
        // loop: a bad placeholder or temporarily-unreachable node must
        // not surface as a user-visible failure.
        console.debug("[libp2p] bootstrap dial failed", { addr, err });
      }
    }
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

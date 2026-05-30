/**
 * Phase 9 — lazy-load shim around `./node`.
 *
 * The js-libp2p stack added in Phase 9 is heavy (~600 KB raw, ~250 KB
 * gzipped) and the vast majority of web sessions never reach a surface
 * that needs it (no voice room, no Paired Peers settings tab). Eagerly
 * starting the swarm on App mount (as the original `useBrowserLibp2p`
 * hook did) pinned the entire libp2p tree to the main cold-start
 * bundle.
 *
 * This module replaces every direct `import { ... } from "./node"`
 * call elsewhere in the app with a thin async wrapper. Vite sees the
 * dynamic `import("./node")` here and emits the libp2p tree as its
 * own chunk (`dist/assets/libp2p-<hash>.js`) — the browser only fetches
 * it the first time a caller actually needs the swarm.
 *
 * Caching semantics: a single in-flight `import()` promise is reused
 * across concurrent callers so two voice-channel mounts racing into
 * `ensureBrowserNode` don't trigger two separate chunk fetches. After
 * the chunk lands, every later call shares the same singleton node
 * inside `./node` (see `startBrowserNode`'s `if (node) return node`
 * guard), so the lazy seam is invisible to callers.
 *
 * Operator escape hatch: power users / operators that want the old
 * eager-start behavior can pass `enabled: true` to `useBrowserLibp2p`
 * from any always-mounted surface (e.g. an embedded servitude config
 * panel). The opt-in design preserves that posture without forcing
 * every cold-start to pay the libp2p tax.
 *
 * Spec pointer: `docs/architecture/p2p-design.md` § Phase 9.
 */

import type { Libp2p } from "@libp2p/interface";

type NodeModule = typeof import("./node");

let cached: Promise<NodeModule> | null = null;

/**
 * Load (or return the in-flight load of) the `./node` chunk.
 *
 * The first caller pays the chunk-fetch cost; subsequent callers
 * share the same promise. Vite emits this as a separate dynamic
 * chunk so the libp2p tree is split from the app shell.
 */
function loadNodeModule(): Promise<NodeModule> {
  if (!cached) cached = import("./node");
  return cached;
}

/**
 * Test seam — clear the cached `import()` promise so each test starts
 * from a "never loaded" state. Production code MUST NOT touch this.
 *
 * Vitest's module registry caches the actual ESM module across tests,
 * so this reset is purely about the `cached` Promise sentinel that
 * tracks whether `loadNodeModule()` has been called at least once.
 */
export function __resetLazyNodeForTests(): void {
  cached = null;
}

/**
 * Lazily load `./node` and start (or return) the browser libp2p node.
 *
 * Caching: the underlying `startBrowserNode` is itself a singleton
 * (returns the same `Libp2p` handle on repeat calls), so reading
 * `cached` here is just a chunk-fetch optimization, not a node-
 * identity guarantee — that lives inside `node.ts`.
 */
export async function ensureBrowserNode(
  bootstrap: readonly string[],
): Promise<Libp2p> {
  const mod = await loadNodeModule();
  return mod.startBrowserNode(bootstrap);
}

/**
 * Stop the browser libp2p node IF the chunk was ever loaded.
 *
 * If `cached` is still null, the libp2p chunk has never been fetched
 * — there's no possible node to stop and we skip the dynamic import
 * entirely. This is the key bundle-size property: a session that
 * never needs libp2p never pays the chunk-fetch cost, even on
 * unmount cleanup paths.
 */
export async function stopBrowserNodeIfStarted(): Promise<void> {
  if (!cached) return;
  const mod = await cached;
  await mod.stopBrowserNode();
}

/**
 * Return the running browser libp2p node IF the chunk was ever
 * loaded AND the node was successfully started. Returns null on the
 * "never loaded" path WITHOUT triggering a chunk fetch — important
 * for the voice-path selector, which is invoked on every voice join
 * and must NOT cause libp2p to load when the selector would have
 * picked LiveKit anyway.
 */
export async function getBrowserNodeIfStarted(): Promise<Libp2p | null> {
  if (!cached) return null;
  const mod = await cached;
  return mod.getNode();
}

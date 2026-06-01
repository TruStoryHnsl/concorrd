/**
 * F-A — Concord-native user-definition protocol — API wrapper.
 *
 * Thin wrappers around the five `concord_user_*` Tauri commands exposed by
 * `src-tauri/src/lib.rs`. Mirrors the Rust types defined in
 * `src-tauri/src/servitude/concord_user/mod.rs`. Web build returns typed
 * errors (the user-definition protocol is a native-only feature; the
 * browser node can't sign with the install's Stronghold seed).
 *
 * See `docs/architecture/concord-user-protocol-scope.md` for the protocol
 * overview. The defining invariant is per-server identity isolation —
 * a ConcordUserDescriptor with multiple `server_profiles` and no trust
 * edges yields multiple effective profiles when reduced via merge_view.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./servitude";

/** Transport-agnostic avatar pointer — see `AvatarRef` in Rust. */
export type AvatarRef =
  | { kind: "multiaddr"; multiaddr: string }
  | { kind: "matrix_mxc"; mxc: string }
  | { kind: "porch_asset"; asset_id: string }
  | { kind: "none" };

/** One server's view of the hero. */
export interface ServerProfile {
  server_id: string;
  display_name: string;
  avatar: AvatarRef;
  bio?: string | null;
  /** Hex-encoded Ed25519 signature, 128 chars. */
  signature: string;
}

/** A signed trust-edge declaration. */
export interface TrustEdge {
  edge_id: string;
  /** Hex-encoded 32-byte Ed25519 public key. */
  concord_uid: string;
  server_a: string;
  server_b: string;
  /** Unix seconds. */
  issued_at: number;
  /** Hex-encoded Ed25519 signature. */
  signature: string;
}

/** A signed revocation of a previously-declared trust edge. */
export interface TrustEdgeRevocation {
  edge_id: string;
  concord_uid: string;
  revoked_at: number;
  signature: string;
}

/** Append-only log entry. */
export type TrustLogEntry =
  | { kind: "edge"; edge_id: string; concord_uid: string; server_a: string; server_b: string; issued_at: number; signature: string }
  | { kind: "revocation"; edge_id: string; concord_uid: string; revoked_at: number; signature: string };

/** The canonical user record — top-level Rust type. */
export interface ConcordUserDescriptor {
  concord_uid: string;
  display_name: string;
  server_profiles: ServerProfile[];
  trust_log: TrustLogEntry[];
}

/**
 * Sentinel error thrown when the web build attempts a native-only call.
 * The renderer disambiguates this from a real failure so it can swap in
 * the "Native build only" copy.
 */
export class ConcordUserUnavailableError extends Error {
  constructor() {
    super("Concord-user protocol is only available in the native build");
    this.name = "ConcordUserUnavailableError";
  }
}

/** Fetch THIS install's local descriptor. */
export async function getSelf(): Promise<ConcordUserDescriptor> {
  if (!isTauri()) throw new ConcordUserUnavailableError();
  return invoke<ConcordUserDescriptor>("concord_user_get_self");
}

/**
 * Fetch a paired peer's descriptor over the
 * `/concord/user-profile/1.0.0` libp2p protocol. Returns `null` when the
 * peer responds with `NotFound`.
 */
export async function getForPeer(
  peerId: string,
): Promise<ConcordUserDescriptor | null> {
  if (!isTauri()) throw new ConcordUserUnavailableError();
  return invoke<ConcordUserDescriptor | null>("concord_user_get_for_peer", {
    peerId,
  });
}

/**
 * Sign + persist a new trust-edge declaration. Returns the signed edge.
 * Per the design contract: trust edges are USER-EXPLICIT only. This is
 * the only path that creates one.
 */
export async function addTrustEdge(
  serverA: string,
  serverB: string,
): Promise<TrustEdge> {
  if (!isTauri()) throw new ConcordUserUnavailableError();
  return invoke<TrustEdge>("concord_user_add_trust_edge", {
    serverA,
    serverB,
  });
}

/** List the currently-active trust edges (revocations replayed). */
export async function listTrustEdges(): Promise<TrustEdge[]> {
  if (!isTauri()) throw new ConcordUserUnavailableError();
  return invoke<TrustEdge[]>("concord_user_list_trust_edges");
}

/**
 * Append a revocation of an existing edge. Append-only semantics —
 * the edge declaration stays on disk; the revocation supersedes it.
 */
export async function revokeTrustEdge(edgeId: string): Promise<void> {
  if (!isTauri()) throw new ConcordUserUnavailableError();
  await invoke("concord_user_revoke_trust_edge", { edgeId });
}

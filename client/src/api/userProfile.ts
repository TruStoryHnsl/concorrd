/**
 * User Management Phase 1 — API wrapper.
 *
 * Thin wrappers around the eight `user_profile_*` Tauri commands exposed
 * by `src-tauri/src/lib.rs`. All commands are native-only — the web
 * build doesn't host a porch, so the wrappers return a `not_supported`
 * sentinel (an empty list / a typed error) instead of dispatching.
 *
 * Wire shapes mirror the Rust types in `src-tauri/src/porch/users.rs`:
 *   - `UserProfile`
 *   - `Provenance` (`local` | `relay_restored`)
 *   - `KeychainEntry`
 *   - `SourceKind` (`concord` | `matrix` | `p2p_peer`)
 *
 * Phase 1 deliberately does NOT ship wrappers for `add_keychain_entry`
 * or `decrypt_credentials` — those are the seams Phase 2's source-add
 * flows wire into. The Rust-side primitives exist (and the integration
 * test exercises them); the IPC surface is held back until Phase 2 to
 * keep credential write-paths intentional.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./servitude";

/** Where a profile originated. */
export type Provenance = "local" | "relay_restored";

/** What kind of source a keychain entry authenticates to. */
export type SourceKind = "concord" | "matrix" | "p2p_peer";

/** One user profile. Mirrors the Rust `UserProfile` shape. */
export interface UserProfile {
  /** ULID. */
  id: string;
  /** User-visible display name (validated non-empty, <= 64 chars). */
  display_name: string;
  /** Optional avatar URL (mxc:// or http(s)). */
  avatar_url: string | null;
  /** Exactly one profile per install carries `true` at a time. */
  is_primary: boolean;
  /** Where this profile came from. */
  provenance: Provenance;
  /** Unix milliseconds — when the profile was created on this install. */
  created_at: number;
}

/** One keychain entry's metadata. Ciphertext + nonce NEVER leave the
 *  porch — only the metadata is surfaced to the renderer. Decryption
 *  is a separate Rust-side call wired in Phase 2. */
export interface KeychainEntry {
  /** ULID. */
  id: string;
  /** FK to `UserProfile.id`. */
  profile_id: string;
  source_kind: SourceKind;
  /** e.g. `matrix.org`. */
  source_host: string;
  /** User-supplied nickname for the login. */
  label: string | null;
  /** Unix milliseconds — when the entry was added. */
  created_at: number;
  /** Unix milliseconds — when the entry was last decrypted, or `null`. */
  last_used_at: number | null;
}

/** List every non-tombstoned profile on this install, primary first.
 *  The web build returns an empty list. */
export async function userProfileList(): Promise<UserProfile[]> {
  if (!isTauri()) return [];
  return await invoke<UserProfile[]>("user_profile_list");
}

/** Create a new profile. The new row is NOT primary — promote
 *  explicitly via {@link userProfileSetPrimary}. Native only. */
export async function userProfileCreate(
  displayName: string,
): Promise<UserProfile> {
  if (!isTauri()) {
    throw new Error("user_profile_create is native-only");
  }
  return await invoke<UserProfile>("user_profile_create", {
    displayName,
  });
}

/** Rename a profile. Native only. */
export async function userProfileRename(
  id: string,
  displayName: string,
): Promise<UserProfile> {
  if (!isTauri()) {
    throw new Error("user_profile_rename is native-only");
  }
  return await invoke<UserProfile>("user_profile_rename", {
    id,
    displayName,
  });
}

/** Promote a profile to primary, demoting whichever profile was
 *  previously primary inside the same transaction. Native only. */
export async function userProfileSetPrimary(
  id: string,
): Promise<UserProfile> {
  if (!isTauri()) {
    throw new Error("user_profile_set_primary is native-only");
  }
  return await invoke<UserProfile>("user_profile_set_primary", { id });
}

/** Set (or clear, when `null`) the avatar URL on a profile. Native only. */
export async function userProfileSetAvatar(
  id: string,
  avatarUrl: string | null,
): Promise<UserProfile> {
  if (!isTauri()) {
    throw new Error("user_profile_set_avatar is native-only");
  }
  return await invoke<UserProfile>("user_profile_set_avatar", {
    id,
    avatarUrl,
  });
}

/** Delete a profile. The porch's `ON DELETE CASCADE` drops every
 *  keychain entry the profile owned. Pass `confirmPrimaryDemotion: true`
 *  to delete the currently-primary profile. The backend refuses to
 *  delete the LAST profile in any case. Native only. */
export async function userProfileDelete(
  id: string,
  confirmPrimaryDemotion: boolean = false,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("user_profile_delete is native-only");
  }
  await invoke<void>("user_profile_delete", {
    id,
    confirmPrimaryDemotion,
  });
}

/** List the keychain entries owned by a profile. Returns metadata only;
 *  credential ciphertext / nonce never cross the IPC boundary. The
 *  web build returns an empty list. */
export async function userProfileKeychainList(
  profileId: string,
): Promise<KeychainEntry[]> {
  if (!isTauri()) return [];
  return await invoke<KeychainEntry[]>("user_profile_keychain_list", {
    profileId,
  });
}

/** Remove a keychain entry by id. Native only. */
export async function userProfileKeychainRemove(entryId: string): Promise<void> {
  if (!isTauri()) {
    throw new Error("user_profile_keychain_remove is native-only");
  }
  await invoke<void>("user_profile_keychain_remove", { entryId });
}

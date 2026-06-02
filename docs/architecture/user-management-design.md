# User Management — multi-profile keychain architecture

This document captures the vision, data model, and phase plan for the
Concord User Management subsystem: multiple per-install user profiles, a
Stronghold-backed keychain abstraction, and the relay-mediated multi-
device restore flow.

## Vision (verbatim — do not paraphrase in code or comments)

> "There needs to be a 'user management' wing of concord that keeps
> track of the various logins that people use to connect to sources.
> This way auth can be unique for each source but still painless for
> the user. The keychain is generated locally per instance. So my
> phone, my computer, my ipad will all have to connect once on their
> own to the various sources. Among the user management menu there
> should be an option to designate a dedicated server instance like
> \[a docker concord instance] as a relay for their account data. So
> each machine need only log into \[that relay] with the same user and
> the keychain associated with that user will come back as well. The
> user management system must be robust enough to visually distinguish
> where user profiles come from and what they are used for. One user
> profile can be made the primary and its keychain is what is copied
> when using a persistent build as a trusted source. But the primary
> owns the other users. When a new instance logs into that same user
> the full keychain is copied which allows for quick rediscovery of
> all established sources."

### Key concepts extracted from the vision

- **User profile** — a distinct identity inside Concord. NOT the same
  as a Matrix `user_id`; one Concord profile may own several Matrix
  logins to different homeservers, plus zero or more concord-source
  credentials and p2p-peer trust entries.
- **Per-install keychain** — the bag of source credentials owned by a
  profile. Per device by default; generated fresh on each install. The
  keychain is what makes "auth unique for each source but painless"
  possible — credentials never leave the device unless the user opts
  into a relay.
- **Primary profile** — exactly one profile per install is marked
  primary. The primary's keychain is the canonical bundle that gets
  relayed to other devices. Non-primary profiles are owned by the
  primary (in the sense that the primary's keychain is the one that
  propagates across devices).
- **Account relay** — an external Concord-docker instance the user
  designates as their relay. Logging into the relay on a new device
  pulls down the primary's keychain (ciphertext) and decrypts it
  locally with the user's passphrase. The relay never sees plaintext.
- **Visual provenance** — the UI MUST clearly show where each profile
  came from (local-only, primary, relay-restored, etc.) so the user can
  reason about trust + propagation without diving into settings.

## Data model

### Schema (porch DB, v7)

```sql
CREATE TABLE user_profiles (
    id TEXT PRIMARY KEY,                    -- ULID
    display_name TEXT NOT NULL,
    avatar_url TEXT,                        -- optional mxc:// or http URL
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    provenance TEXT NOT NULL CHECK (provenance IN ('local', 'relay_restored')),
    created_at INTEGER NOT NULL,
    -- CRDT metadata (Phase F)
    sync_device_id TEXT,
    sync_lamport INTEGER DEFAULT 0,
    sync_tombstone INTEGER DEFAULT 0
);

CREATE TABLE keychain_entries (
    id TEXT PRIMARY KEY,                    -- ULID
    profile_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,              -- 'concord' | 'matrix' | 'p2p_peer'
    source_host TEXT NOT NULL,              -- e.g. 'matrix.org'
    label TEXT,                             -- user-supplied nickname
    ciphertext BLOB NOT NULL,               -- encrypted JSON credentials
    nonce BLOB NOT NULL,                    -- 12-byte AEAD nonce
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    -- CRDT metadata
    sync_device_id TEXT,
    sync_lamport INTEGER DEFAULT 0,
    sync_tombstone INTEGER DEFAULT 0,
    FOREIGN KEY (profile_id) REFERENCES user_profiles(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_only_one_primary
    ON user_profiles(is_primary)
    WHERE is_primary = 1;

CREATE INDEX idx_keychain_by_profile ON keychain_entries(profile_id);
CREATE INDEX idx_keychain_by_source  ON keychain_entries(source_host);
```

The unique partial index is the load-bearing invariant: at most one row
in `user_profiles` can have `is_primary = 1` at any time. A migration
that tries to promote a second profile MUST first clear `is_primary`
on the existing primary within the same transaction.

### Rust enums

```rust
pub enum Provenance { Local, RelayRestored }
pub enum SourceKind { Concord, Matrix, P2pPeer }
```

`Provenance::Local` covers any profile created on this install.
`Provenance::RelayRestored` covers any profile imported from an account
relay (Phase 3). The variant set is intentionally narrow; Phase 4's
multi-device sync does NOT introduce a new provenance variant — a
profile that flows in over Phase F's CRDT sync still counts as
"local" from the user's mental model, because both devices are theirs.

### Encryption

Keychain entry `ciphertext` is encrypted at the keychain layer (not
inside SQLite). The cipher is ChaCha20-Poly1305 keyed by a 32-byte
symmetric key derived from the Stronghold seed via HKDF-SHA256 with the
format-version marker `b"concord/keychain/v1"`. The nonce is a fresh
12-byte RFC8439 value per entry, stored alongside the ciphertext.

The `v1` info string is deliberately different from
`porch::backup::HKDF_INFO_V1` (`b"concord/porch-backup/v1"`) so the
two key streams remain disjoint even if both ever leaked. A `v2`
format revision bumps the info string and v1 readers will fail AEAD
verification against v2 blobs by construction.

The wrong-seed verification test (`keychain_decryption_fails_with_wrong_seed`)
is the load-bearing security check.

## Phase plan

### Phase 1 — Foundation (THIS PR)

Scope:

- Schema v7 migration in the porch DB (`user_profiles`, `keychain_entries`,
  unique index, supporting indexes).
- `porch::users` module: `UserProfile`, `KeychainEntry`, `Provenance`,
  `SourceKind`, `PlaintextCredentials`, CRUD helpers, keychain
  encrypt/decrypt round-trip backed by `SeedAccess`.
- Tauri commands for profile CRUD + primary toggle + keychain list/remove
  (entry creation + decryption are NOT exposed yet — Phase 2's source-add
  flows wire those).
- `client/src/api/userProfile.ts` TS wrappers.
- "Users" settings tab (`UsersTab`) with profile CRUD, primary toggle,
  provenance badges, inline rename.
- Default seed: a single primary profile named "Local" on first-boot to
  schema v7 so existing installs have something.

Out of scope for Phase 1 (deferred to later phases):

- Routing source-add through profile keychains.
- Relay-account protocol.
- Multi-device keychain sync.

### Phase 2 — Source-add routing + migration prompt

Goal: every existing source-add flow (Matrix login, Concord-instance
invite token redemption, p2p peer pairing) writes its credentials into
the active profile's keychain rather than the legacy `sources` store.
Plaintext credentials never persist outside the Stronghold-derived
keychain key.

Mechanics:

- `add_keychain_entry` / `decrypt_credentials` Tauri commands exposed.
- Source-add UIs get a "Save to profile" picker, defaulting to the
  primary profile.
- Migration prompt on launch after Phase 2 lands: "We found N saved
  sources on this device. Move them into your primary profile?" The
  prompt offers per-source migration so the user can split between
  profiles if they want.
- Existing `sources` store rows continue to work read-only until the
  user migrates them; the routing layer treats keychain entries as the
  canonical source of truth and falls back to legacy rows only when no
  keychain entry exists for `(source_host, source_kind)`.

### Phase 3 — Account relay over libp2p

Goal: a designated Concord docker instance acts as the user's account
relay. The primary profile's keychain (ciphertext) is uploaded to the
relay encrypted with a passphrase-derived key. A new device that signs
in to the relay with the user's master passphrase pulls the ciphertext
and decrypts it locally.

Protocol: `/concord/account-relay/1.0.0` on the relay side. The relay
docker instance MUST be operated by someone the user trusts (themselves,
in the common case) because it sees the relay-account auth handshake
and decides who's allowed to pull a given user's blob.

Threat model:

- The relay sees only ciphertext + a relay-account identifier. It
  cannot decrypt the keychain without the user's passphrase.
- A compromised relay can deny service (refuse to hand back the blob)
  or sniff metadata (which user pulled what when), but cannot reveal
  the actual credentials.
- A compromised passphrase IS catastrophic — every keychain entry the
  primary owns is exposed. Mitigation: passphrase hardening via
  Argon2id at the client side before HKDF.
- The relay-account auth handshake itself is NOT covered by the
  keychain encryption; it's a separate credential the user manages
  with the relay (passphrase, WebAuthn, or linked-device — open
  question below).

New profile provenance variant `relay_restored` flags profiles that
were pulled from the relay so the UI can badge them distinctly. The
badge is informational — the profile behaves identically to a local
profile once restored.

### Phase 4 — Multi-device sync over Phase F's CRDT

Goal: two installs both signed into the same relay (or directly linked
as personal devices via Phase F) converge on a single keychain set.
Adds + revokes propagate in both directions; the latest write wins per
entry, scoped per profile.

Mechanics:

- `user_profiles` and `keychain_entries` ride Phase F's
  `(sync_device_id, sync_lamport, sync_tombstone)` columns (already
  laid down in Phase 1).
- `crate::porch::sync` is extended to include the two new tables in
  its `SYNCED_TABLES` set; PullDelta / PushDelta envelopes carry rows
  from both tables alongside the existing ones.
- Tombstones on `keychain_entries` are honored so a "delete credential
  on phone" propagates to laptop.
- Conflict resolution: LWW per (id) with `(sync_lamport, sync_device_id)`
  comparator, same as every other Phase F CRDT table.

### Threat model summary

| Surface | Risk | Mitigation |
|---------|------|------------|
| Local keychain SQLite blob | Disk-stealer reads ciphertext | AEAD-encrypted with HKDF-from-Stronghold key; Stronghold seed never on disk in plaintext |
| Stronghold seed | Disk-stealer with seed knowledge | OS keyring + seed file's own ChaCha20-Poly1305 envelope (existing Phase 4 protection) |
| Account relay (Phase 3) | Compromised relay | Ciphertext-only; passphrase-derived key gated by Argon2id |
| Passphrase brute-force | Weak user passphrase | Argon2id with t=3, m=64MB, p=1; client-side rate limiting on relay calls |
| Multi-device sync (Phase 4) | One compromised device leaks the keychain | Per-device link tokens (Phase F's `device_links`); revoking a device tombstones its sync rights |

## Open questions

These are deferred to their owning phases but recorded here so future
sessions don't re-discover them:

1. **Relay-account auth model.** Passphrase is the simplest; WebAuthn is
   stronger but adds platform dependencies; linked-device (pair a new
   device by scanning a QR on an already-signed-in device) is the most
   ergonomic but requires the relay to act as a temporary rendezvous.
   Tentative leaning: passphrase + linked-device as a recovery option.

2. **Multi-relay (failover).** If a user designates two relays for
   redundancy, do both hold the full keychain? How are writes ordered
   across both? Tentative leaning: primary relay is the canonical
   write target; secondary relays mirror via a relay-to-relay protocol
   and serve reads if primary is unavailable.

3. **Conflict resolution if two devices write keychain entries for the
   same source.** Same (source_host, source_kind, profile_id) tuple on
   both devices, each with different `access_token`. LWW picks one;
   the loser's session on the other device gets force-logged-out next
   sync. Acceptable? Or should the UI surface a "two of your devices
   have conflicting logins to this source" reconciliation prompt?
   Tentative leaning: LWW silently for now; surface a prompt only if
   metrics show this happens regularly.

4. **Per-profile vs. per-entry primary affordance.** Does the primary
   flag transfer to entries (i.e. the entire keychain ships) or could
   the user pin specific entries as "always relay this one"? Phase 3
   ships per-profile; Phase 4 may revisit.

5. **Cross-profile entry move.** Can a credential authored under
   profile A be moved to profile B? Mechanically trivial (update
   `profile_id`); UX-wise unclear whether to expose. Defer until users
   ask.

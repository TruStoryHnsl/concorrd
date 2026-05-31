# Porch — local-server-per-install architecture

The "porch" is the user's persistent, per-install local server that's
available to paired peers as a Source whenever the user is online.

## Vision (verbatim — do not paraphrase in code or comments)

> Each user's install hosts their own server. The porch is the front
> door — a default channel paired peers can visit without explicit
> approval.
>
> Inner rooms are gated: visitor knocks → owner adds them to ACL → they
> appear inside.
>
> Per-channel aesthetic customization (Phase C) lets users express
> themselves; a DND campaign room can have its own theme.
>
> Phase D: Obsidian channel type. Channel points at a vault folder;
> markdown notes/maps/town histories surface to peers granted that
> channel.
>
> Phase E: docker-build-as-backup — a trusted peer (or self-hosted
> Concord docker stack) holds encrypted backups so the user can migrate
> to a new device.
>
> Phase F: multi-device tiers — peers tagged "personal device" sync the
> porch+rooms so one user maintains a single porch across phone+laptop+
> desktop.
>
> Phase G: WireGuard-tunneled p2p hardening — libp2p peers only connect
> inside what feels like a LAN, via WireGuard tunnels that spoof "same
> LAN". Outside connections have no structural path to interfere.

## Why a porch, not a server?

A traditional "server" implies an authority — an operator with admin
power who decides who joins. That's exactly what Concord's federation
model wanted to dissolve. The porch is intentionally smaller:

- Every install runs one. Even users who never invite anyone have one
  sitting empty.
- The porch is the only channel visible to a paired peer by default.
  Inner channels require an explicit ACL grant.
- The owner is always the local peer-id. There is no "promote to
  moderator" — the porch belongs to one person.
- Visiting a peer's porch is the moral equivalent of knocking on their
  front door. Cheap, expected, not particularly intimate.

## Data flow (Phase A)

```
                   ┌─────────────────────────────────────────────┐
                   │           Local install (host)              │
                   │                                             │
   peer A          │   Porch tauri commands ──► Porch{ db }      │
  (visitor) ──┐    │            ▲                  │             │
              │    │            │                  ▼             │
              │    │      libp2p runtime      ┌──────────┐       │
              │    │            ▲             │ porch    │       │
              ├────┼──/concord/porch/1.0.0──► │ .sqlite  │       │
              │    │   length-prefixed JSON   └──────────┘       │
              │    │                                             │
              │    │                          channel_acl ◄── ACL│
              │    │                          channel_messages   │
              │    │                          porch_channels     │
              │    └─────────────────────────────────────────────┘
              │
              │  Peer A's React UI calls porch_visit_peer(B)
              │  → Tauri command dials B's libp2p PeerId
              │  → opens stream on /concord/porch/1.0.0
              │  → JSON-RPC ListChannels / GetMessages / PostMessage
              │  → response decoded → returned to React
              ▼
       Browser visitor:
       same protocol, opened via @libp2p/webrtc once the
       browser libp2p node is up (Phase 9 stack).
```

The host's local React UI does NOT use libp2p to reach its own porch —
it reads SQLite via the Tauri commands `porch_list_my_channels`,
`porch_get_messages`, `porch_post_message`. The libp2p path is only
used for *visiting* (i.e. one peer reaching another's porch).

## Schema (Phase A)

The porch DB lives at `<app_local_data_dir>/porch.sqlite`. Migrations are
applied idempotently on open via a `schema_version` table. Phase A is
schema version 1.

```sql
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);

CREATE TABLE porch_channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('porch', 'inner', 'obsidian')),
    acl_mode TEXT NOT NULL CHECK (acl_mode IN ('open', 'allowlist', 'owner_only')),
    created_at INTEGER NOT NULL  -- unix ms
);

CREATE TABLE channel_acl (
    channel_id TEXT NOT NULL,
    peer_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('visitor', 'member', 'owner')),
    granted_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, peer_id),
    FOREIGN KEY (channel_id) REFERENCES porch_channels(id) ON DELETE CASCADE
);

CREATE TABLE channel_messages (
    id TEXT PRIMARY KEY,           -- ULID
    channel_id TEXT NOT NULL,
    author_peer_id TEXT NOT NULL,  -- libp2p PeerId string
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (channel_id) REFERENCES porch_channels(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_channel_time ON channel_messages(channel_id, created_at);
CREATE INDEX idx_acl_peer ON channel_acl(peer_id);
```

First-boot inserts a single channel:

```sql
INSERT INTO porch_channels VALUES ('porch-default', 'Porch', 'porch', 'open', <now_ms>);
```

This is the user's "front door". `acl_mode = 'open'` means any paired
peer who can dial the libp2p PeerId can read + post.

## libp2p protocol — `/concord/porch/1.0.0`

The same machinery as Phase 6: a `FederationHandler` registered on the
shared `LibP2pTransport` with its own protocol ID. 4-byte big-endian
length-prefixed JSON envelopes, 1 MiB cap.

```rust
#[derive(Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum PorchRequest {
    ListChannels,
    GetMessages { channel_id: String, since: Option<i64>, limit: u32 },
    PostMessage { channel_id: String, body: String },
}

#[derive(Serialize, Deserialize)]
pub struct PorchResponse {
    pub ok: bool,
    pub result: Option<serde_json::Value>,
    pub error: Option<PorchErrorBody>,
}
```

The 1 MiB cap (vs the 16 MiB cap on the Matrix federation handler) is
deliberate: a single porch chat message will never need to exceed 1 MiB.
Voice / Obsidian payloads (Phase D) will land on a different protocol ID
with a larger cap, leaving this one tight against the chat use case.

## Per-phase scope and open questions

### Phase A — local porch + default channel + visit protocol (THIS PR)

In scope:

- Embedded SQLite (`rusqlite` bundled).
- `porch_channels`, `channel_acl`, `channel_messages` schema.
- Default `Porch` channel created on first boot.
- `/concord/porch/1.0.0` libp2p protocol handler.
- Six Tauri commands: `porch_list_my_channels`, `porch_get_messages`,
  `porch_post_message`, `porch_visit_peer`, `porch_visit_get_messages`,
  `porch_visit_post_message`.
- TS API wrappers + zustand stores for own porch + visited peer.
- Browser-side visitor support over the existing Phase 9 libp2p stack.
- One PorchSource tile + PorchView modal/route per paired peer.

Out of scope (deferred to later phases below):

- Inner channels (the schema supports `kind = 'inner'` but no UI yet
  creates them).
- Per-channel ACL grant UI. Phase A only ever ships the open default
  porch; the allowlist machinery is present so Phase B can land without
  a schema migration.
- Per-channel theming.
- Obsidian channel type.
- Backup, multi-device sync, WireGuard hardening.

Open questions:

1. **Owner-marker handling on first boot.** The default porch channel
   has `acl_mode = 'open'`, so the owner doesn't need an ACL row. When
   Phase B introduces `Allowlist` channels, do we auto-insert the
   owner's peer-id with role `owner`, or do we treat "no ACL row for
   owner" as implicit owner? Leaning toward implicit owner — the
   `OwnerOnly` mode already special-cases the local peer, and an
   explicit row would require resolving the local PeerId at DB-open
   time (which needs Stronghold to be loaded — a coupling we'd rather
   avoid).

2. **Message ordering across peers.** Each message is stamped with the
   *host's* clock at INSERT time. If a visitor's clock is wildly out of
   sync, their messages still get the host's monotonic timestamp.
   That's fine for Phase A (single-host porch) but Phase F (multi-
   device) will need a CRDT or Lamport clock.

3. **Wire shape stability.** The `PorchRequest` enum uses
   `#[serde(tag = "method", content = "params")]`. This is a
   forward-compatible shape — adding a new variant doesn't break old
   clients (they get an `error.code = -32601 method_not_found`). Old
   clients sending a method new servers don't understand also get a
   structured error. Future phases extend by adding variants, never by
   re-tagging existing ones.

### Phase B — inner channels + ACL UI

> **Phase B implementation landed (2026-05-30).** This PR adds inner
> channels behind ACL plus the knock-to-enter approval flow.
>
> What ships:
>
> - **Schema bumped to v2.** New `channel_knocks` table with the
>   knock lifecycle (`pending` / `accepted` / `rejected` / `withdrawn`).
>   A partial unique index on `(channel_id, knocker_peer_id) WHERE
>   status = 'pending'` enforces "at most one open knock per pair";
>   re-knocking after withdraw/reject is allowed.
> - **`src-tauri/src/porch/knock.rs`** carries the knock state machine.
>   `Porch::knock` dedupes against an existing pending row (so the wire
>   handler can be idempotent under network jitter). `accept_knock`
>   atomically flips status AND inserts a `member` ACL row in one
>   transaction. `reject_knock` flips status without ACL change.
>   `withdraw_knock` is restricted to the original knocker.
> - **Wire protocol stays `/concord/porch/1.0.0`** — additive
>   methods, no version bump. New `Knock` / `KnockStatus` /
>   `WithdrawKnock` variants on `PorchRequest`.
> - **`ListChannels` is now visibility-aware.** The response shape
>   changed from `Vec<PorchChannel>` to `Vec<PorchListChannelRow>`,
>   where each row carries a `visibility` discriminator: `Visible`
>   means the visitor is inside; `NeedsKnock { existing_knock }`
>   exposes the *existence* of a gated channel so the visitor's UI can
>   render a Knock affordance (and report their own knock status if
>   they've already filed one). `OwnerOnly` channels stay hidden over
>   the wire. This is what addresses the user feedback "don't HIDE
>   inner rooms; expose their existence so guests know what they can
>   ask for".
> - **Owner-side Tauri commands**: `porch_pending_knocks`,
>   `porch_accept_knock`, `porch_reject_knock`, `porch_create_channel`
>   (mints a new channel with a ULID id), `porch_grant_member`,
>   `porch_revoke_member`.
> - **Visitor-side Tauri commands**: `porch_visit_knock`,
>   `porch_visit_knock_status`, `porch_visit_withdraw_knock` — and
>   their browser-libp2p counterparts in `client/src/libp2p/porch.ts`.
> - **UI surfaces**: `KnocksAtTheDoor` polls `porch_pending_knocks`
>   every 10s and renders each pending visitor with Accept / Reject
>   buttons; the empty state reads "Nobody knocking right now." Wired
>   into `PorchManagement`, which sits at the top of the porch modal
>   (above the host's own channel list, which now has a "+ New"
>   affordance for minting inner / owner-only channels). `PorchView`
>   in visit mode renders ALL channels — visible ones click to enter
>   as before; gated channels render a Knock button; pending knocks
>   render a "Waiting on host" badge + Withdraw; accepted knocks
>   surface a Refresh link to re-fetch the channel list.
>
> Out of scope (still deferred):
>
> - **Sources-panel rail integration.** The porch is still surfaced
>   via the modal Phase A introduced; the right rail still doesn't
>   accept a non-Concord source tile. Push to a later phase.
> - **Offline-knock delivery.** When peer A knocks while peer B is
>   offline, the knock is dropped — A has to re-knock on reconnect.
>   The "retry silently" / "ride a federated bridge" decision is left
>   to a future sprint.
> - **`visitor` ACL role refinement.** Phase B's accept inserts
>   `member` directly. A "read-only acknowledged knocker" tier
>   (`visitor` role) is still unused; Phase B's UI doesn't yet
>   distinguish.

The original Phase B plan is captured below for historical reference:

In scope:

- Tauri commands for `porch_create_channel(name, kind, acl_mode)` and
  `porch_grant_acl(channel_id, peer_id, role)` /
  `porch_revoke_acl(channel_id, peer_id)`.
- React UI: an "Add channel" tile in the host's own porch view; a
  visitor's view of an inner channel shows a "Request access" affordance
  that pings the owner via libp2p.
- A new `PorchRequest::RequestAccess { channel_id }` variant — the
  owner side records the knock in a new `porch_access_requests` table
  and surfaces it in the host's UI.

Schema additions:

```sql
CREATE TABLE porch_access_requests (
    id TEXT PRIMARY KEY,           -- ULID
    channel_id TEXT NOT NULL,
    peer_id TEXT NOT NULL,
    note TEXT,                     -- optional message from the knocker
    requested_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'granted', 'denied')),
    FOREIGN KEY (channel_id) REFERENCES porch_channels(id) ON DELETE CASCADE
);
```

Open questions:

1. **Notification delivery for knocks while the host is offline.** When
   peer A knocks on B's inner channel while B is offline, where does
   the knock live? Options: A retries silently every N minutes until B
   comes online; the knock rides through a federated bridge (Matrix
   room used as a relay); the knock is dropped and A has to re-knock.
   No decision yet; Phase B can ship with "A retries on reconnect".

2. **Role semantics inside an inner channel.** Phase A defines `visitor`
   / `member` / `owner`. Phase B might add `read_only` for a knocker who
   was acknowledged but not yet granted full membership. Defer the
   decision until concrete UX requirements land.

### Phase C — per-channel aesthetic customization

In scope:

- New `channel_theme` table keyed on `channel_id`. Stores CSS-variable
  blobs: surface color, accent color, body font, monospace font, banner
  image URL.
- Host UI: a theme editor inside the channel settings.
- Visitor UI: themes are applied client-side; if the visitor has
  disabled remote themes (privacy / a11y), the default theme renders.
- Wire shape: `PorchRequest::GetChannelTheme { channel_id }` ➜
  `PorchResponse.result = { surface_color, accent_color, ... }`.

Schema additions:

```sql
CREATE TABLE channel_theme (
    channel_id TEXT PRIMARY KEY,
    surface_color TEXT,
    accent_color TEXT,
    body_font TEXT,
    mono_font TEXT,
    banner_url TEXT,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (channel_id) REFERENCES porch_channels(id) ON DELETE CASCADE
);
```

Open questions:

1. **Banner-image hosting.** A theme can reference a banner image. The
   options: (a) bake into the theme blob as a data URL — simple but
   blows up the message size; (b) host the image inside the porch
   under a `/concord/porch-blob/1.0.0` protocol that streams a chunked
   blob; (c) reference an external URL. Lean toward (b) — Phase D
   (Obsidian) needs blob streaming anyway and (a) makes the
   `GetChannelTheme` envelope huge.

### Phase D — Obsidian channel type

In scope:

- Host can mark a channel as `kind = 'obsidian'` and bind it to a vault
  folder path on disk.
- A background indexer crawls the folder; visible markdown files become
  available to ACL-granted peers via a new
  `/concord/porch-obsidian/1.0.0` protocol with methods `ListNotes`,
  `GetNote`, `GetAttachment`.
- The visitor's React UI renders the markdown with wikilinks + embeds
  + callouts (the existing `obsidian-markdown` skill output applies).
- Edits are read-only in Phase D. Phase F's CRDT story is what makes
  multi-writer Obsidian channels sane.

Schema additions:

```sql
CREATE TABLE obsidian_channel_bindings (
    channel_id TEXT PRIMARY KEY,
    vault_root TEXT NOT NULL,      -- absolute path on the host filesystem
    last_indexed_at INTEGER,
    FOREIGN KEY (channel_id) REFERENCES porch_channels(id) ON DELETE CASCADE
);

CREATE TABLE obsidian_notes (
    channel_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,   -- e.g. "history/town-founding.md"
    title TEXT,
    indexed_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, relative_path),
    FOREIGN KEY (channel_id) REFERENCES porch_channels(id) ON DELETE CASCADE
);
```

Open questions:

1. **Symlink handling.** A vault may symlink outside its root. Default
   to "do not follow symlinks" and surface a settings toggle. Phase D
   never serves a file outside `vault_root`.

2. **Attachment size cap.** Markdown is small; embedded images aren't.
   Stream attachments chunked over the porch-obsidian protocol with a
   per-chunk size of 256 KiB. The host can cap total transfer size per
   peer per hour.

### Phase E — docker-build-as-backup

DOCUMENT ONLY in Phase A.

The user's porch state (the SQLite file + a small key registry) can be
backed up to a trusted peer or to a long-running self-hosted Concord
docker stack. The backup peer holds an encrypted, ZSTD-compressed
SQLite dump and a key-recovery envelope encrypted under the user's
Stronghold-derived backup key.

Wire protocol sketch:

```
/concord/porch-backup/1.0.0

PorchBackupRequest:
  UploadDump { revision: u64, blob_chunks: <streamed>, total_bytes: u64 }
  ListRevisions
  DownloadDump { revision: u64 }
  GetKeyRecoveryEnvelope

PorchBackupResponse:
  Ack { revision: u64 }
  Revisions { entries: [{ revision, uploaded_at, bytes }] }
  Blob { <streamed bytes> }
  KeyRecoveryEnvelope { ciphertext_b64, salt_b64 }
```

The backup peer is opt-in on both sides. The host marks a paired peer
as `is_backup_peer = true` in a new column on `KnownPeer`; the backup
peer marks the host as `allowed_to_backup_here = true` reciprocally.
The docker stack is just a Concord install running headless that always
accepts backups.

Recovery: a fresh install can dial a backup peer with the
key-recovery envelope decrypted by the user's backup passphrase, then
pull the latest dump and restore over the empty `porch.sqlite`.

Threat model: the backup peer sees ciphertext only. The encryption key
is derived from the user's Stronghold seed; losing the seed means
losing the backup. The backup passphrase exists so the user can
restore on a device that doesn't have access to the old Stronghold
(new phone, etc.).

Open questions:

1. **Revision pruning.** When does the backup peer delete old
   revisions? Per-peer storage budget vs. retention window. Default to
   "keep last N where N=10" with a UI override.

2. **Atomic upload.** A partial dump upload that gets interrupted must
   not overwrite the last good revision. The backup peer writes to a
   tmp blob, verifies a SHA-256 the host included in the trailer, then
   renames into place.

### Phase F — multi-device sync

DOCUMENT ONLY in Phase A.

A paired peer can be tagged `device_tier = 'personal'` on both sides.
Two personal peers maintain the same porch state via a CRDT replicating
the SQLite dataset. The leading candidates:

- **Automerge** (Rust + JS) — operation-based CRDT, good for collaborative
  text but heavier per-document cost.
- **yjs-rs / equivalent** — same model, different ecosystem.
- **A hand-rolled per-table CRDT** — last-writer-wins on messages
  (single-author per row makes this trivial), OR-set semantics on the
  ACL table, register-style on channel metadata. Avoids the
  general-purpose CRDT overhead at the cost of bespoke logic per table.

Decision deferred to Phase F implementation. The likely answer is
hand-rolled per-table; messages are append-only with stable IDs, ACL
adds are commutative, and channel renames are rare enough that
last-writer-wins is fine.

Schema additions (sketch):

```sql
ALTER TABLE porch_channels ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channel_acl ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE sync_state (
    peer_id TEXT PRIMARY KEY,
    last_synced_at INTEGER NOT NULL,
    last_synced_revision INTEGER NOT NULL
);
```

Wire protocol: a new `/concord/porch-sync/1.0.0` that exchanges
op-sequences since `last_synced_revision`. Conflict resolution per
table type as above.

Open questions:

1. **Who is the "primary" device when both edit offline?** The
   per-table CRDT story says "no primary", but the user-facing UX may
   want to highlight conflicts on rare channels (e.g. inner channel
   renamed to two different things). UI surface required to surface
   that.

2. **Resource constraints on phones.** A phone shouldn't be expected
   to host the full sync workload of a desktop. The lighter device
   may opt into "read-only mirror" mode where it pulls but doesn't
   push.

### Phase G — WireGuard-tunneled hardening

DOCUMENT ONLY in Phase A.

The threat the porch design wants to neutralize: an unpaired peer
discovering you via libp2p (NAT punching, opportunistic relay) and
attempting to dial your porch protocol. Even though the ACL gates
visibility, the *connection itself* is something we'd like to deny by
default.

Sketch:

```
┌───────────────────────┐                ┌───────────────────────┐
│ Peer A                │                │ Peer B                │
│                       │                │                       │
│ wg-userspace ◄──────► │ ◄── /tunnel/x  │ ◄──────► wg-userspace │
│         │             │ (UDP-over-     │         │             │
│         ▼             │  whatever)     │         ▼             │
│ libp2p sees only      │                │ libp2p sees only      │
│ 10.42.0.0/16 peers    │                │ 10.42.0.0/16 peers    │
└───────────────────────┘                └───────────────────────┘
```

Each pair of personal-device peers gets its own WireGuard tunnel
(spoofed "LAN"). The libp2p `Transport` is gated to accept connections
only when the remote peer's source IP is inside the tunnel block.

Implementation sketch:

- Bundle a userspace WireGuard impl (`boringtun` or `wireguard-rs`)
  inside the Tauri binary.
- Each KnownPeer stores its WireGuard public key alongside its
  libp2p PeerId.
- On pairing, both sides install a WireGuard peer entry pointing at
  the other's tunnel endpoint.
- A custom `libp2p::core::Transport::poll_listener` accepts only
  incoming connections from inside the tunnel CIDR. External libp2p
  dials are dropped at the transport layer before any noise/yamux
  exchange.

Threat model:

- Unpaired remote peer cannot reach the porch — they don't have a
  WireGuard handshake key, so no IP route exists.
- A paired-but-revoked peer is removed from WireGuard immediately on
  revocation; the porch protocol handler doesn't need to be involved.
- A compromised paired peer can only reach channels they have an ACL
  grant for. The libp2p layer trusts them; the porch ACL layer doesn't.

Open questions:

1. **NAT-friendly endpoints.** WireGuard expects each peer to know an
   IP:port for the other. Concord's existing pairing flow only
   captures libp2p multiaddrs. Either we add a WireGuard public-key
   field to the peer card (Phase G UX), or we run a small coordination
   service per pair (defeats the purpose).

2. **Mobile battery.** A always-on WireGuard tunnel drains battery.
   Phone-side personal devices might run WireGuard only when the porch
   surface is foreground, and rely on a separate "knock me on Matrix"
   path otherwise.

3. **WireGuard adoption blockers on iOS.** iOS user-space WireGuard
   requires a Network Extension entitlement. Verify before committing
   to the design — the alternative is a thinner "libp2p with strict
   peer-id allowlist + opportunistic NAT punching" path that doesn't
   require the OS entitlement.

## Implementation pointers (Phase A)

- Module: `src-tauri/src/porch/` (NEW).
- Submodules: `db`, `channel`, `acl`, `protocol`, `error`.
- Tests: `src-tauri/tests/porch_test.rs` with 4 cases (default-channel
  first-boot, ACL filter, message order, two-swarm visit round-trip).
- Client: `client/src/api/porch.ts`, `client/src/libp2p/porch.ts`,
  `client/src/stores/porchStore.ts`, `client/src/stores/visitorStore.ts`,
  `client/src/components/porch/PorchView.tsx`,
  `client/src/components/porch/PorchSource.tsx`.
- Sources-panel integration: deferred to a follow-up after the
  sortable-rail mechanics in `SourcesPanel.tsx` accept a non-Concord
  source tile. Phase A surfaces the porch visit through a modal opened
  via the Paired Peers list.

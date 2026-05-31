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

> **Phase C implementation landed (2026-05-30).** Schema bumped to v3
> with two new tables: `channel_themes` (one row per channel; primary
> / surface / on_surface / accent color anchors, font_family enum,
> tagged-union background of `none` / `solid` / `gradient` /
> `image{asset_id}`) and `porch_assets` (per-channel uploaded image
> blob metadata — the bytes live on disk under
> `<data_dir>/porch_assets/<asset_id>.<ext>` with SHA-256 + 5 MiB
> upload cap; the DB row carries only metadata).
>
> Wire protocol stays `/concord/porch/1.0.0` — `GetTheme {
> channel_id }` and `GetAssetBytes { asset_id }` variants land
> additively. `ListChannels` rows now carry an optional
> `theme_summary` (primary + accent only) so the visitor's rail can
> render small color swatches without per-row GetTheme roundtrips.
> `GetAssetBytes` is gated by the asset's owning channel ACL
> (verified by `get_asset_bytes_respects_acl` integration test) and
> serializes via a `kind: "inline" | "too_large"` envelope — inline
> bytes capped at 256 KiB; larger assets surface a typed placeholder
> marker so the visitor's client can render "image too large to
> preview" without retrying. A dedicated `/concord/porch-asset/1.0.0`
> streaming protocol for larger assets is deferred to a later phase.
>
> Tauri commands: owner-side `porch_get_theme` / `porch_set_theme` /
> `porch_upload_asset` / `porch_list_assets`; visitor-side
> `porch_visit_get_theme` / `porch_visit_get_asset_bytes`. The
> visitor commands also have browser-libp2p counterparts in
> `client/src/libp2p/porch.ts`.
>
> React surface: `client/src/components/porch/themeRenderer.ts`
> emits CSS custom properties (`--porch-surface`, `--porch-primary`,
> etc.) the porch view scopes to itself (no global Tailwind override)
> and ships a small WCAG-ish contrast floor; `ChannelThemeEditor.tsx`
> is lazy-loaded into `PorchManagement` under a new Themes tab and
> covers color pickers + a font dropdown + a background tab strip +
> an in-place file upload + a live preview. `PorchView` (visitor
> mode) resolves and caches the per-channel theme via
> `porch_visit_get_theme`, fetches image backgrounds through
> `porch_visit_get_asset_bytes` → blob URL, and paints the whole
> channel view through `applyTheme()`.
>
> Out of scope (still deferred to later phases):
>
> - **Sources-panel rail integration.** As in Phase A/B, the porch is
>   still surfaced via the modal, not the right rail.
> - **Large image streaming.** Inline GetAssetBytes is capped at 256
>   KiB; bigger assets surface a placeholder. A
>   `/concord/porch-asset/1.0.0` chunked protocol is a follow-up.
> - **Self-mode image background.** The host's own porch view doesn't
>   yet stream its own image backgrounds (the theme editor preview is
>   the canonical view); only the visitor path resolves blob URLs.
> - **Per-visitor remote-theme opt-out.** The original Phase C plan
>   included a "disable remote themes for a11y / privacy" toggle;
>   ship as a settings option in a follow-up.

The original Phase C plan is captured below for historical reference:

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

> **Phase D implementation landed (2026-05-31).** Schema bumped to v4
> with one new table: `obsidian_channels`. Each row binds a channel
> of `kind = 'obsidian'` to a directory on the owner's filesystem.
>
> **Security model — the load-bearing boundary.** Every read/list
> request goes through three independent gates:
>
> 1. **Canonicalization at config time.** `set_obsidian_config`
>    calls `std::fs::canonicalize` on the supplied `vault_root` and
>    stores the canonical (`..`-resolved, symlink-resolved) absolute
>    form. Optional `subfolder` is canonicalized against the canonical
>    root and rejected if it escapes. Non-existent paths refuse.
> 2. **Prefix check on every access.** `list_vault` and
>    `read_vault_file` reject any wire path containing a `..`
>    component up front, then canonicalize the resolved absolute path
>    and assert it starts with the stored canonical `vault_root`.
>    Symlink-escape attempts are caught on the way down — unless the
>    owner has explicitly opted into `follow_symlinks`. A regression
>    here is CVE-class (see `path_traversal_rejected` in
>    `src-tauri/tests/porch_obsidian_test.rs`).
> 3. **MIME allow-list on reads.** Only `text/markdown`, `text/plain`,
>    `image/png`, `image/jpeg`, `image/webp`, `image/gif`,
>    `image/svg+xml`, `application/pdf` are ever served. Everything
>    else (executables, binary blobs, archives) is refused with a
>    typed error. Hidden entries (leading `.`) are filtered from
>    listings so `.obsidian/`, `.git/`, etc. never leak.
>
> Per-file size cap is 5 MiB; the wire layer applies the existing
> 256 KiB inline cap and serializes a `too_large` marker for anything
> bigger so the visitor's UI can render "ask the owner to share
> directly" rather than retrying.
>
> **Wire protocol stays `/concord/porch/1.0.0`** — additive
> `ListVault { channel_id, path }` and `GetVaultFile { channel_id,
> path }` request variants. Both gate on `can_visit` (the same ACL
> check Phase B/C use) AND on the channel being kind=Obsidian; the
> kind mismatch returns a typed `InvalidInput` rather than leaking a
> dispatch path for non-obsidian channels. The `VaultFileResponse`
> envelope mirrors Phase C's `AssetBytesResponse` shape — `Inline`
> bytes under 256 KiB, otherwise `TooLarge` with metadata.
>
> Tauri commands: owner-side `porch_set_obsidian_config` /
> `porch_get_obsidian_config` / `porch_list_vault` /
> `porch_read_vault_file`; visitor-side `porch_visit_list_vault` /
> `porch_visit_get_vault_file`. The visitor commands have browser-
> libp2p counterparts in `client/src/libp2p/porch.ts`. The owner-side
> dialog uses `@tauri-apps/plugin-dialog` (added in this PR) to surface
> the OS-native folder picker.
>
> React surface: `client/src/components/porch/ObsidianChannelEditor.tsx`
> (lazy-loaded inside `PorchManagement`) lets the owner pick a vault
> root + optional subfolder + toggle `follow_symlinks`.
> `client/src/components/porch/VaultBrowser.tsx` (lazy-loaded inside
> `PorchView` when a visitor selects an obsidian-kind channel) renders
> a two-pane file tree + content view. Markdown renders via the
> lazy-loaded `vaultMarkdown.tsx` module which uses `react-markdown`
> + `remark-gfm` (both already in `client/package.json` from prior
> work — no new bundle weight). Embedded image markdown
> (`![alt](path)`) is resolved through `porch_visit_get_vault_file`
> → blob URL. Plain text renders in a `<pre>`; images render in
> `<img>`; PDFs render inside an `<iframe>` of a blob URL.
>
> **Wikilinks** (`[[Note Title]]`) render as styled but non-clickable
> text. Following a wikilink would require a separate
> "resolve-wikilink-to-path" round-trip + UI navigation — that's
> flagged as a Phase D follow-up.
>
> **Vault file-watch** (auto-refresh of a visitor's open file when the
> owner saves) is also deferred — Phase D ships read-on-demand. A
> visitor refresh button + ETag-style cache invalidation are the
> natural Phase D follow-up.
>
> Out of scope (still deferred to later phases):
>
> - **Sources-panel rail integration.** Still through the modal.
> - **Multi-writer Obsidian.** Phase F's CRDT lands first.
> - **Background indexer + ListNotes/GetNote.** The original Phase D
>   plan envisioned a separate `/concord/porch-obsidian/1.0.0`
>   protocol with `ListNotes` / `GetNote` / `GetAttachment`. The
>   shipped implementation folds those into the existing
>   `/concord/porch/1.0.0` protocol via `ListVault` /
>   `GetVaultFile` — simpler, no second protocol id, ACL surface
>   unified.
> - **Chunked attachment streaming.** The 256 KiB inline cap is shared
>   with Phase C; a future `/concord/porch-blob/1.0.0` streaming
>   protocol lifts both.

The original Phase D plan is captured below for historical reference:

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

> **Phase E implementation landed (2026-05-31).**
>
> The Phase E surface is the encrypt → upload → store → download →
> decrypt → restore pipeline. Implementation choices:
>
> - **Wire protocol**: `/concord/porch-backup/1.0.0` is a dedicated
>   stream protocol distinct from `/concord/porch/1.0.0`. Trust
>   boundaries diverge — a backup peer may refuse content access while
>   accepting uploads (and vice versa), so separate protocol IDs let
>   the federation layer enforce that opt-in independently per role.
>   See `src-tauri/src/porch/backup_protocol.rs`.
> - **Encryption**: ChaCha20-Poly1305 AEAD over `ZSTD(VACUUM INTO
>   snapshot)`. Key derivation is HKDF-SHA256 over the Stronghold
>   Ed25519 seed bytes with the info string
>   `b"concord/porch-backup/v1"` — the v1 marker IS the format
>   version. A future format revision bumps the info string and a v1
>   reader rejects v2 blobs by construction (AEAD verification fails
>   because the derived key differs). See
>   `src-tauri/src/porch/backup.rs::HKDF_INFO_V1` + `derive_backup_key`.
> - **Storage on the backup peer**: per-uploader-keyed
>   (`received_backups.uploader_peer_id` is the PRIMARY KEY); only the
>   latest blob is retained, replays overwrite in-place. Bytes live at
>   `<data_dir>/porch_backups/<uploader>.bin` in
>   `[12 nonce bytes][ciphertext]` layout. Revision pruning beyond
>   "latest only" is a Phase E follow-up.
> - **Per-uploader ACL**: `GetMyBackup` / `GetMyBackupInfo` key on the
>   connected libp2p `PeerId`. Peer A's blob is only retrievable by
>   peer A; peer C dialing in receives `None`. The handler also
>   refuses `UploadBackup` envelopes whose `uploader_peer_id` doesn't
>   match the connected peer-id — otherwise A could overwrite B's
>   slot with garbage.
> - **Cross-device restore prerequisite**: the SAME Stronghold seed
>   must be in the in-memory cache / sibling file on the restoring
>   device. Today that's the same install (the Phase 4 sibling-file
>   layer survives normal restarts). True cross-device — losing the
>   old phone, installing on a new one — is gated on a **separate
>   seed-mnemonic export/import flow** that lands as `feat:
>   stronghold-seed-mnemonic`. Phase E ships the backup mechanics; the
>   mnemonic flow unlocks the cross-device restore from a true loss
>   event.
> - **Auto-scheduler**: deferred. Phase E ships the manual
>   `porch_backup_push_now` command + UI button. A periodic
>   "push-once-per-hour-per-target, push-on-startup-if-stale" loop
>   lands in a follow-up PR.
> - **Schema migration**: schema v5 added two tables — `backup_targets`
>   (backing-up side) and `received_backups` (backup-peer side). The
>   migration is additive and forward-compatible with the Phase A–D
>   tests; no existing rows were touched.

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

> **Phase F implementation landed (2026-05-31).**
>
> Hand-rolled per-table CRDT shipped (no Automerge / Yjs dep). The
> rationale documented in the implementation prompt:
>
> * Automerge's binary format would make the SQLite schema opaque to
>   inspection — and we want `sqlite3 porch.sqlite` to keep working.
> * Yjs is built around collaborative text, not relational tables.
> * Our data shape (channels, messages, ACL grants, knocks, themes,
>   obsidian bindings, assets) maps cleanly to per-row tombstone-LWW.
>
> **Schema v6.** The migration adds two new tables and seven sync
> metadata column triples:
>
> ```sql
> CREATE TABLE device_identity (device_id PRIMARY KEY, created_at, label);
> CREATE TABLE device_links (peer_id PRIMARY KEY, device_id, role, ...);
> ALTER TABLE porch_channels   ADD COLUMN sync_device_id / sync_lamport / sync_tombstone;
> -- ditto for channel_messages, channel_acl, channel_knocks,
> -- channel_themes, porch_assets, obsidian_channels
> ```
>
> Pre-Phase-F rows are backfilled with this install's freshly-minted
> device-id (a ULID) at `sync_lamport = 0`. Indexes on `sync_lamport`
> back the "give me everything since X" PullDelta path.
>
> **LWW comparator: `(sync_lamport, sync_device_id)` — lamport first,
> device-id tiebreak for total ordering.** This tiebreak is the
> load-bearing detail; without it, two devices writing at the same
> logical lamport tick would converge non-deterministically and the
> CRDT property would break. `porch_sync_test::lww_tiebreak_device_id`
> verifies it.
>
> **Tombstones, not hard deletes.** When `revoke_acl` runs, the
> row is updated to `sync_tombstone = 1` and its
> `(sync_device_id, sync_lamport)` is bumped. The row stays on disk
> so a later sync from a device that hasn't yet seen the revoke
> loses LWW against it. The application surface filters
> tombstoned rows: `lookup_acl` treats them as absent so the revoke
> takes effect immediately for the host's UI. The
> `sync_tombstone` column exists for every CRDT-tracked table, but
> Phase F only fires it from `revoke_acl`. Message delete is a Phase
> F follow-up; the column exists so the protocol doesn't break when
> that ships.
>
> **Wire protocol: `/concord/porch-sync/1.0.0`.** Three methods:
>
> * `LinkRequest { my_device_id, label }` — bootstrap. Both peers
>   independently call this during pairing; each side learns the
>   other's `(peer_id, device_id)` and records it in `device_links`
>   via a separate Tauri command (`porch_link_personal_device`). The
>   handler does NOT auto-insert into the responder's `device_links`
>   — the user on the responder side has to also click "link" on
>   their own UI. This is the consent gate.
> * `PullDelta { since: SyncCursor }` — caller asks for rows with
>   `sync_lamport > since[table]` per CRDT-tracked table. Refused
>   with 403 if the caller isn't in `device_links`.
> * `PushDelta { delta: SyncDelta }` — caller ships rows; responder
>   applies via `merge::apply_remote_*` inside one transaction;
>   returns per-table counts of rows that actually changed (rows that
>   lost LWW silently drop).
>
> 32 MiB envelope cap — enough for any realistic porch DB; a future
> chunked-streaming protocol can lift it without breaking the wire
> shape (the cap is per-envelope, not per-protocol).
>
> **Per-table apply functions.** Each `apply_remote_<table>` follows
> the same shape: look up the local row by PK; if absent, insert
> verbatim (including tombstones — a remote tombstone for a row we
> never had is still a tombstone we want to remember, so a delayed
> in-flight insert can't accidentally resurrect it); if present,
> compare `(remote_lamport, remote_device_id)` vs `(local_lamport,
> local_device_id)`; larger wins. `porch_sync_test::
> tombstone_for_unknown_row_inserted_as_tombstone` covers the
> tombstone-resurrection edge.
>
> **Sync mechanics.** `sync_now(porch, control, peer)` runs one
> pull-then-push round and returns a `SyncReport` with per-table
> counts. `porch_sync_all_personal_devices` iterates every linked
> device. The frontend `PersonalDevices.tsx` tab kicks
> `porch_sync_all_personal_devices` every 60s while mounted —
> background convergence without the user having to mash buttons.
> Errors per-peer surface inside each `SyncReport` rather than
> aborting the loop (one offline phone doesn't block sync with the
> desktop).
>
> **Trust boundary.** `/concord/porch-sync/1.0.0` is separate from
> the porch + backup protocols so an install can refuse sync access
> while still accepting porch visits / backup uploads (and vice
> versa). The handler's first action on any non-LinkRequest method
> is `assert_linked(requester)` which returns 403 if the requester
> isn't in `device_links`. `porch_sync_test::sync_rejects_non_linked_peer`
> verifies the 403.
>
> **Obsidian vault_root is intentionally per-device.** The
> `obsidian_channels` row syncs (so all devices agree on which
> channels are obsidian-kind) but the `vault_root` path is
> device-local in practice — `/home/corr/Notes` on laptop A is not
> the same path as `/Documents/Notes` on phone B. The CRDT applies
> LWW on the row as-shipped; the user manually re-binds the vault
> per device. Documenting this here so a future contributor doesn't
> "fix" it by trying to sync paths across heterogeneous filesystems.
>
> **Auto-sync interval shipped: 60s while the Personal Devices tab
> is mounted.** A globally-resident 5-minute cadence is the natural
> follow-up; the spec deferred that decision to the implementer and
> 60s-while-visible is the lighter footprint.
>
> Out of scope (still deferred to later phases):
>
> * **Message-delete UI.** The tombstone column exists; the user-
>   facing "delete a message" affordance is a follow-up that wires
>   into `apply_remote_message` (already tombstone-aware).
> * **Read-only mirror tier.** The original design's "phone pulls
>   but doesn't push" idea is still open — Phase F ships symmetric
>   sync. A future `device_links.role = 'read_only_mirror'` would
>   gate the PushDelta path.
> * **WireGuard hardening.** Phase G.
> * **Conflict surfacing UI.** The CRDT converges automatically but
>   the user has no UI to see "your channel name changed because
>   another device renamed it later". The data is there
>   (`sync_device_id` per row); the surface is a follow-up.

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

> **Phase G implementation landed (2026-05-31).** The first slice
> of Phase G ships the **inbound connection gate** without the
> bundled-WireGuard half: the gate enforces "incoming connection
> source IP must be on a trusted tunnel CIDR" at the libp2p
> `NetworkBehaviour` layer, but the WireGuard tunnel itself is the
> operator's responsibility (WireGuard or Tailscale running on the
> host, or an operator-supplied extra CIDR via Settings → Connections
> → Tunnel hardening). Bundling a userspace WireGuard impl
> (`boringtun`) for the desktop builds is the next slice; the iOS
> NetworkExtension path is a follow-up after that.
>
> New module: `src-tauri/src/servitude/network/` with three
> submodules — `tunnel_detect` (per-platform interface probe;
> Linux/macOS use `getifaddrs(3)`, Windows is a stub returning
> loopback only, iOS is an explicit no-op so the build succeeds),
> `tunnel_config` (JSON-persisted operator preferences at
> `<app_local_data_dir>/tunnel_config.json`), and `connection_gate`
> (a `NetworkBehaviour` impl that returns `Err(ConnectionDenied)`
> from `handle_pending_inbound_connection` when the source IP isn't
> on the allow-list).
>
> **Multi-layer defense.** The gate is the OUTERMOST perimeter. A
> non-tunnel inbound is rejected BEFORE the noise handshake fires —
> the dialing peer sees an `OutgoingConnectionError` and never
> learns the local install's PeerId. Behind the gate, the existing
> noise / yamux / behaviour-level authentication still runs
> (defence-in-depth: even a trusted-CIDR peer must still complete
> the libp2p handshake). The gate operates on TCP and QUIC source
> IPs identically because the libp2p multiaddr stack surfaces the
> `/ip4` or `/ip6` component first for both transports.
>
> **enforce defaults to `false`.** Existing installs upgrading to
> Phase G don't lose connectivity on the upgrade. The Settings
> panel ships a "Tunnel-only mode" toggle, an auto-detected CIDRs
> read-only list (WireGuard `wg*` / Tailscale `tailscale*` /
> `utun*` w/ CGNAT prefix / loopback), and an editable extras list
> for operators running a non-standard VPN (e.g. a custom 10.42.0.0/16).
> Loopback (`127.0.0.0/8` + `::1/128`) is trusted unconditionally
> so the local React UI can never lock itself out of its own porch
> and the existing two-swarm `p2p_test` harness keeps working under
> enforce=true.
>
> **Circuit-relay v2 caveat.** When peer B reaches peer A through a
> relay R, the source IP A sees IS the relay R's IP. The gate
> trusts the relay only if the relay itself sits on a trusted
> tunnel CIDR — which means circuit-relayed connections are NOT
> reachable under tunnel-only mode unless the relay is colocated on
> the same tunnel as the local install (e.g. a Tailnet-hosted
> relay). This is acceptable for Phase G's "lock the porch down to
> a tunnel-only mesh" promise; users who want broad relay-mediated
> reachability disable enforce.
>
> **iOS NetworkExtension follow-up.** iOS sandboxing prevents
> arbitrary system-interface enumeration from an app, so the
> per-platform probe is a no-op on iOS. The full fix is a Network
> Extension of type `packet-tunnel-provider` (entitlement
> `com.apple.developer.networking.networkextension`) — the app
> owns its own tunnel device, both ends of the libp2p connection
> route through it, and the gate sees a known iOS-tunnel CIDR. App
> Store review requires the entitlement be approved by Apple
> Developer Relations as part of an annual review. For Phase G we
> ship the gate code path (so the iOS build compiles cleanly) and
> defer the entitlement work. iOS users CAN pair with native peers
> and visit other porches — the gate only constrains INBOUND
> connections — they just can't be inbound peers under tunnel-only
> mode.
>
> **Hot-swap.** The `TunnelConfig` is stored behind an Arc<RwLock>
> shared between the swarm's gate behaviour and the Tauri
> `tunnel_set_config` command. Toggling enforce or editing the
> extras list takes effect on the running swarm without a restart;
> the next inbound dial is gated under the new policy.
>
> Tests:
> `src-tauri/tests/tunnel_test.rs` (5 cases: config round-trip,
> CIDR matching, loopback-trusted-by-default, report partitioning,
> default-enforce-off) plus `src-tauri/tests/tunnel_gate_test.rs`
> (1 case: two-swarm enforce-rejects-loopback-dial) plus inline
> module unit tests in `tunnel_detect.rs` (4 cases) and
> `connection_gate.rs` (7 cases) and `tunnel_config.rs` (4 cases).
> Vitest: 3 cases in
> `client/src/components/settings/__tests__/TunnelHardeningSection.test.tsx`.

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

## Porch is now a Source tile (post-Phase A follow-up)

The Phase A note above deferred the Sources-rail integration until the
sortable-rail mechanics could accept a non-Concord tile. That follow-up
has shipped:

- `client/src/components/layout/SourcesPanel.tsx` now renders an
  intrinsic `PorchTile` at the TOP of the rail, above the sortable
  sources list. The tile is NOT a row in `useSourcesStore.sources` —
  that store represents external connections, and the porch is local
  to this install (it exists from first boot per Phase A).
- The tile uses the user's Matrix avatar as its icon when a
  `MatrixClient` session is available (via the existing `useAvatarUrl`
  hook in `client/src/hooks/usePresence.ts`). When no Matrix session
  exists (P2P-only profile, user never logged into a homeserver), the
  tile falls back to a `home` material symbol. The fallback is the
  steady state for native installs that boot straight into the local
  porch without a homeserver login.
- An "intrinsic" badge — a small `home`-glyph circle overlapping the
  bottom-right corner of the tile, mirroring the existing
  `source-owner-badge` star pattern — distinguishes the porch from a
  remote source so users intuitively read it as "this is mine, this is
  local" instead of "this is a friend's porch."
- An online indicator dot in the top-right corner lights green when at
  least one paired peer has a recent `lastSeen` (`<60s`) in the
  peer-store. Otherwise the dot is gray. The real libp2p swarm-event
  mirror is a follow-up to this follow-up; until then `lastSeen` is the
  cheapest signal that doesn't require an extra IPC round-trip per
  render.
- The tile is **NOT draggable** — it sits OUTSIDE the rail's
  `SortableContext` — and **NOT removable**. Right-clicking it does
  NOT open the regular `SourceContextMenu` (that menu's "Close
  connection" entry doesn't apply to an intrinsic install-local
  surface).
- Clicking the tile invokes `onPorchOpen()` (a new
  `SourcesPanel` prop), wired in `ChatLayout.tsx` to a full-screen
  overlay that renders `<PorchView mode="self" />`. The local porch
  loads via the existing `porchStore` `loadChannels()` flow, which
  calls the `porch_list_my_channels` Tauri command shipped in Phase A.

Mobile mirrors the desktop contract: the Sources panel renders a
`MobilePorchRow` at the top of its source list with the same intrinsic
semantics (always-on, non-removable, click → `onPorchOpen`).

Tests covering the integration live in
`client/src/components/layout/__tests__/SourcesPanel.porch-tile.test.tsx`
(5 cases: empty-sources render, top-of-rail ordering, no-disconnect
context menu, home-icon fallback, click → callback).

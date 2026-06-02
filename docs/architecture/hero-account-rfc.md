# Hero Account + Device-to-Device Sync — Architecture RFC

**Status:** Draft — RFC ONLY. No implementation code in this PR.
**Author:** Architecture pass, 2026-05-31. User open-question resolutions folded 2026-06-01.
**Supersedes:** none.
**Cross-refs:** `docs/architecture/porch-design.md` (porch + Phase F device-pairing CRDT), `docs/architecture/user-management-design.md` (Phase 1 profiles + keychain), `src-tauri/src/servitude/identity.rs` (per-install Ed25519 seed), `docs/architecture/concord-user-protocol-scope.md` (Architecture A), `docs/architecture/peer-presence-timeout-scope.md` (Architecture B), `docs/architecture/tailscale-gated-hero-sync-scope.md` (Architecture C), `docs/architecture/resumable-conflict-agent-scope.md` (Architecture D), `docs/architecture/hard-disconnect-on-close-scope.md` (Architecture E).

## Status

- Last user input: 2026-06-01.
- All eight open-question markers resolved.
- 5 new architecture scope-documents created in `docs/architecture/`.
- Remaining work: implementation dispatches for Architectures A through E.

This RFC defines the **hero account** — a cross-device user identity in Concord — and the **device-to-device sync** model that lets two installs owned by the same hero mirror their local-server data in an Obsidian-style append-only fashion.

This document is **normative**. It states what Concord does and why; it no longer carries open-question markers.

---

## 1. What is a hero account?

A **hero account** is a long-lived cross-device user identity in Concord. It binds together the per-install identities that exist on every device the same human signs into, so the human can use Concord on (say) a desktop and a phone without those installs being treated as two strangers. When a hero is signed into two installs, those installs gain the option (opt-in, revocable) to mirror their persistent local-server data — channels, messages, voice rooms, applications, themes, vault bindings, ACLs — so the human sees one continuous Concord, not two.

The hero account is **identity**, not **hosting**. It does not move the user's data to a server. Each install continues to host its own local server (the SQLite database described in `porch-design.md`); the hero account just gives those installs a shared notion of "us" that lets them sync.

A hero account is OPTIONAL. An install with no hero account is fully functional — it just can't sync with other installs the user owns, and it can't bring its identity to a new device. This matches the user's intent: the porch + local server work standalone; the hero is an add-on for people who want continuity across devices.

---

## 2. Source of truth for hero identity

The hero account has **no external master instance and no DNS-anchored or DID-anchored source of truth**. It is locally created on a virgin install with the same friction as any other UI step, and the locally-created user IS that install's hero. The hero can be changed to any profile the user wants. There is no required anchor; the only authoritative source of truth for the hero is the hero's own seed-mnemonic, held by the user. Concord recommends no other source of truth.

The hero is advertised to peers on the p2p network using a vanity name plus a machine-readable address. Peers display that pairing as a human-readable identity according to their own preferences.

### 2.a Cross-instance profile sharing — the Concord-native user-definition protocol

Because there is no external anchor, Concord cannot rely on Matrix or a master instance to reconcile two records of the same hero seen by two different parties. That reconciliation is the job of the **Concord-native user-definition protocol** — a transport-agnostic identity bridge that spans Matrix federation, libp2p porch, and Concord-via-domain HTTP.

The protocol's defining contract: given a configurable level of trust between two instances, those instances can share a user profile. Without that trust, identity records accumulate **per-server**, NOT per-device — the intentional effect is that one user can present completely different impressions on two different servers with ease. The interaction with bots and programmatic chat applications is an open follow-up captured in the scope document.

See `docs/architecture/concord-user-protocol-scope.md` for the scope of this protocol and the list of follow-up tasks it will trigger.

### 2.b Why no anchor

1. **The user is the only authority.** A hero owns their seed-mnemonic; that's the recovery and re-issue path. No external party can revoke or relocate the hero on the user's behalf.
2. **Per-server identity isolation is a feature.** Without a global anchor, the same person can be one persona on Server X and another on Server Y without those servers ever learning that the personas belong to one human. A master-instance design would erode that property.
3. **Cross-instance interop becomes the user-definition protocol's job, not a hidden side-effect of Matrix federation.** Concord deliberately owns the reconciliation contract end-to-end via Architecture A rather than borrowing Matrix's homeserver-anchored model.
4. **Recovery UX is preserved.** Seed-mnemonic export and import remain the only durable recovery path. The user-management Phase 1 note that *"seed-mnemonic export/import is the load-bearing follow-up"* applies directly.

### 2.c Per-device revocation

A device is revoked by removing its `DeviceLinkCert` from the local cert lists held on every other device of the hero. The revocation is propagated through the same sync substrate that distributes the cert list; existing sessions on the revoked device tear down on the next app close because Concord does not maintain background connections (see Architecture E below).

---

## 3. Binding hero account → per-install libp2p peerids

Every Concord install holds an Ed25519 seed in Stronghold (see `src-tauri/src/servitude/identity.rs`). That seed derives:
- The Phase 2 fingerprint (base32 of SHA-256 of the public key).
- The libp2p `PeerId` (multihash of the libp2p public-key encoding of the same seed).

Both are the **per-install** identity. They do NOT cross devices. Even if the same human signs into Concord on a desktop and a phone, those two installs hold two independent Stronghold seeds and present two independent peerids on the libp2p swarm.

The hero account binds these two peerids by issuing a **device-link certificate** that says "peerid X and peerid Y both belong to hero H." This certificate is the cryptographic proof that lets device A trust an inbound sync request from device B even though their peerids are unrelated.

### 3.a Device-link certificate format

A device-link certificate is an Ed25519-signed payload:

```text
DeviceLinkCert {
    hero_pubkey:          [u8; 32],          // the hero's public key
    device_peerid:        PeerId,            // the libp2p peerid being linked
    device_label:         String,            // e.g. "Colton's MacBook"
    issued_at:            u64,               // unix seconds
    nonce:                [u8; 32],          // OS CSPRNG; persisted on each device of the hero for replay protection
    signature:            [u8; 64],          // Ed25519(hero_seed) over the canonical encoding of the above
}
```

The hero seed is held by the user (encrypted in Stronghold on whichever device originated the hero, mirrored by mnemonic export). The signing device — whichever holds the seed at link time — signs the certificate locally. There is no `expires_at` field: Concord does not use time-bounded device-link tokens. Sessions tear down on app close (see §3.d, Architecture E).

Each install stores a list of `DeviceLinkCert`s for **itself + every other linked device of the same hero**. The list is loaded into memory on boot, refreshed on every sync exchange that reveals a new linked device, and consulted on every inbound sync handshake.

### 3.b Cross-device key exchange (link flow)

**Scenario.** User has Concord on device A (already running hero H). User installs Concord on device B and wants to add it.

1. **Device B and device A meet via the pairing flow.** Pairing reuses the QR + paired-peer-card mechanism already shipped in PR #87. Device B advertises its peerid; device A scans the QR (or vice versa).
2. **Device A signs B's cert.** Device A, holding the hero seed, signs a `DeviceLinkCert` over B's peerid with the hero's key and hands the cert to B over the pairing channel. A also adds B's cert to its own list and records B as a linked device of the hero.
3. **B trusts A reciprocally.** If A was not already linked to B's cert list (this is B's first link to any hero device), A also issues itself a cert in B's view. From this point B can trust inbound sync from A and any other device A vouches for.
4. **Devices exchange linked-device manifests on next sync.** When A and B meet on the libp2p swarm, the sync handshake exchanges full linked-device manifests so any other devices A and B know about are added to both lists.

Replay protection comes from the per-device nonce store + the lack of any long-lived session credential. Each device tracks `(hero_id, nonce)` for every certificate it has accepted and refuses a duplicate. Because tokens have no TTL and sessions hard-disconnect on app close (§3.d), the long-running-token attack surface is intentionally minimal.

### 3.c Revocation

Revocation of a device is performed by removing its `DeviceLinkCert` from each remaining linked device's cert list. The removal propagates through the same sync substrate that distributes manifests. The revoked device retains its already-replicated home-server data — Concord cannot reach across to wipe a device the user no longer trusts — but it can no longer authenticate as a hero device on inbound sync handshakes from the others.

### 3.d Session lifecycle — hard-disconnect on app close

Concord does NOT use TTL-bounded device-link tokens. The session-lifecycle question that a TTL would answer is instead answered by the connection lifecycle: a session is alive only while the user is actively interacting with the running app. Closing the app **hard-disconnects** every native peer-to-peer connection — porch greet, home sync, server discovery, address rotation, history fetch, export delivery, and the WireGuard tunnels themselves. No background daemon. No warm-resume. Re-connect must be cheap on next launch; cold-start cost is acceptable; each device retains full control over its connectivity.

This is the standing pattern; it is scoped in `docs/architecture/hard-disconnect-on-close-scope.md` (Architecture E). Every subsystem in this RFC that opens a native connection registers with the exit handler defined there.

### 3.e Sync handshake — what gets verified

When device A receives an inbound `PullDelta` or `PushDelta` from peerid X over `/concord/porch-sync/1.0.0` (the existing Phase F protocol), the handshake check is hero-aware:

1. **Old path (Phase F bilateral device pairing):** Check `device_links` table for a row matching `(my_peerid, X)`. If present, accept. This path stays for backward compatibility — installs without a hero can still pair bilaterally.
2. **New path (hero membership):** Look up X's `DeviceLinkCert` in the local cert list. If present, verify: (a) `hero_pubkey` matches MY hero, (b) `device_peerid` matches X, (c) signature verifies against `hero_pubkey`, (d) `nonce` hasn't been seen on this device for this `(hero, device)` pair before. If all pass, accept. Cert lookup is a HashMap by peerid; the verification is one Ed25519 verify (~50µs).

Both paths feed the same downstream sync engine. The hero path is a richer authorization layer above bilateral pairing.

Additionally, hero-mediated sync between two same-hero instances has a second precondition: **mesh-VPN reachability** (Tailscale or equivalent) must be verified between the two machines, AND the shared hero must be confirmed on the protocol level. Either gate fails, no sync. This is the Tailscale-gated hero sync rule scoped in `docs/architecture/tailscale-gated-hero-sync-scope.md` (Architecture C). When the user has elected a docker instance as the sync anchor, the docker mediates; without an anchor, all sync cycles are fully additive p2p merges.

---

## 4. Mirror-mode opt-in

The user said: *"Signing into the same hero account on two devices unlocks an OPTIONAL mode: the two devices share their backend data and host MIRRORED local servers."*

Linking a device to a hero does NOT automatically mirror its local-server data. Mirror-mode is a separate consent.

### 4.a Consent UX

Two trigger paths:

1. **First link on a fresh device.** When device B finishes the link flow (3.b), it has an empty local server (porch + default channel only). After the link, B's "Welcome" screen presents one of three explicit choices:
   - **"Start fresh on this device"** — B keeps its empty local server. No mirroring. The hero account still lets B join other hero devices' local servers as a visitor, but B doesn't replicate their data.
   - **"Mirror your existing devices"** — B requests an initial sync from a chosen source device (default: the most recently active linked device). B's local server is populated from that source. From then on, B is a mirror.
   - **"Mirror but ask first about new rooms"** — B mirrors existing data but every NEW channel created on any other device pops a confirmation on B before B replicates it. Useful for users who want a "main + backup" topology where the backup deliberately stays curated.
2. **Existing device gains a sibling.** If device A is already running standalone and device B comes online as a fresh-linked sibling, A is prompted: "Device 'Phone' wants to mirror your local server. Allow?" If A says yes, the sync handshake unlocks the local server's CRDT data; if A says no, B can still try other linked devices (or fall back to the "Start fresh" option).

The consent is recorded as a row in a new `mirror_consents` table (schema below) keyed by `(my_hero, peer_device_peerid)`. The row carries `mode: full | curated | none` and an `effective_at` timestamp.

### 4.b Decline + un-mirror

- **Decline** at the consent prompt → no row is written; the device pair stays linked-but-not-mirroring.
- **Un-mirror later** → Settings → Hero Account → Devices → "Stop mirroring [Phone]". This sets `mode = none` and writes a tombstone. Data already replicated to the un-mirrored device is NOT remotely deleted (the user can't reach across to wipe a device they no longer trust); the un-mirrored device keeps its local copy. Going forward, no new sync exchanges happen.

A device that un-mirrors is functionally back to "linked but standalone." It can re-mirror later (UI offers it as a one-click re-enable). Re-mirroring triggers a full reconciliation pass (4.c below) to catch up.

### 4.c Initial sync (cold start)

When a device first enters mirror-mode, it doesn't have anything to compare against — it's empty (or stale). Initial sync is a full pass: device B sends `PullDelta { since: SyncCursor::Epoch }` (the existing Phase F cursor type, with the zero value), and device A streams every non-tombstoned row from every CRDT-tracked table. The user sees a progress bar; the rooms / messages / themes / vault bindings appear as they arrive.

After the initial sync completes, B is at parity with A. Subsequent sync exchanges are incremental (Phase F's existing delta protocol).

**Initial-sync ordering.** Concord reuses the existing UI elements and templates from the rest of the display. The order in which the receiving device materializes the synced content is fixed: **text channels first → voice channels → available applications**. The user retains the ability to refine this menu's ordering in a later iteration, but text → voice → applications is the baseline.

---

## 5. Sync mechanics — Obsidian-style

The user's framing: *"Merging is append-only and additive — no destructive overwrites… the 'traveler returns to find' the state the other device was in; their own additions merge in… If one merge operation breaks another, the conflict is flagged. Flagged conflicts are handed to an agent in a parallel session to solve."*

The existing Phase F porch sync (shipped `feat/porch-phase-f-sync-impl` 2026-05-31) already gives us the substrate: per-row `(sync_device_id, sync_lamport, sync_tombstone)`, LWW comparator with device-id tiebreak, per-table CRDT, `/concord/porch-sync/1.0.0` protocol with `PullDelta` / `PushDelta`. This RFC layers the hero account + the conflict-flag-to-agent handoff ON TOP of that substrate.

### 5.a Data model — append-only event log

The user described this as Obsidian-style — additive, no destructive overwrites. The existing Phase F CRDT is LWW (last-write-wins), which IS destructive at the row level (a later write replaces an earlier one). For most fields (channel name, theme primary color), LWW is fine — the user doesn't expect two devices' simultaneous renames to both stick.

But for the conflict-detection layer, we need a true append-only event log so we can SEE that there were two concurrent writes and decide whether the loss is acceptable. Proposal:

Every CRDT-tracked write also produces an entry in a new `event_log` table:

```sql
CREATE TABLE event_log (
    event_id          BLOB PRIMARY KEY,        -- ULID, monotonically sortable
    parent_event_id   BLOB,                    -- the event this device last observed on this (table, row_id)
    table_name        TEXT NOT NULL,           -- porch_channels | channel_messages | …
    row_id            TEXT NOT NULL,           -- ULID of the affected row
    payload           BLOB NOT NULL,           -- CBOR-encoded delta: {field: new_value, …}
    signer_peerid     BLOB NOT NULL,           -- libp2p PeerId of the device that wrote this event
    signed_at         INTEGER NOT NULL,        -- unix seconds
    signature         BLOB NOT NULL            -- Ed25519 over (event_id || parent_event_id || table_name || row_id || payload || signer_peerid || signed_at)
);

CREATE INDEX event_log_by_row ON event_log(table_name, row_id, signed_at);
```

- **Append-only**: events are never updated or deleted (a tombstone-row is itself an event with payload = `{tombstone: true}`).
- **Parent pointer**: each event records the event ID it superseded as observed on the writing device. Two devices that didn't observe each other will both point at the same parent — that's the concurrent-write detector.
- **Signed**: every event carries an Ed25519 signature from the writing peer. Sync receivers verify before applying.

When sync exchanges happen, the event log is streamed alongside the row-level CRDT updates. A receiver applies the LWW row update AND inserts the event into its log. The log is the audit trail.

The CRDT row tables (`porch_channels`, `channel_messages`, etc.) stay as the materialized view; the event log is the source of truth that lets us detect (and surface) concurrent edits.

### 5.b Sync protocol — extending `/concord/porch-sync/1.0.0`

Two additive variants on the existing protocol:

```
PullEvents { since: EventCursor }    // last event_id this device knows per (table, row_id)
PushEvents { events: Vec<Event> }    // event log entries to apply
```

Plus the existing `PullDelta` / `PushDelta` for the row-level CRDT view. The two paths run in parallel — event log keeps the audit trail, row updates keep the materialized view. A future cleanup could collapse them into one, but for the RFC the simplest path is "add events alongside, change nothing existing."

`EventCursor` is `Map<(table_name, row_id), event_id>` — the last event each device knows per row. Missing entries are sent in full. On reconnect, devices exchange cursors and stream missing events in `signed_at` order.

### 5.c Conflict types — only DESTRUCTIVE conflicts get flagged

The user said: *"only DESTRUCTIVE conflicts (concurrent state changes that can't both apply) get flagged."*

Two events are concurrent if neither is an ancestor of the other in the parent-pointer chain. Concurrent events are NOT inherently destructive — most are additive (two devices each posted a different message; both messages exist; no conflict). A concurrent event becomes a destructive conflict when applying both produces an inconsistent state.

Three concrete examples:

1. **Concurrent channel rename.** Device A renames `#general` to `#announcements`. Device B, simultaneously offline, renames `#general` to `#main`. Both events have the same parent. After sync, the LWW comparator picks one (lamport-then-device-id), but the LOSING name is silently dropped. The user on the losing device sees their rename vanish. **Destructive.** Flag.

2. **Concurrent channel delete + post.** Device A deletes `#old-stuff` (writes a tombstone event). Device B, offline, posts a long message in `#old-stuff` (writes a message event whose parent is the channel's pre-tombstone state). After sync, the message exists but its channel is tombstoned, leaving an orphaned message. **Destructive.** Flag.

3. **Concurrent user-role change.** Device A grants user U the `member` ACL on `#secret-room`. Device B, offline, revokes U from the same room (tombstones the ACL row). After sync, LWW picks one — but the security implication of which one wins is qualitatively different (granting access vs. revoking it). The user MUST be told. **Destructive.** Flag.

Other concurrent events (two messages in different channels, two theme tweaks on different channels, two vault bindings on different roots) are NOT destructive — both apply independently. Detected concurrency on those rows is logged at `trace` level and does not surface.

Detection rule: at event-application time, if a NEW event's `parent_event_id` is NOT the row's current "head" event, AND the event class is in the destructive-conflict allow-list (rename / tombstone-vs-write / acl-change), enqueue a `conflict_queue` row.

```sql
CREATE TABLE conflict_queue (
    conflict_id       BLOB PRIMARY KEY,        -- ULID
    detected_at       INTEGER NOT NULL,
    table_name        TEXT NOT NULL,
    row_id            TEXT NOT NULL,
    event_a_id        BLOB NOT NULL,           -- FK event_log.event_id
    event_b_id        BLOB NOT NULL,
    conflict_kind     TEXT NOT NULL,           -- 'concurrent_rename' | 'tombstone_vs_write' | 'acl_change' | …
    status            TEXT NOT NULL DEFAULT 'pending',  -- pending | resolved | abandoned
    resolved_at       INTEGER,
    verdict           BLOB                     -- CBOR of the agent's verdict (5.d)
);
```

### 5.d Conflict-resolution handoff — to a parallel-session agent

The user said: *"Flagged conflicts are handed to an agent in a parallel session to solve. This is a built-in architectural choice: AI agents are part of the sync infrastructure."*

Concord ships with an agent dispatch surface (orrchestrator integration). Conflicts surface in a UI panel ("Sync conflicts — N pending") and the user can:

1. **Auto-dispatch to an agent.** Push the conflict payload to a configured agent endpoint (default: the user's orrchestrator install, or a local Claude / local LLM if configured). The agent receives the payload, returns a verdict, the local Concord applies it.
2. **Resolve manually.** Show a diff UI ("Device A renamed to '#announcements', Device B renamed to '#main' — which one wins?") and let the user click.

**Agent handoff API surface:**

```rust
// Sent to the agent:
ConflictHandoffRequest {
    conflict_id:    Ulid,
    conflict_kind:  ConflictKind,
    table_name:     String,
    row_id:         String,
    event_a:        EventPayload,         // includes parent_event_id, payload, signer_peerid, signed_at
    event_b:        EventPayload,
    context:        ConflictContext,      // adjacent rows, e.g. channel name + recent messages for a rename conflict
    suggested_verdicts: Vec<SuggestedVerdict>,  // heuristic-generated options (e.g. "keep A", "keep B", "combine as 'announcements-main'")
}

// Returned by the agent:
ConflictVerdict {
    conflict_id:    Ulid,
    verdict_kind:   VerdictKind,  // PickA | PickB | NewValue { payload: CborValue } | Defer
    rationale:      String,       // human-readable; logged + shown in UI
    confidence:     f32,          // 0.0..=1.0; below threshold → require user confirmation before applying
    agent_signature: Option<Vec<u8>>,  // optional Ed25519 sig from the agent's identity key
}
```

**Applying the verdict.** The local Concord:
1. Verifies the verdict references a still-pending `conflict_id`.
2. If `verdict_kind == NewValue`, writes a new event that supersedes BOTH `event_a` and `event_b` (parent_event_id is a 2-element list pointing at both — extending the event log model to allow merge events).
3. If `verdict_kind == PickA` / `PickB`, writes a "ratify" event whose payload re-asserts the winner.
4. The new event syncs back to every other linked device, where it short-circuits the same conflict queue ("already resolved").
5. `conflict_queue.status` → `resolved`, `verdict` recorded.

**Where does the agent live?**

- **Default: orrchestrator.** Concord checks for a running orrchestrator instance on the local machine (TCP loopback or unix socket) and offers it as the conflict-resolution agent. orrchestrator can dispatch to Claude, a local LLM, or any of its registered agent profiles. This is the canonical path.
- **Fallback: in-app heuristic.** If no agent is configured, the UI offers heuristic suggestions (rename → "combine both names", tombstone-vs-write → "keep the write, the channel must exist") and asks the user to click one. This keeps Concord functional without orrchestrator.
- **Power-user: HTTP webhook.** Settings → Hero Account → Conflict Agent → "Send conflicts to:" with a URL field. Same JSON envelope shape; the user can wire it to anything.

**Agent verdict confidence threshold.** The auto-apply threshold is **per-conflict-kind**. There is no single global threshold; each conflict kind carries its own override. Lower-confidence verdicts on safety-sensitive conflict kinds (e.g. `acl_change`) require user confirmation before applying, while higher-confidence verdicts on cosmetic conflict kinds (e.g. `concurrent_rename`) can auto-apply at lower thresholds.

**Agent timeout.** When an agent times out, Concord **stops the timed-out process, integrates its session context into a new agent session, and picks up where the previous session left off.** The conflict-resolver loop is resumable across agent sessions — dead-session context flows into the next session. This is a standing architectural pattern: any long-running AI sub-task in Concord follows the same resume model. Scoped in `docs/architecture/resumable-conflict-agent-scope.md` (Architecture D).

**Multi-device convergence on a conflict.** If devices A and B both detect the same conflict at the same time, they both dispatch to the agent and two verdicts arrive. Concord applies the higher-confidence verdict; on confidence tie, it falls back to Lamport timestamp then device-id. This is the RFC's recommended choice and is now normative.

---

## 6. Out of scope

This RFC is JUST the hero account + sync layer. Explicitly NOT covered:

- **Porch ephemeral semantics** — covered in F1-REVISED (`docs/architecture/porch-design.md` rev that adds the ephemeral porch room to the persistent local-server schema).
- **Unified add-source flow** — covered in F2 (the source-rail picker for Concord instances, Matrix homeservers, paired peers, etc.).
- **libp2p mesh propagation** — covered in F3 (gossip + relay + DCUtR tuning for porch-sync over WAN).
- **Account-relay flow over `/concord/account-relay/1.0.0`** — covered in user-management Phase 3. The hero account can USE the relay protocol to back up its keychain to a docker anchor it has elected (Architecture C), but the relay protocol itself is its own design.
- **Cross-protocol user-definition protocol** — covered in `docs/architecture/concord-user-protocol-scope.md` (Architecture A).
- **Docker-anchor election UX** — covered in `docs/architecture/tailscale-gated-hero-sync-scope.md` (Architecture C) and broader docker-install onboarding work, separate sprint.
- **Mobile lifecycle for hero-aware sync** — covered in INS-022's foreground/background glue. Mobile installs sync only when foregrounded (existing constraint).
- **WireGuard tunnel hardening** — covered in porch Phase G. The hero protocol runs over the same libp2p paths; if Phase G's connection gate is enforced, hero-linked peers must also reach each other through a trusted tunnel CIDR.

---

## 7. Implementation phases

After this RFC is approved, four `develop_feature` dispatches form the build queue.

### Phase H1 — Hero identity primitives + local hero creation

**Goal.** A user can create a hero account locally on a virgin install and link a second device by exchanging signed certificates over the existing pairing flow.

**Acceptance.**
- New schema migration adds `hero_accounts` (hero_id ULID, hero_pubkey, created_at) + `device_link_certs` (cert_id ULID, hero_id FK, device_peerid, label, issued_at, nonce, signature). No `master_instance_url`, no `expires_at` — the hero is locally created and certs do not expire (revocation is removal-from-list).
- New libp2p protocol `/concord/hero-link/1.0.0` for peer-to-peer cert exchange between same-hero devices: `OfferLink { my_peerid, label }`, `AcceptLink { signed_cert }`, `ExchangeManifest { linked_devices }`.
- Tauri commands: `hero_create`, `hero_link_device`, `hero_list_my_devices`, `hero_revoke_device`, `hero_export_mnemonic`, `hero_import_from_mnemonic`.
- React surface: Settings → Hero Account tab with hero-creation flow, device list, "Approve pending link" notification, mnemonic export modal.
- Tests: cert-exchange integration tests (create + link + revoke), unit tests for the certificate signature verification, vitest for the React surface.

**Estimated size:** large. Spans backend protocol + frontend onboarding.

**Note.** The cross-protocol user-definition protocol (Architecture A) is a separate dispatch and is NOT part of Phase H1. H1 ships the local cert primitives; A ships the cross-transport user record.

### Phase H2 — Mirror-mode consent + initial sync

**Goal.** Two linked devices can opt into mirror-mode and complete an initial full-sync; the user sees their channels appear on the new device.

**Acceptance.**
- New schema adds `mirror_consents` table.
- Hero-aware sync handshake on `/concord/porch-sync/1.0.0`: receivers check `device_link_certs` in addition to `device_links`.
- "Welcome to your hero" screen on a newly-linked device with the three-way choice (start fresh / mirror / mirror-with-confirm).
- A → B initial sync uses existing `PullDelta { since: SyncCursor::Epoch }` and streams all non-tombstoned CRDT rows.
- Tests: two-Concord-instance integration test that links a fresh device and verifies its DB matches the source.

**Estimated size:** medium. Leans heavily on existing Phase F sync.

### Phase H3 — Event log + concurrent-write detection

**Goal.** Every CRDT write also produces a signed event in `event_log`. Concurrent writes that match the destructive-conflict allow-list enqueue a `conflict_queue` row. UI surfaces "N sync conflicts pending."

**Acceptance.**
- New schema adds `event_log` + `conflict_queue` tables.
- Sync protocol extended additively with `PullEvents { since: EventCursor }` + `PushEvents { events: Vec<Event> }`.
- Detector code in `crate::porch::sync` enqueues conflicts for `concurrent_rename` / `tombstone_vs_write` / `acl_change`.
- React surface: "Sync conflicts" badge on the Hero Account tab; conflict-list view with a placeholder "Resolve" button.
- Tests: two-device integration tests that produce each of the three destructive-conflict types and verify exactly one row lands in `conflict_queue`.

**Estimated size:** medium-large. Event log is new infrastructure but doesn't require a hero account to function — it's useful for Phase F's bilateral device pairing too.

### Phase H4 — Agent-dispatch resolution + manual resolution UI

**Goal.** A pending conflict can be resolved (a) by dispatching to an orrchestrator agent, (b) by a configured HTTP webhook, or (c) by the user picking from heuristic-generated options.

**Acceptance.**
- Settings → Hero Account → Conflict Agent: dropdown (orrchestrator / webhook URL / manual-only).
- Conflict-handoff payload + verdict types codified as documented in 5.d.
- "Resolve" button on each `conflict_queue` row triggers the configured agent or opens the manual-resolve modal.
- Verdict application writes a new event whose parent is BOTH original events, marks the conflict resolved, and syncs back to every linked device.
- Tests: stub-agent integration test (returns canned verdicts), end-to-end test that runs a rename conflict, dispatches to the stub, applies the verdict, and verifies both devices converge on the verdict-chosen name.

**Estimated size:** medium. The agent surface itself is small; most complexity is in the merge-event semantics + cross-device convergence.

---

## 8. Recap

- **Hero account** = a cross-device user identity. Optional. Doesn't replace per-install identity; binds two or more per-install identities together.
- **Source of truth: the hero's own seed-mnemonic.** Hero is locally created on a virgin install. No external anchor, no master instance, no DID, no DNS. Cross-instance profile sharing happens via the **Concord-native user-definition protocol** (Architecture A).
- **Per-server identity isolation by default.** Without a trust-gated profile merge, identity records accumulate per-server, not per-device — one user can present completely different impressions on two servers.
- **Binding** = a device holding the hero seed signs `DeviceLinkCert`s that map peerids to hero pubkeys; sync handshakes check these certs. No TTL; revocation is a removal-from-list operation.
- **Session lifecycle** = hard-disconnect on app close (Architecture E). No background daemon; cold-start cost is acceptable.
- **Mirror-mode** = an explicit second consent; declining link still gives cross-device identity but no data sync. Sync is additionally gated by mesh-VPN reachability (Architecture C, Tailscale-gated).
- **Peer-presence + access** = per-connection expiry policy; expired peers become visibility-only until host re-affirms (Architecture B).
- **Sync** = layered on top of the existing Phase F porch CRDT, plus a new append-only `event_log` that lets us detect destructive concurrent writes.
- **Initial-sync ordering** = text channels first → voice channels → applications.
- **Conflict resolution** = enqueued + handed to an orrchestrator agent (or HTTP webhook, or manual UI). Verdict becomes a merge event that propagates to every linked device. Per-conflict-kind confidence threshold. Agent timeout = stop + resume in a new session with context inlined (Architecture D). Multi-device convergence = higher-confidence verdict wins; tie → Lamport then device-id.
- **Phases** = H1 hero identity → H2 mirror consent + initial sync → H3 event log + conflict detection → H4 agent dispatch. Architectures A through E will be dispatched as follow-up implementations after the RFC lands.

# Hero Account + Device-to-Device Sync — Architecture RFC

**Status:** Draft — RFC ONLY. No implementation code in this PR.
**Author:** Architecture pass, 2026-05-31.
**Supersedes:** none.
**Cross-refs:** `docs/architecture/porch-design.md` (porch + Phase F device-pairing CRDT), `docs/architecture/user-management-design.md` (Phase 1 profiles + keychain), `src-tauri/src/servitude/identity.rs` (per-install Ed25519 seed).

This RFC defines the **hero account** — a cross-device user identity in Concord — and the **device-to-device sync** model that lets two installs owned by the same hero mirror their local-server data in an Obsidian-style append-only fashion.

This document is **opinionated**: it recommends ONE source-of-truth model and ONE sync protocol. Items that the user must genuinely pick between are marked `[OPEN QUESTION]`.

---

## 1. What is a hero account?

A **hero account** is a long-lived cross-device user identity in Concord. It binds together the per-install identities that exist on every device the same human signs into, so the human can use Concord on (say) a desktop and a phone without those installs being treated as two strangers. When a hero is signed into two installs, those installs gain the option (opt-in, revocable) to mirror their persistent local-server data — channels, messages, voice rooms, applications, themes, vault bindings, ACLs — so the human sees one continuous Concord, not two.

The hero account is **identity**, not **hosting**. It does not move the user's data to a server. Each install continues to host its own local server (the SQLite database described in `porch-design.md`); the hero account just gives those installs a shared notion of "us" that lets them sync.

A hero account is OPTIONAL. An install with no hero account is fully functional — it just can't sync with other installs the user owns, and it can't bring its identity to a new device. This matches the user's intent: the porch + local server work standalone; the hero is an add-on for people who want continuity across devices.

---

## 2. Source of truth for hero identity

The user's note: *"A hero account is anchored to 'an agreed upon source of truth' (DID, DNS-anchored identity, or another agreed mechanism — design choice deferred)."*

Three candidates, then a recommendation.

### 2.a Candidate A — DID (Decentralized Identifier) via did:key or did:web

A W3C DID is a URI that resolves to a public key (or to a key-holding document). Two sub-flavors:

- **did:key** — the DID is literally `did:key:z<base58-multibase(public_key)>`. No network resolution, no anchoring, the DID IS the key. Self-sovereign in the purest sense: anyone can verify a signature against the DID with no infrastructure.
- **did:web** — the DID is `did:web:example.com:hero:<slug>`, resolved by fetching `https://example.com/.well-known/did/hero/<slug>/did.json`. A DNS-anchored DID document holds the current keyset and lets the user rotate keys without changing the identifier.

| Aspect | did:key | did:web |
|---|---|---|
| Bootstrap UX | one button: generate key, encode | requires a domain the user controls (most don't) |
| Recovery from lost device | possession of any device holding the seed, OR the seed-mnemonic export (Phase E follow-up) | re-publish the DID doc from any device that still has DNS access |
| Revocation | nothing built in — compromise = whole identity gone (or you rotate the DID, losing continuity) | edit the DID doc to remove the compromised key; old signatures still verify, future ones won't |
| Interop with Matrix / federated Concord | none — Matrix uses its own user IDs; the DID is opaque to Matrix | none directly, but did:web's `https://` resolution is at least familiar |
| Custody | the user holds the seed; the user is the CA | the user holds the seed AND owns a domain; DNS is the trust anchor |

did:web is essentially "your homeserver IS your identity" with a fancier name. did:key is purely cryptographic.

### 2.b Candidate B — A user-chosen master Concord instance acting as the identity anchor (Matrix-style)

The hero account is `@hero-name:concord-instance.example` — the user picks ONE Concord instance (a docker deployment, theirs or a friend's, or a trusted public one) to host their account record. Every other install signs into the hero by authenticating against that instance.

This mirrors Matrix homeservers exactly, which is intentional — the existing user-management Phase 3 (`/concord/account-relay/1.0.0`) was already heading this direction.

| Aspect | Master-instance anchor |
|---|---|
| Bootstrap UX | pick an instance from a list (or accept the bundled default), create credentials, done. Familiar mental model. |
| Recovery from lost device | sign back into the master instance from any new device with passphrase / linked-device approval |
| Revocation | the master instance revokes the device's grant; subsequent libp2p connections from that device's peerid stop being recognized as the hero |
| Interop with Matrix | the master instance IS a Matrix homeserver (conduwuit). Federation comes for free. |
| Custody | the user trusts the master instance operator (themselves, if they self-host; someone else if they don't) |
| Failure mode | master instance disappears → hero is stuck on existing devices but can't bring identity to new ones until they migrate the account elsewhere |

### 2.c Candidate C — Pure cryptographic key-pair, no anchor at all

The hero is a public key the user generates on the first device and copies (QR / mnemonic / encrypted file) to every other device they want to bind. There is no DID URI, no resolution, no homeserver — just a 32-byte public key that signs cross-device pairing tokens.

| Aspect | Pure key-pair |
|---|---|
| Bootstrap UX | first device: generate key + 24-word mnemonic, user writes it down. Second device: type mnemonic OR scan QR off the first device. |
| Recovery from lost device | mnemonic recovery, full stop. No mnemonic = identity gone forever. |
| Revocation | rotate the hero key on every linked device; old key is now untrusted. Lossy — you lose the device-link history. |
| Interop with Matrix / federated Concord | none. Matrix users don't know what a hero key is. |
| Custody | purely the user, no third party at all |

### 2.d Recommendation: **Candidate B (master Concord instance anchor)** with mnemonic-export as the escape hatch

**Why B and not A or C:**

1. **Interop matters more than purity.** Concord federates over Matrix. A hero account whose identity also happens to be a Matrix user ID gets cross-Concord-instance presence, cross-instance DM, federated room membership, and Phase 3's account-relay flow for free. did:key and pure key-pairs get none of that — they'd require building a parallel identity plane on top of Matrix's.
2. **Concord already chose this shape.** User-management Phase 3 explicitly designs an `/concord/account-relay/1.0.0` protocol where a docker Concord instance acts as the anchor. The codebase, the keychain layer, and the synced-tables CRDT are already aimed here. Switching to did:key or pure-key-pair would burn that work.
3. **Recovery UX is good enough.** Lost device → sign back into the master instance with passphrase + linked-device approval. The user is already used to this workflow (it's how every Matrix client recovers).
4. **The master instance can be the user's own.** A power user who doesn't want to trust a third party self-hosts (Concord is already a docker install). They become their own CA. For someone who doesn't want to self-host, they pick a public Concord instance — same trust model as picking a Mastodon home server.
5. **did:key fans don't lose much.** Below the master-instance layer the hero key IS still an Ed25519 keypair the user owns; the master instance just publishes the public key and brokers device-link requests. A future "export as did:key" feature could surface the same public key in DID form if it ever became useful.

**Escape hatch — seed-mnemonic export.** The user-management Phase 1 already notes: *"Seed-mnemonic export/import is the load-bearing follow-up that unlocks cross-device restore from a true loss event."* The hero account inherits this — the master-instance auth is the day-to-day path, but the user can always export the hero seed as 24 words and rebuild the hero on a new master instance if the original instance dies. This is what makes the master-instance choice not-lock-in.

**Trade-off summary of the recommendation:**

| | Master-instance anchor (recommended) |
|---|---|
| Bootstrap UX | Sign up on a Concord instance the way you sign up on Mastodon / Matrix today. Bundled default for new users; "pick another" for power users. |
| Recovery | Passphrase + a linked device approves the new device. If everything is lost, use the 24-word seed mnemonic to rebuild on a fresh instance. |
| Revocation | Per-device revocation handled by the master instance: it stops issuing fresh device-link tokens to the revoked peerid. Existing sessions on that device continue until their token expires (token TTL: `[OPEN QUESTION]` — 24h vs 7d vs 30d). |
| Interop with Matrix | Native — the master instance IS a conduwuit homeserver; the hero IS a Matrix user. Federation across Concord instances works through existing Matrix federation. |
| Interop with non-hero federated Concord users | They see a normal Matrix user. Hero-ness is invisible to them. |
| Custody | User-chosen — self-host for full custody, or pick a public instance for convenience. The seed-mnemonic export means even a public-instance hero can leave at any time. |

`[OPEN QUESTION]` — **default master-instance for fresh signups.** Three options: (1) a Concord project-run public instance, (2) prompt the user to pick from a curated list, (3) require self-host. The donation-only model + commercial scope rule out monetizing via a default instance, but operating it has cost. User picks the policy.

`[OPEN QUESTION]` — **device-link token TTL.** 24h (high security, frequent re-auth), 7d (balanced), 30d (low friction). The longer the TTL the longer a revoked device retains access.

`[OPEN QUESTION]` — **multi-master.** Should a hero be allowed to anchor on TWO master instances simultaneously (e.g. for redundancy if one goes down)? Adds complexity to "which one is canonical?" — probably no, recommend single-master with the mnemonic escape hatch.

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
    hero_pubkey:          [u8; 32],          // the hero's master public key
    device_peerid:        PeerId,            // the libp2p peerid being linked
    device_label:         String,            // e.g. "Colton's MacBook"
    issued_at:            u64,               // unix seconds
    expires_at:           u64,               // unix seconds; renewable
    issuer_master_url:    String,            // master instance hostname, for replay-window scoping
    nonce:                [u8; 32],          // OS CSPRNG; persisted at the master for replay protection
    signature:            [u8; 64],          // Ed25519(hero_seed) over the canonical encoding of the above
}
```

The hero seed lives behind the master instance's auth wall, never on the device itself. The master instance signs the certificate on the user's behalf during the link flow (see 3.b below).

Each install stores a list of `DeviceLinkCert`s for **itself + every other linked device of the same hero**. The list is loaded into memory on boot, refreshed on every successful master-instance sign-in, and consulted on every inbound sync handshake.

### 3.b Cross-device key exchange (link flow)

**Scenario.** User has Concord on device A (already signed into hero H). User installs Concord on device B and wants to add it.

1. **Device B asks the master instance.** Device B sends `LinkDeviceRequest { hero_id, my_peerid: <B's peerid>, label: "Phone" }` to the master instance, authenticated by the hero's master-instance passphrase (or, if the user is signed in elsewhere, by an Argon2id-hardened second factor).
2. **Master instance challenges device A.** The master pushes a notification to every other signed-in device of hero H: "Device 'Phone' wants to join your hero. Approve?" Device A surfaces this as a modal showing B's peerid fingerprint and the label B chose.
3. **Device A approves OR the user types the passphrase.** Approval on device A is preferred (the user is already authenticated there). If no other device is online, the user can fall back to the passphrase + a deliberate "this is the first time on this device" checkbox.
4. **Master instance issues two certificates.** For peerid_B (sent to device B over the auth channel) AND for peerid_A (pushed to device A as a refresh — A also gets B's cert added to its list).
5. **Devices A and B exchange certificates over libp2p.** The next time A and B are on the same libp2p swarm (LAN mDNS or via a paired peer-card connection), the sync handshake (4.a below) presents these certificates to each other.

Replay protection comes from the master instance's nonce store + the `expires_at` field. The master tracks `(hero_id, nonce)` for every certificate it issues and refuses to issue a second certificate with the same nonce. A replayed certificate that's past `expires_at` is rejected by the recipient. A replayed certificate that's still in its TTL window is rejected because the receiving device already accepted it.

Downgrade attacks (attacker forces hero to fall back to weaker auth) are out of scope at the protocol level — they're a master-instance auth question. The master enforces a single auth policy per hero (passphrase + Argon2id, or WebAuthn, or device-link approval); downgrade between policies requires explicit user action and a fresh master-side re-enrollment.

### 3.c Sync handshake — what gets verified

When device A receives an inbound `PullDelta` or `PushDelta` from peerid X over `/concord/porch-sync/1.0.0` (the existing Phase F protocol), the handshake check is now hero-aware:

1. **Old path (Phase F bilateral device pairing):** Check `device_links` table for a row matching `(my_peerid, X)`. If present, accept. This path stays for backward compatibility — installs without a hero can still pair bilaterally.
2. **New path (hero membership):** Look up X's `DeviceLinkCert` in the local cert list. If present, verify: (a) `hero_pubkey` matches MY hero, (b) `device_peerid` matches X, (c) signature verifies against `hero_pubkey`, (d) `expires_at` is in the future, (e) `nonce` hasn't been seen on this device for this `(hero, device)` pair before. If all pass, accept. Cert lookup is a HashMap by peerid; the verification is one Ed25519 verify (~50µs).

Both paths feed the same downstream sync engine. The hero path is a richer authorization layer above bilateral pairing.

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

`[OPEN QUESTION]` — **Initial-sync ordering.** Should the user see channels appear in (a) channel-creation order, (b) most-recently-active order, or (c) all-at-once after the whole sync completes? (a) is simplest, (b) is the best UX, (c) is the smallest amount of UI work.

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

`[OPEN QUESTION]` — **agent verdict confidence threshold.** Below what confidence does Concord show the verdict to the user for confirmation before applying? 0.7? 0.8? Per-conflict-kind override?

`[OPEN QUESTION]` — **what happens if the agent times out.** Re-dispatch after N seconds? Move to manual resolution? Leave in queue?

`[OPEN QUESTION]` — **multi-device convergence on a conflict.** If devices A and B BOTH detect the same conflict at the same time (they were both offline, both came back online, both saw the divergence), they both dispatch to the agent. Two verdicts arrive. Whose wins? Recommend: the agent verdict with the higher confidence; on tie, lamport-then-device-id. But this needs user sign-off.

---

## 6. Out of scope

This RFC is JUST the hero account + sync layer. Explicitly NOT covered:

- **Porch ephemeral semantics** — covered in F1-REVISED (`docs/architecture/porch-design.md` rev that adds the ephemeral porch room to the persistent local-server schema).
- **Unified add-source flow** — covered in F2 (the source-rail picker for Concord instances, Matrix homeservers, paired peers, etc.).
- **libp2p mesh propagation** — covered in F3 (gossip + relay + DCUtR tuning for porch-sync over WAN).
- **Account-relay flow over `/concord/account-relay/1.0.0`** — covered in user-management Phase 3. The hero account can USE the relay protocol to back up its keychain to the master instance, but the relay protocol itself is its own design.
- **Concord-instance-as-master-instance UX** — covered in the broader docker-install onboarding work, separate sprint.
- **Mobile lifecycle for hero-aware sync** — covered in INS-022's foreground/background glue. Mobile installs sync only when foregrounded (existing constraint).
- **WireGuard tunnel hardening** — covered in porch Phase G. The hero protocol runs over the same libp2p paths; if Phase G's connection gate is enforced, hero-linked peers must also reach each other through a trusted tunnel CIDR.

---

## 7. Implementation phases

After this RFC is approved, four `develop_feature` dispatches form the build queue.

### Phase H1 — Hero identity primitives + master-instance auth

**Goal.** A user can create a hero account on a Concord instance and sign into it from a fresh install.

**Acceptance.**
- New schema migration adds `hero_accounts` (hero_id ULID, hero_pubkey, master_instance_url, created_at) + `device_link_certs` (cert_id ULID, hero_id FK, device_peerid, label, issued_at, expires_at, nonce, signature).
- New libp2p protocol `/concord/hero-auth/1.0.0` on docker Concord instances: `CreateHero { username, passphrase }`, `LinkDevice { hero_id, my_peerid, auth }`, `ApproveLink { pending_link_id }`, `RotateHero { ... }`.
- Tauri commands: `hero_create`, `hero_sign_in`, `hero_link_device`, `hero_list_my_devices`, `hero_revoke_device`, `hero_export_mnemonic`, `hero_import_from_mnemonic`.
- React surface: Settings → Hero Account tab with sign-in form, device list, "Approve pending link" notification, mnemonic export modal.
- Tests: master-instance integration tests (sign-up + sign-in + link-device + revoke), unit tests for the certificate signature verification, vitest for the React surface.

**Estimated size:** large. Spans backend protocol + frontend onboarding + master-instance Rust changes.

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
- **Source of truth: a user-chosen master Concord instance** (Matrix-anchored, conduwuit-backed), with seed-mnemonic escape hatch for portability. Recommended over did:key (no interop) and did:web (requires DNS custody most users don't have).
- **Binding** = the master instance signs `DeviceLinkCert`s that map peerids to hero pubkeys; sync handshakes check these certs.
- **Mirror-mode** = an explicit second consent; declining link still gives cross-device identity but no data sync.
- **Sync** = layered on top of the existing Phase F porch CRDT, plus a new append-only `event_log` that lets us detect destructive concurrent writes.
- **Conflict resolution** = enqueued + handed to an orrchestrator agent (or HTTP webhook, or manual UI). Verdict becomes a merge event that propagates to every linked device.
- **Phases** = H1 hero identity → H2 mirror consent + initial sync → H3 event log + conflict detection → H4 agent dispatch.

---

## Open questions (must resolve before H1 dispatch)

The user must pick on each of these:

- **§2.d** — default master-instance for fresh signups (project-run public instance / curated list / require self-host).
- **§2.d** — device-link token TTL (24h / 7d / 30d).
- **§2.d** — allow multi-master anchoring (no recommended; user decides).
- **§4.c** — initial-sync ordering UX (creation order / activity order / batch).
- **§5.d** — agent verdict confidence threshold for auto-apply vs. user-confirm.
- **§5.d** — agent timeout behavior.
- **§5.d** — multi-device convergence when both detect the same conflict.

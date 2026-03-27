# Concord v2 -- Commercial Deployment Audit

**Audit Date:** 2026-03-26
**Auditor:** Claude Code (blind audit, codebase read fresh)
**Codebase:** `/home/corr/projects/concord/v2/`
**Test Count:** 190 passing (cargo test --workspace)
**TypeScript:** Passes (npx tsc --noEmit)

---

## 1. Executive Summary

Concord v2 is an architecturally ambitious P2P mesh communication platform with solid cryptographic foundations and a well-structured Rust codebase. The core libraries (identity, crypto, trust, networking, storage) are production-quality with comprehensive tests, but the media layer (voice/video) and Tauri integration layer have significant gaps between the engine implementation and the app shell -- voice commands still return mock data. The project is approximately 60% complete for a first usable release, with the remaining work concentrated in media integration, transport tier implementation, and the Tauri command layer.

## 2. Score Card

| Category | Weight | Score (1-5) | Weighted |
|----------|--------|-------------|----------|
| **Functionality** | 30% | 3 | 0.90 |
| **Security** | 25% | 4 | 1.00 |
| **Reliability** | 20% | 3 | 0.60 |
| **Code Quality** | 15% | 4 | 0.60 |
| **Deployment Readiness** | 10% | 2 | 0.20 |
| **TOTAL** | 100% | | **3.30/5.00** |

**Deployment Readiness Score: 46%**

Not ready for commercial deployment. Ready for developer preview / alpha testing.

---

## 3. Critical Blockers

These MUST be fixed before any deployment:

### CB-1: Voice commands return mock data (Tauri layer not wired to engine)
- **File:** `src-tauri/src/commands/voice.rs:39-99`
- **Impact:** Users cannot actually use voice chat despite the engine (`crates/concord-media/src/engine.rs`) being fully implemented with audio capture/playback
- **Evidence:** All 5 voice commands (`join_voice`, `leave_voice`, `toggle_mute`, `toggle_deafen`, `get_voice_state`) have `// TODO: Wire to VoiceEngineHandle` comments and return hardcoded responses
- **Fix:** Add `VoiceEngineHandle` to `AppState`, spawn `VoiceEngine` during setup, delegate commands

### CB-2: No LICENSE file
- **File:** Missing (`/home/corr/projects/concord/v2/LICENSE`)
- **Impact:** Code cannot be legally distributed. `Cargo.toml` declares `license = "MIT"` (line 16) but no LICENSE file exists
- **Fix:** Create MIT LICENSE file

### CB-3: Private key stored unencrypted on disk
- **File:** `crates/concord-store/src/identity.rs` -- `save_identity` stores raw signing key bytes in SQLite
- **Impact:** If the device is compromised, the identity is immediately stolen. No passphrase protection.
- **Evidence:** `db.save_identity(&name, &kp)` stores `kp.to_bytes()` (32 raw bytes) directly. The `derive_storage_key` function in `crates/concord-core/src/crypto.rs:211` exists to derive a storage encryption key from the signing key, but identity itself is unprotected.
- **Fix:** Add passphrase-based encryption (argon2 KDF) for the identity key at rest

### CB-4: DM shared secrets stored in plaintext
- **File:** `crates/concord-store/src/dm_store.rs` -- `dm_sessions` table stores `shared_secret BLOB NOT NULL`
- **Impact:** Database compromise reveals all DM encryption keys
- **Fix:** Encrypt DM session secrets using the storage key derived from the identity key

---

## 4. High Priority

Issues that should be fixed before public release:

### HP-1: WebRTC signaling is placeholder, not real str0m sessions
- **File:** `crates/concord-media/src/signaling.rs:29-37`
- **Impact:** SDP offers/answers are hardcoded placeholder strings. No real WebRTC connection is established between peers.
- **Evidence:** `create_offer()` returns a static SDP string. `handle_offer()` returns a static answer. No str0m `Rtc` instances are created.
- **Severity:** Audio frames now flow via GossipSub (after audio wiring), but this is not a sustainable transport for real-time media. GossipSub is designed for pub/sub messaging, not low-latency audio streaming. Works for prototype but will have latency/ordering issues at scale.

### HP-2: Video module is a comment-only stub
- **File:** `crates/concord-media/src/video.rs` (9 lines, all comments)
- **Impact:** Video chat is listed in the architecture but completely unimplemented

### HP-3: SFU module is a comment-only stub
- **File:** `crates/concord-media/src/sfu.rs` (9 lines, all comments)
- **Impact:** Channels with 5+ participants cannot use selective forwarding; all media goes through GossipSub flooding

### HP-4: No session expiration for guest auth
- **File:** `crates/concord-webhost/src/auth.rs:73`
- **Impact:** Guest sessions never expire. `validate_session()` checks if token exists but never checks `authenticated_at` against a timeout.
- **Fix:** Add session TTL check (e.g., 24h) in `validate_session()`

### HP-5: Forum encryption uses well-known seed
- **File:** `crates/concord-core/src/crypto.rs:196`
- **Impact:** `derive_forum_key` uses the hardcoded seed `"concord-forum-well-known-seed-v1"`. Any Concord node can derive the same key. This is "encrypted radio" (prevents non-Concord observers from reading GossipSub traffic) but provides no confidentiality between Concord users.
- **Note:** This is by design per the comments, but should be clearly documented for users. Forum posts should be treated as public within the Concord network.

### HP-6: No rate limiting on voice signal traffic
- **Files:** `crates/concord-net/src/node.rs:942-986`, `crates/concord-media/src/engine.rs`
- **Impact:** A malicious node could flood a voice channel's GossipSub topic with AudioFrame signals. The webhook module has rate limiting (`crates/concord-webhost/src/webhook.rs:26-55`), but voice signaling has none.

### HP-7: No input validation on server/channel names
- **File:** `src-tauri/src/commands/servers.rs`
- **Impact:** Users could create servers/channels with extremely long names, empty names, or names containing control characters. No length limits, no sanitization.

---

## 5. Medium Priority

Issues that affect quality but not function:

### MP-1: Audio playback buffer uses O(n) drain
- **File:** `crates/concord-media/src/audio.rs:219`
- **Impact:** `buffer.remove(0)` in the playback callback is O(n) per sample. For 48kHz audio, this is 48000 remove(0) calls per second. Should use `VecDeque` or a ring buffer.
- **Fix:** Replace `Vec<f32>` with `VecDeque<f32>` and use `pop_front()`

### MP-2: 485 uses of `unwrap()` across the crate workspace
- **Files:** All crates, 27 files
- **Impact:** Potential panics in production. Most are in test code, but some are in production paths (e.g., `crates/concord-media/src/audio.rs:91` -- `mute_flag.lock().unwrap()` in the cpal callback)
- **Fix:** Audit and replace production `unwrap()` calls with proper error handling. Mutex poisoning in audio callbacks should log and skip the frame rather than panic.

### MP-3: Server keys stored unencrypted
- **File:** `crates/concord-store/src/server_keys_store.rs`, `db.rs:236-240`
- **Impact:** `server_keys` table stores `secret_key BLOB NOT NULL` without encryption. Database access reveals all server encryption keys.
- **Fix:** Encrypt server keys at rest using `encrypt_storage()`

### MP-4: No database migration system
- **File:** `crates/concord-store/src/db.rs:47-241`
- **Impact:** Schema is initialized via `CREATE TABLE IF NOT EXISTS`. No versioning, no migration path for schema changes. Adding a column to `messages` would require manual intervention or data loss.
- **Fix:** Add a `schema_version` table and migration functions

### MP-5: Frontend has no tests
- **File:** `frontend/package.json` -- no test framework in dependencies
- **Impact:** Zero frontend test coverage. UI regressions undetectable.

### MP-6: `subscribe_events()` on VoiceEngineHandle is `unimplemented!()`
- **File:** `crates/concord-media/src/engine.rs:190-196`
- **Impact:** Calling this method panics. The comment says to use the broadcast receiver from `VoiceEngine::new()` instead, but this is a trap for any caller who discovers the method via API docs.
- **Fix:** Either implement it (store a clone of the broadcast sender) or remove the method

---

## 6. Low Priority

Nice-to-haves:

### LP-1: UUID generation uses different methods
- **Files:** `crates/concord-webhost/src/auth.rs:103` (manual random bytes), `src-tauri/src/lib.rs:78` (`uuid::Uuid::new_v4()`)
- **Impact:** Inconsistency. The webhost auth module hand-rolls UUID-like strings from random bytes instead of using the `uuid` crate.

### LP-2: Unused imports in multiple files
- **Files:** `crates/concord-net/src/sync.rs:15-16`, `crates/concord-media/src/audio.rs:11`
- **Impact:** Compiler warnings, minor code hygiene issue

### LP-3: `DeviceDescription` API usage may break across cpal versions
- **File:** `crates/concord-media/src/audio.rs:59,192`
- **Impact:** `device.description().map(|d| d.name().to_string())` -- the `description()` method was added in cpal 0.17. If the project upgrades cpal, this may change.

### LP-4: No structured logging format
- **File:** `src-tauri/src/lib.rs:39-40`
- **Impact:** Using default `tracing_subscriber::fmt()` which outputs human-readable logs. For production, JSON structured logging would be better for log aggregation.

### LP-5: No health check endpoint on daemon
- **File:** `crates/concord-daemon/src/admin.rs`
- **Impact:** No way for load balancers or monitoring to check daemon health. The `Status` CLI subcommand exists but no HTTP health endpoint.

### LP-6: No graceful shutdown handler
- **File:** `crates/concord-daemon/src/main.rs`
- **Impact:** `ctrl-c` during daemon operation may not cleanly close database connections or unsubscribe from topics. The Node has a `Shutdown` command but it's not triggered on signal.

---

## 7. Strengths

### Cryptographic implementation is solid
- Ed25519 for identity (industry standard)
- X25519 + ChaCha20-Poly1305 for E2E encryption (modern AEAD)
- HMAC-SHA256 for key derivation (channel keys, forum keys, storage keys)
- Nonce management via counters (prevents reuse)
- 28 crypto-related tests covering roundtrips, wrong-key failures, nonce uniqueness, RFC test vectors
- Proper separation: peer-to-peer encryption, channel encryption, forum encryption, storage encryption are all distinct systems

### Test coverage is comprehensive and meaningful
- 190 tests covering all core libraries
- Tests verify both positive and negative cases (wrong key fails, tampered attestation fails, etc.)
- RFC 6238 TOTP test vector included
- Database schema initialization tested
- Trust system has 13 tests covering level computation, weighted scoring, negative attestations, bleed mechanics

### Architecture is well-designed for the stated goals
- Clean crate separation (core, net, media, store, webhost, daemon)
- `concord-core` has zero network dependencies -- pure library
- `concord-net` properly abstracts over libp2p
- The three-pathway model (forums, servers, direct) maps naturally to GossipSub topics
- Transport tier abstraction is forward-looking (BLE/WiFi Direct readiness)
- NodeHandle/Node split enables clean async command pattern

### Trust system is thoughtfully designed
- Web-of-trust with weighted attestations
- Cross-account reputation bleed prevents sockpuppet abuse
- Negative attestations with reasons enable community moderation
- Trust level thresholds require both attestation count AND identity age (prevents sybil attacks)

### Developer experience is good
- Multi-instance testing workflow with `dev-second-instance.sh`
- Frontend works standalone with comprehensive mock data
- Clear CLAUDE.md documentation
- TOML config for daemon with sensible defaults

### Code quality is consistent
- Idiomatic Rust throughout
- Proper error types with `thiserror`
- `tracing` used consistently for logging
- Serde derives on all wire types
- MessagePack for wire protocol (compact binary format)

---

## 8. Architecture Assessment

**Is the design sound for the stated goals?** Yes, with caveats.

### Sound decisions:
- **libp2p as the networking layer** is the right choice for a P2P mesh. GossipSub, Kademlia, mDNS, QUIC, and Noise are all battle-tested components.
- **Tauri v2 for cross-platform** is appropriate. The Rust backend + web frontend split enables code sharing between desktop and mobile.
- **SQLite for local storage** with WAL mode is correct for a local-first application.
- **The three-pathway model** (forums/servers/direct) maps well to different social interaction patterns.
- **Transport tier abstraction** prepares for infrastructure-free operation without requiring it immediately.

### Design risks:
- **Audio frames over GossipSub** is a temporary solution. GossipSub is a gossip protocol designed for reliable delivery, not low-latency streaming. It adds overhead (multiple hops, message deduplication) that will cause audio quality issues with 3+ participants. The str0m WebRTC integration needs to happen before real voice usage.
- **No Double Ratchet** -- the E2E encryption uses a simple counter-based nonce with a static shared secret. If a key is compromised, all past and future messages are readable. The comment acknowledges this ("a full Double Ratchet can replace it later") but this is a significant security gap for a communication platform.
- **Shared server key model** -- all members of a server share the same symmetric key. A member who leaves retains the key and can continue decrypting messages until the key is rotated. No key rotation mechanism exists.
- **GossipSub topic per channel** may not scale. A user in 50 servers with 10 channels each would subscribe to 500+ GossipSub topics. libp2p gossipsub performance degrades with many subscriptions.

### Missing architectural components:
- **Message ordering** -- GossipSub provides eventual delivery but no ordering guarantees. Two users sending messages simultaneously may see them in different orders. No Lamport timestamps or vector clocks for message ordering (vector clocks exist for sync but not for real-time ordering).
- **Offline message delivery** -- if a recipient is offline, messages are lost until sync reconnection. No store-and-forward relay.
- **Key rotation** -- no mechanism for rotating server keys, DM session keys, or forum keys.
- **Conflict resolution** -- the distributed ledger for servers is mentioned in architecture docs but not implemented. Without it, concurrent server modifications from different nodes could conflict.

---

## 9. Recommendations

Ordered by priority and impact:

1. **Wire VoiceEngineHandle to Tauri commands** -- The engine is implemented, the audio pipeline works, but the app layer returns mocks. This is the highest-ROI fix: ~100 lines of code to enable actual voice chat.

2. **Add LICENSE file** -- Create MIT license file to match Cargo.toml declaration. Blocks any distribution.

3. **Encrypt identity key at rest** -- Add passphrase protection using argon2 KDF. This is the most critical security gap.

4. **Replace GossipSub audio transport with str0m WebRTC** -- Current approach works for 2-3 peers but will degrade. Finish the str0m integration for direct peer-to-peer audio streams.

5. **Add database migration system** -- Before any schema changes happen, implement version tracking. Even a simple `PRAGMA user_version` check would prevent data loss.

6. **Add session expiration to guest auth** -- Simple fix, important for security.

7. **Fix audio playback buffer** -- Replace `Vec` with `VecDeque` to eliminate O(n) per-sample overhead.

8. **Encrypt DM secrets and server keys at rest** -- The `encrypt_storage()` / `decrypt_storage()` functions already exist. Wire them into the store layer.

9. **Add CI pipeline** -- GitHub Actions for `cargo test --workspace` + `npx tsc --noEmit` on push. Prevents regressions.

10. **Implement voice signal rate limiting** -- Prevent audio frame flooding attacks on voice channels.

11. **Add input validation** -- Server/channel names need length limits and character sanitization at the Tauri command layer.

12. **Add structured logging** -- JSON log output for the daemon, with configurable log rotation.

---

*End of audit.*

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex;

pub mod porch;
pub mod porch_ephemeral;
pub mod servitude;

use servitude::config::Profile;
use servitude::{LifecycleState, ServitudeConfig, ServitudeHandle};
use servitude::identity::{self, StrongholdHandle};
use servitude::p2p::SwarmEvent as P2pSwarmEvent;
use servitude::peer_store::{self, KnownPeer, PeerCard, PeerSource};
use servitude::transport::dendrite_federation::RegisterOwnerResponse;

/// Tauri-managed state wrapping the optional embedded servitude handle.
///
/// The handle lives behind a `tokio::sync::Mutex` because the servitude
/// lifecycle is async — transports spawn child processes and await
/// health checks, so the lock must be held across `.await` points.
/// `std::sync::MutexGuard` is not `Send`, which would make the command
/// futures non-Send and incompatible with Tauri's multi-threaded runtime.
///
/// The `Option` encodes the "handle not yet constructed" vs "handle
/// constructed and running/stopped" distinction so restarts don't have
/// to recreate Tauri managed state.
///
/// Note on poisoning: `tokio::sync::Mutex` does not poison on panic — a
/// panic mid-lock simply releases the lock on unwind. The previous
/// `unwrap_or_else(|p| p.into_inner())` recovery shim is no longer
/// necessary and has been removed.
pub struct ServitudeState(pub Mutex<Option<ServitudeHandle>>);

/// Tauri-managed state for the lazily-opened peer-identity Stronghold.
///
/// The Stronghold snapshot file holding the Ed25519 secret is opened on the
/// first `peer_identity` call and reused for every subsequent call. The
/// `tokio::sync::Mutex` wrapping the `Option` serializes the open path so
/// two parallel callers on first launch don't both try to create the file.
///
/// The `Arc<StrongholdHandle>` lets concurrent signing/identity-reads
/// share the underlying Stronghold client without re-opening the snapshot;
/// the handle has its own internal mutex protecting the load_or_create
/// race (see `servitude::identity`).
pub struct PeerIdentityState(pub Mutex<Option<std::sync::Arc<StrongholdHandle>>>);

/// Public peer-identity descriptor serialized back to the renderer.
///
/// **Deliberately has NO `secret_key`, `private_key`, `sk`, `seed`, or any
/// similar field.** The struct exists precisely so the
/// `peer_identity` Tauri command's response shape is locked at compile time
/// to the public-only surface. A negative integration test asserts this
/// stays true (see `src-tauri/tests/identity_test.rs`).
#[derive(serde::Serialize)]
struct PeerIdentityPublic {
    public_key_hex: String,
    fingerprint: String,
}

/// Public swarm-status descriptor serialized back to the renderer for the
/// Phase 3 Profile tab swarm row.
///
/// Fields are snake_case on the wire — the React side's `peerSwarm.ts`
/// wrapper transcribes to camelCase via explicit field-by-field copy.
#[derive(Clone, Debug, Default, serde::Serialize)]
struct SwarmStatus {
    our_peer_id: String,
    our_multiaddrs: Vec<String>,
    peer_count: usize,
    last_event: Option<String>,
}

/// In-memory cache the `peer_swarm_status` command reads from. A background
/// task seeded at app startup subscribes to the running libp2p swarm's
/// broadcast channel and keeps this mirror up to date as new events arrive.
#[derive(Default)]
pub struct SwarmStateCache(std::sync::Mutex<SwarmStatus>);

/// Tauri-managed state holding the swarm event cache. Read by
/// `peer_swarm_status`; written by the background mirror task spawned in
/// `run()`.
pub struct SwarmEventChannel(pub std::sync::Arc<SwarmStateCache>);

/// Porch Phase A — shared local porch backing the host's own porch
/// commands and the inbound `/concord/porch/1.0.0` libp2p handler. The
/// state is opened lazily on the first porch Tauri command call (so a
/// build that never opens the porch surface doesn't pay the
/// migration cost) and reused for the process lifetime.
pub struct PorchState(pub Mutex<Option<std::sync::Arc<porch::Porch>>>);

/// F1a — shared **ephemeral** porch (in-memory, session-only). Created
/// at first read by `ensure_ephemeral_porch`; reused for the process
/// lifetime. Dropping the process drops every byte of porch state —
/// channels, messages, and ACL rows — and the next launch starts from
/// a fresh `welcome` channel with no history. Distinct from
/// [`PorchState`] (the SQLite-backed soon-to-be-home-server module).
pub struct EphemeralPorchState(pub Mutex<Option<std::sync::Arc<porch_ephemeral::EphemeralPorch>>>);

// ---------------------------------------------------------------------------
// Phase 5 — peer-store IPC shapes
// ---------------------------------------------------------------------------

/// Frontend-facing peer record. camelCase via `serde(rename_all)` so the
/// TS wrapper layer doesn't have to manually transcribe every field.
///
/// Derived from [`KnownPeer`] at the IPC boundary so internal changes to
/// `KnownPeer` don't auto-leak into the renderer contract — adding a
/// new internal field requires a deliberate update here too.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct KnownPeerPublic {
    peer_id: String,
    public_key_hex: String,
    multiaddrs: Vec<String>,
    source: String,
    first_seen: String,
    last_seen: String,
}

impl From<KnownPeer> for KnownPeerPublic {
    fn from(kp: KnownPeer) -> Self {
        Self {
            peer_id: kp.peer_id,
            public_key_hex: kp.public_key_hex,
            multiaddrs: kp.multiaddrs,
            source: source_to_wire(&kp.source).to_string(),
            // RFC 3339 string is JSON-friendly + sortable lexicographically.
            first_seen: kp.first_seen.to_rfc3339(),
            last_seen: kp.last_seen.to_rfc3339(),
        }
    }
}

/// Input shape for `peer_store_add`. The `source` field is a plain
/// string so the TS layer can pass `"qr" | "deeplink" | "matrix_room"
/// | "dht"` without a discriminated-union dance.
#[derive(serde::Deserialize)]
struct PeerCardInput {
    peer_id: String,
    public_key_hex: String,
    multiaddrs: Vec<String>,
    source: String,
}

fn parse_source(raw: &str) -> Result<PeerSource, String> {
    match raw {
        "qr" => Ok(PeerSource::Qr),
        "deeplink" => Ok(PeerSource::Deeplink),
        "matrix_room" => Ok(PeerSource::MatrixRoom),
        "dht" => Ok(PeerSource::Dht),
        other => Err(format!(
            "unknown peer source {other:?} — expected one of: qr | deeplink | matrix_room | dht"
        )),
    }
}

fn source_to_wire(source: &PeerSource) -> &'static str {
    match source {
        PeerSource::Qr => "qr",
        PeerSource::Deeplink => "deeplink",
        PeerSource::MatrixRoom => "matrix_room",
        PeerSource::Dht => "dht",
    }
}

/// Open (or create) the peer-identity Stronghold snapshot and return a
/// shared handle.
///
/// Snapshot file: `<app_local_data_dir>/peer-identity.stronghold`
/// Password file: `<app_local_data_dir>/peer-identity.password` (auto
/// generated, 32 random bytes hex-encoded; on Unix the file is chmod 0600).
///
/// The password file is intentionally separate from the snapshot so the
/// Stronghold file-level encryption guards the secret bytes; the password
/// file is the moral equivalent of a system-keychain entry. A future
/// hardening pass swaps this for an OS keyring or argon2-from-user-passcode
/// derivation without changing the on-disk snapshot format.
fn open_peer_identity_stronghold(
    app: &tauri::AppHandle,
) -> Result<std::sync::Arc<StrongholdHandle>, String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("no app_local_data_dir: {e}"))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let snapshot_path = data_dir.join("peer-identity.stronghold");
    let password_path = data_dir.join("peer-identity.password");

    // Load or create the password. The file holds a hex-encoded 32-byte
    // random secret. We generate on first launch and persist; subsequent
    // launches re-read.
    let password_bytes: Vec<u8> = if password_path.exists() {
        let hex_str = std::fs::read_to_string(&password_path)
            .map_err(|e| format!("read peer-identity password: {e}"))?;
        hex::decode(hex_str.trim())
            .map_err(|e| format!("decode peer-identity password: {e}"))?
    } else {
        use rand::RngCore;
        let mut buf = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut buf);
        let encoded = hex::encode(buf);
        std::fs::write(&password_path, &encoded)
            .map_err(|e| format!("write peer-identity password: {e}"))?;
        // Tighten file permissions on Unix so other users can't read it.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(
                &password_path,
                std::fs::Permissions::from_mode(0o600),
            );
        }
        buf.to_vec()
    };

    let stronghold = tauri_plugin_stronghold::stronghold::Stronghold::new(
        &snapshot_path,
        password_bytes.clone(),
    )
    .map_err(|e| format!("open peer-identity stronghold: {e}"))?;

    // Resolve the client.
    //
    // Three cases:
    //   1. Snapshot did not exist  -> create a fresh client.
    //   2. Snapshot existed AND the client has been loaded this process
    //      lifetime -> get_client returns it.
    //   3. Snapshot existed but the client is only in the snapshot, not
    //      in the live client map -> load_client hydrates it.
    //
    // We try (2) first, fall back to (3), and only on a "not in snapshot"
    // error do we (1) create from scratch.
    let client_path = b"peer-identity".to_vec();
    let client = match stronghold.inner().get_client(&client_path) {
        Ok(c) => c,
        Err(_) => match stronghold.inner().load_client(&client_path) {
            Ok(c) => c,
            Err(_) => stronghold
                .inner()
                .create_client(&client_path)
                .map_err(|e| format!("create peer-identity client: {e}"))?,
        },
    };

    // Commit any newly-created client to disk so the next launch sees it.
    if let Err(e) = stronghold.save() {
        log::warn!(
            target: "concord::identity",
            "failed to save peer-identity snapshot on open: {e}"
        );
    }

    // Build the handle wired for Phase 4 cross-restart persistence: the
    // identity module encrypts the Ed25519 seed under the snapshot
    // password and persists it to a sibling file alongside the snapshot,
    // so signing / libp2p Keypair construction survive an app restart.
    // See `servitude/identity.rs` module-level docs.
    let handle = StrongholdHandle::new_persistent(client, &snapshot_path, &password_bytes)
        .map_err(|e| format!("build peer-identity handle: {e}"))?;
    Ok(std::sync::Arc::new(handle))
}

async fn get_or_open_peer_identity(
    state: &tauri::State<'_, PeerIdentityState>,
    app: &tauri::AppHandle,
) -> Result<std::sync::Arc<StrongholdHandle>, String> {
    let mut guard = state.0.lock().await;
    if let Some(h) = guard.as_ref() {
        return Ok(h.clone());
    }
    let handle = open_peer_identity_stronghold(app)?;
    *guard = Some(handle.clone());
    Ok(handle)
}

/// Return the install's peer identity — Ed25519 public key + short
/// fingerprint.
///
/// The keypair is generated on first call and persisted in a dedicated
/// Stronghold snapshot under the app's local data dir. Subsequent calls
/// return the same identity (idempotent + restart-persistent).
///
/// The Ed25519 secret key NEVER crosses the IPC boundary: it lives only
/// inside Stronghold's protected runtime. The returned struct is
/// hard-coded to public-only fields; a negative test in
/// `src-tauri/tests/identity_test.rs` enforces this at the JSON-shape
/// level.
#[tauri::command]
async fn peer_identity(
    state: tauri::State<'_, PeerIdentityState>,
    app: tauri::AppHandle,
) -> Result<PeerIdentityPublic, String> {
    let stronghold = get_or_open_peer_identity(&state, &app).await?;
    let id = identity::load_or_create(&stronghold)
        .await
        .map_err(|e| e.to_string())?;
    Ok(PeerIdentityPublic {
        public_key_hex: hex::encode(id.public_key),
        fingerprint: id.fingerprint,
    })
}

/// Return the current libp2p swarm status — peer count, multiaddrs, the
/// local PeerId, and the last observed swarm event (if any).
///
/// The data is read from a shared in-memory cache populated by a
/// background task that subscribes to the swarm's broadcast channel
/// (see `spawn_swarm_event_mirror`). The cache is empty until the
/// embedded servitude has been started AND the libp2p runtime inside
/// it has bound its first listening multiaddr.
///
/// The Ed25519 seed backing the swarm's `PeerId` is the same seed
/// backing the Phase 2 `peer_identity` fingerprint — see the
/// architectural note in `servitude/identity.rs`. The two commands
/// expose the same identity in different encodings; they never disagree.
#[tauri::command]
async fn peer_swarm_status(
    state: tauri::State<'_, SwarmEventChannel>,
) -> Result<SwarmStatus, String> {
    let cache = state.0.clone();
    let snapshot = cache
        .0
        .lock()
        .map_err(|e| format!("swarm cache poisoned: {e}"))?;
    Ok(snapshot.clone())
}

// ---------------------------------------------------------------------------
// Phase 5 — peer-store Tauri commands
// ---------------------------------------------------------------------------

/// List every known peer currently in the store. Empty on first call.
#[tauri::command]
async fn peer_store_list(
    state: tauri::State<'_, PeerIdentityState>,
    app: tauri::AppHandle,
) -> Result<Vec<KnownPeerPublic>, String> {
    let stronghold = get_or_open_peer_identity(&state, &app).await?;
    let peers = peer_store::list(&stronghold)
        .await
        .map_err(|e| e.to_string())?;
    Ok(peers.into_iter().map(KnownPeerPublic::from).collect())
}

/// Add a peer to the store. Idempotent — see `peer_store::add`.
#[tauri::command]
async fn peer_store_add(
    state: tauri::State<'_, PeerIdentityState>,
    app: tauri::AppHandle,
    input: PeerCardInput,
) -> Result<KnownPeerPublic, String> {
    let stronghold = get_or_open_peer_identity(&state, &app).await?;
    let source = parse_source(&input.source)?;
    let card = PeerCard {
        peer_id: input.peer_id,
        public_key_hex: input.public_key_hex,
        multiaddrs: input.multiaddrs,
    };
    let updated = peer_store::add(&stronghold, card, source)
        .await
        .map_err(|e| e.to_string())?;
    Ok(KnownPeerPublic::from(updated))
}

/// Remove a peer from the store. Returns `true` if a peer was removed.
#[tauri::command]
async fn peer_store_remove(
    state: tauri::State<'_, PeerIdentityState>,
    app: tauri::AppHandle,
    peer_id: String,
) -> Result<bool, String> {
    let stronghold = get_or_open_peer_identity(&state, &app).await?;
    peer_store::remove(&stronghold, &peer_id)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Porch Phase A — local-server + visit commands
// ---------------------------------------------------------------------------

/// Open (or return the already-open) shared porch. Lazy so the porch
/// SQLite migration only runs on demand. Also wires the porch into the
/// running servitude handle's libp2p runtime via `set_porch` — when
/// the runtime restarts, the same porch instance is reused so the
/// inbound `/concord/porch/1.0.0` handler dispatches against the same
/// SQLite the host's own commands operate on.
async fn get_or_open_porch(
    porch_state: &tauri::State<'_, PorchState>,
    servitude_state: &tauri::State<'_, ServitudeState>,
    app: &tauri::AppHandle,
) -> Result<std::sync::Arc<porch::Porch>, String> {
    let mut guard = porch_state.0.lock().await;
    if let Some(p) = guard.as_ref() {
        return Ok(p.clone());
    }
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("no app_local_data_dir: {e}"))?;
    let porch = porch::Porch::open(&data_dir).map_err(|e| e.to_string())?;
    let porch_arc = std::sync::Arc::new(porch);
    *guard = Some(porch_arc.clone());
    drop(guard);
    // Best-effort: wire the freshly-opened porch into the running
    // servitude so the inbound libp2p handler picks it up. If no
    // runtime exists yet, the next `servitude_start` call grabs the
    // porch from `PorchState` directly — see `servitude_start` for
    // the eager wiring path.
    let mut servitude_guard = servitude_state.0.lock().await;
    if let Some(handle) = servitude_guard.as_mut() {
        handle.set_porch(porch_arc.clone());
    }
    Ok(porch_arc)
}

/// List channels on the LOCAL porch (this install's). Always returns
/// every channel, regardless of ACL — the host sees their own porch in
/// full.
#[tauri::command]
async fn porch_list_my_channels(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
) -> Result<Vec<porch::PorchChannel>, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch.list_channels().map_err(|e| e.to_string())
}

/// Read messages from a channel on the LOCAL porch.
#[tauri::command]
async fn porch_get_messages(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    channel_id: String,
    since: Option<i64>,
    limit: u32,
) -> Result<Vec<porch::ChannelMessage>, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch
        .get_messages(&channel_id, since, limit)
        .map_err(|e| e.to_string())
}

/// Append a message to a LOCAL porch channel. The author is stamped as
/// the local libp2p PeerId (read from the running servitude); if no
/// libp2p runtime is up, falls back to the literal string `"local"`
/// so the host can still post while offline.
#[tauri::command]
async fn porch_post_message(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    channel_id: String,
    body: String,
) -> Result<porch::ChannelMessage, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    // Resolve the local PeerId for author attribution. If the libp2p
    // runtime isn't up, fall back to "local" — the host's own UI
    // shouldn't be blocked by transport state.
    let author = {
        let guard = servitude_state.0.lock().await;
        guard
            .as_ref()
            .and_then(|h| h.libp2p_local_peer_id().map(|p| p.to_base58()))
            .unwrap_or_else(|| "local".to_string())
    };
    porch
        .post_message(&channel_id, &author, &body)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// F1a — ephemeral porch commands (in-memory, session-only)
// ---------------------------------------------------------------------------
//
// Distinct surface from the persistent porch above — see
// `src-tauri/src/porch_ephemeral/` for the doorman architecture +
// session-token gate. The existing `porch_*` commands above operate on
// the SQLite-backed module being re-themed as the home server in F1b;
// nothing in this section touches that storage.

/// Lazily construct the per-launch [`porch_ephemeral::EphemeralPorch`].
/// The first read triggers seeding the welcome channel + minting the
/// 256-bit session token; subsequent calls return the same `Arc`.
///
/// The host's libp2p PeerId is plumbed in from the running servitude
/// handle so the porch can publish its identity to clients via the
/// `porch_current_token` command. If the libp2p runtime isn't up yet
/// (rare race during boot — the porch is constructed before
/// servitude_start in some test flows), a placeholder PeerId is
/// generated and replaced the next time servitude reports a real one.
async fn ensure_ephemeral_porch(
    state: &tauri::State<'_, EphemeralPorchState>,
    servitude_state: &tauri::State<'_, ServitudeState>,
) -> std::sync::Arc<porch_ephemeral::EphemeralPorch> {
    let mut guard = state.0.lock().await;
    if let Some(p) = guard.as_ref() {
        return p.clone();
    }
    let host_peer_id = {
        let s = servitude_state.0.lock().await;
        s.as_ref()
            .and_then(|h| h.libp2p_local_peer_id())
            // Fall back to an ephemeral throwaway id when the swarm
            // isn't up — `porch_current_token` will still return the
            // real id once the renderer calls again after start.
            .unwrap_or_else(|| {
                libp2p::PeerId::from(libp2p::identity::Keypair::generate_ed25519().public())
            })
    };
    let porch = std::sync::Arc::new(porch_ephemeral::EphemeralPorch::new(host_peer_id));
    *guard = Some(porch.clone());
    porch
}

/// F1a — `(peer_id, session_token)` published to the renderer so the
/// peer-onboarding UX can surface the running token to invited guests.
/// The token rotates on every binary launch; never log this value.
#[tauri::command]
async fn porch_current_token(
    state: tauri::State<'_, EphemeralPorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
) -> Result<porch_ephemeral::PorchIdentity, String> {
    let porch = ensure_ephemeral_porch(&state, &servitude_state).await;
    Ok(porch.identity())
}

/// F1a — list channels on the ephemeral porch.
#[tauri::command]
async fn porch_list_channels(
    state: tauri::State<'_, EphemeralPorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
) -> Result<Vec<porch_ephemeral::EphemeralChannel>, String> {
    let porch = ensure_ephemeral_porch(&state, &servitude_state).await;
    Ok(porch.list_channels().await)
}

/// F1a — read every message in an ephemeral channel. The persistent
/// porch's own `porch_get_messages` command lives above and operates on
/// the SQLite-backed module — they have different params (the
/// persistent one paginates with `since` + `limit`; the ephemeral one
/// is bounded at `MAX_MESSAGES_PER_CHANNEL` so returns everything).
/// Named with the `_ephemeral_` infix to avoid a Tauri-command
/// collision; the client wraps both behind a `porchEphemeralStore`
/// follow-up.
#[tauri::command]
async fn porch_ephemeral_get_messages(
    state: tauri::State<'_, EphemeralPorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    channel_id: String,
) -> Result<Vec<porch_ephemeral::EphemeralMessage>, String> {
    let porch = ensure_ephemeral_porch(&state, &servitude_state).await;
    Ok(porch.get_messages(&channel_id).await)
}

/// F1a — append a message to an ephemeral channel. The author is
/// stamped as the local libp2p PeerId; if no libp2p runtime is up
/// (rare boot race), falls back to `"local"` so the host can still
/// post.
#[tauri::command]
async fn porch_send_message(
    state: tauri::State<'_, EphemeralPorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    channel_id: String,
    body: String,
) -> Result<porch_ephemeral::EphemeralMessage, String> {
    let porch = ensure_ephemeral_porch(&state, &servitude_state).await;
    let author = {
        let guard = servitude_state.0.lock().await;
        guard
            .as_ref()
            .and_then(|h| h.libp2p_local_peer_id().map(|p| p.to_base58()))
            .unwrap_or_else(|| "local".to_string())
    };
    porch
        .send_message(&channel_id, &author, &body)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Home server (F1b-IMPL) — persistent home-server meta surface
// ---------------------------------------------------------------------------
//
// The HOME server is the user's persistent local data layer. Per the
// 2026-06-01 CONSOLIDATED ARCHITECTURE filing, the existing
// `porch.sqlite` is being repurposed as the home server's backing
// store; renaming the module + file from `porch` → `home` is a
// follow-up PR (kept out of this one to avoid a noisy diff).
//
// The two commands below surface the user-set NAME of the home server
// (default `"home"`), stored in the `home_meta` table added in schema
// version 8. The HOME server's CHANNELS / MESSAGES are still served
// by `porch_list_my_channels` / `porch_get_messages` /
// `porch_post_message` above — the only thing changing in this PR is
// the addition of a renamable label and the LocalServerSidebar
// rendering the porch + home tiles side-by-side.

/// Read the user-set name of the home server. Defaults to `"home"`
/// on a fresh install; persisted via [`home_set_server_name`].
#[tauri::command]
async fn home_get_server_name(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch.home_server_name().map_err(|e| e.to_string())
}

/// Persist a new user-set name for the home server. Trims whitespace,
/// rejects empty, caps length at 64 chars. The new name is reflected
/// in the renderer the next time `home_get_server_name` is called
/// (the zustand store hydrates on ChatLayout mount).
#[tauri::command]
async fn home_set_server_name(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    name: String,
) -> Result<(), String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch.set_home_server_name(&name).map_err(|e| e.to_string())
}

/// Resolve a libp2p stream control + peer-id for a visit. Returns the
/// control + parsed PeerId, or an error string suitable for `Result`.
async fn resolve_visit_control(
    servitude_state: &tauri::State<'_, ServitudeState>,
    peer_id_str: &str,
) -> Result<(libp2p_stream::Control, libp2p::PeerId), String> {
    let peer_id: libp2p::PeerId = peer_id_str
        .parse()
        .map_err(|e| format!("invalid peer_id: {e}"))?;
    let guard = servitude_state.0.lock().await;
    let handle = guard
        .as_ref()
        .ok_or_else(|| "servitude is not running".to_string())?;
    let control = handle
        .porch_stream_control()
        .ok_or_else(|| "libp2p runtime is not running".to_string())?;
    Ok((control, peer_id))
}

/// Visit a paired peer's porch. Dials over libp2p, opens a stream on
/// `/concord/porch/1.0.0`, sends `ListChannels`, returns the response.
///
/// Phase B: response rows now carry a `visibility` discriminator so the
/// visitor's UI can render a Knock affordance on gated channels.
#[tauri::command]
async fn porch_visit_peer(
    servitude_state: tauri::State<'_, ServitudeState>,
    peer_id: String,
) -> Result<Vec<porch::PorchListChannelRow>, String> {
    let (mut control, peer) = resolve_visit_control(&servitude_state, &peer_id).await?;
    porch::visit_list_channels(&mut control, peer)
        .await
        .map_err(|e| e.to_string())
}

/// Visit a peer's porch and page messages from one of their channels.
#[tauri::command]
async fn porch_visit_get_messages(
    servitude_state: tauri::State<'_, ServitudeState>,
    peer_id: String,
    channel_id: String,
    since: Option<i64>,
    limit: u32,
) -> Result<Vec<porch::ChannelMessage>, String> {
    let (mut control, peer) = resolve_visit_control(&servitude_state, &peer_id).await?;
    porch::visit_get_messages(&mut control, peer, channel_id, since, limit)
        .await
        .map_err(|e| e.to_string())
}

/// Visit a peer's porch and post a message into one of their channels.
#[tauri::command]
async fn porch_visit_post_message(
    servitude_state: tauri::State<'_, ServitudeState>,
    peer_id: String,
    channel_id: String,
    body: String,
) -> Result<porch::ChannelMessage, String> {
    let (mut control, peer) = resolve_visit_control(&servitude_state, &peer_id).await?;
    porch::visit_post_message(&mut control, peer, channel_id, body)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Porch Phase B — knock-to-enter + inner channel management
// ---------------------------------------------------------------------------

/// Phase B — owner-side: list every pending knock across all of this
/// install's channels. The host UI polls this to render the "people at
/// the door" surface.
#[tauri::command]
async fn porch_pending_knocks(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
) -> Result<Vec<porch::Knock>, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch.pending_knocks().map_err(|e| e.to_string())
}

/// Phase B — owner-side: accept a pending knock. Flips the knock to
/// `accepted` AND inserts a `member` ACL grant atomically.
#[tauri::command]
async fn porch_accept_knock(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    knock_id: String,
) -> Result<porch::Knock, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch.accept_knock(&knock_id).map_err(|e| e.to_string())
}

/// Phase B — owner-side: reject a pending knock. Flips the knock to
/// `rejected`; no ACL change.
#[tauri::command]
async fn porch_reject_knock(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    knock_id: String,
) -> Result<porch::Knock, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch.reject_knock(&knock_id).map_err(|e| e.to_string())
}

/// Phase B — owner-side: mint a new channel. Phase A's `insert_channel`
/// is exposed here as a Tauri command so the host UI can add inner /
/// allowlist channels without dropping to SQL.
#[tauri::command]
async fn porch_create_channel(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    name: String,
    kind: porch::ChannelKind,
    acl_mode: porch::AclMode,
) -> Result<porch::PorchChannel, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    // Mint a ULID id so two channels with the same display name don't
    // collide on the PRIMARY KEY.
    let id = ulid::Ulid::new().to_string();
    porch
        .insert_channel(&id, &name, kind, acl_mode)
        .map_err(|e| e.to_string())
}

/// Phase B — owner-side: grant `member` on a channel. Idempotent.
#[tauri::command]
async fn porch_grant_member(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    channel_id: String,
    peer_id: String,
) -> Result<(), String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch
        .grant_acl(&channel_id, &peer_id, porch::AclRole::Member)
        .map_err(|e| e.to_string())
}

/// Phase B — owner-side: revoke a channel ACL row.
#[tauri::command]
async fn porch_revoke_member(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    channel_id: String,
    peer_id: String,
) -> Result<(), String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch
        .revoke_acl(&channel_id, &peer_id)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Phase B — visitor-side: knock on a paired peer's gated channel.
/// Returns the recorded `Knock` row.
#[tauri::command]
async fn porch_visit_knock(
    servitude_state: tauri::State<'_, ServitudeState>,
    peer_id: String,
    channel_id: String,
    message: Option<String>,
) -> Result<porch::Knock, String> {
    let (mut control, peer) = resolve_visit_control(&servitude_state, &peer_id).await?;
    porch::visit_knock(&mut control, peer, channel_id, message)
        .await
        .map_err(|e| e.to_string())
}

/// Phase B — visitor-side: read the visitor's own current knock status
/// for a channel (or `null` if they've never knocked).
#[tauri::command]
async fn porch_visit_knock_status(
    servitude_state: tauri::State<'_, ServitudeState>,
    peer_id: String,
    channel_id: String,
) -> Result<Option<porch::Knock>, String> {
    let (mut control, peer) = resolve_visit_control(&servitude_state, &peer_id).await?;
    porch::visit_knock_status(&mut control, peer, channel_id)
        .await
        .map_err(|e| e.to_string())
}

/// Phase B — visitor-side: withdraw a pending knock the visitor filed.
#[tauri::command]
async fn porch_visit_withdraw_knock(
    servitude_state: tauri::State<'_, ServitudeState>,
    peer_id: String,
    knock_id: String,
) -> Result<porch::Knock, String> {
    let (mut control, peer) = resolve_visit_control(&servitude_state, &peer_id).await?;
    porch::visit_withdraw_knock(&mut control, peer, knock_id)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Porch Phase C — per-channel theming + asset storage
// ---------------------------------------------------------------------------

/// Phase C — owner-side: read the theme stored for one of the host's
/// own channels. Returns the persisted theme, or the default theme
/// (see `ChannelTheme::default_for`) if the owner hasn't customized.
/// The React side never has to deal with a `null` here — the default
/// is substituted server-side.
#[tauri::command]
async fn porch_get_theme(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    channel_id: String,
) -> Result<porch::ChannelTheme, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    let theme = porch
        .get_theme(&channel_id)
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| porch::ChannelTheme::default_for(&channel_id));
    Ok(theme)
}

/// Phase C — owner-side: persist the given theme for its channel.
/// Validates color hex, font enum, and Image-background asset binding
/// before hitting the DB so errors are user-friendly. Returns the
/// persisted theme (with `updated_at` stamped).
#[tauri::command]
async fn porch_set_theme(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    theme: porch::ChannelTheme,
) -> Result<porch::ChannelTheme, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch.set_theme(theme).map_err(|e| e.to_string())
}

/// Phase C — owner-side: upload an image asset for `channel_id`. The
/// renderer side passes the file as standard-base64 (NOT base64url —
/// the wire encoding mirrors the inline-asset response). 5 MiB cap
/// enforced at the storage layer.
#[tauri::command]
async fn porch_upload_asset(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    channel_id: String,
    mime_type: String,
    base64_bytes: String,
) -> Result<porch::PorchAsset, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_bytes.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))?;
    porch
        .upload_asset(&channel_id, &mime_type, &bytes)
        .map_err(|e| e.to_string())
}

/// Phase C — owner-side: list every asset uploaded for a channel.
#[tauri::command]
async fn porch_list_assets(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    channel_id: String,
) -> Result<Vec<porch::PorchAsset>, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch.list_assets(&channel_id).map_err(|e| e.to_string())
}

/// Phase C — visitor-side: fetch the owner-set theme for a channel on
/// a paired peer's porch.
#[tauri::command]
async fn porch_visit_get_theme(
    servitude_state: tauri::State<'_, ServitudeState>,
    peer_id: String,
    channel_id: String,
) -> Result<porch::ChannelTheme, String> {
    let (mut control, peer) = resolve_visit_control(&servitude_state, &peer_id).await?;
    porch::visit_get_theme(&mut control, peer, channel_id)
        .await
        .map_err(|e| e.to_string())
}

/// Phase C — visitor-side: fetch raw bytes of an image asset off a
/// peer's porch. Returns the decoded bytes; throws if the asset is
/// over the 256 KiB inline cap.
#[tauri::command]
async fn porch_visit_get_asset_bytes(
    servitude_state: tauri::State<'_, ServitudeState>,
    peer_id: String,
    asset_id: String,
) -> Result<Vec<u8>, String> {
    let (mut control, peer) = resolve_visit_control(&servitude_state, &peer_id).await?;
    porch::visit_get_asset_bytes(&mut control, peer, asset_id)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Porch Phase D — Obsidian channel: vault binding + browse + read
// ---------------------------------------------------------------------------

/// Phase D — owner-side: bind a channel of `kind = 'obsidian'` to a
/// vault directory on disk. `vault_root` is canonicalized (realpath)
/// before being stored so future security checks compare against the
/// canonical form directly. Optional `subfolder` narrows the surface
/// to a sub-tree of a larger vault.
///
/// Returns the persisted [`porch::ObsidianChannelConfig`].
#[tauri::command]
async fn porch_set_obsidian_config(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    channel_id: String,
    vault_root: String,
    subfolder: Option<String>,
    follow_symlinks: bool,
) -> Result<porch::ObsidianChannelConfig, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    let root = std::path::PathBuf::from(vault_root);
    let sub = subfolder.map(std::path::PathBuf::from);
    porch
        .set_obsidian_config(
            &channel_id,
            &root,
            sub.as_deref(),
            follow_symlinks,
        )
        .map_err(|e| e.to_string())
}

/// Phase D — owner-side: read the obsidian binding for a channel, or
/// `null` if the channel isn't yet bound to a vault.
#[tauri::command]
async fn porch_get_obsidian_config(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    channel_id: String,
) -> Result<Option<porch::ObsidianChannelConfig>, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch
        .get_obsidian_config(&channel_id)
        .map_err(|e| e.to_string())
}

/// Phase D — owner-side: list the contents of `path` inside a local
/// obsidian-bound channel's vault. Equivalent of the wire-protocol
/// `ListVault` but skipping the ACL check (the owner sees their own
/// vault unconditionally).
#[tauri::command]
async fn porch_list_vault(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    channel_id: String,
    path: String,
) -> Result<Vec<porch::VaultEntry>, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch
        .list_vault(&channel_id, &path)
        .map_err(|e| e.to_string())
}

/// Phase D — owner-side: read raw bytes + mime of a file inside a
/// local obsidian-bound channel's vault. Returns the inline `Inline`
/// variant unless the file exceeds the inline cap, in which case the
/// `TooLarge` variant carries the metadata + size for the UI to
/// render a placeholder.
#[tauri::command]
async fn porch_read_vault_file(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    channel_id: String,
    path: String,
) -> Result<porch::VaultFileResponse, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    let (bytes, mime) = porch
        .read_vault_file(&channel_id, &path)
        .map_err(|e| e.to_string())?;
    let size = bytes.len() as u64;
    if size > porch::MAX_INLINE_ASSET_BYTES as u64 {
        return Ok(porch::VaultFileResponse::TooLarge {
            path,
            mime_type: mime,
            size,
        });
    }
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(porch::VaultFileResponse::Inline {
        path,
        mime_type: mime,
        bytes_b64: b64,
        size,
    })
}

/// Phase D — visitor-side: list a folder inside a peer's
/// obsidian-bound channel.
#[tauri::command]
async fn porch_visit_list_vault(
    servitude_state: tauri::State<'_, ServitudeState>,
    peer_id: String,
    channel_id: String,
    path: String,
) -> Result<Vec<porch::VaultEntry>, String> {
    let (mut control, peer) = resolve_visit_control(&servitude_state, &peer_id).await?;
    porch::visit_list_vault(&mut control, peer, channel_id, path)
        .await
        .map_err(|e| e.to_string())
}

/// Phase D — visitor-side: read a single file from a peer's
/// obsidian-bound channel. Returns the inline-bytes envelope (or
/// `TooLarge`).
#[tauri::command]
async fn porch_visit_get_vault_file(
    servitude_state: tauri::State<'_, ServitudeState>,
    peer_id: String,
    channel_id: String,
    path: String,
) -> Result<porch::VaultFileResponse, String> {
    let (mut control, peer) = resolve_visit_control(&servitude_state, &peer_id).await?;
    porch::visit_read_vault_file(&mut control, peer, channel_id, path)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Porch Phase E — encrypted backup commands
// ---------------------------------------------------------------------------

/// Add (or update the label on) a backup target. The target is a peer
/// the local install will push its encrypted porch backup to. Returns
/// the inserted row.
#[tauri::command]
async fn porch_backup_add_target(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    peer_id: String,
    label: Option<String>,
) -> Result<porch::BackupTarget, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch::backup_targets::add(&porch, &peer_id, label.as_deref()).map_err(|e| e.to_string())
}

/// Remove a configured backup target. Surfaces a typed error if the
/// peer wasn't on the list.
#[tauri::command]
async fn porch_backup_remove_target(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    peer_id: String,
) -> Result<(), String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    let n = porch::backup_targets::remove(&porch, &peer_id).map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("no backup target with peer_id {peer_id}"));
    }
    Ok(())
}

/// List every configured backup target.
#[tauri::command]
async fn porch_backup_list_targets(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
) -> Result<Vec<porch::BackupTarget>, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch::backup_targets::list(&porch).map_err(|e| e.to_string())
}

/// Manually push a fresh backup to `peer_id` right now. Builds the
/// encrypted blob, opens an outbound `/concord/porch-backup/1.0.0`
/// stream, ships it. On success the target's `last_success_at` is
/// updated; on failure `last_failure_*` is updated and the error is
/// returned.
#[tauri::command]
async fn porch_backup_push_now(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    peer_identity_state: tauri::State<'_, PeerIdentityState>,
    app: tauri::AppHandle,
    peer_id: String,
) -> Result<(), String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    let stronghold = get_or_open_peer_identity(&peer_identity_state, &app).await?;
    let local_peer_id = {
        let guard = servitude_state.0.lock().await;
        guard
            .as_ref()
            .and_then(|h| h.libp2p_local_peer_id().map(|p| p.to_base58()))
            .ok_or_else(|| "libp2p runtime is not running".to_string())?
    };
    // Build the blob using the Stronghold-derived seed; if the seed
    // isn't available (a fresh install before `load_or_create` ran),
    // surface a typed error so the UI can prompt the user to start
    // the swarm first.
    let seed = porch::StrongholdSeedAccess::new(&stronghold);
    let blob = porch::backup::build_encrypted_backup(&porch, &local_peer_id, &seed)
        .map_err(|e| format!("build backup blob: {e}"))?;
    let (mut control, peer) = resolve_visit_control(&servitude_state, &peer_id).await?;
    match porch::visit_backup_upload(&mut control, peer, blob).await {
        Ok(()) => {
            let now = chrono::Utc::now().timestamp_millis();
            let _ = porch::backup_targets::record_success(&porch, &peer_id, now);
            Ok(())
        }
        Err(e) => {
            let now = chrono::Utc::now().timestamp_millis();
            let msg = e.to_string();
            let _ = porch::backup_targets::record_failure(&porch, &peer_id, now, &msg);
            Err(format!("upload failed: {msg}"))
        }
    }
}

/// Ask the backup peer for a summary of what they're holding for us.
/// Returns `None` if the peer isn't storing a backup for our peer-id.
#[tauri::command]
async fn porch_backup_check_remote_info(
    servitude_state: tauri::State<'_, ServitudeState>,
    peer_id: String,
) -> Result<Option<porch::ReceivedBackupSummary>, String> {
    let (mut control, peer) = resolve_visit_control(&servitude_state, &peer_id).await?;
    porch::visit_backup_get_my_backup_info(&mut control, peer)
        .await
        .map_err(|e| e.to_string())
}

/// Pull the stored backup off the backup peer, decrypt it with the
/// local Stronghold seed, and OVERWRITE the local `porch.sqlite`.
///
/// DESTRUCTIVE. The caller MUST pass `confirm = true` — the backend
/// rejects any other value as a guard against accidental restores.
/// After a successful restore the porch is closed (so the next access
/// re-opens it against the fresh DB) and the libp2p runtime continues
/// running unchanged.
#[tauri::command]
async fn porch_backup_restore_from(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    peer_identity_state: tauri::State<'_, PeerIdentityState>,
    app: tauri::AppHandle,
    peer_id: String,
    confirm: bool,
) -> Result<RestoreResult, String> {
    if !confirm {
        return Err(
            "porch_backup_restore_from requires confirm=true — this overwrites the local porch DB"
                .to_string(),
        );
    }
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    let db_path = porch
        .db_path()
        .ok_or_else(|| "porch is in-memory; nothing to restore over".to_string())?
        .to_path_buf();
    let stronghold = get_or_open_peer_identity(&peer_identity_state, &app).await?;

    let (mut control, peer) = resolve_visit_control(&servitude_state, &peer_id).await?;
    let blob_opt = porch::visit_backup_get_my_backup(&mut control, peer)
        .await
        .map_err(|e| format!("fetch remote blob: {e}"))?;
    let blob = blob_opt
        .ok_or_else(|| "backup peer is not storing a backup for this install".to_string())?;

    // Drop the live porch connection BEFORE rewriting the file —
    // SQLite locks make atomic-rename fail if a reader is still open.
    drop(porch);
    {
        let mut guard = porch_state.0.lock().await;
        *guard = None;
    }

    let seed = porch::StrongholdSeedAccess::new(&stronghold);
    let schema_version = porch::restore_from_blob(&db_path, &blob, &seed)
        .map_err(|e| format!("restore: {e}"))?;

    // Re-open the porch so subsequent commands see the restored DB.
    // Note: the libp2p backup handler still has a stale Arc<Porch>; in
    // a future polish pass we'd send a re-wire signal. For Phase E the
    // restore path is rare enough that asking the user to restart is
    // an acceptable trade — and the backup handler doesn't write often
    // anyway, so a stale handle is mostly cosmetic.
    let _ = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    Ok(RestoreResult { schema_version })
}

/// List every uploader the local install is currently storing backups
/// for (in its role as a backup-peer). Surfaces in the Backup settings
/// tab so the user can see who's relying on them.
#[tauri::command]
async fn porch_backup_list_received(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
) -> Result<Vec<porch::ReceivedBackupSummary>, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch::list_received_backups(&porch).map_err(|e| e.to_string())
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
struct RestoreResult {
    /// Schema version recorded in the restored blob. The caller can
    /// use this to detect cross-version restores.
    schema_version: i64,
}

// ---------------------------------------------------------------------------
// Porch Phase F — multi-device sync (personal-device tier)
// ---------------------------------------------------------------------------

/// Phase F — return this install's stable device-id (a ULID).
#[tauri::command]
async fn porch_my_device_id(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch.device_id().map_err(|e| e.to_string())
}

/// Phase F — promote `peer_id` to "personal device" status. Dials the
/// remote, exchanges device-ids, commits the local side of the link.
/// The remote user MUST independently call its own equivalent before
/// sync runs in the other direction.
#[tauri::command]
async fn porch_link_personal_device(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    peer_id: String,
    label: Option<String>,
) -> Result<porch::DeviceLink, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    let (mut control, peer) = resolve_visit_control(&servitude_state, &peer_id).await?;
    porch::sync::link::link_and_record(&porch, &mut control, peer, label)
        .await
        .map_err(|e| e.to_string())
}

/// Phase F — remove a personal-device link. Subsequent sync requests
/// from this peer will be refused.
#[tauri::command]
async fn porch_unlink_device(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    peer_id: String,
) -> Result<(), String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch.unlink_device(&peer_id).map_err(|e| e.to_string())
}

/// Phase F — list every linked personal device.
#[tauri::command]
async fn porch_list_device_links(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
) -> Result<Vec<porch::DeviceLink>, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch.list_device_links().map_err(|e| e.to_string())
}

/// Phase F — run a single pull-then-push round against one linked
/// personal device. Returns a SyncReport with per-table counts.
#[tauri::command]
async fn porch_sync_now(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    peer_id: String,
) -> Result<porch::SyncReport, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    let (mut control, peer) = resolve_visit_control(&servitude_state, &peer_id).await?;
    Ok(porch::sync_now(&porch, &mut control, peer).await)
}

/// Phase F — sync against every linked personal device in turn.
/// Returns per-peer SyncReports; errors are recorded inside each report
/// (rather than aborting the loop) so a transient failure with one
/// device doesn't block the others.
#[tauri::command]
async fn porch_sync_all_personal_devices(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
) -> Result<Vec<porch::SyncReport>, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    let links = porch.list_device_links().map_err(|e| e.to_string())?;
    let mut reports = Vec::with_capacity(links.len());
    for link in links {
        match resolve_visit_control(&servitude_state, &link.peer_id).await {
            Ok((mut control, peer)) => {
                reports.push(porch::sync_now(&porch, &mut control, peer).await);
            }
            Err(e) => {
                let mut report = porch::SyncReport::empty(link.peer_id.clone());
                report.error = Some(e);
                reports.push(report);
            }
        }
    }
    Ok(reports)
}

// ---------------------------------------------------------------------------
// User Management Phase 1 — profile CRUD + keychain metadata commands
// ---------------------------------------------------------------------------

/// List every non-tombstoned user profile, primary first.
#[tauri::command]
async fn user_profile_list(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
) -> Result<Vec<porch::UserProfile>, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch.list_profiles().map_err(|e| e.to_string())
}

/// Create a new profile. The new row is non-primary; promote via
/// `user_profile_set_primary` if desired.
#[tauri::command]
async fn user_profile_create(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    display_name: String,
) -> Result<porch::UserProfile, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch.create_profile(display_name).map_err(|e| e.to_string())
}

/// Rename a profile.
#[tauri::command]
async fn user_profile_rename(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    id: String,
    display_name: String,
) -> Result<porch::UserProfile, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch.rename_profile(&id, display_name).map_err(|e| e.to_string())
}

/// Promote a profile to primary, demoting whichever profile was
/// previously primary inside the same transaction.
#[tauri::command]
async fn user_profile_set_primary(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    id: String,
) -> Result<porch::UserProfile, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch.set_primary(&id).map_err(|e| e.to_string())
}

/// Set or clear a profile's avatar URL.
#[tauri::command]
async fn user_profile_set_avatar(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    id: String,
    avatar_url: Option<String>,
) -> Result<porch::UserProfile, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch.set_profile_avatar(&id, avatar_url).map_err(|e| e.to_string())
}

/// Delete a profile. The schema's `ON DELETE CASCADE` drops every
/// keychain entry the profile owns. Refuses to delete the only
/// remaining profile or the primary without `confirm_primary_demotion`.
#[tauri::command]
async fn user_profile_delete(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    id: String,
    confirm_primary_demotion: Option<bool>,
) -> Result<(), String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch
        .delete_profile(&id, confirm_primary_demotion.unwrap_or(false))
        .map_err(|e| e.to_string())
}

/// List every keychain entry owned by `profile_id`. Returns metadata
/// only — credential ciphertext / nonce never leaves the porch.
#[tauri::command]
async fn user_profile_keychain_list(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<Vec<porch::KeychainEntry>, String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch.list_keychain(&profile_id).map_err(|e| e.to_string())
}

/// Remove a keychain entry by id.
#[tauri::command]
async fn user_profile_keychain_remove(
    porch_state: tauri::State<'_, PorchState>,
    servitude_state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    entry_id: String,
) -> Result<(), String> {
    let porch = get_or_open_porch(&porch_state, &servitude_state, &app).await?;
    porch.remove_keychain_entry(&entry_id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Phase G — tunnel-only inbound hardening
//
// Three commands let the React Settings panel read + mutate
// `<app_local_data_dir>/tunnel_config.json` and ask the running swarm
// for a snapshot of which CIDRs it currently trusts. The mutation
// command persists the JSON file AND hot-swaps the running swarm's
// gate state via the shared Arc, so a toggle takes effect without
// restarting the servitude.
// ---------------------------------------------------------------------------

/// Read the current tunnel config from disk. Returns the default
/// permissive config (`enforce=false`, empty extras) if no file
/// exists yet — that's the first-boot posture.
#[tauri::command]
async fn tunnel_get_config(
    app: tauri::AppHandle,
) -> Result<servitude::network::TunnelConfig, String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("no app_local_data_dir: {e}"))?;
    servitude::network::TunnelConfig::load(&data_dir).map_err(|e| e.to_string())
}

/// Persist a new tunnel config to disk AND push it into the running
/// swarm's gate state (if one is up). The pushed state takes effect
/// immediately — subsequent inbound connections are gated by the new
/// flags. Outbound dials remain unchanged regardless.
#[tauri::command]
async fn tunnel_set_config(
    state: tauri::State<'_, ServitudeState>,
    app: tauri::AppHandle,
    config: servitude::network::TunnelConfig,
) -> Result<servitude::network::TunnelConfig, String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("no app_local_data_dir: {e}"))?;
    config.save(&data_dir).map_err(|e| e.to_string())?;

    // Hot-swap the running swarm's gate, if any. Falling through to
    // the next servitude_start is fine — the config will be loaded
    // off disk at that point.
    let extras = config.parsed_extras();
    let interfaces = servitude::network::TunnelInterfaces::detect(&extras);
    {
        let guard = state.0.lock().await;
        if let Some(handle) = guard.as_ref() {
            if let Some(gate_state) = handle.gate_state() {
                gate_state.update(config.enforce, interfaces);
            }
        }
    }
    Ok(config)
}

/// Snapshot of the currently-trusted tunnel CIDRs + the operator's
/// enforce flag. Reads the persisted config off disk for the
/// authoritative `enforce` value (matches the swarm post-set), and
/// runs a fresh detect() against the operator's extras for the
/// effective CIDR set the next swarm start would use.
#[tauri::command]
async fn tunnel_detect_interfaces(
    app: tauri::AppHandle,
) -> Result<servitude::network::TunnelDetectionReport, String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("no app_local_data_dir: {e}"))?;
    let cfg =
        servitude::network::TunnelConfig::load(&data_dir).map_err(|e| e.to_string())?;
    let extras = cfg.parsed_extras();
    let interfaces = servitude::network::TunnelInterfaces::detect(&extras);
    Ok(interfaces.report(cfg.enforce, &extras))
}

// ---------------------------------------------------------------------------
// Phase 8 — voice path selection
// ---------------------------------------------------------------------------

/// Frontend-supplied participant descriptor. `peer_id` is the libp2p
/// PeerId in base58 form if the local peer-store has a resolved entry
/// for this Matrix user, else `None`. The Matrix user ID is carried
/// through for diagnostics + future mesh-orchestration use; the
/// selector itself only reads `peer_id` (presence/absence).
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
struct VoiceParticipantInput {
    matrix_user_id: String,
    /// Resolved peer_id from the local peer-store if known, else
    /// null. `null` signals a web-only participant per the Phase 8
    /// design-doc rule.
    peer_id: Option<String>,
}

/// Wire form of [`servitude::voice::VoicePath`]. The TS type
/// `VoicePath = "libp2p_mesh" | "livekit_sfu"` matches these literals
/// 1:1.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
struct VoicePathSelection {
    /// `"libp2p_mesh"` or `"livekit_sfu"`.
    path: String,
    /// Stable, snake_case reason for the chosen path —
    /// `"above_cap_8"` / `"web_only_participant_present"` /
    /// `"all_native_under_cap"`. The UI translates these to user-
    /// facing copy.
    reason: String,
}

/// Phase 8: select the voice path for a call given its participant
/// list. Pure function — no IO, no state. Reads `peer_id == Some(_)`
/// as native, `peer_id == None` as web-only.
///
/// Decision rules (full text in
/// `src-tauri/src/servitude/voice/selector.rs`):
///   * `participants.len() > 8` → SFU (`"above_cap_8"`).
///   * any null `peer_id` → SFU (`"web_only_participant_present"`).
///   * else → mesh (`"all_native_under_cap"`).
#[tauri::command]
async fn select_voice_path(
    participants: Vec<VoiceParticipantInput>,
) -> Result<VoicePathSelection, String> {
    use servitude::voice::{ParticipantKind, VoicePath, VoicePathSelector};
    let mut kinds: Vec<ParticipantKind> = Vec::with_capacity(participants.len());
    for p in &participants {
        match &p.peer_id {
            Some(pid_str) => {
                let pid = pid_str.parse::<libp2p::PeerId>().map_err(|e| {
                    format!(
                        "select_voice_path: invalid peer_id {:?}: {}",
                        pid_str, e
                    )
                })?;
                kinds.push(ParticipantKind::Native { peer_id: pid });
            }
            None => kinds.push(ParticipantKind::WebOnly),
        }
    }
    let (path, reason) = VoicePathSelector::select_with_reason(&kinds);
    let path_str = match path {
        VoicePath::LibP2pMesh => "libp2p_mesh",
        VoicePath::LiveKitSfu => "livekit_sfu",
    };
    Ok(VoicePathSelection {
        path: path_str.to_string(),
        reason: reason.as_str().to_string(),
    })
}

// ---------------------------------------------------------------------------
// Phase 8 follow-up — voice mesh call orchestration commands
// ---------------------------------------------------------------------------

/// Tauri-managed state wrapping the shared voice-call registry.
///
/// One [`VoiceCallRegistry`](servitude::voice::VoiceCallRegistry) per
/// app process. The registry holds every active mesh-mode voice call
/// keyed by `room_id`, and serves as the [`VoiceCallSink`](servitude::voice::VoiceCallSink)
/// the libp2p signaling handler routes inbound envelopes through.
pub struct VoiceMeshState(pub std::sync::Arc<servitude::voice::VoiceCallRegistry>);

/// Per-peer connection status surfaced to the React side via
/// [`voice_mesh_status`]. Snake_case on the wire.
#[derive(serde::Serialize, Debug, Clone)]
struct VoicePeerStatus {
    peer_id: String,
    state: String,
}

/// Aggregate status of a single mesh-mode call.
#[derive(serde::Serialize, Debug, Clone)]
struct VoiceMeshStatus {
    room_id: String,
    /// `"active"` while the call is up; `"closed"` between teardown
    /// and the next status poll (the registry removes closed calls).
    state: String,
    peers: Vec<VoicePeerStatus>,
}

/// Phase 8 follow-up — join (or create) a mesh-mode voice call.
///
/// For each `peer_id` in `participants` the orchestrator builds a real
/// [`WebRtcMediaPeer`](servitude::voice::WebRtcMediaPeer), creates an
/// Offer, and forwards it over the libp2p voice-signaling protocol.
/// The remote peer's call registry receives the Offer, generates an
/// Answer, and the SDP / ICE round-trip continues until DTLS comes up.
///
/// Mic capture is NOT wired here yet — the local audio track exists
/// but is fed by an internal channel. See `voice/media.rs` module-doc
/// for the `TODO(mesh-media-followup)` boundary.
#[tauri::command]
async fn voice_mesh_join(
    room_id: String,
    participants: Vec<String>,
    ice_servers: Vec<String>,
    state: tauri::State<'_, ServitudeState>,
    mesh: tauri::State<'_, VoiceMeshState>,
) -> Result<(), String> {
    let (outbound_sender, local_peer_id) = {
        let guard = state.0.lock().await;
        let handle = guard
            .as_ref()
            .ok_or_else(|| "servitude not started — cannot join mesh".to_string())?;
        let tx = handle
            .voice_outbound_sender()
            .ok_or_else(|| "libp2p runtime not started — cannot join mesh".to_string())?;
        let pid = handle
            .libp2p_local_peer_id()
            .ok_or_else(|| "libp2p local peer_id not available".to_string())?;
        (tx, pid)
    };

    // Parse remote peer ids.
    let mut parsed_peers: Vec<libp2p::PeerId> = Vec::with_capacity(participants.len());
    for s in &participants {
        let pid = s
            .parse::<libp2p::PeerId>()
            .map_err(|e| format!("voice_mesh_join: invalid peer_id {s:?}: {e}"))?;
        if pid != local_peer_id {
            parsed_peers.push(pid);
        }
    }

    // Build the call. New call per room — the registry rejects duplicates.
    let mut call = servitude::voice::VoiceCall::new(
        room_id.clone(),
        local_peer_id,
        outbound_sender,
        ice_servers,
    )
    .map_err(|e| format!("voice_mesh_join: build call: {e}"))?;

    // Initiator path — push an Offer to every known remote.
    for pid in parsed_peers {
        if let Err(e) = call.add_peer_as_initiator(pid).await {
            // Don't abort the entire join on a per-peer add failure —
            // log it + continue so the other peers in the room still
            // get an Offer. The orchestrator's state machine will
            // surface the per-peer status via `voice_mesh_status`.
            log::warn!(
                target: "concord::voice",
                "voice_mesh_join: add_peer({pid}) failed: {e}"
            );
        }
    }

    mesh.0
        .insert(call)
        .await
        .map_err(|e| format!("voice_mesh_join: registry insert: {e}"))?;
    Ok(())
}

/// Phase 8 follow-up — leave a mesh-mode voice call.
///
/// Closes every [`WebRtcMediaPeer`](servitude::voice::WebRtcMediaPeer)
/// associated with the room, emits a `Bye` over the signaling wire to
/// every remote, and removes the call from the registry.
#[tauri::command]
async fn voice_mesh_leave(
    room_id: String,
    mesh: tauri::State<'_, VoiceMeshState>,
) -> Result<(), String> {
    mesh.0
        .remove(&room_id)
        .await
        .map_err(|e| format!("voice_mesh_leave: {e}"))
}

/// Phase 8 follow-up — snapshot the per-peer call state for the UI.
///
/// Returns `Err(_)` if no call is active for `room_id`. The React side
/// uses this to render a "Bob: connected / Carol: connecting" panel
/// next to the participant list.
#[tauri::command]
async fn voice_mesh_status(
    room_id: String,
    mesh: tauri::State<'_, VoiceMeshState>,
) -> Result<VoiceMeshStatus, String> {
    let snap = mesh
        .0
        .snapshot_status(&room_id)
        .await
        .map_err(|e| format!("voice_mesh_status: {e}"))?;
    let peers = snap
        .peers
        .into_iter()
        .map(|(pid, st)| VoicePeerStatus {
            peer_id: pid.to_string(),
            state: format!("{:?}", st),
        })
        .collect();
    Ok(VoiceMeshStatus {
        room_id,
        state: snap.state,
        peers,
    })
}

/// Spawn a background task that mirrors the running libp2p swarm's
/// broadcast events into the shared [`SwarmStateCache`] AND re-emits each
/// event onto Tauri's app-wide event bus under the `"peer_swarm_event"`
/// channel so React listeners can subscribe live.
///
/// The task polls `ServitudeState` for a started libp2p runtime; once the
/// swarm comes up, it locks onto the broadcast receiver and runs until
/// the receiver drops (i.e. the swarm stops). Then it loops back to the
/// poll path so a subsequent restart re-attaches transparently.
fn spawn_swarm_event_mirror(
    app: tauri::AppHandle,
    cache: std::sync::Arc<SwarmStateCache>,
) {
    tauri::async_runtime::spawn(async move {
        // Poll interval for the "is the swarm running yet?" check. Cheap
        // — just a lock-and-check; not a network call.
        let poll = std::time::Duration::from_millis(500);
        loop {
            let sender_opt = {
                let state = app.state::<ServitudeState>();
                let guard = state.0.lock().await;
                guard
                    .as_ref()
                    .and_then(|h| h.libp2p_event_sender())
            };
            let Some(sender) = sender_opt else {
                tokio::time::sleep(poll).await;
                continue;
            };

            // Seed the cache with what we know now (PeerId, no events
            // yet). Subsequent loop iterations refresh peer_id if the
            // swarm restarts under a new (Stronghold seed identical)
            // identity.
            let peer_id_str = {
                let state = app.state::<ServitudeState>();
                let guard = state.0.lock().await;
                guard
                    .as_ref()
                    .and_then(|h| h.libp2p_local_peer_id())
                    .map(|p| p.to_string())
                    .unwrap_or_default()
            };
            if !peer_id_str.is_empty() {
                if let Ok(mut snap) = cache.0.lock() {
                    snap.our_peer_id = peer_id_str;
                }
            }

            let mut rx = sender.subscribe();
            // Drain the broadcast channel until the sender is dropped
            // (swarm stop) — at that point `recv()` returns
            // `Err(RecvError::Closed)` and we break to re-poll.
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        apply_event(&cache, &event);
                        // Mirror the event onto the app's event bus.
                        // Failures here are non-fatal — if no listener
                        // is attached the emit silently drops.
                        let payload = swarm_event_payload(&event);
                        let _ = app.emit("peer_swarm_event", payload);

                        // mDNS peers also fire on a dedicated event
                        // channel so the React-side `lanPeers` API
                        // wrapper can maintain its session-scoped LAN
                        // list without parsing every `peer_swarm_event`
                        // payload. The 2026-05-29 architecture redirect
                        // (mDNS + peer cards, no DHT) treats LAN
                        // discovery as a first-class UI surface.
                        if let P2pSwarmEvent::MdnsPeerDiscovered {
                            peer_id,
                            multiaddrs,
                        } = &event
                        {
                            let lan_payload = serde_json::json!({
                                "peer_id": peer_id,
                                "multiaddrs": multiaddrs,
                            });
                            let _ = app.emit("peer_lan_discovered", lan_payload);
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        // Slow subscriber — broadcast dropped some
                        // events. Keep going; the cache will reconverge.
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        // Swarm event loop exited. Reset the cache so
                        // stale multiaddrs don't appear "live" while
                        // the swarm is stopped, then loop back to
                        // poll for a restart.
                        if let Ok(mut snap) = cache.0.lock() {
                            *snap = SwarmStatus::default();
                        }
                        break;
                    }
                }
            }
        }
    });
}

/// Register the concord:// deeplink handler.
///
/// The Tauri deep-link plugin emits a `deep-link://new-url` event on the
/// runtime's event bus whenever the OS hands the app a custom-scheme
/// URL (QR scan launcher, click in another app, bare CLI arg on
/// Windows/Linux). This function attaches a callback that:
///
///   1. Parses each incoming URL via `peer_store::handle_deeplink_url`,
///      which base64url-decodes the payload, JSON-deserializes into a
///      `PeerCard`, validates the fields, and `add()`s under
///      `PeerSource::Deeplink`.
///   2. Emits `peer_paired` (success) or `peer_paired_error` (failure
///      with `{stage, message}`) on the renderer event bus so the
///      Settings → Profile → Paired Peers section can react.
///
/// All failures are logged at `warn`/`debug` only — never `error`. A
/// deeplink URL is untrusted input and a malformed value must never
/// raise a panic banner.
fn spawn_deeplink_listener(app: tauri::AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;

    // Register the on_open_url callback synchronously — the plugin's
    // event-bus listener handles concurrent URLs internally. We move
    // each URL into an async task so the peer-store IO doesn't block
    // the event-bus thread.
    let deep_link = app.deep_link();
    let app_for_cb = app.clone();
    deep_link.on_open_url(move |event| {
        let app = app_for_cb.clone();
        let urls = event.urls();
        tauri::async_runtime::spawn(async move {
            for url in urls {
                handle_one_deeplink(&app, url.as_str()).await;
            }
        });
    });
}

/// Handle a single deeplink URL: forward to peer_store, emit the
/// resulting `peer_paired` / `peer_paired_error` event back to the
/// renderer. Failures here are logged + emitted — never panicked.
async fn handle_one_deeplink(app: &tauri::AppHandle, url: &str) {
    log::debug!(target: "concord::deeplink", "received deeplink url: {url}");

    // Open (or reuse) the peer-identity stronghold — same path the
    // `peer_store_*` Tauri commands use. If this fails, the user
    // hasn't passed the identity-creation step yet; emit a structured
    // error and bail.
    let state = app.state::<PeerIdentityState>();
    let stronghold = match get_or_open_peer_identity(&state, app).await {
        Ok(h) => h,
        Err(msg) => {
            log::warn!(
                target: "concord::deeplink",
                "failed to open peer-identity stronghold for deeplink: {msg}"
            );
            let _ = app.emit(
                "peer_paired_error",
                serde_json::json!({
                    "stage": "add",
                    "message": format!("identity unavailable: {msg}"),
                }),
            );
            return;
        }
    };

    match peer_store::handle_deeplink_url(&stronghold, url).await {
        Ok(known_peer) => {
            log::debug!(
                target: "concord::deeplink",
                "deeplink paired peer {}", known_peer.peer_id
            );
            let payload: KnownPeerPublic = known_peer.into();
            if let Err(emit_err) = app.emit("peer_paired", payload) {
                log::warn!(
                    target: "concord::deeplink",
                    "failed to emit peer_paired event: {emit_err}"
                );
            }
        }
        Err(e) => {
            // Untrusted-input failure path. Stage tag lets the UI
            // distinguish "couldn't read the QR" vs "couldn't add the
            // peer to the store".
            log::warn!(
                target: "concord::deeplink",
                "deeplink handling failed at stage {:?}: {}",
                e.stage(),
                e.message()
            );
            let stage = match e.stage() {
                peer_store::DeeplinkStage::Decode => "decode",
                peer_store::DeeplinkStage::Json => "json",
                peer_store::DeeplinkStage::Validate => "validate",
                peer_store::DeeplinkStage::Add => "add",
            };
            let _ = app.emit(
                "peer_paired_error",
                serde_json::json!({
                    "stage": stage,
                    "message": e.message(),
                }),
            );
        }
    }
}

/// Apply a single swarm event to the shared cache. Pure function on
/// the cache — no side effects.
fn apply_event(cache: &SwarmStateCache, event: &P2pSwarmEvent) {
    let Ok(mut snap) = cache.0.lock() else { return };
    snap.last_event = Some(swarm_event_label(event));
    match event {
        P2pSwarmEvent::LocalAddrChanged { addr } => {
            let s = addr.to_string();
            if !snap.our_multiaddrs.iter().any(|a| a == &s) {
                snap.our_multiaddrs.push(s);
            }
        }
        P2pSwarmEvent::PeerCountChanged { count } => {
            snap.peer_count = *count;
        }
        P2pSwarmEvent::DialSuccess { .. } | P2pSwarmEvent::DialFailure { .. } => {
            // Captured via last_event only — the count is updated
            // through the separate PeerCountChanged event.
        }
        P2pSwarmEvent::MdnsPeerDiscovered { .. } => {
            // Captured via last_event only — the LAN-discovered peer
            // list is maintained in-memory on the React side via the
            // `peer_lan_discovered` event bus emission (see
            // `swarm_event_payload` and `client/src/api/lanPeers.ts`).
            // The swarm-wide multiaddr / peer-count cache stays
            // dedicated to the listen-addr + connected-count signal.
        }
        P2pSwarmEvent::FederationStreamOpened { .. } => {
            // Captured via last_event only — the federation stream
            // surface is per-protocol-ID and per-peer, distinct from
            // the swarm-wide multiaddr / peer-count cache.
        }
    }
}

/// Short human-readable label for a swarm event. Used for both the
/// cache's `last_event` field AND the per-event emit payload below.
fn swarm_event_label(event: &P2pSwarmEvent) -> String {
    match event {
        P2pSwarmEvent::LocalAddrChanged { addr } => format!("listening: {addr}"),
        P2pSwarmEvent::PeerCountChanged { count } => format!("peers: {count}"),
        P2pSwarmEvent::DialSuccess { peer_id } => format!("dialed: {peer_id}"),
        P2pSwarmEvent::DialFailure { peer_id, reason } => match peer_id {
            Some(p) => format!("dial failed ({p}): {reason}"),
            None => format!("dial failed: {reason}"),
        },
        P2pSwarmEvent::MdnsPeerDiscovered { peer_id, .. } => {
            format!("lan peer: {peer_id}")
        }
        P2pSwarmEvent::FederationStreamOpened {
            protocol_id,
            peer_id,
        } => {
            format!("federation stream ({protocol_id}) from {peer_id}")
        }
    }
}

/// JSON payload emitted on the `peer_swarm_event` Tauri event bus.
/// Snake_case fields; React side transcribes to camelCase.
fn swarm_event_payload(event: &P2pSwarmEvent) -> serde_json::Value {
    match event {
        P2pSwarmEvent::LocalAddrChanged { addr } => serde_json::json!({
            "kind": "local_addr_changed",
            "addr": addr.to_string(),
        }),
        P2pSwarmEvent::PeerCountChanged { count } => serde_json::json!({
            "kind": "peer_count_changed",
            "count": *count,
        }),
        P2pSwarmEvent::DialSuccess { peer_id } => serde_json::json!({
            "kind": "dial_success",
            "peer_id": peer_id.to_string(),
        }),
        P2pSwarmEvent::DialFailure { peer_id, reason } => serde_json::json!({
            "kind": "dial_failure",
            "peer_id": peer_id.map(|p| p.to_string()),
            "reason": reason,
        }),
        P2pSwarmEvent::MdnsPeerDiscovered {
            peer_id,
            multiaddrs,
        } => serde_json::json!({
            "kind": "mdns_peer_discovered",
            "peer_id": peer_id,
            "multiaddrs": multiaddrs,
        }),
        P2pSwarmEvent::FederationStreamOpened {
            protocol_id,
            peer_id,
        } => serde_json::json!({
            "kind": "federation_stream_opened",
            "protocol_id": protocol_id,
            "peer_id": peer_id,
        }),
    }
}

#[tauri::command]
fn get_server_url(app: tauri::AppHandle) -> String {
    let store = app.store("settings.json").expect("failed to open store");
    store
        .get("server_url")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default()
}

#[tauri::command]
fn set_server_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let store = app.store("settings.json").expect("failed to open store");
    store.set("server_url", serde_json::json!(url));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Start the embedded servitude. Loads the persisted `ServitudeConfig`
/// from the settings store (falling back to defaults on first run),
/// then either constructs a fresh `ServitudeHandle` or — if one already
/// exists in the `Stopped` state — replaces it with a new handle built
/// from the freshly loaded config, and drives the lifecycle into
/// `Running`.
///
/// The recreate-on-restart behavior exists because `ServitudeHandle`
/// captures its config at construction time and exposes no public
/// setter. Without recreating it, edits the user makes between a stop
/// and the next start would silently never take effect.
#[tauri::command]
async fn servitude_start(
    state: tauri::State<'_, ServitudeState>,
    identity_state: tauri::State<'_, PeerIdentityState>,
    mesh_state: tauri::State<'_, VoiceMeshState>,
    porch_state: tauri::State<'_, PorchState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // Load config OUTSIDE the lock so the (very cheap) store access never
    // overlaps with the mutex guard.
    let config = ServitudeConfig::from_store(&app).map_err(|e| e.to_string())?;

    // Open (or reuse) the peer-identity Stronghold. The libp2p baseline
    // transport inside the servitude handle derives its `PeerId` from
    // the same per-install Ed25519 seed — see `servitude/identity.rs`
    // for the architectural unification note.
    let stronghold = get_or_open_peer_identity(&identity_state, &app).await?;

    // Porch Phase A — open (or reuse) the shared porch BEFORE we grab
    // the servitude lock. The porch is wired into the libp2p runtime
    // via `set_porch` below so its inbound handler is registered the
    // moment the swarm starts.
    let porch_arc = {
        let mut guard = porch_state.0.lock().await;
        if let Some(p) = guard.as_ref() {
            p.clone()
        } else {
            let data_dir = app
                .path()
                .app_local_data_dir()
                .map_err(|e| format!("no app_local_data_dir: {e}"))?;
            let porch = porch::Porch::open(&data_dir).map_err(|e| e.to_string())?;
            let porch_arc = std::sync::Arc::new(porch);
            *guard = Some(porch_arc.clone());
            porch_arc
        }
    };

    let mut guard = state.0.lock().await;

    // Recreate the handle if either (a) there is no handle yet, or
    // (b) there is an existing handle that is currently Stopped. Case
    // (b) is the restart path — we MUST rebuild it so the freshly
    // loaded config is what the next run uses. If the existing handle
    // is in any non-Stopped state we leave it alone and let `start()`
    // below reject it with `AlreadyRunning`.
    let should_recreate = match guard.as_ref() {
        None => true,
        Some(handle) => handle.status() == LifecycleState::Stopped,
    };
    if should_recreate {
        let mut handle = ServitudeHandle::new_with_identity(config, Some(stronghold))
            .map_err(|e| e.to_string())?;
        // Phase 8 follow-up — wire the shared voice-mesh registry
        // into the libp2p runtime BEFORE start() so the signaling
        // handler's sink is the real call orchestrator rather than
        // the Phase 8 NoopVoiceSink. Idempotent — setting the
        // registry on a fresh runtime has no side effects until
        // start() consumes it.
        handle.set_voice_registry(mesh_state.0.clone());
        // Porch Phase A — wire the shared porch into the libp2p
        // runtime so the inbound `/concord/porch/1.0.0` handler is
        // registered when the swarm starts. Idempotent.
        handle.set_porch(porch_arc.clone());
        // Phase G — load the persisted tunnel config and wire the
        // operator's enforce flag + extras CIDRs into the libp2p
        // runtime's gate BEFORE start() so the swarm's first listen
        // accepts/rejects inbound peers under the operator's policy
        // from the very first packet. First-boot returns the default
        // permissive config (enforce=false).
        let data_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("no app_local_data_dir: {e}"))?;
        let tunnel_cfg = servitude::network::TunnelConfig::load(&data_dir)
            .map_err(|e| format!("load tunnel_config: {e}"))?;
        let extras = tunnel_cfg.parsed_extras();
        let interfaces = servitude::network::TunnelInterfaces::detect(&extras);
        let gate_state = servitude::network::connection_gate::GateState::new(
            tunnel_cfg.enforce,
            interfaces,
        );
        handle.set_gate_state(gate_state);
        *guard = Some(handle);
    }

    let handle = guard
        .as_mut()
        .expect("handle just inserted if it was None or Stopped");
    handle.start().await.map_err(|e| e.to_string())
}

/// Stop the embedded servitude. Leaves the handle in place (in the
/// `Stopped` state) so a subsequent `servitude_start` can replace it
/// with a freshly configured one.
#[tauri::command]
async fn servitude_stop(state: tauri::State<'_, ServitudeState>) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    match guard.as_mut() {
        Some(handle) => handle.stop().await.map_err(|e| e.to_string()),
        None => Err("servitude has not been started".to_string()),
    }
}

/// Typed shape for [`servitude_status`].
///
/// Returned directly (not as a serde-encoded JSON string) so the
/// TypeScript caller's `invoke<ServitudeStatusResponse>(...)` type
/// parameter is honored by the Tauri runtime — any future field
/// rename produces a compile error on the Rust side and a runtime
/// shape mismatch the TS side can catch with structural narrowing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServitudeStatusResponse {
    /// Current lifecycle state of the embedded servitude.
    pub state: LifecycleState,
    /// Map of transport name to failure reason for any transport that
    /// is in a degraded state. Empty when nothing is degraded.
    pub degraded_transports: std::collections::HashMap<String, String>,
}

/// Report the current lifecycle state of the embedded servitude.
///
/// INS-024 Wave 4: Returns the [`ServitudeStatusResponse`] struct with
/// `state` (lifecycle enum) and `degraded_transports` (map of
/// transport name -> failure reason). If no handle exists yet (never
/// started), returns `state = Stopped` with an empty degraded map.
///
/// Wire shape: a typed struct, NOT a serde-encoded JSON string.
/// The TypeScript caller invokes with `invoke<ServitudeStatusResponse>`
/// and receives the deserialized object directly. The earlier
/// `Result<String, String>` shape required a hand-rolled `JSON.parse`
/// on the frontend with no compile-time check that the Rust+TS shapes
/// agreed; any rename on either side silently broke the renderer.
#[tauri::command]
async fn servitude_status(
    state: tauri::State<'_, ServitudeState>,
) -> Result<ServitudeStatusResponse, String> {
    let guard = state.0.lock().await;
    let (state_value, degraded) = match guard.as_ref() {
        Some(handle) => (handle.status(), handle.degraded_transports().clone()),
        None => (LifecycleState::Stopped, std::collections::HashMap::new()),
    };
    Ok(ServitudeStatusResponse {
        state: state_value,
        degraded_transports: degraded,
    })
}

/// Return the embedded tuwunel's per-instance registration token.
///
/// W2-11. The Host onboarding flow reads this AFTER `servitude_start`
/// has resolved Running. The token gates the
/// `m.login.registration_token` UI-Authentication flow used to create
/// the owner account on a freshly-spawned local homeserver, AND any
/// invitation tokens the owner shares with later members.
///
/// Returns Err when:
///   * servitude has never been started (no handle), OR
///   * the handle exists but a MatrixFederation transport hasn't
///     been started yet (token not materialized).
///
/// The token is regenerated only when the on-disk file at
/// `<data_dir>/registration_token` is missing or empty — see
/// `ensure_registration_token` for the exact semantics. Calls to this
/// command after a successful start are idempotent: the SAME token is
/// returned every time.
#[tauri::command]
async fn servitude_get_registration_token(
    state: tauri::State<'_, ServitudeState>,
) -> Result<String, String> {
    let guard = state.0.lock().await;
    match guard.as_ref() {
        Some(handle) => match handle.registration_token() {
            Some(t) => Ok(t.to_string()),
            None => Err(
                "servitude is not running, or the matrix-federation transport \
                 has not yet materialized its registration token"
                    .to_string(),
            ),
        },
        None => Err("servitude has not been started".to_string()),
    }
}

/// Drive owner registration through whichever embedded homeserver
/// backend is active for this platform. Wave 3 sprint W3-05.
///
/// Linux/macOS (tuwunel): performs the
/// `m.login.registration_token` UIA dance using the per-instance
/// registration_token, then `/login` to obtain an access token.
///
/// Windows (dendrite): shells out to bundled `create-account.exe`
/// `-admin` to register + elevate, then `/login` to obtain an
/// access token. (Dendrite does NOT support the registration_token
/// UIA flow — see `dendrite_federation.rs` module-doc for the
/// rationale.)
///
/// The frontend's HostOnboarding flow calls this exactly once during
/// the spinner step. On success, the returned tuple drives the
/// useSourcesStore.markOwner() flow that records the owner badge.
#[tauri::command]
async fn servitude_register_owner(
    state: tauri::State<'_, ServitudeState>,
    username: String,
    password: String,
) -> Result<RegisterOwnerResponse, String> {
    if username.is_empty() {
        return Err("username must not be empty".to_string());
    }
    if password.is_empty() {
        return Err("password must not be empty".to_string());
    }

    let guard = state.0.lock().await;
    let handle = guard
        .as_ref()
        .ok_or_else(|| "servitude has not been started".to_string())?;
    handle
        .register_owner(&username, &password)
        .await
        .map_err(|e| e.to_string())
}

/// Phase 7 — return the currently configured deployment profile.
///
/// Reads the persisted [`ServitudeConfig`] from the shared settings
/// store. The env override (`CONCORD_PROFILE=web_first`, set by
/// `docker-compose.yml` for the concord-api container) is applied
/// inside `ServitudeConfig::from_store` so the value returned here
/// reflects the EFFECTIVE profile, not just what's on disk. Native
/// builds with no env override report whatever the user last toggled
/// to; fresh installs report [`Profile::P2pOnly`].
///
/// Used by the Settings → Profile → "Deployment profile" section to
/// render the toggle's current state.
#[tauri::command]
async fn get_servitude_profile(app: tauri::AppHandle) -> Result<Profile, String> {
    let cfg = ServitudeConfig::from_store(&app).map_err(|e| e.to_string())?;
    Ok(cfg.profile)
}

/// Phase 7 — persist a new deployment profile to the settings store.
///
/// Writes the new profile through to the persisted [`ServitudeConfig`]
/// so the next `servitude_start` materializes the right transport set.
/// The currently-running servitude (if any) is NOT restarted by this
/// command — the caller is expected to follow up with
/// `servitude_stop` + `servitude_start` (or rely on the next
/// app launch) so the user has a confirmation moment before the
/// service set actually changes.
///
/// Web / docker builds: this command exists on every platform but
/// docker installs use `CONCORD_PROFILE=web_first` env to force the
/// runtime value, so calling it on a docker stack only changes the
/// on-disk persisted value (which the env override masks). The
/// frontend Settings section renders read-only in the web build for
/// exactly that reason.
#[tauri::command]
async fn set_servitude_profile(
    app: tauri::AppHandle,
    profile: Profile,
) -> Result<(), String> {
    // Load the existing config, mutate `profile`, save back. This
    // preserves every other field the user (or default) set —
    // display_name, listen_port, enabled_transports — so flipping the
    // profile doesn't clobber unrelated settings.
    let mut cfg = ServitudeConfig::from_store(&app).map_err(|e| e.to_string())?;
    cfg.profile = profile;
    // Flipping to a hosting profile (WebFirst) requires the
    // MatrixFederation transport to be present in `enabled_transports`
    // — `servitude_register_owner` and every other Matrix surface
    // depends on it. If the stored config drifted (older builds, hand
    // edits, my own earlier resets), the flip silently leaves the
    // transport list empty and the next `register_owner` fails with
    // "no MatrixFederation transport configured for register_owner."
    // Make the flip-to-hosting path self-healing: ensure the
    // transport is in the list whenever the profile lands on WebFirst.
    if matches!(cfg.profile, Profile::WebFirst)
        && !cfg
            .enabled_transports
            .iter()
            .any(|t| matches!(t, servitude::config::Transport::MatrixFederation))
    {
        cfg.enabled_transports
            .push(servitude::config::Transport::MatrixFederation);
    }
    cfg.save_to_store(&app).map_err(|e| e.to_string())?;
    Ok(())
}

/// Vanity instance name — the operator-chosen label that replaces
/// "local" on the source-rail home tile AND is broadcast in the
/// libp2p Identify protocol's `agent_version` so connecting peers
/// can confirm they've reached the right device. Backed by
/// `ServitudeConfig.display_name`. An empty string means "user has
/// not picked a name yet" — the UI then renders the default "local"
/// label and the Identify agent_version omits the parenthesized
/// suffix.
#[tauri::command]
async fn get_instance_name(app: tauri::AppHandle) -> Result<String, String> {
    let cfg = ServitudeConfig::from_store(&app).map_err(|e| e.to_string())?;
    // ServitudeConfig::validate() forbids an empty display_name on
    // the disk path, so on a fresh install we return the synthetic
    // default rather than the persisted "concord-node" placeholder.
    // The renderer treats an empty string as "user hasn't picked".
    if cfg.display_name.trim().is_empty()
        || cfg.display_name.trim() == "concord-node"
    {
        Ok(String::new())
    } else {
        Ok(cfg.display_name)
    }
}

/// Persist the operator's vanity instance name. Empty / whitespace-
/// only inputs clear the name (the config layer falls back to its
/// default placeholder so on-disk validation still passes); the
/// renderer treats those as "unset" via [`get_instance_name`].
///
/// The change takes effect on the next servitude start/stop cycle:
/// the Identify protocol's `agent_version` is fixed at swarm-build
/// time and there is intentionally no live `set_agent_version` —
/// peers learn the new name when they reconnect, matching how
/// profile flips behave.
#[tauri::command]
async fn set_instance_name(
    app: tauri::AppHandle,
    name: String,
) -> Result<(), String> {
    let trimmed = name.trim().to_string();
    // Bound the name so a runaway paste doesn't pollute Identify
    // payloads for every peer on the swarm. 64 chars is generous for
    // a vanity label and well under any reasonable wire limit.
    if trimmed.chars().count() > 64 {
        return Err(
            "instance name must be 64 characters or fewer".to_string(),
        );
    }
    let mut cfg = ServitudeConfig::from_store(&app).map_err(|e| e.to_string())?;
    // Empty input → revert to the default placeholder so
    // ServitudeConfig::validate() (which forbids empty display_name)
    // still passes. The renderer side recognizes the placeholder via
    // `get_instance_name`'s empty-string return.
    cfg.display_name = if trimmed.is_empty() {
        "concord-node".to_string()
    } else {
        trimmed
    };
    cfg.save_to_store(&app).map_err(|e| e.to_string())?;
    Ok(())
}

/// Diagnostic logger for INS-065 — appends to
/// `<app_local_data>/diag.log` so the renderer can surface
/// errors and lifecycle markers that aren't visible because the
/// boot splash + Welcome screen aren't painting on Windows.
/// Removable once the bug is closed.
#[tauri::command]
async fn log_diagnostic(app: tauri::AppHandle, msg: String) -> Result<(), String> {
    use std::io::Write;
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("no app_local_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("diag.log");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    writeln!(f, "{ts} {msg}").map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK GPU compositing is unreliable on many Linux setups
    // (VM GPU passthrough, nouveau, headless Wayland, etc.) and causes
    // "Failed to create GBM buffer" crashes. Disabling compositing
    // forces software rendering for the WebView compositor — visually
    // identical, avoids the crash. Only set if the user hasn't
    // explicitly configured it.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
    }

    // Shared swarm-state cache. One instance lives in `tauri::State`
    // (read by the `peer_swarm_status` command) and another `Arc` clone
    // is handed to the background mirror task in `setup`, so the cache
    // updates published by the mirror are visible to the command without
    // any further synchronization.
    let swarm_cache = std::sync::Arc::new(SwarmStateCache::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        // Phase 5 (INS-019b) — concord:// deeplink handler. The plugin
        // wires the OS-level URL-scheme registration AND emits the
        // `deep-link://new-url` event from the OS handler thread.
        // `spawn_deeplink_listener` (called in `setup` below) is what
        // turns those events into peer-store writes + emit_all signals
        // to the renderer.
        .plugin(tauri_plugin_deep_link::init())
        // Porch Phase D — native folder picker. The owner taps "pick
        // vault" in the Obsidian channel editor; this plugin surfaces
        // the OS-native directory chooser back to the JS layer.
        .plugin(tauri_plugin_dialog::init())
        .manage(ServitudeState(Mutex::new(None)))
        .manage(PeerIdentityState(Mutex::new(None)))
        .manage(SwarmEventChannel(swarm_cache.clone()))
        // Phase 8 follow-up — shared voice-mesh registry. One per
        // process; every `voice_mesh_join` Tauri command inserts a
        // new `VoiceCall` keyed by `room_id`. The libp2p runtime is
        // wired with the same registry as its signaling sink in
        // `servitude_start` below.
        .manage(VoiceMeshState(std::sync::Arc::new(
            servitude::voice::VoiceCallRegistry::new(),
        )))
        // Porch Phase A — lazily-opened shared porch. The first
        // `porch_*` Tauri command opens the SQLite DB; subsequent calls
        // reuse the same instance.
        .manage(PorchState(Mutex::new(None)))
        // F1a — lazily-opened ephemeral porch. Built on first call to
        // any `porch_list_channels` / `porch_ephemeral_get_messages` /
        // `porch_send_message` / `porch_current_token` command.
        // Lives only for the process lifetime — dropped when the
        // binary exits.
        .manage(EphemeralPorchState(Mutex::new(None)))
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Stronghold vault for credential storage (INS-024 Wave 4).
            // Uses argon2 KDF with a salt file persisted alongside the
            // vault. The salt file is auto-created on first run.
            let salt_path = app
                .path()
                .app_local_data_dir()
                .expect("could not resolve app local data path")
                .join("stronghold-salt.txt");
            app.handle().plugin(
                tauri_plugin_stronghold::Builder::with_argon2(&salt_path).build(),
            )?;

            // Ensure settings store exists
            let _ = app.handle().store("settings.json");

            // Phase 3 — start the background task that mirrors the
            // libp2p swarm's broadcast events into the shared cache and
            // emits them onto the Tauri event bus. The task polls
            // `ServitudeState` until a started libp2p runtime is
            // available; it then runs for the full swarm lifetime.
            spawn_swarm_event_mirror(app.handle().clone(), swarm_cache.clone());

            // Phase 5 — register the concord:// deeplink handler. The
            // plugin emits `deep-link://new-url` on a background thread
            // whenever the OS launches a deeplink (QR scan, click,
            // bare CLI arg on Windows/Linux). We forward each URL to
            // `peer_store::handle_deeplink_url` and emit one of two
            // Tauri events back to the renderer:
            //   * `peer_paired`        — KnownPeer added successfully
            //   * `peer_paired_error`  — { stage, message }
            // Logging is `warn`/`debug` only; deeplink failures must
            // NEVER raise a panic banner (the URL is untrusted input).
            spawn_deeplink_listener(app.handle().clone());

            // Devtools auto-open is gated on the `devtools` Cargo feature
            // (off by default — see `Cargo.toml`). Release builds never link
            // `tauri/devtools` so `open_devtools()` is not even compiled in.
            // Local dev that wants the inspector at launch: run with
            // `cargo tauri dev --features devtools` AND set the
            // `CONCORD_AUTO_DEVTOOLS=1` env var (so dev runs that just need
            // a hot-reload don't get an inspector window in their face).
            //
            // Historical: INS-065 force-opened devtools on Windows release
            // builds to diagnose a missing-Welcome render. That hack shipped
            // to end users (Issue 2 in the P0 sprint that produced this
            // commit). Don't reintroduce.
            #[cfg(feature = "devtools")]
            {
                if std::env::var("CONCORD_AUTO_DEVTOOLS").ok().as_deref() == Some("1") {
                    if let Some(window) = app.get_webview_window("main") {
                        window.open_devtools();
                    }
                }
            }

            // INS-020: Set the native WKWebView + UIView background color to
            // match Concord's dark surface (#0c0e11) so the home indicator
            // safe area doesn't show as gray. The web content stops at the
            // safe area boundary; below that, the native UIView background
            // is visible. Without this, it defaults to system gray/white.
            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.with_webview(|webview| {
                        use std::ffi::c_void;
                        // The Wry PlatformWebview on iOS gives us the raw
                        // WKWebView pointer. We use objc_msgSend to set its
                        // opaque=NO and backgroundColor to our surface color,
                        // plus the same on the scroll view and the view
                        // controller's root view.
                        unsafe {
                            let wk: *mut c_void = webview.inner() as *mut _;
                            let wk: *mut std::ffi::c_void = wk;
                            // Import the objc runtime functions
                            extern "C" {
                                fn objc_msgSend(obj: *mut c_void, sel: *mut c_void, ...) -> *mut c_void;
                                fn sel_registerName(name: *const u8) -> *mut c_void;
                                fn objc_getClass(name: *const u8) -> *mut c_void;
                            }

                            // Helper to create a selector
                            macro_rules! sel {
                                ($name:expr) => {
                                    sel_registerName(concat!($name, "\0").as_ptr())
                                };
                            }

                            // Create UIColor with our surface color #0c0e11
                            let ui_color_class = objc_getClass(b"UIColor\0".as_ptr());
                            let color: *mut c_void = objc_msgSend(
                                ui_color_class,
                                sel!("colorWithRed:green:blue:alpha:"),
                                12.0f64 / 255.0f64,
                                14.0f64 / 255.0f64,
                                17.0f64 / 255.0f64,
                                1.0f64,
                            );

                            // WKWebView.opaque = NO
                            let _: () = std::mem::transmute::<_, extern "C" fn(*mut c_void, *mut c_void, bool)>(
                                objc_msgSend as *const ()
                            )(wk, sel!("setOpaque:"), false);

                            // WKWebView.backgroundColor = color
                            let _: () = std::mem::transmute::<_, extern "C" fn(*mut c_void, *mut c_void, *mut c_void)>(
                                objc_msgSend as *const ()
                            )(wk, sel!("setBackgroundColor:"), color);

                            // ── ScrollView: the critical edge-to-edge fix ──
                            let scroll_view: *mut c_void = objc_msgSend(wk, sel!("scrollView"));

                            // scrollView.backgroundColor = color
                            let _: () = std::mem::transmute::<_, extern "C" fn(*mut c_void, *mut c_void, *mut c_void)>(
                                objc_msgSend as *const ()
                            )(scroll_view, sel!("setBackgroundColor:"), color);

                            // scrollView.contentInsetAdjustmentBehavior = .never (2)
                            // THIS IS THE KEY FIX. By default iOS adds safe-area-
                            // sized content insets to the scroll view, pushing web
                            // content away from the home indicator even though the
                            // WKWebView frame covers the full screen. Setting it
                            // to Never lets web content render edge-to-edge.
                            // UIScrollViewContentInsetAdjustmentNever = 2
                            let _: () = std::mem::transmute::<_, extern "C" fn(*mut c_void, *mut c_void, i64)>(
                                objc_msgSend as *const ()
                            )(scroll_view, sel!("setContentInsetAdjustmentBehavior:"), 2i64);

                            // ── ViewController ──
                            let vc: *mut c_void = webview.view_controller() as *mut _;

                            // viewController.edgesForExtendedLayout = .all (15)
                            // Content extends behind all bars/edges.
                            let _: () = std::mem::transmute::<_, extern "C" fn(*mut c_void, *mut c_void, u64)>(
                                objc_msgSend as *const ()
                            )(vc, sel!("setEdgesForExtendedLayout:"), 15u64);

                            // viewController.view.backgroundColor = color
                            let vc_view: *mut c_void = objc_msgSend(vc, sel!("view"));
                            let _: () = std::mem::transmute::<_, extern "C" fn(*mut c_void, *mut c_void, *mut c_void)>(
                                objc_msgSend as *const ()
                            )(vc_view, sel!("setBackgroundColor:"), color);

                            // WKWebView.insetsLayoutMarginsFromSafeArea = false
                            let _: () = std::mem::transmute::<_, extern "C" fn(*mut c_void, *mut c_void, bool)>(
                                objc_msgSend as *const ()
                            )(wk, sel!("setInsetsLayoutMarginsFromSafeArea:"), false);
                        }
                    });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_server_url,
            set_server_url,
            servitude_start,
            servitude_stop,
            servitude_status,
            servitude_get_registration_token,
            servitude_register_owner,
            get_servitude_profile,
            set_servitude_profile,
            get_instance_name,
            set_instance_name,
            log_diagnostic,
            peer_identity,
            peer_swarm_status,
            peer_store_list,
            peer_store_add,
            peer_store_remove,
            select_voice_path,
            voice_mesh_join,
            voice_mesh_leave,
            voice_mesh_status,
            porch_list_my_channels,
            porch_get_messages,
            porch_post_message,
            // F1a — ephemeral porch (in-memory, session-only).
            porch_current_token,
            porch_list_channels,
            porch_ephemeral_get_messages,
            porch_send_message,
            // F1b-IMPL — persistent home server meta.
            home_get_server_name,
            home_set_server_name,
            porch_visit_peer,
            porch_visit_get_messages,
            porch_visit_post_message,
            // Phase B — inner-channel + knock management.
            porch_pending_knocks,
            porch_accept_knock,
            porch_reject_knock,
            porch_create_channel,
            porch_grant_member,
            porch_revoke_member,
            porch_visit_knock,
            porch_visit_knock_status,
            porch_visit_withdraw_knock,
            // Phase C — per-channel theming + asset uploads.
            porch_get_theme,
            porch_set_theme,
            porch_upload_asset,
            porch_list_assets,
            porch_visit_get_theme,
            porch_visit_get_asset_bytes,
            // Phase D — obsidian vault binding + browse + read.
            porch_set_obsidian_config,
            porch_get_obsidian_config,
            porch_list_vault,
            porch_read_vault_file,
            porch_visit_list_vault,
            porch_visit_get_vault_file,
            // Phase E — encrypted backup pipeline.
            porch_backup_add_target,
            porch_backup_remove_target,
            porch_backup_list_targets,
            porch_backup_push_now,
            porch_backup_check_remote_info,
            porch_backup_restore_from,
            porch_backup_list_received,
            // Phase F — multi-device sync.
            porch_my_device_id,
            porch_link_personal_device,
            porch_unlink_device,
            porch_list_device_links,
            porch_sync_now,
            porch_sync_all_personal_devices,
            // Phase G — tunnel-only inbound hardening.
            tunnel_get_config,
            tunnel_set_config,
            tunnel_detect_interfaces,
            // User Management Phase 1 — profile CRUD + keychain metadata.
            user_profile_list,
            user_profile_create,
            user_profile_rename,
            user_profile_set_primary,
            user_profile_set_avatar,
            user_profile_delete,
            user_profile_keychain_list,
            user_profile_keychain_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

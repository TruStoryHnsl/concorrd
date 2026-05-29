use tauri::{Emitter, Manager};
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex;

pub mod servitude;

use servitude::{LifecycleState, ServitudeConfig, ServitudeHandle};
use servitude::identity::{self, StrongholdHandle};
use servitude::p2p::SwarmEvent as P2pSwarmEvent;
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
        P2pSwarmEvent::DhtRoutingUpdated { .. } => {
            // Captured via last_event only — the DHT-side "peer_count"
            // is a routing-table sample, distinct from the swarm-wide
            // connected count tracked by `PeerCountChanged`.
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
        P2pSwarmEvent::DhtRoutingUpdated { peer_count } => {
            format!("dht routed: {peer_count}")
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
        P2pSwarmEvent::DhtRoutingUpdated { peer_count } => serde_json::json!({
            "kind": "dht_routing_updated",
            "peer_count": *peer_count,
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
        *guard = Some(
            ServitudeHandle::new_with_identity(config, Some(stronghold))
                .map_err(|e| e.to_string())?,
        );
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

/// Report the current lifecycle state of the embedded servitude.
///
/// INS-024 Wave 4: Returns a JSON object with `state` (lifecycle string)
/// and `degraded_transports` (map of transport name -> failure reason).
/// The previous return shape was a bare JSON string; the new shape is
/// backward-compatible at the TypeScript level because the frontend
/// parses the response structurally.
///
/// If no handle exists yet (never started), returns `"stopped"` with
/// an empty degraded map.
#[tauri::command]
async fn servitude_status(state: tauri::State<'_, ServitudeState>) -> Result<String, String> {
    let guard = state.0.lock().await;
    let (state_value, degraded) = match guard.as_ref() {
        Some(handle) => (
            handle.status(),
            handle.degraded_transports().clone(),
        ),
        None => (LifecycleState::Stopped, std::collections::HashMap::new()),
    };

    let response = serde_json::json!({
        "state": state_value,
        "degraded_transports": degraded,
    });
    serde_json::to_string(&response).map_err(|e| e.to_string())
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
        .manage(ServitudeState(Mutex::new(None)))
        .manage(PeerIdentityState(Mutex::new(None)))
        .manage(SwarmEventChannel(swarm_cache.clone()))
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
            log_diagnostic,
            peer_identity,
            peer_swarm_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

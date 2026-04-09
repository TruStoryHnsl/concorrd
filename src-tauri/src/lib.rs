use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex;

pub mod servitude;

use servitude::{LifecycleState, ServitudeConfig, ServitudeHandle};

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
    app: tauri::AppHandle,
) -> Result<(), String> {
    // Load config OUTSIDE the lock so the (very cheap) store access never
    // overlaps with the mutex guard.
    let config = ServitudeConfig::from_store(&app).map_err(|e| e.to_string())?;

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
        *guard = Some(ServitudeHandle::new(config).map_err(|e| e.to_string())?);
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
/// Returns a JSON string (e.g. `"stopped"`, `"running"`) so the JS bridge
/// can render it without needing a separate TypeScript enum definition.
/// If no handle exists yet (never started), returns the JSON string
/// `"stopped"` to match the expected "inactive" user-facing state.
#[tauri::command]
async fn servitude_status(state: tauri::State<'_, ServitudeState>) -> Result<String, String> {
    let guard = state.0.lock().await;
    let state_value = match guard.as_ref() {
        Some(handle) => handle.status(),
        None => LifecycleState::Stopped,
    };
    serde_json::to_string(&state_value).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(ServitudeState(Mutex::new(None)))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Ensure settings store exists
            let _ = app.handle().store("settings.json");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_server_url,
            set_server_url,
            servitude_start,
            servitude_stop,
            servitude_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

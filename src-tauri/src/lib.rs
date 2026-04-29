use tauri::Manager;
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex;

pub mod servitude;

use servitude::{LifecycleState, ServitudeConfig, ServitudeHandle};
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

            // INS-065: force-open devtools at launch on Windows so we can
            // inspect Network/Console for the missing Welcome render.
            // Compiled in via the `devtools` Cargo feature on the tauri
            // crate (also active in release builds, gated only by this
            // explicit call). Removable once INS-065 is closed.
            #[cfg(target_os = "windows")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

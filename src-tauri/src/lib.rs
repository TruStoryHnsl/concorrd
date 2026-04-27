use tauri::Manager;
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

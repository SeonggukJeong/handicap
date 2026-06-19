mod backend;
mod launch;

use std::sync::Mutex;

use backend::{ControllerBackend, SidecarBackend};
use tauri::{Manager, RunEvent};

/// 종료 훅이 접근할 backend 핸들(managed state).
struct BackendState(Mutex<Option<Box<dyn ControllerBackend>>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BackendState(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let exe_dir = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                    .unwrap_or_else(|| std::path::PathBuf::from("."));
                let sidecar = launch::resolve_sidecar_path(
                    &exe_dir,
                    std::env::var("HANDICAP_CONTROLLER_BIN").ok().as_deref(),
                );
                match SidecarBackend::start(sidecar, launch::SpawnConfig::default()).await {
                    Ok(be) => {
                        let url = be.base_url();
                        if let Some(win) = handle.get_webview_window("main") {
                            if let Ok(u) = url.parse::<tauri::Url>() {
                                let _ = win.navigate(u);
                            }
                        }
                        handle
                            .state::<BackendState>()
                            .0
                            .lock()
                            .unwrap()
                            .replace(Box::new(be));
                    }
                    Err(e) => {
                        // 창의 스플래시에 에러 표시(navigate 금지).
                        if let Some(win) = handle.get_webview_window("main") {
                            let js = format!(
                                "window.__setError && window.__setError({})",
                                serde_json::to_string(&e.to_string())
                                    .unwrap_or_else(|_| "\"error\"".into())
                            );
                            let _ = win.eval(&js);
                        }
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(be) = app_handle.state::<BackendState>().0.lock().unwrap().take() {
                    be.shutdown();
                }
            }
        });
}

mod backend;
mod launch;

use std::sync::Mutex;

use backend::{ControllerBackend, InProcessBackend};
use handicap_controller::in_process::InProcessConfig;
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
                // in-process 컨트롤러: DB는 HANDICAP_DB env override(dev/live-verify 격리) 또는 기본.
                let cfg = InProcessConfig {
                    db: std::env::var("HANDICAP_DB").ok(),
                    ..InProcessConfig::default()
                };
                match InProcessBackend::start(cfg).await {
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

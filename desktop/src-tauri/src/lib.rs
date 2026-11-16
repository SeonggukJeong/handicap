pub mod config_store;
mod launch;
pub mod role;

use role::{Env, Shell, ShellState};
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            // 역할 설정(R1) → 셸 상태. DB는 HANDICAP_DB env override(dev/live-verify 격리) 또는 기본.
            let config_dir = config_store::config_dir(&handle);
            let loaded = config_store::load(&config_dir);
            let shell = Shell::new(ShellState::new(
                loaded,
                Env {
                    config_dir,
                    db: std::env::var("HANDICAP_DB").ok(),
                    hostname: handicap_worker::resolve_hostname,
                    start_gate: None,
                },
            ));
            app.manage(shell.clone());
            tauri::async_runtime::spawn(async move {
                match role::boot(&shell).await {
                    Ok(url) => {
                        if let Some(win) = handle.get_webview_window("main") {
                            if let Ok(u) = url.parse::<tauri::Url>() {
                                let _ = win.navigate(u);
                            }
                        }
                    }
                    Err(e) => {
                        // 창의 스플래시에 에러 표시(navigate 금지). Task 7이 역할 화면으로 바꾼다.
                        if let Some(win) = handle.get_webview_window("main") {
                            let js = format!(
                                "window.__setError && window.__setError({})",
                                serde_json::to_string(&e).unwrap_or_else(|_| "\"error\"".into())
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
                if let Some(shell) = app_handle.try_state::<Shell>() {
                    // RunEvent::Exit는 메인(이벤트루프) 스레드라 tokio 워커가 아님 → block_on 안전.
                    // role::shutdown은 bounded(전환 대기 ≤10s + 정지 경로 bounded).
                    tauri::async_runtime::block_on(role::shutdown(&shell));
                }
            }
        });
}

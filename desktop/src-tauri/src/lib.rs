pub mod commands;
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
                    fail_start: None,
                    code_ips_override: None,
                },
            ));
            app.manage(shell.clone());

            // 창은 conf(`create: false`)의 정의로 여기서 직접 만든다 — conf가 만드는 창엔
            // 초기화 스크립트를 달 수 없다(Task 1 스파이크). label "main" 유지 = capability 매치.
            let role_page = launch::role_page_url();
            let win_cfg = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or("tauri.conf.json에 창 정의가 없습니다")?;
            let win = tauri::WebviewWindowBuilder::from_config(app.handle(), &win_cfg)?
                .initialization_script(launch::marker_script(&role_page))
                .build()?;
            match win.url() {
                Ok(u) if launch::origin_of(&u) == launch::shell_origin() => {}
                Ok(u) => eprintln!(
                    "desktop: 경고 — 셸 origin 예상 {} 와 실제 {} 가 다름(「모드 전환」 링크가 틀린 곳을 가리킴)",
                    launch::shell_origin(),
                    launch::origin_of(&u)
                ),
                Err(e) => eprintln!("desktop: 경고 — 창 주소를 읽지 못함: {e}"),
            }

            tauri::async_runtime::spawn(async move {
                let Some(win) = handle.get_webview_window("main") else {
                    return;
                };
                match role::boot(&shell).await {
                    Ok(url) => {
                        if let Ok(u) = url.parse::<tauri::Url>() {
                            let _ = win.navigate(u);
                        }
                    }
                    Err(e) => {
                        // 서버 역할 시작 실패 → 「모드 전환」 화면(사유는 notices.start_error 안내).
                        // 혼자 쓰기 시작 실패(DB 등)는 안내가 없으므로 스플래시에 사유를 띄운다.
                        eprintln!("desktop: 시작 실패: {e}");
                        let server_failed = shell.state.lock().await.notices.start_error.is_some();
                        match role_page.parse::<tauri::Url>() {
                            Ok(u) if server_failed => {
                                let _ = win.navigate(u);
                            }
                            _ => {
                                let js = format!(
                                    "window.__setError && window.__setError({})",
                                    serde_json::to_string(&e)
                                        .unwrap_or_else(|_| "\"error\"".into())
                                );
                                let _ = win.eval(&js);
                            }
                        }
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::role_state,
            commands::worker_command,
            commands::active_run_count,
            commands::switch_role,
            commands::set_self_worker,
            commands::dismiss_notice,
            commands::connect_code,
            commands::check_code,
            commands::connect_worker,
            commands::disconnect_worker,
            commands::reconnect_worker,
        ])
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

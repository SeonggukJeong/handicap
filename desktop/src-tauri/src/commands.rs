//! 「모드 전환」 화면(`desktop/src/role.html`, 셸 origin 전용)이 부르는 IPC 명령 (spec R7).
//!
//! 이름·인자·응답 모양은 role.html과 1:1. **토큰은 `worker_command` 응답에만** 실린다 —
//! `role_state`·로그·표지에는 없다. 원격 origin(`http://127.0.0.1:…`)에는 capability가 없어
//! 이 명령들을 부를 수 없다(Task 1 실측: "not allowed").

use std::net::Ipv4Addr;

use handicap_desktop_core::command::{
    current_os, worker_command as build_worker_command, WorkerOs,
};
use handicap_desktop_core::config::Role;
use handicap_desktop_core::net::{candidate_ipv4s, list_local_ipv4s};
use serde::Serialize;
use tauri::State;

use crate::role::{self, Shell, ShellState, MSG_SWITCHING};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NoticesDto {
    pub port_changed: Option<[u16; 2]>,
    pub save_failed: bool,
    pub self_worker_excluded: bool,
    pub config_warning: bool,
    pub start_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RoleStateDto {
    /// `"local"` | `"server"`
    pub role: &'static str,
    pub switching: bool,
    pub grpc_port: u16,
    pub ips: Vec<String>,
    pub server_os: WorkerOs,
    pub self_worker: bool,
    pub self_worker_busy: bool,
    pub self_worker_unavailable: Option<String>,
    pub notices: NoticesDto,
    /// 앱 화면 주소(컨트롤러가 떠 있을 때만).
    pub app_url: Option<String>,
}

pub fn build_role_state(s: &ShellState, ips: Vec<Ipv4Addr>, busy: bool) -> RoleStateDto {
    let self_worker = match s.running.as_ref() {
        Some(r) => r
            .self_worker
            .as_ref()
            .is_some_and(|w| !w.handle.is_finished()),
        // 컨트롤러가 없으면(시작 전·실패) 저장된 토글.
        None => s.config.server.self_worker,
    };
    RoleStateDto {
        role: match s.config.role {
            Role::Local => "local",
            Role::Server => "server",
        },
        switching: s.switching,
        grpc_port: s.config.server.grpc_port,
        ips: candidate_ipv4s(&ips)
            .into_iter()
            .map(|a| a.to_string())
            .collect(),
        server_os: current_os(),
        self_worker,
        self_worker_busy: busy,
        self_worker_unavailable: s.notices.self_worker_unavailable.clone(),
        notices: NoticesDto {
            port_changed: s.notices.port_changed.map(|(a, b)| [a, b]),
            save_failed: s.notices.save_failed,
            self_worker_excluded: s.notices.self_worker_excluded,
            config_warning: s.config_warning,
            start_error: s.notices.start_error.clone(),
        },
        app_url: s.running.as_ref().map(|r| r.base_url.clone()),
    }
}

/// 부하기 PC용 명령. 서버 역할이고 `ip`가 지금 이 PC의 주소 후보일 때만(아무 주소나 넣은
/// 명령을 만들지 않게). 포트는 실제로 열린 포트(`config.server.grpc_port` — 시작이 갱신).
pub fn worker_command_for(
    s: &ShellState,
    ips: &[Ipv4Addr],
    ip: &str,
    os: WorkerOs,
    app_version: &str,
) -> Result<String, String> {
    if s.config.role != Role::Server {
        return Err("서버 모드에서만 만들 수 있습니다".into());
    }
    let addr: Ipv4Addr = ip
        .parse()
        .map_err(|_| "이 PC의 주소가 아닙니다".to_string())?;
    if !candidate_ipv4s(ips).contains(&addr) {
        return Err("이 PC의 주소가 아닙니다".into());
    }
    let token = s
        .config
        .server
        .token
        .as_deref()
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "접속 토큰이 없습니다".to_string())?;
    Ok(build_worker_command(
        os,
        app_version,
        addr,
        s.config.server.grpc_port,
        token,
    ))
}

/// 안내 닫기. 전환 중이면 거절 — 전환이 끝나며 시작 시점의 안내 사본을 다시 설치하므로
/// 지금 닫아도 되살아난다.
pub fn apply_dismiss(s: &mut ShellState, kind: &str) -> Result<(), String> {
    if s.switching {
        return Err(MSG_SWITCHING.into());
    }
    match kind {
        "port_changed" => s.notices.port_changed = None,
        "save_failed" => s.notices.save_failed = false,
        "self_worker_excluded" => s.notices.self_worker_excluded = false,
        "config_warning" => s.config_warning = false,
        "start_error" => s.notices.start_error = None,
        _ => return Err("알 수 없는 안내입니다".into()),
    }
    Ok(())
}

pub fn parse_target(t: &str) -> Result<Role, String> {
    match t {
        "local" => Ok(Role::Local),
        "server" => Ok(Role::Server),
        _ => Err("알 수 없는 모드입니다".into()),
    }
}

// ---- IPC (잠금은 짧게: 플래그·스냅샷만. 긴 작업은 role::switch가 잠금 밖에서) ----

#[tauri::command]
pub async fn role_state(shell: State<'_, Shell>) -> Result<RoleStateDto, String> {
    let ips = list_local_ipv4s();
    let mut st = shell.state.lock().await;
    let busy = role::self_worker_busy_locked(&mut st).await;
    Ok(build_role_state(&st, ips, busy))
}

#[tauri::command]
pub async fn worker_command(
    app: tauri::AppHandle,
    shell: State<'_, Shell>,
    ip: String,
    os: WorkerOs,
) -> Result<String, String> {
    let ips = list_local_ipv4s();
    let version = app.package_info().version.to_string();
    let st = shell.state.lock().await;
    if st.running.is_none() {
        return Err("서버가 실행 중이 아닙니다".into());
    }
    worker_command_for(&st, &ips, &ip, os, &version)
}

#[tauri::command]
pub async fn active_run_count(shell: State<'_, Shell>) -> Result<usize, String> {
    let st = shell.state.lock().await;
    if st.switching {
        return Err(MSG_SWITCHING.into());
    }
    match st.running.as_ref() {
        Some(r) => r
            .controller
            .active_run_count()
            .await
            .map_err(|e| format!("{e:#}")),
        None => Ok(0),
    }
}

#[tauri::command]
pub async fn switch_role(shell: State<'_, Shell>, target: String) -> Result<(), String> {
    let target = parse_target(&target)?;
    role::switch(&shell, target).await
}

#[tauri::command]
pub async fn set_self_worker(shell: State<'_, Shell>, enabled: bool) -> Result<(), String> {
    role::set_self_worker(&shell, enabled).await
}

#[tauri::command]
pub async fn dismiss_notice(shell: State<'_, Shell>, kind: String) -> Result<(), String> {
    let mut st = shell.state.lock().await;
    apply_dismiss(&mut st, &kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::role::Env;
    use handicap_desktop_core::config::{DesktopConfig, Loaded, ServerSettings};

    fn host() -> String {
        "h".into()
    }

    fn state(config: DesktopConfig) -> ShellState {
        ShellState::new(
            Loaded {
                config,
                warning: false,
            },
            Env {
                config_dir: std::env::temp_dir(),
                db: None,
                hostname: host,
                start_gate: None,
                fail_start: None,
            },
        )
    }

    fn server_state_with_token(token: &str) -> ShellState {
        state(DesktopConfig {
            role: Role::Server,
            server: ServerSettings {
                token: Some(token.into()),
                grpc_port: 8093,
                self_worker: true,
            },
        })
    }

    fn server_state() -> ShellState {
        server_state_with_token(&"ab".repeat(16))
    }

    fn local_state() -> ShellState {
        let mut s = state(DesktopConfig::default());
        s.config.server.token = Some("ab".repeat(16));
        s
    }

    fn ip(s: &str) -> Ipv4Addr {
        s.parse().unwrap()
    }

    #[test]
    fn role_state_never_contains_token() {
        let s = server_state_with_token(&"deadbeef".repeat(4));
        assert!(!serde_json::to_string(&build_role_state(&s, vec![], false))
            .unwrap()
            .contains("deadbeef"));
    }
    #[test]
    fn role_state_maps_port_change() {
        let mut s = server_state();
        s.notices.port_changed = Some((8081, 8093));
        assert_eq!(
            build_role_state(&s, vec![], false).notices.port_changed,
            Some([8081, 8093])
        );
    }
    #[test]
    fn role_state_lists_candidates_only() {
        assert_eq!(
            build_role_state(
                &server_state(),
                vec![
                    "192.168.0.12".parse().unwrap(),
                    "127.0.0.1".parse().unwrap()
                ],
                false
            )
            .ips,
            vec!["192.168.0.12"]
        );
    }
    #[test]
    fn role_state_no_ips_is_empty() {
        assert!(
            build_role_state(&server_state(), vec!["127.0.0.1".parse().unwrap()], false)
                .ips
                .is_empty()
        );
    }
    #[test]
    fn role_state_maps_fields() {
        let mut s = server_state();
        s.config_warning = true;
        s.switching = true;
        s.notices.save_failed = true;
        s.notices.self_worker_excluded = true;
        s.notices.start_error = Some("bind".into());
        s.notices.self_worker_unavailable = Some("이름 없음".into());
        let d = build_role_state(&s, vec![], true);
        assert_eq!(d.role, "server");
        assert!(d.switching);
        assert_eq!(d.grpc_port, 8093);
        assert_eq!(d.server_os, current_os());
        assert!(d.self_worker, "실행 전이면 저장된 토글");
        assert!(d.self_worker_busy);
        assert_eq!(d.self_worker_unavailable.as_deref(), Some("이름 없음"));
        assert_eq!(
            d.notices,
            NoticesDto {
                port_changed: None,
                save_failed: true,
                self_worker_excluded: true,
                config_warning: true,
                start_error: Some("bind".into()),
            }
        );
        assert_eq!(d.app_url, None, "컨트롤러가 없으면 화면 주소 없음");
        assert_eq!(
            build_role_state(&local_state(), vec![], false).role,
            "local"
        );
    }
    #[test]
    fn role_state_json_keys_match_role_html() {
        let v = serde_json::to_value(build_role_state(&server_state(), vec![], false)).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "app_url",
                "grpc_port",
                "ips",
                "notices",
                "role",
                "self_worker",
                "self_worker_busy",
                "self_worker_unavailable",
                "server_os",
                "switching"
            ]
        );
        let mut nk: Vec<&str> = v["notices"]
            .as_object()
            .unwrap()
            .keys()
            .map(|k| k.as_str())
            .collect();
        nk.sort();
        assert_eq!(
            nk,
            [
                "config_warning",
                "port_changed",
                "save_failed",
                "self_worker_excluded",
                "start_error"
            ]
        );
    }
    #[test]
    fn worker_command_refused_when_local() {
        assert!(worker_command_for(
            &local_state(),
            &[ip("10.0.0.1")],
            "10.0.0.1",
            WorkerOs::Macos,
            "0.15.0"
        )
        .is_err());
    }
    #[test]
    fn worker_command_refused_for_unknown_ip() {
        assert!(worker_command_for(
            &server_state(),
            &[ip("10.0.0.1")],
            "8.8.8.8",
            WorkerOs::Macos,
            "0.15.0"
        )
        .is_err());
    }
    #[test]
    fn worker_command_refused_for_loopback_even_if_listed() {
        assert!(worker_command_for(
            &server_state(),
            &[ip("10.0.0.1"), ip("127.0.0.1")],
            "127.0.0.1",
            WorkerOs::Macos,
            "0.15.0"
        )
        .is_err());
    }
    #[test]
    fn worker_command_uses_current_port_and_token() {
        let s = server_state_with_token("tok"); // grpc_port 8093
        assert!(
            worker_command_for(&s, &[ip("10.0.0.1")], "10.0.0.1", WorkerOs::Linux, "0.15.0")
                .unwrap()
                .contains("http://10.0.0.1:8093 --token tok")
        );
    }
    #[test]
    fn dismiss_clears_each_kind() {
        let mut s = server_state();
        s.config_warning = true;
        s.notices.port_changed = Some((8081, 8093));
        s.notices.save_failed = true;
        s.notices.self_worker_excluded = true;
        s.notices.start_error = Some("x".into());
        for k in [
            "port_changed",
            "save_failed",
            "self_worker_excluded",
            "config_warning",
            "start_error",
        ] {
            apply_dismiss(&mut s, k).unwrap();
        }
        let n = build_role_state(&s, vec![], false).notices;
        assert_eq!(
            n,
            NoticesDto {
                port_changed: None,
                save_failed: false,
                self_worker_excluded: false,
                config_warning: false,
                start_error: None,
            }
        );
        assert!(apply_dismiss(&mut s, "token").is_err());
    }
    #[test]
    fn dismiss_refused_while_switching() {
        let mut s = server_state();
        s.notices.save_failed = true;
        s.switching = true;
        assert_eq!(
            apply_dismiss(&mut s, "save_failed").unwrap_err(),
            "전환 중입니다"
        );
        assert!(s.notices.save_failed, "전환 중에는 그대로");
    }
    #[test]
    fn parse_target_accepts_two_roles_only() {
        assert_eq!(parse_target("local").unwrap(), Role::Local);
        assert_eq!(parse_target("server").unwrap(), Role::Server);
        assert!(parse_target("Server").is_err());
    }
}

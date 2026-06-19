//! Tauri 런타임 비의존 순수 글루(controller `launch.rs` 패턴). 단위 테스트로 잠근다.

use std::path::{Path, PathBuf};

/// controller 기동 파라미터. 기본값은 **localhost-only**(LAN 전방호환 — 미래엔 필드 추가만).
#[derive(Debug, Clone)]
pub struct SpawnConfig {
    /// REST 바인드 주소. 기본 `127.0.0.1:0` → OS가 빈 포트를 *원자적으로* 할당(pick-then-bind TOCTOU 없음).
    pub rest: String,
    /// gRPC 바인드 주소. 기본 `127.0.0.1:0`(워커는 controller가 내부적으로 dial — 셸은 grpc 포트 불요).
    pub grpc: String,
    /// 브라우저 자동 오픈 끔(창이 대신 표시). bundle controller의 `--no-open`.
    pub no_open: bool,
}

impl Default for SpawnConfig {
    fn default() -> Self {
        Self {
            rest: "127.0.0.1:0".to_string(),
            grpc: "127.0.0.1:0".to_string(),
            no_open: true,
        }
    }
}

impl SpawnConfig {
    /// controller CLI 인자. bundle controller는 `--rest`/`--grpc`(SocketAddr)·`--no-open`(bundle 전용)을 받는다.
    pub fn to_args(&self) -> Vec<String> {
        let mut a = vec![
            "--rest".to_string(),
            self.rest.clone(),
            "--grpc".to_string(),
            self.grpc.clone(),
        ];
        if self.no_open {
            a.push("--no-open".to_string());
        }
        a
    }
}

/// 사이드카 controller 경로 결정.
/// 1) env `HANDICAP_CONTROLLER_BIN`(dev/live-verify 오버라이드) 우선,
/// 2) 없으면 현재 exe 옆(번들 설치 형태 — Tauri externalBin이 triple suffix 떼고 옆에 복사).
pub fn resolve_sidecar_path(current_exe_dir: &Path, env_override: Option<&str>) -> PathBuf {
    if let Some(p) = env_override {
        return PathBuf::from(p);
    }
    let name = if cfg!(windows) {
        "controller.exe"
    } else {
        "controller"
    };
    current_exe_dir.join(name)
}

/// ANSI CSI 이스케이프 시퀀스를 제거한 순수 텍스트 반환.
/// `\x1b[` 시작 후 `0x40..=0x7e` 범위 바이트(최종 바이트)까지 스킵.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if let Some('[') = chars.next() {
                // CSI 시퀀스: 최종 바이트(0x40–0x7e)까지 소비
                for inner in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&inner) {
                        break;
                    }
                }
            }
            // `\x1b` 뒤가 `[`가 아니면 이스케이프 자체 드롭
        } else {
            out.push(c);
        }
    }
    out
}

/// controller `info!` 로그 라인에서 **실제 바인딩된 REST 포트**를 추출.
/// ANSI 이스케이프가 포함된 실-파이프 출력도 처리(tracing_subscriber가 TTY 감지 없이 ANSI ON).
/// 매칭(단일 소스): `... REST listening ... addr=127.0.0.1:NNNN`
///                 `... listeners ... rest=127.0.0.1:NNNN grpc=...`
/// 비매칭(가드): `controller starting ... rest: 127.0.0.1:0`(요청 포트 0·Debug `rest:`),
///             `gRPC listening ... addr=127.0.0.1:MMMM`(grpc 포트).
pub fn parse_rest_port(line: &str) -> Option<u16> {
    let clean = strip_ansi(line);
    let key = if clean.contains("REST listening") {
        "addr="
    } else if clean.contains("listeners") {
        "rest="
    } else {
        return None;
    };
    let after = clean.split(key).nth(1)?;
    let port_str: String = after
        .split(':')
        .nth(1)?
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    match port_str.parse::<u16>().ok()? {
        0 => None,
        p => Some(p),
    }
}

pub fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

pub fn health_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/api/health")
}

/// 헬스폴 단계: 100회 × 100ms = 최대 ~10s. (별도로 포트 파싱 대기도 최대 ~10s →
/// 기동 실패 시 창에 에러를 띄우기까지 worst-case 합 ~20s — 런북/에러문구에 반영.)
pub const HEALTH_POLL_ATTEMPTS: u32 = 100;
pub const HEALTH_POLL_INTERVAL_MS: u64 = 100;

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn default_config_is_localhost_no_open() {
        let args = SpawnConfig::default().to_args();
        assert!(args.iter().any(|a| a == "--no-open"), "no_open 기본 on");
        // localhost only — 네트워크 노출 주소 없음(R6)
        assert!(args.iter().any(|a| a.contains("127.0.0.1")));
        assert!(
            !args.iter().any(|a| a.contains("0.0.0.0")),
            "네트워크 노출 금지"
        );
        // rest/grpc 둘 다 :0(원자 할당)
        assert_eq!(
            args.iter().filter(|a| a.as_str() == "127.0.0.1:0").count(),
            2
        );
    }

    #[test]
    fn env_override_wins_for_sidecar_path() {
        let p = resolve_sidecar_path(Path::new("/app"), Some("/tmp/controller"));
        assert_eq!(p, PathBuf::from("/tmp/controller"));
    }

    #[test]
    fn sidecar_path_defaults_next_to_exe() {
        let p = resolve_sidecar_path(Path::new("/app"), None);
        let name = if cfg!(windows) {
            "controller.exe"
        } else {
            "controller"
        };
        assert_eq!(p, Path::new("/app").join(name));
    }

    // 드리프트 가드 — 실제 bundle controller 파이프 출력(ANSI 색상 포함)으로 파싱 검증.
    // ANSI 이스케이프: \x1b[...m 시퀀스가 `addr=`·`rest=` 주변을 감쌈.
    #[test]
    fn parses_real_ansi_rest_listening_line() {
        // RAW captured: \x1b[2m2026-06-19T13:26:48.673871Z\x1b[0m \x1b[32m INFO\x1b[0m \x1b[2mcontroller\x1b[0m\x1b[2m:\x1b[0m REST listening \x1b[3maddr\x1b[0m\x1b[2m=\x1b[0m127.0.0.1:60054
        let line = "\x1b[2m2026-06-19T13:26:48.673871Z\x1b[0m \x1b[32m INFO\x1b[0m \x1b[2mcontroller\x1b[0m\x1b[2m:\x1b[0m REST listening \x1b[3maddr\x1b[0m\x1b[2m=\x1b[0m127.0.0.1:60054";
        assert_eq!(parse_rest_port(line), Some(60054));
    }

    #[test]
    fn parses_real_ansi_listeners_line() {
        // RAW captured: \x1b[2m2026-06-19T13:26:48.671333Z\x1b[0m \x1b[32m INFO\x1b[0m \x1b[2mcontroller\x1b[0m\x1b[2m:\x1b[0m listeners \x1b[3mrest\x1b[0m\x1b[2m=\x1b[0m127.0.0.1:60054 \x1b[3mgrpc\x1b[0m\x1b[2m=\x1b[0m127.0.0.1:60055
        let line = "\x1b[2m2026-06-19T13:26:48.671333Z\x1b[0m \x1b[32m INFO\x1b[0m \x1b[2mcontroller\x1b[0m\x1b[2m:\x1b[0m listeners \x1b[3mrest\x1b[0m\x1b[2m=\x1b[0m127.0.0.1:60054 \x1b[3mgrpc\x1b[0m\x1b[2m=\x1b[0m127.0.0.1:60055";
        assert_eq!(parse_rest_port(line), Some(60054));
    }

    #[test]
    fn parses_clean_rest_listening_line() {
        // Clean line (with NO_COLOR=1) — belt-and-suspenders for Task 2's env var
        let line =
            "2026-06-19T13:28:05.235046Z  INFO controller: REST listening addr=127.0.0.1:60060";
        assert_eq!(parse_rest_port(line), Some(60060));
    }

    #[test]
    fn parses_listeners_line_taking_rest_not_grpc() {
        let line = "... INFO controller: listeners rest=127.0.0.1:50845 grpc=127.0.0.1:50846";
        assert_eq!(parse_rest_port(line), Some(50845));
    }

    #[test]
    fn ignores_grpc_listening_line() {
        let line = "... INFO controller: gRPC listening addr=127.0.0.1:50846";
        assert_eq!(parse_rest_port(line), None);
    }

    #[test]
    fn ignores_controller_starting_args_with_port_zero() {
        let line = "... INFO controller: controller starting args=ControllerArgs { rest: 127.0.0.1:0, grpc: 127.0.0.1:0 }";
        assert_eq!(parse_rest_port(line), None);
    }

    #[test]
    fn urls_are_localhost_with_health_path() {
        assert_eq!(base_url(8080), "http://127.0.0.1:8080/");
        assert_eq!(health_url(8080), "http://127.0.0.1:8080/api/health");
    }
}

//! 데스크톱 역할 설정(`desktop-role.json`) 파싱·직렬화.

pub const CONFIG_FILE_NAME: &str = "desktop-role.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Local,
    Server,
    Worker,
}

/// 부하기 역할 설정. `code`는 비밀 — `Debug`는 손으로(`ServerSettings`와 같은 규칙).
#[derive(Clone, PartialEq, Default)]
pub struct WorkerSettings {
    pub code: Option<String>,
    pub connected: bool,
}

impl std::fmt::Debug for WorkerSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkerSettings")
            .field("code", &self.code.as_ref().map(|_| "[REDACTED]"))
            .field("connected", &self.connected)
            .finish()
    }
}

/// `Debug`는 손으로 — 토큰은 `[REDACTED]`(`InProcessConfig`와 같은 규칙).
#[derive(Clone, PartialEq)]
pub struct ServerSettings {
    pub token: Option<String>,
    pub grpc_port: u16,
    pub self_worker: bool,
}

impl std::fmt::Debug for ServerSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerSettings")
            .field("token", &self.token.as_ref().map(|_| "[REDACTED]"))
            .field("grpc_port", &self.grpc_port)
            .field("self_worker", &self.self_worker)
            .finish()
    }
}

impl Default for ServerSettings {
    fn default() -> Self {
        Self {
            token: None,
            grpc_port: 8081,
            self_worker: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DesktopConfig {
    pub role: Role,
    pub server: ServerSettings,
    pub worker: WorkerSettings,
    pub install_id: Option<String>,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            role: Role::Local,
            server: ServerSettings::default(),
            worker: WorkerSettings::default(),
            install_id: None,
        }
    }
}

/// 쓸 수 있는 설치 ID = 32–64바이트 ∧ 전부 ASCII 영숫자.
pub fn is_usable_install_id(s: &str) -> bool {
    (32..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// 쓸 수 있으면 그대로, 아니면 새로 만들어 넣고 그 값을 돌려준다.
pub fn ensure_install_id<R: rand::RngCore + rand::CryptoRng>(
    c: &mut DesktopConfig,
    rng: &mut R,
) -> String {
    match &c.install_id {
        Some(id) if is_usable_install_id(id) => id.clone(),
        _ => {
            let id = crate::token::generate_token(rng);
            c.install_id = Some(id.clone());
            id
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Loaded {
    pub config: DesktopConfig,
    pub warning: bool,
}

fn fallback() -> Loaded {
    Loaded {
        config: DesktopConfig::default(),
        warning: true,
    }
}

/// 파일 내용(없으면 `None`)을 해석한다. 깨졌거나 모르는 버전이면 전부 기본값 + 경고,
/// 모르는 역할이면 서버 설정은 살리고 역할만 Local + 경고. `server` 안 빠진 칸은 칸마다 기본값.
pub fn parse_config(raw: Option<&str>) -> Loaded {
    let Some(raw) = raw else {
        return Loaded {
            config: DesktopConfig::default(),
            warning: false,
        };
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return fallback();
    };
    if v.get("version").and_then(|x| x.as_u64()) != Some(1) {
        return fallback();
    }
    let d = ServerSettings::default();
    let s = v.get("server");
    let server = ServerSettings {
        token: s
            .and_then(|s| s.get("token"))
            .and_then(|t| t.as_str())
            .map(str::to_owned),
        grpc_port: s
            .and_then(|s| s.get("grpc_port"))
            .and_then(|p| p.as_u64())
            .and_then(|p| u16::try_from(p).ok())
            .unwrap_or(d.grpc_port),
        self_worker: s
            .and_then(|s| s.get("self_worker"))
            .and_then(|b| b.as_bool())
            .unwrap_or(d.self_worker),
    };
    let w = v.get("worker");
    let worker = WorkerSettings {
        code: w
            .and_then(|w| w.get("code"))
            .and_then(|c| c.as_str())
            .map(str::to_owned),
        connected: w
            .and_then(|w| w.get("connected"))
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
    };
    let install_id = v
        .get("install_id")
        .and_then(|i| i.as_str())
        .map(str::to_owned);
    let (role, warning) = match v.get("role").and_then(|r| r.as_str()) {
        Some("local") => (Role::Local, false),
        Some("server") => (Role::Server, false),
        Some("worker") => (Role::Worker, false),
        _ => (Role::Local, true),
    };
    Loaded {
        config: DesktopConfig {
            role,
            server,
            worker,
            install_id,
        },
        warning,
    }
}

pub fn serialize_config(c: &DesktopConfig) -> String {
    let role = match c.role {
        Role::Local => "local",
        Role::Server => "server",
        Role::Worker => "worker",
    };
    let v = serde_json::json!({
        "version": 1,
        "role": role,
        "server": {
            "token": c.server.token,
            "grpc_port": c.server.grpc_port,
            "self_worker": c.server.self_worker,
        },
        "worker": {
            "code": c.worker.code,
            "connected": c.worker.connected,
        },
        "install_id": c.install_id,
    });
    serde_json::to_string_pretty(&v).expect("json 직렬화")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_is_local_without_warning() {
        let l = parse_config(None);
        assert_eq!(l.config.role, Role::Local);
        assert!(!l.warning);
        assert_eq!(l.config.server.grpc_port, 8081);
        assert!(l.config.server.self_worker);
    }
    #[test]
    fn server_round_trip() {
        let c = DesktopConfig {
            role: Role::Server,
            server: ServerSettings {
                token: Some("ab".repeat(16)),
                grpc_port: 8093,
                self_worker: false,
            },
            ..Default::default()
        };
        let l = parse_config(Some(&serialize_config(&c)));
        assert_eq!(l.config, c);
        assert!(!l.warning);
    }
    #[test]
    fn garbage_is_local_with_warning() {
        let l = parse_config(Some("{not json"));
        assert_eq!(l.config.role, Role::Local);
        assert!(l.warning);
    }
    #[test]
    fn unknown_role_is_local_with_warning_keeping_server_settings() {
        let l = parse_config(Some(
            r#"{"version":1,"role":"robot","server":{"token":null,"grpc_port":9000,"self_worker":true}}"#,
        ));
        assert_eq!(l.config.role, Role::Local);
        assert!(l.warning);
        assert_eq!(l.config.server.grpc_port, 9000);
    }
    #[test]
    fn unknown_version_is_local_with_warning() {
        let l = parse_config(Some(r#"{"version":2,"role":"server"}"#));
        assert_eq!(l.config.role, Role::Local);
        assert!(l.warning);
    }
    #[test]
    fn debug_redacts_token() {
        let secret = "deadbeef".repeat(4);
        let c = DesktopConfig {
            role: Role::Server,
            server: ServerSettings {
                token: Some(secret.clone()),
                grpc_port: 8093,
                self_worker: true,
            },
            ..Default::default()
        };
        let d = format!("{c:?}");
        assert!(!d.contains(&secret), "{d}");
        assert!(d.contains("[REDACTED]"), "{d}");
        assert!(d.contains("8093"), "다른 칸은 그대로: {d}");
        let s = format!("{:?}", c.server);
        assert!(!s.contains(&secret), "{s}");
        let none = format!("{:?}", ServerSettings::default());
        assert!(none.contains("token: None"), "{none}");
    }
    #[test]
    fn missing_server_section_defaults_without_warning() {
        let l = parse_config(Some(r#"{"version":1,"role":"server"}"#));
        assert_eq!(l.config.role, Role::Server);
        assert!(!l.warning);
        assert_eq!(l.config.server.grpc_port, 8081);
    }
    #[test]
    fn worker_round_trip() {
        let c = DesktopConfig {
            role: Role::Worker,
            worker: WorkerSettings {
                code: Some("HANDICAP1-ab".into()),
                connected: true,
            },
            install_id: Some("ab".repeat(16)),
            ..Default::default()
        };
        let l = parse_config(Some(&serialize_config(&c)));
        assert_eq!(l.config, c);
        assert!(!l.warning);
    }
    #[test]
    fn first_version_file_reads_with_defaults() {
        let l = parse_config(Some(
            r#"{"version":1,"role":"server","server":{"token":"abcd","grpc_port":8093,"self_worker":false}}"#,
        ));
        assert_eq!(l.config.role, Role::Server);
        assert_eq!(l.config.worker, WorkerSettings::default());
        assert_eq!(l.config.install_id, None);
        assert!(!l.warning);
    }
    #[test]
    fn worker_role_string_parses() {
        let l = parse_config(Some(r#"{"version":1,"role":"worker"}"#));
        assert_eq!(l.config.role, Role::Worker);
        assert!(!l.warning);
        assert!(!l.config.worker.connected);
    }
    #[test]
    fn wrong_typed_worker_fields_default() {
        let l = parse_config(Some(
            r#"{"version":1,"role":"worker","worker":{"code":5,"connected":"yes"},"install_id":7}"#,
        ));
        assert_eq!(l.config.worker, WorkerSettings::default());
        assert_eq!(l.config.install_id, None);
        assert!(!l.warning);
    }
    #[test]
    fn debug_redacts_worker_code() {
        let c = DesktopConfig {
            role: Role::Worker,
            worker: WorkerSettings {
                code: Some("HANDICAP1-deadbeefdeadbeef".into()),
                connected: true,
            },
            ..Default::default()
        };
        let d = format!("{c:?}");
        assert!(!d.contains("deadbeef"), "{d}");
        assert!(d.contains("[REDACTED]"), "{d}");
        let w = format!("{:?}", c.worker);
        assert!(!w.contains("deadbeef"), "{w}");
        assert!(w.contains("[REDACTED]"), "{w}");
        let none = format!("{:?}", WorkerSettings::default());
        assert!(none.contains("code: None"), "{none}");
    }
    #[test]
    fn install_id_rules() {
        assert!(!is_usable_install_id(&"a".repeat(31)));
        assert!(is_usable_install_id(&"a".repeat(32)));
        assert!(is_usable_install_id(&"a".repeat(64)));
        assert!(!is_usable_install_id(&"a".repeat(65)));
        assert!(!is_usable_install_id(""));
        assert!(!is_usable_install_id(&"가".repeat(32)));
        let dashed = format!("{}-{}", "a".repeat(15), "a".repeat(16));
        assert_eq!(dashed.len(), 32);
        assert!(!is_usable_install_id(&dashed));
    }
    #[test]
    fn ensure_install_id_keeps_or_replaces() {
        let mut rng = rand::rngs::OsRng;
        let good = "Ab0".repeat(11);
        let mut c = DesktopConfig {
            install_id: Some(good.clone()),
            ..Default::default()
        };
        assert_eq!(ensure_install_id(&mut c, &mut rng), good);
        assert_eq!(c.install_id.as_deref(), Some(good.as_str()));
        for bad in [None, Some(String::new()), Some("short".to_string())] {
            let mut c = DesktopConfig {
                install_id: bad,
                ..Default::default()
            };
            let id = ensure_install_id(&mut c, &mut rng);
            assert_eq!(id.len(), 32);
            assert!(
                id.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            );
            assert_eq!(c.install_id.as_deref(), Some(id.as_str()));
            assert_eq!(ensure_install_id(&mut c, &mut rng), id);
        }
    }
}

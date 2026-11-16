//! 데스크톱 역할 설정(`desktop-role.json`) 파싱·직렬화.

pub const CONFIG_FILE_NAME: &str = "desktop-role.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Local,
    Server,
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
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            role: Role::Local,
            server: ServerSettings::default(),
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
    let (role, warning) = match v.get("role").and_then(|r| r.as_str()) {
        Some("local") => (Role::Local, false),
        Some("server") => (Role::Server, false),
        _ => (Role::Local, true),
    };
    Loaded {
        config: DesktopConfig { role, server },
        warning,
    }
}

pub fn serialize_config(c: &DesktopConfig) -> String {
    let role = match c.role {
        Role::Local => "local",
        Role::Server => "server",
    };
    let v = serde_json::json!({
        "version": 1,
        "role": role,
        "server": {
            "token": c.server.token,
            "grpc_port": c.server.grpc_port,
            "self_worker": c.server.self_worker,
        },
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
            r#"{"version":1,"role":"worker","server":{"token":null,"grpc_port":9000,"self_worker":true}}"#,
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
}

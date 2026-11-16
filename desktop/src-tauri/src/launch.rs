//! Tauri 런타임 비의존 순수 글루. 단위 테스트로 잠근다.

/// 창이 navigate할 베이스 URL(`http://127.0.0.1:<port>/`).
pub fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

/// 셸 페이지(`frontendDist`) origin. tauri 내부 `tauri_protocol_url` 규칙의 거울:
/// Windows(·Android)는 `http://tauri.localhost`, 그 외 `tauri://localhost` (Task 1 실측: macOS 일치).
/// 초기화 스크립트는 창을 만들기 *전에* 고정돼야 해서 `win.url()`을 쓸 수 없다 — 만든 뒤 대조한다.
pub fn shell_origin() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    }
}

/// 「모드 전환」 화면 주소.
pub fn role_page_url() -> String {
    format!("{}/role.html", shell_origin())
}

/// `scheme://host[:port]` (url 크레이트의 `origin()`은 `tauri:` 같은 비특수 scheme에 `null`을 준다).
pub fn origin_of(u: &tauri::Url) -> String {
    let host = u.host_str().unwrap_or("");
    match u.port() {
        Some(p) => format!("{}://{host}:{p}", u.scheme()),
        None => format!("{}://{host}", u.scheme()),
    }
}

/// 원격(앱 화면 `http://127.0.0.1:…`) 페이지에만 읽기 전용 표지를 단다. 필드는 `rolePageUrl`
/// 하나(비밀 없음, spec §5). 셸 페이지·그 밖 origin엔 아무것도 하지 않는다.
const MARKER_TEMPLATE: &str = r##"(function () {
  if (!location.origin.startsWith("http://127.0.0.1:")) return;
  Object.defineProperty(window, "__HANDICAP_DESKTOP__", {
    value: Object.freeze({ rolePageUrl: __ROLE_PAGE_URL__ }),
    writable: false,
    configurable: false,
  });
})();"##;

pub fn marker_script(role_page_url: &str) -> String {
    // JSON 문자열 리터럴로 넣는다(따옴표·역슬래시가 있어도 스크립트가 깨지지 않게).
    let lit = serde_json::to_string(role_page_url).expect("문자열 직렬화");
    MARKER_TEMPLATE.replace("__ROLE_PAGE_URL__", &lit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_is_localhost() {
        assert_eq!(base_url(8080), "http://127.0.0.1:8080/");
    }

    #[test]
    fn role_page_is_on_shell_origin() {
        let u = role_page_url();
        assert!(u.starts_with(shell_origin()));
        assert!(u.ends_with("/role.html"));
        #[cfg(not(windows))]
        assert_eq!(u, "tauri://localhost/role.html");
    }

    #[test]
    fn origin_of_handles_custom_scheme_and_port() {
        let a: tauri::Url = "tauri://localhost/splash.html".parse().unwrap();
        assert_eq!(origin_of(&a), "tauri://localhost");
        let b: tauri::Url = "http://127.0.0.1:5173/x".parse().unwrap();
        assert_eq!(origin_of(&b), "http://127.0.0.1:5173");
    }

    #[test]
    fn marker_is_remote_only_and_has_one_field() {
        let s = marker_script("tauri://localhost/role.html");
        assert!(s.contains(r#"if (!location.origin.startsWith("http://127.0.0.1:")) return;"#));
        assert!(s.contains(r#"Object.freeze({ rolePageUrl: "tauri://localhost/role.html" })"#));
        assert!(s.contains("__HANDICAP_DESKTOP__"));
        assert!(!s.contains("__ROLE_PAGE_URL__"));
        assert!(!s.to_lowercase().contains("token"));
    }

    #[test]
    fn marker_escapes_url_literal() {
        let s = marker_script(r#"a"b\c"#);
        assert!(s.contains(r#"rolePageUrl: "a\"b\\c""#));
    }
}

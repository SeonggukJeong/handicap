//! Tauri 런타임 비의존 순수 글루. 단위 테스트로 잠근다.

/// 창이 navigate할 베이스 URL(`http://127.0.0.1:<port>/`).
pub fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_is_localhost() {
        assert_eq!(base_url(8080), "http://127.0.0.1:8080/");
    }
}

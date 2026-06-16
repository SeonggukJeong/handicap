//! 단일 self-contained 바이너리(`--features bundle`) 전용 — 임베드 UI 서빙·브라우저 오픈 등.

use axum::body::Body;
use axum::http::{StatusCode, Uri, header};
use axum::response::Response;

/// 컴파일 타임에 ui/dist를 바이너리에 임베드. content-type은 rust-embed의 `mime-guess` 기능으로.
#[derive(rust_embed::RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/../../ui/dist"]
struct EmbeddedUi;

/// 요청 경로에 맞는 임베드 에셋(bytes, content-type)을 찾는다. 못 찾으면 SPA fallback으로
/// index.html(text/html)을 돌려준다(클라이언트 라우트 hard-refresh 대비; ServeDir.fallback과 동일 계약).
fn resolve_embedded(path: &str) -> Option<(Vec<u8>, String)> {
    let trimmed = path.trim_start_matches('/');
    let key = if trimmed.is_empty() {
        "index.html"
    } else {
        trimmed
    };
    if let Some(f) = EmbeddedUi::get(key) {
        return Some((f.data.into_owned(), f.metadata.mimetype().to_string()));
    }
    // SPA fallback: 알 수 없는 경로 → index.html을 200으로.
    EmbeddedUi::get("index.html").map(|f| (f.data.into_owned(), "text/html".to_string()))
}

/// axum fallback 핸들러: 임베드 UI를 서빙(없으면 SPA index.html, 그조차 없으면 404).
pub async fn serve_embedded_ui(uri: Uri) -> Response {
    match resolve_embedded(uri.path()) {
        Some((bytes, mime)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .body(Body::from(bytes))
            .unwrap(),
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("ui asset not found"))
            .unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_is_embedded() {
        assert!(
            EmbeddedUi::get("index.html").is_some(),
            "ui/dist/index.html must be embedded"
        );
    }

    #[test]
    fn root_resolves_to_index() {
        let (bytes, mime) = resolve_embedded("/").expect("root should resolve");
        assert!(!bytes.is_empty());
        assert!(mime.contains("html"));
    }

    #[test]
    fn unknown_route_falls_back_to_index() {
        // 클라이언트 라우트(파일 아님) → index.html 200.
        let (bytes, _) = resolve_embedded("/scenarios/01ABC").expect("spa fallback");
        let (index, _) = resolve_embedded("/index.html").expect("index");
        assert_eq!(bytes, index, "unknown route must serve index.html bytes");
    }
}

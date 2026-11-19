//! 풀기 사슬로 아주 깊어진 본문 — 2 MiB 스택 스레드에서 추출이 스택을 넘치지 않는다.
//! 넘침은 프로세스 abort로 나타난다(`join()`으로 못 잡는다) — 테스트 실행의 종료 상태가 판정.
//!
//! 기준은 release 빌드다(사용자 결정 2026-11-20, roadmap §B72 (0) 선택지 (a)).
//! 목표 1 MiB 사례(실제 본문 1.58 MB)는 debug·release 모두에서 돈다.
//! 목표 16 MiB 사례(실제 본문 25.2 MB)는 release에서만 돈다. pre-commit·CI의 테스트는
//! debug라 이 사례는 자동 게이트 밖이다 — 추출·글자화 경로를 고치면 손으로 돌릴 것:
//! `cargo test -p handicap-engine --release --test nested_json_depth`.

use handicap_engine::scenario::Extract;
use handicap_engine::{ResponseFacts, evaluate_extracts};

const LAYERS: usize = 100;

/// 고리 하나 = 100겹 배열 안의 `{"w": "<다음 고리의 JSON 글자>"}`, 가장 안쪽 = `{"x":1}`.
/// 글자 크기가 `target`을 넘을 때까지 고리를 감는다. (본문, 고리 수)를 돌려준다.
fn build_chain(target: usize) -> (String, usize) {
    let mut text = String::from(r#"{"x":1}"#);
    let mut links = 0;
    while text.len() < target {
        let obj = serde_json::json!({ "w": text }).to_string();
        text = format!("{}{}{}", "[".repeat(LAYERS), obj, "]".repeat(LAYERS));
        links += 1;
    }
    (text, links)
}

fn body_extract(path: &str) -> Extract {
    Extract::Body {
        var: "v".into(),
        path: path.into(),
        decode: None,
        claim: None,
        default: None,
    }
}

fn run_on_small_stack(body: &str, path: &str) -> Result<String, String> {
    let body = body.as_bytes().to_vec();
    let path = path.to_string();
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(move || {
            let facts = ResponseFacts {
                status: 200,
                headers: &[],
                set_cookies: &[],
                body: &body,
            };
            evaluate_extracts(&[body_extract(&path)], &facts)
                .map(|m| m["v"].clone())
                .map_err(|e| e.to_string())
        })
        .unwrap()
        .join()
        .unwrap()
}

fn check_chain(target: usize) {
    let deep_container = format!("${}.w[0]", "[0]".repeat(LAYERS));
    let (body, links) = build_chain(target);
    eprintln!("target={target} body_len={} links={links}", body.len());
    // 고리가 둘 이상이어야 안쪽 푼 값에서 찾을 때 고리를 실제로 건넌다.
    assert!(links >= 2);

    for path in ["$.a.b", "$..zzz"] {
        let err = run_on_small_stack(&body, path).unwrap_err();
        assert!(err.contains("no match"), "{path}: {err}");
    }
    assert_eq!(run_on_small_stack(&body, "$..x").unwrap(), "1");
    assert!(run_on_small_stack(&body, "$..w").is_ok());
    // 안쪽까지 푼 값에서만 찾히는 깊은 컨테이너 — 찾은 값이 통째로 글자가 됐는지 본다.
    let deep = run_on_small_stack(&body, &deep_container).unwrap();
    assert!(deep.starts_with('['), "{}", &deep[..deep.len().min(40)]);
    assert!(deep.contains(r#""x":1"#));
}

#[test]
fn deep_unwrap_chain_does_not_overflow_1mib() {
    check_chain(1 << 20);
}

#[test]
#[cfg_attr(
    debug_assertions,
    ignore = "debug 빌드는 25.2 MB 본문(찾은 값 깊이 2,122)의 글자화에서 2 MiB 스택을 넘는다 — release 전용(§B72 (0))"
)]
fn deep_unwrap_chain_does_not_overflow_16mib() {
    check_chain(16 << 20);
}

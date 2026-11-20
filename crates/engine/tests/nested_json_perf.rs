//! 못 찾는 본문 경로의 비용 — 옛 길(파싱 + `jsonpath_first`) 대비 비율. 전부 `#[ignore]`(수동 측정):
//! `cargo test -p handicap-engine --release --test nested_json_perf -- --ignored --nocapture`

use std::hint::black_box;
use std::time::{Duration, Instant};

use handicap_engine::extract::{evaluate, jsonpath_first};
use handicap_engine::json_unwrap::{has_unwrappable, unwrap_nested};
use handicap_engine::scenario::Extract;
use handicap_engine::{ResponseFacts, evaluate_lenient};
use serde_json::{Value, json};

const REPS: usize = 200;
const ROUNDS: usize = 5;

/// 짧은 글자 필드를 가진 객체 `count`개 배열(2200개 ≈100 KiB). `label`이 글자 필드 값,
/// `wrap_every`가 `Some(k)`면 `k`번째마다 감싼 JSON 문자열 필드를 단다.
fn body_with(label: impl Fn(usize) -> String, count: usize, wrap_every: Option<usize>) -> Vec<u8> {
    let mut items = Vec::new();
    for i in 0..count {
        let mut o = json!({"id": i, "name": label(i), "ok": true, "n": i * 3});
        if wrap_every.is_some_and(|k| i % k == 0) {
            o["payload"] = Value::String(json!({"k": i, "tag": "x"}).to_string());
        }
        items.push(o);
    }
    serde_json::to_vec(&json!({ "items": items })).unwrap()
}

fn body_a() -> Vec<u8> {
    body_with(|i| format!("user{i}"), 2200, None)
}

fn body_b() -> Vec<u8> {
    body_with(|i| format!("[INFO] event {i}"), 2200, None)
}

fn body_c() -> Vec<u8> {
    body_with(|i| format!("user{i}"), 2200, Some(100))
}

/// 글자 ≈4 KiB에 감싼 필드 18개.
fn body_c_small() -> Vec<u8> {
    body_with(|i| format!("user{i}"), 90, Some(5))
}

/// 레코드마다 감싼 필드(풀리는 문자열 2,200개).
fn body_c_dense() -> Vec<u8> {
    body_with(|i| format!("user{i}"), 2200, Some(1))
}

fn body_extract(var: &str, path: &str) -> Extract {
    Extract::Body {
        var: var.into(),
        path: path.into(),
        decode: None,
        claim: None,
        default: None,
    }
}

fn facts(body: &[u8]) -> ResponseFacts<'_> {
    ResponseFacts {
        status: 200,
        headers: &[],
        set_cookies: &[],
        body,
    }
}

fn extracts(paths: &[&str]) -> Vec<Extract> {
    paths
        .iter()
        .enumerate()
        .map(|(i, p)| body_extract(&format!("v{i}"), p))
        .collect()
}

/// 옛 길: 항목마다 파싱 없이 `jsonpath_first` 한 번 + 본문 파싱 한 번.
fn old_paths(body: &[u8], paths: &[&str]) -> usize {
    let Ok(v) = serde_json::from_slice::<Value>(body) else {
        return 0;
    };
    paths
        .iter()
        .filter(|p| jsonpath_first(&v, p).is_some())
        .count()
}

fn new_lenient(body: &[u8], paths: &[&str]) -> usize {
    evaluate_lenient(&extracts(paths), &facts(body)).len()
}

fn new_strict(body: &[u8], paths: &[&str]) -> usize {
    evaluate(&extracts(paths), &facts(body)).map_or(0, |m| m.len())
}

/// `ROUNDS`번 반복해 `REPS`회 시간의 최솟값.
fn min_time(mut f: impl FnMut()) -> Duration {
    (0..ROUNDS)
        .map(|_| {
            let t = Instant::now();
            for _ in 0..REPS {
                f();
            }
            t.elapsed()
        })
        .min()
        .unwrap()
}

fn ratio_with(
    name: &str,
    body: &[u8],
    paths: &[&str],
    new: impl Fn(&[u8], &[&str]) -> usize,
) -> f64 {
    let old = min_time(|| {
        black_box(old_paths(black_box(body), paths));
    });
    let newt = min_time(|| {
        black_box(new(black_box(body), paths));
    });
    let r = newt.as_secs_f64() / old.as_secs_f64();
    eprintln!(
        "{name}: len={} old={old:?} new={newt:?} ratio new/old={r:.3}",
        body.len()
    );
    r
}

fn ratio(name: &str, body: &[u8]) -> f64 {
    ratio_with(name, body, &["$.nope"], new_lenient)
}

#[test]
#[ignore]
fn miss_ratio_no_candidates() {
    let a = ratio("A(no candidates)", &body_a());
    ratio("B(candidates, not unwrapped)", &body_b());
    let c = ratio("C(unwrapped)", &body_c());
    assert!(a <= 1.25, "body A ratio {a:.3} > 1.25");
    assert!(c <= 1.10, "body C ratio {c:.3} > 1.10");
}

/// 기록 행(단언 없음).
#[test]
#[ignore]
fn nested_cost_rows() {
    ratio("row1 small C miss", &body_c_small());
    ratio_with(
        "row2 C found at stage 3 ($.items[0].payload.k)",
        &body_c(),
        &["$.items[0].payload.k"],
        new_lenient,
    );
    ratio("row3 dense C (2200 unwrapped) miss", &body_c_dense());
    let two = ["$.nope", "$.items"];
    ratio_with(
        "row4 strict [nope, items] on A",
        &body_a(),
        &two,
        new_strict,
    );
    ratio_with(
        "row5 strict [nope, items] on C",
        &body_c(),
        &two,
        new_strict,
    );
}

#[test]
#[ignore]
fn scan_vs_clone() {
    let a: Value = serde_json::from_slice(&body_a()).unwrap();
    let scan = min_time(|| {
        black_box(has_unwrappable(black_box(&a)));
    });
    let clone = min_time(|| {
        black_box(black_box(&a).clone());
    });
    let unwrap = min_time(|| {
        black_box(unwrap_nested(black_box(&a)));
    });
    eprintln!("scan_vs_clone: has_unwrappable={scan:?} clone={clone:?} unwrap_nested={unwrap:?}");
}

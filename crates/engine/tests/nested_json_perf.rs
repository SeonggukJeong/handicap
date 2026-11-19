//! 못 찾는 본문 경로의 비용 — 옛 길(파싱 + `jsonpath_first`) 대비 비율. 전부 `#[ignore]`(수동 측정):
//! `cargo test -p handicap-engine --release --test nested_json_perf -- --ignored --nocapture`

use std::hint::black_box;
use std::time::{Duration, Instant};

use handicap_engine::extract::jsonpath_first;
use handicap_engine::json_unwrap::{has_unwrappable, unwrap_nested};
use handicap_engine::scenario::Extract;
use handicap_engine::{ResponseFacts, evaluate_lenient};
use serde_json::{Value, json};

const REPS: usize = 200;
const ROUNDS: usize = 5;

/// 짧은 글자 필드를 가진 객체 배열, 글자 ≈100 KiB. `label`이 글자 필드 값.
fn body_with(label: impl Fn(usize) -> String, wrapped: bool) -> Vec<u8> {
    let mut items = Vec::new();
    for i in 0..2200 {
        let mut o = json!({"id": i, "name": label(i), "ok": true, "n": i * 3});
        if wrapped && i % 100 == 0 {
            o["payload"] = Value::String(json!({"k": i, "tag": "x"}).to_string());
        }
        items.push(o);
    }
    serde_json::to_vec(&json!({ "items": items })).unwrap()
}

fn body_a() -> Vec<u8> {
    body_with(|i| format!("user{i}"), false)
}

fn body_b() -> Vec<u8> {
    body_with(|i| format!("[INFO] event {i}"), false)
}

fn body_c() -> Vec<u8> {
    body_with(|i| format!("user{i}"), true)
}

fn old_miss(body: &[u8]) -> Option<Value> {
    let v: Value = serde_json::from_slice(body).ok()?;
    jsonpath_first(&v, "$.nope")
}

fn new_miss(body: &[u8]) -> usize {
    let facts = ResponseFacts {
        status: 200,
        headers: &[],
        set_cookies: &[],
        body,
    };
    let e = Extract::Body {
        var: "v".into(),
        path: "$.nope".into(),
        decode: None,
        claim: None,
        default: None,
    };
    evaluate_lenient(&[e], &facts).len()
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

fn ratio(name: &str, body: &[u8]) -> f64 {
    let old = min_time(|| {
        black_box(old_miss(black_box(body)));
    });
    let new = min_time(|| {
        black_box(new_miss(black_box(body)));
    });
    let r = new.as_secs_f64() / old.as_secs_f64();
    eprintln!(
        "{name}: len={} old={old:?} new={new:?} ratio new/old={r:.3}",
        body.len()
    );
    r
}

#[test]
#[ignore]
fn miss_ratio_no_candidates() {
    let a = ratio("A(no candidates)", &body_a());
    ratio("B(candidates, not unwrapped)", &body_b());
    ratio("C(unwrapped)", &body_c());
    assert!(a <= 1.25, "body A ratio {a:.3} > 1.25");
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

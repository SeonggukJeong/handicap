//! 본문 추출 비용 — 못 찾는 경로·3단계에서 찾는 경로·엄격 평가 행을 옛 길(파싱 + `jsonpath_first`) 대비 비율로 잰다. 전부 `#[ignore]`(수동 측정):
//! `cargo test -p handicap-engine --release --test nested_json_perf -- --ignored --nocapture --test-threads=1`

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

/// 본문 A와 같은 모양에서 감싼 필드가 맨 앞 레코드 하나뿐이다. `has_unwrappable`은 스택에서 뒤쪽부터
/// 꺼내므로 맨 앞 레코드가 마지막으로 닿고, 키 `a_payload`는 객체 값 중 가장 먼저 쌓여(키 순서) 그 레코드 안에서도 마지막으로 닿는다.
fn body_c_first() -> Vec<u8> {
    let mut v: Value = serde_json::from_slice(&body_a()).unwrap();
    let items = v["items"].as_array_mut().unwrap();
    items[0]["a_payload"] = Value::String(json!({"k": 0, "tag": "x"}).to_string());
    serde_json::to_vec(&v).unwrap()
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

/// 옛 길(너그러운): 본문 파싱 한 번 + 항목마다 파싱 없이 `jsonpath_first` 한 번.
fn old_lenient(body: &[u8], paths: &[&str]) -> usize {
    let Ok(v) = serde_json::from_slice::<Value>(body) else {
        return 0;
    };
    paths
        .iter()
        .filter(|p| jsonpath_first(&v, p).is_some())
        .count()
}

/// 옛 길(엄격): 위와 같되 첫 못 찾음에서 멈춘다(엄격 `evaluate`가 첫 에러에서 끝나는 것과 같다).
fn old_strict(body: &[u8], paths: &[&str]) -> usize {
    let Ok(v) = serde_json::from_slice::<Value>(body) else {
        return 0;
    };
    paths
        .iter()
        .take_while(|p| jsonpath_first(&v, p).is_some())
        .count()
}

fn new_lenient(body: &[u8], xs: &[Extract]) -> usize {
    evaluate_lenient(xs, &facts(body)).len()
}

fn new_strict(body: &[u8], xs: &[Extract]) -> usize {
    evaluate(xs, &facts(body)).map_or(0, |m| m.len())
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

/// 분자 = 새 구현 `new(body, 항목들)`, 분모 = 옛 길 `old(body, 경로들)`.
fn ratio_with(
    name: &str,
    body: &[u8],
    paths: &[&str],
    old: impl Fn(&[u8], &[&str]) -> usize,
    new: impl Fn(&[u8], &[Extract]) -> usize,
) -> f64 {
    let xs = extracts(paths);
    let old_t = min_time(|| {
        black_box(old(black_box(body), paths));
    });
    let new_t = min_time(|| {
        black_box(new(black_box(body), &xs));
    });
    let r = new_t.as_secs_f64() / old_t.as_secs_f64();
    eprintln!(
        "{name}: len={} old={old_t:?} new={new_t:?} ratio new/old={r:.3}",
        body.len()
    );
    r
}

/// 분자 = 새 너그러운 `evaluate_lenient([$.nope])`, 분모 = 옛 길 파싱 + `jsonpath_first($.nope)`.
fn ratio(name: &str, body: &[u8]) -> f64 {
    ratio_with(name, body, &["$.nope"], old_lenient, new_lenient)
}

/// 새 엄격 `evaluate(paths)`의 시간.
fn strict_time(body: &[u8], paths: &[&str]) -> Duration {
    let xs = extracts(paths);
    min_time(|| {
        black_box(new_strict(black_box(body), &xs));
    })
}

/// `measure`를 최대 3번 재서 `limit` 이하가 나오면 멈추고, 잰 값 중 최솟값을 돌려준다.
fn min_ratio(limit: f64, mut measure: impl FnMut() -> f64) -> f64 {
    let mut best = f64::INFINITY;
    for _ in 0..3 {
        best = best.min(measure());
        if best <= limit {
            break;
        }
    }
    best
}

#[test]
#[ignore]
fn miss_ratio_no_candidates() {
    let body_a = body_a();
    let body_c = body_c();
    let a = min_ratio(1.25, || ratio("A(no candidates)", &body_a));
    ratio("B(candidates, not unwrapped)", &body_b());
    let c = min_ratio(1.10, || ratio("C(unwrapped)", &body_c));
    assert!(a <= 1.25, "body A ratio {a:.3} > 1.25");
    assert!(c <= 1.10, "body C ratio {c:.3} > 1.10");
}

/// 기록 행. 행 ④만 단언한다 — 풀 것 없는 본문에서 첫 못 찾음 뒤 항목이 더 있어도 미리 구하는 일이 없어야 한다.
#[test]
#[ignore]
fn nested_cost_rows() {
    ratio(
        "row1 small C (4 KiB, 18 unwrapped) lenient [$.nope] / old parse+jsonpath_first",
        &body_c_small(),
    );
    ratio_with(
        "row2 C lenient [$.items[0].payload.k] found at stage 3 / old parse+jsonpath_first of the same path (평범한 조회 대비, not old-vs-new of the same work)",
        &body_c(),
        &["$.items[0].payload.k"],
        old_lenient,
        new_lenient,
    );
    ratio(
        "row3 dense C (2200 unwrapped) lenient [$.nope] / old parse+jsonpath_first",
        &body_c_dense(),
    );
    ratio(
        "row6 C-first (감싼 필드가 맨 앞 레코드 하나 — 스택 순회가 마지막에 닿는 곳) lenient [$.nope] / old parse+jsonpath_first",
        &body_c_first(),
    );
    let two = ["$.nope", "$.items"];
    let body_a = body_a();
    let row4 = min_ratio(1.25, || {
        ratio_with(
            "row4 A strict [nope, items] / old strict (parse + jsonpath_first, stops at first miss)",
            &body_a,
            &two,
            old_strict,
            new_strict,
        )
    });
    assert!(row4 <= 1.25, "row4 ratio {row4:.3} > 1.25");
    ratio_with(
        "row5 C strict [nope, items] / old strict (parse + jsonpath_first, stops at first miss)",
        &body_c(),
        &two,
        old_strict,
        new_strict,
    );
    let c = body_c();
    let two_t = strict_time(&c, &two);
    let one_t = strict_time(&c, &["$.nope"]);
    eprintln!(
        "row5 waste: C strict [nope, items]={two_t:?} / C strict [nope]={one_t:?} ratio={:.3}",
        two_t.as_secs_f64() / one_t.as_secs_f64()
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

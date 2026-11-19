//! 문자열로 감싼 JSON 풀기 — 모니터(컨트롤러)와 추출(엔진)이 같은 규칙을 쓴다.

use serde_json::Value;

/// 본문 JSON 읽기 — 문자열로 감싼 JSON은 최대 `MAX_JSON_UNWRAP`번 풀어 객체/배열을 낸다.
pub const MAX_JSON_UNWRAP: usize = 3;

/// 문자열 하나를 최대 `MAX_JSON_UNWRAP`겹 풀어 객체/배열이 되면 그 값. 아니면 `None`.
pub fn unwrap_json_str(s: &str) -> Option<Value> {
    // 객체·배열·감싼 문자열만 후보 — 평범한 문자열은 파싱 시도도 안 한다(JSON 공백 4종만 건너뜀).
    let head = s.trim_start_matches([' ', '\t', '\n', '\r']);
    if !head.starts_with(['{', '[', '"']) {
        return None;
    }
    let mut cur = s.to_owned();
    for _ in 0..MAX_JSON_UNWRAP {
        match serde_json::from_str::<Value>(&cur) {
            Ok(v) if v.is_object() || v.is_array() => return Some(v),
            Ok(Value::String(next)) => cur = next,
            _ => return None,
        }
    }
    None
}

pub fn parse_body_json(body: &str) -> Option<Value> {
    let first: Value = serde_json::from_str(body).ok()?;
    // 평범한 객체/배열(대부분)은 복제 없이 그대로 — 문자열일 때만 풀기 시도.
    if let Value::String(s0) = &first
        && let Some(v) = unwrap_json_str(s0)
    {
        return Some(v);
    }
    Some(first)
}

/// 풀 수 있는 문자열이 하나라도 있는가 — 읽기 전용 반복 순회(깊은 본문에서도 스택 안전).
pub fn has_unwrappable(root: &Value) -> bool {
    let mut stack: Vec<&Value> = vec![root];
    while let Some(node) = stack.pop() {
        match node {
            Value::String(s) => {
                if unwrap_json_str(s).is_some() {
                    return true;
                }
            }
            Value::Array(a) => stack.extend(a.iter()),
            Value::Object(o) => stack.extend(o.values()),
            _ => {}
        }
    }
    false
}

/// 안쪽 필드의 감싼 JSON까지 푼 사본. 바뀐 곳이 없으면 `None`(경로 재조회 불필요).
/// 풀 것이 없으면 복사하지 않는다. 깊은 본문에서도 스택이 넘치지 않게 직접 쌓아 가며 훑는다.
pub fn unwrap_nested(root: &Value) -> Option<Value> {
    if !has_unwrappable(root) {
        return None;
    }
    let mut out = root.clone();
    let mut changed = false;
    let mut stack: Vec<&mut Value> = vec![&mut out];
    while let Some(node) = stack.pop() {
        if let Value::String(s) = node
            && let Some(inner) = unwrap_json_str(s)
        {
            *node = inner;
            changed = true;
        }
        match node {
            Value::Array(a) => stack.extend(a.iter_mut()),
            Value::Object(o) => stack.extend(o.values_mut()),
            _ => {}
        }
    }
    changed.then_some(out)
}

/// `unwrap_nested`의 제자리 판: 풀리는 문자열을 푼 값으로 바꾸고(푼 값 안쪽도 이어서),
/// 하나라도 바꿨으면 `true`. 복사하지 않고, 직접 쌓는 스택으로 `unwrap_nested`의 교체 순회와 같은 순서로 훑는다.
pub fn unwrap_in_place(root: &mut Value) -> bool {
    let mut changed = false;
    let mut stack: Vec<&mut Value> = vec![root];
    while let Some(node) = stack.pop() {
        if let Value::String(s) = node
            && let Some(inner) = unwrap_json_str(s)
        {
            *node = inner;
            changed = true;
        }
        match node {
            Value::Array(a) => stack.extend(a.iter_mut()),
            Value::Object(o) => stack.extend(o.values_mut()),
            _ => {}
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wrap(v: &Value, times: usize) -> String {
        let mut s = v.to_string();
        for _ in 0..times {
            s = Value::String(s).to_string();
        }
        s
    }

    #[test]
    fn unwrap_json_str_table() {
        let obj = json!({"code":1});
        // wrap(obj, n) = 문자열 n겹 감싼 JSON 텍스트; 풀기 입력은 그 안쪽 문자열 값.
        for n in 1..=3 {
            let text = wrap(&obj, n);
            let outer: String = serde_json::from_str(&text).unwrap();
            assert_eq!(unwrap_json_str(&outer), Some(obj.clone()), "n={n}");
        }
        let outer4: String = serde_json::from_str(&wrap(&obj, 4)).unwrap();
        assert_eq!(unwrap_json_str(&outer4), None);
        for s in ["hello", "12", "{oops", ""] {
            assert_eq!(unwrap_json_str(s), None, "{s:?}");
        }
        assert_eq!(unwrap_json_str(" \n[1,2] "), Some(json!([1, 2])));
    }

    #[test]
    fn has_unwrappable_table() {
        assert!(!has_unwrappable(&json!({"a":1,"b":"x"})));
        assert!(!has_unwrappable(
            &json!({"a":"[INFO] x","b":"{name}","c":"\"12\""})
        ));
        assert!(has_unwrappable(&json!({"a":{"b":["{\"k\":1}"]}})));
        assert!(has_unwrappable(&json!("{\"k\":1}")));
    }

    fn old_unwrap_nested(root: &Value) -> Option<Value> {
        let mut out = root.clone();
        let mut changed = false;
        let mut stack: Vec<&mut Value> = vec![&mut out];
        while let Some(node) = stack.pop() {
            if let Value::String(s) = node
                && let Some(inner) = unwrap_json_str(s)
            {
                *node = inner;
                changed = true;
            }
            match node {
                Value::Array(a) => stack.extend(a.iter_mut()),
                Value::Object(o) => stack.extend(o.values_mut()),
                _ => {}
            }
        }
        changed.then_some(out)
    }

    #[test]
    fn unwrap_nested_matches_old_impl() {
        let inner = json!({"id":7,"deep":"{\"k\":\"x\"}"}).to_string();
        let cases = vec![
            json!({"a":1,"b":"x"}),
            json!({"a":"[INFO] x","b":"{name}","c":"\"12\""}),
            json!({"a":{"b":["{\"k\":1}"]}}),
            json!("{\"k\":1}"),
            json!({"data": inner, "empty":"[]", "eobj":" {} ", "n":"007"}),
        ];
        for v in &cases {
            assert_eq!(unwrap_nested(v), old_unwrap_nested(v), "{v}");
        }
    }

    #[test]
    fn unwrap_nested_matches_old_impl_on_vectors() {
        let fx: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/nested_json_vectors.json"
        )))
        .unwrap();
        let mut parsed = 0;
        for key in ["cases", "known_divergence"] {
            for case in fx[key].as_array().unwrap() {
                let body = case["body"].as_str().unwrap();
                if let Ok(v) = serde_json::from_str::<Value>(body) {
                    assert_eq!(unwrap_nested(&v), old_unwrap_nested(&v), "{body}");
                    parsed += 1;
                }
            }
        }
        assert!(parsed >= 14, "parsed bodies: {parsed}");
    }

    /// 2만 겹 배열 안에 감싼 `{"k":1}` — 반복문으로 만든다(`from_str`은 128겹에서 거절).
    fn deep_value() -> Value {
        let mut v = json!(["{\"k\":1}"]);
        for _ in 0..20_000 {
            v = Value::Array(vec![v]);
        }
        v
    }

    #[test]
    fn has_unwrappable_deep_is_iterative() {
        let v = deep_value();
        std::thread::scope(|sc| {
            let ok = std::thread::Builder::new()
                .stack_size(2 * 1024 * 1024)
                .spawn_scoped(sc, || has_unwrappable(&v))
                .unwrap()
                .join()
                .unwrap();
            assert!(ok);
        });
        // 해제는 재귀라 큰 스택 스레드에서.
        std::thread::Builder::new()
            .stack_size(16 * 1024 * 1024)
            .spawn(move || drop(v))
            .unwrap()
            .join()
            .unwrap();
    }

    /// 기준 둘(`unwrap_nested`, `old_unwrap_nested`)과 같은 결과.
    fn assert_in_place_matches(v: &Value) {
        let mut got = v.clone();
        let changed = unwrap_in_place(&mut got);
        for want in [unwrap_nested(v), old_unwrap_nested(v)] {
            match want {
                Some(w) => {
                    assert!(changed, "{v}");
                    assert_eq!(got, w, "{v}");
                }
                None => {
                    assert!(!changed, "{v}");
                    assert_eq!(&got, v, "{v}");
                }
            }
        }
    }

    #[test]
    fn unwrap_in_place_matches_reference() {
        let inner = json!({"id":7,"deep":"{\"k\":\"x\"}"}).to_string();
        let cases = vec![
            json!({"a":1,"b":"x"}),
            json!({"a":"[INFO] x","b":"{name}","c":"\"12\""}),
            json!({"a":{"b":["{\"k\":1}"]}}),
            json!("{\"k\":1}"),
            json!({"data": inner, "empty":"[]", "eobj":" {} ", "n":"007"}),
        ];
        for v in &cases {
            assert_in_place_matches(v);
        }
        let fx: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/nested_json_vectors.json"
        )))
        .unwrap();
        let mut parsed = 0;
        for key in ["cases", "known_divergence"] {
            for case in fx[key].as_array().unwrap() {
                let body = case["body"].as_str().unwrap();
                if let Ok(v) = serde_json::from_str::<Value>(body) {
                    assert_in_place_matches(&v);
                    parsed += 1;
                }
            }
        }
        assert!(parsed >= 14, "parsed bodies: {parsed}");
    }

    #[test]
    fn unwrap_in_place_deep_value() {
        // 해제가 재귀라 큰 스택 스레드에서.
        std::thread::Builder::new()
            .stack_size(128 * 1024 * 1024)
            .spawn(|| {
                let mut v = deep_value();
                assert!(unwrap_in_place(&mut v));
            })
            .unwrap()
            .join()
            .unwrap();
    }

    /// `wrap`이 감싸는 작은 값 — 잎이 이미 감싼 글자일 수 있어, 푼 값 안에 또 푸는 필드가 생긴다.
    fn arb_small() -> impl proptest::strategy::Strategy<Value = Value> {
        use proptest::prelude::*;
        let tiny = prop_oneof![
            Just(Value::Null),
            (0i64..1000).prop_map(|n| json!(n)),
            "[a-z]{0,3}".prop_map(Value::String),
            proptest::collection::btree_map("[a-z]{1,3}", (0i64..10).prop_map(|n| json!(n)), 0..3)
                .prop_map(|m| Value::Object(m.into_iter().collect())),
        ];
        let wrapped_leaf = (tiny, 0usize..=2).prop_map(|(v, n)| Value::String(wrap(&v, n)));
        let leaf = prop_oneof![
            1 => Just(Value::Null),
            1 => any::<bool>().prop_map(Value::Bool),
            1 => (0i64..1000).prop_map(|n| json!(n)),
            1 => "[a-z ]{0,4}".prop_map(Value::String),
            4 => wrapped_leaf,
        ];
        leaf.prop_recursive(2, 8, 3, |inner| {
            prop_oneof![
                proptest::collection::vec(inner.clone(), 0..3).prop_map(Value::Array),
                proptest::collection::btree_map("[a-z]{1,3}", inner, 0..3)
                    .prop_map(|m| Value::Object(m.into_iter().collect())),
            ]
        })
    }

    /// 깊이 ≤4의 `Value` — 문자열 잎은 평범한 글자, 후보지만 안 풀리는 글자,
    /// 작은 `Value`를 1–4겹 감싼 글자 중에서 뽑는다.
    fn arb_value() -> impl proptest::strategy::Strategy<Value = Value> {
        use proptest::prelude::*;
        let wrapped = (arb_small(), 0usize..=3).prop_map(|(v, n)| Value::String(wrap(&v, n)));
        let leaf = prop_oneof![
            Just(Value::Null),
            any::<bool>().prop_map(Value::Bool),
            (0i64..1000).prop_map(|n| json!(n)),
            "[a-z ]{0,6}".prop_map(Value::String),
            prop_oneof![Just("[INFO] x"), Just("{name}"), Just("\"12\"")]
                .prop_map(|s| Value::String(s.to_owned())),
            wrapped,
        ];
        leaf.prop_recursive(4, 32, 4, |inner| {
            prop_oneof![
                proptest::collection::vec(inner.clone(), 0..4).prop_map(Value::Array),
                proptest::collection::btree_map("[a-z]{1,3}", inner, 0..4)
                    .prop_map(|m| Value::Object(m.into_iter().collect())),
            ]
        })
    }

    proptest::proptest! {
        #[test]
        fn unwrap_in_place_matches_reference_prop(v in arb_value()) {
            assert_in_place_matches(&v);
        }
    }

    #[test]
    fn unwrap_nested_deep_value() {
        // 디버그 빌드에서 2만 겹 `Value` 복제·해제의 재귀가 16MiB 스택을 넘는다.
        std::thread::Builder::new()
            .stack_size(128 * 1024 * 1024)
            .spawn(|| {
                let v = deep_value();
                assert!(unwrap_nested(&v).is_some());
            })
            .unwrap()
            .join()
            .unwrap();
    }
}

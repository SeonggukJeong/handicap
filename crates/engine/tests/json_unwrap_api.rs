use handicap_engine::json_unwrap::{has_unwrappable, parse_body_json, unwrap_nested};
use serde_json::json;

#[test]
fn json_unwrap_public_api() {
    let wrapped = json!("{\"a\":1}").to_string();
    assert_eq!(parse_body_json(&wrapped), Some(json!({"a":1})));
    assert!(has_unwrappable(&json!({"a":"{\"k\":1}"})));
    assert_eq!(unwrap_nested(&json!({"a":1})), None);
}

use handicap_proto::v1::{Profile, RunAssignment};
use std::collections::HashMap;

/// Compile-time + runtime guard: RunAssignment must have an `env` map<string,string> field.
#[test]
fn run_assignment_env_field_exists() {
    let mut env = HashMap::new();
    env.insert("BASE_URL".to_string(), "http://example.com".to_string());
    let a = RunAssignment {
        run_id: "r1".to_string(),
        scenario_yaml: "yaml: true".to_string(),
        profile: Some(Profile {
            vus: 1,
            ramp_up_seconds: 0,
            duration_seconds: 10,
        }),
        env,
    };
    assert_eq!(
        a.env.get("BASE_URL").map(String::as_str),
        Some("http://example.com")
    );
}

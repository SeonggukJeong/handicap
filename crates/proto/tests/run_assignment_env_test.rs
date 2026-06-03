use handicap_proto::v1::{Profile, RunAssignment};
use std::collections::HashMap;

/// Compile-time + runtime guard: RunAssignment must have an `env` map<string,string> field
/// and the 4 shard fields (shard_index, shard_count, vu_offset, vu_count).
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
            loop_breakdown_cap: 0,
            http_timeout_seconds: 30,
        }),
        env,
        data_binding: None,
        shard_index: 2,
        shard_count: 4,
        vu_offset: 10,
        vu_count: 5,
    };
    assert_eq!(
        a.env.get("BASE_URL").map(String::as_str),
        Some("http://example.com")
    );
    assert_eq!(
        (a.shard_index, a.shard_count, a.vu_offset, a.vu_count),
        (2, 4, 10, 5)
    );
}

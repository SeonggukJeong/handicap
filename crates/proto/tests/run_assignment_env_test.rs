use handicap_proto::v1::{
    DataBinding, DatasetBatch, Profile, RunAssignment, Stage, data_binding::Policy,
};
use prost::Message;
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
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: vec![
                Stage {
                    target: 200,
                    duration_seconds: 30,
                },
                Stage {
                    target: 0,
                    duration_seconds: 30,
                },
            ],
            measure_phases: false,
            vu_stages: vec![],
            ramp_down_immediate: false,
        }),
        env,
        data_binding: None,
        shard_index: 2,
        shard_count: 4,
        vu_offset: 10,
        vu_count: 5,
        data_bindings: vec![],
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

/// Proto round-trip guard: Profile.stages must survive encode→decode.
#[test]
fn profile_stages_round_trip() {
    let original = RunAssignment {
        run_id: "r2".to_string(),
        scenario_yaml: "yaml: true".to_string(),
        profile: Some(Profile {
            vus: 10,
            ramp_up_seconds: 0,
            duration_seconds: 60,
            loop_breakdown_cap: 0,
            http_timeout_seconds: 30,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: vec![
                Stage {
                    target: 200,
                    duration_seconds: 30,
                },
                Stage {
                    target: 0,
                    duration_seconds: 30,
                },
            ],
            measure_phases: false,
            vu_stages: vec![],
            ramp_down_immediate: false,
        }),
        env: HashMap::new(),
        data_binding: None,
        shard_index: 0,
        shard_count: 1,
        vu_offset: 0,
        vu_count: 10,
        data_bindings: vec![],
    };

    // encode → decode round-trip
    let mut buf = Vec::new();
    original.encode(&mut buf).expect("encode failed");
    let decoded = RunAssignment::decode(buf.as_slice()).expect("decode failed");

    assert_eq!(decoded.profile.as_ref().unwrap().stages.len(), 2);
    assert_eq!(decoded.profile.as_ref().unwrap().stages[0].target, 200);
    assert_eq!(decoded.profile.as_ref().unwrap().stages[1].target, 0);
    assert_eq!(
        decoded.profile.as_ref().unwrap().stages[0].duration_seconds,
        30
    );
}

#[test]
fn run_assignment_carries_multiple_bindings() {
    let a = RunAssignment {
        run_id: "r".into(),
        data_bindings: vec![
            DataBinding {
                policy: Policy::PerVu as i32,
                seed: 1,
                row_count: 3,
            },
            DataBinding {
                policy: Policy::Unique as i32,
                seed: 1,
                row_count: 20,
            },
        ],
        ..Default::default()
    };
    let bytes = a.encode_to_vec();
    let back = RunAssignment::decode(bytes.as_slice()).unwrap();
    assert_eq!(back.data_bindings.len(), 2);
    assert_eq!(back.data_bindings[1].row_count, 20);
}

#[test]
fn dataset_batch_carries_binding_index() {
    let b = DatasetBatch {
        run_id: "r".into(),
        rows: vec![],
        binding_index: 2,
    };
    let back = DatasetBatch::decode(b.encode_to_vec().as_slice()).unwrap();
    assert_eq!(back.binding_index, 2);
}

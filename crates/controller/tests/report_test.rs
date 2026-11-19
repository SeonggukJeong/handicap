use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::dispatcher::subprocess::SubprocessDispatcher;
use handicap_controller::grpc::coordinator::CoordinatorState;
use handicap_controller::report::ReportJson;
use handicap_controller::store::metrics::{
    ErrorKindRow, LoopExitRow, MetricRow, insert_batch, insert_error_kind_batch,
    insert_loop_exit_batch,
};
use handicap_controller::store::runs::{Profile, RunStatus};
use handicap_controller::{app, store};
use hdrhistogram::Histogram;
use hdrhistogram::serialization::{Serializer, V2Serializer};
use serde_json::Value;
use tower::ServiceExt;

fn make_app(db: handicap_controller::store::Db) -> axum::Router {
    let coord = CoordinatorState::new(db.clone());
    app::router(app::AppState {
        db: db.clone(),
        coord,
        dispatcher: Arc::new(SubprocessDispatcher::new(
            "/nonexistent".to_string(),
            "127.0.0.1:0".parse().unwrap(),
            db,
        )),
        ui_dir: None,
        settings: handicap_controller::settings::SettingsState::build(
            &std::collections::HashMap::new(),
            &[],
        ),
        scheduler_tz: chrono_tz::UTC,
        monitor: handicap_controller::monitor::MonitorSupervisor::default(),
    })
}

fn make_hdr_bytes(samples_us: &[u64]) -> Vec<u8> {
    let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    for &v in samples_us {
        h.record(v).unwrap();
    }
    let mut buf = Vec::new();
    V2Serializer::new().serialize(&h, &mut buf).unwrap();
    buf
}

async fn seed_run_with_metrics(db: &handicap_controller::store::Db) -> (String, String) {
    let yaml = concat!(
        "version: 1\n",
        "name: report-test\n",
        "steps:\n",
        "  - id: stepA\n",
        "    name: ping\n",
        "    type: http\n",
        "    request:\n",
        "      method: GET\n",
        "      url: http://x/ping\n",
    );

    // Insert a scenario row first (FK: runs.scenario_id REFERENCES scenarios(id)).
    // SQLite doesn't enforce FKs by default in this pool, but insert anyway to be safe.
    sqlx::query(
        "INSERT INTO scenarios(id, name, yaml, created_at, updated_at, version) \
         VALUES(?,?,?,?,?,?)",
    )
    .bind("S-report-test")
    .bind("report-test")
    .bind(yaml)
    .bind(1_i64)
    .bind(1_i64)
    .bind(1_i64)
    .execute(db)
    .await
    .unwrap();

    let env = serde_json::json!({});
    let profile = Profile {
        vus: 1,
        ramp_up_seconds: 0,
        duration_seconds: 2,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
        data_binding: None,
        data_bindings: vec![],
        criteria: None,
        think_time: None,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
        stages: None,
        measure_phases: false,
        vu_stages: None,
        ramp_down: None,
        graceful_ramp_down_seconds: None,
        connect_timeout_seconds: None,
        worker_count: None,
        apply_scenario_think_time: true,
        stair: None,
    };
    let row = store::runs::insert(db, "S-report-test", yaml, &profile, &env, None)
        .await
        .unwrap();
    // Move to completed so the report endpoint can answer for a terminal run.
    store::runs::set_status(db, &row.id, RunStatus::Completed, Some(100), Some(102))
        .await
        .unwrap();

    let metric_rows = vec![
        MetricRow {
            run_id: row.id.clone(),
            ts_second: 100,
            step_id: "stepA".to_string(),
            worker_id: "".to_string(),
            count: 5,
            error_count: 0,
            hdr_histogram: make_hdr_bytes(&[10_000, 20_000, 30_000]),
            status_counts: r#"{"200":5}"#.to_string(),
        },
        MetricRow {
            run_id: row.id.clone(),
            ts_second: 101,
            step_id: "stepA".to_string(),
            worker_id: "".to_string(),
            count: 2,
            error_count: 1,
            hdr_histogram: make_hdr_bytes(&[15_000, 25_000]),
            status_counts: r#"{"200":1,"500":1}"#.to_string(),
        },
    ];
    insert_batch(db, &metric_rows).await.unwrap();

    (row.id, yaml.to_string())
}

#[tokio::test]
async fn report_endpoint_returns_404_on_unknown_run() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);

    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/api/runs/NOPE/report")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn report_endpoint_returns_bundle_for_seeded_run() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (run_id, scenario_yaml) = seed_run_with_metrics(&db).await;
    let app = make_app(db);

    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/runs/{run_id}/report"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["run"]["id"].as_str().unwrap(), run_id);
    assert_eq!(json["scenario_yaml"].as_str().unwrap(), scenario_yaml);
    assert!(json["summary"]["count"].as_u64().unwrap() > 0);
    let steps = json["steps"].as_array().unwrap();
    assert!(!steps.is_empty());

    // Latency distribution is emitted for a run with recorded samples.
    let latency = &json["latency"];
    assert!(latency.is_object(), "latency present");
    assert_eq!(latency["percentile_curve"].as_array().unwrap().len(), 11);
    assert!(!latency["histogram"].as_array().unwrap().is_empty());

    // Also typed-decode it to catch shape regressions
    let _typed: ReportJson = serde_json::from_value(json).unwrap();
}

/// store → report → HTTP 다리: `build_report_for_run`이 loop_exit 행을 읽어 넘긴다.
#[tokio::test]
async fn report_endpoint_includes_loop_exits() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (run_id, _scenario_yaml) = seed_run_with_metrics(&db).await;
    let row = |bucket: i64, outcome: i64, count: i64, sum: i64| LoopExitRow {
        run_id: run_id.clone(),
        step_id: "loopA".to_string(),
        pass_bucket: bucket,
        outcome,
        count,
        pass_sum: sum,
    };
    insert_loop_exit_batch(&db, &[row(1, 0, 5, 5), row(21, 2, 1, 40)])
        .await
        .unwrap();
    let app = make_app(db);
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/runs/{run_id}/report"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        json["loop_exits"],
        serde_json::json!([{
            "step_id": "loopA", "entered": 6, "passes": 45, "exhausted": 0, "truncated": 1,
            "buckets": [
                {"pass": 1, "completed": 5, "exhausted": 0, "truncated": 0},
                {"pass": null, "completed": 0, "exhausted": 0, "truncated": 1}
            ]
        }])
    );
}

/// E1 Task 5 e2e smoke: run-level `error_kinds` rollup surfaces on the report
/// endpoint. This is store → report → HTTP 다리 검증(gRPC ingest 다리는
/// coordinator.rs의 ingest 테스트가 담당), not a RED-first test — it must be
/// GREEN immediately.
#[tokio::test]
async fn report_endpoint_includes_error_kinds_rollup() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (run_id, _scenario_yaml) = seed_run_with_metrics(&db).await;

    insert_error_kind_batch(
        &db,
        &[ErrorKindRow {
            run_id: run_id.clone(),
            step_id: "stepA".to_string(),
            kind: "connect_refused".to_string(),
            count: 7,
        }],
    )
    .await
    .unwrap();

    let app = make_app(db);

    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/runs/{run_id}/report"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(
        json["error_kinds"],
        serde_json::json!([{"kind": "connect_refused", "count": 7}])
    );
}

/// store → report → HTTP 다리: 계단 run이면 `build_report_for_run`이 초 단위 계수·워커 시작
/// 시각을 읽어 `stair`를 채운다(둘 중 하나라도 안 읽으면 notes 플래그가 선다).
#[tokio::test]
async fn report_endpoint_includes_stair_for_stair_run() {
    use handicap_controller::store::open_loop::{insert_open_loop_seconds, insert_worker_start};
    let db = store::connect("sqlite::memory:").await.unwrap();
    let yaml = "version: 1\nname: stair\nsteps: []\n";
    let mut profile: Profile = serde_json::from_value(serde_json::json!({
        "duration_seconds": 0,
        "max_in_flight": 50,
        "stair": {"targets": [100, 200], "hold_seconds": 20, "ramp_seconds": 1, "discard_seconds": 5}
    }))
    .unwrap();
    handicap_controller::stair::normalize_stair(&mut profile).unwrap();
    sqlx::query(
        "INSERT INTO scenarios(id, name, yaml, created_at, updated_at, version) \
         VALUES('S-stair','stair',?,1,1,1)",
    )
    .bind(yaml)
    .execute(&db)
    .await
    .unwrap();
    let row = store::runs::insert(&db, "S-stair", yaml, &profile, &serde_json::json!({}), None)
        .await
        .unwrap();
    store::runs::set_status(&db, &row.id, RunStatus::Completed, Some(1), Some(2))
        .await
        .unwrap();
    insert_worker_start(&db, &row.id, "w0", 1_000_000)
        .await
        .unwrap();
    // 계단0 측정 초 = ts 1006..1021, 계단1 = 1027..1042. 초마다 목표만큼 완료.
    let ol: Vec<(i64, i64, i64, i64)> = (0..42)
        .map(|o| {
            let t = if o < 21 { 100 } else { 200 };
            (1000 + o, t, t, 0)
        })
        .collect();
    insert_open_loop_seconds(&db, &row.id, "w0", &ol)
        .await
        .unwrap();
    let metric_rows: Vec<MetricRow> = ol
        .iter()
        .map(|&(ts, _, c, _)| MetricRow {
            run_id: row.id.clone(),
            ts_second: ts,
            step_id: "s".to_string(),
            worker_id: "w0".to_string(),
            count: c,
            error_count: 0,
            hdr_histogram: make_hdr_bytes(&[2_000]),
            status_counts: format!(r#"{{"200":{c}}}"#),
        })
        .collect();
    insert_batch(&db, &metric_rows).await.unwrap();

    let resp = make_app(db)
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/runs/{}/report", row.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    let stair = &json["stair"];
    assert_eq!(stair["notes"]["open_loop_unknown"], false);
    assert_eq!(stair["notes"]["t0_estimated"], false);
    assert_eq!(stair["steps"][0]["achieved"], 100.0);
    assert_eq!(stair["steps"][1]["measured_seconds"], 15);
    assert_eq!(stair["headline"]["kind"], "all_ok");
    let _typed: ReportJson = serde_json::from_value(json).unwrap();
}

/// 자동 정지 기록은 status `completed`일 때만 리포트에 싣고 판정 경계를 강제한다 — 경합으로
/// 기록이 남은 aborted run은 기록을 무시한다(spec §4.6).
#[tokio::test]
async fn record_ignored_unless_completed() {
    use handicap_controller::auto_stop::{AutoStopRecord, StopInfo, StopKind};
    use handicap_controller::stair::SaturationStopMode;
    use handicap_controller::store::open_loop::{insert_open_loop_seconds, insert_worker_start};
    let db = store::connect("sqlite::memory:").await.unwrap();
    let yaml = "version: 1\nname: stair\nsteps: []\n";
    let mut profile: Profile = serde_json::from_value(serde_json::json!({
        "duration_seconds": 0,
        "max_in_flight": 50,
        "stair": {"targets": [100, 200], "hold_seconds": 20, "ramp_seconds": 1, "discard_seconds": 5}
    }))
    .unwrap();
    handicap_controller::stair::normalize_stair(&mut profile).unwrap();
    sqlx::query(
        "INSERT INTO scenarios(id, name, yaml, created_at, updated_at, version) \
         VALUES('S-stair','stair',?,1,1,1)",
    )
    .bind(yaml)
    .execute(&db)
    .await
    .unwrap();
    // 계단0에서 멈췄다는 기록(judged_through 0) — 강제되면 계단1은 「일부 실행」.
    let rec = AutoStopRecord {
        stop: Some(StopInfo {
            kind: StopKind::Saturation,
            mode: Some(SaturationStopMode::FirstFail),
            failed_steps: vec![0],
            decided_step: 0,
            judged_through: 0,
            phase: None,
            decided_at_ms: 1_021_000,
            stopped_at_ms: 1_023_000,
            emergency: None,
            slot_limited: false,
        }),
        suspended_seconds: 0,
    };
    let rec_json = serde_json::to_string(&rec).unwrap();
    let mut got = Vec::new();
    for status in [RunStatus::Aborted, RunStatus::Completed] {
        let row = store::runs::insert(&db, "S-stair", yaml, &profile, &serde_json::json!({}), None)
            .await
            .unwrap();
        store::runs::set_status(&db, &row.id, status, Some(1), Some(2))
            .await
            .unwrap();
        sqlx::query("UPDATE runs SET auto_stop_json = ? WHERE id = ?")
            .bind(&rec_json)
            .bind(&row.id)
            .execute(&db)
            .await
            .unwrap();
        insert_worker_start(&db, &row.id, "w0", 1_000_000)
            .await
            .unwrap();
        let ol: Vec<(i64, i64, i64, i64)> = (0..42)
            .map(|o| {
                let t = if o < 21 { 100 } else { 200 };
                (1000 + o, t, t, 0)
            })
            .collect();
        insert_open_loop_seconds(&db, &row.id, "w0", &ol)
            .await
            .unwrap();
        let metric_rows: Vec<MetricRow> = ol
            .iter()
            .map(|&(ts, _, c, _)| MetricRow {
                run_id: row.id.clone(),
                ts_second: ts,
                step_id: "s".to_string(),
                worker_id: "w0".to_string(),
                count: c,
                error_count: 0,
                hdr_histogram: make_hdr_bytes(&[2_000]),
                status_counts: format!(r#"{{"200":{c}}}"#),
            })
            .collect();
        insert_batch(&db, &metric_rows).await.unwrap();
        let resp = make_app(db.clone())
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri(format!("/api/runs/{}/report", row.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap();
        let json: Value = serde_json::from_slice(&body).unwrap();
        got.push(json["stair"].clone());
    }
    let (aborted, completed) = (&got[0], &got[1]);
    assert!(!aborted.as_object().unwrap().contains_key("auto_stop"));
    assert_eq!(aborted["steps"][1]["state"], "ok", "강제 없음");
    assert_eq!(aborted["headline"]["kind"], "all_ok");
    // 대조: completed면 기록을 싣고 계단1을 판정 밖으로 뺀다.
    assert_eq!(completed["auto_stop"], serde_json::to_value(&rec).unwrap());
    assert_eq!(completed["steps"][1]["state"], "partial");
    assert_eq!(completed["steps"][1]["partial"]["seconds"], 2);
    assert_eq!(completed["headline"]["kind"], "ok_then_unmeasured");
}

/// spec §5 재현 모양(M=2500, 60초): (ts offset, launched, completed, dropped) 합계.
fn stall_repro_rows() -> Vec<(i64, i64, i64, i64)> {
    let drops = [
        10, 12, 15, 17, 19, 22, 24, 27, 29, 32, 34, 37, 39, 42, 44, 47, 49, 52,
    ];
    (0..60i64)
        .map(|s| {
            let (l, c, d) = if s == 0 {
                (7014, 7000, 0)
            } else if drops.contains(&s) {
                (6000, 3514, 1000)
            } else if drops.contains(&(s - 1)) {
                (7000, 9486, 0)
            } else {
                match s {
                    55 => (7000, 6014, 0),
                    56 | 57 => (7000, 6500, 0),
                    58 => (7000, 6600, 0),
                    59 => (7000, 9386, 0),
                    _ => (7000, 7000, 0),
                }
            };
            (s, l, c, d)
        })
        .collect()
}

/// 재현 모양을 워커 w0·w1에 반씩 나눠 넣는다(모든 값이 짝수).
async fn insert_stall_repro_seconds(db: &handicap_controller::store::Db, run_id: &str) {
    use handicap_controller::store::open_loop::insert_open_loop_seconds;
    let half: Vec<(i64, i64, i64, i64)> = stall_repro_rows()
        .iter()
        .map(|&(s, l, c, d)| (1000 + s, l / 2, c / 2, d / 2))
        .collect();
    for w in ["w0", "w1"] {
        insert_open_loop_seconds(db, run_id, w, &half)
            .await
            .unwrap();
    }
}

async fn insert_stall_repro_windows(db: &handicap_controller::store::Db, run_id: &str) {
    let rows: Vec<MetricRow> = stall_repro_rows()
        .iter()
        .map(|&(s, _, c, _)| MetricRow {
            run_id: run_id.to_string(),
            ts_second: 1000 + s,
            step_id: "s".to_string(),
            worker_id: "w0".to_string(),
            count: c,
            error_count: 0,
            hdr_histogram: make_hdr_bytes(&[2_000]),
            status_counts: format!(r#"{{"200":{c}}}"#),
        })
        .collect();
    insert_batch(db, &rows).await.unwrap();
}

async fn get_report_json(db: handicap_controller::store::Db, run_id: &str) -> Value {
    let resp = make_app(db)
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/runs/{run_id}/report"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    serde_json::from_slice(&body).unwrap()
}

/// 비계단 open-loop run(목표 7000, M=2500, 60초, 버림 18000)을 만든다.
async fn seed_open_loop_stall_run(db: &handicap_controller::store::Db) -> String {
    let yaml = "version: 1\nname: ol\nsteps: []\n";
    let profile: Profile = serde_json::from_value(serde_json::json!({
        "duration_seconds": 60,
        "target_rps": 7000,
        "max_in_flight": 2500
    }))
    .unwrap();
    sqlx::query(
        "INSERT INTO scenarios(id, name, yaml, created_at, updated_at, version) \
         VALUES('S-ol','ol',?,1,1,1)",
    )
    .bind(yaml)
    .execute(db)
    .await
    .unwrap();
    let row = store::runs::insert(db, "S-ol", yaml, &profile, &serde_json::json!({}), None)
        .await
        .unwrap();
    store::runs::set_status(db, &row.id, RunStatus::Completed, Some(1000), Some(1060))
        .await
        .unwrap();
    sqlx::query("UPDATE runs SET dropped = 18000 WHERE id = ?")
        .bind(&row.id)
        .execute(db)
        .await
        .unwrap();
    insert_stall_repro_windows(db, &row.id).await;
    row.id
}

#[tokio::test]
async fn report_endpoint_marks_stall_for_intermittent_stall() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_open_loop_stall_run(&db).await;
    insert_stall_repro_seconds(&db, &id).await;
    let json = get_report_json(db, &id).await;
    let ins = json["insights"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["kind"] == "load_gen_saturated")
        .expect("load_gen_saturated");
    assert_eq!(ins["cause"], "stall");
    assert!(!ins.as_object().unwrap().contains_key("recommended"));
    assert!(ins.as_object().unwrap().contains_key("typical_in_flight"));
    let can = json["narrative"]["can_claim"].as_array().unwrap();
    assert!(can.iter().any(|c| c == "delivery_interrupted_by_stall"));
    let _typed: ReportJson = serde_json::from_value(json).unwrap();
}

#[tokio::test]
async fn report_endpoint_keeps_slots_without_totals() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_open_loop_stall_run(&db).await;
    let json = get_report_json(db, &id).await;
    let ins = json["insights"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["kind"] == "load_gen_saturated")
        .expect("load_gen_saturated");
    assert_eq!(ins["cause"], "slots");
    let obj = ins.as_object().unwrap();
    assert!(obj.contains_key("recommended"));
    for k in [
        "typical_in_flight",
        "max_in_flight",
        "drop_seconds",
        "measured_seconds",
    ] {
        assert!(!obj.contains_key(k), "{k} must be absent");
    }
    let can = json["narrative"]["can_claim"].as_array().unwrap();
    assert!(can.iter().any(|c| c == "delivery_ceiling_observed"));
    assert!(!can.iter().any(|c| c == "delivery_interrupted_by_stall"));
}

#[tokio::test]
async fn report_endpoint_marks_stall_for_stair_run() {
    use handicap_controller::store::open_loop::insert_worker_start;
    let db = store::connect("sqlite::memory:").await.unwrap();
    let yaml = "version: 1\nname: stair\nsteps: []\n";
    let mut profile: Profile = serde_json::from_value(serde_json::json!({
        "duration_seconds": 0,
        "max_in_flight": 2500,
        "stair": {"targets": [100, 200], "hold_seconds": 20, "ramp_seconds": 1, "discard_seconds": 5}
    }))
    .unwrap();
    handicap_controller::stair::normalize_stair(&mut profile).unwrap();
    sqlx::query(
        "INSERT INTO scenarios(id, name, yaml, created_at, updated_at, version) \
         VALUES('S-stair2','stair',?,1,1,1)",
    )
    .bind(yaml)
    .execute(&db)
    .await
    .unwrap();
    let row = store::runs::insert(
        &db,
        "S-stair2",
        yaml,
        &profile,
        &serde_json::json!({}),
        None,
    )
    .await
    .unwrap();
    store::runs::set_status(&db, &row.id, RunStatus::Completed, Some(1000), Some(1060))
        .await
        .unwrap();
    sqlx::query("UPDATE runs SET dropped = 18000 WHERE id = ?")
        .bind(&row.id)
        .execute(&db)
        .await
        .unwrap();
    insert_worker_start(&db, &row.id, "w0", 1_000_000)
        .await
        .unwrap();
    insert_stall_repro_seconds(&db, &row.id).await;
    insert_stall_repro_windows(&db, &row.id).await;
    let json = get_report_json(db, &row.id).await;
    let ins = json["insights"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["kind"] == "load_gen_saturated")
        .expect("load_gen_saturated");
    assert_eq!(ins["cause"], "stall");
    assert_eq!(ins["typical_in_flight"], 14);
    let _typed: ReportJson = serde_json::from_value(json).unwrap();
}

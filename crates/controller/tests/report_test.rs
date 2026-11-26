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
        steady: None,
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
            failed_hdr_histogram: None,
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
            failed_hdr_histogram: None,
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
            failed_hdr_histogram: None,
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
                failed_hdr_histogram: None,
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
            failed_hdr_histogram: None,
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
    store::runs::set_status(
        db,
        &row.id,
        RunStatus::Completed,
        Some(1_000_000),
        Some(1_060_000),
    )
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
    assert_eq!(ins["typical_in_flight"], 14);
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
    store::runs::set_status(
        &db,
        &row.id,
        RunStatus::Completed,
        Some(1_000_000),
        Some(1_060_000),
    )
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
const T0: i64 = 1_700_000_000_000;

struct SteadySeed {
    profile: Value,
    status: RunStatus,
    ended_ms: i64,
    worker_start: bool,
    seconds: i64,
    slow_until: i64,
    yaml: &'static str,
}

const SETUP_SCENARIO_YAML: &str = "version: 1
name: steady
setup:
  steps:
    - type: http
      id: 01HX0000000000000000000A01
      name: login
      request: { method: POST, url: \"http://x/login\" }
steps: []
";

impl SteadySeed {
    fn closed() -> Self {
        Self {
            profile: serde_json::json!({
                "vus": 2,
                "ramp_up_seconds": 10,
                "duration_seconds": 40,
                "steady": {"ramp_seconds": 10, "hold_seconds": 30, "discard_seconds": 5}
            }),
            status: RunStatus::Completed,
            ended_ms: T0 + 40_000,
            worker_start: true,
            seconds: 40,
            slow_until: 15,
            yaml: "version: 1\nname: steady\nsteps: []\n",
        }
    }

    fn without_steady() -> Self {
        let mut s = Self::closed();
        s.profile = serde_json::json!({
            "vus": 2, "ramp_up_seconds": 10, "duration_seconds": 40
        });
        s
    }
}

/// 앞 `slow_until`초는 느리고 오류가 있고, 나머지는 빠르다. 워커 `w0`.
async fn seed_steady(db: &handicap_controller::store::Db, s: SteadySeed) -> String {
    use handicap_controller::store::open_loop::insert_worker_start;
    let yaml = s.yaml;
    let mut profile: Profile = serde_json::from_value(s.profile).unwrap();
    handicap_controller::steady::normalize_steady(&mut profile).unwrap();
    sqlx::query(
        "INSERT OR IGNORE INTO scenarios(id, name, yaml, created_at, updated_at, version) \
         VALUES('S-steady','steady',?,1,1,1)",
    )
    .bind(yaml)
    .execute(db)
    .await
    .unwrap();
    let row = store::runs::insert(db, "S-steady", yaml, &profile, &serde_json::json!({}), None)
        .await
        .unwrap();
    store::runs::set_status(db, &row.id, s.status, Some(T0), Some(s.ended_ms))
        .await
        .unwrap();
    if s.worker_start {
        insert_worker_start(db, &row.id, "w0", T0).await.unwrap();
    }
    let base = T0 / 1000;
    let metric_rows: Vec<MetricRow> = (0..s.seconds)
        .map(|o| {
            let slow = o < s.slow_until;
            let (count, errors, us, sc) = if slow {
                (2, 1, 500_000, r#"{"200":1,"500":1}"#)
            } else {
                (10, 0, 20_000, r#"{"200":10}"#)
            };
            MetricRow {
                failed_hdr_histogram: None,
                run_id: row.id.clone(),
                ts_second: base + o,
                step_id: "s".to_string(),
                worker_id: "w0".to_string(),
                count,
                error_count: errors,
                hdr_histogram: make_hdr_bytes(&vec![us; count as usize]),
                status_counts: sc.to_string(),
            }
        })
        .collect();
    insert_batch(db, &metric_rows).await.unwrap();
    row.id
}

async fn get_report(db: &handicap_controller::store::Db, uri: &str) -> (StatusCode, Vec<u8>) {
    let resp = make_app(db.clone())
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    let body = axum::body::to_bytes(resp.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    (status, body.to_vec())
}

async fn report_json(db: &handicap_controller::store::Db, uri: &str) -> Value {
    let (st, body) = get_report(db, uri).await;
    assert_eq!(st, StatusCode::OK);
    serde_json::from_slice(&body).unwrap()
}

#[tokio::test]
async fn steady_run_defaults_to_steady_basis() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_steady(&db, SteadySeed::closed()).await;
    let json = report_json(&db, &format!("/api/runs/{id}/report")).await;
    let b = &json["basis"];
    assert_eq!(b["selected"], "steady");
    assert_eq!(b["default"], "steady");
    assert_eq!(b["state"], "measured");
    assert_eq!(b["window"]["measured_seconds"], 25);
    assert_eq!(b["window"]["start_ms"], T0 + 15_000);
    assert_eq!(json["summary"]["duration_seconds"], 25);
    assert!(b["other"]["count"].as_u64().unwrap() > json["summary"]["count"].as_u64().unwrap());
    let _typed: ReportJson = serde_json::from_value(json).unwrap();
}

#[tokio::test]
async fn basis_whole_param_returns_whole_report() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_steady(&db, SteadySeed::closed()).await;
    let json = report_json(&db, &format!("/api/runs/{id}/report?basis=whole")).await;
    assert_eq!(json["basis"]["selected"], "whole");
    assert_eq!(json["basis"]["default"], "steady");
    assert_eq!(json["summary"]["duration_seconds"], 40);
    assert_eq!(json["basis"]["other"]["duration_seconds"], 25);
}

#[tokio::test]
async fn basis_other_has_stats() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_steady(&db, SteadySeed::closed()).await;
    let whole = report_json(&db, &format!("/api/runs/{id}/report?basis=whole")).await;
    let steady = report_json(&db, &format!("/api/runs/{id}/report?basis=steady")).await;
    assert!(steady["summary"]["stats"].is_object());
    assert_eq!(whole["basis"]["other"]["stats"], steady["summary"]["stats"]);
    assert_eq!(steady["basis"]["other"]["stats"], whole["summary"]["stats"]);
}

#[tokio::test]
async fn whole_basis_equals_report_without_steady() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let with = seed_steady(&db, SteadySeed::closed()).await;
    let without = seed_steady(&db, SteadySeed::without_steady()).await;
    let mut a = report_json(&db, &format!("/api/runs/{with}/report?basis=whole")).await;
    let mut b = report_json(&db, &format!("/api/runs/{without}/report")).await;
    for v in [&mut a, &mut b] {
        let o = v.as_object_mut().unwrap();
        o.remove("basis");
        o.remove("run");
    }
    assert_eq!(a, b);
}

#[tokio::test]
async fn run_without_steady_has_no_basis_key() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_steady(&db, SteadySeed::without_steady()).await;
    let (st, plain_body) = get_report(&db, &format!("/api/runs/{id}/report")).await;
    assert_eq!(st, StatusCode::OK);
    let v: Value = serde_json::from_slice(&plain_body).unwrap();
    assert!(!v.as_object().unwrap().contains_key("basis"));
    let (st, with_param) = get_report(&db, &format!("/api/runs/{id}/report?basis=steady")).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(plain_body, with_param);
}

#[tokio::test]
async fn invalid_basis_param_is_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let steady = seed_steady(&db, SteadySeed::closed()).await;
    let without = seed_steady(&db, SteadySeed::without_steady()).await;
    for id in [steady, without, "no-such-run".to_string()] {
        let (st, _) = get_report(&db, &format!("/api/runs/{id}/report?basis=x")).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{id}");
    }
}

#[tokio::test]
async fn aborted_before_window_falls_back_to_whole() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let mut s = SteadySeed::closed();
    s.status = RunStatus::Aborted;
    s.ended_ms = T0 + 8_000;
    let id = seed_steady(&db, s).await;
    let json = report_json(&db, &format!("/api/runs/{id}/report?basis=steady")).await;
    let b = json["basis"].as_object().unwrap();
    assert_eq!(b["selected"], "whole");
    assert_eq!(b["default"], "whole");
    assert_eq!(b["state"], "not_reached");
    assert!(b["window"].is_null());
    assert!(b.contains_key("other") && b["other"].is_null());
}

#[tokio::test]
async fn completed_run_that_ended_early_is_measured_up_to_ended_at() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let mut s = SteadySeed::closed();
    s.ended_ms = T0 + 25_000;
    s.seconds = 25;
    let id = seed_steady(&db, s).await;
    let json = report_json(&db, &format!("/api/runs/{id}/report")).await;
    assert_eq!(json["basis"]["state"], "measured");
    assert_eq!(json["basis"]["window"]["measured_seconds"], 10);
    assert_eq!(json["basis"]["window"]["end_ms"], T0 + 25_000);
    assert_eq!(json["summary"]["duration_seconds"], 10);
}

#[tokio::test]
async fn aborted_mid_window_is_partial() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let mut s = SteadySeed::closed();
    s.status = RunStatus::Aborted;
    s.ended_ms = T0 + 25_000;
    s.profile["criteria"] = serde_json::json!({"max_p95_ms": 1000});
    let id = seed_steady(&db, s).await;
    let json = report_json(&db, &format!("/api/runs/{id}/report")).await;
    assert_eq!(json["basis"]["state"], "partial");
    assert_eq!(json["basis"]["window"]["measured_seconds"], 10);
    assert!(!json.as_object().unwrap().contains_key("verdict"));
}

#[tokio::test]
async fn start_time_missing_sets_estimated() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let mut s = SteadySeed::closed();
    s.worker_start = false;
    let id = seed_steady(&db, s).await;
    let json = report_json(&db, &format!("/api/runs/{id}/report")).await;
    assert_eq!(json["basis"]["t0_estimated"], true);
    assert_eq!(json["basis"]["state"], "measured");
}

fn open_steady_seed() -> SteadySeed {
    let mut s = SteadySeed::closed();
    s.profile = serde_json::json!({
        "max_in_flight": 50,
        "steady": {"ramp_seconds": 10, "hold_seconds": 30, "discard_seconds": 5, "target": 10}
    });
    s
}

async fn seed_open_counts(db: &handicap_controller::store::Db, id: &str) {
    use handicap_controller::store::open_loop::insert_open_loop_seconds;
    sqlx::query("UPDATE runs SET dropped = 30 WHERE id = ?")
        .bind(id)
        .execute(db)
        .await
        .unwrap();
    let base = T0 / 1000;
    let rows: Vec<(i64, i64, i64, i64)> = (0..40)
        .map(|o| (base + o, 10, 10, if o < 10 { 3 } else { 0 }))
        .collect();
    insert_open_loop_seconds(db, id, "w0", &rows).await.unwrap();
}

#[tokio::test]
async fn open_loop_steady_recounts_dropped() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_steady(&db, open_steady_seed()).await;
    seed_open_counts(&db, &id).await;
    let json = report_json(&db, &format!("/api/runs/{id}/report")).await;
    assert_eq!(json["dropped"], 0);
    assert_eq!(json["basis"]["dropped_whole_run"], false);
    let whole = report_json(&db, &format!("/api/runs/{id}/report?basis=whole")).await;
    assert_eq!(whole["dropped"], 30);
}

#[tokio::test]
async fn open_loop_steady_without_second_counts_marks_whole_run() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_steady(&db, open_steady_seed()).await;
    sqlx::query("UPDATE runs SET dropped = 30 WHERE id = ?")
        .bind(&id)
        .execute(&db)
        .await
        .unwrap();
    let json = report_json(&db, &format!("/api/runs/{id}/report")).await;
    assert_eq!(json["basis"]["dropped_whole_run"], true);
    assert_eq!(json["dropped"], 30);
}

#[tokio::test]
async fn open_loop_whole_basis_equals_report_without_steady() {
    use handicap_controller::store::open_loop::insert_open_loop_seconds;
    let db = store::connect("sqlite::memory:").await.unwrap();
    let with = seed_steady(&db, open_steady_seed()).await;
    let mut plain = open_steady_seed();
    plain.profile = serde_json::json!({
        "max_in_flight": 50,
        "stages": [
            {"target": 10, "duration_seconds": 10},
            {"target": 10, "duration_seconds": 30}
        ]
    });
    let without = seed_steady(&db, plain).await;
    let base = T0 / 1000;
    let second_worker: Vec<(i64, i64, i64, i64)> = (0..40)
        .map(|o| (base + o, 4, 3, if o % 7 == 0 { 2 } else { 0 }))
        .collect();
    for id in [&with, &without] {
        seed_open_counts(&db, id).await;
        insert_open_loop_seconds(&db, id, "w1", &second_worker)
            .await
            .unwrap();
    }
    let mut a = report_json(&db, &format!("/api/runs/{with}/report?basis=whole")).await;
    let mut b = report_json(&db, &format!("/api/runs/{without}/report")).await;
    assert!(
        a["insights"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["kind"] == "load_gen_saturated"),
        "{}",
        a["insights"]
    );
    for v in [&mut a, &mut b] {
        let o = v.as_object_mut().unwrap();
        o.remove("basis");
        o.remove("run");
    }
    assert_eq!(a, b);
}

#[tokio::test]
async fn warmup_copied_from_ramp_is_not_subtracted_twice() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let mut s = SteadySeed::closed();
    s.profile = serde_json::json!({
        "vus": 2,
        "ramp_up_seconds": 30,
        "duration_seconds": 50,
        "steady": {"ramp_seconds": 30, "hold_seconds": 20, "discard_seconds": 0},
        "criteria": {"min_window_rps": 1.0, "rps_warmup_seconds": 30}
    });
    s.ended_ms = T0 + 50_000;
    s.seconds = 50;
    s.slow_until = 0;
    let id = seed_steady(&db, s).await;
    let json = report_json(&db, &format!("/api/runs/{id}/report")).await;
    assert_eq!(json["basis"]["state"], "measured");
    let rows = json["verdict"]["criteria"].as_array().unwrap();
    assert!(
        rows.iter().any(|r| r["metric"] == "min_window_rps"),
        "{rows:?}"
    );
}

#[tokio::test]
async fn exports_use_default_basis() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_steady(&db, SteadySeed::closed()).await;
    let json = report_json(&db, &format!("/api/runs/{id}/report")).await;
    let (st, csv) = get_report(&db, &format!("/api/runs/{id}/report.csv")).await;
    assert_eq!(st, StatusCode::OK);
    let text = String::from_utf8(csv).unwrap();
    let row = text.lines().nth(1).unwrap();
    let count = json["steps"][0]["count"].as_u64().unwrap();
    assert_eq!(row.split(',').nth(1).unwrap(), count.to_string());
    assert_eq!(count, 250);
}

async fn get_with_headers(
    db: &handicap_controller::store::Db,
    uri: &str,
) -> (StatusCode, Option<String>, Vec<u8>) {
    let resp = make_app(db.clone())
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    let disposition = resp
        .headers()
        .get(axum::http::header::CONTENT_DISPOSITION)
        .map(|v| v.to_str().unwrap().to_string());
    let body = axum::body::to_bytes(resp.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    (status, disposition, body.to_vec())
}

fn disposition_for(id: &str, stem: &str, ext: &str) -> String {
    format!("attachment; filename=\"run-{id}-{stem}.{ext}\"")
}

#[tokio::test]
async fn export_csv_follows_basis_param() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_steady(&db, SteadySeed::closed()).await;
    for basis in ["steady", "whole"] {
        let json = report_json(&db, &format!("/api/runs/{id}/report?basis={basis}")).await;
        let (st, csv) = get_report(&db, &format!("/api/runs/{id}/report.csv?basis={basis}")).await;
        assert_eq!(st, StatusCode::OK);
        let text = String::from_utf8(csv).unwrap();
        let count = json["steps"][0]["count"].as_u64().unwrap();
        assert_eq!(
            text.lines().nth(1).unwrap().split(',').nth(1).unwrap(),
            count.to_string()
        );
    }
    let s = report_json(&db, &format!("/api/runs/{id}/report?basis=steady")).await;
    let w = report_json(&db, &format!("/api/runs/{id}/report?basis=whole")).await;
    assert_ne!(s["steps"][0]["count"], w["steps"][0]["count"]);
}

#[tokio::test]
async fn export_filename_carries_basis_only_for_steady_runs() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_steady(&db, SteadySeed::closed()).await;
    let cases = [
        ("report.csv", "report", "csv"),
        ("report.xlsx", "report", "xlsx"),
        ("report-insights.csv", "insights", "csv"),
    ];
    for (route, kind, ext) in cases {
        let (st, disp, _) =
            get_with_headers(&db, &format!("/api/runs/{id}/{route}?basis=whole")).await;
        assert_eq!(st, StatusCode::OK, "{route}");
        assert_eq!(
            disp.unwrap(),
            disposition_for(&id, &format!("{kind}-whole"), ext)
        );
        let (st, disp, _) = get_with_headers(&db, &format!("/api/runs/{id}/{route}")).await;
        assert_eq!(st, StatusCode::OK, "{route}");
        assert_eq!(
            disp.unwrap(),
            disposition_for(&id, &format!("{kind}-steady"), ext)
        );
    }

    let (plain, _) = seed_run_with_metrics(&db).await;
    for (route, kind, ext) in cases {
        for query in ["", "?basis=steady", "?basis=whole"] {
            let (st, disp, _) =
                get_with_headers(&db, &format!("/api/runs/{plain}/{route}{query}")).await;
            assert_eq!(st, StatusCode::OK, "{route}{query}");
            assert_eq!(disp.unwrap(), disposition_for(&plain, kind, ext));
        }
    }
}

#[tokio::test]
async fn export_basis_steady_falls_back_to_whole_when_not_reached() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let mut s = SteadySeed::closed();
    s.status = RunStatus::Aborted;
    s.ended_ms = T0 + 8_000;
    let id = seed_steady(&db, s).await;
    let (st, disp_s, body_s) =
        get_with_headers(&db, &format!("/api/runs/{id}/report.csv?basis=steady")).await;
    let (st2, disp_w, body_w) =
        get_with_headers(&db, &format!("/api/runs/{id}/report.csv?basis=whole")).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(st2, StatusCode::OK);
    assert_eq!(body_s, body_w);
    assert_eq!(
        disp_s.as_deref(),
        Some(disposition_for(&id, "report-whole", "csv").as_str())
    );
    assert_eq!(disp_s, disp_w);
}

#[tokio::test]
async fn export_invalid_basis_is_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_steady(&db, SteadySeed::closed()).await;
    for route in ["report.csv", "report.xlsx", "report-insights.csv"] {
        let (st, _) = get_report(&db, &format!("/api/runs/{id}/{route}?basis=x")).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{route}");
        let (st, _) = get_report(&db, &format!("/api/runs/no-such-run/{route}?basis=x")).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{route} unknown run");
    }
}

#[tokio::test]
async fn both_reports_are_consistent() {
    use handicap_controller::api::runs::build_reports_for_run;
    use handicap_controller::steady::Basis;
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_steady(&db, SteadySeed::closed()).await;

    let (first, second) = build_reports_for_run(&db, &id, None, None).await.unwrap();
    assert_eq!(first.basis.as_ref().unwrap().selected, Basis::Steady);
    let second = second.expect("steady run has the opposite report");
    let whole = report_json(&db, &format!("/api/runs/{id}/report?basis=whole")).await;
    let steady = report_json(&db, &format!("/api/runs/{id}/report?basis=steady")).await;
    assert_eq!(serde_json::to_value(&second).unwrap(), whole);
    assert_eq!(serde_json::to_value(&first).unwrap(), steady);

    let (first, second) = build_reports_for_run(&db, &id, Some(Basis::Whole), None)
        .await
        .unwrap();
    assert_eq!(first.basis.as_ref().unwrap().selected, Basis::Whole);
    assert_eq!(serde_json::to_value(&first).unwrap(), whole);
    assert_eq!(serde_json::to_value(second.unwrap()).unwrap(), steady);

    let plain = seed_steady(&db, SteadySeed::without_steady()).await;
    let (first, second) = build_reports_for_run(&db, &plain, None, None)
        .await
        .unwrap();
    assert!(second.is_none());
    assert!(first.basis.is_none());
}

#[tokio::test]
async fn both_bases_carry_setup() {
    use handicap_controller::api::runs::build_reports_for_run;
    use handicap_controller::store::section::{
        SectionOutcomeRow, SectionStepRow, insert_section_outcome_batch, insert_section_step_batch,
    };
    let db = store::connect("sqlite::memory:").await.unwrap();
    let mut seed = SteadySeed::closed();
    seed.yaml = SETUP_SCENARIO_YAML;
    let id = seed_steady(&db, seed).await;
    insert_section_step_batch(
        &db,
        &[SectionStepRow {
            run_id: id.clone(),
            worker_id: "w0".into(),
            section: "setup".into(),
            step_id: "01HX0000000000000000000A01".into(),
            count: 2,
            error_count: 1,
            status_counts: r#"{"200":1,"401":1}"#.into(),
            failure_kinds: r#"{"status_assert":1}"#.into(),
            hdr_histogram: make_hdr_bytes(&[30_000, 50_000]),
        }],
    )
    .await
    .unwrap();
    insert_section_outcome_batch(
        &db,
        &[SectionOutcomeRow {
            run_id: id.clone(),
            worker_id: "w0".into(),
            section: "setup".into(),
            ok: 1,
            failed: 1,
            interrupted: 0,
            last_done_ms: T0 + 500,
        }],
    )
    .await
    .unwrap();

    let (first, second) = build_reports_for_run(&db, &id, None, None).await.unwrap();
    let second = second.expect("steady run has both bases");
    assert!(first.basis.is_some() && second.basis.is_some());
    let a = first.setup.as_ref().expect("selected basis carries setup");
    let b = second.setup.as_ref().expect("other basis carries setup");
    assert_eq!(a, b);
    assert_eq!((a.ok, a.failed, a.interrupted), (1, 1, 0));
    assert_eq!(a.steps[0].count, 2);
    assert!(
        first
            .validity
            .reasons
            .iter()
            .any(|r| r.kind == "setup_failed")
    );
}

async fn seed_setup_outcome(db: &handicap_controller::store::Db, id: &str, last_done_ms: i64) {
    use handicap_controller::store::section::{SectionOutcomeRow, insert_section_outcome_batch};
    insert_section_outcome_batch(
        db,
        &[SectionOutcomeRow {
            run_id: id.to_string(),
            worker_id: "w0".into(),
            section: "setup".into(),
            ok: 1,
            failed: 0,
            interrupted: 0,
            last_done_ms,
        }],
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn closed_loop_steady_window_start_waits_for_setup_done() {
    use handicap_controller::api::runs::build_reports_for_run;
    let db = store::connect("sqlite::memory:").await.unwrap();
    let mut seed = SteadySeed::closed();
    seed.yaml = SETUP_SCENARIO_YAML;
    let id = seed_steady(&db, seed).await;
    // 정해진 시작: T0 + (ramp 10 + discard 5)초. 준비가 그보다 늦게 끝난다.
    seed_setup_outcome(&db, &id, T0 + 25_000).await;
    let (first, _) = build_reports_for_run(&db, &id, None, None).await.unwrap();
    let w = first.basis.unwrap().window.unwrap();
    assert_eq!(w.start_ms, T0 + 25_000);
}

async fn seed_outcome_rows(
    db: &handicap_controller::store::Db,
    id: &str,
    rows: &[(&str, &str, i64)],
) {
    use handicap_controller::store::section::{SectionOutcomeRow, insert_section_outcome_batch};
    for (worker, section, last_done_ms) in rows {
        insert_section_outcome_batch(
            db,
            &[SectionOutcomeRow {
                run_id: id.to_string(),
                worker_id: (*worker).into(),
                section: (*section).into(),
                ok: 1,
                failed: 0,
                interrupted: 0,
                last_done_ms: *last_done_ms,
            }],
        )
        .await
        .unwrap();
    }
}

/// 워커별 최대 → 올림 초. 뒤에 넣은 더 이른 값·0 행은 시작을 당기지 않는다.
#[tokio::test]
async fn steady_window_start_uses_per_worker_max_rounded_up() {
    use handicap_controller::api::runs::build_reports_for_run;
    let db = store::connect("sqlite::memory:").await.unwrap();
    let mut seed = SteadySeed::closed();
    seed.yaml = SETUP_SCENARIO_YAML;
    let id = seed_steady(&db, seed).await;
    seed_outcome_rows(
        &db,
        &id,
        &[
            ("w0", "setup", T0 + 25_400),
            ("w0", "setup", T0 + 18_000),
            ("w0", "setup", 0),
        ],
    )
    .await;
    let (first, _) = build_reports_for_run(&db, &id, None, None).await.unwrap();
    let w = first.basis.unwrap().window.unwrap();
    assert_eq!(w.start_ms, T0 + 26_000);
}

/// 준비가 아닌 구간 글자의 행은 유지 구간 시작을 밀지 않는다.
#[tokio::test]
async fn steady_window_start_ignores_other_section_rows() {
    use handicap_controller::api::runs::build_reports_for_run;
    let db = store::connect("sqlite::memory:").await.unwrap();
    let mut seed = SteadySeed::closed();
    seed.yaml = SETUP_SCENARIO_YAML;
    let id = seed_steady(&db, seed).await;
    seed_outcome_rows(
        &db,
        &id,
        &[("w0", "setup", T0 + 1_000), ("w0", "teardown", T0 + 25_000)],
    )
    .await;
    let (first, _) = build_reports_for_run(&db, &id, None, None).await.unwrap();
    let w = first.basis.unwrap().window.unwrap();
    assert_eq!(w.start_ms, T0 + 15_000);
}

/// VU 곡선 run은 유지 구간과 함께 만들 수 없다(`normalize_steady`가 거부). 저장된 행이 둘을
/// 함께 가져도 준비 완료 시각은 시작을 밀지 않는다.
#[tokio::test]
async fn vu_curve_steady_window_start_ignores_setup_done() {
    use handicap_controller::api::runs::build_reports_for_run;
    let mut curve: Profile = serde_json::from_value(serde_json::json!({
        "vus": 0,
        "ramp_up_seconds": 0,
        "duration_seconds": 0,
        "vu_stages": [{"target": 2, "duration_seconds": 40}],
        "steady": {"ramp_seconds": 10, "hold_seconds": 30, "discard_seconds": 5}
    }))
    .unwrap();
    assert!(handicap_controller::steady::normalize_steady(&mut curve).is_err());

    let db = store::connect("sqlite::memory:").await.unwrap();
    let mut seed = SteadySeed::closed();
    seed.yaml = SETUP_SCENARIO_YAML;
    let id = seed_steady(&db, seed).await;
    sqlx::query(
        "UPDATE runs SET profile_json = json_set(profile_json, '$.vu_stages', \
         json('[{\"target\":2,\"duration_seconds\":40}]')) WHERE id = ?",
    )
    .bind(&id)
    .execute(&db)
    .await
    .unwrap();
    seed_outcome_rows(&db, &id, &[("w0", "setup", T0 + 25_400)]).await;
    let (first, _) = build_reports_for_run(&db, &id, None, None).await.unwrap();
    let w = first.basis.unwrap().window.unwrap();
    assert_eq!(w.start_ms, T0 + 15_000);
}

#[tokio::test]
async fn open_loop_steady_window_start_ignores_setup_done() {
    use handicap_controller::api::runs::build_reports_for_run;
    let db = store::connect("sqlite::memory:").await.unwrap();
    let mut seed = open_steady_seed();
    seed.yaml = SETUP_SCENARIO_YAML;
    let id = seed_steady(&db, seed).await;
    seed_open_counts(&db, &id).await;
    seed_setup_outcome(&db, &id, T0 + 25_000).await;
    let (first, _) = build_reports_for_run(&db, &id, None, None).await.unwrap();
    let w = first.basis.unwrap().window.unwrap();
    assert_eq!(w.start_ms, T0 + 15_000);
}

#[tokio::test]
async fn unreadable_scenario_yaml_has_no_setup_block() {
    use handicap_controller::api::runs::build_reports_for_run;
    let db = store::connect("sqlite::memory:").await.unwrap();
    let mut seed = SteadySeed::closed();
    seed.yaml = "{{{ not yaml";
    let id = seed_steady(&db, seed).await;
    seed_setup_outcome(&db, &id, T0 + 25_000).await;
    let (first, _) = build_reports_for_run(&db, &id, None, None).await.unwrap();
    assert!(first.setup.is_none());
}

#[tokio::test]
async fn no_setup_scenario_ignores_stored_section_rows() {
    use handicap_controller::api::runs::build_reports_for_run;
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_steady(&db, SteadySeed::closed()).await;
    seed_setup_outcome(&db, &id, T0 + 25_000).await;
    let (first, _) = build_reports_for_run(&db, &id, None, None).await.unwrap();
    assert!(first.setup.is_none());
    assert_eq!(first.basis.unwrap().window.unwrap().start_ms, T0 + 15_000);
}

#[tokio::test]
async fn no_setup_run_has_no_setup_block() {
    use handicap_controller::api::runs::build_reports_for_run;
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_steady(&db, SteadySeed::closed()).await;
    let (first, second) = build_reports_for_run(&db, &id, None, None).await.unwrap();
    assert!(first.setup.is_none());
    assert!(second.unwrap().setup.is_none());
    let v = serde_json::to_value(&first).unwrap();
    assert!(!v.as_object().unwrap().contains_key("setup"));
}

#[tokio::test]
async fn xlsx_route_carries_both_bases() {
    use calamine::{Data, Reader, Xlsx, open_workbook_from_rs};
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_steady(&db, SteadySeed::closed()).await;
    let steady = report_json(&db, &format!("/api/runs/{id}/report?basis=steady")).await;
    let whole = report_json(&db, &format!("/api/runs/{id}/report?basis=whole")).await;
    let steady_count = steady["steps"][0]["count"].as_u64().unwrap() as f64;
    let whole_count = whole["steps"][0]["count"].as_u64().unwrap() as f64;
    assert_ne!(steady_count, whole_count);

    let (st, bytes) = get_report(&db, &format!("/api/runs/{id}/report.xlsx?basis=whole")).await;
    assert_eq!(st, StatusCode::OK);
    let mut wb: Xlsx<std::io::Cursor<Vec<u8>>> =
        open_workbook_from_rs(std::io::Cursor::new(bytes)).unwrap();
    let summary = wb.worksheet_range("Summary").unwrap();
    assert_eq!(
        summary.get_value((15, 0)),
        Some(&Data::String("basis".into()))
    );
    assert_eq!(
        summary.get_value((15, 1)),
        Some(&Data::String("whole".into()))
    );
    let other = wb.worksheet_range("Other basis").unwrap();
    assert_eq!(
        other.get_value((0, 1)),
        Some(&Data::String("steady".into()))
    );
    let steps = wb.worksheet_range("Steps").unwrap();
    assert_eq!(steps.get_value((1, 1)), Some(&Data::Float(whole_count)));
    assert_eq!(other.get_value((16, 1)), Some(&Data::Float(steady_count)));
}

/// 통과한 요청 4건(40 ms)과 실패한 요청 6건(2 ms)이 섞인 run. `split`이면 실패 칸을 채운다.
async fn seed_sample_run(db: &handicap_controller::store::Db, split: bool) -> String {
    let mut seed = SteadySeed::without_steady();
    seed.seconds = 0;
    let id = seed_steady(db, seed).await;
    let mut all = vec![40_000_u64; 4];
    all.extend(vec![2_000_u64; 6]);
    let rows: Vec<MetricRow> = (0..2)
        .map(|o| MetricRow {
            failed_hdr_histogram: split.then(|| make_hdr_bytes(&[2_000; 6])),
            run_id: id.clone(),
            ts_second: T0 / 1000 + o,
            step_id: "s".to_string(),
            worker_id: "w0".to_string(),
            count: 10,
            error_count: 6,
            hdr_histogram: make_hdr_bytes(&all),
            status_counts: r#"{"200":4,"500":6}"#.to_string(),
        })
        .collect();
    insert_batch(db, &rows).await.unwrap();
    id
}

#[tokio::test]
async fn sample_param_selects_latency_sample() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_sample_run(&db, true).await;
    let base = format!("/api/runs/{id}/report");
    let default = report_json(&db, &base).await;
    assert_eq!(default["sample"]["selected"], "passed");
    assert_eq!(default["sample"]["split"], true);
    let all = report_json(&db, &format!("{base}?sample=all")).await;
    assert_eq!(all["sample"]["selected"], "all");
    assert_ne!(all["summary"]["p50_ms"], default["summary"]["p50_ms"]);
    let failed = report_json(&db, &format!("{base}?sample=failed")).await;
    assert_eq!(failed["sample"]["selected"], "failed");
    let both = report_json(&db, &format!("{base}?sample=all&basis=whole")).await;
    assert_eq!(both["sample"]["selected"], "all");
}

#[tokio::test]
async fn invalid_sample_param_is_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_sample_run(&db, true).await;
    let (st, body) = get_report(&db, &format!("/api/runs/{id}/report?sample=bogus")).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert!(String::from_utf8_lossy(&body).contains("sample"));
}

#[tokio::test]
async fn sample_param_on_unsplittable_run_reports_all() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let id = seed_sample_run(&db, false).await;
    let json = report_json(&db, &format!("/api/runs/{id}/report?sample=passed")).await;
    assert_eq!(
        json["sample"],
        serde_json::json!({"selected": "all", "default": "all", "split": false})
    );
}

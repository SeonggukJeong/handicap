use handicap_controller::store::{
    self,
    runs::{self, Profile, RunStatus},
    scenarios,
};

// Fixed wall-clock millis; mark_orphans_failed only needs SOMETHING comparable.
const NOW_MS: i64 = 1_700_000_000_000;

const SCENARIO_YAML: &str = "version: 1\nname: crash-recovery-fixture\nsteps: []\n";

async fn fresh_db() -> store::Db {
    store::connect("sqlite::memory:")
        .await
        .expect("connect in-memory db")
}

async fn insert_scenario(db: &store::Db) -> String {
    let scenario: handicap_engine::Scenario =
        serde_yaml::from_str(SCENARIO_YAML).expect("parse fixture scenario");
    let row = scenarios::insert(db, &scenario, SCENARIO_YAML)
        .await
        .expect("insert scenario");
    row.id
}

fn profile() -> Profile {
    Profile {
        vus: 1,
        ramp_up_seconds: 0,
        duration_seconds: 1,
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
        worker_count: None,
        apply_scenario_think_time: true,
    }
}

#[tokio::test]
async fn orphan_pending_and_running_become_failed() {
    let db = fresh_db().await;
    let scenario_id = insert_scenario(&db).await;
    let env = serde_json::json!({});

    // Two orphans: one pending (never dispatched), one running (dispatched but mid-flight).
    let pending = runs::insert(
        &db,
        &scenario_id,
        "version: 1\nname: x\nsteps: []\n",
        &profile(),
        &env,
    )
    .await
    .expect("insert pending");
    let running = runs::insert(
        &db,
        &scenario_id,
        "version: 1\nname: x\nsteps: []\n",
        &profile(),
        &env,
    )
    .await
    .expect("insert running");
    runs::set_status(&db, &running.id, RunStatus::Running, Some(NOW_MS), None)
        .await
        .expect("flip to running");

    // Non-orphan controls: one completed, one aborted.
    let completed = runs::insert(
        &db,
        &scenario_id,
        "version: 1\nname: x\nsteps: []\n",
        &profile(),
        &env,
    )
    .await
    .expect("insert completed");
    runs::set_status(
        &db,
        &completed.id,
        RunStatus::Completed,
        Some(NOW_MS),
        Some(NOW_MS + 1_000),
    )
    .await
    .expect("flip to completed");

    let aborted = runs::insert(
        &db,
        &scenario_id,
        "version: 1\nname: x\nsteps: []\n",
        &profile(),
        &env,
    )
    .await
    .expect("insert aborted");
    runs::mark_aborted(&db, &aborted.id)
        .await
        .expect("mark aborted");

    let n = runs::mark_orphans_failed(&db, "controller restarted while run was in progress")
        .await
        .expect("mark_orphans_failed");
    assert_eq!(n, 2, "expected the two orphans to be flipped");

    // Verify orphans flipped to failed with the message + ended_at set.
    let p = runs::get(&db, &pending.id).await.unwrap().unwrap();
    assert_eq!(p.status, RunStatus::Failed);
    assert_eq!(
        p.message.as_deref(),
        Some("controller restarted while run was in progress")
    );
    assert!(p.ended_at.is_some(), "pending orphan should have ended_at");

    let r = runs::get(&db, &running.id).await.unwrap().unwrap();
    assert_eq!(r.status, RunStatus::Failed);
    assert_eq!(
        r.message.as_deref(),
        Some("controller restarted while run was in progress")
    );
    assert!(r.ended_at.is_some(), "running orphan should have ended_at");

    // Non-orphans untouched (status + message preserved).
    let c = runs::get(&db, &completed.id).await.unwrap().unwrap();
    assert_eq!(c.status, RunStatus::Completed);
    assert!(c.message.is_none());

    let a = runs::get(&db, &aborted.id).await.unwrap().unwrap();
    assert_eq!(a.status, RunStatus::Aborted);
    assert!(a.message.is_none());
}

#[tokio::test]
async fn second_call_is_noop_if_no_orphans_remain() {
    let db = fresh_db().await;
    let scenario_id = insert_scenario(&db).await;
    let env = serde_json::json!({});

    let pending = runs::insert(
        &db,
        &scenario_id,
        "version: 1\nname: x\nsteps: []\n",
        &profile(),
        &env,
    )
    .await
    .expect("insert pending");

    // First call recovers the orphan.
    let n1 = runs::mark_orphans_failed(&db, "controller restarted while run was in progress")
        .await
        .expect("first mark");
    assert_eq!(n1, 1);

    let p = runs::get(&db, &pending.id).await.unwrap().unwrap();
    assert_eq!(p.status, RunStatus::Failed);

    // Second call sees no orphans and updates nothing.
    let n2 = runs::mark_orphans_failed(&db, "controller restarted while run was in progress")
        .await
        .expect("second mark");
    assert_eq!(n2, 0);
}

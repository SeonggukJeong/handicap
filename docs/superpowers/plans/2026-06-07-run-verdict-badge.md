# Run verdict 영속화 + pass/fail 배지 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 종료(Completed) run의 SLO verdict를 완료 시점에 계산·영속화하고, run 목록·스케줄 이벤트 타임라인·run 상세 헤더에 PASS/FAIL/— 배지로 노출한다.

**Architecture:** 코디네이터의 단일 finalization 지점(`Finalize::Completed`)에서 기존 `build_report_for_run`을 재사용해 verdict를 추출, 새 nullable 컬럼 `runs.verdict_json`(migration 0012, Rust-guarded)에 저장. read-path(`RunRow`·schedule events JOIN)가 verdict를 실어 API로 내보내고, UI는 기존 `VerdictSchema`(`.nullish()`)로 받아 공유 `<VerdictBadge>`를 세 표면에 렌더. **엔진·워커·proto 무변경.**

**Tech Stack:** Rust(controller: axum + sqlx/SQLite + tonic), TypeScript/React(Vite + Zod + React Query), 기존 A4a verdict(ADR-0028) 재사용.

**Spec:** `docs/superpowers/specs/2026-06-07-run-verdict-badge-design.md`

---

## 모든 Task 공통 규칙 (반드시 숙지)

- **각 Task = 단일 green 커밋.** pre-commit 훅이 비-`.md` 커밋마다 전체 workspace(`cargo build/clippy/test --workspace`)를 돌린다. RED 테스트 단독·미사용(dead-code) 헬퍼 단독 커밋은 게이트에서 막히므로 **로컬에서 RED→GREEN 확인하되 커밋은 task 끝에 1회**.
- **커밋 전 warm build**: `cargo build -p handicap-worker --bin worker && cargo build --workspace` (cold-build e2e flake 회피). 그 다음 `git commit`을 **foreground 단일 호출**(파이프 금지 — exit code 마스킹). 커밋 후 `git log -1 --oneline`로 landed 확인.
- **TDD guard**: 이 계획이 만지는 Rust src 파일(`store/mod.rs`/`store/runs.rs`/`report.rs`/`api/runs.rs`/`grpc/coordinator.rs`/`store/schedules.rs`/`api/schedules.rs`)은 전부 디스크에 인라인 `#[cfg(test)] mod tests`가 이미 있어 편집이 자동 통과한다. UI는 각 task가 먼저 `*.test.tsx`를 만든다(self-unblock).
- **UI task 커밋 전**: `cd ui && pnpm lint && pnpm test && pnpm build`(`tsc -b`까지) — `.nullish()` 누출·exhaustive-deps는 `tsc -b`/lint에서만 잡힌다.
- **타입 위치**: `Verdict`/`CriterionResult`는 `crate::report`에 정의됨(`report.rs:127`/`:133`), 현재 `Serialize+Deserialize+PartialEq` 파생 — **T2 Step 5a에서 `Clone` 추가**(T4의 `ScheduleEventRow #[derive(Clone)]`가 요구).
- **clippy `-D warnings`**: 테스트 코드(`--all-targets`)도 린트된다 — `let mut x = Default::default(); x.f = …`는 `field_reassign_with_default`로 거부(구조체-업데이트 `..Default::default()` 사용); `Some(&string)`을 `Option<&str>` 파라미터에 넘기지 말 것(`.as_str()`).

---

## Task 1: Migration 0012 — `runs.verdict_json` 컬럼

**Files:**
- Modify: `crates/controller/src/store/mod.rs` (새 가드 fn + `connect()` 배선 + 2 테스트)

`runs.dropped`(0009)와 동형의 Rust-guarded `ALTER TABLE ADD COLUMN`. **별도 `.sql` 파일 없음.**

- [ ] **Step 1: connect-applies 회귀 테스트 작성 (RED)**

`crates/controller/src/store/mod.rs`의 `#[cfg(test)] mod tests` 안(기존 `connect_applies_runs_dropped_migration` 옆)에 추가:

```rust
    #[tokio::test]
    async fn connect_applies_runs_verdict_json_migration() {
        let pool = connect("sqlite::memory:").await.expect("connect");
        let has: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name = 'verdict_json'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(has, 1, "connect() must apply migration 0012 (verdict_json column)");
    }

    #[tokio::test]
    async fn ensure_runs_verdict_json_is_idempotent() {
        let pool = connect("sqlite::memory:").await.expect("connect");
        // connect() already added it once; calling the guard again must be a no-op.
        ensure_runs_verdict_json(&pool).await.expect("idempotent");
        let has: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name = 'verdict_json'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(has, 1, "guard must not duplicate the column");
    }
```

- [ ] **Step 2: 테스트 실패 확인 (RED)**

Run: `cargo test -p handicap-controller store::tests::connect_applies_runs_verdict_json_migration 2>&1 | tail -20`
Expected: 컴파일 에러(`ensure_runs_verdict_json` 미정의) 또는 실패.

- [ ] **Step 3: 가드 fn 추가**

`crates/controller/src/store/mod.rs`에서 `ensure_runs_dropped`(line 140) 바로 아래에:

```rust
/// migration 0012: runs.verdict_json (nullable). A4a SLO verdict를 완료 시점에
/// 영속화해 목록/타임라인 배지에 쓴다. dropped(0009) 가드와 동형 — ADD COLUMN은
/// SQLite에서 멱등이 아니므로 pragma로 가드. 별도 .sql 파일 없음.
async fn ensure_runs_verdict_json(db: &Db) -> anyhow::Result<()> {
    let has: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name = 'verdict_json'",
    )
    .fetch_one(db)
    .await?;
    if has == 0 {
        sqlx::query("ALTER TABLE runs ADD COLUMN verdict_json TEXT")
            .execute(db)
            .await?;
    }
    Ok(())
}
```

- [ ] **Step 4: `connect()`에 배선**

`crates/controller/src/store/mod.rs::connect()`에서 **마지막 마이그레이션 `MIGRATION_SQL_0011` 줄(line 66) 바로 뒤**에 추가(numeric 순서 유지):

```rust
    sqlx::query(MIGRATION_SQL_0011).execute(&pool).await?; // migration 0011: schedules + schedule_events
    ensure_runs_verdict_json(&pool).await?; // migration 0012 (Rust-guarded; see fn)
```

- [ ] **Step 5: 테스트 통과 확인 (GREEN)**

Run: `cargo test -p handicap-controller store::tests::connect_applies_runs_verdict_json_migration store::tests::ensure_runs_verdict_json_is_idempotent 2>&1 | tail -20`
Expected: 2 passed.

- [ ] **Step 6: warm build + 커밋**

```bash
cargo build -p handicap-worker --bin worker && cargo build --workspace
git add crates/controller/src/store/mod.rs
git commit -m "feat(controller): migration 0012 runs.verdict_json (Rust-guarded ALTER)"
git log -1 --oneline
```

---

## Task 2: Read path — `RunRow.verdict` + `RunResponse.verdict`

**Files:**
- Modify: `crates/controller/src/store/runs.rs` (`RunRow` 필드 + `get`/`list_by_scenario` SELECT·매핑 + `insert` 리터럴 + 테스트)
- Modify: `crates/controller/src/report.rs` (`run_row()` 테스트 픽스처 리터럴)
- Modify: `crates/controller/src/api/runs.rs` (`RunResponse` 필드 + `to_response`)

`verdict_json` 컬럼을 읽어 `Option<Verdict>`로 노출. 쓰기(`set_verdict`)·코디네이터 훅은 Task 3.

- [ ] **Step 1: read round-trip 테스트 작성 (RED)**

`crates/controller/src/store/runs.rs`의 `#[cfg(test)] mod tests` 안에 추가(`seed_pending` 헬퍼 재사용):

```rust
    #[tokio::test]
    async fn get_and_list_carry_verdict_json() {
        let db = test_db().await;
        let id = seed_pending(&db).await;
        // 기본은 verdict 없음.
        assert!(get(&db, &id).await.unwrap().unwrap().verdict.is_none());

        // finalize 훅이 쓸 것과 동일한 JSON을 직접 주입(Task 3의 set_verdict 의존 회피).
        let vjson = r#"{"passed":false,"criteria":[{"metric":"p95_ms","direction":"max","threshold":300.0,"actual":420.0,"passed":false}]}"#;
        sqlx::query("UPDATE runs SET verdict_json = ? WHERE id = ?")
            .bind(vjson)
            .bind(&id)
            .execute(&db)
            .await
            .unwrap();

        let got = get(&db, &id).await.unwrap().unwrap();
        let v = got.verdict.as_ref().expect("verdict parsed");
        assert!(!v.passed);
        assert_eq!(v.criteria[0].metric, "p95_ms");
        assert_eq!(v.criteria[0].actual, 420.0);

        // list 경로도 동일하게 싣는다.
        let listed = list_by_scenario(&db, &got.scenario_id).await.unwrap();
        assert!(!listed[0].verdict.as_ref().unwrap().passed);

        // 손상 JSON → None(관대, 목록 안 깨짐).
        sqlx::query("UPDATE runs SET verdict_json = 'not json' WHERE id = ?")
            .bind(&id)
            .execute(&db)
            .await
            .unwrap();
        assert!(get(&db, &id).await.unwrap().unwrap().verdict.is_none());
    }
```

- [ ] **Step 2: 테스트 실패 확인 (RED)**

Run: `cargo test -p handicap-controller store::runs::tests::get_and_list_carry_verdict_json 2>&1 | tail -20`
Expected: 컴파일 에러(`RunRow`에 `verdict` 필드 없음).

- [ ] **Step 3: `RunRow`에 필드 추가**

`crates/controller/src/store/runs.rs`의 `pub struct RunRow`(line 128)에 `dropped` 다음 줄로:

```rust
    pub dropped: i64,
    /// A4a SLO verdict, 완료 시 영속(없으면/criteria 없으면 None). 손상 JSON도 None.
    pub verdict: Option<crate::report::Verdict>,
```

- [ ] **Step 4: `insert` 리터럴 + `get`/`list_by_scenario` SELECT·매핑 갱신**

(a) `insert`(line 166)의 `Ok(RunRow { … })` 리터럴에 `dropped: 0,` 다음:
```rust
        dropped: 0,
        verdict: None,
```

(b) `get`(line 183) SELECT 문자열에 `verdict_json` 추가 — `…,message,dropped` → `…,message,dropped,verdict_json`:
```rust
        "SELECT id,scenario_id,scenario_yaml,profile_json,env_json,status,started_at,ended_at,created_at,message,dropped,verdict_json \
         FROM runs WHERE id = ?",
```
그리고 `Ok(Some(RunRow { … }))` 매핑(line 196)의 `dropped: r.get("dropped"),` 다음:
```rust
        dropped: r.get("dropped"),
        verdict: r
            .get::<Option<String>, _>("verdict_json")
            .and_then(|s| serde_json::from_str(&s).ok()),
```
**주의: 인접 `profile_json`/`env_json`은 `.unwrap()`(손상 시 panic)이지만 verdict는 의도적으로 `.ok()`(관대) — 손상 행이 목록 전체를 깨면 안 되므로. `.unwrap()`로 "통일"하지 말 것.**

(c) `list_by_scenario`(line 213) SELECT에도 `verdict_json` 추가(동일하게 `…,dropped,verdict_json`), 매핑(line 227 `out.push(RunRow { … })`)의 `dropped: r.get("dropped"),` 다음 동일한 `verdict: r.get::<Option<String>,_>("verdict_json").and_then(|s| serde_json::from_str(&s).ok()),` 추가.

- [ ] **Step 5: `report.rs` — `Verdict`/`CriterionResult`에 `Clone` 파생 + 테스트 픽스처 리터럴 갱신**

(a) **`Clone` 파생 추가 (CRITICAL — Task 4의 `ScheduleEventRow`가 `#[derive(Clone)]`이라 필드 `Option<Verdict>`도 `Clone` 필요).** `crates/controller/src/report.rs`에서:
```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]  // line 127: pub struct Verdict
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]  // line 133: pub struct CriterionResult
```
(둘 다 평범한 데이터 struct라 안전 — 기존 `.clone()` 호출 사이트 없음. T4보다 먼저 들어가야 T4가 컴파일된다.)

(b) `run_row()` 헬퍼(약 line 564)의 `RunRow { … }` 리터럴에 `dropped: 0,`(또는 마지막 필드) 다음 `verdict: None,` 추가(컴파일러가 missing field로 잡는다).

- [ ] **Step 6: `RunResponse` + `to_response` 갱신**

`crates/controller/src/api/runs.rs`의 `pub struct RunResponse`(line 22) `message` 필드 다음:
```rust
    pub message: Option<String>,
    /// A4a SLO verdict(완료 run, criteria 있을 때만 non-null). 목록 배지용.
    pub verdict: Option<crate::report::Verdict>,
```
`to_response`(line 613)의 `message: r.message,` 다음:
```rust
        message: r.message,
        verdict: r.verdict,
```

- [ ] **Step 7: 테스트 통과 확인 (GREEN)**

Run: `cargo test -p handicap-controller store::runs::tests::get_and_list_carry_verdict_json 2>&1 | tail -20`
Expected: 1 passed. (그리고 `cargo build --workspace`가 `report.rs`/`api/runs.rs` 리터럴까지 클린.)

- [ ] **Step 8: warm build + 커밋**

```bash
cargo build -p handicap-worker --bin worker && cargo build --workspace
git add crates/controller/src/store/runs.rs crates/controller/src/report.rs crates/controller/src/api/runs.rs
git commit -m "feat(controller): RunRow/RunResponse가 verdict_json read-path로 verdict 노출"
git log -1 --oneline
```

---

## Task 3: Write path — `set_verdict` + 코디네이터 finalize 훅

**Files:**
- Modify: `crates/controller/src/store/runs.rs` (`set_verdict` fn)
- Modify: `crates/controller/src/grpc/coordinator.rs` (`Finalize::Completed` arm + 테스트)

완료 시점에 `build_report_for_run`으로 verdict를 추출해 영속화. fail-soft.

- [ ] **Step 1: 코디네이터 finalize 테스트 작성 (RED)**

`crates/controller/src/grpc/coordinator.rs`의 `#[cfg(test)] mod tests`에 추가. 먼저 criteria 있는 run을 seed하는 헬퍼(기존 `seed_run` 미러):

```rust
    /// criteria가 있는 run을 seed(메트릭 없음 → p95=0 <= 큰 임계 → verdict passed=true).
    async fn seed_run_with_criteria(db: &Db) -> String {
        let scenario_yaml = "version: 1\nname: t\nsteps: []\n";
        let sc: handicap_engine::Scenario = serde_yaml::from_str(scenario_yaml).unwrap();
        let scenario = crate::store::scenarios::insert(db, &sc, scenario_yaml)
            .await
            .unwrap();
        // 구조체-업데이트 구문(field-reassign-with-default clippy lint 회피 — pre-commit
        // 의 clippy -D warnings가 `let mut x = default(); x.f = …`를 거부한다).
        let criteria = crate::store::runs::Criteria {
            max_p95_ms: Some(100_000),
            ..Default::default()
        };
        let profile = runs::Profile {
            vus: 4,
            ramp_up_seconds: 0,
            duration_seconds: 1,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            data_binding: None,
            criteria: Some(criteria),
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
        };
        runs::insert(db, &scenario.id, scenario_yaml, &profile, &serde_json::json!({}))
            .await
            .unwrap()
            .id
    }

    #[tokio::test]
    async fn finalize_completed_persists_verdict_for_criteria_run() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run_with_criteria(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord.enqueue(run_id.clone(), base_assignment(), 1, 4).await;
        let (tx0, _r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord
            .record_phase(&run_id, "w0", pb::run_status::Phase::Completed as i32)
            .await;
        let row = runs::get(&db, &run_id).await.unwrap().unwrap();
        assert_eq!(row.status, RunStatus::Completed);
        let v = row.verdict.expect("verdict persisted at finalize");
        assert!(v.passed, "no metrics → p95=0 <= 100000 → passed");
        assert_eq!(v.criteria.len(), 1);
    }

    #[tokio::test]
    async fn finalize_completed_no_criteria_leaves_verdict_null() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await; // criteria: None
        let coord = CoordinatorState::new(db.clone());
        coord.enqueue(run_id.clone(), base_assignment(), 1, 4).await;
        let (tx0, _r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord
            .record_phase(&run_id, "w0", pb::run_status::Phase::Completed as i32)
            .await;
        let row = runs::get(&db, &run_id).await.unwrap().unwrap();
        assert_eq!(row.status, RunStatus::Completed);
        assert!(row.verdict.is_none(), "no criteria → verdict NULL");
    }

    #[tokio::test]
    async fn finalize_failed_does_not_persist_verdict() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run_with_criteria(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord.enqueue(run_id.clone(), base_assignment(), 1, 4).await;
        let (tx0, _r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord
            .record_phase(&run_id, "w0", pb::run_status::Phase::Failed as i32)
            .await;
        let row = runs::get(&db, &run_id).await.unwrap().unwrap();
        assert_eq!(row.status, RunStatus::Failed);
        assert!(row.verdict.is_none(), "Failed run never gets a verdict");
    }
```

- [ ] **Step 2: 테스트 실패 확인 (RED)**

Run: `cargo test -p handicap-controller grpc::coordinator::tests::finalize_completed_persists_verdict_for_criteria_run 2>&1 | tail -20`
Expected: 실패(verdict가 None — 훅 미구현) 또는 컴파일 에러(`set_verdict` 미정의).

- [ ] **Step 3: `set_verdict` store fn 추가**

`crates/controller/src/store/runs.rs`에 추가(기존 `mark_failed_if_active` 등 인근):

```rust
/// 완료 run의 SLO verdict를 영속(목록/타임라인 배지용 forward-only 캐시).
/// finalization에서 1회 호출. 사라진 run이면 rows_affected==0 무해.
pub async fn set_verdict(db: &Db, id: &str, verdict: &crate::report::Verdict) -> sqlx::Result<()> {
    let json = serde_json::to_string(verdict).expect("serialize verdict");
    sqlx::query("UPDATE runs SET verdict_json = ? WHERE id = ?")
        .bind(json)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}
```

- [ ] **Step 4: `Finalize::Completed` arm에 훅 삽입**

`crates/controller/src/grpc/coordinator.rs`의 `Finalize::Completed` arm(line 357)을:

```rust
            Finalize::Completed => {
                let _ = runs::set_status(
                    &self.db,
                    run_id,
                    RunStatus::Completed,
                    None,
                    Some(crate::store::now_ms()),
                )
                .await;
                // 목록/타임라인 배지용 verdict 영속(forward-only 캐시). on-demand /report
                // verdict와 동일 — 같은 evaluate_criteria를 동일한 완료-후 불변 메트릭에 적용.
                // fail-soft: 리포트 빌드 실패는 finalize를 막지 않는다(run은 이미 Completed).
                if let Ok(report) = crate::api::runs::build_report_for_run(&self.db, run_id).await {
                    if let Some(verdict) = &report.verdict {
                        let _ = runs::set_verdict(&self.db, run_id, verdict).await;
                    }
                }
                self.cleanup_dispatcher(run_id).await;
            }
```

(`build_report_for_run`은 `pub async fn`(`api/runs.rs:401`), 반환 `Result<ReportJson, ApiError>`, `ReportJson.verdict: Option<Verdict>`.)

- [ ] **Step 5: 테스트 통과 확인 (GREEN)**

Run: `cargo test -p handicap-controller grpc::coordinator::tests::finalize_completed 2>&1 | tail -25`
Expected: `finalize_completed_persists_verdict_for_criteria_run`·`finalize_completed_no_criteria_leaves_verdict_null`·`finalize_failed_does_not_persist_verdict` + 기존 `finalize_*` 전부 passed.

- [ ] **Step 6: warm build + 커밋**

```bash
cargo build -p handicap-worker --bin worker && cargo build --workspace
git add crates/controller/src/store/runs.rs crates/controller/src/grpc/coordinator.rs
git commit -m "feat(controller): 완료 시 verdict 영속(코디네이터 Finalize::Completed 훅, fail-soft)"
git log -1 --oneline
```

---

## Task 4: 스케줄 이벤트 타임라인에 verdict (LEFT JOIN)

**Files:**
- Modify: `crates/controller/src/store/schedules.rs` (`ScheduleEventRow` 필드 + `recent_events` JOIN·매핑 + 테스트)
- Modify: `crates/controller/src/api/schedules.rs` (`EventResponse` 필드 + `events` 매핑)

fired 이벤트의 run verdict를 read-time JOIN으로 해석.

- [ ] **Step 1: recent_events JOIN 테스트 작성 (RED)**

`crates/controller/src/store/schedules.rs`의 `#[cfg(test)] mod tests`에 추가(`seed_scenario`·`profile` 헬퍼 재사용):

```rust
    #[tokio::test]
    async fn recent_events_resolves_run_verdict() {
        use crate::store::runs;
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sid = seed_scenario(&db).await;
        let env: BTreeMap<String, String> = BTreeMap::new();
        let sched = insert(
            &db, "s", &sid, &profile(), &env,
            &Trigger::Cron { expr: "0 2 * * *".into() }, true, None,
        )
        .await
        .unwrap();

        // 완료 run + verdict.
        let run = runs::insert(&db, &sid, "version: 1\nname: t\nsteps: []\n", &profile(), &serde_json::json!({}))
            .await
            .unwrap();
        let v = crate::report::Verdict {
            passed: true,
            criteria: vec![crate::report::CriterionResult {
                metric: "p95_ms".into(),
                direction: "max".into(),
                threshold: 300.0,
                actual: 120.0,
                passed: true,
            }],
        };
        runs::set_verdict(&db, &run.id, &v).await.unwrap();

        // insert_event의 run_id는 Option<&str> — Some(&run.id)는 Option<&String>이라 타입 불일치.
        insert_event(&db, &sched.id, 1, "fired", Some(run.id.as_str()), None).await.unwrap();
        insert_event(&db, &sched.id, 2, "skipped_overlap", None, Some("overlap")).await.unwrap();

        let evs = recent_events(&db, &sched.id, 100).await.unwrap();
        // at DESC 정렬 → skipped(2) 먼저, fired(1) 다음.
        let fired = evs.iter().find(|e| e.kind == "fired").unwrap();
        assert!(fired.verdict.as_ref().unwrap().passed, "fired run verdict resolved");
        let skipped = evs.iter().find(|e| e.kind == "skipped_overlap").unwrap();
        assert!(skipped.verdict.is_none(), "no run_id → no verdict");
    }
```

- [ ] **Step 2: 테스트 실패 확인 (RED)**

Run: `cargo test -p handicap-controller store::schedules::tests::recent_events_resolves_run_verdict 2>&1 | tail -20`
Expected: 컴파일 에러(`ScheduleEventRow`에 `verdict` 없음).

- [ ] **Step 3: `ScheduleEventRow`에 필드 + `recent_events` JOIN·매핑**

(a) `crates/controller/src/store/schedules.rs`의 `pub struct ScheduleEventRow`(line 50) `detail` 다음:
```rust
    pub detail: Option<String>,
    /// 이 이벤트가 발사한 run의 verdict(read-time JOIN, fired·완료 run만 non-null).
    pub verdict: Option<crate::report::Verdict>,
```

(b) `recent_events`(line 292)의 쿼리를 LEFT JOIN으로 — **모든 컬럼 자격(qualify)** 필수(`runs`·`schedule_events` 둘 다 `id` 컬럼이라 unqualified는 모호):
```rust
    let rows = sqlx::query(
        "SELECT schedule_events.id, schedule_events.schedule_id, schedule_events.at, \
                schedule_events.kind, schedule_events.run_id, schedule_events.detail, \
                r.verdict_json \
         FROM schedule_events LEFT JOIN runs r ON r.id = schedule_events.run_id \
         WHERE schedule_events.schedule_id = ? ORDER BY schedule_events.at DESC LIMIT ?",
    )
```
그리고 `.map(|r| ScheduleEventRow { … })` 매핑(line 305)의 `detail: r.get("detail"),` 다음:
```rust
            detail: r.get("detail"),
            verdict: r
                .get::<Option<String>, _>("verdict_json")
                .and_then(|s| serde_json::from_str(&s).ok()),
```

- [ ] **Step 4: `EventResponse` + `events` 핸들러 매핑 갱신**

`crates/controller/src/api/schedules.rs`의 `pub struct EventResponse`(line 104) `detail` 다음:
```rust
    pub detail: Option<String>,
    pub verdict: Option<crate::report::Verdict>,
```
`events` 핸들러의 `.map(|e| EventResponse { … })`(line 283)의 `detail: e.detail,` 다음:
```rust
            detail: e.detail,
            verdict: e.verdict,
```

- [ ] **Step 5: 테스트 통과 확인 (GREEN)**

Run: `cargo test -p handicap-controller store::schedules::tests::recent_events_resolves_run_verdict 2>&1 | tail -20`
Expected: 1 passed.

- [ ] **Step 6: warm build + 커밋**

```bash
cargo build -p handicap-worker --bin worker && cargo build --workspace
git add crates/controller/src/store/schedules.rs crates/controller/src/api/schedules.rs
git commit -m "feat(controller): 스케줄 이벤트가 발사 run verdict를 LEFT JOIN으로 노출"
git log -1 --oneline
```

---

## Task 5: Zod 와이어 — `RunSchema` + `ScheduleEventSchema`에 verdict

**Files:**
- Modify: `ui/src/api/schemas.ts` (`RunSchema`·`ScheduleEventSchema`에 `verdict`)
- Test: `ui/src/api/__tests__/schemas.test.ts` (기존 파일에 케이스 추가 — 없으면 생성)

기존 `VerdictSchema`(schemas.ts:296) 재사용. **`.nullish()`**(서버 `None→null`).

- [ ] **Step 1: 파싱 테스트 작성 (RED)**

`ui/src/api/__tests__/schemas.test.ts`는 **이미 존재**하며 `RunSchema`/`VerdictSchema`를 import한다(line 2–10). **새 import 줄을 추가하지 말고** 기존 import 블록에 `ScheduleEventSchema`만 합칠 것(중복 import는 `no-duplicate-imports` lint·TS 재선언 에러). 그 파일에 케이스 추가:

```ts
describe("verdict wire", () => {
  const baseRun = {
    id: "r1",
    scenario_id: "s1",
    scenario_yaml: "version: 1\nname: t\nsteps: []\n",
    status: "completed" as const,
    profile: { vus: 1, duration_seconds: 1 },
    env: {},
    started_at: null,
    ended_at: null,
    created_at: 1,
  };
  const verdict = {
    passed: false,
    criteria: [{ metric: "p95_ms", direction: "max" as const, threshold: 300, actual: 420, passed: false }],
  };

  it("RunSchema accepts a verdict object", () => {
    expect(RunSchema.parse({ ...baseRun, verdict }).verdict?.passed).toBe(false);
  });
  it("RunSchema accepts verdict null (server None)", () => {
    expect(RunSchema.parse({ ...baseRun, verdict: null }).verdict).toBeNull();
  });
  it("RunSchema accepts absent verdict (backward compat)", () => {
    expect(RunSchema.parse(baseRun).verdict).toBeUndefined();
  });
  it("ScheduleEventSchema accepts verdict + null", () => {
    const ev = { id: "e1", at: 1, kind: "fired", run_id: "r1" };
    expect(ScheduleEventSchema.parse({ ...ev, verdict }).verdict?.passed).toBe(false);
    expect(ScheduleEventSchema.parse({ ...ev, verdict: null }).verdict).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인 (RED)**

Run: `cd ui && pnpm test schemas 2>&1 | tail -20`
Expected: `verdict` 케이스 실패(또는 `.verdict` undefined 단언 외 실패 — RunSchema에 verdict 키 없어 `.strict()` 아니므로 객체 케이스는 그냥 drop돼 `.passed` 접근이 undefined).

- [ ] **Step 3: 스키마에 필드 추가**

`ui/src/api/schemas.ts`:
- `RunSchema`(line 139)의 `message: z.string().nullable().optional(),` 다음:
```ts
  message: z.string().nullable().optional(),
  // A4a SLO verdict, 완료 시 영속(목록 배지). 서버 None→null이라 .nullish().
  verdict: VerdictSchema.nullish(),
```
- `ScheduleEventSchema`(line 124)의 `detail: z.string().nullish(),` 다음:
```ts
  detail: z.string().nullish(),
  verdict: VerdictSchema.nullish(),
```
(`VerdictSchema`는 같은 파일 line 296에 정의돼 있으나 `RunSchema`/`ScheduleEventSchema`보다 *뒤*에 선언됨 — `const`는 호이스팅 안 되므로 **`VerdictSchema` 선언을 `RunSchema`보다 앞으로 이동**해야 한다. `CriterionResultSchema`+`VerdictSchema` 블록(line 289–300)을 `ScheduleEventSchema`(line 124) 위로 옮길 것. `ReportSchema`는 여전히 뒤에서 참조하므로 무영향.)

- [ ] **Step 4: 테스트 + 게이트 통과 확인 (GREEN)**

Run: `cd ui && pnpm test schemas 2>&1 | tail -15 && pnpm lint && pnpm build`
Expected: schemas 테스트 pass, lint 0 warning, `tsc -b` 클린(`.nullish()` 누출 없음).

- [ ] **Step 5: warm build(cargo 훅) + 커밋**

```bash
cargo build -p handicap-worker --bin worker && cargo build --workspace
git add ui/src/api/schemas.ts ui/src/api/__tests__/schemas.test.ts
git commit -m "feat(ui): RunSchema/ScheduleEventSchema에 verdict (.nullish, VerdictSchema 재사용)"
git log -1 --oneline
```

---

## Task 6: `<VerdictBadge>` + 세 표면 배선

**Files:**
- Create: `ui/src/components/VerdictBadge.tsx`
- Test: `ui/src/components/__tests__/VerdictBadge.test.tsx`
- Modify: `ui/src/pages/ScenarioRunsPage.tsx` (Verdict 열)
- Modify: `ui/src/components/ScheduleEventTimeline.tsx` (run 링크 옆 배지)
- Modify: `ui/src/pages/RunDetailPage.tsx` (헤더 배지, `report.data?.verdict` 소스)
- Modify: `ui/src/pages/__tests__/ScenarioRunsPage.test.tsx` (verdict 열 렌더 단언)

- [ ] **Step 1: VerdictBadge 테스트 작성 (RED)**

`ui/src/components/__tests__/VerdictBadge.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { VerdictBadge } from "../VerdictBadge";

describe("VerdictBadge", () => {
  it("renders — for null/undefined", () => {
    render(<VerdictBadge verdict={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
  it("renders PASS for passed verdict", () => {
    render(<VerdictBadge verdict={{ passed: true, criteria: [] }} />);
    expect(screen.getByText("PASS")).toBeInTheDocument();
  });
  it("renders FAIL with failed-criteria title", () => {
    render(
      <VerdictBadge
        verdict={{
          passed: false,
          criteria: [
            { metric: "p95_ms", direction: "max", threshold: 300, actual: 420, passed: false },
            { metric: "rps", direction: "min", threshold: 100, actual: 200, passed: true },
          ],
        }}
      />,
    );
    const badge = screen.getByText("FAIL");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("title", "p95_ms 420 > 300");
  });
});
```

- [ ] **Step 2: 테스트 실패 확인 (RED)**

Run: `cd ui && pnpm test VerdictBadge 2>&1 | tail -15`
Expected: FAIL (모듈 없음).

- [ ] **Step 3: VerdictBadge 컴포넌트 작성**

`ui/src/components/VerdictBadge.tsx`:

```tsx
import type { Verdict } from "../api/schemas";

/** 실패한 기준만 "metric actual (>|<) threshold"로 요약(FAIL tooltip). */
function failSummary(v: Verdict): string {
  return v.criteria
    .filter((c) => !c.passed)
    .map((c) => `${c.metric} ${c.actual} ${c.direction === "max" ? ">" : "<"} ${c.threshold}`)
    .join(", ");
}

export function VerdictBadge({ verdict }: { verdict?: Verdict | null }) {
  if (!verdict) return <span className="text-slate-400">—</span>;
  const pass = verdict.passed;
  return (
    <span
      title={pass ? undefined : failSummary(verdict)}
      className={[
        "inline-block rounded px-2 py-0.5 text-xs font-medium",
        pass ? "bg-emerald-200 text-emerald-900" : "bg-red-200 text-red-900",
      ].join(" ")}
    >
      {pass ? "PASS" : "FAIL"}
    </span>
  );
}
```

(`Verdict` 타입은 `ui/src/api/schemas.ts`에서 export됨 — line 300.)

- [ ] **Step 4: 세 표면에 배선**

(a) `ui/src/pages/ScenarioRunsPage.tsx`:
- import 추가: `import { VerdictBadge } from "../components/VerdictBadge";`
- `<thead>`(line 224) "Status" `<th>` 다음에 `<th className="py-2 pr-4 font-medium">결과</th>` 추가.
- 각 행(line 249 Status `<td>`) 다음에:
```tsx
                        <td className="py-3 pr-4">
                          <VerdictBadge verdict={r.verdict} />
                        </td>
```
(기존 `?retry=` effect deps·선택 게이트 로직은 건드리지 말 것 — 이 파일은 exhaustive-deps 함정의 출처.)

(b) `ui/src/components/ScheduleEventTimeline.tsx`:
- import: `import { VerdictBadge } from "./VerdictBadge";`
- run 링크(line 40–44) `</Link>` 다음에:
```tsx
              {e.run_id && <VerdictBadge verdict={e.verdict} />}
```

(c) `ui/src/pages/RunDetailPage.tsx`:
- import: `import { VerdictBadge } from "../components/VerdictBadge";`
- 헤더 `<StatusBadge status={r.status} />`(line 100) 다음에:
```tsx
            <StatusBadge status={r.status} />
            <VerdictBadge verdict={report.data?.verdict} />
```
(report fetch는 post-mount async라 종료 직후 잠깐 "—" 후 채워짐 — 정상.)

- [ ] **Step 5: ScenarioRunsPage 표면 렌더 단언 추가**

`ui/src/pages/__tests__/ScenarioRunsPage.test.tsx`의 기존 run 목록 fixture 중 하나에 `verdict: { passed: true, criteria: [] }`를 더하고(다른 행은 verdict 생략/null), 목록 렌더 후 `expect(screen.getByText("PASS")).toBeInTheDocument()`와 verdict 없는 행에 "—"가 보이는지 단언을 추가. (기존 테스트가 쓰는 fixture/헬퍼 형태에 맞춰 verdict 키만 추가.)

- [ ] **Step 6: 테스트 + 게이트 통과 확인 (GREEN)**

Run: `cd ui && pnpm test VerdictBadge ScenarioRunsPage 2>&1 | tail -20 && pnpm lint && pnpm test 2>&1 | tail -5 && pnpm build`
Expected: VerdictBadge·ScenarioRunsPage pass, **전체 `pnpm test` pass**(다른 파일 잠복 red 없음 — RunDetailPage/ScheduleEventTimeline 기존 테스트가 verdict 추가로 안 깨지는지), lint 0, `tsc -b` 클린.

- [ ] **Step 7: warm build(cargo 훅) + 커밋**

```bash
cargo build -p handicap-worker --bin worker && cargo build --workspace
git add ui/src/components/VerdictBadge.tsx ui/src/components/__tests__/VerdictBadge.test.tsx ui/src/pages/ScenarioRunsPage.tsx ui/src/components/ScheduleEventTimeline.tsx ui/src/pages/RunDetailPage.tsx ui/src/pages/__tests__/ScenarioRunsPage.test.tsx
git commit -m "feat(ui): VerdictBadge + run목록/스케줄타임라인/run상세 헤더 배선"
git log -1 --oneline
```

---

## Task 7: 라이브 검증 (필수, spec §7)

**목적**: RTL fixture는 verdict를 *absent*로 줘 `.optional()`↔서버-`null` 미스매치를 못 잡는다(문서화된 S-D 갭). 실제 controller+worker로 1회 검증 + 영속 verdict == `/report` verdict 불변식 확인.

**Files:** 없음(검증만). 필요 시 throwaway parse 테스트(커밋 안 함).

- [ ] **Step 1: 워크트리 자체 바이너리로 controller+worker 빌드·기동**

```bash
cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller
# python 200/404/500 stub + controller(격리 DB) 기동은 S-B/B6 수동테스트 레시피 참조.
./target/debug/controller --db /tmp/verdict-check.db --ui-dir ui/dist &
```
(워크트리면 메인 절대경로 금지 — **상대 `./target/debug/controller`**. controller가 spawn하는 `target/debug/worker`도 cwd-상대.)

- [ ] **Step 2: criteria 있는 run 생성 → 완료 대기**

시나리오 생성(`POST /api/scenarios`) 후 criteria 든 run 생성:
```bash
curl -sX POST localhost:8080/api/runs -H 'content-type: application/json' -d '{
  "scenario_id":"<SID>","profile":{"vus":2,"duration_seconds":3,"criteria":{"max_p95_ms":1}},"env":{}
}'
# p95<=1ms는 거의 FAIL → FAIL 배지 확인용. PASS 보려면 max_p95_ms를 크게.
```
`GET /api/runs/{id}`를 폴링해 `status=="completed"` 대기.

- [ ] **Step 3: 영속 verdict 확인 + 불변식**

```bash
curl -s localhost:8080/api/runs/<RID> | python3 -c 'import sys,json; r=json.load(sys.stdin); print("run.verdict:", r["verdict"])'
curl -s localhost:8080/api/runs/<RID>/report | python3 -c 'import sys,json; r=json.load(sys.stdin); print("report.verdict:", r["verdict"])'
```
Expected: 두 verdict의 `passed`·`criteria`가 **동일**(불변식). 목록 `GET /api/scenarios/{SID}/runs`의 해당 run에도 `verdict` 포함.

- [ ] **Step 4: UI 라이브(Playwright 또는 dev 서버)**

`pnpm dev`(또는 `ui/dist` 서빙) + 브라우저로 `/scenarios/{SID}/runs` → 결과 열에 PASS/FAIL 배지, FAIL hover→tooltip. `/runs/{RID}` 헤더 배지. (스케줄 만들어 발사시키면 `/schedules` 타임라인 배지까지.) **콘솔 Zod 에러 0** 확인(서버 `null`↔`.nullish()` 갭 차단).

- [ ] **Step 5: (선택) throwaway parse 테스트로 결정적 확인**

라이브 `/api/runs/{id}` JSON을 파일로 저장 → `ui/src/api/__tests__/`에 `readFileSync`+`RunSchema.safeParse`(실패 시 `r.error.issues` throw) throwaway 테스트 → 돌리고 **삭제(커밋 안 함)**. (`.playwright-mcp/`·루트 png·throwaway 테스트 머지 전 정리.)

- [ ] **Step 6: 정리**

controller/worker/stub 종료, `/tmp/verdict-check.db` 삭제, `rm -rf .playwright-mcp` + 루트 png 정리.

---

## 머지 후 (orchestrator)

- 최종 `handicap-reviewer`로 whole-feature 리뷰(와이어 1:1, deferral 추적, 게이트 재확인).
- `master`로 ff-merge(워크트리면 `git -C <메인> merge --ff-only` 패턴, 충돌 시 rebase 후 ff). `ExitWorktree(remove, discard_changes:true)`.
- 문서 갱신: 루트 `CLAUDE.md` "알아둘 결정들" ADR-0028 줄에 verdict 영속화 한 줄, `docs/roadmap.md` §B6 "run 목록 pass/fail 배지"를 완료로, auto-memory 1줄.

---

## Self-Review (작성자 체크)

- **Spec 커버리지**: §4.1 migration→T1; §4.2 finalize 훅→T3; §4.3 read-path(RunRow/RunResponse)→T2, events JOIN→T4; §4.4 Zod→T5; §4.5 3표면 배지→T6; §7 라이브→T7. 모든 절 매핑됨.
- **Placeholder 없음**: 모든 코드 step에 실제 코드/명령/기대출력.
- **타입 일관성**: `Verdict`/`CriterionResult`(report.rs), `set_verdict`(runs.rs, T3 정의·T4 사용), `VerdictBadge`(T6 정의), `verdict` 필드명 전 레이어 동일. `RunRow.verdict`/`RunResponse.verdict`/`ScheduleEventRow.verdict`/`EventResponse.verdict` 명칭 일치.
- **커밋 경계**: 각 task가 dead-code/RED 단독 없이 green 커밋(T2는 raw-SQL로 set_verdict 의존 회피, T3에서 set_verdict가 코디네이터 caller 확보).
- **알려진 함정 반영**: migration 배선 순서(0011 뒤), JOIN 컬럼 자격, RunRow 리터럴 2곳(insert+report.rs fixture), VerdictSchema 선언 위치 이동(const 비호이스팅), `.nullish()`, 전체 pnpm test, warm build.
- **plan-reviewer 반영(2026-06-07)**: `Verdict`/`CriterionResult`에 `Clone` 파생 추가(T2 Step 5a — T4 `ScheduleEventRow` Clone 요구); T3 criteria는 struct-update(`field_reassign_with_default` 회피); T4 `Some(run.id.as_str())`(Option<&str>); T5는 기존 import에 `ScheduleEventSchema` 합치기(중복 import 금지).

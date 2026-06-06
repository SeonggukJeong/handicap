# Run 스케줄러 34b (영속화 + 루프 + REST) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 34a가 깐 순수 트리거 엔진(`schedule::trigger`)과 발사 코어(`api::runs::spawn_run`) 위에, 스케줄의 **영속화(migration 0011 + `store/schedules.rs`)**, **컨트롤러 내장 주기 루프(`schedule/runner.rs`: `process_due_schedules`/`run_scheduler`)**, **CRUD REST API(`api/schedules.rs` + preview-next)**, **main.rs 배선(CLI 3종 + spawn)** 을 더해 백엔드를 완결한다(curl로 검증 가능). UI는 34c.

**Architecture:** 모두 컨트롤러 한정. 스케줄 정의는 `schedules` 테이블(profile/env 스냅샷 + trigger 컬럼 + `next_run_at` 루프 키 + last_* 요약), 주목 이벤트는 append-only `schedule_events`. 단일 `tokio::spawn` 루프가 틱마다 `enabled AND next_run_at <= now`를 조회해 겹침/missed를 판정한 뒤 `spawn_run`(REST와 공유)으로 발사하고, 모든 결과를 schedule row UPDATE + event INSERT로 기록한다. cron 평가 TZ는 `--scheduler-timezone`(IANA)을 main.rs가 1곳에서 파싱해 `AppState.scheduler_tz`로 주입 — API 핸들러(next_run_at 계산·preview)와 루프가 같은 TZ를 공유한다.

**Tech Stack:** Rust(edition 2024, MSRV 1.85), 기존 `croner`/`chrono`/`chrono-tz`(34a 추가), axum 0.8, sqlx 0.8 SQLite, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-06-06-run-scheduler-design.md` (§4 데이터 모델, §7 루프, §8 REST, §10 검증, §11 테스트, §13 ADR, §15 분할 — 이 plan = 34b).

---

## 사전 메모 (실행 전 1회 읽기)

- **TDD-guard 함정(C-1, 루트 CLAUDE.md)**: store/schedules.rs·schedule/runner.rs는 **새 src 파일 + 인라인 `#[cfg(test)]`**라 첫 Write가 차단된다(인라인-test 자동통과는 디스크에 이미 `#[cfg(test)]`가 있는 파일에만 적용 — 첫 Write엔 안 통함). **orchestrator는 각 해당 task 시작 전에 `crates/controller/tests/_tdd_keepalive.rs`에 `#[test] fn k() {}` 한 줄을 깔아 unblock**하고, implementer에겐 **명시 경로로만 `git add`**(절대 `-A` 금지)시킨 뒤 **task 끝(커밋 직전)에 `rm crates/controller/tests/_tdd_keepalive.rs`**. Task 2(trigger 테스트 추가)·Task 4(통합 테스트 먼저 작성)·Task 5(.md-only)는 self-unblock이라 keepalive 불필요.
- **pre-commit 게이트**: 비-`.md` 커밋마다 전체 워크스페이스(`cargo fmt --check + build + clippy -D warnings + test --workspace`)를 돈다(수 분). **커밋 전 `cargo build -p handicap-worker && cargo build --workspace`로 warm**(cold-build worker race flake 대비 — flake나면 동일 커밋 warm 재시도). 커밋은 `run_in_background:false` 단일 호출 + 파이프 금지(exit code 마스킹) + 직후 `git log -1`로 확인.
- **마이그레이션 리넘버 함정(controller CLAUDE.md)**: `MIGRATION_SQL_0011` const 1개당 `connect()`의 execute 1줄이 짝이어야 한다. 세션 중 master가 0011을 선점하면 리넘버(현재 최신 파일 마이그레이션은 0010, 0011이 다음). const와 execute 라인 짝을 육안 확인.
- **byte-identical 불변식**: `AppState`에 `scheduler_tz` 필드를 더해도(Task 3) 기존 핸들러는 그 필드를 안 읽으므로 동작 무변경 — 컴파일(모든 `AppState { … }` literal에 필드 추가)만 영향. 기존 통합 테스트가 전부 GREEN인 것이 게이트.
- **설계 결정(spec 대비 변경 — Task에서 구현, §리뷰 검토 포인트에 정리)**:
  1. **TZ는 `AppState.scheduler_tz`로 단일화** — spec §7은 `run_scheduler(state, tick, tz)`로 tz를 인자로 받지만, API의 `next_run_at` 계산(create/update)·preview-next도 같은 TZ가 필요하다. main.rs가 1곳에서 파싱해 AppState에 넣으면 루프와 API가 단일 소스를 공유한다. → `run_scheduler(state, tick)`(tz 인자 없음), `process_due_schedules`도 `state.scheduler_tz` 사용.
  2. **5-field 강제는 `validate_trigger`에서**(34a 인계 ①) — croner는 6-field도 파싱하므로 `validate_trigger`에 `split_whitespace().count() == 5` 체크를 더해 고급 raw 탭의 stray 6-field를 거부한다(UI 프리셋은 항상 5-field라 정상 경로 무영향). 검증 단일 소스(create/update/preview 공유).
  3. **once의 missed는 발사를 막지 않고 이벤트 kind도 바꾸지 않는다** — once가 due면 grace 무관하게 발사하고 성공 시 `fired` 이벤트(run_id) + 비활성화. spec §7의 "missed면 kind만 바꾼다"는 cosmetic 문구를 "fired 이벤트는 항상 run 생성을 의미"로 단순화(missed 이벤트는 cron 전용 = 발사 안 함). 운영 가시성·일관성이 더 명확.
  4. **e2e/Helm 배선 무변경** — `--scheduler-disabled` CLI 플래그는 제공하되, in-process 통합 테스트(e2e_test.rs)는 main.rs를 안 거쳐 루프가 안 뜨고(무영향), K8s controller args는 Helm 소관(34b 무변경)이며 빈 schedules 테이블 틱은 무해한 SELECT no-op이다. deploy는 안 건드린다.

---

## 파일 구조

| 파일 | 책임 | Task |
|---|---|---|
| `crates/controller/src/store/migrations/0011_schedules.sql` (신규) | `schedules` + `schedule_events` 2테이블 + 인덱스 | 1 |
| `crates/controller/src/store/schedules.rs` (신규) | `ScheduleRow`/`ScheduleEventRow` + CRUD + events + `due`/`mark_outcome` | 1 |
| `crates/controller/src/store/mod.rs` | `MIGRATION_SQL_0011` const+execute, `pub mod schedules;` | 1 |
| `crates/controller/src/schedule/trigger.rs` | `validate_trigger` 5-field 체크 추가 | 2 |
| `crates/controller/tests/scheduler_trigger_test.rs` | 5-field 거부 테스트 | 2 |
| `crates/controller/src/app.rs` | `AppState.scheduler_tz` 필드 | 3 |
| `crates/controller/src/main.rs` | CLI 3종 + TZ 파싱 + `run_scheduler` spawn 배선 | 3 |
| `crates/controller/src/schedule/runner.rs` (신규) | `process_due_schedules`/`run_scheduler`/`TickSummary` + 인라인 테스트 | 3 |
| `crates/controller/src/schedule/mod.rs` | `pub mod runner;` + re-export | 3 |
| (모든 `AppState { … }` literal 사이트 — 테스트 make_app들 + e2e in-process + **`api/runs.rs:657` 인라인 test `state_with`**) | `scheduler_tz` 추가 | 3 |
| `crates/controller/src/api/schedules.rs` (신규) | CRUD + preview-next + events 핸들러 | 4 |
| `crates/controller/src/api/mod.rs` | `pub mod schedules;` | 4 |
| `crates/controller/src/app.rs` | schedules 라우트 + import | 4 |
| `crates/controller/tests/schedules_api_test.rs` (신규) | API 통합 테스트 | 4 |
| `docs/adr/0034-run-scheduler.md` (신규) | ADR | 5 |
| `CLAUDE.md` / `docs/roadmap.md` | 결정 한 줄 + roadmap | 5 |

---

## Task 1: migration 0011 + `store/schedules.rs`

**Files:**
- Create: `crates/controller/src/store/migrations/0011_schedules.sql`
- Create: `crates/controller/src/store/schedules.rs`
- Modify: `crates/controller/src/store/mod.rs`
- (keepalive: `crates/controller/tests/_tdd_keepalive.rs` — orchestrator가 선설치, task 끝에 rm)

- [ ] **Step 1: keepalive 설치 (orchestrator)**

`crates/controller/tests/_tdd_keepalive.rs`:
```rust
#[test]
fn keepalive() {}
```
(store/schedules.rs는 새 src 파일 + 인라인 test라 이게 없으면 첫 Write가 TDD-guard에 막힌다. 커밋 직전 `rm`.)

- [ ] **Step 2: migration SQL 작성**

`crates/controller/src/store/migrations/0011_schedules.sql`:
```sql
-- 예약/반복 run 정의 (top-level 리소스, environments 패턴).
-- CREATE ... IF NOT EXISTS는 멱등(재실행 안전), 0003/0004/0005/0007과 동일.
-- runs 테이블·proto·엔진·워커 무변경. profile_json/env_json은 Profile/맵 스냅샷.
CREATE TABLE IF NOT EXISTS schedules (
    id            TEXT PRIMARY KEY,        -- ULID, server-generated
    name          TEXT NOT NULL,
    scenario_id   TEXT NOT NULL REFERENCES scenarios(id),
    profile_json  TEXT NOT NULL,           -- Profile 스냅샷 (runs/presets와 동일 직렬화)
    env_json      TEXT NOT NULL,           -- ${ENV} 오버레이 (평탄 맵)
    trigger_kind  TEXT NOT NULL,           -- 'once' | 'cron'
    cron_expr     TEXT,                    -- trigger_kind='cron'일 때
    run_at        INTEGER,                 -- trigger_kind='once'일 때 (epoch ms)
    enabled       INTEGER NOT NULL DEFAULT 1,
    next_run_at   INTEGER,                 -- 루프 쿼리 키 (계산값; NULL=발사 예정 없음)
    last_run_id   TEXT,                    -- 마지막 발사한 run (겹침 체크·링크)
    last_fired_at INTEGER,
    last_status   TEXT,                    -- 'fired'|'skipped_overlap'|'missed'|'error' (목록 표시 요약)
    last_error    TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_name ON schedules(name);
-- 루프가 매 틱 'enabled AND next_run_at <= now'를 조회 → 부분 인덱스.
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(next_run_at) WHERE enabled = 1;

-- append-only 이벤트 로그 (알림/이력의 단일 소스).
CREATE TABLE IF NOT EXISTS schedule_events (
    id          TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    at          INTEGER NOT NULL,
    kind        TEXT NOT NULL,             -- 'fired'|'skipped_overlap'|'missed'|'error'
    run_id      TEXT,                      -- kind='fired'
    detail      TEXT                       -- 에러 메시지 / skip·miss 사유
);
CREATE INDEX IF NOT EXISTS idx_schedule_events_sched ON schedule_events(schedule_id, at DESC);
```

- [ ] **Step 3: `store/mod.rs` 배선**

① 상단 모듈 목록(`pub mod scenarios;` 옆)에 추가:
```rust
pub mod schedules;
```
② const 블록(`MIGRATION_SQL_0010` 아래)에 추가:
```rust
const MIGRATION_SQL_0011: &str = include_str!("migrations/0011_schedules.sql");
```
③ `connect()`의 `sqlx::query(MIGRATION_SQL_0010).execute(&pool).await?;`(`:63`) **뒤**에 추가:
```rust
    sqlx::query(MIGRATION_SQL_0011).execute(&pool).await?; // migration 0011: schedules + schedule_events
```
> 확인: const 라인과 execute 라인이 1:1 짝인지 육안 점검(controller CLAUDE.md 리넘버 함정).

- [ ] **Step 4: `store/schedules.rs` 작성** (environments.rs 미러 + trigger 컬럼 + events + 루프 헬퍼)

```rust
use std::collections::BTreeMap;

use sqlx::Row;
use ulid::Ulid;

use super::Db;
use super::runs::Profile;
use crate::schedule::trigger::Trigger;

/// 하나의 예약/반복 run 정의. profile/env는 발사 시점 스냅샷(runs/presets와 동일
/// 직렬화). trigger는 (trigger_kind, cron_expr, run_at) 3컬럼으로 평탄 저장하고
/// `trigger()`로 순수 `Trigger`를 복원한다(API 게이트가 정합성 보장).
#[derive(Debug, Clone)]
pub struct ScheduleRow {
    pub id: String,
    pub name: String,
    pub scenario_id: String,
    pub profile: Profile,
    pub env: BTreeMap<String, String>,
    pub trigger_kind: String,
    pub cron_expr: Option<String>,
    pub run_at: Option<i64>,
    pub enabled: bool,
    pub next_run_at: Option<i64>,
    pub last_run_id: Option<String>,
    pub last_fired_at: Option<i64>,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl ScheduleRow {
    /// 저장 컬럼에서 순수 Trigger 복원. insert/update가 `validate_trigger`를 통과한
    /// 값만 저장하므로 두 컬럼은 trigger_kind와 정합한다(once→run_at, cron→cron_expr).
    pub fn trigger(&self) -> Trigger {
        match self.trigger_kind.as_str() {
            "once" => Trigger::Once {
                run_at: self.run_at.unwrap_or(0),
            },
            _ => Trigger::Cron {
                expr: self.cron_expr.clone().unwrap_or_default(),
            },
        }
    }
}

/// append-only 이벤트 한 줄.
#[derive(Debug, Clone)]
pub struct ScheduleEventRow {
    pub id: String,
    pub schedule_id: String,
    pub at: i64,
    pub kind: String,
    pub run_id: Option<String>,
    pub detail: Option<String>,
}

fn trigger_columns(t: &Trigger) -> (String, Option<String>, Option<i64>) {
    match t {
        Trigger::Once { run_at } => ("once".to_string(), None, Some(*run_at)),
        Trigger::Cron { expr } => ("cron".to_string(), Some(expr.clone()), None),
    }
}

fn row_to_schedule(r: &sqlx::sqlite::SqliteRow) -> ScheduleRow {
    let profile: Profile =
        serde_json::from_str(r.get::<String, _>("profile_json").as_str()).unwrap();
    let env: BTreeMap<String, String> =
        serde_json::from_str(r.get::<String, _>("env_json").as_str()).unwrap_or_default();
    ScheduleRow {
        id: r.get("id"),
        name: r.get("name"),
        scenario_id: r.get("scenario_id"),
        profile,
        env,
        trigger_kind: r.get("trigger_kind"),
        cron_expr: r.get("cron_expr"),
        run_at: r.get("run_at"),
        enabled: r.get::<i64, _>("enabled") != 0,
        next_run_at: r.get("next_run_at"),
        last_run_id: r.get("last_run_id"),
        last_fired_at: r.get("last_fired_at"),
        last_status: r.get("last_status"),
        last_error: r.get("last_error"),
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn insert(
    db: &Db,
    name: &str,
    scenario_id: &str,
    profile: &Profile,
    env: &BTreeMap<String, String>,
    trigger: &Trigger,
    enabled: bool,
    next_run_at: Option<i64>,
) -> sqlx::Result<ScheduleRow> {
    let id = Ulid::new().to_string();
    let now = super::now_ms();
    let profile_json = serde_json::to_string(profile).expect("serialize profile");
    let env_json = serde_json::to_string(env).expect("serialize env");
    let (kind, cron_expr, run_at) = trigger_columns(trigger);
    sqlx::query(
        "INSERT INTO schedules \
           (id,name,scenario_id,profile_json,env_json,trigger_kind,cron_expr,run_at,enabled,next_run_at,created_at,updated_at) \
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(name)
    .bind(scenario_id)
    .bind(&profile_json)
    .bind(&env_json)
    .bind(&kind)
    .bind(&cron_expr)
    .bind(run_at)
    .bind(enabled as i64)
    .bind(next_run_at)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    Ok(ScheduleRow {
        id,
        name: name.to_string(),
        scenario_id: scenario_id.to_string(),
        profile: profile.clone(),
        env: env.clone(),
        trigger_kind: kind,
        cron_expr,
        run_at,
        enabled,
        next_run_at,
        last_run_id: None,
        last_fired_at: None,
        last_status: None,
        last_error: None,
        created_at: now,
        updated_at: now,
    })
}

pub async fn get(db: &Db, id: &str) -> sqlx::Result<Option<ScheduleRow>> {
    let row = sqlx::query("SELECT * FROM schedules WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?;
    Ok(row.as_ref().map(row_to_schedule))
}

pub async fn list(db: &Db) -> sqlx::Result<Vec<ScheduleRow>> {
    let rows = sqlx::query("SELECT * FROM schedules ORDER BY name")
        .fetch_all(db)
        .await?;
    Ok(rows.iter().map(row_to_schedule).collect())
}

/// 루프 쿼리: 발사 후보(enabled AND next_run_at 도래).
pub async fn due(db: &Db, now_ms: i64) -> sqlx::Result<Vec<ScheduleRow>> {
    let rows = sqlx::query(
        "SELECT * FROM schedules \
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? \
         ORDER BY next_run_at ASC",
    )
    .bind(now_ms)
    .fetch_all(db)
    .await?;
    Ok(rows.iter().map(row_to_schedule).collect())
}

/// 전체 교체(name/scenario/profile/env/trigger/enabled/next_run_at). last_*는
/// 보존(루프 소유). 없는 id면 None.
#[allow(clippy::too_many_arguments)]
pub async fn update(
    db: &Db,
    id: &str,
    name: &str,
    scenario_id: &str,
    profile: &Profile,
    env: &BTreeMap<String, String>,
    trigger: &Trigger,
    enabled: bool,
    next_run_at: Option<i64>,
) -> sqlx::Result<Option<ScheduleRow>> {
    let now = super::now_ms();
    let profile_json = serde_json::to_string(profile).expect("serialize profile");
    let env_json = serde_json::to_string(env).expect("serialize env");
    let (kind, cron_expr, run_at) = trigger_columns(trigger);
    let res = sqlx::query(
        "UPDATE schedules SET \
           name=?, scenario_id=?, profile_json=?, env_json=?, \
           trigger_kind=?, cron_expr=?, run_at=?, enabled=?, next_run_at=?, updated_at=? \
         WHERE id=?",
    )
    .bind(name)
    .bind(scenario_id)
    .bind(&profile_json)
    .bind(&env_json)
    .bind(&kind)
    .bind(&cron_expr)
    .bind(run_at)
    .bind(enabled as i64)
    .bind(next_run_at)
    .bind(now)
    .bind(id)
    .execute(db)
    .await?;
    if res.rows_affected() == 0 {
        return Ok(None);
    }
    get(db, id).await
}

/// 발사/스킵/미스/에러 처리 후 스케줄 상태를 한 번에 갱신(루프 전용).
/// last_run_id/last_fired_at은 COALESCE라 None이면 보존(fired일 때만 갱신),
/// last_error/last_status/next_run_at/enabled는 매번 set(에러 아니면 last_error NULL로 클리어).
#[allow(clippy::too_many_arguments)]
pub async fn mark_outcome(
    db: &Db,
    id: &str,
    next_run_at: Option<i64>,
    enabled: bool,
    last_status: &str,
    last_run_id: Option<&str>,
    last_fired_at: Option<i64>,
    last_error: Option<&str>,
) -> sqlx::Result<()> {
    let now = super::now_ms();
    sqlx::query(
        "UPDATE schedules SET \
           next_run_at = ?, enabled = ?, last_status = ?, \
           last_run_id = COALESCE(?, last_run_id), \
           last_fired_at = COALESCE(?, last_fired_at), \
           last_error = ?, updated_at = ? \
         WHERE id = ?",
    )
    .bind(next_run_at)
    .bind(enabled as i64)
    .bind(last_status)
    .bind(last_run_id)
    .bind(last_fired_at)
    .bind(last_error)
    .bind(now)
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

/// events 선삭제 + 스케줄 삭제(트랜잭션). FK ON DELETE CASCADE도 있으나 dataset_rows
/// 패턴처럼 앱 레벨로 명시(FK 의존 안 함).
pub async fn delete(db: &Db, id: &str) -> sqlx::Result<()> {
    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM schedule_events WHERE schedule_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM schedules WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn insert_event(
    db: &Db,
    schedule_id: &str,
    at: i64,
    kind: &str,
    run_id: Option<&str>,
    detail: Option<&str>,
) -> sqlx::Result<()> {
    let id = Ulid::new().to_string();
    sqlx::query(
        "INSERT INTO schedule_events(id,schedule_id,at,kind,run_id,detail) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(schedule_id)
    .bind(at)
    .bind(kind)
    .bind(run_id)
    .bind(detail)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn recent_events(
    db: &Db,
    schedule_id: &str,
    limit: i64,
) -> sqlx::Result<Vec<ScheduleEventRow>> {
    let rows = sqlx::query(
        "SELECT id,schedule_id,at,kind,run_id,detail FROM schedule_events \
         WHERE schedule_id = ? ORDER BY at DESC LIMIT ?",
    )
    .bind(schedule_id)
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows
        .iter()
        .map(|r| ScheduleEventRow {
            id: r.get("id"),
            schedule_id: r.get("schedule_id"),
            at: r.get("at"),
            kind: r.get("kind"),
            run_id: r.get("run_id"),
            detail: r.get("detail"),
        })
        .collect())
}
```

- [ ] **Step 5: 인라인 테스트 작성** (`store/schedules.rs` 끝)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;
    use crate::store::runs::Profile;

    fn profile() -> Profile {
        Profile {
            vus: 1,
            ramp_up_seconds: 0,
            duration_seconds: 1,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            data_binding: None,
            criteria: None,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
        }
    }

    async fn seed_scenario(db: &store::Db) -> String {
        let yaml = "version: 1\nname: s\nsteps: []\n";
        let sc = handicap_engine::Scenario::from_yaml(yaml).unwrap();
        scenarios_insert(db, &sc, yaml).await
    }
    // scenarios::insert를 그대로 쓰면 되지만 import 충돌을 피해 한 줄 래퍼.
    async fn scenarios_insert(
        db: &store::Db,
        sc: &handicap_engine::Scenario,
        yaml: &str,
    ) -> String {
        crate::store::scenarios::insert(db, sc, yaml)
            .await
            .unwrap()
            .id
    }

    #[tokio::test]
    async fn insert_get_list_update_delete_roundtrip() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sid = seed_scenario(&db).await;
        let env: BTreeMap<String, String> =
            [("BASE_URL".to_string(), "http://x".to_string())].into();
        let trigger = Trigger::Cron {
            expr: "0 2 * * *".into(),
        };
        let row = insert(&db, "nightly", &sid, &profile(), &env, &trigger, true, Some(5_000))
            .await
            .unwrap();

        let got = get(&db, &row.id).await.unwrap().expect("schedule");
        assert_eq!(got.name, "nightly");
        assert_eq!(got.trigger_kind, "cron");
        assert_eq!(got.cron_expr.as_deref(), Some("0 2 * * *"));
        assert_eq!(got.env, env);
        assert!(matches!(got.trigger(), Trigger::Cron { .. }));

        let listed = list(&db).await.unwrap();
        assert_eq!(listed.len(), 1);

        let once = Trigger::Once { run_at: 9_999 };
        let updated = update(
            &db, &row.id, "oneshot", &sid, &profile(), &env, &once, false, Some(9_999),
        )
        .await
        .unwrap()
        .expect("updated");
        assert_eq!(updated.name, "oneshot");
        assert_eq!(updated.trigger_kind, "once");
        assert_eq!(updated.run_at, Some(9_999));
        assert!(!updated.enabled);

        delete(&db, &row.id).await.unwrap();
        assert!(get(&db, &row.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn unique_name_is_enforced() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sid = seed_scenario(&db).await;
        let t = Trigger::Cron { expr: "0 2 * * *".into() };
        insert(&db, "dup", &sid, &profile(), &BTreeMap::new(), &t, true, None)
            .await
            .unwrap();
        let err = insert(&db, "dup", &sid, &profile(), &BTreeMap::new(), &t, true, None)
            .await
            .expect_err("duplicate name must fail");
        assert!(
            err.as_database_error()
                .map(|d| d.is_unique_violation())
                .unwrap_or(false),
            "expected UNIQUE violation, got {err:?}"
        );
    }

    #[tokio::test]
    async fn due_returns_only_enabled_and_arrived() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sid = seed_scenario(&db).await;
        let t = Trigger::Cron { expr: "* * * * *".into() };
        // arrived + enabled → due
        insert(&db, "a", &sid, &profile(), &BTreeMap::new(), &t, true, Some(100)).await.unwrap();
        // future → not due
        insert(&db, "b", &sid, &profile(), &BTreeMap::new(), &t, true, Some(10_000)).await.unwrap();
        // disabled → not due
        insert(&db, "c", &sid, &profile(), &BTreeMap::new(), &t, false, Some(100)).await.unwrap();
        // next_run_at NULL → not due
        insert(&db, "d", &sid, &profile(), &BTreeMap::new(), &t, true, None).await.unwrap();

        let due = due(&db, 1_000).await.unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].name, "a");
    }

    #[tokio::test]
    async fn mark_outcome_advances_and_preserves_last_run_on_non_fire() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sid = seed_scenario(&db).await;
        let t = Trigger::Cron { expr: "* * * * *".into() };
        let row = insert(&db, "s", &sid, &profile(), &BTreeMap::new(), &t, true, Some(100))
            .await.unwrap();
        // fired: last_run_id 세팅.
        mark_outcome(&db, &row.id, Some(200), true, "fired", Some("RUN1"), Some(150), None)
            .await.unwrap();
        let g = get(&db, &row.id).await.unwrap().unwrap();
        assert_eq!(g.last_run_id.as_deref(), Some("RUN1"));
        assert_eq!(g.last_status.as_deref(), Some("fired"));
        // skipped: last_run_id 보존(COALESCE None), status 갱신.
        mark_outcome(&db, &row.id, Some(300), true, "skipped_overlap", None, None, Some("busy"))
            .await.unwrap();
        let g = get(&db, &row.id).await.unwrap().unwrap();
        assert_eq!(g.last_run_id.as_deref(), Some("RUN1"), "last_run_id preserved");
        assert_eq!(g.last_status.as_deref(), Some("skipped_overlap"));
        assert_eq!(g.last_error.as_deref(), Some("busy"));
    }

    #[tokio::test]
    async fn events_insert_recent_and_cascade_on_delete() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sid = seed_scenario(&db).await;
        let t = Trigger::Cron { expr: "* * * * *".into() };
        let row = insert(&db, "s", &sid, &profile(), &BTreeMap::new(), &t, true, Some(100))
            .await.unwrap();
        insert_event(&db, &row.id, 100, "fired", Some("RUN1"), None).await.unwrap();
        insert_event(&db, &row.id, 200, "skipped_overlap", None, Some("busy")).await.unwrap();
        let evs = recent_events(&db, &row.id, 10).await.unwrap();
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0].kind, "skipped_overlap", "at DESC → newest first");
        assert_eq!(evs[1].kind, "fired");

        delete(&db, &row.id).await.unwrap();
        let evs = recent_events(&db, &row.id, 10).await.unwrap();
        assert!(evs.is_empty(), "events deleted with the schedule");
    }
}
```

- [ ] **Step 6: 테스트 + clippy/fmt**

Run: `cargo test -p handicap-controller schedules` (store 인라인 테스트 6개 + connect 멱등 테스트)
Expected: PASS. 이어서 `cargo clippy -p handicap-controller --all-targets -- -D warnings && cargo fmt --check` 통과.

- [ ] **Step 7: keepalive 제거 + 커밋**

```bash
rm crates/controller/tests/_tdd_keepalive.rs
cargo build -p handicap-worker && cargo build --workspace   # warm
git add crates/controller/src/store/migrations/0011_schedules.sql \
        crates/controller/src/store/schedules.rs \
        crates/controller/src/store/mod.rs
git commit -m "feat(controller): schedules/schedule_events 영속화 + migration 0011 (34b)"
```
직후 `git log -1 --oneline` 확인. (keepalive가 `git status`에 untracked로 남으면 안 됨 — rm 확인.)

---

## Task 2: `validate_trigger` 5-field 강제

**Files:**
- Modify: `crates/controller/src/schedule/trigger.rs` (`validate_trigger` Cron arm)
- Modify: `crates/controller/tests/scheduler_trigger_test.rs` (테스트 1개 추가)

34a 인계 ① 해소: croner는 6-field도 파싱하므로 검증 단일 소스에서 5-field를 강제. self-unblock(scheduler_trigger_test.rs는 디스크 존재 test-path 파일).

- [ ] **Step 1: 실패 테스트 추가** (`scheduler_trigger_test.rs` 끝)

```rust
#[test]
fn validate_rejects_non_five_field_cron() {
    let now = seoul_ms(2026, 6, 6, 1, 0);
    // 6-field (croner는 seconds-optional이라 파싱하지만 우리 불변식은 5-field crontab): 거부.
    assert!(validate_trigger(&Trigger::Cron { expr: "0 0 2 * * *".into() }, now).is_err());
    // 7-field (croner는 year-optional이라 파싱; == 5 가드가 6·7 둘 다 막음 — MINOR-E): 거부.
    assert!(validate_trigger(&Trigger::Cron { expr: "0 0 2 * * * 2030".into() }, now).is_err());
    // 4-field: 거부.
    assert!(validate_trigger(&Trigger::Cron { expr: "0 2 * *".into() }, now).is_err());
    // 5-field: 통과.
    assert!(validate_trigger(&Trigger::Cron { expr: "0 2 * * *".into() }, now).is_ok());
}
```

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-controller --test scheduler_trigger_test validate_rejects_non_five_field_cron`
Expected: FAIL — 6-field가 croner를 통과해 `is_err()`가 거짓.

- [ ] **Step 3: `validate_trigger` Cron arm 수정** (`trigger.rs`)

기존:
```rust
        Trigger::Cron { expr } => Cron::from_str(expr)
            .map(|_| ())
            .map_err(|e| format!("cron 표현식이 올바르지 않습니다: {e}")),
```
교체:
```rust
        Trigger::Cron { expr } => {
            // 5-field 표준 crontab(분 시 일 월 요일)만 허용. croner는 6-field도
            // 파싱하지만 spec §5 불변식·UI 프리셋은 5-field로 통일(34a 인계 ①).
            let fields = expr.split_whitespace().count();
            if fields != 5 {
                return Err(format!(
                    "cron 표현식은 5개 필드(분 시 일 월 요일)여야 합니다: {fields}개 발견"
                ));
            }
            Cron::from_str(expr)
                .map(|_| ())
                .map_err(|e| format!("cron 표현식이 올바르지 않습니다: {e}"))
        }
```

- [ ] **Step 4: GREEN + 회귀 확인**

Run: `cargo test -p handicap-controller --test scheduler_trigger_test`
Expected: PASS (기존 7 + 신규 1 = 8 — 34a M2 fold-in `next_fires_count_zero` 포함이라 기존이 6이 아닌 7 — MINOR-A). 이어서 `cargo clippy -p handicap-controller --all-targets -- -D warnings && cargo fmt --check`.

- [ ] **Step 5: 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace   # warm
git add crates/controller/src/schedule/trigger.rs crates/controller/tests/scheduler_trigger_test.rs
git commit -m "feat(controller): validate_trigger 5-field cron 강제 (34b, 34a 인계 ①)"
```
직후 `git log -1 --oneline` 확인.

---

## Task 3: `AppState.scheduler_tz` + main.rs 배선 + `schedule/runner.rs`

**Files:**
- Modify: `crates/controller/src/app.rs` (`AppState` 필드)
- Modify: `crates/controller/src/main.rs` (CLI 3종 + TZ 파싱 + spawn)
- Create: `crates/controller/src/schedule/runner.rs`
- Modify: `crates/controller/src/schedule/mod.rs`
- Modify: (모든 `AppState { … }` literal 사이트 — grep로 전부; **`crates/controller/src/api/runs.rs:657` 인라인 test `state_with` 포함** — MAJOR-1)
- (keepalive: `crates/controller/tests/_tdd_keepalive.rs` — runner.rs 인라인 test 첫 Write unblock)

- [ ] **Step 1: keepalive 설치 (orchestrator)**

`crates/controller/tests/_tdd_keepalive.rs`에 `#[test] fn keepalive() {}` (Task 1과 동일, 이미 있으면 재사용). runner.rs는 새 src + 인라인 test라 필요.

- [ ] **Step 2: `AppState`에 `scheduler_tz` 필드 추가** (`app.rs`)

`AppState` struct(`:16-25`)에 필드 추가:
```rust
#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub coord: CoordinatorState,
    pub dispatcher: SharedDispatcher,
    pub ui_dir: Option<PathBuf>,
    pub dataset_max_rows: u64,
    /// IANA timezone for cron evaluation (spec §3). main.rs parses
    /// `--scheduler-timezone` once and injects it so the scheduler loop AND the
    /// REST handlers (next_run_at calc, preview-next) share one source of truth.
    pub scheduler_tz: chrono_tz::Tz,
}
```

- [ ] **Step 3: 모든 `AppState { … }` literal에 `scheduler_tz` 추가**

Run: `grep -rn "AppState {" crates/controller/` 로 literal 사이트 확인(app.rs는 struct *정의*라 제외 — `pub struct AppState {`; **`src/api/runs.rs:657`는 인라인 test `state_with`의 진짜 생성 literal이라 포함**).

다음 사이트의 AppState literal에 한 줄 추가(테스트는 결정론 위해 UTC):
- 각 **통합 테스트 make_app**: `api_test` / `data_binding_api_test` / `presets_api_test` / `datasets_api_test` / `environments_api_test` / `test_runs_api_test` / `export_routes_test` / `report_test` / `run_dispatch_failure_test` / `static_test`. (⚠ `crash_recovery_test`는 AppState literal **없음** — grep로 확인, 건드리지 않음 — MINOR-C.)
- **e2e_test.rs** / **multi_worker_fanout_e2e.rs**의 in-process AppState literal.
- **`crates/controller/src/api/runs.rs:657-669`의 인라인 test `state_with`**(`SubprocessDispatcher`를 쓰는 진짜 literal — `scheduler_tz: chrono_tz::UTC` 추가). **이 src 파일은 Step 8 `git add`에 반드시 포함**(빠뜨리면 `cargo test -p handicap-controller`가 "missing field scheduler_tz"로 깨진다 — MAJOR-1).
```rust
        scheduler_tz: chrono_tz::UTC,
```
> 컴파일러가 빠진 사이트를 "missing field scheduler_tz"로 전부 잡는다 — `cargo build --workspace --tests`로 0 에러 될 때까지 추가. (main.rs는 Step 6에서 실제 TZ로 채운다.)

- [ ] **Step 4: `schedule/runner.rs` 작성**

```rust
//! 스케줄러 루프: due 스케줄을 틱마다 발사 경로(`api::runs::spawn_run`, REST와 공유)로
//! 흘린다. 트리거 계산은 `schedule::trigger`(순수, TZ-aware), TZ는 `state.scheduler_tz`.
use std::collections::HashMap;
use std::time::Duration;

use crate::api::runs::{spawn_run, validate_run_config};
use crate::app::AppState;
use crate::schedule::trigger::{Trigger, next_fire_after};
use crate::store::{now_ms, runs, scenarios, schedules};

/// on-time과 missed를 가르는 grace 윈도(ms). 짧은 재시작/틱 지연은 정상 발사로
/// 흡수하고, 장기 다운만 cron에서 missed로 친다. grace ≥ 기본 틱(30s).
const MISS_GRACE_MS: i64 = 300_000;

/// 한 틱의 처리 요약(테스트 가독성·info 로깅).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct TickSummary {
    pub fired: usize,
    pub skipped: usize,
    pub missed: usize,
    pub errored: usize,
}

/// startup에서 1회 spawn. `interval.tick()`마다 due 스케줄을 처리한다.
/// 단일 루프 + 틱당 순차 처리라 틱 겹침 없음(ADR-0011 단일 인스턴스).
pub async fn run_scheduler(state: AppState, tick: Duration) {
    let mut interval = tokio::time::interval(tick);
    loop {
        interval.tick().await;
        let summary = process_due_schedules(&state, now_ms()).await;
        if summary != TickSummary::default() {
            tracing::info!(?summary, "scheduler processed due schedules");
        }
    }
}

/// 한 틱: due 스케줄을 순차 처리(주입 `now_ms`로 결정론적 테스트). 반환=처리 요약.
pub(crate) async fn process_due_schedules(state: &AppState, now_ms: i64) -> TickSummary {
    let mut summary = TickSummary::default();
    let due = match schedules::due(&state.db, now_ms).await {
        Ok(d) => d,
        Err(e) => {
            tracing::error!(error = %e, "scheduler: due query failed; skipping tick");
            return summary;
        }
    };
    let tz = state.scheduler_tz;
    for sched in due {
        let trigger = sched.trigger();
        let is_once = matches!(trigger, Trigger::Once { .. });
        // 이 틱 처리 후 스케줄을 어디로 전진시킬지: cron은 now 기준 다음 발사(놓친
        // 슬롯은 버리고 전진), once는 소진(NULL + 비활성).
        let (adv_next, adv_enabled) = if is_once {
            (None, false)
        } else {
            (next_fire_after(&trigger, now_ms, tz), true)
        };
        let scheduled_at = sched.next_run_at.unwrap_or(now_ms);

        // ── cron missed: 발사 안 하고 전진. once-missed는 cosmetic(아래 발사로) ──
        if !is_once && now_ms - scheduled_at > MISS_GRACE_MS {
            let detail = format!("missed by {}ms (controller down?)", now_ms - scheduled_at);
            record(state, &sched.id, "missed", None, None, Some(&detail), adv_next, adv_enabled, now_ms).await;
            summary.missed += 1;
            continue;
        }

        // ── 겹침: 직전 run이 아직 pending/running이면 skip ──
        // last_run_id 없음 / runs::get None(행 부재) → 겹침 아님, 발사 진행(spec MINOR-16).
        if let Some(last_id) = &sched.last_run_id {
            if let Ok(Some(prev)) = runs::get(&state.db, last_id).await {
                if matches!(prev.status, runs::RunStatus::Pending | runs::RunStatus::Running) {
                    record(state, &sched.id, "skipped_overlap", None, None, Some("이전 run이 아직 실행 중"), adv_next, adv_enabled, now_ms).await;
                    summary.skipped += 1;
                    continue;
                }
            }
        }

        // ── 발사: scenario fetch → 매 발사 재검증(spec MAJOR-5) → spawn_run ──
        let scenario = match scenarios::get(&state.db, &sched.scenario_id).await {
            Ok(Some(s)) => s,
            Ok(None) => {
                record(state, &sched.id, "error", None, None, Some("시나리오를 찾을 수 없습니다"), adv_next, adv_enabled, now_ms).await;
                summary.errored += 1;
                continue;
            }
            Err(e) => {
                let d = format!("시나리오 조회 실패: {e}");
                record(state, &sched.id, "error", None, None, Some(&d), adv_next, adv_enabled, now_ms).await;
                summary.errored += 1;
                continue;
            }
        };
        let validated_meta = match validate_run_config(state, &sched.profile).await {
            Ok(m) => m,
            Err(e) => {
                let d = format!("검증 실패: {e}");
                record(state, &sched.id, "error", None, None, Some(&d), adv_next, adv_enabled, now_ms).await;
                summary.errored += 1;
                continue;
            }
        };
        let env: HashMap<String, String> =
            sched.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        match spawn_run(state, &scenario, &sched.profile, validated_meta, &env).await {
            Ok(row) => {
                record(state, &sched.id, "fired", Some(&row.id), Some(now_ms), None, adv_next, adv_enabled, now_ms).await;
                summary.fired += 1;
            }
            Err(e) => {
                let d = format!("발사 실패: {e}");
                record(state, &sched.id, "error", None, None, Some(&d), adv_next, adv_enabled, now_ms).await;
                summary.errored += 1;
            }
        }
    }
    summary
}

/// 스케줄 상태 UPDATE + 이벤트 INSERT를 묶어 적용. DB 에러는 로깅만(틱은
/// best-effort — 한 스케줄 실패가 다음 스케줄을 막지 않는다).
#[allow(clippy::too_many_arguments)]
async fn record(
    state: &AppState,
    schedule_id: &str,
    kind: &str,
    run_id: Option<&str>,
    fired_at: Option<i64>,
    detail: Option<&str>,
    next_run_at: Option<i64>,
    enabled: bool,
    at: i64,
) {
    if let Err(e) =
        schedules::mark_outcome(&state.db, schedule_id, next_run_at, enabled, kind, run_id, fired_at, detail).await
    {
        tracing::error!(error = %e, schedule_id, "scheduler: mark_outcome failed");
    }
    if let Err(e) = schedules::insert_event(&state.db, schedule_id, at, kind, run_id, detail).await {
        tracing::error!(error = %e, schedule_id, "scheduler: insert_event failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::AppState;
    use crate::dispatcher::NoopDispatcher;
    use crate::grpc::coordinator::CoordinatorState;
    use crate::schedule::trigger::Trigger;
    use crate::store::{self, runs::Profile};
    use std::collections::BTreeMap;
    use std::sync::Arc;

    const NOW: i64 = 1_700_000_000_000;

    async fn test_state() -> AppState {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let coord = CoordinatorState::new(db.clone());
        AppState {
            db,
            coord,
            dispatcher: Arc::new(NoopDispatcher),
            ui_dir: None,
            dataset_max_rows: 1_000_000,
            scheduler_tz: chrono_tz::UTC,
        }
    }

    fn profile() -> Profile {
        Profile {
            vus: 1,
            ramp_up_seconds: 0,
            duration_seconds: 1,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            data_binding: None,
            criteria: None,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
        }
    }

    async fn seed_scenario(db: &store::Db) -> String {
        let yaml = "version: 1\nname: s\nsteps: []\n";
        let sc = handicap_engine::Scenario::from_yaml(yaml).unwrap();
        store::scenarios::insert(db, &sc, yaml).await.unwrap().id
    }

    async fn insert_sched(
        db: &store::Db,
        sid: &str,
        p: &Profile,
        trigger: &Trigger,
        next_run_at: Option<i64>,
    ) -> String {
        schedules::insert(db, "s", sid, p, &BTreeMap::new(), trigger, true, next_run_at)
            .await
            .unwrap()
            .id
    }

    #[tokio::test]
    async fn cron_due_fires_and_advances() {
        let state = test_state().await;
        let sid = seed_scenario(&state.db).await;
        let t = Trigger::Cron { expr: "* * * * *".into() };
        let id = insert_sched(&state.db, &sid, &profile(), &t, Some(NOW - 1_000)).await;

        let sum = process_due_schedules(&state, NOW).await;
        assert_eq!(sum.fired, 1);

        let g = schedules::get(&state.db, &id).await.unwrap().unwrap();
        assert!(g.enabled, "cron stays enabled");
        assert!(g.next_run_at.unwrap() > NOW, "advanced to future");
        assert_eq!(g.last_status.as_deref(), Some("fired"));
        let run_id = g.last_run_id.expect("run created");
        let run = runs::get(&state.db, &run_id).await.unwrap().unwrap();
        assert_eq!(run.scenario_id, sid);
        let evs = schedules::recent_events(&state.db, &id, 10).await.unwrap();
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].kind, "fired");
        assert_eq!(evs[0].run_id.as_deref(), Some(run_id.as_str()));
    }

    #[tokio::test]
    async fn cron_missed_does_not_fire_but_advances() {
        let state = test_state().await;
        let sid = seed_scenario(&state.db).await;
        let t = Trigger::Cron { expr: "* * * * *".into() };
        let id = insert_sched(&state.db, &sid, &profile(), &t, Some(NOW - (MISS_GRACE_MS + 10_000))).await;

        let sum = process_due_schedules(&state, NOW).await;
        assert_eq!(sum.missed, 1);
        assert_eq!(sum.fired, 0);

        let g = schedules::get(&state.db, &id).await.unwrap().unwrap();
        assert!(g.last_run_id.is_none(), "did not fire");
        assert_eq!(g.last_status.as_deref(), Some("missed"));
        assert!(g.enabled && g.next_run_at.unwrap() > NOW, "advanced");
        let evs = schedules::recent_events(&state.db, &id, 10).await.unwrap();
        assert_eq!(evs[0].kind, "missed");
    }

    #[tokio::test]
    async fn overlap_skips_while_prev_active() {
        let state = test_state().await;
        let sid = seed_scenario(&state.db).await;
        // 직전 run(pending; NoopDispatcher라 pending 유지)을 시드.
        let prev = runs::insert(&state.db, &sid, "version: 1\nname: s\nsteps: []\n", &profile(), &serde_json::json!({}))
            .await.unwrap();
        let t = Trigger::Cron { expr: "* * * * *".into() };
        let id = insert_sched(&state.db, &sid, &profile(), &t, Some(NOW - 1_000)).await;
        // last_run_id = prev(pending)로 세팅(이전 발사를 흉내).
        schedules::mark_outcome(&state.db, &id, Some(NOW - 1_000), true, "fired", Some(&prev.id), Some(NOW - 60_000), None)
            .await.unwrap();

        let sum = process_due_schedules(&state, NOW).await;
        assert_eq!(sum.skipped, 1);
        assert_eq!(sum.fired, 0);
        let g = schedules::get(&state.db, &id).await.unwrap().unwrap();
        assert_eq!(g.last_status.as_deref(), Some("skipped_overlap"));
        assert_eq!(g.last_run_id.as_deref(), Some(prev.id.as_str()), "still points at running run");
    }

    #[tokio::test]
    async fn once_due_fires_then_disables() {
        let state = test_state().await;
        let sid = seed_scenario(&state.db).await;
        let t = Trigger::Once { run_at: NOW - 1_000 };
        let id = insert_sched(&state.db, &sid, &profile(), &t, Some(NOW - 1_000)).await;

        let sum = process_due_schedules(&state, NOW).await;
        assert_eq!(sum.fired, 1);
        let g = schedules::get(&state.db, &id).await.unwrap().unwrap();
        assert!(!g.enabled, "once disabled after firing");
        assert!(g.next_run_at.is_none(), "once exhausted");
        assert_eq!(g.last_status.as_deref(), Some("fired"));
    }

    #[tokio::test]
    async fn once_missed_still_fires_then_disables() {
        let state = test_state().await;
        let sid = seed_scenario(&state.db).await;
        let t = Trigger::Once { run_at: NOW - (MISS_GRACE_MS + 10_000) };
        let id = insert_sched(&state.db, &sid, &profile(), &t, Some(NOW - (MISS_GRACE_MS + 10_000))).await;

        let sum = process_due_schedules(&state, NOW).await;
        assert_eq!(sum.fired, 1, "once fires regardless of grace (cosmetic)");
        let g = schedules::get(&state.db, &id).await.unwrap().unwrap();
        assert!(!g.enabled && g.next_run_at.is_none());
    }

    #[tokio::test]
    async fn fire_validation_failure_records_error() {
        let state = test_state().await;
        let sid = seed_scenario(&state.db).await;
        // 잘못된 open-loop 프로파일(target_rps만, max_in_flight 없음) → validate_run_config Err.
        let mut p = profile();
        p.target_rps = Some(100);
        let t = Trigger::Cron { expr: "* * * * *".into() };
        let id = insert_sched(&state.db, &sid, &p, &t, Some(NOW - 1_000)).await;

        let sum = process_due_schedules(&state, NOW).await;
        assert_eq!(sum.errored, 1);
        assert_eq!(sum.fired, 0);
        let g = schedules::get(&state.db, &id).await.unwrap().unwrap();
        assert_eq!(g.last_status.as_deref(), Some("error"));
        assert!(g.last_error.is_some());
        assert!(g.enabled && g.next_run_at.unwrap() > NOW, "cron advances to retry next slot");
    }
}
```

- [ ] **Step 5: `schedule/mod.rs` 갱신**

```rust
//! Run 스케줄러: 순수 트리거 엔진(34a) + 영속화 루프(34b).
pub mod runner;
pub mod trigger;

pub use runner::run_scheduler;
```

- [ ] **Step 6: main.rs 배선 (CLI 3종 + TZ 파싱 + spawn)**

① `Args` struct에 3개 필드 추가(`worker_capacity_vus` 아래):
```rust
    /// Scheduler tick interval in seconds (how often due schedules are checked).
    #[arg(long, default_value_t = 30)]
    scheduler_tick_seconds: u64,
    /// IANA timezone for cron evaluation (e.g. Asia/Seoul, UTC). chrono::Local is
    /// silently UTC in stock containers, so cron TZ is explicit (spec §3).
    #[arg(long, default_value = "Asia/Seoul")]
    scheduler_timezone: String,
    /// Disable the in-process scheduler loop entirely (no auto-fire).
    #[arg(long, default_value_t = false)]
    scheduler_disabled: bool,
```
② TZ 파싱(`let state = ...` 전, db connect 부근):
```rust
    let scheduler_tz: chrono_tz::Tz = args.scheduler_timezone.parse().map_err(|_| {
        anyhow::anyhow!("invalid --scheduler-timezone: {}", args.scheduler_timezone)
    })?;
```
③ `AppState` literal에 필드 추가:
```rust
    let state = app::AppState {
        db: db.clone(),
        coord: coord_state.clone(),
        dispatcher: dispatcher.clone(),
        ui_dir: args.ui_dir.clone(),
        dataset_max_rows: args.dataset_max_rows,
        scheduler_tz,
    };
```
④ `AppState` literal **직후**, `let app_router = app::router(state);`(state move) **전**에 spawn:
```rust
    if !args.scheduler_disabled {
        let sched_state = state.clone();
        let tick = std::time::Duration::from_secs(args.scheduler_tick_seconds);
        tokio::spawn(handicap_controller::schedule::run_scheduler(sched_state, tick));
        info!(
            tick_seconds = args.scheduler_tick_seconds,
            tz = %scheduler_tz,
            "scheduler loop started"
        );
    }
```
> `AppState: Clone`(db 풀/CoordinatorState/SharedDispatcher 전부 Arc/cheap, `Tz`는 Copy)이라 clone은 cheap. `chrono_tz::Tz`는 `Copy`라 state로 move 후에도 `scheduler_tz` 로깅 가능.

- [ ] **Step 7: 빌드/테스트/clippy/fmt**

Run: `cargo build --workspace --tests` (AppState 필드 누락 사이트 0 확인)
Run: `cargo test -p handicap-controller` (runner 인라인 7개 포함 전체)
Run: `cargo clippy -p handicap-controller --all-targets -- -D warnings && cargo fmt --check`
Expected: 전부 PASS. (기존 통합 테스트도 GREEN = AppState 필드 추가 byte-identical 게이트.)

- [ ] **Step 8: keepalive 제거 + 커밋**

```bash
rm crates/controller/tests/_tdd_keepalive.rs
cargo build -p handicap-worker && cargo build --workspace   # warm
git add crates/controller/src/app.rs crates/controller/src/main.rs \
        crates/controller/src/schedule/runner.rs crates/controller/src/schedule/mod.rs \
        crates/controller/src/api/runs.rs \  # MAJOR-1: 인라인 test state_with literal 갱신
        crates/controller/tests/   # AppState literal 갱신된 모든 테스트
git commit -m "feat(controller): 스케줄러 루프 + main 배선 + AppState.scheduler_tz (34b)"
```
직후 `git log -1 --oneline` 확인. (`git add crates/controller/tests/`는 갱신된 기존 테스트만 — keepalive는 rm 됐는지 `git status`로 확인.)

---

## Task 4: `api/schedules.rs` (CRUD + preview-next + events) + 라우트

**Files:**
- Create: `crates/controller/src/api/schedules.rs`
- Modify: `crates/controller/src/api/mod.rs` (`pub mod schedules;`)
- Modify: `crates/controller/src/app.rs` (라우트 + import)
- Create: `crates/controller/tests/schedules_api_test.rs`

self-unblock: Step 1에서 통합 테스트 파일을 먼저 만든다(test-path 파일).

- [ ] **Step 1: 통합 테스트 작성** (`crates/controller/tests/schedules_api_test.rs`)

```rust
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::dispatcher::NoopDispatcher;
use handicap_controller::grpc::coordinator::CoordinatorState;
use handicap_controller::{app, store};
use serde_json::{Value, json};
use tower::ServiceExt;

fn make_app(db: handicap_controller::store::Db) -> axum::Router {
    let coord = CoordinatorState::new(db.clone());
    app::router(app::AppState {
        db,
        coord,
        dispatcher: Arc::new(NoopDispatcher),
        ui_dir: None,
        dataset_max_rows: 1_000_000,
        scheduler_tz: chrono_tz::UTC,
    })
}

async fn send(app: &axum::Router, method: Method, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let builder = Request::builder().method(method).uri(uri);
    let req = match body {
        Some(b) => builder
            .header("content-type", "application/json")
            .body(Body::from(b.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, v)
}

/// 시나리오를 만들고 id 반환(schedule.scenario_id FK).
async fn seed_scenario(app: &axum::Router) -> String {
    let yaml = "version: 1\nname: s\nsteps: []\n";
    let (status, v) = send(app, Method::POST, "/api/scenarios", Some(json!({ "yaml": yaml }))).await;
    assert_eq!(status, StatusCode::CREATED, "scenario seed: {v:?}");
    v["id"].as_str().unwrap().to_string()
}

fn profile() -> Value {
    json!({ "vus": 1, "duration_seconds": 1 })
}

#[tokio::test]
async fn create_list_get_update_delete_roundtrip() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let sid = seed_scenario(&app).await;

    // create (cron)
    let (status, created) = send(&app, Method::POST, "/api/schedules", Some(json!({
        "name": "nightly",
        "scenario_id": sid,
        "profile": profile(),
        "env": { "BASE_URL": "http://x" },
        "trigger": { "kind": "cron", "cron_expr": "0 2 * * *" },
        "enabled": true,
    }))).await;
    assert_eq!(status, StatusCode::CREATED, "{created:?}");
    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["trigger"]["kind"], "cron");
    assert_eq!(created["trigger"]["cron_expr"], "0 2 * * *");
    assert!(created["next_run_at"].is_number(), "next_run_at computed on create");

    // list
    let (status, list) = send(&app, Method::GET, "/api/schedules", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list["schedules"].as_array().unwrap().len(), 1);

    // get
    let (status, got) = send(&app, Method::GET, &format!("/api/schedules/{id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(got["name"], "nightly");

    // update → once
    let future = store::now_ms() + 3_600_000;
    let (status, updated) = send(&app, Method::PUT, &format!("/api/schedules/{id}"), Some(json!({
        "name": "oneshot",
        "scenario_id": sid,
        "profile": profile(),
        "env": {},
        "trigger": { "kind": "once", "run_at": future },
        "enabled": true,
    }))).await;
    assert_eq!(status, StatusCode::OK, "{updated:?}");
    assert_eq!(updated["trigger"]["kind"], "once");
    assert_eq!(updated["trigger"]["run_at"], future);

    // delete
    let (status, _) = send(&app, Method::DELETE, &format!("/api/schedules/{id}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = send(&app, Method::GET, &format!("/api/schedules/{id}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn create_rejects_bad_inputs() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let sid = seed_scenario(&app).await;

    // 잘못된 cron → 400
    let (status, _) = send(&app, Method::POST, "/api/schedules", Some(json!({
        "name": "a", "scenario_id": sid, "profile": profile(), "env": {},
        "trigger": { "kind": "cron", "cron_expr": "not a cron" },
    }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // 6-field cron → 400 (5-field 강제)
    let (status, _) = send(&app, Method::POST, "/api/schedules", Some(json!({
        "name": "b", "scenario_id": sid, "profile": profile(), "env": {},
        "trigger": { "kind": "cron", "cron_expr": "0 0 2 * * *" },
    }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // 과거 once → 400
    let (status, _) = send(&app, Method::POST, "/api/schedules", Some(json!({
        "name": "c", "scenario_id": sid, "profile": profile(), "env": {},
        "trigger": { "kind": "once", "run_at": 1_000 },
    }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // 없는 시나리오 → 404
    let (status, _) = send(&app, Method::POST, "/api/schedules", Some(json!({
        "name": "d", "scenario_id": "NOPE", "profile": profile(), "env": {},
        "trigger": { "kind": "cron", "cron_expr": "0 2 * * *" },
    }))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn duplicate_name_conflicts() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let sid = seed_scenario(&app).await;
    let body = json!({
        "name": "dup", "scenario_id": sid, "profile": profile(), "env": {},
        "trigger": { "kind": "cron", "cron_expr": "0 2 * * *" },
    });
    let (s1, _) = send(&app, Method::POST, "/api/schedules", Some(body.clone())).await;
    assert_eq!(s1, StatusCode::CREATED);
    let (s2, _) = send(&app, Method::POST, "/api/schedules", Some(body)).await;
    assert_eq!(s2, StatusCode::CONFLICT);
}

#[tokio::test]
async fn preview_next_returns_increasing_times_and_does_not_shadow_id_route() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);

    let (status, v) = send(&app, Method::POST, "/api/schedules/preview-next", Some(json!({
        "trigger": { "kind": "cron", "cron_expr": "0 2 * * *" },
        "count": 3,
    }))).await;
    // preview-next가 /schedules/{id}의 {id}로 새지 않고 핸들러에 도달(POST + 200).
    assert_eq!(status, StatusCode::OK, "{v:?}");
    let next = v["next"].as_array().unwrap();
    assert_eq!(next.len(), 3);
    let a = next[0].as_i64().unwrap();
    let b = next[1].as_i64().unwrap();
    assert!(b > a, "strictly increasing");
}

#[tokio::test]
async fn events_history_is_listed() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = seed_scenario(&app).await;
    let (_, created) = send(&app, Method::POST, "/api/schedules", Some(json!({
        "name": "e", "scenario_id": sid, "profile": profile(), "env": {},
        "trigger": { "kind": "cron", "cron_expr": "0 2 * * *" },
    }))).await;
    let id = created["id"].as_str().unwrap().to_string();
    // 이벤트 직접 시드(루프 없이 API 검증).
    handicap_controller::store::schedules::insert_event(&db, &id, 100, "fired", Some("RUN1"), None)
        .await.unwrap();

    let (status, v) = send(&app, Method::GET, &format!("/api/schedules/{id}/events"), None).await;
    assert_eq!(status, StatusCode::OK);
    let evs = v["events"].as_array().unwrap();
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0]["kind"], "fired");
    assert_eq!(evs[0]["run_id"], "RUN1");
}
```

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-controller --test schedules_api_test`
Expected: 컴파일 실패 — `api::schedules` 미존재 / 라우트 미등록.

- [ ] **Step 3: `api/schedules.rs` 작성**

```rust
use std::collections::BTreeMap;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::app::AppState;
use crate::error::ApiError;
use crate::schedule::trigger::{Trigger, next_fire_after, next_fires, validate_trigger};
use crate::store::runs::Profile;
use crate::store::{now_ms, scenarios, schedules};

/// 와이어 트리거(요청). discriminated union(kind) — UI Zod와 1:1.
#[derive(Debug, Deserialize)]
pub struct TriggerBody {
    pub kind: String, // 'once' | 'cron'
    #[serde(default)]
    pub cron_expr: Option<String>,
    #[serde(default)]
    pub run_at: Option<i64>,
}

impl TriggerBody {
    fn to_trigger(&self) -> Result<Trigger, ApiError> {
        match self.kind.as_str() {
            "once" => self
                .run_at
                .map(|run_at| Trigger::Once { run_at })
                .ok_or_else(|| ApiError::BadRequest("once 트리거는 run_at이 필요합니다".into())),
            "cron" => self
                .cron_expr
                .clone()
                .filter(|s| !s.trim().is_empty())
                .map(|expr| Trigger::Cron { expr })
                .ok_or_else(|| ApiError::BadRequest("cron 트리거는 cron_expr이 필요합니다".into())),
            other => Err(ApiError::BadRequest(format!("알 수 없는 트리거 종류: {other}"))),
        }
    }
}

/// 와이어 트리거(응답). internally-tagged → {"kind":"once","run_at":..} / {"kind":"cron","cron_expr":".."}.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TriggerResponse {
    Once { run_at: i64 },
    Cron { cron_expr: String },
}

#[derive(Debug, Deserialize)]
pub struct ScheduleBody {
    pub name: String,
    pub scenario_id: String,
    pub profile: Profile,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub trigger: TriggerBody,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
pub struct ScheduleResponse {
    pub id: String,
    pub name: String,
    pub scenario_id: String,
    pub profile: Profile,
    pub env: BTreeMap<String, String>,
    pub trigger: TriggerResponse,
    pub enabled: bool,
    pub next_run_at: Option<i64>,
    pub last_run_id: Option<String>,
    pub last_fired_at: Option<i64>,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct ScheduleSummary {
    pub id: String,
    pub name: String,
    pub scenario_id: String,
    pub trigger: TriggerResponse,
    pub enabled: bool,
    pub next_run_at: Option<i64>,
    pub last_status: Option<String>,
    pub last_fired_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct ScheduleListResponse {
    pub schedules: Vec<ScheduleSummary>,
}

#[derive(Debug, Serialize)]
pub struct EventResponse {
    pub id: String,
    pub at: i64,
    pub kind: String,
    pub run_id: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct EventsResponse {
    pub events: Vec<EventResponse>,
}

#[derive(Debug, Deserialize)]
pub struct PreviewBody {
    pub trigger: TriggerBody,
    #[serde(default = "default_preview_count")]
    pub count: usize,
}

fn default_preview_count() -> usize {
    3
}

#[derive(Debug, Serialize)]
pub struct PreviewResponse {
    pub next: Vec<i64>,
}

fn trigger_response(row: &schedules::ScheduleRow) -> TriggerResponse {
    match row.trigger() {
        Trigger::Once { run_at } => TriggerResponse::Once { run_at },
        Trigger::Cron { expr } => TriggerResponse::Cron { cron_expr: expr },
    }
}

fn to_response(row: schedules::ScheduleRow) -> ScheduleResponse {
    let trigger = trigger_response(&row);
    ScheduleResponse {
        id: row.id,
        name: row.name,
        scenario_id: row.scenario_id,
        profile: row.profile,
        env: row.env,
        trigger,
        enabled: row.enabled,
        next_run_at: row.next_run_at,
        last_run_id: row.last_run_id,
        last_fired_at: row.last_fired_at,
        last_status: row.last_status,
        last_error: row.last_error,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

/// UNIQUE(name) → 409, 그 외 → 500. environments::map_db_err 미러.
fn map_db_err(e: sqlx::Error) -> ApiError {
    if e.as_database_error()
        .map(|d| d.is_unique_violation())
        .unwrap_or(false)
    {
        return ApiError::Conflict("같은 이름의 스케줄이 이미 있습니다".into());
    }
    ApiError::from(e)
}

/// 공통 검증 게이트: 시나리오 존재(404) → profile(`validate_run_config`, 400) →
/// trigger(`validate_trigger`, 400). 통과 시 trigger + next_run_at 계산값 반환.
async fn gate(
    state: &AppState,
    body: &ScheduleBody,
) -> Result<(Trigger, Option<i64>), ApiError> {
    if body.name.trim().is_empty() {
        return Err(ApiError::BadRequest("이름은 비어 있을 수 없습니다".into()));
    }
    scenarios::get(&state.db, &body.scenario_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    // run/preset과 공유하는 권위 게이트(데이터셋/open-loop 검증).
    crate::api::runs::validate_run_config(state, &body.profile).await?;
    let trigger = body.trigger.to_trigger()?;
    let now = now_ms();
    validate_trigger(&trigger, now).map_err(ApiError::BadRequest)?;
    let next_run_at = next_fire_after(&trigger, now, state.scheduler_tz);
    Ok((trigger, next_run_at))
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<ScheduleBody>,
) -> Result<(StatusCode, Json<ScheduleResponse>), ApiError> {
    let (trigger, next_run_at) = gate(&state, &body).await?;
    let row = schedules::insert(
        &state.db,
        body.name.trim(),
        &body.scenario_id,
        &body.profile,
        &body.env,
        &trigger,
        body.enabled,
        next_run_at,
    )
    .await
    .map_err(map_db_err)?;
    Ok((StatusCode::CREATED, Json(to_response(row))))
}

pub async fn list(State(state): State<AppState>) -> Result<Json<ScheduleListResponse>, ApiError> {
    let rows = schedules::list(&state.db).await?;
    let schedules = rows
        .into_iter()
        .map(|r| {
            let trigger = trigger_response(&r);
            ScheduleSummary {
                id: r.id,
                name: r.name,
                scenario_id: r.scenario_id,
                trigger,
                enabled: r.enabled,
                next_run_at: r.next_run_at,
                last_status: r.last_status,
                last_fired_at: r.last_fired_at,
            }
        })
        .collect();
    Ok(Json(ScheduleListResponse { schedules }))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ScheduleResponse>, ApiError> {
    let row = schedules::get(&state.db, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ScheduleBody>,
) -> Result<Json<ScheduleResponse>, ApiError> {
    let (trigger, next_run_at) = gate(&state, &body).await?;
    let row = schedules::update(
        &state.db,
        &id,
        body.name.trim(),
        &body.scenario_id,
        &body.profile,
        &body.env,
        &trigger,
        body.enabled,
        next_run_at,
    )
    .await
    .map_err(map_db_err)?
    .ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    // 멱등: 없어도 204(events 선삭제 트랜잭션).
    schedules::delete(&state.db, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn events(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<EventsResponse>, ApiError> {
    // 404 if schedule absent.
    schedules::get(&state.db, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let rows = schedules::recent_events(&state.db, &id, 100).await?;
    let events = rows
        .into_iter()
        .map(|e| EventResponse {
            id: e.id,
            at: e.at,
            kind: e.kind,
            run_id: e.run_id,
            detail: e.detail,
        })
        .collect();
    Ok(Json(EventsResponse { events }))
}

pub async fn preview_next(
    State(state): State<AppState>,
    Json(body): Json<PreviewBody>,
) -> Result<Json<PreviewResponse>, ApiError> {
    let trigger = body.trigger.to_trigger()?;
    let now = now_ms();
    validate_trigger(&trigger, now).map_err(ApiError::BadRequest)?;
    let count = body.count.clamp(1, 50);
    let next = next_fires(&trigger, now, state.scheduler_tz, count);
    Ok(Json(PreviewResponse { next }))
}
```

- [ ] **Step 4: `api/mod.rs`에 모듈 선언**

`pub mod schedules;` 추가(`pub mod scenarios;` 옆).

- [ ] **Step 5: `app.rs` 라우트 등록**

① import(`:8-11`)에 `schedules as schedules_api` 추가:
```rust
use crate::api::{
    datasets as datasets_api, environments as environments_api, presets as presets_api,
    runs as runs_api, scenarios as scenarios_api, schedules as schedules_api,
    test_runs as test_runs_api,
};
```
② 라우트(environments 블록 아래, `/test-runs` 위)에 추가. **preview-next(static)를 `{id}`(capture) 앞에** — axum 0.8 matchit는 static을 우선하므로 순서 무관하지만 명시적으로:
```rust
        .route(
            "/schedules",
            post(schedules_api::create).get(schedules_api::list),
        )
        .route("/schedules/preview-next", post(schedules_api::preview_next))
        .route(
            "/schedules/{id}",
            get(schedules_api::get)
                .put(schedules_api::update)
                .delete(schedules_api::delete),
        )
        .route("/schedules/{id}/events", get(schedules_api::events))
```

- [ ] **Step 6: GREEN + 회귀 + clippy/fmt**

Run: `cargo test -p handicap-controller --test schedules_api_test`
Expected: 6 테스트 PASS.
Run: `cargo test -p handicap-controller` (전체 — 기존 통합 GREEN)
Run: `cargo clippy -p handicap-controller --all-targets -- -D warnings && cargo fmt --check`

- [ ] **Step 7: 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace   # warm
git add crates/controller/src/api/schedules.rs crates/controller/src/api/mod.rs \
        crates/controller/src/app.rs crates/controller/tests/schedules_api_test.rs
git commit -m "feat(controller): schedules CRUD REST + preview-next + events (34b)"
```
직후 `git log -1 --oneline` 확인.

---

## Task 5: ADR-0034 + CLAUDE.md / roadmap 갱신

**Files:**
- Create: `docs/adr/0034-run-scheduler.md`
- Modify: `CLAUDE.md` ("알아둘 결정들" + 상태 한 줄)
- Modify: `docs/roadmap.md` (스케줄러 항목 갱신)

`.md`-only 커밋 → pre-commit fast-path(cargo 게이트 skip).

- [ ] **Step 1: ADR-0034 작성** (MADR 포맷, spec §13 기반)

`docs/adr/0034-run-scheduler.md`:
```markdown
# 0034. Run 스케줄러 (예약/반복 실행)

- 상태: 채택
- 날짜: 2026-06-06

## 맥락

종료 run을 매번 손으로 `POST /api/runs` 하지 않고 특정 일시(once) 또는 반복(cron)으로
자동 발사하고 싶다. 반복 발사가 SLO verdict(A4a)·run 비교(A4b)·insights(A4c)와 맞물려
성능 회귀 감시 루프가 된다. (spec: 2026-06-06-run-scheduler-design.md)

## 결정

- **아키텍처**: 컨트롤러 내장 주기 `tokio::spawn` 루프(외부 K8s CronJob·사이드카 기각).
  컨트롤러는 db+coord+dispatcher를 쥔 always-on 조정자라 새 인프라 0.
- **트리거**: once(epoch ms) | cron(**5-field 표준 crontab**) 2종. UI 프리셋(매일/매주/간격)은
  클라에서 5-field cron으로 컴파일, 고급 탭은 raw cron. cron 파서 `croner`, `validate_trigger`가
  필드수==5 강제(croner는 6-field도 파싱하므로).
- **TZ**: 컨트롤러 단일 IANA TZ(`--scheduler-timezone`, 기본 `Asia/Seoul`, `chrono-tz`).
  `chrono::Local`은 stock 컨테이너에서 조용히 UTC라 명시. main.rs가 1곳에서 파싱해
  `AppState.scheduler_tz`로 주입(루프 + REST가 단일 소스 공유). per-schedule TZ는 연기.
- **의미론**: 겹침=skip(`skipped_overlap` 이벤트), 놓친 발사(다운)=버리고 전진(cron, grace
  300s) / once는 grace 무관 1회 발사 후 비활성. 모든 주목 이벤트를 append-only
  `schedule_events`에 기록(알림 레이어의 이음새).
- **발사 코어**: `api::runs::spawn_run`(34a 추출)을 REST `create`와 스케줄러 루프가 공유.
  매 발사 시 `validate_run_config` 재호출(생성 후 무효화 잡음 — TOCTOU 의도).
- **profile/시나리오**: profile/env는 스케줄 자체 스냅샷(profile_json/env_json), 시나리오 YAML은
  발사 시점 현재본 스냅샷(runs.insert 기존 동작).
- **저장**: migration 0011(`schedules` + `schedule_events`, `CREATE TABLE IF NOT EXISTS`).
  runs/proto/엔진/워커 무변경.
- **검증 HTTP 코드**: trigger 검증 위반·과거 once = **400**(test-run 전용 422 컨벤션 비위반),
  UNIQUE(name) = 409.
- **동시성**: 단일 인스턴스(ADR-0011), leader election 없음. 단일 루프 + 틱당 순차.

## 연기

알림(이메일/슬랙/웹훅, 이음새=`schedule_events`)·per-schedule TZ(+DST 정책)·catch-up 모드·
`runs.schedule_id` 역링크·이벤트 보존정책·프리셋에서 시드·멀티 컨트롤러.

## 결과

QA가 매니페스트 없이 반복 부하를 예약(제품 전제 ADR-0001). 백엔드(34a/34b) 완결 후
UI(34c)로 노출.
```

- [ ] **Step 2: `CLAUDE.md` 갱신**

① "알아둘 결정들" 목록 끝에 한 줄:
```markdown
- **0034** Run 스케줄러: 컨트롤러 내장 주기 루프 + once|5-field cron 트리거(`croner`, `validate_trigger` 필드수==5 강제) + 단일 IANA TZ(`AppState.scheduler_tz`, `--scheduler-timezone` 기본 Asia/Seoul) + skip-overlap/skip-missed(once 1회 늦게) + append-only `schedule_events`(알림 이음새) + `spawn_run` 공유 발사 코어(매 발사 `validate_run_config` 재검증) + migration 0011(`schedules`+`schedule_events`). 34a(트리거 엔진+spawn_run 추출) + 34b(영속화+루프+REST) 머지, 34c(UI) 잔여. 연기: 알림·per-schedule TZ·catch-up·보존정책.
```
② 상태 줄(파일 상단 "상태:" 단락)에 34b 머지 사실 한 줄 추가(기존 마지막 항목 뒤). 예:
```markdown
그리고 **(Run 스케줄러) 34a(트리거 엔진 `croner` + `spawn_run` 추출) + 34b(migration 0011 `schedules`/`schedule_events` + `store/schedules.rs` + 컨트롤러 내장 `run_scheduler` 루프 + `api/schedules.rs` CRUD/preview-next + main.rs CLI 3종 배선, ADR-0034) 구현·머지 완료 — 백엔드 완결, 34c(UI) 잔여.** 엔진·워커·proto 무변경, migration 0011 추가. 상세 ADR-0034 / spec `2026-06-06-run-scheduler-design.md`.
```

- [ ] **Step 3: `docs/roadmap.md` 갱신**

스케줄러 섹션(또는 신규 §스케줄러)에 34a/34b 완료 + 34c 잔여 + 연기 항목 반영. (정확한 위치는 `grep -n "스케줄\|scheduler\|34a\|34b" docs/roadmap.md`로 확인 후 한 단락.)

- [ ] **Step 4: 머지 마커 점검 + 커밋**

```bash
grep -rn '^<<<<<<<\|^>>>>>>>' CLAUDE.md docs/adr/0034-run-scheduler.md docs/roadmap.md || echo "no conflict markers"
git add docs/adr/0034-run-scheduler.md CLAUDE.md docs/roadmap.md
git commit -m "docs: Run 스케줄러 34b + ADR-0034"
```
(`.md`-only라 cargo 게이트 skip.) 직후 `git log -1 --oneline` 확인.

---

## 라이브 검증 (머지 전, 34b는 백엔드라 curl)

34b 머지 전 컨트롤러+워커를 띄우고 스케줄러 end-to-end 1회(루트 CLAUDE.md "로컬에서 curl로 직접 구동"):

```bash
cargo build -p handicap-worker --bin worker
./target/debug/controller --db /tmp/sched.db --ui-dir ui/dist \
    --scheduler-tick-seconds 2 --scheduler-timezone Asia/Seoul &
# (워커 타깃용 echo 서버 or wiremock — 빈 steps 시나리오면 워커가 빠르게 종료)
```

1. **preview-next**: `curl -sX POST localhost:8080/api/schedules/preview-next -H 'content-type: application/json' -d '{"trigger":{"kind":"cron","cron_expr":"0 2 * * *"},"count":3}'` → `{"next":[...3개 증가...]}`.
2. **시나리오 생성** → id 확보(`jq -Rs '{yaml:.}' f.yaml | curl ...`).
3. **1초 뒤 once 스케줄**: `run_at = (date +%s%3N) + 1000`으로 `POST /api/schedules` → 201, `next_run_at` 채워짐.
4. **틱(2s) 후 확인**: `GET /api/schedules/{id}` → `enabled:false`, `next_run_at:null`, `last_status:"fired"`, `last_run_id` 채워짐. `GET /api/schedules/{id}/events` → `fired` 이벤트(run_id). `GET /api/scenarios/{sid}/runs` → 그 run이 목록에 보임.
5. **매분 cron 스케줄**(`* * * * *`) 생성 → 한 틱 발사 후 `enabled` 유지 + `next_run_at` 미래로 전진 확인.

> `process_due_schedules` 직접 단언(인라인 테스트)이 1차 검증, curl 라이브는 main.rs spawn 배선·실 응답 shape(34c Zod 대비) 확인용 보조.

---

## Self-Review 체크 (작성자 기록)

- **Spec 커버리지**: §4 데이터 모델(2테이블+인덱스+배선) → Task 1. §5 5-field 강제(34a 인계 ①) → Task 2. §7 루프(`process_due_schedules`/`run_scheduler`/grace/겹침/missed/error/전진) + main 배선 → Task 3. §8 CRUD+preview-next+events+라우트 우선순위 → Task 4. §10 검증(400/409/404) → Task 4. §11 테스트(trigger 5-field·store round-trip/UNIQUE/events/cascade/due·process_due 6 케이스·API) → Task 1/2/3/4. §13 ADR → Task 5.
- **타입 일관성**: `ScheduleRow{trigger():Trigger}`/`ScheduleEventRow`(Task1) ↔ store fn 시그니처 ↔ runner 호출 ↔ api `to_response`/`gate`. `mark_outcome(db,id,next_run_at:Option<i64>,enabled:bool,last_status:&str,last_run_id:Option<&str>,last_fired_at:Option<i64>,last_error:Option<&str>)` — store 정의(Task1)·인라인 테스트·runner `record`(Task3) 일치. `next_fire_after(&Trigger,i64,Tz)`/`next_fires(&Trigger,i64,Tz,usize)` — 34a 머지 시그니처와 api/runner 호출 일치(Tz는 `state.scheduler_tz`). `spawn_run(&AppState,&ScenarioRow,&Profile,Option<DatasetMeta>,&HashMap)` — 34a 머지본, runner가 BTreeMap→HashMap clone.
- **플레이스홀더**: 없음(모든 Step에 실제 코드/명령/기대). roadmap 위치(Task5 Step3)는 grep로 확정 지시(파일 가변).
- **게이트 경계**: 각 Task = 1 green 커밋(dead_code/RED-only 단독 커밋 회피 — 루트 CLAUDE.md). store fn은 Task1에서 인라인 test가 즉시 소비, runner는 Task3 인라인 test·main spawn이 소비(미사용 pub 없음).

## 리뷰 검토 포인트 (spec-plan-reviewer에게) — 6개 전부 **타당** 판정

1. **TZ를 `AppState.scheduler_tz`로 단일화**(spec §7의 `run_scheduler(state,tick,tz)` tz-인자 대신) — API next_run_at/preview도 같은 TZ가 필요해서. → **타당**(`Tz: Copy` + Arc 필드 cheap clone 확인). spec §7은 자체 모순(2-arg 선언 vs 3-arg 호출) — plan이 2-arg로 일관 정리.
2. **5-field 강제를 `validate_trigger`(trigger.rs, 34a 파일)에 추가** vs API 레이어 한정. → **타당**(croner는 seconds/year-optional이라 5–7 field 파싱, `==5` 가드가 6·7 둘 다 거부; 34a 트리거 테스트는 6/7-field 미사용=무회귀; 단일 소스가 옳은 위치).
3. **once-missed = `fired` 이벤트로 단순화**(spec §7 cosmetic 문구 대비). → **타당**("fired ⟹ run 생성"이 더 깔끔한 불변식; once는 여전히 1회 늦게 발사 후 비활성 = 실질 spec 위반 아님).
4. **e2e/Helm `--scheduler-disabled` 미배선**. → **타당**(e2e_test.rs는 `app::router` 직접 구성·main 미경유=루프 안 뜸; 플래그는 main-launched 컨트롤러 전용, K8s/Helm은 34b 범위 밖).
5. **`GET /schedules/{id}`는 상세만**(이벤트는 `/events` 전용). → **타당**(더 깔끔한 REST shape; spec §9.1 Zod 스키마에도 events 필드 없어 34c와 일관 — **34c가 inline-events를 재도입하지 않게 주의**).
6. **마이그레이션 0011 번호**. → **타당**(파일 마이그레이션 0001–0007 + 0010, 0008/0009 Rust-guarded; 0010 execute = mod.rs:63; 0011이 다음).

## 리뷰 반영 (2026-06-06 spec-plan-reviewer, APPROVE-WITH-FIXES)

- **MAJOR-1 (반영)**: `api/runs.rs:657-669`의 인라인 test `state_with`도 진짜 `AppState {…}` literal — Task 3 Files/Step 3/Step 8(`git add`)에 명시 추가. 빠뜨리면 `cargo test -p handicap-controller`가 "missing field scheduler_tz"로 깨짐(이 src 파일은 Task 3 commit add 목록 누락 위험이 가장 큼).
- **MINOR-A (반영)**: trigger 테스트 기존 개수 6→7 정정(34a M2 fold-in `next_fires_count_zero` 포함) → 신규 후 8.
- **MINOR-C (반영)**: `crash_recovery_test`는 AppState literal 없음 → Task 3 사이트 목록에서 제거.
- **MINOR-E (반영)**: croner는 7-field(year-optional)도 파싱 → Task 2 테스트에 7-field 거부 단언 추가(`==5` 가드가 6·7 둘 다 막음 확인).
- **MINOR-B (무관)**: reviewer가 인용한 "lib.rs `pub mod schedule` 추가"는 spec §12의 것 — plan은 lib.rs를 안 건드림(34a가 이미 `lib.rs:11`에 추가). 확인 완료, plan 수정 없음.
- **MINOR-F/G (정보)**: spec §7 run_scheduler arity 모순·preview clamp(1..=50)로 count==0 contract 미경유 — 둘 다 plan은 일관·무해, 수정 불필요.
- 그 외 인용 다수 CONFIRMED: spawn_run/validate_run_config/trigger 시그니처, RunStatus variant, NoopDispatcher, 라우트 static 우선(A4b 선례), migration 0010 execute :63, chrono_tz `UTC`/`Copy`/`FromStr`.
```

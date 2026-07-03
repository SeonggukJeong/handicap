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
    /// 이 이벤트가 발사한 run의 verdict(read-time JOIN, fired·완료 run만 non-null).
    pub verdict: Option<crate::report::Verdict>,
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
    // sqlx 동적 Row API는 컬럼명(단축형)으로 `.get()` 키를 참조한다. LEFT JOIN 후
    // schedule_events.id 와 runs.id 가 둘 다 "id" 로 노출돼 충돌하므로 schedule_events
    // 컬럼 전체에 ev_* 별칭을 붙인다(qualified 이름으로 "단순화"하면 키는 여전히 단축형
    // "id" 라 런타임에 잘못된 컬럼을 읽는다 — 별칭 유지 필수). verdict_json 은
    // schedule_events 에 없어 충돌 없음.
    let rows = sqlx::query(
        "SELECT schedule_events.id AS ev_id, schedule_events.schedule_id AS ev_schedule_id, \
                schedule_events.at AS ev_at, schedule_events.kind AS ev_kind, \
                schedule_events.run_id AS ev_run_id, schedule_events.detail AS ev_detail, \
                r.verdict_json AS verdict_json \
         FROM schedule_events LEFT JOIN runs r ON r.id = schedule_events.run_id \
         WHERE schedule_events.schedule_id = ? ORDER BY schedule_events.at DESC LIMIT ?",
    )
    .bind(schedule_id)
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows
        .iter()
        .map(|r| ScheduleEventRow {
            id: r.get("ev_id"),
            schedule_id: r.get("ev_schedule_id"),
            at: r.get("ev_at"),
            kind: r.get("ev_kind"),
            run_id: r.get("ev_run_id"),
            detail: r.get("ev_detail"),
            verdict: r
                .get::<Option<String>, _>("verdict_json")
                .and_then(|s| serde_json::from_str(&s).ok()),
        })
        .collect())
}

/// 시나리오 삭제 soft 409 카운트용.
pub async fn count_by_scenario(db: &Db, scenario_id: &str) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM schedules WHERE scenario_id = ?")
        .bind(scenario_id)
        .fetch_one(db)
        .await
}

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
            worker_count: None,
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
        let row = insert(
            &db,
            "nightly",
            &sid,
            &profile(),
            &env,
            &trigger,
            true,
            Some(5_000),
        )
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
            &db,
            &row.id,
            "oneshot",
            &sid,
            &profile(),
            &env,
            &once,
            false,
            Some(9_999),
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
        let t = Trigger::Cron {
            expr: "0 2 * * *".into(),
        };
        insert(
            &db,
            "dup",
            &sid,
            &profile(),
            &BTreeMap::new(),
            &t,
            true,
            None,
        )
        .await
        .unwrap();
        let err = insert(
            &db,
            "dup",
            &sid,
            &profile(),
            &BTreeMap::new(),
            &t,
            true,
            None,
        )
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
        let t = Trigger::Cron {
            expr: "* * * * *".into(),
        };
        // arrived + enabled → due
        insert(
            &db,
            "a",
            &sid,
            &profile(),
            &BTreeMap::new(),
            &t,
            true,
            Some(100),
        )
        .await
        .unwrap();
        // future → not due
        insert(
            &db,
            "b",
            &sid,
            &profile(),
            &BTreeMap::new(),
            &t,
            true,
            Some(10_000),
        )
        .await
        .unwrap();
        // disabled → not due
        insert(
            &db,
            "c",
            &sid,
            &profile(),
            &BTreeMap::new(),
            &t,
            false,
            Some(100),
        )
        .await
        .unwrap();
        // next_run_at NULL → not due
        insert(&db, "d", &sid, &profile(), &BTreeMap::new(), &t, true, None)
            .await
            .unwrap();

        let due = due(&db, 1_000).await.unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].name, "a");
    }

    #[tokio::test]
    async fn mark_outcome_advances_and_preserves_last_run_on_non_fire() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sid = seed_scenario(&db).await;
        let t = Trigger::Cron {
            expr: "* * * * *".into(),
        };
        let row = insert(
            &db,
            "s",
            &sid,
            &profile(),
            &BTreeMap::new(),
            &t,
            true,
            Some(100),
        )
        .await
        .unwrap();
        // fired: last_run_id 세팅.
        mark_outcome(
            &db,
            &row.id,
            Some(200),
            true,
            "fired",
            Some("RUN1"),
            Some(150),
            None,
        )
        .await
        .unwrap();
        let g = get(&db, &row.id).await.unwrap().unwrap();
        assert_eq!(g.last_run_id.as_deref(), Some("RUN1"));
        assert_eq!(g.last_status.as_deref(), Some("fired"));
        // skipped: last_run_id 보존(COALESCE None), status 갱신.
        mark_outcome(
            &db,
            &row.id,
            Some(300),
            true,
            "skipped_overlap",
            None,
            None,
            Some("busy"),
        )
        .await
        .unwrap();
        let g = get(&db, &row.id).await.unwrap().unwrap();
        assert_eq!(
            g.last_run_id.as_deref(),
            Some("RUN1"),
            "last_run_id preserved"
        );
        assert_eq!(g.last_status.as_deref(), Some("skipped_overlap"));
        assert_eq!(g.last_error.as_deref(), Some("busy"));
    }

    #[tokio::test]
    async fn recent_events_resolves_run_verdict() {
        use crate::store::runs;
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sid = seed_scenario(&db).await;
        let env: BTreeMap<String, String> = BTreeMap::new();
        let sched = insert(
            &db,
            "s",
            &sid,
            &profile(),
            &env,
            &Trigger::Cron {
                expr: "0 2 * * *".into(),
            },
            true,
            None,
        )
        .await
        .unwrap();

        // 완료 run + verdict.
        let run = runs::insert(
            &db,
            &sid,
            "version: 1\nname: t\nsteps: []\n",
            &profile(),
            &serde_json::json!({}),
        )
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
                target: None,
            }],
        };
        runs::set_verdict(&db, &run.id, &v).await.unwrap();

        insert_event(&db, &sched.id, 1, "fired", Some(run.id.as_str()), None)
            .await
            .unwrap();
        insert_event(&db, &sched.id, 2, "skipped_overlap", None, Some("overlap"))
            .await
            .unwrap();

        let evs = recent_events(&db, &sched.id, 100).await.unwrap();
        // at DESC 정렬 → skipped(2) 먼저, fired(1) 다음.
        let fired = evs.iter().find(|e| e.kind == "fired").unwrap();
        assert!(
            fired.verdict.as_ref().unwrap().passed,
            "fired run verdict resolved"
        );
        let skipped = evs.iter().find(|e| e.kind == "skipped_overlap").unwrap();
        assert!(skipped.verdict.is_none(), "no run_id → no verdict");
    }

    #[tokio::test]
    async fn events_insert_recent_and_cascade_on_delete() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sid = seed_scenario(&db).await;
        let t = Trigger::Cron {
            expr: "* * * * *".into(),
        };
        let row = insert(
            &db,
            "s",
            &sid,
            &profile(),
            &BTreeMap::new(),
            &t,
            true,
            Some(100),
        )
        .await
        .unwrap();
        insert_event(&db, &row.id, 100, "fired", Some("RUN1"), None)
            .await
            .unwrap();
        insert_event(&db, &row.id, 200, "skipped_overlap", None, Some("busy"))
            .await
            .unwrap();
        let evs = recent_events(&db, &row.id, 10).await.unwrap();
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0].kind, "skipped_overlap", "at DESC → newest first");
        assert_eq!(evs[1].kind, "fired");

        delete(&db, &row.id).await.unwrap();
        let evs = recent_events(&db, &row.id, 10).await.unwrap();
        assert!(evs.is_empty(), "events deleted with the schedule");
    }
}

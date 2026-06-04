use serde::{Deserialize, Serialize};
use sqlx::Row;
use ulid::Ulid;

use super::Db;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Aborted,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Pending => "pending",
            RunStatus::Running => "running",
            RunStatus::Completed => "completed",
            RunStatus::Failed => "failed",
            RunStatus::Aborted => "aborted",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "pending" => RunStatus::Pending,
            "running" => RunStatus::Running,
            "completed" => RunStatus::Completed,
            "failed" => RunStatus::Failed,
            "aborted" => RunStatus::Aborted,
            _ => return None,
        })
    }
}

fn default_loop_cap() -> u32 {
    256
}

fn default_http_timeout() -> u32 {
    30
}

/// run-level SLO 기준. 모든 필드 Option — Some이면 활성 기준 1개. 전부 None이면 기준 없음.
/// (A2 일반 연산자/step-level은 후속; 출력 `Verdict`만 미리 일반형 — spec §10.)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Criteria {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_p50_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_p95_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_p99_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_error_rate: Option<f64>, // 분수 0.0..=1.0 (UI는 %로 입출력)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_rps: Option<f64>,
}

impl Criteria {
    /// 활성 기준이 하나라도 있는가. 전부 None이면 verdict를 만들지 않는다(spec §6).
    pub fn has_any(&self) -> bool {
        self.max_p50_ms.is_some()
            || self.max_p95_ms.is_some()
            || self.max_p99_ms.is_some()
            || self.max_error_rate.is_some()
            || self.min_rps.is_some()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub vus: u32,
    #[serde(default)]
    pub ramp_up_seconds: u32,
    pub duration_seconds: u32,
    #[serde(default = "default_loop_cap")]
    pub loop_breakdown_cap: u32,
    #[serde(default = "default_http_timeout")]
    pub http_timeout_seconds: u32,
    #[serde(default)]
    pub data_binding: Option<crate::binding::DataBinding>,
    #[serde(default)]
    pub criteria: Option<Criteria>,
    #[serde(default)]
    pub think_time: Option<handicap_engine::ThinkTime>,
    #[serde(default)]
    pub think_seed: Option<u32>,
}

pub struct RunRow {
    pub id: String,
    pub scenario_id: String,
    pub scenario_yaml: String,
    pub profile: Profile,
    pub env: serde_json::Value,
    pub status: RunStatus,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub created_at: i64,
    pub message: Option<String>,
}

pub async fn insert(
    db: &Db,
    scenario_id: &str,
    scenario_yaml: &str,
    profile: &Profile,
    env: &serde_json::Value,
) -> sqlx::Result<RunRow> {
    let id = Ulid::new().to_string();
    let now = super::now_ms();
    let profile_json = serde_json::to_string(profile).expect("serialize profile");
    let env_json = serde_json::to_string(env).expect("serialize env");
    sqlx::query(
        "INSERT INTO runs(id,scenario_id,scenario_yaml,profile_json,env_json,status,created_at) \
         VALUES(?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(scenario_id)
    .bind(scenario_yaml)
    .bind(&profile_json)
    .bind(&env_json)
    .bind(RunStatus::Pending.as_str())
    .bind(now)
    .execute(db)
    .await?;
    Ok(RunRow {
        id,
        scenario_id: scenario_id.to_string(),
        scenario_yaml: scenario_yaml.to_string(),
        profile: profile.clone(),
        env: env.clone(),
        status: RunStatus::Pending,
        started_at: None,
        ended_at: None,
        created_at: now,
        message: None,
    })
}

pub async fn get(db: &Db, id: &str) -> sqlx::Result<Option<RunRow>> {
    let row = sqlx::query(
        "SELECT id,scenario_id,scenario_yaml,profile_json,env_json,status,started_at,ended_at,created_at,message \
         FROM runs WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(r) = row else { return Ok(None) };
    let profile: Profile =
        serde_json::from_str(r.get::<String, _>("profile_json").as_str()).unwrap();
    let env: serde_json::Value =
        serde_json::from_str(r.get::<String, _>("env_json").as_str()).unwrap();
    let status =
        RunStatus::parse(r.get::<String, _>("status").as_str()).unwrap_or(RunStatus::Failed);
    Ok(Some(RunRow {
        id: r.get("id"),
        scenario_id: r.get("scenario_id"),
        scenario_yaml: r.get("scenario_yaml"),
        profile,
        env,
        status,
        started_at: r.get("started_at"),
        ended_at: r.get("ended_at"),
        created_at: r.get("created_at"),
        message: r.get("message"),
    }))
}

pub async fn list_by_scenario(db: &Db, scenario_id: &str) -> sqlx::Result<Vec<RunRow>> {
    let rows = sqlx::query(
        "SELECT id,scenario_id,scenario_yaml,profile_json,env_json,status,started_at,ended_at,created_at,message \
         FROM runs WHERE scenario_id = ? ORDER BY created_at DESC",
    )
    .bind(scenario_id)
    .fetch_all(db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let profile: Profile =
            serde_json::from_str(r.get::<String, _>("profile_json").as_str()).unwrap();
        let env: serde_json::Value =
            serde_json::from_str(r.get::<String, _>("env_json").as_str()).unwrap();
        let status =
            RunStatus::parse(r.get::<String, _>("status").as_str()).unwrap_or(RunStatus::Failed);
        out.push(RunRow {
            id: r.get("id"),
            scenario_id: r.get("scenario_id"),
            scenario_yaml: r.get("scenario_yaml"),
            profile,
            env,
            status,
            started_at: r.get("started_at"),
            ended_at: r.get("ended_at"),
            created_at: r.get("created_at"),
            message: r.get("message"),
        });
    }
    Ok(out)
}

pub async fn set_status(
    db: &Db,
    id: &str,
    status: RunStatus,
    started: Option<i64>,
    ended: Option<i64>,
) -> sqlx::Result<()> {
    let result = sqlx::query(
        "UPDATE runs SET status = ?, started_at = COALESCE(?, started_at), ended_at = COALESCE(?, ended_at) WHERE id = ? AND status != 'aborted'",
    )
    .bind(status.as_str())
    .bind(started)
    .bind(ended)
    .bind(id)
    .execute(db)
    .await?;
    let affected = result.rows_affected();
    if affected != 1 {
        tracing::warn!(
            run_id = %id, status = %status.as_str(), affected,
            "set_status updated {affected} rows (run already aborted, or unknown run_id)"
        );
    }
    Ok(())
}

pub async fn mark_aborted(db: &Db, id: &str) -> sqlx::Result<()> {
    let now = super::now_ms();
    sqlx::query("UPDATE runs SET status = 'aborted', ended_at = ? WHERE id = ?")
        .bind(now)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Mark a single run `failed` with a message and stamp `ended_at`. Used when
/// worker dispatch fails at run-create time so the failure is authoritative and
/// immediate (with a useful cause) instead of leaving the run `pending` for the
/// 60s registration watchdog to fail anonymously. Unlike `set_status`, this
/// records a `message` — the existing fail paths (watchdog/fail-fast) leave it
/// NULL because `set_status` has no message column.
pub async fn mark_failed(db: &Db, id: &str, message: &str) -> sqlx::Result<()> {
    let now = super::now_ms();
    sqlx::query("UPDATE runs SET status = 'failed', ended_at = ?, message = ? WHERE id = ?")
        .bind(now)
        .bind(message)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Returns `true` if any non-terminal run (status `pending` or `running`)
/// references `dataset_id` in its `profile_json.data_binding`.
/// Used by the dataset DELETE guard (spec §10, Slice 8c Task 13).
pub async fn dataset_in_use(db: &Db, dataset_id: &str) -> sqlx::Result<bool> {
    let rows = sqlx::query("SELECT profile_json FROM runs WHERE status IN ('pending','running')")
        .fetch_all(db)
        .await?;
    for r in rows {
        let pj: String = r.get("profile_json");
        if let Ok(profile) = serde_json::from_str::<Profile>(&pj) {
            if let Some(b) = &profile.data_binding {
                if b.dataset_id == dataset_id {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

/// Mark any run currently in `pending` or `running` as `failed` with a
/// message. Called on controller startup to recover from crash.
pub async fn mark_orphans_failed(db: &Db, message: &str) -> sqlx::Result<u64> {
    let now = super::now_ms();
    let res = sqlx::query(
        "UPDATE runs
            SET status = 'failed', ended_at = ?, message = ?
            WHERE status IN ('pending', 'running')",
    )
    .bind(now)
    .bind(message)
    .execute(db)
    .await?;
    Ok(res.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;

    async fn test_db() -> Db {
        store::connect("sqlite::memory:")
            .await
            .expect("in-memory db")
    }

    #[tokio::test]
    async fn set_status_missing_run_is_ok_noop() {
        let db = test_db().await;
        // No scenario/run inserted. Updating a non-existent run must NOT error (warn-only).
        let r = set_status(&db, "does-not-exist", RunStatus::Completed, None, None).await;
        assert!(
            r.is_ok(),
            "set_status on missing run should be a warn-only no-op, not an error"
        );
    }

    #[tokio::test]
    async fn set_status_happy_path_and_aborted_guard() {
        use crate::store::scenarios;
        use handicap_engine::Scenario;

        let db = test_db().await;

        // Insert a minimal scenario so the FK constraint is satisfied.
        let yaml = "version: 1\nname: test\nsteps: []";
        let scenario: Scenario = serde_yaml::from_str(yaml).unwrap();
        let sc = scenarios::insert(&db, &scenario, yaml).await.unwrap();

        // Insert a run in pending state.
        let profile = Profile {
            vus: 1,
            ramp_up_seconds: 0,
            duration_seconds: 1,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            data_binding: None,
            criteria: None,
            think_time: None,
            think_seed: None,
        };
        let run = insert(&db, &sc.id, yaml, &profile, &serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(run.status, RunStatus::Pending);

        // Normal transition: pending → running is Ok and reflected in DB.
        set_status(&db, &run.id, RunStatus::Running, Some(1000), None)
            .await
            .unwrap();
        let updated = get(&db, &run.id).await.unwrap().unwrap();
        assert_eq!(updated.status, RunStatus::Running);

        // Mark aborted via mark_aborted (simulates REST abort path).
        mark_aborted(&db, &run.id).await.unwrap();
        let aborted = get(&db, &run.id).await.unwrap().unwrap();
        assert_eq!(aborted.status, RunStatus::Aborted);

        // set_status on already-aborted run must still return Ok (the guard keeps
        // rows_affected == 0 — belt-and-suspenders contract must not be broken).
        let r = set_status(&db, &run.id, RunStatus::Completed, None, Some(2000)).await;
        assert!(r.is_ok(), "set_status on aborted run must return Ok");
        // Status must remain aborted — the guard held.
        let still_aborted = get(&db, &run.id).await.unwrap().unwrap();
        assert_eq!(still_aborted.status, RunStatus::Aborted);
    }

    #[test]
    fn criteria_has_any_reflects_fields() {
        assert!(!Criteria::default().has_any());
        assert!(
            Criteria {
                max_p95_ms: Some(500),
                ..Default::default()
            }
            .has_any()
        );
        assert!(
            Criteria {
                min_rps: Some(100.0),
                ..Default::default()
            }
            .has_any()
        );
    }

    #[test]
    fn profile_json_think_time_round_trip_and_old_row_defaults_none() {
        let json = r#"{"vus":1,"duration_seconds":2,"think_time":{"min_ms":100,"max_ms":500},"think_seed":7}"#;
        let p: Profile = serde_json::from_str(json).unwrap();
        assert_eq!(
            p.think_time,
            Some(handicap_engine::ThinkTime {
                min_ms: 100,
                max_ms: 500
            })
        );
        assert_eq!(p.think_seed, Some(7));
        // old row without the keys → None
        let old = r#"{"vus":1,"duration_seconds":2}"#;
        let p2: Profile = serde_json::from_str(old).unwrap();
        assert_eq!(p2.think_time, None);
        assert_eq!(p2.think_seed, None);
    }

    #[test]
    fn profile_without_criteria_field_deserializes_to_none() {
        // pre-A4a profile_json 행에는 criteria 키가 없다 — 하위 호환.
        let json = r#"{"vus":1,"ramp_up_seconds":0,"duration_seconds":2,"loop_breakdown_cap":256,"data_binding":null}"#;
        let p: Profile = serde_json::from_str(json).unwrap();
        assert!(p.criteria.is_none());
    }

    #[test]
    fn profile_with_criteria_round_trips() {
        let p = Profile {
            vus: 1,
            ramp_up_seconds: 0,
            duration_seconds: 2,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            data_binding: None,
            criteria: Some(Criteria {
                max_p95_ms: Some(500),
                max_error_rate: Some(0.01),
                ..Default::default()
            }),
            think_time: None,
            think_seed: None,
        };
        let s = serde_json::to_string(&p).unwrap();
        let back: Profile = serde_json::from_str(&s).unwrap();
        assert_eq!(p.criteria, back.criteria);
    }
}

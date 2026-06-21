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

/// step-level criterion (spec §2.1). metric×op(max/min)를 특정 http-leaf step에 적용.
/// target은 v1 필수(step-level 전용); 모델은 일반형 유지 → optional relax가 순수 가산.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Criterion {
    pub metric: String, // p50_ms|p95_ms|p99_ms|error_rate|4xx_rate|5xx_rate|4xx_count|5xx_count
    pub op: String,     // "max" | "min" (→ 출력 direction)
    pub threshold: f64, // rate 0.0..=1.0, ms/count >= 0
    pub target: String, // http-leaf step_id
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_4xx_rate: Option<f64>, // 분수 0.0..=1.0 (UI %), 분모=HTTP 응답 수
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_5xx_rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_4xx_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_5xx_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_window_rps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rps_warmup_seconds: Option<u32>, // min_window_rps 수식자 — None = 0. has_any에 미포함.
    /// step-level criteria (spec §2.1). 빈 리스트면 직렬화 생략 → migration-0·byte-identical.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub step_criteria: Vec<Criterion>,
}

impl Criteria {
    /// 활성 기준이 하나라도 있는가. 전부 None이면 verdict를 만들지 않는다(spec §6).
    pub fn has_any(&self) -> bool {
        self.max_p50_ms.is_some()
            || self.max_p95_ms.is_some()
            || self.max_p99_ms.is_some()
            || self.max_error_rate.is_some()
            || self.min_rps.is_some()
            || self.max_4xx_rate.is_some()
            || self.max_5xx_rate.is_some()
            || self.max_4xx_count.is_some()
            || self.max_5xx_count.is_some()
            || self.min_window_rps.is_some()
            || !self.step_criteria.is_empty()
        // 주의: rps_warmup_seconds는 의도적으로 제외(수식자, spec §4 N-3).
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    /// closed-loop VU 수. open-loop(`target_rps`)·VU 곡선(`vu_stages`)은 이 값을 무시하므로
    /// `#[serde(default)]`(0) — 그 모드 페이로드는 vus 생략 가능. closed-loop만
    /// `validate_run_config`가 `vus > 0`을 강제한다(serde required 아님).
    #[serde(default)]
    pub vus: u32,
    #[serde(default)]
    pub ramp_up_seconds: u32,
    pub duration_seconds: u32,
    #[serde(default = "default_loop_cap")]
    pub loop_breakdown_cap: u32,
    #[serde(default = "default_http_timeout")]
    pub http_timeout_seconds: u32,
    #[serde(default)]
    pub data_binding: Option<crate::binding::DataBinding>, // DEPRECATED: 레거시 단일(읽기 호환)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub data_bindings: Vec<crate::binding::DataBinding>, // 다중 — 신규 쓰기는 여기만 채움
    #[serde(default)]
    pub criteria: Option<Criteria>,
    #[serde(default)]
    pub think_time: Option<handicap_engine::ThinkTime>,
    #[serde(default)]
    pub think_seed: Option<u32>,
    #[serde(default)]
    pub target_rps: Option<u32>,
    #[serde(default)]
    pub max_in_flight: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stages: Option<Vec<handicap_engine::Stage>>,
    #[serde(default)]
    pub measure_phases: bool,
    /// Closed-loop VU 곡선 (spec §3.1). skip_serializing_if → UI Zod `.optional()`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vu_stages: Option<Vec<handicap_engine::Stage>>,
    /// VU 곡선 ramp-down 노브. absent = graceful (spec §2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ramp_down: Option<handicap_engine::RampDown>,
    /// 멀티워커 open-loop fan-out 수 (spec 2026-06-15). absent/Some(1) = 단일 워커
    /// (오늘과 byte-identical). open-loop 전용 — closed-loop은 vus/capacity로 N 유도.
    /// proto에는 없음(컨트롤러가 register 시 워커별 프로필을 분할).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_count: Option<u32>,
}

impl Profile {
    /// 효과적 바인딩 목록: data_bindings가 비어있지 않으면 그것, 비었으면 레거시
    /// data_binding을 1-원소로 fold. 모든 읽기 사이트는 이 접근자를 경유한다.
    pub fn data_bindings(&self) -> Vec<&crate::binding::DataBinding> {
        if !self.data_bindings.is_empty() {
            self.data_bindings.iter().collect()
        } else {
            self.data_binding.iter().collect()
        }
    }

    /// S-D §3.5: open-loop when fixed rate OR a non-empty stage curve is set.
    /// Empty `stages` ≡ absent. Single source of truth for every open-loop
    /// discriminator (validate + slot_count + worker count).
    pub fn is_open_loop(&self) -> bool {
        self.target_rps.is_some() || self.stages.as_ref().is_some_and(|s| !s.is_empty())
    }

    /// Closed-loop VU curve (vu_stages 비어있지 않음). `Some(vec![])` ≡ absent.
    /// 판별은 반드시 이 헬퍼로 — `vu_stages.is_some()` 직접 분기 금지 (spec §3.3).
    pub fn is_vu_curve(&self) -> bool {
        self.vu_stages.as_ref().is_some_and(|s| !s.is_empty())
    }

    /// 곡선의 최대 목표 VU — park-gate 슬랩 크기 = per_vu row 요구치 = enqueue
    /// total_vus (spec §3.3). 비어있으면 0 (is_vu_curve가 false인 경우만).
    pub fn vu_curve_max(&self) -> u32 {
        self.vu_stages
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|s| s.target)
            .max()
            .unwrap_or(0)
    }

    /// 풀 동시성 수요 = capacity_split 입력 + 사전검사 demand.
    /// closed: vus, open(고정+곡선): max_in_flight, vu-curve: vu_curve_max(가드 미호출·완전성).
    pub fn concurrency_demand(&self) -> u32 {
        if self.is_vu_curve() {
            self.vu_curve_max()
        } else if self.is_open_loop() {
            self.max_in_flight.unwrap_or(1)
        } else {
            self.vus
        }
    }

    /// 풀 N 상한(레이트-상한). 고정 모드서 0-share 워커(엔진 .max(1) 초과 발사)를
    /// 막으려면 N <= rate_peak이어야 한다. **풀 전용 — ADR-0038 `worker_count`
    /// (비-풀 fan-out) 노브와 무관.** closed: vus, open: min(max_in_flight, rate_peak).
    pub fn pool_worker_cap(&self) -> u32 {
        if self.is_vu_curve() {
            self.vu_curve_max()
        } else if self.is_open_loop() {
            let rate_peak = self.target_rps.unwrap_or_else(|| {
                self.stages
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .map(|s| s.target)
                    .max()
                    .unwrap_or(1)
            });
            self.max_in_flight.unwrap_or(1).min(rate_peak)
        } else {
            self.vus
        }
    }
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
    pub dropped: i64,
    /// A4a SLO verdict, 완료 시 영속(없으면/criteria 없으면 None). 손상 JSON도 None.
    pub verdict: Option<crate::report::Verdict>,
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
        dropped: 0,
        verdict: None,
    })
}

pub async fn get(db: &Db, id: &str) -> sqlx::Result<Option<RunRow>> {
    let row = sqlx::query(
        "SELECT id,scenario_id,scenario_yaml,profile_json,env_json,status,started_at,ended_at,created_at,message,dropped,verdict_json \
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
        dropped: r.get("dropped"),
        verdict: r
            .get::<Option<String>, _>("verdict_json")
            .and_then(|s| serde_json::from_str(&s).ok()),
    }))
}

pub async fn list_by_scenario(db: &Db, scenario_id: &str) -> sqlx::Result<Vec<RunRow>> {
    let rows = sqlx::query(
        "SELECT id,scenario_id,scenario_yaml,profile_json,env_json,status,started_at,ended_at,created_at,message,dropped,verdict_json \
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
            dropped: r.get("dropped"),
            verdict: r
                .get::<Option<String>, _>("verdict_json")
                .and_then(|s| serde_json::from_str(&s).ok()),
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

/// Like [`mark_failed`] but only transitions a run that is still active
/// (`pending`/`running`). Returns `true` if it changed the row. Used by the
/// subprocess reaper to fail a run whose worker process died without reporting
/// a terminal phase — WITHOUT clobbering a run already finalized by the gRPC
/// paths (`record_phase` Completed/Failed/Aborted, user abort). The single
/// guarded UPDATE avoids a check-then-write race with those concurrent paths.
pub async fn mark_failed_if_active(db: &Db, id: &str, message: &str) -> sqlx::Result<bool> {
    let now = super::now_ms();
    let res = sqlx::query(
        "UPDATE runs SET status = 'failed', ended_at = ?, message = ? \
         WHERE id = ? AND status IN ('pending', 'running')",
    )
    .bind(now)
    .bind(message)
    .bind(id)
    .execute(db)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// Returns `true` if any non-terminal run (status `pending` or `running`)
/// references `dataset_id` in any of its `profile_json` data bindings (the
/// `data_bindings` accessor folds the legacy single field, so both shapes count).
/// Used by the dataset DELETE guard (spec §10, Slice 8c Task 13).
pub async fn dataset_in_use(db: &Db, dataset_id: &str) -> sqlx::Result<bool> {
    let rows = sqlx::query("SELECT profile_json FROM runs WHERE status IN ('pending','running')")
        .fetch_all(db)
        .await?;
    for r in rows {
        let pj: String = r.get("profile_json");
        if let Ok(profile) = serde_json::from_str::<Profile>(&pj) {
            if profile
                .data_bindings()
                .iter()
                .any(|b| b.dataset_id == dataset_id)
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

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

    fn profile_fixture(f: impl FnOnce(&mut Profile)) -> Profile {
        let mut p = Profile {
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
        };
        f(&mut p);
        p
    }

    fn stage(target: u32, dur: u32) -> handicap_engine::Stage {
        handicap_engine::Stage {
            target,
            duration_seconds: dur,
        }
    }

    #[test]
    fn concurrency_demand_by_mode() {
        // closed: vus
        let p = profile_fixture(|p| {
            p.vus = 50;
        });
        assert_eq!(p.concurrency_demand(), 50);
        // open fixed: max_in_flight
        let p = profile_fixture(|p| {
            p.vus = 0;
            p.target_rps = Some(100);
            p.max_in_flight = Some(20);
        });
        assert_eq!(p.concurrency_demand(), 20);
    }

    #[test]
    fn pool_worker_cap_by_mode() {
        // closed: vus
        let p = profile_fixture(|p| {
            p.vus = 50;
        });
        assert_eq!(p.pool_worker_cap(), 50);
        // open fixed: min(max_in_flight, target_rps)
        let p = profile_fixture(|p| {
            p.vus = 0;
            p.target_rps = Some(3);
            p.max_in_flight = Some(30);
        });
        assert_eq!(p.pool_worker_cap(), 3);
        let p = profile_fixture(|p| {
            p.vus = 0;
            p.target_rps = Some(100);
            p.max_in_flight = Some(20);
        });
        assert_eq!(p.pool_worker_cap(), 20);
        // open curve: min(max_in_flight, max(stage.target))
        let p = profile_fixture(|p| {
            p.vus = 0;
            p.max_in_flight = Some(30);
            p.stages = Some(vec![stage(10, 5), stage(40, 5)]);
        });
        assert_eq!(p.pool_worker_cap(), 30); // min(30, 40)
    }

    #[test]
    fn profile_deserializes_without_vus_defaulting_to_zero() {
        // open-loop 페이로드는 vus를 안 보내도 된다 — serde default(0)로 채워지고
        // open-loop은 vus 값을 무시(부하=target_rps+max_in_flight). closed-loop만
        // validate_run_config가 vus>0를 강제한다.
        let p: Profile =
            serde_json::from_str(r#"{"target_rps":2000,"max_in_flight":20,"duration_seconds":5}"#)
                .expect("open-loop profile without vus must deserialize");
        assert_eq!(p.vus, 0);
        assert!(p.is_open_loop());
    }

    #[test]
    fn criterion_serde_round_trip_and_skip_when_empty() {
        // 빈 step_criteria는 직렬화에서 생략(byte-identical) — 키가 없어야 한다.
        let c = Criteria::default();
        let v = serde_json::to_value(&c).unwrap();
        assert!(
            v.get("step_criteria").is_none(),
            "빈 step_criteria는 생략되어야 한다"
        );

        // 비어있지 않으면 round-trip.
        let c2 = Criteria {
            step_criteria: vec![Criterion {
                metric: "p95_ms".into(),
                op: "max".into(),
                threshold: 300.0,
                target: "STEP01".into(),
            }],
            ..Default::default()
        };
        let json = serde_json::to_string(&c2).unwrap();
        let back: Criteria = serde_json::from_str(&json).unwrap();
        assert_eq!(c2, back);
        assert!(c2.has_any(), "step_criteria만 있어도 has_any는 true");
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

    /// Seed one `pending` run (scenario FK satisfied) and return its id.
    async fn seed_pending(db: &Db) -> String {
        use crate::store::scenarios;
        use handicap_engine::Scenario;
        let yaml = "version: 1\nname: test\nsteps: []";
        let scenario: Scenario = serde_yaml::from_str(yaml).unwrap();
        let sc = scenarios::insert(db, &scenario, yaml).await.unwrap();
        let profile = Profile {
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
        };
        insert(db, &sc.id, yaml, &profile, &serde_json::json!({}))
            .await
            .unwrap()
            .id
    }

    #[tokio::test]
    async fn mark_failed_if_active_transitions_active_runs_with_message() {
        let db = test_db().await;

        // pending → failed (true) + message recorded.
        let pending = seed_pending(&db).await;
        let changed = mark_failed_if_active(&db, &pending, "worker died")
            .await
            .unwrap();
        assert!(changed, "pending run must transition to failed");
        let row = get(&db, &pending).await.unwrap().unwrap();
        assert_eq!(row.status, RunStatus::Failed);
        assert_eq!(row.message.as_deref(), Some("worker died"));
        assert!(row.ended_at.is_some(), "failure stamps ended_at");

        // running → failed (true).
        let running = seed_pending(&db).await;
        set_status(&db, &running, RunStatus::Running, Some(1), None)
            .await
            .unwrap();
        assert!(
            mark_failed_if_active(&db, &running, "x").await.unwrap(),
            "running run must transition to failed"
        );
    }

    #[tokio::test]
    async fn mark_failed_if_active_is_noop_on_terminal_runs() {
        let db = test_db().await;

        // completed → unchanged (gRPC path already finalized it; reaper must not clobber).
        let completed = seed_pending(&db).await;
        set_status(&db, &completed, RunStatus::Completed, None, Some(2))
            .await
            .unwrap();
        assert!(
            !mark_failed_if_active(&db, &completed, "late")
                .await
                .unwrap(),
            "completed run must NOT be clobbered to failed"
        );
        assert_eq!(
            get(&db, &completed).await.unwrap().unwrap().status,
            RunStatus::Completed
        );

        // aborted → unchanged.
        let aborted = seed_pending(&db).await;
        mark_aborted(&db, &aborted).await.unwrap();
        assert!(
            !mark_failed_if_active(&db, &aborted, "late").await.unwrap(),
            "aborted run must NOT be clobbered to failed"
        );
        assert_eq!(
            get(&db, &aborted).await.unwrap().unwrap().status,
            RunStatus::Aborted
        );

        // unknown run id → no-op false (no panic).
        assert!(
            !mark_failed_if_active(&db, "does-not-exist", "x")
                .await
                .unwrap()
        );
    }

    #[test]
    fn has_any_reflects_new_status_and_window_fields() {
        // 신규 status-class / per-window 기준이 has_any를 켠다.
        assert!(
            Criteria {
                max_5xx_rate: Some(0.01),
                ..Default::default()
            }
            .has_any()
        );
        assert!(
            Criteria {
                max_4xx_count: Some(0),
                ..Default::default()
            }
            .has_any()
        );
        assert!(
            Criteria {
                min_window_rps: Some(1.0),
                ..Default::default()
            }
            .has_any()
        );
        // rps_warmup_seconds는 수식자 — 그것만으론 verdict를 만들지 않는다(N-3).
        assert!(
            !Criteria {
                rps_warmup_seconds: Some(5),
                ..Default::default()
            }
            .has_any()
        );
        assert!(!Criteria::default().has_any());
    }

    #[test]
    fn criteria_new_fields_serde_round_trip() {
        let c = Criteria {
            max_4xx_rate: Some(0.1),
            max_5xx_rate: Some(0.0),
            max_4xx_count: Some(3),
            max_5xx_count: Some(0),
            min_window_rps: Some(50.0),
            rps_warmup_seconds: Some(5),
            ..Default::default()
        };
        let j = serde_json::to_string(&c).unwrap();
        let back: Criteria = serde_json::from_str(&j).unwrap();
        assert_eq!(c, back);
        // None 필드는 직렬화에서 생략(skip_serializing_if).
        let empty = serde_json::to_string(&Criteria::default()).unwrap();
        assert_eq!(empty, "{}");
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
    fn profile_open_loop_fields_roundtrip_and_default_absent() {
        // absent → None (back-compat with old profile_json rows)
        let p: Profile = serde_json::from_str(r#"{"vus":1,"duration_seconds":1}"#).unwrap();
        assert_eq!(p.target_rps, None);
        assert_eq!(p.max_in_flight, None);
        // present → round-trips
        let p2: Profile = serde_json::from_str(
            r#"{"vus":0,"duration_seconds":10,"target_rps":500,"max_in_flight":64}"#,
        )
        .unwrap();
        assert_eq!(p2.target_rps, Some(500));
        assert_eq!(p2.max_in_flight, Some(64));
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
            data_bindings: vec![],
            criteria: Some(Criteria {
                max_p95_ms: Some(500),
                max_error_rate: Some(0.01),
                ..Default::default()
            }),
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
            measure_phases: false,
            vu_stages: None,
            ramp_down: None,
            worker_count: None,
        };
        let s = serde_json::to_string(&p).unwrap();
        let back: Profile = serde_json::from_str(&s).unwrap();
        assert_eq!(p.criteria, back.criteria);
    }

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

    #[test]
    fn legacy_single_binding_folds_into_data_bindings_accessor() {
        // 옛 profile_json: data_binding(단일) only, data_bindings 없음
        let json = r#"{"vus":1,"ramp_up_seconds":0,"duration_seconds":2,
            "data_binding":{"dataset_id":"01J","policy":"per_vu","mappings":[]}}"#;
        let p: Profile = serde_json::from_str(json).unwrap();
        let eff = p.data_bindings();
        assert_eq!(eff.len(), 1);
        assert_eq!(eff[0].dataset_id, "01J");
    }

    #[test]
    fn data_bindings_vec_takes_precedence_over_legacy() {
        let json = r#"{"vus":1,"ramp_up_seconds":0,"duration_seconds":2,
            "data_bindings":[
                {"dataset_id":"A","policy":"per_vu","mappings":[]},
                {"dataset_id":"B","policy":"unique","mappings":[]}]}"#;
        let p: Profile = serde_json::from_str(json).unwrap();
        assert_eq!(p.data_bindings().len(), 2);
    }

    #[test]
    fn no_binding_yields_empty_accessor() {
        let json = r#"{"vus":1,"ramp_up_seconds":0,"duration_seconds":2}"#;
        let p: Profile = serde_json::from_str(json).unwrap();
        assert!(p.data_bindings().is_empty());
    }

    #[test]
    fn profile_stages_serde_roundtrip_and_default_absent() {
        // present → parses
        let j = serde_json::json!({
            "vus": 0, "duration_seconds": 60, "max_in_flight": 50,
            "stages": [{"target": 200, "duration_seconds": 30}, {"target": 0, "duration_seconds": 30}]
        });
        let p: Profile = serde_json::from_value(j).unwrap();
        assert_eq!(p.stages.as_ref().unwrap().len(), 2);
        assert_eq!(p.stages.as_ref().unwrap()[0].target, 200);
        // absent → None (old rows, no migration)
        let j2 = serde_json::json!({ "vus": 1, "duration_seconds": 10 });
        let p2: Profile = serde_json::from_value(j2).unwrap();
        assert!(p2.stages.is_none());
        // None → omitted from output (skip_serializing_if)
        let out = serde_json::to_value(&p2).unwrap();
        assert!(out.get("stages").is_none());
    }
}

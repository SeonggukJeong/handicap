//! controller in-process 구동 진입점(bundle 전용). `main.rs` bundle 부트스트랩을
//! 라이브러리로 추출한 것 — desktop 셸(Slice 2)·standalone bundle exe가 함께 쓴다.

use std::net::SocketAddr;
use std::time::Duration;

use anyhow::Context;

use crate::grpc::coordinator::{CoordinatorState, DEFAULT_WORKER_CAPACITY_VUS};
use crate::store::Db;

// Task 3 (run_in_process) will use this constant within this module.
#[allow(dead_code)]
const GRACEFUL_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

/// `SettingsState::build`에 넘길 8개 런타임 설정의 CLI-기본 시드.
/// 필드명·기본값은 `main.rs` `ControllerArgs`의 `default_value_t`와 1:1.
#[derive(Debug, Clone)]
pub struct SettingsSeeds {
    pub worker_capacity_vus: u32,
    pub dataset_max_rows: u64,
    pub scheduler_tick_seconds: u64,
    pub pool_heartbeat_interval_seconds: u64,
    pub pool_stale_timeout_seconds: u64,
    pub pool_keepalive_seconds: u64,
    pub run_startup_grace_seconds: u64,
    pub run_backstop_grace_seconds: u64,
}

impl Default for SettingsSeeds {
    fn default() -> Self {
        Self {
            worker_capacity_vus: DEFAULT_WORKER_CAPACITY_VUS,
            dataset_max_rows: 1_000_000,
            scheduler_tick_seconds: 30,
            pool_heartbeat_interval_seconds: 10,
            pool_stale_timeout_seconds: 30,
            pool_keepalive_seconds: 20,
            run_startup_grace_seconds: 90,
            run_backstop_grace_seconds: 120,
        }
    }
}

impl SettingsSeeds {
    /// `SettingsState::build(&overrides, &seeds)`가 받는 `(key, i64)` 시드 슬라이스.
    /// R5c stale-clamp는 build 호출 *전*에 raw 시드에 대해 별도로 처리하므로 여기선 raw 값만.
    ///
    /// 주의(리뷰 적발): `scheduler_tick_seconds`·`pool_keepalive_seconds`는 `SETTINGS`
    /// 레지스트리에 **readonly(`mutable:false`)** 항목이라(settings.rs:144/154) `build`가
    /// 가변 스냅샷이 아니라 `readonly` 표시값으로만 보관한다(settings.rs:252). 결정 지점은
    /// settings 스냅샷이 아니라 `SettingsSeeds` 필드에서 **직접** 읽는다(run_in_process §8
    /// scheduler tick·§11 keepalive·가변 accessor 부재). main.rs:272/275도 같은 8키를
    /// 넘기므로 parity 유지 — 미래 독자가 "죽은 시드"로 오인해 제거하지 않도록 8키를 그대로 둔다.
    // Task 3 (run_in_process) calls this to build the settings seed slice.
    #[allow(dead_code)]
    fn to_seed_array(&self) -> [(&'static str, i64); 8] {
        [
            ("worker_capacity_vus", self.worker_capacity_vus as i64),
            ("dataset_max_rows", self.dataset_max_rows as i64),
            ("scheduler_tick_seconds", self.scheduler_tick_seconds as i64),
            (
                "pool_heartbeat_interval_seconds",
                self.pool_heartbeat_interval_seconds as i64,
            ),
            (
                "pool_stale_timeout_seconds",
                self.pool_stale_timeout_seconds as i64,
            ),
            ("pool_keepalive_seconds", self.pool_keepalive_seconds as i64),
            (
                "run_startup_grace_seconds",
                self.run_startup_grace_seconds as i64,
            ),
            (
                "run_backstop_grace_seconds",
                self.run_backstop_grace_seconds as i64,
            ),
        ]
    }
}

/// in-process controller 구동 설정. `db: None` → dirs data-local-dir의 기본 DB,
/// `rest`/`grpc` 기본 `127.0.0.1:0`(OS가 빈 포트 할당). **고정: worker_mode = Subprocess, ui_dir = None.**
#[derive(Clone)]
pub struct InProcessConfig {
    pub db: Option<String>,
    pub rest: SocketAddr,
    pub grpc: SocketAddr,
    pub worker_token: Option<String>,
    pub scheduler_disabled: bool,
    pub scheduler_timezone: String,
    pub settings_seeds: SettingsSeeds,
}

impl Default for InProcessConfig {
    fn default() -> Self {
        Self {
            db: None,
            rest: SocketAddr::from(([127, 0, 0, 1], 0)),
            grpc: SocketAddr::from(([127, 0, 0, 1], 0)),
            worker_token: None,
            scheduler_disabled: false,
            scheduler_timezone: "Asia/Seoul".to_string(),
            settings_seeds: SettingsSeeds::default(),
        }
    }
}

impl std::fmt::Debug for InProcessConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InProcessConfig")
            .field("db", &self.db)
            .field("rest", &self.rest)
            .field("grpc", &self.grpc)
            .field(
                "worker_token",
                &self.worker_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field("scheduler_disabled", &self.scheduler_disabled)
            .field("scheduler_timezone", &self.scheduler_timezone)
            .field("settings_seeds", &self.settings_seeds)
            .finish()
    }
}

/// serve 태스크를 graceful drain하되 **절대 무한 대기하지 않는다**(스펙 §6).
/// `timeout` 내 완료 → `true`. 초과 → 태스크를 hard-abort하고 `false`.
/// (JoinHandle을 그냥 drop하면 detach될 뿐 abort되지 않으므로 명시적 `abort()` 필요.)
// Task 3 (run_in_process shutdown path) calls this function.
#[allow(dead_code)]
async fn bounded_drain(mut handle: tokio::task::JoinHandle<()>, timeout: Duration) -> bool {
    match tokio::time::timeout(timeout, &mut handle).await {
        Ok(_) => true,
        Err(_) => {
            handle.abort();
            let _ = handle.await;
            false
        }
    }
}

/// 활성(`pending`/`running`) run에 in-memory Abort를 보낸다(send-only).
/// `coord.abort(id)`는 in-memory 워커 엔트리가 없으면 `false`를 돌려주는데(아직 미등록 pending 등)
/// 이는 **no-op이지 에러가 아니다** — 그런 run은 워커 self-cancel(R4b)·다음 startup
/// `mark_orphans_failed`(R4c)가 커버한다. 반환값은 활성 run 개수.
pub async fn abort_all(coord: &CoordinatorState, db: &Db) -> anyhow::Result<usize> {
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM runs WHERE status IN ('pending','running')")
            .fetch_all(db)
            .await
            .context("query active run ids")?;
    for id in &ids {
        let _ = coord.abort(id).await;
    }
    Ok(ids.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;

    #[test]
    fn settings_seeds_default_maps_keys_and_values() {
        let arr = SettingsSeeds::default().to_seed_array();
        assert_eq!(arr.len(), 8);
        assert_eq!(
            arr[0],
            ("worker_capacity_vus", DEFAULT_WORKER_CAPACITY_VUS as i64)
        );
        assert_eq!(arr[1], ("dataset_max_rows", 1_000_000_i64));
        assert_eq!(arr[2], ("scheduler_tick_seconds", 30));
        assert_eq!(arr[3], ("pool_heartbeat_interval_seconds", 10));
        assert_eq!(arr[4], ("pool_stale_timeout_seconds", 30));
        assert_eq!(arr[5], ("pool_keepalive_seconds", 20));
        assert_eq!(arr[6], ("run_startup_grace_seconds", 90));
        assert_eq!(arr[7], ("run_backstop_grace_seconds", 120));
    }

    #[test]
    fn in_process_config_default_binds_ephemeral_localhost() {
        let c = InProcessConfig::default();
        assert_eq!(c.rest.ip().to_string(), "127.0.0.1");
        assert_eq!(c.rest.port(), 0);
        assert_eq!(c.grpc.ip().to_string(), "127.0.0.1");
        assert_eq!(c.grpc.port(), 0);
        assert_eq!(c.scheduler_timezone, "Asia/Seoul");
        assert!(c.db.is_none());
        assert!(c.worker_token.is_none());
        assert!(!c.scheduler_disabled);
    }

    #[tokio::test]
    async fn bounded_drain_returns_true_when_task_finishes() {
        let h = tokio::spawn(async {});
        assert!(bounded_drain(h, Duration::from_secs(5)).await);
    }

    #[tokio::test]
    async fn bounded_drain_hard_stops_on_timeout() {
        // pending 태스크 → 타임아웃 → hard-stop. 테스트가 끝난다는 것 자체가 hang 안 함의 증거.
        let h = tokio::spawn(std::future::pending::<()>());
        assert!(!bounded_drain(h, Duration::from_millis(50)).await);
    }

    #[tokio::test]
    async fn abort_all_counts_active_runs_and_tolerates_absent_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let db_url = store::url_from_path(&tmp.path().join("a.db").display().to_string());
        let db = store::connect(&db_url).await.unwrap();
        // FK: runs.scenario_id REFERENCES scenarios(id) — insert seed scenario first.
        sqlx::query(
            "INSERT INTO scenarios(id,name,yaml,created_at,updated_at,version) VALUES(?,?,?,?,?,?)",
        )
        .bind("scn-1")
        .bind("test")
        .bind("version: 1\nsteps: []\n")
        .bind(0_i64)
        .bind(0_i64)
        .bind(1_i64)
        .execute(&db)
        .await
        .unwrap();
        insert_active_run(&db, "run-a", "running").await;
        insert_active_run(&db, "run-b", "pending").await;
        insert_active_run(&db, "run-c", "completed").await; // 비활성 → 카운트 제외
        let coord = CoordinatorState::new(db.clone());
        // 워커 등록 안 함 → 활성 run 모두 in-memory 엔트리 없음 → abort()는 false지만 에러 아님.
        let n = abort_all(&coord, &db).await.unwrap();
        assert_eq!(n, 2);
    }

    async fn insert_active_run(db: &Db, id: &str, status: &str) {
        sqlx::query(
            "INSERT INTO runs(id,scenario_id,scenario_yaml,profile_json,env_json,status,created_at) \
             VALUES(?,?,?,?,?,?,?)",
        )
        .bind(id)
        .bind("scn-1")
        .bind("version: 1\nsteps: []\n")
        .bind(r#"{"duration_seconds":1}"#)
        .bind("{}")
        .bind(status)
        .bind(0_i64)
        .execute(db)
        .await
        .unwrap();
    }
}

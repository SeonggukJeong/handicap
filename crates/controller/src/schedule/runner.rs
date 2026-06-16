//! 스케줄러 루프: due 스케줄을 틱마다 발사 경로(`api::runs::spawn_run`, REST와 공유)로
//! 흘린다. 트리거 계산은 `schedule::trigger`(순수, TZ-aware), TZ는 `state.scheduler_tz`.
use std::collections::HashMap;
use std::time::Duration;

use crate::api::runs::{spawn_run, validate_run_config, validate_step_criteria_targets};
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
            record(
                state,
                &sched.id,
                "missed",
                None,
                None,
                Some(&detail),
                adv_next,
                adv_enabled,
                now_ms,
            )
            .await;
            summary.missed += 1;
            continue;
        }

        // ── 겹침: 직전 run이 아직 pending/running이면 skip ──
        // last_run_id 없음 / runs::get None(행 부재) → 겹침 아님, 발사 진행(spec MINOR-16).
        if let Some(last_id) = &sched.last_run_id {
            if let Ok(Some(prev)) = runs::get(&state.db, last_id).await {
                if matches!(
                    prev.status,
                    runs::RunStatus::Pending | runs::RunStatus::Running
                ) {
                    record(
                        state,
                        &sched.id,
                        "skipped_overlap",
                        None,
                        None,
                        Some("이전 run이 아직 실행 중"),
                        adv_next,
                        adv_enabled,
                        now_ms,
                    )
                    .await;
                    summary.skipped += 1;
                    continue;
                }
            }
        }

        // ── 발사: scenario fetch → 매 발사 재검증(spec MAJOR-5) → spawn_run ──
        let scenario = match scenarios::get(&state.db, &sched.scenario_id).await {
            Ok(Some(s)) => s,
            Ok(None) => {
                record(
                    state,
                    &sched.id,
                    "error",
                    None,
                    None,
                    Some("시나리오를 찾을 수 없습니다"),
                    adv_next,
                    adv_enabled,
                    now_ms,
                )
                .await;
                summary.errored += 1;
                continue;
            }
            Err(e) => {
                let d = format!("시나리오 조회 실패: {e}");
                record(
                    state,
                    &sched.id,
                    "error",
                    None,
                    None,
                    Some(&d),
                    adv_next,
                    adv_enabled,
                    now_ms,
                )
                .await;
                summary.errored += 1;
                continue;
            }
        };
        let validated_meta = match validate_run_config(state, &sched.profile).await {
            Ok(m) => m,
            Err(e) => {
                let d = format!("검증 실패: {e}");
                record(
                    state,
                    &sched.id,
                    "error",
                    None,
                    None,
                    Some(&d),
                    adv_next,
                    adv_enabled,
                    now_ms,
                )
                .await;
                summary.errored += 1;
                continue;
            }
        };
        // step-criteria target은 시나리오 YAML 대조라 매 발사 재검증(시나리오 편집으로
        // target이 사라졌을 수 있음 — validate_run_config는 profile만 보므로 못 잡는다).
        if let Err(e) = validate_step_criteria_targets(&sched.profile, &scenario.yaml) {
            let d = format!("검증 실패: {e}");
            record(
                state,
                &sched.id,
                "error",
                None,
                None,
                Some(&d),
                adv_next,
                adv_enabled,
                now_ms,
            )
            .await;
            summary.errored += 1;
            continue;
        }
        let env: HashMap<String, String> = sched
            .env
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        match spawn_run(state, &scenario, &sched.profile, validated_meta, &env).await {
            Ok(row) => {
                record(
                    state,
                    &sched.id,
                    "fired",
                    Some(&row.id),
                    Some(now_ms),
                    None,
                    adv_next,
                    adv_enabled,
                    now_ms,
                )
                .await;
                summary.fired += 1;
            }
            Err(e) => {
                let d = format!("발사 실패: {e}");
                record(
                    state,
                    &sched.id,
                    "error",
                    None,
                    None,
                    Some(&d),
                    adv_next,
                    adv_enabled,
                    now_ms,
                )
                .await;
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
    if let Err(e) = schedules::mark_outcome(
        &state.db,
        schedule_id,
        next_run_at,
        enabled,
        kind,
        run_id,
        fired_at,
        detail,
    )
    .await
    {
        tracing::error!(error = %e, schedule_id, "scheduler: mark_outcome failed");
    }
    if let Err(e) = schedules::insert_event(&state.db, schedule_id, at, kind, run_id, detail).await
    {
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
    use crate::settings::SettingsState;
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
            settings: SettingsState::seeded_for_test(),
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
        store::scenarios::insert(db, &sc, yaml).await.unwrap().id
    }

    async fn insert_sched(
        db: &store::Db,
        sid: &str,
        p: &Profile,
        trigger: &Trigger,
        next_run_at: Option<i64>,
    ) -> String {
        schedules::insert(
            db,
            "s",
            sid,
            p,
            &BTreeMap::new(),
            trigger,
            true,
            next_run_at,
        )
        .await
        .unwrap()
        .id
    }

    #[tokio::test]
    async fn cron_due_fires_and_advances() {
        let state = test_state().await;
        let sid = seed_scenario(&state.db).await;
        let t = Trigger::Cron {
            expr: "* * * * *".into(),
        };
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
        let t = Trigger::Cron {
            expr: "* * * * *".into(),
        };
        let id = insert_sched(
            &state.db,
            &sid,
            &profile(),
            &t,
            Some(NOW - (MISS_GRACE_MS + 10_000)),
        )
        .await;

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
        let prev = runs::insert(
            &state.db,
            &sid,
            "version: 1\nname: s\nsteps: []\n",
            &profile(),
            &serde_json::json!({}),
        )
        .await
        .unwrap();
        let t = Trigger::Cron {
            expr: "* * * * *".into(),
        };
        let id = insert_sched(&state.db, &sid, &profile(), &t, Some(NOW - 1_000)).await;
        // last_run_id = prev(pending)로 세팅(이전 발사를 흉내).
        schedules::mark_outcome(
            &state.db,
            &id,
            Some(NOW - 1_000),
            true,
            "fired",
            Some(&prev.id),
            Some(NOW - 60_000),
            None,
        )
        .await
        .unwrap();

        let sum = process_due_schedules(&state, NOW).await;
        assert_eq!(sum.skipped, 1);
        assert_eq!(sum.fired, 0);
        let g = schedules::get(&state.db, &id).await.unwrap().unwrap();
        assert_eq!(g.last_status.as_deref(), Some("skipped_overlap"));
        assert_eq!(
            g.last_run_id.as_deref(),
            Some(prev.id.as_str()),
            "still points at running run"
        );
    }

    #[tokio::test]
    async fn once_due_fires_then_disables() {
        let state = test_state().await;
        let sid = seed_scenario(&state.db).await;
        let t = Trigger::Once {
            run_at: NOW - 1_000,
        };
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
        let t = Trigger::Once {
            run_at: NOW - (MISS_GRACE_MS + 10_000),
        };
        let id = insert_sched(
            &state.db,
            &sid,
            &profile(),
            &t,
            Some(NOW - (MISS_GRACE_MS + 10_000)),
        )
        .await;

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
        let t = Trigger::Cron {
            expr: "* * * * *".into(),
        };
        let id = insert_sched(&state.db, &sid, &p, &t, Some(NOW - 1_000)).await;

        let sum = process_due_schedules(&state, NOW).await;
        assert_eq!(sum.errored, 1);
        assert_eq!(sum.fired, 0);
        let g = schedules::get(&state.db, &id).await.unwrap().unwrap();
        assert_eq!(g.last_status.as_deref(), Some("error"));
        assert!(g.last_error.is_some());
        assert!(
            g.enabled && g.next_run_at.unwrap() > NOW,
            "cron advances to retry next slot"
        );
    }
}

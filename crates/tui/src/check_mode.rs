//! `--check <file>` — 화면 없이 세션을 띄우고 모든 칸의 첫 결과를 기다려 요약을 출력한다.
//! exit: 0 = 모든 칸 결과 수신 · 1 = 기동/가져오기/start 실패 · 2 = 대기 상한 초과.

use std::collections::HashSet;
use std::path::Path;
use std::time::{Duration, Instant};

use handicap_controller::monitor::config::BoardConfig;

use crate::judge::{PanelStateInput, big_value_text, panel_state};
use crate::session::{Session, Stage};
use crate::wire::StatusResponse;
use crate::{tempdb, text};

/// 컨트롤러 전역 동시 점검 상한(`supervisor.rs` `MAX_CONCURRENT_CHECKS`).
const CONCURRENT_CHECKS: usize = 32;
const POLL_EVERY: Duration = Duration::from_secs(1);

pub fn stage_label(s: Stage) -> &'static str {
    match s {
        Stage::ReadFile => "파일 읽기",
        Stage::Controller => "점검 엔진 시작",
        Stage::Import => "보드 가져오기",
        Stage::StartBoard => "보드 시작",
    }
}

/// 실행 단위 = 묶음 1개 또는 단독 칸 1개.
pub fn count_units(cfg: &BoardConfig) -> usize {
    let groups: HashSet<&str> = cfg
        .panels
        .iter()
        .filter_map(|p| p.group_id.as_deref())
        .collect();
    groups.len() + cfg.panels.iter().filter(|p| p.group_id.is_none()).count()
}

pub fn wait_cap_secs(units: usize, max_budget: u32) -> u64 {
    units.div_ceil(CONCURRENT_CHECKS) as u64 * u64::from(max_budget) + 10
}

/// 칸들의 점검 예산 최댓값 — 상태가 없는 칸은 칸 설정의 `timeout_seconds`로 폴백.
pub fn max_budget(configs: &[BoardConfig], statuses: &[Option<StatusResponse>]) -> u32 {
    configs
        .iter()
        .zip(statuses)
        .flat_map(|(cfg, st)| {
            cfg.panels.iter().map(move |p| {
                st.as_ref()
                    .and_then(|s| s.panels.iter().find(|s| s.panel_id == p.id))
                    .map_or(p.timeout_seconds, |s| s.check_budget_seconds)
            })
        })
        .max()
        .unwrap_or(0)
}

fn all_have_results(configs: &[BoardConfig], statuses: &[Option<StatusResponse>]) -> bool {
    configs.iter().zip(statuses).all(|(cfg, st)| {
        let Some(st) = st else { return false };
        cfg.panels.iter().all(|p| {
            st.panels
                .iter()
                .any(|s| s.panel_id == p.id && !s.results.is_empty())
        })
    })
}

fn summary(
    names: &[String],
    configs: &[BoardConfig],
    statuses: &[Option<StatusResponse>],
) -> String {
    let mut out = String::new();
    for ((name, cfg), st) in names.iter().zip(configs).zip(statuses) {
        for p in &cfg.panels {
            let ps = st
                .as_ref()
                .and_then(|s| s.panels.iter().find(|s| s.panel_id == p.id));
            let latest = ps.and_then(|s| s.results.last());
            let budget = ps.map_or(p.timeout_seconds, |s| s.check_budget_seconds);
            let state = panel_state(&PanelStateInput {
                latest,
                now_ms: st.as_ref().map_or(0, |s| s.now_ms),
                started_at_ms: st.as_ref().and_then(|s| s.started_at_ms),
                enabled: st.as_ref().is_none_or(|s| s.enabled),
                server_down: false,
                interval_sec: p.interval_seconds,
                budget_sec: budget,
                thresholds: &p.thresholds,
            });
            out.push_str(&format!(
                "{name} / {}  {}  {}\n",
                p.title,
                text::state_label(state),
                big_value_text(state, latest)
            ));
        }
    }
    out
}

/// 출력 문자열과 exit 코드를 돌려준다. `cap=None`이면 공식으로 계산한다.
pub async fn run_with_cap(file: &Path, db_dir: &Path, cap: Option<Duration>) -> (i32, String) {
    let session = match Session::start(file, db_dir).await {
        Ok(s) => s,
        Err(e) => return (1, format!("{}: {}\n", stage_label(e.stage), e.message)),
    };
    let started = Instant::now();
    let names: Vec<String> = session.boards.iter().map(|b| b.name.clone()).collect();

    let mut configs = Vec::new();
    for b in &session.boards {
        match session.api.board(&b.id).await {
            Ok(r) => configs.push(r.config),
            Err(e) => {
                session.shutdown().await;
                return (1, format!("보드 읽기: {}\n", e.message));
            }
        }
    }

    let mut deadline = cap.map(|c| started + c);
    let mut statuses: Vec<Option<StatusResponse>> = vec![None; session.boards.len()];
    let mut first_round = true;
    let (code, prefix) = loop {
        for (i, b) in session.boards.iter().enumerate() {
            if let Ok(s) = session.api.status(&b.id).await {
                statuses[i] = Some(s);
            }
        }
        if first_round {
            first_round = false;
            if deadline.is_none() {
                let units: usize = configs.iter().map(count_units).sum();
                let budget = max_budget(&configs, &statuses);
                deadline = Some(started + Duration::from_secs(wait_cap_secs(units, budget)));
            }
        }
        if all_have_results(&configs, &statuses) {
            break (0, String::new());
        }
        if deadline.is_some_and(|d| Instant::now() >= d) {
            break (
                2,
                "대기 시간이 초과되었습니다 — 일부 칸의 첫 결과가 없습니다\n".to_string(),
            );
        }
        tokio::time::sleep(POLL_EVERY).await;
    };
    let out = format!("{prefix}{}", summary(&names, &configs, &statuses));
    session.shutdown().await;
    (code, out)
}

/// `main` 전용 동기 진입점 — 자체 런타임을 만든다(테스트는 async 판을 직접 await).
pub fn run(file: &Path) -> i32 {
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            println!("점검 엔진을 시작하지 못했습니다: {e}");
            return 1;
        }
    };
    let (code, out) = rt.block_on(run_with_cap(file, &tempdb::runtime_dir(), None));
    print!("{out}");
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    use handicap_controller::monitor::config::PanelConfig;

    fn panel(id: &str, group: Option<&str>) -> PanelConfig {
        PanelConfig {
            id: id.into(),
            group_id: group.map(str::to_string),
            ..PanelConfig::default()
        }
    }

    #[test]
    fn count_units_groups_and_singles() {
        let cfg = BoardConfig {
            panels: vec![
                panel("a", Some("g1")),
                panel("b", Some("g1")),
                panel("c", Some("g2")),
                panel("d", None),
                panel("e", None),
            ],
            ..BoardConfig::default()
        };
        assert_eq!(count_units(&cfg), 4);
    }

    #[test]
    fn max_budget_falls_back_to_timeout_when_status_missing() {
        let mut p = panel("a", None);
        p.timeout_seconds = 7;
        let cfg = BoardConfig {
            panels: vec![p],
            ..BoardConfig::default()
        };
        assert_eq!(max_budget(std::slice::from_ref(&cfg), &[None]), 7);
        let st = StatusResponse {
            now_ms: 0,
            board_updated_at: 0,
            enabled: true,
            started_at_ms: None,
            panels: vec![],
        };
        // 상태는 있으나 그 칸이 없을 때도 폴백.
        assert_eq!(max_budget(&[cfg], &[Some(st)]), 7);
    }

    #[test]
    fn wait_cap_formula() {
        assert_eq!(wait_cap_secs(33, 5), 20);
        assert_eq!(wait_cap_secs(1, 152), 162);
    }
}

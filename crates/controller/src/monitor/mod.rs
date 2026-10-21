pub mod check;
pub mod config;
pub mod supervisor;

pub use supervisor::MonitorSupervisor;

/// 기동 시 `enabled=1` 보드를 모두 재개한다. 개별 보드 실패는 건너뛰고(경고) 계속하며,
/// 재개에 성공한 보드 수를 돌려준다. 목록 조회 실패만 `Err`.
pub async fn resume_enabled(state: &crate::app::AppState) -> anyhow::Result<usize> {
    let rows = crate::store::monitor_boards::list_enabled(&state.db).await?;
    let mut n = 0;
    for row in rows {
        match state.monitor.reconcile(&state.db, &row.id).await {
            Ok(()) => n += 1,
            Err(e) => tracing::warn!(board_id = %row.id, error = ?e, "monitor resume failed"),
        }
    }
    Ok(n)
}

use sqlx::Row;

use super::Db;

pub struct OpenLoopSecondRow {
    pub worker_id: String,
    pub ts_second: i64,
    pub launched: i64,
    pub completed: i64,
    pub dropped: i64,
}

pub struct WorkerStartRow {
    pub worker_id: String,
    pub started_at_ms: i64,
}

/// rows = (ts_second, launched, completed, dropped). 끝난 초만 한 번 오므로 같은 키는
/// 재연결 재전송뿐 — keep-first (`metrics::insert_batch`와 같은 규칙).
pub async fn insert_open_loop_seconds(
    db: &Db,
    run_id: &str,
    worker_id: &str,
    rows: &[(i64, i64, i64, i64)],
) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut tx = db.begin().await?;
    for (ts, launched, completed, dropped) in rows {
        sqlx::query(
            "INSERT INTO run_open_loop_seconds(run_id,worker_id,ts_second,launched,completed,dropped) \
             VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,worker_id,ts_second) DO NOTHING",
        )
        .bind(run_id)
        .bind(worker_id)
        .bind(ts)
        .bind(launched)
        .bind(completed)
        .bind(dropped)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

pub async fn insert_worker_start(
    db: &Db,
    run_id: &str,
    worker_id: &str,
    started_at_ms: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO run_worker_starts(run_id,worker_id,started_at_ms) VALUES(?,?,?)",
    )
    .bind(run_id)
    .bind(worker_id)
    .bind(started_at_ms)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn open_loop_seconds(db: &Db, run_id: &str) -> sqlx::Result<Vec<OpenLoopSecondRow>> {
    let rows = sqlx::query(
        "SELECT worker_id,ts_second,launched,completed,dropped FROM run_open_loop_seconds \
         WHERE run_id = ? ORDER BY worker_id, ts_second",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .iter()
        .map(|r| OpenLoopSecondRow {
            worker_id: r.get("worker_id"),
            ts_second: r.get("ts_second"),
            launched: r.get("launched"),
            completed: r.get("completed"),
            dropped: r.get("dropped"),
        })
        .collect())
}

pub async fn worker_starts(db: &Db, run_id: &str) -> sqlx::Result<Vec<WorkerStartRow>> {
    let rows = sqlx::query(
        "SELECT worker_id,started_at_ms FROM run_worker_starts WHERE run_id = ? ORDER BY worker_id",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .iter()
        .map(|r| WorkerStartRow {
            worker_id: r.get("worker_id"),
            started_at_ms: r.get("started_at_ms"),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_loop_insert_is_idempotent() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        insert_open_loop_seconds(&db, "r", "w0", &[(5, 10, 9, 1)])
            .await
            .unwrap();
        insert_open_loop_seconds(&db, "r", "w0", &[(5, 99, 99, 99), (6, 1, 1, 0)])
            .await
            .unwrap();
        let rows = open_loop_seconds(&db, "r").await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            (
                rows[0].ts_second,
                rows[0].launched,
                rows[0].completed,
                rows[0].dropped
            ),
            (5, 10, 9, 1),
            "first value wins"
        );
        assert_eq!(rows[1].ts_second, 6);
    }

    #[tokio::test]
    async fn worker_start_first_wins() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        insert_worker_start(&db, "r", "w0", 1_000).await.unwrap();
        insert_worker_start(&db, "r", "w0", 2_000).await.unwrap();
        let s = worker_starts(&db, "r").await.unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].started_at_ms, 1_000);
    }
}

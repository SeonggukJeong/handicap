use std::collections::HashMap;

use serde::Serialize;
use sqlx::Row;

use super::Db;

pub struct MetricRow {
    pub run_id: String,
    pub ts_second: i64,
    pub step_id: String,
    pub count: i64,
    pub error_count: i64,
    pub hdr_histogram: Vec<u8>,
    pub status_counts: String,
}

pub async fn insert_batch(db: &Db, rows: &[MetricRow]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    // Single tx, individual upserts to handle late repeated keys.
    let mut tx = db.begin().await?;
    for r in rows {
        sqlx::query(
            "INSERT OR REPLACE INTO run_metrics(run_id,ts_second,step_id,count,error_count,hdr_histogram,status_counts) \
             VALUES(?,?,?,?,?,?,?)",
        )
        .bind(&r.run_id)
        .bind(r.ts_second)
        .bind(&r.step_id)
        .bind(r.count)
        .bind(r.error_count)
        .bind(&r.hdr_histogram)
        .bind(&r.status_counts)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

#[derive(Debug, Serialize)]
pub struct MetricSummary {
    pub run_id: String,
    pub windows: Vec<WindowSummary>,
}

#[derive(Debug, Serialize)]
pub struct WindowSummary {
    pub ts_second: i64,
    pub step_id: String,
    pub count: i64,
    pub error_count: i64,
    pub status_counts: HashMap<String, u64>,
}

pub async fn summary(db: &Db, run_id: &str) -> sqlx::Result<MetricSummary> {
    let rows = sqlx::query(
        "SELECT ts_second, step_id, count, error_count, status_counts \
         FROM run_metrics WHERE run_id = ? ORDER BY ts_second, step_id",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;

    let windows = rows
        .into_iter()
        .map(|r| {
            let status_json: String = r.get("status_counts");
            let parsed: HashMap<String, u64> =
                serde_json::from_str(&status_json).unwrap_or_default();
            WindowSummary {
                ts_second: r.get("ts_second"),
                step_id: r.get("step_id"),
                count: r.get("count"),
                error_count: r.get("error_count"),
                status_counts: parsed,
            }
        })
        .collect();

    Ok(MetricSummary {
        run_id: run_id.to_string(),
        windows,
    })
}

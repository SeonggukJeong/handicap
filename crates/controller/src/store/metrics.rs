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

#[derive(Debug)]
pub struct WindowWithHdr {
    pub ts_second: i64,
    pub step_id: String,
    pub count: i64,
    pub error_count: i64,
    pub status_counts: String, // raw JSON text — same as the column
    pub hdr_histogram: Vec<u8>,
}

pub async fn windows_with_hdr(db: &Db, run_id: &str) -> sqlx::Result<Vec<WindowWithHdr>> {
    let rows = sqlx::query(
        "SELECT ts_second, step_id, count, error_count, status_counts, hdr_histogram \
         FROM run_metrics WHERE run_id = ? ORDER BY ts_second, step_id",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| WindowWithHdr {
            ts_second: r.get("ts_second"),
            step_id: r.get("step_id"),
            count: r.get("count"),
            error_count: r.get("error_count"),
            status_counts: r.get("status_counts"),
            hdr_histogram: r.get("hdr_histogram"),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;

    async fn pool() -> Db {
        store::connect("sqlite::memory:")
            .await
            .expect("in-memory pool")
    }

    #[tokio::test]
    async fn windows_with_hdr_returns_rows_in_order_with_hdr_bytes() {
        let db = pool().await;

        // 1) Insert a scenario (schema: id, name, yaml, created_at, updated_at, version)
        sqlx::query(
            "INSERT INTO scenarios(id, name, yaml, created_at, updated_at, version) \
             VALUES(?,?,?,?,?,?)",
        )
        .bind("S1")
        .bind("test")
        .bind("version: 1\nname: test\nsteps: []\n")
        .bind(1_i64)
        .bind(1_i64)
        .bind(1_i64)
        .execute(&db)
        .await
        .unwrap();

        // 2) Insert a run (schema: id, scenario_id, scenario_yaml, profile_json, env_json, status, created_at)
        sqlx::query(
            "INSERT INTO runs(id, scenario_id, scenario_yaml, profile_json, env_json, status, created_at) \
             VALUES(?,?,?,?,?,?,?)",
        )
        .bind("R1")
        .bind("S1")
        .bind("version: 1\nname: test\nsteps: []\n")
        .bind("{}")
        .bind("{}")
        .bind("completed")
        .bind(1_i64)
        .execute(&db)
        .await
        .unwrap();

        // 3) Insert two metric windows out of order (verify ORDER BY).
        let rows = vec![
            MetricRow {
                run_id: "R1".into(),
                ts_second: 101,
                step_id: "stepA".into(),
                count: 5,
                error_count: 0,
                hdr_histogram: vec![1, 2, 3, 4],
                status_counts: r#"{"200":5}"#.into(),
            },
            MetricRow {
                run_id: "R1".into(),
                ts_second: 100,
                step_id: "stepA".into(),
                count: 3,
                error_count: 1,
                hdr_histogram: vec![5, 6, 7, 8],
                status_counts: r#"{"200":2,"500":1}"#.into(),
            },
        ];
        insert_batch(&db, &rows).await.unwrap();

        // 4) windows_with_hdr returns sorted by (ts_second, step_id) with hdr bytes intact.
        let got = windows_with_hdr(&db, "R1").await.unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].ts_second, 100);
        assert_eq!(got[0].hdr_histogram, vec![5, 6, 7, 8]);
        assert_eq!(got[1].ts_second, 101);
        assert_eq!(got[1].hdr_histogram, vec![1, 2, 3, 4]);
    }

    #[tokio::test]
    async fn windows_with_hdr_returns_empty_for_unknown_run() {
        let db = pool().await;
        let got = windows_with_hdr(&db, "NOPE").await.unwrap();
        assert!(got.is_empty());
    }
}

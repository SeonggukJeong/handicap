use std::collections::HashMap;

use serde::Serialize;
use sqlx::Row;

use super::Db;

pub struct MetricRow {
    pub run_id: String,
    pub ts_second: i64,
    pub step_id: String,
    pub worker_id: String, // A3b: per-worker keying so N workers' windows coexist
    pub count: i64,
    pub error_count: i64,
    pub hdr_histogram: Vec<u8>,
    pub status_counts: String,
}

pub async fn insert_batch(db: &Db, rows: &[MetricRow]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    // Each window is a complete per-second snapshot emitted once per worker. A duplicate
    // (run_id,ts_second,step_id,worker_id) key can only come from an at-least-once gRPC
    // resend after reconnect (Slice 6) and carries identical data — keep-first per worker
    // is idempotent. Distinct worker_id rows coexist; read-time merge (report.rs /
    // metrics::summary) sums them. (Contrast run_loop_metrics, which accumulates because
    // those are incremental deltas, not snapshots.)
    let mut tx = db.begin().await?;
    for r in rows {
        sqlx::query(
            "INSERT INTO run_metrics(run_id,ts_second,step_id,worker_id,count,error_count,hdr_histogram,status_counts) \
             VALUES(?,?,?,?,?,?,?,?) \
             ON CONFLICT(run_id,ts_second,step_id,worker_id) DO NOTHING",
        )
        .bind(&r.run_id)
        .bind(r.ts_second)
        .bind(&r.step_id)
        .bind(&r.worker_id)
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
    pub worker_id: String, // A3b: separate row per worker; build_report merges by (ts,step)
    pub count: i64,
    pub error_count: i64,
    pub status_counts: String, // raw JSON text — same as the column
    pub hdr_histogram: Vec<u8>,
}

pub async fn windows_with_hdr(db: &Db, run_id: &str) -> sqlx::Result<Vec<WindowWithHdr>> {
    let rows = sqlx::query(
        "SELECT ts_second, step_id, worker_id, count, error_count, status_counts, hdr_histogram \
         FROM run_metrics WHERE run_id = ? ORDER BY ts_second, step_id, worker_id",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| WindowWithHdr {
            ts_second: r.get("ts_second"),
            step_id: r.get("step_id"),
            worker_id: r.get("worker_id"),
            count: r.get("count"),
            error_count: r.get("error_count"),
            status_counts: r.get("status_counts"),
            hdr_histogram: r.get("hdr_histogram"),
        })
        .collect())
}

#[derive(Debug, Clone)]
pub struct LoopMetricRow {
    pub run_id: String,
    pub step_id: String,
    pub loop_index: i64, // u32 stored as i64 (SQLite INTEGER); overflow = 4294967295
    pub count: i64,
    pub error_count: i64,
}

pub async fn insert_loop_batch(db: &Db, rows: &[LoopMetricRow]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    // Single tx, individual upserts to handle late repeated keys.
    let mut tx = db.begin().await?;
    for r in rows {
        sqlx::query(
            "INSERT INTO run_loop_metrics(run_id,step_id,loop_index,count,error_count) \
             VALUES(?,?,?,?,?) \
             ON CONFLICT(run_id,step_id,loop_index) DO UPDATE SET \
               count = count + excluded.count, \
               error_count = error_count + excluded.error_count",
        )
        .bind(&r.run_id)
        .bind(&r.step_id)
        .bind(r.loop_index)
        .bind(r.count)
        .bind(r.error_count)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

pub async fn loop_breakdown(db: &Db, run_id: &str) -> sqlx::Result<Vec<LoopMetricRow>> {
    let rows = sqlx::query(
        "SELECT step_id, loop_index, count, error_count FROM run_loop_metrics \
         WHERE run_id = ? ORDER BY step_id, loop_index",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| LoopMetricRow {
            run_id: run_id.to_string(),
            step_id: r.get("step_id"),
            loop_index: r.get("loop_index"),
            count: r.get("count"),
            error_count: r.get("error_count"),
        })
        .collect())
}

#[derive(Debug, Clone)]
pub struct IfBranchRow {
    pub run_id: String,
    pub step_id: String, // the `if` node's id
    pub branch: String,  // "then" | "elif_0".. | "else" | "none"
    pub count: i64,
}

pub async fn insert_if_branch_batch(db: &Db, rows: &[IfBranchRow]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    // Single tx, individual upserts: branch deltas are incremental counts (like
    // run_loop_metrics), so accumulate on conflict.
    let mut tx = db.begin().await?;
    for r in rows {
        sqlx::query(
            "INSERT INTO run_if_metrics(run_id,step_id,branch,count) \
             VALUES(?,?,?,?) \
             ON CONFLICT(run_id,step_id,branch) DO UPDATE SET \
               count = count + excluded.count",
        )
        .bind(&r.run_id)
        .bind(&r.step_id)
        .bind(&r.branch)
        .bind(r.count)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

pub async fn if_breakdown(db: &Db, run_id: &str) -> sqlx::Result<Vec<IfBranchRow>> {
    // ORDER BY branch is lexicographic TEXT — fine for counts; the UI re-sorts
    // then < elif_n < else < none for display (BranchStatsTable::branchRank).
    let rows = sqlx::query(
        "SELECT step_id, branch, count FROM run_if_metrics \
         WHERE run_id = ? ORDER BY step_id, branch",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| IfBranchRow {
            run_id: run_id.to_string(),
            step_id: r.get("step_id"),
            branch: r.get("branch"),
            count: r.get("count"),
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
                worker_id: "".into(),
                count: 5,
                error_count: 0,
                hdr_histogram: vec![1, 2, 3, 4],
                status_counts: r#"{"200":5}"#.into(),
            },
            MetricRow {
                run_id: "R1".into(),
                ts_second: 100,
                step_id: "stepA".into(),
                worker_id: "".into(),
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

    #[tokio::test]
    async fn run_metrics_insert_is_idempotent_keep_first() {
        let db = pool().await;

        // FK: run_metrics.run_id REFERENCES runs(id), runs.scenario_id REFERENCES scenarios(id)
        sqlx::query(
            "INSERT INTO scenarios(id, name, yaml, created_at, updated_at, version) \
             VALUES(?,?,?,?,?,?)",
        )
        .bind("S-idem")
        .bind("idem-scenario")
        .bind("version: 1\nname: idem\nsteps: []\n")
        .bind(1_i64)
        .bind(1_i64)
        .bind(1_i64)
        .execute(&db)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO runs(id, scenario_id, scenario_yaml, profile_json, env_json, status, created_at) \
             VALUES(?,?,?,?,?,?,?)",
        )
        .bind("R-idem")
        .bind("S-idem")
        .bind("version: 1\nname: idem\nsteps: []\n")
        .bind("{}")
        .bind("{}")
        .bind("completed")
        .bind(1_i64)
        .execute(&db)
        .await
        .unwrap();

        // First insert: count=5, error_count=0
        let first = vec![MetricRow {
            run_id: "R-idem".into(),
            ts_second: 1,
            step_id: "step-x".into(),
            worker_id: "".into(),
            count: 5,
            error_count: 0,
            hdr_histogram: vec![0xAA, 0xBB],
            status_counts: r#"{"200":5}"#.into(),
        }];
        insert_batch(&db, &first).await.unwrap();

        // Duplicate resend (same key, different payload — simulates at-least-once gRPC resend)
        let second = vec![MetricRow {
            run_id: "R-idem".into(),
            ts_second: 1,
            step_id: "step-x".into(),
            worker_id: "".into(),
            count: 99,
            error_count: 7,
            hdr_histogram: vec![0xCC, 0xDD],
            status_counts: r#"{"200":99}"#.into(),
        }];
        insert_batch(&db, &second).await.unwrap();

        // Read back: must see the FIRST row (count=5), not the replaced (99) or accumulated (104)
        let got = summary(&db, "R-idem").await.unwrap();
        assert_eq!(got.windows.len(), 1);
        assert_eq!(
            got.windows[0].count, 5,
            "duplicate window resend must be ignored (keep-first), not summed or replaced"
        );
        assert_eq!(
            got.windows[0].error_count, 0,
            "error_count must remain from first insert"
        );
    }

    #[tokio::test]
    async fn loop_metrics_upsert_accumulates() {
        let db = pool().await;
        let rows = vec![
            LoopMetricRow {
                run_id: "r".into(),
                step_id: "s".into(),
                loop_index: 0,
                count: 3,
                error_count: 1,
            },
            LoopMetricRow {
                run_id: "r".into(),
                step_id: "s".into(),
                loop_index: 0,
                count: 2,
                error_count: 0,
            },
            LoopMetricRow {
                run_id: "r".into(),
                step_id: "s".into(),
                loop_index: 4_294_967_295,
                count: 7,
                error_count: 0,
            },
        ];
        insert_loop_batch(&db, &rows).await.unwrap();
        let got = loop_breakdown(&db, "r").await.unwrap();
        let m: std::collections::HashMap<(String, i64), (i64, i64)> = got
            .into_iter()
            .map(|r| ((r.step_id, r.loop_index), (r.count, r.error_count)))
            .collect();
        assert_eq!(m.get(&("s".into(), 0)), Some(&(5, 1))); // 3+2 / 1+0
        assert_eq!(m.get(&("s".into(), 4_294_967_295)), Some(&(7, 0)));
    }

    #[tokio::test]
    async fn run_metrics_per_worker_rows_coexist() {
        let db = pool().await;
        sqlx::query(
            "INSERT INTO scenarios(id,name,yaml,created_at,updated_at,version) VALUES(?,?,?,?,?,?)",
        )
        .bind("S")
        .bind("n")
        .bind("version: 1\nname: n\nsteps: []\n")
        .bind(1_i64)
        .bind(1_i64)
        .bind(1_i64)
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO runs(id,scenario_id,scenario_yaml,profile_json,env_json,status,created_at) \
             VALUES(?,?,?,?,?,?,?)",
        )
        .bind("R").bind("S").bind("version: 1\nname: n\nsteps: []\n")
        .bind("{}").bind("{}").bind("completed").bind(1_i64).execute(&db).await.unwrap();

        // Two workers emit the SAME (run_id, ts_second, step_id) window. Under A3a's
        // 3-column PK keep-first one would be dropped; with worker_id in the PK both
        // rows must survive.
        let rows = vec![
            MetricRow {
                run_id: "R".into(),
                ts_second: 1,
                step_id: "s".into(),
                worker_id: "w-a".into(),
                count: 5,
                error_count: 0,
                hdr_histogram: vec![0xAA],
                status_counts: r#"{"200":5}"#.into(),
            },
            MetricRow {
                run_id: "R".into(),
                ts_second: 1,
                step_id: "s".into(),
                worker_id: "w-b".into(),
                count: 3,
                error_count: 1,
                hdr_histogram: vec![0xBB],
                status_counts: r#"{"200":3}"#.into(),
            },
        ];
        insert_batch(&db, &rows).await.unwrap();

        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM run_metrics WHERE run_id='R'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 2, "distinct worker_id rows must coexist");

        // Same worker_id resend (same key, different payload) -> keep-first per worker.
        let resend = vec![MetricRow {
            run_id: "R".into(),
            ts_second: 1,
            step_id: "s".into(),
            worker_id: "w-a".into(),
            count: 99,
            error_count: 7,
            hdr_histogram: vec![0xCC],
            status_counts: r#"{"200":99}"#.into(),
        }];
        insert_batch(&db, &resend).await.unwrap();
        let again: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM run_metrics WHERE run_id='R'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(
            again, 2,
            "duplicate worker key must be ignored (per-worker keep-first)"
        );
        let a_count: i64 = sqlx::query_scalar(
            "SELECT count FROM run_metrics WHERE run_id='R' AND worker_id='w-a'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(a_count, 5, "w-a keeps first value, not replaced/summed");
    }

    #[tokio::test]
    async fn if_metrics_upsert_accumulates() {
        let db = pool().await;
        let rows = vec![
            IfBranchRow {
                run_id: "r".into(),
                step_id: "if1".into(),
                branch: "then".into(),
                count: 3,
            },
            IfBranchRow {
                run_id: "r".into(),
                step_id: "if1".into(),
                branch: "then".into(),
                count: 2,
            },
            IfBranchRow {
                run_id: "r".into(),
                step_id: "if1".into(),
                branch: "none".into(),
                count: 7,
            },
        ];
        insert_if_branch_batch(&db, &rows).await.unwrap();
        let got = if_breakdown(&db, "r").await.unwrap();
        let m: std::collections::HashMap<(String, String), i64> = got
            .into_iter()
            .map(|r| ((r.step_id, r.branch), r.count))
            .collect();
        assert_eq!(m.get(&("if1".into(), "then".into())), Some(&5)); // 3+2 accumulate
        assert_eq!(m.get(&("if1".into(), "none".into())), Some(&7));
    }
}

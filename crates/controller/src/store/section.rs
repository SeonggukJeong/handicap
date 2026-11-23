//! 반복 밖 구간(준비 스텝)의 통계 저장 — migration 0027. 배치마다 행을 추가만 하고
//! 읽을 때 합친다(합치기는 report 쪽). 수신 때 읽고-고쳐-쓰기를 하지 않는다.

use sqlx::Row;

use super::Db;

#[derive(Debug, Clone, PartialEq)]
pub struct SectionStepRow {
    pub run_id: String,
    pub worker_id: String,
    pub section: String,
    pub step_id: String,
    pub count: i64,
    pub error_count: i64,
    /// JSON 객체 `{"200": 3}`.
    pub status_counts: String,
    /// JSON 객체.
    pub failure_kinds: String,
    pub hdr_histogram: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SectionOutcomeRow {
    pub run_id: String,
    pub worker_id: String,
    pub section: String,
    pub ok: i64,
    pub failed: i64,
    pub interrupted: i64,
    /// 0 = 없음.
    pub last_done_ms: i64,
}

pub async fn insert_section_step_batch(db: &Db, rows: &[SectionStepRow]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut tx = db.begin().await?;
    for r in rows {
        sqlx::query(
            "INSERT INTO run_section_step_metrics(run_id,worker_id,section,step_id,count,error_count,status_counts,failure_kinds,hdr_histogram) \
             VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(&r.run_id)
        .bind(&r.worker_id)
        .bind(&r.section)
        .bind(&r.step_id)
        .bind(r.count)
        .bind(r.error_count)
        .bind(&r.status_counts)
        .bind(&r.failure_kinds)
        .bind(&r.hdr_histogram)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

pub async fn insert_section_outcome_batch(db: &Db, rows: &[SectionOutcomeRow]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut tx = db.begin().await?;
    for r in rows {
        sqlx::query(
            "INSERT INTO run_section_outcomes(run_id,worker_id,section,ok,failed,interrupted,last_done_ms) \
             VALUES(?,?,?,?,?,?,?)",
        )
        .bind(&r.run_id)
        .bind(&r.worker_id)
        .bind(&r.section)
        .bind(r.ok)
        .bind(r.failed)
        .bind(r.interrupted)
        .bind(r.last_done_ms)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

/// 저장된 행 그대로(합치지 않음). 합치기는 report 쪽.
pub async fn section_steps(db: &Db, run_id: &str) -> sqlx::Result<Vec<SectionStepRow>> {
    let rows = sqlx::query(
        "SELECT worker_id, section, step_id, count, error_count, status_counts, failure_kinds, hdr_histogram \
         FROM run_section_step_metrics WHERE run_id = ? ORDER BY rowid",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| SectionStepRow {
            run_id: run_id.to_string(),
            worker_id: r.get("worker_id"),
            section: r.get("section"),
            step_id: r.get("step_id"),
            count: r.get("count"),
            error_count: r.get("error_count"),
            status_counts: r.get("status_counts"),
            failure_kinds: r.get("failure_kinds"),
            hdr_histogram: r.get("hdr_histogram"),
        })
        .collect())
}

pub async fn section_outcomes(db: &Db, run_id: &str) -> sqlx::Result<Vec<SectionOutcomeRow>> {
    let rows = sqlx::query(
        "SELECT worker_id, section, ok, failed, interrupted, last_done_ms \
         FROM run_section_outcomes WHERE run_id = ? ORDER BY rowid",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| SectionOutcomeRow {
            run_id: run_id.to_string(),
            worker_id: r.get("worker_id"),
            section: r.get("section"),
            ok: r.get("ok"),
            failed: r.get("failed"),
            interrupted: r.get("interrupted"),
            last_done_ms: r.get("last_done_ms"),
        })
        .collect())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SectionTotals {
    pub ok: i64,
    pub failed: i64,
    pub interrupted: i64,
}

/// 한 구간의 모든 워커·배치 행을 합친 VU 결과 수. 행이 없으면 `None`.
pub async fn section_outcome_totals(
    db: &Db,
    run_id: &str,
    section: &str,
) -> sqlx::Result<Option<SectionTotals>> {
    let r = sqlx::query(
        "SELECT COUNT(*) AS n, COALESCE(SUM(ok),0) AS ok, COALESCE(SUM(failed),0) AS failed, \
         COALESCE(SUM(interrupted),0) AS interrupted \
         FROM run_section_outcomes WHERE run_id = ? AND section = ?",
    )
    .bind(run_id)
    .bind(section)
    .fetch_one(db)
    .await?;
    let n: i64 = r.get("n");
    if n == 0 {
        return Ok(None);
    }
    Ok(Some(SectionTotals {
        ok: r.get("ok"),
        failed: r.get("failed"),
        interrupted: r.get("interrupted"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(run: &str, count: i64) -> SectionStepRow {
        SectionStepRow {
            run_id: run.to_string(),
            worker_id: "w0".to_string(),
            section: "setup".to_string(),
            step_id: "s1".to_string(),
            count,
            error_count: 1,
            status_counts: "{\"200\":2}".to_string(),
            failure_kinds: "{\"timeout\":1}".to_string(),
            hdr_histogram: vec![1, 2, 3],
        }
    }

    fn outcome(run: &str, ok: i64) -> SectionOutcomeRow {
        SectionOutcomeRow {
            run_id: run.to_string(),
            worker_id: "w0".to_string(),
            section: "setup".to_string(),
            ok,
            failed: 2,
            interrupted: 3,
            last_done_ms: 1234,
        }
    }

    #[tokio::test]
    async fn insert_and_read_back() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        insert_section_step_batch(&db, &[step("R1", 3)])
            .await
            .unwrap();
        insert_section_step_batch(&db, &[step("R1", 3), step("R2", 9)])
            .await
            .unwrap();
        insert_section_outcome_batch(&db, &[outcome("R1", 5)])
            .await
            .unwrap();
        insert_section_outcome_batch(&db, &[outcome("R1", 5)])
            .await
            .unwrap();

        // 같은 키로 두 번 넣으면 두 행 — 추가 전용.
        let steps = section_steps(&db, "R1").await.unwrap();
        assert_eq!(steps, vec![step("R1", 3), step("R1", 3)]);
        let outs = section_outcomes(&db, "R1").await.unwrap();
        assert_eq!(outs, vec![outcome("R1", 5), outcome("R1", 5)]);
        assert_eq!(section_steps(&db, "R2").await.unwrap().len(), 1);
        assert!(section_outcomes(&db, "R2").await.unwrap().is_empty());
    }

    fn outcome_row(
        run: &str,
        worker: &str,
        section: &str,
        ok: i64,
        failed: i64,
    ) -> SectionOutcomeRow {
        SectionOutcomeRow {
            run_id: run.to_string(),
            worker_id: worker.to_string(),
            section: section.to_string(),
            ok,
            failed,
            interrupted: 0,
            last_done_ms: 1,
        }
    }

    #[tokio::test]
    async fn section_outcome_totals_none_without_rows() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        assert_eq!(
            section_outcome_totals(&db, "R1", "setup").await.unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn section_outcome_totals_sums_workers_and_batches() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        insert_section_outcome_batch(
            &db,
            &[
                outcome_row("R1", "w0", "setup", 10, 0),
                outcome_row("R1", "w0", "setup", 20, 1),
                outcome_row("R1", "w1", "setup", 7, 1),
            ],
        )
        .await
        .unwrap();
        assert_eq!(
            section_outcome_totals(&db, "R1", "setup").await.unwrap(),
            Some(SectionTotals {
                ok: 37,
                failed: 2,
                interrupted: 0
            })
        );
    }

    #[tokio::test]
    async fn section_outcome_totals_ignores_other_sections_and_runs() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        insert_section_outcome_batch(
            &db,
            &[
                outcome_row("R1", "w0", "other", 5, 5),
                outcome_row("R2", "w0", "setup", 9, 9),
            ],
        )
        .await
        .unwrap();
        assert_eq!(
            section_outcome_totals(&db, "R1", "setup").await.unwrap(),
            None
        );
        insert_section_outcome_batch(&db, &[outcome_row("R1", "w0", "setup", 1, 0)])
            .await
            .unwrap();
        assert_eq!(
            section_outcome_totals(&db, "R1", "setup").await.unwrap(),
            Some(SectionTotals {
                ok: 1,
                failed: 0,
                interrupted: 0
            })
        );
    }
}

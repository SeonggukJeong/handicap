use handicap_engine::Scenario;
use sqlx::Row;
use ulid::Ulid;

use super::Db;

pub struct ScenarioRow {
    pub id: String,
    pub name: String,
    pub yaml: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub version: i64,
}

pub async fn insert(db: &Db, scenario: &Scenario, yaml: &str) -> sqlx::Result<ScenarioRow> {
    let id = Ulid::new().to_string();
    let now = super::now_ms();
    sqlx::query(
        "INSERT INTO scenarios(id,name,yaml,created_at,updated_at,version) VALUES(?,?,?,?,?,1)",
    )
    .bind(&id)
    .bind(&scenario.name)
    .bind(yaml)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    Ok(ScenarioRow {
        id,
        name: scenario.name.clone(),
        yaml: yaml.to_string(),
        created_at: now,
        updated_at: now,
        version: 1,
    })
}

pub async fn get(db: &Db, id: &str) -> sqlx::Result<Option<ScenarioRow>> {
    let row = sqlx::query_as::<_, (String, String, String, i64, i64, i64)>(
        "SELECT id,name,yaml,created_at,updated_at,version FROM scenarios WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(id, name, yaml, c, u, v)| ScenarioRow {
        id,
        name,
        yaml,
        created_at: c,
        updated_at: u,
        version: v,
    }))
}

pub async fn list(db: &Db) -> sqlx::Result<Vec<ScenarioRow>> {
    let rows = sqlx::query(
        "SELECT id,name,yaml,created_at,updated_at,version FROM scenarios \
         ORDER BY updated_at DESC",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| ScenarioRow {
            id: r.get("id"),
            name: r.get("name"),
            yaml: r.get("yaml"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
            version: r.get("version"),
        })
        .collect())
}

pub enum UpdateOutcome {
    Updated(ScenarioRow),
    NotFound,
    VersionMismatch { current: i64 },
}

pub async fn update(
    db: &Db,
    id: &str,
    new_name: &str,
    new_yaml: &str,
    expected_version: i64,
) -> sqlx::Result<UpdateOutcome> {
    let mut tx = db.begin().await?;
    let row = sqlx::query("SELECT version FROM scenarios WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(r) = row else {
        tx.commit().await?;
        return Ok(UpdateOutcome::NotFound);
    };
    let current: i64 = r.get("version");
    if current != expected_version {
        tx.commit().await?;
        return Ok(UpdateOutcome::VersionMismatch { current });
    }
    let now = super::now_ms();
    let new_version = current + 1;
    sqlx::query(
        "UPDATE scenarios SET name = ?, yaml = ?, updated_at = ?, version = ? \
         WHERE id = ?",
    )
    .bind(new_name)
    .bind(new_yaml)
    .bind(now)
    .bind(new_version)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    let created_at: i64 = sqlx::query("SELECT created_at FROM scenarios WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?
        .get("created_at");
    tx.commit().await?;
    Ok(UpdateOutcome::Updated(ScenarioRow {
        id: id.to_string(),
        name: new_name.to_string(),
        yaml: new_yaml.to_string(),
        created_at,
        updated_at: now,
        version: new_version,
    }))
}

#[derive(Debug, PartialEq)]
pub enum DeleteOutcome {
    Deleted,
    ActiveRuns,
}

/// 시나리오와 참조 그래프 전체(run 이력+메트릭 6테이블·프리셋·스케줄)를 단일
/// 트랜잭션으로 삭제한다 (ADR-0045). 권위 hard 가드는 트랜잭션 *안*의 재확인 —
/// 핸들러의 advisory 체크와 이 트랜잭션 사이에 커밋된 run도 여기서 잡힌다.
/// EXISTS와 첫 DELETE 사이에 끼어드는 동시 쓰기는 WAL busy/snapshot으로 tx가
/// 시끄럽게 실패한다(silent 경로 없음 — spec §3-5).
pub async fn delete_cascade(db: &Db, id: &str) -> sqlx::Result<DeleteOutcome> {
    let mut tx = db.begin().await?;
    let active: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM runs WHERE scenario_id = ? AND status IN ('pending','running'))",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if active {
        tx.rollback().await?;
        return Ok(DeleteOutcome::ActiveRuns);
    }
    // 자식 → 부모 순서 (foreign_keys=ON이 순서 오류를 즉시 거부).
    // 메트릭 테이블 일부는 FK 없이 run_id만 가지므로 6테이블 전수 명시 삭제.
    for table in [
        "run_metrics",
        "run_loop_metrics",
        "run_if_metrics",
        "run_group_metrics",
        "run_phase_metrics",
        "run_active_vu_metrics",
    ] {
        sqlx::query(&format!(
            "DELETE FROM {table} WHERE run_id IN (SELECT id FROM runs WHERE scenario_id = ?)"
        ))
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("DELETE FROM runs WHERE scenario_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM run_presets WHERE scenario_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    // schedule_events는 schedules FK의 ON DELETE CASCADE로 함께 삭제된다(0011).
    sqlx::query("DELETE FROM schedules WHERE scenario_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM scenarios WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(DeleteOutcome::Deleted)
}

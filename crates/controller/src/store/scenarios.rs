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
    pub group: Option<String>,
}

pub async fn insert(db: &Db, scenario: &Scenario, yaml: &str) -> sqlx::Result<ScenarioRow> {
    insert_grouped(db, scenario, yaml, None).await
}

pub async fn insert_grouped(
    db: &Db,
    scenario: &Scenario,
    yaml: &str,
    group: Option<&str>,
) -> sqlx::Result<ScenarioRow> {
    let id = Ulid::new().to_string();
    let now = super::now_ms();
    sqlx::query(
        "INSERT INTO scenarios(id,name,yaml,created_at,updated_at,version,group_name) \
         VALUES(?,?,?,?,?,1,?)",
    )
    .bind(&id)
    .bind(&scenario.name)
    .bind(yaml)
    .bind(now)
    .bind(now)
    .bind(group)
    .execute(db)
    .await?;
    Ok(ScenarioRow {
        id,
        name: scenario.name.clone(),
        yaml: yaml.to_string(),
        created_at: now,
        updated_at: now,
        version: 1,
        group: group.map(str::to_string),
    })
}

/// 그룹만 바꾼다 — `version`·`updated_at`은 건드리지 않는다. 맞은 행 수를 돌려준다.
pub async fn assign_group(db: &Db, ids: &[String], group: Option<&str>) -> sqlx::Result<u64> {
    if ids.is_empty() {
        return Ok(0);
    }
    let marks = vec!["?"; ids.len()].join(",");
    let sql = format!("UPDATE scenarios SET group_name = ? WHERE id IN ({marks})");
    let mut q = sqlx::query(&sql).bind(group);
    for id in ids {
        q = q.bind(id);
    }
    Ok(q.execute(db).await?.rows_affected())
}

/// `from` 그룹의 모든 시나리오를 `to`로 옮긴다(이미 있는 그룹이면 합쳐진다).
pub async fn rename_group(db: &Db, from: &str, to: &str) -> sqlx::Result<u64> {
    Ok(
        sqlx::query("UPDATE scenarios SET group_name = ? WHERE group_name = ?")
            .bind(to)
            .bind(from)
            .execute(db)
            .await?
            .rows_affected(),
    )
}

/// 가져오기용: 주어진 ID로 그대로 추가(version=1). 호출자가 트랜잭션 연결을 넘긴다.
pub async fn insert_with_id(
    conn: &mut sqlx::SqliteConnection,
    id: &str,
    name: &str,
    yaml: &str,
) -> sqlx::Result<()> {
    let now = super::now_ms();
    sqlx::query(
        "INSERT INTO scenarios(id,name,yaml,created_at,updated_at,version) VALUES(?,?,?,?,?,1)",
    )
    .bind(id)
    .bind(name)
    .bind(yaml)
    .bind(now)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// 주어진 ID들의 YAML을 `{id: yaml}`로(없는 ID는 빠진다).
pub async fn yaml_by_ids(
    conn: &mut sqlx::SqliteConnection,
    ids: &[String],
) -> sqlx::Result<std::collections::BTreeMap<String, String>> {
    let mut out = std::collections::BTreeMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let marks = vec!["?"; ids.len()].join(",");
    let sql = format!("SELECT id,yaml FROM scenarios WHERE id IN ({marks})");
    let mut q = sqlx::query(&sql);
    for id in ids {
        q = q.bind(id);
    }
    for r in q.fetch_all(&mut *conn).await? {
        out.insert(r.get::<String, _>("id"), r.get::<String, _>("yaml"));
    }
    Ok(out)
}

pub async fn get(db: &Db, id: &str) -> sqlx::Result<Option<ScenarioRow>> {
    let row = sqlx::query_as::<_, (String, String, String, i64, i64, i64, Option<String>)>(
        "SELECT id,name,yaml,created_at,updated_at,version,group_name FROM scenarios WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(id, name, yaml, c, u, v, group)| ScenarioRow {
        id,
        name,
        yaml,
        created_at: c,
        updated_at: u,
        version: v,
        group,
    }))
}

pub async fn list(db: &Db) -> sqlx::Result<Vec<ScenarioRow>> {
    let rows = sqlx::query(
        "SELECT id,name,yaml,created_at,updated_at,version,group_name FROM scenarios \
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
            group: r.get("group_name"),
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
    let stored = sqlx::query("SELECT created_at, group_name FROM scenarios WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let created_at: i64 = stored.get("created_at");
    let group: Option<String> = stored.get("group_name");
    tx.commit().await?;
    Ok(UpdateOutcome::Updated(ScenarioRow {
        id: id.to_string(),
        name: new_name.to_string(),
        yaml: new_yaml.to_string(),
        created_at,
        updated_at: now,
        version: new_version,
        group,
    }))
}

#[derive(Debug, PartialEq)]
pub enum DeleteOutcome {
    Deleted,
    ActiveRuns,
}

/// 시나리오와 참조 그래프 전체(run 이력+메트릭 10테이블·프리셋·스케줄)를 단일
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
    // 메트릭 테이블 일부는 FK 없이 run_id만 가지므로 10테이블 전수 명시 삭제.
    for table in [
        "run_metrics",
        "run_loop_metrics",
        "run_if_metrics",
        "run_group_metrics",
        "run_phase_metrics",
        "run_active_vu_metrics",
        "run_error_kind_metrics",
        "run_loop_exit_metrics",
        "run_open_loop_seconds",
        "run_worker_starts",
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

#[cfg(test)]
mod group_tests {
    use super::*;
    use crate::store;

    fn sc(name: &str) -> Scenario {
        let yaml = format!("version: 1\nname: {name}\nsteps: []\n");
        Scenario::from_yaml(&yaml).unwrap()
    }

    async fn add(db: &Db, name: &str, group: Option<&str>) -> String {
        let s = sc(name);
        insert_grouped(db, &s, "version: 1\nname: x\nsteps: []\n", group)
            .await
            .unwrap()
            .id
    }

    async fn group_of(db: &Db, id: &str) -> Option<String> {
        get(db, id).await.unwrap().expect("row").group
    }

    #[tokio::test]
    async fn insert_defaults_to_no_group() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let row = insert(&db, &sc("a"), "version: 1\nname: a\nsteps: []\n")
            .await
            .unwrap();
        assert_eq!(row.group, None);
        assert_eq!(group_of(&db, &row.id).await, None);
    }

    #[tokio::test]
    async fn insert_grouped_round_trips() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let id = add(&db, "a", Some("서비스A")).await;
        assert_eq!(group_of(&db, &id).await.as_deref(), Some("서비스A"));
        let listed = list(&db).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].group.as_deref(), Some("서비스A"));
    }

    #[tokio::test]
    async fn assign_sets_and_clears_without_touching_version() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let a = add(&db, "a", None).await;
        let b = add(&db, "b", None).await;
        let c = add(&db, "c", None).await;
        sqlx::query("UPDATE scenarios SET updated_at = 1, version = 7")
            .execute(&db)
            .await
            .unwrap();

        let n = assign_group(&db, &[a.clone(), b.clone(), "없는ID".into()], Some("G"))
            .await
            .unwrap();
        assert_eq!(n, 2);
        assert_eq!(group_of(&db, &a).await.as_deref(), Some("G"));
        assert_eq!(group_of(&db, &b).await.as_deref(), Some("G"));
        assert_eq!(group_of(&db, &c).await, None);

        let n = assign_group(&db, std::slice::from_ref(&a), None)
            .await
            .unwrap();
        assert_eq!(n, 1);
        assert_eq!(group_of(&db, &a).await, None);

        for id in [&a, &b, &c] {
            let row = get(&db, id).await.unwrap().expect("row");
            assert_eq!((row.updated_at, row.version), (1, 7));
        }
    }

    #[tokio::test]
    async fn assign_empty_ids_is_zero() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        assert_eq!(assign_group(&db, &[], Some("G")).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn rename_moves_all_and_merges() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let a = add(&db, "a", Some("A")).await;
        let b = add(&db, "b", Some("A")).await;
        let c = add(&db, "c", Some("B")).await;
        assert_eq!(rename_group(&db, "A", "B").await.unwrap(), 2);
        for id in [&a, &b, &c] {
            assert_eq!(group_of(&db, id).await.as_deref(), Some("B"));
        }
        assert_eq!(rename_group(&db, "없는그룹", "X").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn update_returns_stored_group() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let id = add(&db, "a", Some("G")).await;
        let out = update(&db, &id, "a2", "version: 1\nname: a2\nsteps: []\n", 1)
            .await
            .unwrap();
        let UpdateOutcome::Updated(row) = out else {
            panic!("expected Updated");
        };
        assert_eq!(row.group.as_deref(), Some("G"));
        assert_eq!(group_of(&db, &id).await.as_deref(), Some("G"));
    }
}

#[cfg(test)]
mod transfer_tests {
    use super::*;
    use crate::store;

    #[tokio::test]
    async fn insert_with_id_keeps_id() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let mut conn = db.acquire().await.unwrap();
        insert_with_id(&mut conn, "01J00000000000000000000001", "이름", "y: 1")
            .await
            .unwrap();
        drop(conn);
        let got = get(&db, "01J00000000000000000000001")
            .await
            .unwrap()
            .expect("row");
        assert_eq!(
            (got.name.as_str(), got.yaml.as_str(), got.version),
            ("이름", "y: 1", 1)
        );
        let mut conn = db.acquire().await.unwrap();
        let ids = vec!["01J00000000000000000000001".to_string(), "nope".to_string()];
        let m = yaml_by_ids(&mut conn, &ids).await.unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m["01J00000000000000000000001"], "y: 1");
        assert!(yaml_by_ids(&mut conn, &[]).await.unwrap().is_empty());
    }
}

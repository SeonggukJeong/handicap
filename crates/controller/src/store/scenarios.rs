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

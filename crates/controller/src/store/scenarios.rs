use handicap_engine::Scenario;
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
    let now = now_ms();
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

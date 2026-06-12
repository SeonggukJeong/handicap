use sqlx::Row;
use ulid::Ulid;

use super::Db;

/// One stored step template: a named, cross-scenario snapshot of a step sequence.
/// `steps_yaml` is the same YAML format as a scenario's `steps:` array. Copy-on-insert
/// semantics — nothing references a template, so DELETE is unguarded (ADR-0036).
#[derive(Debug, Clone)]
pub struct StepTemplateRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub steps_yaml: String,
    pub step_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

fn row_from(r: sqlx::sqlite::SqliteRow) -> StepTemplateRow {
    StepTemplateRow {
        id: r.get("id"),
        name: r.get("name"),
        description: r.get("description"),
        steps_yaml: r.get("steps_yaml"),
        step_count: r.get("step_count"),
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    }
}

pub async fn insert(
    db: &Db,
    name: &str,
    description: &str,
    steps_yaml: &str,
    step_count: i64,
) -> sqlx::Result<StepTemplateRow> {
    // Server-generated ULID — never trust a client id (matches environments.rs).
    let id = Ulid::new().to_string();
    let now = super::now_ms();
    sqlx::query(
        "INSERT INTO step_templates(id,name,description,steps_yaml,step_count,created_at,updated_at) \
         VALUES(?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(name)
    .bind(description)
    .bind(steps_yaml)
    .bind(step_count)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    Ok(StepTemplateRow {
        id,
        name: name.to_string(),
        description: description.to_string(),
        steps_yaml: steps_yaml.to_string(),
        step_count,
        created_at: now,
        updated_at: now,
    })
}

pub async fn get(db: &Db, id: &str) -> sqlx::Result<Option<StepTemplateRow>> {
    let row = sqlx::query(
        "SELECT id,name,description,steps_yaml,step_count,created_at,updated_at \
         FROM step_templates WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(row_from))
}

/// Name lookup for the 409 ConflictJson body — the UI's overwrite flow needs the
/// conflicting row's id to issue a PUT (spec §4.3).
pub async fn find_by_name(db: &Db, name: &str) -> sqlx::Result<Option<StepTemplateRow>> {
    let row = sqlx::query(
        "SELECT id,name,description,steps_yaml,step_count,created_at,updated_at \
         FROM step_templates WHERE name = ?",
    )
    .bind(name)
    .fetch_optional(db)
    .await?;
    Ok(row.map(row_from))
}

pub async fn list(db: &Db) -> sqlx::Result<Vec<StepTemplateRow>> {
    let rows = sqlx::query(
        "SELECT id,name,description,steps_yaml,step_count,created_at,updated_at \
         FROM step_templates ORDER BY name",
    )
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(row_from).collect())
}

/// Full-body replace. Returns `None` if no template with `id` exists.
pub async fn update(
    db: &Db,
    id: &str,
    name: &str,
    description: &str,
    steps_yaml: &str,
    step_count: i64,
) -> sqlx::Result<Option<StepTemplateRow>> {
    let now = super::now_ms();
    let res = sqlx::query(
        "UPDATE step_templates SET name = ?, description = ?, steps_yaml = ?, \
         step_count = ?, updated_at = ? WHERE id = ?",
    )
    .bind(name)
    .bind(description)
    .bind(steps_yaml)
    .bind(step_count)
    .bind(now)
    .bind(id)
    .execute(db)
    .await?;
    if res.rows_affected() == 0 {
        return Ok(None);
    }
    get(db, id).await
}

pub async fn delete(db: &Db, id: &str) -> sqlx::Result<()> {
    // No guard: nothing references a template (copy-on-insert snapshot, ADR-0036).
    sqlx::query("DELETE FROM step_templates WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;

    const YAML: &str =
        "- id: A\n  name: x\n  type: http\n  request:\n    method: GET\n    url: /x\n";

    #[tokio::test]
    async fn insert_get_list_update_delete_roundtrip() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let row = insert(&db, "login-flow", "로그인", YAML, 1).await.unwrap();

        let got = get(&db, &row.id).await.unwrap().expect("template");
        assert_eq!(got.name, "login-flow");
        assert_eq!(got.description, "로그인");
        assert_eq!(got.steps_yaml, YAML);
        assert_eq!(got.step_count, 1);

        let listed = list(&db).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, row.id);

        let updated = update(&db, &row.id, "login-v2", "", YAML, 1)
            .await
            .unwrap()
            .expect("updated");
        assert_eq!(updated.name, "login-v2");
        assert!(updated.updated_at >= row.updated_at);

        delete(&db, &row.id).await.unwrap();
        assert!(get(&db, &row.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn unique_name_is_enforced() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        insert(&db, "dup", "", YAML, 1).await.unwrap();
        let err = insert(&db, "dup", "", YAML, 1)
            .await
            .expect_err("second insert with same name must fail");
        assert!(
            err.as_database_error()
                .map(|d| d.is_unique_violation())
                .unwrap_or(false),
            "expected a UNIQUE violation, got {err:?}"
        );
    }

    #[tokio::test]
    async fn find_by_name_hit_and_miss() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let row = insert(&db, "exists", "", YAML, 1).await.unwrap();
        assert_eq!(
            find_by_name(&db, "exists").await.unwrap().expect("hit").id,
            row.id
        );
        assert!(find_by_name(&db, "nope").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn update_missing_returns_none() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let out = update(&db, "nope", "x", "", YAML, 1).await.unwrap();
        assert!(out.is_none());
    }
}

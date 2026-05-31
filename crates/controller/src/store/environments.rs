use std::collections::BTreeMap;

use sqlx::Row;
use ulid::Ulid;

use super::Db;

/// One stored environment: a named, cross-scenario bundle of `${ENV}` values.
/// `vars` is an ordered map so list output and round-trips are deterministic.
#[derive(Debug, Clone)]
pub struct EnvironmentRow {
    pub id: String,
    pub name: String,
    pub vars: BTreeMap<String, String>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub async fn insert(
    db: &Db,
    name: &str,
    vars: &BTreeMap<String, String>,
) -> sqlx::Result<EnvironmentRow> {
    // Server-generated ULID — never trust a client/UUID (matches runs.rs/presets.rs).
    let id = Ulid::new().to_string();
    let now = super::now_ms();
    let vars_json = serde_json::to_string(vars).expect("serialize env vars");
    sqlx::query(
        "INSERT INTO environments(id,name,vars_json,created_at,updated_at) \
         VALUES(?,?,?,?,?)",
    )
    .bind(&id)
    .bind(name)
    .bind(&vars_json)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    Ok(EnvironmentRow {
        id,
        name: name.to_string(),
        vars: vars.clone(),
        created_at: now,
        updated_at: now,
    })
}

pub async fn get(db: &Db, id: &str) -> sqlx::Result<Option<EnvironmentRow>> {
    let row = sqlx::query(
        "SELECT id,name,vars_json,created_at,updated_at FROM environments WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(r) = row else { return Ok(None) };
    let vars: BTreeMap<String, String> =
        serde_json::from_str(r.get::<String, _>("vars_json").as_str()).unwrap_or_default();
    Ok(Some(EnvironmentRow {
        id: r.get("id"),
        name: r.get("name"),
        vars,
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    }))
}

pub async fn list(db: &Db) -> sqlx::Result<Vec<EnvironmentRow>> {
    let rows = sqlx::query(
        "SELECT id,name,vars_json,created_at,updated_at FROM environments ORDER BY name",
    )
    .fetch_all(db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let vars: BTreeMap<String, String> =
            serde_json::from_str(r.get::<String, _>("vars_json").as_str()).unwrap_or_default();
        out.push(EnvironmentRow {
            id: r.get("id"),
            name: r.get("name"),
            vars,
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
        });
    }
    Ok(out)
}

/// Full-body replace. Returns `None` if no environment with `id` exists.
pub async fn update(
    db: &Db,
    id: &str,
    name: &str,
    vars: &BTreeMap<String, String>,
) -> sqlx::Result<Option<EnvironmentRow>> {
    let now = super::now_ms();
    let vars_json = serde_json::to_string(vars).expect("serialize env vars");
    let res =
        sqlx::query("UPDATE environments SET name = ?, vars_json = ?, updated_at = ? WHERE id = ?")
            .bind(name)
            .bind(&vars_json)
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
    // No guard: nothing references an environment (snapshot overlay model, B-2).
    sqlx::query("DELETE FROM environments WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;

    fn vars(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[tokio::test]
    async fn insert_get_list_update_delete_roundtrip() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let v = vars(&[("BASE_URL", "http://x"), ("API_KEY", "sk-1")]);
        let row = insert(&db, "staging", &v).await.unwrap();

        let got = get(&db, &row.id).await.unwrap().expect("env");
        assert_eq!(got.name, "staging");
        assert_eq!(got.vars, v); // JSON round-trip preserves the map

        let listed = list(&db).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, row.id);

        let v2 = vars(&[("BASE_URL", "http://y")]);
        let updated = update(&db, &row.id, "prod", &v2)
            .await
            .unwrap()
            .expect("updated");
        assert_eq!(updated.name, "prod");
        assert_eq!(updated.vars, v2);

        delete(&db, &row.id).await.unwrap();
        assert!(get(&db, &row.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn unique_name_is_enforced() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        insert(&db, "dup", &vars(&[])).await.unwrap();
        let err = insert(&db, "dup", &vars(&[]))
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
    async fn update_missing_returns_none() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let out = update(&db, "nope", "x", &vars(&[])).await.unwrap();
        assert!(out.is_none());
    }

    #[tokio::test]
    async fn empty_vars_roundtrips() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let row = insert(&db, "empty", &vars(&[])).await.unwrap();
        let got = get(&db, &row.id).await.unwrap().expect("env");
        assert!(got.vars.is_empty());
    }
}

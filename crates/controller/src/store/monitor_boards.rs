use sqlx::Row;
use sqlx::sqlite::SqliteRow;
use ulid::Ulid;

use super::Db;
use crate::monitor::config::BoardConfig;

/// One stored monitor board. `config` is the whole `BoardConfig` as one JSON column.
#[derive(Debug, Clone)]
pub struct MonitorBoardRow {
    pub id: String,
    pub name: String,
    pub config: BoardConfig,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

const COLS: &str = "id,name,config_json,enabled,created_at,updated_at";

fn row_from(r: &SqliteRow) -> MonitorBoardRow {
    let id: String = r.get("id");
    let config: BoardConfig = serde_json::from_str(r.get::<String, _>("config_json").as_str())
        .unwrap_or_else(|e| {
            tracing::warn!(board_id = %id, error = %e, "monitor board config_json unparseable; using default");
            BoardConfig::default()
        });
    MonitorBoardRow {
        id,
        name: r.get("name"),
        config,
        enabled: r.get::<i64, _>("enabled") != 0,
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    }
}

pub async fn insert(db: &Db, name: &str, config: &BoardConfig) -> sqlx::Result<MonitorBoardRow> {
    let id = Ulid::new().to_string();
    let now = super::now_ms();
    let json = serde_json::to_string(config).expect("serialize board config");
    sqlx::query(
        "INSERT INTO monitor_boards(id,name,config_json,enabled,created_at,updated_at) \
         VALUES(?,?,?,0,?,?)",
    )
    .bind(&id)
    .bind(name)
    .bind(&json)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    Ok(MonitorBoardRow {
        id,
        name: name.to_string(),
        config: config.clone(),
        enabled: false,
        created_at: now,
        updated_at: now,
    })
}

pub async fn get(db: &Db, id: &str) -> sqlx::Result<Option<MonitorBoardRow>> {
    let row = sqlx::query(&format!("SELECT {COLS} FROM monitor_boards WHERE id = ?"))
        .bind(id)
        .fetch_optional(db)
        .await?;
    Ok(row.as_ref().map(row_from))
}

pub async fn list(db: &Db) -> sqlx::Result<Vec<MonitorBoardRow>> {
    let rows = sqlx::query(&format!("SELECT {COLS} FROM monitor_boards ORDER BY name"))
        .fetch_all(db)
        .await?;
    Ok(rows.iter().map(row_from).collect())
}

pub async fn list_enabled(db: &Db) -> sqlx::Result<Vec<MonitorBoardRow>> {
    let rows = sqlx::query(&format!(
        "SELECT {COLS} FROM monitor_boards WHERE enabled = 1 ORDER BY name"
    ))
    .fetch_all(db)
    .await?;
    Ok(rows.iter().map(row_from).collect())
}

/// Full-body replace (bumps `updated_at`). `None` if no board with `id`.
pub async fn update(
    db: &Db,
    id: &str,
    name: &str,
    config: &BoardConfig,
) -> sqlx::Result<Option<MonitorBoardRow>> {
    let json = serde_json::to_string(config).expect("serialize board config");
    let res = sqlx::query(
        "UPDATE monitor_boards SET name = ?, config_json = ?, updated_at = ? WHERE id = ?",
    )
    .bind(name)
    .bind(&json)
    .bind(super::now_ms())
    .bind(id)
    .execute(db)
    .await?;
    if res.rows_affected() == 0 {
        return Ok(None);
    }
    get(db, id).await
}

/// Toggles `enabled` only — `updated_at` is deliberately untouched (the screen
/// re-fetches on config changes, not on start/stop).
pub async fn set_enabled(
    db: &Db,
    id: &str,
    enabled: bool,
) -> sqlx::Result<Option<MonitorBoardRow>> {
    let res = sqlx::query("UPDATE monitor_boards SET enabled = ? WHERE id = ?")
        .bind(i64::from(enabled))
        .bind(id)
        .execute(db)
        .await?;
    if res.rows_affected() == 0 {
        return Ok(None);
    }
    get(db, id).await
}

pub async fn delete(db: &Db, id: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM monitor_boards WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitor::config::{BoardConfig, PanelConfig};
    use crate::store;

    fn cfg(sid: &str) -> BoardConfig {
        BoardConfig {
            panels: vec![PanelConfig {
                id: "01J0000000000000000000000A".into(),
                title: "t".into(),
                scenario_id: sid.into(),
                ..PanelConfig::default()
            }],
            ..BoardConfig::default()
        }
    }

    fn is_unique(e: &sqlx::Error) -> bool {
        e.as_database_error()
            .map(|d| d.is_unique_violation())
            .unwrap_or(false)
    }

    #[tokio::test]
    async fn crud_roundtrip() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let row = insert(&db, "b1", &cfg("S1")).await.unwrap();
        assert!(!row.enabled);
        let got = get(&db, &row.id).await.unwrap().expect("row");
        assert_eq!(got.name, "b1");
        assert_eq!(got.config, cfg("S1"));
        assert!(get(&db, "nope").await.unwrap().is_none());

        insert(&db, "a0", &cfg("S0")).await.unwrap();
        let names: Vec<_> = list(&db)
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.name)
            .collect();
        assert_eq!(names, vec!["a0", "b1"]);

        let upd = update(&db, &row.id, "b2", &cfg("S2"))
            .await
            .unwrap()
            .expect("upd");
        assert_eq!(upd.name, "b2");
        assert_eq!(upd.config.panels[0].scenario_id, "S2");
        assert!(update(&db, "nope", "x", &cfg("S")).await.unwrap().is_none());

        delete(&db, &row.id).await.unwrap();
        assert!(get(&db, &row.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn update_bumps_updated_at() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let row = insert(&db, "b", &cfg("S")).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let upd = update(&db, &row.id, "b", &cfg("S")).await.unwrap().unwrap();
        assert!(upd.updated_at > row.updated_at);
    }

    #[tokio::test]
    async fn set_enabled_keeps_updated_at() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let row = insert(&db, "b", &cfg("S")).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let on = set_enabled(&db, &row.id, true).await.unwrap().expect("row");
        assert!(on.enabled);
        assert_eq!(on.updated_at, row.updated_at);
        let off = set_enabled(&db, &row.id, false)
            .await
            .unwrap()
            .expect("row");
        assert!(!off.enabled);
        assert!(set_enabled(&db, "nope", true).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn list_enabled_only_enabled() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let a = insert(&db, "a", &cfg("S")).await.unwrap();
        insert(&db, "b", &cfg("S")).await.unwrap();
        set_enabled(&db, &a.id, true).await.unwrap();
        let en = list_enabled(&db).await.unwrap();
        assert_eq!(en.len(), 1);
        assert_eq!(en[0].id, a.id);
    }

    #[tokio::test]
    async fn name_unique_violation() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        insert(&db, "dup", &cfg("S")).await.unwrap();
        let err = insert(&db, "dup", &cfg("S")).await.expect_err("dup");
        assert!(is_unique(&err));
        let other = insert(&db, "other", &cfg("S")).await.unwrap();
        let err = update(&db, &other.id, "dup", &cfg("S"))
            .await
            .expect_err("dup on update");
        assert!(is_unique(&err));
    }
}

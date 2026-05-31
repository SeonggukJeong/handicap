pub mod datasets;
pub mod metrics;
pub mod presets;
pub mod runs;
pub mod scenarios;

use std::path::Path;
use std::str::FromStr;

/// Wall-clock milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Pool, Sqlite};

pub type Db = Pool<Sqlite>;

const MIGRATION_SQL_0001: &str = include_str!("migrations/0001_initial.sql");
const MIGRATION_SQL_0002: &str = include_str!("migrations/0002_run_message.sql");
const MIGRATION_SQL_0003: &str = include_str!("migrations/0003_run_loop_metrics.sql");
const MIGRATION_SQL_0004: &str = include_str!("migrations/0004_datasets.sql");
const MIGRATION_SQL_0005: &str = include_str!("migrations/0005_run_presets.sql");
const MIGRATION_SQL_0006: &str = include_str!("migrations/0006_run_if_metrics.sql");

pub async fn connect(db_url: &str) -> anyhow::Result<Db> {
    let opts = SqliteConnectOptions::from_str(db_url)?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5))
        // sqlx 0.8 enables foreign_keys ON by default, but we set it explicitly so
        // that enforcement is a documented invariant of this pool, not a library default
        // that could silently change under us.
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await?;
    sqlx::query(MIGRATION_SQL_0001).execute(&pool).await?;
    // ALTER TABLE ADD COLUMN is not idempotent on SQLite. Detect first.
    let has_message: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name = 'message'")
            .fetch_one(&pool)
            .await?;
    if has_message == 0 {
        sqlx::query(MIGRATION_SQL_0002).execute(&pool).await?;
    }
    sqlx::query(MIGRATION_SQL_0003).execute(&pool).await?;
    sqlx::query(MIGRATION_SQL_0004).execute(&pool).await?;
    sqlx::query(MIGRATION_SQL_0005).execute(&pool).await?;
    sqlx::query(MIGRATION_SQL_0006).execute(&pool).await?;
    Ok(pool)
}

pub fn url_from_path(path: &str) -> String {
    if path.starts_with("sqlite:") {
        path.to_string()
    } else {
        format!("sqlite://{}", Path::new(path).display())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn opens_and_migrates_in_memory() {
        let pool = connect("sqlite::memory:").await.expect("connect");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scenarios")
            .fetch_one(&pool)
            .await
            .expect("query");
        assert_eq!(count, 0);
    }

    #[test]
    fn now_ms_is_positive_and_recent() {
        let t = super::now_ms();
        assert!(
            t > 1_700_000_000_000,
            "now_ms should be a ms-epoch timestamp"
        );
    }

    /// FK enforcement must be ON: inserting a run with a non-existent scenario_id must fail.
    #[tokio::test]
    async fn foreign_keys_enforced() {
        let db = connect("sqlite::memory:").await.unwrap();
        // Verify the pragma is actually ON.
        let fk_on: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(fk_on, 1, "PRAGMA foreign_keys must be 1 after connect()");
        // scenario_id 'NOPE' does not exist in scenarios — only the FK should cause failure.
        let res = sqlx::query(
            "INSERT INTO runs \
             (id, scenario_id, scenario_yaml, profile_json, env_json, status, created_at) \
             VALUES ('r1', 'NOPE', '', '{}', '{}', 'pending', 0)",
        )
        .execute(&db)
        .await;
        assert!(
            res.is_err(),
            "FK violation should be rejected when foreign_keys=ON"
        );
    }
}

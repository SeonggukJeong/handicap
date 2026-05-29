pub mod metrics;
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

pub async fn connect(db_url: &str) -> anyhow::Result<Db> {
    let opts = SqliteConnectOptions::from_str(db_url)?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5));
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
}

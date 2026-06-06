pub mod datasets;
pub mod environments;
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
const MIGRATION_SQL_0007: &str = include_str!("migrations/0007_environments.sql");
const MIGRATION_SQL_0010: &str = include_str!("migrations/0010_run_group_metrics.sql");

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
    sqlx::query(MIGRATION_SQL_0007).execute(&pool).await?;
    ensure_run_metrics_worker_id(&pool).await?; // migration 0008 (Rust-guarded; see fn)
    ensure_runs_dropped(&pool).await?; // migration 0009 (Rust-guarded; see fn)
    sqlx::query(MIGRATION_SQL_0010).execute(&pool).await?; // migration 0010: run_group_metrics
    Ok(pool)
}

/// migration 0008 (Rust-guarded): add `worker_id` to the `run_metrics` PRIMARY KEY
/// so N workers' windows for the same (run_id, ts_second, step_id) coexist as
/// separate rows (read-time merge in report.rs / metrics::summary). SQLite can't
/// ALTER a table's PK, and run_metrics is `CREATE TABLE IF NOT EXISTS` (0001), so
/// we rebuild: new table -> copy -> drop -> rename. Guarded on the worker_id column
/// so the second startup skips entirely (idempotent; existing rows kept with the
/// sentinel worker_id ''). Same shape as the runs.message column guard in connect().
async fn ensure_run_metrics_worker_id(db: &Db) -> anyhow::Result<()> {
    let has_col: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('run_metrics') WHERE name = 'worker_id'",
    )
    .fetch_one(db)
    .await?;
    if has_col != 0 {
        return Ok(());
    }
    // Rebuild atomically on one connection. SAFETY (why this is correct with
    // foreign_keys=ON, not a hand-wave):
    //   (1) This runs inside connect() during single-threaded startup, BEFORE the pool
    //       is handed to the app — no other pooled connection observes the transient
    //       state, so max_connections(8) is irrelevant here.
    //   (2) run_metrics is referenced by NO other table (grep: zero `REFERENCES
    //       run_metrics`), so `ALTER ... RENAME` rewrites no foreign-key clauses
    //       elsewhere — the documented hazard of table rebuilds under FKs.
    //   (3) The copied rows already satisfy run_metrics.run_id -> runs(id) (same FK as
    //       the old table), so COMMIT's FK check passes.
    // DDL is transactional in SQLite, so the CREATE/INSERT/DROP/RENAME commit or roll
    // back as a unit.
    let mut tx = db.begin().await?;
    sqlx::query(
        "CREATE TABLE run_metrics_v2 ( \
           run_id        TEXT NOT NULL REFERENCES runs(id), \
           ts_second     INTEGER NOT NULL, \
           step_id       TEXT NOT NULL, \
           worker_id     TEXT NOT NULL DEFAULT '', \
           count         INTEGER NOT NULL, \
           error_count   INTEGER NOT NULL, \
           hdr_histogram BLOB NOT NULL, \
           status_counts TEXT NOT NULL, \
           PRIMARY KEY (run_id, ts_second, step_id, worker_id) \
         )",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO run_metrics_v2 \
           (run_id, ts_second, step_id, worker_id, count, error_count, hdr_histogram, status_counts) \
         SELECT run_id, ts_second, step_id, '', count, error_count, hdr_histogram, status_counts \
         FROM run_metrics",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("DROP TABLE run_metrics")
        .execute(&mut *tx)
        .await?;
    sqlx::query("ALTER TABLE run_metrics_v2 RENAME TO run_metrics")
        .execute(&mut *tx)
        .await?;
    // The DROP took idx_metrics_run with it; recreate so the live /metrics query stays
    // indexed within this same startup (0001's CREATE INDEX IF NOT EXISTS only re-runs
    // on the NEXT connect()).
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_metrics_run ON run_metrics(run_id)")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// migration 0009 (Rust-guarded): add the `dropped` column to `runs` (open-loop
/// run-total arrivals dropped). Idempotent — SQLite ADD COLUMN isn't, so detect first.
async fn ensure_runs_dropped(db: &Db) -> anyhow::Result<()> {
    let has: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name = 'dropped'")
            .fetch_one(db)
            .await?;
    if has == 0 {
        sqlx::query("ALTER TABLE runs ADD COLUMN dropped INTEGER NOT NULL DEFAULT 0")
            .execute(db)
            .await?;
    }
    Ok(())
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
    async fn run_metrics_worker_id_migration_is_idempotent_and_preserves_rows() {
        // Build a pool with the OLD run_metrics schema only (no 0008 guard yet), so
        // we exercise the OLD->NEW rebuild path. max_connections(1) pins one shared
        // in-memory db (avoids the `:memory:` per-connection footgun in tests).
        let opts = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::query(MIGRATION_SQL_0001)
            .execute(&pool)
            .await
            .unwrap();

        // Seed scenario + run (FK: run_metrics.run_id REFERENCES runs(id)).
        sqlx::query(
            "INSERT INTO scenarios(id,name,yaml,created_at,updated_at,version) VALUES(?,?,?,?,?,?)",
        )
        .bind("S1")
        .bind("n")
        .bind("version: 1\nname: n\nsteps: []\n")
        .bind(1_i64)
        .bind(1_i64)
        .bind(1_i64)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO runs(id,scenario_id,scenario_yaml,profile_json,env_json,status,created_at) \
             VALUES(?,?,?,?,?,?,?)",
        )
        .bind("R1").bind("S1").bind("version: 1\nname: n\nsteps: []\n")
        .bind("{}").bind("{}").bind("completed").bind(1_i64)
        .execute(&pool).await.unwrap();

        // One OLD-schema metric row (no worker_id column exists yet).
        sqlx::query(
            "INSERT INTO run_metrics(run_id,ts_second,step_id,count,error_count,hdr_histogram,status_counts) \
             VALUES(?,?,?,?,?,?,?)",
        )
        .bind("R1").bind(7_i64).bind("s").bind(4_i64).bind(0_i64)
        .bind(vec![1u8, 2, 3]).bind("{}")
        .execute(&pool).await.unwrap();

        // First call: rebuild (adds worker_id to PK, copies row with sentinel '').
        ensure_run_metrics_worker_id(&pool).await.unwrap();

        let has_col: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('run_metrics') WHERE name = 'worker_id'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(has_col, 1, "worker_id column must exist after rebuild");

        let (cnt, wid): (i64, String) = sqlx::query_as(
            "SELECT count, worker_id FROM run_metrics WHERE run_id='R1' AND ts_second=7 AND step_id='s'",
        )
        .fetch_one(&pool).await.unwrap();
        assert_eq!(cnt, 4, "existing row must be preserved");
        assert_eq!(wid, "", "migrated row gets sentinel worker_id ''");

        // Second call: guard sees worker_id present -> no-op (idempotent), row intact.
        ensure_run_metrics_worker_id(&pool).await.unwrap();
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM run_metrics")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 1, "second call must not duplicate or drop rows");
    }

    #[tokio::test]
    async fn runs_dropped_column_guard_is_idempotent() {
        // Build a pool with the OLD schema (no `dropped` column), mirroring how the
        // worker_id idempotency test builds its old-schema pool.
        let opts = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::query(MIGRATION_SQL_0001)
            .execute(&pool)
            .await
            .unwrap();

        // Seed scenario + run so we can assert the existing row is preserved.
        sqlx::query(
            "INSERT INTO scenarios(id,name,yaml,created_at,updated_at,version) VALUES(?,?,?,?,?,?)",
        )
        .bind("S1")
        .bind("n")
        .bind("version: 1\nname: n\nsteps: []\n")
        .bind(1_i64)
        .bind(1_i64)
        .bind(1_i64)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO runs(id,scenario_id,scenario_yaml,profile_json,env_json,status,created_at) \
             VALUES(?,?,?,?,?,?,?)",
        )
        .bind("R1")
        .bind("S1")
        .bind("version: 1\nname: n\nsteps: []\n")
        .bind("{}")
        .bind("{}")
        .bind("completed")
        .bind(1_i64)
        .execute(&pool)
        .await
        .unwrap();

        // First call: adds the `dropped` column.
        ensure_runs_dropped(&pool).await.unwrap();
        // Second call: no-op (idempotent).
        ensure_runs_dropped(&pool).await.unwrap();

        let has: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name = 'dropped'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(has, 1, "dropped column must exist after guard");

        // Existing row gets DEFAULT 0 backfill (ADD COLUMN with DEFAULT 0).
        let dropped: i64 = sqlx::query_scalar("SELECT dropped FROM runs WHERE id='R1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(dropped, 0, "existing run row must get dropped=0 default");
    }

    // Catches the "guard defined but never wired into connect()" regression.
    #[tokio::test]
    async fn connect_applies_runs_dropped_migration() {
        let pool = connect("sqlite::memory:").await.expect("connect");
        let has: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name = 'dropped'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            has, 1,
            "connect() must apply migration 0009 (dropped column)"
        );
    }

    // Catches the "guard defined but never wired into connect()" regression — the test
    // above calls the guard directly and would pass even if Step 4's one-line wiring is
    // forgotten. This goes through the real connect() path instead.
    #[tokio::test]
    async fn connect_applies_run_metrics_worker_id_migration() {
        let pool = connect("sqlite::memory:").await.expect("connect");
        let has_col: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('run_metrics') WHERE name = 'worker_id'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            has_col, 1,
            "connect() must apply migration 0008 (worker_id column)"
        );
    }

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

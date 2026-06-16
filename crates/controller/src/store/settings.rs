//! `settings` 테이블 raw I/O. 범위 재검증은 여기 아님 — SettingsState::build(§4.1 M3).
use std::collections::HashMap;

use sqlx::Row;

use super::Db;

/// value TEXT→i64. 파싱 실패는 skip+warn(스냅샷 빌더가 범위 재검증).
pub async fn load_overrides(db: &Db) -> sqlx::Result<HashMap<String, i64>> {
    let rows = sqlx::query("SELECT key, value FROM settings")
        .fetch_all(db)
        .await?;
    let mut out = HashMap::new();
    for r in rows {
        let key: String = r.get("key");
        let raw: String = r.get("value");
        match raw.parse::<i64>() {
            Ok(v) => {
                out.insert(key, v);
            }
            Err(_) => tracing::warn!(key, value = raw, "settings 오버라이드 파싱 실패 — 무시"),
        }
    }
    Ok(out)
}

pub async fn upsert(db: &Db, key: &str, value: i64, now_ms: i64) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key)
    .bind(value.to_string())
    .bind(now_ms)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn delete(db: &Db, key: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM settings WHERE key = ?")
        .bind(key)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;

    #[tokio::test]
    async fn upsert_load_delete_roundtrip() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        assert!(load_overrides(&db).await.unwrap().is_empty());
        upsert(&db, "max_data_bindings", 20, 1).await.unwrap();
        upsert(&db, "max_data_bindings", 30, 2).await.unwrap(); // 멱등 upsert
        let m = load_overrides(&db).await.unwrap();
        assert_eq!(m.get("max_data_bindings"), Some(&30));
        delete(&db, "max_data_bindings").await.unwrap();
        assert!(load_overrides(&db).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn load_overrides_skips_unparseable_rows() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        // typed upsert를 우회해 비-i64 값을 직접 삽입 → load_overrides가 skip+warn해야 함.
        sqlx::query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
            .bind("bad_key")
            .bind("not-a-number")
            .bind(0_i64)
            .execute(&db)
            .await
            .unwrap();
        upsert(&db, "good_key", 42, 1).await.unwrap();
        let m = load_overrides(&db).await.unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m.get("good_key"), Some(&42));
        assert!(!m.contains_key("bad_key"));
    }

    #[tokio::test]
    async fn migration_0017_is_idempotent() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        // connect()가 이미 0017 실행 → 재실행 무해(CREATE IF NOT EXISTS).
        sqlx::query(super::super::MIGRATION_SQL_0017)
            .execute(&db)
            .await
            .unwrap();
        upsert(&db, "x", 1, 1).await.unwrap(); // 테이블 존재 확인
    }
}

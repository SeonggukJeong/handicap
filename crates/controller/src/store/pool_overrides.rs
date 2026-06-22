//! Persisted operator control overrides for stable (operator-named) pool workers.
//! Re-attached on cold register (controller restart / reaper eviction). LAN ops.
use crate::store::{Db, now_ms};

#[derive(Debug, Clone, PartialEq)]
pub struct PoolOverride {
    pub drained: bool,
    pub capacity_override: Option<u32>,
    pub label: Option<String>,
}

/// Fetch the persisted override for a stable worker (None = no row = defaults).
pub async fn get_pool_override(db: &Db, worker_id: &str) -> anyhow::Result<Option<PoolOverride>> {
    let row = sqlx::query_as::<_, (i64, Option<i64>, Option<String>)>(
        "SELECT drained, capacity_override, label FROM pool_worker_overrides WHERE worker_id = ?",
    )
    .bind(worker_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(drained, cap, label)| PoolOverride {
        drained: drained != 0,
        capacity_override: cap.map(|c| c as u32),
        label,
    }))
}

/// Insert-or-replace the override row (stamps `updated_at = now_ms`).
pub async fn upsert_pool_override(
    db: &Db,
    worker_id: &str,
    drained: bool,
    capacity_override: Option<u32>,
    label: Option<&str>,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO pool_worker_overrides (worker_id, drained, capacity_override, label, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(worker_id) DO UPDATE SET
           drained = excluded.drained,
           capacity_override = excluded.capacity_override,
           label = excluded.label,
           updated_at = excluded.updated_at",
    )
    .bind(worker_id)
    .bind(drained as i64)
    .bind(capacity_override.map(|c| c as i64))
    .bind(label)
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(())
}

/// Remove the override row (called when control returns to all-default).
pub async fn delete_pool_override(db: &Db, worker_id: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM pool_worker_overrides WHERE worker_id = ?")
        .bind(worker_id)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn override_roundtrip_and_delete() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        assert_eq!(get_pool_override(&db, "w1").await.unwrap(), None);
        upsert_pool_override(&db, "w1", true, Some(7), Some("office"))
            .await
            .unwrap();
        let o = get_pool_override(&db, "w1").await.unwrap().unwrap();
        assert!(o.drained);
        assert_eq!(o.capacity_override, Some(7));
        assert_eq!(o.label.as_deref(), Some("office"));
        // upsert overwrites
        upsert_pool_override(&db, "w1", false, None, None)
            .await
            .unwrap();
        let o2 = get_pool_override(&db, "w1").await.unwrap().unwrap();
        assert!(!o2.drained);
        assert_eq!(o2.capacity_override, None);
        assert_eq!(o2.label, None);
        // delete
        delete_pool_override(&db, "w1").await.unwrap();
        assert_eq!(get_pool_override(&db, "w1").await.unwrap(), None);
    }
}

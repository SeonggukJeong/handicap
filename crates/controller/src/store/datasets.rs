use std::collections::BTreeMap;

use serde::Serialize;
use sqlx::Row;
use ulid::Ulid;

use super::{Db, now_ms};

/// 데이터셋 메타(행 데이터 제외).
#[derive(Debug, Clone, Serialize)]
pub struct DatasetMeta {
    pub id: String,
    pub name: String,
    pub columns: Vec<String>,
    pub row_count: i64,
    pub byte_size: i64,
    pub created_at: i64,
}

/// 파싱된 컬럼 + 행(컬럼 정렬된 셀)을 저장하고 새 dataset id 반환.
/// 행은 columns 순서대로 `{"col": "cell"}` JSON 객체로 직렬화한다.
pub async fn insert(
    db: &Db,
    name: &str,
    columns: &[String],
    rows: &[Vec<String>],
    byte_size: i64,
) -> Result<String, sqlx::Error> {
    let id = Ulid::new().to_string();
    let now = now_ms();
    let columns_json = serde_json::to_string(columns).unwrap_or_else(|_| "[]".to_string());

    let mut tx = db.begin().await?;
    sqlx::query(
        "INSERT INTO datasets(id,name,columns_json,row_count,byte_size,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(name)
    .bind(&columns_json)
    .bind(rows.len() as i64)
    .bind(byte_size)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    for (idx, cells) in rows.iter().enumerate() {
        let row_json = row_to_json(columns, cells);
        sqlx::query("INSERT INTO dataset_rows(dataset_id,idx,row_json) VALUES(?,?,?)")
            .bind(&id)
            .bind(idx as i64)
            .bind(&row_json)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(id)
}

/// columns 순서대로 cells를 매핑한 JSON 객체 문자열. cells가 짧으면 빈 문자열로 패딩.
fn row_to_json(columns: &[String], cells: &[String]) -> String {
    let mut map = serde_json::Map::with_capacity(columns.len());
    for (i, col) in columns.iter().enumerate() {
        let v = cells.get(i).cloned().unwrap_or_default();
        map.insert(col.clone(), serde_json::Value::String(v));
    }
    serde_json::Value::Object(map).to_string()
}

pub async fn get_meta(db: &Db, id: &str) -> Result<Option<DatasetMeta>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id,name,columns_json,row_count,byte_size,created_at FROM datasets WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|r| DatasetMeta {
        id: r.get("id"),
        name: r.get("name"),
        columns: parse_columns(r.get::<String, _>("columns_json")),
        row_count: r.get("row_count"),
        byte_size: r.get("byte_size"),
        created_at: r.get("created_at"),
    }))
}

pub async fn list(db: &Db) -> Result<Vec<DatasetMeta>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id,name,columns_json,row_count,byte_size,created_at FROM datasets ORDER BY created_at DESC",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| DatasetMeta {
            id: r.get("id"),
            name: r.get("name"),
            columns: parse_columns(r.get::<String, _>("columns_json")),
            row_count: r.get("row_count"),
            byte_size: r.get("byte_size"),
            created_at: r.get("created_at"),
        })
        .collect())
}

/// 처음 `limit`개 행을 컬럼→값 맵으로 반환(idx 순서).
pub async fn get_sample(
    db: &Db,
    id: &str,
    limit: i64,
) -> Result<Vec<BTreeMap<String, String>>, sqlx::Error> {
    let rows =
        sqlx::query("SELECT row_json FROM dataset_rows WHERE dataset_id = ? ORDER BY idx LIMIT ?")
            .bind(id)
            .bind(limit)
            .fetch_all(db)
            .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let s: String = r.get("row_json");
            serde_json::from_str::<BTreeMap<String, String>>(&s).unwrap_or_default()
        })
        .collect())
}

/// 데이터셋 + 행 삭제(앱 레벨 cascade).
pub async fn delete(db: &Db, id: &str) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM dataset_rows WHERE dataset_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM datasets WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

fn parse_columns(json: String) -> Vec<String> {
    serde_json::from_str(&json).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;

    #[tokio::test]
    async fn insert_get_list_delete_roundtrip() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let columns = vec!["email".to_string(), "pw".to_string()];
        let rows = vec![
            vec!["a@ex.com".to_string(), "p1".to_string()],
            vec!["b@ex.com".to_string(), "p2".to_string()],
        ];
        let id = insert(&db, "users", &columns, &rows, 42).await.unwrap();

        let meta = get_meta(&db, &id).await.unwrap().expect("meta");
        assert_eq!(meta.name, "users");
        assert_eq!(meta.columns, columns);
        assert_eq!(meta.row_count, 2);
        assert_eq!(meta.byte_size, 42);

        let listed = list(&db).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id);

        let sample = get_sample(&db, &id, 20).await.unwrap();
        assert_eq!(sample.len(), 2);
        assert_eq!(sample[0].get("email").map(String::as_str), Some("a@ex.com"));

        delete(&db, &id).await.unwrap();
        assert!(get_meta(&db, &id).await.unwrap().is_none());
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dataset_rows WHERE dataset_id = ?")
            .bind(&id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 0);
    }

    #[tokio::test]
    async fn get_sample_caps_rows() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let columns = vec!["c".to_string()];
        let rows: Vec<Vec<String>> = (0..50).map(|i| vec![i.to_string()]).collect();
        let id = insert(&db, "big", &columns, &rows, 0).await.unwrap();
        let sample = get_sample(&db, &id, 20).await.unwrap();
        assert_eq!(sample.len(), 20, "sample은 limit까지만");
        assert_eq!(sample[0].get("c").map(String::as_str), Some("0"));
    }
}

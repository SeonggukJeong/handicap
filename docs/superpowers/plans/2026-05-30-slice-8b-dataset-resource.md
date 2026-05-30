# Slice 8b — Dataset Resource (업로드·파싱·CRUD·페이지) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CSV/XLSX 파일을 업로드하면 서버(Rust)가 파싱해 독립 `datasets` 리소스로 저장하고, 웹 UI에서 목록·드래그드롭 업로드·미리보기·삭제를 할 수 있게 한다. **이 슬라이스만으로는 데이터가 run에 주입되지 않는다** — 데이터셋을 만들고 보는 것까지(주입·바인딩은 8c).

**Architecture:** 컨트롤러에 새 SQLite 테이블 2개(`datasets`/`dataset_rows`, migration 0004, `CREATE TABLE IF NOT EXISTS` 멱등 패턴)와 `/api/datasets` REST 리소스(multipart 업로드 + parse-only preview + list/get/delete)를 추가한다. 파싱은 순수 함수 모듈(`crates/controller/src/datasets/parse.rs`)로 분리해 `csv`+`calamine`+`encoding_rs`로 처리(자동감지 + 얇은 override). UI는 새 `/datasets` 페이지(목록·드래그드롭 업로드·미리보기 표·override 패널·삭제). 워커·엔진·proto 무변경.

**Tech Stack:** Rust (edition 2024, MSRV 1.85) — `sqlx 0.8`(sqlite), `axum 0.8`(+`multipart` feature 신규), `csv`/`calamine`/`encoding_rs`(신규), `ulid`. UI — Vite + React + TS + Tailwind, React Router v6 data API, React Query, Zod, vitest + RTL.

**참조 spec:** `docs/superpowers/specs/2026-05-30-slice-8-data-driven-design.md` §2(공유 아키텍처)·§3(데이터 모델/migration 0004)·§5(API)·§6(파싱)·§9-8b(Datasets 페이지)·§11(에러·경계)·§13-8b(완료 기준)·§14(의존성)·§15(ADR-0022).

---

## 설계 결정 (작성자 — spec §5↔§9 조정)

- **spec §5 ↔ §9 조정 — preview 엔드포인트 추가**: §5는 `POST /api/datasets`를 "파싱→저장→sample 반환"으로 적었고, §9는 "미리보기 표 → 이름 확인·저장 + 오감지 시 즉시 재파싱"이라는 **저장 전 미리보기/override 재파싱** UX를 적었다. 둘을 모두 만족시키기 위해 **parse-only `POST /api/datasets/preview`(저장 안 함)** 와 **save `POST /api/datasets`(§5대로 파싱+저장)** 두 엔드포인트로 분리한다. preview는 같은 `parse_upload`를 호출하고 DB를 건드리지 않는다. (사용자가 "저장 전 미리보기 없이 한 방에 저장" 쪽을 원하면 preview 엔드포인트 + 미리보기 단계를 빼면 됨 — 그 경우 Task 3의 preview 핸들러/라우트와 Task 6의 preview 단계만 제거.)
- **DELETE는 8b에서 무조건 삭제**: §5/§7-1 "non-terminal run이 참조하면 409"는 run config `data_binding`(8c)가 dataset_id를 참조할 때만 의미가 있다. 8b에는 데이터셋을 참조하는 run이 없으므로 409 가드는 **8c로 연기**(8c가 `data_binding` 도입 시 추가). 8b DELETE는 `dataset_rows` + `datasets` 행만 지운다.
- **업로드는 관대(상한 없음)**: §11대로 단일 검증 게이트는 run-create(8c)다. 8b 업로드는 빈 데이터셋·대용량을 모두 허용(저장 무제한). 컨트롤러 `--dataset-max-rows` 플래그와 per-iteration 경고는 8c.
- **컬럼·매핑·정책은 8c**: 8b는 행을 `{"col":"value"}` JSON으로 그대로 저장만 한다(매핑/슬라이싱/주입 없음).
- **CSV 스트리밍은 future 최적화**: §6은 CSV 행단위 스트리밍 insert가 "가능"하다고 적었다. 8b는 파싱 결과를 메모리 `Vec`로 모은 뒤 한 트랜잭션으로 insert(XLSX는 어차피 전체 로드). 매우 큰 CSV의 진짜 스트리밍 insert는 명시적 future(필요 시 별도 최적화).

---

## File Structure

**Backend (`crates/controller`)**
- **Modify** `Cargo.toml`(워크스페이스 루트): `axum`에 `"multipart"` feature 추가, `[workspace.dependencies]`에 `csv`/`calamine`/`encoding_rs`(+dev `rust_xlsxwriter`) 추가.
- **Modify** `crates/controller/Cargo.toml`: 새 deps를 `*.workspace = true`로 인용, dev-dep `rust_xlsxwriter`.
- **Create** `crates/controller/src/datasets/mod.rs`: 파싱 모듈 re-export + 공유 타입(`ParseOptions`, `ParsedDataset`, `ParseError`).
- **Create** `crates/controller/src/datasets/parse.rs`: 순수 파싱 로직(CSV/XLSX/인코딩/정규화) + 단위 테스트.
- **Modify** `crates/controller/src/lib.rs`: `pub mod datasets;` 추가.
- **Create** `crates/controller/src/store/migrations/0004_datasets.sql`: 테이블 2개.
- **Modify** `crates/controller/src/store/mod.rs`: `MIGRATION_SQL_0004` 상수 + `connect()`에서 실행 + `pub mod datasets;`.
- **Create** `crates/controller/src/store/datasets.rs`: `insert`/`list`/`get_meta`/`get_sample`/`delete` + 단위 테스트.
- **Create** `crates/controller/src/api/datasets.rs`: 핸들러(`upload`/`preview`/`list`/`get`/`delete`) + 요청/응답 구조체.
- **Modify** `crates/controller/src/api/mod.rs`: `pub mod datasets;`.
- **Modify** `crates/controller/src/app.rs`: `/datasets` 라우트 등록.
- **Create** `crates/controller/tests/datasets_api_test.rs`: oneshot CRUD 흐름(업로드→목록→get→delete) + multipart 헬퍼.

**UI (`ui/`)**
- **Modify** `ui/src/api/schemas.ts`: Dataset Zod 스키마.
- **Modify** `ui/src/api/client.ts`: `listDatasets`/`getDataset`/`previewDataset`/`uploadDataset`(multipart)/`deleteDataset` + multipart 전용 fetch 경로.
- **Modify** `ui/src/api/hooks.ts`: React Query 훅 + `queryKeys.datasets`.
- **Modify** `ui/src/routes.tsx`: `/datasets` 라우트.
- **Modify** `ui/src/components/Layout.tsx`: nav 링크.
- **Create** `ui/src/pages/DatasetsPage.tsx`: 목록 + 삭제 + 업로드 패널 마운트.
- **Create** `ui/src/components/datasets/UploadPanel.tsx`: 드래그드롭/파일선택 + override 컨트롤 + 미리보기 표 + 이름·저장.
- **Create** `ui/src/pages/__tests__/DatasetsPage.test.tsx`: RTL.
- **Create** `ui/src/components/datasets/__tests__/UploadPanel.test.tsx`: RTL.

**Docs**
- **Create** `docs/adr/0022-data-driven-datasets.md`.
- **Modify** `CLAUDE.md`: 상태 줄, "알아둘 결정들" ADR-0022, "Slice 8b에서 배운 함정들" 섹션.

> **함정(spec §11)**: 8b는 엔진·워커를 건드리지 않으므로 `cargo build -p handicap-worker` 재빌드 함정은 무관(8c에서 다시 등장). 단 새 deps 추가 후 `just build && just lint && just test` + lockfile 커밋은 필수.

---

## Task 0: 의존성 추가 + 핀 + MSRV/edition 빌드 검증 (R6 / spec §14)

**Files:**
- Modify: `Cargo.toml`(워크스페이스 루트)
- Modify: `crates/controller/Cargo.toml`

- [ ] **Step 1: 워크스페이스 deps 추가**

`Cargo.toml`(루트)의 `[workspace.dependencies]`에서 `axum` 줄을 multipart 포함으로 교체하고, 세 파싱 deps + dev용 xlsx writer를 추가:

```toml
# 기존:
# axum = { version = "0.8", features = ["macros"] }
axum = { version = "0.8", features = ["macros", "multipart"] }

# 신규 (버전은 cargo add가 해석한 최신을 핀; 아래는 시작 메이저):
csv = "1"
calamine = "0.26"
encoding_rs = "0.8"
rust_xlsxwriter = "0.79"   # dev 전용(테스트에서 XLSX 픽스처 생성) — 런타임 이미지에 안 들어감
```

- [ ] **Step 2: controller 크레이트에서 인용**

`crates/controller/Cargo.toml`의 `[dependencies]`에 추가:

```toml
csv.workspace = true
calamine.workspace = true
encoding_rs.workspace = true
```

`[dev-dependencies]`에 추가:

```toml
rust_xlsxwriter.workspace = true
```

> axum은 이미 `axum.workspace = true`로 인용 중이므로 Step 1의 워크스페이스 feature 변경이 자동 반영된다(Cargo는 per-crate feature 가산 병합을 안 하므로 워크스페이스 줄에 multipart를 넣는 게 정답).

- [ ] **Step 3: 빌드 검증 (MSRV 1.85 / edition 2024)**

Run:
```bash
cargo build -p handicap-controller
cargo build -p handicap-controller --tests
```
Expected: 성공. 실패 시(calamine/csv가 MSRV 1.85를 요구치 못하면) 한 단계 낮은 버전으로 핀하고 재시도. 해석된 정확한 버전을 lockfile에서 확인:
```bash
grep -A1 'name = "calamine"' Cargo.lock | head -2
grep -A1 'name = "csv"' Cargo.lock | head -2
grep -A1 'name = "encoding_rs"' Cargo.lock | head -2
```

- [ ] **Step 4: 오프라인/이미지 영향 메모 (ADR-0001)**

calamine은 `zip`/`quick-xml` 등 트리가 크다. Docker 런타임 이미지 크기에 미치는 영향은 **런타임 바이너리에만** 반영된다(`rust_xlsxwriter`는 dev-dep이라 무관). 확인:
```bash
cargo tree -p handicap-controller -e no-dev -i calamine | head -30   # calamine 역의존 트리
```
결과(추가된 크레이트 목록)를 8b 완료 메모/PR에 한 줄로 기록(이미지 크기 회귀 모니터링용). 에어갭 vendoring은 기존 `cargo` 캐시로 충분(새 외부 레지스트리 없음).

- [ ] **Step 5: 게이트 + lockfile 커밋**

Run: `just build && just lint && just test`
Expected: 전부 PASS(기존 테스트 불변 — 아직 새 코드 없음, deps만 추가).

```bash
git add Cargo.toml Cargo.lock crates/controller/Cargo.toml
git commit -m "build(controller): add csv/calamine/encoding_rs + axum multipart for datasets (8b)"
```

---

## Task 1: Migration 0004 + dataset store 모듈

**Files:**
- Create: `crates/controller/src/store/migrations/0004_datasets.sql`
- Modify: `crates/controller/src/store/mod.rs`
- Create: `crates/controller/src/store/datasets.rs`

- [ ] **Step 1: 마이그레이션 SQL 작성**

`crates/controller/src/store/migrations/0004_datasets.sql`:

```sql
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  columns_json TEXT NOT NULL,     -- ["email","pw",...] 순서 보존
  row_count INTEGER NOT NULL,
  byte_size INTEGER NOT NULL,     -- 원본 파일 바이트 수
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dataset_rows (
  dataset_id TEXT NOT NULL,
  idx INTEGER NOT NULL,           -- 0-based
  row_json TEXT NOT NULL,         -- {"email":"a@ex.com",...}
  PRIMARY KEY (dataset_id, idx)
);
```

- [ ] **Step 2: connect()에 마이그레이션 배선 + 모듈 선언**

`crates/controller/src/store/mod.rs`에서 기존 `MIGRATION_SQL_0003` 상수 옆에 추가:

```rust
const MIGRATION_SQL_0004: &str = include_str!("migrations/0004_datasets.sql");
```

`connect()` 안 `sqlx::query(MIGRATION_SQL_0003).execute(&pool).await?;` **다음 줄**에 추가(0003·0004 모두 `CREATE TABLE IF NOT EXISTS`라 멱등):

```rust
    sqlx::query(MIGRATION_SQL_0004).execute(&pool).await?;
```

파일 상단(다른 `pub mod runs;` 류 옆)에 모듈 선언 추가:

```rust
pub mod datasets;
```

- [ ] **Step 3: store 단위 테스트 작성 (실패)**

`crates/controller/src/store/datasets.rs` 생성, 먼저 인라인 테스트만 두고 실행해 컴파일 실패를 확인한다. 최종 파일은 아래 Step 4가 채운다. 우선 테스트:

```rust
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
        // rows도 사라졌는지(cascade는 앱 레벨)
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dataset_rows WHERE dataset_id = ?")
            .bind(&id).fetch_one(&db).await.unwrap();
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
```

Run: `cargo test -p handicap-controller --lib store::datasets`
Expected: 컴파일 실패(아직 `insert`/`get_meta`/… 없음).

- [ ] **Step 4: store 구현**

`crates/controller/src/store/datasets.rs`의 테스트 위에 추가:

```rust
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
    let rows = sqlx::query("SELECT row_json FROM dataset_rows WHERE dataset_id = ? ORDER BY idx LIMIT ?")
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
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cargo test -p handicap-controller --lib store::datasets`
Expected: PASS (2 tests).

- [ ] **Step 6: 커밋**

```bash
git add crates/controller/src/store/migrations/0004_datasets.sql crates/controller/src/store/mod.rs crates/controller/src/store/datasets.rs
git commit -m "feat(controller): datasets/dataset_rows store + migration 0004 (8b)"
```

---

## Task 2: 파싱 모듈 (`datasets/parse.rs`)

**Files:**
- Create: `crates/controller/src/datasets/mod.rs`
- Create: `crates/controller/src/datasets/parse.rs`
- Modify: `crates/controller/src/lib.rs`

> **calamine API 버전 주의**: calamine은 마이너 버전마다 `worksheet_range`의 시그니처(`Result` vs `Option<Result>`)와 셀 타입 이름(`Data` vs `DataType`)이 바뀐다. 아래 코드는 calamine ~0.26 기준이다. **Task 0에서 핀한 버전의 실제 시그니처를 `cargo doc -p calamine --open` 또는 `node_modules`/소스로 확인**하고, 컴파일 에러가 나면 그 버전에 맞춰 `worksheet_range`의 `?`/`.ok_or(...)?`와 `Data`/`DataType` import만 조정한다. 로직(시트 목록·셀 문자열화·행 수집)은 동일.

- [ ] **Step 1: lib에 모듈 선언 + mod.rs re-export**

`crates/controller/src/lib.rs`에 추가:

```rust
pub mod datasets;
```

`crates/controller/src/datasets/mod.rs`:

```rust
pub mod parse;

pub use parse::{ParseError, ParseOptions, ParsedDataset, parse_upload};
```

- [ ] **Step 2: 실패하는 CSV 테스트 작성**

`crates/controller/src/datasets/parse.rs` 생성. 먼저 타입 스텁 + 테스트만:

```rust
//! 업로드된 CSV/XLSX 바이트를 컬럼 + 행(문자열 셀)으로 파싱.
//! 자동감지(헤더/구분자/인코딩/포맷) + 얇은 override.

#[derive(Debug, Clone, Default)]
pub struct ParseOptions {
    pub has_header: Option<bool>, // None = auto(true)
    pub delimiter: Option<u8>,    // None = auto(',' 기본, ';'/'\t' 감지)
    pub encoding: Option<String>, // None = auto(utf-8/BOM → cp949 fallback)
    pub sheet: Option<String>,    // XLSX 시트명; None = 첫 시트
}

#[derive(Debug, Clone)]
pub struct ParsedDataset {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,         // columns에 정렬된 셀
    pub sheets: Option<Vec<String>>,    // XLSX면 전체 시트명(UI 선택용)
}

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("디코딩 실패: {0}")]
    Decode(String),
    #[error("CSV 파싱 실패: {0}")]
    Csv(String),
    #[error("XLSX 파싱 실패: {0}")]
    Xlsx(String),
    #[error("시트 '{0}' 없음")]
    SheetNotFound(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> ParseOptions { ParseOptions::default() }

    #[test]
    fn csv_comma_with_header() {
        let bytes = b"email,pw\na@ex.com,p1\nb@ex.com,p2\n";
        let d = parse_upload(bytes, &opts()).unwrap();
        assert_eq!(d.columns, vec!["email", "pw"]);
        assert_eq!(d.rows.len(), 2);
        assert_eq!(d.rows[0], vec!["a@ex.com", "p1"]);
        assert!(d.sheets.is_none());
    }

    #[test]
    fn csv_semicolon_autodetected() {
        let bytes = b"a;b;c\n1;2;3\n";
        let d = parse_upload(bytes, &opts()).unwrap();
        assert_eq!(d.columns, vec!["a", "b", "c"]);
        assert_eq!(d.rows[0], vec!["1", "2", "3"]);
    }

    #[test]
    fn csv_tab_autodetected() {
        let bytes = b"a\tb\n1\t2\n";
        let d = parse_upload(bytes, &opts()).unwrap();
        assert_eq!(d.columns, vec!["a", "b"]);
        assert_eq!(d.rows[0], vec!["1", "2"]);
    }

    #[test]
    fn csv_no_header_generates_col_names() {
        let bytes = b"1,2,3\n4,5,6\n";
        let mut o = opts();
        o.has_header = Some(false);
        let d = parse_upload(bytes, &o).unwrap();
        assert_eq!(d.columns, vec!["col1", "col2", "col3"]);
        assert_eq!(d.rows.len(), 2);
        assert_eq!(d.rows[0], vec!["1", "2", "3"]);
    }

    #[test]
    fn csv_blank_and_duplicate_columns_normalized() {
        // 빈 헤더 → colN, 중복 → base_2
        let bytes = b"name,,name\nx,y,z\n";
        let d = parse_upload(bytes, &opts()).unwrap();
        assert_eq!(d.columns, vec!["name", "col2", "name_2"]);
    }

    #[test]
    fn csv_empty_cells_become_empty_strings_and_pad() {
        let bytes = b"a,b,c\n1,,3\n4\n"; // 둘째 데이터행은 셀 1개 → b,c는 빈 문자열로 패딩
        let d = parse_upload(bytes, &opts()).unwrap();
        assert_eq!(d.rows[0], vec!["1", "", "3"]);
        assert_eq!(d.rows[1], vec!["4", "", ""]);
    }

    #[test]
    fn csv_utf8_bom_stripped() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"name\nalice\n");
        let d = parse_upload(&bytes, &opts()).unwrap();
        assert_eq!(d.columns, vec!["name"], "BOM이 첫 컬럼명에 섞이면 안 됨");
    }

    #[test]
    fn csv_cp949_autodetected() {
        // "이름" in CP949(EUC-KR) = 0xC0 0xCC 0xB8 0xA7
        let mut bytes = vec![0xC0, 0xCC, 0xB8, 0xA7];
        bytes.extend_from_slice(b"\nx\n");
        let d = parse_upload(&bytes, &opts()).unwrap();
        assert_eq!(d.columns, vec!["이름"]);
        assert_eq!(d.rows[0], vec!["x"]);
    }

    #[test]
    fn xlsx_single_sheet() {
        let bytes = make_xlsx(&[("Sheet1", vec![vec!["a", "b"], vec!["1", "2"]])]);
        let d = parse_upload(&bytes, &opts()).unwrap();
        assert_eq!(d.columns, vec!["a", "b"]);
        assert_eq!(d.rows[0], vec!["1", "2"]);
        assert_eq!(d.sheets.as_deref(), Some(&["Sheet1".to_string()][..]));
    }

    #[test]
    fn xlsx_multi_sheet_selects_named() {
        let bytes = make_xlsx(&[
            ("First", vec![vec!["x"], vec!["1"]]),
            ("Second", vec![vec!["y"], vec!["2"]]),
        ]);
        // 기본은 첫 시트
        let d0 = parse_upload(&bytes, &opts()).unwrap();
        assert_eq!(d0.columns, vec!["x"]);
        assert_eq!(d0.sheets.as_ref().unwrap().len(), 2);
        // override로 둘째 시트
        let mut o = opts();
        o.sheet = Some("Second".to_string());
        let d1 = parse_upload(&bytes, &o).unwrap();
        assert_eq!(d1.columns, vec!["y"]);
        assert_eq!(d1.rows[0], vec!["2"]);
    }

    /// 테스트용 XLSX 바이트 생성(rust_xlsxwriter, dev-dep).
    fn make_xlsx(sheets: &[(&str, Vec<Vec<&str>>)]) -> Vec<u8> {
        use rust_xlsxwriter::Workbook;
        let mut wb = Workbook::new();
        for (name, grid) in sheets {
            let ws = wb.add_worksheet();
            ws.set_name(*name).unwrap();
            for (r, row) in grid.iter().enumerate() {
                for (c, cell) in row.iter().enumerate() {
                    ws.write_string(r as u32, c as u16, *cell).unwrap();
                }
            }
        }
        wb.save_to_buffer().unwrap()
    }
}
```

Run: `cargo test -p handicap-controller --lib datasets::parse`
Expected: 컴파일 실패(`parse_upload` 미구현).

- [ ] **Step 3: 파싱 구현**

`parse.rs`의 타입 정의 아래, `#[cfg(test)]` 위에 추가:

```rust
use std::collections::HashMap;
use std::io::Cursor;

/// 업로드 바이트를 파싱. 포맷은 매직 넘버로 감지(XLSX=zip `PK\x03\x04`, 그 외 CSV).
pub fn parse_upload(bytes: &[u8], opts: &ParseOptions) -> Result<ParsedDataset, ParseError> {
    if is_xlsx(bytes) {
        parse_xlsx(bytes, opts)
    } else {
        parse_csv(bytes, opts)
    }
}

fn is_xlsx(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && bytes[0..4] == [0x50, 0x4B, 0x03, 0x04]
}

fn parse_csv(bytes: &[u8], opts: &ParseOptions) -> Result<ParsedDataset, ParseError> {
    let text = decode(bytes, opts.encoding.as_deref())?;
    let delim = opts.delimiter.unwrap_or_else(|| detect_delimiter(&text));

    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(false) // 헤더는 우리가 직접 처리(컬럼 네이밍 제어)
        .flexible(true)
        .from_reader(text.as_bytes());

    let mut records: Vec<Vec<String>> = Vec::new();
    for rec in rdr.records() {
        let rec = rec.map_err(|e| ParseError::Csv(e.to_string()))?;
        records.push(rec.iter().map(|s| s.to_string()).collect());
    }

    let has_header = opts.has_header.unwrap_or(true);
    build(records, has_header, None)
}

fn parse_xlsx(bytes: &[u8], opts: &ParseOptions) -> Result<ParsedDataset, ParseError> {
    use calamine::{Data, Reader, Xlsx};

    let mut wb: Xlsx<_> = calamine::open_workbook_from_rs(Cursor::new(bytes.to_vec()))
        .map_err(|e| ParseError::Xlsx(e.to_string()))?;
    let sheet_names = wb.sheet_names().to_vec();
    if sheet_names.is_empty() {
        return Err(ParseError::Xlsx("시트 없음".into()));
    }
    let target = match &opts.sheet {
        Some(s) => {
            if !sheet_names.iter().any(|n| n == s) {
                return Err(ParseError::SheetNotFound(s.clone()));
            }
            s.clone()
        }
        None => sheet_names[0].clone(),
    };

    // calamine ~0.26: worksheet_range -> Result<Range<Data>, XlsxError>
    let range = wb
        .worksheet_range(&target)
        .map_err(|e| ParseError::Xlsx(e.to_string()))?;

    let mut records: Vec<Vec<String>> = Vec::new();
    for row in range.rows() {
        records.push(row.iter().map(data_to_string).collect::<Vec<_>>());
    }

    let has_header = opts.has_header.unwrap_or(true);
    build(records, has_header, Some(sheet_names))
}

/// calamine 셀을 표시 문자열로. 빈 셀→"".
fn data_to_string(cell: &calamine::Data) -> String {
    use calamine::Data;
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => {
            // 정수형 float은 ".0" 없이
            if f.fract() == 0.0 { format!("{}", *f as i64) } else { f.to_string() }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(d) => d.to_string(),
        Data::DateTimeIso(s) => s.clone(),
        Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("#ERR({e:?})"),
    }
}

/// records(헤더 포함 여부는 has_header)를 columns + 정렬된 rows로.
fn build(
    mut records: Vec<Vec<String>>,
    has_header: bool,
    sheets: Option<Vec<String>>,
) -> Result<ParsedDataset, ParseError> {
    if records.is_empty() {
        return Ok(ParsedDataset { columns: vec![], rows: vec![], sheets });
    }
    let columns: Vec<String> = if has_header {
        normalize_columns(records.remove(0))
    } else {
        let ncols = records.iter().map(|r| r.len()).max().unwrap_or(0);
        (1..=ncols).map(|i| format!("col{i}")).collect()
    };
    let width = columns.len();
    let rows: Vec<Vec<String>> = records
        .into_iter()
        .map(|mut cells| {
            cells.resize(width, String::new()); // 짧으면 빈 문자열 패딩, 길면 truncate
            cells.truncate(width);
            cells
        })
        .collect();
    Ok(ParsedDataset { columns, rows, sheets })
}

/// 빈 헤더 → colN(1-based), 중복 → base_2, base_3 …
fn normalize_columns(raw: Vec<String>) -> Vec<String> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    raw.into_iter()
        .enumerate()
        .map(|(i, name)| {
            let base = if name.trim().is_empty() {
                format!("col{}", i + 1)
            } else {
                name.trim().to_string()
            };
            let count = seen.entry(base.clone()).or_insert(0);
            *count += 1;
            if *count == 1 { base } else { format!("{base}_{count}") }
        })
        .collect()
}

/// 첫 줄에서 ','/';'/'\t' 중 최빈 구분자.
fn detect_delimiter(text: &str) -> u8 {
    let first = text.lines().next().unwrap_or("");
    let candidates = [(b',', first.matches(',').count()),
                      (b';', first.matches(';').count()),
                      (b'\t', first.matches('\t').count())];
    candidates
        .iter()
        .max_by_key(|(_, n)| *n)
        .filter(|(_, n)| *n > 0)
        .map(|(d, _)| *d)
        .unwrap_or(b',')
}

/// 인코딩 디코드. override 없으면 UTF-8(BOM strip) 시도 후 실패 시 CP949(EUC-KR).
fn decode(bytes: &[u8], encoding: Option<&str>) -> Result<String, ParseError> {
    match encoding.map(|e| e.to_ascii_lowercase()) {
        Some(e) if e == "utf-8" || e == "utf8" => decode_with(bytes, encoding_rs::UTF_8),
        Some(e) if e == "cp949" || e == "euc-kr" || e == "euckr" => {
            decode_with(bytes, encoding_rs::EUC_KR)
        }
        Some(other) => Err(ParseError::Decode(format!("지원 안 하는 인코딩: {other}"))),
        None => {
            // auto: UTF-8 strict 먼저(BOM 자동 strip), 실패 시 CP949
            if let Ok(s) = decode_with(bytes, encoding_rs::UTF_8) {
                Ok(s)
            } else {
                decode_with(bytes, encoding_rs::EUC_KR)
                    .map_err(|_| ParseError::Decode("auto: UTF-8·CP949 모두 실패".into()))
            }
        }
    }
}

fn decode_with(bytes: &[u8], enc: &'static encoding_rs::Encoding) -> Result<String, ParseError> {
    let (cow, _enc, had_errors) = enc.decode(bytes); // UTF_8.decode는 BOM도 strip
    if had_errors {
        Err(ParseError::Decode(enc.name().to_string()))
    } else {
        Ok(cow.into_owned())
    }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo test -p handicap-controller --lib datasets::parse`
Expected: PASS (11 tests). XLSX 두 테스트가 calamine 시그니처 불일치로 컴파일 실패하면 위 "버전 주의" 노트대로 `worksheet_range`/`Data` 부분만 핀 버전에 맞춰 조정.

- [ ] **Step 5: 커밋**

```bash
git add crates/controller/src/lib.rs crates/controller/src/datasets/mod.rs crates/controller/src/datasets/parse.rs
git commit -m "feat(controller): CSV/XLSX dataset parser (csv+calamine+encoding_rs) (8b)"
```

---

## Task 3: `/api/datasets` 핸들러 + 라우트 + CRUD 흐름 테스트

**Files:**
- Create: `crates/controller/src/api/datasets.rs`
- Modify: `crates/controller/src/api/mod.rs`
- Modify: `crates/controller/src/app.rs`
- Create: `crates/controller/tests/datasets_api_test.rs`

- [ ] **Step 1: 통합 테스트 작성 (실패) — multipart 헬퍼 포함**

`crates/controller/tests/datasets_api_test.rs`:

```rust
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::app::{self, AppState};
use handicap_controller::dispatcher::SubprocessDispatcher;
use handicap_controller::grpc::CoordinatorState;
use handicap_controller::store;
use serde_json::Value;
use tower::ServiceExt;

fn make_app(db: store::Db) -> axum::Router {
    let coord = CoordinatorState::new(db.clone());
    app::router(AppState {
        db,
        coord,
        dispatcher: Arc::new(SubprocessDispatcher::new(
            "/nonexistent".to_string(),
            "127.0.0.1:0".parse().unwrap(),
        )),
        ui_dir: None,
    })
}

/// multipart/form-data 본문 + content-type 헤더값 생성.
/// fields: (name, filename(Option), bytes). filename 있으면 파일 파트.
fn multipart(fields: &[(&str, Option<&str>, &[u8])]) -> (String, Vec<u8>) {
    let boundary = "X-HANDICAP-BOUNDARY-8b";
    let mut body = Vec::new();
    for (name, filename, data) in fields {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        match filename {
            Some(fname) => body.extend_from_slice(
                format!(
                    "Content-Disposition: form-data; name=\"{name}\"; filename=\"{fname}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
                )
                .as_bytes(),
            ),
            None => body.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
            ),
        }
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

async fn body_json(resp: axum::response::Response) -> (StatusCode, Value) {
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, v)
}

#[tokio::test]
async fn dataset_upload_list_get_delete_flow() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());

    // 1) 업로드(save)
    let (ct, body) = multipart(&[("file", Some("users.csv"), b"email,pw\na@ex.com,p1\nb@ex.com,p2\n")]);
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/datasets")
        .header("content-type", ct)
        .body(Body::from(body))
        .unwrap();
    let (status, v) = body_json(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK, "upload: {v:?}");
    let id = v["id"].as_str().unwrap().to_string();
    assert_eq!(v["name"], "users"); // 확장자 제거된 파일명 기본
    assert_eq!(v["columns"], serde_json::json!(["email", "pw"]));
    assert_eq!(v["row_count"], 2);
    assert_eq!(v["sample"][0]["email"], "a@ex.com");

    // 2) 목록
    let req = Request::builder().method(Method::GET).uri("/api/datasets").body(Body::empty()).unwrap();
    let (status, v) = body_json(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["datasets"].as_array().unwrap().len(), 1);

    // 3) get(메타 + 샘플)
    let req = Request::builder().method(Method::GET).uri(format!("/api/datasets/{id}")).body(Body::empty()).unwrap();
    let (status, v) = body_json(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["row_count"], 2);
    assert_eq!(v["sample"].as_array().unwrap().len(), 2);

    // 4) delete
    let req = Request::builder().method(Method::DELETE).uri(format!("/api/datasets/{id}")).body(Body::empty()).unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

    // 5) get → 404
    let req = Request::builder().method(Method::GET).uri(format!("/api/datasets/{id}")).body(Body::empty()).unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn dataset_preview_does_not_persist() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());

    let (ct, body) = multipart(&[("file", Some("x.csv"), b"a,b\n1,2\n")]);
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/datasets/preview")
        .header("content-type", ct)
        .body(Body::from(body))
        .unwrap();
    let (status, v) = body_json(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK, "preview: {v:?}");
    assert_eq!(v["columns"], serde_json::json!(["a", "b"]));
    assert!(v.get("id").is_none(), "preview는 저장 안 함 → id 없음");

    // 목록은 비어 있어야 함
    let req = Request::builder().method(Method::GET).uri("/api/datasets").body(Body::empty()).unwrap();
    let (_s, v) = body_json(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(v["datasets"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn dataset_upload_rejects_no_file() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let (ct, body) = multipart(&[("delimiter", None, b",")]); // 파일 파트 없음
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/datasets")
        .header("content-type", ct)
        .body(Body::from(body))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}
```

> 위 테스트는 `handicap_controller::{app, store, dispatcher, grpc}`의 공개 경로가 `api_test.rs`와 동일하다고 가정한다. 실제 import 경로가 다르면(`api_test.rs`를 열어 확인) 그에 맞춘다.

Run: `cargo test -p handicap-controller --test datasets_api_test`
Expected: 컴파일/실행 실패(라우트·핸들러 없음 → 404/405).

- [ ] **Step 2: 핸들러 구현**

`crates/controller/src/api/datasets.rs`:

```rust
use axum::Json;
use axum::extract::{Multipart, Path, State};
use axum::http::StatusCode;
use serde::Serialize;
use std::collections::BTreeMap;

use crate::app::AppState;
use crate::datasets::{ParseOptions, ParsedDataset, parse_upload};
use crate::error::ApiError;
use crate::store;

#[derive(Debug, Serialize)]
pub struct DatasetResponse {
    pub id: String,
    pub name: String,
    pub columns: Vec<String>,
    pub row_count: i64,
    pub byte_size: i64,
    pub created_at: i64,
    pub sample: Vec<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheets: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct PreviewResponse {
    pub columns: Vec<String>,
    pub row_count: i64,
    pub sample: Vec<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheets: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct DatasetListResponse {
    pub datasets: Vec<store::datasets::DatasetMeta>,
}

const SAMPLE_LIMIT: usize = 20;

/// multipart에서 파일 바이트 + 옵션 + 기본 이름(파일명에서 확장자 제거)을 추출.
struct Upload {
    file: Vec<u8>,
    name: String,
    opts: ParseOptions,
}

async fn read_multipart(mut mp: Multipart) -> Result<Upload, ApiError> {
    let mut file: Option<Vec<u8>> = None;
    let mut name: Option<String> = None;
    let mut opts = ParseOptions::default();

    while let Some(field) = mp.next_field().await.map_err(|e| ApiError::BadRequest(e.to_string()))? {
        let fname = field.name().map(str::to_string);
        match fname.as_deref() {
            Some("file") => {
                if let Some(filename) = field.file_name() {
                    name = Some(strip_ext(filename));
                }
                let data = field.bytes().await.map_err(|e| ApiError::BadRequest(e.to_string()))?;
                file = Some(data.to_vec());
            }
            Some("name") => {
                name = Some(field.text().await.map_err(|e| ApiError::BadRequest(e.to_string()))?);
            }
            Some("header") => {
                let v = field.text().await.map_err(|e| ApiError::BadRequest(e.to_string()))?;
                opts.has_header = Some(v == "true" || v == "1");
            }
            Some("delimiter") => {
                let v = field.text().await.map_err(|e| ApiError::BadRequest(e.to_string()))?;
                opts.delimiter = Some(parse_delimiter(&v));
            }
            Some("encoding") => {
                opts.encoding = Some(field.text().await.map_err(|e| ApiError::BadRequest(e.to_string()))?);
            }
            Some("sheet") => {
                opts.sheet = Some(field.text().await.map_err(|e| ApiError::BadRequest(e.to_string()))?);
            }
            _ => { let _ = field.bytes().await; } // 알 수 없는 필드는 소비하고 무시
        }
    }

    let file = file.ok_or_else(|| ApiError::BadRequest("file 파트가 필요합니다".into()))?;
    Ok(Upload { file, name: name.unwrap_or_else(|| "dataset".into()), opts })
}

fn strip_ext(filename: &str) -> String {
    match filename.rsplit_once('.') {
        Some((stem, _ext)) if !stem.is_empty() => stem.to_string(),
        _ => filename.to_string(),
    }
}

/// "," / ";" / "\t" / 리터럴 탭 → 단일 바이트.
fn parse_delimiter(v: &str) -> u8 {
    match v {
        "\\t" | "tab" | "\t" => b'\t',
        s => s.as_bytes().first().copied().unwrap_or(b','),
    }
}

fn sample_objects(parsed: &ParsedDataset, limit: usize) -> Vec<BTreeMap<String, String>> {
    parsed
        .rows
        .iter()
        .take(limit)
        .map(|cells| {
            parsed
                .columns
                .iter()
                .enumerate()
                .map(|(i, col)| (col.clone(), cells.get(i).cloned().unwrap_or_default()))
                .collect()
        })
        .collect()
}

/// POST /api/datasets — 파싱 + 저장.
pub async fn upload(
    State(state): State<AppState>,
    mp: Multipart,
) -> Result<Json<DatasetResponse>, ApiError> {
    let Upload { file, name, opts } = read_multipart(mp).await?;
    let byte_size = file.len() as i64;
    let parsed = parse_upload(&file, &opts).map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let sample = sample_objects(&parsed, SAMPLE_LIMIT);

    let id = store::datasets::insert(&state.db, &name, &parsed.columns, &parsed.rows, byte_size).await?;
    let meta = store::datasets::get_meta(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("방금 저장한 데이터셋을 못 읽음")))?;

    Ok(Json(DatasetResponse {
        id: meta.id,
        name: meta.name,
        columns: meta.columns,
        row_count: meta.row_count,
        byte_size: meta.byte_size,
        created_at: meta.created_at,
        sample,
        sheets: parsed.sheets,
    }))
}

/// POST /api/datasets/preview — 파싱만(저장 안 함).
pub async fn preview(_state: State<AppState>, mp: Multipart) -> Result<Json<PreviewResponse>, ApiError> {
    let Upload { file, opts, .. } = read_multipart(mp).await?;
    let parsed = parse_upload(&file, &opts).map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let sample = sample_objects(&parsed, SAMPLE_LIMIT);
    Ok(Json(PreviewResponse {
        columns: parsed.columns.clone(),
        row_count: parsed.rows.len() as i64,
        sample,
        sheets: parsed.sheets,
    }))
}

/// GET /api/datasets
pub async fn list(State(state): State<AppState>) -> Result<Json<DatasetListResponse>, ApiError> {
    let datasets = store::datasets::list(&state.db).await?;
    Ok(Json(DatasetListResponse { datasets }))
}

/// GET /api/datasets/{id}
pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<DatasetResponse>, ApiError> {
    let meta = store::datasets::get_meta(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    let sample = store::datasets::get_sample(&state.db, &id, SAMPLE_LIMIT as i64).await?;
    Ok(Json(DatasetResponse {
        id: meta.id,
        name: meta.name,
        columns: meta.columns,
        row_count: meta.row_count,
        byte_size: meta.byte_size,
        created_at: meta.created_at,
        sample,
        sheets: None,
    }))
}

/// DELETE /api/datasets/{id} — 8b는 무조건 삭제(참조 가드는 8c).
pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    store::datasets::delete(&state.db, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
```

`crates/controller/src/api/mod.rs`에 추가:

```rust
pub mod datasets;
```

- [ ] **Step 3: 라우트 등록**

`crates/controller/src/app.rs`의 `api` Router 빌더(스캐폴드 `.route("/runs/{id}/abort", ...)` 다음)에 추가. 파일 상단 `use` 에 `datasets as datasets_api` 별칭이 필요하면 기존 `scenarios as scenarios_api` 패턴을 따른다(예: `use crate::api::datasets as datasets_api;`):

```rust
        .route("/datasets", post(datasets_api::upload).get(datasets_api::list))
        .route("/datasets/preview", post(datasets_api::preview))
        .route("/datasets/{id}", get(datasets_api::get).delete(datasets_api::delete))
```

> `/datasets/preview`는 `/datasets/{id}` **위**(또는 axum 0.8 라우터는 정적 세그먼트를 동적보다 우선 매칭하므로 순서 무관하지만, 가독성 위해 preview를 먼저) 등록. `post`/`get`/`delete`는 이미 `use axum::routing::{get, post}` 되어 있을 것 — `delete`가 없으면 import에 추가.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo test -p handicap-controller --test datasets_api_test`
Expected: PASS (3 tests).

- [ ] **Step 5: 커밋**

```bash
git add crates/controller/src/api/datasets.rs crates/controller/src/api/mod.rs crates/controller/src/app.rs crates/controller/tests/datasets_api_test.rs
git commit -m "feat(controller): /api/datasets upload/preview/list/get/delete (8b)"
```

---

## Task 4: UI — Dataset 스키마 + API 클라이언트 + 훅

**Files:**
- Modify: `ui/src/api/schemas.ts`
- Modify: `ui/src/api/client.ts`
- Modify: `ui/src/api/hooks.ts`
- Create: `ui/src/api/__tests__/datasets.test.ts`

- [ ] **Step 1: 실패하는 클라이언트 단위 테스트 작성**

`ui/src/api/__tests__/datasets.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { api } from "../client";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("datasets api", () => {
  it("listDatasets parses the list response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ datasets: [{ id: "01J", name: "u", columns: ["a"], row_count: 1, byte_size: 9, created_at: 1 }] }),
    );
    const out = await api.listDatasets();
    expect(out.datasets[0].id).toBe("01J");
    expect(fetchMock).toHaveBeenCalledWith("/api/datasets", expect.objectContaining({ method: "GET" }));
  });

  it("uploadDataset posts FormData and omits the JSON content-type", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "01J", name: "u", columns: ["a"], row_count: 1, byte_size: 9, created_at: 1, sample: [{ a: "x" }] }),
    );
    const file = new File(["a\nx\n"], "u.csv", { type: "text/csv" });
    const out = await api.uploadDataset(file, { delimiter: "," });
    expect(out.id).toBe("01J");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    // content-type을 우리가 강제하면 boundary가 깨진다 → 없어야 함
    const headers = new Headers(init.headers ?? {});
    expect(headers.has("content-type")).toBe(false);
    const fd = init.body as FormData;
    expect(fd.get("file")).toBeInstanceOf(File);
    expect(fd.get("delimiter")).toBe(",");
  });

  it("deleteDataset issues DELETE", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.deleteDataset("01J");
    expect(fetchMock).toHaveBeenCalledWith("/api/datasets/01J", expect.objectContaining({ method: "DELETE" }));
  });
});
```

Run: `cd ui && pnpm vitest run src/api/__tests__/datasets.test.ts`
Expected: FAIL(`api.listDatasets` 등 미정의).

- [ ] **Step 2: Zod 스키마 추가**

`ui/src/api/schemas.ts`에 추가(기존 `ScenarioSchema` 패턴):

```ts
export const DatasetMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  columns: z.array(z.string()),
  row_count: z.number().int(),
  byte_size: z.number().int(),
  created_at: z.number().int(),
});
export type DatasetMeta = z.infer<typeof DatasetMetaSchema>;

// upload/get 응답: 메타 + sample(+ xlsx면 sheets)
export const DatasetSchema = DatasetMetaSchema.extend({
  sample: z.array(z.record(z.string(), z.string())),
  sheets: z.array(z.string()).optional(),
});
export type Dataset = z.infer<typeof DatasetSchema>;

export const DatasetListSchema = z.object({ datasets: z.array(DatasetMetaSchema) });

// preview 응답: 저장 안 됨 → id/메타 없음
export const DatasetPreviewSchema = z.object({
  columns: z.array(z.string()),
  row_count: z.number().int(),
  sample: z.array(z.record(z.string(), z.string())),
  sheets: z.array(z.string()).optional(),
});
export type DatasetPreview = z.infer<typeof DatasetPreviewSchema>;
```

- [ ] **Step 3: API 클라이언트 함수 추가 (multipart 경로 포함)**

`ui/src/api/client.ts`. 먼저 multipart 전용 fetch 헬퍼(기존 `request`는 `content-type: application/json`을 강제하므로 FormData엔 못 쓴다). 파일 상단의 `request` 정의 근처에 추가:

```ts
import {
  DatasetListSchema,
  DatasetSchema,
  DatasetPreviewSchema,
  type Dataset,
  type DatasetPreview,
} from "./schemas";
import type { ZodType } from "zod";

// FormData 업로드용: content-type을 설정하지 않는다(브라우저가 boundary 포함해 자동 설정).
async function requestMultipart<T>(path: string, fd: FormData, schema: ZodType<T>): Promise<T> {
  const res = await fetch(`/api${path}`, { method: "POST", body: fd }); // headers 미지정 = JSON 강제 안 함
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const body = await res.json();
      msg = (body as { error?: string }).error ?? msg;
    } catch {
      /* non-JSON */
    }
    throw new Error(msg);
  }
  return schema.parse(await res.json());
}

export type DatasetUploadOptions = {
  name?: string;
  header?: boolean;
  delimiter?: string;
  encoding?: string;
  sheet?: string;
};

function buildDatasetForm(file: File, opts?: DatasetUploadOptions): FormData {
  const fd = new FormData();
  fd.append("file", file);
  if (opts?.name) fd.append("name", opts.name);
  if (opts?.header !== undefined) fd.append("header", String(opts.header));
  if (opts?.delimiter) fd.append("delimiter", opts.delimiter);
  if (opts?.encoding) fd.append("encoding", opts.encoding);
  if (opts?.sheet) fd.append("sheet", opts.sheet);
  return fd;
}
```

그리고 `api` 객체(기존 `listScenarios`/`createScenario` 등이 있는 객체)에 추가:

```ts
  listDatasets: () => request("/datasets", { method: "GET" }, DatasetListSchema),
  getDataset: (id: string) => request(`/datasets/${id}`, { method: "GET" }, DatasetSchema),
  uploadDataset: (file: File, opts?: DatasetUploadOptions): Promise<Dataset> =>
    requestMultipart("/datasets", buildDatasetForm(file, opts), DatasetSchema),
  previewDataset: (file: File, opts?: DatasetUploadOptions): Promise<DatasetPreview> =>
    requestMultipart("/datasets/preview", buildDatasetForm(file, opts), DatasetPreviewSchema),
  deleteDataset: (id: string) => request(`/datasets/${id}`, { method: "DELETE" }, undefined),
```

> `request(..., undefined)`로 DELETE(204, 본문 없음)를 다루려면 기존 `request`가 `schema?: ZodType` 옵셔널을 받아 schema 없으면 파싱을 건너뛰도록 되어 있어야 한다. `client.ts`의 `request` 시그니처를 확인해, schema가 옵셔널이 아니면 `request<void>`가 204를 처리하도록 작은 분기(`if (!schema) return undefined as T;` + 204 시 `res.json()` 호출 안 함)를 추가한다. (기존에 DELETE가 없었으므로 이 분기가 신규다.)

- [ ] **Step 4: React Query 훅 추가**

`ui/src/api/hooks.ts`. `queryKeys`에 추가:

```ts
  datasets: () => ["datasets"] as const,
  dataset: (id: string) => ["datasets", id] as const,
```

그리고 훅:

```ts
export function useDatasets() {
  return useQuery({ queryKey: queryKeys.datasets(), queryFn: api.listDatasets });
}

export function useUploadDataset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, opts }: { file: File; opts?: import("./client").DatasetUploadOptions }) =>
      api.uploadDataset(file, opts),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.datasets() }),
  });
}

export function useDeleteDataset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteDataset(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.datasets() }),
  });
}
```

(preview는 mutation이 아니라 컴포넌트에서 직접 `api.previewDataset` 호출 — Task 6에서 사용.)

- [ ] **Step 5: 테스트 통과 + 빌드 게이트**

Run:
```bash
cd ui && pnpm vitest run src/api/__tests__/datasets.test.ts
pnpm build   # tsc -b && vite build — strict 타입 게이트
```
Expected: 테스트 PASS, 빌드 성공.

- [ ] **Step 6: 커밋**

```bash
git add ui/src/api/schemas.ts ui/src/api/client.ts ui/src/api/hooks.ts ui/src/api/__tests__/datasets.test.ts
git commit -m "feat(ui): dataset api client + schemas + react-query hooks (8b)"
```

---

## Task 5: UI — DatasetsPage(목록 + 삭제) + 라우트 + nav

**Files:**
- Modify: `ui/src/routes.tsx`
- Modify: `ui/src/components/Layout.tsx`
- Create: `ui/src/pages/DatasetsPage.tsx`
- Create: `ui/src/pages/__tests__/DatasetsPage.test.tsx`

- [ ] **Step 1: 실패하는 RTL 테스트 작성**

`ui/src/pages/__tests__/DatasetsPage.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { DatasetsPage } from "../DatasetsPage";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DatasetsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("DatasetsPage", () => {
  it("lists datasets", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ datasets: [{ id: "01J", name: "users", columns: ["email", "pw"], row_count: 2, byte_size: 30, created_at: 1 }] }),
    );
    renderPage();
    expect(await screen.findByText("users")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // row_count
  });

  it("shows empty state", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ datasets: [] }));
    renderPage();
    expect(await screen.findByText(/No datasets yet/i)).toBeInTheDocument();
  });

  it("deletes a dataset", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ datasets: [{ id: "01J", name: "users", columns: ["email"], row_count: 1, byte_size: 9, created_at: 1 }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // delete
      .mockResolvedValueOnce(jsonResponse({ datasets: [] })); // refetch
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("users");
    await user.click(screen.getByRole("button", { name: /delete/i }));
    await waitFor(() => expect(screen.getByText(/No datasets yet/i)).toBeInTheDocument());
  });
});
```

Run: `cd ui && pnpm vitest run src/pages/__tests__/DatasetsPage.test.tsx`
Expected: FAIL(`DatasetsPage` 미정의).

- [ ] **Step 2: DatasetsPage 구현 (목록 + 삭제 + 업로드 패널 마운트)**

`ui/src/pages/DatasetsPage.tsx`(`ScenarioListPage` 레이아웃 패턴 차용):

```tsx
import { useDatasets, useDeleteDataset } from "../api/hooks";
import { Button } from "../components/Button";
import { UploadPanel } from "../components/datasets/UploadPanel";

export function DatasetsPage() {
  const { data, isLoading, error } = useDatasets();
  const del = useDeleteDataset();

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold">Datasets</h2>
      </div>

      <UploadPanel />

      <section aria-label="dataset list" className="mt-8">
        {isLoading && <p className="text-slate-500">Loading…</p>}
        {error && <p className="text-red-600">Failed to load: {(error as Error).message}</p>}
        {data && data.datasets.length === 0 && <p className="text-slate-500">No datasets yet.</p>}
        {data && data.datasets.length > 0 && (
          <table className="min-w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-600">
              <tr>
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Columns</th>
                <th className="py-2 pr-4">Rows</th>
                <th className="py-2 pr-4"></th>
              </tr>
            </thead>
            <tbody>
              {data.datasets.map((d) => (
                <tr key={d.id} className="border-b border-slate-100">
                  <td className="py-2 pr-4 font-medium">{d.name}</td>
                  <td className="py-2 pr-4 text-slate-600">{d.columns.join(", ")}</td>
                  <td className="py-2 pr-4">{d.row_count}</td>
                  <td className="py-2 pr-4">
                    <Button
                      variant="danger"
                      onClick={() => del.mutate(d.id)}
                      disabled={del.isPending}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
```

> `Button`의 정확한 props(variant/onClick/disabled)는 `ui/src/components/Button.tsx`에서 확인. variant가 `"danger"`가 아니면 그 컴포넌트의 실제 위험 변형 이름을 쓴다.

- [ ] **Step 3: 라우트 + nav 등록**

`ui/src/routes.tsx`의 `children` 배열에 추가 + import:

```tsx
import { DatasetsPage } from "./pages/DatasetsPage";
// children 안에:
      { path: "datasets", element: <DatasetsPage /> },
```

`ui/src/components/Layout.tsx`의 `<nav>`에 링크 추가(기존 한 줄짜리 nav면 `flex gap-4`로 감싸 두 링크 정렬):

```tsx
<nav className="flex gap-4 text-sm text-slate-600">
  <Link to="/" className="hover:text-slate-900">Scenarios</Link>
  <Link to="/datasets" className="hover:text-slate-900">Datasets</Link>
</nav>
```

- [ ] **Step 4: 테스트 통과 (UploadPanel 스텁 필요)**

`DatasetsPage`가 `UploadPanel`을 import하므로, Task 6 전에 컴파일되도록 **임시 스텁**을 먼저 만든다(Task 6에서 본구현으로 대체):

`ui/src/components/datasets/UploadPanel.tsx`(스텁):
```tsx
export function UploadPanel() {
  return <section aria-label="upload dataset" />;
}
```

Run:
```bash
cd ui && pnpm vitest run src/pages/__tests__/DatasetsPage.test.tsx
pnpm build
```
Expected: 테스트 PASS(3), 빌드 성공.

- [ ] **Step 5: 커밋**

```bash
git add ui/src/routes.tsx ui/src/components/Layout.tsx ui/src/pages/DatasetsPage.tsx ui/src/pages/__tests__/DatasetsPage.test.tsx ui/src/components/datasets/UploadPanel.tsx
git commit -m "feat(ui): Datasets page (list + delete) + route + nav (8b)"
```

---

## Task 6: UI — UploadPanel(드래그드롭/파일선택 + override + 미리보기 + 저장)

**Files:**
- Modify: `ui/src/components/datasets/UploadPanel.tsx` (스텁 → 본구현)
- Create: `ui/src/components/datasets/__tests__/UploadPanel.test.tsx`

- [ ] **Step 1: 실패하는 RTL 테스트 작성**

`ui/src/components/datasets/__tests__/UploadPanel.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UploadPanel } from "../UploadPanel";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <UploadPanel />
    </QueryClientProvider>,
  );
}

describe("UploadPanel", () => {
  it("previews a chosen file (columns + sample)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ columns: ["email", "pw"], row_count: 2, sample: [{ email: "a@ex.com", pw: "p1" }] }),
    );
    const user = userEvent.setup();
    renderPanel();
    const file = new File(["email,pw\na@ex.com,p1\n"], "users.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText(/choose file/i), file);

    expect(await screen.findByText("email")).toBeInTheDocument();
    expect(screen.getByText("a@ex.com")).toBeInTheDocument();
    // preview 엔드포인트로 갔는지
    expect(fetchMock.mock.calls[0][0]).toBe("/api/datasets/preview");
  });

  it("saves after preview", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ columns: ["a"], row_count: 1, sample: [{ a: "x" }] })) // preview
      .mockResolvedValueOnce(
        jsonResponse({ id: "01J", name: "users", columns: ["a"], row_count: 1, byte_size: 5, created_at: 1, sample: [{ a: "x" }] }),
      ); // save
    const user = userEvent.setup();
    renderPanel();
    await user.upload(screen.getByLabelText(/choose file/i), new File(["a\nx\n"], "users.csv", { type: "text/csv" }));
    await screen.findByText("a");
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(fetchMock.mock.calls[1][0]).toBe("/api/datasets"));
  });

  it("re-previews when delimiter override changes", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ columns: ["a;b"], row_count: 1, sample: [{ "a;b": "1;2" }] })) // 쉼표로 오파싱
      .mockResolvedValueOnce(jsonResponse({ columns: ["a", "b"], row_count: 1, sample: [{ a: "1", b: "2" }] })); // 세미콜론 재파싱
    const user = userEvent.setup();
    renderPanel();
    await user.upload(screen.getByLabelText(/choose file/i), new File(["a;b\n1;2\n"], "x.csv", { type: "text/csv" }));
    await screen.findByText("a;b");
    await user.selectOptions(screen.getByLabelText(/delimiter/i), ";");
    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
    expect(fetchMock.mock.calls[1][0]).toBe("/api/datasets/preview");
  });
});
```

Run: `cd ui && pnpm vitest run src/components/datasets/__tests__/UploadPanel.test.tsx`
Expected: FAIL(스텁이라 입력/미리보기 없음).

- [ ] **Step 2: UploadPanel 본구현**

`ui/src/components/datasets/UploadPanel.tsx`(스텁 전체 교체):

```tsx
import { useRef, useState } from "react";
import { api, type DatasetUploadOptions } from "../../api/client";
import type { DatasetPreview } from "../../api/schemas";
import { useUploadDataset } from "../../api/hooks";
import { Button } from "../Button";

type Options = {
  header: boolean;
  delimiter: string; // "" = auto
  encoding: string; // "" = auto
  sheet: string; // "" = first
};

function toUploadOptions(o: Options): DatasetUploadOptions {
  return {
    header: o.header,
    delimiter: o.delimiter || undefined,
    encoding: o.encoding || undefined,
    sheet: o.sheet || undefined,
  };
}

export function UploadPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [opts, setOpts] = useState<Options>({ header: true, delimiter: "", encoding: "", sheet: "" });
  const [preview, setPreview] = useState<DatasetPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadDataset();

  async function runPreview(f: File, o: Options) {
    setBusy(true);
    setError(null);
    try {
      const p = await api.previewDataset(f, toUploadOptions(o));
      setPreview(p);
    } catch (e) {
      setError((e as Error).message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  function onPick(f: File | null) {
    setFile(f);
    setPreview(null);
    if (f) {
      if (!name) setName(f.name.replace(/\.[^.]+$/, ""));
      void runPreview(f, opts);
    }
  }

  function changeOpt(patch: Partial<Options>) {
    const next = { ...opts, ...patch };
    setOpts(next);
    if (file) void runPreview(file, next);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0] ?? null;
    onPick(f);
  }

  async function save() {
    if (!file) return;
    await upload.mutateAsync({ file, opts: { ...toUploadOptions(opts), name: name || undefined } });
    // 성공: 리셋
    setFile(null);
    setPreview(null);
    setName("");
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <section aria-label="upload dataset" className="border border-slate-200 rounded-md p-4">
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="border-2 border-dashed border-slate-300 rounded-md p-6 text-center text-sm text-slate-500"
      >
        <p className="mb-2">CSV/XLSX 파일을 끌어다 놓거나</p>
        <label className="inline-block">
          <span className="sr-only">choose file</span>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            aria-label="choose file"
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
            className="block text-sm"
          />
        </label>
      </div>

      {file && (
        <div className="mt-4 flex flex-wrap gap-3 items-end">
          <label className="block text-sm">
            <span className="text-slate-600">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 block w-48 rounded border border-slate-300 px-2 py-1"
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">Header</span>
            <select
              aria-label="header"
              value={opts.header ? "true" : "false"}
              onChange={(e) => changeOpt({ header: e.target.value === "true" })}
              className="mt-1 block border border-slate-300 rounded px-2 py-1"
            >
              <option value="true">첫 행 = 헤더</option>
              <option value="false">헤더 없음</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">Delimiter</span>
            <select
              aria-label="delimiter"
              value={opts.delimiter}
              onChange={(e) => changeOpt({ delimiter: e.target.value })}
              className="mt-1 block border border-slate-300 rounded px-2 py-1"
            >
              <option value="">auto</option>
              <option value=",">, (comma)</option>
              <option value=";">; (semicolon)</option>
              <option value="\t">tab</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">Encoding</span>
            <select
              aria-label="encoding"
              value={opts.encoding}
              onChange={(e) => changeOpt({ encoding: e.target.value })}
              className="mt-1 block border border-slate-300 rounded px-2 py-1"
            >
              <option value="">auto</option>
              <option value="utf-8">UTF-8</option>
              <option value="cp949">CP949 (EUC-KR)</option>
            </select>
          </label>
          {preview?.sheets && preview.sheets.length > 1 && (
            <label className="block text-sm">
              <span className="text-slate-600">Sheet</span>
              <select
                aria-label="sheet"
                value={opts.sheet}
                onChange={(e) => changeOpt({ sheet: e.target.value })}
                className="mt-1 block border border-slate-300 rounded px-2 py-1"
              >
                {preview.sheets.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {busy && <p role="status" className="mt-3 text-sm text-slate-500">Parsing…</p>}
      {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}

      {preview && (
        <div className="mt-4">
          <p className="text-sm text-slate-600 mb-2">
            {preview.columns.length} columns · {preview.row_count} rows (showing {preview.sample.length})
          </p>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm border border-slate-200">
              <thead className="bg-slate-50 text-left">
                <tr>
                  {preview.columns.map((c) => (
                    <th key={c} className="px-2 py-1 border-b border-slate-200 font-medium">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.sample.map((row, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    {preview.columns.map((c) => (
                      <td key={c} className="px-2 py-1">{row[c] ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3">
            <Button onClick={save} disabled={upload.isPending}>Save dataset</Button>
            {upload.error && <span role="alert" className="ml-3 text-sm text-red-600">{(upload.error as Error).message}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
```

> 함정(CLAUDE.md Slice 7-1 flex): override 줄은 `flex flex-wrap gap-3`라 입력이 밀리지 않지만, 만약 단일 행 `flex`로 바꾸면 입력에 `min-w-0`을 줘야 한다. 미리보기 표는 `overflow-x-auto`로 감싸 넓은 컬럼이 페이지를 안 밀게 한다.
> 함정(delimiter 탭): `<option value="\t">`의 값은 JSX에서 리터럴 백슬래시-t 두 글자가 아니라 실제 탭이 되도록 — 위처럼 `"\t"` 문자열 리터럴이면 실제 탭 문자다. 백엔드 `parse_delimiter`는 실제 탭(`\t`)과 `"\\t"`/`"tab"` 모두 받으므로 안전.

- [ ] **Step 3: 테스트 통과 + 빌드**

Run:
```bash
cd ui && pnpm vitest run src/components/datasets/__tests__/UploadPanel.test.tsx
pnpm build
```
Expected: 테스트 PASS(3), 빌드 성공.

- [ ] **Step 4: UI 전체 테스트 회귀 확인**

Run: `cd ui && pnpm test`
Expected: 전체 PASS(기존 + 신규).

- [ ] **Step 5: 커밋**

```bash
git add ui/src/components/datasets/UploadPanel.tsx ui/src/components/datasets/__tests__/UploadPanel.test.tsx
git commit -m "feat(ui): dataset upload panel — dropzone, override, preview, save (8b)"
```

---

## Task 7: ADR-0022 + CLAUDE.md + 전체 게이트

**Files:**
- Create: `docs/adr/0022-data-driven-datasets.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: ADR-0022 작성**

`docs/adr/0022-data-driven-datasets.md`(MADR 포맷, 기존 ADR 파일의 헤더 구조 따라):

```markdown
# 0022 — Data-driven 데이터셋 (독립 리소스 + 서버 파싱)

- 상태: 채택
- 날짜: 2026-05-30
- 맥락: Slice 8(data-driven). 8b에서 리소스+파싱이 출하됨. 바인딩/주입은 8c.

## 결정

데이터셋을 **독립 DB 리소스**(`datasets`/`dataset_rows`, migration 0004)로 모델링하고, run config(`profile_json`)가 `dataset_id`+매핑+정책을 참조한다(8c). 파싱은 **Rust 서버**(`csv`+`calamine`+`encoding_rs`)에서 수행한다.

- mapping-agnostic / policy-aware worker, 정책 인지 슬라이싱, 3 정책(per_vu 기본/iter_sequential/iter_random), 워커 로딩 단계 — **8c**.
- 행은 `{"col":"value"}` JSON으로 저장(컬럼 이질성·매핑 적용 용이). 컬럼 순서는 `columns_json`.

## 대안 (거절)

- scenario YAML inline(ADR-0013 위반) / run-only ephemeral(재사용 불가) / 브라우저 SheetJS 파싱(오프라인 번들·파서 불일치·대용량 약함) / 항상 전체 스트리밍(per-VU 낭비) / 워커 lazy fetch(hot-path 왕복).

## 연기

`unique` 정책 / 민감정보 마스킹 / JSON 숫자·타입 주입 / 멀티워커 전역 커서 / 데이터셋 버전·diff·편집. (spec §12)

## 결과

- 8b: 데이터셋 생성·조회·삭제. runs 테이블 무변경(바인딩은 `profile_json` 새 필드, 8c).
- DELETE는 8b에서 무조건; non-terminal run 참조 시 409 가드는 8c(`data_binding` 도입 시).
```

- [ ] **Step 2: CLAUDE.md 갱신**

(a) 맨 위 상태 줄 근처에 8b 결과 한 줄 추가(8a 줄 다음). (b) "알아둘 결정들" 목록에 추가:

```markdown
- **0022** Data-driven 데이터셋: 독립 리소스 + 서버 파싱(8b), 바인딩/주입(8c)
```

(c) 파일 맨 끝에 새 섹션 추가:

```markdown

## Slice 8b에서 배운 함정들

- **axum `multipart`는 별도 feature**: 워크스페이스 `axum` 줄에 `"multipart"`를 넣어야 `axum::extract::Multipart`를 쓸 수 있다. per-crate `features` 가산 병합이 안 되므로 워크스페이스 dependency 줄을 고쳐야 한다(controller만 `axum = { workspace = true, features = [...] }`로 재선언해도 됨).
- **multipart 업로드 클라이언트는 content-type을 직접 설정하면 안 된다**: `ui/src/api/client.ts`의 `request`는 `content-type: application/json`을 강제한다 → FormData엔 못 쓴다. 별도 `requestMultipart`(헤더 미지정)로 브라우저가 `multipart/form-data; boundary=...`를 자동 설정하게 한다. oneshot 테스트에선 boundary를 박은 본문을 손수 만든다(`datasets_api_test.rs::multipart`).
- **calamine API는 마이너 버전마다 시그니처가 바뀐다**: `worksheet_range`가 `Result` vs `Option<Result>`, 셀 타입이 `Data` vs `DataType`. 새로 핀할 때 `cargo doc -p calamine`로 확인하고 `parse_xlsx`의 `?`/import만 조정. 로직은 불변.
- **dataset_rows cascade는 앱 레벨**: SQLite FK cascade 대신 `DELETE FROM dataset_rows WHERE dataset_id=?`를 트랜잭션으로 먼저 실행. migration은 `CREATE TABLE IF NOT EXISTS`라 멱등(Slice 6/7-1 패턴, ALTER 회피).
- **§5↔§9 조정으로 preview 엔드포인트 추가**: `POST /api/datasets`(파싱+저장)와 별개로 `POST /api/datasets/preview`(파싱만, 저장 안 함)를 둬서 "저장 전 미리보기 + override 즉시 재파싱" UX를 구현. 둘 다 같은 `parse_upload` 호출.
```

- [ ] **Step 3: 전체 워크스페이스 게이트 + UI 빌드**

Run:
```bash
just build && just lint && just test
cd ui && pnpm build && pnpm test && cd ..
```
Expected: 전부 PASS. (참고 함정: `full_slice_1_e2e`가 cold build에서 signal-9로 드물게 깨지면 환경 플레이크 — 같은 명령 재실행. `--no-verify` 금지.)

- [ ] **Step 4: 커밋**

```bash
git add docs/adr/0022-data-driven-datasets.md CLAUDE.md
git commit -m "docs: ADR-0022 data-driven datasets + CLAUDE.md 8b notes"
```

---

## Self-Review (작성자 체크 결과)

- **Spec 커버리지**:
  - §2 독립 리소스/서버 파싱 → Task 1(store)·Task 2(parse)·ADR(Task 7). ✓
  - §3 데이터 모델/migration 0004 → Task 1 (`CREATE TABLE IF NOT EXISTS`, row_json, PK(dataset_id,idx), 앱레벨 cascade). ✓
  - §5 API(POST multipart/GET 목록/GET 단건+샘플20/DELETE, axum multipart feature, `{id}`) → Task 0(feature)·Task 3. preview 추가는 §9 충족 위해 명시 결정. DELETE 409는 8c로 연기(근거 기재). ✓
  - §6 파싱(CSV `,`/`;`/`\t`, CP949, BOM, XLSX 단일/다중시트, 빈 셀, 헤더 없음, 중복 컬럼명; 단위 8+) → Task 2의 11개 테스트. ✓
  - §9-8b Datasets 페이지(목록·드래그드롭·미리보기·override·재파싱) → Task 5(목록/삭제)·Task 6(업로드/미리보기/override). ✓
  - §11 업로드 관대(빈/대용량 허용), 삭제 후 과거 run 무영향(8b엔 run 없음) → Task 3(상한 없음). 단일 검증 게이트(run-create)는 8c. ✓
  - §13-8b 완료기준(파싱 단위 8+/CRUD+multipart/페이지 RTL/`pnpm build`/CRUD e2e) → Task 2/3/5/6 + Task 3의 full-flow oneshot 테스트가 "생성·조회·삭제 e2e" 역할. ✓
  - §14 deps(csv/calamine/encoding_rs+multipart, 버전 핀, MSRV/edition, calamine 트리/이미지) → Task 0. ✓
  - §15 ADR-0022 → Task 7. ✓
- **Placeholder 스캔**: 모든 코드 스텝에 실제 코드·명령·기대 출력. "TBD/TODO" 없음. calamine 버전 시그니처 조정은 placeholder가 아니라 명시된 검증 단계(버전 의존 실제 작업). ✓
- **타입 일관성**: `parse_upload(&[u8], &ParseOptions) -> Result<ParsedDataset, ParseError>`, `ParsedDataset{columns,rows,sheets}`. store `insert(db,name,&[String],&[Vec<String>],i64)->String`/`DatasetMeta`/`get_sample->Vec<BTreeMap>`. API `DatasetResponse`/`PreviewResponse`/`DatasetListResponse`. UI `DatasetSchema`(메타+sample+sheets?)/`DatasetPreviewSchema`/`DatasetMetaSchema`(목록). `api.{listDatasets,getDataset,uploadDataset,previewDataset,deleteDataset}` ↔ 훅 `useDatasets/useUploadDataset/useDeleteDataset`. 이름 일치 확인. ✓
- **검증 가정**: 테스트의 `handicap_controller::{app,store,dispatcher,grpc}` 공개 경로와 `Button`/`request` 시그니처는 실제 파일로 확인 후 맞출 것(스텁 단계에서 컴파일 에러로 즉시 드러남). ✓
- **8b 독립 출하성**: 워커·엔진·proto 무변경 → 8b만 머지해도 데이터셋 관리 기능이 동작(주입은 8c). ✓

---
name: new-migration
description: Scaffold the next handicap controller SQLite migration with the correct number and idempotency pattern. Use when adding a DB migration to crates/controller/src/store — a new table, or a new column to an existing table — so numbering and the guard pattern follow the store's conventions and avoid the documented renumber/auto-merge footguns. Invoke via /new-migration <short_name> or when implementation work needs a schema change.
---

# new-migration — handicap 컨트롤러 SQLite 마이그레이션 스캐폴드

마이그레이션은 `crates/controller/src/store/mod.rs::connect()`가 **순서대로** 실행한다. 두 형태가 섞여 있다:
- **`.sql` 파일** (`const MIGRATION_SQL_NNNN = include_str!(…)` + `sqlx::query(…).execute(&pool)`) — `CREATE TABLE IF NOT EXISTS`처럼 **멱등한** DDL.
- **Rust-guarded `ensure_*` 함수** — SQLite `ALTER TABLE ADD COLUMN`은 비멱등이라 `pragma_table_info` 가드가 필요한 경우. `.sql` 번호 시퀀스에 **구멍**으로 나타난다(0008/0009/0012/0014).

## 0) 먼저: 정말 마이그레이션이 필요한가?

대부분의 "필드 추가"는 마이그레이션이 **필요 없다**:
- **`profile_json` / `scenario` JSON 안의 새 필드** → `#[serde(default)]` 하나면 끝. 옛 행은 역직렬화 시 default로 채워진다 (`loop_breakdown_cap`·`data_binding`·`stages`·`vu_stages` 전부 이 길). **테이블 스키마 변경 0.**

`runs`/`scenarios`/메트릭 테이블의 **실제 컬럼/테이블**을 바꿀 때만 아래로.

## 1) 다음 번호 계산 — .sql과 Rust 가드 둘 다 스캔

```bash
last=$( { ls crates/controller/src/store/migrations/ | grep -oE '^[0-9]{4}'; \
          grep -oE 'migration [0-9]{4}' crates/controller/src/store/mod.rs | grep -oE '[0-9]{4}'; } \
        | sort -n | tail -1 )
# 10# 강제: 0008/0009는 octal로 해석되면 깨진다
printf 'next = %04d\n' $((10#$last + 1))
```

`.sql` 최고 번호만 보면 Rust-guarded 마이그레이션이 더 높을 때 충돌한다 — 항상 둘 다.

## 2) 패턴 선택

| 변경 | 멱등? | 패턴 |
|---|---|---|
| **새 테이블** (`CREATE TABLE IF NOT EXISTS`) | 예 | `.sql` 파일 (3a) |
| **새 인덱스** (`CREATE INDEX IF NOT EXISTS`) | 예 | `.sql` 파일 (3a) |
| **컬럼 추가** (`ALTER TABLE … ADD COLUMN`) | **아니오** | Rust `ensure_*` 가드 (3b) |
| **PK/제약 변경** (테이블 재빌드) | **아니오** | Rust `ensure_*` 가드 (3b, `ensure_run_metrics_worker_id` 참고) |

## 3a) `.sql` 경로 (새 테이블/인덱스)

1. `crates/controller/src/store/migrations/NNNN_<short_name>.sql` 생성 — `CREATE TABLE IF NOT EXISTS …`(멱등 필수). PK·FK·인덱스 포함.
2. `mod.rs`에 const 추가 (0015 줄 아래):
   ```rust
   const MIGRATION_SQL_NNNN: &str = include_str!("migrations/NNNN_<short_name>.sql");
   ```
3. `connect()` **끝**(마지막 execute/ensure 뒤)에 실행 라인 추가:
   ```rust
   sqlx::query(MIGRATION_SQL_NNNN).execute(&pool).await?; // migration NNNN: <설명>
   ```
4. **교차검증 (문서화된 auto-merge 함정)** — rebase/머지 때 const 충돌(`<<<<<<<`)은 보여도 동일 텍스트인 execute 라인은 조용히 합쳐져 누락된다. 모든 const가 `connect()`에서 실제로 실행되는지 확인:
   ```bash
   for n in $(grep -oE 'const MIGRATION_SQL_[0-9]+' crates/controller/src/store/mod.rs | grep -oE '[0-9]+'); do
     grep -q "sqlx::query(MIGRATION_SQL_$n)" crates/controller/src/store/mod.rs || echo "MISSING execute for MIGRATION_SQL_$n"
   done   # MISSING 줄이 0이어야 함
   ```
   (단순 `grep -c MIGRATION_SQL_`는 `#[cfg(test)]` 테스트가 기존 const를 재실행해 숫자가 어긋나니 쓰지 말 것 — 위 "const마다 execute 존재" 루프가 정확.) 누락하면 런타임 `no such table`. (이 repo는 9d·영역 B에서 두 번 겪음.)

## 3b) Rust 가드 경로 (ADD COLUMN / 테이블 재빌드)

`ensure_runs_dropped`(가장 단순한 ADD COLUMN 가드)를 템플릿으로 복제:

```rust
/// migration NNNN (Rust-guarded): <무엇을·왜>. SQLite ADD COLUMN은 비멱등이라 먼저 감지.
async fn ensure_<table>_<col>(db: &Db) -> anyhow::Result<()> {
    let has: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('<table>') WHERE name = '<col>'",
    )
    .fetch_one(db)
    .await?;
    if has == 0 {
        sqlx::query("ALTER TABLE <table> ADD COLUMN <col> <TYPE> NOT NULL DEFAULT <d>")
            .execute(db)
            .await?;
    }
    Ok(())
}
```

`connect()`의 올바른 순서 위치에 호출 추가:
```rust
ensure_<table>_<col>(&pool).await?; // migration NNNN (Rust-guarded; see fn)
```

**멱등 테스트 필수** (`mod.rs`의 `#[cfg(test)] mod tests`에 인라인 — 같은 가드를 두 번 호출해도 안 깨지는지). `ensure_runs_verdict_json_is_idempotent` / `ensure_run_group_metrics_branch_is_idempotent_and_backfills` 패턴.

> PK/제약을 바꾸려면 `ensure_run_metrics_worker_id`(새 테이블 → 복사 → DROP → RENAME, 단일 startup 트랜잭션, FK 안전성 주석)를 정확히 따를 것 — 이건 단순 ADD COLUMN보다 훨씬 미묘하다.

## 4) 마무리

- 새 컬럼을 read/write하는 쿼리 사이트(`runs.rs`/`metrics.rs` 등)도 같이 갱신. `RunRow` 등 `.get()` 사이트는 컴파일러가 안 잡으니 직접.
- 새 메트릭 테이블이면 proto `MetricBatch`에 필드 추가가 따라올 수 있다(prost exhaustive — `crates/controller/CLAUDE.md`의 그 함정).
- 이 repo 마이그레이션은 **forward-only**(백필 없음) — 옛 행은 default/sentinel로.
- 게이트: cargo-영향 변경이라 pre-commit이 전체 워크스페이스를 돈다. 커밋 전 `cargo build -p handicap-worker && cargo build --workspace`로 warm.
- 새 테이블/컬럼이 **아키텍처 결정**을 수반하면(설계 트레이드오프) ADR 추가 — 단순 스키마 추가는 ADR 불필요(루트 CLAUDE.md "알아둘 결정들" 규칙).

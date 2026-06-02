# A3b — 멀티 워커 fan-out: 메트릭 워커별 머지 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** N 개 워커가 같은 `(run_id, ts_second, step_id)` 윈도를 각자 내도 손실 없이 합치도록, `run_metrics` 를 **워커별 행 + 읽기 시점 HDR 머지** 로 전환한다 (A3a 의 keep-first 가 첫 워커 것만 남기고 나머지를 조용히 버리던 레이턴시 부정확을 해소).

**Architecture:** `run_metrics` PK 에 `worker_id` 를 추가(migration 0008, Rust-guarded 새 테이블+복사)해 워커별 윈도가 별도 행으로 공존한다. 쓰기 경로(`insert_batch`)는 워커별 keep-first 로 멱등성을 유지하고, 읽기 3 사이트(`summary` live, `windows_with_hdr`/`build_report` 리포트)가 `(ts_second, step_id)` 로 그룹핑하며 워커 HDR 를 `Histogram::add` 로 무손실 병합 + count SUM 한다. loop/if 메트릭은 이미 증분 델타 누적이라 **무변경**(워커별 disjoint 델타 합산이 정확).

**Tech Stack:** Rust, SQLite(sqlx 0.8), hdrhistogram(V2 BLOB), tonic/prost(gRPC), wiremock(e2e).

---

## 스코프 결정 / spec 대비 의도된 deviation (리뷰어 주목)

이 plan 은 spec(`2026-06-01-multi-worker-fanout-design.md`) §5 = "A3b — 메트릭 머지" **만** 구현한다. A3a(조정 인프라)는 머지 완료, A3c(K8s Indexed Job)는 후속.

1. **`WindowWithHdr` 에 `worker_id: String` 필드 추가** — spec §5.2 가 "`windows_with_hdr` 는 `(ts_second, step_id, worker_id)` 행을 반환"이라 명시. `build_report` 는 `(ts_second, step_id)` 로만 그룹핑하므로 worker_id 값 자체는 머지에 쓰지 않지만, ① SQL `ORDER BY ts,step,worker` 결정성 ② 단위테스트가 "두 워커 행"을 자기설명적으로 구성 ③ spec 와이어 1:1 — 위해 구조체에 노출한다.

2. **`build_report` 의 `windows` 배열은 이제 `(ts_second, step_id)` 당 1행** — A3a 까지 SQL 행당 1개씩 push 하던 것을, N 워커 행을 한 윈도로 collapse(count SUM·HDR merge·status_counts map merge)한다. `overall`/`per_step`/`per_step_count`/`status_dist`/`total_count`/`total_errors` 누적 로직은 **무변경**(모든 행을 가산하므로 N 워커여도 이미 정확) — 바뀌는 건 per-second 윈도 emit 뿐. N=1(단일워커)이면 윈도당 행이 1개라 byte-identical.

3. **`summary`(live `/metrics`) 출력 shape 무변경** — `WindowSummary{ts_second, step_id, count, error_count, status_counts}` 에 worker_id 를 **노출하지 않는다**(UI `MetricSummarySchema` 무변경). 내부적으로만 `(ts_second, step_id)` 로 merge.

4. **loop/if 메트릭(`run_loop_metrics`/`run_if_metrics`) 무변경** — spec §5.3. 이미 `count = count + excluded.count` 누적이고 워커별 disjoint 델타라 합산이 정확. worker_id 를 PK 에 넣지 않는다(run_metrics 와 정반대 전략, 둘 다 옳음). 이번 plan 은 이 두 테이블/`insert_loop_batch`/`insert_if_branch_batch` 를 건드리지 않는다.

5. **migration 0008 은 pure-SQL const 가 아니라 `connect()` 내 Rust 가드 함수**(`ensure_run_metrics_worker_id`) — SQLite 가 기존 테이블 PK 변경에 ALTER 를 못 쓰고, `run_metrics` 는 `CREATE TABLE IF NOT EXISTS`(0001)라 SQL const 재실행으로는 PK 가 안 바뀐다. 기존 `runs.message` 컬럼 가드(store/mod.rs:48-54)와 동형. 따라서 `MIGRATION_SQL_0008` 상수를 만들지 **않으며** `grep -c MIGRATION_SQL` 교차검증 대상이 아니다(컨트롤러 CLAUDE.md 의 "execute 라인 silently auto-merge" 함정은 이번엔 무관 — 새 const 가 없으니까).

6. **읽기 시점 SUM 의 안전 불변식: 한 run 은 sentinel-`''` 행과 named-`worker_id` 행을 절대 섞지 않는다.** 마이그레이션이 기존(pre-A3b) 행을 `''` 로 복사하지만, 그 run 들은 전부 `''`(과거 단일워커, 이미 종료). A3b 이후 생성되는 run 은 워커가 항상 non-empty `worker_id`(subprocess 는 distinct ULID, K8s 는 `{run_id}-w{index}`)를 stamp 하므로 전부 named. 같은 `(run_id, ts_second, step_id)` 가 `''` 와 `w-a` 두 행으로 동시에 존재하는 경로가 없으므로 `summary`/`build_report` 의 `(ts,step)` SUM 은 한 run 내에서 절대 중복 가산하지 않는다.

## 파일 구조 맵 (무엇을, 왜)

| 파일 | 변경 | 책임 |
|---|---|---|
| `crates/controller/src/store/mod.rs` | 수정 | `ensure_run_metrics_worker_id()` 가드 함수 추가 + `connect()` 가 0007 뒤에 호출. 멱등·기존행 보존 단위테스트. |
| `crates/controller/src/store/metrics.rs` | 수정 | `MetricRow.worker_id`/`WindowWithHdr.worker_id` 필드. `insert_batch` 4-컬럼 PK keep-first. `summary` (ts,step) merge. `windows_with_hdr` worker_id SELECT/ORDER. 단위테스트(워커별 keep-first, summary merge). |
| `crates/controller/src/report.rs` | 수정 | `build_report` 의 윈도 emit 을 (ts,step) 그룹 HDR-merge 로 재작성. 단위테스트(워커 윈도 머지, bound 무손실). 기존 테스트 fixture 에 worker_id. |
| `crates/controller/src/grpc/coordinator.rs` | 수정 | `ingest_metrics` 의 `MetricRow` literal 에 `worker_id: batch.worker_id.clone()`. |
| `crates/controller/tests/report_test.rs` | 수정 | seed 의 `MetricRow` literal 2곳에 `worker_id`. |
| `crates/controller/tests/multi_worker_fanout_e2e.rs` | 수정 | `two_worker_fanout_merges_metrics` e2e 추가(N=2 → report.count 무손실·HDR p50>0). |
| `crates/controller/CLAUDE.md` / `docs/adr/0027-*.md` / `docs/roadmap.md` / 루트 `CLAUDE.md` / 메모리 | 수정 | A3b 함정·결정·상태 갱신. |

**무변경 확인 대상**(리뷰어 체크): proto(`coordinator.proto` — `MetricBatch.worker_id=2` 는 A3a 가 이미 추가), worker(`main.rs` — 이미 `worker_id: worker_id.clone()` stamp, A3a), 엔진, UI, `run_loop_metrics`/`run_if_metrics`, `runs` 테이블.

---

## Task 1: migration 0008 — `run_metrics` PK 에 worker_id (Rust-guarded 새 테이블+복사)

**Files:**
- Modify: `crates/controller/src/store/mod.rs` (가드 함수 + `connect()` 배선 + 단위테스트)

`run_metrics`(0001) 는 PK `(run_id, ts_second, step_id)`. SQLite 는 기존 테이블 PK 변경에 ALTER 를 못 쓰므로 **새 테이블 생성 → 복사 → DROP → RENAME**. migration 은 매 `connect()` 마다 무조건 실행(버전 테이블 없음)이라 **worker_id 컬럼 존재 여부로 가드**해 멱등 + 기존 행 보존(sentinel `''`).

- [ ] **Step 1: 실패하는 테스트 작성** (`store/mod.rs` 의 `#[cfg(test)] mod tests` 에 추가)

```rust
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
        sqlx::query(MIGRATION_SQL_0001).execute(&pool).await.unwrap();

        // Seed scenario + run (FK: run_metrics.run_id REFERENCES runs(id)).
        sqlx::query(
            "INSERT INTO scenarios(id,name,yaml,created_at,updated_at,version) VALUES(?,?,?,?,?,?)",
        )
        .bind("S1").bind("n").bind("version: 1\nname: n\nsteps: []\n")
        .bind(1_i64).bind(1_i64).bind(1_i64)
        .execute(&pool).await.unwrap();
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
        .fetch_one(&pool).await.unwrap();
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
            .fetch_one(&pool).await.unwrap();
        assert_eq!(n, 1, "second call must not duplicate or drop rows");
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
        assert_eq!(has_col, 1, "connect() must apply migration 0008 (worker_id column)");
    }
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-controller --lib store::tests::run_metrics_worker_id_migration store::tests::connect_applies_run_metrics_worker_id -- --nocapture`
Expected: FAIL — `cannot find function ensure_run_metrics_worker_id in this scope` (둘 다 컴파일/실행 실패; `connect_applies...`는 가드 배선 전이라 worker_id 컬럼 없음).

- [ ] **Step 3: 가드 함수 구현** (`store/mod.rs`, `connect()` 위 또는 아래 모듈 레벨에 추가)

```rust
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
    sqlx::query("DROP TABLE run_metrics").execute(&mut *tx).await?;
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
```

- [ ] **Step 4: `connect()` 배선** — 0007 실행 뒤(현 `store/mod.rs:59` 직후)에 한 줄 추가:

```rust
    sqlx::query(MIGRATION_SQL_0007).execute(&pool).await?;
    ensure_run_metrics_worker_id(&pool).await?; // migration 0008 (Rust-guarded; see fn)
    Ok(pool)
```

- [ ] **Step 5: 테스트 통과 확인 + 전체 store 회귀**

Run: `cargo test -p handicap-controller --lib store::`
Expected: PASS — 새 테스트 + 기존 `opens_and_migrates_in_memory`/`foreign_keys_enforced`/metrics 테스트 전부 green.

- [ ] **Step 6: 커밋**

```bash
git add crates/controller/src/store/mod.rs
git commit -m "feat(controller): migration 0008 — run_metrics PK +worker_id (Rust-guarded rebuild) (A3b)"
```

---

## Task 2: `MetricRow.worker_id` + `insert_batch` 워커별 keep-first

**Files:**
- Modify: `crates/controller/src/store/metrics.rs` (struct 필드 + `insert_batch` + 단위테스트)
- Modify: `crates/controller/src/grpc/coordinator.rs` (`ingest_metrics` literal)
- Modify: `crates/controller/tests/report_test.rs` (seed literal ×2)

`MetricRow` 는 plain Rust struct(prost 아님)지만 **필드 추가 = 모든 literal 사이트 갱신 필수**. 사이트: `metrics.rs` 자기 테스트 ×4, `coordinator.rs::ingest_metrics` ×1, `report_test.rs` seed ×2. (Task 3 의 report.rs 는 `WindowWithHdr` 라 무관.)

- [ ] **Step 1: 실패하는 테스트 작성** (`metrics.rs` 의 `#[cfg(test)] mod tests`)

```rust
    #[tokio::test]
    async fn run_metrics_per_worker_rows_coexist() {
        let db = pool().await;
        sqlx::query(
            "INSERT INTO scenarios(id,name,yaml,created_at,updated_at,version) VALUES(?,?,?,?,?,?)",
        )
        .bind("S").bind("n").bind("version: 1\nname: n\nsteps: []\n")
        .bind(1_i64).bind(1_i64).bind(1_i64).execute(&db).await.unwrap();
        sqlx::query(
            "INSERT INTO runs(id,scenario_id,scenario_yaml,profile_json,env_json,status,created_at) \
             VALUES(?,?,?,?,?,?,?)",
        )
        .bind("R").bind("S").bind("version: 1\nname: n\nsteps: []\n")
        .bind("{}").bind("{}").bind("completed").bind(1_i64).execute(&db).await.unwrap();

        // Two workers emit the SAME (run_id, ts_second, step_id) window. Under A3a's
        // 3-column PK keep-first one would be dropped; with worker_id in the PK both
        // rows must survive.
        let rows = vec![
            MetricRow {
                run_id: "R".into(), ts_second: 1, step_id: "s".into(),
                worker_id: "w-a".into(), count: 5, error_count: 0,
                hdr_histogram: vec![0xAA], status_counts: r#"{"200":5}"#.into(),
            },
            MetricRow {
                run_id: "R".into(), ts_second: 1, step_id: "s".into(),
                worker_id: "w-b".into(), count: 3, error_count: 1,
                hdr_histogram: vec![0xBB], status_counts: r#"{"200":3}"#.into(),
            },
        ];
        insert_batch(&db, &rows).await.unwrap();

        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM run_metrics WHERE run_id='R'")
            .fetch_one(&db).await.unwrap();
        assert_eq!(n, 2, "distinct worker_id rows must coexist");

        // Same worker_id resend (same key, different payload) -> keep-first per worker.
        let resend = vec![MetricRow {
            run_id: "R".into(), ts_second: 1, step_id: "s".into(),
            worker_id: "w-a".into(), count: 99, error_count: 7,
            hdr_histogram: vec![0xCC], status_counts: r#"{"200":99}"#.into(),
        }];
        insert_batch(&db, &resend).await.unwrap();
        let again: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM run_metrics WHERE run_id='R'")
            .fetch_one(&db).await.unwrap();
        assert_eq!(again, 2, "duplicate worker key must be ignored (per-worker keep-first)");
        let a_count: i64 = sqlx::query_scalar(
            "SELECT count FROM run_metrics WHERE run_id='R' AND worker_id='w-a'",
        )
        .fetch_one(&db).await.unwrap();
        assert_eq!(a_count, 5, "w-a keeps first value, not replaced/summed");
    }
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-controller --lib store::metrics::tests::run_metrics_per_worker_rows_coexist`
Expected: FAIL — `MetricRow` 에 `worker_id` 필드가 없어 컴파일 에러(또는 인접 테스트가 worker_id 누락으로 컴파일 실패).

- [ ] **Step 3: struct 필드 추가** (`metrics.rs`, `MetricRow` 정의)

```rust
pub struct MetricRow {
    pub run_id: String,
    pub ts_second: i64,
    pub step_id: String,
    pub worker_id: String, // A3b: per-worker keying so N workers' windows coexist
    pub count: i64,
    pub error_count: i64,
    pub hdr_histogram: Vec<u8>,
    pub status_counts: String,
}
```

- [ ] **Step 4: `insert_batch` 4-컬럼 PK keep-first** (`metrics.rs`)

```rust
pub async fn insert_batch(db: &Db, rows: &[MetricRow]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    // Each window is a complete per-second snapshot emitted once per worker. A duplicate
    // (run_id,ts_second,step_id,worker_id) key can only come from an at-least-once gRPC
    // resend after reconnect (Slice 6) and carries identical data — keep-first per worker
    // is idempotent. Distinct worker_id rows coexist; read-time merge (report.rs /
    // metrics::summary) sums them. (Contrast run_loop_metrics, which accumulates because
    // those are incremental deltas, not snapshots.)
    let mut tx = db.begin().await?;
    for r in rows {
        sqlx::query(
            "INSERT INTO run_metrics(run_id,ts_second,step_id,worker_id,count,error_count,hdr_histogram,status_counts) \
             VALUES(?,?,?,?,?,?,?,?) \
             ON CONFLICT(run_id,ts_second,step_id,worker_id) DO NOTHING",
        )
        .bind(&r.run_id)
        .bind(r.ts_second)
        .bind(&r.step_id)
        .bind(&r.worker_id)
        .bind(r.count)
        .bind(r.error_count)
        .bind(&r.hdr_histogram)
        .bind(&r.status_counts)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}
```

- [ ] **Step 5: `ingest_metrics` literal 갱신** (`coordinator.rs`, `MetricRow` 매핑) — `batch.worker_id` 전달:

```rust
            crate::store::metrics::MetricRow {
                run_id: batch.run_id.clone(),
                ts_second: w.ts_second,
                step_id: w.step_id.clone(),
                worker_id: batch.worker_id.clone(), // A3b: per-worker keying
                count: w.count as i64,
                error_count: w.error_count as i64,
                hdr_histogram: w.hdr_histogram.clone(),
                status_counts: status_json,
            }
```

또한 그 위의 A3a 주석(`// A3a: worker_id ignored for run_metrics (A3b adds per-worker merge).` ~ `MetricBatch arm`)을 갱신:

```rust
                    Some(WorkerPayload::MetricBatch(batch)) => {
                        // A3b: run_metrics is keyed by worker_id (per-worker rows, read-time
                        // merge). loop/if metrics accumulate (count + excluded), so N-worker
                        // sums are correct without per-worker keying.
                        ingest_metrics(&state, &batch).await;
                    }
```

- [ ] **Step 6: 기존 literal 사이트 worker_id 채우기** — 컴파일 에러가 나는 곳 전부:
  - `metrics.rs` 기존 테스트 ×4(`windows_with_hdr_returns_rows_in_order...` ×2, `run_metrics_insert_is_idempotent_keep_first` ×2): 각 `MetricRow` 에 `worker_id: "".into(),` 추가(step_id 다음 줄).
  - `report_test.rs` seed ×2: 각 `MetricRow` 에 `worker_id: "".to_string(),` 추가.

  > 단일워커 sentinel `""` 로 채우면 기존 어설션(keep-first, ordering)은 worker_id 가 동일("")해 PK 충돌 → keep-first 그대로 동작 = 의도 보존.

- [ ] **Step 7: 테스트 통과 + 빌드**

Run: `cargo test -p handicap-controller --lib store::metrics:: && cargo build -p handicap-controller --tests`
Expected: PASS, 컴파일 클린(literal 누락 0).

- [ ] **Step 8: 커밋**

```bash
git add crates/controller/src/store/metrics.rs crates/controller/src/grpc/coordinator.rs crates/controller/tests/report_test.rs
git commit -m "feat(controller): MetricRow.worker_id + per-worker keep-first insert (A3b)"
```

---

## Task 3: `windows_with_hdr` worker_id 반환 + `build_report` (ts,step) HDR 머지

**Files:**
- Modify: `crates/controller/src/store/metrics.rs` (`WindowWithHdr.worker_id` + SELECT/ORDER)
- Modify: `crates/controller/src/report.rs` (`build_report` 윈도 emit 재작성 + 단위테스트)

읽기 리포트 경로. `windows_with_hdr` 가 워커별 행을 `ORDER BY ts,step,worker` 로 반환하고, `build_report` 가 `(ts_second, step_id)` 로 그룹핑하며 워커 HDR 를 `merge_into`(= `Histogram::add`, bound 동일 → 무손실) 로 병합 + count SUM + status_counts map merge.

- [ ] **Step 1: 실패하는 테스트 작성** (`report.rs` 의 `#[cfg(test)] mod tests`) — 두 워커가 같은 윈도에 기여. **이 테스트가 keep-first 회귀의 권위 가드**(Task 5 e2e 는 버킷 충돌이 확률적이라 smoke; 이건 결정론적 RED):

```rust
    #[test]
    fn build_report_merges_worker_windows() {
        let r = run_row();
        // Same (ts_second=100, step_id="s"), two workers, distinct latency samples.
        // A3a keep-first would drop one row -> undercount + half the histogram.
        let rows = vec![
            WindowWithHdr {
                ts_second: 100,
                step_id: "s".into(),
                worker_id: "w-a".into(),
                count: 3,
                error_count: 0,
                status_counts: r#"{"200":3}"#.into(),
                hdr_histogram: make_hdr_bytes(&[10_000, 10_000, 10_000]),
            },
            WindowWithHdr {
                ts_second: 100,
                step_id: "s".into(),
                worker_id: "w-b".into(),
                count: 5,
                error_count: 1,
                status_counts: r#"{"200":4,"500":1}"#.into(),
                hdr_histogram: make_hdr_bytes(&[40_000, 40_000, 40_000, 40_000, 40_000]),
            },
        ];
        let yaml = r.scenario_yaml.clone();
        let rep = build_report(&r, &yaml, &rows, &[], &[]);

        // One collapsed window per (ts_second, step_id), counts summed.
        assert_eq!(rep.windows.len(), 1, "worker rows collapse to one window");
        assert_eq!(rep.windows[0].count, 8);
        assert_eq!(rep.windows[0].error_count, 1);
        assert_eq!(rep.windows[0].status_counts.get("200").copied(), Some(7));
        assert_eq!(rep.windows[0].status_counts.get("500").copied(), Some(1));
        // Window percentiles come from the MERGED histogram (both workers' samples):
        // p99 must reflect the 40ms tail, not just w-a's 10ms.
        // NOTE: of the 8 merged samples [10,10,10,40,40,40,40,40]ms, FIVE are 40ms, so
        // p50 is ALSO 40 here (the 4th sample). Do not assert p50==10 — only the tail
        // (p99) distinguishes "merged" from "w-a only". Under A3a keep-first, w-b's row
        // is dropped -> count 3, p99 10 -> this test goes RED. That is the gate.
        assert_eq!(rep.windows[0].p99_ms, 40, "merged HDR keeps both workers' tail");

        // Totals + overall percentiles also reflect both workers.
        assert_eq!(rep.summary.count, 8);
        assert_eq!(rep.summary.errors, 1);
        assert_eq!(rep.summary.p99_ms, 40);
        // Step-level rollup sums both workers too.
        let s = rep.steps.iter().find(|s| s.step_id == "s").unwrap();
        assert_eq!(s.count, 8);

        // typed round-trip.
        let v = serde_json::to_value(&rep).unwrap();
        let _back: ReportJson = serde_json::from_value(v).unwrap();
    }
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-controller --lib report::tests::build_report_merges_worker_windows`
Expected: FAIL — `WindowWithHdr` 에 `worker_id` 필드 없음(컴파일 에러).

- [ ] **Step 3: `WindowWithHdr` 필드 + `windows_with_hdr` SQL** (`metrics.rs`)

```rust
#[derive(Debug)]
pub struct WindowWithHdr {
    pub ts_second: i64,
    pub step_id: String,
    pub worker_id: String, // A3b: separate row per worker; build_report merges by (ts,step)
    pub count: i64,
    pub error_count: i64,
    pub status_counts: String,
    pub hdr_histogram: Vec<u8>,
}

pub async fn windows_with_hdr(db: &Db, run_id: &str) -> sqlx::Result<Vec<WindowWithHdr>> {
    let rows = sqlx::query(
        "SELECT ts_second, step_id, worker_id, count, error_count, status_counts, hdr_histogram \
         FROM run_metrics WHERE run_id = ? ORDER BY ts_second, step_id, worker_id",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| WindowWithHdr {
            ts_second: r.get("ts_second"),
            step_id: r.get("step_id"),
            worker_id: r.get("worker_id"),
            count: r.get("count"),
            error_count: r.get("error_count"),
            status_counts: r.get("status_counts"),
            hdr_histogram: r.get("hdr_histogram"),
        })
        .collect())
}
```

  또한 `metrics.rs` 의 `windows_with_hdr_returns_rows_in_order...` 테스트가 `WindowWithHdr` 를 직접 만들지는 않지만(insert_batch→read), `MetricRow` 는 Task 2 에서 이미 worker_id 추가됨 — 이 테스트는 그대로 통과(worker_id 컬럼이 SELECT 에 늘었어도 어설션은 ts/hdr 만 봄).

- [ ] **Step 4: `build_report` 윈도 emit 재작성** (`report.rs`) — `for r in rows { ... windows.push(...) }` 블록(현 152-179)과 그 위 `let mut windows = Vec::with_capacity(rows.len());`(143) 를 아래로 교체. `overall`/`per_step`/`per_step_count`/`status_dist`/`total_count`/`total_errors` 선언·누적은 유지하되, per-row push 대신 `(ts,step)` 어큐뮬레이터에 모아 마지막에 emit:

```rust
    // Per-(ts_second, step_id) accumulator merging all workers sharing the window.
    struct WindowAcc {
        count: u64,
        error_count: u64,
        status: BTreeMap<String, u64>,
        hist: Option<Histogram<u64>>, // None until the first decodable HDR blob
    }
    let mut window_acc: BTreeMap<(i64, String), WindowAcc> = BTreeMap::new();
    let mut overall = fresh_hist();
    let mut per_step: BTreeMap<String, Histogram<u64>> = BTreeMap::new();
    // (count, error_count, status_counts)
    let mut per_step_count: BTreeMap<String, (u64, u64, BTreeMap<String, u64>)> = BTreeMap::new();
    let mut status_dist: BTreeMap<String, u64> = BTreeMap::new();
    let mut total_count: u64 = 0;
    let mut total_errors: u64 = 0;

    for r in rows {
        let sc = parse_status_counts(&r.status_counts);
        let acc = window_acc
            .entry((r.ts_second, r.step_id.clone()))
            .or_insert_with(|| WindowAcc {
                count: 0,
                error_count: 0,
                status: BTreeMap::new(),
                hist: None,
            });
        acc.count += r.count as u64;
        acc.error_count += r.error_count as u64;
        add_status(&mut acc.status, &sc);
        if let Ok(Some(h)) = decode_hdr(&r.hdr_histogram) {
            merge_into(&mut overall, &h);
            let step_h = per_step.entry(r.step_id.clone()).or_insert_with(fresh_hist);
            merge_into(step_h, &h);
            let win_h = acc.hist.get_or_insert_with(fresh_hist);
            merge_into(win_h, &h);
        }
        total_count += r.count as u64;
        total_errors += r.error_count as u64;
        add_status(&mut status_dist, &sc);
        let step_acc = per_step_count.entry(r.step_id.clone()).or_default();
        step_acc.0 += r.count as u64;
        step_acc.1 += r.error_count as u64;
        add_status(&mut step_acc.2, &sc);
    }

    // Emit one window per (ts_second, step_id) — BTreeMap iterates sorted by (ts, step),
    // matching the previous SQL ORDER BY. Percentiles come from the merged histogram.
    let windows: Vec<ReportWindow> = window_acc
        .into_iter()
        .map(|((ts_second, step_id), acc)| {
            let wp = acc
                .hist
                .as_ref()
                .map(percentiles_of)
                .unwrap_or_else(Percentiles::empty);
            ReportWindow {
                ts_second,
                step_id,
                count: acc.count,
                error_count: acc.error_count,
                status_counts: acc.status,
                p50_ms: wp.p50_ms,
                p95_ms: wp.p95_ms,
                p99_ms: wp.p99_ms,
            }
        })
        .collect();
```

  > 주의: 기존 코드에서 `let mut overall = fresh_hist();` 등 선언이 이미 152행 위에 있다면 **중복 선언이 안 되게** 위 블록으로 통합(한 군데에서만 선언). `windows` 도 `let mut windows` → `let windows`(불변, map 으로 한 번에 생성)로 바뀐다. 이후 `ReportJson { ... windows, ... }` 사용처는 그대로.

- [ ] **Step 5: 테스트 통과 + 기존 report 테스트 회귀**

Run: `cargo test -p handicap-controller --lib report::`
Expected: PASS — 새 `build_report_merges_worker_windows` + 기존 `build_report_aggregates_totals`(distinct (ts,step) 라 windows.len()==3 유지)/`build_report_tolerates_bad_hdr_blob`(단일 bad row → hist None → p95=0)/`..loop_breakdown`/`..if_breakdown` 전부 green.

- [ ] **Step 6: 커밋**

```bash
git add crates/controller/src/store/metrics.rs crates/controller/src/report.rs
git commit -m "feat(controller): build_report merges per-worker HDR windows by (ts,step) (A3b)"
```

---

## Task 4: `summary`(live `/metrics`) 워커 행 merge — 출력 shape 무변경

**Files:**
- Modify: `crates/controller/src/store/metrics.rs` (`summary` 재작성 + 단위테스트)

live `/metrics` 는 진행 중 폴링. 워커별 행이 생긴 뒤 같은 `(ts_second, step_id)` 가 N 행이므로, `(ts_second, step_id)` 로 fold 해 count/error_count SUM + status_counts map merge. **출력 `WindowSummary` 에 worker_id 를 넣지 않는다**(UI 무변경).

- [ ] **Step 1: 실패하는 테스트 작성** (`metrics.rs` 의 `#[cfg(test)] mod tests`)

```rust
    #[tokio::test]
    async fn summary_merges_worker_rows() {
        let db = pool().await;
        sqlx::query(
            "INSERT INTO scenarios(id,name,yaml,created_at,updated_at,version) VALUES(?,?,?,?,?,?)",
        )
        .bind("S").bind("n").bind("version: 1\nname: n\nsteps: []\n")
        .bind(1_i64).bind(1_i64).bind(1_i64).execute(&db).await.unwrap();
        sqlx::query(
            "INSERT INTO runs(id,scenario_id,scenario_yaml,profile_json,env_json,status,created_at) \
             VALUES(?,?,?,?,?,?,?)",
        )
        .bind("R").bind("S").bind("version: 1\nname: n\nsteps: []\n")
        .bind("{}").bind("{}").bind("running").bind(1_i64).execute(&db).await.unwrap();

        // Two workers, same (ts_second=1, step_id="s"); plus a distinct window.
        let rows = vec![
            MetricRow {
                run_id: "R".into(), ts_second: 1, step_id: "s".into(), worker_id: "w-a".into(),
                count: 5, error_count: 0, hdr_histogram: vec![1], status_counts: r#"{"200":5}"#.into(),
            },
            MetricRow {
                run_id: "R".into(), ts_second: 1, step_id: "s".into(), worker_id: "w-b".into(),
                count: 3, error_count: 2, hdr_histogram: vec![2], status_counts: r#"{"200":1,"500":2}"#.into(),
            },
            MetricRow {
                run_id: "R".into(), ts_second: 2, step_id: "s".into(), worker_id: "w-a".into(),
                count: 4, error_count: 0, hdr_histogram: vec![3], status_counts: r#"{"200":4}"#.into(),
            },
        ];
        insert_batch(&db, &rows).await.unwrap();

        let s = summary(&db, "R").await.unwrap();
        // ts=1 collapses two workers into one window; ts=2 stays one -> 2 windows total.
        assert_eq!(s.windows.len(), 2);
        let w1 = s.windows.iter().find(|w| w.ts_second == 1).unwrap();
        assert_eq!(w1.count, 8, "summed across workers");
        assert_eq!(w1.error_count, 2);
        assert_eq!(w1.status_counts.get("200").copied(), Some(6));
        assert_eq!(w1.status_counts.get("500").copied(), Some(2));
        let w2 = s.windows.iter().find(|w| w.ts_second == 2).unwrap();
        assert_eq!(w2.count, 4);
    }
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-controller --lib store::metrics::tests::summary_merges_worker_rows`
Expected: FAIL — 현재 `summary` 는 per-row 반환이라 `windows.len()==3`(ts=1 이 두 행) → 어설션 실패.

- [ ] **Step 3: `summary` 재작성** (`metrics.rs`) — fold by `(ts_second, step_id)`:

```rust
pub async fn summary(db: &Db, run_id: &str) -> sqlx::Result<MetricSummary> {
    // Per-worker rows (A3b): merge by (ts_second, step_id). status_counts is per-row
    // JSON so it can't be SUMmed in SQL — fold in Rust. ORDER guarantees deterministic
    // grouping; output shape is unchanged (no worker_id exposed — UI MetricSummarySchema).
    let rows = sqlx::query(
        "SELECT ts_second, step_id, count, error_count, status_counts \
         FROM run_metrics WHERE run_id = ? ORDER BY ts_second, step_id",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;

    use std::collections::BTreeMap;
    let mut acc: BTreeMap<(i64, String), WindowSummary> = BTreeMap::new();
    for r in rows {
        let ts: i64 = r.get("ts_second");
        let step: String = r.get("step_id");
        let count: i64 = r.get("count");
        let errors: i64 = r.get("error_count");
        let status_json: String = r.get("status_counts");
        let parsed: HashMap<String, u64> = serde_json::from_str(&status_json).unwrap_or_default();
        let w = acc.entry((ts, step.clone())).or_insert_with(|| WindowSummary {
            ts_second: ts,
            step_id: step,
            count: 0,
            error_count: 0,
            status_counts: HashMap::new(),
        });
        w.count += count;
        w.error_count += errors;
        for (k, v) in parsed {
            *w.status_counts.entry(k).or_insert(0) += v;
        }
    }

    Ok(MetricSummary {
        run_id: run_id.to_string(),
        windows: acc.into_values().collect(),
    })
}
```

  > `BTreeMap<(i64, String), _>::into_values()` 는 (ts, step) 정렬 순 — 기존 `ORDER BY ts_second, step_id` 와 동일한 윈도 순서 보존. `WindowSummary`/`MetricSummary` 구조체는 무변경.

- [ ] **Step 4: 테스트 통과 + 기존 summary 사용 테스트 회귀**

Run: `cargo test -p handicap-controller --lib store::metrics::`
Expected: PASS — 새 테스트 + 기존 `run_metrics_insert_is_idempotent_keep_first`(summary 로 count 확인, worker_id 동일 "" → 1 윈도 그대로) green.

- [ ] **Step 5: 커밋**

```bash
git add crates/controller/src/store/metrics.rs
git commit -m "feat(controller): summary() merges per-worker rows by (ts,step), shape unchanged (A3b)"
```

---

## Task 5: e2e — N=2 fan-out 메트릭 머지 (무손실 count + HDR p50)

**Files:**
- Modify: `crates/controller/tests/multi_worker_fanout_e2e.rs` (`two_worker_fanout_merges_metrics` 추가; `worker_bin_path`/`bind_local`/`boot` 헬퍼 재사용)

A3a 의 `two_worker_fanout_completes` 와 같은 셋업(2 VU, capacity 1 → N=2)으로 run 을 끝내고, **`GET /report`** 와 **`GET /metrics`** 를 검증한다.

> **회귀 가드의 권위는 Task 3 의 단위테스트 `build_report_merges_worker_windows` 다** — 그건 두 워커를 결정론적으로 `ts_second=100` 동일 버킷에 놓아 keep-first 면 반드시 RED. 이 e2e 는 **smoke 테스트**다: 실제 run 에서 두 워커의 flush 타임스탬프가 같은 `ts_second` 버킷에 떨어질지는 확률적(인접 버킷에 떨어지면 keep-first 여도 손실 0 → A3a/A3b 구분 불가)이라, 단독으론 약한 가드다. 가장 강한 e2e 어설션은 `mc == rc`(아래 — `/metrics`와 `/report`가 같은 머지 행을 읽으므로 필연적으로 일치, A3b 읽기 경로 정합성 교차검증).

- [ ] **Step 1: 실패하는 e2e 작성** (파일 끝에 추가)

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_worker_fanout_merges_metrics() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("ok")
                .set_delay(Duration::from_millis(5)), // p50_ms > 0 after HDR merge
        )
        .mount(&target)
        .await;

    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::with_capacity(db.clone(), 1); // capacity 1 -> N = total_vus
    let (rest_handle, grpc_handle) =
        boot(coord, db.clone(), grpc_listener, rest_listener, grpc_addr, &worker_bin).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);
    // Same step_id across both shards so their per-second windows collide on
    // (run_id, ts_second, step_id) — exactly the case A3a keep-first dropped.
    let scenario_yaml = format!(
        "version: 1\nname: merge\nvariables:\n  base: \"{}\"\nsteps:\n  - id: \"01HX0000000000000000000022\"\n    name: hit\n    type: http\n    request:\n      method: GET\n      url: \"{{{{base}}}}/hit?vu=${{vu_id}}\"\n    assert:\n      - status: 200\n",
        target.uri()
    );
    let v: Value = http
        .post(format!("{}/api/scenarios", rest_base))
        .json(&json!({ "yaml": scenario_yaml }))
        .send().await.unwrap().json().await.unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 2 VUs, 3s — steady load so both shards emit several overlapping windows.
    let v: Value = http.post(format!("{}/api/runs", rest_base))
        .json(&json!({ "scenario_id": scenario_id, "profile": { "vus": 2, "duration_seconds": 3 }, "env": {} }))
        .send().await.unwrap().json().await.unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    let deadline = std::time::Instant::now() + Duration::from_secs(40);
    let mut last = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{}/api/runs/{}", rest_base, run_id))
            .send().await.unwrap().json().await.unwrap();
        last = v["status"].as_str().unwrap().to_string();
        if last == "completed" || last == "failed" || last == "aborted" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(last, "completed", "N=2 fan-out should complete; got {last}");

    // Ground truth: wiremock saw both shards (vu=0 and vu=1) plus a total count.
    let reqs = target.received_requests().await.unwrap();
    let wc = reqs.len();
    let qs: Vec<String> = reqs
        .iter()
        .map(|r| r.url.query().unwrap_or("").to_string())
        .collect();
    assert!(qs.iter().any(|q| q.contains("vu=0")), "shard 0 missing");
    assert!(qs.iter().any(|q| q.contains("vu=1")), "shard 1 missing");

    // /report: counts must NOT be halved by keep-first. A3a would drop one worker's
    // row per colliding (ts,step) -> report count ~= wc/2. A3b merges -> ~= wc (a few
    // in-flight-at-deadline requests may hit wiremock without being counted).
    let report: Value = http
        .get(format!("{}/api/runs/{}/report", rest_base, run_id))
        .send().await.unwrap().json().await.unwrap();
    let rc = report["summary"]["count"].as_u64().unwrap() as usize;
    assert!(
        rc <= wc && rc + 4 >= wc,
        "report count {rc} should match wiremock {wc} (A3a keep-first would be ~half)"
    );
    // HDR blobs from both workers decoded + merged -> non-zero p50 (5ms delay).
    assert!(
        report["summary"]["p50_ms"].as_u64().unwrap() >= 1,
        "merged HDR should yield p50_ms >= 1ms"
    );

    // /metrics live summary must agree with /report (both read the same merged rows).
    let metrics: Value = http
        .get(format!("{}/api/runs/{}/metrics", rest_base, run_id))
        .send().await.unwrap().json().await.unwrap();
    let mc: u64 = metrics["windows"]
        .as_array().unwrap()
        .iter()
        .map(|w| w["count"].as_u64().unwrap())
        .sum();
    assert_eq!(mc as usize, rc, "/metrics summed count must equal /report count");

    rest_handle.abort();
    grpc_handle.abort();
}
```

- [ ] **Step 2: 실패 확인 (Task 1–4 미적용 상태 기준이면)** — 이 task 시점엔 Task 1–4 가 이미 머지돼 있으므로, 먼저 빌드만 깨지는지 확인 후 바로 통과해야 한다. 실패-우선 의미를 보려면 이 테스트를 Task 1 전에 돌리면 keep-first 로 `rc + 4 >= wc` 가 깨진다(설계 의도). 실제 실행 순서상으론:

Run: `cargo test -p handicap-controller --test multi_worker_fanout_e2e two_worker_fanout_merges_metrics -- --nocapture`
Expected: PASS (Task 1–4 적용 후). 한 번 깨지면 controller 로그에서 worker exit / status 확인(루트 CLAUDE.md "run 영영 running + 0 req" 함정).

  > **flake 주의**: e2e 는 cold build 시 SIGKILL flake 이력 있음(메모리 `flaky-e2e-cold-build`). 한 번 실패하면 warm 재시도. 타이밍 tolerance(`rc + 4 >= wc`)는 deadline 직전 in-flight 요청 ±몇 개를 흡수.

- [ ] **Step 3: 커밋**

```bash
git add crates/controller/tests/multi_worker_fanout_e2e.rs
git commit -m "test(controller): N=2 fan-out metric merge e2e (no keep-first loss + HDR p50) (A3b)"
```

---

## Task 6: 게이트 통과 + 문서 (CLAUDE.md 함정 · ADR-0027 · 로드맵 · 메모리)

**Files:**
- Modify: `crates/controller/CLAUDE.md`, `docs/adr/0027-multi-worker-fanout.md`, `docs/roadmap.md`, 루트 `CLAUDE.md`
- Memory: `mvp1-roadmap.md` / `multi-worker-fanout-a3.md` 갱신(orchestrator)

- [ ] **Step 1: 전체 게이트** (커밋 전 필수 — 루트 CLAUDE.md 검증 훅)

```bash
cargo fmt --check
cargo build --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
Expected: 전부 green. UI 무변경이므로 `pnpm` 게이트 불필요(이 슬라이스는 `ui/` 무손댐).

- [ ] **Step 2: `crates/controller/CLAUDE.md` 함정 갱신** — "멀티 워커 fan-out" 섹션의 A3a keep-first 줄을 **해소 + A3b 함정 추가**로 교체. 기존:

  `- **A3a 메트릭은 keep-first(레이턴시 부정확) — A3b 까지** (A3a): ...`

  를 아래로 교체:

```markdown
- **A3b: run_metrics 는 워커별 행 + 읽기 시점 머지 (A3a keep-first 해소)** (A3b): `run_metrics` PK 에 `worker_id` 추가(migration 0008, **Rust-guarded 새 테이블+복사** = `connect()` 내 `ensure_run_metrics_worker_id`, `runs.message` 컬럼 가드와 동형 — pure-SQL const 아님, `grep -c MIGRATION_SQL` 교차검증 무관). `insert_batch` 는 4-컬럼 PK keep-first(워커별 멱등). 읽기 3 사이트가 `(ts_second, step_id)` 로 머지: `summary`(live `/metrics`, count/error SUM + status_counts Rust map merge, **출력 shape 무변경**), `windows_with_hdr`(worker_id SELECT + `ORDER BY ts,step,worker`), `build_report`(워커 HDR `merge_into`=`Histogram::add` 무손실 + count SUM, **`windows` 배열이 (ts,step)당 1행으로 collapse** — `overall`/`per_step`/`total_*` 누적은 무변경, N=1 이면 byte-identical). HDR bound(LO=1/HI=60_000_000/SIGFIG=3) 동일이라 무손실(engine CLAUDE.md).
- **loop/if 메트릭은 worker_id 안 넣는다 (run_metrics 와 정반대, 둘 다 옳음)** (A3b): `run_loop_metrics`/`run_if_metrics` 는 증분 델타 누적(`count + excluded.count`)이고 워커별 disjoint 델타라 합산이 정확 → PK 무변경. run_metrics 윈도는 "완전 스냅샷"이라 워커별 분리 후 머지가 필요, loop/if 는 "증분"이라 합산이 맞다.
```

- [ ] **Step 3: `docs/adr/0027-multi-worker-fanout.md` 상태 갱신** — `* Status: Accepted (A3a 머지; A3b/A3c 후속)` → `* Status: Accepted (A3a+A3b 머지; A3c 후속)`. "메트릭 머지는 A3b" 단락(§A3a 한정 스코프) 끝에 한 줄 추가:

```markdown
  **(A3b 머지 완료: run_metrics PK +worker_id via migration 0008 Rust-guarded rebuild, 읽기 시점 (ts,step) HDR merge + count SUM, summary/windows_with_hdr/build_report. loop/if 는 증분 누적이라 무변경.)**
```

- [ ] **Step 4: `docs/roadmap.md` 갱신** — §A3 헤더와 진행 줄의 "A3a 머지 완료" → "A3a+A3b 머지 완료", "A3b(메트릭 머지)·A3c 후속" → "A3c(K8s Indexed Job) 후속". 분할 줄의 A3b 화살표 항목에 ✅ 표기.

- [ ] **Step 5: 루트 `CLAUDE.md` 갱신** — "알아둘 결정들" 0027 줄에 "A3a(조정+proto+엔진) 머지 완료" → "A3a+A3b(메트릭 머지) 머지 완료", "다음=A3b" → "다음=A3c". A3a 한 줄 요약 섹션이 있으면 A3b 결과 한 줄 추가(다른 슬라이스 결과 포맷과 일치).

- [ ] **Step 6: 문서 커밋 + conflict marker 점검**

```bash
grep -rn '^<<<<<<<\|^>>>>>>>\|^=======$' docs/ crates/controller/CLAUDE.md CLAUDE.md || echo "no markers"
git add crates/controller/CLAUDE.md docs/adr/0027-multi-worker-fanout.md docs/roadmap.md CLAUDE.md
git commit -m "docs: A3b metric merge — CLAUDE.md traps + ADR-0027 + roadmap (A3b)"
```

- [ ] **Step 7: 메모리 갱신** (orchestrator, 커밋 후) — `multi-worker-fanout-a3.md` / `mvp1-roadmap.md` 에 "A3b 머지 완료" + 핵심 락인(0008 Rust-guarded rebuild, (ts,step) read-time merge, loop/if 무변경) 한 줄.

---

## Self-Review (spec 대비 점검 결과)

**1. spec §5 커버리지:**
- §5.1 migration 0008 Rust-guarded 새 테이블+복사 → Task 1 ✅ (가드 = worker_id 컬럼 존재; sentinel `''`; 멱등·기존행 보존 테스트 + `connect()` 배선 회귀 테스트 = "가드 정의했으나 미배선" 차단).
- §5.2 `insert_batch` 4-컬럼 keep-first → Task 2 ✅. `summary` (ts,step) merge + status_counts Rust map merge → Task 4 ✅. `windows_with_hdr` worker_id 반환(ORDER ts,step,worker) → Task 3 ✅. `build_report` (ts,step) HDR merge + count SUM → Task 3 ✅. HDR bound 무손실 테스트 → Task 3 `build_report_merges_worker_windows`(p99_ms=40 으로 양 워커 tail 보존 단언) ✅.
- §5.3 loop/if 무변경 → 본 plan 이 두 테이블/insert 를 건드리지 않음으로 충족 ✅ (파일 구조 맵 "무변경 확인 대상"에 명시).
- §9 A3b 불릿(마이그레이션 0008 / MetricRow.worker_id+insert_batch / MetricBatch arm worker_id 전달 / summary·windows_with_hdr·build_report 머지 + HDR bound 테스트 / N=2 메트릭 합산 e2e) → Task 1–5 전부 매핑 ✅.
- §10 테스트 전략(메트릭 머지 단위, 마이그레이션 멱등, keep-first per-worker, A3b 메트릭 합산 e2e) → Task 1·2·3·4 단위 + Task 5 e2e ✅.

**2. placeholder 스캔:** 모든 코드 step 에 실제 코드 블록 + 정확한 `cargo test` 명령·기대 결과 동봉. "적절한 에러 처리" 류 없음.

**3. 타입 일관성:** `MetricRow.worker_id`/`WindowWithHdr.worker_id` 동일 `String`; `ensure_run_metrics_worker_id` 이름 Task 1↔Task 6 일치; PK 컬럼 순서 `(run_id, ts_second, step_id, worker_id)` 가 0008 DDL·`insert_batch` ON CONFLICT 동일; `summary` 출력 `WindowSummary`(worker_id 없음) shape 무변경. `merge_into`/`decode_hdr`/`fresh_hist`/`percentiles_of`/`Percentiles::empty` 시그니처는 기존 엔진/리포트 API 그대로 사용.

**리뷰어 주목 deviation**(상단 "스코프 결정" 1–5): `WindowWithHdr.worker_id` 노출(spec 와이어 1:1, build_report 는 미사용), `build_report` 윈도 collapse(누적 로직 무변경), `summary` 출력 shape 무변경, loop/if 무변경, 0008 은 const 아닌 Rust 가드.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-02-multi-worker-fanout-a3b.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — task 마다 fresh subagent + 2-stage 리뷰(spec compliance → code quality), task 간 검토, 최종 `handicap-reviewer`. 이 repo 의 표준(A3a/9c/9d/A2 동일).

**2. Inline Execution** — 이 세션에서 executing-plans 로 batch 실행 + 체크포인트.

**Which approach?**

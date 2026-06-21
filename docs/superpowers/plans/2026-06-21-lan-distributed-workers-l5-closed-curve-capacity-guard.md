# LAN 분산 워커 L5 — closed-loop VU 곡선 풀 과부하 가드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** closed-loop VU 곡선(`vu_stages`) 풀 run을 L3/L4와 동형으로 capacity-aware fan-out시키고(곡선 peak를 `capacity_split`로 워커에 분배·각 워커가 비례 축소된 `vu_stages` 실행), 용량 부족 시 409+곡선 비례 축소/강행 UX를 제공하며, active-VU 시계열을 worker_id로 분리·읽기 SUM해 멀티워커 곡선에서도 정확하게 만든다.

**Architecture:** 컨트롤러-mostly. L4가 접근자(`concurrency_demand`/`pool_worker_cap`/`vu_curve_max`)·2-param `reserve_idle_pool_capacity`를 곡선에 대해 *미리* peak를 반환하게 깔아둬, 가드 fork에서 `!is_vu_curve()` 제외를 제거하면 예약/enqueue/register가 곡선용 `(vu_offset, vu_count)`(=peak 몫)를 그대로 산출한다. 신규 작업 = ① per-worker `vu_stages` 비례 스케일(`reduce_pool_profile`) ② active-VU worker_id 머지(migration 0018, A3b 미러) ③ 예약-시점 unique 빈-슬라이스 floor(3모드 공통·선재 버그 fix) ④ UI 곡선 프리뷰+409 다이얼로그. **proto·worker·engine 0 · migration 1(0018).**

**Tech Stack:** Rust(axum controller, tonic gRPC, sqlx SQLite), TypeScript/React(Vite, Zod, React Query, vitest/RTL).

## Global Constraints

- **proto · worker · engine 0-diff** — `crates/proto`·`crates/worker`·`crates/engine` 무변경. 곡선 실행(`run_scenario_vu_curve`)·`MetricBatch`·`vu_offset`/`vu_count` 전부 기존 그대로(spec R11).
- **migration은 0018 하나만** — `run_active_vu_metrics` worker_id. 현재 최고 번호 0017(settings). **Rust-guarded `ensure_*` fn 패턴**(A3b `ensure_run_metrics_worker_id` 미러·`connect()`에서 `.await?` 1줄 배선) — const+execute가 아니라 `.sql`은 참고용 주석. 따라서 `grep -c MIGRATION_SQL` 교차검증은 **이 슬라이스엔 무관**(ensure_fn 계열).
- **byte-identical 보존**: 비-풀 곡선(N=1·validate 254 유지)·단일워커 풀 곡선(`shard_count=1` early-return)·active-VU N=1 출력(`ReportJson.active_vu_series`)·closed-fixed·open(L3/L4)·비-곡선·rows≥N 풀 unique. **의도적 동작 변경 2건만**: 풀 곡선 `?force` N=1→even-split(R6)·풀 unique `rows<N` 언바운드→거부(R14, 곡선+closed-fixed+open 공통·선재 버그 fix).
- **모든 UI 문구는 `ko.*` 카탈로그 경유**(ADR-0035·인라인 영어/한국어 0). 곡선 다이얼로그는 mode-aware(VU 단위).
- **커밋 게이트**: cargo-영향 커밋마다 전체 워크스페이스 게이트(수 분). `git commit`은 `run_in_background:false` 단일 호출(폴링 금지)·파이프 없이. UI 커밋은 `cd ui && pnpm lint && pnpm test && pnpm build` 선행.
- **리뷰 BASE**: 각 task는 독립 green 커밋. 최종 `handicap-reviewer`는 spec/plan docs 커밋 *위* 첫 코드 커밋부터 스코프.

---

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `crates/controller/src/grpc/coordinator.rs` | `reduce_open_loop_profile`→`reduce_pool_profile` 개명 + 곡선 `vu_stages` 스케일 arm; ingest active-VU worker_id | 1, 2 |
| `crates/controller/src/store/metrics.rs` | `ActiveVuRow.worker_id` + insert UPSERT 키 + `active_vu_series` SUM | 2 |
| `crates/controller/src/store/migrations/0018_run_active_vu_metrics_worker_id.sql` | (신규) 새 테이블 정의 참고용 — 실제 reshape는 Rust-guarded `ensure_*` | 2 |
| `crates/controller/src/store/mod.rs` | `ensure_active_vu_worker_id`(A3b `ensure_run_metrics_worker_id` 미러) + connect() 배선 | 2 |
| `crates/controller/src/api/runs.rs` | 가드 fork 곡선 포함(precheck/dispatch) · `n_cap` 곡선 peak · validate 254 pool-gate · 예약-시점 unique floor | 3 |
| `ui/src/components/sizing.ts` | (기존·Modify) 순수 `scaleVuStages` 가산 (`peakStageTarget`:86 등 이미 있음) | 4 |
| `ui/src/components/RunDialog.tsx` | closed+curve 프리뷰 over-hint · 409 다이얼로그 3-way clamp(curve arm) | 4 |
| `ui/src/i18n/ko.ts` | `capacityGuard` 곡선 변형(dialogBodyCurve·clampNoteCurve·clampCurve·overHintCurve) | 4 |

---

## Task 1: `reduce_pool_profile` — 개명 + 곡선 `vu_stages` 비례 스케일 (R2, R3)

순수 컨트롤러 헬퍼. 곡선 분기는 Task 3가 곡선을 guarded 경로로 보내기 전까지 런타임 미도달이지만, 단위 테스트가 직접 호출해 검증하므로 standalone green.

> **R3 두 단언 중**: `vu_curve_peak_stage_equals_vu_count`(peak 스케일 == vu_count)는 아래 Step 1의 `reduce_pool_profile_scales_vu_stages_proportionally`가 인라인으로 단언(`max(scaled) == vu_count`). `vu_curve_offsets_disjoint_cover_peak`(vu_offset 무겹침·`[0,peak)` 덮음)는 **별도 신규 테스트 불요** — `(vu_offset, vu_count)`는 `reduce_pool_profile`이 아니라 `reserve_idle_pool_capacity`+`capacity_split`(Σ=peak)+`register`(precomputed prefix-sum)가 산출하고 곡선은 그 경로를 **무변경 재사용**(closed-fixed/open과 동일), 그 disjoint/coverage는 기존 shard/coordinator 테스트가 이미 잠금. 곡선-고유 신규 동작은 stage 스케일뿐이라 그것만 신규 테스트.

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` (`reduce_open_loop_profile` 896-923 → `reduce_pool_profile`; call site `assignment_for` ~612; 인라인 테스트 2곳 ~1631-1693/~2407-2437)

**Interfaces:**
- Consumes: `shard::proportional_split(total: u32, weights: &[u32]) -> Vec<u32>`(곡선·0-share OK), `shard::shard_split(total: u32, n: u32, i: u32) -> (u32, u32)`(균등 fallback) — 둘 다 `crates/controller/src/grpc/shard.rs`에 기존.
- Produces: `fn reduce_pool_profile(profile: &mut pb::Profile, shard_index: u32, shard_count: u32, vu_count: u32, slot_weights: Option<&[u32]>)` — 개명만, 시그니처 불변. Task 3·assignment_for가 이 이름으로 호출.

- [ ] **Step 1: 곡선 스케일 단위 테스트 작성 (RED)**

`crates/controller/src/grpc/coordinator.rs`의 기존 `mod tests` 안(reduce 관련 인라인 테스트 근처)에 추가:

```rust
#[test]
fn reduce_pool_profile_scales_vu_stages_proportionally() {
    // peak 50, weights [5,25] (worker 0 gets 5 VUs, worker 1 gets 25 at peak).
    // stage targets [50, 10] → worker0 [5,1], worker1 [25,9] (proportional_split per stage; Σ==stage.target).
    let mk = |stages: Vec<(u32, u32)>| pb::Profile {
        vu_stages: stages
            .into_iter()
            .map(|(t, d)| pb::Stage { target: t, duration_seconds: d })
            .collect(),
        ..Default::default()
    };
    let weights = [5u32, 25u32];

    let mut w0 = mk(vec![(50, 10), (10, 10)]);
    reduce_pool_profile(&mut w0, 0, 2, 5, Some(&weights));
    assert_eq!(
        w0.vu_stages.iter().map(|s| s.target).collect::<Vec<_>>(),
        vec![5, 1],
        "worker0 peak stage == its weight (5); sub-peak proportional"
    );
    // max scaled stage == vu_count (slab size / offset parity, R3)
    assert_eq!(w0.vu_stages.iter().map(|s| s.target).max().unwrap(), 5);
    assert!(w0.max_in_flight.is_none(), "curve arm must NOT set max_in_flight");

    let mut w1 = mk(vec![(50, 10), (10, 10)]);
    reduce_pool_profile(&mut w1, 1, 2, 25, Some(&weights));
    assert_eq!(
        w1.vu_stages.iter().map(|s| s.target).collect::<Vec<_>>(),
        vec![25, 9]
    );
    // Σ per stage == original stage target
    assert_eq!(w0.vu_stages[0].target + w1.vu_stages[0].target, 50);
    assert_eq!(w0.vu_stages[1].target + w1.vu_stages[1].target, 10);
}

#[test]
fn reduce_pool_profile_curve_none_weights_even_split() {
    // force/legacy path: slot_weights None → shard_split even split.
    let mut p = pb::Profile {
        vu_stages: vec![pb::Stage { target: 10, duration_seconds: 5 }],
        ..Default::default()
    };
    reduce_pool_profile(&mut p, 0, 2, 5, None);
    assert_eq!(p.vu_stages[0].target, shard_split(10, 2, 0).1);
    assert!(p.max_in_flight.is_none());
}

#[test]
fn reduce_pool_profile_single_worker_curve_noop() {
    // shard_count <= 1 → early return, vu_stages untouched (byte-identical, R11).
    let mut p = pb::Profile {
        vu_stages: vec![pb::Stage { target: 50, duration_seconds: 10 }],
        ..Default::default()
    };
    reduce_pool_profile(&mut p, 0, 1, 50, Some(&[50]));
    assert_eq!(p.vu_stages[0].target, 50, "shard_count==1 → unchanged");
}
```

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-controller --lib reduce_pool_profile 2>&1 | tail -20`
Expected: 컴파일 에러 `cannot find function reduce_pool_profile`(아직 개명 전) — 이게 RED.

- [ ] **Step 3: 개명 + 곡선 arm 구현**

`coordinator.rs:896-923`의 `fn reduce_open_loop_profile`을 다음으로 교체(개명 + early-return 가드 확장 + 2-arm):

```rust
/// Reduce a pooled worker's per-shard Profile: open-loop slot/rate split OR
/// closed-loop VU-curve stage scaling. Pure mutation. `slot_weights` = the full
/// per-worker count vector (vu_count per shard), derived by `assignment_for` from
/// `precomputed_counts`; `None` = legacy/force/non-pool even split.
fn reduce_pool_profile(
    profile: &mut pb::Profile,
    shard_index: u32,
    shard_count: u32,
    vu_count: u32,
    slot_weights: Option<&[u32]>,
) {
    let is_open_loop = profile.target_rps.is_some() || !profile.stages.is_empty();
    let is_curve = !profile.vu_stages.is_empty();
    if shard_count <= 1 || (!is_open_loop && !is_curve) {
        return;
    }
    if is_open_loop {
        // ── open-loop arm (L4, unchanged) ──
        profile.max_in_flight = Some(vu_count);
        if let Some(total) = profile.target_rps {
            profile.target_rps = Some(match slot_weights {
                Some(w) => shard::proportional_split_min1(total, w)[shard_index as usize],
                None => shard_split(total, shard_count, shard_index).1,
            });
        }
        for s in &mut profile.stages {
            s.target = match slot_weights {
                Some(w) => shard::proportional_split(s.target, w)[shard_index as usize],
                None => shard_split(s.target, shard_count, shard_index).1,
            };
        }
    } else {
        // ── closed-loop VU-curve arm (L5): scale each stage.target only.
        // 0-share is harmless (engine parks a 0-VU stage; no .max(1) over-fire —
        // run_scenario_vu_curve has no min-1 floor). Do NOT touch max_in_flight.
        for s in &mut profile.vu_stages {
            s.target = match slot_weights {
                Some(w) => shard::proportional_split(s.target, w)[shard_index as usize],
                None => shard_split(s.target, shard_count, shard_index).1,
            };
        }
    }
}
```

- [ ] **Step 4: call site + 인라인 테스트 심볼 개명**

`reduce_open_loop_profile` 참조는 **총 13곳**(def + `assignment_for` call site ~612 + 인라인 테스트 11곳 ~1631/1633/1641/1650/1679/1681/1693·~2410/2413/2421/2429/2437). "2곳"만 고치고 멈추지 말 것 — **grep로 전부** `reduce_pool_profile`로 개명:

Run: `grep -rn "reduce_open_loop_profile" crates/`
Expected: 출력 없음(전부 개명됨).

- [ ] **Step 5: GREEN 확인**

Run: `cargo test -p handicap-controller --lib reduce_pool_profile 2>&1 | tail -20`
Expected: 3개 신규 테스트 + 기존 open-loop 분배 테스트 전부 PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/controller/src/grpc/coordinator.rs
git commit -m "feat(lan-l5): reduce_pool_profile rename + curve vu_stages proportional scale (R2,R3)"
```

---

## Task 2: active-VU worker_id 머지 (R4, R13) — migration 0018 + read SUM

A3b `run_metrics` worker_id 패턴(migration 0008)을 `run_active_vu_metrics`에 그대로 미러. seam(migration↔read)이라 한 커밋. N=1 출력 byte-identical.

**Files:**
- Create: `crates/controller/src/store/migrations/0018_run_active_vu_metrics_worker_id.sql` (정의 참고용 주석)
- Modify: `crates/controller/src/store/mod.rs` (`ensure_active_vu_worker_id` + connect() 배선)
- Modify: `crates/controller/src/store/metrics.rs` (`ActiveVuRow.worker_id` + insert + read SUM + 테스트)
- Modify: `crates/controller/src/grpc/coordinator.rs` (ingest ~1307 `ActiveVuRow` 리터럴에 worker_id)

**Interfaces:**
- Consumes: `batch.worker_id`(`pb::MetricBatch`, 기존 — run_metrics ingest가 이미 사용 coordinator.rs:1229).
- Produces: `ActiveVuRow { run_id, ts_second, desired, actual, worker_id }`(필드 1개 추가); `active_vu_series`는 ts_second당 1행(SUM 머지) 반환.

- [ ] **Step 1: store 테스트 작성 (RED)**

`crates/controller/src/store/metrics.rs`의 `mod tests` 안에 추가(기존 active_vu 테스트 ~807 근처):

```rust
#[tokio::test]
async fn active_vu_worker_id_rows_coexist_and_sum() {
    let db = pool().await; // 기존 헬퍼 (metrics.rs:402; 기존 active_vu 테스트 :804가 이걸 씀)
    // run_active_vu_metrics는 FK 없음(0016 sql에 REFERENCES 없음) → run row 선행 불요.
    // 두 워커가 같은 (run, second)에 desired/actual 보고 → 공존 + SUM.
    insert_active_vu_batch(
        &db,
        &[ActiveVuRow { run_id: "r1".into(), ts_second: 5, desired: 12, actual: 11, worker_id: "w-a".into() }],
    ).await.unwrap();
    insert_active_vu_batch(
        &db,
        &[ActiveVuRow { run_id: "r1".into(), ts_second: 5, desired: 28, actual: 27, worker_id: "w-b".into() }],
    ).await.unwrap();
    let out = active_vu_series(&db, "r1").await.unwrap();
    assert_eq!(out.len(), 1, "SUM merge → one row per ts_second");
    assert_eq!(out[0].ts_second, 5);
    assert_eq!(out[0].desired, 40, "12 + 28");
    assert_eq!(out[0].actual, 38, "11 + 27");
}

#[tokio::test]
async fn active_vu_n1_byte_identical_output() {
    let db = pool().await;
    // single worker → SUM over 1 row == the value itself (byte-identical, R11).
    insert_active_vu_batch(
        &db,
        &[ActiveVuRow { run_id: "r1".into(), ts_second: 3, desired: 7, actual: 6, worker_id: "w-a".into() }],
    ).await.unwrap();
    // keep-last per worker: re-send same (run,sec,worker) updates in place.
    insert_active_vu_batch(
        &db,
        &[ActiveVuRow { run_id: "r1".into(), ts_second: 3, desired: 9, actual: 8, worker_id: "w-a".into() }],
    ).await.unwrap();
    let out = active_vu_series(&db, "r1").await.unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!((out[0].desired, out[0].actual), (9, 8), "keep-last per worker");
}
```

> **함정**: 기존 active_vu 테스트(`active_vu_insert_and_read_upserts_keep_last`, metrics.rs:804)가 `pool()`(metrics.rs:402)로 in-memory DB를 만든다 — `run_active_vu_metrics`는 **FK 없음**(0016 sql에 `REFERENCES` 없음)이라 run row 선행 불요. 그 테스트 패턴 그대로.

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-controller --lib active_vu 2>&1 | tail -20`
Expected: 컴파일 에러 `missing field worker_id`(ActiveVuRow에 아직 없음) — RED.

- [ ] **Step 3: migration 0018 — `ensure_active_vu_worker_id`**

`crates/controller/src/store/migrations/0018_run_active_vu_metrics_worker_id.sql` 생성(참고 주석 — 실제 reshape는 Rust):

```sql
-- migration 0018: add worker_id to run_active_vu_metrics PK (multi-worker VU curve).
-- Reshape is Rust-guarded (ensure_active_vu_worker_id) like run_metrics (0008) —
-- this file documents the target shape. Per-worker keep-last; read-time SUM merges.
-- CREATE TABLE run_active_vu_metrics (
--   run_id TEXT NOT NULL, ts_second INTEGER NOT NULL,
--   worker_id TEXT NOT NULL DEFAULT '', desired INTEGER NOT NULL, actual INTEGER NOT NULL,
--   PRIMARY KEY (run_id, ts_second, worker_id));
```

`crates/controller/src/store/mod.rs`에 `ensure_run_metrics_worker_id`(90-149) 미러 추가:

```rust
/// migration 0018 (Rust-guarded): add worker_id to run_active_vu_metrics PK so
/// multi-worker VU curves don't clobber (read-time SUM merges). Mirrors
/// ensure_run_metrics_worker_id (0008). Idempotent — detect column first.
async fn ensure_active_vu_worker_id(db: &Db) -> anyhow::Result<()> {
    let has_col: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('run_active_vu_metrics') WHERE name = 'worker_id'",
    )
    .fetch_one(db)
    .await?;
    if has_col != 0 {
        return Ok(());
    }
    let mut tx = db.begin().await?;
    sqlx::query(
        "CREATE TABLE run_active_vu_metrics_v2 ( \
           run_id    TEXT    NOT NULL, \
           ts_second INTEGER NOT NULL, \
           worker_id TEXT    NOT NULL DEFAULT '', \
           desired   INTEGER NOT NULL, \
           actual    INTEGER NOT NULL, \
           PRIMARY KEY (run_id, ts_second, worker_id) \
         )",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO run_active_vu_metrics_v2 (run_id, ts_second, worker_id, desired, actual) \
         SELECT run_id, ts_second, '', desired, actual FROM run_active_vu_metrics",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("DROP TABLE run_active_vu_metrics")
        .execute(&mut *tx)
        .await?;
    sqlx::query("ALTER TABLE run_active_vu_metrics_v2 RENAME TO run_active_vu_metrics")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
```

connect()의 0016/0017 execute 라인 근처(~78)에 배선:

```rust
    ensure_active_vu_worker_id(&pool).await?; // migration 0018 (Rust-guarded; see fn)
```

> **함정**: `run_active_vu_metrics`는 다른 테이블에서 `REFERENCES` 안 됨(grep으로 확인) + 인덱스 없음(0016 sql 참고) → run_metrics와 달리 인덱스 재생성 불요. `ensure_*`는 `connect()` 단일스레드 startup 안이라 안전(0008 SAFETY 주석 참고). const+execute가 아니라 ensure_fn이므로 `grep -c MIGRATION_SQL` 교차검증과 무관(`ensure_*` 계열).

- [ ] **Step 4: `ActiveVuRow.worker_id` + insert + read SUM**

`crates/controller/src/store/metrics.rs`:

`ActiveVuRow`(350-356)에 필드 추가:
```rust
pub struct ActiveVuRow {
    pub run_id: String,
    pub ts_second: i64,
    pub desired: i64,
    pub actual: i64,
    pub worker_id: String, // L5: per-worker keying so N curves' samples coexist; read SUMs.
}
```

`insert_active_vu_batch`(358-376) UPSERT를 worker_id 키로:
```rust
        sqlx::query(
            "INSERT INTO run_active_vu_metrics(run_id,ts_second,worker_id,desired,actual) VALUES(?,?,?,?,?) \
             ON CONFLICT(run_id,ts_second,worker_id) DO UPDATE SET desired=excluded.desired, actual=excluded.actual",
        )
        .bind(&r.run_id)
        .bind(r.ts_second)
        .bind(&r.worker_id)
        .bind(r.desired)
        .bind(r.actual)
        .execute(&mut *tx)
        .await?;
```

`active_vu_series`(378-395) read를 SUM GROUP BY:
```rust
pub async fn active_vu_series(db: &Db, run_id: &str) -> sqlx::Result<Vec<ActiveVuRow>> {
    let rows = sqlx::query(
        "SELECT ts_second, SUM(desired) AS desired, SUM(actual) AS actual \
         FROM run_active_vu_metrics WHERE run_id = ? GROUP BY ts_second ORDER BY ts_second",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| ActiveVuRow {
            run_id: run_id.to_string(),
            ts_second: r.get("ts_second"),
            desired: r.get("desired"),
            actual: r.get("actual"),
            worker_id: String::new(), // aggregated rows carry no single worker_id
        })
        .collect())
}
```

> **함정**: `SUM(...)`은 sqlite에서 INTEGER 반환이지만 sqlx가 `r.get::<i64,_>("desired")`로 읽으려면 컬럼 별칭(`AS desired`)이 있어야 한다(별칭 없으면 `SUM(desired)`가 컬럼명). 빈 그룹은 없음(GROUP BY는 존재 행만).

- [ ] **Step 5: ingest worker_id**

`crates/controller/src/grpc/coordinator.rs`의 active_vu ingest(~1304-1312) `ActiveVuRow` 리터럴에 worker_id 추가:
```rust
        .map(|s| crate::store::metrics::ActiveVuRow {
            run_id: batch.run_id.clone(),
            ts_second: s.ts_second,
            desired: s.desired as i64,
            actual: s.actual as i64,
            worker_id: batch.worker_id.clone(), // L5: per-worker keying (run_metrics:1229 동형)
        })
```

- [ ] **Step 6: 다른 `ActiveVuRow {` 리터럴 사이트 컴파일 fix**

Run: `grep -rn "ActiveVuRow {" crates/`
나오는 모든 리터럴 사이트(테스트 픽스처 포함)에 `worker_id` 필드 추가(컴파일러가 missing field로 잡음). build_report read 경로는 `active_vu_series` 반환을 그대로 매핑하므로 추가 변경 없음(worker_id 무시).

- [ ] **Step 7: GREEN 확인 + 전체 빌드**

```bash
cargo build -p handicap-worker --bin worker   # cold-build flake 예방 (워커 워밍)
cargo test -p handicap-controller --lib active_vu 2>&1 | tail -20
cargo build --workspace --tests 2>&1 | tail -5   # 모든 ActiveVuRow 리터럴 컴파일
```
Expected: active_vu 테스트 PASS + workspace 컴파일 0 에러.

- [ ] **Step 8: Commit**

```bash
git add crates/controller/src/store/mod.rs crates/controller/src/store/metrics.rs crates/controller/src/store/migrations/0018_run_active_vu_metrics_worker_id.sql crates/controller/src/grpc/coordinator.rs
git commit -m "feat(lan-l5): active-vu worker_id merge — migration 0018 + read SUM (R4,R13)"
```

---

## Task 3: 가드 fork 곡선 포함 + validate pool-gate + force fan-out + 예약-시점 unique floor (R1, R5, R6, R7, R14)

`spawn_run`이 곡선을 capacity-aware 경로로 보내고, validate가 풀 곡선의 단일워커 거부를 생략하며, force 곡선이 even-split하고, 예약 후 unique 빈-슬라이스를 거부한다. 통합 테스트로 검증.

**Files:**
- Modify: `crates/controller/src/api/runs.rs` (`spawn_run` 509/649/705 가드 + 예약-후 unique floor; `validate_run_config` 254 pool-gate)
- Test: `crates/controller/tests/pool_vu_curve_capacity_test.rs` (신규 — `pool_capacity_guard_test.rs`/`pool_open_loop_capacity_test.rs` 미러)

**Interfaces:**
- Consumes: `profile.is_vu_curve()`/`concurrency_demand()`/`pool_worker_cap()`/`vu_curve_max()`(store/runs.rs, 곡선=peak), `state.coord.is_pool_mode()`, `reserve_idle_pool_capacity(run_id, worker_cap, slot_total) -> PoolReservation`, `reserve_idle_pool(run_id, n) -> Vec<...>`, `pool_achievable_capacity(worker_cap) -> (idle, achievable)`, `ApiError::ConflictJson`/`BadRequest`, `assignment.data_bindings: Vec<pb::DataBinding>`.
- Produces: (없음 — 핸들러 동작 변경만)

- [ ] **Step 1: 통합 테스트 작성 (RED)**

**픽스처는 `pool_capacity_guard_test.rs`의 헬퍼를 그대로 복사**(실 워커 subprocess + MockServer 기반·multi_thread 테스트): `worker_bin_path`/`bind_local`/`boot_pool(coord, db, grpc_listener, rest_listener)`/`spawn_pool_worker_with_cap(worker_bin, grpc_addr, capacity_vus)`/`wait_idle(coord, n, timeout, label)`/`create_scenario`/`run_count`. **곡선 run 생성**은 `POST /api/runs`에 곡선 프로파일을 보냄(closed-fixed의 `vus` 대신):
```rust
// 곡선 run 페이로드 헬퍼 (이 파일에 추가)
fn vu_curve_profile_json(stages: &[(u32, u32)]) -> Value {
    json!({
        "duration_seconds": 0,
        "vu_stages": stages.iter().map(|(t, d)| json!({"target": t, "duration_seconds": d})).collect::<Vec<_>>(),
    })
}
// 사용: http.post("/api/runs").json(&json!({"scenario_id": sid, "profile": vu_curve_profile_json(&[(28,5)]), "env": {}}))
//   force는 .query(&[("force","true")]). 409는 res.status()==409 + res.json()["achievable_vus"].
```
`crates/controller/tests/pool_vu_curve_capacity_test.rs`를 그 패턴으로 작성(각 테스트는 `#[tokio::test(flavor="multi_thread", worker_threads=4)]`, `spawn_pool_worker_with_cap`로 cap 명시·`wait_idle`로 등록 대기 후 run 생성):

```rust
// 미러 소스: pool_capacity_guard_test.rs (closed-fixed) / pool_open_loop_capacity_test.rs (open).
// 곡선 프로파일 = vus:0, duration:0, vu_stages:[{target,duration}], target_rps:None, max_in_flight:None.

// R5: peak > achievable → 409 {achievable_vus, requested_vus=peak}, run row 미생성.
#[tokio::test]
async fn pool_vu_curve_insufficient_returns_409() { /* 2 워커 cap[5,5]=10, 곡선 peak 50 →
    spawn_run Err(ConflictJson{achievable_vus:10, requested_vus:50}); runs::get(id)==None */ }

// R1: peak <= achievable → capacity-aware fan-out (각 워커 ≤ cap, Σ peak 몫 == peak).
#[tokio::test]
async fn pool_vu_curve_assigns_capacity_aware() { /* 워커 cap[5,25], 곡선 peak 28 →
    201; register 두 워커가 precomputed (vu_offset, vu_count) 받음·Σ==28·각≤cap */ }

// R6: ?force + peak > achievable → even-split fan-out (201, no 409).
#[tokio::test]
async fn pool_vu_curve_force_skips_guard() { /* cap[5,5], peak 50, force:true → 201;
    두 워커가 shard_split 균등 vu_count 받음(곡선 N=1 아님) */ }

// R5: 빈 풀(idle 0) → 기존 빈-풀 400 (409 아님).
#[tokio::test]
async fn pool_vu_curve_zero_idle_400() { /* 풀 워커 0대, 곡선 → BadRequest, not ConflictJson */ }

// R14: 풀 곡선 + unique + rows < n_pool → 거부 (mark_failed). closed-fixed도 동형.
#[tokio::test]
async fn pool_unique_rows_lt_workers_rejected() { /* 워커 cap[5,25] (n_pool=2), unique dataset rows=1,
    곡선 peak 28 → spawn_run Err (rows=1 < workers=2); closed-fixed vus 28도 동일 */ }

// R14 반례: rows >= n_pool → 정상 (no impact).
#[tokio::test]
async fn pool_unique_rows_ge_workers_ok() { /* unique rows=10, n_pool=2 → 201 */ }
```

> **함정**: 통합 e2e는 집계/status/run-row만 관측 가능 — per-worker 정확 분배는 Task 1 인라인 단위가 소유. 여기선 409 본문 숫자·`runs::get` None·201·400 분기를 단언. unique 거부는 `validated_metas`+dataset 픽스처가 필요(`datasets_binding_integration_test.rs`의 dataset seed 패턴 참고).

- [ ] **Step 2: RED 확인**

Run: `cargo build -p handicap-worker --bin worker && cargo test -p handicap-controller --test pool_vu_curve_capacity_test 2>&1 | tail -25`
Expected: 곡선이 아직 N=1 legacy라 `pool_vu_curve_insufficient_returns_409`가 FAIL(409 대신 201/다른 경로) — RED. (일부는 컴파일 후 assertion fail.)

- [ ] **Step 3: precheck 가드 곡선 포함 (R5)**

`runs.rs:509` precheck 조건에서 `!profile.is_vu_curve()` 제거:
```rust
    // L3/L4/L5: pool capacity precheck (before any DB insert → 409 leaves no run row).
    // Covers closed-loop, open-loop (fixed+curve), AND closed-loop VU curve.
    if state.coord.is_pool_mode() && !force {
        let (idle, achievable) = state
            .coord
            .pool_achievable_capacity(profile.pool_worker_cap())
            .await;
        let demand = profile.concurrency_demand();
        if idle > 0 && demand > achievable {
            return Err(ApiError::ConflictJson(serde_json::json!({
                "achievable_vus": achievable,
                "requested_vus": demand,
            })));
        }
    }
```

- [ ] **Step 4: dispatch fork 곡선 guarded + force fan-out (R1, R6)**

`runs.rs:649` `let guarded = !profile.is_vu_curve();` → `let guarded = true;`
`runs.rs:705` legacy 경로 `n_cap` 곡선 분기 `1` → `vu_curve_max()`:
```rust
            let n_cap: usize = if profile.is_vu_curve() {
                profile.vu_curve_max() as usize   // R6: force curve fans out (even-split), was 1
            } else if profile.is_open_loop() {
                // ... (기존 open-loop 그대로)
```

> 곡선 non-force는 이제 `guarded` 경로 → `reserve_idle_pool_capacity(pool_worker_cap()=peak, concurrency_demand()=peak)` → `enqueue(..., Some(counts))` → `assignment_for`가 precomputed_counts에서 slot_weights 도출 → `reduce_pool_profile` 곡선 arm(Task 1). 추가 코드 없음(L4 guarded 분기 재사용).

- [ ] **Step 5: 예약-시점 unique floor (R14)**

`runs.rs` `spawn_run`의 풀 경로에서, 예약으로 `n_pool`을 안 직후(guarded `Reserved{workers}` 분기 ~683와 legacy `reserved` 분기 ~724 **둘 다**), `enqueue` *전*에 unique floor 검사. 공유 헬퍼로:

```rust
// 풀 경로 두 분기 공통 — n_pool 직후 호출. assignment.data_bindings에서 unique row_count 읽음
// (로컬 data_bindings는 line 624에서 assignment로 move, validated_metas는 538 zip으로 소비).
fn pool_unique_floor_violation(assignment: &PendingAssignment, n_pool: u32) -> Option<(u64, u32)> {
    assignment.data_bindings.iter().find_map(|b| {
        // PendingDataBinding.policy is the Policy ENUM (coordinator.rs:47), not i32 —
        // compare to the enum variant directly (no `as i32`). row_count is u64.
        if b.policy == pb::data_binding::Policy::Unique && b.row_count < n_pool as u64 {
            Some((b.row_count, n_pool))
        } else {
            None
        }
    })
}
```

각 분기에서:
```rust
                    let n_pool = workers.len() as u32; // (guarded) / reserved.len() (legacy)
                    if let Some((rows, n)) = pool_unique_floor_violation(&assignment, n_pool) {
                        let msg = format!(
                            "unique 데이터셋 행 수가 풀 워커 수보다 적습니다: rows={rows} < workers={n}"
                        );
                        state.coord.cancel_dispatch_failed(&row.id).await;
                        runs::mark_failed(&state.db, &row.id, &msg).await?;
                        return Err(ApiError::BadRequest(msg));
                    }
```

> **함정**: `assignment`는 `enqueue`(686/733)에서 move되므로 검사는 enqueue *전*. `PendingDataBinding.policy`는 **enum**(`coordinator.rs:47`)이라 `== Policy::Unique`(no `as i32` — proto wire `DataBinding.policy`만 i32). 두 분기(guarded/legacy) 모두 배선해야 force도 커버. **R14 SHOULD(insert-전 best-effort precheck로 409 no-row)는 v1 미구현·연기** — 여기 MUST(예약-시점 floor, mark_failed) 하나만; precheck 추가는 후속(spec §4.1 SHOULD).

- [ ] **Step 6: validate 254 pool-gate (R7)**

`runs.rs:254` 단일워커 거부에 pool-gate:
```rust
            if !state.coord.is_pool_mode() && s.target > capacity {
                return Err(ApiError::BadRequest(format!(
                    "최대 목표 VU {}가 워커 용량 {capacity}을 초과합니다 \
                     (vu_stages는 단일 워커 — 멀티워커 곡선 샤딩 미지원, spec §9)",
                    s.target
                )));
            }
```
다른 곡선 검증(stage duration·≥1 target>0)은 무변경.

- [ ] **Step 7: validate pool-gate 단위 테스트**

`runs.rs`의 인라인 `mod tests`(validate 관련)에 추가:
```rust
// 헬퍼: 곡선 Profile 빌더 (이 mod tests에 추가, 기존 Profile literal 패턴 참고).
fn vu_curve_profile(stages: Vec<(u32, u32)>) -> Profile {
    Profile {
        vu_stages: Some(stages.into_iter().map(|(t, d)| Stage { target: t, duration_seconds: d }).collect()),
        ..base_profile() // 기존 테스트의 default Profile 헬퍼 (vus:0·duration:0)
    }
}

#[tokio::test]
async fn validate_vu_curve_pool_defers_to_guard() {
    // pool mode: peak > worker_capacity_vus (2000) NOT rejected at validate (409 at spawn_run).
    let state = state_with(...).await;     // 기존 헬퍼 (runs.rs:1113) — DB + 기본 capacity
    state.coord.set_pool_mode(true);       // coordinator.rs:235
    let p = vu_curve_profile(vec![(5000, 10)]); // peak 5000 > 2000
    assert!(validate_run_config(&state, &p).await.is_ok());
}
#[tokio::test]
async fn validate_vu_curve_nonpool_rejects() {
    let state = state_with(...).await;     // pool mode 미설정(기본 false)
    let p = vu_curve_profile(vec![(5000, 10)]);
    assert!(matches!(validate_run_config(&state, &p).await, Err(ApiError::BadRequest(_))));
}
```
> **함정**: `state_with`(runs.rs:1113)·`coord.set_pool_mode(true)`(coordinator.rs:235)·`base_profile()`(기존 default Profile 헬퍼)는 *실재* — 먼저 그 시그니처를 읽고 `state_with(...)` 인자를 맞춰 채울 것(임의 `state_with_pool_mode` 같은 헬퍼는 없음). `Profile`/`Stage`는 `handicap_engine`(store/runs.rs re-export).

- [ ] **Step 8: GREEN 확인 (통합 + 단위)**

```bash
cargo build -p handicap-worker --bin worker
cargo test -p handicap-controller --test pool_vu_curve_capacity_test 2>&1 | tail -25
cargo test -p handicap-controller --lib validate_vu_curve 2>&1 | tail -10
cargo test -p handicap-controller 2>&1 | tail -15   # 기존 pool/open/closed 통합 회귀 0
```
Expected: 신규 통합 6 + validate 2 PASS, 기존 풀/fan-out 스위트 green(R11 — rows≥N·force 비-곡선 무영향).

- [ ] **Step 9: Commit**

```bash
git add crates/controller/src/api/runs.rs crates/controller/tests/pool_vu_curve_capacity_test.rs
git commit -m "feat(lan-l5): curve pool guard fork + validate pool-gate + force fan-out + unique floor (R1,R5,R6,R7,R14)"
```

---

## Task 4: UI — closed+curve 프리뷰 + 409 다이얼로그 3-way clamp + scaleVuStages (R8, R9, R10, R12)

`ui/`-only. RunDialog closed+curve arm에 용량 프리뷰 over-hint + 409 다이얼로그 곡선 변형(비례 축소 clamp + 자세한 부하-차이 설명). `client.ts`/`hooks.ts`/Zod는 L3/L4 그대로 재사용(0-diff).

**Files:**
- Create: `ui/src/components/__tests__/scaleVuStages.test.ts` (TDD 먼저 — pending diff)
- Modify: `ui/src/components/sizing.ts` (`scaleVuStages` 순수 함수)
- Modify: `ui/src/components/RunDialog.tsx` (프리뷰 over-hint closed+curve · 409 clamp 3-way)
- Modify: `ui/src/i18n/ko.ts` (`capacityGuard` 곡선 변형)
- Test: `ui/src/components/__tests__/RunDialog.test.tsx` (기존 풀 테스트 파일에 곡선 케이스 추가)

**Interfaces:**
- Consumes: `peakStageTarget(stages)`(`sizing.ts` 기존 — 유효 stage.target 최대), `PoolCapacityError {achievable, requested}`(`client.ts` 기존), `buildProfile()`(RunDialog 내부 — closed+curve면 `vu_stages` emit), `ko.capacityGuard.*`.
- Produces: `scaleVuStages(stages: {target:string; duration_seconds:string}[], achievable: number, peak: number): {target:string; duration_seconds:string}[]`.

> **TDD-guard 순서**: `ui/src/**` src 편집 전에 test 파일이 pending이어야 함(루트 C-1). **Step 1에서 `__tests__/scaleVuStages.test.ts`를 먼저 작성**(pending RED diff 생성) → 이후 sizing.ts/RunDialog/ko.ts src 편집 unblock.

- [ ] **Step 1: `scaleVuStages` 단위 테스트 작성 (RED, pending diff 생성)**

`ui/src/components/__tests__/scaleVuStages.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { scaleVuStages } from "../sizing";

describe("scaleVuStages", () => {
  it("scales all stage targets by achievable/peak, preserving shape", () => {
    // peak 50, achievable 30 → factor 0.6: [50,20] → [30,12]
    const out = scaleVuStages(
      [{ target: "50", duration_seconds: "10" }, { target: "20", duration_seconds: "10" }],
      30, 50,
    );
    expect(out.map((s) => s.target)).toEqual(["30", "12"]);
    expect(out.map((s) => s.duration_seconds)).toEqual(["10", "10"]); // duration untouched
  });
  it("floors the peak stage at >=1 so at least one target stays positive", () => {
    // tiny achievable: peak 100, achievable 1 → factor 0.01, peak stage rounds to 1 (not 0)
    const out = scaleVuStages([{ target: "100", duration_seconds: "5" }], 1, 100);
    expect(out[0].target).toBe("1");
  });
  it("rounds each stage (not floor)", () => {
    const out = scaleVuStages([{ target: "10", duration_seconds: "5" }], 3, 10); // 10*0.3=3
    expect(out[0].target).toBe("3");
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/lan-workers-l5-closed-curve-guard/ui && pnpm test scaleVuStages 2>&1 | tail -15`
Expected: FAIL `scaleVuStages is not a function` (sizing.ts에 아직 없음).

- [ ] **Step 3: `scaleVuStages` 구현**

`ui/src/components/sizing.ts`에 추가:
```ts
/** Proportionally scale a VU curve so its peak == achievable (capacity clamp).
 * Each stage.target *= achievable/peak, rounded; the largest stage is floored at
 * >=1 so the curve never collapses to all-zero (engine rejects no-positive-stage).
 * Strings in/out (RunDialog stage rows are string-draft). */
export function scaleVuStages(
  stages: { target: string; duration_seconds: string }[],
  achievable: number,
  peak: number,
): { target: string; duration_seconds: string }[] {
  const factor = peak > 0 ? achievable / peak : 0;
  return stages.map((s) => {
    const t = Number(s.target);
    const scaled = Number.isFinite(t) ? Math.round(t * factor) : 0;
    // peak stage floor: the stage equal to peak must stay >=1.
    const floored = t === peak ? Math.max(scaled, 1) : scaled;
    return { target: String(floored), duration_seconds: s.duration_seconds };
  });
}
```

- [ ] **Step 4: GREEN 확인**

Run: `pnpm test scaleVuStages 2>&1 | tail -10`
Expected: 3 PASS.

- [ ] **Step 5: `ko.capacityGuard` 곡선 변형 (R10 자세한 설명)**

`ui/src/i18n/ko.ts`의 `capacityGuard`(160-185)에 곡선 변형 키 추가(제품요구 `load-divergence-explain-confirm` — 실제 부하가 어떻게 달라지는지 명시):
```ts
    // L5 곡선(VU curve) 변형 — 줄여 진행=곡선 비례 축소, 강행=과부하.
    dialogBodyCurve: (achievable: number, requested: number) =>
      `연결된 풀 워커 용량은 ${achievable} VU인데 설정한 곡선 최고점은 ${requested} VU입니다. ` +
      `이 부하를 어떻게 발생시킬지 선택하세요.`,
    clampNoteCurve: (achievable: number, requested: number) =>
      `[줄여서 발생] 곡선을 ${achievable}/${requested}배로 축소 → 최고점 ${achievable} VU·각 단계가 비례로 낮아집니다(설정보다 낮은 부하). ` +
      `[그대로 강행] 워커가 과부하되어 실제 발생 부하가 목표(${requested} VU)에 못 미칠 수 있습니다.`,
    clampCurve: (achievable: number) => `줄여서 발생 (최고점 ${achievable} VU로 축소)`,
    overHintCurve: (cap: number) =>
      `곡선 최고점이 풀 유휴 용량 ${cap} VU를 초과합니다 — 실행 시 줄이거나 강행을 선택하게 됩니다.`,
```
> **함정**: `aria-label`/문구 전부 ko 경유(인라인 영어 0). 기존 `dialogBody`/`clampNote`/`clamp`/`overHint`(closed-fixed)·`*Open`(L4) 키는 무변경.

- [ ] **Step 6: RunDialog 프리뷰 over-hint closed+curve (R8)**

`ui/src/components/RunDialog.tsx`의 프리뷰 IIFE(542-568)에 곡선 분기. `closedCurve` + `peakStageTarget(stages)` 기준:
```tsx
            const closedFixed = loadModel === "closed" && rateMode === "fixed";
            const closedCurve = loadModel === "closed" && rateMode === "curve";
            const isOpenLoop = loadModel === "open";
            const curvePeak = closedCurve ? peakStageTarget(stages) : null; // number | null
            const overClosed = closedFixed && Number(vus) > idleCapacity;
            const overOpen =
              isOpenLoop && maxInFlight.trim() !== "" && Number(maxInFlight) > idleCapacity;
            const overCurve = closedCurve && curvePeak != null && curvePeak > idleCapacity;
            const over = overClosed || overOpen || overCurve;
```
over-hint 렌더 분기에 곡선 추가:
```tsx
                  <p className="text-sm text-amber-700" role="status">
                    {overCurve
                      ? ko.capacityGuard.overHintCurve(idleCapacity)
                      : overOpen
                      ? ko.capacityGuard.overHintOpen(idleCapacity)
                      : ko.capacityGuard.overHint(idleCapacity)}
                  </p>
```
> **함정**: `peakStageTarget`은 `sizing.ts`에서 import(open+curve 슬롯 힌트가 이미 쓰는 함수). `stages`는 RunDialog의 string-draft state.

- [ ] **Step 7: 409 다이얼로그 3-way clamp (R9, FR3)**

`RunDialog.tsx` 409 다이얼로그(808-873)를 3-way로. `isCurve` 추가 + clamp 분기 + 곡선 body/note/label:
```tsx
            const isOpenLoop = loadModel === "open";
            const isCurve = loadModel === "closed" && rateMode === "curve";
```
body(818-825):
```tsx
                <p className="mb-3">
                  {isCurve
                    ? ko.capacityGuard.dialogBodyCurve(poolConflict.achievable, poolConflict.requested)
                    : isOpenLoop
                    ? ko.capacityGuard.dialogBodyOpen(poolConflict.achievable, poolConflict.requested)
                    : ko.capacityGuard.dialogBody(poolConflict.achievable, poolConflict.requested)}
                </p>
                {isCurve ? (
                  <p className="mb-3 text-xs">
                    {ko.capacityGuard.clampNoteCurve(poolConflict.achievable, poolConflict.requested)}
                  </p>
                ) : isOpenLoop ? (
                  <p className="mb-3 text-xs">{ko.capacityGuard.clampNoteOpen}</p>
                ) : null}
```
clamp 핸들러(832-835) 3-way:
```tsx
                      const built = buildProfile();
                      const clamped = isCurve
                        ? {
                            ...built,
                            vu_stages: scaleVuStages(
                              stages, // RunDialog string-draft stage rows
                              poolConflict.achievable,
                              poolConflict.requested, // = peak
                            ).map((s) => ({
                              target: Number(s.target),
                              duration_seconds: Number(s.duration_seconds),
                            })),
                          }
                        : isOpenLoop
                        ? { ...built, max_in_flight: poolConflict.achievable }
                        : { ...built, vus: poolConflict.achievable };
```
clamp 버튼 라벨(844-846):
```tsx
                    {isCurve
                      ? ko.capacityGuard.clampCurve(poolConflict.achievable)
                      : isOpenLoop
                      ? ko.capacityGuard.clampOpen(poolConflict.achievable)
                      : ko.capacityGuard.clamp(poolConflict.achievable)}
```
> **함정**: `scaleVuStages`는 string in/out인데 `buildProfile`의 `vu_stages`는 number — clamp에서 `Number()` 변환(`buildLoadProfile`의 closed+curve emit 형태와 맞춤, ui/CLAUDE.md "곡선 payload"). `import { scaleVuStages, peakStageTarget } from "./sizing"`.

- [ ] **Step 8: RunDialog 곡선 RTL 테스트**

기존 RunDialog 풀 테스트 파일(`__tests__/`)에 곡선 케이스 추가:
```tsx
it("clamps a VU curve proportionally on 409 (줄여 진행)", async () => {
  // closed+curve 모드 + 409 mock (PoolCapacityError{achievable:30, requested:50}) →
  // 다이얼로그 [줄여서 발생] 클릭 → 2번째 createRun payload.vu_stages peak === 30,
  //   target_rps/max_in_flight 미주입, vus 0. (URL-필터 call-count로 run 생성만 셈)
});
it("shows curve over-hint when peak exceeds idle capacity (R8)", async () => {
  // closed+curve, peak 50 > idleCapacity 30 → ko.capacityGuard.overHintCurve 문구 존재
});
it("does NOT show capacity dialog for a curve within capacity (정상 fan-out, R10)", async () => {
  // closed+curve peak 28 <= 30 → 201, alertdialog 미표시
});
```
> **함정**: ui/CLAUDE.md "구조화된 에러 본문 409" — `mutation.reset()`·`!poolConflict` double-fire 가드·URL-필터 call-count(`url.includes("/api/runs")`)는 L3/L4 패턴 그대로. closed+curve 진입은 부하모드 셀렉터에서 closed 라디오 + 곡선 라디오 + stage 행 입력(`deriveLoadMode`/`buildLoadProfile` closed+curve arm, ui/CLAUDE.md).

- [ ] **Step 9: GREEN + 전체 UI 게이트**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/lan-workers-l5-closed-curve-guard/ui
pnpm test scaleVuStages RunDialog 2>&1 | tail -15   # 타깃
pnpm lint && pnpm test && pnpm build 2>&1 | tail -15  # 전체 게이트 (lint 0·tsc -b·전체 스위트)
```
Expected: 전부 PASS, lint 0 warning, `tsc -b` 0 에러.

- [ ] **Step 10: Commit**

```bash
git add ui/src/components/sizing.ts ui/src/components/RunDialog.tsx ui/src/i18n/ko.ts ui/src/components/__tests__/scaleVuStages.test.ts ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(lan-l5): RunDialog curve capacity preview + 409 proportional clamp + scaleVuStages (R8,R9,R10,R12)"
```

---

## Task 5: 라이브 검증 + finish (R 전반)

run-생성·active-VU read·곡선 엔진 경로를 건드림(S-D 갭) → **라이브 필수**.

- [ ] **Step 1: `/live-verify`로 풀 스택 기동**

워크트리 자체 바이너리로 실 pool 2워커(cap[5,25]=30) 기동:
```bash
cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller
# controller --worker-mode pool / worker 2대 --worker-mode pool --capacity-vus 5 / 25 (런북 docs/dev/lan-workers.md)
```

- [ ] **Step 2: 시나리오별 라이브 단언**
  - ① 곡선 peak 50 → `409 {achievable_vus:30, requested_vus:50}` + `runs::get` None(R5).
  - ② 곡선 peak 28 → fan-out 201 → 완료 후 `/report` `active_vu_series` SUM 차트(desired 원곡선 복원·actual 총합, R4).
  - ③ `?force` peak 50 → 201 over-subscribe even-split(R6).
  - ④ 단일워커 곡선(유휴 1대 or peak≤1워커) → active-VU N=1 출력 byte-identical(R11).
  - ⑤ unique dataset rows=1 + 곡선 peak 28(n_pool 2) → 거부(R14).
  - ⑥ Playwright: closed+curve 프리뷰 over-hint·409 alertdialog 곡선 축소/강행 설명·`scaleVuStages` 폼 stage 재작성·콘솔 Zod 0.

- [ ] **Step 3: 정리 + finish-slice**

`rm -rf .playwright-mcp` + 루트 png 정리. `/finish-slice`: handicap-reviewer(+security-reviewer path-gate: 요청실행/데이터셋 바인딩 매치 → APPROVE 필수) → build-log·roadmap·ADR-0041 §귀결·CLAUDE 상태줄·메모리 → ff-merge → `ExitWorktree(remove, discard_changes:true)`.

---

<!-- 근거: spec-plan-reviewer 2라운드(spec, CRITICAL FR1 포함 직잠) + 1라운드(plan) APPROVE-WITH-FIXES.
     spec 5+2, plan 5+3 dictated 교정을 전부 verbatim 반영(설계 변경 0·전부 텍스트/시그니처 정밀화).
     spec은 사용자 결정(2026-06-22)으로 수렴 간주, plan 마커는 동일 근거. SendMessage(저비용 resume) 미지원으로 3차 풀 리뷰는 생략. -->
<!-- REVIEW-GATE: APPROVED -->

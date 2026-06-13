# Active-VU 초당 시계열 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** closed-loop VU 곡선(`run_scenario_vu_curve`) run의 리포트에 초당 active-VU 시계열(목표 desired + 실제 actual 두 줄)을 추가한다.

**Architecture:** 기존 메트릭 파이프라인(windows/group_stats/phase_stats)을 그대로 미러하는 7-레이어 가산: 슈퍼바이저가 초당 1회 `(desired, actual)` 샘플을 `Aggregator`에 기록 → `MetricFlush.active_vu_samples`(7번째 벡터) → proto `MetricBatch.active_vu_samples=9` → 워커 forward → migration 0016 `run_active_vu_metrics`(UPSERT) → `build_report` 8번째 param → `ReportJson.active_vu_series` → UI `ActiveVuChart`. 곡선 외 경로는 빈 벡터로 흘러 **byte-identical**. 샘플링은 초당 1회(핫패스 밖) → 처리량 무회귀.

**Tech Stack:** Rust(engine/controller/worker, tokio, sqlx, prost/tonic) + TypeScript/React(Zod, Recharts).

**설계 근거(권위 소스):** `docs/superpowers/specs/2026-06-13-active-vu-timeseries-design.md`. 충돌 시 spec 우선.

---

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `crates/engine/src/aggregator.rs` | `ActiveVuSample` 타입 + `Aggregator.active_vu` 맵 + `record_active_vu`/`drain_active_vu` | 1 |
| `crates/engine/src/runner.rs` | `MetricFlush.active_vu_samples` + 슈퍼바이저 초당 샘플 + 6 리터럴/2 send-guard | 2 |
| `crates/engine/tests/vu_curve.rs` | 곡선 run이 active-VU emit하는 통합 테스트 | 2 |
| `crates/proto/proto/coordinator.proto` | `ActiveVuSample` 메시지 + `MetricBatch.active_vu_samples=9` | 3 |
| `crates/worker/src/main.rs` | forwarder 변환 + 스킵-가드 term + `pb::ActiveVuSample` import | 3 |
| `crates/controller/src/store/migrations/0016_run_active_vu_metrics.sql` | 새 테이블 | 4 |
| `crates/controller/src/store/mod.rs` | migration const + execute | 4 |
| `crates/controller/src/store/metrics.rs` | `ActiveVuRow` + `insert_active_vu_batch` + `active_vu_series` | 4·5 |
| `crates/controller/src/grpc/coordinator.rs` | `ingest_metrics`가 active_vu insert | 4 |
| `crates/controller/src/report.rs` | controller `ActiveVuSample` + `ReportJson.active_vu_series` + `build_report` 8th param | 5 |
| `crates/controller/src/api/runs.rs` | `build_report_for_run`가 read+pass | 5 |
| `crates/controller/src/export.rs` | `ReportJson` 픽스처에 `active_vu_series: vec![]` | 5 |
| `crates/controller/tests/` | 곡선 run → report active_vu_series e2e smoke | 6 |
| `ui/src/api/schemas.ts` | `ActiveVuSampleSchema` + `active_vu_series` | 7 |
| `ui/src/components/report/ActiveVuChart.tsx` | 2-라인 차트(목표 점선/실제 실선) | 7 |
| `ui/src/components/report/ReportView.tsx` | 조건부 섹션 | 7 |
| `ui/src/i18n/ko.ts` | 문구 | 7 |
| `crates/engine/CLAUDE.md`·`crates/controller/CLAUDE.md`·`docs/roadmap.md`·`docs/build-log.md` | 함정/상태 갱신 | 8 |

**커밋 경계 규칙(루트 CLAUDE.md):** pre-commit이 cargo-영향 커밋마다 전체 게이트(`build/clippy/test --workspace`)를 돌린다 → **각 태스크는 단일 green 커밋**. RED 테스트만/미사용 헬퍼만 커밋 불가 → 테스트+구현을 한 커밋으로 fold(로컬에선 RED→GREEN 확인하되 커밋 1회). 커밋은 파이프 없이(`git commit` 직접) 후 `git log -1`로 landed 확인. `git commit`은 `run_in_background:false` 단일 호출(폴링 금지).

---

### Task 1: 엔진 — `ActiveVuSample` 타입 + Aggregator record/drain

**Files:**
- Modify: `crates/engine/src/aggregator.rs` (`LoopStat`/`BranchStat` 정의 인근 + `Aggregator` struct + `impl` + inline `mod tests`)

이 태스크는 엔진만 건드리고 `MetricFlush`는 안 건드린다 → 단독 컴파일 green.

- [ ] **Step 1: `ActiveVuSample` 타입 추가**

`crates/engine/src/aggregator.rs`의 `pub struct BranchStat { … }`(현재 33행) 바로 아래에 추가:

```rust
/// One per-second active-VU gauge sample (ADR-0037 follow-up). `desired` = the VU
/// curve's commanded count for that second; `actual` = VUs in their active loop at
/// the sample instant. Run-level (not per-step), curve-only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveVuSample {
    pub ts_second: i64,
    pub desired: u32,
    pub actual: u32,
}
```

- [ ] **Step 2: `Aggregator`에 `active_vu` 필드 추가**

`crates/engine/src/aggregator.rs` 상단에 `use std::collections::BTreeMap;`가 없으면 추가(현재 `HashMap`만 import — 확인 후 `use std::collections::{BTreeMap, HashMap};`로). `Aggregator` struct(현재 132행)의 `phase_hists` 필드 다음에:

```rust
    /// per-second active-VU gauge samples (curve only): ts_second -> (desired, actual).
    /// One entry per second; BTreeMap keeps drain order by ts_second.
    active_vu: BTreeMap<i64, (u32, u32)>,
```

그리고 `Aggregator::new`(현재 146행)의 `phase_hists: HashMap::new(),` 다음에 `active_vu: BTreeMap::new(),` 추가.

- [ ] **Step 3: 실패하는 단위 테스트 작성**

`crates/engine/src/aggregator.rs`의 `#[cfg(test)] mod tests` 안에(기존 `drain_branch_deltas_resets_between_drains` 인근) 추가:

```rust
#[test]
fn active_vu_record_and_drain_orders_and_resets() {
    let mut agg = Aggregator::new(256);
    agg.record_active_vu(100, 3, 2);
    agg.record_active_vu(101, 5, 5);
    agg.record_active_vu(100, 4, 4); // same second overwrites (keep-last)
    let mut out = agg.drain_active_vu();
    out.sort_by_key(|s| s.ts_second);
    assert_eq!(
        out,
        vec![
            ActiveVuSample { ts_second: 100, desired: 4, actual: 4 },
            ActiveVuSample { ts_second: 101, desired: 5, actual: 5 },
        ]
    );
    // drain resets
    assert!(agg.drain_active_vu().is_empty());
}
```

- [ ] **Step 4: 테스트가 실패하는지 확인**

Run: `cargo test -p handicap-engine active_vu_record_and_drain -- --nocapture`
Expected: 컴파일 실패 — `no method named record_active_vu`/`drain_active_vu`.

- [ ] **Step 5: `record_active_vu`/`drain_active_vu` 구현**

`crates/engine/src/aggregator.rs`의 `impl Aggregator` 안, `drain_branch_deltas`(현재 211행) 다음에:

```rust
    /// Record the active-VU gauge for one wall-clock second (keep-last; the supervisor
    /// records each second once). `desired` = commanded curve count, `actual` = live VUs.
    pub fn record_active_vu(&mut self, ts_second: i64, desired: u32, actual: u32) {
        self.active_vu.insert(ts_second, (desired, actual));
    }

    /// Take and reset the accumulated per-second active-VU samples (ascending ts_second).
    pub fn drain_active_vu(&mut self) -> Vec<ActiveVuSample> {
        std::mem::take(&mut self.active_vu)
            .into_iter()
            .map(|(ts_second, (desired, actual))| ActiveVuSample {
                ts_second,
                desired,
                actual,
            })
            .collect()
    }
```

- [ ] **Step 6: 테스트 통과 확인 + lib.rs re-export 확인**

`crates/engine/src/lib.rs`가 `aggregator`의 stat 타입을 어떻게 노출하는지 확인 — `BranchStat`/`GroupStat`가 `pub use`로 re-export돼 있으면 `ActiveVuSample`도 같은 줄에 추가(워커가 `flush.active_vu_samples`로 필드 접근하므로 이름 import는 불필요하나, 일관성 위해 BranchStat이 re-export면 같이).

Run: `cargo test -p handicap-engine active_vu_record_and_drain`
Expected: PASS.

- [ ] **Step 7: 게이트 + 커밋**

Run: `cargo build -p handicap-engine && cargo clippy -p handicap-engine --all-targets -- -D warnings && cargo test -p handicap-engine`
Expected: 전부 green.

```bash
git add crates/engine/src/aggregator.rs crates/engine/src/lib.rs
git commit -m "feat(engine): ActiveVuSample 타입 + Aggregator record/drain_active_vu"
git log -1 --oneline
```

---

### Task 2: 엔진 — `MetricFlush.active_vu_samples` + 슈퍼바이저 초당 샘플

**Files:**
- Modify: `crates/engine/src/runner.rs` (MetricFlush struct ~92행, vu-curve flusher ~694-727, supervisor ~730-799, final flush ~808-835, 그리고 다른 4개 MetricFlush 리터럴 230/274/1111/1263)
- Modify: `crates/engine/tests/vu_curve.rs` (통합 테스트)

**주의:** `MetricFlush`에 필드를 더하면 **6개 리터럴 사이트 전부**가 컴파일 에러 → 한 커밋에서 같이. 곡선 2곳(711·826)만 실제 drain, 나머지 4곳(230·274·1111·1263)은 `active_vu_samples: vec![]`. send-guard term(`|| !active_vu_samples.is_empty()`)은 **곡선 2곳만**(다른 곳은 항상 빈 벡터).

- [ ] **Step 1: 실패하는 통합 테스트 작성**

`crates/engine/tests/vu_curve.rs` 끝에 추가(`ActiveVuSample`는 `handicap_engine`에서):

```rust
#[tokio::test]
async fn vu_curve_emits_active_vu_samples() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let h = tokio::spawn(run_scenario_vu_curve(
        scenario(&format!("{}/", server.uri())),
        curve_plan(vec![stage(3, 2)], RampDown::Graceful),
        tx,
        CancellationToken::new(),
    ));
    let mut samples: Vec<handicap_engine::ActiveVuSample> = Vec::new();
    while let Some(f) = rx.recv().await {
        samples.extend(f.active_vu_samples);
    }
    h.await.unwrap().unwrap();
    assert!(!samples.is_empty(), "curve run must emit active-VU samples");
    // desired reaches the stage target (3).
    let max_desired = samples.iter().map(|s| s.desired).max().unwrap();
    assert_eq!(max_desired, 3, "desired should reach stage target 3");
    // actual VUs really ran at some second.
    assert!(
        samples.iter().any(|s| s.actual > 0),
        "actual VUs should be observed"
    );
    // gauge: at most one sample per second.
    let mut secs: Vec<i64> = samples.iter().map(|s| s.ts_second).collect();
    secs.sort_unstable();
    let mut uniq = secs.clone();
    uniq.dedup();
    assert_eq!(uniq.len(), secs.len(), "one active-VU sample per second");
}
```

> **타이밍 노트**: `max_desired == 3`은 견고(`rate_at`가 elapsed≥1.75s에 3.0 도달 → round 3). `actual > 0`은 VU가 1초 경계 샘플 시점에 활성(slab Some)이어야 참 — 빠른 mock·ramp에서 거의 항상 참이지만 환경 부하에 민감할 수 있다. flake 시 warm 재시도(기존 `aggregator::tests` wall-clock flake와 동류) 또는 stage를 `stage(3, 3)`로 늘려 샘플 기회를 늘린다.

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cargo test -p handicap-engine --test vu_curve vu_curve_emits_active_vu_samples`
Expected: 컴파일 실패 — `MetricFlush`에 `active_vu_samples` 필드 없음.

- [ ] **Step 3: `MetricFlush`에 필드 추가**

`crates/engine/src/runner.rs` `pub struct MetricFlush`(92행)의 `phase_stats` 다음에:

```rust
    /// Per-second active-VU gauge samples since the last flush. Only the VU-curve path
    /// populates this; all other paths send an empty Vec (byte-identical).
    pub active_vu_samples: Vec<ActiveVuSample>,
```

파일 상단 use에 `ActiveVuSample`를 추가(`use crate::aggregator::{… , ActiveVuSample};` 또는 기존 stat 타입 import 줄에 합류).

- [ ] **Step 4: 슈퍼바이저 초당 샘플링 추가**

`crates/engine/src/runner.rs` `run_scenario_vu_curve`의 supervisor 루프 시작 직전(`let mut ticker = tokio::time::interval(Duration::from_millis(250));` 위, 730행 인근)에:

```rust
    let mut last_active_sample_second: i64 = i64::MIN;
```

supervisor 루프 안, `let _ = desired_tx.send(desired);`(785행) 바로 뒤에:

```rust
        // Active-VU gauge: one sample per wall-clock second (hot-path-free — at most
        // 4 ticks/sec, but recorded once/sec). `desired` reuses the value computed above;
        // `actual` counts live slab tokens.
        let sample_second = chrono_second();
        if sample_second != last_active_sample_second {
            let actual = {
                let g = slab.lock().expect("slab mutex");
                g.iter().flatten().count() as u32
            };
            agg.lock().await.record_active_vu(sample_second, desired, actual);
            last_active_sample_second = sample_second;
        }
```

- [ ] **Step 5: 곡선 periodic flush — drain + guard + 리터럴**

`crates/engine/src/runner.rs` 곡선 flusher(694-723행)를 수정:

drain 튜플(695-704행)에 `g.drain_active_vu()` 추가:

```rust
            let (drained, loop_stats, branch_stats, group_stats, phase_stats, active_vu_samples) = {
                let mut g = flush_agg.lock().await;
                (
                    g.drain_completed(now_s),
                    g.drain_loop_deltas(),
                    g.drain_branch_deltas(),
                    g.drain_group_deltas(),
                    g.drain_phase_deltas(),
                    g.drain_active_vu(),
                )
            };
```

guard(705-709행)에 term 추가 + 리터럴(711-718행)에 필드 추가:

```rust
            if (!drained.is_empty()
                || !loop_stats.is_empty()
                || !branch_stats.is_empty()
                || !group_stats.is_empty()
                || !phase_stats.is_empty()
                || !active_vu_samples.is_empty())
                && flush_out
                    .send(MetricFlush {
                        windows: drained,
                        loop_stats,
                        branch_stats,
                        group_stats,
                        dropped: 0,
                        phase_stats,
                        active_vu_samples,
                    })
                    .await
                    .is_err()
            {
                break;
            }
```

- [ ] **Step 6: 곡선 final flush — drain + guard + 리터럴**

`crates/engine/src/runner.rs` final flush(809-834행)를 동일 패턴으로:

```rust
    let (final_windows, final_loops, final_branches, final_groups, final_phases, final_active_vu) = {
        let mut g = agg.lock().await;
        (
            g.drain_all(),
            g.drain_loop_deltas(),
            g.drain_branch_deltas(),
            g.drain_group_deltas(),
            g.drain_phase_deltas(),
            g.drain_active_vu(),
        )
    };
    if !final_windows.is_empty()
        || !final_loops.is_empty()
        || !final_branches.is_empty()
        || !final_groups.is_empty()
        || !final_phases.is_empty()
        || !final_active_vu.is_empty()
    {
        let _ = out
            .send(MetricFlush {
                windows: final_windows,
                loop_stats: final_loops,
                branch_stats: final_branches,
                group_stats: final_groups,
                dropped: 0,
                phase_stats: final_phases,
                active_vu_samples: final_active_vu,
            })
            .await;
    }
```

- [ ] **Step 7: 나머지 4개 MetricFlush 리터럴에 `active_vu_samples: vec![]`**

컴파일러가 가리키는 4곳(closed-loop periodic ~230, closed-loop final ~274, open-loop periodic ~1111, open-loop final ~1263)의 각 `MetricFlush { … }` 리터럴에 `active_vu_samples: vec![],`를 추가. (엔진 통합 테스트에 `MetricFlush { … }` 리터럴이 있으면 그것도.) 빠진 곳은 `cargo build`가 "missing field"로 잡는다.

- [ ] **Step 8: 컴파일 + 테스트 통과 확인**

Run: `cargo build -p handicap-engine --tests`
Expected: 0 errors (missing-field 0).

Run: `cargo test -p handicap-engine --test vu_curve`
Expected: 새 테스트 + 기존 8개 전부 PASS. (flake 시 warm 재시도 — `aggregator::tests` wall-clock flake와 무관.)

- [ ] **Step 9: 게이트 + 커밋**

Run: `cargo clippy -p handicap-engine --all-targets -- -D warnings && cargo test -p handicap-engine`
Expected: green.

```bash
git add crates/engine/src/runner.rs crates/engine/tests/vu_curve.rs
git commit -m "feat(engine): 곡선 슈퍼바이저 초당 active-VU 샘플 + MetricFlush.active_vu_samples"
git log -1 --oneline
```

---

### Task 3: proto + 워커 forwarder

**Files:**
- Modify: `crates/proto/proto/coordinator.proto` (새 메시지 + `MetricBatch` 필드 9)
- Modify: `crates/worker/src/main.rs` (import + forwarder 변환 + 스킵-가드)
- Modify: 컴파일러가 가리키는 `MetricBatch { … }` 리터럴 전부(`crates/worker/src/main.rs:342`, `crates/controller/src/grpc/coordinator.rs` 테스트 등)

**주의:** proto 필드 추가는 prost exhaustive라 모든 `MetricBatch { … }` 리터럴을 깨뜨린다. 이 태스크는 순수 배선이라 새 단위 테스트 없음(T6 e2e가 검증). 기존 테스트 green 유지가 통과 기준.

- [ ] **Step 1: proto 메시지 + 필드 추가**

`crates/proto/proto/coordinator.proto`의 `message PhaseStat { … }`(52-57행) 다음에:

```proto
message ActiveVuSample {
  int64 ts_second = 1;
  uint32 desired = 2;   // curve's commanded active-VU count for this second
  uint32 actual = 3;    // live VUs in their active loop at the sample instant
}
```

`message MetricBatch { … }`의 `phase_stats = 8;`(67행) 다음에:

```proto
  repeated ActiveVuSample active_vu_samples = 9;  // per-second active-VU gauge (curve only)
```

- [ ] **Step 2: proto 재생성 확인**

Run: `cargo build -p handicap-proto`
Expected: PASS(tonic-build이 `pb::ActiveVuSample` + `MetricBatch.active_vu_samples` 생성). 실패 시 `protoc` 설치 확인.

- [ ] **Step 3: 워커 forwarder 변환 + import**

`crates/worker/src/main.rs` 16-18행의 `use pb::{ … }`에 `ActiveVuSample` 추가:

```rust
use pb::{
    ActiveVuSample, BranchStat, GroupStat, LoopStat, MetricBatch, MetricWindow, PhaseStat,
    RunStatus, WorkerMessage,
};
```

forwarder의 `phase_stats` 변환(316-328행) 다음에 active_vu 변환 추가:

```rust
            let active_vu_samples: Vec<ActiveVuSample> = flush
                .active_vu_samples
                .into_iter()
                .map(|s| ActiveVuSample {
                    ts_second: s.ts_second,
                    desired: s.desired,
                    actual: s.actual,
                })
                .collect();
```

- [ ] **Step 4: 스킵-가드 term 추가 (C1 함정 — 누락 시 곡선-only flush가 silently drop)**

`crates/worker/src/main.rs`의 빈-배치 스킵 가드(332-340행)에 term 추가:

```rust
            if windows.is_empty()
                && loop_stats.is_empty()
                && branch_stats.is_empty()
                && group_stats.is_empty()
                && phase_stats.is_empty()
                && active_vu_samples.is_empty()
                && flush.dropped == 0
            {
                continue;
            }
```

- [ ] **Step 5: `MetricBatch` 리터럴에 필드 추가**

워커 forwarder의 `MetricBatch { … }`(342-351행)에 `active_vu_samples,` 추가:

```rust
                payload: Some(WorkerPayload::MetricBatch(MetricBatch {
                    run_id: run_id.clone(),
                    worker_id: worker_id.clone(),
                    windows,
                    loop_stats,
                    branch_stats,
                    group_stats,
                    phase_stats,
                    dropped: flush.dropped,
                    active_vu_samples,
                })),
```

그리고 `crates/controller/src/grpc/coordinator.rs`(및 다른 곳)의 테스트용 `MetricBatch { … }` 리터럴에 `active_vu_samples: vec![],` 추가 — `cargo build --workspace --tests`의 "missing field"가 전부 가리킨다.

- [ ] **Step 6: 워크스페이스 컴파일 + 기존 테스트 green**

Run: `cargo build --workspace --tests`
Expected: 0 errors.

Run: `cargo test --workspace`
Expected: 기존 테스트 전부 green(회귀 0).

- [ ] **Step 7: 게이트 + 커밋**

Run: `cargo clippy --workspace --all-targets -- -D warnings`
Expected: green.

```bash
git add crates/proto/proto/coordinator.proto crates/worker/src/main.rs crates/controller/src/grpc/coordinator.rs
git commit -m "feat(proto+worker): MetricBatch.active_vu_samples=9 + forwarder 변환·스킵가드"
git log -1 --oneline
```

---

### Task 4: 컨트롤러 store — migration 0016 + insert + ingest

**Files:**
- Create: `crates/controller/src/store/migrations/0016_run_active_vu_metrics.sql`
- Modify: `crates/controller/src/store/mod.rs` (const + execute + idempotency 테스트)
- Modify: `crates/controller/src/store/metrics.rs` (`ActiveVuRow` + `insert_active_vu_batch` + round-trip 테스트)
- Modify: `crates/controller/src/grpc/coordinator.rs` (`ingest_metrics`가 insert 호출 — `insert_active_vu_batch`의 실 caller라 dead_code 회피)

- [ ] **Step 1: migration SQL 작성**

`crates/controller/src/store/migrations/0016_run_active_vu_metrics.sql`:

```sql
-- migration 0016: per-second active-VU gauge series (closed-loop VU curve only).
-- Scalar gauge (not HDR), single-worker (curve rejects capacity overflow with 400),
-- so no worker_id. UPSERT keep-last on (run_id, ts_second).
CREATE TABLE IF NOT EXISTS run_active_vu_metrics (
  run_id     TEXT    NOT NULL,
  ts_second  INTEGER NOT NULL,
  desired    INTEGER NOT NULL,
  actual     INTEGER NOT NULL,
  PRIMARY KEY (run_id, ts_second)
);
```

- [ ] **Step 2: mod.rs에 const + execute 배선**

`crates/controller/src/store/mod.rs` migration const 블록(27-37행)의 `MIGRATION_SQL_0015` 다음에:

```rust
const MIGRATION_SQL_0016: &str = include_str!("migrations/0016_run_active_vu_metrics.sql");
```

`connect()`의 execute 블록에서 `sqlx::query(MIGRATION_SQL_0015)…`(73행) 다음에:

```rust
    sqlx::query(MIGRATION_SQL_0016).execute(&pool).await?; // migration 0016: run_active_vu_metrics
```

(0010/0011/0013/0015와 동일 — Rust-guarded ALTER 아님. **execute 라인을 빠뜨리면 런타임 `no such table`** — const 추가 시 execute도 추가됐는지 눈으로 확인.)

- [ ] **Step 3: 실패하는 idempotency + round-trip 테스트 작성**

`crates/controller/src/store/mod.rs`의 `#[cfg(test)] mod tests`에 추가(기존 migration 테스트 인근):

```rust
#[tokio::test]
async fn migration_0016_is_idempotent() {
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::query(MIGRATION_SQL_0016).execute(&pool).await.unwrap();
    sqlx::query(MIGRATION_SQL_0016).execute(&pool).await.unwrap(); // CREATE IF NOT EXISTS: no-op
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM run_active_vu_metrics")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}
```

`crates/controller/src/store/metrics.rs`의 `#[cfg(test)] mod tests`에 추가:

```rust
#[tokio::test]
async fn active_vu_insert_and_read_upserts_keep_last() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    insert_active_vu_batch(
        &db,
        &[
            ActiveVuRow { run_id: "r1".into(), ts_second: 100, desired: 3, actual: 2 },
            ActiveVuRow { run_id: "r1".into(), ts_second: 101, desired: 5, actual: 5 },
        ],
    )
    .await
    .unwrap();
    // same (run_id, ts_second) overwrites (keep-last).
    insert_active_vu_batch(
        &db,
        &[ActiveVuRow { run_id: "r1".into(), ts_second: 100, desired: 4, actual: 4 }],
    )
    .await
    .unwrap();
    let out = active_vu_series(&db, "r1").await.unwrap();
    assert_eq!(out.len(), 2);
    assert_eq!((out[0].ts_second, out[0].desired, out[0].actual), (100, 4, 4));
    assert_eq!((out[1].ts_second, out[1].desired, out[1].actual), (101, 5, 5));
}
```

(`active_vu_series` read fn은 T5에서 추가하지만, 테스트가 둘 다 부르므로 컴파일 위해 이 태스크에서 두 fn 모두 작성 — Step 4. read fn의 실 caller(`build_report_for_run`)는 T5에서 배선되지만, `pub` lib fn이라 dead_code 미플래그.)

- [ ] **Step 4: `ActiveVuRow` + insert + read 구현**

`crates/controller/src/store/metrics.rs`의 `PhaseMetricRow`/`phase_breakdown`(299-348행) 다음에:

```rust
#[derive(Debug, Clone)]
pub struct ActiveVuRow {
    pub run_id: String,
    pub ts_second: i64,
    pub desired: i64,
    pub actual: i64,
}

pub async fn insert_active_vu_batch(db: &Db, rows: &[ActiveVuRow]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut tx = db.begin().await?;
    for r in rows {
        sqlx::query(
            "INSERT INTO run_active_vu_metrics(run_id,ts_second,desired,actual) VALUES(?,?,?,?) \
             ON CONFLICT(run_id,ts_second) DO UPDATE SET desired=excluded.desired, actual=excluded.actual",
        )
        .bind(&r.run_id)
        .bind(r.ts_second)
        .bind(r.desired)
        .bind(r.actual)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

pub async fn active_vu_series(db: &Db, run_id: &str) -> sqlx::Result<Vec<ActiveVuRow>> {
    let rows = sqlx::query(
        "SELECT ts_second, desired, actual FROM run_active_vu_metrics \
         WHERE run_id = ? ORDER BY ts_second",
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
        })
        .collect())
}
```

- [ ] **Step 5: ingest 배선 (insert의 실 caller)**

`crates/controller/src/grpc/coordinator.rs` `ingest_metrics`의 phase insert 블록(869-884행) 다음에:

```rust
    let active_vu_rows: Vec<crate::store::metrics::ActiveVuRow> = batch
        .active_vu_samples
        .iter()
        .map(|s| crate::store::metrics::ActiveVuRow {
            run_id: batch.run_id.clone(),
            ts_second: s.ts_second,
            desired: s.desired as i64,
            actual: s.actual as i64,
        })
        .collect();
    if !active_vu_rows.is_empty() {
        if let Err(e) =
            crate::store::metrics::insert_active_vu_batch(&state.db, &active_vu_rows).await
        {
            warn!(run_id = %batch.run_id, error = %e, "failed to insert active-vu metrics");
        }
    }
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `cargo test -p handicap-controller migration_0016_is_idempotent active_vu_insert_and_read`
Expected: 둘 다 PASS.

- [ ] **Step 7: 게이트 + 커밋**

Run: `cargo clippy -p handicap-controller --all-targets -- -D warnings && cargo test -p handicap-controller`
Expected: green (dead_code 0 — insert는 ingest가, read는 테스트가 호출).

```bash
git add crates/controller/src/store/migrations/0016_run_active_vu_metrics.sql crates/controller/src/store/mod.rs crates/controller/src/store/metrics.rs crates/controller/src/grpc/coordinator.rs
git commit -m "feat(controller): migration 0016 run_active_vu_metrics + insert/read + ingest"
git log -1 --oneline
```

---

### Task 5: 컨트롤러 — build_report + ReportJson.active_vu_series

**Files:**
- Modify: `crates/controller/src/report.rs` (controller `ActiveVuSample` 타입 + `ReportJson.active_vu_series` + `build_report` 8th param + 매핑 + 17 테스트 fixture + 비오염 테스트)
- Modify: `crates/controller/src/api/runs.rs` (`build_report_for_run`가 read + pass — read fn의 실 caller)
- Modify: `crates/controller/src/export.rs` (ReportJson 픽스처 ~390행에 `active_vu_series: vec![]`)

**주의:** `ReportJson`은 `rename_all` 없음 → 필드명은 snake_case `active_vu_series`(와이어 키). `build_report`가 7→8 param이라 호출부 전부(프로덕션 1곳 `api/runs.rs:498` + `report.rs` 테스트 17곳)에 인자 추가.

- [ ] **Step 1: 실패하는 비오염 테스트 작성**

`crates/controller/src/report.rs`의 `#[cfg(test)] mod tests`에 추가(기존 `build_report_attaches_group_latency_without_polluting_summary` 인근):

```rust
#[test]
fn build_report_attaches_active_vu_series_without_polluting_summary() {
    use crate::store::metrics::ActiveVuRow;
    // fixture: run_row() + win() 헬퍼 (build_report_attaches_group_latency_… 와 동일 패턴, report.rs:652·686).
    let r = run_row();
    let rows = vec![win(100, "01HX0000000000000000000011", 5, 0, r#"{"200":5}"#, &[5_000])];
    let yaml = r.scenario_yaml.clone();
    let active = vec![
        ActiveVuRow { run_id: r.id.clone(), ts_second: 100, desired: 3, actual: 2 },
        ActiveVuRow { run_id: r.id.clone(), ts_second: 101, desired: 5, actual: 5 },
    ];
    let rep = build_report(&r, &yaml, &rows, &[], &[], &[], &[], &active);
    assert_eq!(rep.active_vu_series.len(), 2);
    assert_eq!(
        (rep.active_vu_series[0].ts_second, rep.active_vu_series[0].desired, rep.active_vu_series[0].actual),
        (100, 3, 2)
    );
    // summary/windows must be untouched by the gauge (same as the windows-only build).
    let baseline = build_report(&r, &yaml, &rows, &[], &[], &[], &[], &[]);
    assert_eq!(rep.summary.count, baseline.summary.count);
    assert_eq!(rep.summary.rps, baseline.summary.rps);
    assert_eq!(rep.windows.len(), baseline.windows.len());
    // empty input -> empty series.
    assert!(baseline.active_vu_series.is_empty());
}
```

(`run_row()`=`report.rs:652`(id `"R1"`), `win(ts,step,count,errors,sc,samples)`=`report.rs:686` — `build_report_attaches_group_latency_without_polluting_summary`(`:1223`)가 쓰는 그 헬퍼. 발명 헬퍼 금지.)

- [ ] **Step 2: 테스트 실패 확인**

Run: `cargo test -p handicap-controller build_report_attaches_active_vu_series`
Expected: 컴파일 실패 — `build_report` 인자 수 불일치 + `active_vu_series` 필드 없음.

- [ ] **Step 3: controller `ActiveVuSample` 타입 추가**

`crates/controller/src/report.rs`의 `pub struct GroupLatency { … }`(125행) 인근에:

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct ActiveVuSample {
    pub ts_second: i64,
    pub desired: u32,
    pub actual: u32,
}
```

- [ ] **Step 4: `ReportJson`에 필드 추가**

`crates/controller/src/report.rs` `pub struct ReportJson`의 `group_latency`(31행) 다음에:

```rust
    #[serde(default)]
    pub active_vu_series: Vec<ActiveVuSample>,
```

(`#[serde(default)]`, `skip_serializing_if` 없음 → 빈 배열도 항상 직렬화. `group_latency` 패턴과 동일 — UI Zod는 `.optional()`.)

- [ ] **Step 5: `build_report` 8th param + 매핑 + 리터럴**

`crates/controller/src/report.rs` `build_report` 시그니처(332-340행)에 8번째 param 추가:

```rust
pub fn build_report(
    run: &RunRow,
    scenario_yaml: &str,
    rows: &[WindowWithHdr],
    loops: &[LoopMetricRow],
    branches: &[IfBranchRow],
    groups: &[GroupMetricRow],
    phases: &[PhaseMetricRow],
    active_vu: &[crate::store::metrics::ActiveVuRow],
) -> ReportJson {
```

함수 본문에서 `group_latency` 빌드(594-609행) 다음, `ReportJson { … }` 리터럴(611행) 직전에:

```rust
    // Active-VU gauge: independent per-second series. NOT merged into summary/windows/
    // overall/rps (group_latency/download-phase와 동형 — 독립 게이지).
    let active_vu_series: Vec<ActiveVuSample> = active_vu
        .iter()
        .map(|r| ActiveVuSample {
            ts_second: r.ts_second,
            desired: r.desired as u32,
            actual: r.actual as u32,
        })
        .collect();
```

`ReportJson { … }` 리터럴(632행 `group_latency,` 다음)에:

```rust
        active_vu_series,
```

- [ ] **Step 6: 호출부 전부 — `build_report_for_run` + 17 테스트 fixture + export.rs**

(a) 프로덕션: `crates/controller/src/api/runs.rs` `build_report_for_run`(487-507행)에서 read + pass:

```rust
    let phases = crate::store::metrics::phase_breakdown(db, run_id).await?;
    let active_vu = crate::store::metrics::active_vu_series(db, run_id).await?;
    let scenario_yaml = row.scenario_yaml.clone();
    Ok(crate::report::build_report(
        &row,
        &scenario_yaml,
        &rows,
        &loops,
        &branches,
        &groups,
        &phases,
        &active_vu,
    ))
```

(b) `crates/controller/src/report.rs`의 **기존 17개** `build_report(…)` 호출에 8번째 인자 `&[]` 추가. (Step 1에서 새로 추가한 `build_report_attaches_active_vu_series` 테스트는 자체적으로 `&active`/`&[]`를 넘기므로 — 편집 후 grep하면 19곳이 되지만 새로 손댈 건 기존 17곳뿐.) `cargo test --no-run`의 인자-수 에러가 빠진 곳을 전부 가리킨다.

(c) `crates/controller/src/export.rs`의 `ReportJson { … }` 픽스처(~390행, `report_with_steps`)에 `active_vu_series: vec![],` 추가(`#[serde(default)]`는 역직렬화만 default라 struct 리터럴엔 필드 필요 — 컴파일러가 잡지만 export.rs를 빼먹기 쉬움).

- [ ] **Step 7: 테스트 통과 확인**

Run: `cargo test -p handicap-controller build_report_attaches_active_vu_series`
Expected: PASS.

Run: `cargo test -p handicap-controller`
Expected: 전부 green(기존 report/export 테스트 회귀 0).

- [ ] **Step 8: 게이트 + 커밋**

Run: `cargo clippy -p handicap-controller --all-targets -- -D warnings`
Expected: green.

```bash
git add crates/controller/src/report.rs crates/controller/src/api/runs.rs crates/controller/src/export.rs
git commit -m "feat(controller): build_report active_vu_series + ReportJson 필드 + 호출부"
git log -1 --oneline
```

---

### Task 6: 컨트롤러 — 곡선 run → report e2e smoke

**Files:**
- Modify/Create: `crates/controller/tests/` (기존 e2e 패턴 — `parallel_group_latency_report_e2e_smoke` 미러)

end-to-end(워커 subprocess → gRPC → DB → report)로 active_vu_series가 채워지는지 확인. 워커 forwarder(T3)·ingest(T4)·build_report(T5)를 한 번에 검증.

> **스코프 가드(reviewer S4)**: Step 1 grep으로 **이미 run을 구동하는 e2e 하니스**(워커 subprocess spawn + run 생성 + terminal 대기 + `/report` fetch)가 있으면 곡선 케이스만 얹는다(작음). **만약 그런 하니스가 없으면** 이 태스크는 net-new 스캐폴딩이라 커진다 — 그 경우 e2e는 **최소 스모크 1개**로 한정하고, end-to-end 신뢰는 T2(엔진 통합)+T5(컨트롤러 단위)+**T9(라이브 검증, 진짜 e2e 게이트)**에 둔다. 이 태스크를 위해 큰 하니스를 새로 짓지 말 것.

- [ ] **Step 1: 기존 e2e 스모크 패턴 확인**

Run: `grep -rln "group_latency_report_e2e_smoke\|worker_bin_path\|measure_phases.*e2e" crates/controller/tests/`
기존 파일(예: `e2e_test.rs` 또는 phase/group e2e)에서 ① 컨트롤러 app + gRPC 기동, ② 워커 subprocess spawn(`worker_bin_path()`), ③ run 생성 → terminal 대기 → `/report` fetch, ④ 단언 패턴을 그대로 차용.

- [ ] **Step 2: 곡선 run e2e 테스트 작성**

기존 e2e 파일에 추가(curve run = `vu_stages` profile). run 생성 payload는 closed+curve(`vus:0`, `duration_seconds:0`, `vu_stages:[{target,duration_seconds}]`, `ramp_down:"graceful"`)로. 짧은 곡선(예: `[{target:2, duration_seconds:2}]`)으로:

```rust
// (기존 e2e 헬퍼 시그니처에 맞춰 작성 — 아래는 단언 골자)
let report: serde_json::Value = fetch_report(&app, &run_id).await;
let series = report["active_vu_series"].as_array().expect("active_vu_series present");
assert!(!series.is_empty(), "curve run report must carry active-VU series");
assert!(
    series.iter().any(|s| s["desired"].as_u64().unwrap() >= 1),
    "desired should reach the stage target"
);
assert!(
    series.iter().any(|s| s["actual"].as_u64().unwrap() >= 1),
    "actual VUs should be observed"
);
```

- [ ] **Step 3: e2e 실행**

Run: `cargo build -p handicap-worker --bin worker && cargo test -p handicap-controller --test <e2e_file> -- --nocapture`
Expected: PASS. (cold-build flake 시 warm 재시도 — 루트 CLAUDE.md.)

- [ ] **Step 4: 게이트 + 커밋**

Run: `cargo test --workspace`
Expected: green.

```bash
git add crates/controller/tests/
git commit -m "test(controller): 곡선 run active_vu_series e2e smoke"
git log -1 --oneline
```

---

### Task 7: UI — Zod + ActiveVuChart + ReportView

**Files:**
- Modify: `ui/src/api/schemas.ts` (`ActiveVuSampleSchema` + `active_vu_series`)
- Create: `ui/src/components/report/ActiveVuChart.tsx`
- Modify: `ui/src/components/report/ReportView.tsx` (조건부 섹션)
- Modify: `ui/src/i18n/ko.ts` (문구 — 실제 카탈로그 경로 확인)
- Create: `ui/src/components/report/__tests__/ActiveVuChart.test.tsx`

**주의:** 필드명 snake_case `active_vu_series`, `.optional()`(NOT `.default([])` — 누출), `.strict()` ReportSchema. Recharts jsdom은 explicit width/height. X축 = `ts_second - t0`(상대 초). desired 점선/actual 실선, `type="linear"`(StageCurvePreview 컨벤션, monotone 금지).

- [ ] **Step 1: Zod 스키마 추가**

`ui/src/api/schemas.ts`의 `ReportSchema` 정의 위에:

```ts
export const ActiveVuSampleSchema = z.object({
  ts_second: z.number().int(),
  desired: z.number().int().nonnegative(),
  actual: z.number().int().nonnegative(),
});
export type ActiveVuSample = z.infer<typeof ActiveVuSampleSchema>;
```

`ReportSchema`(`.strict()` object)의 `group_latency` 줄 다음에:

```ts
    active_vu_series: z.array(ActiveVuSampleSchema).optional(),
```

(`.optional()` — `.default([])` 금지: 응답 스키마 top-level `.default()`는 `T|undefined`를 부모 `z.infer`로 누출하고 `pnpm build`만 잡는다. `group_latency`와 동일.)

- [ ] **Step 2: 실패하는 차트 테스트 작성**

`ui/src/components/report/__tests__/ActiveVuChart.test.tsx`:

```tsx
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActiveVuChart } from "../ActiveVuChart";

describe("ActiveVuChart", () => {
  it("renders a labelled region with the active-VU chart", () => {
    const { getByRole } = render(
      <ActiveVuChart
        series={[
          { ts_second: 100, desired: 0, actual: 0 },
          { ts_second: 101, desired: 3, actual: 2 },
          { ts_second: 102, desired: 3, actual: 3 },
        ]}
        width={400}
        height={200}
      />,
    );
    // <section aria-label> — accessible-name substring (literal parens in the full title
    // "활성 VU (시간별)" break a full-string regex, so match the stable prefix).
    const region = getByRole("region", { name: /활성 VU/ });
    expect(region).toBeInTheDocument();
    // Repo-proven pattern (TimeSeriesChart.test.tsx): assert region + <svg> existence.
    // Do NOT assert Recharts <Legend>/<Tooltip> text — NOT reliably rendered under jsdom
    // (ui/CLAUDE.md: only axis-tick/heading text is guaranteed). The production component
    // still renders <Legend> (목표/실제) for real browsers; the test just can't see it.
    expect(region.querySelector("svg")).not.toBeNull();
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd ui && pnpm test ActiveVuChart`
Expected: FAIL — `ActiveVuChart` 모듈 없음.

- [ ] **Step 4: `ActiveVuChart` 구현**

`ui/src/components/report/ActiveVuChart.tsx`:

```tsx
import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { ko } from "../../i18n/ko";
import type { ActiveVuSample } from "../../api/schemas";

type Props = {
  series: ActiveVuSample[];
  width?: number;
  height?: number;
};

export function ActiveVuChart({ series, width = 720, height = 220 }: Props) {
  // ts_second is unix epoch — subtract the first so the X axis reads as elapsed seconds
  // (same convention as TimeSeriesChart).
  const t0 = series.length > 0 ? series[0].ts_second : 0;
  const data = series.map((s) => ({ x: s.ts_second - t0, desired: s.desired, actual: s.actual }));
  return (
    <section aria-label={ko.report.activeVuTitle} className="mb-6">
      <h4 className="text-sm font-semibold text-slate-700 mb-2">{ko.report.activeVuTitle}</h4>
      <LineChart width={width} height={height} data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="x" label={{ value: "seconds", position: "insideBottom", offset: -4 }} />
        <YAxis label={{ value: "VU", angle: -90, position: "insideLeft" }} allowDecimals={false} />
        <Tooltip />
        <Legend />
        <Line
          type="linear"
          dataKey="desired"
          name={ko.report.activeVuDesired}
          stroke="#94a3b8"
          strokeDasharray="4 2"
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="linear"
          dataKey="actual"
          name={ko.report.activeVuActual}
          stroke="#2563eb"
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </section>
  );
}
```

- [ ] **Step 5: ko.ts 문구 추가**

`ui/src/i18n/ko.ts`(실제 카탈로그 위치는 `grep -rn "report:" ui/src/i18n/`로 확인)의 `report` 네임스페이스에:

```ts
    activeVuTitle: "활성 VU (시간별)",
    activeVuDesired: "목표",
    activeVuActual: "실제",
```

(소비처가 `ko.report.activeVuTitle` 등. 카탈로그 구조가 다르면 그 컨벤션에 맞춰 키 추가.)

- [ ] **Step 6: 차트 테스트 통과 확인**

Run: `cd ui && pnpm test ActiveVuChart`
Expected: PASS(region `활성 VU` + `<svg>` 존재).

- [ ] **Step 7: ReportView 조건부 섹션 배선**

`ui/src/components/report/ReportView.tsx`:

import 추가:

```tsx
import { ActiveVuChart } from "./ActiveVuChart";
```

`Errors / second` TimeSeriesChart(164행 `/>` 다음)와 `report.latency` 섹션(166행) 사이에:

```tsx
      {report.active_vu_series && report.active_vu_series.length > 0 ? (
        <ActiveVuChart series={report.active_vu_series} />
      ) : null}
```

- [ ] **Step 8: 전체 UI 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 green(`tsc -b`가 snake_case 필드·Recharts 타입 확인; lint `--max-warnings=0`).

- [ ] **Step 9: 커밋**

```bash
git add ui/src/api/schemas.ts ui/src/components/report/ActiveVuChart.tsx ui/src/components/report/__tests__/ActiveVuChart.test.tsx ui/src/components/report/ReportView.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): ActiveVuChart 활성 VU 시계열(목표 점선/실제 실선) + ReportView 슬롯"
git log -1 --oneline
```

---

### Task 8: 문서 — CLAUDE.md + roadmap + build-log

**Files:**
- Modify: `crates/engine/CLAUDE.md` (MetricFlush "드레인 6 / send-guard 5" 노트에 7번째 벡터 반영)
- Modify: `crates/controller/CLAUDE.md` (새 `run_active_vu_metrics` 테이블 + read 헬퍼 한 줄)
- Modify: `docs/roadmap.md` (§B9 "active-VU per-second 시계열" 완료 표시)
- Modify: `docs/build-log.md` (한 단락 append)

- [ ] **Step 1: 엔진 CLAUDE.md — MetricFlush 노트 갱신**

`crates/engine/CLAUDE.md`의 "`MetricFlush`에 새 드레인 벡터(Nth) 추가 시 6 flush 사이트…" 항목에 한 줄 추가:

```
- **active_vu_samples(7번째 벡터, ADR-0037 follow-up)**: 곡선만 채움 → 드레인 6곳 리터럴(곡선 2곳 실 drain·나머지 4곳 vec![]) + **send-guard는 곡선 periodic+final 2곳만**(다른 곳은 항상 빈 벡터라 불필요) + **워커 forwarder 스킵-가드(main.rs)에 `&& flush.active_vu_samples.is_empty()`**(누락 시 곡선-only flush silently drop, dropped C1 함정과 동형). 슈퍼바이저가 초당 1회 `agg.record_active_vu(chrono_second(), desired, slab Some 카운트)`.
```

- [ ] **Step 2: 컨트롤러 CLAUDE.md — 새 테이블 노트**

`crates/controller/CLAUDE.md` 마이그레이션 섹션에 한 줄:

```
- **migration 0016 `run_active_vu_metrics` = scalar 게이지 UPSERT (HDR 델타 테이블과 대비)** (ADR-0037 follow-up): PK `(run_id, ts_second)` + `ON CONFLICT DO UPDATE`(keep-last; 게이지=완전 스냅샷, 곡선 단일워커라 worker_id 없음). `insert_active_vu_batch`(ingest)·`active_vu_series`(build_report read). `build_report` 8번째 param `active_vu` → `ReportJson.active_vu_series`(독립 게이지, summary/windows 비오염).
```

- [ ] **Step 3: roadmap §B9 갱신**

`docs/roadmap.md` §B9의 "active-VU per-second 시계열" 항목을 ✅ 완료로 표시(구현 요지 1줄 + 날짜).

- [ ] **Step 4: build-log 단락 append**

`docs/build-log.md`에 구현 요약 한 단락(파이프라인 7레이어·desired/actual·byte-identical·처리량 무회귀·라이브 검증).

- [ ] **Step 5: 커밋 (docs-only fast-path)**

```bash
git add crates/engine/CLAUDE.md crates/controller/CLAUDE.md docs/roadmap.md docs/build-log.md
git commit -m "docs: active-VU 시계열 — CLAUDE.md 함정 + roadmap/build-log 갱신"
git log -1 --oneline
```

---

### Task 9: 머지 전 라이브 검증 (커밋 아님 — finish-slice 체크리스트)

spec §9 "라이브(머지 전 필수)". 구현 세션 마무리(`/finish-slice`) 시:

- [ ] **Step 1: 워크트리 자체 바이너리 빌드** (stale 메인 바이너리 회피, 루트 CLAUDE.md)

Run: `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller && cd ui && pnpm build && cd ..`

- [ ] **Step 2: 격리 DB로 컨트롤러 기동 (상대경로)**

Run: `./target/debug/controller --db /tmp/avu.db --ui-dir ui/dist` (별도 터미널 또는 background)

- [ ] **Step 3: 곡선 run 생성 → 리포트 확인**

curl로 시나리오 + 곡선 run(`vu_stages:[{target:50,duration_seconds:10},{target:0,duration_seconds:5}]`, `ramp_down:"graceful"`) 생성 → terminal 대기 → `GET /api/runs/{id}/report` → `active_vu_series`에 desired(0→50→0 곡선) + actual(따라가되 ramp/retire lag) 확인. `python3`로 `ReportSchema` 호환 safeParse(ui/CLAUDE.md throwaway 테스트 패턴) 또는 Playwright로 `/runs/{id}` 리포트에서 "활성 VU (시간별)" 차트 + 목표(점선)/실제(실선) 두 줄 + 콘솔 Zod 0 확인.

- [ ] **Step 4: 비-곡선 run에 차트 부재 확인**

고정 closed-loop run(`vus:N`) 1개 → 리포트에 `active_vu_series` 빈(또는 absent) + "활성 VU" 차트 미렌더 확인(byte-identical 불변식).

- [ ] **Step 5: 처리량 무회귀 (RPS A/B)**

곡선 run의 summary.rps가 계측 전후 변동 범위 내인지 확인(샘플링 초당 1회 = 핫패스 밖). 의심 시 `just bench-throughput` 또는 flat-http run RPS 비교.

- [ ] **Step 6: Playwright 잔류물 정리**

`rm -rf .playwright-mcp` + 루트 png 정리(머지 전 untracked 잔류 방지, 루트 CLAUDE.md).

---

## Self-Review (작성 후 점검)

- **Spec 커버리지**: §3 데이터모델→T1·T5, §4 엔진→T1·T2, §5 proto/워커→T3, §6 컨트롤러→T4·T5, §7 UI→T7, §8 불변식→T2(byte-id)·T5(비오염)·T9(처리량), §9 테스트→각 태스크+T6 e2e+T9 라이브, §10 파이프라인 표→전 태스크. docs(§10 docs 행)→T8. **전 항목 매핑됨.**
- **타입 일관성**: 엔진 `ActiveVuSample{ts_second:i64,desired:u32,actual:u32}`(T1) / proto `ActiveVuSample{int64,uint32,uint32}`(T3) / store `ActiveVuRow{…,desired:i64,actual:i64}`(T4, SQLite INTEGER) / controller `ActiveVuSample{i64,u32,u32}`(T5) / Zod `ActiveVuSample{number,number,number}`(T7) — 경계마다 `as i64`/`as u32` 변환 명시(ingest T4 Step5, build_report T5 Step5). 필드명 `active_vu_series`(snake) 전 레이어 일관.
- **메서드명 일관**: `record_active_vu`/`drain_active_vu`(T1·T2), `insert_active_vu_batch`/`active_vu_series`(T4·T5), `ActiveVuChart`(T7) — 사용처와 일치.
- **Placeholder 스캔**: 모든 코드 스텝에 실제 코드 + 실제 명령/기대출력. T6 e2e는 기존 헬퍼 시그니처에 맞춰 단언 골자 제공(기존 패턴 차용 명시). T5 Step1 fixture는 인접 테스트 복제 지시.
- **커밋 경계**: 각 태스크 단일 green 커밋. T4 read fn은 `pub` lib fn(dead_code 미플래그) + insert는 ingest가 즉시 호출. T2 MetricFlush 6리터럴 한 커밋.

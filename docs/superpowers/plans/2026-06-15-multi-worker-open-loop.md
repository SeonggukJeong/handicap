# 멀티워커 open-loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** open-loop(arrival-rate) 부하를 N개 워커에 fan-out — 명시적 `worker_count` 노브로 `target_rps`/`max_in_flight`/`stages`를 워커별 분할(합=목표), 정확한 레이트 제어를 유지한 채 수평 확장.

**Architecture:** 컨트롤러 전용 슬라이스. 코디네이터 `assignment_for`가 register 시 워커별로 proto `Profile`을 `shard_split`로 축소해 보낸다 → 엔진·워커·proto·migration 무변경(워커는 받은 축소 프로필 그대로 실행). N=1이면 byte-identical. 메트릭 머지·`dropped` 합산은 A3b 인프라 재사용. 초보자 안전 = UI 접이식 필드(기본 1) + 사후 포화 인사이트 워커 추천.

**Tech Stack:** Rust(axum/sqlx/tonic-prost), TypeScript/React(Zod/vitest). 게이트: `cargo build/clippy/nextest --workspace` + UI `pnpm lint && pnpm test && pnpm build`.

**Spec:** `docs/superpowers/specs/2026-06-15-multi-worker-open-loop-design.md` (spec-plan-reviewer APPROVE).

**커밋 규율(루트 CLAUDE.md):** 각 Task = 단일 green 커밋(미사용 헬퍼-only·RED-only 단독 커밋 불가 — 헬퍼/테스트/배선을 한 커밋으로 fold). 로컬에선 RED→GREEN 확인하되 커밋 1회. `git commit`은 `run_in_background: false` + timeout 600000ms 단일 호출(폴링 금지). 커밋 직후 `git log -1`로 landed 확인(파이프 금지).

**UI 의존성:** Task 5·6은 `ui/`를 건드린다 — 시작 전 `cd ui && pnpm install`(fresh 워크트리 node_modules 없음). Task 1–4·7은 cargo만.

---

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `crates/controller/src/store/runs.rs` | `Profile.worker_count` 필드 + 모든 literal 사이트 | 1 |
| `crates/controller/src/api/runs.rs` | `validate_run_config` 검증 5종 + `spawn_run`/unique fan-out un-pin | 1,2 |
| `crates/controller/src/grpc/coordinator.rs` | `assignment_for` 워커별 프로필 분할 헬퍼 | 2 |
| `crates/controller/src/grpc/shard.rs` | `shard_split` 재사용(무변경) — 레이트/슬롯 분할기 | 2 |
| `crates/controller/tests/multi_worker_fanout_e2e.rs` | 2-워커 open-loop e2e | 3 |
| `crates/controller/src/insights.rs` | `recommended_workers` 인사이트(capacity 분기) | 4 |
| `crates/controller/src/report.rs` | `derive_insights` 10번째 인자 `worker_count_current` | 4 |
| `ui/src/api.ts`(또는 schema 위치) `InsightSchema` | `recommended_workers` Zod `.optional()` | 4 |
| `ui/src/components/InsightPanel.tsx` + `ko.ts` | 워커 추천 렌더 | 4 |
| `ui/src/components/loadModel.ts` · `LoadModelFields.tsx` · `RunDialog.tsx` · `ProfileSchema` · `ko.ts` | `worker_count` 접이식 입력 | 5 |
| `docs/adr/00NN-*.md` · 루트 `CLAUDE.md` · `docs/dev/capacity-planning.md` | ADR + 인덱스 + §4 정정 | 6 |

---

## Task 1: `worker_count` 필드 + 검증 5종

**Files:**
- Modify: `crates/controller/src/store/runs.rs` (Profile struct ~107-145)
- Modify: `crates/controller/src/api/runs.rs` (`validate_run_config` 177-336 + 인라인 테스트 ~1237-1340)
- Modify(컴파일러-driven): 모든 `Profile { … }` literal 사이트(~25곳: `report.rs:738`·`schedule/runner.rs:284`·`coordinator.rs:1034,1143`·`api/runs.rs` 테스트 다수) — `worker_count: None` 추가

- [ ] **Step 1: 필드 추가 (`store/runs.rs`)**

`Profile` struct에 `ramp_down` 필드 뒤에 추가:

```rust
    /// 멀티워커 open-loop fan-out 수 (spec 2026-06-15). absent/Some(1) = 단일 워커
    /// (오늘과 byte-identical). open-loop 전용 — closed-loop은 vus/capacity로 N 유도.
    /// proto에는 없음(컨트롤러가 register 시 워커별 프로필을 분할).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_count: Option<u32>,
```

- [ ] **Step 2: 컴파일러로 literal 사이트 전수 수정**

Run: `cargo build --workspace --tests 2>&1 | grep "missing field"`
모든 `Profile { … }` literal에 `worker_count: None,` 추가(테스트 픽스처는 전부 None — closed-loop·open-loop 기존 케이스 무영향). `cargo build --workspace --tests`가 0 에러 될 때까지. (AppState-필드 트랩과 동형 — 컴파일러가 전부 잡는다.)

- [ ] **Step 3: 검증 테스트 작성 (RED) — `api/runs.rs` 인라인 테스트**

기존 open-loop 검증 테스트군(`ol_profile()` 헬퍼 ~1237, `state_with(db, capacity)` ~847 사용)에 추가. capacity를 작게(`state_with(db, 4)`) 만들어 `vus`/`worker_count` 임계를 결정론으로:

```rust
#[tokio::test]
async fn worker_count_validation() {
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    let state = state_with(db, 2000).await; // capacity는 worker_count 검증과 무관(직접 임계)

    // #1 worker_count는 open-loop 전용: closed-loop에 w>1 → Err
    let mut closed = ol_profile();
    closed.target_rps = None;            // closed-loop
    closed.vus = 2;
    closed.max_in_flight = None;
    closed.worker_count = Some(2);
    assert!(validate_run_config(&state, &closed).await.is_err());

    // #2 범위: 0·65 → Err
    let mut w0 = ol_profile();
    w0.worker_count = Some(0);
    assert!(validate_run_config(&state, &w0).await.is_err());
    let mut w65 = ol_profile();
    w65.worker_count = Some(65);
    w65.max_in_flight = Some(65);
    w65.target_rps = Some(1000);
    assert!(validate_run_config(&state, &w65).await.is_err());

    // #3 슬롯 충분: max_in_flight < w → Err (w=3, mif=2)
    let mut slots = ol_profile();        // ol_profile: target_rps=Some, max_in_flight=Some
    slots.worker_count = Some(3);
    slots.max_in_flight = Some(2);
    slots.target_rps = Some(1000);
    assert!(validate_run_config(&state, &slots).await.is_err());

    // #4 레이트 충분(고정): target_rps < w → Err (w=3, rps=2)
    let mut rate = ol_profile();
    rate.worker_count = Some(3);
    rate.max_in_flight = Some(10);
    rate.target_rps = Some(2);
    assert!(validate_run_config(&state, &rate).await.is_err());

    // #5 open-loop + vus>0 → Err (리다이렉트)
    let mut volu = ol_profile();
    volu.vus = 1;
    assert!(validate_run_config(&state, &volu).await.is_err());

    // OK: open-loop + vus=0 + worker_count=2 + 충분한 slots/rate
    let mut ok = ol_profile();
    ok.worker_count = Some(2);
    ok.max_in_flight = Some(10);
    ok.target_rps = Some(1000);
    ok.vus = 0;
    assert!(validate_run_config(&state, &ok).await.is_ok());

    // OK: 곡선모드 stage.target < w 면제 (w=3, stages target 2)
    let mut curve = ol_profile();
    curve.target_rps = None;
    curve.duration_seconds = 0;
    curve.stages = Some(vec![handicap_engine::Stage { target: 2, duration_seconds: 5 }]);
    curve.max_in_flight = Some(10);
    curve.worker_count = Some(3);
    assert!(validate_run_config(&state, &curve).await.is_ok());

    // OK: closed-loop w=None·vus>0 무영향
    let mut closed_ok = ol_profile();
    closed_ok.target_rps = None;
    closed_ok.max_in_flight = None;
    closed_ok.vus = 2;
    closed_ok.worker_count = None;
    assert!(validate_run_config(&state, &closed_ok).await.is_ok());
}
```

(주의: `ol_profile()`의 정확한 기본값을 확인해 위 override가 일관되게 — 특히 `vus: 0`, `target_rps: Some`, `max_in_flight: Some`, `duration_seconds > 0`.)

- [ ] **Step 4: 테스트 RED 확인**

Run: `cargo nextest run -p handicap-controller worker_count_validation`
Expected: FAIL (검증 미구현 — 모든 `is_err()`가 실제로 Ok 반환).

- [ ] **Step 5: 검증 구현 (`validate_run_config`)**

**#1·#2는 체인 앞**(함수 시작부, `ramp_down` 체크 뒤·`is_vu_curve` 체인 전):

```rust
    // ── worker_count: open-loop 전용 멀티워커 fan-out 노브 (spec 2026-06-15) ──
    if let Some(w) = profile.worker_count {
        if w < 1 || w > 64 {
            return Err(ApiError::BadRequest(
                "worker_count must be between 1 and 64".into(),
            ));
        }
        if w > 1 && !profile.is_open_loop() {
            return Err(ApiError::BadRequest(
                "worker_count는 open-loop(target_rps/stages) 전용입니다 — \
                 closed-loop은 vus로 워커 수가 정해집니다".into(),
            ));
        }
    }
```

**#3·#4·#5는 open-loop arm 안** — `// vus ignored in open-loop (slot pool = max_in_flight)` 주석 자리를 교체:

```rust
        // #5 open-loop에선 vus가 무시된다 → 비정합 신호, worker_count/closed-loop로 리다이렉트.
        if profile.vus > 0 {
            return Err(ApiError::BadRequest(
                "open-loop에선 vus가 무시됩니다 — 수평 확장은 worker_count, \
                 VU 기반 부하는 closed-loop(vus)을 쓰세요".into(),
            ));
        }
        // #3·#4 멀티워커 fan-out 분할 가능성 (worker_count > 1):
        if let Some(w) = profile.worker_count {
            if w > 1 {
                // #3 워커당 ≥1 슬롯 (0-슬롯 워커는 자기 도착 전부 drop)
                let mif = profile.max_in_flight.unwrap_or(0);
                if mif < w {
                    return Err(ApiError::BadRequest(format!(
                        "worker_count={w}이면 max_in_flight >= {w} 필요 (워커당 ≥1 슬롯)"
                    )));
                }
                // #4 고정모드: 워커당 ≥1 rps (엔진 .max(1)이 0-share를 왜곡). 곡선모드 면제.
                let is_curve = profile.stages.as_ref().is_some_and(|s| !s.is_empty());
                if !is_curve {
                    let rps = profile.target_rps.unwrap_or(0);
                    if rps < w {
                        return Err(ApiError::BadRequest(format!(
                            "worker_count={w}이면 target_rps >= {w} 필요 (워커당 ≥1 rps)"
                        )));
                    }
                }
            }
        }
```

(주의: open-loop arm은 이미 `max_in_flight` None→400, `target_rps`/stages 범위를 검증한다. 위 블록은 그 검증들 *뒤*, arm 끝에 둔다.)

- [ ] **Step 6: 테스트 GREEN 확인 + 전체 게이트**

Run: `cargo nextest run -p handicap-controller worker_count_validation` → PASS
Run: `cargo build -p handicap-worker && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run --workspace` → 0 에러

- [ ] **Step 7: Commit**

**먼저** `git status --porcelain`로 Step 2가 건드린 파일 전부 확인(`..ol_profile()` spread 사이트는 worker_count 자동 채움 → full literal 빌더만 수정됨). 아래는 알려진 full-literal 파일 — `git status`에 더 있으면 명시 추가(절대 `git add -A` 금지):

```bash
git add crates/controller/src/store/runs.rs crates/controller/src/api/runs.rs \
  crates/controller/src/report.rs crates/controller/src/schedule/runner.rs \
  crates/controller/src/grpc/coordinator.rs crates/controller/src/store/presets.rs \
  crates/controller/src/store/schedules.rs crates/controller/tests/crash_recovery_test.rs \
  crates/controller/tests/report_test.rs crates/controller/tests/export_routes_test.rs \
  crates/controller/tests/dispatcher_subprocess_test.rs
git commit -m "feat(open-loop): worker_count profile field + validation 5종

worker_count: Option<u32> (serde default, open-loop 전용 fan-out 노브).
검증: 범위 1-64, open-loop 전용, max_in_flight>=w, 고정 target_rps>=w,
open-loop+vus>0 리다이렉트. proto/migration 무변경.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Run: `git log -1 --stat` (landed 확인)

---

## Task 2: fan-out un-pin + 워커별 프로필 분할

**핵심:** un-pin(spawn_run/unique)과 split(assignment_for)을 **한 커밋으로** — un-pin만 먼저면 split 없이 N×발사 깨진 상태, split만 먼저면 `shard_count>1` 미발생으로 dead-code 게이트.

**Files:**
- Modify: `crates/controller/src/api/runs.rs` (`spawn_run` n/total_vus ~515-526, unique count ~374-378)
- Modify: `crates/controller/src/grpc/coordinator.rs` (`assignment_for` ~253-296 + 분할 헬퍼 + 인라인 테스트)
- Use(무변경): `crates/controller/src/grpc/shard.rs::shard_split`

- [ ] **Step 1: 분할 헬퍼 단위 테스트 작성 (RED) — `coordinator.rs` 인라인 테스트**

```rust
#[test]
fn split_open_loop_profile_sums_exact_and_byte_identical_at_n1() {
    use handicap_proto::v1::{Profile as PbProfile, Stage as PbStage};
    let base = PbProfile {
        target_rps: Some(10),
        max_in_flight: Some(7),
        stages: vec![PbStage { target: 10, duration_seconds: 5 }],
        ..Default::default()
    };

    // N=2: 두 워커 합 == 총량, max_in_flight = vu_count 슬롯 share
    // shard_split(7,2,0)=(0,4), (1)=(4,3) → 슬롯 4+3=7
    // shard_split(10,2,0).1=5, (1).1=5 → rps 5+5=10
    let mut w0 = base.clone();
    reduce_open_loop_profile(&mut w0, /*shard_index*/0, /*shard_count*/2, /*vu_count*/4);
    let mut w1 = base.clone();
    reduce_open_loop_profile(&mut w1, 1, 2, 3);
    assert_eq!(w0.target_rps.unwrap() + w1.target_rps.unwrap(), 10);
    assert_eq!(w0.max_in_flight.unwrap(), 4);
    assert_eq!(w1.max_in_flight.unwrap(), 3);
    assert_eq!(w0.stages[0].target + w1.stages[0].target, 10);

    // N=1: byte-identical (shard_count=1 → 미변경)
    let mut solo = base.clone();
    reduce_open_loop_profile(&mut solo, 0, 1, 7);
    assert_eq!(solo, base);

    // closed-loop(미-open-loop) 프로필은 미변경 (방어)
    let closed = PbProfile { vus: 100, ..Default::default() };
    let mut c = closed.clone();
    reduce_open_loop_profile(&mut c, 0, 2, 50);
    assert_eq!(c, closed);
}
```

- [ ] **Step 2: 테스트 RED 확인**

Run: `cargo nextest run -p handicap-controller split_open_loop_profile`
Expected: FAIL ("cannot find function `reduce_open_loop_profile`").

- [ ] **Step 3: 분할 헬퍼 구현 (`coordinator.rs`)**

`assignment_for` 근처에 private 자유 함수:

```rust
/// open-loop N>1일 때 워커 i의 proto Profile을 자기 몫으로 축소한다.
/// 슬롯/동시성 = vu_count(register의 shard_split(max_in_flight,…) 결과),
/// 레이트(target_rps·각 stage.target) = shard_split(total, shard_count, i).1.
/// shard_count==1 또는 비-open-loop이면 미변경(byte-identical). (spec §3.1)
fn reduce_open_loop_profile(
    profile: &mut pb::Profile,
    shard_index: u32,
    shard_count: u32,
    vu_count: u32,
) {
    let is_open_loop = profile.target_rps.is_some() || !profile.stages.is_empty();
    if shard_count <= 1 || !is_open_loop {
        return;
    }
    // 슬롯 풀 = 이 워커의 vu_count (총 max_in_flight를 shard_split한 share).
    profile.max_in_flight = Some(vu_count);
    // 고정 레이트 분할 (Σ == 총 target_rps).
    if let Some(total) = profile.target_rps {
        profile.target_rps =
            Some(crate::grpc::shard::shard_split(total, shard_count, shard_index).1);
    }
    // 곡선 각 stage.target 분할 (선형성 → Σ 곡선 == 총 곡선).
    for s in &mut profile.stages {
        s.target = crate::grpc::shard::shard_split(s.target, shard_count, shard_index).1;
    }
}
```

`assignment_for`에서 프로필 clone을 축소: `profile: Some(a.profile.clone())` 줄을 교체:

```rust
            profile: Some({
                let mut p = a.profile.clone();
                reduce_open_loop_profile(&mut p, shard_index, shard_count, vu_count);
                p
            }),
```

- [ ] **Step 4: 분할 테스트 GREEN 확인**

Run: `cargo nextest run -p handicap-controller split_open_loop_profile` → PASS

- [ ] **Step 5: fan-out un-pin (`spawn_run` + unique count)**

`spawn_run`의 `n` 계산(결합 arm 분리 — vu-curve 먼저):

```rust
    let n = if profile.is_vu_curve() {
        1
    } else if profile.is_open_loop() {
        profile.worker_count.unwrap_or(1)
    } else {
        state.coord.worker_count_for(profile.vus)
    };
    let total_vus = if profile.is_vu_curve() {
        profile.vu_curve_max()
    } else if profile.is_open_loop() {
        profile.max_in_flight.unwrap_or(1) // 슬롯 풀을 shard_split 기준으로 (0 금지)
    } else {
        profile.vus
    };
```

unique-binding count 사이트(~374)도 같은 형태로 분리:

```rust
        let n = if profile.is_vu_curve() {
            1
        } else if profile.is_open_loop() {
            profile.worker_count.unwrap_or(1)
        } else {
            state.coord.worker_count_for(profile.vus)
        };
```

- [ ] **Step 6: HTTP 통합 테스트 (un-pin이 HTTP 경로에서 동작)**

**`crates/controller/tests/api_test.rs`**(precedent: `make_app` + `NoopDispatcher` + `StatusCode::CREATED`/`BAD_REQUEST`, ~12-17·127·163)에 새 `#[tokio::test]` 추가 — NoopDispatcher로 워커 미기동 → run `pending` 유지하므로 201 단언 가능. scenario 생성 + `POST /api/runs` 보일러플레이트를 같은 파일에서 차용해 2개 단언:

- 유효 open-loop(`target_rps`≥2, `max_in_flight`≥2, `worker_count=2`, `vus` 생략/0, `duration_seconds`>0) POST → **201**(un-pin이 n=2를 받아들이고 enqueue 성공 — 검증 통과 + dispatch Noop).
- 같은 페이로드에 `max_in_flight=1` → **400**(#3 슬롯 부족, HTTP 레이어 배선 확인).

deep한 "expected==2" 단언은 Task 3 e2e가 실제 2-워커 완주로 증명하므로 여기선 HTTP status만. (n>1 실행 경로는 Task 3 e2e가, n=1 byte-identical은 기존 open-loop 테스트가 커버.)

- [ ] **Step 7: GREEN + 전체 게이트**

Run: `cargo build -p handicap-worker && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run --workspace` → 0 에러

- [ ] **Step 8: Commit**

```bash
git add crates/controller/src/api/runs.rs crates/controller/src/grpc/coordinator.rs crates/controller/tests/api_test.rs
git commit -m "feat(open-loop): N-worker fan-out via per-worker profile split

spawn_run/unique count un-pin open-loop N=1 → worker_count.
assignment_for가 register 시 워커별 target_rps/max_in_flight/stages를
shard_split로 분할(Σ=총량). N=1 byte-identical. 메트릭/dropped 머지는 A3b 재사용.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Run: `git log -1 --stat`

---

## Task 3: 2-워커 open-loop e2e

**Files:**
- Modify: `crates/controller/tests/multi_worker_fanout_e2e.rs` (`two_worker_fanout_completes:85` 패턴 차용)

- [ ] **Step 1: e2e 테스트 작성**

기존 closed-loop `two_worker_fanout_completes`를 차용해 open-loop 버전 추가. 워커 바이너리 빌드(`worker_bin_path()` 헬퍼), 200-responder(wiremock 또는 기존 헬퍼), open-loop 프로필 `target_rps`(예 200) + `max_in_flight`(예 20) + `worker_count=2` + `vus=0` + 짧은 duration. run이 `Completed`에 도달, `dropped` 합산 노출, 메트릭이 두 워커 머지(report `summary.count > 0`) 확인.

```rust
#[tokio::test]
async fn two_worker_open_loop_fanout_completes() {
    // worker_bin_path() 빌드 + 200 responder.
    // POST /api/runs: open-loop target_rps=200, max_in_flight=20, worker_count=2, vus=0, duration=3s.
    // run terminal == Completed; /report summary.count > 0; (dropped 필드 존재).
}
```

- [ ] **Step 2: 실행 (느림 — subprocess 워커 2개)**

Run: `cargo nextest run -p handicap-controller two_worker_open_loop_fanout_completes --no-capture`
Expected: PASS (run Completed, 메트릭 머지).

- [ ] **Step 3: 전체 게이트 + Commit**

Run: `cargo nextest run --workspace`
```bash
git add crates/controller/tests/multi_worker_fanout_e2e.rs
git commit -m "test(open-loop): 2-worker open-loop fan-out e2e

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Run: `git log -1 --stat`

---

## Task 4: 포화 인사이트 워커 추천

**Files:**
- Modify: `crates/controller/src/insights.rs` (`Insight` struct + `derive_insights` 시그니처 + saturation block ~200-241)
- Modify: `crates/controller/src/report.rs` (derive_insights 호출 ~607 — 10번째 인자)
- Modify: UI `InsightSchema`(Zod, `recommended_workers` `.optional()`) + `InsightPanel.tsx` + `ko.ts` (워커 추천 렌더)

- [ ] **Step 1: Rust 단위 테스트 작성 (RED) — `insights.rs`**

```rust
#[test]
fn saturated_capacity_recommends_more_workers() {
    // dropped>0, cause=capacity(슬롯 충분), peak_observed>0, M>현재 → recommended_workers=Some(M).
    // 단일워커(worker_count_current=1) peak 1000, target 3000 → M=3.
    // (기존 헬퍼 win_count(ts, step_id, count) insights.rs:792로 windows 구성해 peak 1000;
    //  max_in_flight 충분히 크게 cause=capacity 유도 — precedent: saturated_capacity_when_slots_sufficient:895.)
    // assert: insight.recommended_workers == Some(3.0)
}

#[test]
fn saturated_peak_zero_omits_worker_rec() {
    // peak_observed=0(다초 run·count=1·dropped>0) → recommended_workers=None (div-by-zero 가드).
}

#[test]
fn saturated_m_le_current_omits_worker_rec() {
    // M <= worker_count_current(워커 늘려도 목표 미달=SUT-bound) → recommended_workers=None.
}
```

- [ ] **Step 2: RED 확인**

Run: `cargo nextest run -p handicap-controller saturated_`
Expected: FAIL (필드/로직 미구현).

- [ ] **Step 3: 구현 — `Insight` 필드 + 시그니처 + 로직**

`Insight` struct에 추가:
```rust
    /// 권장 worker_count (capacity-bound open-loop 포화 시, M > 현재일 때만). spec §4.2.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended_workers: Option<f64>,
```
`Insight::new`의 필드 초기화에 `recommended_workers: None,` 추가.

`derive_insights` 시그니처에 10번째 인자 추가(`#[allow(clippy::too_many_arguments)]` 이미 적용):
```rust
    worker_count_current: u32,
```
→ insights.rs 자체 `#[cfg(test)] mod tests`의 기존 `derive_insights(…)` 호출 ~28곳이 인자 부족으로 깨진다(컴파일러가 전부 잡음) — 각 호출 끝에 `1` 추가(기존 테스트는 단일워커 가정).

saturation block(`if dropped > 0 { … }`)의 cause=capacity 분기 — `(Some(_), Some(_)) => { ins.cause = Some("capacity".to_string()); }` arm을 확장:
```rust
            (Some(_), Some(_)) => {
                ins.cause = Some("capacity".to_string());
                // 워커 추천: per-worker 천장으로 정규화 (peak는 N워커 합산).
                // peak>0 가드(summary.rps.round() 폴백이 0일 수 있음 → inf 방지).
                let wc = worker_count_current.max(1);
                if peak > 0 {
                    if let Some(t) = target_rps {
                        let per_worker = peak as f64 / wc as f64;
                        let m = ((t as f64) / per_worker).ceil();
                        if m > wc as f64 {
                            ins.recommended_workers = Some(m);
                        }
                    }
                }
            }
```
(주의: `peak`·`target_rps` 바인딩명을 기존 saturation block의 실제 변수명에 맞춰라 — `peak`는 by_sec max, `target_rps`는 함수 인자.)

- [ ] **Step 4: 호출부 — 10번째 인자**

`derive_insights(…)` 모든 호출부에 마지막 인자 추가(컴파일러가 누락 호출부를 전부 잡음 — `grep -rn "derive_insights(" crates/controller/src/`로 확인; report.rs `build_report`가 유일 호출부일 것):
```rust
        run.profile.worker_count.unwrap_or(1),
```
Run: `cargo build -p handicap-controller 2>&1 | grep -c "this function takes"` → 0 (모든 호출부 인자 일치).

- [ ] **Step 5: Rust GREEN**

Run: `cargo nextest run -p handicap-controller saturated_` → PASS

- [ ] **Step 6: UI Zod + 렌더 + ko**

- `ui/src/api/schemas.ts`의 `InsightSchema`(:350, `recommended: z.number().optional()` :360 옆)에 `recommended_workers: z.number().optional()` 추가(응답 파싱 — 누락/존재 모두 허용, default 누출 금지).
- `ui/src/i18n/ko.ts`의 `saturation`(:320): 기존 `capacity`는 **정적 문자열**, `slots`는 **함수**(`slots(rec)` :321)다. 워커 추천은 M 보간이 필요하므로 `slots` 패턴을 따라 **함수** `capacityWithWorkers(m: number)` 신규 추가(기존 정적 `capacity`는 추천 없을 때용으로 유지): 반환 "현 워커가 포화 — 부하기(워커 CPU) 한계라면 worker_count를 ~${m}개로 올리세요. 대상 서버 한계라면 워커를 늘려도 무익(에러·지연이 함께 높으면 SUT)."
- `ui/src/components/report/InsightPanel.tsx`의 cause=capacity 분기(`actionFor` :52)에서 `recommended_workers` 있으면 `ko.saturation.capacityWithWorkers(Math.round(recommended_workers))` 렌더, 없으면 기존 정적 `ko.saturation.capacity`.
- RTL: insight에 `recommended_workers` 있는 fixture → "worker_count를 ~M개" 문구 노출 단언. (RTL fixture는 서버 실제 응답이 아니라 absent를 주니 — 여기선 *존재*를 주는 fixture로 렌더만 검증.)

- [ ] **Step 7: UI 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build` (먼저 `pnpm install` 1회 — Task 5 안내 참조)
Expected: 0 에러/경고.

- [ ] **Step 8: 전체 게이트 + Commit**

Run: `cargo nextest run --workspace`
```bash
git add crates/controller/src/insights.rs crates/controller/src/report.rs ui/
git commit -m "feat(insights): open-loop 포화 시 worker_count 추천

cause=capacity 분기에 recommended_workers (per-worker 천장 정규화 +
peak>0 가드 + M>현재일 때만). dropped==0 미emit. UI 렌더 + ko.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Run: `git log -1 --stat`

---

## Task 5: UI `worker_count` 접이식 입력

**선행:** `cd ui && pnpm install` (fresh 워크트리 node_modules 없음).

**Files:**
- Modify: `ui/src/components/loadModel.ts` (LoadProfileFields 타입 + buildLoadProfile open arm 2곳에 worker_count emit)
- Modify: `ui/src/components/LoadModelFields.tsx` (open 모드 접이식 worker_count 필드)
- Modify: `ui/src/components/RunDialog.tsx` (worker_count 상태 배선 — 필요 시)
- Modify: `ProfileSchema`(Zod, 위치 grep으로) — `worker_count: z.number().int().min(1).max(64).optional()`
- Modify: `ui/src/ko.ts` (라벨/HelpTip)
- Test: `ui/src/components/__tests__/loadModel.test.ts` + RunDialog/LoadModelFields RTL

- [ ] **Step 1: Zod + buildLoadProfile 테스트 작성 (RED) — `loadModel.test.ts`**

open 모드(고정·곡선)에서 worker_count 설정 시 `buildLoadProfile`가 `worker_count`를 emit, closed 모드에선 미emit(byte-identical) 단언. worker_count=1/미설정이면 미emit(또는 생략) 단언.

- [ ] **Step 2: RED 확인** — Run: `cd ui && pnpm test loadModel` → FAIL.

- [ ] **Step 3: 구현**

- `loadModel.ts`: `LoadProfileFields`에 `worker_count?: number` 추가; open+fixed·open+curve arm(`vus: 0` 보내는 2곳)에서 `worker_count` 있으면(>1) emit, 아니면 생략. closed arm 무변경.
- `ProfileSchema`: `worker_count: z.number().int().min(1).max(64).optional()` (`.default()` 금지 — 누출 트랩).
- `LoadModelFields.tsx`: open 모드에 접이식 고급 섹션(영역 U `ui-optional-sections-collapsible` 이디엄 — `ScenarioSnapshot`/기존 접이식 참고: 기본 접힘·값>1이면 "N개" 힌트·seed 시 펼침). number input(min 1 max 64). closed/vu-curve 미렌더.
- `ko.ts`: 라벨 "부하 생성기 워커 수 (수평 확장)" + HelpTip "한 워커가 목표 RPS를 못 내면 늘리세요. 리포트가 권장값을 알려줍니다." `it.each`류로 closed/curve 미렌더 락인(open+fixed·open+curve만 렌더).

- [ ] **Step 4: GREEN + UI 게이트**

Run: `cd ui && pnpm test loadModel` → PASS
Run: `cd ui && pnpm lint && pnpm test && pnpm build` → 0 에러/경고.

- [ ] **Step 5: Commit**

```bash
git add ui/
git commit -m "feat(ui): worker_count 접이식 입력 (open 모드 수평 확장)

LoadModelFields open 모드 고급 섹션 + ProfileSchema .optional() +
buildLoadProfile open arm emit + ko. closed/curve 미렌더 락인.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Run: `git log -1 --stat`

---

## Task 6: ADR + 인덱스 + capacity-planning §4 정정

**Files:**
- Create: `docs/adr/00NN-multi-worker-open-loop.md` (다음 번호 — `ls docs/adr/ | tail`로 확인, MADR 포맷)
- Modify: 루트 `CLAUDE.md` "알아둘 결정들" 인덱스(한 줄)
- Modify: `docs/dev/capacity-planning.md` §4(`:97-124`)

- [ ] **Step 1: ADR 작성**

다음 ADR 번호로 MADR 포맷. 결정 = "open-loop을 단일워커 v1에서 계획된 멀티워커 fan-out으로 확장(N=명시 worker_count, 컨트롤러가 register 시 shard_split로 워커별 프로필 분할, 엔진/워커/proto/migration 무변경, A3b 메트릭/dropped 머지 재사용). 반응형 HPA는 비목표 유지." 거절안(max_in_flight÷capacity 유도·target_rps÷워커당-예산·반응형) + 근거(ADR-0027 계획된 fan-out 철학·capacity-planning "측정"·ADR-0001 LoadRunner 대체)는 spec §7 참조. **결과(Consequences)에 명시**: 검증 #5(open-loop+vus>0 거절)는 공유 게이트라 **발사/저장 시점에도 재검증**(`schedule/runner.rs` fire·preset/schedule save) — 이 슬라이스 이전 손-API로 저장된 vus>0 open-loop preset/schedule은 발사/수정 시 400(UI-생성분은 vus=0이라 무영향). 의도된 동작(과거 무의미 config 마감).

- [ ] **Step 2: 루트 CLAUDE.md 인덱스 한 줄**

"알아둘 결정들"에 `- **00NN** open-loop 멀티워커 fan-out: 명시 worker_count(기본 1) + 컨트롤러 워커별 레이트 분할(shard_split) + A3b 머지 재사용, 엔진/proto/migration 무변경` 추가.

- [ ] **Step 3: capacity-planning.md §4 정정**

§4(`:101`·`:106`)의 "프로필 복제 → 합계 target_rps × N"·"큰 vus → N>1 워커 사고" 서술을 **정정**: ① 옛 서술이 현 코드를 잘못 기술했음(open-loop은 N=1로 핀됐었음) ② 새 동작 — `worker_count`로 명시 fan-out, `target_rps`가 워커별 분할돼 합=목표, `vus`는 open-loop에서 무시(검증이 vus>0 거절). "수평 확장이 필요하면 closed-loop" 안내도 "open-loop도 worker_count로 수평 확장 가능"으로 보강.

- [ ] **Step 4: Commit (docs-only — fast-path)**

```bash
git add docs/adr/ CLAUDE.md docs/dev/capacity-planning.md
git commit -m "docs(open-loop): ADR 멀티워커 fan-out + CLAUDE.md 인덱스 + capacity-planning §4 정정

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Run: `git log -1 --stat`

---

## 머지 전 마무리 (모든 Task 후)

1. **라이브 검증** (`/live-verify` 스택, spec §6.4): 워크트리 자체 바이너리 + 200-responder + 격리 DB. open-loop `target_rps=4000, worker_count=2, max_in_flight≥40, vus=0` run → `summary.rps ≈ 4000`(단일워커 천장의 ~2배), `dropped` 합산, 메트릭 머지. UI: RunDialog 접이식 worker_count 입력 → run → 리포트, 콘솔 Zod 0. 인사이트: 작은 max_in_flight로 포화 유발 → 워커 추천 문구 노출 확인. (`browser_evaluate` 인라인 — 저장-경로 의존 회피.)
2. **handicap-reviewer** 최종 whole-feature 리뷰(repo-trap-aware, 와이어 1:1·deferral 추적·게이트 재확인) → READY-TO-MERGE까지.
3. **docs 갱신**: `docs/build-log.md` 한 단락 append + `docs/roadmap.md` §현재 상태/§A 갱신(멀티워커 open-loop 완료, worker_count 상한 64 → §B2'' 운영 상한 관리자 화면에 추가) + 루트 CLAUDE.md 상태줄 한 줄 교체.
4. **머지**: master ff-merge(워크트리 안에서 `git -C /Users/sgj/develop/handicap merge --ff-only <branch>`, 사전 ancestor·clean 확인) → `ExitWorktree(remove, discard_changes:true)`. 플레이라이트 잔류 정리(`rm -rf .playwright-mcp` + 루트 png).

> **참고**: 워크트리/브랜치명이 `open-loop-vus-misconfig-guard`(설계 전환 전 명칭)라 실제 슬라이스(멀티워커 open-loop)와 불일치 — 로컬 ff-merge 후 브랜치 폐기되므로 무해(remote 없음). 커밋/spec/plan/ADR은 정확한 이름 사용.

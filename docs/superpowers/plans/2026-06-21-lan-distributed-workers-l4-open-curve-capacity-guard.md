# LAN 분산 워커 L4 — open-loop/곡선 과부하 가드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** L3의 capacity 과부하 가드(closed-loop 전용)를 open-loop(고정+곡선) 풀 배정으로 확장 — 슬롯(`max_in_flight`)을 워커 `capacity_vus` 비례로 분배하고, 레이트를 슬롯 비례(고정=min-1 floored)로 나누며, 용량 부족 시 L3와 동일한 409 + 줄여진행/강행 UX를 제공한다.

**Architecture:** L3 기계장치(`capacity_split`/`reserve_idle_pool_capacity`/`PoolReservation`/`precomputed_counts`/409 `{achievable_vus,requested_vus}`/`PoolCapacityError`/`?force`/RunDialog 다이얼로그) 재사용. 신규 표면 = `Profile` 접근자 2개(`concurrency_demand`/`pool_worker_cap`) + 순수 함수 2개(`proportional_split`/`proportional_split_min1`) + `reserve_idle_pool_capacity`/`pool_achievable_capacity` 2-param 일반화 + `reduce_open_loop_profile` 5번째 인자 + UI mode 분기. 엔진·proto·워커·migration 무변경.

**Tech Stack:** Rust(컨트롤러 `crates/controller`) + TypeScript/React(`ui/`). 게이트 = `cargo nextest`/`clippy -D warnings` + `pnpm lint && pnpm test && pnpm build`.

## Global Constraints (spec §5, 전 task 암묵 포함)

- **proto·worker(`crates/worker`,`worker-core`)·엔진(`crates/engine`)·migration·DB 스키마·`shard_split`/`worker_count`/`capacity_split`/`achievable_capacity`/`dataset_slice`·`check_token` 무변경.**
- **조건부 byte-identical**: 균등 cap 풀 + `rate_peak ≥ max_in_flight` → ADR-0038 풀 open-loop과 byte-identical. closed-loop(고정·곡선·VU곡선)·비-풀(subprocess/k8s)·`?force` 경로 결과 불변.
- **`reserve_idle_pool_capacity`는 arity만 변경**(부분집합 일반화), **`pool_achievable_capacity`는 arity + `sort`/부분집합 추가**(reserve와 같은 first-N 집합을 보게 — 동작 추가지만 closed `worker_cap≥idle`이면 Σ 불변이라 closed 결과 재현). closed 호출은 `worker_cap==slot_total==vus`. 기존 closed 단위테스트는 호출부 arity만 갱신(단언 불변).
- **신규/수정 UI 문구는 전부 `ko.*` 경유**(ADR-0035 인라인 0), open-loop은 슬롯/동시 요청 워딩(VU 아님).
- **커밋 게이트**: cargo-영향 커밋은 전체 워크스페이스 게이트(수 분). 각 task는 **독립 green 커밋**. `git commit`은 `run_in_background:false` 단일 호출(폴링 금지), 파이프 없이.
- **R-id**는 spec `docs/superpowers/specs/2026-06-21-lan-distributed-workers-l4-open-curve-capacity-guard-design.md` §2를 참조.

---

## File Structure

- `crates/controller/src/grpc/shard.rs` — 순수 분배 산술. 신규 `proportional_split`·`proportional_split_min1` (기존 `shard_split`/`capacity_split`/`achievable_capacity` 옆).
- `crates/controller/src/store/runs.rs` — `Profile` 접근자 신규 `concurrency_demand`·`pool_worker_cap` (기존 `is_open_loop`/`is_vu_curve`/`vu_curve_max` 옆).
- `crates/controller/src/grpc/coordinator.rs` — `reserve_idle_pool_capacity`/`pool_achievable_capacity` 2-param 일반화 + `reduce_open_loop_profile` 5번째 인자(`assignment_for`가 weights 전달).
- `crates/controller/src/api/runs.rs` — `spawn_run` 사전검사 + fork 조건 확대(`!is_vu_curve()`).
- `crates/controller/tests/pool_open_loop_capacity_test.rs` — 신규 통합 테스트(L3 `pool_capacity_guard_test.rs` 하니스 미러).
- `ui/src/components/RunDialog.tsx` — open 프리뷰 힌트 + 409 다이얼로그 mode 분기.
- `ui/src/i18n/ko.ts` — `ko.capacityGuard` mode-aware 워딩.
- `docs/dev/lan-workers.md` — §4/§8 갱신.

---

## Task 1: 순수 함수 + Profile 접근자

**Files:**
- Modify: `crates/controller/src/grpc/shard.rs` (신규 `proportional_split`·`proportional_split_min1` + 인라인 `#[cfg(test)] mod tests` 확장)
- Modify: `crates/controller/src/store/runs.rs` (`Profile` impl에 `concurrency_demand`·`pool_worker_cap` + 인라인 테스트)

**Interfaces:**
- Produces: `pub fn proportional_split(total: u32, weights: &[u32]) -> Vec<u32>`; `pub fn proportional_split_min1(total: u32, weights: &[u32]) -> Vec<u32>` (둘 다 `grpc/shard.rs`). `Profile::concurrency_demand(&self) -> u32`; `Profile::pool_worker_cap(&self) -> u32`.
- Consumes: 기존 `shard::shard_split(total_vus: u32, n: u32, i: u32) -> (u32, u32)`; `Profile::{is_open_loop, is_vu_curve, vu_curve_max}` + 필드 `vus: u32`, `target_rps: Option<u32>`, `max_in_flight: Option<u32>`, `stages: Option<Vec<Stage>>`(각 `Stage{ target: u32, .. }`).

**충족 R: R1, R2, R7(불변식 일부).**

- [ ] **Step 1: `shard.rs`에 두 함수의 실패 테스트 작성**

`crates/controller/src/grpc/shard.rs`의 `#[cfg(test)] mod tests`에 추가:

```rust
    #[test]
    fn proportional_split_sums_and_is_deterministic() {
        // 비례·Σ==total·결정적
        assert_eq!(proportional_split(30, &[5, 25]), vec![5, 25]);
        assert_eq!(proportional_split(10, &[5, 25]), vec![2, 8]);
        // 0-share 허용(작은 weight가 0으로 반올림): 곡선 stage용
        assert_eq!(proportional_split(3, &[1, 25]), vec![0, 3]);
        for &(total, ref w) in &[(7u32, vec![1u32, 1, 1]), (100, vec![3, 7, 11])] {
            assert_eq!(proportional_split(total, w).iter().sum::<u32>(), total);
        }
        assert!(proportional_split(10, &[]).is_empty());
    }

    #[test]
    fn proportional_split_equals_shard_split_when_uniform() {
        // 균등 weights → shard_split per-worker(앞 total%n개 +1)와 동일 (R7 byte-identical)
        for &(total, n) in &[(5u32, 2u32), (7, 3), (10, 4), (1, 1), (100, 7)] {
            let w = vec![1u32; n as usize];
            let even: Vec<u32> = (0..n).map(|i| shard_split(total, n, i).1).collect();
            assert_eq!(proportional_split(total, &w), even, "total={total} n={n}");
        }
        assert_eq!(proportional_split(5, &[1, 1]), vec![3, 2]);
        assert_eq!(proportional_split(7, &[1, 1, 1]), vec![3, 2, 2]);
    }

    #[test]
    fn proportional_split_min1_floors_each_at_one() {
        // 이질 cap·저 rate: 순수 비례면 [0,3]이지만 min1은 0-share 금지 → [1,2]
        assert_eq!(proportional_split_min1(3, &[1, 25]), vec![1, 2]);
        let out = proportional_split_min1(3, &[2, 8]);
        assert!(out.iter().all(|&r| r >= 1), "every worker >= 1: {out:?}");
        assert_eq!(out.iter().sum::<u32>(), 3);
        // total < n → 방어 fallback(proportional_split, 0 허용)
        assert_eq!(proportional_split_min1(1, &[1, 1]), proportional_split(1, &[1, 1]));
    }

    #[test]
    fn proportional_split_min1_equals_shard_split_when_uniform() {
        for &(total, n) in &[(5u32, 2u32), (7, 3), (10, 4), (1, 1)] {
            let w = vec![1u32; n as usize];
            let even: Vec<u32> = (0..n).map(|i| shard_split(total, n, i).1).collect();
            assert_eq!(proportional_split_min1(total, &w), even, "total={total} n={n}");
        }
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cargo test -p handicap-controller --lib grpc::shard::tests::proportional 2>&1 | tail -20`
Expected: FAIL — `cannot find function proportional_split`.

- [ ] **Step 3: 두 함수 구현**

`crates/controller/src/grpc/shard.rs`에 (`capacity_split` 아래) 추가:

```rust
/// Distribute `total` across `weights` proportionally (largest-remainder, ties
/// broken by ascending index). Σ == total, deterministic. When all weights are
/// equal the result equals `shard_split`'s per-worker counts (front-loaded
/// remainder) — byte-identical construction (spec R2/R7). Zero shares ARE
/// allowed (a small weight may round to 0); used for open-loop **curve**
/// stage.target where the engine polls a zero-rate stage. (spec §4.2.)
pub fn proportional_split(total: u32, weights: &[u32]) -> Vec<u32> {
    let n = weights.len();
    if n == 0 {
        return Vec::new();
    }
    let sum_w: u64 = weights.iter().map(|&w| w as u64).sum();
    if sum_w == 0 {
        // defensive: degenerate weights → even split
        return (0..n as u32).map(|i| shard_split(total, n as u32, i).1).collect();
    }
    let total64 = total as u64;
    let mut alloc: Vec<u32> = Vec::with_capacity(n);
    let mut rems: Vec<(u64, usize)> = Vec::with_capacity(n); // (fractional remainder, index)
    let mut assigned: u64 = 0;
    for (i, &w) in weights.iter().enumerate() {
        let num = total64 * w as u64;
        let q = num / sum_w;
        alloc.push(q as u32);
        assigned += q;
        rems.push((num % sum_w, i));
    }
    let mut rem_units = total64 - assigned; // < n
    // largest remainder first; ascending index on ties (front-loaded like shard_split)
    rems.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    for &(_, i) in rems.iter() {
        if rem_units == 0 {
            break;
        }
        alloc[i] += 1;
        rem_units -= 1;
    }
    alloc
}

/// Like `proportional_split` but every worker gets **at least 1** (no zero
/// share), used for open-loop **fixed** `target_rps`: the engine clamps a
/// zero-rate fixed worker to >=1 rps (`runner.rs:1093` `.max(1)`), so a 0-share
/// would over-fire. Caller guarantees `total >= n` via the rate-bound
/// `pool_worker_cap = min(max_in_flight, rate_peak)` (N <= rate_peak <= total);
/// if `total < n` (or weights sum 0) it falls back to `proportional_split`
/// (defensive). Σ == total, uniform weights == `shard_split`. (spec §3.4/§4.2.)
pub fn proportional_split_min1(total: u32, weights: &[u32]) -> Vec<u32> {
    let n = weights.len();
    if n == 0 {
        return Vec::new();
    }
    let sum_w: u64 = weights.iter().map(|&w| w as u64).sum();
    if (total as usize) < n || sum_w == 0 {
        return proportional_split(total, weights);
    }
    // base 1 each, distribute the remaining (total - n) proportionally.
    let extra = proportional_split(total - n as u32, weights);
    extra.iter().map(|&e| e + 1).collect()
}
```

- [ ] **Step 4: shard 테스트 통과 확인**

Run: `cargo test -p handicap-controller --lib grpc::shard::tests 2>&1 | tail -20`
Expected: PASS (신규 4개 + 기존 `capacity_split`/`shard_split` 테스트 전부).

- [ ] **Step 5: `Profile` 접근자 실패 테스트 작성**

`crates/controller/src/store/runs.rs`의 인라인 `#[cfg(test)] mod tests`(없으면 생성)에 추가. **주의: 스토어 `Profile`은 `Default`를 derive하지 않는다**(`runs.rs:107` `#[derive(Debug, Clone, Serialize, Deserialize)]`) → `..Default::default()` 불가. 기존 전체-리터럴 패턴(`runs.rs:511`의 ~18필드 리터럴)을 복사해 `profile_fixture` 헬퍼를 만들 것. (prost `PbProfile`[coordinator.rs]은 `..Default::default()` 되지만 *다른 타입* — 혼동 금지.)

```rust
    #[test]
    fn concurrency_demand_by_mode() {
        // closed: vus
        let p = profile_fixture(|p| { p.vus = 50; });
        assert_eq!(p.concurrency_demand(), 50);
        // open fixed: max_in_flight
        let p = profile_fixture(|p| { p.vus = 0; p.target_rps = Some(100); p.max_in_flight = Some(20); });
        assert_eq!(p.concurrency_demand(), 20);
    }

    #[test]
    fn pool_worker_cap_by_mode() {
        // closed: vus
        let p = profile_fixture(|p| { p.vus = 50; });
        assert_eq!(p.pool_worker_cap(), 50);
        // open fixed: min(max_in_flight, target_rps)
        let p = profile_fixture(|p| { p.vus = 0; p.target_rps = Some(3); p.max_in_flight = Some(30); });
        assert_eq!(p.pool_worker_cap(), 3);
        let p = profile_fixture(|p| { p.vus = 0; p.target_rps = Some(100); p.max_in_flight = Some(20); });
        assert_eq!(p.pool_worker_cap(), 20);
        // open curve: min(max_in_flight, max(stage.target))
        let p = profile_fixture(|p| {
            p.vus = 0; p.max_in_flight = Some(30);
            p.stages = Some(vec![stage(10, 5), stage(40, 5)]);
        });
        assert_eq!(p.pool_worker_cap(), 30); // min(30, 40)
    }
```

`profile_fixture(|p: &mut Profile| ...)`는 `runs.rs:511`의 전체-필드 리터럴로 baseline `Profile`을 만든 뒤 클로저로 필드를 덮는 헬퍼(Default 없음 — 전 필드 명시). `stage(target, dur)`는 `Stage { target, duration_seconds: dur }` 리터럴.

- [ ] **Step 6: 접근자 테스트 실패 확인**

Run: `cargo test -p handicap-controller --lib store::runs 2>&1 | tail -20`
Expected: FAIL — `no method named concurrency_demand`.

- [ ] **Step 7: 접근자 구현**

`crates/controller/src/store/runs.rs`의 `impl Profile`(또는 `is_open_loop` 등이 있는 곳)에 추가:

```rust
    /// 풀 동시성 수요 = capacity_split 입력 + 사전검사 demand.
    /// closed: vus, open(고정+곡선): max_in_flight, vu-curve: vu_curve_max(가드 미호출·완전성).
    pub fn concurrency_demand(&self) -> u32 {
        if self.is_vu_curve() {
            self.vu_curve_max()
        } else if self.is_open_loop() {
            self.max_in_flight.unwrap_or(1)
        } else {
            self.vus
        }
    }

    /// 풀 N 상한(레이트-상한). 고정 모드서 0-share 워커(엔진 .max(1) 초과 발사)를
    /// 막으려면 N <= rate_peak이어야 한다. **풀 전용 — ADR-0038 `worker_count`
    /// (비-풀 fan-out) 노브와 무관.** closed: vus, open: min(max_in_flight, rate_peak).
    pub fn pool_worker_cap(&self) -> u32 {
        if self.is_vu_curve() {
            self.vu_curve_max()
        } else if self.is_open_loop() {
            let rate_peak = self.target_rps.unwrap_or_else(|| {
                self.stages
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .map(|s| s.target)
                    .max()
                    .unwrap_or(1)
            });
            self.max_in_flight.unwrap_or(1).min(rate_peak)
        } else {
            self.vus
        }
    }
```

- [ ] **Step 8: 접근자 테스트 통과 확인**

Run: `cargo test -p handicap-controller --lib store::runs 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 9: 게이트 + 단일 green 커밋**

Run: `cargo clippy -p handicap-controller --all-targets -- -D warnings 2>&1 | tail -5` (Expected: clean)
Run: `cargo test -p handicap-controller --lib 2>&1 | tail -5` (Expected: PASS)

```bash
git add crates/controller/src/grpc/shard.rs crates/controller/src/store/runs.rs
git commit -m "feat(lan-l4): proportional_split(+min1) + Profile concurrency_demand/pool_worker_cap (R1,R2)"
```
Run after: `git log -1 --oneline` (커밋 landed 확인).

---

## Task 2: 컨트롤러 open-loop capacity 배정 + 가드 확장

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` — `reserve_idle_pool_capacity`(412), `pool_achievable_capacity`(397), `reduce_open_loop_profile`(873), `assignment_for`(597 호출부), 기존 인라인 테스트 호출부.
- Modify: `crates/controller/src/api/runs.rs` — `spawn_run` 사전검사(509), fork(643-644).
- Create: `crates/controller/tests/pool_open_loop_capacity_test.rs` — 통합 테스트.

**Interfaces:**
- Consumes (Task 1): `shard::proportional_split`, `shard::proportional_split_min1`, `Profile::concurrency_demand`, `Profile::pool_worker_cap`.
- Consumes (기존): `reserve_idle_pool_capacity(&self, run_id: &str, total_vus: u32) -> PoolReservation` → **2-param으로 변경**; `pool_achievable_capacity(&self) -> (usize, u32)` → **worker_cap 인자 추가**; `PoolReservation::{Reserved{workers, counts}, Insufficient{achievable}}`; `RunWorkers.precomputed_counts: Option<Vec<(u32,u32)>>`; `reduce_open_loop_profile(profile, shard_index, shard_count, vu_count)` → **5번째 `slot_weights` 추가**; `ApiError::ConflictJson(serde_json::Value)`.
- Produces: 새 시그니처 `reserve_idle_pool_capacity(&self, run_id, worker_cap: u32, slot_total: u32)`; `pool_achievable_capacity(&self, worker_cap: u32)`; `reduce_open_loop_profile(profile, shard_index, shard_count, vu_count, slot_weights: Option<&[u32]>)`.

**충족 R: R3, R4, R5, R6, R11, R13.**

- [ ] **Step 1: `reserve_idle_pool_capacity` 2-param 일반화**

`crates/controller/src/grpc/coordinator.rs:412` 시그니처를 `pub async fn reserve_idle_pool_capacity(&self, run_id: &str, worker_cap: u32, slot_total: u32) -> PoolReservation`로. 본문(spec §4.3):
- 빈-풀 분기(현 425-430) 유지.
- `let n = idle.len().min(worker_cap as usize);`  (현 438 `total_vus`→`worker_cap`)
- `let achievable = shard::achievable_capacity(&caps[..n]);`  (현 432는 전체 `&caps` → **`&caps[..n]` 부분집합으로**)
- `if achievable < slot_total { return PoolReservation::Insufficient { achievable }; }`  (현 434 `total_vus`→`slot_total`)
- `let split = shard::capacity_split(slot_total, &caps[..n]);`  (현 439 `total_vus`→`slot_total`)
- 나머지(누적합 counts·`assigned_run=Some`·`Reserved`) 동일.

- [ ] **Step 2: `pool_achievable_capacity` worker_cap 인자화**

`coordinator.rs:397` → `pub async fn pool_achievable_capacity(&self, worker_cap: u32) -> (usize, u32)`. 본문: 유휴 caps를 **worker_id 정렬**(reserve와 동일 순서) 후 `let n = caps.len().min(worker_cap as usize); (caps.len(), shard::achievable_capacity(&caps[..n]))`. (현재 정렬이 없으면 reserve의 `idle.sort_by(|a,b| a.0.cmp(&b.0))` 패턴을 미러 — 부분집합이 reserve와 같은 워커를 보게.)

- [ ] **Step 3: `reduce_open_loop_profile` slot_weights(R4)**

`coordinator.rs:873` 시그니처에 5번째 `slot_weights: Option<&[u32]>`. 본문(spec §4.3):
- 고정(887): `if let Some(total) = profile.target_rps { profile.target_rps = Some(match slot_weights { Some(w) => shard::proportional_split_min1(total, w)[shard_index as usize], None => shard::shard_split(total, shard_count, shard_index).1 }); }`
- 곡선(891): `for s in &mut profile.stages { s.target = match slot_weights { Some(w) => shard::proportional_split(s.target, w)[shard_index as usize], None => shard::shard_split(s.target, shard_count, shard_index).1 }; }`
- 슬롯(884 `max_in_flight = Some(vu_count)`) 무변경. `shard_count <= 1 || !is_open_loop` early-return(880) 유지.

- [ ] **Step 4: `assignment_for`가 weights 도출·전달**

`coordinator.rs:597` 호출부를 (rw가 566에서 잡혀 있음):

```rust
            profile: Some({
                let mut p = a.profile.clone();
                let slot_weights: Option<Vec<u32>> = rw
                    .precomputed_counts
                    .as_ref()
                    .map(|c| c.iter().map(|(_, cnt)| *cnt).collect());
                reduce_open_loop_profile(&mut p, shard_index, shard_count, vu_count, slot_weights.as_deref());
                p
            }),
```

- [ ] **Step 5: `spawn_run` 사전검사 + fork 확대**

`crates/controller/src/api/runs.rs`:
- 사전검사(509): 조건 `state.coord.is_pool_mode() && !force && !profile.is_open_loop() && !profile.is_vu_curve()` → **`state.coord.is_pool_mode() && !force && !profile.is_vu_curve()`**. 본문:

```rust
        let (idle, achievable) = state.coord.pool_achievable_capacity(profile.pool_worker_cap()).await;
        let demand = profile.concurrency_demand();
        if idle > 0 && demand > achievable {
            return Err(ApiError::ConflictJson(serde_json::json!({
                "achievable_vus": achievable,
                "requested_vus": demand,
            })));
        }
```

- fork(643-644): `let closed = !profile.is_open_loop() && !profile.is_vu_curve();` → **`let guarded = !profile.is_vu_curve();`**. capacity 경로 호출을 `reserve_idle_pool_capacity(&row.id, profile.pool_worker_cap(), profile.concurrency_demand())`로(2-param). `if closed && !force` → `if guarded && !force`. `enqueue`에 넘기는 `total_vus`는 **기존 로컬(633-639)을 그대로** 재사용(= `concurrency_demand()`와 동치; 두 번째 소스 만들지 말 것 — 동치 주석 1줄). `else` 분기(legacy/force/vu-curve)는 무변경(R6·R11).
- **`Insufficient` arm 메시지 수정(659-665 근처, guarded 브랜치 내부)**: 현 `format!("풀 용량 부족 (가용 {achievable} VU < 요청 {} VU)", profile.vus)`는 open-loop(vus=0)면 "요청 0 VU"로 거짓 → `profile.vus` → **`profile.concurrency_demand()`**(open이면 max_in_flight)로 교체. (이 arm은 `else` 무변경 범위가 아니라 capacity 경로 TOCTOU 폴백이라 손봐야 함.)

- [ ] **Step 6: 기존 단위테스트 호출부 arity 갱신(3 함수)**

`grep -n "reserve_idle_pool_capacity\|pool_achievable_capacity\|reduce_open_loop_profile" crates/controller/src/grpc/coordinator.rs`로 전 호출부 확인 후:
- `reserve_idle_pool_capacity("run-x", 30)` → `reserve_idle_pool_capacity("run-x", 30, 30)`(closed: worker_cap=slot_total). `pool_achievable_capacity()` → `pool_achievable_capacity(<해당 vus>)`. **단언값 변경 금지**(컴파일만 — 동작 동일).
- **`reduce_open_loop_profile(.., shard_index, shard_count, vu_count)` 기존 테스트 호출부 7곳(grep 결과 = 1601/1603/1611/1620/1649/1651/1663; production `assignment_for`:597은 Step 4가 처리)에 5번째 `None` 추가** — `None` arm은 legacy `shard_split` 균등이라 기존 단언(`w0.target_rps`/`stages[0].target` 등) **그대로 통과**. 이건 단순 컴파일 정합이고, 비례/min1 새 단언은 Step 7에서 `Some(&weights)` 경로로 *추가*한다.

- [ ] **Step 7: per-worker 슬롯/레이트 정밀 단언 = `coordinator.rs` 인라인 단위테스트**

**중요(plan-reviewer)**: subprocess e2e 하니스(`pool_capacity_guard_test.rs`/`pool_e2e.rs`)는 **집계(`report.summary.count`/`rps`)·run-row·HTTP status만** 관측 가능 — per-worker `target_rps`/`stage.target`/`vu_count`를 못 본다. 따라서 정확한 분배값(`[6,24]`/`[5,25]`/`[1,2]`/`capacity_split`)은 **인라인 단위테스트**로 검증한다. 오라클 = 기존 `coordinator.rs` 인라인 테스트: `split_open_loop_profile_*`/`split_curve_only_*`(1586-1665, `reduce_open_loop_profile` 호출 후 `w0.target_rps`/`w0.stages[0].target`/`w0.max_in_flight` 단언) + `reserve_capacity_*`(2260-2302, `reserve_idle_pool_capacity` 후 `counts` 단언). 그 패턴으로 **신규 인라인 테스트 추가**(`Some(&weights)` 경로):

```rust
    // reduce_open_loop_profile에 Some(weights) 전달 시 비례/min1 (기존 split_* 테스트 미러)
    #[test]
    fn reduce_open_loop_fixed_uses_min1_with_weights() {
        let mut p = open_fixed_pb(/*target_rps*/ 30, /*max_in_flight*/ 30); // 기존 PbProfile fixture
        reduce_open_loop_profile(&mut p, /*shard_index*/ 0, /*shard_count*/ 2, /*vu_count*/ 5, Some(&[5, 25]));
        assert_eq!(p.target_rps, Some(6)); // proportional_split_min1(30,[5,25])[0]
        let mut p1 = open_fixed_pb(30, 30);
        reduce_open_loop_profile(&mut p1, 1, 2, 25, Some(&[5, 25]));
        assert_eq!(p1.target_rps, Some(24)); // [1] ; Σ=30
    }
    #[test]
    fn reduce_open_loop_fixed_min1_no_zero_heterogeneous() {
        let mut p = open_fixed_pb(3, 26);
        reduce_open_loop_profile(&mut p, 0, 2, 1, Some(&[1, 25]));
        assert_eq!(p.target_rps, Some(1)); // min1: 작은 슬롯도 >=1 (순수 비례면 0 → clamp 초과)
    }
    #[test]
    fn reduce_open_loop_curve_uses_proportional_with_weights() {
        let mut p = open_curve_pb(/*stage target*/ 30); // 기존 PbProfile stages fixture
        reduce_open_loop_profile(&mut p, 0, 2, 5, Some(&[5, 25]));
        assert_eq!(p.stages[0].target, 5); // proportional_split(30,[5,25])[0]
    }
    #[test]
    fn reduce_open_loop_none_is_legacy_shard_split() {
        // None arm = 기존 동작 (회귀 가드, 위 split_* 테스트와 동일 의미)
        let mut p = open_fixed_pb(10, 6);
        reduce_open_loop_profile(&mut p, 0, 2, 3, None);
        assert_eq!(p.target_rps, Some(shard_split(10, 2, 0).1));
    }
    // reserve_idle_pool_capacity(worker_cap, slot_total) 슬롯 분배 (기존 reserve_capacity_* 미러)
    #[tokio::test]
    async fn reserve_open_loop_slots_capacity_split() {
        // 워커 cap [5,25] 등록, worker_cap=30(=min(30,30)), slot_total=30
        // → counts == capacity_split(30,[5,25]) == [(0,5),(5,25)]
    }
```

`open_fixed_pb`/`open_curve_pb`는 기존 `split_open_loop_profile_*` 테스트의 `PbProfile` 리터럴(`target_rps`/`max_in_flight`/`stages` 세팅, `..Default::default()` 가능 — prost 타입)을 헬퍼화한 것.

- [ ] **Step 8: e2e-관측 가능 동작 = `pool_open_loop_capacity_test.rs` 통합테스트**

`crates/controller/tests/pool_open_loop_capacity_test.rs` 신규 — 하니스는 `pool_capacity_guard_test.rs` 미러(풀 워커 N대 명시 `capacity_vus` 등록·`--worker-mode pool`·`POST /api/runs`). **집계/status/run-row만** 단언(per-worker 분배는 Step 7 단위테스트가 소유):

```rust
// 페이로드: open fixed = {"profile":{"duration_seconds":S,"target_rps":R,"max_in_flight":M}} (vus 생략)
//           curve = {... "stages":[{"target":T,"duration_seconds":D}]}.

#[tokio::test]
async fn pool_open_loop_insufficient_returns_409() {
    // cap [5,5], max_in_flight=20, target_rps=40 → HTTP 409, body {achievable_vus:10, requested_vus:20}, runs::get None.
}
#[tokio::test]
async fn pool_open_loop_zero_idle_400() {
    // 유휴 0 → 기존 빈-풀 400 (409 아님).
}
#[tokio::test]
async fn pool_open_loop_force_skips_guard() {
    // cap [5,5], max_in_flight=20, target_rps=40, ?force=true → 201 (run 생성).
}
#[tokio::test]
async fn pool_open_loop_assigns_capacity_aware() {
    // cap [5,25], max_in_flight=8, target_rps=16 → 201 + run 완료(집계 count>0, error 0). (정확 슬롯은 Step 7)
}
#[tokio::test]
async fn pool_open_loop_no_zero_rate_fixed_aggregate() {
    // cap [2,8], max_in_flight=10, target_rps=3 (저-rate) → 201 + 관측 총 rps ≈ 3(초과 없음).
    // min1이 아니었다면(순수 비례) 0-share clamp로 ~4 rps. report.summary.rps로 근사 판별(tolerance).
}
```

하니스의 정확한 등록·관측 패턴은 `pool_capacity_guard_test.rs`를 따른다(집계·status·run-row 한정).

- [ ] **Step 9: 빌드/테스트 정합 확인**

Run: `cargo build -p handicap-worker --bin worker 2>&1 | tail -3` (e2e 워커 워밍, cold-build race 회피)
Run: `cargo test -p handicap-controller --lib grpc::coordinator 2>&1 | tail -20` (Step 7 인라인 단위 PASS)
Run: `cargo test -p handicap-controller --test pool_open_loop_capacity_test 2>&1 | tail -30` (Step 8 통합 PASS)
Expected: 전부 PASS (구현이 Step 1-6에서 됨; RED→GREEN 로컬 확인, 커밋은 1회).

- [ ] **Step 10: 전체 게이트 + 단일 green 커밋**

Run: `cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -5` (clean)
Run: `cargo nextest run -p handicap-controller 2>&1 | tail -15` (기존 closed 풀/fan-out·`split_*`/`reserve_capacity_*` 포함 전부 green — 회귀 0)
Run: `cargo build -p handicap-controller --features bundle 2>&1 | tail -3` (bundle 빌드 깨짐 없음)

```bash
git add crates/controller/src/grpc/coordinator.rs crates/controller/src/api/runs.rs crates/controller/tests/pool_open_loop_capacity_test.rs
git commit -m "feat(lan-l4): open-loop pool capacity guard — 2-param reserve, proportional/min1 rate, precheck (R3,R4,R5,R6,R11,R13)"
```
Run after: `git log -1 --oneline`.

---

## Task 3: UI 프리뷰 + 409 확인 다이얼로그 확장

**Files:**
- Modify: `ui/src/components/RunDialog.tsx` — open 프리뷰 힌트(547 근처) + 409 다이얼로그 mode 분기(802-849, clamp 816).
- Modify: `ui/src/i18n/ko.ts` — `ko.capacityGuard`(160-170) mode-aware 워딩.
- Modify/Create: `ui/src/components/__tests__/RunDialog*.test.tsx` — RTL.

**Interfaces:**
- Consumes (기존, 변경 없음): `PoolCapacityError`(client.ts:33, `{achievable_vus, requested_vus}` 보유), `createRun(payload, { force?: boolean })`(client.ts), `useCreateRun`(hooks.ts), `usePoolWorkers`(L2), `Profile` Zod(`vus`·`max_in_flight` 둘 다 존재).

**충족 R: R8, R9, R10.**

- [ ] **Step 1: RTL 실패 테스트 작성**

`ui/src/components/__tests__/`의 기존 RunDialog 테스트 파일(L3 capacity 테스트가 있는 곳)에 추가:

```tsx
  it("open+fixed: max_in_flight > 풀 총용량이면 제출 전 힌트", () => {
    // usePoolWorkers mock: idle 2대 cap 5 → X=10. open+fixed max_in_flight=20.
    // expect: 초과 힌트 텍스트(ko.capacityGuard.overHint류) 보임.
  });
  it("open+curve: max_in_flight > X 힌트", () => { /* stages 채우고 max_in_flight=20 */ });
  it("open+fixed: max_in_flight <= X면 힌트 없음", () => { /* max_in_flight=8, X=10 */ });
  it("open 409 → 줄여 진행이 max_in_flight를 achievable로 clamp(target_rps 유지)", async () => {
    // createRun mock이 PoolCapacityError{achievable_vus:10, requested_vus:20} throw.
    // 다이얼로그 [줄여 진행] 클릭 → createRun 2번째 호출 payload.profile.max_in_flight===10,
    // target_rps 불변, vus 미설정. 안내문(슬롯만 축소) 보임.
  });
  it("open 409 → 강행이 ?force=true로 동일 페이로드 재전송", async () => { /* force:true */ });
  it("비-풀이면 힌트 미표시", () => {});
```

L3의 closed-fixed 힌트/clamp 테스트가 이미 있으면 그 패턴을 복사. mock 방법(usePoolWorkers·createRun)은 기존 테스트 미러.

- [ ] **Step 2: 실패 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/lan-workers-l4/ui && pnpm test RunDialog 2>&1 | tail -20`
Expected: FAIL (신규 케이스).

- [ ] **Step 3: 프리뷰 힌트 open 확장**

`RunDialog.tsx`의 프리뷰 힌트(현 `closedFixed && Number(vus) > idleCapacity` 류, ~547)에 open 분기 추가: open(고정·곡선)이고 `Number(maxInFlight) > idleCapacity`면 동일 힌트(`ko.capacityGuard.overHint` mode-aware). `idleCapacity`(Σ유휴 cap) 재사용. 비-풀·`max_in_flight` 미설정 = 미표시.

- [ ] **Step 4: 409 다이얼로그 mode 분기**

`RunDialog.tsx`의 409 clamp(현 816 `{ ...built, vus: poolConflict.achievable }`)를 mode 분기:

```tsx
const clamped = isOpenLoop
  ? { ...built, max_in_flight: poolConflict.achievable }
  : { ...built, vus: poolConflict.achievable };
```

다이얼로그 본문/clamp 버튼 라벨을 open이면 `ko.capacityGuard`의 슬롯-워딩 + 안내문("동시 슬롯만 줄입니다 …")으로. [강행]=`?force=true`, [취소]=미생성, `mutation.reset()` 가드는 L3 그대로.

- [ ] **Step 5: `ko.ts` mode-aware 워딩**

`ko.capacityGuard`(160-170)에 open-loop 변형 키 추가(`overHintOpen`·`clampOpen`·`dialogBodyOpen`·`clampNoteOpen`류) 또는 함수형 워딩으로 슬롯/동시 요청 표현. 인라인 한국어/영어 0.

- [ ] **Step 6: 통과 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/lan-workers-l4/ui && pnpm test RunDialog 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 7: UI 게이트 + 단일 green 커밋**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/lan-workers-l4/ui && pnpm lint 2>&1 | tail -5 && pnpm test 2>&1 | tail -5 && pnpm build 2>&1 | tail -5`
Expected: 전부 clean/PASS.

```bash
git add ui/src/components/RunDialog.tsx ui/src/i18n/ko.ts ui/src/components/__tests__/
git commit -m "feat(lan-l4): RunDialog open-loop capacity preview/hint + 409 clamp(max_in_flight) mode branch (R8,R9,R10)"
```
Run after: `git log -1 --oneline`.

---

## Task 4: 런북 갱신

**Files:**
- Modify: `docs/dev/lan-workers.md` — §4(과부하 가드)·§8(한도 표).

**충족 R: R11, R12, N3(문서).**

- [ ] **Step 1: §4·§8 갱신**

`docs/dev/lan-workers.md` §4를 open-loop 포함으로: 슬롯=`capacity_split`·레이트 비례(고정 min1·곡선 proportional)·N 레이트-상한(초과 발사 방지)·409/줄여진행(max_in_flight clamp)/강행. **한계 노트** 추가: ① closed-loop VU 곡선 풀 가드 미적용(N=1 legacy·under-cap 배정 갭 존속) ② dataset `unique` 비례 분할 미적용(disjointness 보존·소비 속도만 불균등) ③ 풀 open-loop은 `worker_count` 노브 무시(use-all-by-demand). §8 한도 요약 표에 open-loop capacity 행 반영.

- [ ] **Step 2: docs-only 커밋(fast-path)**

```bash
git add docs/dev/lan-workers.md
git commit -m "docs(lan-l4): 런북 §4/§8 open-loop 과부하 가드 + 한계 노트 (R11,R12)"
```
Run after: `git log -1 --oneline`.

---

## Task 5: 라이브 검증 + finish-slice

**충족: spec §6 라이브, finish-slice.**

- [ ] **Step 1: 라이브 풀 스택 검증(`/live-verify`)**

spec §6 라이브 레시피 ①~⑧ 실행. `--worker-mode pool` 컨트롤러 + 풀 워커 2대(저 `--capacity-vus`, 일부 이질 cap). **워크트리 자체 바이너리**로: `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller` 후 상대경로 실행. 핵심: ② 409 `{achievable_vus:10, requested_vus:20}`·run row 부재, ⑥ 이질 cap 고정 rate `[6,24]`(min1)·곡선 `[5,25]`, ⑧ 이질 cap `[2,8]`·`target_rps=3` → 관측 총 RPS ≈ 3(초과 0). Playwright로 open 프리뷰·초과 힌트·409 다이얼로그(clamp max_in_flight·안내문)·콘솔 Zod 0. **정리**: `rm -rf .playwright-mcp` + 루트 png.

- [ ] **Step 2: 최종 리뷰**

`handicap-reviewer`(크로스커팅·와이어 1:1) + `security-reviewer`(409 본문 2정수·`?force` auth 비우회 — path-gate 매치). 둘 다 APPROVE까지. (path-gate: 요청실행/env 바인딩 변경 없음이나 `?force`·409 표면이 보안 트리거.)

- [ ] **Step 3: finish-slice**

`/finish-slice` — build-log 단락 append + roadmap §현재상태 갱신(L4 완료) + 루트 CLAUDE.md 상태줄 1줄 교체 + ADR-0041 §귀결 갱신 + 도메인 CLAUDE.md(controller — open-loop capacity 경로·min1·2-param 함정) + 메모리. ff-merge → `ExitWorktree(remove, discard_changes:true)`.

---

## Self-Review (작성자 체크)

- **Spec 커버리지**: R1(Task1)·R2(Task1)·R3(Task2)·R4(Task2)·R5(Task2)·R6(Task2)·R7(Task1+2 byte-identical 테스트)·R8(Task3)·R9(Task3)·R10(Task3)·R11(Task2 fork+Task4 doc)·R12(Task4 doc + dataset_slice diff 0)·R13(Task2+Task5 security). 전 R 매핑됨.
- **Placeholder**: 순수 함수는 완전 코드. **per-worker 분배 정밀 단언은 `coordinator.rs` 인라인 단위테스트**(Step 7, 기존 `split_open_loop_profile_*`/`reserve_capacity_*` 미러 — e2e는 집계만 관측 가능하므로). 통합(Step 8)은 e2e-관측(409/run-row/status/집계 rps)으로 한정. RTL은 기존 RunDialog 테스트 미러. 정확한 관찰 패턴은 그 파일 참조(반복 회피·코드베이스 패턴 준수).
- **타입 일관성**: `reserve_idle_pool_capacity(worker_cap, slot_total)`·`pool_achievable_capacity(worker_cap)`·`reduce_open_loop_profile(.., slot_weights)`·`concurrency_demand`/`pool_worker_cap` 전 task 일관.
- **커밋 경계**: 각 task 독립 green(미사용 헬퍼 단독 커밋 불가 → Task1은 헬퍼+테스트 fold, Task2는 배선+테스트 fold).

---

<!-- REVIEW-GATE: APPROVED -->
> spec-plan-reviewer 통과: spec 3라운드 수렴 + plan 2라운드 APPROVE (2026-06-21). 구현은 fresh 컨텍스트에서 `superpowers:subagent-driven-development`로.

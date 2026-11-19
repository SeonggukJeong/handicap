# 포화 진단 — 대상 간헐 멈춤 구별 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 버림이 있는 open-loop run에서, 첫 버림 뒤 회복한 초의 사용 슬롯이 설정의 절반 이하이면 `load_gen_saturated`의 `cause`를 `slots`에서 `stall`로 바꾼다. 리포트(인사이트·결과 해석)·내보내기·RunDialog 슬롯 도우미가 이 진단을 정직하게 보이게 한다.

**Architecture:** 이미 저장되는 초 단위 계수(`run_open_loop_seconds`, migration 0024)를 초별 합계로 읽는다(store). `build_report`가 `derive_insights` 직후, validity·결과 해석 계산 전에 순수 함수로 slots 인사이트를 stall로 고친다(insights). 결과 해석은 stall일 때 「전달 상한」 대신 「멈춘 동안 못 보냄」을 낸다. UI는 새 cause·숫자 4개·해석 키를 그린다. 엔진·워커·proto·마이그레이션은 바꾸지 않는다.

**Tech Stack:** Rust(controller, sqlx/SQLite, rust_xlsxwriter), TypeScript/React(Zod, vitest/RTL).

**Spec:** `docs/superpowers/specs/2026-11-20-stall-saturation-design.md` (spec-plan-reviewer clean APPROVE 3회차). 사용자 스토리 US1–US5는 spec 앞머리에 있다.

plan 리뷰: spec-plan-reviewer 3회차 clean APPROVE (2026-11-20).
REVIEW-GATE: APPROVED

**spec 대비 추가(plan 리뷰 I3, 2026-11-20):** spec은 결과 해석 패널(`derive_narrative` → `ValidityBanner`·인쇄 보고서)을 다루지 않았다. 그런데 해석 패널은 `load_gen_saturated`가 있으면 항상 `delivery_ceiling_observed`(「부하 전달 상한(이 구성으로 보낼 수 있는 한계)이 관측되었습니다」)를 낸다. 이 문장은 spec §3이 거짓이라고 한 옛 제목과 같은 주장이다. 그래서 stall일 때 새 해석 키 `delivery_interrupted_by_stall`를 낸다(Task 3·5). 이 때문에 stall 판정은 `build_report` 안, `derive_validity`·`derive_narrative` 앞에서 한다(spec §4.4 원래 배선 — `derive_insights` 시그니처는 그대로 두고 `build_report`가 인자를 받는다).

## Global Constraints

- 판정 상수 3개(이름 있는 const, `insights.rs`): `TAU_RATE = 0.9`, `TAU_IDLE = 0.5`, `MIN_COMPARABLE = 3`.
- 판정 순서는 `sut`(기존 `sut_stress`) → `stall` → `slots`다. stall은 **기존 결과가 `cause == Some("slots")`인 인사이트만** 바꾼다.
- 새 `Insight` 필드 4개를 구조체 **끝에** 이 순서로 붙인다: `typical_in_flight: Option<u64>`, `max_in_flight: Option<u32>`, `drop_seconds: Option<u64>`, `measured_seconds: Option<u64>`. 모두 `#[serde(skip_serializing_if = "Option::is_none")]`이고 stall일 때만 `Some`이다.
- stall 인사이트는 `cause = Some("stall")`, `recommended = None`. 나머지 필드(`value`·`count`·`onset_second`·`target_per_sec`·`achieved_per_sec`·`severity`)는 그대로 둔다.
- stall이 아닌 run의 리포트 JSON은 바이트 동일하다(반목표 1).
- 초별 합계는 `profile.is_open_loop() && run.dropped > 0`일 때만 읽는다.
- UI 문구는 전부 `ko.ts`를 거친다(ADR-0035). 숫자는 `n()`(천 단위 구분)으로 쓴다.
- 공유 게이트: cargo-영향 커밋은 `git commit`을 background로 돌리고 `| tail` 파이프를 쓰지 않는다. UI 커밋 전에 `pnpm lint && pnpm test && pnpm build`를 돌린다.

## Review Focus

1. **회복 초가 정확히 3개인 run:** `stall`이 난다. 2개면 `slots`다. 경계 테스트로 잠근다(Task 2 `stall_needs_three_recovery_seconds`).
2. **`max_in_flight`가 `None`인 open-loop 프로필**(옛 행·테스트 픽스처): 아무것도 바꾸지 않는다(panic·0 나누기 금지). Task 2 `refine_without_max_in_flight_is_noop`이 잠근다.
3. **계단 run:** 이미 읽은 워커별 행을 Rust에서 더하는 경로를 탄다. 비계단 run(SQL 합계)과 같은 진단이 나와야 한다(Task 3 `report_endpoint_marks_stall_for_stair_run`).
4. **멀티 워커에서 한 워커 행만 있는 초:** 합계가 그 워커 값만 갖고, 다른 run 행은 섞이지 않는다(Task 1 `totals_sum_workers_and_isolate_runs`).
5. **곡선 run의 `measured_seconds`:** 0-레이트 구간 초(A=0)는 세지 않는다. 그래서 화면의 「도착을 시도한 N초」가 run 길이보다 작을 수 있다(Task 2 `measured_seconds_counts_only_attempt_seconds`).

---

### Task 1: 초별 합계 읽기 (store)

**Files:**
- Modify: `crates/controller/src/store/open_loop.rs`
- Test: `crates/controller/tests/open_loop_totals_test.rs`(새 파일)

**Interfaces:**
- Produces:
  - `#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub struct OpenLoopTotal { pub ts_second: i64, pub launched: i64, pub completed: i64, pub dropped: i64 }`
  - `pub fn sum_by_second(rows: &[OpenLoopSecondRow]) -> Vec<OpenLoopTotal>` — 워커별 행을 초별로 더한다(`ts_second` 오름차순).
  - `pub async fn open_loop_totals(db: &Db, run_id: &str) -> sqlx::Result<Vec<OpenLoopTotal>>` — `SELECT ts_second, SUM(launched) AS launched, SUM(completed) AS completed, SUM(dropped) AS dropped FROM run_open_loop_seconds WHERE run_id = ? GROUP BY ts_second ORDER BY ts_second`(sqlx `r.get`이 이름으로 찾으므로 `AS` 별칭이 필수다).

- [ ] **Step 1: Write the failing tests** in `tests/open_loop_totals_test.rs`. `insert_open_loop_seconds` 사용법은 `report_test.rs`를 따른다(`run_open_loop_seconds`엔 FK가 없어 임의 run_id로 넣어도 된다).
  - `totals_sum_workers_and_isolate_runs`: run A에 워커 `w0` `(1000,5,4,0),(1001,6,6,1)`, `w1` `(1001,3,2,0),(1002,2,3,0)`을 넣는다. run B에는 `w0` `(1001,100,100,100)`을 넣는다. `open_loop_totals(A)` = `[{1000,5,4,0},{1001,9,8,1},{1002,2,3,0}]`.
  - `sum_by_second_matches_sql`: 같은 A 행을 `open_loop_seconds(db, A)`로 읽어 `sum_by_second`에 넘긴 결과가 `open_loop_totals(A)`와 같다.
  - `totals_empty_for_unknown_run` → 빈 Vec.
- [ ] **Step 2:** `cargo nextest run -p handicap-controller --test open_loop_totals_test` → 컴파일 실패(정의 없음).
- [ ] **Step 3:** `OpenLoopTotal`·`sum_by_second`(BTreeMap 누적)·`open_loop_totals`를 구현한다.
- [ ] **Step 4:** 같은 명령 → 3 passed.
- [ ] **Step 5: Commit** `feat(controller): open-loop 초별 합계 읽기`.

---

### Task 2: stall 판정 (insights, 순수) + 결정 기록

**Files:**
- Modify: `crates/controller/src/insights.rs` (구조체·`Insight::new`·새 함수·테스트)
- Modify: `Insight { … }` 전체 리터럴 5곳 — `insights.rs` `Insight::new`, `validity.rs` 테스트 헬퍼, `export.rs` 테스트 픽스처 3곳. 나머지 export 픽스처는 `..insight()` spread를 써서 고칠 필요가 없다. 구현 중 `grep -rn "Insight {" crates/controller`로 다시 확인한다.
- Modify: `docs/adr/0046-open-loop-rate-unit-iterations-per-second.md`(끝에 덧붙임 절), `crates/controller/CLAUDE.md`(`load_gen_saturated` cause 항목)

**Interfaces:**
- Consumes: Task 1 `store::open_loop::OpenLoopTotal`.
- Produces:
  - 새 `Insight` 필드 4개(Global Constraints).
  - `pub fn refine_saturation_stall(insights: &mut [Insight], totals: &[OpenLoopTotal], max_in_flight: Option<u32>)`. 다음이 모두 참일 때만 그 인사이트를 stall로 바꾸고, 아니면 아무것도 하지 않는다.
    - `kind == "load_gen_saturated"`
    - `cause == Some("slots")`
    - `max_in_flight`가 `Some(m)`
    - `stall_stats`가 `Some`
  - 비공개 `fn in_flight_series(totals: &[OpenLoopTotal]) -> Vec<(u64, u64)>` — 입력 순서대로 `(F(s), A(s))`(아래 알고리즘 첫 줄).
  - 비공개 `fn stall_stats(totals: &[OpenLoopTotal], m: u32) -> Option<StallStats>`, `struct StallStats { typical_in_flight: u64, drop_seconds: u64, measured_seconds: u64 }`.

**판정 알고리즘** (spec §4.2–4.3 그대로 — 테스트만으로는 다 정해지지 않는 부분):
```
R = 0;  초 s를 ts 오름차순으로:  R += L(s) − C(s);  F(s) = max(0, R);  A(s) = L(s) + D(s)   // in_flight_series
S_d = {s : D>0};  비면 None
s₀ = min S_d;  a* = median{A(s) : s∈S_d}           // 기존 private median(&[u64]) -> f64 재사용
S_c = {s : s > s₀ ∧ D(s)=0 ∧ A(s) ≥ TAU_RATE·a*}
|S_c| < MIN_COMPARABLE → None
f̃ = median{F(s) : s∈S_c};  f̃ > TAU_IDLE·m → None    // 거절 조건
Some { typical_in_flight: f̃.round() as u64, drop_seconds: |S_d|, measured_seconds: |{s : A(s)>0}| }
```
- 누적 `R`은 자르지 않는다(i64).
- 초는 입력에 있는 것만 쓴다.
- `A`·`F`는 u64로 바꿔 `median`에 넘긴다(둘 다 음수가 아니다).

테스트 헬퍼 `fn tot(ts: i64, l: i64, c: i64, d: i64) -> OpenLoopTotal`과 `fn slots_insight() -> Insight`를 `mod tests`에 둔다. `slots_insight()`는 `Insight::new("load_gen_saturated","warning")`에 `cause = Some("slots")`, `recommended = Some(2507.0)`를 넣은 것이다. 모든 판정 테스트는 `refine_saturation_stall(&mut [slots_insight()], &totals, Some(m))`의 결과를 본다.

- [ ] **Step 1: Write the failing tests** (`insights.rs` `mod tests`).
  - ★ `stall_repro_scattered_drops`(spec §5 재현, M=2500, 60초):
    - 행 구성:
      - `tot(0,7014,7000,0)` → R=14.
      - 1–59초는 기본 `tot(s,7000,7000,0)`.
      - 흩어진 18개 초 s ∈ {10,12,15,17,19,22,24,27,29,32,34,37,39,42,44,47,49,52}는 `tot(s,6000,3514,1000)`(그 초 끝 R=2500). 바로 다음 초는 `tot(s+1,7000,9486,0)`(R=14로 회복).
      - 버림 없는 멈춘 초 4개 s ∈ {55,56,57,58}는 경계 F가 1000·1500·2000·2400이 되게 L/C를 고르고, 59초에 R=14로 돌아온다.
    - 기대: `cause == Some("stall")`, `recommended == None`, `typical_in_flight == Some(14)`, `max_in_flight == Some(2500)`, `drop_seconds == Some(18)`, `measured_seconds == Some(60)`.
    - 되돌려 확인: 거절 조건 `f̃ > TAU_IDLE·m`을 `f̃ <= TAU_IDLE·m`으로 뒤집으면 RED.
  - ★ `fill_up_phase_is_not_stall`(F1, M=500):
    - 행 구성:
      - 채움 3초: `tot(0,100,60,0)`·`tot(1,100,20,0)`·`tot(2,100,20,0)` → F 40·120·200(≤ 0.4M).
      - 3–39초: `tot(s,60,60,40)` → A=100=a\*, 매초 버림이라 회복 초 없음.
    - 기대: `cause == Some("slots")`, 새 필드 모두 None.
    - 되돌려 확인: `s > s₀` 조건을 빼면 비교 초 = 채움 3초, 중앙값 120 ≤ 250이라 `stall`로 RED.
  - ★ `target_knee_is_not_stall`(F2, M=1000, 곡선):
    - 행 구성:
      - 100→1000/s로 오른다. 최고 구간 첫 3초는 버림 없이 `A=1000`, F 100·250·400(≤ 0.4M — 대기열이 쌓이는 중).
      - 그 뒤 끝까지 매초 `D>0`(F=M).
    - 기대: `slots`.
    - 되돌려 확인: `s > s₀`을 빼면 RED.
  - ★ `curve_shortage_then_long_low_plateau_is_slots`(US4, M=1000):
    - 행 구성:
      - 1000/s 구간 10초 매초 D>0(F=1000).
      - 내려오는 구간 무버림 3초(A 950·930·910 ≥ 0.9·a\*, F 950·930·910).
      - 그 뒤 100/s 30초(F≈20).
    - 기대: `slots`(비교 초 3개의 중앙값 930 > 500). 회복 초가 정확히 3개라 `MIN_COMPARABLE` 하한이 아니라 (d) 비교에서 결과가 정해진다.
    - 되돌려 확인: `TAU_RATE` 필터를 빼면 낮은 구간 30초가 들어와 중앙값이 20이 되어 `stall`로 RED.
  - `steady_shortage_every_second_is_slots`: 모든 초 D>0, F=M → `slots`, `recommended == Some(2507.0)` 그대로.
  - `curve_low_stage_stall_is_stall`: 낮은 구간(200/s)에서 멈춰 버림, 그 뒤 1000/s 무버림 5초(F 30) → `stall`.
  - `stall_needs_three_recovery_seconds`: 재현 모양에서 회복 초가 3개면 `stall`, 2개면 `slots`.
  - `empty_or_dropless_totals_are_noop`: 빈 슬라이스, 그리고 D=0만 있는 합계에서는 인사이트가 원본 clone과 `==`이다.
  - `sut_insight_is_untouched`: `cause=Some("sut")` 인사이트에 재현 합계를 줘도 그대로다.
  - `refine_without_max_in_flight_is_noop`: `max_in_flight = None`이면 그대로다.
  - `measured_seconds_counts_only_attempt_seconds`: 재현 합계 앞뒤에 A=0인 초(`tot(s,0,0,0)`, `tot(s,0,5,0)`)를 섞어도 `measured_seconds == Some(60)`.
  - `in_flight_series_clamps_report_only`: `tot(0,10,0,0)`, `tot(1,0,15,0)`, `tot(2,10,0,0)` → `in_flight_series` = `[(10,10),(0,0),(5,10)]`. 누적이 −5가 되지만 보고 F만 0으로 자르고, 다음 초는 잘리지 않은 누적에서 계산한다.
  - `typical_in_flight_rounds_half_away`: 비교 초 4개(짝수, `MIN_COMPARABLE` 이상)의 F가 14·14·15·15(중앙값 14.5)인 합계 → `typical_in_flight == Some(15)`.
  - `non_stall_json_has_no_new_keys`: refine 후 slots 인사이트를 `serde_json::to_value`로 바꾸면 `as_object()`에 새 키 4개가 하나도 없다. stall 인사이트에는 4개가 모두 있다.
- [ ] **Step 2:** `cargo nextest run -p handicap-controller insights::` → 컴파일 실패.
- [ ] **Step 3: Implement.**
  - 4개 필드를 Global Constraints 순서로 넣고, `Insight::new`와 리터럴 5곳에 `None` 4개를 채운다.
  - `in_flight_series`·`stall_stats`·`refine_saturation_stall`과 상수 3개를 추가한다.
  - `Insight.cause` doc comment를 `"slots" | "sut" | "stall"`로 바꾸고, stall은 「대상(또는 드물게 부하기) 간헐 멈춤 — 첫 버림 뒤 회복 초의 사용 슬롯 ≤ M/2, recommended 없음」으로 설명한다.
- [ ] **Step 4:** `cargo nextest run -p handicap-controller` → 전부 통과(기존 insights·validity·export 테스트 포함). ★ 네 개는 각각 되돌려 확인을 한 번씩 실행해 RED 출력을 본 뒤 원복한다.
- [ ] **Step 5: 결정 기록.**
  - ADR-0046 끝에 `## 덧붙임 (2026-11-20, stall-saturation)` 절을 3–5줄로 단다. 넣을 내용:
    - cause는 3-way(slots/sut/stall)다.
    - 근거는 초 단위 계수의 회복 초 사용 슬롯이다.
    - 「M ÷ 달성」 항등식이 깨지는 경우라 권장값을 내지 않는다.
    - 결과 해석 키는 `delivery_interrupted_by_stall`이다.
    - spec 경로.
  - `crates/controller/CLAUDE.md`의 `load_gen_saturated` cause 항목(「cause는 셋 `{slots, loadgen, sut}`」로 시작하는 불릿)을 현재 사실로 다시 쓴다.
    - cause = `{slots, sut, stall}`이고, `loadgen`·`recommended_workers`는 ADR-0046에서 제거됐다.
    - slots: `recommended = ceil(target × M ÷ achieved)`.
    - sut: `sut_stress`(5xx률 ≥1% 또는 late/early p95 ≥1.5×)가 먼저 판정한다.
    - stall: 초 단위 계수로, slots일 때만 덮어쓴다(stall-saturation).
    - 하위 「`cause=sut`/`loadgen` 라이브 재현 레시피」 불릿은 제목에서 `/loadgen`만 빼고 내용은 그대로 둔다.
- [ ] **Step 6: Commit** `feat(controller): 포화 인사이트 — 대상 간헐 멈춤(stall) 판정`.

---

### Task 3: 리포트 배선 + 결과 해석

**Files:**
- Modify: `crates/controller/src/report.rs` (`build_report` 13번째 인자 + refine 호출 + 테스트 호출 43곳에 `&[]`)
- Modify: `crates/controller/src/api/runs.rs` (`build_report_for_run`, `needs_open_loop_totals`)
- Modify: `crates/controller/src/validity.rs` (`derive_narrative` 5번 규칙)
- Modify: `crates/controller/src/insights.rs` (비용 측정 `#[ignore]` 테스트)
- Test: `crates/controller/tests/report_test.rs`, `api/runs.rs`·`validity.rs` 인라인 테스트

**Interfaces:**
- Consumes: Task 1 `open_loop_totals`·`sum_by_second`, Task 2 `insights::refine_saturation_stall`.
- Produces:
  - `build_report(…, stair_inputs: &StairInputs, open_loop_totals: &[crate::store::open_loop::OpenLoopTotal]) -> ReportJson`. 마지막 인자를 추가하고, `derive_insights` 결과에 `refine_saturation_stall(&mut insights, open_loop_totals, run.profile.max_in_flight)`을 **`derive_validity`·`derive_narrative` 호출 전에** 적용한다.
  - 비공개 `fn needs_open_loop_totals(profile: &Profile, dropped: i64) -> bool` (`api/runs.rs`) = `profile.is_open_loop() && dropped > 0`.
  - 결과 해석 can 키 `delivery_interrupted_by_stall`.

배선 메모: `derive_insights` 시그니처(41곳)는 그대로 둔다. `build_report` 테스트 호출 43곳은 마지막에 `&[]`를 붙이는 기계적 변경이고, 빠진 곳은 컴파일러가 잡는다. 프로덕션 호출은 `build_report_for_run` 하나뿐이고, 리포트 핸들러·단일/비교 내보내기·`persist_verdict`가 모두 이 함수를 거친다.

- [ ] **Step 1: Write the failing tests.**
  - `validity.rs` `stall_saturation_narrative_says_interrupted`: `load_not_delivered` reason이 있는 validity와 `cause=Some("stall")`인 `load_gen_saturated` 인사이트 → `can_claim`에 `delivery_interrupted_by_stall`이 있고 `delivery_ceiling_observed`는 없다. 같은 입력에 `cause=Some("slots")`이면 지금처럼 `delivery_ceiling_observed`가 나온다. `cannot_claim`의 `target_load_applied`는 두 경우 모두 그대로다.
  - `report_test.rs` `report_endpoint_marks_stall_for_intermittent_stall`:
    - 준비: 비계단 open-loop run을 만든다(`target_rps` 7000, `max_in_flight` 2500, `duration_seconds` 60, status Completed). `UPDATE runs SET dropped = 18000 WHERE id = ?`로 버림을 넣는다.
    - 초별 행: Task 2 재현 모양을 워커 2개(`w0`·`w1`, 값을 반씩)로 나눠 넣는다.
    - 윈도 행: 같은 초에 `MetricRow`를 넣는다(계단 테스트 패턴 — `load_gen_saturated` 발행에 필요).
    - 기대(`GET /api/runs/{id}/report`):
      - `load_gen_saturated`가 `cause == "stall"`이고 `recommended` 키가 없으며 `typical_in_flight`이 있다.
      - `narrative.can_claim`에 `delivery_interrupted_by_stall`이 있다.
      - `ReportJson`으로 역직렬화된다.
  - `report_test.rs` `report_endpoint_keeps_slots_without_totals`: 같은 run에서 초별 행만 넣지 않으면 `cause == "slots"`, `recommended`가 있고, 새 키 4개가 없으며, `delivery_ceiling_observed`가 그대로다(US5).
  - `report_test.rs` `report_endpoint_marks_stall_for_stair_run`: 계단 프로필(`report_endpoint_includes_stair_for_stair_run` 준비를 재사용하되 `max_in_flight`는 **2500**으로)에 재현 모양 초별 행(워커 2개)·버림 18000을 넣으면 `cause == "stall"`이고 `typical_in_flight`이 비계단 테스트와 같은 14다(계단 경로 `sum_by_second` ↔ SQL 경로 같은 진단).
  - `api/runs.rs` 인라인 `needs_open_loop_totals_gate`:
    - closed 프로필 + dropped 5 → false.
    - open(`target_rps`) + dropped 0 → false.
    - open(`target_rps`) + dropped 1 → true.
    - stages-only + dropped 1 → true.
- [ ] **Step 2:** `cargo nextest run -p handicap-controller --test report_test` → 컴파일 실패 또는 새 테스트 FAIL.
- [ ] **Step 3: Implement.**
  - `build_report`에 인자를 추가하고 refine을 호출한다. 테스트 호출 43곳에 `&[]`를 붙인다.
  - `derive_narrative` 5번 규칙은 기존 `if has_reason(validity, "load_not_delivered")` 가드 **안에서만** 고른다(가드 밖에서 새 claim을 만들지 않는다 — `stair_dropped_explained`로 reason이 빠진 계단 run은 지금처럼 claim 없음). `insights`에 `kind == "load_gen_saturated" && cause == Some("stall")`이 있으면 `delivery_interrupted_by_stall`, 아니면 `delivery_ceiling_observed`를 push한다.
  - `build_report_for_run`은 `needs_open_loop_totals`일 때만 합계를 얻는다. 계단 run이면 이미 읽은 `stair_inputs.open_loop`를 `sum_by_second`로 더하고, 아니면 `open_loop_totals(db, run_id)`를 부른다. 그 밖에는 `Vec::new()`를 쓴다.
- [ ] **Step 4:** `cargo nextest run -p handicap-controller` → 전부 통과.
- [ ] **Step 5: 비용 측정**(build-log 기록용).
  - `insights.rs` `mod tests`에 `#[ignore] fn stall_stats_cost_86400_seconds`를 둔다. 86,400초 합성 합계(재현 모양 반복)로 `stall_stats`를 3회 돌려 최솟값을 `eprintln!`한다.
  - 실행: `cargo nextest run -p handicap-controller --cargo-profile release --run-ignored only stall_stats_cost --no-capture`. 값은 `.superpowers/sdd/2026-11-20-stall-saturation/live.md`에 적는다.
  - 고정 상한 단언은 넣지 않는다.
- [ ] **Step 6: Commit** `feat(controller): 리포트가 초별 합계로 stall 진단, 결과 해석 문구 분기`.

---

### Task 4: 내보내기 21열

**Files:**
- Modify: `crates/controller/src/export.rs` (`INSIGHT_COLUMNS`·`insight_csv_cells`·`write_insight_xlsx_row`·「17」 doc comment 3곳(`INSIGHT_COLUMNS` 위·두 행 작성 함수 위)·테스트의 헤더 문자열 2곳·`insight_error_kind_column_round_trips`)
- Modify: `crates/controller/tests/export_routes_test.rs` (헤더 문자열 1곳)

**Interfaces:**
- Consumes: Task 2 새 필드.
- Produces: `INSIGHT_COLUMNS: [&str; 21]`. 끝 4열은 `typical_in_flight`·`max_in_flight`·`drop_seconds`·`measured_seconds`이고 셀 인덱스는 17–20이다(비교 시트는 `col_offset` 1을 더한다).

- [ ] **Step 1: Write the failing tests.** 헤더 문자열 3곳(테스트 단언)을 먼저 21열로 고친다.
  - `insight_stall_columns_round_trip`:
    - CSV 셀: stall 인사이트(14·2500·18·60)는 `insight_csv_cells`가 21칸이고 `[17..=20] == ["14","2500","18","60"]`이다. slots 인사이트는 그 4칸이 빈 문자열이다.
    - 단일 XLSX(calamine 읽기): Insights 시트 헤더 마지막 4칸이 열 이름이다. stall 행의 4칸은 숫자 값이고, slots 행의 4칸은 `None | Some(Data::Empty)`이다.
  - 비교 CSV·XLSX: run_id 열 뒤로 한 칸 밀린 같은 값이다(기존 비교 테스트 패턴).
  - `insight_error_kind_column_round_trips`: 17 → 21(세 단언), 「마지막 열」 단언 → `measured_seconds`. `error_kind`는 인덱스 16 그대로다.
- [ ] **Step 2:** `cargo nextest run -p handicap-controller export` → FAIL.
- [ ] **Step 3: Implement.** 4개 셀을 추가한다(CSV는 `to_string`, XLSX는 `if let Some` + `write_number(v as f64)`). doc comment 3곳을 21로 고친다.
- [ ] **Step 4:** `cargo nextest run -p handicap-controller` → 전부 통과(`export_routes_test` 포함).
- [ ] **Step 5: Commit** `feat(controller): 인사이트 내보내기에 stall 숫자 4열`.

---

### Task 5: 리포트 화면 (Zod·InsightPanel·결과 해석 문구)

**Files:**
- Modify: `ui/src/api/schemas.ts` (`InsightSchema` 끝에 4필드: 모두 `z.number().int().nonnegative().optional()`)
- Modify: `ui/src/i18n/ko.ts` (`saturation.stallHead`·`saturation.stall`·`narrative.can.delivery_interrupted_by_stall`)
- Modify: `ui/src/components/report/InsightPanel.tsx` (`message()` `load_gen_saturated`, `actionFor()`)
- Test: `ui/src/components/report/__tests__/InsightPanel.test.tsx`, `ValidityBanner` 테스트 파일(`ui/src/components/report/__tests__/`에서 확인), 인쇄 보고서는 같은 `ko.narrative.can` 맵을 쓴다(`buildPrintDoc.ts`)

**Interfaces:**
- Consumes: Task 2·3 와이어 필드(서버가 `skip_serializing_if` → absent이므로 `.optional()`), Task 3 해석 키.
- Produces: `ko.saturation.stallHead(count, measured, drop)`, `ko.saturation.stall(typical, m, chart)`, `ko.narrative.can.delivery_interrupted_by_stall`.

**문구(byte-exact):**
```ts
// saturation
stallHead: (count: string, measured: string, drop: string) =>
  `응답이 가끔 멈춰 반복(시나리오 실행) ${count}회를 못 보냈어요 — 도착을 시도한 ${measured}초 중 ${drop}초에만 몰렸어요`,
stall: (typical: string, m: string, chart: string) =>
  `평소엔 동시 실행이 ${typical}개만 쓰였어요(설정 ${m}개). 버림이 몰린 초에는 응답이 멈춰 슬롯이 잠시 다 찼던 거예요 — ` +
  `슬롯 수를 바꾸기보다 그 시각 대상 서버의 상태를 먼저 확인하세요(드물게 부하기 쪽 멈춤일 수도 있어요). ` +
  `멈춘 시각은 아래 「${chart}」 그래프에서 튄 곳이에요.`,
// narrative.can
delivery_interrupted_by_stall: "응답이 가끔 멈춘 동안 부하를 다 보내지 못했습니다(이 구성의 전달 한계는 아닙니다)",
```
`InsightPanel`은 `chart`에 `ko.report.timeSeriesP95`(「p95 응답 시간 (ms)」 — `ReportView`의 초별 `TimeSeriesChart` 제목)를 넘긴다. 차트 이름을 문구에 하드코딩하지 않는다. 「지연」 섹션은 분포 차트라 시간축이 없어서 쓰지 않는다.

- [ ] **Step 1: Write the failing tests**(테스트 파일을 먼저 편집 — tdd-guard).
  - ★ `stall insight shows stall head and action with numbers`:
    - 입력: `{kind:"load_gen_saturated", severity:"warning", value:7000, count:1203, onset_second:12, cause:"stall", typical_in_flight:14, max_in_flight:2500, drop_seconds:18, measured_seconds:86400, target_per_sec:7000, achieved_per_sec:6980}`.
    - 제목: `1,203`·`86,400초`·`18초`가 들어 있고, 「지점부터 포화」(onset 꼬리)는 붙지 않는다.
    - 안내: `14개`·`2,500개`·`p95 응답 시간 (ms)`가 들어 있다.
    - 「올려 다시 실행」은 화면 어디에도 없다.
    - 조치문 토글이 꺼져 있어도(기본) 안내가 보인다.
    - 숫자는 렌더된 글자로 단언한다(`ko.*(…)` 자기참조 단언 금지 — ui/CLAUDE.md 11호).
    - 되돌려 확인: `actionFor`의 stall 분기를 지우면 RED.
  - `stall insight without new fields falls back`: `cause:"stall"`만 있고 4필드가 없으면 제목이 기존 「목표한 부하를 다 걸지 못했어요」로 시작한다. 안내는 일반 문구(`computed:false`)라 토글이 꺼져 있으면 보이지 않는다.
  - 기존 slots·sut 테스트는 수정하지 않고 통과해야 한다.
  - Zod: `InsightSchema.parse`가 4필드를 보존한다.
  - 결과 해석: `narrative.can_claim = ["delivery_interrupted_by_stall"]`인 리포트 → `ValidityBanner` 상세에 그 문장이 보인다(기존 ValidityBanner 테스트 패턴, 상세 토글 펼침).
- [ ] **Step 2:** `cd ui && pnpm test InsightPanel` 그리고 `cd ui && pnpm test ValidityBanner` → 새 테스트 FAIL.
- [ ] **Step 3: Implement.**
  - `message()`: stall이고 `drop_seconds`·`measured_seconds`가 있으면 `stallHead(n(count), n(measured), n(drop))`를 쓰고 onset 꼬리를 붙이지 않는다. 아니면 기존 그대로.
  - `actionFor()`: stall이고 `typical_in_flight`·`max_in_flight`가 있으면 `{text: ko.saturation.stall(n(typical), n(m), ko.report.timeSeriesP95), computed: true}`. 아니면 일반 문구(`computed:false`).
- [ ] **Step 4:** `cd ui && pnpm lint && pnpm test && pnpm build` → 통과.
- [ ] **Step 5: Commit** `feat(ui): 리포트 — 대상 간헐 멈춤 진단·해석 문구`.

---

### Task 6: RunDialog 슬롯 도우미 (US2)

**Files:**
- Modify: `ui/src/components/run/SlotSizingHelper.tsx` (`SlotAnchor` 유니온·`usePriorOpenRunAnchor`·렌더)
- Modify: `ui/src/i18n/ko.ts` (`slotSizing.fromStallRun`)
- Test: `ui/src/components/run/__tests__/SlotSizingHelper.test.tsx`

**Interfaces:**
- Consumes: Task 5 Zod(`cause`만 사용).
- Produces: `SlotAnchor`에 `| { kind: "stall" }`, `ko.slotSizing.fromStallRun`(문자열).

**문구(byte-exact):**
```ts
fromStallRun:
  "직전 run은 응답이 가끔 멈춘 run이에요. 응답 시간으로 계산한 권장값은 멈춤 동안을 감당하지 못하니 슬롯을 줄이지 말고 대상 멈춤부터 확인하세요.",
```

**동작:**
- `usePriorOpenRunAnchor`는 직전 run 포화 인사이트의 `cause === "stall"`이면 「M ÷ 달성」(ⓐ)·걷기(ⓑ)보다 **먼저** `{kind:"stall"}`을 돌려준다.
- 컴포넌트는 `anchor?.kind === "stall"`이면 제목 줄은 그대로 두되, 제목 옆 HelpTip(「권장값은 최소 출발점」 설명)과 그 아래 전부를 그리지 않는다(추정 입력·측정 버튼·권장 숫자·「적용」·공식 줄·`cannotCompute`). 대신 `ko.slotSizing.fromStallRun` `<p>` 한 줄을 그린다.
- `holdMs` 계산(`anchor?.holdMs ?? …`)과 근거 문구 삼항(`insight`/`walk`)은 새 유니온 종류 때문에 `tsc`가 깨지므로 판별 내로잉으로 다시 쓴다. 예: `const anchorHold = anchor && anchor.kind !== "stall" ? anchor.holdMs : null`.
- 이른 `return`을 쓴다면 모든 훅(`useState`·`useTestRun`·`useScenario`) 호출 **뒤**에 둔다(훅 규칙).

- [ ] **Step 1: Write the failing tests**(테스트 파일 먼저).
  - ★ `stall prior run shows note and no recommendation`:
    - 픽스처: 직전 open run 리포트에 `{kind:"load_gen_saturated", cause:"stall", achieved_per_sec:6980}`이 있고, 스텝 p50도 있어 걷기가 가능하다(기존 walk 테스트 픽스처 재사용).
    - 기대: `ko.slotSizing.fromStallRun` 글자가 보인다. 「적용」 버튼(`ko.slotSizing.apply`)·`ko.slotSizing.estMs` 입력·측정 버튼·HelpTip 버튼(`ko.slotSizing.helpLabel`)은 없다. 제목 `ko.slotSizing.title`은 보인다.
    - 되돌려 확인: stall 분기를 지우면 RED(걷기 권장 + 적용 버튼이 나타남).
  - 기존 slots·sut·인사이트 없음 테스트는 수정하지 않고 통과해야 한다.
- [ ] **Step 2:** `cd ui && pnpm test SlotSizingHelper` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `cd ui && pnpm lint && pnpm test && pnpm build` → 통과.
- [ ] **Step 5: Commit** `feat(ui): 멈춤 run 뒤 슬롯 도우미는 권장 대신 안내`.

---

### Task 7: 라이브 검증 (orchestrator — 코드 커밋 없음)

**Files:**
- Create(스크래치, 커밋 금지): `<scratchpad>/stall_responder.py`. `.claude/skills/live-verify/responder.py`를 복사해 인자 `[port] [delay_ms] [stall]`을 받게 한다.
  - `stall`이 있으면 벽시계 `t = time.time()`에서 `t % 5 < 1`인 동안 들어온 요청은 `1 - (t % 5)`초를 기다린 뒤 답한다.
  - 그 밖에는 `delay_ms`로 답한다.
  - keep-alive가 기본이다.

워크트리 자체 바이너리와 격리 DB로 돌린다(`/live-verify` 절차). spec §6 표가 척추다.

- [ ] **Step 1:** `cargo build -p handicap-worker && cargo build -p handicap-controller --bin controller`, 그다음 `cd ui && pnpm build`. 포트는 `lsof`로 빈 것을 확인하고 쓴다.
- [ ] **Step 2: US1** — 멈춤 응답기(2 ms) + 고정 목표 2000/s, M=400, 30초.
  - 리포트 JSON: `cause=stall`, `recommended` 없음, `typical_in_flight` ≪ 400, `narrative.can_claim`에 `delivery_interrupted_by_stall`.
  - 브라우저: 리포트 화면의 인사이트 제목·안내와 결과 해석 문장을 확인하고(스크린샷), 「올려 다시 실행」과 「전달 상한」이 없음을 본다.
  - 2000/s에서 응답기가 무너지면(오류율 > 1%) 1000/s로 낮춘다.
- [ ] **Step 3: US2** — 같은 시나리오 `/scenarios/{id}/runs` → 「실행하기」 → open-loop. 슬롯 도우미에 안내 한 줄이 보이고, 「적용」 버튼·권장 숫자·추정 입력이 없다(스크린샷). 슬롯 칸 값은 그대로다.
- [ ] **Step 4: US3·US3′·US4** — 일반 응답기로 spec §6 값을 돌린다. 각각 `cause=slots`이고 새 키가 없어야 한다.
  - US3: 50 ms, M 20, 2000/s.
  - US3′: 10,000 ms, M 300, 50/s, 40초, `http_timeout_seconds` 15.
  - US4: stages 200→3000/s 20초, M 100, 50 ms.
- [ ] **Step 5: US5** — US1 run의 `run_open_loop_seconds` 행을 `sqlite3`로 지운 뒤 리포트를 다시 연다 → `cause=slots`, `recommended` 있음, `delivery_ceiling_observed`.
- [ ] **Step 6:** 결과 표(US · 절차 · 실측 · 통과)와 Task 3 Step 5 비용 측정값을 `.superpowers/sdd/2026-11-20-stall-saturation/live.md`에 남긴다. finish-slice 때 build-log로 옮기고, spec §7 한계에 아래 하나를 더해 roadmap §B(다음 번호 — `grep -n '^### B' docs/roadmap.md`로 마지막+1)에 기록한다.
  - 풀 모드에서 용량 축소를 확정하면 실제 M이 프로필 M보다 작아진다. 그러면 0.5·프로필 M 비교가 실제 여유보다 관대해진다(기존 slots 공식도 같은 노출).

# 계단 진행 패널 — 실패 이유 표시 (stage-live-reasons) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 실행 중 「계단 진행」 패널의 요약 줄·칩 라벨에 판정 계단의 실패 이유를 리포트와 같은 조각 글자로 보이고, 판정 직후 머리 줄 경계 초 어긋남과 400px run 상세 표 넘침을 고친다.

**Architecture:** 서버 순수 함수 `stair_live::build_live`가 `Judgement.reasons`·`slot_limited`와 감시가 보관한 계단별 p99로 `LiveState.step_reasons`(계단마다 `{reasons, slot_limited, ref_fast}`)를 채우고, 같은 함수 안에서 `current < judged`이면 현재 구간을 다음 계단 상승으로 올린다(전부 판정이면 null). 화면은 리포트 `reasonTexts`의 조각 조립부를 `reasonPartTexts`로 떼어 두 화면이 같이 쓴다.

REVIEW-GATE: APPROVED

**Tech Stack:** Rust(serde) / TypeScript·React·Zod·vitest·RTL.

**Spec:** `docs/superpowers/specs/2026-11-20-stage-live-reasons-design.md` (§5 설계·§6 불변식·§7 라이브). 선행 판단·연기: roadmap §B70.

## 사용자 스토리 (US) — spec에서 발췌 (원천 = spec 앞머리)

- **US1**: 운영자가 계단 run을 서버 대시보드 옆에 띄워 놓고 보다가 어느 계단이 「튄 계단」·「포화」로 판정되는 걸 본다. 성공하면 요약 줄에 「2 튄 계단(오류 4.6%)」·「3 포화(p99 3.9×)」처럼 이유가 같이 보이고, 이유 조각 하나하나의 글자는 run이 끝난 뒤 리포트 「사유」 칸과 똑같다(「p99 5 ms 이상」·「슬롯 부족 의심」 포함 — 조각 사이 구분자만 실행 중 `, `, 리포트 ` · `).
- **US2**: QA가 실행 중 칩 하나에 마우스를 올리거나 스크린리더로 칩을 읽는다. 성공하면 그 계단의 상태와 이유가 함께 나온다(요약 줄엔 안 붙는 「포화 이후」 계단의 이유도 여기서). 이유가 없는 칩(정상·측정 중·예정·판정 중단·일부 실행·실행 안 함·즉시 정지·측정 안 됨)은 지금과 같다.
- **US3**: 운영자가 계단이 판정되는 순간 머리 줄을 본다. 성공하면 방금 판정된 계단을 「측정 중」으로 보여 주는 약 2초가 없고 다음 계단 「상승 중」으로 바로 넘어간다. 마지막 계단까지 판정되면 「측정 중」 머리 줄이 사라진다.
- **US4**: 운영자가 좁은 화면(폭 400px)에서 실행 중 run 상세를 연다. 성공하면 페이지 가로 넘침이 없고 메트릭 표는 자기 상자 안에서만 가로 스크롤된다. 한 계단에 이유가 가장 많이 붙어도(달성·dropped·오류·p99 N.N× 네 개, 큰 숫자 — 또는 달성·dropped·슬롯 부족 의심) 요약 줄이 잘리거나 겹치지 않는다.

## Global Constraints

- 엔진·워커·worker-core·proto·migration diff 0: `git diff --stat master -- crates/engine crates/worker crates/worker-core crates/proto crates/controller/src/store` 출력 0줄(migration 파일은 `src/store/migrations/`, 이 슬라이스는 store 무변경).
- 계단 아닌 run: `GET /api/runs/{id}`에 `auto_stop_live` 키 없음(기존 `skip_serializing_if` 그대로) — 리포트·CSV·XLSX·인쇄 사유 출력 무변경(기존 골든 패리티 `stairExportParity.test.ts`·`report.rs` 골든 **무수정** 통과).
- 와이어: `LiveState.step_reasons`는 `step_states`와 같은 길이, 항목 키 `reasons`·`slot_limited`·`ref_fast` 항상 직렬화. `reasons` 항목은 기존 `crate::stair::Reason`(새 타입 없음).
- `ref_fast` 정의 = 계단 i 앞쪽에서 가장 가까운 `ok` 판정 계단의 p99 < `P99_FAST_US`(1000 µs). 없으면 `false`. `i < judged`인 행만 채우고 나머지는 `{reasons: [], slot_limited: false, ref_fast: false}`.
- 실행 중 이유 조각 구분자 `, `(괄호 안), 리포트는 ` · ` 그대로. 화면 글자는 전부 `ui/src/i18n/ko.ts` 경유.
- 상태 용어(「튄 계단」 등) 불변. 칩 안에 숫자 없음(기호만).
- 정확성 최우선, 성능은 결과 불변 최적화만(working-rules §10) — 새 비용(이유 벡터 복사)은 Task 2 측정으로 기록.
- 줄번호는 작성 시점 기준 — 편집 전 `grep -n`으로 재확인. 커밋은 pre-commit 게이트 통과(`--no-verify` 금지), implementer 커밋은 단일 FOREGROUND 호출(600000 ms), 게이트 판정에 `| tail` 금지(`; echo exit=$?`). subagent는 `git checkout/switch/stash` 금지.

## Review Focus

1. **이유가 빈 `after` 계단**(포화 이후지만 고정 기준 대비 통과): 칩 라벨이 「4계단 포화 이후」 그대로이고 빈 괄호 「()」가 없어야 한다 → Task 3 `step_label_after_without_reasons_has_no_parens`.
2. **기준 계단이 1 ms 미만인 p99 배수 실패**: 실행 중에도 리포트처럼 「p99 5 ms 이상」(배수 아님) → Task 1 `ref_fast_uses_nearest_ok_not_prev`, Task 3 `step_label_reason_texts`.
3. **동결 중 경계 초**: 「판정 중단」 run에서 `current < judged`면 다음 계단 상승으로 올리되 칩은 `frozen` 유지 → Task 1 `frozen_lag_lifts_current_keeps_frozen_chips`.
4. **`step_reasons`가 `step_states`보다 짧은 입력**(테스트 fixture·향후 회귀): 화면이 던지지 않고 이유 없음으로 취급 → Task 3 `missing_step_reasons_is_no_reason`.
5. **큰 숫자**(dropped 1,000,000,000 · p99 12345.6×)·네 이유 동시: 글자 정확 + 400px에서 요약 줄 줄바꿈 → Task 3 `step_label_max_reasons`, Task 4 클래스 단언 + 라이브 rect.

---

### Task 1: 서버 — `step_reasons`·`ref_fast`·판정 직후 현재 구간 (`stair_live.rs` + 감시 배선)

**Files:**
- Modify: `crates/controller/src/stair.rs:156` (`P99_FAST_US`를 `pub(crate) const`로)
- Modify: `crates/controller/src/stair_live.rs` (`LiveStepReasons` 신설, `LiveState.step_reasons`, `LiveInputs.judged_p99_us`, `build_live` 보정 — 테스트는 같은 파일 `mod tests`)
- Modify: `crates/controller/src/stair_monitor.rs` (필드 `judged_p99_us: Vec<u64>`; `judge_steps` `:474` 근처 `self.judgement = Some(j)` 옆에서 `nums`의 `p99_us`로 덮어씀; `live()` `:291`이 넘김; `new()`는 빈 벡터)

**Interfaces:**
- Produces:
  - `#[derive(Debug, Clone, PartialEq, Serialize)] pub struct LiveStepReasons { pub reasons: Vec<Reason>, pub slot_limited: bool, pub ref_fast: bool }`
  - `LiveState.step_reasons: Vec<LiveStepReasons>` — 필드 순서는 `step_states` 바로 뒤.
  - `LiveInputs.judged_p99_us: &'a [u64]` — 마지막 판정에 넣은 계단별 p99(판정 전이면 빈 슬라이스). 인덱스 = 계단.
  - 와이어 JSON: `"step_reasons": [{"reasons": [{"kind": "errors", "value": 0.05}], "slot_limited": false, "ref_fast": true}, …]`

- [ ] **Step 1: 실패 테스트 작성** (`stair_live.rs` `mod tests` — 기존 `inp()` 헬퍼에 `judged_p99_us: &[]` 추가)

  `nums` 직접 구성용 헬퍼 `fn nums(c, rows: &[(f64 /*error_rate*/, u64 /*p99_us*/)]) -> Vec<StepNumbers>`(achieved None·dropped Some(0)·measured true, 길이 밖은 measured false)을 두고:

  ```rust
  #[test]
  fn step_reasons_copy_judged_rows() {
      // jud("ofoo", 5): 계단 1 오류 → spike, judged 4, 계단 4는 미판정
      let c = cfg(5, None);
      let j = jud("ofoo", 5);
      let l = build_live(&LiveInputs { judged_p99_us: &[1000; 5], ..inp(&c, 4, Some(&j)) });
      assert_eq!(l.step_reasons.len(), 5);
      assert_eq!(l.step_reasons[1].reasons, j.reasons[1]);
      assert_eq!(l.step_reasons[1].reasons[0].kind, ReasonKind::Errors);
      assert!(l.step_reasons[0].reasons.is_empty());
      assert_eq!(l.step_reasons[4], LiveStepReasons { reasons: vec![], slot_limited: false, ref_fast: false });
  }

  #[test]
  fn ref_fast_uses_nearest_ok_not_prev() {
      // p99 [500, 6000, 8000, 7000] → [ok, saturated, saturated, after], 기준 = 계단 0(500 µs)
      let c = cfg(4, None);
      let p = [500, 6000, 8000, 7000];
      let j = judge(&nums(&c, &[(0.0, 500), (0.0, 6000), (0.0, 8000), (0.0, 7000)]), &c);
      assert_eq!(j.states, vec![StepState::Ok, StepState::Saturated, StepState::Saturated, StepState::After]);
      let l = build_live(&LiveInputs { judged_p99_us: &p, ..inp(&c, 4, Some(&j)) });
      for i in 1..4 {
          assert_eq!(l.step_reasons[i].reasons[0].kind, ReasonKind::P99Relative, "step {i}");
          assert!(l.step_reasons[i].ref_fast, "step {i}"); // 바로 앞 계단(6000·8000)으로 계산하면 false → RED
      }
  }

  #[test]
  fn ref_fast_false_without_ok_ref() {
      // nums [(0.5, 500), (0.0, 500)] → [Saturated, After]; 계단 1 사유 비었을 수 있음 — ref_fast 둘 다 false
      // (바로 앞 계단 규칙이면 계단 1 = 500 < 1000 → true → RED)
  }

  #[test]
  fn unjudged_and_stop_rows_have_empty_reasons() {
      // 기존 saturation_stop_states_match_stop_row_state 입력을 재사용: i ≥ judged인 모든 행 == 빈 LiveStepReasons
  }

  #[test]
  fn current_lifts_to_next_ramp_when_judged() {
      let c = cfg(4, Some(TwoFails));
      let j = jud("oo", 4);
      let l = build_live(&LiveInputs { current: Some((1, BandKind::Measure)), judged_p99_us: &[1000; 4], ..inp(&c, 2, Some(&j)) });
      assert_eq!((l.current_step, l.phase), (Some(2), Some(BandKind::Ramp)));
      assert_eq!(l.step_states[2], L::Measuring);
      assert_eq!(l.step_states[3], L::Pending);
  }

  #[test]
  fn current_null_when_all_judged() {
      // jud("oooo", 4), judged 4, current (3, Measure) → (None, None)
  }

  #[test]
  fn current_unchanged_when_not_behind() {
      // judged 2, current (2, Discard) → (Some(2), Some(Discard)); current (3, Ramp) → 그대로
  }

  // 기존 saturation_stop_states_match_stop_row_state에 추가: 정지 기록 + current (3, Measure) + judged 4 → (Some(4), Some(Ramp))

  #[test]
  fn frozen_lag_lifts_current_keeps_frozen_chips() {
      // frozen: true, judged 2 of 4, current (1, Measure) → (Some(2), Some(Ramp)), step_states[2..] == [Frozen, Frozen]
  }
  ```

  `serializes_nulls`에 추가: `v["step_reasons"][0]`의 키 집합이 정확히 `reasons`·`slot_limited`·`ref_fast`이고 `reasons`는 빈 배열.

- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller stair_live` → 컴파일 실패(`step_reasons`·`judged_p99_us`·`LiveStepReasons` 없음).

- [ ] **Step 3: 구현** — `build_live`에서 `judged = judged_states.len()`을 먼저 구하고:
  - 표시용 `current` = `inp.current`에서 `c < judged`면 `judged < n` → `(judged, Ramp)`, `judged == n` → `None`. 이 보정값을 `step_states`의 `measuring` 규칙과 `current_step`·`phase` 출력에 쓴다(`next_fail_stops`·`last_ok_step`·`stop` 무변경).
  - `step_reasons[i]` = `i < judged`면 `judgement`의 `reasons[i].clone()`·`slot_limited[i]`, `ref_fast` = `(0..i).rev().find(|&k| j.states[k] == StepState::Ok).and_then(|k| inp.judged_p99_us.get(k)).is_some_and(|&p| p < P99_FAST_US)`; 아니면 빈 값.
  - 감시: `judge_steps`가 `judge(&nums, …)` 직후 `self.judged_p99_us = nums.iter().map(|s| s.p99_us).collect()`(판정할 때만).

- [ ] **Step 4: 통과 확인** — `cargo nextest run -p handicap-controller stair_live stair_monitor` 전부 PASS(기존 `judged_then_measuring_then_pending`·`lagging_steps_are_measuring`·`live_*` 무수정 통과).

- [ ] **Step 5: 되돌려 확인** — ① `ref_fast`를 `i.checked_sub(1)` 계단 p99로 바꿔 `ref_fast_uses_nearest_ok_not_prev` RED ② `current` 보정을 지워 `current_lifts_to_next_ramp_when_judged`·`current_null_when_all_judged` RED → 원복 → GREEN. 출력 줄을 리포트에 남긴다.

- [ ] **Step 6: 커밋** (단일 FOREGROUND 호출, timeout 600000) — `git add crates/controller/src/stair.rs crates/controller/src/stair_live.rs crates/controller/src/stair_monitor.rs` → `git commit -F <메시지 파일>`(`feat(controller): 실행 중 계단 요약에 계단별 실패 이유·판정 직후 현재 구간 보정`) → `git log -1`로 landed 확인.

---

### Task 2: 판정 도중 실행 중 이유 = 최종 리포트 (감시 통합 테스트) + 비용 측정

**Files:**
- Modify: `crates/controller/src/stair_monitor.rs` `mod tests` (새 생성기 + 테스트; production 무변경)
- Modify: `crates/controller/src/stair_live.rs` `mod tests` (`#[ignore]` 측정 테스트)

**Interfaces:**
- Consumes: Task 1 `LiveState.step_reasons`, `LiveStepReasons`; 기존 테스트 헬퍼 `report_of(&StairConfig, &GenRun, Option<AutoStopRecord>)`·`GenRun`·`hdr(p99_us)`·`T0`·`T0MS`·`NOW2`·`STEP`(=21, `cfg5` 계단 길이).

- [ ] **Step 1: 생성기** `fn gen_kinds_run(c: &StairConfig, steps: &[(u64 /*errors per 100*/, u64 /*p99_us*/)]) -> (GenRun, Vec<(i64, LiveState)>)` — 워커 1개(`StairMonitor::new(c, 1)`, `open_loop_started_at_ms = T0MS`), 초 `T0..=T0 + STEP·n + 2`(마지막 계단 완결 증거용 꼬리 몇 초 — 기존 `gen_run`이 5계단 105초에 `T0 + 108`까지 보내는 것과 같은 이유; 마지막 계단이 판정되지 않으면 아래 「스냅숏 수 = 6」 가드가 잡는다), 계단 i의 초마다 open-loop `launched = completed = target`, `dropped 0`, 스텝 하나 `"a"` 창 `count 100`·`error_count = errors`·`hdr(p99_us)`. 5초 묶음마다 `on_msg` 뒤 `m.judged_through()`가 올랐으면 `(m.judged_through(), m.live())`를 스냅숏 목록에 넣는다. `GenRun.rows/ol/starts`도 같이 모은다(기존 `gen_run`과 같은 방식).

- [ ] **Step 2: 테스트** `live_reasons_match_report_while_judging`:
  - 설정: `cfg5` 형태 6계단(`targets [10..=60 step 10]`, hold 20·ramp 1·discard 5, `auto_stop: Some(AutoStopConfig { saturation: None, emergency: None })` — 정지 없이 끝까지 판정).
  - 입력 `[(0,500), (5,500), (0,500), (0,6000), (0,8000), (0,7000)]`.
  - 고정 단언(fixture 가드): 최종 리포트 상태 = `[ok, spike, ok, saturated, saturated, after]`; 계단 1 사유 kind = `errors`; 계단 4·5 사유 = `p99_relative`이고 바로 앞 계단(3·4)은 `ok`가 아니며 p99 ≥ 1000, 기준 계단 2는 p99 < 1000.
  - 어떤 스냅숏에서 `step_states[1] == Unconfirmed`였다(잠정 → spike 전환 경유).
  - **모든 스냅숏 `(jt, s)`, 모든 `i <= jt`**: `s.step_reasons[i].reasons == rep.steps[i].reasons`, `slot_limited == rep.steps[i].slot_limited`, `ref_fast == stair_ref_step 규칙(앞쪽 가장 가까운 ok 행의 p99_us < 1000)`(리포트 행에서 직접 계산 — `export::stair_ref_step`(`export.rs:669`)은 private이므로 테스트 안에서 같은 규칙을 3줄로).
  - 스냅숏 수 = 6(5초 묶음마다 계단 하나 완결 — 리뷰 추적값; 다르면 STOP하고 원인 확인).

- [ ] **Step 3: 통과 확인 + 되돌려 확인** — `cargo nextest run -p handicap-controller live_reasons_match_report_while_judging` PASS → Task 1의 `ref_fast` 계산을 `i.checked_sub(1)` 계단으로 바꾸면 이 테스트가 계단 4에서 RED(계단 0–3은 같은 값 — 계단 2는 앞 계단 1의 p99 500 < 1000이라 같음; 계단 4·5가 RED) → 원복 GREEN(출력 남김).

- [ ] **Step 4: 비용 측정 테스트** (`stair_live.rs`) `#[test] #[ignore] fn live_cost_50_steps()`: 50계단 `Judgement`를 손으로 구성(states 전부 `After`, 계단마다 사유 4개 achieved·dropped·errors·p99_relative) vs 사유 0개 판. 각 판에서 `build_live` + `clone()` + `serde_json::to_vec` 10 000회 평균 ns와 JSON 바이트 수를 `eprintln!`. 실행: `cargo test --release -p handicap-controller live_cost_50_steps -- --ignored --nocapture`. 숫자 네 개(평균 ns 두 개·바이트 두 개)를 리포트에 남긴다(마무리 때 build-log 기록 — 판정: 사유 판 build+clone이 폴링 주기 1 s 대비 무시 가능한지).

- [ ] **Step 5: 커밋** (단일 FOREGROUND 호출, timeout 600000) — `test(controller): 판정 도중 실행 중 이유 = 최종 리포트 사유, 50계단 비용 측정`.

---

### Task 3: UI — 스키마·사유 조각 공용 함수·실행 중 라벨/요약 (순수 함수)

**Files:**
- Modify: `ui/src/api/schemas.ts` (`StairLiveSchema`에 `step_reasons`)
- Modify: `ui/src/components/report/stair/stairFormat.ts:55` (`reasonPartTexts` 떼어 냄)
- Modify: `ui/src/components/run/stairLive.ts` (`liveReasonText`·`liveStepLabel`, `liveSummaryText` 그룹 규칙, `liveHeadText` null 규칙)
- Modify: `ui/src/i18n/ko.ts` (`runDetail.stairLive`에 `withReasons`·`unconfirmedPendingWith`)
- Test: `ui/src/components/run/__tests__/stairLive.test.ts`, 기존 fixture 보강 `ui/src/components/run/__tests__/StairLivePanel.test.tsx`·`ui/src/pages/__tests__/RunDetailPage.test.tsx`(`liveBody`에 `step_reasons`)

**Interfaces:**
- Consumes: Task 1 와이어 모양.
- Produces:
  - 스키마 항목 `StairLiveReasonsSchema = z.object({ reasons: z.array(StairReasonSchema), slot_limited: z.boolean(), ref_fast: z.boolean() }).strict()`; `StairLiveSchema.step_reasons: z.array(StairLiveReasonsSchema)`(nullish 아님).
  - `export function reasonPartTexts(reasons: StairStep["reasons"], slotLimited: boolean, refFast: boolean): string[]` (stairFormat.ts) — `reasonTexts`는 고정 문구 상태 처리 뒤 `const ref = refStep(stair.steps, step.index); return reasonPartTexts(step.reasons, step.slot_limited, ref != null && ref.p99_us < 1000)`.
  - `export function liveReasonText(live: StairLive, i: number): string | null` — 조각을 `, `로; 항목이 없거나(`step_reasons[i]` undefined 포함) 조각 0이면 `null`.
  - `export function liveStepLabel(live: StairLive, i: number): string` — 이유 없음 → `liveStateLabel(s, live)`; 잠정 실패(`unconfirmed` & 정지 없음 & 비동결) + 이유 → `t.unconfirmedPendingWith(r)`; 그 밖 + 이유 → `t.withReasons(liveStateLabel(s, live), r)`.
  - ko: `withReasons: (label: string, reasons: string) => \`${label}(${reasons})\``, `unconfirmedPendingWith: (reasons: string) => \`실패(${reasons}, 다음 계단 확인 중)\``.

- [ ] **Step 1: 실패 테스트 작성** (`stairLive.test.ts` — 타입 import에 `StairStep` 추가; `live()` 헬퍼는 `step_reasons` 미지정 시 `step_states` 길이만큼 빈 항목을 채운다; `rs(kind, value)` 헬퍼)

  ```ts
  const empty = { reasons: [], slot_limited: false, ref_fast: false };
  const rs = (kind: StairStep["reasons"][number]["kind"], value: number) => ({ kind, value });
  const R = (reasons: ReturnType<typeof rs>[], over: Partial<typeof empty> = {}) => ({ ...empty, reasons, ...over });
  it("schema_accepts_step_reasons_and_rejects_missing_or_extra", () => {
    // server 모양 + step_reasons → success; step_reasons 삭제 → fail; 항목에 bogus 키 → fail
  });
  it("step_label_reason_texts", () => {
    const l = live({
      step_states: ["ok", "spike", "ok", "saturated", "saturated"],
      step_reasons: [empty, R([rs("errors", 0.046)]), empty, R([rs("p99_relative", 3.94)]), R([rs("p99_relative", 9.2)], { ref_fast: true })],
    });
    expect(liveStepLabel(l, 1)).toBe("튄 계단(오류 4.6%)");
    expect(liveStepLabel(l, 3)).toBe("포화(p99 3.9×)");
    expect(liveStepLabel(l, 4)).toBe("포화(p99 5 ms 이상)");
    expect(liveStepLabel(l, 0)).toBe("정상");
  });
  it("step_label_unconfirmed_pending_one_paren", () => {
    // ["ok","unconfirmed"] + 오류 0.046 → "실패(오류 4.6%, 다음 계단 확인 중)"; stop 있으면 → "확인 못 한 실패(오류 4.6%)"
  });
  it("step_label_after_without_reasons_has_no_parens", () => {
    // ["ok","saturated","after"], after 항목 empty → liveStepLabel(l, 2) === "포화 이후"; after에 이유 있으면 "포화 이후(p99 3.1×)"
  });
  it("step_label_max_reasons", () => {
    // saturated + [achieved 0.5, dropped 1e9, errors 0.046, p99_relative 12345.6] → "포화(달성 50.0%, dropped 1,000,000,000, 오류 4.6%, p99 12345.6×)"
    // 같은 입력 ["ok","saturated"]의 liveSummaryText → "1 정상 · 2 포화(달성 50.0%, dropped 1,000,000,000, 오류 4.6%, p99 12345.6×)" (US4 최다 조합이 요약 줄에 실제로 붙는지)
    // saturated + [achieved 0.8, dropped 1e9], slot_limited → "포화(달성 80.0%, dropped 1,000,000,000, 슬롯 부족 의심)"
  });
  it("missing_step_reasons_is_no_reason", () => {
    // step_reasons: [] 인데 step_states ["ok","spike"] → liveStepLabel(l,1) === "튄 계단", liveReasonText(l,1) === null, 던지지 않음
  });
  it("live_parts_equal_report_parts", () => {
    // 리포트 fixture = 골든 StairReport 복제 + `StairResultSection.test.tsx`의 `withStep` 패턴(계단 0 ok p99 500, 계단 1 saturated p99_relative)과 같은 사유의 live:
    // liveReasonText(l, 1)!.split(", ") 와 reasonTexts(report, report.steps[1]) 가 같은 배열
  });
  ```

  `summary_groups`에 추가(기존 단언 무수정):
  - `["ok","spike","ok"]` + 계단 1 오류 0.046 → `"1 정상 · 2 튄 계단(오류 4.6%) · 3 정상"`
  - `["ok","saturated","saturated","after","after"]` + 2·3 서로 다른 이유, 4·5 이유 있음 → `"1 정상 · 2 포화(오류 4.6%) · 3 포화(p99 3.9×) · 4–5 포화 이후"` (실패 상태 + 이유 = 계단마다 한 그룹, `after`는 이유가 있어도 묶고 안 붙임)
  - `["ok","unconfirmed","measuring"]` + 오류 → `"1 정상 · 2 실패(오류 4.6%, 다음 계단 확인 중)"`

  `head_waiting_current_and_after_stop`에 추가: `current_step: null` + `step_states: ["ok","ok"]`(전부 판정) → `liveHeadText(...) === null`; `current_step: null` + `["pending","pending"]` → `"첫 데이터 대기 중"`(기존 단언 유지).

- [ ] **Step 2: 실패 확인** — `cd ui && pnpm vitest run src/components/run/__tests__/stairLive.test.ts` → FAIL(함수·스키마 없음).

- [ ] **Step 3: 구현** — 위 Interfaces 그대로. `liveSummaryText` 그룹 규칙: 판정 칩 구간(`judgedCount`) 안에서 상태가 `spike`·`saturated`·`unconfirmed`이고 `liveReasonText(live, i) != null`이면 단독 그룹(`t.group(i+1, i+1, liveStepLabel(live, i))`), 나머지는 지금처럼 같은 상태끼리 묶어 `liveStateLabel`. `liveHeadText`: `current_step == null`이면 `judgedCount(live) > 0 ? null : t.waitingFirst`.

- [ ] **Step 4: 기존 fixture 보강** — `StairLivePanel.test.tsx`의 `live()` 헬퍼와 `RunDetailPage.test.tsx` `liveBody`(`:1608` 근처)에 `step_reasons`(길이 = `step_states`) 추가 — strict 스키마 때문에 안 하면 상세 렌더 테스트가 파싱 실패.

- [ ] **Step 5: 통과 + 게이트** — `cd ui && pnpm lint && pnpm test && pnpm build; echo exit=$?` → exit=0. `stairExportParity.test.ts`·`stairPrint.test.tsx` 무수정 통과.

- [ ] **Step 6: 되돌려 확인** — ① `liveSummaryText`의 단독 그룹 규칙을 빼면 「2 포화(오류…) · 3 포화(p99…)」 단언 RED ② `reasonPartTexts` 호출에 `refFast`를 `false` 고정하면 `step_label_reason_texts`의 「p99 5 ms 이상」 RED → 원복 GREEN.

- [ ] **Step 7: 커밋** (단일 FOREGROUND 호출, timeout 600000) — `feat(ui): 실행 중 계단 요약·라벨에 실패 이유 — 리포트 사유 조각 공용`.

---

### Task 4: UI — 칩 라벨에 이유 + run 상세 표 가로 스크롤 상자

**Files:**
- Modify: `ui/src/components/run/StairLivePanel.tsx` (`texts.labels` = `liveStepLabel(live, i)`)
- Modify: `ui/src/pages/RunDetailPage.tsx:409`·`:451` (두 `<table className="min-w-full text-sm">`를 각각 `<div className="overflow-x-auto">`로 감쌈)
- Test: `ui/src/components/run/__tests__/StairLivePanel.test.tsx`, `ui/src/pages/__tests__/RunDetailPage.test.tsx`

**Interfaces:**
- Consumes: Task 3 `liveStepLabel(live, i): string`, `ko.runDetail.stairLive.chipLabel(n, state)`(무변경).

- [ ] **Step 1: 실패 테스트**
  - `chip_labels_carry_reasons`: 칩 `["ok","spike","ok","saturated","after","measuring"]` + 2번 오류 0.046 · 4번 p99_relative 3.94 · 5번 p99_relative 3.14 → `getByRole("listitem", { name: "2계단 튄 계단(오류 4.6%)" })`의 `title`이 같은 글자; 4번 `"4계단 포화(p99 3.9×)"`; 5번 `"5계단 포화 이후(p99 3.1×)"`; 1번 `"1계단 정상"`·6번 `"6계단 측정 중"` 불변.
  - `summary_line_wraps`(**기존 동작 유지 확인 — 변경 전에도 통과**): `saturated` 계단에 이유 네 개·큰 숫자 fixture에서 요약 `<p>`에 `break-words` 클래스.
  - RunDetailPage `metric_tables_scroll_in_box`: running run + windows 1개 + 스텝 1개 렌더 → 두 표 각각의 `parentElement`가 `overflow-x-auto` 클래스를 가진다.

- [ ] **Step 2: 실패 확인** — `cd ui && pnpm vitest run src/components/run/__tests__/StairLivePanel.test.tsx src/pages/__tests__/RunDetailPage.test.tsx` → FAIL.

- [ ] **Step 3: 구현** — 위 Files 그대로(마크업 외 변경 없음).

- [ ] **Step 4: 게이트** — `cd ui && pnpm lint && pnpm test && pnpm build; echo exit=$?` → exit=0.

- [ ] **Step 5: 되돌려 확인** — `texts.labels`를 `liveStateLabel`로 되돌리면 `chip_labels_carry_reasons` RED, 감싼 `div` 하나를 빼면 `metric_tables_scroll_in_box` RED → 원복 GREEN.

- [ ] **Step 6: 커밋** (단일 FOREGROUND 호출, timeout 600000) — `feat(ui): 계단 칩 라벨에 실패 이유, run 상세 표 가로 스크롤 상자`.

---

## 라이브 검증 (파이프라인 5단계 — US 척추, plan task 아님)

`/live-verify` 스택(워크트리 자체 바이너리 — `cargo build -p handicap-worker` 포함, 응답기 keep-alive 기본), 시나리오에 `status: 200` 단언 필수(§B70 (4) ①). spec §7 표 그대로:

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 오류로 실패하는 계단 run + 지연으로 실패하는 계단 run(두 run 허용) | 요약 줄 「N 튄 계단(오류 x%)」/「M 포화(…)」, 지연 run 「(p99 y×)」 또는 「(p99 5 ms 이상)」 · 끝난 리포트 사유 칸과 조각 글자 같음 |
| US2 | 실패·포화 이후 칩 hover / 접근성 트리 | `title`·`aria-label` = 상태+이유, 이유 없는 칩 글자 불변 |
| US3 | 페이지 안 `MutationObserver` 기록기로 판정 순간 | 판정된 계단을 「측정 중」으로 보인 기록 0 · 다음 계단 「상승 중」 · 전부 판정 뒤 머리 줄 없음 |
| US4 | 400px 뷰포트 — Playwright 응답 가로채기로 최다 조합 두 가지 + 큰 숫자를 **`saturated`/`spike` 계단에**(요약 줄에 붙는 상태 — `after`는 요약에 안 붙음), 그리고 실제 run 화면 | 문서 폭 ≤ 화면 폭(rect) · 표 상자만 스크롤 · 요약 줄 겹침·잘림 0 |
| 성능 | Task 2 Step 4 숫자 + 라이브 `GET /api/runs/{id}` 응답 바이트(50계단 run이면 그것, 아니면 측정 테스트 값) | build-log에 숫자 |

추가: 콘솔 오류 0 · 계단 아닌 running run 상세 정상 · UI 변경 뒤 `just ui-build` + hard reload(stale 번들 함정).

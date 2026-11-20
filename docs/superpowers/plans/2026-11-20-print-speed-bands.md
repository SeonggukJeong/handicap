# 인쇄 보고서 보강 (응답 속도 구간 + 기준·측정값 자릿수) Implementation Plan

REVIEW-GATE: APPROVED

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 인쇄 보고서에서 판정에 쓰이는 측정값·기준값이 서로 구분되는 글자로 찍히고, 표준판에 「3. 단계별 응답 속도 구간」 절이 시안 그대로 나온다.

**Architecture:** (1) UI `ui/src/print/format.ts`에 쌍 표기 순수 함수를 두고 판정 문장·목표 줄·기준 표가 그것을 쓴다. (2) 컨트롤러 `build_report`가 이미 만든 전체·단계별 HDR 히스토그램을 한 번 훑어 `ReportJson.speed_bands`를 낸다(판정과 같은 ms 버림 잣대). (3) UI가 `speed_bands`를 순수 모델(`speedBands.ts`)로 바꿔 표준판 표 블록으로 그린다.

**Tech Stack:** Rust(`hdrhistogram`, serde) · TypeScript/React · Zod · vitest · `ko.ts` 문구 카탈로그.

**Spec:** `docs/superpowers/specs/2026-11-20-print-speed-bands-design.md` (실행자는 spec과 함께 읽는다 — 문구·표 규칙의 정본은 spec §5·§6·§7)

**시각 기준:** `docs/superpowers/specs/assets/2026-11-20-print-speed-bands/speed-bands-v2.html` — 이 파일의 CSS·마크업이 **시각 기준**이다(참고용이 아니다). 색·빗금·굵기·칸 폭·줄 간격·클래스 구조를 그대로 옮긴다. `.guide`·`.case`·경우 1의 `.alt` 블록은 설명용이라 옮기지 않는다.

## Global Constraints

- UI 문구는 전부 `ui/src/i18n/ko.ts` 경유(`ko.print.*`). 보고서 문체 — 질문형·구어체 금지.
- 인쇄 CSS는 `ui/src/print/print.css`의 `.p-root` 범위.
- 판단 로직은 `ui/src/print/`의 순수 함수, 컴포넌트는 그리기만.
- 렌더 경로에서 `normalizeProfile` 금지(기준은 `buildPrintDoc`이 `safeParse`로 얻은 `criteria`를 쓴다).
- 엔진·proto·DB·워커·`export.rs` 로직·판정 로직(`evaluate_criteria`)·2절 표 규칙(`stepStatus.ts`) 무변경.
- 응답 시간 기준이 없는 run의 리포트 JSON은 `speed_bands` 키 외에 바뀌지 않는다.
- 요약판(`summaryBlocks`)에는 새 절을 넣지 않는다.
- 놀라운 동작을 변호하는 주석 금지(working-rules §7) — 고치거나, 못 고치면 보고.
- UI task는 테스트 파일 편집을 먼저(tdd-guard). UI 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build`.
- 커밋은 단독 git 명령(`git add <리터럴 경로>` → `git commit -F <메시지 파일>`), 파이프·`--no-verify` 금지, cargo-영향 커밋은 단일 foreground 호출(timeout 600000ms).

## Review Focus

1. **기준과 아슬아슬한 값** — 초과 몫 5.04%·4.96%(허용 5%), 측정 3,040ms·기준 3,000ms: 표시가 붙은 칸과 안 붙은 칸에 같은 글자가 찍히면 안 된다. → Task 1·4 테스트.
2. **저장 오차가 있는 기준**(0.7% 입력 = `0.006999999999999999`) 대 정확히 0.007 측정: 6자리에서도 같은 글자 → 꼬리/`*`가 붙어야 한다. → Task 1·4 테스트.
3. **단계 기준만 있는 run**(run 수준 응답 시간 기준 없음): 머리 작은 글씨·각주·단계 줄이 spec §7.4 표 넷째 행대로. → Task 4 테스트.
4. **보내지 않은 요청·표본 없는 단계·실행 안 된 단계**: 분모가 0이거나 `speed_bands.steps`에 없는 행에서 0 나눗셈·`NaN%` 없이 「—」. → Task 4 테스트.
5. **소수 단계 기준**(2999.5)·기준 0: `slow_ms = floor`, 경계 글자 `0ms`. → Task 3·4 테스트.

---

### Task 1: 쌍 표기 함수 (`format.ts`)

**Files:**
- Modify: `ui/src/print/format.ts`
- Modify: `ui/src/i18n/ko.ts` (`ko.print.fmt`에 키 추가)
- Test: `ui/src/print/__tests__/format.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** ms → "3,040ms". 소수가 있으면 소수 3자리까지 뒤 0 제거("2,999.5ms"). */
  export function fmtMsExact(ms: number): string;
  /** 경계값 글자: 0 → "0ms", 0이 아닌 1000의 배수 → "3초", 그 밖 → fmtMsExact. */
  export function fmtBoundary(ms: number): string;
  export type PairText = { actual: string; threshold: string; tiny: boolean };
  /** fraction(0–1) 쌍 → 같은 자릿수의 % 글자 둘. base 자리에서 시작해 값이 다른데 글자가 같으면 6자리까지 늘림.
   *  6자리에서도 같으면 base 자리 글자 + tiny=true. 0이 아닌 값이 "0.0…%"로 찍히면 그 자릿수의 "미만" 표기. */
  export function fmtPctPair(actual: number, threshold: number, base: number): PairText;
  /** rps 쌍(단위 포함, 기본 1자리, 같은 규칙). */
  export function fmtRpsPair(actual: number, threshold: number): PairText;
  /** 시간 쌍: fmtMsExact 둘. 값이 다른데 글자가 같으면 tiny=true. */
  export function fmtMsPair(actual: number, threshold: number): PairText;
  /** metric으로 갈래를 골라 주는 진입점. *_ms → fmtMsPair, *_rate → fmtPctPair(base 2), rps·min_window_rps → fmtRpsPair, *_count → 정수(기존 count 문구).
   *  모르는 metric → String(v) 둘, tiny=false. */
  export function fmtCriterionPair(metric: string, actual: number, threshold: number): PairText;
  /** 측정값 없이 기준값만(판정 안 함 등): 같은 갈래의 기본 자릿수. */
  export function fmtCriterionThreshold(metric: string, threshold: number): string;
  ```
- `ko.print.fmt` 새 키: `msExact: (s: string) => \`${s}ms\``, `pctUnder: (unit: string) => \`${unit}% 미만\`` (unit = "0.1"·"0.01"…), `tiny: "(기준과 차이가 아주 작음)"`. 기존 `pctUnderTenth`는 그대로 둔다(기존 `fmtPct`가 쓴다).

- [ ] **Step 1: 실패하는 테스트 작성** — `format.test.ts`에 `describe("pair formatting")` 추가:

```ts
it("ms는 반올림 없이, 소수 기준은 3자리까지", () => {
  expect(fmtMsExact(3040)).toBe("3,040ms");
  expect(fmtMsExact(0)).toBe("0ms");
  expect(fmtMsExact(2999.5)).toBe("2,999.5ms");
  expect(fmtMsPair(3040, 3000)).toEqual({ actual: "3,040ms", threshold: "3,000ms", tiny: false });
  expect(fmtMsPair(3000, 2999.9999).tiny).toBe(true);
});
it("경계값 글자", () => {
  expect(fmtBoundary(0)).toBe("0ms");
  expect(fmtBoundary(3000)).toBe("3초");
  expect(fmtBoundary(800)).toBe("800ms");
  expect(fmtBoundary(2500)).toBe("2,500ms");
});
it("비율 쌍은 글자가 달라질 때까지 자릿수를 늘린다", () => {
  expect(fmtPctPair(0.0104, 0.01, 2)).toEqual({ actual: "1.04%", threshold: "1.00%", tiny: false });
  expect(fmtPctPair(0.0504, 0.05, 1)).toEqual({ actual: "5.04%", threshold: "5.00%", tiny: false });
  expect(fmtPctPair(0.0496, 0.05, 1)).toEqual({ actual: "4.96%", threshold: "5.00%", tiny: false });
  expect(fmtPctPair(0.32, 0.05, 1)).toEqual({ actual: "32.0%", threshold: "5.0%", tiny: false });
  expect(fmtPctPair(0.05, 0.05, 2)).toEqual({ actual: "5.00%", threshold: "5.00%", tiny: false });
});
it("6자리에서도 같으면 기본 자릿수 + tiny", () => {
  const thr = Number("0.7") / 100; // 0.006999999999999999
  expect(fmtPctPair(0.007, thr, 2)).toEqual({ actual: "0.70%", threshold: "0.70%", tiny: true });
});
it("0이 아닌 값이 0으로 찍히면 그 자릿수의 미만 표기", () => {
  expect(fmtPctPair(0.0004, 0.5, 1).actual).toBe("0.1% 미만");
  expect(fmtPctPair(0, 0.05, 1).actual).toBe("0.0%");
});
it("metric 진입점", () => {
  expect(fmtCriterionPair("p95_ms", 3040, 3000).actual).toBe("3,040ms");
  expect(fmtCriterionPair("error_rate", 0.0104, 0.01).actual).toBe("1.04%");
  expect(fmtCriterionPair("rps", 412.64, 400)).toMatchObject({ actual: "412.6건/초", threshold: "400.0건/초" });
  expect(fmtCriterionThreshold("p95_ms", 3000)).toBe("3,000ms");
  expect(fmtCriterionPair("weird", 7, 9)).toEqual({ actual: "7", threshold: "9", tiny: false });
  expect(fmtCriterionThreshold("weird", 7)).toBe("7");
});
it("불변식: 값이 다르면 글자가 다르거나 tiny", () => {
  // 고정 시드 반복(값 500쌍): a, t in [0,1), 일부는 a = t ± 1e-9
  // 모든 쌍에서 a === t || r.actual !== r.threshold || r.tiny
});
```
(`fmtRpsPair`의 단위는 기존 `ko.print.fmt.rpsUnit` — 테스트 기대값은 위처럼 리터럴로 적는다. 실제 키 값이 `건/초`가 아니면 리터럴을 그 값으로 고친다.)

- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test format` → 새 케이스 FAIL(함수 없음).
- [ ] **Step 3: 구현** — 자릿수 반올림은 기존 `fmtMs`처럼 `Math.round` 기반 정수 연산으로(`toFixed` 반올림 오차 회피): `Math.round(p * 10^d) / 10^d` 뒤 `toFixed(d)`.
- [ ] **Step 4: 통과 확인** — `pnpm test format` PASS.
- [ ] **Step 5: 되돌려 확인** — `fmtPctPair`의 자릿수 늘리기를 꺼서(항상 base) `0.0504 vs 0.05` 케이스와 불변식 케이스가 RED인지 보고 원복.
- [ ] **Step 6: 게이트·커밋** — `pnpm lint && pnpm test && pnpm build` 후 커밋 `feat(ui/print): 기준·측정값 쌍 표기 함수`.

---

### Task 2: 판정 문장·목표 줄·기준 표에 쌍 표기 적용 (US1)

**Files:**
- Modify: `ui/src/print/verdict.ts` (`criterionValue`, `kpiCards`의 `targetFor`, `otherCriteriaRows`)
- Modify: `ui/src/print/sentences.ts` (`verdictLine`, 느림 줄 `S.slow(...)` 호출부)
- Modify: `ui/src/i18n/ko.ts` (`ko.print.kpi`에 `measured: (v: string) => \`(측정 ${v})\``, `measuredTiny: (v: string) => \`(측정 ${v}, 기준과 차이가 아주 작음)\``)
- Test: `ui/src/print/__tests__/verdict.test.ts`, `ui/src/print/__tests__/sentences.test.ts`

**Interfaces:**
- Consumes: Task 1의 `fmtCriterionPair`·`fmtCriterionThreshold`·`fmtMsPair`·`ko.print.fmt.tiny`.
- Produces: 동작 변경만(시그니처 불변). `criterionValue`는 지운다 — 남은 참조가 없어야 한다(`grep -rn "criterionValue" ui/src` → 0). 지금 참조: `verdict.ts`(정의 + `kpiCards`·`otherCriteriaRows`), `sentences.ts`(`verdictLine`), 그리고 `verdict.test.ts`의 import와 `criterionValue` 단위 테스트 블록 — 그 블록은 지운다(같은 갈래 단언은 Task 1의 `fmtCriterionPair`/`fmtCriterionThreshold` 테스트가 갖고 있고, 모르는 metric `"weird"` 케이스도 거기 있다).

규칙(spec §5):
- **목표 줄**(`targetFor`): 기준값은 `fmtCriterionThreshold`. 서버 판정 행이 있고 상자가 판정 안 함·판정할 수 없음이 아니면 끝에 ` ${ko.print.kpi.measured(pair.actual)}`를 덧붙인다(`pair = fmtCriterionPair(metric, row.actual, spec.threshold)`, 기준값 글자도 `pair.threshold`). `pair.tiny`면 `ko.print.kpi.measuredTiny(pair.actual)`를 쓴다(괄호가 겹치지 않게). 큰 숫자(`value`)는 무변경.
- **그 밖의 기준 표**(`otherCriteriaRows`): 판정 행이 있으면 `target`·`actual`을 `pair`에서, `tiny`면 `actual` 뒤에 꼬리. 행이 없으면 `fmtCriterionThreshold`.
- **판정 줄**(`verdictLine`): `thr`·`act`를 `pair`에서, `tiny`면 `act` 뒤에 꼬리.
- **느림 줄**: `fmtMs(worst.p95Ms)`·`fmtMs(thr)` → `fmtMsPair(worst.p95Ms, thr)`.

- [ ] **Step 1: 실패하는 테스트 작성**

`verdict.test.ts`:
```ts
it("목표 줄에 측정값이 반올림 없이 붙는다 (미달)", () => {
  // summary.p95_ms = 3040, criteria.max_p95_ms = 3000, verdict row {metric:"p95_ms", threshold:3000, actual:3040, passed:false}
  const card = cards.find((c) => c.key === "p95")!;
  expect(card.value).toBe(fmtMs(3040));            // 큰 숫자는 그대로
  expect(card.target).toBe("목표 3,000ms 이하 ✕ 미달 (측정 3,040ms)");
});
it("판정 안 함이면 측정값을 덧붙이지 않는다", () => { /* box.kind === "notJudged" → target에 "(측정" 없음 */ });
it("오류율 0.7% 저장 오차: 꼬리가 붙는다", () => {
  // threshold = Number("0.7")/100, actual = 0.007, passed:false
  expect(card.target).toBe("목표 0.70% 이하 ✕ 미달 (측정 0.70%, 기준과 차이가 아주 작음)");
});
it("그 밖의 기준 표: 미달 행의 target·actual 글자가 다르다", () => {
  // p99_ms threshold 5000 actual 5004 → "5,000ms 이하" / "5,004ms"
});
```
`sentences.test.ts`:
```ts
it("판정 줄: 측정·기준이 구분되는 글자", () => {
  // p95 3040 vs 3000 미달 → 문장에 "3,040ms"와 "3,000ms"가 둘 다 있고 "3.0초"는 없다
});
it("느림 줄: 단계 p95·기준이 ms로", () => {
  // 단계 p95 3040, 기준 3000 → "3,040ms"·"3,000ms" 포함
});
```
기존 테스트 중 `"3.0초"` 같은 옛 기대값을 가진 판정 쌍 단언은 새 글자로 고친다(판정과 무관한 숫자의 기대값은 건드리지 않는다).

- [ ] **Step 2: 실패 확인** — `pnpm test verdict` / `pnpm test sentences` FAIL.
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** + `grep -rn "criterionValue" ui/src` → 출력 없음.
- [ ] **Step 5: 되돌려 확인** — `targetFor`의 측정값 덧붙이기를 지워 첫 테스트가 RED인지 보고 원복.
- [ ] **Step 6: 게이트·커밋** — `pnpm lint && pnpm test && pnpm build`. 커밋 `fix(ui/print): 판정에 쓰이는 측정값·기준값을 구분되는 자릿수로`.

---

### Task 3: 컨트롤러 `speed_bands` + UI 스키마 (와이어 — code-quality 리뷰 `model: opus`)

> 컨트롤러가 새 키를 내기 시작하는 커밋에 UI 스키마가 같이 있어야 한다 — `ReportSchema`가 `.strict()`라 스키마 없이 이 커밋만 들어가면 화면 리포트·인쇄 화면의 `/report` 파싱이 전부 깨진다. 그래서 이 task는 cargo 게이트와 UI 게이트를 둘 다 지난다.

**Files:**
- Create: `crates/controller/tests/speed_bands_test.rs` (**가장 먼저** — `lib.rs`에는 `#[cfg(test)]`가 없어 pending 테스트 파일이 있어야 tdd-guard가 `lib.rs` 편집을 허용한다)
- Create: `crates/controller/src/speed_bands.rs`
- Modify: `crates/controller/src/lib.rs` (`pub mod speed_bands;`)
- Modify: `ui/src/api/schemas.ts` (`ReportSchema` — `:745`)
- Create: `ui/src/print/__tests__/speedBands.test.ts` (이 task에서는 스키마 케이스만 — UI 쪽 첫 편집)
- Modify: `crates/controller/src/report.rs` (`ReportJson`에 필드 — 구조체는 `:18`, 히스토그램은 `:632-633`의 `overall`·`per_step`, 반환 리터럴은 `:1161`; 줄번호는 `grep -n`으로 다시 확정)
- Modify: `crates/controller/src/export.rs` (테스트 픽스처의 `ReportJson` 리터럴에 `speed_bands: None`)
- Test: `crates/controller/tests/speed_bands_test.rs`(pub API 단위 테스트), `crates/controller/src/report.rs` 인라인 테스트 1건, `ui/src/print/__tests__/speedBands.test.ts`(스키마)

**Interfaces:**
- Produces (와이어 — spec §6.1):
  ```rust
  #[derive(Debug, Serialize, Deserialize, PartialEq)]
  pub struct SpeedBands { pub overall: SpeedBandRow, pub steps: Vec<SpeedBandStep> }
  #[derive(Debug, Serialize, Deserialize, PartialEq)]
  pub struct SpeedBandStep { pub step_id: String, #[serde(flatten)] pub row: SpeedBandRow }
  #[derive(Debug, Serialize, Deserialize, PartialEq)]
  pub struct SpeedBandRow {
      pub slow_ms: u64,
      pub basis: String,        // "p95" | "p99" | "p50" | "default"
      pub own: bool,
      pub fast: Option<u64>,    // skip_serializing_if 없음 → None은 null
      pub within: u64,
      pub over: u64,
  }
  pub const FAST_MS: u64 = 1_000;
  pub const DEFAULT_SLOW_MS: u64 = 3_000;
  /** run 수준 경계: (slow_ms, basis). p95 → p99 → p50 → (3000, "default"). */
  pub fn run_boundary(c: Option<&Criteria>) -> (u64, &'static str);
  /** 단계 경계: step_criteria(op == "max", metric p95_ms/p99_ms/p50_ms, target == step_id)에서 같은 우선순위·가장 작은 값의 floor. 없으면 None. */
  pub fn step_boundary(c: Option<&Criteria>, step_id: &str) -> Option<(u64, &'static str)>;
  /** 히스토그램 한 번 훑기. ms = value_iterated_to()/1000; ms > slow_ms → over; slow_ms > FAST_MS && ms < FAST_MS → fast; 그 밖 → within. */
  pub fn count_bands(h: &Histogram<u64>, slow_ms: u64, basis: &'static str, own: bool) -> SpeedBandRow;
  /** 전체가 비면 None. 표본 없는 단계는 steps에서 뺀다. steps는 step_id 오름차순(BTreeMap 순서). */
  pub fn build(overall: &Histogram<u64>, per_step: &BTreeMap<String, Histogram<u64>>, c: Option<&Criteria>) -> Option<SpeedBands>;
  /** 판정과 같은 정수식: 초과 몫이 그 basis의 허용 몫을 넘는가. p95 → 20*over > total, p99 → 100*over > total, p50 → 2*over > total, default → false. */
  pub fn exceeds_allowance(basis: &str, over: u64, total: u64) -> bool;
  ```
  `fast`는 `slow_ms > FAST_MS`일 때만 `Some`(경계가 1초 이하면 두 구간).
- `ReportJson`: `#[serde(default, skip_serializing_if = "Option::is_none")] pub speed_bands: Option<crate::speed_bands::SpeedBands>,`
- UI 스키마(`schemas.ts`):
  ```ts
  export const SpeedBandRowSchema = z.object({
    slow_ms: z.number(), basis: z.enum(["p95", "p99", "p50", "default"]), own: z.boolean(),
    fast: z.number().nullable(), within: z.number(), over: z.number(),
  }).strict();
  export const SpeedBandsSchema = z.object({
    overall: SpeedBandRowSchema,
    steps: z.array(SpeedBandRowSchema.extend({ step_id: z.string() }).strict()),
  }).strict();
  export type SpeedBands = z.infer<typeof SpeedBandsSchema>;
  // ReportSchema: speed_bands: SpeedBandsSchema.optional()
  ```

- [ ] **Step 1: 실패하는 테스트 작성** — 먼저 `crates/controller/tests/speed_bands_test.rs`(`use handicap_controller::speed_bands::*;` 히스토그램은 엔진과 같은 범위 `Histogram::<u64>::new_with_bounds(1, 60_000_000, 3)`, 값은 µs), 그리고 UI `speedBands.test.ts`에 스키마 케이스(`SpeedBandsSchema.parse`가 `fast: null` 행 통과·모르는 키 거부, `ReportSchema`가 `speed_bands` 있는/없는 리포트 둘 다 통과).

```rust
#[test] fn boundary_priority_p95_then_p99_then_p50_then_default()   // (3000,"p95") / (5000,"p99") / (800,"p50") / (3000,"default")
#[test] fn step_boundary_takes_min_and_floors()                      // p95 max 5000·3000 → 3000; 2999.5 → 2999; op "min"·error_rate는 무시; 다른 target은 None
#[test] fn step_boundary_prefers_p95_over_p99()                      // 같은 단계에 p99 1000·p95 4000 → (4000,"p95")
#[test] fn counts_three_bands()                                      // 500ms×10, 2000ms×5, 4000ms×2, slow 3000 → fast Some(10), within 5, over 2
#[test] fn counts_two_bands_when_slow_at_most_one_second()           // slow 800 → fast None; slow 1000 → fast None; slow 1001 → fast Some(_)
#[test] fn boundary_edges_follow_ms_truncation()                     // slow 3000: 3000ms 기록은 within, 3001ms 기록은 over; 999ms fast, 1000ms within
#[test] fn zero_boundary_puts_everything_over_except_sub_ms()        // slow 0: 500µs → within(ms 0), 2ms → over
#[test] fn total_equals_recorded_len()                               // fast+within+over == h.len()
#[test] fn build_none_when_overall_empty_and_skips_empty_steps()
#[test] fn verdict_agrees_with_over_share()                          // 불변식 — 아래
```
불변식 테스트(spec §6.3): 고정 시드(예: 단순 LCG)로 히스토그램 300개(표본 1–5,000개, 값 1µs–10s 로그 분포 + 기준 ±1ms 근처 값 섞기)와 기준값을 만들고, (q, basis) 짝 (0.95, "p95")·(0.99, "p99")·(0.5, "p50") 각각에 대해
`(h.value_at_quantile(q) / 1_000 <= slow_ms) == !exceeds_allowance(basis, over, total)`를 단언한다. 정수식인 이유: 통과 ⇔ `N − over >= ceil(q·N)` ⇔ p95에서 `20·over <= N`(부동소수 `1.0 − 0.95`는 `0.05`와 글자 그대로 같지 않다). **이 단언이 어떤 입력에서 깨지면 구현을 멈추고 그 입력을 보고한다**(안내 줄 문구가 이 관계에 기댄다 — 테스트를 느슨하게 고치지 말 것). `exceeds_allowance` 자체도 표로 단언한다: `("p95", 5, 100) → false`, `("p95", 6, 100) → true`, `("p99", 1, 100) → false`, `("p99", 2, 100) → true`, `("p50", 50, 100) → false`, `("p50", 51, 100) → true`, `("default", 100, 100) → false`.

`report.rs` 인라인:
```rust
#[test] fn build_report_emits_speed_bands_and_keeps_rest()
// 기준 없는 run 픽스처로 build_report → speed_bands.overall.basis == "default";
// serde_json::to_value한 최상위 키 목록에서 "speed_bands"를 뺀 것이 이 변경 전 목록과 같다(최상위 키 가드 — 값 가드는 아니다. 값 무변경은 기존 report 테스트 전체가 그대로 통과하는 것으로 본다).
```

- [ ] **Step 2: 실패 확인** — `cargo test -p handicap-controller --test speed_bands_test`가 **컴파일 에러**(모듈 없음)로 실패, `cd ui && pnpm test speedBands` FAIL.
- [ ] **Step 3: 구현** — `build_report`에서 `overall`·`per_step`이 소비되기 전에(`percentiles_of(&overall)` 근처) `speed_bands::build(&overall, &per_step, run.profile.criteria.as_ref())`를 불러 지역 변수에 두고 리터럴에 넣는다. 디코드·병합을 다시 하지 않는다. `count_bands`는 할당 없이 `iter_recorded()` 한 번.
- [ ] **Step 4: 통과 확인** — `cargo build --workspace --tests` (누락 리터럴 0) → `cargo nextest run -p handicap-controller` PASS, `cargo clippy --workspace --all-targets -- -D warnings`, `cd ui && pnpm lint && pnpm test && pnpm build`.
- [ ] **Step 5: 되돌려 확인** — `count_bands`의 `ms > slow_ms`를 `ms >= slow_ms`로 바꿔 `boundary_edges_follow_ms_truncation`과 불변식 테스트가 RED인지 보고 원복.
- [ ] **Step 6: 커밋** (cargo + UI 파일을 한 커밋에, 단일 foreground, 600000ms) — `feat(controller): 리포트에 응답 속도 구간(speed_bands) + UI 스키마`.

---

### Task 4: 구간 모델 + 문구

**Files:**
- Create: `ui/src/print/speedBands.ts`
- Modify: `ui/src/i18n/ko.ts` (`ko.print.speed`, `ko.print.section`)
- Modify: `ui/src/print/buildPrintDoc.ts` (`PrintDoc.speed`)
- Test: `ui/src/print/__tests__/speedBands.test.ts`(Task 3이 만든 파일에 추가), `ui/src/print/__tests__/buildPrintDoc.test.ts`

**Interfaces:**
- Consumes: Task 1(`fmtPctPair`·`fmtBoundary`·`fmtMsExact`), Task 3의 `SpeedBands` 타입, 기존 `RankedRow`(`stepStatus.ts`)·`Matched`(`verdict.ts`)·`stepThresholds`·`fmtPct`.
- Produces:
  ```ts
  // speedBands.ts
  /** 굵게/붉게 칠할 조각을 가진 글 한 줄(시안의 <b>·<b class="bad">). */
  export type Seg = { text: string; strong?: boolean; bad?: boolean };
  export type Mark = "none" | "warn" | "bad";              // warn = ▲ 주황, bad = ✕/굵은 붉은
  export type SpeedCell = { text: string; mark: Mark; glyph: "" | "▲" | "✕"; muted: boolean; star: boolean };
  export type SpeedRow = {
    key: string;                     // stepId 또는 "total"
    total: boolean;
    label: string;                   // "① 로그인" / ko.print.speed.totalRow
    rowBad: boolean;                 // 실패 칸 ✕ → 행 바탕 + 이름 앞 ✕
    ownNote: string | null;          // "이 단계 기준 5초" — ko.print.speed.ownNote(fmtBoundary(row.slow_ms))
    bar: Array<{ band: "fast" | "within" | "over"; pct: number }> | null;  // null = 「—」
    merged: boolean;                 // fast === null 인 행이 세 구간 표에 있을 때
    fast: SpeedCell | null;          // 두 구간 표거나 merged면 null
    within: SpeedCell;               // merged면 text = "800ms 이내 91.0%" — ko.print.speed.withinMerged(fmtBoundary(slow_ms), 비율)
    over: SpeedCell;
    fail: SpeedCell;
  };
  export type SpeedModel = {
    twoBand: boolean;
    head: { fast: string | null; within: string; over: string; overSub: string | null };
    legend: Array<{ band: "fast" | "within" | "over"; text: string }>;  // 견본 색은 band로. 세 구간 = fast·within·over, 두 구간 = fast(이내)·over(초과) — 시안 경우 4의 .s1·.s3
    rows: SpeedRow[];                // table.rows 순서 + 마지막 total
    rule: { segs: Seg[]; fail: boolean } | null;         // run 수준 안내 줄
    stepRules: Seg[][];              // 최대 5, 미달 먼저 → 시나리오 순서
    stepRulesRest: string | null;
    ruleBoxFail: boolean;            // 안내 상자 왼쪽 테두리 붉게 = run 수준 줄이 미달일 때만(단계 줄 미달은 테두리를 바꾸지 않는다)
    notes: Seg[][];                  // 각주(순서: default 안내 → 막대 안내(+이름 문장) → 보내지 않음 → * 설명)
  };
  /** 안내 줄·쌍 표기에 찍는 허용 몫(글자용). */
  export const ALLOWED: Record<"p95" | "p99" | "p50", number> = { p95: 0.05, p99: 0.01, p50: 0.5 };
  /** 판정용 — 컨트롤러 `exceeds_allowance`와 같은 정수식(p95 20*over > total, p99 100*over > total, p50 2*over > total, default false). */
  export function exceedsAllowance(basis: SpeedBands["overall"]["basis"], over: number, total: number): boolean;
  export function buildSpeedModel(a: {
    bands: SpeedBands; ranked: RankedRow[]; summary: Report["summary"];
    matched: Matched[]; criteria: Criteria | null; anyNotSent: boolean;
  }): SpeedModel;
  ```
  `PrintDoc.speed: SpeedModel | null`(`report.speed_bands`가 없으면 `null`). `PrintDoc.sectionNo: { chart: string; conditions: string; glossary: string }` — speed가 있으면 4·5·6 제목, 없으면 기존 3·4·5 제목.
- `ko.print.section`: `speed: "3. 단계별 응답 속도 구간"`, `chartShifted: "4. 시간에 따른 변화"`, `conditionsShifted: "5. 측정 조건과 해석 범위"`, `glossaryShifted: "6. 용어 풀이"`(기존 세 키는 그대로).
- `ko.print.speed` 문구는 spec §7.3–§7.5와 시안 v2 글자 그대로(머리·범례·`totalRow: "전체 요청"`·`failSub: "막대와 별개"`·`overSubOver: "기준 넘음"`·`overSubMixed(b)`·`overSubNoCriteria: "기준 없는 단계는 3초"`·`ownNote(b)`·`withinMerged(b, p)`·`rule(...)`·`ruleNoVerdict(...)`·`stepRule(...)`·`stepRulesRest(n)`·`noteDefault`·`noteDefaultMixed`·`noteBars`·`noteNamed(glyph, name, pct)`·`noteNamedMore(n)`·`noteNotSent`·`noteStar`). 받침에 따라 달라지는 조사는 병기형.

규칙은 spec이 정본이다. 구현자가 따로 정할 것이 없도록 판정 갈래만 여기 못박는다:
- ▲ 판정은 `exceedsAllowance`(정수식)로만 한다. `ALLOWED`는 글자(안내 줄의 "5%", 쌍 표기의 비교값)에만 쓴다.
- 굵게/붉게 조각(시안 v2 그대로): 안내 줄의 「{경계} 초과가 N% 이하」와 초과 비율은 `strong`, 「이 기준은 미달」은 `strong`+`bad`, 「이 기준은 통과」는 `strong`. 단계 줄의 비율은 `strong`, 「미달」은 `strong`+`bad`, 「통과」는 `strong`. 이름 각주의 「✕ ⑤ 신청 제출」은 `strong`.
- 색 조각: `fast`가 없는 행(두 구간 표의 모든 행 + 세 구간 표의 합친 행)의 「이내」 조각은 가장 옅은 색 — `bar`의 그 조각을 `band: "fast"`로 낸다(컴포넌트는 band만 보고 칠한다).
- 자기 기준 글자는 실제로 쓰인 경계 `slow_ms`를 `fmtBoundary`로(소수 기준 2999.5 → `2,999ms`).
- 「걸릴 수 있는 칸」: basis ≠ `default`인 행의 초과 칸 → `fmtPctPair(over/total, ALLOWED[basis], 1)`; 오류율 기준이 있는 행(`stepThresholds(stepId, criteria).errorRate !== null`, total 행은 `criteria.max_error_rate`)의 실패 칸 → `fmtPctPair(errorRate, 기준, 1)`. `tiny`면 `star: true`.
- 실패 칸 표시: `status.tags`에 `error` → `bad`+`✕`+`rowBad`, `hasErrors` → `warn`+`▲`. total 행: `matched`에서 run 수준 `error_rate` 행이 `passed === false`면 `bad`(기호 없음).
- total 행 초과 칸: `matched`에서 run 수준 `${basis}_ms` 행이 `passed === false`면 `bad`(기호 없음), ▲ 없음.
- 실행 안 된 단계(`row.executed === false`): bar `null`, 네 칸 모두 `—`. 표본 없는 단계(`bands.steps`에 없음): bar `null`, 구간 칸 `—`, 실패 칸은 값.
- 이름 각주: 실패 칸 표시가 있고 bar가 있고 실패 비율 ≥ 0.10인 단계 중 비율이 가장 큰 것.

- [ ] **Step 1: 실패하는 테스트 작성** — `speedBands.test.ts`. 픽스처 헬퍼 `row(stepId, {count, errorCount, tags})`·`band(stepId, {slow_ms, basis, own, fast, within, over})`로 시안 v2의 경우를 그대로 옮긴다:

```ts
it("경우 1: 고른 표·p95 3000·미달", () => {
  // head = {fast:"1초 미만", within:"1초–3초", over:"3초 초과", overSub:"기준 넘음"}
  // ④ over 셀 = {text:"32.0%", mark:"warn", glyph:"▲"}; ⑤ fail 셀 glyph "✕", rowBad true
  // total over 셀 mark "bad", glyph ""
  // rule.fail === true·ruleBoxFail === true, rule.segs를 이어 붙인 글에 "7.00%"·"이 기준은 미달" 포함, "넘어 미달" 없음
  // notes에 noteBars와 "✕ ⑤ 신청 제출" 이름 문장
});
it("경우 2: 섞인 표 — 자기 기준 단계", () => {
  // head.within "1초–기준", over "기준 초과", overSub "3초 (따로 적힌 단계 제외)"
  // ④ ownNote "이 단계 기준 5초"; stepRules[0]를 이어 붙인 글에 "④ 첨부 업로드"·"5초 초과 14.00%"·"미달" 포함
  // ruleBoxFail false (run 줄은 통과, 단계 줄만 미달)
});
it("경우 3: 기준 없음", () => {
  // rule === null, 모든 over 셀 mark "none", overSub null, notes[0] === ko.print.speed.noteDefault
});
it("경우 4: 두 구간", () => {
  // twoBand true, head.fast null, head.within "800ms 이내", over "800ms 초과", legend = [{band:"fast", text:"800ms 이내"}, {band:"over", text:"800ms 초과 (기준 넘음)"}]
});
it("경우 6: 아슬아슬한 값과 기준 없는 실패", () => {
  // over 4.96% → {text:"4.96%", mark:"none"}; 5.04% → {text:"5.04%", mark:"warn", glyph:"▲"}
  // hasErrors 90% → fail {mark:"warn", glyph:"▲"}; 이름 문장 "▲ ③ 신청 제출"
  // hasErrors 0.3% → ▲는 붙지만 이름 문장 대상 아님
});
it("경우 7: 단계 기준만 있는 run", () => {
  // overSub "기준 없는 단계는 3초"; rule null; stepRules 2줄
  // ① merged true, within.text "800ms 이내 91.0%", bar = [{band:"fast",pct:91},{band:"over",pct:9}]
  // 오류율 기준 0.7% 저장 오차 단계 fail.star true, notes에 noteStar
  // anyNotSent true → noteNotSent; notes[0] === noteDefaultMixed
  // 실행 안 된 단계: bar null, fail.text "—"
});
it("서버 판정 없는 run(중단): 낱말 없는 안내 줄, ▲는 유지", () => {
  // 전체 초과 몫 7%(> 5%), matched의 row 전부 null
  // → rule 글이 "넘었습니다."로 끝나고 "통과"·"미달" 없음, rule.fail false
  // → total 행 over 셀 mark "none" (건수로 붉게 칠하지 않는다); 단계 ▲ 셀은 그대로
  // → 자기 기준 단계의 단계 줄도 낱말 없이 "…초과 14.00%."로 끝난다
});
it("단계 줄 순서: 미달 먼저", () => {
  // 시나리오 순서 ① 통과 · ② 미달 → stepRules[0]이 ②
});
it("두 구간 섞인 표 (run 800ms + 단계 500ms)", () => {
  // twoBand true, head.within "기준 이내", over "기준 초과", overSub "800ms (따로 적힌 단계 제외)", legend = [{band:"fast", text:"기준 이내"}, {band:"over", text:"기준 초과"}]
  // 모든 행 bar의 첫 조각 band "fast"
});
it("자기 기준이 run 값과 같으면 고른 표", () => {
  // run p95 3000 + 단계 own p95 3000 → head.over "3초 초과", overSub "기준 넘음", 그 단계 ownNote는 그대로 표시
});
it("실패 칸은 오류율 기준과 구분되게", () => {
  // 기준 1%, 단계 실패 1.04% → fail.text "1.04%"(✕), 0.96% → "0.96%"(표시 없음)
});
it("단계 기준 6개 → 5줄 + 나머지 줄", () => { /* stepRules.length 5, stepRulesRest에 "1건" */ });
it("표본 없는 단계·분모 0에서 NaN이 없다", () => {
  // JSON.stringify(model)에 "NaN" 없음
});
it("경계 0·소수 기준 글자", () => { /* slow_ms 0 → head.over "0ms 초과" */ });
```
`buildPrintDoc.test.ts`: `speed_bands` 있는 리포트 → `doc.speed !== null`·`doc.sectionNo.chart === "4. 시간에 따른 변화"`; 없는 리포트 → `doc.speed === null`·`sectionNo.chart === "3. 시간에 따른 변화"`.

- [ ] **Step 2: 실패 확인** — `pnpm test speedBands` FAIL.
- [ ] **Step 3: 구현** (`buildPrintDoc`의 `anyNotSent` = `table.rows.some(r => r.notSent > 0)`)
- [ ] **Step 4: 통과 확인** — `pnpm test speedBands`·`pnpm test buildPrintDoc` PASS.
- [ ] **Step 5: 되돌려 확인** — (a) 초과 칸을 `fmtPct`로 바꿔 경우 6이 RED, (b) total 행 `bad` 판정을 건수 기반으로 바꿔 "서버 판정 없는 run" 케이스가 RED인지 보고 각각 원복.
- [ ] **Step 6: 게이트·커밋** — `pnpm lint && pnpm test && pnpm build`. 커밋 `feat(ui/print): 응답 속도 구간 모델·문구`.

---

### Task 5: 표 컴포넌트·CSS·블록 배선 (화면이 처음 그려지는 task)

**Files:**
- Create: `ui/src/print/components/SpeedBandTable.tsx`
- Modify: `ui/src/print/print.css`
- Modify: `ui/src/print/buildPrintDoc.ts` (`MEASURE_IDS`, `standardBlocks`)
- Modify: `ui/src/print/PrintDocument.tsx` (`AtomicContent`, `MeasureSheet`, `PageView`)
- Modify: `ui/src/print/components/ErrorChart.tsx`·`ConditionsSection.tsx`·`GlossarySection.tsx` (고정 제목 대신 `doc.sectionNo.*` — 이미 `doc`을 받는 컴포넌트는 그것을 쓰고, 안 받는 컴포넌트만 `title: string` prop 추가)
- Modify: `ui/src/i18n/ko.ts` (`ko.print.speed`에 고정 머리 `colStep: "단계"`·`colBar: "응답 속도 비율"`·`colFail: "실패"`)
- Test: `ui/src/print/__tests__/speedBandTable.test.tsx`(신규), `ui/src/print/__tests__/buildPrintDoc.test.ts`, `ui/src/print/__tests__/PrintDocument.test.tsx`

**Interfaces:**
- Consumes: Task 4의 `SpeedModel`·`PrintDoc.speed`·`PrintDoc.sectionNo`.
- Produces:
  ```ts
  // buildPrintDoc.ts MEASURE_IDS에 추가
  speedTitle: "speed:title", speedHeader: "speed:header",
  speedRowId: (key: string): string => `speed:row:${key}`,
  // 블록: { kind: "table", id: "speed", titleMm, headerMm, rowsMm: doc.speed.rows.map(...) } + atom "speed:notes"
  // SpeedBandTable.tsx
  export function SpeedTableTitle(p: { continued: boolean; measure?: boolean }): JSX.Element;
  export function SpeedBandTable(p: { model: SpeedModel; from: number; to: number; measure?: boolean }): JSX.Element;
  export function SpeedNotes(p: { model: SpeedModel }): JSX.Element;   // 범례 + 안내 줄 + 단계 줄 + 각주
  ```
- `standardBlocks` 순서: … `notes:unreadable` 다음, `chart` 앞에 `doc.speed !== null`일 때만 `speed` 표 블록과 `speed:notes` atom. `summaryBlocks`는 손대지 않는다.
- `PrintDocument.tsx`: `MeasureSheet`와 `PageView` **두 곳 모두** `b.id === "speed" && doc.speed` 가지를 `stair` 가지 옆에 넣는다(안 넣으면 모르는 표 id가 2절 표로 그려진다). `AtomicContent`에 `case "speed:notes"`.
- 제목: 세 컴포넌트가 `doc.sectionNo.chart`·`.conditions`·`.glossary`를 그린다.
- 안내 상자: run 줄과 단계 줄을 한 상자에 줄바꿈으로 담는다(시안 경우 2·7). 상자의 붉은 왼쪽 테두리는 `model.ruleBoxFail`로만. `Seg`의 `strong` → `<b>`, `bad` → 붉은 굵은 글씨.

모양(시안 v2가 기준 — 값을 그대로 옮긴다):
- 열 폭: 단계 36mm · 막대 62mm · 실패 22mm, 나머지 구간 칸은 남는 폭 균등. 숫자 칸 오른쪽 정렬, 머리 가운데 정렬, 머리 작은 글씨 7.3pt 회색 블록.
- 막대: 높이 4.4mm, 테두리 `1px solid var(--sub)`, 조각 색 band `fast` → `--b1:#d6e2f5`, `within` → `--b2:#7f9fd6`, `over` → `--b3:#27407f` + `repeating-linear-gradient(45deg, rgba(255,255,255,.55) 0 1px, transparent 1px 4px)`.
- 범례 견본 6mm×2.8mm. 안내 줄: 8.3pt, `border:1px solid var(--line)`, 왼쪽 3px `var(--ink)`(미달이면 `var(--bad)`), 안쪽 여백 1.6mm 2.5mm. 각주 7.6pt 회색.
- total 행 위 테두리 `1.5px solid var(--ink)`·굵게. `rowBad` 행은 단계 칸과 실패 칸만 `var(--badbg)`.
- 머리 칸은 `word-break: keep-all`(기존 좁은 머리 칸 규칙과 같은 처리), 이름 칸은 2절 표의 이름 칸 규칙을 그대로 쓴다(긴 이름 줄바꿈/clamp).
- 막대 조각 색이 인쇄에서 빠지지 않게 기존 `print-color-adjust` 규칙 범위(`print.css` 끝의 전역 규칙)에 들어가는지 확인만 한다(이미 전역이면 추가 없음).

- [ ] **Step 1: 실패하는 테스트 작성**

`speedBandTable.test.tsx`:
```tsx
it("세 구간 표: 머리·행·total을 그린다", () => {
  // Task 4 경우 1 모델로 render → columnheader 6개, 본문 행 = rows.length
  // ⑤ 행: 실패 칸 textContent "✕ 26.6%", 행에 p-speed-row--bad 클래스
  // 막대 조각 수·style.width("22%" 등)
});
it("합친 칸은 colSpan 2", () => { /* 경우 7 ① 행의 within td.colSpan === 2 */ });
it("두 구간 표는 구간 열이 둘", () => { /* columnheader 5개 */ });
it("막대 없는 행은 —", () => {});
it("from/to로 잘라 그리고 머리줄은 항상 있다", () => { /* from=2,to=4 → 본문 행 2, thead 있음 */ });
it("안내 줄 미달이면 fail 클래스, 각주 순서", () => {});
it("measure면 data-measure id가 행마다 붙는다", () => { /* speed:row:<key> */ });
```
`buildPrintDoc.test.ts`: `standardBlocks`에서 `speed` 표 블록이 `notes`류 뒤·`chart` 앞에 있고 `rowsMm.length === doc.speed.rows.length`; `doc.speed === null`이면 블록 없음; `summaryBlocks` 어느 단계에도 `speed` 없음.
`PrintDocument.test.tsx`: speed 있는 doc 표준판 렌더 → 리터럴 「3. 단계별 응답 속도 구간」 제목 1개와 「4. 시간에 따른 변화」·「6. 용어 풀이」가 보이고, 「2. 단계별 결과」가 한 번만 보인다(새 표가 2절 표로 그려지지 않았다는 가드). 요약판 테스트의 기존 부재 단언(「3. 시간에 따른 변화」·「5. 용어 풀이」) 옆에 「3. 단계별 응답 속도 구간」·「4. 시간에 따른 변화」·「6. 용어 풀이」 부재도 더한다.

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — `StairPrintTable.tsx`의 제목/측정 id 패턴을 따른다.
- [ ] **Step 4: 통과 확인** — `pnpm lint && pnpm test && pnpm build`.
- [ ] **Step 5: 되돌려 확인** — `PageView`의 `speed` 가지를 지워 `PrintDocument.test`의 "2절 제목 한 번만" 가드가 RED인지 보고 원복.
- [ ] **Step 6: 커밋** — `feat(ui/print): 표준판 「단계별 응답 속도 구간」 절`.
- [ ] **Step 7 (orchestrator — 구현자 아님): 시안 대조** — 워크트리 자체 바이너리로 컨트롤러를 띄우고(`cargo build -p handicap-worker` 후 `./target/debug/controller --db /tmp/print-speed-bands.db --ui-dir ui/dist --rest 127.0.0.1:8099 --grpc 127.0.0.1:8098`, 포트는 `lsof`로 빈 것 확인) 단계별 지연이 다른 응답기로 기준 걸린 run 하나를 만들어 `/runs/:id/print` 표준판과 시안 v2를 나란히 스크린샷으로 본다. 색·빗금·굵기·칸 폭·안내 줄 모양이 다르면 이 task로 되돌려 고친다. 결과를 최종 리뷰 전에 사용자에게 보고하지 않아도 되지만, 차이를 고친 커밋은 남긴다.

---

## 끝난 뒤 (task 아님 — orchestrator)

1. **최종 리뷰** `handicap-reviewer`(와이어 1:1 — Rust `SpeedBandRow` ↔ Zod, `fast: null`; spec 연기 항목 추적). BASE = Task 1 직전 커밋.
2. **보안 표면**: `finish-slice` §0 grep을 직접 돌린다. 이 변경은 값(응답 시간 건수·기준값)을 새 필드로 옮길 뿐 비밀값·요청 실행·템플릿 경로를 건드리지 않는다는 예상이지만, grep과 "새 sink로 옮긴 값이 있는가" 판단이 지배한다.
3. **라이브 검증** `/live-verify` — spec §9 표(US1–US4)·극단값·PDF 쪽 수·글꼴 폭(`letter-spacing: 0.12em`)·요약판 1장 유지·응답 파싱. 요약판도 연다(목표 줄이 길어졌다).
4. **마무리** `/finish-slice` — roadmap §B 새 블록(번호는 `grep -n '^### B' docs/roadmap.md`로 확정)에 spec의 연기·판단을 비용·해소법과 함께: 요약판/화면 리포트/CSV·XLSX 미적용, 화면 리포트 쌍 표기, `0.7%` 저장 오차 판정, 2절·3절 ▲ 차이, 소수 단계 기준 문장 외관, §B43 (1) 첫 항목 해소 표시.

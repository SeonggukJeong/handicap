# open-loop 단위 표면화 (슬라이스 ②) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** open-loop 부하 단위(도착률 = 초당 시나리오 반복, ADR-0046)를 UI 표면에 드러낸다 — 목표 입력 라벨 개명("도착률(초당 반복)"), "≈ 초당 요청 N건" 라이브 환산(분기 시 범위), 리포트 목표/달성 도착률 카드, ko "RPS" 잔존 키 스윕, `peakThroughput` stale docstring 교정.

**Architecture:** UI-only 카피·표시 슬라이스. 신규 순수 함수 2개(`iterationRequestRange` — 반복당 요청 수 범위 walk, `openLoopRates` — 리포트 목표/달성 도착률 도출)와 ko.ts 키 개명이 전부다. **와이어/payload 0-diff**: `loadModel.ts`(buildProfile)·`schemas.ts`(Zod — `achieved_per_sec`/`target_per_sec`는 슬라이스 ①이 이미 추가)·`crates/**` 무변경.

**Tech Stack:** React + TS, vitest + RTL, ko.ts 메시지 카탈로그(ADR-0035).

**Spec:** `docs/superpowers/specs/2026-07-12-open-loop-slot-sizing-design.md` §7 "슬라이스 ②(단위 표면화)" + roadmap §B20. 상위 spec이 이 슬라이스를 정의하므로 별도 spec 없음.

## Global Constraints

- **모든 사용자 노출 문구는 `ui/src/i18n/ko.ts` 경유** (ADR-0035). 변수 뒤 조사는 병기형 `(으)로` 등.
- **용어 canon (ADR-0046)**: open-loop 목표 단위 = **도착률(초당 반복)**. 관측 처리량 = **요청/초(RPS)** — 이 의미의 키는 유지(아래 keep-list). 슬라이스 ①이 확립한 표현("반복 1회", "초당 N회 반복 시작")과 일관되게.
- **payload/와이어 0-diff**: `ui/src/components/loadModel.ts`·`ui/src/api/schemas.ts`·`ui/src/api/client.ts`·`crates/**` 파일은 이 슬라이스에서 **편집 금지**.
- **tdd-guard**: 각 task의 **첫 편집은 반드시 테스트 파일**(`__tests__/`) — src 먼저 건드리면 차단된다(ui/CLAUDE.md).
- **단일 파일 테스트는 `pnpm test <이름>` (`--` 없이)** — `pnpm test -- <이름>`은 전체 스위트를 돈다.
- 각 task 끝: `cd ui && pnpm lint && pnpm test && pnpm build` 후 독립 green 커밋. 커밋은 `run_in_background: false` 단일 호출.
- `sizingScenario` 게이트 패턴: RunDialog만 전달·ScheduleForm 미전달 → 환산 힌트는 scenario 부재 시 미렌더(ScheduleForm DOM은 ko 문구 외 불변).

---

## 카피 개명 표 (T2·T4의 정본 — 이 표의 문자열을 그대로 쓴다)

`ui/src/i18n/ko.ts` (라인 번호는 현 HEAD 기준 근사 — 키 이름으로 찾을 것):

| # | 키 | 현재 | 새 값 |
|---|---|---|---|
| 1 | `glossary.openLoop` | "요청 속도 기준(open-loop) — 응답 속도와 무관하게 목표 RPS로 요청을 발사하는 방식입니다. 처리량 한계 측정에 적합합니다." | "도착률 기준(open-loop) — 응답 속도와 무관하게 매초 정해진 횟수만큼 시나리오 반복을 시작하는 방식입니다. 처리량 한계 측정에 적합합니다." |
| 2 | `glossary.workerCount` | "…더 높은 목표 RPS를 냅니다.…" | "…더 높은 도착률을 냅니다.…" (나머지 문장 유지) |
| 3 | `glossary.arrivalRate` **신규** | — | "도착률(초당 반복) — 매초 시작하는 시나리오 반복 횟수입니다. 반복 1회 = 시나리오 전체(모든 스텝) 실행이라, 초당 요청 수는 도착률 × 반복당 요청 수가 됩니다." |
| 4 | `runDialog.summaryOpen` | 세그먼트 "목표 **{rps}** RPS · 약 **{total}**건 · **{time}**" | 세그먼트 "도착률 초당 **{rate}**회 · 반복 약 **{total}**회 · **{time}**" — `[{ text: "도착률 초당 " }, { text: String(rate), bold: true }, { text: "회 · 반복 약 " }, { text: total, bold: true }, { text: "회 · " }, { text: time, bold: true }]` (첫 파라미터명 `rps`→`rate`) |
| 5 | `runDialog.summaryCurveRps` | "최대 **{peak}** RPS (곡선)" | `[{ text: "최대 초당 " }, { text: String(peak), bold: true }, { text: "회 반복 (곡선)" }]` |
| 6 | `runDialog.summaryWarnOpenSub` | "목표 RPS·시간을 입력" | "목표 도착률·시간을 입력" |
| 7 | `runDialog.measureHelp` | "…VU나 RPS를 올려도…" | "…VU나 도착률을 올려도…" (나머지 유지) |
| 8 | `loadModel.openLoop` | "요청 속도 기준 (open-loop)" | "도착률 기준 (open-loop)" |
| 9 | `loadModel.targetRps` | "목표 RPS" | "도착률(초당 반복)" (spec §7 인용 라벨) |
| 10 | `loadModel.curveTargetRps` | "목표 RPS" | "목표 도착률" |
| 11 | `loadModel.curveHintRps` | "각 단계가 끝날 때의 목표 초당 요청 수 (이전 값에서 선형 변화)" | "각 단계가 끝날 때의 목표 도착률(초당 반복) (이전 값에서 선형 변화)" |
| 12 | `loadModel.curvePreviewAriaRps` | "레이트 곡선 미리보기 (x: 누적 초, y: RPS)" | "레이트 곡선 미리보기 (x: 누적 초, y: 도착률)" |
| 13 | `loadModel.tileOpenTitle` | "목표 RPS" | "도착률 (초당 반복)" |
| 14 | `loadModel.tileOpenDesc` | "초당 N건씩 도착" | "초당 N회씩 반복 시작" |
| 15 | `validation.targetRps` | "목표 RPS는 1 ~ 1,000,000 사이여야 합니다." | "도착률(초당 반복)은 1 ~ 1,000,000 사이여야 합니다." |
| 16 | `capacityGuard.clampNoteOpen` | "…목표 RPS는 유지되어…" | "…목표 도착률은 유지되어…" |
| 17 | `report.vusOpenHint` | "VU 해당 없음 — 열린 루프(RPS·슬롯 기반)" | "VU 해당 없음 — 열린 루프(도착률·슬롯 기반)" |
| 18 | `report.headlineOpenFixed` | "…목표 ${p.targetRps} RPS로 ${p.count}회 요청…" | "…목표 도착률 초당 ${p.targetRps}회로 ${p.count}회 요청…" |
| 19 | `report.headlineOpenCurve` | "…단계별 RPS 곡선으로…" | "…단계별 도착률 곡선으로…" |
| 20 | `report.cardTargetRps` | "목표 RPS" | "목표 도착률" (키 id는 유지 — 소비처 churn 최소화) |
| 21 | `report.cardTargetRatePeak` **신규** | — | "목표 도착률(피크)" |
| 22 | `report.cardAchievedRate` **신규** | — | "달성 도착률" |
| 23 | `report.cardAchievedRateHelp` **신규** | — | "실제로 시작된 초당 반복 수입니다. 드롭(유실)이 있으면 목표보다 낮아집니다. 곡선 run은 포화 인사이트가 있을 때만 계산됩니다." |
| 24 | `slotSizing.help` | "목표 RPS를 내려면…" | "목표 도착률을 내려면…" (나머지 유지) |
| 25 | `slotSizing.needTarget` | "위에서 목표 RPS를 먼저 입력하세요." | "위에서 목표 도착률을 먼저 입력하세요." |
| 26 | `slotSizing.overCapacity` | "…목표 RPS를 낮추거나 워커를 늘려야 합니다." | "…목표 도착률을 낮추거나 워커를 늘려야 합니다." |
| 27 | `workerSizing.help` | "워커 한 대가 낼 수 있는 최대 RPS는…" | "워커 한 대가 낼 수 있는 최대 도착률은…" |
| 28 | `openLoopCheck.inertSlots` | "…부하 세기는 max_in_flight가 아니라 목표 RPS로 정해져요." | "…부하 세기는 max_in_flight가 아니라 목표 도착률로 정해져요." |
| 29 | `settingsHelp`류 `max_open_loop_worker_count` 인접 도움말(ko.ts ~1240행, "매우 높은 목표 RPS" 2회) | "⬆ 올리면 매우 높은 목표 RPS를…", "⬇ …아주 높은 목표 RPS를…" | "매우 높은 도착률 목표를" / "아주 높은 도착률 목표를" (각 1회) |
| 30 | `loadModel.reqPerSecApprox` **신규** | — | `(n: string) => \`≈ 초당 요청 ${n}건\`` |
| 31 | `loadModel.reqPerSecApproxRange` **신규** | — | `(lo: string, hi: string) => \`≈ 초당 요청 ${lo}~${hi}건\`` |
| 32 | `loadModel.reqPerSecPeakApprox` **신규** | — | `(n: string) => \`최고 단계 기준 ≈ 초당 요청 ${n}건\`` |
| 33 | `loadModel.reqPerSecPeakApproxRange` **신규** | — | `(lo: string, hi: string) => \`최고 단계 기준 ≈ 초당 요청 ${lo}~${hi}건\`` |

주: spec §7의 표기 예 "≈ 요청 N/s"는 카탈로그 관례("초당 요청 수 (RPS)")에 맞춰 "≈ 초당 요청 N건"으로 한다(같은 의미·한국어 일관).

## Keep-list (요청/초 의미 — 변경 금지, T5 스윕 게이트의 허용 목록)

| 위치 | 이유 |
|---|---|
| `glossary.rps` | 관측 지표 RPS 정의 — 리포트 평균 RPS 카드 HelpTip 소비 |
| `report.timeSeriesRequests` "초당 요청 수 (RPS)" | 요청/초 시계열 제목 |
| `report.cardAvgRps` · `runDetail.cardAvgRps` "평균 RPS" | `summary.rps`(요청/초) |
| `sizing.*` (closed-loop VU 헬퍼: `help`·`targetRps`·`fromPriorRun` 등) | closed-loop 처리량 목표는 요청/초가 맞음(`recommendVus`가 `summary.rps` 앵커) |
| `verdictFormat.ts` `rps`/`min_window_rps` + `CriteriaFields.tsx` "최소 RPS"/"최소 윈도 RPS"/"RPS 워밍업(초)" | SLO 기준은 요청/초 지표 |
| `InsightPanel.tsx` "(= 이 구성의 지속 가능한 최대 RPS)" | `Insight.value` = 관측 요청/초 peak(슬라이스 ① 의미 보존 결정) |
| `DataBindingPanel.tsx:707` "부하(RPS)는 그 시점부터 감소" | unique 정책 stop-VU 경고 — 요청/초 감소 서술 |
| `ReportView.tsx` `yLabel="req/s"` | 요청/초 축 라벨 |
| `sizing.ts:7` "closed-loop에서 목표 RPS…" doc 주석 | closed-loop 요청/초 문맥 |
| `sizing.ts:30` `recommendVus` doc "목표 RPS + 처리량 출처 → 권장 VU" | closed-loop VU 헬퍼(요청/초) — T1은 :20·:123만 개명 |
| ko.ts 파일 헤더 주석의 "VU/RPS/p95" | 고유명사 병기 규칙 서술 |

---

### Task 1: `iterationRequestRange` 순수 함수 + sizing.ts stale doc 교정

**Files:**
- Modify: `ui/src/components/sizing.ts`
- Test: `ui/src/components/__tests__/sizing.test.ts`

**Interfaces:**
- Produces: `export type RequestRange = { min: number; max: number }`, `export function iterationRequestRange(steps: ReadonlyArray<Step>): RequestRange` — Task 3이 소비.

- [ ] **Step 1: 실패 테스트 작성** — `sizing.test.ts`에 describe 추가. 같은 파일 `iterationHoldMs (R7)` describe의 이디엄을 그대로 쓴다: 기존 `http(id, think?)` 헬퍼 재사용 + 컨테이너 스텝은 인라인 리터럴 `as unknown as Step`(기존 loop/if/parallel fixture와 동일).

```ts
import { iterationRequestRange } from "../sizing"; // 기존 import 줄에 추가

describe("iterationRequestRange (ADR-0046 ②)", () => {
  it("flat http 2개 → {2,2}", () => {
    expect(iterationRequestRange([http("a"), http("b")])).toEqual({ min: 2, max: 2 });
  });
  it("loop repeat 3 × (http 2개) → {6,6}", () => {
    const steps = [
      { type: "loop", id: "L", name: "L", repeat: 3, do: [http("a"), http("b")] } as unknown as Step,
    ];
    expect(iterationRequestRange(steps)).toEqual({ min: 6, max: 6 });
  });
  it("if(then 2건·elif 1건·else 빈 배열) → {0,2} — else 무요청이 min", () => {
    const ifStep = {
      type: "if", id: "I", name: "I", cond: {},
      then: [http("a"), http("b")],
      elif: [{ cond: {}, then: [http("c")] }],
      else: [],
    } as unknown as Step;
    expect(iterationRequestRange([ifStep])).toEqual({ min: 0, max: 2 });
  });
  it("parallel은 분기 '합'(전 분기 동시 실행 — 시간 walk의 max와 다름) — 2분기(2건·3건) → {5,5}", () => {
    const par = {
      type: "parallel", id: "P", name: "P",
      branches: [
        { name: "x", steps: [http("a"), http("b")] },
        { name: "y", steps: [http("c"), http("d"), http("e")] },
      ],
    } as unknown as Step;
    expect(iterationRequestRange([par])).toEqual({ min: 5, max: 5 });
  });
  it("http leaf 0개 → {0,0} (호출부 skip 신호)", () => {
    expect(iterationRequestRange([])).toEqual({ min: 0, max: 0 });
  });
  it("혼합: http 1 + if(then 1건/else 빈) → {1,2}", () => {
    const ifStep = {
      type: "if", id: "I2", name: "I2", cond: {}, then: [http("b")], elif: [], else: [],
    } as unknown as Step;
    expect(iterationRequestRange([http("a"), ifStep])).toEqual({ min: 1, max: 2 });
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd ui && pnpm test sizing` → Expected: FAIL (`iterationRequestRange` export 없음)

- [ ] **Step 3: 구현** — `sizing.ts`의 `iterationHoldMs` 아래에 추가:

```ts
export type RequestRange = { min: number; max: number };

/** 반복 1회가 발사하는 HTTP 요청 수 범위 — iterationHoldMs(위)와 동형 재귀지만 집계 축이 다르다:
 *  시간은 parallel=분기 max(동시 실행)지만 **요청 수는 parallel=분기 합**(전 분기 모두 실행).
 *  if는 정확히 한 분기만 실행 → [분기별 min의 최소, 분기별 max의 최대](else 부재=빈 배열=0건).
 *  loop = repeat ×. http leaf 0개면 {min:0,max:0} → 호출부 skip(환산 힌트 미표시).
 *  ADR-0046 슬라이스 ② — "≈ 초당 요청 N건" 환산의 반복당 요청 수. */
export function iterationRequestRange(steps: ReadonlyArray<Step>): RequestRange {
  let min = 0;
  let max = 0;
  for (const s of steps) {
    if (s.type === "http") {
      min += 1;
      max += 1;
    } else if (s.type === "loop") {
      const r = iterationRequestRange(s.do);
      min += s.repeat * r.min;
      max += s.repeat * r.max;
    } else if (s.type === "parallel") {
      for (const b of s.branches) {
        const r = iterationRequestRange(b.steps);
        min += r.min;
        max += r.max;
      }
    } else {
      // if — 단일 분기 실행: then / elif[].then / else 전체에서 min/max
      const branches = [s.then, ...s.elif.map((e) => e.then), s.else];
      let bmin = Infinity;
      let bmax = 0;
      for (const b of branches) {
        const r = iterationRequestRange(b);
        bmin = Math.min(bmin, r.min);
        bmax = Math.max(bmax, r.max);
      }
      min += bmin;
      max += bmax;
    }
  }
  return { min, max };
}
```

- [ ] **Step 4: stale doc 교정 (같은 파일, 주석만)** —
  - `peakThroughput`(현 204-207행) docstring을 다음으로 교체(구 워커-앵커 가드 서술 제거):

```ts
/** report.windows(초별 (ts,step) count 행 — A3b 워커 머지 후)에서 초별 throughput(요청/초) 천장.
 *  초별 Σcount의 최대. ADR-0046(R10)으로 워커 앵커가 달성 도착률 기반이 되며 소비처가 없어졌지만
 *  표시용 관측 peak 후보로 유지(슬라이스 ① 결정 — 삭제 아님).
 *  insights.rs load_gen_saturated arm의 by_sec와 동형(라인 고정 참조는 두지 않는다 — drift). */
```

  - `targetRpsValid`(현 20행) 주석: "목표 RPS 유효 범위" → "목표 도착률(초당 반복) 유효 범위" (뒷부분 유지).
  - `recommendSlots`(현 123행) 주석 첫 구: "목표 RPS + 반복 1회 점유시간" → "목표 도착률 + 반복 1회 점유시간".
  - 7행 closed-loop 주석("closed-loop에서 목표 RPS…")은 **keep-list — 건드리지 않는다**.

- [ ] **Step 5: 통과 확인** — Run: `pnpm test sizing` → Expected: PASS (기존 케이스 포함 전부)

- [ ] **Step 6: 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
git add ui/src/components/sizing.ts ui/src/components/__tests__/sizing.test.ts
git commit -m "feat(ui): iterationRequestRange 반복당 요청 수 범위 walk + sizing.ts stale doc 교정 (ADR-0046 ②)"
```

---

### Task 2: create-time 카피 개명 — ko.ts 개명 + 소비 테스트 일괄 갱신

**Files:**
- Modify: `ui/src/i18n/ko.ts` (위 표 #1~2, #3(신규 — 아래 주의), #4~16, #24~29. 나머지는 T3(#30~33 신규)·T4(#17~19 개명, #20 값 교체, #21~23 신규)에서)
- Modify: `ui/src/components/LoadModelFields.tsx:719` (HelpTip 교체 — 아래 Step 4)
- Modify: `ui/src/components/SlotSizingHelper.tsx:60`, `ui/src/components/WorkerSizingHelper.tsx:44` (주석 "목표 RPS"→"목표 도착률" — 주석만)
- Test: `ui/src/components/__tests__/LoadModelFields.test.tsx`, `__tests__/RunDialog.test.tsx`, `__tests__/runSummary.test.ts`, `__tests__/SlotSizingHelper.test.tsx`

주의: #3(`glossary.arrivalRate`)은 Step 4의 HelpTip이 소비하므로 **이 task에서 함께 추가**한다(표의 T3/T4 배정 중 예외).

- [ ] **Step 1: 테스트 갱신 먼저 (RED)** — 기계적 치환. 대상 4파일에서:
  - `getByRole("radio", { name: /목표 RPS/ })` 류 → `{ name: /도착률/ }` (RunDialog.test ~34곳 — `:2992` 부근 aria-label "레이트 곡선 미리보기 (x: 누적 초, y: RPS)" 단언(표 #12)도 포함, LoadModelFields.test — 타일 라디오 accname은 `tileOpenTitle` "도착률 (초당 반복)"이 됨)
  - `getByRole("spinbutton", { name: /목표 RPS/i })` → `{ name: /도착률/ }` (입력 라벨 "도착률(초당 반복)" — role이 라디오/스핀버튼을 구분하므로 동일 정규식 안전)
  - `getByLabelText(/목표 RPS/i)` → `/도착률/` · `getAllByText("목표 RPS")` → `getAllByText("목표 도착률")` (curve 스테이지 라벨 = #10)
  - `{ name: /요청 속도 기준/ }` → `/도착률 기준/` (LoadModelFields.test:452)
  - `runSummary.test.ts:31` `"목표 100 RPS · 약 30,000건 · 5분"` → `"도착률 초당 100회 · 반복 약 30,000회 · 5분"`
  - SlotSizingHelper.test `/목표 RPS를 먼저 입력/` 2곳 → `/목표 도착률을 먼저 입력/`
  - `validation.targetRps` 문구 단언(RunDialog.test:1140 `/목표 RPS는 1 ~ 1,000,000/`) → `/도착률\(초당 반복\)은 1 ~ 1,000,000/`
  - **정확매치 케이스**(정규식 아닌 exact string): LoadModelFields.test:447 `getByRole("radio", { name: "목표 RPS" })` → `{ name: "도착률 (초당 반복)" }`(타일 제목 #13); :177-179 테스트 제목 "open+curve: 기존 목표 RPS 라벨 유지…" → "…목표 도착률 라벨 유지…" + `getAllByText("목표 RPS")` → `getAllByText("목표 도착률")`(스테이지 라벨 #10)
  - 치환 후 각 대상 파일을 `grep -n "RPS\|요청 속도" <파일>`로 재훑어(runSummary.test의 `summaryCurveRps` 곡선 단언 등 위 목록 밖 잔존 포함) 카피 개명 표 기준으로 전부 갱신. 남는 것은 keep-list 문맥(VuSizingHelper.test의 closed 헬퍼 "목표 RPS" 등)뿐이어야 한다. **VuSizingHelper.test는 갱신하지 않는다**(closed-loop keep).

- [ ] **Step 2: RED 확인** — Run: `pnpm test RunDialog` → Expected: FAIL (구 카피 렌더 vs 새 단언)

- [ ] **Step 3: ko.ts 개명** — 카피 개명 표 #1~2, #3, #4~16, #24~29를 정확히 반영. #4는 파라미터명도 `rps`→`rate`.

- [ ] **Step 4: LoadModelFields HelpTip 교체** — 719행:

```tsx
// 변경 전
help={<HelpTip label="RPS 설명">{ko.glossary.rps}</HelpTip>}
// 변경 후
help={<HelpTip label="도착률 설명">{ko.glossary.arrivalRate}</HelpTip>}
```

(open+fixed arm의 목표 입력 전용 — `Summary.tsx`의 `glossary.rps` 소비는 평균 RPS 카드라 유지.)

- [ ] **Step 5: 주석 2곳** — SlotSizingHelper.tsx:60·WorkerSizingHelper.tsx:44. **각 줄에 "목표 RPS"가 2회 있다** — 둘 다 개명: `/** 유효 목표 RPS 문자열…` → `유효 목표 도착률 문자열…`, 같은 줄 꼬리 `fixed=폼 목표 RPS, curve=stages 피크` → `fixed=폼 목표 도착률, curve=stages 피크` (주석만, 로직 0-diff).

- [ ] **Step 6: GREEN 확인** — Run: `pnpm test LoadModelFields && pnpm test RunDialog && pnpm test runSummary && pnpm test SlotSizingHelper && pnpm test ScheduleForm` → Expected: PASS

- [ ] **Step 7: 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
git add ui/src/i18n/ko.ts ui/src/components/LoadModelFields.tsx ui/src/components/SlotSizingHelper.tsx ui/src/components/WorkerSizingHelper.tsx ui/src/components/__tests__/
git commit -m "feat(ui): open-loop 목표 라벨 '도착률(초당 반복)' 개명 — create-time 카피 스윕 (ADR-0046 ②)"
```

---

### Task 3: "≈ 초당 요청 N건" 라이브 환산 힌트 (LoadModelFields)

**Files:**
- Modify: `ui/src/i18n/ko.ts` (표 #30~33 신규 키 — `loadModel` 블록)
- Modify: `ui/src/components/LoadModelFields.tsx`
- Test: `ui/src/components/__tests__/LoadModelFields.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `iterationRequestRange`, 기존 `targetRpsValid`·`peakStageTarget`(sizing.ts).

- [ ] **Step 1: 실패 테스트 작성** — LoadModelFields.test.tsx에 describe 추가. 기존 렌더 헬퍼(`renderFields` 류)를 재사용하고, `twoStepScenario`/`branchScenario`/`oneStepScenario`는 **신규 fixture로 작성**(openLoopWarnings 테스트의 scenario fixture 모양을 따름 — http leaf 필수 필드 동일). 간단 모드 가시성 핀 케이스도 아래 describe **안에** 함께 넣는다:

```tsx
  it("simpleMode에서도 fixed 환산 힌트 렌더(의도 — 입력 아래 보조 문구)", () => {
    renderFields({ loadModel: "open", rateMode: "fixed", targetRps: "20", sizingScenario: twoStepScenario, simpleMode: true });
    expect(screen.getByText("≈ 초당 요청 40건")).toBeInTheDocument();
  });
```

```tsx
describe("도착률→요청 환산 힌트", () => {
  it("open+fixed + scenario(http 2개) + 목표 20 → '≈ 초당 요청 40건'", () => {
    renderFields({ loadModel: "open", rateMode: "fixed", targetRps: "20", sizingScenario: twoStepScenario });
    expect(screen.getByText("≈ 초당 요청 40건")).toBeInTheDocument();
  });
  it("분기 시나리오(http1 + if(then 1/else 빈)) + 목표 10 → 범위 '≈ 초당 요청 10~20건'", () => {
    renderFields({ loadModel: "open", rateMode: "fixed", targetRps: "10", sizingScenario: branchScenario });
    expect(screen.getByText("≈ 초당 요청 10~20건")).toBeInTheDocument();
  });
  it("scenario 미전달(ScheduleForm 경로) → 힌트 미렌더", () => {
    renderFields({ loadModel: "open", rateMode: "fixed", targetRps: "20" });
    expect(screen.queryByText(/≈ 초당 요청/)).not.toBeInTheDocument();
  });
  it("목표 무효(빈 문자열) → 미렌더", () => {
    renderFields({ loadModel: "open", rateMode: "fixed", targetRps: "", sizingScenario: twoStepScenario });
    expect(screen.queryByText(/≈ 초당 요청/)).not.toBeInTheDocument();
  });
  it("open+curve + scenario(http 1개) + peak 50 → '최고 단계 기준 ≈ 초당 요청 50건'", () => {
    renderFields({
      loadModel: "open", rateMode: "curve", sizingScenario: oneStepScenario,
      stages: [{ target: "50", duration_seconds: "30" }, { target: "10", duration_seconds: "30" }],
    });
    expect(screen.getByText("최고 단계 기준 ≈ 초당 요청 50건")).toBeInTheDocument();
  });
  it("closed 모드 → 미렌더 (VU 곡선에 환산 없음)", () => {
    renderFields({ loadModel: "closed", rateMode: "fixed", sizingScenario: twoStepScenario });
    expect(screen.queryByText(/≈ 초당 요청/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: RED 확인** — Run: `pnpm test LoadModelFields` → Expected: FAIL (힌트 미렌더)

- [ ] **Step 3: ko 키 추가** — 표 #30~33을 `loadModel` 블록에 추가.

- [ ] **Step 4: 구현** — LoadModelFields.tsx:
  - import에 `iterationRequestRange`, `targetRpsValid` 추가(`./sizing`).
  - 컴포넌트 본문(기존 `peakStr` useMemo 근처)에:

```tsx
// 환산 힌트: 도착률(반복/초) → 초당 요청 수 범위. scenario 없으면(ScheduleForm) 미렌더.
const reqRange = useMemo(
  () => (sizingScenario ? iterationRequestRange(sizingScenario.steps) : null),
  [sizingScenario],
);
const reqConversion = (rate: number | null, peak: boolean): string | null => {
  if (rate == null || !targetRpsValid(rate) || !reqRange || reqRange.max <= 0) return null;
  const lo = (rate * reqRange.min).toLocaleString();
  const hi = (rate * reqRange.max).toLocaleString();
  if (reqRange.min === reqRange.max)
    return peak ? ko.loadModel.reqPerSecPeakApprox(hi) : ko.loadModel.reqPerSecApprox(hi);
  return peak
    ? ko.loadModel.reqPerSecPeakApproxRange(lo, hi)
    : ko.loadModel.reqPerSecApproxRange(lo, hi);
};
```

  - **fixed arm**: `errs.targetRpsInvalid` 에러 `<p>` 블록 바로 뒤(SlotSizingHelper 앞)에. **의도적으로 `!simpleMode` 게이트를 걸지 않는다** — 간단 모드에서도 open+fixed 목표 입력이 렌더되므로 환산 힌트도 함께 보인다(입력 바로 아래 보조 문구라 간단 모드의 정보 밀도 원칙과 충돌하지 않음). curve arm 힌트만 `!simpleMode`(곡선 에디터와 동행):

```tsx
{(() => {
  const hint = reqConversion(Number(targetRps), false);
  return hint ? (
    <p className="mb-3 -mt-2 text-xs text-slate-500">{hint}</p>
  ) : null;
})()}
```

  - **curve arm**(open만 — `curveEditor`는 closed+curve와 공유되므로 curveEditor 내부가 아니라 open 분기의 `{!simpleMode && curveEditor}` 바로 뒤에):

```tsx
{!simpleMode &&
  (() => {
    const hint = reqConversion(peakStageTarget(stages), true);
    return hint ? <p className="mb-3 text-xs text-slate-500">{hint}</p> : null;
  })()}
```

- [ ] **Step 5: GREEN 확인** — Run: `pnpm test LoadModelFields && pnpm test RunDialog && pnpm test ScheduleForm` → Expected: PASS (ScheduleForm은 scenario 미전달이라 불변)

- [ ] **Step 6: 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
git add ui/src/i18n/ko.ts ui/src/components/LoadModelFields.tsx ui/src/components/__tests__/LoadModelFields.test.tsx
git commit -m "feat(ui): open-loop 도착률→'≈ 초당 요청 N건' 라이브 환산 힌트 — 분기 시 범위 (ADR-0046 ②)"
```

---

### Task 4: 리포트 목표/달성 도착률 표기 — openLoopRates + Summary 카드 + 헤드라인

> **범위 주(spec §7 "시리즈·카드" 중 카드만)**: 목표/달성 도착률 *시계열(시리즈)*은 구현하지 않는다 — 달성 도착률의 초별 데이터(per-second arrival/dropped)는 와이어에 없고(§7 "per-second dropped 시리즈" 연기의 전제), 목표 시리즈만 단독으로 요청/초 차트에 겹치면 단위 혼합이라 오독을 만든다. 카드(목표/달성) + 헤드라인 표기가 이 슬라이스의 "리포트 도착률 표기"이고, 시리즈는 per-second dropped 시리즈와 함께 §B20에 잔존 연기한다.

**Files:**
- Create: `ui/src/components/report/openLoopRates.ts`
- Modify: `ui/src/i18n/ko.ts` (표 #17~23)
- Modify: `ui/src/components/report/Summary.tsx`
- Modify: `ui/src/components/report/ReportView.tsx:154-158`
- Test: `ui/src/components/report/__tests__/openLoopRates.test.ts` (신규), `__tests__/Summary.test.tsx`, `__tests__/ReportHeadline.test.tsx`

**Interfaces:**
- Produces: `export type OpenLoopRates = { target: number; curve: boolean; achieved: number | null }`, `export function openLoopRates(profile: unknown, dropped: number, durationSeconds: number, insights: Insight[]): OpenLoopRates | null`
- Consumes: `InsightSchema`의 `achieved_per_sec`(슬라이스 ①이 추가 — schemas.ts 0-diff).

- [ ] **Step 1: 실패 테스트 작성** — `report/__tests__/openLoopRates.test.ts` 신규(주의 — import 깊이는 `__tests__`에서 한 단계 더: `from "../openLoopRates"`, `from "../../../api/schemas"`):

```ts
import { describe, expect, it } from "vitest";
import { openLoopRates } from "../openLoopRates";
import type { Insight } from "../../../api/schemas";

const sat = (achieved: number): Insight[] => [
  { kind: "load_gen_saturated", severity: "warning", achieved_per_sec: achieved } as Insight,
];

describe("openLoopRates", () => {
  it("closed-loop(profile에 target_rps·stages 없음) → null", () => {
    expect(openLoopRates({ vus: 10 }, 0, 15, [])).toBeNull();
  });
  it("고정 rate·dropped 0 → 달성=목표", () => {
    expect(openLoopRates({ target_rps: 20 }, 0, 15, [])).toEqual({
      target: 20, curve: false, achieved: 20,
    });
  });
  it("고정 rate·dropped 260·15s → 달성 = 20 − 260/15 ≈ 2.667 (서버 R2 공식과 동형)", () => {
    const r = openLoopRates({ target_rps: 20 }, 260, 15, []);
    expect(r?.achieved).toBeCloseTo(20 - 260 / 15, 5);
  });
  it("인사이트 achieved_per_sec가 있으면 그 값 우선(고정 rate도)", () => {
    expect(openLoopRates({ target_rps: 20 }, 260, 15, sat(2.7))?.achieved).toBe(2.7);
  });
  it("곡선 → target=피크·curve=true·인사이트 없으면 달성 null(적분 복제 연기 §7)", () => {
    expect(
      openLoopRates({ stages: [{ target: 10 }, { target: 30 }, { target: 5 }] }, 100, 20, []),
    ).toEqual({ target: 30, curve: true, achieved: null });
  });
  it("곡선 + 인사이트 → 달성 = achieved_per_sec passthrough", () => {
    expect(openLoopRates({ stages: [{ target: 30 }] }, 100, 20, sat(7.5))?.achieved).toBe(7.5);
  });
  it("달성 음수는 0으로 클램프·duration 0 가드 → null", () => {
    expect(openLoopRates({ target_rps: 1 }, 1000, 15, [])?.achieved).toBe(0);
    expect(openLoopRates({ target_rps: 20 }, 10, 0, [])?.achieved).toBeNull();
  });
  it("profile null/unknown 형태 관대 처리 → null", () => {
    expect(openLoopRates(null, 0, 15, [])).toBeNull();
  });
});
```

- [ ] **Step 2: RED 확인** — Run: `pnpm test openLoopRates` → Expected: FAIL (모듈 없음)

- [ ] **Step 3: `openLoopRates.ts` 구현**:

```ts
import type { Insight } from "../../api/schemas";

export type OpenLoopRates = {
  /** 목표 도착률(반복/초) — 곡선이면 최고 단계(피크) */
  target: number;
  /** stages 기반(피크 표기)이면 true */
  curve: boolean;
  /** 달성 도착률 — 고정 rate는 클라 산출, 곡선은 인사이트 있을 때만. 산출 불가 null */
  achieved: number | null;
};

type LooseProfile = {
  target_rps?: number | null;
  stages?: { target: number }[] | null;
} | null;

/** run.profile(ReportRunSchema가 z.unknown())에서 open-loop 목표/달성 도착률 도출.
 *  target 도출은 controller report.rs의 target_eff(target_rps.or_else(stages peak))와 동일 수식
 *  (peakStageTarget과 같은 max — 단 여기 profile.stages는 서버 직렬화 숫자라 draft 파싱 불요).
 *  achieved 우선순위: ① load_gen_saturated 인사이트의 achieved_per_sec(서버 실측 — 곡선 포함)
 *  ② 고정 rate면 max(0, target − dropped/duration) — 서버 R2 achieved_arrival_rate와 동형
 *    (scheduled=target×duration이므로 (scheduled−dropped)/duration과 등가)
 *  ③ 곡선 + 인사이트 없음 → null(scheduled 적분의 UI 복제는 ADR-0046 §7 연기).
 *  closed-loop(둘 다 없음) → null → 소비처(Summary)가 카드 3종 통째 생략(기존 거동). */
export function openLoopRates(
  profile: unknown,
  dropped: number,
  durationSeconds: number,
  insights: Insight[],
): OpenLoopRates | null {
  const p = profile as LooseProfile;
  const stages = p?.stages ?? [];
  let target: number | null = null;
  let curve = false;
  if (p?.target_rps != null) {
    target = p.target_rps;
  } else if (stages.length > 0) {
    target = Math.max(...stages.map((s) => s.target));
    curve = true;
  }
  if (target == null) return null;
  const fromInsight = insights.find(
    (i) => i.kind === "load_gen_saturated" && i.achieved_per_sec != null,
  )?.achieved_per_sec;
  let achieved: number | null = fromInsight ?? null;
  if (achieved == null && !curve && durationSeconds > 0) {
    achieved = Math.max(0, target - dropped / durationSeconds);
  }
  return { target, curve, achieved };
}
```

- [ ] **Step 4: openLoopRates GREEN** — Run: `pnpm test openLoopRates` → Expected: PASS

- [ ] **Step 5: Summary/헤드라인 테스트 갱신 (RED)** —
  - `Summary.test.tsx`: prop `targetRps={…}` 사용처를 `openLoop={{ target: …, curve: false, achieved: … }}`로 교체. 기존 "목표 RPS" 라벨 단언 → "목표 도착률". **기존 `md:grid-cols-9` 단언(현 :54-60 부근) → `md:grid-cols-10`**. 신규 케이스: ① 달성 카드 `"2.7"` 표시(`achieved: 2.6667` → toFixed(1)), ② 곡선 라벨 `"목표 도착률(피크)"` + 달성 null → `"—"`, ③ `openLoop` 미전달(closed) → 카드 7개 유지(기존 케이스 rename).
  - `ReportHeadline.test.tsx`: `/목표 \d+ RPS로/` 류 단언 → `/목표 도착률 초당 \d+회로/`, `단계별 RPS 곡선` → `단계별 도착률 곡선`.

- [ ] **Step 6: ko 키(표 #17~23) + Summary.tsx + ReportView.tsx 구현** —
  - ko.ts: #17~19 개명, #20 값 교체, #21~23 신규(`report` 블록).
  - `Summary.tsx`:

```tsx
import type { OpenLoopRates } from "./openLoopRates";

type Props = {
  summary: ReportSummary;
  dropped?: number;
  openLoop?: OpenLoopRates | null;
};

export function Summary({ summary, dropped, openLoop }: Props) {
  // …cards 7종 기존 그대로…
  if (openLoop != null) {
    const droppedCount = dropped ?? 0;
    const total = droppedCount + summary.count;
    const dropRate = total === 0 ? 0 : droppedCount / total;
    const dropPct = floorPct(dropRate * 100);
    cards.push(
      {
        label: openLoop.curve ? ko.report.cardTargetRatePeak : ko.report.cardTargetRps,
        value: openLoop.target.toLocaleString(),
        help: ko.glossary.arrivalRate,
      },
      {
        label: ko.report.cardAchievedRate,
        value: openLoop.achieved != null ? openLoop.achieved.toFixed(1) : "—",
        help: ko.report.cardAchievedRateHelp,
      },
      {
        label: ko.report.cardDropped,
        value: `${droppedCount.toLocaleString()} (${dropPct})`,
        help: ko.glossary.maxInFlight,
      },
    );
  }
  const gridColsClass = openLoop != null ? "md:grid-cols-10" : "md:grid-cols-7";
  // …이하 렌더 동일…
}
```

  - `ReportView.tsx` 154-158행:

```tsx
<Summary
  summary={report.summary}
  dropped={report.dropped}
  openLoop={openLoopRates(
    report.run.profile,
    report.dropped,
    report.summary.duration_seconds,
    report.insights ?? [],
  )}
/>
```

(import 추가: `import { openLoopRates } from "./openLoopRates";` — 기존 `(report.run.profile as {target_rps?: number}|null)` 캐스트는 제거.)

- [ ] **Step 7: GREEN 확인** — Run: `pnpm test Summary && pnpm test ReportHeadline && pnpm test ReportView` → Expected: PASS (ReportView 테스트가 있으면 곡선 run에서도 카드가 뜨는 변화 반영 — 기존 fixture에 stages가 있으면 카드 7→10개로 단언 갱신)

- [ ] **Step 8: 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
git add ui/src/i18n/ko.ts ui/src/components/report/
git commit -m "feat(ui): 리포트 목표/달성 도착률 카드 + 헤드라인 도착률 표기 (ADR-0046 ②)"
```

---

### Task 5: 전수 스윕 게이트 + full 게이트

**Files:**
- Modify: (스윕에서 잔존 발견 시 해당 파일 — 예상 0)

- [ ] **Step 1: ko.ts RPS 잔존 대조** — Run: `grep -n "RPS" ui/src/i18n/ko.ts` → Expected: 잔존 전부가 위 **Keep-list** 항목에만 해당(파일 헤더 주석·glossary.rps·timeSeriesRequests·cardAvgRps×2·sizing.* 블록). 목록 밖 잔존 발견 시 표의 규칙(도착률 개명 vs 요청/초 유지)으로 판정해 처리.
- [ ] **Step 2: 구 표현 grep-0** — Run: `grep -rn "목표 RPS\|요청 속도 기준" ui/src --include="*.ts" --include="*.tsx"` → Expected: **keep-list 항목만**(`sizing.ts:7`·`sizing.ts:30` 주석·ko.ts `sizing:` 블록[closed VU 헬퍼]·VuSizingHelper 관련 테스트). 그 외 0.
- [ ] **Step 3: 하드코딩 한글 스윕(신규 문구가 카탈로그 경유인지)** — Run: `grep -n '"[^"]*[가-힣]' ui/src/components/report/openLoopRates.ts ui/src/components/report/Summary.tsx` → Expected: 0 (문구는 전부 ko.ts 경유; `"—"` placeholder는 한글 아님).
- [ ] **Step 4: full 게이트** — Run: `cd ui && pnpm lint && pnpm test && pnpm build` → Expected: 전부 green.
- [ ] **Step 5: 잔존 처리했으면 커밋** (없으면 skip). **tdd-guard 주의**: 잔존이 ko.ts *값*(문자열 리터럴 = 행동 변경)이면 그 문구를 단언하는 테스트를 **먼저** 갱신해 pending test를 만든 뒤 ko.ts를 고친다(주석-only 잔존은 가드 통과):

```bash
git add -A ui/src && git commit -m "chore(ui): open-loop RPS 잔존 카피 스윕 마무리 (ADR-0046 ②)"
```

> **orchestrator 주의**: Step 1~3의 grep은 subagent 보고와 무관하게 **orchestrator가 최종 리뷰 때 직접 재실행**한다(CLAUDE.md "완성도 게이트는 직접 재실행").

---

### Task 6: 라이브 검증 (orchestrator 직접 — `/live-verify`)

UI-only·Zod 0-diff지만 `openLoopRates`가 실 리포트 JSON(profile/dropped/insights)을 소비하므로 라이브 1회 확인(구현 rigor 선호). 슬라이스 ① 레시피(100ms responder + think 시나리오) 재사용:

- [ ] **Run A (포화)**: 1-스텝(105ms) + think 1s·target 20·slots 3·15s → 리포트 카드: 목표 도착률 **20** / 달성 도착률 **≈2.7**(인사이트 passthrough) / 드롭 > 0. 헤드라인 "목표 도착률 초당 20회로".
- [ ] **Run B (비포화)**: 같은 시나리오·slots 30 → 달성 == 목표(20.0) · 드롭 0 (인사이트 없음 — 클라 산출 경로).
- [ ] **RunDialog 실측**(Playwright): open 타일 제목 "도착률 (초당 반복)"·입력 라벨 "도착률(초당 반복)"·환산 힌트 "≈ 초당 요청 20건"(1-스텝 시나리오·목표 20) 렌더 + 콘솔 Zod 에러 0.
- [ ] payload 대조: run 생성 POST 본문이 슬라이스 이전과 동일 shape(`target_rps`/`max_in_flight` — 개명은 라벨뿐).
- [ ] finish-slice 기록 리마인더: "리포트 도착률 **시리즈**"는 per-second dropped 시리즈와 함께 roadmap §B20에 잔존 연기로 명기(카드·헤드라인 표기만 이 슬라이스에서 소화).

---

REVIEW-GATE: APPROVED

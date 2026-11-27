# 판정 기준·응답 시간 통계 ④c — 비교 인쇄의 시간 흐름에 평균 응답 시간 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

plan 검토: `spec-plan-reviewer` 3라운드(1차 Important 1·Minor 10, 2차 Fix 4 — 모두 반영) 뒤 clean APPROVE(2026-11-27).

REVIEW-GATE: APPROVED

**Goal:** 비교 보고서 인쇄(표준판)의 「시간에 따른 변화 — 겹쳐 보기」 절에 이전·이후 run의 칸별 평균 응답 시간 선을 함께 그린다(spec R-C1 · US10).

**Architecture:** UI만 바꾼다. ④a가 만든 칸 평균 계산(`print/latencyChart.ts` `binLatency`)을 비교 인쇄의 묶음(`OverlaySide.bins`)에도 쓸 수 있게 인자 타입만 넓히고, 새 순수 모델 `print/compare/overlayLatency.ts`가 두 run의 `latency_by_second`를 겹쳐 보기와 같은 묶음으로 묶는다. 그림은 겹쳐 보기 그림 바로 아래의 **새 atomic 블록 `cmp:overlay:lat`**(같은 절, 제목 없음)로 넣는다 — 기존 그림은 세로축 둘(처리량·오류)을 이미 쓰고 있어 세 번째 단위(ms)를 같은 그림에 넣을 수 없다.

**Tech Stack:** TypeScript · React · vitest/RTL · 인쇄 CSS(`ui/src/print/print.css`). 서버·와이어·DB·proto·엔진 변화 없음.

**Spec:** `docs/superpowers/specs/2026-11-25-verdict-stats-b-design.md` — §2 「④c」 R-C1, US10, §1.3 「하면 안 되는 것」. ④c는 spec 목업 밖(`b-screens.html` 61행 「④c = 비교 인쇄 시간 흐름(이 목업 밖)」)이라 따로 목업을 만들었다 — 아래 「시각 기준」.

## 사용자 스토리 (US)

(spec에서 그대로 — 2026-11-25 사용자 승인)

- **US10**: QA가 비교 보고서를 인쇄한다 — 성공하면 시간 흐름 겹쳐 보기 절에 이전·이후 run의 초별 평균 응답 시간 선이 함께 보인다.

## Global Constraints

- 60초 칸 값을 표시 없이 보여 주지 않는다(spec §1.3) — 묶음에 `capped`인 초가 있으면 캡션에 「60초를 넘긴 응답이 있어 그 구간의 값은 실제보다 작게 그려졌습니다.」(`ko.print.latencyChart.capped` 그대로).
- 같은 값이 인쇄·비교 인쇄에서 다른 숫자로 나오지 않는다 — 칸 평균은 `binLatency` 하나(`Σ n·mean_us / Σ n`, R-A8과 공유 — R-C1).
- 재지 않은 쪽은 0으로 그리지 않는다(`ui/CLAUDE.md` 인쇄 보고서 절) — 응답 시간 값이 없는 쪽은 선이 없고 범례 줄에 글로 적는다.
- 요약판(한 쪽)에는 넣지 않는다(spec §1.2 — 요약판에 그래프 없음).
- 화면 문구는 모두 `ui/src/i18n/ko.ts`(ADR-0035), 보고서 문체(working-rules §8).
- 실행 중 화면·단일 run 인쇄의 그림은 바뀌지 않는다(`binLatency`는 인자 타입만 넓힘 — 기존 `print/__tests__/latencyChart.test.ts` 무수정 green). **정정(2026-11-27, 사용자 결정 `c2497c01`)**: 단일 run 인쇄 「응답 시간」 그림도 홀로 남은 묶음을 묶음 폭 선분으로 그린다(공용 `latencyLinePoints`) — 그 테스트 파일에 단위 테스트를 더했고 `LatencyChart.test.tsx` 기존 단언 하나가 새 규칙 값으로 바뀌었다. 실행 중 화면은 그대로.
- 값은 정확히 — 테스트 기대값은 아래에 적은 숫자 그대로(working-rules §10-1).
- 결함을 설명하는 주석을 쓰지 않는다(working-rules §7).

## 시각 기준 — 목업 `docs/superpowers/mockups/2026-11-27-verdict-stats-4c-overlay.html` 「안 A」

**사용자 결정(2026-11-27, 다시 묻지 않는다): 안 A** — 지금 겹쳐 보기 그림 아래에 같은 크기(180 × 55mm) 그림. 「A안이 제일 대칭도 있어 보이고, 조금 길어지더라도 보는 사람 입장에서 더 나을 것 같아」. 안 B(낮은 그림)·안 C(나란히)는 기각. 목업의 「한쪽에 응답 시간 값이 없을 때」 장도 기준이다.

**구현 지시(brief)에 이 목업 경로를 주고 그 CSS·마크업을 시각 기준으로 명시한다**(working-rules §4). 목업 값은 아래처럼 기존 두 그림의 값과 같다 — 새 디자인 값은 없다. Task 2 직후 컨트롤러를 띄워 목업과 나란히 대조한다.

- 틀·세로 기하·글자: `compare/components/OverlayChart.tsx`와 같은 상수(`PLOT_TOP 8`·`PLOT_BOTTOM 47`·`TIME_LABEL_Y 51.5`·`FONT 2.3`·`COLOR_GRID #e4e6ea`·`COLOR_SUB #5b6170`), viewBox `0 0 180 55`, 가로 눈금·시간축은 겹쳐 보기 그림과 같은 `durationSec`·`timeTicks`.
- 선: 이전 = `#9aa1ad` 점선 `strokeDasharray="1.5 1"` 굵기 0.5 / 이후 = `#3b4bc8` 실선 굵기 0.5(처리량 선과 같은 색·모양 — 같은 절에서 「회색 점선 = 이전, 파란 실선 = 이후」가 유지된다). 선 끝 `strokeLinecap="round"`. **정정(2026-11-27 라이브 ④)**: 앞뒤가 끊겨 홀로 남은 묶음은 점이 아니라 그 묶음 폭만큼의 가로 선분으로 그린다(같은 절 `OverlayChart` `RpsLine`의 규칙) — 길이 0 경로는 점선(이전)일 때 인쇄 PDF에서 보이지 않았다(`3578f3aa`).
- 상자: `p-cmp-box p-cmp-ov-box`, 위 블록과 1.5mm 간격(`p-cmp-b--note`). 상자 첫 줄 = 굵은 글씨 제목 「평균 응답 시간 (ms)」(`p-bold`), 그 아래 그림, 범례, 캡션(`p-cmp-note p-cmp-ov-reading` — 위 여백 0.5mm는 `p-cmp-ov-reading`이 준다, `OverlayChart.tsx`의 읽는 법 줄과 같은 모양). 상자 안쪽 여백은 `p-cmp-ov-box`(1.5mm 3mm) 그대로, `print.css`는 바꾸지 않는다. 범례·svg 마크업은 `OverlayChart.tsx`의 `Legend`·`Svg`와 같게 쓴다 — 견본은 `<i className="p-cmp-db-sw p-cmp-ov-sw--line [p-cmp-ov-sw--dash]" style={{ borderTopColor }} aria-hidden="true" />`(폭 4mm는 `p-cmp-db-sw`에서 온다 — 빼면 견본이 안 보인다), 범례 줄은 `p-cmp-db-legend p-cmp-ov-legend`, svg에는 `style={{ display: "block" }}`.
- 값이 없던 묶음: 단일 run 인쇄와 같다 — 초가 하나도 없던 묶음은 건너뛰어 잇고(§B98 (0-1) 규칙), 초는 있었지만 통과 표본이 0이던 묶음은 선을 끊는다(`sparkPath`의 `null`).

## Review Focus

1. **한쪽 run에 응답 시간 값이 없다**(옛 run — `latency_by_second` 없음, 또는 통과한 요청 0건) → 그 쪽 선 없음 + 범례 줄 「이전 측정에는 응답 시간 값이 없습니다.」, 다른 쪽은 그대로 그린다. 0ms 선을 그리지 않는다. (Task 1 테스트 3 · `overlayLatencyChart` 테스트 2)
2. **두 run 모두 값이 없다 / 요청이 실행되지 않은 측정** → 블록 자체가 없다(빈 그림 상자 금지). (Task 1 테스트 4 · `buildCompareDoc` 새 테스트 2·3)
3. **두 측정 길이가 다르다**(이전 60초 · 이후 1,800초) → 묶음 15초 공통, 이전 선은 제 길이(묶음 4개)에서 끝난다. (Task 1 테스트 2)
4. **60초를 넘긴 응답이 있는 묶음** → 캡션에 잘림 안내, 값은 60,000을 넘지 않는다. (Task 1 테스트 5 · `overlayLatencyChart` 테스트 1의 캡션 유무 두 경우)
5. **묶음이 하나뿐**(1초짜리 측정) → NaN·Infinity 없는 경로, 그림 폭 전체의 가로 선분(정정 `3578f3aa`). (`overlayLatencyChart` 테스트 3)

## File Structure

| 파일 | 일 |
|---|---|
| `ui/src/print/latencyChart.ts` (수정) | `binLatency`·`buildLatencyChart`의 셋째 인자 타입을 `ChartModel` → `LatencyGrid`(구조 타입)로 넓힘 |
| `ui/src/print/compare/overlay.ts` (수정) | `sideDuration` export |
| `ui/src/print/compare/overlayLatency.ts` (새) | 순수 모델 `buildOverlayLatency` |
| `ui/src/print/compare/components/OverlayLatencyChart.tsx` (새) | 그림 + 범례 + 캡션 |
| `ui/src/print/compare/buildCompareDoc.ts` (수정) | `CompareDoc.overlayLatency` · 표준판 블록 `cmp:overlay:lat` |
| `ui/src/print/compare/CompareDocument.tsx` (수정) | 블록 렌더 · 간격 클래스 |
| `ui/src/i18n/ko.ts` (수정) | `ko.print.cmp.overlay.latency` |
| `ui/src/print/compare/__tests__/latencyRuns.ts` (새) | 테스트 공용 도우미(`T0_SEC`·`win`·`secs`·`L`·`run`) |
| `ui/src/print/compare/__tests__/overlayLatency.test.ts` (새) · `overlayLatencyChart.test.tsx` (새) · `buildCompareDoc.test.ts` · `CompareDocument.test.tsx` (수정) | 테스트 |

`print.css`는 바꾸지 않는다(쓰는 클래스가 모두 이미 있다 — 아래 사실 확인).

---

### Task 1: 모델 — 두 run의 칸별 평균 응답 시간

**Files:**
- Test: `ui/src/print/compare/__tests__/overlayLatency.test.ts` (새)
- Modify: `ui/src/print/latencyChart.ts`(`binLatency`·`buildLatencyChart` 시그니처)
- Modify: `ui/src/print/compare/overlay.ts`(`sideDuration`에 `export`)
- Create: `ui/src/print/compare/overlayLatency.ts`
- Modify: `ui/src/i18n/ko.ts`(`print.cmp.overlay` 안에 `latency` 추가)

**Interfaces:**
- Consumes: `OverlayModel`·`OverlaySide`·`buildOverlay`(`./overlay`), `RunModel`(`./runModel`), `LatencyBin`·`binLatency`(`../latencyChart`), `niceTicks`·`elapsedText`(`../chartModel`).
- Produces (Task 2가 쓴다):

```ts
// ui/src/print/latencyChart.ts
export type LatencyGrid = {
  binSeconds: number;
  bins: readonly { startSec: number; seconds: number }[];
};
export function binLatency(series: SecondLatency[], t0: number, grid: LatencyGrid): LatencyBin[];
export function buildLatencyChart(series: SecondLatency[], t0: number | null, chart: LatencyGrid): LatencyChartModel | null;

// ui/src/print/compare/overlay.ts
export function sideDuration(run: RunModel): { t0: number; durationSec: number };

// ui/src/print/compare/overlayLatency.ts
export type OverlayLatencySide = { bins: LatencyBin[]; has: boolean }; // has = meanMs가 있는 묶음이 하나라도
export type OverlayLatencyModel = {
  durationSec: number;      // overlay.durationSec
  timeTicks: number[];      // overlay.timeTicks
  binText: string;          // elapsedText(overlay.binSeconds)
  before: OverlayLatencySide;
  after: OverlayLatencySide;
  yTicks: number[];         // niceTicks(두 쪽 meanMs 최댓값, 5)
  capped: boolean;          // 어느 쪽이든 capped 묶음이 있음
  missingNote: string | null; // 한쪽만 값이 없을 때 그 쪽 글
};
export function buildOverlayLatency(before: RunModel, after: RunModel, overlay: OverlayModel): OverlayLatencyModel | null;

// ui/src/i18n/ko.ts — ko.print.cmp.overlay.latency
latency: {
  title: "평균 응답 시간 (ms)",
  aria: "이전·이후 평균 응답 시간을 시간 순서로 겹쳐 그린 그래프",
  legendBefore: "이전 평균 응답 시간",
  legendAfter: "이후 평균 응답 시간",
  missingBefore: "이전 측정에는 응답 시간 값이 없습니다.",
  missingAfter: "이후 측정에는 응답 시간 값이 없습니다.",
  caption: (bin: string) => `모든 단계의 요청을 합친 값입니다. 한 칸 = ${bin}, 그 칸 안 요청 전체의 평균입니다.`,
},
```

규칙: 각 쪽의 `bins = binLatency(run.report.latency_by_second ?? [], sideDuration(run).t0, { binSeconds: overlay.binSeconds, bins: side.bins })`(쪽의 `durationSec`이 0이면 `[]`). 두 쪽 모두 `has === false`면 `null`. `missingNote`는 `before.has !== after.has`일 때만.

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `overlayLatency.test.ts`와 공용 도우미 파일 `ui/src/print/compare/__tests__/latencyRuns.ts`(새 — `T0_SEC`·`win`·`secs`·`L`·`run`을 export, Task 2의 테스트 파일들도 이것을 쓴다. `overlay.test.ts`는 건드리지 않는다). 도우미는 `overlay.test.ts`의 `T0_SEC`·`win`·`secs`·`run`과 같은 모양이되 `run(id, windows, lat)`가 `latency_by_second: lat`를 리포트에 넣는다(`lat`이 빈 배열이면 키를 넣지 않는다 — 서버가 빈 목록을 빼고 보낸다). `ReportSchema.safeParse(report).success`를 도우미 안에서 단언한다.

```ts
const L = (sec: number, n: number, mean_us?: number, capped?: boolean) => ({
  ts_second: T0_SEC + sec,
  n,
  // p95는 평균과 다른 값 — 세로 눈금이 p95를 섞어 넣으면 yTicks 단언이 깨진다
  ...(mean_us === undefined ? {} : { mean_us, p95_us: Math.min(mean_us * 3, 60_000_000) }),
  ...(capped ? { capped: true } : {}),
});
const model = (b: RunModel, a: RunModel) => buildOverlayLatency(b, a, buildOverlay(b, a, false));

it("칸 평균: 2초 묶음에 (n=1, 10ms)·(n=3, 20ms) → 17.5ms (R-A8과 같은 계산)", () => {
  const m = model(
    run("b", secs(125, 10), [L(0, 1, 10_000), L(1, 3, 20_000)]),
    run("a", secs(125, 10), [L(2, 2, 30_000)]),
  )!;
  expect(m.durationSec).toBe(125);
  expect(m.binText).toBe("2초");
  expect(m.before.bins).toHaveLength(63);
  expect(m.before.bins[0]).toMatchObject({ startSec: 0, seconds: 2, meanMs: 17.5, observed: true });
  expect(m.before.bins[1]).toMatchObject({ meanMs: null, observed: false });
  expect(m.after.bins[1]).toMatchObject({ startSec: 2, meanMs: 30 });
  expect(m.yTicks).toEqual([0, 10, 20, 30]);
  expect(m.capped).toBe(false);
  expect(m.missingNote).toBeNull();
  expectClean(m);
});

it("길이가 다른 두 측정: 이전 60초 · 이후 1,800초 → 15초 묶음, 이전 4개 · 이후 120개", () => {
  const b = run("b", secs(60, 10), [L(59, 4, 8_000)]);
  const a = run("a", secs(1800, 10), [L(1799, 1, 12_000)]);
  const m = model(b, a)!;
  expect(m.binText).toBe("15초");
  expect(m.before.bins).toHaveLength(4);
  expect(m.before.bins[3]!.meanMs).toBe(8);
  expect(m.after.bins).toHaveLength(120);
  expect(m.after.bins[119]!.meanMs).toBe(12);
  expect(m.timeTicks).toEqual(buildOverlay(b, a, false).timeTicks);
});

it("한쪽에만 값이 없으면 그 쪽은 has false + 글, 다른 쪽은 그대로", () => {
  const m = model(run("b", secs(10, 5), []), run("a", secs(10, 5), [L(0, 1, 5_000)]))!;
  expect(m.before.has).toBe(false);
  expect(m.before.bins.every((b) => b.meanMs === null)).toBe(true);
  expect(m.after.has).toBe(true);
  expect(m.missingNote).toBe("이전 측정에는 응답 시간 값이 없습니다.");
  // 거꾸로
  const r = model(run("b", secs(10, 5), [L(0, 1, 5_000)]), run("a", secs(10, 5), [L(0, 0)]))!;
  expect(r.missingNote).toBe("이후 측정에는 응답 시간 값이 없습니다.");
});

it("두 쪽 모두 값이 없으면 null (창 없는 측정 포함)", () => {
  expect(model(run("b", secs(10, 5), []), run("a", secs(10, 5), [L(0, 0)]))).toBeNull();
  expect(model(run("b", [], []), run("a", [], []))).toBeNull();
});

it("60초 칸: capped 초가 든 묶음이 있으면 capped true, 값은 60,000", () => {
  const m = model(
    run("b", secs(10, 5), [L(0, 2, 60_000_000, true)]),
    run("a", secs(10, 5), [L(0, 1, 5_000)]),
  )!;
  expect(m.capped).toBe(true);
  expect(m.before.bins[0]!.meanMs).toBe(60_000);
  expect(m.yTicks[m.yTicks.length - 1]).toBe(60_000);
});
```

`yTicks`는 두 쪽 `meanMs`만으로 정한다(`p95Ms`는 쓰지 않는다 — 이 그림에는 p95 선이 없다).

**명령 규칙(두 task 공통)**: `pnpm` 명령은 `/Users/sgj/develop/handicap/.claude/worktrees/verdict-stats-4c/ui`에서, `git` 명령은 워크트리 루트 `/Users/sgj/develop/handicap/.claude/worktrees/verdict-stats-4c`에서 **단독 호출**로 돌린다(`cd … && git …` 복합 금지 — 루트 CLAUDE.md ⑤). 아래 git 경로는 모두 워크트리 루트 기준이다.

- [ ] **Step 2: 실패를 확인한다** — (`ui/`에서) `pnpm test overlayLatency` → FAIL(`../overlayLatency` 모듈 없음).

- [ ] **Step 3: `binLatency`·`buildLatencyChart` 인자 타입을 `LatencyGrid`로 넓힌다** — 본문에서 `chart.bins`·`chart.binSeconds`만 읽으므로 타입만 바꾼다(`ChartModel`은 구조적으로 `LatencyGrid`에 들어맞아 `buildPrintDoc.ts` 호출부는 그대로). `ChartModel` import가 안 쓰이면 지운다.

- [ ] **Step 4: `sideDuration`을 export하고 `overlayLatency.ts`·`ko` 키를 쓴다** — 위 Interfaces 그대로.

- [ ] **Step 5: 통과를 확인한다** — (`ui/`에서) `pnpm test overlayLatency` → PASS(5개), `pnpm test latencyChart` → PASS, `pnpm test overlay` → PASS. 기존 테스트 파일 무수정 확인은 워크트리 루트에서 `git status --porcelain ui/src/print/__tests__/latencyChart.test.ts ui/src/print/compare/__tests__/overlay.test.ts` → 출력 없음(두 상태: 지금도 출력 없음 — 이 명령은 「고쳤다면 줄이 나온다」를 본다).

- [ ] **Step 6: 되돌려 확인(teeth check)** — `overlayLatency.ts`에서 `sideDuration(run).t0` 자리에 `0`을 넣는다 → 첫 테스트가 RED(모든 초가 마지막 묶음으로 몰려 `bins[0].meanMs`가 `null`)인지 보고 원복 → GREEN.

- [ ] **Step 7: 게이트 + 커밋** (각각 단독 foreground 호출, 파이프 금지. 커밋 메시지는 Write 도구로 `.superpowers/sdd/msg-task1.txt`에 쓰고 `-F`로 넘긴다 — 첫 줄 `feat(ui): 비교 인쇄 겹쳐 보기 — 이전·이후 칸별 평균 응답 시간 모델 (④c R-C1)`)

```bash
# ui/ 에서
pnpm lint && pnpm test && pnpm build; echo exit=$?
# 워크트리 루트에서, 한 줄씩 단독 호출
git add ui/src/print/latencyChart.ts ui/src/print/compare/overlay.ts ui/src/print/compare/overlayLatency.ts ui/src/i18n/ko.ts ui/src/print/compare/__tests__/overlayLatency.test.ts ui/src/print/compare/__tests__/latencyRuns.ts
git diff --cached --name-only
git commit -F .superpowers/sdd/msg-task1.txt
git log -1 --oneline
```

---

### Task 2: 그림 + 표준판 블록 `cmp:overlay:lat`

**Files:**
- Test: `ui/src/print/compare/__tests__/overlayLatencyChart.test.tsx` (새), `buildCompareDoc.test.ts`·`CompareDocument.test.tsx` (추가)
- Create: `ui/src/print/compare/components/OverlayLatencyChart.tsx`
- Modify: `ui/src/print/compare/buildCompareDoc.ts`(`CompareDoc` 타입 · `buildCompareDoc` 반환 · `compareStandardBlocks`)
- Modify: `ui/src/print/compare/CompareDocument.tsx`(`AtomicContent`의 `switch` · `blockClass`)

**Interfaces:**
- Consumes: Task 1의 `OverlayLatencyModel`·`buildOverlayLatency`·`ko.print.cmp.overlay.latency`, `sparkPath`(`../../../report/sparkPath`), `CHART_W_MM`·`CHART_H_MM`·`PLOT_X0_MM`·`PLOT_X1_MM`·`fmtElapsed`·`markerX`(`../../chartModel`), `ko.print.latencyChart.capped`.
- Produces:

```ts
// buildCompareDoc.ts — CompareDoc
/** 표준판 겹쳐 보기 절의 평균 응답 시간 그림. 두 측정 모두 값이 없으면 null(블록 없음). */
overlayLatency: OverlayLatencyModel | null;
// buildCompareDoc(): overlay를 변수에 담아 overlayLatency: incomparable ? null : buildOverlayLatency(before, after, overlay)
// compareStandardBlocks(): atom(h, "cmp:overlay") 바로 뒤에 ...(doc.overlayLatency !== null ? [atom(h, "cmp:overlay:lat")] : [])
// compareSummaryBlocks(): 변화 없음

// components/OverlayLatencyChart.tsx
export function OverlayLatencyChart({ model }: { model: OverlayLatencyModel }): JSX.Element;
```

그림 규칙(「시각 기준」 절): 쪽마다 `<path data-ovlat-line="before"|"after">`를 `sparkPath(관측된 묶음의 {x: startSec + seconds/2, y: meanMs}, {xMax: durationSec, yMax: 마지막 yTick(1e-9 하한), x0: PLOT_X0_MM, x1: PLOT_X1_MM, yTop: 8, yBottom: 47})`로 그린다 (정정 `3578f3aa`: 홀로 남은 묶음은 {x: startSec}·{x: startSec + seconds} 두 점 — 묶음 폭 선분) — `has === false`인 쪽은 `<path>`를 만들지 않는다. `<svg className="p-cmp-ovlat" role="img" aria-label={K.aria} width="100%" viewBox="0 0 180 55">`. 범례는 `has`인 쪽만 견본 + 이름, `missingNote`가 있으면 `<span>`으로 덧붙인다. 캡션 = `K.caption(model.binText)` + (`model.capped`면 `" " + ko.print.latencyChart.capped`). `CompareDocument.tsx`: `case "cmp:overlay:lat": return doc.overlayLatency === null ? null : <OverlayLatencyChart model={doc.overlayLatency} />;`, `blockClass`의 `p-cmp-b--note` 목록에 `"cmp:overlay:lat"` 추가.

`incomparable`(요청이 실행되지 않은 측정이 있음)이면 블록을 만들지 않는다 — 겹쳐 보기 그림이 「비교하지 않았습니다」를 이미 적는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`overlayLatencyChart.test.tsx`(도우미는 Task 1의 `./latencyRuns`에서 `run`·`secs`·`L`):

```tsx
it("두 쪽 모두 값이 있으면 선 2개(이전만 점선) · 제목 · 범례 2개 · 캡션", () => {
  const b = run("b", secs(10, 5), [L(0, 1, 5_000), L(1, 1, 7_000)]);
  const a = run("a", secs(10, 5), [L(0, 1, 3_000), L(1, 1, 4_000)]);
  const { container } = render(<OverlayLatencyChart model={buildOverlayLatency(b, a, buildOverlay(b, a, false))!} />);
  const lines = container.querySelectorAll("path[data-ovlat-line]");
  expect(lines).toHaveLength(2);
  expect(container.querySelector('path[data-ovlat-line="before"]')?.getAttribute("stroke-dasharray")).toBe("1.5 1");
  expect(container.querySelector('path[data-ovlat-line="after"]')?.hasAttribute("stroke-dasharray")).toBe(false);
  // 세로 기하 고정: yTicks = niceTicks(7, 5) = [0,2,4,6,8] → yMax 8, durationSec 10.
  // x = 12 + (0.5/10)·156 = 19.8, 12 + (1.5/10)·156 = 35.4 · y = 47 − (5/8)·39 = 22.625 → 22.63, 47 − (7/8)·39 = 12.875 → 12.88
  expect(container.querySelector('path[data-ovlat-line="before"]')?.getAttribute("d")).toBe("M19.8,22.63 L35.4,12.88");
  const svg = container.querySelector("svg.p-cmp-ovlat")!;
  expect(svg.getAttribute("viewBox")).toBe("0 0 180 55");
  expect(svg.getAttribute("aria-label")).toBe("이전·이후 평균 응답 시간을 시간 순서로 겹쳐 그린 그래프");
  expect(container.textContent).toContain("평균 응답 시간 (ms)");
  expect(container.textContent).toContain("이전 평균 응답 시간");
  expect(container.textContent).toContain("이후 평균 응답 시간");
  expect(container.textContent).toContain("모든 단계의 요청을 합친 값입니다. 한 칸 = 1초, 그 칸 안 요청 전체의 평균입니다.");
  expect(container.textContent).not.toContain("60초를 넘긴 응답이 있어");
  expect(container.innerHTML).not.toContain("NaN");
  // 60초 칸이 있으면 캡션에 안내
  const c = run("c", secs(10, 5), [L(0, 2, 60_000_000, true)]);
  const capped = render(<OverlayLatencyChart model={buildOverlayLatency(c, a, buildOverlay(c, a, false))!} />);
  expect(capped.container.textContent).toContain("60초를 넘긴 응답이 있어 그 구간의 값은 실제보다 작게 그려졌습니다.");
});

it("한쪽에 값이 없으면 그 쪽 선·범례 이름이 없고 글이 붙는다", () => {
  const b = run("b", secs(10, 5), []);
  const a = run("a", secs(10, 5), [L(0, 1, 3_000)]);
  const { container } = render(<OverlayLatencyChart model={buildOverlayLatency(b, a, buildOverlay(b, a, false))!} />);
  expect(container.querySelectorAll("path[data-ovlat-line]")).toHaveLength(1);
  expect(container.querySelector('path[data-ovlat-line="before"]')).toBeNull();
  expect(container.textContent).not.toContain("이전 평균 응답 시간");
  expect(container.textContent).toContain("이전 측정에는 응답 시간 값이 없습니다.");
});

it("묶음이 하나뿐이어도 NaN·Infinity 없는 경로", () => {
  const b = run("b", secs(1, 5), [L(0, 1, 5_000)]);
  const a = run("a", secs(1, 5), [L(0, 1, 3_000)]);
  const { container } = render(<OverlayLatencyChart model={buildOverlayLatency(b, a, buildOverlay(b, a, false))!} />);
  expect(container.querySelectorAll("path[data-ovlat-line]")).toHaveLength(2);
  expect(container.innerHTML).not.toContain("NaN");
  expect(container.innerHTML).not.toContain("Infinity");
});
```

`buildCompareDoc.test.ts`에 추가. 그 파일의 `withSpeed`(리포트를 펼쳐 칸을 더하는 기존 도우미)와 같은 모양으로 `withLatency(m: RunModel, windows, lat): RunModel = { ...m, report: { ...m.report, windows, latency_by_second: lat } }`를 그 파일 안에 두고(`buildOverlayLatency`는 `report.windows`·`report.latency_by_second`·`meta.started_at`만 읽는다), 창·초 값은 `./latencyRuns`의 `secs`·`L`로 만든다. 요약판 id 목록은 기존 관용구 `compareSummaryBlocks(d, new Map(), l).map((b) => b.id)`:

```ts
it("두 측정에 응답 시간 값이 있으면 cmp:overlay:lat이 cmp:overlay 바로 뒤, 요약판에는 없다", () => {
  // list = 표준판 블록 id 목록
  expect(list.indexOf("cmp:overlay:lat")).toBe(list.indexOf("cmp:overlay") + 1);
  expect(list.indexOf("cmp:cond")).toBe(list.indexOf("cmp:overlay:lat") + 1); // speed_bands 없는 픽스처
  for (let l = 0; l <= CMP_LAST_LEVEL; l++)
    expect(compareSummaryBlocks(doc, new Map(), l).map((b) => b.id)).not.toContain("cmp:overlay:lat");
});
it("응답 시간 값이 없는 두 측정이면 cmp:overlay:lat이 없다(기존 픽스처)", () => {
  expect(doc.overlayLatency).toBeNull();
  expect(list).not.toContain("cmp:overlay:lat");
});
it("요청이 실행되지 않은 측정이 있으면(incomparable) 값이 있어도 cmp:overlay:lat이 없다", () => {
  // 이전 = summary.count 0, 이후 = 보통. 두 쪽 모두 withLatency(secs(10, 5), [L(0, 1, 5_000)])로 값이 있다
  // — incomparable 조건을 지운 구현이면 overlayLatency가 null이 아니게 된다
  expect(doc.incomparable).toBe(true);
  expect(doc.overlayLatency).toBeNull();
});
```

`CompareDocument.test.tsx` 「겹쳐 보기 절」 describe에 추가:

```tsx
it("응답 시간 값이 있으면 측정 시트와 쪽에 평균 응답 시간 그림(p-cmp-b--note 블록)이 겹쳐 보기 뒤에 그려진다", async () => {
  // makeDoc에 windows + latency_by_second를 가진 두 run
  expect(container.querySelector('.p-sheet [data-measure="cmp:overlay:lat"]')).not.toBeNull();
  await ready(root);
  const svg = container.querySelector(".p-page svg.p-cmp-ovlat") as SVGElement;
  expect(svg).not.toBeNull();
  expect(svg.closest(".p-block")).toHaveClass("p-cmp-b--note");
  const ov = container.querySelector(".p-page svg.p-cmp-ov")!;
  expect(ov.compareDocumentPosition(svg) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // 절 번호는 그대로(새 절이 아니다)
  expect(screen.getByRole("heading", { name: "6. 시간에 따른 변화 — 겹쳐 보기" })).toBeInTheDocument();
});
```

(`SceneRun`에는 `windows`·`latency_by_second` 칸이 없다 — 이 테스트는 `sceneModel(...)` 두 개에 위 `withLatency`와 같은 펼침을 적용한 뒤 `buildCompareDoc`을 직접 불러 문서를 만든다(`makeDoc`이 `buildCompareDoc`에 넘기는 나머지 인자를 그대로 따른다). `scene.ts` 공용 도우미는 넓히지 않는다.)

- [ ] **Step 2: 실패를 확인한다** — (`ui/`에서) `pnpm test overlayLatencyChart` → FAIL(모듈 없음), `pnpm test buildCompareDoc` → 새 3개 FAIL.

- [ ] **Step 3: `OverlayLatencyChart.tsx`를 쓰고 `buildCompareDoc.ts`·`CompareDocument.tsx`에 배선한다** — 위 Interfaces·그림 규칙 그대로. 세로 눈금 글자는 `OverlayChart.tsx`의 `tickText`와 같은 `toLocaleString("en-US", { maximumFractionDigits: 2 })`.

- [ ] **Step 4: 통과를 확인한다** — (`ui/`에서) `pnpm test overlayLatencyChart buildCompareDoc CompareDocument` → PASS. 선 `d` 기대값 `M19.8,22.63 L35.4,12.88`이 맞지 않으면 STOP — 기하 상수(8·47·12·168)와 `yTicks`를 다시 확인하고, 손계산이 틀렸던 것이면 plan 값을 고친다(단언을 정규식으로 약하게 바꾸지 않는다). 기존 스냅샷이 바뀌지 않았는지 워크트리 루트에서 `git status --porcelain ui/src/print`에 `__snapshots__` 줄이 없음을 본다(기존 픽스처에는 응답 시간 값이 없어 블록이 생기지 않는다).

- [ ] **Step 5: 되돌려 확인(teeth check)** — `compareStandardBlocks`에서 `cmp:overlay:lat` 줄을 지운다 → `buildCompareDoc` 새 테스트 1번과 `CompareDocument` 새 테스트가 RED인지 보고 원복 → GREEN. 이어서 `buildCompareDoc`의 `incomparable ? null :` 조건을 지운다 → 새 테스트 3번이 RED인지 보고 원복 → GREEN.

- [ ] **Step 6: 게이트 + 커밋** (각각 단독 foreground 호출, 파이프 금지. 메시지는 `.superpowers/sdd/msg-task2.txt`에 쓰고 `-F` — 첫 줄 `feat(ui): 비교 인쇄 겹쳐 보기 절에 이전·이후 평균 응답 시간 그림 (④c US10)`)

```bash
# ui/ 에서
pnpm lint && pnpm test && pnpm build; echo exit=$?
# 워크트리 루트에서, 한 줄씩 단독 호출
git add ui/src/print/compare/components/OverlayLatencyChart.tsx ui/src/print/compare/buildCompareDoc.ts ui/src/print/compare/CompareDocument.tsx ui/src/print/compare/__tests__/overlayLatencyChart.test.tsx ui/src/print/compare/__tests__/buildCompareDoc.test.ts ui/src/print/compare/__tests__/CompareDocument.test.tsx
git diff --cached --name-only
git commit -F .superpowers/sdd/msg-task2.txt
git log -1 --oneline
```

---

## 라이브 검증 (orchestrator — Task 2 직후, `/live-verify`)

UI만 바꿨으므로 메인 체크아웃에서 컨트롤러·워커를 **먼저 증분 빌드**(`cargo build -p handicap-controller -p handicap-worker` — 메인 바이너리가 오래됐을 수 있다)한 뒤 그 바이너리 + `--ui-dir <워크트리>/ui/dist`(working-rules §5), 포트는 `lsof`로 빈 것을 확인하고 8099/8098. 목업(안 A)과 스크린샷을 나란히 대조한다.

US10 판정 기준: US10의 「초별」은 묶음이 1초일 때(120초 이하 run)이고, 그보다 긴 run은 R-C1대로 칸 평균이며 캡션이 「한 칸 = N초」를 알린다 — 둘 다 확인한다.

1. **US10**: 지연이 다른 두 run(같은 시나리오, 응답기 지연 예 20ms ↔ 80ms, 각 150초 → 2초 묶음)을 만들고 비교 화면 → [비교 보고서 인쇄] 표준판. 겹쳐 보기 그림 아래에 「평균 응답 시간 (ms)」 그림, 회색 점선·파란 실선 두 선. 스크린샷을 눈으로 본다. 선 높이가 리포트 요약 평균과 맞는지(`GET /api/runs/{id}/report`의 `summary.stats.mean_us` ÷ 1000이 그림 세로 눈금 범위 안) 견준다.
2. **쪽**: 모든 `.p-page`에서 블록 아래 끝이 본문 한계(273mm) 안, `.p-page` 수 == 헤드리스 Chrome `--print-to-pdf` + `pdfinfo` Pages. 새 블록이 쪽 경계에 걸리는 경우(단계 수를 늘려 앞 절을 길게) 한 번.
3. **극단값**: ① 길이가 다른 두 run(20초 ↔ 150초) — 이전 선이 제 길이에서 끝남 ② 한쪽이 전부 실패한 run(통과 0건) — 그 쪽 선 없음 + 글 ③ 60초짜리 두 run(1초 묶음 — 「한 칸 = 1초」) ④ **홀로 남은 점**: 1초짜리 두 run(창이 두 초에 걸치면 묶음 2개가 된다 — 리포트 `windows`의 초 수를 먼저 본다)과, 중간 구간이 전부 실패해 앞뒤가 끊긴 run(그 run의 리포트 `sample`이 통과한 요청 표본일 때만 선이 끊긴다 — 먼저 확인) — 인쇄 PDF에서 이전(점선)·이후 점이 눈에 보이는지 확인한다. 보이지 않으면 STOP → 같은 절 `OverlayChart` `RpsLine`의 규칙(묶음 폭만큼 가로 선분)으로 바꾸고 plan·테스트를 고친다 ⑤ 범례 줄에 `letter-spacing: 0.12em`을 주입(Windows 글꼴 흉내)해 범례·캡션이 상자 밖으로 넘치지 않음(`scrollWidth <= clientWidth`) ⑥ 요약판에는 그림 없음 ⑦ 측정 시트 `[data-measure="cmp:overlay:lat"]`의 높이(mm)를 재서 §B에 적는다(절이 늘어난 길이).
4. **못 하는 것**: 60초를 넘긴 응답(단위 테스트만) — build-log와 §B에 「못 한 검증」으로 적는다.

## §B에 옮길 판단 (finish-slice에서 `grep -n '^### B' docs/roadmap.md` 마지막 + 1 — 지금 마지막은 B103)

- 사용자 결정(2026-11-27, 다시 묻지 않는다): 목업 안 A — 아래에 같은 크기 별도 그림(늘어난 길이는 라이브 ⑦ 실측값으로 적는다).
- p95 선은 넣지 않음(R-C1이 평균만) — 필요하면 후보.
- 두 run의 표본이 다를 때(통과한 요청 ↔ 모든 요청)는 「측정 조건」 카드의 표본 안내 줄(`fairness.sampleLine`)만 알린다 — 그림 캡션에 다시 적지 않음.
- `incomparable`이면 그림 없음.

## 사실 확인 명령 (claims-ledger — 디스패치 전 다시 돌린다, 워크트리 `ui/`에서)

```bash
# binLatency가 chart에서 읽는 것은 bins·binSeconds뿐
grep -n "chart\." src/print/latencyChart.ts
# binLatency·buildLatencyChart를 쓰는 곳(본문 2 + 테스트 1)
grep -rln "binLatency\|buildLatencyChart" src
# sideDuration은 지금 export가 아니다
grep -n "function sideDuration" src/print/compare/overlay.ts
# 표준판 블록 순서·요약판에 overlay 없음
grep -n '"cmp:overlay"' src/print/compare/buildCompareDoc.ts src/print/compare/CompareDocument.tsx
# 쓰는 CSS 클래스가 모두 이미 있다
grep -n "p-cmp-ov-box\|p-cmp-ov-legend\|p-cmp-ov-reading\|\.p-root \.p-cmp-db-sw \|\.p-root \.p-cmp-db-legend \|p-cmp-ov-sw--line\|p-cmp-ov-sw--dash\|p-cmp-b--note\|\.p-root \.p-bold\|\.p-root \.p-cmp-note " src/print/print.css
# 기존 비교 인쇄 픽스처의 리포트에는 latency_by_second가 없다(0건)
grep -rn "latency_by_second" src/print/compare/__tests__ ; echo "exit=$?"
# niceTicks(30, 5) = [0,10,20,30] · pickBinSeconds(125) = 2 · pickBinSeconds(1800) = 15 — chartModel.ts 21–43행을 읽어 손계산, 기존 overlay.test.ts가 2·15를 단언
grep -n "binSeconds).toBe" src/print/compare/__tests__/overlay.test.ts
# ko 키를 Rust 테스트가 읽는지(새 키만 더하므로 영향 없음 — 0건 확인)
grep -rn "cmp.overlay\|legendBeforeRps" ../crates ; echo "exit=$?"
```

두 상태: 구현 뒤에는 둘째 명령에 `src/print/compare/overlayLatency.ts`가 더해지고, 여섯째 명령에 새 테스트 파일들이 나온다.

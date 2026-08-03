# 실행 중 라이브 RPS·에러 궤적 차트 (live-rps-chart) — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** run 진행 중 Run 상세 페이지에 초당 요청 수·초당 에러 시계열 차트를 라이브로 표시한다(이미 1초 폴링 중인 `windows` 데이터의 클라이언트 표시 — 새 fetch 0, 백엔드 0-diff).

**Architecture:** 순수 헬퍼 `liveBySecond`(스텝 간 합산·오름차순·후미 1초 트림)가 기존 `useRunMetrics` 폴링 결과를 시리즈로 접고, `RunDetailPage`의 else 가지(`!(terminal && report.data)`)에 기존 `TimeSeriesChart` 2개를 렌더한다. ADR-0051이 ADR-0009의 후속-범위 한 줄을 supersede.

**Tech Stack:** React + TS + 기존 recharts(`TimeSeriesChart` 재사용) + vitest/RTL. 신규 의존성 0.

**Spec:** `docs/superpowers/specs/2026-08-03-live-rps-chart-design.md` (clean APPROVE, R3). US·N-id·F-ledger는 spec이 정본 — 이 plan의 N1~N7·F1~F13 인용은 그 문서를 가리킨다.

## Global Constraints

- **백엔드/proto/스토어/migration 0-diff** — `ui/src`·`docs/`·루트 `CLAUDE.md` 밖을 건드리면 범위 위반 (spec §4).
- **새 fetch 금지** — 데이터는 기존 `useRunMetrics` 폴링(F1)만 소비 (N7).
- 사용자 노출 문구는 전부 `ko.ts` 경유 (ADR-0035). 신규 키는 `ko.runDetail.liveSectionTitle = "라이브 궤적"` **1개뿐** (N6). 차트 제목·aria는 `ko.report.timeSeriesRequests`/`timeSeriesErrors`/`timeSeriesAria` 재사용.
- UI 게이트: `pnpm lint`(--max-warnings=0)·`pnpm test`·`pnpm build`(tsc -b가 최종). baseline 실측 green: lint=0 · test=0(211 files/2439 tests) · build=0.
- **tdd-guard**: 각 task의 첫 편집은 반드시 테스트 파일(테스트 편집은 항상 허용, pending test가 생겨야 src 편집 가능). 이 plan의 step 순서가 이미 그 순서다 — 자구를 재배열하지 말 것.
- **spec-review-guard**: 이 plan 파일 끝의 `REVIEW-GATE: APPROVED` 마커가 없으면 `ui/src` 편집이 차단된다(마커는 리뷰 통과 후 orchestrator가 단다).
- 트림 테스트 기대값은 **하드코딩 리터럴** — `LIVE_TRIM_TRAILING_SECONDS`를 테스트에서 import 금지 (자기참조 공허 차단, spec §7).

## plan-신규 사실 (spec F-ledger 외 — 검증 명령 재실행 완료 2026-08-03)

| # | 사실 | 확인 명령 |
|---|---|---|
| P1 | `RunDetailPage.test.tsx` 헬퍼 = `renderWithRouter(runId)`(QueryClient retry:false + MemoryRouter `/runs/:id`) · 모듈 스코프 `fetchMock` + `beforeEach` stubGlobal · `jsonResponse(body, status=200)` — 신규 케이스도 이 3종 재사용 | `sed -n '15,40p' ui/src/pages/__tests__/RunDetailPage.test.tsx` |
| P2 | `PageSection` props = `{ariaLabel, title, sub?, className?, children}` → `<section aria-label>` + (sub? h4 : h3). `className`은 통째 교체(`?? "mb-6"`) | `cat ui/src/components/ui/PageSection.tsx` (27줄) |
| P3 | 기존 run fixture 형태(status/profile/env/started_at/…)는 test 파일 `:46-59` 패턴 그대로 — `profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 5 }`로 RunSchema 통과 | `sed -n '42,69p' ui/src/pages/__tests__/RunDetailPage.test.tsx` |

---

### Task 1: `liveBySecond` 순수 헬퍼 + 단위 테스트

**Files:**
- Test(먼저): `ui/src/runs/__tests__/liveSeries.test.ts` (신규)
- Create: `ui/src/runs/liveSeries.ts`

**Interfaces:**
- Consumes: `WindowSummary` (`ui/src/api/schemas.ts:223-230` — `{ts_second, step_id, count, error_count, status_counts}`)
- Produces (Task 2가 그대로 씀): `export type LiveSecond = { ts_second: number; count: number; errors: number }` · `export const LIVE_TRIM_TRAILING_SECONDS = 1` · `export function liveBySecond(windows: WindowSummary[]): LiveSecond[]`

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/runs/__tests__/liveSeries.test.ts` 신규(테스트 파일 먼저 = tdd-guard 통과 경로):

```ts
import { describe, expect, it } from "vitest";
import { liveBySecond } from "../liveSeries";
import type { WindowSummary } from "../../api/schemas";

// 기대 ts 값은 전부 하드코딩 리터럴 — LIVE_TRIM_TRAILING_SECONDS import 금지(자기참조 공허 차단, spec §7).
function w(
  ts_second: number,
  step_id: string,
  count: number,
  error_count: number,
): WindowSummary {
  return { ts_second, step_id, count, error_count, status_counts: {} };
}

describe("liveBySecond", () => {
  it("같은 초의 스텝 간 count·error를 합산하고 ts 오름차순으로 정렬한다", () => {
    const out = liveBySecond([
      w(101, "b", 5, 1),
      w(100, "a", 3, 0),
      w(100, "b", 7, 2),
      w(102, "a", 4, 0), // max_ts — 트림으로 제외
    ]);
    expect(out).toEqual([
      { ts_second: 100, count: 10, errors: 2 },
      { ts_second: 101, count: 5, errors: 1 },
    ]);
  });

  it("후미 트림: max_ts 초는 표시에서 제외된다", () => {
    const out = liveBySecond([w(100, "a", 1, 0), w(101, "a", 2, 0)]);
    expect(out).toEqual([{ ts_second: 100, count: 1, errors: 0 }]);
  });

  it("빈 입력은 빈 배열", () => {
    expect(liveBySecond([])).toEqual([]);
  });

  it("단일 초 입력은 전량 트림되어 빈 배열", () => {
    expect(liveBySecond([w(100, "a", 9, 3)])).toEqual([]);
  });

  it("무-트래픽 중간 초는 채우지 않는다 (리포트 bySecond와 동일 정책)", () => {
    const out = liveBySecond([w(100, "a", 1, 0), w(105, "a", 2, 1), w(106, "a", 3, 0)]);
    expect(out).toEqual([
      { ts_second: 100, count: 1, errors: 0 },
      { ts_second: 105, count: 2, errors: 1 },
    ]);
  });
});
```

- [ ] **Step 2: RED 확인** — Run: `cd ui && pnpm test liveSeries` (단일 파일 필터 — `--` 붙이면 전체 스위트가 도니 금지). Expected: FAIL — `Cannot find module '../liveSeries'` 류 5건.

- [ ] **Step 3: 구현** — `ui/src/runs/liveSeries.ts` 신규:

```ts
import type { WindowSummary } from "../api/schemas";

export type LiveSecond = { ts_second: number; count: number; errors: number };

// 최신 초는 멀티워커 도착 skew로 부분합일 수 있어 표시에서 제외 — 단일 워커 행은
// 도착 즉시 완성값이다(엔진 drain_completed는 지난 초만 내보낸다). spec N2.
export const LIVE_TRIM_TRAILING_SECONDS = 1;

// ts_second별 스텝 간 합산(워커 간 merge는 서버 선처리) + 오름차순 + 후미 트림.
// 무-트래픽 초는 채우지 않는다 — 리포트 bySecond와 동일 정책(라이브·리포트 궤적 일치).
export function liveBySecond(windows: WindowSummary[]): LiveSecond[] {
  if (windows.length === 0) return [];
  const buckets = new Map<number, LiveSecond>();
  let maxTs = windows[0].ts_second;
  for (const win of windows) {
    if (win.ts_second > maxTs) maxTs = win.ts_second;
    const cur = buckets.get(win.ts_second) ?? { ts_second: win.ts_second, count: 0, errors: 0 };
    cur.count += win.count;
    cur.errors += win.error_count;
    buckets.set(win.ts_second, cur);
  }
  const cutoff = maxTs - LIVE_TRIM_TRAILING_SECONDS;
  return Array.from(buckets.values())
    .filter((s) => s.ts_second <= cutoff)
    .sort((a, b) => a.ts_second - b.ts_second);
}
```

- [ ] **Step 4: GREEN 확인** — Run: `pnpm test liveSeries`. Expected: 5 passed.

- [ ] **Step 5: 트림 이빨 실증** — `liveSeries.ts`의 상수를 일시 `= 0`으로 수정 → `pnpm test liveSeries` → **케이스 1·2·4가 RED**(각각 3점째 등장/2점째 등장/1점 잔존) 확인 → `= 1`로 원복 → GREEN 재확인. 결과(RED 케이스 수)를 커밋 메시지가 아니라 작업 보고에 기록.

- [ ] **Step 6: 커밋**

```bash
git add ui/src/runs/liveSeries.ts ui/src/runs/__tests__/liveSeries.test.ts
git commit -m "feat(ui): liveBySecond — 라이브 초당 시리즈 도출(스텝 합산·후미 1s 트림) (live-rps-chart T1)"
```

pre-commit UI 게이트(lint+test+build)가 돈다 — 수 분 소요 정상. `git log -1`로 landed 확인.

---

### Task 2: ko 키 + RunDetailPage 라이브 섹션 + RTL 4케이스

**Files:**
- Test(먼저): `ui/src/pages/__tests__/RunDetailPage.test.tsx` (케이스 추가)
- Modify: `ui/src/i18n/ko.ts` (`runDetail` 네임스페이스, :1135 블록 안)
- Modify: `ui/src/pages/RunDetailPage.tsx` (import 2건 + 훅 구역 useMemo 1건 + else 가지 섹션 1블록)

**Interfaces:**
- Consumes: Task 1의 `liveBySecond`/`LiveSecond` · `TimeSeriesChart`(F5: `{title, data: {ts_second, value}[], yLabel}` — width/height 미전달 시 ResponsiveContainer) · `PageSection`(P2) · `ko.report.timeSeriesRequests`/`timeSeriesErrors`(F6)
- Produces: `ko.runDetail.liveSectionTitle = "라이브 궤적"` (라이브 검증·finish 문서가 참조)

- [ ] **Step 1: 실패하는 RTL 케이스 4건 추가** — `RunDetailPage.test.tsx` 말미에 새 describe. P1 헬퍼 재사용, fixture는 P3 패턴. **존재-단언(①③) fixture는 서로 다른 `ts_second` 2종**(트림이 max_ts를 제거하므로 1종이면 원리적으로 미렌더 — spec §7):

```tsx
describe("RunDetailPage — 라이브 궤적 섹션", () => {
  const liveWindows = [
    { ts_second: 100, step_id: "s1", count: 3, error_count: 0, status_counts: {} },
    { ts_second: 100, step_id: "s2", count: 2, error_count: 1, status_counts: {} },
    { ts_second: 101, step_id: "s1", count: 4, error_count: 0, status_counts: {} },
  ];

  function mockRun(status: string, windows: unknown[], report?: { body: unknown; status: number }) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/runs/R7") && (!init || init.method !== "POST")) {
        return Promise.resolve(
          jsonResponse({
            id: "R7",
            scenario_id: "S7",
            scenario_yaml: "version: 1\nname: t\nsteps: []\n",
            status,
            profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 5 },
            env: {},
            started_at: 1,
            ended_at: null,
            created_at: 1,
          }),
        );
      }
      if (url.endsWith("/api/runs/R7/metrics")) {
        return Promise.resolve(jsonResponse({ run_id: "R7", windows }));
      }
      if (url.endsWith("/api/runs/R7/report") && report) {
        return Promise.resolve(jsonResponse(report.body, report.status));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
  }

  it("① running + windows(2초 이상) → 섹션과 차트 region 2개가 보인다", async () => {
    mockRun("running", liveWindows);
    renderWithRouter("R7");
    const section = await screen.findByRole("region", { name: ko.runDetail.liveSectionTitle });
    expect(
      within(section).getByRole("region", {
        name: ko.report.timeSeriesAria(ko.report.timeSeriesRequests),
      }),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole("region", {
        name: ko.report.timeSeriesAria(ko.report.timeSeriesErrors),
      }),
    ).toBeInTheDocument();
  });

  it("④ running + windows 없음 → 섹션 미렌더", async () => {
    mockRun("running", []);
    renderWithRouter("R7");
    await screen.findByText(ko.runDetail.waitingFirstBatch);
    expect(
      screen.queryByRole("region", { name: ko.runDetail.liveSectionTitle }),
    ).not.toBeInTheDocument();
  });

  it("③ terminal + report 에러 + windows → 섹션이 남는다 (N4 수명 핀)", async () => {
    mockRun("failed", liveWindows, { body: { error: "boom" }, status: 500 });
    renderWithRouter("R7");
    await screen.findByRole("region", { name: ko.runDetail.liveSectionTitle });
  });
});
```

케이스 ②(terminal + report.data → 섹션 부재)는 기존 describe `"RunDetailPage — report on terminal"`의 fixture(`:583-655`, reportBundle)를 쓰는 **기존 it 안이 아니라 새 it**로 — 그 describe의 mock 구조를 복사하되 metrics 응답에 `liveWindows`를 넣고:

```tsx
expect(
  screen.queryByRole("region", { name: ko.runDetail.liveSectionTitle }),
).not.toBeInTheDocument();
```

(삼항 밖 호이스팅을 잡는 배치 이빨 — windows가 있는데도 ReportView 가지에선 안 떠야 한다.)

- [ ] **Step 2: RED 확인** — Run: `pnpm test RunDetailPage`. Expected: 신규 4건 FAIL(`liveSectionTitle` 미존재로 TS 에러 또는 region not found), 기존 케이스는 GREEN 유지.

- [ ] **Step 3: ko 키 추가** — `ui/src/i18n/ko.ts`의 `runDetail: {` 블록(:1135) 안에 한 줄:

```ts
    liveSectionTitle: "라이브 궤적",
```

- [ ] **Step 4: 양방향 포함관계 sweep 재실행** (F13 명령 verbatim):

```bash
python3 -c "import re;t=open('ui/src/i18n/ko.ts',encoding='utf-8').read();lits=set(re.findall(r'\"([^\"\n]+)\"',t));n='라이브 궤적';print([s for s in lits if s!=n and (s in n or n in s)])"
```

Expected: `[' ']` (공백 1글자 리터럴만 — 구조적 예외). 다른 값이 나오면 STOP하고 orchestrator에 보고.

- [ ] **Step 5: RunDetailPage 배선** — `ui/src/pages/RunDetailPage.tsx`:

① import 추가(기존 import 블록):

```tsx
import { TimeSeriesChart } from "../components/report/TimeSeriesChart";
import { liveBySecond } from "../runs/liveSeries";
```

② 훅 구역 — 기존 `stepTotals` useMemo(:78-88) 바로 아래, early return(:90-92) **위**:

```tsx
const liveSeconds = useMemo(() => liveBySecond(metrics.data?.windows ?? []), [metrics.data]);
```

③ else 가지 — `<EnvBlock env={r.env} />`(:261) **바로 앞**:

```tsx
{liveSeconds.length > 0 && (
  <PageSection
    ariaLabel={ko.runDetail.liveSectionTitle}
    title={ko.runDetail.liveSectionTitle}
    className="mb-6"
  >
    <TimeSeriesChart
      title={ko.report.timeSeriesRequests}
      yLabel="req/s"
      data={liveSeconds.map((s) => ({ ts_second: s.ts_second, value: s.count }))}
    />
    <TimeSeriesChart
      title={ko.report.timeSeriesErrors}
      yLabel="errors"
      data={liveSeconds.map((s) => ({ ts_second: s.ts_second, value: s.errors }))}
    />
  </PageSection>
)}
```

별도 status 게이트를 달지 말 것(N4 — 가지 위치가 게이트). `!terminal &&`를 추가하면 Step 1의 케이스 ③이 RED가 된다(그게 이 테스트의 존재 이유).

- [ ] **Step 6: GREEN 확인** — Run: `pnpm test RunDetailPage`. Expected: 신규 4건 포함 전부 PASS.

- [ ] **Step 7: 전체 게이트** — Run: `pnpm lint; echo "lint=$?"` → `pnpm test; echo "test=$?"` → `pnpm build; echo "build=$?"` (파이프 금지, exit 명시). Expected: 전부 0. test는 baseline 211 files 대비 +1 file(liveSeries) 이상.

- [ ] **Step 8: 커밋**

```bash
git add ui/src/i18n/ko.ts ui/src/pages/RunDetailPage.tsx ui/src/pages/__tests__/RunDetailPage.test.tsx
git commit -m "feat(ui): run 상세 라이브 궤적 섹션 — RPS·에러 시계열 2종, else 가지 수명 (live-rps-chart T2)"
```

---

### Task 3: ADR-0051 + 동반 문서 갱신

**Files:**
- Create: `docs/adr/0051-in-run-progress-chart.md`
- Modify: `docs/roadmap.md` (:147·:190 — 줄번호는 `grep -n`으로 재확정 후 편집)
- Modify: `CLAUDE.md` (루트 — line 9 문장 + "알아둘 결정들" 인덱스 끝)

**Interfaces:** Consumes: spec §6. Produces: ADR-0051(빌드로그·finish가 참조).

- [ ] **Step 1: ADR-0051 작성** — `docs/adr/0051-in-run-progress-chart.md`:

```markdown
# 0051. 실행 중 진행 차트 — in-run 1s windows의 클라이언트 표시 허용

- **상태**: Accepted
- **날짜**: 2026-08-03

## Context

ADR-0009는 MVP에서 라이브 대시보드를 제외하며 후속 한도를 "옵션 2 정도(진행률·현재 RPS·에러 카운트 수치만, 차트는 종료 후)"로 남겼다. 도그푸딩에서 그 한도의 비용이 드러났다: run 진행 중 Run 상세엔 누적 평균 카드뿐이라, 사람이 계속 지켜보지 않으면 부하가 어떻게 변했는지(ramp-up 상승·정체·에러 시작 시점) 알 수 없다. 한편 데이터는 이미 전부 있다 — 워커가 1s 윈도우를 사전 집계(ADR-0012)해 컨트롤러 SQLite에 영속하고, UI는 `/api/runs/{id}/metrics`를 이미 1초마다 폴링 중이며, 리포트용 recharts도 이미 번들에 있다.

## Decision

**이미 수집·영속되고 이미 폴링 중인 1s windows의 클라이언트 표시(in-run 진행 차트)를 허용한다.** 이는 ADR-0009의 "후속은 옵션 2 정도" 한 줄을 supersede하는 확장이다(차트가 실행 중에 뜬다). ADR-0009의 나머지는 전부 유지: WebSocket/SSE·서버 push·시계열 DB·전용 라이브 대시보드·APM 대체는 계속 비목표다. 이 기능은 신규 데이터 경로도 신규 라이브러리도 만들지 않는다 — 서버/proto/스토어 0-diff.

구현: `liveBySecond` 순수 헬퍼(스텝 간 합산·후미 1초 트림 — 멀티워커 도착 skew가 유일한 부분합 벡터, 엔진 flush는 완성 초만 전송) + `RunDetailPage` else 가지에 `TimeSeriesChart` 2종(RPS·에러). 설계: `docs/superpowers/specs/2026-08-03-live-rps-chart-design.md`.

## Consequences

**Positive**: 실행 중 궤적 가시성(자리 비움 후 복귀 시 전체 이력) · 에러 시작 시점의 실시간 파악(중단 판단) · 라이브·리포트가 같은 1s windows 기반이라 사후 분석과 연속.

**Negative / Trade-offs**: 최신 1초는 트림되어 표시가 1초 늦다 · 트래픽 정체 시 마지막 실데이터 1초가 숨는다(stall 배너가 상보) · 레이턴시(p50/p95) 라이브는 여전히 불가(windows에 없음 — 수요 확인 후 별도 결정).
```

- [ ] **Step 2: roadmap.md 2줄 갱신** — `grep -n "라이브 대시보드" docs/roadmap.md`로 두 줄 재확정 후:

:147 (구) `- 라이브 대시보드 (§4.5) — **ADR-0009로 MVP 범위에서 영구 제외**(종료 후 리포트 + APM). 되살리려면 ADR 재검토부터.`
:147 (신) `- 라이브 대시보드 (§4.5) — 스트리밍 인프라·전용 대시보드는 **ADR-0009로 계속 제외**(종료 후 리포트 + APM). 단 in-run 진행 차트(기존 1s 폴링 데이터의 클라 표시)는 **ADR-0051로 허용·출하**(live-rps-chart).`

:190 (구) `**명시적 비목표(가짜 차별화)**: 라이브 대시보드 경쟁(ADR-0009), 프로토콜 수집형 확장, AI 시나리오 양산만(신뢰·리뷰 없이), RPS 벤치 자랑 단독.`
:190 (신) `**명시적 비목표(가짜 차별화)**: 라이브 대시보드 경쟁(ADR-0009 — in-run 진행 차트만 ADR-0051로 허용), 프로토콜 수집형 확장, AI 시나리오 양산만(신뢰·리뷰 없이), RPS 벤치 자랑 단독.`

- [ ] **Step 3: 루트 CLAUDE.md 2곳** —

line 9 (구) `라이브 대시보드는 MVP 범위 자체에서 제외(ADR-0009 — 종료 후 HTML/JSON 리포트로 충분, 실시간은 APM 사용).`
line 9 (신) `라이브 대시보드는 MVP 범위 자체에서 제외(ADR-0009 — 종료 후 HTML/JSON 리포트로 충분, 실시간은 APM 사용; in-run 진행 차트만 ADR-0051로 허용 — 기존 1s 폴링 데이터의 클라 표시).`

"알아둘 결정들" 인덱스 끝(0050 다음)에:

```markdown
- **0051** 실행 중 진행 차트: 이미 폴링 중인 1s windows의 클라 표시 허용 (ADR-0009 "후속은 옵션 2" 한도 supersede, 스트리밍 인프라·라이브 대시보드는 계속 비목표)
```

- [ ] **Step 4: 커밋** (docs-only fast path)

```bash
git add docs/adr/0051-in-run-progress-chart.md docs/roadmap.md CLAUDE.md
git commit -m "docs(adr): ADR-0051 실행 중 진행 차트 — ADR-0009 후속-한도 supersede + roadmap·인덱스 동반 갱신 (live-rps-chart T3)"
```

---

## 머지 전 검증 (task 아님 — orchestrator 직접)

1. **최종 whole-branch 리뷰**: `handicap-reviewer` APPROVE (BASE = implementer 디스패치 직전 커밋, `HEAD~1` 금지).
2. **보안 표면 게이트**: `finish-slice` §0 grep이 지배 — diff는 `ui/src`+docs뿐이라 N/A 예상이지만 grep을 **직접 돌려** 판정.
3. **라이브 검증** (`/live-verify`, spec §7 표 verbatim — US1·US2·US3·N4 4행): 워크트리 자체 바이너리(`cargo build -p handicap-worker --bin worker` + `cargo build -p handicap-controller --bin controller`) → `just ui-build`로 fresh dist → `./target/debug/controller --db /tmp/live-rps-chart.db --ui-dir ui/dist --rest 127.0.0.1:8095 --grpc 127.0.0.1:8094`(8080 회피) → python responder. US2는 도중부터 5xx 섞는 responder 필요(레시피의 무-로깅 responder로 충분 — 요청 내용 검증 아님).
4. `just doc-coverage` / `just doc-budget` (finish-slice §5에서도 돌지만 T3가 루트 CLAUDE.md를 건드리므로 선제 확인).

## Self-review 기록 (plan 작성 시점)

- spec 커버리지: N1~N3→T1, N4~N7→T2, §6→T3, §7 단위/RTL→T1·T2 step, §7 라이브→검증 §3. US1/US2=T2 섹션 렌더, US3=검증 §3 표. 갭 없음.
- placeholder 스캔: TBD/TODO/"적절히" 없음 — 전 코드 스텝에 실제 코드 포함.
- 타입 일관성: `LiveSecond`/`liveBySecond` 시그니처가 T1 Produces ↔ T2 Consumes 1:1. `WindowSummary` fixture 필드는 F2와 일치.
- tdd-guard 시뮬레이션: T1 Step1=테스트 파일(항상 허용), T2 Step1=테스트 파일 → 이후 src 편집 시 pending test 존재. T3는 docs-only(가드 밖).

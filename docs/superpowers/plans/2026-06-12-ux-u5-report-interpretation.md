# U5 — 리포트 해석 (영역 U §7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 초보 QA가 run 결과 화면에서 "합격인가, 문제는 어느 스텝인가"를 스스로 판단하게 — 쉬운 요약 헤더(§7.1), 통계 용어 해설 잔여 표면(§7.2), 인사이트 행동화(§7.3), running 진단 힌트(§7.4), VerdictBadge FAIL popover(§7.5).

**Architecture:** 전부 UI-only(엔진·컨트롤러·proto·migration 무변경, ADR-0035 범위). 신규 문구는 전부 `ko.ts` 카탈로그 경유 — 매개변수 문장은 **함수 상수**(spec §2.1 명시: `ko.report.summaryLine(...)`). §7.1은 `ReportRunSchema.profile`이 `z.unknown()`이라 RunDetailPage가 이미 가진 typed profile을 ReportView **prop으로 전달**(재파싱 금지, spec §7.1). §7.5는 HelpTip의 popover 로직을 `usePopover` 훅으로 추출해 공유(HelpTip 기존 테스트 무수정 통과 = 리팩터 안전망).

**Tech Stack:** React + TS + Tailwind, vitest + RTL, Zod (스키마 무변경 — 읽기만).

**워크트리:** `/Users/sgj/develop/handicap/.claude/worktrees/ux-u5-report-interpretation` (모든 작업·커밋은 여기서)

**spec:** `docs/superpowers/specs/2026-06-11-ux-beginner-friendly-redesign-design.md` §7 (+§2.1–2.3, §8 U5 행)

---

## 전역 규칙 (모든 task 공통)

- **UI-only 슬라이스**: pre-commit hook의 cargo 게이트는 skip되지만(2026-06-11 fast-path) UI 게이트는 hook 밖 수동 — **매 task 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build` 셋 다 실행**(`pnpm lint`는 `--max-warnings=0`, `pnpm build`=`tsc -b`가 최종 타입 게이트).
- **tdd-guard**: src 파일을 만지기 전에 그 task의 테스트 파일(`__tests__/*.test.tsx`)을 먼저 작성/수정해 pending test diff를 만든다. 각 task의 Step 1이 항상 테스트 파일이다.
- **`pnpm test <이름>`으로 단일 파일 반복** (`--` 붙이면 전체 스위트가 도니 금지), 커밋 전엔 인자 없는 전체 `pnpm test` 1회.
- **커밋은 명시 경로 `git add`** (`-A` 금지), 파이프 없이 foreground 단일 호출, 직후 `git log -1`로 landed 확인.
- 타임스탬프(`started_at`/`created_at`)는 **ms epoch**(컨트롤러 `now_ms()`) — 초로 나누는 곳에서 `/1000`.
- 기존 테스트 취급 2부류(spec §6.6 준용): **구조/동작 단언은 무수정 통과**, **영어 라벨·문구 단언만 새 카탈로그 문구로 갱신 허용**. 예외 1: 동작 의미를 보존하는 **셀렉터 스코프 좁히기**는 허용 — 예: 새 ⓘ 버튼 추가로 `queryByRole("button")` 광역 부재 단언이 깨지면 `{ name: /Toggle loop breakdown/ }`로 좁혀 원래 의도(브레이크다운 caret 부재)를 유지.

## File Structure (전체 조망)

| 파일 | 책임 | Task |
|---|---|---|
| `ui/src/i18n/ko.ts` | `report`(헤드라인 함수 상수·verdict 콜아웃·SLO 힌트·요약 카드 라벨·스텝 표 라벨·FAIL popover 제목), `insightActions`, `runDetail` 네임스페이스 추가 | 1,2,3,4,5 |
| `ui/src/i18n/duration.ts` (신규) | `formatDurationKo(seconds)`("1분 30초"), `formatSecondsKo(ms)`("0.21초") 순수 포매터 | 1 |
| `ui/src/components/report/ReportHeadline.tsx` (신규) | §7.1 쉬운 요약 헤더(한 문장 + verdict 크게/SLO 힌트) — 순수 프레젠테이셔널 | 1 |
| `ui/src/components/report/ReportView.tsx` | `profile: Profile` prop 추가 + `<ReportHeadline>` 최상단 배치 | 1 |
| `ui/src/pages/RunDetailPage.tsx` | ReportView에 `normalizeProfile(r.profile)` 전달(T1) + stalled 배너(T4) | 1,4 |
| `ui/src/components/report/Summary.tsx` | 카드 라벨 한국어화 + 평균 RPS·드롭 HelpTip | 2 |
| `ui/src/components/report/StepStatsTable.tsx` | 헤더 한국어화 + p50/p95/p99 HelpTip | 2 |
| `ui/src/components/report/GroupLatencyTable.tsx` | 헤더 한국어화 + p50/p95/p99 HelpTip (U1a 인계 "나머지 표면") | 2 |
| `ui/src/components/report/BranchStatsTable.tsx` | 헤더 한국어화 (U1a 인계 "나머지 표면") | 2 |
| `ui/src/components/report/InsightPanel.tsx` | kind별 "다음 행동" 줄 | 3 |
| `ui/src/hooks/useNow.ts` (신규) | `useNow(intervalMs | null)` 시계 틱 훅(신규 fetch 없음) | 4 |
| `ui/src/pages/ScenarioRunsPage.tsx` | running 행 경과 시간 | 4 |
| `ui/src/components/usePopover.ts` (신규) | HelpTip에서 추출한 클릭 popover 공통 로직(ESC/외부 클릭/edge-flip) | 5 |
| `ui/src/components/HelpTip.tsx` | usePopover 사용으로 리팩터(동작 불변) | 5 |
| `ui/src/components/VerdictBadge.tsx` | FAIL title → 클릭 popover(미달 기준 목록) | 5 |

**의도적 범위 밖(연기 — 머지 시 roadmap §A8에 기록)**: 리포트 섹션 h3·aria-label 영어(Report/Summary/Steps/Page load latency/Branch decisions/Latency/Status codes — §7.2 문언은 "표 헤더"라 섹션 제목은 밖)·TimeSeriesChart 제목·다운로드 버튼 라벨·RunDetailPage 라이브 카드·run 목록 컬럼 헤더 한국어화(ko.common 도입 시 일괄 — U2/U3 연기 패턴과 정합), HelpTip Modal-내 ESC 레이어링(현 소비처 전부 Modal 밖 — usePopover 주석으로 문서화만), verdict 필터/정렬(B6 연기 유지).

---

### Task 1: §7.1 쉬운 요약 헤더 (`ReportHeadline`)

**Files:**
- Create: `ui/src/i18n/duration.ts`
- Create: `ui/src/i18n/__tests__/duration.test.ts`
- Create: `ui/src/components/report/ReportHeadline.tsx`
- Create: `ui/src/components/report/__tests__/ReportHeadline.test.tsx`
- Modify: `ui/src/i18n/ko.ts` (`report` 네임스페이스 추가)
- Modify: `ui/src/components/report/ReportView.tsx` (prop + 최상단 렌더)
- Modify: `ui/src/components/report/__tests__/ReportView.test.tsx` (render 사이트에 profile 추가)
- Modify: `ui/src/pages/RunDetailPage.tsx` (prop 전달 1줄)

**컨텍스트:** `ReportRunSchema.profile`은 `z.unknown()`이라 직접 못 읽는다 — RunDetailPage의 `run.data.profile`(typed)을 prop으로 내린다(spec §7.1 명시). `Run["profile"]`은 Zod 중첩 `.default()` input 누출(`ramp_up_seconds?: number|undefined`)로 `Profile`에 직접 대입 불가 — **`normalizeProfile()`(=`ProfileSchema.parse`, `ui/src/api/runPrefill.ts` 기존 헬퍼)로 감싸 전달**한다(RunDetailPage가 이미 import 중). 문장 길이는 `summary.duration_seconds`(리포트 실측)를 쓴다 — 곡선 run의 `profile.duration_seconds=0` 함정을 자연 회피. spec "페이지 최상단에 크게"의 해석: ReportHeadline은 **리포트 표면의 최상단**(그 위 RunDetailPage 헤더 h2엔 기존 VerdictBadge가 페이지-상단 배지 역할 유지) — RunDetailPage 라이브 카드 영역은 terminal 시 리포트로 대체되므로 사실상 결과 화면 최상단이다.

- [ ] **Step 1: 테스트 파일 2개 먼저 작성 (tdd-guard unblock + RED)**

`ui/src/i18n/__tests__/duration.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatDurationKo, formatSecondsKo } from "../duration";

describe("formatDurationKo", () => {
  it("초 단위", () => expect(formatDurationKo(30)).toBe("30초"));
  it("정확히 1분", () => expect(formatDurationKo(60)).toBe("1분"));
  it("분+초 조합", () => expect(formatDurationKo(90)).toBe("1분 30초"));
  it("시간+분", () => expect(formatDurationKo(3900)).toBe("1시간 5분"));
  it("0초", () => expect(formatDurationKo(0)).toBe("0초"));
  it("음수는 0초로 clamp", () => expect(formatDurationKo(-5)).toBe("0초"));
  it("소수 입력은 floor", () => expect(formatDurationKo(90.9)).toBe("1분 30초"));
});

describe("formatSecondsKo", () => {
  it("1초 미만은 소수 2자리", () => expect(formatSecondsKo(210)).toBe("0.21초"));
  it("1~10초는 소수 1자리", () => expect(formatSecondsKo(1234)).toBe("1.2초"));
  it("10초 이상은 정수", () => expect(formatSecondsKo(12345)).toBe("12초"));
  it("0ms", () => expect(formatSecondsKo(0)).toBe("0.00초"));
});
```

`ui/src/components/report/__tests__/ReportHeadline.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ReportHeadline } from "../ReportHeadline";
import type { Profile, ReportSummary } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";

const SUMMARY: ReportSummary = {
  count: 12345,
  errors: 37,
  rps: 205.7,
  duration_seconds: 60,
  p50_ms: 80,
  p95_ms: 210,
  p99_ms: 450,
};

const CLOSED: Profile = {
  vus: 50,
  ramp_up_seconds: 0,
  duration_seconds: 60,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
  measure_phases: false,
};

describe("ReportHeadline", () => {
  it("closed-loop 문장: 시간·VU·요청수·p95·에러율", () => {
    render(<ReportHeadline summary={SUMMARY} profile={CLOSED} verdict={null} />);
    const region = screen.getByRole("region", { name: "쉬운 요약" });
    expect(region).toHaveTextContent(
      "1분 동안 동시 사용자 50명이 12,345회 요청 — 95%가 0.21초 안에 응답, 에러 0.3%",
    );
  });

  it("open-loop(고정 rate) 문장은 목표 RPS 변형", () => {
    render(
      <ReportHeadline
        summary={SUMMARY}
        profile={{ ...CLOSED, target_rps: 100 }}
        verdict={null}
      />,
    );
    expect(screen.getByRole("region", { name: "쉬운 요약" })).toHaveTextContent(
      "목표 100 RPS로 12,345회 요청",
    );
  });

  it("open-loop(stages 곡선) 문장은 곡선 변형", () => {
    render(
      <ReportHeadline
        summary={SUMMARY}
        profile={{ ...CLOSED, stages: [{ target: 50, duration_seconds: 30 }] }}
        verdict={null}
      />,
    );
    expect(screen.getByRole("region", { name: "쉬운 요약" })).toHaveTextContent(
      "단계별 RPS 곡선으로 12,345회 요청",
    );
  });

  it("verdict 있으면 합격/불합격을 크게 표시", () => {
    render(<ReportHeadline summary={SUMMARY} profile={CLOSED} verdict={{ passed: true, criteria: [] }} />);
    expect(screen.getByText(ko.report.verdictPass)).toBeInTheDocument();
    expect(screen.queryByText(ko.report.sloHint)).toBeNull();
  });

  it("verdict 불합격", () => {
    render(<ReportHeadline summary={SUMMARY} profile={CLOSED} verdict={{ passed: false, criteria: [] }} />);
    expect(screen.getByText(ko.report.verdictFail)).toBeInTheDocument();
  });

  it("verdict 없으면 SLO 발견성 한 줄", () => {
    render(<ReportHeadline summary={SUMMARY} profile={CLOSED} verdict={null} />);
    expect(screen.getByText(ko.report.sloHint)).toBeInTheDocument();
  });

  it("요청 0건이면 별도 문구", () => {
    render(
      <ReportHeadline
        summary={{ ...SUMMARY, count: 0, errors: 0 }}
        profile={CLOSED}
        verdict={null}
      />,
    );
    expect(screen.getByText(ko.report.headlineNoRequests)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test duration && pnpm test ReportHeadline`
Expected: 두 파일 모두 FAIL (모듈 없음).

- [ ] **Step 3: `ui/src/i18n/duration.ts` 구현**

```ts
/** 초 → "1시간 5분" / "1분 30초" / "30초" (한국어 자연 표기, 음수는 0초). */
export function formatDurationKo(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}시간`);
  if (m > 0) parts.push(`${m}분`);
  if (sec > 0 || parts.length === 0) parts.push(`${sec}초`);
  return parts.join(" ");
}

/** ms → 초 단위 사람 표기. 1초 미만 "0.21초", 10초 미만 "1.2초", 그 이상 "12초". */
export function formatSecondsKo(ms: number): string {
  const s = ms / 1000;
  if (s < 1) return `${s.toFixed(2)}초`;
  if (s < 10) return `${s.toFixed(1)}초`;
  return `${Math.round(s)}초`;
}
```

- [ ] **Step 4: `ko.ts`에 `report` 네임스페이스 추가** (`templates` 블록 뒤, `} as const` 직전)

```ts
  report: {
    // §7.1 쉬운 요약 — 매개변수 문구는 함수 상수(spec §2.1). 숫자는 호출부에서
    // en-US toLocaleString으로 고정(천단위 콤마 결정성 — InsightPanel 전례).
    headlineClosed: (p: { duration: string; vus: number; count: string; p95: string; errPct: string }) =>
      `${p.duration} 동안 동시 사용자 ${p.vus}명이 ${p.count}회 요청 — 95%가 ${p.p95} 안에 응답, 에러 ${p.errPct}`,
    headlineOpenFixed: (p: { duration: string; targetRps: number; count: string; p95: string; errPct: string }) =>
      `${p.duration} 동안 목표 ${p.targetRps} RPS로 ${p.count}회 요청 — 95%가 ${p.p95} 안에 응답, 에러 ${p.errPct}`,
    headlineOpenCurve: (p: { duration: string; count: string; p95: string; errPct: string }) =>
      `${p.duration} 동안 단계별 RPS 곡선으로 ${p.count}회 요청 — 95%가 ${p.p95} 안에 응답, 에러 ${p.errPct}`,
    headlineNoRequests: "요청이 기록되지 않았습니다 — 시나리오 URL과 워커 상태를 확인하세요.",
    headlineAria: "쉬운 요약",
    verdictPass: "합격",
    verdictFail: "불합격",
    sloHint: "합격 기준(SLO)을 설정하면 다음 실행부터 합격/불합격을 자동 판정합니다.",
  },
```

- [ ] **Step 5: `ReportHeadline.tsx` 구현**

```tsx
import type { Profile, ReportSummary, Verdict } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { formatDurationKo, formatSecondsKo } from "../../i18n/duration";

type Props = {
  summary: ReportSummary;
  profile: Profile;
  verdict: Verdict | null | undefined;
};

/** §7.1 쉬운 요약 헤더 — 리포트 최상단 한 문장 + verdict 콜아웃(클라 파생, 백엔드 무변경). */
export function ReportHeadline({ summary, profile, verdict }: Props) {
  const common = {
    duration: formatDurationKo(summary.duration_seconds),
    count: summary.count.toLocaleString("en-US"),
    p95: formatSecondsKo(summary.p95_ms),
    errPct: `${summary.count === 0 ? "0" : ((summary.errors / summary.count) * 100).toFixed(1)}%`,
  };
  const isCurve = (profile.stages?.length ?? 0) > 0;
  const sentence =
    summary.count === 0
      ? ko.report.headlineNoRequests
      : profile.target_rps != null
        ? ko.report.headlineOpenFixed({ ...common, targetRps: profile.target_rps })
        : isCurve
          ? ko.report.headlineOpenCurve(common)
          : ko.report.headlineClosed({ ...common, vus: profile.vus });

  return (
    <section aria-label={ko.report.headlineAria} className="mb-6">
      {verdict ? (
        <div
          className={[
            "mb-1 text-2xl font-bold",
            verdict.passed ? "text-emerald-700" : "text-red-700",
          ].join(" ")}
        >
          {verdict.passed ? ko.report.verdictPass : ko.report.verdictFail}
        </div>
      ) : (
        <p className="mb-1 text-sm text-slate-500">{ko.report.sloHint}</p>
      )}
      <p className="text-base text-slate-800">{sentence}</p>
    </section>
  );
}
```

- [ ] **Step 6: `ReportView.tsx` 배선**

import에 `ReportHeadline`·`Profile` 타입 추가, props 확장, 최상단(다운로드 버튼 행보다 위) 렌더:

```tsx
import type { Profile, Report } from "../../api/schemas";
import { ReportHeadline } from "./ReportHeadline";

type Props = { report: Report; profile: Profile };

export function ReportView({ report, profile }: Props) {
  // …기존 useMemo들 무변경…
  return (
    <div>
      <ReportHeadline summary={report.summary} profile={profile} verdict={report.verdict} />
      <div className="flex items-center justify-between mb-4">{/* 기존 Report h3 + 다운로드 버튼 행 */}</div>
      {/* …이하 기존 그대로… */}
```

- [ ] **Step 7: `RunDetailPage.tsx` prop 전달**

```tsx
// 기존: <ReportView report={report.data} />
<ReportView report={report.data} profile={normalizeProfile(r.profile)} />
```

(`normalizeProfile`은 이미 import돼 있음 — Zod 중첩 `.default()` input 누출을 경계에서 collapse.)

- [ ] **Step 8: `ReportView.test.tsx`의 render 사이트에 profile 추가**

파일 상단에 fixture 추가 후, 모든 `render(<ReportView report={…} />)`(11곳)를 `render(<ReportView report={…} profile={TEST_PROFILE} />)`로 기계적 치환:

```tsx
import type { Profile } from "../../../api/schemas";

const TEST_PROFILE: Profile = {
  vus: 1,
  ramp_up_seconds: 0,
  duration_seconds: 2,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
  measure_phases: false,
};
```

새 단언 1개 추가(헤드라인이 떴는지):

```tsx
it("쉬운 요약 헤더가 최상단에 렌더된다", () => {
  render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
  expect(screen.getByRole("region", { name: "쉬운 요약" })).toBeInTheDocument();
});
```

- [ ] **Step 9: GREEN 확인 + 전체 게이트**

Run: `cd ui && pnpm test duration && pnpm test ReportHeadline && pnpm test ReportView && pnpm test RunDetailPage`
Expected: 전부 PASS (RunDetailPage 기존 테스트는 무수정 통과 — ReportView 호출이 prop만 늘었고 fixture run에 profile이 이미 있음).
Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0 경고, 전체 스위트 PASS, `tsc -b` clean.

- [ ] **Step 10: Commit**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/ux-u5-report-interpretation
git add ui/src/i18n/duration.ts ui/src/i18n/__tests__/duration.test.ts \
  ui/src/components/report/ReportHeadline.tsx \
  ui/src/components/report/__tests__/ReportHeadline.test.tsx \
  ui/src/i18n/ko.ts ui/src/components/report/ReportView.tsx \
  ui/src/components/report/__tests__/ReportView.test.tsx ui/src/pages/RunDetailPage.tsx
git commit -m "feat(ui): report easy-summary headline with verdict callout (U5 §7.1)"
git log -1 --oneline
```

---

### Task 2: §7.2 결과 표면(Summary 카드 + 표 3종) 한국어화 + 용어 HelpTip 잔여

**Files:**
- Modify: `ui/src/i18n/ko.ts` (`report` 네임스페이스에 라벨 키 추가)
- Modify: `ui/src/components/report/Summary.tsx`
- Modify: `ui/src/components/report/__tests__/Summary.test.tsx`
- Modify: `ui/src/components/report/StepStatsTable.tsx`
- Modify: `ui/src/components/report/__tests__/StepStatsTable.test.tsx`
- Modify: `ui/src/components/report/GroupLatencyTable.tsx`
- Modify: `ui/src/components/report/__tests__/GroupLatencyTable.test.tsx`
- Modify: `ui/src/components/report/BranchStatsTable.tsx`

**컨텍스트:** U1a가 Summary 카드 p50/p95/p99 HelpTip을 핀으로 출하했고 "StepStatsTable **등 나머지 표면**은 U5 잔여"로 남겼다 — 잔여 표면 = StepStatsTable + GroupLatencyTable + BranchStatsTable 3종 전부. 이번에 ① Summary 카드 영어 라벨 한국어화("Total requests"→"총 요청" 등) + 평균 RPS·드롭 카드에 HelpTip 추가(`ko.glossary.rps`/`ko.glossary.maxInFlight` **기존 항목 재사용** — 새 용어 정의 금지, 단일 소스), ② 표 3종 헤더 한국어화 + p50/p95/p99 컬럼 헤더 HelpTip(StepStatsTable·GroupLatencyTable — BranchStatsTable엔 레이턴시 컬럼이 없어 HelpTip 불요). p50/p95/p99/max 라벨 자체는 고유명사라 원어 유지(`p50 ms` — 단위-헤더 컨벤션 유지). **HelpTip을 `<th>` 안에 두는 것은 허용** — U3의 "h3/legend 안 금지" 규칙은 그룹-라벨 요소의 accessible name 오염 건이고, columnheader는 인터랙티브 콘텐츠 포함이 표준 동작. **단 columnheader accessible name에 버튼 라벨이 합쳐지므로**(`"p95 ms"` → `"p95 ms p95 설명"`) `getByRole("columnheader", { name: "p95 ms" })` **정확 매치 단언은 regex로 갱신해야 한다**(`GroupLatencyTable.test.tsx:28`이 해당 — 아래 Step 1). 섹션 h3("Summary"/"Steps"/"Page load latency"/"Branch decisions")·section aria-label·ReportView "Report" h3·다운로드 버튼 라벨은 **이번 범위 밖**(ko.common 일괄 연기 — §7.2 문언은 "표 헤더").

- [ ] **Step 1: 기존 테스트를 새 라벨 기준으로 갱신 (RED 먼저)**

`Summary.test.tsx` — 라벨 단언만 치환(구조 단언 유지). 이 파일의 fixture 상수명은 `baseSummary` 등 실파일 기준으로 맞출 것:
- `:33` `toHaveTextContent("Target RPS")` → `toHaveTextContent("목표 RPS")`, `:35` `toHaveTextContent("Dropped")` → `toHaveTextContent("드롭")`
- `"도움말이 없는 카드(Total requests 등)엔 도움말 버튼이 없다"` 테스트 →
  ```tsx
  it("도움말이 없는 카드(총 요청·에러·테스트 시간)엔 도움말 버튼이 없다", () => {
    render(<Summary summary={SUMMARY} />);
    expect(screen.queryByRole("button", { name: "총 요청 설명" })).toBeNull();
    expect(screen.queryByRole("button", { name: "에러 설명" })).toBeNull();
    expect(screen.queryByRole("button", { name: "테스트 시간 설명" })).toBeNull();
  });
  ```
- 신규 테스트 추가:
  ```tsx
  it("평균 RPS 카드에 RPS 용어 도움말이 있다", async () => {
    const user = userEvent.setup();
    render(<Summary summary={SUMMARY} />);
    await user.click(screen.getByRole("button", { name: "평균 RPS 설명" }));
    expect(screen.getByRole("note")).toHaveTextContent("초당 요청 수");
  });

  it("open-loop 카드(목표 RPS·드롭) 라벨이 한국어이고 드롭에 도움말이 있다", () => {
    render(<Summary summary={SUMMARY} dropped={5} targetRps={100} />);
    expect(screen.getByText("목표 RPS")).toBeInTheDocument();
    expect(screen.getByText("드롭")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "드롭 설명" })).toBeInTheDocument();
  });
  ```

`StepStatsTable.test.tsx` — 의도-보존 스코프 좁히기 1건 + 신규 테스트(기존 "다운로드 p50 ms" 등 헤더 단언은 무수정):
- `:88` `expect(screen.queryByRole("button")).not.toBeInTheDocument()` ("breakdown 비면 caret 없음") — 헤더 ⓘ 버튼 3개가 생기므로 광역 부재 단언이 깨진다. 원래 의도(브레이크다운 토글 caret 부재)를 보존해 좁힌다:
  ```tsx
  expect(screen.queryByRole("button", { name: /Toggle loop breakdown/ })).not.toBeInTheDocument();
  ```

신규 테스트 추가:

```tsx
it("표 헤더가 한국어이고 p50/p95/p99에 용어 도움말이 있다", async () => {
  const user = userEvent.setup();
  render(<StepStatsTable steps={STEPS} meta={META} />);
  expect(screen.getByText("스텝")).toBeInTheDocument();
  expect(screen.getByText("메서드")).toBeInTheDocument();
  expect(screen.getByText("요청 수")).toBeInTheDocument();
  expect(screen.getByText("에러")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "p95 설명" }));
  expect(screen.getByRole("note")).toHaveTextContent("95%");
});
```

(Summary·StepStatsTable 두 파일 모두 기존 fixture 이름이 plan 예시와 다르면 그 파일의 실제 상수를 사용할 것 — StepStatsTable은 fixture가 인라인이다. `userEvent` import가 없으면 추가: `import userEvent from "@testing-library/user-event";`)

`GroupLatencyTable.test.tsx` — 라벨/접근성 단언 갱신 + 신규:
- `:28` `getByRole("columnheader", { name: "p95 ms" })` → `{ name: /p95 ms/ }` (HelpTip 버튼 라벨이 accname에 합쳐짐 — 정확 매치 불가)
- 신규:
  ```tsx
  it("헤더가 한국어이고 p95에 용어 도움말이 있다", async () => {
    const user = userEvent.setup();
    render(<GroupLatencyTable breakdown={[GROUP]} meta={META} />);
    expect(screen.getByText("동시 실행 노드 / 분기")).toBeInTheDocument();
    expect(screen.getByText("횟수")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "p95 설명" })[0]);
    expect(screen.getByRole("note")).toHaveTextContent("95%");
  });
  ```
  (fixture 상수명은 실파일 기준. 같은 화면에 StepStatsTable의 "p95 설명" 버튼이 공존하는 건 ReportView 통합 시이고 이 단위 테스트에선 1개지만, 방어적으로 `getAllByRole(...)[0]` 사용 — U3 "동일-화면 aria-label 2개" 함정.)

`BranchStatsTable` 테스트는 헤더 단언이 없어(행 콘텐츠만) **무수정 통과** — 신규 헤더 단언 1개만 추가:
```tsx
expect(screen.getByText("조건(if) 노드")).toBeInTheDocument();
expect(screen.getByText("분기 결정 수")).toBeInTheDocument();
```
(기존 "renders one row per if-node" 테스트 안에 합류시켜도 좋다.)

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test Summary && pnpm test StepStatsTable && pnpm test GroupLatencyTable && pnpm test BranchStatsTable`
Expected: 새/갱신 단언이 FAIL ("총 요청" 없음 등).

- [ ] **Step 3: `ko.ts` `report` 네임스페이스에 라벨 키 추가**

```ts
    // §7.2 결과 표면 라벨 (Summary 카드 + 스텝 표 헤더)
    cardTotalRequests: "총 요청",
    cardErrors: "에러",
    cardAvgRps: "평균 RPS",
    cardDuration: "테스트 시간",
    cardTargetRps: "목표 RPS",
    cardDropped: "드롭",
    colStep: "스텝",
    colMethod: "메서드",
    colRequests: "요청 수",
    colErrors: "에러",
    colCount: "횟수",
    colParallelNode: "동시 실행 노드 / 분기",
    colIfNode: "조건(if) 노드",
    colDecisions: "분기 결정 수",
    colBranch: "분기",
    colDecisionsInner: "결정 수",
```

- [ ] **Step 4: `Summary.tsx` 라벨 교체 + HelpTip 확장**

```tsx
import { ko } from "../../i18n/ko";

export function Summary({ summary, dropped, targetRps }: Props) {
  const cards: Array<{ label: string; value: string; help?: string }> = [
    { label: ko.report.cardTotalRequests, value: summary.count.toLocaleString() },
    { label: ko.report.cardErrors, value: summary.errors.toLocaleString() },
    { label: ko.report.cardAvgRps, value: summary.rps.toFixed(1), help: ko.glossary.rps },
    { label: ko.report.cardDuration, value: `${summary.duration_seconds}s` },
    { label: "p50", value: `${summary.p50_ms} ms`, help: ko.glossary.p50 },
    { label: "p95", value: `${summary.p95_ms} ms`, help: ko.glossary.p95 },
    { label: "p99", value: `${summary.p99_ms} ms`, help: ko.glossary.p99 },
  ];

  if (targetRps != null) {
    // …dropRate 계산 기존 그대로…
    cards.push(
      { label: ko.report.cardTargetRps, value: targetRps.toLocaleString() },
      {
        label: ko.report.cardDropped,
        value: `${droppedCount.toLocaleString()} (${dropPct}%)`,
        // 드롭 정의는 max in-flight 용어 정의가 단일 소스(초과분 drop 집계 설명 포함)
        help: ko.glossary.maxInFlight,
      },
    );
  }
  // …렌더 기존 그대로(c.help && <HelpTip label={`${c.label} 설명`}>…)…
```

- [ ] **Step 5: `StepStatsTable.tsx` 헤더 교체 + HelpTip**

import 추가: `import { ko } from "../../i18n/ko";` + `import { HelpTip } from "../HelpTip";`

```tsx
<tr>
  <th className="py-2 pr-4 font-medium">{ko.report.colStep}</th>
  <th className="py-2 pr-4 font-medium">{ko.report.colMethod}</th>
  <th className="py-2 pr-4 font-medium">URL</th>
  <th className="py-2 pr-4 font-medium">{ko.report.colRequests}</th>
  <th className="py-2 pr-4 font-medium">{ko.report.colErrors}</th>
  <th className="py-2 pr-4 font-medium">
    p50 ms<HelpTip label="p50 설명">{ko.glossary.p50}</HelpTip>
  </th>
  <th className="py-2 pr-4 font-medium">
    p95 ms<HelpTip label="p95 설명">{ko.glossary.p95}</HelpTip>
  </th>
  <th className="py-2 pr-4 font-medium">
    p99 ms<HelpTip label="p99 설명">{ko.glossary.p99}</HelpTip>
  </th>
  {/* 다운로드 3열 기존 그대로 */}
</tr>
```

`aria-label={...}` 토글 버튼의 `Toggle loop breakdown for …` 등 동작 단언·구조는 무변경.

- [ ] **Step 6: `GroupLatencyTable.tsx` 헤더 교체 + HelpTip**

import 추가: `import { ko } from "../../i18n/ko";` + `import { HelpTip } from "../HelpTip";`

```tsx
<tr>
  <th className="py-2 pr-4 font-medium">{ko.report.colParallelNode}</th>
  <th className="py-2 pr-4 font-medium">{ko.report.colCount}</th>
  <th className="py-2 pr-4 font-medium">
    p50 ms<HelpTip label="p50 설명">{ko.glossary.p50}</HelpTip>
  </th>
  <th className="py-2 pr-4 font-medium">
    p95 ms<HelpTip label="p95 설명">{ko.glossary.p95}</HelpTip>
  </th>
  <th className="py-2 pr-4 font-medium">
    p99 ms<HelpTip label="p99 설명">{ko.glossary.p99}</HelpTip>
  </th>
  <th className="py-2 pr-4 font-medium">max ms</th>
</tr>
```

(행 렌더·`(parallel)` 서픽스·↳ sub-행은 무변경.)

- [ ] **Step 7: `BranchStatsTable.tsx` 헤더 교체**

import 추가: `import { ko } from "../../i18n/ko";`

```tsx
{/* 바깥 표 */}
<tr>
  <th className="py-2 pr-4 font-medium">{ko.report.colIfNode}</th>
  <th className="py-2 pr-4 font-medium">{ko.report.colDecisions}</th>
</tr>
{/* 펼침 내부 sub-표 */}
<tr>
  <th className="pr-4 text-left">{ko.report.colBranch}</th>
  <th className="pr-4 text-left">{ko.report.colDecisionsInner}</th>
</tr>
```

(`branchRank`/`branchLabel`/`(if)` 서픽스/토글 aria-label 무변경.)

- [ ] **Step 8: GREEN + 전체 게이트**

Run: `cd ui && pnpm test Summary && pnpm test StepStatsTable && pnpm test GroupLatencyTable && pnpm test BranchStatsTable && pnpm test ReportView`
Expected: PASS. (ReportView 테스트가 "Total requests" 등 영어 라벨 텍스트를 단언하고 있으면 그 단언만 새 라벨로 갱신.)
Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 green.

- [ ] **Step 9: Commit**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/ux-u5-report-interpretation
git add ui/src/i18n/ko.ts ui/src/components/report/Summary.tsx \
  ui/src/components/report/__tests__/Summary.test.tsx \
  ui/src/components/report/StepStatsTable.tsx \
  ui/src/components/report/__tests__/StepStatsTable.test.tsx \
  ui/src/components/report/GroupLatencyTable.tsx \
  ui/src/components/report/__tests__/GroupLatencyTable.test.tsx \
  ui/src/components/report/BranchStatsTable.tsx \
  ui/src/components/report/__tests__/BranchStatsTable.test.tsx
git commit -m "feat(ui): koreanize report tables and summary cards with glossary HelpTips (U5 §7.2)"
git log -1 --oneline
```

(ReportView.test.tsx도 고쳤다면 add에 포함.)

---

### Task 3: §7.3 인사이트 "다음 행동" 행동화

**Files:**
- Modify: `ui/src/i18n/ko.ts` (`insightActions` 네임스페이스)
- Modify: `ui/src/components/report/InsightPanel.tsx`
- Modify: `ui/src/components/report/__tests__/InsightPanel.test.tsx`

**컨텍스트:** 기존 결정론적 insight 7종의 **렌더링에만** "다음 행동" 한 줄 추가(클라 매핑) — 백엔드 `insights.rs`·XLSX Insights 시트 무변경. `slo_pass`는 spec이 명시적으로 행동 없음(맵에서 의도적 부재). 알 수 없는 kind(미래 백엔드 추가)는 행동 줄 생략(fail-soft).

- [ ] **Step 1: 테스트 추가 (RED)**

`InsightPanel.test.tsx`에 추가:

```tsx
it("kind별 '다음 행동' 줄이 렌더된다", () => {
  const insights: Insight[] = [
    { kind: "slowest_step", severity: "info", step_id: "s1", metric: "p95_ms", value: 1240 },
    { kind: "status_class", severity: "critical", status_class: "5xx", pct: 0.12, count: 3 },
  ];
  render(<InsightPanel insights={insights} meta={meta} />);
  expect(screen.getByText(/스텝 표를 내보내 개발팀과 공유하세요/)).toBeInTheDocument();
  expect(screen.getByText(/5xx면 서버 측 문제부터 확인하세요/)).toBeInTheDocument();
});

it("slo_pass와 미지의 kind엔 행동 줄이 없다", () => {
  const insights: Insight[] = [
    { kind: "slo_pass", severity: "info" },
    { kind: "future_kind", severity: "info" },
  ];
  render(<InsightPanel insights={insights} meta={meta} />);
  expect(screen.queryByText(/→/)).toBeNull();
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test InsightPanel`
Expected: 새 테스트 2개 FAIL.

- [ ] **Step 3: `ko.ts`에 `insightActions` 추가** (top-level, `report` 옆)

```ts
  // §7.3 인사이트 kind → "다음 행동" 한 줄 (slo_pass는 의도적 부재 — 행동 없음).
  insightActions: {
    slowest_step: "이 API가 병목입니다 — 스텝 표를 내보내 개발팀과 공유하세요.",
    error_hotspot: "이 스텝의 응답 검증 조건과 서버 로그를 확인하세요.",
    no_request_step: "이 스텝에 요청이 없었습니다 — 조건 분기·시나리오 구조를 확인하세요.",
    status_class: "4xx면 요청 형식(인증·파라미터), 5xx면 서버 측 문제부터 확인하세요.",
    status_temporal: "테스트 후반 5xx 증가 — 서버 자원 고갈 의심. 더 긴 soak 테스트를 고려하세요.",
    slo_failure: "미달 기준 행을 확인하고 임계값과 서버 성능 중 무엇을 조정할지 정하세요.",
  },
```

- [ ] **Step 4: `InsightPanel.tsx` 행동 줄 렌더**

```tsx
import { ko } from "../../i18n/ko";

// `as const` 객체는 string 키 인덱싱이 안 되므로 lookup용 넓힌 뷰를 한 번 만든다.
const ACTIONS: Record<string, string | undefined> = ko.insightActions;

// …li 내부를:
<li key={…} data-testid="insight" className={…}>
  <div>{message(i, meta)}</div>
  {ACTIONS[i.kind] && <div className="mt-0.5 text-xs opacity-80">→ {ACTIONS[i.kind]}</div>}
</li>
```

- [ ] **Step 5: GREEN + 전체 게이트**

Run: `cd ui && pnpm test InsightPanel`
Expected: 전부 PASS (기존 메시지·순서 테스트는 textContent regex라 무수정 통과).
Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: green.

- [ ] **Step 6: Commit**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/ux-u5-report-interpretation
git add ui/src/i18n/ko.ts ui/src/components/report/InsightPanel.tsx \
  ui/src/components/report/__tests__/InsightPanel.test.tsx
git commit -m "feat(ui): insight next-action lines (U5 §7.3)"
git log -1 --oneline
```

---

### Task 4: §7.4 running 진단 — stalled 배너 + run 목록 경과 시간

**Files:**
- Create: `ui/src/hooks/useNow.ts`
- Create: `ui/src/hooks/__tests__/useNow.test.ts`
- Modify: `ui/src/i18n/ko.ts` (`runDetail` 네임스페이스)
- Modify: `ui/src/pages/RunDetailPage.tsx`
- Modify: `ui/src/pages/__tests__/RunDetailPage.test.tsx`
- Modify: `ui/src/pages/ScenarioRunsPage.tsx`
- Modify: `ui/src/pages/__tests__/ScenarioRunsPage.test.tsx`

**컨텍스트:** "영영 running" 백엔드 갭의 **UI 측 완화만**(갭 수정은 범위 밖, spec §7.4). 판정 데이터는 기존 `useRun`/`useRunMetrics` 1s 폴링으로 가용 — **신규 fetch 없음**. 단 React Query는 데이터가 동일하면(빈 윈도 그대로) structural sharing으로 리렌더를 안 일으키므로, 시계 경과만으로 배너가 떠야 하는 이 케이스엔 클라 시계 틱(`useNow`)이 필요하다. `useNow`는 범용 훅이라 신설 `ui/src/hooks/`에 둔다(React Query 훅 모음 `api/hooks.ts`와 분리; Task 5의 `usePopover`는 DOM ref·이벤트에 결합된 컴포넌트 보조라 `components/`에 둔다 — 의도적 비대칭). `started_at`/`created_at`은 **ms epoch**. 경과 기준 = `started_at`(running이면 non-null) 방어적 fallback `created_at`. **기존 fixture 주의**: 기존 테스트들의 running run은 `started_at: 1` 같은 epoch-초기값이라 Task 4 이후 그 화면에 stalled 배너·거대 경과 텍스트가 *추가로* 렌더된다 — 단언 충돌은 없음이 확인됐지만(plan 리뷰), 전체 스위트에서 깨지는 게 있으면 fixture의 `started_at`을 `Date.now()` 기반으로 올리는 쪽으로 고칠 것(단언 완화 말고). real-timer interval로 act() 경고 노이즈가 날 수 있으나 무해.

- [ ] **Step 1: `useNow` 테스트 작성 (RED)**

`ui/src/hooks/__tests__/useNow.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNow } from "../useNow";

afterEach(() => vi.useRealTimers());

describe("useNow", () => {
  it("intervalMs마다 현재 시각으로 갱신된다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { result } = renderHook(() => useNow(1000));
    expect(result.current).toBe(1_000_000);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBe(1_003_000);
  });

  it("intervalMs=null이면 틱 없이 mount 시각 고정", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const { result } = renderHook(() => useNow(null));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(2_000_000);
  });

  it("unmount 시 interval을 정리한다", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = renderHook(() => useNow(1000));
    unmount();
    expect(spy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test useNow`
Expected: FAIL (모듈 없음).

- [ ] **Step 3: `ui/src/hooks/useNow.ts` 구현**

```ts
import { useEffect, useState } from "react";

/** intervalMs 간격으로 갱신되는 현재 시각(ms epoch). null이면 틱 없이 mount 시각 고정.
 *  서버 폴링과 무관한 순수 클라 시계 — running 경과 시간 표시용(§7.4, 신규 fetch 없음). */
export function useNow(intervalMs: number | null = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs == null) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
```

- [ ] **Step 4: GREEN 확인**

Run: `cd ui && pnpm test useNow`
Expected: PASS.

- [ ] **Step 5: 페이지 테스트 추가 (RED)**

`RunDetailPage.test.tsx`에 추가 — 이 파일의 기존 모킹 패턴(fetch mock 또는 MSW)을 그대로 따라 running run fixture를 만들 것. 핵심 3케이스:

```tsx
it("running + 15초 경과 + 요청 0건이면 진단 배너가 뜬다", async () => {
  // fixture: status "running", started_at = Date.now() - 20_000, metrics windows []
  // (useNow의 초기값이 Date.now()라 fake timer 불필요 — 첫 렌더에서 즉시 판정)
  renderRunningRun({ startedAgoMs: 20_000, windows: [] });
  expect(await screen.findByText(/워커가 시작하지 못했을 수 있습니다/)).toBeInTheDocument();
});

it("요청이 있으면 배너가 안 뜬다", async () => {
  renderRunningRun({ startedAgoMs: 20_000, windows: [SOME_WINDOW] });
  await screen.findByText(/Metric windows/i);
  expect(screen.queryByText(/워커가 시작하지 못했을/)).toBeNull();
});

it("15초 미만이면 배너가 안 뜬다", async () => {
  renderRunningRun({ startedAgoMs: 3_000, windows: [] });
  await screen.findByText(/Metric windows/i);
  expect(screen.queryByText(/워커가 시작하지 못했을/)).toBeNull();
});
```

(`renderRunningRun`은 이 테스트 파일 안에 만드는 로컬 헬퍼 — 기존 fixture 빌더를 복제해 status/started_at/windows만 바꾼다. 기존 헬퍼 이름이 다르면 그에 맞출 것.)

`ScenarioRunsPage.test.tsx`에 추가:

```tsx
it("running 행에 경과 시간이 표시된다", async () => {
  // fixture run: status "running", started_at = Date.now() - 90_000
  // 기존 makeRun 헬퍼에 started_at 인자가 없으면 확장(기본값 유지 — 기존 호출 무수정).
  renderPageWithRuns([makeRunningRun(90_000)]);
  // fixture 생성→렌더 사이 1초가 지나면 "1분 31초"가 될 수 있어 regex로 흡수(flake 방지)
  expect(await screen.findByText(/경과 1분 3[01]초/)).toBeInTheDocument();
});

it("terminal 행엔 경과 표시가 없다", async () => {
  renderPageWithRuns([makeRun("R1", "completed", 300)]);
  await screen.findByText(/view/);
  expect(screen.queryByText(/경과/)).toBeNull();
});
```

- [ ] **Step 6: RED 확인**

Run: `cd ui && pnpm test RunDetailPage && pnpm test ScenarioRunsPage`
Expected: 새 테스트 FAIL.

- [ ] **Step 7: `ko.ts`에 `runDetail` 네임스페이스 추가**

```ts
  runDetail: {
    // §7.4 영영-running 갭의 UI 측 완화(갭 자체 수정은 범위 밖)
    stalledRunning:
      "워커가 시작하지 못했을 수 있습니다 — 시나리오 URL과 컨트롤러 로그를 확인하세요.",
    elapsed: (d: string) => `경과 ${d}`,
  },
```

- [ ] **Step 8: `RunDetailPage.tsx` 배너 배선**

```tsx
import { useNow } from "../hooks/useNow";

// 컴포넌트 본문, 기존 hook 호출들 옆(early return보다 위):
const now = useNow(run.data?.status === "running" ? 1000 : null);

// early return들 뒤, r/totalCount 계산 뒤:
const stalledRunning =
  r.status === "running" && totalCount === 0 && now - (r.started_at ?? r.created_at) > 15_000;

// JSX — createRun/createPreset 에러 배너들(:171-186) 바로 아래, 카드 그리드 위(같은 배너 블록, amber 변형):
{stalledRunning && (
  <div
    role="status"
    className="mb-4 p-3 border border-amber-300 bg-amber-50 text-sm text-amber-800 rounded"
  >
    {ko.runDetail.stalledRunning}
  </div>
)}
```

- [ ] **Step 9: `ScenarioRunsPage.tsx` 경과 시간 배선**

```tsx
import { useNow } from "../hooks/useNow";
import { formatDurationKo } from "../i18n/duration";

// 컴포넌트 본문 상단(기존 hook들 옆):
const hasRunning = runs.data?.runs.some((r) => r.status === "running") ?? false;
const now = useNow(hasRunning ? 1000 : null);

// Duration 셀(<td>{profileDurationSeconds(r.profile)}s</td>)을:
<td className="py-3 pr-4">
  {profileDurationSeconds(r.profile)}s
  {r.status === "running" && (
    <span className="ml-1 text-xs text-slate-500">
      · {ko.runDetail.elapsed(formatDurationKo((now - (r.started_at ?? r.created_at)) / 1000))}
    </span>
  )}
</td>
```

(`formatDurationKo`가 내부에서 floor/clamp하므로 ms→초 나눗셈만 하면 된다.)

- [ ] **Step 10: GREEN + 전체 게이트**

Run: `cd ui && pnpm test RunDetailPage && pnpm test ScenarioRunsPage && pnpm test useNow`
Expected: PASS.
Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: green (특히 `react-hooks/exhaustive-deps` — `ScenarioRunsPage`는 이 lint 함정의 출처 파일이니 기존 `?retry=` effect deps를 절대 건드리지 말 것).

- [ ] **Step 11: Commit**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/ux-u5-report-interpretation
git add ui/src/hooks/useNow.ts ui/src/hooks/__tests__/useNow.test.ts \
  ui/src/i18n/ko.ts ui/src/pages/RunDetailPage.tsx ui/src/pages/__tests__/RunDetailPage.test.tsx \
  ui/src/pages/ScenarioRunsPage.tsx ui/src/pages/__tests__/ScenarioRunsPage.test.tsx
git commit -m "feat(ui): running-run diagnostics — stalled banner and elapsed time (U5 §7.4)"
git log -1 --oneline
```

---

### Task 5: §7.5 VerdictBadge FAIL 클릭 popover (+ `usePopover` 추출)

**Files:**
- Create: `ui/src/components/usePopover.ts`
- Modify: `ui/src/components/HelpTip.tsx` (usePopover 사용 리팩터 — **동작 불변**)
- Modify: `ui/src/components/VerdictBadge.tsx`
- Modify: `ui/src/components/__tests__/VerdictBadge.test.tsx`
- Modify: `ui/src/i18n/ko.ts` (`report.failReasonTitle`)

**컨텍스트:** FAIL 사유를 hover 전용 `title`에서 **클릭 popover**로(HelpTip 패턴 재사용 — 터치·키보드 접근성). HelpTip의 open/ESC/외부 클릭/edge-flip 로직을 `usePopover` 훅으로 추출해 공유한다. **`HelpTip.test.tsx`는 무수정 통과해야 한다**(리팩터 안전망). U1a 기록의 "HelpTip Modal-내 ESC 레이어링" 함정: VerdictBadge 3표면(run 목록 행·스케줄 이벤트 타임라인·run 상세 헤더)은 전부 Modal 밖이라 비해당 — usePopover 주석으로 제약을 문서화만 한다. 값 포맷은 기존 `fmt`/`METRIC_LABEL`(verdictFormat.ts) 재사용 — VerdictPanel과 단일 소스 유지. run 상세 h2 안의 FAIL 버튼은 기존에도 "FAIL" 텍스트가 heading accname에 포함돼 있었으므로 신규 오염 아님(U3 h3/legend 규칙은 새 ⓘ 라벨 추가 건).

- [ ] **Step 1: VerdictBadge 테스트를 popover 계약으로 갱신 (RED)**

`VerdictBadge.test.tsx` 전체 교체:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VerdictBadge } from "../VerdictBadge";
import type { Verdict } from "../../api/schemas";

const FAIL_VERDICT: Verdict = {
  passed: false,
  criteria: [
    { metric: "p95_ms", direction: "max", threshold: 300, actual: 420, passed: false },
    { metric: "error_rate", direction: "max", threshold: 0.01, actual: 0.05, passed: false },
    { metric: "rps", direction: "min", threshold: 100, actual: 200, passed: true },
  ],
};

describe("VerdictBadge", () => {
  it("renders — for null/undefined", () => {
    render(<VerdictBadge verdict={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("PASS는 비인터랙티브 span (버튼 아님)", () => {
    render(<VerdictBadge verdict={{ passed: true, criteria: [] }} />);
    expect(screen.getByText("PASS")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("FAIL 클릭 시 미달 기준만 포맷되어 popover로 열린다 (fmt/METRIC_LABEL 공유)", async () => {
    const user = userEvent.setup();
    render(<VerdictBadge verdict={FAIL_VERDICT} />);
    const btn = screen.getByRole("button", { name: "FAIL" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(btn).not.toHaveAttribute("title"); // hover 전용 title 제거(§7.5)
    await user.click(btn);
    const note = screen.getByRole("note");
    // METRIC_LABEL 적용(p95_ms→p95) + fmt 값 포맷 + 통과 기준(rps) 제외
    expect(note).toHaveTextContent("p95 420 ms > 300 ms");
    expect(note).toHaveTextContent("Error rate 5.00% > 1.00%");
    expect(note).not.toHaveTextContent("RPS");
    expect(btn).toHaveAttribute("aria-expanded", "true");
  });

  it("ESC와 외부 클릭으로 닫힌다", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <VerdictBadge verdict={FAIL_VERDICT} />
        <button type="button">outside</button>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "FAIL" }));
    expect(screen.getByRole("note")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("note")).toBeNull();
    await user.click(screen.getByRole("button", { name: "FAIL" }));
    await user.click(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("note")).toBeNull();
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test VerdictBadge`
Expected: popover 테스트들 FAIL (현재는 title 구현).

- [ ] **Step 3: `ui/src/components/usePopover.ts` 추출**

```ts
import { useEffect, useRef, useState } from "react";

/** HelpTip에서 추출한 클릭 토글 popover 공통 로직 — ESC/외부 pointerdown 닫힘 +
 *  뷰포트 우단 edge-flip. 소비처: HelpTip(ⓘ 용어 도움말), VerdictBadge(FAIL 사유).
 *
 *  주의(U1a 기록): Modal.tsx의 capture-phase keydown이 stopPropagation()하므로
 *  Modal 내부에서는 ESC 닫힘이 동작하지 않는다 — 현 소비처는 전부 Modal 밖.
 *  Modal 안에서 쓰려면 레이어링 설계부터(ui/CLAUDE.md). */
export function usePopover(widthPx: number) {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  function toggle() {
    if (!open && rootRef.current) {
      const r = rootRef.current.getBoundingClientRect();
      setAlignRight(r.left + widthPx + 8 > window.innerWidth);
    }
    setOpen((v) => !v);
  }

  return { open, alignRight, rootRef, toggle };
}
```

- [ ] **Step 4: `HelpTip.tsx`를 usePopover 사용으로 리팩터 (동작 불변)**

```tsx
import { useId, type ReactNode } from "react";
import { usePopover } from "./usePopover";

const POPOVER_WIDTH_PX = 224; // w-56 — 클래스와 lockstep

/** (기존 doc comment 유지) */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  const { open, alignRight, rootRef, toggle } = usePopover(POPOVER_WIDTH_PX);
  const id = useId();

  return (
    <span ref={rootRef} className="relative inline-block">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={toggle}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 align-middle text-[10px] leading-none text-slate-500 hover:bg-slate-100"
      >
        ?
      </button>
      {open && (
        <span
          id={id}
          role="note"
          className={`absolute top-5 z-20 block w-56 whitespace-normal rounded-md border border-slate-200 bg-white p-2 text-left text-xs font-normal text-slate-700 shadow-lg ${alignRight ? "right-0" : "left-0"}`}
        >
          {children}
        </span>
      )}
    </span>
  );
}
```

Run: `cd ui && pnpm test HelpTip`
Expected: **무수정 PASS** (리팩터 검증).

- [ ] **Step 5: `ko.ts`에 popover 제목 키 추가** (`report` 네임스페이스 안)

```ts
    failReasonTitle: "미달 기준",
```

- [ ] **Step 6: `VerdictBadge.tsx` 재작성**

```tsx
import { useId } from "react";
import type { Verdict } from "../api/schemas";
import { METRIC_LABEL, fmt } from "./report/verdictFormat";
import { usePopover } from "./usePopover";
import { ko } from "../i18n/ko";

const POPOVER_WIDTH_PX = 256; // w-64 — 클래스와 lockstep (기준 행이 ⓘ 본문보다 길다)

const BADGE_CLASS = "inline-block rounded px-2 py-0.5 text-xs font-medium";

export function VerdictBadge({ verdict }: { verdict?: Verdict | null }) {
  if (!verdict) return <span className="text-slate-400">—</span>;
  if (verdict.passed)
    return <span className={`${BADGE_CLASS} bg-emerald-200 text-emerald-900`}>PASS</span>;
  return <FailBadge verdict={verdict} />;
}

/** FAIL 사유 popover (§7.5) — hover title 대신 클릭 토글(터치·키보드 접근성).
 *  값 포맷은 VerdictPanel과 공유하는 fmt/METRIC_LABEL — 같은 run의 표/배지 단일 소스. */
function FailBadge({ verdict }: { verdict: Verdict }) {
  const { open, alignRight, rootRef, toggle } = usePopover(POPOVER_WIDTH_PX);
  const id = useId();
  const failed = verdict.criteria.filter((c) => !c.passed);

  return (
    <span ref={rootRef} className="relative inline-block">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={toggle}
        className={`${BADGE_CLASS} bg-red-200 text-red-900 cursor-pointer hover:bg-red-300`}
      >
        FAIL
      </button>
      {open && (
        <span
          id={id}
          role="note"
          className={`absolute top-5 z-20 block w-64 whitespace-normal rounded-md border border-slate-200 bg-white p-2 text-left text-xs font-normal text-slate-700 shadow-lg ${alignRight ? "right-0" : "left-0"}`}
        >
          <span className="mb-1 block font-medium">{ko.report.failReasonTitle}</span>
          {failed.map((c) => (
            <span key={c.metric} className="block">
              {METRIC_LABEL[c.metric] ?? c.metric} {fmt(c.metric, c.actual)}{" "}
              {c.direction === "max" ? ">" : "<"} {fmt(c.metric, c.threshold)}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
```

(기존 `failSummary` 함수와 `title` prop은 삭제 — popover가 단일 소스.)

- [ ] **Step 7: GREEN + 전체 게이트**

Run: `cd ui && pnpm test VerdictBadge && pnpm test HelpTip && pnpm test ScheduleEventTimeline && pnpm test ScenarioRunsPage && pnpm test RunDetailPage`
Expected: 전부 PASS — VerdictBadge를 마운트하는 다른 테스트가 title 단언을 하고 있으면 그 단언만 popover 계약으로 갱신(전체 스위트로 확인).
Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: green.

- [ ] **Step 8: Commit**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/ux-u5-report-interpretation
git add ui/src/components/usePopover.ts ui/src/components/HelpTip.tsx \
  ui/src/components/VerdictBadge.tsx ui/src/components/__tests__/VerdictBadge.test.tsx \
  ui/src/i18n/ko.ts
git commit -m "feat(ui): VerdictBadge FAIL click popover via shared usePopover (U5 §7.5)"
git log -1 --oneline
```

---

### Task 6: 마무리 스윕 (전체 게이트 + 잔여물 점검)

**Files:** (수정 없으면 커밋 없음)

- [ ] **Step 1: 전체 스위트 + 빌드 최종 1회**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0 경고 / 전체 테스트 PASS / `tsc -b` clean. 실패 시 고치고 해당 task 커밋에 fold하지 말고 별도 fix 커밋.

- [ ] **Step 2: 문서/잔여물 그렙**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/ux-u5-report-interpretation && grep -rn '^<<<<<<<\|^>>>>>>>' --include='*.md' . | grep -v node_modules; git status --porcelain`
Expected: conflict marker 0건, untracked 잔여물 없음(`.playwright-mcp/`·루트 png 등은 발견 시 `rm -rf`).

- [ ] **Step 3: 완료 보고**

orchestrator에 보고 — 이후 단계(orchestrator 직접 수행, 이 plan 범위 밖):
1. 최종 whole-feature 리뷰 = `handicap-reviewer` 에이전트.
2. **머지 전 라이브 검증(S-D 갭 차단, Playwright)** — controller+worker 빌드 후 `./target/debug/controller --db /tmp/u5.db --ui-dir ui/dist`(워크트리 자체 바이너리·상대경로):
   - SLO 기준 있는 run 1개 → 리포트에서 헤드라인 문장(시간·VU·요청수·p95·에러율)·합격/불합격 크게 표시 확인,
   - 기준 없는 run → `sloHint` 한 줄,
   - FAIL run → run 목록·상세 헤더에서 FAIL 클릭 popover(미달 기준 행·fmt 포맷),
   - Summary 카드 한국어 라벨 + 평균 RPS/드롭 HelpTip, StepStatsTable p95 HelpTip,
   - 인사이트 행동 줄,
   - 콘솔 Zod 에러 0.
   - (stalled 배너는 라이브 재현이 어려움 — dispatch fail-fast가 즉시 failed로 만들므로 RTL 커버리지로 갈음, 캐비엇 기록.)
3. 머지(`git -C /Users/sgj/develop/handicap merge --ff-only …`, 필요 시 rebase) + `ExitWorktree`.
4. docs: roadmap §A8 U5 완료 + 연기 항목(본 plan "의도적 범위 밖" 목록), build-log 한 단락, 루트 CLAUDE.md 상태줄 교체, 메모리 갱신.

---

## Self-Review 결과 (작성 시 수행 + spec-plan-reviewer 반영 2026-06-12)

- **Spec coverage**: §7.1(T1: 문장 3변형+0건+verdict 크게+sloHint+prop 전달) / §7.2(T2: 카드+표 3종 — U1a "잔여 표면" 인계 완결) / §7.3(T3: 6 kind 행동+slo_pass 제외) / §7.4(T4: 15s 배너+started_at fallback+목록 경과) / §7.5(T5: popover+fmt 공유) — 전부 task 매핑됨. §7.4의 "pending 고착은 reaper가 백엔드서 처리"·"갭 자체 수정 범위 밖" 준수(컨트롤러 무변경).
- **spec에 없는 plan 추가(의도적, 소소)**: `headlineNoRequests`(0건 전용 문구), open-curve 제3 문장 변형(spec은 "변형" 한 단어 — 고정/곡선을 구분), Summary 드롭 카드 HelpTip(`ko.glossary.maxInFlight` 재사용). 전부 합리적 가산, 신규 용어 정의 0.
- **U1a 연기 인계**: "HelpTip Modal-내 ESC 레이어링은 U5 popover 전 설계 필요" → 3표면 전부 Modal 밖임을 확인(ScheduleEventTimeline은 SchedulesPage 인라인), usePopover 주석으로 제약 문서화(T5).
- **Type consistency**: `usePopover(widthPx)` 반환 `{open, alignRight, rootRef, toggle}` — T5 두 소비처 동일 시그니처. `formatDurationKo(seconds)`/`formatSecondsKo(ms)` — T1·T4 사용처 단위 일치(T4는 ms→초 나눗셈 후 호출). `ko.report.*` 키는 T1/T2/T5가 같은 네임스페이스에 누적(충돌 없는 키 이름).
- **Placeholder scan**: 코드 블록 전부 실코드. 기존 테스트 파일의 fixture 헬퍼명만 "그 파일의 실제 이름에 맞출 것"으로 명시(파일별 패턴 상이 — implementer가 파일을 열고 따름).
- **spec-plan-reviewer must-fix 3건 반영**: ① `Summary.test.tsx:33/35` Target RPS/Dropped 라벨 단언 갱신 명시 ② `StepStatsTable.test.tsx:88` 광역 버튼-부재 단언의 의도-보존 스코프 좁히기(+전역 규칙 예외 1줄) ③ GroupLatencyTable·BranchStatsTable을 T2 범위에 포함(+`GroupLatencyTable.test.tsx:28` columnheader 정확매치 → regex). minor 반영: 11곳 카운트 정정, fixture명 캐비엇 일반화, T4 배너 위치 정정(:171-186 옆), 경과 테스트 regex flake 방지, 훅 배치 근거, §7.1 "최상단" 해석 명시, 기존 epoch-초기 fixture 부수효과 주의.

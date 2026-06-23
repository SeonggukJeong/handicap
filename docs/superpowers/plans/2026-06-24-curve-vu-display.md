# 곡선 run VU 표시 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** closed-loop VU 곡선 run이 VUs 카드·run 목록 VU 열에서 `0`으로 뜨던 것을 "최대 N (곡선)"으로, open-loop run을 "—"로 표시한다(closed+fixed는 종전 숫자 유지).

**Architecture:** 순수 헬퍼 `profileVuDisplay(profile)`(`components/loadModel.ts`, `deriveLoadMode` 재사용)가 profile→`VuDisplay`를 도출하고, 공유 프레젠테이셔널 `RunVuCell`이 그걸 ko.ts 경유로 렌더한다. RunDetailPage 카드·ScenarioRunsPage 열이 `RunVuCell`을 쓰고, RunDetailPage raw 프로필 섹션엔 곡선 줄 1개를 추가한다. **UI-only·read-only·와이어 무변경**.

**Tech Stack:** React + TypeScript, Zod(`api/schemas.ts` — *읽기만*, 무변경), vitest + @testing-library/react, ko.ts 메시지 카탈로그.

## Global Constraints

- **UI-only·와이어 0-diff (R9)**: `crates/**`·proto·migration·`ui/src/api/schemas.ts`·`ui/src/api/runPrefill.ts` 무변경. run 생성 payload byte-identical. 머지 diff = `ui/src/**`(+docs)만.
- **모든 신규 사용자노출 문자열은 `ko.ts` 카탈로그 경유 (R8, ADR-0035)** — `aria-label`/`title` 포함. 컴포넌트·페이지에 인라인 한국어/영어 사용자노출 문자열 0(em-dash `—` punctuation은 예외).
- **모드 역도출은 `deriveLoadMode` 단일 소스 (R4)** — `profileVuDisplay`가 독립적인 `vu_stages`/`target_rps`/`stages` mode 분기를 새로 짜지 않는다.
- **헬퍼 파라미터는 `Pick<Profile, "vus" | "target_rps" | "stages" | "vu_stages">` (R5)** — 이 4필드는 `.default()`가 없어(=leak-free) `r.profile`(`RunSchema.profile`)을 `normalizeProfile` 없이 받는다. 추가로 `vus`만 required(나머지 3은 optional), 그래서 테스트 fixture는 `{ vus: N }`만으로도 타입 통과.
- **tdd-guard (ui/CLAUDE.md)**: `ui/src/**`(non-test) 편집 전 pending test 파일이 있어야 한다 → **각 커밋에서 테스트 파일을 가장 먼저** 편집(RED diff 생성). test-path(`__tests__/*.test.tsx`) 편집은 항상 허용.
- **매 커밋 UI 게이트**: `pnpm lint && pnpm test && pnpm build`(`pnpm lint`=`eslint . --max-warnings=0`, `pnpm build`=`tsc -b && vite build`). 단일 파일 빠른 반복은 `pnpm test <name>`(`--` 없이).
- **3 커밋** — 각 커밋은 green(테스트→구현 fold). cargo 무관(UI-only).

---

### Task 1: `profileVuDisplay` 순수 헬퍼 + 단위 테스트

**Files:**
- Modify: `ui/src/components/loadModel.ts` (`deriveLoadMode`(:151–160) 바로 아래에 `VuDisplay` 타입 + `profileVuDisplay` 추가)
- Test: `ui/src/components/__tests__/loadModel.test.ts` (`profileVuDisplay` describe 블록 추가)

**Interfaces:**
- Consumes: `deriveLoadMode`(loadModel.ts:151 — `(p: {target_rps?; stages?; vu_stages?}) => {loadModel, rateMode}`), `Profile`(api/schemas.ts).
- Produces:
  - `export type VuDisplay = { kind: "fixed"; vus: number } | { kind: "curve"; peak: number } | { kind: "open" }`
  - `export function profileVuDisplay(profile: Pick<Profile, "vus" | "target_rps" | "stages" | "vu_stages">): VuDisplay`

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/components/__tests__/loadModel.test.ts`

기존 import 블록(상단 `from "../loadModel"`)에 `profileVuDisplay` 추가:
```ts
import {
  buildLoadProfile,
  deriveLoadMode,
  loadModelErrors,
  profileVuDisplay,
  type LoadModelState,
} from "../loadModel";
```
파일 끝(마지막 `describe` 뒤)에 추가:
```ts
describe("profileVuDisplay (§4.1)", () => {
  it("closed+fixed → {kind:'fixed', vus}", () => {
    expect(profileVuDisplay({ vus: 50 })).toEqual({ kind: "fixed", vus: 50 });
  });

  it("closed+curve(vu_stages) → {kind:'curve', peak = max target}", () => {
    expect(
      profileVuDisplay({
        vus: 0,
        vu_stages: [
          { target: 5, duration_seconds: 10 },
          { target: 50, duration_seconds: 20 },
          { target: 2, duration_seconds: 5 },
        ],
      }),
    ).toEqual({ kind: "curve", peak: 50 });
  });

  it("open+fixed(target_rps) → {kind:'open'}", () => {
    expect(profileVuDisplay({ vus: 0, target_rps: 100 })).toEqual({ kind: "open" });
  });

  it("open+curve(stages) → {kind:'open'}", () => {
    expect(profileVuDisplay({ vus: 0, stages: [{ target: 100, duration_seconds: 30 }] })).toEqual({
      kind: "open",
    });
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test loadModel`
Expected: FAIL — `profileVuDisplay`가 export되지 않아 import 에러 / 미정의.

- [ ] **Step 3: 헬퍼 구현** — `ui/src/components/loadModel.ts`

`deriveLoadMode` 함수(끝 `}` = :160) **바로 아래**에 추가:
```ts
export type VuDisplay =
  | { kind: "fixed"; vus: number } // closed+fixed → 숫자 그대로
  | { kind: "curve"; peak: number } // closed+curve → "최대 N (곡선)"
  | { kind: "open" }; // open-loop(고정/곡선) → "—"

/** 한 run의 VU 표시 방식. closed+fixed→리터럴 `vus`; closed+curve(vu_stages)→곡선 최고점
 *  (max target)을 "최대 N (곡선)"으로; open-loop(target_rps/stages)는 VU 개념이 없어 "—".
 *  모드 역도출은 deriveLoadMode 단일 소스(곡선 증발 drift 방지). 읽는 필드만 Pick해
 *  RunSchema.profile(nested-default leak)을 normalizeProfile 없이 수용(profileDurationSeconds
 *  패턴 — 이 4필드는 .default()가 없어 leak-free). */
export function profileVuDisplay(
  profile: Pick<Profile, "vus" | "target_rps" | "stages" | "vu_stages">,
): VuDisplay {
  const { loadModel, rateMode } = deriveLoadMode(profile);
  if (loadModel === "open") return { kind: "open" };
  if (rateMode === "curve")
    return { kind: "curve", peak: Math.max(...(profile.vu_stages ?? []).map((s) => s.target)) };
  return { kind: "fixed", vus: profile.vus };
}
```
(`loadModel.ts`는 이미 `import type { Profile } from "../api/schemas"`(:1)가 있어 추가 import 불요. `Math.max(...[])`는 curve 가지에서만 호출되고 그 가지는 `deriveLoadMode`가 `vu_stages.length>0`을 보장한 뒤라 빈 배열 `-Infinity` 불가.)

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm test loadModel`
Expected: PASS (기존 `deriveLoadMode`/`buildLoadProfile` 테스트 포함 전부 green).

- [ ] **Step 5: 게이트**

Run: `cd ui && pnpm lint && pnpm build`
Expected: lint 0 경고, `tsc -b` green(Pick 타입 호환 확인).

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/loadModel.ts ui/src/components/__tests__/loadModel.test.ts
git commit -m "feat(ui): profileVuDisplay helper — VU 곡선/open-loop 표시 도출 (R1·R2·R3·R4·R5)"
```

---

### Task 2: `RunVuCell` 프레젠테이셔널 컴포넌트 + ko 키

**Files:**
- Create: `ui/src/components/RunVuCell.tsx`
- Modify: `ui/src/i18n/ko.ts` (`ko.report`에 `vusCurvePeak`/`vusOpenHint` 추가 — `colVus: "VU"`(:603) 바로 아래)
- Test: `ui/src/components/__tests__/RunVuCell.test.tsx` (신규)

**Interfaces:**
- Consumes: `profileVuDisplay`/`VuDisplay`(Task 1), `Profile`(api/schemas.ts), `ko`(i18n/ko.ts).
- Produces: `export function RunVuCell({ profile }: { profile: Pick<Profile, "vus" | "target_rps" | "stages" | "vu_stages"> }): JSX.Element` — fragment(fixed/curve) 또는 `<span>`(open).
- New ko keys: `ko.report.vusCurvePeak(n: number): string` = `최대 ${n} (곡선)`; `ko.report.vusOpenHint: string` = `VU 해당 없음 — 열린 루프(RPS·슬롯 기반)`.

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/components/__tests__/RunVuCell.test.tsx` (신규)

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunVuCell } from "../RunVuCell";

const OPEN_HINT = "VU 해당 없음 — 열린 루프(RPS·슬롯 기반)";

describe("RunVuCell", () => {
  it("closed+fixed → 숫자 그대로 (R3)", () => {
    render(<RunVuCell profile={{ vus: 50 }} />);
    expect(screen.getByText("50")).toBeInTheDocument();
  });

  it("closed+curve → '최대 N (곡선)' (R1)", () => {
    render(
      <RunVuCell
        profile={{
          vus: 0,
          vu_stages: [
            { target: 5, duration_seconds: 10 },
            { target: 50, duration_seconds: 20 },
          ],
        }}
      />,
    );
    expect(screen.getByText("최대 50 (곡선)")).toBeInTheDocument();
  });

  it("open-loop → '—' + aria-label/title 힌트 (R2)", () => {
    render(<RunVuCell profile={{ vus: 0, target_rps: 100 }} />);
    const cell = screen.getByLabelText(OPEN_HINT);
    expect(cell).toHaveTextContent("—");
    expect(cell).toHaveAttribute("title", OPEN_HINT);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test RunVuCell`
Expected: FAIL — `../RunVuCell` 모듈 없음.

- [ ] **Step 3: ko 키 추가** — `ui/src/i18n/ko.ts`

`ko.report` 객체 안 `colVus: "VU",`(:603) **바로 아래** 줄에 추가:
```ts
    vusCurvePeak: (n: number) => `최대 ${n} (곡선)`,
    vusOpenHint: "VU 해당 없음 — 열린 루프(RPS·슬롯 기반)",
```

- [ ] **Step 4: 컴포넌트 작성** — `ui/src/components/RunVuCell.tsx` (신규)

```tsx
import type { Profile } from "../api/schemas";
import { ko } from "../i18n/ko";
import { profileVuDisplay } from "./loadModel";

/** 한 run의 VU 표시 셀(RunDetailPage 카드 · ScenarioRunsPage 열 공유). closed+fixed→숫자,
 *  closed+curve→"최대 N (곡선)", open-loop→"—"(VU 해당 없음·RPS/슬롯 기반). 표시 분기 단일
 *  소스라 per-surface 복붙 drift와 a11y 누락(open의 aria-label)을 막는다. */
export function RunVuCell({
  profile,
}: {
  profile: Pick<Profile, "vus" | "target_rps" | "stages" | "vu_stages">;
}) {
  const vu = profileVuDisplay(profile);
  if (vu.kind === "curve") return <>{ko.report.vusCurvePeak(vu.peak)}</>;
  if (vu.kind === "open")
    return (
      <span title={ko.report.vusOpenHint} aria-label={ko.report.vusOpenHint}>
        —
      </span>
    );
  return <>{vu.vus}</>;
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd ui && pnpm test RunVuCell`
Expected: PASS (3 it green).

- [ ] **Step 6: 게이트**

Run: `cd ui && pnpm lint && pnpm build`
Expected: lint 0, `tsc -b` green.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/RunVuCell.tsx ui/src/components/__tests__/RunVuCell.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): RunVuCell — VU 표시 셀 공유 컴포넌트 + ko 키 (R1·R2·R6·R8)"
```

---

### Task 3: 두 페이지 배선 + RunDetailPage raw 곡선 줄 + ko 키

**Files:**
- Modify: `ui/src/pages/RunDetailPage.tsx` (카드 :220 → `RunVuCell`; raw `<ul>`(:264–268)에 곡선 `<li>` 추가; import 추가)
- Modify: `ui/src/pages/ScenarioRunsPage.tsx` (VU 열 :302 → `RunVuCell`; import 추가)
- Modify: `ui/src/i18n/ko.ts` (`ko.runDetail`에 `profileVuStages` 추가 — `profileTitle: "프로필"`(:690) 바로 아래)
- Test: `ui/src/pages/__tests__/RunDetailPage.test.tsx` (곡선/고정 running fixture describe 추가)
- Test: `ui/src/pages/__tests__/ScenarioRunsPage.test.tsx` (곡선/open run describe 추가)

**Interfaces:**
- Consumes: `RunVuCell`(Task 2), `ko.report.vusCurvePeak`/`vusOpenHint`(Task 2), 신규 `ko.runDetail.profileVuStages(peak, count)`.
- New ko key: `ko.runDetail.profileVuStages(peak: number, count: number): string` = `최대 ${peak} · ${count}단계`.

- [ ] **Step 1: 실패하는 페이지 테스트 작성**

(1) `ui/src/pages/__tests__/RunDetailPage.test.tsx` 끝에 추가. (이 raw 프로필 섹션은 `terminal && report.data`의 **else**에서만 렌더되므로 — `RunDetailPage.tsx:240–269` — 반드시 **running** fixture로 검증한다. terminal+report fixture면 `<ReportView>`가 대신 떠 줄이 안 보인다.)
```tsx
// ---------------------------------------------------------------------------
// 곡선 run VU 표시 (R1/R7) — raw 섹션은 running(non-terminal)에서만 렌더
// ---------------------------------------------------------------------------

function makeCurveRunningRun() {
  return {
    id: "CR1",
    scenario_id: "S1",
    scenario_yaml: "version: 1\nname: t\nsteps: []\n",
    status: "running",
    profile: {
      vus: 0,
      ramp_up_seconds: 0,
      duration_seconds: 0,
      vu_stages: [
        { target: 5, duration_seconds: 10 },
        { target: 50, duration_seconds: 20 },
        { target: 2, duration_seconds: 5 },
      ],
    },
    env: {},
    started_at: Date.now(),
    ended_at: null,
    created_at: Date.now(),
  };
}

describe("RunDetailPage — 곡선 run VU 표시 (R1/R7)", () => {
  it("닫힌 곡선 running run: VUs 카드 '최대 50 (곡선)' + raw vu_stages 줄", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/runs/CR1"))
        return Promise.resolve(jsonResponse(makeCurveRunningRun()));
      if (url.endsWith("/api/runs/CR1/metrics"))
        return Promise.resolve(jsonResponse({ run_id: "CR1", windows: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderWithRouter("CR1");
    // 주의: 카드 단언은 정확매치 "최대 50 (곡선)" 유지 — `/최대 50/`로 느슨하게 하면 raw
    // 줄("최대 50 · 3단계")까지 다중매치돼 throw(ui/CLAUDE.md "같은 라벨 여럿" 함정).
    expect(await screen.findByText("최대 50 (곡선)")).toBeInTheDocument();
    expect(screen.getByText(/vu_stages = 최대 50 · 3단계/)).toBeInTheDocument();
  });

  it("고정 VU running run: raw vu_stages 줄 없음", async () => {
    mockRunningApi(Date.now() - 1_000, 1);
    renderWithRouter("SR1");
    await screen.findByRole("heading", { name: /메트릭 윈도우/ });
    expect(screen.queryByText(/vu_stages =/)).toBeNull();
  });
});
```

(2) `ui/src/pages/__tests__/ScenarioRunsPage.test.tsx` 끝에 추가:
```tsx
describe("ScenarioRunsPage — 곡선/열린 run VU 열 (R1/R2)", () => {
  it("닫힌 곡선 run: VU 열 '최대 50 (곡선)'", async () => {
    mockApi({
      profile: {
        vus: 0,
        ramp_up_seconds: 0,
        duration_seconds: 0,
        vu_stages: [
          { target: 5, duration_seconds: 10 },
          { target: 50, duration_seconds: 20 },
        ],
      },
    });
    renderPage();
    expect(await screen.findByText("최대 50 (곡선)")).toBeInTheDocument();
  });

  it("열린 루프 run: VU 열 '—'", async () => {
    mockApi({
      profile: { vus: 0, ramp_up_seconds: 0, duration_seconds: 30, target_rps: 100 },
    });
    renderPage();
    expect(
      await screen.findByLabelText("VU 해당 없음 — 열린 루프(RPS·슬롯 기반)"),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test RunDetailPage ScenarioRunsPage`
Expected: 새 4 it FAIL — 카드/열이 아직 `{r.profile.vus}`(=`0`)을 렌더, raw 곡선 줄·"최대 50 (곡선)"·"—" 부재. (`profileVuStages` ko 키 미정의 컴파일 에러는 esbuild 단계엔 안 뜸 — 다음 스텝에서 추가.)

- [ ] **Step 3: ko 키 추가** — `ui/src/i18n/ko.ts`

`ko.runDetail` 객체 안 `profileTitle: "프로필",`(:690) **바로 아래** 줄에 추가:
```ts
    profileVuStages: (peak: number, count: number) => `최대 ${peak} · ${count}단계`,
```

- [ ] **Step 4: RunDetailPage 배선** — `ui/src/pages/RunDetailPage.tsx`

(a) import 추가 (기존 import 블록, 예: `ko` import 근처):
```tsx
import { RunVuCell } from "../components/RunVuCell";
```
(b) VUs 카드(:220) 교체:
```tsx
        <Card label={ko.runDetail.cardVus}>
          <RunVuCell profile={r.profile} />
        </Card>
```
(c) raw `<ul>`(:264–268)에서 `<li>ramp_up = {r.profile.ramp_up_seconds ?? 0}s</li>`(:267) **바로 뒤**, `</ul>`(:268) **앞**에 곡선 줄 추가:
```tsx
              {r.profile.vu_stages && r.profile.vu_stages.length > 0 && (
                <li>
                  vu_stages ={" "}
                  {ko.runDetail.profileVuStages(
                    Math.max(...r.profile.vu_stages.map((s) => s.target)),
                    r.profile.vu_stages.length,
                  )}
                </li>
              )}
```

- [ ] **Step 5: ScenarioRunsPage 배선** — `ui/src/pages/ScenarioRunsPage.tsx`

(a) import 추가:
```tsx
import { RunVuCell } from "../components/RunVuCell";
```
(b) VU 열(:302) 교체:
```tsx
                        <td className="py-3 pr-4">
                          <RunVuCell profile={r.profile} />
                        </td>
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `cd ui && pnpm test RunDetailPage ScenarioRunsPage`
Expected: PASS (새 4 it + 기존 테스트 전부 green — 기존 fixed-run 테스트의 "1"/"4" VU 표시 무수정 통과 = R3).

- [ ] **Step 7: 전체 게이트 + R9 확인**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0, 전체 스위트 green, `tsc -b`+vite build green.

Run: `git -C /Users/sgj/develop/handicap/.claude/worktrees/curve-vu-display diff --name-only master -- ui/src/api/schemas.ts ui/src/api/runPrefill.ts crates`
Expected: **빈 출력** (R9 — schemas/runPrefill/엔진 0-diff).

- [ ] **Step 8: Commit**

```bash
git add ui/src/pages/RunDetailPage.tsx ui/src/pages/ScenarioRunsPage.tsx ui/src/i18n/ko.ts \
  ui/src/pages/__tests__/RunDetailPage.test.tsx ui/src/pages/__tests__/ScenarioRunsPage.test.tsx
git commit -m "feat(ui): RunDetailPage 카드·ScenarioRunsPage 열에 RunVuCell 배선 + raw 곡선 줄 (R1·R2·R3·R6·R7·R9)"
```

---

## Self-Review

**1. Spec coverage (R1–R9):**
- R1 (closed+curve "최대 N (곡선)") → Task 1 단위 + Task 2 RunVuCell + Task 3 페이지 스모크. ✓
- R2 (open "—" + a11y) → Task 1 단위(open kind) + Task 2 RunVuCell(aria-label/title) + Task 3 ScenarioRunsPage open. ✓
- R3 (closed+fixed byte-identical 숫자) → Task 1 단위 + Task 3 기존 페이지 테스트 무수정 통과. ✓
- R4 (deriveLoadMode 재사용) → Task 1 Step 3 구현이 `deriveLoadMode` 호출. ✓
- R5 (Pick<Profile,…> leak-free) → Task 1 시그니처 + Step 5 `tsc -b`. ✓
- R6 (공유 RunVuCell) → Task 2 컴포넌트 + Task 3 두 페이지 모두 사용. ✓
- R7 (raw 곡선 줄, running fixture) → Task 3 Step 1(1)·Step 4(c). ✓
- R8 (ko 경유) → Task 2 ko 2키 + Task 3 ko 1키, 인라인 문자열 0(em-dash 예외). ✓
- R9 (와이어 0-diff) → Task 3 Step 7 `git diff --name-only` 확인. ✓

**2. Placeholder scan:** 모든 스텝에 실제 코드/명령/예상결과 있음. TBD/TODO 0.

**3. Type consistency:** `profileVuDisplay`/`VuDisplay`/`RunVuCell` 시그니처가 Task 1→2→3에서 일관(`Pick<Profile, "vus"|"target_rps"|"stages"|"vu_stages">`). ko 키 이름(`vusCurvePeak`/`vusOpenHint`/`profileVuStages`)이 정의(Task 2/3)·사용(RunVuCell·RunDetailPage) 일치.

**4. 라이브 검증:** waived (spec §6) — UI-only·read-only·`ProfileSchema` 무변경·run-생성/리포트-파싱/엔진 무변경. RTL fixture가 `vu_stages`를 실배열로 줘(absent 아님) 4 표시 kind를 결정적 커버. 머지 전 전체 `pnpm test`(Task 3 Step 7) + `git diff --name-only`(R9).

---

<!-- spec-plan-reviewer clean APPROVE (spec 2회 + plan 2회 라운드, 2026-06-24) -->
REVIEW-GATE: APPROVED

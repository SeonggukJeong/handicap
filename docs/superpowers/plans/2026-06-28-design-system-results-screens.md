# 디자인 시스템 확산 — 결과·표시 화면군 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 결과·표시 화면(목록·run 상세·워커·비교·리포트)의 블록-레벨 알림 박스를 기존 `Callout` 프리미티브로, WorkerDashboard `EditModal`의 raw `<input>`을 `Input`으로 드롭인 교체해 룩·역할·포커스를 통일한다.

**Architecture:** ADR-0043 디자인 시스템의 3번째 *적용*(발명 아님). 토대(프리미티브 6종·accent 토큰) 0-diff 순수 소비. 화면별 독립 green 커밋 — 각 파일이 리뷰·롤백 단위. 동작/와이어 byte-identical, 시각은 Callout 캐넌으로 통일(pixel-1:1 아님).

**Tech Stack:** TypeScript/React, Tailwind, Vitest + React Testing Library(jsdom). 게이트 = `pnpm lint && pnpm test && pnpm build`(cargo 비대상 — UI-only 슬라이스).

**Spec:** `docs/superpowers/specs/2026-06-28-design-system-results-screens-design.md` (spec-plan-reviewer clean APPROVE, 2026-06-28). 각 박스의 file:line·variant·role 매핑은 spec §4가 권위 — 구현 시 현재 코드로 재확인(line drift 가능).

## Global Constraints

> 모든 task의 요구사항에 암묵 포함. 값은 spec에서 verbatim.

- **토대 동결(R2)**: `ui/src/components/ui/{Field,Input,Select,Section,Callout,Badge}.tsx`·`tailwind.config.ts`·`Button.tsx` **0-diff**. 새 variant/tone/토큰 0 — 순수 소비.
- **동작·와이어 byte-identical(R3)**: 핸들러·react-query 훅·도출(`useMemo`/필터/정렬/라벨)·상태 round-trip·전송 payload 0-diff. **JSX 마크업만 교체.** (시각은 Callout 캐넌으로 통일됨 — byte-identical 아님.)
- **백엔드·proto·migration·`ui/src/api/*`·`schemas.ts`·Zod 0-diff(R10)**. diff는 `ui/src`(페이지/컴포넌트)·`ui/src/i18n/ko.ts`·`docs/`만.
- **데이터-식별 색 동결(R7)**: 차트 stroke·`StatusBadge`·`VerdictBadge`·`VerdictPanel`·`runLabel`(`runColor`/`runShortLabel`)·`ConnectionCostCard` green/teal·`ScenarioRunsPage` stall 배지(`bg-amber-100`)·워커 인라인 status 배지(`bg-amber-100`/`bg-slate-100`) 0-diff.
- **severity 팔레트 동결(R8)**: `InsightPanel.tsx`·`InsightCompareMatrix.tsx`의 critical/warning/info 색 맵 0-diff(3단계 severity-식별 단위).
- **컴팩트 툴바 동결(R9)**: `ui/src/components/RunListControls.tsx` 0-diff(이 슬라이스 diff에 부재).
- **기존 action-control accent 동결(R11)**: `ScenarioRunsPage:269/458`·`WorkerDashboardPage:63/132/485`의 기존 `bg-indigo-600`/`text-indigo-600`/`bg-blue-600`/`text-blue-600`는 Button-accent 도메인 — 손대지 않음. **신규** blue/indigo drift만 금지.
- **문구(R12, ADR-0035)**: **신규 인라인 영어 문자열 0.** Callout children/문구는 기존 ko 키·리터럴 그대로 이동. 신규 노출 텍스트 필요 시만 `ko.ts` 추가(이번엔 불필요 예상).
- **정당 예외(R5)**: checkbox(`ScenarioRunsPage:333`·`CompareOverlaySection:26`)·`<textarea>`·`type="date"`(RunListControls)·색 없는 slate 로딩/상태 텍스트·slate 박스(`RunDetailPage:257`)·버튼 옆 인라인 `<span>`(`ScenarioRunsPage:230/277`)·`CompareOverlaySection:43` plain status — **변환 안 함**.
- **git**: `git add`는 **명시 경로만**(`-A` 금지). 커밋은 단일 foreground 호출.

---

## 변환 패턴 (전 task 공통 — 한 번 정의, 반복 적용)

### Callout import
- 페이지(`ui/src/pages/*.tsx`): `import { Callout } from "../components/ui/Callout";`
- `ui/src/components/report/*.tsx`·`ui/src/components/compare/*.tsx`: `import { Callout } from "../ui/Callout";`
- Input(WorkerDashboard만): `import { Input } from "../components/ui/Input";`

### Callout API (소비만 — 변경 금지)
```tsx
<Callout variant="info" | "warn" | "error" role={role} aria-label={...} title={...} className={...}>
  {children}
</Callout>
```
- `Callout` BASE = `rounded-md border p-2 text-sm` + variant 색. → 변환 시 **기존 박스의 `border`/`bg-*`/`text-red-*`|`text-amber-*`/`p-*`/`rounded*`는 제거**(Callout이 제공). **레이아웃 클래스만 `className`으로 보존**: 마진(`mb-3`/`mb-4`)·flex(`flex items-center justify-between gap-3`).
- **role/children/문구는 1:1 보존**. roleless 박스는 `role` 미부여.

### 변환 규칙 (spec R4/R5)
| 기존 | → |
|---|---|
| 빨강 오류 박스/텍스트 `role="alert"`(`bg-red-50` 또는 borderless `text-red-*`) | `<Callout variant="error" role="alert" className="<마진/flex>">` |
| 빨강 오류 박스/텍스트 **roleless** (`<p text-red-600>` early-return 등) | `<Callout variant="error" className="<마진>">` (role 미부여) |
| 호박 경고 박스 `role="status"` | `<Callout variant="warn" role="status" className="<마진/flex>">` |
| 호박 경고 박스 **roleless** | `<Callout variant="warn" className="<마진>">` (role 미부여) |

### Before/After 예시 (RunDetailPage)
```tsx
// BEFORE
{createRun.error && (
  <div role="alert" className="mb-4 p-3 border border-red-200 bg-red-50 text-sm text-red-800 rounded">
    재실행 실패: {(createRun.error as Error).message}
  </div>
)}
// AFTER
{createRun.error && (
  <Callout variant="error" role="alert" className="mb-4">
    재실행 실패: {(createRun.error as Error).message}
  </Callout>
)}
```
```tsx
// BEFORE (flex 박스 — 레이아웃 보존)
<div role="status" className="mb-4 p-3 border border-amber-300 bg-amber-50 text-sm text-amber-800 rounded flex items-center justify-between gap-3">
  <span>{ko.runDetail.midRunStall(...)}</span>
  <button …>…</button>
</div>
// AFTER
<Callout variant="warn" role="status" className="mb-4 flex items-center justify-between gap-3">
  <span>{ko.runDetail.midRunStall(...)}</span>
  <button …>…</button>
</Callout>
```
```tsx
// BEFORE (roleless load error early-return)
if (run.error) return <p className="text-red-600">{(run.error as Error).message}</p>;
// AFTER
if (run.error) return <Callout variant="error">{(run.error as Error).message}</Callout>;
```

### tdd-guard 사전조치 (전 task 공통)
`tdd-guard`는 `ui/src/**`(non-test) 편집 전 디스크에 *pending*(수정/미추적) test-path 파일을 요구한다(JSX-only 변경은 auto-pass 제외). **각 task는 테스트 편집을 먼저** 한다(=pending diff + 회귀 가드 겸함). test-path(`__tests__/`·`*.test.tsx`) 편집은 항상 허용. 셀렉터 보존이라 대개 기존 테스트는 그대로 green — 추가 단언은 변환 박스의 role+text를 한 줄 더 핀하는 정도.

---

## Task 1: ScenarioListPage

**Files:**
- Modify: `ui/src/pages/ScenarioListPage.tsx` (목록 로드 오류 `:35` roleless, 복제 오류 `:37` role=alert)
- Test: `ui/src/pages/__tests__/ScenarioListPage.home.test.tsx`, `ui/src/pages/__tests__/ScenarioListPage.clone.test.tsx`

**Interfaces:**
- Consumes: `Callout` from `../components/ui/Callout`.
- Produces: (없음 — 독립 화면)

- [ ] **Step 1: 테스트 먼저 — 로드 오류 분기 신규 단언** (`ScenarioListPage.home.test.tsx`)

`home.test.tsx`의 기존 렌더 헬퍼(React Query 클라이언트·라우터 래퍼)를 그대로 써서, scenarios 쿼리를 error로 두는 케이스를 추가하고 변환될 로드 오류가 렌더되는지 단언한다. (기존 케이스 헬퍼를 복사해 error mock으로만 변경.)
```tsx
it("renders failedToLoad as an error Callout on list query error", async () => {
  // 기존 헬퍼와 동일하게 마운트하되 scenarios 쿼리를 error 상태로(예: fetch reject)
  // ko.common.failedToLoad(...) 텍스트가 화면에 보이는지
  expect(await screen.findByText(/불러오기 실패|실패/)).toBeInTheDocument();
});
```
- 정확한 문구·mock 방식은 `home.test.tsx` 기존 패턴에 맞춘다(이 파일의 fetch/React Query mock 컨벤션). 핵심은 *로드 오류 분기를 렌더해 pending diff + 회귀 가드*를 만드는 것.

- [ ] **Step 2: 테스트 실행 — RED/통과 확인**

Run: `cd ui && pnpm test ScenarioListPage`
Expected: 새 단언 포함 통과(또는 변환 전이라 plain `<p>`로도 텍스트는 보이므로 통과 — 회귀 가드는 변환 후에도 유지됨이 핵심).

- [ ] **Step 3: src 변환** (`ScenarioListPage.tsx`)

`import { Callout } from "../components/ui/Callout";` 추가. 2곳 변환:
- `:35` `{error && <p className="text-red-600">{ko.common.failedToLoad((error as Error).message)}</p>}` → `{error && <Callout variant="error" className="mb-3">{ko.common.failedToLoad((error as Error).message)}</Callout>}`
- `:37` `<p role="alert" className="mb-3 text-sm text-red-600">복제 실패: {...}</p>` → `<Callout variant="error" role="alert" className="mb-3">복제 실패: {(clone.error as Error).message}</Callout>`
- **EmptyState(`:43`)·로딩 `<p text-slate-500>`(`:34`)은 손대지 않음.**

- [ ] **Step 4: 게이트** — Run: `cd ui && pnpm test ScenarioListPage && pnpm lint && pnpm build`
Expected: PASS. (lint `--max-warnings=0` — 미사용 import 등 0.)

- [ ] **Step 5: 커밋** (단일 foreground)
```bash
git add ui/src/pages/ScenarioListPage.tsx ui/src/pages/__tests__/ScenarioListPage.home.test.tsx
git commit -m "refactor(ui): ScenarioListPage 알림 → Callout (디자인시스템 결과화면 확산)"
```

---

## Task 2: ScenarioRunsPage

**Files:**
- Modify: `ui/src/pages/ScenarioRunsPage.tsx` (시나리오 로드 오류 `:138` roleless, run-생성 오류 박스 `:183` role=alert)
- Test: `ui/src/pages/__tests__/ScenarioRunsPage.test.tsx`

**Interfaces:**
- Consumes: `Callout` from `../components/ui/Callout`.

- [ ] **Step 1: 테스트 먼저** — 기존 `ScenarioRunsPage.test.tsx`에 run-생성 오류 박스가 `getByRole("alert")`로 잡히고 Callout화 후에도 같은 role로 유지됨을 핀하는 단언 추가(없으면). 필터 칩 ↔ verdict 배지 disambiguate(`aria-pressed`/`getByRole("button",{name,pressed:false})`)는 `ui/CLAUDE.md` 규칙대로 유지.
```tsx
// run 생성 mutation을 error로 둔 케이스에서:
expect(screen.getByRole("alert")).toHaveTextContent(/실패/);
```

- [ ] **Step 2: 테스트 실행** — Run: `cd ui && pnpm test ScenarioRunsPage` → 통과 확인.

- [ ] **Step 3: src 변환** (`ScenarioRunsPage.tsx`)

`Callout` import 추가. 2곳 변환:
- `:138` `if (scenario.error) return <p className="text-red-600">{(scenario.error as Error).message}</p>;` → `return <Callout variant="error">{(scenario.error as Error).message}</Callout>;`
- `:183` 페이지 오류 박스 `role="alert" border border-red-200 bg-red-50 text-red-700`(마진 `mb-4`) → `<Callout variant="error" role="alert" className="mb-4">…</Callout>`
- **동결**: 인라인 `<span text-red-600>`(`:230` "최대 50개…"·`:277` 버튼 옆)·stall 배지(`:344`)·`StatusBadge`(`:342`)·`VerdictBadge`(`:359`)·checkbox(`:333`)·`RunListControls`.

- [ ] **Step 4: 게이트** — Run: `cd ui && pnpm test ScenarioRunsPage && pnpm lint && pnpm build` → PASS.

- [ ] **Step 5: 커밋**
```bash
git add ui/src/pages/ScenarioRunsPage.tsx ui/src/pages/__tests__/ScenarioRunsPage.test.tsx
git commit -m "refactor(ui): ScenarioRunsPage 알림 → Callout"
```

---

## Task 3: RunDetailPage

**Files:**
- Modify: `ui/src/pages/RunDetailPage.tsx`
- Test: `ui/src/pages/__tests__/RunDetailPage.test.tsx`

**Interfaces:**
- Consumes: `Callout` from `../components/ui/Callout`.

- [ ] **Step 1: 테스트 먼저** — `RunDetailPage.test.tsx`에 오류/경고 박스의 role 보존 단언 추가(없으면). 변환 박스가 `getByRole("alert")`/`getByRole("status")`로 유지됨을 핀.

- [ ] **Step 2: 테스트 실행** — Run: `cd ui && pnpm test RunDetailPage` → 통과.

- [ ] **Step 3: src 변환** (`RunDetailPage.tsx`)

`Callout` import 추가. 변환(spec §4.3):
- run 로드 오류 `:82` `if (run.error) return <p className="text-red-600">…</p>;` → `<Callout variant="error">…</Callout>` (roleless).
- 오류 박스 `role="alert" … text-red-800`(`:181`·`:189`·`:236`·`:249`) → `<Callout variant="error" role="alert" className="mb-4">…</Callout>` (4곳).
- 경고/상태 박스 `role="status" … text-amber-800`(`:197`·`:205`) → `<Callout variant="warn" role="status" className="mb-4">…</Callout>`. `:205`는 `className="mb-4 flex items-center justify-between gap-3"`로 flex 보존(자식 `<span>`+`<button>` 동작 0-diff).
- **동결**: slate 로딩 박스 `:257`(`bg-slate-50` role=status)·`StatusBadge`(`:127`)·`VerdictBadge`(`:128`)·raw 프로필 `<li>`·차트.

- [ ] **Step 4: 게이트** — Run: `cd ui && pnpm test RunDetailPage && pnpm lint && pnpm build` → PASS.

- [ ] **Step 5: 커밋**
```bash
git add ui/src/pages/RunDetailPage.tsx ui/src/pages/__tests__/RunDetailPage.test.tsx
git commit -m "refactor(ui): RunDetailPage 알림 → Callout"
```

---

## Task 4: WorkerDashboardPage

**Files:**
- Modify: `ui/src/pages/WorkerDashboardPage.tsx` (`ConfirmDialog`·`EditModal` 내부 + 페이지 레벨 박스 + `EditModal` 입력)
- Test: `ui/src/pages/__tests__/WorkerDashboardPage.test.tsx`

**Interfaces:**
- Consumes: `Callout` from `../components/ui/Callout`, `Input` from `../components/ui/Input`.

- [ ] **Step 1: 테스트 먼저** — `WorkerDashboardPage.test.tsx`에 ① 경고/오류 박스 role 보존, ② `EditModal` 입력이 `getByLabelText(title)`로 여전히 잡힘을 핀하는 단언 추가(없으면). `EditModal`은 워커 행의 편집 액션으로 열리는 컴포넌트 — 기존 테스트가 여는 경로 재사용.

- [ ] **Step 2: 테스트 실행** — Run: `cd ui && pnpm test WorkerDashboardPage` → 통과.

- [ ] **Step 3: src 변환** (`WorkerDashboardPage.tsx`)

`Callout`·`Input` import 추가. 변환(spec §4.4):
- 경고 박스 **roleless** `bg-amber-50 text-amber-800`(`:43`, `ConfirmDialog` 내) → `<Callout variant="warn" className="mb-3">{warn}</Callout>` (role 미부여).
- 오류 박스 `role="alert" bg-red-50 text-red-700`(`:46` `ConfirmDialog`·`:116` `EditModal`·`:426` 페이지) → `<Callout variant="error" role="alert" className="mb-3">…</Callout>`. `:426`는 `className="mb-3 flex items-center justify-between"`로 flex 보존.
- borderless 오류 `<p role="alert">{ko.workers.loadError}</p>`(`:402`) → `<Callout variant="error" role="alert">{ko.workers.loadError}</Callout>`.
- `EditModal` 입력(`:106`) `<input type={inputType} className="mb-2 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" aria-label={title} value={val} onChange={…}>` → `<Input className="mb-2" type={inputType} aria-label={title} value={val} onChange={(e) => setVal(e.target.value)} />` (BASE가 `w-full rounded-md border px-2 py-1 text-sm`+focus/invalid 제공 → 중복 클래스 제거, `mb-2`만 className).
- **동결**: slate 로딩 텍스트 `:398`(role=status)·인라인 status 배지(`:465`/`:473`/`:504`)·기존 `bg-blue-600`/`text-blue-600` 버튼·링크(`:63`/`:132`/`:485`).

- [ ] **Step 4: 게이트** — Run: `cd ui && pnpm test WorkerDashboardPage && pnpm lint && pnpm build` → PASS.

- [ ] **Step 5: 커밋**
```bash
git add ui/src/pages/WorkerDashboardPage.tsx ui/src/pages/__tests__/WorkerDashboardPage.test.tsx
git commit -m "refactor(ui): WorkerDashboardPage 알림 → Callout, EditModal 입력 → Input"
```

---

## Task 5: ScenarioComparePage + compare/{CompareMatrix,CompareOverlaySection}

**Files:**
- Modify: `ui/src/pages/ScenarioComparePage.tsx`, `ui/src/components/compare/CompareMatrix.tsx`, `ui/src/components/compare/CompareOverlaySection.tsx`
- Test: `ui/src/pages/__tests__/ScenarioComparePage.test.tsx`, `ui/src/components/compare/__tests__/CompareMatrix.test.tsx`, `ui/src/components/compare/__tests__/CompareOverlaySection.test.tsx`

**Interfaces:**
- Consumes: `Callout` from `../components/ui/Callout`(페이지) / `../ui/Callout`(compare 컴포넌트).

> 3 파일 = 각 독립 커밋 권장(한 task 안에서 순차). 각 파일 테스트 먼저 → src → 게이트 → 커밋.

- [ ] **Step 1: ScenarioComparePage** — 테스트 먼저(오류 분기 role 보존 단언) → src 변환:
  - `:75` `<p role="alert" text-red-600>` → `<Callout variant="error" role="alert">…</Callout>`
  - `:217` 오류 박스 `role="alert" bg-red-50 text-red-700`(`mb-4`) → `<Callout variant="error" role="alert" className="mb-4">…</Callout>`
  - **동결**: slate 로딩 `<p role="status" text-slate-600>`(`:62`)·`runLabel`·`InsightCompareMatrix`.
  → `cd ui && pnpm test ScenarioComparePage && pnpm lint && pnpm build` → 커밋(`ScenarioComparePage.tsx` + 그 test).

- [ ] **Step 2: CompareMatrix** — 테스트 먼저(경고 박스 role=status 보존) → src 변환:
  - `:112` 경고 박스 `role="status" bg-amber-50 text-amber-700`(`mb-4`) → `<Callout variant="warn" role="status" className="mb-4">…</Callout>` (import `../ui/Callout`).
  - **동결**: Δ 폴라리티 색·`runColor` 스와치·`<colgroup>` 테이블 구조.
  → `cd ui && pnpm test CompareMatrix && pnpm lint && pnpm build` → 커밋.

- [ ] **Step 3: CompareOverlaySection** — 이 파일은 **변환 대상이 없다**(plain status `:43`·checkbox `:26` 모두 동결). spec §4.7 재확인 후 **변경 없음이면 이 파일은 건너뛴다**(diff 0). 단 spec이 적은 대로 다른 변환이 없으면 커밋 불필요. (만약 재확인에서 변환할 tinted 박스가 발견되면 위 패턴 적용.)

- [ ] **Step 4: 그룹 게이트** — Run: `cd ui && pnpm test compare ScenarioComparePage && pnpm lint && pnpm build` → PASS.

---

## Task 6: ReportView

**Files:**
- Modify: `ui/src/components/report/ReportView.tsx`
- Test: `ui/src/components/report/__tests__/ReportView.test.tsx`

**Interfaces:**
- Consumes: `Callout` from `../ui/Callout`.

- [ ] **Step 1: 테스트 먼저** — `ReportView.test.tsx`에 다운로드 실패 배너(`dlErr`)가 `getByRole("alert")`로 잡힘을 핀하는 단언 추가(없으면). 다운로드 실패를 트리거하는 기존 테스트 경로 재사용(`downloadFile` mock reject 등).

- [ ] **Step 2: 테스트 실행** — Run: `cd ui && pnpm test ReportView` → 통과.

- [ ] **Step 3: src 변환** (`ReportView.tsx`)

`import { Callout } from "../ui/Callout";` 추가.
- 다운로드 실패 배너 `:147` `role="alert" border border-red-200 bg-red-50 text-red-700`(`mb-4`, `dlErr`) → `<Callout variant="error" role="alert" className="mb-4">…</Callout>`.
- **동결**: `VerdictPanel`(`:154`)·자식 차트/표(`report/*`)·plain 표시 카드(Section 비대상).

- [ ] **Step 4: 게이트** — Run: `cd ui && pnpm test ReportView && pnpm lint && pnpm build` → PASS.

- [ ] **Step 5: 커밋**
```bash
git add ui/src/components/report/ReportView.tsx ui/src/components/report/__tests__/ReportView.test.tsx
git commit -m "refactor(ui): ReportView 다운로드 실패 배너 → Callout"
```

---

## Task 7: 슬라이스 마무리 — 전체 게이트 + 불변식 grep + 라이브

**Files:** (코드 변경 없음 — 검증·문서)

- [ ] **Step 1: 전체 UI 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 PASS(전체 스위트 — 타깃-green ≠ full-green 함정 방지, `ui/CLAUDE.md`).

- [ ] **Step 2: 불변식 grep (orchestrator가 직접 재실행 — self-report 불신)**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/design-system-screens
# R2 토대 0-diff
git diff --name-only master..HEAD | grep -E 'components/ui/|tailwind.config.ts|Button.tsx' && echo "FAIL: 토대 변경" || echo "OK: 토대 0-diff"
# R10 와이어 0-diff
git diff --name-only master..HEAD | grep -E 'crates/|\.proto$|\.sql$|ui/src/api/|schemas.ts' && echo "FAIL: 와이어 변경" || echo "OK: 와이어 0-diff"
# R9 RunListControls 0-diff
git diff --name-only master..HEAD | grep -E 'RunListControls' && echo "FAIL: 툴바 변경" || echo "OK: 툴바 0-diff"
# R8 severity 팔레트 0-diff
git diff master..HEAD -- ui/src/components/report/InsightPanel.tsx ui/src/components/compare/InsightCompareMatrix.tsx | grep -E '^[+-]' && echo "CHECK: severity 변경 여부" || echo "OK: severity 0-diff"
# R11 신규 accent drift — 변환 박스에 blue/indigo 신규 0(수동 diff 리뷰)
# R12 인라인 영어 0(신규)
```
Expected: 토대·와이어·툴바·severity 전부 OK. (변환 박스에 신규 blue/indigo·인라인 영어 0은 diff 리뷰로.)

- [ ] **Step 3: 라이브 검증(경량)** — `/live-verify`

워크트리 자체 바이너리(`cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller`) + `ui/dist`(`just ui-build`) + Playwright로:
- RunDetail에서 실제 report 뷰 렌더(정상 경로 console 에러 0).
- run 목록 진입 + 필터/정렬 라운드트립(RunListControls 동결 확인 — 동작 무변경).
- 변환된 Callout(예: 오류 유도 또는 정상 화면)에서 `role` 보존·accent 포커스 링 가시.
- 근거: run-생성/report-파싱/Zod 경로 비해당(읽기-표시) → S-D Zod 갭 부재. production diff가 표시-only라 라이브는 회귀 스모크 수준.

- [ ] **Step 4: 마무리 문서(= `/finish-slice`가 수행)**

`/finish-slice`로: build-log.md 단락 append · roadmap §B12 완료 항목 이동(결과·표시 화면군) + 새 연기 적재(에디터/Inspector·`RunListControls` 컴팩트 variant·success Callout variant·status Badge tone·severity 팔레트) · 루트 CLAUDE.md 상태줄 1줄 교체 · 메모리 기록 · ff-merge.

---

## 최종 리뷰 (구현 후, 머지 전)

- **whole-branch `handicap-reviewer`**(Opus, 1M 세션이면 명시 `model: opus`): cross-page 일관성 필수 검증 — **roleless 로드 오류 4곳(`:35`/`:138`/`:82`/`Worker:402`)이 전부 Callout로 통일됐는지**(design-system-spread가 놓친 트랩, `ui/CLAUDE.md`)·role 1:1·토대/와이어 0-diff·동결 surface 무변경.
- **security-reviewer**: N/A 예상(요청실행·템플릿·env/dataset 바인딩·업로드·trace 뷰어 비해당 — `finish-slice §0` grep이 트리거; 매치 0이면 스킵).
- per-task 리뷰(spec-compliance + code-quality): 이 task들은 UI JSX className 교체라 **path-gated 아님 → Sonnet**으로 충분(engine/concurrency/proto/template/migration 비해당). 미묘하면 self-flag로 Opus 재패스.

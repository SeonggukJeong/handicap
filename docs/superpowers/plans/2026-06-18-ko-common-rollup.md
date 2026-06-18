# ko.common 한국어화 일괄 롤업 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ui/src에 잔존한 모든 하드코딩 사용자 노출 문구(영어 + 카탈로그 밖 인라인 한국어)를 `ko.ts` 카탈로그 경유 한국어로 전수 이전한다.

**Architecture:** 순수 UI 문구 치환. `ko.ts`에 `common` 네임스페이스를 신설(크로스커팅 동작/상태만)하고, 도메인 라벨은 기존 도메인 네임스페이스(`editor`/`report`/`runDetail` 등)에 추가한다. 엔진/proto/controller/migration/와이어/run 페이로드 무변경(byte-identical) — 머지 diff는 `ui/`(+ 마무리 docs) 한정.

**Tech Stack:** TypeScript/React, Vitest + React Testing Library, ESLint(`--max-warnings=0`), `tsc -b`. 카탈로그 = `ui/src/i18n/ko.ts`(`export const ko = {...} as const`).

**Spec:** `docs/superpowers/specs/2026-06-18-ko-common-rollup-design.md` (R1–R8).

## Global Constraints

- **정규 범위 = grep, §아님**: 무엇이 "끝"인지는 R1 grep(잔존 0)이 정의한다. 각 추출 task는 그 파일군에 grep을 몰아 **모든** 영어/인라인 문구를 치환한다 — 아래 string→key 표는 *알려진* 매핑이고, 표에 없어도 grep이 잡으면 같은 정책으로 치환한다. (R1)
- **`common`은 크로스커팅 동작/상태만**(loading/save/cancel/delete/…). 도메인 한정 라벨(Name/Method/VUs/Duration/표 헤더…)은 단어가 겹쳐도 도메인 네임스페이스. (R2)
- **영어로 남기는 것(R3)**: `VU`/`RPS`/`p50·p95·p99`, HTTP 메서드 값(GET/POST), `YAML`, `URL`, `Set-Cookie`, `#`. placeholder의 예시 *값*(`${BASE_URL}`/`staging`/`http://localhost:9090`/`var_name`/`left`/`right`)은 리터럴 유지, 영어 *라벨 조각*(`value (e.g. …)`)은 한국어화.
- **R4 통일/재사용**: 제네릭 배너 `Failed to load:`·`Failed:` → `ko.common.failedToLoad(msg)`; `Not found.` → `ko.common.notFound`; `Loading…`/`Loading runs…` → `ko.common.loading`. 이미 ko 키가 있는 인라인 문구는 **기존 키 재사용**(예: `Data binding` aria → `ko.binding.sectionTitle`; `Starting…` → `ko.runDialog.running`). **기존 도메인 실패/취소/저장 키는 마이그레이션하지 않는다**(R5 최소 diff; `common.*`와 도메인 `cancel`/`save` 공존 허용 = 독립 편집 표면).
- **R8 와이어 불변식**: 라벨/텍스트/`aria-label`/`title`만 번역. `<option value=…>`의 `value`, `Tab` 상태 `tab=`, enum/discriminant 키, `data-testid`는 **절대** 안 건드린다 — 라벨과 값이 같은 문자열이어도(HTTP 메서드 `value={m}`) 값은 원형 보존.
- **R6 RTL lockstep**: 문구 바꾼 파일의 테스트 셀렉터(`getByRole({name})`/`getByText`/`getByLabelText`)를 한국어로 갱신. **함정**: 대소문자무시 정규식(`/Add/i`·`/repeat/i`·`/No env vars/i`)은 번역 후 *조용히* 안 맞으니 regex 셀렉터까지 갱신.
- **게이트(매 task)**: `cd ui && pnpm lint && pnpm test && pnpm build` 전부 green(`pnpm lint`는 `--max-warnings=0`). cargo 무관(순수 ui/).
- **커밋**: 파이프(`| tail`) 없이 — git exit code 가시성. 각 task 독립 green 커밋.

---

### Task 1: `ko.common` 네임스페이스 + 헤더 컨벤션 갱신

**충족 R:** R2, R4, R7

**Files:**
- Modify: `ui/src/i18n/ko.ts` (`export const ko = {...}` 안에 `common` 키 추가; 헤더 주석 1줄)
- Test: 없음(이 task는 카탈로그 데이터만 추가; 소비처 0 → `as const` 객체라 dead-key lint 없음, 기존 `pnpm test`/`build` 통과로 충분)

**Interfaces:**
- Produces (이후 task가 소비): `ko.common.{ loading, loadingRuns, failedToLoad(msg), notFound, save, saving, cancel, close, delete, edit, add, remove, moveUp, moveDown, abort, aborting, parsing }`. `failedToLoad`는 `(msg: string) => string`(기존 `ko.stepTemplates.loadFailed` 시그니처 미러).

- [ ] **Step 1: `common` 네임스페이스 추가**

`ko.ts`의 `export const ko = {` 바로 아래(첫 키 `glossary` 앞 또는 뒤 — 알파벳 무관, 파일 상단 권장)에 추가. 함수 키는 기존 `loadFailed: (msg) => ...` 패턴과 동일.

```ts
  // 크로스커팅 UI 동작/상태 — 의미가 어디서나 동일한 것만(ADR-0035, spec R2).
  // 도메인 한정 라벨(Name/Method/VUs/표 헤더 등)은 여기 두지 말고 도메인 네임스페이스로.
  common: {
    loading: "불러오는 중…",
    loadingRuns: "실행 목록 불러오는 중…",
    failedToLoad: (msg: string) => `불러오기 실패: ${msg}`,
    notFound: "찾을 수 없습니다.",
    save: "저장",
    saving: "저장 중…",
    cancel: "취소",
    close: "닫기",
    delete: "삭제",
    edit: "편집",
    add: "추가",
    remove: "제거",
    moveUp: "위로",
    moveDown: "아래로",
    abort: "중단",
    aborting: "중단 중…",
    parsing: "분석 중…",
  },
```

> 이후 task가 grep으로 다른 *제네릭* 문구(예: `Close`)를 발견하면 여기 키를 추가한다. 도메인 한정 문구(예: `Save dataset`·`Waiting for first batch…`)는 여기 말고 도메인 네임스페이스(T2/T4)에.

- [ ] **Step 2: 헤더 컨벤션 주석 갱신 (R7)**

`ko.ts` 상단 주석 블록의 이 줄을:

```ts
 * - 신규·변경 문구는 이 카탈로그 경유로 작성한다 (기존 미변경 문구의 소급 추출은 비목표).
```

다음으로 교체:

```ts
 * - 모든 사용자 노출 문구(본문·버튼·표 헤더·placeholder·aria-label·title·배너)는 이 카탈로그 경유다 — 인라인 영어/한국어 금지. (기술 고유명사 VU/RPS/p95/YAML/URL 등은 원어 유지 + 설명 병기.)
```

- [ ] **Step 3: 게이트 통과 확인**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 green(미사용 `common` 키는 `as const` 객체라 lint 무경고).

- [ ] **Step 4: Commit**

```bash
git add ui/src/i18n/ko.ts
git commit -m "feat(ui): add ko.common namespace + strengthen catalog convention (R2,R4,R7)"
```

---

### Task 2: 페이지 로딩/에러/빈상태 배너 (~21곳)

**충족 R:** R1, R4

**Files (modify):** `ui/src/pages/DatasetsPage.tsx`, `ScenarioRunsPage.tsx`, `RunDetailPage.tsx`(banner만 — 카드/표는 T4), `TemplatesPage.tsx`, `SettingsPage.tsx`, `SchedulesPage.tsx`, `ScenarioEditPage.tsx`, `ScenarioListPage.tsx`, `EnvironmentsPage.tsx`, `ScenarioComparePage.tsx`, `ui/src/components/ScheduleEventTimeline.tsx`, `ui/src/components/DataBindingPanel.tsx`(`<option disabled>Loading…`만 — 나머지 DataBindingPanel은 T6), `ui/src/components/scenario/InsertTemplateModal.tsx`
- 각 파일이 `import { ko } from "../i18n/ko"`(또는 상대 깊이) 안 돼 있으면 추가.
- Test: 위 파일들의 `__tests__` 중 배너 문구를 단언하는 것(있으면) 셀렉터 갱신.

**Interfaces:** Consumes `ko.common.{loading,loadingRuns,failedToLoad,notFound}`(T1), `ko.runDialog.running`(기존).

**Known string→key (grep으로 잔존 0까지 — 표는 알려진 것):**

| 현재 문자열 | 위치(예) | → 키 |
|---|---|---|
| `Loading…` | DatasetsPage:47, ScenarioRunsPage:110, RunDetailPage:78, TemplatesPage:155, SettingsPage:152, SchedulesPage:159, ScenarioEditPage:57, ScenarioListPage:34, EnvironmentsPage:230, ScheduleEventTimeline:20, DataBindingPanel:517(`<option disabled>`), InsertTemplateModal:202 | `ko.common.loading` |
| `Loading runs…` | ScenarioRunsPage:163 | `ko.common.loadingRuns` |
| `Failed to load: {(error as Error).message}` | DatasetsPage:48, ScenarioListPage:35, EnvironmentsPage:231, SchedulesPage:161 | `ko.common.failedToLoad((error as Error).message)` |
| `Failed: {(error as Error).message}` | ScenarioEditPage:58 | `ko.common.failedToLoad((error as Error).message)` |
| `Not found.` | ScenarioRunsPage:112, RunDetailPage:80, ScenarioEditPage:59 | `ko.common.notFound` |

> ScenarioComparePage(:56 부근)·InsertTemplateModal에 다른 영어 배너/빈상태가 있으면 같은 정책으로(`ko.common.*` 또는 도메인). TemplatesPage는 이미 `ko.stepTemplates.loadFailed`를 쓰므로(그건 도메인 키, 유지) loading만 손댄다.

- [ ] **Step 1: 한 파일에서 배너 치환 (대표 패턴)**

`ScenarioEditPage.tsx`:57-59 예:

```tsx
// before
  if (isLoading) return <p className="text-slate-500">Loading…</p>;
  if (error) return <p className="text-red-600">Failed: {(error as Error).message}</p>;
  if (!data) return <p className="text-slate-500">Not found.</p>;
// after
  if (isLoading) return <p className="text-slate-500">{ko.common.loading}</p>;
  if (error) return <p className="text-red-600">{ko.common.failedToLoad((error as Error).message)}</p>;
  if (!data) return <p className="text-slate-500">{ko.common.notFound}</p>;
```

- [ ] **Step 2: 위 표 + grep으로 나머지 페이지/컴포넌트 전부 치환**

Run(잔존 확인): `cd ui/src && grep -rn -E 'Loading…|Loading runs…|Failed to load:|Failed: \{|Not found\.' --include='*.tsx' pages components | grep -v __tests__ | grep -vE 'ko\.common'`
Expected(치환 후): (빈 출력 — 단 `Failed:` 가 다른 의미로 쓰인 곳 없는지 눈으로 확인)

- [ ] **Step 3: 테스트 셀렉터 갱신**

이 페이지들의 테스트가 `getByText(/Loading|Failed|Not found/i)` 류로 단언하면 한국어로(`/불러오는 중/`·`/불러오기 실패/`·`/찾을 수 없/`). Run: `cd ui && pnpm test pages` 로 깨진 셀렉터 식별 후 수정.

- [ ] **Step 4: 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages ui/src/components/ScheduleEventTimeline.tsx ui/src/components/DataBindingPanel.tsx ui/src/components/scenario/InsertTemplateModal.tsx
git commit -m "feat(ui): localize page loading/error/empty banners via ko.common (R1,R4)"
```

---

### Task 3: `Inspector.tsx` (스텝 설정 패널)

**충족 R:** R1, R2, R8

**Files:**
- Modify: `ui/src/components/scenario/Inspector.tsx`
- Test: `ui/src/components/scenario/__tests__/Inspector.test.tsx`(셀렉터 lockstep — `/Add/i`·`/repeat/i`·`/add elif/i`·`/remove elif 1/i`·`/think min/i`·`/add branch/i`·`json body` 등 다수)

**Interfaces:** Consumes `ko.common.{delete,moveUp,moveDown,add,remove,edit}`(T1) + 신규 `ko.editor.*` 키.

**정책:**
- 필드 라벨·빈상태·조건 빌더 aria → `ko.editor.*`(도메인). 버튼 동작(Delete/Move up/Move down) → `ko.common.*`; 단 `Delete step`/`Delete loop`/`Delete if`/`Delete parallel` 같은 *대상 명시 title*은 도메인 함수/키(`ko.editor.deleteStep` 등) — 제네릭 `삭제`(버튼 라벨)는 `ko.common.delete`.
- 보간 aria는 **함수 키**: `Remove assertion/extract/elif ${idx}`·`Elif ${i+1}`·`Add step to ${label}`/`Add loop to ${label}` → `ko.editor.removeElif(i)` 식.
- **R8**: `<option value="body">body</option>`·`<option value="all">ALL (AND)</option>` 등에서 `value=`는 절대 안 건드린다 — 라벨 텍스트만(여기선 `body`/`ALL (AND)`이 표시이자 코드값 경계라, 표시 라벨만 한국어화하되 `value` 속성 보존).
- **F9 ruling (extract/body 옵션 라벨)**: `<option value="body|header|cookie|status">…</option>`(:676-679)·body kind 옵션의 **표시 라벨은 한국어화**("본문"/"헤더"/"쿠키"/"상태" 등, `ko.editor.*`), `value=`는 보존(R8). 단일 기술 토큰이라도 기본 한국어(ko-우선); 한국어가 외려 모호하면 그때만 원어(드묾).
- **인라인 lowercase 본문도 대상**: `override`(:90류는 EnvironmentPicker=T5), `+ condition`(:1127), `from {selectedName}`(:65류=T5) 같은 소문자-시작 JSX 텍스트도 카탈로그로 — T6 grep #2가 소문자-시작을 놓치니(F5) **이 파일은 grep 의존 말고 눈으로 sweep**.

**Known string→key (대표 — grep으로 잔존 0):**

| 현재 | 위치(예) | → 키 |
|---|---|---|
| `Name` (필드) | :235,847,940,1272 | `ko.editor.fieldName` |
| `Method` | :249 | `ko.editor.fieldMethod`("메서드") — **신규 도메인 키**(R2 "단어 겹쳐도 도메인": `ko.report.colMethod`와 별도, 재사용 안 함) |
| `Timeout (s)` | :281 | `ko.editor.fieldTimeout` |
| `Think min (ms)`/`Think max (ms)` | :293,304 | `ko.editor.fieldThinkMin`/`fieldThinkMax` |
| `Repeat` | :948 | `ko.editor.fieldRepeat` |
| `Then`/`Else` | :1289,1332 | `ko.editor.condThen`/`condElse` |
| `Request`/`Headers`/`No headers`/`Header`/`value` legends·라벨 | :244,327-344 | `ko.editor.*` |
| `No assertions`/`No extracts`/`No steps` | :545,712,968,1217 | `ko.editor.*Empty` |
| `Move up`/`Move down` | :140,146 | `ko.common.moveUp`/`moveDown` |
| `Delete`(버튼) | :228,840,933,1265 | `ko.common.delete` |
| `Delete step`/`loop`/`if`/`parallel`(title) | :229,841,934,1266 | `ko.editor.deleteStep`/`deleteLoop`/`deleteIf`/`deleteParallel` |
| `Add branch`/`Add step to loop body`/`Add if to loop body` | :870,973,985 | `ko.editor.*` |
| `Remove assertion/extract/elif ${idx}`·`Elif ${i+1}` | :531,704,1305,1302 | `ko.editor.*` (함수 키) |
| 인라인 `min=max면 고정 지연…` | :315 | `ko.editor.*`(인라인 한국어도 카탈로그로) |

- [ ] **Step 1: 필요한 `ko.editor.*` 키 추가**

`ko.ts`의 `editor:` 네임스페이스에 위 표의 신규 키를 추가(기존 `editor` 키 컨벤션 따름; 보간은 `(n: number) => ...` 함수). `Method`는 의미 동일한 기존 키 있으면 재사용(R4).

- [ ] **Step 2: Inspector.tsx 치환**

대표 패턴:

```tsx
// before
<Field label="Name" ...>
<button title="Move up" .../>
<option value="all">ALL (AND)</option>
// after
<Field label={ko.editor.fieldName} ...>
<button title={ko.common.moveUp} .../>
<option value="all">{ko.editor.condAll}</option>   {/* value="all" 보존(R8) */}
```

- [ ] **Step 3: grep 잔존 확인**

Run: `cd ui/src && grep -nE 'aria-label="[A-Za-z]|title="[A-Z]|>[A-Z][a-z]+ ?[a-z]*<|label="[A-Za-z]' components/scenario/Inspector.tsx | grep -vE 'ko\.'`
Expected: R3 토큰(URL/HTTP 메서드 value 등)만 남고 영어 라벨 0.

- [ ] **Step 4: 테스트 셀렉터 lockstep**

`Inspector.test.tsx`의 영어/regex 셀렉터를 한국어로. **목록은 illustrative — `pnpm test Inspector`를 돌려 *빨개진 셀렉터 전부* 고친다**(예: `/Add/i`·`/repeat/i`·`/wrap in group/i`·`/\+ condition/i`·`/remove condition/i`×4·`"Format"`·`/add step to else|branch/i`·`/remove branch/i`·`"Name"` exact·`/Remove extract 0/i`·`/add elif/i`·`/remove elif 1/i`·`/think min/i`·`/add branch/i`). Run: `cd ui && pnpm test Inspector`(단일 파일 — `--` 없이). Expected: PASS.

- [ ] **Step 5: 게이트 + Commit**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
git add ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/__tests__/Inspector.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): localize Inspector labels/actions via ko.editor+common (R1,R2,R8)"
```

---

### Task 4: RunDetailPage + ScenarioRunsPage + report 컴포넌트

**충족 R:** R1, R2, R8

**Files (modify):**
- `ui/src/pages/RunDetailPage.tsx`(카드/표 헤더/aria — 배너는 T2서 완료), `ui/src/pages/ScenarioRunsPage.tsx`(열 헤더)
- `ui/src/components/report/`: `Summary.tsx`(aria `Report summary`:41), `TimeSeriesChart.tsx`(보간 aria `` Time series — ${title} ``:18), `StepStatsTable.tsx`, `BranchStatsTable.tsx`, `StatusDistribution.tsx`, `LatencyHistogramChart.tsx`, `PercentileCurveChart.tsx`, `CompareMatrix.tsx`(compare 디렉터리), `TestRunPanel.tsx`, `GroupLatencyTable.tsx`, `ScenarioSnapshot.tsx`, `InsightPanel.tsx`, `ReportView.tsx`(title `Requests / second`:166·`p95 response time`:171·`Errors / second`:176), `VerdictPanel.tsx`(`Result` th:29)
- Test: 각 컴포넌트의 `__tests__`(특히 `StatusDistribution`/`ReportView`/`LatencyHistogramChart` — `Status codes`/`Branch decisions`/`No latency data` 등 단언)

**Interfaces:** Consumes `ko.common.{abort,aborting}`, `ko.runDialog.running`(=`Starting…`), 신규 `ko.report.*`/`ko.runDetail.*`.

**Known string→key (대표):**

| 현재 | 위치(예) | → 키 |
|---|---|---|
| 카드 `VUs`/`Duration`/`Total requests`/`Errors`/`Avg RPS`/`Created`/`Profile`/`Metric windows` | RunDetailPage:206-296 | `ko.report.card*`/`ko.runDetail.*`(VUs/Duration 등은 기존 `ko.report.colStep` 류 컨벤션) |
| `Run`(heading)/`Env`(aria+heading) | RunDetailPage:127,364-365 | `ko.runDetail.*` |
| `Abort`/`Aborting…` | RunDetailPage:139 | `ko.common.abort`/`aborting` |
| `Starting…` | RunDetailPage:159 | `ko.runDialog.running`(재사용, R4) |
| `No metrics recorded.`/`Waiting for first batch…` | RunDetailPage:299 | `ko.runDetail.noMetrics`/`waitingFirstBatch` |
| `No env vars were sent.` | RunDetailPage:367 | `ko.runDetail.noEnvSent` |
| 표 헤더 `#`(R3 유지)/`Name`/`Method`/`URL`(R3)/`Requests`/`Errors`/`Second`/`Step`/`Count`/`Status codes` | RunDetailPage:263-309 | `ko.report.col*` |
| 인라인 `실패 사유:`/`Report 로드 실패:`/`리포트 생성 중…` | RunDetailPage:222,235,243 | `ko.runDetail.*`(인라인 한국어/혼합도 카탈로그로) |
| run 목록 `Status`/`VUs`/`Duration`/`Created` | ScenarioRunsPage:252-256 | `ko.report.col*` |
| `Branch decisions`(aria+heading) | BranchStatsTable:39-40 | `ko.report.colIfNode` 재사용 검토 / 신규 |
| `Status codes`/`No status data.` | StatusDistribution:16-18 | `ko.report.*` |
| `No latency data.` | LatencyHistogramChart:26 | `ko.report.*` |
| `Steps`/`Per-step stats` | StepStatsTable:32-33 | `ko.report.*` |
| `Request headers`/`Response headers`/`Set-Cookie`(R3 유지) | TestRunPanel:341-359 | `ko.report.*` |
| `Summary`/`Steps`/`Status` | CompareMatrix:169-175 | `ko.report.*` |
| `VerdictPanel` `Result` 등 / `ReportView` `title="Requests / second"` | VerdictPanel:29, ReportView:166,176 | `ko.report.*` |

- [ ] **Step 1: `ko.report`/`ko.runDetail` 키 추가** (위 표; 기존 `report`/`runDetail` 네임스페이스 컨벤션. `#`·`URL`·`Set-Cookie`는 R3로 키 안 만듦).
- [ ] **Step 2: RunDetailPage + ScenarioRunsPage + report 컴포넌트 치환** (R8: `<th>#</th>`·`<td>URL</td>` 표시 토큰·`value=` 보존).
- [ ] **Step 3: grep 잔존 확인**

Run: `cd ui/src && grep -rnE 'aria-label="[A-Za-z]|title="[A-Z][a-z]|>[A-Z][a-z]+( [A-Za-z]+)*<' pages/RunDetailPage.tsx pages/ScenarioRunsPage.tsx components/report components/compare | grep -v __tests__ | grep -vE 'ko\.'`
Expected: R3 토큰만 잔존.

- [ ] **Step 4: 테스트 셀렉터 lockstep** — **목록 illustrative; 단일파일 테스트로 빨개진 것 전부 수정**. `report` 테스트는 region/aria 라벨도 단언(`Status distribution`·`Report summary`·`` Time series — … ``·`Latency histogram`·`Per-step stats`·`Toggle loop breakdown`[StepStatsTable.test:88]). Run: `cd ui && pnpm test report` 와 `pnpm test RunDetail` 로 깨진 곳 수정.
- [ ] **Step 5: 게이트 + Commit**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
git add ui/src/pages/RunDetailPage.tsx ui/src/pages/ScenarioRunsPage.tsx ui/src/components/report ui/src/components/compare ui/src/i18n/ko.ts
git commit -m "feat(ui): localize run-detail/run-list/report surfaces via ko.report+runDetail (R1,R2,R8)"
```

---

### Task 5 (격리): `EnvironmentPicker.tsx` + 소비처 테스트 cascade

**충족 R:** R1, R2, R6

**Files:**
- Modify: `ui/src/components/EnvironmentPicker.tsx`
- Test (lockstep): `ui/src/components/__tests__/EnvironmentPicker.test.tsx`(primary), `ui/src/components/__tests__/RunDialog.test.tsx`(picker aria를 `getByLabelText("env key 0")`/`/Remove env BASE_URL/i`/`/Environment variables/i`로 단언). `ScheduleForm.test.tsx`·`TestRunSection.test.tsx`는 picker를 렌더만 하고 aria 단언 안 함(render-only) — 깨지지 않지만 게이트로 함께 확인.

**Interfaces:** Consumes `ko.common.{add,remove}`; 신규 도메인 키(env picker용). `Data binding`류와 달리 picker 전용 키 묶음.

**Known string→key:**

| 현재 | 위치 | → 키 |
|---|---|---|
| `No env vars`/인라인 `이 환경엔 변수가 없습니다` | :146,97 | env picker 키(예: `ko.runDialog.envNoVars` 또는 신규) |
| aria `Environment variables` | :42 | 키 |
| aria `select environment`/`new env key`/`new env value` | :49,151,159 | 키 |
| aria 함수 `Remove env ${key}`/`env key ${idx}`/`env value ${idx}` | :138,112,123 | 함수 키 `removeEnv(key)`/`envKey(i)`/`envValue(i)` |
| 본문 `override`/`Env`/`Add`/인라인 `from … (읽기 전용)`/`override (이 run 한정)`/`재정의됨`/`재정의` | :90,104,177,65,83,133 | `ko.common.add` + 도메인 키 |
| placeholder `BASE_URL`/`http://localhost:9090` | :153,161 | **R3 유지(변경 안 함)** |

- [ ] **Step 1: 필요한 키 추가** (env picker 라벨/aria/함수 키). 기존 `ko.runDialog`에 env 섹션 키가 있으면 거기, 없으면 신규 묶음. `Add`는 `ko.common.add`.
- [ ] **Step 2: EnvironmentPicker.tsx 치환** (placeholder 예시 값은 R3로 유지).
- [ ] **Step 3: grep 잔존 확인**

Run: `cd ui/src && grep -nE 'aria-label="[A-Za-z]|placeholder="[A-Za-z]|>[A-Za-z]' components/EnvironmentPicker.tsx | grep -vE 'ko\.|BASE_URL|localhost'`
Expected: R3 placeholder만 잔존.

- [ ] **Step 4: 소비처 테스트 lockstep** — `EnvironmentPicker.test.tsx` + `RunDialog.test.tsx`의 picker aria 셀렉터를 한국어로. **RunDialog.test.tsx만 ~15개 env 셀렉터**: regex(`/No env vars/i`·`/Environment variables/i`·`/Remove env BASE_URL/i`) + **exact `"Add"`**(:64,100,128,143) + **`getByLabelText("env key 0"/"env value 0"/"new env key"/"new env value")` family**(:66,67,130,131,332-334) — `Add`→`추가`, env aria→한국어 함수키로 전부 깨지니 함께 flip. Run: `cd ui && pnpm test EnvironmentPicker` 후 `pnpm test RunDialog`(둘 다 PASS까지).
- [ ] **Step 5: 게이트 + Commit**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
git add ui/src/components/EnvironmentPicker.tsx ui/src/components/__tests__/EnvironmentPicker.test.tsx ui/src/components/__tests__/RunDialog.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): localize EnvironmentPicker labels/aria + lockstep consumer tests (R1,R6)"
```

---

### Task 6: 나머지 grep-driven + R1 전수 하드 게이트

**충족 R:** R1, R2, R4, R5, R8

**Files (modify, grep-driven — 경로는 실행 전 `ls`로 확인, `components/` vs `components/scenario/` 혼재):** `ui/src/components/scenario/TabBar.tsx`, `ui/src/components/datasets/UploadPanel.tsx`, `ui/src/components/DataBindingPanel.tsx`(aria/본문 잔여 — Loading은 T2), `ui/src/components/RunDialog.tsx`(잔존 aria `load preset`/`preset name` — 본문은 이미 `ko.runDialog`), `ui/src/components/TriggerBuilder.tsx`, `ui/src/components/ScheduleForm.tsx`(**`scenario/` 아님**), `ui/src/components/scenario/BulkEditPanel.tsx`, `ui/src/components/scenario/ExtractConfirmRow.tsx`, `ui/src/components/scenario/VariablesPanel.tsx`(보간 aria `Remove variable ${key}`:38), + grep이 잡는 그 외 전부.
- Test: 각 파일 `__tests__`(`TabBar.test`/`EditorShell.test`의 `getByRole("tab",{name:"Canvas"/"YAML"})`·`DataBindingPanel.test`의 `getByLabelText("dataset"/"policy")` 등).

**정책 핵심:**
- `TabBar`: `label="Canvas"` → `ko.editor.tabCanvas`("캔버스"); `label="YAML"` → `ko.editor.tabYaml`("YAML", R3 토큰이라 한국어 안 해도 됨 — 키로 노출만). **R8: `tab="canvas"`/`tab="yaml"` value 절대 보존.**
- `DataBindingPanel`: `aria-label="Data binding"` → 기존 `ko.binding.sectionTitle` 재사용(R4·중복 키 금지). policy `<option value="per_vu">` 등 `value` 보존(R8).
- `RunDialog`: 본문은 이미 `ko.runDialog` — 잔존 `aria-label`/`title`(`load preset`/`preset name`)만.

- [ ] **Step 1: 위 파일들 치환 + 필요한 키 추가** (대표: TabBar)

```tsx
// before:  <Tab label="Canvas" tab="canvas" /> <Tab label="YAML" tab="yaml" />
// after:   <Tab label={ko.editor.tabCanvas} tab="canvas" /> <Tab label={ko.editor.tabYaml} tab="yaml" />   // tab= 값 보존(R8)
```

- [ ] **Step 2: 각 파일 테스트 셀렉터 lockstep** (`getByRole("tab",{name:"Canvas"})` → `{name:"캔버스"}`, regex 셀렉터 포함). Run: `cd ui && pnpm test TabBar` / `pnpm test EditorShell` / `pnpm test DataBindingPanel`.

- [ ] **Step 3: R1 게이트 — grep 백스톱 + 파일별 sweep (정규 범위 확인)**

> **grep는 *백스톱*이지 단독 oracle 아님**(spec-plan-reviewer F3-F5): 기존 `aria-label="X` 패턴은 **보간형** `aria-label={`Remove env ${x}`}`·소문자-시작 `title="p95 response time"`·JSX 소문자 본문을 놓쳐, 영어가 남아도 green이 나고 RTL도 조용히 통과한다. 아래 *넓힌* grep 3 arm + **변경 파일 전부 눈으로 sweep**(특히 보간 aria 많은 Inspector/EnvironmentPicker/VariablesPanel/DataBindingPanel) 둘 다로 닫는다.

Arm 1 — 속성(리터럴 `"…"` **와** 보간 `` {`…` `` 둘 다, 소문자 포함):
```bash
cd ui/src && grep -rnE '(aria-label|title|placeholder)=\{?[`"][A-Za-z]' --include='*.tsx' . | grep -v __tests__ | grep -vE 'ko\.|\$\{BASE_URL\}|"BASE_URL"|localhost|"GET"|"POST"|"PUT"|"PATCH"|"DELETE"|"HEAD"|"OPTIONS"|staging|"left"|"right"|var_name|new_var|"YAML"|"URL"'
```
(보간 ko 키 `aria-label={ko.editor.x(i)}`는 `{` 다음이 `` ` ``/`"`가 아니라 `ko`라 매치 안 됨 → green = 정상.)
Expected: **빈 출력**. 남으면 그 파일을 같은 정책으로 치환 후 재실행.

Arm 2 — JSX 본문 영어(대·소문자 시작 모두; 노이즈 있어 R3 제외 후 *판정*):
```bash
cd ui/src && grep -rnE '>[ ]*[A-Za-z][A-Za-z ]{2,}<' --include='*.tsx' pages components | grep -v __tests__ | grep -vE 'ko\.|VU|RPS|YAML|URL|HTTP|JSON|CSV|XLSX|HAR|GET|POST|PUT|PATCH|DELETE'
```
Expected: 빈 출력 또는 R3 토큰만. (히트마다 R3 토큰인지 번역대상인지 판정.)

Arm 3 — 파일별 sweep: Arm 1·2가 0이어도, **이 슬라이스가 건드린 모든 파일**(T2-T6 file list + grep 발견분)을 한 번씩 열어 영어 라벨/인라인 한국어(예: `override`·`+ condition`·`재정의됨`·`from {…}`)가 없는지 확인. 이게 정규 "잔존 0"의 최종 판정.

- [ ] **Step 4: R5/R8 불변식 확인**

Run: `git -C /Users/sgj/develop/handicap/.claude/worktrees/ko-common-rollup diff --stat master..HEAD`
Expected: `ui/`(+ docs는 아직 없음) 한정 — `crates/`·`*.proto`·`*.sql` 0.
Run(R8): `cd ui/src && git diff master..HEAD -- . | grep -E '^[-+].*(value=|tab=)' | grep -vE 'aria|label|title'` — value/tab 속성 변경이 없는지 눈으로(번역으로 인한 wire 값 변경 0).

- [ ] **Step 5: 전체 게이트 + Commit**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
git add ui/src
git commit -m "feat(ui): localize remaining components + R1 grep hard-gate (R1,R2,R4,R5,R8)"
```

---

### Task 7: 마무리 (finish-slice — 코드 task 아님)

`/finish-slice`가 처리: handicap-reviewer(크로스커팅·와이어 1:1) → 라이브 검증 **waived**(spec §6 — production byte-identical, run/report/엔진 경로 무변경, S-D 무관; 직전 두 `ui/`-only 슬라이스 선례) → build-log 한 단락 + roadmap §B10 "ko.common 롤업" 완료 표기 + 루트 CLAUDE 상태줄 교체 + 메모리 → ff-merge. **보안 게이트 N/A**(요청실행/템플릿/캐스트/env·dataset 바인딩/업로드파싱/trace 뷰어 미변경 — finish-slice §0 grep 무매치).

---

## Self-Review

**1. Spec coverage:**
- R1(전수, grep-driven) → T2–T6 추출 + T6 Step 3 R1 하드 게이트. ✓
- R2(`common`=크로스커팅만, 도메인 라벨 분리) → T1 `common` + T3/T4 도메인 키. ✓
- R3(기술 토큰/placeholder 규칙) → Global Constraints + 각 grep의 R3 제외 패턴. ✓
- R4(통일/재사용) → T1 `failedToLoad`/`notFound`/`loading` + `Starting…`→`runDialog.running`·`Data binding`→`binding.sectionTitle` 재사용 + 도메인 실패 키 미마이그레이션. ✓
- R5(byte-identical, diff=ui/+docs) → T6 Step 4 diff-stat. ✓
- R6(RTL lockstep + regex 함정) → 각 task Step "테스트 셀렉터" + T5 cascade 격리. ✓
- R7(헤더 컨벤션) → T1 Step 2. ✓
- R8(라벨만, value/tab 보존) → Global Constraints + T3/T4/T6 R8 메모 + T6 Step 4 value-grep. ✓

**2. Placeholder scan:** "grep-driven"은 placeholder 아님 — spec R1의 정규 방법(전수 enumeration을 grep에 위임). 각 task는 알려진 string→key 표 + 대표 코드 + grep 검증 + commit으로 self-contained. ✓

**3. Type consistency:** `ko.common.failedToLoad(msg: string)=>string`(T1 정의) ↔ T2 호출 `failedToLoad((error as Error).message)` 일치. `ko.common.{loading,notFound,loadingRuns}` 스칼라 ↔ 소비처 일치. `Starting…`→`ko.runDialog.running`(기존, "시작 중…") 정합. ✓

**참고(실행자):** 추출은 **grep을 몰아** 한다 — 표는 알려진 매핑이고, 표에 없어도 grep이 잡으면 같은 정책(R2/R3/R4/R8)으로 치환. import 경로 깊이 주의(`__tests__/`는 한 단계 더 깊음 — `import type` 깊이 오류는 `tsc -b`만 잡음, ui/CLAUDE.md). 단일 파일 테스트는 `pnpm test <Name>`(`--` 없이).

---

<!-- spec clean APPROVE (spec-plan-reviewer, 2026-06-18, 2라운드); plan clean APPROVE (2026-06-18, 2라운드 — F1~F9 fold-in 후). spec/plan 둘 다 루프 통과. -->
REVIEW-GATE: APPROVED

# 디자인 시스템 확산 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** C-2가 만든 재사용 프리미티브(Field/Input/Select/Section/Callout/Badge + accent 토큰)를 4개 고빈도 폼 화면 그룹(Settings·ScenarioImport·Datasets/Environments·Templates/Schedules)에 적용해 입력·섹션·알림 룩을 통일한다.

**Architecture:** 순수 UI 마크업 교체. 각 폼의 뮤테이션 페이로드·검증·핸들러·react-query·와이어는 0-diff(behavior byte-identical), JSX만 프리미티브로 교체. 토대(`ui/src/components/ui/*`·`tailwind.config.ts`·`Button.tsx`)는 동결(순수 소비). 그룹별 단계, 파일별 독립 green 커밋.

**Tech Stack:** React + TypeScript + Tailwind + Vitest/RTL. 게이트 = `pnpm lint && pnpm test && pnpm build`(cargo 비대상).

**스펙**: `docs/superpowers/specs/2026-06-27-design-system-spread-design.md`(R1–R15). 각 Task의 요구사항은 그 스펙 R-id를 가리킨다.

## Global Constraints

스펙의 프로젝트 전역 불변식 — 모든 Task에 암묵 포함:

- **토대 0-diff (R2)**: `ui/src/components/ui/{Field,Input,Select,Section,Callout,Badge}.tsx`·`tailwind.config.ts`·`ui/src/components/Button.tsx`를 **수정하지 않는다**(소비만). 어떤 Task도 새 tone/variant/토큰을 추가하지 않는다.
- **동작 byte-identical (R3)**: 뮤테이션 요청 본문·검증 게이트·이벤트 핸들러·react-query 훅·상태 round-trip 0-diff. JSX 마크업만 교체. 로직 함수/`onChange`/`onSubmit`/`useMutation` 호출은 그대로.
- **와이어 0-diff (R12)**: `crates/`·`*.proto`·`*.sql`·`ui/src/api/*`·`ui/src/api/schemas.ts`·Zod 파싱을 건드리지 않는다. 최종 `git diff --name-only`은 `ui/src`(페이지/컴포넌트)·`ui/src/i18n/ko.ts`·`docs`만.
- **데이터-식별 색 동결 (R4)**: `SchedulesPage` `STATUS_STYLE`·`SettingsPage` 풀-모드 배너(초록)·`StatusBadge`·차트 stroke은 손대지 않는다.
- **VF — Section 적용 깊이 (R6)**: `Section`은 카드 테두리/패딩/`min-w-0`/`text-sm`를 못 싣고 `<fieldset className="mb-4 [border-t pt-3]"><legend text-sm>`만 렌더한다. 따라서 **`border-t pt-3` 디바이더 fieldset에만** 적용(ScheduleForm SLO/고급·TriggerBuilder "트리거"). 카드형 fieldset(ScenarioImport 4개)·`min-w-0` fieldset(Templates preview)·plain `<section><h3>` 폼 카드·리스트 region은 Section으로 바꾸지 않는다 — 토큰 정합 + 입력/알림만 교체.
- **셀렉터 lockstep (R10)**: `aria-label`/placeholder/text로 셀렉트되는 입력은 그 속성을 패스스루로 보존한 `Input`/`Select`로 교체(가시 라벨 강제 금지). `getByRole("region")` 거는 `<section aria-label>`은 보존.
- **ko.ts copy (R11)**: 신규 인라인 문자열 0이 원칙. 기존 문자열은 출처(ko 키/legend 텍스트) 그대로 이동. 신규 노출 텍스트는 `ko.ts` 경유(인라인 영어 금지).
- **고정폭 보존 (R5)**: `Input` BASE는 `block w-full`. 고정폭 입력(`w-40`/`w-64`/`w-24`/`w-48`)은 래퍼 `<div className="w-NN">`로 감싸 폭을 보존(className 산출 순서에 의존하지 말 것).
- **tdd-guard 사전조치 (F4)**: `ui/src/**`(non-test) 편집 전 디스크에 pending(modified/untracked) test-path 파일이 있어야 한다. className/JSX-only 변경은 auto-pass 안 됨 → **각 Task의 Step 1에서 그 파일의 test에 먼저 손을 댄다**(F6 lockstep 단언 추가 = pending diff). 추가할 단언이 없으면 `ui/src/<dir>/__tests__/_tdd_keepalive.test.tsx`(`it.todo("design-system-spread keepalive")`)를 깔고 Task 끝에 `rm`(커밋 금지). subagent에는 명시 경로만 `git add` 지시(`-A` 금지).
- **UI 게이트**: 각 Task 커밋 전 그 파일 테스트 + `pnpm build`. 슬라이스 종료(Task 10)에 전체 `pnpm lint && pnpm test && pnpm build`.
- **file:line 디스클레이머**: 아래 line 번호는 탐색 시점 기준 — 구현 시 `grep`로 재확인(±몇 줄 드리프트 정상).

---

## Conversion Recipe (전 Task 공유 — 같은 패턴 반복)

각 Task는 이 레시피의 해당 변환만 적용한다. import는 파일 상단에 추가:
```tsx
import { Input } from "../components/ui/Input";       // 페이지: "../components/ui/X"
import { Select } from "../components/ui/Select";      // 컴포넌트(components/): "./ui/X"
import { Callout } from "../components/ui/Callout";    // components/datasets/: "../ui/X"
import { Badge } from "../components/ui/Badge";
import { Section } from "../components/ui/Section";
```

**R-1. raw `<input>` → `<Input>`** (속성 패스스루):
```tsx
// before
<input type="number" aria-label={ko.x} className="rounded border border-slate-300 px-2 py-1 text-sm" value={v} onChange={...} />
// after — 동작/속성 그대로, className은 폭만 남기거나 제거(BASE가 룩 제공)
<Input type="number" aria-label={ko.x} value={v} onChange={...} />
```
폭/폰트 보존 규칙:
```tsx
// (a) 고정폭(w-40/w-64/w-24/w-48): Input BASE는 w-full이라 래퍼로 폭 보존
// before: <input className="w-40 rounded border border-slate-300 px-2 py-1 text-sm" .../>
<div className="w-40"><Input ... /></div>
// (b) auto-width 컨트롤이 수평 flex 행에 있으면(UploadPanel 옵션 select·TriggerBuilder 간격단위):
//     w-full로 퍼지면 행이 깨짐 → 폭 래퍼로 compact 유지(폭은 현재 렌더에 맞춰 라이브 확인)
<div className="w-36"><Select ... /></div>
// (c) font-mono 입력(Env var 키·ScenarioImport 호스트 var·cron): className으로 mono 보존
<div className="w-40"><Input className="font-mono" ... /></div>
// (d) flex-1 입력(Env 값): className="flex-1" 유지
<Input className="flex-1" ... />
```

**R-2. raw `<select>` → `<Select>`** (동일 패턴):
```tsx
// before
<select aria-label={ko.x} className="rounded border border-slate-300 px-2 py-1"> {opts} </select>
// after
<Select aria-label={ko.x}> {opts} </Select>
```

**R-3. 알림 박스 → `<Callout>`** (기존 `role`을 정확히 보존 — 없으면 안 만든다):
```tsx
// error block (role=alert 있음)
// before: <p role="alert" className="mt-4 text-sm text-red-600">{err}</p>
// after:
<Callout variant="error" role="alert" className="mt-4">{err}</Callout>

// error block (roleless) — role 부여 금지(byte-identical)
// before: <p className="text-red-600">{err}</p>
// after:
<Callout variant="error">{err}</Callout>

// warn box (Settings apply-note: roleless / ScheduleForm blocked: role=status)
// before: <p className="mb-6 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">{note}</p>
// after:
<Callout variant="warn" className="mb-6">{note}</Callout>
// before: <div role="status" className="mb-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800">{...}</div>
// after:
<Callout variant="warn" role="status" className="mb-3">{...}</Callout>
```
`Callout`은 `className` 패스스루를 가지므로 기존 마진(`mt-4`/`mb-3`/`mb-6`)은 `className`으로 옮긴다. **소형 인라인 생-에러(`text-xs text-red-600` borderless)·버튼 옆 인라인 `<span role="alert">`는 변환하지 않고 그대로 둔다**(레이아웃 시프트 방지).

**R-4. warn 배지 → `<Badge tone="warn">`** (2곳만). `Badge`엔 className이 없으니 기존 위치 클래스(`ml-2`/`shrink-0`)는 래퍼 `<span>`로 보존. "변경됨"은 **인라인 리터럴**(ko 키 아님 — `ko.opsSettings.changedBadge` 없음): 그대로 인라인 유지:
```tsx
// Settings "변경됨"(:68, ml-2 보존):
// before: <span className="ml-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-1">변경됨</span>
// after:
<span className="ml-2"><Badge tone="warn">변경됨</Badge></span>
// Import 중복 배지(:281, shrink-0 보존):
// before: <span className="shrink-0 rounded bg-amber-100 px-1 text-xs text-amber-700">{dupLabel}</span>
// after:
<span className="shrink-0"><Badge tone="warn">{dupLabel}</Badge></span>
```
> 참고: `Badge tone="warn"`는 `px-1.5 py-0.5 font-semibold text-amber-800`라 원본(`px-1 text-amber-700`, no bold)보다 약간 크고 진하다 — 배지 표준화 의도(R15 시각 확인).

**R-5. `border-t` 디바이더 `<fieldset>` → `<Section divider>`** ⚠ **`Section`은 카드 테두리/패딩/배경/`min-w-0`/`text-sm`를 못 싣는다** — 렌더 출력이 `<fieldset className="mb-4 [border-t border-slate-200 pt-3]"><legend class="text-sm">`뿐. 따라서 **`border-t pt-3` 디바이더 fieldset에만** 적용(ScheduleForm SLO/고급·TriggerBuilder "트리거"). **카드형 fieldset(ScenarioImport 4개 `rounded-md border p-4`)·`min-w-0` fieldset(TemplatesPage preview)에는 적용 금지** — 그 fieldset은 그대로 두고 내부 입력/알림만 교체한다.
```tsx
// non-collapsible 디바이더(TriggerBuilder "트리거")
// before: <fieldset className="mb-4 border-t pt-3"><legend className="text-sm font-medium">트리거</legend>{children}</fieldset>
// after (인라인 문자열 그대로 이동·R11):
<Section title="트리거" divider>{children}</Section>
```

**R-6. 접힘 `border-t` `<fieldset>` → `<Section collapsible divider hint>`** (ScheduleForm SLO/고급):
```tsx
// before: <fieldset className="mt-3 mb-4 border-t pt-3"><legend><button type="button" aria-expanded={open} onClick={()=>setOpen(!open)}>{caret}{title}{!open && count>0 && <span>· {count}개 설정됨</span>}</button></legend>{open && children}</fieldset>
// after — 동작/상태 동일 + 접힘 "N개 설정됨" 힌트 보존(필수! 누락 시 UX 회귀)
<Section
  title={title}
  collapsible open={open} onToggle={() => setOpen(!open)} divider
  hint={!open && count > 0 ? `${count}개 설정됨` : undefined}
>
  {children}
</Section>
```
`Section`이 caret(▸/▾)·`aria-expanded`·`{open && children}`·접힘 hint를 내부 처리하므로 기존 caret 스팬·조건부 카운트 스팬·조건부 렌더는 제거(중복 방지). `count`는 기존 변수(예: `sloActiveCount`) 그대로.

**R-7. raw `<button>` → `<Button>`** (EnvironmentsPage "추가" 1곳). **실제 핸들러/조건을 복사**(아래는 실제 `EnvironmentsPage.tsx:189-200` 기준 — 인라인 화살표 + `newKey.trim().length===0`):
```tsx
// before: <button onClick={() => {/* add row */}} disabled={newKey.trim().length === 0} className="px-2 py-1 text-sm border border-slate-300 rounded disabled:opacity-50">{ko.environment.addBtn}</button>
// after (ko.environment.addBtn = "추가" — addVar 아님):
<Button variant="secondary" onClick={() => {/* same */}} disabled={newKey.trim().length === 0}>{ko.environment.addBtn}</Button>
```
> `<Button>`은 `px-4 py-2`라 인접 `py-1` 입력보다 높다 — 같은 flex 행 정렬을 R15 라이브에서 확인(어긋나면 raw 버튼 토큰 정합으로 폴백).

---

## Task 1: SettingsPage

**Files:**
- Modify: `ui/src/pages/SettingsPage.tsx`
- Test: `ui/src/pages/__tests__/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: `Input`, `Callout`, `Badge` from `ui/src/components/ui/`. No new exports.

적용(스펙 §4.1, R5/R7/R8): `MutableRow` number 입력(`:77`, 고정폭 `w-40`) → `<div className="w-40"><Input type="number" .../></div>`(R-1). apply-note warn `<p ...bg-amber-50...>`(`:295`, **roleless**) → `<Callout variant="warn">`(R-3, role 안 만든다). load error `<p role="alert">`(`:301`) → `<Callout variant="error" role="alert">`. "변경됨" 배지(`:68`, **인라인 리터럴**) → `<span className="ml-2"><Badge tone="warn">변경됨</Badge></span>`(R-4·ml-2 보존). **동결**: 그룹 `<section aria-label>`(region·`:310`/`:331`)·`<ul>` 카드(`:179`/`:220`)는 토큰 정합만(Section 금지), 풀-모드 배너 `modeBanner()`(`:267`)·행-레벨 소형 에러(`:103`/`:109`)는 그대로.

- [ ] **Step 1: tdd-guard pending diff — 테스트에 lockstep 단언 추가**

`SettingsPage.test.tsx`에 region 셀렉터가 변환 후에도 살아있음을 확인하는 단언을 추가(pending test diff 생성). ⚠ 테스트 헬퍼는 `renderPage()`(`{wrapper}` 아님), 기본 fixture는 모든 키가 `common` scope라 **공통 region 1개만** 렌더 → by-name으로 단언:
```tsx
// SettingsPage.test.tsx — 변환 후에도 공통 그룹 region 보존
// ⚠ region은 settings 쿼리 settle 후 렌더 → fetch 목 seed + await findByRole (기존 테스트 패턴)
it("keeps the common settings group region", async () => {
  fetchMock.mockResolvedValueOnce(SETTINGS_RESPONSE); // 파일 내 기존 헬퍼/상수 재사용
  renderPage();
  expect(await screen.findByRole("region", { name: ko.opsSettings.groupCommon })).toBeInTheDocument();
});
```

- [ ] **Step 2: 테스트 실행(현재 GREEN 확인)**

Run: `cd ui && pnpm test SettingsPage`
Expected: PASS (단언이 현 마크업에서도 성립).

- [ ] **Step 3: SettingsPage.tsx 변환 적용**

위 "적용" 목록대로 R-1/R-3/R-4 변환. import 추가. 동결 대상 미변경. `onChange`/`useMutation`/draft 로직 0-diff.

- [ ] **Step 4: 테스트 + 빌드**

Run: `cd ui && pnpm test SettingsPage && pnpm build`
Expected: PASS / 빌드 성공. 실패 시 셀렉터 lockstep 또는 import 경로(`tsc -b`) 점검.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/SettingsPage.tsx ui/src/pages/__tests__/SettingsPage.test.tsx
git commit -m "feat(ds-spread): SettingsPage 프리미티브 적용(Input/Callout/Badge)"
```

---

## Task 2: ScenarioImportPage

**Files:**
- Modify: `ui/src/pages/ScenarioImportPage.tsx`
- Test: `ui/src/pages/__tests__/ScenarioImportPage.test.tsx`

**Interfaces:**
- Consumes: `Input`, `Select`, `Callout`, `Badge` (Section 미사용 — 4 fieldset은 카드형이라 유지).

적용(스펙 §4.2, R5/R7/R8): 4개 `<fieldset ...rounded-md border p-4 [text-sm]>`(옵션 `:184`/호스트 `:229`/요청 `:245`/Host→Env `:292`)는 **카드형이라 Section 미적용**(R5/R6 — Section은 border/padding 못 실음)·fieldset 구조·border·`text-sm` 보존, 내부만 교체. 입력: 시나리오 이름(`:188`)·var 이름(`:313`, `w-40 font-mono`→래퍼+`className="font-mono"`)·env 이름(`:339`) → `<Input>`(R-1)·헤더모드 `<select>`(`:206`, flex 컬럼이라 w-full 허용·라이브 확인) → `<Select>`(R-2). HAR parse error `<p role="alert">`(`:177`) → `<Callout variant="error" role="alert">`(R-3). 중복 배지(`:281`) → `<span className="shrink-0"><Badge tone="warn">…</Badge></span>`(R-4). **그대로**: file/checkbox 입력·YAML `<textarea readOnly>`(`:373`)·var 검증·예약 호스트 소형 인라인 에러(`:322`~`:361`).

- [ ] **Step 1: tdd-guard pending diff — 테스트 lockstep 확인/추가**

기존 `getByLabelText(ko.import.chooseFile)`·`getByLabelText(ko.import.nameLabel)`·`getByRole("checkbox",{name})`·`findByRole("group",{name: ko.import.options})`(이미 `:191`에 존재)가 변환 후에도 통과하는지 확인. 4 fieldset은 그대로 두니 group role/legend 무변경 → **기존 group 테스트가 가드**. 입력 변환 가드용으로 var-name 입력 단언 1개 추가(pending diff):
```tsx
it("renders the host-var name input", async () => {
  // ... render with a parsed HAR + a selected host ...
  expect(screen.getByLabelText(ko.import.varNameAria)).toBeInTheDocument(); // 실제 aria-label 키로 확인
});
```
(ko 키는 실제 코드에서 확인 후 사용. 추가 단언이 마땅찮으면 `_tdd_keepalive` fallback.)

- [ ] **Step 2: 테스트 실행(GREEN 확인)**

Run: `cd ui && pnpm test ScenarioImportPage`
Expected: PASS.

- [ ] **Step 3: ScenarioImportPage.tsx 변환 적용**

4 카드형 fieldset 유지(Section 미적용)·R-1/R-2(입력, var 이름 font-mono 래퍼)·R-3(HAR error)·R-4(중복 배지 shrink-0 래퍼). 업로드/파싱/체크박스 선택 로직 0-diff.

- [ ] **Step 4: 테스트 + 빌드**

Run: `cd ui && pnpm test ScenarioImportPage && pnpm build`
Expected: PASS / 성공.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/ScenarioImportPage.tsx ui/src/pages/__tests__/ScenarioImportPage.test.tsx
git commit -m "feat(ds-spread): ScenarioImportPage Input/Select/Callout/Badge 적용(카드 fieldset 유지)"
```

---

## Task 3: DatasetsPage

**Files:**
- Modify: `ui/src/pages/DatasetsPage.tsx`
- Test: `ui/src/pages/__tests__/DatasetsPage.test.tsx`

**Interfaces:**
- Consumes: `Callout`.

적용(스펙 §4.3, R7): 삭제 error `<p role="alert">`(`:41`) → `<Callout variant="error" role="alert" className="mt-4">`(R-3). load error `<p className="text-red-600">`(`:49`, **roleless**) → `<Callout variant="error">`(role 안 만든다). 리스트 `<section aria-label>`(`:46`)·테이블은 그대로(입력 없음·Section 미적용).

- [ ] **Step 1: tdd-guard pending diff — 오류 Callout 렌더 단언 추가(F6 — 현재 미단언)**

`DatasetsPage.test.tsx`는 현재 삭제/로드 오류 `<p>`를 단언하지 않는다. 변환을 가드하는 단언을 추가:
```tsx
it("shows a delete error in a callout", async () => {
  // mock deleteDataset to reject with ApiError(message)
  // ... trigger delete ...
  expect(await screen.findByRole("alert")).toHaveTextContent(/삭제/); // ko 메시지 일부
});
```
(목 패턴은 기존 DatasetsPage.test의 react-query 래퍼 재사용. ko 문구는 실제 키로.)

- [ ] **Step 2: 테스트 실행 — RED**

Run: `cd ui && pnpm test DatasetsPage`
Expected: 새 단언 FAIL(아직 `role="alert"` 없거나 메시지 경로 미연결) 또는 기존 `<p role="alert">`라면 PASS. RED면 Step 3 후 GREEN으로.

- [ ] **Step 3: DatasetsPage.tsx 변환 적용**

R-3 두 곳. 리스트/테이블/삭제 로직 0-diff.

- [ ] **Step 4: 테스트 + 빌드**

Run: `cd ui && pnpm test DatasetsPage && pnpm build`
Expected: PASS / 성공.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/DatasetsPage.tsx ui/src/pages/__tests__/DatasetsPage.test.tsx
git commit -m "feat(ds-spread): DatasetsPage 오류 Callout 적용"
```

---

## Task 4: EnvironmentsPage

**Files:**
- Modify: `ui/src/pages/EnvironmentsPage.tsx`
- Test: `ui/src/pages/__tests__/EnvironmentsPage.test.tsx`

**Interfaces:**
- Consumes: `Input`, `Callout`, `Button`(기존 `ui/src/components/Button.tsx`).

적용(스펙 §4.3, R5/R7/R9, VF/R6): 폼 카드 `<section aria-label ...bg-white>`(`:112`)는 **구조·`<h3>`·`aria-label` 보존**(Section 금지)·카드 클래스 토큰 정합만. 이름(`:121`, `w-64`)·키(`:138`/`:173`, `w-40 font-mono`→래퍼+`className="font-mono"`)·값(`:147`/`:183`, `flex-1`→`className="flex-1"`) → `<Input>`(R-1). raw "추가" `<button>`(`:196`) → `<Button variant="secondary">`(R-7, **실제 핸들러+`disabled={newKey.trim().length===0}` 복사**·`ko.environment.addBtn`). 폼 error(`:210`)·삭제 error(`:227`) → `<Callout variant="error" role="alert">`(R-3). **동결(인라인 유지)**: 예약 var warn(`:204`, `text-xs text-amber-700` borderless 필드-레벨·R7)·EmptyState CTA(`:244`).

- [ ] **Step 1: tdd-guard pending diff — lockstep 확인/추가**

기존 `getByLabelText(/환경 이름/)`(nameAria)·new-var placeholder(`BASE_URL`/`/값/`)·`getByRole("button",{name: /^추가$/})`(이미 `:86`에 존재, `ko.environment.addBtn`="추가")가 변환 후 통과하는지 확인. 기존 add-button 테스트가 `<Button>` 변환을 가드하므로(role/name 동일) **새 단언 불필요** — 단 tdd-guard pending diff용으로 한 줄(예: disabled 단언) 추가하거나 `_tdd_keepalive` fallback:
```tsx
it("add button disabled until key filled", async () => {
  // ... render edit form ...
  expect(screen.getByRole("button", { name: /^추가$/ })).toBeDisabled();
});
```

- [ ] **Step 2: 테스트 실행(GREEN 확인)**

Run: `cd ui && pnpm test EnvironmentsPage`
Expected: PASS.

- [ ] **Step 3: EnvironmentsPage.tsx 변환 적용**

R-1(입력, 고정폭 래퍼·키 font-mono·값 flex-1)·R-7(추가 버튼, 실제 핸들러)·R-3(폼/삭제 error만 — 예약 var warn 인라인 유지). 폼 카드 구조·h3·aria-label·add/save/delete 뮤테이션 0-diff.

- [ ] **Step 4: 테스트 + 빌드**

Run: `cd ui && pnpm test EnvironmentsPage && pnpm build`
Expected: PASS / 성공.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/EnvironmentsPage.tsx ui/src/pages/__tests__/EnvironmentsPage.test.tsx
git commit -m "feat(ds-spread): EnvironmentsPage Input/Button/Callout 적용(폼 카드 구조 보존)"
```

---

## Task 5: UploadPanel (datasets)

**Files:**
- Modify: `ui/src/components/datasets/UploadPanel.tsx`
- Test: `ui/src/components/datasets/__tests__/UploadPanel.test.tsx`

**Interfaces:**
- Consumes: `Input`, `Select`, `Callout`(`../ui/` 경로 — components/datasets/ 기준).

적용(스펙 §4.3, R5/R7, VF/R6): 업로드 카드 `<section aria-label ...p-4>`(`:85`)는 **구조·aria-label 보존**(Section 금지)·토큰 정합만. 데이터셋 이름(`:109`, `w-48`) → `<Input>`(R-1, 래퍼). 옵션 `<select>` 4~5개(`:117`~`:168`, **auto-width·`flex flex-wrap` 행 `:106`**) → `<Select>`(R-2, `aria-label` 보존)지만 **각 폭 래퍼로 compact 유지**(R-1(b) — w-full로 퍼지면 side-by-side 깨짐; 래퍼 폭은 현재 렌더에 맞춰 라이브 확인). parse error `<p role="alert">`(`:180`) → `<Callout variant="error" role="alert" className="mt-3">`(R-3). **그대로**: parsing 상태 `<p role="status">`(`:175`)·업로드 인라인 `<span role="alert">`(`:219`, 버튼 옆)·file 입력·dashed 드롭존(`:89`).

- [ ] **Step 1: tdd-guard pending diff — lockstep 확인/추가**

기존 `getByLabelText(/파일 선택/)`·`getByLabelText(/구분자/)`·preview 텍스트 단언이 통과하는지 확인. 미단언 select(`headerLabel`/encoding/sheet)에 렌더 단언 1개 추가:
```tsx
it("renders the header-mode select", async () => {
  // ... render with parsed preview ...
  expect(screen.getByLabelText(ko.dataset.headerLabel)).toBeInTheDocument();
});
```

- [ ] **Step 2: 테스트 실행(GREEN 확인)**

Run: `cd ui && pnpm test UploadPanel`
Expected: PASS.

- [ ] **Step 3: UploadPanel.tsx 변환 적용**

R-1/R-2(입력·select)·R-3(parse error). 업로드/미리보기/multipart 로직 0-diff.

- [ ] **Step 4: 테스트 + 빌드**

Run: `cd ui && pnpm test UploadPanel && pnpm build`
Expected: PASS / 성공.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/datasets/UploadPanel.tsx ui/src/components/datasets/__tests__/UploadPanel.test.tsx
git commit -m "feat(ds-spread): UploadPanel Input/Select/Callout 적용(카드 구조 보존)"
```

---

## Task 6: TemplatesPage

**Files:**
- Modify: `ui/src/pages/TemplatesPage.tsx`
- Test: `ui/src/pages/__tests__/TemplatesPage.test.tsx`

**Interfaces:**
- Consumes: `Input`, `Callout`.

적용(스펙 §4.4, R5/R7, VF): 메인 폼 카드 `<section ...bg-white>`(`:105`)는 **구조·`<h3>` 보존**(Section 금지)·토큰 정합만. preview `<fieldset className="min-w-0 mb-3">`(`:128`)도 **Section 미적용**(R5/R6 — Section은 `min-w-0` overflow 가드를 못 실음)·fieldset 그대로. 이름(`:112`, `w-64`) → `<Input>`(R-1, 래퍼)·설명(`:120`, `w-full`) → `<Input>`(R-1, 래퍼 불요). 폼 error(`:132`)·삭제 error(`:148`) → `<Callout variant="error" role="alert">`(R-3).

- [ ] **Step 1: tdd-guard pending diff — lockstep 확인/추가**

기존 `getByLabelText(ko.stepTemplates.colName)`·`getByRole("alert")`(error)가 통과하는지 확인. 설명 입력은 현재 미단언이므로 F6 단언 추가(pending diff):
```tsx
it("renders the description input", async () => {
  // ... open edit form ...
  expect(screen.getByLabelText(ko.stepTemplates.colDescription)).toBeInTheDocument();
});
```
(`ko.stepTemplates.colDescription` 존재 확인 — 없으면 실제 설명 입력 aria-label/label로.)

- [ ] **Step 2: 테스트 실행(GREEN 확인)**

Run: `cd ui && pnpm test TemplatesPage`
Expected: PASS.

- [ ] **Step 3: TemplatesPage.tsx 변환 적용**

R-1(입력)·R-3(error). 메인 카드·preview fieldset 구조·h3·min-w-0·뮤테이션 0-diff(Section 미적용).

- [ ] **Step 4: 테스트 + 빌드**

Run: `cd ui && pnpm test TemplatesPage && pnpm build`
Expected: PASS / 성공.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/TemplatesPage.tsx ui/src/pages/__tests__/TemplatesPage.test.tsx
git commit -m "feat(ds-spread): TemplatesPage Input/Callout 적용(카드/preview fieldset 구조 보존)"
```

---

## Task 7: SchedulesPage

**Files:**
- Modify: `ui/src/pages/SchedulesPage.tsx`
- Test: `ui/src/pages/__tests__/SchedulesPage.test.tsx`

**Interfaces:**
- Consumes: `Callout`.

적용(스펙 §4.4, R4/R7, F3): 폼 카드 `<section aria-label ...bg-white>`(`:128`)는 `<ScheduleForm>`+`<ScheduleEventTimeline>` 컨테이너라 **Section 미적용**·토큰 정합만. 폼 error(`:135`)·삭제 error(`:152`) → `<Callout variant="error" role="alert">`(R-3). **동결**: status 배지 `STATUS_STYLE`(`:199`)·EmptyState CTA(`:169`).

- [ ] **Step 1: tdd-guard pending diff — 폼-카드 렌더 + 오류 단언 추가(F6 — 폼이 현재 테스트에서 안 열림)**

`SchedulesPage.test.tsx`는 현재 폼을 열지 않는다(리스트/빈/삭제만). 폼-카드 렌더 + 오류 Callout 단언 추가:
```tsx
it("opens the schedule form card", async () => {
  const user = userEvent.setup();
  // ... render, click "새 스케줄" ...
  expect(screen.getByRole("region", { name: ko.schedule.formAria })).toBeInTheDocument();
});
```
(폼 카드는 `<section aria-label={ko.schedule.formAria}>`라 region으로 보존 — F3 덕에 셀렉터 유효.) ⚠ 폼을 열면 `<ScheduleForm>`이 마운트돼 `useScenarios`/`useEnvironment`/TriggerBuilder/LoadModelFields가 추가 fetch를 쏜다 — 테스트의 url-기반 fetch 목이 그 요청들을 견디게 디폴트 응답을 추가(기존 `SchedulesPage.test`의 url 분기 목 패턴 확장). 단언이 무거우면 Step 1을 가벼운 폼-열림 1개로 두고 오류 Callout 단언은 생략 가능.

- [ ] **Step 2: 테스트 실행 — RED 후 GREEN**

Run: `cd ui && pnpm test SchedulesPage`
Expected: 폼-열기 단언이 현재 동작과 맞으면 PASS, 아니면 Step 3 후 GREEN.

- [ ] **Step 3: SchedulesPage.tsx 변환 적용**

R-3(두 error만). 폼 카드 구조·status 배지·EmptyState 0-diff.

- [ ] **Step 4: 테스트 + 빌드**

Run: `cd ui && pnpm test SchedulesPage && pnpm build`
Expected: PASS / 성공.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/SchedulesPage.tsx ui/src/pages/__tests__/SchedulesPage.test.tsx
git commit -m "feat(ds-spread): SchedulesPage 오류 Callout 적용(폼 카드 구조 보존)"
```

---

## Task 8: ScheduleForm

**Files:**
- Modify: `ui/src/components/ScheduleForm.tsx`
- Test: `ui/src/components/__tests__/ScheduleForm.test.tsx`

**Interfaces:**
- Consumes: `Input`, `Select`, `Section`, `Callout`(`./ui/` 경로).

적용(스펙 §4.4, R5/R6/R7): 이름(`:266`, `w-full`)·시나리오 `<select>`(`:276`)·httpTimeout(`:329`, `w-full`)·loopCap(`:349`, `w-full`) → `<Input>`/`<Select>`(R-1/R-2, `aria-label` 보존, w-full이라 래퍼 불요). SLO `<fieldset ...border-t pt-3>`(`:367`)·고급 `<fieldset>`(`:396`) → `<Section collapsible open={sloOpen}/{advOpen} onToggle={...} divider hint=...>`(R-6, **접힘 "N개 설정됨" hint 보존**·기존 state·caret·카운트 스팬 제거). blocked-reasons `<div role="status" ...bg-amber-50>`(`:462`) → `<Callout variant="warn" role="status" className="mb-3">`(R-3). **그대로**: checkbox(measurePhases/enabled)·grid 레이아웃.

> ⚠ ScheduleForm은 `LoadModelFields`를 마운트할 수 있으나 **이 Task는 ScheduleForm 자체 입력만** 만진다(`LoadModelFields`는 C-2에서 이미 토큰화됨 — 0-diff 유지). R10: ScheduleForm 동작/payload byte-identical.

- [ ] **Step 1: tdd-guard pending diff — lockstep 확인**

기존 `getByLabelText(/HTTP 타임아웃/)`·`/이름/`·`/시나리오/`·`getByRole("status")`(blocked)·`getByRole("button",{name:/저장/})`가 통과하는지 확인. SLO/고급 접힘 토글이 `Section`으로 바뀌므로 `aria-expanded` 보존 단언 추가:
```tsx
it("SLO section toggles via aria-expanded", async () => {
  const user = userEvent.setup();
  // ... render ScheduleForm ...
  const toggle = screen.getByRole("button", { name: /SLO/ });
  expect(toggle).toHaveAttribute("aria-expanded");
});
```

- [ ] **Step 2: 테스트 실행(GREEN 확인)**

Run: `cd ui && pnpm test ScheduleForm`
Expected: PASS.

- [ ] **Step 3: ScheduleForm.tsx 변환 적용**

R-1/R-2(4 입력)·R-6(SLO/고급 collapsible Section + hint)·R-3(blocked Callout). 검증·payload·state·`LoadModelFields` prop 0-diff. ⚠ Section `hint`로 접힘 인디케이터 보존 — **SLO는 카운트**(`hint={!sloOpen && sloActiveCount>0 ? \`${sloActiveCount}개 설정됨\` : undefined}`), **고급은 boolean**(`measurePhases` 토글이라 `hint={!advOpen && measurePhases ? "1개 설정됨" : undefined}`). 두 식이 다름(고급은 count 아님).

- [ ] **Step 4: 테스트 + 빌드**

Run: `cd ui && pnpm test ScheduleForm && pnpm build`
Expected: PASS / 성공.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/ScheduleForm.tsx ui/src/components/__tests__/ScheduleForm.test.tsx
git commit -m "feat(ds-spread): ScheduleForm Input/Select + collapsible Section + Callout"
```

---

## Task 9: TriggerBuilder

**Files:**
- Modify: `ui/src/components/TriggerBuilder.tsx`
- Test: `ui/src/components/__tests__/TriggerBuilder.test.tsx`

**Interfaces:**
- Consumes: `Section`, `Input`, `Select`(`./ui/`).

적용(스펙 §4.4, R5/R6): 전체 `<fieldset ...border-t pt-3><legend>트리거</legend>`(`:78`)는 border-t 디바이더라 `<Section title="트리거" divider>`(R-5, 인라인 문자열 그대로 이동·non-collapsible). once datetime(`:97`, `w-full`)·time(`:109`, `w-full`)·간격 N(`:143`, `w-24`)·cron(`:168`, `w-full font-mono`) → `<Input>`(R-1, `w-24`만 래퍼·`font-mono` className 유지)·간격 단위 `<select>`(`:153`, **auto-width·flex 행**) → `<Select>`(R-2)지만 **폭 래퍼로 compact 유지**(R-1(b)·라이브 확인). cron preview error `<p role="alert">`(`:181`, 작음)는 인라인 유지(R7). **그대로**: radio(트리거 모드 `:82`~`:91`)·요일 토글 버튼(`:130`, `aria-pressed`·border-slate-300 정당 예외).

- [ ] **Step 1: tdd-guard pending diff — lockstep 확인**

기존 `getByRole("radio",{name:/매일|간격/})`·`getByLabelText(/시각/)`·preview `findByText(/다음 발사/)`가 통과하는지 확인. fieldset→Section 제목 보존 단언 추가:
```tsx
it("renders the trigger section legend", () => {
  // ... render ...
  expect(screen.getByText(/트리거/)).toBeInTheDocument();
});
```

- [ ] **Step 2: 테스트 실행(GREEN 확인)**

Run: `cd ui && pnpm test TriggerBuilder`
Expected: PASS.

- [ ] **Step 3: TriggerBuilder.tsx 변환 적용**

R-5(fieldset→Section)·R-1/R-2(입력). radio·요일 토글·cron 미리보기 로직 0-diff.

- [ ] **Step 4: 테스트 + 빌드**

Run: `cd ui && pnpm test TriggerBuilder && pnpm build`
Expected: PASS / 성공.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/TriggerBuilder.tsx ui/src/components/__tests__/TriggerBuilder.test.tsx
git commit -m "feat(ds-spread): TriggerBuilder Section/Input/Select 적용"
```

---

## Task 10: 슬라이스 검증 (게이트 + grep 불변식 + 시각 라이브 검증)

**Files:** 없음(검증·grep만). docs/roadmap 갱신은 `/finish-slice`가 담당.

- [ ] **Step 1: 전체 UI 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0 warn / 전체 test PASS / 빌드 성공. (`pnpm test`는 인자 없이 전체 — targeted green ≠ full green 함정 회피.)

- [ ] **Step 2: 불변식 grep**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/design-system-spread
# R2 토대 0-diff
git diff --name-only master..HEAD | grep -E 'components/ui/|tailwind.config.ts|components/Button.tsx' && echo "VIOLATION R2" || echo "R2 ok"
# R12 와이어 0-diff
git diff --name-only master..HEAD | grep -E 'crates/|\.proto$|\.sql$|api/schemas.ts|src/api/' && echo "VIOLATION R12" || echo "R12 ok"
# R13 accent 드리프트 0 (만진 페이지/컴포넌트)
grep -rnE 'text-blue-600|bg-blue-|border-blue-|indigo-' ui/src/pages/{SettingsPage,ScenarioImportPage,DatasetsPage,EnvironmentsPage,TemplatesPage,SchedulesPage}.tsx ui/src/components/{ScheduleForm,TriggerBuilder}.tsx ui/src/components/datasets/UploadPanel.tsx && echo "VIOLATION R13" || echo "R13 ok"
# R5 raw input 잔존 (input/select 한정·비-input 예외 제외) — 수동 검토
grep -nE '<(input|select)[^>]*border-slate-300' ui/src/pages/*.tsx ui/src/components/ScheduleForm.tsx ui/src/components/TriggerBuilder.tsx ui/src/components/datasets/UploadPanel.tsx || echo "R5 ok (no raw input/select with border-slate-300)"
```
Expected: 전부 "ok". (keepalive 테스트 파일이 남아있으면 `rm` 후 재확인.)

- [ ] **Step 3: 시각 라이브 검증 (R15 — 사용자 "디자인이 이상해지지 않길")**

`/live-verify`로 워크트리 자체 바이너리 + Playwright 헤드리스 기동 후, 각 그룹 대표 화면을 **시각 회귀 관점**으로 점검:
- Settings: 입력 포커스 링(accent)·"변경됨" 배지·apply-note Callout 정렬, 그룹 region 2개 보존.
- Environments: 폼 카드 제목(`<h3>` 크기 그대로)·고정폭 입력(name `w-64`·key `w-40`이 full-width로 안 퍼짐)·"추가" 버튼·예약/오류 Callout.
- Templates: 메인 카드 제목 크기 보존·preview fieldset 구조/`min-w-0` 보존(Section 미적용).
- Schedules: 폼 열기·status 배지 색 보존·오류 Callout.
- ScheduleForm/TriggerBuilder: SLO/고급/트리거 Section 접힘·입력 정렬.
- **대표 뮤테이션 라운드트립 1~2개**: 환경 생성(POST /api/environments 201) + 설정 저장(PUT) → console 에러 0·정상 반영.
- 스크린샷으로 전/후 레이아웃 시프트(고정폭 퍼짐·제목 축소·간격 깨짐) 없음 확인. 머지 전 `.playwright-mcp`·루트 png 정리.

- [ ] **Step 4: 검증 요약 기록**

게이트/grep/라이브 결과를 한 단락으로 정리(다음 `/finish-slice` build-log 입력). 이상 발견 시 해당 Task로 돌아가 fix-subagent.

---

## Self-Review (작성자 체크 — 완료)

1. **스펙 커버리지**: R1(Task1–9)·R2(Global+Task10 grep)·R3(각 Task 동작 0-diff)·R4(Task1·7 동결)·R5(R-1 레시피 a/b/c/d+Task10 grep)·R6(레시피 R-5/R-6=border-t fieldset만+VF 제약)·R7(R-3+R-7 레시피·필드-레벨 인라인 유지)·R8(Task1·2 Badge)·R9(Task4 Button)·R10(각 Task Step1 lockstep)·R11(Global ko)·R12(Global+Task10 grep)·R13(Task10 grep)·R14(레시피=프리미티브가 a11y 제공)·R15(Task10 Step3·시각 회귀 항목). 갭 없음.
2. **Placeholder 스캔**: 모든 변환 단계에 레시피 코드블록 참조. "적절히 처리" 류 없음. 일부 ko 키(예: `colDescription`·var-name aria)는 "구현 시 확인" 명시 — 확정된 키(`addBtn`·`groupCommon`·`import.options`)는 실측 반영, "변경됨"/"트리거"는 인라인 리터럴.
3. **타입 일관성**: 프리미티브 시그니처는 실제 파일 기준(`Section{title,badge,help,divider,collapsible,open,onToggle,hint}`[className·border/padding 없음→카드형 fieldset 미적용]·`Callout{variant,role,className}`·`Badge{tone}`[className 없음→위치클래스 래퍼]·`Input`/`Select` forwardRef 패스스루[w-full→고정/auto폭 래퍼]). 신규 export 없음(순수 소비).
4. **플랜 리뷰 반영**: spec-plan-reviewer 3라운드(APPROVE-WITH-FIXES ×2 → clean APPROVE) 지적 전부 반영 — Section은 border-t fieldset만(카드형 strip 방지)·`hint` 보존·ko 키 정정(addBtn/options/인라인)·auto-width 래퍼·font-mono·예약 var 인라인·region 단언 by-name/renderPage·잔존 6 "→Section" 정리.

---

<!-- REVIEW-GATE: APPROVED -->
> spec(2라운드)·plan(3라운드) 모두 spec-plan-reviewer **clean APPROVE** 완료 (2026-06-27). 이 마커는 `spec-review-guard`가 `crates/*/src`·`ui/src` 편집을 허용하는 신호다.

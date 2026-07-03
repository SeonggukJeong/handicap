# Button-accent 드리프트 이주 — 설계

- **날짜**: 2026-07-04
- **슬라이스**: `button-accent-migration` (UX·디자인 시스템 테마, ADR-0043 확산 후속)
- **테마 frontier**: design-system-editor(확산 3차) 완료 후 남은 컨트롤 색 드리프트 이주
- **범위**: UI-only. backend/proto/migration/schemas/model/engine 0-diff. 새 ADR 없음(ADR-0043 범위 내).

## 1. 배경 · 문제

ADR-0043은 시맨틱 `accent` 토큰(`tailwind.config.ts`: `accent: colors.indigo`)과 프리미티브 6종을 세웠고, 이후 확산 1~3차가 블록 알림·입력·경고박스를 프리미티브로 옮겼다. 그러나 **컨트롤 affordance 색**(액션 버튼·선택 상태·링크·레일·포커스 링)에는 raw `indigo-*`/`blue-*` 리터럴이 화면마다 흩어져 남아 있다:

- **filled 버튼**: 일부는 `bg-indigo-600`, 일부는 `bg-blue-600` — 같은 "주요 액션"인데 앱 안에서 색이 두 가지.
- **링크형 버튼**: `text-blue-600 hover:underline`.
- **선택 상태 칩·레일·정렬 표시자**: raw `indigo-*`.
- **바디 입력 textarea**: `<textarea border-slate-300>`에 **포커스 링이 없다** — Input/Select 프리미티브(`focus:border-accent-500 focus:ring-2 focus:ring-accent-500/30`)와 달리 포커스 시 브라우저 기본 외곽선만 뜬다(사용자 플래그: "바디에 JSON 입력할때 테두리 엑센트가 옛날 방식").

목표: 이 컨트롤 색을 **하나의 `accent` 토큰**으로 통일하고, textarea에 프리미티브와 동일한 accent 포커스를 입힌다.

## 2. 색 도메인 원칙 (ADR-0043)

`accent`는 indigo의 **빌드타임 별칭**이라 `accent-N`은 `indigo-N`과 픽셀 동일하게 렌더된다(런타임/오프라인-CSP 무변화).

- **컨트롤 affordance 색** → `accent` 토큰으로 이주. (이 슬라이스의 대상)
- **데이터 식별 색** → 별도 도메인. 토큰화 금지(비교 뷰 라인 매칭 등이 깨진다). **동결.**

두 가지 시각 변경 클래스:

- **indigo → accent**: byte-identical(픽셀 동일). 순수 시맨틱 정리.
- **blue → accent**: 실제 색 변경(파랑→인디고). 드리프트 통일 — **의도된 유일한 가시적 변경.**

## 3. 신규 프리미티브: `Textarea` (`ui/src/components/ui/Textarea.tsx`)

`Input`을 그대로 미러한다:

```
BASE = "block w-full rounded-md border border-slate-300 px-2 py-1 text-slate-900 " +
       "focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/30 " +
       "aria-[invalid=true]:border-red-400 aria-[invalid=true]:ring-red-400/30 " +
       "disabled:bg-slate-50 disabled:text-slate-400";
SIZE = { md: "text-sm", sm: "text-xs" };
```

- `forwardRef<HTMLTextAreaElement>`, `Omit<TextareaHTMLAttributes,"size"> & { size?: "sm" }`.
- 높이·`font-mono`·기타는 호출자가 `className`으로 전달(프리미티브는 높이/폰트를 강제하지 않는다 — `Input`이 폭만 잡고 높이를 안 잡는 것과 동형).
- `SIZE`는 `Input`/`Select`와 동일 키(`md`=text-sm, `sm`=text-xs).

**결정 (a) — 모서리**: 코드 textarea가 지금 `rounded`(4px)인데, 프리미티브 BASE는 Input/Select와 같은 `rounded-md`(6px)로 통일한다. 이주 시 유일한 비-포커스 픽셀 변경(2px 모서리). *근거*: 프리미티브가 형제(Input/Select)와 어긋나면 디자인 시스템 일관성이 깨진다. (포커스 링만 원하면 `rounded` 유지도 가능 — spec-review에서 veto 가능.)

### 3.1 채택 (5개 textarea 전부)

| 사이트 | 현재 | 이주 후 |
|---|---|---|
| `Inspector` `JsonBodyField` (:539) | `w-full h-32 border border-slate-300 rounded px-2 py-1 text-xs font-mono` | `<Textarea size="sm" className="h-32 font-mono" .../>` |
| `Inspector` `RawBodyField` (:592) | `w-full h-24 … rounded … text-xs font-mono` | `<Textarea size="sm" className="h-24 font-mono" .../>` |
| `BulkEditPanel` (:22) | `w-full min-w-0 h-32 … rounded … text-xs font-mono` | `<Textarea size="sm" className="min-w-0 h-32 font-mono" .../>` |
| `ScenarioImportPage` (:376) | `rounded border border-slate-300 p-2 font-mono text-xs` readOnly rows=16 | `<Textarea size="sm" readOnly rows={16} className="py-2 font-mono" .../>` (현재 `p-2`=py-2라 `py-2` override, §3.1 패딩 보존) |
| `AutoGrowTextarea` (:23) | 자체 base + 소비자가 border/rounded 전달 | 프리미티브 **합성**(아래) |

- **텍스트 크기 보존**: xs 코드 필드는 `size="sm"`(text-xs 유지 — 밀도 회귀 방지, ui/CLAUDE.md 밀도 트랩). `AutoGrowTextarea` 소비자(`VariablesPanel`)는 현재 `text-sm`이므로 기본 `md`.
- **패딩 보존**: 프리미티브 BASE 패딩은 `px-2 py-1`. JsonBody·RawBody·BulkEdit는 현재도 `px-2 py-1`이라 추가 override 불필요(`font-mono`+높이만). ImportPage는 현재 `p-2`(=px-2 **py-2**)라 BASE의 `py-1`과 다르므로 `className="py-2 font-mono"`로 기존 세로 패딩을 되살린다(가로 px-2는 동일).
- 즉 **채택 시 각 사이트의 기존 높이·패딩·텍스트 크기·`font-mono`를 className으로 보존**하고, 실제로 바뀌는 것은 (1) accent 포커스 링 추가, (2) `rounded`→`rounded-md`(2px) 둘뿐.

### 3.2 `AutoGrowTextarea` 합성

`AutoGrowTextarea`는 leaf `<textarea>`가 아니라 auto-grow 래퍼다. 내부에서 프리미티브를 렌더하도록 합성:

```tsx
<Textarea ref={ref} value={value} rows={1}
  className={`resize-none overflow-y-auto max-h-40 ${className ?? ""}`} {...rest} />
```

- `Textarea`가 forwardRef라 auto-grow의 `useLayoutEffect` ref 그대로 동작.
- 소비자 `VariablesPanel`(:54)은 지금 `border border-slate-300 rounded px-2 py-1 text-sm font-mono`를 넘긴다 → 프리미티브가 border/rounded-md/px-2/py-1을 이미 주므로 **`className="font-mono"`로 축소**(text-sm=기본 md, 나머지 프리미티브 제공). 결과: accent 포커스 추가 + `rounded`→`rounded-md`.

## 4. accent 토큰 스왑 (컨트롤 affordance, 색 클래스만)

**filled 버튼은 색 클래스만 교체** — `Button` 프리미티브로 대체하지 않는다(프리미티브는 `px-4 py-2 rounded-md`라 이 컴팩트 버튼들의 크기가 바뀐다 = 시각 회귀). 컴팩트 geometry 보존. (컴팩트 `Button` variant는 토대 변경이라 연기.)

### 4.1 blue → accent (가시적 색 변경)

| 사이트 | 현재 → 이주 후 |
|---|---|
| `WorkerDashboardPage` (:136) | `bg-blue-600 hover:bg-blue-700` → `bg-accent-600 hover:bg-accent-700` |
| `WorkerDashboardPage` (:67, 삼항) | `… : "bg-blue-600 hover:bg-blue-700"` → `… : "bg-accent-600 hover:bg-accent-700"` (destructive `bg-red-600` 그대로) |
| `SlotSizingHelper` (:105) | `text-blue-600 hover:underline` → `text-accent-600 hover:underline` |
| `VuSizingHelper` (:131) | 동일 |
| `StepCriteriaFields` (:106) | 동일 |
| `ScheduleEventTimeline` (:43, `<Link>`) | 동일 |
| `WorkerDashboardPage` (:491) | 동일 |

### 4.2 indigo → accent (byte-identical)

| 사이트 | 현재 → 이주 후 |
|---|---|
| `SlotSizingHelper` (:137) · `VuSizingHelper` (:162) · `WorkerSizingHelper` (:95) | `bg-indigo-600 … hover:bg-indigo-700` → `bg-accent-600 … hover:bg-accent-700` |
| `ExtractConfirmRow` (:66, 확인 버튼) | `bg-indigo-600` → `bg-accent-600` |
| `ResponseBodyTree` (:67, ＋추출) | `bg-indigo-600` → `bg-accent-600` |
| `ScenarioRunsPage` (:267, "비교 (N)") | `bg-indigo-600 … hover:bg-indigo-700` → `bg-accent-600 … hover:bg-accent-700` |
| `LoadModelFields` (:524, 선택 타일) | `border-indigo-500 bg-indigo-50 text-indigo-700` → `border-accent-500 bg-accent-50 text-accent-700` |
| `RunListControls` (:142, 선택 필터 칩) | 동일 패턴 → accent |
| `Inspector` (:1189, 조건 그룹 레일) | `border-indigo-200` → `border-accent-200` |
| `ScenarioRunsPage` (:456, 정렬 ▲/▼) | `text-indigo-600` → `text-accent-600` |
| `ExtractConfirmRow` (:45, 확인 행 배경) | `bg-indigo-50` → `bg-accent-50` |

**결정 (b) — ExtractConfirmRow 배경**: `:45`의 `bg-indigo-50` 확인-행 배경을 accent에 **포함**한다. *근거*: 바로 옆 확인 버튼(:66)이 accent로 가므로 한 affordance 덩어리로 일관. (데이터 강조로 보고 동결도 가능 — spec-review veto 가능.)

## 5. 동결 (Non-goals — 데이터 식별 색, 미변경)

- `StageCurvePreview` 차트 stroke `#2563eb`
- `StatusBadge` running `bg-blue-200 text-blue-900`
- `methodBadge` POST 등 `bg-blue-100 text-blue-700`
- `ConnectionCostCard` 범례 점 `bg-indigo-500`
- `TestRunPanel` 추출 변수 칩 `bg-indigo-100 text-indigo-800`
- `Button`/`Modal`/`HelpTip`의 `ui/` 폴더 통합(별건 연기)
- 컴팩트 `Button` variant 신설(토대 변경, 연기)
- `ko.ts` 변경 없음(순수 클래스/프리미티브 — 신규 사용자 노출 문자열 0)

## 6. 불변식

- backend/proto/migration/schemas.ts/scenario model/yamlDoc/engine **0-diff**.
- `ko.ts` **0-diff**.
- `tailwind.config.ts` **0-diff**(`accent` 토큰 이미 존재; `accent-{50,200,500,600,700}` 클래스는 소스에 리터럴로 등장하므로 JIT 생성).
- 페이로드/wire/동작 **byte-identical**. 시각: indigo→accent 픽셀 동일, blue→accent 색 변경, textarea에 포커스 링+`rounded-md` 추가.
- `Textarea` 채택 사이트의 **높이·패딩·텍스트 크기·`font-mono` 보존**(className으로), textarea의 실제 시각 변경은 (1) accent 포커스 링, (2) `rounded`→`rounded-md`(2px), (3) 프리미티브 BASE의 explicit `text-slate-900`(현재 raw textarea는 상속 검정 → `#0f172a`로 사실상 무감지, Input/Select 형제와 동일)뿐. BASE의 `disabled:*`·`aria-[invalid=true]:*` 클래스는 이 textarea들이 disabled/invalid가 아니라 **추가되지만 무효(inert)**.

## 7. 테스트 · 검증

- **신규 `Textarea` 유닛 테스트** (`ui/src/components/ui/__tests__/Textarea.test.tsx`): Input/Select 테스트 패턴 미러 — 렌더, `ref` 전달, `size`(sm→text-xs / 기본 md→text-sm), `className` 머지, `aria-[invalid]`, `focus:ring-accent-500/30` BASE 포함.
- **기존 테스트 영향 없음**(사전 grep 확인): swap 대상 `indigo-*`/`blue-*` 클래스를 단언하는 테스트 0. 기 존재 `accent-*` 단언(Button·LoadModelFields 타일·TestFlowChips·Input 포커스 링)은 무영향. 단, 구현 중 새 grep으로 재확인.
- **게이트**: `pnpm lint && pnpm test && pnpm build`(전체).
- **라이브 시각 검증(경량)**: production diff가 UI-only(run-생성/report-파싱/엔진 경로 무접촉)라 full live-verify 스택 불요. Playwright로 (1) JSON 바디 textarea 포커스 → accent 링 실측(`getComputedStyle` box-shadow/border-color 또는 스크린샷), (2) WorkerDashboard 버튼 blue→indigo 색 실측. 순수 UI라 백엔드 불필요(`/scenarios/new` 등 클라이언트-only 경로 + WorkerDashboard).

## 8. 파일 인벤토리 (예상 diff)

- **신규**: `ui/src/components/ui/Textarea.tsx`, `ui/src/components/ui/__tests__/Textarea.test.tsx`
- **수정**: `Inspector.tsx`(JsonBody·RawBody·조건 레일), `BulkEditPanel.tsx`, `ScenarioImportPage.tsx`, `AutoGrowTextarea.tsx`, `VariablesPanel.tsx`, `WorkerDashboardPage.tsx`, `SlotSizingHelper.tsx`, `VuSizingHelper.tsx`, `WorkerSizingHelper.tsx`, `StepCriteriaFields.tsx`, `ScheduleEventTimeline.tsx`, `ExtractConfirmRow.tsx`, `ResponseBodyTree.tsx`, `ScenarioRunsPage.tsx`, `LoadModelFields.tsx`, `RunListControls.tsx`
- **0-diff**: 위 §6.

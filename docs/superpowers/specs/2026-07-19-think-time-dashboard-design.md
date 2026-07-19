# think-time 현황판 — 스텝별 페이싱 한눈에 보기·일괄 수정 (think-time-dashboard)

- **날짜**: 2026-07-19
- **유형**: user-path (UI-only — 엔진/컨트롤러/proto/store(서버)/migration **0-diff**)
- **출처**: `roadmap.md §A12 도그푸딩 백로그` 마지막 항목 — "**think-time 현황판**: 시나리오 기본값 외에 각 스텝별 think-time이 어떻게 설정돼 있는지(상속/override/대기없음) 한눈에 확인하고 그 자리에서 수정하는 현황판. think-time-defaults(도그푸딩 2호) 후속 — 사용자 제안 2026-07-17."
- **선행**: think-time-defaults (머지 `6d88ce6` — 루트 `default_think_time` 상속 + 스텝 3상태 + parallel 분기 배제) · ADR-0033(parallel 분기) · ADR-0035(한국어 문구 카탈로그) · ADR-0044(FlowOutline 아웃라인)
- **brainstorming 결정(사용자 승인 2026-07-19)**: 배치=**모달** · 편집 범위=**행별 + 일괄 작업** · 병렬 분기 스텝=**행에 포함 + 실효값 열이 진실** · 병렬 혼입=**비차단 안내**

## 사용자 스토리 (US)

- **US1**: QA가 시나리오 기본 think time을 설정한 뒤 각 스텝이 실제로 얼마나 쉬는지 확인하려 할 때 — 성공하면 스텝을 하나씩 열어보지 않고 한 화면에서 전 스텝의 설정 상태와 실효 대기 시간을 본다.
- **US2**: QA가 여러 스텝의 페이싱을 같은 값으로 맞추려 할 때 — 성공하면 스텝마다 같은 값을 반복 입력하지 않고, 대상을 골라 한 번에 적용한 결과가 즉시 표와 YAML에 반영된 것을 본다.
- **US3**: QA가 병렬 분기 안 스텝에 대기가 걸리지 않는 이유를 파악하려 할 때 — 성공하면 그 행이 "상속"이 아니라 "미적용(병렬 분기)"으로 구분돼 보이고 실효 대기가 "대기없음"임을 확인해, 그 스텝에 값을 직접 넣는 조치를 취한다.
- **US4**: QA가 병렬 분기 스텝이 섞인 여러 스텝을 한 번에 "상속으로" 되돌릴 때 — 성공하면 그 중 병렬 분기 스텝은 대기없음이 된다는 안내를 적용 **전에** 보고, 의도치 않은 부하 변화를 피한다.

(행위자 = QA, ADR-0001 1차 사용자 · user-path 4건 · brainstorming에서 사용자 승인 2026-07-19)

## 배경 (현행 코드)

**모델·엔진 규칙 (think-time-defaults에서 확립, 이번 슬라이스는 소비만 한다)**

- `ScenarioModel.default_think_time: ThinkTimeModel.optional()`(`model.ts:404`), `HttpStepModel.think_time: ThinkTimeModel.optional()`(`model.ts:95`). `ThinkTime = {min_ms, max_ms}`이고 Zod refine이 `min_ms <= max_ms <= 600_000`을 강제한다(`model.ts:76-84`).
- `isInsideParallelBranch(steps, stepId)`(`model.ts`) — 스텝이 parallel 분기 서브트리 안인지 판정하는 기존 헬퍼. 엔진 `runner`/`trace`의 Parallel arm이 분기 재귀에 default를 넘기지 않는 규칙(ADR-0033)의 UI 미러다.
- `flattenHttpSteps(steps)`(`model.ts`) — 전 컨테이너(loop `do` / if `then`·`elif[].then`·`else` / parallel `branches[].steps`)를 재귀 하강해 http leaf만 평탄화. **조상 경로 정보를 잃는다.**

**3상태 판정의 현 위치 (중복 위험 지점)**

- `Inspector.tsx:185-193`이 3상태를 **컴포넌트 본문 인라인**으로 계산한다:
  `defaultThink = model?.default_think_time` / `insideParallel = isInsideParallelBranch(...)` / `noWait = step.think_time?.min_ms === 0 && step.think_time?.max_ms === 0` / `inheriting = step.think_time === undefined`.
  현황판이 같은 판정을 복제하면 두 화면이 서로 다른 말을 할 수 있다(엔진 규칙의 미러라 틀리면 **거짓 정보**).

**편집 이디엄**

- `Inspector.tsx::commitThinkTime`(`:236-256`) — draft + commit-on-blur. 규칙: 둘 다 빔 → `setStepField(id, ["think_time"], undefined)`(YAML 키 삭제) / **정확히 한 칸만 빔 → no-op**(draft 보존, cross-field 포커스 이동 보호) / 둘 다 유효 → 커밋 / 그 외 → 마지막 커밋값으로 revert.
- `ScenarioDefaults.tsx`(109줄) — 왼쪽 패널의 접이식 "시나리오 기본값" 섹션. 같은 commit 규칙으로 `setDefaultThinkTime`을 호출하고, `disabled={yamlError !== null}` 게이트가 걸려 있다.
- `store.ts::dispatch`(모듈 private) — `if (get().yamlError !== null) return;` 편집 게이트 후 `applyEdit(doc, edit)` → `serializeDoc` → `parseScenarioDoc` 재파싱 → 성공 시 `{doc, model, yamlText, yamlError:null}` **단일 `set`** 커밋. 실패 시 `yamlError`만 세팅.
- `yamlDoc.ts::applyEdit`(`:133`)의 `case "setStepField"`(`:448`) — `findStepPath(doc, stepId)`로 스텝 노드 경로를 찾고(못 찾으면 `return`), `value === undefined`면 `doc.deleteIn`, 아니면 객체는 `doc.createNode` 래핑 후 `doc.setIn`.
- `Edit` 유니온은 `yamlDoc.ts:30`에 있고, 다중 사이트를 한 번에 고치는 선례가 `case "renameVariable"`(`:482`)이다.

**기존의 부분 가시성**

- `FlowOutline`의 wide 모드 행이 `ko.editor.wideChipThink(min, max)` 칩(`FlowOutline.tsx:171`)을 띄운다 — 단 **`step.think_time`이 있을 때만**. 상속·대기없음·병렬 미적용은 보이지 않고, 편집도 불가하며, `[스텝 넓게 보기]` 모드로 들어가야만 보인다. 이 칩은 이번 슬라이스에서 **건드리지 않는다**(현황판이 상위 집합).

## 범위 / 비목표

**범위**: `ui/src`만 — 신규 순수 모듈 `scenario/thinkTime.ts`, 신규 컴포넌트 `components/scenario/ThinkTimeBoard.tsx`, `yamlDoc.ts`에 `Edit` 변형 1개 + `store.ts`에 액션 1개, `ScenarioDefaults.tsx`에 진입 버튼, `Inspector.tsx`를 새 판정 함수로 수렴, `i18n/ko.ts` 문구, 테스트.

**비목표**:
- 서버·엔진·proto·migration 변경 **0** (와이어 형식은 기존 `think_time` 그대로 — 새 필드 없음).
- `EditorShell`의 **레이아웃·그리드 분기 0-diff** — 세 번째 wide 모드를 만들지 않는다. 헤더 툴바에 진입 버튼 1개 + 모달 마운트 1줄만 추가된다(R2).
- **`Modal.tsx` 0-diff** — 폭 prop을 뚫지 않는다(R2의 truncate 정책으로 해결).
- `FlowOutline`의 wide think 칩 변경 없음.
- 페이지네이션·가상 스크롤 없음 — 모달 내부 스크롤로 충분(필요해지면 후속. 현 시나리오 규모에서 100행대는 DOM 렌더 문제 없음).
- `timeout_seconds` 없음 — 페이싱이 아니라 별개 축이다.
- open-loop "시나리오 think time 적용" 토글 없음 — run 설정이라 에디터 밖이고 §B21에서 이미 처리됐다.
- 실행 취소(undo) 없음 — 코드베이스에 undo 인프라가 없다. 일괄 적용의 안전장치는 R5 사전 안내 + YAML 모달에서의 확인이다.

## 요구사항

### R1 — 판정·행 모델 단일 소스 `scenario/thinkTime.ts` (US1, US3)

신규 **순수 모듈**(React/store 미접촉. 경로 라벨 문구는 `ko.ts`를 import한다 — 순수 모듈이 문구 카탈로그를 쓰는 선례는 `problems.ts::formatSegment`):

```ts
export type ThinkState =
  | "inherited"       // think_time 없음 · 분기 밖 · 기본값 있음      → 실효 = 기본값(0,0이면 대기없음)
  | "inherited_none"  // think_time 없음 · 분기 밖 · 기본값 없음      → 실효 = 대기없음
  | "override"        // 값 있음 (0,0 아님)                          → 실효 = 그 값
  | "no_wait"         // 값 = {min_ms:0, max_ms:0}                   → 실효 = 대기없음
  | "parallel_unset"; // think_time 없음 · 분기 안 (기본값 미적용)     → 실효 = 대기없음

export type ThinkRow = {
  stepId: string;
  name: string;
  method: string;
  url: string;
  path: string;                        // 조상 경로 라벨 (아래 R1-b) — 최상위면 ""
  state: ThinkState;
  configured: ThinkTime | undefined;   // min/max 입력 시드값 (원본 그대로 — 정규화 안 함).
                                       //   "설정" 열의 배지는 `state`가 그린다.
  effective: ThinkTime | undefined;    // "실효 대기" 열 — undefined = 대기없음 (R1-a2 정규화 후)
};

export function classifyThink(
  step: HttpStep,
  defaultThink: ThinkTime | undefined,
  insideParallel: boolean,
): { state: ThinkState; effective: ThinkTime | undefined; insideParallel: boolean };

export function buildThinkRows(sc: Scenario): ThinkRow[];
```

- **R1-a 실효값 규칙 (엔진 미러)**: 분기 **안** → `step.think_time`(없으면 대기없음, 기본값 무시). 분기 **밖** → `step.think_time ?? default_think_time`(둘 다 없으면 대기없음). `{0,0}`은 값이 있는 것이므로 `override`가 아니라 `no_wait`로 분류한다.
- **R1-a2 `{0,0}` 실효값 정규화 (필수)**: **출처가 무엇이든** `min_ms === 0 && max_ms === 0`이면 `effective`는 `undefined`(대기없음)로 정규화한다. 특히 **기본값 자체가 `{0,0}`인 경우**(`state: "inherited"`)도 `effective: undefined`다. 이 정규화가 없으면 스텝 `{0,0}`은 "대기없음", 상속된 `{0,0}`은 "0–0ms"로 **같은 엔진 동작이 두 문자열**이 되어, 브레인스토밍에서 "진실"로 정한 실효값 열이 자기모순에 빠진다(`pace(0)`은 `Slept` 즉시 반환 — `pacing.rs:57`, 둘은 구별 불가능한 동작이다). `configured`는 정규화하지 않는다(설정 열·입력 시드는 사용자가 적은 값 그대로여야 한다).
- **R1-b 행 순서·경로**: `buildThinkRows`는 아웃라인(FlowOutline)과 동일한 깊이우선 순서로 전 http leaf를 낸다. **이 순서는 `flattenHttpSteps`도 이미 만족한다** — 새 walker가 필요한 유일한 이유는 **경로 라벨**이지 순서가 아니다(순서 버그를 함의하지 않는다). 경로 라벨 조립 규칙(각 조상을 `" / "`로 연결):
  - loop → 컨테이너 `name`
  - if → `` `${name}·${band}` ``, band = **기존 키 재사용** `ko.editor.condThen`(`ko.ts:617`) / **`ko.editor.elifLabel(i + 1)`**(`:624` — 1-based. 기존 호출부 `Inspector.tsx:1440/1452`가 전부 `i + 1`이고 `FlowOutline.tsx:206`도 `` `ELIF ${i + 1}` ``. 0-based로 쓰면 첫 elif가 "Elif 0"이 되어 전 화면과 어긋난다) / `ko.editor.condElse`(`:618`)
  - parallel → `` `${name}·${branchName}` ``
  - **케이싱 발산은 수용**: 아웃라인 밴드 헤더는 ko 경유가 아니라 하드코딩 대문자(`"THEN"`/`` `ELIF ${i+1}` ``/`"ELSE"`, `FlowOutline.tsx:205-209`)다. 현황판 breadcrumb은 밴드 헤더가 아니라 산문형 경로이므로 Inspector 케이싱(`Then`/`Elif n`/`Else`)을 쓴다. 아웃라인의 하드코딩을 ko로 이주시키는 것은 이 슬라이스 범위 밖.
- **R1-c Inspector 수렴 (마지막·드롭 가능 task)**: `Inspector.tsx:190-193`의 인라인 판정 중 **`noWait`/`inheriting` 두 개만** `classifyThink` 결과로 대체한다. `insideParallel`은 **계속 별도로 살아 있어야 한다** — `Inspector.tsx:404`가 `insideParallel ? parallelNoDefaultNote : inheriting && defaultThink ? inheritedThink : null`로 렌더하는데, **분기 안에 값이 지정된 스텝**은 `state`가 `override`/`no_wait`라 `state === "parallel_unset"`로 `insideParallel`을 유도하면 그 amber 안내가 조용히 사라진다. 그래서 `classifyThink`는 `insideParallel`을 **결과에 실어 돌려준다**(위 시그니처).
  - 렌더 출력은 byte-identical이어야 한다(기존 Inspector 테스트가 회귀 가드).
  - 이 R은 **어느 US에도 매달리지 않는 리팩터**다(리뷰 지적). 따라서 **plan의 마지막 task**로 두고, 일정·리스크가 생기면 **잘라낸다**. 잘라낼 경우 `Inspector.tsx:190-193`에 `thinkTime.ts`를 가리키는 주석만 남긴다.

### R2 — 현황판 모달 + 진입점 (US1)

- 신규 `ui/src/components/scenario/ThinkTimeBoard.tsx`. 기존 공용 `components/Modal.tsx`를 쓴다(EditorShell의 YAML 모달·스텝 편집 모달과 같은 이디엄).
- **진입점 = EditorShell 헤더 툴바** — `☰ 변수` / `</> YAML` / `⛶ 스텝 넓게` / `◧ 변수 넓게` 버튼들 옆에 버튼 1개(`ko.editor.thinkBoardOpen`). **`ScenarioDefaults`에 두지 않는다**: 그 섹션은 `{(varsWide || varsOpen) && <aside>}`(`EditorShell.tsx:135`) 안에 살고 `varsOpen`은 헤더 `☰` 버튼(`:85`)으로 사용자가 끌 수 있어, 변수 패널을 접는 순간 진입점이 통째로 사라진다. 헤더 툴바는 다른 모달/뷰 열기 액션이 모여 있는 자리라 더 관용적이기도 하다.
- **표 구조**: 7열 — 헤더 = `[전체선택 체크박스] | 스텝 | 설정 | min | max | (되돌리기, 헤더 셀은 빈 칸 + `sr-only` 라벨) | 실효 대기`. 모달 상단에 현재 시나리오 기본값 요약 한 줄(`기본값 200–500ms` / `기본값 없음` / 기본값이 `{0,0}`이면 `기본값 대기없음`).
- 각 행: 체크박스 · 스텝 셀(경로 + method 배지 + 이름; `components/scenario/methodBadge.ts`의 `METHOD_BADGE` 재사용) · 설정 배지(5상태 문구) · min/max 입력 2칸 · `×` 상속 되돌리기(설정이 있는 행만) · 실효 대기 셀.
- **폭·truncate 정책 (`Modal.tsx`는 범위 밖)**: `Modal`은 `max-w-3xl max-h-[85vh]`(`Modal.tsx:76`) 고정이고 본문이 `overflow-auto p-4`(`:89`)라 가용 폭은 ~736px다. 폭 prop을 새로 뚫으면 `UnsavedChangesDialog`/`SaveTemplateDialog`/`InsertTemplateModal`/`TestRunPanel` 등 기존 소비처 전부에 영향이 가므로 **`Modal.tsx`는 건드리지 않는다.** 대신 고정폭 열(체크박스 ~32 · 설정 배지 ~90 · min/max 각 ~72 · `×` ~28 · 실효 ~110)을 제외한 나머지를 스텝 셀이 먹고, **경로+이름은 `truncate` + `title` 전체 문자열**로 처리한다(`FlowOutline`의 http leaf 이름/URL 한 줄 truncate와 같은 이디엄). 세로는 모달 본문의 기존 `overflow-auto`가 처리한다.
- `parallel_unset` 행의 설정 배지 옆에 `HelpTip`(`ko.editor.defaultThinkParallelHelp` **기존 문구 재사용** — ADR-0035 단일 소스)으로 "왜 미적용인가"를 설명한다.
- 실효 대기 표시: 값이 있으면 `` `${min}–${max}ms` ``, 없으면 `대기없음`. `min === max`여도 같은 형식을 유지한다(별도 분기 없음).
- 스텝이 0개면 표 대신 빈 상태 문구.

### R3 — 행별 편집 (US1)

- min/max 입력은 `commitThinkTime`과 **동일한 4분기 규칙**(둘 다 빔 → 상속으로 되돌림 / 정확히 한 칸만 빔 → no-op·draft 보존 / 둘 다 유효 → 커밋 / 그 외 → revert). 커밋은 기존 `setStepField(stepId, ["think_time"], …)` 단일 스텝 액션을 그대로 쓴다(새 Edit 불요).
- **draft state는 행 컴포넌트 안에 격리**한다(부모가 행 수만큼의 draft Map을 들면 한 글자마다 표 전체가 리렌더된다).
- **재시드 `useEffect` deps는 원시값이어야 한다 — `[row.stepId, row.configured?.min_ms, row.configured?.max_ms]`.** `row.configured`(객체)를 dep에 쓰면 안 된다: `buildThinkRows`가 `useMemo([model])`로 매 커밋마다 전 행을 새로 만들므로 **표 어디서든 한 번 커밋될 때마다 모든 행의 재시드가 재발화**한다. 그러면 R3가 지키려는 바로 그 케이스가 깨진다 — B행에 `min`만 치다가 A행으로 탭 → A행 커밋 → B행 재시드 → **B행에 친 값이 사라진다**. Inspector가 이 문제를 안 겪는 건 한 번에 한 스텝만 렌더하기 때문이므로, Inspector의 effect(`Inspector.tsx:232-235`)를 그대로 복사하면 안 된다.
- `×` 버튼 = `setStepField(stepId, ["think_time"], undefined)`.

### R4 — 선택 + 일괄 3액션 + 새 Edit 변형 (US2)

- **선택 상태**: 모달 로컬 `useState<Set<string>>`(닫으면 버림 — 영속화하지 않는다). 헤더 체크박스는 전체선택/해제이며, 일부만 선택된 상태에서는 `indeterminate`.
- **액션 바**는 선택이 1개 이상일 때만 렌더한다: `N개 선택` + `[min]–[max] [적용]` + `[상속으로]` + `[대기없음으로]`.
  - `[적용]` = `{min_ms, max_ms}` 커밋. 두 칸이 모두 유효한 정수이고 `0 <= min <= max <= 600000`일 때만 활성(그 외 `disabled`).
  - `[상속으로]` = `undefined`(YAML 키 삭제).
  - `[대기없음으로]` = `{min_ms:0, max_ms:0}`.
- **새 `Edit` 변형** `{ type: "setStepsThinkTime"; stepIds: ReadonlyArray<string>; value: ThinkTime | undefined }` (`yamlDoc.ts`):
  - 구현은 `case "setStepField"`의 로직을 id마다 반복한다 — `findStepPath`로 경로를 찾고(**못 찾은 id는 조용히 건너뛴다**), `value === undefined`면 `deleteIn([...path, "think_time"])`, 아니면 `setIn([...path, "think_time"], doc.createNode(value))`.
  - `stepIds`가 빈 배열이면 아무것도 하지 않는다(no-op).
  - 한 `applyEdit` 호출 안에서 모든 mutation이 끝난 뒤 `dispatch`가 **한 번** 재파싱·`set`하므로, 관측 가능한 부분 적용 상태가 없다.
- **store 액션** `setStepsThinkTime(stepIds, value)` — 기존 `dispatch(set, get, {type:"setStepsThinkTime", …})` 한 줄. `dispatch`가 이미 `yamlError` 게이트와 재파싱·단일 커밋을 담당한다.
  - **http leaf 필터 (필수 가드)**: 액션은 `dispatch` 전에 `stepIds`를 **현재 모델의 http leaf id 집합**(`flattenHttpSteps(get().model.steps)` — `store.ts`가 아직 import하지 않는 헬퍼라 import 한 줄 추가)**과 교집합**한다. `model === null`이면 교집합이 빈 집합이 되어 자연히 no-op이다. 이유: `findStepPath`(`yamlDoc.ts:662`)는 **타입을 가리지 않고** id로 스텝을 찾으므로, loop/if/parallel 컨테이너 id가 섞여 들어오면 컨테이너 노드에 `think_time` 키를 써버리고 `.strict()` Zod가 거부한다. 그러면 `dispatch`는 `applyEdit`로 **doc을 이미 변형한 뒤**(`store.ts:420`) 재파싱 실패 분기에서 `yamlError`만 세우므로(`:425`), `doc`은 변형됐는데 `model`/`yamlText`는 옛 상태인 **divergence**가 남는다.
  - **`renameVariable`식 clone→검증 패턴은 쓰지 않는다.** 정확한 불변식은 "재파싱이 실패할 수 없다"가 아니라 **"입력이 http leaf id + 사전 검증된 정수 쌍(또는 키 삭제)으로 제한되는 한 실패할 수 없다"** 이고, 위 필터가 그 제한을 by-construction으로 보장한다. UI가 넘기는 id는 항상 `buildThinkRows`(http leaf만)에서 오므로 필터는 방어선이지 정상 경로가 아니다.

### R5 — 병렬 혼입 비차단 안내 (US4)

- **`n`의 정의 = 선택된 행 중 "분기 안이면서 **현재 `think_time`이 있는**" 행의 수.** 이미 `parallel_unset`인 행(분기 안 + 값 없음)은 `[상속으로]`가 **no-op**이라 세지 않는다 — 이걸 세면 안 바뀌는 행까지 세어 원칙 자체를 무디게 만든다. (경계: 값이 `{0,0}`인 분기 행은 `n`에 들어가지만 실효 대기는 이미 0이라 실제로 *떨어지지는* 않는다 — 안내 문구는 "대기없음이 됩니다"라 여전히 참이므로 정의를 복잡하게 만들지 않는다.)
- `n >= 1`이면 **선택이 바뀌는 즉시**(호버·클릭이 아니라 선택 상태 기반) 액션 바에 비차단 안내 한 줄을 렌더한다: `ko.editor.thinkBoardParallelWarn(n)` — "선택에 병렬 분기 스텝 N개 — 상속으로 되돌리면 대기없음이 됩니다". US4의 "적용 **전에** 본다"를 만족시키는 것이 이 즉시성이다.
- **차단하지 않는다**(버튼 disable·확인 다이얼로그 없음). 사용자가 의도적으로 그렇게 할 수 있어야 하고, 규칙은 안내로 충분하다.
- 이 안내는 `[상속으로]`에 대해서만 의미가 있다. `[적용]`·`[대기없음으로]`는 분기 안에서도 값이 그대로 적용되므로 안내 대상이 아니다.
- 근거: 부하가 설정과 다르게 나가는 경우를 조용히 넘기지 않는다는 제품 원칙(메모리 `load-divergence-explain-confirm`).

### R6 — 깨진 YAML 게이트 (필수)

- `yamlError !== null`이면 **행 입력·`×`·체크박스·일괄 액션을 전부 `disabled`** 로 한다. 읽기 전용 크롬(모달 닫기, 표 자체)은 활성 유지.
- 이유: `store.ts::dispatch`가 깨진 버퍼에서 early-return no-op이라, 입력을 활성으로 두면 사용자가 친 값이 **조용히 삼켜지고** 재시드 effect가 draft를 되돌려 "입력이 사라진" 것처럼 보인다(think-time-defaults S1에서 이미 밟은 함정 — `VariablesPanel`/`FlowOutline`/`ScenarioDefaults`가 모두 같은 이디엄).

### R7 — 문구 (ADR-0035)

- 새 사용자 노출 문자열은 전부 `i18n/ko.ts`의 `ko.editor.*`에 추가한다(`aria-label` 포함 — 하드코딩 영어 금지). 최소 집합: 모달 제목·진입 버튼·5상태 배지·열 머리글·`대기없음`·`기본값 없음`·전체선택/행 체크박스 `aria-label`·3액션 버튼·`N개 선택`·R5 안내(함수 키)·빈 상태.
- 기존 키는 **재사용**한다: `defaultThinkParallelHelp`(R2 HelpTip), `fieldThinkMin`/`fieldThinkMax` 계열은 라벨 의미가 다르면 새로 만들되 중복 신설은 피한다.
- 변수 치환 명사 뒤 조사는 `(으)로` 병기형 규칙을 따른다.

## 테스트 계획

**단위 — `scenario/__tests__/thinkTime.test.ts` (신규)**

1. `classifyThink` 5상태 전수: 기본값 없음/`{0,0}`/`{200,500}` × `think_time` 없음/`{0,0}`/`{200,500}` × 분기 안/밖 **전 조합(3×3×2)** 에서 `state`·`effective`·`insideParallel`이 표대로.
1-b. **R1-a2 정규화 락인**: 기본값 `{0,0}` + `think_time` 없음 + 분기 밖 → `state: "inherited"`이면서 `effective === undefined`(= "0–0ms"가 아니라 "대기없음"). 스텝 `{0,0}`(`no_wait`)과 실효 표시가 **같은 문자열**임을 단언.
1-c. **분기 안 `{0,0}`**: `state`는 `no_wait`(`parallel_unset` 아님) — 결정적임을 락인.
2. `buildThinkRows` 행 순서 = 아웃라인 깊이우선 순서(최상위·loop 안·if 각 분기·parallel 각 분기가 섞인 픽스처).
3. 경로 라벨: loop / if(then·elif·else) / parallel(분기명) / 중첩(loop 안 if) 조합.
4. 시나리오에 http leaf가 없으면 빈 배열.

**단위 — `scenario/__tests__/yamlDoc.test.ts` (기존 파일에 추가)**

5. `setStepsThinkTime` 다중 id 라운드트립 — 3개 중 2개만 지정했을 때 지정한 둘만 바뀌고 나머지는 byte 보존.
6. `value: undefined` → 세 스텝의 `think_time` 키가 모두 사라짐.
7. 중첩(loop/if/parallel 안) 스텝 id도 `findStepPath`로 도달.
8. 빈 `stepIds` = 문서 무변화. 존재하지 않는 id 포함 시 나머지는 정상 적용.
9. 주석 보존(형제 키에 붙은 주석이 살아남음).

**RTL — `components/scenario/__tests__/ThinkTimeBoard.test.tsx` (신규)**

10. 진입 버튼 클릭 → 모달 열림, 시나리오의 전 http leaf가 행으로(개수·순서).
11. 5상태 배지·실효 대기 셀 표시. `parallel_unset` 행은 **긍정 단언**으로 잠근다 — 배지 텍스트 = 미적용 문구 **그리고** 실효 셀 = "대기없음"(부정 단언 "'상속'이 아님"만 두면 배지가 비어 있거나 행이 통째로 없어도 통과한다).
11-b. **크로스-행 draft 보존(R3 회귀 가드)**: B행 `min`만 입력 → A행 값 입력 후 blur(커밋) → **B행의 `min` draft가 그대로 남아 있음**을 단언. `row.configured` 객체를 dep으로 쓰는 구현에서 실패해야 하는 이빨(구현 후 dep을 객체로 되돌려 RED 확인).
12. 행별 편집 3분기: 값 입력→blur→커밋 / 둘 다 비우기→상속 복귀 / 한 칸만 비우기→**no-op**(store 무변화 단언).
13. 전체선택 체크박스 → 일괄 `[대기없음으로]` → 전 행이 `{0,0}`.
14. 부분 선택 → `[적용]` → 선택 행만 바뀌고 비선택 행 무변화(US2).
15. `[적용]`은 잘못된 입력(min>max, 600001, 빈 칸)에서 `disabled`.
16. R5 안내: 병렬 분기 행을 포함해 선택하면 안내가 뜨고, 순차 행만 선택하면 안 뜬다. 안내가 떠도 `[상속으로]`는 **활성**(비차단 락인).
17. R6: `setPendingYamlText` + `commitPendingYaml`로 깨진 YAML 상태를 만든 뒤 입력·버튼이 `toBeDisabled()`(그 경로는 `doc`/`model`을 보존하므로 표가 DOM에 남아 단언이 성립한다).

**회귀**

18. 기존 `Inspector.test.tsx`가 R1-c 수렴 후에도 **수정 없이** 통과 — 특히 **분기 안에 값이 지정된 스텝**이 여전히 amber `parallelNoDefaultNote`를 렌더하는지(R1-c가 `insideParallel`을 `state`에서 유도하면 여기서 RED). 없다면 이 케이스를 먼저 추가한 뒤 R1-c를 착수한다.
18-b. `ScenarioDefaults.test.tsx`는 **무변경**이어야 한다(진입 버튼이 헤더 툴바로 갔으므로 이 파일은 손대지 않는다). 진입 버튼 존재 단언은 **`EditorShell.test.tsx`에** 둔다 — `ScenarioEditPage.clone.test.tsx`/`.save.test.tsx`는 `vi.mock`으로 `EditorShell`을 스텁하므로 페이지 테스트에서는 버튼이 보이지 않는다.
19. 전체 `pnpm test` + `pnpm lint` + `pnpm build` — targeted green ≠ full green.

## 라이브 검증 (US 척추 — user-path)

UI-only(엔진·컨트롤러 0-diff)라 CLAUDE.md 5단계의 "필수" 조건에는 해당하지 않지만, **편집 결과가 곧 부하 형상**이므로 1회 돌린다. 진입 화면은 `/scenarios/{id}`와 `/scenarios/new` **둘 다**(메모리 `live-verify-all-mount-paths` — 한 화면만 보면 그 화면이 우연히 정상인 버그를 놓친다).

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 기본값 200–500 설정 + 순차/loop/parallel 섞인 시나리오에서 현황판 열기 | 전 http leaf가 아웃라인 순서로 뜨고, 상속/지정/대기없음/미적용이 각각 정확한 실효값과 함께 표시 |
| US2 | 3개 선택 → `300–800` 적용 → YAML 모달로 확인 | 선택 3개만 `think_time: {min_ms:300, max_ms:800}`, 나머지 무변화. **모달 read는 전체 `.view-line`을 뜬다**(새 루트 키가 아니라 스텝 하위 키라 위치는 안전하지만, 가상화 누락 함정은 동일) |
| US3 | parallel 분기 안 스텝 행 확인 | 배지가 "미적용", 실효 = "대기없음", HelpTip이 ADR-0033 이유 설명 |
| US4 | 병렬 분기 안의 **값이 지정된** 행 + 순차 행을 함께 선택(클릭·호버 없이 선택만) | 선택 즉시 안내가 뜨고 N이 "값이 지정된 분기 행" 수와 정확히 일치(이미 미설정인 분기 행은 안 세짐), `[상속으로]`는 여전히 활성 |
| 종합 | 현황판으로 2 VU·전 스텝 200ms 고정 적용 → run 1회 | `summary.rps ≈ VUs / think_ms` (2 VU·200ms → ~10 RPS) — 현황판이 보여준 실효값이 실제 부하와 일치 |

## 리스크 / 함정 메모 (plan이 상속할 것)

- **tdd-guard 순서**: `ui/src` 편집 전에 pending test 파일이 있어야 한다 — 각 task는 **테스트 파일 편집을 먼저**(import 미해결로 RED여도 무방).
- **`pnpm build`가 최종 게이트**: `pnpm test`(esbuild)는 TS strict 에러를 놓친다. 특히 (a) ES2023 배열 메서드(`findLast` 등) 금지 — tsconfig `lib`은 ES2022, (b) 판별 union 내로잉은 중간 boolean 변수를 통과하지 못한다(JSX 조건 렌더는 인라인 판별 체크로), (c) `__tests__/`의 `import type` 상대경로 깊이.
- **`pnpm lint`는 `--max-warnings=0`** — 미사용 `eslint-disable` directive도 에러. 비-컴포넌트 export를 컴포넌트 파일에 두면 `react-refresh/only-export-components` warn(순수 헬퍼는 `thinkTime.ts`에 두는 이유 중 하나).
- **셀렉터의 인라인 `?? []` 금지** — `useScenarioEditor((s) => s.model?.steps ?? [])`는 매 스냅샷 새 객체를 만들어 "getSnapshot should be cached" 경고/무한 렌더를 부른다. 모듈 스코프 상수(`EMPTY_STEPS`) 사용.
- **`Modal` 안에서 `HelpTip`의 ESC 레이어링이 안 된다**(Modal capture-phase keydown이 먼저 먹는다). R2의 parallel HelpTip은 모달 안이므로 ESC로 tip이 아니라 모달이 닫힌다 — 허용된 한계로 두되(팁은 바깥 클릭·재클릭으로 닫힘) plan은 이를 알고 있어야 한다.
- **RTL 다중매치**: 스텝 이름이 아웃라인 행(`role="option"`)·wide 칩·현황판 표에 동시 존재할 수 있다. 표 단언은 모달/표 컨테이너로 `within` 스코프.
- **localStorage 미사용**: 이 슬라이스는 영속 상태를 만들지 않는다(선택은 모달 로컬). 테스트에 `localStorage.clear()` 부담 없음.
- **행 draft 재시드는 무해하지 않다** — R3 참조. 커밋 한 번이 전 행의 재시드를 재발화시키므로 **dep은 원시값**이어야 한다(객체 dep이면 다른 행에 반쯤 친 값이 사라진다). 일괄 액션 후 열려 있는 행 draft가 새 값으로 갱신되는 것은 **올바른 동작**이다(원시값 dep에서도 값이 실제로 바뀌었으므로 재시드된다).
- **Inspector의 think 입력은 `yamlError` 게이트가 없다**(`Inspector.tsx:379-401`은 `disabled={noWait}`만) — 현황판(R6)은 같은 필드에 대해 Inspector보다 엄격해진다. 이는 **선재하는 불일치**이며 이 슬라이스에서 Inspector를 고치지 않는다(R6는 새 표면을 올바르게 만드는 것이고, 기존 표면 수정은 별개 스코프).
- **`buildThinkRows`를 렌더마다 새로 만들면** 표 전체가 리렌더된다 — `useMemo([model])`.

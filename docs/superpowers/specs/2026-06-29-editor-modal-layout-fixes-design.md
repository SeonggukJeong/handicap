# 에디터 후속 버그 수정 — 변수 패널 세로 스택+사용 힌트 · 아웃라인 스텝명 한 줄 · YAML 모달 Monaco 높이 (에디터 재설계 후속 슬라이스 A)

> **이 슬라이스의 normative 코어는 §2 R-표.** plan·구현·리뷰는 전부 R-id를 참조한다.

- **날짜**: 2026-06-29
- **상태**: 설계 승인(사용자 2026-06-29) → spec-plan-reviewer 대기
- **출처**: 사용자 dogfooding 보고(2026-06-29) — 에디터 흐름 아웃라인 재설계(ADR-0044, 머지 `ac2938c`) 직후 회귀 5종 중 **저위험 critical+layout 3종**(인계 메모 `editor-redesign-followup-bugs.md`의 슬라이스 A). 드래그 재작업(#3 컨테이너 스냅백·#4 하위 안 따라옴)은 별도 슬라이스 B로 분리(본 spec 범위 밖).
- **연관**: ADR-0044(에디터 1차 표현 캔버스→아웃라인 — `FlowOutline`·변수 접기·YAML 모달의 출처), ADR-0035(UI 한국어 `ko.ts` 단일 소스), ADR-0014(변수 표기 `{{var}}` 흐름 / `${ENV}` 환경 / `${vu_id}` 시스템), ADR-0003/0015(GUI↔Code 양방향 sync·Zustand+Zod+YAML round-trip — 본 슬라이스는 모델/wire 무변경, 그 위 *표시*만). 선행 spec: `2026-06-28-editor-flow-outline-redesign-design.md`(이 컴포넌트들의 출처). 주요 파일: `ui/src/components/scenario/VariablesPanel.tsx`·`FlowOutline.tsx`·`EditorShell.tsx`·`MonacoYamlView.tsx`(automaticLayout 1줄)·`ui/src/scenario/scanVars.ts`·`ui/src/i18n/ko.ts`·`ui/src/components/Modal.tsx`(읽기만).
- **ADR**: **신규 ADR 불필요.** 본 슬라이스는 ADR-0044가 정의한 아웃라인/모달/변수-패널 구조 안의 레이아웃 버그 수정 + 변수 사용 힌트(additive)다. 새 아키텍처 결정 없음(표현 모델·sync·wire 모두 ADR-0044/0003/0015 그대로). 변수 사용 힌트는 기존 `scanVars.ts`의 읽기 전용 확장.

---

## 1. 문제와 목표

에디터 아웃라인 재설계(ADR-0044) 직후 사용자가 dogfooding으로 3개 레이아웃 회귀를 보고했다. 전부 `ui/`(에디터), 모델/wire 무변경.

- **#1 변수 패널이 너무 좁다** — 변수명이 조금만 길어도 `(…)`로 잘려 유사 변수명을 구분 못 하고, 값 입력칸이 ~60–70px로 압착돼 JWT 토큰·URL·JSON 같은 실제 값의 *뒤쪽 데이터가 안 보인다*. 근본원인: `VariablesPanel.tsx:26-42`의 한 행 `[이름 w-24(96px) truncate][값 flex-1][× 버튼]` 가로 레이아웃이 좁은 210px 컬럼(`EditorShell.tsx:61`)에서 이름·값이 한 행을 경쟁.
- **#2 아웃라인 스텝 이름이 2줄로 줄바꿈** — http leaf 행의 이름이 길면 wrap돼 흐름 파악이 어렵다. 근본원인: `FlowOutline.tsx:188` 이름 `<span className="font-medium">`에 `truncate`/`min-w-0` 없음(부모 flex `:181`에도 `min-w-0` 없음 → URL `truncate`도 신뢰 불가).
- **#5 YAML 모달의 Monaco가 높이 ≈ 0** — `</> YAML` 모달을 열면 에디터가 상단 수 px만 보여 *사용 불가*. 근본원인(정적 CSS 분석만으로는 *완전히 핀되지 않음* — 라이브에서 실측·확정): 두 메커니즘 후보가 결합돼 있다. ① 퍼센트-높이 체인(`MonacoYamlView.tsx:74` 외곽 `h-full`·`:77` `<Editor height="100%">`)이 확정 높이 없는 모달(`Modal.tsx:76` 패널 `max-h-[85vh]`=height auto)에서 resolve를 잃음. ② Monaco가 `automaticLayout` 없이 **mount 시 컨테이너를 1회 측정**하고 그 값(then-0/잘못된 크기)에 *얼어붙음*. ⚠ **주의**: `MonacoYamlView.tsx:75` 내부 div엔 이미 `min-h-[400px]`가 있어(slice 3 `bf998fd`부터, ADR-0044 머지본에 존재) first-principles CSS상 에디터는 ≥400px여야 하는데 사용자는 ≈0을 봤다 → 순수 "퍼센트 붕괴" 서사는 **불완전**하고 Monaco mount-시 측정(②)이 유력한 추가 요인. 그래서 수정은 두 메커니즘 모두에 견고하게(아래 R7·§3.4) — 단일 cause 핀에 의존하지 않는다.

**목표**: 세 회귀를 닫는다 — 변수 입력을 인지/사용성 측면에서 제대로 고치고(세로 스택 + 값 가시성 + 사용 힌트), 아웃라인 스텝명/URL을 각 한 줄로, YAML 모달 Monaco에 확정 높이를 준다.

**#1은 단순 폭 확대를 넘어 입력 *방식*을 손본다**(사용자 요청, 2026-06-29): 키-값 *모델*은 유지(흐름 변수 `{{var}}`의 정직한 표현·헤더/폼/ENV 에디터와 일관)하되, *표현*을 (A) 세로 스택으로 양쪽 다 전폭 사용 + 값을 자동 확장 textarea로 *전체 내용 가시화* + (B) 변수별 **사용 힌트**(어디에 쓰이나 / 미사용)를 더해 "변수를 눈 감고 편집"하지 않게 한다.

**비목표(연기 — §7)**: 변수 *이름 편집*(rename — 참조 재작성 동반, tier C 백로그), 일괄 붙여넣기 입력, 값 타입/설명 메타데이터, **"참조됐으나 미정의" 경고**(extract·데이터셋 바인딩 계정 필요 → 문서화된 false-alarm 함정), 드래그 재작업(#3/#4 슬라이스 B), ADR-0044 §7의 기존 에디터-트랙 연기(하단 흐름 다이어그램·경계 넘는 re-parent·YAML file-I/O).

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| R | 요구 | 충족 파일 |
|---|---|---|
| **R1** | `VariablesPanel`의 기존 변수 행을 **세로 row-group**으로: **이름 줄**(전폭·`font-mono`·`truncate`+`title={key}`·우측 `×` 제거 버튼 `shrink-0`) + **값 줄**(전폭). 이름은 현행대로 **비편집**(span 또는 readOnly 표시 — rename 아님). 그리드 변수 컬럼 폭 **210px 유지**(`EditorShell` grid 문자열 무변경). add-row(이름 1칸 + 추가)·빈 상태 문구 무변경. | `VariablesPanel.tsx` |
| **R2** | 값 입력을 **자동 확장 textarea**로: 짧으면 1행, 길면 내용에 맞춰 성장(상한 도달 시 내부 스크롤), 전폭. 커밋 의미론은 **현행 유지**(`onChange`→`setVariable(key, value)` 즉시 — 자유 문자열 값이라 Zod-구조 위험 없음). 재사용 가능한 소형 컴포넌트(`AutoGrowTextarea`)로 추출. | `VariablesPanel.tsx`, `AutoGrowTextarea`(신규) |
| **R3** | `scanVars.ts`에 **읽기 전용** 사용량 스캐너 추가 — 변수명별로 그 변수를 참조하는 **스텝 수**를 센다. 참조 표면 = http 요청 url/헤더/바디(기존 `scanFlowVars` 필드 커버리지) **그리고 `if`/`elif` 조건 피연산자(left/right, `all`/`any` 재귀)**. 전체 스텝 트리 하강(loop `do`·if 분기·parallel 레인). `Map<string, number>` 반환. 유닛 테스트(조건 피연산자 커버 + teeth-check). | `scanVars.ts` |
| **R4** | `VariablesPanel`에서 변수별 **사용 힌트**(muted `text-xs`): count===0 → `ko.editor.variableUnused`("미사용"), 아니면 `ko.editor.variableUsage(count)`("N개 스텝에서 사용"). 모델 변경마다 `useMemo`로 1회 도출(셀렉터 안 인라인 스캔 금지 — getSnapshot 함정). | `VariablesPanel.tsx` |
| **R5** | `FlowOutline` **http leaf 행**: 이름+URL을 `flex min-w-0 flex-col` 블록 안에 각 **한 줄**(각각 `truncate`+`title`)으로 스택. 행 상단 정렬(`items-start`), 메서드 배지·드래그 핸들·`⚠`는 `shrink-0`. 2줄 wrap 제거. | `FlowOutline.tsx` |
| **R6** | `FlowOutline` **컨테이너 헤더 행**(loop/if/parallel)의 이름 span에 `truncate`+조상 `min-w-0` 적용(일관성) — 단일 줄·`items-center` 유지. 긴 컨테이너 이름이 wrap·삐져나오지 않게. | `FlowOutline.tsx` |
| **R7** | **YAML 모달 Monaco를 사용 가능한 높이로 — 두 메커니즘 모두 방어**(cause-독립): ① `EditorShell`에서 `<MonacoYamlView/>`를 `<div className="h-[70vh]">`로 감싸 **확정 높이 조상** 제공(mount 즉시 resolve되는 vh 단위 → Monaco가 측정할 실제 크기 보장). ② `MonacoYamlView`의 Editor options에 `automaticLayout: true` 추가(Monaco가 ResizeObserver로 컨테이너를 **재측정** → mount-시 측정 동결 케이스 해소). 70vh + 헤더 + 패딩이 패널 `max-h-[85vh]` 아래 — 짧은 뷰포트는 본문 `overflow-auto`가 커버. **수정됨의 권위 신호 = 라이브 `getBoundingClientRect().height > 300` + 실제 타이핑**(§6). | `EditorShell.tsx`, `MonacoYamlView.tsx` |
| **R8** | 신규 사용자 노출 문구는 전부 `ko.editor.*` 경유(ADR-0035) — `variableUnused`·`variableUsage(n)`. 하드코딩 영어/한국어 금지. | `ko.ts` |

---

## 3. 핵심 통찰 (설계 근거)

1. **키-값 *모델*은 옳다 — 문제는 *표현*이다.** 흐름 변수는 이름→초기값 슬롯(`{{name}}`)이라 키-값이 정직한 표현이고 헤더/폼/ENV 에디터와 일관된다. 게다가 에디터는 양방향 sync의 GUI 절반이라(ADR-0003) 복잡 케이스는 YAML 뷰가 받는다. 그러므로 패널은 *흔한 빠른 케이스*(목록 훑기·값 한 개 수정)를 잘하면 되고, 메타데이터 헤비 UI로 키울 필요 없다 → 세로 스택 + 값 가시화 + 가벼운 사용 힌트로 충분.
2. **사용 힌트는 *거짓말하면 안 된다*.** "미사용" 배지가 틀리면(실제로 쓰이는데 미사용 표시) 없느니만 못하다. 기존 `scanFlowVars`는 http 요청 필드만 스캔하고 **조건 피연산자는 의도적으로 제외**(scanVars.test.ts:87 — `{{code}}` 미포함)한다. 따라서 사용량 스캐너는 조건 피연산자(`left`/`right`)까지 커버해야 신뢰할 수 있다. 그래서 R3은 `scanFlowVars` 재사용이 아니라 *완전한* 표면 스캔이다.
3. **"참조됐으나 미정의" 경고는 이 슬라이스에 넣지 않는다.** 그것은 extract 산출 변수 + 데이터셋 바인딩(run-config, 시나리오 모델 밖) 변수를 union해야 false-alarm을 피한다(문서화된 DataBindingPanel 함정의 역). 레이아웃 슬라이스의 범위/위험에 안 맞아 별도 후속으로 연기(§7). 반면 R3/R4의 "미사용/N곳"은 *완전한 시나리오-내부 표면*만으로 정직하게 도출되므로 안전.
4. **#5의 cause는 정적으로 단정하지 않고 *두 메커니즘 모두* 방어한다 — RTL이 못 본다.** 정적 CSS 추론은 모순적이다: `MonacoYamlView:75`의 `min-h-[400px]`가 first-principles상 에디터를 ≥400px로 floor해야 하는데 사용자는 ≈0을 봤다. 즉 "퍼센트 체인 붕괴"만으론 설명이 안 되고 Monaco가 `automaticLayout` 없이 mount 시 컨테이너를 1회 측정해 동결되는 게 유력하다. **그래서 단일 cause 핀에 의존하지 않는 견고한 수정**: (1) 호스트(`EditorShell` 모달)가 `h-[70vh]` 확정 높이를 제공(mount 즉시 resolve — Monaco가 측정할 >0 크기 보장) + (2) `automaticLayout: true`로 Monaco가 컨테이너를 재측정. 둘이 상보적이라 어느 메커니즘이 지배하든 에디터가 사용 가능해진다. `MonacoYamlView`의 `h-full` fill-parent 의도는 유지(호스트가 높이 소유 = 단일 소비처라 안전). **EditorShell 테스트가 `MonacoYamlView`를 목**하므로(`yaml-view` stub) 높이는 RTL로 검증 불가 → **라이브 Playwright가 cause를 실측하고 "수정됨"의 권위 신호**(`getBoundingClientRect().height > 300` + 타이핑, 직전 슬라이스 false-PASS 교훈 — 클립보드만 보고 통과시킴).
5. **드래그 배선은 절대 건드리지 않는다.** R5/R6은 행 *마크업*만 바꾼다 — `useSortable`/`setNodeRef`/`transform` 스타일/드래그 핸들/`SortableContext`/`resolveDragEnd`는 그대로. http leaf의 `setNodeRef`는 행 div에, 핸들은 첫 자식에 유지하고 이름/URL 블록만 그 안에 넣는다(#3/#4 스냅백 버그는 슬라이스 B 소관 — 본 슬라이스가 *악화*시키지 않음을 회귀 테스트로 보장).

---

## 4. 변경 상세

### 4.1 `ui/src/scenario/scanVars.ts` — 충족 R: R3
- 신규 `export function countFlowVarUsage(scenario: Scenario): Map<string, number>` — 전체 스텝 트리를 walk하며, 각 스텝이 참조하는 변수명 집합을 모아(중복 없이) 변수별 *스텝 카운트*를 증가. 스텝 1개가 같은 변수를 여러 번 참조해도 그 스텝에 대해 +1(="N개 스텝에서 사용").
- 참조 표면: http leaf = url·헤더 값·바디(raw/form/json string leaf, 기존 `collectFromString`/`collectFromJson` 재사용). **if/elif 스텝 = 조건 트리의 leaf `left`·`right`**(단항 `exists`/`empty`는 right 없음).
- **조건 스캔의 완전성(F3)**: if 스텝의 `cond` *그리고* **각 `elif[].cond`**(`model.ts:185` — elif마다 자기 조건 트리)를 모두 스캔. 조건 트리는 `all`/`any` 그룹 재귀. 또한 모델은 1레벨 상호 중첩을 허용(`NestedIfStep`이 `loop.do` 안에 — `model.ts:167,178`)하므로 walk는 **중첩 컨테이너를 넘어 재귀**해야 한다(loop `do`·if `then`/`elif[].then`/`else`·parallel `branches[].steps` + 그 안의 컨테이너의 조건까지). 최상위 컨테이너만 훑으면 중첩 if의 조건 변수를 놓쳐 "미사용" 오판.
- 기존 `scanFlowVars`(참조 *집합*, Set)은 **무변경**(DataBindingPanel·InsertTemplateModal 소비처 보존). `countFlowVarUsage`는 추가 함수.
- 구현 메모: `flattenHttpSteps`는 조건 노드를 안 주므로(http leaf만) 여기선 자체 재귀 walk가 필요. 조건 피연산자 수집은 `collectFromString(c.left)`·`collectFromString(c.right ?? "")` + `all`/`any` 재귀.

### 4.2 `ui/src/components/AutoGrowTextarea.tsx`(신규) — 충족 R: R2
- 제어 textarea 래퍼: `value`/`onChange`/`className`/`aria-label` 등 패스스루. mount·value 변경 시 `el.style.height='auto'; el.style.height = el.scrollHeight + 'px'`로 내용 높이에 맞춤(`useLayoutEffect([value])`). CSS로 `max-h-40 overflow-y-auto`(상한 도달 시 스크롤·`max-height`가 inline `height`를 클램프). `rows={1}` 기본·`resize-none`.
- jsdom 한계: `scrollHeight`=0이라 RTL에선 자동 높이가 0(무크래시·값/onChange는 정상) → 시각은 라이브 검증. RTL은 textarea 존재·전폭 클래스·onChange 동작만 단언.

### 4.3 `ui/src/components/scenario/VariablesPanel.tsx` — 충족 R: R1, R2, R4
- 변수 행(`<li>`)을 가로 1행에서 **세로 스택**으로 (F2 — 줄 배치 확정): **첫 줄** = 이름 `<span className="block w-full truncate font-mono text-xs ..." title={key}>` + 우측 `×` 버튼(`shrink-0`); **둘째 줄** = `<AutoGrowTextarea>`(전폭); **셋째 줄**(값 아래, 자체 줄) = 사용 힌트 `<span className="text-xs text-slate-400">`. (힌트를 이름 줄에 붙이지 않음 — 좁은 210px에서 이름 truncate 공간을 잠식하지 않게.)
- 이름 줄 레이아웃: `flex items-center gap-2`에서 이름 span `min-w-0 flex-1 truncate`, `×` `shrink-0`. (이름은 비편집 — 현행 span 유지, rename 아님.)
- 값: 기존 `<input>`→`<AutoGrowTextarea value={value} onChange={(e)=>setVariable(key, e.target.value)} className="w-full ...">`. 커밋 즉시(현행).
- 사용 힌트: `model` 셀렉터 추가(`useScenarioEditor((s) => s.model)` — 안정 ref) + `const usage = useMemo(() => model ? countFlowVarUsage(model) : new Map<string,number>(), [model])`. 각 변수 `const n = usage.get(key) ?? 0` → `n === 0 ? ko.editor.variableUnused : ko.editor.variableUsage(n)`.
- **무변경**: add-row(`new_var` 1칸 + 추가 버튼)·빈 상태(`variablesEmpty`)·`EMPTY_VARS` 모듈 상수·셀렉터 안정성(인라인 `?? {}` 금지) — 기존 getSnapshot 핀 테스트(`VariablesPanel.test.tsx` model=null 윈도) 보존.

### 4.4 `ui/src/components/scenario/FlowOutline.tsx` — 충족 R: R5, R6
- **http leaf 행**(`:180-203`): 행 컨테이너 정렬을 `items-center`→`items-start`로(2줄 블록). 핸들·메서드 배지 뒤에 `<div className="flex min-w-0 flex-col">` 안에 이름 `<span className="truncate font-medium" title={step.name}>` + URL `<span className="truncate text-xs text-slate-500" title={step.request.url}>` 두 줄. `⚠` 배지 `shrink-0` 유지.
  - 정렬 변경 처리: `rowProps.className`은 공유 객체이므로 leaf만 `items-start`를 적용(예: leaf에서 `className`을 `items-center`→`items-start`로 치환하거나, 정렬을 분리 가능한 형태로 소폭 리팩터 — plan이 가장 깔끔한 방식 선택). 컨테이너 행은 `items-center` 유지.
- **컨테이너 헤더 행**(loop `:94-99`·if `:118-123`·parallel `:150-154`): 이름 `<span className="font-medium">`에 `min-w-0 truncate` 추가(필요 시 헤더 flex에 `min-w-0`). 부가 텍스트(× repeat·조건 요약·분기 없음)는 현행 유지 — 이름만 클립.
- **드래그 무변경**: `useSortable`·`setNodeRef`(행 div)·`transform`·`dragHandle`·`SortableContext`·`resolveDragEnd`·`moveStep`·키보드 센서 전부 그대로. 마크업만 변경.

### 4.5 `ui/src/components/scenario/EditorShell.tsx` + `MonacoYamlView.tsx` — 충족 R: R7
- **EditorShell**: `<Modal ...><MonacoYamlView /></Modal>`(`:79-81`)을 `<Modal ...><div className="h-[70vh]"><MonacoYamlView /></div></Modal>`로. 그리드(`:61`)·변수 토글·기타 무변경.
- **MonacoYamlView**: `<Editor options={{...}}>`(`:81-88`)에 `automaticLayout: true` **한 줄 추가**(Monaco가 ResizeObserver로 컨테이너 재측정). 그 외 컴포넌트 로직(디바운스·pending 텍스트·yamlError·worker 등록) 무변경. — 두 변경은 상보적(§3.4): 래퍼는 측정할 확정 높이를, automaticLayout은 재측정을 보장.

### 4.6 `ui/src/i18n/ko.ts` — 충족 R: R8
- `ko.editor`에 추가: `variableUnused: "미사용"`, `variableUsage: (n: number) => \`${n}개 스텝에서 사용\``. (조사 병기 불필요 — "N개"는 받침 가변 명사 뒤가 아님.)

### 4.7 무변경 파일 (명시)
- `Modal.tsx`·`store.ts`·`model.ts`·`yamlDoc.ts`·`reorder.ts` — 읽기만(R7 호스트 래퍼는 EditorShell, R5/R6은 마크업). `MonacoYamlView.tsx`는 `automaticLayout: true` 1줄 외 무변경(§4.5).

---

## 5. 무변경 / 불변식 (명시)

- **모델/wire/store-편집 의미론 byte-identical** — UI-only. `model.ts`/`yamlDoc.ts`/`store.ts` 편집 액션 무변경. `scanVars.ts`는 읽기 전용 함수 *추가*(기존 `scanFlowVars` 무변경). 시나리오 직렬화·sync·검증 경로 무영향.
- **그리드 변수 컬럼 210px 유지** — `EditorShell` grid 문자열 무변경(모달 래퍼 div만 추가).
- **VariablesPanel add-row·빈 상태·이름 비편집** 유지 — rename/bulk 없음.
- **드래그/재정렬 동작(#3/#4) 무변경** — R5/R6은 마크업만. 본 슬라이스가 스냅백 버그를 *고치지도 악화시키지도* 않음(슬라이스 B 소관) — 회귀 테스트로 기존 드래그 단위(`resolveDragEnd`)·DOM 핸들 보존 확인.
- **`MonacoYamlView`는 `automaticLayout: true` 옵션 1줄 추가 외 무변경** — 디바운스·pending·sync·worker 등록 로직 byte-identical. 호스트 높이 래퍼는 EditorShell.
- **기존 `scanFlowVars` 소비처(DataBindingPanel·InsertTemplateModal) byte-identical.**
- **"참조됐으나 미정의" 경고·rename·bulk 미포함**(§7 연기).

---

## 6. 테스트 / 검증

- **유닛 `scanVars` (R3)**: `countFlowVarUsage` — ① http 필드 참조 카운트(url/헤더/바디), ② **조건 피연산자 카운트**(`left`/`right`의 `{{var}}` — `scanFlowVars`가 못 보는 것), ③ loop/if/parallel 중첩 하강, ④ 한 스텝이 같은 변수 다회 참조 시 +1, ⑤ **teeth-check**: 조건 스캔을 일시 제거하면 조건-only 변수 카운트가 0으로 떨어짐을 확인 후 복원.
- **RTL `VariablesPanel` (R1/R2/R4)**: 변수 행이 이름 span(`truncate`+`title`) + 값 `textarea`(전폭) 세로 구조; 값 textarea onChange→`setVariable`; 사용 힌트가 fixture에서 "미사용"/"N개 스텝에서 사용" 렌더(`ko` 경유). 기존 getSnapshot 핀(model=null) 테스트 보존(파일 첫 마운트 유지).
- **RTL `AutoGrowTextarea` (R2)**: 존재·value/onChange 패스스루·전폭 클래스(jsdom은 자동 높이 미관측 → 높이 단언 없음).
- **RTL `FlowOutline` (R5/R6)**: http leaf 이름·URL 각 `truncate`+`title`; 컨테이너 헤더 이름 `truncate`. 기존 드래그/선택/렌더 단위 테스트 무회귀(`resolveDragEnd` 6케이스·act 경고 0 유지).
- **RTL `EditorShell` (R7)**: 모달 open/close 동작(yaml-view 목) — 높이는 RTL 불가.
- **라이브 검증 (필수 — #5 시각 표면)**: `/live-verify` + Playwright로 ① `</> YAML` 모달 열기 → **`.monaco-editor` `getBoundingClientRect().height > 300` 단언 + 실제 타이핑** + 스크린샷(직전 슬라이스가 클립보드-내용만 보고 #5를 false-PASS한 교훈 — 모달/에디터 높이는 `getBoundingClientRect` 또는 screenshot으로), ② 변수 패널 세로 스택 + 긴 값 가시성 + 사용 힌트 스크린샷, ③ 아웃라인 긴 스텝명/URL 각 한 줄 스크린샷. (`--ui-dir`는 절대경로 `$PWD/ui/dist`로 — cwd-drift Monaco 청크 MIME 함정.) **참고**: `automaticLayout: true`는 일부 브라우저에서 무해한 `ResizeObserver loop … undelivered notifications` 콘솔 *경고*를 낼 수 있다 — Zod/React 에러가 아니므로 라이브검증 콘솔 체크에서 PASS를 막지 않음(이걸 실패로 오인 말 것).
- **게이트**: `pnpm lint && pnpm test && pnpm build`(머지 전 인자 없는 전체 1회). tdd-guard: 각 task **테스트 파일 먼저** 편집(pending RED) 후 src(ui/CLAUDE.md tdd-guard 순서 함정).
- **production diff 시각 표면 + #5 RTL 불가** → 라이브 검증 생략 불가.

---

## 7. 의도적 연기 (roadmap §B/에디터 트랙·tier C 백로그에 누적)

- **#3 컨테이너 드래그 스냅백 + #4 하위 스텝 안 따라옴** — 슬라이스 B(DragOverlay + nesting-aware collision 또는 flat-tree sortable·Playwright 포인터-드래그 실측). 본 슬라이스와 분리.
- **변수 이름 편집(rename)** — `{{old}}`→`{{new}}` 참조 재작성(url/헤더/바디/조건) 또는 orphan 경고 동반 = 본 레이아웃 슬라이스 밖. tier C.
- **변수 일괄 붙여넣기 입력**(`name: value` 줄, `kvBulk` 이디엄 재사용)·값 타입/설명 메타데이터 — tier C.
- **"참조됐으나 미정의" 변수 경고** — extract 산출 + 데이터셋 바인딩 변수 계정 필요(false-alarm 함정) → 별도 후속.
- **ADR-0044 §7 기존 연기**(하단 흐름 가로 칩 다이어그램+test-run 결과 색/아이콘[슬라이스 2]·컨테이너 경계 넘는 re-parent dnd[슬라이스 3]·YAML 가져오기/내보내기 file-I/O) — 무관·그대로.

---

## 8. 구현 순서 (plan 입력)

각 task는 독립 green 커밋. tdd-guard 순서 = **테스트 먼저**.

1. **R3** — `scanVars.ts` `countFlowVarUsage` + 유닛 테스트(조건 피연산자 + teeth). 순수 함수라 선행.
2. **R8** — `ko.ts` `variableUnused`/`variableUsage(n)` 키.
3. **R2** — `AutoGrowTextarea` 컴포넌트 + RTL.
4. **R1+R2+R4** — `VariablesPanel` 세로 스택 + 값 textarea 배선 + 사용 힌트 + RTL.
5. **R5+R6** — `FlowOutline` http leaf 이름/URL 스택 + 컨테이너 헤더 이름 truncate + RTL(드래그 무회귀 포함).
6. **R7** — `EditorShell` 모달 `h-[70vh]` 래퍼 + `MonacoYamlView` Editor options `automaticLayout: true`.
7. **게이트 + 라이브 검증** — `pnpm lint && pnpm test && pnpm build` + Playwright(#5 높이 단언·스크린샷 3종).

> **normative는 §2 R-표.** §4는 구현 가이드(가장 깔끔한 방식은 plan/구현 재량), §5 불변식은 리뷰 체크리스트.

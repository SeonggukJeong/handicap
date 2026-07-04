# 에디터 UX 폴리시 — 변수 패널·뷰포트 높이·이름변경 실시간 반영 설계

- **날짜**: 2026-07-04
- **상태**: 설계 (spec) — spec-plan-reviewer 2R APPROVE-WITH-FIXES 반영(§9)
- **출처**: 사용자 요청(불편 항목 4종). editor-var-tools-b 직후 도그푸딩에서 나온 실사용 마찰 — 변수 많아지면 화면 무한 확장·rename 후 열린 스텝 stale·사용-nav 순환 불편·변수 검색 부재.
- **선행**: ADR-0044(에디터 아웃라인) 범위 내 — **ADR 신규 없음**. editor-var-tools(A)·editor-var-tools-b(B)의 `VariablesPanel`/`scanVars`/rename 위에 얹는다.
- **성격**: **UI-only**. `crates`/proto/migration/`model.ts`(Zod)/YAML 직렬화 **형식**/store rename **시그니처** 0-diff. `ui/src` 안에서만(store에 `renameEpoch` 필드 additive 추가는 있음 — 와이어 아님, 클라 렌더 상태).

> 참고: 과거 머지된 슬라이스도 브랜치명이 `editor-ux-polish`였다(test-run UX 통합·검증 배너). 이 슬라이스는 그와 **무관한 별개 스코프**이며 spec 파일명으로 구분한다.

---

## 1. 문제와 목표

에디터에서 스텝·변수가 많아지면 (#4) 페이지가 무한히 길어지고 "넓게 보기"에서만 스크롤이 된다. 변수 이름을 바꾸면 (#5) 현재 열린 스텝의 헤더/JSON 바디/추출 입력이 재선택 전까지 옛 토큰(`{{old}}`)을 그대로 보여준다. 변수 사용처 nav는 (#3) 클릭마다 한 스텝씩 순환할 뿐 전체를 못 보고 직접 못 고른다. 변수가 많을 때 (#6) 찾을 검색이 없다.

- **목표**: 에디터를 한 화면(뷰포트) 높이 안에 담고 각 열을 내부 스크롤(#4)·사용처 nav를 팝오버 목록 직접 점프(#3)·rename을 열린 스텝에 실시간 반영(#5)·변수 검색(#6). 전부 UI-only.
- **비목표(연기)**: §7 — 검색 고급(정규식/스코프 필터)·팝오버 화살표키 내비·전체화면 셸(test-run 탭 분리)·rename 외 구조편집의 draft 재시드·기존 HelpTip/헤더메뉴 portal화(라이브가 문제 삼을 때만).

### 사용자 결정 (brainstorming)

1. **범위**: 4항목 한 슬라이스 — #3 사용-nav 팝오버·#4 열별 독립 스크롤·#5 rename 실시간 반영·#6 변수 검색. (#1 test-run 진행률·중지, #2 HTML form/select 추출은 별 슬라이스.)
2. **#3**: 순환 대체 = **팝오버 목록 + 직접 점프**. 항목 클릭 시 팝오버는 **닫지 않음**(사용처를 오가며 점프); **바깥 클릭·ESC만 닫힘**. 현재 선택된 스텝 항목은 active 표시.
3. **#4**: **열별 독립 스크롤** — 에디터 그리드를 뷰포트 높이 이내로 제한, 변수·아웃라인·디테일 세 열이 각자 내부 스크롤. test-run은 에디터 아래 그대로(페이지 스크롤로 도달). 전체화면 셸(옵션 C) 기각.
4. **#5**: rename(값 편집 아님)만 대상 — 이름을 바꿨을 때 영향받는 참조가 실시간 갱신.
5. **#6**: 검색은 변수명 + **값** + parallel 분기 표기까지 부분일치.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST #3 — "N개 스텝에서 사용" 클릭 시 순환 대신 **버튼에 앵커된 팝오버**가 열려 참조 스텝을 문서순 나열(http=메서드 텍스트[`METHOD_BADGE[method]` 클래스 스타일]+스텝명 / `if`=타입 라벨+`summarizeCondition(cond)` / loop·parallel=타입 라벨+스텝명, `findStepById(model.steps,id)`로 해석). 항목 클릭 → `onJumpToStep(id)` 호출하고 **팝오버는 열린 채 유지**; 현재 `selectedStepId`와 일치하는 항목은 active 스타일. **바깥 pointerdown·ESC·리스트 스크롤로 닫힘**, 한 번에 하나만 열림(다른 변수 nav 열면 이전 닫힘). | `VariablesPanel.test.tsx`: 클릭→목록 렌더·항목 클릭 시 `onJumpToStep` 호출+팝오버 잔존·active 표시·ESC/바깥클릭 닫힘·둘째 열면 첫째 닫힘 | |
| R2 | MUST #3 팝오버는 #4의 `overflow-auto` 열에 **클리핑되지 않아야** 한다 → `Modal.tsx` 선례대로 **portal(document.body) + fixed 위치**(앵커 `getBoundingClientRect`)로 렌더하고 뷰포트 우/하단 넘치면 edge-flip. 순환 상태(`cycleRef`/증가 인덱스)·`nav` 순환 함수 제거. `미사용`(refIds 빈) 행은 기존대로 비버튼 텍스트 유지. 팝오버는 declared/flat-extract/parallel-extract/undefined **모든 행종**에 동일 적용(각자 refIds 소비). | `VariablesPanel.test.tsx`: 순환 인덱스 부재(2회 클릭에 같은 목록)·미사용 비버튼·portal 렌더(`document.body` 자식)·행종별 목록 / 라이브: `overflow-auto` 열 안에서 열어도 미클립 | |
| R3 | MUST #4 — 비-wide 에디터 그리드(`data-testid="editor-grid"`)를 뷰포트 높이 이내로 제한: `max-h-[calc(100vh − <chrome>)]` **+ 명시 shrinkable 행 트랙 `grid-rows-[minmax(0,1fr)]`**(grid는 flex와 달리 `max-h`+`min-h-0`만으론 `auto` 행이 콘텐츠로 넘쳐 열 스크롤이 발동 안 함 — 행 트랙 필수, 라이브 확정 F1). 기존 `min-h-[680px]` 무한 바닥 제거. 열별 독립 스크롤 — **아웃라인·디테일 열은 컨테이너 `overflow-auto min-h-0`**; **변수 aside는 `overflow-visible`(내부 `<ul>` 리스트만 `overflow-auto min-h-0`, R13/F2 회귀 방지)**. 위 툴바는 그리드 밖이라 항상 보임. 콘텐츠 짧으면 그리드가 줄어 test-run이 올라오고, 길면 넘치는 열만 내부 스크롤 — **에디터가 페이지를 뷰포트-chrome 이상으로 밀지 않음**. `<chrome>`값은 wide 선례(`16rem`)에서 출발해 라이브로 확정(근사값 — `ValidationBanner` 조건부 표시 시 살짝 부족해 미세 스크롤 가능=수용, M3). | 라이브: 스텝 다수 시나리오에서 `editor-grid` `getBoundingClientRect().height ≤ innerHeight − chrome`·아웃라인 열 `scrollHeight > clientHeight`(내부 스크롤 활성)·변수 열도 동일·**열이 test-run 위로 안 넘침**; RTL: 아웃라인·디테일 컨테이너 `overflow-auto`+`min-h-0`·변수 aside `overflow-visible`+내부 `<ul>` `overflow-auto min-h-0`·그리드 `grid-rows-[minmax(0,1fr)]`·`min-h-[680px]` 부재 | |
| R4 | MUST #4 — wide 모드 변수 aside도 동일하게 바운딩/스크롤(일관성). aside는 wide/비-wide 삼항 **앞에서 1회 렌더되는 단일 요소**라 className을 `wideOpen`으로 분기(비-wide=그리드 행에 바운드 / wide=`max-h-[calc(100vh-16rem)]`)해야 두 모드가 각자 맞는 캡을 가진다(M1). 기존 wide 아웃라인 스크롤(`max-h-[calc(100vh-16rem)]`) 보존. | RTL 클래스 계약(모드별 aside className 분기) + 라이브 | |
| R5 | MUST #5 — store에 `renameEpoch: number` 추가, `renameVariable`·`renameParallelVar`가 **성공 커밋(반환 `null`) 시에만** 증가(단일 성공 `set` 분기 — `store.ts:174-179`/`:201-206`). 두 액션의 **시그니처·반환타입 불변**(필드 추가만·`RenameVarError` 그대로). no-op/실패(self/invalid/shadow/collision)엔 미증가. `INITIAL` `Pick<>`(`store.ts:101-111`)+`getInitialState`(`store.ts:475`)에 필드 포함(reset 자동 전파). | `store.renameVariable.test.ts`/`store.renameParallelVar.test.ts`: 성공 1회당 epoch +1·실패/no-op 시 불변 | |
| R6 | MUST #5 — Inspector draft 편집기 3종이 rename 시 재시드: `JsonBodyField`(`:497-503`)·`ExtractEditor`(`:703-706`)의 `useEffect` 재시드 dep에 `renameEpoch` 추가, `KeyValueGrid`(헤더 `:438`·폼 `:579`) `resetKey={`${step.id}:${renameEpoch}`}`. 결과: **현재 열린 스텝**의 헤더/JSON 바디/추출에서 쓰이는 변수를 rename하면 재선택 없이 입력이 새 토큰으로 갱신. 필드 자체 커밋엔 epoch 불변이라 **self-commit 재시드 0**(KeyValueGrid content-deep-compare 재시드 함정 회피). URL/메서드는 store-controlled라 이미 live(무변경), 조건 편집기는 `[cond]` content 재시드라 이미 live(무변경). | `Inspector.test.tsx` teeth-check: rename 전엔 stale(dep에서 renameEpoch 빼면 옛 토큰) → 넣으면 새 토큰; 헤더 값·JSON 바디·extract var 3표면 | |
| R7 | MUST #6 — VariablesPanel 상단 검색 입력이 행을 **대소문자 무시 부분일치**로 필터: 변수명 + 값(declared 행의 value) + parallel 분기 표기(`branchName.varName` display). 빈 쿼리=전 행. 무매치=**`variablesEmpty`와 구분된** 빈 상태 안내(`ko.editor.varSearchEmpty`). 필터는 **표시 전용**(모델 무접촉 — add/rename/nav는 전체 모델 기준). | `VariablesPanel.test.tsx`: 이름/값/분기표기 매치·대소문자 무시·빈 쿼리 전체·무매치 안내(전용 키) | |
| R8 | MUST #6 — 검색이 add/rename/nav를 깨지 않음: 필터아웃 행은 미렌더일 뿐, 변수 추가 입력·rename 연필·nav·삭제 동작 무영향. **변수 추가(`추가`) 시 검색어를 클리어**해 방금 추가한 변수가 필터에 가려지지 않게 한다(M5). | `VariablesPanel.test.tsx`: 필터 상태에서 add-var 동작+추가 후 검색어 클리어·매치 행 rename/nav 정상 | |
| R9 | MUST 신규 사용자 노출 문구(팝오버 항목 aria/타입 라벨·검색 placeholder·무매치 안내·active aria) 전부 `ko.ts`(ADR-0035), 인라인 한글/영어 0. | 하드코딩 sweep(`'"[^"]*[가-힣]'` + ternary-attr `(aria-label|title|placeholder)=\{[^}]*"[A-Za-z]`) + 리뷰 | |
| R10 | MUST 엔진/컨트롤러/proto/migration/`model.ts`(Zod)/YAML 직렬화 **형식**/store rename **시그니처** 0-diff — `ui/src` 밖 무접촉. 신규는 전부 additive(store `renameEpoch` 필드·팝오버/검색 로컬 상태·Inspector 재시드 dep). ADR 신규 없음. | diff 스코프 grep(`git diff --name-only` = `ui/**`·`docs/**`만) + 기존 model/yamlDoc/wire 테스트 무수정 green | |
| R11 | MUST 의도된 nav 거동 변경(순환→팝오버) 외 기존 소비처 무영향 — 기존 순환-nav 테스트는 팝오버로 **재작성**(의도된 변경, 회귀 아님; VariablesPanel의 유일 프로덕션 소비처는 EditorShell이고 `cycleRef`/`nav`는 로컬이라 코히런트), 그 외 VariablesPanel/Inspector/EditorShell/store 테스트 green. | 인자 없는 전체 `pnpm test` green + `pnpm build` + `pnpm lint` | |
| R12 | SHOULD §7 연기 항목을 `docs/roadmap.md`에 등재. | roadmap.md diff | |
| R13 | MUST #4 — 열을 `overflow-auto`로 만들며 **기존 absolute 오버레이 클리핑 회귀 방지**(F2): 변수 열은 헤더(제목+`VarCheatSheet` HelpTip+검색)와 **하단 변수-추가 입력 행**을 스크롤 밖에 `shrink-0`로 고정하고 **가운데 `<ul>` 리스트만 `overflow-auto min-h-0`**(aside 자체는 `overflow-visible` 유지 → 224px `VarCheatSheet` HelpTip이 210px 열 밖으로 미클립·검색/제목/추가입력 pinned = UX 개선·긴 목록에서도 추가입력 도달 가능 M6b). 디테일 열의 JSON 캐스트 HelpTip(`Inspector.tsx:533`)·KeyValueGrid 헤더 메뉴(`KeyValueGrid.tsx:316`)는 **인라인 유지**(portal 안 함)·스크롤 열 안 거동을 라이브로 확인 — 세로 클립은 수용된 한계(트리거 근처 렌더·디테일 열은 가로 충분), 심하면 §7 후속으로 portal화. | 라이브: 변수 열 리스트 스크롤 시 VarCheatSheet HelpTip 미클립·디테일 열 스크롤 시 캐스트 HelpTip/헤더 메뉴 거동 확인 | |

**seam 없음** — 전 요구사항이 UI 렌더/로컬 편집/클라 상태 한정. rename은 기존 참조 *내용*만 재작성(형식 불변, B 슬라이스가 소유), `renameEpoch`는 와이어에 안 나감.

---

## 3. 핵심 통찰 (설계 근거)

1. **#3 팝오버는 portal-fixed여야 한다(R2) — #4와의 상호작용.** #4가 변수 열을 `overflow-auto`로 만들면 그 안에 `absolute`로 띄운 팝오버(HelpTip 이디엄)는 **열 경계에서 잘린다**(CSS: 한 축이 auto면 다른 축 visible이 auto로 강등돼 무력). 따라서 `Modal.tsx`의 portal 선례대로 `createPortal(document.body)` + 앵커 rect 기반 `fixed` 위치로 클립을 원천 회피하고 뷰포트 edge-flip한다. 순환(cycleRef) 제거는 자연 귀결 — 팝오버가 전체를 한 번에 보여주므로 인덱스가 불필요. fixed는 open 시점 rect로 배치되므로 리스트 스크롤 시 어긋남 → **리스트 스크롤에 닫힘**(R1, M6).

2. **#4는 `max-h` + `grid-rows-[minmax(0,1fr)]` + 열별 `overflow-auto min-h-0`(R3).** 고정 `h-`가 아니라 `max-h`여야 콘텐츠가 짧을 때 그리드가 줄어 test-run이 올라온다(사용자 결정 3). **핵심(F1)**: grid는 flex와 다르다 — wide 모드 선례(`EditorShell.tsx:117` `flex flex-col` + `:126` `min-h-0 flex-1`)의 `min-h-0` 트릭은 flex에서만 통하고, 비-wide **grid**는 암시적 `auto` 행이 `max-h` 캡을 무시하고 콘텐츠로 넘쳐 열 스크롤이 발동 안 한다 → 넘친 열이 test-run 위로 겹친다(#4가 고치려는 그 버그). 명시 `grid-rows-[minmax(0,1fr)]`(shrinkable 행 트랙)를 줘야 행이 캡 이내로 줄고 열의 `overflow-auto`가 산다. **jsdom은 레이아웃이 없어 이 캡/스크롤을 관측 못 하므로**([[implementation-rigor-over-spec]]) R3 correctness는 RTL 클래스 계약 + **라이브 `getBoundingClientRect`/`scrollHeight` 실측**이 권위다(RTL만 보면 F1 결함이 안 보임). `<chrome>`은 라이브 확정(wide 선례 `16rem`); `ValidationBanner` 조건부 표시로 정확한 단일 상수가 불가라 근사값+미세 스크롤 수용(M3).

3. **#5는 content-dep 재시드가 아니라 rename-epoch(R5/R6).** draft를 미러 콘텐츠 deep-compare로 재시드하면 필드 *자체* 커밋마다 재발화해 진행 중 편집을 리셋한다(ui/CLAUDE.md `KeyValueGrid` 함정). rename은 **VariablesPanel에서 일어나는 이산 이벤트**(그 순간 Inspector 필드는 포커스/타이핑 중이 아님 — rename하려면 변수 패널을 클릭해 Inspector 필드가 blur됨)라, rename 성공에만 증가하는 `renameEpoch`를 재시드 키에 넣으면 필드 커밋엔 불변→self 재시드 0, rename엔 정확히 1회 재시드로 stale을 해소한다. **알려진 한계(M2·수용)**: epoch는 전역이라 어떤 rename이든 열린 스텝의 draft를 재시드하며, KeyValueGrid resetKey 재시드는 그 순간의 `newKey`/`newValue`/`bulkOpen` 미커밋 draft와 실패한 JSON blur의 invalid draft를 함께 버린다 — "타이핑 중 리셋 없음"은 self-commit에 한해 성립하고 "새 헤더를 반쯤 입력한 채 rename"엔 미성립. rename이 다른 패널에서 하는 명시 액션(필드 포커스가 이미 떠남)이라 수용. URL/메서드는 store-controlled(draft 없음)라 무변경 — 실제 stale은 draft 3종(JSON 바디·헤더/폼 KeyValueGrid·추출)에 한정됨을 코드로 확인. 조건 편집기는 `[cond]` content 재시드라 이미 live(무변경).

4. **#6은 표시 전용 필터(R7/R8).** `rows` 파생(`useMemo([model])`)은 그대로 두고, 렌더 직전 검색어로 필터만 건다. 모델·add·rename·nav는 전체 기준이라 필터 상태와 독립. 값 포함 검색은 사용자 결정(토큰/URL 조각으로도 찾게). 추가 시 검색어 클리어로 방금 추가한 변수를 가리지 않는다(M5).

---

## 4. 변경 상세

> 파일·함수 단위. 각 묶음 머리에 **충족 R** 태그.

### 4.1 `components/scenario/VariablesPanel.tsx` — 충족 R: R1, R2, R7, R8, R9, R13
- **팝오버(#3)**: `cycleRef`/`nav` 순환 제거. `usageCell`을 팝오버 트리거 버튼으로 — 클릭 시 `openUsageKey`(행 identity 문자열) 토글. 신규 `VarUsagePopover`(신규 파일 `components/scenario/VarUsagePopover.tsx`): props `{anchorRect 또는 anchorEl, refIds, steps, selectedStepId, onJump, onClose}`. `createPortal`로 body에 `fixed` 위치(앵커 `getBoundingClientRect`, edge-flip), `refIds`를 `findStepById(steps,id)`로 해석해 목록(http=`METHOD_BADGE[method]` 클래스로 메서드 텍스트, `if`=`summarizeCondition(cond)`, 그 외 컨테이너=스텝명). 항목 클릭 → `onJump(id)`(팝오버 유지), `id===selectedStepId`면 active 클래스. `useEffect`로 document `pointerdown`(바깥)·`keydown`(ESC)·리스트/열 `scroll` → 닫기. `selectedStepId`는 store 셀렉터 추가.
- **검색(#6)**: 상단 pinned 헤더(제목+VarCheatSheet+검색 `Input`)에 `query` 로컬 상태. 렌더 직전 `rows.filter(r => matches(r, query))` — `matches`는 name/value/parallel display를 소문자 부분일치. 무매치면 `ko.editor.varSearchEmpty`. `추가` 핸들러 끝에 `setQuery("")`.
- **레이아웃(R13)**: 패널을 `flex flex-col` — 헤더(제목/검색, `shrink-0`)와 **하단 추가-입력 행(`shrink-0`)은 스크롤 밖**, 가운데 변수 `<ul>`만 `flex-1 min-h-0 overflow-auto`. (aside `overflow-visible`은 EditorShell이 소유 — §4.2.)
- 신규 `ko.editor.*` 키(검색 placeholder·무매치·팝오버 타입 라벨·active aria·항목 aria).

### 4.2 `components/scenario/EditorShell.tsx` — 충족 R: R3, R4, R13
- 비-wide `editor-grid`: `min-h-[680px]` → `max-h-[calc(100vh−<chrome>)] grid-rows-[minmax(0,1fr)]`. 아웃라인 `<div>`·디테일 `<div>` 각각 `overflow-auto min-h-0` 추가(아웃라인은 이미 `overflow-auto`, `min-h-0`만 보강).
- 변수 `<aside>`(삼항 앞 단일 요소): `overflow-visible min-h-0` + className `wideOpen` 분기(비-wide=그리드 행에 바운드 / wide=`max-h-[calc(100vh-16rem)]`, R4/M1). 실제 스크롤은 aside가 아니라 내부 `<ul>`(§4.1 R13)이라 aside는 `overflow-visible`로 HelpTip 미클립.
- 기존 wide 아웃라인 스크롤 보존.

### 4.3 `scenario/store.ts` — 충족 R: R5
- 상태에 `renameEpoch: number`(초기 0). `renameVariable`(`:174-179`)/`renameParallelVar`(`:201-206`)의 **성공 커밋 `set`**에서 `renameEpoch: get().renameEpoch + 1` 포함. 실패/no-op 분기 미변경. `INITIAL` `Pick<>`+`getInitialState`에 필드 포함(reset 자동 전파).

### 4.4 `components/scenario/Inspector.tsx` — 충족 R: R6
- `renameEpoch` 셀렉터 추가. `JsonBodyField` 재시드 `useEffect` dep `[step.id]` → `[step.id, renameEpoch]`. `ExtractEditor` 재시드 dep `[step.id]` → `[step.id, renameEpoch]`. `KeyValueGrid`(헤더 `:438`·폼 `:579` 2곳) `resetKey={step.id}` → `resetKey={`${step.id}:${renameEpoch}`}`.

### 4.5 `i18n/ko.ts` — 충족 R: R9
- `editor.varSearchPlaceholder`·`editor.varSearchEmpty`(≠ 기존 `variablesEmpty`)·팝오버 항목 aria(`varUsageStepAria(name)`)·컨테이너/active aria·container 타입 라벨. 기존 `variableUsage`/`variableUsageNavAria`는 팝오버 트리거로 재사용/조정.

### 4.6 테스트 — 충족 R: R1–R8, R11, R13
- `VariablesPanel.test.tsx`: 순환 테스트 → 팝오버 테스트 재작성(R1/R2/R7/R8).
- `Inspector.test.tsx`: rename 재시드 teeth-check(R6, 3표면).
- `store.renameVariable.test.ts`/`store.renameParallelVar.test.ts`: epoch 증가(R5).
- EditorShell 클래스 계약(R3/R4/R13, jsdom 한도 — grid-rows·overflow-auto·min-h-0·min-h-[680px] 부재·aside 모드 분기).

---

## 5. 검증

- **RTL/유닛**: 위 §4.6. #4는 jsdom 미관측이라 클래스 계약까지만(F1 결함은 RTL 불가시 → 라이브 필수).
- **라이브(controller-served `ui/dist`, 백엔드 무런)** — `docs/dev/live-verify-playwright.md` 로드. [[implementation-rigor-over-spec]] 실측:
  - **#5**: 헤더 값 + JSON 바디에서 같은 변수를 쓰는 스텝을 열어둔 채 그 변수를 rename → 두 입력이 **재선택 없이** 새 토큰으로 갱신(React controlled `input.value` 실측).
  - **#4**: 스텝 다수 시나리오에서 `editor-grid` 높이 ≤ `innerHeight − chrome`·아웃라인/변수 열 `scrollHeight > clientHeight`(내부 스크롤)·**열이 test-run 위로 안 넘침**·페이지가 에디터 때문에 안 밀림. `ValidationBanner` 표시(검증 오류 시나리오) 시 미세 스크롤 여부 관찰(M3).
  - **#4 회귀(R13/F2)**: 변수 열 리스트 스크롤 시 `VarCheatSheet` HelpTip 미클립·디테일 열 스크롤 시 JSON 캐스트 HelpTip·KeyValueGrid 헤더 메뉴 거동 확인(세로 클립 심하면 §7 후속).
  - **#3**: 사용처 버튼 클릭→팝오버 목록·항목 클릭 시 점프+팝오버 잔존·ESC/바깥/스크롤 닫힘·`overflow-auto` 열 안에서 미클립(`getBoundingClientRect` 팝오버가 열 경계 밖에도 보임).
  - **#6**: 검색어로 행 필터(이름/값/분기)·무매치 안내·추가 후 검색어 클리어.
- 프로덕션 diff는 `ui/src`뿐이라 `security-reviewer`는 트리거 grep(요청실행/템플릿·캐스트/env·데이터셋 바인딩/업로드 파싱/trace·body 뷰어) **무매치 → N/A**(rename은 기존 참조 *내용* 재작성이나 이 슬라이스는 그 로직 무변경·표시/레이아웃/재시드만).

---

## 6. 파일 영향 요약

| 파일 | 변경 | R |
|---|---|---|
| `components/scenario/VariablesPanel.tsx` | 팝오버 nav(#3)·검색(#6)·순환 제거·헤더 pin/리스트 스크롤 | R1,R2,R7,R8,R9,R13 |
| `components/scenario/VarUsagePopover.tsx`(신규) | portal-fixed 팝오버 | R1,R2 |
| `components/scenario/EditorShell.tsx` | 뷰포트 높이·grid-rows·열별 스크롤(#4)·aside 모드분기 | R3,R4,R13 |
| `scenario/store.ts` | `renameEpoch` additive | R5 |
| `components/scenario/Inspector.tsx` | draft 3종 재시드 dep(#5) | R6 |
| `i18n/ko.ts` | 신규 문구 | R9 |
| 위 테스트 4파일 | 팝오버/검색/재시드/epoch/레이아웃 계약 | R1–R8,R11,R13 |
| `docs/roadmap.md` | 연기 항목 | R12 |

---

## 7. 비목표 (연기 — roadmap 등재, R12)

- **검색 고급**: 정규식·"미정의만/미사용만" 스코프 필터·값 하이라이트. 이번은 부분일치만.
- **#3 팝오버 화살표키 내비/포커스 트랩**: 클릭·ESC·스크롤 닫힘만. 리스트 키보드 순회는 후속(a11y 심화).
- **#4 전체화면 셸**: test-run을 탭/별도 스크롤로 분리하는 옵션 C 기각(범위·test-run 접근성 변경).
- **기존 HelpTip/KeyValueGrid 헤더메뉴 portal화**: 디테일 열 in-scroll 세로 클립이 라이브에서 수용 불가로 판명될 때만 후속(HelpTip은 앱 전역 공유 + ESC-in-Modal 레이어링 caveat라 이번 슬라이스 스코프 밖).
- **#5 rename 외 재시드**: move/reparent 등 다른 구조편집은 열린 스텝의 필드 *내용*을 재작성하지 않으므로 stale 유발 안 함 → 범위 밖. 향후 그런 액션이 생기면 같은 `renameEpoch`(→ 일반화된 `fieldRewriteEpoch`) 패턴 재사용.

---

## 8. 구현 순서 힌트 (plan 참고 — 리뷰어 스코프 관찰)

#5(epoch+dep)·#6(표시 필터)는 **저위험**(store 필드+dep 배열+순수 필터)이라 먼저 랜딩, #3(신규 portal 컴포넌트+순환 테스트 재작성)·#4(grid-rows/클리핑 CSS)는 **결합·라이브-heavy**라 뒤에. 한 슬라이스 유지(사용자 4항목 승인)하되 plan task 순서를 이 위험도로 배치. 만약 #3/#4 CSS가 커지면 8a(#5+#6)/8b(#3+#4) 분할이 자연 decomposition(현재는 미분할).

---

## 9. spec 리뷰 반영 (spec-plan-reviewer 1R, Opus)

APPROVE-WITH-FIXES → 전 finding 수용·반영:
- **F1**(grid `max-h`+`min-h-0`만으론 열 스크롤 무발동) → R3에 `grid-rows-[minmax(0,1fr)]` 명시·§3-2에 flex↔grid 차이 근거.
- **F2**(overflow-auto가 기존 absolute 오버레이 클립) → **R13 신규**: 변수 헤더 pin/리스트만 스크롤·aside `overflow-visible`(VarCheatSheet 미클립)·디테일 오버레이 라이브 확인+한계 수용.
- **M1**(단일 aside 두 캡) → R4/§4.2 className `wideOpen` 분기 명시.
- **M2**(전역 epoch 재시드가 미커밋 draft 버림) → §3-3 한계 명문화(수용).
- **M3**(`<chrome>` 단일상수 불가·banner) → R3/§3-2 근사값+미세 스크롤 수용·라이브 관찰.
- **M4**(`METHOD_BADGE`=클래스 record, `summarizeCondition`=if만) → R1/§4.1 문구 수정.
- **M5**(무매치 키 구분·필터 중 add 가림) → R7 전용 `varSearchEmpty` 키·R8 추가 시 검색어 클리어.
- **M6**(fixed 팝오버 스크롤 detach) → R1/§3-1 리스트 스크롤 닫힘.

**2R**(APPROVE-WITH-FIXES, 정밀화 2건 수용):
- **R3↔R13 모순**(R3가 "세 열 각각 overflow-auto"로 R13의 aside `overflow-visible`과 충돌·RTL 계약도 어긋남) → R3 본문·acceptance를 아웃라인/디테일=`overflow-auto min-h-0`·변수 aside=`overflow-visible`+내부 `<ul>` 스크롤로 정합.
- **M6b**(하단 변수-추가 행 pin 미명시) → R13/§4.1에 추가-입력 행 `shrink-0`(스크롤 밖 고정, 긴 목록서도 도달) 명시.

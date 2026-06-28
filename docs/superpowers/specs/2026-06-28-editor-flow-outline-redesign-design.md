# 에디터 흐름 재설계 — 팬 캔버스를 세로 인터랙티브 아웃라인으로 교체 + 넓은 편집기 + 변수 접기 + YAML 모달 (에디터 구조 재설계 슬라이스 1/3)

> **이 슬라이스의 normative 코어는 §2 R-표.** plan·구현·리뷰는 전부 R-id를 참조한다.

- **날짜**: 2026-06-28
- **상태**: 설계 승인(사용자 2026-06-28) → plan 대기
- **출처**: 사용자 요청(2026-06-28) — "디자인 시스템 추가 적용 *전*에 에디터를 더 useful하게." 현 React Flow 캔버스가 ① 스텝이 길어지면 글자가 작아져 흐름 파악이 어렵고 ② 팬이 클릭-드래그라 조작이 불편하며 ③ 드래그가 재정렬 같은 실기능이 없고 ④ 캔버스가 좌우 편집 패널 폭을 잡아먹어 긴 텍스트(변수/헤더/바디) 편집이 어렵다. **왜 지금**: 디자인 시스템 확산 전에 에디터의 *구조*를 먼저 바로잡아야 이후 폴리시가 헛돌지 않는다(내부 테스트 단계 QoL 트랙).
- **연관**: ADR-0003(GUI↔Code 양방향 sync), ADR-0015(Zustand+Zod+YAML AST round-trip), ADR-0020/0023(loop/if 1레벨 중첩), ADR-0035(UI 한국어 `ko.ts` 단일 소스), ADR-0043(디자인 시스템 프리미티브·accent 토큰). 선행 에디터 spec: `2026-06-19-editor-ux-polish-design.md`(test-run 재배치), `2026-06-01-scenario-editor-test-run-design.md`(`TestRunSection`/`summarizeCondition` 출처). 주요 파일: `ui/src/components/scenario/EditorShell.tsx`·`CanvasView.tsx`·`{Http,Loop,If,Parallel}StepNode.tsx`·`TabBar.tsx`·`MonacoYamlView.tsx`·`Inspector.tsx`·`VariablesPanel.tsx`·`ValidationBanner.tsx`·`ui/src/scenario/store.ts`·`yamlDoc.ts`·`model.ts`·`ui/src/i18n/ko.ts`.
- **ADR**: **신규 ADR 필요** — 에디터 1차 표현 모델을 "팬 가능한 노드-그래프 캔버스(React Flow)"에서 "세로 인터랙티브 아웃라인(HTML 트리)"으로 바꾸는 결정은 ADR-0003(양방향 sync)의 *표현*을 재정의하므로 결정 기록이 맞다. 본 spec의 §3이 근거, plan/finish 단계에서 `ADR-00XX`로 등재(다음 번호). 양방향 sync 모델(ADR-0003/0015) 자체는 *유지*(아웃라인은 같은 store/model 위의 새 뷰).

---

## 1. 문제와 목표

현재 에디터(`EditorShell`)는 `[210px 변수 | 1fr React Flow 캔버스 | 320px Inspector]` 3컬럼이다. 캔버스 노드 위치는 **자동 계산**(`CanvasView` `draggable:false`, 매 렌더 재계산)이라 노드-그래프의 유일한 인지 강점인 *공간 기억*을 못 살리고, 비용(팬/줌 조작·글자 축소·공간 낭비·문서화된 auto-fit race)만 남는다. 시나리오 모델은 본질적으로 **순서가 핵심인 정렬된 리스트 + 제한된 중첩**(loop `do` / if `then·elif·else` / parallel 레인, 1레벨)이라 그래프가 아니라 **아웃라인**이 맞다.

- **목표**: 캔버스를 **세로 인터랙티브 아웃라인**(중첩=들여쓰기, 그룹내 드래그 재정렬, 클릭 선택)으로 교체하고, 디테일 편집기를 **1fr로 확대**(320px→대폭)하며, 변수 패널을 **접이식**으로, YAML을 **모달**(양방향 유지)로 빼 편집 공간을 넓힌다. React Flow를 에디터에서 제거한다.
- **비목표(연기)**: §7 참조. **하단 흐름 다이어그램 + 테스트 결과 색상(슬라이스 2)**, **컨테이너 경계 넘는 드래그/re-parent(슬라이스 3)**, **YAML 가져오기/내보내기 file-I/O(fast-follow — share→paste는 R8 모달로 충족)**, **스텝 내부 필드 편집 UX 개선**, **디자인 시스템 전면 적용**.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST `EditorShell` 레이아웃을 `[변수(접이식) │ 흐름 아웃라인(상한폭 ~300px) │ 디테일 편집기(1fr)]`로 바꾸고, 디테일 편집기를 현 320px 고정에서 **1fr(가변·대폭 확대)**로 만든다. 두 에디터 페이지(`/scenarios/:id`·`/scenarios/new`)가 공유 `EditorShell` 경유로 자동 반영. | `EditorShell.test`: 디테일 영역이 고정 `320px`가 아닌 가변 컬럼임을 단언(grid 클래스 변경) + 두 페이지 마운트 green. | |
| R2 | MUST 변수 패널을 **접이식**으로 만든다(에디터 툴바 토글 버튼, 옵시디언식). 접으면 변수 패널이 DOM에서 빠지거나 폭 0이 되고 아웃라인·편집기가 넓어진다. 펼침/접힘 상태는 컴포넌트 로컬 state(영속화는 연기). | `EditorShell.test`: 토글 클릭 → `VariablesPanel`(또는 그 콘텐츠) 표시/숨김 단언. | |
| R3 | MUST 새 `FlowOutline` 컴포넌트가 스텝을 **세로 들여쓰기 트리**로 렌더해 `CanvasView`를 대체한다 — **전체 중첩**(loop `do` / if `then·elif·else` 밴드 / parallel 레인을 라벨 붙은 세로 그룹으로) 표시. http 행 = `[메서드 배지]·이름·해석된 URL(말줄임+title)·URL 누락 ⚠`; 컨테이너(loop/if/parallel) = 색 좌측테두리 + 헤더 카드 + 들여쓴 자식. | `FlowOutline.test`: loop+if+parallel 섞인 모델에서 모든 잎/컨테이너 행이 렌더되고 들여쓰기 깊이가 모델 깊이와 일치 + 메서드 배지·URL 말줄임 단언. | |
| R4 | MUST 아웃라인 행 클릭이 `select(stepId)`(기존 store 액션)로 선택을 세팅해 디테일 편집기를 구동하고, 선택 행은 accent 강조를 받는다. **행은 키보드 포커스 가능(`tabIndex`/role)이고 Enter·Space로 선택**(드래그 핸들은 별도 버튼). 빈 영역 클릭은 선택 해제(`select(null)` — 현 `CanvasView.onPaneClick` 패리티). | `FlowOutline.test`: 행 클릭 **및 Enter 키** 후 store `selectedStepId` 일치 + 선택 행 accent 클래스; 빈영역 클릭 후 `null`. | |
| R5 | MUST **같은 형제 그룹 내** 드래그 재정렬을 `dnd-kit` Sortable로 구현해 기존 `moveStep(stepId, toIndex)`를 호출한다. 드래그는 형제 그룹(최상위 / loop `do` / if 분기 / parallel 레인)에 **국한**(컨테이너 경계 넘기 = 슬라이스 3). | `FlowOutline.test`: 같은 그룹 내 재정렬 시뮬레이트(dnd-kit `onDragEnd` 핸들러 직접 호출)→`moveStep` 인자 단언; 그룹 밖 드롭은 no-op. | |
| R6 | MUST 접근성: 드래그에 **키보드 센서 + 스크린리더 안내**(dnd-kit 기본)를 켜고, 기존 Inspector **↑↓ 이동 버튼을 유지**(키보드/SR 비드래그 경로), 메서드 배지는 **색+텍스트**(색 단독 금지). | Inspector ↑↓ 버튼 기존 테스트 green 유지 + 배지에 메서드 텍스트 존재 단언 + dnd-kit `KeyboardSensor` 등록 코드 존재. | |
| R7 | MUST React Flow를 에디터에서 **제거**: `CanvasView`·`{Http,Loop,If,Parallel}StepNode`·`TabBar` + 각 테스트 삭제, `@xyflow/react` 의존성 제거, 레이아웃 수학(`measureStep`/`emitStep`/`measureWidth`) 삭제. **`test/setup.ts`의 `ResizeObserver` 폴리필은 유지**(recharts `ResponsiveContainer`가 `ReportView`/`RunDetailPage` 테스트에서 공동 의존 — `grep ResizeObserver ui/src`는 node_modules 소비처를 못 봐 0건이지만 제거하면 그 테스트가 red. 폴리필 주석을 "@xyflow + recharts ResponsiveContainer"로 갱신). | `grep -r "@xyflow/react" ui/src` → **0건** + `grep "xyflow" ui/package.json` → 0 + `pnpm build`·**`pnpm test`(ReportView/RunDetailPage 포함) green**. | |
| R8 | MUST YAML 편집을 툴바 `</> YAML` 버튼이 여는 **큰 모달**(기존 `Modal` 컴포넌트)로 옮겨 `MonacoYamlView`(양방향 Monaco)를 호스팅한다. 디바운스 커밋 sync(`pendingYamlText`/`commitPendingYaml`)는 **그대로 보존**하고, **모달 닫을 때 pending 편집을 flush-커밋**해 `model`/아웃라인이 최종 YAML을 반영(편집 유실 0). | `EditorShell.test`: 버튼 클릭→모달에 Monaco(또는 그 스텁) 렌더; 모달에서 YAML 변경→닫기→`model.steps`가 갱신됨(또는 `commitPendingYaml` 호출) 단언. **+ 라이브 왕복**(§6). | |
| ~~R9~~ | **이 슬라이스에서 제외 → §7 fast-follow로 연기.** YAML 가져오기/내보내기(file I/O). 핵심 *share→paste* 워크플로우는 **R8 모달(복사/붙여넣기)만으로 충족**되므로, 직교적 file-I/O 표면(`FileReader`·`showSaveFilePicker`·`picker.call(window,…)` 바운드 호출 함정)은 별 슬라이스로 분리해 본 슬라이스(캔버스→아웃라인 교체)를 타이트하게 둔다. ID는 결번 보존(재사용 금지). | (이 슬라이스 acceptance 없음 — §7) | |
| R10 | MUST 디테일 편집기 = 기존 `Inspector`를 **무변경 재사용**(폭만 확대). 스텝 *내부 필드*(헤더/바디/추출 등) 편집 UX 개선은 범위 밖. | `Inspector.tsx` diff = import 경로/래퍼 외 동작 무변경 + 기존 Inspector 테스트 전부 green. | |
| R11 | MUST (불변식) 모델/YAML/store 편집 의미론 **byte-identical**: `scenario/model.ts`·`yamlDoc.ts`(편집 apply)·엔진·proto·controller·migration **무변경**. `moveStep`은 **그대로 재사용**. 아웃라인은 같은 모델 위의 새 *뷰 + 드래그 어피던스*일 뿐. 머지 diff = `ui/`(+`docs/`·`package.json`·`pnpm-lock.yaml`)만. | 머지 diff에 `crates/`·`*.proto`·`*.sql` **0건** + `model.ts`/`yamlDoc.ts` 편집-apply 함수 무변경 grep. | |
| R12 | MUST (불변식) `TestRunSection`의 배치/동작 이번 슬라이스 **무변경**(하단 흐름 다이어그램 + 테스트 결과 색상 = **슬라이스 2 연기**). 두 페이지에서 에디터 아래 그대로 유지. | `ScenarioEditPage`/`ScenarioNewPage`에 `<TestRunSection>` 위치 무변경 + 기존 test-run 테스트 green. | |
| R13 | MUST 죽은 뷰-state 정리: store `activeTab`·`setActiveTab`·`Tab` 타입(`store.ts` INITIAL·인터페이스·`actions` shim line·`Tab` export 전부) + `TabBar` 제거. **남은 소비처 = `ValidationBanner`(`activeTab`을 *읽지 않고* `setActiveTab`을 *쓴다* 2곳): 게이트-액션 버튼 `setActiveTab("yaml")`(`:35`) → EditorShell이 내려주는 `onOpenYaml()` 콜백으로 YAML 모달 열기로 재배선; 스텝-문제 버튼 `setActiveTab("canvas")`(`:51`) → 호출 제거(아웃라인 상시 표시라 무의미, 스텝 선택만 유지).** `ValidationBanner.test.tsx`(`:35,41,57`)의 `activeTab` 단언도 재작성. | `grep -rn "\bactiveTab\b\|setActiveTab" ui/src` → 0 + 게이트-액션 클릭 시 `onOpenYaml` spy 호출 단언 + `pnpm build` green. | |
| R14 | MUST 신규 `@dnd-kit/*` 의존성은 **오프라인 번들**(CSP `default-src 'self'`·CDN 금지 — dnd-kit는 순수 JS라 충족)이고 `pnpm-lock.yaml`을 커밋한다. 최종 게이트 `pnpm lint`(`--max-warnings=0`)·`pnpm test`·`pnpm build` 전부 green. | `pnpm-lock.yaml`에 `@dnd-kit/*` 추가 + 3 게이트 green + CSP 메타(`index.html`) 무변경(외부 fetch 0). | |

- **`seam?` 전 행 비어 있음(계약 경계 없음).** 이 슬라이스는 UI Zod ↔ engine serde / proto / migration / CSV·XLSX 어느 경계도 건드리지 않는다 — R11이 그 무경계성(모델/와이어 byte-identical, 아웃라인=뷰)을 명문화한다. 그래서 최종 리뷰는 와이어 1:1 대조 부담이 없고, 라이브 검증은 **S-D 갭(서버 응답경로) 사유로는 불요**지만 **드래그/모달 인터랙션이 jsdom 미관측**이라 Playwright 권장(§6).

---

## 3. 핵심 통찰 (설계 근거)

1. **R3(아웃라인)이 4가지 불편을 한 표현으로 해소한다.** 노드-그래프의 강점은 *사용자가 배치한* 노드의 공간 기억인데, 이 에디터는 자동 레이아웃(`CanvasView` `draggable:false`)이라 그 강점이 0이고 비용(팬/줌·글자 축소·공간 낭비)만 남는다. 세로 리스트는 ① 행 전폭이라 글자 안 줄고 ② 세로 스크롤=자연스러움(팬 불요) ③ 드래그 재정렬=가장 보편적 리스트 상호작용(R5) ④ 캔버스 칸을 디테일 편집기에 반환(R1)한다. 중첩은 들여쓰기(파일 트리 관용구)로 1:1 표현되고, parallel 레인은 *동시성*을 헤더+레인 라벨로 전달(가로 컬럼 대신 세로 그룹) — 아웃라인에서 정직한 표현.
2. **R5는 신규 모델 변경 없이 가능하다.** `moveStep(stepId, toIndex)`(`store.ts:60`/`yamlDoc.ts:377`)가 이미 형제-그룹 내 재정렬을 한다 — 드래그 *어피던스*만 없었다. dnd-kit `SortableContext`를 형제 그룹마다 두고 `onDragEnd`에서 `moveStep`을 부르면 끝(R11 불변식 유지). 그룹내-only(R5)는 단일 컨텍스트 안 재정렬이라 dnd-kit의 가장 단순 케이스이자 forward-compatible(컨텍스트 간 = 슬라이스 3).
3. **R8 모달이 안전한 이유 — sync가 디바운스-라이브지 탭-스위치가 아니다.** `MonacoYamlView`는 `onChange`→`setPendingYamlText`+300ms 디바운스 `commitPendingYaml`로 산다(`store.ts`). 따라서 Monaco를 모달에 넣어도 **동작 동일**(같은 store 구독). 탭 전환 커밋 로직 자체가 없으므로 `activeTab` 제거(R13)가 sync를 안 깬다. 유일 신경 쓸 점 = 모달을 디바운스 윈도(<300ms) 중에 닫으면 마지막 편집이 미커밋 → **닫기 시 `commitPendingYaml` flush**(R8)로 봉쇄. 양방향·dirty-flag·baselineSeededRef 불변식은 store 레벨이라 그대로(R11).
4. **R7(RF 제거)은 순이득이다.** `@xyflow/react`(무거운 dep)·팬/줌·문서화된 auto-fit race·복잡한 `measureStep`/`emitStep`/`measureWidth` 수학이 전부 사라지고, 그 자리에 dnd-kit(작은 dep)이 들어와 **번들 순감소** 가능성. 노드 컴포넌트 4종은 `CanvasView`+자기 테스트만 import(grep 확인)라 삭제 안전, `summarizeCondition`은 이미 `model.ts`로 추출돼 의존 없음.
5. **R1+R2가 ④(편집 공간 협소)에 직접 답한다.** 320px Inspector→1fr + 변수 접기 = 헤더/바디 등 긴 텍스트 편집 폭 대폭 확보. 단 *내부 필드* UX는 의도적으로 연기(§7) — 이 슬라이스는 *구조*를 바로잡고, 폭이 넓어진 토대 위에서 다음 슬라이스가 필드 폴리시를 한다.
6. **신규 ADR 사유**: ADR-0003은 "GUI↔Code 양방향 sync"를 결정했지 GUI의 *표현*(캔버스 vs 아웃라인)을 고정하지 않았다. 표현을 노드-그래프에서 아웃라인으로 바꾸는 건 향후 슬라이스(다이어그램·re-parent)의 토대라 결정 기록이 맞다 — sync 모델은 유지하되 표현만 교체.

---

## 4. 변경 상세

> 각 묶음 머리에 **충족 R** 태그. 라인 참조는 작성 시점 기준(구현 시 재확인).

### 4.1 `ui/src/components/scenario/EditorShell.tsx` — 충족 R: R1, R2, R8, R12, R13
- 3컬럼 grid `grid-cols-[210px_1fr_320px]`(`:34`)를 `[변수(접이식) │ 아웃라인(예: `minmax(260px,300px)`) │ 디테일(`1fr`)]`로 교체. 변수 접힘 시 grid를 `[아웃라인 │ 1fr]`(또는 변수 col 0)로.
- 상단 **에디터 툴바**(신규, EditorShell 내부) 추가: `[☰ 변수]`(R2 토글)·`[</> YAML]`(R8 모달 오픈). (가져오기/내보내기 버튼은 R9 연기로 **이번엔 없음**.) 페이지 헤더의 저장/복제/실행기록/템플릿 버튼은 페이지 소유라 무변경.
- `TabBar`/`activeTab` 분기(`:40-43,47-52`) 제거 → 중앙 = 항상 `<FlowOutline/>`, 우측 = 항상 `<Inspector/>`. YAML은 `const [yamlOpen,setYamlOpen]` 로컬 state로 `<Modal open={yamlOpen}>` 안 `<MonacoYamlView/>`. 모달 `onClose` = `commitPendingYaml()` flush 후 `setYamlOpen(false)`(R8).
- `<ValidationBanner/>`에 **`onOpenYaml={() => setYamlOpen(true)}` prop 전달**(R13) — 게이트-액션 버튼이 더 이상 탭 전환이 아니라 YAML 모달을 연다(파싱 불가 YAML로 `model`이 stale일 때 유일한 "YAML 고치러 가기" 경로). `<VariablesPanel/>` 유지(접이식 래퍼 안). `<TestRunSection>`은 페이지 소유라 EditorShell 무관(R12).

### 4.2 `ui/src/components/scenario/FlowOutline.tsx` (신규) — 충족 R: R3, R4, R5, R6
- `CanvasView`를 대체하는 세로 트리. 재귀 렌더: 최상위 스텝 → 컨테이너면 헤더 카드 + 들여쓴 자식(loop `do` / if 밴드 then·elif[].then·else / parallel 레인). `flattenHttpSteps`가 아니라 **트리 구조 보존 렌더**(중첩 표시 R3).
- 행 컴포넌트: http = 드래그핸들 + 메서드 배지(색+텍스트, 데이터-식별 팔레트=accent 토큰과 별개) + 이름 + **raw `step.request.url`** 말줄임(`title` 풀 URL) + URL 누락 ⚠(`url.trim()===""`, 현 `emitStep` `urlMissing` 판정 이식). 컨테이너 = 색 좌측테두리 카드 + 헤더(⟳ loop ×N / ⎇ if `summarizeCondition` / ⇉ parallel). **URL은 raw 표시**(현 `CanvasView.tsx:273` `url: step.request.url`와 패리티) — `resolveForDisplay(template, env)`는 2-arg + 에디터엔 `${ENV}` 소스가 없어 부적합. (진단용 resolve는 RunDetail 전용.)
- 선택: 행 `onClick`(및 Enter/Space `onKeyDown`)→`select(id)`; 행은 `tabIndex={0}` + **`role="option"`(listbox 이디엄) 또는 tree-item 컨테이너 — `<button>` 금지**(드래그 핸들이 별도 `<button>`이라 button-in-button 안티패턴 회피, 리뷰 note); 선택 행 accent 링; 컨테이너/빈 영역 클릭 해제(R4). store `select`/`selectedStepId` 재사용. **셀렉터 fallback은 모듈 스코프 안정 `EMPTY_STEPS` 상수**(현 `CanvasView.tsx:45` 패턴 복사 — 인라인 `?? []` 금지, getSnapshot 경고/크래시 회피; `EditorShell.test` 첫 it가 핀).
- 드래그(R5/R6): 형제 그룹마다 `dnd-kit` `SortableContext`(`PointerSensor`+`KeyboardSensor`), `onDragEnd(active,over)`→같은 컨텍스트면 `moveStep(active.id, overIndex)`. 그룹 경계 넘는 드롭은 무시. 드래그 핸들은 행 클릭과 별개 버튼(`aria-label` ko 경유).
- 하단 추가 버튼(현 `CanvasView` `:129-186` 이식): `+HTTP`/`+loop`/`+if`/`+parallel`(loop 선택 시 `addStepInLoop` 컨텍스트 분기 유지) + 빈상태 메시지 + 컨테이너 캡션. 모든 라벨 `ko.editor.*` 기존 키 재사용.
- **`panelHint`(첫 스텝 추가 1회 안내, 현 `CanvasView.tsx:62-73,185`)는 드롭** — 넓어진 디테일 편집기(R1)가 선택 시 자명해 불필요. `ko.editor.panelHint` 키는 미사용으로 남겨둠(제거는 선택, 비차단).

### 4.3 React Flow 자산 삭제 — 충족 R: R7
- 삭제: `CanvasView.tsx`·`HttpStepNode.tsx`·`LoopStepNode.tsx`·`IfStepNode.tsx`·`ParallelStepNode.tsx`·`TabBar.tsx` + `__tests__/{CanvasView,HttpStepNode,TabBar}.test.tsx`(존재분).
- `ui/package.json`에서 `@xyflow/react` 제거. **`ui/src/test/setup.ts`의 `ResizeObserver` 폴리필은 유지**(recharts `ResponsiveContainer`가 `ReportView`/`RunDetailPage` 테스트에서 공동 의존 — `grep ResizeObserver ui/src`는 node_modules를 못 봐 0건이라 "다른 소비처 없음"은 거짓; 제거하면 그 테스트 red). 폴리필 주석을 "@xyflow + recharts ResponsiveContainer"로 갱신.
- `FlowOutline.test.tsx`(신규)가 캔버스 테스트의 커버리지(렌더·선택·추가)를 대체.

### 4.4 `ui/src/components/scenario/MonacoYamlView.tsx` — 충족 R: R8 (최소 변경)
- 컴포넌트 자체는 **거의 무변경**(모달 안에서 그대로 렌더). 필요한 경우 모달 높이에 맞춘 `h-full` 래퍼만. 디바운스 sync 로직 무변경(R3 통찰).

### 4.5 (연기) YAML 가져오기/내보내기 — ~~R9~~ → §7 fast-follow
- **이번 슬라이스에서 구현하지 않는다.** 핵심 *share→paste*는 R8 모달의 Monaco 복사/붙여넣기로 충족. file-I/O(`FileReader`·`showSaveFilePicker`·`picker.call` 바운드 호출 함정·blob revoke)는 직교적 표면이라 별 슬라이스로 분리(§7). 툴바에 가져오기/내보내기 버튼 없음.

### 4.6 `ui/src/scenario/store.ts` — 충족 R: R13
- 제거 surface 전수: `Tab` export(`:22`)·인터페이스 `activeTab`/`setActiveTab` 필드·`INITIAL.activeTab`(`:92`)·구현 `setActiveTab`·`actions` shim line `setActiveTab: s.setActiveTab`(`:369`). **`pendingYamlText`/`setPendingYamlText`/`commitPendingYaml`/`clearPendingYaml`는 sync 핵심이라 유지**(R8/§3.3). store 테스트의 `activeTab`/`setActiveTab` 참조 갱신.

### 4.7 `ui/src/components/scenario/ValidationBanner.tsx` — 충족 R: R13
- **실제 코드 사실(리뷰 정정)**: 이 컴포넌트는 `activeTab`을 *읽지 않는다*(표시 게이트는 `problems.length===0`, `:19`). `setActiveTab`을 *쓴다* — 게이트-액션 버튼 `setActiveTab("yaml")`(`:35`)·스텝-문제 버튼 `setActiveTab("canvas")`(`:51`).
- 신규 prop `onOpenYaml?: () => void` 추가. 게이트-액션 `onClick`을 `setActiveTab("yaml")`→`onOpenYaml?.()`로 교체(EditorShell이 모달 오픈 주입). 스텝-문제 버튼의 `setActiveTab("canvas")` 호출은 **제거**(아웃라인 상시 표시 — 스텝 선택만 유지). `setActiveTab` import 제거.
- `ValidationBanner.test.tsx`(`:35,41,57`)의 `activeTab`/`setActiveTab` 단언을 `onOpenYaml` spy 단언으로 재작성.

### 4.8 `ui/src/i18n/ko.ts` — 충족 R: R2, R8, R6, R13
- 신규 키(전부 `ko.editor.*` 또는 적절 네임스페이스): 변수 토글 라벨/aria, YAML 모달 버튼/제목, 드래그 핸들 aria-label, 아웃라인 행/선택 관련 aria(메서드 배지 텍스트는 메서드명 그대로라 무관). (가져오기/내보내기 라벨은 R9 연기라 **추가 안 함**.)
- `tabCanvas`/`tabYaml`(TabBar 전용)·`yamlTabNoInspector`(구 YAML-탭 Inspector 빈 안내) 제거.
- **죽은 UI 참조 문구 정정(ADR-0035)**: `problemGateAction`(`:425`)="YAML 탭에서 확인" → 탭 없어짐, "YAML 열어 확인"류로; `problemGateIntro`(`:424`)의 "…**캔버스**가 마지막 정상 상태로 표시될 수 있습니다" → "캔버스" 없어짐, "아웃라인/에디터"로. 두 값 모두 새 구조에 맞춰 갱신(키 자체는 유지).

---

## 5. 무변경 / 불변식 (명시)

- **엔진·proto·controller·migration·CSV/XLSX export 무변경** — 머지 diff에 `crates/`·`*.proto`·`*.sql` 0건(R11).
- **`scenario/model.ts`·`yamlDoc.ts` 편집-apply 6종·`store.ts` 편집 액션 무변경** — 아웃라인은 같은 모델 위 뷰, `moveStep` 등 기존 액션 재사용(R11). (단 `store.ts`의 `activeTab` *뷰-state*만 제거 — 모델 무관, R13.)
- **양방향 sync·dirty-flag·`baselineSeededRef`·`pendingYamlText` 디바운스 커밋 byte-identical** — Monaco가 탭에서 모달로 위치만 이동(R8).
- **`Inspector`(디테일) 동작 무변경** — 폭만 확대(R10).
- **`TestRunSection`·`useTestRun`·`POST /api/test-runs`·`ScenarioTrace` 무변경** — 하단 다이어그램/색상은 슬라이스 2(R12).
- **CSP 메타(`index.html`) 무변경** — dnd-kit는 외부 fetch 0(R14).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | `EditorShell.test`: 디테일 컬럼 가변(`1fr`)·320px 고정 부재; 두 페이지 마운트 green | |
| R2 | `EditorShell.test`: 변수 토글 → 패널 표시/숨김 | |
| R3 | `FlowOutline.test`: loop+if+parallel 모델 전 행 렌더·들여쓰기 깊이·메서드 배지·URL 말줄임 | |
| R4 | `FlowOutline.test`: 행 클릭→`selectedStepId`; 빈영역→`null`; 선택 accent | |
| R5 | `FlowOutline.test`: `onDragEnd` 직접 호출→`moveStep` 인자; 그룹밖 no-op | ✅(Playwright 실 드래그) |
| R6 | Inspector ↑↓ 기존 테스트 green; `KeyboardSensor` 등록; 배지 텍스트 존재 | |
| R7 | `grep "@xyflow/react" ui/src`=0·`grep xyflow ui/package.json`=0·`pnpm build` | |
| R8 | `EditorShell.test`: YAML 버튼→모달 렌더; 모달 편집→닫기→`model.steps` 갱신/`commitPendingYaml` 호출 | ✅(Playwright 왕복) |
| ~~R9~~ | 연기(§7) — 이 슬라이스 검증 없음 | |
| R10 | `Inspector` 동작 diff 없음 + 기존 Inspector 테스트 green | |
| R11 | 머지 diff `crates/`·proto·sql 0; `model.ts`/`yamlDoc.ts` apply 무변경 grep | |
| R12 | 두 페이지 `<TestRunSection>` 위치 무변경 + test-run 테스트 green | |
| R13 | `grep activeTab ui/src`=0; ValidationBanner 정상; `pnpm build` | |
| R14 | `pnpm-lock.yaml`에 `@dnd-kit/*`; `pnpm lint`+`test`+`build` green | |

- **라이브 검증(권장, S-D-필수는 아님)**: 이 슬라이스는 run-생성/리포트-파싱/엔진 경로 **무관**(R11)이라 S-D 갭 사유의 "필수"는 아니다. 그러나 **드래그 재정렬(R5)·YAML 모달 왕복(R8)·변수 접기(R2)**는 jsdom이 픽셀/포커스를 미관측하므로 머지 전 `/live-verify`+Playwright로 ① 그룹내 드래그가 순서를 바꾸고 YAML에 반영 ② YAML 모달 열기→편집→닫기→아웃라인 갱신 ③ 변수 접기→편집기 확대 를 실측한다. (Playwright 운전법 = `docs/dev/live-verify-playwright.md`.)

---

## 7. 의도적 연기 (roadmap §B/에디터 트랙에 누적)

- **하단 흐름 다이어그램 + 테스트 결과 색상(녹색 ✓/빨강 ✗/중립 ○) + 칩 클릭 선택** → **슬라이스 2**. 가로 flex-wrap 칩(줄바꿈, React Flow 아님), `POST /api/test-runs` 트레이스의 스텝별 결과를 색+아이콘으로(색맹 a11y). 별 슬라이스 사유: 테스트 통합 + 새 표현이라 독립 검증 단위.
- **YAML 가져오기/내보내기(file I/O) (~~R9~~)** → **fast-follow(슬라이스 1.5 또는 2에 흡수)**. 핵심 share→paste는 R8 모달로 충족되고, file-I/O는 직교적 footgun 표면(`FileReader`·`showSaveFilePicker`·`picker.call(window,…)` 바운드 호출·blob revoke 타이밍)이라 캔버스→아웃라인 교체와 분리해 본 슬라이스를 타이트하게 유지(spec-plan-reviewer 권고 + 사용자 "크면 나눠라" 위임). 사용자 요청 기능이므로 빠른 후속.
- **`panelHint`(첫 스텝 추가 1회 안내) 드롭** → 넓어진 디테일 편집기가 선택 시 자명. `ko.editor.panelHint` 키는 미사용으로 잔존(다음 정리에서 제거 가능).
- **컨테이너 경계 넘는 드래그 / re-parent** → **슬라이스 3**. 새 store 액션(다른 부모로 이동)·재부모 엣지케이스 다수. dnd-kit 다중 컨텍스트라 R5 토대 위 확장.
- **스텝 내부 필드(헤더/바디/추출) 편집 UX 개선** → 별도. 이 슬라이스는 *구조*만; 넓어진 폭 위에서 다음에.
- **디자인 시스템 전면 적용** → 별도. 새 셸은 accent 토큰을 자연 사용하되 프리미티브 전수 적용은 비목표.
- **변수 접힘 상태 영속화(localStorage)** → 사소·연기. 이번엔 컴포넌트 로컬 state.

---

## 8. 구현 순서 (plan 입력)

> UI-only 슬라이스라 cargo 게이트 무관(빠른 UI 게이트 `pnpm lint && test && build`). tdd-guard 회피 위해 **각 task 테스트 파일 먼저**(ui/CLAUDE.md 함정). green-fold 지점 명시.

1. **deps + ko 키**: `@dnd-kit/*` 추가(`pnpm-lock` 커밋, R14), `ko.ts` 신규 키 + 죽은 키 정리(`tabCanvas`/`tabYaml`/`yamlTabNoInspector` 제거·`problemGateAction`/`problemGateIntro` 정정, R13). (R9 연기로 `exportYaml.ts` 헬퍼 없음.)
2. **`FlowOutline` (드래그 없이 정적)**: 트리 렌더·선택(클릭+키보드)·추가 버튼·raw URL/배지·안정 `EMPTY_STEPS`(R3/R4) + 테스트(test-path 먼저). 이 시점 `CanvasView`와 공존 가능하나, EditorShell 배선(3)에서 교체.
3. **EditorShell 재배선 + RF 삭제(green-fold)**: grid 교체·툴바(`☰`/`</> YAML`)·변수 접기·YAML 모달(flush-on-close)·`FlowOutline` 마운트·`TabBar`/`activeTab` 전수 제거·`ValidationBanner` `onOpenYaml` 재배선(R1/R2/R8/R13) + 테스트. R7 삭제(CanvasView/노드4/TabBar + 테스트·`@xyflow/react` dep·ResizeObserver 폴리필은 유지)를 **같은 커밋**에(삭제와 대체가 한 커밋이어야 빌드 green).
4. **드래그(R5/R6)**: `FlowOutline`에 dnd-kit `SortableContext`(형제 그룹별)·`PointerSensor`+`KeyboardSensor`·`onDragEnd`→`moveStep` 배선 + 테스트. Inspector ↑↓는 무변경 유지.
5. **전체 게이트 + 라이브**: `pnpm lint && test && build`(R14, ReportView/RunDetail 포함 전체) + `/live-verify`+Playwright 왕복(드래그·YAML 모달·변수 접기, §6).

<!-- REVIEW-GATE: 미승인 — spec-plan-reviewer 통과 후 plan에만 마커를 단다(이 spec 파일이 아니라). -->

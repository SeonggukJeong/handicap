# 에디터 아웃라인 경계 넘는 드래그 / re-parent (에디터 구조 재설계 슬라이스 3/3)

- **날짜**: 2026-07-02 (개정 r2 — spec-plan-reviewer round 1 반영)
- **출처**: roadmap §B13 슬라이스 3 — 사용자 최종 목표(2026-06-28 "최종적으로 컨테이너 경계 넘어 재배치하고 싶음"). ADR-0044 후속.
- **사용자 결정(2026-07-02 brainstorming)**: ① 드래그 범위 = **전부**(http + loop/if 컨테이너, 합법성 규칙 내; parallel은 모델상 최상위-only라 최상위 재정렬만 유지) ② 접근 = **A(기존 구조 확장)로 진행하되, 사용성 문제가 있으면 B(flat-tree) 승격 검토**(→ R10 밸브).
- **접근 비교(요약)**: A-extend = 충돌 후보를 "자기 형제 그룹"에서 "합법 드롭 위치 전체"로 확장 + 새 re-parent store 액션. B flat-tree = 단일 SortableContext + X-오프셋 projection 재작성 — **기각(연기)**: projection의 "깊이→부모" 추론이 다중-밴드 컨테이너(if의 then/elif×N/else, parallel 레인)에서 깨져 밴드-인지 로직을 다시 얹어야 하므로 교과서 패턴의 이점이 소멸. 밴드가 이미 1급 구조(per-band `SortableContext`, `FlowOutline.tsx:232-239`)인 현 설계에선 A가 자연스럽다. drag-fixes spec(2026-06-29 §2)의 "B가 슬라이스 3의 자연스러운 토대" 평가는 다중-밴드 문제를 셈하지 않은 것.

## 1. 문제와 목표

슬라이스 1(ADR-0044)의 아웃라인 드래그는 **같은 형제 그룹 내 재정렬만** 지원한다 — 충돌 콜백(`FlowOutline.tsx:356-377`)이 후보를 `findStepSiblings(steps, activeId)`로 제한하고(`nearestByHeader` `:313-329`는 그 후보 안의 근접 판정), `resolveDragEnd`(`ui/src/scenario/reorder.ts:20-29`)는 같은 형제 목록 밖 `over`를 no-op 처리하며, store엔 같은 부모 내 splice인 `moveStep(stepId, toIndex)`(`store.ts:57`, `yamlDoc.ts:377-388`)뿐이다. 이 슬라이스는 **컨테이너 경계를 넘는 이동(re-parent)** 을 추가한다: loop 밖 스텝을 loop 안으로, if 분기 사이, 컨테이너째 최상위↔분기 등 — 모델 합법성 규칙 안에서 자유 재배치.

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST 경계 넘는 드래그 대상 = **전 스텝 유형**: http leaf, loop/if 컨테이너(서브트리째). parallel 스텝 자체는 모델상 최상위-only이므로 **최상위 재정렬만**(기존과 동일). 기존 같은-그룹 내 재정렬 동작·애니메이션은 **불변**(회귀 0) — 특히 **컨테이너 헤더 근처 드롭 = 컨테이너-레벨 재정렬**이라는 현행 시맨틱 유지(R4①). | 기존 `ui/src/scenario/__tests__/reorder.test.ts` 재정렬 케이스 전부 green + `FlowOutline.test` 기존 렌더/선택 테스트 green + 신규 cross-group 테스트; 라이브 §6에서 같은-그룹 재정렬 회귀 확인. | |
| R2 | MUST 드롭 합법성은 **순수 모듈**(신규 `ui/src/scenario/dropRules.ts` — pure 로직은 `ui/src/scenario/` 관례·react-refresh footgun 회피)로 판정: `legalTargets(steps, activeId): Set<BandKey>` + `findParentBand(steps, id): {parentId: string \| null, band: string}`(자체 재귀 트래버설 — `model.ts` 타입가드만 import, `findStepSiblings`는 부모 밴드 정체를 못 준다) + `hasNestedContainer(step)`. **목적지 규칙**: 최상위 = 전 유형; *최상위* loop의 `do` = http + *전-http-분기* if; *최상위* if의 분기(then/elif[j].then/else) = http + *전-http-body* loop; **중첩 컨테이너의 밴드 = http만**(깊이 2 상한, `model.ts` `LoopBodyStep`/`IfBranchStep`과 1:1); parallel 레인 = http만; parallel 스텝은 어떤 밴드로도 진입 금지. **소스 규칙**: 자기 서브트리 안으로 금지(사이클); `min(1)` 밴드(loop `do`·if/elif `then`·parallel 레인, `model.ts:139-210`)의 **마지막 자식은 경계 밖 이동 금지**(빈 밴드가 Zod 파싱을 깨므로 — `else`(`default([])`)·최상위 소스는 예외). | `dropRules.test`: 목적지×소스 매트릭스 단위테스트(§5 엣지케이스 전수 — 합법/불법 각각 단언) + `findParentBand` 케이스(최상위/do/then/elif_j/else/branch_i). | |
| R3 | MUST 충돌 감지 확장: dragStart에 `legalTargets`를 1회 계산하고, **포인터 드래그**의 후보 = **합법 밴드의 행**(자기 형제 그룹 포함) + **빈 `else` placeholder**(빈 밴드가 가능한 유일한 밴드 — 나머지는 전부 min(1)·비어 있을 수 없어 행 기반 삽입으로 충분). 불법 밴드의 행은 후보에서 제외되어 `over`가 절대 잡히지 않는다(불법 드롭 = 구조적 no-op, 에러 UI 불요). placeholder는 **net-new `useDroppable`**(현 코드베이스는 `useSortable`만 사용 — 신규 표면임을 명시). **키보드(포인터 좌표 없음) 경로는 기존 분기(`FlowOutline.tsx:362-364`)대로 자기 형제 그룹 후보로 제한**(키보드 re-parent는 비목표 §7 — 절반-동작 방지; placeholder 같은 비-스텝 id는 기존 `siblingIds` 필터가 자연 배제). `nearestByHeader` 근접 판정 유지. | `FlowOutline.test`: onDragEnd에 불법 조합 주입 → store 액션 미호출; 키보드 경로 same-group 유지 단언. 라이브 §6 불법 드롭 no-op 실측. | |
| R4 | MUST 드롭 해석(`over` → 타깃): ① **행 위**(컨테이너 헤더 행 포함) = 포인터 Y가 행/헤더-띠 중심 위/아래 → 그 행의 **형제 레벨에서 앞/뒤** 인덱스 — 컨테이너 헤더 드롭은 오늘처럼 **컨테이너-레벨 재정렬**이며 밴드 진입이 아니다(밴드 진입 = 밴드 *안의 행* 또는 placeholder 경유만 — 헤더/밴드 라벨은 드롭 타깃 승격 안 함, R1 회귀-0과 상충 제거) ② **빈 `else` placeholder**(드래그 중·합법일 때만 렌더) = 그 밴드 index 0 ③ 해석 결과가 **같은 부모·같은 밴드**면 기존 `moveStep` 경로로 위임(동작·인덱스 의미 불변). **pointer-half 소싱**: `DragEndEvent`엔 포인터 좌표가 없으므로, 충돌 콜백(이미 `pointerCoordinates` 수신, `FlowOutline.tsx:361`)이 최신 (overId, above/below) 판정을 ref에 기록하고 `handleDragEnd`가 그 ref를 읽는다. | 신규 해석 순수함수 단위테스트: (overId, half) → `{kind:"move"} \| {kind:"reparent", target} \| null`; 헤더 드롭 = 재정렬(밴드 진입 아님) 단언; 같은-밴드 강하 케이스는 moveStep 위임 단언. | |
| R5 | MUST 드래그 중 시각 피드백: 삽입 예정 위치에 **accent 인디케이터**(대상 행 상/하단 라인·placeholder 하이라이트) + 현재 over 중인 대상 밴드 배경 하이라이트. 기존 메커니즘(DragOverlay 서브트리 프리뷰·소스 wrapper `opacity-0`·`nearestByHeader`) 유지. 색은 선택 링과 동일 accent 도메인. (교차-컨텍스트에선 sortable shift 애니메이션이 없으므로 이 인디케이터가 유일한 위치 신호.) | `FlowOutline.test`: over 상태 주입 시 인디케이터 클래스 단언(가능 범위); 라이브 §6 held-drag로 mid-drag 인디케이터/placeholder 실측. | |
| R6 | MUST store 신규 edit `reparentStep(stepId, target: {parentId: string \| null, band: string, index: number})`(`parentId null` = 최상위; `band` 키 ↔ 경로 매핑 **명시**: `"do"`→`do`, `"then"`→`then`, `"elif_0"`…→`elif[j].then`, `"else"`→`else`, `"branch_0"`…→`branches[i].steps` — 기존 `addStepInParallelBranch(parallelId, branchIndex, …)`와 정합) — `yamlDoc.ts` `applyEdit` 신규 variant가 소스 seq에서 YAML 노드를 **verbatim** splice-out 후 타깃 seq에 splice-in. Loop↔NestedLoop·If↔NestedIf는 **Zod 티어 차이일 뿐 YAML 동형**이라 노드 이동만으로 재파싱이 성립(합법성 게이트 R2가 보장). **트랜잭셔널 적용 필수**: 현행 dispatch는 doc을 in-place 변이 후 재파싱 실패 시 `yamlError`만 set하고 변이를 되돌리지 않으므로(`store.ts:302-308`) reparent variant는 **Document clone에 적용→재파싱 성공 시에만 커밋**(re-parent는 불법 상태를 만들 수 있는 첫 edit — in-place 변이는 상태 오염). | `yamlDoc.test`: 대표 re-parent 케이스별 라운드트립(YAML 텍스트 스냅샷 — 노드 내용 불변·위치만 이동) + 재파싱 성공; **불법 입력 시 doc 무변이(트랜잭션) 단언**. | 모델↔YAML 경계(기존 계약 내) |
| R7 | MUST 신규 사용자 노출 문구(빈-밴드 placeholder 라벨 등 — aria 포함)는 전부 `ko.ts` 경유(ADR-0035). | grep: 신규/변경 파일 하드코딩 문구 0 + `ko.editor.*` 신규 키. | |
| R8 | MUST (불변식) 엔진·controller·proto·migration **무변경**(diff에 `crates/`·`*.proto`·`*.sql` 0건); `schemas.ts`·`model.ts` **무변경**(dropRules는 기존 타입가드·타입 import만); `store.ts`/`yamlDoc.ts`는 **신규 액션/variant 추가만**(기존 액션·`moveStep` 시맨틱 무변경); 시나리오 YAML 와이어 포맷 byte-identical(이동된 노드 내용 불변). | 머지 diff 경로 검사 + 기존 store/yamlDoc/reorder/FlowOutline 테스트 전부 green. | seam 없음(에디터 내부) |
| R9 | MUST 게이트: `pnpm lint`(`--max-warnings=0`)·`pnpm test`(전체)·`pnpm build` green + 머지 전 **라이브 Playwright held-drag 실측**(§6) — 하드 단언에 **"경계를 넘는 held-drag 중 드래그 취소/dead-zone 미발생"** 포함(§3-6 최상위 리스크의 직접 검증 — 이 기능은 drag-fixes가 교차-컨텍스트 취소 제거용으로 도입한 그룹-스코프 제한을 의도적으로 되돌린다). 그 외: mid-drag 인디케이터·placeholder·경계 이동 후 YAML 모달 구조 확인·불법 드롭 no-op·같은-그룹 재정렬 회귀. | 3 게이트 green + §6 체크리스트 수행 기록(취소-미발생 단언 필수). | |
| R10 | SHOULD **B-승격 밸브**(사용자 결정 2026-07-02): 라이브 검증/도그푸딩에서 A 구조로 해소 불가능한 사용성 문제(드롭 타깃 예측 불가·상습 오배치·**교차-컨텍스트 취소 재발**)가 드러나면 이 슬라이스를 멈추고 B(flat-tree) 승격을 사용자에게 제안한다(drag-fixes spec §6.3과 동일 패턴). 임의 확대 금지 — 밸브 발동도 사용자 확인 후. | (프로세스 조항 — 코드 acceptance 없음) | |

## 3. 핵심 통찰 (설계 근거)

1. **불법 드롭의 최선 UX = "후보에서 제외"**: dnd-kit에서 불법 대상을 후보로 두고 드롭 시 거부하면 인디케이터가 떴다가 무시되는 기만적 UX가 된다. 후보 산출 단계에서 제외하면 `over`가 아예 잡히지 않아 "붙지 않는" 자연스러운 피드백이 되고 에러 UI가 불필요하다.
2. **합법성은 "타입 규칙 + 드래그 서브트리 내용"의 곱**: loop→if-분기는 타입상 합법이지만 그 loop가 NestedIf를 품고 있으면 3단 중첩이라 불법. 목적지 밴드의 수용 타입만으론 판정 불가 — `hasNestedContainer(dragged)`를 함께 봐야 한다. 이것이 roadmap이 말한 "재부모 엣지케이스 다수"의 본체다.
3. **min(1) 제약이 소스 규칙을 강제**: `model.ts:139-210`의 `.min(1)`(loop do·if/elif then·parallel 레인) 때문에 "마지막 자식 빼내기"는 재파싱을 깨는 편집이다. 허용하려면 컨테이너 자동삭제나 Zod 완화가 필요한데 둘 다 스코프 크리프 — 금지(경계 밖 타깃을 후보 없음으로)로 확정. 빈 밴드가 가능한 곳은 `else`(`default([])`)와 최상위뿐 — placeholder도 `else` 전용.
4. **YAML 노드는 verbatim 이동으로 충분**: Loop/NestedLoop·If/NestedIf는 같은 YAML 키 집합(Zod 티어만 다름)이라 re-parent = AST seq 간 노드 이동. `findStepPath`/`searchSeq`(`yamlDoc.ts:466-507`)가 이미 전 컨테이너 형태를 재귀 탐색하고, `addStepInLoop`/`addStepInBranch`/`addStepInParallelBranch`가 타깃 seq 해석을 조각조각 보유 — 신규 variant는 이들의 조합이다. 단 **적용은 트랜잭셔널**(R6 — clone→재파싱 성공 시 커밋): 현행 in-place 변이 + `yamlError` set 경로는 롤백이 아니다.
5. **키보드는 이번에 안 넓힌다**: sortable 키보드 이동은 컨텍스트 내 인덱스 기반이라 경계 넘기가 절반-동작(포커스/인덱스 불일치)하기 쉽다. 후보 확장을 포인터 경로에 한정해 기존 키보드 동작을 보존하고, 키보드 re-parent는 후속(§7)으로.
6. **최상위 리스크 = 교차-컨텍스트 취소의 의도적 재도입**: 그룹-스코프 충돌 제한은 drag-fixes(#3)가 **교차-컨텍스트 취소·dead-zone 제거용으로** 넣은 완화책이고(`FlowOutline.tsx:350-351` 주석), 이 슬라이스의 핵심 메커니즘은 그 제한을 합법 범위에서 되돌리는 것이다 — 같은 버그 부류가 재발할 수 있는 구조로 되돌아간다. 대응: 단일 `DndContext` + `MeasuringStrategy.Always`(`:400,:403`)는 유지된 채 후보만 넓히므로 droppable 등록 자체는 이미 전역이고(전 행이 등록됨 — 현 코드는 필터로 배제할 뿐), 취소 재발 여부를 **R9 하드 단언**으로 직접 실측하며, 재발이 A 구조로 못 잡히면 **R10 밸브**로 B 승격을 제안한다.

## 4. 변경 상세

### 4.1 `ui/src/scenario/dropRules.ts` (신규) — 충족 R: R2
`legalTargets(steps, activeId): Set<BandKey>`(BandKey = `"top"` 또는 `` `${parentId}:${band}` `` 직렬화) + `findParentBand(steps, id)` + `hasNestedContainer(step)`. **자체 재귀 트래버설**(밴드 열거 + 부모 밴드 정체 — 기존 헬퍼가 못 주는 정보) — `model.ts`의 타입가드(`isLoopStep`/`isIfStep`/`isParallelStep`)·타입만 import(모델 무변경). 순수 함수, `ui/src/scenario/` 배치(pure 로직 관례·react-refresh footgun 회피).

### 4.2 `ui/src/components/scenario/FlowOutline.tsx` — 충족 R: R1, R3, R4, R5
- `useSortable` 행에 `data: {parentId, band, index}` 부여(현재 id-only, `:170`) + 빈 `else` 밴드 placeholder를 `useDroppable`로 등록(드래그 중·합법 시만).
- 충돌 콜백(`:356-377`): 포인터 경로 후보를 `legalTargets` 기반으로 확장, (overId, above/below) 판정을 ref에 기록(R4 pointer-half 소싱). 키보드 경로(`:362-364`) 기존 형제-그룹 유지.
- `handleDragEnd`(`:382-391`): 해석 결과가 같은 밴드면 `moveStep`, 다르면 `reparentStep` 디스패치.
- 드래그 중 인디케이터/밴드 하이라이트 렌더(over+half ref 기반).

### 4.3 `ui/src/scenario/reorder.ts` 확장(또는 형제 모듈 `reparent.ts` — 같은 디렉토리) — 충족 R: R4
순수 해석: `(steps, activeId, over{id,data}, half) → {kind:"move", toIndex} | {kind:"reparent", target} | null`. 기존 `resolveDragEnd`/`computeReorder` 시맨틱 보존(기존 함수 시그니처 무변경).

### 4.4 `ui/src/scenario/store.ts` + `ui/src/scenario/yamlDoc.ts` — 충족 R: R6, R8
`reparentStep` 액션 + `applyEdit` variant(트랜잭셔널: Document clone→splice-out→splice-in→재파싱 성공 시 커밋; 같은 seq 강하 케이스는 moveStep 위임). 기존 액션 무변경.

### 4.5 `ui/src/i18n/ko.ts` — 충족 R: R7
빈-밴드 placeholder 라벨 등 신규 키.

## 5. 엣지케이스 (R2 매트릭스에 전수 포함)

| # | 케이스 | 판정 |
|---|---|---|
| 1 | http → 아무 합법 밴드(loop do·if 분기·parallel 레인·최상위) | 합법 |
| 2 | 전-http loop → *최상위* if 분기 / 전-http if → *최상위* loop do | 합법(티어 전환 — YAML 동형) |
| 3 | NestedIf 품은 loop → if 분기 (3단) | 불법 |
| 4 | NestedLoop 품은 if → loop do (3단) | 불법 |
| 5 | loop/if → *중첩* 컨테이너의 밴드(예: if-분기 안 NestedLoop의 do) | 불법(중첩 밴드 = http만) |
| 6 | loop/if/parallel → parallel 레인 | 불법(레인 = http만) |
| 7 | parallel → 어떤 밴드든 | 불법(최상위-only, 최상위 재정렬만) |
| 8 | 컨테이너 → 자기 서브트리 밴드(loop을 자기 do로) | 불법(사이클) |
| 9 | `min(1)` 밴드의 마지막 자식 → 경계 밖 | 불법(소스 규칙) — 단 `else`/최상위 소스는 합법 |
| 10 | NestedIf/NestedLoop → 최상위 | 합법(티어 승격 — http-only body는 상위 티어의 부분집합) |
| 11 | 같은 밴드 내 드롭 | `moveStep` 위임(기존 동작 byte-identical) |
| 12 | 빈 `else` 밴드로 드롭(placeholder — `else`가 유일한 빈-가능 밴드) | 합법(index 0) |
| 13 | 컨테이너 헤더 행 위/아래 드롭 | 컨테이너-레벨 재정렬(밴드 진입 아님 — R4①, 현행 시맨틱 유지) |

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R2 | `dropRules.test` — §5 매트릭스 전수 + `findParentBand` 단위테스트 | |
| R3 | `FlowOutline.test` 불법 조합 no-op + 키보드 same-group | ✅(불법 드롭 "안 붙음" 실측) |
| R4 | 해석 순수함수 단위테스트(상/하반·헤더=재정렬·placeholder·위임) | |
| R5 | 클래스 단언(가능 범위) | ✅(held-drag mid-drag 인디케이터·placeholder 실측) |
| R6 | `yamlDoc.test` 라운드트립 스냅샷 + 불법 입력 무변이(트랜잭션) | ✅(이동 후 YAML 모달 구조 확인) |
| R1/R9 | 기존 reorder/FlowOutline 테스트 green + 전체 게이트 | ✅(같은-그룹 재정렬 회귀·loop 밖→안·분기 간·컨테이너째 이동·**경계 held-drag 취소 미발생 하드 단언**) |

라이브 절차: vite dev 또는 dist 서빙으로 에디터만(test-run 불요) + Playwright `browser_run_code_unsafe` held-drag(`page.mouse.down→move→관측→up`, ui/CLAUDE.md editor-drag-fixes 함정 절차) — vite dev는 IPv6 `[::1]` 바인드 함정 주의(`localhost`로 navigate).

## 7. 비목표 (연기)

- **B flat-tree 재작성** — R10 밸브 발동 시에만 사용자 제안.
- **키보드 re-parent** — 기존 키보드 같은-그룹 재정렬 유지, 확장은 후속(Inspector "이동" 메뉴가 대안 경로 후보).
- **multi-select 드래그**, **Inspector 이동 메뉴**, **parallel 중첩 완화**(ADR-0033 재론), **드래그 중 자동 스크롤 튜닝**(dnd-kit 기본값).
- **빈 min(1) 밴드를 만드는 이동 허용**(컨테이너 자동삭제·Zod 완화) — §3-3.
- `panelHint` 미사용 ko 키 제거(roadmap §B13 잔여) — 별도 정리 슬라이스.
- 모델·엔진·와이어 변경 일체(R8 불변식).

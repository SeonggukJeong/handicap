# 에디터 아웃라인 경계 넘는 드래그 / re-parent (에디터 구조 재설계 슬라이스 3/3)

- **날짜**: 2026-07-02
- **출처**: roadmap §B13 슬라이스 3 — 사용자 최종 목표(2026-06-28 "최종적으로 컨테이너 경계 넘어 재배치하고 싶음"). ADR-0044 후속.
- **사용자 결정(2026-07-02 brainstorming)**: ① 드래그 범위 = **전부**(http + loop/if 컨테이너, 합법성 규칙 내; parallel은 모델상 최상위-only라 최상위 재정렬만 유지) ② 접근 = **A(기존 구조 확장)로 진행하되, 사용성 문제가 있으면 B(flat-tree) 승격 검토**(→ R10 밸브).
- **접근 비교(요약)**: A-extend = 충돌 후보를 "자기 형제 그룹"에서 "합법 드롭 위치 전체"로 확장 + 새 re-parent store 액션. B flat-tree = 단일 SortableContext + X-오프셋 projection 재작성 — **기각(연기)**: projection의 "깊이→부모" 추론이 다중-밴드 컨테이너(if의 then/elif×N/else, parallel 레인)에서 깨져 밴드-인지 로직을 다시 얹어야 하므로 교과서 패턴의 이점이 소멸. 밴드가 이미 1급 구조(per-band `SortableContext`, `FlowOutline.tsx:230-239`)인 현 설계에선 밴드 = 명시 드롭존인 A가 자연스럽다. drag-fixes spec(2026-06-29 §2)의 "B가 슬라이스 3의 자연스러운 토대" 평가는 다중-밴드 문제를 셈하지 않은 것.

## 1. 문제와 목표

슬라이스 1(ADR-0044)의 아웃라인 드래그는 **같은 형제 그룹 내 재정렬만** 지원한다 — 충돌 감지(`nearestByHeader`, `FlowOutline.tsx:313-329`)가 후보를 `findStepSiblings(steps, activeId)`로 제한하고(`:356-377`), `resolveDragEnd`(`reorder.ts:20-29`)는 같은 형제 목록 밖 `over`를 no-op 처리하며, store엔 같은 부모 내 splice인 `moveStep(stepId, toIndex)`(`store.ts:57`, `yamlDoc.ts:377-388`)뿐이다. 이 슬라이스는 **컨테이너 경계를 넘는 이동(re-parent)** 을 추가한다: loop 밖 스텝을 loop 안으로, if 분기 사이, 컨테이너째 최상위↔분기 등 — 모델 합법성 규칙 안에서 자유 재배치.

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST 경계 넘는 드래그 대상 = **전 스텝 유형**: http leaf, loop/if 컨테이너(서브트리째). parallel 스텝 자체는 모델상 최상위-only이므로 **최상위 재정렬만**(기존과 동일). 기존 같은-그룹 내 재정렬 동작·애니메이션은 **불변**(회귀 0). | `FlowOutline.test` 기존 재정렬 테스트 전부 green + 신규 cross-group 테스트; 라이브 §6에서 같은-그룹 재정렬 회귀 확인. | |
| R2 | MUST 드롭 합법성은 **순수 모듈**(신규 `ui/src/components/scenario/dropRules.ts`)의 `legalTargets(steps, activeId)`(및 내부 술어)로 판정 — **목적지 규칙**: 최상위 = 전 유형; *최상위* loop의 `do` = http + *전-http-분기* if; *최상위* if의 분기(then/elif[j].then/else) = http + *전-http-body* loop; **중첩 컨테이너의 밴드 = http만**(깊이 2 상한, `model.ts` `LoopBodyStep`/`IfBranchStep`/`NestedLoopStepModel`/`NestedIfStepModel`과 1:1); parallel 레인 = http만; parallel 스텝은 어떤 밴드로도 진입 금지. **소스 규칙**: 자기 서브트리 안으로 금지(사이클); `min(1)` 밴드(loop `do`·if/elif `then`·parallel 레인, `model.ts:139-210`)의 **마지막 자식은 경계 밖 이동 금지**(빈 밴드가 Zod 파싱을 깨므로 — `else`(`default([])`)·최상위 소스는 예외). | `dropRules.test`: 목적지×소스 매트릭스 단위테스트(§5 엣지케이스 전수 — 합법/불법 각각 단언). | |
| R3 | MUST 충돌 감지 확장: dragStart에 `legalTargets`를 1회 계산하고, 포인터 드래그의 후보 = **합법 밴드의 행 + 합법 빈-밴드 placeholder**(자기 형제 그룹 포함) — 불법 밴드의 행은 후보에서 제외되어 `over`가 절대 잡히지 않는다(불법 드롭 = 구조적 no-op, 별도 에러 UI 불요). **키보드(포인터 좌표 없음) 경로는 기존대로 자기 형제 그룹 후보로 제한**(키보드 re-parent는 비목표 §7 — 절반-동작 방지). `nearestByHeader`의 헤더-띠/행-중심 근접 판정 자체는 유지. | `FlowOutline.test`: onDragEnd에 불법 조합 주입 → store 액션 미호출; 키보드 경로 same-group 유지 단언. 라이브 §6 불법 드롭 no-op 실측. | |
| R4 | MUST 드롭 해석(`over` → 타깃): ① 행 위 = 포인터 Y가 행 중심 위/아래 → 그 행 **앞/뒤** 인덱스 ② 컨테이너 **헤더** 또는 밴드 라벨 위 = 그 밴드(헤더면 첫 밴드) **끝에 append** ③ **빈 밴드 placeholder**(빈 `else` 등 — 드래그 중·합법일 때만 렌더되는 droppable) = index 0. 결과 타깃이 **같은 부모·같은 밴드**면 기존 `moveStep` 경로로 위임(동작·인덱스 의미 불변). | `reorder.test`(또는 신규 `reparent.test`): (overId, 상/하반) → `{parentId, band, index}` 순수 해석 단위테스트; 같은-밴드 강하 케이스는 moveStep 위임 단언. | |
| R5 | MUST 드래그 중 시각 피드백: 삽입 예정 위치에 **accent 인디케이터**(대상 행 상/하단 라인 또는 빈-밴드 placeholder 하이라이트) + 현재 over 중인 대상 밴드 배경 하이라이트. 기존 메커니즘(DragOverlay 서브트리 프리뷰·소스 wrapper `opacity-0`·`nearestByHeader`) 유지. 색은 선택 링과 동일 accent 도메인. | `FlowOutline.test`: over 상태 주입 시 인디케이터 클래스 단언(가능 범위); 라이브 §6 held-drag로 mid-drag 인디케이터/placeholder 실측. | |
| R6 | MUST store 신규 edit `reparentStep(stepId, target: {parentId: string \| null, band: string, index: number})`(`parentId null` = 최상위; `band` = `"do"`/`"then"`/`"elif_0"`…/`"else"`/`"branch_0"`…(parallel 분기 **인덱스** — 기존 `addStepInParallelBranch(parallelId, branchIndex, …)`와 정합)) — `yamlDoc.ts` `applyEdit` 신규 variant가 소스 seq에서 YAML 노드를 **verbatim** splice-out 후 타깃 seq에 splice-in(주석·포맷 보존은 기존 yaml Document API 수준). Loop↔NestedLoop·If↔NestedIf는 **Zod 티어 차이일 뿐 YAML 동형**이라 노드 이동만으로 재파싱이 성립(합법성 게이트 R2가 보장); 편집 후 재파싱 실패 시 edit 거부(버그 가드, 기존 applyEdit 에러 경로 재사용). | `yamlDoc.test`: 대표 re-parent 케이스별 라운드트립(YAML 텍스트 스냅샷 — 노드 내용 불변·위치만 이동) + 재파싱 성공; 불법 입력 방어 케이스. | 모델↔YAML 경계(기존 계약 내) |
| R7 | MUST 신규 사용자 노출 문구(빈-밴드 placeholder 라벨 등 — aria 포함)는 전부 `ko.ts` 경유(ADR-0035). | grep: 신규/변경 파일 하드코딩 문구 0 + `ko.editor.*` 신규 키. | |
| R8 | MUST (불변식) 엔진·controller·proto·migration **무변경**(diff에 `crates/`·`*.proto`·`*.sql` 0건); `schemas.ts`·`model.ts` **무변경**(합법성 모듈은 기존 타입가드·타입 import만); `store.ts`/`yamlDoc.ts`는 **신규 액션/variant 추가만**(기존 액션·`moveStep` 시맨틱 무변경); 시나리오 YAML 와이어 포맷 byte-identical(이동된 노드 내용 불변). | 머지 diff 경로 검사 + 기존 store/yamlDoc/FlowOutline 테스트 전부 green. | seam 없음(에디터 내부) |
| R9 | MUST 게이트: `pnpm lint`(`--max-warnings=0`)·`pnpm test`(전체)·`pnpm build` green + 머지 전 **라이브 Playwright held-drag 실측**(§6) — 드롭 후 DOM만으론 부족(ui/CLAUDE.md editor-drag-fixes 함정): mid-drag 인디케이터·placeholder·경계 이동 후 YAML 모달로 구조 확인·불법 드롭 no-op·같은-그룹 재정렬 회귀. | 3 게이트 green + §6 체크리스트 수행 기록. | |
| R10 | SHOULD **B-승격 밸브**(사용자 결정 2026-07-02): 라이브 검증/도그푸딩에서 A 구조로 해소 불가능한 사용성 문제(드롭 타깃 예측 불가·상습 오배치)가 드러나면 이 슬라이스를 멈추고 B(flat-tree) 승격을 사용자에게 제안한다(drag-fixes spec §6.3과 동일 패턴). 임의 확대 금지 — 밸브 발동도 사용자 확인 후. | (프로세스 조항 — 코드 acceptance 없음) | |

## 3. 핵심 통찰 (설계 근거)

1. **불법 드롭의 최선 UX = "후보에서 제외"**: dnd-kit에서 불법 대상을 후보로 두고 드롭 시 거부하면 인디케이터가 떴다가 무시되는 기만적 UX가 된다. 후보 산출 단계에서 제외하면 `over`가 아예 잡히지 않아 "붙지 않는" 자연스러운 피드백이 되고 에러 UI가 불필요하다.
2. **합법성은 "타입 규칙 + 드래그 서브트리 내용"의 곱**: loop→if-분기는 타입상 합법이지만 그 loop가 NestedIf를 품고 있으면 3단 중첩이라 불법. 목적지 밴드의 수용 타입만으론 판정 불가 — `hasNestedContainer(dragged)`(서브트리에 컨테이너 자식 존재 여부)를 함께 봐야 한다. 이것이 roadmap이 말한 "재부모 엣지케이스 다수"의 본체다.
3. **min(1) 제약이 소스 규칙을 강제**: `model.ts:139-210`의 `.min(1)`(loop do·if/elif then·parallel 레인) 때문에 "마지막 자식 빼내기"는 재파싱을 깨는 편집이다. 허용하려면 컨테이너 자동삭제나 Zod 완화가 필요한데 둘 다 스코프 크리프 — 금지(드래그 자체를 후보 없음으로)로 확정(2026-07-02 실측·brainstorming 기록).
4. **YAML 노드는 verbatim 이동으로 충분**: Loop/NestedLoop·If/NestedIf는 같은 YAML 키 집합(Zod 티어만 다름)이라 re-parent = AST seq 간 노드 이동. `findStepPath`/`searchSeq`(`yamlDoc.ts:466-507`)가 이미 전 컨테이너 형태를 재귀 탐색하고, `addStepInLoop`/`addStepInBranch`/`addStepInParallelBranch`가 타깃 seq 해석을 조각조각 보유 — 신규 variant는 이들의 조합이다.
5. **키보드는 이번에 안 넓힌다**: sortable 키보드 이동은 컨텍스트 내 인덱스 기반이라 경계 넘기가 절반-동작(포커스/인덱스 불일치)하기 쉽다. 후보 확장을 포인터 경로에 한정해 기존 키보드 동작을 보존하고, 키보드 re-parent는 후속(§7)으로.

## 4. 변경 상세

### 4.1 `ui/src/components/scenario/dropRules.ts` (신규) — 충족 R: R2
`legalTargets(steps, activeId): Set<BandKey>` + `hasNestedContainer(step)` + 밴드 컨텍스트 타입(`{parentId: string | null, band: string}` 직렬화 키). 순수 함수 — `model.ts` 타입가드(`isLoopStep`/`isIfStep`/`isParallelStep`)와 `findStepById`/`findStepSiblings`만 import.

### 4.2 `ui/src/components/scenario/FlowOutline.tsx` — 충족 R: R1, R3, R4, R5
- `useSortable` 행에 `data: {parentId, band, index}` 부여(현재 id-only, `:170`) + 밴드 라벨/헤더·빈-밴드 placeholder를 droppable로 등록.
- 충돌 함수(`:356-377`): 포인터 경로 후보를 `legalTargets` 기반으로 확장(키보드 경로는 기존 형제-그룹 유지). `nearestByHeader` 근접 판정 유지.
- `handleDragEnd`(`:382-391`): 해석 결과가 같은 밴드면 `moveStep`, 다르면 `reparentStep` 디스패치.
- 드래그 중 인디케이터/밴드 하이라이트 렌더(over 상태 기반).

### 4.3 `ui/src/components/scenario/reorder.ts`(또는 신규 `reparent.ts`) — 충족 R: R4
순수 해석: `(steps, activeId, over{id,data}, pointerHalf) → {kind:"move", toIndex} | {kind:"reparent", target} | null`. 기존 `resolveDragEnd`/`computeReorder` 시맨틱 보존.

### 4.4 `ui/src/scenario/store.ts` + `ui/src/scenario/yamlDoc.ts` — 충족 R: R6, R8
`reparentStep` 액션 + `applyEdit` variant(splice-out→splice-in, 같은 seq 강하 케이스는 인덱스 보정 또는 moveStep 위임). 기존 액션 무변경.

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
| 12 | 빈 `else` 밴드로 드롭 | 합법(placeholder, index 0) |

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R2 | `dropRules.test` — §5 매트릭스 전수 단위테스트 | |
| R3 | `FlowOutline.test` 불법 조합 no-op + 키보드 same-group | ✅(불법 드롭 "안 붙음" 실측) |
| R4 | 해석 순수함수 단위테스트(상/하반·헤더 append·placeholder·위임) | |
| R5 | 클래스 단언(가능 범위) | ✅(held-drag mid-drag 인디케이터·placeholder 실측) |
| R6 | `yamlDoc.test` 라운드트립 스냅샷 | ✅(이동 후 YAML 모달 구조 확인) |
| R1/R9 | 기존 테스트 green + 전체 게이트 | ✅(같은-그룹 재정렬 회귀·loop 밖→안·분기 간·컨테이너째 이동 시나리오) |

라이브 절차: `/live-verify` 스택(단, 이 슬라이스는 test-run 불요 — vite dev 또는 dist 서빙으로 에디터만) + Playwright `browser_run_code_unsafe` held-drag(`page.mouse.down→move→관측→up`, ui/CLAUDE.md editor-drag-fixes 함정 절차) — vite dev는 IPv6 `[::1]` 바인드 함정 주의(`localhost`로 navigate).

## 7. 비목표 (연기)

- **B flat-tree 재작성** — R10 밸브 발동 시에만 사용자 제안.
- **키보드 re-parent** — 기존 키보드 같은-그룹 재정렬 유지, 확장은 후속(Inspector "이동" 메뉴가 대안 경로 후보).
- **multi-select 드래그**, **Inspector 이동 메뉴**, **parallel 중첩 완화**(ADR-0033 재론), **드래그 중 자동 스크롤 튜닝**(dnd-kit 기본값).
- `panelHint` 미사용 ko 키 제거(roadmap §B13 잔여) — 별도 정리 슬라이스.
- 모델·엔진·와이어 변경 일체(R8 불변식).

# 에디터 드래그 메커니즘 수리 (slice B) — 설계

- 날짜: 2026-06-29
- 영역: 에디터 구조 재설계 (B13) · ADR-0044 후속
- 트랙: editor-flow-outline-redesign 슬라이스 1 + 레이아웃 후속 슬라이스 A(editor-modal-layout-fixes) **다음**
- 범위: **UI-only** (백엔드 0-diff) · 모델/wire/store **byte-identical**

## 1. 문제 (dogfooding 발견)

ADR-0044 아웃라인 재설계(`FlowOutline`, dnd-kit 그룹내 드래그) 직후 도그푸딩에서 드래그 두 버그가 드러났다.

- **#3 (CRITICAL) — 컨테이너를 지날 때 드래그가 취소된다.** 단일 HTTP 스텝끼리는 드래그 재정렬이 잘 되지만, 단일 HTTP 스텝(또는 핸들로 직접 잡은 컨테이너)이 LOOP/IF/PARALLEL 같은 **컨테이너 위를 잠깐만 지나가도 잡고 있던 드래그가 풀려버린다**. 간헐적("어쩔 때는 됨").
- **#4 — 드래그 *중* 컨테이너의 하위 스텝이 따라오지 않는다.** 컨테이너를 끌면 헤더만 움직이고 자식들은 제자리에 남는다. **드롭 *후*에는** 자식들이 정상적으로 같이 따라와 안착한다(즉 `moveStep` 이동 로직은 정상 — 드래그 *프리뷰*만 결함).

### 1.1 근본 원인 분석 (코드 기준)

현 `ui/src/components/scenario/FlowOutline.tsx`:

- 단일 `<DndContext sensors onDragEnd>` 안에 **그룹마다 중첩 `SortableContext`**(최상위 steps / loop `do` / if 밴드 then·elif[].then·else / parallel 분기). 각 `OutlineRow`가 `useSortable({id: step.id})`를 호출하고, **transform을 행 div에 직접** 적용한다(`CSS.Transform.toString(transform)`).
- **`DragOverlay` 없음.** 드래그 중인 행 자체가 transform으로 움직인다.
- 컨테이너 행은 **헤더 div에만** `setNodeRef`/transform이 붙고, 자식들은 같은 외곽 `<div>`의 *형제* DOM(들여쓴 밴드)으로 렌더된다 — sortable transform 밖.

이로부터:

- **#4 직접 설명**: 컨테이너 드래그 시 transform이 헤더 div에만 걸려 헤더만 움직이고, 자식 밴드는 transform을 안 받아 제자리. 드롭 시 `moveStep`이 모델을 재정렬해 전체가 새 위치로 재렌더되며 자식이 "안착".
- **#3 근본 원인(도그푸딩 2026-06-29로 첨예화 — 교차-컨텍스트 드래그-오버)**: 취소는 드래그 중인 (최상위) 아이템이 **중첩 `SortableContext`에 속한 자식**(컨테이너 *내부* 스텝) 위를 지날 때 발생한다. *같은* 컨텍스트의 형제(최상위↔최상위) 위를 지날 땐 멀쩡하다. **위/아래 비대칭이 증거**: 컨테이너 *위*의 최상위 HTTP 스텝은 위로 올리기 쉽지만(가로막는 게 최상위 형제뿐=같은 컨텍스트), *아래*로 내리려면 컨테이너의 자식들(중첩 컨텍스트)을 가로질러야 해 취소된다. 추정 메커니즘: 각 `useSortable`은 *자기* 컨텍스트의 `activeIndex`/`overIndex`로 transform을 계산하는데, `over`가 중첩 자식이 되면 (a) 최상위(active) 컨텍스트는 `overIndex`를 자기 목록 밖으로 해석하고 (b) 중첩 컨텍스트는 자기에 없는 active로 시프트를 시도 → 소스에 잘못된 transform/리플로우가 걸려 포인터 상호작용이 취소로 깨진다. 간헐성은 측정/시프트 레이스와 부합.

**중요**: #4의 수정(오버레이가 서브트리 렌더)은 *확정적*이다. #3은 위 근본 원인을 **그룹-스코프 충돌 감지 + 소스 transform 제로화**(§3.1)로 직격하되, 정확한 취소 트리거(pointercancel/unmount)는 *경험적 재현으로 확인*하고(§6.1), 그래도 남으면 B로 에스컬레이션한다(§7).

## 2. 접근 (Approach A — 검토 후 채택)

검토한 대안:

- **A (채택)**: `DragOverlay` + 안정 충돌/측정 설정, **중첩 `SortableContext` 구조와 그룹내-전용 의미론 유지**. 두 버그를 같은 변경으로 잡고, re-parenting 없음, 모델/wire byte-identical. 최소 변경.
- **B (기각·연기)**: flat-tree 단일 `SortableContext` + projection 전면 재작성. 가장 견고하고 슬라이스 3 re-parenting의 자연스러운 토대지만, 이번 슬라이스 목표(메커니즘 수리)를 크게 초과하고 re-parenting(ADR-0044 슬라이스 3)을 앞당긴다. **A의 overlay/collision 작업은 추후 B로 갈 때 그대로 재사용**되므로 A는 버려지는 작업이 아니다.
- **C (기각)**: 오버레이 없이 충돌/측정만 손봄. **#4를 못 고친다**(자식이 드래그 중 따라오려면 오버레이가 서브트리를 렌더해야 함).

### 2.1 결정: re-parenting 연기 유지

이 슬라이스는 **드래그 메커니즘 수리만** 한다. 그룹 경계를 넘어 *컨테이너 안으로 드롭*(re-parenting)은 ADR-0044대로 **슬라이스 3으로 계속 연기**한다. `resolveDragEnd`의 그룹내-전용·경계=no-op 의미론은 불변.

## 3. 설계

대상 파일: `ui/src/components/scenario/FlowOutline.tsx`(주), 테스트 `ui/src/components/scenario/__tests__/FlowOutline.test.tsx`.

### 3.1 `DndContext` 설정 추가

`@dnd-kit/core@6.3.1`에서 다음을 import해 `<DndContext>`에 추가한다(나머지 props·트리 구조 불변):

- **그룹-스코프 충돌 감지 (#3 직격)** — 기본 `rectIntersection`도, 평범한 `closestCenter`도 `over`가 *중첩 자식*이 되는 것을 막지 못한다. 대신 **active의 형제 그룹으로 후보를 좁힌** 커스텀 `collisionDetection`을 쓴다: `findStepSiblings(steps, activeId)`(model.ts, reorder.ts와 동일)로 active의 그룹을 구해 그 id들만 `droppableContainers`에 남기고 `closestCenter`를 적용. 효과 — `over`가 **절대 중첩 컨테이너 자식이 되지 않아** (a) 중첩 컨텍스트가 시프트하지 않고(active/over 둘 다 자기 목록 밖=transform null) (b) 소스 컨텍스트의 `overIndex`가 항상 유효해 소스 transform이 정상 → 교차-컨텍스트 취소·dead-zone이 구조적으로 사라진다. **그룹내-전용 `resolveDragEnd` 의미론과 정확히 일치**(시각 충돌 = 드롭 가능 위치). re-parenting을 허용하지 않으므로 안전.
- `measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}` — 중첩 컨테이너 레이아웃 시프트로 droppable rect가 stale되는 것을 방지(드래그 중 항상 재측정).
- **소스 transform 제로화 (DragOverlay 표준)** — 드래그 중 소스 행의 `transform`을 `isDragging ? undefined : CSS.Transform.toString(transform)`로 둔다. 시각은 오버레이가 담당하므로 소스는 제자리(gap)에 두고 자체 transform을 적용하지 않아, 잘못된 transform이 포인터를 흔드는 경로를 차단.
- `onDragStart`/`onDragCancel` 핸들러 추가(기존 `onDragEnd` 유지). 드래그 식별자를 `activeId` state로 추적: start에서 set, end/cancel에서 null.

### 3.2 `DragOverlay`로 서브트리 프리뷰 (#4)

`<DndContext>` 안(트리 마크업 옆)에 `<DragOverlay>`를 둔다. `activeId`가 있으면 해당 스텝을 `findStepById(steps, activeId)`(`model.ts`, 기존 헬퍼)로 resolve해 그 스텝의 **전체 서브트리를 비대화형 프리뷰**로 렌더한다.

- **소스 *서브트리* 숨김 (컨테이너 정확성 — 리뷰 F1)**: 드래그 중인 스텝은 mount는 유지하되 시각적으로 숨긴다(`useSortable`의 `isDragging`으로 `opacity-0`/`invisible`). **숨김은 `OutlineRow`가 반환하는 *최외곽 요소*에 적용한다** — leaf는 행 div 자체이지만, **컨테이너는 `isDragging`/`setNodeRef`가 헤더 div에만 걸리고 자식 밴드는 *형제* DOM**이라(`FlowOutline.tsx` loop `:105`/if `:132`/parallel `:165`), 헤더만 숨기면 자식 밴드가 원위치에 그대로 남아 **오버레이의 자식과 이중 표시**된다. 따라서 컨테이너 행은 헤더가 아니라 **헤더+밴드를 감싼 외곽 wrapper `<div>`**에 hide 클래스를 적용해 서브트리 전체를 숨긴다. dnd-kit가 소스 노드를 계속 측정해야 하므로 DOM 제거가 아니라 *숨기기만* 한다 → 오버레이만 커서를 따라 보인다.
- **프리뷰 = 서브트리**: 컨테이너면 오버레이가 헤더 + 모든 자식 밴드를 재귀로 렌더 → 드래그 중 자식이 함께 따라온다(#4 해결).

### 3.3 프리젠테이션 조각 추출 (시각 드리프트 방지)

오버레이 프리뷰는 `useSortable`을 호출하면 안 된다(같은 id 이중 등록 → 충돌). 따라서:

- 한 행의 **헤더 비주얼**(드래그 핸들 글리프·`ContainerTag`/메서드 배지·이름·repeat/조건/URL·⚠ 누락 배지)을 **공유 프리젠테이션 컴포넌트**로 추출한다(현재 `OutlineRow`의 헤더 JSX와 byte-identical한 클래스).
- 대화형 `OutlineRow`(sortable): 기존대로 `useSortable` 배선(+ `setActivatorNodeRef`를 드래그 핸들에 추가) + 공유 헤더 조각 + **중첩 `SortableContext` 자식**(불변).
- 오버레이용 `OutlineRowPreview`(신규, 비대화형): 공유 헤더 조각 + **재귀 `OutlineRowPreview` 자식**(`useSortable`/`SortableContext`/`onClick`/listeners 없음). 컨테이너 밴드 스캐폴딩(들여쓰기·`border-l-2`·밴드 라벨)은 동일 클래스로 재현. 오버레이 root는 `aria-hidden="true"`(소스 행이 이미 `role="option"`/aria를 가지므로 SR 이중 구술 방지).
- **프리뷰는 선택 accent를 표시하지 않는다 (리뷰 F3)**: 행 accent 테두리/ring은 store `selectedStepId`에 의존한다(`FlowOutline.tsx:50-51`). 프리뷰는 **store 미접촉**(§5)이므로 선택 여부와 무관하게 **항상 비선택 중립 테두리**(`border-slate-200`)로 렌더한다. accent를 보이려고 store를 읽지 말 것(불변식 위반). 공유 헤더 조각(핸들/배지/이름/URL/⚠)은 store 불필요라 영향 없음.

밴드 구조(loop `do` / if then·elif·else / parallel 분기) 재현은 헤더 조각을 공유해 비주얼 드리프트를 막고, 자식 렌더 방식(sortable vs preview)만 두 컴포넌트가 각자 담당한다.

### 3.4 드래그-핸들 activator (보강)

현 핸들 `<button>`은 `{...attributes} {...listeners}`만 스프레드한다. `setActivatorNodeRef`를 핸들에 추가해 dnd-kit가 activator rect를 정확히 계산하게 한다(#3 보강, byte-identical 시각).

### 3.5 의미론·데이터 불변 (byte-identical)

- `resolveDragEnd`(`reorder.ts`)·`computeReorder`·`moveStep` **무변경** — 그룹내 재정렬만, 경계=no-op.
- 모델/YAML wire/Zustand store **0-diff**. 시나리오 직렬화 무영향.
- 백엔드(controller/worker/engine/proto) **0-diff**.
- `ko.ts` 무변경 — 오버레이는 `aria-hidden` 장식이라 신규 사용자노출 문구 없음.

## 4. 비목표 (Non-goals)

- re-parenting(경계 넘어 컨테이너 안으로 드롭) — 슬라이스 3.
- flat-tree 재작성(Approach B).
- 인스펙터/YAML sync/모델/추가-스텝 버튼/`reorder.ts` 의미론 변경.
- 키보드 센서 동작 변경(기존 `KeyboardSensor` + `sortableKeyboardCoordinates` 유지 — Playwright 미발화는 검증 한계일 뿐 프로덕션 키보드 a11y는 유지).

## 5. 컴포넌트 경계 (격리·테스트 가능성)

- `OutlineRow`(sortable 래퍼): dnd-kit 배선 + 헤더 조각 + 중첩 sortable 자식. 입력 = `step`/`depth`. 의존 = `useSortable`, store(`select`).
- `OutlineRowPreview`(프리뷰): 순수 함수형, 입력 = `step`/`depth`. 부작용/훅 없음(store·dnd 미접촉, 선택 accent 미표시 — §3.3 F3) → 단위로 "서브트리 렌더" 검증 가능.
- 공유 헤더 조각: 순수 프리젠테이션. 입력 = `step`(+ 선택자). 단위로 비주얼 락인.
- `FlowOutline`: `DndContext`/`DragOverlay`/센서/`activeId` state 소유. `onDragEnd` → `resolveDragEnd` → `moveStep`(불변).

## 6. 검증 (DOM-존재만으론 PASS 금지 — [[implementation-rigor-over-spec]])

### 6.1 재현 우선 (systematic-debugging)

구현은 **수정 전 #3을 먼저 재현**한다(`/scenarios/new`, 컨테이너 1개 + 최상위 HTTP 스텝 구성 후 HTTP를 컨테이너 위로 드래그 → 취소 관찰). `onDragCancel` 계측(임시 로그/카운터)으로 취소 발화를 확인하고, 수정 후 같은 시퀀스에서 취소가 사라짐을 대조한다.

### 6.2 단위 테스트 (`FlowOutline.test.tsx`, jsdom)

- 기존 `resolveDragEnd` 6케이스(flat/null/cross-group/nested-loop/parallel same-branch/parallel cross-branch)는 **`ui/src/scenario/__tests__/reorder.test.ts`**에 있다(`FlowOutline.test.tsx` 아님 — 리뷰 F4; 후자엔 렌더/선택 테스트 + `computeReorder` 핀 1개뿐). 의미론 불변이라 **그대로 green** 락인.
- 신규: `OutlineRowPreview`가 컨테이너의 **자식까지 재귀 렌더**함을 단언(예: 자식 HTTP 스텝 이름이 프리뷰 DOM에 존재) + 선택된 스텝의 프리뷰여도 **accent 클래스 부재**(F3) 단언.
- 신규: 드래그 메커니즘 자체(취소/포인터)는 **jsdom 단위 불가** — 이 한계를 테스트 주석에 명시하고 Playwright(§6.3)로 위임.
- jsdom 폴리필: `FlowOutline` 풀 마운트는 기존 `ResizeObserver` 폴리필(`test/setup.ts`)로 충분(현 테스트가 이미 마운트).

### 6.3 Playwright 포인터드래그 (필수 acceptance)

KeyboardSensor는 Playwright 자동화에서 미발화(문서화된 함정)라 **포인터 드래그만 유효**. 단 `browser_drag`은 press-move-release **원자적**이라 드래그 *중* 상태(오버레이·소스 숨김)를 못 본다 → **held 드래그**가 필요한 검증은 `browser_run_code_unsafe`로 `page.mouse.down()` → `page.mouse.move()`(중간 지점들) → 스크린샷/`getBoundingClientRect` 관측 → `page.mouse.up()` 시퀀스로 수행한다(리뷰 F5). `/scenarios/new`(클라이언트-only, 백엔드 불필요)에서 추가버튼으로 시나리오 구성(Monaco 프로그램 setValue 불가 함정 회피):

- **#3 (취소 제거 + 실재 재정렬)**: 최상위 HTTP 스텝을 LOOP/IF/PARALLEL 컨테이너를 *지나* 최상위 다른 위치로 드롭 → **취소 없이** + **순서가 실제로 바뀜**을 둘 다 단언(드롭 후 아웃라인/YAML 모달 순서 비교). **no-op 드롭을 "고쳐짐"으로 오인 금지**(리뷰 F6) — `over`가 컨테이너의 *중첩 자식*으로 잡히면 `computeReorder`가 null을 반환해 재정렬이 안 되므로, "취소 안 남"만으론 부족하고 *최상위 순서가 바뀐 것*까지 확인. 간헐성 커버 위해 **수회 반복**. 컨테이너를 핸들로 직접 잡아 다른 컨테이너를 지나는 케이스도.
- **#3 회귀 가드**: 그룹-스코프 커스텀 충돌이 기존 재정렬을 깨지 않는지 확인 — ① 최상위 **HTTP↔HTTP** 두 leaf swap + ② **그룹내 중첩 재정렬**(loop `do` 안 스텝끼리, parallel 한 분기 안 스텝끼리)이 모두 여전히 동작.
- **#4-a (오버레이가 서브트리)**: held 드래그로 컨테이너를 잡은 채 `DragOverlay` 포털 안에 **헤더 + 자식 행**이 함께 존재함을 실측(`getBoundingClientRect`).
- **#4-b (소스 숨김 — 리뷰 F2)**: 같은 held 드래그 시점에 **원위치 소스 서브트리가 시각적으로 숨겨짐**을 단언 — 포털 밖에서 그 자식 이름이 보이는 사본이 1개를 넘지 않거나, 원 밴드의 computed `opacity`/`visibility`가 hidden. (F1의 이중-밴드 아티팩트를 잡는 결정적 단언.)
- 콘솔 Zod/React 에러 0.

### 6.4 게이트

`pnpm lint && pnpm test && pnpm build` GREEN(루트 UI 게이트). lint는 `--max-warnings=0`.

## 7. Fallback (A로 #3이 안 죽으면)

§6.3 Playwright 실측에서 컨테이너를 지날 때 취소가 **여전히 재현되면**, A(중첩+overlay)로는 #3을 못 잡는 것이므로 이 슬라이스를 멈추고 **B(flat-tree) 승격**을 사용자에게 제안한다 — 이때 A에서 만든 `DragOverlay`/프리뷰 컴포넌트/충돌·측정 설정은 B로 그대로 재사용한다. (확률은 낮음 — dnd-kit는 멀티-컨텍스트 + 오버레이를 공식 지원하나, 간헐성 때문에 0은 아니라 명시적 분기로 둔다.)

## 8. 위험 / 함정

- **오버레이 클론 id 충돌**: 프리뷰는 절대 `useSortable` 호출 금지(이중 등록). 별도 비대화형 컴포넌트로.
- **시각 드리프트**: 헤더 조각을 공유하지 않으면 오버레이와 실제 행이 어긋난다 → 공유 프리젠테이션 조각 필수.
- **소스 행 unmount 금지**: 드래그 중 소스는 *숨김*만(opacity/visibility), DOM 제거 금지(dnd-kit 측정 필요).
- **컨테이너 소스 숨김은 헤더가 아닌 외곽 wrapper에 (리뷰 F1)**: 헤더 div에만 hide를 걸면 형제 자식 밴드가 원위치에 남아 오버레이와 이중 표시된다 → 헤더+밴드 감싼 최외곽 요소에 hide(§3.2).
- **그룹-스코프 충돌 회귀**: 커스텀 충돌이 HTTP↔HTTP 및 *그룹내 중첩 재정렬*(loop 안 스텝끼리 등)을 깨지 않는지 §6.3에서 같이 확인. `findStepSiblings`는 read-only(모델 무변경).
- **`measuring: Always` 비용**: 드래그 중 연속 재측정 — 아웃라인 크기(수십 행)에선 무시 가능. 문제 시 `WhileDragging` + `frequency` 조정으로 후퇴.

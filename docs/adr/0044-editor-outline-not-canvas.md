# 0044. 에디터 1차 표현 — 팬 가능한 노드-그래프 캔버스(React Flow) → 세로 인터랙티브 아웃라인

- 상태: 채택됨 (2026-06-29)
- 관련: [ADR-0003](0003-ux-bidirectional-sync.md)(GUI↔Code 양방향 sync — *유지*), [ADR-0015](0015-bidirectional-sync-impl.md)(Zustand+Zod+YAML AST round-trip — *유지*), [ADR-0020](0020-control-flow-loop.md)/[ADR-0023](0023-conditional-node.md)(loop/if 1레벨 중첩 — 아웃라인이 들여쓰기로 표현), [ADR-0035](0035-korean-copy.md)(UI 한국어 `ko.ts`), [ADR-0043](0043-ui-design-system.md)(accent 토큰 — 아웃라인 선택 강조에 사용). 설계: `docs/superpowers/specs/2026-06-28-editor-flow-outline-redesign-design.md`(§3 근거·R-표), 계획: `docs/superpowers/plans/2026-06-28-editor-flow-outline-redesign.md`. 주요 파일: `ui/src/components/scenario/FlowOutline.tsx`(신규)·`EditorShell.tsx`·`ui/src/scenario/reorder.ts`(신규).

## 맥락

MVP 에디터(`EditorShell`)는 시나리오를 **팬 가능한 노드-그래프 캔버스**(`@xyflow/react`/React Flow, `CanvasView`+`{Http,Loop,If,Parallel}StepNode`)로 표현하고, 레이아웃은 `[210px 변수 │ 1fr 캔버스 │ 320px Inspector]` 3컬럼, YAML은 별도 탭(`TabBar`/`activeTab`)이었다.

노드-그래프의 유일한 인지 강점은 **사용자가 직접 배치한 노드의 공간 기억**인데, 이 에디터의 캔버스는 노드 위치를 **자동 계산**(`draggable:false`, 매 렌더 재배치)해 그 강점이 0이고 비용만 남았다 — 사용자 보고(2026-06-28)대로 ① 스텝이 길어지면 글자가 작아져 흐름 파악이 어렵고, ② 팬이 클릭-드래그라 조작이 불편하며, ③ 드래그에 재정렬 같은 실기능이 없고, ④ 캔버스가 좌우 패널 폭을 잡아먹어 변수/헤더/바디 같은 긴 텍스트 편집이 좁았다. 더해 React Flow는 무거운 의존성이고 문서화된 auto-fit race·복잡한 레이아웃 수학(`measureStep`/`emitStep`/`measureWidth`)을 끌고 왔다.

시나리오 모델은 본질적으로 **순서가 핵심인 정렬된 리스트 + 제한된 1레벨 중첩**(loop `do` / if `then·elif·else` / parallel 레인)이라 자유형 그래프가 아니라 **아웃라인**(파일 트리 관용구)이 맞다. ADR-0003은 "GUI↔Code 양방향 sync"를 결정했을 뿐 GUI의 *표현*(캔버스 vs 아웃라인)을 고정하지 않았다 — 표현 교체는 이후 에디터 슬라이스(흐름 다이어그램·컨테이너 경계 넘는 re-parent)의 토대라 별도 결정 기록이 맞다. **디자인 시스템 확산(ADR-0043) 전에 에디터의 *구조*를 먼저 바로잡는다**(내부 테스트 단계 QoL 트랙).

## 결정

**에디터의 1차 표현 모델을 "팬 가능한 노드-그래프 캔버스(React Flow)"에서 "세로 인터랙티브 아웃라인(HTML 트리)"으로 교체한다. 양방향 sync 모델(ADR-0003/0015)은 그대로 유지한다 — 아웃라인은 같은 Zustand store/model 위의 새 *뷰 + 드래그 어피던스*일 뿐이다.** (에디터 구조 재설계 슬라이스 1/3.)

- **세로 아웃라인(`FlowOutline`)**: 스텝을 들여쓰기 트리로 렌더 — http 잎 = 메서드 배지(색+텍스트)·이름·raw URL(말줄임+`title`)·URL 누락 ⚠; 컨테이너 = 색 좌측테두리 + 헤더 + 들여쓴 자식(loop `do`·if `THEN/ELIF/ELSE` 밴드·parallel 레인). 행 클릭/Enter/Space로 선택, 선택 행 accent 강조, 빈 영역 클릭 해제. 행은 `role="option"`(드래그 핸들은 *별도* 버튼 — button-in-button 회피).
- **그룹내 드래그 재정렬(`dnd-kit`)**: 형제 그룹마다 `SortableContext`, `PointerSensor`+`KeyboardSensor`. `onDragEnd` → 순수 `resolveDragEnd(steps, activeId, overId)` → 기존 `moveStep(stepId, toIndex)`. **그룹 경계 넘는 re-parent는 no-op**(슬라이스 3 연기). 신규 모델 변경 0 — `moveStep`은 이미 형제-그룹 재정렬을 했고 드래그 어피던스만 없었다.
- **넓은 디테일 편집기 + 접이식 변수**: 레이아웃을 `[변수(접이식) │ 아웃라인(~300px) │ 디테일(1fr)]`로. Inspector는 무변경 재사용(폭만 확대). 변수 패널은 툴바 토글로 접으면 DOM에서 빠지고 편집기가 넓어진다.
- **YAML = 양방향 모달**: 탭 대신 툴바 `</> YAML` 버튼이 여는 `Modal` 안 `MonacoYamlView`. 디바운스-라이브 sync(`pendingYamlText`/`commitPendingYaml`)는 보존하고, **모달 닫을 때 flush-커밋**(편집 유실 0). 탭 전환 커밋 로직이 애초에 없으므로 `activeTab` 제거가 sync를 깨지 않는다.
- **React Flow 완전 제거**: `@xyflow/react` 의존성·`CanvasView`·노드 4종·`TabBar`·`store.activeTab` 표면 삭제. `test/setup.ts`의 `ResizeObserver` 폴리필은 recharts `ResponsiveContainer`(ReportView/RunDetailPage)가 공동 의존이므로 **유지**.
- **불변식**: 모델/YAML/store 편집 의미론 byte-identical — 엔진·proto·migration·`model.ts`·`yamlDoc.ts` 편집-apply 무변경. 머지 diff = `ui/`(+`docs/`·`package.json`·`pnpm-lock.yaml`)만.

## 결과

- **순이득**: 무거운 React Flow + 팬/줌 + auto-fit race + 레이아웃 수학이 사라지고(번들 순감소, 머지 diff 순 −1160/+834줄) 작은 dnd-kit이 들어온다. 전폭 행이라 글자가 안 줄고, 세로 스크롤이 팬을 대체하며, 드래그가 실제 재정렬 기능이 되고, 캔버스 칸이 디테일 편집기로 반환된다. YAML은 모드 전환 없이 모달로 즉시 연다.
- **a11y**: 행 키보드 포커스·Enter/Space 선택, dnd-kit `KeyboardSensor`(키보드 드래그), Inspector ↑↓ 이동 버튼 유지(비드래그 경로), 메서드 배지 색+텍스트.
- **트레이드오프**: 자유형 공간 배치를 잃는다 — 시나리오는 순차/중첩 트리이지 그래프가 아니므로 수용 가능. **컨테이너 경계 넘는 드래그/re-parent(슬라이스 3)**, **하단 흐름 다이어그램 + 테스트 결과 색상(슬라이스 2)**, YAML file-I/O(fast-follow — share→paste는 모달로 충족)는 연기.
- **검증**: per-task + whole-feature 리뷰(`handicap-reviewer`) clean APPROVE, UI 게이트 green(lint 0·1344 test·build), Playwright 라이브 검증 PASS(그룹내 드래그→YAML 반영·모달 flush·변수 접기·console Zod/React 0). 키보드 드래그 센서는 Playwright 자동화에서 미작동(포인터 드래그로 검증) — dnd-kit 포인터 이벤트 특성.

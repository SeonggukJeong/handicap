# 에디터 칩 스트립 높이 캡 — [스텝 넓게 보기] 가림 수정 (editor-wide-view-overflow)

- **날짜**: 2026-07-17
- **유형**: correctness-bug (UI-only 소형 — 와이어/서버/store/proto/모델 0-diff, 순수 표현 계층)
- **출처**: 사용자 직접 보고 2026-07-17 (start-slice) — "시나리오 에디터에서 [스텝 넓게 보기] 눌렀을때 스텝이 굉장히 긴 경우 그 가로 흐름들이 세로 방향 스텝을 다 가려버리는 문제". TestRunSection 확장 토글은 사용자 제안(같은 날): "TestRunSection은 기본 높이 캡을 적용하되 사용자가 원하면 더 늘릴 수 있게".
- **선행**: editor-space-qol(스텝 넓게 보기 도입) · editor-test-chips(`TestFlowChips` 도입, B13 슬라이스 2)

## 사용자 스토리 (US)

**B1 — [스텝 넓게 보기] 칩 스트립이 아웃라인을 가림 (재현/기대/실측)**

- **재현**: 45스텝 이상 시나리오에서 에디터 [스텝 넓게 보기] 클릭 (실측 뷰포트 1200×695).
- **기대**: 세로 아웃라인이 패널의 주 영역을 차지하고, 상단 "테스트 흐름" 칩 스트립은 칩 2~3줄 높이로 유지된다(넘치면 스트립 내부 스크롤).
- **실측**: 칩 스트립이 스텝 수에 비례해 무제한 세로 성장(`flex-wrap`+`shrink-0`) — 45스텝에서 233px(고정 높이 패널 439px의 53%), 105스텝에서 503px로 **패널을 뚫고 넘치며 아웃라인 wrapper 높이 0**(스텝 행이 패널 밖 y=898에 렌더, 뷰포트 밖). "넓게 보기"인데 스텝이 아예 안 보임.

**US1 — 하단 테스트 섹션 결과 밀림 (일관 적용분)**

QA가 긴 시나리오(45스텝+)에서 에디터 하단 '테스트' 섹션의 미리 1회 실행 결과를 확인할 때, 칩 스트립이 결과 패널을 밀어내지 않는다 — 성공하면 스트립이 기본 칩 2~3줄 높이 캡(내부 스크롤)으로 제한되고 ✓/✗ 결과 칩은 스크롤로 전부 접근 가능하며, 원하면 토글로 스트립을 펼쳐(전체 표시) 볼 수 있다(사용자 제안 — 페이지 흐름이라 펼쳐도 가림 없음). 현재 105스텝 실측: 스트립 ~503px가 결과 패널을 그만큼 아래로 밀어냄.

(브레인스토밍에서 사용자 승인 2026-07-17 — 버그 블록은 US 스파인 규약 §대체 경로)

## 배경 (현행 코드)

- `TestFlowChips.tsx`: 칩 wrap div가 `flex flex-wrap items-center gap-1.5` — **높이 제한 없음**. 소비처 2곳:
  1. `EditorShell.tsx` wide 분기(`wideOpen`) — 고정 높이 컨테이너(`capClass` = `h-[calc(100vh-16rem)]`, 접힘 크롬 시 `-11rem`) 안에서 `<section className="shrink-0">`로 렌더(trace=null 플레인 미러). 그 아래 `<div className="min-h-0 flex-1"><FlowOutline wide/></div>`. 스트립이 자라면 아웃라인이 짜부라지고(flex-1 shrink), 스트립 단독이 컨테이너를 넘으면 컨테이너 밖으로 흘러넘친다(overflow 미지정).
  2. `TestRunSection.tsx` — 페이지 흐름(가림 없음)이지만 긴 시나리오에서 스트립 503px+가 EnvironmentPicker·실행 버튼·결과 패널을 그만큼 아래로 민다.
- `varsWide`·비-wide(2열) 모드는 `TestFlowChips` 미렌더 — 이 버그와 무관.
- `TestFlowChips`는 `steps.length === 0`이면 null 반환(불변 유지).

## 범위 / 비목표

**범위**: `ui/src` 3파일 중심 — `TestFlowChips.tsx`(캡+expandable), `TestRunSection.tsx`(expandable 전달), `ko.ts`(문구 2키), + 테스트. `EditorShell.tsx`는 **0-diff 목표**(캡이 컴포넌트 기본이라 소비처 변경 불요).

**비목표**:
- 아웃라인에서 스텝 선택 시 캡 밖 선택 칩 자동 scrollIntoView (후속 후보 — §7).
- wide 모드의 펼치기 토글 — 펼치면 가림 버그가 그대로 복귀하는 경로라 **의도적으로 미제공**(하드 캡).
- 펼침 상태 localStorage 영속 — 영속하면 다음 진입 때 긴 스트립이 결과 패널을 다시 밀어내는 원래 문제가 복귀. 기본 접힘(캡)이 보호 기본값(ephemeral useState).
- 칩 렌더 내용·선택 링·클릭 점프·결과 색 등 기존 동작 전부 불변. 모델/store/와이어 0-diff.

## 요구사항

### R1 — 칩 wrap 높이 캡 (B1·US1 공통, 컴포넌트 내부)

1. `TestFlowChips`의 **칩 wrap div**(라벨 제외)에 기본 `max-h-24`(96px ≈ 칩 2~3줄) + `overflow-y-auto`. 라벨 "테스트 흐름"은 캡 밖(스크롤 영역은 칩만). wrap div에 `data-testid="chip-strip-wrap"` 부여 — T1/T4 클래스 토큰 단언의 안정 앵커(`editor-grid` testid 선례; role/testid 없는 div를 DOM 구조로 집는 취약 셀렉터 회피).
2. `max-h`(상한)라 짧은 시나리오는 자연 높이 유지 — 캡은 넘칠 때만 발동. 캡 발동 시 모든 칩은 스트립 내부 세로 스크롤로 접근 가능.
3. 구현 위치는 컴포넌트 내부 단일 지점 — 소비처 래핑(로직 2곳 중복·라벨 동반 스크롤) 기각.

### R2 — `expandable` prop + 펼치기 토글 (US1, TestRunSection 전용)

1. `TestFlowChips`에 additive optional prop `expandable?: boolean`(기본 undefined=미제공). `TestRunSection`만 `expandable`을 전달, `EditorShell`은 미전달(하드 캡 — 기존 호출부 0-diff).
2. 토글 렌더 조건: `expandable && (overflowing || expanded)` — 짧은 시나리오(캡 미발동)에서 아무 효과 없는 죽은 컨트롤을 노출하지 않는다. `overflowing`은 칩 wrap div의 **실측** `scrollHeight > clientHeight`.
3. 재측정 트리거: ① `useLayoutEffect` — steps/trace/expanded 변경 시(칩 내용·결과 아이콘로 wrap 줄 수 변동), ② `ResizeObserver` — 컨테이너 폭 변경 시(창 리사이즈로 wrap 재배치). RO 콜백은 읽기+`setState`만(스타일 미변경이라 `AutoGrowTextarea`류 되먹임 루프 없음 — same-value setState는 React가 bail). `disconnect` cleanup. **측정 effect·RO 생성은 `expandable`로 게이트** — EditorShell 인스턴스(미전달)는 `overflowing`을 소비하지 않으므로 관측 자체를 만들지 않는다(불필요 RO 방지).
4. 펼침(`expanded=true`) 시 캡 클래스(`max-h-24 overflow-y-auto`) 제거 — 전체 wrap 표시. 펼친 상태에선 `scrollHeight === clientHeight`라 `overflowing=false`가 되므로 렌더 조건의 `|| expanded`가 접기 버튼을 유지한다.
5. 토글은 라벨 "테스트 흐름" 옆(같은 헤더 행) 소형 텍스트 버튼 — `aria-expanded={expanded}` + `aria-controls={칩 wrap div id}`(`useId()`; wrap div는 항상 DOM에 있으므로 무조건 부여). 문구는 R4.
6. 펼침 상태는 ephemeral(useState) — 데이터셋/모드 등 다른 상태와 무관, 컴포넌트 lifetime 한정.

### R3 — wide 모드 회복 검증 (B1)

1. `EditorShell` wide 분기 구조(`shrink-0` section + `min-h-0 flex-1` 아웃라인)는 불변 — R1 캡만으로 스트립 총높이 ≤ ~120px(라벨+gap+96px)이 되어 아웃라인이 컨테이너 대부분을 회복한다.
2. 105스텝 재현 케이스에서: 칩 wrap div 높이 ≤ 96px, 아웃라인 wrapper 높이 > 200px(1200×695 기준), 스트립이 컨테이너 경계를 넘지 않음 — 라이브 rect 실측이 권위.

### R4 — 문구 (ADR-0035)

신규 사용자 노출 문구는 전부 `ko.ts` 경유:
- `ko.editor.chipStripExpand = "전체 펼치기"` (토글, 접힘 상태)
- `ko.editor.chipStripCollapse = "접기"` (토글, 펼침 상태)

## 테스트 계획

**`TestFlowChips` 테스트** (기존 파일 확장 — 칩 스트립 단언은 `role="group"` "테스트 흐름" `within` 스코프, 상시 미러 다중매치 함정):
- T1: 칩 wrap div에 캡 토큰 존재 — **`className.split(/\s+/)` 정확-토큰 `toContain`**(`max-h-24`·`overflow-y-auto`; raw substring `toContain`은 `max-h-*` false-green 함정).
- T2: `expandable` 미전달 → 토글 부재 — **overflow getter mock을 켠 상태에서**(mock 없이는 jsdom 기본 0이라 vacuous).
- T3: `expandable` + overflow 실측 mock(`scrollHeight`/`clientHeight` getter — jsdom은 둘 다 0이라 element/prototype getter mock 필요) → "전체 펼치기" 토글 렌더, `aria-expanded=false` + `aria-controls`가 wrap div id와 일치.
- T4: 토글 클릭 → 캡 토큰 제거(`not.toContain`) + `aria-expanded=true` + 문구 "접기". 재클릭 → 캡 복귀.
- T5: `expandable` + overflow 없음(getter 0) → 토글 부재(죽은 컨트롤 미노출).
- T6(신규 RO): `vi.stubGlobal`로 RO mock — 콜백 수동 발화로 재측정 경로 확인(`AutoGrowTextarea` 테스트 선례; `test/setup.ts`의 no-op 폴리필은 콜백 미발화라 기존 테스트 무영향).

**소비처**:
- `TestRunSection` 테스트: `TestFlowChips`에 expandable 전달 확인(토글이 뜨는 경로 1건 — overflow mock).
- `EditorShell` 테스트: wide 모드에서 펼치기 토글 **부재** 단언 — 실제 가치는 "`expandable` 미배선" 락인(향후 우발적 prop 전달 가드)이지 레이아웃 검증이 아님(레이아웃은 jsdom 불가 — R3.2 라이브 rect가 권위).

**게이트**: `pnpm lint && pnpm test && pnpm build` (파이프 없이 `; echo exit=$?`). tdd-guard: 테스트 파일 편집 먼저.

## 라이브 검증 (US 척추)

run-생성/report-파싱/엔진 경로 0-diff라 파이프라인 §5 의무 대상은 아니나, **시각 레이아웃 버그이므로 rect 실측 필수**([[implementation-rigor-over-spec]] #5 false-PASS 클래스 — DOM 존재만으로 PASS 금지). vite dev(`localhost` — IPv6 바인드) 클라이언트-only로 충분(백엔드 불요 — 검증 대상이 레이아웃·토글이라 trace 불요):

| US | 절차 | 통과 신호 |
|---|---|---|
| B1 | 105스텝 시나리오 → [스텝 넓게 보기]. **버퍼 주입 경로 = `+ HTTP 스텝` 버튼 반복 클릭**(브레인스토밍 재현 실측과 동일 — Monaco 프로그램 set 불가·store 미노출이라 UI 조작이 유일 검증된 경로; `browser_run_code_unsafe` 루프) | `getBoundingClientRect`: 칩 wrap ≤96px·아웃라인 wrapper >200px·스트립 bottom ≤ 컨테이너 bottom, 칩 스트립 내부 스크롤로 마지막 칩 도달 가능(`scrollHeight > clientHeight` + scrollTo 후 마지막 칩 가시) |
| US1 | 같은 시나리오 하단 '테스트' 섹션 | 기본: 칩 wrap ≤96px + "전체 펼치기" 토글 존재 → 클릭 후 wrap 높이 > 96px(전체 표시)·문구 "접기" → 재클릭 복귀 |
| US1' | 3스텝 짧은 시나리오 | 하단 섹션 토글 **부재**(overflow 게이트) + 캡 미발동(자연 높이) |

콘솔 에러 0 확인.

## 리스크 / 함정 메모 (plan이 상속할 것)

- **`max-h-24` 토큰 단언은 반드시 `split(/\s+/)` 정확-토큰** — raw `toContain`은 substring false-green(`ui/CLAUDE.md` 클래스 토큰 함정).
- **jsdom은 scrollHeight/clientHeight 항상 0 → overflow mock 메커니즘은 다음 중 하나로 핀** (둘은 등가가 아님 — 측정 `useLayoutEffect`가 mount 중 동기 실행되므로 render *후* element-레벨 `defineProperty`만 하면 재측정 트리거가 없어 T3/T4가 vacuous): ⓐ **`vi.spyOn(HTMLElement.prototype, "scrollHeight"/"clientHeight", "get")`을 `render()` 호출 *전*에 설치**(권장 — mount-시 측정이 mock 값을 봄), 또는 ⓑ element `defineProperty` + RO mock 콜백 수동 발화로 재측정 유도(`AutoGrowTextarea.test` 선례, T6 경로와 겸용). teeth: mock 제거 시 토글 부재 FAIL 확인.
- **RO 폴리필**: `test/setup.ts`가 no-op stub(콜백 미발화) — RO 경로 테스트는 `vi.stubGlobal` mock + 수동 발화(`AutoGrowTextarea.test` 선례). RO 콜백에서 스타일을 만지지 않으므로 width-gate 불요(읽기+bail-safe setState만).
- **선택 링(ring-1) 1px 클립**: overflow 컨테이너 상/하단 경계에 붙은 칩의 ring 바깥 1px이 잘릴 수 있음 — 수용(캡 발동 시에만, 시각 미미).
- **rules-of-hooks**: `TestFlowChips`는 현재 `useMemo` 뒤 `if (steps.length === 0) return null` early return이 있는 순수 컴포넌트 — 신규 훅(`useState`×2·`useRef`·`useId`·`useLayoutEffect`+RO)은 전부 **early return 앞**에 배치하고, 측정 effect는 `if (!el) return` 가드(steps-empty로 wrap div 부재 시).
- tdd-guard: 테스트 파일 편집을 src 편집보다 먼저(`ui/CLAUDE.md`).
- 신규 문구는 `ko.editor.*` 경유(ADR-0035) — RTL 셀렉터도 ko 키로 lockstep.
- 라이브 검증 Playwright는 `localhost`(vite IPv6 바인드), `.playwright-mcp/` 산출물 머지 전 정리.
- **`chip-strip-wrap` testid는 페이지 전역 유일이 아님** — `ScenarioEditPage`에서 EditorShell(wide) + TestRunSection 두 인스턴스가 공존 가능. 라이브 검증 셀렉터는 bare `querySelector` 금지, B1=wide section(`aria-label` `wideFlowStripAria`) / US1=TestRunSection 스코프 안에서 집는다(단위 테스트는 파일당 단일 마운트라 무관).

## §7 연기 (후속 후보)

- 선택 칩 자동 scrollIntoView(캡 안 선택 칩 가시성) — 아웃라인 행 클릭 시 스트립 자동 스크롤은 놀람 모션 우려로 이번엔 미포함.
- 펼침 상태 영속화 — 수요 확인 시 `editorPrefs` 패턴(단, 보호 기본값 상실 트레이드오프 재평가).

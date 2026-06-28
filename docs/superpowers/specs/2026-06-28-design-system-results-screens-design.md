# 디자인 시스템 확산 — 결과·표시 화면군 (설계) (§B12 / design-system-spread 후속)

- **날짜**: 2026-06-28
- **상태**: 설계 — spec-plan-reviewer **clean APPROVE**(2라운드, 2026-06-28). plan 작성 대기. plan = `docs/superpowers/plans/2026-06-28-design-system-results-screens.md`(작성 예정)
- **출처**: 사용자 요청 (roadmap §B12 "나머지 화면 토큰 이주"). C-2(`2026-06-27-rundialog-design-system-design.md`)가 토대(프리미티브 6종 + accent 토큰)를 세우고, design-system-spread(`2026-06-27-design-system-spread-design.md`)가 **폼 화면 4그룹**(Settings·Import·Datasets·Env·Templates·Schedules)에 확산했다. 그 §7이 "나머지 화면(리포트·run 상세·워커·비교·목록)"을 연기했고, 이 슬라이스가 그중 **결과·표시 화면군**을 실행한다. **에디터/Inspector(`scenario/`)는 입력 집약·고위험(React Flow/Monaco/Zustand)이라 별 슬라이스로 추가 연기**(§7).
- **연관**:
  - **토대(소비만, 0-diff)**: `ui/src/components/ui/{Field,Input,Select,Section,Callout,Badge}.tsx`·`tailwind.config.ts`·`Button.tsx`.
  - **확산 대상(JSX 재구성)**: `ui/src/pages/{ScenarioListPage,ScenarioRunsPage,RunDetailPage,WorkerDashboardPage,ScenarioComparePage}.tsx` + `ui/src/components/report/ReportView.tsx` + `ui/src/components/compare/{CompareMatrix,CompareOverlaySection}.tsx`.
  - 문구: `ui/src/i18n/ko.ts`(ADR-0035) — 신규 인라인 문자열 0이 원칙.
- **ADR**: **신규 없음.** ADR-0043("UI 디자인 시스템 점진 채택")의 *실행*이지 새 결정이 아니다. roadmap §B12에서 완료 항목 이동·새 연기 적재만.

## 범위 결정 (사용자, 2026-06-28)

1. **결과·표시 화면군만.** 에디터/Inspector(`scenario/` 디렉토리)는 별 슬라이스로 연기.
2. **토대 동결(순수 소비)** — 프리미티브·토큰에 새 tone/variant 추가 없음. 탐색 결과 success Callout variant·status Badge tone을 *부를* 표면(verdict 초록·워커 busy/idle/stale·status 분포)은 전부 **데이터-식별 색**이라 동결 대상이지 토대 변경 사유가 아니다(§3.3).
3. **시각 회귀 방지가 적용 깊이보다 우선**(design-system-spread R6 정신): 프리미티브가 깨끗이 맞지 않는 표면(데이터-viz 색·plain 표시 카드·dense 컴팩트 툴바·자체 severity 팔레트)은 **변환하지 않고 동결**한다(억지로 끼우면 룩이 깨진다).

---

## 1. 문제와 목표

결과·표시 화면(run 목록·run 상세·워커 대시보드·비교·리포트)은 design-system-spread가 폼 화면을 통일한 뒤에도 **ad-hoc 알림 박스**가 남아 있다 — 같은 의미의 오류/경고/상태 박스(`role="alert"` 빨강·`role="status"` 호박)가 화면마다 손으로 `border border-red-200 bg-red-50 text-red-700` 식으로 ~17곳 반복되고, 패딩·라운드·색조가 미묘하게 다르다(`p-2`/`p-3`·`rounded`/`rounded-md`·`text-red-700`/`text-red-800`/`text-red-600`). 이 슬라이스는 **C-2가 만든 `Callout` 프리미티브를 그 블록-레벨 알림에 드롭인 적용**해 결과 화면 전반의 알림 룩·역할(role)·여백을 통일하고, 곁들여 표시 화면의 raw 입력 1곳을 `Input`으로 통일한다.

- **목표**:
  1. 블록-레벨 알림(오류/경고/상태 박스)을 **기존 프리미티브 `Callout`으로 드롭인 교체** — **역할(role)·variant 계열(error=빨강/warn=호박)·문구는 1:1 보존**하되, 세부 패딩·라운드·색조는 **Callout 캐넌으로 정규화**(의도된 *통일* — design-system-spread가 폼 입력을 canonical `Input`으로 통일한 것과 동일. **look은 pixel-1:1이 아니라 통일·behavior/wire는 byte-identical**).
  2. 표시 화면의 정당한 raw `<input>`(WorkerDashboard `EditModal`)을 `Input`으로 통일(포커스 링·`aria-invalid` 획득).
  3. **동작 byte-identical** — 핸들러·react-query·도출 로직·셀렉터 0-diff. JSX 마크업만 교체.
  4. **토대 동결** — `ui/src/components/ui/*`·`tailwind.config.ts`·`Button.tsx` 0-diff(순수 소비).
- **비목표(연기)**: §7. 에디터/Inspector·`RunListControls` 컴팩트 툴바(별도 컴팩트 variant 필요 = 토대 변경)·success Callout variant·status Badge tone·데이터-식별 색 토큰화·`InsightPanel` severity 팔레트.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

> 전부 UI-only 표시/구조 폴리시. 와이어/뮤테이션 계약 변경 없음(R3/R10이 0-diff 불변식 소유) → `seam` 열은 비어 있고, 라이브 검증(R12)은 표시 화면 JSX 리팩터 회귀 방지용(경량).

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | `MUST` 8개 대상 파일(5 페이지 + ReportView + CompareMatrix + CompareOverlaySection)의 **블록-레벨 알림 박스**를 기존 `Callout`으로 재구성한다 | 각 대상 파일 diff가 `Callout` import·적용을 보임; §4 매핑대로 | |
| R2 | `MUST`(불변식) **토대 동결** — `ui/src/components/ui/{Field,Input,Select,Section,Callout,Badge}.tsx`·`tailwind.config.ts`·`Button.tsx` **0-diff**(새 tone/variant/토큰 0). 순수 소비 | `git diff --name-only`에 그 경로 부재 | |
| R3 | `MUST`(불변식) **동작·와이어 byte-identical** — 핸들러·react-query 훅·도출(`useMemo`/필터/정렬/라벨)·상태 round-trip·전송 payload가 재구성 전과 동일. JSX 마크업만 교체. **(시각은 byte-identical이 *아님* — Callout 캐넌으로 통일됨, R4 참조)** | 각 페이지/컴포넌트 기존 테스트 전부 통과; 로직 함수 0-diff(리뷰) | |
| R4 | `MUST` **블록-레벨 알림 → `Callout`**, **기존 `role` 1:1 보존**(없으면 안 만든다): `role="alert"`(blocking 오류)→`Callout role="alert"`·`role="status"`(non-blocking 경고)→`Callout role="status"`·roleless 오류/경고 텍스트·박스→`Callout` role 미부여(roleless 보존). variant = 빨강(`bg-red-*`/`text-red-*`) 오류 박스·텍스트→`error`·호박(`bg-amber-*`) 경고 박스→`warn`. **세부 색조/패딩/라운드는 Callout 캐넌으로 정규화**(예: `p-3`→`p-2`·`rounded`→`rounded-md`·`text-red-800`→`text-red-700`·`text-red-600`→`text-red-700` — 의도된 통일, 시각 1:1 *아님*) | 전환 박스 **role이 전환 전과 1:1** + **variant 계열(error=빨강/warn=호박) 일치** + 문구 보존; 기존 role RTL 통과 | |
| R5 | `MUST` **변환 제외(인라인 유지·동결)** — ① 색 없는(slate) 로딩/상태 *텍스트*(`<p role="status" text-slate-*>`)·slate 박스(`RunDetail:257` `bg-slate-50`)는 **유지**(`Callout`엔 plain/slate variant 없음 → 박스화·재색이 시각 회귀), ② 버튼 옆 인라인 `<span role="alert">`(`ScenarioRunsPage:277`)은 인라인 유지(전환=레이아웃 시프트), ③ checkbox·`<textarea>`·`type="date"` 등 비-Input 요소는 정당 예외 | 그 요소들 0-diff(grep); slate 텍스트/박스·인라인 span 보존 | |
| R6 | `MUST` raw `<input>` 중 **WorkerDashboard `EditModal` 입력**(`WorkerDashboardPage:106`, `w-full rounded border-slate-300 px-2 py-1.5`)만 `Input`으로 교체(이미 `w-full`이라 폭 래퍼 불요·`mb-2`는 `className`으로·`aria-label` 패스스루 보존). **checkbox**(`ScenarioRunsPage:333`·`CompareOverlaySection:26`)는 정당 예외(R5) | 그 입력 `Input` 적용·`aria-label`/`type` 보존; checkbox 0-diff | |
| R7 | `MUST`(불변식) **데이터-식별 색 동결** — 차트 stroke·`StatusBadge`·`VerdictBadge`·`VerdictPanel`·`runLabel`/compare 팔레트(`runColor`/`runShortLabel`)·`ConnectionCostCard` green/teal 바·`ScenarioRunsPage` stall 배지(`bg-amber-100`)는 손대지 않는다(C-2 R13 원칙: 데이터-식별 색은 별 도메인) | 그 마크업 0-diff(grep) | |
| R8 | `MUST`(불변식·동결) **`InsightPanel`·`InsightCompareMatrix` severity 색 맵**(`critical`·`warning`·`info` 3단계, `InsightPanel.tsx:11`·`InsightCompareMatrix.tsx:15`)은 **`Callout`으로 변환하지 않는다** — 이유는 *색조 차이*가 아니라(R4에서 색조 정규화는 수용) **severity가 자체 3단계 데이터-식별 팔레트**라서다: `info`는 severity 등급이지 generic `Callout info`(accent 안내)와 의미가 다르고, 한 맵이 여러 인사이트 행을 균일 구동한다(piecemeal 변환 부적합). severity-식별 색 = R7 데이터-식별 색의 한 갈래로 **단위 동결**. (`warning` 단계가 Callout `warn`과 우연히 색이 같아도 맵 전체를 단위로 동결) | 두 파일 severity 맵·렌더 0-diff(grep) | |
| R9 | `MUST`(불변식·동결) **`RunListControls` 컴팩트 툴바**(`ui/src/components/RunListControls.tsx`: date preset `<select>`·`type="date"` 입력·sort field/dir `<select>`)는 **변환하지 않는다** — `px-0.5/py-0.5`·`bg-transparent` 칩-내 select 등 dense 컴팩트 스타일이라 `Input`/`Select`(BASE `px-2 py-1`·자체 border·`w-full`)로 바꾸면 툴바 높이·dense 룩이 깨진다(컴팩트 variant = 토대 변경 = 연기) | `RunListControls.tsx` 0-diff(이 슬라이스 diff에 부재) | |
| R10 | `MUST`(불변식) 백엔드·proto·migration·`ui/src/api/*`·`schemas.ts`·Zod 파싱 **0-diff** — 순수 UI 표시/구조 | `git diff --name-only`에 `crates/`·`*.proto`·`*.sql`·`api/` 부재; diff는 `ui/src`(페이지/컴포넌트)·`ko.ts`·`docs`만 | |
| R11 | `MUST`(불변식) accent 드리프트 — 이 슬라이스가 **새 `text-blue-*`/`bg-blue-*`/`indigo-*` 컨트롤 색을 *추가* 하지 않는다**. ⚠ **기존(pre-existing) drift는 0이 아니다** — `ScenarioRunsPage:269`(`bg-indigo-600` 비교 버튼)·`:458`(`text-indigo-600` 정렬 화살표)·`WorkerDashboardPage:63`/`:132`(`bg-blue-600` 다이얼로그 버튼)·`:485`(`text-blue-600` busy-run 링크)는 **Button-accent 도메인이라 이 Callout/Input 슬라이스 범위 밖**(별도 Button-accent 이주 슬라이스로 연기, §5·§7). C-2는 *폼* 화면만 수렴했고 결과 화면은 미수렴 | 만진 박스/입력에 **신규** blue/indigo 0(diff 리뷰); 기존 action-control drift는 §5 동결 목록에 명시 | |
| R12 | `MUST` 신규/변경 사용자-노출 문구는 `ko.ts` 경유(ADR-0035) — 단, **신규 인라인 문자열 0**이 원칙(기존 ko 키 그대로 이동). `Callout title=`을 *새로* 다는 경우만 ko 재사용. `aria-label`도 ko 경유 | 만진 파일 인라인 영어 0·신규 노출 텍스트 ko 참조(grep) | |
| R13 | `MUST` 라벨↔컨트롤 연결·셀렉터 lockstep — `Callout`은 `role`/children/`aria-label`을 패스스루로 보존(기존 `getByRole("alert")`/`getByRole("status")`/`getByText` 통과); WorkerDashboard 입력은 `aria-label` 보존 `Input`으로(`getByLabelText` 통과) | 기존 `getByRole`/`getByLabelText`/`getByText` 셀렉터 통과 | |
| R14 | `SHOULD` a11y — `Callout`/`Input`가 제공하는 accent 포커스 링·`aria-invalid` 스타일을 소비로 획득하되 **기존 a11y 계약(role·aria-label) 회귀 0** | 만진 파일 RTL a11y 셀렉터 통과 | |
| R15 | `MUST` 라이브 검증(경량) — 이 화면들은 run-생성/report-파싱/Zod 경로가 **아니라**(읽기-표시) S-D Zod 갭 비해당. 대표 화면(RunDetail report 뷰 + run 목록 필터/정렬 라운드트립)에서 console 에러 0·역할/포커스 링 보존만 스모크 | `/live-verify`(워크트리 자체 바이너리 + Playwright) 또는 plan에서 근거와 함께 축소 | ✅(표시 화면) |

- **seam**: 와이어/뮤테이션 계약 변경 없음 — R3·R10이 "0-diff/byte-identical" 불변식을 명시 소유.

---

## 3. 핵심 통찰 (설계 근거)

1. **확산은 *적용*이지 *발명*이 아니다**(R1·R2). C-2가 프리미티브·토큰을, design-system-spread가 폼 화면 적용 패턴을 이미 확립했다. 이 슬라이스는 그 패턴을 결과 화면에 소비할 뿐이라 **토대 동결**(R2)이 위험을 "마크업 교체"로 한정한다.
2. **표시 화면이라 폼 화면보다 더 안전하다**(R3). design-system-spread는 뮤테이션 폼(payload 0-diff가 안전선)이었지만, 결과 화면은 대부분 **읽기-표시**다. Callout 교체는 핸들러·react-query·도출 로직을 전혀 안 건드린다 → 기존 RTL이 그대로 회귀 가드.
3. **토대 동결이 성립한다 — success variant·status tone 불필요**(R2·R7·R8). 탐색 결과 드롭인 후보는 전부 기존 Callout(info/warn/error) API로 덮인다. 토대 변경을 *부를* 표면(verdict 초록·워커 busy/idle/stale·status 분포·`ConnectionCostCard` green 바·severity 팔레트)은 셋 다 **데이터-식별/severity 색**이라 *그대로 두는 게 옳다*(데이터-식별 색은 별 도메인=C-2 R13). 그래서 토대 0-diff가 자연스럽게 성립한다.
4. **변환 경계 규칙 = "빨강/호박 오류·경고(박스 또는 borderless 텍스트)"만**(R4·R5). 빨강(`bg-red-*`/`text-red-*`) 오류·호박(`bg-amber-*`) 경고는 박스든 borderless 텍스트든 Callout로 통일하되, **색 없는(slate) 로딩/상태 텍스트·slate 박스·버튼 옆 인라인 span은 유지**한다 — `Callout`엔 plain/slate variant가 없어 박스화·재색이 시각 회귀이기 때문. 이 경계가 "통일(좋음)"과 "회귀(나쁨)"를 가른다. **cross-page 일관성 필수**(F2): 구조상 동일한 roleless 로드 오류(`<p text-red-600>` early-return: `ScenarioList:35`·`ScenarioRuns:138`·`RunDetail:82`)와 borderless `role="alert"` 로드 오류(`Worker:402`)는 **전부 Callout error로 통일**(각자 role 보존 — roleless면 role 없이) — design-system-spread가 *이 정확한 패턴을 화면별 매핑에서 놓쳐* whole-branch 리뷰가 잡았던 트랩(`ui/CLAUDE.md`)을 사전 차단.
5. **`Callout`의 `role`은 호출자 지정 — 프리미티브가 강제 안 함**(R4·R13). 같은 시각 variant라도 의미 role은 문맥별로 다르다(blocking 오류=`alert`·non-blocking advisory=`status`·roleless 경고=role 없음). 17개 박스의 기존 role을 1:1 보존해야 a11y·셀렉터 byte-identical(C-2 Callout role 함정).
6. **드롭인이 a11y를 *공짜로* 올린다**(R14). raw `<input>`엔 포커스 링·`aria-invalid`가 없지만 `Input`은 토큰화된 accent 포커스 링·invalid 빨강 링을 BASE로 갖는다. WorkerDashboard 입력 1곳이 그 이득을 받는다(동작 변화 0, 표시 개선).
7. **시각 회귀 방지 > 적용 깊이**(R5·R8·R9, design-system-spread R6 정신). `RunListControls` 컴팩트 툴바·`InsightPanel` severity 팔레트·plain 표시 카드는 프리미티브가 깨끗이 안 맞아 **동결**한다 — 억지 적용보다 명시적 비-적용이 옳다.
8. **화면별 단계 = subagent-driven 자연 매핑**(§8). 각 파일이 독립 green 커밋이고, 화면 경계가 리뷰·롤백 단위가 된다(design-system-spread Phase 정신의 결과-화면 확장).

---

## 4. 변경 상세 (화면별)

> 각 항목에 **충족 R** 태그. 전부 `ui/src`(페이지/컴포넌트)·`ko.ts`·`docs/` 범위. file:line은 탐색 시점(2026-06-28) 기준 — 구현 시 재확인.

### 4.1 ScenarioListPage — 충족 R: `R1,R3,R4,R12,R13`
- **목록 로드 오류 `<p className="text-red-600">{ko.common.failedToLoad(...)}</p>`(`:35`, roleless early-return)** → `Callout variant="error"`(role 미부여 — roleless 보존; F2 cross-page 일관). 현재 **미테스트**(`home.test.tsx` 미커버) → 변환과 함께 렌더 단언 추가.
- **복제(clone) 오류 `<p role="alert" className="mb-3 text-sm text-red-600">{clone.error}</p>`(`:37`)** → `Callout variant="error" role="alert"`(borderless 빨강 → 박스 통일). 이미 `clone.test.tsx:111` `findByRole("alert")`·`:115` `queryByRole("alert")`가 행사 → Callout role 보존이라 그대로 green(lockstep).
- **EmptyState CTA(`:43`)는 공유 컴포넌트라 동결**(R7 정신 — 시그니처 무변경). `home.test.tsx:52-53`가 EmptyState 분기 커버.
- ✅ **테스트 정정**: ScenarioListPage는 `ScenarioListPage.clone.test.tsx`·`ScenarioListPage.home.test.tsx` 두 파일이 **존재**한다(앞선 spec 초안의 "테스트 없음"은 오류 — `.test.tsx` 정확명만 본 탓). lockstep 대상 = 이 두 파일 + `:35` 로드오류 신규 단언.

### 4.2 ScenarioRunsPage + (RunListControls 동결) — 충족 R: `R1,R3,R4,R5,R7,R9,R13`
- **시나리오 로드 오류 `<p className="text-red-600">…</p>`(`:138`, `if (scenario.error) return …` roleless early-return)** → `Callout variant="error"`(role 미부여 — F2 cross-page 일관).
- 페이지(run 생성) 오류 박스 `role="alert" border border-red-200 bg-red-50 text-red-700`(`:183`) → `Callout variant="error" role="alert"`.
- **버튼 옆 인라인 `<span role="alert" text-red-600>`(`:277`)·인라인 `text-red-600` span(`:230`)은 인라인 유지**(R5 — 전환=레이아웃 시프트).
- **stall 배지(`:344` `bg-amber-100`)·`StatusBadge`(`:342`)·`VerdictBadge`(`:359`)·compare 선택 checkbox(`:333`)는 동결**(R7·R5).
- **`RunListControls`(필터/정렬 툴바)는 통째 동결**(R9 — 컴팩트 variant 연기).

### 4.3 RunDetailPage — 충족 R: `R1,R3,R4,R5,R7,R13`
- **run 로드 오류 `<p className="text-red-600">…</p>`(`:82`, `if (run.error) return …` roleless early-return)** → `Callout variant="error"`(role 미부여 — F2 cross-page 일관).
- 오류 박스 `role="alert" border-red-200 bg-red-50 text-red-800 rounded`(`:181`·`:189`·`:236`·`:249`) → `Callout variant="error" role="alert"`(공통 4곳; `text-red-800`→Callout `text-red-700` 정규화, R4).
- 경고/상태 박스 `role="status" border-amber-300 bg-amber-50 text-amber-800`(`:197`·`:205`) → `Callout variant="warn" role="status"`. `:205`는 `flex items-center justify-between gap-3`라 그 레이아웃을 `Callout className=`으로 보존(자식 버튼 동작 0-diff).
- **slate 로딩 박스 `role="status" border-slate-200 bg-slate-50 text-slate-600`(`:257`, reportGenerating)는 유지**(R5 — Callout에 slate variant 없음).
- **`StatusBadge`(`:127`)·`VerdictBadge`(`:128`)·raw 프로필 `<li>`·차트 동결**(R7).

### 4.4 WorkerDashboardPage — 충족 R: `R1,R3,R4,R5,R6,R7,R13`
- 경고 박스 **roleless** `bg-amber-50 text-amber-800`(`:43`) → `Callout variant="warn"`(role 미부여 — roleless 보존).
- 오류 박스 `role="alert" bg-red-50 text-red-700`(`:46`[`ConfirmDialog` 내]·`:116`[`EditModal` 내]·`:426`[flex justify-between]) → `Callout variant="error" role="alert"`. `:426`는 flex 레이아웃 `Callout className=`으로 보존.
- borderless 오류 `<p role="alert">{ko.workers.loadError}</p>`(`:402`) → `Callout variant="error" role="alert"`.
- **`EditModal` 입력 `<input type={inputType} w-full rounded border-slate-300 px-2 py-1.5>`(`:106`) → `<Input className="mb-2" aria-label={title} type={inputType} value onChange />`**(R6 — 이미 `w-full`·`mb-2`만 className·focus/invalid 획득·`py-1.5`→Callout/Input `py-1`·`rounded`→`rounded-md` 정규화). (`PromptDialog`는 없는 이름 — 컴포넌트는 `EditModal`·`ConfirmDialog`.)
- **slate 로딩 텍스트 `<p role="status" text-slate-500>`(`:398`)·인라인 busy/idle/stale 상태 배지(`:465`/`:504` `bg-amber-100`·`:473` `bg-slate-100` 등) 동결**(R5·R7 — 데이터-식별 상태 색; stale 배지 roleless 컨벤션은 `ui/CLAUDE.md` 워커 대시보드 항목. `STATUS_STYLE` 맵은 SchedulesPage 것 — 여긴 인라인 배지).

### 4.5 ScenarioComparePage — 충족 R: `R1,R3,R4,R5,R7,R13`
- 오류 `<p role="alert" text-red-600>`(`:75`)·오류 박스 `role="alert" bg-red-50 text-red-700`(`:217`) → `Callout variant="error" role="alert"`.
- **slate 로딩 `<p role="status" text-slate-600>`(`:62`)은 유지**(R5).
- **`runLabel`(`runShortLabel`/`runColor`) 팔레트·`InsightCompareMatrix`(R8) 동결**(R7·R8).

### 4.6 ReportView — 충족 R: `R1,R3,R4,R7`
- **다운로드 실패 배너** `role="alert" border-red-200 bg-red-50 text-red-700`(`:147`, `dlErr` — ReportView는 `report.data` 있을 때만 렌더되므로 리포트-로드 오류가 아니라 다운로드 실패) → `Callout variant="error" role="alert"`.
- **`VerdictPanel`(`:154`, 데이터-식별 verdict 색)·자식 차트/표 컴포넌트(`report/*`) 동결**(R7) — plain 표시 카드라 Section 비대상(design-system-spread R6).

### 4.7 compare/* — 충족 R: `R1,R3,R4,R5,R7,R8`
- **CompareMatrix**: 경고 박스 `role="status" bg-amber-50 text-amber-700`(`:112`) → `Callout variant="warn" role="status"`. **Δ 폴라리티 색·`runColor` 스와치 동결**(R7).
- **CompareOverlaySection**: **plain `<p role="status" text-slate-500>`(`:43`)은 유지**(R5)·metric toggle checkbox(`:26`) 정당 예외(R5)·차트 동결(R7).

### 4.8 report/* 나머지 (reviewed-no-change) — 충족 R: `R7,R8`
- `ActiveVuChart`·`PercentileCurveChart`·`LatencyHistogramChart`·`StatusDistribution`·`TimeSeriesChart`·`StepPhaseBreakdown`·`StepStatsTable`·`Summary`·`ReportHeadline`·`ScenarioSnapshot`·`BranchStatsTable`·`GroupLatencyTable`·`ConnectionCostCard`·`VerdictPanel`·`WorkerBreakdownTable`·`InsightPanel`(R8): **데이터-viz 색·자체 severity 팔레트·plain 표시 카드**라 프리미티브 비대상 → **변경 없음**. (블록 알림 없음 → Callout 대상 아님.)

### 4.9 문구 — `ui/src/i18n/ko.ts` — 충족 R: `R12`
- **신규 인라인 문자열 0이 원칙.** Callout children은 기존 ko 키/문구 그대로 이동. `Callout title=`을 *새로* 추가하는 경우만 `ko.common`/해당 페이지 ko 재사용/추가(이번엔 신규 title 불필요 예상). dead-key 위생: 변환으로 더는 참조 안 되는 ko 키가 생기면 제거(이번 범위에선 발생 안 함 — role/children 보존).

---

## 5. 무변경 / 불변식 (명시)

- **토대**: `ui/src/components/ui/{Field,Input,Select,Section,Callout,Badge}.tsx`·`tailwind.config.ts`·`Button.tsx` 0-diff(R2).
- **백엔드·proto·migration·`ui/src/api/*`·`schemas.ts`·Zod 파싱**: 0-diff(R10).
- **각 화면 로직**: 핸들러·react-query 훅·도출(필터/정렬/라벨/useMemo)·상태 round-trip 0-diff(R3) — 마크업만 교체.
- **데이터-식별 색**: 차트 stroke·`StatusBadge`·`VerdictBadge`·`VerdictPanel`·`runLabel` 팔레트·compare Δ 색·`ConnectionCostCard` green/teal·stall 배지·워커 status 배지 0-diff(R7).
- **severity 팔레트**: `InsightPanel`·`InsightCompareMatrix` critical/warning/info 색 맵 0-diff(R8).
- **컴팩트 툴바**: `RunListControls` 0-diff(R9).
- **기존 action-control accent drift(범위 밖·동결)**: `ScenarioRunsPage:269`(`bg-indigo-600` 비교 버튼)·`:458`(`text-indigo-600` 정렬 화살표)·`WorkerDashboardPage:63`/`:132`(`bg-blue-600` 다이얼로그 버튼)·`:485`(`text-blue-600` busy-run 링크)는 **Button/링크 accent 도메인**이라 이 Callout/Input 슬라이스에서 손대지 않는다(R11 — 별도 Button-accent 이주 슬라이스, §7). 신규 drift만 금지.
- **공유 컴포넌트 경계**: `EmptyState`·`StatusBadge`·`VerdictBadge`·`HelpTip`·`Modal`·`Button` 시그니처/동작 무변경.
- **정당 예외(프리미티브 비대상)**: checkbox·`<textarea>`·`type="date"`·slate 로딩 텍스트/박스·버튼 옆 인라인 `<span role="alert">` — 구조 보존(R5).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | 각 대상 파일 diff에 `Callout` 적용(리뷰) + §4 매핑 대조 | |
| R2 | `git diff --name-only`에 `ui/src/components/ui/`·`tailwind.config.ts`·`Button.tsx` 부재 | |
| R3 | 각 페이지/컴포넌트 기존 RTL 테스트 전부 통과·로직 함수 0-diff(리뷰) | |
| R4 | 전환 박스 role/variant 1:1 RTL(`getByRole("alert")`/`getByRole("status")`)·variant 색 매칭 | |
| R5 | slate 텍스트/박스·인라인 span·checkbox 0-diff(grep)·`RunDetail:257`/`Compare:62`/`Worker:398`/`Overlay:43` 유지 | |
| R6 | WorkerDashboard 입력 `Input` 적용·`aria-label`/`type` 보존(`getByLabelText`) | |
| R7 | 차트/StatusBadge/VerdictBadge/VerdictPanel/runLabel/Δ색/green바/stall/워커status 0-diff(grep) | |
| R8 | `InsightPanel`·`InsightCompareMatrix` severity 맵·렌더 0-diff(grep) | |
| R9 | `RunListControls.tsx` 슬라이스 diff에 부재 | |
| R10 | `git diff --name-only`(ui/ko/docs만) | |
| R11 | 만진 파일 blue/indigo 드리프트 0(grep) | |
| R12 | 인라인 영어 0·신규 노출 텍스트 ko 참조(grep) | |
| R13 | 기존 `getByRole`/`getByLabelText`/`getByText` 셀렉터 통과 | |
| R14 | 만진 파일 RTL a11y 셀렉터 통과 + 라이브 포커스/role | ✅ |
| R15 | `/live-verify`: RunDetail report 뷰 + run 목록 필터/정렬 라운드트립·console 0·역할/포커스 링 | ✅ |

- **UI 게이트**: 각 화면 커밋마다 그 파일 + 의존 테스트 GREEN, 슬라이스 종료 시 `pnpm lint && pnpm test && pnpm build`(전체).
- **회귀 가드 보강(F1)**: R3의 "기존 테스트가 곧 회귀 가드"는 *변환 박스가 테스트로 실제 행사되는* 곳에만 성립한다. 변환되지만 미행사인 박스는 **타깃 lockstep 단언 추가**(렌더 + `getByRole("alert"/"status")` 1~2개) — 이 추가 단언이 곧 tdd-guard용 pending diff를 겸한다(아래 §8 tdd-guard 사전조치). 특히 추가 대상: `ScenarioListPage` **로드 오류 `:35`**(현재 미테스트 — `clone.test.tsx`/`home.test.tsx`는 clone 오류·EmptyState만 커버)·`ScenarioComparePage`(오류 분기)·`WorkerDashboardPage`(`EditModal` 입력·경고 박스)·각 화면 roleless 로드오류 변환분(`ScenarioRuns:138`/`RunDetail:82`).
- **라이브 검증(R15)**: design-system-spread보다도 경량 — run-생성/report-파싱/Zod 경로 비해당(읽기-표시)이라 S-D Zod 갭 부재. RunDetail이 실제 report를 그려야 하므로 `/live-verify`로 measure 포함 run 1개 → RunDetail에서 Callout(오류 분기는 비정상 상태 유도 또는 정상 경로 console 0 확인)·필터/정렬 라운드트립만 스모크.

---

## 7. 의도적 연기 (roadmap §B12에 누적)

- **에디터/Inspector 화면군**(`scenario/` 디렉토리: `Inspector`(1391L)·`KeyValueGrid`·`InsertTemplateModal`·`SaveTemplateDialog`·`TestRunPanel`·`VariablesPanel`·step 노드·`ScenarioEditPage`): 입력 집약·고위험(React Flow/Monaco/Zustand 양방향 sync) — 별 슬라이스(자체 brainstorming/spec).
- **`RunListControls` 컴팩트 툴바**: dense 컴팩트 컨트롤(`py-0.5`·`bg-transparent` 칩-내 select)이라 `Input`/`Select` 컴팩트 variant(토대 변경) 선행 필요 — 연기.
- **success Callout variant**·**status Badge tone**: design-system-spread §7 그대로 — 토대 변경이라 데이터-식별 색 정책과 함께 별도 검토.
- **차트/compare 색 토큰화**·**`InsightPanel`/`InsightCompareMatrix` severity 팔레트**: 데이터-식별/severity 색은 별 도메인 — 별도 검토.
- **기존 프리미티브(`Button`/`Modal`/`HelpTip`) `ui/` 폴더 통합**·**기존 HelpTip aria 텍스트 ko 이주**: C-2 §7 그대로 유지.

---

## 8. 구현 순서 (plan 입력)

> 전부 `ui/`(+`ko.ts`)·`docs/` — cargo 게이트 비대상(UI 게이트 `pnpm lint && pnpm test && pnpm build`만). **화면별 단계** — 각 화면이 독립 커밋(그 파일 + 의존 테스트 GREEN). 단일 슬라이스·단일 머지. 토대(R2)·와이어(R10) 0-diff가 전 phase 공통 불변식.
>
> ⚠ **tdd-guard 사전조치(F1)**: `tdd-guard`는 `ui/src/**`(non-test) 편집 시 디스크에 *pending*(수정/미추적) test-path 파일을 요구하고, JSX-only 변경은 auto-pass에 안 들어간다. 대응: (a) F1의 타깃 lockstep 단언을 *먼저* 그 파일의 test에 추가(=pending diff + 회귀 가드 겸함), 또는 (b) 단언 추가가 불요한 파일엔 `__tests__/_tdd_keepalive.test.tsx`(`it.todo`)를 미리 깔아 unblock 후 task 끝에 `rm`(커밋 금지). orchestrator는 implementer에 명시 경로만 `git add` 지시(`-A` 금지).

1. **`ScenarioListPage`** (작고 드롭인 2곳·낮은 위험 = 시작점) — 로드 오류 `:35`(roleless)·clone 오류 `:37`(role=alert) → Callout error. **기존 테스트 존재**(`clone.test.tsx`·`home.test.tsx`) → lockstep + **`:35` 로드오류 렌더 단언 신규**(미커버 분기, F1 pending diff 겸).
2. **`ScenarioRunsPage`** — 시나리오 로드 오류 `:138`(roleless)·run-생성 오류 박스 `:183` → Callout error(인라인 span `:230`/`:277`·stall/status 배지·checkbox·`RunListControls` 동결). 기존 `ScenarioRunsPage.test` lockstep(필터 칩 ↔ verdict 배지 disambiguate는 `ui/CLAUDE.md` 항목 유지).
3. **`RunDetailPage`** — run 로드 오류 `:82`(roleless)·오류 4곳·경고 2곳 → Callout(slate 로딩 박스 `:257`·배지·차트 동결). flex 박스(`:205`) className 보존. 기존 `RunDetailPage.test` lockstep.
4. **`WorkerDashboardPage`** — 경고/오류 박스(`:43` roleless warn·`:46`/`:116`/`:402`/`:426`) → Callout(roleless/role 보존)·`EditModal` 입력(`:106`) → Input(slate 로딩 `:398`·인라인 status 배지 동결). 기존 테스트 lockstep + `EditModal` 입력/경고 단언(F1).
5. **`ScenarioComparePage` + `compare/{CompareMatrix,CompareOverlaySection}`** — 오류/경고 박스 → Callout(slate 로딩·checkbox·`runLabel`/`InsightCompareMatrix` 동결). 기존 테스트 lockstep.
6. **`ReportView`** — 리포트 오류 박스 → Callout(VerdictPanel·차트 동결). 기존 `ReportView.test` lockstep.

**마무리**
7. 전체 UI 게이트(`pnpm lint && pnpm test && pnpm build`) + grep 불변식(R2·R5·R7·R8·R9·R10·R11) + 라이브 검증(R15).
8. roadmap **§B12** 완료 항목 이동(결과·표시 화면군) + 새 연기 적재(에디터/Inspector·`RunListControls` 컴팩트 variant·success variant·status tone·severity 팔레트) + build-log 단락 + 루트 CLAUDE.md 상태줄.

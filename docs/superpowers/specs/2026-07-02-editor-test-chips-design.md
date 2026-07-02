# 에디터 테스트 흐름 칩 스트립 — 가로 flex-wrap 그룹 칩 + test-run 결과 색/아이콘 + 칩 클릭 선택 (에디터 구조 재설계 슬라이스 2/3)

> **이 슬라이스의 normative 코어는 §2 R-표.** plan·구현·리뷰는 전부 R-id를 참조한다.

- **날짜**: 2026-07-02
- **상태**: 설계 승인(사용자 2026-07-02, 구조 표현은 사용자 변형 "컨테이너=그룹 칩" 채택) → spec 리뷰 대기
- **출처**: 사용자 요청(2026-06-28) — "스크롤 내려 테스트할 때 흐름을 가로로 줄바꿈 표시 + 성공/실패 색상". 상위 spec `2026-06-28-editor-flow-outline-redesign-design.md` §7이 슬라이스 2로 연기한 항목: "하단 흐름 다이어그램 + 테스트 결과 색상(녹색 ✓/빨강 ✗/중립 ○) + 칩 클릭 선택 — 가로 flex-wrap 칩(줄바꿈, React Flow 아님), `POST /api/test-runs` 트레이스의 스텝별 결과를 색+아이콘으로(색맹 a11y)". 설계 Q&A(2026-07-02): ① 구조 표현 = 평탄+라벨 기반에서 **사용자 변형 채택** — loop/if/parallel은 하위 칩까지 하나의 그룹 칩으로 묶고 컨테이너 이름은 작게(상하 크기 소폭 증가 수용); ② if 칩 = 타진 분기 라벨 + **색으로 구분**(타진 분기 강조/안 타진 분기 dimmed); ③ 칩 클릭 = 선택만(스크롤 점프 없음) — 선택으로 위쪽 디테일 편집기(Inspector)에 해당 스텝이 뜨는 것으로 충족.
- **연관**: ADR-0044(에디터 1차 표현 = 아웃라인, 이 트랙의 슬라이스 1), ADR-0026(test-run trace 계약 `ScenarioTrace`), ADR-0035(UI 한국어 `ko.ts` 단일 소스), ADR-0043(디자인 시스템 — 단 결과 색은 데이터-식별 도메인이라 accent 토큰 비대상). 주요 파일: `ui/src/components/scenario/TestRunSection.tsx`·`TestRunPanel.tsx`(branch 라벨 출처)·`ui/src/api/schemas.ts`(`ScenarioTraceSchema` — 무변경 소비만)·`ui/src/scenario/model.ts`(`Step` 판별 헬퍼 — 무변경 소비만)·`ui/src/i18n/ko.ts`.
- **ADR**: **신규 ADR 불필요.** ADR-0044가 결정한 아웃라인 재설계 트랙 안의 뷰 *추가*(같은 모델·같은 trace 계약 위 표시 전용)이고 모델/와이어/아키텍처 결정이 없다. ADR-0044 원문이 이미 슬라이스 2를 로드맵으로 명시.

---

## 1. 문제와 목표

에디터는 `[변수 │ 아웃라인 │ 디테일 편집기]` 상단부와, 그 **아래로 스크롤해야 나오는** `TestRunSection`(테스트 컨트롤 + 실행 결과 패널)으로 구성된다(슬라이스 1 결과). 테스트 섹션까지 내려가면 아웃라인이 화면 밖이라 ① 지금 테스트하는 시나리오의 *흐름*이 안 보이고, ② test-run 결과(`TestRunPanel`)는 실행 행의 세로 리스트라 "어느 스텝이 성공/실패했고 어디는 아예 실행이 안 됐는지"를 흐름 위에서 한눈에 못 본다. ③ 결과에서 문제 스텝을 발견해도 그 스텝을 편집하려면 위로 스크롤해 아웃라인에서 다시 찾아야 한다.

- **목표**: `TestRunSection` 상단에 시나리오 흐름을 **가로 flex-wrap 칩 스트립**으로 상시 미러하고(run 전 = 순수 흐름 미러), test-run 후 스텝별 결과를 **색+아이콘**(✓/✗/○, 색맹 a11y)으로 입히며, **칩 클릭 = 스텝 선택**(위쪽 디테일 편집기가 그 스텝을 표시)으로 결과→편집 동선을 잇는다. 컨테이너(loop/if/parallel)는 하위 칩까지 **하나의 그룹 칩**으로 묶어 구조를 보존한다.
- **비목표(연기)**: §7 참조. **컨테이너 경계 넘는 드래그/re-parent(슬라이스 3)**, 칩 위 unbound-vars 경고 표시, 칩 클릭 시 스크롤 점프, 컨테이너 그룹의 집계 결과 배지, `TestRunPanel` 행 ↔ 칩 상호 하이라이트.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST 신규 프레젠테이셔널 `TestFlowChips` 컴포넌트를 `TestRunSection` 컨트롤 섹션 내부(인트로 문단 아래·EnvironmentPicker 위)에 **상시 렌더**한다 — props는 `steps`(기존 `traceSteps` 재사용), `trace`(`testRun.data ?? null`), `selectedStepId`, `onSelect`; `steps.length === 0`(빈 시나리오·파싱 실패)이면 미렌더. | `TestRunSection.test`: 스텝 있는 yamlText로 마운트 → 스트립 렌더; 파싱 불가 yamlText → 스트립 부재. 두 에디터 페이지는 `TestRunSection` 공유라 자동 반영. | |
| R2 | MUST 칩 스트립은 **문서 순서**의 가로 `flex flex-wrap`: http leaf = 단독 칩(`[메서드 배지 + 이름(말줄임+title) + 결과 아이콘]`), loop/if/parallel = **그룹 칩**(연한 테두리·배경의 inline-flex flex-wrap 단위, 앞머리에 작은 라벨 ⟳이름×N / ⎇이름 / ⇉이름, 자식 칩이 그 안에 들어감), 중첩 컨테이너는 그룹-안-그룹(모델 제약상 최대 2겹), **최상위 형제 사이에만 → 구분자**(aria-hidden 장식). | `TestFlowChips.test`: loop+if+parallel 섞인 모델에서 그룹 칩 안에 자식 칩이 DOM 중첩으로 들어있고(컨테이너 요소 `within` 스코프로 자식 매치), 라벨 glyph+이름 렌더, 최상위 구분자 개수 = 최상위 스텝 수 − 1. | |
| R3 | MUST if 그룹 칩 내부는 분기 라벨(`then:` / `elif 1:` / `else:`)로 자식을 구획하고, parallel 그룹 칩 내부는 분기명 라벨로 구획한다; **실행 후 타진 분기(집합 — loop 안 if는 반복마다 다른 분기 가능)의 라벨은 violet 강조 + → 접두**, 안 타진 분기 라벨은 dimmed(자식은 R4의 ○); 타진 집합에 `"none"`이 있으면 if 그룹 라벨 옆에 `(미매치)` 표지. branch 라벨 문자열 매핑은 `TestRunPanel`의 `branchText`/`BRANCH_LABEL`을 `chipResults.ts`로 추출해 **단일 소스**로 쓴다(`TestRunPanel`은 import 경로만 변경, 렌더 문자열 byte-identical). | `TestFlowChips.test`: trace의 if 행 `branch:"then"` → then 라벨에 강조 클래스+→, else 라벨에 dimmed 클래스; then+else 두 행이면 **둘 다** 강조; `branch:"none"` 행이면 `(미매치)` 표지; `TestRunPanel.test` 기존 branch 라벨 단언 green 유지. | |
| R4 | MUST 결과 도출은 순수 함수 `deriveChipResults(trace)`(신규 `ui/src/scenario/chipResults.ts`) — http: 같은 `step_id` 행 중 하나라도 `error != null ∥ response.status ≥ 400` → **fail**(기존 `statusClass`의 fail 판정과 동일 기준), 행 ≥1 & fail 아님 → **pass**(3xx 등 비-2xx 클린 행도 pass — 패널 status 칩의 3-상태 색과 달리 흐름 칩은 성공/실패/미실행 3상태로 단순화, reqwest가 redirect를 따라가 3xx 노출은 드묾); if: 행들의 non-null `branch` **고유 집합**을 그대로 운반; **trace에 행이 없는 스텝** = not-run. `trace == null`(run 전)이면 결과 장식 전무(플레인 흐름 미러). | `chipResults.test`: ① 클린 1행=pass ② error 행 포함=fail ③ status 500=fail ④ loop 3행 중 1 fail=fail ⑤ 행 없음=not-run(맵 미포함) ⑥ if 단일 then=`{then}` ⑦ if then+else 두 행=`{then,else}` ⑧ 3xx 클린 행=pass 단위 단언. | |
| R5 | MUST 결과 시각화(색맹 a11y): pass = emerald 계열 + ✓, fail = red 계열 + ✗, not-run = slate dimmed + ○ — 아이콘은 `aria-hidden` 장식이고 결과 텍스트는 칩 `aria-label`("이름 — 성공/실패/미실행")에 실어 색 단독 전달 금지; run 전 플레인 칩의 aria-label은 이름만. 색은 데이터-식별 도메인(accent 토큰 금지, `TestRunPanel` emerald/red 계열과 통일). | `TestFlowChips.test`: trace 주입 후 pass/fail/not-run 칩 각각의 클래스 + `getByRole("button", {name:"… — 성공"})` 단언; trace 없으면 결과 접미 없는 name 단언. | |
| R6 | MUST 칩(http leaf **및 컨테이너 그룹 라벨**)은 `<button>`이고 클릭 시 `onSelect(stepId)` — `TestRunSection`이 `useScenarioEditor` `select`로 배선해 위쪽 디테일 편집기(Inspector)가 그 스텝을 표시한다(기존 `selectedStepId` 메커니즘, 스크롤 점프 없음); `selectedStepId`와 일치하는 칩은 아웃라인 행과 동일한 accent 링. | `TestFlowChips.test`: 칩 클릭 → `onSelect` 인자 단언 + selected 칩 accent 클래스·비선택 칩 부재; `TestRunSection.test`: 칩 클릭 → store `selectedStepId` 갱신. | |
| R7 | MUST 신규 사용자 노출 문구(스트립 제목/aria·결과 접미·mixed 라벨 등)는 전부 `ko.ts` 경유(ADR-0035); 단 공유 추출한 branch 라벨(`then`/`elif n`/`else`/`(미매치)`)은 **기존 문자열 byte-identical 유지**(ko 이주는 범위 밖 — §7). | `grep`으로 신규 컴포넌트 내 하드코딩 한국어/영어 문구 0(메서드명·glyph 제외) + `ko.editor.*` 신규 키 존재. | |
| R8 | MUST (불변식) 엔진·controller·proto·migration **무변경**(diff에 `crates/`·`*.proto`·`*.sql` 0건); `ScenarioTraceSchema`·`schemas.ts`·`model.ts`·`yamlDoc.ts`·`store.ts` **무변경**; `TestRunPanel`은 branch 라벨 추출 import 외 무변경; `TestRunSection`은 스트립 마운트 배선(subscribe/prop 전달)만 추가하고 기존 파싱·상태·mutation 로직 무변경. | 머지 diff 경로 검사 + `git diff` 상 해당 파일 무변경/최소변경 확인 + 기존 `TestRunSection`/`TestRunPanel`/`useTestRun` 테스트 green. | seam 없음(표시 전용) |
| R9 | MUST 게이트: `pnpm lint`(`--max-warnings=0`)·`pnpm test`(전체)·`pnpm build` green + 머지 전 **라이브 Playwright 실측**(§6) — jsdom이 못 보는 실제 색 렌더·flex-wrap 줄바꿈·클릭→Inspector 반영을 확인([[implementation-rigor-over-spec]]: DOM 존재/텍스트만으로 PASS 금지). | 3 게이트 green + §6 라이브 체크리스트 수행 기록. | |

- **`seam?` 전 행 비어 있음(계약 경계 없음).** 이 슬라이스는 UI Zod ↔ engine serde / proto / migration 어느 경계도 건드리지 않는다 — `ScenarioTrace`는 기존 스키마 그대로 *소비*만 하고(R8), 새 필드·새 요청·새 응답이 없다. run-생성/report-파싱/엔진 경로 무관이라 S-D 갭 사유의 라이브 "필수"는 아니지만, 시각 표면(색·wrap·클릭 동선)이 헤드라인이라 R9가 라이브 실측을 요구한다.

---

## 3. 핵심 통찰 (설계 근거)

1. **trace 계약이 이미 결과 도출에 충분하다 — 백엔드 0-diff.** `ScenarioTrace.steps`는 http 실행마다 1행(loop 자식은 `loop_index`로 반복 행), if는 결정 행(`branch` 운반)이고, loop/parallel 컨테이너 자체는 행이 없다(`trace.rs` 주석 명시). assertion 실패는 http 행 `error`에 실린다(`status X != Y`) → ✗ 판정은 기존 `statusClass`(error∥status≥400)와 동일 기준 재사용(R4). **행 부재 = 미실행**(안 타진 분기·truncation 이후)이라 ○도 파생만으로 나온다. 즉 이 기능 전체가 기존 응답의 *표시 전용* 소비다.
2. **그룹 칩(사용자 변형)은 이 모델에서 안전하다.** 일반적으로 중첩 그룹 레이아웃은 무한 중첩이 위험이지만, 이 모델은 상호 1레벨 중첩만 허용(9c 두 계층 Zod 게이트)하고 parallel은 top-level 전용 → 그룹-안-그룹 최대 2겹으로 유계. 그룹 내부를 `inline-flex flex-wrap`으로 두면 자식이 많아도 그룹 *안에서* 줄바꿈되고 그룹은 바깥 flex-wrap에 한 단위로 참여 — "하위 칩까지 하나로 묶여 보임"과 "가로 줄바꿈"이 동시에 성립한다. 컨테이너 라벨은 `text-[11px]` 소형으로 상하 증가를 최소화(사용자가 명시 수용).
3. **마운트 지점이 이미 모든 데이터를 들고 있다.** `TestRunSection`은 `traceSteps`(yamlText 파싱, `TestRunPanel` if-요약용으로 이미 존재)와 `testRun.data`(trace)를 둘 다 소유 → 스트립은 그 자식으로 props만 받는 프레젠테이셔널이 된다(R1). 선택 배선도 이 컴포넌트가 이미 `useScenarioEditor`를 import한다(extract 추가 경로). 새 상태·새 fetch·새 store 액션 0.
4. **if 결과는 pass/fail이 아니라 "어느 분기"다.** if 결정 행엔 `error` 개념이 없고(조건 unbound는 경고 도메인 — §7 연기) 의미는 분기 선택뿐 → ✓/✗ 대신 타진 분기 라벨 + 색 구분(사용자 답 ②). 타진 라벨 violet 강조는 `TestRunPanel` IfRow의 violet 어휘와 통일. loop 안 if가 반복마다 다른 분기를 탈 수 있으므로 결과는 단일 분기가 아니라 **타진 분기 집합**으로 파생해 타진 라벨을 전부 강조 — "mixed" 같은 별도 표지 없이 밴드 자체가 사실을 보여준다(R4 ⑦).
5. **"편집화면에 해당 칩 관련이 떠 있으면"은 기존 메커니즘이 공짜로 준다.** `select(id)` → `selectedStepId` → Inspector(디테일 편집기)가 그 스텝을 렌더 — 슬라이스 1이 만든 구동계 그대로(R6). 스크롤 점프는 결과를 보던 맥락을 깨므로 안 한다(사용자 답 ③); 클릭 피드백은 칩 자체의 accent 링이 준다.
6. **run 후 버퍼 편집과의 정합은 "현재 버퍼 기준" 단일 규칙으로.** 스트립은 항상 *현재* `steps`를 렌더하고 결과 맵은 마지막 trace에서 파생 → 삭제된 스텝의 행은 자연 무시(맵에 있어도 칩이 없음), run 후 추가된 스텝은 행이 없어 ○(="지난 실행에 없었음" — 정직한 표시). 별도 stale 배지·무효화 로직 불요.

---

## 4. 변경 상세

> 각 묶음 머리에 **충족 R** 태그. 라인 참조는 작성 시점 기준(구현 시 재확인).

### 4.1 `ui/src/scenario/chipResults.ts` (신규) — 충족 R: R3, R4
- 순수 모듈(React 무관, `resolveDragEnd`/`reorder.ts` 패턴): `export type ChipResult = { kind: "http"; result: "pass" | "fail" } | { kind: "if"; branches: string[] }`(taken 분기 고유 집합, `"none"` 포함 가능), `export function deriveChipResults(trace: ScenarioTrace): Map<string, ChipResult>`.
- http 집계: step_id별 행 그룹 → any(`error != null ∥ (response != null && response.status >= 400)`) → fail, else pass(행 ≥1 전제 — 행 0이면 맵 미포함=not-run). `response == null && error == null` 행(이론상 없음 — 방어)은 fail 트리거가 아니며 존재만으로 pass 판정에 들어간다.
- if 집계: 행들의 `branch`(non-null) 고유 집합을 순서 보존으로 수집(중복 제거).
- `TestRunPanel.tsx`의 `BRANCH_LABEL`/`branchText`를 이 모듈로 추출 export — 문자열 byte-identical, `TestRunPanel`은 import로 교체(R3).

### 4.2 `ui/src/components/scenario/TestFlowChips.tsx` (신규) — 충족 R: R2, R3, R5, R6
- props: `{ steps: ReadonlyArray<Step>; trace: ScenarioTrace | null; selectedStepId: string | null; onSelect: (id: string) => void }`. `steps.length === 0`이면 `null` 반환(R1의 미렌더는 여기 가드로).
- 재귀 렌더: http leaf → `<button>`(메서드 배지[`FlowOutline`의 `METHOD_BADGE` 팔레트와 동일 어휘 — 공유 여부는 plan에서 결정하되 시각 일치] + 이름 `max-w`+`truncate`+`title` + 결과 아이콘). 컨테이너 → 그룹 `<span>`(연한 테두리 `border-slate-200`·배경 `bg-slate-50` 계열, `inline-flex flex-wrap items-center`) 안에 라벨 `<button>`(glyph ⟳/⎇/⇉ + 이름 소형 + loop `×N`) + 자식 재귀. if/parallel은 분기 라벨 `<span>`(then:/elif n:/else:/분기명) 구획(R3).
- 결과 장식: `deriveChipResults` 맵 lookup — pass `bg-emerald-*`+✓, fail `bg-red-*`+✗, 미존재(trace 있을 때) slate dimmed+○, trace `null`이면 전부 플레인(R4/R5). 아이콘 `<span aria-hidden>`, `aria-label`은 `ko.editor.*` 함수 키로 "이름 — 성공/실패/미실행" 조립(R7).
- 선택: `selectedStepId === id` 칩에 `border-accent-500 ring-1 ring-accent-500`(아웃라인 행과 동일 규약, R6).
- 최상위 형제 사이 `→` 구분자 `<span aria-hidden>`(R2).

### 4.3 `ui/src/components/scenario/TestRunSection.tsx` — 충족 R: R1, R6, R8
- `const selectedStepId = useScenarioEditor((s) => s.selectedStepId)` 구독 추가 + 인트로 문단 아래에 `<TestFlowChips steps={traceSteps} trace={testRun.data ?? null} selectedStepId={selectedStepId} onSelect={(id) => useScenarioEditor.getState().select(id)} />` 마운트. 그 외(파싱 memo·mutation·EnvironmentPicker·TestRunPanel 배선) 무변경(R8).

### 4.4 `ui/src/i18n/ko.ts` — 충족 R: R7
- `ko.editor.*` 신규 키: 스트립 제목/aria-label(예: `testFlowAria`), 결과 접미 함수 키(`chipAriaPass(name)`/`chipAriaFail(name)`/`chipAriaNotRun(name)` 또는 단일 함수), 컨테이너 그룹 aria 등 — 정확한 키 구성은 plan에서 확정. (`(미매치)` 표지는 추출된 `branchText("none")` 재사용 — byte-identical, R3/§7.)

### 4.5 테스트 (신규/갱신) — 충족 R: R1–R6
- `ui/src/scenario/__tests__/chipResults.test.ts`(신규): R4 acceptance 8케이스.
- `ui/src/components/scenario/__tests__/TestFlowChips.test.tsx`(신규): 구조(그룹 중첩·구분자)·결과 클래스/aria·클릭 `onSelect`·선택 링·플레인 모드.
- `ui/src/components/scenario/__tests__/TestRunSection.test.tsx`(갱신): 스트립 렌더/미렌더 + 칩 클릭 → store 선택.
- 기존 `TestRunPanel.test.tsx`: branch 라벨 추출 후 green 유지 확인(R3).

---

## 5. 무변경 / 불변식 (명시)

- **엔진·proto·controller·migration 무변경** — 머지 diff에 `crates/`·`*.proto`·`*.sql` 0건(R8). `POST /api/test-runs` 요청/응답 계약 무변경.
- **`ScenarioTraceSchema`(`schemas.ts`)·`model.ts`·`yamlDoc.ts`·`store.ts` 무변경** — 스트립은 기존 계약의 표시 전용 소비자(R8). 새 store 액션·새 Zod 스키마 0.
- **`TestRunPanel` 렌더 동작 무변경** — branch 라벨 상수/함수의 모듈 추출 + import 교체만(문자열 byte-identical, R3/R8).
- **`TestRunSection` 기존 로직 무변경** — 마운트 배선(구독 1줄 + JSX 1블록)만 추가(R8).
- **CSP 메타(`index.html`) 무변경** — 신규 의존성 0(순수 컴포넌트 + Tailwind 클래스).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | `TestRunSection.test`: 스트립 렌더/파싱실패 미렌더 | |
| R2 | `TestFlowChips.test`: 그룹 DOM 중첩(`within`)·라벨·최상위 구분자 수 | ✅(wrap 줄바꿈 실측) |
| R3 | `TestFlowChips.test`: 타진 분기 강조/비타진 dimmed + `TestRunPanel.test` green | |
| R4 | `chipResults.test`: 7케이스 단위 | |
| R5 | `TestFlowChips.test`: 결과 클래스+aria-label 접미; 플레인 모드 | ✅(실색 렌더 screenshot) |
| R6 | `TestFlowChips.test`: 클릭→`onSelect`+선택 링; `TestRunSection.test`: store 반영 | ✅(클릭→Inspector 표시) |
| R7 | grep 하드코딩 0 + ko 키 존재 | |
| R8 | 머지 diff 경로 검사 + 기존 테스트 green | |
| R9 | `pnpm lint`·`test`·`build` + 아래 라이브 체크 | ✅ |

- **라이브 검증(머지 전, `/live-verify` + Playwright)**: responder 상대 시나리오(성공 스텝 + assertion 실패 스텝 + if 분기 + loop)로 에디터에서 test-run 실행 후 ① 칩에 ✓/✗/○이 색과 함께 표시(클래스 단언 + screenshot — [[implementation-rigor-over-spec]] #5 false-PASS 클래스 회피, `getBoundingClientRect`로 스트립 가시 높이 > 0 확인) ② 좁은 뷰포트에서 flex-wrap 줄바꿈(스트립 높이 증가 실측) ③ 칩 클릭 → 위 디테일 편집기에 해당 스텝 폼 표시 ④ run 전 플레인 미러 상태. 에디터 `/scenarios/new`는 클라이언트-only지만 test-run은 백엔드 필요(`POST /api/test-runs`) — live-verify 스택 사용.

---

## 7. 의도적 연기 (roadmap §B13에 누적)

- **컨테이너 경계 넘는 드래그 / re-parent** → 슬라이스 3(상위 spec §7 그대로).
- **칩 위 unbound-vars/조건 경고 표시** — `TestRunPanel`이 이미 행 단위로 보여줌; 칩은 결과 3상태만(과밀 방지).
- **컨테이너 그룹의 집계 결과 배지**(loop 전체 fail 등) — 자식 칩이 이미 전달; v1은 라벨=구조만.
- **칩 클릭 시 스크롤/포커스 이동** — 사용자 답 ③으로 배제(선택만).
- **`TestRunPanel` 행 ↔ 칩 상호 하이라이트/앵커 점프** — 별도 폴리시 후보.
- **branch 라벨("(미매치)" 등) ko.ts 이주** — 기존 하드코딩의 byte-identical 추출만 수행; ADR-0035 전수 정리 트랙에서 해소.
- **loop 반복 상세(N회 중 M회 실패) title 툴팁** — v1은 집계 결과만; 필요 시 후속 폴리시.

# RunDialog 디자인 시스템 + 초보자 친화 재구성 (설계) (사용성 묶음 C-2 / §UX1 ④c)

- **날짜**: 2026-06-27
- **상태**: 설계 승인(spec-plan-reviewer clean APPROVE) · plan 승인(REVIEW-GATE APPROVED 2026-06-27) → 구현 대기 (STOP-gate: `/clear`→fresh 컨텍스트)
- **출처**: 사용자 요청 (roadmap §UX1 "사용성 묶음 C" 중 ④c, shortlist #1). C-1(결과화면 폴리시)에서 분할 연기된 마지막 항목. **왜 지금**: RunDialog가 초보자에게 가장 당황스러운 표면(필드 과밀·전문 용어·안내 부재·시각 평탄)인데, 동시에 앱 전체에 **재사용할 디자인 시스템의 첫 출발점**으로 삼기 좋다("차츰 확장").
- **연관**: `ui/src/components/RunDialog.tsx`(936줄, 주 소비처)·`LoadModelFields.tsx`(647줄, ScheduleForm 공유)·`Button.tsx`·`Modal.tsx`·`HelpTip.tsx`(기존 프리미티브)·`CriteriaFields.tsx`·`StepCriteriaFields.tsx`·`EnvironmentPicker.tsx`·`DataBindingPanel.tsx`(렌더 트리 하위)·`ScheduleForm.tsx`(공유 영향)·`tailwind.config.ts`(빈 `theme.extend`)·`ui/src/i18n/ko.ts`(`glossary`·`runDialog`). ADR-0035(한국어 copy).
- **ADR**: **ADR-0043 신규** — "UI 디자인 시스템(시맨틱 토큰 + 프리미티브 컴포넌트 레이어)을 점진 채택, RunDialog를 첫 채택처로". 근거: 토큰·프리미티브·accent 선택은 *향후 슬라이스가 따라야 할 방향*이라 한 줄 인덱스로 못박아야 재결정을 막는다.

---

## 1. 문제와 목표

RunDialog는 한 화면에 부하·대상·판정·프리셋·용량까지 수십 개 raw 입력을 평면으로 펼쳐, 초보자가 **① 어디서부터(정보 과부하) ② 용어가 무슨 뜻(전문 용어) ③ 무엇을 넣어야 맞는지(안내·추천값 부재) ④ 그룹·우선순위 구분이 약함(시각적 평탄)**의 4중고를 겪는다. 동시에 앱엔 디자인 토대가 없다(`tailwind.config.ts`의 `theme.extend`가 빔, 프리미티브는 `Button`/`Modal`/`HelpTip` 3개뿐, accent가 `indigo-600`/`text-blue-600`로 드리프트). 이 슬라이스는 **시맨틱 토큰 + 소형 프리미티브 셋**을 세우고 그 위에 **RunDialog를 동작 byte-identical로 재구성**해 네 pain을 동시에 푼다.

- **목표**:
  1. 재사용 디자인 토대(토큰 + 프리미티브 셋)를 세운다 — RunDialog가 소비하는 만큼, 향후 확장의 출발점.
  2. RunDialog를 구조 A(번호 섹션·강한 위계) + 추천 기본값 프레이밍 + 용어 HelpTip 배선으로 재구성. **제출 페이로드·검증·동작은 byte-identical.**
  3. accent를 `indigo`로 통일(앱 전역 `Button.primary` 포함).
- **비목표(연기)**: §7. 다른 페이지(리포트·에디터·목록) 토큰 이주·차트 팔레트·간단/상세 토글·마법사·기존 프리미티브 폴더 통합.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

> 전부 UI-only 표시/구조 폴리시. 와이어/파싱 계약 변경 없음(R14가 0-diff 불변식 소유) → `seam` 열은 비어 있고, 라이브 검증은 run-생성 경로 리팩터 회귀 방지용(R16).

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | `MUST` `tailwind.config.ts`의 `theme.extend`에 시맨틱 토큰 레이어를 정의한다 — accent=`indigo`(primary `indigo-600`·hover `indigo-700`·ring `indigo-500`·soft `indigo-50/700`), neutral=`slate`(유지), semantic=amber(경고)/red(오류)/green(통과, 기존 유지), 입력 radius `rounded-md` 통일 | `tailwind.config.ts` diff에 토큰 정의; 프리미티브가 토큰 경유 클래스 사용(리뷰) | |
| R2 | `MUST` 신규 프리미티브 셋을 `ui/src/components/ui/`에 추가한다 — `Field`(라벨+컨트롤+힌트+에러+선택적 HelpTip+추천 태그 래퍼)·`Input`·`Select`·`Section`(번호 배지+제목+필수/선택 배지+선택적 접힘)·`Callout`(info/warn/error variant)·`Badge`. 전부 프레젠테이셔널·드롭인 | 각 `ui/src/components/ui/__tests__/*.test.tsx` GREEN(아래 R11·R15 a11y 포함) | |
| R3 | `MUST` 공유 `Button` 프리미티브의 `primary` variant를 `bg-slate-900…`→accent(`bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300`)로 (앱 전역). `secondary`/`danger` variant·시그니처·기존 className 병합은 무변경 | `Button.test`(**신규** — 현재 없음, accent flip의 유일 프로그램 가드)/소비처 시각; `secondary`/`danger` 0-diff(리뷰) | |
| R4 | `MUST`(불변식) RunDialog 제출 페이로드(`buildProfile()` 출력)·검증 게이트(`loadModelErrors`/`canSubmit`/`*Invalid`)·cross-field 동작(`minWindowRps`→`rpsWarmup` seed·think-time 페어링·프리셋 load·prefill seed·pool 409 clamp/force)이 재구성 전과 byte-identical | `RunDialog.test`(payload·disable·프리셋·409 분기) 전부 통과; `buildProfile`/`profileForm.ts`/`loadModel.ts` 로직 0-diff | |
| R5 | `MUST` RunDialog를 번호 섹션 3개로 재구성 — `1 부하 정의`(필수)·`2 대상 설정`(선택)·`3 판정·고급`(선택·접힘)을 `Section` 프리미티브로. 기존 접힘 토글·`advancedActiveCount`("N개 설정됨") 힌트·자동 펼침(seed 비기본값) 동작 보존 | `RunDialog.test`: 3섹션 구조·접힘 토글·"N개 설정됨" 힌트·seed시 자동 펼침 | |
| R6 | `MUST` 추천 기본값 프레이밍을 **위치-게이트**한다 — (a) 부하 섹션 상단 안내 한 줄("추천값으로 채워져 있어 바로 실행할 수 있습니다")은 **RunDialog 소유 Section 마크업**(공유 `LoadModelFields` *밖*)에, (b) 필수 입력 옆 `추천` `Badge`는 **`LoadModelFields`의 RunDialog-전용 optional prop**(`onApply*`/`sizingScenarioId!==undefined` 게이트 패턴 — prop 부재면 미렌더)로. 기본값 숫자는 R4로 byte-identical(프레이밍만 추가) | `RunDialog.test`: 안내+추천 배지 렌더 / `LoadModelFields`·`ScheduleForm.test`: 추천 배지·"바로 실행" 문구 **미렌더** | |
| R7 | `MUST` 모든 주요 용어 필드가 `?` HelpTip을 갖도록 보장한다 — 렌더 트리는 이미 **11개** 노출(RunDialog: slo·thinkTime / `LoadModelFields`: closedLoop·openLoop·vuCurve·rampDown·vu·rampUp·maxInFlight·workerCount·rps)이라 R7은 *재구성 중 보존* + **유일 공백 지속시간(duration) 1곳 추가**. 본문은 `ko.glossary` 단일 소스(신규 글로서리 = `duration` 1건뿐) | `RunDialog`/`LoadModelFields.test`: 기존 11 HelpTip 보존 + duration HelpTip 신규·`ko.glossary.*` 참조 | |
| R8 | `MUST` RunDialog의 ad-hoc 경고/오류 박스를 `Callout` 프리미티브로 전환한다 — 드리프트 경고(`role=alert`)·blockedReasons(`role=status`)·pool over-hint(`role=status`)·preset 오류(`role=alert` 유지, `RunDialog.tsx:506`)·capacity 확인 다이얼로그(`role=alertdialog`). 각 `role`·문구·동작(버튼/clamp/force) 보존. **mutation 오류 `<p>`(`:789`)만 현재 roleless → Callout `role="alert"` 부여**(표시-only a11y 개선, 동작 무변경) | `RunDialog.test`: 기존 `role=alert`/`status`/`alertdialog`·clamp/force 페이로드 + mutation 오류 `role=alert` 신규 | |
| R9 | `MUST` 신규 프리미티브(Field/Input/Select)를 RunDialog **렌더 트리 전체**에 적용한다 — RunDialog 자체 입력 + 공유 `LoadModelFields`의 number/text 입력·셀렉트. 복잡 위젯(stage 편집기·사이징 헬퍼·모드 라디오)은 **공유 `INPUT` 상수(`LoadModelFields.tsx:56` `rounded`→토큰 `rounded-md`)를 통한 클래스 정합만**(구조 무재작성) — 그 위젯 입력도 상수 경유로 radius/포커스 통일 | RunDialog/`LoadModelFields`의 `<input>`/`<select>` 요소에 raw `border-slate-300` 인라인 클래스 0(전부 `Input` 또는 토큰화된 `INPUT` 상수 경유); `INPUT` 상수 자체·size-preset pill(`:403`)·프리셋 버튼은 리터럴 정당 보존·모드 라디오·stage 편집기 구조 보존 | |
| R10 | `MUST`(불변식) `LoadModelFields`/`ScheduleForm` **동작 byte-identical** — ScheduleForm은 입력 룩만 상속하고 검증·payload·state round-trip·사이징 헬퍼 게이트(`onApply*` optional prop)·라디오 accname·**추천 프레이밍 미렌더(R6 게이트)**는 무변경 | 기존 `LoadModelFields.test`·`ScheduleForm.test` 전부 통과(셀렉터 lockstep 외 로직 0-diff) | |
| R11 | `MUST` `Field`가 라벨↔컨트롤을 연결(`htmlFor`+`useId` `id`)해 `getByLabelText`가 해소되고, **에러 연결은 외부 `errorId`를 받을 수 있다**(자동 `useId` describedby만이 아님) — think-time min/max가 공유하는 단일 외부 `<p id="think-time-error">`와 `LoadModelFields`의 외부 에러 `<p>`(ramp-up/target-rps/max-in-flight/worker-count)·RunDialog의 http-timeout/loop-cap 에러 id를 **그대로 보존**. 기존 셀렉터(`ko.runDialog.env*Aria`·`loadPresetAria`·`presetNameAria`·radio accname "곡선" 정확매치)는 보존 또는 테스트 lockstep | 기존 라벨/aria/에러-id RTL 셀렉터 통과; 변경 라벨은 동반 수정(은퇴 리터럴 음수단언 금지=editor-ux-polish 함정) | |
| R12 | `MUST` 신규/변경 사용자 노출 문구(섹션 라벨·필수/선택/추천 배지·안내 문구·HelpTip 라벨·`aria-label`)는 전부 `ko.ts` 경유(ADR-0035). 인라인 영어/하드코딩 한국어 0 | `grep`로 만진 파일에 인라인 영어 라벨 0; `ko.runDialog.*`/`ko.common.*` 참조 | |
| R13 | `MUST` accent 드리프트 수렴 — 이번에 만지는 파일의 떠도는 `text-blue-600` 링크 등을 accent 토큰으로. **차트 stroke `#2563eb`·`StageCurvePreview` 곡선선·run-compare 팔레트(`runLabel.ts`)·`StatusBadge` running은 데이터-식별 색 도메인 → 손대지 않음** — 곡선 편집기 안에서 곡선*선*은 블루 유지·인접 컨트롤 링크는 indigo(데이터 vs 컨트롤 색 구분은 의도) | 만진 파일 blue→accent; 차트/compare/StatusBadge/`StageCurvePreview` stroke 0-diff(grep) | |
| R14 | `MUST`(불변식) 백엔드·proto·migration·`ui/src/api/schemas.ts`·리포트/run 파싱(Zod)·`buildProfile` 와이어 출력 **0-diff** — 순수 UI 표시/구조. diff는 `ui/src`(+`tailwind.config.ts`)·`docs`만 | `git diff --name-only`에 `crates/`·`*.proto`·`*.sql`·`schemas.ts` 부재 | |
| R15 | `SHOULD` a11y — accent 포커스 링 가시·배지/Callout 색 단독 금지(텍스트/아이콘 동반)·`Field` 에러 `aria-invalid`+`aria-describedby`(단일 입력=자동 `useId`, 공유/외부 에러=R11 외부 `errorId`)·`Section` 토글 `aria-expanded`·**collapsed-section `blockedReasons` 요약 경로 보존** | 프리미티브 단위 테스트 + `RunDialog.test` blockedReasons(접힘 시 invalid 사유 표시) 통과 + 라이브 키보드/포커스 | |
| R16 | `MUST` 라이브 검증 — 실제 run 1회 생성→리포트 진입·console Zod 0·키보드 포커스 링·추천값 그대로 즉시 실행. run-생성 경로 대규모 리팩터의 회귀 방지(payload byte-identical이라 스키마 갭 아닌 *리팩터 회귀*가 표적) | `/live-verify`(워크트리 자체 바이너리 + Playwright) | ✅(run 생성 경로) |

- **seam**: 와이어 계약 변경 없음 — R14가 "0-diff/byte-identical" 불변식을 명시 소유. R16은 계약이 아니라 리팩터 회귀를 라이브로 닫는다.

---

## 3. 핵심 통찰 (설계 근거)

1. **토큰은 신규가 아니라 *드리프트 수렴*이다**(R1·R3·R13). 앱은 이미 `indigo-600`을 사실상 accent로 쓰지만(사이징 헬퍼 "적용"·compare 버튼·활성 필터 칩·`if` 노드) `text-blue-600` 링크·`bg-blue-200` 배지가 섞여 있다. accent를 `indigo`로 *이름 붙여* 못박으면 새 색을 들이는 게 아니라 기존 드리프트를 닫는 것이다. 단 **차트 stroke·compare 팔레트·`StatusBadge`는 의미가 다른 별 도메인**(데이터 식별 색)이라 손대지 않는다(R13).
2. **프리미티브는 "작지만 진짜"여야 향후 확장의 출발점이 된다**(R2). Field/Input/Select/Section/Callout/Badge 6종이면 RunDialog 트리를 덮고, 동시에 폼이 있는 어느 화면에도 재사용 가능하다. `ui/src/components/ui/`에 모아 "디자인 시스템 홈"을 만든다(기존 `Button`/`Modal`/`HelpTip`는 이번엔 제자리 유지 — 폴더 통합은 §7로 연기해 diff를 가둔다). 프리미티브는 **다운로드/검증 같은 도메인 로직을 모름**(순수 UI) — C-1의 `DownloadMenu`가 메뉴 동작만 캡슐화한 것과 동일 정신.
3. **재구성의 안전선은 "표현만 바꾸고 로직은 안 건드린다"**(R4·R10). `buildProfile`/`loadModelErrors`/`canSubmit`/`deriveLoadMode`/cross-field 효과는 **0-diff**. RunDialog/LoadModelFields는 *JSX 마크업*만 프리미티브로 교체한다. 페이로드·검증이 불변이므로 **기존 RunDialog/LoadModelFields/ScheduleForm 테스트가 곧 회귀 가드**다 — 셀렉터(라벨/role/aria)만 lockstep으로 따라간다.
4. **`getByLabelText`/aria 셀렉터가 최대 함정**(R11). 현재 입력은 wrapping `<label><span>…</span><input></label>`(암시적 연결)과 `aria-label` 두 방식이 섞여 있다. `Field`는 `htmlFor`+`useId` `id`로 명시 연결해 `getByLabelText`를 보존하되, `EnvironmentPicker`의 `aria-label`(`ko.runDialog.env*Aria`)·라디오 accname("곡선" 정확매치, HelpTip을 label *밖* 형제로) 같은 기존 계약은 그대로 둔다. 라벨 텍스트를 바꾸는 경우(예: `groupAdvanced` "판정·고급 (선택)"→배지로 분리된 "판정·고급")는 **그 테스트를 동반 수정**하고, 은퇴 라벨의 *부재*가 아니라 살아있는 라벨의 *유일성*으로 단언한다(editor-ux-polish grep-0 모순 함정).
5. **추천 기본값은 숫자가 아니라 프레이밍이다**(R6). 현재 기본값(vus=2·duration=5·target_rps=100·max_in_flight=200·worker=1·timeout=30)을 **그대로 두고**(R4 byte-identical), `추천` 배지 + "바로 실행 가능" 안내로 *심적 허들만* 낮춘다. 데이터 기반 추천은 이미 사이징 헬퍼(`VuSizingHelper`/`SlotSizingHelper`/`WorkerSizingHelper`)가 제공하므로 중복 구축하지 않는다.
6. **전문 용어 HelpTip은 대부분 이미 배선돼 있다 — 검증·보존이 주, 신규는 1곳**(R7). 렌더 트리는 이미 11개 HelpTip을 노출한다(RunDialog: slo·thinkTime / `LoadModelFields`: closedLoop·openLoop·vuCurve·rampDown·vu·rampUp·maxInFlight·workerCount·rps). 따라서 R7은 *재구성 중 이들을 잃지 않게 보존* + **유일 공백인 지속시간(duration) 1곳 추가**다. duration만 `ko.glossary`에 없으므로 **신규 글로서리 1건(`ko.glossary.duration`)** 추가 — 그 외는 재사용. (기존 HelpTip `label` aria 텍스트의 ko.ts 이주는 byte-identical 유지 위해 이번 범위 밖 — §7.)
7. **RunDialog는 Modal이 아니라 인라인 패널**(`ScenarioRunsPage`의 `<div className="mb-6">`). 따라서 `Modal` capture-phase ESC ↔ HelpTip bubble-phase ESC 레이어링 함정(`ui/CLAUDE.md` U1a)이 **없다** — HelpTip을 자유롭게 배선 가능. 단 HelpTip 버튼을 `Section` 헤더 heading/legend *안*에 넣으면 accessible name이 오염되므로 헤더 텍스트의 형제로 배치(U3 패턴).
8. **앱 전역 Button accent는 작지만 가시적**(R3). `Button.tsx` `primary` 클래스 한 줄 변경이라 diff·위험은 작고 동작 변화 0이지만, primary 버튼을 쓰는 모든 화면 색이 바뀐다(통일감 ↑). 사용자 승인 사항(2026-06-27 — "앱 전역으로 가자").

---

## 4. 변경 상세

> 각 묶음 머리에 **충족 R** 태그. 전부 `ui/`(+`tailwind.config.ts`)·`docs/` 범위.

### 4.1 토큰 — `tailwind.config.ts` — 충족 R: `R1`
`theme.extend`에 시맨틱 별칭을 추가(예: `colors.accent` = indigo 스케일 매핑, `borderRadius`/포커스 ring 토큰). 오프라인 제약 유지(원격 폰트 금지). 토큰은 Tailwind 스케일 위 *별칭*이라 클래스 산출만 늘 뿐 런타임 무변화.

### 4.2 프리미티브 셋 — `ui/src/components/ui/{Field,Input,Select,Section,Callout,Badge}.tsx` (+`__tests__`) — 충족 R: `R2, R11, R15`
- **`Field`**: `{ label, htmlFor?, hint?, error?, help?(ReactNode), recommended?(boolean|string), required?/optional? , children }` → 라벨 + 컨트롤 슬롯 + 힌트/에러(`aria-invalid`/`aria-describedby` 자동) + 선택적 HelpTip + 추천 Badge.
- **`Input`/`Select`**: 토큰화된 컨트롤(포커스 링=accent·`rounded-md`·`aria-invalid` 스타일). `forwardRef`·표준 HTML 속성 패스스루.
- **`Section`**: `{ index?, title, status?: "required"|"optional", collapsible?, open?, onToggle?, hint? }` → 번호 배지 + 제목 + 필수/선택 Badge + 선택적 접힘(`aria-expanded`). 기존 fieldset/legend 대체.
- **`Callout`**: `{ variant: "info"|"warn"|"error", role?, title?, children }` → 토큰화된 박스(amber/red/indigo soft). `role`은 호출자가 지정(alert/status/alertdialog 보존).
- **`Badge`**: `{ tone: "neutral"|"accent"|"warn"|... , children }` — 색 단독 금지(텍스트 동반).

### 4.3 Button accent — `ui/src/components/Button.tsx` — 충족 R: `R3`
`STYLES.primary`만 `bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300`로. `secondary`/`danger`/레이아웃 클래스/시그니처 무변경.

### 4.4 RunDialog 재구성 — `ui/src/components/RunDialog.tsx` — 충족 R: `R4, R5, R6, R7, R8, R9, R11, R12, R13`
- 3개 `<fieldset><legend>` → `Section`(번호·필수/선택 배지·기존 접힘 동작 유지). `groupAdvanced` 텍스트에서 "(선택)" 제거(배지로 이관·테스트 lockstep).
- 부하 섹션 상단(**RunDialog 소유 마크업**)에 추천 안내 한 줄 + 필수 입력 옆 `추천` Badge는 `LoadModelFields`의 RunDialog-전용 prop로 게이트(R6 — ScheduleForm 미렌더).
- 자체 입력(think-time·http_timeout·loop_cap·preset 이름) → `Field`+`Input`. think-time min/max는 단일 외부 `<p id="think-time-error">` 공유 유지(`Field`에 외부 `errorId` 전달, R11). 용어 필드 HelpTip은 보존(R7 — 신규는 duration).
- ad-hoc 경고/오류/다이얼로그 박스 → `Callout`(role 보존; **mutation 오류는 `role="alert"` 신규 부여**, R8). 프리셋/제출 버튼 행은 `Button`(accent 자동). collapsed-section `blockedReasons` 경로 보존(R15).
- 떠도는 blue 링크·인라인 영어 → accent/ko(R12·R13). **로직(buildProfile·canSubmit·loadState·핸들러)은 0-diff**(R4).

### 4.5 공유 하위 컴포넌트 — `LoadModelFields.tsx`(+`CriteriaFields`/`StepCriteriaFields`/`EnvironmentPicker` 입력) — 충족 R: `R6, R9, R10, R13`
- 공유 `INPUT` 상수(`:56` `rounded`→`rounded-md` 토큰)를 정합해 모든 소비 입력(stage 편집기 포함)의 radius/포커스를 통일. 개별 입력은 `Field`/`Input`/`Select`로.
- 모드 라디오·stage 편집기·사이징 헬퍼는 **구조 무재작성**(accname·게이트·payload 무변경, R10).
- 추천 `Badge`는 **RunDialog-전용 optional prop**로 게이트(prop 부재 → ScheduleForm 미렌더, R6). 기존 HelpTip 9개 보존.

### 4.6 문구 — `ui/src/i18n/ko.ts` — 충족 R: `R7, R12`
`ko.runDialog`에 섹션 라벨/추천 안내/필수·선택·추천 배지 키 추가(공용이면 `ko.common`). 글로서리는 거의 재사용 — **신규는 `ko.glossary.duration` 1건**(유일 공백).

---

## 5. 무변경 / 불변식 (명시)

- **백엔드·proto·migration·`schemas.ts`·Zod 파싱·`buildProfile` 와이어 출력**: 0-diff(R14). run 생성 페이로드·검증 byte-identical.
- **`buildProfile`/`profileForm.ts`/`loadModel.ts`/`sizing.ts`/`openLoopChecks.ts` 로직**: 0-diff(R4) — 마크업만 교체.
- **`ScheduleForm` 동작/payload/state round-trip**: 0-diff(R10) — 입력 룩만 상속.
- **차트 stroke `#2563eb`·`StageCurvePreview` 곡선선·`runLabel.ts` compare 팔레트·`StatusBadge`**: 0-diff(R13) — 데이터-식별 색 도메인.
- **기존 `Button` secondary/danger·`Modal`·`HelpTip`**: 시그니처/동작 무변경(HelpTip은 소비만 늘림; 기존 HelpTip `label` aria 텍스트도 byte-identical).
- **사이징 헬퍼 게이트(`onApply*` optional prop)·prefill reseed-by-key·pool 409 clamp/force 분기**: 동작 보존.
- **ScheduleForm**: 추천/바로실행 프레이밍 미렌더(R6 게이트)·payload/검증/state round-trip 0-diff(R10).
- **collapsed-section `blockedReasons` 요약 경로**(접힘 시 invalid 사유 표면화): 동작 보존(R15) — 외부 에러 id 보존(R11)이 전제.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | `tailwind.config.ts` 토큰 정의 리뷰 + 프리미티브가 토큰 클래스 사용 | |
| R2 | `ui/src/components/ui/__tests__/{Field,Input,Select,Section,Callout,Badge}.test.tsx` | |
| R3 | `Button.test`(primary=indigo·secondary/danger 0-diff) | |
| R4 | `RunDialog.test`(payload·canSubmit disable·프리셋 load·409 clamp/force) 통과·`buildProfile` 0-diff | |
| R5 | `RunDialog.test`(3섹션·접힘 토글·"N개 설정됨"·자동 펼침) | |
| R6 | `RunDialog.test`(추천 배지·안내 문구) + 기본 profile 불변 | |
| R7 | `RunDialog`/`LoadModelFields.test`(HelpTip 존재·`ko.glossary` 참조) | |
| R8 | `RunDialog.test`(role=alert[드리프트·preset]/status/alertdialog·clamp/force payload·mutation 오류 role=alert 신규) | |
| R9 | raw 입력 잔존 grep + 리뷰 | |
| R10 | `LoadModelFields.test`·`ScheduleForm.test` 전부 통과 | |
| R11 | 기존 라벨/aria 셀렉터 통과·변경분 lockstep | |
| R12 | `grep` 인라인 영어 0·ko 참조 | |
| R13 | 만진 파일 blue→accent·차트/compare/StatusBadge 0-diff grep | |
| R14 | `git diff --name-only`(ui/docs/tailwind만) | |
| R15 | 프리미티브 단위 a11y + 라이브 키보드/포커스 | ✅ |
| R16 | `/live-verify`: 실 run 1회 생성→리포트·console Zod 0·포커스 링·추천값 즉시 실행 | ✅ |

- **라이브 검증 필수**(R16): RunDialog는 run-생성 경로. payload byte-identical이라 *스키마 갭*이 아니라 *리팩터 회귀*가 표적 — 머지 전 실 run 1회. 워크트리 자체 바이너리 + Playwright 헤드리스(`/live-verify`).

---

## 7. 의도적 연기 (roadmap §B12 "디자인 시스템 확장" 신규 절에 누적)

- **다른 화면 토큰 이주**(리포트·에디터/Inspector·목록·설정): 이번은 RunDialog 트리만. 차츰 같은 프리미티브로 확장.
- **차트/compare 색 토큰화**: 데이터 식별 색은 별 도메인, 별도 검토.
- **간단/상세 모드 토글·단계별 마법사**: 구조 A로 충분 — B/C는 효과 확인 후 재검토(사용자: "개선해보고 나서 추가 검토").
- **기존 프리미티브(`Button`/`Modal`/`HelpTip`) `ui/` 폴더 통합**: import 경로 churn이 커서 분리 — 후속 정리 슬라이스.
- **기존 HelpTip `label` aria 텍스트 ko.ts 이주**(현재 "VU 설명" 등 하드코딩): byte-identical 유지 위해 이번 미이주 — ADR-0035 전수 정리 시.
- **기본값 숫자 재검토**(추천값을 더 의미있는 부하로): 이번은 byte-identical 유지, 별도 논의.

---

## 8. 구현 순서 (plan 입력)

> 전부 `ui/`(+`tailwind.config.ts`) — cargo 게이트 비대상(UI 게이트 `pnpm lint && pnpm test && pnpm build`만). 프리미티브는 **각 컴포넌트+테스트를 한 green 커밋**으로(tdd-guard: 테스트 파일 먼저 pending diff). **plan은 2단계** — Phase A(파운데이션, RunDialog 무위험)를 먼저 끝내 견고화한 뒤 Phase B(소비, byte-identical/두-소비자 위험)로. 단일 슬라이스·단일 머지.

**Phase A — 파운데이션 (RunDialog 무위험·독립 검증)**
1. 토큰(`tailwind.config.ts`).
2. 프리미티브 셋(Field/Input/Select/Section/Callout/Badge) + 각 단위 테스트(`ui/src/components/ui/__tests__/`) — Field 외부 `errorId` 계약·Section `aria-expanded`·Callout role·Badge 색+텍스트 포함.
3. `Button.primary` accent 전환 + **신규 `Button.test`**(primary=indigo·secondary/danger 0-diff).

**Phase B — 소비 (byte-identical·lockstep)**
4. RunDialog 재구성 — Section/Field/Callout 적용·추천 안내(RunDialog 소유)·duration HelpTip·mutation `role=alert`·blue→accent·ko 문구. 기존 RunDialog 테스트 셀렉터 lockstep. RunDialog 마크업 교체 커밋마다 **그 파일 + 의존 테스트 GREEN**.
5. 공유 `LoadModelFields`(+하위 입력) `INPUT` 상수 토큰화 + 추천 Badge RunDialog-전용 prop 게이트 — **LoadModelFields/ScheduleForm 테스트 GREEN 유지**(R10).
6. 전체 UI 게이트(`pnpm lint && pnpm test && pnpm build`) + 라이브 검증(R16) + grep 불변식(R12·R13·R14).
7. ADR-0043 작성 + roadmap **§B12**(디자인 시스템 확장 신규 절) 연기 적재 + 상태줄.

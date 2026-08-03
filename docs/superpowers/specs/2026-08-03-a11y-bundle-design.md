# a11y 소형 묶음 (a11y-bundle) — 설계

- **날짜**: 2026-08-03
- **유형**: user-path (스크린리더·저시력 사용자 경로) — UI-only, 엔진/proto/컨트롤러/migration 0-diff
- **출처**: 의도적 연기 4곳 — roadmap.md `rundialog-hint-sr 연기 항목`(A1·A2), roadmap.md `editor-viewport-polish-v2 연기 항목`(B), roadmap.md:91 U4 연기 블록(C1·C2), release-hygiene 연기 ④(D — 포인터 roadmap.md:407, 원문 `docs/build-log.md:516`)
- **사용자 결정(브레인스토밍)**: 4묶음 전부 포함(A+B+C+D) · C2=배지 3종 h2 밖 형제 배치 · D 대비=slate-500(배지 1곳만, slate-400 토큰 전역 무변경)

## 사용자 스토리 (US)

- **US1**: QA가 스크린리더로 run 폼(RunDialog·ScheduleForm)의 think time·동시 요청 상한을 설정하는 상황에서, 시각 사용자가 보는 힌트를 동일하게 들으려 한다 — 성공하면 think min/max 포커스 시 "min=max면 고정 지연" 힌트가 description으로 낭독되고(현재 0회), invalid 시 에러가 먼저 오되 힌트가 소거되지 않으며, maxInFlight는 라벨 "동시 요청 상한"이 정확히 1회만 낭독된다(현재 라벨+힌트 선두에서 2회).
- **US2**: QA가 스크린리더로 에디터 헤더 접기 토글에 포커스한 상황에서, 이 버튼이 무엇을 접는지 알려 한다 — 성공하면 펼침 상태의 접근성 트리에서 `aria-controls`가 접히는 두 영역(브레드크럼·부제 줄)을 가리킨다(접힘 상태는 영역 언마운트라 참조 없음).
- **US3**: QA가 스크린리더로 시나리오 검증 배너를 읽는 상황에서, 무슨 문제인지 맥락을 먼저 들으려 한다 — 성공하면 낭독 순서가 제목 → intro(맥락) → 액션 버튼이 된다(현재 버튼이 intro보다 먼저; 시각 배치는 버튼 우상단 유지).
- **US4**: QA가 스크린리더로 run 상세 heading을 탐색하는 상황에서, FAIL 사유 popover를 열어도 heading이 오염되지 않아야 한다 — 성공하면 h2 접근명이 heading 텍스트+식별자만으로 유지되고(실측 "실행 <id8>" — `ko.runDetail.heading`="실행"(ko.ts:1169), `#`은 브레드크럼 소관) 미달 기준 텍스트가 heading에 합류하지 않는다(배지 3종은 h2 밖 형제 — 시각 동일 한 줄).
- **US5**: 운영자가 저시력 또는 스크린리더로 헤더의 버전을 확인하는 상황에서 — 성공하면 배지 대비가 AA(≥4.5:1)를 충족하고(slate-400→slate-500), 접근명이 "컨트롤러 버전 v<버전>"으로 맥락을 포함한다(현재 맥락은 마우스 `title` 전용).

## 1. 범위 개요

7개 소항목을 6개 변경 단위로 (전부 `ui/src` 한정):

| 단위 | US | 파일 | 성격 |
|---|---|---|---|
| A1 think hint SR 연결 + ko 이전 | US1 | `components/RunDialog.tsx` · `i18n/ko.ts` | describedby 배선 + 카탈로그 이전 |
| A2 maxInFlightHint 선두 라벨 제거 | US1 | `i18n/ko.ts` | 카피 1줄 |
| B 접기 토글 aria-controls | US2 | `pages/ScenarioEditPage.tsx` | 조건부 id 참조 |
| C1 배너 낭독 순서 | US3 | `components/scenario/ValidationBanner.tsx` | DOM 재배치 |
| C2 배지 heading 밖 형제 | US4 | `pages/RunDetailPage.tsx` | DOM 재배치 |
| D 버전 배지 대비·접근명 | US5 | `components/Layout.tsx` | 색 1클래스 + sr-only 접두 |

## 2. 항목별 설계

### 2.1 A1 — RunDialog think hint SR 연결 (+ ko 카탈로그 이전)

**현재** (`ui/src/components/RunDialog.tsx`): think min/max Input의 `aria-describedby={thinkInvalid ? "think-time-error" : undefined}`(895·906) — valid 상태에선 describedby가 아예 없고, hint `<p>`(924, id 없음)는 에러와 **삼항 배타 렌더**(919–925)라 invalid 시 언마운트된다. hint 카피 `"min=max면 고정 지연"`은 ko 카탈로그 밖 **하드코딩 리터럴**(ADR-0035 위반 잔존 — `ko.editor.thinkHint`(674, Inspector용 `"min=max면 고정 지연 (요청 후 대기)"`)와 별개 문구).

**변경** — rundialog-hint-sr가 connect timeout에 확립한 패턴(947–962: `aria-describedby={invalid ? "connect-timeout-error " + hintId : hintId}`, 에러 `<p>`는 1003에 별도, hint 상시 렌더)과 동형으로:

1. `ko.loadModel.thinkHint: "min=max면 고정 지연"` 신설(문구 그대로 이전 — Inspector 키와 컨텍스트가 달라 별도 유지). `ko.loadModel`엔 `thinkHint` 키 부재 확인(충돌 없음).
2. `thinkHintId = useId()` — hint `<p id={thinkHintId}>`를 **상시 렌더**로 삼항 해체. 에러 `<p id="think-time-error">`는 invalid 시 hint **앞**에 조건부 렌더(에러-먼저).
3. min/max 두 Input: `aria-describedby={thinkInvalid ? `think-time-error ${thinkHintId}` : thinkHintId}`. seed Input(910–917)은 무변경(힌트가 min=max 언급이라 min/max 소관).
4. **기존 테스트 동반 갱신**: `RunDialog.test.tsx:1170–1190` "links the Pacing error to the think inputs…"가 invalid describedby를 정확값 `"think-time-error"`로 단언(×2, 1181–1188) — A1 후 값이 `"think-time-error <hintId>"`가 되어 둘 다 실패하므로 갱신(hintId는 useId 동적 → 실제 hint 요소의 id를 읽어 조립하거나 `/^think-time-error /` 정규 단언).

**시각 delta(의도)**: invalid 상태에서 에러 아래 힌트가 함께 보인다 — connect timeout이 이미 확립한 표시 방식과 일치(비소거 원칙).

### 2.2 A2 — maxInFlightHint 선두 라벨 문구 제거

**현재** (`ui/src/i18n/ko.ts:195–196`): `maxInFlightHint: "동시 요청 상한 — 서비스가 목표 속도를 못 따라가면 초과분은 drop되어 리포트에 표시됩니다"` — 라벨 `maxInFlight: "동시 요청 상한"`(194)과 선두 중복이라 SR이 라벨→description 순서로 같은 문구를 두 번 읽는다.

**변경**: 선두 `"동시 요청 상한 — "` 제거 → `"서비스가 목표 속도를 못 따라가면 초과분은 drop되어 리포트에 표시됩니다"`. 소비처 전수는 **이중 grep**(키 이름 + 카피 리터럴 — 키 grep만으론 리터럴 참조를 구조적으로 못 본다):

- 키 참조(`grep -rn "maxInFlightHint" ui/src`): `LoadModelFields.tsx`(125·672·673·685·686 — 렌더 1곳+id 배선, **양 폼 공용이라 RunDialog·ScheduleForm 자동 적용**)·테스트 3곳(`RunDialog.test.tsx:1329`·`LoadModelFields.test.tsx:602`·`ScheduleForm.test.tsx:336` — ko 키 참조라 자동 추종).
- 카피 리터럴 참조(`grep -rn "동시 요청 상한" ui/src`, ko.ts 제외): hint 카피의 **선두+` — `를 참조하는 곳은 `RunDialog.test.tsx:1508`**(`getByText(/동시 요청 상한 — /)`) **1건 — A2에서 갱신 필수**(옛 roadmap 서술 "전부 ko 키 참조라 자동 추종"은 이 리터럴을 놓친 거짓 전수였다). 판정 기준은 기계적 — **매치 중 ` — `를 포함하는 것만 hint 카피 참조**이고, 그 기준으로 1508 유일. 나머지 매치는 전부 라벨 정규식 쿼리·다른 키의 카피·테스트 제목 문자열이라 A2 무영향.

### 2.3 B — 에디터 헤더 접기 토글 `aria-controls`

**현재** (`ui/src/pages/ScenarioEditPage.tsx`): 접기 버튼(166–174)에 `aria-expanded={!chromeCollapsed}`(169)만 있고 `aria-controls` 없음. 접히는 영역은 비인접 2곳 — 브레드크럼(161–163)·부제 `<p>`(207–212), 둘 다 `{!chromeCollapsed && …}` **언마운트** 조건부. 이 토글은 `/scenarios/{id}`에만 존재(`chromeCollapsed` 참조는 3파일 — `ScenarioEditPage.tsx`·`EditorShell.tsx`·`EditorShell.test.tsx`; ScenarioNewPage 무관).

**변경**: `useId` 2개(브레드크럼용·부제용). 브레드크럼은 조건부 렌더 wrapper `<div id={…}>`(또는 Breadcrumb id passthrough — plan 재량, 레이아웃 중립 확인 필수), 부제 `<p>`는 직접 `id`. 버튼에 `aria-controls={chromeCollapsed ? undefined : `${bcId} ${subId}`}` — **접힘 시 참조 대상이 언마운트되므로 속성도 제거**(레포 선례: `VerdictBadge.tsx:34–35` `aria-controls={open ? id : undefined}`). `aria-controls`는 ID 참조 *리스트*라 2개 유효. DOM 재구성(두 영역 병합) 불필요 — roadmap이 우려한 "단일 id 부여에 DOM 재구성"은 다중 참조로 회피.

### 2.4 C1 — ValidationBanner 낭독 순서

**현재** (`ui/src/components/scenario/ValidationBanner.tsx`): DOM 순서 = 제목 `<p>`(26) → 액션 버튼(27–36, 제목과 같은 `justify-between` 행 우측) → intro `<p>`(37) → editBlocked `<p>`(38–40) → 목록 `<ul>`(41–) — SR이 맥락(intro) 전에 액션 버튼을 만난다.

**변경**: intro·editBlocked를 제목과 같은 **왼쪽 열**로 이동 — `<div flex justify-between><div className="min-w-0">제목+intro+editBlocked</div><button className="shrink-0 self-start">…</button></div>` → 낭독/포커스 순서 = 제목 → intro → editBlocked → 버튼 → 목록. 버튼은 `self-start`로 우상단 시각 위치 유지. 마운트 표면: `EditorShell.tsx:133` 1곳이지만 EditorShell은 `/scenarios/new`·`/scenarios/{id}` 양 페이지가 사용 — 라이브는 두 진입 화면 모두 확인([[live-verify-all-mount-paths]]).

**시각 delta(의도)**: intro가 full-width에서 좌열 폭(버튼 폭만큼 축소)으로 — 긴 intro의 줄바꿈 지점 변화 가능. 허용(폭 축소는 버튼 hasGate 시에만).

### 2.5 C2 — run 상세 배지 3종 heading 밖 형제 배치

**현재** (`ui/src/pages/RunDetailPage.tsx:133–139`): `<h2>`가 heading 텍스트+`<id8>` span+`StatusBadge`+`VerdictBadge`+`ValidityBadge`를 모두 포함. `VerdictBadge`의 FAIL popover(`components/VerdictBadge.tsx` — `usePopover`, badge `<span>` 서브트리 안에 절대배치 `role="note"`)가 열리는 동안 미달 기준 텍스트가 h2 **접근명에 일시 합류**한다. `ValidityBadge`(button/usePopover/aria-expanded 0건)·`StatusBadge`(정적 span)는 비인터랙티브지만, 배지 3종을 함께 옮겨 heading을 항구적으로 간결화한다(사용자 결정).

**변경**: h2는 heading 텍스트+`<id8>` span만 유지, 배지 3종은 h2의 **형제**로 — 기존 h2의 `flex items-center gap-3`을 감싸는 wrapper로 올려 시각 동일 한 줄 유지:

```tsx
<div className="flex items-center gap-3">
  <h2 className="text-xl font-semibold flex items-center gap-3">
    {ko.runDetail.heading}{" "}
    <span className="font-mono text-base text-slate-600">{r.id.slice(0, 8)}</span>
  </h2>
  <StatusBadge status={r.status} />
  <VerdictBadge verdict={report.data?.verdict} />
  <ValidityBadge validity={report.data?.validity} />
</div>
```

`VerdictBadge`/`usePopover` 컴포넌트 자체는 **0-diff**(다른 소비처 `ScenarioRunsPage`·`ScheduleEventTimeline` 무영향 — VerdictBadge의 조건부 `aria-controls`는 34). h2 접근명이 배지 텍스트를 항구적으로 잃는 것은 **의도된 개선**(heading 간결화) — **기존 테스트 갱신 0 확정**: `RunDetailPage.test.tsx`의 heading 쿼리 콜사이트 8곳 전부 name이 `/메트릭 윈도우/`(7곳, level 미지정) 또는 `profileTitle`(933, level 3)라 h2 접근명("실행 <id8>")과 무매치(C2 후에도 무매치), verdict 배지 문구(`verdictFail`/`verdictPass`) 참조 0건.

### 2.6 D — 헤더 버전 배지 대비·접근명

**현재** (`ui/src/components/Layout.tsx:16`): `<span className="text-xs text-slate-400" title={ko.common.versionTitle}>v{…}</span>` — ① 12px `text-slate-400` on-white 대비 ~2.6:1 < AA 4.5:1 ② 맥락("컨트롤러 버전")이 마우스 전용 `title`뿐.

**변경**:
1. `text-slate-400` → `text-slate-500`(~4.8:1, AA 통과 — **이 배지 1곳만**, slate-400 토큰 전역 무변경. 사용자 결정).
2. 접근명에 맥락 포함 — **`aria-label` 금지**(generic `<span>`은 naming prohibited라 AT가 무시) → **sr-only 접두 텍스트**: `<span className="sr-only">{ko.common.versionTitle} </span>v{…}` → SR 낭독 "컨트롤러 버전 v0.7.0". `title`은 존치(마우스 툴팁).
3. 기존 테스트 확인 대상 2곳(`Layout.test.tsx:52–53·61`), **실질 갱신은 53 한 곳**: `getByTitle` 쿼리(52·61)는 title 존치라 유지, 53의 anchored `toHaveTextContent(/^v9\.9\.9$/)`만 sr-only 접두("컨트롤러 버전 v9.9.9")로 깨짐 → 접두 포함 정규식(또는 접근명 단언)으로 갱신. 61(부재 케이스)은 무변경 통과.

## 3. 비목표

- **변수 팝오버 화살표키 내비/포커스 트랩** — a11y 심화 후속(editor-varpanel-viewport-polish 연기), 소형 묶음 범위 초과.
- **ScheduleForm hint 마크업 2형태 수렴**(Field 프리미티브 수렴 후속) — 이번엔 ScheduleForm 마크업 무접촉(A2는 ko.ts 카피만). 연기 메모의 "label-안 span accname 오염(U3 함정)" 주의는 그 후속의 것.
- **slate-400 토큰 전역 교체**(79회) — D는 배지 1곳만.
- **usePopover portal화** — C2는 배치 이동으로 해소, 공유 훅 무변경.
- **RunDialog think 에러 문구·검증 로직**(919–922) — 무변경(describedby 배선만).
- `RunDialog.test.tsx` describe 접두사 코스메틱(직전 슬라이스 잔여) — 이 묶음과 무관, 미포함.

## 4. 테스트 전략

전 항목 RTL 단위 테스트(jsdom) + 최종 `pnpm lint && pnpm test && pnpm build`(각각 `; echo exit=$?`로 종료코드 명시 캡처 — 파이프 금지). **회귀 가드 표방 테스트는 전부 고의 회귀→RED→원복→GREEN 실증 의무**([[plan-mandated-vacuous-tests]]).

| 단위 | 핵심 단언 (관찰 층위 = 접근성 속성/트리) |
|---|---|
| A1 | valid: min/max 둘 다 `aria-describedby`가 hint id 포함 + hint 텍스트 렌더. invalid: describedby가 `"think-time-error <hintId>"` **순서**(에러 먼저) + hint 비소거 + 에러 렌더 |
| A2 | `ko.loadModel.maxInFlightHint`가 `ko.loadModel.maxInFlight` 문구로 **시작하지 않음**(카탈로그 계약 단언 — 선두 복원 시 RED 실증 가능) + `RunDialog.test.tsx:1508`의 리터럴 정규식을 새 카피 기준으로 갱신 |
| B | 펼침: 토글 `aria-controls` 값이 **정확히 두 개의 id**임을 양성 단언 **선행** 후 각 id `getElementById` 실존 검사(`split(" ")` 루프 단독은 속성 부재/빈 값 시 0회 루프 공허 통과). 접힘: 속성 부재 + 두 영역 언마운트 |
| C1 | hasGate 배너에서 DOM 순서 제목→intro→버튼(compareDocumentPosition 또는 텍스트 순서) + 버튼 여전히 클릭 가능 |
| C2 | FAIL popover **열림 상태**에서 h2 accname에 미달 기준 문구 미포함 + 배지 3종 렌더 유지. (열림 전후 accname 동일 단언은 무이빨 주의 — 열림 상태에서 부정 단언이 이빨) |
| D | 배지 텍스트에 `versionTitle` 접두 포함(sr-only) + `text-slate-500` 클래스 + `title` 존치 |

**공허 함정 경계**: C2의 "popover 열기 전 accname 검사"는 배지를 h2에 되돌려도 통과한다(열기 전엔 원래 오염 없음) — 반드시 **열린 상태**에서 h2 accname 부정 단언이 이빨이다. A1의 "hint 텍스트 존재" 단독 단언도 describedby 배선을 끊어도 통과 — describedby 값 단언이 본체.

## 5. 라이브 검증 (US-anchored — UI-only이므로 Playwright 접근성 트리·computed style)

백엔드 무접촉이지만 run 상세(US4)는 FAIL verdict run이 필요 → `/live-verify` 스택(전용 포트)으로 SLO 미달 run 1개 생성.

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | RunDialog 열기 → **상세 모드 전환 → [판정·고급] 섹션 펼침**(think 입력은 `mode==="detailed"`(857) + Section 5 collapsible 안 — 기본 미노출) → closed-loop think min 포커스 / open-loop로 maxInFlight 포커스 | a11y 스냅샷에서 min/max description="min=max면 고정 지연"; invalid 입력 시 description 선두가 에러 문구+힌트 잔존; maxInFlight description이 "동시 요청 상한"으로 시작하지 않음 |
| US2 | `/scenarios/{id}` 토글 펼침/접힘 | 펼침: `aria-controls` 두 id 모두 `document.getElementById` 실존; 접힘: 속성 null |
| US3 | 게이트 문제 있는 시나리오로 배너 렌더(`/scenarios/new`·`/scenarios/{id}` **두 진입 화면**) | DOM 순서 제목→intro→버튼 + 버튼 `getBoundingClientRect` 우상단(제목 행과 y 겹침) |
| US4 | FAIL run 상세에서 FAIL 배지 클릭 | 열린 상태 h2 accname = "실행 <id8>"뿐(미달 기준 문구 부재), 시각 한 줄 유지(h2와 배지 y 겹침) |
| US5 | 헤더 배지 | `getComputedStyle` color가 slate-500(`rgb(100, 116, 139)`) + 접근명에 "컨트롤러 버전" 포함 |

## 6. 주의 함정 (도메인 CLAUDE.md·메모리)

- `Field` 동명 로컬 shadow 2곳(`Inspector.tsx:1436`·`ScenarioDefaults.tsx:10`)이 prop grep을 오염(rundialog-hint-sr 교훈) — Field 소비처 주장은 import 확인 후.
- U3 함정: label-안 텍스트는 accname에 합류 — C1 재배치 시 intro를 `<label>`류 안에 넣지 말 것(현재 구조엔 label 없음 — Callout `<div>`뿐).
- `pnpm build`(tsc -b)가 최종 게이트 — `pnpm test`는 TS strict 미적발 케이스 있음.
- `Layout.test.tsx`엔 `clearMocks`/`beforeEach` 부재 — **세 번째 케이스 추가 시 직전 `mockVersion` 상속**(build-log.md:516 ⑦가 예고한 발화 조건). D가 새 it를 추가하면 명시 mock 셋업 필수.
- 라이브 검증 포트: 8080 점유자 확인 후 전용 포트(직전 슬라이스 8095/8094 사용 — 새 세션은 재확인).

## 7. Claims ledger (spec 사실 주장 → 생성 명령; 디스패치 전 일괄 재실행)

작업 디렉토리 = 워크트리 `ui/src` (`cd …/a11y-bundle/ui/src`).

| 주장 | 명령 |
|---|---|
| think describedby 삼항·hint 리터럴 위치(895·906·919–925) | `grep -n 'think-time-error' components/RunDialog.tsx` · `sed -n '895,935p' components/RunDialog.tsx` |
| connect 확립 패턴(947–962·1003) | `grep -n "connectTimeoutHintId\|connect-timeout-error" components/RunDialog.tsx` |
| `ko.loadModel`에 `thinkHint` 부재·둘의 네임스페이스(187 loadModel·450 editor) | `awk '/^  [a-z][a-zA-Z]*: \{/{ns=NR": "$1} NR==674{print ns} NR==195{print ns}' i18n/ko.ts` · `sed -n '/^  loadModel: {/,/^  },/p' i18n/ko.ts \| grep thinkHint` |
| maxInFlightHint 키 참조 전수(프로덕션 LoadModelFields 1파일+테스트 3곳) | `grep -rn "maxInFlightHint" .` (ui/src 루트에서) |
| hint 카피 리터럴 참조 = `RunDialog.test.tsx:1508` 유일(라벨 정규식 다수는 무영향) | `grep -rn "동시 요청 상한" . \| grep -v "^./i18n/ko.ts"` — ` — ` 포함 매치만 hint 참조 |
| A1이 깨뜨리는 기존 describedby 정확값 단언(1181–1188 ×2) | `sed -n '1170,1190p' components/__tests__/RunDialog.test.tsx` |
| think 입력 도달 게이트(detailed 857 + Section 5 collapsible) | `sed -n '855,882p' components/RunDialog.tsx` |
| `ko.runDetail.heading`="실행"(1169) — US4 accname 실측 근거 | `grep -n "heading" i18n/ko.ts` |
| RunDetailPage.test에 h2 accname 배지 조회 부재(heading 쿼리 콜사이트 8곳 = /메트릭 윈도우/ 7 + profileTitle 1 — h2 접근명 무매치·verdict 문구 0건) | `grep -n "ByRole(\"heading\"" pages/__tests__/RunDetailPage.test.tsx` · `grep -c "verdictFail\|verdictPass" pages/__tests__/RunDetailPage.test.tsx` |
| ScheduleForm think UI 부재(DEFERRED) | `grep -n "think" components/ScheduleForm.tsx` |
| 접기 토글 aria-controls 부재·조건부 영역 2곳(161·207)·ScenarioNewPage 무관 | `grep -rn "chromeCollapsed\|aria-controls\|aria-expanded" components/scenario/EditorShell.tsx pages/ScenarioEditPage.tsx` + `grep -rln "chromeCollapsed" --include="*.tsx" .` |
| ValidationBanner DOM 순서·마운트 1곳(EditorShell:133, 양 페이지 사용) | `sed -n '1,80p' components/scenario/ValidationBanner.tsx` · `grep -rn "ValidationBanner" --include="*.tsx" .` · `grep -n "EditorShell" pages/ScenarioEditPage.tsx pages/ScenarioNewPage.tsx` |
| VerdictBadge popover가 h2 내부(133–139)·ValidityBadge/StatusBadge 비인터랙티브 | `sed -n '128,142p' pages/RunDetailPage.tsx` · `grep -n "button\|usePopover\|aria-expanded" components/ValidityBadge.tsx`(0건) · `sed -n '11,15p' components/StatusBadge.tsx` |
| 버전 배지 title-only·slate-400(Layout.tsx:16)·테스트 쿼리 2곳(52–53·61) | `grep -rn "versionTitle" --include="*.tsx" --include="*.ts" .` · `sed -n '48,64p' components/__tests__/Layout.test.tsx` |
| baseline 게이트 green(cargo workspace + pnpm lint/test) | `cargo build --workspace`(exit 0 확인) · `cd ui && pnpm lint; echo exit=$?` · `pnpm test 2>&1; echo exit=$?`(요약행 확인 — 판정에 파이프 금지) |

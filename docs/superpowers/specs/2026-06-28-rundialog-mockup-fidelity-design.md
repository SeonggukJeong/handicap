# RunDialog 목업 시각 충실도 + footer 부하-모양 시그니처 Design

## 목표

직전 슬라이스(`rundialog-simple-detailed`, 머지됨)가 RunDialog 간단/상세 모드를 **기능적으로** 구현했으나, **시각 충실도가 목업과 어긋난다**(특히 부하 모델 "타일"이 스타일 0의 텍스트라 선택 상태가 안 보임). 이 슬라이스는 **저장된 목업(인터랙티브 HTML + PNG 2장)을 시각 oracle로 삼아** RunDialog를 목업에 맞춘다(헤더·섹션/eyebrow·타일·프로파일·측정·footer 전부). + 사용자 추가 요구: **footer 부하-모양 미니그래프를 전 모드(고정 포함)** 에 표시("시그니처") — 이는 **의도적 mockup-초과 추가**(목업 footer는 곡선에만 그래프, §결정 3).

**불변 제약: payload byte-identical(R10) + ScheduleForm byte-identical(R12) + 기존 기능 전부 보존(목업이 일부 기능을 생략해 그렸을 뿐, 삭제 금지). 변경은 *오직 시각/표현*(className·요소·라벨 문구·footer 조각 구조).**

## 시각 oracle (정규 기준)

**1순위(authoritative) — 인터랙티브 HTML 목업** (brainstorm 세션 산출물, 트랜스크립트에서 복구·커밋):
- `docs/superpowers/mockups/rundialog-v3.html` — **최종/정답**(title "RunDialog v3 — 사이징 도우미 유지 · 측정 노출"). **브라우저로 열어(간단↔상세 토글) 전 디테일을 본다.** CSS 토큰·치수·`render()` 로직이 시각·텍스트의 단일 소스.
- `docs/superpowers/mockups/rundialog-v2.html`·`rundialog.html` — 이전 버전(참고).

보조 — PNG 캡처(둘 다 **open+fixed·100/300/200** 상태): `2026-06-28-rundialog-simple.png`·`-detailed.png`.

구현·검증 시 **v3 HTML을 열어 픽셀 대조**한다. (직전 슬라이스 빵꾸 원인 = ① 라이브 검증이 `role`/`aria-checked` 의미·구조만 보고 *시각*을 안 봄 ② 목업 HTML이 gitignored `.superpowers/brainstorm/`에만 있다 worktree 삭제로 소실 → PNG 일부 캡처로만 작업해 측정 섹션 등 디테일 놓침. **이번엔 HTML을 커밋해 durable + 스크린샷 대조가 acceptance.**) 교훈은 메모리 [[save-mockups-durably]].

### v3 HTML에서 읽어낸 정규 사실 (구현·리뷰가 대조할 oracle 사실)

- **헤더**: 제목 `실행 설정` + `간단/상세` 세그먼트 + ✕(모달 ✕는 비범위·결정 8).
- **상단 프리셋 로드 바**: `저장된 설정에서 시작` + `— 프리셋 불러오기 —` select (loadbar).
- **Section1 = 단일 eyebrow `부하 모델 [필수]`** → 타일 2개(좌 closed / 우 open) → (상세만) `프로파일` eyebrow + `고정/곡선` 세그먼트 → (closed+fixed) 프리셋 칩 + grid3(동시 사용자[추천]/시간(초)[추천]/램프업(초)ⓘ) + VU 도우미 disclosure → (open) grid3(목표 RPS[추천]/시간(초)[추천]/동시 요청 상한ⓘ) + (상세+open) `워커 수 (분산 실행)` disclosure → (간단만) `⚙ 상세 설정 N개 적용됨` 칩.
- **타일**(`.tile`): `border 1px hair2·radius 8·padding 11/12·flex gap10 items-start·bg #fff`. 좌측 `.dot`(15px 원·border 1.5px hair2). 선택(`.tile.sel`)=`border-color accent·bg accent-weak`, dot=`border accent` + `::after`(inset 3 채운 accent 원). 제목 `.tt`(weight 600·13.5px), 설명 `.td`(12px·t2·block). hover=`border #aeb8c8`. **타일 제목: closed `동시 사용자 (VU)` / open `목표 RPS`. 설명: closed `N명이 동시에 반복 요청` / open `초당 N건씩 도착`. 타일엔 ⓘ 없음**(현 라이브 per-tile HelpTip의 새 위치는 결정 7).
- **eyebrow**(`.eyebrow`): `10px·weight650·letter-spacing .15em·uppercase·color t3` + 배지(`.req`=accent-weak/accent-text `필수` · `.opt`=slate `선택`). 한국어는 uppercase 무효과 → 작은 spaced 라벨로 보임.
- **상세 섹션 순서**: `환경 [선택]`(select + 변수 오버라이드) → `데이터셋 바인딩 [선택]` → `부하 줄이는 방식 [선택]`(closed+curve만) → `측정 [선택]`(토글 카드) → `판정 · 고급` disclosure(SLO + 페이싱·진단) → `이 설정 저장 [선택]`(프리셋 저장 바).
- **측정 카드**(`.measure`): `border 1px hair2·radius 8·padding 12/14·flex gap12`. 좌측 `.sw`(38×22 pill·`#cbd5e1`, on=accent·knob 18px 슬라이드). 제목 `응답 시간 단계 분해`(weight600·13.5px) + 설명 `응답 시간을 DNS · 연결 · 대기 · 다운로드로 나눠 측정 — 리포트에서 "어디서 느린지" 진단` + ⓘ.
- **footer**(`.foot`): 좌측 `.bar`(3px 세로 accent bar·warn=amber) + `.spark`(곡선만 SVG, `#4f46e5`) + `.sumtext`(굵은 숫자 `b`) + `.sub`(11.5px·t3 회색). 우측 `실행하기`(primary accent) + `취소`(ghost). **`render()`: `spark.innerHTML=''` 후 `rate==='curve'`에서만 그래프 set → 고정 모드 footer엔 그래프 없음(= R5는 의도적 초과).**
- **footer 텍스트(굵게=`b`)**:
  - closed+fixed: `동시 사용자 «vus»명 · «time»` / sub `램프업 «n»초`|`램프업 없음`
  - open+fixed: `목표 «rps» RPS · 약 «total»건 · «time»` / sub `동시 요청 상한 «mif|—»`
  - curve: `최대 «peak»명 (곡선)`|`최대 «peak» RPS (곡선)` / sub `총 «total»초 · «n»단계`
  - invalid(warn): `설정을 확인하세요` / sub `동시 사용자·시간을 입력`|`목표 RPS·시간을 입력`

## 배경 / 왜 빵꾸났나

- 직전 슬라이스의 RTL·리뷰·라이브 검증은 전부 **의미/구조**(role=radio·aria-checked·payload byte-identical)만 확인. **타일이 시각적으로 선택돼 보이는지, 룩이 목업과 맞는지를 단언한 게이트가 없었다** + spec에 시각 목업이 임베드 안 돼 있어 diff 기준이 없었다.
- 현 `loadModelTiles` 타일 버튼 className = `flex flex-col items-start text-sm cursor-pointer`(`LoadModelFields.tsx:300,313`) — **테두리·배경·라디오 인디케이터·선택 강조가 전무**. `aria-checked`만 맞고 시각 선택 상태 0.
- 현 footer는 `sum.text` 단일 문자열(굵게 없음)을 렌더하고 `sum.curve`일 때만 `StageCurvePreview`를 보인다(`RunDialog.tsx:1035,1046`) — 목업의 굵은-숫자/회색-sub 2단 구조·고정 모드 모양 시그니처가 없다.

## 요구사항

| R | 요구 | 검증 |
|---|---|---|
| R1 | MUST: `loadModelTiles` 부하 모델을 **진짜 타일**로 (v3 `.tile`). 좌우 동일너비(2열 그리드 `1fr 1fr` 또는 `flex-1`)로 행을 채우는 테두리 박스(`rounded-lg border`), **라디오 ◉ 인디케이터**(작은 원·선택 시 accent 채움), 굵은 제목(`tt`) + 회색 설명(`td`, inline block). **선택(`aria-checked=true`)=accent 테두리 + 연한 accent 배경**(`border-accent-500 bg-accent-50`), 비선택=`border-slate-200 hover:border-slate-300`. `role=radio`/`aria-checked`/키보드 보존. **accent 토큰만**(ADR-0043·차트색 무관). | RTL: 선택 타일에 accent 클래스(`toHaveClass`) 존재·비선택 부재 + **teeth-check**(선택→비-accent 뒤집어 FAIL 확인) + 스크린샷 대조 |
| R2 | MUST: 타일 제목을 목업대로 — closed=**"동시 사용자 (VU)"**, open=**"목표 RPS"**. **신규 ko 키 `loadModel.tileClosedTitle`/`tileOpenTitle`** 로 추가 — 공유 `ko.loadModel.closedLoop`/`openLoop`(ScheduleForm 라디오·기타 소비처)는 **안 건드림**(R12·R16[직전 슬라이스 `rundialog-simple-detailed` = ko add-only/ADR-0035]). 설명(`tileClosedDesc`/`tileOpenDesc`)은 현행 유지(이미 목업 일치 — `ko.ts:170-171`). | 타일 접근명이 신규 라벨로 바뀐 RunDialog/LoadModelFields **타일** 셀렉터 갱신; ScheduleForm 라디오 셀렉터(`사용자 수 기준`) 불변 |
| R3 | MUST: 간단 모드 "⚙ 상세 설정 N개 적용됨"을 **N=0 포함 항상 보이는 칩**으로(칩 룩·클릭→상세 전환). 현 `mode==="simple" && detailedAppliedCount > 0` 조건(`RunDialog.tsx:888`) → `mode==="simple"`이면 항상 렌더. **count 계수식·`detailedAppliedCount` 0-diff**(F1 이중계수 함정 — 가시성만 바뀜). | RTL: 간단·기본(count 0)에서 칩 보임 + 클릭→`상세` aria-checked; count>0 표시 |
| R4 | MUST: 상세 프로파일 `고정/곡선` 토글(`LoadModelFields.tsx:358-390` 라디오·legend 360)을 **`Segmented`**(active=accent)로. **RunDialog 전용 게이트**(`loadModelTiles` 또는 신규 optional prop) — ScheduleForm은 라디오 유지(R12). `role=radio` 접근명 "고정"/"곡선" 보존(`Segmented`도 `role=radiogroup`+`role=radio aria-checked` — `Segmented.tsx:30,41-42`). HelpTip은 Segmented 밖 형제(U3). | RTL: RunDialog 상세 프로파일 Segmented + `getByRole("radio",{name:"곡선"})`(정확매치) 보존; ScheduleForm 라디오 불변 |
| R5 | MUST(**의도적 mockup-초과 추가**): footer 시그니처에 **전 (유효) 모드 부하-모양 미니그래프**. 고정(closed VU·open RPS)=**평평한 일정선**(duration 동안 일정 레벨), 곡선=stages 모양. **신규 장식 컴포넌트 `LoadShapePreview`** 신설(§결정 3) — `StageCurvePreview` 재사용 금지(`toControlPoints`가 `(0,0)` 시작 하드코딩이라 1-stage flat을 *대각 ramp*로 그림 + stroke가 `#2563eb`로 잠김). **invalid(warn)이면 미니그래프 생략**(목업도 고정/warn엔 spark 없음). 목업 footer는 곡선에만 그래프지만(R5=초과) 고정에도 flat 시그니처를 더한다 → R15 대조에서 "고정 footer 그래프"는 미스매치 아님(의도적 초과). | RTL: 고정 closed/open·곡선 모두 유효 시 footer에 모양 요소(`role=img`+`aria-label` svg·항상 announce) 렌더 + invalid엔 부재 + 스크린샷 |
| R6 | MUST: footer 텍스트 **2단 구조 + 핵심 숫자 굵게**(목업: 굵은 `sumtext` + 회색 `sub`). `runSummary`가 **구조화 조각** 반환 — `{ main: SummarySegment[]; sub: string; tone; curve }`(`SummarySegment={text:string; bold?:boolean}`). ko `summary*` (main)이 **세그먼트 배열** 반환(굵은 = 보간 숫자), `*Sub`는 회색 string. **신규 warn-sub 키**(closed/open) 추가(목업 warn sub). ADR-0035 준수(인라인 한국어 0·연결 텍스트도 ko). 실행 버튼 "실행"→**"실행하기"**. | RTL: footer main 굵은 세그먼트 + 회색 sub 렌더 + warn sub; 버튼 `getByRole("button",{name:"실행하기"})`; `runSummary.test.ts` 재작성; **기존 footer-요약 매처 재작성**(§test) |
| R8 | SHOULD: 헤더 제목 "새 실행"→**"실행 설정"**(`ko.runDialog.title:65`, 의도적 copy 변경). | RTL: 제목 텍스트 |
| R9 | MUST: **기존 기능 전부 보존** — VU/slot/worker 사이징 도우미, 측정, 판정·고급(SLO·페이싱·http_timeout·loop_cap), 프리셋 불러오기/저장/이름변경/삭제, 데이터셋 바인딩(다중 카드), R17(직전 슬라이스) 곡선 읽기전용 카드, blockedReasons, F1 measure 단일계수, prefill 상세예측(`opensDetailed`), **per-tile HelpTip**(결정 7). 목업이 생략해 그린 것일 뿐 삭제 금지. | 기존 RTL 전수 green(라벨/구조 변경분 갱신) |
| R10 | MUST: **payload byte-identical** — `buildProfile`/`buildLoadProfile`/`resolveEnv`/`canSubmit`/`deriveLoadMode`/`detailedAppliedCount`·`opensDetailed` *계수·판정식* 0-diff. 변경은 전부 시각/표현. `DEFAULT_SIMPLE_PROFILE` 골든 정확 `toEqual` 유지. **`runSummary`는 main/sub *조각*만 재구조화**(판정 로직=warn 게이트·곡선 분기 불변·display-only·`buildProfile` 미접촉). | 골든 `toEqual` green + `git diff` 로직식 0 |
| R11 | MUST: **진짜 wire는 0-diff** — `crates/**`·proto·migration·`ui/src/api/schemas.ts` 0-diff. `ko.ts`는 **신규 키(tile-title 2·warn-sub 2·eyebrow 라벨) + 의도적 copy 변경(title/run/summary-조각)** 만 — 기존 *공유* 키(`closedLoop`/`openLoop`·`tileClosedDesc`/`tileOpenDesc`)는 불변. (구 R11의 "ko grep-0"은 폐기 — title/run/summary copy를 *의도적으로* 바꾸므로.) `SummarySegment`는 ko/runSummary 로컬 TS 타입(schemas.ts 미접촉). | grep: `crates`/proto/migration/schemas.ts 0-diff; ko 기존 공유 키 불변 |
| R12 | MUST(**wire byte-identical**): 공유 컴포넌트(`LoadModelFields`·`EnvironmentPicker`·`Input`)의 RunDialog-전용 확장은 **전부 additive optional prop**(미전달 호출부=ScheduleForm byte-identical·직전 슬라이스 게이트 패턴). `ScheduleForm`은 `loadModelTiles`/신규 prop 미전달(`ScheduleForm.tsx:307`) → 라디오·룩·payload 0-diff. | RTL: ScheduleForm 미전달 prop = 라디오 유지·byte-identical; `ScheduleForm.test.tsx:103` 라디오 셀렉터 불변 |
| R13 | MUST: 측정(응답 시간 단계 분해)을 **체크박스가 아니라 토글-스위치 카드**로(v3 `.measure`) — 테두리 카드(`rounded border p-3`) + **큰 토글 스위치**(≈38×22 pill·on=accent·knob 슬라이드) + 굵은 제목 "응답 시간 단계 분해" + 설명 "응답 시간을 DNS · 연결 · 대기 · 다운로드로 나눠 측정 — 리포트에서 '어디서 느린지' 진단" + ⓘ. **`role="switch"` + `aria-checked`로 핀**(토글의 정확 semantic). **토글 on/off ↔ `measure_phases` payload 매핑은 현 로직 유지(byte-identical)**, 시각/role만 변경. 기존 입력의 접근명 보존. **`RunDialog.test.tsx:1855` `getByRole("checkbox",{name:/응답 시간 단계 분해/})` → `getByRole("switch",…)` 갱신**. | RTL: 측정 토글(role=switch+aria-checked)·on→`measure_phases:true` 골든 + 스크린샷 |
| R14 | MUST(**전체 충실도, §스코프 결정 — 사용자 2026-06-28: 번호 `Section` 유지**): 섹션 재구성 — 기존 번호 `Section`(ADR-0043·`index` 원형 ①②③)을 **유지**하고 mockup #6 항목을 *번호 Section으로* 추가/분리(번호는 1..N 재시퀀스 — 목업 무번호와는 **의도적 차이**, 사용자 수용·R15 미스매치 아님). 각 Section은 기존 `eyebrowCls` 타이틀(`RunDialog.tsx:532`) + `Badge`(이미 eyebrow 스타일). ① **부하 모델 단일 헤더**: Section1 타이틀 `부하 정의`(`ko.ts:70 sectionLoadTitle`)→**`부하 모델`** 리타이틀(번호 ① 유지·[필수]) + 안쪽 LoadModelFields `<legend>부하 모델`(`:288`)을 **`sr-only`**(시각 중복 제거·fieldset 접근명/`tagName==="FIELDSET"` 보존 → `LoadModelFields.test.tsx:414-420` `getByRole("group",{name:/부하 모델/i})` green; sr-only legend도 텍스트 보유라 접근명 유지). ② **환경/데이터셋 분리**(구 R7 흡수): Section2 `대상 설정`(`:674-697`)을 **환경 Section** + **데이터셋 바인딩 Section** 둘로(둘 다 [선택]). ③ **측정 Section**(현 bare `<div>` `:824-838` → 번호 Section). ④ **이 설정 저장 Section**(현 bare 프리셋 블록 → 번호 Section). ⑤ **프로파일 eyebrow**: LoadModelFields `<legend>프로파일`(`:360`)을 `eyebrowCls` sub-eyebrow로(번호 없음·Section1 내부 — 기존 SLO/페이싱 `<h4 className={eyebrowCls}>` 패턴과 동일). 판정·고급 Section은 번호 재시퀀스(현 `index={3}`). 모드 가시성 보존(부하모델·환경=양 모드, 데이터셋/측정/저장/프로파일/판정·고급=상세). (주의: 타일은 `:293` bare `<div>` 안 loose `role="radio"` — radiogroup 아님; 그룹 접근명은 fieldset legend가 담당.) | RTL: 각 Section 타이틀+배지; `부하 정의`/`대상 설정` 부재(리타이틀/분리); fieldset(부하 모델 sr-only legend) green; 모드별 가시성 + 스크린샷 |
| R15 | MUST(**시각 acceptance·강제**): 구현 후 Playwright로 간단·상세 둘 다 스크린샷 떠 `docs/superpowers/mockups/*.png`와 대조해 *시각적으로 일치* 확인. **대조 STATE = open+fixed·RPS 100/시간 300/상한 200**(PNG 정규 상태 — 라이브 기본 closed+fixed 2/5에서 open 전환 후 입력). **고정 모드 footer 미니그래프(R5 의도적 초과)·번호 Section 원형 ①②③(R14·사용자 결정)은 둘 다 PNG엔 없으나 의도적 잔존 → 미스매치 아님.** 단순 role/aria 통과로 끝내지 말 것(직전 빵꾸 재발 방지). | live-verify 스크린샷 대조 기록(간단·상세 각 1장 + 대조 노트) |

## 설계 결정

1. **타일 룩 = v3 `.tile` (R1).** 각 타일 = `<button role="radio">`, 컨테이너 `flex items-start gap-3 rounded-lg border p-3 text-left`(2열은 부모 `grid grid-cols-2 gap-3` 또는 두 버튼 `flex-1`). 좌측 라디오 ◉(작은 원, 선택 시 accent 채움), 우측 `flex flex-col`(굵은 제목 + `text-xs text-slate-500` 설명). 선택: `border-accent-500 bg-accent-50`(mockup `.tile.sel`=accent border + accent-weak bg, ring 불필요), 비선택: `border-slate-200 hover:border-slate-300`. **accent 토큰만**(ADR-0043·차트색 무관·R13 디자인시스템 노트).
2. **타일 라벨은 신규 ko 키 (R2·R11·R16).** `ko.loadModel.closedLoop`/`openLoop`는 ScheduleForm 라디오·기타 소비처 **공유** → 건드리면 그 표시가 다 바뀐다. 타일 전용 신규 키(`tileClosedTitle:"동시 사용자 (VU)"`·`tileOpenTitle:"목표 RPS"`)를 **타일 분기에서만** 사용. 타일 접근명이 새 라벨이 되므로 RunDialog/LoadModelFields의 *타일* 셀렉터(현 `사용자 수 기준`/`요청 속도 기준` 매치)는 새 라벨로 갱신; ScheduleForm(라디오·기존 키) 셀렉터는 불변.
3. **footer 시그니처 = 신규 `LoadShapePreview` (R5·R6 색).** `StageCurvePreview`는 `toControlPoints`가 `(0,0)` 시작 하드코딩이라 고정 load(1-stage)에 *대각 ramp*가 되고 stroke가 `#2563eb`(ui/CLAUDE.md: 데이터-차트 stroke의 accent화 금지)로 잠겨 있다. footer 시그니처는 *장식*(데이터 차트 아님)이라 별도 작은 컴포넌트로 분리하면 둘 다 해결: `LoadShapePreview({ kind:"flat"|"curve", stages?, width, height })` — `flat`=수평선(mid-height), `curve`=stages 비례 polyline(자체 제어점, `(0,0)` 강제 없음). 색은 accent(`stroke="currentColor"` + 부모 accent 텍스트색, 또는 accent 리터럴) — *장식 컴포넌트라 차트색 규칙 무위반*. **footer는 `sum.curve` 분기 없이 유효하면 항상** `LoadShapePreview`(고정=flat·곡선=stages), warn이면 생략. a11y(정정 — 현 설계 실측): 현 RunDialog는 *본문 R17 곡선 카드*를 `aria-hidden`(`RunDialog.tsx:629`)으로 두고 **footer가 유일한 SR 구술 지점**이다. 따라서 footer `LoadShapePreview`는 **표시될 때 항상 `role="img"`+`aria-label`**(곡선=`curvePreviewAriaVu`/`Rps`·고정=신규 `loadShapeAria`) — **조건부 `aria-hidden` 추가 금지**(footer를 숨기면 `RunDialog.test.tsx:2791`/`:2849`가 깨지고 SR 구술점이 사라진다). 본문 카드의 기존 `aria-hidden`은 유지. R5 RTL은 고정 모드 footer `role=img` 존재 + invalid시 부재로 검증. (실잠재 중복은 *상세*+곡선 편집 미리보기 — 현 코드에 이미 존재=선재·범위 밖.)
4. **footer 텍스트 = 구조화 조각 (R6).** `runSummary`가 `{ main: SummarySegment[]; sub: string; tone; curve }` 반환. ko `summary*`(main)는 `SummarySegment[]` 반환 — 예 `summaryClosed(vus,time)=[{text:"동시 사용자 "},{text:String(vus),bold:true},{text:"명 · "},{text:time,bold:true}]`(연결 한국어 텍스트도 ko 안에 머무름 → ADR-0035 준수, 굵음은 보간 숫자 세그먼트). `*Sub`(`summaryRampUp`/`summaryOpenSub`/`summaryCurveSub`)는 회색 string 유지. warn은 main=`[{text:summaryInvalid}]`(굵음 없음) + **신규 sub 키**(`summaryWarnClosedSub:"동시 사용자·시간을 입력"`·`summaryWarnOpenSub:"목표 RPS·시간을 입력"`); 곡선 warn은 generic sub(또는 sub 생략). footer는 main 세그먼트(`<b>` for bold)·sub(`text-slate-*`) 렌더. **소비처는 `runSummary.ts`(빌드)+footer(`RunDialog.tsx:377` 렌더)+`runSummary.test.ts`뿐**(grep 확인: ko `summary*`는 `runSummary.ts`만 소비). 판정 로직(warn 게이트·curve 분기)은 불변(R10).
5. **칩은 항상 표시 (R3).** `appliedDetail(0)`="상세 설정 0개 적용됨"이 자연스러우므로 ko 변경 불필요. 칩 = `<button>` 칩 룩(⚙ + 텍스트) `onClick=setMode("detailed")`. 0개여도 "고급 설정이 여기 있다"는 affordance. **`detailedAppliedCount` 계수식 0-diff**(F1 이중계수 함정 — `advancedActiveCount` 경유 단일계수 유지, 가시성 조건만 `>0` 제거).
6. **프로파일 Segmented는 RunDialog 전용 게이트 (R4·R12).** `LoadModelFields`에 기존 `loadModelTiles`(또는 신규 `profileSegmented`) 분기로 라디오↔Segmented. ScheduleForm 미전달=라디오. `Segmented` 프리미티브(직전 슬라이스 신설) 재사용. **신규 prop은 additive optional**(미전달 호출부=ScheduleForm byte-identical, 직전 슬라이스 게이트 패턴).
7. **per-tile HelpTip 위치 (R9·R1).** 현 라이브 타일은 각각 형제 HelpTip(`LoadModelFields.tsx:305,318`)을 단다. 목업 타일엔 ⓘ가 없지만 R9가 기능 보존을 요구 → HelpTip은 **타일 `<button>` 밖 형제로 유지**(U3 — 버튼 안에 넣으면 라디오 accessible name 오염·중첩 interactive). 배치는 eyebrow 옆(부하 모델 용어 도움말) 또는 타일 grid 아래 형제 행 — **plan이 v3 디테일·R9 보존을 만족하는 한 곳을 택일**(목업 충실도상 eyebrow 권장). 타일 *내부*엔 ⓘ를 넣지 않는다.
8. **섹션 재구성 = 기존 번호 `Section` 재사용 (R14·사용자 2026-06-28).** 사용자가 "번호 Section 유지 + eyebrow 항목 추가"를 택함 → **신규 `Eyebrow` 컴포넌트 불필요**. 현 `Section`(ADR-0043)이 이미 `eyebrowCls` 타이틀(`RunDialog.tsx:532`=`text-[10px] uppercase tracking-[0.15em] text-slate-500`·mockup `.eyebrow`와 동일) + `Badge` + `index` 원형을 렌더하므로, mockup #6 항목을 **번호 Section으로 추가/분리**(번호 1..N 재시퀀스). `Section`은 본디 `<fieldset>`+`<legend>`라 의미 group이 자연(env/dataset/measure/save를 각 Section으로). R14①은 **외곽 Section1 유지(리타이틀 부하 모델·번호 ①) + 안쪽 LoadModelFields legend `sr-only`**(번호를 outer에 두려면 outer를 못 지움 → inner를 시각적으로만 숨김; fieldset/legend 텍스트 보존 → 접근명·`tagName==="FIELDSET"` 테스트 green). 모드 가시성 보존(부하모델·환경=양 모드, 데이터셋/측정/저장/프로파일/판정·고급=상세). 목업 무번호와의 차이(번호 잔존)는 사용자 수용(R15 미스매치 아님).
9. **모달화는 비범위 (유지).** 목업은 모달 카드+✕로 그렸으나 라이브 RunDialog는 runs 페이지 인라인 섹션. 인라인→모달 전환은 큰 구조 변경(라우팅·오버레이·포커스 트랩)이라 이 슬라이스 밖. 헤더 제목만 "실행 설정"으로(R8). (모달 전환 원하면 사용자와 별도 슬라이스.)
10. **byte-identical은 절대 (R10·R11).** 이 슬라이스는 *오직 시각/표현*. 어떤 state·핸들러·검증·payload 식도 안 바꾼다. `runSummary` 조각화(R6)는 *반환 구조*만 바꾸고 *판정 로직*(warn·curve 게이트)은 불변. eyebrow/섹션 재배치는 *마크업/className*만 — 모든 입력·핸들러·`aria-label`(테스트 셀렉터) 보존.

## 주요 파일·앵커

- `ui/src/components/LoadModelFields.tsx` — 타일 분기(`:289-320`·className `:300,313`·HelpTip `:305,318`), fieldset/legend "부하 모델"(`:288`·타일 div `:293`), 프로파일 라디오→Segmented(`:358-390`·legend `:360`), `rateMode`/`setRateMode`·신규 optional prop.
- `ui/src/components/RunDialog.tsx` — footer 시그니처(accent bar `:1035`·미니 preview `:1046`·`sum`=`:377`·렌더 `:1036/1050/1052`·버튼 `:1066`), 적용 칩(`:888-890`·`mode==="simple" && detailedAppliedCount>0`), `detailedAppliedCount`(`:350`·`advancedActiveCount` `:345`), 번호 `Section`(`<Section index={1/2/3}>` `:581/674/701`·`eyebrowCls` `:532`)·Section1 타이틀 `sectionLoadTitle` `ko.ts:70`(→`부하 모델`)·Section2 `대상 설정`(`:674-697`) 분리(환경+데이터셋)·측정 bare div(`:824-838`)→Section·프리셋 블록→Section·R17 곡선 카드(`:623-633`)·헤더 제목(`runDialog.title`).
- `ui/src/components/runSummary.ts` — `{main:Segment[],sub,tone,curve}` 재구조화(R6).
- `ui/src/components/StageCurvePreview.tsx` — **불변**(LoadShapePreview는 별도 신규, 이 파일 미접촉).
- `ui/src/components/LoadShapePreview.tsx` — **신규** footer 부하-모양(flat/curve·accent·role=img).
- `ui/src/components/ui/Segmented.tsx`(`:30,41-42`)·`Badge.tsx` — 재사용(프리미티브 0-diff). (선택) `ui/src/components/ui/Eyebrow.tsx` 신규(plan 재량).
- `ui/src/i18n/ko.ts` — 신규 키(`loadModel.tileClosedTitle`/`tileOpenTitle`·`runDialog.summaryWarnClosedSub`/`summaryWarnOpenSub`·eyebrow 라벨[필요 시]) + 의도적 copy 변경(`runDialog.title:65`→"실행 설정"·`runDialog.run:66`→"실행하기"·`summary*:100-108` main→Segment[]). 외곽 `sectionLoadTitle:70`("부하 정의")는 제거 대상(R14①).
- 테스트 갱신: `ui/src/components/__tests__/RunDialog.test.tsx`(`/^실행$/`×39·footer 매처·측정 role·타일 라벨), `LoadModelFields.test.tsx`(타일 라벨·fieldset 보존), `runSummary.test.ts`(세그먼트 재작성). `ScheduleForm.test.tsx`는 **불변**(라디오·공유 키).

## 테스트·acceptance

- 기존 RTL 전수 green(`pnpm lint && pnpm test && pnpm build`). **블라스트 레이디어스(plan sweep, 실측):**
  - ① 앵커 `/^실행$/` 셀렉터 **39곳**(전부 `RunDialog.test.tsx`)이 "실행하기"로 깨짐 → 갱신.
  - ② 타일 라벨 셀렉터 — `사용자 수 기준`(9) + `요청 속도 기준`(26) = **35 참조**(`LoadModelFields.test.tsx`·`ScheduleForm.test.tsx`·`RunDialog.test.tsx`). **`ScheduleForm.test.tsx`의 라디오 참조는 유지**(공유 키 불변·`ScheduleForm.test.tsx:103` `getByRole("radio",{name:/사용자 수 기준/})`); RunDialog/LoadModelFields의 *타일* 참조만 신규 라벨로 갱신(라디오 vs 타일 구분 주의). **신규 타일 셀렉터는 정규식 부분일치(`/동시 사용자 \(VU\)/`·`/목표 RPS/`) — 정확문자열 금지**: 타일 button 접근명 = 제목+설명 span 연결(`"동시 사용자 (VU)N명이 동시에 반복 요청"`)이라 정확매치 실패. `LoadModelFields.test.tsx:418`(fieldset 테스트 내부 `{name:/사용자 수 기준/}` 타일 셀렉터)도 신규 라벨로(아래 ⑤의 :416/417/419 group/tagName/desc는 불변).
  - ③ **footer 요약 매처 *구조적* 재작성**(R6 굵은 세그먼트 함정): R6이 숫자를 `<b>`로 감싸면 RTL `getByText`가 직접 텍스트노드만 join해 full-string 정규식이 안 맞는다 → `RunDialog.test.tsx`의 footer 단언 갱신 — `:2695` `getByText(/동시 사용자 100명/)`·`:2696` `getByText(/5분/)`·`:2714` `getByText(/약 30,000건/)`·`:2741` `getByText(/최대 50명/)`(`:2723` "설정을 확인하세요"는 굵음 없어 생존). 권장 재작성 = footer 컨테이너를 `getByRole("button",{name:"실행하기"}).closest('[class*="sticky"]')`로 잡아 `toHaveTextContent("동시 사용자 100명 · 5분")`(textContent는 `<b>` 경계 무관). **단순 라벨치환 아님 — plan이 별도 task로 예산.**
  - ④ 측정 role: `RunDialog.test.tsx:1855` `getByRole("checkbox",…)` → `getByRole("switch",…)`(R13).
  - ⑥ **섹션 제목 단언**(리타이틀/분리가 깨뜨림 → 같은 task 커밋): `RunDialog.test.tsx:206 getByText("부하 정의")` + `:2871 includes("부하 정의")` → "부하 모델"(R14①·Task 2); `:207 getByText("대상 설정")` → "환경"/"데이터셋 바인딩"(R14②·Task 8). grep `getByText("부하 정의"\|"대상 설정")`로 잔존 0 확인.
  - ⑦ **footer img 테스트는 green 유지**: `RunDialog.test.tsx:2791`(`getAllByRole("img")≥1`)·`:2849`(`getByRole("img",{name:…RPS})`)는 footer가 항상 role=img+aria-label을 유지하므로 통과(aria-hidden 추가 금지 — 결정 3).
  - ⑤ fieldset 보존: `LoadModelFields.test.tsx:414-420`(`getByRole("group",{name:/부하 모델/i})`+`tagName==="FIELDSET"`+`getByText(tileClosedDesc)`)는 R14① 후에도 **green 유지**(inner legend를 *제거가 아니라 `sr-only`* — 텍스트 보유라 fieldset 접근명·태그 유지) — 깨지면 legend를 텍스트째 지운 오구현 신호.
- 신규 RTL: 타일 선택 accent 클래스+teeth(R1)·신규 타일 라벨(R2)·항상-칩+클릭(R3)·프로파일 Segmented+ScheduleForm 라디오 보존(R4)·footer 모양 유효-렌더/invalid-부재(R5)·footer main 굵은 세그먼트+회색 sub+warn sub+"실행하기"(R6)·제목(R8)·측정 토글 카드 role=switch aria-checked→`measure_phases:true`(R13)·eyebrow 텍스트/배지/중복-해소/fieldset 보존/모드 가시성(R14).
- payload 골든 정확 `toEqual(DEFAULT_SIMPLE_PROFILE)`(R10·부분 `toMatchObject` 금지)·ScheduleForm 미전달 prop byte-identical(R12) 락인. `runSummary.test.ts` 세그먼트 단언으로 재작성.
- **시각 acceptance(R15·강제)**: live-verify에서 **open+fixed 100/300/200**으로 간단·상세 스크린샷 → 저장 PNG와 대조 기록(고정 footer 미니그래프=의도적 초과로 표기).
- **teeth-check**: R1 accent-선택 단언은 선택→비-accent 뒤집어 FAIL 확인(jsdom `toHaveClass`/`toHaveStyle` 규약 ui/CLAUDE.md). R3 클릭→상세·R13 toggle aria는 mockup-초과 a11y 추가(유지·의도 명시).

## 리뷰 이력

- **1차(spec-plan-reviewer, 2026-06-28) NEEDS-REWORK** — 코드 앵커 8개 정확. acceptance-레벨 모순/누락 10항(R5↔시각acc 모순·R5 메커니즘·footer 색·R11 재조정·R6 완전명세·#6 누락 fidelity·R7 모호·테스트 blast radius·대조 state·teeth)을 1차 개정에서 반영.
- **2차(spec-plan-reviewer, 2026-06-28) APPROVE-WITH-FIXES** — 앵커·mockup 사실·blast-radius 전수 재확인(정확). 6 fix를 이 개정본이 반영: ① footer-요약 테스트 *구조적* 재작성을 §test ③에 명시(매처 4곳 file:line)·② R14① 단일-헤더를 "외곽 제거+legend 유지·eyebrow화"로 확정(fieldset/`LoadModelFields.test.tsx:414-421` 보존)+radiogroup 표현 정정(loose role=radio in bare div)·③ 시각 acceptance R12→**R15** 재번호(R12=ScheduleForm wire byte-identical 단독 행)·④ per-tile HelpTip 위치 규칙(결정 7·버튼 밖 형제)·⑤ 측정 `role="switch"` 핀(+`RunDialog.test.tsx:1855` 갱신)·⑥ 구 R7→R14② 흡수.
- **스코프 결정(사용자, 2026-06-28): 전체 충실도.** #6의 section/eyebrow 재구성(R14)이 슬라이스를 "타일+측정+footer"에서 **"전체 헤더/섹션 fidelity"**로 확장 — 사용자가 명시적으로 *전체 충실도*를 선택했으므로 R14 전 항목 포함(out-of-scope 처리 금지). fresh 구현 세션은 v3 HTML을 정규 oracle로 전 섹션을 맞춘다.
- **R14 섹션 헤더 결정(사용자, 2026-06-28, plan-writing 중 발견된 갭):** 목업은 무번호 eyebrow지만 현 RunDialog는 ADR-0043 번호 `Section`(①②③)을 쓴다. 사용자가 **"번호 Section 유지 + #6 eyebrow 항목만 추가"** 를 택함 → R14는 신규 `Eyebrow` 컴포넌트 없이 기존 `Section` 재사용(번호 1..N 재시퀀스)·R14① dedupe는 inner legend `sr-only`. 번호 잔존은 목업 대비 **의도적 차이**(R15 미스매치 아님).
- **plan 리뷰(spec-plan-reviewer, 2026-06-28) APPROVE-WITH-FIXES 반영분이 spec에도:** ① footer a11y 정정(결정 3·R5) — 현 코드가 *본문 카드*를 aria-hidden하고 footer가 유일 SR 구술점이라, footer는 항상 role=img+aria-label(조건부 aria-hidden 금지). ② blast-radius에 섹션 제목 단언(⑥ `:206`/`:207`/`:2871`)·footer img 테스트 green(⑦ `:2791`/`:2849`)·타일 셀렉터 정규식(②)·fieldset 테스트 `:419` 타일 셀렉터 갱신(⑤) 보강. 상세는 plan 문서(LoadShapePreview className 머지·`setup()` 헬퍼·측정 Section 이동 등).

## 비범위 / 후속

- 모달화(인라인→오버레이+✕·결정 9).
- 고정-모드 footer 미니그래프를 "실시간 처리량 미리보기"로 고도화(현재는 정적 부하-모양).
- 나머지 화면 디자인 토큰 이주(roadmap shortlist #3 나머지 절반).

# RunDialog 목업 시각 충실도 + footer 부하-모양 시그니처 Design

## 목표

직전 슬라이스(`rundialog-simple-detailed`, 머지됨)가 RunDialog 간단/상세 모드를 **기능적으로** 구현했으나, **시각 충실도가 목업과 어긋난다**(특히 부하 모델 "타일"이 스타일 0의 텍스트라 선택 상태가 안 보임). 이 슬라이스는 **저장된 목업 2장을 시각 oracle로 삼아** RunDialog를 목업에 맞춘다. + 사용자 추가 요구: **footer 부하-모양 미니그래프를 전 모드(고정 포함)** 에 표시("시그니처").

**불변 제약: payload byte-identical(R11) + ScheduleForm byte-identical(R12) + 기존 기능 전부 보존(목업이 일부 기능을 생략해 그렸을 뿐, 삭제 금지).**

## 시각 oracle (정규 기준)

**1순위(authoritative) — 인터랙티브 HTML 목업** (brainstorm 세션 산출물, 트랜스크립트에서 복구·커밋):
- `docs/superpowers/mockups/rundialog-v3.html` — **최종/정답**(title "RunDialog v3 — 사이징 도우미 유지 · 측정 노출"). **이걸 브라우저로 열어(간단↔상세 토글) 전 디테일을 본다.**
- `docs/superpowers/mockups/rundialog-v2.html`·`rundialog.html` — 이전 버전(참고).

보조 — PNG 캡처(간단/상세 일부): `2026-06-28-rundialog-simple.png`·`-detailed.png`.

구현·검증 시 **v3 HTML을 열어 픽셀 대조**한다. (직전 슬라이스 빵꾸 원인 = ① 라이브 검증이 `role`/`aria-checked` 의미·구조만 보고 *시각*을 안 봄 ② 목업 HTML이 gitignored `.superpowers/brainstorm/`에만 있다 worktree 삭제로 소실 → PNG 일부 캡처로만 작업해 측정 섹션 등 디테일 놓침. **이번엔 HTML을 커밋해 durable + 스크린샷 대조가 acceptance.**) 교훈은 메모리 [[save-mockups-durably]].

## 배경 / 왜 빵꾸났나

- 직전 슬라이스의 RTL·리뷰·라이브 검증은 전부 **의미/구조**(role=radio·aria-checked·payload byte-identical)만 확인. **타일이 시각적으로 선택돼 보이는지, 룩이 목업과 맞는지를 단언한 게이트가 없었다** + spec에 시각 목업이 임베드 안 돼 있어 diff 기준이 없었다.
- 현 `loadModelTiles` 타일 버튼 className = `flex flex-col items-start text-sm cursor-pointer`(`LoadModelFields.tsx:300,313`) — **테두리·배경·라디오 인디케이터·선택 강조가 전무**. `aria-checked`만 맞고 시각 선택 상태 0.

## 요구사항

| R | 요구 | 검증 |
|---|---|---|
| R1 | MUST: `loadModelTiles` 부하 모델을 **진짜 타일**로 — 좌우 동일너비(`flex-1`)로 행을 채우는 테두리 박스(`rounded-lg border`), **라디오 ◉ 인디케이터**, 굵은 제목 + 회색 설명(inline). **선택(`aria-checked`)=accent 테두리 + 연한 accent 배경(+ring)**, 비선택=`border-slate-200`. `role=radio`/`aria-checked`/키보드 보존. | RTL: 선택 타일에 accent 클래스(`toHaveClass`/`toHaveStyle`) 존재·비선택 부재 + 스크린샷 대조 |
| R2 | MUST: 타일 제목을 목업대로 — closed=**"동시 사용자 (VU)"**, open=**"목표 RPS"**(현 "사용자 수 기준 (closed-loop)"/"요청 속도 기준 (open-loop)" 대신). 설명(`tileClosedDesc`/`tileOpenDesc`)은 현행 유지(목업 일치). **신규 ko 키(tile 전용)로 추가** — 공유 `ko.loadModel.closedLoop`/`openLoop`는 **안 건드림**(ScheduleForm 라디오·기타 소비처 표시 불변 = R12·R16 add-only). | 타일 접근명이 신규 라벨로 바뀐 RunDialog/LoadModelFields **타일 셀렉터** 갱신; ScheduleForm 라디오 셀렉터 불변 |
| R3 | MUST: 간단 모드 "상세 설정 N개 적용됨"을 **N=0 포함 항상 보이는 칩**으로(⚙ 아이콘·칩 룩·클릭→상세 전환). 현 `mode==="simple" && detailedAppliedCount > 0` 조건(`RunDialog.tsx:888`) → `mode==="simple"`이면 항상 렌더. | RTL: 간단·기본(count 0)에서 칩 보임 + 클릭→`상세` aria-checked; count>0 표시 |
| R4 | MUST: 상세 프로파일 `고정/곡선` 토글(`LoadModelFields.tsx:357-385` 라디오)을 **`Segmented`**(active=accent)로. **RunDialog 전용 게이트**(loadModelTiles 또는 신규 optional prop) — ScheduleForm은 라디오 유지(R12). `role=radio` 접근명 "고정"/"곡선" 보존(Segmented도 role=radio). HelpTip은 Segmented 밖 형제(U3). | RTL: RunDialog 상세 프로파일 Segmented + `getByRole("radio",{name:"곡선"})` 보존; ScheduleForm 라디오 불변 |
| R5 | MUST(**신규 요구**): footer 시그니처에 **전 모드 부하-모양 미니그래프**. 고정(closed VU·open RPS)=**평평한 일정선**(duration 동안 일정 레벨), 곡선=기존 stages 모양(`StageCurvePreview`). 현 footer는 `sum.curve`일 때만 미니 `StageCurvePreview`(`RunDialog.tsx:1046`) → 고정 모드도 모양 렌더. invalid면 미니그래프 흐리게/생략 + `설정을 확인하세요`. | RTL: 고정 closed/open·곡선 모두 footer에 모양 요소(`role=img`) 렌더 + 스크린샷 |
| R6 | MUST: footer 텍스트 핵심 숫자 **굵게**(목업: "목표 **100 RPS** · 약 **30,000건** · **5분**"). 실행 버튼 라벨 "실행"→**"실행하기"**(목업). | RTL: footer 강조 마크업 존재; 버튼 `getByRole("button",{name:"실행하기"})` |
| R7 | MUST: 환경 섹션 라벨 옆 **"선택" Badge**(목업). | RTL: 환경 라벨 근처 "선택" 배지 |
| R8 | SHOULD: 헤더 제목 "새 실행"→**"실행 설정"**(목업). | RTL: 제목 텍스트 |
| R13 | MUST(**사용자 지적**): 측정(응답 시간 단계 분해)을 **체크박스가 아니라 토글-스위치 카드**로(목업 v3 `.measure`) — 테두리 카드(`rounded border p-3`) + **큰 토글 스위치**(≈38×22 pill·`aria-checked`·on=accent·knob 슬라이드) + 굵은 제목 "응답 시간 단계 분해" + 설명 "DNS · 연결 · 대기 · 다운로드…어디서 느린지 진단" + ⓘ. 현 구현은 기존 체크박스를 섹션으로 *빼내기만* 함. 토글 on/off ↔ `measure_phases` payload 매핑은 **현 로직 유지(byte-identical)**, 시각만 토글 카드로. | RTL: 측정 토글(role=switch/checkbox+aria-checked)·on→`measure_phases:true` 골든 + 스크린샷 |
| R9 | MUST: **기존 기능 전부 보존** — VU/slot/worker 사이징 도우미, 측정 섹션, 판정·고급(SLO·페이싱·http_timeout·loop_cap), 프리셋 불러오기/저장/이름변경/삭제, 데이터셋 바인딩, R17 곡선 읽기전용 카드, blockedReasons, F1 measure 단일계수, prefill 상세예측(`opensDetailed`). 목업이 생략해 그린 것일 뿐 삭제 금지. | 기존 RTL 전수 green(라벨 변경분만 갱신) |
| R10 | MUST: **payload byte-identical(R11)** — `buildProfile`/`buildLoadProfile`/`resolveEnv`/`canSubmit`/`deriveLoadMode`/`detailedAppliedCount` *계수식*·`runSummary` *판정 로직* 0-diff. 변경은 전부 시각/표현(className·요소·라벨 문구). `DEFAULT_SIMPLE_PROFILE` 골든 유지. | 골든 `toEqual` green + `git diff` 로직식 0 |
| R11 | MUST: **UI-only** — `crates/**`·proto·migration·`ui/src/api/schemas.ts` 0-diff. `ko.ts` 추가-only(신규 tile-title 키만; 기존 키 변경 0). | grep 0-diff |
| R12 | MUST: **시각 acceptance(강제)** — 구현 후 Playwright로 간단·상세 둘 다 스크린샷 떠 `docs/superpowers/mockups/*.png`와 대조해 *시각적으로 일치* 확인. 단순 role/aria 통과로 끝내지 말 것(직전 빵꾸 재발 방지). | live-verify 스크린샷 대조 기록 |

## 설계 결정

1. **타일 룩 = 목업 (R1).** 각 타일 = `<button role="radio">`, 컨테이너 `flex-1 flex items-start gap-3 rounded-lg border p-3 text-left`. 좌측 라디오 ◉(작은 원, 선택 시 accent 채움·체크), 우측 `flex flex-col`(굵은 제목 + `text-xs text-slate-500` 설명). 선택: `border-accent-500 bg-accent-50 ring-1 ring-accent-500/30`(또는 동급 accent fill), 비선택: `border-slate-200 hover:border-slate-300`. **accent 토큰만**(ADR-0043·차트색 무관). 두 타일을 감싸는 `flex gap-3`로 행 채움.
2. **타일 라벨은 신규 ko 키 (R2·R12·R16).** `ko.loadModel.closedLoop`/`openLoop`는 ScheduleForm 라디오·`deriveLoadMode` 표시 등 **여러 소비처 공유** → 건드리면 그 표시가 다 바뀐다. 타일 전용 신규 키(`tileClosedTitle:"동시 사용자 (VU)"`·`tileOpenTitle:"목표 RPS"`)를 **타일 분기에서만** 사용. 타일 접근명이 새 라벨이 되므로 RunDialog/LoadModelFields의 *타일* 셀렉터(`getByRole("radio",{name:/사용자 수 기준/})` 등)는 새 라벨로 갱신; ScheduleForm(라디오·기존 키) 셀렉터는 불변.
3. **footer 시그니처 = 전 모드 부하-모양 (R5).** 새 작은 컴포넌트 또는 `StageCurvePreview` 확장으로 "고정=평평한 일정선 / 곡선=stages 모양"을 통일 렌더. 고정 closed=일정 VU 레벨, 고정 open=일정 RPS 레벨 → 둘 다 수평선(또는 채워진 영역). 곡선은 기존 `StageCurvePreview`(stages). footer는 `sum.curve` 분기 없이 항상 미니그래프(invalid 제외). **`StageCurvePreview`의 jsdom explicit width/height·stroke `#2563eb`·`type="linear"` 규칙 유지**(ui/CLAUDE.md). 미니그래프는 장식이지만 footer에 단 하나면 `role=img`+aria-label, 읽기전용 카드와 중복 시 한쪽 `aria-hidden`(직전 슬라이스 패턴).
4. **칩은 항상 표시 (R3).** `appliedDetail(0)`="상세 설정 0개 적용됨"이 자연스러우므로 ko 변경 불필요. 칩 = `<button>` 칩 룩(⚙ + 텍스트) onClick=`setMode("detailed")`. 0개여도 "고급 설정이 여기 있다"는 affordance.
5. **프로파일 Segmented는 RunDialog 전용 게이트 (R4·R12).** `LoadModelFields`에 기존 `loadModelTiles`(또는 신규 `profileSegmented`) 분기로 라디오↔Segmented. ScheduleForm 미전달=라디오. `Segmented` 프리미티브(직전 슬라이스 신설) 재사용.
6. **모달화는 비범위(후속 결정).** 목업은 모달 카드+X로 그렸으나 라이브 RunDialog는 runs 페이지 인라인 섹션. 인라인→모달 전환은 큰 구조 변경(라우팅·오버레이·포커스 트랩)이라 이 슬라이스 밖. 헤더 제목만 "실행 설정"으로(R8). (모달 전환 원하면 사용자와 별도 슬라이스.)
7. **byte-identical은 절대 (R10·R11).** 이 슬라이스는 *오직 시각/표현*. 어떤 state·핸들러·검증·payload 식도 안 바꾼다. `runSummary`의 굵게(R6)는 footer 렌더에서 강조 마크업으로 처리하되 `runSummary`가 구조화 조각을 반환하도록 바꾸면 그 단위 테스트만 갱신(판정 로직 불변).

## 주요 파일·앵커

- `ui/src/components/LoadModelFields.tsx` — 타일 분기(`:289-320`·className `:300,313`), 프로파일 라디오(`:357-385`), `rateMode`/`setRateMode` prop.
- `ui/src/components/RunDialog.tsx` — footer 시그니처(accent bar `:1035`·미니 StageCurvePreview `:1046`·`sum`=`:377`), 적용 칩(`:888-890`), `detailedAppliedCount`(`:350`), 헤더 제목·환경 섹션 라벨.
- `ui/src/components/runSummary.ts` — footer 텍스트(R6 강조 시 구조화).
- `ui/src/components/StageCurvePreview.tsx` — footer 미니그래프(고정=flat 추가).
- `ui/src/components/ui/Segmented.tsx`·`Badge.tsx` — 재사용(프리미티브 0-diff).
- `ui/src/i18n/ko.ts` — 신규 tile-title 키(add-only).

## 테스트·acceptance

- 기존 RTL 전수 green(타일 라벨 변경 셀렉터만 갱신·`pnpm lint && pnpm test && pnpm build`).
- 신규 RTL: 타일 선택 accent 클래스(R1)·항상-칩+클릭(R3)·프로파일 Segmented(R4)·footer 전모드 미니그래프(R5)·footer 강조+"실행하기"(R6)·환경 배지(R7)·제목(R8).
- payload 골든(R10)·ScheduleForm 불변(R12) 락인.
- **시각 acceptance(R12)**: live-verify에서 간단·상세 스크린샷 → 저장 목업과 대조 기록.

## 비범위 / 후속

- 모달화(인라인→오버레이+X·결정6).
- 고정-모드 footer 미니그래프를 "실시간 처리량 미리보기"로 고도화(현재는 정적 부하-모양).
- 나머지 화면 디자인 토큰 이주(roadmap shortlist #3 나머지 절반).

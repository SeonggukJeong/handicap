# RunDialog 간단/상세 모드 + 정밀계기 재디자인 — 초보자 친화 실행 설정 (UI-only · ADR-0043 범위 내)

- **날짜**: 2026-06-27
- **상태**: 설계 초안
- **출처**: roadmap §"다음 후보" shortlist #3 (§B12 디자인 시스템 후속) / 사용자 요청. **왜 지금**: C-2(rundialog-design-system)가 RunDialog를 byte-identical 재구성했지만 여전히 필드 벽이라 초보자가 압도된다 — "초보자 친화" 스레드를 간단/상세 토글로 마무리하고, 사용성+심미를 동시에 끌어올린다.
- **연관**: ADR-0043(디자인 시스템), 선행 슬라이스 `2026-06-27-rundialog-design-system-design.md`·`2026-06-27-design-system-spread-design.md`.
- **ADR**: 신규 불필요(ADR-0043 범위 내 additive — 새 프리미티브 `Segmented`·`Input numeric` 옵션·`Eyebrow`는 "점진 채택" 원칙에 부합·기존 프리미티브/accent 토큰 무변경). 간단/상세는 UX 패턴이지 아키텍처 결정 아님.

---

## 1. 문제와 목표

RunDialog(944줄)는 한 화면에 부하 정의·환경·데이터 바인딩·SLO·페이싱·진단·프리셋을 전부 펼쳐 초보 QA를 압도한다. 부하모델/수치/시간/환경만 알면 첫 부하 테스트를 띄울 수 있는데, 그 핵심이 고급 옵션 사이에 묻혀 있다. 또 "이 테스트가 무엇을 발생시키나"를 실행 전에 읽을 방법이 없어, 프로덕션을 때릴 수 있는 도구치고 검증·신뢰 장치가 약하다.

- **목표**: ① 헤더 `간단/상세` 세그먼트 토글로 초보자에게 **필수 7필드만** 보이고 전문가는 한 클릭으로 전체 제어. ② 실행 전 **실시간 요약**(시그니처)으로 "무엇이 실행되나"를 정직하게 보여 줌. ③ 프리셋 동선 정리(불러오기=위·저장=아래), 측정 옵션 노출. ④ "정밀 계기(라이트)" 룩 — 기존 라이트 디자인 시스템과 일관되되 distinctive. **사용성 #1, 심미 #2.**
- **비목표(연기)**: §7. 복제 버튼·다크 테마·ReportView 측정 유도·모드 localStorage·ScheduleForm 동일 재디자인.

**안전 경계(이 슬라이스의 핵심 불변식)**: 시각/구성은 자유롭게 바꾸되, **같은 입력이면 `profileForm.buildProfile` 출력(=POST /api/runs 페이로드)이 재디자인 전과 byte-identical**. 모드는 *가시성만* 게이트하고 wire/검증 계약은 불변. `schemas.ts`·`crates/**`·proto·migration 0-diff. ScheduleForm byte-identical.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (테스트/관찰) | seam? |
|---|---|---|---|
| R1 | MUST: RunDialog 헤더에 `간단`/`상세` 세그먼트 컨트롤(`role=radiogroup`, 키보드 탐색, active=accent fill) 배치. | RTL: 토글 클릭/키보드로 `aria-pressed` 전환 + 상세 섹션 렌더/미렌더 | |
| R2 | MUST: 기본 모드=간단. 단 `initial`(prefill: retry/preset)이 **비기본 상세값**(곡선·SLO·think-time·worker>1·measure_phases·비기본 http_timeout/loop_cap)을 가지면 상세로 연다(기존 `advancedOpen` 자동펼침 술어 재사용·단일소스). | RTL: detailed-value prefill→상세 마운트; plain prefill/신규→간단 | |
| R3 | MUST: 간단 모드 렌더 집합 = [프리셋 불러오기 strip] · 부하모델(타일) · 크기 chips(closed) · 주 수치(closed: VU·시간·램프업 / open: RPS·시간·동시요청상한) · 환경 **선택만** · 사이징 도우미(접힘) · 실시간 요약 · 실행/취소. 그 외 섹션은 미렌더. | RTL: 간단에서 상세-전용 섹션(프로파일·measure·고급·바인딩·오버라이드·저장) 부재 | |
| R4 | MUST: 상세 모드 = R3 ∪ {프로파일(고정/곡선)+곡선 에디터/미리보기, 워커 수, 램프다운, 측정, 판정·고급(SLO·스텝SLO·페이싱·http_timeout·loop_cap), 환경 오버라이드 편집, 데이터셋 바인딩, 프리셋 저장/이름변경/삭제}. | RTL: 상세에서 전 섹션 렌더 | |
| R5 | MUST(불변식): 모든 폼 state는 RunDialog가 소유 → 모드 전환에 값 손실 0; 숨겨진 섹션의 invalid 값도 submit을 막고, 그 사유는 **기존 `blockedReasons` Callout**으로 노출(미렌더라 인라인 에러 부재 보완). | RTL: 상세값 입력→간단→상세 복귀 시 값 유지; 숨긴 invalid가 Run disable + blockedReasons에 사유 | |
| R6 | MUST: 간단 모드에서 숨겨진 상세 설정이 **비기본**이면 "상세 설정 N개 적용됨" 표시(silent config 금지·[[load-divergence-explain-confirm]] 정신). | RTL: 상세값 set 후 간단 전환 시 카운트 표시 | |
| R7 | MUST: 프리셋 **불러오기**=본문 최상단(두 모드, 프리셋 존재 시) / 프리셋 **저장·이름변경·삭제**=본문 최하단(상세만, 실행 직전). | RTL: load strip 위치(최상단)·save 섹션 상세-only·간단에 save 부재 | |
| R8 | MUST: 실시간 요약 strip(sticky footer, 두 모드)을 순수 헬퍼 `runSummary(...)`로 — closed=요청 수 미추정(서버-제한) / open=`목표 RPS·약 rps×duration건·시간` / 곡선=`최대 N (곡선)·총 M초`+스파크라인 / 미완성·invalid=`설정을 확인하세요`(가짜 "0" 금지). | `runSummary` 단위 테스트(모드별·invalid)·RTL 렌더 | |
| R9 | MUST: 측정(`measure_phases`) 토글을 상세에서 **독립 가시 섹션**으로(판정·고급 collapse 밖)·가치 라벨("응답 시간을 DNS·연결·대기·다운로드로 분해") + HelpTip. | RTL: 상세에서 측정 섹션이 고급 collapse 밖에 가시 | |
| R10 | MUST: 기존 편의기능 보존 — 추천 badge(간단·기존 `showRecommended`) · VU/slot 사이징 도우미(두 모드, 접힘, 주 수치 옆) · worker 사이징 도우미(상세) · `StageCurvePreview`(곡선=상세). | RTL `it.each`: 사이징 도우미 렌더 위치 락인 | |
| R11 | MUST(불변식·byte-identical): 같은 필드값 → `profileForm.buildProfile` 출력 Profile이 재디자인 전과 deep-equal. 모드는 가시성만 게이트, buildProfile 입력 경로 불변. | 골든 단위: 간단-기본/대표 입력 → 기존 Profile과 `toEqual`; 라이브 run 1회 | ✅ wire: buildProfile→`POST /api/runs` |
| R12 | MUST(byte-identical): **ScheduleForm 무변경** — `LoadModelFields` 신규 prop(`simpleMode`·타일 표시 등)·`EnvironmentPicker.showOverrides`는 전부 optional이고 ScheduleForm은 미전달 → 렌더 동일. | RTL: 기존 ScheduleForm 테스트 그대로 green + `it.each` 미전달=기존 표시 락인 | |
| R13 | MUST(0-diff): `ui/src/api/schemas.ts`·`crates/**`·proto·migration 무변경. `ko.ts`는 additive(신규 키만, 기존 키 0-diff). | `git diff` 해당 경로 0(ko.ts는 추가-only) | ✅ contract |
| R14 | MUST: 정밀계기(라이트) 룩 — 신규 additive 프리미티브 `ui/Segmented`, `Input`에 optional `numeric`(=`tabular-nums`, 기본 off), eyebrow 라벨 스타일, 헤어라인 구분선 섹션, sticky footer. **기존 6 프리미티브·accent 토큰·차트 색 무변경** → 타 이주 화면 byte-identical. | 신규 프리미티브 단위 테스트 + 기존 폼 화면 스냅샷/테스트 불변 | |
| R15 | MUST: a11y — 세그먼트/타일 `radiogroup`+키보드, focus 가시, 요약 strip은 과도한 live-region 금지(요약은 정적 텍스트), 무애니메이션(reduced-motion 자연 충족). | RTL role/aria + 키보드 | |
| R16 | MUST: 신규 사용자-노출 문구(라벨·aria-label·요약·힌트) 전부 `ko.ts` 경유(ADR-0035), 인라인 영어 0. | grep: 신규 인라인 영어 0 | |

- **seam ✅ = R11(wire byte-identical), R13(contract 0-diff)** — 최종 리뷰가 buildProfile 경로 불변과 0-diff를 1:1 확인.

---

## 3. 핵심 통찰 (설계 근거)

1. **모드는 *가시성*만 게이트한다 → byte-identical(R11)은 구조적으로 보장된다.** 모든 폼 state가 RunDialog 부모에 살아 `buildProfile`은 어느 섹션이 렌더됐는지와 무관하게 같은 입력을 읽는다(R5). 그래서 간단 모드에서 상세 섹션을 **언마운트해도 값이 사라지지 않고**(상태는 부모 소유), 숨긴 invalid도 `canSubmit`이 그대로 막으며 사유는 *이미 존재하는* `blockedReasons` Callout(접힌 고급 그룹의 invalid를 위해 만든 패턴, RunDialog.tsx:799-826)이 노출한다. CSS-hide가 아니라 조건부 렌더로 충분.

2. **간단/상세 게이트와 룩 재디자인을 ScheduleForm으로 새지 않게 — 문서화된 optional-prop 게이트(4회 검증) 재사용.** `LoadModelFields`는 RunDialog+ScheduleForm 공유라, 새 표현(타일·tabular-nums)과 필드 게이트(`simpleMode`)를 **전부 optional prop**으로 추가하고 ScheduleForm은 미전달 → 기존 라디오/라벨 그대로 = byte-identical(R12). `EnvironmentPicker.showOverrides`(기본 true)도 같은 패턴 — 간단 모드만 `false`로 셀렉터-only. 이 결정으로 슬라이스가 RunDialog로 스코프되고 ScheduleForm 회귀 위험 0.

3. **요약은 정직해야 신뢰가 된다(R8).** closed-loop 처리량은 서버-제한이라 요청 수를 예측하면 거짓말 → closed는 "N명·시간"만. open-loop arrival은 결정적이라 `rps×duration`이 정직 → "약 N건". 곡선은 peak+총길이+스파크라인(기존 `StageCurvePreview` 재사용). 미완성/범위밖은 가짜 0 대신 `설정을 확인하세요` amber. 순수 헬퍼라 모드별 단위 테스트로 닫는다.

4. **프리셋은 흐름의 양 끝(bookend)이다(R7).** 불러오기=시작점(아래를 덮어씀)→최상단, 저장=마지막(만든 걸 명명)→최하단. 현 프로덕션 코드가 이미 이 분할(load 위·save 아래)을 갖고 있어 — 회귀가 아니라 보존이다. 불러오기는 되돌아온 사용자 1-클릭 시작이라 두 모드 모두 노출, 저장/관리는 상세-only.

5. **측정(measure_phases)은 "더 자세한 진단을 원하나?" 토글 — 존재를 알려야 쓴다(R9).** 고급 collapse 맨 밑은 너무 깊다. 상세에서 독립 가시 섹션 + 가치 라벨로 올려 발견성을 준다. 단 간단엔 없음(첫 테스트 불필요·리포트 비용↑).

6. **정밀계기 룩은 시스템 폰트 제약 안에서 distinctive(R14).** CSP `default-src 'self'`라 웹폰트 금지 → 시스템 스택 + **모든 수치 `tabular-nums`**(계기 느낌의 핵심) + 대문자 tracked eyebrow 마이크로라벨 + 헤어라인 구분선(고스트 카드/그라데이션/글래스 금지=AI-slop 회피) + 단일 indigo accent. 신규 프리미티브는 `Segmented` 하나만 공유로 올리고(재사용성↑), 나머지(타일·요약 strip·eyebrow)는 RunDialog-국소 + `Input numeric` 옵션 — blast radius 최소.

---

## 4. 변경 상세

> 파일·함수 단위. 각 묶음에 **충족 R** 태그.

### 4.1 `ui/src/components/RunDialog.tsx` — 충족 R: R1·R2·R3·R4·R5·R6·R7·R8·R9·R14·R15·R16
- `const [mode, setMode] = useState<"simple"|"detailed">(...)` — 초기값은 기존 `advancedOpen` 자동펼침 술어(criteriaHasValue·initTT·think_seed·measure_phases·비기본 http_timeout/loop_cap)에 곡선(`deriveLoadMode`)·worker>1을 더한 단일 술어 `hasDetailedPrefill(initial)` → true면 `"detailed"`, else `"simple"`(R2). 이 술어는 `advancedOpen` 초기화와 **공유**(중복 분기 금지).
- 헤더(`<h3>` 행)에 `<Segmented value={mode} onChange={setMode} options=[간단,상세]>`(R1). title은 형제로(accname 오염 금지).
- 본문을 모드로 게이트: 프로파일/measure/고급/바인딩/오버라이드/저장/램프다운/워커 disclosure는 `mode==="detailed"`일 때만 렌더(R3·R4). **state는 그대로 유지**(R5).
- **프리셋 불러오기 strip(기존 RunDialog.tsx:492-513)** → 본문 최상단으로 이동(두 모드, `presets.data?.length>0`). **프리셋 저장/이름변경/삭제(기존 755-791)** → 본문 최하단·상세-only로 이동(R7).
- **측정 토글(기존 744-751, 고급 그룹 내부)** → 상세 독립 섹션으로 승격(R9) — 가치 라벨 + HelpTip. 고급 그룹엔 SLO/스텝SLO/페이싱/http_timeout/loop_cap만 남김.
- **실시간 요약 strip**: sticky footer(실행/취소 옆)에 `runSummary(loadState, ...)` 결과 텍스트 + 곡선이면 `StageCurvePreview` 소형(R8). 두 모드 공통.
- **"상세 설정 N개 적용됨"**: 간단 모드 + `advancedActiveCount>0`(기존 카운트 재사용) || 곡선 || worker>1 || open-loop비기본 → 표시(R6).
- **`blockedReasons` Callout 게이트 일반화(R5 load-bearing)**: 기존 조건은 `!advancedOpen && (httpTimeoutInvalid|loopCapInvalid|thinkInvalid)`(접힌 고급 그룹의 숨은 invalid 노출용, RunDialog.tsx:799-826). 새 모드 모델에선 그 필드들이 간단 모드에서도 미렌더되므로, 조건을 **"해당 필드 섹션이 현재 미렌더"**(= `mode==="simple" || !advancedOpen`)로 일반화해야 숨은 invalid 사유가 계속 보인다(안 하면 간단 모드에서 Run은 disable인데 사유 부재). `bindingBlock` 분기는 모드 무관 유지.
- 모드 전환은 `buildProfile`/`canSubmit`(검증식)/프리셋/풀가드/에러 배너 **로직**을 건드리지 않는다(blockedReasons는 *표시 게이트*라 위처럼 모드를 반영하되, 검증식 자체는 불변).

### 4.2 `ui/src/components/LoadModelFields.tsx` — 충족 R: R3·R4·R10·R12·R14
- 신규 optional props(전부 ScheduleForm 미전달=기존 동작): `simpleMode?: boolean`, `loadModelTiles?: boolean`(타일 표현), `numeric?: boolean`(tabular-nums) — 또는 plan이 단일 `instrument?: boolean`로 묶을 수 있음(미전달=기존 라디오/라벨=byte-identical).
- `simpleMode`일 때 숨김: 프로파일(고정/곡선) fieldset, 곡선 에디터, ramp_down, worker_count disclosure+worker 사이징, open-loop 구조 경고(idle/inert). 유지: 부하모델 선택, 크기 chips(closed), 주 수치 그리드, **VU 사이징 도우미(closed)·slot 사이징 도우미(open)** — 주 수치를 돕는 도우미라 두 모드 공통(R10).
- 부하모델 선택을 `loadModelTiles`면 라디오→**타일**(설명 동반, `radiogroup`)로(R14·R3). 미전달이면 기존 라디오(R12).
- 사이징 도우미 게이트 락인: 기존 `it.each`(미렌더 매트릭스)에 `simpleMode` 축 추가 — VU/slot 도우미는 simple/detail 모두 해당 arm에서 렌더, worker 도우미는 detail-only.

### 4.3 `ui/src/components/EnvironmentPicker.tsx` — 충족 R: R3·R12
- 신규 optional `showOverrides?: boolean`(기본 `true`). `false`면 base-list·오버라이드 행·add-row를 미렌더하고 **환경 셀렉터만**(간단 모드). 기존 호출부(RunDialog 상세·TestRunSection 등)는 미전달=true=byte-identical.

### 4.4 `ui/src/components/runSummary.ts` (신규, 순수) — 충족 R: R8
- `runSummary(input: Pick<LoadModelState, ...>): { text: string; tone: "ok"|"warn"; curve: boolean }`. 모드 분기는 §3.2 표대로. `fmtTime`(초→"5분"/"90초"/"1분 30초") 내장. wire 무접촉(표시 전용).

### 4.5 신규 프리미티브 — 충족 R: R14
- `ui/src/components/ui/Segmented.tsx` — `radiogroup` 세그먼트 컨트롤(active=accent). 공유 프리미티브(재사용).
- `ui/src/components/ui/Input.tsx` — optional `numeric` prop 추가 → `tabular-nums` 클래스(기본 off=기존 byte-identical). 기존 prop/기본 렌더 0-diff.
- eyebrow 라벨: RunDialog/LoadModelFields-국소 유틸 className(`Eyebrow` 컴포넌트는 plan 재량 — 공유 프리미티브로 승격은 선택). 타일·요약 strip은 RunDialog-국소 JSX.

### 4.6 `ui/src/i18n/ko.ts` — 충족 R: R16
- 신규 키만 추가(`ko.runDialog.modeSimple/modeDetail`, `summary*`, `measureTitle/measureDesc`, `appliedDetail(n)`, 타일 라벨/설명, eyebrow 라벨 등). 기존 키 0-diff.

### 4.7 무변경(명시) — `profileForm.ts`·`loadModel.ts`(`buildLoadProfile`/`deriveLoadMode`/`loadModelErrors`)·`schemas.ts`·`DataBindingPanel`·`StageCurvePreview`·사이징 도우미 내부·풀 가드·`client.ts`/`hooks.ts`. §5.

---

## 5. 무변경 / 불변식 (명시)

- **`profileForm.buildProfile`·`buildLoadProfile`·`deriveLoadMode`·`loadModelErrors`·`canSubmit` 로직 0-diff** → 같은 입력=같은 Profile(R11).
- **`ui/src/api/schemas.ts`·`crates/**`·proto·`migrations` 0-diff**(R13). `ko.ts` 추가-only.
- **ScheduleForm byte-identical**(R12) — 신규 prop 미전달.
- **기존 6 프리미티브(Field/Input 기본/Select/Section/Callout/Badge)·`accent` 토큰·차트 색(`#2563eb`·runLabel 팔레트·StatusBadge) 0-diff**(R14) → 타 이주 화면 회귀 0. (`Input`은 새 optional `numeric`만 추가, 기본 렌더 불변.)
- 프리셋/SLO/데이터 바인딩/풀 과부하 가드/환경 오버레이 **기능 동작 불변** — 위치·룩만 변경.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1·R3·R4 | RTL: 토글 클릭/키보드→상세 섹션 렌더·간단에서 미렌더 | |
| R2 | RTL: detailed-value prefill→상세, plain→간단 | |
| R5 | RTL: 상세값 입력→간단→상세 값 유지; 숨긴 invalid가 Run disable + blockedReasons 사유 | |
| R6 | RTL: 상세값 set→간단 전환→"N개 적용됨" | |
| R7 | RTL: load strip 최상단·save 상세-only | |
| R8 | `runSummary` 단위(closed/open/곡선/invalid) + RTL 렌더 | |
| R9 | RTL: 상세에서 측정 섹션 고급 collapse 밖 가시 | |
| R10 | RTL `it.each`: 사이징 도우미 렌더 매트릭스(simpleMode 축 포함) | |
| R11 | **골든 단위**: 대표 입력들 → buildProfile `toEqual` 기존 Profile + **라이브 run 1회**(간단·상세 각 1) | ✅ |
| R12 | 기존 ScheduleForm 테스트 green + `it.each` 미전달 락인 | |
| R13 | `git diff --stat`로 schemas/crates/proto/migration 0 | |
| R14 | Segmented 단위 + 기존 폼 화면 테스트 불변 | |
| R15 | RTL role/aria/키보드 | |
| R16 | grep: 신규 인라인 영어 0 (라벨·aria-label) | |

- **라이브 검증 필수**(R11·S-D 갭): RunDialog는 run-생성 경로 → 머지 전 `/live-verify`로 간단·상세 각각 run 1회 생성→리포트 도달 + console Zod 0. RTL fixture는 absent-not-null이라 서버 응답경로 버그를 못 잡는다.

---

## 7. 의도적 연기 (roadmap §B12에 누적)

- **프리셋 복제(1-클릭 clone) 버튼**: 능력은 이미 존재(불러오기→이름 변경→저장=신규명 save-as) — 복제는 *단축*이지 누락 기능 아님. 4번째 관리 버튼 추가 + "저장 프리셋 vs 현재 폼 state" 의미 모호 + 신규 *동작*(이 슬라이스의 시각/구성 스코프 밖). 별도 작은 후속(클라 POST + 자동 "(복사본)" 명명).
- **ReportView 측정 유도 힌트**("이 리포트엔 단계 분해가 없습니다 — 다음 실행에서 측정을 켜보세요"): 발견성 보강이나 *다른 표면*(ReportView), 별도 슬라이스.
- **다크 "콘솔" 테마**: 공유 프리미티브(Input/Select/Field)의 다크 변형이 필요해 blast radius·디자인 시스템 리스크가 크고 라이트 페이지와 대비 — 트리거-기반 별도 검토.
- **모드 선택 localStorage 영속**: YAGNI — 기본은 콘텐츠 기반(prefill 상세값→상세, else 간단).
- **ScheduleForm 동일 재디자인**: 이 슬라이스는 byte-identical 유지. 일관성 확산은 후속(§B12).

---

## 8. 구현 순서 (plan 입력)

> cargo 무영향(UI-only) → pre-commit은 UI 게이트(`pnpm lint && pnpm test && pnpm build`)만. tdd-guard: **테스트 파일 편집을 src보다 먼저**(ui/CLAUDE.md). 각 task는 독립 green 커밋.

1. **토대(additive)**: `Segmented` 프리미티브 + `Input` `numeric` 옵션 + `runSummary.ts` 순수 헬퍼 + `ko.ts` 신규 키 — 각 테스트와 함께 green.
2. **공유 컴포넌트 게이트**: `EnvironmentPicker.showOverrides` + `LoadModelFields`(`simpleMode`/타일/numeric) — `it.each` 미렌더/ScheduleForm 미전달 락인 동반(R12).
3. **RunDialog 조립**: 모드 state+`Segmented`·섹션 게이트·프리셋 bookend 재배치·측정 승격·요약 footer·"N개 적용됨"·정밀계기 룩 — RTL(R1~R9·R15) + 골든 byte-identical(R11) 동반.
4. **검증**: 전체 `pnpm lint && pnpm test && pnpm build` + grep(R13·R16) + `/live-verify`(간단·상세 run 각 1, R11).

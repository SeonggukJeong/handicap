# timeout-knob-ui — ScheduleForm connect timeout 입력·해제 + 적용 타임아웃 사후 리포트 노출

- **날짜**: 2026-08-03 · **유형**: user-path · **슬라이스 브랜치**: `worktree-timeout-knob-ui`
- **연관**: error-taxonomy E3(`0ecc9821`, ADR-0050 — connect_timeout 8계층 와이어를 깐 슬라이스; 이 슬라이스는 그 spec §2 Non-goals의 "ScheduleForm connect_timeout 입력 (연기)"의 회수) · S-A 타임아웃(`http_timeout_seconds` 도입) · report-advice-noise(`6b0a776` — 리포트 밀도 규율)
- **ADR**: 불필요 — additive UI 표면 2곳, 새 결정 축 없음(와이어·서버 계약 무변경). E3 연기 항목의 회수는 ADR-0050이 이미 참조 맥락을 든다.
- **서버/proto/migration diff**: **0** — UI-only. 근거는 §9 클레임 레저 C1·C2·C8.

## 사용자 스토리 (US)

- **US1**: QA가 야간 스케줄로 도는 부하에 connect timeout을 걸어 connect 지연을 별도 분류로 잡으려는 상황에서, 스케줄 편집 폼에 입력이 없어 API를 직접 호출해야 한다 — 성공하면 스케줄 폼에서 connect timeout(초)을 입력·저장하고, 그 스케줄이 발사한 run의 profile에 `connect_timeout_seconds`가 실려 있는 것을 본다.
- **US2**: QA가 (API로 설정됐거나 과거에 넣은) 스케줄의 connect timeout을 해제하려는 상황에서, 현재 UI로는 지울 방법이 없고 편집-저장하면 값이 그대로 보존된다(pass-through) — 성공하면 폼에서 값을 비우고 저장해, 이후 발사되는 run에 connect timeout이 더 이상 적용되지 않는 것을 본다.
- **US3**: 운영자가 timeout/connect_timeout 분류가 섞인 리포트를 해석하는 상황에서, "이 run에 어떤 타임아웃이 걸려 있었나"를 리포트에서 확인할 수 없어 RunDialog 재현 설정이나 API 조회로 우회해야 한다 — 성공하면 명시 설정된 타임아웃 노브(http/connect)의 값이 리포트에 표시되어, 리포트만으로 "connect 5s 제한이 걸린 run이었다"를 안다 (미설정 run은 기존 리포트와 0-diff).

## 1. 배경·문제

E3가 `connect_timeout_seconds`를 UI(RunDialog)→Zod→store→검증→proto→워커→reqwest 8계층으로 관통시켰지만 두 표면을 의도적으로 연기했다:

1. **ScheduleForm**: 입력 없이 pass-through만 구현(C4) — API로 설정된 스케줄의 값은 편집-저장 시 보존되고, http_timeout과 모순이면 저장이 차단되지만, **UI로 설정할 수도 해제할 수도 없다**(roadmap-status 영역 E 행의 "현재 저장값을 UI로 지울 수 없다").
2. **리포트**: terminal run은 `ReportView`만 렌더되는데 적용된 타임아웃 노브를 보여주는 표면이 없다(C7) — transport 분류표에 `connect_timeout`이 잡혀도 "이 run에 몇 초 제한이 걸려 있었나"를 리포트에서 알 수 없다.

## 2. 범위 / Non-goals

**범위**: ① ScheduleForm connect timeout 입력(설정·해제·검증) ② 리포트/Run 상세의 적용 타임아웃 노출(**타임아웃 2종만** — 사용자 결정 2026-08-03) ③ 노출은 **명시 설정 시에만**(기본값 run은 0-diff — 사용자 결정 2026-08-03, report-advice-noise 밀도 규율).

**Non-goals (연기·제외)**:
- 타임아웃 외 노브(think time 적용 여부·measure_phases·ramp_down cap 등)의 리포트 노출 — 사용자 결정으로 2종 한정.
- per-step `HttpStep.timeout_seconds` 오버라이드의 리포트 노출 — run-level 노브만(스텝별 오버라이드는 시나리오 스냅샷 YAML에서 확인 가능).
- export(CSV/XLSX)·비교 뷰의 타임아웃 표시 — 연기.
- 공유 `TimeoutFields` 컴포넌트 추출(B안) — 두 폼의 레이아웃 이디엄이 달라(Field+hint vs 인라인 라벨 스팬) 추출물이 prop 분기 투성이가 됨. 드리프트는 공유 `buildProfile`(C2)과 동일 검증식 미러 + 테스트가 억제.
- ScheduleForm의 인라인 에러 `<p>` 신설 — 이 폼은 "막힘 사유 블록" 방식(C5)이므로 그 이디엄 유지.
- RunDialog·서버 검증 변경 — 무접촉.

## 3. ScheduleForm 입력 (US1·US2)

**현재 상태**(C1): `connectTimeout` string state는 이미 존재(`ScheduleForm.tsx:100-101`, init 시드)하고 공유 `buildProfile`에 전달되며(`:261`), `buildProfile`은 빈 문자열이면 키 자체를 생략한다(C2). 없는 것은 **입력 UI**뿐이다.

**변경**:

1. **입력 추가**: httpTimeout 입력 블록(`ScheduleForm.tsx:347-363`, C5 — `max-w-xs` div > `label` > 라벨 스팬 + `Input aria-label`) 바로 아래에 같은 이디엄으로 connect timeout number 입력 추가. ko 키는 RunDialog와 동일 재사용(C6): 라벨·aria-label = `ko.loadModel.connectTimeout`, placeholder = `ko.loadModel.connectTimeoutPlaceholder`("비워두면 미설정"). state는 기존 `connectTimeout`(string — 빈 문자열이 "미설정"의 표현이므로 httpTimeout처럼 number로 바꾸지 않는다).
2. **검증 교체**: 기존 `connectTimeoutConflict`(`:231` — 저장값 pass-through 전용, `>= httpTimeout`만 검사)를 RunDialog와 동일식(C3)의 `connectTimeoutInvalid`로 교체: `connectTimeout.trim() !== "" && (!Number.isInteger(Number(connectTimeout)) || < 1 || > 600 || >= httpTimeout)`. `canSubmit`에서 `!connectTimeoutConflict`를 `!connectTimeoutInvalid`로 교체. 막힘 사유 블록(C5)의 항목을 `ko.validation.connectTimeoutStored(n)`에서 **`ko.validation.connectTimeout`**(RunDialog가 쓰는 일반 문구, C6)으로 교체.
3. **orphan 정리**: `ko.validation.connectTimeoutStored`는 교체 후 사용처가 0이 된다(C11 — 현재 사용처는 ScheduleForm:454·그 테스트:244·ko.ts 정의 3곳 전수) → 키 삭제. 기존 테스트 2건(C12)은 재작성: `:184`(pass-through 라운드트립)는 "init 시드 → 무수정 저장 시 보존"으로 의미 유지, `:214`(저장값 공개 문구)는 입력이 생겨 전제("이 폼엔 입력이 없다")가 사라지므로 일반 검증 문구·저장 차단 단언으로 교체.
4. **해제(US2)**: 칸을 비우고 저장 → `buildProfile`이 키 생략(C2, 기존 동작) → 서버에 `connect_timeout_seconds` 부재로 저장. 신규 코드 불요, 테스트로 고정.

서버측은 무변경: 스케줄 create/update가 `validate_run_config`를 이미 통과시키고(C8) 그 안에 1..=600·`< http_timeout` 검증이 있다(C9). UI 검증은 그보다 먼저 막는 역할(기존 RunDialog와 동일 분담).

## 4. 리포트 표면 (US3)

**신규 컴포넌트** `ui/src/components/report/AppliedTimeouts.tsx`:

- **입력**: `profile: Profile` (ReportView가 이미 받는 prop, C7 — `RunDetailPage.tsx:237`에서 `normalizeProfile(r.profile)` 통과라 `http_timeout_seconds`는 항상 number(기본 30), `connect_timeout_seconds`는 `.optional()`(C10)).
- **렌더 게이트**: `profile.connect_timeout_seconds != null || profile.http_timeout_seconds !== 30` — 아니면 `null` (기본값 run 0-diff).
- **표시**: muted 한 줄(비대화형·roleless·`text-sm text-slate-600` 계열, 정확 클래스는 plan에서 이웃과 정합 확인): `적용 타임아웃 — 요청 {N}s · 연결 {M}s`. connect 미설정이면 `· 연결 …` 세그먼트 생략, `http === 30`(connect만 설정된 경우)이면 `요청 30s (기본값)`으로 병기해 맥락 보존.
- **배치**: `ReportView.tsx`의 `<Summary>` 직전(`:164` 앞) — 해석 표면(Validity/Verdict/Insight) 뒤·수치 앞.
- **한계(명시)**: `http_timeout_seconds`는 non-optional 와이어(C10 — store `u32`, UI가 항상 emit)라 "명시로 30을 넣은 run"과 "기본 30"을 원리적으로 구별할 수 없다 → 값 30은 일괄 "(기본값)" 취급. 30을 명시한 사용자에게 잃는 정보는 없다(적용값 자체는 30으로 동일).

**RunDetailPage 비-terminal profile `<ul>`**(C7, `:260-273` — running/report-less run의 raw wire-값 목록): 같은 게이트의 `<li>` 2줄 추가 — `http_timeout = {N}s`(`!== 30`일 때)·`connect_timeout = {M}s`(설정 시). 이 목록의 기존 이디엄(font-mono·wire 필드명)을 유지한다.

## 5. 카피 (ko 카탈로그, ADR-0035)

신규 키는 `ko.report` 아래(정확 값은 plan에서 확정하되 아래를 기본으로):

- `appliedTimeoutsLead` = `"적용 타임아웃"`
- `appliedTimeoutsHttp(n)` = `요청 {n}s` (템플릿 함수)
- `appliedTimeoutsHttpDefault` = `"요청 30s (기본값)"`
- `appliedTimeoutsConnect(n)` = `연결 {n}s` (템플릿 함수)

규율: ① 신규↔기존 카탈로그 **양방향 부분문자열 포함관계** sweep(thinkboard-defaults 함정 — `toHaveTextContent`는 부분문자열 매칭) ② `ko.*(n)` 보간 단언은 자기참조 공허(11호) — 렌더된 숫자 별도 단언 병기 ③ 삭제 키 = `validation.connectTimeoutStored` 1개.

## 6. 테스트 전략

**ScheduleForm RTL**(기존 파일 확장):
- 입력 렌더 + init 시드(`initial.profile.connect_timeout_seconds` → 칸에 표시).
- 설정 저장: 값 입력 → 저장 → `onSubmit` payload `profile.connect_timeout_seconds === N`(number).
- 해제 저장(US2 핵심): 시드된 폼에서 칸 비움 → 저장 → payload `expect(profile).not.toHaveProperty("connect_timeout_seconds")` (조건부 spread 계약 — `undefined` 대입이면 이 단언이 잡는다).
- invalid(`>= httpTimeout`·범위 밖·비정수): 저장 버튼 disabled + 막힘 사유 블록에 `ko.validation.connectTimeout` 표시. **비정수 케이스는 "abc"가 아니라 "1.5"로**(HTML5 number sanitize 함정 — ui/CLAUDE.md).
- 기존 2건(C12) 재작성은 §3-3.

**AppliedTimeouts RTL**(신규 파일): 렌더 조건 4분기 — ① connect set·http 30 → 라인 + "(기본값)" ② connect set·http≠30 → 두 세그먼트 숫자 ③ connect 미설정·http≠30 → 요청 세그먼트만 ④ 둘 다 기본 → `container.firstChild === null`. 숫자는 별도 `toContain("5")` 병기(§5-②).

**RunDetailPage RTL**: 비-terminal fixture에 노브 설정 → `<li>` 존재; 기본 run → 부재.

**이빨 실증**: 회귀 가드 표방 테스트(특히 US2 `not.toHaveProperty`·렌더 게이트)는 고의 회귀(조건부 spread를 `field: undefined` 대입으로 / 게이트 상수 뒤집기)→RED→원복→GREEN을 구현 중 실증한다([[plan-mandated-vacuous-tests]]).

**게이트(2-상태)**: baseline `pnpm lint && pnpm test && pnpm build` = **이미 green 실측**(C13 — lint=0·test 2407/210 files·build=0, 2026-08-03 이 워크트리). 변경 후 동일 3게이트 + 신규 테스트 포함 green이 DoD. cargo 게이트는 `.rs` 0-diff라 pre-commit이 skip(전 게이트 체인은 훅이 판정).

## 7. 라이브 검증 (`/live-verify` — run-생성/report-파싱 경로 접촉이라 필수)

US-anchored (규약 `docs/dev/user-story-spine.md`):

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 스케줄 폼에서 connect 5s 입력 + `once` 근미래 트리거로 저장 → 발사 대기 | 발사된 run의 `GET /api/runs/{id}` `profile.connect_timeout_seconds === 5` |
| US2 | 같은 스케줄 편집 → 칸 비움 → `once` 재설정 저장 → 발사 대기 | `GET /api/schedules/{id}` profile에 키 부재 **및** 다음 발사 run profile에 키 부재 |
| US3 | US1 run 리포트 열람 + 대조로 미설정 run 리포트 열람 | 설정 run: "적용 타임아웃 — … 연결 5s" 라인 렌더(실제 DOM) / 미설정 run: 라인 부재 / 양쪽 콘솔 Zod 에러 0 |

비-terminal `<li>` 표면은 RTL로 고정하고 라이브는 기회 되면(run 도는 동안) 확인 — 필수 신호는 위 3행.

## 8. 보안 게이트

예상 N/A(diff가 요청실행·템플릿/캐스트·env/데이터셋 바인딩·업로드파싱·trace/body 뷰어 무접촉) — 단 **판정은 finish-slice §0 grep이 지배**(think-time-defaults 함정: 예측 신뢰 금지). 신규 sink 없음: 표시값은 이미 리포트 JSON에 실려 오던 profile 필드의 재표시다.

## 9. 클레임 레저 (사실 주장 → 생성 명령; 디스패치 전 일괄 재실행 대상)

| # | 주장 | 명령 | 결과 요지 |
|---|---|---|---|
| C1 | ScheduleForm은 `connectTimeout` state를 이미 소유·시드·builder에 전달, 입력 UI만 없음 | `grep -n "connectTimeout" ui/src/components/ScheduleForm.tsx` | `:100-101` 시드 · `:229-231` conflict · `:261` builder 전달 · 입력 JSX 0건 |
| C2 | `buildProfile`은 connectTimeout 빈 문자열/미전달이면 키 생략(조건부 spread) | `sed -n '139,160p' ui/src/components/profileForm.ts` | `...(i.connectTimeout && trim !== "" ? {connect_timeout_seconds: Number} : {})` |
| C3 | RunDialog 검증식 = 비어있지 않음 && (!정수 ‖ <1 ‖ >600 ‖ >= httpTimeout) | `sed -n '389,394p' ui/src/components/RunDialog.tsx` | 동일식 확인 |
| C4 | E3 spec이 ScheduleForm 입력을 명시 연기 | `grep -n "ScheduleForm" docs/superpowers/specs/2026-08-01-error-taxonomy-design.md` | `:40` "폼 입력은 RunDialog만 v1 (연기)" |
| C5 | ScheduleForm httpTimeout 입력 이디엄·막힘 사유 블록 구조 | `sed -n '347,362p;444,470p' ui/src/components/ScheduleForm.tsx` | 인라인 라벨 스팬 + `aria-label` · blockedReasons Callout |
| C6 | ko 키 실존: `loadModel.connectTimeout{,Hint,Placeholder}` · `validation.connectTimeout` | `grep -n "connectTimeout" ui/src/i18n/ko.ts` | `:198-201` · `:250` |
| C7 | terminal run은 ReportView만 렌더(적용 노브 표면 無)·profile prop 수신·비-terminal은 raw `<ul>` | `sed -n '236,274p' ui/src/pages/RunDetailPage.tsx` · `grep -n "profile" ui/src/components/report/ReportView.tsx` | `:237` `<ReportView profile={normalizeProfile(...)}>` · `:255-274` ul(vus/duration/ramp_up/vu_stages뿐) |
| C8 | 스케줄 create/update는 `validate_run_config` 통과 | `grep -n "validate_run_config" crates/controller/src/api/schedules.rs` | `:182` |
| C9 | 서버 검증: connect 1..=600 · `< http_timeout` | `sed -n '418,431p' crates/controller/src/api/runs.rs` | 확인 |
| C10 | Zod: http `.default(30)`(항상 직렬화) · connect `.optional()`(skip_serializing_if) · store http `u32` non-optional | `grep -n "http_timeout_seconds\|connect_timeout_seconds" ui/src/api/schemas.ts crates/controller/src/store/runs.rs` | schemas `:75`·`:103` · store `:128`·`:167` |
| C11 | `connectTimeoutStored` 사용처 전수 = 3곳(교체 후 orphan) | `grep -rn "connectTimeoutStored" --include="*.ts" --include="*.tsx" <워크트리 루트>` (경계 없는 재귀) | ScheduleForm.tsx:454 · ScheduleForm.test.tsx:244 · ko.ts:251 |
| C12 | 기존 ScheduleForm connect 테스트 2건(라운드트립 보존·저장값 공개 문구) | `grep -n -B4 -A8 "connect_timeout" ui/src/components/__tests__/ScheduleForm.test.tsx` | `:184` · `:214` |
| C13 | baseline UI 게이트 green | `cd ui && pnpm lint; pnpm test; pnpm build` (각 `echo exit=$?`) | lint=0 · test=0(2407) · build=0 |

## 10. 알려진 한계 (수용)

- 값 30의 명시/기본 구별 불가(§4 한계 — 와이어 계약상 원리적).
- 슬라이스 이전의 과거 run도 노브가 설정돼 있었다면 리포트 라인이 **소급 표시**된다 — 리포트는 조회 시 재계산 자산이라 기존 성질(E2 소급 발행과 동류), 정보로서 옳으므로 수용.
- ScheduleForm에는 connect 인라인 에러 `<p>`가 없다(막힘 사유 블록만) — RunDialog와 표시 위치가 다르지만 이 폼의 기존 이디엄(C5 주석 "인라인 aria-invalid만 있고 에러 p가 없다")과 일관.

# timeout-knob-ui — ScheduleForm connect timeout 입력·해제 + 적용 타임아웃 사후 리포트 노출

- **날짜**: 2026-08-03 · **유형**: user-path · **슬라이스 브랜치**: `worktree-timeout-knob-ui`
- **연관**: error-taxonomy E3(`0ecc9821`, ADR-0050 — connect_timeout 8계층 와이어를 깐 슬라이스; 이 슬라이스는 그 spec §2 Non-goals의 "ScheduleForm connect_timeout 입력 (연기)"의 회수) · S-A 타임아웃(`http_timeout_seconds` 도입) · report-advice-noise(`6b0a776` — 리포트 밀도 규율)
- **ADR**: 불필요 — additive UI 표면 2곳, 새 결정 축 없음(와이어·서버 계약 무변경). E3 연기 항목의 회수는 ADR-0050이 이미 참조 맥락을 든다.
- **서버/proto/migration diff**: **0** — UI-only. `schemas.ts`는 **와이어 계약 무변경**(변경은 기본값 상수 `DEFAULT_HTTP_TIMEOUT_SECONDS` 정의 + `.default(상수)` 참조 치환뿐 — 값 동일이라 파싱 동작 byte-identical, §5). 근거는 §9 클레임 레저 C1·C2·C8·C10.

## 사용자 스토리 (US)

- **US1**: QA가 야간 스케줄로 도는 부하에 connect timeout을 걸어 connect 지연을 별도 분류로 잡으려는 상황에서, 스케줄 편집 폼에 입력이 없어 API를 직접 호출해야 한다 — 성공하면 스케줄 폼에서 connect timeout(초)을 입력·저장하고, 그 스케줄이 발사한 run의 profile에 `connect_timeout_seconds`가 실려 있는 것을 본다.
- **US2**: QA가 (API로 설정됐거나 과거에 넣은) 스케줄의 connect timeout을 해제하려는 상황에서, 현재 UI로는 지울 방법이 없고 편집-저장하면 값이 그대로 보존된다(pass-through) — 성공하면 폼에서 값을 비우고 저장해, 이후 발사되는 run에 connect timeout이 더 이상 적용되지 않는 것을 본다.
- **US3**: 운영자가 timeout/connect_timeout 분류가 섞인 리포트를 해석하는 상황에서, "이 run에 어떤 타임아웃이 걸려 있었나"를 리포트에서 확인할 수 없어 RunDialog 재현 설정이나 API 조회로 우회해야 한다 — 성공하면 명시 설정된 타임아웃 노브(http/connect)의 값이 리포트에 표시되어, 리포트만으로 "connect 5s 제한이 걸린 run이었다"를 안다 (미설정 run은 기존 리포트와 0-diff). **보조 관찰**: 아직 리포트가 없는 *실행 중* run 상세에서도 같은 조건으로 노브를 확인할 수 있다(raw profile 목록의 `<li>`).

## 1. 배경·문제

E3가 `connect_timeout_seconds`를 UI(RunDialog)→Zod→store→검증→proto→워커→reqwest 8계층으로 관통시켰지만 두 표면을 의도적으로 연기했다:

1. **ScheduleForm**: 입력 없이 pass-through만 구현(C4) — API로 설정된 스케줄의 값은 편집-저장 시 보존되고, http_timeout과 모순이면 저장이 차단되지만, **UI로 설정할 수도 해제할 수도 없다**(roadmap-status 영역 E 행의 "현재 저장값을 UI로 지울 수 없다").
2. **리포트**: terminal run은 `ReportView`만 렌더되는데 적용된 타임아웃 노브를 보여주는 표면이 없다(C7) — transport 분류표에 `connect_timeout`이 잡혀도 "이 run에 몇 초 제한이 걸려 있었나"를 리포트에서 알 수 없다.

## 2. 범위 / Non-goals

**범위**: ① ScheduleForm connect timeout 입력(설정·해제·검증) ② 리포트/Run 상세의 적용 타임아웃 노출(**타임아웃 2종만** — 사용자 결정 2026-08-03) ③ 노출은 **명시 설정 시에만**(기본값 run은 0-diff — 사용자 결정 2026-08-03, report-advice-noise 밀도 규율).

**Non-goals (연기·제외)**:
- 타임아웃 외 노브(think time 적용 여부·measure_phases·ramp_down cap 등)의 리포트 노출 — 사용자 결정으로 2종 한정.
- per-step `HttpStep.timeout_seconds` **값의** 리포트 노출 — run-level 노브만. 단 오도 방지 꼬리 문구는 §4에 포함(리뷰 R1 — "요청 30s"만 보고 스텝 오버라이드를 배제하는 오독 차단).
- export(CSV/XLSX)·비교 뷰의 타임아웃 표시 — 연기.
- 공유 `TimeoutFields` **레이아웃 컴포넌트** 추출(B안) — 두 폼의 레이아웃 이디엄이 달라(Field+hint vs 인라인 라벨 스팬) 기각. 단 **검증 술어와 기본값 상수는 공유한다**(§3-2, 리뷰 F4 — 레이아웃 논거로 로직 공유까지 기각하지 않는다).
- 서버 검증 변경 — 무접촉. RunDialog는 **기계적 추출-호출·상수 치환 diff만** 허용(§3-2 술어 공유·§5 상수 — 동작 byte-identical, 신규 UI 없음).
- ScheduleForm의 인라인 에러 `<p>` 신설 — 이 폼은 "막힘 사유 블록" 방식(C5)이므로 그 이디엄 유지(인라인 신호는 `aria-invalid`만, §3-1).

## 3. ScheduleForm 입력 (US1·US2)

**현재 상태**(C1·C14): `connectTimeout`은 **state가 아니라 init 파생 plain const**(`ScheduleForm.tsx:100-101`, setter 없음 — 리뷰 F1이 spec 초판의 "state 이미 존재" 오류를 정정)로, 공유 `buildProfile`에 전달만 된다(`:261`). `buildProfile`은 빈 문자열이면 키 자체를 생략한다(C2). 없는 것은 **입력 UI와 편집 가능한 state**다.

**변경**:

1. **입력 추가**: `connectTimeout`을 `const` → `useState(init?.connect_timeout_seconds != null ? String(...) : "")`로 전환(시드 안전 근거: `SchedulesPage.tsx:142`가 `key={editingId ?? "new"}`로 리마운트하므로 reseed effect 불요 — C15, 기존 RunDialog reseed-by-key 패턴과 동일). httpTimeout 입력 블록(`ScheduleForm.tsx:347-362`, C5 — `max-w-xs` div > `label` > 라벨 스팬 + `Input aria-label`) 바로 아래에 같은 이디엄으로 connect timeout number 입력 추가:
   - 라벨·aria-label = `ko.loadModel.connectTimeout`, placeholder = `ko.loadModel.connectTimeoutPlaceholder`(C6).
   - `aria-invalid={connectTimeoutInvalid}` 필수(리뷰 모호성 해소 — §2가 인라인 `<p>`를 금지했으므로 이것이 유일한 인라인 신호).
   - **hint 노출**(리뷰 R7): 입력 아래 muted 한 줄(`text-xs text-slate-500` 계열 `<p>`)로 `ko.loadModel.connectTimeoutHint`(C6 — "HTTP 타임아웃보다 작게"의 유일한 사전 안내)를 표시하고 `aria-describedby`로 연결. placeholder만으로는 순서 제약이 사전에 안 보인다. id는 `useId()`로(RunDialog.tsx:235 패턴 — 이 폼 최초의 id 도입이므로 하드코딩 금지, 리뷰 N3).
2. **검증 술어 공유**(리뷰 F4/R2 결정): `profileForm.ts`(두 폼의 기존 공유 모듈)에 순수 술어 **`isConnectTimeoutDraftInvalid(draft: string, httpTimeout: number): boolean`** 신설 — 식은 RunDialog 현행(C3)과 동일: `draft.trim() !== "" && (!Number.isInteger(Number(draft)) || < 1 || > 600 || >= httpTimeout)`. RunDialog(`RunDialog.tsx:389-394`)는 인라인 식을 이 호출로 교체(동작 byte-identical — 기존 RunDialog 테스트가 가드), ScheduleForm은 기존 `connectTimeoutConflict`(`:231`)를 이 호출 결과 `connectTimeoutInvalid`로 교체. `canSubmit`의 `!connectTimeoutConflict`(`:242`)도 교체. 막힘 사유 블록(C5)의 항목을 `ko.validation.connectTimeoutStored(n)`에서 **`ko.validation.connectTimeout`**(RunDialog와 동일 문구, C6)으로 교체.
3. **stale 주석 정리**(리뷰 R3): 무효가 되는 주석 3곳을 같은 task에서 갱신 — `ScheduleForm.tsx:98-99`("폼 입력은 RunDialog만…pass-through"), `:229-230`("pass-through된 connect_timeout이…"), **`profileForm.ts:133-134`**(공유 모듈 계약 docstring "ScheduleForm은 초기값을 pass-through만 한다"). 거짓 근거 주석은 코드 결함보다 오래 산다([[review-findings-are-hypotheses]]).
4. **orphan 정리**: `ko.validation.connectTimeoutStored`는 교체 후 사용처가 0이 된다(C11 — 현재 사용처는 ScheduleForm:454·그 테스트:244·ko.ts 정의 3곳 전수) → 키 삭제. 기존 테스트 2건(C12)은 재작성: `:184`(pass-through 라운드트립)는 "init 시드 → 무수정 저장 시 보존"으로 의미 유지, `:214`(저장값 공개 문구)는 입력이 생겨 전제("이 폼엔 입력이 없다")가 사라지므로 일반 검증 문구·저장 차단 단언으로 교체.
5. **해제(US2)**: 칸을 비우고 저장 → `buildProfile`이 키 생략(C2, 기존 동작) → 서버에 `connect_timeout_seconds` 부재로 저장. 신규 코드 불요, 테스트로 고정(§6의 시드 중간-상태 단언 필수).

서버측은 무변경: 스케줄 create/update가 `validate_run_config`를 이미 통과시키고(C8) 그 안에 1..=600·`< http_timeout` 검증이 있다(C9). update는 profile **전체 교체**라 키 부재 저장이 성립하고, 발사 시 `sched.profile`이 그대로 `spawn_run`에 넘어간다(C16 — US1·US2의 end-to-end 전제).

## 4. 리포트 표면 (US3)

**공유 게이트 헬퍼**(리뷰 R2): 표시 판정을 순수 헬퍼 한 벌로 — `appliedTimeoutKnobs(p: { http_timeout_seconds?: number; connect_timeout_seconds?: number | null }): { http: number; connect: number | null; show: boolean }`. 배치는 **`ui/src/api/runPrefill.ts`**(리뷰 N7 — `profileDurationSeconds`/`seedBindingsFrom` 등 leak-free 헬퍼의 집이고, `profileForm.ts`에 두면 report 컴포넌트가 폼 모듈을 import하게 된다). 입력 타입을 **느슨한 구조 타입**으로 두는 이유: `AppliedTimeouts`는 `normalizeProfile` 통과 `Profile`(C7 — http 항상 number)을 받지만 RunDetailPage 비-terminal `<ul>`은 **raw `r.profile`**(RunSchema 중첩 `.default()` 누출 → `number|undefined`)을 읽는다 — `Pick<Profile,…>`로 받으면 raw 쪽에서 `tsc -b`가 깨진다(ui/CLAUDE.md 누출 함정). 내부에서 `http = p.http_timeout_seconds ?? DEFAULT_HTTP_TIMEOUT_SECONDS` 정규화. `show = connect != null || http !== DEFAULT_HTTP_TIMEOUT_SECONDS`.

**신규 컴포넌트** `ui/src/components/report/AppliedTimeouts.tsx`:

- **입력**: `profile: Profile`(ReportView가 이미 받는 prop, C7) + `hasStepTimeoutOverride: boolean`(ReportView가 이미 파싱하는 시나리오 모델에서 `flattenHttpSteps(model.steps).some(s => s.timeout_seconds != null)`로 도출 — C17, `timeout_seconds`는 `HttpStepModel` 루트 필드. `flattenHttpSteps`는 loop/parallel/if 완전 재귀라 중첩 오버라이드도 잡히며, `scenarioHasThink`(`model.ts:284-287`)가 동일 이디엄의 기존 선례다. 파싱 실패 시 `false` = 꼬리 생략, fail-soft §10).
- **렌더 게이트**: `appliedTimeoutKnobs(profile).show` — 아니면 `null` (기본값 run 0-diff).
- **표시**: muted 한 줄(비대화형·roleless·`text-sm text-slate-600` 계열, 정확 클래스는 plan에서 이웃과 정합 확인): `적용 타임아웃 — 요청 {N}s · 연결 {M}s`. connect 미설정이면 `· 연결 …` 세그먼트 생략, `http === 30`(connect만 설정된 경우)이면 `요청 30s (기본값)`으로 병기해 맥락 보존. **오도 방지 꼬리**(리뷰 R1 — spec 결정): `hasStepTimeoutOverride`가 참이면 `· 일부 스텝은 자체 타임아웃 사용` 세그먼트를 덧붙인다 — per-step 오버라이드(C17)가 run-level보다 짧으면 그 스텝은 run 기본과 다른 타임아웃으로 동작하므로(서버 store 주석이 문서화, `store/runs.rs:162-165` — C9), 꼬리 없이는 "요청 30s"가 거짓 진술이 된다. 값 노출은 비목표(§2) — 존재 신호만.
- **배치**: `ReportView.tsx`의 `<Summary>` 직전(`:164` 앞) — 해석 표면(Validity/Verdict/Insight) 뒤·수치 앞.
- **한계(명시)**: `http_timeout_seconds`는 non-optional 와이어(C10 — store `u32`, UI가 항상 emit)라 "명시로 30을 넣은 run"과 "기본 30"을 원리적으로 구별할 수 없다 → 값 30은 일괄 "(기본값)" 취급. 30을 명시한 사용자에게 잃는 정보는 없다(적용값 자체는 30으로 동일).

**RunDetailPage 비-terminal profile `<ul>`**(C7, `:260-273` — running/report-less run의 raw wire-값 목록, US3 보조 관찰): **줄별 게이트**(리뷰 모호성 해소 — 공통 게이트 아님)의 `<li>` 2줄 추가 — `http_timeout = {N}s`는 `!== 30`**일 때만**, `connect_timeout = {M}s`는 설정 시**에만**. 따라서 connect만 설정된 run은 connect 줄만 뜬다(raw 목록은 해석 표면이 아니라 wire-값 나열이므로 기본값 병기 불요 — AppliedTimeouts의 "(기본값)" 맥락 병기와 역할이 다르다). 기존 이디엄(font-mono·wire 필드명) 유지. 판정은 같은 `appliedTimeoutKnobs` 헬퍼 결과에서 도출(줄별 조건: `connect != null` / `http !== DEFAULT`).

## 5. 카피 (ko 카탈로그, ADR-0035) + 기본값 상수

**공유 상수**(리뷰 R5·N1·N2): **`ui/src/api/schemas.ts`에 `export const DEFAULT_HTTP_TIMEOUT_SECONDS = 30` 신설 + `:75`의 `.default(30)`을 `.default(DEFAULT_HTTP_TIMEOUT_SECONDS)`로 치환** — 클라이언트의 권위 기본값(Zod)과 상수가 같은 정의를 공유하는 진짜 단일 소스(리뷰 N2 옵션 (a); 값 동일이라 파싱 동작 byte-identical, header 참조). 서버 기본과는 lockstep 주석(C10 — store serde default). 소비처 교체는 **비교 3곳 + 시드 2곳 전수 5곳**(리뷰 N1 — C18 재실측: `RunDialog.tsx:167,291,422`의 `!== 30`과 `RunDialog.tsx:124`·`ScheduleForm.tsx:97`의 `useState(... ?? 30)`, 기계적 same-value diff). §4 헬퍼·ko 템플릿이 이 상수를 소비 — 카피에 30이 하드코딩되지 않는다.

신규 키는 `ko.report` 아래(정확 값은 plan에서 확정하되 아래를 기본으로):

- `appliedTimeoutsLead` = `"적용 타임아웃"`
- `appliedTimeoutsHttp(n)` = `요청 {n}s` (템플릿 함수)
- `appliedTimeoutsHttpDefault(n)` = `요청 {n}s (기본값)` (템플릿 함수 — 30 하드코딩 금지)
- `appliedTimeoutsConnect(n)` = `연결 {n}s` (템플릿 함수)
- `appliedTimeoutsStepOverride` = `"일부 스텝은 자체 타임아웃 사용"` (R1 꼬리)

규율: ① 신규↔기존 카탈로그 **양방향 부분문자열 포함관계** sweep — 단 `appliedTimeoutsHttpDefault(n) ⊃ appliedTimeoutsHttp(n)`는 **구조적으로 불가피**(전자가 후자 + " (기본값)")하므로 이 쌍은 §6의 **전체일치 단언 의무**로 방어한다(리뷰 R5 — thinkboard-defaults 함정) ② `ko.*(n)` 보간 단언은 자기참조 공허(11호) — 렌더된 숫자 별도 단언 병기 ③ 삭제 키 = `validation.connectTimeoutStored` 1개.

## 6. 테스트 전략

**ScheduleForm RTL**(기존 파일 확장):
- 입력 렌더 + init 시드(`initial.profile.connect_timeout_seconds` → 칸에 표시).
- 설정 저장: 값 입력 → 저장 → `onSubmit` payload `profile.connect_timeout_seconds === N`(number).
- 해제 저장(US2 핵심, 리뷰 R4-a 하드닝): 시드된 폼에서 **먼저 `expect(input).toHaveValue(3)` 중간-상태 단언**(시드가 깨지면 빈 칸 → `not.toHaveProperty`가 공허 통과하는 auto-seed 클래스 차단) → 칸 비움 → 저장 → payload `expect(profile).not.toHaveProperty("connect_timeout_seconds")`.
- invalid(`>= httpTimeout`·범위 밖·비정수): 저장 버튼 disabled + 막힘 사유 블록에 `ko.validation.connectTimeout` 표시. **비정수 케이스는 "abc"가 아니라 "1.5"로**(HTML5 number sanitize 함정 — ui/CLAUDE.md).
- hint a11y(리뷰 N6): `expect(input).toHaveAccessibleDescription(ko.loadModel.connectTimeoutHint)` — R7로 새로 노출하는 표면의 `aria-describedby` 배선 가드.
- 기존 2건(C12) 재작성은 §3-4.

**AppliedTimeouts RTL**(신규 파일): 렌더 조건 분기 — ① connect set·http 30 → 라인 + "(기본값)" ② connect set·http≠30 → 두 세그먼트 숫자 ③ connect 미설정·http≠30 → 요청 세그먼트만 ④ 둘 다 기본 → `container.firstChild === null` ⑤ 꼬리: `hasStepTimeoutOverride` true → 꼬리 세그먼트 존재 / false → 부재. **①·②를 구별하는 단언은 전체일치**(`/^…$/` 또는 `textContent` 정확 비교 — §5-① substring 포함관계 방어). 숫자는 별도 `toContain("5")` 병기(§5-②).

**RunDetailPage RTL**: 비-terminal fixture에 노브 설정 → 해당 `<li>`만 존재(줄별 게이트 — connect만 설정 fixture에서 http 줄 **부재** 단언 포함); 기본 run → 둘 다 부재.

**이빨 실증**(리뷰 R4-b — 주입 지점 교정): US2 `not.toHaveProperty`의 고유 가드 대상은 "입력→state→builder **배선**"이다. 공유 builder의 조건부 spread를 `field: undefined` 대입으로 바꾸는 주입은 **기존 `profileForm.test.ts:250-263`(C19)이 이미 RED로 잡는 코드**라 새 테스트의 이빨을 증명하지 못한다 → 주입은 **ScheduleForm 쪽**으로: `connectTimeout`을 다시 init 파생 const로 되돌려(사용자 clear 무시) 새 테스트만 RED·`profileForm.test.ts`는 green으로 남는 것까지 확인. 렌더 게이트 테스트의 주입은 게이트 상수/부등호 뒤집기.

**게이트**: baseline `pnpm lint && pnpm test && pnpm build` = green 실측(C13 — lint=0·test 2407/210 files·build=0). 이 슬라이스의 **baseline 부재 신호는 게이트가 아니라 C1**("입력 JSX 0건"·리포트 표면 無 — 리뷰 지적대로 게이트 2-상태가 아니라 상태 실측 + 부재 실측의 짝이다). 변경 후 동일 3게이트 + 신규 테스트 포함 green이 DoD. cargo 게이트는 `.rs` 0-diff라 pre-commit이 skip(전 게이트 체인은 훅이 판정).

## 7. 라이브 검증 (`/live-verify` — 필수)

**필수 근거(정정, 리뷰 지적)**: `schemas.ts`는 파싱 형상 무변경(§5 상수 치환뿐)이라 S-D 클래스(서버 `null`↔`.optional()`)는 구조적으로 발생 불가 — 라이브가 필요한 진짜 이유는 **스케줄 payload → 스케줄러 발사 → run profile 전파의 end-to-end**(RTL이 못 밟는 경로, US1·US2)다. US3은 순수 렌더지만 실 리포트 DOM으로 확인한다.

레시피 보강(리뷰 R6): 컨트롤러를 **`--scheduler-tick-seconds 5`**로 띄운다(기본 30s — 대기 단축, C16). 발사된 run id는 **`GET /api/schedules/{id}`의 `last_run_id`**(C16)로 얻는다(`GET /api/runs` 목록 엔드포인트 없음 — 루트 CLAUDE.md).

US-anchored (규약 `docs/dev/user-story-spine.md`):

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 스케줄 폼에서 connect 5s 입력 + `once` 근미래 트리거로 저장 → 발사 대기(≤5s tick) → `last_run_id` 조회 | 발사된 run의 `GET /api/runs/{id}` `profile.connect_timeout_seconds === 5` |
| US3' (보조 li) | US1 run이 도는 동안(duration을 30s 이상으로) `/runs/{id}` 상세 열람 | raw profile 목록에 `connect_timeout = 5s` `<li>` 렌더(실행 중 = 리포트 없음 상태) |
| US2 | 같은 스케줄 편집 → 칸 비움 → `once` 재설정 저장 → 발사 대기 | `GET /api/schedules/{id}` profile에 키 부재 **및** 다음 발사 run profile에 키 부재 |
| US3 | US1 run 종료 후 리포트 열람 + 대조로 미설정 run 리포트 열람 | 설정 run: "적용 타임아웃 — … 연결 5s" 라인 렌더(실제 DOM) / 미설정 run: 라인 부재 / 양쪽 콘솔 Zod 에러 0 |

## 8. 보안 게이트

예상 N/A(diff가 요청실행·템플릿/캐스트·env/데이터셋 바인딩·업로드파싱·trace/body 뷰어 무접촉) — 단 **판정은 finish-slice §0 grep이 지배**(think-time-defaults 함정: 예측 신뢰 금지). 신규 sink 없음: 표시값은 이미 리포트 JSON에 실려 오던 profile 필드의 재표시다.

## 9. 클레임 레저 (사실 주장 → 생성 명령; 디스패치 전 일괄 재실행 대상)

| # | 주장 | 명령 | 결과 요지 |
|---|---|---|---|
| C1 | ScheduleForm의 `connectTimeout`은 **init 파생 const**(setter 없음, 리뷰 F1 정정)·builder에 전달·입력 JSX 0건 | `grep -n "connectTimeout" ui/src/components/ScheduleForm.tsx` · `sed -n '97,102p'` 동파일 | `:100-101` `const connectTimeout =` · `:261` builder 전달 · 입력 JSX 0건 |
| C2 | `buildProfile`은 connectTimeout 빈 문자열/미전달이면 키 생략(조건부 spread) | `sed -n '139,160p' ui/src/components/profileForm.ts` | `...(i.connectTimeout && trim !== "" ? {connect_timeout_seconds: Number} : {})` |
| C3 | RunDialog 검증식 = 비어있지 않음 && (!정수 ‖ <1 ‖ >600 ‖ >= httpTimeout) | `sed -n '389,394p' ui/src/components/RunDialog.tsx` | 동일식 확인 |
| C4 | E3 spec이 ScheduleForm 입력을 명시 연기 | `grep -n "ScheduleForm" docs/superpowers/specs/2026-08-01-error-taxonomy-design.md` | `:40` "폼 입력은 RunDialog만 v1 (연기)" |
| C5 | ScheduleForm httpTimeout 입력 이디엄(`:347-362`)·막힘 사유 블록 구조 | `sed -n '347,362p;444,470p' ui/src/components/ScheduleForm.tsx` | 인라인 라벨 스팬 + `aria-label` + `aria-invalid` · blockedReasons Callout |
| C6 | ko 키 실존: `loadModel.connectTimeout{,Hint,Placeholder}` · `validation.connectTimeout` | `grep -n "connectTimeout" ui/src/i18n/ko.ts` | `:198-201` · `:250` |
| C7 | terminal run은 ReportView만 렌더(적용 노브 표면 無)·profile prop 수신·비-terminal은 raw `<ul>`(`:260-273`) | `sed -n '236,274p' ui/src/pages/RunDetailPage.tsx` · `grep -n "profile" ui/src/components/report/ReportView.tsx` | `:237` `<ReportView profile={normalizeProfile(...)}>` · `<ul>`=260-273(vus/duration/ramp_up/vu_stages뿐) |
| C8 | 스케줄 create/update는 `validate_run_config` 통과 | `grep -n "validate_run_config" crates/controller/src/api/schedules.rs` | `:182` |
| C9 | 서버 검증: connect 1..=600 · `< http_timeout` (+ 인접 `:162-166` per-step 상호작용 문서화) | `sed -n '418,431p' crates/controller/src/api/runs.rs` · `sed -n '160,167p' crates/controller/src/store/runs.rs` | 확인 |
| C10 | Zod: http `.default(30)`(항상 직렬화) · connect `.optional()`(skip_serializing_if) · store http `u32` non-optional | `grep -n "http_timeout_seconds\|connect_timeout_seconds" ui/src/api/schemas.ts crates/controller/src/store/runs.rs` | schemas `:75`·`:103` · store `:128`·`:167` |
| C11 | `connectTimeoutStored` 사용처 전수 = 3곳(교체 후 orphan) | `grep -rn "connectTimeoutStored" --include="*.ts" --include="*.tsx" <워크트리 루트>` (경계 없는 재귀) | ScheduleForm.tsx:454 · ScheduleForm.test.tsx:244 · ko.ts:251 (리뷰어 재확인: `ko.test.ts` 무참조 — 삭제 안전) |
| C12 | 기존 ScheduleForm connect 테스트 2건(라운드트립 보존·저장값 공개 문구) | `grep -n -B4 -A8 "connect_timeout" ui/src/components/__tests__/ScheduleForm.test.tsx` | `:184` · `:214` |
| C13 | baseline UI 게이트 green | `cd ui && pnpm lint; pnpm test; pnpm build` (각 `echo exit=$?`) | lint=0 · test=0(2407/210 files) · build=0 (리뷰어 독립 재실측 일치) |
| C14 | `connectTimeout` const 선언 원문(F1 근거) | `sed -n '97,102p' ui/src/components/ScheduleForm.tsx` | `const connectTimeout = init?... ? String(...) : ""` |
| C15 | SchedulesPage가 key로 리마운트(useState 시드 안전) | `sed -n '140,144p' ui/src/pages/SchedulesPage.tsx` | `key={editingId ?? "new"}` |
| C16 | 스케줄러 tick 기본 30s(`--scheduler-tick-seconds`) · `ScheduleResponse.last_run_id` 존재 · 발사 시 `sched.profile` 그대로 `spawn_run` | `sed -n '88,96p' crates/controller/src/main.rs` · `grep -n "last_run_id" crates/controller/src/api/schedules.rs` · `grep -n "spawn_run" crates/controller/src/schedule/runner.rs` | `default_value_t = 30` · `:78`·`:152` · runner `:189`(리뷰어 확인) |
| C17 | `timeout_seconds`는 `HttpStepModel` 루트 optional 필드 | `sed -n '85,100p' ui/src/scenario/model.ts` | `:95` (request가 아니라 step 루트) |
| C18 | `30` 하드코딩 전수 = 비교 3곳 + 시드 2곳(테스트 제외 src 전수, 리뷰 N1 확장) | `grep -rn "?? 30\|== 30" ui/src --include="*.tsx" --include="*.ts" \| grep -v __tests__` | RunDialog `:124`(시드)·`:167`·`:291`·`:422` · ScheduleForm `:97`(시드) — 5곳 외 0건 |
| C19 | 조건부 spread는 기존 유닛 테스트가 커버(이빨 주입 지점 판단 근거) | `sed -n '250,263p' ui/src/components/__tests__/profileForm.test.ts` | 미전달/빈문자열 키 생략·값 숫자 적재 3건 |

## 10. 알려진 한계 (수용)

- 값 30의 명시/기본 구별 불가(§4 한계 — 와이어 계약상 원리적).
- 슬라이스 이전의 과거 run도 노브가 설정돼 있었다면 리포트 라인이 **소급 표시**된다 — 리포트는 조회 시 재계산 자산이라 기존 성질(E2 소급 발행과 동류), 정보로서 옳으므로 수용.
- ScheduleForm에는 connect 인라인 에러 `<p>`가 없다(막힘 사유 블록 + `aria-invalid` + hint) — RunDialog와 표시 위치가 다르지만 이 폼의 기존 이디엄(C5 주석 "인라인 aria-invalid만 있고 에러 p가 없다")과 일관.
- R1 꼬리는 시나리오 파싱 실패 시 생략(fail-soft) — 파싱 실패 리포트는 stepMeta도 비어 스텝 이름 전반이 degraded인 기존 상태라 일관.
- 스텝 오버라이드 꼬리는 **존재 신호만**(값·개수 미노출 — §2 비목표). 오버라이드가 run-level보다 *긴* 경우도 같은 꼬리(방향 구분 없음).

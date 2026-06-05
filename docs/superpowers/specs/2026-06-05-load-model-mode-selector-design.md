# 부하 모드 선택기 (2축 보존 RunDialog 리팩터) — 설계

- 날짜: 2026-06-05
- 출처: `docs/roadmap.md` §D 연기 항목 "부하모델 모드 선택기 (UX, 별도 슬라이스)" (line 127)
- 성격: **UI-only** 리팩터 (UX 명료화 + 코드 건강 + 불변식 락인). 엔진·proto·컨트롤러·마이그레이션 무변경.
- ADR: 불요 (아키텍처 결정 아님, additive UI 변경)

---

## 1. 배경 / 동기

영역 D(S-A 타임아웃 / S-B think time / S-C open-loop / S-D stages)가 완결되며 `RunDialog`에 부하 모델 knob이 쌓였고, 일부 조합은 서버가 거부한다(`POST /api/runs` → 400). 로드맵은 2026-06-04 S-D brainstorm 시점에 "RunDialog 상단 라디오로 *관련 필드만* 노출 → 상호배타 400들을 표현 불가능하게"를 연기 항목으로 적었다.

### 1.1 착수 시 발견: 400은 이미 UI 구조로 막혀 있다

로드맵 항목은 RunDialog가 더 평평하던 시점에 적힌 것이고, **S-C/S-D 구현 과정에서 모드 게이팅이 이미 점진적으로 들어왔다.** 현재 `ui/src/components/RunDialog.tsx`:

- `loadModel: "closed" | "open"` 라디오(`RunDialog.tsx:69`) + open 안에 `rateMode: "fixed" | "curve"` 라디오(`RunDialog.tsx:81`) — 2단계 중첩이지만 사실상 3-way 모드.
- `buildProfile()`(`RunDialog.tsx:303`)이 모드별로 충돌 필드를 애초에 안 보냄:
  - **closed** → `{ vus, duration_seconds, ramp_up_seconds, think_time, think_seed }` (no `target_rps`/`stages`/`max_in_flight`)
  - **open + fixed** → `{ vus:0, duration_seconds, ramp_up_seconds:0, target_rps, max_in_flight }` (no `think_time`/`stages`)
  - **open + curve** → `{ vus:0, duration_seconds:0, ramp_up_seconds:0, max_in_flight, stages }` (no `target_rps`/`think_time`)
- think time(pacing) 섹션은 `loadModel === "closed"`일 때만 렌더(`RunDialog.tsx:901`). ramp-up도 closed 전용.

서버 `validate_run_config`(`crates/controller/src/api/runs.rs:62`)가 거부하는 조합 —
`open + ramp_up_seconds>0`(`runs.rs:87`), `open + think_time`(`runs.rs:92`), `stages + target_rps`(`runs.rs:100`), `stages + duration_seconds>0`(`runs.rs:105`) — 은 **현재 폼 조작으로 만들 수 없다.** 로드맵이 적은 "검증을 UI 구조로 흡수"는 이미 달성돼 있다.

### 1.2 그래서 이 슬라이스의 실제 가치 (버그 방지가 아니라)

1. **UX 명료성** — 중첩 라디오(open을 고른 뒤 2차 "레이트" 라디오가 나타나는 걸 알아채야 함)를 **2축을 명시한 구조**로 다듬어 발견성을 높인다.
2. **코드 건강** — RunDialog 1046줄, `http_timeout` 입력이 **3곳**(`RunDialog.tsx:514`, `:599`, `:755`), `max_in_flight`가 **2곳**(`RunDialog.tsx:574`, `:737`)에 복붙. 모드 부분을 focused 유닛으로 추출하며 중복 제거.
3. **불변식 락인** — "각 모드는 자기 필드만 emit" 계약 테스트로 미래 knob이 400을 재유발 못 하게.

---

## 2. 핵심 모델: 3개가 아니라 2축 4사분면

```
              fixed              curve (stages)
  closed │ 고정 VU      ✅     │ VU 곡선        🔜 (연기)
  open   │ 고정 레이트  ✅     │ 레이트 곡선    ✅
```

- 현재 중첩 라디오(`loadModel` closed/open × `rateMode` fixed/curve)는 **이미 이 2축을 정확히 반영**한다 — 단지 `rateMode`를 open일 때만 노출할 뿐.
- 3개 사분면이 구현됐고, **closed+curve(VU 곡선)만 빈칸**. S-D가 의도적으로 남겼다(`docs/roadmap.md:126` — "closed-loop stages(VU 곡선+retire/ramp-down)는 별도 미래 슬라이스 연기 — 비대칭 반쪽 기피").
- **결정: 평탄화하지 않고 2축을 보존·명료화.** 단일 3-way로 평탄화하면 이 구조를 버리게 되고, 4번째가 들어올 때 리스트가 4개로 늘거나 중첩으로 되돌려야 한다. 2축 보존은 4번째 사분면 추가 시 재작업 0.

---

## 3. 범위 / 비범위

### 범위 (UI-only)
1. 숨어 있던 2차 축(Fixed/Curve)을 **closed-loop에도 노출**해 2축을 명시화; **closed+curve는 disabled + "곧 지원"**.
2. 모드 셀렉터 + 사분면별 필드 패널 + buildProfile 모드 분기를 **순수함수 + presentational 컴포넌트**로 추출.
3. `http_timeout`(3곳) · `max_in_flight`(2곳) **중복 제거**.
4. "모드당 자기 필드만 emit" **불변식 테스트**.

### 비범위
- 엔진·proto·컨트롤러·마이그레이션 **무변경**.
- 서버 `validate_run_config`는 권위 게이트로 **그대로 유지**(defense-in-depth — UI는 잘못된 조합을 *표현 불가능*하게 만들 뿐, 검증 제거 아님).
- 프리셋 CRUD / SLO 기준 / pacing / 환경 picker / 데이터바인딩 섹션은 **안 건드림**(직교, 이미 동작).
- 제출 payload는 현재와 **byte-identical**(같은 buildProfile 결과) — 서버 동작 무변경.
- VU 곡선(closed+curve) 실제 실행 = **별도 미래 슬라이스**(엔진이 stages를 VU 곡선에 적용).

---

## 4. 셀렉터 UI

라디오 2행(둘 다 `fieldset` + `legend` — 기존 idiom 유지):

```
부하 모델   (●) Closed-loop (VU)    ( ) Open-loop (rate)
프로파일    (●) 고정                ( ) 곡선
            └ closed일 때 '곡선'은 disabled + "곧 지원" 힌트

[선택된 사분면의 필드만 아래에 렌더]
```

- **상태 변수**: 신규 state *변수* 없음 — 기존 `loadModel: "closed"|"open"` × `rateMode: "fixed"|"curve"` 그대로(이미 2축). 단 아래 리셋/disable **배선은 신규 로직**이다("동작 무변경" 아님 — 리뷰 I-2).
- **closed → fixed 리셋 (신규 배선)**: 오늘은 `rateMode` 라디오·curve 필드가 `loadModel==="open"` else-분기(`RunDialog.tsx:528`) 안에만 있어 closed일 때 `rateMode`가 무관(harmless)했다. 2차 축을 closed에도 노출하므로 명시 처리 필요 — **(a)** closed 라디오 `onChange`에서 `setRateMode("fixed")` **즉시 리셋(eager)** + **(b)** 2차 축 '곡선' 라디오는 `loadModel==="closed"`일 때 `disabled`. 이 둘이 함께 "closed인데 curve" 상태를 도달 불가능하게 한다(curve 필드 렌더·`buildLoadProfile` curve 분기 모두 안 탐). 통합 테스트로 락인(§8 신규 #2).
- **라벨**: 1차 축 라디오는 기존 테스트 정규식(`/closed-loop/i`, `/open-loop/i`)을 보존하도록 `closed-loop`/`open-loop` 부분문자열 유지. 2차 축 라디오는 `고정`/`곡선`(`/곡선/` 보존). **2차 축 fieldset legend = `프로파일`(확정)** — "레이트"는 closed에 안 맞아 교체하고, 신규 §8 테스트가 이 legend(`getByRole("group", {name:/프로파일/i})`)를 질의하므로 구현·테스트가 합의하도록 **미리 못박음**("구현 시 확정" 금지 — 새 테스트가 단언하는 문자열을 미루는 건 repo footgun, 리뷰 I-5).
- **폼 형태 결정**: 세그먼트 컨트롤 대신 **라디오 유지**. 기존 RunDialog 테스트가 `getByRole("radio", {name})`에 의존(`ui/src/components/__tests__/RunDialog.test.tsx:796`, `:831`, `:861`, `:892` 등)하므로 세그먼트(버튼)로 바꾸면 라디오-role 단언이 전부 깨진다. "다듬고 명료화" 방향과도 정합.

---

## 5. 컴포넌트 분해

코드베이스의 **순수함수 + presentational 컴포넌트** 패턴 따름(`resolveEnv`+`EnvironmentPicker`, `compareReports`+`CompareMatrix`).

### 5.1 `ui/src/components/loadModel.ts` (순수)
- 타입 `LoadModelState`(loadModel, rateMode, vus, duration, rampUp, targetRps, maxInFlight, stages, httpTimeout, think* … RunDialog가 이미 들고 있는 모드 관련 필드).
- `buildLoadProfile(state): Pick<Profile, …>` — `buildProfile`의 모드 분기(`RunDialog.tsx:310-343`)를 이관. 입력은 정규화된 숫자 state, 출력은 모드별 Profile 부분.
- `loadModelErrors(state)` 또는 boolean 플래그 모음 — `targetRpsInvalid`/`maxInFlightInvalid`/`stagesInvalid`/`rampInvalid` 등 모드 관련 검증(`RunDialog.tsx:208-258`)을 이관.
- **불변식 테스트가 이 파일에 붙는다(§7).**

### 5.2 `ui/src/components/LoadModelFields.tsx` (presentational, controlled)
- 2축 셀렉터 + 사분면별 필드 입력 + stages 에디터 + 곡선 미리보기.
- **Controlled**: 상태·setter를 props로 받음(state 소유권은 RunDialog — `EnvironmentPicker` 패턴). 프리셋 load / retry prefill의 reseed-by-key 불변식(`ui/CLAUDE.md` "RunDialog/DataBindingPanel prefill 은 reseed-by-key")을 그대로 유지하기 위해 state는 RunDialog가 계속 소유.
- 기존 `StageCurvePreview`(`ui/src/components/StageCurvePreview.tsx`) · `LOAD_SHAPES`(`ui/src/components/loadShapes.ts`) 재사용.
- stages 인라인 JSX(`RunDialog.tsx:614-769`)가 커서 `LoadModelFields`가 비대해지면 `StagesEditor`로 추가 분리 — 구현 중 판단(YAGNI, 강제 아님).

### 5.3 `RunDialog.tsx`
- state 소유 유지(프리셋/prefill 배선 무변경).
- `buildProfile()` = `{ ...base, ...buildLoadProfile(state) }`. `base`(loop_breakdown_cap / http_timeout_seconds / data_binding / criteria, `RunDialog.tsx:304`)는 그대로.
- 모드 JSX는 `<LoadModelFields …/>` 한 줄로 대체. SLO/pacing/env/binding/preset 섹션은 위치·동작 무변경.
- `canSubmit`(`RunDialog.tsx:259`)의 모드 관련 항은 `loadModelErrors`로 위임, 그 외(loopCap/httpTimeout/binding/pending)는 RunDialog 유지.

---

## 6. 중복 제거

- **`http_timeout`**: 3개 모드 그리드의 복붙 입력(`RunDialog.tsx:514`, `:599`, `:755`) → **모드 패널 아래 공유 입력 1개**(모든 모드 공통 transport 설정). 검증 `httpTimeoutInvalid`는 RunDialog 유지(모드 무관).
- **`max_in_flight`**: fixed/curve 두 곳(`RunDialog.tsx:574`, `:737`) → **open일 때 1개**(두 open 서브모드 공통).

---

## 7. 불변식 테스트 (이 슬라이스의 락인)

**두 층으로 분리** — 순수 함수가 보장할 수 있는 것(필드 존재/부재)과 게이팅이 보장하는 것(숫자 범위)을 섞지 않는다(리뷰 I-3).

### 7.1 순수 `buildLoadProfile` 필드-형태 불변식 — `ui/src/components/__tests__/loadModel.test.ts`
모드별로 충돌 필드의 **존재/부재**만 단언(입력 state는 유효값으로 고정). `buildLoadProfile`은 정규화된 숫자 state의 순수 함수라 *형태*만 보장한다:

- **closed** → `target_rps`/`stages`/`max_in_flight` **부재**.
- **open + fixed** → `stages`/`think_time` **부재**, `ramp_up_seconds===0`; `target_rps`·`max_in_flight` **존재**.
- **open + curve** → `target_rps`/`think_time` **부재**, `ramp_up_seconds===0`, `duration_seconds===0`; `stages`(비어있지 않음)·`max_in_flight` **존재**.

이 필드-형태가 `validate_run_config`(`crates/controller/src/api/runs.rs:87-143`)의 *조합* 거부 규칙(`open+ramp_up>0`/`open+think_time`/`stages+target_rps`/`stages+duration>0`)을 표현 불가능하게 만든다. **주의**: `think_time`은 **closed에서 허용**, open에서만 금지다(`runs.rs:92`) — closed 분기가 `think_time`을 emit하는 건 정상이고 단언 대상이 아니다.

### 7.2 숫자 범위 게이팅은 `canSubmit` (RunDialog 통합 테스트, 다른 층)
`vus>0`·`duration_seconds>0`·`target_rps`/`max_in_flight` 범위·`stages` 유효성은 **순수 함수가 아니라 `canSubmit`**(`RunDialog.tsx:259`)이 막는다(Run 버튼 disabled). `buildLoadProfile`에 `vus>0` 같은 숫자 단언을 기대하지 말 것(함수가 그 입력엔 `vus:0`을 그대로 emit한다 — 보장 못 함). 이 층은 RunDialog 통합 테스트로 검증(예: `vus:0`이면 Run 버튼 disabled).

미래 knob 추가가 모드 격리를 깨면 §7.1이 RED.

---

## 8. 테스트 / 동작 보존

기존 RunDialog 테스트는 전부 `ui/src/components/__tests__/RunDialog.test.tsx`에 있다(주의: `__tests__/` 하위 — 리뷰 I-1). 보존 대상:

- **라디오-role 단언**: `/closed-loop/i`, `/open-loop/i`, `/곡선/`(`:796`/`:831`/`:861`/`:892`). 1·2차 축 라벨 부분문자열 유지로 통과.
- **fieldset group 단언**: `getByRole("group", {name:/부하 모델/i})`(`:829`) — 1차 축 legend 유지.
- **라벨-기반 입력 단언(중요 — 리뷰 I-4)**: `getByLabelText(/HTTP timeout/i)`(`:308`/`:1037`/`:1064`, closed 모드) · `getByLabelText("Max in-flight")`(`:898`, curve) · `/max in.?flight/i`(`:851`, fixed). dedup 후에도 각 모드에서 정확히 **1개**이며, 단일화된 입력은 **정확한 `aria-label`(`"HTTP timeout (s)"` / `"Max in-flight"`) + `aria-invalid` + `aria-describedby`(`"http-timeout-error"` / `"max-in-flight-error"`) 와이어링을 그대로 유지**해야 한다. 단일화는 입력 *개수*만 줄이고 라벨·a11y는 보존(이게 깨지면 위 라벨 테스트가 RED).

신규 RTL:
1. closed 선택 시 2차 축 '곡선' 라디오 `disabled` + 2차 fieldset legend `/프로파일/i`로 접근.
2. open+curve→closed 전환 시 `rateMode`가 fixed로 리셋(closed+curve 도달 불가).
3. http_timeout·max_in_flight 입력이 각 모드에서 단 1개.
4. closed/open-fixed/open-curve 제출 payload 동일: §7.1 순수 단위 + RunDialog 통합(mutation 인자 검사).

- **게이트**: `pnpm lint && pnpm test && pnpm build`(전체 — targeted green ≠ full green, `ui/CLAUDE.md`). `tsc -b`로 Zod default 누출/discriminated union 미스매치 확인.
- 라이브 run은 payload byte-identical이라 회귀 위험 낮으나, 머지 전 RunDialog로 closed/open-fixed/open-curve 각 1회 생성 권장(`ui/CLAUDE.md` "run 생성/응답-파싱 경로는 RTL·tsc로 안 잡힌다 — 라이브 run 1회").

---

## 9. 비범위 / 연기

- VU 곡선(closed+curve) 실제 실행 = 별도 미래 슬라이스(엔진 stages→VU 적용 + retire/ramp-down).
- 부하모델 modifier(Poisson 분포, per-VU rate cap, churn, max_iterations — `docs/roadmap.md:128`)는 모드 안 서브옵션 — 후속.
- "부하모델 모드 선택기"를 넘어선 RunDialog 전면 리팩터(프리셋/SLO/env 재배치)는 범위 밖.

---

## 10. 참고

- `docs/roadmap.md` §D (line 119–128) — 영역 D 완결 + 모드 선택기 연기 항목 + VU 곡선 연기.
- `crates/controller/src/api/runs.rs:62` `validate_run_config` — 권위 검증 게이트(이 슬라이스가 미러할 거부 규칙).
- `ui/src/components/RunDialog.tsx` — 현재 구현(loadModel/rateMode/buildProfile/중복 입력).
- `ui/CLAUDE.md` — 다단계 ramp UI 섹션, prefill reseed-by-key, optional 섹션 접이식, 전체 vs targeted pnpm test.
- ADR-0031(open-loop) / ADR-0032(stages) — 모드 의미의 권위 정의.

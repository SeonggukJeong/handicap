# open-loop think time UX — 서버측 검증 + 실행-레벨 무시 토글 + 관측 RPS 앵커

- **날짜**: 2026-07-15
- **상태**: 설계 (spec-plan-reviewer 대기)
- **출처**: roadmap §B21 (think-time-defaults `security-reviewer`(Opus) APPROVED-with-Medium 2건 후속). 사용자 브레인스토밍(2026-07-15)에서 §B21 ②를 "경고"에서 "실행-레벨 무시 토글 + 매끄러운 open↔closed 스위칭"으로 확장.
- **ADR**: 신규 불필요 (근거 §12).

---

## 1. 문제 (§B21 배경)

think-time-defaults(2026-07-13)가 시나리오 루트 `default_think_time{min_ms,max_ms}`를 http 스텝이 상속하게 하면서, 그 슬라이스의 보안 리뷰가 Medium 2건을 남기고 R6(proto/controller 0-diff)를 지키려 후속으로 분리했다:

1. **서버측 think time 범위 검증 부재**: `POST /api/scenarios`는 `Scenario::from_yaml`만 돌린다. 손편집/curl YAML의 `min_ms: 5000, max_ms: 100`(엔진 `ThinkTime::sample`의 `max.max(min)`이 조용히 **고정 5초**로 degrade — `crates/engine/src/pacing.rs:25`)이나 거대한 `max_ms`가 서버를 통과한다. UI Zod(`ThinkTimeModel`, `0 ≤ min ≤ max ≤ 600000`)만 막고 서버는 안 막는다. `default_think_time`은 한 줄이 **모든 http 스텝**에 퍼져 영향 범위가 크다(= 조용한 부하 divergence, 사용자 상시 규칙 위반). run-level `think_time`은 이미 `runs.rs`가 검증한다(비대칭).

2. **open-loop 정책 비대칭**: run-level `think_time`은 open-loop에서 **거부**되는데(`crates/controller/src/api/runs.rs:301`, "open-loop에선 run-level think_time을 쓸 수 없습니다"), 그 시나리오-와이드 아날로그인 `default_think_time`(+스텝 think)은 open-loop에서 **적용되고 `max_in_flight` 슬롯을 점유**한다. Zod 허용 범위 내의 큰 값이면 슬롯이 전부 잡혀 대부분 도착이 `dropped`가 되는데, **생성 시점 경고가 없다**(`openLoopChecks`의 `inert_slots`는 슬롯 *과다*만 경고하고 *과소*는 경고 안 함).

브레인스토밍에서 사용자는 "순수 경고는 불편하다 — open-loop 실행에 think time 변경을 강요하면 안 된다"고 방향을 잡았고, 실제 user journey를 그려 **가장 편한 조작 모델**을 요구했다.

---

## 2. User journeys

**J1 — 정확한 목표 RPS로 때리기 (가장 흔함)**
QA: "결제 API가 500 RPS 견디나?" → open-loop, `target_rps=500`. think는 무관하고 있으면 슬롯만 점유해 방해. **원하는 조작**: open 선택 → 500 입력 → 실행. 시나리오에 think가 있어도 신경 쓰지 않고 싶다.

**J2 — 현실적 사용자 N명 시뮬레이션**
운영팀: "동시 200명이 로그인→조회→로그아웃, 단계 사이 1~3초 생각" → closed-loop, `vus=200`, `think=1~3s`. RPS는 *결과*. think가 부하 throttle 겸 현실성.

**J3 — 같은 시나리오로 두 관점을 오감 (핵심 — 스위칭)**
J2로 200명 돌려 ~180 RPS 관측 → "그럼 딱 300 RPS로 밀면?" → open-loop 전환, `target_rps=300`. **마찰 두 개**: (a) closed용 think가 open에서 슬롯 점유(§1-② 버그), (b) "300"을 어디서 정하나 — 직전 180 RPS를 기준 삼고 싶다.

---

## 3. 설계 원칙

**think time은 두 부하모델에서 의미가 다르다**:
- closed-loop: think가 *rate를 만드는 주역* (`RPS ≈ VUs / (지연+think)`) + 페이싱 현실성.
- open-loop: rate는 `target_rps`가 정하고, think는 **슬롯만 점유**(도착률 불변, 슬롯 과소면 드롭).

사용자 마찰의 근원은 이 이중성이다. 편함의 열쇠 = **"무엇을 제어하고 싶은가(처리량이냐 사용자 수냐)"로 모델을 고르게 하고, think 처리는 자동으로.** 목표 RPS는 예외 없이 open-loop가 정답이며, think를 배율로 주물러 RPS를 맞추는 접근은 비채택한다(§11).

---

## 4. Goals / Non-goals

### Goals
- **G1** 서버가 시나리오 `default_think_time` + 모든 스텝 `think_time`의 범위(`min ≤ max ≤ 600000`)를 검증 (scenario create/update·test-run). run-level 검증과 대칭.
- **G2** open-loop 실행 시 시나리오 think time을 **기본 무시**하되, 원하면 실행-레벨 토글로 적용 — 시나리오 편집·open-loop 전용 think 관리 없이.
- **G3** 부하모델 선택을 *의도*로 안내(처리량 vs 사용자 수)해 스위칭을 이해 가능하게.
- **G4** open-loop에서 직전 이 시나리오 run의 **관측 RPS를 앵커로 표시 + 원클릭 `target_rps` 채우기** (J3의 스케일 이월).

### Non-goals
- think-scaling 헬퍼(closed-loop를 think 배율로 목표 RPS에 맞춤) — §11 비채택.
- ScheduleForm 토글/앵커 — §10 후속 연기 (serde-default가 현행 유지 보장).
- 엔진/proto/migration 변경 — §9 불변식으로 0-diff 유지.
- 홀리스틱 시크릿 마스킹(§B1) — 무관.

---

## 5. 기능 ① — 서버측 think time 범위 검증 (컨트롤러)

### 5.1 공유 술어 + 재귀 walk
`crates/controller/src/api/scenarios.rs`에 `validate_parallel_branch_names`(같은 파일 line 19) **선례와 동형**으로 추가:

- `fn validate_think_time(tt: &ThinkTime) -> Result<(), String>` — 스칼라 단일 소스. 규칙: `tt.min_ms <= tt.max_ms && tt.max_ms <= 600_000`. 위반 시 `Err(메시지)`.
- `fn validate_scenario_think_times(steps: &[Step], default: &Option<ThinkTime>) -> Result<(), String>` — 루트 `default` 검사(있으면) + `Step` 트리 **exhaustive 재귀 walk**로 모든 http 스텝의 `think_time` 검사. loop `do_`·if `then_`/`elif[].then_`/`else_`·parallel `branches[].steps`까지 재귀(엔진이 자유 중첩 허용 — `validate_parallel_branch_names`와 동일 walk 구조). `Step` match가 exhaustive라 새 Step 변형 추가 시 컴파일러가 walk 갱신 강제.
  - **parallel 분기 스텝의 명시 `think_time`도 검사한다** — think-time-defaults R4는 *default 상속*만 분기에서 배제했고, 분기 스텝의 *명시* think는 적용된다(엔진 `trace.rs`/`runner.rs` Parallel arm). 따라서 범위 위반은 분기 안에서도 동일하게 degrade → walk는 예외 없이 모든 스텝 검사.

### 5.2 호출부 4곳 (공유 술어 재사용)
1. `scenarios.rs::create` (line 74 부근, `validate_parallel_branch_names` 옆) — `validate_scenario_think_times(&parsed.steps, &parsed.default_think_time).map_err(ApiError::BadRequest)?` → **400**.
2. `scenarios.rs::update` (line 140 부근) — 동일 → **400**.
3. `runs.rs` run-level (`crates/controller/src/api/runs.rs:399-405`) — 기존 인라인 검사(`tt.min_ms > tt.max_ms || tt.max_ms > 600_000`)를 **공유 `validate_think_time` 호출로 교체**. 반환 400·동작 **byte-identical**(같은 규칙, 중복 제거). 술어를 `pub(crate)`로 노출해 `runs.rs`가 import.
4. `test_runs.rs::create` (`crates/controller/src/api/test_runs.rs`, `Scenario::from_yaml` 직후 line ~50, `trace_scenario` 전) — `validate_scenario_think_times(&scenario.steps, &scenario.default_think_time).map_err(|e| ApiError::Unprocessable(e))?` → **422**(이 엔드포인트 컨벤션 — `controller/CLAUDE.md` "422는 test-run 전용"). 근거: `apply_think_time=true`면 in-process trace가 실제 sleep → 극단 `max_ms` curl 페이로드가 trace를 장시간 hang시키는 벡터를 닫음. (`ThinkTime::sample`은 deadline/`WALL_CLOCK_CEILING_SECS=120` clamp가 있어 크래시는 아니나, 조용한 degrade는 여전히 막을 값.)

### 5.3 에러 메시지 (한국어 인라인 + 위치 명시)
run-level 선례 문구(`"think_time: min_ms <= max_ms <= 600000 (10분) 이어야 합니다"`) 재사용 + 위치:
- 스텝: `스텝 "{name}"의 think_time: min_ms <= max_ms <= 600000 (10분) 이어야 합니다`
- 루트: `시나리오 기본 think time(default_think_time): min_ms <= max_ms <= 600000 (10분) 이어야 합니다`

`validate_think_time`은 위치-무지(스칼라)라 run-level 재사용 시 문구는 호출부가 감싸거나(위치 접두), run-level은 기존 문구 유지. 스텝명은 `HttpStep.name`(항상 존재).

### 5.4 무변경
엔진(`sample()`의 lenient clamp는 방어선으로 **유지** — 서버 검증 후에도 잘못된 값이 어떤 경로로 닿아도 크래시 없음)·proto·migration 0-diff. 유효 YAML은 byte-identical 통과.

---

## 6. 기능 ② — open-loop think time 실행-레벨 무시 토글

### 6.1 조작 모델 (기본 "무시")
open-loop RunDialog에 토글 **"시나리오 think time [무시 / 적용]"**:
- **시나리오에 think가 있을 때만** 표시(default_think_time 또는 스텝 think 존재 — 없으면 무의미하니 숨김).
- 기본 = **무시**. → J1/J3a footgun 자동 제거. 조작 0.
- 무시 시 안내: `think time 무시 중 (open-loop 기본) — 적용하려면 켜기` (무시하는 divergence도 눈에 보이게 — [[load-divergence-explain-confirm]] 양방향).
- 적용 시 안내: 기존 슬롯 사이징 도우미(open arm에 이미 존재)가 think 포함 hold를 계산하므로, 가벼운 문구로 도우미를 가리킴. **신규 slot-shortfall 경고는 만들지 않는다**(기본이 무시라 공통 케이스엔 불필요·`iterationThinkFloorMs` 류 신규 floor 계산 없음).

### 6.2 저장 필드 (컨트롤러 profile_json, migration 불필요)
`crates/controller/src/store/runs.rs::Profile`(line 108)에 필드 추가:
```rust
/// open-loop에서 시나리오 think time(default_think_time + 스텝 think) 적용 여부.
/// 기본 true(적용) = 기존 저장 run·closed-loop byte-identical. open-loop 신규 run은
/// UI가 기본 false(무시)를 명시 전송. closed-loop에선 무시됨(think가 부하 메커니즘 —
/// 컨트롤러 strip은 open-loop 경로만).
#[serde(default = "apply_scenario_think_default", skip_serializing_if = "is_apply_default")]
pub apply_scenario_think_time: bool,
```
- serde default = `true`(apply) → 기존 profile_json(필드 부재) 역직렬화 = 적용 = 히스토리 byte-identical.
- `skip_serializing_if`가 true를 생략 → 저장 JSON은 값이 `false`(open-loop 무시)일 때만 필드 추가 → closed-loop·apply 케이스 profile_json byte-identical.
- **proto `Profile`에는 추가하지 않는다** — 워커는 strip된 YAML을 받으므로 플래그 불요(§6.3). proto/엔진/워커 0-diff.

### 6.3 컨트롤러 YAML strip (엔진/proto 0-diff)
`runs.rs::spawn_run`(line ~552, `PendingAssignment` 빌드부)에서:
- **cheap 게이트 먼저**: `profile.is_open_loop() && !profile.apply_scenario_think_time`일 때만 시나리오를 파싱(파싱을 매 run 하지 않도록). 그 안에서 `scenario_has_think(&parsed)`이면 워커-전송 복사본 `PendingAssignment.scenario_yaml`(현재 line 635 `scenario.yaml.clone()`)을 **strip된 YAML**로 대체, 아니면 원본. closed-loop·apply·no-think은 파싱조차 안 함.
- strip = `Scenario::from_yaml(&scenario.yaml)?` → `parsed.default_think_time = None` + 모든 스텝 `think_time = None`(§5.1과 동형 재귀 mutation walk) → `parsed.to_yaml()?`.
- **저장 스냅샷(`runs::insert`, line 578 `&scenario.yaml`)은 원본 유지** — 리포트 스텝 라벨·retry drift 경고의 정본. 워커-복사본만 분기.
- **no-think 시나리오는 strip도 재직렬화도 안 함**(게이트의 `scenario_has_think`) → 공통 경로 무영향.
- **안전성**: 워커가 어차피 `scenario_yaml`을 재파싱하므로(`Scenario::from_yaml`) 관건은 포맷이 아니라 `from_yaml(to_yaml(s)) == s`(라운드트립 속성 — 이미 테스트됨, `scenario.rs` round-trip 테스트군). 즉 워커가 받는 파싱 결과 = "원본 파싱 − think". 재직렬화 리포맷/주석 손실은 실행에 무의미.
- `scenario_has_think(&Scenario) -> bool` = `default_think_time.is_some() || 스텝 walk에 think_time.is_some()` 하나라도. 컨트롤러 헬퍼(§5.1 walk와 인접).

### 6.4 UI (RunDialog)
- `RunDialog`가 `applyScenarioThink: boolean` 상태 소유(open-loop·has-think일 때만 UI 노출), 기본 false. reseed-by-key(A1 패턴) — prefill 소스면 remount로 시드.
- `LoadModelFields`(open arm)가 토글 렌더 — **additive optional prop**(`applyScenarioThink?`/`onApplyScenarioThinkChange?`·`scenarioHasThink?`). 미전달(ScheduleForm)이면 미렌더 → ScheduleForm byte-identical(§10). RunDialog-전용 optional-prop 게이트 패턴(코드베이스 4회 검증됨).
- `buildProfile`: **open-loop일 때만** `apply_scenario_think_time: applyScenarioThink` 포함, closed-loop은 생략 → closed-loop payload byte-identical(R11 `toEqual` 계약 유지).
- Zod `ProfileSchema`: `apply_scenario_think_time: z.boolean().optional()`(서버가 값 있을 때만 직렬화 → 서버 null 없음 → `.optional()` 적정, `.nullish()` 불요). 소비처(`normalizeProfile`/prefill): `profile.apply_scenario_think_time ?? true`.
- 문구 전부 `ko.ts` 경유(ADR-0035).

---

## 7. 기능 ③ — 부하모델 선택 의도 안내

기존 부하모델 타일(closed/open, `rundialog-mockup-fidelity`에서 타일화)에 **한 줄 설명 카피**만 추가(구조 무변경):
- open 타일: `처리량(RPS) 제어 · think는 슬롯만 점유`
- closed 타일: `동시 사용자 수 · think가 페이싱을 만든다`

목적: "open/closed loop" jargon을 의도로 번역해 J3 스위칭을 이해 가능하게. `ko.ts` 경유. 타일 accessible name 오염 방지(설명은 타일 제목과 별도 `<span>` — U3 선례).

---

## 8. 기능 ④ — 관측 RPS 앵커 (open-loop 스케일 이월)

### 8.1 동작
open-loop **고정(fixed) 모드**에서, `usePriorClosedRunAnchor(scenarioId)`(기존 훅, `VuSizingHelper.tsx:23` — `{ vus, rps, durationSeconds }` 반환, `rps = report.summary.rps`)가 non-null이면 `target_rps` 입력 근처에 표시:
- `직전 실행 관측 ≈ {round(rps)} RPS` + 버튼 `이 값으로` → `setTargetRps(String(round(rps)))`.
- 비차단·표시 전용. 클릭해야만 채워짐(우발 덮어쓰기 없음).

### 8.2 스코프·근거
- **open+fixed만**: 앵커는 단일 RPS 값이라 `target_rps`에 매핑. 곡선(stages)·closed는 대상 아님(각 모드는 이미 자체 사이징 도우미 보유).
- **직전 closed run의 관측 RPS 재사용**: `usePriorClosedRunAnchor`가 closed run만 필터 → J3(closed→open)의 주 경로를 정확히 커버. 직전 open run 앵커(any-mode)는 새 훅이 필요하니 **후속 연기**(§10).
- think-scaling 대비 우위: 직전 *관측* 데이터로 스케일을 정확히 이월 → think 배율의 latency-의존·페이싱 왜곡 없음.

---

## 9. 데이터/와이어 변경 요약 (불변식)

| 레이어 | 변경 | byte-identical 보장 |
|---|---|---|
| 엔진 | **0-diff** | `sample()` lenient 유지·strip은 컨트롤러가 함 |
| proto | **0-diff** | 워커는 strip된 YAML 수신·플래그 불요 |
| migration | **0-diff** | 필드는 profile_json serde-default |
| 컨트롤러 store `Profile` | `apply_scenario_think_time: bool` (serde default true·skip-when-true) | 기존 run·closed-loop·open-apply profile_json 무변화 |
| 컨트롤러 `scenarios.rs` | `validate_think_time`+walk (신규) | 유효 시나리오 통과 |
| 컨트롤러 `runs.rs` | run-level 검증 공유술어로 교체·spawn_run open-loop strip | 무-think·apply·closed 경로 무변화 |
| 컨트롤러 `test_runs.rs` | walk 호출(422) | 유효 시나리오 통과 |
| UI | 토글·앵커·타일 카피·Zod optional 필드 | closed payload `toEqual` 유지·no-think open 무영향 |

---

## 10. 스코프·연기

- **ScheduleForm 제외 (후속)**: LoadModelFields optional prop 미전달 → 토글/앵커 미렌더. serde-default=apply라 스케줄 open-loop run은 **현행 유지(악화 없음)**. 후속 슬라이스에서 동일 prop 배선.
- **any-mode RPS 앵커 (후속)**: v1은 직전 closed run만(기존 훅). 직전 open run 관측 RPS 앵커는 새 훅.
- **closed-loop think-throttle 헬퍼 (비채택·니치면 별도)**: §11.

---

## 11. 비채택 — think-scaling 헬퍼 (사용자 아이디어 비판 평가)

"목표 RPS를 맞추려 think를 특정 배율로 줄이는 헬퍼"는 세 결함으로 비채택:
1. **부정확(latency 의존)**: closed-loop `RPS = N/(지연+think)`, 목표 R'는 `think' = N/R' − 지연`인데 지연이 부하 하에서 변해 선험적으로 모름 → 반복 튜닝 불가피.
2. **open-loop가 직접·정확히 하는 일**: 정확한 RPS는 `target_rps` 한 번으로 지정됨. think 배율은 우회.
3. **coordinated omission**: closed에서 think로 rate를 맞추면 SUT가 느려질 때 VU도 느려져 진짜 지연을 가린다. 정확 rate 부하는 open-loop가 정석.

→ 대안 = ②(자동 무시)+④(관측 앵커). "제한된 동시성으로 rate 테스트"라는 니치 용도는 인정하나, 필요 시 별도 슬라이스.

---

## 12. ADR 불필요 근거

① 검증 하드닝(신규 아키텍처 없음)·② open-loop-misconfig-warning(spec-only 선례, ADR 없음)의 확장·④ 기존 사이징 앵커 재사용. "open-loop think = reject 아닌 무시(기본)+토글" 정책 결정은 이 spec 본문(§3/§6)이 기록. 기존 ADR-0031(open-loop)·think-time-defaults(ADR-0033 범위) 안.

---

## 13. 테스트

### 13.1 컨트롤러 (Rust)
- `scenarios.rs` 단위: default `min>max` 거부·default `max>600000` 거부·스텝 think 범위 거부(loop/if/parallel 중첩 각 1)·수용(in-range)·absent 수용. create/update 통합 400.
- `test_runs.rs`: bad-think YAML → 422·good → 200.
- `runs.rs` run-level: 기존 think_time 거부 테스트(`validate_rejects_think_time_min_gt_max`·`_max_over_600000`) **그대로 green**(공유술어 교체가 byte-identical임을 증명).
- **strip 라운드트립 가드**: think 있는 시나리오 → strip → `to_yaml` → `from_yaml` = 원본−think(default_think_time None·모든 스텝 think None, 그 외 필드 동일). 게이트 단위: `is_open_loop()&&!apply&&has_think`만 strip·no-think은 원본·apply는 원본·closed는 원본.

### 13.2 UI
- 토글: open+has-think에서 렌더·기본 무시·closed/no-think 미렌더·payload(open=`apply_scenario_think_time` 포함·기본 false, closed=필드 부재 byte-identical).
- 무시/적용 안내 문구 렌더.
- ④ 앵커: 직전 closed run 있으면 `이 값으로` 클릭 → `target_rps` = round(rps)·앵커 없으면 미렌더·open+curve/closed 미렌더.
- ③ 타일 카피 렌더(accessible name 비오염 — 타일 라디오 정확매치 유지).
- `LoadModelFields` optional prop 미전달 시 토글/앵커 미렌더(ScheduleForm 회귀 락인).

### 13.3 게이트
`pnpm lint && pnpm test && pnpm build` + `cargo build --workspace && cargo nextest && clippy -D warnings`. UI payload는 라이브 run 1회로 확인(S-D 갭·`.nullish()`/`.optional()` 클래스).

---

## 14. 라이브 검증 (필수 — run-create·엔진 경로 변경)

`/live-verify` 스택(워크트리 자체 바이너리 + latency responder + 격리 DB):
1. **①**: curl `POST /api/scenarios`에 `min>max`/`max>700000` YAML → **400**·정상 → **201**. `POST /api/test-runs` bad → **422**.
2. **②**: think-heavy 시나리오(예 `default_think_time{500,500}`) open-loop `target_rps` run — 토글 **기본 무시**로 생성 → 리포트 `summary.rps`가 목표에 근접(드롭 없음). 그 다음 토글 **적용** run → RPS 하락/`dropped` 증가로 **strip 실증**. closed-loop 동일 시나리오는 think 적용(RPS = VUs/think)으로 byte-identical 확인.
3. **④**: 직전 closed run 후 open-loop RunDialog에서 `이 값으로` → `target_rps`가 관측 RPS로 채워짐(Playwright).
4. **security-reviewer**: `test_runs.rs`·시나리오 strip을 건드리므로 finish-slice §0 grep 발동 예상(예측 신뢰 금지 — grep이 지배).

---

## 15. 열린 질문 (없음)

브레인스토밍에서 ①범위(test-run 포함)·②정책(무시 토글 기본 무시)·스코프(핵심+관측앵커)·think-scaling 비채택이 전부 사용자 결정으로 확정.

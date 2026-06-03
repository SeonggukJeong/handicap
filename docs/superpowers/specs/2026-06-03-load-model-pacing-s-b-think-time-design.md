# S-B: think time (요청/반복 간 페이싱) — 설계

> **상태**: 설계(brainstorming) — 2026-06-03. 영역 D(부하 모델·페이싱)의 두 번째 하위 슬라이스. S-A(타임아웃) 완료 후 착수.
>
> **이 문서의 성격**: focused spec. 영역 umbrella spec(`2026-06-03-load-model-pacing-config-design.md`) §5 S-B가 잡은 *범위/결정/연기*를 구현 가능한 수준으로 디테일화한다. 영역 spec의 §3 지배 원칙(배치 규칙·byte-identical·검증 레이어·메트릭 영향 최소화)을 그대로 상속한다.
>
> **연관 문서**:
> - 영역 spec = `docs/superpowers/specs/2026-06-03-load-model-pacing-config-design.md` (§3 지배 원칙, §5 S-B, §8 추가 knob)
> - 선행 슬라이스 = S-A 타임아웃 (영역 spec §5 S-A, master `c5c3f27`→`8ff689d`) — 이 슬라이스가 확립한 "Profile 필드 + HttpStep 필드 + proto + worker + UI Zod + range 검증" 7-layer 배선을 그대로 재사용.
> - 로드맵 = `docs/roadmap.md` §D
> - 관련 ADR: 0013(scenario vs run config 분리), 0014(변수 표기), 0016(VU = tokio task per VU), 0018(VU별 cookie jar), 0022(데이터바인딩 seed = `mix`/`splitmix64`), 0026(test-run trace), 0027(멀티워커 글로벌 vu_id)
> - **새 ADR 불필요** — additive 와이어 확장(ADR-0013/0016 범위 내). S-A와 동일하게 ADR 안 만든다.

---

## 1. 목표 한 줄

closed-loop 실행을 더 현실적으로 — **반복 사이(run-level)** 와 **스텝 직후(per-step)** 에 지연(think time)을 넣어 실제 트래픽의 페이싱을 흉내 낸다. 실행 모델은 closed-loop 유지. 추가로 test-run 미리보기에서 페이싱을 켤 수 있는 opt-in 토글을 단다.

## 2. 범위 (이 슬라이스에서 하는 것 / 안 하는 것)

### IN
1. **run-level think time** — `Profile.think_time: Option<ThinkTime>`. 한 iteration 완료 후 다음 iteration 시작 전 sleep.
2. **per-step think time** — `HttpStep.think_time: Option<ThinkTime>`. 그 스텝의 요청 직후 sleep. **그 스텝이 실행될 때마다**(루프 내 매 repeat, if 분기 선택 시) 발동.
3. **`ThinkTime { min_ms, max_ms }`** — `min==max` → 고정, `min<max` → `[min,max]` 균등 랜덤(inclusive 양끝).
4. **사용자 선택 시드** — `Profile.think_seed: Option<u32>`. 있으면 결정적(재현 가능), 없으면 비결정적(엔트로피). run-level·per-step think time **양쪽**의 랜덤을 지배.
5. **test-run think time 토글** — `TestRunRequest.apply_think_time: bool`(기본 false). 켜면 trace가 시나리오의 **per-step** think time을 실제로 sleep(기존 `max_wall` 120s 상한 내).

### OUT (의도적 연기 — §13에 출처/행선지)
- think time 분포 확장(Poisson/exponential) — 영역 spec §8, S-C 도착 모델과 묶음.
- constant-pacing-timer(JMeter식 "반복 시작 간격 고정") — S-C arrival-rate와 개념 겹침, S-C 이후.
- test-run 전용 "시나리오 think time과 무관한 일괄 요청 간 지연" — 이 슬라이스는 시나리오에 정의된 per-step think time을 trace가 존중하는 데까지. blanket preview delay는 별개 기능.
- trace 결과에 "여기서 Xms 쉼" **표시**(시각화) — `apply_think_time` OFF든 ON이든 ScenarioTrace에 think time 행/필드 안 추가. 실제 sleep 여부만 토글.
- 시드의 데이터바인딩 seed와의 통합(단일 run-seed) — think_seed는 think time 전용. 데이터바인딩 seed(`fold_seed(run_id)`)는 무변경.

## 3. 핵심 결정 (확정 — brainstorming 2026-06-03)

1. **모양**: `ThinkTime { min_ms: u32, max_ms: u32 }` 단일 타입. 고정값은 `min==max`로 표현(별도 enum/모드 없음). → S-A의 단일-필드 철학과 일관.
2. **배치**(영역 §3.1): run-level → Profile(run config), per-step → Scenario HttpStep(YAML). think time은 "이 스텝 뒤엔 사용자가 N초 읽는다"가 시나리오의 일부이고, "이 run은 반복 사이 M초 쉰다"가 run 강도 축이라 이 분리가 자연스럽다.
3. **결정성 = 사용자 선택 시드(③)**: `Profile.think_seed: Option<u32>`. 비우면 VU별 엔트로피 RNG(비결정), 값 넣으면 그 시드로 재현. RunDialog에 optional 입력 노출. *재현성이 진짜 유용한 건 "다른 run에서 같은 페이싱 시퀀스 재현"이라 niche지만 비용이 작고 비우면 깨끗(byte-identical).*
4. **per-step think time은 스텝 실행 횟수만큼**: 루프 안 http 스텝이면 매 repeat, if 분기 안이면 그 분기 선택 시마다. think time은 스텝에 붙은 속성이라 "그 스텝이 요청을 한 번 보낼 때마다 그 뒤에" 적용. 요청 성공/에러 무관하게 record 직후 발동.
5. **test-run trace는 기본 sleep 안 함**(즉각 미리보기), opt-in 토글로만 sleep. run-level think time은 trace에 무관(단일패스 1 iteration이라 "반복 사이" 없음) — 토글은 **per-step만** 영향.
6. **취소/deadline 안전**: 모든 부하 경로 sleep은 `cancel`과 `tokio::select!` 경합 + `deadline`까지로 clamp(abort 즉시 반응, run window 넘겨 안 매달림). loop deadline 함정(engine CLAUDE.md)과 동형.

## 4. 데이터 모델

### 4.1 엔진 (`crates/engine`) — 단일 source of truth

새 모듈 `crates/engine/src/pacing.rs`:

```rust
/// 요청/반복 간 지연. min==max → 고정, min<max → [min,max] 균등 랜덤(양끝 포함).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThinkTime {
    pub min_ms: u32,
    pub max_ms: u32,
}

impl ThinkTime {
    /// 한 번 샘플. 런타임 관대: max < min이면 max=min으로 clamp(run 안 죽임).
    pub fn sample(&self, rng: &mut StdRng) -> Duration { … }
}

/// cancel과 경합 + deadline까지 clamp한 sleep.
/// 반환: PaceOutcome { Slept | Cancelled | DeadlineReached }.
pub async fn pace(
    dur: Duration,
    deadline: Instant,
    cancel: &CancellationToken,
) -> PaceOutcome { … }
```

- `ThinkTime`은 serde derive — **per-step**(HttpStep YAML)과 **RunPlan**(worker가 빌드) 둘 다 같은 타입 재사용.
- 시드 mix는 데이터바인딩 `dataset.rs::{mix, splitmix64}`를 재사용(또는 동형 헬퍼) — `mix(seed, vu_id, salt)`.

`Scenario.HttpStep`에 추가(`scenario.rs`):
```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub think_time: Option<ThinkTime>,
```
→ 비면 YAML 키 사라져 옛 시나리오와 **byte-identical**(S-A `timeout_seconds`·B4 `disabled`와 동형).

`RunPlan`에 추가(`runner.rs`):
```rust
/// 반복 사이 페이싱. None → 지연 0(byte-identical).
pub think_time: Option<ThinkTime>,
/// think time RNG 시드. Some → 결정적, None → VU별 엔트로피.
pub think_seed: Option<u32>,
```

### 4.2 controller (`crates/controller/src/store/runs.rs`) — profile_json

```rust
#[serde(default)]
pub think_time: Option<handicap_engine::ThinkTime>,   // 엔진 타입 재사용(controller는 이미 engine 의존)
#[serde(default)]
pub think_seed: Option<u32>,
```
- **`runs` 테이블 마이그레이션 0건** — profile_json JSON 컬럼 + `#[serde(default)]`라 옛 행은 `None`으로 역직렬화(Slice 7-1/8c/S-A 패턴).
- **`#[serde(default)]`만 쓰고 `skip_serializing_if`는 안 쓴다** — store `Profile`의 기존 Option 필드(`data_binding`/`criteria`, runs.rs:85-88)와 일관(항상 `null`로 직렬화). byte-identical 불변식(§9)은 *런타임 동작*(엔진 출력) 기준이고 profile_json 텍스트는 무관 — `null`이든 키 생략이든 둘 다 `None`으로 역직렬화. (엔진 `HttpStep.think_time`은 YAML이라 §4.1처럼 `skip_serializing_if` 유지 — 옛 시나리오 YAML byte-identical이 중요.)
- 엔진 `ThinkTime` 재사용으로 {min_ms,max_ms} 셰이프 단일화(controller↔engine 드리프트 방지). controller는 이미 `handicap_engine`에 의존(test_runs.rs).
- **SF-1 (store `runs::Profile {…}` 리터럴 — 두 종류 중 하나)**: `Profile { … }` literal 사이트 전부 `think_time: None, think_seed: None` 추가. `grep -rn "Profile {" crates/controller/src/`로 열거 — store struct 사이트: `store/runs.rs:327·391`(default fixture, **줄번호는 추가 후 이동**), `store/presets.rs:194`, `report.rs:384`, `grpc/coordinator.rs:970`, `api/runs.rs:524·635`. **proto(prost) `pb::Profile` 리터럴은 §4.3 별도 — 같은 `grep`에 섞여 나오니 주의.**

### 4.3 proto (`crates/proto/proto/coordinator.proto`)

```proto
message ThinkTime {
  uint32 min_ms = 1;
  uint32 max_ms = 2;
}

message Profile {
  uint32 vus = 1;
  uint32 ramp_up_seconds = 2;
  uint32 duration_seconds = 3;
  uint32 loop_breakdown_cap = 4;   // 0 = disabled
  uint32 http_timeout_seconds = 5; // 0 = use default (30s)
  ThinkTime think_time = 6;        // 메시지 필드 = 암묵적 optional, absent → 페이싱 없음
  optional uint32 think_seed = 7;  // present → 결정적, absent → 엔트로피
}
```
- proto3 메시지 필드는 presence 감지 가능 → prost가 `Option<ThinkTime>` 생성. `optional uint32` → `Option<u32>`.
- **per-step think time은 proto에 없음** — 시나리오 YAML로 흐른다(워커가 `scenario_yaml` 파싱). S-A per-step `timeout_seconds`와 동일(run-level만 proto, per-step은 YAML).
- **SF-2 (prost `pb::Profile {…}` 리터럴 — exhaustive)**(controller CLAUDE.md prost 함정): proto에 6/7 필드가 생기면 prost가 `pb::Profile`에 `think_time: Option<pb::ThinkTime>`/`think_seed: Option<u32>` 필드를 생성하고, prost-generated struct는 `..Default::default()` spread가 **안 통하므로** 모든 `pb::Profile {…}` literal에 두 필드를 명시해야 컴파일된다. 사이트(`grep -rn "Profile {" crates/`):
  - `crates/controller/src/api/runs.rs:202` — **프로덕션** controller→proto 매핑(여기가 store `Profile.think_time/think_seed` → proto 실제 와이어링 지점). 메시지 필드는 `think_time: profile.think_time.map(|t| pb::ThinkTime{min_ms:t.min_ms, max_ms:t.max_ms})`, `think_seed: profile.think_seed`.
  - `crates/controller/src/grpc/coordinator.rs:951` — test helper `base_assignment`.
  - `crates/proto/tests/run_assignment_env_test.rs:13` — proto crate 테스트.
- proto enum/필드 추가는 controller+worker 동시 배포라 backward-compat 안전.

### 4.4 UI Zod (`ui/src/scenario/model.ts` + `ui/src/api/schemas.ts`)

```ts
// per-step (scenario model, 와이어 1:1 strict)
const ThinkTimeModel = z.object({
  min_ms: z.number().int().min(0),
  max_ms: z.number().int().min(0),
}).refine(t => t.min_ms <= t.max_ms && t.max_ms <= 600_000, …);
// HttpStepModel에 think_time: ThinkTimeModel.optional()
```
- run-level think time/seed는 RunDialog 상태 → POST /api/runs profile(아래 §7).

## 5. 의미 / 적용 지점 (엔진 배선)

### 5.1 run-level (반복 사이) — `runner.rs::run_vu`
- VU 시작 시 RNG 1개 생성:
  - `think_seed=Some(s)` → `StdRng::seed_from_u64(mix(s, vu_id, /*salt*/0))`
  - `None` → `StdRng::from_entropy()`
- 반복 루프(`while Instant::now() < deadline`)에서 `execute_steps`가 `StepFlow::Continue`를 반환한 **직후**, 다음 iteration 전에:
  - `if let Some(tt) = plan.think_time { match pace(tt.sample(&mut rng), deadline, &cancel) { Cancelled → return Err(Aborted), _ → {} } }`
- 첫 iteration 전엔 적용 안 함(think time = 반복 *사이*). deadline 도달 iteration 뒤 sleep은 clamp로 0에 수렴(다음 while 검사가 종료).
- 멀티워커(A3): VU는 글로벌 `vu_id`(`vu_offset + spawned`)로 시드 → 워커 간 비중복·재현(ADR-0027). think time은 per-VU local이라 워커 조정 불필요.

### 5.2 per-step (스텝 직후) — `runner.rs::execute_steps` Http arm
- `Step::Http` arm에서 메트릭 `record(...)` **직후**:
  - `if let Some(tt) = &http.think_time { match pace(tt.sample(rng), deadline, cancel) { Cancelled → return Ok(StepFlow::Aborted), DeadlineReached → return Ok(StepFlow::DeadlineReached), Slept → {} } }`
- `execute_steps`에 `rng: &mut StdRng` 파라미터 추가(이미 `#[allow(clippy::too_many_arguments)]`). **재귀 호출 3사이트 전부 `rng` 전달**: `run_vu`의 최초 호출(runner.rs:259), **loop arm** `Box::pin(execute_steps(...))`(runner.rs:343), **if arm** `Box::pin(execute_steps(...))`(runner.rs:386). if arm을 빠뜨리면 if 분기 안 http 스텝의 per-step think time이 안 먹는다(§3 결정 4 "if 분기 선택 시마다"와 어긋남). borrow 충돌 없음 — `iter_vars: &mut`와 `rng: &mut`는 서로 다른 객체, 순차 await라 aliasing 없음.
- **executor `execute_step`은 무변경** — think time은 runner(인터프리터) 레이어의 sleep이지 요청 실행(executor)의 일부가 아니다. → `execute_step` byte-identical 불변식 보존(engine CLAUDE.md).
- 루프/분기: execute_steps가 재귀라 loop body·if 분기 안 http 스텝도 같은 arm을 타므로 per-step think time이 자연히 매 실행마다 발동.

### 5.3 test-run trace — `trace.rs::trace_steps` (opt-in)
- `TraceOptions`에 `apply_think_time: bool` 추가.
- `trace_steps`의 http leaf 처리 직후, `opts.apply_think_time && step.think_time.is_some()`이면 sleep:
  - 시드 무관(미리보기) — 로컬 `StdRng::from_entropy()`로 sample.
  - **cancel 토큰 없음** — trace는 `deadline`(= `started + max_wall`)만 가짐. `sleep(min(sample, deadline - now))` 후 `Instant::now() >= deadline`면 `truncated = true`(기존 truncation 경로 재사용).
- run-level think time은 trace에 적용 안 함(단일패스).
- **lockstep**(engine CLAUDE.md): `execute_steps`와 `trace_steps`는 의도된 중복 — 양쪽에 per-step think time을 넣되 trace 것은 `apply_think_time` gate + cancel 없음 + seedless. 부하 경로 변경 시 trace도 같이 점검.

## 6. 검증 레이어 (영역 §3.3)

### 6.1 Profile (controller `validate_run_config`, `api/runs.rs`)
http_timeout 검증(`api/runs.rs:76`, `validate_run_config` 내부 — `store/runs.rs:76`은 struct 정의 줄이라 무관) 옆에 추가:
```rust
if let Some(tt) = &profile.think_time {
    if tt.min_ms > tt.max_ms || tt.max_ms > 600_000 {
        return Err(ApiError::BadRequest(
            "think_time: min_ms <= max_ms <= 600000 (10분) 이어야 합니다".into()));
    }
}
// think_seed: 범위 검증 불필요(임의 u32).
```
- preset-save도 같은 게이트 공유(A2 — `validate_run_config`는 run-create + preset-save 공유).

### 6.2 per-step (UI Zod `ThinkTimeModel` `.refine`) + 엔진 관대
- UI: `min_ms <= max_ms <= 600_000`. authoring 게이트.
- 엔진: 런타임 비정상값(`max < min`)은 `ThinkTime::sample`이 `max=min`으로 clamp — run을 죽이지 않음(lenient 정책, ADR-0023 평가 정합). YAML로 직접 들어온 음수는 u32라 불가, 과대값은 sample이 그대로 sleep하되 deadline clamp가 상한 역할.

## 7. UI

### 7.1 run-level — `ui/src/components/RunDialog.tsx`
- **정정(spec-review B1)**: S-A의 `http_timeout`은 **평범한 인라인 입력**(RunDialog.tsx:324 "HTTP timeout (s)")이지 접이식 페이싱 섹션이 아니다. RunDialog의 접이식 disclosure는 **SLO 섹션 하나뿐**(`RunDialog.tsx:378-393`, `<button aria-expanded={sloOpen}>` + `{sloOpen && …}`). 따라서 think time은 **새 접이식 "Pacing" 섹션**을 SLO 패턴을 모방해 만든다(`ui-optional-sections-collapsible` 선호: 기본 접힘 + 값 있으면 자동 펼침 + "N개 설정됨" 힌트).
- 입력(Pacing 섹션 안):
  - think time **min (ms)** / **max (ms)** 두 number 입력.
  - **seed** (optional) number 입력 — 비우면 비결정.
- 기본 접힘. think time/seed 중 값이 채워져 있으면 자동 펼침 + 토글에 "N개 설정됨" 힌트(SLO 섹션 `sloOpen`/카운트 패턴, RunDialog.tsx:79·133·386 미러).
- 제출: `profile.think_time = (min/max 둘 다 입력 시) {min_ms,max_ms} : undefined`, `profile.think_seed = (seed 입력 시) seed : undefined`. 둘 다 미입력이면 키 omit.
- 검증 미러: `min<=max<=600000` → `aria-invalid` + 인라인 에러(httpTimeoutInvalid 패턴, RunDialog.tsx:150).
- 프리셋 prefill: optional 빈칸을 표현하려면 SLO 섹션의 text-state/`numToStr` 패턴을 따른다(initial?.profile, RunDialog.tsx:119 + SLO prefill 패턴).
- 입력 모양: min/max 두 칸 + "min=max면 고정 지연" 힌트(모델 1:1, 기존 number-input 일관).

### 7.2 per-step — `ui/src/components/scenario/Inspector.tsx`
- S-A per-step "Timeout (s)" 입력(Inspector.tsx:145-163 `timeoutDraft`/`commitTimeout` F5 패턴: `Number.isInteger` + 범위 + draft revert) 옆/아래에 per-step think time **min (ms)** / **max (ms)** 한 쌍(같은 draft/commit 패턴).
- `HttpStepModel.think_time` 와이어 1:1. 둘 다 입력 시에만 think_time 객체 set, 아니면 omit(skip_serializing_if와 정합).
- **읽기 패스스루(spec-review B2 — write-only 버그 방지)**: `ui/src/scenario/yamlDoc.ts::normalizeStep`(http 스텝 정규화, line ~422-)은 **명시적 화이트리스트 패스스루**라 `timeout_seconds`를 `yamlDoc.ts:458`에서 `...(src.timeout_seconds != null ? { timeout_seconds } : {})`로 통과시킨다. `think_time`에 대응 패스스루를 **반드시 추가**(없으면 저장→재로드 시 `think_time`이 떨어져 write-only — UI CLAUDE.md B4 `disabled` 함정과 동형). 쓰기 경로(`setStepField(id, ["think_time"], {min_ms,max_ms})`)는 yamlDoc.ts:303-306 object→`createNode` 분기가 이미 처리(읽기만 문제). **테스트는 반드시 round-trip(set→serialize→parse→normalize)으로 검증** — write-only 버그는 단방향 테스트를 통과한다.

### 7.3 test-run 토글 — `ui/src/components/scenario/TestRunSection.tsx`
- **정정(spec-review S3)**: test-run 트리거는 `TestRunPanel`(순수 렌더러)이 아니라 **`TestRunSection.tsx:56-59`**(`testRun.mutate({scenario_yaml, env, max_requests})` 소유)에 있다. 토글 owner = `TestRunSection`.
- `TestRunSection`에 체크박스 "**think time 적용 (천천히 전송)**"(기본 해제) + mutate 본문에 `apply_think_time: boolean` 추가.
- 와이어: `ui/src/api/client.ts:144`의 `createTestRun` body 타입에 `apply_think_time?: boolean` 추가 → `ui/src/api/hooks.ts`(`useTestRun` passthrough) → `POST /api/test-runs` 본문.
- 켜졌을 때 ScenarioTrace에 추가 표시는 없음(§2 OUT) — 단지 실제 sleep만 일어남.

## 8. 와이어 1:1 대조표 (handicap-reviewer 최종 검증용)

| knob | UI(Zod/state) | REST(JSON) | controller(profile_json) | proto | worker→engine | engine 적용 |
|---|---|---|---|---|---|---|
| run-level think time | RunDialog state → `profile.think_time` | `{think_time:{min_ms,max_ms}}` | `Profile.think_time: Option<ThinkTime>` | `Profile.think_time = 6` | `RunPlan.think_time` | `run_vu` 반복 사이 |
| think seed | RunDialog state → `profile.think_seed` | `{think_seed:u32}` | `Profile.think_seed: Option<u32>` | `Profile.think_seed = 7 (optional)` | `RunPlan.think_seed` | VU RNG 시드 |
| per-step think time | `HttpStepModel.think_time` | (scenario YAML) | — | — (YAML) | scenario_yaml 파싱 | `execute_steps` Http arm |
| test-run 토글 | TestRunPanel checkbox | `{apply_think_time:bool}` | (test_runs handler) | — | — | `trace_steps` (gate) |

## 9. 불변식 (Acceptance)

- **하위호환 byte-identical**: think_time·think_seed·per-step think_time·apply_think_time 전부 absent → sleep 0 → 현재 동작과 byte-identical. (회귀 테스트로 단언.)
- **마이그레이션 0건**: profile_json(`#[serde(default)]`) + scenario YAML(`skip_serializing_if`) 둘 다 흡수.
- **메트릭/리포트 무변경**: think time은 윈도 사이 idle일 뿐(요청을 안 보냄). `Aggregator`/`MetricFlush`/proto `MetricBatch`/리포트 **무변경**. think time 동안 RPS 자연 하락 = 의도된 동작.
- **execute_step(executor) byte-identical**: think time은 runner/trace 레이어만 — executor 무변경.
- 게이트: `cargo fmt/clippy/test --workspace` + UI `pnpm lint && pnpm test && pnpm build`.

## 10. 테스트 계획

### 엔진 (`crates/engine`)
- **per-step think time 적용**: 고정 `think_time{min:Xms,max:Xms}`(결정적) 단 스텝 → tokio `start_paused` 가상시계로 X만큼 advance 필요 확인(요청 직후 sleep). loop 안 스텝이면 repeat×X.
- **run-level think time**: 반복 사이 sleep 검증(가상시계로 iteration 간격).
- **cancel 즉시 반응**: think time sleep 중 `cancel` → `Err(Aborted)`(매달리지 않음).
- **deadline clamp**: think time이 남은 window보다 길면 deadline에서 잘림(다음 iteration 미시작).
- **seed 재현**: 같은 `think_seed`+같은 시나리오 2회 = 같은 sample 시퀀스. 다른 seed = 다름. seed None = 비결정(같은 sample 보장 안 함 — 단언하지 않음).
- **byte-identical**: think time absent → 기존 통합 테스트 무변경 통과.
- **ThinkTime::sample**: `min==max` → 고정, `min<max` → `[min,max]` 범위 내, `max<min` → min으로 clamp. (순수 단위.)

### controller
- `validate_run_config`: think_time 범위(min>max·max>600000 거부, 정상 통과). think_seed 무검증.
- profile_json round-trip: think_time/think_seed 직렬화·역직렬화 + 옛 행(필드 없음) → None.
- test-run: `apply_think_time=false`(기존 즉각) / `true`(per-step think time만큼 sleep — 짧은 값으로 검증) + `max_wall` 초과 시 truncated.

### worker
- proto Profile.think_time/think_seed → RunPlan 매핑(absent → None).

### UI (vitest)
- `ThinkTimeModel` Zod 와이어 1:1(min<=max<=600000 refine).
- RunDialog: think time min/max/seed 입력 → profile, 검증 인라인 에러, 미입력 시 omit.
- Inspector: per-step think time 입력 → HttpStepModel.
- TestRunPanel: 체크박스 → `apply_think_time` 본문 전달.

## 11. 엔진 구조 메모 (격리/테스트 용이성)

- `pacing.rs`는 `ThinkTime`(데이터) + `sample`(순수, rng 주입) + `pace`(async sleep/cancel/deadline)로 분리 — 각각 독립 단위 테스트.
- `execute_steps` 시그니처에 `rng: &mut StdRng` 1개 추가(기존 too_many_arguments allow). 대안(번들 ctx 구조체로 묶기)은 plan에서 판단 — 현재 다인자 관례상 단일 `&mut StdRng` 추가가 최소 변경.
- `mix`/`splitmix64`를 `dataset.rs`에서 `pacing.rs`로 공유하려면 `pub(crate)`로 노출하거나 공용 위치로 이동 — plan에서 결정(중복 구현은 피한다).

## 12. 영향 받는 파일 (예상)

### 프로덕션
- `crates/engine/src/pacing.rs` (신규) — ThinkTime/sample/pace/PaceOutcome.
- `crates/engine/src/scenario.rs` — HttpStep.think_time.
- `crates/engine/src/runner.rs` — RunPlan 2필드, run_vu RNG+run-level pace, execute_steps rng+per-step pace(3 재귀 사이트).
- `crates/engine/src/trace.rs` — TraceOptions.apply_think_time, trace_steps per-step sleep.
- `crates/engine/src/lib.rs` — pacing 모듈 + ThinkTime re-export.
- `crates/engine/src/dataset.rs` — mix/splitmix64 공유 노출(`pub(crate)`, 필요 시).
- `crates/proto/proto/coordinator.proto` — ThinkTime 메시지 + Profile 2필드.
- `crates/controller/src/store/runs.rs` — Profile 2필드 + store 리터럴 사이트(SF-1: runs.rs/presets.rs:194/report.rs:384/coordinator.rs:970/api/runs.rs:524·635).
- `crates/controller/src/api/runs.rs` — validate_run_config think_time 범위(:76) + **프로덕션 proto 매핑**(:202, SF-2).
- `crates/controller/src/api/test_runs.rs` — TestRunRequest.apply_think_time → TraceOptions(:43-47).
- `crates/controller/src/grpc/coordinator.rs` — `pb::Profile` 테스트 리터럴(:951, SF-2) + store Profile 리터럴(:970, SF-1).
- `crates/proto/tests/run_assignment_env_test.rs:13` — `pb::Profile` 테스트 리터럴(SF-2).
- `crates/worker/src/main.rs:181-196` — proto Profile → RunPlan think_time/think_seed.
- `ui/src/scenario/model.ts:84` — ThinkTimeModel + HttpStepModel.think_time.
- `ui/src/scenario/yamlDoc.ts` — **normalizeStep think_time 읽기 패스스루(:458 근처, B2)** + 쓰기 경로(이미 처리).
- `ui/src/api/{schemas.ts:46, client.ts:144, hooks.ts}` — profile think_time/think_seed + test-run apply_think_time body 타입.
- `ui/src/components/RunDialog.tsx` — run-level think time/seed 입력(**신규 접이식 Pacing 섹션**, B1).
- `ui/src/components/scenario/Inspector.tsx` — per-step think time 입력(F5 draft/commit 패턴).
- `ui/src/components/scenario/TestRunSection.tsx` — apply_think_time 토글(owner).

### exhaustive 리터럴 (컴파일 위해 텍스트는 변경, *동작*은 무변경 — S1)
- **`RunPlan {…}` = 25 사이트** (`grep -rn "RunPlan {" crates/`, 14 파일: 엔진 테스트 11 + worker + worker 테스트 + runner.rs). 2필드 추가 시 전부 `think_time: None, think_seed: None` 명시(RunPlan은 `#[derive(Debug, Clone)]`만 — spread 불가). **대안**: `RunPlan`/`TraceOptions`에 `#[derive(Default)]` 추가해 `..Default::default()` 허용(모든 필드 Default 가능 확인 필요 — plan에서 택1).
- **`TraceOptions {…}` = 2 사이트** (`crates/engine/tests/trace_scenario.rs:9`, `crates/controller/src/api/test_runs.rs:43`). `apply_think_time: false` 추가.
- **`pb::Profile {…}` = 3 사이트** (SF-2, §4.3). **store `runs::Profile {…}`** = SF-1 사이트.
- 이 텍스트 변경 때문에 §9 "byte-identical 테스트 무변경 통과"는 정확히는 "테스트 *동작* 무변경, 리터럴 텍스트는 2필드 추가 필수"를 뜻한다.

### 무변경 (명시)
- `crates/engine/src/executor.rs` (execute_step / execute_step_traced byte-identical).
- `crates/engine/src/aggregator.rs`/`percentiles.rs`, `report.rs`, proto `MetricBatch`/`MetricWindow`.
- `runs`/`run_metrics`/`run_loop_metrics`/`run_if_metrics` 테이블 (마이그레이션 0건).

## 13. 연기 항목 (roadmap §D 추가 knob로 누적)

- think time 분포(Poisson/exponential) → S-C 도착 모델.
- constant-pacing-timer(반복 시작 간격 고정) → S-C 이후.
- test-run blanket preview delay(시나리오 think time 무관) → 별개.
- trace 결과의 think time 시각화 표시 → UI 폴리시.
- think_seed ↔ 데이터바인딩 seed 통합(단일 run-seed) → 결정성 통합 슬라이스.

## 14. ADR

**불필요**. additive 와이어 확장(ADR-0013 scenario/run config 분리 + ADR-0016 closed-loop VU 모델 범위 내). S-A와 동일. 새 실행 모델(open-loop, S-C)에서만 ADR-0031.

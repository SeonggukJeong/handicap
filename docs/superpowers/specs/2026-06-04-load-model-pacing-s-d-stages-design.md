# S-D 다단계 ramp (open-loop 레이트 곡선) 설계

> **상태**: 설계(brainstorming) — 2026-06-04. 영역 D(부하 모델·페이싱)의 4번째이자 마지막 계획 슬라이스.
> **선행**: S-A(타임아웃)·S-B(think time)·S-C(open-loop, ADR-0031) 머지 완료. 이 슬라이스는 S-C 위에 얹는다.
> **영역 spec**: `docs/superpowers/specs/2026-06-03-load-model-pacing-config-design.md` §5 S-D.
> **ADR**: 신규 **ADR-0032 "다단계 ramp (open-loop 레이트 곡선)"** 를 이 슬라이스에서 작성(ADR-0031 위에 레이트 곡선 + config 표면 + 범위 컷).

## 1. 한 줄 / 동기

S-C의 **고정** `target_rps`(상수 도착률)를 `stages: [{target=RPS, duration}]` **레이트 곡선**으로 일반화한다. "30s 동안 0→200 올리고 → 2분 유지 → 30s 내려서 0" 같은 다단계 부하 곡선을 open-loop에서 표현 가능하게 한다. LoadRunner/JMeter 대체(ADR-0001)에서 "ramp이 단일 선형뿐"이라는 격차의 open-loop 측 해소.

## 2. 범위 결정 (확정)

**S-D = open-loop RPS 곡선만.** closed-loop은 무변경(byte-identical).

- **closed-loop stages(VU 곡선 + retire/ramp-down)는 연기.** 이유: closed-loop에서 VU를 *줄이려면* 현재 없는 "VU 회수(deadline 외 조기 종료 신호)" 프리미티브가 필요하다. "올리기만(단조 증가 계단)"은 그 프리미티브 없이 되지만 **올릴 순 있는데 못 내리는 비대칭 반쪽 기능**이라 혼란스럽다 → 양방향(up-staircase + retire + ramp-down)을 한 번에 완결하는 별도 미래 슬라이스로 묶는다(브레인스토밍 옵션 (b)+(c)).
- **부하모델 모드 선택기(closed/fixed-rate/curve 3-way 재편)는 연기** — 별도 UX 슬라이스. 로드맵 §D 기록됨.

forward-compat: 같은 `stages` 필드를 미래 closed-loop stages가 재사용한다(target=RPS냐 VU냐는 `max_in_flight` 유무로 구분 — `target_rps`+`max_in_flight`가 이미 쓰는 그 disambiguator). 즉 이 슬라이스의 "stages + max_in_flight 없음 → 400" 거부를 미래에 풀면 closed-loop 경로가 열린다.

## 3. 의미론 (config 계약)

### 3.1 stages 곡선 (k6식)

- `Stage { target: u32 /* = RPS */, duration_seconds: u32 }`. 전체 run 길이 = **stage duration의 합**.
- rate r(t)는 **piecewise-linear**. **시작 rate = 0** (가상 stage 0 = `{target:0}`).
- stage k는 `target_{k-1} → target_k`를 `duration_k` 동안 선형 전이(target_0 = 0).
- 연속 동일 target = **유지(hold)**. 마지막 target=0 = **ramp-down**.
- 예: `[{200,30},{200,120},{0,30}]` = 30s 0→200 상승, 200 2분 유지, 30s 200→0 하강. 총 180s.

### 3.2 "일정(constant)"은 stages가 아니다

시작 rate=0이라 `[{500,60}]`은 *일정 500*이 아니라 **0→500 삼각형**이다. 일정 레이트는 이미 S-C의 `target_rps` 고정 경로가 담당하므로, **open-loop 섹션 안에 `고정 | 곡선` 2-way 토글**을 둬서 분리한다(§6 UX):
- **고정** → `target_rps` 입력 (S-C, byte-identical)
- **곡선** → stages 에디터 (S-D)

부하-모양 템플릿은 0에서 시작하는 진짜 곡선 4종만(점증·유지 / 스파이크 / 계단 스트레스 / 소크). "일정"은 템플릿이 아니라 고정 토글.

(대안 — 시작 rate를 `target_1`로 잡는 컨벤션 — 은 "0에서 올리기"를 표현 불가하게 만들어 k6 직관과 어긋나므로 기각.)

### 3.3 trigger + 상호 배타

| 구성 | 의미 | 트리거 |
|---|---|---|
| `target_rps` + `max_in_flight` + `duration_seconds` | open-loop **고정** 레이트 (S-C, 무변경) | `target_rps.is_some()` |
| `stages` + `max_in_flight` | open-loop **곡선** 레이트 (S-D, 신규) | `stages` 비어있지 않음 |

- `stages`는 `target_rps` + `duration_seconds`의 generic 대체. **`max_in_flight`는 여전히 필수, 직교**(슬롯풀 크기 = 동시 in-flight 상한, 레이트와 무관).
- **상호 배타(전부 400 BadRequest)**:
  - `stages` + `target_rps` 동시 (레이트 지정 방식 2개 충돌)
  - `stages` + `duration_seconds > 0` (길이는 합으로 결정)
  - `stages` + `ramp_up_seconds > 0` (기존 open-loop 가드 연장)
  - `stages` + run-level `think_time` (기존 open-loop 가드 연장; per-step think time(S-B)은 직교라 허용)
  - `stages` + `max_in_flight` **없음** → 400 "closed-loop stages는 아직 미지원" (= 연기한 (b)+(c) 자리, forward-compat)

### 3.4 검증 bounds (`validate_run_config`)

- stage `target`: **0..=1_000_000** — 기존 `target_rps` cap과 parity(도출됨).
- stage `duration_seconds`: **>= 1** — 시간이 전진하도록. **상한 없음**(기존 `duration_seconds`도 상한 없음 — 일관성).
- **최소 한 stage의 target > 0** (전부 0 = 부하 없음 → 거부).
- **stage 개수 캡 없음** — 물리/리소스 제약 아님(슬롯풀은 `max_in_flight`가 bound). `/api/runs`는 axum 기본 2MB body limit이 이미 막음.
- 1M RPS / 1만 동시는 **단일워커 v1 천장(~20k RPS, ADR-0031)** 위라 cap을 풀어도 못 냄 — cap 상향·>1만 동시는 open-loop 멀티워커 fan-out(ADR-0031 연기)의 몫. S-D는 cap 무변경.

### 3.5 open-loop 판별 predicate (구현 계약 — ⚠ spec-plan-reviewer C1/I3)

**S-C는 `target_rps.is_some()`를 "open-loop인가?"의 단일 proxy로 쓴다.** S-D가 두 번째 open-loop 트리거(stages)를 도입하므로, `target_rps.is_some()`로 분기하는 **모든** 사이트를 공유 predicate로 바꿔야 한다. 안 그러면 `target_rps==None`인 stages run이 그 사이트들에서 **closed-loop으로 오분류**된다(데이터바인딩 슬라이싱이 `vus` 기준, 워커수가 `worker_count_for(vus)`로 fan-out, 디스패치가 `run_scenario`로 가 stages 무시 + `vus`개 VU 실행).

- **단일 predicate 도입**: `profile.is_open_loop() = target_rps.is_some() || stages_present`. 여기서 **`stages_present = stages.as_ref().is_some_and(|s| !s.is_empty())`** — 즉 **`Some(vec![])`(빈 배열)는 absent와 동일 취급**(closed-loop). UI Zod `z.array().optional()`이 `[]`를 직렬화할 수 있으므로 빈 배열 정규화는 필수.
- **교체해야 하는 `target_rps.is_some()` 판별 사이트(전부)** — spec-plan-reviewer가 코드에서 확인:
  - `api/runs.rs:215` — per_vu 데이터바인딩 `slot_count`(open = `max_in_flight` 행 / closed = `vus` 행)
  - `api/runs.rs:277` — 워커수 `n`(open = 1 / closed = `worker_count_for(vus)`)
  - `api/runs.rs:156` — unique 정책 워커수 `n`(동일)
  - `worker/main.rs:305` — `match plan.target_rps` 디스패치 (`run_scenario_open_loop` vs `run_scenario`)
  - `validate_run_config`의 open-loop 분기 진입(§3.3 트리거)
- **stages도 단일워커 v1**: open-loop predicate가 true면 워커수 = 1(현 `target_rps.is_some() → 1` 규칙을 predicate로 일반화). open-loop fan-out은 ADR-0031 연기 그대로.

## 4. 엔진 (스케줄러)

S-C의 격리 함수 `run_scenario_open_loop`에 **레이트 곡선만 주입**한다. 슬롯풀·drop·`dropped` 카운터·`exhausted`·cancel·플러셔·`run_arrival`은 100% 무변경 — 곡선은 "언제 arrival을 발사하나"만 바꾸고 슬롯/집계/메트릭은 안 바꾼다. **스케줄러 루프 body(슬롯 try_recv → spawn / drop+`yield_now` / `next += interval`)는 S-C와 byte-identical이고, 유일한 변경은 `interval`이 상수에서 `rate_at(elapsed)` 도출로 바뀌는 것뿐**(spec-plan-reviewer M4).

- **`RunPlan.stages: Option<Vec<Stage>>`** 추가. `None` → 기존 고정 `interval = 1/target_rps`(byte-identical). `Some` → 매 arrival마다 순간 rate로 interval 재계산.
- **`rate_at(elapsed) -> f64`**: stage 경계 누적시간 piecewise-linear 룩업. 선형 스캔(stage 수 적음).
- **interval 계산**: rate > 0이면 `interval = 1 / rate_at(elapsed)`, `next += interval`. 저레이트면 interval이 자연히 커짐(정상, ramp-down 꼬리, 예 0.5 RPS = 2s 간격) — **interval에 상한을 두지 않는다**(상한은 레이트를 왜곡: 2s 간격을 1s로 자르면 1 RPS가 됨). 저레이트의 긴 sleep도 정상 경로(`1/rate`)로 처리하고, responsiveness는 기존 S-C 코드의 `tokio::select! { sleep, cancel }` + 루프 top의 deadline 체크가 이미 보장(긴 sleep도 cancel로 깨지고 deadline에 막힘).
- **rate ≈ 0 가드(M3)**: `rate_at(elapsed)`가 **실질 0**(`<= EPS`, 예 `1e-9` — 저레이트(0.5 RPS 등 양수)는 여기 해당 안 되고 위 정상 `1/rate` 경로를 탐)이면 **arrival을 발사하지 않는다**(spawn도 drop도 없음 — drop은 rate>0인데 슬롯이 없을 때만). 고정 poll-step(예 100ms)만큼 sleep하되 **정상 경로와 동일한 `tokio::select! { sleep, cancel }`** 를 써 cancel responsive 유지(루프 top이 deadline 체크). 자연 발생 지점은 ① 마지막 target=0 stage 끝(= deadline, 루프가 break) ② 중간 `{0, d}` hold(드물지만 표현 가능 — 그 구간 arrival 0, 정확). rate가 다시 >0으로 오르면 `interval = 1/rate` 재개.
- **deadline 소유권(⚠ spec-plan-reviewer I2)**: 엔진은 stages를 합산하지 않는다 — `run_scenario_open_loop`은 기존대로 `deadline = started_at + plan.duration`(`runner.rs:462`)를 쓴다. **워커가 `plan.duration = sum(stage.duration_seconds)`를 계산**(§5)해 넘긴다. 불변식: **`plan.duration == sum(stages)`**. 엔진은 `plan.stages`를 `rate_at`(스케줄)에만 쓰고 종료조건은 `plan.duration`에 의존.
- **정밀도(v1)**: 순간-rate 방식은 ramp 중 미세 under/over(상승 시 약간 적게, 하강 시 약간 많게)지만 누적 오차 bounded. 리포트의 초당 RPS 윈도가 실제 달성 곡선을 정직하게 노출. ADR-0031 "v1 균등 틱, 정밀화 후속" 철학 연장 — **정확한 적분-역산(trapezoid quadratic inversion)은 연기**.

구현 노트: 고정 경로 byte-identical 보장을 위해 `stages.is_none()`이면 기존 상수 interval 코드를 그대로 타게 한다(곡선 분기는 `Some`일 때만).

## 5. 배선 (7-layer, 마이그레이션 0건)

S-A/S-C가 확립한 패턴 재사용. **마이그레이션 0건** — `stages`는 `profile_json` 필드(serde-default)라 `runs` 테이블 무변경. (S-C `runs.dropped`만 영역 D의 유일한 마이그레이션이었고, S-D는 추가 0건.)

| 레이어 | 변경 |
|---|---|
| **엔진** `runner.rs` | `pub Stage { target: u32, duration_seconds: u32 }` — **`runner.rs`에 둠**(`RunPlan` 옆), `scenario.rs`(YAML 수동-serde enum orbit) 아님. run-config 개념이라 YAML round-trip 불요 → **plain `#[derive(Serialize, Deserialize)]`**(단순 `{u32,u32}`, enum 함정 없음). `ThinkTime`처럼 store가 재사용(`pub`). `RunPlan.stages: Option<Vec<Stage>>`, `rate_at` + 곡선 스케줄러 (M2) |
| **proto** `crates/proto/proto/coordinator.proto` | `message Stage { uint32 target = 1; uint32 duration_seconds = 2; }` + `repeated Stage stages = 10;` (Profile). repeated → 비어있음 = absent. (M1: 파일명은 `coordinator.proto`, `handicap.proto` 아님) |
| **store** `store/runs.rs::Profile` | `stages: Option<Vec<Stage>>` `#[serde(default, skip_serializing_if = "Option::is_none")]` (`handicap_engine::Stage` 재사용) |
| **검증** `api/runs.rs::validate_run_config` | §3.3 상호배타 + §3.4 bounds + **§3.5 공유 `is_open_loop` predicate로 판별 사이트 전부 교체**(`:156`/`:215`/`:277` + 트리거 진입). `Some(vec![])`=absent 정규화 |
| **worker** `main.rs` | §3.5 predicate로 디스패치(`:305`), `RunPlan.stages` 빌드, **`plan.duration = stages 있으면 sum(stage.duration_seconds) / 없으면 기존`**(I2 불변식). proto `repeated`(Vec) → 비었으면 `None` 매핑 |
| **메트릭/리포트** | **무변경** — `MetricBatch`/`Aggregator`/`build_report` 그대로. 초당 RPS 윈도가 곡선을 이미 드러냄(새 집계 0) |
| **UI** | §6 |

**proto `Profile` literal 사이트(⚠ spec-plan-reviewer I1 — 정확 매핑 필요, `vec![]`만으론 부족):**
- `api/runs.rs:257` — **프로덕션 store→proto 변환**(`handicap_proto::v1::Profile { … }` 수동 literal). `stages: body.profile.stages.map(...).unwrap_or_default()` 식 **실 매핑** 필수(prost가 자동 채워주지 않음).
- `grpc/coordinator.rs:961` — 테스트 헬퍼(`base_assignment`) → `stages: vec![]`.
- `crates/proto/tests/run_assignment_env_test.rs:13` — proto round-trip 테스트 → `stages: vec![]`.

`Stage`는 신규 메시지라 그 자체 literal 사이트 없음. worker는 proto `Profile`을 *읽기*만 → worker엔 literal 없음. `MetricBatch` 무변경이라 그쪽 grep 불요.

## 6. UI (stages 영역 국한)

모든 S-D UI는 RunDialog의 **open 분기 안**에만. closed-loop·기존 `부하 모델` radio는 무변경(byte-identical UI).

### 6.1 D1 — fixed|curve 토글 (확정: 옵션 A)

open 분기 안에 작은 2-way 토글 `레이트: 고정 | 곡선` 추가. 모든 S-D 변경을 open 분기에 격리하고 연기한 "전체 모드 선택기"(3-way 재편)를 안 건드린다. (대안 B = 기존 radio 3-way화는 모드 선택기 영역 침범이라 기각.)

### 6.2 레이아웃 (curve 모드)

```
부하 모델:  ○ Closed-loop (VUs)   ◉ Open-loop (arrival rate)
레이트:     ○ 고정   ◉ 곡선(stages)

부하 모양 ▾ [ 점증·유지 ▾ ]   Max in-flight [200] (?)   HTTP timeout(s) [30]

 단계   목표 RPS    지속(s)
  1     [  200 ]    [  30 ]   ×
  2     [  200 ]    [ 120 ]   ×
  3     [    0 ]    [  30 ]   ×
        [+ 단계 추가]                  총 길이: 180s

 RPS ┤        ╭─────────╮
     │      ╭─╯         ╰─╮         ← 라이브 미리보기(Recharts)
   0 ┼──╯───────────────────╰──→ t
```

- **고정 모드**: 기존 `[Target RPS · Max in-flight · Duration · HTTP timeout]` 4칸(byte-identical). **곡선 모드**: `Max in-flight · HTTP timeout` + 부하-모양 드롭다운 + 단계 행 + 미리보기(Target RPS·Duration 칸은 stage가 대체).

### 6.3 구성 요소

1. **부하-모양 템플릿 드롭다운** (UI-only 상수, stages 배열 시드만 — 백엔드 무관): 점증·유지 / 스파이크 / 계단 스트레스 / 소크. 고르면 합리적 출발 곡선이 채워지고 사용자가 숫자만 손봄. 기존 run 프리셋(A2, 시니어가 저장)과 상보적 — 템플릿은 빈손 빌트인. 구체 시드 곡선 숫자는 plan에서 확정.
2. **단계 행 에디터**: `[목표 RPS][지속 s][×]` 반복 + `+ 단계 추가`. 숫자 입력은 **F5 draft + commit-on-blur**(`ui/CLAUDE.md` 표준 — 빈칸/NaN store 오염 방지). 총 길이 = duration 합 readout.
3. **라이브 미리보기 스파크라인**: Recharts LineChart, x=누적초 / y=RPS, 제어점 `(0,0)→(T₁,target₁)→…` 선형. jsdom 테스트는 explicit width/height(`ui/CLAUDE.md` Recharts+jsdom 함정). 주니어 이해의 핵심.
4. **인라인 helper + `?`**: 목표 RPS(이 단계 *끝*의 RPS, 이전 값에서 선형) / Max in-flight(동시 처리 상한, 초과분 drop) / 지속(초). 호버-only 툴팁 아니라 인라인 helper(a11y).
5. **검증 표면화**: 행별 invalid + "최소 한 단계 target>0" + 상호배타 메시지.
6. **Prefill/retry/preset**: 저장된 profile에 `stages` 있으면 open+curve 모드로 열고 시드(기존 `target_rps` prefill 미러). **reseed-by-key remount** 패턴(`ui/CLAUDE.md` — reseed effect 금지).

### 6.4 Zod

- `StageModel = z.object({ target: z.number().int().min(0).max(1_000_000), duration_seconds: z.number().int().min(1) })`.
- `ProfileSchema.stages: z.array(StageModel).optional()` — **`.default([])` 금지**(nested default 누출, `pnpm build`만 잡음 — `ui/CLAUDE.md`). 소비처 `?? []`. 기존 `target_rps`/`data_binding` optional 패턴 따름. `normalizeProfile`이 경계에서 정규화.

## 7. 테스트

- **엔진**: `rate_at` 단위(경계/중간/ramp-down-to-0 정확값) + open-loop+stages run이 곡선 추세 따르는지(S-C 하네스 재사용, 총 arrival·monotonic 추세 tolerance — `ramp-up flakiness` 함정 따라 정확 per-second 단언 금지). **stages 없음 → fixed-rate byte-identical** 가드.
- **컨트롤러**: `validate_run_config` 새 상호배타 400 전부 + stage 검증 + proto round-trip + e2e smoke(stages run 완료 + 리포트 초당 RPS 곡선, S-C e2e 미러).
- **워커**: RunPlan 빌드(duration=sum, stages 디스패치).
- **UI**: Zod round-trip, curve 모드(토글/템플릿 시드/행 추가·삭제/미리보기 렌더/검증/prefill).

## 8. 연기

- **closed-loop stages** (VU 곡선 + retire/ramp-down) = (b)+(c) 미래 슬라이스 (§2).
- **부하모델 모드 선택기** (3-way 재편) — 별도 UX 슬라이스 (로드맵 §D).
- **정확 적분-역산 스케줄러 정밀화** — v1 = 순간-rate (§4).
- **graceful drain** (ramp-down-to-0 시 in-flight grace) — 영역 spec §8 knob, deadline hard-cut 유지.
- **per-second drop 시계열** (S-C 연기 유지), **Poisson/exponential 분포** (ADR-0031 연기 유지), **per-stage think time 혼합** (영역 spec §S-D 연기).
- **open-loop 멀티워커 fan-out** (ADR-0031 §5 연기) — cap 상향·>20k RPS·>1만 동시의 토대.

## 9. ADR

신규 **ADR-0032 "다단계 ramp (open-loop 레이트 곡선)"** 를 이 슬라이스에서 작성. 결정 사항:
1. open-loop만(closed-loop 연기, 비대칭 반쪽 회피), forward-compat한 `stages` 필드.
2. `stages` = `target_rps`+`duration_seconds`의 generic 대체(상호 배타), `max_in_flight` 직교 필수, `max_in_flight` 없으면 closed-loop stages로 보고 400.
3. 시작 rate=0 (k6식) + fixed|curve UI 분리.
4. 순간-rate 스케줄러(v1, 정확 적분 연기), piecewise-linear.
5. 마이그레이션 0건(profile_json), 메트릭/proto MetricBatch 무변경, stages 없으면 byte-identical.

루트 `CLAUDE.md`의 "알아둘 결정들" 목록에도 한 줄 추가.

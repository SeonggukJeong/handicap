# 0032. 다단계 ramp (open-loop 레이트 곡선)

- 상태: 채택
- 날짜: 2026-06-05

## 맥락

S-C(ADR-0031)가 깔아 놓은 open-loop 인프라는 **단일 고정 레이트**(`target_rps`)만 지원한다.
실제 부하 시나리오에서는 서비스가 초기화·워밍업을 거친 뒤 목표 레이트에 도달하는 점증
패턴, 또는 일정→급증→일정 같은 다단계 모양을 자주 요구한다.

LoadRunner/JMeter 대체(ADR-0001)에서 "RPS 곡선"은 핵심 기능이다. S-D는 이를
`stages: [{target_rps, duration_seconds}]` 형태의 piecewise-linear 레이트 곡선으로 실현한다.
범위는 **open-loop RPS 곡선만** — closed-loop VU 곡선(retire/ramp-down)은 별도 미래
슬라이스로 연기했다(아래 §연기 참조).

## 결정

### 1. open-loop 전용 (closed-loop stages 연기)

`stages`는 open-loop(`max_in_flight` 필수)에서만 허용한다. closed-loop(고정 VU) stages는
연기하는 이유: "VU 올리기만" 단독 구현은 비대칭 반쪽 기능(올리기는 있고 내리기/회수는 없음)
으로 인터페이스 설계 상의 혼란을 초래한다. VU ramp-up(올리기)+ramp-down(회수)을 양방향 한
번에 완결하는 것이 더 일관된 UX이므로, 그 시점까지 closed-loop stages를 예약(`stages` 필드
forward-compat 설계 — 미래 closed-loop stages도 같은 필드 재사용 가능).

### 2. `stages`는 `target_rps` + `duration_seconds`의 generic 대체

S-C의 `target_rps: Option<u32>`와 `duration_seconds: u32`는 **`stages`와 상호배타**다.
`stages`를 지정하면 `target_rps`, `duration_seconds > 0`, `ramp_up_seconds > 0`은 400
BadRequest. `max_in_flight`는 `stages`와 직교 + **필수**(없으면 400 — "open-loop 백프레셔
필수" 불변식, S-C 검증과 동일). `stages` 없이 `max_in_flight`만 지정하면 기존 `target_rps`
고정 경로(S-C). **`Some(vec![])` = absent**: 빈 stages는 None과 동일하게 취급된다.

워커가 `plan.duration = sum(stage.duration_seconds)`를 계산해서 컨트롤러에 전달하는 것이
의무(엔진은 `plan.duration`에서 deadline을 파생 — stages 구조체를 직접 sum 안 함).

### 3. 시작 레이트 = 0 (k6 스타일) + fixed|curve UI 분리

레이트 곡선은 항상 **0에서 시작**해 첫 stage의 target으로 선형 증가한다. 이는 k6의 스테이지
컨벤션과 일치하고, "워밍업 없이 풀레이트" 패턴은 S-C 고정 레이트(`target_rps`)로 표현한다.

RunDialog UI는 "레이트: 고정 | 곡선" 토글로 두 경로를 명시적으로 분리한다. 고정 모드는
S-C 경로(`target_rps`)를 그대로 사용하고, 곡선 모드가 `stages` 경로다. 두 경로를 같은
입력 폼으로 합치면 상호배타 검증을 UI가 흡수하지 못해 400 응답이 UX에 노출된다.

### 4. 순간-레이트 스케줄러 v1 (piecewise-linear, `rate_at`)

`rate_at(stages, elapsed)` 순수 함수가 경과 시간을 받아 그 순간의 RPS를 계산한다
(구간별 선형 보간, 마지막 구간 종료 후 = 마지막 target 고정). **평가 기준은 `next`(예약된
tick의 시간)**이고 `now`가 아니다: `now` 기준이면 ramp 초반에 `now ≈ 0` → rate ≈ 0 →
첫 interval이 수 초 → ~1회 arrival만 발사된다. `next` 기준으로 "다음 tick이 얼마나 자주
와야 하는가"를 계산해야 ramp-up 처음부터 정확한 레이트가 나온다.

`rate ≤ RATE_EPS(1e-9)` 구간에서는 arrival을 발사하지 않고 100ms poll-step(cancel-aware)
으로 대기한다. `now < next` wait은 `deadline`으로 clamp해서 곡선이 만든 큰 interval이
run 종료를 블록하지 않는다.

이 스케줄러는 기존 `run_scenario_open_loop`의 **interval 계산 부분만** 교체한다. 루프
body(슬롯 try_recv → spawn / drop+yield / next+=interval) 구조는 S-C와 동일하다.
`target_rps` 고정 경로와 `stages` 곡선 경로 모두 같은 루프 body를 통과하므로, S-C
closed-loop 경로는 여전히 byte-identical이고, `stages` 없는 open-loop(고정 `target_rps`)는
behaviorally-equivalent(deadline clamp 공유, arrival/drop/메트릭 무변경)이다.

정확 적분(trapezoid 면적 역산)/Poisson 분포는 v1 외 연기.

### 5. migration 0 (profile_json), 메트릭/proto MetricBatch 무변경

`stages`는 `Profile.stages: Option<Vec<Stage>>`로 `profile_json` JSON 컬럼에 저장된다
(`#[serde(default, skip_serializing_if="Option::is_none")]`). `runs` 테이블 스키마 무변경.
옛 행 역직렬화 시 `stages=None` 자동 적용 → byte-identical(S-A/S-B 패턴과 동일).

proto `Profile`에 `repeated Stage stages = 10`을 추가했다. `Stage{target, duration_seconds}`
추가로 proto `Profile`이 암묵적 `Copy`를 잃었으므로 dispatch 사이트에서 `.clone()` 한 곳
필요(1회, per-dispatch).

메트릭/`MetricBatch`/`run_metrics`/`run_loop_metrics`/`run_if_metrics` 무변경.
`dropped` 카운터(migration 0009, S-C)도 stages 경로에서 그대로 동작.

### 6. `is_open_loop()` predicate로 판별 통일

S-C는 `target_rps.is_some()`을 open-loop 식별자로 3곳에서 직접 사용했다.
S-D에서 두 번째 open-loop 트리거(`stages` 비어있지 않음)가 추가됐으므로,
`Profile::is_open_loop() → target_rps.is_some() || stages.as_ref().is_some_and(|s| !s.is_empty())`
메서드로 판별을 한 곳으로 통일했다. 3개 discriminator 사이트(unique 워커 수 / per_vu
slot_count / create 워커 수) + validate entry 전부 교체. `target_rps.is_some()` 직접 분기
금지 — stages-only run이 closed-loop으로 오분류돼 VU 기반 fan-out/wrong data-binding
slicing을 낳는다.

단일워커 v1(fan-out 연기)은 S-C와 동일: open-loop 시 `worker_count = 1`.

## 결과

**Positive**
- `stages` 없는 모든 run(기존 closed-loop + 기존 고정 open-loop)은 byte-identical/
  behaviorally-equivalent — 회귀 0.
- `rate_at` 순수 함수 + 격리된 interval 계산 교체라 기존 루프 body 회귀 0 (구조적 보장).
- 미리 만든 4개 부하-모양 템플릿(점증/유지·스파이크·계단·소크) + 라이브 Recharts 곡선
  미리보기로 stages 입력 부담 최소화.
- `is_open_loop()` 통일로 미래 세 번째 open-loop 트리거 추가 시 한 곳만 변경.

**Negative / Trade-offs**
- `stages`와 `target_rps`/`duration_seconds`가 상호배타 → validation이 복잡해짐(RunDialog
  UI가 고정/곡선 토글로 표현 불가능하게 해결).
- proto `Profile` `Copy` 상실 → dispatch 사이트 `.clone()` 1곳 추가(negligible).
- `rate_at`의 "next 기준 평가"는 비직관적 — 주석 없이 보면 `now` 기준으로 바꾸기 쉽고
  그러면 ramp-start ~1 arrival 버그가 재현된다(engine CLAUDE.md 함정으로 기록).
- v1 순간-레이트 스케줄러는 cumulative target 보정 없음 — drop이 많은 구간 직후 구간에서
  잠시 실제 도착률이 목표보다 낮을 수 있다(정확 적분으로 해소 가능, 연기).
- 단일 워커 v1은 stages 고RPS 총합도 ~20k RPS 천장(fan-out 연기).

## 연기

- **closed-loop stages (VU 곡선 + retire/ramp-down)**: VU를 시간에 따라 늘리고 줄이는 양방향
  ramp. open-loop과 달리 "VU 수가 실행 중에 변한다"는 run-workers 상태머신 변경 필요.
- **부하모델 모드 선택기 (UX)**: RunDialog 상단에 "고정 VU(closed) / 고정 레이트 / 레이트
  곡선" 라디오로 상호배타 400들을 표현 불가능하게 만드는 전면 리팩터. S-D 이후 별도 슬라이스.
- **정확 적분 스케줄러**: cumulative area 계산으로 구간 경계 오차 보정(trapezoid 역산 or
  pre-computed lookup).
- **graceful drain**: stages 종료 시 in-flight 요청을 소진 후 종료(현재 deadline 도달 시
  즉시 중단).
- **per-second drop 시계열**: dropped가 어느 구간에서 터졌는지 시계열 분해(run-total만 있음).
- **Poisson/exponential 분포**: 균등 틱 대신 도착 시각의 확률 분포.
- **open-loop fan-out**: `ceil(max_in_flight/capacity)` 워커 N개 fan-out(단일 워커 ~20k
  RPS 천장 돌파).

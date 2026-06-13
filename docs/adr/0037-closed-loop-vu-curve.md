# 0037 — Closed-loop VU 곡선: park-gate 격리 함수 + vu_stages/ramp_down 와이어

- Status: accepted
- Date: 2026-06-13

## Context

영역 D(부하 모델·페이싱)의 S-D 슬라이스는 **open-loop RPS 곡선**(`stages:[{target_rps, duration}]`,
ADR-0032)을 구현했고, closed+curve 조합("VU 곡선")을 disabled "곧 지원"으로 연기했다
(부하 모드 선택기 ADR, 2026-06-05). 목표는 k6 ramping-vus 스타일의 **VU 수를 시간에
따라 ramp up → sustain → ramp down**하는 closed-loop 부하 형태다.

설계 제약:
- 기존 `run_scenario`(closed-loop 고정 VU)·`run_scenario_open_loop`(RPS 곡선)는
  **byte-identical** 유지(회귀 0). 새 경로를 추가해야 한다.
- VU를 retire할 때 **세션(cookie jar)을 버리지 않아야** 한다 — 실제 사용자가
  잠시 빠졌다가 돌아올 때 세션이 그대로인 것과 같다(k6 ramping-vus 의미론).
- 마이그레이션 0건(profile_json serde default), proto 최소 additive, 단일 워커 v1.

## Decision

### 신규 격리 엔진 함수 `run_scenario_vu_curve`

`run_scenario`와 `run_scenario_open_loop`를 수정하지 않고 **별도 함수**를 추가한다.
컨트롤러 워커 dispatch는 3-way 분기로: `vu_stages` 지정 → `run_scenario_vu_curve`,
`target_rps|stages` 지정 → `run_scenario_open_loop`, 아무것도 없음 → `run_scenario`.

### 와이어 스키마

- `Profile.vu_stages: Option<Vec<Stage>>`(target 필드 = VU 수로 재해석, duration_seconds은
  동일). proto field **12**(repeated Stage vu_stages). ADR-0032의 open-loop `stages`
  field 10과는 별개 필드 — 혼합 사용 시 컨트롤러 400 거부.
- `Profile.ramp_down: Option<String>` — `"graceful"`(기본, iteration 완료 후 park) |
  `"immediate"`(child CancellationToken 취소 → 다음 스텝 경계 후 park). proto field **13**
  (string ramp_down_immediate를 bool이 아닌 string으로 표현, absent="graceful").
- 마이그레이션 0건: profile_json에 serde default로 흡수.

### Park & 재사용 (retire ≠ 종료)

VU를 retire할 때 task를 종료하지 않고 **park 채널**로 재사용 슬랩에 돌려놓는다.
같은 `vu_id`·cookie jar·`VuClient`가 다음 re-activation에 재사용된다.

- `vu_id ∈ [vu_offset, vu_offset + max_vus)` 고정(멀티워커 글로벌 범위 준수, ADR-0027).
- park 중 VU의 task는 `watch::Receiver<usize>`를 await하며 대기. desired_active 값이
  자신의 슬롯 인덱스보다 크면 깨어난다.
- **retire-abort**(immediate 모드의 child token 취소): 진행 중 HTTP 요청 1개는 마저
  끝남(소켓 찢기 비목표). `failed`++ 없음 — park 후 재사용 대기이므로 "실패"가 아니다.

### 슈퍼바이저(park-gate)

250ms tick의 inline 슈퍼바이저 루프가 `desired_active: usize`를 `watch::Sender`로
방송한다. 매 tick:
1. 현재 elapsed를 기준으로 `vu_at(stages, elapsed)`로 목표 VU 수 계산.
2. `desired_active` < 현재 active → retire(graceful: 다음 iteration 완료까지 대기;
   immediate: child token 취소).
3. `desired_active` > 현재 active → park 슬랩에서 VU 꺼내 re-activate. 없으면 신규
   spawn(max_vus 상한 내).
4. 모든 VU task가 실패로 종료(park 아님)하면 `AllVusFailed` 조기 종료.
   **AllVusFailed는 spawned 기준** — park 중 VU는 spawned에 포함되므로 목표 VU 미달
   단계가 잘못 트리거하지 않는다.
5. deadline 도달 시 graceful/immediate 구분 없이 모든 active VU를 park·종료 후 함수 반환.

### 단일워커 v1

`max(vu_stages[].target) > worker capacity`이면 컨트롤러 400 거부. 멀티워커 샤딩은 연기.

### 비목표 (spec §10)

- mid-request 소켓 중단(메트릭 오염 방지 — 진행 중 요청은 항상 완료).
- open-loop와의 혼합 모드(`vu_stages` + `target_rps`/`stages` 동시 — 400 거부).
- 기존 두 모드(closed 고정 VU·open-loop)의 어떤 행동 변화(byte-identical).
- 라이브 대시보드류 실시간 VU 표시(ADR-0009).

## Consequences

- `run_scenario_vu_curve` 신규 추가, 기존 두 함수 무변경(byte-identical 구조적 보장).
- MetricFlush 드레인 4+2=**6곳**, send-guard 3+2=**5곳**(open-loop final 무가드 유지).
- proto field 12(vu_stages)+13(ramp_down) additive — 기존 binary 순방향 호환.
- UI: closed+curve 조합이 RunDialog에서 활성화, VU-axis stage 에디터 + ramp_down 선택기.
- 연기(§B9 roadmap): 멀티워커 샤딩·active-VU 시계열·graceful 상한(k6 gracefulRampDown
  류)·fresh-spawn 모드·VU 표시 개선·criteria `ramp_down_seconds` prefill.

## Alternatives considered

1. **기존 `run_scenario` 수정**: desired_active 채널을 넣어도 park-gate 분기가 고정 VU
   경로를 오염시켜 byte-identical 구조적 보장 상실.
2. **retire = spawn/cancel**: VU task를 종료하고 새 task로 재생성. cookie jar가 사라져
   "돌아온 사용자 세션" 재현 불가 — 매번 새 사용자로 처리됨(ADR-0018 위반).
3. **open-loop `stages` 재사용**: target 필드가 RPS와 VU를 동시에 의미하게 되어
   API 의미론 혼동(RPS 곡선 + VU 곡선 구분 불가). 별도 `vu_stages` 필드로 명확 분리.

# open-loop 곡선 도착 스케줄 = 누적 도착 역산 — 설계

- 날짜: 2026-10-18 · 유형: **correctness-bug** · 워크트리: `curve-arrival-integral` (브랜치 `worktree-curve-arrival-integral`)
- 상태: **완료** (2026-10-19, 코드 `6f417fb1`..`0746631b`, build-log `docs/build-log.md:769`). **§2 비목표 '컨트롤러 변경 0'에서 편차 1건**: 최종 리뷰가 적발한 startup 워치독 회귀(느린 ramp의 첫 도착 √(D/s)가 grace 90s 초과) 때문에 `api/runs.rs::curve_first_arrival_secs`를 `startup_grace_eff`에 가산(`0746631b`) — 판단·비용은 roadmap §B36.
- 출처: `docs/roadmap.md` §B34 (2026-10-18 재현, 수정은 별도 엔진 슬라이스 — 사용자 결정). ADR-0032 §4가 "정확 적분(trapezoid 면적 역산)… v1 외 연기"로 남긴 항목을 해소한다.
- **§B34 해소 경로 대비 편차 1건**: §B34는 "rate 0 구간 poll-step… 유지"라 적었지만 이 spec은 poll-step을 **제거**한다 — Λ⁻¹이 0 구간을 건너뛰므로 남기면 실행되지 않는 dead code다(§3.3). 설계 승인 시(2026-10-18) 이 결정을 사용자에게 명시 제시했다.
- 새 ADR 없음: 곡선의 *의미*(0에서 시작하는 piecewise-linear 레이트 함수, ADR-0032 §3)는 그대로 두고, 그 함수를 도착 시각으로 바꾸는 *알고리즘*만 정정한다. ADR-0032는 규약(`docs/dev/root-doc-maintenance.md` §ADR 상태 갱신 규약)대로 헤더 요약 + §3.4의 6곳(§4·§결과·§연기) 괄호 주석만 덧붙인다.
- 사용자 조건(2026-10-18 설계 승인 시): "성능 상에 문제가 없고, 기대한 부하를 출력할 수 있다면 이견이 없어." → §5(성능)·§6(검증)이 이 두 조건을 각각 증명 대상으로 삼는다.

## 사용자 스토리 (US)

- **US1** (재현 / 기대 / 실측) — 유형 `correctness-bug`:
  - **재현:** open-loop `stages`로 0에서 출발하는 완만한 곡선을 실행한다(워크트리 바이너리·responder 50ms·`max_in_flight` 50, API 직접 생성 — §B34 재현 조건). UI 곡선 프리셋 `점증·유지`·`소크`(`ui/src/components/loadShapes.ts`)의 첫 구간도 같은 모양이지만, 프리셋 기본값(큰 target)에서는 손실이 미미하다(리뷰 시뮬레이션: 30,000 중 ~6, 186,000 중 ~28). 큰 손실은 **작은 target이나 fan-out 분할로 워커당 target이 작아질 때** 난다.
  - **기대:** 발생 요청 수 ≈ ∫rate (±1).
  - **실측** (§B34 표):

    | 곡선 | 기대(∫rate) | 실측 count |
    |---|---|---|
    | `[{target:5,duration_seconds:10}]` | 25 | **1** |
    | `[{target:10,duration_seconds:6}]` | 30 | **2** |
    | `[{target:20,duration_seconds:6}]` | 60 | 46 |
    | `[{target:20,duration_seconds:6}]` + `worker_count:2` | 60 | **4** |
    | 대조 `[{20,1},{20,7}]` 단일/2워커 | 150 | 148 / 142 |

  - **완료 시 관찰:** 위 표의 곡선을 다시 돌리면 `summary.count`가 기대치의 ±1(2워커는 워커당 ±1이라 합 ±2) 안에 든다. 고정 `target_rps` run과 closed-loop run의 count는 수정 전 바이너리와 같은 범위다.
- **US2** — 유형 `correctness-bug` (사용자 조건 "성능 상에 문제가 없고"):
  - QA가 많은 stage를 가진 곡선이나 고레이트 곡선을 걸어도 스케줄러가 병목이 되지 않는다. 성공하면 ① 도착당 스케줄 계산이 stage 수와 무관함을 결정적 단위 테스트가 증명하고(§6.1 c — 고의 회귀 시 RED), ② 고레이트 곡선(0→1000 rps 2초 + 1000 rps 6초)을 수정 전/후 바이너리로 돌린 `summary.count`가 둘 다 ∫rate(7000)의 1% 안이며 `dropped` 0이다(비회귀 스모크 — §6.3).

## 1. 문제

`crates/engine/src/runner.rs`의 `run_scenario_open_loop`(확인: `grep -n "pub async fn run_scenario_open_loop" crates/engine/src/runner.rs` → 1328)는 곡선 모드에서 다음 도착 간격을 **예약 시각의 순간 레이트 역수**로 정한다(`:1461-1476`, `grep -n "let rate = rate_at(stages, next_elapsed)" crates/engine/src/runner.rs` → 1465):

```
interval = 1 / rate_at(stages, next − started_at)
next    += interval                                  (:1541)
```

곡선은 항상 rate 0에서 시작한다(ADR-0032 §3). t=0은 rate 0 → 100ms poll 후 `next = Instant::now()`(≈0.1s) → 0→5/10s에서 rate(0.1)=0.05 → interval 20s → deadline clamp(`:1449`)까지 다음 도착이 없다. 기울기가 완만할수록, fan-out으로 워커당 target이 작아질수록(컨트롤러가 stage target을 워커 수로 정수 분할 — `crates/controller/src/grpc/coordinator.rs` 테스트 `:2017` `w0.stages[0].target + w1.stages[0].target == 10`) 손실이 커진다.

근본 원인은 "다음 간격 = 지금 레이트의 역수"라는 **국소 근사** 자체다. 레이트가 0 근처에서 출발하는 한 첫 간격이 발산하고, 그 사이 레이트가 올라가도 반영되지 않는다. `crates/engine/CLAUDE.md` S-D 항목("`next` 기준 평가로 ramp 초반 버그 해소")은 `now` 대비 개선일 뿐 이 결함을 막지 못한다.

**기준선과의 정합**: 컨트롤러 `crates/controller/src/insights.rs::scheduled_arrivals`(확인: `grep -n "pub(crate) fn scheduled_arrivals" crates/controller/src/insights.rs` → 116)는 이미 곡선의 **사다리꼴 적분**을 "계획된 도착 수"로 쓴다(사이징 인사이트 `achieved_per_sec = (scheduled − dropped)/duration`의 기준값, `insights.rs:480`). 즉 리포트는 ∫rate를 약속하는데 엔진만 그것을 지키지 않는다. 수정 후 엔진이 이 기준에 맞는다.

## 2. 목표 / 비목표

**목표**
- G1: 곡선 모드에서 [0, T) 동안 발사(시도)되는 도착 수 = Λ(T)를 반올림한 값(차이 ≤ ½). Λ(t) = ∫₀ᵗ rate_at(stages, s) ds.
- G2: 도착당 스케줄 비용이 stage 수와 무관(amortized O(1)) — 수정 전(도착마다 `rate_at`의 O(stages) 순회)보다 나빠지지 않는다.
- G3: 고정 `target_rps` 경로·closed-loop(`run_scenario`)·VU 곡선(`run_scenario_vu_curve`)·슬롯 풀/drop/catch-up/메트릭은 무변경.

**비목표**
- Poisson 도착(무작위 간격) — 균등 결정적 스케줄 유지(ADR-0031).
- 컨트롤러 `scheduled_arrivals`와 수학 공유 리팩터(엔진 함수는 private, 두 구현은 테스트로 각자 의미 고정 — 현 구조 유지).
- UI·proto·컨트롤러·워커·migration 변경 0.
- 멀티워커 분할 정밀도(정수 분할 잔차)는 범위 밖 — 분할은 컨트롤러 소관이고 합은 보존된다.

## 3. 설계

### 3.1 k번째 도착 시각

도착 인덱스 k = 0, 1, 2, … (drop 포함 *시도* 순번 — §3.3)에 대해

```
t_k = Λ⁻¹(k + ½)          (Λ(t) = k + ½ 이 되는 최소 t)
```

[0, T)에 드는 도착 수 = #{k ≥ 0 : k + ½ < Λ(T)} = ⌈Λ(T) − ½⌉ → |count − Λ(T)| ≤ ½. `+½` 위상은 반올림 기준을 준다(정수 Λ(T)면 정확히 Λ(T)개: 0→5/10s → 25). `Λ⁻¹(k+1)`(floor 기준)이면 24개가 돼 마지막 도착이 정확히 deadline에 걸려 버려진다.

**0 구간 자동 처리**: Λ는 rate 0 구간에서 평평하므로 Λ⁻¹은 그 구간을 건너뛰어 다음 양(+)의 레이트 구간 안의 시각을 돌려준다. `{0, d}` hold·0으로 끝나는 ramp-down 꼬리에 별도 poll 로직이 필요 없다(§3.3).

### 3.2 `ArrivalSchedule` — 순수 함수 단위 (`runner.rs`, `rate_at` 옆)

```rust
/// Λ(t)=∫rate 의 역함수를 단조 커서로 평가 (§B34). 호출마다 m이 비감소여야 한다.
struct ArrivalSchedule {
    segs: Vec<Seg>,   // stage별: t0, dur, r0, slope, cum0(구간 시작의 Λ), area
    cursor: usize,    // m이 비감소라 앞으로만 이동
    end_t: f64,       // Σdur
    end_cum: f64,     // Λ(end_t)
    tail_rate: f64,   // 마지막 target (곡선 끝 이후 rate_at과 동일하게 상수 유지)
}
impl ArrivalSchedule {
    fn new(stages: &[Stage]) -> Self;
    /// Λ(t) = m 인 최소 t(초, started_at 기준). 도달 불가(곡선이 0으로 끝났고 m > 총면적,
    /// 또는 stages 비어 있음)면 None.
    fn time_at(&mut self, m: f64) -> Option<f64>;
}
```

- **구간 모델**: stage i는 `[t0, t0+dur]`에서 `r(t) = r0 + slope·(t−t0)`, `r0` = 직전 target(첫 stage는 0), `slope = (target − r0)/dur`, `area = (r0 + target)/2 · dur`. `rate_at`(`:789`)과 같은 곡선이다. `duration_seconds == 0` stage는 컨트롤러가 거부하지만(`crates/controller/src/api/runs.rs:363` "stage duration_seconds must be >= 1") 엔진은 방어적으로 area 0 구간으로 취급해 건너뛴다(레이트 점프만 반영 — `rate_at`의 span 0 처리와 같다). 이때 `slope = 0`으로 저장해 inf/NaN이 구조에 들어가지 않게 한다(커서가 건너뛰어 무해하더라도 그 우연에 기대지 않는다).
- **구간 내 해**: 남은 양 Δ = m − cum0 (0 ≤ Δ ≤ area)에 대해 `slope/2·τ² + r0·τ = Δ`. 수치 안정형 하나로 증가·감소·평평 구간을 모두 푼다:

  ```
  τ = 2Δ / (r0 + √(max(0, r0² + 2·slope·Δ)))
  ```

  - 평평(slope=0): τ = Δ/r0. 0에서 출발(r0=0, slope>0): τ = √(2Δ/slope).
  - 감소(slope<0): Δ ≤ area이면 판별식 ≥ (r0+slope·dur)² = target² ≥ 0이다(이 관계는 대수 항등식이므로 `max(0, ·)`은 부동소수 잡음 가드일 뿐이다).
  - 분모 0은 r0=0 ∧ 판별식 0일 때뿐인데, 그건 Δ=0(→ τ=0으로 처리)이거나 area 0인 구간(커서가 건너뜀)이다.
- **커서**: `cursor` 구간의 `cum0 + area < m`이면 앞으로 전진. 한 run 동안 커서는 최대 stage 수만큼만 움직인다 → 도착당 amortized O(1)(G2).
- **검사 카운터(테스트 전용)**: `#[cfg(test)] scans: u64` — `time_at`이 구간 하나를 검사할 때마다 +1. §6.1 c가 "호출 N회의 총 검사 수 ≤ N + segs.len()"으로 G2를 결정적으로 잠근다(시간 측정 없음). 프로덕션 빌드엔 필드가 없다.
- **곡선 끝 이후**: m > end_cum이면 `tail_rate > 0`일 때 `end_t + (m − end_cum)/tail_rate`, 아니면 None. (deadline = Σdur라 실사용에선 거의 닿지 않지만 `rate_at`의 "끝 이후 = 마지막 target" 의미와 일치시킨다.)
- 반환값은 항상 유한·비음수다(Δ ≥ 0, 분모 > 0).

### 3.3 스케줄러 루프 배선 (`run_scenario_open_loop`)

바뀌는 것은 "다음 `next`를 정하는 곳" 두 군데뿐이다. 슬롯 try_recv→spawn / drop+yield 본문은 그대로다.

- 루프 진입 전:
  - `let mut schedule = plan.stages.as_deref().map(ArrivalSchedule::new);` — 빈 필터를 **두지 않는다**. 현행 `curve = plan.stages.clone()`(`:1436`)도 `Some(vec![])`을 곡선 분기로 보내 아무것도 발사하지 않으므로(rate 0 poll), 빈 stages → `time_at` None → `next = deadline`이 현행 관찰 동작과 같다(G3). 프로덕션은 워커가 빈 proto `stages`를 `None`으로 바꿔(`crates/worker/src/lib.rs:617`) 도달하지 않는다.
  - `let mut tick: u64 = 0;` — 곡선 모드의 도착 *시도* 순번. **`arrival_counter`(발사된 것만 세고 `iter_id`로 쓰임, `:1482`)와 별개**여야 한다. drop된 tick도 스케줄 슬롯 하나를 소비하므로, 발사 수로 다음 시각을 정하면 drop 뒤 스케줄이 뒤로 밀려 레이트가 낮아진다(고정 경로의 `next += interval`이 drop에도 전진하는 것과 같은 의미).
  - 초기 `next`: 고정 → `started_at`(현행). 곡선 → `curve_time(0)`.
  - `curve_time(k)` = `schedule.time_at(k as f64 + 0.5)`가 `Some(s)`이고 `s < duration_secs`면 `started_at + Duration::from_secs_f64(s)`, 그 외(None 또는 s ≥ duration)는 `deadline`. deadline으로 clamp하므로 `from_secs_f64`에 큰 값이 들어가지 않는다.
- 반복 끝(현 `next += interval`, `:1541`):
  - 고정: `next += fixed_interval` — 현행 산술 그대로(`fixed_interval` 선계산 `:1438` 유지 → byte-identical).
  - 곡선: `tick += 1; next = curve_time(tick);`
- **제거**: 곡선 분기의 `rate_at` 호출·`RATE_EPS`·100ms poll-step·`next = Instant::now()` 리셋(`:1432-1476`). 0 구간은 Λ⁻¹이 건너뛰고, 남은 도착이 없으면 `next = deadline`이 되어 기존 `now < next` 대기(`next.min(deadline)` clamp + `cancel` select, `:1446-1454`)가 deadline까지 잔다 → 루프 머리의 `now >= deadline` 검사로 종료. cancel 응답성은 그 select가 그대로 보장한다(poll-step의 cancel 경로와 같은 메커니즘).
- **수용하는 동작 변화 — `exhausted` 감지 지연**: poll-step은 0 구간에서 100ms마다 깨어나 루프 머리의 `exhausted` 검사(`:1441`)를 돌렸다. 제거 후엔 unique 데이터셋이 소진된 직후 0 구간(또는 긴 간격)이 오면 run은 다음 예약 도착 시각이나 deadline에 끝난다(최대 그 0 구간 길이만큼 늦게). 양(+)의 저레이트 구간에선 수정 전에도 같은 지연이 있었다. 결과(요청 수·메트릭)는 같고 run이 설정 길이보다 일찍 끝나는 경우의 종료 시각만 늦어진다 — 깨우기 채널(`Notify`) 추가는 범위 밖으로 둔다.
- `rate_at`은 VU 곡선(`:933`)이 계속 쓰므로 남긴다.
- **catch-up 동작 무변경**: 스케줄이 밀려 `now ≥ next`이면 지금처럼 즉시 발사(또는 drop)하고 다음 tick으로 넘어간다. 절대 시각 스케줄이라 누적 가산(`next += interval`)의 부동소수 드리프트도 없다.

### 3.4 문서

- `crates/engine/CLAUDE.md` "다단계 ramp 곡선" 절 `:74`·`:75`(확인: `grep -n "rate_at\`는 반드시\|RATE_EPS(1e-9)" crates/engine/CLAUDE.md`) — 순간 레이트·poll-step 서술을 누적 역산 서술로 교체하고 §B34 출처 태그를 단다(이 파일은 함정 노트라 사실이 바뀌면 고친다 — ADR과 달리 덧붙이기 규약 대상 아님). `:73`의 "interval 산출만 주입" 문장도 "다음 시각 산출만 주입"으로 맞춘다.
- `docs/adr/0032-multi-stage-open-loop-rate-curve.md` — 헤더 상태 줄에 요약 한 마디 + 낡는 문장에 괄호 주석(해소 날짜·slug·build-log 포인터, 본문 재작성 금지): §4 "평가 기준은 `next`" 문단(`:49-53`)·poll-step 문단(`:55`)·§4 끝 "정확 적분… v1 외 연기"(`:65`)·§결과 "next 기준 평가는 비직관적"(`:106-107`)·§연기 "정확 적분 스케줄러"(`:118`). **§결과 `:108-109`("drop이 많은 구간 직후 실제 도착률이 낮을 수 있다… 정확 적분으로 해소 가능")는 해소되지 않는다** — 이 설계에서도 drop은 tick을 소비하므로(§3.3) 놓친 도착을 되살리지 않는다. 그 문장엔 "정확 적분 도입 후에도 유지 — drop은 스케줄 슬롯을 소비(의도)" 주석을 단다.
- 완료 기록(build-log·roadmap §B34 상태·현황판·CLAUDE 상태줄)은 `/finish-slice`가 한다.

## 4. 오류 처리

새 실패 경로 없음. `time_at`은 패닉하지 않는다(나눗셈 분모 > 0 보장, `sqrt` 인자 클램프, 빈 stages → None). `Duration::from_secs_f64`는 [0, duration) 범위 값만 받는다(§3.3 clamp). 곡선이 0으로 끝나 도착이 소진되면 run은 deadline까지 기다렸다 정상 종료한다(현재 poll-step의 관찰 동작과 같다).

## 5. 성능 (사용자 조건 ①)

- **도착당 비용**: 수정 전 = `rate_at` O(stages) 순회 + 나눗셈 1회. 수정 후 = 커서 비교(대개 0회 전진) + `sqrt` 1회 + 곱셈 몇 개. stage 수와 무관하고 수정 전보다 크지 않다(G2).
- **메모리**: run당 `Vec<Seg>`(stage 수만큼) 1회 할당. 도착당 할당 없음.
- **스케줄 정밀도**: f64 초 단위, k ≤ 2⁵³까지 `k + 0.5` 정확. 1M rps × 24h도 범위 안.
- **증명 방법**: 1차 증거는 §6.1 c의 **결정적 검사-카운터 테스트**다(총 구간 검사 수 ≤ 호출 수 + stage 수; 커서를 매 호출 0으로 되돌리는 고의 회귀에서 RED 실증). 시간을 재지 않으므로 CI 러너 속도와 무관하다. §6.3의 라이브 A/B는 1000 rps에서 스케줄러가 병목과 거리가 멀어(도착 간격 1ms ≫ 도착당 계산) 회귀 *검출기*가 아니라 **비회귀 스모크**다.

## 6. 검증 (사용자 조건 ②)

### 6.1 단위 (`runner.rs` `mod tests`, 순수·결정적)

- a) **해석해 대조**: `[{5,10}]`에서 `time_at(k+½) == √(4(k+½))`(|오차| < 1e-9), k = 0..24. Λ(t)=t²/4.
- b) **개수 성질**: 곡선 표(단일 ramp·ramp+hold·`{0,d}` 선행 hold·ramp-down to 0·상승/하강 다구간·§B34 재현 4곡선)마다 T=Σdur에 대해 `#{k : time_at(k+½) < T}`와 테스트 안의 독립 사다리꼴 Λ(T)의 차이 ≤ ½. (독립 Λ는 테스트 헬퍼로 따로 계산 — 구현의 `cum0`을 재사용하면 같은 오류를 같이 품는다.)
- c) **단조·커서·O(1)**: ① 연속 호출 결과가 비감소. ② 같은 m 열을 fresh 인스턴스로 하나씩 평가한 값과 재사용 인스턴스 값이 같다(낡은 커서 검출). ③ 1000-stage 곡선에서 `time_at(k+½)`을 k = 0..N(N ≥ 총면적의 절반 — 커서가 곡선 뒤쪽까지 가도록) 호출한 뒤 `scans ≤ N + segs.len()`. **이빨 실증**: 커서를 매 호출 0부터 다시 훑게 바꾸면 ③이 RED(검사 수 ≈ N × 평균 구간 인덱스)여야 하고, 원복 시 GREEN. ②만으로는 "매번 0부터 훑는" 구현도 통과하므로 ③이 G2의 유일한 잠금이다.
- d) **0 구간 건너뜀**: `[{0,2},{10,2}]` → `time_at(0.5) ≥ 2.0`.
- e) **소진**: `[{10,2},{0,2}]`(면적 20) → `time_at(19.5)`는 `Some(< 4.0)`, `time_at(20.5)`는 None.
- f) **끝 이후 연장**: `[{10,1}]`(면적 5) → `time_at(5.5)`가 1.05와 |오차| < 1e-12.
- g) 빈 stages → None.

### 6.2 엔진 통합 (`crates/engine/tests/open_loop.rs`, 실 wiremock·짧은 run)

- 새 테스트 — 앞의 셋은 수정 전 코드에서 **RED**여야 한다(구현 전 실행으로 실증; 수정 전 예상 count는 각 1건):
  - `[{5,4}]`(Λ=10; 수정 전 rate(0.1)=0.125 → 간격 8s → ~1건) → count ∈ [9, 11].
  - `[{10,3}]`(Λ=15) → count ∈ [14, 16].
  - `[{0,1},{10,2}]`(선행 0 hold, Λ=10) → count ∈ [9, 11].
  - `[{10,1},{10,1},{0,1}]`(0으로 끝나는 꼬리, Λ=20) → count ∈ [19, 21], run이 deadline 근처에서 정상 종료. 이 테스트는 꼬리 소진·종료 가드라 수정 전 RED를 요구하지 않는다(리뷰 시뮬레이션 수정 전 16건이라 RED일 가능성이 높지만 지터에 민감). 종료 단언 = 결과 `Ok`, 경과 시간 ≥ 3s(조기 종료 아님), 전체를 넉넉한 `tokio::time::timeout`(예 15s)으로 감싼다 — 촘촘한 상한은 두지 않는다.
  - **drop이 스케줄 슬롯을 소비함(§3.3 `tick` ≠ `arrival_counter`)**: `[{50,2}]`(Λ=50)·`max_in_flight` 1·mock 지연 200ms → `count + dropped ∈ [49, 51]`. 슬롯이 넉넉한 다른 테스트에선 두 카운터가 항상 같아 이 규칙을 못 본다. **이빨 실증**: 스케줄을 `arrival_counter`로 구동하게 바꾸면 drop 뒤 `next`가 과거에 머물러 루프가 drop을 연발 → `dropped` 폭증으로 RED, 원복 시 GREEN.
  - **곡선 모드 cancel**: `[{0,30},{10,1}]`(긴 0 구간)을 300ms 뒤 cancel → `Err(Aborted)`, 넉넉한 `timeout`(예 5s) 안에 반환. 기존 cancel 테스트는 고정 경로라 poll-step 제거 후 곡선의 cancel 경로(대기 select 단독)를 못 본다.
  - (위 개수 테스트 4개의) 허용 폭 ±1은 순수 개수 오차(≤½)에 deadline 직전 도착의 스케줄링 지터 1건을 더한 것이다.
- 기존 `open_loop_stages_curve_runs_and_drops_nothing_when_capacity_ample`(`[{100,1},{100,1}]`, Λ=150)의 `total > 30` 단언을 `total ∈ [147, 151]`로 조인다. 수정 전 코드도 통과할 수 있는 범위다(평평한 곡선은 원래 거의 맞았다 — §B34 대조 148). 이 테스트의 역할은 회귀 가드이지 RED 실증이 아니다.
- 고정 경로 `open_loop_fires_near_target_rps_with_ample_pool`·drop·cancel 테스트는 무수정 green(G3).

### 6.3 라이브 (`/live-verify`, 워크트리 바이너리·responder 50ms·`max_in_flight` 50)

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | §B34 표의 곡선 6 run(단일 3 + 2워커 1 + 대조 단일·2워커 2)을 API로 재생성 | 각 `summary.count`가 기대 ±1(2워커 ±2), `dropped` 0 |
| US1 | 고정 `target_rps:20`·8s run, closed-loop 2VU·5s run | 수정 전 바이너리와 같은 범위(고정 ≈160, closed는 RPS 정상 범위) |
| US2 | `[{1000,2},{1000,6}]`·`max_in_flight` 200을 수정 전/후 바이너리로 1회씩 | 둘 다 count ∈ [6930, 7070](∫=7000 ±1%)·`dropped` 0, 수정 후 count ≥ 수정 전 − 1% |

- **시나리오**: 모든 run은 http 스텝 **1개**짜리 시나리오(→ `summary.count` = 도착 수).
- **수정 전 바이너리 확보(plan 첫 task, 엔진 커밋 전)**: 워크트리 baseline 빌드(`target/debug/{controller,worker}`, master `68498991` 기준)를 `/tmp/curve-arrival-prefix/`로 복사한다. 수정 전 run은 `/tmp/curve-arrival-prefix/controller --worker-bin /tmp/curve-arrival-prefix/worker --db /tmp/curve-arrival-prefix.db …`로 띄운다(`--worker-bin` 기본값 `target/debug/worker`가 cwd-상대라 명시 필수 — `crates/controller/src/main.rs:67`). 수정 후 run은 워크트리 root에서 `./target/debug/controller`(fresh 빌드).
- US2는 HTTP/1.0 responder라 요청마다 새 커넥션이다 — 7000 연결은 macOS ephemeral 포트(~16k, TIME_WAIT 15s) 안이다. 두 7000-연결 run 사이에 **15초 이상** 간격을 둔다(10k를 넘기지 말 것 — 루트 CLAUDE.md 포트 고갈 함정).

## 7. 영향 범위 요약

| 파일 | 변경 |
|---|---|
| `crates/engine/src/runner.rs` | `ArrivalSchedule` 추가, `run_scenario_open_loop` 곡선 분기 교체(poll-step 제거), `RunPlan.stages` doc 주석(`:77-78` "drives arrivals at `rate_at`") 정정, 단위 테스트 |
| `crates/engine/tests/open_loop.rs` | 통합 테스트 6개 추가(개수 4·drop 소비·곡선 cancel) + 기존 1개 단언 강화 |
| `crates/engine/CLAUDE.md` | S-D 절 3줄 정정 |
| `docs/adr/0032-…md` | 헤더 요약 + 괄호 주석 6곳(§3.4) |

proto·controller·worker·UI·migration 0-diff.

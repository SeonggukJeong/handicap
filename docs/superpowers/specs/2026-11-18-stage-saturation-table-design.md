# 계단 시험 a — 계단 입력 + 계단 결과 표 + 포화 계단 표시 (설계)

- 날짜: 2026-11-18 · 슬라이스: `stage-saturation-table` (roadmap §A16의 a) · 유형: user-path
- 후속: **b = 자동 정지**(§9) — a를 master에 합친 뒤 릴리즈 없이 바로 이어 한다(사용자 결정 2026-11-18).
- 화면 기준(사용자 승인 목업): `2026-11-18-stage-saturation-mockup-rundialog.png`(실행 창), `2026-11-18-stage-saturation-mockup-report.png`(리포트), 원본 `2026-11-18-stage-saturation-mockup.html`, 설계 확인 3건(리포트 내 위치·달성/처리량 열·목표 계단선) `2026-11-18-stage-saturation-mockup-decisions.png`. 꼬리표 **b**가 붙은 요소는 이번 범위가 아니다. 숫자는 지어낸 예시다.
- **부재 중 판단**: 사용자가 자리를 비운 뒤(2026-11-18 새벽) 리뷰 반영 과정에서 정한 것은 "【부재 중 판단】"으로 표시했다. 기준 = `docs/dev/working-rules.md` §9(정직한 동작·성능 → QA 입문자 사용성). 슬라이스 마무리 때 roadmap §B 블록에 비용·되돌리는 법과 함께 옮긴다.

## 사용자 스토리 (US)

(사용자 승인 2026-11-18)

- **US1**: QA가 신규 시스템 수용성 시험에서 목표 목록(예: 100, 200 … 800)과 계단 유지·상승·앞부분 버림 시간만 넣어 계단 run을 실행한다 — 성공하면 실행 창에 "8계단 · 총 8분 40초 · 계단마다 측정 45초"가 보이고, 실제 run의 1초 RPS가 계단마다 평평하게 유지된다.
- **US2**: 운영자가 계단 run 리포트를 열어 몇 req/s부터 무너지는지 찾는다 — 성공하면 맨 위에 「포화 계단 N · 마지막 정상 M」(끝까지 정상이면 「N 이상」)과 계단 곡선(판정색 + 「지연 상승 시작」 표시)이 보이고, 표의 판정이 bench 규칙(95% 달성 · dropped 0 · 오류 1% · p99 3배 · 튐 넘김)과 같은 결과를 낸다.
- **US3**: 운영자가 계단별 숫자를 서버 대시보드와 맞춰 본다 — 성공하면 계단 행마다 측정 구간 시각, 정확한 p50/p95/p99(평균의 평균 아님), 오류율, **그 계단에서 생긴 dropped**가 보여 "부하기가 못 따라감"과 "시스템 포화"를 구분할 수 있다.
- **US4**: QA가 앞부분 버림 시간이 충분했는지 판단한다 — 성공하면 측정 구간 앞부분 p99가 나머지보다 크게 높은 계단에 표 아래 ⚠ 안내가 뜨고, 1초 차트의 계단 띠에서 버린 구간이 회색으로 보여 다음 run의 값을 정할 수 있다.
- **US5**: 운영자가 결과를 보고서로 공유한다 — 성공하면 CSV/XLSX 내보내기와 A4 인쇄 보고서에 같은 판정 머리말과 계단 표가 들어간다.

## 1. 왜

사용자의 신규 MSA 시스템(게이트웨이 → WAS → DB, 서비스 ~8개) 전환 전 수용성 시험을 **운영 환경 저트래픽 시간대에 반복** 실행한다. 지금은 `stages` 곡선으로 계단 모양 부하는 줄 수 있지만, 리포트가 run 전체 요약 + 1초 시계열뿐이라 계단별 숫자와 포화 판정이 없다. redis-large-list-bench는 이 판정을 handicap 밖 Python(`/Users/sgj/develop/redis-large-list-bench/bench/rllb/saturation.py` — **판정 규칙의 이식 원본**)으로 했다. 목표는 "stages run 하나 → 리포트에서 바로 포화 계단"이다.

## 2. 목표 / 비목표 / 반목표

**목표**
- RunDialog 부하 프로파일에 세 번째 탭 「계단」(open-loop, 상세 모드 전용) + 목표 목록 도우미.
- 계단별 목표·달성·처리량·p50/p95/p99·오류율·dropped·측정 구간 시각 + 판정 + 머리말 + 「지연 상승 시작」 + 버림 부족 ⚠.
- 리포트 계단 곡선 차트 + 1초 계단 띠 차트, CSV/XLSX, A4 인쇄.
- 계단별 달성·dropped를 정확히 내기 위한 엔진 → 와이어 → DB 초 단위 open-loop 계수(시작·완료·버림).
- 곁들임(사용자 결정): 곡선 프리셋 「계단 스트레스」 → 「점증 스트레스」 이름 변경(평평한 구간이 없는 경사로라서).

**비목표**
- 자동 정지 — **b 슬라이스**(§9).
- VU(closed-loop) 계단 — 달성률·dropped 판정이 성립하지 않는다.
- 곡선 stage 목록에서 계단 자동 추측(접근 A) — 기각(§3).
- run 비교 화면 변경. 계단 판정의 SLO criteria 통합.
- 운영 실사용자 트래픽 분리 — handicap은 모른다. 도움말 한 줄로만.

**반목표 (돌아가도 실패)**
- 퍼센타일을 초별 퍼센타일의 평균으로 내는 것(반드시 HDR 머지).
- 같은 계단 숫자를 넣었을 때 bench `saturation.py`와 다른 판정을 내는 것(§5.3 표 테스트로 고정).
- 기존 run(계단 아닌 run)의 리포트 JSON·CSV·XLSX·인쇄가 바뀌는 것.
- 사용자가 버림 시간·판정 기준을 볼 수 없는 채로 판정이 나오는 것.
- 숫자가 추정인데 추정이라고 말하지 않는 것.

## 3. 접근 (사용자 결정)

| 접근 | 내용 | 결과 |
|---|---|---|
| A. 곡선에서 자동 인식 | 연속 두 stage 목표가 같으면 유지 구간 | 기각 — 행 하나 고치면 계단이 어긋나고 버림 초가 run에 안 남는다. 기존 「계단 스트레스」 프리셋은 평평한 구간이 없다(`loadShapes.ts` `step` = 30초씩 경사) |
| A'. 곡선 탭 안 「계단 만들기」 | 만든 뒤 행을 고치면 계단 정보와 곡선이 어긋남 | 기각 |
| **B. 「계단」 탭 + profile `stair` 필드** | 목표 목록·유지·상승·버림을 입력, 서버가 `stages`로 펼침 | **채택** (2026-11-18) |

슬라이스 분할: 사용자가 a(계단 입력·결과)/b(자동 정지)로 나눴다. 리뷰가 a를 a1/a2/a3로 더 나누자고 제안했으나 **【부재 중 판단】 a 하나로 유지**하되 plan의 task 순서를 a1(입력·계수·판정·표) → a2(차트 둘·⚠) → a3(내보내기·인쇄)로 세로로 짠다 — 사용자가 아침에 a 전체 화면을 확인하길 원했고(종류별 화면 띄우기 요청), task 단위 subagent 구현이라 orchestrator 컨텍스트는 task 경계에서 관리된다. 비용: orchestrator 컨텍스트가 커질 수 있음 → plan이 중간 재개 지점(커밋 단위)을 명확히 한다.

## 4. 데이터 모델·와이어

### 4.1 profile `stair` (controller-only, 와이어 아님)

`store::runs::Profile`(`crates/controller/src/store/runs.rs:116`)에 추가:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub stair: Option<StairConfig>,

pub struct StairConfig {
    pub targets: Vec<u32>,          // 반복/초(전 워커 합), 엄격 증가, 2..=50개, 각 1..=1_000_000
    pub hold_seconds: u32,          // 계단 유지, 20..=3600
    pub ramp_seconds: u32,          // 상승, 1..=600 (stage duration 0 금지 때문에 ≥1)
    pub discard_seconds: u32,       // 앞부분 버림, 0..=hold_seconds-10 (측정 ≥ 10초)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub p99_cap_ms: Option<u32>,    // 선택 절대 p99 상한, 1..=600_000 (§5.3: 넣으면 배수 규칙을 대체)
}
```

- **펼침(`expand_stair`)**: 계단 i마다 `Stage{target: t_i, duration: ramp}` + `Stage{target: t_i, duration: hold}`. 엔진 stage는 앞 목표→이 목표 선형 보간이므로(`crates/engine/src/runner.rs:36` doc) ramp stage가 경사, hold stage가 평평한 구간이 된다. 첫 계단 ramp는 0→t_1.
- **정규화 `normalize_stair(&mut Profile) -> Result<(), String>`**: stair가 있으면
  - `stages`가 비어 있으면 `expand_stair`로 채운다. 비어 있지 않으면 `expand_stair` 결과와 같을 때만 통과(재제출 round-trip), 다르면 400.
  - `target_rps`·`vu_stages`가 있으면 400, `duration_seconds > 0`이면 400.
  - 그 뒤 기존 `validate_run_config`(`crates/controller/src/api/runs.rs:223`, `&Profile`)가 펼친 stages 위에서 그대로 돈다(open-loop 규칙: `max_in_flight` 필수 등). 저장되는 profile_json에는 `stair`와 펼친 `stages`가 둘 다 있다.
- **호출 지점 — `validate_run_config`를 부르는 모든 곳 앞**(리뷰 F1 실측): `api/runs.rs:1017`(run 생성), `api/presets.rs:84`(생성)·`:144`(수정), `api/schedules.rs:182`(생성·수정 공용 게이트 — 지금 `&body`라 `&mut`로 바꿔야 함), `schedule/runner.rs:148`(스케줄 발사 시 저장 profile 재검증 — 저장본은 이미 펼쳐져 있어 정규화는 round-trip 통과만). plan은 `grep -rn "validate_run_config" crates/controller/src`로 목록을 다시 확정한다. 재실행은 UI를 거쳐 run 생성으로 가고, 번들 가져오기·TUI·모니터는 profile을 저장·생성하지 않는다(리뷰 실측).
- 워커는 `stages`만 받는다(proto `Profile`·`to_proto_profile` `grpc/profile.rs:13` 무변경). 멀티워커 open-loop stage 분할(`assignment_for`, `coordinator.rs:1070`)도 그대로.
- 마이그레이션 불필요(profile_json serde default).

### 4.2 엔진 → 와이어: 초 단위 open-loop 계수 + 엔진 시작 시각

현재 `dropped`는 스케줄 루프의 지역 변수(`runner.rs:1771`, 증가 `:1963`)로 run 합계만 최종 flush(`:2019`)에 실린다. 계단별로 내려면 초 단위가 필요하다.

- **계수 3종**(초 단위, open-loop 전용):
  - `launched` — 그 초에 슬롯을 얻어 시작한 도착 수(스케줄 루프).
  - `dropped` — 그 초에 슬롯이 없어 버린 도착 수(스케줄 루프, 기존 증가 지점).
  - `completed` — 그 초에 `run_arrival`의 `execute_steps`가 끝난 반복 수(결과와 무관, 데이터셋 소진으로 바로 돌아간 도착 `runner.rs:2076–2079`는 제외). `execute_steps(…).await?`(`:2083–2101`)는 `Err`(엔진 오류·취소)면 `?`로 바로 돌아가므로, **`?` 전에 결과를 받아 `completed`를 먼저 기록**한다(리뷰 2차 3). 응답 지연이 계단 경계를 넘으면 다음 계단 초에 잡힌다 — 지연 기록(완료 초 기준)과 같은 기준이다.
- **기록 장소(리뷰 R1)**: `std::sync::Mutex<OpenLoopCounters>` 하나(`Arc`, await를 넘겨 잡지 않음). `record(kind)`는 **잠금 안에서** 현재 epoch 초(`aggregator.rs:538` `current_second()`와 같은 시계)를 읽어 그 초 칸을 올린다 — 이미 drain된 초를 다시 만들지 않기 위해서다. 공유 tokio `agg` 잠금은 쓰지 않는다(도착마다 지연 기록과 경합해 스케줄러를 늦출 수 있음 → 거짓 포화). **0행 채우기**: 스케줄 루프는 다음 도착까지 잠들어 있어(`runner.rs:1897–1905`) 빈 초를 못 찍으므로, flusher가 drain할 때 같은 잠금 안에서 "마지막으로 낸 초 + 1 ~ 현재 초 − 1" 사이 빈 초를 0행으로 채운다(리뷰 2차 5). 채우기는 **스케줄러가 살아 있는 동안만**: 첫 채우기는 t0의 초부터, 스케줄 루프가 끝날 때 같은 잠금 안에서 `scheduler_ended` 표시를 세우면 그 뒤로는 채우지 않는다(리뷰 3차 A). 0행은 기록 연속성용일 뿐 — `last_w`는 `launched + dropped > 0`인 초로 정하고(§5.1), 측정 초 자체는 시간으로 센다.
- `MetricFlush`(`runner.rs:115`)에 `open_loop_seconds: Vec<OpenLoopSecond { ts_second: i64, launched: u64, completed: u64, dropped: u64 }>` + `open_loop_started_at_ms: Option<i64>`(= `run_scenario_open_loop` 시작 `runner.rs:1762` 옆에서 읽은 `SystemTime` epoch ms, 계단 경계의 t0. 스케줄의 t=0과 같은 순간이어야 한다 — plan이 `ArrivalSchedule`·`rate_at`의 기준 시각을 읽어 확인).
- 주기 flush(500 ms, `:1803`)는 **끝난 초만** drain, 최종 flush가 나머지 전부. `open_loop_started_at_ms`는 **모든 open-loop flush에 싣는다**(첫 flush 유실에 견딤, 리뷰 R3).
- **엔진 주기 flush의 전송 가드**(`runner.rs:1829–1836`, `has_data` 검사)에 `|| !open_loop_seconds.is_empty()` 추가(리뷰 R2 — 없으면 시작만 있고 완료가 없는 초가 drain된 뒤 버려진다). 최종 flush는 원래 무조건 전송.
- closed-loop 경로는 빈 vec·None(동작 불변). 기존 run 합계 `dropped`(proto field 6, 최종 flush) 의미는 **그대로** — `runs.dropped`·인사이트 불변.
- **불변식 테스트**: 초 단위 `dropped` 합 == run 합계 `dropped`.
- proto `MetricBatch`(`crates/proto/proto/coordinator.proto:83`, 사용 중 1–11):
  ```proto
  repeated OpenLoopSecond open_loop_seconds = 12;
  int64 open_loop_started_at_ms = 13;   // 0 = 없음
  message OpenLoopSecond { int64 ts_second = 1; uint64 launched = 2; uint64 completed = 3; uint64 dropped = 4; }
  ```
- 워커(`crates/worker/src/lib.rs`): 매핑 + 빈 배치 건너뛰기 가드(`:349`, C1 footgun)에 `open_loop_seconds` 비어 있지 않음 조건 추가.
- 부수 효과(리뷰 R8, 수용): open-loop run은 시작 ~1초 뒤부터 배치를 보내므로 시작 감시(`first_load`, `coordinator.rs:1932–1937`)가 더 일찍 풀린다. 매 초 행은 엔진이 살아 있다는 증거라 그 감시의 목적(엔진이 아무것도 안 보냄)과 맞다. 백스톱 감시는 그대로.

### 4.3 컨트롤러 저장: migration 0024

`0024_run_open_loop_seconds.sql` (`CREATE TABLE IF NOT EXISTS`, `/new-migration` 스킬):

```sql
CREATE TABLE IF NOT EXISTS run_open_loop_seconds (
  run_id TEXT NOT NULL, worker_id TEXT NOT NULL, ts_second INTEGER NOT NULL,
  launched INTEGER NOT NULL, completed INTEGER NOT NULL, dropped INTEGER NOT NULL,
  PRIMARY KEY (run_id, worker_id, ts_second));
CREATE TABLE IF NOT EXISTS run_worker_starts (
  run_id TEXT NOT NULL, worker_id TEXT NOT NULL, started_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, worker_id));
```

- 수집(`ingest_metrics`, `coordinator.rs:1928`): `run_open_loop_seconds`는 `ON CONFLICT DO NOTHING`(재연결 재전송 멱등 — `insert_batch` `store/metrics.rs:32–34`와 같은 규칙; 끝난 초만 보내므로 한 초는 한 번만 온다), `run_worker_starts`는 값 > 0일 때 `INSERT OR IGNORE`.
- **삭제 cascade**: run 자식 테이블 목록은 `store/scenarios.rs:199–208` 하나뿐(리뷰 실측) — 두 테이블 추가 + "8테이블" 주석 갱신 + `tests/scenario_delete_api_test.rs`의 테이블 열거에도 추가.

## 5. 리포트 계산 (`report.rs`)

`ReportJson`에 `#[serde(skip_serializing_if = "Option::is_none")] pub stair: Option<StairReport>`. `profile.stair`가 있을 때만 계산 — 없으면 필드 자체가 없다. 판정(§5.3)은 **I/O 없는 순수 함수**(`stair::judge(&[StepNumbers], &StairConfig) -> Judgement`)로 분리한다 — b 슬라이스가 run 중에 재사용한다.

### 5.1 계단 구간 (ms로 계산)

워커 w마다 t0_w(ms) = `run_worker_starts.started_at_ms`. 계단 i(0부터)의 오프셋(ms):

```
step_start_i    = i * (ramp + hold) * 1000
measure_start_i = step_start_i + (ramp + discard) * 1000
measure_end_i   = step_start_i + (ramp + hold) * 1000
```

워커 w의 계단 i 측정 초 = 정수 `ts_second` 중 `[ts*1000, ts*1000+1000)`이 `[t0_w + measure_start_i, t0_w + measure_end_i)` 안에 **완전히** 들어가는 초, 그리고 `ts_second <= last_w`(아래). 이 초들의 `run_metrics` 행(전 step)과 `run_open_loop_seconds` 행을 계단 i에 모은다.

- **측정 초는 시간으로 센다**(리뷰 R4): `measured_seconds_w` = 위 조건을 만족하는 정수 초의 개수(행이 있든 없든). 분모는 이것이다. → 완전히 멈춘 시스템(완료 0)은 행이 없어도 측정 초가 그대로라 "달성 0 → 포화"로 판정된다(미측정으로 숨지 않음).
- **run 끝(`last_w`)**: 워커 w의 `run_open_loop_seconds` 중 **`launched + dropped > 0`인 최대 `ts_second`**(= 스케줄러가 도착을 만든 마지막 초, 리뷰 3차 A). `completed`만 있는 꼬리 초(스케줄러가 끝난 뒤 진행 중 요청이 끝나는 초)는 run 끝으로 치지 않는다 — 데이터셋 소진·중지로 스케줄러가 일찍 멈춘 계단이 "달성 0 → 포화"로 둔갑하지 않게. 계단 목표 ≥ 1/s라 보통 스케줄러 끝과 1초 안쪽이다(멀티워커로 워커당 목표가 1/s 미만이면 몇 초 오차 — §10). 워커 시계 기준이라 t0_w와 같은 시계다. 폴백(행 없음) = 그 워커 `run_metrics` 최대 `ts_second`.
- **일 없는 워커 제외**(리뷰 4차 선택 지적): run 전체에서 `launched + dropped > 0`인 초가 하나도 없는 워커(워커 수 > 목표라 몫이 0인 워커)는 계단 집계·`measured_seconds` 최솟값에서 뺀다 — 안 빼면 모든 계단이 "측정 안 됨"이 된다. 특정 계단에서만 몫이 0인 워커는 그대로 둔다(시간으로 센 측정 초 × 0 = 정확한 기여 0).
- **경계 손실 안내**: t0가 초 경계에 딱 맞지 않으면 측정 초는 설정(유지−버림)보다 1 적을 수 있다(가장자리 부분 초 제외). 표의 측정 구간 시각은 실제로 포함한 초를 보여 주고, 표 아래 단위 줄에 "측정 구간은 경계의 부분 초를 뺀 실제 구간"이라고 적는다.
- **t0 폴백**: 워커의 `run_worker_starts` 행이 없으면(구버전 워커) 그 워커 `run_metrics` 최소 `ts_second`×1000을 쓰고 `notes.t0_estimated = true` → 표 위 ⓘ 안내(결정 목업 ②).
- **초 단위 계수 폴백**: 워커의 `run_open_loop_seconds` 행이 하나도 없으면 그 run의 `achieved`·`dropped`는 `null`, `notes.open_loop_unknown = true` → 판정에서 달성·dropped 조건을 건너뛰고 머리말 아래 "예전 버전 부하기라 계단별 달성·dropped를 모름 — 판정은 지연·오류로만" 한 줄.
- 측정 시각 표시(`measure_start_ms/end_ms`)는 가장 이른 t0의 워커 기준 실제 포함 초.

### 5.2 계단 숫자

| 필드 | 계산 | 표시 |
|---|---|---|
| `target` | `stair.targets[i]` (반복/초, 전 워커 합) | 목표(반복/초) |
| `achieved` | Σ_w (Σ completed_w / measured_seconds_w) | 달성(반복/초) |
| `launched_rate` | Σ_w (Σ launched_w / measured_seconds_w) | 띠 차트·XLSX |
| `throughput_rps` | Σ_w (Σ run_metrics count_w / measured_seconds_w) | 처리량(요청/초) |
| `p50_us/p95_us/p99_us` | 측정 초의 전 step·전 워커 HDR을 `merge_into`로 머지 → `value_at_quantile` (**정수 µs**) | ms로 변환해 표시(1 ms 미만은 소수 둘째 자리, 이상은 정수 — 【부재 중 판단】 입문자 가독성) |
| `error_rate` | Σ error_count / Σ count (count 0이면 0) | 오류율 % |
| `dropped` | Σ dropped (측정 초만) | dropped |
| `measured_seconds` | 워커별 측정 초의 최솟값 | XLSX |
| `head_p99_ratio` | §5.4 | ⚠ 줄 |

**「달성」= 완료 반복/초【부재 중 판단, 리뷰 P3 — 사용자가 확인한 정의(결정 목업 ②)를 뒤집음 → 아침 요약 맨 앞에 보고】**: 결정 목업 ②의 설명은 "시작한 반복 수"였으나 바꾼다. 시작 수는 `목표 − dropped`와 같아서 "달성 < 95%"가 dropped 조건과 중복되고, 슬롯이 남는 한 느려지는 시스템도 100%로 보인다 — 정직하지 않다. bench의 achieved는 성공 완료/초(`ok/elapsed`)다. handicap은 반복의 성공 여부를 엔진이 따로 모으지 않으므로(`run_arrival`의 `let _ = execute_steps(…).await?` — `Ok`의 `StepFlow` 값은 버리고 `Err`면 `?`로 바로 돌아감, `runner.rs:2083–2101`) **완료(결과 무관)/초**로 센다 — `completed`는 `?` 전에 기록(§4.2). bench와의 차이 = 오류 난 반복이 달성에 포함되는 것 — 오류율 ≥ 1%면 어차피 실패이므로 판정 차이는 "오류율 < 1% ∧ 달성 95~96% 경계"에서만 날 수 있다(§B에 기록). 결정 목업 ② 설명 문구는 "그 초에 끝난 시나리오 수"로 고친다. 띠 차트의 「실제 시작」 선은 `launched`(부하기가 목표만큼 보냈나)를 그대로 보여 준다.

HDR 디코드·머지는 기존 `decode_hdr`·`merge_into`·`fresh_hist`(`report.rs:500`, `percentiles.rs:30/53`)를 쓴다.

### 5.3 판정 — bench `saturation.py` 이식 (규칙 정본)

모든 비교는 **정수 µs**(리뷰 P4). 상수: `ACHIEVED_MIN = 0.95`, `ERROR_MAX = 0.01`, `P99_MULT = 3`, `P99_FAST_US = 1000`, `P99_FAST_CAP_US = 5000`.

`step_ok(cur, prev_ok)` (bench `step_ok`와 같은 순서·의미):
1. `achieved`가 있고 `achieved < 0.95 × target` → 실패 `achieved`
2. `dropped`가 있고 `dropped != 0` → 실패 `dropped`
3. `error_rate >= 0.01` → 실패 `errors`
4. `p99_cap_ms`가 있으면 → `p99_us < cap×1000`이어야 정상(아니면 실패 `p99_cap`). **상한이 있으면 5번(배수 규칙)을 보지 않고, 첫 계단에도 적용한다**(리뷰 P1 — bench와 같음).
5. 상한이 없고 `prev_ok`가 있으면: `prev_ok.p99_us < 1000`이면 `cur.p99_us < 5000`, 아니면 `cur.p99_us < 3 × prev_ok.p99_us`(아니면 실패 `p99_relative`, 기록 값 = 배수).
6. 그 외 정상.

실패 사유는 표시용으로 **해당하는 것을 모두** 기록한다(bench는 첫 실패에서 돌아오지만 판정 결과는 같다).

**걷기** (bench `_walk`와 같음) — `last` = 마지막 정상 계단(없음으로 시작), `i = 0`:
- 계단 i가 `not_measured`(§5.1에서 `measured_seconds < (hold − discard) / 2`)면 걷기 종료.
- `step_ok(i, last)` → 정상, `last = i`, 다음.
- 실패이고 **`last`가 있고**(리뷰 P2) i+1이 측정됐고 `step_ok(i+1, last)` → i는 `spike`(튐), 다음(i+1은 다시 같은 규칙으로 판정되어 정상 → last).
- 그 밖의 실패 → 걷기 종료, 포화 지점 = i.

**계단 표시 상태** (걷기 결과로):

| 상태 | 조건 | pill |
|---|---|---|
| `ok` | 걷기 중 정상 | 초록 「정상」 |
| `spike` | 튐 | 주황 「튄 계단」 |
| `saturated` | 포화 지점 i, 그리고 i 다음 계단이 측정됐고 `step_ok(i+1, last)` 실패면 i+1도 | 빨강 「포화」 |
| `unconfirmed` | 포화 지점 i인데 **i가 마지막 계단이 아니고 i+1이 측정되지 않음**(run이 중간에 끝남) — 확인 계단 없음 | 주황 테두리 「확인 못 한 실패」 |
| `after` | 포화 확정 뒤의 나머지 측정 계단(판정에 쓰이지 않음) | 회색 「포화 이후」 + 사유 요약(실패 사유가 있으면) |
| `not_measured` | 측정 부족 | 회색 「측정 안 됨」, 숫자 「—」 |

**머리말** (판정 상자 첫 줄):
- 포화 지점 k(`saturated`): 「포화 계단 t_k req/s · 마지막 정상 t_last」(`last` 없으면 「정상 계단 없음 — 첫 계단부터 실패」 + 뒤 계단 중 정상 조건을 만족한 게 있으면 힌트 「첫 계단만 일시적으로 튀었을 수 있습니다 — 앞부분 버림을 늘려 다시 실행해 보세요」).
- 포화 지점 k(`unconfirmed`): 「포화 의심 t_k req/s — 확인할 다음 계단 전에 run이 끝남 · 마지막 정상 t_last」.
- 포화 없음, 모든 계단 측정: 「t_마지막 req/s까지 정상 (포화 못 찾음 — 더 높은 목표로 다시)」.
- 포화 없음, 일부 미측정: 「t_last req/s까지 정상 · 이후 계단은 측정 안 됨」.
- 측정된 계단 0개: 「판정할 수 없음 — 측정이 끝난 계단이 없습니다」.

**지연 상승 시작(knee)** — 판정이 아닌 참고: 포화 지점 앞(포화 없으면 전부)의 `ok` 계단 중, 바로 앞 `ok` 계단 대비 `p99 ≥ 1.5×` **이고 `p99 ≥ 1 ms`**(1 ms 미만 잡음 배제, 리뷰 6)인 첫 계단.

**표 테스트**(plan 필수): bench `saturation.py`의 `find_saturation`/`_walk`와 같은 입력·같은 결과(**단언 대상 = 마지막 정상 index `last`·튄 계단 목록·포화 지점 index** — `unconfirmed`·`after`는 handicap의 표시 전용 상태라 라벨은 별도 단언, 리뷰 2차 6) — 전부 정상, 튐 1개, 튐 뒤 연속 실패, 첫 계단 실패 뒤 정상(튐 아님), 마지막 계단 실패, 연속 두 실패, 1 ms 미만 ref, 절대 상한(첫 계단 적용·배수 규칙 무시), 미측정 중단, 확인 못 한 실패. 각 테스트는 되돌려 확인(teeth check).

### 5.4 버림 부족 ⚠

측정 초가 20초 이상인 계단에서, 측정 구간 첫 10초 HDR p99 ÷ 나머지 HDR p99 = `head_p99_ratio`. `>= 2.0`이고 앞부분 p99 ≥ 1 ms면 `discard_warning = true`. 나머지 p99가 0이면 null.

### 5.5 1초 계단 띠 데이터

- `stair.seconds: Vec<{ offset_s, launched|null, completed|null, dropped|null, count, p99_us }>` — 전 run, 가장 이른 t0 기준 초 오프셋(워커별 t0로 정렬한 뒤 합산), 전 step·전 워커 HDR 머지 p99와 count 합.
- `stair.bands: Vec<{ index, kind: "ramp"|"discard"|"measure", start_s, end_s }>` — 같은 기준, 설정 그대로(경계 부분 초 무관).
- `stair.target_line: Vec<{ offset_s, target }>` — 펼친 stages의 꼭짓점(목표 계단선, 결정 목업 ③ B).
- 기존 `windows`는 그대로.

### 5.6 `StairReport` 직렬화 형태

```
stair: {
  config: StairConfig,
  steps: [{ index, target, achieved|null, launched_rate|null, throughput_rps,
            p50_us, p95_us, p99_us, error_rate, dropped|null, measured_seconds,
            measure_start_ms, measure_end_ms,
            state: "ok"|"spike"|"saturated"|"unconfirmed"|"after"|"not_measured",
            reasons: [{kind: "achieved"|"dropped"|"errors"|"p99_cap"|"p99_relative", value}],
            knee: bool, slot_limited: bool, head_p99_ratio|null, discard_warning: bool }],
  headline: { kind: "saturated"|"unconfirmed"|"all_ok"|"ok_then_unmeasured"|"no_data",
              saturated_target|null, last_ok_target|null, through_target|null, first_fail_hint: bool },
  knee_target|null, spike_targets: [u32],
  max_in_flight|null, dropped_total|null,     // 머리말 문구용(§5.7 M·N) — profile·run 합계 그대로
  dropped_explained: bool, slot_limited_targets: [u32],   // §5.7 (steps[].slot_limited도 둔다)
  notes: { t0_estimated: bool, open_loop_unknown: bool },
  seconds, bands, target_line
}
```

UI Zod `ReportSchema`는 `.strict()` → `stair: StairReportSchema.optional()` 필수.

### 5.7 신뢰도 배너와 슬롯 부족 (리뷰 R7·2차 1)【부재 중 판단】

dropped > 0이면 `load_gen_saturated` 인사이트 → 신뢰도 `load_not_delivered` 경고가 뜬다(`validity.rs:123–125`). open-loop dropped의 원인은 둘이다: **시스템이 느려져 슬롯이 안 비는 것**(진짜 포화) / **`max_in_flight`가 애초에 작은 것**(부하기 설정 한계). 계단 run은 지연이 계단마다 오르도록 설계돼 있어 run 전체 인사이트의 원인 판별(`insights.rs:487–488` 후반/전반 p95 1.5×)로는 둘을 못 가른다. 그래서 **계단 단위로** 가른다:

- 계단별 `slot_limited = (dropped 또는 achieved로 실패) ∧ (errors·p99_relative·p99_cap로는 실패 안 함)` — "지연·오류는 규칙 안인데 못 보냄" = 부하기 설정 한계 의심.
- `dropped_explained = true`는 **dropped > 0인 모든 구간(계단 시작~다음 계단 시작 전, 첫 계단 전 포함)이 `after` 계단이거나, `slot_limited`가 아닌 실패(지연·오류로도 실패한 `saturated`·`unconfirmed`·`spike`) 계단**일 때만. 이때만 `load_not_delivered` 사유를 넣지 않고, 계단 머리말 둘째 줄에 「부하기가 못 보낸 요청 N개는 모두 지연·오류로 무너진 계단에서 발생 — 시스템 포화로 판정에 반영됨」.
- 그 밖(정상 계단 구간의 dropped, 또는 `slot_limited` 계단)이면 기존 경고 **그대로** + `slot_limited` 계단이 있으면 머리말에 경고색 줄 「계단 N은 지연·오류는 정상인데 요청을 다 못 보냄 — 동시 실행 한도(max_in_flight = M)가 부족할 수 있어 **시스템 한계로 단정할 수 없음**. 한도를 늘려 다시 실행하세요」, 표 사유에 「슬롯 부족 의심」.
- `notes.open_loop_unknown`이면 `dropped_explained = false`(초 단위 귀속 불가 → 배너 유지, 리뷰 2차 4).
- 판정(§5.3 걷기) 자체는 bench 그대로 둔다 — 슬롯 부족 계단도 실패로 센다. 정직성은 위 머리말·사유·배너로 확보한다.
- 인사이트(`load_gen_saturated`) 자체는 손대지 않는다. 구현: `build_report`에서 stair를 validity보다 먼저 계산해 넘긴다. controller CLAUDE.md "인사이트·신뢰도 임계는 함께 본다" 함정 대상.

## 6. UI

### 6.1 RunDialog 「계단」 탭 (목업 ①, 꼬리표 a만)

- `rateMode`를 `"fixed" | "curve" | "stair"`로 넓힌다. 유니언 확장은 기존 `rateMode === "curve"` 분기를 TypeScript가 잡아 주지 않는다(리뷰 R6) → **모든 `rateMode` 비교·캐스트 지점 전수 sweep**, 각각 stair 처리를 정한다. sweep 명령은 `grep -rni "ratemode" ui/src` + `grep -rn '"fixed" | "curve"' ui/src`(대소문자·`setRateMode(v as …)` 캐스트 포함, 리뷰 2차 2). 토글은 두 갈래 — 세그먼트(`loadModelTiles`)와 라디오(ScheduleForm이 쓰는 비-tiles 분기) — **둘 다**에 「계단」을 넣는다. 리뷰 실측 목록: `loadModel.ts:6·169`, `LoadModelFields.tsx:24·451·498·750·791`(사이징 도우미 `targetRps` — stair면 최대 목표), `RunDialog.tsx:90·187`(`opensDetailed`)·`430–440`(상세 개수)·`476·494`(`canSubmit`)·`757`(미리보기), `runSummary.ts:22`, `openLoopChecks.ts:18·86·94`(유휴 워커·무의미 슬롯 경고 — stair면 최대 목표를 peak로; run 전체에서 몫이 0인 워커만 유휴), `ScheduleForm.tsx:75·248·251`. `deriveLoadMode`가 `"stair"`를 내므로 그 소비처도 같이(plan 리뷰 R1): 인쇄 조건란 `print/conditions.ts`(「열린 루프 계단 · N계단 min–max req/s」), run 목록 요약 `runs/profileSummary.ts`(「계단 N개 · 최대 X/s」), run 목록 필터 `runs/runFilterSort.ts`·`RunListControls.tsx`(ModeKey `open_stair` + 라벨 「계단」). 단순 모드로 바꿨는데 계단이 선택돼 있으면 곡선의 읽기 전용 카드(`RunDialog.tsx:757`)처럼 계단 요약 카드 + 「상세에서 수정」.
- **상세 모드 전용**【부재 중 판단, 리뷰 M4】: 단순 모드는 고정|곡선 토글도 숨기므로(`LoadModelFields.tsx` simpleMode) 「계단」도 숨긴다. stair가 든 프리셋·재실행은 `opensDetailed`가 상세 모드로 연다. 「계단」 세그먼트는 open-loop일 때만 보인다.
- 입력: 목표 목록(쉼표 구분 문자열 draft), 계단 유지(초, 기본 60), 상승(초, 기본 5), 앞부분 버림(초, 기본 15, HelpTip — "목표를 올린 직후 시스템이 적응하는 시간. 이 구간은 판정에서 빼고 차트에 회색으로 보여 줍니다. 자동 확장(HPA)이 있으면 늘리세요."), `max_in_flight`·`worker_count`(기존 open-loop 필드 재사용).
- **목표 목록 도우미**: 「목표(req/s)」 + 「최대 배수」(1.5×·2×·2.5×·3×, 기본 1.5×) + 「목록 만들기」. 생성 = 목표의 25%·50%·75%·100%, 이후 25%p씩 최대 배수까지, 반올림 정수·0 제거·중복 제거. HelpTip "버텨야 할 요청 수 — 운영 피크 데이터가 있으면 그 값을 넣으세요." 만든 목록은 손으로 고칠 수 있다.
- 요약 줄: "N계단 · 총 M분 S초 · 계단마다 측정 K초". 총 = N × (ramp + hold). 하단 run 요약(`runSummary`)에도 stair 분기 하나(리뷰 M6 — 한 소스).
- 판정 기준(기본 접힘 disclosure — 사용자 선호): 규칙 문구 + 선택 「절대 p99 상한(ms)」. HelpTip "넣으면 '아래 계단의 3배' 규칙 대신 이 값으로 판정합니다." 값이 있으면 접힌 채 "1개 설정됨".
- 미리보기: 기존 `StageCurvePreview`에 펼친 stages(클라 `expandStair` = 서버와 같은 수식, 미리보기 전용).
- 검증(클라): 목표 2..50개·엄격 증가·정수 1..1_000_000, 유지 20..3600, 상승 1..600, 버림 0..유지−10, 상한 1..600000. 위반 시 기존 `loadModelErrors` 방식(문구는 입문자용 — 무엇을 어떻게 고칠지).
- `buildLoadProfile` stair 분기 = `stair` + `max_in_flight` + `worker_count` + `vus: 0` + `duration_seconds: 0`(리뷰 모순 1). `stages`는 안 보냄. `LoadProfileFields` 허용 목록에 `stair`.
- 프리셋·재실행·스케줄: `ProfileSchema`에 `stair: StairConfigSchema.optional()`(없으면 parse가 조용히 지움), `deriveLoadMode`가 **stair를 가장 먼저** 검사(저장본에 stair·stages 공존), `loadPreset`·재실행 prefill·`ScheduleForm`이 stair 상태를 다시 채운다.
- 곡선 프리셋 `loadShapes.ts` `step` 라벨 → 「점증 스트레스」.
- 문구 전부 `ko.ts`(ADR-0035). 단위: 입력 라벨은 목업대로 "req/s", 표 머리글은 결정 목업 ②대로 "반복/초"·"요청/초" — 입력 HelpTip에 "요청 1개짜리 시나리오면 req/s = 반복/초"를 붙인다【부재 중 판단】.

### 6.2 리포트 「계단 결과」 섹션 (목업 ②·결정 목업)

`report.stair`가 있을 때만. 위치(사용자 확정, 결정 목업 ①): 머리(`ReportHeadline`·제목 줄) → `ValidityBanner` → `LoopRetryNotice` **다음**, `VerdictPanel` **앞**. `PageSection` 하나, 네 부분:

1. **판정 머리말 상자**: §5.3 머리말 + 둘째 줄(「지연 상승 시작 ≈ K」 · 「튄 계단 j개(목표들) 넘김」 · §5.7 dropped 설명 — 있는 것만). notes 안내 줄.
2. **계단 곡선**: 가로 = 목표(범주), 세로 = 지연 ms 로그축. p99 실선·p50 점선, 점 색 = 상태(§5.3 표), knee 고리, 포화 이후 영역 옅은 빨강, 점 라벨(p99 + 「튐」/「포화」/「↑시작」), 아래 줄 달성률(achieved/target %, 95% 기준 색). Recharts.
3. **계단 표**: # · 목표(반복/초) · 달성(반복/초) · 처리량(요청/초) · p50 · p95 · p99 · 오류율 · dropped · 측정 구간(HH:MM:SS–HH:MM:SS, 로컬) · 판정 pill + 사유 요약(예: "p99 4.0× · dropped 212"). null은 「—」. 표 위: t0 추정 ⓘ(있을 때). 표 아래: ⚠ 버림 부족 줄(해당 계단마다), 단위·측정 구간 경계·실사용자 트래픽 안내 한 줄.
4. **1초 계단 띠 차트**: `bands` 배경(상승·버림 = 회색, 측정 = 그 계단 상태색 옅게) + 목표 계단선(회색 점선, `target_line`) + 실제 시작(`launched`/초, 실선) + p99(오른쪽 로그축). 기존 3개 시계열 차트는 손대지 않는다.

### 6.3 인쇄 (`print/buildPrintDoc.ts`)

- **standard**: `kpis` 다음에 머리말 문장 블록 + 기존 `table` 블록 패턴(행 높이 측정, 리뷰 M3)으로 계단 표.
- **summary**(한 장 축소 사다리): 머리말 문장 한 줄만 + "계단 표는 표준 보고서에" 【부재 중 판단】. 50행 표는 한 장에 못 들어간다(`paginate.ts` 과대 블록).

### 6.4 내보내기

- XLSX(`report_to_xlsx`, `export.rs:458`): stair가 있으면 `Stairs` 시트(표 열 + launched_rate + measured_seconds + 상태 + 사유 + 측정 시작/끝 ISO) — 머리말은 시트 첫 줄들.
- CSV: 기존 `report.csv`는 손대지 않고 새 경로 `GET /api/runs/{id}/report-stairs.csv`(선례 `report-insights.csv`, `app.rs:74`). 계단 run이 아니면 404. `DownloadMenu`에 계단 run일 때만 항목.

## 7. 함정·불변식 체크리스트 (plan이 task로 옮길 것)

- 기존 run 바이트 불변: `stair` 없는 run의 report JSON·CSV·XLSX·인쇄 무변화(골든 비교). 단 open-loop run은 새 행(`run_open_loop_seconds`·`run_worker_starts`)이 쌓이고 시작 감시가 일찍 풀린다(§4.2 R8) — 리포트 출력은 불변.
- `ReportSchema.strict()` / `ProfileSchema` strip — 둘 다 추가, RTL fixture는 서버형 `null`로.
- 엔진 주기 전송 가드 + 워커 C1 가드 — 마지막 초·시작만 있는 초 유실 테스트.
- 주기 flush는 끝난 초만, 잠금 안에서 초 읽기(R1) — 초 단위 dropped 합 == run 합계 테스트.
- 삭제 cascade + `scenario_delete_api_test.rs` 열거.
- 구조체 리터럴: `MetricFlush` 6곳(`runner.rs`), `MetricBatch` coordinator 테스트 6곳 + worker 1곳, `ReportJson` report/export 테스트 — 컴파일러가 잡는다.
- 엔진 MetricFlush 드레인 사이트 규칙(`crates/engine/CLAUDE.md`).
- 멀티워커: 워커별 t0로 정렬한 뒤 합산(라이브 `worker_count=2`).
- `rateMode` 전수 sweep(§6.1).
- 판정 표 테스트 되돌려 확인.

## 8. 검증 (라이브 — US 척추)

동시 처리 한도가 있는 응답기(목표가 올라가면 지연이 커지는 것)로 계단 run → 리포트:

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 상세 모드 RunDialog 계단 탭, 도우미로 목록 생성 → 실행 | 요약 줄 숫자 일치, 띠 차트에서 계단마다 평평한 실제 시작선이 목표선과 겹침 |
| US2 | 리포트 열기 | 머리말·곡선·표 상태가 §5.3 손계산과 일치 |
| US3-a | 슬롯 넉넉 + 응답기 지연이 계단마다 커져 상위 계단에서 drop | 그 계단 행에만 dropped > 0, 아래 계단 0, §5.7 설명 줄, 신뢰도 경고 배너 **없음** |
| US3-b | 응답기 지연 고정(빠름) + `max_in_flight`를 작게 해 상위 계단에서 drop | 그 계단 사유 「슬롯 부족 의심」, 머리말 경고색 「시스템 한계로 단정할 수 없음」 줄, 신뢰도 경고 배너 **유지** |
| US4 | 버림 0초로 다시 실행 | ⚠ 줄 출현, 띠 차트 회색 구간 변화 |
| US5 | CSV·XLSX 다운로드, 인쇄 미리보기(standard·summary) | 같은 판정·숫자 |

극단값: 50계단, 목표 1,000,000(입력·표 폭), p99 수십 초에서 곡선·표·인쇄가 겹침 없이 읽힘(rect 교차). 진입 화면: 실행 창은 시나리오 상세·스케줄 폼 둘 다, 프리셋 불러오기·재실행 prefill. 멀티워커 `worker_count=2` 1회.

## 9. b 슬라이스(자동 정지) — 미리 정한 범위 (이번에 구현 안 함)

- RunDialog 「자동 정지」(목업 ① 꼬리표 b): ☑ 포화가 확정되면 남은 계단 실행 안 함 · ☑ 즉시 정지 — 오류율 > 5% 또는 p99 > 2000 ms가 3초 연속(초기 제안, b에서 확정). 경고 "설정한 계단을 다 돌지 않습니다".
- 컨트롤러가 run 중 1초 데이터로 §5.3 `stair::judge`(a에서 순수 함수로 분리)·즉시 정지 감시 → 기존 abort 경로.
- 리포트: 머리말 노랑 줄 「N계단에서 자동 정지 — …실행 안 함 · 사유 · 시각」, 실행 안 한 계단 = 회색 「실행 안 함」 행(새 상태 `skipped`). 사용자 요구 "부하가 설정과 다르면 설명" 충족.

## 10. 알려진 한계 (수용)

- 지연은 완료 초에 기록되므로 계단 끝에 시작해 경계 뒤에 끝난 요청은 다음 계단 지연에 들어간다(리뷰 R5). 지연이 상승+버림 시간보다 길 때만 영향 — 포화 근처라 판정 방향은 같다.
- 「달성」은 오류 난 반복도 완료로 센다(§5.2) — bench와 오류율 < 1% ∧ 95~96% 경계에서만 다를 수 있다.
- 멀티워커로 워커당 계단 목표가 1/s 미만이면 `last_w`(§5.1)가 스케줄러 끝보다 몇 초 이를 수 있다 — 마지막으로 돈 계단의 측정 초가 그만큼 줄 뿐 판정 방향은 같다.
- 워커 시계가 서로 다른 LAN 부하기: 워커별 t0·ts가 같은 시계라 정렬은 맞지만, 측정 시각 표시는 가장 이른 t0 워커의 시계다.

## 부록: 근거 명령 (사실 주장 재실행용)

```
grep -n "pub struct Profile" crates/controller/src/store/runs.rs              # :116
grep -n "fn is_open_loop" crates/controller/src/store/runs.rs                 # :198
grep -n "pub struct Stage" crates/engine/src/runner.rs                        # :36
grep -rn "validate_run_config" crates/controller/src                          # 정의 :223 + 호출 5곳
grep -n "message MetricBatch" crates/proto/proto/coordinator.proto            # :83 (1–11 사용)
grep -n "let mut dropped\|dropped += 1\|dropped: total_dropped" crates/engine/src/runner.rs  # :1771 :1963 :2019
grep -n "pub struct MetricFlush" crates/engine/src/runner.rs                  # :115
grep -n "has_data" crates/engine/src/runner.rs                                # 주기 전송 가드
grep -n "async fn run_arrival" crates/engine/src/runner.rs                    # :2038
grep -n "flush.dropped == 0" crates/worker/src/lib.rs                         # :349
grep -n "async fn ingest_metrics" crates/controller/src/grpc/coordinator.rs   # :1928
grep -n "run_loop_exit_metrics" crates/controller/src/store/scenarios.rs      # cascade 목록
ls crates/controller/src/store/migrations | sort | tail -1                    # 0023
grep -n "fn fresh_hist" crates/controller/src/report.rs                       # :500
grep -n "load_not_delivered" crates/controller/src/validity.rs                # :123
grep -n "report-insights.csv" crates/controller/src/app.rs                    # :74
grep -n "ReportSchema = " ui/src/api/schemas.ts                               # .strict()
grep -rn "rateMode" ui/src | grep -v __tests__                                # sweep 대상
grep -n 'label: "계단 스트레스"' ui/src/components/run/loadShapes.ts
```

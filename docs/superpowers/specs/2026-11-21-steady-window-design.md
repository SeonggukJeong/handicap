# 유지 구간 기준 요약 (steady-window) — 설계

- 날짜: 2026-11-21 · 슬라이스: `steady-window` · 유형: `user-path`
- 상태: **슬라이스 A 구현 완료**(2026-11-22, 코드 `eba77fdc`..`07e7bd61`) · 슬라이스 B 미착수. spec과 다르게 구현한 것 둘(D5의 「보내지 않음」은 창 안에서 직접 센다 · D3의 완료 run도 `ended_at`에서 자른다)과 판단·연기 = roadmap §B82.
- 배경: 사용자가 ramp-up을 넣은 부하를 돌린 뒤 「평균 req/s에 ramp-up 구간이 섞이는 게 맞나」를 물었다. 지금 리포트 요약은 run 전체 구간으로 계산한다(§2 F4). 계단 시험만 구간별 측정을 한다.
- 범위 결정(사용자, 2026-11-21): ① ramp-up은 「고정」 부하에 붙인다(탭을 늘리지 않는다) ② 리포트를 「유지 구간」·「전체 구간」 기준별로 통째로 만들고 화면에서 전환한다(기본은 유지 구간). 인쇄는 보고 있는 기준 하나 + 다른 기준 참고 한 줄 ③ 도착률 고정(open-loop)과 VU 고정(closed-loop) **둘 다** 포함한다.
- 이 문서 밖(다음 슬라이스): 자유 곡선(`stages`·`vu_stages`)에서 사용자가 단계마다 「측정에 포함」을 표시하는 기능.

## 사용자 스토리 (US)

- **US1**: QA가 도착률 고정 부하를 돌릴 때 처음부터 목표치로 때리지 않고 천천히 올리고 싶다 — 성공하면 실행 대화상자의 「고정」에서 상승 시간을 넣을 수 있고, 리포트 시계열에서 요청 수가 0에서 목표까지 오른 뒤 유지되는 것을 본다.
- **US2**: QA가 ramp-up이나 앞부분 버림을 넣은 고정 부하(도착률·VU 둘 다)의 결과를 볼 때 「목표 부하에서의 성능」을 알고 싶다 — 성공하면 리포트가 처음부터 유지 구간 기준으로 열리고(요약, 스텝별 요청 수·오류·응답 시간, 지연 분포가 그 구간 값이고 나눌 수 없는 항목에는 「전체 구간」 표지), 집계한 구간(시작·끝 시각, 초 수, 뺀 상승·버림 초)이 적혀 있으며, 전환 하나로 전체 구간 기준 리포트를 볼 수 있다. 유지 구간에 닿지 못하고 끝난 run은 전체 구간 리포트를 보여 주고 그 사실을 적는다.
- **US3**: QA가 SLO 기준을 건 run을 판정할 때 ramp-up 중의 낮은 RPS나 초기 지연 때문에 합격·불합격이 뒤집히지 않기를 바란다 — 성공하면 유지 구간 리포트의 판정이 유지 구간 값으로 내려지고 목록의 판정 배지도 같은 결과다.
- **US4**: 운영자가 이 변경 전에 만든 run이나 ramp-up·버림이 없는 run의 리포트를 볼 때 숫자가 달라지지 않기를 바란다 — 성공하면 그런 run의 리포트 JSON·판정·내보내기가 변경 전과 같다.
- **US5**: QA가 유지 구간 기준 run과 전체 구간 기준 run을 비교할 때 숫자 차이가 집계 기준 차이인지 알고 싶다 — 성공하면 비교 화면과 비교 보고서의 조건 점검에 「집계 기준」 줄이 있고 두 run의 기준이 다르면 「다름」으로 표시된다.

## 1. 용어

- **상승(ramp)**: 부하를 0에서 목표까지 올리는 앞 구간. 길이 `ramp_seconds`.
- **유지(hold)**: 목표 부하를 유지하는 구간. 길이 `hold_seconds`. run 전체 길이 = 상승 + 유지.
- **버림(discard)**: 유지 구간 맨 앞에서 집계에서 빼는 초. 길이 `discard_seconds`.
- **유지 구간(steady window)**: 집계 대상 = 유지 구간에서 버림을 뺀 부분. 이 문서에서 「유지 구간 값」은 이 구간만으로 계산한 값이다.
- **전체 구간 값**: 지금의 `ReportJson.summary`(run 시작~종료).

## 2. 지금 코드 (조사 결과 — 리뷰어 재검증 대상)

조사 에이전트가 워크트리 `6abbd601`에서 확인한 것이다. 줄 번호는 그 시점 값이다.

| # | 사실 | 위치 |
|---|---|---|
| F1 | open-loop는 `ramp_up_seconds > 0`을 거절한다(「open-loop에선 ramp_up_seconds를 쓸 수 없습니다 (RPS 곡선은 S-D stages)」) | `crates/controller/src/api/runs.rs:340-344` |
| F2 | closed-loop 고정은 t=0에 `per_tick = ceil(vus/ramp)`개, 그 뒤 1초마다 같은 수만큼 VU를 띄운다. 그래서 전부 뜨는 시각은 `ceil(vus/per_tick) − 1`초로 `min(ramp, vus) − 1`초 이하다(VU 10·상승 30초면 약 9초에 다 뜬다 — 상승 시간은 「최대」다). run 길이 `duration`은 run 시작부터 세며 상승을 포함한다 | `crates/engine/src/runner.rs:176-177,200-205,207-290` |
| F2b | `run_scenario`는 VU를 띄우는 반복문이 끝난 **뒤에** 메트릭 flusher를 띄운다. 띄우는 동안에는 메트릭 배치가 가지 않는다. 컨트롤러의 시작 감시는 첫 메트릭을 `startup_grace_eff`(바닥 90초, 상승 시간을 더하지 않는다) 안에 기다린다 — 상승이 그보다 긴 closed-loop run은 「부하 없음」으로 실패할 가능성이 크다(리뷰어 지적, 재현 테스트로 확정할 것) | `crates/engine/src/runner.rs:207-290`, `crates/controller/src/grpc/coordinator.rs:1852-1862`, `crates/controller/src/api/runs.rs:614-626`, `crates/controller/src/in_process.rs:48` |
| F3 | open-loop 곡선은 도착률 0에서 시작해 단계마다 앞 목표→이 목표로 선형 변화한다. 그래서 `[{T, ramp}, {T, hold}]` 두 단계가 「0→T 상승 뒤 T 유지」다. 고정·곡선은 `run_scenario_open_loop` 한 함수이고 다음 도착 시각 계산만 다르다 | `crates/engine/src/runner.rs:1121-1123,1179,1777,1911,1917` |
| F4 | 리포트 요약은 run 전체로 계산한다: `rps = total_count·1000/duration_ms`, 백분위는 모든 창을 합친 `overall` 히스토그램 | `crates/controller/src/report.rs:635,687-688,764-783,999-1008` |
| F5 | `evaluate_criteria`는 요약(`s.p*_ms`·`s.errors/s.count`·`s.rps`), 전체 `status_dist`, `windows`, `steps`를 읽는다. `rps_warmup_seconds`는 `min_window_rps`만 쓴다 | `crates/controller/src/report.rs:339-345,362-486,323-336` |
| F6 | 판정은 run 완료 때 `build_report_for_run`으로 계산해 `runs.verdict_json`에 저장한다(목록 배지용). 리포트는 열 때마다 저장된 1초 창에서 다시 계산한다 | `crates/controller/src/grpc/coordinator.rs:1435-1450`, `crates/controller/src/store/runs.rs:589` |
| F7 | 계단 시험은 `profile.stair`를 저장하고 서버가 `stages`로 펼친다(`normalize_stair` — run 생성·프리셋 저장 2곳·스케줄 저장·스케줄 발사에서 호출). 계단 측정 창: `[ceil((t0+(상승+버림)·1000)/1000), min(floor((t0+(상승+유지)·1000)/1000), last+1))`, 경계의 부분 초 제외, 워커별 t0 | `crates/controller/src/stair.rs:57-73,123-148,564-575,874,915-927`, 호출 `api/runs.rs:1072`·`api/presets.rs:84,145`·`api/schedules.rs:185`·`schedule/runner.rs:149` |
| F8 | 계단의 창 계산은 `StairConfig`(목표 2–50개)에 묶여 있어 그대로 못 쓴다. 범용 조각은 `Bound`, `report::fresh_hist()` 정도다 | `crates/controller/src/stair.rs:76,579,640,850,854`, `report.rs:506` |
| F9 | 워커별 시작 시각(`run_worker_starts`)은 open-loop run만 기록한다. closed-loop 엔진은 `open_loop_started_at_ms: None`을 보낸다. 리포트는 계단 run일 때만 이 표를 읽는다 | `crates/engine/src/runner.rs:347-348,408-409,1789,1895-1896`, `crates/controller/src/grpc/coordinator.rs:2325-2345`, `api/runs.rs:1159-1172` |
| F10 | 요약을 읽는 화면: 리포트 카드·머리 줄·달성 도착률(`ReportView.tsx:217-224` → `openLoopRates`), 비교(`compareReports.ts` `SUMMARY_METRICS`), 인쇄 단일(`verdict.ts`·`sentences.ts`·`stepStatus.ts:125-128`·`speedBands.ts:227,357`)·인쇄 비교(`change.ts`·`headline.ts:141`·`runModel.ts:39`·`speedCompare.ts:34`·`buildCompareDoc.ts:89-92`), 사이징 도우미 3종(`VuSizingHelper.tsx:30`·`SlotSizingHelper.tsx:53`·`WorkerSizingHelper.tsx:31`). 내보내기는 `export.rs` `summary_metric`·XLSX Summary 시트. 전부 `report.summary`를 읽으므로 기준별 리포트(D5)에서는 받은 리포트의 기준을 그대로 따른다 | `ui/src/components/report/Summary.tsx:16-27`, `ReportHeadline.tsx:17-25`, `ui/src/compare/compareReports.ts:18,40-50`, `ui/src/print/verdict.ts:143-171`, `ui/src/print/sentences.ts`, `ui/src/print/compare/change.ts:181-200`, `ui/src/components/run/VuSizingHelper.tsx:30`, `crates/controller/src/export.rs:67-84,488-500` |
| F11 | 비교 보고서 조건 점검 줄: `model, size, duration, ramp, think, timeout, connect, maxInFlight, workers, data, stair`. 집계 기준 줄은 없다 | `ui/src/print/compare/fairness.ts:96-108` |
| F12 | UI `ReportSchema`·`ReportSummarySchema`는 `.strict()`다(모르는 키가 있으면 리포트 파싱 실패). `ProfileSchema`는 평범한 `z.object`라 모르는 키를 **조용히 버린다**(다시 실행·프리셋 프리필에서 사라진다). `buildLoadProfile`의 open+고정은 `ramp_up_seconds: 0`을 보낸다. 지금 UI 검증은 `rampUp > duration`만 막는다 | `ui/src/api/schemas.ts:293-336,632-643,764-794`, `ui/src/components/run/loadModel.ts:107-131` |
| F14 | UI에서 `stages` 유무로 「곡선」을 가르는 곳: `ReportHeadline.tsx:22-30`(곡선 문장), `openLoopRates.ts:36-49`(「목표(최대)」·달성률 없음), `sizing.ts:191-199`(곡선 run은 사이징 기준에서 제외), `LoadShapePreview`, 그리고 `deriveLoadMode` 소비처 8개 파일. 「고정」으로 읽는 곳은 `target_rps ?? 0`을 쓴다(`profileSummary.ts:21`, `conditions.ts:46`, `runFilterSort.ts`, 실행 대화상자 프리필) | 왼쪽 열 |
| F15 | 구간으로 나눌 수 없는 표: `run_loop_metrics`·`run_if_metrics`·`run_error_kind_metrics`·`run_loop_exit_metrics`는 PK에 `ts_second`가 없고, `run_group_metrics`·`run_phase_metrics`에는 `ts_second` 열이 없다. `run_open_loop_seconds`는 워커·초 단위로 `launched`·`completed`·`dropped`를 가진다 | `crates/controller/src/store/migrations/*.sql`, `crates/controller/src/store/mod.rs` |
| F13 | 과거 결정: 곡선에서 유지 구간을 자동 추정하는 안은 계단 시험 설계에서 기각됐다(「행 하나 고치면 어긋나고 버림 초가 run에 안 남는다」) — 전용 필드를 run에 저장하는 방식을 택했다 | `docs/superpowers/specs/2026-11-18-stage-saturation-table-design.md:50-52` |

## 3. 결정

### D1. run에 `steady` 설정을 저장한다 (표시가 있는 run만 새 기준)

`Profile.steady: Option<SteadyConfig>`를 더한다(없으면 직렬화하지 않는다).

```
SteadyConfig {
  ramp_seconds: u32,      // 0 허용(버림만 쓰는 경우)
  hold_seconds: u32,      // run 길이 = ramp + hold
  discard_seconds: u32,   // 유지 구간 앞에서 빼는 초
  target: Option<u32>,    // open-loop + ramp>0 일 때만(목표 iter/s). 그 밖엔 없음
}
```

- 이유: 리포트는 열 때마다 다시 계산한다(F6). 「`ramp_up_seconds > 0`이면 유지 구간 기준」으로 정하면 예전 VU run의 숫자가 바뀐다(US4 위반). run을 만들 때 저장한 표시가 있는 run만 새 기준을 쓴다. F13과 같은 방식이다.
- `profile_json`에 들어가므로 마이그레이션은 없다.

### D2. 세 가지 저장 모양 (서버가 맞추고 검증한다)

`normalize_steady(profile)`를 `normalize_stair`와 같은 다섯 곳(F7)에서 부른다. `steady`가 없으면 아무것도 하지 않는다.

| 경우 | 저장되는 프로필 | 워커가 받는 것 |
|---|---|---|
| open-loop, 상승 > 0 | `stages = [{target, ramp}, {target, hold}]`, `duration_seconds = 0`, `target_rps` 없음, `steady.target = T` | 곡선(엔진 변경 없음, F3) |
| open-loop, 상승 = 0 (버림만) | `target_rps = T`, `duration_seconds = hold`, `steady.target` 없음 | 지금의 고정 도착률 |
| closed-loop | `vus`, `ramp_up_seconds = ramp`, `duration_seconds = ramp + hold` | 지금의 고정 VU(F2) |

- open-loop + 상승 > 0을 계단처럼 `stages`로 저장하는 이유: 컨트롤러에서 `stages`를 보고 갈라지는 곳(풀 워커 수 상한, 예정 도착 수, 첫 도착 대기, 워커별 분할, 포화 인사이트의 목표)이 손대지 않아도 맞는 값을 쓴다. `target_rps`로 저장하고 워커 경계에서만 바꾸면 그 곳들을 하나씩 고쳐야 하고 빠뜨리면 조용히 틀린다.
- 입력은 채워 주거나 일치를 요구한다(계단의 「stages가 일치하지 않습니다」와 같은 방식): 비어 있으면 서버가 채우고, 값이 있는데 `steady`와 다르면 400.
- **어느 모양인지 가르는 규칙**(정규화 전에는 `is_open_loop()`로 알 수 없다 — open-loop + 상승 페이로드에는 `target_rps`도 `stages`도 없을 수 있다):
  1. `steady.target`이 있으면 **open-loop + 상승**이다. `ramp_seconds ≥ 1`, `max_in_flight` 필수. `target_rps` 있음·`vus > 0`·`ramp_up_seconds > 0`·`duration_seconds > 0`이면 400. `stages`는 비어 있으면 채우고, 있으면 펼친 값과 같아야 한다(다르면 400 — 이미 정규화된 프로필을 다시 정규화해도 통과한다).
  2. `steady.target`이 없고 `target_rps`가 있으면 **open-loop, 버림만**이다. `ramp_seconds = 0`이어야 하고 `stages`가 있으면 400. `duration_seconds`는 0이면 `hold_seconds`로 채우고, 있으면 같아야 한다.
  3. 그 밖은 **closed-loop**다. `stages`가 비어 있지 않으면 400(자유 곡선에 `steady`를 붙이는 길을 막는다 — 안 막으면 뒤의 검증이 open-loop 곡선으로 받아들인다). `ramp_up_seconds`는 `steady.ramp_seconds`와 **같아야 한다**(0은 기본값이라 「비어 있음」과 구분할 수 없으므로 채우지 않는다). `duration_seconds`는 0이면 `ramp + hold`로 채우고, 있으면 같아야 한다.
- UI가 보내는 모양: 규칙 1은 `{max_in_flight, duration_seconds: 0, steady: {target, ramp_seconds, hold_seconds, discard_seconds}}`(실행 시간 칸의 값을 `duration_seconds`로 보내지 않는다), 규칙 2는 `{target_rps, max_in_flight, duration_seconds, steady: {ramp_seconds: 0, hold_seconds, discard_seconds}}`, 규칙 3은 `{vus, ramp_up_seconds, duration_seconds, steady: {ramp_seconds, hold_seconds, discard_seconds}}`.
- 거절(400, 한국어 사유): `steady`와 `stair`·`vu_stages` 동시 사용(두 정규화 중 어느 쪽이 먼저 돌아도 거절되게 `steady` 쪽이 `stair`를 본다) · 위 규칙의 불일치 · 범위 밖 값 · open-loop + 상승에서 `worker_count > 1`인데 `steady.target < worker_count`(고정 도착률의 「워커당 1 이상」 규칙을 그대로 적용 — 곡선 분할은 0을 허용해서 일을 안 하는 워커가 생긴다).
- 범위: `ramp_seconds` 0–3600, `hold_seconds` 1–86400, `discard_seconds` 0–3600, `hold_seconds − discard_seconds ≥ 5`(측정 초가 남도록), `target` 1–1,000,000. 상승 0이고 버림 0인 `steady`는 거절한다(쓸 이유가 없는 표시).
- F1의 거절(open-loop에서 `ramp_up_seconds > 0`)은 그대로 둔다. open-loop의 상승은 `steady`로만 넣는다.

### D3. 유지 구간 창 — 모든 워커에 공통인 한 구간

일을 한 워커(= `run_metrics` 행이 하나라도 있는 워커) w마다:

```
lo_w = ceil((t0_w + (ramp + discard)·1000) / 1000)
hi_w = floor(min(t0_w + (ramp + hold)·1000, 끝_ms) / 1000)
창   = [ max_w lo_w , min_w hi_w )          // ts_second의 반열린 구간, 모든 워커에 공통
측정 초 = 창 길이 (행 유무와 무관)
```

- `t0_w` = 그 워커의 시작 시각(`run_worker_starts`). 없으면 그 워커 `run_metrics`의 가장 이른 초 × 1000으로 추정하고 `t0_estimated = true`.
- `끝_ms`: run이 `completed`면 제한 없음(계획한 끝까지). 그 밖(중단·실패·실행 중)은 `runs.ended_at`(없으면 마지막 `run_metrics` 초의 끝). **마지막 메트릭 초를 완료 run의 상한으로 쓰지 않는다** — VU 1개에 반복이 3초 걸리는 run은 마지막 초에 끝난 응답이 없을 수 있고, 그걸 「일찍 끝남」으로 읽으면 창이 줄어 RPS가 부풀려진다.
- 일을 하지 않은 워커는 계산에서 뺀다(계단과 같다). 빼지 않으면 그 워커의 빈 창 때문에 run 전체가 「못 닿음」이 된다.
- 경계의 부분 초는 뺀다. 워커마다 시작 시각이 다르면 공통 구간은 그만큼 줄어든다(워커당 최대 1초 + 시작 시각 차이).
- 계단은 워커별 창으로 각자 세고 더하지만 여기서는 **공통 구간 하나**로 센다 — 기준별 리포트(D5)는 지금의 리포트 계산에 「이 초 범위의 행」을 넣는 방식이라 범위가 하나여야 요약·스텝 표·판정·`min_window_rps`가 같은 초를 본다.
- 상태: 「계획한 끝」 = `min_w floor((t0_w + (ramp + hold)·1000) / 1000)`. **`completed` run은 `partial`이 되지 않는다**: 창이 1초 이상이면 `measured`(워커 시작 시각 차이나 추정 t0의 자르기로 줄어든 것도 `measured` — 줄어든 초 수는 기준 줄에 드러난다), 창이 비면 `no_common_window`. **`completed`가 아닌 run**: 창이 1초 이상이면 `partial`, 비면 `not_reached`(시작 시각 차이 탓으로 돌리지 않는다 — 원인은 일찍 끝난 것이다).
- 워커는 등록하는 대로 배정을 받아 시작한다(시작을 맞추는 장치가 없다). K8s 여러 워커는 시작 시각이 수십 초 다를 수 있고, 그 차이가 `hold − discard`를 넘으면 `no_common_window`다 — 「닿기 전에 끝남」과 다른 문구로 알린다(D9).
- `t0_estimated`인 워커는 추정이 실제보다 늦다. 그 워커의 `hi_w`는 마지막 메트릭 초 + 1을 넘지 않게 자른다(엔진이 이미 끝난 뒤의 빈 초를 넣어 RPS를 낮추지 않게).
- `끝_ms`(`ended_at`)는 컨트롤러 시계, `t0_w`는 워커 시계다. 두 PC의 시계 차이만큼 중단된 run의 창 끝이 어긋날 수 있다(§6).
- 지연은 응답이 끝난 초에 기록된다. 상승 중 보낸 요청이 유지 구간에서 끝나면 그 초에 들어간다 — 버림이 이를 흡수한다(계단 설계 §10과 같은 한계, 화면 도움말에 적는다).

### D4. closed-loop도 워커 시작 시각을 기록한다 (엔진 변경 1건)

closed-loop 고정 경로(`run_scenario`)가 메트릭 flush에 시작 시각을 싣는다(지금 `None`인 `open_loop_started_at_ms`에 값을 넣는다, F9). 컨트롤러 ingest는 이미 0보다 큰 값이면 `run_worker_starts`에 넣는다.

- 이유: 추정(t0 = 첫 창의 초)은 첫 응답이 늦으면 최대 「첫 응답 시간 + 1초」만큼 창이 뒤로 밀린다. 정확한 값을 쓸 수 있으면 쓴다.
- proto 필드 이름(`open_loop_started_at_ms`)은 그대로 둔다(이름 변경은 와이어 전체 수정). 주석에 「closed-loop 고정도 채운다」를 적는다.
- VU 곡선(`run_scenario_vu_curve`)은 이번에 바꾸지 않는다(`steady`를 쓸 수 없는 모드).
- 옛 워커와 섞이면 추정으로 떨어지고 `t0_estimated`가 켜진다.
- 지금의 엔진 테스트 `closed_loop_flush_has_no_open_loop_fields`(`crates/engine/tests/open_loop_seconds.rs:181-204`)와 `MetricFlush` 문서 주석(`runner.rs:138`)은 「closed-loop는 시작 시각을 싣지 않는다」를 말한다 — 뒤집어야 한다. 0보다 큰 시작 시각을 읽는 다른 곳은 계단 감시(`stair_monitor`, 계단 run 전용)뿐이다.
- **같은 함수의 선재 위험을 함께 고친다(F2b)**: 상승이 시작 감시 대기보다 길어도 run이 「부하 없음」으로 실패하지 않아야 한다. 먼저 재현 테스트로 확정하고, 확정되면 flusher를 VU를 띄우기 전에 시작하거나(권장 — 상승 중에도 메트릭이 흐른다) 시작 감시 대기에 상승 시간을 더한다. 재현되지 않으면 이 항목은 테스트만 남긴다.

### D5. 리포트를 기준별로 통째로 만든다 (사용자 결정 2026-11-21)

초안은 「요약·판정만 유지 구간, 나머지는 전체 구간」이었다. 사용자 제안으로 바꿨다: **리포트 전체를 고른 기준 하나로 만든다.** 구간으로 나눌 수 없는 칸만 전체 구간 값으로 두고 표지를 붙인다(아래 목록).

- `GET /api/runs/{id}/report?basis=steady|whole`. 파라미터가 없으면 **기본 기준** = `steady` 설정이 있고 유지 구간에 닿았으면(`measured`·`partial`) `steady`, 아니면 `whole`.
- `basis=steady`인 리포트는 유지 구간 창(D3)에 든 `run_metrics` 행으로 지금의 `build_report` 계산을 돌린다. 요약·스텝별 요청 수·오류·응답 시간·상태 코드 분포·지연 분포·응답 속도 구간·워커별 표·판정·인사이트·유효성 안내가 유지 구간 값이다. **행만 거르면 틀리는 곳이 있어 아래를 함께 바꾼다**(함수를 둘로 복사하지 않는다 — `build_report`에 초 범위와 덮어쓸 값 묶음을 넘긴다. 한 번 도는 행 반복문에서 그림용 창 누적은 모든 행을, 나머지 누적은 범위 안 행만 받는다):
  - **기간**: `started_at`/`ended_at`에서 구하지 않고 측정 초를 쓴다.
  - **인사이트에 넣는 초 단위 목록**: 창 안의 것만(앞·뒤 3분의 1 지연 비교, 실행 중 오류 시작, 포화의 초 단위 훑기가 상승 구간을 「지연 상승」으로 읽지 않게).
  - **open-loop 계수**: `dropped`, 예정 도착 수(= 목표 × 측정 초 — `stages`를 0초부터 적분하지 않는다), 포화 멈춤 판정에 넣는 초 단위 합계를 모두 창 안의 `run_open_loop_seconds`로 다시 센다. `steady`가 있는 open-loop run은 `runs.dropped`가 0이어도 이 표를 항상 읽는다. 초 단위 계수가 없는 옛 워커가 섞였으면 창으로 다시 셀 수 없다 — `basis.dropped_whole_run = true`를 내고, **버림 수에서 나오는 것 전부**(버림 수, 버림 비율, 달성 도착률, 포화 인사이트와 그 인사이트에서 나오는 유효성 사유)를 전체 구간 리포트에서 그대로 가져온다. 창 안 요청 수와 run 전체 버림 수를 섞어 비율을 만들지 않는다. 화면은 그 항목들에 「전체 구간」 표지를 붙인다.
  - **구간으로 나눌 수 없는 것은 전체 구간 리포트에서 그대로 가져온다**(범위 안 값과 섞어 계산하지 않는다): 연결 지표 블록 전체(지금 식은 `보낸 수 = 요청 수 − 못 보낸 수`라 한쪽만 거르면 재사용률이 음수가 될 수 있다), 스텝 행 안의 반복 횟수별 집계·다운로드/대기 단계·조건 반복 응답 분리·보내지 않음 수.
  - `summary.duration_seconds` = 측정 초, `summary.count` = 창 안 요청 수, `summary.rps` = 창 안 요청 수 ÷ 측정 초. 요약 안의 값들이 서로 맞는다(요청 수 ÷ 기간 = RPS).
  - 판정에 넣는 초 단위 창(`min_window_rps`)도 창 안의 것만이다. 응답의 `windows`(그림용)와는 다른 목록이다.
  - open-loop의 `dropped`와 달성 도착률은 창 안의 초 단위 계수(`run_open_loop_seconds`)로 다시 센다. 예정 도착 수 = 목표 × 측정 초(창 안은 목표가 평평하다).
- **시계열(`windows`)은 어느 기준이든 run 전체**를 준다(그림에 상승·버림 띠를 그리려면 전체가 필요하다).
- **구간으로 나눌 수 없는 집계는 어느 기준이든 run 전체 값**이다 — 초 단위로 저장되지 않기 때문이다(PK에 `ts_second`가 없다): 반복 횟수별 집계(`run_loop_metrics`), 분기 판정 수(`run_if_metrics`), 오류 종류(`run_error_kind_metrics`), 조건 반복 종료(`run_loop_exit_metrics`), 묶음 지연(`run_group_metrics`), 다운로드 단계·조건 반복 응답 분리(`run_phase_metrics`), 연결 지표. 화면은 유지 구간 리포트에서 이 표들과 **스텝 표 안의 해당 열·하위 줄**에 「전체 구간」 표지를 붙인다(D9).
- 리포트에 `basis` 블록을 더한다. **`steady` 설정이 없는 run은 키를 내지 않는다** → 그런 run의 리포트 JSON은 지금과 같다(US4).

```
basis: {
  selected: "steady" | "whole",          // 이 리포트가 계산된 기준
  default: "steady" | "whole",           // 파라미터 없을 때의 기준
  state: "measured" | "partial" | "not_reached" | "no_common_window",
  config: SteadyConfig,
  window: Option<{ start_ms, end_ms, measured_seconds }>,   // 공통 구간(D3)의 첫 초 시작·마지막 초 끝, measured_seconds = (end − start)/1000
  t0_estimated: bool,
  dropped_whole_run: bool,                // 버림 수를 창으로 다시 세지 못했다(옛 워커)
  other: Option<{ rps, p50_ms, p95_ms, p99_ms, error_rate, count, duration_seconds }>,   // 다른 기준의 핵심 숫자(참고 줄용)
}
```

- 상태의 뜻은 D3과 같다 — `measured`: 완료된 run이고 창이 1초 이상. `partial`: 완료되지 않은 run이고 창이 1초 이상(일찍 끝남). `not_reached`: 완료되지 않은 run이고 창이 비었다. `no_common_window`: 완료된 run인데 워커 시작 시각 차이로 공통 구간이 비었다. 뒤의 둘은 `basis=steady` 요청도 전체 구간 리포트를 돌려주고 `selected: "whole"`이다.
- 계단 시험과 `steady`는 함께 쓸 수 없으므로(D2) 계단 리포트와 겹치지 않는다.

### D6. 판정

- 판정은 리포트마다 그 기준의 값으로 계산된다(지금의 `evaluate_criteria`를 그 기준의 요약·분포·스텝 값·창에 그대로 적용). 스텝 기준·`min_window_rps`도 같은 기준이다.
- `rps_warmup_seconds`는 지금처럼 **run 시작부터 센 초**로 읽는다: 유지 구간 기준에서는 `warmup − (ramp + discard)`가 0보다 클 때만 그만큼 창 앞에서 더 뺀다. 상승 시간을 warmup으로 복사해 둔 옛 프리셋(실행 대화상자·스케줄 폼의 자동 채움)이 상승을 두 번 빼지 않는다. `min_window_rps`가 입력의 첫·마지막 초를 항상 빼는 것은 그대로다.
- run 완료 때 저장하는 판정 배지(F6)는 **기본 기준**의 판정이다. 목록·스케줄 기록의 배지는 그 값을 보여 준다.
- `Verdict` 모양은 바꾸지 않는다(기준은 리포트의 `basis`가 말한다). 이미 저장된 판정 JSON에는 영향이 없다.

### D7. 기준을 쓰는 다른 곳

- `build_report_for_run`이 기준 인자(없음 = 기본 기준)를 받고 기본 기준을 스스로 정한다. 기본 기준은 D3의 상태에 달려 있으므로 `steady`가 있는 run은 `run_worker_starts`를(지금은 계단 run만 읽는다), open-loop면 `run_open_loop_seconds`도 읽는다.
- 호출하는 곳마다의 기준:

| 호출 | 기준 |
|---|---|
| 리포트 JSON `GET /runs/{id}/report` | `?basis=`, 없으면 기본 |
| 완료 때 판정 저장(`persist_verdict`) | 기본 (run이 `completed`로 바뀐 뒤 도므로 기본 기준이 확정돼 있다) |
| `report.csv`·`report.xlsx`·`report-insights.csv` | A: 기본 / B: `?basis=` |
| `report-stairs.csv` | 해당 없음(계단과 `steady`는 함께 못 쓴다) |
| 비교 CSV/XLSX/인사이트 | 기본 |

- 기준 파라미터 없이 리포트를 읽는 화면은 **기본 기준**을 받는다: 비교 화면, 사이징 도우미 3종(지난 실행의 RPS·평균 응답 시간·달성률). 그래서 `steady` run의 「지난 실행 RPS」는 유지 구간 값이 된다.
- 요약을 읽는 화면 코드는 `report.summary`를 그대로 읽는다(서버가 기준에 맞는 리포트를 준다). 화면마다 값을 고르는 코드는 두지 않는다.
- UI의 리포트 조회 키에 기준을 넣는다 — 빠뜨리면 전환했을 때 다른 기준의 캐시가 나온다.

### D8. 실행 대화상자

- 「고정」 모드에 칸 둘을 더한다:
  - **상승 시간(초)**: VU 고정은 지금 칸 그대로(지금 위치·간단 모드에서도 보임). 도착률 고정은 새 칸(상세 모드).
  - **앞부분 버림(초)**: 새 칸, 도착률·VU 둘 다(상세 모드). 도움말 — 「목표 부하에 도달한 직후 몇 초는 불안정합니다. 그 초를 유지 구간 집계에서 뺍니다」.
- 실행 시간 칸은 지금처럼 **전체 길이**(상승 포함)다. `hold = 실행 시간 − 상승`.
- **`steady`를 보내는 조건**: (상승 > 0 또는 버림 > 0)이고 유지 구간이 성립할 때 — `상승 < 실행 시간`, `실행 시간 − 상승 − 버림 ≥ 5`, `상승 ≤ 3600`, `버림 ≤ 3600`.
  - 버림 > 0인데 성립하지 않으면 **오류**로 제출을 막는다(사용자가 버림을 명시했다).
  - 버림 = 0이고 VU 고정의 상승만 있는데 성립하지 않으면(예: 상승 = 실행 시간, 남는 유지가 5초 미만, 상승 > 3600) **막지 않는다** — 지금 통하는 설정을 깨지 않는다. `steady`를 보내지 않고 칸 아래에 「이 설정으로는 유지 구간을 잴 수 없어 리포트는 전체 구간 기준입니다」와 이유(「상승이 실행 시간과 같거나 깁니다」/「상승 뒤 남는 시간이 5초보다 짧습니다」/「상승이 3600초를 넘습니다」)를 보인다(상승 칸이 보이는 간단 모드에서도).
  - 도착률 고정의 상승은 `steady`로만 보낼 수 있으므로 성립하지 않으면 오류다.
  - 둘 다 0이면 `steady`를 보내지 않는다(지금과 같은 페이로드, US4). 간단 모드 기본 프로필(`DEFAULT_SIMPLE_PROFILE`)은 그대로다.
- 기본값: 상승 0(도착률)·지금 값(VU), 버림 0. 상승을 0보다 크게 넣으면 버림 칸에 「권장 5초」 안내를 보인다(자동으로 채우지 않는다 — 숨은 값으로 집계가 바뀌지 않게).
- VU 고정의 상승 도움말에 「VU 수가 상승 초보다 적으면 더 일찍 다 뜹니다 — 상승 시간은 최대값입니다」를 더한다(F2).
- 칸 아래 한 줄 요약: 「상승 30초 → 유지 270초 · 리포트 기본 기준은 뒤 265초」.
- 프리셋·다시 실행·스케줄 폼은 같은 칸을 쓴다(`LoadModelFields` 공유). 저장본에 `steady`가 있으면 모드를 「고정」으로 읽고 칸을 채운다 — open-loop + 상승 > 0은 저장본에 `stages`가 있으므로 `steady`를 **먼저** 본다(계단과 같은 순서, `deriveLoadMode`). 목표 칸은 `fixedTarget(p) = target_rps ?? steady.target`에서 채운다.
- 상세 모드로 여는 조건(`opensDetailed`)에 「버림 > 0」과 「도착률 고정 + 상승 > 0」을 더한다(숨은 설정이 조용히 제출되지 않게). VU 고정의 상승만 있는 다시 실행은 지금처럼 연다.
- UI 스키마: `ProfileSchema`에 `steady`를 `.optional()`로 더한다 — 빠뜨리면 프리필에서 조용히 사라져 다시 실행한 run이 곡선 + 전체 구간 기준이 된다(F12).

### D9. 리포트 화면

- `basis` 블록이 있는 리포트에만 맨 위에 **기준 전환** 「유지 구간 | 전체 구간」을 둔다. 처음 열면 기본 기준이다. 전환하면 그 기준의 리포트를 받아 화면 전체가 바뀐다. `not_reached`면 「유지 구간」을 고를 수 없고 안내 「유지 구간에 닿기 전에 끝나 전체 구간만 볼 수 있습니다」.
- `basis.dropped_whole_run`이면 버림 수 옆에 「전체 구간」 표지.
- 전환 아래 기준 줄:
  - 유지 구간: 「유지 구간 · 14:02:35–14:07:00 (265초) · 상승 30초·버림 5초 제외」. `partial`이면 「일찍 끝남 — 계획 265초 중 120초」, `t0_estimated`면 「시작 시각 추정」을 덧붙인다.
  - 전체 구간: 「전체 구간 · 상승 30초 포함」.
- 기준 줄 옆 참고 한 줄(`basis.other`): 「전체 구간: 초당 요청 71.2 · p95 48 ms · 오류 0.3%」(유지 구간을 볼 때. 반대도 같다).
- 시계열 그림은 두 기준 모두 run 전체를 그리고, 상승·버림 구간을 옅은 띠로, 유지 구간 시작·끝을 세로선으로 표시한다(범례 한 줄).
- 유지 구간 리포트에서 구간으로 나눌 수 없는 표(D5 목록)에는 표 머리에 「전체 구간」 표지를 붙인다.
- 프로필 표시는 `steady`가 있으면 「도착률 고정 80 iter/s · 상승 30초 · 버림 5초」처럼 **고정**으로 적는다(곡선으로 적지 않는다). 손댈 곳(F14): `deriveLoadMode`가 `steady`를 먼저 보고 「고정」을 돌려주고, 고정 목표를 읽는 곳은 `fixedTarget(p)` 하나를 쓴다(`target_rps ?? 0` 직접 읽기를 없앤다 — 안 그러면 「0 iter/s」가 찍힌다). `stages`를 직접 보고 곡선으로 가르는 곳(`ReportHeadline`의 곡선 문장, `openLoopRates`의 「목표(최대)」·달성률 없음, 사이징 기준 제외, `LoadShapePreview`)도 `steady` run은 고정으로 다룬다.
- UI 스키마: `ReportSchema`(`.strict()`)에 `basis`를 `.optional()`로 더한다 — 빠뜨리면 `steady` run의 리포트가 통째로 파싱에 실패한다(F12). 비교 보고서의 `NAMED_PROFILE_KEYS`에 `steady`를 더한다(안 그러면 「그 밖의 설정 다름」이 거짓으로 뜬다).
- **`steady` 없이 상승만 있는 run**(예전 run, 위의 「막지 않는」 경우)의 리포트에는 요약 위에 화면 전용 한 줄 「상승 N초 포함 전체 구간 값」을 보인다. 리포트 JSON은 그대로다(US4) — 처음의 의문(「평균에 상승이 섞였나」)에 그 run에서도 답이 보이게 한다.
- `no_common_window`면 「유지 구간」을 고를 수 없고 안내 「워커 시작 시각 차이가 커서 공통 유지 구간이 없습니다 — 전체 구간만 볼 수 있습니다」.
- 주소에 기준을 담는다(`?basis=whole`) — 새로 고침·링크 공유·인쇄 화면으로 넘길 때 유지된다. 기본 기준이면 주소에 넣지 않는다.

### D10. 비교·인쇄·내보내기

- **비교 화면**: run마다 기본 기준 리포트를 쓴다. 두 run의 기준이 다르면 표 위에 안내 한 줄 「집계 기준이 다릅니다 — A: 유지 구간, B: 전체 구간」.
- **비교 보고서** 조건 점검: 「집계 기준」 줄을 더한다(값 「유지 구간(상승 30초·버림 5초 제외)」/「전체 구간」, 다르면 「다름」). 기존 `ramp` 줄은 `steady.ramp_seconds`도 읽는다.
- **인쇄 단일 보고서**(사용자 결정): 화면에서 보고 있던 기준 하나로 인쇄한다. 머리에 기준 줄(D9와 같은 글자)과 다른 기준의 참고 한 줄을 넣는다. 두 기준을 통째로 함께 인쇄하는 선택은 두지 않는다(둘 다 필요하면 기준을 바꿔 두 번 인쇄).
- **XLSX**: 두 기준을 함께 넣는다 — 지금의 시트들은 기본 기준 값이고, 다른 기준의 요약·스텝 표를 시트 하나(「다른 기준」)로 더한다. Summary 시트에 기준 행을 더한다. `steady` 없는 run의 파일은 지금과 같다.
- **CSV**(스텝 표): `?basis=`를 받는다. 화면의 내려받기는 보고 있는 기준을 넘긴다.
- **비교 CSV/XLSX**: run마다 기본 기준 값 + run별 기준 표시. 화면과 같은 값을 내는지는 기존 골든 방식으로 잠근다.

## 3-1. 두 슬라이스로 나눈다 (리뷰 지적 — 한 슬라이스로는 크다)

| 슬라이스 | 내용 | US |
|---|---|---|
| **A (이 spec의 첫 plan)** | D1–D8, D9 중 기준 전환·기준 줄·참고 줄·`partial`/`not_reached`/`no_common_window`/추정 안내·「전체 구간」 표지(`dropped_whole_run` 포함)·`steady` 없는 상승 run의 「상승 N초 포함 전체 구간 값」 줄·프로필 표시·주소 유지 | US1–US4 |
| **B (이어서, 같은 릴리즈 전)** | D9의 시계열 띠·세로선, D10 전부(비교 화면 안내, 비교 보고서 「집계 기준」 줄, 인쇄 단일의 기준 줄·보고 있는 기준으로 인쇄, XLSX 두 기준, CSV `?basis=`, 비교 내보내기 기준 표시) | US5, US2의 인쇄·내보내기 |

- A만 들어간 상태에서도 비교·인쇄·내보내기·사이징은 **기본 기준 리포트**를 받는다(값은 맞다). 빠져 있는 것은 「이 값이 어느 기준인지」의 표시와 인쇄·내보내기에서 기준을 고르는 길이다. A와 B 사이에는 릴리즈하지 않는다.
- A의 라이브에서 US1의 「오른 뒤 유지」는 시계열 그림의 모양으로 확인한다(띠는 B).
- A에서 주소의 `?basis=`는 리포트 화면의 새로 고침·링크에만 쓰인다. 인쇄 화면과 화면의 내려받기 버튼은 A에서는 **항상 기본 기준**이고, 보고 있는 기준을 넘기는 것은 B다. 인쇄 요약 문장의 「처음 보인 시각」(전체 시계열에서 읽는다)을 기준에 맞추는 것도 B다.

## 4. 요구사항

| ID | 요구 | US |
|---|---|---|
| R1 | `steady` 설정 저장·정규화·검증(D1·D2), 다섯 진입점 모두 | US1·US4 |
| R2 | open-loop + 상승 > 0 run이 실제로 0→목표로 오른 뒤 유지한다(엔진 변경 없이 `stages`로) | US1 |
| R3 | closed-loop 고정 run이 워커 시작 시각을 기록한다(D4) | US2 |
| R4 | 유지 구간 창 계산(D3) — 워커별 t0, 부분 초 제외, 일찍 끝난 run, 추정 표시 | US2 |
| R5 | 기준별 리포트(D5): `?basis=`, 기본 기준, 창 안 행만으로 계산, `dropped`·달성 도착률 재계산, 시계열은 전체, `basis` 블록 | US2 |
| R6 | `steady` 없는 run은 리포트 JSON·판정·내보내기가 변경 전과 같다(`basis` 키 없음, `?basis=` 무시) | US4 |
| R7 | 판정이 기준을 따른다(D6): run 단위·스텝 기준·`min_window_rps`, 저장 배지 = 기본 기준 | US3 |
| R8 | 실행 대화상자 칸·검증·요약 줄·프리필(D8), 프리셋·스케줄 폼 포함 | US1 |
| R9 | 리포트 화면(D9): 기준 전환, 기준 줄, 참고 줄, 「전체 구간」 표지(`dropped_whole_run` 포함), `partial`·`not_reached`·`no_common_window`·추정 안내, `steady` 없는 상승 run의 한 줄, 주소 유지 (A) · 시계열 띠 (B) | US2·US3 |
| R10 | 비교 화면 안내, 비교 보고서 「집계 기준」 줄, 인쇄 단일, XLSX·CSV·비교 내보내기(D10) (B) | US5·US2 |
| R11 | `steady` run을 「고정 + 상승·버림」으로 읽고 적는다: `deriveLoadMode`·`fixedTarget`·`stages`로 가르는 곳(F14), UI 스키마 두 곳(D8·D9) | US1 |
| R12 | `steady`와 계단·VU 곡선 동시 사용 거절, F1 거절 유지 | US4 |
| R13 | 상승이 시작 감시 대기보다 긴 closed-loop run이 「부하 없음」으로 실패하지 않는다(D4·F2b, 재현 테스트 먼저) | US1 |

## 5. 검증

### 단위·통합

- 창 계산: t0가 초 경계가 아닐 때의 부분 초, 버림 0, 상승 0, 여러 워커(t0가 다름 → 공통 구간), 일을 안 한 워커 제외, 중단된 run의 `partial`·`not_reached`(워커 하나만 창에 닿은 중단 run도 `no_common_window`가 아니다), 완료 run은 `partial`이 되지 않는 것(추정 t0 포함), t0 추정, **완료 run의 마지막 초에 응답이 없어도 `measured`**(VU 1·긴 반복 픽스처).
- `rps_warmup_seconds`: 상승과 같은 값이면 유지 구간 기준에서 추가로 빼지 않고, 더 크면 차이만큼만 빼는 것.
- D4: closed-loop flush에 시작 시각이 실리고 `run_worker_starts`에 들어가는 것. 상승이 시작 감시 대기보다 긴 run(F2b) 재현 테스트.
- 값: 상승 구간에만 느린 응답·오류가 있는 픽스처에서 유지 구간 리포트의 p95·오류율·스텝 표·상태 코드 분포가 그 영향을 받지 않고 전체 구간 리포트는 받는 것(고의로 창을 0부터로 되돌려 실패하는지 확인).
- 같은 run의 전체 구간 리포트(`?basis=whole`)가 `basis` 블록과 `windows`를 뺀 나머지에서 `steady` 설정을 지운 같은 데이터의 리포트와 같은 것.
- 판정: 전체 구간으로는 불합격, 유지 구간으로는 합격인 픽스처(와 반대)에서 기준별 리포트의 판정이 각각 맞고, 저장 배지가 기본 기준을 따르는 것. 스텝 기준·`min_window_rps` 포함.
- open-loop: 창 밖에서만 버림이 난 픽스처에서 유지 구간 리포트의 `dropped`가 0이고 달성 도착률이 목표와 같은 것. 초 단위 계수가 없는 워커가 섞이면 `dropped_whole_run`.
- 상승 구간에만 느린 응답이 있는 픽스처에서 유지 구간 리포트에 「지연 상승」류 인사이트가 뜨지 않는 것.
- 연결 지표·스텝 행의 나눌 수 없는 칸이 두 기준 리포트에서 같은 값인 것(재사용률이 음수가 되지 않는 것).
- 공통 구간: 워커 시작 차이가 작으면 `measured`, `hold − discard`보다 크면 `no_common_window`. 추정 t0에서 `hi`가 마지막 메트릭 초 + 1을 넘지 않는 것.
- 정규화 규칙 3에 `stages`가 있으면 400.
- US4: `steady` 없는 run의 리포트 JSON이 변경 전 골든과 같은 것(키 추가 없음), `?basis=steady`를 붙여도 같은 것.
- 정규화: 세 저장 모양을 가르는 규칙 1–3, 채움과 불일치 400, 거절 조합(`steady.target < worker_count` 포함), 프리셋·스케줄 경로, 이미 정규화된 프로필을 다시 정규화해도 같은 것.
- UI: `steady`를 보내는 조건(D8)의 네 갈래, `ProfileSchema`를 지난 프리필에 `steady`가 남는 것, `steady` run이 「고정」으로 읽히고 목표가 0으로 찍히지 않는 것.

### 라이브 (US 척추)

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 실행 대화상자에서 도착률 고정 40 iter/s·실행 60초·상승 20초·버림 5초 → 실행 | 저장된 프로필에 `steady`와 두 단계 `stages`. 리포트 시계열의 요청 수가 앞 20초 동안 오르고 뒤 40초는 평평, 띠·세로선이 그 경계에 있음 |
| US2 | 같은 run 리포트. VU 고정 10·상승 10초·버림 5초 run도 | 처음 열면 유지 구간. 요약 RPS가 기대값(도착률: 40 × 스텝 수)과 오차 5% 안. 「전체 구간」으로 바꾸면 RPS가 더 낮고 요청 수·기간이 늘어남. 기준 줄의 초 수 = 실행 − 상승 − 버림(경계 1초 이내). 실행 중 중단한 run은 `partial` 또는 `not_reached` 안내 |
| US3 | 상승 중에만 느린 응답기(처음 15초 500 ms, 이후 20 ms)로 p95 ≤ 100 ms 기준 run, 상승 20초 | 유지 구간 리포트 판정 합격, 목록 배지 합격. 「전체 구간」으로 바꾸면 불합격 |
| US4 | 변경 전 DB의 run(또는 `steady` 없는 새 run) 리포트 | 기준 전환 없음, `basis` 키 없음, 요약·판정이 변경 전과 같음 |
| US5 | US2의 run과 `steady` 없는 run을 비교, 비교 보고서 인쇄 | 화면 안내 줄, 조건 점검 「집계 기준 … 다름」 |

그 밖: 기준을 바꾼 채 인쇄 → 인쇄본이 그 기준(기준 줄·참고 줄 포함), XLSX에 두 기준. 극단값 — 상승 3600초 문구·긴 기준 줄이 폭을 넘지 않는지, 인쇄 쪽 수가 화면 쪽 수와 같은지, 여러 워커(VU > 워커 용량) run에서 창이 맞는지.

## 6. 비용·한계 (머지 때 roadmap §B로 옮길 것)

- **(1) 구간으로 나눌 수 없는 집계** — 반복·분기·오류 종류·조건 반복 종료·묶음 지연·다운로드 단계·연결 지표는 유지 구간 리포트에서도 run 전체 값이다(초 단위로 저장되지 않는다). 표지로 알린다. 해소하려면 그 집계들을 초 단위로 저장해야 한다(엔진·와이어·마이그레이션).
- **(2) 지연은 응답이 끝난 초에 기록** — 상승 끝의 느린 요청이 유지 구간 첫 초들에 들어간다. 버림으로 흡수한다. 요청 시작 시각 기준 분류는 엔진·와이어 변경이라 하지 않는다.
- **(3) 실행 중 화면의 「평균 RPS」** 는 지금도 설정 전체 길이로 나눈다(선재). 이번에 바꾸지 않는다.
- **(4) 같은 프리셋의 예전 run과 숫자 기준이 달라진다** — 상승이 있던 VU 프리셋으로 새로 돌리면 기본 기준이 유지 구간이 된다. 비교 조건 점검의 「집계 기준」 줄(US5)이 이를 알린다.
- **(5) 인쇄는 한 번에 한 기준** — 두 기준을 한 보고서로 묶지 않는다(사용자 결정).
- **(6) 자유 곡선은 그대로** — 다음 슬라이스.
- **(7) VU 고정의 상승은 「최대」 시간이다** — VU 수가 상승 초보다 적으면 더 일찍 다 뜬다(F2). 유지 구간 창은 설정한 상승 시간 뒤에서 시작하므로 틀린 값은 아니지만, VU 10·상승 3600초처럼 넣으면 다 뜬 뒤의 긴 구간을 버린다. 도움말로 알린다(D8). 엔진의 VU 띄우는 간격을 고르게 바꾸는 것은 부하 모양이 달라지므로 하지 않는다.
- **(8) 여러 워커의 시작 시각이 많이 다르면 공통 구간이 그만큼 줄어든다**(D3). 기준 줄의 초 수로 드러난다.
- **(9) 중단된 run의 창 끝은 컨트롤러 시계 기준**이라 워커 PC와 시계가 다르면 그만큼 어긋난다(완료 run은 워커 시계만 쓴다).
- **(10) 워커 시작 시각이 `hold − discard`보다 크게 다르면 유지 구간 리포트를 못 만든다**(`no_common_window`). 해소: 워커 시작을 맞추는 장치(엔진·와이어) 또는 워커별 창 합산.
- **(11) 창은 초 단위다** — 경계의 초는 통째로 넣거나 뺀다(부분 초는 뺀다).

## 7. 그 밖

- ADR: 「유지 구간 기준 리포트 — run에 저장한 `steady` 표시 + 기준별 리포트(`?basis=`) + 기본 기준」를 ADR-0061로 남긴다(구현 슬라이스 마무리 때).
- 보안 표면: 요청 실행·템플릿·환경·데이터셋·업로드·본문 뷰어를 건드리지 않는다. 새 입력은 숫자 넷이고 서버가 범위를 검증한다. 마무리 때 §0 grep으로 다시 확인한다.
- 릴리즈 노트 줄(초안): 「고정 부하에 상승 시간·앞부분 버림 — 리포트와 SLO 판정을 유지 구간 기준으로(전체 구간 기준으로 전환 가능), 도착률 고정에도 상승 시간」.

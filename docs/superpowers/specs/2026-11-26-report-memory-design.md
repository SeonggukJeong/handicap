# 리포트 생성 메모리 — 창마다 분포를 끝까지 들지 않기 (report-memory)

- 날짜: 2026-11-26 · 유형: `correctness-bug`
- 상태: 구현·최종 리뷰·실측·두 바이너리 비교 끝(2026-11-26, 코드 `3f8e4ec5`..`2e98fd9a`) — 결과 build-log, 판단·남은 것 roadmap §B99. §4.2의 상한은 구현 중 확정(증가 상한은 최종 리뷰에서 16 → 4 MiB).
- 출처: roadmap §B98 (1) 첫 항목 「리포트 생성 메모리 — ④a 이전부터(D6, 중요)」
- 사용자 결정(2026-11-26, 다시 묻지 않는다):
  - 범위 = `build_report`의 창 분포 + 계단 리포트의 초 분포(같은 원인). §B98 (1) 둘째 항목 「리포트 생성 시간 +23.3%」는 **이 슬라이스 밖** — 끝난 뒤 따로 재고 판단한다.
  - 방법 = 「한 칸씩 계산하고 버리기」(§3). 정밀도를 낮추는 방법·저장 시점에 미리 계산하는 방법·긴 run을 막는 방법은 기각(§3.4).
  - 숫자가 하나라도 달라지면 실패다 — 성능보다 정확성이 먼저.

## 사용자 스토리 (US)

버그 슬라이스라 `재현 / 기대 / 실측` 형식이다.

- **US1 — 긴 run이 끝나도, 그 리포트를 열어도 컨트롤러가 죽지 않는다** (QA)
  - 재현: 스텝 10개 시나리오를 1시간 돌린다. run이 `completed`가 되는 순간 컨트롤러가 판정 배지를 저장하려고 리포트를 한 번 만든다(§1.3 — 판정 기준이 없는 run도). 그 뒤 리포트 화면·인쇄·CSV/XLSX 내보내기·비교가 열 때마다 다시 만든다.
  - 기대: 리포트를 만드는 동안 **동시에 풀어 두는 응답 시간 분포의 수**가 run 길이에 비례하지 않는다(창마다 하나 → 몇 개로 고정). 합성 1시간 × 스텝 10 run(§4.3)의 리포트 생성 최대 RSS가 **512 MB 이하**다(수정 전 ≈11 GB). 행 원본·출력 창처럼 run 길이에 비례하는 나머지(§1.5)는 남지만 분포보다 수백 배 작다 — 크기는 §4.3에서 잰다.
  - 실측: 600초 × 스텝 10 = 최대 RSS 1.8 GB, 1시간 × 스텝 10은 디버그에서 RSS 10.5 GB까지 보고 중단(≈11 GB 예상, §B98 (1)). 컨트롤러가 OOM으로 죽으면 그 컨트롤러의 다른 run·운영 모니터·예약 실행이 함께 멈춘다. 사람이 지켜보지 않는 예약 run도 끝나는 순간 해당한다.
- **US2 — 고친 뒤에도 같은 run의 리포트 숫자는 한 글자도 다르지 않다** (운영자)
  - 재현: 수정 전 바이너리와 수정 후 바이너리로 같은 DB의 같은 run 리포트를 받는다.
  - 기대: 리포트 JSON(요약·스텝별·초별 창·초별 모든 스텝 합계·판정·인사이트·유효성·계단 표)이 표본 셋(`?sample=passed|failed|all`) × 기준(`?basis=whole|steady`) 모두에서 바이트까지 같다. CSV·인사이트 CSV·계단 CSV·비교 CSV가 바이트까지 같고 XLSX(단일·비교)는 파일 생성 시각 부분을 뺀 모든 부분이 같다. 실행 목록의 판정 배지는 같은 `build_report`가 만든 `/report`의 `verdict`로 확인한다(배지 = 그 값을 완료 순간 저장한 것, §1.3).
- **US3 — 계단 시험 run도 같다** (QA)
  - 재현: 계단 시험 run의 리포트를 연다.
  - 기대: 계단 표·초별 그래프(`stair.seconds`)가 수정 전과 같고, 리포트를 만드는 동안의 메모리가 run 길이에 비례하지 않는다.
  - 실측: 초마다 모든 스텝을 합친 분포 하나(≈139 KB, 실패 분포 없이)를 끝까지 든다 — 1시간 run이면 ≈500 MB(계산값). §4.2의 계단 측정이 수정 전·후 숫자를 남긴다.

## 1. 지금 동작 (코드 확인, base `ac05b231`)

### 1.1 `build_report`의 창 누적 (`crates/controller/src/report.rs`)

줄번호는 `grep -n "let mut window_acc\|let occupancy_windows\|for ((ts, step), mut acc) in window_acc\|^    for r in rows {" crates/controller/src/report.rs`로 확인했다.

- 989: `window_acc: BTreeMap<(i64, String), WindowAcc>` — (초, 스텝) 칸마다 `SplitHist`(전체 분포 + 실패가 있으면 실패 분포, 각각 고정 범위 1..60,000,000 µs · 유효 숫자 3)를 든다.
- 1018–1085: 행 하나를 한 번 디코드해 네 자리(창·전체·스텝·워커)에 더한다. 창은 범위(유지 구간) 밖 행도 받는다.
- 1118–1133: 보여 주는 표본이 「모든 요청」이 아니면 점유 창(`occupancy_windows`)을 `window_acc` 전체를 빌려 따로 만든다.
- 1148–1171: `window_acc`를 옮겨 가며 보여 주는 창(`windows`)과 초별 모든 스텝 합계(`latency_by_second`, 같은 초의 창이 이어 나오는 것에 기댄다)를 만든다.
- 그래서 행 루프가 끝난 시점(1085)과 점유 창을 만드는 동안(1118–1133) `window_acc`의 모든 칸 분포가 메모리에 있다 — 이때가 최대다. 1148의 훑기는 맵을 옮겨 가며 칸을 하나씩 버린다. 칸 수 = 초 × 스텝. 분포 하나 = 카운트 배열 17 × 1024 × 8 B = 139,264 B, 실패 분포가 있으면 칸당 ≈280 KB.
- 이 칸에서 나가는 값은 전부 칸 단위로 끝난다: `ReportWindow`(p50/p95/p99 ms·n·mean_us·capped·건수·상태 코드), 초별 합계로 합쳐지는 분포. 칸 분포를 나중에 다시 읽는 곳은 없다(`grep -n "window_acc" crates/controller/src/report.rs` = 989·1020·1119·1144·1148, 전부 위 구간).
- 다른 누적(`overall`·`per_step`·`worker_acc`·`group_acc`·`download_acc`·`wait_acc`·`split_acc`)의 **분포 수**는 스텝 수·워커 수에 비례하고 run 길이와 무관하다. 단 `SplitHist.fail_rows`(`sample.rs:132`)는 실패가 있는 행마다 32 B 참조 한 쌍을 `overall`·해당 `per_step`·해당 `worker_acc`에 쌓는다 — run 길이에 비례하지만 분포의 수천분의 일이라 그대로 둔다.

### 1.2 행 순서

- 운영 경로의 유일한 행 공급자는 `store::metrics::windows_with_hdr`이고 `ORDER BY ts_second, step_id, worker_id`로 읽는다(`grep -n "ORDER BY ts_second, step_id, worker_id" crates/controller/src/store/metrics.rs` → 126).
- `build_report`의 운영 호출자는 `api::runs::build_reports_for_run` 하나다(`grep -rn "report::build_report(" crates/controller/src`로 확인 — 나머지는 `report.rs` 테스트). 그 안에서 `build(None)`(전체)과 유지 구간이 있으면 `build(Some(scope))`를 차례로 부른다(`let whole = build(None)` → `api/runs.rs` 1341).
- 테스트는 정렬되지 않은 행도 넘긴다. 지금 코드는 `BTreeMap`이 칸을 모아 주므로 행 순서와 무관하게 같은 창을 만든다.

### 1.3 리포트를 만드는 때

- `GET /api/runs/{id}/report`, 단일 내보내기(CSV·인사이트 CSV·XLSX·인쇄), 비교 내보내기(run마다 한 번씩 차례로), 그리고 **run이 `completed`가 되는 순간** `CoordinatorState::persist_verdict`(`grep -n "self.persist_verdict(run_id)" crates/controller/src/grpc/coordinator.rs` → 1373·1389). `persist_verdict`는 판정 기준 유무와 상관없이 `build_report_for_run`을 부른다. 그래서 긴 run은 리포트를 열지 않아도 끝나는 순간 메모리를 쓴다.

### 1.4 계단 리포트의 초 누적 (`crates/controller/src/stair.rs`)

- 950: `secs: BTreeMap<i64, SecAcc>` — 워커 시작 기준 초(offset)마다 계수와 `hist: Option<Histogram<u64>>`(그 초의 모든 스텝·모든 워커 합)를 든다. 951–968: 워커마다 open-loop 계수 행과 메트릭 행을 돌며 `secs`와 `StairAccumulator`(`acc.push_metric`)에 더한다. 1078–1088: `secs`를 `StairSecond`로 바꾸며 초마다 `p99_us`를 계산한다.
- 워커마다 시작 시각(`t0`)이 달라 같은 offset의 행이 워커마다 다른 `ts_second`에서 온다. 그래서 1.1처럼 「DB 순서 그대로 훑기」가 성립하지 않는다.
- `StairAccumulator`는 계단 수(`cfg.targets.len()`)에 비례하고 run 길이와 무관하다. 그 누적은 합(포화 덧셈)과 분포 합치기뿐이다(`push_metric`·`push_open_loop`).

### 1.5 이번에 손대지 않는 곳 (확인만)

- 라이브 계단 감시(`stair_monitor.rs`)의 초 버퍼는 상한이 있다(`SECOND_BUFFER_MAX = 30`, `PENDING_MAX_SECONDS = 30`).
- 실행 중 `/metrics` 요약(`store::metrics::summary`)은 분포를 디코드하지 않는다.
- run 길이에 비례하지만 분포를 풀지 않는 것들 — 리포트를 만드는 동안 한꺼번에 메모리에 있다. 크기는 §4.3에서 잰다:
  - DB 행 원본 `Vec<WindowWithHdr>`(직렬화된 분포 바이트)와 `fetch_all`이 그것을 만드는 동안의 임시 사본(`metrics.rs:124–131`).
  - `phases`·`groups` 행(추가 전용, 배치마다 한 행 — `INSERT INTO run_phase_metrics`·`INSERT INTO run_group_metrics`, `api/runs.rs`에서 `phase_breakdown`·`group_breakdown`으로 전부 읽음). 이 행들은 스텝별로 하나씩 합쳐지므로 동시에 푸는 분포는 스텝 수만큼이다.
  - 출력 `windows`·`latency_by_second`, 유지 구간 run에서 두 번째 리포트를 만드는 동안 들고 있는 전체 리포트(`whole`), 이번에 더하는 정렬 인덱스(행당 8 B).

## 2. 목표 · 비목표

**목표**
- G1. `build_report`가 리포트를 만드는 동안 동시에 드는 창 분포를 run 길이와 무관한 수로 줄인다 — 현재 칸의 전체·실패 분포 2개 + 통과 표본 빼기용 복사본 1개 + 그 초의 합계 1개, 보통 4개(≈560 KB). 합친 분포끼리 빼기가 실패해 행 단위로 다시 계산하는 동안(`sample.rs` `passed_by_rows`)은 행 분포 몇 개가 더해져 ≈7개(≈1 MB) — 그래도 run 길이와 무관하다.
- G2. 계단 리포트가 동시에 드는 초 분포를 1개로 줄인다.
- G3. 리포트의 모든 출력이 수정 전과 같다(US2). 「같다」는 코드 경로로 논증하고(§3.3) 테스트·두 바이너리 비교로 확인한다(§4).

**비목표**
- 리포트 생성 시간 단축(§B98 (1) 둘째 항목 — 사용자 결정으로 분리). 이 슬라이스가 생성 시간을 늘리지 않았는지는 §4.4에서 확인만 한다.
- DB 행 원본을 나눠 읽기(스트리밍 조회). §4.3 실측이 크면 roadmap §B에 보고만 한다.
- 리포트 결과 저장(캐시), 리포트 JSON의 창 개수 줄이기, UI.
- 라이브 계단 감시·`/metrics`(§1.5).

**반목표(이렇게 되면 기술적으로 동작해도 실패)**
- 숫자·순서·키가 하나라도 달라짐. 깨진 BLOB·통과 표본 없음·빼기 실패(`Broken`/`Empty`) 같은 가장자리의 결과가 달라짐.
- 들어온 행 순서에 따라 창이 쪼개짐(같은 칸이 두 창으로 나옴) — 오류 없이 숫자만 틀리는 형태.

## 3. 설계

### 3.1 `build_report` — 칸을 다 모으면 바로 계산하고 버린다

1. 행 참조의 순서를 만든다: `rows`의 인덱스를 `(ts_second, step_id)`로 **안정 정렬**한다. 키 비교는 지금 `window_acc`의 키 `(i64, String)` 순서와 같다(`i64` 오름차순, `String`은 바이트 순). 운영 경로의 행은 이미 이 순서라(§1.2 — SQLite `TEXT` 기본 정렬 `BINARY`도 바이트 순) 정렬 결과는 원래 순서 그대로다.
2. 1018의 행 루프를 이 순서로 돈다. 루프 몸체(창 외의 누적 — 전체·스텝·워커·건수·상태 코드)는 그대로 둔다.
3. 창 누적은 「현재 칸」 하나만 든다. 키가 바뀌면 직전 칸을 **마무리**한다:
   - 보여 주는 창: 지금 1157–1170과 같은 계산(`acc.hist.resolve(selected)`, `window_of(…, true)`).
   - 점유 창(보여 주는 표본이 「모든 요청」이 아닐 때만): 지금 1119–1131과 같은 계산(`acc.hist.resolve(Sample::All)`, `window_of(…, false)`).
   - 초별 합계: 보여 주는 분포가 있으면 그 초의 임시 분포에 합치고, 초가 바뀌면 `second_of`로 내보낸다(지금 1149–1155·1172–1174와 같은 규칙).
   - 그 뒤 칸을 버린다.
4. 마지막 칸은 루프 뒤에 같은 방식으로 마무리한다. 행이 없으면 창·점유 창·초별 합계가 모두 빈 벡터다(지금과 같음).
5. 점유 창 벡터가 따로 만들어지는 규칙(`selected != Sample::All`일 때만 `Some`, 아니면 보여 주는 창을 빌림 — 1175)은 그대로 둔다.

결과: 동시에 드는 창 분포 = 보통 현재 칸의 전체·실패 2개 + 빼기 복사본 1개 + 초 합계 1개, 빼기 실패 때 행 단위 재계산 중엔 몇 개 더(G1). 스텝·워커 단위 누적은 지금 그대로.

- 행이 하나뿐이고 그 행이 깨진 칸(디코드 실패 → `fed=false` → `Broken`)도 지금처럼 값이 0인 창을 낸다 — 칸은 건수·상태 코드로 이미 생겼으므로.

### 3.2 계단 리포트 — 초마다 바로 p99를 내고 버린다

1. 워커 등록 루프(903–948)는 그대로 둔다.
2. 951–968 루프를 둘로 나눈다:
   - open-loop 계수 행은 지금처럼 워커마다 돌며 `secs`(계수만)와 `acc.push_open_loop`에 더한다.
   - 메트릭 행은 **`workers`(903–948이 남긴 활동 워커만)의 `metrics`** 를 모아 `(offset, worker_id, 원래 순서)`로 안정 정렬한 순서로 돈다. 입력 `rows` 전체를 정렬하면 안 된다 — 도착을 하나도 만들지 않은 워커(905–912에서 빠짐)의 행이 `secs`의 건수·분포에 섞인다(`push_metric`은 등록 안 된 워커를 버리지만 `secs`는 그렇지 않다). 행마다 지금처럼 `window_hist_per_window`로 한 번 디코드해 `secs`의 건수와 `acc.push_metric`에 더하고, 분포는 **현재 offset의 임시 분포**에 합친다. offset이 바뀌면 그 분포의 p99(`q(…, 0.99)`와 같은 계산)를 `secs[offset]`에 숫자로 남기고 분포를 버린다.
3. `SecAcc.hist: Option<Histogram<u64>>`는 p99 숫자 칸으로 바뀐다. 분포가 하나도 없던 초는 지금처럼 0이다(`q`가 `None`이면 0).
4. 1078–1088은 남긴 숫자를 그대로 쓴다.

### 3.3 「같다」의 근거

- **창 값(3.1)**: 칸 하나에 들어가는 행 집합과 그 행들이 들어가는 순서가 지금과 같다(안정 정렬이라 같은 칸 안의 순서 = 입력 순서 = 지금 `BTreeMap` 칸에 들어가던 순서). 칸 마무리 계산은 지금 코드와 같은 함수 호출이다. 창이 나오는 순서 = 키 순서 = 지금 `BTreeMap` 순회 순서.
- **창 외 누적(3.1 2.)**: 운영 경로는 정렬 결과가 원래 순서라 모든 누적의 순서가 지금과 같다. 정렬되지 않은 입력(테스트)에서는 스텝·전체·워커 누적에 행이 들어가는 순서가 바뀐다. 그 누적은 정수 합·상태 코드 맵 합·고정 범위 분포 합치기(카운트 정수 덧셈, 최솟값·최댓값은 순서와 무관)라 결과가 같다. `SplitHist::passed_by_rows`(빼기 실패 때의 행 단위 재계산)는 실패 행 목록의 전체 분포를 차례로 뺀 뒤 행마다 (전체 − 실패)를 더한다. 첫 단계는 어떤 순서로도 실패하지 않는다 — 시작값이 모든 행의 전체 분포 합이라 어느 중간 상태에서도 칸마다 남은 행들의 몫 이상이 남는다(hdrhistogram `subtract`는 칸마다 `checked_sub`, 7.5.4 `lib.rs:587–626`). 둘째 단계는 행 단위 계산과 덧셈이라 순서와 무관하다. 이 논증은 plan의 순서 무관 테스트(§4.1)로 확인한다.
- **계단(3.2)**: `push_metric`·`push_open_loop`의 누적은 포화 덧셈과 분포 합치기뿐이라 워커 간 순서가 바뀌어도 결과가 같다(`u64` 합이 포화할 일은 없다). 초 분포는 같은 행 집합을 합친 뒤 같은 `value_at_quantile(0.99)`를 계산한다.

### 3.4 고려했다가 기각한 방법

| 방법 | 기각 이유 |
|---|---|
| 창 분포를 덜 정밀하게(유효 숫자를 낮춤) | 숫자가 바뀐다(반목표). |
| 창 분포를 압축 표현(기록된 칸만)으로 보관 | 숫자는 같지만 메모리가 여전히 창 수에 비례하고 더 복잡하다. |
| 저장 시점에 창 숫자를 미리 계산 | 워커가 여럿이면 합치기 전 값이라 틀린다. 마이그레이션이 필요하고 옛 run엔 없다. |
| 긴 run은 리포트를 막거나 창을 생략 | 사용자가 결과를 못 본다. |
| 리포트 결과 저장(캐시) | 첫 생성(= run이 끝나는 순간)의 메모리는 그대로다. 나중에 덧붙일 수는 있다. |
| DB에 의존해 정렬 없이 훑기 | 순서가 어긋난 입력에서 창이 오류 없이 쪼개진다(반목표). 정렬 비용은 행 수 n의 n log n 비교로 디코드 비용보다 작다. |

## 4. 검증

### 4.1 단위 테스트 (`report.rs`·`stair.rs` 인라인)

- **순서 무관**: 여러 워커·여러 스텝·실패 분포가 있는 행과 없는 행·깨진 BLOB·빼기 실패 행이 섞인 입력을 정렬된 순서와 뒤섞은 순서로 넣어 `ReportJson`의 JSON 값이 같은지, 표본 셋 × 범위 있음/없음에서 단언한다. 되돌려 확인: 3.1의 정렬을 빼면 RED.
- **칸 경계**: 한 초에 스텝이 여럿, 한 칸에 워커가 여럿, 초 사이가 빈 경우, 행 1개, 행 0개, 깨진 행 하나뿐인 칸(값 0인 창)에서 창·점유 창·초별 합계가 예상값과 같다.
- **계단**: 시작 시각이 다른 워커 둘(offset이 엇갈림)의 `stair.seconds`가 정렬·뒤섞은 순서에서 같고, 손으로 계산한 p99와 같다. 되돌려 확인: offset 정렬을 빼면 RED. 도착을 만들지 않은 워커의 메트릭 행이 있는 입력에서 `stair.seconds`가 지금과 같다(그 행이 섞이면 RED).
- 기존 `report.rs`·`stair.rs`·`export.rs` 테스트와 `testdata/compare_golden.json` 골든이 수정 없이 통과한다.

### 4.2 메모리 회귀 테스트

- 별도 통합 테스트 파일 하나, 그 안에 `#[test]` **하나**(전역 할당기의 최대치 칸을 공유하므로 — `cargo test`는 같은 파일의 테스트를 스레드로 동시에 돌려 섞는다). 바이트를 세고 최대치를 기록하는 전역 할당기를 둔다. 기준점은 입력 행을 다 만든 뒤 잡는다.
- 입력 분포 바이트는 그 파일에서 `hdrhistogram::serialization::V2Serializer`로 직접 만든다(`report.rs`의 `make_hdr_bytes`·`win`·`run_row`는 `#[cfg(test)]`라 통합 테스트에서 보이지 않는다).
- 순서대로 두 가지를 잰다:
  1. `build_report`(합성 N초 × 스텝 10, 행마다 실패 분포)의 최대 증가분을 N과 2N에서. 단언: `peak(2N) − peak(N)`이 작은 상한 이하(길이에 비례하지 않음) + `peak(2N)`이 절대 상한 이하.
  2. `build_stair_report`(`stair.rs:875`, `pub`)를 **직접** 시작 시각이 다른 워커 둘로 N초와 2N초에서. 같은 두 단언. `build_report`를 거치면 수정 전 값이 창 분포에 묻혀 계단만 되돌렸을 때 RED가 안 난다.
- 상한·N은 **구현 중 실측 확정**. 조건: 수정 전 코드에서 RED(되돌려 확인 — `build_report`만 되돌림 → 1이 RED, 계단만 되돌림 → 2가 RED). 작은 N으로 충분하다(수정 전 60초 × 10이면 ≈168 MB, 수정 후 수 MB 예상). 디버그 실행이 수 초 안에 끝나는 N.

### 4.3 실측 (US1·US3 숫자)

- 기존 `#[ignore]` `report_build_timing`(합성 행)을 `REPORT_TIMING_SECONDS=3600`으로 `/usr/bin/time -l`(macOS 최대 RSS) 아래 돌려 1시간 × 스텝 10의 최대 RSS를 잰다. 수정 전은 600초(§B98의 1.8 GB)와 1,200초로 비례를 보이고, 수정 후는 600·1,200·3,600초가 거의 같음을 보인다.
- 같은 측정에서 행 원본(`Vec<WindowWithHdr>`)의 크기를 따로 계산해 남긴다(§1.5). `phases`·`groups` 행은 합성 측정에 없으므로 라이브 run(§4.4)의 DB에서 `SUM(LENGTH(hdr_histogram))`·행 수로 초당 크기를 재 1시간 값으로 환산한다. 크면 roadmap §B에 「DB 행을 나눠 읽기」 후보로 기록한다.
- 통과 조건(US1): 3,600초 × 스텝 10 최대 RSS ≤ 512 MB.

### 4.4 두 바이너리 비교 (라이브, US2·US3)

- 절차: ① 한 바이너리(master)로 모든 run을 만들고 끝낸다 ② 컨트롤러를 멈춘다. 멈춘 뒤 `-wal`·`-shm` 파일이 남아 있으면 DB와 **함께** 복사하거나, 복사 전에 `sqlite3 <db> "PRAGMA wal_checkpoint(TRUNCATE)"`로 합친다(종료 때 합쳐진다고 가정하지 않는다 — 빠진 행이 두 벌에 똑같이 빠지면 비교는 통과해도 데이터가 모자란다) ③ DB를 두 벌 복사하고, 두 벌의 `SELECT COUNT(*) FROM run_metrics`가 run을 만든 직후 값과 같은지 확인 ④ master(`ac05b231`) 바이너리와 이 브랜치 바이너리를 각자의 복사본에 다른 포트로 띄운다 ⑤ 같은 요청을 보내 응답을 바이트 비교.
- run: ① 스텝 여럿 + 일부 실패(통과/실패 표본이 나뉨) ② 부하기 2개(fan-out) ③ 유지 구간(`steady`) ④ 계단 시험 — **부하기 2개 이상**(시작 시각이 달라야 offset 정렬이 실제로 순서를 바꾼다. 부하기 1개면 정렬이 항등이라 새 경로를 지나지 않는다) ⑤ 판정 기준이 있는 run.
- 비교 대상(run마다): `/report`(표본 셋 × 기준 둘), `report.csv`·`report-insights.csv`·`report.xlsx`(기준 둘 — 내보내기도 `?basis=`를 받는다, `api/runs.rs` 1554·1571·1588), 계단 run의 `report-stairs.csv`, 시나리오별 `compare.csv`·`compare-insights.csv`·`compare.xlsx`.
- XLSX는 압축을 풀어 `docProps/core.xml`(생성 시각)을 **뺀 모든 부분**을 비교한다 — 셀 글자는 `xl/sharedStrings.xml`에 있고 시트 XML에는 번호만 있다. `export.rs`는 문서 속성을 정하지 않으므로 다른 부분은 결정적이다.
- 생성 시간: `report_build_timing`(600초) 중앙값을 수정 전·후, 디버그·릴리즈로 기록한다(비목표지만 회귀 확인). 릴리즈 중앙값이 수정 전보다 5% 넘게 늘면 원인을 확인해 사용자에게 보고한다(머지를 막는 기준은 아니고 판단 요청).

## 5. 위험 · 남는 것

- R1. 정렬 키가 지금 칸 키와 다르면 창 순서가 바뀐다 → 3.1 1.에서 키를 `window_acc`의 키와 같은 타입·같은 비교로 정한다. 4.1 순서 무관 테스트와 4.4 비교가 잡는다.
- R2. 마지막 칸·마지막 초 마무리 누락 → 4.1 칸 경계(행 1개·마지막 초) 테스트.
- R3. 점유 창을 같은 훑기에서 만들 때 보여 주는 창과 상태 코드 맵을 공유하다 한쪽을 비움 → 점유 창은 상태 코드 맵을 복사, 보여 주는 창은 옮긴다(지금과 같음). 4.1이 표본 셋 모두를 단언.
- R4. 행 원본이 크면(§4.3) OOM 위험이 남는다 → 실측해 보고.
- 남는 것: 생성 시간(§B98 (1) 둘째), 리포트 캐시, DB 행 나눠 읽기 — 끝에서 roadmap §B에 정리.

## 6. 사실 주장과 그 명령 (디스패치 전 재실행)

| 주장 | 명령 |
|---|---|
| `window_acc` 사용처 5곳, 전부 989–1148 | `grep -n "window_acc" crates/controller/src/report.rs` |
| 운영 행 공급자 순서 | `grep -n "ORDER BY ts_second, step_id, worker_id" crates/controller/src/store/metrics.rs` |
| `build_report` 운영 호출자 하나 | `grep -rn "report::build_report(" crates/controller/src` |
| 완료 시 리포트 생성 | `grep -n "self.persist_verdict(run_id)" crates/controller/src/grpc/coordinator.rs` |
| 계단 초 분포 | `grep -n "let mut secs: BTreeMap\|hist: Option<Histogram<u64>>,\|let seconds = secs" crates/controller/src/stair.rs` |
| 라이브 감시 상한 | `grep -n "pub const SECOND_BUFFER_MAX\|pub const PENDING_MAX_SECONDS" crates/controller/src/stair_monitor.rs` |
| 실패 행 참조 목록 | `grep -n "fail_rows: Vec" crates/controller/src/sample.rs` |
| 계단 활동 워커 거르기 | `grep -n "let active = if open_loop.is_empty()" crates/controller/src/stair.rs` |
| phases·groups 추가 전용 | `grep -n "INSERT INTO run_phase_metrics\|INSERT INTO run_group_metrics" crates/controller/src/store/metrics.rs` |
| 비교 대상 경로 | `grep -n "report.csv\|report.xlsx\|report-insights.csv\|report-stairs.csv\|compare.csv\|compare.xlsx\|compare-insights.csv" crates/controller/src/app.rs` |
| XLSX 문서 속성 미설정 | `grep -n "DocProperties\|set_properties" crates/controller/src/export.rs` (0건) |
| hdrhistogram 빼기 = 칸마다 `checked_sub` | `grep -n "pub fn subtract\|checked_sub" ~/.cargo/registry/src/*/hdrhistogram-7.5.4/src/lib.rs` |

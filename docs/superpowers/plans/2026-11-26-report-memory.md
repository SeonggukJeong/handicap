# 리포트 생성 메모리 (report-memory) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 리포트를 만드는 동안 창·초마다 풀어 둔 응답 시간 분포를 끝까지 들지 않게 해, 1시간 run의 리포트가 컨트롤러를 OOM으로 죽이지 않게 한다 — 출력은 바이트까지 그대로.

**Architecture:** `build_report`는 행을 `(ts_second, step_id)`로 안정 정렬한 순서로 한 번 훑으며 칸이 바뀔 때마다 직전 칸의 창·점유 창·초별 합계를 계산하고 분포를 버린다. `build_stair_report`는 활동 워커의 메트릭 행을 `(offset, worker_id)`로 안정 정렬해 offset이 바뀔 때마다 p99 숫자만 남긴다. 계산 함수는 지금 것을 그대로 부른다.

**Tech Stack:** Rust(edition 2024), `hdrhistogram` 7.5.4, cargo-nextest.

**Spec:** `docs/superpowers/specs/2026-11-26-report-memory-design.md` (spec-plan-reviewer APPROVE). 구현자는 spec §3(설계)·§3.3(같다의 근거)를 먼저 읽는다.

## Global Constraints

- 출력 불변: `ReportJson`·`StairReport`의 모든 값·순서·키가 수정 전과 같다. 기존 테스트·골든(`testdata/` 아래 `report_whole_golden.json`·`compare_golden.json`·`stair_report_golden.json`·`stair_autostop_report_golden.json`·`stair_export_text_golden.json`·`stair_stop_line_golden.json`)을 **수정하지 않고** 통과해야 한다. 골든 갱신 환경변수(`REPORT_WHOLE_GOLDEN_UPDATE`·`STAIR_GOLDEN_UPDATE`)를 쓰지 말 것.
- 범위: `crates/controller/src/report.rs`·`crates/controller/src/stair.rs`·새 통합 테스트 파일·`crates/controller/CLAUDE.md` 한 줄. 와이어·DB·UI·`sample.rs` 계산 함수는 바꾸지 않는다.
- 생성 시간 단축(초별 합치기 `merge_into` → `iter_recorded` 등)은 **이 슬라이스 밖** — 하지 말 것.
- 정렬은 반드시 **안정 정렬**(`slice::sort_by`/`sort_by_key`, `sort_unstable*` 금지) — 같은 칸 안의 행 순서 = 입력 순서여야 지금 `BTreeMap` 칸과 같다.
- 정렬 키 비교는 지금 칸 키 `(i64, String)`의 순서와 같아야 한다: `(r.ts_second, r.step_id.as_str())`의 튜플 비교.
- clippy `-D warnings` 통과(2-arm `match … _ => {}` 대신 `if let`).
- 커밋은 단일 FOREGROUND 호출(timeout 600000ms), `| tail` 파이프·`--no-verify` 금지, 커밋 전 `git diff --cached --name-only`.

## Review Focus

1. **정렬되지 않은 행**(테스트·미래 호출자): 같은 칸이 두 창으로 쪼개지면 오류 없이 숫자만 틀린다 → Task 1 `same_report_for_any_row_order`(되돌려 확인: 정렬 제거 → RED).
2. **깨진 행 하나뿐인 칸**: 지금처럼 건수는 있고 값이 0인 창이 나와야 한다 → Task 1 `one_window_per_cell_in_key_order`.
3. **빼기 실패 칸**(`passed_by_rows` 행 단위 재계산): 스트리밍에서도 같은 값 → Task 1 픽스처에 `inconsistent` 행 포함, 표본 셋 모두 비교.
4. **유지 구간(범위 있음) 리포트**: 범위 밖 창도 그래프용으로 나오고, `scoped_windows`(점유 창을 `partition_point`로 자름)·인사이트 시점 옮기기가 같은 값 → Task 1 범위 있음 변형.
5. **계단: 도착을 만들지 않은 워커**의 메트릭 행이 초 계수·분포에 섞이지 않는다, **시작 시각이 다른 워커 둘**의 offset이 엇갈려도 p99가 같다 → Task 2 두 테스트.

---

### Task 1: `build_report` — 칸을 다 모으면 바로 계산하고 버리기

**Files:**
- Modify: `crates/controller/src/report.rs` — `build_report` 안 989–1175(창 누적·점유 창·보여 주는 창·초별 합계), 테스트 모듈에 `mod stream_windows` 추가, `report_build_timing`(4835–4872) 주석·출력.
- Modify: `crates/controller/CLAUDE.md` — 「`build_report`는 창마다 풀어 둔 분포(창당 ≈300 KB)를 끝까지 들고 있다 …」 줄.

**Interfaces:**
- Consumes: 지금 `build_report` 시그니처(그대로), `SplitHist::{add, resolve}`, `window_of`/`second_of` 계산(지금 클로저와 같은 계산).
- Produces: 시그니처·출력 변화 없음. Task 3이 `build_report`를 통합 테스트에서 부른다(이미 `pub`).

- [ ] **Step 1: 동등성 가드 테스트 작성** — `report.rs` 테스트 모듈 끝에 `mod stream_windows { use super::*; use crate::sample::Sample; … }`.

  픽스처(모든 행이 `failed_hdr_histogram: Some(..)` = 나눌 수 있는 run):
  - `fn row(ts: i64, step: &str, worker: &str, all: &[u64], failed: &[u64]) -> WindowWithHdr` — `count = all.len()`, `error_count = failed.len()`, `status_counts = {"200": all.len().saturating_sub(failed.len()), "500": failed.len()}`(0인 키는 빼도 됨), `hdr_histogram = make_hdr_bytes(all)`, `failed_hdr_histogram = Some(make_hdr_bytes(failed))`.
  - `fn broken(ts, step, worker) -> WindowWithHdr` — `count: 3, error_count: 0, status_counts {"200":3}`, `hdr_histogram: vec![0xde, 0xad, 0xbe, 0xef]`, `failed_hdr_histogram: Some(make_hdr_bytes(&[]))`.
  - `fn mixed_rows() -> Vec<WindowWithHdr>` — **SQL 순서**(ts, step 바이트 순, worker)로:
    1. `row(100, "B", "w-0", &[30_000; 2], &[])`
    2. `row(100, "a", "w-0", &[10_000, 10_000, 10_000, 10_000, 50_000], &[50_000])`
    3. `row(100, "a", "w-1", &[20_000; 3], &[])`
    4. `row(100, "é", "w-0", &[5_000; 2], &[])`
    5. `row(101, "B", "w-0", &[40_000, 40_000], &[2_000, 2_000, 2_000])` ← 실패 분포가 전체에 없음(빼기 실패 → `passed_by_rows`)
    6. `row(101, "B", "w-1", &[40_000; 2], &[])`
    7. `broken(101, "a", "w-0")` ← 그 칸의 유일한 행
    8. `row(103, "a", "w-0", &[15_000; 2], &[])` ← 102초 비어 있음
  - `fn reorder(rows: Vec<WindowWithHdr>, idx: &[usize]) -> Vec<WindowWithHdr>` — `idx` 순서로 옮긴다(`WindowWithHdr`는 `Clone`이 아니다 — `Vec<Option<_>>`에서 `take`).
  - `fn build(run: &RunRow, rows: &[WindowWithHdr], scope: Option<&SteadyScope<'_>>, sample: Option<Sample>) -> ReportJson` — 보조 입력은 전부 빈 값(`report_with_run`과 같고 `scope`만 넘김).
  - run: `run_row()`에 `started_at: Some(100_000)`, `ended_at: Some(104_000)`.

  테스트:
  ```rust
  #[test]
  fn same_report_for_any_row_order() {
      // 순서 셋: 역순 [7,6,5,4,3,2,1,0], 워커 우선 [0,1,3,4,6,7,2,5], 섞음 [4,0,7,2,6,1,5,3]
      // 표본 넷: None, Some(Passed), Some(Failed), Some(All)
      // 범위 둘: None, Some(closed_scope(&whole, 101, 104, 0)) — whole = build(&run, &mixed_rows(), None, None)
      // 각 조합에서 serde_json::to_value(build(정렬된 mixed_rows())) == serde_json::to_value(build(reorder(..)))
  }

  #[test]
  fn one_window_per_cell_in_key_order() {
      let rep = build(&run, &reorder(mixed_rows(), &[7,6,5,4,3,2,1,0]), None, None);
      let keys: Vec<(i64, &str)> = rep.windows.iter().map(|w| (w.ts_second, w.step_id.as_str())).collect();
      assert_eq!(keys, vec![(100,"B"),(100,"a"),(100,"é"),(101,"B"),(101,"a"),(103,"a")]);
      let a100 = &rep.windows[1];
      assert_eq!((a100.count, a100.n), (8, 7));            // 통과 표본 = w-0의 10ms×4 + w-1의 20ms×3
      let broken = &rep.windows[4];
      assert_eq!((broken.count, broken.p50_ms, broken.p95_ms, broken.p99_ms, broken.n, broken.mean_us), (3, 0, 0, 0, 0, None));
      let secs: Vec<i64> = rep.latency_by_second.iter().map(|s| s.ts_second).collect();
      assert_eq!(secs, vec![100, 101, 103]);
  }

  #[test]
  fn no_rows_no_windows() {
      let rep = build(&run, &[], None, None);
      assert!(rep.windows.is_empty() && rep.latency_by_second.is_empty());
  }

  #[test]
  fn single_row_one_window() {
      let rep = build(&run, &[row(100, "a", "w-0", &[10_000], &[])], None, None);
      assert_eq!(rep.windows.len(), 1);
      let secs: Vec<i64> = rep.latency_by_second.iter().map(|s| s.ts_second).collect();
      assert_eq!(secs, vec![100]);
  }
  ```
  (필드 타입이 위와 다르면 — 예: `count`가 `u64` — 리터럴 타입만 맞춘다. 값은 그대로.)

- [ ] **Step 2: base에서 통과 확인** — 이 테스트들은 리팩터 가드라 지금 코드에서도 GREEN이어야 한다.
  Run: `cargo nextest run -p handicap-controller -E 'test(stream_windows)'`
  Expected: 4 passed. 실패하면 STOP — 픽스처 가정(예: (101,"B")의 통과 표본)이 틀린 것이니 지금 코드의 실제 값을 읽고 단언을 고친 뒤 보고서에 적는다(지금 코드가 정답).

- [ ] **Step 3: `build_report` 재구성** (spec §3.1)
  - 행 루프 앞에서 `let mut order: Vec<&WindowWithHdr> = rows.iter().collect(); order.sort_by(|a, b| (a.ts_second, a.step_id.as_str()).cmp(&(b.ts_second, b.step_id.as_str())));`
  - 1018의 `for r in rows`를 `for r in order`로. 창 외 누적(워커·전체·스텝·건수·상태 코드·`counted`)은 손대지 않는다.
  - `window_acc` `BTreeMap`을 없애고 「현재 칸」 `Option<((i64, String), WindowAcc)>` 하나로. 키가 바뀌면 직전 칸을 마무리 싱크에 넘긴다.
  - 마무리 싱크: 함수 안 지역 struct(예 `WindowSink`)에 `selected: Sample`, `windows: Vec<ReportWindow>`, `occupancy: Option<Vec<ReportWindow>>`(`selected != Sample::All`일 때만 `Some(Vec::new())`), `latency_by_second: Vec<SecondLatency>`, `sec_hist`, `cur_sec`를 두고 `fn push(&mut self, ts: i64, step: String, acc: WindowAcc<'_>)`가 지금 1119–1131(점유 창: `acc.status.clone()`, `resolve(Sample::All)`, `latency_stats=false`)과 1149–1170(초가 바뀌면 `second_of`로 내보내고 `sec_hist.reset()`; 보여 주는 창: `std::mem::take(&mut acc.status)`, `resolve(selected)`, 분포가 있으면 `merge_into(&mut sec_hist, h)`, `latency_stats=true`)을 그 순서대로 한다. 루프 뒤 남은 칸을 `push`하고, 마지막 초를 `second_of`로 내보낸다(지금 1172–1174).
  - `window_of`·`second_of`는 지금 클로저 본문 그대로(캡처가 없으면 지역 `fn`으로 옮겨도 됨).
  - 1175 `let occupancy: &[ReportWindow] = …unwrap_or(&windows)`는 그대로.
  - 지금 주석 중 「`window_acc`를 옮겨 가며 …」처럼 사라진 구조를 설명하는 줄은 새 구조에 맞게 고친다.

- [ ] **Step 4: 통과 확인**
  Run: `cargo nextest run -p handicap-controller` (전체 — 골든·인사이트·계단·export 포함)
  Expected: 전부 PASS, 기존 테스트 수정 0.

- [ ] **Step 5: 되돌려 확인(teeth)** — Step 3의 `order.sort_by(..)` 줄만 주석 처리 → `cargo nextest run -p handicap-controller -E 'test(stream_windows)'` → `same_report_for_any_row_order`가 RED인지 확인 → 원복 → GREEN. 보고서에 RED 출력 한 줄을 남긴다.

- [ ] **Step 6: 측정 테스트·노트 정리**
  - `report_build_timing`의 doc 주석에서 「기본값이 600초인 까닭: 창마다 풀어 둔 분포가 메모리에 남아 …」 문장을 지우고(이제 거짓), 기본 600초는 「디버그 실행 시간」 이유로 적는다. 출력에 행 원본 크기 한 줄을 더한다: `eprintln!("ROWS bytes {}", rows.iter().map(|r| r.hdr_histogram.len() + r.failed_hdr_histogram.as_ref().map_or(0, Vec::len)).sum::<usize>())`.
  - `crates/controller/CLAUDE.md` 「`build_report`는 창마다 풀어 둔 분포(창당 ≈300 KB)를 끝까지 들고 있다 …」 줄을 바꾼다: 「`build_report`는 행을 (ts, step)으로 안정 정렬해 한 칸씩 마무리하고 분포를 버린다(report-memory) — 창 분포를 칸 끝 너머로 들고 가는 구조(맵·벡터에 쌓기)를 다시 만들지 말 것, 메모리가 초 × 스텝에 비례해 1시간 × 스텝 10 ≈ 11 GB였다. `tests/report_memory_test.rs`가 잡는다. 초별 합계는 칸 마무리에서 같은 분포를 쓴다. 점유 창은 `n`·`mean_us`·`capped`를 계산하지 않는다(읽는 곳 없음 — 새 소비처가 읽으면 `latency_stats`를 참으로).」

- [ ] **Step 7: 커밋**
  `git add crates/controller/src/report.rs crates/controller/CLAUDE.md` → `git diff --cached --name-only` → `git commit -m "perf(controller): 리포트 창을 한 칸씩 마무리하고 분포를 버리기 — 메모리가 run 길이에 비례하지 않게"`(foreground, 600000ms) → `git log -1 --oneline`.

---

### Task 2: 계단 리포트 — 초마다 p99만 남기기

**Files:**
- Modify: `crates/controller/src/stair.rs` — `SecAcc`(843–849), `build_stair_report`의 951–968 루프, 1078–1088.
- Test: `crates/controller/src/report.rs` 테스트 모듈 `mod stair_report` 안(기존 `Fx`·`scfg`·`sec`·`start`·`ol`·`mrow` 재사용).

**Interfaces:**
- Consumes: `WorkerView { id, t0_ms, metrics, open_loop }`(903–948이 만든 활동 워커만), `window_hist_per_window`, `StairAccumulator::{push_open_loop, push_metric}`, `q`.
- Produces: `SecAcc.hist: Option<Histogram<u64>>` → `p99_us: u64`(기본 0). 시그니처·출력 변화 없음. Task 3이 `build_stair_report`(`pub`)를 부른다.

- [ ] **Step 1: 가드 테스트 작성** — `mod stair_report` 안에:
  ```rust
  #[test]
  fn seconds_same_for_any_row_order_and_offsets_merge_across_workers() {
      let c = scfg(&[10, 20], 1, 9, 1);
      let mut fx = Fx::default();
      // 느린 워커가 w-a(먼저 훑힘), 빠른 워커가 w-b(나중) — 정렬이 없으면 offset마다 w-b만의
      // 분포가 마지막에 p99를 덮어쓴다. 표본 15개의 p99는 최댓값이라, 마지막 워커가 최댓값을
      // 가지면 덮어써도 값이 같아 되돌려 확인이 RED가 안 된다.
      fx.fill("w-a", 1000, 20, |_| Some(sec(5, 30_000)));
      fx.fill("w-b", 1001, 20, |_| Some(sec(10, 10_000)));   // 1초 늦게 시작 → 같은 ts가 다른 offset
      fx.inp.starts = vec![start("w-a", T0), start("w-b", T0 + 1000)];
      let sorted = fx.report(&c);
      fx.rows.reverse();
      assert_eq!(fx.report(&c), sorted);
      let s0 = &sorted.seconds[0];
      assert_eq!(s0.offset_s, 0);
      assert_eq!(s0.count, 15);
      assert_eq!(s0.p99_us, hist(&[(30_000, 5), (10_000, 10)]).value_at_quantile(0.99));
  }

  #[test]
  fn seconds_ignore_worker_that_never_scheduled() {
      let c = scfg(&[10, 20], 1, 9, 1);
      let mut base = Fx::default();
      base.fill("w-a", 1000, 20, |_| Some(sec(10, 10_000)));
      base.inp.starts = vec![start("w-a", T0)];
      let want = base.report(&c);
      // w-c: open-loop 행은 있지만 launched = dropped = 0(도착을 만들지 않음), 메트릭 행은 있음
      for o in 0..20 {
          base.inp.open_loop.push(ol("w-c", 1000 + o, 0, 0, 0));
          base.rows.push(mrow("w-c", 1000 + o, "s", 7, 0, &[(90_000, 7)]));
      }
      assert_eq!(base.report(&c), want);
  }
  ```
  (`StairSecond`의 `count`·`offset_s` 타입이 다르면 리터럴만 맞춘다. 필요하면 `StairSecond`를 `use`에 더한다.)

- [ ] **Step 2: base에서 통과 확인**
  Run: `cargo nextest run -p handicap-controller -E 'test(stair_report::)'`
  Expected: 전부 PASS(새 둘 포함). 실패하면 STOP — 지금 코드가 정답이니 픽스처 가정을 실제 값으로 고치고 보고.

- [ ] **Step 3: 구현** (spec §3.2)
  - `SecAcc.hist` → `p99_us: u64`.
  - 951 루프를 둘로: ① `for w in &workers`에서 open-loop 행만 지금처럼(`secs` 계수 + `acc.push_open_loop`). ② `workers`의 메트릭 행을 `(offset = r.ts_second.saturating_sub(w.t0_ms.div_euclid(1000)), w.id, r)`로 모아 `sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)))`(안정). 그 순서로 행마다 `window_hist_per_window` 한 번 → `secs.entry(offset).or_default()`에 `add(&mut s.count, r.count)` → 분포가 있으면 현재 offset 임시 분포에 `merge_opt` → `acc.push_metric(w.id, r.ts_second, r.count, r.error_count, h.as_ref())`. offset이 바뀌면 직전 offset의 `secs` 항목에 `p99_us = q(&임시, 0.99)`를 쓰고 임시를 비운다. 루프 뒤 마지막 offset도.
  - **입력 `rows` 전체를 정렬하지 말 것** — `workers`(활동 워커)의 `metrics`만(spec §3.2).
  - 1086의 `p99_us: q(&s.hist, 0.99)` → `p99_us: s.p99_us`.

- [ ] **Step 4: 통과 확인**
  Run: `cargo nextest run -p handicap-controller`
  Expected: 전부 PASS(계단 감시 `stair_monitor` 테스트·누적기 비트 동일성 테스트 포함), 기존 테스트 수정 0.

- [ ] **Step 5: 되돌려 확인(teeth) 둘**
  - ② 정렬 줄을 주석 처리 → `seconds_same_for_any_row_order_and_offsets_merge_across_workers` RED 확인 → 원복.
  - ②의 행 출처를 `workers`의 메트릭 대신 입력 `rows` 전체로 바꿔(워커 t0는 `workers`에서 찾고 없으면 건너뛰지 말고 `t0_s = r.ts_second`의 첫 값 등 아무 값) → `seconds_ignore_worker_that_never_scheduled` RED 확인 → 원복.
  - 둘 다 원복 후 GREEN. RED 출력 한 줄씩 보고서에.

- [ ] **Step 6: 커밋**
  `git add crates/controller/src/stair.rs crates/controller/src/report.rs` → `git diff --cached --name-only` → `git commit -m "perf(controller): 계단 리포트 초별 분포를 초마다 p99로 바꾸고 버리기"`(foreground) → `git log -1 --oneline`.

---

### Task 3: 메모리 회귀 테스트

**Files:**
- Create: `crates/controller/tests/report_memory_test.rs`

**Interfaces:**
- Consumes: `handicap_controller::report::build_report`, `handicap_controller::stair::{build_stair_report, expand_stair, StairConfig, StairInputs}`, `handicap_controller::store::metrics::WindowWithHdr`, `handicap_controller::store::open_loop::{OpenLoopSecondRow, WorkerStartRow}`, `handicap_controller::store::runs::{RunRow, Profile, RunStatus, STATUS_RULE_LEGACY, LATENCY_RULE_LEGACY}`, `hdrhistogram::{Histogram, serialization::{Serializer, V2Serializer}}`. 경로가 다르면 `grep -n "pub struct\|pub fn\|pub mod"`로 찾아 맞춘다.
- Produces: 없음.

- [ ] **Step 1: 테스트 작성** — 파일 하나에 `#[test]` **하나**(spec §4.2: 전역 최대치를 공유하므로).
  - 전역 할당기: `System`을 감싸 `CUR: AtomicUsize`(alloc +size, dealloc −size, realloc ±차이; `alloc_zeroed`를 덮어쓰면 그것도 +size — 덮어쓰지 않으면 기본 구현이 `self.alloc`을 불러 세어진다)와 `PEAK: AtomicUsize`(`fetch_max(CUR)`)를 유지. `fn measure<T>(f: impl FnOnce() -> T) -> usize`: `let base = CUR.load(); PEAK.store(base); let out = f(); let peak = PEAK.load(); drop(out); peak - base`.
  - 입력 만들기(측정 밖에서): `fn hdr(samples: &[u64]) -> Vec<u8>`(고정 범위 1..60_000_000·유효 숫자 3 분포에 기록 후 `V2Serializer`). `fn report_rows(secs: i64) -> Vec<WindowWithHdr>` — `report_build_timing`(report.rs 4846–4857)과 같은 모양: 초 × 스텝 10(`s00`..`s09`), 행마다 표본 100개(값 `1_000 + (i * 997 + s * 31 + ts * 7) % 90_000`), `failed_hdr_histogram: Some(hdr(&samples[..5]))`, `count 100, error_count 5, status_counts {"200":100}`, `worker_id "w-0"`. `fn run_row() -> RunRow` — report.rs 테스트 `run_row()`(1833–1876)와 같은 필드 값.
  - 계단 입력: `StairConfig { targets: vec![10, 20, 30], ramp_seconds: 10, hold_seconds: 190, discard_seconds: 10, p99_cap_ms: None, auto_stop: None }`, 프로필 = `run_row().profile`에 `duration_seconds 0, max_in_flight Some(50), stages Some(expand_stair(&c)), stair Some(c)`. 워커 `w-a`(t0 = 1_000_000 ms)·`w-b`(t0 = 1_001_000 ms), 각자 `secs`초 동안 초마다 open-loop 행(launched = completed = 10, dropped 0)과 메트릭 행(스텝 "s", count 10, 표본 10개 `10_000 + (ts * 13 + k * 101) % 50_000`, failed `None`). `StairInputs { open_loop, starts: [w-a, w-b], auto_stop: None }`.
  - 측정·단언:
    ```rust
    let (r1, r2) = (report_rows(N_R), report_rows(2 * N_R));
    let p1 = measure(|| build_report(&run, yaml, &r1, /* 빈 보조 입력 */ …, None, None, None));
    let p2 = measure(|| build_report(&run, yaml, &r2, …));
    eprintln!("REPORT peak N={N_R}: {p1} B, 2N: {p2} B");
    assert!(p2 <= REPORT_ABS && p2.saturating_sub(p1) <= REPORT_GROWTH, …);
    // 계단도 같은 모양: S1 = stair(N_S), S2 = stair(2*N_S), build_stair_report(&profile, 0, &rows, &inp)
    ```
  - 상수(**구현 중 실측 확정**): 잠정 `N_R = 60`, `REPORT_ABS = 64 MiB`, `REPORT_GROWTH = 16 MiB`, `N_S = 300`, `STAIR_ABS = 32 MiB`, `STAIR_GROWTH = 8 MiB`. 확정 조건: (a) 수정 후 측정값이 각 상한의 1/2 이하 (b) Step 3의 수정 전 측정값이 두 단언(절대·증가) 모두를 깬다. 둘 중 하나라도 안 맞으면 STOP — 측정값을 보고하고 orchestrator가 상한을 정한다. 디버그 실행이 10초를 넘으면 N을 줄인다(조건 (b)를 유지하는 선에서).

- [ ] **Step 2: 통과 확인**
  Run: `cargo nextest run -p handicap-controller --test report_memory_test --no-capture`
  Expected: PASS, `REPORT peak …`·`STAIR peak …` 출력. 보고서에 네 숫자.

- [ ] **Step 3: 되돌려 확인(teeth) 둘** — 커밋된 코드는 건드리지 않고 작업 트리에서만. 옛 판은 **base 커밋 `ac05b231`** 에서 가져온다(리뷰 수정 커밋이 끼어 상대 참조 `HEAD~n`은 어긋날 수 있다; Task 1은 `stair.rs`를 안 바꾸므로 base 판 = Task 2 전 판). `git checkout`·`git stash`는 쓰지 않는다(워크트리 규칙) — 파일을 덮어쓰고 덮어써서 원복한다. 서로 다른 판끼리 컴파일된다(`report.rs`는 `stair`의 공개 API만 쓰고, `--test`는 라이브러리를 `cfg(test)` 없이 빌드해 판마다 다른 인라인 테스트를 컴파일하지 않는다).
  - `git show ac05b231:crates/controller/src/report.rs > crates/controller/src/report.rs` → Step 2 명령 → `REPORT` 단언 RED, 측정값 기록 → `git show HEAD:crates/controller/src/report.rs > crates/controller/src/report.rs`로 원복.
  - `git show ac05b231:crates/controller/src/stair.rs > crates/controller/src/stair.rs` → Step 2 명령 → `STAIR` 단언 RED, 측정값 기록 → `git show HEAD:crates/controller/src/stair.rs > crates/controller/src/stair.rs`로 원복.
  - 원복 후 `git status --short`가 새 테스트 파일만 보이는지 확인, 다시 PASS.
  - 보고서: 수정 전 네 숫자(=확정 조건 (b) 근거).

- [ ] **Step 4: 커밋**
  `git add crates/controller/tests/report_memory_test.rs` → `git diff --cached --name-only` → `git commit -m "test(controller): 리포트·계단 리포트 생성 메모리가 run 길이에 비례하지 않음을 잡는 회귀 테스트"`(foreground) → `git log -1 --oneline`.

---

## 구현 뒤 검증 (orchestrator — 서브에이전트 task 아님)

최종 리뷰(`handicap-reviewer`) 뒤, `/live-verify` 단계에서 한다. 결과는 build-log·roadmap §B에.

### V1. 메모리·시간 실측 (spec §4.3, US1 통과 조건)

- base 판: `git worktree add --detach /private/tmp/claude-501/report-memory-base ac05b231`, `CARGO_TARGET_DIR=/private/tmp/claude-501/report-memory-base-target`(절대경로).
- 각 판에서 테스트 바이너리를 먼저 빌드(`cargo test -p handicap-controller --lib --no-run`, 출력의 바이너리 경로)하고, 바이너리를 직접 `/usr/bin/time -l <bin> report_build_timing --ignored --nocapture`로 실행(cargo·rustc 메모리가 섞이지 않게). `REPORT_TIMING_SECONDS` = base 600·1200, 새 판 600·1200·3600.
- 기록: 「maximum resident set size」, `TIMING … median`, `ROWS bytes`(새 판만 출력).
- 통과: 새 판 3600초 최대 RSS ≤ 512 MB. 600·1200·3600의 RSS 차이가 행 원본 크기 차이 수준.
- 릴리즈 시간: 같은 방식으로 `--release`, 600초 중앙값 base 대비. +5% 초과면 원인 확인 후 사용자 보고(머지 차단 아님).

### V2. 두 바이너리 비교 (spec §4.4, US2·US3)

- 바이너리: base 워크트리에서 `cargo build -p handicap-controller --bin controller -p handicap-worker`(위 `CARGO_TARGET_DIR`), 이 브랜치 `./target/debug/{controller,worker}`.
- run 만들기(**base 바이너리 하나**로, `/live-verify` 스택): ① 스텝 3개 + 일부 500(통과/실패 나뉨) ② `worker_capacity_vus`를 낮춰 부하기 2개 fan-out ③ `steady` 있는 run ④ 계단 시험 `worker_count: 2`(open-loop 부하기 2개 — `run_worker_starts` 두 행의 `started_at_ms.div_euclid(1000)`(초)이 달라야 offset 정렬이 실제로 다른 `ts_second`를 합친다. 같으면 run을 다시 만들고, 그래도 같으면 그 사실을 기록) ⑤ 판정 기준 있는 run. 같은 시나리오에 둘 이상(비교 내보내기용).
- 컨트롤러 정지 → `-wal`·`-shm`이 있으면 함께 복사하거나 `sqlite3 <db> "PRAGMA wal_checkpoint(TRUNCATE)"` 후 복사 → 두 벌의 `SELECT COUNT(*) FROM run_metrics`가 정지 전 값과 같은지.
- 두 바이너리를 각자의 복사본에 다른 포트로(`--rest`·`--grpc`, `lsof`로 빈 포트 확인) 띄우고, 비교 스크립트(Write 도구로 스크래치패드에, `python3 -I`)가 run마다: `/api/runs/{id}/report?sample=passed|failed|all&basis=whole|steady`, `report.csv`·`report-insights.csv`·`report.xlsx`(`?basis=` 둘), 계단 run `report-stairs.csv`, 시나리오 `compare.csv`·`compare-insights.csv`·`compare.xlsx`(run_ids 둘 이상)를 두 쪽에서 받아 바이트 비교. XLSX는 zip을 풀어 `docProps/core.xml`을 뺀 모든 부분을 비교.
- 통과: 차이 0건. phases·groups 크기(spec §4.3 둘째 불릿)는 같은 DB에서 `SELECT COUNT(*), SUM(LENGTH(hdr_histogram)) FROM run_phase_metrics`(·`run_group_metrics`) ÷ run 초 수 × 3600으로 환산해 기록.

REVIEW-GATE: APPROVED

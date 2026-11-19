# 포화 진단 — 대상 간헐 멈춤을 슬롯 부족과 구별 (설계)

- 날짜: 2026-11-20 · 유형: correctness-bug + user-path · roadmap §B57 (1) 넷째 항목
- 슬러그: `stall-saturation` · 선행: ADR-0046(사이징 교정 — cause 2-way), stage-saturation-table(migration 0024 — 초 단위 시작·완료·버림 계수)
- 범위 결정(사용자 2026-11-20): 진단 근거는 **워커가 이미 보내는 초 단위 계수**(접근 2 — 리틀의 법칙 평균·요청 지연 대용치는 기각, §4.1). 리포트 문구는 **새 원인 「대상 간헐 멈춤」**(슬롯 권장 숫자 없음, B′ 보조 숫자 기각). 평소 슬롯 사용량과 버림이 몰린 정도를 **둘 다** 보여 준다. 초 단위 계수가 없는 옛 run은 지금 그대로.

## 사용자 스토리 (US)

(사용자 승인 2026-11-20)

- **US1**: QA가 대상이 가끔 1초쯤 멈춰 버림이 생긴 open-loop run의 리포트를 연다. 성공하면 「대상 간헐 멈춤」 진단을 보고, 평소 쓰인 슬롯 수(설정 대비)와 버림이 몰린 초 수가 숫자로 나오며, 「슬롯을 2507로 늘리세요」 같은 슬롯 권장 숫자는 보이지 않는다.
- **US2**: QA가 그 run의 시나리오로 「다시 실행」 창을 연다. 성공하면 슬롯 칸 도우미가 권장 숫자도 「적용」 버튼도 내지 않는다. 대신 「직전 run은 대상 응답이 가끔 멈춘 run — 슬롯을 줄이지 말고 대상 멈춤부터 확인」 안내를 보여 준다. 슬롯 칸 값은 사용자가 넣은 그대로다.

(spec 리뷰 뒤 정밀화 2026-11-20: US2의 처음 문구 「엉뚱한 권장값을 만들지 않는다(설정값 그대로 두거나, 시나리오 걷기 추정으로 내려간다)」는 걷기 추정이 「~14로 설정하세요 + 적용」을 내는 해로운 결과까지 통과시켰다. 걷기·추정 입력·측정은 모두 응답 시간에서 점유시간을 얻으므로, 멈춤 run 뒤에는 어느 것도 멈춤 동안을 감당하는 값을 낼 수 없다.)
- **US3**: QA가 슬롯이 정말 모자라 꾸준히 버린 고정 목표 run을 연다. 성공하면 지금처럼 「슬롯 부족」 진단과 권장 슬롯 수를 본다(인사이트 JSON 바이트 동일).
- **US4**: QA가 계단·곡선 run에서 높은 구간에서만 꾸준히 슬롯이 모자랐던 run을 연다. 성공하면 「대상 간헐 멈춤」이 아니라 「슬롯 부족」으로 진단된다.
- **US5**: QA가 초 단위 계수가 없는 옛 run(2026-11-18 migration 0024 이전)을 연다. 성공하면 진단이 지금과 같다(인사이트 JSON 바이트 동일).

**재현 / 기대 / 실측** (§B57, redis-large-list-bench `jsonget-extra-20261114/Z{1,2,3}p90-*`)
- 재현: M(`max_in_flight`)=2500, 목표 6000–7000/s, 60초. 초별 p95가 평소 2 ms, 멈춘 초 300–1600 ms가 14–22개 초. 버림 0.07–1.6%.
- 기대: 대상 멈춤 진단, 슬롯 증설 권장 없음.
- 실측: `cause=slots`, `recommended` 2502–2541(「2500에서 조금 더 올려라」).

## 1. 왜

`load_gen_saturated`는 `dropped>0`이면 먼저 `sut_stress`(5xx≥1% 또는 뒤 1/3 p95 ≥ 앞 1/3의 1.5배)를 보고, 아니면 `cause=slots` + `recommended = ceil(목표 × M ÷ 달성)`을 낸다(`insights.rs` `if dropped > 0` 블록). 이 공식은 「포화 중엔 슬롯 M개가 늘 차 있다」는 항등식(ADR-0046)에 기댄다. 대상이 가끔 멈추면 평소엔 슬롯이 거의 비어 있고 멈춘 초에만 꽉 찬다. 그러니 버림이 0.1–1%면 권고는 언제나 「M보다 조금 더」가 되고, 실제로는 무의미하다. `sut_stress`의 두 조건도 이 경우를 못 잡는다. 멈춤은 5xx를 내지 않고, 앞뒤 1/3 중앙값은 평소 값이라 지연 상승도 안 보인다. QA는 슬롯을 7개 늘려 다시 돌리고 같은 결과를 본다. 정작 봐야 할 대상의 멈춤은 진단에 나오지 않는다.

## 2. 목표 / 비목표 / 반목표

**목표**
- 초 단위 계수가 있는 open-loop run에서 「첫 버림 뒤, 버림이 생긴 초와 같은 도착률인데 버림이 없던 초들」의 사용 슬롯이 설정의 절반 이하이면 `cause=stall`로 진단한다.
- stall 인사이트에 평소 사용 슬롯·설정 슬롯·버림이 생긴 초 수·도착이 예정된 초 수를 싣고, 화면이 이 숫자로 제목과 안내를 쓴다. `recommended`는 비운다.
- 내보내기(CSV·XLSX의 인사이트 표)에도 새 값이 열로 나간다. 인사이트 열은 `Insight` 필드에서 단일 목록으로 파생되므로 화면과 내보내기가 같은 값을 보인다(ADR-0030 화면↔export 일치).
- 직전 run이 stall이면 RunDialog 슬롯 도우미가 권장 숫자·적용 버튼 대신 안내를 보인다(US2).
- ADR-0046에 「cause 3-way(slots/sut/stall)」 덧붙임 절을 단다(같은 결정의 확장이라 새 ADR 대신). `Insight.cause` doc comment와 `crates/controller/CLAUDE.md`의 낡은 cause 집합 서술(`{slots, loadgen, sut}`)도 slots/sut/stall로 갱신한다.

**비목표**
- `sut_stress` 규칙·`slots` 공식 변경(US3).
- 옛 run의 대체 진단(리틀의 법칙 평균 등 — 사용자 결정, §4.1).
- 계단 결과 표(`stair.rs`)의 판정·문구 변경. 계단 run도 같은 인사이트 규칙을 타지만 계단 표는 자기 규칙 그대로다.
- 엔진·워커·proto·마이그레이션 변경(데이터는 이미 있다 — §3).
- 멈춘 시각 목록·멈춤 길이 같은 추가 숫자(B′ 기각 — 「대상을 먼저 보라」 메시지를 흐림).
- Run 비교 화면(`InsightCompareMatrix`, kind별 행)에 cause 표시 추가 — 지금도 slots/sut를 구분하지 않으므로 그대로 둔다.

**반목표 (돌아가도 실패)**
- stall이 아닌 run(슬롯 부족·sut·초 단위 계수 없음·버림 없음)의 리포트 JSON이 바이트 하나라도 달라진다. 단 내보내기 인사이트 표는 열이 늘어 헤더가 바뀐다(§4.5, 의도).
- 계단·곡선의 높은 구간 꾸준한 부족을 stall로 오진한다(US4).
- 슬롯 칸 도우미가 stall run 뒤에 어떤 근거로든 권장 숫자를 낸다(US2). 「M ÷ 달성」은 그 항등식이 깨진 경우라서 stall을 진단한 것이고, 응답 시간 기반 근거는 평소 지연만 보고 지금 M보다 훨씬 작은 값을 낸다(재현 사례: ~14).
- 리포트 조회 비용이 버림 없는 run에서 늘어난다(이번 변경의 추가 질의는 `dropped > 0`인 open-loop run에서만 — §4.4).

## 3. 지금 구조 (확인한 사실)

명령은 §8 claims-ledger에 모았다.

- **초 단위 계수는 모든 open-loop run에 기록된다.** 엔진 `run_scenario_open_loop`가 고정 목표·곡선 공통으로 `OpenLoopCounters`를 만든다(`runner.rs` `let counters = …OpenLoopCounters::new`). 스케줄러가 도착을 **시도한 시각**(벽시계 초, `record()` → `current_second()`)에 슬롯을 잡으면 `Launched`, 슬롯이 없어 버리면 `Dropped`를 센다. 도착 태스크는 반복이 끝나면(성공·실패·엔진 오류·취소 무관) `Completed`를 센다(`runner.rs` `record(CountKind::…)` 세 곳, `run_arrival` 끝 「결과와 무관하게 끝난 반복으로 센다」). **예외 두 가지**: unique 데이터셋이 소진된 도착은 `Launched` 뒤 `Completed` 전에 반환하고(`run_arrival`의 `exhausted.store(true, …); return Ok(())`), 도착 태스크가 panic해도 `Completed`가 빠진다. 소진되면 스케줄러가 새 도착을 멈추므로 그 뒤 초는 도착 시도가 0이다. 워커는 계단 여부와 무관하게 `MetricBatch.open_loop_seconds`(proto 필드 12)로 보낸다(`worker/src/lib.rs`). 컨트롤러 `ingest`도 조건 없이 `run_open_loop_seconds`(migration 0024, PK `run_id, worker_id, ts_second`, keep-first)에 넣는다(`coordinator.rs` `if !batch.open_loop_seconds.is_empty()`).
- 카운터는 스케줄 t=0이 속한 초부터 빈 초를 0행으로 채운다(`open_loop_counters.rs` `start_second`·`MAX_ZERO_FILL_SPAN` 3600). 스케줄이 끝난 뒤(`end_s`) 빈 초는 채우지 않는다.
- **리포트는 지금 계단 run에서만 이 행을 읽는다.** `api/runs.rs` `build_report_for_run`의 `let stair_inputs = if row.profile.stair.is_some() { … open_loop_seconds(db, run_id) … }`. 프로덕션의 `build_report` 호출은 이곳 하나다. 그 외 호출은 `report.rs` 테스트다.
- `derive_insights`(`insights.rs`)는 `#[allow(clippy::too_many_arguments)]`로 11개 인자를 받는다. 포화 블록은 `target_rps`(곡선이면 최고 계단 목표)·`max_in_flight`·`scheduled_arrivals`가 모두 `Some`일 때만 cause를 정한다. `None`이면 cause 없는 인사이트를 낸다.
- `Insight`는 모든 선택 필드가 `skip_serializing_if = "Option::is_none"`이다. 그래서 stall일 때만 채우는 새 필드는 다른 run의 JSON을 바꾸지 않는다.
- 내보내기 인사이트 표는 `export.rs` `INSIGHT_COLUMNS: [&str; 17]` + `insight_csv_cells`·`write_insight_xlsx_row`에서 4개 표면(단일·비교 × CSV·XLSX)이 파생된다. 헤더 문자열은 `export.rs`에 2곳, `tests/export_routes_test.rs`에 1곳 하드코딩돼 있다(controller CLAUDE.md 리포트 export 항목).
- UI 소비처: `InsightPanel.tsx`의 `message()` 중 `case "load_gen_saturated"`(제목: 「초당 최대 N건까지만 보냈어요(= 이 구성의 지속 가능한 최대 RPS)」 — stall에선 이 문장도 거짓이다. 멈추지 않은 초에는 목표를 다 보냈다)와 `actionFor()`(`cause === "slots"`/`"sut"` 분기, 그 외 일반 문구 `computed:false`). `SlotSizingHelper.tsx`의 `usePriorOpenRunAnchor`는 `sat?.cause === "slots"`일 때만 「M ÷ 달성」을 쓰고, 아니면 시나리오 걷기(`iterationHoldMs`)로 내려간다. `openLoopRates.ts`는 cause와 무관하게 `achieved_per_sec`를 읽는다(요약 카드 달성 도착률). Zod `cause: z.string().optional()`(`schemas.ts`)라 새 값도 통과한다. `InsightSchema`는 `.strict()`가 아닌 `z.object`라 모르는 키는 조용히 버린다. 그래서 새 숫자 필드는 Zod에 추가해야 화면에서 쓸 수 있다(추가 안 해도 파싱은 깨지지 않는다).
- `validity.rs` 5번 `load_not_delivered`는 kind(`load_gen_saturated`)만 보고 cause는 보지 않는다. stall에서도 「목표한 부하를 다 걸지 못했습니다」는 참이라 그대로 둔다.
- `SlotSizingHelper`의 앵커가 `null`이면(지금 stall일 때) 직전 run 걷기(ⓑ, 리포트 스텝 p50)로 내려간다. 걷기도 실패하면 추정 입력·측정(test-run) 칸을 보인다. 셋 다 응답 시간 기반이다(`SlotSizingHelper.tsx` `usePriorOpenRunAnchor`·`holdMs` precedence).
- `Insight { … }` 리터럴(새 필드 추가 시 고칠 곳): `insights.rs` `Insight::new`, `validity.rs` 테스트 헬퍼 전체 리터럴, `export.rs` 테스트 픽스처들(일부는 `..insight()` spread). 그리고 `export.rs` `insight_error_kind_column_round_trips`가 열 수 17과 마지막 열 `error_kind`를 단언한다. 전수 목록은 plan이 `grep -rn "Insight {" crates/controller`로 확정한다.

## 4. 설계

### 4.1 기각한 진단 근거 (사용자와 합의)

- **요청 지연 대용치(목표 × 초별 p50 중앙값 ÷ M):** 벤치 실데이터 196건에서는 깨끗이 갈렸다(멈춤 ≤0.05, 꾸준한 포화 ≥0.124). 하지만 요청 한 건 지연을 반복 점유시간 대신 쓰는 것은 ADR-0046이 고친 오류다. 생각 시간·여러 스텝 시나리오에서는 꾸준한 포화가 멈춤으로 읽힌다. 벤치 데이터는 전부 스텝 하나에 생각 시간이 없어 그 반례가 없었다.
- **리틀의 법칙 run 평균(요청 수 × 평균 지연 ÷ 시간):** 실제 평균이지만 곡선 run에서는 낮은 구간의 빈 시간이 섞여 멈춤으로 오진한다(US4 위반).

### 4.2 초별 시계열 (컨트롤러, 순수 함수)

입력: 초별 합계 `(ts_second, L, C, D)` — 모든 워커의 `launched`·`completed`·`dropped`를 초마다 더한 것(§4.4 질의). 한 워커에 그 초 행이 없으면 그 워커는 그 초에 L=C=D=0이므로, 워커별로 누적해 합치는 것과 초별 합계를 한 번 누적하는 것은 같다.

1. `ts_second` 오름차순으로 누적 `R(s) = Σ_{t≤s} (L(t) − C(t))`(부호 있는 정수, 누적 자체는 자르지 않는다). 그 초 끝의 **사용 중 슬롯** `F(s) = max(0, R(s))` — 0 자르기는 보고·비교 값에만.
2. **그 초에 시도된 도착** `A(s) = L(s) + D(s)`. 스케줄러는 도착을 시도할 때마다 정확히 L 하나 또는 D 하나를 센다(시도 시각 기준이라 스케줄이 밀리면 늦은 초에 몰릴 수 있다 — 판정은 「같은 시도율의 초끼리」 비교이므로 이것으로 충분하다).

`F(s)`는 초 경계에서 찍은 순간값이다. 초 안의 최대치가 아니다. 버림이 없던 초를 여럿 모아 중앙값을 쓰므로 그 초들의 대표 사용량으로 충분하다. unique 소진·panic으로 `Completed`가 빠진 도착은 `R`을 영구히 1씩 올리지만(§3), 소진 뒤에는 도착 시도가 없어 비교 초가 되지 않는다. panic은 드물어 무시한다.

### 4.3 판정 규칙

`sut_stress`가 참이면 지금처럼 `sut`. 그 다음에, 아래가 모두 성립하면 `stall`, 아니면 지금처럼 `slots`.

- (a) 초별 합계가 있고 `Σ D(s) > 0`(없거나 버림이 행에 없으면 옛 경로 — US5).
- (b) 버림 초 `S_d = { s : D(s) > 0 }`, 첫 버림 초 `s₀ = min S_d`, 기준 시도율 `a* = median{ A(s) : s ∈ S_d }`.
- (c) **회복 초** `S_c = { s : s > s₀ ∧ D(s) = 0 ∧ A(s) ≥ TAU_RATE × a* }`, `|S_c| ≥ MIN_COMPARABLE`.
- (d) 평소 사용 슬롯 `f̃ = median{ F(s) : s ∈ S_c }`(f64, 기존 `median()`과 같이 짝수 개면 두 가운데 값의 평균), `f̃ ≤ TAU_IDLE × M`. 보고값 `typical_in_flight = f̃.round()`(0.5는 0에서 먼 쪽 — `f64::round`).

상수: `TAU_RATE = 0.9`, `TAU_IDLE = 0.5`, `MIN_COMPARABLE = 3`(이름 있는 const).

**근거(리틀의 법칙):** 같은 도착률에서 사용 슬롯 = 도착률 × 반복 점유시간이다. 꾸준한 슬롯 부족이라면 버림 초와 비슷한 도착률의 다른 초도 슬롯이 거의 다 차 있다(`F ≈ 0.9M` 이상). 대상이 가끔 멈춘다면 같은 도착률에서 평소엔 슬롯이 거의 비어 있다(재현 사례: 7000/s × 2 ms ≈ 14 ≪ 2500). 두 경우 차이가 한 자릿수 이상이라 기준을 절반에 둔다. 생각 시간·여러 스텝은 점유시간에 이미 들어 있다. `F`가 실측 슬롯 수이므로 ADR-0046의 대용치 오류가 생기지 않는다.

**왜 첫 버림 뒤의 초만 보나(spec 리뷰 F1·F2):** 「멈춤」은 버린 뒤 **회복**하는 것이다. 첫 버림 전의 초를 섞으면 두 경우에 거짓 stall이 난다.
- **채움 구간:** 반복이 긴(생각 시간·느린 대상) 진짜 부족 run은 슬롯이 0에서 M까지 `M/목표`초 동안 선형으로 찬다. 그 초들은 버림이 없고 시도율이 같아 비교 초가 되며, 중앙값이 M/2 근처라 판정이 반올림에 달린다. 예: M=500, 목표 100/s, 반복 10 s → F 50·150·250·350·450 → 중앙값 250 ≤ 250.
- **대상 과부하 무릎:** 반복 시간이 도착률에 따라 급히 늘어나는 대상은 최고 구간 첫 몇 초(대기열이 쌓이는 중)와 그 바로 아래 구간의 F가 M보다 훨씬 작다. 그 뒤 버림이 끝까지(또는 계단 자동 정지까지) 이어진다.

둘 다 첫 버림 뒤에 회복하지 않으므로 (c)에서 빠진다.

**경우별 기대:**
- 고정 목표 꾸준한 부족: 첫 버림 뒤 거의 모든 초가 버림 초 → `S_c`가 3개 미만, 또는 사이사이 무버림 초의 `F ≈ M` → `slots`(US3).
- 곡선이 포화점을 넘어 오른 뒤 꾸준한 부족(US4): 첫 버림 뒤 무버림 초는 내려오는 구간에만 있고, 거기서 시도율 ≥ 0.9·a\*인 초는 여전히 `F ≈ (A/포화 도착률) × M ≥ 0.9M`(대기열이 아직 차 있음) → `slots`. 계단 자동 정지로 끝나면 회복 초가 없어 → `slots`.
- 간헐 멈춤(US1): 첫 멈춤 뒤 같은 목표의 무버림 초가 다수, 그 초들의 `F ≪ M` → `stall`. 곡선 run의 낮은 구간에서 멈춰도 그 뒤의 더 높은 무버림 초가 비교 대상이 된다.
- run 끝 무렵 처음 멈춘 경우(첫 버림 뒤 회복 초 < 3): `slots`(옛 동작) — §7.

### 4.4 와이어 (`Insight` 새 선택 필드 — stall일 때만 `Some`, 구조체 **끝에** 추가)

| 필드 | 타입 | 뜻 |
|---|---|---|
| `typical_in_flight` | `Option<u64>` | `f̃.round()` — 첫 버림 뒤, 버림 초와 같은 시도율에서 버림이 없던 초들의 사용 슬롯 중앙값 |
| `max_in_flight` | `Option<u32>` | `M`(run 프로필 값, 워커 분할 전 합계) |
| `drop_seconds` | `Option<u64>` | `|S_d|` |
| `measured_seconds` | `Option<u64>` | `A(s) > 0`인 초 수(도착을 시도한 초) |

stall 인사이트의 나머지: `kind`·`severity`(warning)·`value`(초별 최대 요청 수)·`count`(run `dropped` — ADR-0046 단위로 **반복** 수)·`onset_second`·`target_per_sec`·`achieved_per_sec`는 지금과 같은 계산이다. `cause = "stall"`, `recommended = None`. slots·sut·cause 없음 인사이트에는 새 필드가 모두 `None`이다. 그래서 JSON 바이트가 같다(반목표 1).

**데이터 읽기(spec 리뷰 F4 — 비용):** 판정은 `dropped > 0`일 때만 필요하다. `build_report_for_run`은 `profile.is_open_loop() && run.dropped > 0`일 때만 초별 합계를 읽는다.
- 계단 run은 이미 워커별 행을 읽으므로(계단 집계용) 그 행을 Rust에서 초별로 더한다(추가 질의 0).
- 계단이 아닌 run은 새 store 함수가 `SELECT ts_second, SUM(launched), SUM(completed), SUM(dropped) FROM run_open_loop_seconds WHERE run_id = ? GROUP BY ts_second ORDER BY ts_second`로 초당 한 행만 가져온다(`AS` 별칭 필수 — controller CLAUDE.md sqlx 함정).
- 닫힌 루프 run과 버림 없는 open-loop run은 질의 0회(지금과 같은 비용).

`derive_insights`에 초별 합계 슬라이스 인자 하나를 더하고(타입은 plan이 정한다 — 작은 `Copy` 구조체 권장), `build_report`가 받아 넘긴다. 계단 집계는 지금처럼 `profile.stair`가 있을 때만 워커별 행을 쓴다. 비용 확인: 24시간·워커 8개 규모(초 86,400개) 합성 입력에서 판정 함수 시간을 재어 build-log에 남긴다(고정 상한 테스트는 두지 않는다 — engine CLAUDE.md 성능 테스트 규칙).

### 4.5 내보내기

`INSIGHT_COLUMNS`를 17 → 21로 늘려 끝에 `typical_in_flight`·`max_in_flight`·`drop_seconds`·`measured_seconds`를 붙인다. 두 행 작성 함수에 한 줄씩, 하드코딩 헤더 문자열 3곳을 갱신한다. `insight_error_kind_column_round_trips`의 열 수 단언(17)과 「마지막 열」 단언도 21·`measured_seconds`로 바꾼다. XLSX는 `if let Some` 조건부 기록이므로 **Some 값 픽스처 + 헤더·값·빈칸 단언**을 함께 넣는다(controller CLAUDE.md E2 F2 함정).

### 4.6 화면

- **제목**(`message()` `case "load_gen_saturated"`): `cause === "stall"`이고 새 필드가 있으면 새 문구, 아니면 지금 문구 그대로. 초안: 「응답이 가끔 멈춰 반복(시나리오 실행) {count}회를 못 보냈어요 — 도착을 시도한 {measured}초 중 {drop}초에만 몰렸어요」(`count`는 반복 수 — ADR-0046 단위).
- **안내**(`actionFor()`): `cause === "stall"`이면 `computed: true`(조치문 토글과 무관하게 항상 표시 — sut와 같은 이유: 「슬롯을 늘리지 말라」는 방향 경고). 초안: 「평소엔 동시 실행이 {typical}개만 쓰였어요(설정 {M}개). 버림이 몰린 초에는 응답이 멈춰 슬롯이 잠시 다 찼던 거예요 — 슬롯 수보다 그 시각 대상 서버의 상태를 먼저 확인하세요(드물게 부하기 쪽 멈춤일 수도 있어요). 멈춘 시각은 아래 지연 그래프에서 튄 곳이에요.」 숫자는 `n()`(천 단위 구분). 「충분했어요」라고 쓰지 않는다 — 평소 사용량으로 줄이라는 뜻으로 읽힌다(spec 리뷰 F3). 새 필드가 없으면(방어) 일반 문구.
- 부하기 쪽 멈춤(워커 프로세스가 잠시 스케줄되지 못함)도 같은 모양이라 계수만으로는 구별할 수 없다(ADR-0046이 `loadgen` cause를 뺀 이유와 같다). 그래서 문구가 「대상」이라고 단정하지 않는다.
- 문구는 `ko.saturation.stallHead`·`ko.saturation.stall`(ADR-0035). 최종 글자는 plan에서 정한다. 「지연 그래프」는 리포트의 시계열 차트 제목(`ko.ts` `latencyTitle`: 「지연」)에 맞춘다 — plan이 실제 화면 이름을 확인한다.
- **슬롯 도우미(`SlotSizingHelper`, US2):** `usePriorOpenRunAnchor`가 직전 run 포화 인사이트의 `cause === "stall"`을 보면 새 앵커 종류 `{ kind: "stall" }`(점유시간 없음)을 돌려준다. 도우미는 이 앵커일 때 안내 한 줄(`ko.slotSizing.fromStallRun` — 초안: 「직전 run은 응답이 가끔 멈춘 run이에요. 응답 시간으로 계산한 권장값은 멈춤 동안을 감당하지 못하니 슬롯을 줄이지 말고 대상 멈춤부터 확인하세요.」)만 보이고, 권장 숫자·「적용」 버튼·추정 입력·측정 버튼을 그리지 않는다(`holdMs = null`, 걷기·추정·측정 precedence보다 먼저). `cause === "slots"`·`"sut"`·없음의 기존 경로는 그대로.
- `openLoopRates.ts` 무변경(stall에도 `achieved_per_sec`가 있으므로 요약 카드 그대로).

## 5. 테스트 (되돌려 확인 대상 표시 ★)

컨트롤러 단위(`insights.rs`, 순수):
- ★ 재현 픽스처: M=2500, 목표 7000, 60초. 초당 L=7000/C=7000(F≈14). 10초부터 **흩어진** 18개 초가 D>0이고 그 초 끝 F=2500, 다음 초에 C가 몰려 F≈14로 돌아온다. 여기에 버림은 없지만 멈춘 초(경계 F 1,000–2,400) 몇 개를 섞어 중앙값이 그런 초에 흔들리지 않음을 본다 → `cause=stall`, `recommended=None`, 새 필드 값 정확(`typical_in_flight`=14 등). 되돌려 확인: (d)의 비교를 `>`로 뒤집거나 규칙을 끄면 RED(`slots`, `recommended=Some`).
- ★ 채움 구간(F1): M=500, 목표 100/s, 반복 10 s. F가 50·150·250·350·450으로 차고 6초째부터 끝까지 매초 D>0 → `slots`. 되돌려 확인: (c)의 `s > s₀`을 빼면 RED(`stall`).
- ★ 대상 과부하 무릎(F2): 곡선 100→1000/s, 반복 시간이 도착률에 따라 급히 늘어(무릎 아래 F≪M, 무릎 뒤 F=M) 최고 구간부터 끝까지 매초 D>0 → `slots`. 픽스처 조건: s₀ **앞에** `A ≥ 0.9·a*`이고 `F ≤ 0.5M`인 무버림 초가 3개 이상(최고 구간에 올라 대기열이 쌓이는 동안). 되돌려 확인: `s > s₀`을 빼면 RED.
- ★ 곡선 높은 구간 부족(US4): 1000/s로 올라 F가 M에서 막혀 연속 버림, 내려오는 구간에서 F≈0.9M인 무버림 초 몇 개, 그 **뒤에** 낮은 구간(100/s)을 길게(30초) → `slots`. 낮은 구간이 s₀ 뒤에 있어야 `TAU_RATE`가 유일한 거름망이 된다. 되돌려 확인: `TAU_RATE` 필터를 빼면 RED(낮은 구간 F가 다수라 중앙값이 0.5M 아래로).
- 꾸준한 부족: 모든 초 D>0, F=M → `slots`, 기존 `recommended` 값과 같음. 첫 버림 뒤 일부 초만 D=0이고 F≈0.95M → `slots`.
- 곡선 낮은 구간 멈춤: 낮은 구간에서 멈춰 버림, 그 뒤의 더 높은 무버림 초 F≪M → `stall`.
- 회복 초 2개(`MIN_COMPARABLE` 미만) → `slots`.
- 초별 합계 없음 / 합계에 버림 0 → 지금과 같은 인사이트(US5) — 같은 입력의 기존 테스트 기대값을 그대로 둔 채 새 인자에 빈 슬라이스를 넘긴다.
- `sut_stress` 참 + stall 모양 → `sut`(우선순위 불변).
- 누적 F: 꼬리 초(L=0, C>0), 누적이 음수가 되는 입력에서 보고 F=0이되 누적은 자르지 않음(다음 초 값으로 확인), `typical_in_flight` 반올림(짝수 개 중앙값 x.5).

store·리포트·와이어:
- store: 초별 합계 질의 — 두 워커 행(한 워커가 한 초 늦게 시작)을 초별로 더한 값, 다른 run 행 미포함.
- 계단 run 경로: 이미 읽은 워커별 행을 Rust에서 더한 합계가 store 질의 결과와 같다(같은 입력 두 경로 동등성).
- `report.rs`: open-loop 비계단 run에서 합계가 인사이트까지 전달되는지(`build_report`에 합계를 넣어 stall 인사이트 확인). 계단 run의 `stair` 출력은 그대로.
- JSON 바이트 동일성: slots·sut·옛 run 인사이트의 `serde_json::to_value`에 새 키가 없다(`as_object().contains_key` — 부재 단언, controller CLAUDE.md 테스트 항목).
- 질의 횟수: `dropped == 0` open-loop run과 닫힌 루프 run은 초별 합계를 읽지 않는다(`build_report_for_run` 분기 — 단위로 못 재면 plan이 코드 경로 단언 방식을 정한다).
- export: 21열 헤더, stall Some 값 행(4개 새 칸 값), slots 행(4칸 빈칸). CSV·XLSX × 단일·비교.

UI(vitest/RTL):
- ★ `InsightPanel`: stall 인사이트 → 새 제목·안내(숫자 천 단위), 토글 꺼짐에도 안내 표시. 슬롯 권장 글자(「올려 다시 실행」)가 없다. 되돌려 확인: stall 분기를 지우면 RED. 숫자는 `ko.*(n)` 자기참조 단언 말고 렌더된 숫자 글자를 따로 단언(ui/CLAUDE.md 공허 테스트 11호).
- `InsightPanel`: stall인데 새 필드 없음 → 지금 제목 + 일반 문구(방어).
- ★ `SlotSizingHelper`: 직전 run 인사이트가 `cause=stall`(achieved 있음, 리포트 스텝 p50 있음 — 걷기가 가능한 픽스처)이면 안내가 보이고 권장 숫자·「적용」 버튼이 없다. 되돌려 확인: stall 분기를 지우면 RED(걷기 권장 + 적용 버튼이 나타남).
- `SlotSizingHelper`: `cause=slots`·`sut`·없음 직전 run은 지금과 같은 출력(기존 테스트 유지).
- Zod: 새 필드 4개 수용(서버가 보내는 정수).

## 6. 라이브 검증

워크트리 자체 바이너리 + 격리 DB(`/live-verify`). 응답기는 live-verify `responder.py`를 복사해 **멈춤 모드**를 더한 스크래치 응답기를 쓴다. 평소 지연 2 ms이고, 벽시계 기준 5초마다 1초 동안 들어온 요청은 그 1초 창이 끝날 때까지 붙잡는다(keep-alive).

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 고정 목표 2000/s, M=400, 30초, 멈춤 응답기 | 리포트 인사이트 `cause=stall`, `recommended` 없음, `typical_in_flight` ≪ 400. 화면 제목·안내 문구 표시, 「올려 다시 실행」 글자 없음(스크린샷) |
| US2 | 그 시나리오로 RunDialog open-loop 열기 → 슬롯 도우미 | 멈춤 안내 한 줄이 보이고, 권장 숫자·「적용」 버튼이 없다(스크린샷). 슬롯 칸 값은 그대로 |
| US3 | 고정 목표 2000/s, M=20, 응답기 50 ms(멈춤 없음) | `cause=slots`, `recommended` = 공식 값, 새 키 없음 |
| US3′ | 채움 구간: 고정 목표 50/s, M=300, 응답기 10,000 ms(멈춤 없음, `http_timeout` > 10초), 40초 — 용량 30/s < 목표, 채움 6초 | `cause=slots`(첫 버림 전 채움 초가 비교 초로 안 들어감) |
| US4 | stages 200→3000/s 20초, M=100, 응답기 50 ms | `cause=slots` |
| US5 | 같은 run의 `run_open_loop_seconds` 행을 지운 뒤 리포트 다시 열기 | `cause=slots`·`recommended` 있음(옛 경로) |

라이브 값(도착률·M)은 이 맥에서 응답기가 무너지지 않는 범위로 plan이 조정한다(keep-alive 응답기 1천여 req/s 함정 — controller CLAUDE.md).

## 7. 알려진 한계 (roadmap §B에 기록)

- **한 run 안에서 멈춤과 진짜 부족이 섞이면** 한쪽만 진단된다. 버림 초 도착률의 중앙값 `a*`를 어느 쪽 버림 초가 더 많이 차지하느냐에 달렸다(예: 곡선 낮은 구간 멈춤이 많고 최고 구간도 부족). 비용: 최고 구간 슬롯 부족을 「대상 멈춤」으로 말하는 오진. 해소 경로: 도착률 구간별 판정(계단 run이면 계단별)을 따로 내는 후속.
- **슬롯을 빠듯하게 잡은 run에서의 멈춤**(평소 F가 M의 절반 초과)은 지금처럼 `slots`와 「M보다 조금 더」 권장이 나온다. 비용: §B57 원래 증상이 좁은 범위에 남는다. 해소 경로: 버림 초 비율과 무버림 초 F의 분포를 함께 쓰는 2차 규칙(실데이터 수집 뒤).
- **run 끝 무렵 처음 멈춘 run**(첫 버림 뒤 회복 초 3개 미만)은 `slots`(옛 동작)다. 비용: 그 run엔 원래 오진이 남는다. 해소 경로: 없음(회복을 못 봤으니 멈춤이라 말할 근거가 없다 — 정직한 기본값).
- **부하기 쪽 멈춤**도 stall로 진단된다(계수·클라이언트 지연으로 구별 불가). 문구가 「드물게 부하기 쪽」을 병기한다. 해소 경로: 워커 텔레메트리(ADR-0046 §B20과 같은 전제).
- **초별 행 유실**(삽입 실패 `warn!`·시계가 비정상인 행 폐기)은 그 뒤 `F`를 치우치게 한다. 멈춤 시작 초(큰 L)가 빠지면 F가 낮게 남아 stall 쪽으로 기운다. 비용: 드문 오진. 해소 경로: 누적 대신 초별 시작·완료 쌍 대조(행 유실 감지) 후속.
- 옛 run(행 없음)은 원래 오진 그대로다(사용자 결정).
- **슬롯이 작고 지연 꼬리가 긴 run**(예: 목표 10/s, 반복 ~0.5 s, M=10, 평소 F≈5)에서 느린 응답 몇 개가 겹쳐 가끔 M에 닿으면 버림이 흩어지고 회복 F ≤ 0.5M이라 `stall`이 된다. 이때는 슬롯 여유를 늘리는 게 싸고 맞는 조치인데, US2 도우미는 숫자를 숨긴다. 비용: 작은 run에서 도우미가 권장을 못 낸다(안내 문구는 「대상 상태 확인」이라 틀리진 않지만 덜 유용). 해소 경로: 여유 슬롯 절대 하한(`M − f̃ ≥ N`) 같은 보조 조건 — 실데이터를 본 뒤.
- `InsightCompareMatrix`(run 비교)는 kind별 행이라 stall과 slots가 한 「포화」 행에 섞인다(지금도 cause 미표시 — 비목표).

## 8. claims-ledger (사실 주장 → 확인 명령, plan 디스패치 전 재실행)

| 주장 | 명령 |
|---|---|
| 엔진이 open-loop 공통으로 카운터 생성·세 종류 기록 | `grep -n "OpenLoopCounters::new\|CountKind::" crates/engine/src/runner.rs` |
| 워커가 계단 조건 없이 전송 | `grep -n "open_loop_seconds\|stair" crates/worker/src/lib.rs` |
| 컨트롤러 ingest 무조건 저장 | `grep -n "open_loop_seconds" crates/controller/src/grpc/coordinator.rs` |
| 리포트는 계단 run만 행을 읽음 | `grep -n "profile.stair.is_some()" crates/controller/src/api/runs.rs` |
| 프로덕션 `build_report` 호출 1곳 | `grep -rn "build_report(" crates/controller/src \| grep -v "fn build_report" \| grep -v "crates/controller/src/report.rs"` |
| 인사이트 열 17개·헤더 하드코딩 3곳 | `grep -n "INSIGHT_COLUMNS" crates/controller/src/export.rs` · `grep -rn "runner_up_ms,error_kind" crates/controller/src crates/controller/tests` |
| UI cause 소비처 | `grep -rn "cause" ui/src --include="*.ts" --include="*.tsx" \| grep -v "\.test\."` |
| unique 소진이 Completed 전 반환 | `grep -n "exhausted.store(true" crates/engine/src/runner.rs` |
| 도우미 앵커 null → 걷기 | `grep -n "kind: \"walk\"\|kind: \"insight\"" ui/src/components/run/SlotSizingHelper.tsx` |
| validity는 kind만 봄 | `grep -n "load_gen_saturated" crates/controller/src/validity.rs` |
| Insight 선택 필드 전부 skip-if-none | `sed -n '/pub struct Insight/,/^}/p' crates/controller/src/insights.rs > $SCRATCH/s.txt`(스크래치 경로) 후 `grep -c 'skip_serializing_if = "Option::is_none"' $SCRATCH/s.txt` = `grep -c ': Option<' $SCRATCH/s.txt`(둘 다 15, 2026-11-20) |
| Zod `InsightSchema` 비-strict | `sed -n '/export const InsightSchema/,/^});/p' ui/src/api/schemas.ts \| grep -c strict` = 0 |

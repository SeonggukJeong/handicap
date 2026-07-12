# open-loop-slot-sizing — 슬롯 사이징·포화 인사이트를 "반복 점유시간" 기반으로 교정 (open-loop 단위 정합 슬라이스 ①)

- **날짜**: 2026-07-12
- **상태**: 설계 승인(사용자 2026-07-12) → plan 대기
- **출처**: 사용자 버그 리포트("open-loop에서 자원 여유가 충분한데 설정대로 부하가 안 오름") → 2026-07-12 실측 5-run 재현으로 3층 결함 입증(메모리 `open-loop-rate-unit-decision`, 본 spec §1). 지금 하는 이유: 도구 자신의 권장값을 따르면 목표에 미달하고, 사후 진단이 무익한 처방(워커 증설)으로 발산하는 사용자-신뢰 결함.
- **연관**: ADR-0031(open-loop)·ADR-0038(open-loop fan-out)·`2026-06-15` cause 귀속(loadgen/sut)·`openLoopChecks.ts`(inert_slots — 올바른 반복-시간 모델의 선례).
- **ADR**: **ADR-0046 신규** — "open-loop 부하 단위 = 반복/초(도착률) 공식화". 단위 결정은 공식 전체의 전제라 별도 결정 기록 필요(요청/초 공식화 기각 근거 포함). 본 슬라이스(①)가 공식·귀속을, 후속 슬라이스(②)가 라벨·환산 표시·리포트 도착률을 구현한다.

---

## 1. 문제와 목표

실측 재현(2026-07-12, 100ms responder·target 20·15s)으로 확인된 결함: ① 엔진은 `target_rps`를 **반복(도착)/초**로 페이싱하는데(각 arrival = 시나리오 전체 1회 실행, 슬롯을 반복 내내 점유), 슬롯 권장 공식(`sizing.ts::recommendSlots`)과 사후 인사이트 `required`(`insights.rs:236-241`)는 **요청 1건의 평균 지연**만 반영한다 — 멀티스텝(2-스텝 run: dropped 40%)·per-step think time(think 1s run: 목표의 13%인 2.7 RPS로 plateau) 시나리오에서 체계적 과소 추천. ② 과소 추천된 `required ≤ max_in_flight`가 "슬롯 충분"으로 오판돼 `cause=loadgen` + 워커 증설 권장으로 빠지는데, open-loop fan-out은 `max_in_flight`를 **총량 분할**하므로(`api/runs.rs:695-696`→`shard_split`) 워커를 늘려도 RPS 불변(실측 2.7→2.7)·권장 워커 수만 발산(7→20). 올바른 공식(슬롯 = 목표 도착률 × 반복 점유시간)으로 돌리면 목표 도달(슬롯 23 → 19.9 RPS·dropped 0).

- **목표**: `required`/`recommended`·UI 슬롯 헬퍼·워커 헬퍼를 **반복 점유시간** 기반으로 교정하고, cause 귀속을 신뢰 가능한 신호만 남긴 2-way(slots/sut)로 재설계한다. 전문가·초보자 모두 "무엇을 얼마로 바꿔야 하는지"를 문구에서 바로 읽을 수 있어야 한다(사용자 요구 2026-07-12).
- **비목표(연기)**: §7 참조 — open-loop 목표 입력 라벨 개명·"≈ 요청 N/s" 환산 표시·리포트 도착률 시리즈(슬라이스 ②), loadgen(워커 CPU) 감지 재도입(워커 텔레메트리 필요), per-second dropped 시리즈.

---

## 2. 요구사항 (정규 — R-id)

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST `load_gen_saturated`의 `recommended`(권장 max_in_flight)는 실측 점유시간 기반 `ceil(target_eff × hold)`·`hold = M ÷ achieved_arrival_rate`로 산출한다(M=max_in_flight) — Run C 재현 fixture(target 20·M 3·dropped 260·15s·think 1s)에서 정확히 23. | `cargo test -p handicap-controller insights` 신규 케이스(23 단언) | |
| R2 | MUST `achieved_arrival_rate = (scheduled_arrivals − dropped) ÷ duration_actual`, `scheduled_arrivals`는 고정 rate면 `target × duration_actual`, 곡선(stages)이면 `rate_at` 사다리꼴 적분을 **실제 run 길이에서 절단**해 계산한다(`duration_actual = summary.duration_seconds`). | 단위: 고정/곡선/조기종료(절단) 3 케이스 | |
| R3 | MUST cause는 2-way — `sut_stress`(기존 신호 무변경: 5xx률≥1% OR late/early p95≥1.5×)면 `cause=sut`·`recommended=None`, 아니면 `cause=slots`·`recommended=Some(R1)`; `cause=loadgen` 생성 경로는 제거한다. | 단위: 두 arm + loadgen 부재 단언; 라이브 §6 | |
| R4 | MUST 사후 `recommended_workers` 산출을 제거한다 — `Insight.recommended_workers` 필드는 와이어/export 호환을 위해 유지하되 모든 경로에서 `None`(deprecated 주석 + 재도입 연기 §7). | 단위: 포화 인사이트 전 경로 `recommended_workers == None` | |
| R5 | MUST `Insight`에 `achieved_per_sec: Option<f64>`(달성 도착률)·`target_per_sec: Option<f64>`(목표 도착률 — 곡선이면 peak) 두 필드를 additive로 추가한다(포화 인사이트에서 **계산 가능할 때만** `Some` — fallback arm은 §4.1) — serde `skip_serializing_if = "Option::is_none"`, UI Zod `.optional()`, struct 선언 위치는 `onset_second` **뒤 append**(선언순=컬럼순 계약, export.rs:86-88), `INSIGHT_COLUMNS` 13→**15**열 + 두 행-writer(`insight_csv_cells`/`write_insight_xlsx_row`) 갱신. | round-trip + `insight_columns_are_single_source` + export 테스트 | ✅ wire: UI Zod↔serde + CSV/XLSX 열 |
| R6 | MUST UI `recommendSlots(target, holdMs) = max(1, ceil(target × holdMs/1000))` — 둘째 인자의 의미를 "요청당 지연"에서 "**반복 1회 점유시간(ms)**"으로 변경한다(시그니처 유지). | `sizing.test.ts` 갱신 | |
| R7 | MUST 신규 순수 함수 `iterationHoldMs(steps, perStepP50, fallbackMs)`(`sizing.ts`)는 `iterationTimeUpperBoundSeconds`(`openLoopChecks.ts:27`) 구조를 미러한다 — http leaf = `perStepP50[id] ?? fallbackMs` + think 평균 `(min+max)/2`; loop = `repeat ×`; if/parallel = 분기 max; http leaf 0개면 `0`(호출부 skip). | 단위: flat/loop/if/parallel/think 케이스 | |
| R8 | MUST `SlotSizingHelper` 지연 앵커 우선순위를 재설계한다 — 기준 run은 `pickLatestOpenRun`의 **latest 1개**(탐색 없음): ⓐ 그 run의 `load_gen_saturated`가 `cause=slots && achieved_per_sec>0`이고 prior run의 `max_in_flight`가 있으면 **`hold_sec = prior.profile.max_in_flight ÷ insight.achieved_per_sec`로 점유시간을 복원**해 `recommendSlots(현재 목표, hold_ms)` — hold는 목표-독립 속성이라 현재 폼 목표가 prior와 달라도 정확하고, 현재 목표 == prior 목표면 서버 `recommended`와 정확히 일치(R9; raw passthrough는 현재 목표≠prior 목표일 때 틀린 권장이라 기각) → ⓑ ⓐ 불충족 시(비포화·cause=sut·cause=None 전부) 같은 run의 `iterationHoldMs`(per-step p50 = prior report **`steps[]`**의 `p50_ms` 맵, fallback = `summary.mean_ms`; **결과 hold ≤ 0이면 앵커 무효 → 다음 순위**, localhost p50=0 가드) → ⓒ 수동 입력(의미를 "**반복 1회 예상 시간(ms)**"으로 변경) → ⓓ 측정 test-run: `apply_think_time: true`로 호출하고 `trace.total_ms`를 hold로 **직접** 사용(÷요청수 제거). | RTL: 4앵커 각 경로 + 우선순위 | |
| R9 | MUST(parity) 사전 권장 ≡ 사후 인사이트 — ⓐ 경로는 **현재 목표 == prior 목표일 때 서버 `recommended`와 동일값**(동일 공식 `ceil(T×M÷A)` — RTL 단언)이고, 곡선 `scheduled_arrivals` 적분은 서버 단위 테스트 fixture 숫자를 spec §4.1에 기록해 검증을 고정한다. | RTL passthrough + 서버 fixture 단언 | |
| R10 | MUST `WorkerSizingHelper` 권장식을 `ceil(target × prior_wc ÷ prior_achieved_arrival_rate)`로 교정한다(요청 peak 단위 혼용 제거) — 앵커는 **고정 rate prior run으로 한정**(곡선 prior는 앵커 제외, §7)·`prior_achieved_arrival_rate = prior_target − dropped ÷ duration`; 적용 문구에 "worker_count 증설 시 max_in_flight는 워커별 분할 — 슬롯도 함께 상향" 경고 1줄 추가. | 단위 + RTL(경고 문구) | |
| R11 | MUST 무변경 불변식 — 엔진(`runner.rs`)/proto/migration/`openLoopChecks.ts`/`validate_run_config` 0-diff; closed-loop 인사이트 경로·`dropped=0` run 리포트는 byte-identical(신규 필드 R5는 포화 인사이트에만 실림); `sut_stress` 판정식·`onset_second`·`slowest_step` 등 여타 인사이트 무변경. | 전체 스위트 green(**§8에 명시된 기존 테스트는 새 공식 기대값으로 갱신 후** — cargo nextest + pnpm test/build) + `no_saturation_when_dropped_zero` 유지 | |
| R12 | MUST ko 문구(`ko.ts` saturation/슬롯·워커 헬퍼) — cause=slots는 "목표 도착 X/s 중 Y/s만 시작(초당 Z건 유실) → max_in_flight를 N 이상으로", cause=sut는 "서버 응답 열화 신호 — 부하·슬롯 증설 보류, 서버 지표 확인"을 명시하고, 곡선 run의 권장값엔 "(피크 기준 상한 추정)"을 병기한다(곡선의 Z=X−Y도 X=peak·Y=적분평균이라 상한 — 같은 병기가 한정) — 수치·행동이 문장 안에 있어 초보자도 다음 행동을 바로 안다. **데이터 출처**: X=`target_per_sec`·Y=`achieved_per_sec`(둘 다 R5 insight 필드), Z=X−Y 클라 산출 — InsightPanel prop 확장 없음. cause=None fallback 문구(`ko.insightActions.load_gen_saturated` — 구 "워커 CPU" 언급)도 2-way 모델에 맞게 재작성. | RTL 문구 단언 + 라이브 육안 | |
| R13 | MUST 경계 가드(**slots arm 한정 — R3의 sut 판정이 우선**: sut_stress면 achieved≤0이어도 `recommended=None`) — `achieved_arrival_rate ≤ 0`(dropped ≥ scheduled)이면 `recommended = 10_000`(validate 상한, api/runs.rs:290)으로 클램프하고 상한 도달 문구(`ko.saturation` 신규 키, §4.8)를 표시한다; `recommended`는 항상 `min(계산값, 10_000)`. | 단위: 클램프 케이스 + sut 우선 케이스 | |
| R14 | SHOULD 라이브 재현 3-run으로 종단 검증 — think 시나리오(1-스텝 105ms+think 1s) 슬롯 3 → `cause=slots`·`recommended≈23`·`achieved_per_sec≈2.7`; 슬롯 23 → 포화 인사이트 없음·RPS≈20; 2-스텝(각 105ms) 슬롯 3 → `recommended≈5`(실측 Run B: achieved 12/s → ceil(20×3/12)=5). | `/live-verify` §6 | |

---

## 3. 핵심 통찰 (설계 근거)

1. **점유시간은 자기측정이 가장 정확하다(R1)**: 포화 중엔 M개 슬롯이 상시 사용 중이므로 `hold = M ÷ 달성 도착률`이 항등식으로 성립 — 시나리오 walk·think 지식 없이 think time·멀티스텝·분기까지 자동 반영된다(실측 23=23). 시나리오-walk 기반 대안(Σ per-step 지연 + think)은 서버에서 분기 근사·walk 유지비가 들고 정확도도 낮아 기각. 단 **곡선 run은 저율 구간의 유휴 슬롯이 평균에 섞여 hold가 과대(=권장 슬롯 과대) 추정**된다 — 안전한 방향(과대 프로비저닝)이고 per-second dropped 시리즈 없인 정밀화 불가라 "(상한 추정)" 문구로 명시(R12)하고 정밀화는 연기(§7).
2. **loadgen(워커 CPU) 감지는 현 텔레메트리로 불가능(R3/R4)**: 새 required 산식에선 dropped>0 ⟹ 항상 required>M이라 기존 "슬롯 충분한데 포화 = loadgen" 잔차 논리가 구조적으로 사라진다. 대안으로 검토한 "본질 hold(스텝 지연 합+think) vs 실측 hold 비교"는 워커 CPU 포화 시 **측정된 스텝 지연 자체가 함께 부풀어** 두 값이 동반 상승 → 판별력 없음. 거짓 진단(Run C/D의 무익·발산 워커 권장)보다 진단 범위 축소가 낫다(사용자 확정 2026-07-12). 필드는 유지(R4)해 와이어·export 4표면 churn 회피.
3. **사전 권장 == 사후 인사이트 불변식은 실측-hold 복원으로 격상(R8ⓐ/R9)**: 포화 prior run의 insight가 실측 달성 도착률(`achieved_per_sec`)을 실으므로 UI는 `hold = M_prior ÷ achieved`로 **목표-독립 점유시간을 복원**해 현재 목표에 적용한다 — 서버와 같은 공식(`ceil(T×M÷A)`)이라 같은 목표면 동일값(parity by-construction), 다른 목표면 올바르게 스케일된다. raw passthrough(그대로 표시)는 현재 목표≠prior 목표에서 틀린 권장이라 기각(plan 작성 중 적발).
4. **측정 앵커는 test-run 1-pass의 wall-clock이 곧 반복 점유시간(R8ⓓ)**: `apply_think_time: true`면 `trace.total_ms` = 스텝 지연 합 + think 합 = hold 그 자체. 기존 `total_ms ÷ 요청수`(요청당 평균)보다 정확하고 단순하다.
5. **`achieved_per_sec`·`target_per_sec` 필드 추가(R5)가 초보자-자명 문구(R12)의 전제**: "목표 X/s 중 Y/s만 시작"을 쓰려면 목표·달성 도착률이 인사이트에 실려야 한다 — 특히 목표를 서버가 실어야 곡선 peak 도출을 UI가 복제하지 않는다(passthrough 철학). `value`(관측 peak, 요청/초)는 기존 소비처 보존을 위해 의미 무변경.

---

## 4. 변경 상세

### 4.1 `crates/controller/src/insights.rs` — 충족 R: R1, R2, R3, R4, R13
- `derive_insights`의 `dropped > 0` 블록(현 213-271행) 재작성:
  - **`scheduled_arrivals` 적분은 insights.rs의 순수 함수로 정의**(엔진 `rate_at`는 private라 미러 구현 — §4.1 fixture가 0-start 램프 의미를 고정): 고정 = `f64(target) × duration`; 곡선 = `Σ_stage 사다리꼴(prev_target→target, dur)`을 `duration_actual`에서 절단(마지막 부분 stage는 선형 보간 값까지 적분). **호출은 `report.rs`가 하고 결과를 전달**(아래 4.2) — `derive_insights`에 11번째 인자 `scheduled_arrivals: Option<f64>` 추가(`#[allow(clippy::too_many_arguments)]` 기존; 인라인 테스트 call site ~30곳 기계적 churn — §8).
  - `achieved_rate = ((scheduled − dropped as f64) / duration).max(0.0)`; `duration = summary.duration_seconds.max(1) as f64`.
  - `required = if achieved_rate > 0 { ceil(target_eff × M / achieved_rate) } else { 10_000 }`; `recommended = Some(min(required, 10_000))` (R13).
  - cause 평가 순서: **sut_stress를 먼저** — `sut_stress(...)` → `("sut", recommended=None)`, else `("slots", recommended)` (R3, R13은 slots arm 안). loadgen arm·`recommended_workers` 계산 블록 삭제(R4). 기존 `sut_stress_only_inside_slots_sufficient_arm`(CC2) invariant는 **의도적으로 반전**됨(sut가 항상 선평가) — 테스트 재설계(§8).
  - **fallback arm 보존**: `target_eff`/`max_in_flight`/`scheduled` 중 하나라도 `None`이면(구식 run·profile 부재 테스트 fixture) 기존처럼 인사이트는 emit하되 `cause=None`·`recommended=None`·`achieved_per_sec=None`·`target_per_sec=None`(현 `_ => {}` 폴백 268행의 계승 — `InsightPanel.tsx:64` cause-None 분기가 이 경로 소비).
  - 계산 가능 arm에서 `ins.achieved_per_sec = Some(achieved_rate)`·`ins.target_per_sec = Some(target_eff)` (R5). `value`(peak)·`count`(dropped)·`onset_second` 무변경.
  - **참조 fixture(R9 고정)**: 고정 rate — target 20·M 3·dropped 260·duration 15 → scheduled 300·achieved (300−260)/15=2.667/s·required ceil(20×3/2.667)=**23**. 곡선 — stages `[{target:10,dur:10},{target:10,dur:10}]`·duration 20 → scheduled 50+100=**150**(첫 stage 0→10 사다리꼴 50 + 둘째 10 유지 100); 절단 케이스 duration_actual 15 → 50+50=**100**.
- `Insight` struct: `pub achieved_per_sec: Option<f64>`·`pub target_per_sec: Option<f64>`(둘 다 serde `default, skip_serializing_if`, **`onset_second` 뒤 append** — 선언순=INSIGHT_COLUMNS 순 계약), `recommended_workers`에 deprecated 주석.

### 4.2 `crates/controller/src/report.rs` — 충족 R: R2
- `derive_insights` 호출부(현 767행 부근): 기존 `target_eff` 도출(776-781행, `target_rps.or_else(stages peak)`) 옆에서 insights.rs의 `scheduled_arrivals` 함수를 호출해 전달 — profile(`run.profile`)의 `target_rps`/`stages`와 `summary.duration_seconds` 사용. open-loop이 아니면(둘 다 없음) `None`.
- **기존 테스트 갱신**: `build_report_sizing_slots_recommendation`(현 1998행, recommended=500 단언)·`build_report_sizing_uses_stages_peak`(2019행, 600 단언)은 새 공식 기대값으로 재산정(§8).

### 4.3 `crates/controller/src/export.rs` — 충족 R: R5
- `INSIGHT_COLUMNS` 13→**15**열(`achieved_per_sec`·`target_per_sec` 추가) + `insight_csv_cells`/`write_insight_xlsx_row` **각 두 줄** — 4표면 동시 반영(기존 단일-소스 계약).

### 4.4 `ui/src/api/schemas.ts` — 충족 R: R5
- `InsightSchema`(또는 해당 인사이트 Zod)에 `achieved_per_sec: z.number().optional()`·`target_per_sec: z.number().optional()` — 서버 `skip_serializing_if`라 absent→`.optional()`(B7-C 3종 분기 규칙).

### 4.5 `ui/src/components/sizing.ts` — 충족 R: R6, R7, R10
- `recommendSlots(targetRps, holdMs)`: 구현 동일(`ceil(target × ms/1000)`), doc 주석·호출부 의미를 hold로 전환.
- 신규 `iterationHoldMs(steps: ReadonlyArray<Step>, perStepP50: ReadonlyMap<string, number>, fallbackMs: number): number` — R7 walk. think 평균 `(min_ms+max_ms)/2`.
- `recommendWorkers(target, priorWc, priorAchievedArrivalRate)`: 분모를 달성 도착률로(R10). `peakThroughput`은 다른 소비처 없으면 worker 앵커에서 분리(삭제는 하지 않고 유지 — 표시용 관측 peak 계속 사용 가능).
- `pickLatestOpenRun` 무변경; worker 앵커용 `pickLatestFixedOpenRun`(target_rps 있는 run 한정) 추가 또는 앵커 훅에서 필터(R10).

### 4.6 `ui/src/components/SlotSizingHelper.tsx` — 충족 R: R8, R9, R12
- 앵커 재설계(R8 ⓐ→ⓓ). ⓐ: prior report `insights`에서 `kind=load_gen_saturated && cause=slots && achieved_per_sec>0` + prior run `profile.max_in_flight` 존재 → `hold_ms = (prior.max_in_flight ÷ achieved_per_sec) × 1000`으로 복원해 `recommendSlots(현재 목표, hold_ms)`("직전 run 실측 점유시간 기반" 문구). ⓑ: `iterationHoldMs`(prior report `steps[]`의 `p50_ms` 맵, fallback `summary.mean_ms`) → `recommendSlots`. ⓒ: 수동 입력 라벨·placeholder를 "반복 1회 예상 시간(ms)"으로. ⓓ: `testRun.mutate({..., apply_think_time: true})` + `trace.total_ms`를 hold로.
- **props에 typed `scenario` 추가 필요**(R7 walk 입력 — 현 props는 scenarioId/env/targetRps뿐): `LoadModelFields`가 이미 보유한 `sizingScenario`를 optional prop으로 내려줌(기존 게이트 패턴 유지 — prop 부재 시 ⓑ 앵커 skip).
- 문구(ko 경유): 공식 표시를 "목표 도착 N/s × 반복 1회 M ms ≈ 슬롯 K"로.

### 4.7 `ui/src/components/WorkerSizingHelper.tsx` — 충족 R: R10
- 앵커: 고정 rate prior 한정 + `achieved = prior.profile.target_rps − report.dropped/summary.duration_seconds`. 적용 영역에 슬롯 분할 경고 1줄(ko 신규 키).

### 4.8 `ui/src/i18n/ko.ts` + `InsightPanel` 소비처 — 충족 R: R12, R13
- `ko.insights.saturation` cause 분기 문구 재작성(2-way): slots = 목표/달성 도착률·유실률·권장 슬롯 수치 포함(X=`target_per_sec`·Y=`achieved_per_sec`·Z=X−Y 클라 산출 — InsightPanel prop 확장 없음), sut = 증설 보류 경고. loadgen 문구 키 제거(소비처 분기도 함께). 곡선 병기 "(피크 기준 상한 추정)" + R13 상한 도달 문구 신규 키. 조사 병기 규칙((으)로) 유지.
- `ko.insightActions.load_gen_saturated`(cause=None fallback 행동 문구 — 구 "워커 CPU" 언급) 2-way 모델에 맞게 재작성; `InsightPanel.tsx:64` cause-None 폴백 분기는 유지.
- 슬롯/워커 헬퍼 문구 키 갱신(4.6/4.7).
- **기존 테스트 갱신**: `InsightPanel.test.tsx`의 loadgen 케이스 3곳(현 86·94·135행 부근)을 2-way 문구로 재작성.

### 4.9 `docs/adr/0046-open-loop-rate-unit-iterations-per-second.md` — 신규
- 결정: open-loop `target_rps`/stage `target`의 공식 단위 = **반복(도착)/초**. 요청/초 공식화 기각(if 분기에서 K 가변 → 근사/피드백 제어 필요 → silent divergence 원칙 위반; k6/Gatling/Artillery 관례). 실측 5-run 근거 요약. cause 2-way 축소·loadgen 연기. 구현 분할: ①(본 spec) 공식·귀속, ②(후속) 라벨 개명·"≈ 요청 N/s" 환산·리포트 도착률 시리즈. 와이어 필드명 `target_rps`는 호환 유지.

---

## 5. 무변경 / 불변식 (명시)

- **엔진 0-diff**: `runner.rs` 스케줄러·슬롯풀·dropped 계수 무변경(단위 결정이 현 엔진 의미를 공식화하는 것이므로). proto·migration 0.
- **`openLoopChecks.ts` 0-diff**: `iterationTimeUpperBoundSeconds`/`inert_slots`는 이미 반복-시간 기반으로 올바름 — R7은 구조를 *미러*할 뿐 그 파일을 건드리지 않는다(상한[timeout]용 vs 추정[관측 p50]용으로 목적이 달라 통합하지 않음).
- **`validate_run_config`·fan-out 분할 0-diff**: `max_in_flight` 총량-분할 의미(ADR-0038) 유지 — R10 경고 문구가 이를 사용자에게 알릴 뿐.
- **Insight 기존 필드 의미 보존**: `value`(관측 peak, 요청/초)·`count`(dropped)·`onset_second`·`recommended_workers`(필드 존치, 항상 None) — 와이어 shape는 R5 additive뿐. `dropped=0` run 리포트 byte-identical.
- **`sut_stress` 판정·`slowest_step`·SLO·비교 export 델타 공식 무변경**.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1 | `insights.rs` 단위: Run C fixture → recommended==23 | |
| R2 | 단위: 고정/곡선(150)/절단(100) scheduled_arrivals | |
| R3 | 단위: sut arm(기존 sut fixture 재사용)·slots arm·loadgen 부재 | ✅ |
| R4 | 단위: 전 경로 recommended_workers==None | |
| R5 | serde round-trip + `insight_columns_are_single_source` + CSV/XLSX export 셀 | |
| R6·R7 | `sizing.test.ts`: hold walk(flat/loop/if/parallel/think)·recommendSlots | |
| R8 | RTL: ⓐ passthrough·ⓑ walk·ⓒ 수동·ⓓ 측정(apply_think_time·total_ms 직접) 각 경로+우선순위 | |
| R9 | RTL ⓐ passthrough 동일값 + 서버 fixture(§4.1 숫자) 단언 | |
| R10 | 단위 + RTL: 새 분모·경고 문구·곡선 prior 앵커 제외 | |
| R11 | 기존 스위트 green(cargo nextest + pnpm test/build)·no_saturation 테스트 유지 | |
| R12 | RTL 문구 단언 | ✅ |
| R13 | 단위: achieved≤0 → 10_000 클램프 + sut 우선(sut_stress 시 recommended=None) | |
| R14 | `/live-verify` 3-run(§2 R14 수치) + 권장 적용 run 목표 도달 | ✅ |

- 라이브 검증 **필수**(인사이트=리포트 응답 경로 + Zod 신규 필드 — S-D 갭 클래스). 레시피는 2026-07-12 재현 세션 그대로(100ms responder·think 시나리오·15s).

---

## 7. 의도적 연기 (roadmap §B20 신설에 누적)

- **슬라이스 ②(단위 표면화)**: open-loop 목표 입력 라벨에서 "RPS" 제거→"도착률(초당 반복)", 설정 시 "≈ 요청 N/s" 라이브 환산(분기 시 범위), 리포트 목표/달성 도착률 시리즈·카드. 이유: UI 카피 전면 스윕은 독립 diff가 크고, ①의 공식 교정과 검증 축이 다름.
- **loadgen(워커 CPU) cause 재도입**: 워커가 CPU/이벤트루프 lag 텔레메트리를 보고해야 신뢰 가능 — proto 확장 필요라 별도 슬라이스.
- **per-second dropped 시리즈**: 곡선 run의 required 정밀화(포화 구간 한정 산출)·onset 정밀화의 전제. S-C spec §9에서 이미 연기된 항목의 재확인.
- **곡선 prior run의 워커 앵커**: scheduled 적분을 UI에 복제해야 해 parity 표면이 늘어남 — 고정 prior 한정으로 출발.

---

## 8. 구현 순서 (plan 입력)

1. **계약-먼저(R5)**: `Insight.achieved_per_sec`/`target_per_sec` serde + UI Zod `.optional()` + `INSIGHT_COLUMNS` 15열 — 한 green 커밋(와이어 양쪽 동시).
2. **서버 공식(R1-R4, R13)**: `insights.rs` 재작성 + `report.rs` scheduled 전달 + 단위 테스트(fixture §4.1) — **기존 테스트 파급 전부 같은 커밋에서 갱신**: insights.rs slots-arm 3건(`saturated_slots_recommends_when_underprovisioned`·`saturated_small_required_rounds_up_to_one`·`saturated_sizing_falls_back_when_latency_zero` — mean 기반 fixture 재설계)·loadgen 케이스·CC2(`sut_stress_only_inside_slots_sufficient_arm` — invariant 반전 재설계)·report.rs `build_report_sizing_slots_recommendation`/`build_report_sizing_uses_stages_peak`(기대값 재산정)·`derive_insights` 11번째 인자 call site ~30곳.
3. **UI 사이징(R6-R10)**: `sizing.ts`(hold walk·worker 분모) → `SlotSizingHelper`(앵커 재설계) → `WorkerSizingHelper` — 각 green 커밋(테스트 동반).
4. **문구(R12)** + ADR-0046(4.9) + roadmap §B20 연기 기록.
5. **라이브(R14)**: `/live-verify` 3-run + 권장 적용 확인 → finish-slice.

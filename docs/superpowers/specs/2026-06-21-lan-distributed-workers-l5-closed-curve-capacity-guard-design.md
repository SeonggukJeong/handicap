# LAN 분산 워커 L5 — closed-loop VU 곡선 풀 과부하 가드 (capacity-aware 곡선 샤딩 + active-VU 머지, ADR-0041 후속)

> **이 파일의 척추는 §2 요구사항 표(R-id)다.** plan·구현·리뷰가 전부 이 ID를 참조한다.

- **날짜**: 2026-06-21
- **상태**: 설계 초안(사용자 핵심결정 3건 확정 2026-06-21) → 사용자 spec 리뷰 대기
- **출처**: roadmap §LAN 분산 / **L4 spec §7 + R11**("closed-loop VU 곡선(vu_stages) 풀 가드 — N=1 legacy·under-cap 갭 존속·별도 슬라이스"). **왜 지금**: L3(closed-fixed)·L4(open 고정+곡선)가 풀 배정을 capacity-aware로 만들었지만, **closed-loop VU 곡선만 가드 fork `!is_vu_curve()`에서 제외**돼 여전히 legacy N=1로 빠진다 — 풀 워커 선언 `--capacity-vus`를 무시하고 곡선 전체를 한 워커에 얹어 과포화시키거나, 집계 풀 용량 안에 드는 곡선조차 fan-out 못 한다(under-cap 갭). 이 슬라이스가 LAN 과부하 가드 set의 마지막 모드를 닫는다.
- **연관**: **L4**(`2026-06-21-lan-distributed-workers-l4-open-curve-capacity-guard*` — `reduce_open_loop_profile` slot_weights·`proportional_split`·2-param `reserve_idle_pool_capacity`·`pool_achievable_capacity(worker_cap)`·409 `{achievable_vus,requested_vus}`·`PoolCapacityError`·RunDialog mode-분기 다이얼로그), **L3**(`capacity_split`·`achievable_capacity`·`PoolReservation`·`precomputed_counts`·`?force`), ADR-0037(closed-loop VU 곡선·`run_scenario_vu_curve` park-gate·active-VU 시계열 migration 0016), ADR-0041(L1 풀), A3b(`run_metrics` worker_id + read-merge — migration 0008 패턴, **active-VU 머지가 그대로 미러**), ADR-0035(ko.ts). 런북 `docs/dev/lan-workers.md`. 제품요구 메모리 `load-divergence-explain-confirm`.
- **ADR**: 신규 불필요(ADR-0041 범위 내 additive — L4 spec §7/R11이 예고한 후속). 완료 시 ADR-0041 §귀결·roadmap 갱신.

---

## 1. 문제와 목표

L3는 closed-fixed, L4는 open(고정+곡선) 풀 배정을 `capacity_split`로 cap 존중하게 만들고 용량 부족 시 409+`?force`를 추가했지만, **closed-loop VU 곡선(vu_stages)은 두 곳에서 제외**된다: ① `validate_run_config`(runs.rs:254)가 `max(vu_stages.target) > settings.worker_capacity_vus()`(비-풀 기본 2000)이면 *단일워커* 전제로 400 거부, ② `spawn_run`이 가드 fork `!is_vu_curve()`(precheck 509·dispatch 649)로 곡선을 legacy 경로(`reserve_idle_pool(run_id, 1)` — N=1)로 보낸다. 즉 풀 곡선 run은 워커 선언 `capacity_vus`를 무시하고 곡선 전체를 한 워커에 얹는다(silent 과포화), 집계 풀 용량 안에 드는 곡선도 fan-out 못 한다(under-cap 갭).

이 슬라이스는 **closed VU 곡선 풀 배정이 L3/L4와 동형으로 capacity-aware**가 되게 한다: 곡선 peak VU(`max(vu_stages.target)`)를 `capacity_split`로 N개 풀 워커에 분배(워커당 ≤ `capacity_vus`), 각 워커는 그 몫에 **비례 축소된 vu_stages**를 실행, peak > 풀 achievable이면 **409+줄여 진행/강행/취소**(L3/L4 UX 재사용).

핵심: 기반은 **이미 깔려 있다**. L4가 접근자(`concurrency_demand()`/`pool_worker_cap()`/`vu_curve_max()`)를 곡선에 대해 *미리* peak를 반환하게 만들어 뒀고("vu-curve: vu_curve_max(가드 미호출·완전성)"), 2-param `reserve_idle_pool_capacity(worker_cap, slot_total)`는 곡선에선 둘 다 = peak라 **이미 올바른 `(vu_offset, vu_count)`(=peak 몫)를 산출**한다. 엔진 `run_scenario_vu_curve`는 이미 `plan.vu_offset`(전역 vu_id)·임의 `vu_stages`를 실행한다. 그래서 **예약/enqueue/register·proto·worker·engine 무변경**, 컨트롤러 변경은 ① 가드 fork에서 곡선 제외 제거 ② per-worker `vu_stages` 스케일 ③ active-VU worker_id 머지(유일한 신규 migration) ④ validate pool-게이팅 ⑤ UI 다이얼로그. **유일한 곡선-고유 신규 작업 = active-VU 시계열 N>1 머지**(곡선만 갖는 게이지 테이블, migration 0016) — A3b `run_metrics` 패턴 그대로.

- **목표**: ① 곡선 peak를 `capacity_split`로 cap 존중 샤딩(가드 fork `!is_vu_curve()` 제거). ② 각 워커 `vu_stages.target`을 슬롯 몫에 **비례 분배**(`proportional_split`, 0-share는 엔진 park 흡수 — closed 곡선엔 open-loop 고정 rate의 `.max(1)` 초과발사 문제 없음). ③ active-VU 시계열을 worker_id로 분리·읽기 SUM(N>1 정확·N=1 byte-identical). ④ peak > 풀 achievable이면 409 `{achievable_vus, requested_vus=peak}` → run 미생성. ⑤ RunDialog closed+curve 용량 프리뷰 + 409 다이얼로그(**곡선 비례 축소** clamp + **부하가 어떻게 달라지는지 자세한 설명**, 제품요구).
- **비목표(연기)**: §7. 비-풀 곡선 fan-out(roadmap §B9)·L3/L4 다이얼로그 자세한-설명 소급·곡선 active-VU CSV/XLSX 열·per-stage 워커 분해·dataset `unique` 비례 분할·measured rate capacity·하트비트·제어 액션·mTLS.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

> MUST/SHOULD는 전부 여기 행으로. 산문(§3·§4)은 근거·방법만. **흘리기 쉬운 불변식/byte-identical/fallback/seam을 특히 R로.**

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | `MUST` closed VU 곡선 풀 배정 capacity-aware: 가드 fork 조건 `!is_open_loop() && !is_vu_curve()`→이미 L4가 `!is_vu_curve()`로 좁혔으니 **그 `!is_vu_curve()` 제외를 precheck(509)·dispatch fork(649) 두 곳에서 제거**해 곡선도 capacity-aware 경로로. 곡선 호출은 `reserve_idle_pool_capacity(worker_cap=pool_worker_cap()=peak, slot_total=concurrency_demand()=peak)` → `N=min(idle, peak)`·`counts=capacity_split(peak, caps[..N])`(각 워커 peak 몫=`vu_count`≥1). **접근자(`concurrency_demand`/`pool_worker_cap`/`vu_curve_max`)·예약·enqueue·register 무변경**(L4 prewired). | 통합 `pool_vu_curve_assigns_capacity_aware`(이질 cap 풀 → 곡선 peak가 cap 존중 분배·각≤cap·Σ=peak) / 라이브 | |
| R2 | `MUST` per-worker `vu_stages` 비례 스케일: `reduce_open_loop_profile`을 **`reduce_pool_profile`로 개명**(open+곡선 샤딩 둘 다 처리; 단일 call site `assignment_for`(coordinator.rs:612) + 인라인 테스트 2곳 coordinator.rs:~1631-1693/~2407-2413 갱신)의 early-return 가드를 곡선 포함으로(`shard_count<=1 \|\| (!is_open_loop && vu_stages.is_empty())`), 곡선 분기 추가 — 각 `vu_stages[].target`을 `slot_weights`(=워커별 `vu_count`=peak 몫, `assignment_for`가 `precomputed_counts`서 도출) 기준 **`Some`→`proportional_split`**(0-share OK·합=stage.target) / **`None`→`shard_split`**(force/비-풀 균등). open-loop stage 처리(L4)와 동형. | 단위 `reduce_pool_profile_scales_vu_stages`(peak 50·weights[5,25] → 워커별 stage 비례·sub-peak 0-share·Σ=stage.target) | |
| R3 | `MUST`(불변식·parity) **peak stage 스케일 == `vu_count`(슬랩 크기·offset 정합)**: `weights=capacity_split(peak,caps)`라 `Σweights=peak` → `proportional_split(peak, weights)==weights`(largest-remainder identity) → 각 워커의 *최고* 스케일 stage == 그 `vu_count`. 그리고 **전역 vu_id 무겹침**: `vu_offset_i = Σ_{k<i} vu_count_k`·`Σvu_count=peak`. **reserved 워커마다 peak 몫 ≥1**의 근거 = `N=min(idle,peak)≤peak`라 균등 몫 `peak/N≥1`(+`capacity_split`의 cap-floor `.max(1)`이 0-cap 워커를 0으로 만들지 않음 — `.max(1)`은 *할당*이 아니라 *cap*에 적용, F1) → 워커별 vu_id 구간 `[off, off+count)` disjoint·`[0,peak)` 덮음(`${vu_id}`·unique-dataset 정합). | 단위 `vu_curve_peak_stage_equals_vu_count` + `vu_curve_offsets_disjoint_cover_peak` | |
| R4 | `MUST` active-VU 시계열 N>1 정확 머지(해법 1 = A3b `run_metrics` 미러): **migration 0018** `run_active_vu_metrics` PK에 `worker_id` 추가(A3b 0008 "Rust-guarded new-table + copy(worker_id='')" 패턴·멱등 가드)·워커별 keep-last UPSERT(`ON CONFLICT(run_id,ts_second,worker_id)`); ingest(coordinator.rs:1308 `ActiveVuRow`)에 `worker_id: batch.worker_id.clone()` 1줄(run_metrics:1229 동형·**proto 0**); 읽기 `active_vu_series`를 `SELECT ts_second, SUM(desired), SUM(actual) … GROUP BY ts_second ORDER BY ts_second`로. SUM(desired)=원곡선 총 desired·SUM(actual)=총 활성 VU 재구성. | store 단위 `active_vu_worker_id_rows_coexist_and_sum`(워커별 행 공존·SUM 머지, A3b `distinct worker_id rows coexist` 미러) + `active_vu_n1_byte_identical`(단일 worker_id → SUM == 종전 출력) | ✅ migration 0018 + read path(`ReportJson.active_vu_series` 출력 N=1 byte-identical) |
| R5 | `MUST` non-force 곡선 풀 run이 **유휴>0 AND `concurrency_demand()(=peak) > achievable`**면 **409 `{achievable_vus, requested_vus}`**(requested=peak) + **insert *전* 사전검사로 run 미생성**(L3/L4 R3 패턴). precheck `pool_achievable_capacity(pool_worker_cap()=peak)` = 예약과 같은 N·부분집합. **유휴==0 = 기존 빈-풀 400**. L3/L4 `ApiError::ConflictJson`·`PoolCapacityError` **재사용**(타입·client 0-churn). | 통합 `pool_vu_curve_insufficient_returns_409`(저-cap·큰 peak → 409 본문·`runs::get` None) + `pool_vu_curve_zero_idle_400` | ✅ REST wire(L3/L4 재사용) |
| R6 | `MUST` `?force=true` 곡선도 가드를 **건너뛰고** legacy even-split fan-out: legacy 경로 `n_cap`(runs.rs:705)을 곡선에서 `1`→**`vu_curve_max()`**(peak)로 → `reserve_idle_pool(peak)`·register `shard_split`·`reduce_pool_profile(slot_weights=None)`이 vu_stages를 `shard_split` 균등 분배. **현재 N=1 곡선 force가 even-split fan-out으로 바뀜**(과부하 강행을 워커에 균등 분산 — "설정 부하 그대로 발생"에 충실, L3/L4 force와 일관). | 통합 `pool_vu_curve_force_skips_guard`(저-cap + `?force` → 201·곡선 even-split N>1·vu_stages 균등) | ✅ REST surface(`?force` 재사용) |
| R7 | `MUST` `validate_run_config`(runs.rs:254)의 단일워커 거부(`max(vu_stages.target) > worker_capacity_vus()` → 400 "…단일 워커…")를 **`!state.coord.is_pool_mode()` 게이트** — 풀 모드면 이 거부 생략(실제 풀 용량 대비 R5 409가 권위), 비-풀 모드는 유지(비-풀 곡선은 N=1 v1). 다른 곡선 검증(stage `duration>=1`·`≥1 target>0`·노브 충돌 ①–⑧)은 양 모드 유지. | 단위 `validate_vu_curve_pool_defers_to_guard`(풀 모드: peak>2000도 validate 통과) + `validate_vu_curve_nonpool_rejects`(비-풀: 종전 400) | |
| R8 | `MUST` RunDialog 총 용량 프리뷰("유휴 M대 · 총 용량 X VU")의 초과 힌트를 **closed+curve arm으로 확장**(곡선 `vu_curve_max()(=폼 stage peak) > X`면 힌트). closed+fixed(L3)·open(L4) 유지. 비-풀·곡선 미설정 = 힌트 미표시·byte-identical. 기존 `usePoolWorkers` 재사용. **프리뷰 X=풀 전체 Σcap(best-effort 상한)**: `idle>peak`면 서버 achievable(first-`min(idle,peak)` 부분집합, R5)보다 클 수 있으나 **서버 409가 권위**(정확 achievable를 다이얼로그에 표시) — 프리뷰는 힌트, parity 주장 아님(L4 R8 동형, ui/CLAUDE.md). | RTL `RunDialog`(closed+curve peak>X 힌트·≤X 부재·비-풀 무힌트) | ✅ Zod(L2 `capacity_vus` 재사용) |
| R9 | `MUST` 409 확인 다이얼로그를 곡선으로 확장 + **clamp 분기를 명시적 3-way로**: 현 `RunDialog.tsx:810` `isOpenLoop = loadModel==="open"` 2분기 ternary(closed→`vus` clamp)는 closed+curve를 잘못된 `vus` clamp arm으로 보낸다(곡선은 `vus:0`+`vu_stages` → no-op) → **closed-fixed(`vus=achievable`) / open(`max_in_flight=achievable`) / closed-curve(`scaleVuStages`)** 3분기로 교체. **[줄여 진행]=곡선 비례 축소** — 순수 `scaleVuStages(stages, achievable, peak)`(각 `target=round(target×achievable/peak)`·**최고점 stage ≥1 floor**·`≥1 target>0` 보장)로 폼 stage 값 재작성 후 재전송. **[강행]**=`?force=true`·**[취소]**=미생성. | RTL `RunDialog`(곡선 409 mock → `scaleVuStages` 폼 재작성·재전송 stages peak==achievable·`vus` clamp arm 미진입·강행 `?force`·취소 미전송) + 단위 `scaleVuStages`(비례·peak≥1 floor·shape 유지) | ✅ REST wire(R5 본문 ↔ UI) |
| R10 | `MUST`(제품요구 `load-divergence-explain-confirm`) 409 다이얼로그가 **실제 부하가 설정과 어떻게 달라지는지 자세히 설명** + 발생 여부 확인: [줄여 진행]=곡선 N배 축소 → 설정보다 *낮은 부하*(예 "최고점 50→30 VU, 각 단계 0.6배") / [강행]=용량 X에 peak 배정 → 워커 과부하로 *실제 부하 목표 미달 가능*. **정상 fan-out(peak≤X, 총량 보존)은 divergence 아님 → 다이얼로그 없이 실행.** 문구는 `ko.capacityGuard` 곡선 변형. | RTL: 곡선 다이얼로그에 축소 배율/강행 경고 문구 존재 + 정상 fan-out(peak≤X) run은 다이얼로그 미표시 | |
| R11 | `MUST`(불변식) **byte-identical / 무변경**: ① 비-풀 곡선(N=1·validate 254 유지) ② 단일워커 풀 곡선(peak가 1 워커에 다 들어가거나 유휴 1대 → `shard_count=1`→`reduce_pool_profile` early-return·active-VU 단일 worker_id→SUM 동일) ③ active-VU N=1 출력(`ReportJson.active_vu_series`) ④ closed-fixed·open(L3/L4)·비-곡선·**rows≥N 풀 unique 전부**. **proto·worker·engine 0 · migration 1(0018)**. **의도적 비-byte-identical(동작 변경) 2건**: **⑤** 풀 곡선 `?force`가 N=1→even-split fan-out(R6, 사용자 결정) · **⑥** closed-fixed/open/곡선 풀 + unique + `rows<N`이 언바운드-부하 실행→거부(R14 선재 버그 fix). | 기존 곡선/closed/open 풀·비-풀 스위트 green + active-VU N=1 출력 단언 + `cargo build --workspace`(proto/engine 0 diff) + ⑤⑥ 동작변경 테스트(R6/R14) | |
| R12 | `SHOULD` 신규/수정 UI 문구 전부 `ko.*`(ADR-0035 인라인 0)·곡선 mode-aware 단위(VU/슬롯). | grep: 신규/수정 컴포넌트 `ko.*`·인라인 0 | |
| R13 | `MUST`(보안) 409 본문은 **`{achievable_vus, requested_vus}` 두 정수뿐**(worker_id·hostname·token·시크릿 0, L3 R12/L4 R13 재사용). `?force`는 가드만 우회·gRPC `check_token` 비우회. active-VU worker_id는 DB 내부 키일 뿐 `ReportJson` 미노출. | security-reviewer + 409 본문 grep + `active_vu_series` SUM이 worker_id 비노출 | |
| R14 | `MUST`(안전·신규·**선재 fix**) **풀 모드 `unique` 빈-슬라이스 언바운드 부하 차단 — 예약-시점 실제 N 기준**(사용자 결정 2026-06-22 "3모드 일괄"): `spawn_run`이 풀 워커를 예약해 `n_pool`을 안 직후, 각 `unique` 바인딩 `row_count >= n_pool` 검사 — 미달이면 `mark_failed` + 명확한 에러(`rows=X < workers=N`). **곡선+closed-fixed+open 풀 세 모드 공통**(예약 N은 셋 다 동적 `min(idle, *cap)`이라 validate `n`[runs.rs:430, 비-풀 worker_count]과 불일치 → 빈 unique 슬라이스 = 언바운드, 루트 CLAUDE.md). **L3/L4 선재 위험까지 닫음.** validate-time floor(runs.rs:466)는 비-풀(결정적 N)에 유지. SHOULD: insert *전* best-effort precheck(`min(idle, worker_cap)` vs unique rows → 409 no-row, 자본 가드 패턴) + 예약-시점 authoritative recheck(TOCTOU). `?force`도 예약 경로라 커버. per_vu/iter_*는 복제라 무관. | 통합 `pool_unique_rows_lt_workers_rejected`(곡선·closed-fixed·open — 단일 spawn_run 삽입점이 3모드 공통) + `pool_unique_rows_ge_workers_ok` | ✅ REST(에러 본문) |

- **`seam?`** — 와이어 변경은 **R4(migration 0018 + active-VU read SUM)가 유일한 신규**, 나머지는 **L3/L4 재사용**: R5/R9(REST 409 `{achievable_vus,requested_vus}` ↔ UI·`?force`)·R8(L2 `capacity_vus` Zod). **proto·DB(active-VU 외)·엔진 0**(R11). `reduce_open_loop_profile`은 곡선 분기만 가산(시그니처 무변경 — `slot_weights` 이미 L4가 추가). plan은 컨트롤러 가드 task와 UI 다이얼로그 task를 같은 계약으로 묶고, 최종 `handicap-reviewer`가 ① active-VU migration↔read SUM ② 409 본문↔UI 파싱을 1:1 대조.

---

## 3. 핵심 통찰 (설계 근거)

1. **기반이 L4에 이미 깔려 있어 곡선 가드는 "제외 제거 + vu_stages 스케일"이 거의 전부.** L4 접근자가 곡선에 대해 `concurrency_demand()=pool_worker_cap()=vu_curve_max()=peak`를 반환하고("vu-curve: …가드 미호출·완전성"), 2-param `reserve_idle_pool_capacity(worker_cap, slot_total)`는 곡선에선 둘 다 peak라 `capacity_split(peak, caps)`로 워커별 peak 몫=`vu_count`를 *이미* 산출한다. 엔진 `run_scenario_vu_curve`는 `plan.vu_offset`(전역 vu_id)·임의 `vu_stages`를 이미 실행. 그래서 예약/enqueue/register·proto·engine·worker 0 — 가드 fork `!is_vu_curve()`만 제거하면 슬롯(=peak 몫)은 끝. [R1]

2. **곡선 stage 스케일은 open-loop 곡선(L4)과 동형 — 단 0-share 정책이 더 단순.** 각 워커 vu_stages를 `proportional_split(stage.target, weights)`(weights=peak 몫)로 비례 축소. open-loop *고정 rate*는 0-share를 엔진 `.max(1)`이 1로 clamp해 초과 발사하므로 `proportional_split_min1`이 필요했지만, **closed 곡선은 그 문제가 없다**: `run_scenario_vu_curve`의 `desired=rate_at(vu_stages).round()`엔 min-1 floor가 없어 0-VU stage는 그냥 park(미발사). 그래서 `proportional_split`(0-share 허용)로 충분하고 합=stage.target 정확. [R2]

3. **peak stage 스케일이 `vu_count`와 정확히 같아 offset 회계가 정합**(R3). `weights=capacity_split(peak,caps)`라 `Σweights=peak`이고, `proportional_split(peak, weights)`는 total==Σweights이면 weights를 그대로 반환(largest-remainder identity). 따라서 각 워커의 *최고* 스케일 stage == 그 `vu_count`(슬랩 크기)이고, `vu_offset_i=Σ_{k<i}vu_count_k`가 disjoint vu_id 구간을 준다. **reserved 워커마다 peak 몫 ≥1**의 근거(F1 정정) = `N=min(idle,peak)≤peak`라 균등 몫 `peak/N≥1`이고, `capacity_split`의 `.max(1)`은 *할당*이 아니라 *cap*에 적용돼 0-cap 워커가 0으로 떨어지는 것만 막는다(할당 0은 `total<n`일 때만인데 여기선 `peak≥N`이라 불가). → peak에서 빈 워커 없음. sub-peak stage는 비례로 0-share 가능(park). [R3]

4. **active-VU 머지가 유일한 곡선-고유 신규 작업 — A3b `run_metrics`가 *바로 이 문제*를 푼 패턴이라 그대로 미러(해법 1).** `run_active_vu_metrics`(migration 0016, 곡선 전용 게이지)는 keep-last UPSERT 키 `(run_id, ts_second)`·worker_id 없음 — N>1이면 워커들이 서로 clobber해 한 워커의 부분 곡선만 남는다(현재 버그). A3b가 `run_metrics`에 worker_id를 PK에 넣고 읽기 시점 머지로 푼 것을 그대로: PK+worker_id·워커별 keep-last(멱등 보존 — 재전달에도 안전)·읽기 `SUM…GROUP BY ts_second`. `batch.worker_id`는 ingest에 이미 있어(run_metrics가 씀) **proto 0**. SUM(desired)=원곡선 총 desired·SUM(actual)=총 활성 VU → 멀티워커 곡선 차트가 *총량*을 정확히 표시. N=1이면 단일 worker_id라 SUM이 종전 값 → 출력 byte-identical. **성능 무영향**: active-VU는 초당 워커당 1행(저빈도 게이지·핫패스 아님), 읽기는 run당 1회(terminal `/report`). 행 수 `초×워커`로 bounded. [R4·R11]

5. **풀 모드에선 capacity 검사를 validate(254)에서 spawn_run 409로 이전**(R7). 비-풀 곡선은 N=1 v1이라 validate 254가 단일워커 cap(2000) 거부를 유지하지만, 풀 곡선은 실제 풀 achievable(Σ선언 cap, 보통 작음)을 봐야 하므로 validate에서 거부하면 안 된다(2000은 풀과 무관한 비-풀 fan-out 설정). `is_pool_mode()`는 컨트롤러 시작 플래그라 save-time/fire-time 안정 — preset/schedule 경로도 일관. [R7]

6. **`?force` 곡선은 even-split fan-out으로 라우팅(L3/L4 force와 일관·현재 N=1에서 변경).** force = "용량 부족해도 설정 부하 발생." 가장 충실한 건 곡선을 가용 워커에 *균등* 분산(과부하 강행)하는 것 — N=1로 한 워커에 다 얹으면 그 워커가 곡선을 못 따라가 목표 부하 자체를 못 낸다. legacy `n_cap`을 곡선에서 `1`→`vu_curve_max()`로, `reduce_pool_profile(None)`이 vu_stages를 `shard_split` 균등 분배. **사용자 확정(2026-06-22): even-split.** 현 N=1에서 동작 변경(byte-identical 아님 — R11 ⑤ 카브아웃). [R6]

7. **제품요구: 부하가 설정과 달라지면 자세한 설명 + 발생 확인**([[load-divergence-explain-confirm]]). 곡선 풀에서 "설정과 다른 부하"는 ① 용량 부족 줄여 진행(곡선 비례 축소 → *낮은 부하*) ② 강행(과부하 → *목표 미달 가능*) 둘뿐 — 409 다이얼로그가 그 구현체이고, 단순 버튼이 아니라 *실제 부하가 어떻게 달라지는지*(축소 배율·과부하 경고)를 명시해야 한다. **정상 fan-out**(peak≤풀 용량, 총량을 워커에 분할만, 합 보존)은 divergence가 아니라 다이얼로그 없이 실행. [R9·R10]

8. **`unique` 빈-슬라이스 언바운드 부하는 풀 동적 N의 *예약 시점*에 검사해야 한다 — 세 모드 공통 근본 원인**(R14·FR1, 사용자 결정 "3모드 일괄"). `validate`의 unique floor(runs.rs:466 `rows >= n`)가 빈-슬라이스 언바운드를 막지만, 그 `n`(runs.rs:430)은 **비-풀 worker_count**(곡선=1·closed=ceil(vus/cap)·open=worker_count)다. 풀 fan-out의 *실제* N은 `min(idle, *cap)`로 **예약 시점에야** 정해져 validate가 모른다 → `rows<N`이면 `dataset_slice`(coordinator.rs:589)가 빈 unique 슬라이스 → 언바운드(루트 CLAUDE.md). 동적 N을 아는 유일한 지점이 예약 직후이므로 `spawn_run`이 `n_pool`을 안 직후 `unique.row_count >= n_pool`을 검사·미달이면 거부 — **곡선뿐 아니라 closed-fixed/open 풀의 선재 위험까지 한 곳에서 닫는다**(L3/L4 잠복 버그 fix). validate floor는 비-풀(결정적 N)에 그대로. capacity 가드(R5)와 같은 precheck(insert 전 409)+recheck(예약 TOCTOU) 패턴 재사용 가능. [R14·R11⑥]

---

## 4. 변경 상세

> 파일·함수 단위. 각 묶음 머리에 **충족 R**.

### 4.1 `crates/controller/src/api/runs.rs` (`spawn_run` 가드 fork + unique floor) — 충족 R: R1, R5, R6, R14
- precheck(509) 조건 `is_pool_mode() && !force && !profile.is_vu_curve()` → `is_pool_mode() && !force`(곡선 포함). demand=`concurrency_demand()`(곡선=peak)·achievable=`pool_achievable_capacity(pool_worker_cap())`(곡선=peak) — L4 로직 그대로 곡선에 적용.
- dispatch fork(649) `let guarded = !profile.is_vu_curve();` → `let guarded = true;`(또는 force만 legacy). 곡선 non-force → `reserve_idle_pool_capacity(peak, peak)`·`enqueue(…, Some(counts))`.
- legacy 경로(705) `n_cap` 곡선 분기 `1` → `profile.vu_curve_max()`(R6 force fan-out).
- **unique 빈-슬라이스 floor(R14)**: 풀 경로에서 예약(`Reserved{workers}`/`reserved`)으로 `n_pool`을 안 직후(=`n_pool` 계산 683 guarded/724 legacy **와** `enqueue` 686/733 *사이*), **`assignment.data_bindings`** 에서 `policy==Unique`인 바인딩의 `row_count`(unique는 TOTAL — runs.rs:566)가 `< n_pool`이면 `cancel_dispatch_failed`+`mark_failed`+에러(Insufficient 분기와 동형). **읽기 소스 주의**: 로컬 `data_bindings` Vec는 line 624에서 `assignment` 리터럴로 **move**되고 `validated_metas`는 line 538 zip으로 소비되므로, 예약-시점엔 둘 다 무효 — `assignment.data_bindings`(enqueue 전까지 소유)에서 읽는다. **곡선·closed-fixed·open·force 전 풀 경로 공통**(guarded·legacy 둘 다). SHOULD: precheck(509)에 `min(idle, worker_cap)` 기반 best-effort unique 검사를 더해 insert 전 409(no-row) — **단 `pool_achievable_capacity`와 같은 first-N(worker_id 정렬) 부분집합**을 봐야 precheck-pass→reserve-fail이 500으로 새지 않음.

### 4.2 `crates/controller/src/grpc/coordinator.rs` (`reduce_open_loop_profile` → `reduce_pool_profile`) — 충족 R: R2, R3
- early-return 가드를 `shard_count<=1 || (!is_open_loop && profile.vu_stages.is_empty())`로.
- **2-arm match로 재구조화**(중요): 현재 `max_in_flight=Some(vu_count)`(908)·`target_rps` 분할(910-915)·`stages` 분할(917-922)이 *무조건* 실행되는데, 가드가 곡선을 통과시키면 곡선 profile에 **spurious `max_in_flight`가 박힌다**(런타임 무해 — 워커가 `is_vu_curve`로 먼저 분기해 `run_scenario_vu_curve`가 `max_in_flight` 무시, but 잘못된 proto 상태). → 두 arm으로 분리: **(open-loop arm, `is_open_loop`)** 기존 `max_in_flight`+레이트(target_rps/stages) 로직 그대로 / **(curve arm, else)** `vu_stages[].target`만 스케일(`match slot_weights { Some(w) => proportional_split(s.target,w)[shard_index], None => shard_split(s.target,shard_count,shard_index).1 }`)·**`max_in_flight`·`target_rps` 미터치**.
- **개명 확정**: `reduce_open_loop_profile` → `reduce_pool_profile`(C2 — open+곡선 풀 샤딩 둘 다 처리하므로 이름이 정확). 단일 call site `assignment_for`(coordinator.rs:612) + 인라인 테스트 2곳(coordinator.rs:~1631-1693/~2407-2413) 심볼 갱신. `is_open_loop`은 헬퍼 로컬 = **proto-local** `profile.target_rps.is_some() || !profile.stages.is_empty()`(coordinator.rs:903) — `pb::Profile`엔 `is_vu_curve()` 없음, store `Profile` predicate import 금지(C3).

### 4.3 active-VU 머지 — 충족 R: R4, R13
- **`store/migrations/0018_run_active_vu_metrics_worker_id.sql`** + `store/mod.rs` const+execute(0017 뒤·`grep -c MIGRATION_SQL` 교차검증) — A3b `ensure_run_metrics_worker_id`(0008) 미러: 기존 테이블에 worker_id 없으면 새 테이블(PK `(run_id,ts_second,worker_id)`)+복사(worker_id='')+교체. 멱등 가드.
- `store/metrics.rs`: `ActiveVuRow`에 `worker_id: String`·`insert_active_vu_batch` UPSERT `ON CONFLICT(run_id,ts_second,worker_id) DO UPDATE`(keep-last per worker)·`active_vu_series` `SUM(desired), SUM(actual) … GROUP BY ts_second`.
- `grpc/coordinator.rs:1308`: `ActiveVuRow { …, worker_id: batch.worker_id.clone() }`(run_metrics:1229 동형).

### 4.4 `crates/controller/src/api/runs.rs` (`validate_run_config`) — 충족 R: R7
- 254 `if s.target > capacity` 거부를 `if !state.coord.is_pool_mode() && s.target > capacity`로. 다른 곡선 검증 무변경. (R7)
- validate-time unique floor(runs.rs:466 `rows >= n`)는 **비-풀(결정적 N)에 그대로 유지** — 풀의 동적-N floor는 §4.1 예약-시점(R14)이 담당.

### 4.5 `ui/` (RunDialog 프리뷰·409 다이얼로그) — 충족 R: R8, R9, R10, R12
- 용량 프리뷰 초과 힌트를 closed+curve arm으로(곡선 `peakStr=vu_curve_max` > X). `usePoolWorkers` 재사용.
- 순수 `scaleVuStages(stages, achievable, peak)`(`sizing.ts` 인근) — 비례·peak stage ≥1 floor.
- 409 다이얼로그 mode 분기에 curve 추가: 줄여 진행=`scaleVuStages` 폼 재작성+재전송·강행=`?force`·취소. `ko.capacityGuard` 곡선 변형(축소 배율·강행 과부하 경고·divergence 설명, R10). `PoolCapacityError`·client.ts 재사용(0-churn).

---

## 5. 무변경 / 불변식 (명시)

- **proto · worker · engine 0**: 곡선 실행(`run_scenario_vu_curve`)·`MetricBatch`·`vu_offset`/`vu_count` 전부 기존 그대로. active-VU worker_id는 `MetricBatch.worker_id`(기존 field)에서 ingest만 읽음.
- **migration 1건(0018)** — active-VU worker_id만. 다른 테이블 무변경.
- **byte-identical**: ① 비-풀 곡선(N=1) ② 단일워커 풀 곡선(`shard_count=1` early-return·active-VU 단일 worker_id) ③ active-VU N=1 출력 ④ closed-fixed·open(L3/L4)·비-곡선·**rows≥N 풀 unique** ⑤ `?force` 비-곡선.
- **의도적 동작 변경(비-byte-identical) 2건**(R11 ⑤⑥): ⓐ 풀 곡선 `?force` N=1→even-split(R6) ⓑ 풀 + unique + `rows<N` 언바운드→거부(R14, 곡선+closed-fixed+open 공통·선재 버그 fix).
- **데이터 바인딩**: per_vu/iter_* 복제 정책 무변경(per_vu slot_count는 이미 `vu_curve_max()`(runs.rs:544), 각 워커가 전역 vu_id로 인덱싱). `unique`는 풀에서 예약-시점 floor(R14)가 `rows<N`을 거부(rows≥N이면 정상 fan-out).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | 통합 `pool_vu_curve_assigns_capacity_aware`(이질 cap → peak cap 존중) | ✅ |
| R2 | 단위 `reduce_pool_profile_scales_vu_stages`(비례·sub-peak 0-share·Σ) | |
| R3 | 단위 `vu_curve_peak_stage_equals_vu_count` + `vu_curve_offsets_disjoint_cover_peak` | |
| R4 | store 단위 `active_vu_worker_id_rows_coexist_and_sum` + `active_vu_n1_byte_identical` | ✅ |
| R5 | 통합 `pool_vu_curve_insufficient_returns_409`(본문·no-row) + `pool_vu_curve_zero_idle_400` | ✅ |
| R6 | 통합 `pool_vu_curve_force_skips_guard`(`?force` → even-split N>1) | ✅ |
| R7 | 단위 `validate_vu_curve_pool_defers_to_guard` + `validate_vu_curve_nonpool_rejects` | |
| R8 | RTL `RunDialog`(closed+curve 힌트) | |
| R9 | RTL `RunDialog`(409 곡선 clamp 재전송) + 단위 `scaleVuStages` | |
| R10 | RTL(축소 배율·강행 경고 문구·정상 fan-out 무다이얼로그) | |
| R11 | 기존 스위트 green + active-VU N=1 출력 단언 + `cargo build --workspace` 0 diff(proto/engine) | |
| R13 | security-reviewer + 409 본문 grep | |
| R14 | 통합 `pool_unique_rows_lt_workers_rejected`(곡선·closed-fixed·open) + `pool_unique_rows_ge_workers_ok` + 라이브 | ✅ |

- **라이브 필수**(`/live-verify`): run-생성·active-VU read·곡선 엔진 경로를 건드림(S-D 갭). 실 pool 2워커(cap[5,25]=30) — ① 곡선 peak 50 → 409 `{achievable_vus:30, requested_vus:50}`+row 0 ② 곡선 peak 28 → fan-out·active-VU SUM 차트(desired 원곡선 복원·actual 총합) ③ `?force` peak 50 → 201 over-subscribe even-split ④ 단일워커 곡선 byte-identical + Playwright(프리뷰·409 다이얼로그 곡선 축소/강행 설명·`scaleVuStages` 폼 재작성·Zod 0).

---

## 7. 의도적 연기 (roadmap §B/§LAN에 누적)

- **비-풀 곡선 fan-out**(roadmap §B9 "곡선 멀티워커 샤딩"): 비-풀(subprocess/k8s) 곡선은 N=1 유지·validate 254 단일워커 거부 유지. 풀 가드와 별개 메커니즘(`worker_count(peak, settings.capacity)`)이라 별도 슬라이스.
- **L3/L4 다이얼로그 자세한-설명 소급**(제품요구 일관성): closed-fixed·open 409 다이얼로그도 R10 수준의 "실제 부하 차이" 설명으로. `ui/`-only follow-up.
- **풀 `unique` 행수 부족 시 capacity-비례 재분배**(R14는 `rows<N`을 *거부*만): 행을 워커에 비례 재분배해 빈 슬라이스를 피하는 적응형 슬라이싱은 연기. roadmap §B9 "dataset unique 비례 분할"과 묶음. (R14가 언바운드 위험은 이미 닫았으므로 이건 편의 개선.)
- **곡선 active-VU CSV/XLSX 열 · per-stage 워커 분해 리포트 · measured-rate capacity · 하트비트 · 제어 액션(disconnect/exclude/cap) · mTLS** — 기존 L1–L4 연기 목록 그대로.

---

## 8. 구현 순서 (plan 입력)

> cargo-영향 커밋마다 전체 워크스페이스 게이트 → green fold 지점 명시. seam(active-VU migration↔read)은 한 커밋으로.

1. **(green) `reduce_pool_profile` 곡선 스케일 + 단위(R2/R3)** — 순수 헬퍼·`proportional_split` 재사용·offset parity 단위. (call site 무변경이라 단독 green.)
2. **(green) active-VU worker_id 머지(R4/R13)** — migration 0018 + `ActiveVuRow.worker_id` + ingest 1줄 + read SUM + store 단위(공존·SUM·N=1 byte-identical). seam 한 커밋(migration↔read 동시).
3. **(green) 가드 fork 곡선 포함 + validate pool-게이팅 + force fan-out + 예약-시점 unique floor(R1/R5/R6/R7/R14)** — precheck/dispatch `!is_vu_curve()` 제거·`n_cap` 곡선 peak·validate `is_pool_mode` 게이트 + spawn_run 예약 후 `unique.row_count>=n_pool` 검사(3모드 공통) + 통합 테스트(capacity-aware·409·force·zero-idle·unique-rows<N reject).
4. **(green) UI 프리뷰·409 다이얼로그·`scaleVuStages`(R8/R9/R10/R12)** — `ui/` 가산·RTL·`ko.capacityGuard` 곡선 변형·divergence 설명.
5. **라이브 검증(R-전반)** + finish(build-log·roadmap·ADR-0041 §귀결·CLAUDE 상태줄·메모리).

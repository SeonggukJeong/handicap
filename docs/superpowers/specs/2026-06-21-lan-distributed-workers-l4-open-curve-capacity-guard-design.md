# LAN 분산 워커 L4 — open-loop/곡선 과부하 가드 (capacity-aware 슬롯 배정 + 비례 레이트, ADR-0041 후속)

> **이 파일의 척추는 §2 요구사항 표(R-id)다.** plan·구현·리뷰가 전부 이 ID를 참조한다.

- **날짜**: 2026-06-21
- **상태**: 설계 초안(spec-plan-reviewer 2라운드 반영 — Resolution A 확정) → 사용자 리뷰 대기
- **출처**: roadmap §LAN 분산 / ADR-0041 §연기 + L3 spec §7 "open-loop / VU 곡선 capacity 가드"(별도 슬라이스). **왜 지금**: L3가 closed-loop 풀 배정만 capacity-aware로 만들었다 — open-loop(고정·곡선) 풀 run은 여전히 legacy 균등 경로(`reserve_idle_pool`)로 빠져 워커 선언 `--capacity-vus`를 무시한다. 이질 PC 풀(L3가 노린 시나리오)에서 open-loop도 과부하 가드가 있어야 운용이 완결된다.
- **연관**: **L3**(`2026-06-20-lan-distributed-workers-l3-capacity-guard*` — `capacity_split`·`achievable_capacity`·`reserve_idle_pool_capacity`/`PoolReservation`·`precomputed_counts`·409 `{achievable_vus,requested_vus}`·`PoolCapacityError`·RunDialog 프리뷰/힌트/409 다이얼로그·`?force`), ADR-0041(L1 풀), ADR-0038(open-loop 멀티워커 fan-out — `reduce_open_loop_profile` rate split·legacy `n_cap=min(max_in_flight,rate)`), ADR-0031(open-loop·`max_in_flight` 슬롯풀), ADR-0018(슬롯=VuClient=동시성), ADR-0035(ko.ts). 런북 `docs/dev/lan-workers.md`.
- **ADR**: 신규 불필요(ADR-0041 범위 내 additive — L3 spec §7이 예고한 후속). 완료 시 ADR-0041 §귀결·roadmap 갱신.

---

## 1. 문제와 목표

L3는 closed-loop 풀 배정을 `capacity_split`(워커당 `≤ capacity_vus`)로 만들고 용량 부족 시 409+`?force`를 추가했지만, **open-loop(고정·곡선)는 가드 fork 조건 `!is_open_loop() && !is_vu_curve()`에서 제외**돼 legacy 균등 경로(`reserve_idle_pool` + `register` 내부 `shard_split`)로 빠진다. 즉 open-loop 풀 run은 워커 선언 `capacity_vus`를 무시하고 `max_in_flight`(슬롯 풀)를 균등 분할해 능력 작은 워커를 과포화시킬 수 있다. 이 슬라이스는 **open-loop 풀 배정이 워커당 `capacity_vus`를 존중**(슬롯=`capacity_split`)하고, **레이트를 슬롯에 비례 분배**(슬롯당 부하 균등)하며, 풀 용량 부족 시 **L3와 동일한 409+줄여진행/강행** UX를 open-loop에도 제공하게 만든다.

핵심 설계: open-loop은 세 수량(슬롯=`max_in_flight`, 레이트=`target_rps`/`stage.target`, 워커수 N)이 얽힌다. **capacity는 슬롯 단위**라 가드는 `max_in_flight` vs Σcap만 본다(§3.2). 고정 모드 레이트는 **0-share 워커를 만들면 안 된다** — 엔진이 0-rate 고정 워커를 `≥1`로 clamp(`runner.rs:1093`)해 초과 발사하기 때문. 두 겹으로 막는다: **N 레이트-상한**(`worker_cap = min(max_in_flight, rate_peak)`로 `rate≥N` 보장) + **고정 rate는 min-1 floored 비례 분배**(`proportional_split_min1` — 이질 cap에서 작은 슬롯 워커가 0으로 반올림되는 것까지 차단). 그래서 L3 단일 `total_vus`를 **`(worker_cap, slot_total)` 2-param으로 일반화**(closed면 둘 다 `vus`=L3 불변)한다(§3.4).

- **목표**: ① open-loop(고정+곡선) 풀 슬롯(`max_in_flight`)을 `capacity_split`로 cap 존중 분배. ② 레이트(`target_rps`·각 `stage.target`)를 슬롯 할당에 비례 분배 — 슬롯당 부하 균등화(곡선=`proportional_split` 정확 비례·고정=`proportional_split_min1` 각≥1 보장한 근사 비례). ③ N을 `min(max_in_flight, rate_peak)`로 상한 + 고정 rate min-1 floor → **레이트 초과 발사 0**(이질 cap 포함). ④ 용량 부족 시 409 `{achievable_vus, requested_vus}`(requested=`max_in_flight`)로 run 미생성 → UI "줄여 진행(=max_in_flight를 achievable로 clamp) / 강행(force) / 취소". ⑤ RunDialog 총 용량 프리뷰+초과 힌트를 open+fixed·open+curve로 확장.
- **비목표(연기)**: §7. closed-loop VU 곡선(vu_stages) 풀 가드(단일워커 v1·갭 존속)·dataset `unique` 비례 분할(L3 R12 그대로)·measured rate capacity·degraded 모드·하트비트·제어 액션·mTLS.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

> MUST/SHOULD는 전부 여기 행으로. 산문(§3·§4)은 근거·방법만. **흘리기 쉬운 불변식/byte-identical/fallback/seam을 특히 R로.**

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | `MUST` `Profile`(`store/runs.rs`)에 순수 접근자 2개: **`concurrency_demand() -> u32`**(슬롯 총량 = capacity_split·가드 demand — closed:`vus`, open:`max_in_flight.unwrap_or(1)`, vu-curve:`vu_curve_max()`[미사용]) + **`pool_worker_cap() -> u32`**(N 상한 — closed:`vus`, open:`min(max_in_flight, rate_peak)`, `rate_peak`=`target_rps` OR `max(stage.target)`). closed면 두 값 동일(=`vus`)=L3. **`pool_worker_cap`은 풀 전용 N 상한이며 ADR-0038 `worker_count` 노브(비-풀 fan-out 전용)와 무관**(N3). | 단위 `concurrency_demand_by_mode`/`pool_worker_cap_by_mode`(closed=vus·open 두 값·rate_peak=curve max) | |
| R2 | `MUST` 순수 분배 헬퍼 2종(`grpc/shard.rs`, tonic-free), 둘 다 **Σ == total**·결정적(동률 인덱스 오름차순)·**`weights` 전부 같으면 == `shard_split` per-worker**(앞 `total%n`개 +1 → 균등 cap byte-identical 구성 보장, R7): **(i) `proportional_split(total, weights)`** = 비례(최대-잉여), 0-share 허용(곡선 stage용 — 엔진이 0-rate를 poll). **(ii) `proportional_split_min1(total, weights)`** = 각 워커 **≥1** 후 잔여(`total - n`)를 비례 분배(고정 rate용 — 0-share 금지). `total >= n` 전제(R3 rate-bound가 보장); `total < n`/합 0/빈 = 방어 fallback. | 단위 `proportional_split_*`(Σ·uniform==shard_split[remainder≠0]·비례) + `proportional_split_min1_*`(각≥1·Σ·uniform==shard_split·heterogeneous no-zero 예 `(3,&[1,25])==[1,2]`) | |
| R3 | `MUST` open-loop(고정+곡선) 풀 배정 capacity-aware: 가드 fork 조건 `!is_open_loop() && !is_vu_curve()` → **`!is_vu_curve()`**(closed+open). `reserve_idle_pool_capacity`를 **2-param 일반화** `(run_id, worker_cap, slot_total)`: `N = min(idle, worker_cap)`, `counts = capacity_split(slot_total, caps[..N])`. closed 호출은 `worker_cap == slot_total == vus`(L3 동작·결과 불변). open이면 슬롯이 cap 존중·각 `≤ caps[i]`·Σ=`max_in_flight`. | 통합 `pool_open_loop_assigns_capacity_aware`(이질 cap → 불균형 슬롯·각≤cap·합=max_in_flight) / 라이브 | |
| R4 | `MUST` open-loop 레이트를 슬롯 할당에 비례 분배하되 **모드별 0-share 정책**: `reduce_open_loop_profile`(coordinator.rs:873, **`assignment_for`(556)가 호출**)에 5번째 인자 `slot_weights: Option<&[u32]>` 추가 — `assignment_for`가 `rw.precomputed_counts`(전체 슬롯 벡터)에서 도출(`register`는 RegisterOutcome 반환 후 종료라 전체 벡터 미보유). `Some(w)`면 **고정 `target_rps` → `proportional_split_min1`**(모든 워커 ≥1 → `runner.rs:1093`의 `.max(1)` clamp가 0-share를 1로 왜곡해 **초과 발사하는 것을 차단**, §3.4) / **각 곡선 `stage.target` → `proportional_split`**(0-share는 엔진이 poll·미발사라 무해, 합=stage.target). `None`(force/비-풀/subprocess)이면 현 `shard_split` 균등. 슬롯(`max_in_flight=vu_count`, 884) 무변경. **R3 rate-bound(N≤rate_peak)가 min1의 `total≥n` 전제를 보장**. | 통합 `pool_open_loop_rate_proportional`(**곡선 stage**=정확 비례 `proportional_split` 예 `[5,25]`·Σ=stage.target / **고정 target_rps**=min1 `proportional_split_min1` 예 `[6,24]`·Σ=target_rps) + `pool_open_loop_no_zero_rate_fixed`(이질 cap `[1,25]`·저 rate → 모든 워커 rate≥1·Σ=target_rps·초과 0) | |
| R5 | `MUST` non-force open-loop 풀 run이 **유휴>0 AND `concurrency_demand()(=max_in_flight) > achievable`**면 **409 `{achievable_vus, requested_vus}`**(requested=`max_in_flight`) + **insert *전* 사전검사로 run 미생성**(L3 R3 패턴). 사전검사는 `pool_achievable_capacity`를 **`worker_cap` 인자로 일반화** → `(idle, Σcaps[..min(idle, worker_cap)])`(예약과 **같은 N·같은 부분집합**을 봐 사전검사·예약 결과 일치, §3.5). **유휴==0 = 기존 빈-풀 400**. L3 `ApiError::ConflictJson`·`PoolCapacityError` **재사용**(타입·client 0-churn). | 통합 `pool_open_loop_insufficient_returns_409`(저-cap·큰 max_in_flight → 409 본문 숫자·`runs::get` None) + `pool_open_loop_zero_idle_400` | ✅ REST wire(L3 재사용) |
| R6 | `MUST` `POST /api/runs?force=true` open-loop도 가드를 **건너뛰고** 기존 legacy even-split 경로(`reserve_idle_pool` + register `shard_split` + `reduce_open_loop_profile` `slot_weights=None` 균등)로 라우팅 → L1/ADR-0038 byte-identical. | 통합 `pool_open_loop_force_skips_guard`(저-cap + `?force=true` → 201·균등 슬롯/레이트) | ✅ REST surface(`?force` 재사용) |
| R7 | `MUST`(불변식) **(a) byte-identical**: 균등 cap 풀 **AND `rate_peak ≥ max_in_flight`**(흔한 처리량 테스트) → `worker_cap=max_in_flight`·`capacity_split==shard_split`·min1/`proportional_split==shard_split`(uniform)·N 동일 → **ADR-0038 풀 open-loop과 byte-identical**. **(b) 레이트 충실(no overshoot, 이질 cap 포함)**: 고정 모드는 `min1`(모든 워커 ≥1)이라 0-share clamp 왜곡이 없어 발사 레이트 == 목표(이질 cap에서도 초과 0); 곡선 모드는 0-share를 poll로 흡수해 합=stage.target. 슬롯이 부분집합에 안 들어가면 **정직한 409**(silent 변형 없음). ADR-0038 검증(runs.rs:362-371 "고정모드 target_rps≥worker_count")의 동일 규율을 capacity-비례 경로에 적용. **proto·worker·engine·migration 0.** 비-풀·`?force`·closed-loop VU곡선·closed-loop 고정 무변경(closed 결과 불변). | 단위(R2 두 헬퍼) + 통합 `pool_open_loop_homogeneous_byte_identical`(균등 cap·rate≥max_in_flight = ADR-0038) + `pool_open_loop_no_zero_rate_fixed`(R4) + 기존 closed 풀/fan-out 스위트 green | |
| R8 | `MUST` RunDialog 총 용량 프리뷰("유휴 M대 · 총 용량 X VU", X=Σ유휴 cap)의 초과 힌트를 **open+fixed·open+curve로 확장**(open이면 `max_in_flight > X`). **프리뷰 X=풀 전체 용량(best-effort 상한)**: `rate_peak ≥ max_in_flight`(흔함)면 서버 achievable과 동일(정확)하고, `rate_peak < max_in_flight`(드묾)면 서버는 부분집합(R5)이라 힌트가 under-warn할 수 있으나 **서버 409가 권위**(정확한 achievable를 다이얼로그에 표시). closed+fixed(L3) 유지. 비-풀·`max_in_flight` 미설정 = 힌트 미표시·byte-identical. | RTL `RunDialog`(open+fixed·open+curve `max_in_flight>X` 힌트·`≤X` 부재·비-풀 무힌트) | ✅ Zod(L2 `capacity_vus` 재사용) |
| R9 | `MUST` 409 확인 다이얼로그(줄여 진행/강행/취소)를 open-loop로 확장: **[줄여 진행] = `max_in_flight`를 `achievable_vus`로 clamp 후 재전송**(`target_rps`·`stages` 불변) + 다이얼로그에 **"동시 슬롯만 줄입니다 — 목표 RPS는 유지되어 드롭이 늘 수 있어요(포화 시 워커를 늘리세요)"** 안내. **[강행]**=`?force=true`. **[취소]**=미생성. closed의 clamp(`vus`)와 mode 분기(closed→`vus`·open→`max_in_flight`). | RTL `RunDialog`(open 409 mock → clamp `max_in_flight:X` POST·`target_rps` 유지·강행 `?force`·취소 미전송·안내문 존재) | ✅ REST wire(R5 본문 ↔ UI) |
| R10 | `SHOULD` 신규/수정 UI 문구 전부 `ko.*`(ADR-0035 인라인 0) + **mode-aware 단위 표기**: open-loop 다이얼로그/힌트는 clamp 대상이 `max_in_flight`(동시 슬롯)라 "VU" 대신 슬롯/동시 요청 표현(기존 `ko.capacityGuard` VU-워딩을 mode 분기). | grep: 신규/수정 컴포넌트 `ko.*`·인라인 0 + open 다이얼로그 슬롯-워딩 | |
| R11 | `MUST`(무변경·문서) **closed-loop VU 곡선(vu_stages) 풀 경로 무변경** — 여전히 N=1 legacy(`reserve_idle_pool(run_id,1)`·precomputed `None`·`slot_weights=None`), capacity 가드 **미적용**(풀 모드 vu-curve가 under-cap 워커에 배정될 수 있는 갭 *존속*). 가드 fork `!is_vu_curve()`가 vu-curve를 의도적으로 legacy로 보냄. 명시 연기 + 한계 노트. | `spawn_run` vu-curve 분기 diff 0 + 한계 노트 | |
| R12 | `MUST`(무변경·문서) dataset `unique` 슬라이싱(`dataset_slice`) **무변경**(L3 R11 그대로) — capacity-비례 분할 연기. disjointness 보존(각 행 ≤1회·`rows<N` 게이트 무영향), 소비 속도만 불균등. | `dataset_slice` diff 0 + 한계 노트 | |
| R13 | `MUST`(보안) 409 본문은 **`{achievable_vus, requested_vus}` 두 정수뿐**(worker_id·hostname·token·시크릿 0, L3 R12 재사용). `?force`는 가드만 우회·`check_token` 비우회. | security-reviewer + 409 본문 token/hostname 부재 grep | |

- **`seam?`** — 와이어 변경은 **전부 L3 재사용**: R5/R9(REST 409 `{achievable_vus, requested_vus}` ↔ UI·`?force` 쿼리)·R8(L2 `capacity_vus` Zod). **proto·migration·DB·엔진 0**(R7). `reserve_idle_pool_capacity`/`pool_achievable_capacity`는 **arity만** 변경(시그니처, R3/R5)·본문 로직은 부분집합 일반화 — closed 결과 불변, 기존 closed 단위테스트는 새 arity로 갱신(§4.3). plan은 컨트롤러 가드 task와 UI 확인-다이얼로그 task를 같은 계약으로 묶고, 최종 `handicap-reviewer`가 본문 키 ↔ UI 파싱 1:1 대조.

---

## 3. 핵심 통찰 (설계 근거)

1. **슬롯(`max_in_flight`)이 open-loop의 동시성 단위라 슬롯 분할엔 신규 코드가 거의 없다.** open-loop 엔진(ADR-0031)은 `max_in_flight` 슬롯을 `Vec<Arc<VuClient>>`로 미리 적재(`runner.rs:1108`) — 슬롯=VuClient=동시 in-flight(ADR-0018). 슬롯은 이미 `total_vus = max_in_flight`로 closed VU와 *동일 기계장치*(`precomputed_counts`→`register`(coordinator.rs:525-527)→`assignment_for`→`reduce_open_loop_profile`가 `max_in_flight=Some(vu_count)`, 884)로 분할된다. capacity 경로(`reserve_idle_pool_capacity`)에 `slot_total=max_in_flight`를 주면 `capacity_split`이 슬롯을 cap 존중 분배한다. 가드 fork만 `!is_vu_curve()`로 넓히면 슬롯은 끝. [R1·R3·R7]

2. **레이트는 선언 용량이 없어 *가드*할 수 없고 *분배*만 한다 — 가드 demand는 슬롯뿐.** 워커는 `--capacity-vus`(동시성)만 선언하지 RPS 용량을 선언 안 하고 지속 RPS는 지연 의존(A9가 사후 담당). 그래서 가드는 closed와 동형으로 동시성(슬롯)만 검사. [R5·R2]

3. **레이트를 슬롯에 비례 분배해야 슬롯당 부하가 균등해진다(사용자 결정 2026-06-21).** cap 불균등이면 `capacity_split`이 슬롯을 불균등 분배(예 cap `[5,25]`·`max_in_flight=30` → 5/25). 레이트를 균등 분배(현 `reduce_open_loop_profile`의 `shard_split`)하면 작은 워커 과부하(drop)·큰 워커 유휴. `proportional_split(rate, slot_counts)`로 5/25 비례하면 슬롯당 rps 균등. `assignment_for`가 `rw.precomputed_counts`(전체 슬롯 벡터)를 갖고 있어 weights를 도출해 `reduce_open_loop_profile`에 넘긴다(`register`는 RegisterOutcome 반환 후 종료라 전체 벡터 미보유 — weight 도출은 반드시 `assignment_for`). [R4]

4. **고정 open-loop 레이트 분배는 0-share 워커를 절대 못 만든다 — 엔진이 0을 1로 clamp하기 때문(`runner.rs:1093` `.max(1)`).** 0이 배정된 고정 워커도 1 rps를 발사하므로, 0-share가 하나라도 있으면 목표 RPS를 초과한다. 이를 막는 **두 겹 방어**: ① **N 레이트-상한**(`worker_cap=min(max_in_flight, rate_peak)`, legacy runs.rs:694-711 산식) → `rate ≥ N` 보장(min1의 `total≥n` 전제). 단 rate-bound *만으로는 불충분* — capacity-비례 분배는 이질 cap에서 작은 슬롯 워커의 몫을 0으로 *반올림*할 수 있다(예 cap `[1,25]`·rate 3 → 순수 비례 `[0,3]` → 0-share clamp → 4 rps 초과). ② **고정 rate는 `proportional_split_min1`**(각 워커 ≥1 후 잔여 비례) → 이질 cap에서도 0-share 0 → 초과 0. 이는 ADR-0038이 이미 검증으로 강제한 규율("고정모드 `target_rps≥worker_count`", runs.rs:362-371; 단 ADR-0038은 *균등* shard_split이라 rate≥N이면 0이 안 나와 min1 불요)을 **capacity-비례 경로에 맞게 강화**한 것. 곡선은 0-rate stage를 poll·미발사로 흡수(`rate_at≤RATE_EPS`)하므로 `proportional_split`로 충분(0-share 무해·합 정확). 이 N-상한이 L3 단일 `total_vus`를 `(worker_cap, slot_total)` **2-param**으로 가르는 이유다. [R1·R2·R4·R7(b)]

5. **사전검사·예약·UI 일치성**: 예약(`reserve_idle_pool_capacity`)이 `N=min(idle, worker_cap)`개 워커(부분집합)를 쓰므로 사전검사(`pool_achievable_capacity`)도 **같은 `worker_cap`으로 같은 부분집합 Σcap**을 봐야 한다(둘 다 worker_id 정렬·first-N) → 사전검사 통과면 예약 성공(드문 TOCTOU 제외)·run row 미생성(R3/R5). **UI 프리뷰는 풀 전체 Σcap(상한)을 best-effort로 표시**한다(R8): `rate_peak≥max_in_flight`(흔함)면 부분집합=전체라 정확, `rate_peak<max_in_flight`(드묾)면 프리뷰가 under-warn할 수 있으나 **서버 409가 정확한 achievable로 권위**(다이얼로그가 그 값으로 clamp). 프리뷰=풀 총량·409=설정별 가능량은 서로 다른 두 사실이라 모순 아님. UI가 서버 부분집합 선택을 재현하지 않아 결합도가 낮다. [R5·R8]

6. **`?force`는 open-loop도 legacy even-split로 복원(L3 동형).** force면 capacity 경로 미진입·`reserve_idle_pool` + register `shard_split` + `reduce_open_loop_profile(slot_weights=None)` 균등 → ADR-0038 byte-identical. ephemeral 쿼리(Profile 비영속, ADR-0013). [R6]

7. **closed-loop VU 곡선은 범위 밖 — 가드 fork `!is_vu_curve()`라 vu-curve는 legacy(N=1)로 빠진다.** vu-curve는 단일워커 v1(ADR-0037)·멀티워커 곡선 샤딩은 별도 연기(roadmap §B9). 풀 모드 under-cap 배정 갭은 *존속*하나 그 가드(단일 best-fit 워커 cap ≥ `max(vu_stages)`)는 슬롯-분할 없는 다른 메커니즘이라 별도 슬라이스가 깔끔(§7). [R11]

---

## 4. 변경 상세

> 파일·함수 단위. 각 묶음 머리에 **충족 R**.

### 4.1 `crates/controller/src/store/runs.rs` (`Profile`) — 충족 R: R1
- `pub fn concurrency_demand(&self) -> u32`: `if self.is_vu_curve() { self.vu_curve_max() } else if self.is_open_loop() { self.max_in_flight.unwrap_or(1) } else { self.vus }`. (가드는 `!is_vu_curve()`에서만 호출 → vu-curve arm 미사용·완전성.)
- `pub fn pool_worker_cap(&self) -> u32`: closed=`vus`; open=`min(self.max_in_flight.unwrap_or(1), rate_peak)` where `rate_peak = self.target_rps.unwrap_or_else(|| self.stages.as_deref().unwrap_or_default().iter().map(|s| s.target).max().unwrap_or(1))`(legacy runs.rs:698-708 산식 재현). vu-curve arm=`vu_curve_max()`(미사용). **doc 주석에 "풀 전용 N 상한·ADR-0038 `worker_count`(비-풀 fan-out)와 무관" 명시**(N3).
- 단위로 mode별 두 값 락인.

### 4.2 `crates/controller/src/grpc/shard.rs` — 충족 R: R2, R7
- 신규 순수 `pub fn proportional_split(total: u32, weights: &[u32]) -> Vec<u32>`:
  1. `n=weights.len()`; `n==0`→빈 벡터. `sum_w=Σweights`; `sum_w==0`→균등 fallback `(0..n).map(|i| shard_split(total, n as u32, i).1)`.
  2. `q[i]=(total as u64 * weights[i] as u64 / sum_w as u64) as u32` + 잔여 `rem=total-Σq`를 **최대-잉여**(소수부 `total*weights[i] % sum_w` 큰 순, 동률 **인덱스 오름차순**)로 `rem`개 +1.
  3. `weights` 전부 같으면 == `shard_split` per-worker(앞 `total%n`개 +1, R7).
- 신규 순수 `pub fn proportional_split_min1(total: u32, weights: &[u32]) -> Vec<u32>` (고정 rate용·0-share 금지):
  1. `n=weights.len()`; `n==0`→빈. **`total < n` 또는 합 0 → 방어 fallback `proportional_split(total, weights)`**(rate-bound가 `total≥n`을 보장하지만 안전망).
  2. `total ≥ n`: 베이스 `[1; n]` + `proportional_split(total - n, weights)`를 원소합 → 각 워커 ≥1·Σ=total.
  3. `weights` 전부 같으면 == `shard_split(total, n)`(베이스 1 + `proportional_split(total-n, uniform)` = shard_split, 검증 `(7,&[1,1,1])`→`[1,1,1]+[2,1,1]=[3,2,2]`).
- 단위: 둘 다 Σ==total·결정적·uniform==shard_split(`(5,&[1,1])==[3,2]`·`(7,&[1,1,1])==[3,2,2]`); proportional 비례(`(30,&[5,25])==[5,25]`·`(10,&[5,25])==[2,8]`); min1 no-zero(`(3,&[1,25])==[1,2]`·각≥1).
- **`capacity_split`/`achievable_capacity`/`shard_split`/`worker_count`/`dataset_slice` 무변경**(R12).

### 4.3 `crates/controller/src/grpc/coordinator.rs` — 충족 R: R3, R4, R5
- **`reserve_idle_pool_capacity` 2-param 일반화(R3)**: `(&self, run_id, total_vus)` → `(&self, run_id, worker_cap: u32, slot_total: u32)`. 풀 락 1회 안에서: ① 유휴 worker_id 정렬 수집→`caps`. ② **빈-풀 먼저** → `Reserved{vec![],vec![]}`(빈-풀 400). ③ `N = min(idle, worker_cap as usize)`; `achievable = achievable_capacity(&caps[..N])`. `slot_total > achievable` → `Insufficient{achievable}`. ④ `counts = capacity_split(slot_total, &caps[..N])` → 누적합 `(offset,count)`·선택 워커 `assigned_run=Some`·`Reserved{workers,counts}`. **closed 호출은 `worker_cap==slot_total==vus`라 기존과 동일**(N=min(idle,vus)·Σcaps[..N]; vus≤idle이면 항상 충분이라 부분집합화가 closed 결과를 안 바꿈).
- **`pool_achievable_capacity` `worker_cap` 인자화(R5)**: `(&self)` → `(&self, worker_cap: u32)` → 유휴 worker_id 정렬·`(idle_count, achievable_capacity(&caps[..min(idle, worker_cap)]))`(예약과 같은 부분집합). closed 사전검사는 `worker_cap=vus`(부족은 vus>idle→N=idle=전체라 L3 값 동일).
- **`reduce_open_loop_profile`(coordinator.rs:873) 비례 레이트(R4)**: 5번째 `slot_weights: Option<&[u32]>` 추가. **고정 `target_rps`(887)** = `match slot_weights { Some(w) => proportional_split_min1(total, w)[shard_index], None => shard_split(total, shard_count, shard_index).1 }`(min1 = 0-share 금지·초과 차단). **각 곡선 `stage.target`(891)** = 같은 match지만 `Some` arm은 `proportional_split`(0-share는 poll 흡수). 슬롯(`max_in_flight=vu_count`, 884) 무변경. `None` arm = 현 `shard_split`(force/비-풀/subprocess byte-identical).
- **`assignment_for`(556)가 weights 도출**: `rw=g.get(run_id)?`(566)에서 `let slot_weights: Option<Vec<u32>> = rw.precomputed_counts.as_ref().map(|c| c.iter().map(|(_, cnt)| *cnt).collect());` → `reduce_open_loop_profile(&mut p, shard_index, shard_count, vu_count, slot_weights.as_deref())`(597). precomputed `Some`(capacity 경로=closed+open non-force)이면 비례, `None`(legacy/force/비-풀)이면 균등.
- `enqueue`/`register`/`precomputed_counts`/`PoolReservation`/`assign_pool_workers`는 L3 그대로 재사용.
- **N4 노트(주석)**: legacy `reserve_idle_pool`(249)은 정렬 없이 `take(cap)`, capacity 경로는 worker_id 정렬 — force/비-capacity 경로 워커 선택을 "정렬로 통일"하려다 force-path 동작을 바꾸지 말 것(의도된 비대칭).

### 4.4 `crates/controller/src/api/runs.rs::spawn_run` — 충족 R: R3, R5, R6, R11
- **사전검사(insert 전, runs.rs:509)**: 조건 `is_pool_mode() && !force && !is_open_loop() && !is_vu_curve()` → **`is_pool_mode() && !force && !profile.is_vu_curve()`**(closed+open). `let (idle, achievable) = state.coord.pool_achievable_capacity(profile.pool_worker_cap()).await; let demand = profile.concurrency_demand(); if idle > 0 && demand > achievable { return ConflictJson({achievable_vus: achievable, requested_vus: demand}); }`. 유휴 0은 통과(409 아님 → 빈-풀 400).
- **모드 fork(runs.rs:643-644)**: `let closed = !is_open_loop() && !is_vu_curve();` → **`let guarded = !profile.is_vu_curve();`**. `if guarded && !force` → capacity 경로 `reserve_idle_pool_capacity(row.id, profile.pool_worker_cap(), profile.concurrency_demand())` → `Reserved{workers,counts}`(빈→400·`Insufficient`→TOCTOU mark_failed 폴백·정상→`enqueue(.., total_vus, Some(counts))`+`assign_pool_workers`). `else`(force OR vu-curve) → **기존 legacy 경로 그대로**(R6·R11).
- **단일 소스(C1)**: enqueue에 넘기는 `total_vus`는 **기존 로컬(runs.rs:633-639, open=max_in_flight·closed=vus·curve=vu_curve_max = `concurrency_demand()`와 모든 모드 동치)을 재사용** — `concurrency_demand()`를 enqueue용으로 두 번째 계산하지 않는다(사전검사·reserve엔 `concurrency_demand()`/`pool_worker_cap()` 직접 호출, enqueue엔 기존 `total_vus` 로컬·동치 주석 명시; A3a/settings "단일 소스" 함정).
- **vu-curve 분기 diff 0(R11)**: `guarded=!is_vu_curve()`라 vu-curve는 `else`로 빠져 L3/L1 동작 유지(precomputed None·N=1).
- schedule-fire 공유: `spawn_run(force=false)` — L3 동형(부족 시 fire 실패 기록, §7 연기).

### 4.5 `ui/src/components/RunDialog.tsx` — 충족 R: R8, R9, R10
- **프리뷰 힌트 확장(R8)**: L3 "총 용량 X VU(X=Σ유휴 cap) + closed-fixed `vus>X` 힌트"에 **open(고정·곡선) `max_in_flight > X` 힌트** 추가(best-effort 상한, §3.5). 비-풀·`max_in_flight` 미설정 = 미표시·byte-identical.
- **409 다이얼로그 mode 분기(R9)**: 409(`PoolCapacityError`) 시 — closed면 [줄여 진행]=`{...built, vus: achievable}`(L3), **open이면 `{...built, max_in_flight: achievable}`**(`target_rps`/`stages` 불변; `Profile`에 두 필드 다 있어 spread+override 구조적 안전) + 안내문(`ko.*`). [강행]=`?force=true`, [취소]=미생성. `mutation.reset()`·중복 다이얼로그 가드 L3 재사용.
- closed·비-풀·충분 run = 409 미발생 → byte-identical.

### 4.6 `ui/src/api/{client.ts, hooks.ts}` — 충족 R: R9
- **`createRun`/`PoolCapacityError`/`useCreateRun {force}`는 L3 그대로 재사용**(409 본문 `{achievable_vus, requested_vus}` surface·`?force` 쿼리) — open-loop도 같은 에러 타입·mutation. 코드 변경 0(or 최소). RunDialog만 mode별 clamp 필드(`max_in_flight` vs `vus`) 분기.

### 4.7 `ui/src/i18n/ko.ts` — 충족 R: R10
- `ko.capacityGuard`(L3) 확장 + **mode-aware 워딩**: open clamp 안내문("동시 슬롯만 줄입니다 — 목표 RPS 유지·드롭 가능·포화 시 워커 추가")·open 프리뷰 힌트·다이얼로그 본문에서 open은 "동시 슬롯/요청"(VU 아님). 인라인 0.

### 4.8 `docs/dev/lan-workers.md` — 충족 R: R11, R12
- §4(과부하 가드)를 open-loop 포함으로 갱신: 슬롯=capacity_split·레이트 비례·N 레이트 상한(초과 발사 방지)·409/줄여진행(max_in_flight clamp)/강행. **한계 노트**: closed-loop VU 곡선 풀 가드 미적용(N=1·under-cap 갭 존속)·dataset `unique` 비례 분할 미적용(disjointness 보존)·풀 open-loop은 `worker_count` 노브 무시(use-all-by-demand, N3). §8 한도 표 갱신.

---

## 5. 무변경 / 불변식 (명시)

- **proto·worker·엔진(`crates/engine`)·migration·DB·리포트·CSV/XLSX/비교·메트릭 머지·`shard_split`/`worker_count`/`capacity_split`/`achievable_capacity`/`dataset_slice`·`check_token`·`reduce_open_loop_profile`의 슬롯 로직 전부 무변경.** `capacity_vus`는 이미 와이어/저장(L1) → **migration 0 / proto 0**.
- **`reserve_idle_pool_capacity`/`pool_achievable_capacity`는 arity만 변경**(부분집합 일반화) — **closed-loop 결과 불변**(worker_cap=slot_total=vus 재현). 기존 closed 단위테스트(`reserve_capacity_*`·`pool_achievable_capacity_sums_idle`)는 새 arity로 호출만 갱신·동작 동일.
- **closed-loop(고정·곡선)·closed-loop VU 곡선 풀 배정 무변경**: closed 고정은 `concurrency_demand=vus`라 L3 경로 동일; VU 곡선은 `!is_vu_curve()` fork로 legacy(N=1)(R11).
- **비-풀(subprocess/k8s) open-loop fan-out 무변경**: precomputed `None` → register `shard_split` + `reduce_open_loop_profile(slot_weights=None)` 균등(ADR-0038 byte-identical, R7).
- **불변식(R7)**: (a) 균등 cap + `rate_peak≥max_in_flight` → ADR-0038 byte-identical. (b) 레이트 충실: 고정 모드 `proportional_split_min1`(N≤rate_peak 보장 하 모든 워커 ≥1) → 이질 cap에서도 0-share clamp 초과 0; 곡선 모드 0-share는 poll 흡수(합=stage.target). 슬롯 부족이면 정직한 409. `?force=true` = 항상 균등(L1 복원).
- **풀 open-loop은 `worker_count` 노브 무시**(N3): 풀은 use-all-by-demand(`N=min(idle, worker_cap)`)라 ADR-0038 `worker_count`(비-풀 fan-out 전용)를 안 읽는다 — 기존 L1/L3 동작과 일관, 런북 명시.
- **degraded/부분-실행 상태 없음**: 줄여진행=정직한 작은-슬롯 run, 강행=정직한 과부하 run(L3 동형).
- 기존 run-create 성공 경로(비-풀·충분 풀·closed·vu-curve)는 **409 미발생 → byte-identical**. 빈 풀(유휴 0)=기존 400(R5).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | 단위 `concurrency_demand_by_mode`·`pool_worker_cap_by_mode`(closed=vus·open 두 값·rate_peak=curve max) | |
| R2 | 단위 `proportional_split_*`(Σ·uniform==shard_split[remainder≠0]·비례) + `proportional_split_min1_*`(각≥1·Σ·uniform==shard_split·`(3,&[1,25])==[1,2]`) | |
| R3 | 통합 `pool_open_loop_assigns_capacity_aware`(이질 cap → 슬롯 각≤cap·합=max_in_flight) / 라이브 | ✅ |
| R4 | 통합 `pool_open_loop_rate_proportional`(곡선 stage=정확 비례 `[5,25]`·Σ=stage.target / 고정=min1 `[6,24]`·Σ=target_rps) + `pool_open_loop_no_zero_rate_fixed`(이질 cap `[1,25]`·저 rate → 모든 워커 rate≥1·Σ=target_rps·초과 0) | ✅ |
| R5 | 통합 `pool_open_loop_insufficient_returns_409`(저-cap·큰 max_in_flight → 409 본문·run row 부재) + `pool_open_loop_zero_idle_400` | ✅ |
| R6 | 통합 `pool_open_loop_force_skips_guard`(`?force=true` → 201·균등) | ✅ |
| R7 | 단위(R2 두 헬퍼·capacity_split) + 통합 `pool_open_loop_homogeneous_byte_identical`(균등 cap·rate≥max_in_flight = ADR-0038) + `pool_open_loop_no_zero_rate_fixed`(R4) + **기존 closed 풀/fan-out 스위트 green(arity만 갱신, 동작 동일)** | |
| R8 | RTL `RunDialog`(open+fixed·open+curve `max_in_flight>X` 힌트·`≤X` 부재·비-풀 무힌트) | ✅ |
| R9 | RTL `RunDialog`(open 409 mock → clamp `max_in_flight:X` POST·target_rps 유지·강행 `?force`·취소 미전송·안내문) | ✅ |
| R10 | grep: 신규/수정 컴포넌트 `ko.*`·인라인 0 + open 슬롯-워딩 | |
| R11 | `spawn_run` vu-curve 분기 diff 0 + 한계 노트 존재 | |
| R12 | `dataset_slice` diff 0 + 한계 노트 존재 | |
| R13 | security-reviewer + 409 본문 token/hostname 부재 grep | |

- **신규 테스트가 open-loop 풀 경로의 유일 가드**: 기존 통합(`pool_capacity_guard_test.rs`·`pool_e2e.rs`)은 closed-loop, `multi_worker_fanout_e2e.rs::two_worker_open_loop_fanout_completes`는 비-풀 fan-out — **legacy open-loop *풀* 동작을 커버하는 기존 테스트가 없다** → 신규 `pool_open_loop_*`가 그 경로의 회귀 가드(필수·중복 아님).
- **라이브 검증 필수**(`/live-verify`): open-loop 풀 배정(`spawn_run` 분기) + 비례 레이트 + 409 응답-파싱(RunDialog) → S-D 갭. **localhost 풀 스택**(런북 §9): `--worker-mode pool` + 풀 워커 2대 **저 `--capacity-vus`**(각 5)로 ① open+fixed `max_in_flight=8`·`target_rps=16`(cap 5+5=10) → 슬롯 `capacity_split(8,[5,5])`=**[4,4]**·레이트 `proportional_split(16,[4,4])`=[8,8]·report 정합 ② 부족(`max_in_flight=20`·`target_rps=40 > 10`) → 409 `{achievable_vus:10, requested_vus:20}`·run row 부재 ③ 줄여 진행(`max_in_flight=10`) → 201·완료 ④ 강행(`?force=true`, `max_in_flight=20`) → 201·균등 10/10 과부하 ⑤ open+curve(stages peak 16·max_in_flight 8) 동일 가드·각 stage.target 비례 ⑥ 이질 cap(`[5,25]`·`max_in_flight=30`) → 슬롯 `capacity_split(30,[5,25])`=5/25; **고정 `target_rps=30`** → rate `proportional_split_min1(30,[5,25])`=**[6,24]**(각≥1·Σ=30, min1이라 정확 비례 아님 — base[1,1]+proportional(28)); **곡선 stage 30** → `proportional_split(30,[5,25])`=[5,25](슬롯당 1 rps 균등은 *곡선*에서만 정확) ⑦ 전원 기본 cap(1000) open run = ADR-0038 byte-identical ⑧ **이질 cap 저-rate**(워커 cap `[2,8]`·`max_in_flight=10`·`target_rps=3`) → 슬롯 `capacity_split(10,[2,8])`=[2,8]·고정 rate `proportional_split_min1(3,[2,8])`=[1,2](각≥1)·**관측 총 RPS ≈ 3(초과 없음)** — 순수 비례면 [0,3]→clamp [1,3]→4 rps가 됐을 것(N1 회귀가드, min1 효과 판별). **cold-build 워커 race(CLAUDE.md S-A)** — `cargo build -p handicap-worker` 워밍.
- **실화면 사용자 리뷰**: Playwright로 open 프리뷰·초과 힌트·409 다이얼로그(clamp max_in_flight·안내문) 사용자 확인 → 반영.

---

## 7. 의도적 연기 (roadmap §LAN 분산 / ADR-0041 §귀결에 누적)

- **closed-loop VU 곡선(vu_stages) 풀 capacity 가드**(R11): vu-curve는 단일워커 v1(ADR-0037)이라 슬롯-분할 가드가 아니라 "단일 best-fit 워커 cap ≥ `max(vu_stages)`" 예약이 필요 + 멀티워커 곡선 샤딩 별도 연기(§B9). 풀 under-cap 갭 *존속*하나 드문 조합. 별도 슬라이스.
- **레이트-상한 워커 절약 vs degraded**: N≤rate_peak라 `rate_peak < max_in_flight`·작은 cap이면 슬롯이 부분집합에 안 맞아 409가 뜬다(예 max_in_flight=30·target 3·cap5 → 409 achievable=15). 이건 "30 동시·3 rps"가 큰 cap 워커를 요구한다는 정직한 신호 — 더 영리한 bin-pack(0-share 없이 더 많은 워커로 슬롯 충족)은 별도.
- **dataset `unique` 비례 분할**(R12·L3 R11): capacity-aware 불균형 슬롯/VU에서 unique 행 비례 분배. disjointness 보존이라 정확성 위험 아님(속도만), 연기.
- **measured rate capacity**: 워커가 자기 지속 RPS 실측 보고(현재 `capacity_vus`는 동시성 선언만). 레이트 가드는 그 메트릭이 있어야 — 별도.
- **schedule-fire 자동 clamp/강행 + 명확한 이벤트 메시지**: open-loop 예약 발사 부족도 fire 실패 기록(L3 동형, §4.4).
- **degraded/부분-실행 모드**(B2'')·**하트비트/last-seen**·**제어 액션**(disconnect/exclude/cap)·**mTLS**·**다중 동시 run**: L3 다른 후보, 별도.

---

## 8. 구현 순서 (plan 입력)

> cargo-영향 커밋마다 전체 워크스페이스 게이트 → green fold 지점 명시. seam(R5 409 ↔ R9 UI·전부 L3 재사용)을 계약-먼저.

1. **순수 함수 + 접근자**(R1·R2·R7): `Profile::concurrency_demand`/`pool_worker_cap`(store/runs.rs) + `proportional_split`·`proportional_split_min1`(shard.rs) + 단위(Σ·uniform==shard_split·비례·min1 no-zero·mode별 값). 자족 green 커밋(헬퍼+단위 fold).
2. **컨트롤러 open-loop capacity 배정 + 가드 확장**(R3·R4·R5·R6·R11·R13): `reserve_idle_pool_capacity`/`pool_achievable_capacity` 2-param/1-param 일반화(**기존 closed 단위테스트 호출부 새 arity로 갱신** — `reserve_capacity_*`·`pool_achievable_capacity_sums_idle`, 동작 동일) + `reduce_open_loop_profile` slot_weights(고정→min1·곡선→proportional, `assignment_for`가 `rw.precomputed_counts`→weights) + `spawn_run` 사전검사·fork `!is_vu_curve()`(단일 소스 C1). 통합(`pool_open_loop_assigns_capacity_aware`/`_rate_proportional`/`_no_zero_rate_fixed`/`_insufficient_409`/`_zero_idle_400`/`_force_skips_guard`/`_homogeneous_byte_identical`) + 기존 closed 풀/fan-out 스위트 green. `--features bundle` 빌드 1회.
3. **UI 프리뷰/409 확장**(R8·R9·R10): RunDialog open 힌트 + 409 다이얼로그 mode 분기(clamp `max_in_flight`·안내문) + ko.ts mode-aware 워딩. `createRun`/`PoolCapacityError`/hooks 재사용. RTL(open 힌트·409 흐름).
4. **런북 갱신**(R11·R12·N3): lan-workers.md §4/§8 + 한계 노트.
5. **라이브 검증**(§6) + 실화면 사용자 리뷰 → 반영. **finish-slice**(ADR-0041 §귀결·roadmap·build-log·도메인 CLAUDE.md).

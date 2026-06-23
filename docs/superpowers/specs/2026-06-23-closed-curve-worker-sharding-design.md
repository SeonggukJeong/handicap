# closed-loop VU 곡선 비-풀 fan-out 샤딩 — capacity-derived N으로 vu_stages를 워커에 균등 샤딩 (B9, ADR-0027 fan-out 확장)

> **이 파일은 spec이다.** normative 척추는 **§2 요구사항 표(R-id)** — plan·구현·리뷰가 전부 이 ID를 참조한다.

- **날짜**: 2026-06-23
- **상태**: 설계 승인(사용자 2026-06-23) → plan 대기
- **출처**: roadmap §B9 "곡선 멀티워커 샤딩" 연기 항목(ADR-0037 §9). **왜 지금**: closed-loop VU 곡선은 풀 모드(L5)에선 샤딩되지만 **비-풀 fan-out 경로**(ADR-0027 capacity-derived N, subprocess N-spawn / k8s Indexed Job)에선 여전히 N=1로 단일워커 강제(`peak > capacity`면 400 거부) — 부하 모델 fan-out 스토리의 마지막 갭. 사용자가 다음 슬라이스로 선택.
- **연관**: ADR-0037(closed-loop VU 곡선·§9 멀티워커 샤딩 연기), ADR-0027(멀티워커 fan-out·A3a/A3b/A3c), spec `2026-06-21-lan-distributed-workers-l5-closed-curve-capacity-guard-design.md`(풀 곡선 샤딩 — 재사용 기반), spec `2026-06-01-multi-worker-fanout-design.md`(fan-out 본체).
- **ADR**: 신규 불필요(ADR-0037 §9 "멀티워커 샤딩 연기"의 해소 + ADR-0027 fan-out 범위 내 additive). vu_curve를 fixed-VU와 같은 capacity-derived fan-out 메커니즘에 편입할 뿐 새 결정 없음.

---

## 1. 문제와 목표

closed-loop VU 곡선(`vu_stages`)은 **비-풀 fan-out 경로에서 단일워커 강제**다: `validate_run_config`(runs.rs:258)가 `!is_pool_mode() && max(vu_stages.target) > worker_capacity_vus()`면 400 거부("vu_stages는 단일 워커")하고, `spawn_run`(runs.rs:691)·validate(runs.rs:434)가 vu_curve N을 하드코드 `1`로 둔다. fixed-VU는 같은 경로에서 `N=ceil(vus/capacity)`로 fan-out하는데(A3a) 곡선만 제외돼, capacity 초과 대형 곡선을 비-풀로 돌릴 길이 없다(k8s 고처리량 프로덕션의 유일 경로).

기반은 **이미 깔려 있다**: `total_vus`는 vu_curve에서 이미 `vu_curve_max()`(=peak, runs.rs:701-702), 비-풀 enqueue/dispatch(runs.rs:852/871)는 `n`을 그대로 받아 fan-out, `reduce_pool_profile`(coordinator.rs:1130-1168)의 곡선+`None`-weights 분기는 각 stage를 `shard_split(stage.target, N, i)`로 균등 분배(L5가 추가), 엔진 `run_scenario_vu_curve`는 임의 `vu_stages`+`vu_offset`을 실행, active-VU worker_id 머지(migration 0018)는 dispatch-agnostic. 그래서 **유일한 변경 = vu_curve의 N을 `1`→`ceil(peak/capacity)`로** + 거부 제거 + (그 둘이 어긋나지 않게) N 도출 단일화.

- **목표**: ① 비-풀 closed-loop VU 곡선이 fixed-VU와 동일하게 capacity-derived fan-out(`N=ceil(peak/capacity)`)으로 vu_stages를 워커에 균등 샤딩. ② validate·dispatch·unique-floor가 **같은 N**을 읽어 silent 불일치(빈 unique 슬라이스 언바운드 부하) 차단. ③ subprocess 라이브 검증 + k8s by-construction + `e2e_kind_driver` 곡선 어서션.
- **비목표(연기)**: §7. per-stage 워커 분해·worker-count UI 표시·closed-loop `worker_count` override 노브·pool/비-풀 경로 통합·best-effort/degraded·N 상한.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | `MUST` 비-풀 closed-loop VU 곡선 fan-out N 도출: validate(runs.rs:434)·spawn_run(runs.rs:691)의 vu_curve N을 하드코드 `1` → `shard::worker_count(profile.vu_curve_max(), worker_capacity_vus())`(fixed-VU와 **동일 수식**). `total_vus`(runs.rs:701-702 `vu_curve_max()`)·비-풀 `enqueue`(852)/`dispatch`(871)·register·`assignment_for`·`reduce_pool_profile` **무변경**(N>1을 받아 기존 fan-out 발동). 풀 모드 분기·fixed-VU·open-loop·비-곡선 무변경. | 통합 `nonpool_vu_curve_fans_out`(비-풀·peak>cap → register N=ceil(peak/cap) 워커·각 워커 sharded vu_stages) + 라이브 | |
| R2 | `MUST` 단일워커 거부 제거: `validate_run_config`의 vu_curve 거부(runs.rs:258-264 `!is_pool_mode() && s.target > capacity → 400 "단일 워커"`)를 **제거**(이제 fan-out). 다른 곡선 검증 — 노브충돌 `duration_seconds`(240)·`vus`(245), stage `duration_seconds>=1`(253), `>=1 target>0`(266) — 은 **유지**. | 통합 `nonpool_vu_curve_peak_over_cap_accepted`(비-풀 peak>cap → 201, 종전 400 아님) + 기존 곡선-검증 회귀(노브충돌·빈 stage 여전히 400) | |
| R3 | `MUST`(재사용) per-worker `vu_stages` 샤딩은 기존 `reduce_pool_profile`(coordinator.rs:1130-1168) **곡선+`None`-weights 분기 그대로**: 비-풀은 `RunWorkers.precomputed_counts=None`→`slot_weights=None`→각 `vu_stages[].target = shard_split(target, shard_count, shard_index).1`(균등 분배·합=target). **`reduce_pool_profile` 본문/시그니처 신규 변경 0**. | 단위(coordinator.rs 인라인) `nonpool_vu_curve_stage_shard_split`(N=3·peak·sub-peak 균등·Σ=원target) | |
| R4 | `MUST`(불변식·안전) **unique-floor가 vu_curve의 실제 fan-out N을 봐야 빈-슬라이스 언바운드 부하 차단**: unique dataset floor(runs.rs:470 `rows >= n`)는 **validate-N(runs.rs:434)을 읽으므로**, vu_curve N을 `1`→`ceil(peak/cap)`로 바꿀 때 **그 434 사이트도 함께** 바꿔야 floor가 실제 fan-out N(=dispatch-N 691)을 본다(둘 다 안 바꾸면: dispatch는 N개 발사·floor는 rows>=1만 검사 → 빈 unique 슬라이스 언바운드, L5 R14 클래스). 비-풀 N은 결정적(profile+settings 스냅샷)이라 validate-time floor로 충분(풀 R14의 예약-시점 recheck 불요). `SHOULD` 두 N 사이트(434·691)를 공유 헬퍼(`fanout_worker_count`)로 추출 — 같은 결정식이라 현재 동치이나 향후 *코드* 드리프트 차단(루트 컨트롤러 CLAUDE.md "validated-N과 dispatched-N 다른 소스=silent 불일치"). **선재 TOCTOU(비-회귀)**: validate(892)↔spawn(895) 사이 `PUT /api/settings`로 capacity가 바뀌면 validate-N≠dispatch-N 가능 — fixed-VU fan-out에도 이미 존재하는 선재 위험이지 B9 신규 아님(§5). | 통합 `nonpool_vu_curve_unique_rows_lt_workers_rejected`(peak>cap·unique rows<N → 400) + `_ge_workers_ok`(rows>=N → 201) + 단위 `fanout_worker_count`가 양 호출부 단일 소스 | |
| R5 | `MUST`(불변식·정합) **peak stage 스케일 == `vu_count`(슬랩 크기) + 전역 vu_id disjoint 덮음**: `total_vus=peak`라 register `shard_split(peak, N, i) → (vu_offset, vu_count)`, peak stage의 target=peak라 `reduce_pool_profile`의 `shard_split(peak, N, i).1 == vu_count`(동일 호출) → 슬랩 크기 정합·`vu_offset_i=Σ_{k<i}vu_count_k`가 `[0,peak)` disjoint 덮음(`${vu_id}`·unique-dataset 정합). 각 워커 peak에서 **≥1 VU**(`N=ceil(peak/cap)≤peak` ⟹ `shard_split(peak,N,i).1≥1`). sub-peak stage `target<N`은 일부 워커 0-share → 엔진 park(`run_scenario_vu_curve`는 `.max(1)` floor 없음·총량 보존), **min-1 floor 안 씀**(곡선 왜곡 방지). | 단위 `nonpool_vu_curve_peak_stage_equals_vu_count` + `nonpool_vu_curve_offsets_disjoint_cover_peak` + `nonpool_vu_curve_subpeak_zero_share_parks`(stage target<N → 일부 0·Σ=target) | |
| R6 | `MUST`(byte-identical) ① peak≤capacity 곡선(N=1·`reduce_pool_profile` early-return[`shard_count<=1`]·active-VU 단일 worker_id→SUM 동일) ② 풀 모드 곡선(L5 무변경) ③ fixed-VU·open-loop·비-곡선 ④ active-VU N=1 출력(`ReportJson.active_vu_series`). **proto·migration·engine·worker·UI 0**. | 기존 곡선/fixed/open/풀 스위트 green + active-VU N=1 출력 단언 + `cargo build --workspace`(proto/engine/worker 0 diff) + `git diff --stat`에 ui/·proto/·engine/·worker/ 없음 | |
| R7 | `MUST`(재사용) active-VU 시계열 N>1 머지: migration 0018 `run_active_vu_metrics` worker_id PK + 읽기 `SUM(desired)/SUM(actual) … GROUP BY ts_second`(metrics.rs:405) + ingest `batch.worker_id`(L5)가 dispatch-agnostic이라 fan-out에 그대로. **신규 migration·proto·store 코드 0**. | 라이브(비-풀 N>1 곡선 → `active_vu_series` SUM 머지 actual peak ≈ 곡선 peak) + L5 store 단위 재사용 | ✅ (재사용) migration 0018 + active-VU read SUM(L5·신규 0) |
| R8 | `MUST`(보안) N 도출·샤딩이 신규 외부 노출 0: 비-풀 곡선 fan-out은 capacity-shortage 개념이 없음(N이 자라서 맞춤) → **409/`?force` 없음**(풀 전용). active-VU worker_id는 DB 내부 키·`ActiveVuSample`(report.rs) 미보유·`ReportJson` 미노출(L5 R13 이중방어). | security-reviewer(path-gate 요청실행/샤딩 매치 시) + `active_vu_series` worker_id 비노출 grep | |
| R9 | `MUST`(검증) k8s 곡선 Indexed Job fan-out: `e2e_kind_driver`의 단일 run을 **fixed-VU(`vus:50`) → closed-loop 곡선(`{duration_seconds:0, vu_stages:[{target:50,duration_seconds:10}]}` — top-level `duration_seconds:0`은 serde-required·`store/runs.rs:116`)으로 교체**. e2e는 이미 `worker.capacityVus=25` 배포(scripts/e2e-kind.sh:9 + GH 워크플로 `--set`)라 peak50→**N=2**, 워크플로(`.github/workflows/e2e-kind.yml`)의 기존 라이브 `completionMode=Indexed && completions=2` kubectl 단언이 곡선 fan-out을 **그대로 검증(워크플로·Helm·script 수정 0)**. REST smoke(`count>0`·`steps==2`) 유지. `build_job_spec(worker_count=N)`은 vu_curve-특화 분기 0(무변경). 곡선 run이 fixed-VU와 동일 Indexed-Job dispatch 경로 + 곡선-N을 strict superset로 검증(fixed-VU N-도출 `worker_count(vus,cap)`은 단위테스트 커버, §7). | 워크플로 라이브 Indexed N=2 단언이 곡선 run에 통과 + driver REST smoke 통과 — kind | |

- **`seam?`**: 유일한 와이어 = **R7(active-VU)**이고 그것도 **L5 재사용**(migration 0018·read SUM 신규 0). R1~R5는 컨트롤러 내부(N 산술·샤딩), R9는 dispatcher/kind 하니스 — 신규 proto/migration/Zod 0. plan은 컨트롤러 N+거부 변경을 한 계약-task로 묶고(둘 다 vu_curve N 의미를 바꿈), 최종 `handicap-reviewer`가 validate-N↔dispatch-N 단일 소스와 peak-stage==vu_count 불변식을 코드 대조.

---

## 3. 핵심 통찰 (설계 근거)

1. **기반이 L5+A3a에 이미 깔려 있어 "N=1 → ceil(peak/cap)"이 거의 전부.** 비-풀 fan-out 기계(enqueue→dispatch N→register `shard_split(total_vus,N,i)`→`assignment_for`→`reduce_pool_profile`)는 fixed-VU로 이미 돌고, `reduce_pool_profile`의 곡선+`None` 분기(`shard_split`)는 L5가 추가했다. vu_curve의 N만 `1`에서 막혀 있었을 뿐이라 그 하드코드만 풀면 곡선이 **fixed-VU와 동일 경로**로 흐른다. `total_vus`는 vu_curve에서 이미 peak(runs.rs:701-702 — 풀 곡선 offset용으로 L5가 깔아 둠)라 register의 shard 회계도 그대로. [R1·R3]
2. **비-풀은 균등(uniform-cap) 샤딩이라 `shard_split`(0-share OK)로 충분 — 풀의 `proportional_split`보다 단순.** 비-풀 워커는 전부 같은 `worker_capacity_vus()`라 가중치가 균등 → `precomputed_counts=None`이 곧 `shard_split`. closed 곡선의 0-share는 엔진 `run_scenario_vu_curve`가 `desired=rate_at().round()`에 min-1 floor를 안 둬 그냥 park(미발사)이므로 무해(open-loop 고정 rate가 `.max(1)`로 초과발사하던 문제 없음·L5 통찰 2). [R3·R5]
3. **peak stage 스케일이 `vu_count`와 정확히 같아 offset 회계가 정합**(R5). `total_vus=peak`라 register `shard_split(peak,N,i)=(vu_offset,vu_count)`이고, `reduce_pool_profile`이 peak stage(target=peak)를 `shard_split(peak,N,i).1`로 줄이면 **그 값이 곧 `vu_count`**(같은 인자의 같은 함수). 따라서 각 워커의 최고 스케일 stage == 슬랩 크기이고 `vu_offset_i=Σ_{k<i}vu_count_k`가 disjoint vu_id 구간을 준다. 각 워커 peak ≥1의 근거: `N=ceil(peak/cap)≤peak`(cap≥1·peak≥1) ⟹ 균등 몫 `peak/N≥1`. [R5]
4. **unique floor(470)는 validate-N(434)을 읽으므로, dispatch-N(691)만 바꾸면 언바운드 부하**(R4). validate(434)와 dispatch(691)가 각자 3-way `if`로 N을 계산하는데, vu_curve arm을 *dispatch만* `ceil(peak/cap)`로 고치고 *validate(434)*를 N=1로 두면: floor는 `rows>=1`만 검사해 통과하지만 dispatch는 N개 워커를 발사 → 빈 unique 슬라이스 = 언바운드 부하(L5 R14 클래스). 그래서 **434도 함께** 바꿔 floor가 실제 fan-out N을 보게 해야 한다. 비-풀 N은 결정적(capacity-derived)이라 풀처럼 예약-시점 recheck는 불요. 두 사이트를 같은 `fanout_worker_count(profile, capacity)`로 추출하면 둘이 어긋날 수 없어(implementer가 한쪽만 고치는 사고 차단·향후 드리프트도) 이 안전성이 구조적으로 보장된다. [R4]
5. **active-VU 머지는 dispatch-agnostic이라 공짜**(R7). L5가 migration 0018로 `run_active_vu_metrics` PK에 worker_id를 넣고 읽기 SUM으로 풀 N>1을 풀었는데, 이 머지는 "워커가 worker_id별 행을 쓰면 합산"일 뿐 dispatch 출처(풀/fan-out)를 안 본다. 비-풀 fan-out 워커도 같은 ingest 경로(`batch.worker_id`)를 타므로 신규 0. N=1이면 단일 worker_id라 SUM이 종전 값 → byte-identical. [R7·R6]
6. **비-풀 곡선 fan-out은 부하 divergence가 아니다** — 정상 fan-out은 총량(peak) 보존이라 [[load-divergence-explain-confirm]]가 트리거되지 않는다. 풀의 409/`?force`/축소 다이얼로그는 *capacity 부족*(achievable<peak) 때문인데, 비-풀은 N이 peak를 덮을 만큼 자라므로 capacity-shortage 자체가 없다 → 다이얼로그·force 경로 불필요(풀 전용). [R8]

---

## 4. 변경 상세

> 파일·함수 단위. 각 묶음 머리에 **충족 R**.

### 4.1 `crates/controller/src/api/runs.rs` — vu_curve fan-out N 단일화 — 충족 R: R1, R4
- 신규 `fn fanout_worker_count(profile: &Profile, capacity: u32) -> u32`(`Profile`=`crate::store::runs::Profile` — `is_vu_curve`/`vu_curve_max`/`vus`/`worker_count`가 그 타입의 메서드·필드. **`pb::Profile` 아님** — proto엔 `worker_count` 필드 없음) 추출 — 현재 validate(434-440)·spawn_run(691-697)에 중복된 3-way `if`(vu_curve/open-loop/closed)를 한 곳으로. vu_curve arm을 `1` → `shard::worker_count(profile.vu_curve_max(), capacity)`로. 두 사이트 모두 이 헬퍼 호출(R4 단일 소스).
- `total_vus`(701-707)·비-풀 `enqueue(…, n, total_vus, None, …)`(852-863)·`dispatch(&row.id, n)`(871)·풀 분기 무변경 — N>1을 받아 기존 fan-out 발동.

### 4.2 `crates/controller/src/api/runs.rs::validate_run_config` — 단일워커 거부 제거 — 충족 R: R2
- vu_stages 검증 블록(219-270, vu_curve arm)에서 **258-264 거부 제거**(vu_curve도 fan-out). `capacity` local(250)은 거부 제거 후 이 블록에서 unused → **제거**(4.1 헬퍼는 호출부에서 `worker_capacity_vus()`를 인자로 받고, 4.1의 N 도출은 binding 블록 434에 위치). 노브충돌(240·245)·stage duration(253)·`>=1 target>0`(266) 유지 — peak≥1 보장(434 N 도출보다 앞서 실행되므로 `vu_curve_max()≥1`).

### 4.3 `crates/controller/src/grpc/coordinator.rs` — 샤딩 재사용(무변경 확인) — 충족 R: R3, R5
- `reduce_pool_profile`(1130-1168) 곡선+`None`-weights 분기 **그대로** — 비-풀 `precomputed_counts=None`이 `shard_split(vu_stages[].target, shard_count, shard_index)`로 라우팅. register(`shard_split(total_vus=peak, N, i)`)와 같은 인자라 peak stage==`vu_count` 정합. 신규 코드 0(인라인 단위테스트만 비-풀 곡선 케이스로 추가).

### 4.4 active-VU N>1 머지(무변경 확인) — 충족 R: R7
- migration 0018(`ensure_active_vu_worker_id`)·`active_vu_series` SUM read(metrics.rs:405)·ingest `batch.worker_id`(coordinator.rs) **그대로**. 비-풀 fan-out 워커가 worker_id별 행 기록 → SUM 머지. 신규 0.

### 4.5 `crates/controller/src/bin/e2e_kind_driver.rs` — 단일 run을 곡선으로 교체 — 충족 R: R9
- 현 driver는 단일 run을 `{"vus": 50, "ramp_up_seconds": 2, "duration_seconds": 10}`로 생성(86-88). 이를 `{"duration_seconds": 0, "vu_stages": [{"target": 50, "duration_seconds": 10}]}`로 교체 — top-level `vus`/`ramp_up_seconds`만 제거하고 **`duration_seconds: 0`은 유지**(serde-required·`store/runs.rs:116`에 `#[serde(default)]` 없음 → 빼면 422; vu_curve는 `duration_seconds==0` 강제·runs.rs:240. 선례 `tests/pool_vu_curve_capacity_test.rs:166`). 배포 cap=25(scripts/e2e-kind.sh:9)라 peak50→N=2. REST 단언(`count>0`·`steps==2`)·시나리오·wiremock seed 무변경. 워크플로(`.github/workflows/e2e-kind.yml`)의 라이브 `completionMode=Indexed`/`completions=2` kubectl 단언이 곡선 run의 Indexed Job을 그대로 검증(**워크플로·Helm values·script 무변경**). `build_job_spec`은 vu_curve-특화 분기 없음(무변경).

---

## 5. 무변경 / 불변식 (명시)

- **proto·migration·engine·worker·UI(ui/) 0 diff** — 머지 diff는 `crates/controller/` + docs 한정(`e2e_kind_driver`·테스트 포함). [R6]
- `reduce_pool_profile`·register·`assignment_for`·`enqueue`·`dispatch` 시그니처/본문 무변경(N 값만 vu_curve에서 달라짐). [R1·R3]
- active-VU 테이블/read/ingest(migration 0018) 무변경 — 재사용. [R7]
- **byte-identical**: ① peak≤capacity 곡선(N=1) ② 풀 모드 곡선(L5) ③ fixed-VU·open-loop·비-곡선 run ④ active-VU N=1 출력. [R6]
- **선재 TOCTOU(비-회귀, 미해결)**: `worker_capacity_vus()`가 런타임-가변 설정(운영 상한 관리자)이라 validate(runs.rs:892)↔spawn(895) 사이 `PUT /api/settings`로 capacity가 바뀌면 validate-N≠dispatch-N 가능 — vu_curve도 이 위험을 *공유*하나 **fixed-VU fan-out에 이미 존재**(두 사이트 모두 라이브 설정 읽음)하므로 B9 신규 아님. 닫으려면 N을 한 번 계산해 양 사이트에 전달하는 더 큰 리팩터 필요(별도·§7). [R4]
- **N 상한 없음**(의도) — fixed-VU와 동일하게 `N=ceil(peak/cap)` 무계(낮춘 ops `capacity`면 N 큼). 사용자 결정(매치 fixed-VU). [§7]
- **UI 없음**(의도) — 비-풀 closed-loop fan-out은 silent·capacity-derived(fixed-VU와 동일·worker_count 노브 없음). active-VU 차트가 머지된 desired/actual을 이미 표시. [§7]

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | 통합 `nonpool_vu_curve_fans_out`(register N=ceil(peak/cap)·각 워커 sharded vu_stages) | ✅ subprocess |
| R2 | 통합 `nonpool_vu_curve_peak_over_cap_accepted`(201) + 노브충돌/빈-stage 400 회귀 | |
| R3 | 단위 `nonpool_vu_curve_stage_shard_split`(균등·Σ=target) | |
| R4 | 통합 `nonpool_vu_curve_unique_rows_lt_workers_rejected`/`_ge_workers_ok` + 단위 `fanout_worker_count` 단일 소스 | |
| R5 | 단위 `nonpool_vu_curve_peak_stage_equals_vu_count`·`_offsets_disjoint_cover_peak`·`_subpeak_zero_share_parks` | |
| R6 | 기존 곡선/fixed/open/풀 스위트 green + active-VU N=1 출력 단언 + `cargo build --workspace` + `git diff --stat` 경로 확인 | |
| R7 | active_vu_series SUM 머지(actual peak ≈ 곡선 peak) | ✅ subprocess |
| R8 | security-reviewer(매치 시) + active_vu worker_id 비노출 grep | |
| R9 | `e2e_kind_driver` 단일 run→곡선 교체 → 워크플로 라이브 Indexed N=2 단언 통과 + REST smoke 통과 | ✅ kind |

- **라이브 검증 필수**(run-생성·dispatch·report-파싱 경로 변경·S-D 갭): `/live-verify`로 subprocess 스택(50ms responder·격리 DB·`--worker-capacity-vus` 작게) → peak>cap 곡선 run이 N개 워커 spawn·`active_vu_series` SUM 머지·총 VU/RPS 보존·`/report` `ReportSchema` 파싱. **+ kind**: `scripts/e2e-kind.sh` 1회 실행 — 곡선으로 교체된 driver run이 워크플로 라이브 `Indexed && completions=2` 단언 + REST smoke 통과.
- main-only 와이어링 아님(spawn_run은 통합/e2e가 거침) — 단 N>1 fan-out의 실제 워커 spawn·머지는 subprocess 라이브가 결정적.

---

## 7. 의도적 연기 (roadmap §B9에 누적)

- **per-stage 워커 분해 리포트**(어느 stage에서 어느 워커가 꺾였나): active-VU는 SUM 총량만. per-worker 게이지 노출은 별도(읽기-경로 확장·CSV/XLSX 열 포함).
- **worker-count UI 표시**(곡선 run이 N 워커 fan-out됨): fixed-VU도 silent라 일관성상 비표시. roadmap §B9 "곡선 run의 VU 표시 개선"과 묶음.
- **closed-loop `worker_count` override 노브**: 현재 closed는 capacity로 N 유도(open 전용 노브·ADR-0038). 명시 N 지정은 별도.
- **pool/비-풀 곡선 샤딩 경로 통합**: 두 경로가 `reduce_pool_profile`을 공유하나 reserve/N-도출이 다름(풀=동적 min(idle,*cap)·비-풀=결정적 ceil). 통합 리팩터는 비목표.
- **best-effort/degraded fan-out**(워커 일부 실패 시 부분 완주): 비-풀 곡선도 fail-fast(§B2'' 동일·profile 이음새만).
- **N 상한/가드**: fixed-VU 매치로 무계. 낮춘 capacity로 N 폭증 방지 가드는 별도(운영 상한 관리자 곁다리).
- **fixed-VU 전용 kind 단언 소실(사용자 결정 Option A)**: R9가 driver의 단일 run을 곡선으로 교체하므로 kind CI는 더 이상 fixed-VU N=2를 *직접* 단언하지 않는다 — 곡선 run이 동일 Indexed-Job dispatch 경로를 strict superset로 검증하고 `worker_count(vus,cap)`은 단위테스트가 커버하므로 의미적 손실은 미미. fixed-VU kind 단언 복원이 필요하면 별도(워크플로 2-run 동기화·A3c Job 삭제 타이밍 fragile, Option B).
- **0-share sub-peak 가시화**: 엔진 park는 정상이나, "이 워커는 이 stage에서 0 VU"를 리포트로 보이는 건 per-stage 분해(위)에 흡수.

---

## 8. 구현 순서 (plan 입력)

> cargo-영향 커밋마다 전체 워크스페이스 게이트 → RED 테스트만/미사용 헬퍼만 단독 커밋 불가. green fold 지점 명시.

1. **컨트롤러 N 단일화 + 거부 제거 + 단위/통합 테스트 (단일 green 커밋)** — 4.1(헬퍼 추출·vu_curve N=ceil(peak/cap)) + 4.2(258 거부 제거) + 4.3 인라인 단위(R3/R5) + 통합 테스트(R1/R2/R4: `nonpool_vu_curve_*`). 헬퍼·N 변경·거부 제거·테스트가 한 의미 단위라 fold(테스트만 먼저 커밋하면 RED 게이트 실패). active-VU(4.4)는 무변경이라 별도 작업 없음.
2. **e2e_kind_driver run을 곡선으로 교체 (커밋)** — 4.5(driver 단일 run profile `vus:50`→`vu_stages`). controller crate라 1번과 별 커밋 가능(또는 fold).
3. **라이브 검증** — subprocess(R1/R7) + kind(R9). 머지 전 필수.

- 단일-task 성격(컨트롤러 + 테스트, 작은 diff) — plan은 1~2 task로 충분. 최종 `handicap-reviewer`가 ① validate-N↔dispatch-N 단일 소스 ② peak-stage==vu_count 불변식 ③ byte-identical(proto/engine/migration/UI 0) 대조. 보안 path-gate(요청실행/샤딩) 매치 시 `security-reviewer`.

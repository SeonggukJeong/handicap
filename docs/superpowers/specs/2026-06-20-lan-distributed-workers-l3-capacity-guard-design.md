# LAN 분산 워커 L3 — 과부하 가드 (capacity-aware 풀 배정, ADR-0041 후속)

> **이 파일의 척추는 §2 요구사항 표(R-id)다.** plan·구현·리뷰가 전부 이 ID를 참조한다.

- **날짜**: 2026-06-20
- **상태**: 설계 승인(사용자 2026-06-20 — 텍스트 설계 OK, 실동작은 라이브 검증서 확인) → plan 대기
- **출처**: roadmap §LAN 분산 / ADR-0041 §연기 "과부하 capacity 가드" + 런북 `docs/dev/lan-workers.md` §4 "⚠ 과부하 미가드 경고". **왜 지금**: L1이 `--capacity-vus`를 와이어로 받아 `PoolEntry`에 저장만 하고 **배정에 무시**한다(런북 §4: 워커 2대·`vus:100`이면 PC당 능력 20이어도 50 VU 배정). 사내에서 여러 PC를 실제 풀로 묶어 돌리려면 워커당 능력을 존중하는 배정이 운용 안정성의 전제다.
- **연관**: ADR-0041(L1 — 풀 레지스트리·`reserve_idle_pool`/`assign_pool_workers`·`PoolEntry.capacity_vus`), L2(`2026-06-20-lan-distributed-workers-l2*` — 대시보드·RunDialog 풀 프리뷰), ADR-0027(fan-out·`shard_split`), ADR-0024(dataset DELETE soft-409 = `ApiError::ConflictJson` 선례), ADR-0035(ko.ts). 런북 `docs/dev/lan-workers.md`.
- **ADR**: 신규 불필요(ADR-0041 범위 내 additive — "per-worker capacity는 L1 무시[L2/L3 가드]"가 이미 예고된 후속). 단 **soft-guard + `?force` 강행 결정은 §3에 명문화**, 완료 시 ADR-0041 §귀결·roadmap 갱신.

---

## 1. 문제와 목표

L1 풀 배정은 closed-loop run에서 `N = min(유휴, vus)`개 워커를 잡고 `shard_split`로 VU를 **균등** 분할한다 — 각 워커가 선언한 `capacity_vus`(`Register.capacity_vus=3` → `PoolEntry`에 이미 저장, L1이 의도적 dead 보존)를 무시한다. 그래서 능력이 작은 PC가 자기 한도를 넘는 VU를 받아 과포화될 수 있다. 이 슬라이스는 **closed-loop 풀 배정이 워커당 `capacity_vus`를 존중**하게 만들고, 풀 총 용량이 부족하면 **silently 과부하 대신 사용자에게 알리고 선택**(줄여 진행 / 강행)하게 한다.

- **목표**: ① 용량 충분 시(Σ유휴 capacity ≥ vus) 균등 분할을 **water-fill**(각 워커 ≤ `capacity_vus`)로 교체 — 능력 있는 워커의 여유를 써 작은 워커 과부하 방지. ② 용량 부족 시(Σ유휴 capacity < vus) **soft 409 + `{achievable_vus, requested_vus}`** 로 run 미생성 → UI가 "줄여 진행(clamp)" / "강행(force)" / "취소" 확인. ③ RunDialog 프리뷰에 총 용량 표시 + 초과 시 제출 전 인라인 힌트.
- **비목표(연기)**: §7 참조. open-loop·VU 곡선 capacity(다른 메트릭 필요)·dataset `unique` 비례 분할·degraded/부분-실행 상태·하트비트·제어 액션·mTLS.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

> MUST/SHOULD는 전부 여기 행으로. 산문(§3·§4)은 근거·방법만. **흘리기 쉬운 불변식/byte-identical/fallback/seam을 특히 R로.**

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | `MUST` 순수 함수 `capacity_split(total_vus: u32, caps: &[u32]) -> Vec<u32>`를 `grpc/shard.rs`에 추가(tonic-free) — **알고리즘 = 균등 `shard_split` 분포에서 출발**(워커 i 시작값 = `shard_split(total, n, i).1`)**해 cap(`caps[i].max(1)`, R7) 초과분을 미달 워커로 재분배**(R5 byte-identical을 *구성으로* 보장 — 아무 cap도 안 조이면 `shard_split`과 정확히 동일 벡터). `Σcaps.max(1) ≥ total_vus`이면 **합 == total_vus**·각 `≤ caps[i].max(1)`, 결정적(입력 순서). 워커 i의 vu_offset = Σ(count[0..i])라 전역 vu_id 연속·disjoint(`shard_split`과 동일 계약). | 단위 `capacity_split_respects_caps_and_sums`(합·각≤cap·연속 disjoint·결정적) | |
| R2 | `MUST` closed-loop(`!is_open_loop() && !is_vu_curve()) 풀 배정이 균등 `shard_split` 대신 `capacity_split`로 워커별 vu_count를 산출해 push한다(능력 작은 워커는 자기 한도까지만, 여유는 큰 워커가 흡수). 선택 = `N=min(유휴, vus)` 워커, **worker_id 정렬로 결정적**. | 통합 `pool_assigns_capacity_aware`(이질 capacity 워커 → 불균형 split이 각 cap 이하·합=vus) | |
| R3 | `MUST` non-force closed-loop 풀 run이 **유휴>0 AND `vus > achievable_vus`**(R6)면 **409 `{achievable_vus, requested_vus}`**(`ApiError::ConflictJson`, `{error}` 비래핑) 반환 + **정상 경로에서 run 미생성**(`spawn_run` 시작·`runs::insert`(runs.rs:500) *전*의 읽기전용 사전검사로 거부 → DB insert/예약/enqueue 0). **유휴==0(achievable==0)은 409 아님 — 기존 빈-풀 400 경로 유지**(원자예약 분기, "0 VU로 줄여 진행" 무의미 다이얼로그 방지). 사전검사~원자예약 사이 드문 TOCTOU(풀 축소)는 원자예약(R6)이 권위 게이트 — row 존재라 기존 빈-풀과 동형 `mark_failed` 폴백. | 통합 `pool_insufficient_capacity_returns_409`(저-cap 워커·큰 vus → 409 본문 숫자·`runs::get` None) + `pool_zero_idle_returns_400`(유휴 0 → 기존 400, 409 아님) | ✅ REST wire (axum Json ↔ UI 파싱) |
| R4 | `MUST` `POST /api/runs?force=true`는 closed-loop 풀 용량 가드를 **건너뛰고** closed-loop를 **기존 L1 경로**(`reserve_idle_pool` + `register` 내부 `shard_split` 균등)로 라우팅한다(선언 capacity 무시·과부하 감수·precomputed counts 미저장 → register fallback). force=true면 용량 충분이어도 균등 분할(가드 전체 우회). | 통합 `pool_force_skips_guard`(저-cap·큰 vus + `?force=true` → 201·균등 분할 = L1 byte-identical) | ✅ REST surface (`?force` 쿼리) |
| R5 | `MUST`(불변식) **byte-identical (조건부)**: 선택된 모든 워커의 `capacity_vus` ≥ 자기 균등-share(= 전원 기본 1000 & `vus ≤ N×1000`인 압도적 흔한 경우)면 `capacity_split` 결과 == `shard_split` 균등 → L1 풀 배정과 byte-identical(R1 알고리즘이 구성으로 보장). **proto·worker·migration·엔진 0**, open-loop·VU곡선 풀 경로 무변경, 비-풀(subprocess/k8s) 경로 무변경, **legacy gRPC fan-out register(coordinator.rs:901) 무변경**(precomputed counts 부재 시 `shard_split` fallback). | 단위 `capacity_split_equals_even_when_slack`(모든 cap≥share → shard_split과 **벡터 동일**, **remainder≠0 shape 포함** 예 total=5,n=2→[3,2]·total=7,n=3→[3,2,2]) + 통합(전원 기본 cap run = L1 배정) | |
| R6 | `MUST` `achievable_vus` = **Σ max(capacity_vus, 1) over 유휴 워커 전체**(용량이 조이는 경우는 유휴 전원을 쓰므로 Σ-전체가 도달가능 상한). 컨트롤러가 풀 락 안에서 1회 계산(TOCTOU 회피). clamp 재전송(`vus=achievable_vus`)은 항상 충분→배정 성공. | 통합 `pool_clamp_resubmit_succeeds`(409의 achievable로 재전송 → 201) | |
| R7 | `MUST` `capacity_vus == 0`(워커가 명시 0)은 capacity 계산에서 **1로 floor**(기존 `shard::worker_count`의 `capacity.max(1)` 컨벤션 정렬) — 0-용량 워커도 최소 1 VU 수용, 전원 0인 퇴화 케이스 회피. | 단위 `capacity_split_floors_zero_to_one` | |
| R8 | `MUST` RunDialog 풀 프리뷰(L2 "유휴 워커 M대")를 **"유휴 워커 M대 · 총 용량 X VU"**(X = Σ유휴 capacity, floor 1)로 확장 + **closed-fixed(고정 VU) `vus > X`**면 제출 *전* 인라인 힌트("풀 용량 X VU 초과 — 줄이거나 강행"). **open-loop·VU곡선(payload `vus:0`)·비-풀 = 힌트 미표시**(서버 `!is_vu_curve()` 게이트와 정합, §3.6); 프리뷰 byte-identical. | RTL `RunDialog`(총 용량 표시·closed-fixed vus>X 힌트·vus≤X 부재·open-loop/curve 무힌트) | ✅ Zod(L2 `capacity_vus`) ↔ UI |
| R9 | `MUST` UI가 `POST /api/runs` 409를 받으면 확인 다이얼로그: **[X VU로 줄여 진행]**(=`vus:X`로 재전송) / **[X 무시하고 강행]**(=`?force=true`로 동일 페이로드 재전송) / **[취소]**(미생성). 일반(비-풀·충분) run 경로 byte-identical(409 안 옴). | RTL `RunDialog`(409 mock → 다이얼로그·clamp가 `vus:X` POST·강행이 `?force=true` POST·취소 미전송) | ✅ REST wire (R3 본문 ↔ UI) |
| R10 | `SHOULD` 신규 UI 문구 전부 `ko.*` 네임스페이스 경유(ADR-0035 — 인라인 한국어/영어 0). **+ L2 대시보드 `ko.colCapacity`(ko.ts:166)의 "미적용" 한정어 제거/갱신** — L3가 capacity를 *적용*하므로 기존 라벨이 거짓이 됨. | grep: 신규/수정 컴포넌트 `ko.*`·인라인 0 + `colCapacity` "미적용" 부재 | |
| R11 | `MUST`(문서·무변경) dataset `unique` 슬라이싱(`dataset_slice`, shard-count 균등)은 **무변경** — **disjointness 보존**(각 unique 행은 여전히 ≤1회 소비, shard_count=워커 수 불변이라 `rows < N` 게이트도 무영향). capacity-aware 불균형 VU split은 **소비 *속도*만** 불균등하게 만들 뿐(많은 VU 받은 워커가 자기 슬라이스를 먼저 소진→stop-on-exhaust graceful) 정확성 불변식을 깨지 않음. v1 한계로 **명시 문서화**(uniqueness 위험 아님을 분명히), 비례 분할은 연기(§7). | `dataset_slice` diff 0 + spec/런북 한계 노트(disjointness 보존 명시) | |
| R12 | `MUST`(보안) 409 본문은 **`{achievable_vus, requested_vus}` 숫자뿐** — worker_id·hostname·token·env/dataset 시크릿 일절 미포함. `?force`는 가드만 우회하고 **토큰 인증(`check_token`)은 우회 안 함**. | security-reviewer + 본문 token/hostname 부재 grep | |

- **`seam?`** — 와이어 변경 1곳: **R3/R9**(REST 409 `{achievable_vus, requested_vus}`, axum `ConflictJson` ↔ UI 파싱) + **R4**(`?force=true` 쿼리 표면). **proto·migration·DB·엔진 변경 없음**(R5). plan은 컨트롤러 409 본문 task와 UI 확인-다이얼로그 task를 같은 계약으로 묶고, 최종 `handicap-reviewer`가 본문 키 ↔ UI 파싱 1:1 대조.

---

## 3. 핵심 통찰 (설계 근거)

1. **데이터는 이미 와이어에 있다 — 컨트롤러가 안 읽었을 뿐.** `Register.capacity_vus=3`(워커 `--capacity-vus` 기본 1000) → `pool_register_idle`이 `PoolEntry.capacity_vus`에 저장(coordinator.rs:312-329) → `pool_snapshot`이 이미 노출(L2 대시보드 "용량" 열). L1은 배정에서 이를 의도적으로 무시했다("capacity는 settings가 아니라 LOAD" — 컨트롤러 CLAUDE.md). 이 슬라이스는 **그 저장값을 closed-loop 배정에서 읽어 쓰는 컨트롤러-사이드 변경**이라 proto·worker·migration이 필요 없다(R5). [R1·R2·R5]

2. **균등 분할은 총량이 충분해도 워커를 과부하시킬 수 있다 — 그래서 total 검사가 아니라 per-worker water-fill이 코어다.** 워커 cap `[5, 1000]`·vus=30이면 Σcap=1005 ≥ 30이라 "총량 부족" 검사는 통과하지만 균등 15/15는 워커A(cap5)를 3× 과부하시킨다. `capacity_split`이 5/25로 채워 큰 워커의 여유를 흡수해야 런북 §4의 실제 문제("워커당 배정 VU가 PC 능력 초과")가 풀린다. 그래서 가드는 (a) 분배를 capacity-aware로 바꾸고 (b) 총량 부족 시에만 사용자에게 묻는 2층이다. [R2·R3]

3. **soft-guard + 강행은 두 정직한 run을 낳아 degraded 기계장치를 회피한다(사용자 결정 2026-06-20).** 용량 부족 시 선택지는 — **줄여 진행**: `vus=achievable`로 재전송 → run 기록이 곧 X-VU run(리포트가 X-VU run을 정직히 표현, 부분-완료 배지 불요). **강행**: `?force=true` → 선언 capacity를 무시(advisory 힌트라 OS 하드캡 아님)하고 100 VU를 그대로 균등 배정 → 정직한 100-VU run(능력 초과 워커에서 느리게 돌 뿐, 모든 VU 실행). **두 경로 다 degraded 상태 enum·배지·리포트 표기가 0**이라 슬라이스가 타이트하다. dataset-delete soft-409(`ApiError::ConflictJson` + `?force=true`, ADR-0024)의 직접 선례를 미러. [R3·R4·R9]

4. **achievable = Σ유휴 capacity(floor 1)인 이유 = 용량이 조이는 경우는 유휴 전원을 쓴다.** `N=min(유휴, vus)`라 유휴 ≥ vus면 N=vus·워커당 cap≥1 → Σ선택 ≥ vus → 항상 충분(부족 불가). 부족은 오직 유휴 < vus일 때이고 그땐 유휴 전원이 선택되므로 도달가능 상한 = Σ-유휴-전체. 컨트롤러가 풀 락 한 번에 achievable 계산 + (충분 시) 예약을 원자적으로 해 TOCTOU(검사-후-워커이탈)을 피한다. [R6]

4b. **0-용량 floor = 기존 컨벤션 재사용.** `shard::worker_count`가 이미 `capacity.max(1)`로 0을 방어한다(0÷ceil 폭주 회피). `capacity_split`도 같은 floor를 써 "전원 cap 0 → achievable 0 → 항상 409"인 퇴화·혼란을 막는다(0은 보통 미설정 실수). [R7]

5. **byte-identical은 "능력이 안 조일 때"가 헤드라인 불변식이다.** 전원이 기본 cap 1000이고 `vus ≤ N×1000`이면 균등-share ≤ 1000 ≤ cap이라 water-fill이 정확히 균등 분할과 같은 벡터를 낸다 → L1 풀 배정과 byte-identical. 가드는 *누가 `--capacity-vus`를 작게 선언했을 때만* 작동한다. `?force=true`는 그 escape hatch로 균등 분할(=L1)을 복원한다. [R4·R5]

6. **open-loop/VU곡선은 capacity_vus와 의미가 안 맞아 범위 밖.** open-loop 부하는 `target_rps`/`max_in_flight`(슬롯) 단위로 분할되지 VU가 아니고, 워커의 open-loop 천장은 `capacity_vus`로 안 잡힌다(다른 메트릭 `capacity_rps`/`slots` 필요 → proto 변경). VU 곡선은 단일워커(L1 §3). 그래서 이 가드는 **closed-loop 고정 VU 풀 경로**(`n_cap = profile.vus`인 그 `else` 분기, runs.rs:642)에만 건다 — open/curve 분기는 무변경(R5). [R5]

7. **`?force`는 ephemeral 의도라 profile에 영속시키지 않는다.** 강행은 "이번 발사에 가드 무시"이지 시나리오/프리셋 속성이 아니다 → 쿼리 파라미터로 받고 `Profile`에 필드를 더하지 않는다(persisted run config 비오염, ADR-0013). dataset-delete `?force=true`와 동형. [R4]

---

## 4. 변경 상세

> 파일·함수 단위. 각 묶음 머리에 **충족 R**.

### 4.1 `crates/controller/src/grpc/shard.rs` — 충족 R: R1, R5, R7
- 신규 순수 `pub fn capacity_split(total_vus: u32, caps: &[u32]) -> Vec<u32>`. **알고리즘(R5 byte-identical을 구성으로 보장)**:
  1. **균등 출발**: `alloc[i] = shard_split(total_vus, n, i).1`(기존 함수 재사용 → 아무 cap도 안 조이면 결과가 정확히 `shard_split` 벡터, R5).
  2. **초과분 회수**: `cap_i = caps[i].max(1)`(R7). `alloc[i] > cap_i`인 워커는 `overflow += alloc[i] - cap_i; alloc[i] = cap_i`.
  3. **여유분 재분배**: `overflow`를 `alloc[j] < cap_j`인 워커들에 결정적 순서(입력 인덱스)로 `min(cap_j - alloc[j], 남은 overflow)`씩 채움. (`Σcap ≥ total`이면 overflow 전량 흡수 → 합 == total.)
  - cap이 아무 데서도 안 조이면 2~3단계가 no-op → `alloc == shard_split`(R5). 결정적·O(n) 1~2패스.
- 반환 벡터 합 == `total_vus`(Σcap.max(1) ≥ total일 때), 각 `≤ caps[i].max(1)`. contiguous offset은 호출자가 누적합으로 도출(워커 i offset = Σalloc[0..i]). **`shard_split`/`worker_count`/`dataset_slice`는 무변경**(R11).
- `achievable`(R6) 헬퍼도 여기(또는 coordinator)에 단일 소스로: `caps.iter().map(|c| c.max(1)).sum()`. 사전검사·원자예약이 **같은 헬퍼** 사용(드리프트 방지, CLAUDE.md "single source").
- 단위 테스트: 합·각≤cap·결정적·**slack이면 `shard_split`과 벡터 동일(remainder≠0 shape 포함)**(R5)·0-floor(R7)·부족(Σcap<total)이면 cap까지만 채워 합<total.

### 4.2 `crates/controller/src/grpc/coordinator.rs` — 충족 R: R2, R6, R7
**핵심 seam(MAJOR-1): `register`(coordinator.rs:442)가 shard를 *내부 계산*하고 legacy gRPC fan-out 핸들러(:901)와 공유되므로, register 시그니처를 바꾸지 않는다.** 대신 precomputed counts를 `RunWorkers`에 실어 register가 *있으면 읽고 없으면 `shard_split` fallback* 하게 한다 — legacy/open/curve/force 경로는 precomputed 부재로 byte-identical(R5).

- **`RunWorkers`에 `precomputed_counts: Option<Vec<(u32,u32)>>` 추가**(shard_index→(vu_offset, vu_count)). 기본 `None`.
- **`register`(:442)**: `let (vu_offset, vu_count) = match &rw.precomputed_counts { Some(c) => c[shard_index], None => shard_split(rw.total_vus, rw.expected, shard_index) }`. `None`이면 기존과 100% 동일 → legacy :901·force·open/curve 무변경.
- **`enqueue`(:389)에 `precomputed: Option<Vec<(u32,u32)>>` 인자 추가**(struct literal에 저장). 모든 호출부 갱신(legacy/open/curve/force는 `None`).
- **신규 읽기전용 `pub async fn pool_achievable_capacity(&self) -> (usize, u32)`**(사전검사용): 풀 락 잡고 유휴 워커를 worker_id 정렬로 모아 `(idle_count, Σ caps.max(1))` 반환(§4.1 단일 sum 헬퍼 사용, 락을 await 너머로 안 듦). `reserve_idle_pool_capacity`와 **같은 헬퍼·같은 순서**(드리프트 0, R6).
- 신규 `pub async fn reserve_idle_pool_capacity(&self, run_id: &str, total_vus: u32) -> PoolReservation`(enum, **non-force closed-loop 전용**): 풀 락 1회 안에서 — ① 유휴 워커를 **worker_id 정렬로 수집**(MINOR-2, take/caps-벡터 둘 다 이 순서) → `caps` 벡터. **② 빈-풀 *먼저*: `caps.is_empty()`(유휴 0)면 `Reserved{ workers: vec![], counts: vec![] }`** → 호출자 기존 빈-풀 400(closed-loop `vus≥1`이라 `achievable 0 < vus`가 항상 참이므로, 이 emptiness 분기가 capacity 비교보다 *앞*이어야 idle 0이 `Insufficient`로 새지 않음 — R3/§5 정합). ③ `achievable = Σ caps.max(1)`(R6 단일 헬퍼). `achievable < total_vus` → `PoolReservation::Insufficient { achievable }`(예약 0 — 사전검사 통과 후 TOCTOU 축소만 도달). ④ 그 외: `N = min(유휴, total_vus)` 선택, `counts = capacity_split(total_vus, &caps[..N])` → 누적합으로 `(offset, count)` 벡터, 선택 워커 `assigned_run=Some`, `Reserved { workers: Vec<(worker_id, tx)>, counts }`.
- **`assign_pool_workers` 시그니처 불변**(`Vec<(worker_id, tx)>` 그대로) — counts는 `RunWorkers`에 enqueue가 실으므로 register가 읽는다. 즉 capacity 경로 = `reserve_idle_pool_capacity` → `enqueue(..., Some(counts))` → `assign_pool_workers(workers)`.
- L1 `reserve_idle_pool`(균등 take)은 **open-loop/VU곡선·force closed-loop 경로용으로 유지**(precomputed `None` → register shard_split, R4/R5).

### 4.3 `crates/controller/src/api/runs.rs::spawn_run` (490) — 충족 R: R2, R3, R4, R6
- `spawn_run`은 `runs::insert`(500)로 **row를 먼저 만든 뒤** 623의 pool 분기(`is_pool_mode()`)를 탄다(`row.id`가 reserve에 필요 — reserve가 워커를 `assigned_run=Some(run_id)`로 태깅하므로 insert가 reserve보다 앞설 수밖에 없음). 그래서 R3 "미생성"은 **insert *전* 사전검사**로 보장한다:
  - **사전검사(insert 전)**: `spawn_run` 시그니처에 `force: bool` 추가(`create`가 `?force` 쿼리에서, schedule-fire는 `false`). pool_mode && closed-loop(`!is_open_loop() && !is_vu_curve()`) && `!force`면 풀 락 읽기전용 `pool_achievable_capacity()`(§4.2)로 `(idle_count, achievable)` 취득 → **`idle_count > 0 && vus > achievable`**면 `ApiError::ConflictJson(json!({ "achievable_vus": achievable, "requested_vus": profile.vus }))` **즉시 반환**(insert/예약/enqueue 0, R3). **`idle_count == 0`은 사전검사 통과**(409 아님) → insert 후 원자예약이 빈 → 기존 빈-풀 400(R3 — "0 VU 줄여 진행" 방지).
  - **원자예약(insert 후)**: pool 분기(623)를 **모드로 fork**:
    - **closed-loop && `!force`**(capacity 경로): `reserve_idle_pool_capacity(row.id, profile.vus)` → `Reserved{workers, counts}` → `enqueue(.., Some(counts))` → `assign_pool_workers(workers)` / `Insufficient{achievable}`(사전검사~예약 TOCTOU 축소) → `cancel_dispatch_failed` + `mark_failed`(빈-풀과 동형, 드문 폴백) / `Reserved{vec![], _}`(유휴 0) → 기존 빈-풀 400.
    - **closed-loop && `force`**(R4 강행): **기존 L1 경로** `reserve_idle_pool(row.id, vus)` → `enqueue(.., None)` → `assign_pool_workers` (register가 precomputed 부재 → `shard_split` 균등, byte-identical).
    - **open-loop / VU곡선**: 무변경 — 기존 `reserve_idle_pool(row.id, n_cap)`(627-643 n_cap 그대로) → `enqueue(.., None)` → assign (R5). force·capacity 무관.
- `reserve_idle_pool_capacity`는 **force 인자 없음**(force는 위 fork에서 legacy로 라우팅, §4.2).
- **schedule-fire 공유 주의**: `spawn_run`은 스케줄러도 호출(`force=false`) — 예약 발사가 용량 부족이면 409가 fire 에러로 기록된다(자동 clamp/강행 없음, 사용자 결정 후속 §7). 인간 없는 경로라 정직한 실패가 안전. **이벤트 메시지는 v1에서 terse**(`ConflictJson` Display = "conflict" → `runner.rs:203` "발사 실패: conflict") — 수용, achievable/requested를 실은 명확한 메시지는 후속 polish(§7).

### 4.4 `crates/controller/src/error.rs` — 충족 R: R3
- `ApiError::ConflictJson(Value)`는 **이미 존재**(error.rs:20, dataset-delete soft-guard, ADR-0024; 409 + 본문 그대로 `{error}` 비래핑, error.rs:32-33) → 재사용(신규 추가 불요). 라우트가 `?force` 쿼리를 받도록 `create` 핸들러에 `axum::extract::Query<ForceQuery>`(body `Json`보다 앞) 배선.

### 4.5 `ui/src/components/RunDialog.tsx` — 충족 R: R8, R9, R10
- **프리뷰 확장(R8)**: L2 `usePoolWorkers` 데이터에서 `idleCapacity = Σ workers.filter(!busy).capacity_vus.max(1)` 도출 → 배너에 "유휴 워커 M대 · 총 용량 X VU". **closed-fixed(고정 VU) & `vus > X`**면 인라인 힌트(`ko.*`). open-loop/VU곡선(`vus:0`)/비-풀 = 힌트 미표시·byte-identical.
- **409 확인 흐름(R9)**: run 생성 mutation이 409면 응답 본문(`achievable_vus`)을 파싱해 확인 다이얼로그(`ko.*` 3버튼). [줄여 진행] → `createRun({...payload, profile:{...profile, vus: achievable}})`. [강행] → `createRun(payload, { force: true })`(쿼리). [취소] → no-op. clamp/force 모두 동일 mutation 재호출(중복 다이얼로그 가드).
- 비-풀·충분 run = **409 안 옴 → byte-identical**(기존 성공 경로 무변경).

### 4.6 `ui/src/api/{client.ts, hooks.ts}` — 충족 R: R9
- **MAJOR-3: 공유 `request<T>`(client.ts:31-60)는 에러 본문을 `ApiErrorSchema{error:string}`(schemas.ts:222)로 파싱해 *문자열만* 던지므로 409의 `{achievable_vus,...}` 숫자가 버려진다.** → `api.createRun`(client.ts:138)을 **`deleteDatasetImpl`(client.ts:92-111) 패턴의 bespoke `fetch`**로 교체: optional `{ force?: boolean }`로 `?force=true` 쿼리(미지정=쿼리 없음=byte-identical), 응답 `status===409`면 JSON 본문을 읽어 **`{achievable_vus, requested_vus}`를 실은 전용 에러**(예: `PoolCapacityError`)를 throw, 그 외는 기존 동작. (대안: `ApiError`에 `body?` 필드 추가 + `request`가 409만 특례 — 둘 중 plan이 택1, deleteDataset 선례라 bespoke 권장.)
- `useCreateRun`(hooks.ts:122)이 `{force}`를 통과시키고, mutation `onError`/`error`가 `PoolCapacityError`면 RunDialog가 `achievable_vus`를 읽는다. 비-409 경로 byte-identical.
- **`PoolCapacityError.message`는 사람이 읽을 한국어**(예: `ko` 경유 "풀 용량 X VU 부족 — RunDialog에서 vus 조정"): clamp/강행 다이얼로그는 **RunDialog 한정**(R9·§4.5)이고, 다른 `createRun` 호출부(`RunDetailPage.tsx:148` 즉시 재실행·`ScenarioRunsPage.tsx:316` 재실행/`?retry=`)는 기존 에러 배너(`error.message`)로 그 메시지를 노출한다 — 크래시 0·다이얼로그 미표시(스코프 밖, §5 명시). 두 재실행 경로에 다이얼로그 확대는 연기(§7).

### 4.7 `ui/src/i18n/ko.ts` — 충족 R: R10
- `ko.runDialog`(또는 신규 `ko.capacityGuard`) 네임스페이스: 총 용량 라벨·초과 힌트·확인 다이얼로그 제목/본문·3버튼(줄여 진행/강행/취소)·강행 경고.
- **L2 `ko.colCapacity`(ko.ts:166) "용량(VU, 선언값·미적용)" 갱신**: L3가 capacity를 *적용*하므로 "미적용" 한정어 제거(예: "용량(VU)") — 거짓 라벨 방지(MINOR-1).

### 4.8 `docs/dev/lan-workers.md` — 충족 R: R11, R12
- §4 "⚠ 과부하 미가드 경고"를 **"과부하 가드(L3)"**로 갱신: capacity-aware 배정·용량 부족 시 줄여진행/강행 동작·`?force=true` 의미. **dataset `unique` 한계 노트**: 불균형 split에서 **disjointness는 보존**(각 행 ≤1회 소비·`rows<N` 게이트 무영향) 되고 소비 *속도*만 불균등(많은 VU 워커가 먼저 소진), uniqueness 위험 아님 명시(R11/MINOR-5). §8 한도 요약 표 갱신.

---

## 5. 무변경 / 불변식 (명시)

- **proto·worker(`crates/worker`,`worker-core`)·엔진(`crates/engine`)·migration·DB 스키마·리포트·CSV/XLSX/비교·메트릭 머지·`shard_split`/`worker_count`/`dataset_slice`·토큰 검사(`check_token`) 전부 무변경.** `capacity_vus`는 이미 와이어/저장됨 → **migration 0 / proto 0**.
- **open-loop·VU 곡선 풀 배정 무변경**: 그 경로는 `capacity_vus`와 의미 불일치라 L1 `reserve_idle_pool` + 균등 유지(R5·§3.6).
- **비-풀(subprocess/k8s) fan-out 무변경**: `settings.worker_capacity_vus()` + `shard::worker_count` 균등 split 그대로(컨트롤러 정책 capacity, 워커 선언 capacity와 별개 — A3a 노트).
- **byte-identical (조건부, R5)**: 선택 워커 전원 `capacity_vus ≥ 균등-share`(전원 기본 1000 & `vus ≤ N×1000`) → water-fill == 균등 → L1 byte-identical. `?force=true` = 항상 균등(L1 복원).
- **degraded/부분-실행 상태 없음**(§3.3): 줄여진행=정직한 X-VU run, 강행=정직한 100-VU run. 상태 enum·배지·리포트 표기 0.
- 기존 run-create 성공 경로(비-풀·open-loop·충분 closed)는 **409 미발생 → byte-identical**. `?force` 미지정 호출은 쿼리 없음.
- **빈 풀(유휴 0) = 기존 400 유지**(R3): 사전검사는 `idle>0`일 때만 409 → 유휴 0은 기존 빈-풀 400 경로 그대로(메시지·코드 무변경).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | `capacity_split_respects_caps_and_sums`(합·각≤cap·연속·결정적) | |
| R2 | 통합 `pool_assigns_capacity_aware`(이질 cap → 불균형 split·각≤cap·합=vus) / 라이브 | ✅ |
| R3 | 통합 `pool_insufficient_capacity_returns_409`(저-cap·큰 vus → 409 본문 숫자·run row 부재) + `pool_zero_idle_returns_400`(유휴 0 → 기존 400) | ✅ |
| R4 | 통합 `pool_force_skips_guard`(`?force=true` → 201·균등 = L1) | ✅ |
| R5 | 단위 `capacity_split_equals_even_when_slack` + 통합(전원 기본 cap = L1 배정)·기존 풀 스위트 green | |
| R6 | 통합 `pool_clamp_resubmit_succeeds`(409 achievable로 재전송 → 201) | ✅ |
| R7 | 단위 `capacity_split_floors_zero_to_one` | |
| R8 | RTL `RunDialog`(총 용량 표시·vus>X 힌트·vus≤X 부재·open-loop 무힌트) | ✅ |
| R9 | RTL `RunDialog`(409 mock → 다이얼로그·clamp `vus:X` POST·강행 `?force=true` POST·취소 미전송) | ✅ |
| R10 | grep: 신규/수정 컴포넌트 `ko.*`·인라인 리터럴 0(orchestrator 직접 재실행) | |
| R11 | `dataset_slice` diff 0 + 한계 노트 존재 | |
| R12 | security-reviewer + 409 본문 token/hostname 부재 grep | |

- **라이브 검증 필수**(`/live-verify`): run-생성 경로(`spawn_run` 풀 분기) + 신규 409 응답-파싱(RunDialog 확인 흐름) 변경 → S-D 갭(RTL fixture는 absent-not-null이라 서버 409 본문 키 미스매치를 놓침). **localhost 풀 스택**(런북 §9): `--worker-mode pool` 컨트롤러 + 풀 워커 2대를 **저 `--capacity-vus`**(예: 각 5)로 띄워 ① 충분(vus=8, cap 5+5=10) → water-fill 4/4 또는 5/3 (각≤5)·report req 정합 ② 부족(vus=20 > 10) → 409 `{achievable_vus:10, requested_vus:20}` ③ 줄여 진행(vus=10) → 201·완료 ④ 강행(`?force=true`, vus=20) → 201·균등 10/10 과부하 실행 ⑤ 전원 기본 cap(1000) run = L1 byte-identical. **cold-build 워커 race(CLAUDE.md S-A)** — `cargo build -p handicap-worker` 워밍.
- **실화면 사용자 리뷰**(사용자 요청): 라이브 스택 Playwright로 RunDialog 총 용량 프리뷰·초과 힌트·409 확인 다이얼로그(줄여진행/강행)를 사용자에게 보이고 의견 수렴 → 반영.

---

## 7. 의도적 연기 (roadmap §LAN 분산 / ADR-0041 §귀결에 누적)

- **open-loop / VU 곡선 capacity 가드**: `capacity_vus`는 closed-loop VU 메트릭 — open-loop는 `capacity_rps`/`slots`(신규 proto 필드) 필요, VU곡선은 단일워커. 별도 슬라이스(§3.6).
- **dataset `unique` 비례 분할**(R11): capacity-aware 불균형 VU split에서 워커별 unique 행을 vu_count 비례로 분배(현재 worker-count 균등). 드문 조합(unique + 이질 capacity) + stop-on-exhaust graceful이라 v1 연기 — 필요 시 `dataset_slice`에 vu 비례 인자.
- **degraded/부분-실행 모드**(B2''): "100 요청 중 X달성" 상태 enum·배지·리포트 표기. 이번 설계는 줄여진행/강행 두 정직 run으로 회피 — 진짜 부분-완료가 필요해지면 별도(워커 일부 실패 best-effort와 묶음).
- **measured capacity**(선언 `--capacity-vus` 대신 워커가 자기 처리량을 실측 보고): 현재 capacity는 운영자 선언 advisory 힌트. 자동 측정은 별도.
- **schedule-fire 자동 clamp/강행**: 예약 발사가 용량 부족이면 v1은 fire 실패로 기록(인간 선택 없음, §4.3). 예약별 "부족 시 clamp/강행/skip" 정책 노브 + achievable/requested 실은 명확한 이벤트 메시지는 후속.
- **재실행 경로 clamp/강행 다이얼로그**(RunDetailPage 즉시 재실행·ScenarioRunsPage 재실행/`?retry=`): v1은 RunDialog 한정 — 두 경로는 `PoolCapacityError.message` 배너만(§4.6). 다이얼로그 확대는 후속.
- **하트비트/last-seen**(half-open 유령 워커, 런북 §7a) · **제어 액션**(disconnect/exclude/per-worker cap) · **mTLS**(L3 보안) · **다중 동시 run**: L3 다른 후보, 별도 슬라이스.

---

## 8. 구현 순서 (plan 입력)

> cargo-영향 커밋마다 전체 워크스페이스 게이트 → green fold 지점 명시. seam(R3 409 본문 ↔ R9 UI)을 계약-먼저.

1. **순수 `capacity_split` + achievable 헬퍼**(R1·R5·R6·R7): `grpc/shard.rs` 함수(균등출발→초과회수→재분배 알고리즘) + 단위(합·cap·**slack==shard_split 벡터동일[remainder≠0 포함]**·0-floor·부족표현). 자족 green 커밋(헬퍼+단위 fold — 미사용-헬퍼 단독 커밋 불가).
2. **컨트롤러 capacity-aware 배정 + soft-guard**(R2·R3·R4·R6·R12): `RunWorkers.precomputed_counts` 필드 + `register`(:442) precomputed-or-`shard_split` fallback + `enqueue`(:389) precomputed 인자(전 호출부 `None`) + `reserve_idle_pool_capacity`(force 인자 없음) + `spawn_run` 사전검사(insert 전 409) + pool 분기 mode-fork(closed!force/closed-force/open·curve) + `?force` 쿼리(**axum: `Query<ForceQuery>`를 body `Json`보다 *앞*에 — 추출기 순서 footgun**) + `ConflictJson` 409. 통합(`pool_assigns_capacity_aware`/`_insufficient_*409`/`_force_skips_guard`/`_clamp_resubmit_*`/`_default_cap_byte_identical`). **사전검사로 "미생성"(R3)·legacy :901 register 회귀 0** 확인. 번들 게이트 무관(컨트롤러-only)이나 `--features bundle` 빌드 1회.
3. **UI 프리뷰 + 409 확인 다이얼로그**(R8·R9·R10): RunDialog 총 용량/힌트 + 409 다이얼로그(줄여진행/강행/취소) + **bespoke `createRun` fetch(409 본문 surface, deleteDatasetImpl 패턴)** + force 쿼리 + ko.ts(신규 + L2 `colCapacity` 갱신). RTL(프리뷰·힌트·409 흐름 3분기).
4. **런북 갱신**(R11·R12): lan-workers.md §4/§8 + unique 한계 노트.
5. **라이브 검증**(§6) + 실화면 사용자 리뷰 → 반영. **finish-slice**(ADR-0041 §귀결·roadmap·build-log·도메인 CLAUDE.md 갱신).

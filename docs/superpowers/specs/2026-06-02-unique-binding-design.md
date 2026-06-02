# `unique` 데이터 바인딩 정책 — 설계

- **날짜**: 2026-06-02
- **상태**: 설계 승인 (구현 대기)
- **선행**: A3 멀티 워커 fan-out (ADR-0027, 머지 완료) — 이 인프라가 깔린 뒤의 후속 하위 슬라이스
- **연관**: ADR-0022 (data-driven 데이터셋, "unique 예약"), Slice 8c (3정책 바인딩/주입), `2026-06-01-multi-worker-fanout-design.md` §6.4 (unique 설계 스텁)
- **로드맵**: §B1 / §B2'' "`unique` 바인딩(중앙 커서)"

## 1. 배경 & 스코프

데이터셋 행을 `{{var}}` 흐름 변수로 주입하는 3개 정책(`per_vu`/`iter_sequential`/`iter_random`)은 Slice 8c에서 완결됐다. 네 번째 정책 `unique`는 "행을 워커/반복 간 **중복 없이 전역 소진**"을 뜻하며, 멀티-워커 전역 분배가 필요해 8c에선 API/UI에서 거부(reserved)됐다. A3 fan-out 인프라가 머지된 지금, 그 위에서 `unique`를 구현한다.

**대표 use case**: "1만 개의 유니크 로그인 자격증명이 있다. 각 자격을 최대 1회만 써서 부하를 건다(재사용 금지)."

### IN (이 슬라이스)
- 엔진: `BindingPolicy::Unique` + 소진 시 `None` 반환 행 선택 + 소진 VU 종료.
- proto: `Policy.UNIQUE = 3`.
- 컨트롤러: 거부 게이트 제거 + 워커별 **disjoint 슬라이스** 정적 파티션(`shard_split` 재사용) + 슬라이스 오프셋 스트리밍.
- 워커: proto policy 매핑에 `Unique` arm.
- UI: 정책 드롭다운/Zod enum에 `unique` 추가 + 안내 배너.

### OUT (연기)
- **`on_exhaust: fail` 토글** (소진 시 run 실패): §3.3에서 기각된 대안. 미래에 opt-in profile 필드로 되살릴 수 있으나, "degraded/best-effort 토글" 계열(멀티워커 spec §11, 로드맵 §B2'')과 묶어 별도 슬라이스.
- **완벽 균형(라이브 중앙 커서)**: §3.2에서 기각(처리량 비용). 정적 파티션의 워커 간 소진-시점 비대칭은 수용.
- **소진 메트릭/리포트 표면화**: unique는 전용 카운터를 추가하지 않는다(§4.6). 소진은 기존 step 메트릭의 RPS 테이퍼로 자연히 드러난다.

## 2. 시맨틱 정의

`unique`는 `iter_sequential`의 **공유 워커-로컬 `AtomicU64` 커서**를 재사용하되, 단 하나의 차이가 있다: **`% len` modulo wrap 제거**.

- 워커 i 는 컨트롤러가 배정한 **disjoint 슬라이스** `rows[offset_i .. offset_i+count_i)` 만 메모리에 갖는다(타 워커와 행 겹침 0). 워커는 이 슬라이스를 로컬 인덱스 `0..count_i` 로 본다 — 전역 오프셋은 컨트롤러 내부 관심사이고 워커/엔진은 모른다.
- 한 워커 안의 모든 VU가 **하나의 공유 커서**를 당긴다. 매 반복 `idx = counter.fetch_add(1)`.
- `idx >= count_i` 이면 그 VU는 더 줄 행이 없으므로 **루프를 빠져나가 종료**한다(소진 시 stop-VU).
- 동시 VU 간에 *어느 VU가 어느 행을 받는지*는 스케줄링 의존(iter_sequential과 동일) — 하지만 **각 행은 정확히 1회** 소비되고 전역 유일성이 보장된다.

**run의 종료**: 한 워커의 모든 VU가 소진해 멈추면 그 워커의 VU join_set이 비고 → 워커가 `Completed` 보고 → 모든 워커가 Completed면 run 종료(기존 A3 완료 게이트 무변경). 즉 run은 **(데이터 전부 소진) 또는 (duration 도달)** 중 먼저 오는 시점에 끝난다. 데이터가 먼저 떨어지지 않으면 평소처럼 `duration`까지 돈다.

## 3. 설계 결정

### 3.1 왜 소진 = "그 VU만 종료"(stop-VU)인가

unique의 정의("한 번 쓰면 소진")는 *소진됐을 때 무엇을 할지*를 강제하지 않는다. 유일성을 깨지 않는 선택지는 둘뿐: ① 그 소비자가 더 안 돈다(stop-VU), ② 전부 멈춘다(fail/graceful-stop). wrap(재사용)은 유일성 위반이라 탈락.

stop-VU가 옳은 이유:
- **국소적·최소 개입**: 워커-로컬 처리, 추가 cross-worker 조정 0. 기존 완료 집계가 그대로 동작.
- `iter_sequential`의 자연스러운 무-wrap 확장 — 새 개념 도입 없음.
- "데이터 전부 소진 시 run 종료"가 emergent 하게 일어남(§2). 따라서 "각 행 1회씩 다 쓰고 멈춰라(duration 무관)" use case도 긴 duration + 자연 종료로 충족된다.
- 측정은 소진 구간에서 RPS가 테이퍼되지만, unique 용도엔 정직한 정보다("자격 1만 개를 t=T에 다 쓸 때까지 X RPS 유지").

### 3.2 왜 정적 disjoint 파티션인가 (라이브 중앙 커서 기각)

| 접근 | 처리량 | 균형 | 채택 |
|---|---|---|---|
| **정적 disjoint 슬라이스** (`shard_split(total_rows,N,i)`) | 런타임 round-trip 0 | 워커 동질 시 ~동시 소진(실무상 충분) | **채택** |
| 라이브 중앙 커서 (반복마다 컨트롤러 왕복) | 매 반복 왕복 → 처리량 붕괴 | 완벽 | 기각 |

spec §6.4의 "컨트롤러 중앙 커서"는 *런타임 커서*가 아니라 **컨트롤러가 분할 권위자**(누가 어느 슬라이스를 갖는지 결정)라는 의미로 해석한다. 부하 생성기의 1차 목표(정해진 VU 안정 생성)와 정합. 정적 파티션의 단점(워커 성능 비대칭 시 한쪽이 먼저 소진해 그 슬라이스의 미사용 행 발생)은 동질 fan-out(같은 capacity·균등 VU)에선 무시 가능하므로 수용한다.

### 3.3 왜 fail-fast(B) / 첫-소진-전체종료(C)를 기각하는가

- **C(첫 소진 시 전체 graceful 종료)**: disjoint 슬라이스에선 워커별 소진 시점이 제각각이라, "첫 소진"으로 끊으면 *가장 빨리 소진한 워커*가 run 운명을 결정 → 타 워커의 미사용 unique 행이 버려지고 측정 창이 자의적으로 잘린다. 게다가 합리적 버전("전부 소진 시 종료")은 §2의 stop-VU emergent 동작으로 이미 얻어진다. → C는 별도 선택지가 아님(A로 수렴).
- **B(fail-fast)**: "duration 내내 부하 못 채웠으니 무효"라는 입장은 가능하나, unique 소진은 워커 크래시·샤드 미등록 같은 **인프라 고장**이 아니라 **사용자가 정한 데이터 사이징의 결과**다. 실패 처리하면 소진 전까지의 유효 메트릭을 통째로 버리고 의도된 use case를 벌준다. 또 B도 "먼저 소진한 워커가 전체를 실패시키는" 자의성을 그대로 물려받는다. → 기본값 부적절. opt-in 토글로만 가치(§1 OUT).

## 4. 파이프라인 변경 (레이어별)

### 4.1 엔진 (`crates/engine`)

**`dataset.rs`**:
- `BindingPolicy`에 `Unique` 변형 추가(현재 PerVu/IterSequential/IterRandom).
- `select_index(vu_id, iter_id, counter) -> usize` 를 **`Option<usize>`** 로 변경:
  - `PerVu` → `Some(vu_id % len)` (항상 Some)
  - `IterSequential` → `Some(counter.fetch_add(1) % len)` (항상 Some)
  - `IterRandom` → `Some(rng.gen_range(0..len))` (항상 Some)
  - `Unique` → `let next = counter.fetch_add(1) as usize; if next >= len { None } else { Some(next) }` (소진 시 None, **wrap 없음**)
- `Unique`는 `seed` 미사용(RNG 없음). `select_index` 시그니처/`counter` 인자는 그대로(Unique도 IterSequential처럼 공유 카운터 사용).

**`runner.rs`**:
- `run_scenario`(~58): 공유 카운터를 `IterSequential` 단독 → **`IterSequential | Unique`** 둘 다에 생성.
- `run_vu`(~240): 행 overlay를 `match ds.select_index(...) { Some(idx) => 행 overlay, None => break }` 로. `None`이면 while 루프 탈출 → VU 정상 종료(`Ok(())`).

### 4.2 proto (`crates/proto/proto/coordinator.proto`)

- `DataBinding.Policy` enum에 `UNIQUE = 3;` 추가(주석 "reserved" 제거). enum 값 추가는 backward-compat 안전(controller/worker 동시 배포). `row_count` 주석("after policy-aware slicing")은 unique의 per-worker count에 그대로 맞음 — **메시지 구조 무변경**.

### 4.3 컨트롤러 — run-create 해석 (`api/runs.rs`)

- `validate_run_config`(line 64-68): `BindingPolicy::Unique` 거부 블록 **제거**. unique를 `per_iteration` cap 검사(line 89-92)에 포함 — unique는 전체 데이터셋을 워커들에 나눠 스트리밍하므로 총 DB 읽기 = 전체 행 → `--dataset-max-rows` 상한 적용. `rows > 0` 검사는 기존 유지. "행이 충분한가" 게이트는 없음(stop-VU라 반복수 미지 → 검증 불가).
- `create`(line 129-143): `BindingPolicy::Unique => unreachable!(...)` arm을 실제 arm으로 — `(Policy::Unique, meta.row_count as u64)`. unique는 **총행**을 `PendingDataBinding.row_count`에 저장(워커별 분할은 register 시점에 수행, §4.4).

### 4.4 컨트롤러 — 워커별 disjoint 파티션 (`grpc/coordinator.rs`)

핵심: per_vu/iter_*는 `row_count`가 **모든 워커에 동일(복제)** 이지만, unique는 워커마다 다른 `(offset_i, count_i)` 다.

- `assignment_for`(line 252): unique면 `(row_offset, row_count_i) = shard_split(total_rows, shard_count, shard_index)` 계산(`shard_split`은 `grpc/shard.rs`의 기존 순수 함수, u32). 빌드하는 proto `DataBinding.row_count = row_count_i`. 비-unique는 기존대로(offset 0, count = `binding.row_count`).
  - 반환에 워커별 **스트림 시작 오프셋**을 함께 넘겨야 함 → 반환 타입을 `(RunAssignment, Option<(PendingDataBinding, u64 offset)>)` 또는 `PendingDataBinding`에 `stream_offset` 필드 추가(택1, plan에서 결정). unique=offset_i, 비-unique=0.
  - `shard_split`은 u32라 `total_rows`(u64, cap≤dataset_max_rows로 실무상 u32 범위) 캐스팅 — cap 검증이 선행하므로 안전.
- `stream_dataset`(line 672): `start_offset` 파라미터 추가. `get_rows_range(db, dataset_id, start_offset + sent, limit)`, `total = count_i`. 비-unique는 `start_offset = 0` 으로 호출 = 기존과 byte-identical.
  - `row_count_i == 0`(빈 슬라이스, total_rows < N) → 호출부의 `if binding.row_count > 0`(line 635) 가드가 이미 스킵 → 그 워커는 데이터셋 없이 시작 → §4.1의 `dataset = None` 경로 = 즉시 소진(VU 0회 반복 후 종료).

### 4.5 워커 (`crates/worker/src/main.rs`)

- policy 매핑(line 118-128): `Ok(pb::data_binding::Policy::Unique) => BindingPolicy::Unique` arm 추가. `_ => unreachable!` 는 유지(forward-compat). 워커는 `b.row_count`(=count_i) 행을 `load_dataset`으로 받아 `DataSet { policy: Unique, seed, rows }` 빌드 — **disjoint 슬라이스임을 모른다**(로컬 0..count_i 인덱싱).

### 4.6 메트릭/리포트/DB

**무변경**. unique는 전용 카운터를 추가하지 않는다(loop_breakdown/if_breakdown과 달리). 소진은 기존 step 메트릭의 RPS 곡선으로 드러난다. `runs` 테이블 무변경(`data_binding`은 `profile_json` JSON, `#[serde(default)]`). `run_metrics`/loop/if 테이블 무변경.

### 4.7 UI (`ui/`)

- `api/schemas.ts:20`: `BindingPolicyEnum = z.enum([..., "unique"])`.
- `components/DataBindingPanel.tsx`:
  - 드롭다운(line 375-377)에 `<option value="unique">unique — 행마다 1회 소비, 소진 시 VU 종료</option>`.
  - 배너(`showBanner`, line 198): unique 포함. unique 전용 안내문(예: "데이터셋 전체를 워커별로 분할해 각 행을 1회만 사용합니다. 소진된 VU는 종료되고, 부하(RPS)는 그 시점부터 감소합니다.").

## 5. 엣지 케이스 & 불변

- **`total_rows < N`**: `shard_split`이 뒤쪽 워커에 count 0 배정 → 빈 슬라이스 워커의 VU 즉시 종료(부하 일부 미생성). 차단하지 않음(stop-VU 정합). UI에서 soft 경고는 선택(이 슬라이스에선 미구현 가능 — plan 판단).
- **`total_rows < total_vus`**: 일부 VU가 1회도 못 돌고 종료 가능 — 정상(stop-VU).
- **결정성**: 소비되는 *행의 집합*은 고정(전체, 각 1회)이나, *어느 VU/반복이 어느 행을 받는지*는 공유 커서 + 스케줄링 의존(iter_sequential과 동일 성질). 재현 가능한 시퀀스는 보장하지 않음 — 유일성만 보장.
- **N=1(단일 워커)**: 슬라이스 = 전체 행, 정상 동작(`shard_split(total,1,0)=(0,total)`). unique는 멀티워커 전용이 아님.
- **`seed`**: unique에서 미사용. proto/PendingDataBinding 필드는 유지(다른 정책 공유).
- **하위 호환**: unique 미선택 = byte-identical(비-unique 경로 `start_offset=0` 무변경, 엔진 `Option` 변경은 Some 경로 동일 동작).

## 6. 검증 게이트 요약 (`validate_run_config`)

| 정책 | rows>0 | cap(`--dataset-max-rows`) | row_count 의미 |
|---|---|---|---|
| per_vu | ✓ | 미적용(min(vus,rows) 슬라이싱) | min(vus, rows) |
| iter_sequential / iter_random | ✓ | 적용(전체 복제) | rows |
| **unique** | ✓ | **적용**(전체를 분할 스트리밍) | **총 rows**(register 시 워커별 분할) |

unique 거부 제거 외 게이트 로직 무변경. "충분한 행" 게이트 없음.

## 7. 테스트 전략

- **엔진 단위(`dataset.rs`)**: unique `select_index` — `0,1,2,...` 순차 반환 후 `len`째부터 `None`(wrap 아님). 공유 카운터로 두 VU가 같은 행 안 받음.
- **엔진 통합/runner**: unique + 작은 데이터셋으로 VU가 소진 후 종료(`Ok`)·전체 반복수 ≤ rows.
- **컨트롤러 단위**: `assignment_for`가 unique에서 `shard_split` 기반 disjoint (offset,count) 산출; `validate_run_config`가 unique 수용 + cap 적용(초과 시 거부).
- **컨트롤러 e2e(`e2e_test.rs`)**: 2-워커 unique fan-out — 두 워커가 disjoint 슬라이스 수신, 전 워커 행 합 = 전체·중복 0, run `Completed`. 기존 N=2 e2e 패턴(`two_worker_fanout_completes`) 차용.
- **UI RTL(`DataBindingPanel`)**: unique 선택 가능, 바인딩 round-trip(`policy: "unique"`), 배너 노출.

## 8. 슬라이스 분할

단일 슬라이스(9d/A3b보다 작음). 엔진→proto→컨트롤러→워커→UI가 한 와이어 변경(enum 1값)으로 묶여 분할 이득 적음. subagent-driven 구현 시 task 순서는 plan에서: ① 엔진 `Option` + Unique(테스트 먼저) → ② proto enum → ③ 워커 매핑 → ④ 컨트롤러 게이트/해석/파티션/스트림 → ⑤ UI → ⑥ e2e → ⑦ 최종 whole-feature 리뷰.

## 9. 후속 연기 항목

- `on_exhaust: fail` opt-in 토글(§3.3, 로드맵 §B2'' degraded 토글 계열).
- `total_rows < N` UI soft 경고(이 슬라이스에서 빠지면 여기로).
- 재현 가능한 unique 시퀀스(per-VU 결정적 분할) — 현재 스케줄링 의존, 필요 시 별도.

## 10. ADR

ADR-0022("Data-driven 데이터셋")를 갱신해 unique 예약 해소를 기록(또는 별도 ADR — plan에서 결정). CLAUDE.md "알아둘 결정들" 한 줄 + 도메인 함정(engine/controller/ui) 갱신.

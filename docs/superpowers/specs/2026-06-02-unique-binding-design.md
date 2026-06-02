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
- `run_scenario`(line 58-61): 공유 카운터를 `IterSequential` 단독 → **`IterSequential | Unique`** 둘 다에 생성(현재 `match … { Some(IterSequential) => …, _ => None }`은 비-exhaustive `_`라 `IterSequential | Unique` arm 추가 가능).
- `run_vu`(line 240-247): 행 overlay 블록을 다음으로 교체:
  ```rust
  if let Some(ds) = &dataset {
      match ds.select_index(vu_id, iter_id, seq_counter.as_deref()) {
          Some(idx) => { for (k, v) in &ds.rows[idx] { iter_vars.insert(k.clone(), v.clone()); } }
          None => break, // unique 슬라이스 소진 → 이 VU 정상 종료
      }
  }
  ```
  `None`이면 `while` 탈출 → `Ok(())`(runner.rs:268). VU가 `Err`를 안 내므로 `failed` 카운터(runner.rs:114-117)·`AllVusFailed` 게이트(runner.rs:201)를 건드리지 않음 = 깨끗한 완료. 기존 `if !ds.rows.is_empty()` 가드는 제거 가능 — 게이트가 빈 데이터셋을 거부(per_vu/iter_*)하고 unique는 `rows >= N`(§4.3 2c)이라 `rows`는 항상 non-empty이므로 per_vu/iter_*의 `% 0` 패닉 경로는 도달 불가.

> **두 개의 `BindingPolicy` enum 주의**: 컨트롤러 `crate::binding::BindingPolicy`(binding.rs)는 **이미 4변형(`Unique` 포함)**, 엔진 `handicap_engine::BindingPolicy`(dataset.rs)는 **3변형**. 이 절(§4.1)은 **엔진** enum에만 `Unique`를 추가한다(`select_index`의 exhaustive `match self.policy`도 함께).

### 4.2 proto (`crates/proto/proto/coordinator.proto`)

- `DataBinding.Policy` enum에 `UNIQUE = 3;` 추가(주석 "reserved" 제거). enum 값 추가는 backward-compat 안전(controller/worker 동시 배포). `row_count` 주석("after policy-aware slicing")은 unique의 per-worker count에 그대로 맞음 — **메시지 구조 무변경**.

### 4.3 컨트롤러 — run-create 해석 + 검증 (`api/runs.rs`)

- `validate_run_config`(line 47-100):
  - `BindingPolicy::Unique` 거부 블록(line 64-68) **제거**.
  - unique를 `per_iteration` cap 검사(line 89-92)에 포함 — unique는 전체 데이터셋을 워커들에 나눠 스트리밍하므로 총 DB 읽기 = 전체 행 → `--dataset-max-rows` 상한 적용.
  - **N-floor 검사 추가(HOLE 2 / 2c)**: unique면 `let n = state.coord.worker_count_for(profile.vus)`(create와 동일 함수, AppState로 접근 가능) 를 구해 `meta.row_count < n` 이면 **거부**("unique 정책은 데이터셋 행 수가 워커 수 이상이어야 합니다: rows={r} < workers={n}"). `shard_split(total, n, i)`는 `total >= n`이면 모든 샤드 `count_i >= 1`(base=total/n≥1)을 보장 → **빈 슬라이스 워커가 존재하지 않음** → 워커는 항상 non-empty `DataSet`을 받아 소진 시 `select_index→None→break`로 깨끗이 종료(언바운드 부하 경로 제거). 기본 capacity=2000이라 vus≤2000이면 N=1, `rows < 1`은 이미 빈 데이터셋 거부와 동치 → 단일워커 경로엔 새 거부 없음.
  - **u32 overflow 가드(HOLE 3)**: unique면 `meta.row_count > u32::MAX` 일 때 거부(`shard_split`이 u32라 truncate 방지). `--dataset-max-rows`는 u64 무한이라 cap만으론 못 막음. 실무상 cap 기본값(1M)이 한참 아래이나 방어적으로 명시.
  - `rows > 0` 검사·"충분한 행" 게이트 부재는 기존 그대로(stop-VU라 반복수 미지).
- `create`(line 129-143): `BindingPolicy::Unique => unreachable!(...)` arm을 실제 arm으로 — `(Policy::Unique, meta.row_count as u64)`. unique는 **총행**을 `PendingDataBinding.row_count`에 저장. 이 값은 **`assignment_for`만 읽어** 워커별로 분할한다(§4.4) — proto/stream/guard로는 절대 그대로 흐르지 않음.

### 4.4 컨트롤러 — 워커별 disjoint 파티션 (`grpc/coordinator.rs`)

핵심: per_vu/iter_*는 `row_count`가 **모든 워커에 동일(복제)** 이지만, unique는 워커마다 다른 `(offset_i, count_i)` 다. `PendingDataBinding.row_count`의 의미가 정책별로 다름(replicated 정책=per-worker count / unique=총행) — **오직 `assignment_for`만 이 필드를 해석**하고, 항상 per-worker count를 downstream에 내보낸다.

- **반환 타입 결정(HOLE 4)**: `assignment_for`(line 252)는 `(RunAssignment, Option<PendingDataBinding>)` → **`(RunAssignment, Option<WorkerStream>)`** 로 변경. 신규 경량 struct:
  ```rust
  struct WorkerStream { dataset_id: String, mappings: Vec<Mapping>, offset: u64, count: u64 }
  ```
  - unique: `(offset, count) = shard_split(total_rows as u32, shard_count, shard_index)` (각 u64로). 
  - 비-unique: `(0, binding.row_count)`.
  - 빌드하는 proto `DataBinding.row_count = count` (즉 unique는 `count_i`, HOLE 1 해소).
- `stream_dataset`(line 672): 시그니처를 `(state, tx, run_id, ws: &WorkerStream)` 로. `get_rows_range(db, ws.dataset_id, ws.offset + sent, limit)`, `total = ws.count`, mappings = `ws.mappings`. 비-unique는 `ws.offset = 0` = 기존과 byte-identical(현재 루프의 `sent`는 절대 인덱스 → `offset + sent`가 정확).
- 호출부(line 634-638): 가드를 `if let Some(ws) = &stream { if ws.count > 0 { stream_dataset(&state, &tx, &reg.run_id, ws).await; } }` 로. (§4.3 2c로 unique `count`는 항상 ≥1, replicated 정책도 항상 ≥1 — 가드는 방어적으로 유지.)
- `RunAssignment`/proto `DataBinding` 리터럴 사이트는 필드 추가가 아니므로 prost-exhaustive 트랩 비해당(값만 변경).

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

- **`total_rows < N`**: **run-create에서 거부**(§4.3 2c). 모든 워커에 최소 1행을 줄 수 없는 구성 = 일부 워커가 부하 0 생성 = 미구성으로 간주. 명확한 메시지로 거부(데이터 추가 또는 VU 감소 유도). 이로써 "빈 슬라이스 → `dataset=None` → 언바운드 full-duration 부하"라는 함정(spec-review HOLE 2)이 구조적으로 제거됨.
- **`N <= total_rows < total_vus`**: **허용**. 일부 VU는 1회도 못 돌고 종료할 수 있으나, **`DataSet`이 존재**(count_i≥1)하므로 그 VU의 `select_index`는 `None`을 반환 → 깨끗이 break(언바운드 부하 아님). 정상적인 unique use case(예: rows=50, vus=100 → 50회 소비 후 전원 정지).
- **결정성**: 소비되는 *행의 집합*은 고정(전체, 각 1회)이나, *어느 VU/반복이 어느 행을 받는지*는 공유 커서 + 스케줄링 의존(iter_sequential과 동일 성질). 재현 가능한 시퀀스는 보장하지 않음 — 유일성만 보장.
- **N=1(단일 워커)**: 슬라이스 = 전체 행, 정상 동작(`shard_split(total,1,0)=(0,total)`). unique는 멀티워커 전용이 아님. 단일워커에서 N-floor 거부는 `rows<1`=빈 데이터셋과 동치라 새 제약 없음.
- **`seed`**: unique에서 미사용. proto/PendingDataBinding 필드는 유지(다른 정책 공유).
- **하위 호환**: unique 미선택 = byte-identical(비-unique 경로 `WorkerStream.offset=0` 무변경, 엔진 `Option` 변경은 Some 경로 동일 동작, proto enum 값 추가는 기존 메시지 무영향).

## 6. 검증 게이트 요약 (`validate_run_config`)

| 정책 | rows>0 | cap(`--dataset-max-rows`) | 추가 게이트 | `PendingDataBinding.row_count` 의미 |
|---|---|---|---|---|
| per_vu | ✓ | 미적용(min(vus,rows) 슬라이싱) | — | min(vus, rows) |
| iter_sequential / iter_random | ✓ | 적용(전체 복제) | — | rows |
| **unique** | ✓ | **적용**(전체를 분할 스트리밍) | **`rows >= N` & `rows <= u32::MAX`** | **총 rows**(`assignment_for`만 읽어 워커별 분할) |

unique 거부 제거 + N-floor·u32 가드 추가가 게이트 변경 전부. "충분한 행(rows≥vus)" 게이트는 없음(rows<vus는 허용).

## 7. 테스트 전략

- **엔진 단위(`dataset.rs`)**: unique `select_index` — `0,1,2,...` 순차 `Some` 반환 후 `len`째부터 `None`(wrap 아님). 공유 카운터로 두 VU가 같은 행 안 받음. **기존 3개 단위테스트(`dataset.rs:94-129`)가 `== usize`를 단언하므로 `Some(_)`로 갱신**(시그니처 `Option<usize>` 변경의 직접 영향). `proptests.rs`는 `select_index`/`DataSet` 미접촉 → 무영향.
- **엔진 통합/runner**: unique + 작은 데이터셋으로 VU가 소진 후 종료(`Ok`)·전체 반복수 ≤ rows·`failed` 미증가.
- **컨트롤러 단위**: `assignment_for`가 unique에서 `shard_split` 기반 disjoint `(offset,count)` 산출(2-워커 → `(0,k)`,`(k,total-k)`); `validate_run_config`가 unique 수용 + cap 적용 + **N-floor 거부**(`rows<N`) + **u32 거부**.
- **컨트롤러 e2e(`e2e_test.rs`)**: 2-워커 unique fan-out. **관측 메커니즘(HOLE 5)**: 시나리오가 unique `{{var}}`(예: 데이터셋의 고유 토큰 컬럼)를 wiremock이 캡처하는 요청 경로/헤더/바디에 주입(기존 `data_binding_per_vu_injects_distinct_values`, e2e_test.rs:956 패턴 차용). 단언: 두 워커가 보낸 요청에서 관측된 주입값들의 **합집합 = 데이터셋 부분집합, 어떤 값도 2회 이상 등장 안 함(유일성)**, run `Completed`. fixture ULID는 Crockford base32 유효(엔진 CLAUDE.md 함정: `I/L/O/U` 회피). N=2 e2e 패턴은 `multi_worker_fanout_e2e.rs:83 two_worker_fanout_completes` 차용.
- **UI RTL(`DataBindingPanel`)**: unique 선택 가능, 바인딩 round-trip(`policy: "unique"`), 배너 노출(`showBanner`에 unique 포함).
- **게이트(CLAUDE.md 함정)**: 엔진 `BindingPolicy` 변경 후 **`cargo build -p handicap-worker` 필수**(`cargo run -p handicap-controller`는 worker 바이너리 재빌드 안 함 — 옛 워커가 새 enum 못 읽음). UI 변경 후 **`pnpm build`(`tsc -b`)** 까지(Zod enum·드롭다운 타입). pre-commit hook은 cargo만 돌림.

## 8. 슬라이스 분할

단일 슬라이스. 새 proto 필드·migration·메트릭 테이블 없음, `select_index` 단일 호출 사이트, `PendingDataBinding` 단일 리터럴이라 분할하지 않는다. 단 spec-review가 지적했듯 "행 파티션"은 `shard_split` 단순 재사용이 아니라 ① `row_count` 의미 정정(WorkerStream 도입) ② N-floor/u32 게이트 ③ u32 캐스팅이 얽혀 spec이 처음 가정한 것보단 살집이 있다. subagent-driven 구현 시 task 순서(plan에서 확정): ① 엔진 `select_index → Option` + `Unique` 변형(기존 단위테스트 갱신 포함, 테스트 먼저) → ② proto `UNIQUE=3` → ③ 워커 policy 매핑 arm → ④ 컨트롤러: validate 게이트(거부 제거 + N-floor + u32) + create 해석 + `WorkerStream` 파티션(`assignment_for`/`stream_dataset`/호출부) → ⑤ UI(Zod enum + 드롭다운 + 배너) → ⑥ e2e(2-워커 유일성 관측) → ⑦ 최종 whole-feature 리뷰(`handicap-reviewer`, 와이어 1:1). 각 Rust task 후 `cargo build -p handicap-worker`, UI task 후 `pnpm build`.

## 9. 후속 연기 항목

- `on_exhaust: fail` opt-in 토글(§3.3, 로드맵 §B2'' degraded 토글 계열).
- 재현 가능한 unique 시퀀스(per-VU 결정적 분할) — 현재 스케줄링 의존, 필요 시 별도.
- UI에서 N(=ceil(vus/capacity))·N-floor를 사전 표시(현재는 run-create 거부 메시지로만 안내). capacity가 UI에 노출 안 돼 있어 추정 불가 → 운영 상한 관리자 화면(로드맵 §B2'')과 묶음.

## 10. ADR

ADR-0022("Data-driven 데이터셋")를 갱신해 unique 예약 해소를 기록(또는 별도 ADR — plan에서 결정). CLAUDE.md "알아둘 결정들" 한 줄 + 도메인 함정(engine/controller/ui) 갱신.

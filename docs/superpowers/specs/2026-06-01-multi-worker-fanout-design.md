# A3 — 멀티 워커 fan-out (계획된 분산 실행) 설계

> 출처: 로드맵 §A3 "멀티 워커 + 자동 스케일(HPA)". spec §4.5 "다중 워커 자동 스케일링 (워커는 1대 고정)".
> 선행 결정: ADR-0010(gRPC pull/register), ADR-0016(VU=tokio task), ADR-0012(워커측 메트릭 집계), ADR-0019(워커 dispatcher 추상화).
> 이 문서는 spec-plan-review(2026-06-01) 1차 반영본이다 — 1차 설계의 과소 스코프(조정 자료구조 재작성 규모, 단일 spec→3 슬라이스)를 교정했다.

## 1. 개요 · 목표

한 run 을 **N 개의 워커**에 결정론적으로 분산 실행한다. 부하 생성기에서 "자동 스케일"은 반응형 HPA 가 아니라 **계획된 fan-out** — run 시작 시 요청 VU 수에 맞춰 워커 수 N 을 정하고, 그 run 동안 N 을 고정한다. 워커가 run 중간에 합류/이탈하지 않으므로 측정이 흔들리지 않는다(부하 테스트는 "정해진 VU 를 안정적으로 생성"이 목적).

§4.3 성능 목표(5,000 RPS)는 단일 워커로 이미 ~20,000 RPS(Slice 6 baseline)라, 이 슬라이스는 **처리량이 아니라 분산 실행/조정**이다.

### 1.1 In scope

- 컨트롤러가 run 을 N 워커로 fan-out: 워커 수 산정, VU 구간 분배, shard 할당.
- 컨트롤러 조정 자료구조를 **per-run 멀티워커 상태머신**으로 재작성(§2).
- 엔진 **글로벌 vu_id**(샤드 간 통일된 VU 번호) — `${vu_id}`·`per_vu`·`iter_random` 재현성(§3).
- proto `RunAssignment` 에 shard 필드(§4).
- 메트릭 머지: 워커별 행 + 읽기 시점 머지(§5).
- 데이터 바인딩을 fan-out 에서 정합(기존 3 정책, §6).
- 디스패치: subprocess N-spawn(로컬), K8s **Indexed Job**(prod) (§7).
- 상태/abort 집계 + 등록 deadline watchdog(§8).

### 1.2 Out of scope (명시적 연기 — §11)

- **반응형 HPA** (CPU/메트릭 기반 run 중 스케일). 부하 생성기엔 부자연(VU 수가 흔들리면 측정이 흔들림).
- **best-effort/degraded 모드 + per-run 토글** (워커 일부 실패해도 run 지속). 이번엔 **fail-fast** 만.
- **`unique` 바인딩 정책** (중앙 커서). 본 문서 §6.4 에 설계 스텁만, 구현은 후속.
- **운영 상한 관리자 화면** (worker capacity·loop_breakdown_cap 등 op-config 모음 UI).
- **멀티워커 run 의 컨트롤러 재시작 부분 복구** — §8.4 에 "통째 failed"로 결정(현 동작 유지).

## 2. 조정 모델 — 컨트롤러가 권위자

### 2.1 워커 수 N 산정 (capacity 유도)

run-create 시 컨트롤러가 계산:

```
N = ceil(total_vus / worker_capacity_vus)
```

- `worker_capacity_vus` = 컨트롤러 기동 플래그 `--worker-capacity-vus`(기본 2000) / Helm value. **워커 register 의 `capacity_vus`(coordinator.proto:25)가 아니다** — N 은 워커가 등록하기 *전*(dispatch 시점)에 정해져야 하므로 컨트롤러 설정에서 온다. `Register.capacity_vus` 는 정보/검증용으로 남긴다.
- `N == 1` 이면(즉 `total_vus <= capacity`) 전 경로가 현재 단일워커와 **byte-identical**(§3.3 의 vu_offset=0·vu_count=total_vus, §5 의 worker_id sentinel).
- `worker_count` 는 run-create 시 계산해 N 개 dispatch 에만 쓴다 — **`runs` 테이블에 저장하지 않는다**(profile/env 와 달리 재현에 불필요; CoordinatorState 메모리에만). 구현자는 runs 에 worker_count 컬럼을 추가하지 말 것.

### 2.2 현재 자료구조의 부적합 (재작성 근거)

현재(`crates/controller/src/grpc/coordinator.rs`):

- `pending: HashMap<run_id, PendingAssignment>` — run 당 단일 assignment. Register 시 `remove`(:137) 로 꺼냄 → **두 번째 워커는 `None` → `error!("no pending assignment") + break`(:244)**.
- `active: HashMap<run_id, WorkerTx>` — run 당 tx **하나**. 두 번째 register 의 `insert`(:132) 가 첫 tx 를 **덮어씀**. `abort()`(:82) 는 단일 tx 만 꺼냄. stream close 시 `active.remove(rid)`(:349) 가 한 워커만 끊겨도 run 전체 tx 제거.

→ "필드 추가" 수준이 아니라 **Register/Metric/RunStatus arm + abort + 종료 처리 전체를 per-run 멀티워커 상태로 재작성**한다.

### 2.3 새 per-run 상태머신

`CoordinatorState` 의 `pending` + `active` 를 **하나의 per-run 맵**으로 대체:

```rust
struct RunWorkers {
    base: PendingAssignment,      // scenario_yaml/profile/env/data_binding (워커 공통)
    expected: u32,                // N
    total_vus: u32,
    next_shard: u32,              // 다음 배정할 shard index (0..N)
    workers: HashMap<String /*worker_id*/, WorkerEntry>,
    reg_deadline: CancellationToken,  // 전원 등록 시 cancel → watchdog 종료
    terminal: bool,               // 이미 Completed/Failed/Aborted 로 마감했는지(멱등)
}
struct WorkerEntry {
    shard_index: u32,
    vu_offset: u32,
    vu_count: u32,
    tx: WorkerTx,
    phase: Phase,                 // Started/Completed/Failed/Aborted
}
// CoordinatorState { db, runs: Arc<Mutex<HashMap<run_id, RunWorkers>>> }
```

**enqueue**(run-create): `RunWorkers { base, expected: N, total_vus, next_shard: 0, workers: {}, reg_deadline: token, terminal: false }` 삽입 + watchdog spawn(§8.3).

**Register arm**:
1. `runs[run_id]` 조회(없으면 기존처럼 error+break).
2. `terminal` 이면 무시(이미 마감된 run 에 늦게 붙은 워커 → abort 회신).
3. `workers[worker_id]` 가 **이미 있으면 그 shard 를 그대로 재전송**(멱등 — 초기 연결 backoff 중 같은 worker_id 재등록 시 shard 슬롯 재소비 방지. mid-run 재접속은 없음, §clarify C6).
4. 없으면: `next_shard >= expected` 면 over-registration(로그+abort 회신, shard 안 줌). 아니면 `shard = next_shard; next_shard += 1`, §3.2 로 `(vu_offset, vu_count)` 계산, `WorkerEntry` 삽입(tx clone).
5. `RunAssignment`(shard_index/shard_count=N/vu_offset/vu_count 포함) 전송 → 데이터셋 행 스트리밍(§6.2) → 첫 워커 등록 시 run `Running`(현 :158 위치, 단 한 번).
6. `workers.len() == expected` 면 `reg_deadline.cancel()`(watchdog 해제).

**MetricBatch arm**: `batch.worker_id` 를 `MetricRow.worker_id` 로 전달(§5). loop/if 행은 무변경(§5.3).

**RunStatus arm**: `workers[worker_id].phase` 갱신 후 §8 집계.

**stream close**: 해당 워커만 제거하고, terminal phase 없이 끊겼으면 fail-fast(§8.2). run 전체 tx 를 지우지 않는다.

## 3. VU 분배 & 글로벌 vu_id

### 3.1 글로벌 vu_id (단일 개념, "두 종류" 아님)

엔진은 VU 를 **글로벌 id** 로 번호 매긴다: `vu_id = vu_offset + local_spawn_index`. 현재 `runner.rs` 의 `vu_id`(워커-로컬 0-based)를 글로벌로 통일한다.

- `aggregator` 는 `step_id`(+loop_index/branch)로 키잉하지 **`vu_id` 로 키잉하지 않으므로** 글로벌화해도 메트릭 키 충돌 없음.
- `${vu_id}` 시스템 변수가 글로벌(0..total_vus)이 되는 건 분산 run 에서 오히려 정확(전 run 에서 VU 정체성 유일).
- `DataSet::select_index(vu_id, ...)`(dataset.rs:35)에 **글로벌 vu_id** 가 들어가 `per_vu`/`iter_random` 가 단일워커와 동일 결과.
- **구현 검증 task**: 엔진이 `vu_id` 를 *vus 크기 구조의 인덱스*로 쓰는 곳이 없는지 확인(현재 vu_id 는 identity-only: `select_index` + `${vu_id}` 렌더). 있으면 글로벌화가 out-of-bounds → 그 지점만 로컬 index 로 분리.

### 3.2 VU 구간 분배 (나머지는 앞 shard 로)

총 `V` VU 를 `N` shard 로:
```
base = V / N,  rem = V % N
shard i:  vu_count_i = base + (i < rem ? 1 : 0)
          vu_offset_i = i*base + min(i, rem)
```
합 = V, 구간 disjoint·연속. shard 0..rem-1 이 1 개씩 더 받음.

### 3.3 엔진 RunPlan

`RunPlan`(현 `{ vus, ramp_up, duration, env, loop_breakdown_cap, data_binding }`)에 **`vu_offset: u32`** 추가(기본 0). `vus` 의 의미는 **샤드 slice 수**(워커가 도는 VU 개수)로 바뀐다.

- 워커 `main.rs:169` 는 `plan.vus = profile.vus` 를 **`= assignment.vu_count`**, `plan.vu_offset = assignment.vu_offset` 으로 바꾼다. `Profile.vus`(총 VU)는 참조로만 남음.
- `vu_offset=0 && vu_count==total_vus`(N=1)이면 현재와 동일 = 하위 호환.

### 3.4 ramp-up

각 워커가 자기 `vu_count` 를 **동일 `ramp_up_seconds`** 에 걸쳐 spawn → 전체 spawn rate = `total_vus / ramp` 보존(엔진 ramp 로직 무변경, vus=slice 만 다름).

## 4. proto 변경 (`crates/proto/proto/coordinator.proto`)

```proto
message RunAssignment {
  string run_id = 1;
  string scenario_yaml = 2;
  Profile profile = 3;            // Profile.vus = 총 VU (참조)
  map<string, string> env = 4;
  DataBinding data_binding = 5;
  uint32 shard_index = 6;         // 0..shard_count-1
  uint32 shard_count = 7;         // = N
  uint32 vu_offset = 8;           // 이 워커의 글로벌 VU 시작
  uint32 vu_count = 9;            // 이 워커가 도는 VU 수 (= RunPlan.vus)
}
```

- `MetricBatch.worker_id`(:47) 이미 존재 → §5 머지 키. (현재 컨트롤러는 이 필드를 무시 — A3b 에서 사용.)
- **prost exhaustive 함정**(controller CLAUDE.md): `RunAssignment` 에 4 필드 추가 시 `..Default::default()` 안 됨 → `RunAssignment {..}` literal 을 **crate-wide grep** 으로 전부 갱신(`coordinator.rs:140`, 워커-core/엔진/테스트 fixture 포함). `Profile` 에는 새 필드 없음.

## 5. 메트릭 머지 (A3b)

워커 N 개가 같은 `(run_id, ts_second, step_id)` 윈도우를 각자 낸다. 현재 `run_metrics` insert 는 `ON CONFLICT(run_id,ts_second,step_id) DO NOTHING`(metrics.rs:34, keep-first) — **첫 워커 것만 남고 나머지가 조용히 버려진다.** HDR 히스토그램은 SQL 에서 못 합치므로(역직렬화→merge→재직렬화) **워커별 행 + 읽기 시점 머지**(1안)로 푼다.

### 5.1 마이그레이션 0008 (PK 에 worker_id 추가 — 새 테이블+복사, Rust-guarded)

`run_metrics` PK 를 `(run_id, ts_second, step_id, worker_id)` 로 바꾼다. SQLite 는 **기존 테이블 PK 변경에 ALTER 를 못 쓰고**, `run_metrics` 는 `CREATE TABLE IF NOT EXISTS`(0001)라 0008 에서 다시 CREATE 해도 no-op. 또 migration 은 매 `connect()` 마다 무조건 실행(버전 테이블 없음)이라 **멱등**이어야 한다.

→ **`store/mod.rs::connect()` 안에서 Rust 가드**(기존 `message` 컬럼 가드 :48-54 패턴 그대로):

```
if pragma_table_info('run_metrics') 에 'worker_id' 가 없으면:
   CREATE TABLE run_metrics_v2( ... , worker_id TEXT NOT NULL DEFAULT '', ...,
       PRIMARY KEY(run_id, ts_second, step_id, worker_id),
       FOREIGN KEY(run_id) REFERENCES runs(id));
   INSERT INTO run_metrics_v2 SELECT ..., '' AS worker_id, ... FROM run_metrics;  -- 기존 행 sentinel
   DROP TABLE run_metrics;
   ALTER TABLE run_metrics_v2 RENAME TO run_metrics;
```

가드(worker_id 컬럼 존재 여부)가 있으므로 두 번째 startup 에선 통째 skip → 멱등·기존 데이터 보존(sentinel `''`). 이건 **pure-SQL `MIGRATION_SQL_0008` 상수가 아니라 `connect()` 내 Rust 조건부 블록**(기존 `message` 컬럼 가드와 동형)이라 "const N == execute N" 교차검증 대상이 아니다 — 대신 **이 가드 블록이 `connect()` 의 마이그레이션 순서(0007 뒤)에 실제로 호출되는지**를 task 에서 확인. (만약 구현 중 다른 브랜치가 `MIGRATION_SQL_0008` 상수를 같은 번호로 추가하면 리넘버 — 그땐 controller CLAUDE.md 의 "execute 라인 silently auto-merge" 함정 적용.)

### 5.2 읽기 3 사이트 머지

- **`insert_batch`**: INSERT 에 `worker_id` 추가, `ON CONFLICT(run_id,ts_second,step_id,worker_id) DO NOTHING`(워커별 keep-first — at-least-once 재전송 멱등 유지).
- **`summary`**(live `/metrics`): `(ts_second, step_id)` 로 GROUP BY, `count`/`error_count` SUM. `status_counts`(행별 JSON map)는 SQL 로 못 합치므로 행을 모아 **Rust 에서 map 병합**.
- **`windows_with_hdr` → `build_report`**: `windows_with_hdr` 는 `(ts_second, step_id, worker_id)` 행을 반환(정렬 `ts, step, worker`). **`build_report`(report.rs)가 `(ts_second, step_id)` 로 그룹핑하며 워커 HDR 를 `add` 로 병합 + count SUM**. 이건 build_report 가 이미 하는 "per-second 윈도 → step 합산" HDR merge 의 자연 확장(머지 지점 = report.rs 의 윈도 누적 루프).
  - **HDR bound 일치**(engine CLAUDE.md): `Histogram::add` 는 lo/hi/sigfig 동일할 때만 무손실. 워커들이 같은 `fresh_hist` bound(LO=1/HI=60_000_000/SIGFIG=3)로 직렬화하므로 현재 invariant 상 무손실 — spec 에 명시, 테스트로 고정.

### 5.3 loop/if 메트릭은 무변경 (그리고 왜 안전한가)

`run_loop_metrics`/`run_if_metrics` 는 이미 `count = count + excluded.count` 누적(metrics.rs:145,199). **멀티워커에서 누적이 정합**한 이유: 워커별로 **disjoint delta**(자기 VU 가 돈 loop_index/branch 결정 수)를 보내므로 합산이 정확. over-count 우려(재전송 중복 누적)는 **mid-run 재전송이 없으므로**(§connect 1회성, 워커 stream 끊기면 재개 안 함 → fail-fast) 발생하지 않는다. 따라서 worker_id 를 PK 에 넣을 필요 없음 — run_metrics(keep-first→워커별 행)와 **정반대 전략이지만 둘 다 옳다**: run_metrics 윈도는 "완전 스냅샷"이라 워커별 분리가 필요하고, loop/if 는 "증분 델타"라 합산이 맞다. (spec 에 이 비대칭 근거 기록.)

## 6. 데이터 바인딩 under fan-out (기존 3 정책 정합)

각 워커는 데이터셋을 **복제 수신**한다(컨트롤러가 register 시 각 워커에 동일 행 집합 스트리밍). 글로벌 vu_id(§3) 덕에 단일워커와 동일 결과.

### 6.1 정책별 row_count (모든 워커에 동일하게 스트리밍)

`V`=총VU, `R`=데이터셋 행수.

- **`per_vu`**: 워커는 `글로벌 vu_id % min(V,R)` 로 인덱싱 → 단일워커와 동일하려면 모든 워커가 **같은 `min(V,R)` prefix** 를 받아야 함. `row_count = min(V, R)`(현 `runs.rs:131` 의 `min(vus,rows)` 를 V=총VU 로 일반화). 워커 i 는 `vu_count_i` 개만 실제 사용하나 prefix 전체를 보유(낭비는 V 로 유계, 데이터셋 cap 으로 제한).
- **`iter_sequential`**: 워커-로컬 `AtomicU64` 유지(글로벌 순차 아님 — **문서화**). 전체 `R` 행 필요. `row_count = R`.
- **`iter_random`**: `(seed, 글로벌 vu_id, iter_id)` 시드 → 전체 `R` 필요·재현 가능. `row_count = R`.

→ row_count 가 **모든 워커에 동일**(복제)이라 register 시 스트리밍 루프(coordinator.rs:168-242)는 워커마다 1 회 반복하면 됨. 리뷰 F3(워커마다 row_count 다른지) 해소: 동일.

### 6.2 스트리밍

register handler 의 데이터셋 스트리밍을 **per-워커**로(현재 단일 워커 가정). 컨트롤러가 워커별로 `binding.row_count` 행을 fetch+mappings_apply+스트리밍. 행 값은 절대 로깅 안 함(spec §11 유지).

### 6.3 검증 게이트

`validate_run_config`(runs.rs:47)의 per_vu row_count 슬라이싱을 `min(total_vus, rows)` 로(이미 vus 기반이므로 vus=총VU 의미 유지 — N 분할은 워커 내부 vu_count 이지 게이트는 총VU 로 판단). iter_* 의 `--dataset-max-rows` 상한 무변경.

### 6.4 `unique` (설계 스텁만 — 후속)

`unique` = 행을 워커/반복 간 중복 없이 전역 소진. **컨트롤러 중앙 커서**로 워커별 disjoint 슬라이스를 스트리밍하면 풀린다(per_vu 복제와 달리 워커 i 에 `rows[offset_i..offset_i+count_i)` 만, 워커-로컬 인덱싱). 이번 슬라이스는 **여전히 거부**(`validate_run_config` 의 `BindingPolicy::Unique` reject 유지). 멀티워커 인프라(이 spec)가 깔린 뒤 후속 하위 슬라이스에서 중앙 커서로 구현. ADR-0022 의 "unique 예약" 과 정합.

## 7. 디스패치 & K8s 형상

### 7.1 trait 시그니처

`WorkerDispatcher::dispatch(run_id, worker_id)` → **`dispatch(run_id, worker_count)`**(dispatcher/mod.rs). 호출부 `api/runs.rs:175-176` 는 단일 `ulid::Ulid::new()` worker_id 생성을 제거하고 `worker_count`(=N) 만 넘긴다. worker_id 생성 책임은 디스패처 내부로:

- **subprocess**(로컬/e2e): 디스패처가 `worker_count` 개 ULID 를 생성해 **N 개 자식 spawn**(각 distinct `--worker-id`). 각 자식 reaping 은 현 패턴(:53) 그대로 N 회.
- **K8s**(prod): **1 개 Indexed Job**(parallelism=completions=N) 생성. Pod 가 `JOB_COMPLETION_INDEX` env 로 자기 id 파생.

비대칭(subprocess=N 프로세스 / K8s=1 Job N Pod)은 **ADR-0019 디스패처 추상화의 의도된 모습** — trait 는 "run 을 N 워커로 시작"만 약속, 실현은 구현체별.

### 7.2 K8s Indexed Job (`k8s_spec.rs`)

`build_job_spec` 에 `worker_count: u32` 입력 추가:
- `JobSpec.parallelism = Some(N)`, `completions = Some(N)`, `completion_mode = Some("Indexed")`. (k8s-openapi 0.23 `v1_30` JobSpec 에 세 필드 모두 존재 — 확인됨.)
- **worker 가 `JOB_COMPLETION_INDEX` 를 읽도록**: 컨테이너 args 의 `--worker-id <ulid>`(현 :65) 를 제거하고, 워커 `Args.worker_id` 를 **optional** 로. 없으면 `JOB_COMPLETION_INDEX` env 읽어 `worker_id = "{run_id}-w{index}"`. (subprocess 는 `--worker-id` 명시 전달 유지 → 양쪽 다 동작.)
- `cleanup`(kubernetes.rs:66)은 `handicap.io/run-id={}` 라벨 셀렉터로 list+delete — **무변경**(Indexed Job 1 개라 라벨 동일, ownerRef GC 로 N Pod 일괄 삭제).
- `backoff_limit=0`/`restart_policy=Never`(현 :111,119) 유지 — 크래시 Pod 재시작 안 함(fail-fast 와 정합, mid-run 재접속 불필요).

### 7.3 부하 충실도 Helm values

Job 형상은 throughput 에 무관 — 충실도 레버는 **Pod 템플릿**(Helm values 노출):
- 워커 `resources.requests == limits`(CPU) → CFS 스로틀 방지(스로틀되면 타겟이 아니라 생성기를 측정).
- `topologySpreadConstraints` / pod anti-affinity → 워커를 노드 분산(코어·NIC·egress 분리, 실제 분산 소스에 근접, 자기경합 방지).
- 워커를 컨트롤러와 분리 스케줄.

(현 `WorkerResources`(k8s_spec.rs:24)는 requests≠limits 기본. 충실도 권장값을 values 기본 + 문서화.)

## 8. 상태 / abort 집계

### 8.1 완료 (전원 Completed)

`RunStatus(Completed)` 수신마다 `workers[worker_id].phase=Completed`. **모든 `expected` 워커가 Completed** 면 run `Completed` + dispatcher `cleanup` + `terminal=true`. (`terminal` 가드로 멱등.)

### 8.2 실패 (fail-fast)

다음 중 하나면 run `Failed` + **나머지 워커에 AbortRun fan-out**(§8.5) + `cleanup` + `terminal=true`:
- 어떤 워커가 `RunStatus(Failed)`.
- 어떤 워커 stream 이 terminal phase 없이 close(영구 단절 — mid-run 재접속 없음).
- 등록 deadline 만료 시 `workers.len() < expected`(§8.3).

근거: 샤드 하나가 빠지면 요청한 부하를 안 돌린 것 → 부분 리포트는 오해의 소지. 명시적 실패가 안전(best-effort 는 §11 연기).

### 8.3 등록 deadline watchdog

enqueue 시 per-run tokio task spawn: `registration_deadline`(기본 60s, 워커 backoff `TOTAL_CAP` 과 정렬) sleep 후 `runs[run_id]` 확인 → `terminal==false && workers.len() < expected` 면 §8.2 fail-fast. **전원 등록 시 `reg_deadline.cancel()`**(§2.3 Register 6)로 watchdog 조기 종료. 소유자 = enqueue(run-create 경로).

### 8.4 컨트롤러 재시작 (결정: 통째 failed)

`mark_orphans_failed`(main.rs:79 / runs.rs:226)는 **무변경** — 재시작 시 `running` 인 멀티워커 run 도 통째 `failed`. 부분 완료 복구는 안 함(현 동작·fail-fast 철학과 일치). 부분 진행 상태가 `runs.status` 단일 row 에만 있어 정밀 복구 불가하나, 재시작은 드물고 run 은 재실행 가능 → 의도된 단순화(§11).

### 8.5 abort fan-out

사용자 abort(`api/runs.rs::abort_run`) → `coord.abort(run_id)` 가 `runs[run_id].workers` 의 **모든 tx** 에 `AbortRun` 전송(현 단일 tx → 순회). `mark_aborted` 는 무변경(belt-and-suspenders, controller CLAUDE.md). 각 워커는 `Phase::Aborted` 보고.

## 9. 슬라이스 분할 (A3a / A3b / A3c)

9a–9d 컨디셔널 선례처럼 한 spec 을 3 하위 슬라이스로. **A3a → A3b 는 한 세트로 출하**(A3a 단독은 멀티워커 메트릭이 keep-first 라 손실 — A3a 는 단일워커 무변경 보장만으로 리뷰·머지 가능하나, 사용자에게 N>1 을 노출하려면 A3b 필요). A3c 는 독립(로컬 subprocess 는 A3a+A3b 로 이미 멀티워커, K8s 형상은 가산).

### A3a — 컨트롤러 조정 + proto + 엔진 글로벌 vu_id
- 엔진 `RunPlan.vu_offset` + 글로벌 vu_id(§3) + 검증 task(vu_id identity-only).
- proto `RunAssignment` shard 4 필드(§4) + prost grep.
- `CoordinatorState` per-run 상태머신(§2.3): `pending`+`active` → `runs` 맵, Register/RunStatus arm 재작성, shard 할당, watchdog(§8.3), 상태 집계(§8.1-8.2), abort fan-out(§8.5).
- 워커: `RunAssignment.vu_count/vu_offset` → RunPlan(§3.3), `--worker-id` optional + `JOB_COMPLETION_INDEX` fallback(§7.2).
- 디스패처 trait `dispatch(run_id, worker_count)` + subprocess N-spawn(§7.1).
- run-create: N 산정(§2.1) + enqueue(expected=N).
- **e2e**: subprocess **N=2** fan-out → 코디네이션·전원완료·fail-fast·abort 검증(메트릭 정확성은 A3b, 단 loop/if 누적은 N=2 합산 검증 가능).

### A3b — 메트릭 머지
- 마이그레이션 0008(§5.1, Rust-guarded 새 테이블+복사).
- `MetricRow.worker_id` + `insert_batch`(§5.2) + MetricBatch arm 이 worker_id 전달.
- `summary`/`windows_with_hdr`/`build_report` 머지(§5.2) + HDR bound 테스트.
- **e2e**: N=2 fan-out → run_metrics 워커 합산(count SUM·HDR merge) 검증.

### A3c — K8s Indexed Job + Helm
- `build_job_spec`(parallelism/completions/Indexed, §7.2) + worker_count 입력 + 단위 테스트.
- Helm values: worker_count(또는 capacity)·resources requests==limits·topologySpread(§7.3).
- e2e-kind 확장(N>1 Job).

## 10. 테스트 전략

- **엔진**(A3a): `vu_offset` 글로벌 번호 단위테스트(per_vu/iter_random 가 글로벌 vu_id 로 단일워커와 동일 결과; vu_offset=0 회귀).
- **컨트롤러**(A3a): shard 분배(나머지 분포 `base+rem`), Register 멱등(같은 worker_id 재등록=같은 shard), 전원등록→Running, over-registration 거부, 상태 집계(전원 Completed→Completed; 1 Failed→Failed+나머지 abort), 등록 deadline watchdog(만료→fail-fast, 전원등록→cancel) 단위테스트.
- **컨트롤러**(A3b): 메트릭 머지(워커 HDR add·count SUM), 마이그레이션 멱등(두 번째 connect skip), keep-first per-worker.
- **e2e**: A3a `multi_worker_fanout_e2e`(subprocess N=2, `e2e_test.rs::worker_bin_path` 패턴), A3b 메트릭 합산 e2e.
- **K8s**(A3c): `build_job_spec` 단위(parallelism/completions/Indexed) + e2e-kind N>1.
- 게이트: cargo workspace(fmt/build/clippy/test) + UI 무변경(이 슬라이스는 UI 무손댐 — RunDialog 는 N 을 안 받음, capacity 는 컨트롤러 설정).

## 11. 명시적 연기 (out of scope) → 로드맵 §A·§B 기록

- **반응형 HPA** (run 중 CPU/메트릭 스케일) → 로드맵 §A 별 후보. 부하 생성기엔 부자연.
- **best-effort/degraded 모드 + per-run 토글**(`on_worker_failure: fail|continue`) → 로드맵 §B. profile 필드 이음새만 비워둠(`#[serde(default)]` 추가 시 무변경).
- **`unique` 바인딩**(중앙 커서) → §6.4 설계 스텁, 후속 하위 슬라이스(ADR-0022 unique 예약 해소).
- **운영 상한 관리자 화면**(worker capacity·loop_breakdown_cap 등 op-config UI) → 로드맵 §B.
- **컨트롤러 재시작 부분 복구** → §8.4 통째 failed 로 결정(복구 안 함).

## 12. 함정 노트 (도메인 CLAUDE.md 반영 예정)

- **controller**: ① 0008 은 PK 변경이라 ALTER 불가 → Rust-guarded 새 테이블+복사(§5.1); ② proto 4 필드 = prost exhaustive crate-wide grep(§4); ③ 마이그레이션 적용 라인 등록·`grep -c MIGRATION_SQL` 교차검증; ④ `active` 단일 tx → per-run tx 집합 재작성(§2.2).
- **engine**: 글로벌 vu_id 는 identity-only 라 메트릭 키 무영향이나, vus-크기 인덱싱 없는지 검증(§3.1); HDR merge bound 동일(§5.2).
- **worker-core**: connect 1회성·mid-run 재접속 없음 → 워커 단절 = fail-fast(§8.2).
- **테스트**: 하드코딩 worker_id fixture 는 ULID Crockford(I/L/O/U 금지) — 단 subprocess 는 `ulid::Ulid::new()` 라 자동 안전.

## 13. ADR

**ADR-0027 — 멀티 워커 fan-out (계획된 분산 실행)**: 반응형 HPA 거절·계획된 fan-out 채택, 컨트롤러 권위(capacity 유도 N·Register 시 shard 배정), per-run 상태머신, Indexed Job 형상, 메트릭 worker_id 머지(run_metrics 워커별 행 vs loop/if 누적 비대칭), fail-fast(best-effort/unique/HPA 연기). CLAUDE.md "알아둘 결정들" 한 줄 + 도메인 함정 인덱스 갱신. 로드맵 §A3 완료 표시.

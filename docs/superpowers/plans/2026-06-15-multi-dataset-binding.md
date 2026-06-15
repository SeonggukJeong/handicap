# 다중 데이터셋 바인딩 (multi-dataset binding) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 한 run에 N개의 독립 데이터셋 바인딩을 허용한다(현재는 단일 `Profile.data_binding`). 각 바인딩은 자기 데이터셋·정책·매핑으로 독립 전진하며 행 개수가 달라도 무관하다.

**Architecture:** 단일 `data_binding`(Option)을 `data_bindings`(Vec)로 일반화한다. proto는 `repeated DataBinding data_bindings=10` + `DatasetBatch.binding_index=3` 가산. 엔진은 바인딩별 커서 Vec를 들고 VU body에서 순회 주입(break-on-first-None). 컨트롤러는 바인딩별 슬라이스·스트림. 워커는 binding_index 버킷으로 N개 적재. UI는 바인딩 목록 편집기. **DB 마이그레이션·새 엔진 인덱싱 로직 0** (binding은 `profile_json` serde). 설계 전문: `docs/superpowers/specs/2026-06-15-multi-dataset-binding-design.md`.

**Tech Stack:** Rust(engine/controller/worker, tonic/prost, sqlx, hdrhistogram), TypeScript/React(Zod, React Query, vitest/RTL).

---

## 확정 결정 (spec 잔여 항목 핀)

- **`MAX_BINDINGS = 8`** — `validate_run_config`의 교차 검증 const. 초과 시 400.
- **`DatasetIncomplete { got, expected }` 다중 버킷 집계** — 스트림 조기 종료 시 `got`=전 버킷 수신 행 합, `expected`=전 버킷 약속 행 합(스칼라 에러라 합산; 메시지는 정보용).
- **per-stream AbortRun 처리** — `stream_dataset`가 `bool`(완료 여부) 반환, 등록 핸들러의 `for ws in &streams` 루프는 한 스트림이 incomplete면 break(이미 AbortRun 전송됨, 이후 스트림 시도 불필요).
- **back-compat 전환 안전**: 워커는 proto `data_bindings`(field 10)가 비어있으면 레거시 `data_binding`(field 5)을 1-원소로 fall back. 컨트롤러는 field 10만 채운다. → Task 4(워커 fallback)가 Task 5(컨트롤러 emit)보다 먼저라 모든 중간 커밋이 green.

## 커밋 경계 규칙 (이 repo 고유 — 반드시 준수)

- **각 task = 단일 green 커밋.** pre-commit이 전체 워크스페이스 `build/clippy -D warnings/nextest`를 돈다(수 분). RED 테스트만 커밋·미사용 `pub(crate)` 헬퍼만 커밋은 게이트 실패 → 헬퍼·테스트·배선을 한 커밋으로 fold.
- 커밋은 `run_in_background:false` 단일 호출 + `timeout 600000`, 폴링 금지. `git commit`을 `| tail`로 파이프하지 말 것(exit code 마스킹) — 직후 `git log -1`로 확인.
- prost/RunPlan/Profile 필드 추가는 **워크스페이스 전체 컴파일 break**라 "필드 추가 + 전 literal 사이트 갱신"을 한 커밋에 묶어야 빌드가 선다.
- TDD-guard: src 편집 전 pending test 필요. 인라인 `#[cfg(test)]`가 이미 있는 파일(`binding.rs`/`dataset.rs`/`runner.rs`/`coordinator.rs`/`api/runs.rs`/`DataBindingPanel.test.tsx` 등)은 자동 통과. 새 src 파일·인라인 테스트 *첫 추가*는 먼저 `tests/*.rs` 또는 `*.test.tsx`를 만들어 unblock.
- spec-review-guard: 이 plan에 `REVIEW-GATE: APPROVED` 마커가 있어야 `crates/*/src`·`ui/src` 편집 허용.

---

## Task 1: proto 필드 추가 + 전 literal 사이트 갱신 (행동 무변경)

**Files:**
- Modify: `crates/proto/proto/coordinator.proto` (RunAssignment, DatasetBatch)
- Modify (literal 사이트, prost exhaustive): `crates/controller/src/grpc/coordinator.rs:279` (RunAssignment), `:799` (DatasetBatch), `crates/worker-core/src/client.rs:250` (DatasetBatch), `crates/proto/tests/run_assignment_env_test.rs:11,58` (RunAssignment)
- Test: `crates/proto/tests/run_assignment_env_test.rs` (round-trip)

- [ ] **Step 1: proto에 필드 추가**

`coordinator.proto` `RunAssignment`(field 5 `data_binding` 아래):
```proto
  DataBinding data_binding = 5;   // DEPRECATED: 단일 바인딩(레거시). 신 컨트롤러는 data_bindings 사용.
  // ... (기존 6~9: shard_index/shard_count/vu_offset/vu_count) ...
  repeated DataBinding data_bindings = 10;  // 다중 독립 바인딩 (binding_index 순서)
```
`DatasetBatch`:
```proto
message DatasetBatch {
  string run_id = 1;
  repeated DatasetRow rows = 2;
  uint32 binding_index = 3;   // 이 배치 행들이 몇 번째 바인딩 것인지 (단일=0)
}
```

- [ ] **Step 2: 빌드해서 깨지는 literal 사이트 전부 확인**

Run: `cargo build --workspace --tests 2>&1 | grep -E "missing field|RunAssignment|DatasetBatch" | head`
Expected: `RunAssignment {...}`·`DatasetBatch {...}` literal에 missing field 에러.

- [ ] **Step 3: 모든 RunAssignment/DatasetBatch literal에 새 필드 추가**

- `coordinator.rs:279` `RunAssignment {...}`: `data_bindings: vec![]` 추가(아직 미사용 — Task 5에서 채움). 기존 `data_binding:` 줄 유지.
- `coordinator.rs:799`·`client.rs:250` `DatasetBatch {...}`: `binding_index: 0` 추가.
- `run_assignment_env_test.rs:11,58` `RunAssignment {...}`: `data_bindings: vec![]` 추가.
- 그 외 grep로 나온 사이트 전부: `grep -rn "RunAssignment {\|DatasetBatch {" crates/`

- [ ] **Step 4: round-trip 테스트 추가** (`run_assignment_env_test.rs`에 인라인)

```rust
#[test]
fn run_assignment_carries_multiple_bindings() {
    use handicap_proto::v1::{data_binding::Policy, DataBinding, RunAssignment};
    let a = RunAssignment {
        run_id: "r".into(),
        data_bindings: vec![
            DataBinding { policy: Policy::PerVu as i32, seed: 1, row_count: 3 },
            DataBinding { policy: Policy::Unique as i32, seed: 1, row_count: 20 },
        ],
        ..Default::default()
    };
    let bytes = prost::Message::encode_to_vec(&a);
    let back = RunAssignment::decode(bytes.as_slice()).unwrap();
    assert_eq!(back.data_bindings.len(), 2);
    assert_eq!(back.data_bindings[1].row_count, 20);
}

#[test]
fn dataset_batch_carries_binding_index() {
    use handicap_proto::v1::DatasetBatch;
    let b = DatasetBatch { run_id: "r".into(), rows: vec![], binding_index: 2 };
    let back = DatasetBatch::decode(prost::Message::encode_to_vec(&b).as_slice()).unwrap();
    assert_eq!(back.binding_index, 2);
}
```
(파일 상단에 `use prost::Message;` 필요 시 추가.)

- [ ] **Step 5: 빌드+테스트**

Run: `cargo build --workspace --tests && cargo nextest run -p handicap-proto`
Expected: PASS, 0 에러.

- [ ] **Step 6: 커밋**

```bash
git add crates/proto crates/controller/src/grpc/coordinator.rs crates/worker-core/src/client.rs
git commit -m "feat(proto): add data_bindings + DatasetBatch.binding_index (multi-dataset)"
```
(커밋 후 `git log -1`로 확인.)

---

## Task 2: store `Profile`에 `data_bindings` + 접근자 + back-compat (행동 무변경)

**Files:**
- Modify: `crates/controller/src/store/runs.rs` (Profile struct + `data_bindings()` 접근자)
- Modify (literal 사이트, ~47곳, rustc-driven): `report.rs`, `schedule/runner.rs`, `store/presets.rs`, `store/schedules.rs`, `api/runs.rs`(tests), `tests/*.rs` 다수
- Test: `crates/controller/src/store/runs.rs` 인라인 `#[cfg(test)]`

- [ ] **Step 1: 실패 테스트 작성** (runs.rs 인라인 tests에 추가)

```rust
#[test]
fn legacy_single_binding_folds_into_data_bindings_accessor() {
    // 옛 profile_json: data_binding(단일) only, data_bindings 없음
    let json = r#"{"vus":1,"ramp_up_seconds":0,"duration_seconds":2,
        "data_binding":{"dataset_id":"01J","policy":"per_vu","mappings":[]}}"#;
    let p: Profile = serde_json::from_str(json).unwrap();
    let eff = p.data_bindings();
    assert_eq!(eff.len(), 1);
    assert_eq!(eff[0].dataset_id, "01J");
}

#[test]
fn data_bindings_vec_takes_precedence_over_legacy() {
    let json = r#"{"vus":1,"ramp_up_seconds":0,"duration_seconds":2,
        "data_bindings":[
            {"dataset_id":"A","policy":"per_vu","mappings":[]},
            {"dataset_id":"B","policy":"unique","mappings":[]}]}"#;
    let p: Profile = serde_json::from_str(json).unwrap();
    assert_eq!(p.data_bindings().len(), 2);
}

#[test]
fn no_binding_yields_empty_accessor() {
    let json = r#"{"vus":1,"ramp_up_seconds":0,"duration_seconds":2}"#;
    let p: Profile = serde_json::from_str(json).unwrap();
    assert!(p.data_bindings().is_empty());
}
```

- [ ] **Step 2: 실패 확인**

Run: `cargo build -p handicap-controller --tests 2>&1 | grep -E "data_bindings|no method" | head`
Expected: `data_bindings` 필드/메서드 없음 에러.

- [ ] **Step 3: Profile에 필드 + 접근자 추가** (`store/runs.rs`)

`Profile` struct에 (기존 `data_binding: Option<...>` 줄 유지, 그 아래):
```rust
    #[serde(default)]
    pub data_binding: Option<crate::binding::DataBinding>,   // DEPRECATED: 레거시 단일(읽기 호환)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub data_bindings: Vec<crate::binding::DataBinding>,      // 다중 — 신규 쓰기는 여기만 채움
    // (skip_serializing_if로 비면 키 생략 — stages/vu_stages/worker_count 컨벤션 일치,
    //  바인딩 없는 run의 profile_json을 pre-feature와 근사 유지. UI .optional()이 부재 허용.)
```
`impl Profile`에 접근자:
```rust
    /// 효과적 바인딩 목록: data_bindings가 비어있지 않으면 그것, 비었으면 레거시
    /// data_binding을 1-원소로 fold. 모든 읽기 사이트는 이 접근자를 경유한다.
    pub fn data_bindings(&self) -> Vec<&crate::binding::DataBinding> {
        if !self.data_bindings.is_empty() {
            self.data_bindings.iter().collect()
        } else {
            self.data_binding.iter().collect()
        }
    }
```

- [ ] **Step 4: 깨진 Profile literal 사이트 전부 갱신**

Run: `cargo build --workspace --tests 2>&1 | grep "missing field \`data_bindings\`" | wc -l` 로 사이트 수 확인(~47).
각 `Profile {...}` literal에 `data_bindings: vec![]` 한 줄 추가. 위치 찾기: `grep -rn "Profile {" crates/controller/src crates/controller/tests`. (테스트 literal은 전부 `vec![]`; 프로덕션도 현재 단일 경로 유지라 `vec![]`.)

- [ ] **Step 5: 빌드+테스트**

Run: `cargo build --workspace --tests && cargo nextest run -p handicap-controller store::runs`
Expected: PASS(새 3개 포함).

- [ ] **Step 6: 커밋**

```bash
git add crates/controller
git commit -m "feat(store): Profile.data_bindings Vec + accessor (back-compat fold)"
```

---

## Task 3: 엔진 `RunPlan.data_bindings` Vec + 3경로 다중 주입

**Files:**
- Modify: `crates/engine/src/runner.rs` (RunPlan:57, 카운터 셋업 ~128/674/1076, VU body 주입 ~348/981/1328)
- Modify: `crates/worker/src/main.rs:197` (RunPlan literal — 단일을 1-원소 Vec로 래핑)
- Modify (RunPlan literal, ~19파일 rustc-driven): 엔진 테스트 전부 + 워커 테스트
- Test: `crates/engine/tests/` 신규 `multi_dataset_binding.rs` + `dataset.rs`/`runner.rs` 인라인

- [ ] **Step 1: 실패 테스트 작성** — `crates/engine/tests/multi_dataset_binding.rs` (신규 파일, TDD-guard unblock)

엔진 통합 테스트: 2개 데이터셋(서로 다른 정책·행수)을 `RunPlan.data_bindings`에 주고, wiremock으로 두 변수가 **모두** 주입돼 요청에 나가는지 확인. 기존 `crates/engine/tests/`의 데이터바인딩 통합 테스트(예: 8c 테스트) 패턴을 그대로 차용 — `RunPlan{ data_bindings: vec![ds_a, ds_b], .. }` + wiremock matcher로 양쪽 변수 검증. (정확한 헬퍼는 기존 단일-binding 통합 테스트를 복사해 2-binding으로 확장.)

추가로 `dataset.rs`/`runner.rs` 인라인 단위 테스트:
```rust
// runner.rs tests: 비-unique + unique 혼합에서 unique 소진 시 VU 중단
// (run_scenario를 짧은 데이터셋으로 돌려 요청 수가 unique 행수에 bound 되는지)
```

- [ ] **Step 2: 실패 확인**

Run: `cargo build -p handicap-engine --tests 2>&1 | grep -E "data_bindings|data_binding" | head`
Expected: `RunPlan.data_binding` 필드 없음(아직 Vec 아님) 에러.

- [ ] **Step 3: `RunPlan.data_binding` → `data_bindings: Vec`** (`runner.rs:57`)

```rust
    pub data_bindings: Vec<Arc<DataSet>>,
```

- [ ] **Step 4: 3경로 카운터 셋업 → Vec + 함수 시그니처·instrument 갱신**

**(a) 카운터 셋업** (`run_scenario` ~122/128, `run_scenario_vu_curve` ~668/674, `run_scenario_open_loop` ~1068/1076) — 단일 `dataset`/`seq_counter` 대신:
```rust
    let datasets = plan.data_bindings.clone();
    // 바인딩마다 공유 카운터(IterSequential|Unique만 Some) — 인덱스 = 바인딩 순서
    let seq_counters: Vec<Option<Arc<AtomicU64>>> = datasets
        .iter()
        .map(|d| match d.policy {
            BindingPolicy::IterSequential | BindingPolicy::Unique => Some(Arc::new(AtomicU64::new(0))),
            _ => None,
        })
        .collect();
```

**(b) VU 함수 시그니처 3곳** — `dataset: Option<Arc<DataSet>>` → `datasets: Vec<Arc<DataSet>>`, `seq_counter: Option<Arc<AtomicU64>>` → `seq_counters: Vec<Option<Arc<AtomicU64>>>`:
- `run_vu`(runner.rs:321), `run_vu_curve`(:914), `run_arrival`(:1311).

**(c) instrument skip-list** (rustc가 stale 식별자로 에러): `run_vu`의 `#[instrument(skip(scenario, agg, env, dataset, seq_counter), fields(vu_id))]`(runner.rs:320) → `skip(scenario, agg, env, datasets, seq_counters)`. (`run_vu_curve`는 `skip_all`이라 무변경. `run_arrival`은 instrument 없음.)

**(d) spawn 사이트** 3곳(~171-172, ~763-764, ~1214-1216): `dataset.clone()`/`seq_counter.clone()` → `datasets.clone()`/`seq_counters.clone()`.

- [ ] **Step 5: 3경로 VU body 주입 → 순회 (경로별 None 처리 다름!)**

세 경로의 현재 `None` arm이 **구조적으로 다르므로** 단일 스니펫 금지 — 각 경로의 기존 None 동작을 그대로 미러한다. 공통 카운터 부작용 주석(spec §7): *앞서 평가된 IterSequential 공유 카운터는 break 유발 iter에서 1칸 더 전진(VU당 1회 버려지는 증분, deadline 부분 iteration과 동급 허용).*

**(a) closed-loop `run_vu`** (runner.rs:347, `while` 루프 안, 기존 `None => break`):
```rust
    let mut stop = false;
    for (i, ds) in datasets.iter().enumerate() {
        match ds.select_index(vu_id, iter_id, seq_counters[i].as_deref()) {
            Some(idx) => for (k, v) in &ds.rows[idx] { iter_vars.insert(k.clone(), v.clone()); },
            None => { stop = true; break; }
        }
    }
    if stop { break; }   // while 루프 종료(기존 None=>break와 동일)
```

**(b) vu-curve `run_vu_curve`** (runner.rs:980, 루프 안, 기존 `None => { clear_slot(&slab, index); return Ok(()); }`):
```rust
    let mut stop = false;
    for (i, ds) in datasets.iter().enumerate() {
        match ds.select_index(vu_id, iter_id, seq_counters[i].as_deref()) {
            Some(idx) => for (k, v) in &ds.rows[idx] { iter_vars.insert(k.clone(), v.clone()); },
            None => { stop = true; break; }
        }
    }
    if stop { clear_slot(&slab, index); return Ok(()); }   // 기존 None arm 그대로
```

**(c) open-loop `run_arrival`** (runner.rs:1327, **루프 없는 단일 arrival**, 기존 `None => { exhausted.store(true, Ordering::Relaxed); return Ok(()); }`; **로컬명을 `exhausted`로 쓰지 말 것** — 동명의 `exhausted: &AtomicBool` 파라미터가 :1323에 있음):
```rust
    for (i, ds) in datasets.iter().enumerate() {
        match ds.select_index(vu_id, iter_id, seq_counters[i].as_deref()) {
            Some(idx) => for (k, v) in &ds.rows[idx] { iter_vars.insert(k.clone(), v.clone()); },
            None => { exhausted.store(true, Ordering::Relaxed); return Ok(()); }  // 기존 동작
        }
    }
```

- [ ] **Step 6: 워커 RunPlan literal 래핑** (`worker/src/main.rs:197`)

기존 `data_binding: dataset,`를:
```rust
        data_bindings: dataset.into_iter().collect(),  // 단일(field5)을 1-원소 Vec로 (Task 4에서 다중화)
```

- [ ] **Step 7: 깨진 RunPlan literal 전부 갱신**

`grep -rln "RunPlan {" crates/`로 ~19파일 확인. 각 `data_binding: Some(x)` → `data_bindings: vec![x]`, `data_binding: None` → `data_bindings: vec![]`.

- [ ] **Step 8: 빌드+테스트**

Run: `cargo build -p handicap-worker && cargo build --workspace --tests && cargo nextest run -p handicap-engine`
Expected: PASS(다중 주입·unique 소진 테스트 포함). 단일 바인딩 기존 테스트도 통과(N=1 동일).

- [ ] **Step 9: 커밋**

```bash
git add crates/engine crates/worker/src/main.rs
git commit -m "feat(engine): RunPlan.data_bindings Vec + per-binding inject (break-on-first-None)"
```

---

## Task 4: 워커 다중 적재 (`load_dataset` 버킷) + proto data_bindings 읽기(fallback)

**Files:**
- Modify: `crates/worker-core/src/client.rs:137-172` (`load_dataset` 버킷 form)
- Modify: `crates/worker/src/main.rs:121-183` (assignment.data_bindings 순회 → `Vec<Arc<DataSet>>`, field10 비면 field5 fallback)
- Test: `crates/worker-core/src/client.rs` 인라인(기존 `load_dataset` 테스트 패턴, :250 DatasetBatch 송신)

- [ ] **Step 1: 실패 테스트 작성** (client.rs 인라인 tests)

```rust
#[tokio::test]
async fn load_datasets_buckets_by_binding_index() {
    // 두 바인딩: index 0 expected=2, index 1 expected=3. 섞인 순서로 배치 전송돼도
    // 각 버킷이 자기 count까지 채워지면 반환. (raw mpsc::Receiver + .recv() — 기존 load_dataset과 동형)
    let (tx, mut rx) = tokio::sync::mpsc::channel(16);
    send_batch(&tx, 1, "run", &["b0"]).await;          // index1 일부
    send_batch(&tx, 0, "run", &["a0", "a1"]).await;    // index0 전부
    send_batch(&tx, 1, "run", &["b1", "b2"]).await;    // index1 나머지 (순서-독립 검증)
    drop(tx);
    let cancel = CancellationToken::new();
    let out = load_datasets(&mut rx, &[2, 3], "run", &cancel).await.unwrap();
    assert_eq!(out[0].len(), 2);
    assert_eq!(out[1].len(), 3);
}

#[tokio::test]
async fn load_datasets_early_close_is_incomplete() {
    // 약속 5행인데 3행만 보내고 stream 닫힘 → DatasetIncomplete{got:3, expected:5}
    let (tx, mut rx) = tokio::sync::mpsc::channel(16);
    send_batch(&tx, 0, "run", &["a0","a1","a2"]).await;
    drop(tx);
    let cancel = CancellationToken::new();
    let err = load_datasets(&mut rx, &[5], "run", &cancel).await.unwrap_err();
    assert!(matches!(err, WorkerError::DatasetIncomplete { got: 3, expected: 5 }));
}
```
(`send_batch(tx, binding_index, run_id, vals)`는 `ServerMessage{DatasetBatch{run_id, rows, binding_index}}`를 보내는 헬퍼; 기존 client.rs:250 테스트 패턴 차용.)

- [ ] **Step 2: 실패 확인**

Run: `cargo build -p handicap-worker-core --tests 2>&1 | grep "load_datasets" | head`
Expected: `load_datasets` 미정의.

- [ ] **Step 3: `load_dataset` → `load_datasets` 버킷 form** (client.rs)

기존 `load_dataset`(client.rs:141, `&mut mpsc::Receiver<ServerMessage>` + `.recv()`)을 **그대로 복제·확장**한다(시그니처 형태 유지 — 워커가 raw `&mut inbound_rx`를 넘기고 적재 후 `.recv()`로 재사용하므로 `ReceiverStream`/`impl Stream`로 바꾸지 말 것):
```rust
/// 바인딩별 expected count(인덱스=binding_index)를 받아 각 버킷을 채울 때까지 드레인.
/// 배치는 binding_index로 라우팅돼 스트림 순서 무관. abort(우리 run)/cancel → Cancelled,
/// 조기 종료 → DatasetIncomplete{got=수신합, expected=약속합}. (기존 load_dataset 미러)
pub async fn load_datasets(
    inbound_rx: &mut mpsc::Receiver<ServerMessage>,
    expected: &[u64],
    run_id: &str,
    cancel: &CancellationToken,
) -> Result<Vec<Vec<BTreeMap<String, String>>>, WorkerError> {
    let mut buckets: Vec<Vec<BTreeMap<String, String>>> =
        expected.iter().map(|&n| Vec::with_capacity(n as usize)).collect();
    let total_expected: u64 = expected.iter().sum();
    let mut total_got: u64 = 0;
    while total_got < total_expected {
        tokio::select! {
            _ = cancel.cancelled() => return Err(WorkerError::Cancelled),
            msg = inbound_rx.recv() => match msg {
                Some(sm) => match sm.payload {
                    Some(ServerPayload::DatasetBatch(b)) => {
                        if let Some(bucket) = buckets.get_mut(b.binding_index as usize) {
                            for r in b.rows { bucket.push(r.values.into_iter().collect()); total_got += 1; }
                        } // 알 수 없는 binding_index는 방어적으로 무시
                    }
                    Some(ServerPayload::Abort(a)) if a.run_id == run_id => return Err(WorkerError::Cancelled),
                    _ => {} // Ping / 무관 메시지 — 적재 중 무시 (기존 동작)
                },
                None => return Err(WorkerError::DatasetIncomplete { got: total_got, expected: total_expected }),
            }
        }
    }
    Ok(buckets)
}
```
(기존 `load_dataset`은 `load_datasets`로 대체 — 호출처는 worker main.rs 한 곳. `use` 변경 없음: `mpsc`/`ServerPayload`/`BTreeMap`은 이미 import됨.)

- [ ] **Step 4: 워커 main.rs 다중 적재 + fallback** (`main.rs:121-183`)

```rust
    // field 10(data_bindings) 우선, 비면 레거시 field 5(data_binding) 1-원소 fallback.
    let bindings: Vec<&pb::DataBinding> = if !assignment.data_bindings.is_empty() {
        assignment.data_bindings.iter().collect()
    } else {
        assignment.data_binding.iter().collect()
    };
    let datasets: Vec<Arc<DataSet>> = if bindings.iter().any(|b| b.row_count > 0) {
        let expected: Vec<u64> = bindings.iter().map(|b| b.row_count).collect();
        match load_datasets(&mut inbound_rx, &expected, &args.run_id, &cancel).await {
            Ok(all_rows) => bindings.iter().zip(all_rows).map(|(b, rows)| {
                let policy = map_policy(b.policy);   // 기존 try_from 매핑을 헬퍼로 추출
                Arc::new(DataSet { policy, seed: b.seed, rows })
            }).collect(),
            Err(WorkerError::Cancelled) => { /* 기존 Aborted 종료 시퀀스 (main.rs:144-160) */ }
            Err(e) => { /* 기존 Failed 종료 시퀀스 (main.rs:162-178) */ }
        }
    } else { Vec::new() };
    // ... RunPlan { data_bindings: datasets, .. } (Task 3에서 Vec)
```
기존 단일-binding의 policy try_from 매핑(`pb::Policy::try_from … unreachable!`)을 `fn map_policy(i32) -> BindingPolicy` 헬퍼로 추출해 재사용. abort/fail 종료 시퀀스 블록은 기존 그대로 보존(어느 바인딩이든 미완이면 동일 처리).

- [ ] **Step 5: 빌드+테스트**

Run: `cargo build -p handicap-worker && cargo build --workspace --tests && cargo nextest run -p handicap-worker-core`
Expected: PASS(버킷 드레인·조기종료 테스트 포함).

- [ ] **Step 6: 커밋**

```bash
git add crates/worker-core crates/worker/src/main.rs
git commit -m "feat(worker): load N datasets by binding_index bucket (legacy field5 fallback)"
```

---

## Task 5: 컨트롤러 검증·발사·코디네이터 다중 바인딩

**Files:**
- Modify: `crates/controller/src/binding.rs` (변수명 수집 헬퍼)
- Modify: `crates/controller/src/api/runs.rs:388-513` (`validate_run_config` 루프+교차검증 → `Vec<DatasetMeta>`, `spawn_run` Vec 빌드)
- Modify: `crates/controller/src/grpc/coordinator.rs:45-70,253-300,716-722,757-` (`PendingDataBinding` Vec, `WorkerStream.binding_index`, `assignment_for` 루프, register 다중 스트림, `stream_dataset` bool)
- Modify: `crates/controller/src/store/runs.rs:385` (`dataset_in_use` 순회), `store/presets.rs:161` (`referencing_dataset` 순회)
- Test: `crates/controller/tests/data_binding_api_test.rs` + 인라인

- [ ] **Step 1: 실패 테스트 작성** (`data_binding_api_test.rs` 확장 + binding.rs 인라인)

```rust
// api 통합: 2개 바인딩 run 생성 성공(NoopDispatcher); 변수명 중복 400; >8개 400.
#[tokio::test]
async fn rejects_duplicate_var_across_bindings() {
    // bindings: [{ds A, map name→"x"}, {ds B, map other→"x"}] → 400 "중복 매핑"
}
#[tokio::test]
async fn rejects_too_many_bindings() { /* 9개 → 400 */ }
#[tokio::test]
async fn accepts_two_independent_bindings() { /* 서로 다른 var → 201 */ }
```
binding.rs 인라인: `collect_var_names(&[DataBinding]) -> Vec<String>` 단위 테스트(중복 검출).

- [ ] **Step 2: 실패 확인**

Run: `cargo build -p handicap-controller --tests 2>&1 | head`
Expected: 새 테스트 컴파일/실패.

- [ ] **Step 3: `validate_run_config` 루프 + 교차검증 → `Vec<DatasetMeta>`** (`api/runs.rs:388`)

기존 단일 `let Some(b) = &profile.data_binding else { return Ok(None) }` 블록을:
```rust
    let bindings = profile.data_bindings();   // Vec<&DataBinding>
    if bindings.is_empty() { return Ok(Vec::new()); }
    const MAX_BINDINGS: usize = 8;
    if bindings.len() > MAX_BINDINGS {
        return Err(ApiError::BadRequest(format!("데이터셋 바인딩은 최대 {MAX_BINDINGS}개입니다 ({}개)", bindings.len())));
    }
    // 교차-바인딩 변수명 중복
    let mut seen = std::collections::HashSet::new();
    for b in &bindings {
        for m in &b.mappings {
            let var = match m { Mapping::Column { var, .. } | Mapping::Literal { var, .. } => var };
            if !seen.insert(var.clone()) {
                return Err(ApiError::BadRequest(format!("변수 '{var}'이 여러 데이터셋에 중복 매핑됨")));
            }
        }
    }
    // per-바인딩 검증(기존 로직을 바인딩마다 반복) → 검증된 meta 수집
    let mut metas = Vec::with_capacity(bindings.len());
    for b in &bindings {
        let meta = /* 기존 get_meta + row_count>0 + 컬럼존재 + unique≥N + per-iteration cap 검증 (b 기준) */;
        metas.push(meta);
    }
    Ok(metas)
```
반환 타입 `Result<Option<DatasetMeta>, _>` → **`Result<Vec<DatasetMeta>, _>`**. 함수 시그니처·doc 갱신. (변수명 추출은 binding.rs `collect_var_names` 헬퍼로 두면 단위테스트 가능 — Step 1.)

**호출처 정합(대부분 무편집 — rustc가 강제)**: `validate_run_config`의 다른 호출자 — `api/presets.rs:84,144`·`api/schedules.rs:182`는 `?`로 Ok 페이로드를 버려서 무영향; `schedule/runner.rs:142`(`Ok(m) => m`)와 `create()`(runs.rs)는 `m`을 잡아 `spawn_run`에 넘기는데 `spawn_run`도 `Vec<DatasetMeta>`를 받게 바뀌므로 타입 추론으로 통과. **단 인라인 테스트 1곳은 수정 필요**: `api/runs.rs:1185` `assert!(meta.is_some(), …)` → `assert!(!meta.is_empty(), …)`(Vec엔 `is_some` 없음 — `cargo build --workspace --tests`가 잡음). **`metas` 순서 = `data_bindings()` 순서** 불변식 유지: validate와 spawn_run 둘 다 `profile.data_bindings()`를 같은 순서로 순회하므로 zip이 정합(접근자가 단일 소스).

- [ ] **Step 4: `spawn_run` Vec 빌드** (`api/runs.rs:468`)

`validated_meta: Option<DatasetMeta>` 파라미터 → **`Vec<DatasetMeta>`**. 기존 단일 `match (&profile.data_binding, validated_meta)` 해석 블록을 `profile.data_bindings().iter().zip(metas)` 순회로:
```rust
    let data_bindings: Vec<PendingDataBinding> = profile.data_bindings().iter().zip(validated_metas)
        .map(|(b, meta)| {
            let (policy, row_count) = /* 기존 per-policy slot_count/row_count 산출 (b, meta 기준) */;
            PendingDataBinding { dataset_id: b.dataset_id.clone(), policy, seed: fold_seed(&row.id), mappings: b.mappings.clone(), row_count }
        }).collect();
```
`PendingAssignment { data_bindings, .. }`로 넣음(아래 Step 5에서 필드 Vec화).

- [ ] **Step 5: 코디네이터 다중화** (`grpc/coordinator.rs`)

- `PendingAssignment.data_binding: Option<PendingDataBinding>` (:70) → **`data_bindings: Vec<PendingDataBinding>`**.
- `WorkerStream`(:56-61)에 **`binding_index: u32`** 추가.
- `assignment_for`(:253-300): 단일 `binding`/`stream` → **바인딩마다 루프**로 `Vec<pb::DataBinding>`(per-worker sliced row_count) + `Vec<WorkerStream>`(각자 `binding_index = i`) 생성. unique는 바인딩별 독립 `dataset_slice`. proto `RunAssignment.data_bindings`에 vec 채움(`data_binding: None`로 둠). 반환 `(RunAssignment, Vec<WorkerStream>)`.
- register 핸들러(:718-722): `if let Some(ws)=&stream` → `for ws in &streams { if ws.count>0 { if !stream_dataset(&state,&tx,&reg.run_id,ws).await { break; } } }`.
- `stream_dataset`(:757): `binding_index: ws.binding_index`를 `DatasetBatch`에 실음. 반환 타입 `()` → **`bool`**(incomplete면 false; 기존 AbortRun 전송 유지).

- [ ] **Step 6: dataset DELETE 가드 순회** (`store/runs.rs:385`, `store/presets.rs:161`)

`if let Some(b) = &profile.data_binding { b.dataset_id == target }` → `profile.data_bindings().iter().any(|b| b.dataset_id == target)`. 두 함수(`dataset_in_use`·`referencing_dataset`) 동일 패턴.

- [ ] **Step 7: 빌드+테스트 + 기존 통합테스트 갱신**

Run: `cargo build --workspace --tests && cargo nextest run -p handicap-controller`
Expected: PASS. 기존 `data_binding_api_test.rs`가 proto field 5를 단언하면 field 10(`data_bindings`)으로 갱신. assignment 스트리밍 테스트의 단일 stream 가정도 갱신.

- [ ] **Step 8: 커밋**

```bash
git add crates/controller
git commit -m "feat(controller): N-binding validate/spawn/assignment (dup-var + cap gates)"
```

---

## Task 6: UI 다중 바인딩 (스키마·공유 빌더·두 폼·패널)

**Files:**
- Modify: `ui/src/api/schemas.ts` (ProfileSchema.data_bindings)
- Modify: `ui/src/components/profileForm.ts:119-133` (ProfileFormInput.bindings + buildProfile)
- Modify: `ui/src/components/DataBindingPanel.tsx` (목록 편집기)
- Modify: `ui/src/components/RunDialog.tsx:137-,382,537` (bindings 배열)
- Modify: `ui/src/components/ScheduleForm.tsx:170-184,234,432` (bindings 배열)
- Modify: `ui/src/i18n/ko.ts` (충돌 경고 문구)
- Test: `ui/src/components/__tests__/DataBindingPanel.test.tsx`, `RunDialog.test.tsx`, `profileForm.test.ts`

- [ ] **Step 1: 실패 테스트 작성** (DataBindingPanel.test.tsx + profileForm.test.ts)

```ts
// profileForm: bindings 배열이 data_bindings로 빌드되고 legacy data_binding 키는 생략
it("buildProfile emits data_bindings, omits legacy data_binding", () => {
  const p = buildProfile({ ...base, bindings: [bA, bB] });
  expect(p.data_bindings).toHaveLength(2);
  expect("data_binding" in p).toBe(false);
});
// 패널: 데이터셋 추가/제거; 두 바인딩이 같은 var면 onValidityChange(false)
it("flags duplicate var across bindings", () => { /* ... */ });
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test -- profileForm DataBindingPanel 2>&1 | tail`
Expected: FAIL.

- [ ] **Step 3: `schemas.ts`** — `ProfileSchema`에 추가(레거시 유지):

```ts
  data_binding: DataBindingSchema.nullish(),                 // 레거시 읽기 호환
  data_bindings: z.array(DataBindingSchema).optional(),      // 신규 쓰기
```
(`ProfileSchema`는 `.strict()` 아님 — 기존 fixture 무영향. 확인: schemas.ts:70-95.)

- [ ] **Step 4: `profileForm.ts`** — `ProfileFormInput.binding: DataBinding|null` → `bindings: DataBinding[]`; `buildProfile`에서 `data_binding: i.binding ?? undefined` → `data_bindings: i.bindings.length ? i.bindings : undefined`(빈 배열이면 키 생략, 레거시 `data_binding` 키 미작성).

- [ ] **Step 5: `DataBindingPanel.tsx`** — 단일 상태(`selectedId`/`policy`/`rows`)를 **바인딩 카드 목록**으로. `onChange(bindings: DataBinding[])`, `onValidityChange(ok, reasons)`. "데이터셋 추가"/카드 제거. 각 카드: 접이식 disclosure(`ScenarioSnapshot` 이디엄, [[ui-optional-sections-collapsible]] 선호) + 데이터셋 선택 + 정책 + 매핑 행 + **행개수 인라인 표시**(`useDataset(id).row_count`). 교차-카드 변수명 중복이면 `onValidityChange(false, [ko 문구])`. (단일 바인딩 편집 로직은 카드 내부로 보존 — 기존 매핑 row UX 재사용.)

- [ ] **Step 6: `RunDialog.tsx` + `ScheduleForm.tsx`** — `binding: DataBinding|null` state → `bindings: DataBinding[]`(+`seedBindings`/`panelKey`). 프리필: `prof.data_bindings ?? (prof.data_binding ? [prof.data_binding] : [])`. `buildProfile({..., bindings})`. 두 폼 동일 패턴(lockstep). DataBindingPanel 마운트(RunDialog:537, ScheduleForm:432)에 새 props.

- [ ] **Step 7: 빌드+lint+테스트**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/multi-dataset-binding/ui && pnpm lint && pnpm test && pnpm build`
Expected: PASS(`--max-warnings=0`, `tsc -b` strict 포함).

- [ ] **Step 8: 커밋**

```bash
git add ui
git commit -m "feat(ui): multi-dataset binding list (panel + RunDialog + ScheduleForm)"
```

---

## Task 7: 최종 리뷰 + 라이브 검증

- [ ] **Step 1: `handicap-reviewer`로 whole-feature 리뷰** — 크로스커팅·repo 함정·UI Zod↔엔진 serde 와이어 1:1(`data_bindings`·`binding_index` field명/순서), deferral 추적, build/lint 게이트 재확인. APPROVE까지.

- [ ] **Step 2: 라이브 검증(`/live-verify`, S-D 갭 필수 — run생성/report파싱/엔진경로 전부 건드림)**

워크트리 자체 바이너리 + echo responder(헤더/바디 파일 기록) + 격리 DB로:
1. 데이터셋 2개 업로드 — racetracks(3행, `iter_random`, `track`로 매핑) + users(20행, `unique`, `uid`로 매핑).
2. 두 바인딩(`data_bindings`)으로 run 1회 생성 → 완료.
3. echo 와이어 grep: `{{track}}`·`{{uid}}` **둘 다** 실제 요청에 주입됐는지 확인(서로 다른 행수에도 독립 전진).
4. report JSON을 UI `ReportSchema.safeParse`(strict)로 통과 + 브라우저 콘솔 Zod 0.
5. 변수명 충돌 케이스(둘 다 같은 var) → 400 거부 확인.

- [ ] **Step 3: 검증 산출물 정리** — `rm -rf .playwright-mcp` + 루트 png(있으면). build-log에 라이브 결과 한 단락.

---

## Self-Review (작성자 체크)

- **Spec 커버리지**: §4.1 model→Task2, §4.2 검증→Task5, §4.3 DELETE가드→Task5, §5 proto→Task1, §6 코디네이터→Task5, §7 엔진→Task3, §8 워커→Task4, §9 UI→Task6, §10 back-compat→Task2/3/4(fallback)·Task6(schema), §11 테스트→각 task+Task7. 전 섹션 매핑됨.
- **Placeholder**: 기계적 fan-out(literal ~47/~19)은 grep 명령 + rustc-driven으로 명시(이 repo의 컴파일러-강제 패턴). 코드 스니펫은 핵심 로직 전부 포함, "기존 로직 반복"은 정확 위치(file:line) 지정.
- **타입 일관성**: `data_bindings`(Vec) / `data_bindings()`(접근자, `Vec<&DataBinding>`) / `load_datasets`(복수형) / `WorkerStream.binding_index` / `PendingDataBinding` Vec — task 간 이름 일치 확인.
- **커밋 경계**: 각 task가 워크스페이스-컴파일 단위(proto·Profile·RunPlan 각 1커밋) + green. 중간 상태 없음(워커 fallback이 Task4<Task5 순서 보장).

<!-- spec: spec-plan-reviewer clean APPROVE (2026-06-15). plan: clean APPROVE (2026-06-15). -->
REVIEW-GATE: APPROVED

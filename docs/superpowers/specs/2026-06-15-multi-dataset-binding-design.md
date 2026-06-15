# 다중 데이터셋 바인딩 (multi-dataset binding) — 설계

작성: 2026-06-15 · 상태: 설계 · 범위: post-MVP1 / ADR-0022 확장

## 1. 동기·문제

지금 한 run(Profile)은 데이터셋을 **딱 하나**만 바인딩할 수 있다 (`Profile.data_binding: Option<DataBinding>`, proto `RunAssignment.data_binding` 단일, `DatasetBatch` 스트림 1개). 실사용에서는 한 시나리오가 **여러 독립 데이터 소스**를 동시에 쓰고 싶다 — 예: 경마 부하 테스트에서 **경마장 목록(~10행)** 과 **사용자 계정(수천 행)** 을 같은 시나리오 안에서 함께 주입. 두 소스는 행 개수가 자연히 다르고, **행 단위로 짝지어지지 않는다**(독립). 짝지어야 하는 데이터는 사용자가 애초에 하나의 파일로 합쳐 업로드한다 (정렬/zip은 범위 밖 — 사용자 확인).

목표: 한 run에 **N개의 독립 데이터셋 바인딩**을 허용한다. 각 바인딩은 자기 데이터셋·정책(per_vu/iter_sequential/iter_random/unique)·매핑을 가지며, 서로 독립적으로 행을 고른다. 행 개수가 달라도 무관하다(각 데이터셋 커서가 독립 전진).

## 2. 비목표 (YAGNI)

- **행 정렬/zip/join** — N번째 행끼리 짝짓는 의미론. 사용자가 명시적으로 배제. 데이터셋 간 행개수 불일치 "감지/경고"도 불필요(독립이므로 불일치가 정상).
- **데이터셋 자동 네임스페이스** (`{{tracks.name}}`) — ADR-0014 평면 `{{var}}` 문법 유지. 변수명 충돌은 검증으로 거부(아래 §4.2).
- **cartesian product / cross-product 주입**.
- **마이그레이션·새 DB 테이블** — 바인딩은 `profile_json` serde에 산다(스키마 무변경, ADR-0013/8c 패턴).

## 3. 핵심 결정 (선택지 + 근거)

데이터를 워커로 흘려보내는 계층에서 셋을 검토:

1. **인덱스 기반 다중 바인딩 (채택)** — `RunAssignment`에 `repeated DataBinding`, `DatasetBatch`에 `binding_index`. 워커가 바인딩별 커서 `Vec`를 들고 각 데이터셋을 자기 정책으로 독립 전진. 임의 정책 조합 가능, 개수 무관. DB 마이그레이션 0.
2. **컨트롤러 사전 병합(cartesian/zip)** — ✗ `per_vu`/`unique`/`iter_random`은 런타임에 (vu_id, iter_id)별로 행을 고르므로 미리 평탄화 불가(cartesian은 폭발, unique 파티션 깨짐).
3. **단일 공유 정책으로 lockstep** — ✗ §2에서 배제한 zip 의미로 회귀 + 개수 다르면 인덱스 초과.

→ **1번 채택.**

**ADR:** 새 ADR 불필요 — ADR-0022(data-driven, 4정책 바인딩)의 **구조적 확장**(바인딩 1개 → N개 독립)이고 새 결정 축이 없다(평면 네임스페이스=ADR-0014, 독립 정책=기존 모델). ADR-0022 본문에 "N개 독립 바인딩 허용" 한 줄 보강은 가능(리뷰에서 판단).

## 4. 데이터 모델·검증

### 4.1 Profile 바인딩 필드 (back-compat)

`store/runs.rs`의 `Profile`에서:
- **신규** `data_bindings: Vec<DataBinding>` (`#[serde(default)]`).
- **레거시 유지** `data_binding: Option<DataBinding>` (`#[serde(default)]`) — DB의 옛 `profile_json`·저장된 프리셋이 이 키로 직렬화돼 있으므로 **읽기 호환용**으로 남긴다.
- **접근자** `Profile::data_bindings()` → 효과적 바인딩 목록 반환: `data_bindings`가 비어있지 않으면 그것을, 비었으면 레거시 `data_binding`을 1-원소로 fold. **모든 읽기 사이트가 이 접근자를 경유**한다(직접 필드 접근 금지). 신규 쓰기(UI·API)는 `data_bindings`만 채우고 `data_binding`은 `None`으로 둔다.
- 근거: `stages`/`vu_stages`를 Option 신규 필드 + `is_open_loop()` 접근자로 추가한 S-D 패턴과 동형. 마이그레이션 불필요(컨트롤러 CLAUDE.md "profile_json 새 필드는 serde default로 호환").

`DataBinding`(`binding.rs`)·`Mapping`·`BindingPolicy`·`apply_mappings`/`referenced_columns`는 **무변경** — 단일 바인딩의 의미는 그대로다.

### 4.2 검증 게이트 (`validate_run_config`, run-create + preset-save 공유)

현재 단일 `b`에 대한 검증 블록(`api/runs.rs:388–445`: 데이터셋 존재·비어있음·매핑 컬럼 존재·unique≥워커수·per-iteration 상한)을 **`data_bindings()`의 각 바인딩마다 루프**로 일반화. 반환 타입은 `Option<DatasetMeta>` → **`Vec<DatasetMeta>`** (TOCTOU 회피용 검증된 meta를 바인딩 순서대로; binding 없으면 빈 벡터). `spawn_run`이 이 벡터를 재사용.

**신규 교차-바인딩 검증** (한 run의 바인딩들끼리):
1. **변수명 중복 거부** — 모든 바인딩의 매핑이 산출하는 `var` 이름을 모아 중복이면 `400 BadRequest`: `"변수 '{name}'이 여러 데이터셋에 중복 매핑됨"`. 평면 네임스페이스라 충돌하면 마지막 주입이 앞을 덮어 비결정/혼동을 부르므로 기계적으로 차단.
2. **바인딩 개수 상한** — `data_bindings().len() > MAX_BINDINGS`(예 8)이면 400. proto/스트림·워커 메모리 폭주 방지. (값은 plan에서 const로.)

**허용(거부 안 함):**
- 같은 `dataset_id`를 두 번 바인딩 — 무해(서로 다른 변수명·정책으로 독립 추출 가능). 단 변수명 중복 규칙(1번)은 여전히 적용. **주의: 같은 데이터셋에 둘 다 unique를 걸면** 두 바인딩이 *각자* 카운터로 같은 데이터셋을 소비해 두 배 빨리 소진된다(서로 다른 변수명이면 같은 행을 다른 이름으로 노출 — 무해하나 비실용). 명시적으로 막진 않되 이 동작을 plan 주석/테스트에 1줄 기록.
- 빈 매핑 바인딩 — 현재도 허용(주입 0). 변경 없음.

**per-바인딩 검증은 독립**: unique 행수≥워커수, per-iteration 상한(`dataset_max_rows`), 빈 데이터셋 거부 — 전부 바인딩마다 따로 평가(데이터셋 개수가 달라도 각자 판정).

### 4.3 dataset DELETE soft-guard 갱신

데이터셋 삭제 시 참조 검사 두 곳이 `profile.data_binding` 단일을 본다 → **`data_bindings()` 순회**로 갱신:
- `store/runs.rs::dataset_in_use` (runs.rs:378, `data_binding` 읽기는 :385; 활성 run 참조 → hard 409)
- `store/presets.rs::referencing_dataset` (presets.rs:153, 읽기 :161, `Vec<PresetRef>` 반환; 프리셋 참조 → soft 409 + `?force=true`)

두 정책 모두 "어느 바인딩이든 이 dataset_id를 참조하면 매치"로 바꾼다.

## 5. proto 변경 (가산, co-deployed)

`crates/proto/proto/coordinator.proto`:
- `RunAssignment`: `DataBinding data_binding = 5` (단일) → **유지하되 신규** `repeated DataBinding data_bindings = 10` 추가. 신 컨트롤러는 `data_bindings`만 채우고 `data_binding`(field 5)은 비운다. (워커·컨트롤러 동시 배포라 field 5는 reserved-in-practice. 코드에선 신 워커가 `data_bindings`만 읽음.)
- `DatasetBatch`: `uint32 binding_index = 3` 추가 — 이 배치 행들이 몇 번째 바인딩 것인지. 단일 바인딩(기존) = index 0.

prost struct literal exhaustive 함정: `RunAssignment {...}`·`DatasetBatch {...}` 리터럴 사이트 전부 새 필드 명시 필요(컨트롤러·워커·proto 테스트 — `grep -rn "RunAssignment {\|DatasetBatch {" crates/`).

## 6. 컨트롤러 스트리밍 (`grpc/coordinator.rs`)

- `PendingDataBinding`·`PendingAssignment.data_binding: Option<PendingDataBinding>` (coordinator.rs:70) → **`data_bindings: Vec<PendingDataBinding>`**.
- `WorkerStream { dataset_id, mappings, offset, count }` → **`binding_index: u32` 추가**.
- `assignment_for` (253–300): 현재 단일 `binding`/`stream`을 만든다 → **바인딩마다 루프**로 `Vec<pb::DataBinding>`(per-worker sliced row_count) + `Vec<WorkerStream>`(각자 `binding_index`) 생성. unique는 바인딩별로 독립 `dataset_slice`(disjoint), 복제 정책은 whole. 반환 `(RunAssignment, Vec<WorkerStream>)`.
- 등록 핸들러 (684–722): `if let Some(ws) = &stream` 단일 스트림 → **`for ws in &streams`** 로 각 슬라이스 스트리밍(`stream_dataset`에 `binding_index` 전달).
- `stream_dataset` (757): `DatasetBatch`에 `binding_index: ws.binding_index` 실어 보냄. 나머지(범위 fetch·apply_mappings·incomplete→AbortRun) 무변경. 컨트롤러 CLAUDE.md "row_count 못 전달 시 drop(tx)로 못 닫음 → AbortRun" 불변식 유지(어느 바인딩이든 incomplete면 전체 run abort).

## 7. 엔진 (`crates/engine/src/runner.rs`, `dataset.rs`)

- `dataset.rs` `DataSet`/`select_index` **무변경** — 단일 데이터셋의 인덱싱 의미는 그대로다.
- `RunPlan.data_binding: Option<Arc<DataSet>>` → **`data_bindings: Vec<Arc<DataSet>>`** (runner.rs:57).
- **세 실행 경로 각각**(closed `run_vu`·vu-curve `run_vu_curve`·open-loop `run_arrival`)에서:
  - **카운터 셋업** (현재 단일 `seq_counter` ~128/674/1076): 바인딩마다 1개씩 → **`Vec<Option<Arc<AtomicU64>>>`**(그 바인딩 정책이 IterSequential|Unique면 Some, 아니면 None). 각 VU task에 `Vec` clone 전달.
  - **VU body 주입** (현재 `if let Some(ds)` ~348/981/1328): **각 바인딩을 순회** → `ds.select_index(vu_id, iter_id, counter_i)`로 행 인덱스 → `for (k,v) in &ds.rows[idx] { iter_vars.insert(k, v) }`. 변수명 충돌은 §4.2에서 이미 차단되어 merge 순서 무관.
  - **unique 소진(`None`) 처리 — 확정 의미론**: 현재 단일은 `None → break`(VU 깨끗이 완료, `failed`++ 없음). 다중에선 **바인딩을 선언 순서로 순회하며 `select_index`를 호출하고, 어느 unique 바인딩이 `None`을 반환하면 그 즉시 VU `while` 루프를 break**(그 iteration은 요청을 만들지 않고 주입도 버림). 의미: VU는 자기 *모든* unique 데이터셋에 줄 행이 남아있는 동안만 진행 → **가장 작은 unique 슬라이스가 소진되는 시점에 VU가 멈춘다**(자연스러운 AND 의미; "각 데이터셋에서 행을 하나씩 받아야 일을 한다"). 비-unique 정책은 항상 `Some`(`dataset.rs:48–58`, rows 비어있지 않음 보장)이라 spurious `None` 없음.
    - **카운터 부작용(문서화 필수)**: `select_index`는 `fetch_add`를 `None` 검사 *전에* 한다(`dataset.rs:50–63`). 따라서 break를 유발한 바인딩보다 **앞서 평가된** 공유 카운터(IterSequential)는 그 종료 iteration에서 한 칸 더 전진할 수 있다 — **VU당 1회, 끝에서 버려지는 증분**. 이는 deadline에 잘리는 부분 loop iteration(engine CLAUDE.md "loop body deadline")과 동급의 허용 가능한 경계 효과다. 회피하려면 peek/advance 분리로 `select_index` API를 바꿔야 하는데(더 침습적) v1 범위 밖 — break-on-first-None + 이 1줄 문서화로 간다. (rollback 불가: 공유 atomic이라 되돌릴 수 없음.)
- `vu_offset`(글로벌 vu_id, A3a)·think_time·deadline 등 나머지 로직 무변경.
- 엔진 CLAUDE.md "글로벌 vu_id는 identity-only(`% len`·seed mix·`${vu_id}`)" 불변식은 바인딩마다 그대로 성립.

## 8. 워커 (`crates/worker/src/main.rs`, `worker-core/src/client.rs`)

- 현재 `assignment.data_binding`(단일)으로 한 데이터셋을 `load_dataset(expected=row_count)`로 적재 → `Option<Arc<DataSet>>`.
- 다중: `assignment.data_bindings`를 순회하며 **각 바인딩의 행을 적재 → `Vec<Arc<DataSet>>`** 빌드. 정책 매핑(`pb::Policy::try_from` → engine `BindingPolicy`, unknown=`unreachable!`)은 바인딩마다 동일.
- `load_dataset` (client.rs:141): 현재 "총 expected_rows까지 DatasetBatch 드레인"(binding_index 필터 없음). **확정 시그니처(버킷 형태)**: 바인딩들의 expected count 슬라이스 `&[u64]`(인덱스=binding_index)를 받아 **binding_index별 버킷에 누적, 모든 바인딩이 각자 count에 도달할 때까지 드레인** → `Vec<Vec<BTreeMap<String,String>>>` 반환(바인딩별 행 벡터). 버킷 형태를 택한 이유: 배치가 `binding_index`로 태깅되므로 **스트림 순서에 무관**하게 견고(per-binding 순차-호출 루프는 컨트롤러의 `for ws in &streams` 순차 스트리밍 불변식에 의존해 더 취약 — 기각). 조기 stream close = **`DatasetIncomplete { got, expected }`**(error.rs:25) → Failed(기존 main.rs:162–178 경로), abort/cancel = `WorkerError::Cancelled` → 깨끗한 Aborted(기존 main.rs:144–160) — 둘 다 보존(어느 버킷이든 미완이면 동일 처리).
- 적재 단계는 여전히 `abort_listener`/`forwarder` spawn **이전**(기존 불변식, main.rs:118 주석).
- `RunPlan { data_bindings, .. }` 빌드(main.rs:197 `data_binding:` → `data_bindings:`).

## 9. UI (`ui/src/`)

- `schemas.ts`: `ProfileSchema`에 **`data_bindings: z.array(DataBindingSchema).optional()`** 추가. 레거시 `data_binding: DataBindingSchema.nullish()`는 읽기 호환으로 유지(서버가 옛 run/preset을 줄 수 있음). `DataBindingSchema`/`MappingSchema`/`BindingPolicyEnum` 무변경.
- `DataBindingPanel.tsx`: 현재 단일 바인딩(하나의 `selectedId`/`policy`/`rows`)을 편집 → **바인딩 목록 편집기**로 리팩터. 각 항목 = {데이터셋 선택 + 정책 + 매핑 행들}. "데이터셋 추가"/항목 제거. `onChange(bindings: DataBinding[])`, `onValidityChange(ok, reasons)`. 사용자 선호대로 **접이식 disclosure**(각 바인딩 카드) 유지.
  - 각 바인딩 항목에 **그 데이터셋의 행 개수 인라인 표시**(`useDataset(id).row_count`) — 사용자가 개수 차이를 한눈에 인지(경마장 10 / 사용자 5000). 강제 아님, 가시성만.
  - **변수명 충돌 클라 경고**: 둘 이상 바인딩이 같은 `var`를 매핑하면 `onValidityChange`로 막고 사유 표시(서버가 최종 거부 §4.2). 카탈로그 `ko.ts` 문구.
- **공유 페이로드 빌더 `profileForm.ts`** — `DataBindingPanel`의 산출을 Profile로 바꾸는 단일 소스다. `ProfileFormInput.binding: DataBinding | null`(profileForm.ts:123) → **`bindings: DataBinding[]`**, `buildProfile`(:129)이 `data_binding: i.binding ?? undefined`(:133) → **`data_bindings: i.bindings`** 로 쓰고 레거시 `data_binding` 키는 **생략**(신규 쓰기 = 새 키만). RunDialog·ScheduleForm 둘 다 이 빌더를 경유하므로 여기서 한 번 바꾼다.
- **`RunDialog.tsx`**: `binding: DataBinding | null` → **`bindings: DataBinding[]`**(state·`seedBinding`·`panelKey` 동반). 프리필(run/preset)은 `data_bindings ?? (data_binding ? [data_binding] : [])`로 효과적 목록 복원. validity 집계(`bindingBlock`)는 패널이 종합. `buildProfile` 호출에 `bindings` 전달.
- **`ScheduleForm.tsx`(필수 — 두 번째 소비처)**: `DataBindingPanel`을 RunDialog와 똑같이 마운트한다(ScheduleForm.tsx:22). 자체 `binding`/`seedBinding`/`panelKey`/`bindingBlock` state(170–184)도 **`bindings: DataBinding[]`** 로 동일 변경 + `buildProfile`(:234, 공유 `buildProfileShared`) 호출에 `bindings` 전달. **누락 시 스케줄러 경로가 조용히 단일 바인딩만 emit하고 UI 컴파일 실패** — RunDialog와 lockstep.
- 기타 소비처(ScenarioRunsPage·runPrefill·presets/schedule 테스트 등)에서 `data_binding`을 읽던 곳을 효과적-목록 헬퍼로 갱신.

## 10. 하위 호환·byte-identical

- **`data_bindings`가 비었고 레거시 `data_binding`이 None** → 데이터 주입 0, 기존과 byte-identical(proto field 5·10 둘 다 비고 워커 dataset=빈 Vec).
- **단일 바인딩**(가장 흔한 기존 시나리오) → `data_bindings`에 1개. 엔진 실행·메트릭·report **결과는 기존 단일 경로와 행동적으로 동일**(`binding_index=0`). 옛 DB run/preset은 레거시 `data_binding` 접근자 fold로 동일하게 재생. **단 와이어는 byte-identical 아님**: 신 컨트롤러가 단일 바인딩을 proto field 5 대신 field 10(`data_bindings`)으로 보낸다 — 컨트롤러+워커 동시 배포(옛 워커가 field 5를 읽는 일 없음)라 안전하지, 혼합 배포에선 안전하지 않다(이 repo는 항상 동반 배포, A3 모델). "byte-identical"은 **양쪽 바인딩 필드가 모두 빈 무바인딩 run에만** 성립.
- 마이그레이션 0, 새 테이블 0.

## 11. 테스트 전략

- **엔진**(`dataset.rs`/`runner.rs` 단위·통합): 2개 바인딩(서로 다른 정책·다른 행수)이 독립 전진하며 변수가 모두 주입되는지; unique 소진 시 VU 중단; 단일 바인딩 = 기존과 동일.
- **컨트롤러**(`api/runs.rs`/`coordinator.rs`): 변수명 중복 400; 바인딩 개수 상한 400; per-바인딩 unique/cap 검증 독립; `assignment_for`가 바인딩별 슬라이스(unique disjoint) 생성; dataset DELETE 가드가 다중 바인딩 참조 매치.
- **proto round-trip**: `RunAssignment.data_bindings`·`DatasetBatch.binding_index`.
- **워커**(`client.rs` `load_dataset`): binding_index별 버킷 드레인; 다중 바인딩 적재.
- **UI**(RTL): 패널 목록 추가/제거; 변수명 충돌 경고; 행개수 표시; RunDialog 다중 제출·프리필.
- **라이브 검증(필수, S-D 갭)**: 서로 다른 행수의 데이터셋 2개(예 racetracks 3행 iter_random + users 20행 unique)로 실제 run 1회 — 두 변수 모두 echo 서버 와이어에 주입 확인 + `ReportSchema.safeParse` strict 통과 + 콘솔 Zod 0. (`/live-verify` 스택: 워크트리 자체 바이너리 + echo responder + 격리 DB.)

## 12. 영향 파일 요약

| 계층 | 파일 | 변경 |
|---|---|---|
| proto | `coordinator.proto` | `repeated DataBinding data_bindings=10`, `DatasetBatch.binding_index=3` |
| engine | `runner.rs` | `RunPlan.data_bindings: Vec`, 3경로 카운터 Vec + VU body 순회 주입 |
| engine | `dataset.rs` | 무변경(인덱싱 의미 동일) |
| worker | `worker/src/main.rs`, `worker-core/src/client.rs` | N 데이터셋 적재, `load_dataset` binding_index 버킷 |
| controller | `store/runs.rs` | Profile `data_bindings`+`data_bindings()` 접근자, `dataset_in_use`(:385) 순회 |
| controller | `api/runs.rs` | `validate_run_config` 루프 + 교차검증(변수명 중복·개수 상한) → `Vec<DatasetMeta>`, `spawn_run` Vec 빌드 |
| controller | `grpc/coordinator.rs` | `PendingAssignment.data_bindings`, `WorkerStream.binding_index`, `assignment_for` 루프, 등록 핸들러 다중 스트림 |
| controller | `store/presets.rs` | `referencing_dataset`(:161) 참조 검사 순회 |
| UI | `schemas.ts`, `profileForm.ts`, `DataBindingPanel.tsx`, `RunDialog.tsx`, `ScheduleForm.tsx` (+소비처) | `data_bindings` 배열, 공유 빌더·두 폼 소비처, 패널 목록화, 충돌 경고·행개수 표시 |

**컴파일러-driven fan-out(plan이 예산 잡을 것, rustc가 전부 잡음)**:
- store `Profile {…}` 리터럴에 `data_bindings: vec![]` 추가 **~47곳**(라인 번호는 근사 — rustc가 missing-field로 전부 강제): `report.rs:741`, `schedule/runner.rs:~284`, `presets.rs:194`, `schedules.rs:~339`, `runs.rs`(~496/547/754), `api/runs.rs`(~1125/1194/1242/1293), `crash_recovery_test.rs`, `dispatcher_subprocess_test.rs`, `report_test.rs`, `export_routes_test.rs` 등. (직전 추정 ~18은 과소 — `cargo build --workspace --tests`로 0 에러까지.)
- engine `RunPlan {…}` 리터럴 `data_binding:` → `data_bindings:` ~19파일(엔진 테스트 전부 + 워커 + `main.rs` + `runner.rs`).
- proto `RunAssignment {…}`(`run_assignment_env_test.rs` 11/58)·`DatasetBatch {…}` 리터럴에 새 필드(prost exhaustive). AppState ~31곳 fan-out(controller CLAUDE.md)과 동급 규모 — 기능 변경 아닌 기계적 추가.

마이그레이션·ADR·새 엔진 인덱싱 로직: **없음**.

# store→proto 매핑 회귀 가드 — 설계

- 날짜: 2026-08-02
- 유형 태그: `internal-polish`
- 출처: error-taxonomy E3 연기 항목(`docs/build-log.md`, `crates/controller/CLAUDE.md` §매핑 함정) · `docs/roadmap-status.md` 영역 E "코드 후속 후보"
- 범위 결정(사용자 승인 2026-08-02): **양 끝단 Profile 매핑**(컨트롤러 + 워커), 데이터바인딩 제외

## 사용자 스토리 (US)

행위자는 `개발자-도구`(handicap 자체를 개발·운영 — `docs/dev/user-story-spine.md` 정본 4종 중 하나). 이 슬라이스는 프로덕션 거동을 바꾸지 않으므로 QA/운영자 US는 없다. 관찰 가능한 증거는 전부 **RED(테스트 실패) 또는 컴파일 에러**다.

- **US1**: 개발자-도구가 새 부하 노브를 store→proto→worker로 배선할 때, 한 홉에서 값을 빠뜨리거나 placeholder(`None`)를 남기면 — 전 스위트가 green인 채 머지되는 대신 `cargo nextest`가 **실패하고 실패 메시지가 그 필드를 가리키는 것**을 본다.
- **US2**: 개발자-도구가 `store::Profile` 또는 `pb::Profile`에 필드를 추가할 때, "이 값이 와이어로 가야 하는가"를 판단하지 않고 지나칠 수 없다 — **테스트가 컴파일되지 않아** 그 자리에서 결정을 강요받는 것을 본다.
- **US3**: 개발자-도구가 같은 타입 이웃 필드를 전치해도(`target_rps` ↔ `max_in_flight`, `stages` ↔ `vu_stages`, u32 4종) 컴파일러가 침묵하는 오늘과 달리 — **테스트가 실패하는 것**을 본다.

US1~US3의 성공 신호는 모두 "고의 회귀 → RED → 원복 → GREEN"으로 실증한다(§6).

## 1. 배경 — 왜 지금

`store::Profile`(DB에 영속된 run 설정)이 워커에 도달하려면 두 홉을 지난다.

```
UI → REST → store::Profile ──[A]──> pb::Profile ──gRPC──> pb::Profile ──[B]──> RunPlan → 엔진
```

- **[A]** `crates/controller/src/api/runs.rs:741` — `spawn_run`(330줄 async fn) 안 인라인 struct 리터럴. **프로덕션 유일 `pb::Profile` 생성 사이트**.
- **[B]** `crates/worker/src/lib.rs:234` — `execute_assignment`(360줄 async fn) 안 인라인 `RunPlan` 리터럴.

두 홉 **모두 단위 테스트가 0건**이다. 유일한 `PendingAssignment` 픽스처(`grpc/coordinator.rs:1916` `base_assignment()`)는 `pb::Profile`을 **직접** 지어 [A]를 통째로 우회한다.

E3(connect_timeout) 슬라이스에서 이 갭이 실제로 발화 직전까지 갔다: T1이 워커에, T2가 `api/runs.rs`에 각각 placeholder `None`을 심었고, T3가 둘 다 교체했다. **T3가 하나라도 놓쳤다면** UI 저장·`validate_run_config`·`GET /api/runs/{id}`·리포트가 전부 정상값을 보고하고 전 스위트가 green인 채로, 워커에만 값이 안 갔을 것이다.

`ReportJson.run.profile`은 **같은 DB 행의 재직렬화**라 영속 확인은 원리적으로 와이어를 증명하지 못한다(`crates/controller/CLAUDE.md` 기록). 오늘 이 두 홉을 지키는 유일한 수단은 슬라이스마다 사람이 도는 라이브 검증뿐이고, 그건 회귀 가드가 아니다.

### 1.1 컴파일러가 이미 막는 것 / 막지 못하는 것

두 리터럴 모두 `..Default::default()`를 쓰지 않는 **exhaustive 리터럴**이다(직접 확인). 따라서:

- ✅ **필드 누락**은 컴파일러가 이미 잡는다 — proto/RunPlan에 필드를 더하면 그 자리가 컴파일 에러다.
- ❌ **틀린 값**(placeholder `None`, 잘못된 소스 필드)은 못 잡는다 — E3에서 실제로 일어난 실패 모드.
- ❌ **필드 전치**는 못 잡는다 — 같은 타입 이웃끼리 바꿔 써도 컴파일이 통과한다:
  - `Option<u32>` 이웃: `think_seed` · `target_rps` · `max_in_flight` · `graceful_ramp_down_seconds` · `connect_timeout_seconds`
  - `u32` 이웃: `vus` · `ramp_up_seconds` · `duration_seconds` · `loop_breakdown_cap` · `http_timeout_seconds`
  - `Vec<Stage>` 이웃: `stages` ↔ `vu_stages`

**이 슬라이스가 겨냥하는 것은 아래 두 ❌다.** 산출물은 테스트 개수가 아니라, 조용히 죽는 경로를 **컴파일 에러 또는 RED로 바꾸는 것**이다.

## 2. 범위

### 2.1 대상

| 홉 | 함수 | 배치 |
|---|---|---|
| [A] | `to_proto_profile(p: &store::runs::Profile) -> pb::Profile` | **신규 모듈** `crates/controller/src/grpc/profile.rs` |
| [B] | `to_run_plan(profile: &pb::Profile, vu_count: u32, vu_offset: u32, env: BTreeMap<String, String>, data_bindings: Vec<Arc<DataSet>>) -> RunPlan` | `crates/worker/src/lib.rs` 기존 헬퍼 옆 |

필드 수(직접 카운트): `store::Profile` **20** 필드 → proto **15** 필드. 의도적 미매핑 **5**: `data_binding`·`data_bindings`(→ `PendingDataBinding` 경유), `criteria`(컨트롤러측 SLO 판정), `worker_count`(컨트롤러가 register 시 분할), `apply_scenario_think_time`(YAML strip으로 표현 — 워커는 strip된 YAML을 받는다).

### 2.2 비목표

- **데이터바인딩 매핑**(`PendingDataBinding` 생성 + `slot_count` 3분기: `vu_curve_max` / `max_in_flight` / `vus`) — 같은 `spawn_run` 블록에 있고 역시 무테스트지만 관심사가 다르다(데이터셋 행 배분 ≠ 부하 노브 배선). **build-log 연기 항목으로 기록**한다.
- **`reduce_pool_profile`** — 이미 테스트가 있다(`coordinator.rs:2955` 등).
- **크로스-크레이트 라운드트립 단위 테스트**(`store::Profile → pb::Profile → RunPlan`을 한 테스트에서 단언) — `handicap-controller`와 `handicap-worker`는 형제 크레이트로 **서로 의존하지 않는다**(직접 확인). dev-dependency 간선을 새로 그으면 axum/sqlx/kube 전체가 워커 테스트 빌드로 끌려와 pre-commit 게이트가 무거워진다. 대신 양쪽이 **필드마다 서로 다른 sentinel 값**을 쓰게 해 전치를 잡는다(§4 C1).
- **`base_assignment()` 픽스처 변경** — 그 테스트들의 관심사는 샤딩 로직이다. `store::Profile`에 결합시키면 노이즈만 는다. 그대로 둔다.
- **프로덕션 거동 변경 0** · UI 0-diff · migration 0 · `.proto` 0-diff.

## 3. 설계 — 구조

### 3.1 컨트롤러: `crates/controller/src/grpc/profile.rs` (신규)

`api/runs.rs:741`의 리터럴을 **표현식 그대로** 함수 본문으로 옮기고, 호출부는 한 줄로 대체한다.

```rust
profile: crate::grpc::profile::to_proto_profile(profile),
```

`spawn_run`의 바인딩이 이미 `profile: &Profile`이므로(직접 확인) 시그니처가 그대로 맞는다.

**배치 근거**
- **왜 `grpc/`**: 매핑은 와이어 관심사이고, 소비자(`PendingAssignment`)와 형제 변환(`reduce_pool_profile`)이 이미 `grpc/`에 산다. `grpc/shard.rs`(315줄, 순수함수 + `#[cfg(test)]`)가 정확한 선례다.
- **왜 `store/runs.rs`의 `impl Profile`이 아닌가**: `store/`는 proto를 **전혀** 참조하지 않는다(0건, 직접 확인). 영속 계층이 와이어 포맷을 모르는 경계이고, 한 번 깨면 되돌리기 어렵다.
- **왜 `api/runs.rs`가 아닌가**: 이미 2814줄이고 HTTP 핸들러 모듈이다.
- **발견성 우려 없음**: proto 리터럴이 exhaustive라, 필드를 추가하면 **컴파일러가 새 위치를 가리킨다**.

`grpc/mod.rs`에 `pub mod profile;` 한 줄 추가.

### 3.2 워커: `crates/worker/src/lib.rs`

`RunPlan` 리터럴(234–301)을 `to_run_plan`으로 옮긴다. 별도 모듈로 빼지 않는 이유: `lib.rs`는 1016줄로 아직 작고, 짝이 되는 헬퍼 4종(`proto_is_open_loop`·`proto_is_vu_curve`·`proto_graceful_ramp_down`·`proto_connect_timeout`)이 이미 거기 산다.

**시그니처는 `&pb::Profile`(값 아님).** 리터럴 **뒤**인 `lib.rs:305`에서 `info!(ramp_up_s = profile.ramp_up_seconds, …)`가 `profile`을 다시 읽기 때문이다(직접 확인). 참조로 받으면 호출부가 무손상이다. 함수 안에서 `profile.think_time`은 `Copy`/`Clone`으로 처리한다(오늘의 partial move가 사라진다).

**부수 효과(의도된 정리)**: 오늘 `lib.rs:229–232`의 서문 —

> `Capture predicates BEFORE the RunPlan build — partial field moves (profile.think_time) in the struct literal below make &profile invalid after.`

— 는 순전히 리터럴이 인라인이라 존재한다. 추출 후 `graceful_ramp_down`·`connect_timeout` 사전계산은 함수 **안으로** 들어가고, 밖에 남는 `is_open_loop`·`is_vu_curve`는 리터럴 *뒤* 실행경로 선택(`lib.rs`의 `if is_vu_curve … else if is_open_loop …`)에 실제로 쓰이므로 **진짜 이유로** 남는다. 주석을 그 사실에 맞게 정정한다(스테일 주석을 남기지 않는다).

### 3.3 프로덕션 거동

두 추출 모두 **표현식 이동뿐**이다. 값·타입·순서·에러 경로가 전부 동일하므로 거동 0-diff다.

## 4. 설계 — 테스트

### 4.1 3중 강제 장치 (핵심 산출물)

| # | 장치 | 미래에 필드가 추가되면 |
|---|---|---|
| ① | 입력 픽스처를 `..Default::default()` **없이 전 필드 명시**(`store::Profile` 20 / `pb::Profile` 15) | **테스트 컴파일 에러** → 작성자가 "이 값이 와이어로 가나?"를 그 자리에서 판단 |
| ② | 컨트롤러 기대값을 `pb::Profile` **exhaustive 리터럴**로 두고 통째 `assert_eq!` (`pb::Profile`은 `derive(Clone, PartialEq, ::prost::Message)` — 직접 확인) | 기대 리터럴 컴파일 에러 |
| ③ | 워커는 `let RunPlan { vus, ramp_up, …, connect_timeout } = plan;` — **`..` 없는 전 필드 구조분해** 후 필드별 단언 | 구조분해 패턴 컴파일 에러 |

③이 통째 비교가 아닌 이유: `RunPlan`은 `derive(Debug, Clone)`뿐이고 `PartialEq`가 없다. 필드에 `Vec<Arc<DataSet>>`가 있어 `PartialEq`를 파생하려면 `DataSet`(현재 `derive(Debug)`만)까지 손대야 한다 — **테스트를 위해 엔진 프로덕션 타입에 derive를 더하지 않는다**. 전 필드 구조분해가 derive 없이 같은 강제 효과를 준다. 구조분해한 바인딩은 전부 단언한다(안 하면 `unused_variables` → `-D warnings` 실패).

**②의 한계(정직하게 기록)**: `pb::Profile`은 prost가 `Default`를 파생하므로, 미래 작성자가 컴파일 에러를 만나 기대 리터럴에 `..Default::default()`를 덧붙이면 ②의 강제력이 사라진다. 픽스처 위에 **금지 주석**을 단다. 반면 ①의 `store::Profile`은 `Default`를 파생하지 않아(직접 확인) 그 탈출구가 타입 레벨에서 닫혀 있다.

### 4.2 케이스

**C1 — 전 필드 sentinel (전치·placeholder 잡기)**
`store::Profile`(및 워커의 `pb::Profile`) 픽스처를 **필드마다 서로 다른 값**으로 채운다: `vus=11, ramp_up=22, duration=33, loop_cap=44, http_timeout=55, think_time={66,77}, think_seed=88, target_rps=99, max_in_flight=111, stages=[{122,133}], measure_phases=true, vu_stages=[{144,155}], ramp_down=Immediate, graceful=166, connect_timeout=177`. §1.1의 전치가 하나라도 일어나면 이 테스트가 실패한다 — 오늘 이걸 잡는 방어는 하나도 없다. (구체 숫자는 plan에서 확정하되, **어떤 두 필드도 같은 값을 갖지 않는다**는 성질이 요구사항이다.)

**C2 — 부재/기본 (변환 규칙의 반대 방향)**
전부 `None`/빈 값 → `stages: vec![]`, `vu_stages: vec![]`, `think_time: None`, `ramp_down_immediate: false`, optional 전부 `None`. `stages: Some(vec![])`도 `vec![]`로 매핑됨을 확인한다(빈 Vec ≡ 부재 규약, `is_open_loop`/`is_vu_curve` 판별과 일관).

**C3 — `ramp_down` 3상태**
`None` → `false`, `Some(Graceful)` → `false`, `Some(Immediate)` → `true`. C1이 `Immediate`를, C2가 `None`을 덮으므로 `Some(Graceful)` 1건을 추가한다.

**C4 — 워커 `http_timeout` 0-폴백**
`http_timeout_seconds == 0` → `Duration::from_secs(30)`(구 컨트롤러 호환 규칙). 현재 무테스트다. `!= 0`은 C1이 덮는다.

### 4.3 이미 테스트된 것과의 관계

워커의 헬퍼 4종과 `run_duration_secs`는 이미 단위 테스트가 있다(`lib.rs:773`~). 이 슬라이스는 그것들을 다시 테스트하지 않고, **조립부**(어느 헬퍼 결과가 어느 `RunPlan` 필드로 가는가)를 덮는다.

## 5. 완료 정의

- `to_proto_profile` / `to_run_plan` 추출 완료, 두 인라인 리터럴 소멸, 호출부 각 1줄.
- C1~C4 통과, §4.1 ①②③ 3중 장치 전부 배치.
- `lib.rs:229–232` 서문이 추출 후 사실에 맞게 정정됨.
- 게이트 green: `cargo fmt --check` · `cargo build --workspace` · `cargo clippy -D warnings` · `cargo nextest` · doctest.
- 프로덕션 거동 0-diff (UI/migration/`.proto` 0-diff).

## 6. 검증 — 이빨 실증 (필수)

`docs/dev/subagent-dispatch.md`·[[plan-mandated-vacuous-tests]] 규율: **회귀 가드를 표방하는 테스트는 이빨을 실증해야 한다.** plan은 각 항목을 독립 스텝으로 명시하고, 각각 *고의 회귀 → RED 확인 → 원복 → GREEN 확인*을 실행한다.

| # | 고의 회귀 | 겨냥 | US |
|---|---|---|---|
| R1 | `to_proto_profile`에서 `connect_timeout_seconds: None` 하드코딩 | E3 실제 사고 재현 | US1 |
| R2 | `target_rps` ↔ `max_in_flight` 전치 | `Option<u32>` 이웃 전치 | US3 |
| R3 | `stages` ↔ `vu_stages` 전치 | `Vec<Stage>` 이웃 전치 | US3 |
| R4 | 워커 `http_timeout` 0-폴백 제거(`profile.http_timeout_seconds` 직결) | C4 | US1 |
| R5 | `store::Profile`에 더미 필드 1개 추가 | ①의 강제력 — **테스트가 컴파일되지 않음**을 확인 | US2 |

R5는 RED가 아니라 **컴파일 에러**가 통과 신호다(단언 실패와 다른 종류의 증거이므로 별도로 실증한다).

### 6.1 라이브 검증

**불필요**(프로덕션 diff 0 — 추출은 표현식 이동, 나머지는 테스트). CLAUDE.md 파이프라인 5단계의 "production diff 0이면 생략 + 근거를 build-log에" 경로를 따른다. 다만 추출이 정말 0-diff인지는 §6의 R1~R4가 간접 증명한다(회귀를 넣으면 RED, 원복하면 GREEN).

## 7. 알려진 한계

- **홉 사이는 여전히 규약으로만 이어진다.** 크레이트 간선이 없어 `store::Profile → RunPlan`을 한 테스트로 잇지 못한다(§2.2). 양쪽이 각자 `pb::Profile`을 기준으로 정확하면 전체가 정확하다는 것은 **추론**이지 단언이 아니다. proto 필드 하나의 *의미*를 양쪽이 다르게 해석하는 결함은 이 설계가 잡지 못한다(라이브 검증만 잡는다 — E3의 `connect_timeout` vs `timeout` kind 갈림이 그 예).
- **②의 탈출구**(§4.1) — prost `Default` 파생으로 기대 리터럴에 `..Default::default()`를 덧붙일 수 있다. 주석으로만 막는다.
- **데이터바인딩 매핑은 여전히 무테스트**(§2.2) — 연기 항목.

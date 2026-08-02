# store→proto 매핑 회귀 가드 — 설계

- 날짜: 2026-08-02
- 유형 태그: `internal-polish`
- 출처: error-taxonomy E3 연기 항목(`docs/build-log.md:677`, `crates/controller/CLAUDE.md` §매핑 함정) · `docs/roadmap-status.md` 영역 E "코드 후속 후보"
- 범위 결정(사용자 승인 2026-08-02): **양 끝단 Profile 매핑**(컨트롤러 + 워커), 데이터바인딩 제외

## 사용자 스토리 (US)

행위자는 `개발자-도구`(handicap 자체를 개발·운영 — `docs/dev/user-story-spine.md` 정본 4종 중 하나). 이 슬라이스는 프로덕션 거동을 바꾸지 않으므로 QA/운영자 US는 없다. 관찰 가능한 증거는 전부 **RED(테스트 실패) 또는 컴파일 에러**다.

- **US1**: 개발자-도구가 새 부하 노브를 store→proto→worker로 배선할 때, 한 홉에서 값을 빠뜨리거나 placeholder(`None`)를 남기면 — 전 스위트가 green인 채 머지되는 대신 `cargo nextest`가 **실패하고, 실패 메시지가 어느 필드인지 지목하는 것**을 본다.
- **US2**: 개발자-도구가 `store::Profile` 또는 `pb::Profile`에 필드를 추가할 때, "이 값이 와이어로 가야 하는가"를 판단하지 않고 지나칠 수 없다 — **매핑 단언 바로 옆에서 테스트가 컴파일되지 않아** 그 자리에서 결정을 강요받는 것을 본다.
- **US3**: 개발자-도구가 같은 타입 이웃 필드를 전치해도(`target_rps` ↔ `max_in_flight`, `stages` ↔ `vu_stages`, u32/bool 그룹) 컴파일러가 침묵하는 오늘과 달리 — **테스트가 실패하는 것**을 본다.

US1~US3의 성공 신호는 모두 "고의 회귀 → RED → 원복 → GREEN"으로 실증한다(§6).

## 1. 배경 — 왜 지금

`store::Profile`(DB에 영속된 run 설정)이 워커에 도달하려면 두 홉을 지난다.

```
UI → REST → store::Profile ──[A]──> pb::Profile ──gRPC──> pb::Profile ──[B]──> RunPlan → 엔진
```

- **[A]** `crates/controller/src/api/runs.rs:741` — `spawn_run`(651–979) 안 인라인 struct 리터럴. **프로덕션 유일 `pb::Profile` 생성 사이트**(나머지 `pb::Profile {`는 전부 `#[cfg(test)]` 안).
- **[B]** `crates/worker/src/lib.rs:234–301` — `execute_assignment`(127–487) 안 인라인 `RunPlan` 리터럴.

두 홉 **모두 단위 테스트가 0건**이다. 유일한 `PendingAssignment` 픽스처(`grpc/coordinator.rs:1916` `base_assignment()`)는 `pb::Profile`을 **직접** 지어 [A]를 통째로 우회한다.

E3(connect_timeout) 슬라이스에서 이 갭이 발화 직전까지 갔다: T1이 워커에, T2가 `api/runs.rs`에 각각 placeholder `None`을 심었고 T3가 둘 다 교체했다. **T3가 하나라도 놓쳤다면** UI 저장·`validate_run_config`·`GET /api/runs/{id}`·리포트가 전부 정상값을 보고하고 전 스위트가 green인 채로, 워커에만 값이 안 갔을 것이다. `ReportJson.run.profile`은 **같은 DB 행의 재직렬화**라 영속 확인은 원리적으로 와이어를 증명하지 못한다(`crates/controller/CLAUDE.md` 기록).

### 1.1 오늘 이 두 홉을 지키는 것 (정확히)

"라이브 검증뿐"이 아니다. 자동 커버가 **부분적으로** 존재한다. 실제 워커 바이너리를 빌드·spawn하는 컨트롤러 테스트는 **6개 파일**이다(`e2e_test.rs` · `pool_e2e.rs` · `pool_capacity_guard_test.rs` · `multi_worker_fanout_e2e.rs` · `pool_vu_curve_capacity_test.rs` · `pool_open_loop_capacity_test.rs` — 전부 `#[ignore]` 0건이라 **정규 게이트에서 돈다**). 이들은 `POST /api/runs` → `spawn_run` → gRPC → `RunPlan` → 엔진 → wiremock을 관통한다(`full_slice_1_e2e:65`, `loop_breakdown_e2e:756` — `:747` 주석에 "RunDialog cap → profile → proto → engine Aggregator" 명시).

**그러나 어떤 e2e도 Profile 필드의 *값*을 단언하지 않는다.** 전부 거동 단언이고, 대부분 전치에 둔감하다:

- `loop_breakdown_e2e`는 `loop_breakdown_cap: 256`을 보내지만(`:846`) 단언은 "overflow 버킷 없음(repeat=3 < cap)"(`:947–954`)이라 **cap이 30으로 전치돼도 통과**한다.
- 가장 날카로운 것도 값이 아니라 존재 단언이다 — `phase_breakdown_report_e2e_smoke`(`:2489`)가 `measure_phases: true`(`:2584`)로 run을 만들고 `steps[0].download`의 **존재**를 단언한다(`:2651`).
- 페이로드에 아예 등장하지 않는 필드도 있다(테스트 디렉토리 전수 키 grep): `http_timeout_seconds` · `think_time` · `think_seed` · `graceful_ramp_down_seconds` · `connect_timeout_seconds` **0건**. `ramp_up_seconds`는 등장하지만 **실 워커 e2e 페이로드에선 값이 전부 `0`**(기본값)이라 판별력이 없다(유일한 비-0은 `presets_api_test.rs:70`의 `1`인데 프리셋 REST 왕복이라 와이어를 타지 않는다).
- `vus`는 특수하다 — **`pb::Profile.vus`를 읽는 프로덕션 코드가 아예 없다**(직접 확인: 워커는 `RunPlan.vus = assignment.vu_count`(`lib.rs:235`)만 쓰고, `coordinator.rs`의 `.vus` 히트 0건, `vu_count`는 `shard_split(rw.total_vus, …)`(`coordinator.rs:761–763`)에서 오며 `total_vus`는 **store** 프로필로 계산된다(`runs.rs:800–806`)). 오늘은 write-only 와이어 필드라 e2e가 관측할 수 없다.

→ **이 슬라이스의 겨냥 집합은 proto 15필드 전부다.** e2e 유무로 필드를 등급화해 범위를 좁히지 않는다(그 등급은 유지 비용만 크고, 어차피 값 단언이 0이라 겨냥 집합을 줄이지 못한다). e2e의 역할은 §6.1에서 **라이브 검증 생략 근거**로 쓰이는 것이다 — "추출이 두 경로를 깨뜨리면 게이트가 먼저 실패한다"는 결선 보증이지, 필드 값 보증이 아니다.

### 1.2 컴파일러가 이미 막는 것 / 막지 못하는 것

두 리터럴 모두 `..Default::default()`를 쓰지 않는 **exhaustive 리터럴**이다(직접 확인). 따라서:

- ✅ **필드 누락**은 컴파일러가 이미 잡는다 — proto/RunPlan에 필드를 더하면 그 자리가 컴파일 에러다.
- ❌ **틀린 값**(placeholder `None`, 잘못된 소스 필드)은 못 잡는다 — E3의 실제 실패 모드.
- ❌ **필드 전치**는 못 잡는다 — 같은 타입 이웃끼리 바꿔 써도 컴파일이 통과한다.

**전치 가능 그룹 전수** (이 목록이 §4.2 C1의 sentinel 설계를 지배한다):

| 위치 | 타입 | 이웃 |
|---|---|---|
| store→proto 입력 | `u32` | `vus` · `ramp_up_seconds` · `duration_seconds` · `loop_breakdown_cap` · `http_timeout_seconds` |
| store→proto 입력 | `Option<u32>` | `think_seed` · `target_rps` · `max_in_flight` · `graceful_ramp_down_seconds` · `connect_timeout_seconds` · **`worker_count`**(미매핑이지만 소스로 오용 가능) |
| store→proto 입력 | `bool` | `measure_phases` · **`apply_scenario_think_time`**(미매핑이지만 소스로 오용 가능) |
| proto 출력 | `bool` | `measure_phases` · `ramp_down_immediate` |
| 양쪽 | `Vec<Stage>` / `Option<Vec<Stage>>` | `stages` ↔ `vu_stages` |
| 중첩 struct | — | `ThinkTime{min_ms, max_ms}` · `Stage{target, duration_seconds}` (필드 순서 전치가 컴파일-클린) |
| proto→RunPlan | `u32` | `vus`(=`vu_count`) · `vu_offset` (**둘 다 `assignment` 출처**) · `loop_breakdown_cap` |
| proto→RunPlan | `Duration` | `ramp_up` · `duration` · `http_timeout` |
| proto→RunPlan | `Option<Duration>` | `graceful_ramp_down` · `connect_timeout` |
| proto→RunPlan | `Option<u32>` | `think_seed` · `target_rps` · `max_in_flight` |
| proto→RunPlan | `Option<Vec<Stage>>` | `stages` · `vu_stages` |

**이 슬라이스가 겨냥하는 것은 위 두 ❌다.** 산출물은 테스트 개수가 아니라, 조용히 죽는 경로를 **컴파일 에러 또는 RED로 바꾸는 것**이다.

## 2. 범위

### 2.1 대상

| 홉 | 함수 | 배치 | 가시성 |
|---|---|---|---|
| [A] | `to_proto_profile(p: &store::runs::Profile) -> pb::Profile` | **신규 모듈** `crates/controller/src/grpc/profile.rs` | `pub(crate)` |
| [B] | `to_run_plan(profile: &pb::Profile, vu_count: u32, vu_offset: u32, env: BTreeMap<String, String>, data_bindings: Vec<Arc<DataSet>>) -> RunPlan` | `crates/worker/src/lib.rs` 기존 헬퍼 옆 | 크레이트-사설(`fn`) |

**혼합 소유권의 이유**(표에 근거를 남긴다): `env`·`data_bindings`는 리터럴 이후 사용되지 않으므로 값으로 받는다. `profile`만 참조인 것은 `lib.rs:305`의 `info!(ramp_up_s = profile.ramp_up_seconds, …)`가 리터럴 **뒤에서** `profile`을 다시 읽기 때문이다. 값으로 받는 대안도 컴파일은 가능하다(로그를 `plan.ramp_up.as_secs()`로 바꾸면 되고, `plan.vus`·`plan.duration.as_secs()`가 이미 그 이디엄이다). 그럼에도 참조를 택하는 이유는 **호출부 무손상**(로그 필드 타입 `u32` 보존, 프로덕션 diff 최소)이다.

필드 수(직접 카운트): `store::Profile` **20** 필드 → proto **15** 필드. 의도적 미매핑 **5**: `data_binding`·`data_bindings`(→ `PendingDataBinding` 경유), `criteria`(컨트롤러측 SLO 판정), `worker_count`(컨트롤러가 register 시 분할), `apply_scenario_think_time`(YAML strip으로 표현 — 워커는 strip된 YAML을 받는다).

### 2.2 비목표

- **데이터바인딩 매핑**(`PendingDataBinding` 생성 + `slot_count` 3분기: `vu_curve_max` / `max_in_flight` / `vus`) — 같은 `spawn_run` 블록에 있고 역시 무테스트지만 관심사가 다르다(데이터셋 행 배분 ≠ 부하 노브 배선). **build-log 연기 항목으로 기록**한다.
- **`reduce_pool_profile`** — 이미 테스트가 있다(`coordinator.rs:2955` 등, 호출 15+곳).
- **크로스-크레이트 라운드트립 단위 테스트**(`store::Profile → pb::Profile → RunPlan`을 한 테스트에서 단언) — **기술적으로는 가능하다.** `crates/controller/Cargo.toml:54`가 이미 `handicap-worker`를 optional 의존(`bundle` 피처, ADR-0042)으로 갖고 있어 사이클이 없고, `[dev-dependencies]`로 승격하면 controller 테스트에서 워커 함수를 직접 부를 수 있다. 그럼에도 **채택하지 않는다**:
  1. **한계 값이 낮다.** prost가 양쪽에 **같은 이름의 필드**를 생성하므로, 두 per-side 표 테스트가 각각 정확하면 사이에서 조용히 어긋날 번역 층이 없다. 라운드트립이 추가로 잡는 것은 사실상 "값이 도중에 `None`이 됐다"인데, 그건 어느 홉에 심기든 해당 홉의 표 테스트가 이미 잡는다.
  2. **잔여 위험을 못 없앤다.** 진짜 잔여 위험은 "같은 작성자가 양쪽 기대값을 쓴다"는 편향인데(§7), 라운드트립도 기대 `RunPlan`을 그 작성자가 쓰므로 그대로 남는다.
  3. **이미 더 강한 링크가 있다.** `e2e_test.rs`가 실제 워커 바이너리를 spawn해 체인을 관통한다(§1.1) — 라운드트립 단위 테스트보다 강한 결합 증거이고, 정규 게이트에서 돈다.
  4. 대가로 `to_run_plan`을 `pub`으로 열고 새 크레이트 간선을 상시화해야 한다 — 테스트 전용 이득에 비해 영구적이다.

  → 대신 양쪽이 **필드마다 서로 다른 sentinel 값**을 쓰게 해 전치를 잡는다(§4.2 C1).
- **`base_assignment()` 픽스처 변경** — 그 테스트들의 관심사는 샤딩 로직이다. `store::Profile`에 결합시키면 노이즈만 는다. 그대로 둔다.
- **프로덕션 거동 변경 0** · UI 0-diff · migration 0 · `.proto` 0-diff.

## 3. 설계 — 구조

### 3.1 컨트롤러: `crates/controller/src/grpc/profile.rs` (신규)

`api/runs.rs:741`의 리터럴을 **표현식 그대로** 함수 본문으로 옮기고, 호출부는 한 줄로 대체한다.

```rust
profile: crate::grpc::profile::to_proto_profile(profile),
```

`spawn_run`의 바인딩이 이미 `profile: &Profile`이므로(`runs.rs:654`) 시그니처가 그대로 맞는다. `grpc/mod.rs`에 `pub mod profile;` 한 줄 추가.

**배치 근거**
- **왜 `grpc/`**: 매핑은 와이어 관심사이고, 소비자(`PendingAssignment`)와 형제 변환(`reduce_pool_profile`)이 이미 `grpc/`에 산다. `grpc/shard.rs`(315줄, 순수함수 + `#[cfg(test)]:154`)가 정확한 선례다.
- **왜 `store/runs.rs`의 `impl Profile`이 아닌가**: `store/`는 proto를 **전혀** 참조하지 않는다(0건, 직접 확인). 영속 계층이 와이어 포맷을 모르는 경계이고, 한 번 깨면 되돌리기 어렵다.
- **왜 `api/runs.rs`가 아닌가**: 이미 2814줄이고 HTTP 핸들러 모듈이다.
- **발견성 우려 없음**: proto 리터럴이 exhaustive라, 필드를 추가하면 **컴파일러가 새 위치를 가리킨다**.

### 3.2 워커: `crates/worker/src/lib.rs`

`RunPlan` 리터럴(234–301)을 `to_run_plan`으로 옮긴다. 별도 모듈로 빼지 않는 이유: `lib.rs`는 1016줄로 아직 작고, 짝이 되는 헬퍼 4종(`proto_is_open_loop`·`proto_is_vu_curve`·`proto_graceful_ramp_down`·`proto_connect_timeout`)이 이미 거기 산다.

**스테일 주석 처리 — 정정이 아니라 삭제.** `lib.rs:227–228`의 서문 —

> `Capture predicates BEFORE the RunPlan build — partial field moves (profile.think_time) in the struct literal below make &profile invalid after.`

— 은 **오늘 이미 거짓이다.** `pb::ThinkTime`이 `#[derive(Clone, Copy, PartialEq, ::prost::Message)]`라 `Option<ThinkTime>: Copy`이고, 리터럴의 나머지 읽기는 전부 Copy 스칼라이거나 `.is_empty()`/`.iter()` 차용이다 → partial move는 일어나지 않는다. 추출 후에는 `graceful_ramp_down`·`connect_timeout` 계산이 함수 **안으로** 들어가고, 남는 `is_open_loop`·`is_vu_curve`는 `lib.rs:438/440`(`let run_res = if is_vu_curve { … } else if is_open_loop {`)에서 쓰이는 **평범한 지역 변수**가 된다. 위치를 강제하는 제약이 아예 없으므로 **주석을 삭제한다**(두 번째 스테일 주석을 만들지 않는다). 바인딩 위치는 그대로 둔다 — 아래로 옮기는 건 이득 없는 churn이다.

### 3.3 프로덕션 거동

두 추출 모두 **표현식 이동뿐**이다. 값·타입·순서·에러 경로가 전부 동일하므로 거동 0-diff다.

## 4. 설계 — 테스트

### 4.1 3중 강제 장치 (핵심 산출물)

| # | 장치 | 미래에 필드가 추가되면 |
|---|---|---|
| ① | 입력 픽스처를 `..Default::default()` **없이 전 필드 명시**(`store::Profile` 20 / `pb::Profile` 15) | **매핑 단언 옆에서** 컴파일 에러 |
| ② | 컨트롤러 기대값을 `pb::Profile` **exhaustive 리터럴**로 두고 통째 `assert_eq!` (`pb::Profile`은 `derive(Clone, PartialEq, ::prost::Message)` — 직접 확인) **+ 필드별 단언 병행**(US1의 "필드 지목") | 기대 리터럴 컴파일 에러 |
| ③ | 워커는 `let RunPlan { vus, ramp_up, …, connect_timeout } = plan;` — **`..` 없는 전 필드 구조분해** 후 필드별 단언 | 구조분해 패턴 컴파일 에러 |

③이 통째 비교가 아닌 이유: `RunPlan`은 `derive(Debug, Clone)`뿐이고 `PartialEq`가 없다. 필드에 `Vec<Arc<DataSet>>`가 있어 `PartialEq`를 파생하려면 `DataSet`(`engine/src/dataset.rs:26`, `derive(Debug)`만)까지 손대야 한다 — **테스트를 위해 엔진 프로덕션 타입에 derive를 더하지 않는다**. 구조분해한 바인딩은 전부 단언한다(안 하면 `unused_variables` → `-D warnings` 실패; `Justfile:14`·`.githooks/pre-commit:151`이 `--all-targets`라 테스트 타깃에도 적용된다). `data_bindings: Vec<Arc<DataSet>>`는 `assert_eq!`가 불가하므로 **`.len()` + `Arc::ptr_eq`로 동일 인스턴스 통과를 단언**한다.

**②에 필드별 단언을 병행하는 이유**: 15필드 통째 `assert_eq!`의 실패 출력은 좌/우 구조체 전문이라 "어느 필드"를 지목하지 못한다(pretty_assertions 미도입). US1이 약속한 관찰(“실패 메시지가 필드를 지목”)을 만족시키려면 필드별 단언이 필요하다. exhaustive 리터럴은 **컴파일 강제용으로 유지**한다 — 둘은 역할이 다르다.

**①의 강제력 등급(정직하게 구분)**:
- **기존 필드의 회귀** → mechanical gate. 값이 틀리면 RED.
- **신규 필드** → prompt이지 gate가 아니다. 작성자가 입력 픽스처와 기대값을 **둘 다** 쓰므로, 양쪽에 같은 placeholder를 복사하면 green이 된다. ①이 보장하는 것은 "작성자가 그 필드를 **보게** 된다"까지다.
- **②의 탈출구**: `pb::Profile`은 prost가 `Default`를 파생하므로 기대 리터럴에 `..Default::default()`를 덧붙이면 ②의 강제력이 사라진다. 픽스처 위에 **금지 주석**을 단다. 반면 ①의 `store::Profile`은 `Default`를 파생하지 않아(직접 확인) 그 탈출구가 타입 레벨에서 닫혀 있다.

### 4.2 케이스

**케이스 × 홉 배정** (이 표가 없으면 C2·C3가 컨트롤러 전용으로 읽혀 워커측 구멍이 남는다 — 아래 ⚠ 참조):

| 케이스 | 컨트롤러 `to_proto_profile` | 워커 `to_run_plan` |
|---|---|---|
| C1 전 필드 sentinel | ✅ | ✅ |
| C2 부재/기본 | ✅ | ✅ |
| C3 ramp_down 상태 | ✅ (`Option<RampDown>` 3상태) | ✅ (`ramp_down_immediate` **2상태**) |
| C4 http_timeout 0-폴백 | — (해당 없음) | ✅ |

⚠ **워커측 `ramp_down_immediate = true` 경로를 반드시 덮을 것.** C1·C2가 둘 다 `false`(→ `RampDown::Graceful`)이므로, C3를 컨트롤러 전용으로 읽으면 워커의 `ramp_down: if profile.ramp_down_immediate { Immediate } else { Graceful }`(`lib.rs:291–295`)에서 **`Graceful` 하드코딩 회귀가 전 케이스를 통과한다** — 이 슬라이스가 겨냥하는 placeholder 실패 모드 그 자체다. C3의 워커측은 `ramp_down_immediate: true` → `RampDown::Immediate`를 단언한다.

**C1 — 전 필드 sentinel (전치·placeholder 잡기)**

§1.2 표의 **모든 전치 그룹**을 판별할 수 있어야 한다. 값 설계 요구사항:

1. **수치 필드는 전역 유일** — 어떤 두 필드도 같은 값을 갖지 않는다. 중첩 struct 내부(`ThinkTime.min_ms`/`max_ms`, `Stage.target`/`duration_seconds`)도 포함. **파생값도 포함** — `RunPlan.duration`(= `vu_stages`의 duration 합)이 `ramp_up`·`http_timeout` 등 다른 sentinel과 겹치면 전치 판별력이 새므로, sentinel을 고를 때 그 합까지 유일성 검사에 넣는다.
2. **`vu_count`·`vu_offset`도 서로 다른 sentinel** — 둘 다 `u32`이고 둘 다 `assignment` 출처라 전치 가능하다.
3. **미매핑 5필드도 판별 가능한 값** — 특히 `worker_count: Option<u32>`(다른 `Option<u32>`와 다른 값)와 `apply_scenario_think_time: bool`. `apply_scenario_think_time`의 serde default가 `true`(`runs.rs:177–181`)이므로 **명시적으로 `false`를 준다** — 기본값을 쓰면 `measure_phases: profile.apply_scenario_think_time` 회귀가 통과한다.
4. **bool 판별은 C1+C3 조합으로** — bool은 두 값뿐이라 한 케이스로 3개(`measure_phases`·`apply_scenario_think_time`·`ramp_down_immediate`)를 전부 구분할 수 없다. 배정:
   - **C1**: `measure_phases = true`, `apply_scenario_think_time = false`, `ramp_down = Some(Graceful)` → `ramp_down_immediate = false`
   - **C3(Immediate)**: `ramp_down = Some(Immediate)` → `ramp_down_immediate = true`, 나머지 bool 동일
   - 두 케이스에 걸쳐 각 bool이 서로 다른 패턴을 가지므로 임의의 bool 전치가 최소 한 케이스에서 RED가 된다.

**C1의 파생 기대값 주의** — `RunPlan.duration`은 입력 `duration_seconds`가 **아니다**. `duration = Duration::from_secs(run_duration_secs(&profile))`이고 `run_duration_secs`(`crates/proto/src/lib.rs:18–29`)는 `vu_stages` 우선 → `stages` → `duration_seconds` 순이다. C1이 `vu_stages`를 채우므로 기대값은 **`vu_stages`의 duration 합**이다. plan은 이 값을 계산해 명시해야 한다(입력 `duration_seconds`를 기대하면 엉뚱한 이유로 RED).

**C1 픽스처의 의미론** — `target_rps` + `stages` + `vu_stages`를 동시에 채우는 것은 실제 run에선 불가능한 조합이다(`validate_run_config`가 거부). 순수 매핑 함수는 검증을 하지 않으므로 무해하고, 전치 판별력을 최대화하려면 이 조합이 필요하다. spec/plan에 **의도임을 명시**한다.

**C2 — 부재/기본 (변환 규칙의 반대 방향)**
- **컨트롤러**: 전부 `None`/빈 값 → `stages: vec![]`, `vu_stages: vec![]`, `think_time: None`, `ramp_down_immediate: false`, optional 전부 `None`. `stages: Some(vec![])`도 `vec![]`로 매핑됨을 확인한다(빈 Vec ≡ 부재 규약, `is_open_loop`/`is_vu_curve` 판별과 일관).
- **워커** — ⚠ **기대값이 입력의 직역이 아니다**(C1과 같은 파생값 함정 클래스): `http_timeout_seconds = 0` → **`Duration::from_secs(30)`**(0-폴백, `lib.rs:246–250` — `Duration::ZERO`를 기대하면 엉뚱한 이유로 RED), `duration` → 모든 stage 리스트가 비어 `run_duration_secs`가 `duration_seconds`로 폴백, `ramp_down` → `Graceful`. C4와 0-폴백 단언이 겹치는데 중복이지 결함은 아니다.

**C3 — `ramp_down` 상태 (양쪽 홉, 어휘가 다름)**
- **컨트롤러** (`Option<RampDown>` 3상태 → `bool`): `None` → `false`, `Some(Graceful)` → `false`, `Some(Immediate)` → `true`. C2가 `None`을, C1이 `Some(Graceful)`을 덮으므로 `Some(Immediate)` 1건을 추가한다(§4.2 C1-4의 bool 판별도 겸한다).
- **워커** (`bool` 2상태 → `RampDown`): `false` → `Graceful`(C1·C2가 덮음), **`true` → `Immediate`** 1건을 추가한다. 이 건이 없으면 워커측 `Graceful` 하드코딩 회귀가 전 케이스를 통과한다(위 ⚠).

**C4 — 워커 `http_timeout` 0-폴백**
`http_timeout_seconds == 0` → `Duration::from_secs(30)`(구 컨트롤러 호환 규칙). 현재 무테스트다. `!= 0`은 C1이 덮는다.

### 4.3 이미 테스트된 것과의 관계

워커의 헬퍼 4종과 `run_duration_secs`는 이미 단위 테스트가 있다(`lib.rs:773`~). 이 슬라이스는 그것들을 다시 테스트하지 않고, **조립부**(어느 헬퍼 결과가 어느 `RunPlan` 필드로 가는가)를 덮는다.

## 5. 완료 정의

- `to_proto_profile` / `to_run_plan` 추출 완료, 두 인라인 리터럴 소멸, 호출부 각 1줄.
- **결선 완료 게이트**(아래 §6.1 참조 — 이빨 실증은 결선을 증명하지 못한다). 구현자가 리터럴을 *복사*해 함수를 만들고 인라인을 안 지우면 모든 테스트가 통과하면서 프로덕션엔 중복 코드가 남으므로, **"리터럴 소멸" + "호출 존재"를 둘 다** 기계 검사한다.

  ⚠ **파일 전역 카운트를 쓰지 말 것.** §4.1 ③의 구조분해 `let RunPlan { … } = plan;`이 `RunPlan {`에 매치되므로, 전역 `grep -c 'RunPlan {'`류는 슬라이스 후 값이 늘어 **구조적으로 통과 불가**다. 리전 스코프를 쓴다(아래 명령은 baseline에서 각각 `1`을 냄을 확인했다 — 추출 후 `0`이어야 한다):

  ```bash
  # ① 컨트롤러: 프로덕션 리전(첫 #[cfg(test)] 이전)에 Profile 리터럴 0건
  #    — 'v1::Profile {'만 보면 'pb::Profile {' 철자로 우회된다(그 파일은 이미 pb를 씀, runs.rs:549)
  awk '/^#\[cfg\(test\)\]/{exit} /(v1|pb)::Profile[[:space:]]*\{/{c++} END{print c+0}' \
      crates/controller/src/api/runs.rs            # → 0
  grep -c 'to_proto_profile(' crates/controller/src/api/runs.rs   # → 1 (호출 존재)

  # ② 워커: execute_assignment 본문에 RunPlan 리터럴 0건
  awk '/^async fn execute_assignment\(/{inside=1} inside && /^pub async fn run\(/{exit} \
       inside && /RunPlan[[:space:]]*\{/{c++} END{print c+0}' \
      crates/worker/src/lib.rs                     # → 0
  grep -c 'to_run_plan(' crates/worker/src/lib.rs  # → ≥2 (정의 + execute_assignment 호출)
  ```
- C1~C4 통과(§4.2 케이스×홉 배정 표대로 — 워커측 `ramp_down_immediate=true` 포함), §4.1 ①②③ 3중 장치 전부 배치(② 필드별 단언 병행 포함).
- `lib.rs:227–228` 스테일 주석 **삭제**.
- `crates/controller/CLAUDE.md:178` 함정 항목을 **통째로 현황에 맞게 갱신** — 숫자 `~17`→`15`뿐 아니라 "어느 것도 테스트가 없다"·"기계적 해법이 필요해지면 `to_proto_profile` 추출이 …(E3에서는 의도적으로 기각)"이 전부 이 슬라이스 후 거짓이 된다. 갱신 후 내용 = 추출 완료·단위 테스트 존재·**잔여 위험은 작성자 편향**(§7). `docs/build-log.md:677`의 "~17필드"도 정정.
- 게이트 green: `cargo fmt --check` · `cargo build --workspace` · `cargo clippy -D warnings` · `cargo nextest` · doctest.
- 프로덕션 거동 0-diff (UI/migration/`.proto` 0-diff).

## 6. 검증 — 이빨 실증 (필수)

`docs/dev/subagent-dispatch.md`·[[plan-mandated-vacuous-tests]] 규율: **회귀 가드를 표방하는 테스트는 이빨을 실증해야 한다.** plan은 각 항목을 독립 스텝으로 명시하고, 각각 *고의 회귀 → RED 확인 → 원복 → GREEN 확인*을 실행한다.

| # | 홉 | 고의 회귀 | 겨냥 | 통과 신호 | US |
|---|---|---|---|---|---|
| R1 | 컨트롤러 | `to_proto_profile`에서 `connect_timeout_seconds: None` 하드코딩 | E3 실제 사고 재현 | RED | US1 |
| R2 | 컨트롤러 | `target_rps` ↔ `max_in_flight` 전치 | `Option<u32>` 이웃 | RED | US3 |
| R3a | 컨트롤러 | `stages` ↔ `vu_stages` 전치 | `Vec<Stage>` 이웃 | RED | US3 |
| R3b | **워커** | `stages` ↔ `vu_stages` 전치 | 워커측은 컨트롤러와 로직이 다르다 — `if profile.stages.is_empty() { None } else { Some(…) }` 분기(`lib.rs:261–290`). R3a만으로는 이 분기가 이빨 실증을 못 받는다 | RED | US3 |
| R4 | 컨트롤러 | `measure_phases: profile.apply_scenario_think_time`로 교체 | **bool 이웃**(C1+C3 조합 판별력) | RED | US3 |
| R5 | 워커 | `http_timeout` 0-폴백 제거(`profile.http_timeout_seconds` 직결) | C4 | RED | US1 |
| R6 | 워커 | `ramp_down: RampDown::Graceful` 하드코딩 | **워커측 placeholder** — C3 워커 케이스가 없으면 통과한다(§4.2 ⚠) | RED | US1 |
| R7 | 컨트롤러 | `store::Profile`에 더미 필드 1개 추가 | ①의 강제력 | **컴파일 에러가 `crates/controller/src/grpc/profile.rs`에서도 발생** | US2 |

**R7의 통과 신호는 "컴파일 에러 발생"이 아니다.** `store::Profile`은 `Default`를 파생하지 않고 기존 픽스처 헬퍼들(`unique_profile`·`profile_with` 등)도 이미 exhaustive라, 더미 필드를 추가하면 **이 슬라이스가 없어도** 컴파일 에러가 난다. 따라서 R7은 에러가 **새 픽스처 파일에서도** 나는지로 좁혀 판정한다 — plan은 컴파일 에러 출력에서 `grpc/profile.rs`를 grep하는 명령을 명시할 것. (넓은 신호를 쓰면 [[plan-mandated-vacuous-tests]] 클래스의 공허한 실증이 된다.)

### 6.1 라이브 검증 — 생략, 근거

이 슬라이스는 `api/runs.rs::spawn_run`(run-생성 경로)과 `worker/src/lib.rs::execute_assignment`(엔진 경로)의 **프로덕션 코드를 바꾼다**. CLAUDE.md 파이프라인 5단계가 "필수"로 지목한 바로 그 두 표면이므로, "production diff 0" 면제 조항은 **문자 그대로는 적용되지 않는다**. 그럼에도 생략하는 근거:

1. **변경의 성질이 표현식 이동뿐**이다 — 새 분기·새 값·새 호출이 없다(§3.3).
2. **자동 e2e가 이미 그 두 경로를 관통한다**(§1.1) — 실 워커 바이너리를 spawn하는 6개 파일이 정규 게이트에서 `spawn_run` → gRPC → `RunPlan` → 엔진을 돌린다. 추출이 두 경로를 깨뜨리면 **이 e2e가 라이브 검증보다 먼저 실패한다**. 이것이 생략의 **주 근거**다.

**이빨 실증(§6)은 결선의 근거가 아니다.** R1~R7(8건)은 추출된 함수에 회귀를 심고 *그 함수를 직접 호출하는* 단위 테스트가 RED가 되는지를 볼 뿐, `spawn_run`/`execute_assignment`가 그 함수를 **호출한다는 것**은 증명하지 않는다 — 구현자가 리터럴을 복사해 함수를 만들고 인라인을 지우지 않아도 R1~R7은 전부 정상 동작한다. 결선은 §5의 **결선 완료 게이트**(리전 스코프 리터럴 0건 + 호출 존재, 4개 명령)와 위 e2e가 담보한다.

이 근거를 build-log에 그대로 남긴다.

## 7. 알려진 한계

- **잔여 위험은 "같은 작성자가 양쪽 기대값을 쓴다"는 편향이다.** 두 per-side 표 테스트는 각각 자기 홉에서 정확하지만, 작성자가 양쪽에서 같은 오해를 하면(예: 어떤 proto 필드의 단위를 초가 아니라 밀리초로 이해) 둘 다 green이다. 이 계층의 결함은 라이브 검증만 잡는다 — E3의 `connect_timeout` vs `timeout` kind 갈림이 그 예다. **크로스-크레이트 라운드트립 테스트를 추가해도 이 위험은 줄지 않는다**(§2.2-2).
- **①은 신규 필드에 대해 gate가 아니라 prompt다**(§4.1) — 작성자가 픽스처와 기대값 양쪽에 같은 placeholder를 복사하면 통과한다. E3 사고가 이 가드로 잡혔을지는 T3가 픽스처를 어떻게 채웠느냐에 달렸다. 정직하게 말해 **"보게 만든다"까지가 보장**이다.
- **②의 탈출구** — prost `Default` 파생으로 기대 리터럴에 `..Default::default()`를 덧붙일 수 있다. 주석으로만 막는다.
- **데이터바인딩 매핑은 여전히 무테스트**(§2.2) — 연기 항목.

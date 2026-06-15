# 운영 상한 관리자 화면 — 산재한 op-config 상한을 한 화면에서 보고/조정 (§B2'' QoL 슬라이스)

- **날짜**: 2026-06-16
- **상태**: 설계 초안
- **출처**: roadmap §B2'' "운영 상한 관리자 화면". **왜 지금**: op-config 상한(worker-capacity·dataset-max-rows·open-loop worker_count 하드캡 64·MAX_BINDINGS·loop cap·test-run 본문/요청 상한)이 CLI 플래그·Helm values·하드코드 상수로 산재해 운영자가 한눈에 못 보고, 바꾸려면 재배포/재컴파일이 필요하다. 사용자 결정(2026-06-15): open-loop `worker_count` 하드캡 64를 "이 화면에 설정값으로 노출".
- **연관**: ADR-0027(worker-capacity-vus·fan-out), ADR-0031/0038(open-loop worker_count), ADR-0022(데이터셋 바인딩·MAX_BINDINGS), ADR-0021(loop breakdown cap), ADR-0026(test-run 본문 knob), ADR-0035(UI 한국어/ko.ts), B-1 환경(`EnvironmentsPage`·top-level CRUD 리소스 미러).
- **ADR**: 신규 불필요(전부 기존 ADR 범위 내 additive — 새 아키텍처 결정 없음, 산재한 상수의 단일 표면화 + 선택적 DB 오버라이드). 단 "런타임 가변 설정 저장소"라는 패턴은 향후 option-2(전 설정 가변화)로 확장 시 ADR 후보 — 이 슬라이스는 그 씨앗만 둔다.

**사용자 결정 (브레인스토밍 2026-06-16)**:
- **근본 성격 = 하이브리드**(가변 + 읽기전용 혼합)로 v1 진행, **후속으로 option-2(전 설정 런타임 가변 DB 저장소)**. 하이브리드는 option-2로 자연 확장되게 설계.
- **v1 가변 세트 = 컨트롤러 per-request 상한 전부**(아래 R6 6종). 엔진 subprocess 상수(trace body/preview)·스케줄러는 **읽기전용 표시**. **엔진 상수 plumbing(worker로)은 명시 후속**(§7).
- UI 가변 상한엔 **초보자용 설명(무엇 + 올림/내림 영향)** 첨부(§4.6 카피).

---

## 1. 문제와 목표

부하 도구의 운영 상한들이 세 곳(CLI 플래그·Helm values·코드 하드코드 상수)에 흩어져 있어, 운영자가 "지금 이 클러스터의 상한이 뭔지" 한눈에 볼 수 없고 바꾸려면 재배포/재컴파일이 든다. 이 슬라이스는 그 상한들을 **한 관리 화면에 모아 보여주고**, 컨트롤러가 매 요청 시 읽는 상한 6종은 **재배포 없이 DB 오버라이드로 조정**하게 만든다.

- **목표**: ① 모든 op-config 상한을 `/settings` 한 화면에서 가시화(읽기전용 포함) ② 컨트롤러 per-request 상한 6종을 런타임 가변(DB 오버라이드)으로 ③ 오버라이드 0개면 현재 동작과 완전 동일(byte-identical) ④ 초보 운영자도 각 상한의 의미·올림/내림 영향을 이해.
- **비목표(연기)**: §7. 엔진 subprocess 상수 가변화(worker plumbing)·스케줄러 가변화·RBAC 게이팅·감사 로그.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance | seam? |
|---|---|---|---|
| R1 | MUST `GET /api/settings`가 가변+읽기전용 설정 전부를 메타데이터(`key,label,group,value,default,min,max,unit,mutable,source`)와 함께 반환한다 | 통합 `settings_get_returns_registry` + UI Zod 파싱 | ✅ UI Zod↔serde |
| R2 | MUST `PUT /api/settings/{key} {value:int}`가 검증(가변 여부 + `[min,max]` 정수) 통과 시 DB upsert + 인메모리 스냅샷 갱신을 하고, 비가변키·범위초과·미지키·비정수 값은 **400**으로 거부한다 | 통합 200/400 4케이스 + 라이브 | ✅ |
| R3 | MUST `DELETE /api/settings/{key}`가 오버라이드 행을 삭제해 유효값을 시드 기본값으로 복원한다 | 통합 `settings_delete_reverts_default` | ✅ |
| R4 | MUST 유효값 = DB 오버라이드 ?? 시드 기본값(CLI 플래그 또는 코드 상수)이고, 인메모리 스냅샷은 startup에 (DB ∪ 시드)로 시드되며 매 쓰기마다 갱신된다 | 단위 `effective_prefers_override` + 통합(PUT 후 GET 반영) | |
| R5 | MUST 오버라이드 0개(fresh 설치)면 run-create·test-run 동작이 현재 코드와 **byte-identical**이다(상한 값·거부 경계 불변) | 통합: 빈 `settings`로 기존 run-create/test-run 테스트 전부 통과 | |
| R6 | MUST 가변 6종의 결정 지점이 스냅샷 유효값을 읽어 변경이 **후속** run/test-run에 강제된다 — `worker_capacity_vus`(fan-out N, **3 사이트** runs.rs:237/425/603 전부)·`dataset_max_rows`(per-iter 행 게이트)·`max_open_loop_worker_count`(open worker_count 상한)·`max_data_bindings`·`max_loop_breakdown_cap`(loop cap 허용 상한)·`max_test_run_requests`(test-run 요청 상한) | 통합: 각 cap 변경 후 위반 run = **400** / 위반 test-run = **422** + 라이브 1회 | |
| R7 | MUST 설정 레지스트리(코드 `static`)가 key·label·group·범위·mutability·시드기본값의 **단일 소스** — 검증·DB 키 매핑·REST 응답·UI 메타가 전부 레지스트리에서 파생한다 | 단위 `registry_is_single_source`(중복 키 없음·범위 정합) | |
| R8 | MUST migration 0017 `settings(key TEXT PK, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`을 멱등 `CREATE TABLE IF NOT EXISTS`로 추가하고 const 정의 + `connect()` execute 라인 **양쪽**을 배선한다 | `grep -c MIGRATION_SQL` const==execute + 재실행 멱등 | ✅ migration |
| R9 | MUST `/settings` 페이지가 "조정 가능한 운영 상한"(행별 항상보임 *무엇* 설명 + ⬆/⬇ 영향 HelpTip + 저장/기본값복원) + "배포 설정(읽기전용)" 두 섹션을 한국어/`ko.ts`(ADR-0035)로 렌더한다 | RTL: 편집→PUT·복원→DELETE·읽기전용 섹션·HelpTip·설명 텍스트 존재 | ✅ UI Zod |
| R10 | MUST 엔진·워커·proto는 무변경이다(상한 표면화·가변화는 컨트롤러+UI에 한정) | `git diff` crates/engine·crates/worker·crates/proto 0 | |
| R11 | SHOULD UI가 레지스트리 `[min,max]`를 입력 가드로 표면화한다(범위 밖이면 저장 비활성 + 안내) — 서버 검증(R2)이 최종 권위 | RTL 범위초과 케이스(저장 비활성) | |
| R12 | SHOULD in-flight·기존 run은 변경 영향 없음(유효값은 run-create 시점 스냅샷)을 보장하고 화면이 그 의미("후속 run부터 적용")를 안내한다 | UI 안내 카피 + 코드: 스냅샷 read는 run-create 경로에만 | |

- **seam 묶음**: R1(serde 직렬화) ↔ R9(UI Zod 수용)는 한 와이어 계약의 양쪽 — plan에서 계약-먼저 task로 묶고 최종 리뷰가 1:1 대조. R2/R3도 같은 `SettingDto` 와이어 위.

---

## 3. 핵심 통찰 (설계 근거)

1. **per-request 읽기 = 가변화가 거의 공짜.** R6 6종은 전부 컨트롤러가 run-create/test-run 핸들러에서 **요청 시점에** 읽는 값(`AppState.dataset_max_rows`·`runs.rs`의 리터럴/const·`coord.worker_capacity_vus`). 결정 지점이 startup 고정 필드 대신 **인메모리 스냅샷**을 읽게만 하면 런타임 가변이 된다 — 엔진 subprocess 상수(trace body/preview)와 달리 proto/worker plumbing이 0이라 v1 가변 세트로 자연스럽다(브레인스토밍 scope 결정).

2. **레지스트리가 단일 소스라야 드리프트가 구조적으로 불가(R7).** key·label·범위·mutability·기본값을 `static SETTINGS: &[SettingDef]` 한 곳에 두면, 검증(R2)·DB 매핑(R3·R8)·REST 메타(R1)·UI 행(R9)이 전부 거기서 파생 → 새 knob 추가 = 레지스트리 1행(+가변이면 결정 지점 1줄)으로 option-2 확장 친화. (CSV/XLSX `INSIGHT_COLUMNS` 단일 소스 패턴과 동형.) **예외**: 읽기전용 엔진 상수 표시 1행(`trace_body_cap_bytes`)은 engine crate의 private const를 손-복사한 리터럴이라 컴파일타임 링크가 없다 = R7의 유일한 알려진 드리프트 지점(§5 명문화, option-2 plumbing이 해소).

3. **유효값 = override ?? 시드(R4)라야 byte-identical(R5)이 공짜.** 시드 기본값 = 현재 CLI 플래그값(capacity·dataset_max_rows) 또는 현재 코드 상수(64·8·10000·50)다. `settings` 테이블이 비면 모든 유효값 = 시드 = 현재 동작 → run 경로 byte-identical. DB 오버라이드는 "기존 위에 덮어쓰기"라 `DELETE`(R3)로 시드 복원. 모든 최근 슬라이스의 "absent → byte-identical" 불변식과 같은 안전 장치.

4. **인메모리 스냅샷으로 per-request DB 쿼리 0.** 결정 지점이 매 요청 DB를 치면 핫하다. 대신 `Arc<RwLock<HashMap<&'static str,i64>>>` 스냅샷을 `AppState`에 두고 startup 1회 시드 + 쓰기 시 갱신 → 결정 지점은 락 짧게 잡고 정수 1개 read. 타입드 accessor(`fn worker_capacity_vus()->u32`)가 키→값 캐스팅을 감춰 결정 지점은 타입 안전. (값은 i64로 통일 저장 — 모든 범위가 i64에 안전히 들어감.)

5. **읽기전용 표시는 컨트롤러측 리터럴로(R10 유지).** `MAX_TRACE_BODY_BYTES`(1 MiB)는 engine crate `executor.rs:242`의 **private const**라 동적 참조하려면 `pub`화(=엔진 변경)가 필요하다 → v1은 읽기전용 *표시*만이라 레지스트리에 **문서화된 리터럴** 1행으로 둔다(소스 라벨 "코드 기본값(배포 변경)", 출처 주석). 이로써 R10(엔진 무변경)을 깨지 않는다(드리프트는 R7 예외로 명문화, option-2 plumbing이 해소). **`INLINE_PREVIEW_CHARS`(500)는 엔진이 아니라 UI 상수**(`ui/src/components/scenario/TestRunPanel.tsx:8`) — 변경에 `pnpm build`가 들고 컨트롤러/배포 상한이 아니므로 **v1 표시 세트에서 제외**(§7로 미룸 — UI 상수를 컨트롤러 레지스트리에 복사하면 R7이 막으려는 바로 그 드리프트를 만든다).

6. **worker_capacity_vus = 가장 침습적, 단일 권위로 통일.** capacity는 `CoordinatorState.worker_capacity_vus` 필드(coord.rs:130) + `worker_count_for`(coord.rs:154)에 박혀 run-create의 **세 prod 사이트**가 읽는다: `runs.rs:237`(vu_curve stage-target가 capacity 이하인지 검증), `runs.rs:425`(`validate_run_config`의 unique-binding 행수 게이트), `runs.rs:603`(`spawn_run`의 **권위 있는 dispatch N**). 검증(237/425)과 dispatch(603)가 서로 다른 capacity를 읽으면 "N=1로 검증됐는데 N=2로 발사" 같은 silent 불일치가 난다. fan-out 산식은 이미 자유함수 `shard::worker_count(total_vus, capacity)`다 → **세 사이트 전부 `state.settings.worker_capacity_vus()`를 읽어 `shard::worker_count` 직접 호출**하고, **`CoordinatorState`의 `worker_capacity_vus` 필드 + `worker_count_for` 메서드를 제거**해 단일 권위(스냅샷)를 강제한다(필드를 시드로 남겨두면 §C1 분기 위험 — 반드시 제거). main.rs는 capacity를 coord가 아니라 settings 시드로 넘긴다.

---

## 4. 변경 상세

### 4.1 설정 레지스트리 + 스냅샷 — `crates/controller/src/settings.rs` (신규) — 충족 R: R4, R7

- `enum SettingKind { U32, U64, Usize }`(검증·표시 단위용), `enum Group { Limits, Scheduler, TestRun }`(UI 섹션 분류), `struct SettingDef { key:&'static str, label:&'static str, group:Group, kind, min:i64, max:i64, unit:&'static str, mutable:bool }`.
- `static SETTINGS: &[SettingDef]` — 아래 §4.2 표의 행을 그대로 인코딩.
- `seed_default(key, args)` → i64: CLI 플래그(capacity·dataset_max_rows) 또는 코드 상수. 읽기전용 행도 표시값을 여기서.
- `struct SettingsState { mutable: Arc<std::sync::RwLock<HashMap<&'static str,i64>>>, readonly: HashMap<&'static str,i64> }` + `fn from_db_and_seed(db, args)`(startup: 가변 키마다 `DB override ?? seed`, 읽기전용은 seed) + 타입드 accessor 6종(`worker_capacity_vus()->u32` 등) + `fn set(key,value)`(검증 통과분만, 스냅샷 갱신) + `fn view()->Vec<SettingDto>`(R1 응답 조립: 가변=스냅샷값/읽기전용=readonly값 + 레지스트리 메타 + `source`).
  - **`std::sync::RwLock` + read-into-local**(`tokio::sync::RwLock` 아님): accessor는 락을 잡아 i64 1개를 복사하고 **즉시 drop** — `validate_run_config`가 async라 **가드를 `.await` 너머로 들고 가지 않게** 한다(async-lock footgun 회피). 쓰기(set)는 PUT/DELETE 시에만.
  - **로드 시 범위 밖 오버라이드 정책(M3)**: `from_db_and_seed`가 DB 오버라이드를 레지스트리 `[min,max]`로 **재검증** — 범위 밖이거나 파싱 실패면 **skip + warn → 시드로 폴백**(현재 검증을 우회하는 값이 유효값이 되지 않게; 후속 릴리스가 bound를 좁혀도 안전).
- `fn validate(key,value)->Result<(),String>`: 레지스트리에서 def 찾고 `mutable` + `min<=value<=max` 검사(R2 단일 검증 함수, REST가 호출).
- `seed_default`는 **기존 상수를 참조**(F6): `worker_capacity_vus`→`grpc::coordinator::DEFAULT_WORKER_CAPACITY_VUS`(2000), 나머지 코드 상수도 리터럴 복붙 말고 가능한 const 참조.

### 4.2 가변/읽기전용 세트 (레지스트리 행) — 충족 R: R6, R7

**가변 (DB 오버라이드, group=Limits 또는 TestRun)**:

| key | 시드 출처 (const 참조) | 결정 지점(현재) | min..max | 단위 |
|---|---|---|---|---|
| `worker_capacity_vus` | `coordinator::DEFAULT_WORKER_CAPACITY_VUS`(2000) | runs.rs:237 + 425 + 603 (`worker_count_for` 제거 후 `shard::worker_count`) | 1..1,000,000 | VU |
| `dataset_max_rows` | CLI `--dataset-max-rows`(1,000,000) | runs.rs:470 (`state.dataset_max_rows`) | 1..100,000,000 | 행 |
| `max_open_loop_worker_count` | 리터럴 64 (runs.rs:191) | runs.rs:191 (에러 문구도 동적 N) | 1..256 | 대 |
| `max_data_bindings` | const 8 (runs.rs:397 `MAX_BINDINGS`) | runs.rs:397 | 1..64 | 개 |
| `max_loop_breakdown_cap` | 10,000 (runs.rs:42 `loop_cap_ok`) | runs.rs:42 | 0..1,000,000 | 회차 |
| `max_test_run_requests` | **`MAX_MAX_REQUESTS`(10,000)** (test_runs.rs:11) | **test_runs.rs:38** (`> MAX_MAX_REQUESTS` → 422) | 1..100,000 | 요청 |

> **`max_test_run_requests` 주의(F1)**: 노출 대상은 *enforced 상한* `MAX_MAX_REQUESTS`(10,000, test_runs.rs:11)지 absent-필드 serde 기본값 `DEFAULT_MAX_REQUESTS`(50)가 아니다 — 후자는 정적 serde default fn이라 `AppState`를 못 읽어 가변화 불가. 시드를 50으로 잡으면 빈 테이블이 상한을 10,000→50으로 바꿔 R5(byte-identical)를 깬다.

**읽기전용 (표시만, group=TestRun/Scheduler, mutable=false)**:

| key | 표시값(컨트롤러 리터럴/startup) | 출처 주석 |
|---|---|---|
| `trace_body_cap_bytes` | 1,048,576 (1 MiB) | engine `executor.rs:242` `MAX_TRACE_BODY_BYTES` (private const, 손-복사 리터럴 = R7 예외 §5) |
| `scheduler_tick_seconds` | startup `--scheduler-tick-seconds`(30) | main.rs 캡처 |

> **`SettingDto.value`는 전부 정수(i64)** — DTO를 깔끔히 유지하려고 비-정수/재시작-의미론 knob은 v1 표시에서 제외하고 §7로 미룬다: `scheduler_timezone`(문자열) + `scheduler_disabled`(bool, M1) → 정수 DTO에 안 맞음, `trace_inline_preview_chars`(UI 빌드 상수 §3.5) → 컨트롤러 상한 아님. 스케줄러 읽기전용 표시는 정수 `scheduler_tick_seconds` 한 행으로 대표한다.

### 4.3 DB 저장소 + 마이그레이션 — `store/settings.rs`(신규) + `store/mod.rs` — 충족 R: R8, R3, R4

- migration 0017: `MIGRATION_SQL_0017 = "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"` + `connect()`에 `sqlx::query(MIGRATION_SQL_0017).execute(&pool).await?;`(0016 뒤). **const 1 + execute 1 교차검증**(루트/컨트롤러 CLAUDE.md 리넘버 함정).
- `store/settings.rs`: `load_overrides(db)->HashMap<String,i64>`(value TEXT→i64 파싱, 파싱실패는 skip+warn), `upsert(db,key,value)`(`INSERT … ON CONFLICT(key) DO UPDATE SET value=…,updated_at=…`), `delete(db,key)`. **범위 재검증은 로더가 아니라 `from_db_and_seed`(§4.1 M3)** — 로더는 raw 파싱만, 스냅샷 빌더가 레지스트리 `[min,max]`+`mutable`로 거르고 시드 폴백.

### 4.4 결정 지점 배선 — `api/runs.rs`·`api/test_runs.rs`·`grpc/coordinator.rs` — 충족 R: R5, R6

- `runs.rs:470`: `state.dataset_max_rows` → `state.settings.dataset_max_rows()`.
- `runs.rs:191`: 리터럴 `64` → `state.settings.max_open_loop_worker_count()`(에러 문구도 동적 — "worker_count must be between 1 and {N}").
- `runs.rs:397`: `const MAX_BINDINGS=8` → `state.settings.max_data_bindings()`.
- `runs.rs:42` `loop_cap_ok`: `cap <= 10_000` → 결정 지점에서 `cap <= state.settings.max_loop_breakdown_cap()`(자유함수 `loop_cap_ok`는 인자화하거나 호출부에서 비교).
- **capacity 3 사이트(§3.6, FR1/C1)**: `runs.rs:237`(curve stage 검증)·`runs.rs:425`(`validate_run_config` unique-binding 게이트)·`runs.rs:603`(`spawn_run` dispatch N) **전부** `state.settings.worker_capacity_vus()`를 읽어 `shard::worker_count` 호출. **`CoordinatorState.worker_capacity_vus` 필드 + `worker_count_for` 메서드 제거**(coord.rs:130/154), `with_capacity`/`new`/main.rs 갱신 — 단일 권위. 회귀 테스트: capacity 낮춰 (a) curve 검증 거부 (b) dispatch N 둘 다 새 값 반영(아래 override seam으로).
- **stale 주석 정리(N2)**: `dispatcher/k8s_spec.rs:20`의 "N from `CoordinatorState::worker_count_for`" 주석을 `shard::worker_count`/settings accessor 참조로 갱신(메서드 제거에 매달린 주석).
- **`loop_cap_ok` 인자화 = 테스트 동반(N3)**: `loop_cap_ok`(runs.rs:42 자유함수)를 인자화하거나 호출부 인라인하면 그 단위 테스트 `validates_loop_breakdown_cap_bounds`(runs.rs:947)가 함께 바뀜 — **같은 green 커밋에 fold**(전체-게이트라 RED 단독 불가).
- `test_runs.rs:38`: `body.max_requests > MAX_MAX_REQUESTS` → `> state.settings.max_test_run_requests()`. **핸들러 시그니처에 `State(state): State<AppState>` 추가**(현재 `create(Json(body))`엔 State 없음 — F2) + `app.rs:126` 라우트는 `with_state`로 이미 state 보유라 추가 배선 불요. 거부는 기존대로 **422**(`ApiError::Unprocessable`, test-run 전용 — controller CLAUDE.md).
- **AppState**: 기존 `dataset_max_rows: u64` 필드 제거 → `settings: SettingsState` 교체. AppState literal site 전부 갱신(컴파일러-driven, **~42곳/19파일**(F5) — `grep -rn "AppState {" crates/controller/{src,tests}`; `e2e_test.rs` ~14개 등). **`src` 내 fixture도 포함**(FR2): `schedule/runner.rs:278`·`runs.rs:976` 인라인 `state_with`는 `tests/`가 아니라 `src/`라 헬퍼가 `#[cfg(test)]` src 모듈에서 닿아야 함.
- **테스트 override seam(N1) — 필수**: 헬퍼 2종. `SettingsState::seeded_for_test()`(전 키 시드 기본값, 대부분 fixture) + **`SettingsState::seeded_for_test_with(&[(&'static str, i64)])`**(특정 키 override). 필드 제거로 `with_capacity(db, <비기본>)` 경로가 사라지므로, **capacity가 비-기본(N>1 유도)이어야 하는 테스트를 전부 이 override로 시드**한다. 하드 리스트 대신 **grep으로 완전 열거**(누락 방지): `grep -rn "with_capacity" crates/controller/{src,tests}`로 capacity≠2000 사이트를 모두 찾아 변환. 현재 알려진 사이트:
  - `tests/multi_worker_fanout_e2e.rs`의 `with_capacity(db,1)` 4곳(:105/:198/:309/:570) → `boot()`(`fn boot(` 선언 :51)가 `coord` 외에 **capacity-시드된 `SettingsState`도 받도록 시그니처 조정**(현재 pre-built coord만 받음; gRPC `CoordinatorService`는 N을 재계산 안 하고 `enqueue(expected)`로 받으므로 REST `AppState.settings`에만 capacity 필요 = 충분). vus=2·cap=1 → N=2 유지.
  - `src/api/runs.rs`의 `state_with(db, capacity)`(:966) → `capacity`를 coord가 아니라 `seeded_for_test_with([("worker_capacity_vus", capacity)])`로 라우팅(전 `state_with` 호출자가 이 헬퍼 경유 = 단일 변경; default 2000 호출자는 무해). 단위테스트 `unique_*`(:1020/:1250, cap=1·vus=2→N=2 gate) 그대로.
  - `tests/data_binding_api_test.rs:220`의 직접 `AppState` 리터럴 + `with_capacity(db,1)`(`unique_policy_rejected_when_rows_below_worker_count`, rows1<N2→400·"워커") → `boot`/`state_with`를 안 거치는 standalone이라 **별도 변환 필수**: `seeded_for_test_with([("worker_capacity_vus", 1)])`(기본값 2000으로 떨어뜨리면 N=1→201로 silent flip).
  - R6 capacity 회귀 테스트도 이 seam으로 cap 낮춰 (a)curve 거부 (b)dispatch N 검증.

### 4.5 REST — `api/settings.rs`(신규) + `app.rs` 라우트 — 충족 R: R1, R2, R3

- `GET /api/settings` → `{ settings: Vec<SettingDto> }`(`state.settings.view()` + 읽기전용 합성). `SettingDto { key,label,group,value(i64),default(i64),min,max,unit,mutable,source }`(`source ∈ {"override","default","readonly"}`).
- `PUT /api/settings/{key}` `{value:i64}` → `validate`→`store::settings::upsert`→`state.settings.set` → **200 + 갱신 DTO**. 실패 = `ApiError::BadRequest`(레거시 엔드포인트 컨벤션, 400 — controller CLAUDE.md).
- `DELETE /api/settings/{key}` → `store::settings::delete` + 스냅샷을 시드로 되돌림 → **204 No Content**(environments::delete 미러, C2 — 빈 본문, UI는 invalidate→GET 재조회로 복원값 획득). 미지키/비가변키 400.
- api/environments.rs CRUD 구조 미러(라우트 등록·핸들러 시그니처·`State`+`Path` 추출·204 DELETE).

### 4.6 UI — `pages/SettingsPage.tsx`(신규) + ko.ts·routes·nav·client·Zod — 충족 R: R9, R11, R12

- `client.ts`: `getSettings()`·`putSetting(key,value)`·`deleteSetting(key)` + `SettingSchema`(Zod, `value/default/min/max:number`, `mutable:boolean`, `source` enum, `group` enum) — **와이어 1:1 serde**(R1 seam).
- `SettingsPage`(EnvironmentsPage 미러): React Query `useQuery(getSettings)`.
  - **섹션 1 "조정 가능한 운영 상한"**(`mutable:true`): 행별 — 라벨 + `ko.opsSettings.desc[key]`(항상보임 *무엇* 한 줄) + HelpTip(ⓘ)에 `ko.opsSettings.effect[key]`(⬆/⬇ 영향) + 현재값 입력 + 기본값/범위 힌트 + [저장](PUT)/[기본값 복원](DELETE, override일 때만 활성). 범위 밖 입력 = 저장 비활성 + 안내(R11). 저장 성공 후 invalidate.
  - **섹션 2 "배포 설정 (읽기 전용)"**(`mutable:false`): 라벨 + 현재값 + "Helm/CLI deploy 설정으로 변경" 안내(R10 표면). 입력 없음.
  - 상단 안내: "여기서 바꾼 값은 **다음에 시작하는 run부터** 적용됩니다(진행 중인 run엔 영향 없음)"(R12).
- routes.tsx에 `/settings` + nav 항목 + breadcrumb(기존 페이지 패턴 미러, ADR-0035 한국어).
- **ko.ts 카피**(초보자용, §사용자 요청):

```
워커당 VU 수용량 (worker_capacity_vus)
  무엇: 워커 한 대가 맡는 가상 사용자(VU) 수. 컨트롤러가 "필요 워커 수 = 올림(총 VU ÷ 이 값)"으로 몇 대 띄울지 계산.
  ⬆ 올리면: 워커 한 대에 VU를 더 몰아 워커 수가 줄어듦(자원 절약). 너무 높이면 한 대가 과부하돼 부하 생성이 부정확.
  ⬇ 내리면: 워커를 더 많이 띄움(분산↑·정확도↑). 대신 K8s Pod·프로세스가 늘어 클러스터 자원을 더 씀.
반복 바인딩 데이터셋 최대 행 수 (dataset_max_rows)
  무엇: 데이터셋을 "반복마다(per-iteration)" 바인딩할 때 워커로 보낼 수 있는 최대 행 수. 워커 메모리 보호(VU별 바인딩은 미적용).
  ⬆ 올리면: 더 큰 데이터셋을 반복 바인딩에 사용. 대신 워커 메모리↑(OOM 위험).
  ⬇ 내리면: 메모리 안전. 대신 행이 많은 데이터셋 run은 "행 수 초과"로 거부.
열린 루프 워커 수 상한 (max_open_loop_worker_count)
  무엇: 열린 루프(도착률) run에서 지정 가능한 워커 수의 최댓값.
  ⬆ 올리면: 매우 높은 목표 RPS를 더 많은 워커로 분산. 대신 한 번에 많은 워커 Pod가 떠 클러스터 압박.
  ⬇ 내리면: 안전. 대신 아주 높은 목표 RPS를 워커가 못 따라가 포화(요청 누락).
run당 데이터셋 바인딩 최대 개수 (max_data_bindings)
  무엇: 한 run에 동시에 붙일 수 있는 독립 데이터셋 바인딩 개수.
  ⬆ 올리면: 더 복잡한 다중 데이터셋 시나리오 가능. 대신 워커의 다중 스트림 관리 부담↑.
  ⬇ 내리면: 단순·가벼움. 대신 바인딩이 많은 run은 거부.
반복별 메트릭 상한의 최댓값 (max_loop_breakdown_cap)
  무엇: loop 노드 메트릭을 "회차별로" 몇 개까지 집계할지 정하는 run 설정값의 허용 상한. 초과 회차는 "상한 초과" 한 칸으로 합쳐짐.
  ⬆ 올리면: 반복 많은 loop도 회차별로 세밀히 관찰. 대신 저장·리포트 행(메트릭 양)↑.
  ⬇ 내리면: 메트릭 가벼움. 대신 회차별 분해 해상도 제한.
테스트 실행 최대 요청 수 (max_test_run_requests)
  무엇: 에디터 "미리 1회 실행"이 한 번에 보낼 수 있는 최대 요청 수.
  ⬆ 올리면: 더 긴 시나리오를 미리 끝까지 실행. 대신 미리보기가 느려지고 대상 서버에 요청↑.
  ⬇ 내리면: 빠르고 가벼움. 대신 긴 시나리오는 앞부분까지만 미리 실행.
```

---

## 5. 무변경 / 불변식 (명시)

- **엔진·워커·proto 무변경**(R10) — 상한 표면화·가변화는 컨트롤러+UI 한정. 엔진 상수는 읽기전용 *표시*만(컨트롤러 리터럴, §3.5).
- **오버라이드 0개 → run-create·test-run byte-identical**(R5) — 시드 기본값 = 현재 CLI/상수값(capacity는 `DEFAULT_WORKER_CAPACITY_VUS`, test-run은 `MAX_MAX_REQUESTS`)이라 빈 `settings` 테이블 = 현재 동작. **단 R5는 F1 수정(`max_test_run_requests` 시드=10,000) 전제** — 50으로 시드하면 깨짐.
- **메트릭·리포트·CSV/XLSX·스케줄러 루프·dispatcher 무변경** — 이 슬라이스는 상한 *읽기 소스*만 바꾸고 상한이 쓰이는 로직은 그대로.
- **R7 알려진 예외(C3)**: 읽기전용 `trace_body_cap_bytes`는 engine private const(`executor.rs:242`)의 손-복사 리터럴이라 컴파일타임 단일-소스 링크가 없다 — v1 의도적 허용(읽기전용 표시뿐, option-2 plumbing이 해소). 그 외 모든 설정 메타는 레지스트리 단일 소스.
- in-flight·기존 run 무영향(R12) — 유효값은 run-create 시점에만 읽힘.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1 | 통합 `settings_get_returns_registry`(가변+읽기전용 행·메타 필드) + UI Zod `getSettings` 파싱 | ✅ |
| R2 | 통합 4케이스(가변 200·범위초과 400·비가변키 400·미지키 400) | ✅ |
| R3 | 통합 `settings_delete_reverts_default` | |
| R4 | 단위 `effective_prefers_override`(override ?? seed) + 통합(PUT→GET 반영) | |
| R5 | 통합: 빈 settings로 기존 run-create/test-run/preset/schedule 테스트 전부 green | |
| R6 | 통합 6종: 각 cap 변경 후 위반 run = **400**(예 worker_count cap=2→worker_count 3 run 400)·위반 test-run = **422**(max_test_run_requests 낮춰 초과 요청)·capacity는 3 사이트(curve 검증/dispatch N) 일관 | ✅(1회) |
| R7 | 단위 `registry_is_single_source`(중복 키 0·min≤max·mutable 시드 존재) | |
| R8 | `grep -c MIGRATION_SQL_0017` const==execute(각 1) + 마이그레이션 두 번 실행 멱등 | |
| R9 | RTL `SettingsPage`(편집→PUT·복원→DELETE·읽기전용 섹션·HelpTip 열림·*무엇* 설명 텍스트 존재) | |
| R11 | RTL: 범위 밖 입력 시 저장 비활성 + 안내 | |
| R12 | RTL/관찰: 상단 "다음 run부터 적용" 안내 존재 | |

- **라이브 검증 필수**(`/live-verify`): 새 `/api/settings` 응답을 UI가 Zod 파싱(**S-D 갭** — 새 서버 응답 경로). GET 파싱 + PUT/DELETE 라운드트립 + cap 강제 1회(예 worker_count 상한을 낮춰 위반 run이 400, 복원 후 통과). 콘솔 Zod 0 확인.

---

## 7. 의도적 연기 (roadmap §B2''에 누적)

- **option-2: 엔진/UI 상수 가변화(명시 후속, 사용자 결정)**: `MAX_TRACE_BODY_BYTES`(engine `executor.rs:242`)를 worker로 plumbing(proto 필드 또는 worker env/arg)해 런타임 가변 + 단일 소스화(현 v1은 컨트롤러 리터럴 읽기전용 표시뿐). `INLINE_PREVIEW_CHARS`(UI `TestRunPanel.tsx:8`, 500)는 UI 빌드 상수라 컨트롤러 상한이 아님 → v1 표시에서 제외, 진짜 가변화하려면 UI 빌드-타임 주입이 별도 필요. 엔진/워커/proto/UI 빌드를 건드리는 더 큰 슬라이스.
- **스케줄러 config 가변화**: tick/tz/disabled를 가변화하려면 `run_scheduler` 루프 재시작/재구성 의미론 필요 — v1은 `scheduler_tick_seconds`만 읽기전용 표시. **`scheduler_timezone`(문자열) 표시도 v1 제외**(정수 DTO 유지, §4.2) → 문자열 설정 지원 시 함께.
- **worker_mode·db 경로 등 startup-only 가변화**: 런타임 변경이 부적합(프로세스 재구성). 표시 후보.
- **RBAC 게이팅(§A10)**: v1은 현 화면들과 동일하게 무인증 — A10 도입 시 admin-gate.
- **감사 로그**(누가·무엇을·언제 바꿨나): A10 감사 트랙과 함께. v1은 `updated_at`만.
- **per-deploy 워커 cpu/mem Helm values**(§B2'' 기존 항목): 이 화면과 묶을 수 있으나 별개.

---

## 8. 구현 순서 (plan 입력)

> cargo-영향 커밋마다 전체 워크스페이스 게이트 → 미사용 헬퍼만/RED 테스트만 단독 커밋 불가. 각 task를 **green fold**로.

1. **레지스트리 + 스냅샷 + 단위 테스트**(`settings.rs`, R4/R7) — accessor·validate·seed·view. (단위 테스트 동봉 green.)
2. **DB 저장소 + migration 0017**(`store/settings.rs`·`store/mod.rs`, R8/R3) — load/upsert/delete + 멱등 CREATE. (store 테스트 동봉.)
3. **AppState 교체 + 결정 지점 배선**(`app.rs`·`runs.rs`·`test_runs.rs`·`coord.rs`, R5/R6) — `dataset_max_rows` 필드 → `SettingsState`, 6 결정 지점 스냅샷 read, AppState literal site 전부(~31). (기존 run-create 테스트가 byte-identical 회귀 가드 = R5.)
4. **REST `api/settings.rs` + 라우트**(R1/R2/R3) — GET/PUT/DELETE + 통합 테스트(200/400 케이스·revert·cap 강제).
5. **UI: client+Zod**(R1 seam) → **SettingsPage + ko.ts 카피 + routes/nav**(R9/R11/R12) — RTL 동봉. (4와 5는 와이어 계약 양쪽 = 함께 머지.)
6. **라이브 검증**(§6) → handicap-reviewer → finish-slice.

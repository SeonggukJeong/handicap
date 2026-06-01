# 컨트롤러 (`crates/controller`) 함정

이 파일은 `crates/controller/` 파일을 건드릴 때 자동 로드되는 중첩 CLAUDE.md다. 프로젝트 전역 규칙·git 토폴로지·검증 훅·일하는 모드는 루트 `CLAUDE.md` 참고. 엔진/워커/UI 함정은 각 디렉토리의 CLAUDE.md.

컨트롤러는 워커 오케스트레이션 바이너리: REST API(axum) + SPA 정적 서빙 + gRPC Coordinator + SQLite store + 리포트 빌드(`report.rs`) + 데이터셋 파싱(`datasets/`) + 워커 dispatcher(subprocess/K8s).

> **참고**: `handicap-controller` 패키지엔 바이너리가 둘(`controller` + `e2e_kind_driver`)이라 `cargo run -p handicap-controller`만 쓰면 깨진다. 로컬 실행 footgun은 루트 `CLAUDE.md`의 "로컬 dev 실행 함정" 참고.

## axum / 라우팅 / SPA 서빙 / 업로드 (`app.rs`)

- **axum 0.8 path syntax** (Slice 1): `/scenarios/:id` 아님, `/scenarios/{id}`. 0.7 문서/예제 검색하면 함정.
- **axum 0.8 `nest` + `with_state`** (Slice 2): state는 outer router에 한 번만 붙인다. 안쪽 router에 `with_state`를 두 번 붙이면 컴파일은 되지만 nested router가 state를 못 봄.
- **`ServeDir::fallback` vs `not_found_service`** (Slice 2): SPA를 axum 0.8 + tower-http 0.6에서 띄울 때 핵심 함정. 두 메서드 모두 같은 fallback service를 호출하지만, `not_found_service`는 내부적으로 `SetStatus<_, 404>`로 감싸서 fallback이 반환하는 status code를 무조건 404로 덮어쓴다. 즉 ServeFile이 index.html을 200으로 돌려줘도 브라우저는 404를 본다 → React Router의 hard-refresh가 깨지고 에러 모니터가 4xx로 인식. **`ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html")))`** 로 써야 inner ServeFile의 200이 그대로 전달된다. `ServeDir::append_index_html_on_directories`(기본 true)가 `/` → `index.html`을 처리해주므로 root는 따로 안 다뤄도 됨. (`app.rs` 내 load-bearing 주석 참고.)
- **`/api` 프리픽스로 옮긴 이유** (Slice 2): SPA가 `/scenarios/:id` 같은 client-side route를 갖기 때문에 REST 경로와 충돌. 슬라이스 1 테스트도 함께 업데이트해야 통과.
- **axum 기본 body limit 2MB가 multipart 업로드를 막는다** (Slice 8b, 실제 버그): `DefaultBodyLimit`는 모든 라우트에 2MB 기본 상한을 적용하고 `Multipart`/`field.bytes()`도 그 대상이다. 데이터셋은 쉽게 2MB를 넘으므로 업로드/preview **POST 라우트에만** `.layer(DefaultBodyLimit::max(N))`로 상한을 올린다(전역 변경 금지 — `/runs`·`/scenarios`는 작은 JSON이라 기본 유지). axum 0.8에선 초과 시 413이 아니라 **400**으로 떨어진다.
- **axum `multipart`는 별도 feature** (Slice 8b): 워크스페이스 `axum` 줄에 `"multipart"`를 넣어야 `axum::extract::Multipart`가 쓰인다. per-crate feature 가산 병합이 안 되므로 워크스페이스 dependency 줄을 고쳐야 한다.

## 리포트 빌드 (`report.rs`, `build_report`)

- **리포트 step 라벨링은 controller가 아니라 UI** (Slice 5): `build_report` 는 run_metrics 를 step_id 로 group 만 한다 (시나리오 YAML 을 walk 하지 않음). step 라벨(name/method/url)은 UI 가 `ReportView.tsx`·`RunDetailPage.tsx` 에서 scenario_yaml 을 파싱해 만든다. **스텝 모델을 바꿔도(노드 종류 추가 등) 컨트롤러는 무변경 — 그 두 UI 사이트만 손대면 된다.**
- **HDR Histogram V2 BLOB 의 partial-write 내성** (Slice 5): worker가 flush 중 죽으면 `hdr_histogram` 컬럼에 truncated bytes가 남을 수 있다. 엔진 `decode_hdr` 는 `Result`로 실패를 표현하고 `build_report` 는 그 한 윈도만 p50/p95/p99=0 으로 두고 나머지 윈도를 정상 처리. crash-late-fail-soft 패턴. 단위 테스트 `build_report_tolerates_bad_hdr_blob` 가 contract.
- **`/report` 는 polling 금지** (Slice 5): terminal 후 한 번만 fetch, UI는 `staleTime: Infinity`, `refetchInterval: false`. live polling은 기존 `/metrics` 가 담당. 두 endpoint를 분리한 이유는 hot path의 HDR deserialize 비용을 피하기 위함.
- **Scenario snapshot vs current scenario** (Slice 5): Run 상세가 `runs.scenario_yaml` snapshot 컬럼을 봐야지 `GET /api/scenarios/{id}` 의 현재 YAML을 보면 시나리오 편집 후 과거 run의 step 라벨이 어긋난다. `/report.scenario_yaml`을 snapshot으로 노출.
- **`Deserialize`는 typed round-trip 테스트가 강제** (Slice 5): report.rs의 ReportJson/ReportRun/... 은 처음에 Serialize만 가졌는데 integration test 의 `serde_json::from_value::<ReportJson>` 어설션이 Deserialize 를 요구. 새 응답 타입 정의 시 양방향 derive를 함께.
- **`runs.started_at`/`ended_at` 은 wall-clock 밀리초 (`now_ms`)** (Slice 5): `build_report` 가 처음엔 그 차이를 그대로 `duration_seconds` 필드에 넣어 10초 run이 `10003` 으로 표시되고 rps 도 1000배 작게 나왔다. ms→s 변환은 `/1000`, rps 는 ms 기반으로 계산해 sub-second 분해능 유지. 단위 테스트 fixture 도 ms 값(`100_000` ↔ `102_000`)으로 적어야 의도(=2초 run)가 명확.
- **overflow는 controller에서 `null` 변환** (Slice 7-1): 엔진/proto/DB는 cap 초과 loop_index를 `u32::MAX` sentinel로 나르고, `build_report` 가 이를 `loop_index: null` 로 변환(UI는 "그 외 (상한 초과)" 행). cap 값 자체는 controller/UI가 알 필요 없음. DB를 직접 읽을 때는 `loop_index = 4294967295`가 "상한 초과" 행임을 알아야 한다.
- **`run_if_metrics` 테이블(migration 0006) + `ReportJson.if_breakdown` 최상위 배열** (Slice 9d): `CREATE TABLE IF NOT EXISTS`, PK `(run_id,step_id,branch)`, **`error_count` 컬럼 없음**(결정은 요청이 아님). `build_report`에 5번째 `branches: &[IfBranchRow]` 파라미터 추가(모든 call site 갱신 필수). `MetricBatch.branch_stats = 5` 추가(`MetricBatch` struct literal을 직접 작성하는 곳은 worker `main.rs` 뿐 — prost exhaustive 함정). `if_breakdown`은 **`ReportStep`이 아닌 최상위** `ReportJson` 배열 — `if` 노드 id는 http-leaf 메트릭 행에 없고 `none` 버킷은 http leaf 자체가 없어서(명세 §7의 리터럴 `ReportStep.branch_breakdown` 구현 불가).
- **localhost HTTP RTT는 microsecond 단위 → p95_ms = 0** (Slice 5): e2e 테스트에서 wiremock /ping이 sub-millisecond로 응답하면 `value_at_quantile(0.95) / 1_000` 이 0이 된다. `set_delay(Duration::from_millis(5))` 같은 인공 지연으로 p95 > 0 보장. UI에는 영향 없음(빠른 prod 백엔드도 보통 ms 단위).

## 저장소 / 마이그레이션 (SQLite, `store.rs`)

- **SQLite `ALTER TABLE ADD COLUMN` 은 idempotent 아님** (Slice 6): migration 0002 가 `runs.message` 컬럼을 추가하는데, 이미 마이그레이션된 DB 에서 controller 가 재시작되면 두 번째 ALTER 가 `duplicate column name` 으로 깨진다. 표준 가드는 `SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name = 'message'` 결과가 0 일 때만 ALTER. SQLite 는 `IF NOT EXISTS` 를 컬럼 단위로 지원하지 않으므로 이 패턴이 사실상 유일한 길.
- **`profile_json` 저장 방식 덕분에 runs 테이블 스키마 변경 없이 새 profile 필드 추가 가능** (Slice 7-1): `loop_breakdown_cap` 같은 새 profile 필드는 `#[serde(default)]` 하나로 기존 행 호환 — 옛 rows가 역직렬화될 때 default 값(256)이 자동 채워진다. 위 `ALTER TABLE` idempotency 함정과 대조적. profile에 새 필드를 더할 때는 **runs 테이블 migration이 필요 없다**. (8c `data_binding` 필드도 같은 패턴으로 추가 — migration 불필요.)
- **dataset_rows cascade는 앱 레벨** (Slice 8b): SQLite FK cascade 대신 `DELETE FROM dataset_rows WHERE dataset_id=?`를 트랜잭션으로 먼저 실행. migration은 `CREATE TABLE IF NOT EXISTS`라 멱등(Slice 6/7-1 패턴, ALTER 회피).
- **마이그레이션 리넘버 rebase: const 충돌은 보이지만 `.execute()` 라인은 조용히 auto-merge돼 누락된다** (영역 B): 두 브랜치가 같은 번호(예 둘 다 `MIGRATION_SQL_0006`)를 만들면 `store/mod.rs`의 **const 블록**은 `<<<<<<<` 충돌로 뜨지만, `connect()`의 `sqlx::query(MIGRATION_SQL_0006).execute(&pool).await?;` **execute 라인은 양쪽 텍스트가 동일**해서 git이 **한 줄로 silently auto-merge**한다 — 즉 내 마이그레이션을 0007로 리넘버할 때 const는 충돌 해소하며 추가하지만 **0007 execute 라인은 충돌에 안 나타나서 빠뜨리기 쉽다**. 리넘버 후 반드시 const 개수 == execute 개수인지 확인(`grep -c MIGRATION_SQL crates/controller/src/store/mod.rs`로 const N개·execute N개 교차검증). 빠뜨리면 새 테이블이 아예 생성 안 됨(런타임에 `no such table`). 이 repo는 이미 두 번 겪음: 9d(0005→0006, A2 run_presets와), 영역 B(0006→0007, 9d run_if_metrics와). 두 테이블 disjoint·`CREATE IF NOT EXISTS`라 번호는 순수 라벨이지만 execute 누락은 진짜 버그.

## 데이터셋 파싱 (`datasets/parse.rs`)

- **calamine API는 마이너 버전마다 시그니처가 바뀐다** (Slice 8b): 0.26에선 `open_workbook_from_rs`의 에러 타입이 associated type이라 `Xlsx<Cursor<Vec<u8>>>`로 reader 타입을 명시하고 `map_err(|e: XlsxError| ...)`로 클로저 인자 타입을 박아야 추론된다. `Data` enum 변형(`Float`/`Int`/`Bool`/`DateTime(ExcelDateTime)`/`Error` 등)은 0.26 기준. 새로 핀할 땐 `cargo doc -p calamine`로 확인하고 `parse_xlsx`만 조정 — 로직 불변.
- **§5↔§9 조정으로 preview 엔드포인트 추가** (Slice 8b): `POST /api/datasets`(파싱+저장)와 별개로 `POST /api/datasets/preview`(파싱만)를 둬서 "저장 전 미리보기 + override 즉시 재파싱" UX 구현. 둘 다 같은 `parse_upload` 호출.

## proto / abort 파이프라인

- **prost 구조체는 exhaustive라 proto 필드 추가 시 literal construction 사이트를 모두 고쳐야 한다** (Slice 7-1): `MetricBatch`에 `loop_stats` 필드를 추가하면 `MetricBatch { windows: ..., /* loop_stats 빠짐 */ }` 형태의 struct literal이 전부 컴파일 에러를 낸다. prost-generated 타입은 `..Default::default()` spread가 동작하지 않으므로 각 literal 사이트에 `loop_stats: vec![]`(또는 실제 값)를 명시해야 한다. **새 proto 필드 추가 = crate-wide grep 필수** (engine/worker-core/controller/테스트 전부). (8c도 동일: `RunPlan.data_binding`/`RunAssignment` 추가 시 worker·engine 테스트의 struct literal 전부에 `data_binding: None` 명시.)
- **proto enum 값 추가는 backward-compat 안전** (Slice 4 F3): `Phase::ABORTED = 4` 추가 시 기존 클라이언트가 새 값을 모르면 `unspecified`로 떨어진다. 새 worker→옛 controller, 옛 worker→새 controller 조합은 둘을 같이 배포하므로 일어날 일이 없다. 새 phase가 필요하면 그냥 추가.
- **abort 흐름의 belt-and-suspenders는 의도된 중복** (Slice 4 F4): REST endpoint가 DB에 'aborted'를 찍고(Task 10), worker는 `EngineError::Aborted`를 `Phase::Aborted`로 보내고(F3), `set_status` SQL은 `WHERE status != 'aborted'` guard를 가진다. REST 경로는 worker가 닿지 않을 때(crash, network 단절)도 abort UX가 동작하게 하고, gRPC 경로는 worker가 자기 상태를 정확히 보고하게 한다. e2e로 회귀를 잡으려면 두 safeguard를 동시에 깨야 RED가 난다.

## 데이터 바인딩 / 주입 (8c, `binding.rs`, run-create handler)

- **prost enum 필드는 `i32`로 전달된다** (Slice 8c): controller가 `policy as i32`로 보내면 worker에서 `pb::data_binding::Policy::try_from(i32).expect("controller와 worker는 함께 배포되므로 unknown variant 불가")`로 변환. `i32` 그대로 match하거나 `unwrap_or_default()`하면 조용히 `Unspecified`로 떨어진다. controller+worker 동시 배포이므로 unknown variant는 invariant 위반 — `expect`로 명시적 panic이 의도된 선택.
- **run-create handler에서 dataset meta를 두 번 fetch하면 TOCTOU 가능** (Slice 8c): gate(row_count/column 검증)와 resolution(슬라이싱/seed 계산)이 각각 `get_meta()`를 호출하면, gate 통과 후 dataset이 삭제된 경우 두 번째 `get_meta().expect()`가 패닉한다. meta를 한 번만 fetch해서 양쪽에 재사용할 것.
- **controller가 row_count를 전달 못 하면 `drop(tx)`로는 stream을 닫을 수 없다** (Slice 8c): worker가 `row_count` 행을 기다리며 블로킹 중일 때 controller sender를 drop해도 `state.active`에 clone이 살아있어 stream이 실제로 안 닫힌다. 대신 `ServerMessage::AbortRun`을 명시적으로 전송해야 worker 대기가 해제된다. (정상-종료 시의 `drop(tx)` EOF 패턴은 `crates/worker-core/CLAUDE.md` — 이 블로킹 케이스엔 안 통한다.)

## Run 프리셋 (`store/presets.rs`, `api/presets.rs`) (A2)

- **`validate_run_config`는 run-create와 preset-save가 공유하는 검증 게이트** (A2): 함수가 **검증된 `Option<DatasetMeta>`를 반환**해 resolution이 두 번째 `get_meta` 없이 재사용(TOCTOU 회피). preset 경로는 반환 meta를 무시(저장만). run-create가 권위 있는 최종 방어 — 저장 후 데이터셋 삭제 등은 실행 시점에 다시 거절됨.
- **`ApiError::ConflictJson(Value)`는 본문을 `{error}`로 감싸지 않고 그대로 반환** (A2): dataset delete soft-guard가 참조 프리셋 목록을 실어 보낼 때 사용. 일반 `Conflict(String)`은 여전히 `{error}` 래핑. 소비처(UI `deleteDataset`)는 본문 구조를 알고 파싱해야 함.
- **dataset DELETE 가드 2층** (A2): 활성(pending/running) run 참조 = hard 409(`?force=true` 불가), 프리셋만 참조(active run 없음) = soft 409 + `?force=true` override. soft 409 본문엔 `presets` 배열(없으면 hard). `presets` 배열 없이 409이면 hard로 간주해 throw.

## 환경 (`store/environments.rs`, `api/environments.rs`) (B-1)

- **environments는 top-level, FK/delete-guard 없음 (presets와 정반대)** (B-1): `run_presets`는 `scenario_id` FK + dataset delete soft-guard가 있지만, `environments`는 scenario_id/FK 없는 cross-scenario 리소스이고 **DELETE 무가드**다. 이유 = 오버레이가 스냅샷(B-2: RunDialog가 env 값을 해석해 평탄 `env` 맵으로 제출)이라 어떤 run/preset도 environment_id를 참조하지 않음 → 고아화 경로 자체가 없다. presets 패턴을 미러하되 가드 코드는 의도적으로 뺄 것. migration 0007(설계 시 0006 → 9d `run_if_metrics`가 0006 선점, 리넘버)도 `CREATE TABLE IF NOT EXISTS`(멱등).
- **`validate_env`의 var 키 규칙: 공백·`}`·`:` 금지** (B-1): `${KEY}`로 쓸 수 있어야 하므로. `:`는 `${NAME:-default}` 기본값 구분자(template.rs)에 대한 보수적 가드(bare `:`는 필요보다 넓지만 규칙 단순). 예약 시스템 변수명(vu_id/iter_id/loop_index)은 **거절 안 함** — 엔진이 시스템 값으로 해석하므로 UI가 soft warning만 노출. 검증은 CRUD 엔드포인트에서만.
- **`run_presets`는 `scenario_yaml` 스냅샷 없음** (A2): 프리셋은 라이브 시나리오를 추종(A1 retry의 "시나리오 변경 경고"가 프리셋엔 없는 이유). FK에 ON DELETE CASCADE 없음 — 현재 시나리오 삭제 엔드포인트 부재. 미래에 scenario-delete 추가 시 `ON DELETE CASCADE` 마이그레이션 필요(migration 0005 주석 참조).

## 테스트

- **e2e 테스트는 워커 바이너리를 매번 빌드** (Slice 4): `crates/controller/tests/e2e_test.rs::worker_bin_path()` 헬퍼 패턴 — `cargo build -p handicap-worker` 호출 → `CARGO_BIN_EXE_worker` 또는 `target/debug/worker` 경로. 새 e2e 테스트 추가 시 그대로 차용.
- **`dispatcher_kubernetes_test` 는 `slice6-k8s` feature 로 격리** — K8s 경로 테스트는 `deploy/CLAUDE.md` 참고(`build_job_spec` 단위 테스트 + e2e-kind 두 층).

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
- **localhost HTTP RTT는 microsecond 단위 → p95_ms = 0** (Slice 5): e2e 테스트에서 wiremock /ping이 sub-millisecond로 응답하면 `value_at_quantile(0.95) / 1_000` 이 0이 된다. `set_delay(Duration::from_millis(5))` 같은 인공 지연으로 p95 > 0 보장. UI에는 영향 없음(빠른 prod 백엔드도 보통 ms 단위).

## 저장소 / 마이그레이션 (SQLite, `store.rs`)

- **SQLite `ALTER TABLE ADD COLUMN` 은 idempotent 아님** (Slice 6): migration 0002 가 `runs.message` 컬럼을 추가하는데, 이미 마이그레이션된 DB 에서 controller 가 재시작되면 두 번째 ALTER 가 `duplicate column name` 으로 깨진다. 표준 가드는 `SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name = 'message'` 결과가 0 일 때만 ALTER. SQLite 는 `IF NOT EXISTS` 를 컬럼 단위로 지원하지 않으므로 이 패턴이 사실상 유일한 길.
- **`profile_json` 저장 방식 덕분에 runs 테이블 스키마 변경 없이 새 profile 필드 추가 가능** (Slice 7-1): `loop_breakdown_cap` 같은 새 profile 필드는 `#[serde(default)]` 하나로 기존 행 호환 — 옛 rows가 역직렬화될 때 default 값(256)이 자동 채워진다. 위 `ALTER TABLE` idempotency 함정과 대조적. profile에 새 필드를 더할 때는 **runs 테이블 migration이 필요 없다**.
- **dataset_rows cascade는 앱 레벨** (Slice 8b): SQLite FK cascade 대신 `DELETE FROM dataset_rows WHERE dataset_id=?`를 트랜잭션으로 먼저 실행. migration은 `CREATE TABLE IF NOT EXISTS`라 멱등(Slice 6/7-1 패턴, ALTER 회피).

## 데이터셋 파싱 (`datasets/parse.rs`)

- **calamine API는 마이너 버전마다 시그니처가 바뀐다** (Slice 8b): 0.26에선 `open_workbook_from_rs`의 에러 타입이 associated type이라 `Xlsx<Cursor<Vec<u8>>>`로 reader 타입을 명시하고 `map_err(|e: XlsxError| ...)`로 클로저 인자 타입을 박아야 추론된다. `Data` enum 변형(`Float`/`Int`/`Bool`/`DateTime(ExcelDateTime)`/`Error` 등)은 0.26 기준. 새로 핀할 땐 `cargo doc -p calamine`로 확인하고 `parse_xlsx`만 조정 — 로직 불변.
- **§5↔§9 조정으로 preview 엔드포인트 추가** (Slice 8b): `POST /api/datasets`(파싱+저장)와 별개로 `POST /api/datasets/preview`(파싱만)를 둬서 "저장 전 미리보기 + override 즉시 재파싱" UX 구현. 둘 다 같은 `parse_upload` 호출.

## proto / abort 파이프라인

- **prost 구조체는 exhaustive라 proto 필드 추가 시 literal construction 사이트를 모두 고쳐야 한다** (Slice 7-1): `MetricBatch`에 `loop_stats` 필드를 추가하면 `MetricBatch { windows: ..., /* loop_stats 빠짐 */ }` 형태의 struct literal이 전부 컴파일 에러를 낸다. prost-generated 타입은 `..Default::default()` spread가 동작하지 않으므로 각 literal 사이트에 `loop_stats: vec![]`(또는 실제 값)를 명시해야 한다. **새 proto 필드 추가 = crate-wide grep 필수** (engine/worker-core/controller/테스트 전부).
- **proto enum 값 추가는 backward-compat 안전** (Slice 4 F3): `Phase::ABORTED = 4` 추가 시 기존 클라이언트가 새 값을 모르면 `unspecified`로 떨어진다. 새 worker→옛 controller, 옛 worker→새 controller 조합은 둘을 같이 배포하므로 일어날 일이 없다. 새 phase가 필요하면 그냥 추가.
- **abort 흐름의 belt-and-suspenders는 의도된 중복** (Slice 4 F4): REST endpoint가 DB에 'aborted'를 찍고(Task 10), worker는 `EngineError::Aborted`를 `Phase::Aborted`로 보내고(F3), `set_status` SQL은 `WHERE status != 'aborted'` guard를 가진다. REST 경로는 worker가 닿지 않을 때(crash, network 단절)도 abort UX가 동작하게 하고, gRPC 경로는 worker가 자기 상태를 정확히 보고하게 한다. e2e로 회귀를 잡으려면 두 safeguard를 동시에 깨야 RED가 난다.

## 테스트

- **e2e 테스트는 워커 바이너리를 매번 빌드** (Slice 4): `crates/controller/tests/e2e_test.rs::worker_bin_path()` 헬퍼 패턴 — `cargo build -p handicap-worker` 호출 → `CARGO_BIN_EXE_worker` 또는 `target/debug/worker` 경로. 새 e2e 테스트 추가 시 그대로 차용.
- **`dispatcher_kubernetes_test` 는 `slice6-k8s` feature 로 격리** — K8s 경로 테스트는 `deploy/CLAUDE.md` 참고(`build_job_spec` 단위 테스트 + e2e-kind 두 층).

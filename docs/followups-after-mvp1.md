# Follow-ups (defer until after MVP1)

MVP1의 모든 슬라이스를 완료한 뒤 일괄 정리할 기술 부채와 후속 개선 항목. Slice 1 코드 리뷰에서 식별된 것이 출발점이고, 이후 슬라이스에서 추가되는 항목도 여기에 누적한다.

본 문서에 들어가는 기준:
- Slice 1의 in-scope 기능 동작에는 영향 없음
- 한 번에 batch로 처리하는 게 슬라이스마다 산발적으로 고치는 것보다 깔끔
- "다음 슬라이스에서 자연스럽게 다시 만질 코드"는 그 슬라이스 plan으로 옮긴다 (여기 두지 않음)

## Important (Slice 1 코드 리뷰)

### 1. e2e 테스트의 `pick_addr()` TOCTOU 경합
- 위치: `crates/controller/tests/e2e_test.rs:28-33`
- 현상: bind(port 0) → addr 추출 → drop → 다시 bind. 사이 윈도우에 다른 프로세스가 포트를 점유할 수 있음
- 영향: 로컬에선 거의 안 터지지만 CI 병렬 실행 시 flake 가능
- 픽스: 리스너를 drop하지 않고 그대로 `axum::serve(rest_listener, …)`에 넘기기
  ```rust
  let rest_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
  let rest_addr = rest_listener.local_addr().unwrap();
  // (don't drop — pass to serve)
  ```

### 2. e2e 테스트의 `std::process::Command` 동기 호출이 tokio 스레드 블록
- 위치: `crates/controller/tests/e2e_test.rs:42-46`
- 현상: `cargo build -p handicap-worker`를 동기 std::process로 호출 → 워커 스레드 1개가 빌드 끝날 때까지 점유
- 영향: 콜드 빌드 시 테스트가 수 초~수십 초 느려지고, 4-스레드 런타임의 1/4를 막음
- 픽스: `tokio::task::spawn_blocking`으로 감싸거나 `tokio::process::Command` 사용

### 3. `store::runs::set_status` 의 silent no-op
- 위치: `crates/controller/src/store/runs.rs:125-141`
- 현상: `UPDATE runs WHERE id = ?`가 `rows_affected = 0`이어도 `Ok(())` 반환
- 영향: 미존재 `run_id`로 status 업데이트 요청이 와도 조용히 통과. 현재 코드 경로상 도달 불가하지만 방어 부재
- 픽스: `result.rows_affected() != 1`이면 `warn!`이나 `Err` 반환

### 4. `GET /scenarios` / `GET /runs` list 엔드포인트 부재
- 위치: `crates/controller/src/app.rs`
- 현상: scope 표의 `POST/GET /scenarios`/`/runs`를 list 포함으로 자연 해석할 수 있으나 현재 구현은 `/{id}` get-by-id만 있음
- 영향: Slice 2 UI가 시나리오/런 목록을 보여주려면 list 엔드포인트가 필요. Slice 2 plan에 명시적으로 task 추가하는 게 자연스러움
- **결정 필요**: Slice 2 작성 시 명시적으로 다루기 — 본 문서에서 빼고 Slice 2 plan으로 옮길 것

## Minor (정리 가치 있는 잡다한 것들)

### 5. `template.rs:51` non-ASCII 문자 손상
- `out.push(bytes[i] as char)` — multi-byte UTF-8을 단일 byte char로 변환. ASCII만 다루면 무문제, 한글/일본어 등이 URL 리터럴 부분에 들어오면 mojibake
- 픽스: `&str`의 char iterator로 작성하거나 byte offset로 원본 슬라이스 push

### 6. `EngineError::AssertFailed` 가 dead code
- `crates/engine/src/error.rs:13-18` — 정의만 있고 생성하는 곳 없음. Slice 4의 assertion 강화에서 쓸 예정이라면 그때 추가. 지금은 `#[allow(dead_code)]` 또는 제거
- 참고: `AllVusFailed` (Slice 1 리뷰에서 추가)도 비슷한 패턴이지만 이건 실제로 사용된다

### 7. `now_ms` 함수 3중 중복
- `crates/controller/src/grpc/coordinator.rs:164`
- `crates/controller/src/store/scenarios.rs:55`
- `crates/controller/src/store/runs.rs:144`
- 픽스: `crate::store::now_ms()` 또는 `crate::util::now_ms()` 로 모아두기

### 8. `metrics.rs:26` `INSERT OR REPLACE` 의도와 동작 불일치
- 주석은 "handle late repeated keys"라 accumulate 의도처럼 들리지만 실제 동작은 row 교체. 같은 `(run_id, ts_second, step_id)` 키로 두 번 들어오면 첫 배치 데이터 소실
- Slice 1에선 발생 안 함 (단일 워커, 재전송 없음). Slice 4의 reconnect/backoff 도입 시 진짜 문제
- 픽스 후보:
  - `INSERT OR IGNORE` + 주석 명확화 (보수적)
  - `ON CONFLICT DO UPDATE SET count = count + excluded.count, ...` (accumulate)

### 9. 워커 종료 시 `sleep(200ms)` timing hack
- 위치: `crates/worker/src/main.rs:129`
- gRPC stream은 sender drop 시 in-flight 메시지를 flush함. 200ms는 안전마진일 뿐 정합성용은 아님
- 픽스: `drop(tx)` 명시 후 sleep 제거 (혹은 짧게 50ms로 줄이거나 0으로)

### 10. `client_for_scenario` 미사용 export
- 위치: `crates/engine/src/executor.rs` 끝부분
- pub fn이지만 어디서도 호출 안 됨. 유틸로 남겨두거나 제거

### 11. ADR-0018 cookie jar / ADR-0012 assertion-failure path 행동 테스트 부재
- 현재 `cookie_jar_off_parses` 는 YAML 파싱만 검증, 실제 cookie 지속/비지속 동작은 미검증
- assertion 실패(`status: 500` 모킹) 시 `error_count` 증가 + `ExecOutcome.error` 채워짐도 미검증
- 픽스: `crates/engine/tests/`에 wiremock 기반 행동 테스트 2개 추가

## Recommendations (구조적 개선, Slice 2+ 진행 중 반영 결정)

### 12. SQLite `PRAGMA foreign_keys = ON` 명시
- 위치: `crates/controller/src/store/mod.rs::connect()`
- SQLite는 FK 검사가 기본 OFF. 현재 `runs.scenario_id REFERENCES scenarios(id)`와 `run_metrics.run_id REFERENCES runs(id)` 제약은 사실상 무효
- 픽스: `SqliteConnectOptions::foreign_keys(true)` 또는 connect 직후 `PRAGMA foreign_keys = ON` 실행

### 13. `sqlx::migrate!` 매크로 기반 마이그레이션 전환
- 현재는 `include_str!("migrations/0001_initial.sql")` + `sqlx::query(...).execute()` + `CREATE TABLE IF NOT EXISTS`
- 한계: 버전 추적 없음, ALTER TABLE 안전하게 못 함, 마이그레이션 순서 보장 없음
- Slice 2가 schema 변경하기 전에 전환하는 게 합리적

### 14. 고-VU 환경에서 Aggregator lock 경합
- 위치: `crates/engine/src/runner.rs::run_vu`
- 모든 VU가 매 step outcome마다 `Arc<Mutex<Aggregator>>` lock 획득. 100+ VU 부하 테스트에서 직렬화 병목 가능
- 픽스: per-VU local Aggregator + 주기적 merge로 전환 (표준 패턴)
- Slice 4(ramp-up)에서 부하 늘 때 다시 보는 게 자연스러움

## 메모

- 본 문서는 _MVP1 종료 후_ 별도 cleanup 슬라이스에서 처리하는 것을 가정한다
- 슬라이스 진행 중 이 목록 항목 중 무엇이라도 자연스럽게 손에 닿으면 그때 정리하고 본 문서에서 제거할 것
- 새 follow-up은 시점·위치·픽스 후보를 같이 적어 추가

# Follow-ups (defer until after MVP1)

MVP1의 모든 슬라이스를 완료한 뒤 일괄 정리할 기술 부채와 후속 개선 항목. 새 follow-up은 시점·위치·픽스 후보를 같이 적어 아래 **"열린 항목"** 에 누적한다.

본 문서에 들어가는 기준:
- 현재 슬라이스의 in-scope 기능 동작에는 영향 없음
- 한 번에 batch로 처리하는 게 슬라이스마다 산발적으로 고치는 것보다 깔끔
- "다음 슬라이스에서 자연스럽게 다시 만질 코드"는 그 슬라이스 plan으로 옮긴다 (여기 두지 않음)

## 열린 항목

### A. subprocess 워커가 run 도중 비정상 종료해도 run이 `running`에 멈춤
- **시점/발견**: 2026-05-30, Slice 7/7-1 Playwright 검증 중. stale `target/debug/worker`가 `type: loop`를 못 읽어 worker가 run 시작 직후 exit 1.
- **위치**: `crates/controller/src/dispatcher/subprocess.rs`(worker exit 감지부 — 이미 `worker exited status …` 로그를 찍음) + `crates/controller/src/store/runs.rs::set_status`.
- **현상**: subprocess 모드에서 worker가 non-zero exit하면 controller가 exit를 로그로만 남기고 run status를 `failed`로 전이하지 않는다 → UI는 영영 `running` + 요청수 0. crash와 "느린 run"을 구분할 수 없다(검증 중 실제로 혼란).
- **영향**: 로컬 dev/진단 한정 갭. prod(K8s Job) 경로는 controller 재시작 시 in-progress run을 `failed`로 마크(Slice 6)하지만, controller가 살아있는 채 worker만 죽는 subprocess 경로는 미커버.
- **픽스 후보**: subprocess dispatcher가 worker exit를 await하는 지점에서 `exit_code != 0` && run이 아직 non-terminal이면 `set_status(run_id, 'failed', message = worker exit 사유)` 호출. `set_status`의 `status != 'aborted'` guard와 정합(이미 aborted면 덮어쓰지 않음). e2e 회귀: "parse 실패 시나리오 → run이 `failed`로 종료" 한 케이스.

## 처리 기록 (2026-05-30, branch `cleanup/mvp1-followups` → master)

Slice 1 코드 리뷰에서 출발해 누적된 14개 항목 + 동반 UI 수정 2건을 일괄 정리했다. 각 항목의 처리/근거:

- **#1 e2e `pick_addr()` TOCTOU** — `bind_local()`이 bound listener를 그대로 반환하고, REST는 `axum::serve(listener,…)`, gRPC는 `serve_with_incoming(TcpListenerStream)`로 소비. drop/rebind 윈도 제거.
- **#2 e2e 동기 `cargo build` 블로킹** — `worker_bin_path()`를 async화하고 빌드를 `spawn_blocking`으로 오프로드.
- **#3 `set_status` silent no-op** — `rows_affected != 1`이면 `warn!`. **`Ok(())`는 유지** — `WHERE status != 'aborted'` guard 상 0행은 "이미 aborted"인 정상 케이스라 `Err`로 바꾸면 abort 흐름이 깨진다.
- **#4 list 엔드포인트** — Slice 2에서 이미 구현 (DONE, 무변경).
- **#5 `template.rs` non-ASCII 손상** — literal passthrough를 `bytes[i] as char` 대신 zero-copy `push_str(&input[start..end])`로 재작성. 한글/이모지 URL 리터럴 보존.
- **#6 `EngineError::AssertFailed` dead code** — 제거 (생성처 없음).
- **#7 `now_ms` 3중 중복** — `crate::store::now_ms()`로 통합.
- **#8 `run_metrics` `INSERT OR REPLACE`** — `ON CONFLICT(run_id,ts_second,step_id) DO NOTHING`(keep-first 멱등)으로 변경. 윈도는 1초당 1회 emit되는 **완전 스냅샷**이라 재전송 = 동일 데이터 중복 → accumulate면 **중복 카운트**(그건 delta 기반 `run_loop_metrics`에만 맞음). FK ON 하 `INSERT OR REPLACE`의 delete/reinsert footgun도 회피.
- **#9 워커 종료 `sleep(200ms)`** — Slice 4 F6에서 `drop(tx)` + inbound await로 대체됨 (DONE, 무변경).
- **#10 `client_for_scenario` 미사용 export** — 제거(lib re-export 포함).
- **#11 assertion-failure 행동 테스트 부재** — wiremock 500 vs `assert status:200` → `error_count == total` 테스트 추가(`crates/engine/tests/assertions.rs`). cookie jar 행동 테스트는 이미 존재(`multi_step.rs`).
- **#12 `PRAGMA foreign_keys`** — `SqliteConnectOptions.foreign_keys(true)` 명시 + 회귀 테스트. (sqlx 0.8은 기본 ON이라 실질 동작은 이미 정상이었으나 invariant로 고정.)
- **#13 `sqlx::migrate!` 전환** — MOOT. Slice 6~7-1에서 manual `IF NOT EXISTS` + idempotency guard 패턴을 의도적으로 채택, 마이그레이션 3개까지 무리 없이 확장 중.
- **#14 Aggregator lock 경합** — DONE(실측). step×ts 윈도 분리 + 500ms flusher로 단일 히스토그램 경합이 없고, Slice 6 bench(20,389 RPS / p95 17ms)에서 병목 미관찰. `Arc<Mutex<Aggregator>>`는 유지.

동반 UI 수정(같은 배치): 신규 시나리오의 기본 `base_url` 변수 제거, Variables 패널 Add 버튼 오버플로우(flex `min-w-0`/`shrink-0`) 수정.

## 메모

- 새 follow-up은 "열린 항목"에 시점·위치·픽스 후보와 함께 추가한다.
- 슬라이스 진행 중 자연스럽게 손에 닿는 항목은 그때 정리하고 여기서 제거한다.

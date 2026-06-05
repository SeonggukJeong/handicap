# Follow-ups (defer until after MVP1)

MVP1의 모든 슬라이스를 완료한 뒤 일괄 정리할 기술 부채와 후속 개선 항목. 새 follow-up은 시점·위치·픽스 후보를 같이 적어 아래 **"열린 항목"** 에 누적한다.

본 문서에 들어가는 기준:
- 현재 슬라이스의 in-scope 기능 동작에는 영향 없음
- 한 번에 batch로 처리하는 게 슬라이스마다 산발적으로 고치는 것보다 깔끔
- "다음 슬라이스에서 자연스럽게 다시 만질 코드"는 그 슬라이스 plan으로 옮긴다 (여기 두지 않음)

## 열린 항목

현재 없음.

## 처리 기록 (2026-06-05) — subprocess 워커 비정상 종료 fail-fast (구 열린 항목 A)

- **발견(2026-05-30)**: subprocess 모드에서 worker가 non-zero exit해도 controller가 로그만 찍고 run을 `failed`로 전이하지 않아 UI가 영영 `running` + 0 req에 멈춤.
- **재조사(2026-06-05)**: 그 사이 **A3a(2026-06-02)** 가 coordinator `worker_disconnected` fail-fast + 60s 등록 watchdog을 추가했다. 현 코드에선 worker가 **register 후** 죽으면(시나리오 파싱 실패는 `main.rs`에서 register 뒤 발생 → `?` → Phase 보고 없이 exit) gRPC 스트림이 닫혀 `worker_disconnected`(phase=Started=비-terminal)가 run을 `Failed`로 전이한다 → **"영영 running"은 이미 해소.** 남은 잔여 갭 둘: ① **register 전 사망**(spawn 성공·connect 실패) 시 60s watchdog까지 `pending` 정체, ② gRPC 경로 실패는 `set_status`에 message 컬럼이 없어 **message=NULL**(reap는 exit code를 알지만 버림).
- **수정**: `runs::mark_failed_if_active(db, id, msg) -> bool`(가드 단일 UPDATE `WHERE status IN ('pending','running')`, terminal run 비클로버) 추가 + `SubprocessDispatcher`가 `db: Db`를 들고, 자식 reap 지점(`child.wait()`)에서 `!status.success()`면 `mark_failed_if_active` 호출. dispatcher는 자식 exit code를 보는 유일한 컴포넌트라 **즉시 실패 + 사유 message + defense-in-depth**(post-register 크래시 땐 `worker_disconnected`와 race하지만 둘 다 비-terminal 가드라 무해, 정상 완료/abort된 run은 exit 0이거나 이미 terminal이라 무영향). spawn 실패(`/nonexistent`)는 여전히 `dispatch` Err → codex item 2 경로(reap 미도달).
- **테스트**: 단위 `mark_failed_if_active_*`(active만 전이·terminal 비클로버) + 통합 `worker_nonzero_exit_marks_run_failed`(`/usr/bin/false`로 spawn→exit 1→run `failed`+message 재현). **엔진·워커·proto·마이그레이션 무변경**, ADR 불필요(additive). 함정 → `crates/controller/CLAUDE.md`.

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

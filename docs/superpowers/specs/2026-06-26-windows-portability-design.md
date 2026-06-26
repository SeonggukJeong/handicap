# Windows 빌드 이식성 + CI 결정성 (설계)

- 날짜: 2026-06-26
- 상태: 설계 (spec-plan-reviewer 대기)
- 출처: GitHub Actions에서 Windows Tauri 릴리즈(`release.yml`)와 `ci.yml`을 처음 실행하며 드러난 두 개의 선재(先在) 버그. 둘 다 본 작업의 워크플로 변경이 아니라 *코드*가 원인.

## 배경 / 문제

저장소를 GitHub에 게시하고 `release.yml`(windows-latest, Tauri NSIS/MSI)을 처음 돌리자 두 가지가 드러났다:

1. **(A) Windows 빌드 차단 — worker SIGTERM이 Unix 전용**
   `crates/worker/src/lib.rs:67`의 `spawn_sigterm`이 `use tokio::signal::unix::{SignalKind, signal};`를 **무조건** 사용한다. `tokio::signal::unix`는 `#![cfg(unix)]`이라 Windows 타깃엔 없다 → `error[E0432]: unresolved import 'tokio::signal::unix'`로 `handicap-worker` lib 컴파일 실패. desktop 번들이 `handicap-controller{bundle}` → `dep:handicap-worker`를 컴파일하므로 **Windows 인스톨러를 만들 수 없다.** (런북 `docs/dev/tauri-desktop-build.md`가 "Windows-검증 갭"으로 예고했던 그 빌드 — 지금껏 한 번도 Windows에서 컴파일된 적 없음.)
   - 전수 grep(`signal::unix|cfg(unix)|std::os::unix|killpg|libc|nix::|SignalKind` over `crates/{worker,controller,engine,worker-core}/src`, 테스트 제외) 결과 **워크스페이스 크레이트의 유일한 unix-ism = 이 함수 하나**. (killpg/Job Object 등 OS별 코드는 `desktop/`에 있고 이미 cfg 처리됨 — 본 슬라이스 범위 밖.)

2. **(B) `ci.yml` rust 잡 결정적 실패 — 좌표머신 하트비트 테스트가 CI에서 깨짐**
   `crates/controller/src/grpc/coordinator.rs`의 단위 테스트 `stale_busy_routes_worker_disconnected`가 GitHub ubuntu 러너에서 **두 번 연속** 실패(`left: Running, right: Failed` 1회 / 3137행 `.unwrap()` 패닉 1회 — 비결정적 시그니처). 로컬 nextest 게이트에선 통과.
   - 근본 원인(spec-plan-reviewer가 추적·정정): 이 테스트는 `tokio::time::advance(31s)`로 가상 시계를 31초 전진시키는데, 이 31초가 **sqlx 풀의 기본 acquire-timeout 30초를 초과**한다(`store/mod.rs:54` `SqlitePoolOptions`는 `max_connections`만 설정·커스텀 `acquire_timeout` 없음). 그 결과 advance 이후 첫 풀 acquire — 틱이 `.await`하는 `mark_failed_if_active` write(`coordinator.rs:1008`) 그리고/또는 테스트 자신의 `runs::get`(`:3137`) — 가 `PoolTimedOut`으로 실패한다. 이것이 관측된 **두 시그니처를 모두** 설명한다: `left: Running`(fail-write가 timeout → 상태가 Running으로 잔류) / `:3137` `.unwrap()` 패닉(read가 timeout). 느린/부하 높은 CI 러너에서 advance 직후 풀 경합이 30s 경계를 넘겨 flaky. **(주의: `enqueue`가 spawn하는 `run_watchdog`는 원인이 아니다 — `LONG`=3600s grace로 park돼 31s advance엔 발동 안 함. 초기 가설[watchdog 레이스]은 틀렸고, 구현자는 systematic-debugging으로 sqlx acquire-timeout 메커니즘을 재확인해 build-log에 정확한 원인을 기록할 것.)** CLAUDE.md가 명시한 함정 클래스(`start_paused`가 sqlx 풀 내부 timeout과 충돌 → `PoolTimedOut`, `watchdog_fires_after_deadline` 선례)와 동일 계열.
   - **제품 코드는 정상**: `pool_heartbeat_tick → pool_disconnect → worker_disconnected → mark_failed_if_active`는 전부 `.await`로 동기 완결된다(실서비스 하트비트 틱은 실제 `now`를 주입 — 레이스 없음). 따라서 B는 **테스트 전용** 결함이다.
   - 같은 파일에서 `advance(≥30s)`를 쓰는 다른 테스트(`stale_idle_evicted:3050`·`double_evict_idempotent:3143` 등)는 advance *이후* 풀 acquire가 없다 — 인메모리 풀 상태(`pool_idle_count` 등)만 읽는다. 오직 `stale_busy_routes_worker_disconnected`만 advance 후 sqlx 풀 acquire를 한다(`worker_disconnected`→`mark_failed_if_active` write + 테스트의 `runs::get`) → **수정 대상은 이 한 테스트뿐.**

## 목표 / 비목표

- **목표 A**: `handicap-worker`(및 그 그래프)가 Windows에서 컴파일되도록 `spawn_sigterm`을 크로스플랫폼화한다. → `release.yml`의 Windows 인스톨러 빌드가 진행될 수 있게.
- **목표 B**: `stale_busy_routes_worker_disconnected`를 CI에서 결정적으로 통과하게 만든다(가상시계 조작 제거 → advance(31s)가 sqlx 30s acquire-timeout을 넘기는 문제 제거). → `ci.yml` rust 잡 green.
- **불변식**: Unix(현 macOS/Linux) 런타임 동작 **byte-identical**. SIGTERM 처리 의미 보존. B는 제품 코드 무변경(테스트만).
- **비목표**: 데스크톱 셸의 R4d Windows Job Object 트리 종료(ADR-0042에서 "트리거-연기"로 명시 — 별도 후속), 실제 Windows 머신에서의 인스톨러 설치/실행 검증(런북 "Windows-검증 갭" 체크리스트로 후속), `desktop/` 크레이트 자체 변경.

## 설계

### A. `spawn_sigterm` 크로스플랫폼화 (`crates/worker/src/lib.rs`)

현재 spawned 태스크 본문을 cfg-split한다(시그니처·호출부·반환 타입 무변경 — `tokio::task::JoinHandle<()>` 유지):

- `#[cfg(unix)]` 분기: 기존 코드 verbatim 보존 — `tokio::signal::unix::{SignalKind, signal}`로 SIGTERM 대기 → 수신 시 `cancel.cancel()`. (Unix byte-identical.)
  - **결정적 디테일(crux)**: `use tokio::signal::unix::{SignalKind, signal};`는 현재 spawned 클로저 *최상단*(`lib.rs:67`)에 있다. 반드시 **`#[cfg(unix)]` 분기 *안쪽*으로 이동**해야 한다 — 클로저 스코프에 남겨두면 Windows에서 여전히 `E0432`라 수정이 무효가 된다.
- `#[cfg(windows)]` 분기: `tokio::signal::ctrl_c().await`로 Ctrl-C/콘솔 종료 대기 → 수신 시 `cancel.cancel()`. 실패 시 `warn!`. (워크스페이스 tokio가 `features=["full"]`라 `signal` 포함 → `ctrl_c`는 Windows에서 사용 가능.)
- 로그 문구는 분기별 적절히(Unix "SIGTERM received…", Windows "Ctrl-C received…").
- 근거: Windows엔 SIGTERM이 없다. 배포 형태(데스크톱 셸)에서 실제 트리 종료는 R4d Job Object가 담당(연기)하고, 컨트롤러 disconnect-cancel(R4b)이 run 취소를 처리하므로 이 핸들러는 콘솔-시그널 best-effort 폴백이다.

### B. `stale_busy_routes_worker_disconnected` 결정화 (`crates/controller/src/grpc/coordinator.rs`, 테스트 전용)

`pool_heartbeat_tick(now, stale)`이 `now: tokio::time::Instant`를 **인자**로 받으므로, 가상시계 조작 대신 **합성 미래 instant**를 주입한다:

- `tokio::time::pause()` + `tokio::time::advance(Duration::from_secs(31)).await` 제거.
- `pool_heartbeat_tick(tokio::time::Instant::now(), 30s)` → `pool_heartbeat_tick(tokio::time::Instant::now() + Duration::from_secs(31), 30s)`.
- 효과: `last_seen`(등록 시점, 실제 now)에 대해 `(now+31s).duration_since(last_seen) ≈ 31s > 30s` → stale 판정은 동일하게 결정적이되, **가상시계를 아예 안 쓰므로 advance(31s)가 sqlx 30s acquire-timeout을 넘기는 일이 사라진다**(실제 경과 시간은 밀리초). 풀 acquire가 정상 시간 내 완료 → `mark_failed_if_active` write·`runs::get` read 모두 결정적 성공.
- 단언 2건(idle_count==0, run status==Failed)·테스트 의도 불변. **구현자는 systematic-debugging으로 근본원인(advance(31s) > sqlx 30s acquire-timeout → 틱의 `mark_failed_if_active` write·`runs::get`이 `PoolTimedOut`)을 재확인**(예: 수정 전 반복/부하 실행으로 재현 시도; 결정 재현이 어려우면 코드 추적[`store/mod.rs:54` 커스텀 timeout 부재]으로 갈음)하고, 형제 advance-테스트는 advance 후 풀 acquire가 없어 영향받지 않음을 확인한다.

## 테스트 / 검증

- **A 로컬 한계**: macOS 호스트에서 Windows 타깃 `cargo check`는 불가(`ring` 등 C 의존이 Windows SDK 헤더 부재로 cross-compile 실패 — 실측됨). 따라서 A의 Windows 분기는 **CI의 실제 windows-latest 빌드가 유일한 검증**. 로컬에선 `cargo build/test -p handicap-worker`(Unix 분기 + cfg-split 구문 건전성) + 기존 `crates/worker/tests/sigterm_test.rs`(Unix SIGTERM 동작 회귀) green 확인.
- **B**: 수정 후 `cargo nextest run -p handicap-controller`(특히 해당 테스트)를 반복/부하 실행해 결정성 확인. workspace 전체 게이트 green.
- **수용 기준**: (1) `release.yml`이 windows-latest에서 worker 컴파일을 통과해 NSIS/MSI 빌드까지 진행, (2) `ci.yml` rust 잡이 안정적으로 green, (3) Unix 동작 byte-identical(기존 테스트 전부 통과·sigterm_test 포함).

## 리스크

- A의 Windows 분기는 로컬 미검증 → CI가 1차 검증. 표준 `tokio::signal::ctrl_c` API라 리스크 낮음(타이포 시 CI가 즉시 적발).
- B 근본원인은 sqlx 30s acquire-timeout 초과로 추적됨(spec-plan-reviewer 정정) — 구현자가 systematic-debugging으로 재확인 후 수정. 합성-now 접근은 가상시계를 아예 안 쓰므로 sqlx-timeout이든 다른 시계-레이스든 모두 제거한다.

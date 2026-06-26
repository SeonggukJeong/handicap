# Windows 빌드 이식성 + CI 결정성 (구현 플랜)

- 설계: `docs/superpowers/specs/2026-06-26-windows-portability-design.md` (spec-plan-reviewer **APPROVE-WITH-FIXES** → 두 fix 반영 완료)
- 브랜치: `worktree-windows-portability` (base = master `692eef2`)
- 범위: A(worker SIGTERM 크로스플랫폼) + B(coordinator 테스트 결정화). 둘 다 작고 독립 → **단일 TDD task·단일 green 커밋**(pre-commit whole-workspace 게이트 1회·handicap-reviewer가 whole-branch 1회 커버).

## 사전 준비 (구현 세션 시작 시)

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/windows-portability
cargo build -p handicap-worker --bin worker   # 워커 워밍(e2e race 방지, 루트 CLAUDE.md)
cargo build --workspace                        # baseline green 확인
```
UI 변경 없음 → `pnpm install` 불요. 새 마이그레이션·proto·UI 0.

## Task 1 — A(worker SIGTERM) + B(coordinator 테스트) (단일 green 커밋)

### A. `crates/worker/src/lib.rs` — `spawn_sigterm` 크로스플랫폼화 (`:64-80`)

spawned 태스크 본문을 cfg-split. 시그니처·호출부·반환 타입(`tokio::task::JoinHandle<()>`) **무변경**.

- `#[cfg(unix)]` 분기: 기존 로직 보존. **`use tokio::signal::unix::{SignalKind, signal};`를 이 분기 *안쪽*으로 이동**(클로저 최상단에 남기면 Windows에서 `E0432` 잔존 = 수정 무효 — spec crux). SIGTERM 대기 → `tracing::info!("SIGTERM received, cancelling run")` → `cancel_for_signal.cancel()`. 핸들러 설치 실패 시 기존대로 `warn!` + return.
- `#[cfg(windows)]` 분기: `match tokio::signal::ctrl_c().await { Ok(()) => { info!("Ctrl-C received, cancelling run"); cancel_for_signal.cancel(); } Err(e) => warn!(error=%e, "failed to install Ctrl-C handler") }`. (워크스페이스 tokio `features=["full"]` → `signal` 포함 → Windows에서 `ctrl_c` 가용.)
- 두 분기 모두 `cancel_for_signal`를 사용해 `-D warnings` unused-binding 회피.

### B. `crates/controller/src/grpc/coordinator.rs` — `stale_busy_routes_worker_disconnected` 결정화 (`:3099-3141`, 테스트 전용)

- `tokio::time::pause();` + `tokio::time::advance(std::time::Duration::from_secs(31)).await;` **두 줄 삭제**.
- `pool_heartbeat_tick(tokio::time::Instant::now(), Duration::from_secs(30))` → `pool_heartbeat_tick(tokio::time::Instant::now() + Duration::from_secs(31), Duration::from_secs(30))`.
- 단언 2건(idle_count==0, status==Failed)·주석·의도 불변. 제품 코드 무변경.
- 근거: 가상시계 미사용 → advance(31s)가 sqlx 30s acquire-timeout을 넘기는 메커니즘 자체가 제거됨(spec §B). `(now+31s).duration_since(last_seen)≈31s>30s`로 stale 판정 결정적.

### TDD / 검증 순서 (구현자)

1. **B 근본원인 재확인(systematic-debugging)**: 수정 *전* 상태에서 `stale_busy_routes_worker_disconnected`가 sqlx acquire-timeout으로 깨지는 메커니즘을 확인(예: 해당 테스트에 임시 로깅/반복 실행으로 `PoolTimedOut` 관측 시도 — 결정적 재현은 CI-부하 의존이라 어려울 수 있으니, 못 하면 코드 추적[advance 31s > pool 30s acquire-timeout, `store/mod.rs:54`에 커스텀 timeout 없음]으로 갈음하고 build-log에 정확한 원인 기록). **임시 로깅은 커밋 전 제거.**
2. **A·B 수정 적용**.
3. **로컬 게이트(macOS)**:
   - `cargo build -p handicap-worker && cargo build --workspace` green.
   - `cargo nextest run -p handicap-worker` + 기존 `crates/worker/tests/sigterm_test.rs`(Unix SIGTERM 회귀) green.
   - `cargo nextest run -p handicap-controller` green. **B는 결정성 확인을 위해** 해당 테스트를 반복 실행(예: `cargo nextest run -p handicap-controller stale_busy_routes_worker_disconnected --no-capture` 여러 회, 또는 `for i in $(seq 1 20); do ... ; done`) → 전부 pass.
   - `cargo nextest run --workspace` green.
   - `cargo clippy --workspace --all-targets -- -D warnings` green.
   - **A의 Windows 분기는 macOS에서 컴파일·검증 불가**(`ring` C 의존이 Windows SDK 헤더 부재로 cross-compile 실패 — spec §테스트). → 표준 `tokio::signal::ctrl_c` API라 리스크 낮고, **release.yml의 windows-latest 빌드가 1차 검증**(머지 후).
4. **단일 green 커밋**: `fix(worker,controller): worker SIGTERM Windows 이식성 + coordinator 하트비트 테스트 결정화`. (커밋은 `run_in_background:false` 단일 호출·폴링 금지·파이프 금지 — 루트 CLAUDE.md.)

### Acceptance

- [ ] `spawn_sigterm`가 `#[cfg(unix)]`/`#[cfg(windows)]`로 분리되고 `use signal::unix`가 unix 분기 *안*에 있음(grep으로 확인 — 클로저 최상단에 잔존 0).
- [ ] Unix 동작 byte-identical: `sigterm_test.rs` + 워크스페이스 nextest 전부 green.
- [ ] `stale_busy_routes_worker_disconnected`에 `tokio::time::pause/advance` 부재(grep 0), 반복 실행 전부 pass.
- [ ] `cargo build/clippy/nextest --workspace` green(macOS). proto/migration/UI/제품-코드(B) diff 0.

## 최종 리뷰 (구현 세션, Task 후)

- **handicap-reviewer**(1M 세션이면 `model: opus` 명시) — 단일-task라 whole-branch 리뷰: cfg-split 정확성(use 위치·unused 0)·Unix byte-identical·B 테스트-전용(제품 0-diff)·와이어/migration 무변경 확인.
- **security-reviewer**: N/A — diff가 요청실행/템플릿/env·dataset 바인딩/업로드/trace 뷰어 무관(signal 핸들러 + 테스트). finish-slice §0 grep이 무매치면 스킵.
- **라이브 검증**: WAIVED — A는 signal 핸들러(run-생성/report-파싱/Zod 경로 무관·Unix는 `sigterm_test`가 커버·Windows 분기는 로컬 검증 불가→CI 빌드가 1차), B는 테스트-전용. 실제 Windows 설치/종료 검증은 런북 "Windows-검증 갭" 체크리스트로 후속(ADR-0042 R4d와 함께). 근거를 build-log에 명시.

## 머지 후 (finish-slice)

1. ff-merge → master.
2. **`v0.1.0` 릴리즈 재트리거**: 태그를 새 master HEAD로 이동(`git tag -f -a v0.1.0` → 원격 삭제+재푸시) → `release.yml`이 worker 컴파일을 통과해 NSIS/MSI 빌드까지 진행하는지 모니터(첫 Windows 빌드라 비-unix-ism 이슈[툴링·경로]가 더 나올 수 있음 — 나오면 후속 수정).
3. **build-log 기록**: 정확한 B 원인(sqlx 30s acquire-timeout, watchdog 아님)·A cfg-split·라이브 WAIVED 근거·"Windows-검증 갭"은 여전히 열림(installer 실행 미검증).
4. CLAUDE.md 상태줄·roadmap·메모리 갱신.

## 리뷰 이력

- spec: spec-plan-reviewer APPROVE-WITH-FIXES(B 근본원인 watchdog→sqlx acquire-timeout 정정·A `use` 위치 명시) → 3 doc-fix 반영 → 재확인 clean **APPROVE**.
- plan: spec-plan-reviewer **APPROVE**(구현 스텝·범위·게이트·waiver 정확, 코드/구조 변경 불요).

REVIEW-GATE: APPROVED


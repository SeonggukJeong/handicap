# 워커 (`crates/worker-core` + `crates/worker`) 함정

이 파일은 `crates/worker-core/` 또는 `crates/worker/` 파일을 건드릴 때 자동 로드되는 중첩 CLAUDE.md다. 프로젝트 전역 규칙·git 토폴로지·검증 훅·일하는 모드는 루트 `CLAUDE.md` 참고. 엔진/컨트롤러/UI 함정은 각 디렉토리의 CLAUDE.md.

`worker-core`는 재연결/backoff/시그널 등 단위 테스트 가능한 로직 lib. `worker`는 CLI 파싱 + wiring 만 남긴 bin.

## crate 구조

- **Bin-only crate 는 단위 테스트가 안 됨 → `worker-core` lib 분리** (Slice 6): 원래 plan 은 `reconnect.rs`/backoff 를 `crates/worker/` (bin crate) 안에 두려고 했다. 하지만 bin crate 의 모듈은 외부에서 import 못 해서 `tokio::time::pause()` 기반 단위 테스트를 붙일 수가 없다. Task 0 에서 `crates/worker-core/` 를 sibling lib 로 추출한 뒤 `worker/src/main.rs` 는 CLI parsing + wiring 만 남겼다. **새 패턴: worker 측 로직에 진짜 단위 테스트가 필요하면 `worker-core/src/` 로, bin 은 wiring 만.**

## gRPC 연결 / 셧다운

- **tonic `Channel::from_shared` 오류 타입** (Slice 1): `tonic::transport::Error` 아니라 `tonic::codegen::http::uri::InvalidUri`. WorkerError에 따로 variant 필요.
- **gRPC bidi stream의 클린 셧다운 = mpsc drain ≠ wire deliver** (Slice 4 F6): `tx.send().await`는 채널 버퍼 진입만 보장, wire 전송은 아니다. tokio runtime이 main 종료로 spawn된 task를 cancel하면 tonic 내부 송신 머신도 함께 죽어 HTTP/2 END_STREAM이 안 나간다. 패턴: 마지막 메시지 send → `drop(tx)` (outbound EOF 신호) → 상대가 우리 EOF 보고 자기 쪽 close → 우리 `inbound_fwd.await` 완료 시점이 곧 "far end가 처리 완료" sync point. 200ms `sleep` 같은 fixed delay는 둘 다 race-prone하고 슬로우.

## backoff / 취소 / 시그널

- **tokio JoinHandle drop ≠ abort** (Slice 1): handle을 drop해도 spawn된 task는 detached로 계속 돈다. 종료시키려면 명시적으로 `.abort()`.
- **`tokio::time::pause()` 는 `tokio::time::Instant` 와 짝** (Slice 6): backoff retry 의 누적 시간을 `std::time::Instant::now()` 로 트래킹하면 paused clock 을 무시하고 wall-clock 으로 흘러서 "60초 cap 검증" 단위 테스트가 진짜 60초를 기다린다. `tokio::time::Instant` 로 바꾸고, 추가로 `tokio = { workspace = true, features = ["test-util"] }` 가 dev-deps 에 있어야 `#[tokio::test(start_paused = true)]` 가 활성화된다.
- **Bare `tokio::time::sleep` 은 cancel 안 됨** (Slice 6): SIGTERM 핸들러 1차 구현이 `connect_with_backoff` **뒤에** 설치되어, backoff sleep 중에 SIGTERM 이 와도 process 가 정지하지 못했다. 테스트는 "어쨌든 kernel 의 default action 으로 죽음" 으로 잘못 green 이었음. Fix: (a) handler 를 main 맨 앞에 등록, (b) backoff 의 sleep 을 `tokio::select! { _ = sleep(d) => ..., _ = cancel.cancelled() => return Err(Cancelled) }` 로 감쌈, (c) `WorkerError::Cancelled` variant 추가해서 bin 이 `return Ok(())` (exit 0) 로 끝나게. (워커 SIGTERM 핸들러는 **connect 전에** 설치되어야 K8s `terminationGracePeriodSeconds` 안에 graceful `Phase::Aborted` 보고가 된다.)

## 데이터셋 로딩 (8c)

- **worker `load_dataset`은 `abort_listener` spawn 전에 호출해야 한다** (Slice 8c): `abort_listener`가 `inbound_rx`를 move하므로, 그 이후에 `load_dataset(&mut inbound_rx)`를 호출하면 빌림 에러. 실행 순서: `load_dataset` 완료(엔진 시작 전 `row_count` 행 수신 — abort/cancel→Aborted, 조기 종료→Failed) → `abort_listener` spawn.

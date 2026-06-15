# 워커 (`crates/worker-core` + `crates/worker`) 함정

이 파일은 `crates/worker-core/` 또는 `crates/worker/` 파일을 건드릴 때 자동 로드되는 중첩 CLAUDE.md다. 프로젝트 전역 규칙·git 토폴로지·검증 훅·일하는 모드는 루트 `CLAUDE.md` 참고. 엔진/컨트롤러/UI 함정은 각 디렉토리의 CLAUDE.md.

`worker-core`는 재연결/backoff/시그널 등 단위 테스트 가능한 로직 lib. `worker`는 CLI 파싱 + wiring 만 남긴 bin.

## crate 구조

- **Bin-only crate 는 단위 테스트가 안 됨 → `worker-core` lib 분리** (Slice 6): 원래 plan 은 `reconnect.rs`/backoff 를 `crates/worker/` (bin crate) 안에 두려고 했다. 하지만 bin crate 의 모듈은 외부에서 import 못 해서 `tokio::time::pause()` 기반 단위 테스트를 붙일 수가 없다. Task 0 에서 `crates/worker-core/` 를 sibling lib 로 추출한 뒤 `worker/src/main.rs` 는 CLI parsing + wiring 만 남겼다. **새 패턴: worker 측 로직에 진짜 단위 테스트가 필요하면 `worker-core/src/` 로, bin 은 wiring 만.**
- **`--worker-id`는 optional + `JOB_COMPLETION_INDEX` fallback** (A3a): 멀티워커 fan-out 에서 subprocess 디스패처는 자식마다 distinct `--worker-id`(ULID)를 명시 전달하지만, K8s Indexed Job(A3c)은 Pod 가 자기 인덱스만 알아 `--worker-id`를 못 받는다. `Args.worker_id: Option<String>` + 순수 헬퍼 `resolve_worker_id(arg, run_id, JOB_COMPLETION_INDEX)`: arg 있으면 그대로, 없으면 `"{run_id}-w{index}"`(env 없으면 index 0). bin wiring 함수라 worker-core 가 아닌 `worker/src/main.rs`의 인라인 `#[cfg(test)]`로 테스트(순수 함수라 `tokio::time` 불필요). 워커는 `RunPlan.vus = assignment.vu_count`, `vu_offset = assignment.vu_offset`로 자기 샤드만 돈다(단일워커는 vu_count=총VU/offset=0 → byte-identical). ADR-0027.

## gRPC 연결 / 셧다운

- **tonic `Channel::from_shared` 오류 타입** (Slice 1): `tonic::transport::Error` 아니라 `tonic::codegen::http::uri::InvalidUri`. WorkerError에 따로 variant 필요.
- **gRPC bidi stream의 클린 셧다운 = mpsc drain ≠ wire deliver** (Slice 4 F6): `tx.send().await`는 채널 버퍼 진입만 보장, wire 전송은 아니다. tokio runtime이 main 종료로 spawn된 task를 cancel하면 tonic 내부 송신 머신도 함께 죽어 HTTP/2 END_STREAM이 안 나간다. 패턴: 마지막 메시지 send → `drop(tx)` (outbound EOF 신호) → 상대가 우리 EOF 보고 자기 쪽 close → 우리 `inbound_fwd.await` 완료 시점이 곧 "far end가 처리 완료" sync point. 200ms `sleep` 같은 fixed delay는 둘 다 race-prone하고 슬로우.
- **inbound 스트림의 정상 종료는 `Err`로 온다 — `WorkerLink.shutdown` 플래그로 로그 레벨을 가른다** (codex eval item 4): 컨트롤러가 우리 EOF를 받고 자기 쪽을 닫으면 `forward_inbound`의 `inbound.next()`는 `None`이 아니라 **h2 `Status`(`"error reading a body"`, code Unknown)**를 뱉는다. 이걸 `warn`으로 찍으면 **성공한 run마다** 전송 실패처럼 보인다. `connect_and_register`가 `Arc<AtomicBool> shutdown`을 만들어 forwarder에 넘기고 `WorkerLink.shutdown`으로도 노출 — main이 **terminal RunStatus send 직후·`drop(tx)` 직전**에 `shutdown.store(true)`를 찍으면 그 다음 close는 expected(`debug`), 안 찍힌 mid-run close는 unexpected(`warn`). **새 워커 종료/exit 경로(terminal status + drop(tx))를 추가하면 그 직전에 `shutdown.store(true, Ordering::Relaxed)`를 넣어야** 한다(안 그러면 그 경로의 정상 종료가 warn으로 샌다). 단 dataset-load **fail** 경로(166)는 close가 이미 일어난 진짜 비정상이라 의도적으로 flag를 안 set(warn 유지)하고 abort 경로(148)·happy 경로만 set한다. 레벨 변별은 `client::forward_tests`(최소 `LevelCapture` Subscriber, tracing-subscriber 무의존)가 검증. 메트릭 forwarder의 "controller stream closed" send 실패도 `error!`→`debug!`(트레일링 배치 유실은 종료 시 benign).
- **워커 기본 로그 필터 = `info`(`main.rs`의 `EnvFilter::new("info")` fallback) + subprocess 워커는 부모의 `RUST_LOG`를 상속** (codex eval item 4 검증법): dispatcher가 `Stdio::inherit`라 워커 로그가 테스트 출력에 섞여 나온다. 워커 로그 변경을 e2e로 검증하려면 — "정상 종료가 warn을 안 내는지"는 기본(info)으로 `cargo test -p handicap-controller --test e2e_test <name> -- --nocapture | grep`(매치 0이면 OK), "expected close가 debug로 찍히는지"는 `RUST_LOG=handicap_worker_core=debug`로 켜고 grep. tracing-subscriber 무의존 레벨 캡처는 `client::forward_tests`의 `LevelCapture` 패턴.

## backoff / 취소 / 시그널

- **tokio JoinHandle drop ≠ abort** (Slice 1): handle을 drop해도 spawn된 task는 detached로 계속 돈다. 종료시키려면 명시적으로 `.abort()`.
- **`tokio::time::pause()` 는 `tokio::time::Instant` 와 짝** (Slice 6): backoff retry 의 누적 시간을 `std::time::Instant::now()` 로 트래킹하면 paused clock 을 무시하고 wall-clock 으로 흘러서 "60초 cap 검증" 단위 테스트가 진짜 60초를 기다린다. `tokio::time::Instant` 로 바꾸고, 추가로 `tokio = { workspace = true, features = ["test-util"] }` 가 dev-deps 에 있어야 `#[tokio::test(start_paused = true)]` 가 활성화된다.
- **Bare `tokio::time::sleep` 은 cancel 안 됨** (Slice 6): SIGTERM 핸들러 1차 구현이 `connect_with_backoff` **뒤에** 설치되어, backoff sleep 중에 SIGTERM 이 와도 process 가 정지하지 못했다. 테스트는 "어쨌든 kernel 의 default action 으로 죽음" 으로 잘못 green 이었음. Fix: (a) handler 를 main 맨 앞에 등록, (b) backoff 의 sleep 을 `tokio::select! { _ = sleep(d) => ..., _ = cancel.cancelled() => return Err(Cancelled) }` 로 감쌈, (c) `WorkerError::Cancelled` variant 추가해서 bin 이 `return Ok(())` (exit 0) 로 끝나게. (워커 SIGTERM 핸들러는 **connect 전에** 설치되어야 K8s `terminationGracePeriodSeconds` 안에 graceful `Phase::Aborted` 보고가 된다.)

## 데이터셋 로딩 (8c)

- **worker `load_dataset`은 `abort_listener` spawn 전에 호출해야 한다** (Slice 8c): `abort_listener`가 `inbound_rx`를 move하므로, 그 이후에 `load_dataset(&mut inbound_rx)`를 호출하면 빌림 에러. 실행 순서: `load_dataset` 완료(엔진 시작 전 `row_count` 행 수신 — abort/cancel→Aborted, 조기 종료→Failed) → `abort_listener` spawn.
- **`load_dataset`→`load_datasets`(복수): binding_index 버킷으로 N개 동시 적재** (다중 데이터셋 바인딩): `load_datasets(inbound_rx, expected: &[u64], run_id, cancel)`가 `expected.len()` 버킷을 만들고 각 `DatasetBatch`를 `binding_index`로 라우팅, **`total_got == sum(expected)`까지 드레인**(스트림 순서 무관 — 배치가 섞여 와도 OK, 알 수 없는 binding_index는 카운트 없이 무시). 조기종료(`recv()→None`)→`DatasetIncomplete{got=수신합, expected=약속합}`→Failed, our-run Abort/cancel→`Cancelled`→Aborted(단일 `load_dataset`과 동일 에러 매핑). 워커 main은 proto field 10 `data_bindings` 우선·비면 field 5 `data_binding` 1-원소 fallback(컨트롤러는 field 10만 emit) → `bindings.iter().zip(buckets)`로 `Vec<Arc<DataSet>>`. **`row_count==0` 바인딩은 빈 datasets로 떨어뜨림**(레거시 None 경로와 byte-identical) — `!bindings.is_empty()`로 완화 금지(엔진에 약속한 버킷 수 불일치). `map_policy(i32)` 헬퍼가 try_from 매핑(동반배포라 unknown=`unreachable!`). 적재는 여전히 `abort_listener`/`forwarder` spawn 전(위 불변식).

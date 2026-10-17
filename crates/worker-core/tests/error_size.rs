// clippy `result_large_err`(기본 임계 128바이트)는 Rust 1.99에서 `WorkerError`를 잡아
// CI rust 잡을 깨뜨렸다(로컬 stable 1.97은 미발화 — rust-toolchain.toml이 `stable`만 고정).
// 툴체인 버전과 무관하게 같은 경계를 지키도록 크기를 직접 단언한다.
use handicap_worker_core::WorkerError;

#[test]
fn worker_error_stays_under_clippy_large_err_threshold() {
    let size = std::mem::size_of::<WorkerError>();
    assert!(
        size <= 128,
        "WorkerError is {size} bytes (clippy result_large_err threshold 128)"
    );
}

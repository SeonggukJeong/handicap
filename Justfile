default: build

build:
    cargo build --workspace

test:
    cargo test --workspace

fmt:
    cargo fmt --all

lint:
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings

run-controller:
    RUST_LOG=info,handicap_controller=debug,handicap_engine=debug cargo run -p handicap-controller -- --db ./handicap.db --rest 127.0.0.1:8080 --grpc 127.0.0.1:8081 --worker-bin target/debug/worker

# Direct worker run for manual testing (controller normally spawns it)
run-worker run_id worker_id:
    RUST_LOG=info,handicap_worker=debug,handicap_engine=debug cargo run -p handicap-worker -- --controller http://127.0.0.1:8081 --run-id {{run_id}} --worker-id {{worker_id}}

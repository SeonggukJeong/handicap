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

ui-install:
    cd ui && pnpm install --frozen-lockfile

ui-dev:
    cd ui && pnpm dev

ui-build:
    cd ui && pnpm build

ui-lint:
    cd ui && pnpm lint

ui-test:
    cd ui && pnpm test

# Run the controller with the UI dir set (build the UI first if needed).
run-controller-with-ui:
    @if [ ! -f ui/dist/index.html ]; then just ui-build; fi
    RUST_LOG=info,handicap=debug cargo run -p handicap-controller -- \
      --db ./handicap.db \
      --rest 127.0.0.1:8080 \
      --grpc 127.0.0.1:8081 \
      --worker-bin target/debug/worker \
      --ui-dir ui/dist

build-image image='handicap:dev':
    IMAGE={{image}} ./scripts/build-image.sh

helm-lint:
    helm lint deploy/helm/handicap

chart-snapshot:
    ./deploy/helm/handicap/tests/snapshot_test.sh

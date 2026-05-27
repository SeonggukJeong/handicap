# Handicap

Internal load-testing tool. See `docs/superpowers/specs/` for design.

## Quickstart (Slice 1, backend only)

```
rustup show              # ensure toolchain installed
brew install protobuf just
just build
just test
```

## Slice 2 — UI quickstart

```bash
# 1. Install Node deps (only first time)
just ui-install

# 2. Build the workers + UI
cargo build -p handicap-worker
just ui-build

# 3. Run controller serving the built UI on http://127.0.0.1:8080/
just run-controller-with-ui

# 4. (Alternative) UI dev server with hot reload on :5173, proxying /api → :8080:
cargo run -p handicap-controller -- --db ./handicap.db --worker-bin target/debug/worker  # in one terminal
just ui-dev                                                                                # in another
# Browse http://127.0.0.1:5173/
```

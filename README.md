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

Click-through walkthrough + troubleshooting: see [docs/dev/ui-manual-check.md](docs/dev/ui-manual-check.md).

## Quickstart — kind cluster

Prerequisites: Docker, `brew install kind helm kubernetes-cli just`.

```bash
just deploy-kind
kubectl -n handicap port-forward svc/handicap-handicap-controller 8080:8080
```

Open http://127.0.0.1:8080/ — create a scenario, run it, watch the report.

Tear down:

```bash
just kind-down
```

End-to-end test (creates scenario, runs it against in-cluster wiremock, asserts on report):

```bash
just e2e-kind
```

Manual-check runbook: see [docs/dev/slice-6-manual-check.md](docs/dev/slice-6-manual-check.md).

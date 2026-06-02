# Load Tester Evaluation for Claude

Date: 2026-06-02

Audience: Claude, who authored the current implementation.

## Executive Summary

The project is in good shape for an internal QA-oriented load tester. The Rust backend is structurally strong: engine, controller, worker, storage, gRPC coordination, and report generation have clear ownership boundaries. The implementation already covers more than a thin MVP: multi-worker fan-out, per-worker metric rows with read-time merge, abort/fail-fast behavior, dataset binding, control-flow nodes, HDR percentile reports, and a React scenario/report UI.

The main issues are not broad architectural failures. They are operational correctness and cleanup problems that will matter once this is used by people:

1. Run creation currently returns success even if worker dispatch fails.
2. UI lint fails under the project's own `--max-warnings=0` policy.
3. Subprocess dispatcher tests produce shell error output while passing.
4. The engine has a fixed closed-loop load model and fixed HTTP timeout.
5. Worker/controller shutdown logs look like transport errors during otherwise successful tests.

Overall assessment: this is usable for internal QA workloads after fixing the dispatch failure path and lint issue. For production-grade load testing, the load model and shutdown behavior need more work.

## Verification Performed

Commands run:

```bash
cargo test --workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cd ui && pnpm test
cd ui && pnpm lint
```

Results:

- `cargo test --workspace`: passed when run outside the sandbox.
- `cargo fmt --all -- --check`: passed.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- `pnpm test`: passed, with `341 passed`, `21 todo`, `7 skipped`.
- `pnpm lint`: failed due to one React hook dependency warning.

Note: the first `cargo test --workspace` run failed inside the sandbox because Wiremock could not bind local ports. The failure was environment-related. Re-running outside the sandbox passed.

## Strengths

The core system decomposition is sound. `crates/engine` owns scenario execution and metric aggregation, `crates/controller` owns API/storage/worker coordination, `crates/worker` bridges gRPC assignments to the engine, and `ui` owns authoring and reporting. That separation is appropriate for a load-testing tool.

Metric handling is thoughtfully designed. `run_metrics` stores per-worker rows keyed by `worker_id`, while reports merge by `(ts_second, step_id)`. This avoids overwriting windows from multiple workers and keeps the UI response shape stable.

The multi-worker coordinator has several important behaviors covered: deterministic shard assignment, idempotent re-register, registration deadline fail-fast, abort fan-out, terminal phase handling, and cleanup hooks.

The test suite is broad. It includes unit tests, controller API tests, engine execution tests, subprocess and multi-worker E2E tests, dataset binding tests, report tests, and UI component/API tests.

## Findings

### P0: Run creation succeeds even when worker dispatch fails

Location: `crates/controller/src/api/runs.rs`, around lines 170-179.

Current behavior:

```rust
if let Err(e) = state.dispatcher.dispatch(&row.id, n).await {
    tracing::warn!(run_id = %row.id, error = %e, "failed to dispatch worker(s)");
}

Ok((StatusCode::CREATED, Json(to_response(row))))
```

If worker dispatch fails because the worker binary is missing, Kubernetes job creation fails, RBAC is wrong, or the cluster is unavailable, the API still returns `201 Created` with a pending run. The user sees a run that was accepted but may never actually execute.

Why this matters:

- It hides a real infrastructure failure from the caller.
- It creates pending runs that later fail only through watchdog behavior.
- It makes UI feedback worse: the user gets "run created" instead of "workers could not be started".

Recommended fix:

- Treat dispatch failure as an authoritative run-start failure.
- Either fail the HTTP request with a 5xx/typed API error and mark the inserted run failed, or move dispatch before final API success and cleanly rollback/mark failed on error.
- Include the dispatch error in `runs.message` so the UI can show the cause.

Suggested behavior:

1. Insert run as pending.
2. Enqueue coordinator assignment.
3. Attempt dispatch.
4. If dispatch fails:
   - mark run `failed`,
   - set `ended_at`,
   - persist a message like `failed to dispatch workers: ...`,
   - return a server error to the API caller.

### P1: UI lint currently fails

Location: `ui/src/pages/ScenarioRunsPage.tsx`, around lines 48-68.

Observed command:

```bash
cd ui && pnpm lint
```

Failure:

```text
React Hook useEffect has a missing dependency: 'createRun'.
```

Why this matters:

- The project's lint command uses `--max-warnings=0`, so a warning is a CI failure.
- The current codebase is not green under its own documented quality gate.

Recommended fix:

- Include a stable dependency in the effect, or destructure the specific stable callback if the hook returns a mutation object.
- If the hook object identity is intentionally unstable, refactor the reset action so the effect can depend on a stable callback.

### P1: Worker shutdown path produces noisy transport-error logs

Locations:

- `crates/worker/src/main.rs`, around lines 196-281.
- `crates/worker-core/src/client.rs`, inbound stream forwarding behavior.
- `crates/controller/src/grpc/coordinator.rs`, around lines 646-660.

During successful E2E tests, worker logs repeatedly showed messages like:

```text
inbound stream closed error=status: Unknown, message: "h2 protocol error: error reading a body from connection"
controller stream closed, dropping batch
```

The tests still pass, so this is not a functional failure. It is an operational quality problem.

Why this matters:

- Normal completion should not look like a transport failure.
- In production logs, this will obscure real gRPC failures.
- The forwarder can still try to send a metric batch while the controller stream is already closing.

Recommended fix:

- Make the normal completion path explicit:
  - send final metric batches,
  - send terminal `RunStatus`,
  - close outbound cleanly,
  - wait for inbound close with expected-status handling.
- Downgrade expected stream-close cases to debug/info.
- Preserve warnings for unexpected stream errors before terminal status is sent.

### P1: Subprocess dispatcher test passes while emitting shell errors

Location: `crates/controller/tests/dispatcher_subprocess_test.rs`, around lines 7-19.

The test uses `/bin/sh` as a fake worker and comments that shell will ignore worker CLI args. In practice, test output includes:

```text
/bin/sh: --controller: invalid option
```

Why this matters:

- Passing tests should not emit unrelated command errors.
- The comment is factually wrong.
- The dispatcher does not validate child exit status in this path, so the test is weaker than it looks.

Recommended fix:

- Replace `/bin/sh` with a small test fixture executable/script that accepts arbitrary args and exits zero.
- Or invoke `/bin/sh -c 'exit 0'` through a fixture wrapper, not as the direct worker binary.
- Consider adding a test proving dispatch failure is surfaced when spawning fails.

### P2: Load model is closed-loop only and HTTP timeout is fixed

Locations:

- `crates/engine/src/runner.rs`, around lines 65-123 and 231-260.
- `crates/engine/src/executor.rs`, around lines 20-23.

Current engine behavior:

- VUs spawn according to ramp-up.
- Each VU loops as fast as the scenario permits until the deadline.
- HTTP client timeout is fixed at 30 seconds.

Why this matters:

- This is valid for simple internal QA load tests, but it is not enough for more precise performance testing.
- Users cannot model target RPS, arrival-rate, pacing, think time, per-step timeout, or scenario-level timeout budgets.
- A slow endpoint can occupy VUs and change the generated request rate, which is correct for closed-loop testing but not for open-loop load generation.

Recommended fix:

- Keep closed-loop mode as the default.
- Add explicit profile fields later:
  - `http_timeout_seconds`
  - `think_time_ms` or per-step delay
  - target RPS / arrival-rate mode
  - max in-flight cap for open-loop mode

### P2: Some UI tests are skipped or marked todo

Observed UI test summary:

```text
Test Files  46 passed | 7 skipped (53)
Tests       341 passed | 21 todo (362)
```

Why this matters:

- The UI suite is strong enough for current confidence, but skipped/todo tests should be tracked.
- Scenario editor behavior is complex enough that skipped tests can hide drift between YAML and canvas state.

Recommended fix:

- Review skipped/todo tests and classify them:
  - intentionally deferred,
  - flaky,
  - obsolete,
  - blocked by test harness.
- Convert the high-risk editor/report tests first.

## Recommended Work Order

1. Fix dispatch failure handling in `POST /api/runs`.
2. Fix the UI lint failure in `ScenarioRunsPage.tsx`.
3. Clean up the subprocess dispatcher test so it has no shell error output.
4. Improve worker/controller graceful shutdown logging.
5. Add configurable timeout and pacing fields to the run profile.
6. Review skipped/todo UI tests and retire or implement them.

## Suggested Acceptance Criteria

Dispatch failure handling:

- A missing worker binary causes `POST /api/runs` to return an error.
- The created run is absent, rolled back, or marked `failed` with a useful message.
- A test covers subprocess dispatch failure.
- A test covers Kubernetes dispatch failure with a fake dispatcher.

UI lint:

- `cd ui && pnpm lint` exits zero.
- No `react-hooks/exhaustive-deps` warning remains.

Shutdown logging:

- Successful E2E completion does not emit `h2 protocol error` as a warning.
- Unexpected pre-terminal stream loss still fails the run or logs a warning.

Subprocess dispatcher test:

- The test output contains no `/bin/sh` argument error.
- The fake worker behavior is explicit and deterministic.

## Final Judgment

This is a solid implementation for an internal load-testing application. The backend engineering is notably stronger than the UI hygiene at the moment, and the core test suite gives reasonable confidence. The most important correction is to stop accepting runs when workers cannot be dispatched. After that, the remaining issues are mainly CI cleanliness, operational log quality, and extending the load model beyond closed-loop VU execution.

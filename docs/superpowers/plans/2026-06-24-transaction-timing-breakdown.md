# Transaction Timing Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose each request's TTFB into DNS / connect(TCP+TLS) / wait(server) phases plus the existing download phase, reporting connect phases as a run-level connection-cost summary and wait per-step, surfaced with a visual UI card + waterfall/chips toggle.

**Architecture:** Reuse the existing `phase_stats` pipeline (executor → `record_phase` → `MetricFlush.phase_stats` → proto → `run_phase_metrics` → `build_report` → UI) with NEW phase name strings. A new engine `conn_timing` module installs a custom reqwest `Resolve` (times DNS) + a `connector_layer` (times DNS+TCP+TLS) that write into a `task_local` cell read by `execute_step` after `send().await`. The controller rolls `dns`/`connect` rows up to a run-level `ConnectionStats` and attaches `wait` per-step. **proto = 0, migration = 0, worker logic = 0.**

**Tech Stack:** Rust (reqwest 0.12.28, tower 0.5, hyper-util, hdrhistogram, tokio task_local), TypeScript/React (Zod, Recharts not needed — pure CSS bars), Tailwind.

## Global Constraints

- **proto unchanged · migration unchanged · worker logic unchanged.** New phases ride the existing `MetricBatch.phase_stats` vector and `run_phase_metrics(run_id, step_id, phase TEXT, hdr, count)` table. `phase` is a free string (`coordinator.proto:57` reserves `"dns/tcp/tls/total later"`).
- **No new `MetricFlush` drain vector / no new send-guard.** `dns`/`connect`/`wait` are recorded via the existing `Aggregator::record_phase` into the existing `phase_stats` channel (drain 6 / send-guard 5 already handle it).
- **`measure_phases` OFF → byte-identical.** Instrumentation (resolver + connector_layer) is installed ONLY when `measure_phases` is on (per-run opt-in, `RunDialog.tsx:740`, proto `measure_phases=11`). OFF runs construct the client exactly as today and record no new phase rows.
- **tower version unifies:** root `Cargo.toml:48` = `tower = "0.5"` → locks to `tower 0.5.3` = reqwest 0.12.28's tower → the `Layer`/`Service` traits accepted by `connector_layer` are the same crate. Add `tower.workspace = true` to `crates/engine/Cargo.toml` (lock's `tower 0.4.13` is an unrelated subtree).
- **connector layer must be TYPE-OPAQUE.** reqwest's `Unnameable`/`Conn` (`connect.rs:1290/1298`) are crate-private — never name them. Write the timing service generic over `S: Service<Req>`, boxing the future.
- **All user-facing text via `ko.ts` (ADR-0035)** — including `aria-label`/`title`. Josa after interpolated values uses `(으)로`/`(은)는` paired forms.
- **UI Zod nullability:** `ReportStep.wait` + `ReportJson.connection` use serde `skip_serializing_if` → Zod `.optional()` (NOT `.nullish()`). `ConnectionStats` inner numeric fields (`connections_opened`/`requests_total`/`reuse_ratio`) are always serialized when `connection: Some` → plain `z.number()` (NOT `.optional()`/`.nullish()` — avoids `number|undefined` `tsc -b` trap; mirrors B7-C `download`).
- **Arithmetic:** `connect = connect_total − dns`, `wait = latency − connect_total` (both saturating). `connect_total` is timed by the connector_layer (⊇ dns), `dns` by the resolver, `latency` brackets `send().await` (⊇ connect_total).
- **Attribution is approximate (documented):** under hyper pool contention a background-spawned connect (`hyper-util client.rs:446`) escapes the task-local → `connections_opened` slightly undercounts. Acceptable for a diagnostic.

**Spec:** `docs/superpowers/specs/2026-06-24-transaction-timing-breakdown-design.md` (R1–R11). Each task notes which R-ids it satisfies.

---

### Task 1: Engine connector-instrumentation spike (throwaway — NOT committed)

**Purpose:** Validate the central assumption (R1/R3-2) that a custom `Resolve` + `connector_layer` + `task_local` actually populates per-request DNS/connect timing inline on the request's task, BEFORE building the real feature. If it fails, fall back to a connection-level shared-handle aggregate (spec §7).

**Files:**
- Create (throwaway): `crates/engine/Cargo.toml` add `tower.workspace = true` (keep — needed by Task 2).
- Create (throwaway): `crates/engine/src/bin/spike_conn_timing.rs` — delete before committing Task 2.

**Interfaces:**
- Produces (validated, carried into Task 2): the exact working shapes of `TimingResolver: reqwest::dns::Resolve`, `TimingConnectorLayer: tower::Layer`, `tokio::task_local! { CONN_TIMING: Cell<ConnTiming> }`.

- [ ] **Step 1: Add `tower` to the engine crate**

In `crates/engine/Cargo.toml`, under `[dependencies]` (next to `reqwest.workspace = true`):

```toml
tower = { workspace = true }
```

- [ ] **Step 2: Write the spike binary**

Create `crates/engine/src/bin/spike_conn_timing.rs`:

```rust
// THROWAWAY spike (plan Task 1) — delete before committing Task 2.
// Validates: custom Resolve (DNS timing) + connector_layer (connect timing) +
// task_local populate per-request timing inline on the request's task.
use std::cell::Cell;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Instant;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use tower::{Layer, Service};

#[derive(Default, Clone, Copy)]
struct ConnTiming {
    dns_us: u64,
    connect_total_us: u64,
}

tokio::task_local! {
    static CONN_TIMING: Cell<ConnTiming>;
}

struct TimingResolver;
impl Resolve for TimingResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let start = Instant::now();
            let addrs = tokio::net::lookup_host((host.as_str(), 0)).await?;
            let us = start.elapsed().as_micros().min(u64::MAX as u128) as u64;
            let _ = CONN_TIMING.try_with(|c| {
                let mut t = c.get();
                t.dns_us = t.dns_us.saturating_add(us);
                c.set(t);
            });
            let out: Addrs = Box::new(addrs.collect::<Vec<SocketAddr>>().into_iter());
            Ok(out)
        })
    }
}

#[derive(Clone)]
struct TimingConnectorLayer;
impl<S> Layer<S> for TimingConnectorLayer {
    type Service = TimingConnector<S>;
    fn layer(&self, inner: S) -> Self::Service {
        TimingConnector { inner }
    }
}

#[derive(Clone)]
struct TimingConnector<S> {
    inner: S,
}
impl<S, Req> Service<Req> for TimingConnector<S>
where
    S: Service<Req>,
    S::Future: Send + 'static,
    S::Response: Send,
    S::Error: Send,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<S::Response, S::Error>> + Send>>;
    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), S::Error>> {
        self.inner.poll_ready(cx)
    }
    fn call(&mut self, req: Req) -> Self::Future {
        let fut = self.inner.call(req);
        let start = Instant::now();
        Box::pin(async move {
            let out = fut.await;
            if out.is_ok() {
                let us = start.elapsed().as_micros().min(u64::MAX as u128) as u64;
                let _ = CONN_TIMING.try_with(|c| {
                    let mut t = c.get();
                    t.connect_total_us = t.connect_total_us.saturating_add(us);
                    c.set(t);
                });
            }
            out
        })
    }
}

#[tokio::main]
async fn main() {
    let url = std::env::args().nth(1).unwrap_or_else(|| "https://example.com".into());
    let client = reqwest::Client::builder()
        .dns_resolver(Arc::new(TimingResolver))
        .connector_layer(TimingConnectorLayer)
        .build()
        .unwrap();

    for i in 0..3 {
        let t = CONN_TIMING
            .scope(Cell::new(ConnTiming::default()), async {
                let _ = client.get(&url).send().await.unwrap().bytes().await.unwrap();
                CONN_TIMING.with(|c| c.get())
            })
            .await;
        println!(
            "req {i}: dns_us={} connect_total_us={} (expect req0 connect>0, req1+ =0 reused)",
            t.dns_us, t.connect_total_us
        );
    }
}
```

- [ ] **Step 3: Run the spike against a real host**

Run: `cargo run -p handicap-engine --bin spike_conn_timing -- https://example.com`
Expected: it compiles (validates `connector_layer`/`dns_resolver` accept the types), and prints `req 0` with `connect_total_us > 0` and `dns_us > 0`, then `req 1`/`req 2` with `connect_total_us == 0` (connection reused). This confirms per-request inline attribution.

- [ ] **Step 4: Delete the spike binary**

```bash
rm crates/engine/src/bin/spike_conn_timing.rs
```

Keep the `tower` dependency line. Do NOT commit (Task 2 carries the validated code + the dep in one commit). If the spike showed `connect_total_us == 0` on req 0 (attribution failed), STOP and report — the design needs the §7 shared-handle fallback.

---

### Task 2: Engine — conn_timing module + executor + runner + tests

**Files:**
- Modify: `crates/engine/Cargo.toml` (the `tower` dep from Task 1 — keep it)
- Create: `crates/engine/src/conn_timing.rs`
- Modify: `crates/engine/src/lib.rs` (add `mod conn_timing;`)
- Modify: `crates/engine/src/executor.rs` (`VuClient` field + `with_timeout` sig + `ExecOutcome` fields + `execute_step`)
- Modify: `crates/engine/src/runner.rs:349,:954,:1111` (pass `measure_phases` to `VuClient::with_timeout`) + `runner.rs:471-485` (record wait/dns/connect)

**Interfaces:**
- Produces: `crate::conn_timing::{ConnTiming, send_collecting}`, `ExecOutcome { dns: Option<Duration>, connect: Option<Duration>, wait: Option<Duration> }`, `VuClient::with_timeout(cookie_mode, timeout, measure_phases: bool)`.
- Consumes: existing `Aggregator::record_phase(step_id, phase, latency_us)` (unchanged signature).

- [ ] **Step 1: Write the failing test (attribution + byte-identical)**

Append to `crates/engine/src/executor.rs` `mod tests`:

```rust
#[tokio::test]
async fn execute_step_measures_connect_on_first_request_only_when_measuring() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/c"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&server)
        .await;
    let step = HttpStep {
        id: "01HX0000000000000000000050".into(),
        name: "c".into(),
        request: Request {
            method: HttpMethod::Get,
            url: format!("{}/c", server.uri()),
            headers: BTreeMap::new(),
            body: None,
            disabled: DisabledRows::default(),
        },
        assert: vec![],
        extract: vec![],
        timeout_seconds: None,
        think_time: None,
    };
    let vars = BTreeMap::new();
    let env = empty_env();
    let ctx = TemplateContext { vars: &vars, env: &env, vu_id: 0, iter_id: 0, loop_index: None };

    // measure on: first request opens a connection (connect Some), second reuses it (connect None).
    let client = VuClient::with_timeout(
        crate::scenario::CookieJarMode::Off,
        std::time::Duration::from_secs(30),
        true,
    )
    .unwrap();
    let first = execute_step(&client, &step, &ctx).await.unwrap();
    let second = execute_step(&client, &step, &ctx).await.unwrap();
    assert!(first.connect.is_some(), "first request pays connect cost");
    assert!(first.wait.is_some(), "wait measured whenever measuring");
    assert!(second.connect.is_none(), "reused connection has no connect cost");
    assert!(second.wait.is_some(), "wait still measured on reuse");

    // measure off: no phase timing at all (byte-identical path).
    let plain = VuClient::with_timeout(
        crate::scenario::CookieJarMode::Off,
        std::time::Duration::from_secs(30),
        false,
    )
    .unwrap();
    let o = execute_step(&plain, &step, &ctx).await.unwrap();
    assert!(o.connect.is_none() && o.dns.is_none() && o.wait.is_none());
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p handicap-engine execute_step_measures_connect_on_first_request_only_when_measuring`
Expected: FAIL — `with_timeout` takes 2 args, `ExecOutcome` has no `connect`/`wait`/`dns`.

- [ ] **Step 3: Create the conn_timing module**

Create `crates/engine/src/conn_timing.rs`:

```rust
//! Per-request connection-phase timing (transaction breakdown, opt-in via `measure_phases`).
//!
//! A custom reqwest [`Resolve`] times DNS; a [`tower::Layer`] over the connector times the
//! whole connect (DNS+TCP+TLS). Both write into a `task_local` cell that `execute_step` sets
//! around `send().await` and reads afterward. Installed ONLY when measuring → off = byte-identical.
//!
//! Attribution is approximate: under hyper pool contention a background-spawned connect
//! (`hyper-util client.rs:446`) escapes the task-local. Acceptable for a diagnostic.
use std::cell::Cell;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Instant;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use tower::{Layer, Service};

/// DNS + connect(TCP+TLS) microseconds collected for one request. `0` ⇒ connection reused.
#[derive(Default, Clone, Copy)]
pub struct ConnTiming {
    pub dns_us: u64,
    pub connect_total_us: u64,
}

tokio::task_local! {
    static CONN_TIMING: Cell<ConnTiming>;
}

/// Custom DNS resolver: resolves via `tokio::net::lookup_host` (behaviour-equivalent to the
/// default GAI resolver for explicit hosts) and records the elapsed time into `CONN_TIMING`.
pub struct TimingResolver;

impl Resolve for TimingResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let start = Instant::now();
            let addrs = tokio::net::lookup_host((host.as_str(), 0)).await?;
            let us = start.elapsed().as_micros().min(u64::MAX as u128) as u64;
            let _ = CONN_TIMING.try_with(|c| {
                let mut t = c.get();
                t.dns_us = t.dns_us.saturating_add(us);
                c.set(t);
            });
            let out: Addrs = Box::new(addrs.collect::<Vec<SocketAddr>>().into_iter());
            Ok(out)
        })
    }
}

/// `tower::Layer` that wraps the (crate-private) reqwest connector to time the whole connect.
#[derive(Clone)]
pub struct TimingConnectorLayer;

impl<S> Layer<S> for TimingConnectorLayer {
    type Service = TimingConnector<S>;
    fn layer(&self, inner: S) -> Self::Service {
        TimingConnector { inner }
    }
}

/// Type-opaque connector wrapper — never names reqwest's `Unnameable`/`Conn` (crate-private).
#[derive(Clone)]
pub struct TimingConnector<S> {
    inner: S,
}

impl<S, Req> Service<Req> for TimingConnector<S>
where
    S: Service<Req>,
    S::Future: Send + 'static,
    S::Response: Send,
    S::Error: Send,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<S::Response, S::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), S::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Req) -> Self::Future {
        let fut = self.inner.call(req);
        let start = Instant::now();
        Box::pin(async move {
            let out = fut.await;
            if out.is_ok() {
                let us = start.elapsed().as_micros().min(u64::MAX as u128) as u64;
                let _ = CONN_TIMING.try_with(|c| {
                    let mut t = c.get();
                    t.connect_total_us = t.connect_total_us.saturating_add(us);
                    c.set(t);
                });
            }
            out
        })
    }
}

/// Build a reqwest builder's resolver+connector instrumentation (only call when measuring).
pub fn install(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    builder
        .dns_resolver(Arc::new(TimingResolver))
        .connector_layer(TimingConnectorLayer)
}

/// Run `req.send()` inside the timing task-local when `measure` is set, returning the response
/// result and the collected `ConnTiming`. When `measure` is false this is a bare `send()`
/// (no task-local scope) so the off path is byte-identical.
pub async fn send_collecting(
    req: reqwest::RequestBuilder,
    measure: bool,
) -> (reqwest::Result<reqwest::Response>, ConnTiming) {
    if measure {
        CONN_TIMING
            .scope(Cell::new(ConnTiming::default()), async move {
                let r = req.send().await;
                let t = CONN_TIMING.with(|c| c.get());
                (r, t)
            })
            .await
    } else {
        (req.send().await, ConnTiming::default())
    }
}
```

- [ ] **Step 4: Register the module**

In `crates/engine/src/lib.rs`, add alongside the other `mod` declarations:

```rust
mod conn_timing;
```

- [ ] **Step 5: Add the `measure_phases` field + 3-arg `with_timeout` to VuClient**

In `crates/engine/src/executor.rs`, replace the `VuClient` struct + impl (lines ~15-39):

```rust
/// Per-VU HTTP client. Holds its own cookie jar so sessions are isolated.
pub struct VuClient {
    inner: reqwest::Client,
    /// When true, the client is instrumented (resolver+connector) and `execute_step`
    /// brackets `send()` in the timing task-local. False ⇒ byte-identical to pre-feature.
    measure_phases: bool,
}

impl VuClient {
    /// Back-compat constructor: 30s total request timeout, no phase instrumentation.
    pub fn new(cookie_mode: CookieJarMode) -> Result<Self> {
        Self::with_timeout(cookie_mode, Duration::from_secs(30), false)
    }

    /// Build a client with an explicit total request timeout and optional phase
    /// instrumentation. `run_vu`/`run_arrival`/`run_vu_curve` thread `RunPlan.http_timeout`
    /// and `RunPlan.measure_phases`; `new` delegates here with the 30s default + off.
    pub fn with_timeout(
        cookie_mode: CookieJarMode,
        timeout: Duration,
        measure_phases: bool,
    ) -> Result<Self> {
        let mut builder = reqwest::Client::builder()
            .timeout(timeout)
            .user_agent("handicap/0.1");
        if let CookieJarMode::Auto = cookie_mode {
            let jar = Arc::new(Jar::default());
            builder = builder.cookie_provider(jar);
        }
        if measure_phases {
            builder = crate::conn_timing::install(builder);
        }
        let inner = builder.build()?;
        Ok(Self {
            inner,
            measure_phases,
        })
    }
}
```

- [ ] **Step 6: Add the 3 phase fields to ExecOutcome**

In `crates/engine/src/executor.rs`, extend `ExecOutcome` (after `download`):

```rust
#[derive(Debug, Clone)]
pub struct ExecOutcome {
    pub step_id: String,
    pub status: u16,
    pub latency: Duration,
    /// Body-download time (B7-C). `Some` only on the success path.
    pub download: Option<Duration>,
    /// DNS resolution time — `Some` only when this request opened a NEW connection
    /// (reused connections ⇒ `None`). Transaction breakdown (this slice).
    pub dns: Option<Duration>,
    /// connect(TCP+TLS) time (= connect_total − dns). `Some` only on a new connection.
    pub connect: Option<Duration>,
    /// Server-wait time (= latency − connect_total). `Some` whenever measuring (per request).
    pub wait: Option<Duration>,
    pub error: Option<String>,
    pub extracted: BTreeMap<String, String>,
}
```

- [ ] **Step 7: Bracket `send()` and compute phases in execute_step**

In `crates/engine/src/executor.rs`, replace the send block (lines ~154-156):

```rust
    let started = Instant::now();
    let (outcome, timing) = crate::conn_timing::send_collecting(req, client.measure_phases).await;
    let latency = started.elapsed();

    // Phase decomposition (only when measuring). `wait` is meaningful on any successful send
    // (server processing); dns/connect only when this request opened a new connection.
    let (dns, connect, wait) = if client.measure_phases {
        let lat_us = latency.as_micros().min(u64::MAX as u128) as u64;
        let wait = Some(Duration::from_micros(lat_us.saturating_sub(timing.connect_total_us)));
        if timing.connect_total_us > 0 {
            let tcp_tls = timing.connect_total_us.saturating_sub(timing.dns_us);
            (
                Some(Duration::from_micros(timing.dns_us)),
                Some(Duration::from_micros(tcp_tls)),
                wait,
            )
        } else {
            (None, None, wait)
        }
    } else {
        (None, None, None)
    };
```

Then in the same function, set the new fields on each `ExecOutcome` constructed under `Ok(resp)` (both the body-read-failure early-return AND the final success return) to `dns, connect, wait` (the computed values — the send succeeded so they are valid). On the `Err(e)` (send failure) arm set all three to `None` (transport failed → no phase sample). Concretely:

- body-read-fail return (~line 181): add `dns, connect, wait,` (computed values).
- success return (~line 218): add `dns, connect, wait,`.
- `Err(e)` return (~line 227): add `dns: None, connect: None, wait: None,`.

- [ ] **Step 8: Record the phases in the runner (single site)**

In `crates/engine/src/runner.rs`, the existing `if measure_phases { if let Some(dl) = outcome.download { a.record_phase(&outcome.step_id, "download", ...); } }` block (lines ~471-485). Extend it to also record the new phases:

```rust
                    if measure_phases {
                        if let Some(dl) = outcome.download {
                            a.record_phase(
                                &outcome.step_id,
                                "download",
                                dl.as_micros().min(u64::MAX as u128) as u64,
                            );
                        }
                        if let Some(w) = outcome.wait {
                            a.record_phase(
                                &outcome.step_id,
                                "wait",
                                w.as_micros().min(u64::MAX as u128) as u64,
                            );
                        }
                        if let Some(d) = outcome.dns {
                            a.record_phase(
                                &outcome.step_id,
                                "dns",
                                d.as_micros().min(u64::MAX as u128) as u64,
                            );
                        }
                        if let Some(c) = outcome.connect {
                            a.record_phase(
                                &outcome.step_id,
                                "connect",
                                c.as_micros().min(u64::MAX as u128) as u64,
                            );
                        }
                    }
```

- [ ] **Step 9: Thread `measure_phases` into the 3 VuClient construction sites**

In `crates/engine/src/runner.rs`, each of these reads a `measure_phases` local already in scope (from `plan.measure_phases`). Add it as the 3rd arg:

- `:349` (closed `run_vu`): `VuClient::with_timeout(scenario.cookie_jar, http_timeout, measure_phases)?`
- `:954` (`run_vu_curve`): `VuClient::with_timeout(scenario.cookie_jar, http_timeout, measure_phases)?`
- `:1111` (`run_scenario_open_loop` slot-pool, `Arc`): `Arc::new(VuClient::with_timeout(scenario.cookie_jar, http_timeout, measure_phases)?)` (keep the surrounding `Arc::new(...)`).

If any of those functions does not have a `measure_phases` local in scope, thread it from the function's `RunPlan` parameter (the value is `plan.measure_phases`, already a parameter in the runner functions per `runner.rs:347,442,950`).

- [ ] **Step 10: Run the new test + verify it passes**

Run: `cargo test -p handicap-engine execute_step_measures_connect_on_first_request_only_when_measuring`
Expected: PASS.

- [ ] **Step 11: Run the full engine + workspace build (no regressions)**

Run: `cargo build -p handicap-worker && cargo build --workspace --tests && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run -p handicap-engine`
Expected: 0 errors, all engine tests pass (existing download/executor tests unchanged since they read fields, not construct `ExecOutcome`).

- [ ] **Step 12: Commit**

```bash
git add crates/engine/Cargo.toml crates/engine/src/conn_timing.rs crates/engine/src/lib.rs crates/engine/src/executor.rs crates/engine/src/runner.rs
git commit -m "feat(engine): DNS/connect/wait phase timing via task-local connector instrumentation (transaction breakdown)"
```

(Run `git status` first to confirm `crates/engine/src/bin/spike_conn_timing.rs` is gone — it must NOT be in the commit.)

---

### Task 3: Controller — wait per-step + run-level ConnectionStats rollup

**Files:**
- Modify: `crates/controller/src/report.rs` (add `wait` to `ReportStep`, add `ConnectionStats` + `connection` to `ReportJson`, accumulate `wait`/`dns`/`connect` in `build_report`)
- Modify: `crates/controller/src/export.rs` (its `report_with_steps`/`ReportStep`/`ReportJson` test fixtures construct literals — add the new fields; compiler-driven)
- Modify: `crates/controller/src/insights.rs` (its `step` helper at `:388` constructs a `ReportStep` literal — add `wait: None`; compiler-driven. `step_err` `:489` mutates `step()`'s result, no literal there.)

**Interfaces:**
- Consumes: `phases: &[PhaseMetricRow]` (already a `build_report` param) now also carries `phase ∈ {"wait","dns","connect"}` rows.
- Produces: `ReportStep.wait: Option<PhaseStats>`, `ReportJson.connection: Option<ConnectionStats>` with `ConnectionStats { dns: PhaseStats, connect: PhaseStats, connections_opened: u64, requests_total: u64, reuse_ratio: f64 }`.

- [ ] **Step 1: Write the failing test**

Append to `crates/controller/src/report.rs` `mod tests`, mirroring `build_report_attaches_download_phase_to_step` (report.rs:1645) EXACTLY — it uses the real helpers `run_row()` (`:736`), `win(window_idx, step_id, count, errors, status_json, &[hdr_samples_us])` (`:772`), `make_hdr_bytes(&[us])` (`:726`), and constructs `PhaseMetricRow` with a leading `run_id: r.id.clone()` (5 fields; `count: i64`):

```rust
#[test]
fn build_report_rolls_up_connection_phases_and_attaches_wait() {
    use crate::store::metrics::PhaseMetricRow;
    let r = run_row();
    let yaml = "version: 1\nname: t\nsteps: []\n";
    // one http window: step "s1", count=10 → requests_total=10
    let rows = vec![win(100, "s1", 10, 0, r#"{"200":10}"#, &[10_000])];
    let phases = vec![
        PhaseMetricRow { run_id: r.id.clone(), step_id: "s1".into(), phase: "wait".into(), hdr_histogram: make_hdr_bytes(&[50_000]), count: 10 },
        PhaseMetricRow { run_id: r.id.clone(), step_id: "s1".into(), phase: "dns".into(), hdr_histogram: make_hdr_bytes(&[2_000]), count: 2 },
        PhaseMetricRow { run_id: r.id.clone(), step_id: "s1".into(), phase: "connect".into(), hdr_histogram: make_hdr_bytes(&[15_000]), count: 2 },
    ];
    let rep = build_report(&r, yaml, &rows, &[], &[], &[], &phases, &[]);
    // wait attaches per-step
    let s = rep.steps.iter().find(|s| s.step_id == "s1").unwrap();
    assert!(s.wait.is_some(), "wait phase attaches to step");
    // dns/connect roll up to run-level connection block (NOT per-step)
    let c = rep.connection.as_ref().expect("connection rollup present");
    assert_eq!(c.connections_opened, 2, "= connect sample count");
    assert_eq!(c.requests_total, 10);
    assert!((c.reuse_ratio - 0.8).abs() < 1e-9, "1 - 2/10 = 0.8");
    assert!(c.dns.p50_ms <= 3 && c.connect.p50_ms >= 14);
    // no connection rows → None (byte-identical)
    let rep2 = build_report(&r, yaml, &rows, &[], &[], &[], &[], &[]);
    assert!(rep2.connection.is_none());
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p handicap-controller build_report_rolls_up_connection_phases_and_attaches_wait`
Expected: FAIL — `ReportStep` has no `wait`, `ReportJson` has no `connection`, `ConnectionStats` undefined.

- [ ] **Step 3: Add the structs**

In `crates/controller/src/report.rs`, add `wait` to `ReportStep` (after `download`, same attribute):

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download: Option<PhaseStats>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<PhaseStats>,
}
```

Add a new struct near `PhaseStats`:

```rust
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ConnectionStats {
    /// DNS resolution distribution across new connections this run.
    pub dns: PhaseStats,
    /// connect(TCP+TLS) distribution across new connections this run.
    pub connect: PhaseStats,
    /// Number of new connections opened (= count of `connect` phase samples). Approximate
    /// (background-spawned connects under pool contention may be missed).
    pub connections_opened: u64,
    /// Total requests this run (Σ step counts).
    pub requests_total: u64,
    /// Fraction of requests served by a reused connection = 1 − opened/total (0 if total 0).
    pub reuse_ratio: f64,
}
```

Add `connection` to `ReportJson` (top-level, alongside `group_latency`/`active_vu_series`):

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<ConnectionStats>,
```

- [ ] **Step 4: Accumulate wait per-step + dns/connect run-level**

In `crates/controller/src/report.rs`, right after the existing `download_by_step` block (~line 565), add a `wait_by_step` accumulator (exact mirror of `download_acc`, filter `phase == "wait"`) producing `let mut wait_by_step: BTreeMap<String, PhaseStats>`. Then add a run-level connection accumulator:

```rust
    // Connection cost: dns + connect phases rolled up RUN-LEVEL (step_id ignored — a
    // connection serves many steps). connections_opened = Σ connect counts. NOT per-step.
    let mut dns_hist = fresh_hist();
    let mut dns_count: u64 = 0;
    let mut connect_hist = fresh_hist();
    let mut connect_count: u64 = 0;
    for p in phases {
        let (h, c) = match p.phase.as_str() {
            "dns" => (&mut dns_hist, &mut dns_count),
            "connect" => (&mut connect_hist, &mut connect_count),
            _ => continue,
        };
        if let Ok(Some(decoded)) = decode_hdr(&p.hdr_histogram) {
            merge_into(h, &decoded);
        }
        *c += p.count as u64;
    }
    // total_count is the Σ step requests already computed for the summary (see ReportSummary).
    let connection = if connect_count > 0 || dns_count > 0 {
        let phase_stats = |h: &Histogram<u64>, count: u64| {
            let pc = percentiles_of(h);
            PhaseStats { count, p50_ms: pc.p50_ms, p95_ms: pc.p95_ms, p99_ms: pc.p99_ms, max_ms: h.max() / 1_000 }
        };
        let reuse_ratio = if total_count == 0 {
            0.0
        } else {
            1.0 - (connect_count as f64 / total_count as f64)
        };
        Some(ConnectionStats {
            dns: phase_stats(&dns_hist, dns_count),
            connect: phase_stats(&connect_hist, connect_count),
            connections_opened: connect_count,
            requests_total: total_count,
            reuse_ratio,
        })
    } else {
        None
    };
```

> `total_count` is the run's total request count — confirm the variable name where `ReportSummary { count: total_count, ... }` is built (~report.rs:591) and reuse it. If `connection`'s accumulation must run before `total_count` exists, move it after the per-step count totals are computed.

- [ ] **Step 5: Attach `wait` to each step + `connection` to the report**

In the `steps` builder (~report.rs:575), add `let wait = wait_by_step.remove(&step_id);` and add `wait,` to the `ReportStep { ... }` literal. In the final `ReportJson { ... }` literal, add `connection,`.

- [ ] **Step 6: Fix compiler-flagged literal sites**

Run: `cargo build -p handicap-controller --tests 2>&1 | grep -E "error|missing field"`
Add `wait: None` to every `ReportStep { ... }` literal and `connection: None` to every `ReportJson { ... }` literal the compiler flags. Known sites: `report.rs` test fixtures, `export.rs` (`report_with_steps`/fixtures), and `insights.rs:388` (`step` helper). Note: because both new fields are `Option` with `skip_serializing_if`, the `testdata/compare_golden.json` golden fixture deserializes fine (serde default = None) — no fixture edit needed there. Also no UI `.strict()` summary fixture breakage (these are optional report-level/step-level, not summary fields). Do NOT pipe through `head` — it can truncate the third file's error.

- [ ] **Step 7: Run tests + verify pass**

Run: `cargo test -p handicap-controller build_report_rolls_up_connection_phases_and_attaches_wait && cargo nextest run -p handicap-controller && cargo clippy -p handicap-controller --all-targets -- -D warnings`
Expected: PASS, 0 clippy warnings.

- [ ] **Step 8: Commit**

```bash
git add crates/controller/src/report.rs crates/controller/src/export.rs crates/controller/src/insights.rs
git commit -m "feat(controller): roll up dns/connect phases to run-level ConnectionStats + wait per-step"
```

---

### Task 4: UI Zod — wait + connection schemas

**Files:**
- Modify: `ui/src/api/schemas.ts` (add `wait` to `ReportStepSchema`, add `ConnectionStatsSchema`, add `connection` to the report schema)
- Test: `ui/src/api/__tests__/schemas.test.ts` (or wherever report schema parse is tested) — if none, add a `__tests__` file.

**Interfaces:**
- Produces: `ConnectionStatsSchema`, `type ConnectionStats`, `ReportStep.wait?: PhaseStats`, report `.connection?: ConnectionStats`.

- [ ] **Step 1: Write the failing test FIRST (tdd-guard: test before src edit)**

Create `ui/src/api/__tests__/connectionStats.test.ts`. Test the two NEW schema pieces directly (both standalone-parseable — no full-`ReportSchema` fixture needed; a complete `.strict()` report fixture is non-trivial and the full-report `connection` acceptance is verified live in Task 7 Step 3 via the real `/report` `safeParse`):

```ts
import { describe, expect, it } from "vitest";
import { ConnectionStatsSchema, ReportStepSchema } from "../schemas";

describe("connection stats + wait wire", () => {
  it("parses ConnectionStats (inner numerics are plain, never null/undefined)", () => {
    const parsed = ConnectionStatsSchema.parse({
      dns: { count: 2, p50_ms: 2, p95_ms: 8, p99_ms: 8, max_ms: 9 },
      connect: { count: 2, p50_ms: 15, p95_ms: 40, p99_ms: 40, max_ms: 41 },
      connections_opened: 2,
      requests_total: 100,
      reuse_ratio: 0.98,
    });
    expect(parsed.connections_opened).toBe(2);
    expect(parsed.reuse_ratio).toBeCloseTo(0.98);
  });

  it("ReportStep accepts the wait phase, and accepts it absent (measure off)", () => {
    const base = {
      step_id: "s1",
      count: 10,
      error_count: 0,
      status_counts: { "200": 10 },
      p50_ms: 48,
      p95_ms: 60,
      p99_ms: 70,
    };
    const withWait = ReportStepSchema.parse({
      ...base,
      wait: { count: 10, p50_ms: 45, p95_ms: 55, p99_ms: 60, max_ms: 61 },
    });
    expect(withWait.wait?.p50_ms).toBe(45);
    expect(() => ReportStepSchema.parse(base)).not.toThrow(); // wait is optional
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && pnpm test connectionStats`
Expected: FAIL — `connection` rejected by `.strict()` report schema / `ConnectionStatsSchema` undefined.

- [ ] **Step 3: Add the schemas**

In `ui/src/api/schemas.ts`, add `wait` to `ReportStepSchema` (after `download`):

```ts
    download: PhaseStatsSchema.optional(),
    wait: PhaseStatsSchema.optional(),
  })
  .strict();
```

Add `ConnectionStatsSchema` after `PhaseStatsSchema` (inner numeric fields are plain `z.number()` — always serialized when connection present):

```ts
export const ConnectionStatsSchema = z
  .object({
    dns: PhaseStatsSchema,
    connect: PhaseStatsSchema,
    connections_opened: z.number().int().nonnegative(),
    requests_total: z.number().int().nonnegative(),
    reuse_ratio: z.number(),
  })
  .strict();
export type ConnectionStats = z.infer<typeof ConnectionStatsSchema>;
```

Add `connection` to the top-level report schema (find the `ReportSchema`/`ReportJsonSchema` object that holds `group_latency`/`active_vu_series` and add, since serde uses `skip_serializing_if` → `.optional()`):

```ts
    connection: ConnectionStatsSchema.optional(),
```

- [ ] **Step 4: Run tests + build gate + verify pass**

Run: `cd ui && pnpm test connectionStats && pnpm build`
Expected: PASS, `tsc -b` clean (no `number|undefined` leak — inner fields are non-optional).

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/schemas.ts ui/src/api/__tests__/connectionStats.test.ts
git commit -m "feat(ui): Zod schemas for connection stats + step wait phase"
```

---

### Task 5: UI — ConnectionCostCard + ko.ts + ReportView wiring

**Files:**
- Create: `ui/src/components/report/ConnectionCostCard.tsx`
- Create: `ui/src/components/report/__tests__/ConnectionCostCard.test.tsx`
- Modify: `ui/src/i18n/ko.ts` (add `report.connection` keys)
- Modify: `ui/src/components/report/ReportView.tsx` (render the card when `report.connection` present)

**Interfaces:**
- Consumes: `ConnectionStats` (Task 4), `HelpTip`, `ko.report.connection`.
- Produces: `<ConnectionCostCard stats={connection} />`.

- [ ] **Step 1: Write the failing test FIRST**

Create `ui/src/components/report/__tests__/ConnectionCostCard.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnectionCostCard } from "../ConnectionCostCard";

const stats = {
  dns: { count: 5, p50_ms: 2, p95_ms: 8, p99_ms: 8, max_ms: 9 },
  connect: { count: 5, p50_ms: 15, p95_ms: 40, p99_ms: 40, max_ms: 41 },
  connections_opened: 5,
  requests_total: 1000,
  reuse_ratio: 0.995,
};

describe("ConnectionCostCard", () => {
  it("renders reuse ratio, connections opened, and dns/connect percentiles", () => {
    render(<ConnectionCostCard stats={stats} />);
    expect(screen.getByText(/99\.5%|99,5%/)).toBeInTheDocument(); // reuse ratio
    expect(screen.getByText("5")).toBeInTheDocument(); // connections opened
    expect(screen.getByText(/DNS/i)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /연결/ })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && pnpm test ConnectionCostCard`
Expected: FAIL — module not found.

- [ ] **Step 3: Add ko.ts keys**

In `ui/src/i18n/ko.ts`, inside the `report: {` block (e.g. after `perStepStatsLabel`/`stepsHeading`), add:

```ts
    // ── 연결 비용 (transaction breakdown) ──
    connectionLabel: "연결 비용",
    connectionReuse: "연결 재사용률",
    connectionsOpened: "새로 연 연결",
    connectionUnitCount: "개",
    connectionDns: "DNS 조회",
    connectionConnect: "connect (TCP+TLS)",
    connectionPercentiles: (p50: number, p95: number) => `p50 ${p50}ms · p95 ${p95}ms`,
    connectionBeginner: (opened: number, reusePct: string) =>
      `요청을 ${opened}개 연결로 처리했고 ${reusePct}는 연결을 재사용했어요. 재사용률이 높을수록 좋습니다.`,
    connectionHelp:
      "DNS·TCP·TLS는 연결을 새로 맺을 때만 듭니다. keep-alive로 연결을 재사용하면 그 다음 요청들은 이 비용이 0이라, 요청당 평균이 아니라 연결 단위로 모아서 보여줍니다.",
    connectionReuseHelp:
      "재사용률이 낮으면(90% 미만) keep-alive가 꺼졌거나 서버가 연결을 끊는 것일 수 있어요.",
    connectionDnsHelp: "DNS 조회가 느리면 리졸버나 네임서버가 느린 것입니다.",
    // ── 스텝별 단계 분해 (wait/download) ──
    phaseWait: "대기(서버)",
    phaseDownload: "다운로드",
    phaseWaitHelp:
      "대기 = 요청을 보내고 첫 바이트가 올 때까지 = 거의 서버 처리 시간. 대기가 길면 서버가 느린 것이니 에러율·상태 코드 분포를 함께 보세요.",
    phaseViewWaterfall: "막대",
    phaseViewChips: "칩",
    phaseViewToggleLabel: "스텝 분해 보기 방식",
```

- [ ] **Step 4: Write the ConnectionCostCard component**

Create `ui/src/components/report/ConnectionCostCard.tsx`:

```tsx
import type { ConnectionStats } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";

type Props = { stats: ConnectionStats };

export function ConnectionCostCard({ stats }: Props) {
  const reusePct = (stats.reuse_ratio * 100).toFixed(1);
  return (
    <section
      aria-label={ko.report.connectionLabel}
      className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      {/* HelpTip is a sibling of <h3>, NOT a child — nesting pollutes the heading accname (ui/CLAUDE.md U3). */}
      <div className="mb-1 flex items-center">
        <h3 className="text-base font-semibold">{ko.report.connectionLabel}</h3>
        <HelpTip label={ko.report.connectionLabel}>{ko.report.connectionHelp}</HelpTip>
      </div>
      <p className="mb-4 text-xs text-slate-500">
        {ko.report.connectionBeginner(stats.connections_opened, `${reusePct}%`)}
        <HelpTip label={ko.report.connectionReuse}>{ko.report.connectionReuseHelp}</HelpTip>
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs uppercase tracking-wide text-slate-500">
            {ko.report.connectionReuse}
          </div>
          <div className="mt-1 text-2xl font-bold">{reusePct}%</div>
          <div className="mt-2 h-2 overflow-hidden rounded bg-slate-200">
            <div className="h-full bg-green-500" style={{ width: `${reusePct}%` }} />
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs uppercase tracking-wide text-slate-500">
            {ko.report.connectionsOpened}
          </div>
          <div className="mt-1 text-2xl font-bold">
            {stats.connections_opened}
            <span className="ml-1 text-sm font-medium text-slate-500">
              {ko.report.connectionUnitCount}
            </span>
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center text-sm">
            <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-indigo-500" />
            {ko.report.connectionDns}
            <HelpTip label={ko.report.connectionDns}>{ko.report.connectionDnsHelp}</HelpTip>
            <span className="ml-auto tabular-nums text-slate-500">
              {ko.report.connectionPercentiles(stats.dns.p50_ms, stats.dns.p95_ms)}
            </span>
          </div>
          <div className="mt-2 flex items-center text-sm">
            <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-teal-500" />
            {ko.report.connectionConnect}
            <span className="ml-auto tabular-nums text-slate-500">
              {ko.report.connectionPercentiles(stats.connect.p50_ms, stats.connect.p95_ms)}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Wire into ReportView**

In `ui/src/components/report/ReportView.tsx`, import `ConnectionCostCard` and render it above the per-step table when `report.connection` is present:

```tsx
{report.connection && <ConnectionCostCard stats={report.connection} />}
```

(Place it after the summary/latency sections and before `StepStatsTable`, matching the document order in the mockup.)

- [ ] **Step 6: Run tests + lint + build**

Run: `cd ui && pnpm test ConnectionCostCard && pnpm lint && pnpm build`
Expected: PASS, lint 0 warnings, `tsc -b` clean.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/report/ConnectionCostCard.tsx ui/src/components/report/__tests__/ConnectionCostCard.test.tsx ui/src/i18n/ko.ts ui/src/components/report/ReportView.tsx
git commit -m "feat(ui): connection cost card with reuse gauge + dns/connect + HelpTips"
```

---

### Task 6: UI — per-step wait + waterfall/chips view toggle

**Files:**
- Modify: `ui/src/components/report/StepStatsTable.tsx` (add a `wait` column to the existing table) — keep it the "chips/table" view.
- Create: `ui/src/components/report/StepPhaseBreakdown.tsx` (wrapper with the view toggle: waterfall bars ↔ the existing `StepStatsTable`).
- Create: `ui/src/components/report/__tests__/StepPhaseBreakdown.test.tsx`
- Modify: `ui/src/components/report/ReportView.tsx` (render `StepPhaseBreakdown` instead of `StepStatsTable` directly).

**Interfaces:**
- Consumes: `ReportStep[]` (now with `wait`), `StepMeta` map, `ko.report.phase*`.
- Produces: `<StepPhaseBreakdown steps={...} meta={...} />` with default view = `"waterfall"`.

- [ ] **Step 1: Write the failing test FIRST**

Create `ui/src/components/report/__tests__/StepPhaseBreakdown.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { StepPhaseBreakdown } from "../StepPhaseBreakdown";

const steps = [
  {
    step_id: "s1",
    count: 100,
    error_count: 0,
    status_counts: { "200": 100 },
    p50_ms: 48,
    p95_ms: 60,
    p99_ms: 70,
    wait: { count: 100, p50_ms: 45, p95_ms: 55, p99_ms: 60, max_ms: 61 },
    download: { count: 100, p50_ms: 3, p95_ms: 5, p99_ms: 6, max_ms: 7 },
  },
];
const meta = new Map([["s1", { id: "s1", name: "login", method: "POST", url: "/login" }]]);

describe("StepPhaseBreakdown", () => {
  it("defaults to waterfall and toggles to chips", async () => {
    const user = userEvent.setup();
    render(<StepPhaseBreakdown steps={steps as never} meta={meta} />);
    // waterfall default: bars present (role img or labelled track)
    expect(screen.getByText("login")).toBeInTheDocument();
    // toggle to chips view
    await user.click(screen.getByRole("button", { name: "칩" }));
    expect(screen.getByText(/대기/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && pnpm test StepPhaseBreakdown`
Expected: FAIL — module not found.

- [ ] **Step 3: Add a `wait` column to StepStatsTable**

In `ui/src/components/report/StepStatsTable.tsx`: add `const anyWait = steps.some((s) => s.wait != null);` and extend the conditional columns. Add a `대기 p50` group next to the download columns. Keep the existing `anyDownload` logic; add waiting columns under `anyWait`. Update `colSpan` accordingly. Use `ko.report.phaseWait` for the header with a `HelpTip` (`ko.report.phaseWaitHelp`). Render `{s.wait?.p50_ms ?? "—"}` cells. (This view is the "chips/table" mode.)

- [ ] **Step 4: Write the StepPhaseBreakdown toggle wrapper**

Create `ui/src/components/report/StepPhaseBreakdown.tsx`:

```tsx
import { useState } from "react";
import type { ReportStep } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";
import { StepStatsTable } from "./StepStatsTable";

type StepMeta = { id: string; name: string; method: string; url: string };
type Props = { steps: ReportStep[]; meta: Map<string, StepMeta> };
type View = "waterfall" | "chips";

const WAIT = "#f59e0b";
const DL = "#22c55e";

export function StepPhaseBreakdown({ steps, meta }: Props) {
  const [view, setView] = useState<View>("waterfall");
  const anyPhase = steps.some((s) => s.wait != null || s.download != null);
  if (!anyPhase) {
    // no phase data (measure_phases off) → fall back to the plain table
    return <StepStatsTable steps={steps} meta={meta} />;
  }
  return (
    <section aria-label={ko.report.perStepStatsLabel} className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        {/* HelpTip is a sibling of <h3>, NOT a child (ui/CLAUDE.md U3 heading-accname trap). */}
        <div className="flex items-center">
          <h3 className="text-lg font-semibold">{ko.report.stepsHeading}</h3>
          <HelpTip label={ko.report.phaseWait}>{ko.report.phaseWaitHelp}</HelpTip>
        </div>
        <div role="group" aria-label={ko.report.phaseViewToggleLabel} className="flex gap-1 text-xs">
          <button
            type="button"
            aria-pressed={view === "waterfall"}
            onClick={() => setView("waterfall")}
            className={`rounded px-2 py-1 ${view === "waterfall" ? "bg-slate-800 text-white" : "bg-slate-100"}`}
          >
            {ko.report.phaseViewWaterfall}
          </button>
          <button
            type="button"
            aria-pressed={view === "chips"}
            onClick={() => setView("chips")}
            className={`rounded px-2 py-1 ${view === "chips" ? "bg-slate-800 text-white" : "bg-slate-100"}`}
          >
            {ko.report.phaseViewChips}
          </button>
        </div>
      </div>
      {view === "chips" ? (
        <StepStatsTable steps={steps} meta={meta} />
      ) : (
        <div>
          {steps.map((s) => {
            const m = meta.get(s.step_id);
            const wait = s.wait?.p50_ms ?? 0;
            const dl = s.download?.p50_ms ?? 0;
            const total = wait + dl || 1;
            return (
              <div key={s.step_id} className="flex items-center gap-3 border-t border-slate-100 py-2">
                <div className="w-40 text-sm font-medium">{m?.name ?? s.step_id}</div>
                <div
                  role="img"
                  aria-label={`${m?.name ?? s.step_id} 대기 ${wait}ms 다운로드 ${dl}ms`}
                  className="flex h-5 flex-1 overflow-hidden rounded bg-slate-100"
                >
                  <span style={{ width: `${(wait / total) * 100}%`, background: WAIT }} />
                  <span style={{ width: `${(dl / total) * 100}%`, background: DL }} />
                </div>
                <div className="w-16 text-right text-sm font-bold tabular-nums">{wait + dl}ms</div>
              </div>
            );
          })}
          <div className="mt-2 flex gap-4 text-xs text-slate-500">
            <span>
              <i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-[-1px]" style={{ background: WAIT }} />
              {ko.report.phaseWait}
            </span>
            <span>
              <i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-[-1px]" style={{ background: DL }} />
              {ko.report.phaseDownload}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Swap ReportView to use the wrapper**

In `ui/src/components/report/ReportView.tsx`, replace the direct `<StepStatsTable steps={...} meta={...} />` usage with `<StepPhaseBreakdown steps={...} meta={...} />`.

- [ ] **Step 6: Run tests + lint + build (full suite before merge)**

Run: `cd ui && pnpm test StepPhaseBreakdown && pnpm test StepStatsTable && pnpm lint && pnpm test && pnpm build`
Expected: PASS (full `pnpm test` — catches any other report fixture needing `wait`/`connection`; both are optional so should be clean), lint 0, `tsc -b` clean.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/report/StepPhaseBreakdown.tsx ui/src/components/report/__tests__/StepPhaseBreakdown.test.tsx ui/src/components/report/StepStatsTable.tsx ui/src/components/report/ReportView.tsx
git commit -m "feat(ui): per-step wait phase + waterfall/chips view toggle"
```

---

### Task 7: Live verification (pre-merge, REQUIRED — engine/report path, S-D gap)

**Files:** none committed (throwaway verification per `/live-verify`).

This slice touches run creation → engine request path → report build → UI parsing, so live verification is mandatory (RTL fixtures give absent-not-null and miss server response-path bugs).

- [ ] **Step 1: Build worktree binaries**

```bash
cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller && (cd ui && pnpm build)
```

- [ ] **Step 2: Start a latency responder + controller (isolated DB)**

Use `/live-verify` to scaffold a localhost HTTP responder (~50ms) + controller subprocess + isolated DB (`./target/debug/controller --db /tmp/txn-timing.db --ui-dir ui/dist`). Confirm `curl http://127.0.0.1:8080/api/scenarios` returns 200.

- [ ] **Step 3: Run a `measure_phases` run against localhost (http)**

Create a scenario hitting the responder, then `POST /api/runs` with `profile.measure_phases = true`. After completion, `GET /api/runs/{id}/report` and verify:
- `connection` present with `connections_opened` ≥ 1, `reuse_ratio` near 1 (localhost keep-alive), `dns.p50_ms` ~0 (localhost), `connect.p50_ms` small.
- each step has `wait` with `p50_ms` ≈ responder latency.
- **R4 (resolver equivalence):** the run completed normally (resolution succeeded). (R6) Save the raw `/report` JSON and run a throwaway `__tests__` test doing `ReportSchema.safeParse(json)` — must pass (S-D gap closed).

- [ ] **Step 4: Run against a real external https host (R4)**

Point a scenario at `https://example.com` (or an internal host), `measure_phases=true`, low VUs/short duration. Verify `dns.p50_ms > 0` and `connect.p50_ms > 0` on the connection card (real DNS+TLS), and that the run completes (resolver behaviour-equivalent).

- [ ] **Step 5: Throughput A/B (R10)**

Run the same scenario twice (high closed-loop VUs, localhost): once `measure_phases=false`, once `true`. Confirm `summary.rps` is within normal run-to-run variance (no throughput regression from instrumentation — reused connections only pay the task-local scope).

- [ ] **Step 6: Browser check (R8/R9)**

With Playwright (inline `browser_evaluate`/`browser_snapshot`, no `filename`): open the run report, confirm the "연결 비용" card renders (reuse gauge, connections opened, DNS/connect percentiles), the per-step waterfall renders and toggles to chips (`아리아 button` 막대/칩), HelpTips open, and the browser console has 0 Zod errors. Clean up `.playwright-mcp/` + root pngs.

- [ ] **Step 7: byte-identical-off sanity (R3)**

A `measure_phases=false` run's `/report` has NO `connection` key and NO step `wait` keys; the report renders the plain `StepStatsTable` (no toggle). Confirm.

---

## Self-Review (run before dispatching)

- **Spec coverage:** R1 (Task 2 attribution test) · R2 (Task 2 single record_phase site + proto/migration 0 = Global Constraints) · R3 (Task 2 off-path + Task 7 step 7) · R4 (Task 7 steps 3-4) · R5 (Task 3 rollup) · R6 (Task 4 + Task 7 step 3 safeParse) · R7 (Task 3 reuse_ratio test incl. 0-req guard) · R8 (Task 5 card + Task 6 toggle) · R9 (Task 5/6 HelpTips + ko.ts) · R10 (Task 7 step 5) · R11 (Global Constraints + ConnectionStats doc comment). All covered.
- **tdd-guard ordering:** UI tasks 4/5/6 write the `__tests__` file BEFORE editing `ui/src` production (ui/CLAUDE.md trap) — Step 1 is always the test.
- **No new MetricFlush vector / send-guard** — confirmed: new phases reuse `phase_stats`.
- **Type consistency:** `with_timeout(_, _, measure_phases: bool)` used identically in executor def + 3 runner sites + tests. `ConnectionStats` fields match between report.rs struct, Zod schema, and ConnectionCostCard consumption. `ko.report.connection*`/`phase*` keys defined in Task 5 are consumed in Tasks 5/6.

---

REVIEW-GATE: APPROVED

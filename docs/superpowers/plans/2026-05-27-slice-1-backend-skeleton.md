# Slice 1 — Backend Skeleton End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the full backend pipeline (proto → engine → controller → worker → SQLite) works end-to-end against a mock HTTP target, for a single-step scenario run by N tokio-task VUs with 1-second HDR-Histogram aggregation. No UI, no K8s, no ramp-up, no multi-step.

**Architecture:** Cargo workspace with four crates — `proto` (tonic-generated gRPC types), `engine` (framework-agnostic load library: scenario types, template eval, HTTP executor with per-VU cookie jar, 1s metric aggregator, VU runner), `controller` (axum REST + tonic gRPC server + sqlx SQLite + subprocess-based worker spawn), `worker` (tonic client that pulls scenario, runs via engine, streams metrics). Controller spawns workers as **local subprocesses** in Slice 1 — K8s Job orchestration moves to Slice 6.

**Tech Stack:** Rust (stable, 2024 edition, MSRV 1.85), tokio, tonic 0.12, prost 0.13, axum 0.8, sqlx 0.8 (SQLite, runtime-tokio), reqwest 0.12 (rustls, cookie_store), serde + serde_yaml + serde_json, hdrhistogram 7, ulid 1, tracing + tracing-subscriber, thiserror + anyhow, wiremock (dev), just (task runner). Spec: `docs/superpowers/specs/2026-05-27-handicap-mvp1-design.md`.

**Slice 1 scope (locked):**

| In | Out (deferred slice) |
|---|---|
| Single-step `http` scenarios | Multi-step + `extract` chains (Slice 4) |
| `{{var}}` from `scenario.variables`, `${vu_id}`, `${iter_id}` | `${ENV}` from run config (Slice 4) |
| `assert: status: <code>` | Other assertions (post-MVP) |
| Per-VU cookie jar default ON (ADR-0018) | `cookie_jar: off` (works but untested here) |
| N concurrent VUs, all spawn at t=0, run for `duration_seconds`, then graceful stop | Linear ramp-up curve (Slice 4) |
| 1s window HDR Histogram + status counts (ADR-0012) | Worker-side error categorization beyond count |
| Subprocess-based worker spawn | K8s Job spawn (Slice 6) |
| Controller REST: `POST/GET /scenarios`, `POST/GET /runs`, `GET /runs/:id/metrics` | UI, reports, charts (Slices 2/3/5) |
| gRPC bidi stream: Register → ReceiveRun → MetricBatch | Reconnect/backoff (Slice 4) |
| Integration test with wiremock target via `cargo test` | kind/Helm e2e (Slice 6) |

**Prerequisites:**
- Rust toolchain ≥ 1.85 via rustup (`curl https://sh.rustup.rs -sSf | sh`). Verify: `rustc --version && cargo --version`.
- `protoc` ≥ 25 (`brew install protobuf`). Verify: `protoc --version`. (Used by `tonic-build`.)
- `just` (`brew install just`). Verify: `just --version`.
- SQLite ≥ 3.30 (macOS ships with this).

---

## File structure (Slice 1)

```
Cargo.toml                          # workspace manifest
rust-toolchain.toml                 # pin stable channel
Justfile                            # build/test/run aliases
.gitignore                          # /target, *.db, *.db-journal
README.md                           # touch with quickstart

crates/proto/
  Cargo.toml
  build.rs                          # tonic-build invocation
  proto/coordinator.proto           # gRPC service + messages
  src/lib.rs                        # tonic::include_proto!

crates/engine/
  Cargo.toml
  src/lib.rs                        # public API + module wiring
  src/scenario.rs                   # Scenario/Step/Request types + serde
  src/template.rs                   # {{var}}, ${vu_id}, ${iter_id} substitution
  src/executor.rs                   # reqwest-based HTTP executor with cookie jar
  src/aggregator.rs                 # 1s window HDR + status counts
  src/runner.rs                     # per-VU loop + multi-VU orchestrator
  src/error.rs                      # EngineError (thiserror)
  tests/fixtures/single_step.yaml
  tests/runner_e2e.rs               # integration test against wiremock

crates/controller/
  Cargo.toml
  src/main.rs                       # bin entry (tracing + serve)
  src/app.rs                        # AppState + axum Router builder
  src/error.rs                      # ApiError → IntoResponse
  src/api/mod.rs
  src/api/scenarios.rs              # POST/GET handlers
  src/api/runs.rs                   # POST/GET handlers + metrics endpoint
  src/store/mod.rs                  # SQLite pool + migrate()
  src/store/migrations/0001_initial.sql
  src/store/scenarios.rs            # insert/get
  src/store/runs.rs                 # insert/get/update_status
  src/store/metrics.rs              # insert batch
  src/grpc/mod.rs                   # tonic server bootstrap
  src/grpc/coordinator.rs           # Coordinator service impl
  src/worker_proc.rs                # subprocess spawn (slice 1)
  tests/api_test.rs

crates/worker/
  Cargo.toml
  src/main.rs                       # bin entry (parse args, connect, run)
  src/client.rs                     # gRPC client wiring
  src/error.rs                      # WorkerError

.github/workflows/ci.yml            # fmt + clippy + test
```

**Conventions:**
- Each crate uses `thiserror` for typed errors internally and `anyhow` only at `main.rs` boundaries.
- Logging: `tracing` everywhere, init in each `main.rs`. Format: JSON in release, pretty in debug. Spans for `run_id` and `vu_id`.
- IDs: `ulid::Ulid::new().to_string()`.
- SQLite path: `controller` flag `--db <path>`, default `./handicap.db`.
- Controller listens on REST `:8080` (configurable) and gRPC `:8081` (configurable).
- Worker connects to controller via `--controller http://host:port` arg + identifies itself with `--worker-id <ulid>` + `--run-id <ulid>` arg passed by controller at spawn.

---

## Task 1: Workspace skeleton + tooling

**Files:**
- Create: `Cargo.toml` (workspace root)
- Create: `rust-toolchain.toml`
- Create: `Justfile`
- Modify: `.gitignore`
- Create: `README.md` (or modify existing) — short quickstart
- Create: `crates/.gitkeep` (so directory exists before crates land)

- [ ] **Step 1: Write workspace `Cargo.toml`**

Create `Cargo.toml` at repo root:

```toml
[workspace]
resolver = "2"
members = [
    "crates/proto",
    "crates/engine",
    "crates/controller",
    "crates/worker",
]

[workspace.package]
edition = "2024"
rust-version = "1.85"
license = "Proprietary"
publish = false

[workspace.dependencies]
anyhow = "1"
async-trait = "0.1"
axum = { version = "0.8", features = ["macros"] }
bytes = "1"
clap = { version = "4", features = ["derive", "env"] }
futures = "0.3"
hdrhistogram = { version = "7", features = ["serialization"] }
hyper = "1"
hyper-util = { version = "0.1", features = ["tokio"] }
prost = "0.13"
prost-types = "0.13"
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "cookies", "json", "gzip"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_yaml = "0.9"
sqlx = { version = "0.8", default-features = false, features = ["runtime-tokio", "sqlite", "macros", "migrate"] }
thiserror = "1"
tokio = { version = "1", features = ["full"] }
tokio-stream = { version = "0.1", features = ["sync"] }
tonic = "0.12"
tonic-build = "0.12"
tower = "0.5"
tower-http = { version = "0.6", features = ["trace", "cors"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
ulid = { version = "1", features = ["serde"] }

[workspace.dependencies.wiremock]
version = "0.6"
```

- [ ] **Step 2: Write `rust-toolchain.toml`**

```toml
[toolchain]
channel = "stable"
components = ["rustfmt", "clippy"]
```

- [ ] **Step 3: Write `Justfile`**

```make
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
    RUST_LOG=info,handicap=debug cargo run -p controller -- --db ./handicap.db --rest 127.0.0.1:8080 --grpc 127.0.0.1:8081 --worker-bin target/debug/worker

# Direct worker run for manual testing (controller normally spawns it)
run-worker run_id worker_id:
    cargo run -p worker -- --controller http://127.0.0.1:8081 --run-id {{run_id}} --worker-id {{worker_id}}
```

- [ ] **Step 4: Update `.gitignore`**

Append (preserve existing lines):

```
/target
*.db
*.db-journal
*.db-shm
*.db-wal
.DS_Store
```

- [ ] **Step 5: Touch README.md**

Either create or modify to add:

```markdown
# Handicap

Internal load-testing tool. See `docs/superpowers/specs/` for design.

## Quickstart (Slice 1, backend only)

```
rustup show              # ensure toolchain installed
brew install protobuf just
just build
just test
```
```

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml rust-toolchain.toml Justfile .gitignore README.md
git commit -m "feat(workspace): scaffold cargo workspace + tooling"
```

---

## Task 2: `proto` crate (gRPC contract)

**Files:**
- Create: `crates/proto/Cargo.toml`
- Create: `crates/proto/build.rs`
- Create: `crates/proto/proto/coordinator.proto`
- Create: `crates/proto/src/lib.rs`

- [ ] **Step 1: Write `crates/proto/Cargo.toml`**

```toml
[package]
name = "handicap-proto"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true
publish = false

[dependencies]
prost.workspace = true
prost-types.workspace = true
tonic.workspace = true

[build-dependencies]
tonic-build.workspace = true
```

- [ ] **Step 2: Write `crates/proto/build.rs`**

```rust
fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        .compile_protos(&["proto/coordinator.proto"], &["proto"])?;
    Ok(())
}
```

- [ ] **Step 3: Write `crates/proto/proto/coordinator.proto`**

This is the controller↔worker contract for Slice 1. Multi-step extract and ramp-up come in later slices, but the wire format already reserves space for them.

```proto
syntax = "proto3";
package handicap.coordinator.v1;

// Single bidi stream:
//   Worker  --> Register, MetricBatch, RunStatus
//   Server  --> RunAssignment, AbortRun, Pong
service Coordinator {
  rpc Channel(stream WorkerMessage) returns (stream ServerMessage);
}

// ---------- Worker → Server ----------

message WorkerMessage {
  oneof payload {
    Register register = 1;
    Pong pong = 2;
    MetricBatch metric_batch = 3;
    RunStatus run_status = 4;
  }
}

message Register {
  string worker_id = 1;
  string run_id = 2;        // worker is spawned per-run in slice 1
  uint32 capacity_vus = 3;  // max VUs this worker is willing to run
}

message Pong {
  uint64 nonce = 1;
}

message MetricBatch {
  string run_id = 1;
  string worker_id = 2;
  repeated MetricWindow windows = 3;
}

message MetricWindow {
  int64 ts_second = 1;
  string step_id = 2;           // scenario step id, or "_all"
  uint64 count = 3;
  uint64 error_count = 4;
  bytes hdr_histogram = 5;      // hdrhistogram V2 serialized
  map<string, uint64> status_counts = 6;
}

message RunStatus {
  string run_id = 1;
  Phase phase = 2;
  string message = 3;
  enum Phase {
    PHASE_UNSPECIFIED = 0;
    PHASE_STARTED = 1;
    PHASE_COMPLETED = 2;
    PHASE_FAILED = 3;
  }
}

// ---------- Server → Worker ----------

message ServerMessage {
  oneof payload {
    RunAssignment assignment = 1;
    AbortRun abort = 2;
    Ping ping = 3;
  }
}

message RunAssignment {
  string run_id = 1;
  string scenario_yaml = 2;     // canonical scenario YAML, snapshotted
  Profile profile = 3;
}

message Profile {
  uint32 vus = 1;
  uint32 ramp_up_seconds = 2;   // populated but ignored in slice 1
  uint32 duration_seconds = 3;
}

message AbortRun {
  string run_id = 1;
  string reason = 2;
}

message Ping {
  uint64 nonce = 1;
}
```

- [ ] **Step 4: Write `crates/proto/src/lib.rs`**

```rust
#![allow(clippy::all)]

pub mod coordinator {
    pub mod v1 {
        tonic::include_proto!("handicap.coordinator.v1");
    }
}

pub use coordinator::v1 as v1;
```

- [ ] **Step 5: Run `cargo build -p handicap-proto`**

Expected: compiles cleanly. `tonic-build` runs at build time and generates client+server stubs.

```bash
cargo build -p handicap-proto
```

If `protoc` is missing, the error will say so — install per Prerequisites.

- [ ] **Step 6: Commit**

```bash
git add crates/proto
git commit -m "feat(proto): controller↔worker gRPC contract (Coordinator.Channel)"
```

---

## Task 3: `engine` crate skeleton + Scenario types

**Files:**
- Create: `crates/engine/Cargo.toml`
- Create: `crates/engine/src/lib.rs`
- Create: `crates/engine/src/error.rs`
- Create: `crates/engine/src/scenario.rs`
- Create: `crates/engine/tests/fixtures/single_step.yaml`

- [ ] **Step 1: Write `crates/engine/Cargo.toml`**

```toml
[package]
name = "handicap-engine"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true
publish = false

[dependencies]
async-trait.workspace = true
bytes.workspace = true
futures.workspace = true
hdrhistogram.workspace = true
reqwest.workspace = true
serde.workspace = true
serde_json.workspace = true
serde_yaml.workspace = true
thiserror.workspace = true
tokio.workspace = true
tracing.workspace = true
ulid.workspace = true

[dev-dependencies]
wiremock.workspace = true
tokio = { workspace = true, features = ["full", "test-util"] }
```

- [ ] **Step 2: Write `crates/engine/src/error.rs`**

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("scenario parse: {0}")]
    ScenarioParse(#[from] serde_yaml::Error),
    #[error("template: unknown variable {0}")]
    UnknownVar(String),
    #[error("template: malformed expression near '{0}'")]
    MalformedTemplate(String),
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("assert failed (step={step}, expected={expected}, got={got})")]
    AssertFailed { step: String, expected: String, got: String },
    #[error("histogram: {0}")]
    Histogram(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, EngineError>;
```

- [ ] **Step 3: Write fixture `crates/engine/tests/fixtures/single_step.yaml`**

This is the canonical single-step shape that Slice 1 must accept.

```yaml
version: 1
name: "GET status root"
variables:
  base_url: "http://localhost:9999"
steps:
  - id: "root"
    name: "GET /"
    type: http
    request:
      method: GET
      url: "{{base_url}}/"
    assert:
      - status: 200
```

- [ ] **Step 4: Write failing tests in `crates/engine/src/scenario.rs`**

```rust
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::error::{EngineError, Result};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Scenario {
    pub version: u32,
    pub name: String,
    #[serde(default)]
    pub variables: BTreeMap<String, String>,
    #[serde(default = "default_cookie_jar")]
    pub cookie_jar: CookieJarMode,
    pub steps: Vec<Step>,
}

fn default_cookie_jar() -> CookieJarMode {
    CookieJarMode::Auto
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CookieJarMode {
    Auto,
    Off,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: StepKind,
    pub request: Request,
    #[serde(default)]
    pub assert: Vec<Assertion>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StepKind {
    Http,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub method: HttpMethod,
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body: Option<Body>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    Get, Post, Put, Patch, Delete, Head, Options,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub enum Body {
    #[serde(rename = "json")]
    Json(serde_json::Value),
    #[serde(rename = "form")]
    Form(BTreeMap<String, String>),
    #[serde(rename = "raw")]
    Raw(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub enum Assertion {
    #[serde(rename = "status")]
    Status(u16),
}

impl Scenario {
    pub fn from_yaml(s: &str) -> Result<Self> {
        Ok(serde_yaml::from_str(s)?)
    }

    pub fn to_yaml(&self) -> Result<String> {
        serde_yaml::to_string(self).map_err(EngineError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../tests/fixtures/single_step.yaml");

    #[test]
    fn parses_single_step_fixture() {
        let s = Scenario::from_yaml(FIXTURE).expect("parses");
        assert_eq!(s.version, 1);
        assert_eq!(s.name, "GET status root");
        assert_eq!(s.steps.len(), 1);
        let step = &s.steps[0];
        assert_eq!(step.id, "root");
        assert_eq!(step.kind, StepKind::Http);
        assert_eq!(step.request.method, HttpMethod::Get);
        assert_eq!(step.request.url, "{{base_url}}/");
        assert_eq!(step.assert, vec![Assertion::Status(200)]);
        assert_eq!(s.cookie_jar, CookieJarMode::Auto);
    }

    #[test]
    fn round_trips() {
        let s = Scenario::from_yaml(FIXTURE).unwrap();
        let yaml = s.to_yaml().unwrap();
        let s2 = Scenario::from_yaml(&yaml).unwrap();
        assert_eq!(s, s2);
    }

    #[test]
    fn rejects_unknown_field() {
        let bad = r#"
version: 1
name: x
mystery_field: nope
steps: []
"#;
        assert!(Scenario::from_yaml(bad).is_err());
    }

    #[test]
    fn cookie_jar_off_parses() {
        let y = r#"
version: 1
name: x
cookie_jar: off
steps: []
"#;
        let s = Scenario::from_yaml(y).unwrap();
        assert_eq!(s.cookie_jar, CookieJarMode::Off);
    }
}
```

- [ ] **Step 5: Write minimal `crates/engine/src/lib.rs`**

```rust
pub mod error;
pub mod scenario;

pub use error::{EngineError, Result};
pub use scenario::{Assertion, Body, CookieJarMode, HttpMethod, Request, Scenario, Step, StepKind};
```

- [ ] **Step 6: Run the tests**

```bash
cargo test -p handicap-engine scenario::
```

Expected: 4 tests pass. If `deny_unknown_fields` test fails, check that you didn't forget the attribute on `Scenario`.

- [ ] **Step 7: Commit**

```bash
git add crates/engine
git commit -m "feat(engine): Scenario data model with YAML round-trip"
```

---

## Task 4: `engine` — Template evaluator

**Files:**
- Create: `crates/engine/src/template.rs`
- Modify: `crates/engine/src/lib.rs` (re-export)

Slice 1 supports two notations only:
- `{{var}}` — looked up in `Scenario.variables` (also extract context in later slices)
- `${vu_id}`, `${iter_id}` — system variables

`${ENV}` env-var substitution is **deferred to Slice 4** (requires Run Config wiring).

- [ ] **Step 1: Write failing tests in `crates/engine/src/template.rs`**

```rust
use std::collections::BTreeMap;

use crate::error::{EngineError, Result};

#[derive(Debug, Clone)]
pub struct TemplateContext<'a> {
    pub vars: &'a BTreeMap<String, String>,
    pub vu_id: u32,
    pub iter_id: u32,
}

/// Substitute `{{var}}` (from `vars`) and `${vu_id}` / `${iter_id}` (system).
/// Unknown `{{name}}` → error. `${OTHER}` → error (env support is Slice 4).
pub fn render(input: &str, ctx: &TemplateContext) -> Result<String> {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'{' && bytes[i + 1] == b'{' {
            let end = find_pair(bytes, i + 2, b"}}")
                .ok_or_else(|| EngineError::MalformedTemplate(format!("unclosed {{{{ at byte {i}")))?;
            let name = std::str::from_utf8(&bytes[i + 2..end])
                .map_err(|_| EngineError::MalformedTemplate("non-utf8 in {{ }}".into()))?
                .trim();
            let value = ctx
                .vars
                .get(name)
                .ok_or_else(|| EngineError::UnknownVar(name.to_string()))?;
            out.push_str(value);
            i = end + 2;
            continue;
        }
        if i + 1 < bytes.len() && bytes[i] == b'$' && bytes[i + 1] == b'{' {
            let end = find_byte(bytes, i + 2, b'}')
                .ok_or_else(|| EngineError::MalformedTemplate(format!("unclosed ${{ at byte {i}")))?;
            let name = std::str::from_utf8(&bytes[i + 2..end])
                .map_err(|_| EngineError::MalformedTemplate("non-utf8 in ${{ }}".into()))?
                .trim();
            let value = match name {
                "vu_id" => ctx.vu_id.to_string(),
                "iter_id" => ctx.iter_id.to_string(),
                other => return Err(EngineError::UnknownVar(other.to_string())),
            };
            out.push_str(&value);
            i = end + 1;
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    Ok(out)
}

fn find_pair(b: &[u8], start: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || start >= b.len() {
        return None;
    }
    let mut i = start;
    while i + needle.len() <= b.len() {
        if &b[i..i + needle.len()] == needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn find_byte(b: &[u8], start: usize, needle: u8) -> Option<usize> {
    b[start..].iter().position(|c| *c == needle).map(|p| p + start)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn renders_flow_var() {
        let v = vars(&[("base_url", "http://x")]);
        let ctx = TemplateContext { vars: &v, vu_id: 0, iter_id: 0 };
        assert_eq!(render("{{base_url}}/path", &ctx).unwrap(), "http://x/path");
    }

    #[test]
    fn renders_vu_id_and_iter_id() {
        let v = BTreeMap::new();
        let ctx = TemplateContext { vars: &v, vu_id: 7, iter_id: 42 };
        assert_eq!(render("u${vu_id}-i${iter_id}", &ctx).unwrap(), "u7-i42");
    }

    #[test]
    fn unknown_flow_var_errors() {
        let v = BTreeMap::new();
        let ctx = TemplateContext { vars: &v, vu_id: 0, iter_id: 0 };
        assert!(matches!(render("{{nope}}", &ctx), Err(EngineError::UnknownVar(_))));
    }

    #[test]
    fn unknown_system_var_errors() {
        // ${ENV} substitution is slice 4 — currently errors.
        let v = BTreeMap::new();
        let ctx = TemplateContext { vars: &v, vu_id: 0, iter_id: 0 };
        assert!(matches!(render("${SOMETHING}", &ctx), Err(EngineError::UnknownVar(_))));
    }

    #[test]
    fn unclosed_brace_errors() {
        let v = BTreeMap::new();
        let ctx = TemplateContext { vars: &v, vu_id: 0, iter_id: 0 };
        assert!(matches!(render("{{nope", &ctx), Err(EngineError::MalformedTemplate(_))));
    }

    #[test]
    fn passthrough() {
        let v = BTreeMap::new();
        let ctx = TemplateContext { vars: &v, vu_id: 0, iter_id: 0 };
        assert_eq!(render("no templates here", &ctx).unwrap(), "no templates here");
    }
}
```

- [ ] **Step 2: Add `pub mod template;` to `crates/engine/src/lib.rs`**

```rust
pub mod error;
pub mod scenario;
pub mod template;

pub use error::{EngineError, Result};
pub use scenario::{Assertion, Body, CookieJarMode, HttpMethod, Request, Scenario, Step, StepKind};
pub use template::{render, TemplateContext};
```

- [ ] **Step 3: Run tests**

```bash
cargo test -p handicap-engine template::
```

Expected: 6 tests pass.

- [ ] **Step 4: Commit**

```bash
git add crates/engine
git commit -m "feat(engine): template evaluator for {{var}} and \${vu_id}/\${iter_id}"
```

---

## Task 5: `engine` — HTTP executor + per-VU cookie jar

**Files:**
- Create: `crates/engine/src/executor.rs`
- Modify: `crates/engine/src/lib.rs`

- [ ] **Step 1: Write `crates/engine/src/executor.rs`**

```rust
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::cookie::Jar;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

use crate::error::{EngineError, Result};
use crate::scenario::{Assertion, Body, CookieJarMode, HttpMethod, Scenario, Step};
use crate::template::{render, TemplateContext};

/// Per-VU HTTP client. Holds its own cookie jar so sessions are isolated.
pub struct VuClient {
    inner: reqwest::Client,
}

impl VuClient {
    pub fn new(cookie_mode: CookieJarMode) -> Result<Self> {
        let mut builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent("handicap/0.1");
        if let CookieJarMode::Auto = cookie_mode {
            let jar = Arc::new(Jar::default());
            builder = builder.cookie_provider(jar);
        }
        let inner = builder.build()?;
        Ok(Self { inner })
    }
}

#[derive(Debug, Clone)]
pub struct ExecOutcome {
    pub step_id: String,
    pub status: u16,
    pub latency: Duration,
    pub error: Option<String>,
}

pub async fn execute_step(
    client: &VuClient,
    step: &Step,
    ctx: &TemplateContext<'_>,
) -> Result<ExecOutcome> {
    let url = render(&step.request.url, ctx)?;
    let mut headers = HeaderMap::new();
    for (k, v) in &step.request.headers {
        let v = render(v, ctx)?;
        let name = HeaderName::from_bytes(k.as_bytes())
            .map_err(|e| EngineError::MalformedTemplate(format!("header name {k}: {e}")))?;
        let value = HeaderValue::from_str(&v)
            .map_err(|e| EngineError::MalformedTemplate(format!("header value {k}: {e}")))?;
        headers.insert(name, value);
    }

    let method = match step.request.method {
        HttpMethod::Get => reqwest::Method::GET,
        HttpMethod::Post => reqwest::Method::POST,
        HttpMethod::Put => reqwest::Method::PUT,
        HttpMethod::Patch => reqwest::Method::PATCH,
        HttpMethod::Delete => reqwest::Method::DELETE,
        HttpMethod::Head => reqwest::Method::HEAD,
        HttpMethod::Options => reqwest::Method::OPTIONS,
    };

    let mut req = client.inner.request(method, &url).headers(headers);

    if let Some(body) = &step.request.body {
        req = match body {
            Body::Json(v) => req.json(v),
            Body::Form(map) => req.form(map),
            Body::Raw(s) => {
                let rendered = render(s, ctx)?;
                req.body(rendered)
            }
        };
    }

    let started = Instant::now();
    let outcome = req.send().await;
    let latency = started.elapsed();

    match outcome {
        Ok(resp) => {
            let status = resp.status().as_u16();
            // Drain body so connection returns to pool — but cap to avoid huge bodies hurting numbers.
            let _ = resp.bytes().await;
            let mut error = None;
            for a in &step.assert {
                match a {
                    Assertion::Status(want) if *want != status => {
                        error = Some(format!("status {} != {}", status, want));
                        break;
                    }
                    _ => {}
                }
            }
            Ok(ExecOutcome {
                step_id: step.id.clone(),
                status,
                latency,
                error,
            })
        }
        Err(e) => Ok(ExecOutcome {
            step_id: step.id.clone(),
            status: 0,
            latency,
            error: Some(e.to_string()),
        }),
    }
}

/// Convenience for callers that always want the scenario's cookie_jar mode.
pub fn client_for_scenario(s: &Scenario) -> Result<VuClient> {
    VuClient::new(s.cookie_jar)
}
```

- [ ] **Step 2: Add to `crates/engine/src/lib.rs`**

```rust
pub mod executor;
pub use executor::{client_for_scenario, execute_step, ExecOutcome, VuClient};
```

- [ ] **Step 3: Build to ensure no compile errors**

```bash
cargo build -p handicap-engine
```

Expected: clean build. (Behavioral tests come in Task 7's e2e — exercising the executor in isolation requires a server, which is naturally a runner integration test.)

- [ ] **Step 4: Commit**

```bash
git add crates/engine
git commit -m "feat(engine): per-VU HTTP executor with cookie jar (ADR-0018)"
```

---

## Task 6: `engine` — 1-second window aggregator

**Files:**
- Create: `crates/engine/src/aggregator.rs`
- Modify: `crates/engine/src/lib.rs`

- [ ] **Step 1: Write tests + impl in `crates/engine/src/aggregator.rs`**

```rust
use std::collections::HashMap;
use std::time::SystemTime;

use hdrhistogram::serialization::{Serializer, V2Serializer};
use hdrhistogram::Histogram;

use crate::error::{EngineError, Result};

/// One 1-second bucket of metrics for one step.
#[derive(Debug)]
pub struct StepWindow {
    pub step_id: String,
    pub ts_second: i64,
    pub count: u64,
    pub error_count: u64,
    pub status_counts: HashMap<u16, u64>,
    pub histogram: Histogram<u64>,
}

impl StepWindow {
    fn new(step_id: String, ts_second: i64) -> Self {
        // 1 microsecond to 60 seconds, 3 significant digits — covers all realistic web latencies.
        let h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).expect("valid bounds");
        Self {
            step_id,
            ts_second,
            count: 0,
            error_count: 0,
            status_counts: HashMap::new(),
            histogram: h,
        }
    }

    pub fn record(&mut self, latency_us: u64, status: u16, is_error: bool) {
        let v = latency_us.clamp(1, 60_000_000);
        let _ = self.histogram.record(v);
        self.count += 1;
        if is_error {
            self.error_count += 1;
        }
        *self.status_counts.entry(status).or_insert(0) += 1;
    }

    pub fn serialize_histogram(&self) -> Result<Vec<u8>> {
        let mut buf = Vec::new();
        let mut ser = V2Serializer::new();
        ser.serialize(&self.histogram, &mut buf)
            .map_err(|e| EngineError::Histogram(e.to_string()))?;
        Ok(buf)
    }
}

/// Accumulator keyed by (step_id, ts_second). Flush returns and drains all windows
/// whose ts_second is strictly less than `up_to_second` so the most recent (live)
/// bucket keeps accumulating.
#[derive(Debug, Default)]
pub struct Aggregator {
    windows: HashMap<(String, i64), StepWindow>,
}

impl Aggregator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&mut self, step_id: &str, latency_us: u64, status: u16, is_error: bool) {
        let ts = current_second();
        let key = (step_id.to_string(), ts);
        let w = self
            .windows
            .entry(key)
            .or_insert_with(|| StepWindow::new(step_id.to_string(), ts));
        w.record(latency_us, status, is_error);
    }

    pub fn drain_completed(&mut self, up_to_second: i64) -> Vec<StepWindow> {
        let keys: Vec<_> = self
            .windows
            .keys()
            .filter(|(_, ts)| *ts < up_to_second)
            .cloned()
            .collect();
        keys.into_iter()
            .filter_map(|k| self.windows.remove(&k))
            .collect()
    }

    pub fn drain_all(&mut self) -> Vec<StepWindow> {
        std::mem::take(&mut self.windows).into_values().collect()
    }
}

fn current_second() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_serializes() {
        let mut a = Aggregator::new();
        a.record("step1", 1_000, 200, false);
        a.record("step1", 2_000, 200, false);
        a.record("step1", 50_000, 500, true);
        let mut all = a.drain_all();
        assert_eq!(all.len(), 1);
        let w = all.pop().unwrap();
        assert_eq!(w.step_id, "step1");
        assert_eq!(w.count, 3);
        assert_eq!(w.error_count, 1);
        assert_eq!(w.status_counts.get(&200), Some(&2));
        assert_eq!(w.status_counts.get(&500), Some(&1));
        let bytes = w.serialize_histogram().expect("serializes");
        assert!(!bytes.is_empty(), "histogram bytes should be non-empty");
    }

    #[test]
    fn drain_completed_keeps_current_second() {
        let mut a = Aggregator::new();
        // Manually insert two windows at different seconds to be deterministic.
        let mut old = StepWindow::new("s".into(), 1_000);
        old.record(500, 200, false);
        let mut new_w = StepWindow::new("s".into(), 1_001);
        new_w.record(500, 200, false);
        a.windows.insert(("s".into(), 1_000), old);
        a.windows.insert(("s".into(), 1_001), new_w);

        let drained = a.drain_completed(1_001);
        assert_eq!(drained.len(), 1, "only ts<1001 should drain");
        assert_eq!(drained[0].ts_second, 1_000);
        assert!(a.windows.contains_key(&("s".into(), 1_001)));
    }
}
```

- [ ] **Step 2: Add to `crates/engine/src/lib.rs`**

```rust
pub mod aggregator;
pub use aggregator::{Aggregator, StepWindow};
```

- [ ] **Step 3: Run tests**

```bash
cargo test -p handicap-engine aggregator::
```

Expected: 2 tests pass.

- [ ] **Step 4: Commit**

```bash
git add crates/engine
git commit -m "feat(engine): 1s window aggregator with HDR histogram (ADR-0012)"
```

---

## Task 7: `engine` — VU runner + multi-VU orchestrator + e2e

**Files:**
- Create: `crates/engine/src/runner.rs`
- Modify: `crates/engine/src/lib.rs`
- Create: `crates/engine/tests/runner_e2e.rs`

The runner spawns N tokio tasks (ADR-0016), runs each through `scenario.steps` repeatedly until `duration` elapses, and flushes 1s windows out a channel.

- [ ] **Step 1: Write `crates/engine/src/runner.rs`**

```rust
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinSet;
use tracing::{debug, info, instrument, warn};

use crate::aggregator::{Aggregator, StepWindow};
use crate::error::Result;
use crate::executor::{execute_step, VuClient};
use crate::scenario::Scenario;
use crate::template::TemplateContext;

#[derive(Debug, Clone)]
pub struct RunPlan {
    pub vus: u32,
    pub duration: Duration,
}

/// Drive `vus` virtual users through `scenario` for `plan.duration`, streaming
/// completed 1s windows to `out`. Returns when the run finishes (all VUs done).
pub async fn run_scenario(
    scenario: Arc<Scenario>,
    plan: RunPlan,
    out: mpsc::Sender<Vec<StepWindow>>,
) -> Result<()> {
    let agg = Arc::new(Mutex::new(Aggregator::new()));
    let deadline = Instant::now() + plan.duration;

    let mut set = JoinSet::new();
    for vu_id in 0..plan.vus {
        let scenario = scenario.clone();
        let agg = agg.clone();
        set.spawn(async move {
            if let Err(e) = run_vu(scenario, vu_id, agg, deadline).await {
                warn!(vu_id, error = ?e, "vu failed");
            }
        });
    }

    // Flush loop — until all VUs finish.
    let flush_agg = agg.clone();
    let flush_out = out.clone();
    let flusher = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let now_s = chrono_second();
            let drained = flush_agg.lock().await.drain_completed(now_s);
            if !drained.is_empty() {
                debug!(count = drained.len(), "flushing windows");
                if flush_out.send(drained).await.is_err() {
                    break;
                }
            }
            if flush_out.is_closed() {
                break;
            }
        }
    });

    while let Some(res) = set.join_next().await {
        if let Err(e) = res {
            warn!(error = %e, "vu join error");
        }
    }

    // Final drain after all VUs are done.
    let final_windows = agg.lock().await.drain_all();
    if !final_windows.is_empty() {
        let _ = out.send(final_windows).await;
    }
    drop(out);
    let _ = flusher.await;

    info!("run finished");
    Ok(())
}

#[instrument(skip(scenario, agg), fields(vu_id))]
async fn run_vu(
    scenario: Arc<Scenario>,
    vu_id: u32,
    agg: Arc<Mutex<Aggregator>>,
    deadline: Instant,
) -> Result<()> {
    let client = VuClient::new(scenario.cookie_jar)?;
    let mut iter_id: u32 = 0;
    while Instant::now() < deadline {
        for step in &scenario.steps {
            if Instant::now() >= deadline {
                return Ok(());
            }
            let ctx = TemplateContext {
                vars: &scenario.variables,
                vu_id,
                iter_id,
            };
            let outcome = execute_step(&client, step, &ctx).await?;
            let mut a = agg.lock().await;
            a.record(
                &outcome.step_id,
                outcome.latency.as_micros().min(u64::MAX as u128) as u64,
                outcome.status,
                outcome.error.is_some(),
            );
        }
        iter_id = iter_id.wrapping_add(1);
    }
    Ok(())
}

fn chrono_second() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
```

- [ ] **Step 2: Update `crates/engine/src/lib.rs`**

```rust
pub mod runner;
pub use runner::{run_scenario, RunPlan};
```

- [ ] **Step 3: Write `crates/engine/tests/runner_e2e.rs`**

```rust
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{run_scenario, RunPlan, Scenario};
use tokio::sync::mpsc;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn runs_5_vus_for_2_seconds_against_mock() {
    // Arrange — mock target server.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: test
variables:
  base: "{}"
steps:
  - id: home
    name: GET /
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/"
    assert:
      - status: 200
"#,
        server.uri()
    );

    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel(64);
    let plan = RunPlan { vus: 5, duration: Duration::from_secs(2) };

    let scenario_clone = scenario.clone();
    let run = tokio::spawn(async move {
        run_scenario(scenario_clone, plan, tx).await.expect("runs");
    });

    let mut total: u64 = 0;
    let mut errors: u64 = 0;
    while let Some(batch) = rx.recv().await {
        for w in batch {
            total += w.count;
            errors += w.error_count;
        }
    }
    run.await.expect("join");

    assert!(total > 0, "should record at least one request");
    assert_eq!(errors, 0, "no assertion failures expected");
}
```

- [ ] **Step 4: Run the e2e test**

```bash
cargo test -p handicap-engine --test runner_e2e -- --nocapture
```

Expected: passes. A 2-second run with 5 VUs against an in-process mock should yield hundreds of requests. The exact number depends on the machine.

- [ ] **Step 5: Commit**

```bash
git add crates/engine
git commit -m "feat(engine): VU runner + multi-VU orchestrator + wiremock e2e"
```

---

## Task 8: `controller` skeleton + `/health`

**Files:**
- Create: `crates/controller/Cargo.toml`
- Create: `crates/controller/src/main.rs`
- Create: `crates/controller/src/app.rs`
- Create: `crates/controller/src/error.rs`

- [ ] **Step 1: Write `crates/controller/Cargo.toml`**

```toml
[package]
name = "handicap-controller"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true
publish = false

[[bin]]
name = "controller"
path = "src/main.rs"

[dependencies]
handicap-engine = { path = "../engine" }
handicap-proto = { path = "../proto" }
anyhow.workspace = true
async-trait.workspace = true
axum.workspace = true
clap.workspace = true
futures.workspace = true
serde.workspace = true
serde_json.workspace = true
serde_yaml.workspace = true
sqlx.workspace = true
thiserror.workspace = true
tokio.workspace = true
tokio-stream.workspace = true
tonic.workspace = true
tower.workspace = true
tower-http.workspace = true
tracing.workspace = true
tracing-subscriber.workspace = true
ulid.workspace = true

[dev-dependencies]
reqwest = { workspace = true, default-features = false, features = ["rustls-tls", "json"] }
```

- [ ] **Step 2: Write `crates/controller/src/error.rs`**

```rust
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("not found")]
    NotFound,
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("db: {0}")]
    Db(#[from] sqlx::Error),
    #[error("scenario: {0}")]
    Scenario(#[from] handicap_engine::EngineError),
    #[error("internal: {0}")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            ApiError::Scenario(e) => (StatusCode::BAD_REQUEST, e.to_string()),
            ApiError::Db(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            ApiError::Internal(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}
```

- [ ] **Step 3: Write `crates/controller/src/app.rs`**

```rust
use std::sync::Arc;

use axum::routing::get;
use axum::Router;

#[derive(Clone)]
pub struct AppState {
    // populated in later tasks
    pub _placeholder: Arc<()>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .with_state(state)
}
```

- [ ] **Step 4: Write `crates/controller/src/main.rs`**

```rust
use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use clap::Parser;
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::EnvFilter;

mod app;
mod error;

#[derive(Debug, Parser)]
struct Args {
    #[arg(long, default_value = "./handicap.db")]
    db: String,
    #[arg(long, default_value = "127.0.0.1:8080")]
    rest: SocketAddr,
    #[arg(long, default_value = "127.0.0.1:8081")]
    grpc: SocketAddr,
    /// Path to the worker binary. Used to spawn workers per run.
    #[arg(long, default_value = "target/debug/worker")]
    worker_bin: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    let args = Args::parse();
    info!(?args, "controller starting");

    let state = app::AppState { _placeholder: Arc::new(()) };
    let app = app::router(state);

    let listener = TcpListener::bind(args.rest).await.context("bind REST")?;
    info!(addr = %args.rest, "REST listening");
    axum::serve(listener, app).await.context("serve")?;
    Ok(())
}
```

- [ ] **Step 5: Build + run + curl health**

```bash
cargo build -p handicap-controller
cargo run -p handicap-controller -- --db /tmp/h1.db &
sleep 1
curl -s http://127.0.0.1:8080/health
kill %1
```

Expected output from curl: `ok`. Then kill the background process.

- [ ] **Step 6: Commit**

```bash
git add crates/controller
git commit -m "feat(controller): axum skeleton with /health"
```

---

## Task 9: `controller` — SQLite store + migrations

**Files:**
- Create: `crates/controller/src/store/mod.rs`
- Create: `crates/controller/src/store/migrations/0001_initial.sql`
- Modify: `crates/controller/src/main.rs` (open pool, run migrations)
- Modify: `crates/controller/src/app.rs` (carry pool in state)

- [ ] **Step 1: Write the migration `crates/controller/src/store/migrations/0001_initial.sql`**

Mirrors spec §2.9.

```sql
CREATE TABLE IF NOT EXISTS scenarios (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  yaml        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  version     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  scenario_id     TEXT NOT NULL REFERENCES scenarios(id),
  scenario_yaml   TEXT NOT NULL,
  profile_json    TEXT NOT NULL,
  env_json        TEXT NOT NULL,
  status          TEXT NOT NULL,
  started_at      INTEGER,
  ended_at        INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run_metrics (
  run_id           TEXT NOT NULL REFERENCES runs(id),
  ts_second        INTEGER NOT NULL,
  step_id          TEXT NOT NULL,
  count            INTEGER NOT NULL,
  error_count      INTEGER NOT NULL,
  hdr_histogram    BLOB NOT NULL,
  status_counts    TEXT NOT NULL,
  PRIMARY KEY (run_id, ts_second, step_id)
);

CREATE INDEX IF NOT EXISTS idx_runs_scenario ON runs(scenario_id);
CREATE INDEX IF NOT EXISTS idx_metrics_run ON run_metrics(run_id);
```

- [ ] **Step 2: Write `crates/controller/src/store/mod.rs`**

```rust
use std::path::Path;
use std::str::FromStr;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Pool, Sqlite};

pub type Db = Pool<Sqlite>;

const MIGRATION_SQL: &str = include_str!("migrations/0001_initial.sql");

pub async fn connect(db_url: &str) -> anyhow::Result<Db> {
    let opts = SqliteConnectOptions::from_str(db_url)?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = SqlitePoolOptions::new().max_connections(8).connect_with(opts).await?;
    sqlx::query(MIGRATION_SQL).execute(&pool).await?;
    Ok(pool)
}

pub fn url_from_path(path: &str) -> String {
    if path.starts_with("sqlite:") {
        path.to_string()
    } else {
        format!("sqlite://{}", Path::new(path).display())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn opens_and_migrates_in_memory() {
        let pool = connect("sqlite::memory:").await.expect("connect");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scenarios")
            .fetch_one(&pool)
            .await
            .expect("query");
        assert_eq!(count, 0);
    }
}
```

- [ ] **Step 3: Update `crates/controller/src/app.rs`**

```rust
use axum::routing::get;
use axum::Router;

use crate::store::Db;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .with_state(state)
}
```

- [ ] **Step 4: Update `crates/controller/src/main.rs`**

Replace the placeholder state construction with real DB connect:

```rust
mod app;
mod error;
mod store;

// ... in main(), replace the AppState construction with:
let db_url = store::url_from_path(&args.db);
let db = store::connect(&db_url).await?;
let state = app::AppState { db };
```

Remove the unused `Arc` import if it now warns.

- [ ] **Step 5: Run tests**

```bash
cargo test -p handicap-controller store::
```

Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add crates/controller
git commit -m "feat(controller): SQLite pool + initial schema migration"
```

---

## Task 10: `controller` — Scenarios REST API

**Files:**
- Create: `crates/controller/src/store/scenarios.rs`
- Create: `crates/controller/src/api/mod.rs`
- Create: `crates/controller/src/api/scenarios.rs`
- Modify: `crates/controller/src/app.rs`
- Modify: `crates/controller/src/main.rs` (add `mod api;`)
- Create: `crates/controller/tests/api_test.rs`

- [ ] **Step 1: Write `crates/controller/src/store/scenarios.rs`**

```rust
use handicap_engine::Scenario;
use ulid::Ulid;

use super::Db;

pub struct ScenarioRow {
    pub id: String,
    pub name: String,
    pub yaml: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub version: i64,
}

pub async fn insert(db: &Db, scenario: &Scenario, yaml: &str) -> sqlx::Result<ScenarioRow> {
    let id = Ulid::new().to_string();
    let now = now_ms();
    sqlx::query("INSERT INTO scenarios(id,name,yaml,created_at,updated_at,version) VALUES(?,?,?,?,?,1)")
        .bind(&id)
        .bind(&scenario.name)
        .bind(yaml)
        .bind(now)
        .bind(now)
        .execute(db)
        .await?;
    Ok(ScenarioRow {
        id,
        name: scenario.name.clone(),
        yaml: yaml.to_string(),
        created_at: now,
        updated_at: now,
        version: 1,
    })
}

pub async fn get(db: &Db, id: &str) -> sqlx::Result<Option<ScenarioRow>> {
    let row = sqlx::query_as::<_, (String, String, String, i64, i64, i64)>(
        "SELECT id,name,yaml,created_at,updated_at,version FROM scenarios WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(id, name, yaml, c, u, v)| ScenarioRow {
        id,
        name,
        yaml,
        created_at: c,
        updated_at: u,
        version: v,
    }))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
```

- [ ] **Step 2: Write `crates/controller/src/api/mod.rs`**

```rust
pub mod scenarios;
```

- [ ] **Step 3: Write `crates/controller/src/api/scenarios.rs`**

```rust
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use handicap_engine::Scenario;
use serde::{Deserialize, Serialize};

use crate::app::AppState;
use crate::error::ApiError;
use crate::store::scenarios;

#[derive(Debug, Deserialize)]
pub struct CreateRequest {
    pub yaml: String,
}

#[derive(Debug, Serialize)]
pub struct ScenarioResponse {
    pub id: String,
    pub name: String,
    pub yaml: String,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateRequest>,
) -> Result<(StatusCode, Json<ScenarioResponse>), ApiError> {
    let parsed = Scenario::from_yaml(&body.yaml)?;
    let row = scenarios::insert(&state.db, &parsed, &body.yaml).await?;
    Ok((
        StatusCode::CREATED,
        Json(ScenarioResponse {
            id: row.id,
            name: row.name,
            yaml: row.yaml,
            version: row.version,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }),
    ))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ScenarioResponse>, ApiError> {
    let row = scenarios::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    Ok(Json(ScenarioResponse {
        id: row.id,
        name: row.name,
        yaml: row.yaml,
        version: row.version,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }))
}
```

- [ ] **Step 4: Wire routes in `crates/controller/src/app.rs`**

```rust
use axum::routing::{get, post};
use axum::Router;

use crate::api::scenarios as scenarios_api;
use crate::store::Db;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/scenarios", post(scenarios_api::create))
        .route("/scenarios/{id}", get(scenarios_api::get))
        .with_state(state)
}
```

- [ ] **Step 5: Add `mod api;` to `crates/controller/src/main.rs`**

```rust
mod api;
mod app;
mod error;
mod store;
```

- [ ] **Step 6: Write integration test `crates/controller/tests/api_test.rs`**

```rust
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::{app, store};
use serde_json::{json, Value};
use tower::ServiceExt;

#[tokio::test]
async fn create_and_get_scenario() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = app::router(app::AppState { db });

    let body = json!({
        "yaml": "version: 1\nname: t\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n"
    });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/scenarios")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    let id = v["id"].as_str().unwrap().to_string();

    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/scenarios/{id}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn rejects_invalid_yaml() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = app::router(app::AppState { db });
    let body = json!({ "yaml": "not: valid: yaml: -" });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/scenarios")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}
```

To make this work, the controller crate must expose `app`, `store` as a lib alongside the bin. Add a `src/lib.rs`:

- [ ] **Step 7: Create `crates/controller/src/lib.rs`**

```rust
pub mod api;
pub mod app;
pub mod error;
pub mod store;
```

Then in `crates/controller/src/main.rs`, replace the module declarations with `use` statements:

```rust
use handicap_controller::{app, store};
```

Remove the `mod api; mod app; mod error; mod store;` lines from `main.rs` (they now live in `lib.rs`).

And update `crates/controller/Cargo.toml` to expose both targets:

```toml
[lib]
name = "handicap_controller"
path = "src/lib.rs"

[[bin]]
name = "controller"
path = "src/main.rs"
```

- [ ] **Step 8: Run tests**

```bash
cargo test -p handicap-controller
```

Expected: store test + 2 API tests pass.

- [ ] **Step 9: Commit**

```bash
git add crates/controller
git commit -m "feat(controller): /scenarios REST (POST, GET)"
```

---

## Task 11: `controller` — Runs REST API (pending state only)

**Files:**
- Create: `crates/controller/src/store/runs.rs`
- Create: `crates/controller/src/api/runs.rs`
- Modify: `crates/controller/src/app.rs`
- Modify: `crates/controller/src/store/mod.rs`
- Modify: `crates/controller/src/api/mod.rs`
- Modify: `crates/controller/tests/api_test.rs`

Slice 1 scope: POST creates a run row in `pending` state, returns id. Execution (worker spawn + state transitions) is wired in Task 13 once gRPC exists.

- [ ] **Step 1: Write `crates/controller/src/store/runs.rs`**

```rust
use serde::{Deserialize, Serialize};
use sqlx::Row;
use ulid::Ulid;

use super::Db;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Aborted,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Pending => "pending",
            RunStatus::Running => "running",
            RunStatus::Completed => "completed",
            RunStatus::Failed => "failed",
            RunStatus::Aborted => "aborted",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "pending" => RunStatus::Pending,
            "running" => RunStatus::Running,
            "completed" => RunStatus::Completed,
            "failed" => RunStatus::Failed,
            "aborted" => RunStatus::Aborted,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub vus: u32,
    #[serde(default)]
    pub ramp_up_seconds: u32,
    pub duration_seconds: u32,
}

pub struct RunRow {
    pub id: String,
    pub scenario_id: String,
    pub scenario_yaml: String,
    pub profile: Profile,
    pub env: serde_json::Value,
    pub status: RunStatus,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub created_at: i64,
}

pub async fn insert(
    db: &Db,
    scenario_id: &str,
    scenario_yaml: &str,
    profile: &Profile,
    env: &serde_json::Value,
) -> sqlx::Result<RunRow> {
    let id = Ulid::new().to_string();
    let now = now_ms();
    let profile_json = serde_json::to_string(profile).expect("serialize profile");
    let env_json = serde_json::to_string(env).expect("serialize env");
    sqlx::query(
        "INSERT INTO runs(id,scenario_id,scenario_yaml,profile_json,env_json,status,created_at) \
         VALUES(?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(scenario_id)
    .bind(scenario_yaml)
    .bind(&profile_json)
    .bind(&env_json)
    .bind(RunStatus::Pending.as_str())
    .bind(now)
    .execute(db)
    .await?;
    Ok(RunRow {
        id,
        scenario_id: scenario_id.to_string(),
        scenario_yaml: scenario_yaml.to_string(),
        profile: profile.clone(),
        env: env.clone(),
        status: RunStatus::Pending,
        started_at: None,
        ended_at: None,
        created_at: now,
    })
}

pub async fn get(db: &Db, id: &str) -> sqlx::Result<Option<RunRow>> {
    let row = sqlx::query(
        "SELECT id,scenario_id,scenario_yaml,profile_json,env_json,status,started_at,ended_at,created_at \
         FROM runs WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(r) = row else { return Ok(None) };
    let profile: Profile = serde_json::from_str(r.get::<String, _>("profile_json").as_str()).unwrap();
    let env: serde_json::Value = serde_json::from_str(r.get::<String, _>("env_json").as_str()).unwrap();
    let status = RunStatus::parse(r.get::<String, _>("status").as_str()).unwrap_or(RunStatus::Failed);
    Ok(Some(RunRow {
        id: r.get("id"),
        scenario_id: r.get("scenario_id"),
        scenario_yaml: r.get("scenario_yaml"),
        profile,
        env,
        status,
        started_at: r.get("started_at"),
        ended_at: r.get("ended_at"),
        created_at: r.get("created_at"),
    }))
}

pub async fn set_status(
    db: &Db,
    id: &str,
    status: RunStatus,
    started: Option<i64>,
    ended: Option<i64>,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE runs SET status = ?, started_at = COALESCE(?, started_at), ended_at = COALESCE(?, ended_at) WHERE id = ?")
        .bind(status.as_str())
        .bind(started)
        .bind(ended)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
```

- [ ] **Step 2: Update `crates/controller/src/store/mod.rs`** — re-export the new submodule.

Add at top, after the existing items:

```rust
pub mod runs;
pub mod scenarios;
```

(Replaces any existing `pub mod scenarios;` line; do not duplicate.)

- [ ] **Step 3: Write `crates/controller/src/api/runs.rs`**

```rust
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::app::AppState;
use crate::error::ApiError;
use crate::store::runs::{self, Profile, RunStatus};
use crate::store::scenarios;

#[derive(Debug, Deserialize)]
pub struct CreateRunRequest {
    pub scenario_id: String,
    pub profile: Profile,
    #[serde(default)]
    pub env: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct RunResponse {
    pub id: String,
    pub scenario_id: String,
    pub status: RunStatus,
    pub profile: Profile,
    pub env: serde_json::Value,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub created_at: i64,
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateRunRequest>,
) -> Result<(StatusCode, Json<RunResponse>), ApiError> {
    let scenario = scenarios::get(&state.db, &body.scenario_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    if body.profile.vus == 0 || body.profile.duration_seconds == 0 {
        return Err(ApiError::BadRequest("vus and duration_seconds must be > 0".into()));
    }
    let row = runs::insert(
        &state.db,
        &scenario.id,
        &scenario.yaml,
        &body.profile,
        &body.env,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(to_response(row))))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<RunResponse>, ApiError> {
    let row = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

fn to_response(r: runs::RunRow) -> RunResponse {
    RunResponse {
        id: r.id,
        scenario_id: r.scenario_id,
        status: r.status,
        profile: r.profile,
        env: r.env,
        started_at: r.started_at,
        ended_at: r.ended_at,
        created_at: r.created_at,
    }
}
```

- [ ] **Step 4: Update `crates/controller/src/api/mod.rs`**

```rust
pub mod runs;
pub mod scenarios;
```

- [ ] **Step 5: Add routes in `crates/controller/src/app.rs`**

```rust
use axum::routing::{get, post};
use axum::Router;

use crate::api::{runs as runs_api, scenarios as scenarios_api};
use crate::store::Db;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/scenarios", post(scenarios_api::create))
        .route("/scenarios/{id}", get(scenarios_api::get))
        .route("/runs", post(runs_api::create))
        .route("/runs/{id}", get(runs_api::get))
        .with_state(state)
}
```

- [ ] **Step 6: Add an integration test to `crates/controller/tests/api_test.rs`**

Append:

```rust
#[tokio::test]
async fn create_run_for_scenario() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = app::router(app::AppState { db });

    // 1. create scenario
    let body = json!({
        "yaml": "version: 1\nname: t\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n"
    });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/scenarios")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 2. create run
    let run_body = json!({
        "scenario_id": scenario_id,
        "profile": { "vus": 5, "duration_seconds": 2 },
        "env": {}
    });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/runs")
        .header("content-type", "application/json")
        .body(Body::from(run_body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["status"], "pending");
}
```

- [ ] **Step 7: Run tests**

```bash
cargo test -p handicap-controller
```

Expected: all controller tests pass (4 now).

- [ ] **Step 8: Commit**

```bash
git add crates/controller
git commit -m "feat(controller): /runs REST (POST creates pending, GET reads status)"
```

---

## Task 12: `controller` — gRPC Coordinator skeleton

**Files:**
- Create: `crates/controller/src/grpc/mod.rs`
- Create: `crates/controller/src/grpc/coordinator.rs`
- Modify: `crates/controller/src/lib.rs` (add `pub mod grpc;`)
- Modify: `crates/controller/src/main.rs` (start gRPC server alongside REST)
- Modify: `crates/controller/src/app.rs` (add `Arc<Mutex<HashMap<run_id, RunCoord>>>` for pending assignments)

The Coordinator handles a single bidi stream per worker. In Slice 1 it:
1. Receives `Register{worker_id, run_id, capacity_vus}`
2. Looks up the run by id, finds the assigned scenario_yaml + profile
3. Sends back `RunAssignment{run_id, scenario_yaml, profile}`
4. Receives `MetricBatch` messages → persists (Task 14 wires the actual insert; this task just logs).
5. Receives `RunStatus{phase=Completed}` → flips DB status to `completed` and closes the stream

For this task, we stub the metric handler with a log line and a TODO. Persistence comes in Task 14.

- [ ] **Step 1: Write `crates/controller/src/grpc/mod.rs`**

```rust
pub mod coordinator;
```

- [ ] **Step 2: Write `crates/controller/src/grpc/coordinator.rs`**

```rust
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;

use futures::Stream;
use tokio::sync::Mutex;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;
use tonic::{Request, Response, Status, Streaming};
use tracing::{error, info, warn};

use handicap_proto::v1 as pb;
use pb::coordinator_server::Coordinator;
use pb::server_message::Payload as ServerPayload;
use pb::worker_message::Payload as WorkerPayload;
use pb::{Profile, RunAssignment, ServerMessage, WorkerMessage};

use crate::store::runs::{self, RunStatus};
use crate::store::Db;

/// What a pending run needs to hand to its worker.
#[derive(Debug, Clone)]
pub struct PendingAssignment {
    pub scenario_yaml: String,
    pub profile: Profile,
}

#[derive(Clone)]
pub struct CoordinatorState {
    pub db: Db,
    pub pending: Arc<Mutex<HashMap<String, PendingAssignment>>>,
}

impl CoordinatorState {
    pub fn new(db: Db) -> Self {
        Self {
            db,
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn enqueue(&self, run_id: String, a: PendingAssignment) {
        self.pending.lock().await.insert(run_id, a);
    }
}

pub struct CoordinatorService {
    pub state: CoordinatorState,
}

type ChannelStream = Pin<Box<dyn Stream<Item = Result<ServerMessage, Status>> + Send>>;

#[tonic::async_trait]
impl Coordinator for CoordinatorService {
    type ChannelStream = ChannelStream;

    async fn channel(
        &self,
        req: Request<Streaming<WorkerMessage>>,
    ) -> Result<Response<Self::ChannelStream>, Status> {
        let mut inbound = req.into_inner();
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<ServerMessage, Status>>(32);
        let state = self.state.clone();

        tokio::spawn(async move {
            let mut run_id: Option<String> = None;
            while let Some(msg) = inbound.next().await {
                let msg = match msg {
                    Ok(m) => m,
                    Err(e) => {
                        warn!(error = %e, "worker stream error");
                        break;
                    }
                };
                match msg.payload {
                    Some(WorkerPayload::Register(reg)) => {
                        run_id = Some(reg.run_id.clone());
                        info!(worker_id = %reg.worker_id, run_id = %reg.run_id, "worker registered");
                        let pending = state.pending.lock().await.remove(&reg.run_id);
                        match pending {
                            Some(a) => {
                                let assignment = RunAssignment {
                                    run_id: reg.run_id.clone(),
                                    scenario_yaml: a.scenario_yaml,
                                    profile: Some(a.profile),
                                };
                                let _ = tx
                                    .send(Ok(ServerMessage {
                                        payload: Some(ServerPayload::Assignment(assignment)),
                                    }))
                                    .await;
                                let _ = runs::set_status(
                                    &state.db,
                                    &reg.run_id,
                                    RunStatus::Running,
                                    Some(now_ms()),
                                    None,
                                )
                                .await;
                            }
                            None => {
                                error!(run_id = %reg.run_id, "no pending assignment for worker");
                                break;
                            }
                        }
                    }
                    Some(WorkerPayload::MetricBatch(batch)) => {
                        // Persistence wired in Task 14.
                        info!(
                            run_id = %batch.run_id,
                            windows = batch.windows.len(),
                            "received metric batch (persistence pending Task 14)"
                        );
                    }
                    Some(WorkerPayload::RunStatus(s)) => {
                        info!(run_id = %s.run_id, phase = ?s.phase, "worker run status");
                        if s.phase == pb::run_status::Phase::Completed as i32 {
                            let _ = runs::set_status(
                                &state.db,
                                &s.run_id,
                                RunStatus::Completed,
                                None,
                                Some(now_ms()),
                            )
                            .await;
                        } else if s.phase == pb::run_status::Phase::Failed as i32 {
                            let _ = runs::set_status(
                                &state.db,
                                &s.run_id,
                                RunStatus::Failed,
                                None,
                                Some(now_ms()),
                            )
                            .await;
                        }
                    }
                    Some(WorkerPayload::Pong(_)) => {}
                    None => {}
                }
            }
            info!(?run_id, "worker stream closed");
        });

        let out: ChannelStream = Box::pin(ReceiverStream::new(rx));
        Ok(Response::new(out))
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
```

- [ ] **Step 3: Update `crates/controller/src/lib.rs`**

```rust
pub mod api;
pub mod app;
pub mod error;
pub mod grpc;
pub mod store;
```

- [ ] **Step 4: Update `crates/controller/src/main.rs`** to start both servers concurrently

```rust
use std::net::SocketAddr;

use anyhow::Context;
use clap::Parser;
use handicap_controller::grpc::coordinator::{CoordinatorService, CoordinatorState};
use handicap_controller::{app, store};
use handicap_proto::v1::coordinator_server::CoordinatorServer;
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
struct Args {
    #[arg(long, default_value = "./handicap.db")]
    db: String,
    #[arg(long, default_value = "127.0.0.1:8080")]
    rest: SocketAddr,
    #[arg(long, default_value = "127.0.0.1:8081")]
    grpc: SocketAddr,
    #[arg(long, default_value = "target/debug/worker")]
    worker_bin: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    let args = Args::parse();
    info!(?args, "controller starting");

    let db_url = store::url_from_path(&args.db);
    let db = store::connect(&db_url).await?;
    let coord_state = CoordinatorState::new(db.clone());

    let state = app::AppState { db: db.clone(), coord: coord_state.clone(), worker_bin: args.worker_bin.clone(), grpc_addr: args.grpc };
    let app_router = app::router(state);

    let rest_listener = TcpListener::bind(args.rest).await.context("bind REST")?;
    info!(addr = %args.rest, "REST listening");

    let grpc_svc = CoordinatorServer::new(CoordinatorService { state: coord_state });

    let rest_fut = async {
        axum::serve(rest_listener, app_router).await.context("serve REST")
    };
    let grpc_fut = async {
        info!(addr = %args.grpc, "gRPC listening");
        tonic::transport::Server::builder()
            .add_service(grpc_svc)
            .serve(args.grpc)
            .await
            .context("serve gRPC")
    };

    tokio::try_join!(rest_fut, grpc_fut)?;
    Ok(())
}
```

- [ ] **Step 5: Update `crates/controller/src/app.rs`** so `AppState` carries the coordinator + worker info

```rust
use std::net::SocketAddr;

use axum::routing::{get, post};
use axum::Router;

use crate::api::{runs as runs_api, scenarios as scenarios_api};
use crate::grpc::coordinator::CoordinatorState;
use crate::store::Db;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub coord: CoordinatorState,
    pub worker_bin: String,
    pub grpc_addr: SocketAddr,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/scenarios", post(scenarios_api::create))
        .route("/scenarios/{id}", get(scenarios_api::get))
        .route("/runs", post(runs_api::create))
        .route("/runs/{id}", get(runs_api::get))
        .with_state(state)
}
```

- [ ] **Step 6: Update `crates/controller/tests/api_test.rs`** to satisfy the new `AppState` shape

Replace the two state constructions:

```rust
let coord = handicap_controller::grpc::coordinator::CoordinatorState::new(db.clone());
let app = app::router(app::AppState {
    db,
    coord,
    worker_bin: "/nonexistent".to_string(),
    grpc_addr: "127.0.0.1:0".parse().unwrap(),
});
```

(Use this in all three `#[tokio::test]` blocks; tests don't actually spawn a worker yet.)

- [ ] **Step 7: Build + run tests**

```bash
cargo build -p handicap-controller
cargo test -p handicap-controller
```

Expected: build succeeds (note the `_` unused-warning may appear for `app.worker_bin` and `app.grpc_addr` until Task 13 — that's acceptable for now; do not silence). Tests pass.

- [ ] **Step 8: Commit**

```bash
git add crates/controller
git commit -m "feat(controller): tonic Coordinator + Register/RunAssignment + RunStatus updates"
```

---

## Task 13: `controller` — Subprocess worker spawn on POST /runs

**Files:**
- Create: `crates/controller/src/worker_proc.rs`
- Modify: `crates/controller/src/lib.rs`
- Modify: `crates/controller/src/api/runs.rs`

When `POST /runs` succeeds, enqueue the pending assignment for the coordinator and spawn the worker binary as a child process. K8s replacement comes in Slice 6.

- [ ] **Step 1: Write `crates/controller/src/worker_proc.rs`**

```rust
use std::net::SocketAddr;
use std::process::Stdio;

use tokio::process::Command;
use tracing::{info, warn};
use ulid::Ulid;

pub async fn spawn_worker(
    worker_bin: &str,
    grpc_addr: SocketAddr,
    run_id: &str,
) -> anyhow::Result<()> {
    let worker_id = Ulid::new().to_string();
    let controller_url = format!("http://{}", grpc_addr);
    info!(%worker_id, %run_id, %controller_url, worker_bin, "spawning worker subprocess");

    // We do not await the child — the worker self-terminates when the run ends.
    let mut cmd = Command::new(worker_bin);
    cmd.arg("--controller").arg(&controller_url)
        .arg("--run-id").arg(run_id)
        .arg("--worker-id").arg(&worker_id)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(false);
    let mut child = cmd.spawn()?;

    // Reap in background so the OS doesn't leave zombies — log exit code.
    let run_id = run_id.to_string();
    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) => info!(%run_id, ?status, "worker exited"),
            Err(e) => warn!(%run_id, error = %e, "wait on worker failed"),
        }
    });

    Ok(())
}
```

- [ ] **Step 2: Update `crates/controller/src/lib.rs`**

```rust
pub mod api;
pub mod app;
pub mod error;
pub mod grpc;
pub mod store;
pub mod worker_proc;
```

- [ ] **Step 3: Modify `crates/controller/src/api/runs.rs`** to enqueue + spawn

Insert before the `Ok((StatusCode::CREATED, ...))` return in `create`:

```rust
// Enqueue the assignment so the coordinator can hand it to the worker when it registers.
let assignment = crate::grpc::coordinator::PendingAssignment {
    scenario_yaml: scenario.yaml.clone(),
    profile: handicap_proto::v1::Profile {
        vus: body.profile.vus,
        ramp_up_seconds: body.profile.ramp_up_seconds,
        duration_seconds: body.profile.duration_seconds,
    },
};
state.coord.enqueue(row.id.clone(), assignment).await;

// Spawn the worker subprocess. If this fails we still return the run row;
// the run will be left in `pending` and the operator can investigate.
if let Err(e) = crate::worker_proc::spawn_worker(&state.worker_bin, state.grpc_addr, &row.id).await {
    tracing::warn!(run_id = %row.id, error = %e, "failed to spawn worker");
}
```

Make sure the function pulls `body.profile.ramp_up_seconds` correctly (it is `u32`, defaulted to 0 by Slice 1 scope — see `Profile` in store).

- [ ] **Step 4: Manual smoke (deferred to Task 18 e2e)**

This task is intentionally not unit-tested in isolation — the meaningful check is the e2e in Task 18. Just build.

```bash
cargo build -p handicap-controller
cargo test -p handicap-controller
```

Expected: build clean, existing tests still pass (they use `/nonexistent` worker bin — spawn warns but the run row is still created).

- [ ] **Step 5: Commit**

```bash
git add crates/controller
git commit -m "feat(controller): spawn worker subprocess + enqueue run assignment on POST /runs"
```

---

## Task 14: `controller` — Persist metric batches

**Files:**
- Create: `crates/controller/src/store/metrics.rs`
- Modify: `crates/controller/src/store/mod.rs`
- Modify: `crates/controller/src/grpc/coordinator.rs`
- Modify: `crates/controller/src/api/runs.rs` (add GET /runs/:id/metrics endpoint)
- Modify: `crates/controller/src/app.rs`

- [ ] **Step 1: Write `crates/controller/src/store/metrics.rs`**

```rust
use std::collections::HashMap;

use serde::Serialize;
use sqlx::Row;

use super::Db;

pub struct MetricRow {
    pub run_id: String,
    pub ts_second: i64,
    pub step_id: String,
    pub count: i64,
    pub error_count: i64,
    pub hdr_histogram: Vec<u8>,
    pub status_counts: String,
}

pub async fn insert_batch(db: &Db, rows: &[MetricRow]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    // Single tx, individual upserts to handle late repeated keys.
    let mut tx = db.begin().await?;
    for r in rows {
        sqlx::query(
            "INSERT OR REPLACE INTO run_metrics(run_id,ts_second,step_id,count,error_count,hdr_histogram,status_counts) \
             VALUES(?,?,?,?,?,?,?)",
        )
        .bind(&r.run_id)
        .bind(r.ts_second)
        .bind(&r.step_id)
        .bind(r.count)
        .bind(r.error_count)
        .bind(&r.hdr_histogram)
        .bind(&r.status_counts)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

#[derive(Debug, Serialize)]
pub struct MetricSummary {
    pub run_id: String,
    pub windows: Vec<WindowSummary>,
}

#[derive(Debug, Serialize)]
pub struct WindowSummary {
    pub ts_second: i64,
    pub step_id: String,
    pub count: i64,
    pub error_count: i64,
    pub status_counts: HashMap<String, u64>,
}

pub async fn summary(db: &Db, run_id: &str) -> sqlx::Result<MetricSummary> {
    let rows = sqlx::query(
        "SELECT ts_second, step_id, count, error_count, status_counts \
         FROM run_metrics WHERE run_id = ? ORDER BY ts_second, step_id",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;

    let windows = rows
        .into_iter()
        .map(|r| {
            let status_json: String = r.get("status_counts");
            let parsed: HashMap<String, u64> =
                serde_json::from_str(&status_json).unwrap_or_default();
            WindowSummary {
                ts_second: r.get("ts_second"),
                step_id: r.get("step_id"),
                count: r.get("count"),
                error_count: r.get("error_count"),
                status_counts: parsed,
            }
        })
        .collect();

    Ok(MetricSummary {
        run_id: run_id.to_string(),
        windows,
    })
}
```

- [ ] **Step 2: Update `crates/controller/src/store/mod.rs`**

```rust
pub mod metrics;
pub mod runs;
pub mod scenarios;
```

- [ ] **Step 3: Replace the MetricBatch log in `crates/controller/src/grpc/coordinator.rs`**

Replace the body of the `Some(WorkerPayload::MetricBatch(batch))` arm with:

```rust
Some(WorkerPayload::MetricBatch(batch)) => {
    let rows: Vec<crate::store::metrics::MetricRow> = batch
        .windows
        .iter()
        .map(|w| {
            let status_json = serde_json::to_string(&w.status_counts)
                .unwrap_or_else(|_| "{}".to_string());
            crate::store::metrics::MetricRow {
                run_id: batch.run_id.clone(),
                ts_second: w.ts_second,
                step_id: w.step_id.clone(),
                count: w.count as i64,
                error_count: w.error_count as i64,
                hdr_histogram: w.hdr_histogram.clone(),
                status_counts: status_json,
            }
        })
        .collect();
    if let Err(e) = crate::store::metrics::insert_batch(&state.db, &rows).await {
        warn!(run_id = %batch.run_id, error = %e, "failed to insert metric batch");
    }
}
```

- [ ] **Step 4: Add `GET /runs/:id/metrics` endpoint to `crates/controller/src/api/runs.rs`**

```rust
pub async fn metrics(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<crate::store::metrics::MetricSummary>, ApiError> {
    // 404 if the run doesn't exist.
    let _ = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    let s = crate::store::metrics::summary(&state.db, &id).await?;
    Ok(Json(s))
}
```

Then in `crates/controller/src/app.rs` add the route:

```rust
.route("/runs/{id}/metrics", get(runs_api::metrics))
```

- [ ] **Step 5: Build**

```bash
cargo build -p handicap-controller
cargo test -p handicap-controller
```

Expected: clean build, existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add crates/controller
git commit -m "feat(controller): persist worker metric batches + GET /runs/:id/metrics"
```

---

## Task 15: `worker` — skeleton + gRPC connect + register

**Files:**
- Create: `crates/worker/Cargo.toml`
- Create: `crates/worker/src/main.rs`
- Create: `crates/worker/src/error.rs`
- Create: `crates/worker/src/client.rs`

- [ ] **Step 1: Write `crates/worker/Cargo.toml`**

```toml
[package]
name = "handicap-worker"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true
publish = false

[[bin]]
name = "worker"
path = "src/main.rs"

[dependencies]
handicap-engine = { path = "../engine" }
handicap-proto = { path = "../proto" }
anyhow.workspace = true
async-trait.workspace = true
clap.workspace = true
futures.workspace = true
tokio.workspace = true
tokio-stream.workspace = true
tonic.workspace = true
thiserror.workspace = true
tracing.workspace = true
tracing-subscriber.workspace = true
ulid.workspace = true
```

- [ ] **Step 2: Write `crates/worker/src/error.rs`**

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkerError {
    #[error("connect: {0}")]
    Connect(#[from] tonic::transport::Error),
    #[error("rpc: {0}")]
    Rpc(#[from] tonic::Status),
    #[error("engine: {0}")]
    Engine(#[from] handicap_engine::EngineError),
    #[error("send to controller stream failed")]
    SendFailed,
    #[error("missing assignment after register")]
    NoAssignment,
}
```

- [ ] **Step 3: Write `crates/worker/src/client.rs`**

```rust
use anyhow::Result;
use futures::StreamExt;
use handicap_proto::v1 as pb;
use pb::coordinator_client::CoordinatorClient;
use pb::server_message::Payload as ServerPayload;
use pb::worker_message::Payload as WorkerPayload;
use pb::{Register, RunAssignment, WorkerMessage};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::Channel;
use tracing::{info, warn};

use crate::error::WorkerError;

/// Wraps the worker's side of the bidi stream. After `register`, the worker
/// receives a single `RunAssignment` from the server, then the same `tx` is
/// used for ongoing `MetricBatch` / `RunStatus` sends.
pub struct WorkerLink {
    pub tx: mpsc::Sender<WorkerMessage>,
    pub assignment: RunAssignment,
    pub inbound: tokio::task::JoinHandle<()>,
}

pub async fn connect_and_register(
    controller_url: &str,
    worker_id: &str,
    run_id: &str,
    capacity_vus: u32,
) -> Result<WorkerLink, WorkerError> {
    let channel = Channel::from_shared(controller_url.to_string())
        .map_err(|e| WorkerError::Connect(tonic::transport::Error::from(e)))?
        .connect()
        .await?;
    let mut client = CoordinatorClient::new(channel);

    let (tx, rx) = mpsc::channel::<WorkerMessage>(64);
    let outbound = ReceiverStream::new(rx);
    let response = client.channel(outbound).await?;
    let mut inbound = response.into_inner();

    // Send Register.
    tx.send(WorkerMessage {
        payload: Some(WorkerPayload::Register(Register {
            worker_id: worker_id.to_string(),
            run_id: run_id.to_string(),
            capacity_vus,
        })),
    })
    .await
    .map_err(|_| WorkerError::SendFailed)?;
    info!(%worker_id, %run_id, "registered with controller");

    // Wait for the first ServerMessage — must be RunAssignment in slice 1.
    let first = inbound.next().await;
    let assignment = match first {
        Some(Ok(msg)) => match msg.payload {
            Some(ServerPayload::Assignment(a)) => a,
            other => {
                warn!(?other, "expected RunAssignment, got something else");
                return Err(WorkerError::NoAssignment);
            }
        },
        Some(Err(e)) => return Err(WorkerError::Rpc(e)),
        None => return Err(WorkerError::NoAssignment),
    };

    // Spawn an inbound consumer so we drain pings/aborts (no-op in slice 1).
    let handle = tokio::spawn(async move {
        while let Some(msg) = inbound.next().await {
            match msg {
                Ok(m) => tracing::debug!(?m.payload, "controller msg"),
                Err(e) => {
                    warn!(error = %e, "inbound stream closed");
                    break;
                }
            }
        }
    });

    Ok(WorkerLink { tx, assignment, inbound: handle })
}
```

- [ ] **Step 4: Write `crates/worker/src/main.rs` (skeleton, run hookup comes in Task 16)**

```rust
use anyhow::Context;
use clap::Parser;
use tracing::info;
use tracing_subscriber::EnvFilter;

mod client;
mod error;

#[derive(Debug, Parser)]
struct Args {
    #[arg(long)]
    controller: String,
    #[arg(long)]
    run_id: String,
    #[arg(long)]
    worker_id: String,
    #[arg(long, default_value = "1000")]
    capacity_vus: u32,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    let args = Args::parse();
    info!(?args, "worker starting");

    let _link = client::connect_and_register(&args.controller, &args.worker_id, &args.run_id, args.capacity_vus)
        .await
        .context("register with controller")?;
    info!("received assignment — execution coming in Task 16");
    Ok(())
}
```

- [ ] **Step 5: Build**

```bash
cargo build -p handicap-worker
```

Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add crates/worker
git commit -m "feat(worker): gRPC connect + Register + wait for RunAssignment"
```

---

## Task 16: `worker` — Run scenario + stream metrics back

**Files:**
- Modify: `crates/worker/src/main.rs`
- Modify: `crates/worker/src/client.rs` (or add helper send fns)

- [ ] **Step 1: Update `crates/worker/src/main.rs` to execute the assignment**

```rust
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use clap::Parser;
use handicap_engine::{run_scenario, RunPlan, Scenario, StepWindow};
use handicap_proto::v1 as pb;
use pb::worker_message::Payload as WorkerPayload;
use pb::{MetricBatch, MetricWindow, RunStatus, WorkerMessage};
use tokio::sync::mpsc;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

mod client;
mod error;

#[derive(Debug, Parser)]
struct Args {
    #[arg(long)]
    controller: String,
    #[arg(long)]
    run_id: String,
    #[arg(long)]
    worker_id: String,
    #[arg(long, default_value = "1000")]
    capacity_vus: u32,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    let args = Args::parse();
    info!(?args, "worker starting");

    let link = client::connect_and_register(
        &args.controller,
        &args.worker_id,
        &args.run_id,
        args.capacity_vus,
    )
    .await
    .context("register")?;
    let assignment = link.assignment;
    let tx = link.tx;

    let scenario: Scenario =
        Scenario::from_yaml(&assignment.scenario_yaml).context("parse scenario YAML")?;
    let scenario = Arc::new(scenario);
    let profile = assignment.profile.expect("assignment must include profile");
    let plan = RunPlan {
        vus: profile.vus,
        duration: Duration::from_secs(profile.duration_seconds as u64),
    };
    info!(vus = plan.vus, duration_s = profile.duration_seconds, "starting engine run");

    let (win_tx, mut win_rx) = mpsc::channel::<Vec<StepWindow>>(32);

    let run_id = args.run_id.clone();
    let worker_id = args.worker_id.clone();
    let tx_metric = tx.clone();
    let forwarder = tokio::spawn(async move {
        while let Some(batch) = win_rx.recv().await {
            let windows: Vec<MetricWindow> = batch
                .into_iter()
                .filter_map(|w| {
                    let hdr = w.serialize_histogram().ok()?;
                    let status_counts = w
                        .status_counts
                        .into_iter()
                        .map(|(k, v)| (k.to_string(), v))
                        .collect();
                    Some(MetricWindow {
                        ts_second: w.ts_second,
                        step_id: w.step_id,
                        count: w.count,
                        error_count: w.error_count,
                        hdr_histogram: hdr,
                        status_counts,
                    })
                })
                .collect();
            if windows.is_empty() {
                continue;
            }
            let msg = WorkerMessage {
                payload: Some(WorkerPayload::MetricBatch(MetricBatch {
                    run_id: run_id.clone(),
                    worker_id: worker_id.clone(),
                    windows,
                })),
            };
            if tx_metric.send(msg).await.is_err() {
                error!("controller stream closed, dropping batch");
                break;
            }
        }
    });

    let run_res = run_scenario(scenario, plan, win_tx).await;
    forwarder.await.ok();

    let phase = if run_res.is_ok() {
        pb::run_status::Phase::Completed as i32
    } else {
        pb::run_status::Phase::Failed as i32
    };
    let msg = WorkerMessage {
        payload: Some(WorkerPayload::RunStatus(RunStatus {
            run_id: args.run_id.clone(),
            phase,
            message: run_res
                .as_ref()
                .err()
                .map(|e| e.to_string())
                .unwrap_or_default(),
        })),
    };
    let _ = tx.send(msg).await;

    // Allow the controller a moment to receive the final status before we drop the stream.
    tokio::time::sleep(Duration::from_millis(200)).await;
    info!("worker done");
    Ok(())
}
```

- [ ] **Step 2: Build**

```bash
cargo build -p handicap-worker
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add crates/worker
git commit -m "feat(worker): run scenario + stream metric batches + final RunStatus"
```

---

## Task 17: Workspace lint + format

**Files:**
- Run-only; produces no source changes unless lints flag something.

- [ ] **Step 1: Format check**

```bash
cargo fmt --all -- --check
```

If anything is unformatted, run `cargo fmt --all` and inspect the diff.

- [ ] **Step 2: Clippy with deny-warnings**

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

Resolve any warnings (typically: unused imports, needless clones, dead code). If a clippy lint disagrees with a deliberate design choice, prefer a narrow `#[allow]` at the site over a global suppression.

- [ ] **Step 3: Commit any cleanups**

```bash
git add -A
git commit -m "chore: cargo fmt + clippy cleanups"
```

If nothing changed, skip the commit.

---

## Task 18: End-to-end acceptance test

**Files:**
- Create: `crates/controller/tests/e2e_test.rs`

This test boots an in-process controller (REST + gRPC), launches a wiremock target, builds the worker binary, POSTs a scenario and a run, then polls until completed and asserts metrics landed.

- [ ] **Step 1: Add test deps to `crates/controller/Cargo.toml`**

Under `[dev-dependencies]`, add:

```toml
wiremock.workspace = true
serde_json.workspace = true
```

- [ ] **Step 2: Write `crates/controller/tests/e2e_test.rs`**

```rust
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use handicap_controller::grpc::coordinator::{CoordinatorService, CoordinatorState};
use handicap_controller::{app, store};
use handicap_proto::v1::coordinator_server::CoordinatorServer;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn worker_bin_path() -> PathBuf {
    // CARGO_BIN_EXE_<name> is set for bins of crates listed in [dev-dependencies] OR
    // when running tests via `cargo test -p ... --test e2e_test` and `worker` is a workspace member.
    // To be robust across both, fall back to target/debug/worker.
    if let Ok(p) = std::env::var("CARGO_BIN_EXE_worker") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap()
        .parent().unwrap()
        .join("target/debug/worker")
}

async fn pick_addr() -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let a = l.local_addr().unwrap();
    drop(l);
    a
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn full_slice_1_e2e() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    // 0. Ensure the worker binary exists. The user must `cargo build -p handicap-worker` first
    //    OR rely on the workspace test runner having built it. To make this self-contained we
    //    build it here.
    let status = std::process::Command::new(env!("CARGO"))
        .args(["build", "-p", "handicap-worker"])
        .status()
        .expect("cargo build -p handicap-worker");
    assert!(status.success(), "worker build failed");
    let worker_bin = worker_bin_path();
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    // 1. Mock target.
    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&target)
        .await;

    // 2. Pick free ports for REST + gRPC.
    let rest_addr = pick_addr().await;
    let grpc_addr = pick_addr().await;

    // 3. Spin up controller in-process.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        worker_bin: worker_bin.to_string_lossy().to_string(),
        grpc_addr,
    });
    let rest_listener = TcpListener::bind(rest_addr).await.unwrap();
    let rest_handle = tokio::spawn(async move {
        axum::serve(rest_listener, app).await.unwrap();
    });
    let grpc_handle = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(CoordinatorServer::new(CoordinatorService { state: coord }))
            .serve(grpc_addr)
            .await
            .unwrap();
    });

    // give servers a moment to start
    tokio::time::sleep(Duration::from_millis(100)).await;

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);

    // 4. Create scenario pointing at the wiremock URL.
    let scenario_yaml = format!(
        "version: 1\nname: e2e\nvariables:\n  base: \"{}\"\nsteps:\n  - id: root\n    name: GET /\n    type: http\n    request:\n      method: GET\n      url: \"{{{{base}}}}/\"\n    assert:\n      - status: 200\n",
        target.uri()
    );
    let v: Value = http
        .post(format!("{}/scenarios", rest_base))
        .json(&json!({ "yaml": scenario_yaml }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 5. Create a run (2 VUs, 2s duration).
    let v: Value = http
        .post(format!("{}/runs", rest_base))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": { "vus": 2, "duration_seconds": 2 },
            "env": {}
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    // 6. Poll until completed (max 30s).
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut last_status = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{}/runs/{}", rest_base, run_id))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        last_status = v["status"].as_str().unwrap().to_string();
        if last_status == "completed" || last_status == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(last_status, "completed", "expected completed; got {last_status}");

    // 7. Metrics endpoint returns at least one window with non-zero count.
    let metrics: Value = http
        .get(format!("{}/runs/{}/metrics", rest_base, run_id))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let windows = metrics["windows"].as_array().expect("windows array");
    assert!(!windows.is_empty(), "expected metric windows");
    let total: u64 = windows
        .iter()
        .map(|w| w["count"].as_u64().unwrap_or(0))
        .sum();
    assert!(total > 0, "total count should be positive");
    let errors: u64 = windows
        .iter()
        .map(|w| w["error_count"].as_u64().unwrap_or(0))
        .sum();
    assert_eq!(errors, 0, "no assertion errors expected");

    rest_handle.abort();
    grpc_handle.abort();
}
```

- [ ] **Step 3: Run the e2e**

```bash
cargo test -p handicap-controller --test e2e_test -- --nocapture
```

Expected: passes within ~5 seconds. If the test stalls before "completed", check controller logs (the worker subprocess inherits stdio): worker should register, receive RunAssignment, run for 2 seconds, send batches, send RunStatus(Completed).

- [ ] **Step 4: Commit**

```bash
git add crates/controller
git commit -m "test(controller): slice-1 e2e — scenario→run→metrics over real gRPC"
```

---

## Task 19: CI scaffold

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  push:
    branches: [main, master]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install protoc
        run: sudo apt-get update && sudo apt-get install -y protobuf-compiler
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy
      - uses: Swatinem/rust-cache@v2
      - name: Format check
        run: cargo fmt --all -- --check
      - name: Clippy
        run: cargo clippy --workspace --all-targets -- -D warnings
      - name: Build (incl. worker bin, needed by e2e)
        run: cargo build --workspace
      - name: Test
        run: cargo test --workspace -- --nocapture
        env:
          RUST_LOG: info
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: cargo fmt + clippy + build + test on push/PR"
```

---

## Slice 1 acceptance — checklist

When all tasks land, verify locally before declaring slice 1 done:

- [ ] `just build` succeeds cleanly
- [ ] `just lint` is clean (fmt + clippy with -D warnings)
- [ ] `just test` passes including the e2e in Task 18
- [ ] Manual sanity (optional):
  ```bash
  just run-controller &   # leaves controller running on :8080 + :8081
  curl -s -X POST localhost:8080/scenarios \
    -H 'content-type: application/json' \
    -d '{"yaml":"version: 1\nname: t\nvariables:\n  base: \"http://example.com\"\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: \"{{base}}/\"\n    assert:\n      - status: 200\n"}'
  # → {"id":"01..","name":"t",...}
  curl -s -X POST localhost:8080/runs \
    -H 'content-type: application/json' \
    -d '{"scenario_id":"01..","profile":{"vus":3,"duration_seconds":5},"env":{}}'
  # poll: curl -s localhost:8080/runs/01..
  # eventually status:"completed", then:
  curl -s localhost:8080/runs/01../metrics | jq .
  ```

## Hand-off to Slice 2 (next plan)

Slice 1 leaves these explicit gaps for Slice 2 to pick up:
- React UI scaffold, scenario list/create/edit forms (no canvas yet)
- Wire REST client (fetch + React Query) against the existing `/scenarios`, `/runs`, `/runs/:id`, `/runs/:id/metrics` endpoints
- Controller starts serving the built UI as static files

Slice 3 then adds the canvas + bidirectional sync.
Slice 4 expands engine: multi-step + extract, env vars from run config, ramp-up curve, gRPC reconnect/backoff.
Slice 5 builds reports (charts, step table, status distribution, HTML render).
Slice 6 replaces subprocess spawn with K8s Job, ships the Helm chart + kind setup, hits performance acceptance criteria.

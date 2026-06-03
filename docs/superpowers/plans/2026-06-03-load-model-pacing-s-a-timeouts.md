# S-A 타임아웃 (Load Model & Pacing — Slice A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HTTP 요청 타임아웃을 설정 가능하게 만든다 — run-level `http_timeout_seconds`(profile, 하드코드 30s 대체)와 per-step `timeout_seconds`(시나리오 HttpStep 오버라이드).

**Architecture:** 영역 spec `docs/superpowers/specs/2026-06-03-load-model-pacing-config-design.md` §5 S-A. 두 knob은 순수 가산이고 새 실행 모델이 없다. run-level 값은 Profile(profile_json, `#[serde(default)]` → **마이그레이션 0건**) → proto `Profile` → worker → engine `RunPlan.http_timeout` → `VuClient`. per-step 값은 Scenario `HttpStep.timeout_seconds`(YAML) → executor의 `RequestBuilder::timeout`(client 기본을 그 요청만 덮어씀). **둘 다 미지정 → byte-identical**(하드코드 30s와 동일).

**Tech Stack:** Rust(engine/controller/worker) + prost/tonic(proto) + serde_yaml + reqwest + React/TS + Zod.

**Scope note:** 영역 spec S-A는 `connect_timeout_seconds`를 "곁들임(plan에서 뺄 수 있음)"으로 뒀다 — **이 plan에서는 제외**한다(첫 슬라이스를 최소·명확하게; proto/struct/literal/UI 곱셈 churn을 절반으로). spec §8/로드맵 §D에 후속으로 기록되어 있다.

**지배 원칙(영역 spec §3, 전 task 공통):**
- **absent → byte-identical**: 두 필드 미지정 시 현재 동작과 1바이트도 안 달라야 한다.
- 검증: profile knob = controller `validate_run_config`(1..=600), step knob = UI Zod(min 1, max 600). 엔진은 관대(0/누락이면 무시 또는 기본).
- 메트릭 파이프라인 무변경.

**이 repo 함정(미리 읽기):**
- prost/Rust struct는 exhaustive — `RunPlan`/proto `Profile`/store `Profile`/`HttpStep`에 필드를 더하면 **모든 literal 생성 사이트**가 컴파일 에러. 각 task가 한 green 커밋이 되도록 literal 갱신을 같은 task에 포함했다(루트 CLAUDE.md "prost exhaustive", "단독 커밋 불가" 함정).
- pre-commit hook이 비-`.md` 커밋마다 전체 workspace(`cargo build/clippy/test --workspace`)를 돌린다 — 각 task 끝의 commit은 **`run_in_background:false` + timeout 600000ms 단일 호출, 폴링 금지**(루트 CLAUDE.md subagent commit 함정).
- UI 커밋도 이 cargo hook을 다 거치지만 UI 게이트(`pnpm lint && pnpm test && pnpm build`)는 hook이 안 돌린다 — UI task는 commit 전 `cd ui && pnpm lint && pnpm test && pnpm build` 수동.
- `pnpm test`(esbuild)는 TS strict/Zod nested-default 누출을 못 잡는다 — **`pnpm build`(`tsc -b`)가 최종 게이트**(ui/CLAUDE.md).

---

## File Structure

| 파일 | 변경 | 책임 |
|---|---|---|
| `crates/engine/src/executor.rs` | modify | `VuClient::with_timeout` 추가, `new`가 30s로 위임; `execute_step`/`execute_step_traced`에 per-step `RequestBuilder::timeout` 적용 |
| `crates/engine/src/runner.rs` | modify | `RunPlan.http_timeout: Duration` + run_scenario→run_vu 스레딩 |
| `crates/engine/src/scenario.rs` | modify | `HttpStep.timeout_seconds: Option<u32>` |
| `crates/engine/tests/http_timeout.rs` | create | run-level + per-step 타임아웃 동작 통합 테스트(wiremock) |
| `crates/proto/proto/coordinator.proto` | modify | `Profile.http_timeout_seconds = 5` |
| `crates/controller/src/store/runs.rs` | modify | store `Profile.http_timeout_seconds` + `default_http_timeout` |
| `crates/controller/src/api/runs.rs` | modify | `validate_run_config` 범위 + proto Profile 매핑 |
| `crates/controller/src/grpc/coordinator.rs` | modify | proto/store Profile 테스트 literal |
| `crates/worker/src/main.rs` | modify | `RunPlan.http_timeout` = `profile.http_timeout_seconds`(0→30 가드) |
| 다수 test 파일 | modify | `RunPlan`/`HttpStep`/store·proto `Profile` literal에 새 필드 |
| `ui/src/api/schemas.ts` | modify | `ProfileSchema.http_timeout_seconds` |
| `ui/src/components/RunDialog.tsx` | modify | http_timeout 입력 + state + prefill + payload(×2) |
| `ui/src/scenario/model.ts` | modify | `HttpStepModel.timeout_seconds` |
| `ui/src/components/scenario/Inspector.tsx` | modify | per-step Timeout 입력(`setStepField`) |

---

## Task 1: Engine — configurable HTTP client timeout (run-level)

`RunPlan`에 `http_timeout: Duration`을 추가하고, `VuClient`가 그 값으로 client를 만들게 한다. `VuClient::new`는 30s로 위임하는 얇은 래퍼로 남겨 기존 호출 사이트(테스트·trace)를 안 건드린다.

**Files:**
- Create: `crates/engine/tests/http_timeout.rs`
- Modify: `crates/engine/src/executor.rs:20-31` (VuClient), `crates/engine/src/runner.rs:19-31` (RunPlan), `:222-234` (run_vu), `:96-114` (spawn → run_vu 호출)
- Modify (literal 갱신, `http_timeout: Duration::from_secs(30),` 한 줄 추가): `crates/worker/src/main.rs:189`, `crates/worker/tests/abort_and_env.rs:47,68`, `crates/engine/tests/{if_node.rs:35,257,415, runner_e2e.rs:40, loop_node.rs:58,138,214, all_vus_failed.rs:29, vu_offset.rs:19, json_cast.rs:54, data_binding.rs:52,116,180, ramp_up.rs:41, multi_step.rs:64,172,234,296}` — 각 `RunPlan { ... data_binding: None, }` 블록의 `data_binding` 줄 바로 뒤에 추가

- [ ] **Step 1: Write the failing test** `crates/engine/tests/http_timeout.rs`

```rust
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{MetricFlush, RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Drive a 1-VU run for `run_secs` against a target that delays `delay_ms`, with
/// the engine client timeout set to `http_timeout`. Returns (total, errors).
async fn run_with_timeout(delay_ms: u64, http_timeout: Duration, run_secs: u64) -> (u64, u64) {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/slow"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(delay_ms)))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: timeout-test
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000050"
    name: slow
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/slow"
    assert: []
"#,
        server.uri()
    );

    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(run_secs),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_binding: None,
        http_timeout,
    };
    let cancel = CancellationToken::new();
    let run = tokio::spawn(async move {
        run_scenario(scenario, plan, tx, cancel).await.expect("run ok");
    });
    let (mut total, mut errors) = (0u64, 0u64);
    while let Some(flush) = rx.recv().await {
        for w in flush.windows {
            total += w.count;
            errors += w.error_count;
        }
    }
    run.await.expect("join");
    (total, errors)
}

#[tokio::test]
async fn short_client_timeout_errors_on_slow_target() {
    // Target delays 400ms; client timeout 100ms → every request times out (status 0, error).
    let (total, errors) = run_with_timeout(400, Duration::from_millis(100), 1).await;
    assert!(total > 0, "at least one request recorded");
    assert_eq!(errors, total, "all requests should time out: {errors}/{total}");
}

#[tokio::test]
async fn generous_client_timeout_succeeds_on_slow_target() {
    // Same 400ms delay but 5s timeout → no timeout errors.
    let (total, errors) = run_with_timeout(400, Duration::from_secs(5), 2).await;
    assert!(total > 0, "at least one request recorded");
    assert_eq!(errors, 0, "no request should time out: {errors}/{total}");
}
```

- [ ] **Step 2: Run test to verify it fails (compile error — `http_timeout` field missing)**

Run: `cargo test -p handicap-engine --test http_timeout 2>&1 | head -20`
Expected: FAIL — `RunPlan` has no field `http_timeout` (and `run_scenario` plumbing not done).

- [ ] **Step 3: Add `http_timeout` to `RunPlan` and the `VuClient::with_timeout` constructor**

In `crates/engine/src/runner.rs`, add the field to `RunPlan` (after `data_binding`, around line 30):

```rust
    /// Optional data-driven binding. `None` → no injection (back-compat).
    pub data_binding: Option<Arc<DataSet>>,
    /// Total per-request HTTP timeout for every VU client (reqwest client-level).
    /// `30s` reproduces the pre-S-A hardcoded default.
    pub http_timeout: Duration,
}
```

In `crates/engine/src/executor.rs`, replace `VuClient::new` (lines 20-31) with a delegating `new` + a `with_timeout`:

```rust
impl VuClient {
    /// Back-compat constructor: 30s total request timeout (pre-S-A default).
    pub fn new(cookie_mode: CookieJarMode) -> Result<Self> {
        Self::with_timeout(cookie_mode, Duration::from_secs(30))
    }

    pub fn with_timeout(cookie_mode: CookieJarMode, timeout: Duration) -> Result<Self> {
        let mut builder = reqwest::Client::builder()
            .timeout(timeout)
            .user_agent("handicap/0.1");
        if let CookieJarMode::Auto = cookie_mode {
            let jar = Arc::new(Jar::default());
            builder = builder.cookie_provider(jar);
        }
        let inner = builder.build()?;
        Ok(Self { inner })
    }
}
```

- [ ] **Step 4: Thread `http_timeout` through `run_scenario` → `run_vu`**

In `crates/engine/src/runner.rs::run_scenario`, capture the timeout near the top (after `let dataset = ...`, ~line 56):

```rust
    let http_timeout = plan.http_timeout;
```

In the spawn block (~lines 96-103), clone it into each VU task and pass to `run_vu`. Add `let http_timeout = http_timeout;` is unnecessary (Duration is Copy) — just pass `http_timeout` as the final arg:

```rust
            set.spawn(async move {
                if let Err(e) = run_vu(
                    scenario,
                    vu_id,
                    agg,
                    deadline,
                    env,
                    cancel_vu,
                    dataset,
                    seq_counter,
                    http_timeout,
                )
                .await
                {
```

Update `run_vu`'s signature (line 222-233) to accept it and use `with_timeout`:

```rust
#[allow(clippy::too_many_arguments)]
#[instrument(skip(scenario, agg, env, dataset, seq_counter), fields(vu_id))]
async fn run_vu(
    scenario: Arc<Scenario>,
    vu_id: u32,
    agg: Arc<Mutex<Aggregator>>,
    deadline: Instant,
    env: Arc<BTreeMap<String, String>>,
    cancel: CancellationToken,
    dataset: Option<Arc<DataSet>>,
    seq_counter: Option<Arc<AtomicU64>>,
    http_timeout: Duration,
) -> Result<()> {
    let client = VuClient::with_timeout(scenario.cookie_jar, http_timeout)?;
```

(Leave `trace.rs:112`'s `VuClient::new(scenario.cookie_jar)` and all `executor.rs` test `VuClient::new(...)` sites unchanged — `new` still exists.)

- [ ] **Step 5: Update every other `RunPlan { … }` literal**

Add `http_timeout: Duration::from_secs(30),` immediately after the `data_binding: None,` (or `data_binding: ...,`) line in each site listed under **Files** above. Worker prod site `crates/worker/src/main.rs:189` gets the same hardcoded `Duration::from_secs(30)` for now (Task 2 wires it to the profile).

Find any you missed:

Run: `grep -rn "RunPlan {" crates/ | grep -v "runner.rs:20"` then for each, confirm the literal now contains `http_timeout`.

- [ ] **Step 6: Run the new test + full engine suite**

Run: `cargo test -p handicap-engine 2>&1 | tail -20`
Expected: PASS (incl. `short_client_timeout_errors_on_slow_target`, `generous_client_timeout_succeeds_on_slow_target`). If a `RunPlan` literal is still missing the field, the build error names the file:line — add it.

- [ ] **Step 7: Commit** (single foreground call, no polling — runs full workspace gate, may take minutes)

```bash
git add -A && git commit -m "feat(engine): configurable HTTP client timeout (RunPlan.http_timeout)

VuClient::with_timeout(cookie_mode, timeout); new() delegates 30s (back-compat).
run_scenario threads plan.http_timeout → run_vu → with_timeout. trace + executor
tests keep new() (30s). All RunPlan literals gain http_timeout. S-A (load-model-pacing).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Profile wire — `http_timeout_seconds` (proto + controller + worker)

`RunPlan.http_timeout`을 worker가 하드코딩하던 걸 proto `Profile`에서 받아오게 한다. profile_json은 `#[serde(default)]`라 마이그레이션 없음.

**Files:**
- Modify: `crates/proto/proto/coordinator.proto:98-103` (Profile)
- Modify: `crates/controller/src/store/runs.rs:71-83` (struct) + `default_http_timeout` fn 추가
- Modify: `crates/controller/src/api/runs.rs:62-75` (validate) + `:197-202` (proto 매핑)
- Modify: `crates/controller/src/grpc/coordinator.rs:951` (proto literal), `:969` (store literal)
- Modify (store `Profile { }` literal에 `http_timeout_seconds: 30,` 추가): `crates/controller/src/report.rs:384`, `crates/controller/src/api/runs.rs:518`, `crates/controller/src/store/presets.rs:194`, `crates/controller/src/store/runs.rs:321,384`
- Modify: `crates/worker/src/main.rs:189` (RunPlan.http_timeout ← profile)

- [ ] **Step 1: Write the failing test** — append to `crates/controller/src/api/runs.rs` `#[cfg(test)] mod tests`

```rust
    #[tokio::test]
    async fn rejects_out_of_range_http_timeout() {
        let state = test_state().await; // existing helper in this module's tests
        let mut p = simple_profile(); // existing helper: vus>0, duration>0
        p.http_timeout_seconds = 0;
        let err = validate_run_config(&state, &p).await.unwrap_err();
        assert!(matches!(err, ApiError::BadRequest(_)), "0 must be rejected");
        p.http_timeout_seconds = 601;
        let err = validate_run_config(&state, &p).await.unwrap_err();
        assert!(matches!(err, ApiError::BadRequest(_)), ">600 must be rejected");
    }

    #[test]
    fn old_profile_json_without_http_timeout_defaults_to_30() {
        // profile_json rows persisted before S-A have no http_timeout_seconds key.
        let json = serde_json::json!({ "vus": 2, "duration_seconds": 5 });
        let p: Profile = serde_json::from_value(json).expect("deserializes with serde default");
        assert_eq!(p.http_timeout_seconds, 30);
    }
```

> If `simple_profile()`/`test_state()` helpers don't exist with those exact names, mirror the construction used by the existing `validates_loop_breakdown_cap_bounds` test (`crates/controller/src/api/runs.rs:485`) and the `unique_profile` helper (`:517`). The point: a `Profile` with valid vus/duration and `http_timeout_seconds` set to 0 / 601.

- [ ] **Step 2: Run test to verify it fails (no `http_timeout_seconds` field yet)**

Run: `cargo test -p handicap-controller old_profile_json_without_http_timeout 2>&1 | head -20`
Expected: FAIL — `Profile` has no field `http_timeout_seconds`.

- [ ] **Step 3: Add the proto field** — `crates/proto/proto/coordinator.proto`

```proto
message Profile {
  uint32 vus = 1;
  uint32 ramp_up_seconds = 2;
  uint32 duration_seconds = 3;
  uint32 loop_breakdown_cap = 4;   // 0 = disabled
  uint32 http_timeout_seconds = 5; // 0 = use default (30s)
}
```

- [ ] **Step 4: Add the store field + default** — `crates/controller/src/store/runs.rs`

In `struct Profile` (after `loop_breakdown_cap`):

```rust
    #[serde(default = "default_http_timeout")]
    pub http_timeout_seconds: u32,
```

Add the default fn next to `default_loop_cap`:

```rust
fn default_http_timeout() -> u32 {
    30
}
```

- [ ] **Step 5: Validate range + map to proto** — `crates/controller/src/api/runs.rs`

In `validate_run_config`, after the `loop_cap_ok` check (~line 75):

```rust
    if profile.http_timeout_seconds == 0 || profile.http_timeout_seconds > 600 {
        return Err(ApiError::BadRequest(
            "http_timeout_seconds must be between 1 and 600".into(),
        ));
    }
```

In the proto `Profile` literal (~line 197):

```rust
        profile: handicap_proto::v1::Profile {
            vus: body.profile.vus,
            ramp_up_seconds: body.profile.ramp_up_seconds,
            duration_seconds: body.profile.duration_seconds,
            loop_breakdown_cap: body.profile.loop_breakdown_cap,
            http_timeout_seconds: body.profile.http_timeout_seconds,
        },
```

- [ ] **Step 6: Update remaining Profile literals (proto + store)**

- `crates/controller/src/grpc/coordinator.rs:951` (`pb::Profile { … }`): add `http_timeout_seconds: 30,`.
- `crates/controller/src/grpc/coordinator.rs:969` (`runs::Profile { … }`): add `http_timeout_seconds: 30,`.
- store `Profile { … }` literals — add `http_timeout_seconds: 30,`: `report.rs:384`, `api/runs.rs:518`, `store/presets.rs:194`, `store/runs.rs:321`, `store/runs.rs:384`.

Find any missed: `grep -rn "Profile {" crates/controller/src` and confirm each literal carries the field.

- [ ] **Step 7: Worker consumes the proto field (0→30 guard)** — `crates/worker/src/main.rs:189`

Replace the hardcoded `http_timeout: Duration::from_secs(30),` with:

```rust
        // proto default 0 (absent field from an old controller) → fall back to 30s
        // so the byte-identical invariant holds; current controllers send 1..=600.
        http_timeout: Duration::from_secs(u64::from(
            if profile.http_timeout_seconds == 0 {
                30
            } else {
                profile.http_timeout_seconds
            },
        )),
```

- [ ] **Step 8: Run controller + worker + proto suites**

Run: `cargo test -p handicap-controller -p handicap-worker -p handicap-proto 2>&1 | tail -20`
Expected: PASS (incl. both new tests).

- [ ] **Step 9: Commit** (single foreground call, no polling)

```bash
git add -A && git commit -m "feat(controller,proto,worker): http_timeout_seconds profile field

proto Profile.http_timeout_seconds=5 (0=default), store Profile serde-default 30
(no migration — profile_json), validate_run_config 1..=600, worker maps to
RunPlan.http_timeout with 0->30 guard. S-A (load-model-pacing).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: UI — RunDialog `http_timeout_seconds` 입력

**Files:**
- Modify: `ui/src/api/schemas.ts:46-54` (ProfileSchema)
- Modify: `ui/src/components/RunDialog.tsx` (state ~67, prefill ~116, payload ~178 & ~495, 입력 폼 ~318)
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`

- [ ] **Step 1: Write the failing test** — append to `ui/src/components/__tests__/RunDialog.test.tsx`

```tsx
it("submits http_timeout_seconds from the input (default 30)", async () => {
  const user = userEvent.setup();
  const onCreate = vi.fn();
  renderRunDialog({ onCreate }); // use the file's existing render helper + queryClient wrapper

  const timeout = screen.getByLabelText(/HTTP timeout/i) as HTMLInputElement;
  expect(timeout.value).toBe("30");
  await user.clear(timeout);
  await user.type(timeout, "45");

  await user.click(screen.getByRole("button", { name: /^run$|시작|create/i }));

  expect(onCreate).toHaveBeenCalled();
  const payload = onCreate.mock.calls[0][0];
  expect(payload.profile.http_timeout_seconds).toBe(45);
});
```

> Match the file's existing render/submit helpers and button name (mirror an existing "submits …" test in this file). The assertion that matters: the submitted `profile.http_timeout_seconds` reflects the input.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm test RunDialog 2>&1 | tail -20`
Expected: FAIL — no element with label /HTTP timeout/.

- [ ] **Step 3: Add the field to `ProfileSchema`** — `ui/src/api/schemas.ts`

```ts
  loop_breakdown_cap: z.number().int().min(0).max(10000).default(256),
  http_timeout_seconds: z.number().int().min(1).max(600).default(30),
```

- [ ] **Step 4: Wire RunDialog state, prefill, payload, input**

State (next to `loopCap`, ~line 68):

```tsx
  const [httpTimeout, setHttpTimeout] = useState(initial?.profile.http_timeout_seconds ?? 30);
```

Prefill (in the preset-load block, next to `setLoopCap(prof.loop_breakdown_cap)`, ~line 117):

```tsx
      setHttpTimeout(prof.http_timeout_seconds);
```

Both `profile: { … }` payload literals (run-create ~line 182 and `currentInput()` preset-save ~line 499) — add after `loop_breakdown_cap`:

```tsx
          http_timeout_seconds: httpTimeout,
```

Input — add a 4th cell to the `grid grid-cols-3` block (change it to `grid-cols-4`) at ~line 285, after the Ramp-up label:

```tsx
        <label className="block text-sm">
          <span className="text-slate-600">HTTP timeout (s)</span>
          <input
            type="number"
            min={1}
            max={600}
            aria-label="HTTP timeout (s)"
            value={httpTimeout}
            onChange={(e) => setHttpTimeout(Number(e.target.value))}
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
```

- [ ] **Step 5: Run UI gates**

Run: `cd ui && pnpm test RunDialog 2>&1 | tail -15 && pnpm lint && pnpm build`
Expected: test PASS, lint clean (`--max-warnings=0`), `tsc -b` clean.

- [ ] **Step 6: Commit** (UI change still triggers the full cargo pre-commit gate — single foreground call)

```bash
git add -A && git commit -m "feat(ui): RunDialog HTTP timeout (s) input → profile.http_timeout_seconds

ProfileSchema.http_timeout_seconds (default 30), RunDialog state/prefill/payload
(run-create + preset). S-A (load-model-pacing).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Engine — per-step `timeout_seconds` (HttpStep + executor)

스텝별 타임아웃으로 client 기본을 그 요청만 덮어쓴다(reqwest `RequestBuilder::timeout`). 부하·trace 둘 다 적용(lockstep, engine CLAUDE.md).

**Files:**
- Modify: `crates/engine/src/scenario.rs:65-75` (HttpStep)
- Modify: `crates/engine/src/executor.rs:118` (execute_step), `:306` (execute_step_traced)
- Modify (HttpStep literal에 `timeout_seconds: None,` 추가): `crates/engine/tests/proptests.rs:73`, `crates/engine/src/executor.rs:{470,514,558,601,640,672,717,758,801,1037}`
- Test: `crates/engine/tests/http_timeout.rs` (append), `crates/engine/src/scenario.rs` tests (append)

- [ ] **Step 1: Write the failing tests**

Append a round-trip test to `crates/engine/src/scenario.rs` `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn http_step_timeout_seconds_round_trips_and_omits_when_absent() {
        let with = r#"
version: 1
name: t
steps:
  - id: "01HX0000000000000000000051"
    name: slow
    type: http
    timeout_seconds: 5
    request: { method: GET, url: "/x" }
    assert: []
"#;
        let s = Scenario::from_yaml(with).unwrap();
        let Step::Http(h) = &s.steps[0] else { panic!("http") };
        assert_eq!(h.timeout_seconds, Some(5));
        let out = s.to_yaml().unwrap();
        assert!(out.contains("timeout_seconds: 5"), "round-trips:\n{out}");
        let s2 = Scenario::from_yaml(&out).unwrap();
        assert_eq!(s, s2);

        // Absent → field None → key omitted on serialize (byte-identical).
        let without = r#"
version: 1
name: t
steps:
  - id: "01HX0000000000000000000052"
    name: x
    type: http
    request: { method: GET, url: "/x" }
    assert: []
"#;
        let s3 = Scenario::from_yaml(without).unwrap();
        let Step::Http(h3) = &s3.steps[0] else { panic!("http") };
        assert_eq!(h3.timeout_seconds, None);
        assert!(!s3.to_yaml().unwrap().contains("timeout_seconds"));
    }
```

Append a behavior test to `crates/engine/tests/http_timeout.rs` (reuses `MockServer` import):

```rust
/// A per-step `timeout_seconds` overrides the (generous) client timeout for that
/// step only: a 1s step timeout against a 1500ms-delayed target → all errors,
/// even though the client default is 30s.
#[tokio::test]
async fn per_step_timeout_overrides_client_default() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/slow"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(1500)))
        .mount(&server)
        .await;
    let yaml = format!(
        r#"
version: 1
name: per-step-timeout
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000053"
    name: slow
    type: http
    timeout_seconds: 1
    request:
      method: GET
      url: "{{{{base}}}}/slow"
    assert: []
"#,
        server.uri()
    );
    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(2),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_binding: None,
        http_timeout: Duration::from_secs(30), // generous client default
    };
    let cancel = CancellationToken::new();
    let run = tokio::spawn(async move {
        run_scenario(scenario, plan, tx, cancel).await.expect("run ok");
    });
    let (mut total, mut errors) = (0u64, 0u64);
    while let Some(flush) = rx.recv().await {
        for w in flush.windows {
            total += w.count;
            errors += w.error_count;
        }
    }
    run.await.expect("join");
    assert!(total > 0, "at least one request recorded");
    assert_eq!(errors, total, "per-step 1s timeout must fire: {errors}/{total}");
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p handicap-engine http_step_timeout_seconds_round_trips 2>&1 | head -20`
Expected: FAIL — `HttpStep` has no field `timeout_seconds`.

- [ ] **Step 3: Add the field to `HttpStep`** — `crates/engine/src/scenario.rs`

```rust
pub struct HttpStep {
    pub id: String,
    pub name: String,
    pub request: Request,
    #[serde(default)]
    pub assert: Vec<Assertion>,
    #[serde(default)]
    pub extract: Vec<Extract>,
    /// Per-step total request timeout (seconds), overriding the run-level
    /// `http_timeout`. Absent → use the client default. Authoring-validated
    /// (1..=600) UI-side; the executor ignores `Some(0)` (lenient).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u32>,
}
```

- [ ] **Step 4: Update every `HttpStep { … }` literal**

Add `timeout_seconds: None,` to each site under **Files** (after `extract: …,`). In `proptests.rs:73` the literal is inside a `prop_map` closure — add `timeout_seconds: None,` there too. Confirm: `grep -rn "HttpStep {" crates/` → each carries the field.

- [ ] **Step 5: Apply the per-step timeout in the executor (both paths)**

`crates/engine/src/executor.rs`, in `execute_step` immediately after line 118 (`let mut req = client.inner.request(method, &url).headers(headers);`):

```rust
    if let Some(secs) = step.timeout_seconds.filter(|s| *s > 0) {
        req = req.timeout(Duration::from_secs(secs as u64));
    }
```

In `execute_step_traced` immediately after line 306 (the identical `let mut req = client.inner.request(method, &url).headers(headers);`):

```rust
    if let Some(secs) = step.timeout_seconds.filter(|s| *s > 0) {
        req = req.timeout(Duration::from_secs(secs as u64));
    }
```

- [ ] **Step 6: Run engine suite**

Run: `cargo test -p handicap-engine 2>&1 | tail -20`
Expected: PASS (round-trip + `per_step_timeout_overrides_client_default`). The behavior test takes ~1.2s (1s timeout) — expected.

- [ ] **Step 7: Commit** (single foreground call, no polling)

```bash
git add -A && git commit -m "feat(engine): per-step HttpStep.timeout_seconds override

Optional Option<u32> on HttpStep (serde default, omitted when None → byte-identical).
execute_step + execute_step_traced apply RequestBuilder::timeout (>0 only, lenient).
S-A (load-model-pacing).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: UI — per-step Timeout 입력 (HttpStepModel + Inspector)

**Files:**
- Modify: `ui/src/scenario/model.ts:76-86` (HttpStepModel)
- Modify: `ui/src/components/scenario/Inspector.tsx:190-193` (Request fieldset 뒤 Timeout 필드)
- Test: `ui/src/components/scenario/__tests__/Inspector.test.tsx`

- [ ] **Step 1: Write the failing test** — append to `ui/src/components/scenario/__tests__/Inspector.test.tsx`

```tsx
it("edits per-step timeout_seconds via setStepField", async () => {
  const user = userEvent.setup();
  // mirror this file's existing setup: seed the store with one http step + select it.
  seedHttpStep("01HX0000000000000000000054"); // helper used by other Inspector tests
  render(<Inspector />);

  const input = screen.getByLabelText(/timeout \(s\)/i) as HTMLInputElement;
  await user.clear(input);
  await user.type(input, "12");
  input.blur(); // commit-on-blur not required for number input; assert store value

  const step = useScenarioEditor.getState().model!.steps[0];
  expect(step.type).toBe("http");
  // @ts-expect-error narrow
  expect(step.timeout_seconds).toBe(12);
});
```

> Match this file's actual store-seeding/render helpers (how existing tests select an http step). The behavioral assertion: typing into the Timeout input sets `timeout_seconds` on the step (via `setStepField(step.id, ["timeout_seconds"], …)`).

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && pnpm test Inspector 2>&1 | tail -20`
Expected: FAIL — no element labeled /timeout (s)/.

- [ ] **Step 3: Add `timeout_seconds` to `HttpStepModel`** — `ui/src/scenario/model.ts`

```ts
export const HttpStepModel = z
  .object({
    id: z.string().regex(ULID_RE, "step id must be a ULID"),
    name: z.string().min(1, "step name required"),
    type: z.literal("http"),
    request: RequestModel,
    assert: z.array(AssertionModel).default([]),
    extract: z.array(ExtractModel).default([]),
    timeout_seconds: z.number().int().min(1).max(600).optional(),
  })
  .strict();
```

- [ ] **Step 4: Add the Inspector input** — `ui/src/components/scenario/Inspector.tsx`

In the http-step body, after the Request `</fieldset>` (line 193) and before `<AssertEditor … />`:

```tsx
      <Field label="Timeout (s)">
        <input
          type="number"
          min={1}
          max={600}
          aria-label="timeout (s)"
          className="w-full border border-slate-300 rounded px-2 py-1"
          value={step.timeout_seconds ?? ""}
          onChange={(e) =>
            setStepField(
              step.id,
              ["timeout_seconds"],
              e.target.value === "" ? undefined : Number(e.target.value),
            )
          }
        />
      </Field>
```

(`setStepField` already deletes the YAML key when value is `undefined` — `yamlDoc.ts:297` — so clearing the input → key omitted → byte-identical.)

- [ ] **Step 5: Run UI gates**

Run: `cd ui && pnpm test Inspector 2>&1 | tail -15 && pnpm lint && pnpm build`
Expected: test PASS, lint clean, `tsc -b` clean. If `tsc -b` flags `timeout_seconds` not existing on the narrowed http step, confirm `HttpStepModel` change landed (Step 3).

- [ ] **Step 6: Commit** (single foreground call, no polling)

```bash
git add -A && git commit -m "feat(ui): per-step Timeout (s) input in Inspector → step.timeout_seconds

HttpStepModel.timeout_seconds (optional, 1..=600), Inspector field via setStepField
(undefined clears the YAML key). S-A (load-model-pacing).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (post-write)

**Spec coverage (영역 spec §5 S-A):**
- `http_timeout_seconds` (profile, 30s 대체) → Task 1(engine 소비) + Task 2(wire) + Task 3(UI). ✓
- per-step `timeout_seconds` (HttpStep 오버라이드) → Task 4(engine) + Task 5(UI). ✓
- `connect_timeout_seconds` → **의도적 제외**(spec이 "곁들임, plan에서 뺄 수 있음"으로 허용, scope note 참조). ✓
- absent → byte-identical → Task 1 `new()`=30s 유지 + 모든 literal 30s, Task 2 store serde-default 30 + worker 0→30 가드, Task 4 `skip_serializing_if`로 키 생략, Task 5 undefined→deleteIn. ✓
- 검증 1..=600 → Task 2 `validate_run_config`(profile) + Task 3/5 Zod `min(1).max(600)`. ✓
- 마이그레이션 0건 → Task 2 profile_json `#[serde(default)]`만, `runs` 테이블 무변경. ✓
- 메트릭 무변경 → 어떤 task도 aggregator/MetricFlush/proto MetricBatch 미접촉. ✓

**Placeholder scan:** literal-갱신 다수-사이트는 "추가할 정확한 한 줄 + 파일:라인 목록 + 앵커"로 완전 명시(루트 CLAUDE.md가 권하는 grep 교차검증 포함). UI 테스트의 render/seed 헬퍼는 "이 파일의 기존 헬퍼를 미러"로 지시 — 각 테스트 파일의 실제 헬퍼명은 구현자가 그 파일에서 확인(테스트 자체 로직은 완전 명시). 그 외 TBD/TODO 없음.

**Type consistency:** `http_timeout`(engine `Duration`) vs `http_timeout_seconds`(proto/store/UI `u32`/number) — 경계마다 변환 명시(worker `Duration::from_secs(... as u64)`). `timeout_seconds`(HttpStep `Option<u32>` / Zod `.optional()`) 일관. `setStepField(id, ["timeout_seconds"], number|undefined)` — yamlDoc `setStepField`가 undefined→deleteIn 처리(확인됨). `VuClient::with_timeout` 시그니처 Task 1에서 정의, Task 1에서만 호출. 일관.

**커밋 경계 = pre-commit 전체-게이트 정합:** 각 task는 한 green 커밋(literal 갱신을 같은 task에 묶어 "필드 추가 단독 커밋이 깨지는" 함정 회피). 5 커밋 모두 workspace green.

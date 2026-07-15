# open-loop think time UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two §B21 security-review findings — server-side think-time range validation, and the open-loop think-time footgun — by adding a shared validation walk, an open-loop "ignore scenario think time" toggle (default ignore, implemented via controller-side YAML strip), and an observed-RPS anchor that eases closed↔open switching.

**Architecture:** Three controller-side additions (a shared think-range predicate + recursive walk wired to scenario create/update/test-run; a `Profile.apply_scenario_think_time` profile_json field; a `spawn_run` strip that removes think from the *worker-sent* YAML copy only) plus three UI additions (a `scenarioHasThink` helper + Zod field + conditional `buildProfile`; an open-loop toggle in `LoadModelFields`; an observed-RPS anchor reusing the existing `sizePresetAnchor` prop). The engine, proto, and DB migrations are untouched (0-diff): the worker receives think-free YAML, so no flag needs to cross the wire.

**Tech Stack:** Rust (axum controller, `handicap_engine` scenario model, serde/serde_yaml), TypeScript/React UI (Zod, Zustand, vitest/RTL).

**Spec:** `docs/superpowers/specs/2026-07-15-open-loop-think-time-ux-design.md`

## Global Constraints

Every task's requirements implicitly include these (verbatim from the spec):

- **Engine / proto / migration: 0-diff.** No changes to `crates/engine`, `crates/proto`, or any `.sql` migration. The engine `ThinkTime::sample` lenient clamp stays as a defense line.
- **byte-identical invariants:** valid scenarios still pass validation unchanged; old stored `profile_json` (no new field) deserializes to apply=true; closed-loop and no-think-open-loop run payloads gain no field; the run-level think message stays exactly `"think_time: min_ms <= max_ms <= 600000 (10분) 이어야 합니다"`.
- **think range rule:** `min_ms <= max_ms && max_ms <= 600_000`.
- **Korean copy:** all user-facing UI strings go through `ui/src/i18n/ko.ts` (ADR-0035). API error strings are inline Korean (matching the existing run-level message and `validate_parallel_branch_names` precedent).
- **Zod for the new bool:** `apply_scenario_think_time` is serialized server-side only when `false` (skip-when-true) and is never `null` → use `z.boolean().optional()`, NOT `.nullish()` (this is not the S-D server-null trap).
- **tdd-guard (UI tasks):** edit the `__tests__/*.test.ts(x)` file FIRST (creates the pending RED diff), then the `ui/src` production file — otherwise the first src edit is blocked.
- **Commit gates:** a cargo-affecting commit runs the full workspace gate (fmt/build/clippy -D warnings/nextest); run `cargo build --workspace && cargo nextest run && cargo clippy --workspace -- -D warnings` before committing Rust tasks. UI commits run `pnpm lint && pnpm test && pnpm build` (all three — `pnpm build`/`tsc -b` catches strict errors `pnpm test` misses). Commit with `run_in_background:false`, single call, no polling; no `| tail`/`| head` pipes; no `--no-verify`.
- **Sequence:** Task 1 (①, the pure security fix) lands first; Tasks 2–5 (②); Task 6 (③). Kept one slice — Tasks 1–3 share the recursive-walk shape.

---

## File map

- `crates/controller/src/api/scenarios.rs` — add `think_time_in_range` (pub(crate) predicate) + `validate_scenario_think_times` (pub(crate) walk); wire into `create`/`update` (Task 1).
- `crates/controller/src/api/runs.rs` — replace run-level think check with the shared predicate (Task 1); add `Profile` field usage (Task 2 struct is elsewhere); add strip helpers + `spawn_run` gate (Task 3).
- `crates/controller/src/api/test_runs.rs` — wire the walk (422) (Task 1).
- `crates/controller/src/store/runs.rs` — add `Profile.apply_scenario_think_time` field + serde helpers; fix all store-`Profile` literals (Task 2).
- `ui/src/scenario/model.ts` — add `scenarioHasThink` helper (Task 4).
- `ui/src/api/schemas.ts` — add `apply_scenario_think_time` to `ProfileSchema` (Task 4).
- `ui/src/components/profileForm.ts` — extend `ProfileFormInput` + conditional field in `buildProfile` (Task 4).
- `ui/src/components/RunDialog.tsx` — toggle state + wire to `buildProfile`/`LoadModelFields` (Task 5).
- `ui/src/components/LoadModelFields.tsx` — render the toggle (open arm) (Task 5) + observed-RPS anchor (open+fixed) (Task 6).
- `ui/src/i18n/ko.ts` — new copy for the toggle (Task 5) + anchor (Task 6).

---

## Task 1: ① Server-side think-time range validation

**Files:**
- Modify: `crates/controller/src/api/scenarios.rs` (add predicate + walk near `validate_parallel_branch_names`@19; call in `create`@74, `update`@140)
- Modify: `crates/controller/src/api/runs.rs` (replace run-level check @399-405; add import)
- Modify: `crates/controller/src/api/test_runs.rs` (call walk after `Scenario::from_yaml`@48; add import)
- Test: inline `#[cfg(test)]` in `scenarios.rs`; existing `runs.rs` think tests must stay green.

**Interfaces:**
- Produces: `pub(crate) fn think_time_in_range(tt: &handicap_engine::ThinkTime) -> bool`; `pub(crate) fn validate_scenario_think_times(steps: &[Step], default: &Option<handicap_engine::ThinkTime>) -> Result<(), String>` (both in `crate::api::scenarios`).

- [ ] **Step 1: Write the failing tests** (append to `scenarios.rs` `#[cfg(test)] mod tests`, or add one if absent)

```rust
#[cfg(test)]
mod think_validation_tests {
    use super::*;
    use handicap_engine::Scenario;

    fn scn(yaml: &str) -> Scenario {
        Scenario::from_yaml(yaml).expect("valid yaml")
    }

    // ULID chars exclude I/L/O/U — use "01HX00000000000000000000AA"-style valid ids.
    const HTTP: &str = r#"
version: 1
name: t
steps:
  - id: 01HX0000000000000000000AAA
    type: http
    name: s1
    request:
      method: GET
      url: http://x/
"#;

    #[test]
    fn rejects_default_min_gt_max() {
        let mut s = scn(HTTP);
        s.default_think_time = Some(handicap_engine::ThinkTime { min_ms: 5000, max_ms: 100 });
        assert!(validate_scenario_think_times(&s.steps, &s.default_think_time).is_err());
    }

    #[test]
    fn rejects_default_max_over_600000() {
        let mut s = scn(HTTP);
        s.default_think_time = Some(handicap_engine::ThinkTime { min_ms: 0, max_ms: 700_000 });
        assert!(validate_scenario_think_times(&s.steps, &s.default_think_time).is_err());
    }

    #[test]
    fn rejects_step_think_out_of_range_nested() {
        // step think inside a loop → walk must reach it and its name appears in the error.
        let yaml = r#"
version: 1
name: t
steps:
  - id: 01HX0000000000000000000P02
    type: loop
    name: L
    repeat: 2
    do:
      - id: 01HX0000000000000000000B01
        type: http
        name: innerstep
        request: { method: GET, url: http://x/ }
        think_time: { min_ms: 900000, max_ms: 900000 }
"#;
        let s = scn(yaml);
        let err = validate_scenario_think_times(&s.steps, &s.default_think_time).unwrap_err();
        assert!(err.contains("innerstep"), "error should name the step: {err}");
    }

    #[test]
    fn accepts_in_range_and_absent() {
        let s = scn(HTTP);
        assert!(validate_scenario_think_times(&s.steps, &s.default_think_time).is_ok()); // absent
        let mut s2 = scn(HTTP);
        s2.default_think_time = Some(handicap_engine::ThinkTime { min_ms: 100, max_ms: 500 });
        assert!(validate_scenario_think_times(&s2.steps, &s2.default_think_time).is_ok());
    }

    #[test]
    fn predicate_matches_run_level_condition() {
        // byte-identical to the pre-existing run-level rule (min>max || max>600000).
        assert!(think_time_in_range(&handicap_engine::ThinkTime { min_ms: 0, max_ms: 600_000 }));
        assert!(!think_time_in_range(&handicap_engine::ThinkTime { min_ms: 1, max_ms: 0 }));
        assert!(!think_time_in_range(&handicap_engine::ThinkTime { min_ms: 0, max_ms: 600_001 }));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p handicap-controller think_validation_tests --no-run` then `cargo test -p handicap-controller think_validation`
Expected: FAIL — `cannot find function validate_scenario_think_times` / `think_time_in_range`.

- [ ] **Step 3: Add the predicate + walk to `scenarios.rs`**

Change the import at the top of `scenarios.rs` (currently `use handicap_engine::{Scenario, Step};`) to include `ThinkTime`:

```rust
use handicap_engine::{Scenario, Step, ThinkTime};
```

Add, directly below `validate_parallel_branch_names` (after its closing `}` at ~line 52):

```rust
/// True when the think-time range is well-formed: `min <= max <= 600_000` (10 min).
/// Single source of truth shared by scenario/step validation (below) and the
/// run-level check (`api/runs.rs`), mirroring the UI Zod `ThinkTimeModel` rule.
pub(crate) fn think_time_in_range(tt: &ThinkTime) -> bool {
    tt.min_ms <= tt.max_ms && tt.max_ms <= 600_000
}

/// Validate the scenario's root `default_think_time` and every step's
/// `think_time` (recursing loop/if/parallel — the engine allows free nesting,
/// and a parallel branch step's *explicit* think still degrades if out of range,
/// so no step is exempt). Mirrors `validate_parallel_branch_names`' exhaustive walk.
pub(crate) fn validate_scenario_think_times(
    steps: &[Step],
    default: &Option<ThinkTime>,
) -> Result<(), String> {
    if let Some(tt) = default {
        if !think_time_in_range(tt) {
            return Err(
                "시나리오 기본 think time(default_think_time): min_ms <= max_ms <= 600000 (10분) 이어야 합니다"
                    .into(),
            );
        }
    }
    validate_steps_think(steps)
}

fn validate_steps_think(steps: &[Step]) -> Result<(), String> {
    for step in steps {
        match step {
            Step::Http(h) => {
                if let Some(tt) = &h.think_time {
                    if !think_time_in_range(tt) {
                        return Err(format!(
                            "스텝 \"{}\"의 think_time: min_ms <= max_ms <= 600000 (10분) 이어야 합니다",
                            h.name
                        ));
                    }
                }
            }
            Step::Loop(l) => validate_steps_think(&l.do_)?,
            Step::If(i) => {
                validate_steps_think(&i.then_)?;
                for e in &i.elif {
                    validate_steps_think(&e.then_)?;
                }
                validate_steps_think(&i.else_)?;
            }
            Step::Parallel(p) => {
                for b in &p.branches {
                    validate_steps_think(&b.steps)?;
                }
            }
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Wire into `create` and `update`**

In `scenarios.rs::create`, right after the existing `validate_parallel_branch_names(&parsed.steps).map_err(ApiError::BadRequest)?;` (~line 74):

```rust
    validate_scenario_think_times(&parsed.steps, &parsed.default_think_time)
        .map_err(ApiError::BadRequest)?;
```

Add the identical line after `validate_parallel_branch_names` in `update` (~line 140).

- [ ] **Step 5: Replace the run-level check with the shared predicate**

In `crates/controller/src/api/runs.rs`, add to the imports (near line 8-13):

```rust
use crate::api::scenarios::think_time_in_range;
```

Replace the existing block at ~line 399-405:

```rust
    if let Some(tt) = &profile.think_time {
        if tt.min_ms > tt.max_ms || tt.max_ms > 600_000 {
            return Err(ApiError::BadRequest(
                "think_time: min_ms <= max_ms <= 600000 (10분) 이어야 합니다".into(),
            ));
        }
    }
```

with (byte-identical message, condition delegated to the shared predicate):

```rust
    if let Some(tt) = &profile.think_time {
        if !think_time_in_range(tt) {
            return Err(ApiError::BadRequest(
                "think_time: min_ms <= max_ms <= 600000 (10분) 이어야 합니다".into(),
            ));
        }
    }
```

- [ ] **Step 6: Wire the walk into `test_runs.rs` (422)**

In `crates/controller/src/api/test_runs.rs`, add to the imports:

```rust
use crate::api::scenarios::validate_scenario_think_times;
```

Directly after the `Scenario::from_yaml` line (~48, before building `TraceOptions`):

```rust
    validate_scenario_think_times(&scenario.steps, &scenario.default_think_time)
        .map_err(ApiError::Unprocessable)?;
```

- [ ] **Step 7: Run tests to verify they pass + existing run-level tests stay green**

Run: `cargo test -p handicap-controller think_validation && cargo test -p handicap-controller validate_rejects_think_time`
Expected: PASS — new tests pass; `validate_rejects_think_time_min_gt_max` (`runs.rs:1652`) and `_max_over_600000` (`:1667`) still pass (proves the predicate swap is byte-identical).

- [ ] **Step 8: Full gate + commit**

Run: `cargo build --workspace && cargo nextest run -p handicap-controller && cargo clippy --workspace -- -D warnings`
Expected: PASS (0 warnings).

```bash
git add crates/controller/src/api/scenarios.rs crates/controller/src/api/runs.rs crates/controller/src/api/test_runs.rs
git commit -m "feat(controller): 서버측 think time 범위 검증 (§B21 ①)

공유 술어 think_time_in_range + 재귀 walk validate_scenario_think_times를
scenarios create/update(400)·test_runs(422)에 배선, run-level 검사를 공유
술어로 교체(byte-identical). 엔진/proto/migration 0-diff.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: ② `Profile.apply_scenario_think_time` field + literal churn

**Files:**
- Modify: `crates/controller/src/store/runs.rs` (add field to `Profile`@108 + two serde helper fns)
- Modify: ~64 store-`Profile` literal sites across `crates/controller/src` and `crates/controller/tests` (compiler-driven)
- Test: inline round-trip test in `store/runs.rs`.

**Interfaces:**
- Produces: `Profile.apply_scenario_think_time: bool` (serde default true, skip-when-true). Consumed by Task 3 (`spawn_run` strip) and the UI wire (Task 4 Zod).

**Note — literal churn (documented pattern):** adding a field to a struct that is built with explicit `Profile { ... }` literals (no `..Default::default()`) breaks every literal at compile time. This is the same class as the "AppState 필드 추가 = ~42 literal churn" / prost-exhaustive traps (root `CLAUDE.md`). ~64 store-`Profile` literals exist (38 in `api/runs.rs`, 7 in `store/runs.rs`, 5 in `grpc/coordinator.rs`, plus report/schedule/presets/schedules and 4 test files). Fix them compiler-driven with the byte-identical value `apply_scenario_think_time: true` (= apply = current behavior). Do NOT touch `pb::Profile` / `handicap_proto::v1::Profile` literals — that is the proto type (0-diff).

- [ ] **Step 1: Write the failing round-trip test** (append to `store/runs.rs` `#[cfg(test)]`)

```rust
#[test]
fn apply_scenario_think_time_defaults_true_and_skips_when_true() {
    // Old profile_json (no field) → deserializes to true (apply = byte-identical history).
    let old = r#"{"vus":1,"duration_seconds":10}"#;
    let p: Profile = serde_json::from_str(old).unwrap();
    assert!(p.apply_scenario_think_time, "absent field must default to apply=true");

    // true → omitted from JSON (byte-identical storage).
    let json = serde_json::to_string(&p).unwrap();
    assert!(
        !json.contains("apply_scenario_think_time"),
        "apply=true must be skipped in serialization: {json}"
    );

    // false → serialized, and round-trips.
    let mut p2 = p.clone();
    p2.apply_scenario_think_time = false;
    let json2 = serde_json::to_string(&p2).unwrap();
    assert!(json2.contains("\"apply_scenario_think_time\":false"));
    let back: Profile = serde_json::from_str(&json2).unwrap();
    assert!(!back.apply_scenario_think_time);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p handicap-controller apply_scenario_think_time_defaults_true`
Expected: FAIL — `no field apply_scenario_think_time on type Profile`.

- [ ] **Step 3: Add the field + serde helpers to `store/runs.rs`**

Inside `pub struct Profile { ... }` (after `worker_count`@149, before the closing `}`):

```rust
    /// open-loop에서 시나리오 think time(default_think_time + 스텝 think) 적용 여부.
    /// 기본 true(적용) = 기존 저장 run·closed-loop byte-identical. open-loop 신규 run은
    /// UI가 think 있을 때만 명시 전송. closed-loop에선 무시됨(strip은 open-loop 경로만,
    /// `spawn_run`). proto에는 없음(워커는 strip된 YAML을 받는다 — 0-diff).
    #[serde(
        default = "apply_scenario_think_default",
        skip_serializing_if = "apply_scenario_think_is_default"
    )]
    pub apply_scenario_think_time: bool,
```

Add module-level helper fns near the other `default_*` fns (e.g. below `default_http_timeout`):

```rust
fn apply_scenario_think_default() -> bool {
    true
}

fn apply_scenario_think_is_default(v: &bool) -> bool {
    *v // skip serializing when true (the default = apply)
}
```

- [ ] **Step 4: Fix all store-`Profile` literals (compiler-driven)**

Run: `cargo build --workspace --tests 2>&1 | grep "missing field"`
For every flagged store-`Profile { ... }` literal (NOT `pb::Profile`/`handicap_proto::v1::Profile`), add `apply_scenario_think_time: true,`. Repeat build until zero "missing field apply_scenario_think_time" errors. Value is always `true` (byte-identical apply).

- [ ] **Step 5: Run tests to verify green**

Run: `cargo build --workspace --tests && cargo test -p handicap-controller apply_scenario_think_time_defaults_true`
Expected: PASS; whole workspace + tests compile.

- [ ] **Step 6: Full gate + commit**

Run: `cargo build --workspace && cargo nextest run -p handicap-controller && cargo clippy --workspace -- -D warnings`
Expected: PASS (0 warnings). All pre-existing tests green (byte-identical — every literal got `true`).

```bash
git add crates/controller/src
git add crates/controller/tests
git commit -m "feat(controller): Profile.apply_scenario_think_time 필드 (§B21 ②, profile_json)

serde default true(apply)·skip-when-true → 기존 run·closed-loop byte-identical.
~64 store Profile 리터럴을 compiler-driven으로 true 배선(proto Profile 제외).
migration/proto/engine 0-diff.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: ② `spawn_run` think strip (worker YAML only)

**Files:**
- Modify: `crates/controller/src/api/runs.rs` (add strip helpers; use in `spawn_run`@~635, replacing `scenario.yaml.clone()`)
- Test: inline `#[cfg(test)]` in `runs.rs`.

**Interfaces:**
- Consumes: `Profile.apply_scenario_think_time` (Task 2), `Profile::is_open_loop()` (`store/runs.rs:166`), `handicap_engine::{Scenario, Step}` (already imported in `runs.rs`@4).
- Produces: `fn maybe_strip_think(yaml: &str, profile: &Profile) -> String` used at the `PendingAssignment` build.

- [ ] **Step 1: Write the failing tests** (append to `runs.rs` `#[cfg(test)]`)

```rust
#[cfg(test)]
mod strip_think_tests {
    use super::*;

    const YAML_THINK: &str = r#"
version: 1
name: t
default_think_time: { min_ms: 500, max_ms: 500 }
steps:
  - id: 01HX0000000000000000000AAA
    type: http
    name: s1
    request: { method: GET, url: http://x/ }
    think_time: { min_ms: 300, max_ms: 300 }
"#;

    const YAML_NOTHINK: &str = r#"
version: 1
name: t
steps:
  - id: 01HX0000000000000000000AAA
    type: http
    name: s1
    request: { method: GET, url: http://x/ }
"#;

    fn open_profile(apply: bool) -> Profile {
        // open-loop fixed: target_rps set (is_open_loop() == true).
        let mut p = Profile {
            duration_seconds: 10,
            target_rps: Some(100),
            max_in_flight: Some(50),
            apply_scenario_think_time: apply,
            ..closed_min()
        };
        p.vus = 0;
        p
    }

    // Minimal closed profile literal helper (fill remaining required fields).
    fn closed_min() -> Profile {
        Profile {
            vus: 1,
            ramp_up_seconds: 0,
            duration_seconds: 10,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            data_binding: None,
            data_bindings: vec![],
            criteria: None,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
            measure_phases: false,
            vu_stages: None,
            ramp_down: None,
            worker_count: None,
            apply_scenario_think_time: true,
        }
    }

    #[test]
    fn open_ignore_strips_think() {
        let out = maybe_strip_think(YAML_THINK, &open_profile(false));
        let sc = Scenario::from_yaml(&out).unwrap();
        assert!(sc.default_think_time.is_none(), "default_think_time removed");
        if let Step::Http(h) = &sc.steps[0] {
            assert!(h.think_time.is_none(), "step think removed");
        } else {
            panic!("expected http step");
        }
    }

    #[test]
    fn open_apply_keeps_original() {
        let out = maybe_strip_think(YAML_THINK, &open_profile(true));
        assert_eq!(out, YAML_THINK, "apply=true → original clone");
    }

    #[test]
    fn closed_never_strips() {
        let mut p = closed_min();
        p.apply_scenario_think_time = false; // closed + false: still no strip (open-loop only)
        let out = maybe_strip_think(YAML_THINK, &p);
        assert_eq!(out, YAML_THINK);
    }

    #[test]
    fn open_ignore_no_think_keeps_original() {
        // gate passes but nothing to strip → original (changed==false).
        let out = maybe_strip_think(YAML_NOTHINK, &open_profile(false));
        assert_eq!(out, YAML_NOTHINK);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p handicap-controller strip_think_tests --no-run`
Expected: FAIL — `cannot find function maybe_strip_think`.

- [ ] **Step 3: Add the strip helpers to `runs.rs`**

Add near `spawn_run` (module-level, `Scenario`/`Step` already imported @4):

```rust
/// open-loop에서 시나리오 think를 무시할 때만, 워커-전송 YAML에서 think를 제거한다.
/// 무-think·apply·closed는 원본 clone(파싱조차 안 함). 라운드트립 속성
/// (`from_yaml(to_yaml(s)) == s`, engine `scenario.rs` 테스트)이 안전 담보 — 워커가
/// 어차피 재파싱하므로 리포맷/주석 손실은 실행에 무의미. 저장 스냅샷은 원본을 쓴다.
fn maybe_strip_think(yaml: &str, profile: &Profile) -> String {
    if !(profile.is_open_loop() && !profile.apply_scenario_think_time) {
        return yaml.to_string();
    }
    let mut sc = match Scenario::from_yaml(yaml) {
        Ok(s) => s,
        // 파싱 실패는 생성 시 검증에서 이미 걸렸을 것 — 방어적으로 원본 유지.
        Err(_) => return yaml.to_string(),
    };
    if strip_scenario_think(&mut sc) {
        sc.to_yaml().unwrap_or_else(|_| yaml.to_string())
    } else {
        yaml.to_string()
    }
}

/// 루트 default + 모든 스텝 think를 None으로. 하나라도 바꿨으면 true.
fn strip_scenario_think(sc: &mut Scenario) -> bool {
    let mut changed = sc.default_think_time.take().is_some();
    if strip_steps_think(&mut sc.steps) {
        changed = true;
    }
    changed
}

fn strip_steps_think(steps: &mut [Step]) -> bool {
    let mut changed = false;
    for step in steps.iter_mut() {
        match step {
            Step::Http(h) => {
                if h.think_time.take().is_some() {
                    changed = true;
                }
            }
            Step::Loop(l) => {
                if strip_steps_think(&mut l.do_) {
                    changed = true;
                }
            }
            Step::If(i) => {
                if strip_steps_think(&mut i.then_) {
                    changed = true;
                }
                for e in &mut i.elif {
                    if strip_steps_think(&mut e.then_) {
                        changed = true;
                    }
                }
                if strip_steps_think(&mut i.else_) {
                    changed = true;
                }
            }
            Step::Parallel(p) => {
                for b in &mut p.branches {
                    if strip_steps_think(&mut b.steps) {
                        changed = true;
                    }
                }
            }
        }
    }
    changed
}
```

- [ ] **Step 4: Use it in `spawn_run`**

In `spawn_run`, just before the `PendingAssignment { ... }` literal (~line 634), compute the worker YAML:

```rust
    // open-loop think 무시(§B21 ②): 워커-전송 복사본에서만 think strip. 스냅샷(line 578,
    // runs::insert(&scenario.yaml))은 원본 유지 — 리포트 스텝 라벨·retry drift 정본.
    let worker_yaml = maybe_strip_think(&scenario.yaml, profile);
```

Change the assignment field (~line 635) from `scenario_yaml: scenario.yaml.clone(),` to:

```rust
        scenario_yaml: worker_yaml,
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cargo test -p handicap-controller strip_think_tests`
Expected: PASS.

- [ ] **Step 6: Full gate + commit**

Run: `cargo build --workspace && cargo nextest run -p handicap-controller && cargo clippy --workspace -- -D warnings`
Expected: PASS (0 warnings).

```bash
git add crates/controller/src/api/runs.rs
git commit -m "feat(controller): open-loop think 무시 시 워커-전송 YAML strip (§B21 ②)

is_open_loop() && !apply_scenario_think_time 게이트에서만 파싱→think None→
re-serialize. 스냅샷 원본 유지·changed=false면 원본. 엔진/proto/migration 0-diff.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: ② UI — `scenarioHasThink` helper + Zod field + `buildProfile` gating

**Files:**
- Modify: `ui/src/scenario/model.ts` (add `scenarioHasThink`)
- Modify: `ui/src/api/schemas.ts` (add field to `ProfileSchema`@70-101)
- Modify: `ui/src/components/profileForm.ts` (extend `ProfileFormInput`@119; conditional in `buildProfile`@130)
- Test: `ui/src/scenario/__tests__/model.test.ts` (or existing) + `ui/src/components/__tests__/profileForm.test.ts`

**Interfaces:**
- Produces: `scenarioHasThink(sc: Scenario): boolean`; `ProfileFormInput.applyScenarioThink?: boolean`, `ProfileFormInput.scenarioHasThink?: boolean`; `Profile.apply_scenario_think_time?: boolean` (Zod).
- Consumes: `flattenHttpSteps` (`model.ts:263`), `LoadModelState.loadModel` (`loadModel.ts:5`).

- [ ] **Step 1: Write the failing tests FIRST (tdd-guard)**

Append to `ui/src/scenario/__tests__/model.test.ts` (create if absent, in `__tests__/`):

```ts
import { describe, expect, it } from "vitest";
import { scenarioHasThink, newEmptyScenario } from "../model";
import type { Scenario } from "../model";

describe("scenarioHasThink", () => {
  it("false for a scenario with no think", () => {
    expect(scenarioHasThink(newEmptyScenario())).toBe(false);
  });
  it("true when default_think_time is set", () => {
    const s: Scenario = { ...newEmptyScenario(), default_think_time: { min_ms: 100, max_ms: 200 } };
    expect(scenarioHasThink(s)).toBe(true);
  });
  it("true when a nested step has think_time", () => {
    const s: Scenario = {
      ...newEmptyScenario(),
      steps: [
        {
          type: "loop",
          id: "01HX0000000000000000000P02",
          name: "L",
          repeat: 1,
          do: [
            {
              type: "http",
              id: "01HX0000000000000000000AAA",
              name: "s",
              request: { method: "GET", url: "http://x/", headers: {} },
              assert: [],
              extract: [],
              think_time: { min_ms: 1, max_ms: 2 },
            },
          ],
        },
      ],
    };
    expect(scenarioHasThink(s)).toBe(true);
  });
});
```

Append to `ui/src/components/__tests__/profileForm.test.ts`:

```ts
import { buildProfile } from "../profileForm";
// (reuse the file's existing imports for CriteriaState/EMPTY_CRITERIA/LoadModelState)

const openFixed = { loadModel: "open", rateMode: "fixed", targetRps: "100", maxInFlight: "50" } as const;

function base(loadState: any, extra: Record<string, unknown>) {
  return buildProfile({
    hasLoop: false,
    loopCap: 256,
    httpTimeout: 30,
    bindings: [],
    loadState: loadState as any,
    criteria: EMPTY_CRITERIA,
    measurePhases: false,
    ...extra,
  } as any);
}

describe("buildProfile apply_scenario_think_time", () => {
  it("includes false when open-loop + scenarioHasThink + toggle off", () => {
    const p = base(openFixed, { scenarioHasThink: true, applyScenarioThink: false });
    expect(p.apply_scenario_think_time).toBe(false);
  });
  it("includes true when open-loop + scenarioHasThink + toggle on", () => {
    const p = base(openFixed, { scenarioHasThink: true, applyScenarioThink: true });
    expect(p.apply_scenario_think_time).toBe(true);
  });
  it("omits when open-loop but scenario has NO think (byte-identical)", () => {
    const p = base(openFixed, { scenarioHasThink: false, applyScenarioThink: false });
    expect(p).not.toHaveProperty("apply_scenario_think_time");
  });
  it("omits for closed-loop (byte-identical)", () => {
    const closed = { loadModel: "closed", rateMode: "fixed", vus: "10", duration: 30 } as const;
    const p = base(closed, { scenarioHasThink: true, applyScenarioThink: true });
    expect(p).not.toHaveProperty("apply_scenario_think_time");
  });
});
```

(If `EMPTY_CRITERIA` is not already imported in `profileForm.test.ts`, add it to the existing import from `../profileForm`.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd ui && pnpm test model && pnpm test profileForm`
Expected: FAIL — `scenarioHasThink is not a function` / `apply_scenario_think_time` undefined.

- [ ] **Step 3: Add `scenarioHasThink` to `model.ts`**

Add after `flattenHttpSteps` (~line 275):

```ts
/** True when the scenario applies any think time — root default or any (nested)
 *  step's think_time. Drives the open-loop ignore toggle's visibility and the
 *  buildProfile field gate (spec §6.4). */
export function scenarioHasThink(sc: Scenario): boolean {
  if (sc.default_think_time != null) return true;
  return flattenHttpSteps(sc.steps).some((h) => h.think_time != null);
}
```

- [ ] **Step 4: Add the Zod field to `schemas.ts`**

In `ProfileSchema` (after `measure_phases`@100, before the closing `});`):

```ts
  // open-loop think 무시 토글(§B21 ②). 서버 store는 skip_serializing_if(=true일 때 생략)라
  // false일 때만 직렬화되고 null로는 오지 않는다 → .optional()(‼ .nullish() 아님).
  apply_scenario_think_time: z.boolean().optional(),
```

- [ ] **Step 5: Extend `ProfileFormInput` + `buildProfile`**

In `profileForm.ts`, add to `ProfileFormInput` (after `measurePhases`@127):

```ts
  /** open-loop 무시 토글 값(RunDialog 전용). 아래 scenarioHasThink와 함께 게이트. */
  applyScenarioThink?: boolean;
  /** 시나리오에 think가 있는가(RunDialog가 scenarioHasThink로 계산). 없으면 필드 생략. */
  scenarioHasThink?: boolean;
```

In `buildProfile`, add after the `...buildLoadProfile(i.loadState),` spread (inside the returned object, ~line 139):

```ts
    // open-loop이고 시나리오에 think가 있을 때만 필드를 실는다 → closed·no-think open은
    // byte-identical(필드 부재). 미전달(ScheduleForm)이면 scenarioHasThink=undefined→생략.
    ...(i.loadState.loadModel === "open" && i.scenarioHasThink
      ? { apply_scenario_think_time: !!i.applyScenarioThink }
      : {}),
```

- [ ] **Step 6: Run tests to verify pass**

Run: `cd ui && pnpm test model && pnpm test profileForm`
Expected: PASS.

- [ ] **Step 7: Gate + commit**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: PASS.

```bash
git add ui/src/scenario/model.ts ui/src/api/schemas.ts ui/src/components/profileForm.ts ui/src/scenario/__tests__/model.test.ts ui/src/components/__tests__/profileForm.test.ts
git commit -m "feat(ui): scenarioHasThink + apply_scenario_think_time Zod/buildProfile (§B21 ②)

open-loop && scenarioHasThink일 때만 필드 전송(closed·no-think open byte-identical).
Zod .optional()(skip-when-true·서버 null 없음).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: ② UI — open-loop ignore toggle (RunDialog + LoadModelFields)

**Files:**
- Modify: `ui/src/i18n/ko.ts` (`loadModel` block — 3 strings)
- Modify: `ui/src/components/LoadModelFields.tsx` (props@43-65; render in open arm before the `rateMode` branch@729)
- Modify: `ui/src/components/RunDialog.tsx` (state; wire to `buildProfile`@463 + `<LoadModelFields>`@616)
- Test: `ui/src/components/__tests__/LoadModelFields.test.tsx` (or `RunDialog.test.tsx`)

**Interfaces:**
- Consumes: `scenarioHasThink` (Task 4), `ProfileFormInput.applyScenarioThink/scenarioHasThink` (Task 4).
- Produces: `LoadModelFields` props `applyScenarioThink?: boolean`, `onApplyScenarioThinkChange?: (b: boolean) => void`, `scenarioHasThink?: boolean` (RunDialog-only optional-prop gate; ScheduleForm omits → not rendered).

- [ ] **Step 1: Write the failing test FIRST (tdd-guard)**

Add to `ui/src/components/__tests__/LoadModelFields.test.tsx` (follow the file's existing render helper; if none, render `<LoadModelFields {...requiredProps} />`). The toggle renders only when `onApplyScenarioThinkChange` is passed AND `scenarioHasThink` is true:

```tsx
it("shows the ignore-think toggle only for open-loop with think, default ignore", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <LoadModelFields {...openFixedProps()} scenarioHasThink onApplyScenarioThinkChange={onChange} applyScenarioThink={false} />,
  );
  const toggle = screen.getByRole("checkbox", { name: ko.loadModel.applyScenarioThinkLabel });
  expect(toggle).not.toBeChecked(); // default ignore
  expect(screen.getByText(ko.loadModel.applyScenarioThinkIgnoreNote)).toBeInTheDocument();

  // toggling calls the handler with true
  fireEvent.click(toggle);
  expect(onChange).toHaveBeenCalledWith(true);

  // still shown for open+curve (spec §6.1 — the toggle spans BOTH open sub-modes)
  rerender(
    <LoadModelFields {...openCurveProps()} scenarioHasThink onApplyScenarioThinkChange={onChange} applyScenarioThink={false} />,
  );
  expect(screen.getByRole("checkbox", { name: ko.loadModel.applyScenarioThinkLabel })).toBeInTheDocument();

  // hidden when scenario has no think
  rerender(<LoadModelFields {...openFixedProps()} scenarioHasThink={false} onApplyScenarioThinkChange={onChange} />);
  expect(screen.queryByRole("checkbox", { name: ko.loadModel.applyScenarioThinkLabel })).not.toBeInTheDocument();

  // hidden for closed-loop
  rerender(<LoadModelFields {...closedProps()} scenarioHasThink onApplyScenarioThinkChange={onChange} />);
  expect(screen.queryByRole("checkbox", { name: ko.loadModel.applyScenarioThinkLabel })).not.toBeInTheDocument();
});
```

(Define `openFixedProps()` (`loadModel:"open"`, `rateMode:"fixed"`), `openCurveProps()` (`loadModel:"open"`, `rateMode:"curve"`, with a non-empty `stages`), and `closedProps()` (`loadModel:"closed"`) from the file's existing prop factory, plus the required setters. Import `ko`, `vi`, `fireEvent`, `render`, `screen`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && pnpm test LoadModelFields`
Expected: FAIL — no checkbox with that accessible name.

- [ ] **Step 3: Add the 3 ko strings**

In `ui/src/i18n/ko.ts`, inside the `loadModel: { ... }` block (after `tileOpenDesc`@216 or near the open-loop copy):

```ts
    applyScenarioThinkLabel: "시나리오 think time 적용",
    applyScenarioThinkIgnoreNote:
      "think time 무시 중 (open-loop 기본) — 도착률로만 부하를 제어합니다. 적용하려면 켜세요.",
    applyScenarioThinkApplyNote:
      "think time이 슬롯을 점유합니다 — 아래 슬롯 사이징 도우미로 max_in_flight를 확인하세요.",
```

- [ ] **Step 4: Add the props + render to `LoadModelFields.tsx`**

Add to the `Props` type (near line 61, after `poolMode?`):

```tsx
  // open-loop think 무시 토글(RunDialog 전용 — ScheduleForm 미전달=미렌더). open 전체(fixed+curve).
  applyScenarioThink?: boolean;
  onApplyScenarioThinkChange?: (b: boolean) => void;
  scenarioHasThink?: boolean;
```

Add them to the destructured params (near line 101, after `poolMode`):

```tsx
  applyScenarioThink,
  onApplyScenarioThinkChange,
  scenarioHasThink,
```

Render the toggle inside the open-loop block, BEFORE the `{rateMode === "fixed" ? (...) : (...)}` branch (~line 729) so it appears for both fixed and curve. Gate on `onApplyScenarioThinkChange && scenarioHasThink`:

```tsx
          {onApplyScenarioThinkChange && scenarioHasThink && (
            <div className="mb-3 rounded-md border border-slate-200 bg-slate-50 p-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!applyScenarioThink}
                  onChange={(e) => onApplyScenarioThinkChange(e.target.checked)}
                />
                {ko.loadModel.applyScenarioThinkLabel}
              </label>
              <p className="mt-1 text-xs text-slate-500">
                {applyScenarioThink
                  ? ko.loadModel.applyScenarioThinkApplyNote
                  : ko.loadModel.applyScenarioThinkIgnoreNote}
              </p>
            </div>
          )}
```

- [ ] **Step 5: Wire state in `RunDialog.tsx`**

Add the import (near the model imports):

```tsx
import { scenarioHasThink } from "../scenario/model";
```

Add state (near the other `useState` declarations, reseed-by-key so remount re-seeds; default false = ignore):

```tsx
  const [applyScenarioThink, setApplyScenarioThink] = useState(false);
```

Compute whether this scenario has think (near `loadState`@367):

```tsx
  const scHasThink = scenario ? scenarioHasThink(scenario) : false;
```

Pass to `buildProfile` (in `buildProfileShared({ ... })`@463, add two fields):

```tsx
      applyScenarioThink,
      scenarioHasThink: scHasThink,
```

Pass to `<LoadModelFields>` (in the JSX@616, add three props — e.g. after `poolMode={...}`@646):

```tsx
          applyScenarioThink={applyScenarioThink}
          onApplyScenarioThinkChange={setApplyScenarioThink}
          scenarioHasThink={scHasThink}
```

- [ ] **Step 6: Run tests to verify pass**

Run: `cd ui && pnpm test LoadModelFields`
Expected: PASS.

- [ ] **Step 7: Gate + commit**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: PASS.

```bash
git add ui/src/i18n/ko.ts ui/src/components/LoadModelFields.tsx ui/src/components/RunDialog.tsx ui/src/components/__tests__/LoadModelFields.test.tsx
git commit -m "feat(ui): open-loop 시나리오 think time 무시 토글 (§B21 ②)

RunDialog open-loop(fixed+curve)에 think 있을 때만 토글 노출·기본 무시.
무시/적용 안내 문구. ScheduleForm 미전달=미렌더(byte-identical).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: ③ observed-RPS anchor (open+fixed)

**Files:**
- Modify: `ui/src/i18n/ko.ts` (`loadModel` block — 2 strings)
- Modify: `ui/src/components/LoadModelFields.tsx` (open+fixed arm, after the targetRps `Field`@748, near `SlotSizingHelper`@773)
- Test: `ui/src/components/__tests__/LoadModelFields.test.tsx`

**Interfaces:**
- Consumes: existing `sizePresetAnchor?: ClosedRunAnchor | null` prop (`LoadModelFields.tsx:49`, already passed by RunDialog@639); `setTargetRps` (existing prop).
- Produces: (UI only) the "이 값으로" affordance.

- [ ] **Step 1: Write the failing test FIRST (tdd-guard)**

Add to `LoadModelFields.test.tsx`:

```tsx
it("offers the observed-RPS anchor in open+fixed and fills target_rps on click", () => {
  const setTargetRps = vi.fn();
  render(
    <LoadModelFields
      {...openFixedProps()}
      setTargetRps={setTargetRps}
      sizePresetAnchor={{ vus: 50, rps: 180.4, durationSeconds: 60 }}
    />,
  );
  expect(screen.getByText(ko.loadModel.observedRpsAnchor(180))).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: ko.loadModel.observedRpsApply }));
  expect(setTargetRps).toHaveBeenCalledWith("180");
});

it("hides the anchor when there is no prior run", () => {
  render(<LoadModelFields {...openFixedProps()} sizePresetAnchor={null} />);
  expect(screen.queryByRole("button", { name: ko.loadModel.observedRpsApply })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && pnpm test LoadModelFields`
Expected: FAIL — no anchor text/button.

- [ ] **Step 3: Add the 2 ko strings**

In `ko.ts` `loadModel` block (near the size-preset strings):

```ts
    observedRpsAnchor: (n: number) => `직전 실행 관측 ≈ ${n} RPS`,
    observedRpsApply: "이 값으로",
```

- [ ] **Step 4: Render the anchor in the open+fixed arm**

In `LoadModelFields.tsx`, inside the `rateMode === "fixed"` branch, after the targetRps/duration grid (after the `reqConversion` hint block@769-772, before/around the `SlotSizingHelper`@773):

```tsx
              {sizePresetAnchor && sizePresetAnchor.rps > 0 && (
                <p className="mb-3 -mt-1 text-xs text-slate-500">
                  {ko.loadModel.observedRpsAnchor(Math.round(sizePresetAnchor.rps))}{" "}
                  <button
                    type="button"
                    onClick={() => setTargetRps(String(Math.round(sizePresetAnchor.rps)))}
                    className="text-accent-600 hover:underline"
                  >
                    {ko.loadModel.observedRpsApply}
                  </button>
                </p>
              )}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd ui && pnpm test LoadModelFields`
Expected: PASS.

- [ ] **Step 6: Gate + commit**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: PASS.

```bash
git add ui/src/i18n/ko.ts ui/src/components/LoadModelFields.tsx ui/src/components/__tests__/LoadModelFields.test.tsx
git commit -m "feat(ui): open-loop 관측 RPS 앵커 — target_rps 원클릭 (§B21 ③)

직전 closed run 관측 RPS(sizePresetAnchor.rps)로 '이 값으로' 채우기. open+fixed만.
기존 prop 재사용(새 훅 없음).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final review + live verification (after all tasks)

- [ ] **`handicap-reviewer` (Opus)** — whole-branch review (crosscutting, repo traps, UI Zod ↔ store wire). BASE = commit just before Task 1 (docs commit).
- [ ] **`security-reviewer` (Opus)** — REQUIRED (diff touches `test_runs.rs` + scenario strip + request-execution path). Confirm via `finish-slice §0` grep; the grep governs, not this prediction.
- [ ] **Live verification** (`/live-verify`, REQUIRED — run-create/engine path changed):
  - **①**: `curl POST /api/scenarios` with `default_think_time:{min_ms:5000,max_ms:100}` → **400**; `max_ms:700000` → **400**; valid → **201**. `POST /api/test-runs` bad-think → **422**.
  - **②**: think-heavy scenario (`default_think_time:{500,500}`) open-loop `target_rps` run — toggle default **ignore** → report `summary.rps` near target (no drops); toggle **apply** run → RPS drops / `dropped` rises (proves strip). closed-loop same scenario → think applies (RPS ≈ VUs/think).
  - **③**: after a prior closed run, open-loop RunDialog `이 값으로` → `target_rps` filled with observed RPS (Playwright).

---

## Self-Review (writer's checklist — completed)

1. **Spec coverage:** ① §5 → Task 1. ② field §6.2 → Task 2; strip §6.3 → Task 3; UI model/Zod/buildProfile §6.4 → Task 4; toggle §6.1/§6.4 → Task 5. ③ §7 → Task 6. Non-goals (tiles, ScheduleForm, think-scaling, engine/proto/migration) — not implemented (correct). Live verify §13 + reviewers §13.4 → final section. No gaps.
2. **Placeholder scan:** every code step has full code; no TBD/"handle errors"/"similar to". Literal churn (Task 2) is compiler-driven with the exact value `true`.
3. **Type consistency:** `apply_scenario_think_time` (Rust field), `apply_scenario_think_time` (Zod/wire), `applyScenarioThink`/`scenarioHasThink` (UI camelCase props) — consistent across Tasks 2/4/5. `think_time_in_range`/`validate_scenario_think_times` names match between Task 1 producer and runs/test_runs consumers. `maybe_strip_think` consumes Task 2's field. `sizePresetAnchor.rps` (Task 6) matches the existing `ClosedRunAnchor` type.

<!-- REVIEW-GATE: APPROVED -->

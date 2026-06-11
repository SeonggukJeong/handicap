# Roadmap User-Value Review for Claude

Date: 2026-06-02

Audience: Claude, who owns the current implementation and roadmap flow.

Source reviewed: `docs/roadmap.md`

## TL;DR

The roadmap is technically coherent and correctly reflects the current implementation state. Most foundational features are already done: MVP1, loop, loop breakdown, data-driven, conditional branching, run presets/retry, environments, scenario test-run, and multi-worker fan-out.

From a real user's perspective, the next high-value product move is not another execution primitive. It is **A4: LoadRunner-grade reporting**, but sliced narrowly:

1. **SLO / pass-fail criteria**
2. **Run comparison / baseline regression**
3. **Actionable report summary**

These should come after the currently planned `unique` binding work and the cleanup items identified in the prior review: UI lint gate, dispatch fail-fast, subprocess fixture cleanup, and shutdown log hygiene.

In short:

```text
finish unique-binding
→ fix cleanup/operational correctness
→ A4a SLO pass-fail
→ A4b run comparison
→ A4c actionable report summary
→ then consider load-model expansion
```

## Current Roadmap Assessment

`docs/roadmap.md` is useful as a single entry point. It has a good split between:

- completed slices,
- candidate feature slices,
- intentionally deferred follow-ups,
- tech debt tracked elsewhere.

The document is especially strong in preserving architectural context. It records why multi-worker fan-out is planned fan-out rather than reactive HPA, why `unique` binding was deferred, and which ADR/spec/plan documents matter.

The main gap is that the roadmap says "candidate list, not priority list." That is fine for engineering planning, but it does not answer the product question: **what gives the user the most benefit next?**

This review fills that gap.

## User-Value Ranking

### 1. A4: LoadRunner-grade report depth

Roadmap location: `docs/roadmap.md`, section `A4. LoadRunner급 리포트 깊이`.

This is the highest user-value area now.

Reason: the product already knows how to generate load, distribute workers, bind data, branch, loop, retry runs, and show reports. The next user pain is interpretation:

- Did this run pass?
- Did the new build regress?
- Which step got worse?
- Is the failure due to errors, latency, or insufficient throughput?
- Can I show this result to another engineer without explaining the raw charts?

The current report answers "what happened." A4 should answer "is this acceptable, and what changed?"

Recommended slice split:

#### A4a. SLO / Pass-Fail Criteria

Add run-level and optional step-level thresholds.

Examples:

- `p95_ms <= 500`
- `p99_ms <= 1000`
- `error_rate <= 1%`
- `5xx_count == 0`
- `min_rps >= 100`

Output:

- run verdict: `passed | failed`
- failed criterion list
- criterion values vs thresholds
- UI badge in run list and report page

Why first:

- It turns the tool from "chart viewer" into "release gate."
- It is easy for internal QA users to understand.
- It pairs naturally with retry/presets already completed.
- It requires little engine change because report data already contains count, errors, RPS, and percentiles.

Implementation shape:

- Extend `Profile` or add a separate run config field for `criteria`.
- Persist criteria snapshot with the run.
- Evaluate in `report::build_report` or a nearby evaluator after summary/step aggregation.
- Return verdict in `ReportJson`.
- Add UI display to report summary and run list.

Important design choice:

- Store the criteria snapshot per run. Do not read a mutable preset's current criteria when rendering old reports.

#### A4b. Run Comparison / Baseline Regression

Add a way to compare one run against another run of the same scenario.

Minimum useful version:

- choose baseline run,
- compare current vs baseline:
  - total count,
  - error rate,
  - RPS,
  - p50/p95/p99,
  - per-step p95/p99,
  - status distribution deltas.

Why second:

- Users often care less about absolute latency than "did this release get worse?"
- It makes performance regression visible.
- It reuses immutable `scenario_yaml`, `profile`, `env`, and report rows already stored.

Recommended initial UX:

- On report page: `Compare to...` selector listing prior completed runs for the same scenario.
- Show summary deltas with direction and percentage.
- Highlight regressions over configurable thresholds later.

Avoid initially:

- Cross-scenario comparison.
- Statistical significance claims.
- Complex chart overlays for every metric.

#### A4c. Actionable Report Summary

Add a top report panel that says what needs attention.

Examples:

- "Step `login` accounts for 82% of errors."
- "p95 regressed by 34% vs baseline."
- "5xx responses appeared in the final 20 seconds."
- "No requests recorded for step `profile`."
- "Run passed all criteria."

Why third:

- It reduces chart-reading time.
- It helps non-expert QA users.
- It makes reports shareable.

Implementation shape:

- Pure backend or frontend derived facts from `ReportJson`.
- Prefer backend if the same summary will later be exported.
- Keep first version deterministic and rule-based.

### 2. Cleanup / Operational Correctness

These are not flashy user features, but they should happen before A4 because they protect trust in the tool.

From prior review and Claude's assessment:

1. UI lint gate is a latent CI red.
2. `POST /api/runs` returns `201 Created` even if dispatch fails.
3. subprocess dispatcher test uses `/bin/sh` in a way that emits errors while passing.
4. normal worker shutdown produces scary transport-error logs.

User value:

- A user should not get a successful run creation when workers could not start.
- A report should not be missing because the worker path failed silently.
- Logs should distinguish expected shutdown from real transport failure.

Recommended grouping:

- Fix UI lint and add `pnpm lint` to the documented UI gate.
- Add dispatch fail-fast behavior with persisted `runs.message`.
- Add fake dispatcher/subprocess failure tests.
- Clean up subprocess test fixture.
- Treat expected stream close as normal after terminal status.

### 3. `unique` Binding

Roadmap location: `B1` and `B2''`.

`unique` binding is a good next engineering task if it is already in progress. It completes the data-driven story, especially for test data that must not be reused across VUs.

User value:

- Avoid duplicate accounts/orders/tokens across VUs.
- Make data-driven tests safer against stateful systems.
- Reduce manual dataset partitioning.

Why it is not ranked above A4:

- It benefits users with specific dataset constraints.
- A4 benefits every user who runs any test.

Recommended stance:

- Finish `unique` because context and plan already exist.
- Do not let it expand into generic data orchestration.
- After completion, move to cleanup and A4.

### 4. Load Model Expansion

Roadmap location: partly implied by A4 and deferred follow-ups; not currently a named top-level slice.

Current engine is closed-loop VUs with fixed 30s timeout. This is acceptable for internal QA, but eventually users will ask for:

- target RPS,
- ramp stages,
- per-step timeout,
- think time,
- open-loop arrival rate,
- max in-flight cap.

User value:

- Better matches real performance test plans.
- Makes tests reproducible by target throughput rather than only VU count.

Why after A4:

- Better load generation is valuable, but users still need to judge results.
- SLO and comparison make every existing run more useful immediately.
- Open-loop scheduling has higher engine complexity and measurement risk.

Recommended split:

1. `http_timeout_seconds`
2. `think_time_ms` or per-step delay
3. staged ramp profile
4. target RPS / open-loop mode

Do not combine open-loop mode with A4. It deserves a separate spec.

### 5. Parallel Node

Roadmap location: `A2. Parallel 노드`.

This is technically interesting but lower user value than reporting.

Why:

- It adds scenario expressiveness.
- But most REST QA workflows can continue with sequential, loop, if, data, env, and retry.
- It complicates cookie jar sharing, per-VU concurrency, cancellation, metric attribution, and UI authoring.

Recommended stance:

- Keep it on the roadmap.
- Do it only after reporting and load model needs are addressed, or when a real scenario requires same-VU concurrent branches.

### 6. WebSocket, RBAC, Live Dashboard, Reactive HPA

These should remain deferred.

WebSocket:

- Valuable only if target systems need it.
- It changes protocol modeling and reporting shape.

RBAC:

- Important when multi-team use starts.
- Not the next value step for single-tenant internal QA.

Live dashboard:

- ADR-0009 already excludes it.
- Revisit only if users need mid-run intervention, not just final reports.

Reactive HPA:

- Not a natural fit for deterministic load generation.
- Planned fan-out is the right default.

## Recommended Roadmap Adjustment

Add a small "User-value priority" section near the top of `docs/roadmap.md`.

Suggested text:

```markdown
## 사용자 가치 기준 추천 순서

1. 진행 중인 `unique` binding 완료.
2. 운영 신뢰성 정리: UI lint gate, dispatch fail-fast, subprocess fixture, shutdown 로그.
3. A4a SLO / pass-fail criteria.
4. A4b run comparison / baseline regression.
5. A4c actionable report summary.
6. Load model expansion: timeout, think time, staged ramp, target RPS/open-loop.
7. Parallel node and other protocol/control-flow extensions.
```

This preserves the existing roadmap as a menu while giving future sessions a clear default path.

## Proposed A4 Spec Boundaries

When writing the A4 spec, avoid "LoadRunner-grade" as one giant slice. Split it.

### A4a Spec Scope

In:

- criteria model,
- run criteria snapshot,
- report verdict,
- failed criteria list,
- UI report summary badge,
- run list verdict display.

Out:

- run comparison,
- CSV/Excel export,
- transaction timing breakdown,
- waterfall,
- DNS/TCP/TLS/TTFB,
- live dashboard,
- scheduled runs.

### A4b Spec Scope

In:

- compare current run to one baseline run,
- same-scenario only,
- summary delta,
- per-step delta,
- error-rate delta,
- p95/p99 delta,
- report UI comparison panel.

Out:

- multi-baseline comparison,
- cross-scenario comparison,
- statistical confidence,
- automatic baseline selection beyond "latest successful" or explicit user choice.

### A4c Spec Scope

In:

- deterministic derived insights,
- slowest step,
- most error-prone step,
- largest regression if baseline selected,
- missing/no-request steps,
- SLO failure summary.

Out:

- AI-written narrative,
- root-cause claims,
- APM integration.

## Acceptance Criteria for the Next Feature Track

For A4a:

- A run can be created with criteria.
- Criteria are stored as an immutable run snapshot.
- The report returns a verdict and failed criteria.
- The report UI clearly shows pass/fail.
- The run list shows pass/fail for completed runs.
- Tests cover pass, fail, and missing/empty criteria.

For A4b:

- A report can compare against another completed run from the same scenario.
- Summary and per-step deltas are returned or derived deterministically.
- The UI prevents or rejects cross-scenario comparison.
- Tests cover improved, regressed, and missing-step cases.

For A4c:

- The report shows at least three deterministic insights.
- No insight claims causality beyond available metrics.
- Tests cover no-data, all-pass, and error-heavy runs.

## Final Recommendation

The roadmap should keep its current menu structure, but the practical next product direction should be:

1. Complete `unique` binding if already in flight.
2. Fix operational trust issues from the prior review.
3. Start A4 with SLO/pass-fail, then baseline comparison.

That sequence gives users the most immediate value because it turns Handicap from "a tool that can run load" into "a tool that tells me whether this build is acceptable."

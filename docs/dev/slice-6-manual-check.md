# Slice 6 manual check

End-to-end manual verification of the kind-based deployment slice. Tick each
checkbox as you go. If any item fails, treat the slice as incomplete and file a
follow-up before merging.

## Setup

```bash
just kind-down 2>/dev/null || true   # clean slate
just deploy-kind
kubectl -n handicap port-forward svc/handicap-handicap-controller 8080:8080 &
kubectl apply -f deploy/kind/wiremock.yaml
kubectl -n handicap-test port-forward svc/wiremock 9001:8080 &
```

> Service name: the Helm release name is `handicap` and the chart name is
> `handicap`, so the controller Service expands to
> `handicap-handicap-controller` (`{Release.Name}-{Chart.Name}-controller`).
> Plain `handicap-controller` will 404 in `port-forward`.

## §4.1 — user flows

- [ ] Open http://127.0.0.1:8080/ — UI loads, CSP no errors in console.
- [ ] Drag an HTTP node, fill URL `${BASE_URL}/login` POST, save scenario.
- [ ] Open the YAML tab — the saved YAML matches the canvas.
- [ ] Open RunDialog. Enter VUs=100, ramp=10, duration=30, env `BASE_URL=http://wiremock.handicap-test.svc.cluster.local:8080`.
- [ ] Watch progress refresh every 1 s.
- [ ] On completion, the report renders: summary cards, 3 line charts, status distribution, per-step table.
- [ ] Re-run at VUs=1000 / ramp=30 / duration=300 — new run page is separate.
- [ ] Token-auth: 2-step scenario with `extract: from: body` → `Authorization: Bearer {{token}}`.
- [ ] Session-auth: 2-step scenario with `cookie_jar: auto`, login then GET that requires cookie. Verify in wiremock recorded requests: each VU has a distinct cookie.

## §4.2 — technical / ops

- [ ] One controller pod + one (transient) worker Job per run.
- [ ] Delete the controller pod (`kubectl -n handicap delete pod -l app.kubernetes.io/component=controller`) — when it comes back, scenarios and past runs are still there (PVC); the in-progress run is marked `failed` with `message = "controller restarted while run was in progress"`.
- [ ] Kill the worker pod mid-run (`kubectl -n handicap delete job -l handicap.io/run-id=<id>`) — controller marks run `failed`; the Job is gone.
- [ ] Block the controller→worker network briefly (impractical on kind without Cilium; document the test plan but skip in MVP).

## §4.3 — performance

Follow `docs/dev/perf-bench.md`. Targets:
- [ ] ≥ 5,000 RPS sustained at VUs=500, 1 KB JSON GET (host process, single worker).
- [ ] ≤ 5 % throughput delta with metrics enabled (we don't have a "metrics off" mode — note as deferred to a follow-up if formal measurement needed).
- [ ] Controller RSS ≤ 256 MB idle, ≤ 512 MB during run.
- [ ] Report page initial render ≤ 2 s for 10k-window run (synthesize by running for ~3 h at low VUs, then open report).

Record the numbers in `docs/dev/perf-bench.md`.

## Teardown

```bash
kill %1 %2 2>/dev/null || true
just kind-down
```

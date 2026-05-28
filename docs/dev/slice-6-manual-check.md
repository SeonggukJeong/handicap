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

## 사전 — wiremock stub 등록

`§4.1`의 시나리오들(`/login`, `/me`, `/profile`)이 의존하는 mock 응답은 wiremock
admin API(`/__admin/mappings`)로 미리 등록한다. 빠뜨리면 worker가 매칭 안 되는
요청에 대해 wiremock의 기본 404를 받고, RPS가 비정상적으로 높으면서 status가
전부 비정상으로 찍힌다(Slice 4 함정과 동일 클래스).

**두 개의 주소가 같은 wiremock pod를 가리킨다는 점에 주의:**
- **stub 등록(이 문서의 curl)** 은 호스트에서 port-forward 한 `localhost:9001`로 보낸다.
- **worker(in-cluster Job)** 는 RunDialog의 Env `BASE_URL`로 들어간 클러스터 DNS
  `http://wiremock.handicap-test.svc.cluster.local:8080`로 도달한다.

먼저 admin API가 살아있는지 확인한다. **단, `/__admin/health`가 OK라고 해서
방금 띄운 port-forward가 맞는 인스턴스에 붙었다는 뜻은 아니다** — 이전 세션의
stale forward나 9001을 선점한 다른 프로세스가 health에 응답할 수 있다
(`bind: address already in use`로 새 forward는 죽고 옛 forward가 답하는 케이스).
그래서 health 단독으로 끝내지 말고, **stale forward를 먼저 정리 → 새 forward가
정말 떴는지 확인 → mappings를 실제로 read/write 해보는 round-trip**까지 한다:

```bash
# 1. 9001을 선점한 stale forward/프로세스가 있으면 죽인다.
lsof -ti tcp:9001 | xargs -r kill 2>/dev/null || true

# 2. forward를 띄우고, "Forwarding from 127.0.0.1:9001" 줄이 실제로 찍히는지 확인한다.
#    (bind 실패 시 이 줄 대신 에러가 나고 곧 종료 → 그 상태로 진행하면 안 됨)
kubectl -n handicap-test port-forward svc/wiremock 9001:8080 &
sleep 1

# 3. health 가 아니라, 빈 mappings 목록을 실제로 읽어 round-trip 을 증명한다.
#    (health 는 "누군가 응답함"만, 아래는 "내가 쓰고 읽을 admin API에 닿음"을 증명)
curl -sf http://localhost:9001/__admin/mappings >/dev/null \
  && echo "wiremock admin reachable on 9001" \
  || echo "FAIL: 9001 이 wiremock admin 에 안 닿음 — forward 다시 확인"
```

> 왜 health 만으론 부족한가: `curl -sf … /__admin/health` 는 9001에서 **무엇이든**
> 200을 주면 OK를 찍는다. 정작 검증하고 싶은 건 "stub을 등록하면 worker가 그걸
> 본다"인데, stale/엉뚱한 forward도 health엔 답하므로 거짓 안심을 준다. 등록 직후
> `curl -s …/__admin/mappings` 로 방금 넣은 stub이 **실제로 보이는지** 확인하는 게
> 유일하게 믿을 수 있는 신호다 (아래 "등록 확인 / 디버깅" 참고).

### 토큰 인증 (§4.1 token-auth 체크박스)

```bash
# /login — POST, 200 + access_token (body extract 대상)
curl -s -X POST http://localhost:9001/__admin/mappings \
  -H 'Content-Type: application/json' \
  -d '{
    "request":  { "method": "POST", "url": "/login" },
    "response": {
      "status": 200,
      "headers": { "Content-Type": "application/json" },
      "jsonBody": { "access_token": "T0K3N" }
    }
  }'

# /me — GET, Bearer 검사 + 200
curl -s -X POST http://localhost:9001/__admin/mappings \
  -H 'Content-Type: application/json' \
  -d '{
    "request": {
      "method": "GET",
      "url": "/me",
      "headers": { "Authorization": { "equalTo": "Bearer T0K3N" } }
    },
    "response": {
      "status": 200,
      "headers": { "Content-Type": "application/json" },
      "jsonBody": { "ok": true }
    }
  }'
```

위 `/login` stub은 §4.1 첫 체크박스(단일 `${BASE_URL}/login` POST scenario)도
그대로 만족시킨다.

### 세션(쿠키) 인증 (§4.1 session-auth 체크박스) — token 마치고 reset 후 등록

`/login` path가 token 인증과 충돌하므로 reset 후 다시 등록한다.

```bash
curl -s -X DELETE http://localhost:9001/__admin/mappings

# /login — Set-Cookie 반환 (cookie_jar: auto 가 VU별로 보관)
curl -s -X POST http://localhost:9001/__admin/mappings \
  -H 'Content-Type: application/json' \
  -d '{
    "request":  { "method": "POST", "url": "/login" },
    "response": {
      "status": 200,
      "headers": { "Set-Cookie": "session=S3SSION; Path=/; HttpOnly" }
    }
  }'

# /profile — Cookie 검사
curl -s -X POST http://localhost:9001/__admin/mappings \
  -H 'Content-Type: application/json' \
  -d '{
    "request": {
      "method": "GET",
      "url": "/profile",
      "cookies": { "session": { "equalTo": "S3SSION" } }
    },
    "response": { "status": 200, "jsonBody": { "ok": true } }
  }'
```

### 등록 확인 / 디버깅

```bash
curl -s http://localhost:9001/__admin/mappings   # 등록된 stub 목록
curl -s http://localhost:9001/__admin/requests   # 실제 들어온 요청 로그 (VU별 Cookie 확인 등)
curl -s -X DELETE http://localhost:9001/__admin/mappings   # 전부 리셋

# stub 단독 sanity check (run 돌리기 전에)
curl -i -X POST http://localhost:9001/login \
  -H 'Content-Type: application/json' -d '{"u":"a","p":"b"}'
# → 200 + {"access_token":"T0K3N"} 이 나와야 정상
```

> §4.3 성능 측정의 `/ping`·`/big` stub은 `scripts/bench-throughput.sh`가
> 실행 시 자동 등록하므로 여기서 따로 등록할 필요 없다.

## §4.1 — user flows

- [ ] Open http://127.0.0.1:8080/ — UI loads, CSP no errors in console.
- [ ] Register the wiremock stubs first (see "사전 — wiremock stub 등록" above).
- [ ] Drag an HTTP node, fill URL `${BASE_URL}/login` POST, save scenario.
- [ ] Open the YAML tab — the saved YAML matches the canvas.
- [ ] Open RunDialog. Enter VUs=100, ramp=10, duration=30, env `BASE_URL=http://wiremock.handicap-test.svc.cluster.local:8080`.
      - ⚠️ This value is consumed by the **worker**, which runs as an **in-cluster Job pod** in this slice — so it must be the cluster DNS name (Service port `:8080`), **not** the host's `localhost:9001` port-forward (that's only for the stub-registration curls; see the two-address table under "사전 — wiremock stub 등록"). `localhost` from inside the pod is the pod's own loopback. (In local-dev subprocess mode the worker runs on the host, so there `localhost:9001` would be correct — that's the source of confusion.)
- [ ] Watch progress refresh every 1 s.
- [ ] On completion, the report renders: summary cards, 3 line charts, status distribution, per-step table.
- [ ] Re-run at VUs=1000 / ramp=30 / duration=300 — new run page is separate.
- [ ] Token-auth: 2-step scenario with `extract: from: body` → `Authorization: Bearer {{token}}` (stubs: "토큰 인증" above).
- [ ] Session-auth: 2-step scenario with `cookie_jar: auto`, login then GET that requires cookie (reset + re-register stubs: "세션(쿠키) 인증" above). Verify in wiremock recorded requests: each VU has a distinct cookie.

## §4.2 — technical / ops

- [ ] One controller pod + one (transient) worker Job per run.
- [ ] Delete the controller pod (`kubectl -n handicap delete pod -l app.kubernetes.io/component=controller`) — when it comes back, scenarios and past runs are still there (PVC); the in-progress run is marked `failed` with `message = "controller restarted while run was in progress"`.
- [ ] **After any pod recreation (the step above, a redeploy, or an eviction), restart the port-forwards** — `kubectl port-forward` dies with the old pod, so the UI/wiremock "suddenly" go down even though the new pod is `Running`. Re-run: `kubectl -n handicap port-forward svc/handicap-handicap-controller 8080:8080 &` (and the wiremock forward if you touched it).
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

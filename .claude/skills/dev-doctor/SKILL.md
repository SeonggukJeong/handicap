---
name: dev-doctor
description: Diagnose and correctly start the handicap local dev stack (controller + worker + UI). Checks the documented port/process footguns (5173/8080/9001 conflicts across worktrees, stale target/* binaries, --bin controller ambiguity, port-forward death on pod recreate) before starting. Use when local dev "isn't picking up changes", the UI shows stale behavior, a run hangs in 'running' with 0 requests, or before a manual check.
---

# dev-doctor — handicap 로컬 dev 위생

이 repo의 로컬 dev는 포트·프로세스·바이너리 함정이 많다(전부 CLAUDE.md에 기록됨). 띄우기 전에 아래를 순서대로 점검한다. 증상이 "코드는 맞는데 동작이 옛날 것"이면 거의 항상 아래 1~2번이다.

## 1) 포트 점유 확인 — 어느 worktree의 프로세스인지까지
```bash
for p in 5173 8080 9001; do echo "== :$p =="; lsof -nP -iTCP:$p -sTCP:LISTEN; done
# 점유 PID의 작업 디렉터리(어느 worktree/checkout인지) 확인:
ps -o pid=,cwd=,command= -p <PID>
```
다른 worktree(또는 master)에서 띄운 vite(5173)/controller(8080)가 살아 있으면 그쪽 번들·DB를 서빙해 "변경이 안 보인다". 잘못된 것만 죽인다: `kill <PID>`. 브라우저는 hard reload.

## 2) 엔진/proto를 고쳤다면 워커부터 재빌드
```bash
cargo build -p handicap-worker
```
`cargo run -p handicap-controller`는 `target/debug/worker`(subprocess가 spawn하는 그 바이너리)를 재빌드하지 않는다. 옛 워커가 새 스텝/필드를 못 읽어 run이 시작 직후 exit → run이 `running` + 요청수 0으로 멈춘다(코드/네트워크 아님 — controller 로그의 worker exit를 먼저 본다).

## 3) 컨트롤러 + UI 시작 — 정확한 명령
```bash
just run-controller-with-ui      # 내부적으로 --bin controller 고정 + UI 정적 서빙
```
직접 띄울 땐 반드시 `--bin controller` (handicap-controller엔 controller + e2e_kind_driver 두 바이너리라 그냥 `-p`는 모호 에러):
```bash
cargo run -p handicap-controller --bin controller -- --ui-dir ui/dist
```
UI dev 서버를 따로 쓰면: `cd ui && pnpm dev` (vite `/api` → `http://127.0.0.1:8080` 프록시, `HANDICAP_API`로 override).

## 4) 살아있는지 검증
```bash
curl -s -o /dev/null -w "GET /api/scenarios -> %{http_code}\n" http://127.0.0.1:8080/api/scenarios
```
UI에서 404/CORS면 controller부터 의심(`curl http://127.0.0.1:8080/api/scenarios`).

## 5) kind 모드일 때 port-forward
pod이 재생성되면(`just deploy-kind`/`helm upgrade`/`kubectl delete pod`/eviction) forward가 조용히 죽는다 — pod은 Running인데 8080에 listen이 없음(`lsof -iTCP:8080 -sTCP:LISTEN`가 빈 결과). pod을 건드렸으면 무조건 재기동:
```bash
kubectl -n handicap port-forward svc/handicap-handicap-controller 8080:8080 &
```
wiremock: stub 등록은 호스트 `localhost:9001`(port-forward), in-cluster 워커는 cluster DNS `http://wiremock.handicap-test.svc.cluster.local:8080`로 친다(pod 안에서 localhost는 자기 loopback이라 :9001 안 통함). stub이 보이는지는 health가 아니라 `curl …localhost:9001/__admin/mappings`로 확인.

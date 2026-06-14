---
name: live-verify
description: Scaffold and tear down the handicap pre-merge live-verification stack — worktree-relative controller/worker binaries + a latency-configurable HTTP responder + an isolated SQLite DB + scenario/run creation — so Playwright or curl can exercise a UI/engine slice end-to-end against a real backend. Use before merging any slice that touches run creation, report parsing, or the load engine (the S-D gap: RTL fixtures give absent-not-null and miss server response-path bugs). Invoke via /live-verify or when a slice's plan reaches its live-verification step.
---

# live-verify — 슬라이스 머지 전 라이브 검증 스택

RTL/`tsc -b`는 서버가 실제 보내는 `null`·응답 경로를 못 잡는다(S-D 함정: fixture가 `null`이 아니라 *absent*를 줌). 그래서 run 생성·리포트 파싱·엔진을 건드린 슬라이스는 **머지 전 실제 백엔드로 1회** 돌려야 한다. 이 스킬은 그 셋업/정리를 함정까지 포함해 표준화한다.

## 함정 요약 (이 스킬이 자동으로 피하는 것)
- **워크트리 자체 바이너리로** — 메인 체크아웃의 `…/handicap/target/debug/controller`는 다른 브랜치 stale일 수 있다. 워크트리 root에서 빌드 후 **상대경로** `./target/debug/controller`로(spawn되는 `target/debug/worker`도 cwd-상대).
- **응답 지연 ≥ ~50 ms responder** — localhost sub-ms면 `p50_ms==0`이라 사이징/phase/측정 경로가 0-가드에 걸려 폴백(Slice-5 함정). 50 ms sleep이 `p50>0` 보장.
- **격리 DB** `/tmp/<slug>.db` — 메인/다른 워크트리 DB에 안 붙게.
- **생성 응답을 파싱하지 말 것** — `POST /api/scenarios`·`/api/runs` 응답엔 멀티라인 `scenario_yaml`이 박혀 셸/`jq`/`python json`이 raw 개행으로 깨진다. **id는 `GET /api/scenarios/{id}/runs` 목록에서 재조회**하거나 curl→python 직결.
- **정리** — `.playwright-mcp/`와 repo 루트 png는 gitignore 안 됨 → 머지 전 삭제.

## 1) 빌드 + 기동 (워크트리 root에서)
```bash
WT=/Users/sgj/develop/handicap/.claude/worktrees/<slug>   # 현재 워크트리
cd "$WT"
cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller
( [ -f ui/dist/index.html ] || (cd ui && pnpm build) )    # UI 슬라이스면 dist 최신화

rm -f /tmp/<slug>.db
python3 .claude/skills/live-verify/responder.py 9999 50 > /tmp/<slug>-responder.log 2>&1 &   # 포트 9999, 50ms
./target/debug/controller --db /tmp/<slug>.db --ui-dir ui/dist > /tmp/<slug>-controller.log 2>&1 &
sleep 2
curl -s -o /dev/null -w 'responder %{http_code}\n' http://127.0.0.1:9999/
curl -s -o /dev/null -w 'controller %{http_code}\n' http://127.0.0.1:8080/api/scenarios
```
> 포트가 안 비었으면 `lsof -ti :8080` → `ps -o cwd= -p <PID>`로 어느 워크트리인지 보고 죽인다(`dev-doctor` 참조).

## 2) 시나리오 + 완료 run 준비 (앵커·리포트가 필요하면)
```bash
printf 'version: 1\nname: lv\nsteps:\n  - id: 0123456789ABCDEFGHJKMNPQRS\n    type: http\n    name: ping\n    request:\n      method: GET\n      url: http://127.0.0.1:9999/\n' > /tmp/<slug>-scn.yaml
SID=$(jq -Rs '{yaml:.}' /tmp/<slug>-scn.yaml | curl -s -XPOST http://127.0.0.1:8080/api/scenarios -H 'content-type: application/json' -d @- | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -XPOST http://127.0.0.1:8080/api/runs -H 'content-type: application/json' -d "{\"scenario_id\":\"$SID\",\"profile\":{\"vus\":5,\"duration_seconds\":5},\"env\":{}}" >/dev/null
# 완료 폴링 + 리포트(요청 id는 목록에서 재조회 — 생성 응답 파싱 금지)
RID=$(curl -s "http://127.0.0.1:8080/api/scenarios/$SID/runs" | python3 -c 'import sys,json;print(json.load(sys.stdin)["runs"][0]["id"])')
for i in $(seq 1 12); do S=$(curl -s "http://127.0.0.1:8080/api/runs/$RID" | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])'); echo "poll $i $S"; [ "$S" = completed ] && break; sleep 1; done
curl -s "http://127.0.0.1:8080/api/runs/$RID/report" | python3 -c 'import sys,json;s=json.load(sys.stdin)["summary"];print("rps",round(s["rps"],1),"p50",s["p50_ms"])'
```
> 페이로드 키: closed-loop=`profile:{vus,duration_seconds}`, open-loop=`{target_rps,max_in_flight,duration_seconds}`(vus 생략 가능), 곡선=`{vu_stages|stages,duration_seconds:0}`. summary 키=`count/errors/rps/p50_ms/p95_ms/p99_ms`.

## 3) Playwright (인라인 evaluate — 저장-경로 의존 회피)
- `http://127.0.0.1:8080`로 navigate. **`filename` 없는 `browser_evaluate`/`browser_snapshot`**으로 상태를 텍스트로 직접 추출(저장 png/yml은 고정-cwd로 가 ENOENT/잔류).
- React controlled input은 native setter: `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}))`. **click과 단언은 별도 evaluate**(React 18 batching).
- 끝에 `browser_console_messages({level:'error'})`로 Zod 0 확인.

## 4) 정리 (머지 전 필수)
```bash
kill $(lsof -ti :8080) 2>/dev/null; kill $(lsof -ti :9999) 2>/dev/null
rm -f /tmp/<slug>.db /tmp/<slug>-*.log /tmp/<slug>-scn.yaml
rm -rf "$WT/.playwright-mcp"; rm -f "$WT"/*.png 2>/dev/null
git -C "$WT" status --porcelain   # 잔류 untracked 0 확인
```

`responder.py`는 이 스킬 디렉토리에 번들됨(`python3 .claude/skills/live-verify/responder.py <port> <delay_ms>`).

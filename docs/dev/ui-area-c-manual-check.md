# 영역 C — 시나리오 에디터 test-run 수동 점검 매뉴얼

머지 직전(또는 회귀 점검 시) 실행. 자동 검증은 이미 충분하다(engine `trace.rs` unit + wiremock 통합,
controller `test_runs_api_test.rs`/`if_branch_report_e2e_smoke` 류, UI RTL `scenarioTrace.test.ts`/
`useTestRun.test.tsx`/`TestRunPanel.test.tsx`/`ScenarioEditPage.testrun.test.tsx` + `model.test.ts`
`summarizeCondition`). 이 매뉴얼은 사람이 실제 에디터에서 **버퍼를 1회 실행**해, 요청별 trace가
패널에 **제대로 렌더되는지**(http/if/loop 행·조건 요약·미바인딩 앰버·truncated·에러)와, 환경 오버레이가
**실제 HTTP 요청까지 흘러가는지**(`${ENV}` 주입)를 직접 확인하기 위한 것이다.

영역 C(C-2 UI)가 다루는 범위 (= 점검 대상):

| 하위 | 내용 | 이 매뉴얼 섹션 |
|---|---|---|
| **컨트롤** | `ScenarioEditPage`의 Test-run 영역: `<EnvironmentPicker>` 재사용 + `max_requests` 입력 + 버튼(미저장 버퍼 전송) | §5 |
| **패널** | `TestRunPanel`: http 행(method/url/status/latency/추출/펼침), if 행(조건 요약 + 분기 라벨), loop `#index`, 미바인딩 앰버, truncated 배너, 빈-스텝 | §6 |
| **환경 주입** | `resolveEnv(baseVars, overrides)` → `env` → 엔진이 `${ENV}` 해석 → 실제 요청 | §7 |
| **상한/에러** | `max_requests` truncation, 422(파싱불가/범위초과), assert/unreachable 에러 행 | §8 |
| **ephemeral** | test-run은 아무것도 저장 안 함(runs 목록·DB 무변경) | §9 |

각 체크박스를 진행하며 확인한다. 하나라도 실패하면 미완으로 보고 follow-up을 만든다.

> 결정 근거는 ADR-0026 / spec `docs/superpowers/specs/2026-06-01-scenario-editor-test-run-design.md`(§5/§7),
> plan `docs/superpowers/plans/2026-06-01-scenario-editor-test-run-c2-ui.md`.
> 핵심 불변식: test-run = **컨트롤러 in-process** 1 VU·1회 통과(워커 경로 아님) + **완전 ephemeral**(DB 0).
> 패널은 `ScenarioTrace`의 순수 렌더러이되, if 행 **조건 요약**만은 `ScenarioTrace`에 cond 텍스트가 없어
> 에디터가 live `yamlText`를 파싱해 `steps` prop으로 주입한 것을 쓴다(없으면 요약만 생략).

---

## 0. 사전 도구 (최초 1회 — "초기 환경 세팅"이라 건너뜀)

`CLAUDE.md`의 "개발 환경 세팅"과 동일(Rust toolchain + `protoc`/`just` + Node/pnpm + Docker). 이미 돼 있으면 생략.
이 매뉴얼은 그 이후의 **순차 실행 + 점검**만 다룬다. 빠른 자동 진단은 `dev-doctor` 스킬.

---

## 1. 빌드 (`just`) — 체크아웃 루트에서

```bash
just build        # 워크스페이스 전체 — controller(test-runs 라우트 + 엔진 trace 포함)까지 새로 빌드
just ui-install   # ui/node_modules (frozen-lockfile)
just ui-build     # ui/dist (controller가 --ui-dir로 정적 서빙) — tsc -b 게이트도 겸함
```

> ⚠️ test-run은 **워커가 필요 없다**(컨트롤러 in-process 실행). 그래도 `just build`는 워커까지 빌드하는데
> 무해하다 — `run-controller-with-ui`가 `--worker-bin target/debug/worker`를 참조하지만 그건 **부하 run 생성 시에만**
> 쓰인다. test-run 경로는 워커를 안 띄운다.
> ⚠️ **반드시 controller를 새로 빌드**해야 `POST /api/test-runs` 라우트와 엔진 `trace_scenario`가 들어간다 —
> 옛 controller 바이너리면 test-run POST가 404. (master `9b3ebcc` 이상인지 `git log --oneline -1` 확인.)

---

## 2. 타깃(wiremock) 띄우고 stub 등록 (별도 터미널 T0)

test-run은 trace지만 **실제 HTTP 요청을 보낸다**(엔진 executor 그대로). http 행에 진짜 status/latency가
찍히려면 도달 가능한 타깃이 필요하고, §7에서 `${ENV}` 주입이 실제 요청까지 갔는지를 wiremock 저널로 확인한다.

```bash
# T0 — wiremock 컨테이너 (호스트 9090 → 컨테이너 8080)
docker run --rm --name handicap-wm-c -p 9090:8080 wiremock/wiremock:3.7.0 --global-response-templating

# (다른 터미널) stub 등록 — /ping 200, /secure 401(인증 없으면 거절 흉내)
curl -s -X POST http://localhost:9090/__admin/mappings -H 'Content-Type: application/json' \
  -d '{"request":{"method":"GET","urlPath":"/ping"},"response":{"status":200,"jsonBody":{"ok":true},"headers":{"Set-Cookie":"sid=abc; Path=/"}}}' >/dev/null
curl -s -X POST http://localhost:9090/__admin/mappings -H 'Content-Type: application/json' \
  -d '{"request":{"method":"GET","urlPath":"/secure"},"response":{"status":401,"jsonBody":{"error":"no token"}}}' >/dev/null

# 등록 확인(방금 넣은 mapping을 실제 read — health 단독 금지, Slice 6 학습)
curl -s http://localhost:9090/__admin/mappings | python3 -m json.tool | grep -E '/ping|/secure'

# 점검 시작 전 요청 로그 초기화
curl -s -X DELETE http://localhost:9090/__admin/requests
```

> `/nope` 같은 미등록 경로는 wiremock이 **404**로 응답한다 — §6의 "4xx 빨강 status 칩"에 쓴다.
> in-process 엔진은 호스트에서 도므로 `http://localhost:9090`으로 wiremock에 닿는다.

---

## 3. controller + UI 실행 (`just`, 별도 터미널 T1)

```bash
rm -f ./handicap.db          # (선택) 깨끗한 DB
just run-controller-with-ui  # REST 8080 + gRPC 8081 + 정적 UI (워커는 안 띄움 — test-run엔 불필요)

# 준비 확인 (다른 터미널)
curl -sf -o /dev/null -w "REST %{http_code}\n" http://127.0.0.1:8080/api/scenarios     # 200
curl -s  -o /dev/null -w "UI   %{http_code}\n" http://127.0.0.1:8080/                   # 200
# test-runs 라우트가 살아있는지 직접 타진(빈 본문 → 422가 정상; 404면 controller가 옛 빌드)
curl -s -o /dev/null -w "test-runs %{http_code}\n" -X POST http://127.0.0.1:8080/api/test-runs \
  -H 'content-type: application/json' -d '{}'                                            # 422 (404 아님!)
```

브라우저로 **http://localhost:8080** 접속.

- 포트 선점 확인: `lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(8080|8081|5173|9090)'` → stray 정리(여러 워크트리에서 8080/5173 선점 함정, 루트 CLAUDE.md).
- HMR이 필요하면 controller는 `just run-controller`, UI는 T2에서 `just ui-dev`(5173, `/api`→8080 프록시) → 접속은 **http://localhost:5173**.

---

## 4. 데모 시나리오 만들기 — `/scenarios` → New scenario → YAML 탭

아래를 YAML 탭에 붙여넣고 **Create**. http + if(조건 요약) + loop(`#index`) + extract + 미바인딩을 한 번에 본다.

```yaml
version: 1
name: testrun-smoke
variables:
  code: "200"
steps:
  - id: "01HX00000000000000000000C1"
    name: ping
    type: http
    request: { method: GET, url: "${BASE_URL}/ping" }
    extract:
      - { from: status, var: status_code }
  - id: "01HX00000000000000000000C2"
    name: branch-on-code
    type: if
    cond: { left: "{{code}}", op: eq, right: "200" }
    then:
      - id: "01HX00000000000000000000C3"
        name: ok-call
        type: http
        request: { method: GET, url: "${BASE_URL}/ping" }
    else:
      - id: "01HX00000000000000000000C4"
        name: secure-call
        type: http
        request: { method: GET, url: "${BASE_URL}/secure", headers: { Authorization: "Bearer {{token}}" } }
  - id: "01HX00000000000000000000C5"
    name: loopy
    type: loop
    repeat: 3
    do:
      - id: "01HX00000000000000000000C6"
        name: loop-call
        type: http
        request: { method: GET, url: "${BASE_URL}/ping?i=${loop_index}&t={{token}}" }
```

> - `${BASE_URL}`은 환경 변수(§7에서 주입). `{{code}}`는 `variables.code="200"`(바인딩됨). `{{token}}`은 **어디에도 없음 → 미바인딩**(앰버 대상).
> - `${loop_index}`는 0-based **시스템 변수**(loop 안에서만 바인딩; `${}` 표기). `{{token}}`은 흐름 변수(`{{}}` 표기) — 표기 혼동 주의(ADR-0014).
> - `code="200"`이라 if는 **then**을 탄다(else의 `secure-call`은 실행 안 됨).
- [ ] 캔버스 탭으로 전환하면 http 1 + if 컨테이너(THEN/ELSE 밴드) + loop 컨테이너(자식 http)가 보인다(렌더 sanity).

---

## 5. Test-run 컨트롤 (`ScenarioEditPage`) — 시나리오 **Edit** 화면

시나리오 목록에서 `testrun-smoke`의 **Edit**로 들어간다. 에디터 아래에 **Test run** 영역이 있다.

- [ ] **"Test run"** 제목 + **환경 dropdown**(`<EnvironmentPicker>` 재사용, RunDialog와 동일 UI) + **Max requests** 숫자 입력(기본 **50**) + **Test run** 버튼.
- [ ] 환경 dropdown은 `(없음)` + 등록된 환경들. (환경이 없으면 §7에서 먼저 만든다 — 지금은 `(없음)`인 채 진행 가능: BASE_URL을 override로 직접 넣을 거라.)
- [ ] **미저장(dirty) 버퍼로도 동작**: 에디터에서 아무 URL의 글자를 하나 바꿔(예 `/ping`→`/ping2`) **Save 하지 말고** 그대로 둔다. (§6에서 trace의 resolved url이 **저장이 아니라 현재 버퍼**를 따르는지 확인할 것 — 확인 후 되돌려 둔다.)

> 버튼은 `testRun.mutate({ scenario_yaml: <현재 yamlText>, env: resolveEnv(baseVars, envEntries), max_requests })`를
> 보낸다. 즉 **저장 여부와 무관**하게 화면의 버퍼가 그대로 trace 대상이다.

---

## 6. `TestRunPanel` 렌더 점검 (C-2의 핵심)

§5에서 **BASE_URL을 먼저 채운다**: 환경 `(없음)`인 채 Env override add-row에 `BASE_URL = http://localhost:9090` 추가
(또는 §7에서 환경 `local`을 만들어 선택). Max requests=50 그대로 → **Test run** 클릭.

패널(`Test run result` 영역)이 에디터 하단에 뜬다. 위에서부터:

- [ ] **요약 줄**: `Test run` 제목 + **OK/FAIL 칩** + `{total_ms}ms · {N} steps`. (이 시나리오는 then 분기 + loop라 에러 없으면 **OK 초록**.)
- [ ] **http 행(`ping`)**: `▸` 캐럿 · `GET`(짙은 칩) · 해석된 url `http://localhost:9090/ping`(mono) · **`200` 초록 status 칩** · `Nms` latency · 추출 칩 **`status_code=200`**(indigo).
- [ ] **행 펼치기**: `ping` 행 클릭(`▸`→`▾`) → **Request headers** 표 + **Response headers** 표 + **Set-Cookie**(`sid=abc; Path=/`) + 응답 body(`{"ok":true}`)가 보인다. 다시 클릭하면 접힌다.
- [ ] **if 행(`branch-on-code`)**: 보라 **`if` 칩** + **조건 요약 `{{code}} eq 200`**(mono — 해석값이 아니라 **작성된 조건식** 그대로) + `→` + **분기 라벨 `then`**(보라 칩) + 끝에 muted `step_id`.
- [ ] **then 자식 http 행(`ok-call`)**: `GET … /ping` · `200` 초록. (else의 `secure-call`은 **실행 안 됐으므로 행 자체가 없다**.)
- [ ] **loop 자식 http 행(`loop-call`) × 3**: 각 행 앞에 **`#0` `#1` `#2`**(loop_index 칩) · url에 `?i=0`/`?i=1`/`?i=2`로 **`${loop_index}` 해석** 확인.
- [ ] **미바인딩 앰버(http)**: `loop-call` 행들 아래 **`unbound:` + 앰버 칩 `token`**(`{{token}}`이 어디에도 없어서). `${loop_index}`는 앰버에 **안** 뜬다(시스템 값으로 바인딩됨).

### 6-1. if 행 **조건 unbound**(앰버) — 변형
- [ ] 에디터에서 if의 `cond`를 `{ left: "{{missing}}", op: eq, right: "x" }`로 바꾸고(Save 불필요) **Test run** → if 행에
      조건 요약 `{{missing}} eq x` + **`조건 unbound:` + 앰버 칩 `missing`**, 분기 라벨은 `(미매치)`(then/elif/else 다 거짓 + else 비었음). 확인 후 원복.

> `(미매치)` = `none` 분기(조건 false + elif 모두 false + else 없음/비었음)의 한국어 라벨.
> `elif`가 있으면 라벨이 `elif 1`처럼 뜬다(연산자 토큰은 `eq`/`ne`/`gte`… 원형 — `==` 아님).

### 6-2. 에러 행 + **FAIL** 요약 — 변형
- [ ] `ping` 스텝 url을 `${BASE_URL}/nope`로 바꿔 **Test run** → 그 행 status 칩이 **`404` 빨강**(error 없이도 status≥400이면 빨강). 요약은 여전히 OK일 수 있다(assert 없으면 404는 에러 아님).
- [ ] 이번엔 `ping` 스텝에 `assert: [{ status: 200 }]`을 추가하고 url을 `/nope`로 둔 채 **Test run** → 그 행에 **빨간 에러 텍스트 `status 404 != 200`** + 요약이 **FAIL 빨강**. 확인 후 원복(`/ping`, assert 제거). (assert는 **맵 형태** `[{ status: 200 }]` — `[200]` 아님.)
- [ ] **도달 불가**(connection 단계 실패): BASE_URL override를 `http://localhost:9099`(stub 없는 포트)로 바꿔 **Test run** → http 행에 **빨간 에러 텍스트**(`error sending request…` 류) + status 칩 없음 + 요약 FAIL. 확인 후 9090 원복.

### 6-3. 빈 스텝
- [ ] 새 시나리오(또는 임시로) `steps: []`로 두고 **Test run** → 패널에 **"실행할 스텝이 없습니다."** 메시지(OK, 0 steps).

---

## 7. 환경 오버레이 end-to-end (`${ENV}` 주입) — 환경 값이 실제 요청까지 가는가

상단 네비 **Environments**(`/environments`)에서 환경 `local` 생성: 변수 `BASE_URL = http://localhost:9090` → Save.
(영역 B 매뉴얼 §4와 동일. 이미 있으면 생략.) 다시 `testrun-smoke` **Edit** 화면으로.

- [ ] wiremock 로그 초기화: `curl -s -X DELETE http://localhost:9090/__admin/requests`.
- [ ] Test-run 영역 환경 dropdown에서 **`local` 선택** → 아래 **"from local (읽기 전용):"** 에 `BASE_URL = http://localhost:9090`. override는 비운 채 **Test run**.
- [ ] 패널 http 행들의 **resolved url**이 전부 `http://localhost:9090/...` — 즉 `${BASE_URL}`이 환경 값으로 해석됨.
- [ ] **wiremock 저널 확인**(요청이 실제로 나갔다는 증거):
      `curl -s 'http://localhost:9090/__admin/requests?limit=20' | python3 -m json.tool | grep -E '"url"'`
      → `/ping`, `/ping?i=0`, `/ping?i=1`, `/ping?i=2`가 보인다(then 분기 + loop 3회).
- [ ] **override가 base를 이긴다**: add-row로 `BASE_URL`을 `http://localhost:9090`(같은 키)로 override 추가 → base 행이 `재정의됨`(취소선). **Test run** → 동일 동작(우선순위 환경 < override). (override 값을 `http://localhost:9091`처럼 다른 stub으로 바꾸면 9091 저널에만 찍히는지로 더 확실히.)
- [ ] **환경 미선택 = override-only**(하위호환): dropdown `(없음)` + override로 `BASE_URL` 직접 입력 → §7 위와 동일하게 wiremock에 찍힌다(= `resolveEnv({}, 입력행)`).

> resolved url은 **서버 trace(`request.url`)** 가 권위 — UI의 표시용 `resolveForDisplay`와 별개로 **엔진이 실제 보낸 값**을 그대로 보여준다(진단 정확도, spec §5-2).

---

## 8. 상한(truncation) · 422

**8-A. `max_requests` truncation**
- [ ] Max requests를 **2**로 낮추고(http leaf는 ping=1 + ok-call=1 = 2에서 끊김) **Test run** → 패널 상단에 **앰버 배너 "상한 도달 — 일부만 실행됨 (max_requests 또는 시간 천장)"** + **loop 행들이 안 보인다**(2개 leaf까지만). 요약 step 수도 줄어든다.
- [ ] Max requests를 50으로 원복 → 배너 사라지고 loop 행 3개 복귀.

**8-B. 422 — 의미 검증(test-run 전용 422, 레거시 400과 분기)**
- [ ] **파싱 불가 YAML**: 에디터에서 `steps:`를 `steps`(콜론 삭제)처럼 깨뜨리고 **Test run** → 패널 대신 **빨간 에러 배너**(`scenario parse: …`). 확인 후 원복.
- [ ] **범위 초과 max_requests**: 입력을 **0**으로(또는 비워서 NaN) **Test run** → **422 에러 배너**(`max_requests must be 1..=10000…`). (입력의 `min=1 max=10000`은 advisory라 0도 전송됨 → 서버가 권위 있게 거절.) 확인 후 50 원복.

> 422는 `ApiError::Unprocessable` — test-run 엔드포인트만 쓴다(axum 추출기가 이 라우트에 이미 422를 내므로 일관). 레거시(runs/presets/…)는 400 유지(의도된 분기). 에러는 `request`가 `ApiError`로 throw → 배너 문구로 노출.

---

## 9. ephemeral — test-run은 아무것도 저장 안 한다

- [ ] §6~§8에서 test-run을 여러 번 돌린 뒤, `testrun-smoke`의 **Runs** 페이지로 → **새 run이 하나도 안 생겼다**(test-run은 부하 run이 아님).
- [ ] REST 교차 확인: `curl -s http://127.0.0.1:8080/api/scenarios/<id>/runs | python3 -m json.tool` → 배열 그대로(증가 없음).
- [ ] (선택) DB 무변경: `sqlite3 ./handicap.db 'select count(*) from runs;'` 값이 test-run 전후로 동일.

> 완전 ephemeral 결정(ADR-0026): DB·마이그레이션 0, 워커 0, 메트릭 집계 0. test-run은 디버그 probe일 뿐.

---

## 트러블슈팅 (영역 C 특이)

- **`POST /api/test-runs` 404**: controller가 옛 빌드. `just build` 후 `just run-controller-with-ui` 재시작(§3 타진 curl이 422여야 정상).
- **버튼 눌러도 패널 안 뜸 / 무한 "Running…"**: 네트워크 탭에서 `/api/test-runs` 응답 확인. 422면 에러 배너로 떠야 정상(파싱·범위). 5xx면 controller 로그. (test-run은 워커 무관 — "running+0req" 부하-run 함정과 다름.)
- **http 행 status 0 또는 전부 빨강 에러**: `${BASE_URL}` 미주입(환경 미선택 + override도 안 넣음 → url이 host 없는 `/ping`) 또는 wiremock 죽음. §7에서 BASE_URL을 넣었는지, `curl http://localhost:9090/__admin/health` 확인.
- **resolved url이 옛 값**: 저장본이 아니라 **현재 버퍼**를 보낸다 — 그래도 옛 값이면 캔버스/YAML 동기화(EditorShell)가 yamlText를 안 밀었는지. 탭을 한 번 전환해 보거나 한 글자 편집으로 onChange 유발.
- **조건 요약이 안 뜸(분기 라벨만)**: if 행 `step_id`가 버퍼 파싱 결과와 안 맞거나 버퍼가 파싱 불가(`parseScenarioDoc` 실패 → `steps=[]` → 요약 생략, graceful). YAML이 유효한지(§8-B처럼 깨지지 않았는지) 확인. 미바인딩 앰버/분기 라벨은 trace에서 오므로 요약만 빠진다.
- **여러 워크트리 포트 선점**: `lsof -i :8080`/`:5173` → `ps -o cwd= -p <PID>`로 워크트리 확인 후 stray 정리(루트 CLAUDE.md).

---

## 사인오프

- [ ] §5 컨트롤(환경 picker + max_requests + 버튼, 미저장 버퍼 전송) 통과
- [ ] §6 패널 렌더(요약 OK/FAIL · http 행 status/latency/추출/펼침 · if 조건 요약+분기 라벨 · loop `#index` · 미바인딩 앰버 · 빈-스텝) 전부 통과
- [ ] §6-1/6-2 변형(조건 unbound 앰버 · 404 빨강 · assert 에러+FAIL · 도달불가 에러) 통과
- [ ] §7 환경 주입 end-to-end(resolved url + wiremock 저널 + override-wins + 미선택 하위호환) 통과
- [ ] §8 truncation 배너 + 422(파싱불가·범위초과) 통과
- [ ] §9 ephemeral(runs 무증가 · DB 무변경) 통과

하나라도 실패 → follow-up 이슈/노트로 남기고 머지 보류.

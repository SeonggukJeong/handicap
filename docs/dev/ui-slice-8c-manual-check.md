# Slice 8c — 데이터셋 바인딩·주입 수동 점검 매뉴얼

머지 직전(또는 회귀 점검 시) 실행. 환경 세팅 명령부터 차근차근. 자동 검증은 이미
충분하다(엔진 unit/integration, controller 게이트, worker 로딩, per_vu **브라우저 e2e**,
Rust e2e `data_binding_per_vu_injects_distinct_values`) — 이 매뉴얼은 사람이 실제 UI로
바인딩을 만들어 보고, 주입된 값이 타깃에 도달하는지 직접 확인하기 위한 것이다.

> 8c가 추가한 핵심 UI = **Run 다이얼로그의 "Data binding" 패널**(`DataBindingPanel`).
> 데이터셋 업로드(`/datasets`)는 8b, 시나리오 작성(캔버스/YAML)은 Slice 3이다.

---

## 0. 사전 도구 (최초 1회)

`CLAUDE.md`의 "개발 환경 세팅"과 동일. 이미 돼 있으면 건너뛴다.

```bash
# Rust toolchain (edition 2024 + MSRV 1.85)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
  --default-toolchain stable --component rustfmt --component clippy
. "$HOME/.cargo/env"

# protoc(tonic-build 빌드 타임) + just(태스크 러너)
brew install protobuf just

# Node + pnpm (UI). pnpm이 없으면:
corepack enable && corepack prepare pnpm@latest --activate

# Docker — wiremock 타깃 컨테이너용 (Docker Desktop 실행 상태)
docker --version && docker ps >/dev/null && echo "docker OK"

# 확인
cargo --version && rustc --version && protoc --version && just --version && node --version
```

---

## 1. 빌드 (워크트리/체크아웃 루트에서)

```bash
# 워크스페이스 + 워커 바이너리.
# controller는 --worker-bin 경로의 바이너리를 subprocess로 spawn하므로 워커를 반드시 따로 빌드.
# (cargo run -p handicap-controller 는 controller만 다시 빌드하고 target/debug/worker 는 안 건드린다.)
cargo build --workspace
cargo build -p handicap-worker

# UI 의존성 + 정적 빌드 (controller가 --ui-dir 로 서빙할 dist)
cd ui && pnpm install --frozen-lockfile && pnpm build && cd ..
```

---

## 2. 타깃(wiremock) 띄우고 stub 등록 (별도 터미널 T0)

부하 테스트가 실제로 때릴 가짜 API. 주입된 `{{user}}` 값을 query로 받는 `GET /hit` 하나면 충분하다.

```bash
# T0 — wiremock 컨테이너 (호스트 9090 → 컨테이너 8080)
docker run --rm --name handicap-wm-8c -p 9090:8080 wiremock/wiremock:3.7.0 \
  --global-response-templating

# (다른 터미널에서) /hit stub 등록 — urlPath 라 query(?u=...)는 무시하고 매칭
curl -s -X POST http://localhost:9090/__admin/mappings \
  -H 'Content-Type: application/json' \
  -d '{"request":{"method":"GET","urlPath":"/hit"},
       "response":{"status":200,"headers":{"Content-Type":"application/json"},
                   "jsonBody":{"ok":true}}}'

# sanity — 주입될 형태로 직접 한 번 때려본다
curl -s -o /dev/null -w "GET /hit?u=alice → %{http_code}\n" "http://localhost:9090/hit?u=alice"
# → 200 이어야 정상. 200이 아니면 stub 미등록.

# 점검 시작 전 요청 로그 초기화(나중에 alice/bob 검증을 깨끗하게)
curl -s -X DELETE http://localhost:9090/__admin/requests
```

함정(Slice 6 학습): 공유 포트의 health check는 신뢰 못 한다. 등록 직후
`curl -s http://localhost:9090/__admin/mappings` 로 방금 넣은 stub이 보이는지로 검증할 것.

---

## 3. controller 실행 (별도 터미널 T1)

UI까지 한 프로세스로 서빙(`--ui-dir`)하는 게 점검엔 가장 단순하다(단일 origin, 프록시 불필요).

```bash
# T1 — controller (REST 8080 + gRPC 8081 + 정적 UI), 깨끗한 DB로 시작
RUST_LOG=info,handicap_controller=debug cargo run -p handicap-controller --bin controller -- \
  --db /tmp/handicap-8c.db \
  --rest 127.0.0.1:8080 \
  --grpc 127.0.0.1:8081 \
  --worker-bin target/debug/worker \
  --ui-dir ui/dist
# (just run-controller-with-ui 도 동일 — ui/dist 없으면 자동 빌드.)

# 준비 확인 (다른 터미널)
curl -sf -o /dev/null -w "REST %{http_code}\n" http://127.0.0.1:8080/api/scenarios   # 200
curl -s  -o /dev/null -w "UI   %{http_code}\n" http://127.0.0.1:8080/                  # 200
```

브라우저로 **http://localhost:8080** 접속.

- `handicap-controller` 패키지엔 바이너리가 둘(`controller` + `e2e_kind_driver`)이라
  반드시 `--bin controller` 를 붙인다(안 붙이면 `could not determine which binary to run`).
- 게이트 상한 테스트(§6)를 하려면 `--dataset-max-rows 1` 같이 작게 줘서 다시 띄운다(기본 1,000,000).
- 다른 워크트리/세션의 controller·vite가 8080/8081/5173/9090을 선점했는지 먼저 확인
  (`lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(8080|8081|5173|9090)'`). 선점 시 stray 프로세스 정리.

> 대안(HMR이 필요하면): controller는 `--ui-dir` 없이 띄우고 `cd ui && pnpm dev`(5173, `/api`→8080 프록시).
> 그 경우 접속 주소는 **http://localhost:5173**.

---

## 4. 데이터셋 업로드 (8b 화면 — 8c 바인딩의 입력)

- [ ] 상단 네비 **Datasets** → `/datasets`.
- [ ] **choose file**(또는 드래그드롭)로 아래 CSV 업로드:
  ```csv
  user
  alice
  bob
  ```
  (CSV 한 개 만들기: `printf 'user\nalice\nbob\n' > /tmp/users.csv`)
- [ ] 저장 전 **라이브 미리보기**에 `1 columns · 2 rows`, 컬럼 `user`, 행 `alice`/`bob`이 보인다.
- [ ] (선택) header/delimiter/encoding override를 바꿔 미리보기가 즉시 갱신되는지 확인.
- [ ] **Save dataset** → 아래 목록에 `handicap-8c-users(또는 파일명) | user | 2 | Delete` 행 등장.

---

## 5. 시나리오 준비 ({{user}} 사용)

가장 빠른 길: **New scenario → YAML(코드) 탭**에 아래를 붙여넣고 Create.
(`${BASE_URL}`=env, `{{user}}`=흐름 변수(=바인딩으로 주입). step id는 유효한 ULID여야 함 — `I/L/O/U` 금지.)

```yaml
version: 1
name: data-binding-demo
steps:
  - id: "01HX0000000000000000000099"
    name: hit
    type: http
    request:
      method: GET
      url: "${BASE_URL}/hit?u={{user}}"
```

캔버스로 만들고 싶으면: HTTP 노드 1개, method `GET`, URL `${BASE_URL}/hit?u={{user}}`.

> CLI로 시드하고 싶으면(점검을 run 다이얼로그에 집중):
> `curl -s -X POST http://127.0.0.1:8080/api/scenarios -H 'Content-Type: application/json' -d "$(python3 -c 'import json;print(json.dumps({"yaml":open("/tmp/s.yaml").read()}))')"`

---

## 6. Run 다이얼로그 — Data binding 패널 (8c 핵심)

시나리오 목록에서 `data-binding-demo` 행의 **runs →** → **Run scenario**.

### 6.1 스캔·매핑·정책 (정상 경로)

- [ ] 다이얼로그에 **"Data binding"** 섹션이 보인다.
- [ ] **변수 매핑** 목록에 시나리오가 쓰는 `{{user}}`가 자동으로 한 행(`user`)으로 떠 있다
      (= `scanFlowVars`가 url/header/body·loop `do:`에서 `{{var}}`만 스캔. `${BASE_URL}`은 env라 안 뜸).
- [ ] 데이터셋 미선택 상태에선 `user` 행이 "데이터셋 선택 후 매핑 가능"이고, **Run은 막히지 않는다**
      (바인딩 없이 실행 = 8c 이전과 동일. 단 이 시나리오는 `{{user}}`가 안 풀려 런타임 실패하니 아래에서 데이터셋을 고른다).
- [ ] **Dataset** 드롭다운에서 `handicap-8c-users (2행)` 선택.
- [ ] **자동 매칭**: `user` 행의 source가 `user (예: alice)` 컬럼으로 자동 선택된다(같은 이름 컬럼 매칭, 샘플값 표시).
- [ ] **Policy** 드롭다운에 정확히 3개: `per_vu` / `iter_sequential` / `iter_random`. **`unique`는 없다.**
- [ ] Policy를 `iter_sequential`(또는 `iter_random`)로 바꾸면 **경고 배너** 등장:
      "per-iteration 정책은 전체 데이터셋(N행)을 워커 메모리에 적재합니다. 상한은 controller
      `--dataset-max-rows`(Helm `controller.datasetMaxRows`)." → `per_vu`로 되돌리면 배너 사라짐.

### 6.2 실행 + 주입 확인

- [ ] **Env** 섹션: key `BASE_URL`, value `http://localhost:9090` 입력 → **Add**
      (좌측 두 칸 동시 입력, key 비면 Add disabled. 이름 칸에 URL을 통째로 넣지 말 것 — status 0 폭주 함정).
- [ ] Policy `per_vu`, **VUs 2 / Duration 5s / Ramp-up 0s**, 데이터셋·매핑 위와 동일. **Run**.
- [ ] run 상세로 전환 → status `running` → 5초 후 **`completed`**.
- [ ] 리포트 Summary: **Errors 0**, Status codes 전부 `200`, per-step `hit` requests > 0.
      (per-step URL 셀엔 `…?u={{user}}` 처럼 `{{user}}`가 그대로 보인다 — 정상. step 라벨은 시나리오
      YAML 스냅샷을 `resolveForDisplay`로 표시할 뿐 흐름 변수는 안 푼다. 실제 주입값은 타깃 로그로 확인.)
- [ ] **주입 검증(가장 중요)** — 타깃이 실제로 받은 `u=` 값에 alice·bob 둘 다 있어야 한다:
  ```bash
  curl -s http://localhost:9090/__admin/requests | python3 -c '
  import json,sys; from urllib.parse import urlparse, parse_qs
  d=json.load(sys.stdin); vals={}
  for r in d.get("requests",[]):
      u=parse_qs(urlparse(r["request"]["url"]).query).get("u",[""])[0]
      vals[u]=vals.get(u,0)+1
  print("distinct u=:", dict(sorted(vals.items())))
  print("alice:", "alice" in vals, "| bob:", "bob" in vals)'
  ```
  → `per_vu` + 2 VUs + 2행이면 VU0=alice, VU1=bob로 **둘 다** 찍혀야 한다.
  (`iter_sequential`/`iter_random`도 1 VU로 충분히 돌리면 2값 모두 등장.)

---

## 7. 검증 게이트 / 음성 경로 (선택이지만 권장)

- [ ] **미커버 변수 차단**: 시나리오에 데이터셋에 없는 `{{missing}}`를 추가(예: URL에 `&x={{missing}}`).
      Run 다이얼로그에서 데이터셋을 선택하면 `missing` 행이 빨갛게 표시되고 **Run이 비활성**.
      (단, `{{missing}}`가 시나리오 `variables` 기본값이나 다른 step의 `extract`로 제공되면 차단 안 됨 = 정상.)
- [ ] **컬럼 불일치/빈/unique 게이트(서버측)**: 다음은 run-create에서 거부(400, 다이얼로그에 에러):
      매핑 컬럼이 데이터셋에 없음 / 빈 데이터셋 바인딩 / (UI엔 노출 안 되지만 API로) `unique` 정책.
- [ ] **per-iteration 상한**: controller를 `--dataset-max-rows 1`로 재기동 → 2행 데이터셋에
      `iter_sequential`로 Run → **400**(상한 초과)로 거부. 같은 데이터셋 `per_vu`는 **성공**(per_vu는 미상한).
- [ ] **참조 데이터셋 삭제 차단(409)**: VUs 2 / Duration 60s 같이 **오래 도는** per_vu run을 시작해 둔 채
      `/datasets`에서 그 데이터셋 **Delete** → **409**로 막힘(삭제 안 됨). run이 `completed`된 뒤 Delete → 정상 삭제.

---

## 8. 정리(cleanup)

```bash
# controller(T1)·vite(있으면) Ctrl-C
docker rm -f handicap-wm-8c            # wiremock 정지
rm -f /tmp/handicap-8c.db /tmp/users.csv
```

---

## 9. green 게이트 (머지 전 최종)

```bash
cargo fmt --check && cargo build --workspace && \
  cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
cd ui && pnpm lint && pnpm test && pnpm build && cd ..
```

모두 통과. (pre-commit 훅은 cargo만 돌리고 UI는 안 돌리므로 `pnpm test`/`pnpm build`는 수동 확인.)

---

## 부록 — 빠른 트러블슈팅

- **run이 영영 `running` + 0 req**: controller가 `target/debug/worker`(옛 바이너리)를 spawn 중.
  엔진/시나리오/proto 변경 후엔 `cargo build -p handicap-worker` 필수. controller 로그의 worker exit를 먼저 본다.
- **status 0 폭주 / 전부 5xx**: wiremock stub 미등록이거나 Env `BASE_URL`이 비어 `${BASE_URL}`이 unresolved,
  또는 host 없는 URL. §2 stub + §6.2 Env 행(`key=BASE_URL, value=http://...`) 확인.
- **UI에서 새 기능이 안 보임**: 다른 워크트리의 vite/controller가 포트 선점. `lsof`로 stray 정리 후 재기동 + 하드 리로드.
- **바인딩 패널에 데이터셋이 안 뜸**: `/datasets`에서 저장됐는지(목록에 행 있는지) 확인. 저장 전엔 미리보기만.

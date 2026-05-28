# Slice 4 — UI 수동 점검 체크리스트

머지 직전에 실행. 개발 루프:

```bash
# T0 — wiremock 기반 가짜 API (별도 터미널)
docker run --rm -p 9090:8080 \
  -e WIREMOCK_OPTIONS="--global-response-templating" \
  wiremock/wiremock:3.7.0

# 사전 — worker 바이너리 빌드 (controller의 --worker-bin 기본값이 target/debug/worker)
cargo build -p handicap-worker

# T1 — controller (REST + gRPC 만; UI는 vite가 띄움)
cargo run -p handicap-controller -- \
  --db ./handicap.db \
  --rest 127.0.0.1:8080 \
  --grpc 127.0.0.1:8081 \
  --worker-bin target/debug/worker

# T2 — UI dev 서버 (HMR + /api는 controller로 proxy)
cd ui && pnpm dev
```

`http://localhost:5173` 접속. (controller가 정적 SPA도 함께 서빙해야 한다면 `just run-controller-with-ui` — Slice 3 manual check 옵션 A 참고. Slice 4 점검은 vite dev로 진행 권장.)

## 사전 — wiremock stub 등록

§1·§2가 의존하는 stub은 wiremock admin API(`/__admin/mappings`)로 미리 등록한다.
빠뜨리면 RPS가 비정상적으로 높고 응답 status가 전부 `0`(connection failure)으로 찍힌다.

### §1 (토큰 인증)

```bash
# /login — POST, 200 + access_token
curl -s -X POST http://localhost:9090/__admin/mappings \
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
curl -s -X POST http://localhost:9090/__admin/mappings \
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

### §2 (쿠키 인증) — §1 마치고 reset 후 등록

`/login` path가 §1과 충돌하므로 reset 후 다시 등록한다.

```bash
curl -s -X DELETE http://localhost:9090/__admin/mappings

# /login — Set-Cookie 반환
curl -s -X POST http://localhost:9090/__admin/mappings \
  -H 'Content-Type: application/json' \
  -d '{
    "request":  { "method": "POST", "url": "/login" },
    "response": {
      "status": 200,
      "headers": { "Set-Cookie": "session=S3SSION; Path=/; HttpOnly" }
    }
  }'

# /profile — Cookie 검사
curl -s -X POST http://localhost:9090/__admin/mappings \
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
curl -s http://localhost:9090/__admin/mappings   # 등록된 stub 목록
curl -s http://localhost:9090/__admin/requests   # 실제 들어온 요청 로그 (Cookie 자동첨부 확인 등)
curl -s -X DELETE http://localhost:9090/__admin/mappings   # 전부 리셋

# stub 단독 sanity check (worker 돌리기 전에)
curl -i -X POST http://localhost:9090/login \
  -H 'Content-Type: application/json' -d '{"u":"a","p":"b"}'
# → 200 + {"access_token":"T0K3N"} 이 나와야 정상
```

## 1. 토큰 인증 멀티스텝

- [ ] `/scenarios/new` → 캔버스에서 step 1 추가, name `login`, method `POST`,
      URL `${BASE_URL}/login`, body `{"u":"a","p":"b"}` JSON.
- [ ] Assertion 200 추가.
- [ ] **Extracts** 섹션에서 **Add** → var `token`, from `body`, path `$.access_token`.
- [ ] step 2 추가, name `me`, method `GET`, URL `${BASE_URL}/me`,
      headers: `Authorization: Bearer {{token}}`, assertion 200.
- [ ] YAML 탭으로 전환해 `extract:` 블록이 step 1에 보이는지 확인. 다시 캔버스로.
- [ ] **Create** → 생성된 scenario에서 **Runs** → **New run** → VUs 5 / Duration 5s / Ramp-up 0s.
- [ ] **Env** 섹션에서 이름 `BASE_URL`, 값 `http://localhost:9090` 입력 → **Add**.
      (wiremock stub serving root — `__admin/...`은 관리 API.)
      주의: 좌측 시나리오 Variables 패널은 `{{var}}` 흐름 변수용이라 `${BASE_URL}`은 못 푼다.
      이름 칸에 값을 잘못 넣으면 status 0 폭주가 다시 일어난다 — Env 행이
      `key = BASE_URL, value = http://...` 형태인지 확인.
- [ ] wiremock stub 등록 완료 (상단 "사전 — wiremock stub 등록" §1 참고).
- [ ] 실행 페이지에서 status `running` → 종료 후 `completed`.
- [ ] 1초 시계열 메트릭이 step별로 보이고 error_count == 0.

## 2. 세션(쿠키) 인증

- [ ] wiremock stub 재등록 (상단 "사전 — wiremock stub 등록" §2 참고 — `/login`이 §1과 충돌하므로 reset 후).
- [ ] 새 scenario `cookie_jar: auto`. step 1 POST `${BASE_URL}/login` (Set-Cookie 반환),
      step 2 GET `${BASE_URL}/profile` (Cookie 헤더 자동 첨부).
- [ ] step 1 Extracts 비움 (jar 자동 처리).
- [ ] 같은 VUs 5 / Duration 5s로 실행. Env에 `BASE_URL=http://localhost:9090` 추가. error_count == 0.
- [ ] (선택) wiremock 로그로 Cookie 헤더가 자동 첨부됨을 확인.

## 3. Ramp-up

- [ ] scenario는 (1)에서 만든 토큰 시나리오 재사용. **New run**에서 VUs 50 / Duration 30s / Ramp-up 10s. Env에 `BASE_URL=http://localhost:9090` 추가.
- [ ] 실행 시작 직후 첫 5초 동안 RPS가 단계적으로 증가하는 것 확인 (메트릭 표).
- [ ] ramp 종료 후 정상 plateau.

## 4. Abort

- [ ] 새 run: VUs 5 / Duration 60s. Env에 `BASE_URL=http://localhost:9090` 추가.
- [ ] 시작 후 ~3초 뒤 **Abort** 버튼 클릭.
- [ ] 5초 안에 status `aborted`로 전환, RPS 그래프 절단.
- [ ] Abort 버튼은 사라지거나 disabled.

## 5. 오프라인 런타임 (Slice 2/3 회귀)

- [ ] `pnpm build` → controller로 정적 서빙. DevTools 네트워크 → Offline (`/api` 만 허용).
- [ ] 페이지 로드 시 CDN 요청 없음. CSP 위반 없음. Monaco worker 정상 동작.

## 6. lint/test/build green

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cargo fmt --check && cargo build --workspace && cargo test --workspace
```

모두 통과.

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

## 1. 토큰 인증 멀티스텝

- [ ] `/scenarios/new` → 캔버스에서 step 1 추가, name `login`, method `POST`,
      URL `${BASE_URL}/login`, body `{"u":"a","p":"b"}` JSON.
- [ ] Assertion 200 추가.
- [ ] **Extracts** 섹션에서 **Add** → var `token`, from `body`, path `$.access_token`.
- [ ] step 2 추가, name `me`, method `GET`, URL `${BASE_URL}/me`,
      headers: `Authorization: Bearer {{token}}`, assertion 200.
- [ ] YAML 탭으로 전환해 `extract:` 블록이 step 1에 보이는지 확인. 다시 캔버스로.
- [ ] **Create** → 생성된 scenario에서 **Runs** → **New run** → VUs 5 / duration 5s /
      env: `BASE_URL=http://localhost:9090` (wiremock stub serving root — `__admin/...`은 관리 API).
- [ ] wiremock에 미리 `/login` (200 + body `{"access_token":"T0K3N"}`) 및 `/me` (Bearer 검사 + 200) stub 등록.
- [ ] 실행 페이지에서 status `running` → 종료 후 `completed`.
- [ ] 1초 시계열 메트릭이 step별로 보이고 error_count == 0.

## 2. 세션(쿠키) 인증

- [ ] 새 scenario `cookie_jar: auto`. step 1 POST `${BASE_URL}/login` (Set-Cookie 반환),
      step 2 GET `${BASE_URL}/profile` (Cookie 헤더 자동 첨부).
- [ ] step 1 Extracts 비움 (jar 자동 처리).
- [ ] 같은 VUs 5 / duration 5s로 실행. error_count == 0.
- [ ] (선택) wiremock 로그로 Cookie 헤더가 자동 첨부됨을 확인.

## 3. Ramp-up

- [ ] scenario는 (1)에서 만든 토큰 시나리오 재사용. VUs 50 / ramp_up 10s / duration 30s.
- [ ] 실행 시작 직후 첫 5초 동안 RPS가 단계적으로 증가하는 것 확인 (메트릭 표).
- [ ] ramp 종료 후 정상 plateau.

## 4. Abort

- [ ] 새 run: VUs 5 / duration 60s.
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

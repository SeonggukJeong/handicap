# UI 수동 점검 가이드

브라우저에서 UI가 실제로 동작하는지 직접 눈으로 확인하고 싶을 때 보는 문서. 슬라이스 2가 머지된 master 기준.

자동 테스트(`just test`, `just ui-test`, e2e)는 와이어링과 회귀를 잡지만, "메트릭 표가 1초마다 업데이트되는 게 시각적으로 자연스러운가" 같은 UX 감각은 사람 눈으로만 잡힌다. 새 슬라이스를 머지하기 전, 그리고 컨트롤러/UI 어느 한쪽이라도 만진 PR을 받기 전에 한 번 돌려보길 권장.

---

## 사전 준비

워커 바이너리가 빌드돼 있어야 한다 — 컨트롤러가 run을 실행할 때 서브프로세스로 띄운다.

```bash
cd /Users/sgj/develop/handicap
cargo build -p handicap-worker
```

UI 의존성은 처음 한 번만:

```bash
just ui-install
```

(`pnpm install --frozen-lockfile`을 실행한다. `ui/pnpm-lock.yaml`이 단일 진실이므로 lockfile 없이는 실패함.)

---

## 옵션 A — 프로덕션 형태 (컨트롤러가 빌드된 SPA를 같이 서빙)

K8s에 배포된 상태와 가장 비슷한 형태. `--ui-dir`로 `ui/dist/`를 정적 서빙한다.

```bash
just ui-build              # ui/dist/ 생성
just run-controller-with-ui
```

`run-controller-with-ui` 레시피는 내부적으로:

- `ui/dist/index.html`이 없으면 `just ui-build`를 먼저 돌린다.
- `RUST_LOG=info,handicap=debug`로 컨트롤러 기동.
- 포트: REST 127.0.0.1:8080, gRPC 127.0.0.1:8081.
- `--ui-dir ui/dist`로 SPA 서빙 활성화.

브라우저에서 http://127.0.0.1:8080/ 로 접속하면 끝. `/scenarios/01ABC` 같은 client-side route를 새로고침해도 `index.html`로 fallback 되므로 그대로 동작한다 (Tower-HTTP `ServeDir::fallback` 동작에 의존 — 자세한 건 `crates/controller/src/app.rs`의 SPA fallback 주석과 CLAUDE.md의 슬라이스 2 함정 모음 참조).

---

## 옵션 B — 개발 형태 (Vite dev 서버 + 컨트롤러 분리)

UI 코드 만지면서 즉시 반영(HMR)하고 싶을 때.

**터미널 1** — 컨트롤러만 (UI dir 안 지정):

```bash
cd /Users/sgj/develop/handicap
cargo run -p handicap-controller -- \
  --db ./handicap.db \
  --rest 127.0.0.1:8080 \
  --grpc 127.0.0.1:8081 \
  --worker-bin target/debug/worker
```

**터미널 2** — Vite dev 서버:

```bash
just ui-dev
```

브라우저는 http://127.0.0.1:5173/ 로 접속.

`/api/*` 요청은 Vite가 127.0.0.1:8080으로 자동 프록시한다 (`ui/vite.config.ts`의 `server.proxy`). 즉 같은 origin인 것처럼 동작하므로 CORS / CSP 이슈 없음.

---

## 5단계 클릭스루 (golden path)

옵션 A든 B든 동일하게 다음 흐름이 끝까지 굴러가는지 확인한다.

1. **시나리오 목록 (`/`)** — "No scenarios yet. Create one to get started." 카피만 보여야 함. 우상단에 "New scenario" 버튼.
2. **시나리오 생성 (`/scenarios/new`)** — `STARTER_YAML`이 채워진 textarea가 뜬다. **Create** 버튼을 누르면 자동으로 `/scenarios/{id}` (edit 페이지)로 이동.
3. **시나리오 편집 (`/scenarios/{id}`)** — YAML이 보이고 우상단에 **Runs** 버튼. 누르면 `/scenarios/{id}/runs`로.
4. **시나리오 runs (`/scenarios/{id}/runs`)** — "No runs yet." 카피. 우상단 **Run scenario** 클릭 → 인라인 다이얼로그(모달 아님, 카드 형태)가 뜨고 **VUs=2**, **Duration=3** 정도로 **Run** → `/runs/{run_id}`로 자동 이동.
5. **run 상세 (`/runs/{run_id}`)** — 1초 주기 폴링이 돈다. status가 `pending → running → completed`로 변하는 게 눈에 보여야 함. 종료되면 폴링 멈춤(`refetchInterval`이 `false` 반환). 메트릭 윈도우 테이블에 (second, step, count, errors, status codes) 행이 채워짐.

이 흐름이 끊김 없이 통과하면 controller↔worker↔engine↔UI 파이프라인이 살아있다는 뜻.

---

## CSP / 오프라인 제약 점검 (선택)

ADR-0001대로 사내망/에어갭 staging에서도 동작해야 하므로, 가끔 다음을 확인:

- 브라우저 DevTools → Network 탭 열고, **Offline** 모드로 토글.
- 위 5단계 흐름의 client-side 네비게이션(목록 ↔ 편집 ↔ runs)이 여전히 렌더되어야 함 (React Query 캐시 + React Router는 in-memory).
- `/api/*` 호출만 실패하면서 화면에 에러 카피로 표시됨.
- Network 탭에 컨트롤러 origin 외 호스트로 가는 요청이 **0건**이어야 함. 폰트, 아이콘, 분석 SDK 등 다른 호스트로 새는 요청이 있으면 CSP 위반.

---

## 정리

`Ctrl+C`로 프로세스 종료.

DB 파일(`./handicap.db`, `handicap.db-shm`, `handicap.db-wal`)은 남는다. 다음 기동 시 시나리오/run 데이터가 보존됨. 깨끗하게 시작하려면:

```bash
rm -f handicap.db handicap.db-shm handicap.db-wal
```

---

## 자주 막히는 곳

**404 on `/api/*`** — 컨트롤러가 안 떠 있거나 다른 포트에 떠 있음. 옵션 B 터미널 1에서 `REST listening` 로그 라인 확인.

**404 on `/` (옵션 A)** — `--ui-dir` 인자가 안 들어갔거나 `ui/dist/index.html`이 없음. `just ui-build`부터 다시.

**`Failed to load` 빨간 카피가 페이지에 뜸** — 컨트롤러 stderr를 본다. SQLite 잠금이나 워커 spawn 실패가 흔하다. `RUST_LOG=info,handicap=debug`가 켜져있으면 stack이 잘 잡힌다.

**run이 즉시 `failed`로 떨어짐** — 시나리오 YAML의 `url`이 실제 도달 가능한지 확인. `STARTER_YAML`은 `http://localhost:8080`을 가리키는데, 컨트롤러 자기 자신을 때리면서 assert가 안 맞을 가능성이 높다. 별도 mock 서버(예: `wiremock` 또는 `python3 -m http.server 9000`)를 띄우고 `base_url`을 거기로 바꿔서 다시 만들어보길 권장.

**다이얼로그가 `Starting…`에서 안 넘어감** — gRPC 8081 포트가 막혔거나 워커 바이너리 경로가 틀림. `target/debug/worker`가 실제로 존재하는지 확인 (`cargo build -p handicap-worker` 다시).

**CSP 위반 콘솔 에러** — 누군가 `index.html`이나 컴포넌트에 외부 URL을 박았다는 뜻. `ui/index.html`의 meta CSP 태그가 `default-src 'self'`이므로 외부 호스트 호출은 즉시 차단된다. 의도된 게 아니면 그 PR을 reject.

---

## 참고 파일

- `Justfile`: `ui-install`, `ui-dev`, `ui-build`, `ui-lint`, `ui-test`, `run-controller-with-ui` 정의.
- `ui/vite.config.ts`: `/api` 프록시 타깃.
- `ui/index.html`: CSP meta 태그.
- `crates/controller/src/app.rs`: `--ui-dir` 라우터 와이어링 + SPA fallback 주석.
- `crates/controller/src/main.rs`: `--ui-dir` 플래그 정의 + 시작 시 존재 검증.
- ADR-0001 (사내 QA 1차 사용자), ADR-0009 (라이브 대시보드 제외).

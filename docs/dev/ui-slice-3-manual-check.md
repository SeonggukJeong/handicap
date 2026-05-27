# Slice 3 — 에디터 수동 점검 가이드

Slice 2의 [`ui-manual-check.md`](./ui-manual-check.md)를 보충한다. 5단계 골든패스(시나리오 목록 → 생성 → run → 메트릭) 회귀 확인은 거기서 끝내고, 이 문서는 **Slice 3에서 새로 들어온 것**만 다룬다 — 3패널 에디터, 캔버스, Monaco YAML 에디터, 양방향 sync(코멘트 보존 포함), 더티 플래그.

자동 테스트(`just test`, `just ui-test`)는 모델·스토어·YAML round-trip·디바운스·CSP 메타 태그까지 잡지만, "캔버스 노드를 추가했을 때 화살표가 자연스럽게 따라붙는가", "Monaco가 air-gapped 환경에서 실제로 뜨는가" 같은 것은 사람 눈으로만 잡힌다. Slice 3을 머지하기 전, 그리고 `ui/src/scenario/` 또는 `ui/src/components/scenario/` 어느 한쪽이라도 만진 PR을 받기 전에 한 번 돌려보길 권장.

---

## 사전 준비

워커 바이너리가 빌드돼 있어야 한다 (컨트롤러가 run 실행할 때 서브프로세스로 띄움):

```bash
cd /Users/sgj/develop/handicap
cargo build -p handicap-worker
```

UI 의존성은 처음 한 번:

```bash
just ui-install
```

---

## 띄우는 방법 — 옵션 A / B

Slice 2 매뉴얼과 동일. 짧게:

**옵션 A — 컨트롤러가 빌드된 SPA를 정적 서빙 (프로덕션 형태)**

```bash
just run-controller-with-ui
```

(`ui/dist/index.html`이 없으면 내부에서 `just ui-build`까지 돌아간다. 포트: REST 127.0.0.1:8080, gRPC 127.0.0.1:8081.) 브라우저는 `http://127.0.0.1:8080/`.

**옵션 B — Vite dev 서버 분리 (HMR이 필요할 때)**

터미널 1:

```bash
cd /Users/sgj/develop/handicap
cargo run -p handicap-controller -- \
  --db ./handicap.db \
  --rest 127.0.0.1:8080 \
  --grpc 127.0.0.1:8081 \
  --worker-bin target/debug/worker
```

터미널 2:

```bash
just ui-dev
```

브라우저는 `http://127.0.0.1:5173/`. `/api/*`는 Vite가 컨트롤러로 프록시.

> **Monaco 워커 검증을 하려면 옵션 A를 쓴다.** Vite dev 서버는 워커를 동적 컴파일/blob URL로 다르게 다룰 수 있어서, `worker-src 'self' blob:` CSP 점검은 dist를 컨트롤러가 직접 서빙하는 옵션 A에서 해야 air-gapped 형태와 같다.

---

## 1. 3패널 에디터 — 새 시나리오 진입

- [ ] `New scenario` → `/scenarios/new` 이동.
- [ ] 가운데에 **Canvas / YAML** 탭 바, 왼쪽에 **Variables** 패널, 오른쪽에 Inspector placeholder ("Select a step in the canvas to edit its details.")가 보인다.
- [ ] Canvas는 비어있고 안내 문구가 보임: "Canvas is empty. Click 'Add step' to begin."
- [ ] Variables 패널에 `base_url = http://localhost:8080`가 이미 들어있음 (STARTER_YAML 기본값).

## 2. 캔버스 + Inspector — 노드 추가 / 편집 / 재배치 / 삭제

- [ ] **+ Add step**을 두 번 클릭 → 박스 두 개가 가로로 나란히 뜨고 그 사이에 화살표가 그어진다.
- [ ] 첫 박스 클릭 → 오른쪽 Inspector에 Name / Method / URL / Headers / Body / Assertions 폼이 채워진다.
- [ ] Inspector에서 **Name**을 `login`, **Method**를 `POST`, **URL**을 `{{base_url}}/login`으로 바꿈 → 캔버스 박스 라벨이 즉시 갱신.
- [ ] **Headers** 섹션에서 키 `Content-Type` 입력 → Add → 값 인풋에 `application/json` 입력.
- [ ] **Body** kind 드롭다운을 `json`으로 → textarea에 `{"u":"a"}` 입력 → textarea 바깥 클릭(blur) → 에러가 안 뜨면 모델 반영.
- [ ] **Assertions** 섹션에서 `200` 입력 → Add.
- [ ] 두 번째 박스 클릭 → 같은 방식으로 `Method=GET`, `URL={{base_url}}/me`, assertion `200`.
- [ ] Inspector 헤더의 `↑` `↓` 버튼으로 step 순서를 바꿔본다 — 캔버스 체인이 따라 움직임.
- [ ] **Delete** 누르면 해당 step이 사라지고, 그 step이 선택되어 있었다면 Inspector도 placeholder로 돌아간다.

## 3. YAML 탭 — 직접 편집 + 디바운스 커밋 + 무효 입력 격리

- [ ] **YAML** 탭 클릭. 위에서 만든 두 step이 YAML로 보임:
  - `steps`에 두 항목, 각 ID는 ULID 26자.
  - 첫 step에 `request.headers.Content-Type: application/json`.
  - 첫 step에 `body: { json: { u: "a" } }` 형태.
  - assertion은 `assert: [{ status: 200 }]`.
- [ ] YAML을 직접 편집해서 `{{base_url}}`를 `{{base_url}}/v1`로 모두 바꾼다 → 약 **300 ms** 뒤 자동 커밋(에디터 아래에 빨간 에러가 안 뜸).
- [ ] **Canvas** 탭으로 돌아와 첫 step 클릭 → URL 인풋이 `{{base_url}}/v1/login`로 바뀌어 있다.
- [ ] 다시 YAML 탭에서 `version: 1`을 `version: not a number`로 바꾼다 → 약 300 ms 뒤 에디터 아래에 빨간 에러:
  - `YAML invalid: version: ...`
- [ ] **Canvas** 탭으로 돌아와도 캔버스는 **마지막 valid 상태**(두 step) 그대로 — 모델이 깨지지 않음.
- [ ] YAML 탭으로 돌아오면 무효 텍스트가 그대로 남아있음 (pending buffer 보존, 자동 폐기 안 함).
- [ ] `version: 1`로 되돌리면 에러가 사라지고 정상 커밋.

## 4. 양방향 sync — 코멘트 보존 (가장 중요)

- [ ] YAML 탭에서 첫 step의 `- id: "..."` 줄 위에 코멘트 한 줄을 추가:
  ```yaml
      # production login flow
        - id: "01..."
  ```
- [ ] 약 300 ms 대기 (에디터에 에러 없음).
- [ ] Canvas 탭으로 이동 → 첫 step 클릭 → Name을 `prod-login`으로 바꿈.
- [ ] YAML 탭으로 돌아오면 **`# production login flow` 코멘트가 그대로 살아있어야 한다**.  
  살아있지 않다면 `yamlDoc.ts`의 targeted edit이 깨졌다는 뜻 — 즉시 회귀로 신고.

## 5. Variables 패널

- [ ] 왼쪽 패널 입력란에 `token` 입력 → **Add** → 빈 값 행이 추가됨.
- [ ] 값 칸에 `abc` 입력 → YAML 탭으로 가면 `variables.token: abc`가 보임.
- [ ] 변수 행의 `×` 버튼으로 삭제 → YAML에서도 사라짐.
- [ ] 단, 다른 step의 URL 등에 `{{token}}`이 남아있어도 변수 정의만 사라진다 (템플릿 참조는 그대로). 의도된 동작.

## 6. Save — 더티 플래그 (Slice 3에서 새로 추가됨)

- [ ] 위에서 만든 시나리오를 **Create** 해서 `/scenarios/<id>` 편집 페이지로 들어간다.
- [ ] **새로고침**해서 이 페이지를 깨끗하게 다시 로드한다.
- [ ] 페이지 로드 직후 **Save 버튼이 비활성**이어야 한다.  
  Slice 3 머지 전에는 `yaml` 라이브러리의 재직렬화 정규화 때문에 로드 직후에도 Save가 켜져 있었다 — 첫 EditorShell onChange가 baseline을 seed하도록 고쳤다. 회귀 검증 포인트.
- [ ] Canvas에서 아무 step 이름을 한 글자라도 바꾼다 → **Save 활성화**.
- [ ] Save 클릭 → "Saving…" → 사라짐 → Save가 다시 **비활성**.
- [ ] 새로고침 → 방금 바꾼 이름이 그대로 살아있음 (백엔드 round-trip 성공).
- [ ] 새로고침 후에도 Save가 **비활성**이어야 한다.

## 7. 회귀: run flow가 Slice 2와 동일하게 동작

Slice 2 매뉴얼의 5단계 골든패스가 그대로 통과해야 한다. 시나리오 편집 페이지에서:

- [ ] 우상단 **Runs** → `/scenarios/<id>/runs`.
- [ ] **Run scenario** → 인라인 다이얼로그가 뜨고 **VUs=2, Duration=3**으로 **Run**.
- [ ] 별도 mock 서버(예: `python3 -m http.server 9000`)를 띄워두고, 다이얼로그의 env에 `BASE_URL=http://127.0.0.1:9000`을 채워야 step의 `{{base_url}}` 템플릿이 거기를 가리킨다 (그냥 기본값은 컨트롤러 자기 자신).
- [ ] `/runs/<run_id>`로 이동 → status가 `pending → running → completed`. 1초 주기 메트릭 행이 채워짐. 완료되면 폴링 멈춤.

## 8. CSP / 오프라인 / Monaco 워커 same-origin

ADR-0001 (사내 QA·에어갭 staging 1차 사용자) 제약. Slice 3에서 추가된 검증 포인트는 **Monaco가 CDN으로 새지 않는가**.

- [ ] 옵션 A로 떠 있는지 확인 (`http://127.0.0.1:8080/`).
- [ ] DevTools → **Network** 탭을 열고 초기 로드 → 모든 요청의 도메인이 `127.0.0.1:8080` 한 가지여야 한다.  
  특히 `cdn.jsdelivr.net`, `fonts.googleapis.com`, `unpkg.com` 등이 **단 한 건도 없어야** 한다.
  > 정적 자바스크립트 번들 안에 jsdelivr URL **문자열**은 남아있다 (`@monaco-editor/loader` 1.7.0의 default fallback). 하지만 우리 `MonacoYamlView.tsx`가 모듈 로드 시점에 `loader.config({ monaco })`로 번들된 monaco를 먼저 박아두기 때문에 그 fallback 경로는 실행되지 않는다. **실제 네트워크 요청**이 가지 않으면 OK.
- [ ] 어딘가 step을 만들고 YAML 탭으로 전환 → Monaco가 뜨면 DevTools → **Application** → **Frames**에서 워커 스크립트의 URL을 확인한다. `127.0.0.1:8080/assets/editor.worker-*.js` (또는 `blob:` URL) 만 보여야 한다.
- [ ] DevTools → Network에서 **Offline**으로 토글한 뒤 페이지 내 탭 전환(Canvas ↔ YAML)을 해본다. Monaco가 다시 mount되어도 새 네트워크 요청 없이 렌더되어야 한다.
- [ ] **Console** 탭에 `Content Security Policy`, `worker-src`, `Refused to ...` 류의 빨간 에러가 한 줄도 안 떠야 한다.

## 9. lint / test / build 최종

```bash
just ui-lint
just ui-test
just ui-build
just lint
just test
```

전부 초록. 자동 테스트 카운트는 Slice 3 머지 직후 기준 vitest **60 passing + 26 todo** (15 파일).

---

## 정리

`Ctrl+C`로 모든 프로세스 종료. DB는 `./handicap.db`(+ `-shm`, `-wal`)로 남음. 깨끗하게 시작하려면:

```bash
rm -f handicap.db handicap.db-shm handicap.db-wal
```

---

## 자주 막히는 곳

**YAML 탭으로 갔는데 빈 화면 + 콘솔에 CSP 에러** — `worker-src 'self' blob:`가 `ui/index.html`의 meta CSP 태그에서 빠졌거나, 옵션 A 대신 옵션 B로 띄우고 Vite dev 서버가 워커를 다르게 처리한 경우. 옵션 A로 다시 시도하고, `ui/dist/index.html`을 `grep worker-src`로 확인.

**Monaco는 떴지만 syntax highlighting이 안 됨** — `loader.config({ monaco })`가 모듈 스코프에서 호출되지 않아 `@monaco-editor/react`가 CDN에서 monaco를 가져오려다 CSP에 막혔다는 뜻. Network 탭에 jsdelivr 요청이 보일 것. `MonacoYamlView.tsx` 상단의 `loader.config(...)` 한 줄이 보존됐는지 확인.

**캔버스에서 노드 위치가 이상함 / drag로 옮긴 게 반영 안 됨** — Slice 3은 의도적으로 `draggable: false`, 위치는 step index로 매번 재계산. 변경하려면 `CanvasView.tsx`의 `nodes` useMemo를 손봐야 함.

**Inspector에서 JSON body를 편집했는데 모델에 안 들어감** — `JsonBodyField`는 `onBlur`에서 `JSON.parse` → 성공해야 dispatch. textarea를 떠나기 전에는 반영 안 됨. 의도된 동작.

**Save가 페이지 로드 직후부터 켜져있음** — Slice 3에서 고친 회귀. `ScenarioEditPage.tsx`의 `baselineSeededRef` 로직이 깨졌다는 뜻. 회귀로 신고.

**Canvas 탭에서는 step이 있는데 YAML 탭에서는 빈 `steps: []`로 보임** — `useScenarioEditor` 스토어 dispatch 후 `parseScenarioDoc(serializeDoc(doc))` round-trip이 실패하고 있다는 뜻. 콘솔 또는 에디터 아래 에러 확인.

**run 다이얼로그 `Starting…`에서 안 넘어감** — Slice 2 매뉴얼의 동명 항목 참조 (gRPC 8081 / worker 바이너리 경로).

---

## 참고 파일

- `Justfile`: `run-controller-with-ui`, `ui-dev`, `ui-build` 등.
- `ui/index.html`: CSP meta 태그 — `default-src 'self'; ... worker-src 'self' blob:;`.
- `ui/vite.config.ts`: `/api` 프록시 + Monaco `optimizeDeps` + `worker: { format: "es" }`.
- `ui/vitest.config.ts`: vitest 전용 `workerQueryPlugin` (테스트가 `?worker` import를 처리하기 위한 우회).
- `ui/src/scenario/`: 모델 / ULID / YAML round-trip / Zustand 스토어 — Slice 3의 데이터 계층.
- `ui/src/components/scenario/`: TabBar, VariablesPanel, HttpStepNode, CanvasView, Inspector, MonacoYamlView, EditorShell.
- `ui/src/pages/ScenarioEditPage.tsx`: `baselineSeededRef` 더티 플래그 시드 로직.
- CLAUDE.md의 "Slice 3에서 배운 함정들" 섹션 — 위 자주 막히는 곳들의 배경 설명.
- ADR-0001 (사내 QA 1차 사용자), ADR-0003 (양방향 sync UX), ADR-0015 (Zustand + Zod + YAML AST round-trip).

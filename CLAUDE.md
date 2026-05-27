# Handicap

사내 QA·운영팀을 위한 부하 테스트 도구. REST API를 대상으로, **QA는 드래그-드롭으로 시나리오를 만들고**, **개발자는 같은 시나리오를 YAML/DSL로 편집** 한다 (두 뷰가 같은 모델의 양방향 sync). LoadRunner/JMeter를 사내에서 대체하는 것이 목표.

**상태: Slice 3(캔버스 + Monaco + 양방향 sync) 구현 완료.** 디자인 문서 → `docs/superpowers/specs/`. 구현 계획 → `docs/superpowers/plans/`. 결정 기록 → `docs/adr/`.

Slice 1 결과: REST API(`/api/scenarios`, `/api/runs`, `/api/runs/{id}/metrics`) + gRPC Coordinator(bidi stream) + SQLite store + subprocess-spawn worker가 wiremock 타겟에 대해 end-to-end 동작.

Slice 2 결과: Vite + React + TS + Tailwind UI (`ui/`). 시나리오 목록·생성·편집(YAML textarea), run 다이얼로그, run 상세(1초 폴링 + 메트릭 표). 컨트롤러가 `--ui-dir` 경로의 SPA를 정적 서빙(unknown path는 index.html로 fallback). 캔버스·Monaco·양방향 sync는 Slice 3, 차트·HTML 리포트는 Slice 5, multi-step·extract·ramp-up은 Slice 4, K8s 배포는 Slice 6.

Slice 3 결과: React Flow 캔버스(HTTP 노드 1종, 선형 chain, drag-drop add, inspector) + Monaco YAML 에디터(syntax highlighting only) + Zustand store + Zod 검증 + `yaml` 패키지 Document API targeted edit. 양방향 sync는 탭 전환 모델: 캔버스/YAML 둘 중 하나가 active. Monaco 편집은 300ms debounce → 검증 통과 시 doc swap, 실패 시 pendingYamlText에 유지하고 inline 에러 표시. extract/multi-step variable chaining은 Slice 4, K8s 배포는 Slice 6.

라이브 대시보드는 MVP 범위 자체에서 제외(ADR-0009 — 종료 후 HTML/JSON 리포트로 충분, 실시간은 APM 사용).

## 한 줄 아키텍처

Rust 엔진(컨트롤러 + 워커, K8s Pod로 배포) + TypeScript/React 웹 UI. 워커가 컨트롤러에서 시나리오를 받아 실행하고, 종료 후 상세 HTML/JSON 리포트 생성. 라이브 대시보드 없음 (APM 사용).

## 일하는 모드

| 모드 | 언제 | 방법 |
|---|---|---|
| **로컬 dev** (빠른 반복) | 일상 코딩 | 별도 터미널에서 `cargo run --bin controller` 와 `cargo run --bin worker`. UI: `cd ui && pnpm dev`. K8s 띄우지 않음. |
| **kind 통합 테스트** | 매니페스트·배포 형상 변경 시 | `kind create cluster` → `just deploy-kind` (Helm chart) |
| **프로덕션** | 사내 K8s 도입 후 | upstream Kubernetes에 Helm 배포 |

**로컬 dev에서 docker-compose나 k3s를 쓰지 말 것.** 이유는 [ADR-0007](docs/adr/0007-local-k8s-kind-not-k3s.md).

## 개발 환경 세팅

처음 클론한 머신에서:

```bash
# Rust toolchain (workspace는 edition 2024 + MSRV 1.85)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
  --default-toolchain stable --component rustfmt --component clippy
. "$HOME/.cargo/env"

# protoc (tonic-build이 빌드 타임에 사용) + just (태스크 러너)
brew install protobuf just

# 확인
cargo --version && rustc --version && protoc --version && just --version

# 슬라이스 1 acceptance
just build && just lint && just test     # 18 tests must pass
```

`rust-toolchain.toml`이 stable 채널을 고정하므로 `cargo` 호출만 해도 올바른 toolchain을 잡는다.

## 검증 자동화 (Git + Claude hooks)

`.git/hooks/pre-commit`이 모든 커밋에 대해 `cargo fmt --check + cargo build --workspace + cargo test --workspace`를 실행한다 (워크스페이스가 coherent하지 않으면 per-crate 모드로 fallback). hook은 git common dir에 있어 모든 worktree에 적용된다. 새 머신에서는 `chmod +x .git/hooks/pre-commit`이 한 번 필요할 수 있다.

`.claude/hooks/tdd-guard.sh`는 Claude의 PreToolUse 훅으로, Write/Edit가 `crates/*/src/*.rs` 또는 `ui/src/*.{ts,tsx,js,jsx}`를 만지려 할 때 작업트리에 pending test 파일(`tests/*.rs`, `*_test.rs`, `*.test.{ts,tsx}`, `*.spec.{ts,tsx}`, `__tests__/*`)이 하나도 없으면 차단한다. UI scaffolding처럼 그 작업 단위에 실제 동작 테스트가 없을 때는 `ui/src/__tests__/<name>.test.tsx`에 `it.todo("...")` 한 줄을 먼저 적어 pending diff를 만든 다음 production 파일을 작성하는 게 표준 패턴 — 진짜 테스트는 그 슬라이스의 testing 단계(예: Slice 2 Task 13)에서 채운다. 인라인 `#[cfg(test)] mod tests`가 있는 Rust 파일은 자동으로 통과.

`--no-verify`로 hook 우회 금지 (사용자 명시 요청 없이는). 회귀가 생긴 채로 커밋이 들어가면 후속 작업이 모두 빨갛게 됨.

## 디렉토리 (MVP 계획)

```
crates/
  engine/        Rust 부하 생성 엔진 (라이브러리)
  controller/    Rust 바이너리, 워커 오케스트레이션, HTTP API 서빙
  worker/        Rust 바이너리, 컨트롤러 지시로 시나리오 실행
  proto/         gRPC 정의 (controller↔worker)
ui/              TypeScript/React 웹앱 (Vite + React Flow + Monaco)
deploy/
  helm/          K8s 배포용 Helm chart
  kind/          로컬 kind cluster 설정
docs/
  superpowers/specs/   설계 문서
  dev/                 개발자 runbook (UI 수동 점검 등)
  adr/                 결정 기록 (MADR 포맷)
```

## 알아둘 결정들

전체 컨텍스트는 `docs/adr/`. 빠른 인덱스:

- **0001** 1차 사용자: 사내 QA (OSS·SaaS 아님)
- **0002** 프로토콜: REST API/JSON 우선, WebSocket/gRPC 후속
- **0003** UX 모델: GUI ↔ Code 양방향 sync (드래그-드롭 + YAML 두 뷰)
- **0004** 엔진 언어: Rust (Go/Node/JVM 거절)
- **0005** UI 스택: TypeScript/React
- **0006** 배포 타겟: upstream Kubernetes (사내 도입 대기)
- **0007** 로컬 K8s: kind (k3s 거절)
- **0008** MVP 전략: 수직 슬라이스 (엔진 우선·UI 우선 거절)
- **0009** MVP에 라이브 대시보드 없음
- **0010** Controller ↔ Worker: gRPC bidi stream, 워커 pull/등록 모델
- **0011** MVP 저장소: SQLite (HA·대용량 시 PostgreSQL 마이그레이션)
- **0012** 워커가 메트릭 사전 집계 (1초 윈도우, HDR Histogram)
- **0013** Scenario와 Run Config 분리 (시나리오는 git/YAML, run config는 DB)
- **0014** 변수 표기 분리: `{{var}}` 흐름, `${ENV}` 환경, `${vu_id}` 시스템
- **0015** 양방향 sync 구현: Zustand store + Zod 검증 + YAML AST round-trip
- **0016** VU 실행 모델: tokio task per VU (OS 스레드/work-stealing 아님)
- **0017** MVP 리포트: 1s 시계열 + 스텝별 + status 분포 (run간 비교·SLA는 후속)
- **0018** VU별 자동 cookie jar — 세션(쿠키)·토큰(JWT) 인증 둘 다 지원

## 코딩 컨벤션

- **Rust**: `cargo fmt`, `cargo clippy -- -D warnings`, 테스트 `cargo test`. workspace `members = ["crates/*"]` glob — 새 crate는 `crates/<name>/Cargo.toml`만 만들면 자동 인식.
- **TypeScript**: prettier + eslint, 테스트 vitest

## Slice 1에서 배운 함정들

- **axum 0.8 path syntax**: `/scenarios/:id` 아님, `/scenarios/{id}`. 0.7 문서/예제 검색하면 함정.
- **serde_yaml 0.9 + externally-tagged enum w/ map variants**: derive(Serialize, Deserialize)가 round-trip 안 됨. `Assertion::Status(u16)`, `Body::{Json|Form|Raw}` 같은 enum은 손수 `Serialize`/`Deserialize` 구현해서 `{key: value}` 맵 형태로 처리. derive 그대로 두면 직렬화 시 `!variant value` YAML 태그가 나오고, 사용자/UI가 만든 `{variant: value}` 맵을 역직렬화하려 하면 `invalid type: map, expected a YAML tag starting with '!'` 에러. Slice 1 fixture에 body가 없어서 Body 쪽은 Slice 3 UI(BodyEditor)가 처음 트리거할 때까지 잠복. **새 enum 추가할 때마다 이 패턴 확인.** (`crates/engine/src/scenario.rs::{Assertion, Body}` 참고.)
- **mpsc 플러셔 종료**: 워커 self-cloned `Sender`를 가진 flusher 태스크는 `is_closed()`로 종료 감지가 안 된다 (자기 자신이 살아있으니까). 메인 루프가 끝나면 `flusher.abort()` 후 `flusher.await.ok()`. (`crates/engine/src/runner.rs::run_scenario` 참고.)
- **tonic `Channel::from_shared` 오류 타입**: `tonic::transport::Error` 아니라 `tonic::codegen::http::uri::InvalidUri`. WorkerError에 따로 variant 필요.
- **tokio JoinHandle drop ≠ abort**: handle을 drop해도 spawn된 task는 detached로 계속 돈다. 종료시키려면 명시적으로 `.abort()`.

## Slice 2에서 배운 함정들

- **axum 0.8 `nest` + `with_state`**: state는 outer router에 한 번만 붙인다. 안쪽 router에 `with_state`를 두 번 붙이면 컴파일은 되지만 nested router가 state를 못 봄.
- **`ServeDir::fallback` vs `not_found_service`**: SPA를 axum 0.8 + tower-http 0.6에서 띄울 때 핵심 함정. 두 메서드 모두 같은 fallback service를 호출하지만, `not_found_service`는 내부적으로 `SetStatus<_, 404>`로 감싸서 fallback이 반환하는 status code를 무조건 404로 덮어쓴다. 즉 ServeFile이 index.html을 200으로 돌려줘도 브라우저는 404를 본다 → React Router의 hard-refresh가 깨지고 에러 모니터가 4xx로 인식. **`ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html")))`** 로 써야 inner ServeFile의 200이 그대로 전달된다. `ServeDir::append_index_html_on_directories`(기본 true)가 `/` → `index.html`을 처리해주므로 root는 따로 안 다뤄도 됨. (`crates/controller/src/app.rs` 내 load-bearing 주석 참고.)
- **React Query v5 `refetchInterval`의 시그니처**: `(query) => number | false`. `query.state.data`로 마지막 데이터에 접근. 4.x의 `(data) => ...` 시그니처와 다르니 마이그레이션 가이드 검색 시 주의.
- **`pnpm install --frozen-lockfile` in CI**: `pnpm-lock.yaml`을 반드시 커밋해야 함. 안 하면 CI가 `ERR_PNPM_NO_LOCKFILE`로 실패.
- **TDD-guard 훅의 worktree 인식**: `.claude/hooks/tdd-guard.sh`는 편집되는 파일의 디렉터리에서 `git rev-parse --show-toplevel`로 working tree를 찾는다. 그래서 worktree 안에서 작업해도 pending test 검사가 worktree의 working tree를 보고, primary checkout의 working tree와 혼선이 없다. (Slice 2 작업 초기에 hook이 worktree를 못 봐서 패치함.)
- **`/api` 프리픽스로 옮긴 이유**: SPA가 `/scenarios/:id` 같은 client-side route를 갖기 때문에 REST 경로와 충돌. 슬라이스 1 테스트도 함께 업데이트해야 통과.
- **오프라인 런타임 제약**: 사내망/에어갭 staging에서도 UI가 떠야 한다 (ADR-0001 — 1차 사용자 사내 QA). 그래서 `index.html`에 `Content-Security-Policy` 메타 태그로 `default-src 'self'` 강제, Tailwind 기본 시스템 폰트 스택만 사용 (Google Fonts 같은 CDN 폰트 금지), 외부 아이콘·스크립트 패키지 도입 시에도 npm 번들로만. 어기면 CSP가 브라우저 콘솔에서 즉시 실패시키므로 회귀가 조용히 들어오지 않는다. 향후 폰트 커스텀 필요하면 `@fontsource/*` 같은 로컬 번들 패키지로.

## Slice 3에서 배운 함정들

- **`@xyflow/react` v12의 패키지 이름 변경**: 이전 `reactflow` 패키지가 `@xyflow/react`로 rename. import 경로도 `@xyflow/react` + `@xyflow/react/dist/style.css`. v11 예제는 함정.
- **`@xyflow/react` v12의 `NodeProps` 시그니처**: v11의 `NodeProps<Data>` 가 아니라 `NodeProps<Node<Data, "type-string">>` 형태. `node_modules/@xyflow/react/dist/esm/types/index.d.ts` 확인 후 맞춰야 함.
- **`@monaco-editor/react`는 기본적으로 JSDelivr에서 monaco를 fetch**: 오프라인 런타임 제약을 어김. 반드시 `loader.config({ monaco })` 로 로컬 번들을 강제. 안 그러면 dev에서는 동작하지만 air-gapped staging에서 흰 화면. 빌드된 dist에는 jsdelivr URL 문자열이 dead code로 남지만 (loader 1.7.0 default), `loader.config({monaco})`가 init 전에 state.monaco를 채워두므로 fetch 분기는 도달 불가능.
- **Monaco 워커는 Vite의 `?worker` import로 등록**: `import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker"` + `self.MonacoEnvironment.getWorker = () => new editorWorker()`. 이 등록을 모듈 스코프에서 해야 첫 mount 이전에 실행됨. 컴포넌트 안에 useEffect로 두면 race.
- **Vitest는 `?worker` 쿼리를 Vite처럼 처리하지 못함**: 별도 worker query plugin이 vitest.config.ts에 필요. resolveId 훅으로 `?worker` 접미사를 strip하고 일반 모듈로 넘기는 식. `vi.mock("...editor.worker?worker", ...)`는 위 plugin 없이는 안 듣는다.
- **Vite `resolve.alias`의 string key prefix matching 함정**: `{ "monaco-editor": "/path/to/api.js" }` 는 `monaco-editor/esm/...` 도 매칭해서 ENOTDIR 에러를 낸다. 정확히 패키지명만 잡으려면 regex form: `{ find: /^monaco-editor$/, replacement: "..." }`.
- **CSP `worker-src` 필요**: `default-src 'self'`만 있으면 Chrome이 module worker를 blob: URL로 만들 때 차단할 수 있다. `worker-src 'self' blob:`로 명시. style-src의 unsafe-inline은 Slice 2부터 이미 있음.
- **`yaml` 패키지 Document API의 targeted edit으로 코멘트 보존**: `doc.setIn(['steps', 0, 'request', 'method'], 'POST')` 식으로 부분 수정 시 다른 키 옆 코멘트 그대로 유지. 단, `steps[i]`를 통째로 교체하면 그 안의 모든 코멘트는 사라진다 — `addStep`/`removeStep`/`moveStep`은 그 한도에서 동작 (§2.8의 한계 그대로).
- **`yaml` 패키지의 `doc.setIn(["name"], value)`은 기존 노드의 quote style을 상속**: 원본이 `name: "demo"`였으면 새 값도 `"renamed"`로 quote가 붙는다. 테스트가 unquoted를 기대하면 `Scalar.PLAIN`을 새로 만들어 setIn. `plainScalar()` 헬퍼 참고 (`ui/src/scenario/yamlDoc.ts`).
- **`extract` 키 보존**: TS 모델 (`ScenarioModel`)은 `.strict()`로 `extract`를 거부하지만, `normalizeForModel`이 doc.toJS() 후 모델 입력 단계에서 `extract`를 떨궈 검증을 통과시킨다. 원본 Doc은 그대로 — round-trip 시 `extract`가 유지됨. Slice 4에서 `extract`를 모델에 추가할 때 이 노멀라이저만 손보면 된다.
- **Zod `.strict()` + `default()`의 조합**: `.strict()`가 `default()`로 채워진 키를 거부하지 않는다 — default는 input 단계에서 적용되고 strict는 unknown 키 검사이므로 충돌 없음. 헷갈리지 말 것.
- **Zustand v5는 getInitialState 미제공**: 테스트에서 store를 reset하려면 직접 INITIAL 객체를 보관하고 setState로 덮어쓰는 작은 헬퍼가 필요. 액션 ref는 v5에서 stable하므로 모듈 로드 시 한 번만 `getState()`로 캡쳐하면 된다.
- **React Flow의 control vs uncontrolled**: 노드 위치를 직접 계산해서 넘기면 React Flow 안에서 drag로 옮긴 위치는 반영되지 않는다. Slice 3은 의도적으로 drag 비활성화(`draggable: false`) — 위치는 매번 재계산됨.
- **`removeStep`은 selection clear가 dispatch보다 먼저**: 순서를 반대로 하면 subscriber가 잠깐 "삭제된 step을 가리키는 selectedStepId" 상태를 본다 → Inspector가 stale step을 deref. 그래서 store action에서 `if (get().selectedStepId === stepId) set({ selectedStepId: null })`를 dispatch보다 먼저 호출.

## 새로운 아키텍처 결정이 생기면

`docs/adr/`에 새 ADR 파일 추가 (다음 번호 사용, MADR 포맷). 이 CLAUDE.md의 "알아둘 결정들" 목록에도 한 줄 추가.

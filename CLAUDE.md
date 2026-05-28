# Handicap

사내 QA·운영팀을 위한 부하 테스트 도구. REST API를 대상으로, **QA는 드래그-드롭으로 시나리오를 만들고**, **개발자는 같은 시나리오를 YAML/DSL로 편집** 한다 (두 뷰가 같은 모델의 양방향 sync). LoadRunner/JMeter를 사내에서 대체하는 것이 목표.

**상태: Slice 4(extract + 변수 체이닝 + ${ENV} + ramp-up + abort) 구현 완료.** 디자인 문서 → `docs/superpowers/specs/`. 구현 계획 → `docs/superpowers/plans/`. 결정 기록 → `docs/adr/`.

Slice 1 결과: REST API(`/api/scenarios`, `/api/runs`, `/api/runs/{id}/metrics`) + gRPC Coordinator(bidi stream) + SQLite store + subprocess-spawn worker가 wiremock 타겟에 대해 end-to-end 동작.

Slice 2 결과: Vite + React + TS + Tailwind UI (`ui/`). 시나리오 목록·생성·편집(YAML textarea), run 다이얼로그, run 상세(1초 폴링 + 메트릭 표). 컨트롤러가 `--ui-dir` 경로의 SPA를 정적 서빙(unknown path는 index.html로 fallback). 캔버스·Monaco·양방향 sync는 Slice 3, 차트·HTML 리포트는 Slice 5, multi-step·extract·ramp-up은 Slice 4, K8s 배포는 Slice 6.

Slice 3 결과: React Flow 캔버스(HTTP 노드 1종, 선형 chain, drag-drop add, inspector) + Monaco YAML 에디터(syntax highlighting only) + Zustand store + Zod 검증 + `yaml` 패키지 Document API targeted edit. 양방향 sync는 탭 전환 모델: 캔버스/YAML 둘 중 하나가 active. Monaco 편집은 300ms debounce → 검증 통과 시 doc swap, 실패 시 pendingYamlText에 유지하고 inline 에러 표시. extract/multi-step variable chaining은 Slice 4, K8s 배포는 Slice 6.

Slice 4 결과: 엔진이 multi-step extract(JSONPath body / header / cookie / status)와 ${ENV:-default} 템플릿, 1초 단위 linear ramp-up, CancellationToken 기반 abort를 지원. 컨트롤러 `POST /api/runs/{id}/abort` → 워커가 in-flight run 취소. UI Inspector에 ExtractEditor, RunDetail에 Abort 버튼. 테스트: Rust unit + wiremock multi-step integration + proptest properties, UI RTL + fast-check round-trip. K8s 배포는 Slice 6, 차트·HTML 리포트는 Slice 5.

Slice 4 post-merge manual check: `RunDialog`가 `env`·`ramp_up_seconds`를 하드코딩하던 UI 갭을 메우고(M1), Run 상세에 Steps/Env/Profile 진단 패널을 추가(M2), 시나리오 URL을 env로 풀어 표시하는 client-side `resolveForDisplay` 도입(M3). 매뉴얼에 wiremock stub 등록 절차 명시(M4). 자세한 내용 → `docs/superpowers/plans/2026-05-28-slice-4-manual-check-fixes.md`.

Slice 5 결과: 종료된 run의 same-page Report 전환. Controller `GET /api/runs/{id}/report` 가 run + scenario_yaml snapshot + per-second windows(percentile 포함) + per-step + status 분포를 한 번에 번들. 엔진 `percentiles.rs` 가 V2 HDR Histogram BLOB을 deserialize + merge. UI Recharts (line/bar) + Summary + StepStatsTable + ScenarioSnapshot + JSON download. e2e `report_e2e_smoke` 가 워커 subprocess → 컨트롤러 → report 까지 검증. K8s 배포(Slice 6)는 아직.

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

`.git/hooks/pre-commit`이 모든 커밋에 대해 `cargo fmt --check + cargo build --workspace + cargo clippy --workspace --all-targets -- -D warnings + cargo test --workspace`를 실행한다 (워크스페이스가 coherent하지 않으면 per-crate 모드로 fallback). hook은 git common dir에 있어 모든 worktree에 적용된다. 새 머신에서는 `chmod +x .git/hooks/pre-commit`이 한 번 필요할 수 있다. Slice 4 후속에서 clippy gate가 추가됨 — `next_spawn += ...` 같은 `assign_op_pattern` 회귀가 prod로 안 들어오게 차단. **워크트리 안에서 `.git`은 디렉토리가 아니라 파일**이라 `.git/hooks/pre-commit`을 직접 호출하면 "Not a directory" — `bash $(git rev-parse --git-common-dir)/hooks/pre-commit`로 절대 경로 풀어 실행.

`.claude/hooks/tdd-guard.sh`는 Claude의 PreToolUse 훅으로, Write/Edit가 `crates/*/src/*.rs` 또는 `ui/src/*.{ts,tsx,js,jsx}`를 만지려 할 때 작업트리에 pending test 파일(`tests/*.rs`, `*_test.rs`, `*.test.{ts,tsx}`, `*.spec.{ts,tsx}`, `__tests__/*`)이 하나도 없으면 차단한다. UI scaffolding처럼 그 작업 단위에 실제 동작 테스트가 없을 때는 `ui/src/__tests__/<name>.test.tsx`에 `it.todo("...")` 한 줄을 먼저 적어 pending diff를 만든 다음 production 파일을 작성하는 게 표준 패턴 — 진짜 테스트는 그 슬라이스의 testing 단계(예: Slice 2 Task 13)에서 채운다. 인라인 `#[cfg(test)] mod tests`가 있는 Rust 파일은 자동으로 통과. **Rust 쪽도 같은 stub 패턴 사용 가능** — production 변경이 큰데 인라인 test가 없을 때 `crates/<x>/tests/<feature>_wiring.rs`에 컴파일만 되는 placeholder를 먼저 만들면 guard 통과 (Slice 4 본체에서 5회 사용). 다만 작업이 끝나면 인라인 `mod tests`로 정리하는 게 깔끔.

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
- **0019** Worker dispatcher 추상화 (subprocess local-dev / K8s Job prod)

## 코딩 컨벤션

- **Rust**: `cargo fmt`, `cargo clippy -- -D warnings`, 테스트 `cargo test`. workspace `members = ["crates/*"]` glob — 새 crate는 `crates/<name>/Cargo.toml`만 만들면 자동 인식.
- **TypeScript**: prettier + eslint, 테스트 vitest. **`pnpm build`(`tsc -b && vite build`)가 최종 게이트** — `pnpm test`(jsdom + esbuild transpile)는 TS strict 에러를 안 잡는 경우가 있다. 예: `fc.constantFrom("GET","POST",...)`는 런타임에 동작하지만 `Arbitrary<string>`으로 widening돼서 discriminated union과 안 맞아 `tsc -b`에서 깨짐 → 각 인자에 `as const` 또는 명시적 `fc.Arbitrary<"GET"|"POST"|...>` 선언. UI 변경 commit 전 `pnpm build`까지 한 번 돌리는 게 안전.

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
- **`yaml` 라이브러리 재직렬화의 dirty-flag false positive**: `parseDocument(text)` → `String(doc)` 이 들여쓰기·인용을 정규화한다 (예: 평탄 list `- a`를 `  - a`로). 따라서 `originalText !== currentText` 단순 비교로 dirty를 판단하면, EditorShell mount 직후 첫 onChange가 정규화된 텍스트를 푸시하는 순간 dirty=true가 된다 (사용자가 한 글자도 안 쳤는데 Save 활성). 해결: `originalYaml`을 prop이 아니라 **EditorShell의 첫 onChange 콜백에서 seed** 한다 (ref 플래그로 1회만). 저장 성공 시는 server canonical(`next.yaml`)로 다시 seed. (`ui/src/pages/ScenarioEditPage.tsx::baselineSeededRef` 참고.)

## Slice 4에서 배운 함정들

- **serde_yaml 0.9 + internally-tagged enum w/ struct variants은 round-trip OK**: Slice 1에서 외부 태그(externally-tagged) map-shape enum이 깨지는 버그가 있었지만 (`Body`, `Assertion`), `#[serde(tag = "from")]` 형태의 internally-tagged + struct 변형은 정상 동작. `Extract`는 이 패턴으로 모델링.
- **`reqwest::Response::cookies()` vs Set-Cookie 헤더 직접 읽기**: 자동 쿠키 jar가 활성화돼도 응답의 raw Set-Cookie 헤더는 그대로 노출된다. 우리는 `from: cookie` extract에서 raw Set-Cookie 헤더를 파싱(첫 `key=value` 페어)한다 — jar에서 끄집어내려고 하면 reqwest 내부 jar 인터페이스가 stable하지 않음.
- **JSONPath 라이브러리 선택**: `serde_json_path` (RFC 9535 compliant). `jsonpath-rust`는 의존성이 더 무겁고 API가 변동적. `JsonPath::parse(path).query(json).first()` 패턴이면 충분.
- **`u32::div_ceil`은 Rust 1.79+**: workspace MSRV 1.85라 OK. `ceil_div(a, b)` 헬퍼를 손수 작성할 필요 없음.
- **CancellationToken은 `tokio_util::sync` 모듈에서**: tonic이 transitively 가져오긴 하지만 dev에 명시적으로 의존 추가하는 게 안전 (tonic minor 업데이트로 token 사라질 위험 회피).
- **Ramp-up 테스트의 flakiness 한계**: 1초 윈도우 단위에서 "first window count < later window count" 검증은 환경 부하에 민감. 매 초마다 정확히 `floor(target/ramp)` VU spawn을 검사하지 말고 monotonic non-decreasing trend만 검사.
- **`@testing-library/react` + Zustand의 store reset 패턴**: 각 `it` 전에 `useScenarioEditor.setState(useScenarioEditor.getInitialState())`로 초기화. RTL는 React 트리만 재마운트하므로 모듈 스코프 store는 직접 비워야 한다.
- **`fast-check` + Vitest의 default `numRuns`**: 100. CI 시간을 아끼려고 우리는 round-trip 프로퍼티에서 40으로 줄였다. 의도적 — 셔링크 발생 시 numRuns를 다시 올려 재현.
- **userEvent.setup()를 it마다 호출**: v14에서 글로벌 default user-event는 deprecated. 매 테스트에서 `const user = userEvent.setup()` 명시.
- **`@monaco-editor/react` & `vitest` 환경에서 `?worker` 임포트**: Slice 3 vitest.config.ts의 `workerQueryPlugin`이 Slice 4 RTL 테스트에서도 그대로 사용된다 — Inspector / RunDetail은 Monaco를 직접 마운트하지 않으므로 worker 모킹은 불필요.
- **`PATCH /scenarios/{id}` 의 optimistic lock과 Slice 4 extract 변경**: extract만 바뀌어도 yamlText가 달라지므로 dirty 플래그가 켜진다. EditorShell의 baselineSeededRef 패턴이 그대로 적용되어 추가 작업 없음 — 단 회귀 점검은 manual check §1에서 한 번 한다.
- **abort 흐름의 belt-and-suspenders는 의도된 중복**: REST endpoint가 DB에 'aborted'를 찍고 (Task 10), worker는 `EngineError::Aborted`를 `Phase::Aborted`로 보내고 (F3), `set_status` SQL은 `WHERE status != 'aborted'` guard를 가진다 (Task 10 fix). 두 메커니즘은 서로 다른 실패 모드를 막는다 — REST 경로는 worker가 닿지 않을 때 (crash, network 단절)도 abort UX가 동작하게 하고, gRPC 경로는 worker가 자기 상태를 정확히 보고할 수 있게 한다. e2e 테스트로 회귀를 잡으려면 두 safeguard를 동시에 깨야 RED가 난다 — 단일 safeguard 회귀는 다른 쪽이 막아준다. (`docs/superpowers/plans/2026-05-28-slice-4-follow-ups.md` F4 참고.)
- **gRPC bidi stream의 클린 셧다운 = mpsc drain ≠ wire deliver**: `tx.send().await`는 채널 버퍼 진입만 보장, wire 전송은 아니다. tokio runtime이 main 종료로 spawn된 task를 cancel하면 tonic 내부 송신 머신도 함께 죽어 HTTP/2 END_STREAM이 안 나간다. 패턴: 마지막 메시지 send → `drop(tx)` (outbound EOF 신호) → 상대가 우리 EOF 보고 자기 쪽 close → 우리 `inbound_fwd.await` 완료 시점이 곧 "far end가 처리 완료" sync point. 200ms `sleep` 같은 fixed delay는 둘 다 race-prone하고 슬로우 (F6 참고).
- **clippy를 pre-commit에 안 넣으면 `assign_op_pattern`/`expect_fun_call` 같은 게 prod에 들어간다**: Slice 4에서 두 번 일어남. Follow-up F2에서 hook에 `cargo clippy --workspace --all-targets -- -D warnings` 추가. 단위/integration 테스트가 모두 통과해도 clippy가 다른 클래스의 문제를 잡으니 비용 대비 가치 좋음.
- **UI editor의 commit timing이 dirty-flag 휴리스틱과 결합**: Slice 3의 `baselineSeededRef`가 매 키 입력마다 yamlText diff를 보면 거짓 dirty가 뜬다. 동시에 partial-row가 Zod validation을 잠시 fail해서 yamlText에서 "깜빡"한다. 해법: input의 commit은 onBlur (또는 구조적 변경 시 즉시), 로컬 state는 onChange로 즉시 갱신. (F5의 `ExtractEditor`가 표준 패턴 — 다음 슬라이스의 새 editor도 따라가야 함.)
- **proto enum 값 추가는 backward-compat 안전**: F3에서 `Phase::ABORTED = 4` 추가. 기존 클라이언트가 새 값을 모르면 `unspecified`로 떨어진다. 새 값을 모르는 worker → 새 controller 조합은 일어날 일이 없고, 새 worker → 옛 controller도 마찬가지(우리는 둘을 같이 배포). 새 phase가 필요하면 그냥 추가.
- **plan에 있던 UI 갭이 manual check에서 처음 드러나는 패턴**: Slice 4 plan은 ramp_up/env를 엔진·controller·proto에 다 넣었지만 `RunDialog`가 두 값을 하드코딩(`ramp_up_seconds: 0`, `env: {}`)으로 보내고 있었다. 단위/통합 테스트는 백엔드만 검증해서 회귀가 안 잡혔고, 매뉴얼 §1·§3을 실제로 돌리는 단계에서 발견. 다음 슬라이스부터 새 런타임 옵션이 추가될 때마다 **RunDialog 입력 + 페이로드까지 같은 task 단위로 묶어서** 미루지 말 것. (M1 참고.)
- **엔진과 UI에 같은 템플릿 문법을 두 번 구현**: 엔진 `crates/engine/src/template.rs`는 runtime/엄격, UI `ui/src/scenario/template.ts::resolveForDisplay`는 display/관대(미해결 토큰은 그대로 둠). Run 상세 화면이 시나리오 원본 `${BASE_URL}/login`을 그대로 보여주면 사용자가 "env가 안 들어간 듯" 오해하기에 도입. 새 토큰(`${session_id}` 등)이나 새 문법을 엔진에 추가하면 **반드시 UI resolver도 동시에**, 아니면 진단 표시가 거짓말을 한다. (M3 참고.)
- **key-value 입력 폼은 한 칸짜리 add row를 만들지 말 것**: RunDialog의 Env 입력 1차 구현이 placeholder="BASE_URL" 한 칸 + Add였는데, 사용자가 URL을 키 칸에 통째로 적어 `key=http://..., value=""`라는 잘못된 entry를 만들었다 (M5). 두 칸 동시 입력 + key 비어있으면 Add disabled가 표준. `VariablesPanel`은 이미 이 패턴이었는데 RunDialog만 빠져 있었음.
- **Run 상세 화면의 step_id 진단성**: ULID만 보이면 점검자가 어떤 URL을 때리는지 모른다. 시나리오 YAML을 같이 fetch해서 `step.id → {name, method, url}`로 매핑하고 URL은 `resolveForDisplay`로 풀어 표시하면 status 0 같은 비정상 상태에서 root cause(시나리오 설정 vs connectivity) 분간이 한 화면에서 가능해진다. (M2 참고.)
- **status=0 + 비정상적으로 높은 RPS = HTTP 도달 전 단계 실패**: connection refused / URL parse / DNS 등 fail-fast. 진짜 5xx는 RPS가 정상 범위(타겟이 답을 주긴 함). 매뉴얼 §1 점검에서 3번 마주침 — 시나리오 URL이 host 없는 `/login`인지, wiremock이 죽었는지, env가 빈 채로 `${BASE_URL}`이 unresolved인지 순서로 확인.
- **Zod 중첩 `.default()`의 input 타입 누출**: `ProfileSchema.ramp_up_seconds: z.number().default(0)`이 output에선 `number`지만, `RunSchema.profile`로 nested되면 부모의 `z.infer`에서 `number | undefined`로 추론된다. 별도 `Profile` 타입을 받는 컴포넌트로 props 분리하면 TS 에러. `pnpm test`(esbuild transpile)는 통과하고 **`pnpm build`(`tsc -b`)에서만 잡힘** — UI 변경 commit 전 build 게이트 한 번 더 확인.
- **vite dev `/api` 프록시 타깃**: `ui/vite.config.ts`가 `/api` → `http://127.0.0.1:8080`(controller) 프록시. UI에서 네트워크 404/CORS가 나면 controller 살아있는지 먼저 (`curl http://127.0.0.1:8080/api/scenarios`). `HANDICAP_API` env로 오버라이드 가능.

## Subagent dispatch 노하우 (Slice 4 학습)

- **워크트리에서 subagent를 띄울 땐 prompt 첫 줄에 `cd /Users/sgj/develop/handicap/.claude/worktrees/<name>` 명시**: 안 하면 spec-reviewer 같은 lightweight 모델이 메인 체크아웃을 읽고 "코드가 없다"고 잘못 보고하는 사례가 있었다 (Slice 4 Task 5). 절대 경로로 박는 게 가장 안전.
- **e2e 테스트는 워커 바이너리를 매번 빌드**: `crates/controller/tests/e2e_test.rs::worker_bin_path()` 헬퍼 패턴 — `cargo build -p handicap-worker` 호출 → `CARGO_BIN_EXE_worker` 또는 `target/debug/worker` 경로. 새 e2e 테스트 추가 시 그대로 차용.
- **각 task마다 두 단계 review (spec compliance → code quality)**: Slice 4의 16개 task + 7개 follow-up 전부 이 패턴으로 진행. spec reviewer는 plan 대비 빠짐/추가를 보고, code quality reviewer는 idiom/race/test 품질을 본다. 두 reviewer가 모두 APPROVED여야 다음 task로.

## 새로운 아키텍처 결정이 생기면

`docs/adr/`에 새 ADR 파일 추가 (다음 번호 사용, MADR 포맷). 이 CLAUDE.md의 "알아둘 결정들" 목록에도 한 줄 추가.

## Slice 5에서 배운 함정들

- **Recharts ResponsiveContainer + jsdom**: ResponsiveContainer는 부모의 measured 사이즈를 읽어 자식 차트에 넘기는데 jsdom은 layout이 없어서 size=0 → SVG가 안 그려져 RTL assertion 실패. 컴포넌트에 explicit `width`/`height` prop을 받게 만들고 ResponsiveContainer는 (필요 시) 프로덕션 path에서만 사용. 테스트는 explicit size로.
- **HDR Histogram V2 BLOB 의 partial-write 내성**: worker가 flush 중 죽으면 `hdr_histogram` 컬럼에 truncated bytes가 남을 수 있다. `decode_hdr` 는 `Result`로 실패를 표현하고 controller `build_report` 는 그 한 윈도만 p50/p95/p99=0 으로 두고 나머지 윈도를 정상 처리. crash-late-fail-soft 패턴. 단위 테스트 `build_report_tolerates_bad_hdr_blob` 가 contract.
- **`/report` 는 polling 금지**: terminal 후 한 번만 fetch, `staleTime: Infinity`, `refetchInterval: false`. live polling은 기존 `/metrics` 가 담당. 두 endpoint를 분리한 이유는 hot path의 HDR deserialize 비용을 피하기 위함.
- **Scenario snapshot vs current scenario**: M2의 follow-up에서 noted — Run 상세가 `runs.scenario_yaml` snapshot 컬럼을 봐야지 `GET /api/scenarios/{id}` 의 현재 YAML을 보면 시나리오 편집 후 과거 run의 step 라벨이 어긋난다. Slice 5는 `/report.scenario_yaml`을 snapshot으로 노출하는 쪽으로 결정.
- **bySecond 시계열 derivation은 ReportView 안에서**: 시계열 max-over-steps 합산 같은 derivation 로직을 backend가 아니라 ReportView 안에 두기로. backend는 raw windows 만 보낸다. 이유: UI가 step 필터/색상 분리 같은 변형을 더하기 쉬움.
- **`hdrhistogram` add 의 bound 일치**: `Histogram::add(other)` 는 두 히스토그램의 lo/hi/sigfig 가 같을 때 lossless. 다른 컨피그면 일부 샘플이 누락된다. `fresh_hist()` 헬퍼로 모든 누적용 히스토그램이 같은 bound 를 갖게 통일.
- **blob URL 누수**: `URL.createObjectURL` 결과는 명시적 `revokeObjectURL` 호출 전까지 페이지 lifetime 내내 남는다. `useEffect cleanup`으로 `revokeObjectURL` 호출. DownloadJsonButton unmount 테스트로 contract 검증.
- **jsdom은 `URL.createObjectURL`을 구현하지 않음**: DownloadJsonButton 테스트와 ReportView 테스트에서 `Object.defineProperty(URL, "createObjectURL", ...)` 폴리필을 모듈 스코프에 추가해야 한다. 폴리필은 conditional (`typeof URL.createObjectURL === "undefined"`)로 만들어 jsdom이 아닌 환경에서 덮어쓰지 않게.
- **localhost HTTP RTT는 microsecond 단위 → p95_ms = 0**: e2e 테스트에서 wiremock /ping이 sub-millisecond로 응답하면 `value_at_quantile(0.95) / 1_000` 이 0이 된다. `set_delay(Duration::from_millis(5))` 같은 인공 지연으로 p95 > 0 보장. UI에는 영향 없음(빠른 prod 백엔드도 보통 ms 단위).
- **`Deserialize`는 typed round-trip 테스트가 강제**: report.rs의 ReportJson/ReportRun/... 은 처음에 Serialize만 가졌는데 integration test 의 `serde_json::from_value::<ReportJson>` 어설션이 Deserialize 를 요구. 새 응답 타입 정의 시 양방향 derive를 함께.
- **`runs.started_at`/`ended_at` 은 wall-clock 밀리초 (`now_ms`)**: `build_report` 가 처음엔 그 차이를 그대로 `duration_seconds` 필드에 넣어 10초 run이 `10003` 으로 표시되고 rps 도 1000배 작게 나왔다. ms→s 변환은 `/1000`, rps 는 ms 기반으로 계산해 sub-second 분해능 유지. 단위 테스트 fixture 도 ms 값(`100_000` ↔ `102_000`)으로 적어야 의도(=2초 run)가 명확.
- **terminal 후 `/report` fetch가 silent로 실패하면 사용자는 "전환 없음"으로만 본다**: RunDetailPage 조건부가 `terminal && report.data` 라 fetch 실패 시 `report.error` 가 있어도 라이브 섹션이 그대로 fallthrough. `role="alert"` 배너로 에러 메시지를 띄우고 `role="status"` 로 로딩을 표시해야 사용자가 "404 / Zod parse fail / 네트워크 hang" 같은 원인을 즉시 본다. silent failure 디버깅 시간을 절약.
- **여러 워크트리에서 `pnpm dev` 충돌 (포트 5173 선점)**: 다른 워크트리(또는 master)에서 띄운 vite dev가 떠 있으면 그쪽 코드의 번들을 서빙해 새 브랜치 변경이 안 보인다. 증상: 컨트롤러는 새 빌드(curl로 200 응답)인데 UI에서 새 기능이 동작 안 함. `lsof -i :5173 | grep LISTEN` 후 `ps -o cwd= -p <PID>` 로 어느 워크트리의 vite인지 확인 → 잘못된 것 죽이고 현재 워크트리에서 재시작 + 브라우저 hard reload. 같은 함정이 `cargo run --bin controller`(포트 8080)에도 적용. **`ps aux | grep -E "target/.*controller"` 로 binary 경로 한 번 더 확인하는 게 안전.**
- **Chrome `<a href="blob:..." download>` 가 가끔 "Check Internet Connection"으로 실패**: **온라인 환경에서도** 가끔 발생, 보통 retry로 해소되는 transient 실패. 원인 추정: Chrome 다운로드 매니저가 Safe Browsing 검증을 위해 phone home하는데 그 단계가 잠깐 실패하면 사용자에겐 네트워크 오류처럼 보인다 (확정 진단 아님 — Slice 5 매뉴얼 점검 중 1회 관찰, retry로 해소). 우회 (Slice 5 채택): **`window.showSaveFilePicker`** (File System Access API, Chrome 86+ / Edge 86+) 는 다운로드 매니저를 거치지 않고 사용자가 선택한 위치에 직접 쓰니까 이 transient 실패와 무관하고, 저장 위치를 사용자가 고를 수 있어 UX도 더 좋다. Firefox/Safari는 미지원이라 blob URL anchor click fallback 유지. 패턴: `if (typeof window.showSaveFilePicker === "function") { ... } else { /* blob URL anchor click */ }`. (애초에 "에어갭/사내망"으로 진단했었는데 그건 오인이었음 — 같은 함정 또 만나면 transient/retry 먼저 의심.)

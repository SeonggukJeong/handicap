# Handicap

사내 QA·운영팀을 위한 부하 테스트 도구. REST API를 대상으로, **QA는 드래그-드롭으로 시나리오를 만들고**, **개발자는 같은 시나리오를 YAML/DSL로 편집** 한다 (두 뷰가 같은 모델의 양방향 sync). LoadRunner/JMeter를 사내에서 대체하는 것이 목표.

**상태: Slice 8a/8b/8c(data-driven 전체) 구현 완료.** 다음 = spec §4.5 메뉴에서 선택 — Conditional 노드 / Parallel 노드 / 멀티 워커·HPA / LoadRunner급 리포트. (MVP 1단계 = 슬라이스 1–6, Slice 7 = loop 노드, Slice 8 = data-driven 3분할.) 디자인 문서 → `docs/superpowers/specs/`. 구현 계획 → `docs/superpowers/plans/`. 결정 기록 → `docs/adr/`. **MVP 1단계 spec(`2026-05-27-handicap-mvp1-design.md`)은 슬라이스 1–6으로 전부 구현됨 — 후속은 그 spec §4.5 메뉴(노드 종류 확장 → 멀티 워커/HPA → LoadRunner급 리포트)에서 각자 새 spec/plan으로 나온다.**

Slice 1 결과: REST API(`/api/scenarios`, `/api/runs`, `/api/runs/{id}/metrics`) + gRPC Coordinator(bidi stream) + SQLite store + subprocess-spawn worker가 wiremock 타겟에 대해 end-to-end 동작.

Slice 2 결과: Vite + React + TS + Tailwind UI (`ui/`). 시나리오 목록·생성·편집(YAML textarea), run 다이얼로그, run 상세(1초 폴링 + 메트릭 표). 컨트롤러가 `--ui-dir` 경로의 SPA를 정적 서빙(unknown path는 index.html로 fallback). 캔버스·Monaco·양방향 sync는 Slice 3, 차트·HTML 리포트는 Slice 5, multi-step·extract·ramp-up은 Slice 4, K8s 배포는 Slice 6.

Slice 3 결과: React Flow 캔버스(HTTP 노드 1종, 선형 chain, drag-drop add, inspector) + Monaco YAML 에디터(syntax highlighting only) + Zustand store + Zod 검증 + `yaml` 패키지 Document API targeted edit. 양방향 sync는 탭 전환 모델: 캔버스/YAML 둘 중 하나가 active. Monaco 편집은 300ms debounce → 검증 통과 시 doc swap, 실패 시 pendingYamlText에 유지하고 inline 에러 표시. extract/multi-step variable chaining은 Slice 4, K8s 배포는 Slice 6.

Slice 4 결과: 엔진이 multi-step extract(JSONPath body / header / cookie / status)와 ${ENV:-default} 템플릿, 1초 단위 linear ramp-up, CancellationToken 기반 abort를 지원. 컨트롤러 `POST /api/runs/{id}/abort` → 워커가 in-flight run 취소. UI Inspector에 ExtractEditor, RunDetail에 Abort 버튼. 테스트: Rust unit + wiremock multi-step integration + proptest properties, UI RTL + fast-check round-trip. K8s 배포는 Slice 6, 차트·HTML 리포트는 Slice 5.

Slice 4 post-merge manual check: `RunDialog`가 `env`·`ramp_up_seconds`를 하드코딩하던 UI 갭을 메우고(M1), Run 상세에 Steps/Env/Profile 진단 패널을 추가(M2), 시나리오 URL을 env로 풀어 표시하는 client-side `resolveForDisplay` 도입(M3). 매뉴얼에 wiremock stub 등록 절차 명시(M4). 자세한 내용 → `docs/superpowers/plans/2026-05-28-slice-4-manual-check-fixes.md`.

Slice 5 결과: 종료된 run의 same-page Report 전환. Controller `GET /api/runs/{id}/report` 가 run + scenario_yaml snapshot + per-second windows(percentile 포함) + per-step + status 분포를 한 번에 번들. 엔진 `percentiles.rs` 가 V2 HDR Histogram BLOB을 deserialize + merge. UI Recharts (line/bar) + Summary + StepStatsTable + ScenarioSnapshot + JSON download. e2e `report_e2e_smoke` 가 워커 subprocess → 컨트롤러 → report 까지 검증. K8s 배포(Slice 6)는 아직.

Slice 6 결과: kind 단일 노드 + Helm chart 1개로 controller + worker가 K8s Job 로 동작. 컨트롤러가 `--worker-mode {subprocess,kubernetes}` 로 두 디스패치 경로 지원 (로컬 `cargo run` 은 subprocess 유지, 컨테이너는 kube-rs 로 Job 생성). 워커 SIGTERM 핸들러는 **connect 전에** 설치되고 backoff 도 cancellable 해서 K8s `terminationGracePeriodSeconds` 안에 graceful `Phase::Aborted` 보고. 컨트롤러 재시작 시 진행 중이던 run 을 `failed` + `message` 로 마크. `runs.message` 컬럼 추가 (migration 0002). GitHub Actions `.github/workflows/e2e-kind.yml` 가 PR 마다 `just e2e-kind` 를 실행. 성능 acceptance(§4.3 5,000 RPS 목표) 는 manual + `just bench-throughput` — post-Slice-6 baseline 20,389 RPS / p95 17ms / p99 24ms (200 VUs × 30s, 1KB body). ADR-0019 추가.

Slice 7 결과: 첫 control-flow 노드 `type: loop` 를 end-to-end 추가. 엔진 `Step` 을 internally-tagged enum(`Step::Http`/`Step::Loop`, `#[serde(tag="type")]`)으로 확장하고, 인터프리터를 재귀 `execute_steps(steps, ctx)` 로 전환 — `Step::Loop` arm 만 `0..repeat` 를 돌며 `do_` 를 재귀 실행. `${loop_index}` 0-based 시스템 변수(loop 밖 참조 시 `EngineError::UnknownVar`). `LoopStep.do_: Vec<Step>` 결정(명세 §4.1 의 `Vec<HttpStep>` 에서 변경 — 엔진은 자유 중첩 허용, 단일 레벨 강제는 UI Zod `do: z.array(HttpStepModel)`; 이유는 internally-tagged + `Vec<HttpStep>` 이면 직렬화 시 내부 스텝 `type: http` 가 빠져 round-trip 깨짐, 그리고 Slice 8/9 컨테이너 노드 포석). UI 는 React Flow 부모/자식 subflow 컨테이너(loop 안에 http 자식). **컨트롤러 무변경** — 메트릭은 step_id 집계, step 라벨링은 UI `flattenHttpSteps` 가 `do:` 를 재귀 평탄화. 메트릭 의미: 내부 http 스텝 `count` 는 `repeat` 배 누적되나 distinct step_id 개수는 불변(리포트 행 수 영향 없음). 성능(Task 11 A/B, 200 VUs × 20s, 1KB body, 동일 머신): flat ~19,974 RPS / loop(repeat:1) ~19,449 RPS — ~2.6% 차이는 run-to-run 변동(±5–7%) 범위 내(한 페어에선 loop 가 flat 을 앞섬), p95 17–18ms / p99 24–25ms 양쪽 동일. `Box::pin`-per-iteration 오버헤드는 HTTP round-trip 대비 무시 가능. ADR-0020 추가.

**Slice 7-1 결과:** loop 노드 리포트에 **반복 인덱스별(per-`loop_index`) 요청·오류 수 breakdown** 추가 (counts-only, 레이턴시 breakdown 없음). Run 다이얼로그에 `loop_breakdown_cap` 설정(0=off, default 256, max 10000; controller가 >10000 거부). cap 초과 `loop_index`는 엔진에서 `u32::MAX` sentinel 버킷으로 fold → report에서 `loop_index: null`, UI에서 "그 외 (상한 초과)" 행으로 렌더. 파이프라인: RunDialog → REST profile → proto `Profile.loop_breakdown_cap` → 엔진 `Aggregator` per-(step_id,loop_index) counts → `MetricFlush.loop_stats` → gRPC `MetricBatch.loop_stats` (delta) → controller `run_loop_metrics` 테이블(migration 0003, `CREATE TABLE IF NOT EXISTS` — idempotent) UPSERT-accumulate → `ReportStep.loop_breakdown` → UI StepStatsTable caret drill-down. `runs` 테이블 무변경 — profile은 `profile_json` JSON 컬럼이라 새 필드는 `#[serde(default)]`만으로 기존 행 호환. 성능 A/B(SCENARIO_KIND=loop, 200 VUs × 20s, 1KB body): cap=0(off) → 19,086 RPS p50/p95/p99=9/18/26ms, cap=256(on) → 21,254 RPS p50/p95/p99=8/16/23ms — breakdown ON은 run-to-run 변동 범위 내, 측정 가능한 회귀 없음. ADR-0021 추가.

**Slice 8a 결과:** form/JSON body 템플릿팅(데이터 주입의 전제조건, 데이터셋과 독립 출하). `executor.rs`가 `Body::Form(map)` 각 값 + `Body::Json(v)`의 **문자열 leaf**에 `render` 적용 — 이전엔 url·header·`Body::Raw`만 치환됐다. JSON은 `render_json_value` 재귀 헬퍼로 number/bool/null·object 키를 보존하고 문자열 leaf만 치환(form 키도 authored 식별자라 미렌더). 미바인딩(`{{}}` 토큰 없음)이면 출력 불변 = 하위 호환. 숫자 주입(`{"age": {{age}}}`로 number)은 미지원 — 값은 문자열로만. `bench-throughput`(body 없는 flat GET)은 8a 경로를 안 타므로 구조적 no-op(20,320 RPS, baseline ±0.3%); 실제 8a 비용은 body 보유 요청당 1회로 직렬화+RTT에 묻힘. subagent-driven 3 tasks(form/json/docs) + 2단계 리뷰 "with fixes"(키-미렌더 + unknown-var 전파 + 중첩 JSON 테스트). master `2f6f12b`. CLAUDE.md "Slice 8a에서 배운 함정들" 참고.

**Slice 8b 결과:** CSV/XLSX 업로드 → controller 서버 파싱 → 독립 `datasets`/`dataset_rows` 리소스(migration 0004, `CREATE TABLE IF NOT EXISTS` 멱등)로 저장하는 데이터셋 관리 기능. `/api/datasets` REST: multipart `POST`(파싱+저장), parse-only `POST /datasets/preview`(저장 안 함), `GET` 목록, `GET /{id}`(메타+sample 20행), `DELETE`(8b 무조건 삭제, 참조 409 가드는 8c). 파싱은 순수 모듈 `crates/controller/src/datasets/parse.rs`(csv 1.4 + calamine 0.26 + encoding_rs 0.8): 구분자(`,`/`;`/`\t`) 자동감지, UTF-8 BOM strip + CP949 fallback, XLSX 단일/다중 시트, 헤더 없음→`colN`, 빈/중복 컬럼명 정규화, 짧은 행 빈 문자열 패딩. 행은 `{"col":"value"}` JSON으로 저장. UI `/datasets` 페이지(목록+삭제) + UploadPanel(드래그드롭/파일선택 + header/delimiter/encoding/sheet override + 저장 전 라이브 미리보기 + 저장). **워커·엔진·proto·runs 테이블 무변경** — 데이터 주입/바인딩은 8c(`profile_json` 새 필드). 업로드 본문 상한은 업로드/preview POST 라우트에만 `DefaultBodyLimit::max(256MiB)`(axum 기본 2MB로는 실제 데이터셋 업로드가 막힘). 행 데이터는 worker 로그에 안 나옴(주입 자체가 8c). ADR-0022 추가.

**Slice 8c 결과:** CSV/XLSX 데이터셋 행을 `{{var}}` 흐름 변수로 런타임 주입하는 data-driven 실행 완성. 파이프라인: `RunDialog DataBindingPanel`(시나리오 YAML에서 `{{var}}`를 `scanFlowVars`로 스캔 → 열/리터럴 매핑 + 정책 선택 + 검증) → `profile_json.data_binding`(`#[serde(default)]`, runs 테이블 무변경) → run-create 검증 게이트(미구현 정책·없는 데이터셋·빈 데이터셋·없는 컬럼·`iter_*` 시 `--dataset-max-rows` 초과 거부) → controller `PendingDataBinding` 해석(FNV-1a seed + 정책별 row_count 슬라이싱: `per_vu=min(vus,rows)`, `iter_*=전체`) → worker Register 시 `apply_mappings`된 `{var:value}` 행을 `DatasetBatch` gRPC 메시지로 스트리밍(컬럼명 비노출) → worker 로딩 단계(엔진 시작 전 `row_count` 행 수신 완료; abort/cancel→Aborted, 조기 종료→Failed; controller는 전달 불가 시 `AbortRun` 전송) → 엔진 반복마다 정책 인덱스로 행 선택 + `iter_vars` overlay(우선순위: scenario.variables < dataset < extract). 3 정책: `per_vu`(vu_id % rows, 고정), `iter_sequential`(worker-local `AtomicU64` fetch_add % rows), `iter_random`(splitmix64-seeded `StdRng` — 재현 가능). `unique` 예약(멀티-워커 전역 커서 필요, API 거부). `None` binding = byte-identical pre-8c(하위 호환). 성능: 벤치 하네스(`just bench-throughput`)는 body-injection 시나리오를 구동하지 못하고(8c 이전 작성, `data_binding` profile 미지원), Task 12에서 release 빌드를 재실행하지 않았다. 대신 해석적 분석: `None` binding 경로는 pre-8c와 byte-identical이므로 구조적 no-op(documented prior baseline ~20,000 RPS). binding 경로의 반복당 비용은 modulo 1회 또는 splitmix64+StdRng 1회 + BTreeMap clone-insert — 나노초 단위, HTTP round-trip에 완전히 묻힘(Slice 8a와 동일 결론). 민감값 마스킹·JSON 숫자 주입·Helm values 노출·멀티워커 HPA는 후속. ADR-0022 업데이트.

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

**이 repo의 git 토폴로지**: 통합 브랜치는 `master` (`main` 없음 — 세션 시작 컨텍스트의 "Main branch: main"은 부정확), **remote 미설정**. 브랜치 마무리는 push/PR이 아니라 로컬 fast-forward: `git checkout master && git merge --ff-only <branch>`. 사내 K8s 도입 시 remote 붙이면 PR 흐름 가능. 슬라이스 작업은 `.claude/worktrees/<name>` worktree에서 진행.

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
- **0020** Control-flow 노드: loop (재귀 스텝 트리, 단일 레벨, repeat-count)
- **0021** loop 메트릭 breakdown: per-run cap + overflow sentinel, counts-only
- **0022** Data-driven 데이터셋: 독립 리소스 + 서버 파싱(8b) + 3정책 바인딩/주입(8c) — 완결

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
- **리포트 step 라벨링은 controller가 아니라 UI**: `controller/src/report.rs::build_report` 는 run_metrics 를 step_id 로 group 만 한다 (시나리오 YAML 을 walk 하지 않음). step 라벨(name/method/url)은 UI 가 `ReportView.tsx`·`RunDetailPage.tsx` 에서 scenario_yaml 을 파싱해 만든다. **스텝 모델을 바꿔도(노드 종류 추가 등) 컨트롤러는 무변경 — 이 두 UI 사이트만 손대면 된다.**
- **`hdrhistogram` add 의 bound 일치**: `Histogram::add(other)` 는 두 히스토그램의 lo/hi/sigfig 가 같을 때 lossless. 다른 컨피그면 일부 샘플이 누락된다. `fresh_hist()` 헬퍼로 모든 누적용 히스토그램이 같은 bound 를 갖게 통일.
- **blob URL 누수**: `URL.createObjectURL` 결과는 명시적 `revokeObjectURL` 호출 전까지 페이지 lifetime 내내 남는다. `useEffect cleanup`으로 `revokeObjectURL` 호출. DownloadJsonButton unmount 테스트로 contract 검증.
- **jsdom은 `URL.createObjectURL`을 구현하지 않음**: DownloadJsonButton 테스트와 ReportView 테스트에서 `Object.defineProperty(URL, "createObjectURL", ...)` 폴리필을 모듈 스코프에 추가해야 한다. 폴리필은 conditional (`typeof URL.createObjectURL === "undefined"`)로 만들어 jsdom이 아닌 환경에서 덮어쓰지 않게.
- **localhost HTTP RTT는 microsecond 단위 → p95_ms = 0**: e2e 테스트에서 wiremock /ping이 sub-millisecond로 응답하면 `value_at_quantile(0.95) / 1_000` 이 0이 된다. `set_delay(Duration::from_millis(5))` 같은 인공 지연으로 p95 > 0 보장. UI에는 영향 없음(빠른 prod 백엔드도 보통 ms 단위).
- **`Deserialize`는 typed round-trip 테스트가 강제**: report.rs의 ReportJson/ReportRun/... 은 처음에 Serialize만 가졌는데 integration test 의 `serde_json::from_value::<ReportJson>` 어설션이 Deserialize 를 요구. 새 응답 타입 정의 시 양방향 derive를 함께.
- **`runs.started_at`/`ended_at` 은 wall-clock 밀리초 (`now_ms`)**: `build_report` 가 처음엔 그 차이를 그대로 `duration_seconds` 필드에 넣어 10초 run이 `10003` 으로 표시되고 rps 도 1000배 작게 나왔다. ms→s 변환은 `/1000`, rps 는 ms 기반으로 계산해 sub-second 분해능 유지. 단위 테스트 fixture 도 ms 값(`100_000` ↔ `102_000`)으로 적어야 의도(=2초 run)가 명확.
- **terminal 후 `/report` fetch가 silent로 실패하면 사용자는 "전환 없음"으로만 본다**: RunDetailPage 조건부가 `terminal && report.data` 라 fetch 실패 시 `report.error` 가 있어도 라이브 섹션이 그대로 fallthrough. `role="alert"` 배너로 에러 메시지를 띄우고 `role="status"` 로 로딩을 표시해야 사용자가 "404 / Zod parse fail / 네트워크 hang" 같은 원인을 즉시 본다. silent failure 디버깅 시간을 절약.
- **여러 워크트리에서 `pnpm dev` 충돌 (포트 5173 선점)**: 다른 워크트리(또는 master)에서 띄운 vite dev가 떠 있으면 그쪽 코드의 번들을 서빙해 새 브랜치 변경이 안 보인다. 증상: 컨트롤러는 새 빌드(curl로 200 응답)인데 UI에서 새 기능이 동작 안 함. `lsof -i :5173 | grep LISTEN` 후 `ps -o cwd= -p <PID>` 로 어느 워크트리의 vite인지 확인 → 잘못된 것 죽이고 현재 워크트리에서 재시작 + 브라우저 hard reload. 같은 함정이 `cargo run --bin controller`(포트 8080)에도 적용. **`ps aux | grep -E "target/.*controller"` 로 binary 경로 한 번 더 확인하는 게 안전.**
- **Chrome `<a href="blob:..." download>` 가 가끔 "Check Internet Connection"으로 실패**: **온라인 환경에서도** 가끔 발생, 보통 retry로 해소되는 transient 실패. 원인 추정: Chrome 다운로드 매니저가 Safe Browsing 검증을 위해 phone home하는데 그 단계가 잠깐 실패하면 사용자에겐 네트워크 오류처럼 보인다 (확정 진단 아님 — Slice 5 매뉴얼 점검 중 1회 관찰, retry로 해소). 우회 (Slice 5 채택): **`window.showSaveFilePicker`** (File System Access API, Chrome 86+ / Edge 86+) 는 다운로드 매니저를 거치지 않고 사용자가 선택한 위치에 직접 쓰니까 이 transient 실패와 무관하고, 저장 위치를 사용자가 고를 수 있어 UX도 더 좋다. Firefox/Safari는 미지원이라 blob URL anchor click fallback 유지. 패턴: `if (typeof window.showSaveFilePicker === "function") { ... } else { /* blob URL anchor click */ }`. (애초에 "에어갭/사내망"으로 진단했었는데 그건 오인이었음 — 같은 함정 또 만나면 transient/retry 먼저 의심.)

## Slice 6에서 배운 함정들

- **Bin-only crate 는 단위 테스트가 안 됨 → `worker-core` lib 분리**: 원래 plan 은 `reconnect.rs`/backoff 를 `crates/worker/` (bin crate) 안에 두려고 했다. 하지만 bin crate 의 모듈은 외부에서 import 못 해서 `tokio::time::pause()` 기반 단위 테스트를 붙일 수가 없다. Slice 6 Task 0 에서 `crates/worker-core/` 를 sibling lib 로 추출한 뒤 `worker/src/main.rs` 는 CLI parsing + wiring 만 남겼다. **새 패턴: worker 측 로직에 진짜 단위 테스트가 필요하면 `worker-core/src/` 로, bin 은 wiring 만.**
- **`tokio::time::pause()` 는 `tokio::time::Instant` 와 짝**: backoff retry 의 누적 시간을 `std::time::Instant::now()` 로 트래킹하면 paused clock 을 무시하고 wall-clock 으로 흘러서 "60초 cap 검증" 단위 테스트가 진짜 60초를 기다린다. `tokio::time::Instant` (또는 `tokio::time::Instant::now()`) 로 바꾸고, 추가로 `tokio = { workspace = true, features = ["test-util"] }` 가 dev-deps 에 있어야 `#[tokio::test(start_paused = true)]` 가 활성화된다.
- **Bare `tokio::time::sleep` 은 cancel 안 됨**: SIGTERM 핸들러 1차 구현(Task 8)이 `connect_with_backoff` **뒤에** 설치되어, backoff sleep 중에 SIGTERM 이 와도 process 가 정지하지 못했다. 테스트는 "어쨌든 kernel 의 default action 으로 죽음" 으로 잘못 green 이었음. Fix(`04b4b72`): (a) handler 를 main 맨 앞에 등록, (b) backoff 의 sleep 을 `tokio::select! { _ = sleep(d) => ..., _ = cancel.cancelled() => return Err(Cancelled) }` 로 감쌈, (c) `WorkerError::Cancelled` variant 추가해서 bin 이 `return Ok(())` (exit 0) 로 끝나게.
- **SQLite `ALTER TABLE ADD COLUMN` 은 idempotent 아님**: migration 0002 가 `runs.message` 컬럼을 추가하는데, 이미 마이그레이션된 DB 에서 controller 가 재시작되면 두 번째 ALTER 가 `duplicate column name` 으로 깨진다. 표준 가드는 `SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name = 'message'` 결과가 0 일 때만 ALTER. SQLite 는 `IF NOT EXISTS` 를 컬럼 단위로 지원하지 않으므로 이 패턴이 사실상 유일한 길.
- **`{Release.Name}-{Chart.Name}-controller` Service 이름 collision**: 표준 `handicap.fullname` helper 는 `release-chart` 를 쓰므로, release 이름을 chart 이름과 같게 `handicap` 으로 잡으면 controller Service 이름이 `handicap-handicap-controller` 가 된다. README/runbook 에서 무심코 `handicap-controller` 로 적으면 port-forward 가 조용히 fail (kubectl 은 not found 를 stderr 로만 흘리고 0 으로 끝나는 케이스도 있음). 두 가지 다 명시: release ≠ chart name 으로 가거나, fullname 그대로 쓰거나. Slice 6 은 후자.
- **Helm RWO PVC 는 `strategy.type: Recreate` 필수**: 기본 RollingUpdate 로 가면 새 pod 가 PVC 를 attach 하지 못해 (ReadWriteOnce 가 이미 old pod 한테 잡혀 있음) deploy 가 deadlock 한다. `deploy/helm/handicap/templates/controller-deployment.yaml` 에 인라인 주석으로 이 이유를 박아뒀다 — 무심결에 RollingUpdate 로 되돌리는 회귀 방지.
- **Dockerfile 에서 CMD/ENTRYPOINT 둘 다 의도적으로 미설정**: 멀티-바이너리 (controller + worker) 이미지라 default 가 있으면 "controller container 가 worker binary 를 실행" 같은 사고가 가능. 그래서 Dockerfile 에서 둘 다 비우고 모든 consumer (Helm Deployment, `build_job_spec` 의 K8s Job spec) 가 `command:` 를 명시하도록 강제. 새 consumer 추가 시도 같은 컨벤션.
- **여러 워크트리에서 `kubectl port-forward` IPv4/IPv6 충돌**: 다른 워크트리의 `cargo run --bin controller` 가 `127.0.0.1:18080` 을 점유한 상태로 `kubectl port-forward 18080:8080` 을 띄우면, kubectl 은 IPv4 bind 가 EADDRINUSE 라 silent 하게 `[::1]:18080` 만 listen 한다. 그 후 `curl 127.0.0.1:18080/api/scenarios` 는 잘못된 프로세스 (다른 worktree 의 controller, 다른 DB) 에 도달해서 "no such table: scenarios" 같이 가짜 schema 에러가 난다. `lsof -i :18080` 으로 누가 점유 중인지 확인하고 stray `target/*/controller` 죽이는 게 표준. Slice 5 의 `pnpm dev`/8080 함정과 같은 클래스.
- **공유 endpoint 의 health check 는 forward 정합성을 증명하지 못한다**: `kubectl port-forward svc/wiremock 9001:8080` 후 `curl -sf …/__admin/health && echo OK` 로 readiness 를 끝내면 거짓 안심이 든다 — 9001 에서 **무엇이든** 200 을 주면(이전 세션의 stale forward, 9001 을 선점한 다른 프로세스) OK 가 찍히기 때문. 실제로 stub 을 POST 했는데 worker 가 못 보는 사고가 났고, `curl -s …/health` 의 `-s` 가 connection refused 까지 삼켜서 진단이 더 늦어졌다 (Slice 6 매뉴얼 점검 중). 표준: (a) `lsof -ti tcp:9001 | xargs -r kill` 로 stale 정리 → (b) forward 의 `Forwarding from 127.0.0.1:9001` 줄 확인 → (c) health 가 아니라 등록 직후 `…/__admin/mappings` 를 read 해서 방금 넣은 stub 이 보이는지로 검증 (read/write round-trip 이 유일하게 믿을 신호). 디버깅 중엔 `-s` 빼고 `-sS`/`-sf` 로 connection error 를 노출. (`docs/dev/slice-6-manual-check.md` "사전 — wiremock stub 등록" 참고.)
- **타겟 pod 이 재생성되면 `kubectl port-forward` 도 같이 죽는다**: forward 는 특정 pod 에 묶여 있어서, 재배포(`just deploy-kind`/`helm upgrade`)·`kubectl delete pod`·eviction 으로 pod 이름이 바뀌면 옛 forward 가 조용히 종료된다. 증상: 멀쩡히 쓰던 UI(`localhost:8080`)나 wiremock(`localhost:9001`)이 "갑자기" 안 뜸 — pod 은 `Running` 인데 8080 에 listen 이 없음(`lsof -iTCP:8080 -sTCP:LISTEN` 가 빈 결과). 코드/빌드 문제 아님. **pod 을 한 번이라도 건드렸으면 controller·wiremock forward 를 무조건 재기동**한다 (`kubectl -n handicap port-forward svc/handicap-handicap-controller 8080:8080 &`). Slice 6 매뉴얼 점검 중 wiremock forward 변경 후 저장이 안 돼 controller pod 을 재실행했더니 8080 forward 가 같이 죽어 UI 가 내려간 사례. 위 두 port-forward 함정과 같은 클래스.
- **Vite + Monaco + Recharts 빌드는 Docker 안에서 Node OOM**: `pnpm build` 의 default V8 old-space limit (≈2GiB) 가 우리 UI 번들 (Monaco lazy chunk + Recharts tree-shake 잔여 + React Flow) 에는 부족해 multi-stage Dockerfile 의 UI 빌드 스테이지가 OOM kill. `ENV NODE_OPTIONS=--max-old-space-size=4096` 한 줄로 해소. macOS 호스트의 `pnpm build` 가 통과하는 건 Node 가 호스트 메모리 압력에 따라 동적으로 더 잡기 때문 — Docker container 의 cgroup limit 안에서는 다르다.
- **`helm get manifest | grep -A1 'kind: Deployment$'` 는 `-A2` 가 맞음**: `scripts/deploy-kind.sh` 1차 구현이 plan 의 한 줄짜리 awk pipe 를 그대로 베꼈는데, 렌더된 chart 의 Deployment 블록은 `kind: Deployment\nmetadata:\n  name: …` 3줄 구조라 `-A1` 로는 `name:` 라인이 안 잡혀 wait target 이 빈 문자열이 된다. 항상 freshly rendered chart 로 한 번 dry-run 해서 grep 출력 확인하고 커밋.
- **Snapshot test 는 label/format drift 도 잡는다**: `deploy/helm/handicap/tests/snapshot_test.sh` 가 default values + custom values 두 시나리오로 rendered manifest 를 비교. 1차 run 에서 `_helpers.tpl` 의 표준 label set 에 `app.kubernetes.io/instance` 가 빠져 있었는데 snapshot diff 가 바로 잡아냄. **의도된 변경 후에는 `UPDATE_SNAPSHOTS=1 ./snapshot_test.sh` 로 재생성** — 안 그러면 다음 PR 의 CI 가 빨갛게 뜬다.
- **`dispatcher_kubernetes_test` 는 `slice6-k8s` feature 로 격리**: 진짜 kube context 를 요구하는 integration 테스트는 `#![cfg(feature = "slice6-k8s")]` 로 가둬서 일상 `cargo test --workspace` 가 kube 없이도 통과하게 했다. 진짜 K8s 경로의 회귀 방지는 (a) `build_job_spec` 의 순수 단위 테스트, (b) GitHub Actions `e2e-kind.yml` 의 kind 클러스터 e2e 두 층에서 한다 — 후자가 dispatcher trait 을 controller 전체 흐름 안에서 검증.
- **kind 점검 시 wiremock은 두 주소로 같은 pod를 친다**: stub 등록은 호스트 port-forward `localhost:9001`, worker(in-cluster Job)는 RunDialog Env `BASE_URL`로 cluster DNS `http://wiremock.handicap-test.svc.cluster.local:8080`. pod 안에서 `localhost`는 자기 loopback이라 worker엔 `:9001`이 안 통함. (로컬 dev subprocess 모드면 worker가 호스트라 `:9001`이 맞아 더 헷갈림.) 상세 → `docs/dev/slice-6-manual-check.md`.
- **`handicap-controller` 패키지엔 바이너리가 둘 (`controller` + `e2e_kind_driver`)**: Slice 6이 `e2e_kind_driver`를 추가하면서 `cargo run -p handicap-controller` 가 `error: could not determine which binary to run` 로 깨진다. 로컬 controller 실행은 **항상 `cargo run -p handicap-controller --bin controller -- …`**. `just run-controller`/`run-controller-with-ui` 레시피는 이미 `--bin controller` 로 고정돼 있으니 그걸 쓰는 게 안전. (Slice 7 작업 중 한 번 밟음.)

## Slice 7에서 배운 함정들

- **serde 내부 태그는 enum 레벨에서 `deny_unknown_fields`를 강제하지 않는다**: `#[serde(tag="type")]` 만으로는 loop 스텝에 `request:`를, http 스텝에 `repeat:`를 적어도 조용히 무시된다(strict authoring gate 아님). 그래서 각 variant 구조체(`HttpStep`/`LoopStep`)에 개별로 `#[serde(deny_unknown_fields)]` 를 달았고, 진짜 strict 검증은 UI Zod 스키마(`StepSchema = discriminatedUnion("type", [...].strict())` + `do: z.array(HttpStepModel)`)가 담당한다. 엔진 타입은 `do_: Vec<Step>` 로 느슨하고(자유 중첩), 중첩 loop 거부는 Zod가 http만 받는 것으로 강제 — 두 레이어의 strict 책임이 다르다.
- **`async fn` 재귀는 `Box::pin` 필요**: `execute_steps` 가 `Step::Loop` arm 에서 자기 자신을 재귀 호출하므로 `async fn` 의 무한-크기 future 문제를 `Box::pin(execute_steps(...))` 로 푼다. **`Step::Loop` arm 에서만 박싱**하고 flat http 경로는 추가 박스 0개 — hot path 보존. 박싱 오버헤드가 진짜 무시 가능한지 Task 11 처리량 A/B로 검증(flat ~19,974 vs loop(repeat:1) ~19,449 RPS, 변동 범위 내; 위 Slice 7 결과 수치).
- **React Flow v12 parent/child(subflow)**: 자식 노드에 `parentId` + `extent: "parent"` 를 주고, **부모 노드에 명시적 `style` width/height** 를 줘야 자식이 컨테이너 bounds 안에 담긴다(부모 크기는 자동 산출 안 됨 — 자식 수에 맞춰 높이 계산). 그리고 full `<ReactFlow>` 를 jsdom 에서 처음 마운트하는 RTL 테스트는 `ResizeObserver` 폴리필 필요(xyflow 의 ZoomPane 이 ResizeObserver 를 요구) — `ui/src/test/setup.ts` 에 conditional 폴리필 추가. (Slice 3 의 `HttpStepNode` 단위 테스트는 노드만 렌더해서 안 걸렸다 — 이번에 full canvas 를 마운트하며 처음 드러남.)
- **plan/fixture 의 placeholder ULID `01HX000000000000000000000L` 은 INVALID**: ULID 는 Crockford base32(`[0-9A-HJKMNP-TV-Z]`)라 `I`/`L`/`O`/`U` 를 제외한다. spec/plan 의 `01HX...` 자리표시자를 그대로 테스트 fixture 에 박으면 ULID 파서가 거부한다. 테스트용 ULID 는 이 네 글자를 피해서 적을 것(`...0010` 등). (Task 5 에서 발견.)
- **`Step` 을 discriminated union 으로 바꾸면 모든 consumer 가 union narrowing 을 거쳐야 한다**: `.request`/`.assert`/`.extract` 를 직접 읽던 TS 코드가 전부 `tsc` union 에러를 낸다. Task 4(모델)→5(yamlDoc)→6(store)→7(canvas)→8(inspector)→9(report) 순서로 좁혀가며 해소. `flattenHttpSteps(steps)` 가 "트리에서 http leaf 만 평탄화" 하는 표준 헬퍼(report 라벨링·inspector 중첩 선택에 재사용) — 새 컨테이너 노드(Slice 8/9) 추가 시 이 헬퍼의 walk 만 확장하면 된다.
- **loop body 의 deadline 은 iteration 사이 AND body step 사이 둘 다 체크된다**: run window 끝에서 마지막 loop 이 mid-body 로 잘릴 수 있어 inner http 스텝의 `count` 가 정확히 `repeat` 의 배수가 아닐 수 있다(부분 iteration). 통합/e2e 테스트는 `count > 0 && error_count == 0` 만 단언하고, 정확한 `count % repeat == 0` 검증은 deadline 영향이 없는 엔진 통합 테스트(`crates/engine/tests/loop_node.rs`, fixed iteration 수)가 담당한다.
- **subagent-driven 실행 중 리뷰는 read-only 로만**: reviewer 가 옛 버전을 보려고 `git checkout <sha>` 를 쓰자 HEAD 가 detach 되어 브랜치 ref 가 안 따라온 사례. 리뷰는 `git diff`/`git show <sha>` 같은 read-only 명령만 쓰고, `checkout`/`switch`/`stash` 는 worktree 의 attached HEAD 를 깨므로 금지.

## Slice 7-1에서 배운 함정들

- **`profile_json` 저장 방식 덕분에 runs 테이블 스키마 변경 없이 새 profile 필드 추가 가능**: `loops_breakdown_cap` 같은 새 profile 필드는 `#[serde(default)]` 하나로 기존 행 호환 — 옛 rows가 역직렬화될 때 default 값(256)이 자동 채워진다. Slice-6의 `ALTER TABLE ADD COLUMN` idempotency 함정(migration 재실행 시 `duplicate column name`)과 대조적. profile에 새 필드를 더할 때는 **runs 테이블 migration이 필요 없다** — schema 변경은 profile 구조체의 `#[serde(default)]`만으로 처리.
- **엔진 메트릭 채널 payload를 `Vec<StepWindow>`에서 `MetricFlush`로 변경하면 모든 `run_scenario` 호출 사이트가 `flush.windows`로 바꿔야 한다**: `run_scenario`의 반환값/채널 타입을 교체하면 엔진을 직접 쓰는 모든 테스트(단위·통합·e2e)가 빌드 에러를 낸다. 새 타입으로 wrapping할 때 **모든 consumer를 한 PR에서 같이** 수정해야 한다 — 중간 상태 "일부만 새 타입" 은 컴파일이 안 됨.
- **overflow는 엔진/proto/DB에서 `u32::MAX` sentinel, controller는 `null` 변환**: controller와 UI는 cap 값을 알 필요 없이 `u32::MAX`(DB integer의 최대값 근처)를 만나면 `null`로 변환. 이 설계 덕분에 cap을 바꿔도 controller/UI 코드는 무변경 — sentinel 의미를 아는 레이어는 엔진(`aggregator.rs`)과 controller report 변환(`build_report`)만. DB를 직접 읽을 때는 `loop_index = 4294967295`가 "상한 초과" 행임을 알아야 한다.
- **prost 구조체는 exhaustive라 proto 필드 추가 시 literal construction 사이트를 모두 고쳐야 한다**: `MetricBatch`에 `loop_stats` 필드를 추가하면 `MetricBatch { windows: ..., /* loop_stats 빠짐 */ }` 형태의 struct literal이 전부 컴파일 에러를 낸다. prost-generated 타입은 `..Default::default()` spread가 동작하지 않으므로 각 literal 사이트에 `loop_stats: vec![]`(또는 실제 값)를 명시해야 한다. 새 proto 필드 추가 = crate-wide grep 필수.
- **flexbox `min-width:auto` 오버플로우 + `truncate`는 bounded width 필요 (이번 세션 UI 버그 2건의 공통 원인)**: `flex` row에서 `flex-1` 입력 옆 버튼이 칸 밖으로 밀려나는 건 flex item 기본 `min-width:auto` 때문 — 입력에 `min-w-0`, 트레일링 버튼에 `shrink-0`을 줘야 입력이 줄고 버튼이 안 밀린다(`VariablesPanel`/`RunDialog` add-row). 그리고 Tailwind `truncate`(=overflow-hidden+nowrap+ellipsis)는 **조상에 확정 너비가 있어야** 클립된다 — React Flow 노드는 너비가 콘텐츠로 자라므로 `CanvasView`에서 노드 `style.width`를 박고 노드 root에 `w-full box-border`를 줘야 긴 URL이 컨테이너 밖으로 안 자란다. 새 key-value 폼·새 캔버스 노드 추가 시 둘 다 확인.
- **엔진/시나리오 모델 변경 브랜치 pull·merge 후엔 `cargo build -p handicap-worker` 필수**: `cargo run -p handicap-controller`는 controller만 다시 빌드하고 `target/debug/worker`(subprocess가 spawn하는 그 바이너리)는 안 건드린다. 옛 워커는 새 스텝 타입을 못 읽어 run 시작 직후 exit 1 + controller 로그 `scenario parse: steps[0].type: unknown variant 'loop'`. **증상 함정**: 워커가 죽어도 run은 `failed`로 안 가고 `running`에 멈춘 채 요청수 0 — "run이 영영 running + 0 req"면 코드/네트워크보다 controller 로그의 worker exit를 먼저 본다(이 status-transition 갭은 `docs/followups-after-mvp1.md` "열린 항목 A"). 상세 → `docs/dev/ui-slice-7-manual-check.md`.

## Slice 8a에서 배운 함정들

- **form/JSON body가 이제 템플릿팅된다**: `executor.rs`는 8a부터 `Body::Form` 값 전체와 `Body::Json` 문자열 leaf에 `render`를 적용한다(이전엔 url·header·`Body::Raw`만). JSON은 number/bool/null·object 키를 보존하고 문자열 leaf만 치환(`render_json_value`). 따라서 `{{var}}`/`${ENV}`를 **form 값**·**JSON 문자열 leaf**에 써도 동작한다(form 키·JSON object 키는 렌더 안 됨 — authored 식별자로 그대로 전송). 숫자 주입(`{"age": {{age}}}`로 number)은 미지원 — 값은 문자열로만 들어간다.

## Slice 8b에서 배운 함정들

- **axum 기본 body limit 2MB가 multipart 업로드를 막는다 (이 슬라이스에서 잡은 진짜 버그)**: `DefaultBodyLimit`는 모든 라우트에 2MB 기본 상한을 적용하고 `Multipart`/`field.bytes()`도 그 대상이다. 데이터셋은 쉽게 2MB를 넘으므로 업로드/preview **POST 라우트에만** `.layer(DefaultBodyLimit::max(N))`로 상한을 올린다(전역 변경 금지 — `/runs`·`/scenarios`는 작은 JSON이라 기본 유지). axum 0.8에선 초과 시 413이 아니라 **400**으로 떨어진다. plan self-review가 '상한 없음 ✓'로 잘못 적었던 항목 — Task 3 코드리뷰에서 발견. 실제 행 수 게이트는 run-create(8c).
- **axum `multipart`는 별도 feature**: 워크스페이스 `axum` 줄에 `"multipart"`를 넣어야 `axum::extract::Multipart`가 쓰인다. per-crate feature 가산 병합이 안 되므로 워크스페이스 dependency 줄을 고쳐야 한다.
- **multipart 업로드 클라이언트는 content-type을 직접 설정하면 안 된다**: `ui/src/api/client.ts`의 `request`는 `content-type: application/json`을 강제 → FormData엔 못 쓴다. 별도 `requestMultipart`(헤더 미지정)로 브라우저가 boundary를 자동 설정하게 한다. DELETE(204, 빈 본문)는 `request(..., z.undefined())`로 기존 빈-본문 분기를 타게 해서 공유 `request` 시그니처를 안 건드린다. oneshot 테스트는 boundary 박은 본문을 손수 만든다(`datasets_api_test.rs::multipart`).
- **calamine API는 마이너 버전마다 시그니처가 바뀐다**: 0.26에선 `open_workbook_from_rs`의 에러 타입이 associated type이라 `Xlsx<Cursor<Vec<u8>>>`로 reader 타입을 명시하고 `map_err(|e: XlsxError| ...)`로 클로저 인자 타입을 박아야 추론된다. `Data` enum 변형(`Float`/`Int`/`Bool`/`DateTime(ExcelDateTime)`/`Error` 등)은 0.26 기준. 새로 핀할 땐 `cargo doc -p calamine`로 확인하고 `parse_xlsx`만 조정 — 로직 불변.
- **dataset_rows cascade는 앱 레벨**: SQLite FK cascade 대신 `DELETE FROM dataset_rows WHERE dataset_id=?`를 트랜잭션으로 먼저 실행. migration은 `CREATE TABLE IF NOT EXISTS`라 멱등(Slice 6/7-1 패턴, ALTER 회피).
- **§5↔§9 조정으로 preview 엔드포인트 추가**: `POST /api/datasets`(파싱+저장)와 별개로 `POST /api/datasets/preview`(파싱만)를 둬서 "저장 전 미리보기 + override 즉시 재파싱" UX 구현. 둘 다 같은 `parse_upload` 호출.
- **UploadPanel 라이브 미리보기는 요청 시퀀싱이 없다(8b 알려진 한계)**: 옵션을 빠르게 연속 변경하면 `previewDataset` 응답이 도착 순서대로 `setPreview`돼 stale 미리보기가 남을 수 있다. 단일 사용자 수동 조작 + 빠른 파싱이라 8b에선 무시 가능; 필요 시 seq-ref/AbortController로 가드.
- **워크트리 새 src 파일은 TDD-guard에 막힌다 — 깔끔한 우회**: guard는 새 파일 생성 전 작업트리에 pending test 파일(`tests/*.rs`·`*_test.rs`·`__tests__/*` 등)이 있어야 통과한다(새 파일의 인라인 `#[cfg(test)]`는 디스크에 아직 없어 무효). TDD 순서대로 **테스트 파일을 먼저** 만들면(통합 테스트나 `__tests__/*.test.tsx`) 자연히 unblock된다. 인라인-테스트만 있는 Rust 모듈은 임시 `crates/<x>/tests/_unblock.rs`를 만들고 **커밋 전 `rm`**(Slice 8b Task 1이 stub을 커밋해버려 따로 지운 전례 — 커밋 전에 지울 것).

## Slice 8c에서 배운 함정들

- **prost enum 필드는 `i32`로 전달된다**: controller가 `policy as i32`로 보내면 worker에서 `pb::data_binding::Policy::try_from(i32).expect("controller와 worker는 함께 배포되므로 unknown variant 불가")`로 변환. 이걸 `i32` 그대로 match하거나 `unwrap_or_default()`하면 조용히 `Unspecified`로 떨어진다. controller+worker는 동시 배포이므로 unknown variant는 invariant 위반 — `expect`로 명시적 panic이 의도된 선택.
- **proto struct literal 추가는 crate-wide churn을 일으킨다**: `RunPlan`에 `data_binding: Option<pb::DataBinding>`을 추가하면 `RunPlan { scenario_yaml, profile, .. }` 형태의 literal 전부(worker 테스트·engine 테스트 포함)가 컴파일 에러를 낸다. prost-generated 타입은 `..Default::default()` spread를 지원하지 않으므로 각 사이트에 `data_binding: None`을 명시해야 한다. 신규 proto 필드 추가 = workspace-wide grep으로 construction 사이트 전수 확인 필수. (Slice 7-1의 `MetricBatch::loop_stats` 함정과 동일.)
- **run-create handler에서 dataset meta를 두 번 fetch하면 TOCTOU 가능**: gate(row_count/column 검증)와 resolution(슬라이싱/seed 계산) 두 단계가 각각 `get_meta()`를 호출하면, gate 통과 후 dataset이 삭제된 경우 두 번째 `get_meta().expect()`가 패닉한다. meta를 한 번만 fetch해서 양쪽에 재사용할 것.
- **controller가 row_count를 전달 못 하면 `drop(tx)`로는 stream을 닫을 수 없다**: worker가 `row_count` 행을 기다리며 블로킹 중일 때 controller sender를 drop해도 `state.active`에 clone이 살아있어 stream이 실제로 닫히지 않는다. 대신 `ServerMessage::AbortRun`을 명시적으로 전송해야 worker의 대기가 해제된다.
- **worker `load_dataset`은 `abort_listener` spawn 전에 호출해야 한다**: `abort_listener`가 `inbound_rx`를 move하므로, 그 이후에 `load_dataset(&mut inbound_rx)`를 호출하면 빌림 에러. 실행 순서: `load_dataset` 완료 → `abort_listener` spawn.
- **UI 바인딩 검증은 extract/scenario.variables로 채워질 `{{var}}`를 false-alarm으로 막으면 안 된다**: `DataBindingPanel`이 "매핑 안 된 `{{var}}`가 있으면 invalid" 로직을 단순하게 쓰면, 실제로는 extract나 scenario.variables로 런타임에 채워지는 변수를 missing으로 표시해 유효한 시나리오를 blocking한다. 데이터셋이 선택된 상태에서만, 그리고 column 매핑이 실제로 존재하지 않는 열을 참조할 때만 invalid 처리해야 한다.
- **`Mapping` JSON shape은 Rust ↔ TS 양쪽이 동일해야 한다**: Rust `#[serde(tag="kind")]` 패턴이 생성하는 JSON(`{"kind":"column","var":"x","column":"col"}`)과 TS Zod `discriminatedUnion("kind", [{kind:"column",...},{kind:"literal",...}])`이 생성하는 JSON이 1:1 매치해야 한다. 한쪽에서 `type` 대신 `kind`를 쓰거나 필드명이 달라지면 profile_json 역직렬화가 조용히 실패한다. round-trip 통합 테스트(`datasets_binding_integration_test`)가 이 contract를 검증한다.
- **`profile_json` `#[serde(default)]`로 runs 테이블 migration 불필요**: 8c의 `data_binding` 필드는 `#[serde(default)]`이므로 옛 행 역직렬화 시 `None`으로 채워진다. Slice-6의 `ALTER TABLE ADD COLUMN` idempotency 함정 재발 없음. Slice 7-1에서 먼저 확립된 패턴이지만 8c에서 다시 한번 적용 — profile에 새 필드를 더할 때 **runs migration이 필요 없다**는 원칙을 내면화할 것.
- **cargo pre-commit hook은 UI 테스트/빌드를 실행하지 않는다**: hook은 `cargo fmt/build/clippy/test`만 돌리므로, UI TypeScript 에러는 `cd ui && pnpm test && pnpm build`를 수동으로 돌려야 잡힌다. 특히 `tsc -b`는 esbuild-transpile 기반 `pnpm test`가 놓치는 타입 에러(discriminated union 미스매치, Zod default 타입 누출 등)를 잡으므로 UI 변경이 있는 커밋 전에 반드시 실행.
- **`scanFlowVars`는 loop `do:` 배열 안까지 재귀 스캔해야 한다**: url/headers/body 외에 loop 스텝 `do:` 배열의 중첩 http 스텝도 동일하게 스캔하지 않으면, loop body 안의 `{{var}}`가 패널에서 보이지 않아 사용자가 매핑을 만들지 못한다. `flattenHttpSteps` 헬퍼(Slice 7에서 만든)를 재사용해 먼저 평탄화한 뒤 스캔하면 중복 구현 없이 해결.

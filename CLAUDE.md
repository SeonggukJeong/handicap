# Handicap

사내 QA·운영팀을 위한 부하 테스트 도구. REST API를 대상으로, **QA는 드래그-드롭으로 시나리오를 만들고**, **개발자는 같은 시나리오를 YAML/DSL로 편집** 한다 (두 뷰가 같은 모델의 양방향 sync). LoadRunner/JMeter를 사내에서 대체하는 것이 목표.

> **함정(gotcha) 노트는 도메인별 중첩 CLAUDE.md로 분할됨** — 각 디렉토리 파일을 그 디렉토리 작업 시 자동 로드한다. 이 루트 파일엔 전역 규칙·상태·크로스커팅 함정만 남긴다. 인덱스는 아래 [도메인별 함정 인덱스](#도메인별-함정-인덱스).

**상태: Slice 9a(if 엔진) + 9b(if UI authoring) 구현·머지 완료. 다음 = Slice 9c(상호 1레벨 중첩) → 9d(분기별 메트릭).** 후보 메뉴·연기 항목·착수 메모는 **`docs/roadmap.md`(post-MVP1 단일 진입점)** 에 정리됨 — "다음 뭐 하지?"는 거기부터 본다. (후보: Parallel 노드 / 멀티 워커·HPA / LoadRunner급 리포트, spec §4.5 메뉴.) (MVP 1단계 = 슬라이스 1–6, Slice 7 = loop 노드, Slice 8 = data-driven 3분할, Slice 9 = conditional 4분할 9a–9d.) 디자인 문서 → `docs/superpowers/specs/`. 구현 계획 → `docs/superpowers/plans/`. 결정 기록 → `docs/adr/`. **MVP 1단계 spec(`2026-05-27-handicap-mvp1-design.md`)은 슬라이스 1–6으로 전부 구현됨 — 후속은 그 spec §4.5 메뉴(노드 종류 확장 → 멀티 워커/HPA → LoadRunner급 리포트)에서 각자 새 spec/plan으로 나온다.**

Slice 1 결과: REST API(`/api/scenarios`, `/api/runs`, `/api/runs/{id}/metrics`) + gRPC Coordinator(bidi stream) + SQLite store + subprocess-spawn worker가 wiremock 타겟에 대해 end-to-end 동작.

Slice 2 결과: Vite + React + TS + Tailwind UI (`ui/`). 시나리오 목록·생성·편집(YAML textarea), run 다이얼로그, run 상세(1초 폴링 + 메트릭 표). 컨트롤러가 `--ui-dir` 경로의 SPA를 정적 서빙(unknown path는 index.html로 fallback). 캔버스·Monaco·양방향 sync는 Slice 3, 차트·HTML 리포트는 Slice 5, multi-step·extract·ramp-up은 Slice 4, K8s 배포는 Slice 6.

Slice 3 결과: React Flow 캔버스(HTTP 노드 1종, 선형 chain, drag-drop add, inspector) + Monaco YAML 에디터(syntax highlighting only) + Zustand store + Zod 검증 + `yaml` 패키지 Document API targeted edit. 양방향 sync는 탭 전환 모델: 캔버스/YAML 둘 중 하나가 active. Monaco 편집은 300ms debounce → 검증 통과 시 doc swap, 실패 시 pendingYamlText에 유지하고 inline 에러 표시. extract/multi-step variable chaining은 Slice 4, K8s 배포는 Slice 6.

Slice 4 결과: 엔진이 multi-step extract(JSONPath body / header / cookie / status)와 ${ENV:-default} 템플릿, 1초 단위 linear ramp-up, CancellationToken 기반 abort를 지원. 컨트롤러 `POST /api/runs/{id}/abort` → 워커가 in-flight run 취소. UI Inspector에 ExtractEditor, RunDetail에 Abort 버튼. 테스트: Rust unit + wiremock multi-step integration + proptest properties, UI RTL + fast-check round-trip. K8s 배포는 Slice 6, 차트·HTML 리포트는 Slice 5.

Slice 4 post-merge manual check: `RunDialog`가 `env`·`ramp_up_seconds`를 하드코딩하던 UI 갭을 메우고(M1), Run 상세에 Steps/Env/Profile 진단 패널을 추가(M2), 시나리오 URL을 env로 풀어 표시하는 client-side `resolveForDisplay` 도입(M3). 매뉴얼에 wiremock stub 등록 절차 명시(M4). 자세한 내용 → `docs/superpowers/plans/2026-05-28-slice-4-manual-check-fixes.md`.

Slice 5 결과: 종료된 run의 same-page Report 전환. Controller `GET /api/runs/{id}/report` 가 run + scenario_yaml snapshot + per-second windows(percentile 포함) + per-step + status 분포를 한 번에 번들. 엔진 `percentiles.rs` 가 V2 HDR Histogram BLOB을 deserialize + merge. UI Recharts (line/bar) + Summary + StepStatsTable + ScenarioSnapshot + JSON download. e2e `report_e2e_smoke` 가 워커 subprocess → 컨트롤러 → report 까지 검증. K8s 배포(Slice 6)는 아직.

Slice 6 결과: kind 단일 노드 + Helm chart 1개로 controller + worker가 K8s Job 로 동작. 컨트롤러가 `--worker-mode {subprocess,kubernetes}` 로 두 디스패치 경로 지원 (로컬 `cargo run` 은 subprocess 유지, 컨테이너는 kube-rs 로 Job 생성). 워커 SIGTERM 핸들러는 **connect 전에** 설치되고 backoff 도 cancellable 해서 K8s `terminationGracePeriodSeconds` 안에 graceful `Phase::Aborted` 보고. 컨트롤러 재시작 시 진행 중이던 run 을 `failed` + `message` 로 마크. `runs.message` 컬럼 추가 (migration 0002). GitHub Actions `.github/workflows/e2e-kind.yml` 가 PR 마다 `just e2e-kind` 를 실행. 성능 acceptance(§4.3 5,000 RPS 목표) 는 manual + `just bench-throughput` — post-Slice-6 baseline 20,389 RPS / p95 17ms / p99 24ms (200 VUs × 30s, 1KB body). ADR-0019 추가.

Slice 7 결과: 첫 control-flow 노드 `type: loop` 를 end-to-end 추가. 엔진 `Step` 을 internally-tagged enum(`Step::Http`/`Step::Loop`, `#[serde(tag="type")]`)으로 확장하고, 인터프리터를 재귀 `execute_steps(steps, ctx)` 로 전환 — `Step::Loop` arm 만 `0..repeat` 를 돌며 `do_` 를 재귀 실행. `${loop_index}` 0-based 시스템 변수(loop 밖 참조 시 `EngineError::UnknownVar`). `LoopStep.do_: Vec<Step>` 결정(명세 §4.1 의 `Vec<HttpStep>` 에서 변경 — 엔진은 자유 중첩 허용, 단일 레벨 강제는 UI Zod `do: z.array(HttpStepModel)`; 이유는 internally-tagged + `Vec<HttpStep>` 이면 직렬화 시 내부 스텝 `type: http` 가 빠져 round-trip 깨짐, 그리고 Slice 8/9 컨테이너 노드 포석). UI 는 React Flow 부모/자식 subflow 컨테이너(loop 안에 http 자식). **컨트롤러 무변경** — 메트릭은 step_id 집계, step 라벨링은 UI `flattenHttpSteps` 가 `do:` 를 재귀 평탄화. 메트릭 의미: 내부 http 스텝 `count` 는 `repeat` 배 누적되나 distinct step_id 개수는 불변(리포트 행 수 영향 없음). 성능(Task 11 A/B, 200 VUs × 20s, 1KB body, 동일 머신): flat ~19,974 RPS / loop(repeat:1) ~19,449 RPS — ~2.6% 차이는 run-to-run 변동(±5–7%) 범위 내(한 페어에선 loop 가 flat 을 앞섬), p95 17–18ms / p99 24–25ms 양쪽 동일. `Box::pin`-per-iteration 오버헤드는 HTTP round-trip 대비 무시 가능. ADR-0020 추가.

**Slice 7-1 결과:** loop 노드 리포트에 **반복 인덱스별(per-`loop_index`) 요청·오류 수 breakdown** 추가 (counts-only, 레이턴시 breakdown 없음). Run 다이얼로그에 `loop_breakdown_cap` 설정(0=off, default 256, max 10000; controller가 >10000 거부). cap 초과 `loop_index`는 엔진에서 `u32::MAX` sentinel 버킷으로 fold → report에서 `loop_index: null`, UI에서 "그 외 (상한 초과)" 행으로 렌더. 파이프라인: RunDialog → REST profile → proto `Profile.loop_breakdown_cap` → 엔진 `Aggregator` per-(step_id,loop_index) counts → `MetricFlush.loop_stats` → gRPC `MetricBatch.loop_stats` (delta) → controller `run_loop_metrics` 테이블(migration 0003, `CREATE TABLE IF NOT EXISTS` — idempotent) UPSERT-accumulate → `ReportStep.loop_breakdown` → UI StepStatsTable caret drill-down. `runs` 테이블 무변경 — profile은 `profile_json` JSON 컬럼이라 새 필드는 `#[serde(default)]`만으로 기존 행 호환. 성능 A/B(SCENARIO_KIND=loop, 200 VUs × 20s, 1KB body): cap=0(off) → 19,086 RPS p50/p95/p99=9/18/26ms, cap=256(on) → 21,254 RPS p50/p95/p99=8/16/23ms — breakdown ON은 run-to-run 변동 범위 내, 측정 가능한 회귀 없음. ADR-0021 추가.

**Slice 8a 결과:** form/JSON body 템플릿팅(데이터 주입의 전제조건, 데이터셋과 독립 출하). `executor.rs`가 `Body::Form(map)` 각 값 + `Body::Json(v)`의 **문자열 leaf**에 `render` 적용 — 이전엔 url·header·`Body::Raw`만 치환됐다. JSON은 `render_json_value` 재귀 헬퍼로 number/bool/null·object 키를 보존하고 문자열 leaf만 치환(form 키도 authored 식별자라 미렌더). 미바인딩(`{{}}` 토큰 없음)이면 출력 불변 = 하위 호환. 숫자 주입(`{"age": {{age}}}`로 number)은 미지원 — 값은 문자열로만. master `2f6f12b`. 함정 → `crates/engine/CLAUDE.md`.

**Slice 8b 결과:** CSV/XLSX 업로드 → controller 서버 파싱 → 독립 `datasets`/`dataset_rows` 리소스(migration 0004, `CREATE TABLE IF NOT EXISTS` 멱등)로 저장하는 데이터셋 관리 기능. `/api/datasets` REST: multipart `POST`(파싱+저장), parse-only `POST /datasets/preview`(저장 안 함), `GET` 목록, `GET /{id}`(메타+sample 20행), `DELETE`(8b 무조건 삭제, 참조 409 가드는 8c). 파싱은 순수 모듈 `crates/controller/src/datasets/parse.rs`(csv 1.4 + calamine 0.26 + encoding_rs 0.8): 구분자(`,`/`;`/`\t`) 자동감지, UTF-8 BOM strip + CP949 fallback, XLSX 단일/다중 시트, 헤더 없음→`colN`, 빈/중복 컬럼명 정규화, 짧은 행 빈 문자열 패딩. 행은 `{"col":"value"}` JSON으로 저장. UI `/datasets` 페이지(목록+삭제) + UploadPanel(드래그드롭/파일선택 + header/delimiter/encoding/sheet override + 저장 전 라이브 미리보기 + 저장). **워커·엔진·proto·runs 테이블 무변경** — 데이터 주입/바인딩은 8c(`profile_json` 새 필드). 업로드 본문 상한은 업로드/preview POST 라우트에만 `DefaultBodyLimit::max(256MiB)`(axum 기본 2MB로는 실제 데이터셋 업로드가 막힘). ADR-0022 추가.

**Slice 8c 결과:** CSV/XLSX 데이터셋 행을 `{{var}}` 흐름 변수로 런타임 주입하는 data-driven 실행 완성. 파이프라인: `RunDialog DataBindingPanel`(시나리오 YAML에서 `{{var}}`를 `scanFlowVars`로 스캔 → 열/리터럴 매핑 + 정책 선택 + 검증) → `profile_json.data_binding`(`#[serde(default)]`, runs 테이블 무변경) → run-create 검증 게이트(미구현 정책·없는 데이터셋·빈 데이터셋·없는 컬럼·`iter_*` 시 `--dataset-max-rows` 초과 거부) → controller `PendingDataBinding` 해석(FNV-1a seed + 정책별 row_count 슬라이싱: `per_vu=min(vus,rows)`, `iter_*=전체`) → worker Register 시 `apply_mappings`된 `{var:value}` 행을 `DatasetBatch` gRPC 메시지로 스트리밍(컬럼명 비노출) → worker 로딩 단계(엔진 시작 전 `row_count` 행 수신 완료; abort/cancel→Aborted, 조기 종료→Failed; controller는 전달 불가 시 `AbortRun` 전송) → 엔진 반복마다 정책 인덱스로 행 선택 + `iter_vars` overlay(우선순위: scenario.variables < dataset < extract). 3 정책: `per_vu`(vu_id % rows, 고정), `iter_sequential`(worker-local `AtomicU64` fetch_add % rows), `iter_random`(splitmix64-seeded `StdRng` — 재현 가능). `unique` 예약(멀티-워커 전역 커서 필요, API 거부). `None` binding = byte-identical pre-8c(하위 호환). 성능: 벤치 하네스(`just bench-throughput`)는 body-injection 시나리오를 구동하지 못하고(8c 이전 작성, `data_binding` profile 미지원), Task 12에서 release 빌드를 재실행하지 않았다. 대신 해석적 분석: `None` binding 경로는 pre-8c와 byte-identical이므로 구조적 no-op(documented prior baseline ~20,000 RPS). binding 경로의 반복당 비용은 modulo 1회 또는 splitmix64+StdRng 1회 + BTreeMap clone-insert — 나노초 단위, HTTP round-trip에 완전히 묻힘(Slice 8a와 동일 결론). 민감값 마스킹·JSON 숫자 주입·Helm values 노출·멀티워커 HPA는 후속. 함정 → 각 도메인 `CLAUDE.md`. ADR-0022 업데이트.

**Slice 9a 결과:** 두 번째 control-flow 노드 `type: if` 의 **엔진**을 end-to-end 추가 (UI/중첩/메트릭은 9b–9d). `Step` enum 에 `Step::If` arm 추가, 평탄 `if`/`elif[]`/`else` 분기 + 재귀 조건 트리(`leaf{left,op,right}` / `all[]` / `any[]`) + 10개 비교 연산자(eq/ne/contains/matches/lt/gt/lte/gte/exists/empty). 조건 평가는 lenient — 미바인딩 변수·파싱 실패는 false 로 떨어지고 run 을 죽이지 않음. 흐름 변수가 전부 문자열이라 숫자 비교(lt/gt/…)는 양쪽을 파싱, 실패 시 false. 분기 자유 중첩은 엔진이 허용하나 9a 단계 강제는 "상호 1레벨"(if↔loop). ADR-0023 추가.

**Slice 9b 결과:** `type: if` 의 **UI authoring** (캔버스 + YAML 양방향). Zod 모델(`ui/src/scenario/model.ts`)에 `ConditionModel` — 코드베이스 **최초 `z.lazy`** 재귀 `z.union`(3 형태가 공통 discriminant 가 없어 discriminatedUnion 아님; `left`/`all`/`any` 존재로 구분, 명시적 `z.ZodType<Condition>` 주석 필수) — 과 `IfStepModel`(`elif`/`else` `.default([])`, 분기는 `z.array(HttpStepModel)` = **http-only**) 추가, `StepModel` 은 http|loop|if 3-way discriminatedUnion 으로 확장. 캔버스에 if 컨테이너 노드(`IfStepNode.tsx`, 헤더 + 조건 요약 + THEN/ELIF/ELSE 밴드 라벨) + "+ Add if" 툴바. Inspector 에 재귀 `ConditionEditor` — `ExtractEditor` 커밋 패턴(로컬 draft + 텍스트 onBlur 커밋, 구조 변경 즉시 커밋)을 **index-path 로 편집하는 불변 Condition 트리**(`setAtPath`/`removeAtPath`) 위에 올림 — + 분기별 `BranchPanel`("+ Add step"), elif 추가/삭제, `matches` 연산자 정규식 유효성 경고. 조건 빌더는 **빈 그룹을 만들 수 없음**(엔진 `All([])` 이 vacuous-true 라): "+ group" 은 leaf 하나를 시드, 자식 1개뿐인 그룹은 child 의 "×" 제거 버튼 숨김. `yamlDoc.ts` 에 재귀 `findStepPath`(do/then/else/elif[].then 하강 — 9c 포석) + `normalizeStep`(if) + `cleanCond`(exists/empty 일 때 `right` 생략) + 6 Edit variant(addIfStep/setIfCond/setElifCond/addStepInBranch/addElif/removeElif), store 에 동명 thin action. **컨트롤러·proto·워커·메트릭·runs 테이블 무변경** — 분기별 메트릭 breakdown 은 **9d**, if↔loop 상호 1레벨 중첩(분기는 9b 에서 http-only)은 **9c**. 함정 → `ui/CLAUDE.md`. (게이트: `pnpm build` = `tsc -b`.)

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

`.git/hooks/pre-commit`이 모든 커밋에 대해 `cargo fmt --check + cargo build --workspace + cargo clippy --workspace --all-targets -- -D warnings + cargo test --workspace`를 실행한다 (워크스페이스가 coherent하지 않으면 per-crate 모드로 fallback). **단, staged 파일이 전부 `.md`면 cargo 검사를 통째로 skip한다** (docs-only 커밋 빠른 통과 — `git diff --cached --name-only`에 비-`.md`가 하나라도(삭제된 `.rs` 포함) 섞이면 전체 검사. 가드는 `grep -qvE`의 `-q`+`-v` 종료코드가 zsh에서 뒤집히는 이식성 quirk를 피해 "출력 비었는지" 검사 형태로 작성됨). 이 hook 본체는 `.git/hooks/`(버전 관리 안 됨)라 변경은 이 클론에만 로컬 적용. hook은 git common dir에 있어 모든 worktree에 적용된다. 새 머신에서는 `chmod +x .git/hooks/pre-commit`이 한 번 필요할 수 있다. Slice 4 후속에서 clippy gate가 추가됨 — `next_spawn += ...` 같은 `assign_op_pattern`/`expect_fun_call` 회귀가 prod로 안 들어오게 차단(단위·통합 테스트가 다 통과해도 clippy는 다른 클래스를 잡는다). **워크트리 안에서 `.git`은 디렉토리가 아니라 파일**이라 `.git/hooks/pre-commit`을 직접 호출하면 "Not a directory" — `bash $(git rev-parse --git-common-dir)/hooks/pre-commit`로 절대 경로 풀어 실행. **단, hook은 `cargo`만 돌린다 — UI(TypeScript) 변경은 `cd ui && pnpm test && pnpm build`를 수동으로 돌려야 `tsc -b` 타입 에러(discriminated union 미스매치, Zod default 누출 등)를 잡는다(Slice 8c).**

`.claude/hooks/tdd-guard.sh`는 Claude의 PreToolUse 훅으로, Write/Edit가 `crates/*/src/*.rs` 또는 `ui/src/*.{ts,tsx,js,jsx}`를 만지려 할 때 작업트리에 pending test 파일(`tests/*.rs`, `*_test.rs`, `*.test.{ts,tsx}`, `*.spec.{ts,tsx}`, `__tests__/*`)이 하나도 없으면 차단한다. UI scaffolding처럼 그 작업 단위에 실제 동작 테스트가 없을 때는 `ui/src/__tests__/<name>.test.tsx`에 `it.todo("...")` 한 줄을 먼저 적어 pending diff를 만든 다음 production 파일을 작성하는 게 표준 패턴 — 진짜 테스트는 그 슬라이스의 testing 단계에서 채운다. 인라인 `#[cfg(test)] mod tests`가 있는 Rust 파일은 자동으로 통과. **Rust 쪽도 같은 stub 패턴 사용 가능** — production 변경이 큰데 인라인 test가 없을 때 `crates/<x>/tests/<feature>_wiring.rs`에 컴파일만 되는 placeholder를 먼저 만들면 guard 통과(작업이 끝나면 인라인 `mod tests`로 정리, **커밋 전 임시 stub은 `rm`**). 새 src 파일은 디스크의 pending test 파일이 있어야 통과하므로 TDD 순서대로 **테스트 파일을 먼저** 만들면 자연히 unblock된다. guard는 편집 파일의 디렉터리에서 `git rev-parse --show-toplevel`로 working tree를 찾으므로 worktree 안에서도 정확히 동작한다.

`--no-verify`로 hook 우회 금지 (사용자 명시 요청 없이는). 회귀가 생긴 채로 커밋이 들어가면 후속 작업이 모두 빨갛게 됨.

**이 repo의 git 토폴로지**: 통합 브랜치는 `master` (`main` 없음 — 세션 시작 컨텍스트의 "Main branch: main"은 부정확), **remote 미설정**. 브랜치 마무리는 push/PR이 아니라 로컬 fast-forward: `git checkout master && git merge --ff-only <branch>`. 세션이 길어 그 사이 master가 전진하면 ff-only가 깨지므로 **브랜치를 master에 rebase 후 ff-merge**(Slice 9a 때 docs 커밋이 끼어듦; 파일 겹침 없으면 충돌 0). 사내 K8s 도입 시 remote 붙이면 PR 흐름 가능. 슬라이스 작업은 `.claude/worktrees/<name>` worktree에서 진행 — **네이티브 `EnterWorktree` 사용 시 remote가 없어 기본 `worktree.baseRef`(`fresh`=`origin/<default>`)가 실패**하니 `.claude/settings.local.json`(gitignored)에 `worktree.baseRef: head` 필요(로컬 HEAD에서 분기). 정리는 harness 소유 경로(`.claude/worktrees/`)라 `git worktree remove`가 아니라 **`ExitWorktree`** 로 — 단 ff-merge 후에도 `ExitWorktree(remove)`는 워크트리 *생성 base* 기준 커밋 수를 세어 "N commits discarded"로 거부하므로, master에 머지 끝났음을 확인한 뒤 `discard_changes: true`로 재호출(커밋은 이미 master에 안전).

## 디렉토리 (MVP 계획)

```
crates/
  engine/        Rust 부하 생성 엔진 (라이브러리)   — 함정: crates/engine/CLAUDE.md
  controller/    Rust 바이너리, 워커 오케스트레이션, HTTP API 서빙 — 함정: crates/controller/CLAUDE.md
  worker/        Rust 바이너리, 컨트롤러 지시로 시나리오 실행
  worker-core/   Rust 라이브러리, 재연결/backoff/시그널 (단위 테스트용) — 함정: crates/worker-core/CLAUDE.md
  proto/         gRPC 정의 (controller↔worker)
ui/              TypeScript/React 웹앱 (Vite + React Flow + Monaco) — 함정: ui/CLAUDE.md
deploy/
  helm/          K8s 배포용 Helm chart                — 함정: deploy/CLAUDE.md
  kind/          로컬 kind cluster 설정
docs/
  superpowers/specs/   설계 문서
  superpowers/plans/   구현 계획
  dev/                 개발자 runbook (UI 수동 점검 등)
  adr/                 결정 기록 (MADR 포맷)
```

## 도메인별 함정 인덱스

도메인 함정 노트는 각 디렉토리의 중첩 `CLAUDE.md`에 있고, 그 디렉토리 파일을 건드릴 때 자동 로드된다. 다른 도메인 함정을 미리 보려면 직접 읽을 것.

| 파일 | 다루는 함정 |
|---|---|
| `crates/engine/CLAUDE.md` | serde enum round-trip, internally-tagged, JSONPath/cookie extract, form/JSON body 템플릿팅, loop `Box::pin` 재귀·deadline, HDR merge bound, MetricFlush 채널, ULID fixture |
| `crates/controller/CLAUDE.md` | axum path/nest/ServeDir·body-limit/multipart, report 빌드(HDR 내성·snapshot·ms 단위·step 라벨링은 UI), SQLite ALTER 멱등·profile_json, calamine 파싱, prost exhaustive·proto enum·abort 중복 |
| `crates/worker-core/CLAUDE.md` | bin→lib 분리, tonic 에러 타입·gRPC clean shutdown, tokio time pause+Instant, cancellable sleep/SIGTERM |
| `ui/CLAUDE.md` | pnpm build 게이트·Zod default 누출, React Flow/Monaco/Zustand, yaml Document API 양방향 sync·dirty-flag, React Query·multipart client, jsdom·blob 다운로드, 폼 UX·resolveForDisplay, CSP 오프라인 |
| `deploy/CLAUDE.md` | Helm fullname/PVC/snapshot, Dockerfile no-CMD·Node OOM, port-forward 함정 4종, K8s 테스트 격리 |

## 로컬 dev 실행 함정 (크로스커팅)

먼저 `dev-doctor` 스킬로 자동 진단 가능. 핵심 footgun:

- **`cargo run -p handicap-controller`만 쓰면 깨진다**: `handicap-controller` 패키지엔 바이너리가 둘(`controller` + `e2e_kind_driver`)이라 `error: could not determine which binary to run`. 로컬 실행은 **항상 `cargo run -p handicap-controller --bin controller -- …`** (또는 `just run-controller`/`run-controller-with-ui` — 이미 `--bin controller` 고정).
- **엔진/시나리오 모델 변경 브랜치 pull·merge 후엔 `cargo build -p handicap-worker` 필수**: `cargo run -p handicap-controller`는 controller만 빌드하고 `target/debug/worker`(subprocess가 spawn하는 그 바이너리)는 안 건드린다. 옛 워커는 새 스텝 타입을 못 읽어 run 시작 직후 exit 1. **증상 함정**: 워커가 죽어도 run은 `failed`로 안 가고 `running`에 멈춘 채 요청수 0 — **"run이 영영 running + 0 req"면 코드/네트워크보다 controller 로그의 worker exit를 먼저 본다**(status-transition 갭 = `docs/followups-after-mvp1.md` "열린 항목 A"). 상세 → `docs/dev/ui-slice-7-manual-check.md`.
- **status=0 + 비정상적으로 높은 RPS = HTTP 도달 전 단계 실패**: connection refused / URL parse / DNS 등 fail-fast. 진짜 5xx는 RPS가 정상 범위. 점검 순서: 시나리오 URL이 host 없는 `/login`인지, wiremock이 죽었는지, env가 빈 채로 `${BASE_URL}`이 unresolved인지.
- **여러 워크트리에서 `pnpm dev`(5173)·`cargo run --bin controller`(8080) 포트 선점**: 다른 워크트리/master에서 띄운 프로세스가 살아있으면 stale 번들을 서빙하거나 잘못된 DB에 붙는다. 증상: 컨트롤러는 새 빌드(curl 200)인데 UI에서 새 기능이 동작 안 함. `lsof -i :5173`/`:8080` → `ps -o cwd= -p <PID>`로 워크트리 확인 → stray 죽이고 현재 워크트리에서 재시작 + 브라우저 hard reload. (kind port-forward 8080/9001 충돌·재기동은 `deploy/CLAUDE.md`.)

## Subagent dispatch 노하우

- **워크트리에서 subagent를 띄울 땐 prompt 첫 줄에 `cd /Users/sgj/develop/handicap/.claude/worktrees/<name>` 명시**: 안 하면 spec-reviewer 같은 lightweight 모델이 메인 체크아웃을 읽고 "코드가 없다"고 잘못 보고한다. 절대 경로로 박는 게 가장 안전.
- **각 task마다 두 단계 review (spec compliance → code quality)**: spec reviewer는 plan 대비 빠짐/추가를 보고, code quality reviewer는 idiom/race/test 품질을 본다. 두 reviewer가 모두 APPROVED여야 다음 task로.
- **subagent-driven 실행 중 리뷰는 read-only 로만**: reviewer 가 옛 버전을 보려고 `git checkout <sha>` 를 쓰면 HEAD 가 detach 되어 브랜치 ref 가 안 따라온다. 리뷰는 `git diff`/`git show <sha>` 같은 read-only 명령만 — `checkout`/`switch`/`stash` 는 worktree 의 attached HEAD 를 깨므로 금지.
- **다른 슬라이스로 미룬 항목을 코드 주석으로만 남기면 다음 슬라이스 plan이 놓친다** (Slice 8c): 8b가 `api/datasets.rs`에 `// 참조 가드는 8c`로 미룬 DELETE 409 가드를 8c plan이 안 주워, 최종 whole-feature 리뷰에서야 발견(Task 13으로 추가). 후속 슬라이스 scoping 때 `grep -rn "<해당 슬라이스>" crates/ docs/`로 deferral 주석을 한 번 훑을 것.
- **리뷰-수정 루프는 fresh fix-subagent로** (Slice 9b): subagent-driven 스킬은 "같은 subagent가 fix"라지만 이 하니스엔 `SendMessage`/subagent resume가 없다 — 리뷰가 이슈를 찾으면 finding + `file:line` + 정확한 fix를 담은 **새 self-contained subagent**를 띄운다(컨텍스트 상속 안 됨). fix 후 그 diff만 focused 재리뷰.
- **code-quality 리뷰어의 "APPROVED, but Important·나중에 fold 가능"이 spec invariant 위반이면 미루지 말 것** (Slice 9b): 9b 조건 빌더 ×버튼이 빈 그룹(engine `All([])` vacuous-true, spec §3.2 "UI는 빈 그룹 금지" 위반)을 만들 수 있던 걸 리뷰어가 "later polish"로 표시했지만, spec 보장 위반이라 그 슬라이스 안에서 fix(위 deferral 함정과 같은 맥락 — 미룬 건 사라진다).
- **최종 whole-feature 리뷰는 `handicap-reviewer` 에이전트로** (Slice 9b): repo-trap-aware라 per-task 리뷰가 구조상 못 보는 크로스커팅을 잡는다 — 특히 UI Zod 모델 ↔ 엔진 serde **와이어포맷 1:1 대조**(field명·연산자·`right` 생략 등), deferral 추적, build/lint 게이트 재확인.

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
- **0023** Conditional 노드: 평탄 if/elif/else + 재귀 조건 트리 + lenient 평가 + 상호 1레벨 중첩 (9a 엔진 + 9b UI authoring 출하, 중첩은 9c·분기별 메트릭은 9d)

## 코딩 컨벤션

- **Rust**: `cargo fmt`, `cargo clippy -- -D warnings`, 테스트 `cargo test`. workspace `members = ["crates/*"]` glob — 새 crate는 `crates/<name>/Cargo.toml`만 만들면 자동 인식.
- **TypeScript**: prettier + eslint, 테스트 vitest. **`pnpm build`(`tsc -b && vite build`)가 최종 게이트** — `pnpm test`(jsdom + esbuild transpile)는 TS strict 에러를 안 잡는 경우가 있다. UI 변경 commit 전 `pnpm build`까지 한 번 돌리는 게 안전. 자세한 함정 → `ui/CLAUDE.md`.

## 새로운 아키텍처 결정이 생기면

`docs/adr/`에 새 ADR 파일 추가 (다음 번호 사용, MADR 포맷). 이 CLAUDE.md의 "알아둘 결정들" 목록에도 한 줄 추가.

## 새 함정을 배우면

그 함정이 속한 **도메인 디렉토리의 `CLAUDE.md`** 에 한 줄 추가(인라인 `(Slice N)` 출처 태그 유지). 여러 crate에 걸친 크로스커팅 함정·프로세스 노트·로컬 dev 실행 footgun만 이 루트 파일에. 새 도메인 디렉토리가 생기면 위 [도메인별 함정 인덱스](#도메인별-함정-인덱스) 표에 행 추가.

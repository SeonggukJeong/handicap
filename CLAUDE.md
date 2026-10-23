# Handicap

사내 QA·운영팀을 위한 부하 테스트 도구. REST API를 대상으로, **QA는 드래그-드롭으로 시나리오를 만들고**, **개발자는 같은 시나리오를 YAML/DSL로 편집** 한다 (두 뷰가 같은 모델의 양방향 sync). LoadRunner/JMeter를 사내에서 대체하는 것이 목표.

> 도메인 함정은 각 디렉토리의 중첩 `CLAUDE.md`(그 디렉토리 작업 시 자동 로드) — [도메인별 함정 인덱스](#도메인별-함정-인덱스). 이 root엔 전역 규칙·상태·크로스커팅 함정만.

**상태: MVP 1단계(슬라이스 1–9) 완료 + post-MVP1 영역 A(프리셋·멀티워커 fan-out·Parallel·리포트 export/insights)·B(환경·SLO criteria·리포트 깊이)·C(에디터 test-run)·D(부하모델·페이싱: 타임아웃/think-time/open-loop/stages/VU 곡선) + Run 스케줄러 + 영역 U(UX, ADR-0035) + 운영 모니터 모드 ①a·①b(ADR-0053) + 후속 다수까지 구현·머지 완료. 최신 = ops-monitor-1b (2026-10-23, 코드 83cf82eb..b1411e2c — 클릭으로 성공 조건 + 화면 방식 A·C). 완료 이력·구현 결과·함정 출처 → `docs/build-log.md`(단일 소스), 다음 작업 → `docs/roadmap-status.md`(현황판), 후보·연기 상세 → `docs/roadmap.md`, 결정 → [알아둘 결정들](#알아둘-결정들)·`docs/adr/`, 설계 → `docs/superpowers/specs/`(MVP1 = `2026-05-27-handicap-mvp1-design.md`), 계획 → `docs/superpowers/plans/`.**

## 한 줄 아키텍처

Rust 엔진(컨트롤러 + 워커, K8s Pod로 배포) + TypeScript/React 웹 UI. 워커가 컨트롤러에서 시나리오를 받아 실행하고, 종료 후 상세 HTML/JSON 리포트 생성. 라이브 대시보드는 MVP 범위 밖(ADR-0009 — 실시간은 APM; in-run 진행 차트만 ADR-0051로 허용 — 기존 1s 폴링 데이터의 클라 표시).

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

# git 훅 설치 (클론마다 1회 — core.hooksPath를 tracked .githooks/로)
just install-hooks

# 전체 게이트
just build && just lint && just test
```

`rust-toolchain.toml`이 **정확한 Rust 버전**을 고정(워크플로·`deploy/Dockerfile`이 거울 — 로컬 pre-commit clippy = CI clippy). 승급은 **`just bump-rust <X.Y.Z>`**(새 lint는 그 커밋에서 수정). 다른 버전 시험 시 `CARGO_TARGET_DIR`는 **절대경로**(상대경로면 `crates/*/target/`에 GB급 빌드). **`just install-hooks`는 클론마다 필수** — 안 하면 게이트 없이 커밋된다. 상세 `docs/dev/commit-gates-and-git-workflow.md`.

## 검증 자동화 (Git + Claude hooks)

`.githooks/pre-commit` **층상 게이트**: ⓪ conflict-marker 가드 → ① `ui/`(non-`.md`) staged면 UI 게이트(`pnpm lint && pnpm test && pnpm build`) → ② cargo-영향 경로(`crates/`·`Cargo.*`·`.proto`·`.sql`·`rust-toolchain.toml`·`.cargo/`; `.md` 제외) staged면 cargo 게이트(`fmt --check`·build·`clippy -D warnings`·`nextest`·doctest). cargo-영향 경로가 없으면 cargo 통째 skip, 주석/공백-only `.rs` diff면 nextest/doctest만 skip.

**매 커밋 일상 규칙:** ① cargo-영향 커밋은 수 분 → `git commit`을 `run_in_background`, 그동안 다른 `cargo` 금지(`target/` 락). ② **커밋·게이트에 `| tail`/`| head` 파이프 금지**(종료코드 마스킹, git-guard deny) — 판정은 `; echo exit=$?`, 커밋 후 `git log -1`로 landed 확인. ③ **`--no-verify` 금지**(사용자 명시 요청 없이는). ④ 커밋 전 `git diff --cached --name-only`로 staged 확인 — 빈-staged는 full 게이트 후 'nothing to commit', macOS에서 케이스 틀린 `git add`(`justfile`↔`Justfile`)는 조용히 0건. ⑤ **워크트리-격리 세션은 "검증 불가" 형태의 git/gh/python을 거부** — `$VAR` 경로·`cd … && git …`·`;`/`|` 복합·`--jq '…|…'`·`git` 든 heredoc·문자열 `.github`·`PATH=…:$PATH`·인자 속 `$(…)`. 단독 호출·리터럴 경로로(스크립트는 Write 도구로 파일에, 커밋 메시지는 `-F <파일>`, 문서 스플라이스는 Edit).

**Claude PreToolUse 훅 4종**(`.claude/hooks/`): `tdd-guard.sh`(src 편집 시 pending test 없으면 차단 — 인라인 `#[cfg(test)]`/`it.todo` stub로 unblock), `git-guard.sh`(파이프 커밋·`--no-verify` deny, `checkout/switch/stash` ask), `controller-bin-guard.sh`(`--bin` 없는 `cargo run -p handicap-controller` deny), `spec-review-guard.sh`(브랜치 plan에 EOL-앵커 `REVIEW-GATE: APPROVED` 없으면 `crates/*/src`·`ui/src` 편집 deny — 브랜치에 추가된 `plans/*.md` **전부**가 plan이므로 동반 문서는 `specs/`에). 스킬: `/start-slice`·`/finish-slice`·`/new-migration`·`/live-verify`.

**git 토폴로지:** 통합 브랜치 `master`(`main` 없음), remote `origin`=`github.com/SeonggukJeong/handicap`(**PUBLIC** — push 전 민감정보 주의). 슬라이스 마무리는 **로컬 ff-merge(PR 아님)** + master 주기적 push. 릴리즈 = `v*` 태그 push → `release.yml`이 Windows 인스톨러·포터블 exe·macOS dmg를 GitHub Release로 자동 게시(절차 `docs/dev/tauri-desktop-build.md` §CI 릴리즈, 태그 전 master CI 녹색 확인). 머지 = `merge --ff-only worktree-<X>`(사전 `merge-base --is-ancestor master worktree-<X>` + 메인 `status --porcelain -uno` clean) — 워크트리-격리 세션은 `git -C <메인>`을 거부하므로 `ExitWorktree(keep)` 후 메인에서 실행하고 정리는 수동(`/finish-slice` §5–6), 격리가 아니면 워크트리 안에서 `git -C /Users/sgj/develop/handicap …` 후 `ExitWorktree(remove, discard_changes:true)`. **`EnterWorktree(name: X)` → 브랜치 `worktree-X`·디렉토리 `X`(비대칭)**.

> **전체 디테일·이력·엣지케이스** → **[`docs/dev/commit-gates-and-git-workflow.md`](docs/dev/commit-gates-and-git-workflow.md)** (게이트 명령 전체·단독 커밋 불가 2종+커밋 folding·cold-build flake S-A/S-D·tdd-guard 내용기반 예외·C-1 keepalive·git-guard 정밀화 이력·worktree rebase/docs-충돌 해소/`ExitWorktree` subagent-cwd-override 엣지). "예전엔 왜 이랬나" 디버깅 참조는 거기.

## 디렉토리 (MVP 계획)

```
crates/
  engine/        Rust 부하 생성 엔진 (라이브러리)   — 함정: crates/engine/CLAUDE.md
  controller/    Rust 바이너리, 워커 오케스트레이션, HTTP API 서빙 — 함정: crates/controller/CLAUDE.md
  worker/        Rust 바이너리, 컨트롤러 지시로 시나리오 실행
  worker-core/   Rust 라이브러리, 재연결/backoff/시그널 (단위 테스트용) — 함정: crates/worker-core/CLAUDE.md
  proto/         gRPC 정의 (controller↔worker)
ui/              TypeScript/React 웹앱 (Vite + Monaco + dnd-kit; 에디터=FlowOutline 아웃라인, ADR-0044) — 함정: ui/CLAUDE.md
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
| `ui/CLAUDE.md` | pnpm build 게이트·Zod default 누출, FlowOutline 아웃라인·dnd-kit 드래그(구 React Flow 제거 ADR-0044)·Monaco/Zustand, yaml Document API 양방향 sync·dirty-flag, React Query·multipart client, jsdom·blob 다운로드, 폼 UX·resolveForDisplay, CSP 오프라인 |
| `deploy/CLAUDE.md` | Helm fullname/PVC/snapshot, Dockerfile no-CMD·Node OOM, port-forward 함정 4종, K8s 테스트 격리 |
| `desktop/CLAUDE.md` | Tauri v2 셸: 자체 빈 `[workspace]`(cargo 중첩 패키지), `externalBin`이 `cargo build`도 바이너리 요구, `NO_COLOR` 파이프 무력→`parse_rest_port` ANSI strip, `.dmg` GUI 세션 필요·`.app` headless, desktop 테스트 게이트 밖, lib명 `desktop_lib`·창 label "main"=capability |

## 로컬 dev 실행 함정 (크로스커팅)

먼저 `dev-doctor` 스킬로 자동 진단 가능. 핵심 footgun:

- **`cargo run -p handicap-controller`만 쓰면 깨진다**: 바이너리가 둘(`controller` + `e2e_kind_driver`)이라 `error: could not determine which binary to run`. 항상 **`cargo run -p handicap-controller --bin controller -- …`**(또는 `just run-controller`/`run-controller-with-ui`).
- **엔진/시나리오 모델 변경 브랜치 pull·merge 후엔 `cargo build -p handicap-worker` 필수**: `cargo run -p handicap-controller`는 `target/debug/worker`(subprocess가 spawn)를 안 빌드 → 옛 워커가 새 스텝 타입을 못 읽어 exit 1 → run 즉시 `failed`(사유는 `GET /api/runs/{id}`의 `message`). "영영 running + 0 req"는 hung 워커 한정(G1) — controller 로그의 worker exit를 먼저 본다. 상세 → `docs/dev/ui-slice-7-manual-check.md`.
- **status=0 + 비정상적으로 높은 RPS = HTTP 도달 전 단계 실패**: connection refused / URL parse / DNS 등 fail-fast. 진짜 5xx는 RPS가 정상 범위. 점검 순서: 시나리오 URL이 host 없는 `/login`인지, wiremock이 죽었는지, env가 빈 채로 `${BASE_URL}`이 unresolved인지.
- **포트 선점(5173 `pnpm dev`·8080 controller) — 죽이기 전 소유자 확인**: 다른 워크트리 프로세스가 stale 번들·잘못된 DB를 서빙한다(curl 200인데 UI 새 기능 무동작). cwd 확인은 `lsof -a -p <PID> -d cwd -Fn` — **`ps -o cwd= -p <PID>`는 macOS 미지원**(조용히 오판). 남의 프로세스면 죽이지 말고 컨트롤러를 `--rest 127.0.0.1:8099 --grpc 127.0.0.1:8098`로 옮긴다. kill은 `pgrep -f "target/debug/controller --db /tmp/<slug>.db"`로 내 것만 — `kill $(lsof -ti …)` 금지(리스너+클라이언트·브라우저 탭 혼입). kind port-forward 충돌은 `deploy/CLAUDE.md`.
- **워크트리 백엔드 라이브 검증은 그 워크트리 *자체* 바이너리로**: 워크트리 root에서 빌드 후 상대경로 `./target/debug/controller --db /tmp/x.db --ui-dir ui/dist …`(메인 절대경로 = 다른 브랜치 stale, spawn되는 worker도 cwd-상대). `ui/dist` 없는 백엔드-only 슬라이스는 `--ui-dir` 생략(없는 경로면 fail-fast).
- **게이트 출력을 고정 `/tmp/x.log`로 리다이렉트하지 말 것**: Bash cwd 유지로 `cd` 실패→`&&` 단락→*다른 워크트리*의 stale 로그를 읽어 거짓 'FAIL'. 절대경로 `cd` + 워크트리-스코프 로그명(`/tmp/<slug>-lint.log`).
- **`just run-controller-with-ui`는 `ui/dist`가 *없을 때만* UI를 빌드한다** — UI 변경/머지 후 stale 번들을 8080으로 서빙. `just ui-build` 수동 실행 + hard reload(vite 5173은 HMR이라 무관).
- **로컬에서 curl로 직접 구동·백엔드 라이브 검증 함정 → [`docs/dev/live-verify-backend.md`](docs/dev/live-verify-backend.md)**(`/live-verify`·`/curl-verify`가 쓰는 정본, Playwright 쪽은 `docs/dev/live-verify-playwright.md`): 생성 응답 파싱 금지(멀티라인 `scenario_yaml`)·`GET /api/runs` 목록 없음·YAML `version: 1`+ULID step id·summary 키 `count/errors/rps/p50_ms`·`POST /api/test-runs` / 요청 내용은 로깅 echo 타깃으로 와이어 grep / 페이싱은 RPS로 수동 검증하되 loop/parallel이 섞이면 `VUs / think_ms` 공식이 틀린다 / transport 실패 유발 시 RPS를 조여라(자가 포트 고갈) · "안 떴다"≠억제 증거.
- **UI run 생성/응답-파싱 경로는 RTL·`tsc -b`로 안 잡힌다 — 슬라이스 머지 전 라이브 run 1회 필수** (S-D): RTL fixture는 서버가 보내는 `null` 대신 *absent*를 줘서 Zod `.optional()`↔서버-`null` 미스매치를 통과시킨다. RunDialog로 run 1개→리포트까지(또는 curl 응답의 `null` 필드가 `ProfileSchema`를 통과하는지). 상세 `ui/CLAUDE.md` `.nullish()` 함정.

## Subagent dispatch 노하우

> **규칙 요약만** — 사고 서사·사례·근거·복구 레시피는 [`docs/dev/subagent-dispatch.md`](docs/dev/subagent-dispatch.md)("왜?"·사례가 필요하면 그 파일을 읽어라). 새 함정: 규칙 한 줄은 여기, 서사는 그 파일에.

**brief/plan 작성**
- plan task 헤딩은 숫자 `Task N`으로 — `task-brief`가 문자 라벨("Task A") 미매칭 exit 3.
- plan의 task-밖 공유 정본(카피 표·keep-list)은 별도 파일로 1회 추출해 brief와 함께 디스패치("byte-exact" 명시) — `task-brief`는 그 task 섹션만 자른다.
- spec의 `사용자 스토리 (US)` 고정 헤딩 블록도 1회 추출해 매 brief에 첨부(원천=spec, 헤딩부터 다음 동레벨-이상까지; 규약 `docs/dev/user-story-spine.md`).
- `ui/src`를 한 줄이라도 건드리는 task는 brief에 UI 테스트 스텝 명시(tdd-guard가 UI-side pending test 요구).
- plan 인라인 Rust는 clippy-clean으로 — 2-arm `match … _ => {}` 대신 `if let`(`-D warnings`).
- **plan-지정 테스트도 공허 가능** — 회귀 가드 표방 테스트는 brief에 고의 회귀→RED→원복→GREEN 실증 명시. plan-mandated 결함도 기각 말고 finding. → [[plan-mandated-vacuous-tests]]
- **plan의 *사실 주장*도 가설** — grep·카운트·줄번호 등 기계 재현 가능한 건 디스패치 전 orchestrator가 직접 재실행. 리뷰 라운드 수는 사실을 보증 안 한다.
- **plan은 훅에도 실행 가능해야 — `tdd-guard` 순서 시뮬레이션**: ① 첫 스텝 production 편집 차단(테스트 먼저) ② 무수정 리팩터는 `it.todo` 언블록, 커밋 전 제거는 독립 스텝.
- **줄번호는 `grep -n`으로만 확정** — `sed -n 'N,Mp'` 출력 줄 세기 금지(오프바이원이 곧 finding).
- **사후-diff 검산·자기-삽입 keep-list는 저작 시점 검증 불가** — "구현 중 실측 확정" 표지, 불일치=STOP→재현→plan 정정. diff 로그 grep은 `^[+-]` 필터.

**디스패치**
- 워크트리 작업이면 prompt 첫 줄에 `cd /Users/sgj/develop/handicap/.claude/worktrees/<name>` 명시(안 하면 메인 체크아웃을 읽는다).
- 리포트 경로는 `.superpowers/sdd/` 지정 + "worktree 루트에 `.md` 쓰기·`git add` 금지" 못박기.
- implementer의 commit·검증은 단일 FOREGROUND 호출(600000ms) — background+poll 대기 금지(truncate·미완주). orchestrator 커밋은 background — 단 두 커밋 동시 금지(`index.lock`).
- 무거운 env-setup·외부 바이너리 가정은 디스패치 전 orchestrator가 pre-warm·실측해 값으로 넘긴다(바이너리 *행동*은 리뷰어가 못 잡는다).
- 1M 부모에서 `model:` 생략은 즉사+가짜 completed — 항상 **명시 `model:`**(reviewer도 1M 세션엔 `model: opus`). notification `tool_uses`/`tokens` 0이면 미실행 — 메인 폴백.

**리뷰**
- 모델 라우팅: 기본 Sonnet, path-gate(engine/동시성/`unsafe`/proto/와이어/template/cast/env/dataset/migration/대형 diff)면 그 task code-quality만 `model: opus`, `escalate: true` 재패스, 승격=디스패처(자기승격 불가).
- task별 2단계 review(spec-compliance→code-quality) 둘 다 APPROVED여야 다음. 정의된 리뷰어 3종은 `model: inherit`=Opus 유지(강등 금지), `CLAUDE_CODE_SUBAGENT_MODEL` 설정 금지.
- 리뷰는 read-only만(`git diff`/`git show`) — `checkout`/`switch`/`stash`는 워크트리 attached HEAD 파괴라 금지.
- 리뷰-수정 루프: read-only 리뷰는 같은 subagent `SendMessage` resume, 코드-fix는 fresh(자가검증 편향). clean APPROVE 목표+유한 valve: finding은 `receiving-code-review` 판정, 5회 초과 시 사용자 질문.
- 리뷰어가 "later fold 가능"이라 해도 **spec invariant 위반이면 그 슬라이스 안에서 fix**(미룬 건 사라진다).
- **finding을 뒤 task로 접으면 그 task brief에 명시 추가**(대화 결정은 brief에 도달하지 않는다) + 접을 task의 생존 보장 확인.
- **리뷰 finding의 사실 주장도 가설 — fold-in 전 기계 검증**(특히 렌더: 간격·정렬·폭; fold-in은 리뷰 루프 우회). 틀린 근거 주석은 통째 삭제. → [[review-findings-are-hypotheses]]
- 최종 whole-feature 리뷰는 `handicap-reviewer`(와이어 1:1·deferral 추적·게이트 재확인). 단일-task plan은 per-task와 병합 1회 — 리뷰 BASE는 디스패치 직전 커밋(`HEAD~1` 금지).
- **버그 fix 최종 리뷰엔 "옛 동작 부수효과에 기대던 타 크레이트 소비자" 초점 명시** — "X 0-diff"는 행동 무영향 보증 아님. → [[whole-branch-review-catches-interaction-bugs]]
- 다른 슬라이스로 미룬 항목은 코드 주석만으론 유실 — 후속 scoping 때 `grep -rn "<슬라이스>" crates/ docs/`로 deferral 훑기.

**검증·재개 (subagent 불신 원칙)**
- 새 `EnterWorktree` 워크트리엔 `ui/node_modules`·`target/` 없음 — 디스패치 전 `pnpm install` + `cargo build` baseline.
- implementer는 mid-task truncate 가능 — report 불신, `git status`/`git diff HEAD`로 확인해 남은 step 완료. `<new-diagnostics>`도 STALE — 독립 `cargo build --workspace`+`cargo test --no-run`만 신뢰.
- **orchestrator가 brief에 넘긴 "검증했다"도 가설**(implementer는 의심 안 한다) — brief엔 확인이 아니라 **확인한 명령**을. → [[orchestrator-verification-is-hypothesis]]
- 전수 grep 게이트는 orchestrator **직접 재실행**(self-report 불신). zsh 변수 1개는 word-split 안 됨(`set --`/명시 나열), 스코프 two-dot 금지 — `git diff $(git merge-base master HEAD)..HEAD`.
- 컨텍스트 리셋 후 재개는 **git 커밋이 진실의 원천** — `git log <base>..HEAD` vs plan 체크박스로 첫 미커밋 task부터(TodoWrite/subagent report 불신).

## 슬라이스 파이프라인 (순서·게이트·재개 — 단계 생략 금지)

worktree 슬라이스의 고정 순서. **어느 단계도 "작아서/dogfood라서" 생략 금지** — 템플릿·체크리스트는 리뷰를 대체 못 하므로 `spec-review-guard`가 reviewer 통과를 기계적으로 강제한다. 사고 서사·규율 원문 → [`docs/dev/spec-plan-authoring.md`](docs/dev/spec-plan-authoring.md). 체크리스트는 `/start-slice`·`/finish-slice`.

1. **시작** `/start-slice` — worktree(`worktree-<X>`) + 작업 선택 + baseline(`pnpm install`·`cargo build`).
2. **설계** brainstorming 종료 시 **US 초안(2–5개, 규약 `docs/dev/user-story-spine.md`)을 사용자에게 단독 제시·승인 후 spec 착수**(spec 앞머리 `사용자 스토리 (US)` 고정 헤딩, 내부-only는 `US: N/A — 이유`; ADR-0048). spec → plan 각각 `spec-plan-reviewer` **clean `APPROVE`까지 반복**(`APPROVE-WITH-FIXES`/`NEEDS-REWORK`=미통과, finding은 `receiving-code-review`로 판정). **clean APPROVE 후에만** plan에 `REVIEW-GATE: APPROVED`(미통과 마킹 = 위조). **STOP-gate**: 이 세션에서 spec/plan을 썼으면 커밋 후 `/clear`→fresh로 3단계 — 같은 세션 구현을 권장/옵션으로 먼저 제시하지 말 것(명시 고집 시에만). [[stop-gate-fresh-context-impl]]
   **spec/plan 사실 주장 규율**: ① 부재·유일성 주장("유일한"·"0건")은 **경계 없는 전수 명령으로만**(`grep -A N`·`sed -n` spot-check는 잘라서 거짓 전칭을 만든다) ② 사실 주장마다 그것을 만든 명령을 남기고 디스패치 전 일괄 재실행(claims-ledger) ③ 게이트/검증 명령은 **baseline + 변경-후 예상 상태 두 상태**에서 ④ 리뷰 fix는 같은 패턴을 **문서 전체 sweep** ⑤ 한 절이 두 번 틀리면 "이 절이 무엇을 지탱하나"를 먼저 — 하중 0이면 삭제, 하중이 있으면 정밀도 말고 **검증 방식·서술 층위**를 바꾼다.
   **이 5항(및 새로 도입한 모든 프로세스 규칙)도 점검 대상** — 마찰(결함은 못 잡고 시간만 먹음·충족용 형식·매 슬라이스 예외·빈손 sweep)이 보이면 우회·인내 말고 **즉시 사용자에게 보고 + 해결안**(기본 처방은 삭감). → [[spec-plan-authoring-selfcheck]]
3. **구현** `superpowers:subagent-driven-development` — task별 fresh subagent(plan의 인라인 acceptance 전달), 각 task **독립 green 커밋**.
4. **최종 리뷰** `handicap-reviewer` APPROVE(크로스커팅·repo 함정·와이어 1:1). **+ 보안 표면 게이트**: `finish-slice` §0 grep이 매치하면(요청실행·템플릿/캐스트·env/데이터셋 바인딩·업로드파싱·trace/body 뷰어) `security-reviewer` APPROVE 필수 — plan/spec의 "N/A 예상"보다 grep이 지배하니 직접 돌릴 것.
5. **라이브 검증** — run-생성/report-파싱/엔진 경로를 건드리면 **필수**(`/live-verify`, S-D 갭). production diff 0(docs/테스트-only)이면 생략 + 근거를 build-log에.
6. **마무리** `/finish-slice` — build-log·roadmap·CLAUDE 상태줄·메모리 기록 → ff-merge → `ExitWorktree(remove, discard_changes:true)`.

**재개(컨텍스트 리셋 후)**: `git log --oneline master..<branch>` + plan `- [ ]` 대조로 현재 단계 판정 — ① plan `REVIEW-GATE: APPROVED` 유무 ② task 커밋 수 vs plan task 수 ③ build-log/roadmap 완료 단락 유무. TodoWrite/subagent report 불신 — **커밋·마커·직접 실행한 테스트만 신뢰**.

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
- **0022** Data-driven 데이터셋: 독립 리소스 + 서버 파싱(8b) + 4정책(per_vu/iter_sequential/iter_random/unique) 바인딩·주입(8c) — counts-only
- **0023** Conditional 노드: if/elif/else + 재귀 조건 트리 + lenient 평가 + 상호 1레벨 중첩 + 분기별 결정 카운터
- **0024** Run 프리셋: scenario-scoped 독립 리소스(`run_presets`) + Profile 재사용 + validate_run_config 공유 + dataset delete soft-guard
- **0025** 환경(Environments): top-level 재사용 리소스(`environments`, migration 0007, UNIQUE→409) + 클라 오버레이 스냅샷(B-1+B-2)
- **0026** 시나리오 에디터 test-run: 컨트롤러 in-process 단일패스 trace(ephemeral) + `POST /api/test-runs` + 미바인딩 토큰 수집(C-1+C-2)
- **0027** 멀티 워커 fan-out: 컨트롤러 권위 N + shard 배정 + 글로벌 vu_id + 워커별 메트릭 머지 + K8s Indexed Job
- **0028** Run-level SLO criteria: profile_json 스냅샷 + 고정 per-metric verdict + status-class/per-window RPS + verdict 배지 영속
- **0029** JSON body 타입 캐스트: flow `{{var:num}}`/`{{var:bool}}`/`:str`, leaf 레벨 파싱, 엄격 실패(`CastFailed`), 캐스트 없으면 byte-identical
- **0030** Run 비교 + 리포트 export: 하이브리드(클라 비교/서버 CSV·XLSX), same-scenario terminal-only, 골든 fixture TS↔Rust 패리티
- **0031** Open-loop / arrival-rate: opt-in `target_rps` + 균등 틱 스케줄러 + `max_in_flight` 슬롯풀 + `dropped` 카운터(migration 0009), 단일워커 v1
- **0032** 다단계 ramp: open-loop `stages:[{target,duration}]` piecewise-linear 곡선(고정 target_rps 일반화), stages 없으면 byte-identical
- **0033** Parallel 노드: `type: parallel` `join_all` 동시 분기(공유 jar) + `{{branch.var}}` 네임스페이스 merge + 그룹/페이지 레이턴시
- **0034** Run 스케줄러: 컨트롤러 내장 cron 루프 + once/5-field 트리거(`croner`) + 단일 IANA TZ + `spawn_run` 발사 코어 + migration 0011(34a–c)
- **0035** UI 문구: 한국어 통일 + `ko.ts` 메시지 카탈로그 경유 (고유명사 원어 병기 + HelpTip, i18n 라이브러리·토글 비목표)
- **0036** 스텝 템플릿: top-level `step_templates` 리소스 + 복사-삽입 스냅샷(삽입 시 ULID 재발급), 참조 동기화 기각
- **0037** closed-loop VU 곡선: park-gate 격리 함수 + vu_stages/ramp_down 와이어 + 단일워커 v1
- **0038** open-loop 멀티워커 fan-out: 명시 worker_count(기본 1, open 전용) + 컨트롤러 워커별 레이트 분할 + A3b 머지 재사용
- **0039** 라이트 Windows 데스크톱 배포: 옵션 A = 단일 self-contained `.exe`(subprocess 로컬모드 패키징), Flutter/RN 기각, Tauri 래퍼는 ADR-0040
- **0040** 라이트 Windows 데스크톱 배포 옵션 B(접근 1): Tauri v2 셸이 controller exe를 사이드카로 spawn (**→ ADR-0042 접근 2로 대체**)
- **0041** LAN 분산 워커 L1: 세 번째 워커 모드 `pool`(유휴 등록→컨트롤러가 샤드 push) + proto `Register.token` 토큰 인증 + LAN 바인드
- **0042** 라이트 Windows 데스크톱 배포 옵션 B 접근 2: Tauri in-process 컨트롤러 임베드(사이드카/`externalBin` 제거) — ADR-0040 대체
- **0043** UI 디자인 시스템: 시맨틱 accent 토큰(=indigo) + 프리미티브 6종(`ui/src/components/ui/`) — 점진 채택, 전면 리라이트 기각
- **0044** 에디터 1차 표현 캔버스→아웃라인: React Flow 캔버스 → 세로 아웃라인 `FlowOutline` + dnd-kit 드래그, 양방향 sync 모델 유지
- **0045** 시나리오 삭제 정책: 2층 가드(활성 run hard 409·참조 soft 409+force) + 앱-레벨 단일 tx 전체 cascade(soft-delete 기각)
- **0046** open-loop rate 단위·사이징 교정: target_rps=반복(시나리오 실행)/초 공식화 + 실측 점유시간 기반 사이징 + cause 2-way(slots/sut)
- **0047** 에디터 test-run 데이터셋 바인딩: 컨트롤러 서버측 시드 + single_row/sequential 2모드 + 엔진 행 루프(jar 공유·전역 상한)
- **0048** US 스파인(프로세스): 유저 스토리를 spec→리뷰→brief→live→finish 관통 오라클로 (정본 `docs/dev/user-story-spine.md`)
- **0049** 실행 전 시나리오 신뢰도: 네 번째 판정 축(신뢰도 ⟂ validity ⟂ verdict ⟂ status) + 클라 순수함수 `evaluateTrust` 단일 소스
- **0050** transport 에러 taxonomy: send-실패 8종 kind 와이어 계약(snake_case verbatim) + counts-only 델타 운반 + 최상위 reqwest Display 금지
- **0051** 실행 중 진행 차트: 이미 폴링 중인 1s windows의 클라 표시 허용 (ADR-0009 후속-한도 supersede, 라이브 대시보드는 비목표)
- **0052** run 라벨: 단일 TEXT 컬럼 + 표시 폴백 `label ?? #끝6자` + 스케줄 자동 라벨 (장문 메모·`schedule_id` 컬럼 기각)
- **0053** 운영 모니터 모드: trace 재사용 주기 점검 보드 + 메모리 링버퍼 + 느림은 화면 계산 (0009 번복 아님)

## 코딩 컨벤션

- **Rust**: `cargo fmt`, `cargo clippy -- -D warnings`, 테스트 `cargo test`. workspace `members = ["crates/*"]` glob — 새 crate는 `crates/<name>/Cargo.toml`만 만들면 자동 인식.
- **TypeScript**: prettier + eslint, 테스트 vitest. **`pnpm build`(`tsc -b && vite build`)가 최종 게이트** — `pnpm test`(jsdom + esbuild)는 TS strict 에러를 못 잡을 수 있고 `pnpm lint`는 `--max-warnings=0`. UI 커밋 전 `pnpm lint && pnpm test && pnpm build`. 함정 → `ui/CLAUDE.md`.

## 새로운 아키텍처 결정이 생기면

`docs/adr/`에 새 ADR 파일 추가 (다음 번호 사용, MADR 포맷). 이 CLAUDE.md "알아둘 결정들" 인덱스엔 **한 줄(번호+제목+핵심 한 마디)만** — 상세·근거는 ADR 파일이 단일 소스다(인덱스에 문단을 쌓지 말 것).

## 새 함정을 배우면

그 함정이 속한 **도메인 디렉토리의 `CLAUDE.md`** 에 한 줄 추가(인라인 `(Slice N)` 출처 태그 유지). 여러 crate에 걸친 크로스커팅 함정·프로세스 노트·로컬 dev 실행 footgun만 이 루트 파일에. 새 도메인 디렉토리가 생기면 위 [도메인별 함정 인덱스](#도메인별-함정-인덱스) 표에 행 추가.

## 슬라이스/기능을 완료하면 (root 재비대 방지)

root는 **매 프롬프트에 통째로 로드**된다 — "매 세션 필요한 것"(전역 규칙·현재상태 한 줄·크로스커팅 함정·인덱스)만 두고 나머지는 포인터 + on-demand 파일로. 이관 기준·재분배 절차(manifest → `just doc-coverage` → `just doc-budget`)·원문 → `docs/dev/root-doc-maintenance.md`. 기능 완료 시:

- 구현 결과 요약(파이프라인·함정 출처·라이브 검증)은 root가 아니라 **`docs/build-log.md`에 한 단락 append**.
- root **상태 줄은 한 줄로 *교체*(append 금지)** — `후속 다수(…)` 카탈로그도 append 대상이 아니다, `최신 =`만 갱신.
- 상태줄(line 7)·roadmap 불릿은 **Python 스플라이스**로 — 앵커 함정 → [docs/dev/root-doc-maintenance.md](docs/dev/root-doc-maintenance.md).
- 새 ADR는 인덱스에 **한 줄만**(위 규칙), 기능별 상세 작업 메모는 자동메모리 `MEMORY.md` 항목.
- 신호: `just doc-budget`이 WARN(45 KiB)·FAIL(50 KiB)이면 같은 기준으로 build-log/ADR/도메인 CLAUDE.md/`docs/dev/`로 재분배.

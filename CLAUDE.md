# Handicap

사내 QA·운영팀을 위한 부하 테스트 도구. REST API를 대상으로, **QA는 드래그-드롭으로 시나리오를 만들고**, **개발자는 같은 시나리오를 YAML/DSL로 편집** 한다 (두 뷰가 같은 모델의 양방향 sync). LoadRunner/JMeter를 사내에서 대체하는 것이 목표.

> **함정(gotcha) 노트는 도메인별 중첩 CLAUDE.md로 분할됨** — 각 디렉토리 파일을 그 디렉토리 작업 시 자동 로드한다. 이 루트 파일엔 전역 규칙·상태·크로스커팅 함정만 남긴다. 인덱스는 아래 [도메인별 함정 인덱스](#도메인별-함정-인덱스).

**상태: MVP 1단계(슬라이스 1–9) + post-MVP1 영역 A(프리셋·멀티워커 fan-out·Parallel 노드·리포트 export/insights)·B(환경·SLO criteria·리포트 깊이)·C(에디터 test-run)·D(부하모델·페이싱: 타임아웃/think-time/open-loop/stages) + Run 스케줄러 + B7-C 레이턴시 단계 분해 + Parallel per-branch breakdown + 영역 U(UX 초보자 친화 재설계, ADR-0035) + 스텝 템플릿(저장/복사-삽입 스냅샷, ADR-0036, 2026-06-12 완결: `step_templates` 리소스+migration 0015+에디터 저장/삽입 모달, 삽입 시 ULID 재발급)까지 전부 구현·머지 완료.** 다음 후보·연기 항목 → **`docs/roadmap.md`** (post-MVP1 단일 진입점, "다음 뭐 하지?"는 거기부터). 슬라이스/기능별 구현 결과·함정 출처(과거 이력) → **`docs/build-log.md`**. 결정 요약 → 아래 [알아둘 결정들](#알아둘-결정들), 전문 → `docs/adr/`. 디자인 → `docs/superpowers/specs/`, 구현 계획 → `docs/superpowers/plans/`. MVP 1단계 spec=`2026-05-27-handicap-mvp1-design.md`(슬라이스 1–6), 후속은 그 §4.5 메뉴에서 각자 새 spec/plan으로.

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

`.git/hooks/pre-commit`이 모든 커밋에 대해 `cargo fmt --check + cargo build --workspace + cargo clippy --workspace --all-targets -- -D warnings + cargo test --workspace`를 실행한다 (워크스페이스가 coherent하지 않으면 per-crate 모드로 fallback). **단, staged에 cargo-영향 경로(`crates/`·`Cargo.toml`·`Cargo.lock`·`rust-toolchain.toml`·`.cargo/`)가 하나도 없으면 cargo 검사를 통째로 skip한다** (2026-06-11에 기존 `.md`-only fast-path를 일반화 — docs/ui/.claude/deploy-only 커밋 빠른 통과; 삭제된 `.rs`도 `crates/` 매치라 전체 검사. `PRE_COMMIT_DECIDE_ONLY=1`로 결정만 출력하는 dry-run 가능. 가드는 no-match grep 종료코드 1이 `set -e`를 깨우는 quirk를 피해 "출력 비었는지" 검사 형태로 작성됨). 이 hook 본체는 `.git/hooks/`(버전 관리 안 됨)라 변경은 이 클론에만 로컬 적용. hook은 git common dir에 있어 모든 worktree에 적용된다. 새 머신에서는 `chmod +x .git/hooks/pre-commit`이 한 번 필요할 수 있다. Slice 4 후속에서 clippy gate가 추가됨 — `next_spawn += ...` 같은 `assign_op_pattern`/`expect_fun_call` 회귀가 prod로 안 들어오게 차단(단위·통합 테스트가 다 통과해도 clippy는 다른 클래스를 잡는다). **워크트리 안에서 `.git`은 디렉토리가 아니라 파일**이라 `.git/hooks/pre-commit`을 직접 호출하면 "Not a directory" — `bash $(git rev-parse --git-common-dir)/hooks/pre-commit`로 절대 경로 풀어 실행. **단, hook은 `cargo`만 돌린다 — UI(TypeScript) 변경은 `cd ui && pnpm lint && pnpm test && pnpm build`를 수동으로 돌려야 `tsc -b` 타입 에러(discriminated union 미스매치, Zod default 누출 등)와 eslint 경고를 잡는다(Slice 8c). `pnpm lint`(`eslint . --max-warnings=0`)는 `.github/workflows/ci.yml`엔 게이트로 있지만 pre-commit hook엔 없어서, remote 미설정으로 CI가 안 돌면 경고가 잠복한다 — UI 커밋 전 `pnpm lint`까지 같이 돌릴 것(codex 평가 후속, `react-hooks/exhaustive-deps` 누락 한 건이 이렇게 통과했었다).** **cargo-비영향 커밋(`.md`·ui·`.claude` 등)은 이 fast-path로 어떤 게이트도 안 거치고 markdown을 lint하는 것도 없다 — merge conflict marker(`<<<<<<<`)·깨진 내용이 그대로 commit·merge된다(Slice 9c: A1 머지 때 박힌 conflict marker가 루트 CLAUDE.md에 commit돼 있었음). 문서를 여러 번 커밋하는 워크플로 끝엔 `grep -rn '^<<<<<<<\|^>>>>>>>' **/*.md` 한 번.**

**pre-commit 훅은 cargo-영향 커밋마다 전체 workspace(`cargo build/clippy/test --workspace`, e2e·wiremock·워커 subprocess 빌드 포함)를 돌려 수 분 걸린다** (codex 후속 세션) — 단일 crate 변경도 동일(UI-only·docs-only는 2026-06-11부터 skip). 그래서 `git commit`을 **`run_in_background`로 돌리고 완료 전까지 다른 `cargo` 호출을 피한다**(같은 `target/` 락 경합). UI 커밋은 cargo를 건너뛰지만 UI 게이트(`pnpm lint && pnpm test && pnpm build`)는 여전히 hook 밖 수동 — `.claude/hooks/ui-gate-reminder.sh`(PostToolUse·Bash)가 ui/ 변경 커밋 직후 리마인드를 주입한다. **이 전체-게이트 때문에 단독 커밋이 불가능한 두 종류가 있다**: ① 미사용 `pub(crate)` 헬퍼만 추가(`#[cfg(test)]`만 호출) = `clippy -D warnings`의 dead_code 에러, ② RED 테스트만 커밋 = `test --workspace` 게이트 실패. 그래서 TDD plan의 "헬퍼 → RED 테스트 → 배선"을 **별도 커밋으로 쪼개면 앞 둘이 막힌다 — 하나의 green 커밋으로 fold**(로컬에선 RED→GREEN 확인하되 커밋은 1회; JSON cast 0029에서 Task 1+2+3 합침). subagent-driven plan을 짤 때 commit 경계를 이 게이트에 맞춰 미리 설계할 것. **함정: `git commit`을 `| tail`/`| head`로 파이프하면 git exit code가 마스킹된다(파이프 종료코드=tail의 0) — 커밋 실패(pre-commit reject 포함)를 못 보고 "성공"으로 오인. 커밋은 파이프 없이 돌리고 직후 `git log -1`로 landed 확인. `cargo test` 등 게이트 명령도 동일 — 출력을 줄이려면 파이프 대신 `> /tmp/x.log 2>&1` 후 exit code 확인(스텝 템플릿 세션에서 `cargo test | tail`이 같은 클래스로 마스킹).**

**cold-build flake: engine/worker를 바꾼 커밋은 pre-commit의 `cargo test --workspace`가 controller e2e(`loop_e2e_inner_step_counts`·`full_slice_1_e2e`)에서 워커 바이너리 race로 flake날 수 있다** (S-A) — 증상: `target/debug/worker` ENOENT(`No such file or directory` → dispatch failed → run failed → 테스트 `unwrap()` None panic) 또는 SIGKILL(sig 9) 또는 (S-D) `worker_exits_promptly_on_sigterm`이 `unix_wait_status(15)`(SIGTERM 핸들러 설치 전 종료). **진짜 회귀 아님**(codex-followups의 dispatch-fail→run-failed 동작과 겹쳐 오인하기 쉬움). (2026-06-11 전엔 UI-only 커밋도 cold 재빌드로 이 flake가 났다 — S-D: Zod-only 커밋이 sigterm 테스트 sig 15; 이제 UI-only는 cargo skip이라 해당 없음.) 대응: 커밋 전 `cargo build -p handicap-worker && cargo build --workspace`로 warm한 뒤 커밋하고, flake나면 동일 커밋을 warm 상태로 재시도.

`.claude/hooks/tdd-guard.sh`는 Claude의 PreToolUse 훅으로, Write/Edit가 `crates/*/src/*.rs` 또는 `ui/src/*.{ts,tsx,js,jsx}`를 만지려 할 때 작업트리에 pending test 파일(`tests/*.rs`, `*_test.rs`, `*.test.{ts,tsx}`, `*.spec.{ts,tsx}`, `__tests__/*`)이 하나도 없으면 차단한다. UI scaffolding처럼 그 작업 단위에 실제 동작 테스트가 없을 때는 `ui/src/__tests__/<name>.test.tsx`에 `it.todo("...")` 한 줄을 먼저 적어 pending diff를 만든 다음 production 파일을 작성하는 게 표준 패턴 — 진짜 테스트는 그 슬라이스의 testing 단계에서 채운다. 인라인 `#[cfg(test)] mod tests`가 있는 Rust 파일은 자동으로 통과. **Rust 쪽도 같은 stub 패턴 사용 가능** — production 변경이 큰데 인라인 test가 없을 때 `crates/<x>/tests/<feature>_wiring.rs`에 컴파일만 되는 placeholder를 먼저 만들면 guard 통과(작업이 끝나면 인라인 `mod tests`로 정리, **커밋 전 임시 stub은 `rm`**). 새 src 파일은 디스크의 pending test 파일이 있어야 통과하므로 TDD 순서대로 **테스트 파일을 먼저** 만들면 자연히 unblock된다. **함정(C-1): "pending test"는 *test-path 파일*(`tests/*.rs`·`*_test.rs`·`*.test.tsx`…)만 카운트한다 — 인라인 `#[cfg(test)]`를 추가하는 *src 파일 편집*(예: `template.rs`에 테스트를 막 추가한 상태)은 test-path가 아니라 pending으로 안 쳐서, 같은 작업의 `lib.rs` re-export 편집이나 새 src 파일 Write가 막힌다(인라인-test 자동통과는 디스크에 `#[cfg(test)]`가 *이미* 있는 파일에만 적용 — 첫 Write/첫 추가 편집엔 안 통함).** 대응: orchestrator가 `crates/<x>/tests/_tdd_keepalive.rs`(trivial `#[test] fn(){}`) 한 개를 미리 깔아 그 crate의 모든 src/lib.rs 편집을 unblock하고, implementer엔 명시 경로로만 `git add`(절대 `-A` 금지)시킨 뒤 task 끝나면 `rm`(commit 안 됨). Task 5·7처럼 Step 1이 진짜 `tests/*.rs`를 먼저 만드는 task는 keepalive 불필요(self-unblock). guard는 편집 파일의 디렉터리에서 `git rev-parse --show-toplevel`로 working tree를 찾으므로 worktree 안에서도 정확히 동작한다. **가드는 pending test 파일 존재뿐 아니라 편집 *내용*도 본다 — 주석-only·공백/리인덴트-only 편집은 (Edit `old_string`/`new_string`, 또는 Write `content` vs 디스크를 줄-단위 주석·공백 제거 후 비교해 동일하면) 자동 통과한다. 코드 텍스트가 바뀌는 순수 리팩터는 여전히 pending test 없으면 막힌다. 보수적 설계라 `//`/`/*`/`*`로 *시작*하는 줄만 주석으로 보므로 트레일링 주석(`x; // note`)·한 줄 블록주석 추가는 자동 통과 대상이 아니다 — 그땐 stub로 pending diff를 만들거나 사용자 승인 후 우회.** (이전엔 파일 존재만 봐서 설명 주석 추가도 차단됐다 — Slice 9c; 내용-기반 예외는 그 후속 추가.)

`.claude/hooks/git-guard.sh`(PreToolUse·Bash, 2026-06-11)는 위 git 함정들을 기계적으로 차단한다 — `git commit … | …` 파이프와 `--no-verify`는 deny, `checkout/switch/stash`는 ask(서브에이전트의 Bash에도 적용). 슬라이스 시작/마무리 의식은 `/start-slice`·`/finish-slice` 스킬(`.claude/skills/`)로 체크리스트화돼 있다.

`--no-verify`로 hook 우회 금지 (사용자 명시 요청 없이는). 회귀가 생긴 채로 커밋이 들어가면 후속 작업이 모두 빨갛게 됨.

**이 repo의 git 토폴로지**: 통합 브랜치는 `master` (`main` 없음 — 세션 시작 컨텍스트의 "Main branch: main"은 부정확), **remote 미설정**. 브랜치 마무리는 push/PR이 아니라 로컬 fast-forward: `git checkout master && git merge --ff-only <branch>`. **워크트리 *안에서* 마무리할 땐** master가 메인 체크아웃에 잡혀 있어 worktree에서 `git checkout master`가 안 되므로 — cd 없이 `git -C /Users/sgj/develop/handicap merge --ff-only <branch>`(메인에 master가 이미 checkout돼 있어 ref+워킹트리 동시 갱신; 사전에 `git -C <메인> merge-base --is-ancestor master <branch>`로 ff 가능 + `status --porcelain -uno`로 메인 클린 확인), 머지 확인 후 `ExitWorktree(remove, discard_changes:true)`로 정리(A4b). 세션이 길어 그 사이 master가 전진하면 ff-only가 깨지므로 **브랜치를 master에 rebase 후 ff-merge**(Slice 9a 때 docs 커밋이 끼어듦; 파일 겹침 없으면 충돌 0). 사내 K8s 도입 시 remote 붙이면 PR 흐름 가능. 슬라이스 작업은 `.claude/worktrees/<name>` worktree에서 진행 — **네이티브 `EnterWorktree` 사용 시 remote가 없어 기본 `worktree.baseRef`(`fresh`=`origin/<default>`)가 실패**하니 `.claude/settings.local.json`(gitignored)에 `worktree.baseRef: head` 필요(로컬 HEAD에서 분기). 정리는 harness 소유 경로(`.claude/worktrees/`)라 `git worktree remove`가 아니라 **`ExitWorktree`** 로 — 단 ff-merge 후에도 `ExitWorktree(remove)`는 워크트리 *생성 base* 기준 커밋 수를 세어 "N commits discarded"로 거부하므로, master에 머지 끝났음을 확인한 뒤 `discard_changes: true`로 재호출(커밋은 이미 master에 안전).

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
- **워크트리에서 백엔드 라이브 검증은 그 워크트리의 *자체* 바이너리로**(Run 스케줄러 34c): 워크트리는 메인과 분리된 `target/`(`.claude/worktrees/<name>/target/debug/`)을 갖는다. 메인 체크아웃의 절대경로(`…/handicap/target/debug/controller`)로 돌리면 **다른 브랜치의 stale 바이너리**(새 CLI 플래그·엔진 변경 없음 → `unexpected argument` 등으로 깨짐)가 실행된다. `find -maxdepth 5`는 깊이 6의 워크트리 target을 놓쳐 위치 오판을 부른다. → 워크트리 root에서 `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller` 후 **상대경로 `./target/debug/controller --db /tmp/x.db --ui-dir ui/dist …`**로 실행(controller가 spawn하는 `target/debug/worker`도 cwd-상대라 같은 fresh 바이너리).
- **`just run-controller-with-ui`는 `ui/dist`가 *없을 때만* UI를 빌드한다**(`if [ ! -f ui/dist/index.html ]`) — UI 변경/머지 후 dist가 stale이어도 재빌드 안 하고 옛 번들을 단일-포트(8080)로 서빙한다(위 포트 선점과 다른 별개 함정). 새 UI 기능이 안 보이면 `just ui-build` 수동 실행(+브라우저 hard reload). vite dev 5173은 HMR이라 무관.
- **로컬에서 curl로 직접 구동 (수동 검증/더미 데이터 생성)**: 시나리오 생성 `POST /api/scenarios {"yaml":…}`(name은 YAML에서 파싱 — `jq -Rs '{yaml:.}' f.yaml | curl -sX POST …/api/scenarios -d @-`로 이스케이프 회피). run 목록은 `GET /api/scenarios/{id}/runs` (**`GET /api/runs` 목록 엔드포인트 없음** — `POST /api/runs` + `GET /api/runs/{id}`만). run 생성 `POST /api/runs {"scenario_id":…,"profile":{"vus":N,"duration_seconds":S},"env":{}}`(`ramp_up_seconds`·`loop_breakdown_cap`는 default). report summary 키 = `count/errors/rps/p50_ms/p95_ms/p99_ms`(`total_requests`/`error_count` 아님). 시나리오 YAML엔 **`version: 1` + 각 step `id`(유효 ULID — I/L/O/U 제외)·`type`·`name` 필수**(http step은 셋 다 required — `HttpStep.name: String`; 없으면 `422 missing field version`/`missing field name` 또는 ULID 파싱 거부). 에디터 test-run 단발(trace/본문 뷰어 검증용)은 별도 ephemeral 엔드포인트: `POST /api/test-runs {"scenario_yaml":…,"env":{},"max_requests":N}` → `ScenarioTrace`(미저장; `steps[].response.{body,body_truncated}` 확인). **함정: zsh `echo "$json" | python3`는 serde_json이 이스케이프한 `\n`(2글자)을 실제 개행으로 풀어 JSON 파싱을 깨뜨린다(`Invalid control character`)** — curl을 python에 **직결**(`curl … | python3 -c …`)하거나 `printf '%s' "$json"` 사용. `GET /api/scenarios`는 `{"scenarios":[…]}` 래퍼(bare 배열 아님), 단일 scenario/run 응답은 객체. **생성 응답(`POST /api/scenarios`·`/api/runs`)은 멀티라인 `scenario_yaml`을 임베드 → 셸 변수에 담아 `jq -r '.id'`/`python json.load`하면 raw 개행으로 깨진다**(phase-breakdown): 생성 응답을 파싱하지 말고 `GET /api/scenarios/{id}/runs`(목록)에서 id를 재조회하거나 curl→python 직결.
- **요청 *내용*(실제 전송된 헤더/폼 필드)을 검증하려면 로깅 echo 타깃이 필요**: 리포트는 집계-only이고 시나리오 assertion은 `status`뿐이라 "무엇이 실제로 나갔나"(예: B4 disabled 행 미전송)를 리포트로는 못 본다 → 시나리오 url을 헤더/바디를 파일로 찍는 echo 서버로 돌리고 와이어를 grep. python `ThreadingHTTPServer` echo가 localhost ~10k rps 감당.
- **부하 페이싱/타임아웃 기능(think time·timeout·향후 open-loop/stages)은 RPS로 수동 검증** (S-B 수동테스트): python `ThreadingHTTPServer` 200-responder + controller subprocess 워커 + 격리 DB(`./target/debug/controller --db /tmp/x.db --ui-dir ui/dist`, 먼저 `cargo build -p handicap-worker --bin worker`)로 띄우고 run 리포트 `summary.rps`를 관찰. **closed-loop think time RPS ≈ `VUs / think_ms`**(예: 2 VU·200ms→~10 RPS, per-step도 동일식; 베이스라인 대비 수백배 하락이라 신호 명확). test-run 페이싱은 `POST /api/test-runs`를 curl `-w '%{time_total}'`(wall)로 `apply_think_time` on/off 비교. UI 라운드트립은 Playwright — `browser_take_screenshot` 상대경로 파일은 **repo 루트**, `browser_snapshot`은 `.playwright-mcp/*.yml`에 떨어지고 **둘 다 gitignore 안 됨** → 머지 전 `rm -rf .playwright-mcp` + 루트 png 정리(안 하면 worktree 머지 시 untracked 잔류). **함정: Playwright MCP 서버의 cwd는 그 서버가 처음 기동된 워크트리에 고정된다 — 이전 세션의(삭제됐을 수 있는) 워크트리일 수 있다** (phase-breakdown): 그래서 `filename:` 상대 저장은 *현재* 워크트리가 아니라 그 고정-cwd로 가고(삭제됐으면 `ENOENT`), 위 "현재 디렉터리 정리"가 못 잡는다(역으로 현재 워크트리는 안 더럽혀질 수도). **라이브 검증은 `filename` 없는 인라인 `browser_snapshot`/`browser_evaluate`로** — 페이지 상태를 텍스트로 직접 뽑는 게 저장-경로 의존 없이 결정적이다(이번엔 step 테이블 헤더/셀을 `browser_evaluate`로 추출해 다운로드 컬럼 유무를 검증). **React controlled input은 `browser_type`이 아니라 evaluate 안에서 native setter로**: `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v)` + `el.dispatchEvent(new Event('input',{bubbles:true}))` (U3 라이브 검증). **같은 evaluate 안에서 `el.click()` 직후 DOM을 읽으면 React 렌더 *전* 상태를 본다**(React 18 batching) — 클릭과 단언을 별도 evaluate 호출로 분리.
- **UI run 생성/응답-파싱 경로는 RTL·`tsc -b`로 안 잡힌다 — 슬라이스 머지 전 라이브 run 1회 필수** (S-D Playwright 발견): RTL fixture는 서버가 실제 보내는 `null`이 아니라 *absent*를 줘서 Zod `.optional()`↔서버-`null` 미스매치를 통과시킨다(`tsc`도 못 봄). 머지 전 controller+worker 띄우고 RunDialog로 run 1개 생성→리포트까지 확인(또는 curl `POST /api/runs` 후 응답 JSON에 `null` 필드가 `ProfileSchema`를 통과하는지). S-D에서 이 누락(`ProfileSchema` `.optional()`이 서버 `null` 거부)이 **모든 run UI 생성을 깨뜨린 채** 전 슬라이스 잠복했었다 — 상세 `ui/CLAUDE.md` `.nullish()` 함정.

## Subagent dispatch 노하우

- **워크트리에서 subagent를 띄울 땐 prompt 첫 줄에 `cd /Users/sgj/develop/handicap/.claude/worktrees/<name>` 명시**: 안 하면 spec-reviewer 같은 lightweight 모델이 메인 체크아웃을 읽고 "코드가 없다"고 잘못 보고한다. 절대 경로로 박는 게 가장 안전.
- **각 task마다 두 단계 review (spec compliance → code quality)**: spec reviewer는 plan 대비 빠짐/추가를 보고, code quality reviewer는 idiom/race/test 품질을 본다. 두 reviewer가 모두 APPROVED여야 다음 task로.
- **subagent-driven 실행 중 리뷰는 read-only 로만**: reviewer 가 옛 버전을 보려고 `git checkout <sha>` 를 쓰면 HEAD 가 detach 되어 브랜치 ref 가 안 따라온다. 리뷰는 `git diff`/`git show <sha>` 같은 read-only 명령만 — `checkout`/`switch`/`stash` 는 worktree 의 attached HEAD 를 깨므로 금지.
- **다른 슬라이스로 미룬 항목을 코드 주석으로만 남기면 다음 슬라이스 plan이 놓친다** (Slice 8c): 8b가 `api/datasets.rs`에 `// 참조 가드는 8c`로 미룬 DELETE 409 가드를 8c plan이 안 주워, 최종 whole-feature 리뷰에서야 발견(Task 13으로 추가). 후속 슬라이스 scoping 때 `grep -rn "<해당 슬라이스>" crates/ docs/`로 deferral 주석을 한 번 훑을 것.
- **리뷰-수정 루프는 fresh fix-subagent로** (Slice 9b): subagent-driven 스킬은 "같은 subagent가 fix"라지만 이 하니스엔 `SendMessage`/subagent resume가 없다 — 리뷰가 이슈를 찾으면 finding + `file:line` + 정확한 fix를 담은 **새 self-contained subagent**를 띄운다(컨텍스트 상속 안 됨). fix 후 그 diff만 focused 재리뷰.
- **code-quality 리뷰어의 "APPROVED, but Important·나중에 fold 가능"이 spec invariant 위반이면 미루지 말 것** (Slice 9b): 9b 조건 빌더 ×버튼이 빈 그룹(engine `All([])` vacuous-true, spec §3.2 "UI는 빈 그룹 금지" 위반)을 만들 수 있던 걸 리뷰어가 "later polish"로 표시했지만, spec 보장 위반이라 그 슬라이스 안에서 fix(위 deferral 함정과 같은 맥락 — 미룬 건 사라진다).
- **최종 whole-feature 리뷰는 `handicap-reviewer` 에이전트로** (Slice 9b): repo-trap-aware라 per-task 리뷰가 구조상 못 보는 크로스커팅을 잡는다 — 특히 UI Zod 모델 ↔ 엔진 serde **와이어포맷 1:1 대조**(field명·연산자·`right` 생략 등), deferral 추적, build/lint 게이트 재확인.
- **새 `EnterWorktree` 워크트리엔 `ui/node_modules`·`target/`가 없다** (A1): 테스트 돌리는 subagent를 띄우기 전에 `cd ui && pnpm install`(pnpm 전역 store라 ~수초) + `cargo build`로 baseline부터 깐다 — 안 그러면 첫 subagent가 deps 없어 바로 실패. UI·Rust 둘 다 건드리는 슬라이스면 둘 다.
- **implementer subagent가 mid-task로 끊길 수 있다** (A1, 한 세션에 2회; Slice 9c에서도 1회 재현): report 없이 truncated되면 변경이 uncommitted로 worktree에 남고 build gate·commit이 안 된 상태다. **report를 믿지 말고**(테스트 개수·baseline 같은 수치도 부정확할 수 있음) `git status`/`git diff HEAD`/grep로 실제 상태를 확인한 뒤, 남은 step(테스트 → `cd ui && pnpm test && pnpm build` → commit)을 직접 마저 하거나 fix-subagent로 완료한다. 매 task의 실제 상태는 subagent report가 아니라 직접 실행한 테스트/빌드로 검증.
- **하니스가 subagent tool result·Edit 직후 띄우는 `<new-diagnostics>`(rustc/rust-analyzer)는 STALE일 수 있다** (A2-2, 한 세션 2회): implementer가 이미 고친 call site를 옛 상태로 표시(중간-edit 스냅샷)하거나, **proto 변경 시 stale codegen 캐시**(여러 `target/debug/build/<crate>-*/out/*.rs` 중 RA가 옛 디렉토리를 가리켜 `no such field`). flagged 에러를 진짜로 취급하기 전 독립 `cargo build --workspace` + `cargo test -p <crate> --no-run`(테스트 call site까지 컴파일)로 실제 상태 확인 — T3·T6 둘 다 stale 진단이 green 커밋과 모순이었다. 진단도 보고도 불신, 빌드/테스트만 신뢰.
- **implementer subagent의 commit은 단일 FOREGROUND blocking 호출로 시키고 background+poll 금지** (A4b, 한 세션 3회 truncate): implementer가 `git commit`을 `run_in_background`로 띄우고 완료를 폴링하는 루프가 subagent 턴을 mid-poll에 truncate시킨다(commit 미완 + 변경 uncommitted 잔류 → 위 항목 복구 필요). 프롬프트에 "commit은 `run_in_background:false` + timeout 600000ms 단일 호출, 폴링 금지"로 못박으면 사라진다(T6부터 깨끗). 반대로 **orchestrator 자신의** 커밋은 background가 맞다(완료 notification 받고 그동안 read-only 준비 가능) — 단 두 커밋 동시 진행은 `target/`·`index.lock` 경합이라 항상 직렬.
- **subagent-driven plan을 컨텍스트 리셋/토큰 소진 후 재개하려면 git 커밋이 진실의 원천** (unique 바인딩): 각 task가 독립 커밋(implementer가 task 끝에 commit)이라 진행 상태는 워크트리 git 히스토리에 durable. 재개 레시피: ① 워크트리는 `.claude/worktrees/<name>`에 보존(`ExitWorktree(remove)` 전엔 안 지워짐) → `EnterWorktree(path: …)`로 재진입; ② `git log --oneline <base>..HEAD`로 완료 task 확인 후 plan의 `- [ ]` 체크박스와 대조해 **첫 미커밋 task부터** 재개; ③ `git status`/`git diff HEAD`로 중단 task의 uncommitted 부분작업 복구. TodoWrite/Task 리스트는 컨텍스트와 함께 리셋되니 신뢰 금지 — 커밋·직접 실행한 테스트/빌드만 신뢰.

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
- **0023** Conditional 노드: if/elif/else + 재귀 조건 트리 + lenient 평가 + 상호 1레벨 중첩 + 분기별 결정 카운터(9a–9d, 최상위 `if_breakdown`)
- **0024** Run 프리셋: scenario-scoped 독립 리소스(`run_presets`) + Profile 재사용 + validate_run_config 공유 + dataset delete soft-guard
- **0025** 환경(Environments): top-level 재사용 리소스(`environments`, migration 0007, UNIQUE→409) + 클라 오버레이 스냅샷(B-1+B-2)
- **0026** 시나리오 에디터 test-run: 컨트롤러 in-process 단일패스 trace(ephemeral) + `POST /api/test-runs` + 미바인딩 토큰 수집(C-1+C-2)
- **0027** 멀티 워커 fan-out: 컨트롤러 권위 N + shard 배정 + 글로벌 vu_id + 워커별 메트릭 머지(run_metrics PK +worker_id, migration 0008) + K8s Indexed Job(A3a–c)
- **0028** Run-level SLO criteria: profile_json 스냅샷 + 고정 per-metric verdict + status-class/per-window RPS(B6) + `runs.verdict_json` 배지 영속(migration 0012)
- **0029** JSON body 타입 캐스트: flow `{{var:num}}`/`{{var:bool}}`/`:str`, leaf 레벨 파싱, 엄격 실패(`CastFailed`), 캐스트 없으면 byte-identical
- **0030** Run 비교 + 리포트 export: 하이브리드(클라 비교/서버 CSV·XLSX), same-scenario terminal-only, 골든 fixture TS↔Rust 패리티
- **0031** Open-loop / arrival-rate: opt-in `target_rps` + 균등 틱 스케줄러 + `max_in_flight` 슬롯풀 + `dropped` 카운터(migration 0009), 단일워커 v1
- **0032** 다단계 ramp: open-loop `stages:[{target,duration}]` piecewise-linear 곡선(고정 target_rps 일반화), 마이그레이션 0, stages 없으면 byte-identical
- **0033** Parallel 노드: `type: parallel` `join_all` 동시 분기(공유 jar) + `{{branch.var}}` 네임스페이스 merge + 그룹/페이지 레이턴시(A2-2, migration 0010)
- **0034** Run 스케줄러: 컨트롤러 내장 cron 루프 + once/5-field 트리거(`croner`) + 단일 IANA TZ + `spawn_run` 발사 코어 + migration 0011(34a–c)
- **0035** UI 문구: 한국어 통일 + `ko.ts` 메시지 카탈로그 경유 (고유명사 원어 병기 + HelpTip, i18n 라이브러리·토글 비목표)
- **0036** 스텝 템플릿: top-level `step_templates` 리소스 + 복사-삽입 스냅샷(삽입 시 ULID 재발급), 참조 동기화 기각

## 코딩 컨벤션

- **Rust**: `cargo fmt`, `cargo clippy -- -D warnings`, 테스트 `cargo test`. workspace `members = ["crates/*"]` glob — 새 crate는 `crates/<name>/Cargo.toml`만 만들면 자동 인식.
- **TypeScript**: prettier + eslint, 테스트 vitest. **`pnpm build`(`tsc -b && vite build`)가 최종 게이트** — `pnpm test`(jsdom + esbuild transpile)는 TS strict 에러를 안 잡는 경우가 있다. UI 변경 commit 전 `pnpm lint && pnpm test && pnpm build`를 한 번 돌리는 게 안전(`pnpm lint`는 `--max-warnings=0`이라 경고도 실패 — CI엔 있지만 hook엔 없다). 자세한 함정 → `ui/CLAUDE.md`.

## 새로운 아키텍처 결정이 생기면

`docs/adr/`에 새 ADR 파일 추가 (다음 번호 사용, MADR 포맷). 이 CLAUDE.md "알아둘 결정들" 인덱스엔 **한 줄(번호+제목+핵심 한 마디)만** — 상세·근거는 ADR 파일이 단일 소스다(인덱스에 문단을 쌓지 말 것).

## 새 함정을 배우면

그 함정이 속한 **도메인 디렉토리의 `CLAUDE.md`** 에 한 줄 추가(인라인 `(Slice N)` 출처 태그 유지). 여러 crate에 걸친 크로스커팅 함정·프로세스 노트·로컬 dev 실행 footgun만 이 루트 파일에. 새 도메인 디렉토리가 생기면 위 [도메인별 함정 인덱스](#도메인별-함정-인덱스) 표에 행 추가.

## 슬라이스/기능을 완료하면 (root 재비대 방지)

이 root 파일은 **매 프롬프트에 통째로 로드**되므로 "매 세션 필요한 것"(전역 규칙·현재상태 한 줄·크로스커팅 함정·인덱스)만 남기고, "가끔 필요한 것"(과거 이력·결정 근거·도메인 함정)은 *포인터 + on-demand 파일*로 뺀다. 따라서 기능 완료 시:

- 구현 결과 요약(파이프라인·함정 출처·라이브 검증)은 root가 아니라 **`docs/build-log.md`에 한 단락 append**.
- root **상태 줄은 한 줄로 *교체*(append 금지)** — "어디까지 됐나"만. 디테일은 build-log/ADR/메모리가 들고 있다.
- 새 ADR는 인덱스에 **한 줄만**(위 규칙), 기능별 상세 작업 메모는 자동메모리 `MEMORY.md` 항목.
- 신호: root가 다시 ~50 KB를 넘으면 같은 기준으로 build-log/ADR/도메인 CLAUDE.md로 재분배.

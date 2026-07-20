# Handicap

사내 QA·운영팀을 위한 부하 테스트 도구. REST API를 대상으로, **QA는 드래그-드롭으로 시나리오를 만들고**, **개발자는 같은 시나리오를 YAML/DSL로 편집** 한다 (두 뷰가 같은 모델의 양방향 sync). LoadRunner/JMeter를 사내에서 대체하는 것이 목표.

> **함정(gotcha) 노트는 도메인별 중첩 CLAUDE.md로 분할됨** — 각 디렉토리 파일을 그 디렉토리 작업 시 자동 로드한다. 이 루트 파일엔 전역 규칙·상태·크로스커팅 함정만 남긴다. 인덱스는 아래 [도메인별 함정 인덱스](#도메인별-함정-인덱스).

**상태: MVP 1단계(슬라이스 1–9) 완료 + post-MVP1 영역 A(프리셋·멀티워커 fan-out·Parallel·리포트 export/insights)·B(환경·SLO criteria·리포트 깊이)·C(에디터 test-run)·D(부하모델·페이싱: 타임아웃/think-time/open-loop/stages/VU 곡선) + Run 스케줄러 + 영역 U(UX, ADR-0035) + 후속 다수(LAN 분산 워커 L1–L7·풀 운영 견고성/제어상태 영속화·Tauri 데스크톱[in-process, ADR-0042]·단일 self-contained exe[ADR-0039]·HAR→시나리오 가져오기·다중 데이터셋 바인딩·운영 상한 관리자·스텝 템플릿 관리·ko.common 한국어화·게이트-에러 한국어 매핑·디자인 시스템[ADR-0043]·RunDialog 간단/상세+목업 시각 충실도 재구성·비교 뷰 깊이/XLSX Δ 조건부 서식·트랜잭션 시간 분해·Run 라이브니스 G1/G3+stall 배지·closed-loop 곡선 fan-out 샤딩·결과화면/스텝 막대 폴리시·에디터 캔버스→아웃라인 재설계·에디터 레이아웃 후속 버그 수정·에디터 드래그 메커니즘 수리·에디터 YAML 모달 가져오기/내보내기·JSON 바디 캐스트 확장·에디터 테스트 흐름 칩 스트립·에디터 경계 드래그/re-parent·시나리오 삭제/이름 라이브 편집·에디터 공간·이름 QoL·Button-accent 색 이주·에디터 변수 도구 A·에디터 뷰포트 높이 floor·에디터 뷰포트 폴리시 v2·저장 안 됨 이탈 가드·HAR 쿼리 안전 디코딩·open-loop 슬롯 사이징 교정·open-loop 단위 표면화·시나리오 기본 think time·open-loop think 검증/무시 토글(§B21)·graceful ramp-down 상한(§B9)·에디터 test-run 데이터셋 바인딩 등 — **전수 목록·구현 결과·함정 출처는 `docs/build-log.md`가 단일 소스**)까지 구현·머지 완료. 최신 = trustworthy-open-test(§A11 1차 — soft `validity`+`narrative` on build_report: transport/silent/no_response/load/zero 승격 + events/can/cannot · ValidityBadge 헤더 · Headline emerald 연동 · Banner→Narrative→Verdict→Insight · XLSX Summary 3행 · engine/worker/proto/migration 0-diff · 보안 N/A · 라이브 R11 wire PASS[8099] · 머지 f93544a, 2026-07-20): 완료 슬라이스/기능 상세·함정 출처 → `docs/build-log.md`, 다음 작업(테마별 frontier+추천) → `docs/roadmap-status.md`(현황판·shortlist 대체), 후보 메뉴·연기 항목 상세 → `docs/roadmap.md`, ADR 인덱스 → 아래 [알아둘 결정들](#알아둘-결정들), 결정 전문 → `docs/adr/`. 디자인 → `docs/superpowers/specs/`, 구현 계획 → `docs/superpowers/plans/`. MVP 1단계 spec=`2026-05-27-handicap-mvp1-design.md`(슬라이스 1–6), 후속은 그 §4.5 메뉴에서 각자 새 spec/plan으로.**

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

# git 훅 설치 (클론마다 1회 — core.hooksPath를 tracked .githooks/로)
just install-hooks

# 슬라이스 1 acceptance
just build && just lint && just test     # 18 tests must pass
```

`rust-toolchain.toml`이 stable 채널을 고정하므로 `cargo` 호출만 해도 올바른 toolchain을 잡는다. **`just install-hooks`는 필수다** — 층상 pre-commit 게이트가 tracked `.githooks/`에 살아 있고, 이 명령이 `core.hooksPath`를 거기로 지정해야 클론에 적용된다(안 하면 게이트 없이 커밋됨).

## 검증 자동화 (Git + Claude hooks)

`.githooks/pre-commit`(tracked, `core.hooksPath`; 클론마다 `just install-hooks` 1회 필수)은 **층상 게이트**: ⓪ conflict-marker 가드(`<<<<<<<`/`>>>>>>>` 줄-시작 staged면 abort) → ① `ui/`(non-`.md`) staged면 **UI 게이트**(`pnpm lint && pnpm test && pnpm build`; `ui/node_modules` 없으면 graceful skip) → ② cargo-영향 경로(`crates/`·`Cargo.toml`·`Cargo.lock`·`.proto`·`.sql`·`rust-toolchain.toml`·`.cargo/`; `.md`는 위치 무관 제외) staged면 **cargo 게이트**(`fmt --check`+워커 워밍 빌드+`build --workspace`+`clippy -D warnings`+`nextest`+doctest). **cargo-영향 경로가 하나도 없으면 cargo 검사 통째로 skip**(docs/ui/.claude-only 빠른 통과).

**매 커밋 일상 규칙:** ① cargo-영향 커밋은 전체 workspace 빌드라 수 분 → `git commit`을 `run_in_background`로 돌리고 그동안 다른 `cargo` 호출 금지(`target/` 락 경합). ② **`git commit … | tail`/`| head` 파이프 금지** — 파이프 종료코드가 git 실패(pre-commit reject 포함)를 마스킹한다(git-guard가 deny). 커밋 후 `git log -1`로 landed 확인. **검증 게이트 체인도 동일**(editor-dataset-testrun): `pnpm lint && pnpm test | tail`은 test 실패를 마스킹한 채 `&&` 후속으로 진행 — 게이트 판정은 파이프 없이 `; echo exit=$?`로 종료코드 명시 캡처. ③ **`--no-verify` 우회 금지**(사용자 명시 요청 없이는 — 회귀가 들어가면 후속 작업이 다 빨개진다). ④ 빈-staged 커밋은 `.md`여도 fast-path를 못 타고 full 게이트를 돈 뒤 'nothing to commit' → 커밋 전 `git diff --cached --name-only`로 staged 확인.

**Claude PreToolUse 훅 4종**(`.claude/hooks/`): `tdd-guard.sh`(src 편집 시 작업트리에 pending test 파일 없으면 차단 — 인라인 `#[cfg(test)]`/`it.todo` stub로 unblock), `git-guard.sh`(`git commit … | …` 파이프·`--no-verify` deny, `checkout/switch/stash` ask), `controller-bin-guard.sh`(`cargo run -p handicap-controller`에 `--bin` 없으면 deny), `spec-review-guard.sh`(브랜치 plan에 EOL-앵커 `REVIEW-GATE: APPROVED` 없으면 `crates/*/src`·`ui/src` 편집 deny). 슬라이스 시작/마무리는 `/start-slice`·`/finish-slice` 스킬, 마이그레이션은 `/new-migration`, 라이브 검증은 `/live-verify`.

**git 토폴로지:** 통합 브랜치 `master`(`main` 없음 — 세션 컨텍스트의 "Main branch: main"은 부정확), remote `origin`=`github.com/SeonggukJeong/handicap`(gh CLI=SeonggukJeong; 구 limvik 계정명 변경, **2026-07-11부터 PUBLIC** — 홍보용 README/LICENSE(MIT)/`docs/images/` 스크린샷 있음, push 전 민감정보 주의). 단 슬라이스/브랜치 마무리는 **여전히 로컬 ff-merge(PR 아님)** + origin에 master를 주기적으로 push. **릴리즈 = `v*` 태그 push → `release.yml`(windows-latest `tauri-action`)이 NSIS/MSI 인스톨러+포터블 단일 exe(`Handicap_<ver>_x64-portable.exe`) 빌드+GitHub Release 자동 게시**(현재 최신 v0.4.0; 버전 bump→커밋→태그 절차 → `docs/dev/tauri-desktop-build.md` §CI 릴리즈). 워크트리 *안에서*: `git -C /Users/sgj/develop/handicap merge --ff-only worktree-<X>`(사전 `merge-base --is-ancestor master worktree-<X>` + 메인 `status --porcelain -uno` clean 확인) → 머지 확인 후 `ExitWorktree(remove, discard_changes:true)`. **`EnterWorktree(name: X)` → 브랜치명 `worktree-X`·디렉토리 `X`(비대칭)** 이라 ff 스텝은 반드시 `worktree-X`.

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

- **`cargo run -p handicap-controller`만 쓰면 깨진다**: `handicap-controller` 패키지엔 바이너리가 둘(`controller` + `e2e_kind_driver`)이라 `error: could not determine which binary to run`. 로컬 실행은 **항상 `cargo run -p handicap-controller --bin controller -- …`** (또는 `just run-controller`/`run-controller-with-ui` — 이미 `--bin controller` 고정).
- **엔진/시나리오 모델 변경 브랜치 pull·merge 후엔 `cargo build -p handicap-worker` 필수**: `cargo run -p handicap-controller`는 controller만 빌드하고 `target/debug/worker`(subprocess가 spawn하는 그 바이너리)는 안 건드린다. 옛 워커는 새 스텝 타입을 못 읽어 run 시작 직후 exit 1. **증상 함정**: 워커 *종료*(exit/disconnect) 시 run은 즉시 `failed`로 전이된다(2026-06-05 reaper + `worker_disconnected` fail-fast) — 실패 run의 `message` 필드에 사유가 남으니 controller 로그 외 run 상세(`GET /api/runs/{id}`)에서도 확인 가능. **"run이 영영 running + 0 req"는 이제 등록 후 hung(살아있지만 무진행) 워커에 한정(G1 — 별도 후속)** — controller 로그의 worker exit를 먼저 본다. 상세 → `docs/dev/ui-slice-7-manual-check.md`.
- **status=0 + 비정상적으로 높은 RPS = HTTP 도달 전 단계 실패**: connection refused / URL parse / DNS 등 fail-fast. 진짜 5xx는 RPS가 정상 범위. 점검 순서: 시나리오 URL이 host 없는 `/login`인지, wiremock이 죽었는지, env가 빈 채로 `${BASE_URL}`이 unresolved인지.
- **여러 워크트리에서 `pnpm dev`(5173)·`cargo run --bin controller`(8080) 포트 선점**: 다른 워크트리/master에서 띄운 프로세스가 살아있으면 stale 번들을 서빙하거나 잘못된 DB에 붙는다. 증상: 컨트롤러는 새 빌드(curl 200)인데 UI에서 새 기능이 동작 안 함. `lsof -i :5173`/`:8080` → `ps -o cwd= -p <PID>`로 워크트리 확인 → stray 죽이고 현재 워크트리에서 재시작 + 브라우저 hard reload. (kind port-forward 8080/9001 충돌·재기동은 `deploy/CLAUDE.md`.) **단 8080 점유자가 이 repo 것이 아닐 수 있다 — 죽이기 전에 반드시 `ps`로 확인**(thinkboard-defaults 2026-07-19: 8080을 사용자 자신의 `llama-server`가 쓰고 있었다). 남의 프로세스면 **컨트롤러를 옮긴다**: `--rest 127.0.0.1:8099 --grpc 127.0.0.1:8098`(둘 다 옮겨야 함 — grpc 기본 8081도 충돌 가능) + Playwright도 그 포트로 navigate. `/live-verify` 레시피의 8080 가정은 편의일 뿐 남의 프로세스보다 우선하지 않는다. `lsof -ti :<port>`는 **리스너와 클라이언트를 함께** 반환하니(브라우저 탭이 섞여 나온다) `kill $(lsof -ti …)`로 뭉뚱그리지 말고 `pgrep -f "target/debug/controller --db /tmp/<slug>.db"`처럼 **내가 띄운 프로세스만** 지목해 죽일 것.
- **워크트리에서 백엔드 라이브 검증은 그 워크트리의 *자체* 바이너리로**(Run 스케줄러 34c): 워크트리는 메인과 분리된 `target/`(`.claude/worktrees/<name>/target/debug/`)을 갖는다. 메인 체크아웃의 절대경로(`…/handicap/target/debug/controller`)로 돌리면 **다른 브랜치의 stale 바이너리**(새 CLI 플래그·엔진 변경 없음 → `unexpected argument` 등으로 깨짐)가 실행된다. `find -maxdepth 5`는 깊이 6의 워크트리 target을 놓쳐 위치 오판을 부른다. → 워크트리 root에서 `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller` 후 **상대경로 `./target/debug/controller --db /tmp/x.db --ui-dir ui/dist …`**로 실행(controller가 spawn하는 `target/debug/worker`도 cwd-상대라 같은 fresh 바이너리). **백엔드-only 슬라이스(UI 0-diff·`ui/dist` 미빌드)는 `--ui-dir`를 통째로 생략**(SPA 불필요) — controller는 `--ui-dir <없는 경로>`면 시작 시 `Error: --ui-dir "..." does not exist`로 **fail-fast**라, live-verify 레시피의 `--ui-dir ui/dist`를 그대로 쓰면 dist 없는 워크트리에서 컨트롤러가 안 뜬다(B9 closed-curve fan-out 라이브 검증).
- **게이트 출력을 고정 `/tmp/x.log`로 리다이렉트하면 *이전 세션·다른 워크트리*의 stale 로그를 읽어 거짓 'FAIL'** (사이징 헬퍼): Bash 툴 cwd는 호출 간 유지돼 `cd ui && … > /tmp/lint.log`가 (이미 ui 안이면) `cd` 실패→`&&` 단락→직전 `tail /tmp/lint.log`가 *다른 워크트리 경로*의 옛 출력을 보여준다. 로그 헤더에 다른 브랜치/워크트리명이 보이면 stale(=실패 아님). 절대경로 `cd /Users/.../<worktree>/ui` + 워크트리-스코프 로그명(`/tmp/<slug>-lint.log`)으로 회피.
- **`just run-controller-with-ui`는 `ui/dist`가 *없을 때만* UI를 빌드한다**(`if [ ! -f ui/dist/index.html ]`) — UI 변경/머지 후 dist가 stale이어도 재빌드 안 하고 옛 번들을 단일-포트(8080)로 서빙한다(위 포트 선점과 다른 별개 함정). 새 UI 기능이 안 보이면 `just ui-build` 수동 실행(+브라우저 hard reload). vite dev 5173은 HMR이라 무관.
- **로컬에서 curl로 직접 구동 (수동 검증/더미 데이터 생성)**: 시나리오 생성 `POST /api/scenarios {"yaml":…}`(name은 YAML에서 파싱 — `jq -Rs '{yaml:.}' f.yaml | curl -sX POST …/api/scenarios -d @-`로 이스케이프 회피). run 목록은 `GET /api/scenarios/{id}/runs` (**`GET /api/runs` 목록 엔드포인트 없음** — `POST /api/runs` + `GET /api/runs/{id}`만). run 생성 `POST /api/runs {"scenario_id":…,"profile":{"vus":N,"duration_seconds":S},"env":{}}`(`ramp_up_seconds`·`loop_breakdown_cap`는 default). **`vus`도 serde default(0)라 open-loop(`target_rps`/`max_in_flight`)·VU 곡선(`vu_stages`) 페이로드는 vus 생략 가능 — closed-loop만 `validate_run_config`가 `vus>0` 강제(open-loop은 vus 값 무시: 부하=target_rps+max_in_flight). `duration_seconds`만 항상 필수.** report summary 키 = `count/errors/rps/p50_ms/p95_ms/p99_ms`(`total_requests`/`error_count` 아님). 시나리오 YAML엔 **`version: 1` + 각 step `id`(유효 ULID — I/L/O/U 제외)·`type`·`name` 필수**(http step은 셋 다 required — `HttpStep.name: String`; 없으면 `422 missing field version`/`missing field name` 또는 ULID 파싱 거부). 에디터 test-run 단발(trace/본문 뷰어 검증용)은 별도 ephemeral 엔드포인트: `POST /api/test-runs {"scenario_yaml":…,"env":{},"max_requests":N}` → `ScenarioTrace`(미저장; `steps[].response.{body,body_truncated}` 확인). **함정: zsh `echo "$json" | python3`는 serde_json이 이스케이프한 `\n`(2글자)을 실제 개행으로 풀어 JSON 파싱을 깨뜨린다(`Invalid control character`)** — curl을 python에 **직결**(`curl … | python3 -c …`)하거나 `printf '%s' "$json"` 사용. `GET /api/scenarios`는 `{"scenarios":[…]}` 래퍼(bare 배열 아님), 단일 scenario/run 응답은 객체. **생성 응답(`POST /api/scenarios`·`/api/runs`)은 멀티라인 `scenario_yaml`을 임베드 → 셸 변수에 담아 `jq -r '.id'`/`python json.load`하면 raw 개행으로 깨진다**(phase-breakdown): 생성 응답을 파싱하지 말고 `GET /api/scenarios/{id}/runs`(목록)에서 id를 재조회하거나 curl→python 직결. **비자명한 추출(f-string·다중키)은 인라인 `-c` 말고 파서를 `.py` 파일에 쓰고 `curl … | python3 /tmp/parse.py`** — zsh에서 `python3 -c '…'`는 f-string 속 `\"`가 깨지고, `curl | python3 <<'EOF'`는 heredoc이 pipe stdin을 덮어써 `json.load(sys.stdin)`가 curl이 아닌 스크립트를 읽는다(live-verify 세션 재확인).
- **요청 *내용*(실제 전송된 헤더/폼 필드)을 검증하려면 로깅 echo 타깃이 필요**: 리포트는 집계-only이고 시나리오 assertion은 `status`뿐이라 "무엇이 실제로 나갔나"(예: B4 disabled 행 미전송)를 리포트로는 못 본다 → 시나리오 url을 헤더/바디를 파일로 찍는 echo 서버로 돌리고 와이어를 grep. python `ThreadingHTTPServer` echo가 localhost ~10k rps 감당. **함정: live-verify 스킬 번들 `responder.py`는 `log_message`가 no-op이라 요청을 안 찍는다** — 와이어에 주입된 변수(`{{track}}` 등)를 grep하려면 `print(f"REQ {self.command} {self.path}")` 찍는 로깅 변형을 따로 써라(다중 데이터셋 바인딩). run-detail UI 라우트는 `/runs/{id}` — `/scenarios/{sid}/runs/{rid}`로 가면 404(`routes.tsx`).
- **부하 페이싱/타임아웃 기능(think time·timeout·향후 open-loop/stages)은 RPS로 수동 검증** (S-B 수동테스트): python `ThreadingHTTPServer` 200-responder + controller subprocess 워커 + 격리 DB(`./target/debug/controller --db /tmp/x.db --ui-dir ui/dist`, 먼저 `cargo build -p handicap-worker --bin worker`)로 띄우고 run 리포트 `summary.rps`를 관찰. **closed-loop think time RPS ≈ `VUs / think_ms`**(예: 2 VU·200ms→~10 RPS, per-step도 동일식; 베이스라인 대비 수백배 하락이라 신호 명확). **단 이 공식은 평평한 순차 시나리오 근사다 — loop/parallel이 섞이면 틀린다**(think-time-dashboard 라이브: 전 스텝 200ms·2 VU인데 측정 11.32 RPS. 반복당 요청 수는 loop `repeat`만큼 늘고, parallel 분기는 **동시 실행이라 벽시계는 1개분만** 먹는다 → `2 VU × 7요청 ÷ 1.2초 = 11.67` 예상의 97%로 정상. 구조를 안 세고 10을 기대하면 멀쩡한 구현을 FAIL로 오판한다). test-run 페이싱은 `POST /api/test-runs`를 curl `-w '%{time_total}'`(wall)로 `apply_think_time` on/off 비교. UI 라운드트립(Playwright) 검증 디테일 — `browser_take_screenshot`/`browser_snapshot` 저장경로·`.playwright-mcp` 머지 전 정리·**Playwright MCP cwd 고정**(과거 워크트리)·인라인 `browser_evaluate`·React controlled input native setter·`el.click()` React 18 batching·`browser_console_messages({all:true})` cross-session 버퍼·CONNECTION_REFUSED≠Zod에러 → **docs/dev/live-verify-playwright.md**(／live-verify 시 로드).
- **UI run 생성/응답-파싱 경로는 RTL·`tsc -b`로 안 잡힌다 — 슬라이스 머지 전 라이브 run 1회 필수** (S-D Playwright 발견): RTL fixture는 서버가 실제 보내는 `null`이 아니라 *absent*를 줘서 Zod `.optional()`↔서버-`null` 미스매치를 통과시킨다(`tsc`도 못 봄). 머지 전 controller+worker 띄우고 RunDialog로 run 1개 생성→리포트까지 확인(또는 curl `POST /api/runs` 후 응답 JSON에 `null` 필드가 `ProfileSchema`를 통과하는지). S-D에서 이 누락(`ProfileSchema` `.optional()`이 서버 `null` 거부)이 **모든 run UI 생성을 깨뜨린 채** 전 슬라이스 잠복했었다 — 상세 `ui/CLAUDE.md` `.nullish()` 함정.

## Subagent dispatch 노하우

> 여기엔 **규칙 요약만** — 사고 서사·복구 레시피·근거 수치 전체는 [`docs/dev/subagent-dispatch.md`](docs/dev/subagent-dispatch.md)(재비대 방지 추출 2026-07-16, commit-gates 선례와 동일). 규칙이 처음이거나 "왜?"가 필요하면 그 파일을 읽어라. 새 dispatch 함정은 규칙 한 줄을 여기, 서사를 그 파일에.

**brief/plan 작성**
- plan task 헤딩은 숫자 `Task N`으로 — `task-brief`가 문자 라벨("Task A") 미매칭 exit 3.
- plan의 task-밖 공유 정본(카피 표·keep-list)은 별도 파일로 1회 추출해 brief와 함께 디스패치("byte-exact" 명시) — `task-brief`는 그 task 섹션만 자른다.
- spec의 `사용자 스토리 (US)` 고정 헤딩 블록도 1회 추출해 매 brief에 첨부(US 스파인, ADR-0048 — 원천=spec, 헤딩부터 다음 동레벨-이상 헤딩까지; 규약 `docs/dev/user-story-spine.md`).
- `ui/src`를 한 줄이라도 건드리는 task는 brief에 UI 테스트 스텝 명시(tdd-guard가 UI-side pending test 요구).
- plan 인라인 Rust는 clippy-clean으로 — 2-arm `match … _ => {}` 대신 `if let`(`-D warnings`).
- **plan이 verbatim 지정한 테스트도 이빨이 없을 수 있다** — 회귀 가드를 표방하는 테스트는 brief의 "검증 의무"에 **고의 회귀→RED→원복→GREEN 실증**을 못박을 것(think-time-dashboard에서 3건 적발: 단언 대상이 버그와 무관하게 안정적인 값[`Object.is(undefined,undefined)`]·같은 행에 동일 문구 2개[위치 의존 `getAllBy...[0]`]·복합 `disabled` 조건에서 다른 항이 이미 참). plan-mandated 결함은 기각 대상이 아니라 finding이다 — plan이 자기 작업을 채점하지 않는다. → 메모리 [[plan-mandated-vacuous-tests]] **4번째 패턴(thinkboard-defaults): 단언이 *부분문자열*로 통과** — `toHaveTextContent("대기없음")`이 "없음 — 상속 스텝은 모두 대기없음"에도 걸려 두 분기를 구별 못 했다. 상세는 `ui/CLAUDE.md`.
- **plan의 *사실 주장*도 검증 대상이다 — "충돌 회피됨"·"N/A 예상"·"byte-identical"은 근거가 아니라 가설** (thinkboard-defaults): 그 plan의 Global Constraints는 신규 ko 4개가 "부분문자열 충돌까지 회피된 값"이라 단언했지만, 충돌 표가 **신규↔신규만 대조하고 신규↔기존을 안 봐서** 실제로는 거짓이었다(최종 리뷰가 적발). 같은 클래스: think-time-defaults의 "보안 게이트 N/A 예상"이 틀려 `trace.rs` 매치가 났던 건. **plan이 X를 확인했다고 적어놨으면 그 확인을 *다시 돌려라*** — 특히 전수 grep·충돌 대조·0-diff 주장처럼 기계로 재현 가능한 것은 orchestrator가 직접(self-report 신뢰 천장은 낮다).
- **plan은 코드뿐 아니라 *훅*에 대해서도 실행 가능해야 한다 — 스텝 순서를 `tdd-guard`로 시뮬레이션할 것**(thinkboard-defaults, spec-plan-reviewer가 차단 지점 2곳 적발): `tdd-guard.sh`는 `/ui/src/.+\.(ts|tsx|js|jsx)$`(=`i18n/ko.ts`도 포함)를 production으로 보고 **작업트리에 수정/미추적 테스트 파일이 0건이면 `exit 2`**. ① 직전 task 커밋 직후는 트리가 clean이므로 **task의 첫 스텝이 production 편집이면 무조건 차단** → 테스트 스텝을 먼저 두라. ② "테스트 파일 무수정"이 acceptance인 순수 리팩터 task는 **구조적으로 통과 불가** → 임시 `it.todo` 한 줄로 언블록하고 **커밋 전 제거를 독립 체크박스 스텝으로** 승격하라(훅은 파일 내용을 안 열고 존재만 본다 — `tdd-guard.sh:92`). 제거를 산문에 묻으면 아무도 못 잡는다: `it.todo`는 vitest에서 실패가 아니라 게이트가 green이고, `git add`가 소스만 스테이징하므로 커밋 diff도 깨끗하다.
- **줄번호는 `grep -n`으로만 확정 — `sed -n 'N,Mp'` 출력 줄을 세지 말 것**(thinkboard-defaults에서 2회 오프바이원): 한 번은 *맞게* 적힌 spec 참조를 틀리게 "고쳤고"(리뷰어가 교정), 한 번은 plan 인용이 어긋났다. spec/plan의 `파일:줄` 주장은 리뷰어가 전수 대조하므로 오프바이원이 곧 finding이 된다.

**디스패치**
- 워크트리 작업이면 prompt 첫 줄에 `cd /Users/sgj/develop/handicap/.claude/worktrees/<name>` 절대경로 명시(안 하면 메인 체크아웃을 읽고 "코드가 없다" 오보).
- 리포트 경로는 `.superpowers/sdd/` 지정 + "worktree 루트에 `.md` 쓰기·`git add` 금지" 못박기.
- implementer의 commit은 단일 FOREGROUND 호출(timeout 600000ms)·background+poll 금지(mid-poll truncate). orchestrator 자신의 커밋은 background가 맞다 — 단 두 커밋 동시 진행 금지(`target/`·`index.lock` 경합).
- 무거운 env-setup·외부 바이너리 가정은 디스패치 전 orchestrator가 pre-warm·실측해 값으로 넘긴다(외부 바이너리 *행동*은 spec-plan-reviewer가 못 잡는다).
- 1M-context 부모에서 `model:` 생략 디스패치는 즉사+가짜 completed — 항상 **명시 `model:`**(정의된 reviewer들도 1M 세션에선 명시 `model: opus`). notification `tool_uses`/`tokens`/`duration`이 0이면 실행 안 된 것 — status=completed를 결과로 신뢰 금지, 메인 폴백.

**리뷰**
- task마다 두 단계 review(spec-compliance → code-quality), 둘 다 APPROVED여야 다음. **모델 라우팅: 기본 Sonnet, Opus는 조준 승격** — ① path-gate(engine/동시성/`unsafe`/proto·와이어/template·cast/env·dataset 바인딩/migration/대형 diff → 그 task의 code-quality를 `model: opus`) ② Sonnet self-flag(`escalate: true`) 재패스(트리거 보수적으로 — 승격률 ~40% 넘으면 역손해). 실행 중 Sonnet 자기승격 불가 — 승격은 항상 디스패처가. 정의된 `handicap-reviewer`/`security-reviewer`/`spec-plan-reviewer`는 `model: inherit`=Opus 유지(끌어내리지 말 것), `CLAUDE_CODE_SUBAGENT_MODEL` 설정 금지.
- 리뷰는 read-only만(`git diff`/`git show`) — `checkout`/`switch`/`stash`는 워크트리 attached HEAD 파괴라 금지.
- 리뷰-수정 루프: read-only 리뷰어는 같은 subagent를 `SendMessage`로 resume(코드베이스+직전 findings 보존 — 재리뷰가 싸고 "내 finding 반영됐나" 직접 검증), 코드-fix는 fresh focused subagent로(자가검증 편향). clean APPROVE 목표 + **유한 valve**: finding은 `receiving-code-review`로 타당성 판정(틀림·과설계·범위밖은 근거 1줄 기각), 루프 5회 초과 시 사용자에게 질문.
- 리뷰어가 "later fold 가능"이라 해도 **spec invariant 위반이면 그 슬라이스 안에서 fix**(미룬 건 사라진다).
- **finding을 뒤 task로 접기로 했으면 그 task의 brief에 명시 추가**(think-time-dashboard): 대화에서 내린 결정은 `task-brief`가 자르는 plan 섹션에 없으므로 implementer에게 **도달하지 않는다**. 특히 그 task가 plan에서 "드롭 가능"으로 표시돼 있으면 finding이 task와 함께 조용히 사라진다(리뷰어가 이 위험을 먼저 지적했다 — 접을 곳을 고를 때 그 task의 생존 보장 여부부터 확인).
- 최종 whole-feature 리뷰는 `handicap-reviewer`(Zod↔serde 와이어 1:1·deferral 추적·게이트 재확인). 단일-task plan은 per-task 리뷰와 병합해 1회 — 리뷰 BASE는 implementer 디스패치 직전 커밋(`HEAD~1` 금지, 멀티커밋 절단).
- 다른 슬라이스로 미룬 항목은 코드 주석만으론 유실 — 후속 scoping 때 `grep -rn "<슬라이스>" crates/ docs/`로 deferral 훑기.

**검증·재개 (subagent 불신 원칙)**
- 새 `EnterWorktree` 워크트리엔 `ui/node_modules`·`target/` 없음 — 디스패치 전 `pnpm install` + `cargo build` baseline.
- implementer는 mid-task truncate될 수 있다 — report(수치 포함) 불신, `git status`/`git diff HEAD`로 실상 확인 후 남은 step 직접 완료. Edit 직후 `<new-diagnostics>`도 STALE 가능 — 독립 `cargo build --workspace`+`cargo test --no-run`만 신뢰.
- 완성도(전수 grep) 게이트는 orchestrator가 **직접 재실행**(self-report grep은 신뢰 천장 낮음). zsh: 대상군을 변수 1개로 넘기면 word-split 안 됨(`set --`/명시 나열), 스코프 게이트는 two-dot 금지 — `git diff $(git merge-base master HEAD)..HEAD`.
- 컨텍스트 리셋 후 재개는 **git 커밋이 진실의 원천** — `git log <base>..HEAD` vs plan 체크박스로 첫 미커밋 task부터(TodoWrite/subagent report 불신).

## 슬라이스 파이프라인 (순서·게이트·재개 — 단계 생략 금지)

worktree 슬라이스의 고정 순서. **어느 단계도 "작아서/dogfood라서" 생략 금지** (2026-06-15 사고: `spec-plan-reviewer` 루프를 임의 건너뛰고 구현 직행 → reviewer가 뒤늦게 CRITICAL 1000× 단위 버그 적발. coverage≠correctness라 템플릿·체크리스트가 리뷰를 *대체 못 함*; 그래서 `spec-review-guard`가 reviewer 통과를 기계적으로 강제). 시작·마무리는 `/start-slice`·`/finish-slice` 스킬이 체크리스트, 아래가 전체 골격:

1. **시작** `/start-slice` — worktree(`worktree-<X>`) + 작업 선택 + baseline(`pnpm install`·`cargo build`).
2. **설계** brainstorming 종료 시 **US 초안(2–5개, 규약 `docs/dev/user-story-spine.md`)을 사용자에게 단독 제시·승인 후 spec 착수** — spec 앞머리에 `사용자 스토리 (US)` 고정 헤딩 블록 필수(버그는 재현/기대/실측, 내부-only는 `US: N/A — 이유` 대체 가; ADR-0048). spec → `spec-plan-reviewer` **clean `APPROVE`까지 반복**(`APPROVE-WITH-FIXES`/`NEEDS-REWORK`=미통과; finding은 `receiving-code-review`로 비판 평가 후 반영/기각). 이어 plan도 같은 루프. **clean APPROVE 후에만** plan에 `REVIEW-GATE: APPROVED` 마커 → 없으면 `spec-review-guard`가 `crates/*/src`·`ui/src` 편집 deny(미통과 상태 마킹 = 위조). **STOP-gate**: 이 세션에서 spec/plan을 새로 썼으면 커밋 후 `/clear`→fresh 컨텍스트로 3단계 진입. **사용자가 '바로 구현'을 요청해도 같은 세션 구현을 *권장/옵션으로 먼저 제시하지 말 것* — `/clear`→fresh가 기본 권장, 명시 고집 시에만 따른다**(2026-06-20 L2: 플랜 승인 후 '같은 세션 계속(추천)' 제시→채택→구현+라이브검증+finish로 컨텍스트 62% 소모, 사용자 교정. plan이 진실의 원천이라 fresh 구현이 품질·컨텍스트 양면 유리). [[stop-gate-fresh-context-impl]]
3. **구현** `superpowers:subagent-driven-development` — task별 fresh subagent(plan의 인라인 acceptance 전달), 각 task **독립 green 커밋**.
4. **최종 리뷰** `handicap-reviewer` APPROVE(크로스커팅·repo 함정·와이어 1:1). **+ 보안 표면 게이트(path-gated)**: diff가 요청실행·템플릿/캐스트·env/데이터셋 바인딩·업로드파싱·trace/body 뷰어를 건드리면 `security-reviewer`도 APPROVE 필수(blanket 아님 — `finish-slice` §0의 grep이 트리거; 매치 없으면 N/A 스킵). `security-reviewer`는 "쓸지 기억"이 아니라 diff가 결정. **plan/spec이 "N/A 예상"이라 적어놨어도 grep이 지배한다**(think-time-defaults: plan은 "think time은 페이싱뿐이라 무매치 예상"이라 썼으나 diff가 `crates/engine/src/trace.rs`를 건드려 매치 → security-reviewer 필수. 예측을 신뢰해 스킵하지 말고 `finish-slice §0`의 grep을 직접 돌릴 것).
5. **라이브 검증** — run-생성/report-파싱/엔진 경로를 건드리면 **필수**(`/live-verify`, S-D 갭). production diff 0(docs/테스트-only)이면 생략 + 근거를 build-log에.
6. **마무리** `/finish-slice` — build-log·roadmap·CLAUDE 상태줄·메모리 기록 → ff-merge → `ExitWorktree(remove, discard_changes:true)`.

**재개(컨텍스트 리셋 후 어느 지점이든)**: `git log --oneline master..<branch>` + plan `- [ ]` 대조로 **현재 단계 판정 후 그 다음부터**. 판정 신호 = ① plan에 `REVIEW-GATE: APPROVED` 유무(2단계 통과?) ② task 커밋 수 vs plan task 수(3단계 진척) ③ build-log/roadmap 완료 단락 유무(6단계?). TodoWrite/subagent report 불신 — **커밋·마커·직접 실행한 테스트만 신뢰**(위 "git 커밋이 진실의 원천"의 슬라이스-레벨 확장).

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
- **0037** closed-loop VU 곡선: park-gate 격리 함수 + vu_stages/ramp_down 와이어 + 단일워커 v1
- **0038** open-loop 멀티워커 fan-out: 명시 worker_count(기본 1, open 전용) + 컨트롤러 워커별 레이트 분할(shard_split) + A3b 머지 재사용, 엔진/proto/migration 무변경
- **0039** 라이트 Windows 데스크톱 배포: 단일 self-contained `.exe`(현 subprocess 로컬모드 패키징) → 필요 시 Tauri 래퍼, Flutter/RN 거절(웹 UI 리라이트). LAN 분산 워커는 프로토콜상 이미 가능(pull 모델)·격차=바인딩/오케스트레이션/mTLS. **옵션 A(단일 exe) 구현·머지**(cargo `bundle` feature off=byte-identical), Tauri(옵션 B)=ADR-0040, 서명/인스톨러는 후속
- **0040** 라이트 Windows 데스크톱 배포 옵션 B(접근 1): Tauri v2 셸이 bundle controller exe를 사이드카로 spawn→포트 로그 파싱→헬스 확인→네이티브 창 navigate, 창 닫힘 시 killpg[Unix]/Job Object[Windows] 트리 종료. `desktop/`는 자체 `[workspace]`로 루트 워크스페이스 밖·`crates/**`+`ui/src` 0-diff·`ControllerBackend` 추상으로 접근2(in-process)/LAN 전방호환 (**→ ADR-0042 접근 2로 대체**)
- **0041** LAN 분산 워커 L1: 세 번째 워커 모드 `pool` — 워커가 `--run-id` 없이 유휴 등록(reconnect-per-run)→`--worker-mode pool` 컨트롤러가 run 발사 시 유휴 워커에 샤드 push(기존 fan-out 재사용, N=min(유휴,부하상한)) + proto `Register.token` additive 공유 토큰 인증(미설정=byte-identical) + LAN 바인드. migration 0/엔진 무변경, push(컨트롤러 권위)·capacity 무시(L2)·mTLS 후속
- **0042** 라이트 Windows 데스크톱 배포 옵션 B 접근 2: Tauri in-process 컨트롤러(`run_in_process`/`RunningController` 임베드·desktop `InProcessBackend`·워커 멀티콜 `run_worker_if_invoked`·사이드카/externalBin 제거·R4b disconnect-cancel 크래시 teardown·R4d Windows Job 트리거-연기·비-bundle byte-identical). ADR-0040(접근 1) 대체
- **0043** UI 디자인 시스템: 시맨틱 accent 토큰(=indigo)+프리미티브 6종(Input·Select·Badge·Callout·Field·Section, `ui/src/components/ui/`)+Button accent — 점진 채택(RunDialog 첫 채택처·JSX-only byte-identical 재구성)·전면 리라이트/CSS-in-JS/3rd-party UI 라이브러리 기각
- **0044** 에디터 1차 표현 캔버스→아웃라인: React Flow 팬 캔버스를 세로 인터랙티브 아웃라인(`FlowOutline` HTML 트리)으로 교체 + 디테일 편집기 1fr + 변수 접기 + YAML 양방향 모달 + dnd-kit 그룹내 드래그 재정렬(`resolveDragEnd`→`moveStep`, 경계 넘기/re-parent=슬라이스3 완료) + `@xyflow/react` 제거. 양방향 sync(0003/0015) 모델 유지(아웃라인=같은 store 위 새 뷰)·모델/wire byte-identical(에디터 구조 재설계 1/3)
- **0045** 시나리오 삭제 정책: 2층 가드(활성 run hard 409[in-tx 권위]·참조 soft 409 카운트+force) + 앱-레벨 단일 tx 전체 cascade(FK CASCADE 마이그레이션·soft-delete 기각)
- **0046** open-loop rate 단위·사이징 교정: target_rps=반복(시나리오 실행)/초 공식화 + 포화 사이징 실측 점유시간(hold=M÷달성 도착률 자기측정) 기반 + cause 2-way(slots/sut, loadgen·recommended_workers 산출 제거)
- **0047** 에디터 test-run 데이터셋 바인딩: 컨트롤러 서버측 시드(자동매핑 실체화·R9 검증·R18 clamp) + single_row/sequential 2모드 + 엔진 행 루프(jar 공유·전역 예산), proto/store/migration 0-diff
- **0048** US 스파인(프로세스): 유저 스토리를 파이프라인 관통 오라클로 — brainstorming 승인→spec 고정 헤딩→리뷰어 value 3문항→task-brief 첨부→live US 척추→finish 한 줄, 새 단계·훅 0 (정본 `docs/dev/user-story-spine.md`)

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
- root **상태 줄은 한 줄로 *교체*(append 금지)** — "어디까지 됐나"만. 디테일은 build-log/ADR/메모리가 들고 있다. **`후속 다수(…)` 인라인 카탈로그도 append 대상이 아니다** — 짧은 스코프 나열 + `최신 =` 한 줄만 교체하고, 새 기능의 전체 설명·함정 출처는 build-log가 단일 소스다(2026-06-28: 이 카탈로그가 슬라이스마다 append-누적되어 22KB까지 비대 → line 7을 build-log 포인터로 압축. 새 슬라이스는 카탈로그에 기능명 한 마디만 더하거나 그대로 두고, `최신 =`만 갱신).
- **상태줄(line 7) 교체·`docs/roadmap.md` 불릿 삽입은 Python 스플라이스로** (run-list-filter-sort 2026-06-25): 둘 다 단일 초장문 라인이라 **Read 툴이 `limit`을 줘도 "exceeds max tokens"로 거부**하고 Edit 정확매치도 2KB+ old_string 재현이 깨지기 쉽다 → 작은 unique start/end 마커로 `s.index()` 찾아 splice하는 `.py`(`assert count==1`)로 교체/삽입. 상태줄 한 줄 자체는 `Read offset=7 limit=1`로는 읽힌다.
  - **splice 정합성은 bracket-balance가 아니라 imbalance-vs-HEAD로 검증** (XLSX Δ 2026-06-26): 상태줄·roadmap 불릿은 한국어 `[...]` 다용으로 **이미 불균형**일 수 있어 `count('[')==count(']')`는 무의미 — `git show HEAD:<파일>`의 해당 라인 imbalance와 *같은지* 비교(naive balance 검사는 false-positive). (line 7을 `·feature[detail]`로 append하던 close-앵커 `])까지 구현·머지 완료.` 규칙은 2026-06-28 카탈로그 압축으로 폐지 — 카탈로그는 더 이상 append 대상 아님, 위 규칙 참조.)
  - **splice 앵커의 구분자 char-identity 함정** (json-cast-extend 2026-06-29, line-7 splice 2회 substring-not-found): 상태줄은 `·`(U+00B7 MIDDLE DOT)·`—`(U+2014)·`→`(U+2192)를 쓰는데 ① `.py` heredoc에 *타이핑한* 리터럴이 다른 코드포인트(`•` U+2022 등)일 수 있고 ② **Read 툴 렌더가 raw 바이트와 다를 수 있다**(이번에 Read가 `상세·함정 출처`를 `상세`로 누락 렌더) → `s.index()`가 0매치로 터진다. 앵커는 `python repr`/`xxd`로 **실 바이트 확인** 후 구분자를 `·`/`—`/`→`로 **명시**(또는 파일에서 추출). `assert count==1`은 0매치를 못 거르니(예외로 떨어짐) 앵커 정확도가 선결.
  - **end_anchor가 old-span 꼬리 내용을 포함하면 `assert count==1`이 통과해도 결과가 깨진다** (scenario-clone-error-fixes 2026-07-09): 새 문장 뒤에 `new_sentence + " " + end_anchor`로 이어붙이는 패턴에서, `end_anchor`를 "구 문장의 마지막 조각 + 뒤따르는 boilerplate 포인터"로 잡으면(예: `"...실측). 완료 슬라이스..."`) 그 마지막 조각(`"...실측)."`)이 **새 문장에도 그대로 이식**된다 — replace 자체는 `count==1`로 성공하고 예외도 안 나서 겉보기엔 정상 완료다. old_span 재구성이 바이트 단위로 원본과 일치하는지가 아니라, **new_span에 old 전용 내용이 안 섞였는지**를 별도로 확인해야 한다: end_anchor는 순수 boilerplate(다음 문장·포인터)만으로 최소화해서 잡고, splice 직후 `Read offset=<line> limit=1`(또는 python으로 해당 줄 전체 print)로 **새 문장 전체를 육안 재독**하는 걸 완료 조건에 넣는다.
- 새 ADR는 인덱스에 **한 줄만**(위 규칙), 기능별 상세 작업 메모는 자동메모리 `MEMORY.md` 항목.
- 신호: root가 다시 ~50 KB를 넘으면 같은 기준으로 build-log/ADR/도메인 CLAUDE.md로 재분배.

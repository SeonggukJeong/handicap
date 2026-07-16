# Handicap

사내 QA·운영팀을 위한 부하 테스트 도구. REST API를 대상으로, **QA는 드래그-드롭으로 시나리오를 만들고**, **개발자는 같은 시나리오를 YAML/DSL로 편집** 한다 (두 뷰가 같은 모델의 양방향 sync). LoadRunner/JMeter를 사내에서 대체하는 것이 목표.

> **함정(gotcha) 노트는 도메인별 중첩 CLAUDE.md로 분할됨** — 각 디렉토리 파일을 그 디렉토리 작업 시 자동 로드한다. 이 루트 파일엔 전역 규칙·상태·크로스커팅 함정만 남긴다. 인덱스는 아래 [도메인별 함정 인덱스](#도메인별-함정-인덱스).

**상태: MVP 1단계(슬라이스 1–9) 완료 + post-MVP1 영역 A(프리셋·멀티워커 fan-out·Parallel·리포트 export/insights)·B(환경·SLO criteria·리포트 깊이)·C(에디터 test-run)·D(부하모델·페이싱: 타임아웃/think-time/open-loop/stages/VU 곡선) + Run 스케줄러 + 영역 U(UX, ADR-0035) + 후속 다수(LAN 분산 워커 L1–L7·풀 운영 견고성/제어상태 영속화·Tauri 데스크톱[in-process, ADR-0042]·단일 self-contained exe[ADR-0039]·HAR→시나리오 가져오기·다중 데이터셋 바인딩·운영 상한 관리자·스텝 템플릿 관리·ko.common 한국어화·게이트-에러 한국어 매핑·디자인 시스템[ADR-0043]·RunDialog 간단/상세+목업 시각 충실도 재구성·비교 뷰 깊이/XLSX Δ 조건부 서식·트랜잭션 시간 분해·Run 라이브니스 G1/G3+stall 배지·closed-loop 곡선 fan-out 샤딩·결과화면/스텝 막대 폴리시·에디터 캔버스→아웃라인 재설계·에디터 레이아웃 후속 버그 수정·에디터 드래그 메커니즘 수리·에디터 YAML 모달 가져오기/내보내기·JSON 바디 캐스트 확장·에디터 테스트 흐름 칩 스트립·에디터 경계 드래그/re-parent·시나리오 삭제/이름 라이브 편집·에디터 공간·이름 QoL·Button-accent 색 이주·에디터 변수 도구 A·에디터 뷰포트 높이 floor·에디터 뷰포트 폴리시 v2·저장 안 됨 이탈 가드·HAR 쿼리 안전 디코딩·open-loop 슬롯 사이징 교정·open-loop 단위 표면화·시나리오 기본 think time·open-loop think 검증/무시 토글(§B21)·graceful ramp-down 상한(§B9)·에디터 test-run 데이터셋 바인딩 등 — **전수 목록·구현 결과·함정 출처는 `docs/build-log.md`가 단일 소스**)까지 구현·머지 완료. 최신 = editor-dataset-testrun(§A12 도그푸딩 4호 — 에디터 test-run 데이터셋 바인딩, ADR-0047[서버측 바인딩·single_row/sequential]·store/proto/worker/migration 0-diff·머지 1ea9e81, 2026-07-16): ① `POST /api/test-runs` optional `dataset` — single_row(특정 1행 단발, 응답=기존 ScenarioTrace R7)·sequential(1 VU 순차 N행 행별 ✓/✗, 응답=RowsTrace R8) — 실제 run과 같은 주입 세만틱 ② 엔진 `trace_once` 코어 추출+`trace_scenario_with_seed`(기존 trace_scenario=빈-시드 위임 R1)+`trace_scenario_rows`(jar 1회 공유·전역 예산·실패 행 계속) ③ 컨트롤러 자동매핑 실체화(R3)·R9 검증 11케이스(422 한국어)·R18 clamp(min(row_limit??잔여,잔여,max_requests)+truncated/ok OR)·R17 행 로드(첫 바인딩 no-wrap 앵커·비-첫 %wrap) ④ UI 접이식 데이터셋 섹션(useDatasets 지연 마운트·R11 None 정규화·R15 예산 힌트)+DatasetRowsPreview 행 선택 prop(R12)+SequentialRunPanel(R13)+칩 미러(R14). SDD 7 task(Sonnet 구현·리뷰 7/7 클린 — T1–4·7 Opus path-gate)+최종 S1 fix(행 번호<1 가드)·handicap-reviewer(Opus) APPROVED-WITH-NITS→S1 RESOLVED·security-reviewer APPROVE(grep 3매치 — SSRF/시크릿/템플릿/자원 clean)·라이브 ALL PASS(18체크 — US1–US4 로깅 echo 와이어 실증·실제 run 대조·Playwright 칩 미러 flip·콘솔 0). 잔여 nit·spec §7 연기 → roadmap §B23. 완료 슬라이스/기능 상세·함정 출처 → `docs/build-log.md`, 다음 작업(테마별 frontier+추천) → `docs/roadmap-status.md`(현황판·shortlist 대체), 후보 메뉴·연기 항목 상세 → `docs/roadmap.md`, ADR 인덱스 → 아래 [알아둘 결정들](#알아둘-결정들), 결정 전문 → `docs/adr/`. 디자인 → `docs/superpowers/specs/`, 구현 계획 → `docs/superpowers/plans/`. MVP 1단계 spec=`2026-05-27-handicap-mvp1-design.md`(슬라이스 1–6), 후속은 그 §4.5 메뉴에서 각자 새 spec/plan으로.**

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

**git 토폴로지:** 통합 브랜치 `master`(`main` 없음 — 세션 컨텍스트의 "Main branch: main"은 부정확), remote `origin`=`github.com/SeonggukJeong/handicap`(gh CLI=SeonggukJeong; 구 limvik 계정명 변경, **2026-07-11부터 PUBLIC** — 홍보용 README/LICENSE(MIT)/`docs/images/` 스크린샷 있음, push 전 민감정보 주의). 단 슬라이스/브랜치 마무리는 **여전히 로컬 ff-merge(PR 아님)** + origin에 master를 주기적으로 push. **릴리즈 = `v*` 태그 push → `release.yml`(windows-latest `tauri-action`)이 NSIS/MSI 인스톨러 빌드+GitHub Release 자동 게시**(현재 최신 v0.3.0; 버전 bump→커밋→태그 절차 → `docs/dev/tauri-desktop-build.md` §CI 릴리즈). 워크트리 *안에서*: `git -C /Users/sgj/develop/handicap merge --ff-only worktree-<X>`(사전 `merge-base --is-ancestor master worktree-<X>` + 메인 `status --porcelain -uno` clean 확인) → 머지 확인 후 `ExitWorktree(remove, discard_changes:true)`. **`EnterWorktree(name: X)` → 브랜치명 `worktree-X`·디렉토리 `X`(비대칭)** 이라 ff 스텝은 반드시 `worktree-X`.

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
- **여러 워크트리에서 `pnpm dev`(5173)·`cargo run --bin controller`(8080) 포트 선점**: 다른 워크트리/master에서 띄운 프로세스가 살아있으면 stale 번들을 서빙하거나 잘못된 DB에 붙는다. 증상: 컨트롤러는 새 빌드(curl 200)인데 UI에서 새 기능이 동작 안 함. `lsof -i :5173`/`:8080` → `ps -o cwd= -p <PID>`로 워크트리 확인 → stray 죽이고 현재 워크트리에서 재시작 + 브라우저 hard reload. (kind port-forward 8080/9001 충돌·재기동은 `deploy/CLAUDE.md`.)
- **워크트리에서 백엔드 라이브 검증은 그 워크트리의 *자체* 바이너리로**(Run 스케줄러 34c): 워크트리는 메인과 분리된 `target/`(`.claude/worktrees/<name>/target/debug/`)을 갖는다. 메인 체크아웃의 절대경로(`…/handicap/target/debug/controller`)로 돌리면 **다른 브랜치의 stale 바이너리**(새 CLI 플래그·엔진 변경 없음 → `unexpected argument` 등으로 깨짐)가 실행된다. `find -maxdepth 5`는 깊이 6의 워크트리 target을 놓쳐 위치 오판을 부른다. → 워크트리 root에서 `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller` 후 **상대경로 `./target/debug/controller --db /tmp/x.db --ui-dir ui/dist …`**로 실행(controller가 spawn하는 `target/debug/worker`도 cwd-상대라 같은 fresh 바이너리). **백엔드-only 슬라이스(UI 0-diff·`ui/dist` 미빌드)는 `--ui-dir`를 통째로 생략**(SPA 불필요) — controller는 `--ui-dir <없는 경로>`면 시작 시 `Error: --ui-dir "..." does not exist`로 **fail-fast**라, live-verify 레시피의 `--ui-dir ui/dist`를 그대로 쓰면 dist 없는 워크트리에서 컨트롤러가 안 뜬다(B9 closed-curve fan-out 라이브 검증).
- **게이트 출력을 고정 `/tmp/x.log`로 리다이렉트하면 *이전 세션·다른 워크트리*의 stale 로그를 읽어 거짓 'FAIL'** (사이징 헬퍼): Bash 툴 cwd는 호출 간 유지돼 `cd ui && … > /tmp/lint.log`가 (이미 ui 안이면) `cd` 실패→`&&` 단락→직전 `tail /tmp/lint.log`가 *다른 워크트리 경로*의 옛 출력을 보여준다. 로그 헤더에 다른 브랜치/워크트리명이 보이면 stale(=실패 아님). 절대경로 `cd /Users/.../<worktree>/ui` + 워크트리-스코프 로그명(`/tmp/<slug>-lint.log`)으로 회피.
- **`just run-controller-with-ui`는 `ui/dist`가 *없을 때만* UI를 빌드한다**(`if [ ! -f ui/dist/index.html ]`) — UI 변경/머지 후 dist가 stale이어도 재빌드 안 하고 옛 번들을 단일-포트(8080)로 서빙한다(위 포트 선점과 다른 별개 함정). 새 UI 기능이 안 보이면 `just ui-build` 수동 실행(+브라우저 hard reload). vite dev 5173은 HMR이라 무관.
- **로컬에서 curl로 직접 구동 (수동 검증/더미 데이터 생성)**: 시나리오 생성 `POST /api/scenarios {"yaml":…}`(name은 YAML에서 파싱 — `jq -Rs '{yaml:.}' f.yaml | curl -sX POST …/api/scenarios -d @-`로 이스케이프 회피). run 목록은 `GET /api/scenarios/{id}/runs` (**`GET /api/runs` 목록 엔드포인트 없음** — `POST /api/runs` + `GET /api/runs/{id}`만). run 생성 `POST /api/runs {"scenario_id":…,"profile":{"vus":N,"duration_seconds":S},"env":{}}`(`ramp_up_seconds`·`loop_breakdown_cap`는 default). **`vus`도 serde default(0)라 open-loop(`target_rps`/`max_in_flight`)·VU 곡선(`vu_stages`) 페이로드는 vus 생략 가능 — closed-loop만 `validate_run_config`가 `vus>0` 강제(open-loop은 vus 값 무시: 부하=target_rps+max_in_flight). `duration_seconds`만 항상 필수.** report summary 키 = `count/errors/rps/p50_ms/p95_ms/p99_ms`(`total_requests`/`error_count` 아님). 시나리오 YAML엔 **`version: 1` + 각 step `id`(유효 ULID — I/L/O/U 제외)·`type`·`name` 필수**(http step은 셋 다 required — `HttpStep.name: String`; 없으면 `422 missing field version`/`missing field name` 또는 ULID 파싱 거부). 에디터 test-run 단발(trace/본문 뷰어 검증용)은 별도 ephemeral 엔드포인트: `POST /api/test-runs {"scenario_yaml":…,"env":{},"max_requests":N}` → `ScenarioTrace`(미저장; `steps[].response.{body,body_truncated}` 확인). **함정: zsh `echo "$json" | python3`는 serde_json이 이스케이프한 `\n`(2글자)을 실제 개행으로 풀어 JSON 파싱을 깨뜨린다(`Invalid control character`)** — curl을 python에 **직결**(`curl … | python3 -c …`)하거나 `printf '%s' "$json"` 사용. `GET /api/scenarios`는 `{"scenarios":[…]}` 래퍼(bare 배열 아님), 단일 scenario/run 응답은 객체. **생성 응답(`POST /api/scenarios`·`/api/runs`)은 멀티라인 `scenario_yaml`을 임베드 → 셸 변수에 담아 `jq -r '.id'`/`python json.load`하면 raw 개행으로 깨진다**(phase-breakdown): 생성 응답을 파싱하지 말고 `GET /api/scenarios/{id}/runs`(목록)에서 id를 재조회하거나 curl→python 직결. **비자명한 추출(f-string·다중키)은 인라인 `-c` 말고 파서를 `.py` 파일에 쓰고 `curl … | python3 /tmp/parse.py`** — zsh에서 `python3 -c '…'`는 f-string 속 `\"`가 깨지고, `curl | python3 <<'EOF'`는 heredoc이 pipe stdin을 덮어써 `json.load(sys.stdin)`가 curl이 아닌 스크립트를 읽는다(live-verify 세션 재확인).
- **요청 *내용*(실제 전송된 헤더/폼 필드)을 검증하려면 로깅 echo 타깃이 필요**: 리포트는 집계-only이고 시나리오 assertion은 `status`뿐이라 "무엇이 실제로 나갔나"(예: B4 disabled 행 미전송)를 리포트로는 못 본다 → 시나리오 url을 헤더/바디를 파일로 찍는 echo 서버로 돌리고 와이어를 grep. python `ThreadingHTTPServer` echo가 localhost ~10k rps 감당. **함정: live-verify 스킬 번들 `responder.py`는 `log_message`가 no-op이라 요청을 안 찍는다** — 와이어에 주입된 변수(`{{track}}` 등)를 grep하려면 `print(f"REQ {self.command} {self.path}")` 찍는 로깅 변형을 따로 써라(다중 데이터셋 바인딩). run-detail UI 라우트는 `/runs/{id}` — `/scenarios/{sid}/runs/{rid}`로 가면 404(`routes.tsx`).
- **부하 페이싱/타임아웃 기능(think time·timeout·향후 open-loop/stages)은 RPS로 수동 검증** (S-B 수동테스트): python `ThreadingHTTPServer` 200-responder + controller subprocess 워커 + 격리 DB(`./target/debug/controller --db /tmp/x.db --ui-dir ui/dist`, 먼저 `cargo build -p handicap-worker --bin worker`)로 띄우고 run 리포트 `summary.rps`를 관찰. **closed-loop think time RPS ≈ `VUs / think_ms`**(예: 2 VU·200ms→~10 RPS, per-step도 동일식; 베이스라인 대비 수백배 하락이라 신호 명확). test-run 페이싱은 `POST /api/test-runs`를 curl `-w '%{time_total}'`(wall)로 `apply_think_time` on/off 비교. UI 라운드트립(Playwright) 검증 디테일 — `browser_take_screenshot`/`browser_snapshot` 저장경로·`.playwright-mcp` 머지 전 정리·**Playwright MCP cwd 고정**(과거 워크트리)·인라인 `browser_evaluate`·React controlled input native setter·`el.click()` React 18 batching·`browser_console_messages({all:true})` cross-session 버퍼·CONNECTION_REFUSED≠Zod에러 → **docs/dev/live-verify-playwright.md**(／live-verify 시 로드).
- **UI run 생성/응답-파싱 경로는 RTL·`tsc -b`로 안 잡힌다 — 슬라이스 머지 전 라이브 run 1회 필수** (S-D Playwright 발견): RTL fixture는 서버가 실제 보내는 `null`이 아니라 *absent*를 줘서 Zod `.optional()`↔서버-`null` 미스매치를 통과시킨다(`tsc`도 못 봄). 머지 전 controller+worker 띄우고 RunDialog로 run 1개 생성→리포트까지 확인(또는 curl `POST /api/runs` 후 응답 JSON에 `null` 필드가 `ProfileSchema`를 통과하는지). S-D에서 이 누락(`ProfileSchema` `.optional()`이 서버 `null` 거부)이 **모든 run UI 생성을 깨뜨린 채** 전 슬라이스 잠복했었다 — 상세 `ui/CLAUDE.md` `.nullish()` 함정.

## Subagent dispatch 노하우

- **SDD `scripts/task-brief PLAN N`은 숫자 `Task N` 헤딩만 매칭 — "Task A/B" 라벨 plan은 exit 3** (곡선 fan-out 워커 표시): awk 정규식이 `Task[ \t]+[0-9]+`라 letter-label plan에서 "task N not found"로 실패. 수동 추출 `awk '/^## Task A:/{f=1}/^## Task B:/{f=0}f' PLAN > brief.md`(또는 plan을 숫자 `Task N`으로 작성). `review-package`·`sdd-workspace`는 라벨 비의존이라 무관.
- **`task-brief`는 그 task *섹션만* 자른다 — plan이 task-밖 공유 정본(카피 개명 표·keep-list 등)을 두면 implementer/리뷰어가 못 본다** (open-loop-rate-labels T2–T4): 공유 섹션을 `awk '/^## 카피 개명 표/,/^---$/'`류로 별도 파일(`.superpowers/sdd/copy-table.md`)로 추출해 brief와 함께 디스패치 prompt에 두 경로로 넘길 것("이 표의 문자열을 byte-exact로" 명시). T2·T3·T4가 같은 표를 참조해도 추출은 1회면 된다.
- **`ui/src`를 한 줄이라도 건드리는 task는 plan/brief에 UI 테스트 스텝을 넣을 것** (open-loop-slot-sizing T1): Rust-TDD 위주 task에 UI Zod 2줄이 섞여도 tdd-guard가 UI-side pending test 부재로 `ui/src` 편집을 차단 — implementer가 즉석 테스트를 추가해 통과했지만(brief 밖 파일 커밋 유발), plan이 UI 테스트 스텝을 명시하면 재발 0.
- **plan 인라인 Rust 코드에 2-arm `match … _ => {}` 금지 — `if let`으로 쓸 것** (open-loop-slot-sizing T2): verbatim 전사가 `clippy::single_match`(-D warnings)에 걸려 implementer가 등가 재작성을 해야 했다. plan 코드블록도 clippy-clean하게.
- **워크트리에서 subagent를 띄울 땐 prompt 첫 줄에 `cd /Users/sgj/develop/handicap/.claude/worktrees/<name>` 명시**: 안 하면 spec-reviewer 같은 lightweight 모델이 메인 체크아웃을 읽고 "코드가 없다"고 잘못 보고한다. 절대 경로로 박는 게 가장 안전.
- **각 task마다 두 단계 review (spec compliance → code quality)**: spec reviewer는 plan 대비 빠짐/추가를 보고, code quality reviewer는 idiom/race/test 품질을 본다. 두 reviewer가 모두 APPROVED여야 다음 task로. **모델 라우팅 — 기본 Sonnet, Opus는 조준 승격**(Opus 주간 캡 절약 + correctness 네트 유지): ① **path-gated** — diff가 `engine/`·동시성·`unsafe`·proto/와이어포맷·template/cast·env/dataset 바인딩·migration(`.sql`)·대형 diff를 건드리면 그 task의 **code-quality 리뷰를 Agent 툴 `model: opus`로** 띄운다(finish-slice §0 security-reviewer 게이트와 동일한 결정적 path-gate). ② **self-flag 재패스** — Sonnet 리뷰어 프롬프트에 "미묘하거나 확신 없으면 `escalate: true` 반환" 지시를 주고, 올라오면 **그 리뷰만 Opus로 한 번 더**(2차 패스라 Sonnet+Opus 둘 다 지불 → 트리거 보수적으로; 승격률이 ~40%를 넘으면 always-Opus보다 비싸짐). **실행 중 Sonnet은 자기 자신을 Opus로 못 올린다** — 승격은 항상 *디스패처가 모델을 고르거나*(①) *재패스*(②)로. spec-compliance 리뷰는 plan을 오라클로 한 구조적 대조라 Sonnet 유지. (정의된 `handicap-reviewer`/`security-reviewer`/`spec-plan-reviewer`는 슬라이스당 1회 저볼륨이라 `model: inherit`=Opus 유지 — 끌어내리지 말 것. `CLAUDE_CODE_SUBAGENT_MODEL` 환경변수는 frontmatter·per-invocation override를 전부 덮으니 설정 금지.)
- **subagent-driven 실행 중 리뷰는 read-only 로만**: reviewer 가 옛 버전을 보려고 `git checkout <sha>` 를 쓰면 HEAD 가 detach 되어 브랜치 ref 가 안 따라온다. 리뷰는 `git diff`/`git show <sha>` 같은 read-only 명령만 — `checkout`/`switch`/`stash` 는 worktree 의 attached HEAD 를 깨므로 금지.
- **다른 슬라이스로 미룬 항목을 코드 주석으로만 남기면 다음 슬라이스 plan이 놓친다** (Slice 8c): 8b가 `api/datasets.rs`에 `// 참조 가드는 8c`로 미룬 DELETE 409 가드를 8c plan이 안 주워, 최종 whole-feature 리뷰에서야 발견(Task 13으로 추가). 후속 슬라이스 scoping 때 `grep -rn "<해당 슬라이스>" crates/ docs/`로 deferral 주석을 한 번 훑을 것.
- **subagent 리포트 파일 경로를 `.git/worktrees/<wt>/sdd/`로 명시 + "리포트 `.md`를 worktree 루트에 쓰지 말 것·`git add` 금지" 못박기** (ko-common 롤업 T4): 안 하면 implementer가 `task-N-report.md`를 worktree 루트(tracked)에 써서 커밋돼 `ui/`-only diff 불변식을 깬다(루트 `task-4-report.md`가 `git add ui/src`에도 안 걸렸는데 커밋됨 → sdd로 보존 후 `git rm`+`commit --amend`로 복구). 후속 dispatch에 경로/금지 2줄 추가하니 재발 0. **(superpowers 6.0.3+ 정리)** 이제 `scripts/sdd-workspace`가 워킹트리에 `.superpowers/sdd/`(self-ignoring `.gitignore`)를 만들고 `task-brief`/`review-package`가 그 경로를 print — 루트 커밋 위험이 구조적으로 해소(`.git/` 아래는 하니스가 쓰기 거부). implementer 프롬프트엔 그 `.superpowers/sdd/…` 경로 + 명시 `git add`만 넘기면 된다.
- **완성도(전수 grep) 게이트는 orchestrator가 *직접 재실행*** (ko-common 롤업 T6): implementer가 "R1 grep clean/잔존 0"이라 보고해도 독립 재실행에서 잔존 6개 적발(verdict 배지 raw `PASS`/`FAIL`·삼항 속성 `title={c?"pass":"fail"}`·`max ms` 헤더 등). "subagent report 불신, 직접 실행한 테스트/빌드만 신뢰"의 grep-completeness 확장 — self-report한 grep 결과는 신뢰 천장이 낮다(grep 패턴/제외를 implementer가 자기에게 유리하게 적용). 완성도가 슬라이스 acceptance면 orchestrator가 같은 grep을 손수 돌려 잔존을 눈으로 판정. **zsh에선 grep 대상군을 변수 하나(`$T`)로 넘기면 word-split이 안 돼**(전체가 파일명 1개로 취급) no-such-file 경고와 함께 `|| echo 0건` 폴백이 거짓 clean을 찍는다(design-system-deep 게이트 B) — 대상군은 `set --`/명시 나열로. **plan의 스코프 게이트(R9류)가 `git diff master..HEAD`(two-dot)면 master가 세션 중 전진했을 때 master측 파일까지 나와 오판**(design-system-variants: dataset-preview 3커밋이 crates/·api/ 파일을 게이트에 흘림) — 스코프 판정은 `git diff $(git merge-base master HEAD)..HEAD`(또는 three-dot `master...HEAD`)로, 이후 rebase→전체 게이트 재실행→ff-merge.
- **리뷰-수정 루프: 읽기전용 리뷰는 같은 subagent를 `SendMessage`로 resume, 코드-fix는 fresh subagent로** (Slice 9b, rundialog-ux-fixes 2026-06-28 정정): **`SendMessage(to: <agentId>)`로 완료된 background subagent를 컨텍스트 보존한 채 resume할 수 있다**(과거 "resume 없다" 노트 폐기). → `spec-plan-reviewer`/`handicap-reviewer` 같은 **read-only 리뷰 루프는 같은 agent를 resume**하면 코드베이스+자기 직전 findings를 들고 있어 재리뷰가 싸고 "내 finding이 반영됐나"를 직접 검증한다(rundialog-ux-fixes가 spec 3R+plan 3R을 단일 reviewer resume로 수렴; 1M 부모면 첫 dispatch에 명시 `model: opus`를 줘야 resume도 standard-context로 핀). 단 **코드를 *바꾸는* fix는 여전히 새 focused subagent로**(finding+`file:line`+정확한 fix 담아 — 같은 fixer resume는 자기 변경 자가검증 편향). fix 후 그 diff만 focused 재리뷰.
- **리뷰-수정 루프는 clean APPROVE가 목표지만 *유한 valve*가 있다 — "무한 APPROVE까지"가 footgun** (보안 게이트 세션): subagent-driven 스킬의 "repeat until approved"를 무한정 두면 reviewer가 nit을 끝없이 생성할 때 안 끝난다. 목표(APPROVE)는 낮추지 말되: ① 각 finding은 `receiving-code-review`로 타당성부터 판정 — 틀림·과설계·범위밖은 근거 1줄로 **기각**(맹종이 루프를 늘린다), 타당한 건 fix하며 수렴. ② **valve: 루프가 5회를 초과하면 자동 진행/포기 말고 사용자에게 질문**(남은 finding 요약 + "더 돌릴지"). (spec-plan-reviewer 루프도 start-slice §4가 상한+escalate로 유한 — 같은 정신.) `finish-slice §0` 보안 게이트가 적용 사례.
- **code-quality 리뷰어의 "APPROVED, but Important·나중에 fold 가능"이 spec invariant 위반이면 미루지 말 것** (Slice 9b): 9b 조건 빌더 ×버튼이 빈 그룹(engine `All([])` vacuous-true, spec §3.2 "UI는 빈 그룹 금지" 위반)을 만들 수 있던 걸 리뷰어가 "later polish"로 표시했지만, spec 보장 위반이라 그 슬라이스 안에서 fix(위 deferral 함정과 같은 맥락 — 미룬 건 사라진다).
- **최종 whole-feature 리뷰는 `handicap-reviewer` 에이전트로** (Slice 9b): repo-trap-aware라 per-task 리뷰가 구조상 못 보는 크로스커팅을 잡는다 — 특히 UI Zod 모델 ↔ 엔진 serde **와이어포맷 1:1 대조**(field명·연산자·`right` 생략 등), deferral 추적, build/lint 게이트 재확인.
- **단일-task plan은 per-task 리뷰와 최종 whole-branch 리뷰가 *동일 diff* → `handicap-reviewer` 1회로 둘 다 충족** (게이트-에러 한국어 매핑): generic task-reviewer를 같은 diff에 또 돌리는 중복을 생략(리뷰 *병합*이지 *생략* 아님 — handicap-reviewer가 spec-compliance+quality+repo-trap+wire 1:1을 한 번에). 리뷰 패키지 BASE는 implementer 디스패치 *직전* 커밋(= spec/plan docs 커밋 위)으로 잡아 코드 diff만 스코프(`HEAD~1` 금지 — 멀티커밋 절단).
- **새 `EnterWorktree` 워크트리엔 `ui/node_modules`·`target/`가 없다** (A1): 테스트 돌리는 subagent를 띄우기 전에 `cd ui && pnpm install`(pnpm 전역 store라 ~수초) + `cargo build`로 baseline부터 깐다 — 안 그러면 첫 subagent가 deps 없어 바로 실패. UI·Rust 둘 다 건드리는 슬라이스면 둘 다.
- **implementer subagent가 mid-task로 끊길 수 있다** (A1, 한 세션에 2회; Slice 9c·think-time-defaults[2026-07-13, **원인=API 세션 한도**]에서도 재현): report 없이 truncated되면 변경이 uncommitted로 worktree에 남고 build gate·commit이 안 된 상태다. **report를 믿지 말고**(테스트 개수·baseline 같은 수치도 부정확할 수 있음) `git status`/`git diff HEAD`/grep로 실제 상태를 확인한 뒤, 남은 step(테스트 → `cd ui && pnpm test && pnpm build` → commit)을 직접 마저 하거나 fix-subagent로 완료한다. 매 task의 실제 상태는 subagent report가 아니라 직접 실행한 테스트/빌드로 검증.
- **하니스가 subagent tool result·Edit 직후 띄우는 `<new-diagnostics>`(rustc/rust-analyzer)는 STALE일 수 있다** (A2-2, 한 세션 2회): implementer가 이미 고친 call site를 옛 상태로 표시(중간-edit 스냅샷)하거나, **proto 변경 시 stale codegen 캐시**(여러 `target/debug/build/<crate>-*/out/*.rs` 중 RA가 옛 디렉토리를 가리켜 `no such field`). flagged 에러를 진짜로 취급하기 전 독립 `cargo build --workspace` + `cargo test -p <crate> --no-run`(테스트 call site까지 컴파일)로 실제 상태 확인 — T3·T6 둘 다 stale 진단이 green 커밋과 모순이었다. 진단도 보고도 불신, 빌드/테스트만 신뢰.
- **implementer subagent의 commit은 단일 FOREGROUND blocking 호출로 시키고 background+poll 금지** (A4b, 한 세션 3회 truncate): implementer가 `git commit`을 `run_in_background`로 띄우고 완료를 폴링하는 루프가 subagent 턴을 mid-poll에 truncate시킨다(commit 미완 + 변경 uncommitted 잔류 → 위 항목 복구 필요). 프롬프트에 "commit은 `run_in_background:false` + timeout 600000ms 단일 호출, 폴링 금지"로 못박으면 사라진다(T6부터 깨끗). 반대로 **orchestrator 자신의** 커밋은 background가 맞다(완료 notification 받고 그동안 read-only 준비 가능) — 단 두 커밋 동시 진행은 `target/`·`index.lock` 경합이라 항상 직렬.
- **subagent-driven plan을 컨텍스트 리셋/토큰 소진 후 재개하려면 git 커밋이 진실의 원천** (unique 바인딩): 각 task가 독립 커밋(implementer가 task 끝에 commit)이라 진행 상태는 워크트리 git 히스토리에 durable. 재개 레시피: ① 워크트리는 `.claude/worktrees/<name>`에 보존(`ExitWorktree(remove)` 전엔 안 지워짐) → `EnterWorktree(path: …)`로 재진입; ② `git log --oneline <base>..HEAD`로 완료 task 확인 후 plan의 `- [ ]` 체크박스와 대조해 **첫 미커밋 task부터** 재개; ③ `git status`/`git diff HEAD`로 중단 task의 uncommitted 부분작업 복구. TodoWrite/Task 리스트는 컨텍스트와 함께 리셋되니 신뢰 금지 — 커밋·직접 실행한 테스트/빌드만 신뢰.
- **무거운/불안정한 env-setup·외부-바이너리 가정은 orchestrator가 선점(background pre-warm)** (Tauri 셸): toolchain install·스캐폴드·heavy 빌드를 implementer 디스패치 *전에* 직접 끝내면 mid-task truncation(A1/A4b) 위험↓ + 메인 `target/` heavy 빌드를 디스패치 전에 직렬화해 implementer(별도 target만 건드림)와의 lock 경합 회피. **외부 바이너리의 *행동*(로그 포맷·env·빌드 시스템 quirk)을 소비하는 슬라이스는 spec-plan-reviewer가 못 잡는다 — 실 바이너리를 직접 돌려 가정을 실측한 뒤 그 값을 implementer에 넘긴다**(플랜의 ANSI-없는 로그 fixture·`[workspace]` 누락·`externalBin` build-time 요구 3건이 spec/plan APPROVE를 통과하고 *실행*에서만 드러났다).
- **subagent 디스패치가 0-작업 '가짜 completed'로 죽을 수 있다 — `task-notification`의 status=completed를 결과로 신뢰 금지** (noncurve fan-out 표시 2026-06-25): 부모 세션이 Opus 4.8 **1M-context**로 도는데 subagent를 띄우면 `API Error: Usage credits required for 1M context`로 즉사하면서도 notification은 `<status>completed</status>`로 와 *마치 통과한 것처럼* 보인다(`<result>`에 에러 문자열·`subagent_tokens=0`·`tool_uses=0`·`duration_ms<1000`이 tell). live-verify 같은 게이트 subagent가 이렇게 죽으면 검증을 안 돌리고 PASS로 오인할 위험 → **notification의 `tool_uses`/`tokens`/`duration`을 보고 실제 실행 여부 확인**, 0이면 **메인 세션에서 직접 수행으로 폴백**(live-verify는 절차적 curl+Playwright라 메인에서 그대로 가능). 재시도해도 같은 1M 벽이면 `/model`로 standard-context 전환 후 재디스패치도 옵션. **(정정 — tauri-in-process 2026-06-26)**: 이 즉사는 subagent가 부모의 1M 모델을 *상속*(dispatch에 `model:` 생략)할 때만 난다 — Agent 툴에 **명시 `model: sonnet`/`model: opus`를 주면 standard-context 티어로 핀돼 죽지 않는다**(subagent-driven-development는 어차피 명시 model을 요구). 이번 세션은 1M-context 부모에서 implementer(Sonnet)·code-quality 리뷰어(Opus)·최종 리뷰·live-verify 등 ~12 subagent를 전부 명시 model로 띄워 **0 즉사** → 1M 세션에서도 subagent-driven 그대로 가능(메인-세션 폴백은 model 생략 시의 차선책). **정의된 `handicap-reviewer`/`security-reviewer`도 1M 세션에선 `model: inherit`(=부모 1M 상속·즉사) 대신 명시 `model: opus`로 디스패치**(Opus 유지 + 1M 벽 회피 — "끌어내리지 말 것"과 양립).

## 슬라이스 파이프라인 (순서·게이트·재개 — 단계 생략 금지)

worktree 슬라이스의 고정 순서. **어느 단계도 "작아서/dogfood라서" 생략 금지** (2026-06-15 사고: `spec-plan-reviewer` 루프를 임의 건너뛰고 구현 직행 → reviewer가 뒤늦게 CRITICAL 1000× 단위 버그 적발. coverage≠correctness라 템플릿·체크리스트가 리뷰를 *대체 못 함*; 그래서 `spec-review-guard`가 reviewer 통과를 기계적으로 강제). 시작·마무리는 `/start-slice`·`/finish-slice` 스킬이 체크리스트, 아래가 전체 골격:

1. **시작** `/start-slice` — worktree(`worktree-<X>`) + 작업 선택 + baseline(`pnpm install`·`cargo build`).
2. **설계** spec → `spec-plan-reviewer` **clean `APPROVE`까지 반복**(`APPROVE-WITH-FIXES`/`NEEDS-REWORK`=미통과; finding은 `receiving-code-review`로 비판 평가 후 반영/기각). 이어 plan도 같은 루프. **clean APPROVE 후에만** plan에 `REVIEW-GATE: APPROVED` 마커 → 없으면 `spec-review-guard`가 `crates/*/src`·`ui/src` 편집 deny(미통과 상태 마킹 = 위조). **STOP-gate**: 이 세션에서 spec/plan을 새로 썼으면 커밋 후 `/clear`→fresh 컨텍스트로 3단계 진입. **사용자가 '바로 구현'을 요청해도 같은 세션 구현을 *권장/옵션으로 먼저 제시하지 말 것* — `/clear`→fresh가 기본 권장, 명시 고집 시에만 따른다**(2026-06-20 L2: 플랜 승인 후 '같은 세션 계속(추천)' 제시→채택→구현+라이브검증+finish로 컨텍스트 62% 소모, 사용자 교정. plan이 진실의 원천이라 fresh 구현이 품질·컨텍스트 양면 유리). [[stop-gate-fresh-context-impl]]
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

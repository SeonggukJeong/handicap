# Rust 툴체인 정확 버전 고정 + 릴리즈 CI-녹색 게이트 — 설계

- 날짜: 2026-10-18 · 유형: **platform** · 워크트리: `toolchain-pin` (브랜치 `worktree-toolchain-pin`)
- **상태: 완료** (2026-10-18, 코드 `b17c6bd1`..`11e1eb72` — 최종 리뷰 M1 fix[게이트가 `pull_request` run 무시] 포함; CI 실측 완료 — ci run 39125132007 `rustc 1.99.1`·정합 ok 6줄; release·Docker 경로는 다음 태그에서) · 판단·연기 → `docs/roadmap.md` §B33
- 선행: release-hygiene(`6c80592` — preflight→build×2→publish 4잡, 판정 로직을 레포 스크립트로 빼 로컬 양방향 실행 검증하는 패턴) · genvar-per-request CI 복구(`29b34d80`)
- 출처: `docs/roadmap.md` §B32 R-e (방향 합의 2026-10-18). 새 ADR 없음 — 빌드 인프라 설정이며 결정 근거는 이 spec과 §B32 R-e가 든다.
- **합의 대비 편차 2건**(이 spec에서 결정): ① 고정 버전은 합의 문구의 `1.99.0`이 아니라 **`1.99.1`**(§1 근거) ② CI-녹색 게이트 위치는 합의 문구의 `preflight`가 아니라 **`publish` 잡**(사용자 선택 2026-10-18 — preflight 시점엔 같은 push로 시작된 ci가 아직 도는 중이라 대기가 필요하고, publish는 ~18분 빌드 뒤라 보통 이미 끝나 있다).

## 사용자 스토리 (US)

- **US1** (재현 / 기대 / 실측):
  - **재현:** 코드가 그대로인 커밋에서 GitHub CI `rust` 잡이 빨개진다(1.99 신규 clippy lint 3종 — `result_large_err`·`result_unit_err`·`double_must_use`). 로컬 pre-commit은 1.97로 green이었다.
  - **기대:** 로컬 게이트를 통과한 커밋은 CI clippy도 통과한다.
  - **실측:** `e4bc1729`과 `854a22de`가 2회 연속 실패했다(`gh run list --workflow ci --branch master --limit 5`).
- **US2:** 개발자-도구가 Rust 버전을 올릴 때 한 명령으로 6곳을 갱신한다. 성공하면 정합 검사가 `ok` 6줄을 출력하고, 한 곳이라도 손으로 어긋나게 고치면 CI 첫 스텝이 `MISMATCH` 줄과 함께 실패하는 것을 본다.
- **US3:** 도입담당이 받는 릴리즈는 녹색 CI 위에서만 나간다. 성공하면 태그 커밋의 ci가 빨강이거나 없을 때 publish 잡이 사유·해소법과 함께 실패하고 GitHub Release가 생성되지 않는 것을 본다. ci가 진행 중이면 대기 후 녹색일 때 게시된다. (v0.9.0은 빨간 CI 위에서 나갔다.)
- **US4:** 도입담당/개발자-도구가 같은 태그를 다시 빌드할 때 같은 컴파일러 버전을 얻는다. 성공하면 CI·릴리즈·Docker 이미지 빌드 로그에 **toolchain 파일로 해석된** `rustc --version`이 고정 버전(`1.99.1`)으로 찍힌 것을 본다.

## 1. 문제

`rust-toolchain.toml`은 `channel = "stable"`만 지정한다. CI는 `dtolnay/rust-toolchain@stable`로 **실행 시점의 최신 stable**을, 로컬은 **마지막 `rustup update` 시점의 stable**을 쓴다. 새 stable이 clippy lint를 늘리면 로컬 pre-commit은 통과하고 CI는 `-D warnings`로 실패한다(US1 실측). 게다가 release 워크플로는 clippy를 돌리지 않아 **빨간 CI 위에서도 릴리즈가 성공**한다 — v0.9.0이 그랬고, 현재 이를 막는 건 절차 문서(`docs/dev/tauri-desktop-build.md:71`)와 메모리뿐이다.

**고정 버전 = `1.99.1`**: 현재 stable(`curl -s https://static.rust-lang.org/dist/channel-rust-stable.toml | grep -A1 '^\[pkg.rustc\]'` → `1.99.1 (58cf8f9c3 2026-10-13)`)이며, 마지막 녹색 CI(`11735f43`, run 39042516069)가 실제로 1.99.1로 돌았다(그 run 로그의 `rustc 1.99.1` 줄 — spec 리뷰 R1 실측). 즉 `29b34d80` 이후 master가 clippy clean이라는 증거가 이미 1.99.1에 대해 있다. `1.99.0`은 superseded 포인트 릴리즈라 고정 대상으로 부적합. 거울 대상 실존: `git ls-remote https://github.com/dtolnay/rust-toolchain refs/heads/1.99.1` → 1행 · `curl -s -o /dev/null -w '%{http_code}' https://hub.docker.com/v2/repositories/library/rust/tags/1.99.1-bookworm` → `200`.

컴파일러 버전이 지정되는 곳(확인 명령: `grep -n "dtolnay/rust-toolchain" .github/workflows/*.yml` · `grep -n "^FROM rust" deploy/Dockerfile`):

| # | 위치 | 현재 |
|---|---|---|
| 1 | `rust-toolchain.toml` `channel` | `stable` |
| 2 | `.github/workflows/ci.yml:14` | `dtolnay/rust-toolchain@stable` (+ `components: rustfmt, clippy`) |
| 3 | `.github/workflows/release.yml:71` (windows-installer) | `@stable` |
| 4 | `.github/workflows/release.yml:182` (macos-dmg) | `@stable` (+ `targets: ${{ matrix.target }}`) |
| 5 | `.github/workflows/e2e-kind.yml:14` | `@stable` |
| 6 | `deploy/Dockerfile:20` | `FROM rust:1.85-bookworm` — 25행 `COPY … rust-toolchain.toml` 때문에 컨테이너 안 rustup은 파일의 채널을 따른다 |

**#6 보충**: base 이미지 컴파일러(1.85)는 toolchain 파일이 다른 채널을 지정하면 쓰이지 않는다(rustup override 우선순위). 이미지 안 rustup이 미설치 툴체인을 자동 설치하는지는 rustup 버전에 달려 있어 **미검증**(Docker 데몬 부재). `FROM`을 파일과 같은 버전으로 맞추면 **툴체인 자체의 다운로드는 불필요**해진다. 단 공식 이미지는 `--profile minimal`로 설치되고 우리 파일은 `rustfmt`·`clippy` 컴포넌트를 지정하므로, 빌드 중 rustup이 그 두 컴포넌트를 받을 수는 있다(빌드는 동작 — 컴포넌트 수 MB 수준). 런타임이 `debian:bookworm-slim`이라 빌더도 bookworm 유지(glibc 정합).

`desktop/src-tauri`는 별도 `[workspace]`지만 자체 toolchain 파일이 없다(`ls desktop/src-tauri/rust-toolchain*` → 없음). rustup은 cwd에서 상위로 toolchain 파일을 찾으므로 루트 파일을 따른다 — 별도 고정 불필요.

## 2. 목표 / 비목표

**목표**
1. 6곳을 같은 정확 버전 `1.99.1`로 고정. 원천은 `rust-toolchain.toml`, 나머지 5곳은 거울.
2. 6곳 불일치를 CI가 기계로 잡는다(정합 검사 스크립트).
3. 버전 승급을 한 명령(`just bump-rust <ver>`)으로.
4. release `publish` 잡이 태그 커밋의 `ci` 워크플로 성공을 확인한 뒤에만 게시한다.
5. 빌드 로그가 실제로 쓰인 컴파일러 버전을 보여준다(US4).

**비목표**: 최신 stable 카나리 잡(새 lint 조기 경보 — 승급 커밋에서 고치는 것으로 충분) · MSRV(`rust-version = "1.85"`) CI 검사(MSRV는 별개로 유지만) · CI 게이트 우회 입력(긴급 릴리즈용 escape hatch — flake는 ci 재실행으로 해소) · preflight의 조기 실패 모드(ci가 이미 빨강이면 빌드 전에 실패 — 고정 이후 빨간 CI는 드물고 publish 게이트로 게시는 막히므로 18분 빌드 낭비만 남는다. 리뷰 R9 선택안, 기각) · Dockerfile의 Node 20 버전 · pre-commit에 정합 검사 추가(승급은 `bump-rust` 경유, 수기 편집은 CI가 잡는다) · release 워크플로 권한 전면 최소화(roadmap 별도 후속 — 이 슬라이스는 `publish`에 필요한 만큼만).

**문서에 버전 리터럴을 쓰지 않는다**: CLAUDE.md·README·dev 문서는 "`rust-toolchain.toml`의 고정 버전"을 가리키고 숫자를 적지 않는다(적으면 승급마다 stale). 예외: 이 spec·build-log·roadmap 같은 시점 기록.

**plan 구조 가이드**: (a) 고정+정합 검사+`bump-rust`+버전 출력, (b) publish 게이트+ci `workflow_dispatch`, (c) 문서 — 셋은 독립 green 단위다. (a)는 `rust-toolchain.toml`을 바꾸므로 pre-commit 전체 cargo 게이트가 1.99.1로 돈다 — 착수 전 `rustup toolchain install 1.99.1 --component rustfmt --component clippy`.

## 3. 설계

### 3.1 고정 (6곳) + 버전 출력

- `rust-toolchain.toml`: `channel = "1.99.1"`. `components = ["rustfmt", "clippy"]` 유지. `targets`는 추가하지 않는다(macOS 크로스 타깃을 모든 개발자에게 설치시키지 않기 위해 — 워크플로 입력이 담당).
- 워크플로 4곳: `uses: dtolnay/rust-toolchain@1.99.1`. 기존 `with:` 입력(`components`·`targets`)은 그대로.
- `deploy/Dockerfile`: `FROM rust:1.99.1-bookworm AS rust-build`.

**버전 출력(US4)**: 액션 자체의 버전 출력은 `rustc +"$toolchain" --version`(명시 툴체인)이라 toolchain 파일과 어긋나도 액션 버전을 찍는다 — 공허(spec 리뷰 R4: `gh api 'repos/dtolnay/rust-toolchain/contents/action.yml?ref=1.99.0'`). 그래서 **`+` 없는 `rustc --version`**(toolchain 파일로 해석 = cargo가 실제로 쓰는 것)을 찍는다:
- 워크플로 4곳: 각 `dtolnay/rust-toolchain` 스텝 직후 `- name: Effective toolchain` / `run: rustc --version && cargo --version`. (release 두 잡은 checkout된 리포 루트에서 실행되므로 루트 toolchain 파일이 적용된다.)
- Dockerfile: `cargo build` RUN 앞에 `rustc --version &&` 연결(별 레이어 불필요).

**거울이 파일과 일치해야 하는 이유**: 파일 채널과 워크플로 버전이 다르면 cargo는 파일을 따르고(override 우선), 워크플로가 설치한 `targets`(macOS 잡)는 다른 툴체인에 붙어 빌드가 타깃 없음으로 실패한다. 그래서 거울은 "파일 자동 추종에 기대지 않는 명시"이면서 정합 검사 대상이다.

### 3.2 정합 검사 `scripts/check-rust-toolchain.sh`

`check-release-versions.sh` 관례를 따른다: `set -euo pipefail`, repo-root로 `cd "$(dirname "$0")/.."`, bash 3.2 호환, 항목마다 `ok`/`MISMATCH` 한 줄, **불일치를 전부 출력한 뒤** 종료코드 1.

- 원천: `rust-toolchain.toml`의 `channel` 값. `^[0-9]+\.[0-9]+\.[0-9]+$`가 아니면(예: `stable`) `MISMATCH` — 정확 버전 고정 자체가 불변식이다.
- 거울 ①: `.github/workflows/*.yml`의 모든 `dtolnay/rust-toolchain@<ref>` 출현마다 `<ref>` == 채널. 출현이 0개면 실패(패턴이 바뀌어 검사가 공허해지는 것 방지).
- 거울 ②: `deploy/Dockerfile`의 모든 `FROM rust:<ver>-…` 출현마다 `<ver>` == 채널. 0개면 실패.
- 각 출력 줄은 `파일:줄`을 포함한다.
- 인자 없음. 툴체인 불필요(grep/sed만) → `ci.yml` `rust` 잡의 **checkout 직후 첫 스텝**(툴체인 설치 전에 실패).

### 3.3 `just bump-rust <ver>`

`bump-version` 레시피 형태(bash + 인라인 python)를 따르되 **전부 검증한 뒤 전부 쓴다**(`bump-version`은 파일별 즉시 기록이라 뒤 assert 실패 시 반쯤 쓰인 상태가 남는다 — spec 리뷰 R8):

1. `<ver>`가 `^\d+\.\d+\.\d+$`가 아니면 실패(`v` 접두·`stable`·`1.99` 거부).
2. 거울 대상 실존 확인(네트워크): `git ls-remote --exit-code https://github.com/dtolnay/rust-toolchain refs/heads/<ver>` · `curl -sf -o /dev/null https://hub.docker.com/v2/repositories/library/rust/tags/<ver>-bookworm`. 실패 시 "새 릴리즈 직후라 아직 안 나왔거나(수일 내 생성) bookworm 태그가 중단됨 — Dockerfile 베이스 결정 필요" 안내 후 중단. 이 두 스텝은 Rust 릴리즈 후 지연을 두고 생기기 때문이다.
3. 메모리에서 6곳 치환을 모두 계산: `rust-toolchain.toml`의 `channel = "…"`(정확히 1개) · 워크플로 3파일의 `dtolnay/rust-toolchain@<ref>`(합계 ≥1) · Dockerfile의 `FROM rust:<ver>-`(≥1). 하나라도 assert 실패면 **아무 파일도 쓰지 않고** 중단.
4. 전부 기록 + 파일별 치환 건수 출력.
5. `scripts/check-rust-toolchain.sh` 실행 — 권위 있는 정합 판정.
6. `rustup toolchain install <ver> --component rustfmt --component clippy` — rustup 자동 설치 기본값에 의존하지 않기 위해 명시(멱등).
7. 다음 단계 안내: 승급 커밋을 만들면 pre-commit이 `rust-toolchain.toml` staged로 전체 cargo 게이트를 새 clippy로 돌린다 → 새 lint는 **같은 커밋에서** 고친다. 오프라인(에어갭) 빌드 머신은 반입 아카이브를 새 버전으로 다시 만들어야 한다(`docs/dev/install-rhel-airgapped.md` §4.3).

승급 주기는 2~3개월 또는 필요 시(새 기능·보안 수정). 주기 자동화는 비목표.

### 3.4 publish 게이트 `scripts/check-ci-green.sh <sha>`

판정 로직을 YAML이 아니라 스크립트에 둔다(release-hygiene 선례 — 로컬 양방향 실행 검증 가능). bash 3.2 호환, JSON은 `gh … --jq`로 파싱(외부 `jq` 의존 없음).

- 인자: **40자 hex 전체 SHA**(`^[0-9a-f]{40}$`), 아니면 usage + exit 2. 단축 SHA는 `gh run list --commit`이 `[]`를 돌려 "run 없음"으로 오판되기 때문(spec 리뷰 R7 실측: `--commit 11735f43` → `[]`).
- 조회: `gh run list --workflow ci --commit <sha> --limit 20 --json databaseId,status,conclusion,createdAt,url --jq …` (`GITHUB_REPOSITORY`가 있으면 `--repo`로 전달).
- 판정 대상: **가장 최근 run 1개**(`createdAt` 최대). 재실행은 같은 run의 `conclusion`을 갱신하므로 flake 후 ci 재실행이 반영된다.
  - run 0개 → 실패. 메시지: "이 커밋에 ci run이 없다. ci는 push의 **head 커밋**에서만 돈다 — 한 push에 여러 커밋을 올리면 중간 커밋엔 run이 없다(실측: `29b34d8027e8cefe733e9c026c6886251e1d3f95`는 master에 있지만 run 0개). 해소: `gh workflow run ci --ref <태그>` → 녹색 확인 → 이 publish 잡만 재실행."
  - `status != completed` → `CI_GATE_POLL_SECONDS`(기본 30)마다 재조회, 누적 `CI_GATE_MAX_WAIT_SECONDS`(기본 1800) 초과 시 실패.
  - `completed` + `conclusion == success` → 통과(run URL 출력).
  - `completed` + 그 외(`failure`·`cancelled`·`timed_out`·…) → 실패: 결론·run URL·해소법("flake면 ci 재실행 후 이 publish 잡만 재실행 / 진짜 실패면 수정 커밋+새 태그").
- `gh` 호출 실패 → 즉시 실패(fail-closed — publish 재실행은 수십 초라 재시도 없음). 메시지에 "권한(`actions: read`) 누락이면 403" 힌트.
- 대기 상한 근거: ci 전체 소요 실측 2–7분, release 약 19분(`gh run list --workflow <w> --limit 5 --json createdAt,updatedAt`) — publish 도달 시점엔 보통 완료. 30분은 큐 지연 여유.

**ci.yml에 `workflow_dispatch:` 추가**: 위 "run 0개" 해소 경로(`gh workflow run ci --ref <태그>`)를 가능하게 한다. ci는 여전히 통과해야 하므로 비목표의 "게이트 우회"가 아니다. dispatch run의 headSha는 `--ref`가 가리키는 커밋이라 게이트의 `--commit` 조회에 잡힌다.

**워크플로 배선** (`release.yml` `publish` 잡):
- checkout 직후 스텝 `CI green gate`: `scripts/check-ci-green.sh "$(git rev-parse HEAD)"`, `env: GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`·`GITHUB_REPOSITORY`. **SHA는 `github.sha`가 아니라 checkout 후 `HEAD`** — `workflow_dispatch`에서 `github.sha`는 디스패치 브랜치 커밋이라 엉뚱한 커밋을 검사하게 된다(preflight checkout 주석과 같은 함정). `actions/checkout`은 tag ref를 커밋으로 풀어 체크아웃하므로 `HEAD`가 태그 커밋이다.
- 게이트는 `download-artifact`·`Publish release`보다 앞 — 실패 시 아무것도 게시되지 않는다.
- 권한: `publish` 잡에 **job-level** `permissions: { contents: write, actions: read }`(job-level은 top-level을 통째로 대체하므로 둘 다 명시). top-level은 그대로 둔다 — `actions: read`를 서드파티 액션(`tauri-action`)이 도는 빌드 잡에 퍼뜨리지 않기 위해(spec 리뷰 R10).
- `publish` 잡에 `timeout-minutes: 45`(게이트 상한 30분 + 게시 여유). 현재 미지정.
- **실패 시 복구 경로**(배선 버그 포함 — 게이트가 fail-closed라 권한 누락 등은 다음 릴리즈를 막는다): master를 고친 뒤 release를 `workflow_dispatch`(입력 `tag`)로 재실행. 단 그 태그 트리의 스크립트가 쓰이므로(모든 잡이 `ref: <태그>` 체크아웃) 게이트 자체 버그는 새 태그가 필요하다.
- **소급 불가**: 이 변경 이전 태그 트리엔 `check-ci-green.sh`가 없어, 그런 태그를 `workflow_dispatch`로 재발행하면 18분 빌드 뒤 publish에서 실패한다(preflight가 아니라 publish라서 늦게 실패) — `tauri-desktop-build.md:83` 소급 문단에 추가.

### 3.5 문서

"채널만 고정"·`@stable` 서술을 고정 버전(리터럴 없이 파일 지시)·`bump-rust`·publish 게이트로 교체:
- 루트 `CLAUDE.md:48` (CI 버전 재현 레시피 → 고정 설명 + `just bump-rust` 포인터; 절대경로 `CARGO_TARGET_DIR` 함정은 *다른 버전 시험* 용도로 남긴다).
- `docs/dev/commit-gates-and-git-workflow.md:15`.
- `docs/dev/tauri-desktop-build.md:11`·`:53`(publish 잡 설명에 게이트)·`:71`(수동 `gh run list` 확인은 보조로 유지 + publish 게이트 언급)·`:83`(소급 불가 문단).
- `docs/dev/install-rhel.md:8`·`:87` ("stable 고정" → 정확 버전 고정, rustup이 자동 선택).
- `docs/dev/install-rhel-airgapped.md` §4.3(140–150행 부근): 연결 머신에서 **아카이브 전 `rustup toolchain install <rust-toolchain.toml의 channel> --component rustfmt --component clippy`** 필수(연결 머신 기본 stable이 고정 버전과 다르면 오프라인 빌드가 실패) + 116행 미러 경로도 그 정확 버전이 있어야 함.
- `docs/dev/single-exe-build.md:236–239` 샘플 스니펫: `@stable`+`toolchain: stable-x86_64-pc-windows-msvc` → 레포 고정 버전을 따르도록(리터럴 대신 "`rust-toolchain.toml`의 버전" 주석).
- `README.md:486` (`요구: Rust stable` → `rust-toolchain.toml` 고정 버전, rustup이 자동 선택).
- roadmap §B32 R-e 해소·현황판·build-log는 finish-slice가 처리.

## 4. 검증

- **정합 검사 양방향**: 고정 후 `scripts/check-rust-toolchain.sh` → `ok` 6줄·exit 0. 한 곳씩 어긋나게(파일 채널 `stable`, 워크플로 1곳, Dockerfile) 바꿔 각각 해당 줄 `MISMATCH`·exit 1 확인 후 원복. 0건 가드 둘 다: 워크플로 4곳의 `dtolnay/rust-toolchain@`을 임시로 다른 문자열로 / Dockerfile `FROM rust:`을 임시로 다른 문자열로 바꿔 각각 "출현 0개" 실패·exit 1 → 원복(`git diff` 0).
- **`bump-rust` 왕복**: 워크트리에서 `just bump-rust 1.97.0`(로컬 설치본 — `rustup toolchain list`; dtolnay `1.97.0` 브랜치·`rust:1.97.0-bookworm` 태그 실존은 착수 시 확인) → 6곳 변경·정합 ok → `just bump-rust 1.99.1` 복귀 → `git diff` 0. 잘못된 입력(`v1.99.1`·`stable`·`1.99`) 거부 + 실존 안 하는 버전(`1.999.0`) 거부, 각각 거부 후 `git diff` 0(무기록) 확인.
- **CI 게이트 양방향 (로컬)**: 실 `gh`로 `11735f432ef912156132924ff5d1d17cc50641a5`(success) → 통과 · `854a22dee875c27c3f68b9a889a958de04a5743e`(failure) → 실패 · `29b34d8027e8cefe733e9c026c6886251e1d3f95`(run 0개) → 실패+`gh workflow run ci --ref` 안내 · 단축 SHA `11735f43` → exit 2. `PATH` 앞단 `gh` 스텁으로 `in_progress`→`success` 시퀀스(통과)·영구 `in_progress`(상한 초과 실패)·`gh` 실패(즉시 실패)를 `CI_GATE_POLL_SECONDS=0`·작은 `CI_GATE_MAX_WAIT_SECONDS`로 확인. 스크립트는 읽기 전용 조회만 하므로 release-hygiene의 게시 오염 위험은 없다.
- **CI 실측 (머지 후)**: master push 후 ci `rust` 잡 로그에서 정합 검사 `ok` 6줄 + `Effective toolchain` 스텝 `rustc 1.99.1` 확인(US1·US2·US4). release 경로·Docker 이미지 경로의 실측은 다음 실제 태그·이미지 빌드에서(시험용 태그를 만들지 않는다) — build-log에 "미실측, 다음 릴리즈에서 확인"으로 기록. (Docker 줄은 `cargo build` 레이어가 재빌드될 때만 찍힌다 — 태그 없이 보려면 `e2e-kind` 수동 디스패치가 `just build-image`를 돈다; 선택.)
- `actionlint`가 있으면 워크플로 3파일 검사(없으면 생략, 사유 기록).

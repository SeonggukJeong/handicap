# GitHub 비공개 저장소 + Windows Tauri 릴리즈 자동화 (설계)

- 날짜: 2026-06-26
- 상태: 승인됨 (브레인스토밍 → 구현)
- 범위: 리포지토리 게시 + CI/릴리즈 인프라. **`crates/*/src`·`ui/src` 0-diff** (코드 변경 없음) → `spec-review-guard`/`tdd-guard` 비대상. 따라서 무거운 subagent-driven 슬라이스 파이프라인 대신 직접 구현 + 실측(actual Actions run)으로 검증.

## 목표

1. 현 로컬 저장소를 GitHub **비공개** 저장소 `limvik/handicap`로 게시(`master`만).
2. GitHub Actions로 **Windows용 Tauri 데스크톱 인스톨러**(NSIS `.exe` + MSI)를 빌드.
3. 태그 푸시로 **GitHub Release를 자동 생성**하고 인스톨러를 첨부. 첫 릴리즈 = `v0.1.0`.

## 결정 (브레인스토밍에서 확정)

| 항목 | 결정 |
|---|---|
| Windows 산출물 | Tauri 인스톨러(NSIS `.exe` + MSI). 단일 bundle exe·둘 다는 비채택 |
| 릴리즈 트리거 | `push: tags: ['v*']` + `workflow_dispatch`(수동 시 태그 입력) |
| 기존 CI | `e2e-kind.yml`은 `workflow_dispatch`만으로 전환, `ci.yml`은 push/PR 유지 |
| 저장소 | `limvik/handicap` (private), 소유자 = `limvik` 개인 계정 |
| 첫 태그 | `v0.1.0` (tauri.conf `version`과 일치) |

## 빌드 사실 (검증)

- **현재 데스크톱 빌드는 in-process**(ADR-0042). `tauri.conf.json`에 `externalBin` 없음, `desktop/src-tauri/Cargo.toml`이 `handicap-controller`를 path 의존(`features=["bundle"]`)으로 컴파일. → **사이드카 바이너리 복사 단계 없음**.
- 선행 필수: `ui/dist`(rust-embed가 컴파일타임 임베드 → `pnpm --dir ui build` 먼저) + `protoc`(tonic-build).
- 빌드: `cd desktop && cargo tauri build --bundles nsis,msi` → `desktop/src-tauri/target/release/bundle/{nsis,msi}/`.
- `desktop/src-tauri`는 루트 워크스페이스 밖(자체 `[workspace]`)이라 루트 cargo 게이트와 무관. `Cargo.lock` 커밋됨(재현 빌드).
- `icon.ico`·`capabilities/default.json`(window `"main"`) 존재 → Windows 번들 전제 충족.
- **주의: 이 Windows Tauri 빌드는 이 repo에서 한 번도 실행된 적 없는 미검증 경로**(런북의 "Windows-검증 갭"). CI 첫 run이 사실상 최초 Windows 빌드 → green까지 1~2회 수정 가능성.

## 산출물

### 1. `.github/workflows/release.yml` (신규)
- 트리거: `push: tags: ['v*']` + `workflow_dispatch{inputs.tag}`.
- 러너: `windows-latest`. `permissions: contents: write`(릴리즈 생성/업로드).
- 단계: checkout → setup-node(20) + pnpm(9) → `ui`에서 `pnpm install --frozen-lockfile && pnpm build` → `arduino/setup-protoc@v3`(repo-token) → `dtolnay/rust-toolchain@stable`(MSVC) → `Swatinem/rust-cache@v2`(`desktop/src-tauri -> target`) → `tauri-apps/tauri-action@v0`(`projectPath: desktop`, `args: --bundles nsis,msi`, `tagName: ${{ inputs.tag || github.ref_name }}`).
- 결과: tauri-action이 빌드 → 해당 태그로 GitHub Release 생성 + NSIS/MSI 첨부.

### 2. `.github/workflows/e2e-kind.yml` (수정)
- `on:`을 `workflow_dispatch:`만으로 변경(push/PR 트리거 제거) — 무거운 kind e2e 분 절약.

### 3. `docs/dev/tauri-desktop-build.md` (수정)
- ADR-0040 사이드카 런북 → ADR-0042 in-process 런북으로 정정. 바이너리 복사/externalBin 단계 제거, 실제 빌드 명령 반영, CI 릴리즈 워크플로 포인터 추가. 아키텍처/보안 상세는 `desktop/CLAUDE.md`·ADR-0042가 단일 소스이므로 그쪽을 가리킴.

## 실행 순서

1. 설계 문서 커밋(본 파일).
2. `release.yml` 작성 + `e2e-kind.yml` 수정 + 런북 정정 → 커밋(`.github`·`docs` 만 → pre-commit fast-path).
3. 로컬 검증: YAML 문법 + macOS `cargo tauri build --bundles app` 스모크(컴파일·tauri.conf 유효성, Windows 인스톨러는 못 만들지만 그래프 검증).
4. `gh repo create limvik/handicap --private --source=. --remote=origin` → `git push -u origin master`.
5. 첫 푸시 시 `ci.yml`만 자동 실행됨을 확인.
6. `v0.1.0` 태그 푸시 → `release.yml` 실측. 빌드 모니터링 → 실패 시 수정 → green + 릴리즈에 인스톨러 첨부 확인.

## 검증

- 로컬: macOS tauri 빌드 스모크 통과(그래프 컴파일·번들 파이프라인).
- 원격: Actions `release` 워크플로가 `windows-latest`에서 green, GitHub Release `v0.1.0`에 `Handicap_0.1.0_x64-setup.exe`(NSIS) + `Handicap_0.1.0_x64_*.msi` 첨부.
- 비범위: 인스톨러 실제 설치/실행(Windows 머신 필요) — 런북의 "Windows-검증 갭" 체크리스트로 후속.

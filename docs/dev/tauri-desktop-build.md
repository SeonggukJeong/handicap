# Tauri 데스크톱 셸 빌드/릴리즈 런북 (ADR-0042, 접근 2: in-process)

`desktop/`의 Tauri v2 셸은 **컨트롤러를 in-process로 임베드하는** 네이티브 창이다(ADR-0042 — 구 ADR-0040의 사이드카 접근을 대체). `desktop/src-tauri/Cargo.toml`이 `handicap-controller`를 path 의존(`features=["bundle"]`)으로 컴파일하므로, 셸 프로세스 안에서 컨트롤러가 직접 돌고 워커만 `current_exe worker …`로 self-spawn된다. 사이드카 spawn·포트 로그 파싱·externalBin 복사는 **없다**.

> 아키텍처·런타임 동작·보안 경계(멀티콜 워커, async shutdown 브리지, CSP, R4b disconnect-cancel 등)는 **`desktop/CLAUDE.md`와 `docs/adr/0042-tauri-in-process-controller.md`가 단일 소스**다. 이 파일은 *빌드/릴리즈 절차*만 다룬다.

---

## 사전 준비

- **Rust** (워크스페이스 toolchain; `rust-toolchain.toml`이 고정). macOS는 Xcode CLT(`xcode-select --install`).
- **Tauri CLI v2**: `cargo install tauri-cli --version "^2" --locked` (→ `cargo tauri`).
- **Node/pnpm**: UI 빌드(`ui/dist`)용. (셸 프런트는 정적 스플래시 한 장이라 Node 무관 — `desktop/`는 `--manager cargo`로 스캐폴드돼 `package.json`/`node_modules` 없음.)
- **protoc**: `desktop`가 `handicap-controller{bundle}` 그래프 전체를 컴파일하므로 `handicap-proto`→`tonic-build`가 `protoc`를 요구. fresh 머신은 `brew install protobuf`.
- **Windows 전용**: Rust MSVC 타깃(`x86_64-pc-windows-msvc`) + WebView2 런타임. WebView2는 최신 Windows 10/11에 기본 탑재 — 없으면 MS "Evergreen Bootstrapper"로 설치 확인.

`desktop/src-tauri`는 **루트 cargo 워크스페이스 밖**(자체 빈 `[workspace]` 테이블)이라 `cargo build --workspace`·pre-commit cargo 게이트가 Tauri 시스템 의존 없이 그대로 통과한다. desktop 크레이트 자체 테스트는 게이트 밖이므로 `cd desktop/src-tauri && cargo test`로 수동 확인.

---

## 로컬 빌드 단계 (검증된 순서)

```bash
# 1) UI 빌드 — bundle controller가 rust-embed로 ui/dist를 컴파일타임 임베드하므로 먼저
pnpm --dir ui build

# 2) (선택) bundle feature 컴파일/테스트 — 기본 pre-commit 게이트는 bundle을 안 컴파일하므로 명시 검증
cargo test -p handicap-controller --features bundle      # 전체 green이어야 함

# 3) 데스크톱 앱 빌드 + 번들 (사이드카 복사 단계 없음 — in-process path 의존)
cd desktop && cargo tauri build --bundles nsis,msi
#   macOS 산출물:   src-tauri/target/release/bundle/macos/Handicap.app  (+ dmg — 아래 주의; --bundles app,dmg)
#   Windows 산출물: src-tauri/target/release/bundle/nsis/Handicap_<ver>_x64-setup.exe , bundle/msi/Handicap_<ver>_x64_*.msi
```

`tauri.conf.json`의 `bundle.targets`는 4종(`nsis`/`msi`/`dmg`/`app`)을 선언하지만 `cargo tauri build`는 호스트 OS에 맞는 타깃만 만든다(macOS=app/dmg, Windows=nsis/msi). 특정 타깃만 원하면 `--bundles <list>`.

### macOS 주의: `.app`은 headless OK, `.dmg`는 GUI 세션 필요

`cargo tauri build`의 **`.app` 번들은 headless(SSH/CI/터미널)에서도 생성**되지만, **`.dmg` 변환 단계(`bundle_dmg.sh`)는 AppleScript로 DMG 창 외형을 꾸미느라 WindowServer(로그인된 GUI 세션)를 요구**한다. headless에서는 `rw.*.dmg` 중간 이미지만 남고 최종 dmg 생성이 실패한다(앱 빌드 자체는 성공). 산출물만 필요하면(설치는 `.app` 드래그) `cargo tauri build --bundles app`.

---

## CI 릴리즈 (Windows 인스톨러 + 포터블 exe + macOS dmg)

`.github/workflows/release.yml`이 **Windows NSIS `.exe` + MSI 인스톨러, 포터블 단일 exe, macOS `.dmg`(아키텍처별 2개)를 빌드해 GitHub Release에 첨부**한다. 4-잡 그래프: `preflight`가 정합을 게이트하고, `windows-installer`/`macos-dmg`는 **빌드만**(릴리즈를 만들지 않는다), `publish`가 유일한 게시 지점이다.

- **트리거**: `v*` 태그 푸시(예: `git tag v0.1.0 && git push origin v0.1.0`) 또는 Actions UI의 수동 실행(`workflow_dispatch` — 태그 입력).
- **잡 그래프**:
  - **`preflight`**(ubuntu, 수 초): `scripts/check-release-versions.sh "<태그>"`로 태그↔버전 문자열(3개 매니페스트 + 생성 락 2개, 총 14항목 — 아래 "버전 bump" 참조) 정합을 검사한다. 실패하면 뒤따르는 18분짜리 빌드 잡들이 **시작조차 안 한다**.
  - **`windows-installer`**(windows-latest, `needs: preflight`): `pnpm --dir ui build` → `protoc` 설치 → rust(MSVC) → `tauri-apps/tauri-action`(`projectPath: desktop`, `--bundles nsis,msi`, **`tagName` 없음 — 릴리즈를 만들지 않는다**) → 같은 잡에서 루트 워크스페이스 `cargo build --release -p handicap-controller --bin controller --features bundle`로 포터블 단일 exe도 빌드 → 인스톨러 3종을 `staging/`에 모아 artifact `release-assets-windows`로 업로드.
  - **`macos-dmg`**(macos-latest, `needs: preflight`, matrix `target ∈ {aarch64-apple-darwin, x86_64-apple-darwin}`, `fail-fast: false` — 한쪽이 실패해도 다른 쪽 dmg는 빌드된다): 아키텍처별 네이티브로 `tauri-action`을 **`tagName` 없이** `--bundles app,dmg` 호출(빌드만) → artifact 2종 업로드 — 발행용 `release-assets-macos-<target>`(dmg만, `if-no-files-found: error`) + 회수용 `macos-bundle-<target>`(`.app` 포함, `if: always()` — dmg 변환이 GUI 세션 요구로 실패해도 `.app`은 남는다). **`universal-apple-darwin`(lipo)을 쓰지 않는 이유**: lipo 합본은 링커가 붙인 ad-hoc 서명이 날아가 arm64에서 실행이 거부될 수 있다. 서명·공증 없음 → 사용자는 Gatekeeper 우회 필요(README §C에 우클릭-열기/`xattr -dr com.apple.quarantine` 안내).
  - **`publish`**(ubuntu, `needs: [windows-installer, macos-dmg]`, `if: always() && needs.windows-installer.result == 'success'`): `download-artifact`를 `pattern: release-assets-*`(회수용 `macos-bundle-*`는 매치 안 됨)·`merge-multiple: true`로 받아 한 디렉터리에 합친 뒤 `scripts/publish-release.sh "<태그>" staging`을 실행 — 릴리즈 생성/에셋 업로드/노트 처리가 전부 여기 한 곳. **macOS 양쪽이 다 실패해도 Windows 3종만으로 발행된다**(에셋 **이름** 5종은 불변식이지만 **완전성**은 불변식이 아니다).
- **구 30분 폴링이 사라진 이유**: 이전엔 windows/macos 두 잡이 각자 릴리즈를 만들려 해 동시-create 레이스가 있었고, macos 잡은 windows 잡이 릴리즈를 먼저 만들 때까지 20초 간격 최대 30분 폴링한 뒤에야 업로드했다. 이제 릴리즈 생성(및 첫 업로드)이 `publish` 한 곳으로 모여 애초에 레이스가 없다 — 폴링이 통째로 삭제됐다.

### 버전 bump

`just bump-version <ver>`가 사람이 맞춰야 할 파일 3개를 한 번에 갱신한다: 루트 `Cargo.toml`(`[workspace.package] version`) · `desktop/src-tauri/Cargo.toml`(`[package] version`) · `desktop/src-tauri/tauri.conf.json`(`version`). 생성물 락 2개(`Cargo.lock` · `desktop/src-tauri/Cargo.lock`)는 같은 레시피가 `cargo metadata` 2회(각 워크스페이스 1회씩)로 재생성한다 — 전체 재해상도인 `cargo generate-lockfile`이나 `cargo update --workspace`는 불필요·금지. **`crates/*` 5개(`engine`/`proto`/`worker-core`/`worker`/`controller`)는 `version.workspace = true` 상속이라 릴리즈마다 건드리지 않는다.** 레시피 마지막이 `scripts/check-release-versions.sh v<ver>`로 정합을 자체검사하지만, **커밋·태그·push는 하지 않는다**(사람이 diff를 확인한 뒤 수행). 인스톨러 파일명은 `tauri.conf.json`의 `version`을 따른다(포터블 exe 이름도 태그에서 조립 — 위 워크플로 참조).

순서:

```bash
just bump-version <ver>          # 3파일 갱신 + 락 2개 재생성 + 정합 자체검사
# git diff로 검토
git add -u && git commit -m "chore(release): <ver> 버전 bump"
git push origin master           # 태그 대상 커밋이 origin에 있어야 CI가 체크아웃
git tag -a v<ver>
git push origin v<ver>
```

**주의**: bump가 이제 루트 `Cargo.toml`/`Cargo.lock`도 건드리므로(과거엔 `desktop/src-tauri/`만 건드려 루트 pre-commit cargo 게이트를 안 탔다) 이 커밋은 **cargo-영향 경로 커밋**이라 전체 게이트(fmt/build/clippy/nextest/doctest, 수 분)를 돈다 — 루트 `CLAUDE.md`의 "매 커밋 일상 규칙"대로 `git commit`을 단일 FOREGROUND 호출로 돌릴 것.

### 릴리즈 노트

`docs/release-notes/v<ver>.md`가 있으면 `publish` 잡이 그 본문으로 릴리즈를 발행하고, **없으면 자동 초안(`--generate-notes`/`generate-notes` API)으로 채운다 — 빈 본문 발행은 불가능**하다. 노트 파일은 **bump 커밋과 같은 커밋에 넣는 것을 권장**(태그가 그 커밋을 가리키므로, CI가 체크아웃하는 트리에 노트가 이미 존재하게 된다). 선례: `docs/release-notes/v0.6.0.md`(소급 작성). 기존 릴리즈에 소급 적용은 수동이다: `gh release edit v0.6.0 --notes-file docs/release-notes/v0.6.0.md`

### 장애 시 재실행

- **게시(`publish`)만 실패**(예: GitHub API 일시 장애) → Actions에서 해당 워크플로 실행을 열고 **"Re-run failed jobs"**. `windows-installer`/`macos-dmg`가 남긴 artifact를 그대로 재사용하므로 **수십 초**에 끝난다(18분 빌드를 다시 돌리지 않는다). 이 개선의 동기는 v0.5.0 사고: 18분 빌드 후 게시가 503으로 실패했고, 당시 구조는 재실행이 곧 전체 재실행이라 `setup-protoc` 단계에서 2분 만에 재실패했다(빌드가 통째로 다시 돌았기 때문).
- **워크플로 자체가 못 뜨는 경우**(예: Actions 장애로 `publish`조차 스케줄 안 됨) → `windows-installer`/`macos-dmg`가 남긴 artifact를 각 잡 페이지에서 내려받아 로컬에서 수동 `gh release create v<ver> <파일들...>`(이미 릴리즈가 있으면 `gh release upload v<ver> <파일들...> --clobber`).
- **소급 적용 안 됨**: 모든 잡이 `ref: <태그>`로 그 태그 시점의 트리를 체크아웃한다. **이 4-잡 구조 도입 이전에 자른 태그**(예: v0.7.0)를 `workflow_dispatch`로 재발행하려 하면 그 태그 트리엔 `scripts/check-release-versions.sh`가 없어 `preflight`에서 즉시 실패한다(파괴적이지는 않다) — "게시만 재실행" 혜택은 이 변경 **이후에 자른 태그에만** 적용된다.

### 버전 bump 이력

v0.1.0(2026-06-26)·v0.2.0(2026-06-29)·v0.2.1(2026-07-04)·v0.2.2(2026-07-11)·v0.3.0(2026-07-13, 마이너 — think-time-defaults 등 신규 기능 슬라이스 다수라 patch 관행 대신 minor 채택)·v0.4.0(2026-07-17, 마이너 — 포터블 단일 exe 에셋 신규 첨부 + v0.3.0 이후 기능 슬라이스 다수)·v0.5.0(2026-07-20)·v0.6.0(2026-07-25)·v0.7.0(2026-07-30, 마이너 — macOS dmg 에셋 신규 첨부 + v0.6.0 이후 기능 슬라이스 다수)이 이 절차로 발행됨(v0.1.0–v0.7.0은 모두 위 4-잡 구조 도입 **이전** — 수동 bump로 발행됐다. 그 이전 워크플로 자체도 균일하지 않았다: v0.1.0–v0.6.0은 단일 잡, v0.7.0은 macOS dmg 추가로 2-잡[windows-installer·macos-dmg] + 릴리즈 생성 최대 30분 폴링 구조).

**함정: `desktop/src-tauri/Cargo.lock`의 `desktop` 패키지 `version`은 `Cargo.toml`을 수동 bump해도 자동으로 안 따라온다** — v0.2.1 release 커밋이 `tauri.conf.json`+`Cargo.toml`만 bump하고 `Cargo.lock`은 안 건드려 `0.2.0`으로 한 버전 stale인 채 release가 나갔다(v0.2.2에서 발견·수동 정정). `just bump-version`을 쓰면 락 재생성이 자동이지만, 수동으로 파일을 고칠 땐 여전히 유효한 함정이니 `Cargo.lock`의 `name = "desktop"` 블록도 같이 확인할 것. **이제는 `scripts/check-release-versions.sh`가 태그 push 전(`just bump-version` 레시피 자체검사)과 `preflight`(CI, 태그 push 후)에서 이 항목을 기계로 검사한다(검사 #5 — 바로 이 v0.2.1급 사고를 막는 클래스).**

### Windows-검증 갭 체크리스트 (가용 머신이 macOS뿐 — Windows에서 1회 확인 필요)

빌드 green ≠ 실행 검증. 인스톨러가 만들어지면 Windows 머신에서:

- [ ] 인스톨러 설치 → 아이콘 실행 → 창에 핸디캡 UI 렌더 → responder 대상 run 1개 `completed` + 리포트.
- [ ] **앱 종료 시 작업관리자에 `controller`(in-process라 셸 프로세스)·`worker` 잔류 0** — R4d Windows Job Object가 self-spawn 워커까지 트리 종료(macOS killpg는 검증됨; Windows 경로는 코드만 존재 → 여기서 확인).
- [ ] 리포트 **CSV/XLSX 다운로드**가 WebView2에서 저장됨(HAR 업로드 파일 선택·클립보드 복사 포함 — `csp:null`이라 동작 기대).

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

## CI 릴리즈 (Windows 인스톨러 + 포터블 exe)

`.github/workflows/release.yml`이 **Windows NSIS `.exe` + MSI 인스톨러와 포터블 단일 exe를 빌드해 GitHub Release에 첨부**한다.

- **트리거**: `v*` 태그 푸시(예: `git tag v0.1.0 && git push origin v0.1.0`) 또는 Actions UI의 수동 실행(`workflow_dispatch` — 태그 입력).
- **흐름**: `windows-latest` 러너에서 `pnpm --dir ui build` → `protoc` 설치 → rust(MSVC) → `tauri-apps/tauri-action`(`projectPath: desktop`, `--bundles nsis,msi`) → 해당 태그로 릴리즈 생성 + 인스톨러 첨부 → (v0.4.0부터) 같은 잡에서 루트 워크스페이스 `cargo build --release -p handicap-controller --bin controller --features bundle`(README §B 포터블, ui/dist는 앞 단계 재사용) → `Handicap_<버전>_x64-portable.exe`로 리네임 후 `gh release upload`로 같은 릴리즈에 추가. rust-cache는 desktop·루트 두 워크스페이스를 캐시, timeout 90분.
- **버전**: 인스톨러 파일명은 `desktop/src-tauri/tauri.conf.json`의 `version`을 따른다. 태그와 일치시키려면 **tauri.conf `version` bump → commit → 같은 버전 태그** 순서(예: `version: "0.2.0"` 커밋 후 `v0.2.0` 태그). 일관성을 위해 같은 커밋에서 `desktop/src-tauri/Cargo.toml` + `Cargo.lock`의 `desktop` 패키지 버전도 함께 bump(인스톨러 이름은 tauri.conf만 따르지만 crate 버전 불일치 방지). **이 bump 커밋은 desktop이 별도 `[workspace]`라 루트 pre-commit cargo 게이트를 발동시키지 않는다**(`no cargo-affecting paths staged` → 빠른 통과; `desktop/src-tauri/Cargo.toml`은 루트 cargo-영향 경로로 안 잡힘). 그 다음 `git push origin master`(태그 대상 커밋이 origin에 있어야 CI가 체크아웃)·`git tag -a v<ver>`·`git push origin v<ver>`. v0.1.0(2026-06-26)·v0.2.0(2026-06-29)·v0.2.1(2026-07-04)·v0.2.2(2026-07-11)·v0.3.0(2026-07-13, 마이너 — think-time-defaults 등 신규 기능 슬라이스 다수라 patch 관행 대신 minor 채택)이 이 절차로 발행됨.

**함정: `desktop/src-tauri/Cargo.lock`의 `desktop` 패키지 `version`은 `Cargo.toml`을 수동 bump해도 자동으로 안 따라온다** — v0.2.1 release 커밋이 `tauri.conf.json`+`Cargo.toml`만 bump하고 `Cargo.lock`은 안 건드려 `0.2.0`으로 한 버전 stale인 채 release가 나갔다(v0.2.2에서 발견·수동 정정). 인스톨러 파일명·기능엔 영향 없지만(파일명은 tauri.conf만 따름) crate 버전 불일치 방지를 위해 bump 커밋마다 `Cargo.lock`의 `name = "desktop"` 블록도 같이 확인.

### Windows-검증 갭 체크리스트 (가용 머신이 macOS뿐 — Windows에서 1회 확인 필요)

빌드 green ≠ 실행 검증. 인스톨러가 만들어지면 Windows 머신에서:

- [ ] 인스톨러 설치 → 아이콘 실행 → 창에 핸디캡 UI 렌더 → responder 대상 run 1개 `completed` + 리포트.
- [ ] **앱 종료 시 작업관리자에 `controller`(in-process라 셸 프로세스)·`worker` 잔류 0** — R4d Windows Job Object가 self-spawn 워커까지 트리 종료(macOS killpg는 검증됨; Windows 경로는 코드만 존재 → 여기서 확인).
- [ ] 리포트 **CSV/XLSX 다운로드**가 WebView2에서 저장됨(HAR 업로드 파일 선택·클립보드 복사 포함 — `csp:null`이라 동작 기대).

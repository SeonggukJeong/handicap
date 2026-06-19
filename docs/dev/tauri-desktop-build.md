# Tauri 데스크톱 셸 빌드 런북 (ADR-0040, 옵션 B 접근 1)

`desktop/`의 Tauri v2 셸은 **기존 `bundle`-feature `controller` exe를 사이드카로 감싸는** 네이티브 창이다. 셸은 controller/worker/engine/UI 코드를 한 줄도 안 고치고(소비만), 부팅 시 controller를 `127.0.0.1:0`(OS가 빈 포트 원자 할당)로 직접 spawn → 로그에서 실제 REST 포트 파싱 → `/api/health`==`ok` 준비 확인 후 창을 그 localhost로 navigate한다. 창을 닫으면 controller + self-spawn 워커를 **트리째** 종료한다(macOS killpg / Windows Job Object).

> 옵션 A(브라우저로 여는 단일 `controller.exe`)는 `docs/dev/single-exe-build.md`. 이 셸은 그 bundle exe를 *재사용*한다 — 별도 산출물이 아니라 같은 사이드카를 감싸는 추가 배포 형태.

---

## 사전 준비

- **Rust** (워크스페이스 toolchain; `rust-toolchain.toml`이 고정). macOS는 Xcode CLT(`xcode-select --install`).
- **Tauri CLI v2**: `cargo install tauri-cli --version "^2" --locked` (→ `cargo tauri`).
- **Node/pnpm**: UI 빌드(`ui/dist`)용. (셸 프런트는 정적 스플래시 한 장이라 Node 무관 — `desktop/`는 `--manager cargo`로 스캐폴드돼 `package.json`/`node_modules` 없음.)
- **Windows 전용**: Rust MSVC 타깃(`x86_64-pc-windows-msvc`) + WebView2 런타임. WebView2는 최신 Windows 10/11에 기본 탑재 — 없으면 MS "Evergreen Bootstrapper"로 설치 확인.

`desktop/src-tauri`는 **루트 cargo 워크스페이스 밖**(자체 빈 `[workspace]` 테이블)이라 `cargo build --workspace`·pre-commit cargo 게이트가 Tauri 시스템 의존 없이 그대로 통과한다. desktop 크레이트 자체 테스트는 게이트 밖이므로 `cd desktop/src-tauri && cargo test`로 수동 확인.

---

## 빌드 단계 (검증된 순서)

```bash
# 0) repo 루트에서. 타깃 triple 확보(사이드카 명명용)
TRIPLE=$(rustc -vV | sed -n 's/host: //p')   # 예: aarch64-apple-darwin / x86_64-pc-windows-msvc

# 1) UI 빌드 — bundle controller가 rust-embed로 ui/dist를 컴파일타임 임베드하므로 먼저
pnpm --dir ui build

# 2) (R14) 사이드카 의존 health 확인 — 기본 pre-commit 게이트는 bundle을 컴파일하지 않으므로 명시 검증
cargo test -p handicap-controller --features bundle      # 전체 green이어야 함

# 3) 사이드카(bundle controller) release 빌드
cargo build -p handicap-controller --bin controller --features bundle --release

# 4) Tauri externalBin 규약대로 triple 접미사를 붙여 복사 (커밋 금지 — desktop/.gitignore가 무시)
cp target/release/controller "desktop/src-tauri/binaries/controller-${TRIPLE}"
#   Windows: cp target/release/controller.exe "desktop/src-tauri/binaries/controller-${TRIPLE}.exe"

# 5) 데스크톱 앱 빌드 + 번들
cd desktop && cargo tauri build
#   macOS 산출물:   src-tauri/target/release/bundle/macos/Handicap.app  (+ dmg — 아래 주의)
#   Windows 산출물: src-tauri/target/release/bundle/nsis/*.exe , bundle/msi/*.msi
```

Tauri는 빌드 시 `binaries/controller-<triple>`에서 triple 접미사를 떼어 앱 안 셸 바이너리 *옆*에 복사한다 — macOS `.app`이면 `Contents/MacOS/controller`(셸 `Contents/MacOS/desktop`과 나란히). 셸의 `resolve_sidecar_path`가 `current_exe` 옆을 찾으므로 설치 형태에서 그대로 동작한다(검증: `.app` 안에 `Contents/MacOS/{desktop,controller}` 둘 다 존재).

### macOS 주의: `.app`은 headless OK, `.dmg`는 GUI 세션 필요

`cargo tauri build`의 **`.app` 번들은 headless(SSH/CI/터미널)에서도 생성**되지만, **`.dmg` 변환 단계(`bundle_dmg.sh`)는 AppleScript로 DMG 창 외형을 꾸미느라 WindowServer(로그인된 GUI 세션)를 요구**한다. headless에서는 `rw.*.dmg` 중간 이미지만 남고 최종 dmg 생성이 실패한다(앱 빌드 자체는 성공).

- 산출물만 필요하면(설치는 `.app` 드래그): `cargo tauri build --bundles app`
- `.dmg`까지 만들려면 **로그인된 데스크톱 세션**에서 `cargo tauri build`(기본) 또는 `--bundles app,dmg`.

`tauri.conf.json`의 `bundle.targets`는 4종(`nsis`/`msi`/`dmg`/`app`)을 선언하지만, `cargo tauri build`는 호스트 OS에 맞는 타깃만 만든다(macOS=app/dmg, Windows=nsis/msi). 특정 타깃만 원하면 `--bundles <list>`.

---

## Windows 절차 (이 슬라이스에서 빌드만, 실행 검증은 갭으로 연기)

1. Rust(MSVC) + `cargo install tauri-cli --version "^2" --locked` + (UI 빌드용) Node/pnpm.
2. 위 단계 1–4를 Windows에서(`controller.exe`를 `binaries/controller-x86_64-pc-windows-msvc.exe`로 복사).
3. `cd desktop && cargo tauri build` → `src-tauri/target/release/bundle/nsis/Handicap_<ver>_x64-setup.exe`(+ `msi/`).
4. WebView2 전제: 최신 Windows 기본 탑재. 없으면 Evergreen Bootstrapper 설치 후 재실행.

### Windows-검증 갭 체크리스트 (가용 머신이 macOS뿐 — Windows에서 1회 확인 필요)

- [ ] 인스톨러 설치 → 아이콘 실행 → 창에 핸디캡 UI 렌더 → responder 대상 run 1개 `completed` + 리포트.
- [ ] **앱 종료 시 작업관리자에 `controller`/`worker` 프로세스 잔류 0** — R12 Job Object(`KILL_ON_JOB_CLOSE`)가 손자 워커까지 트리 종료. (macOS killpg는 검증됨; Windows 경로는 코드만 존재 → 여기서 확인.)
- [ ] 리포트 **CSV/XLSX 다운로드**가 WebView2에서 저장됨(HAR 업로드 파일 선택·클립보드 복사 포함 — `csp:null`이라 동작 기대).

---

## 위생 / 함정

- **사이드카 바이너리는 빌드타임 복사물(커밋 금지)**: `desktop/.gitignore`가 `src-tauri/binaries/controller*`·`src-tauri/target/`을 무시한다. 플랫폼마다 위 단계 3–4를 다시 돌려 해당 triple 바이너리를 깐다.
- **`binaries/controller-<triple>`가 없으면** `cargo build`/`cargo tauri build`가 externalBin 해석에서 실패한다 → 항상 단계 4를 먼저.
- bundle controller의 *행동*은 웹/단일 exe 경로와 byte-identical(셸은 기존 CLI 인자·로그만 소비). 셸이 자식 env에 `RUST_LOG=info`(포트 로그 보장) + `NO_COLOR=1`(ANSI 색 코드 억제 — 포트 파싱용)을 강제하는 것 외에 controller 동작 변경 없음.

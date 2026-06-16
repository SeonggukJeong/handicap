# 단일 self-contained 바이너리 빌드 런북

이 문서는 핸디캡을 **더블클릭으로 실행되는 단일 실행 파일**로 빌드하는 법을 초보자 눈높이로 설명한다.
macOS/Linux는 검증용이고, Windows `.exe`는 Windows 머신에서 빌드한다(이 저장소는 macOS에서 개발됨).

> **배경(ADR-0039)**: `bundle` cargo feature(기본 off)를 켜면 `controller` 바이너리 한 개가
> - UI 정적 파일을 내부에 임베드하고 (`--ui-dir` 불필요)
> - DB를 OS 사용자 데이터 폴더에 두고
> - 워커를 자기 자신(`current_exe worker …`)으로 재실행(subprocess 별도 설치 불필요)하고
> - 기본 포트(8080)가 사용 중이면 빈 포트로 자동 이동하고
> - 시작 시 기본 브라우저를 자동 오픈한다.
>
> feature가 꺼진 일반 빌드는 동작이 바이트 단위로 동일하게 유지된다.

---

## macOS/Linux — 자체완결 바이너리

### 1단계: UI 빌드 (임베드 입력)

```bash
cd ui
pnpm install        # 의존성 설치 (처음 한 번 또는 package.json 변경 시)
pnpm build          # ui/dist/ 생성 → cargo가 이 디렉터리를 바이너리 안에 임베드
cd ..
```

### 2단계: 단일 바이너리 빌드

```bash
cargo build --release --features bundle
```

결과물: `target/release/controller`

> `handicap-controller` 패키지엔 바이너리가 둘(`controller`, `e2e_kind_driver`)이지만
> **배포 대상은 `controller`**다. `cargo build --release --features bundle`은 둘 다 빌드하지만
> 실행 파일로 쓰는 건 `target/release/controller`.

### 3단계: 실행

```bash
./target/release/controller
```

- 브라우저가 `http://localhost:<포트>`로 자동 오픈된다.
- 포트 8080이 사용 중이면 OS가 빈 포트를 자동 배정한다(로그에서 실제 포트 확인 가능).
- 브라우저 자동 오픈을 끄려면:

```bash
./target/release/controller --no-open
```

### 데이터 위치 (macOS)

- DB 파일: `~/Library/Application Support/handicap/handicap.db`
- 백업/삭제 = 이 파일

---

## Windows `.exe` 빌드 — 초보자용

> **전제**: Windows 머신에서 모든 단계를 실행한다. 관리자 권한이 필요한 설치가 포함된다.

### 1단계: Visual Studio C++ 빌드 도구

Rust는 링킹에 **MSVC 링커**를 사용하므로 반드시 먼저 설치해야 한다.

1. https://visualstudio.microsoft.com/downloads/ 에서 "**Build Tools for Visual Studio**" 다운로드
2. 설치 프로그램을 실행 후 **"C++를 사용한 데스크톱 개발(Desktop development with C++)"** 워크로드에 체크
3. 설치 완료 후 재부팅(권장)

> Visual Studio IDE 전체 설치가 아니라 "Build Tools"(독립 빌드 도구)를 설치하면 용량을 아낄 수 있다.

### 2단계: Rust 설치

Rust 공식 인스톨러를 내려받아 실행한다.

```
브라우저에서: https://rustup.rs
→ rustup-init.exe 다운로드 후 실행
→ "1) Proceed with standard installation (default)" 선택 (기본 MSVC toolchain)
```

설치 후 새 터미널(PowerShell 또는 cmd)을 열고 확인:

```powershell
rustc --version
```

### 3단계: protoc (protobuf 컴파일러)

빌드 타임에 `tonic-build`가 `.proto` 파일을 컴파일하므로 필수다.

```powershell
winget install protobuf
```

`winget`이 없으면 https://github.com/protocolbuffers/protobuf/releases 에서 `protoc-<버전>-win64.zip`을 내려받아 압축 해제 후 `protoc.exe` 위치를 **시스템 PATH**에 추가한다.

설치 확인:

```powershell
protoc --version
```

### 4단계: Node.js + pnpm

UI를 빌드할 Node.js 런타임과 패키지 관리자가 필요하다.

```powershell
winget install OpenJS.NodeJS.LTS
```

설치 후 새 터미널을 열고:

```powershell
npm install -g pnpm
pnpm --version
```

### 5단계: 소스 가져오기

저장소를 Windows 머신에 복사한다.

- **git이 있으면**: 이 저장소를 clone하거나, 개발 머신에서 `git bundle create handicap.bundle --all`로 번들을 만들어 복사 후 `git clone handicap.bundle handicap`
- **git이 없으면**: zip으로 압축해 전달 후 압축 해제

이후 모든 명령은 저장소 루트(`handicap\`)에서 실행한다.

### 6단계: UI 빌드

```powershell
cd ui
pnpm install
pnpm build
cd ..
```

`ui\dist\` 폴더가 생성되면 성공이다.

### 7단계: 단일 exe 빌드

저장소 루트에서:

```powershell
cargo build --release --features bundle
```

처음 실행 시 수백 개의 Rust crate를 컴파일하므로 **수 분~수십 분** 소요된다(두 번째부터는 변경 부분만 빠르게).

### 8단계: 결과물 확인 및 이름 변경

```powershell
dir target\release\controller.exe
```

배포용으로 이름을 바꾼다:

```powershell
copy target\release\controller.exe handicap.exe
```

`handicap.exe` 한 파일만 다른 Windows PC에 복사하면 된다(의존 파일 없음).

### 9단계: 실행

`handicap.exe`를 더블클릭하거나 터미널에서 실행:

```powershell
.\handicap.exe
```

- 브라우저가 `http://localhost:<포트>`로 자동 오픈된다.
- 포트 8080이 다른 프로그램이 쓰고 있으면 OS가 빈 포트를 자동 배정한다.
- 브라우저 자동 오픈을 끄려면 `.\handicap.exe --no-open`

### 데이터 위치 (Windows)

- DB 파일: `%LOCALAPPDATA%\handicap\handicap.db`
  - 탐색기에서 주소창에 `%LOCALAPPDATA%\handicap` 입력
- 백업 = 이 폴더 복사, 삭제 = 이 폴더 삭제

### 문제 해결

| 증상 | 원인 및 조치 |
|---|---|
| "Windows가 PC를 보호했습니다" (SmartScreen 경고) | 서명되지 않은 exe. "추가 정보" 클릭 → "실행" 버튼이 나타남 |
| 백신이 격리(Quarantine) | 사내 백신에서 `handicap.exe` 제외(allowlist) 처리 |
| "Windows 방화벽에서 일부 기능이 차단됨" 프롬프트 | `localhost`(내부 루프백)만 쓰므로 "액세스 허용" 클릭 — 외부 네트워크 포트는 열지 않아도 됨 |
| 브라우저가 안 열림 | 기본 브라우저가 설정돼 있지 않을 때. 수동으로 `http://localhost:8080` 접속(포트는 터미널 로그 확인) |
| `error: linker 'link.exe' not found` | 1단계(C++ 빌드 도구)가 누락됨. Visual Studio Build Tools 재설치 |
| `protoc: command not found` | 3단계(protoc) 설치 또는 PATH 설정 재확인. 터미널 재시작 필요 |

---

## (선택) CI 부록 — GitHub Actions 예시

> **이 저장소는 remote가 설정돼 있지 않아 지금은 동작하지 않는다.** GitHub에 푸시하면 사용할 수 있는 **참고용 YAML**이다.

```yaml
name: Windows single-exe

on:
  push:
    branches: [master]
  workflow_dispatch:

jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install pnpm
        run: npm install -g pnpm

      - name: Install UI deps and build
        run: |
          pnpm -C ui install
          pnpm -C ui build

      - name: Install protoc
        uses: arduino/setup-protoc@v3
        with:
          version: '29.x'
          repo-token: ${{ secrets.GITHUB_TOKEN }}

      - name: Setup Rust (stable-msvc)
        uses: dtolnay/rust-toolchain@stable
        with:
          toolchain: stable-x86_64-pc-windows-msvc

      - name: Build single exe
        run: cargo build --release --features bundle

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: handicap-windows-exe
          path: target\release\controller.exe
```

---

## 한계 및 후속 방향

- **단일 워커**: 이 모드는 컨트롤러와 워커가 같은 프로세스 그룹에서 돌아 **라이트 부하**에 적합하다. 본격 고부하·멀티워커 fan-out은 K8s 경로(ADR-0027)를 사용한다.
- **exe 서명 없음**: SmartScreen/백신 경고가 뜬다. 서명·인스톨러는 ADR-0039 옵션 B(Tauri 래퍼) 후속으로 검토 예정.
- **Windows 크로스컴파일 미지원**: macOS에서 Windows `.exe`를 크로스컴파일하면 `ring` 같은 네이티브 crate가 MSVC 링커를 요구해 복잡하다. Windows 머신에서 직접 빌드하는 것을 권장한다.

# 핸디캡(Handicap) 데스크톱 앱 — Windows 아주 쉬운 매뉴얼 🪟

> 컴퓨터를 잘 몰라도 **그대로 따라 하면** 되도록 만든 안내서예요. 어려운 말은 최대한 풀어 썼어요.
> 개발자용 짧은 버전은 [`tauri-desktop-build.md`](tauri-desktop-build.md)에 있어요(이 문서가 그걸 쉽게 푼 버전).

---

## 0. 딱 3줄 먼저 읽어요

1. 이 앱은 **두 단계**예요 — ① **만들기(빌드)**: 설치 파일을 *한 번* 만드는 일(조금 어려움) → ② **쓰기**: 그 설치 파일을 더블클릭해서 쓰는 일(아주 쉬움).
2. **컴퓨터를 잘 모르면 [2부(쓰기)](#2부-앱-쓰기-누구나-할-수-있어요)만** 보면 돼요. 누군가 이미 만들어 준 `Handicap_...-setup.exe` 파일만 있으면 끝이에요.
3. [1부(만들기)](#1부-앱-만들기-한-명이-한-번만-하면-돼요)는 프로그램 몇 개를 깔아야 해요. **한 번만** 깔면 다음부터는 안 깔아도 돼요.

> 💡 한 사람이 1부로 설치 파일을 **한 번** 만들고, 그 파일을 USB나 메신저로 나눠 주면, 나머지 사람들은 모두 2부만 하면 돼요.

---

## 1부. 앱 만들기 (한 명이 한 번만 하면 돼요)

여기서는 "설치 파일(`...-setup.exe`)"을 만들어요. 프로그램 5개를 깔고, 명령어 4줄을 복사해서 붙여넣으면 끝나요.

### 1-1. "터미널" 여는 법 (명령어 입력하는 검은 창)

명령어는 **터미널**(또는 **PowerShell**)이라는 창에 입력해요.

1. 키보드 왼쪽 아래 **⊞ Windows 키**를 눌러요.
2. `terminal` 또는 `powershell`이라고 입력해요.
3. **Windows Terminal**(또는 **Windows PowerShell**)을 클릭해서 열어요.
4. 까만(또는 파란) 창이 뜨면 성공! 여기에 아래 명령어들을 **복사 → 붙여넣기(Ctrl+V) → Enter** 하면 돼요.

> 💡 붙여넣기는 마우스 오른쪽 클릭 또는 `Ctrl+V`예요.

### 1-2. 준비물 5개 설치하기

아래 5개를 순서대로 깔아요. 각 단계 끝에 **"확인"** 명령어가 있어요 — 버전 숫자가 나오면 성공이에요.

#### ① Rust (앱의 엔진을 만드는 도구) + C++ 빌드 도구

1. 인터넷 창에서 **https://rustup.rs** 에 들어가요.
2. **`rustup-init.exe`** 를 내려받아 실행해요.
3. 검은 창이 뜨면서 **"Visual Studio C++ Build tools"가 필요하다**고 물어볼 수 있어요 → **`y`(예)** 를 눌러 같이 설치하게 두세요. (이게 Windows에서 프로그램을 만들 때 꼭 필요한 부품이에요.)
   - 만약 그냥 넘어갔다면, 따로 **"Visual Studio Build Tools"** 를 설치하고 설치 화면에서 **"C++를 사용한 데스크톱 개발"** 에 체크하세요.
4. 그 다음 화면에서 그냥 **`1`(기본값)** 을 누르고 Enter → 설치가 끝날 때까지 기다려요.
5. **터미널을 닫았다가 다시 열고** 확인해요:

```powershell
rustc --version
```

✅ `rustc 1.xx.x ...` 처럼 나오면 성공.

#### ② Node.js (화면[UI]을 만드는 도구) + pnpm

1. **https://nodejs.org** 에 들어가서 **LTS**(왼쪽, 안정 버전) 설치 파일을 내려받아 실행해요. (계속 "다음" 누르면 돼요.)
2. **터미널을 다시 열고** pnpm을 켜요:

```powershell
corepack enable pnpm
```

3. 확인:

```powershell
node --version
pnpm --version
```

✅ 둘 다 버전 숫자가 나오면 성공. (`pnpm`이 "없는 명령어"라고 하면 위 `corepack enable pnpm`을 다시 해 보세요.)

#### ③ protoc (앱 부품을 만드는 데 필요한 작은 도구)

가장 쉬운 방법(Windows 10/11에 들어 있는 **winget** 사용):

```powershell
winget install protobuf
```

> "찾을 수 없어요"가 나오면 **직접 받기**로 하세요:
> 1. **https://github.com/protocolbuffers/protobuf/releases** 에 들어가서 `protoc-XX.X-win64.zip` 을 내려받아요.
> 2. 압축을 풀고, 그 안의 **`bin`** 폴더 위치를 복사해요 (예: `C:\protoc\bin`).
> 3. ⊞ Windows 키 → `환경 변수` 검색 → **"시스템 환경 변수 편집"** → **"환경 변수"** 버튼 → 위쪽 목록에서 **`Path`** 선택 → **"편집"** → **"새로 만들기"** → 위에서 복사한 `bin` 폴더 경로 붙여넣기 → **확인**.
> 4. 터미널을 새로 열어요.

확인:

```powershell
protoc --version
```

✅ `libprotoc 3.xx.x` 처럼 나오면 성공.

#### ④ Tauri CLI (창[데스크톱] 앱을 포장하는 도구)

터미널에 그대로:

```powershell
cargo install tauri-cli --version "^2" --locked
```

> ⏳ 몇 분 걸려요. 끝날 때까지 기다리세요.

확인:

```powershell
cargo tauri --version
```

✅ `tauri-cli 2.x.x` 처럼 나오면 성공.

#### ⑤ WebView2 (앱 화면을 그리는 부품) — 보통 이미 있어요

최신 Windows 10/11에는 **이미 들어 있어요**. 없으면 앱 설치할 때 자동으로 깔리니 보통 신경 안 써도 돼요. (정 안 되면 Microsoft에서 "WebView2 Runtime"을 검색해 설치.)

### 1-3. 소스 코드(앱 재료) 준비하기

회사에서 받은 **`handicap` 폴더 전체**를 이 Windows PC로 복사하세요 (USB·네트워크 공유 등). 폴더 안에 `ui`, `desktop`, `crates`, `Cargo.toml` 같은 것들이 보이면 맞아요.

터미널에서 그 폴더로 **이동(cd)** 해요. 예를 들어 폴더가 `C:\work\handicap`에 있다면:

```powershell
cd C:\work\handicap
```

> 💡 "cd"는 "그 폴더로 들어가기"라는 뜻이에요. 경로는 본인 PC에 맞게 바꾸세요.

### 1-4. 앱 만들기 — 명령어 4줄 (복사해서 차례대로)

아래를 **한 줄씩** 복사해 붙여넣고 Enter 하세요. (`handicap` 폴더 안에서 실행해야 해요.)

```powershell
# 1) 화면(UI) 준비
pnpm --dir ui install
pnpm --dir ui build
```

```powershell
# 2) 엔진(controller) 만들기  ⏳ 처음엔 10~30분 걸릴 수 있어요. 글자가 멈춘 듯해도 일하는 중이에요!
cargo build -p handicap-controller --bin controller --features bundle --release
```

```powershell
# 3) 만든 엔진을 데스크톱 폴더로 복사  (★ 이 줄을 빼먹으면 4번에서 오류 나요)
copy target\release\controller.exe desktop\src-tauri\binaries\controller-x86_64-pc-windows-msvc.exe
```

```powershell
# 4) 데스크톱 앱(설치 파일) 만들기
cd desktop
cargo tauri build
```

✅ 끝나면 이런 메시지가 보여요: `Finished` / `Bundling ...`.

### 1-5. 만들어진 설치 파일 찾기

`handicap\desktop\src-tauri\target\release\bundle\` 폴더 안에 있어요:

- **`nsis\Handicap_0.1.0_x64-setup.exe`** ← **이게 사람들에게 나눠 줄 설치 파일이에요** (제일 쉬움, 추천)
- `msi\Handicap_0.1.0_x64_en-US.msi` ← 회사 정책상 MSI가 필요하면 이걸 써요

이 `...-setup.exe` 파일을 USB나 메신저로 다른 사람에게 주면, 그 사람은 [2부](#2부-앱-쓰기-누구나-할-수-있어요)만 하면 돼요. 🎉

---

## 2부. 앱 쓰기 (누구나 할 수 있어요)

### 2-1. 설치하기

1. 받은 **`Handicap_...-setup.exe`** 파일을 **더블클릭**해요.
2. **"Windows의 PC를 보호했습니다"** 라는 파란 경고가 뜰 수 있어요. (도장[서명]이 안 찍힌 앱이라 그래요 — 우리가 직접 만든 거라 괜찮아요.)
   - **"추가 정보"** 글자를 클릭 → 아래에 생긴 **"실행"** 버튼을 클릭하면 돼요.
3. 설치 창이 뜨면 **"Next / 다음"** 을 눌러 진행하고 **"Finish / 완료"** 를 눌러요.

### 2-2. 실행하기

1. ⊞ Windows 키를 누르고 **`Handicap`** 이라고 입력해요.
2. **Handicap** 아이콘을 클릭해요. (바탕화면에 아이콘이 생겼으면 그걸 더블클릭해도 돼요.)
3. 창이 뜨면서 잠깐 **"핸디캡 시작 중…"** 이 보였다가, 곧 **핸디캡 화면**으로 바뀌면 성공! ✅

### 2-3. 닫기

창을 **그냥 닫으면(X)** 돼요. 뒤에서 돌던 엔진(controller)도 **자동으로 같이 꺼져요**. 따로 정리할 필요 없어요.

> ⚠️ 혹시 닫은 뒤에도 느려진 느낌이면, **작업 관리자**(Ctrl+Shift+Esc)에서 `controller` 또는 `worker`가 남아 있는지 보고, 있으면 **"작업 끝내기"** 로 종료하세요. (이번 버전에서 Windows 자동 종료는 아직 최종 점검 전이라, 드물게 남을 수 있어요.)

---

## 3부. 안 될 때 — 자주 나오는 문제와 해결 🔧

| 화면에 이런 말이 나오면 | 뜻 | 해결 |
|---|---|---|
| `'rustc'/'cargo' 은(는) ... 인식되지 않습니다` | Rust가 없거나 터미널이 옛날 상태 | Rust 설치(①) 후 **터미널을 새로 열기** |
| `link.exe not found` / `linker ... not found` | C++ 빌드 도구가 없음 | ①에서 **Visual Studio C++ Build Tools** 설치 |
| `Could not find protoc` / `'protoc' ... 없음` | protoc가 없거나 경로 등록 안 됨 | ③ 다시 하기 + 터미널 새로 열기 |
| `'pnpm' ... 없음` | pnpm이 안 켜짐 | ②의 `corepack enable pnpm` 다시 |
| `no such command: tauri` | Tauri CLI가 없음 | ④의 `cargo install tauri-cli ...` 다시 |
| 4번에서 `binaries/controller... 없음` 류 오류 | **3번 복사를 빼먹음** | 3번(`copy ...controller.exe ...`)을 먼저 실행하고 4번 다시 |
| 앱은 떴는데 **"시작 실패"** 가 보임 | 엔진이 안 켜짐(방화벽·백신이 막았을 수 있음) | Windows 방화벽/백신에서 **Handicap / controller 허용**, 그래도 안 되면 PC 재시작 후 다시 |
| 설치할 때 파란 경고 | 서명이 없는 앱이라 정상 | 2-1의 **"추가 정보 → 실행"** |

> 그래도 안 되면, 화면에 나온 **빨간 글자(오류 메시지)** 를 그대로 복사해서 만든 사람(개발자)에게 보내 주세요. 그게 가장 빠른 해결이에요.

---

## 4부. 자주 묻는 질문 ❓

- **인터넷이 꼭 필요한가요?** — *만들 때(1부)* 만 필요해요(프로그램 내려받기 때문). *쓸 때(2부)* 는 인터넷 없어도 돼요(내 PC 안에서만 도니까요).
- **관리자 권한이 필요한가요?** — 설치할 때 한 번 물어볼 수 있어요. "예"를 누르면 돼요.
- **한 번 만든 설치 파일을 여러 PC에 써도 되나요?** — 네! 같은 `...-setup.exe`를 여러 명이 설치해서 쓸 수 있어요.
- **버전을 새로 받으면?** — 새 `...-setup.exe`를 다시 더블클릭해서 설치하면 덮어써져요.
- **이 앱이 뭐예요?** — REST API에 부하(여러 번 요청)를 보내 성능을 시험하는 도구예요. K8s(쿠버네티스) 없이, 내 Windows PC 하나로 가볍게 돌리는 형태예요.

---

### 📌 한 장 요약 (만드는 사람용 치트시트)

```powershell
# 준비물(한 번만): Rust(+C++) · Node+pnpm · protoc · cargo install tauri-cli --version "^2"
cd C:\work\handicap            # 소스 폴더로 이동
pnpm --dir ui install
pnpm --dir ui build
cargo build -p handicap-controller --bin controller --features bundle --release
copy target\release\controller.exe desktop\src-tauri\binaries\controller-x86_64-pc-windows-msvc.exe
cd desktop
cargo tauri build
# 결과: desktop\src-tauri\target\release\bundle\nsis\Handicap_0.1.0_x64-setup.exe
```

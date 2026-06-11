# RHEL 설치·실행 매뉴얼

다른 RHEL 머신에서 Handicap을 처음부터 빌드·실행하는 절차. 대상은 **RHEL 10.x**(및 CentOS Stream 10, Rocky/Alma 10 등 동일 계열).

> RHEL 10 특이사항 두 가지: ① 패키지 매니저가 **dnf5**(`dnf` 명령은 그대로 호환), ② **DNF modularity(AppStream 모듈)가 제거**됨 — RHEL 9의 `dnf module enable nodejs:20` 같은 방식이 사라지고 Node.js는 일반 패키지로 직접 설치한다(기본 Node 22, 요구사항 ≥20 충족).

요약하면 빌드에 필요한 건 네 가지다:
- **Rust** stable (edition 2024 / MSRV 1.85) — `rust-toolchain.toml`이 채널·컴포넌트 고정
- **protoc** (protobuf 컴파일러) — `crates/proto/build.rs`의 tonic-build가 빌드 타임에 사용 (필수)
- **C 빌드 도구**(gcc/make) — rustls의 `ring`, sqlx의 bundled SQLite 빌드용 (OpenSSL dev는 **불필요** — TLS는 전부 rustls)
- **Node ≥20 + pnpm ≥9** — UI 빌드/실행 시에만

---

## 1. 코드 가져오기 (git remote 없음)

이 repo는 **remote가 설정돼 있지 않다**(로컬 통합 브랜치 `master`, `main` 아님). `git clone <url>`이 안 되므로 **git bundle**로 히스토리째 옮기는 게 가장 깔끔하다.

**소스 머신(현재 개발 머신)에서:**
```bash
cd /path/to/handicap
git bundle create /tmp/handicap.bundle --all
scp /tmp/handicap.bundle <user>@<rhel-host>:~/
```

**RHEL 머신에서:**
```bash
git clone ~/handicap.bundle handicap
cd handicap
git checkout master      # 통합 브랜치는 master
```

> `target/`, `ui/node_modules`, `*.db`는 옮기지 않는다 — 머신에서 새로 빌드한다. bundle은 git이 추적하는 파일만 담으므로 자동으로 제외된다. (사내 git 서버가 있으면 거기에 push 후 clone해도 된다.)

---

## 2. 시스템 패키지 (dnf)

### 2.1 C 빌드 도구 + pkg-config + git

dnf5에서는 그룹 설치 구문(`group install`)이 다소 까다로워, 필요한 패키지를 직접 지정하는 게 가장 확실하다:
```bash
sudo dnf install -y gcc gcc-c++ make pkgconf-pkg-config curl git
# (또는 그룹으로: sudo dnf group install -y "Development Tools")
```

### 2.2 protoc (protobuf 컴파일러) — 필수

RHEL에서 `protobuf-compiler`는 기본 리포(AppStream)에 **없고 EPEL에 있다.** 먼저 CRB + EPEL(버전 10)을 켜고 설치한다.

```bash
# CRB(CodeReady Builder) — EPEL 패키지들의 빌드 의존성이 여기 있다
sudo subscription-manager repos --enable "codeready-builder-for-rhel-10-$(arch)-rpms"
# Rocky/Alma 10 등 비구독 계열은 위 대신:  sudo dnf config-manager --set-enabled crb

# EPEL 10
sudo dnf install -y "https://dl.fedoraproject.org/pub/epel/epel-release-latest-10.noarch.rpm"

# protoc 설치
sudo dnf install -y protobuf-compiler
protoc --version
```

**EPEL을 못 쓰는 폐쇄망/오프라인이면 GitHub 릴리스 바이너리로 설치**(리포 의존 없음):
```bash
PB=29.3   # 임의의 최신 릴리스
curl -LO "https://github.com/protocolbuffers/protobuf/releases/download/v${PB}/protoc-${PB}-linux-x86_64.zip"
sudo dnf install -y unzip
sudo unzip -o "protoc-${PB}-linux-x86_64.zip" -d /usr/local   # /usr/local/bin/protoc, /usr/local/include/*
protoc --version
```

### 2.3 Rust toolchain (rustup)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
  --default-toolchain stable --component rustfmt --component clippy
. "$HOME/.cargo/env"
```
`rust-toolchain.toml`이 stable + rustfmt + clippy를 고정하므로, 이후 `cargo` 호출만으로 올바른 toolchain을 잡는다.

### 2.4 just (태스크 러너)

`just`는 RHEL 기본 리포에 보통 없다. cargo로 설치하는 게 가장 확실하다:
```bash
cargo install just
```

### 2.5 Node ≥20 + pnpm ≥9 (UI용)

**방법 A — dnf 직접 설치 (RHEL 10 권장):** RHEL 10은 모듈이 없어졌고 Node.js를 일반 패키지로 직접 설치한다(기본 Node 22, 요구사항 ≥20 충족).
```bash
sudo dnf install -y nodejs npm
node -v                          # v22.x 확인

# pnpm 설치 — RHEL의 nodejs RPM은 corepack을 번들하지 않는 경우가 많아 npm으로 직접 설치
sudo npm install -g pnpm
pnpm -v                          # 버전이 뜨면 완료
```

> `corepack: command not found`는 RHEL에선 정상이다 — corepack은 **선택**이고, 위처럼 `npm install -g pnpm`으로 깔면 필요 없다. `pnpm -v`가 비면 PATH 문제이니 `npm prefix -g`의 `bin`이 PATH에 있는지 확인(`command -v pnpm`, 안 잡히면 `hash -r` 후 재시도).

**방법 B — nvm (sudo 없이, 버전 격리):**
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. "$HOME/.nvm/nvm.sh"
nvm install 20 && nvm use 20
corepack enable && corepack prepare pnpm@latest --activate
```

### 2.6 버전 확인

```bash
cargo --version && rustc --version && protoc --version && just --version && node -v && pnpm -v
```

---

## 3. 빌드 & 검증

```bash
cd handicap

# 백엔드 빌드 + lint + 테스트 (acceptance)
just build && just lint && just test
```

---

## 4. 로컬 실행

### 4.1 UI까지 한 번에 (운영에 가까운 형태)

```bash
# UI 의존성 설치 (최초 1회)
just ui-install                 # = cd ui && pnpm install --frozen-lockfile

# 워커 바이너리 빌드 — 필수!
#   controller가 target/debug/worker 를 subprocess로 spawn한다.
#   cargo run -p handicap-controller 는 controller만 빌드하고 worker는 안 건드린다.
cargo build -p handicap-worker

# UI 빌드 + UI를 정적 서빙하는 controller 실행
just run-controller-with-ui
```
브라우저에서 **http://127.0.0.1:8080/** → 시나리오 생성·run·리포트 확인.

### 4.2 UI 핫리로드 dev 모드 (UI 자주 만질 때)

터미널 두 개:
```bash
# 터미널 1 — controller (UI dev 서버가 /api 를 :8080 으로 프록시)
cargo run -p handicap-controller --bin controller -- \
  --db ./handicap.db --worker-bin target/debug/worker

# 터미널 2 — Vite dev (:5173)
just ui-dev
```
→ http://127.0.0.1:5173/

> **`--bin controller`를 꼭 붙인다.** `handicap-controller` 패키지엔 바이너리가 둘(`controller` + `e2e_kind_driver`)이라, 생략하면 `error: could not determine which binary to run`. `just run-controller*` 레시피에는 이미 고정돼 있다.

---

## 5. (선택) kind / K8s 경로

매니페스트·배포 형상까지 테스트할 때만 필요하고 일상 dev엔 불필요하다. 추가로 **Docker, kind, helm, kubectl**이 필요하다.

```bash
just deploy-kind
kubectl -n handicap port-forward svc/handicap-handicap-controller 8080:8080
# 정리
just kind-down
# end-to-end 테스트
just e2e-kind
```
자세한 절차 → [slice-6-manual-check.md](slice-6-manual-check.md).

---

## 6. 트러블슈팅 (RHEL 특이사항 + 크로스커팅 footgun)

- **`protoc` 못 찾음 / 빌드 초기에 proto 관련 에러** → 2.2 다시. EPEL/CRB를 켜거나 GitHub 바이너리로 설치하고 `protoc --version` 확인.
- **`cargo run -p handicap-controller`가 "could not determine which binary to run"** → `--bin controller`를 추가한다(4.2 참고).
- **run이 영영 `running` + 요청수 0** → 대개 **워커 바이너리를 안 빌드/오래된 것**. `cargo build -p handicap-worker` 후 controller 로그에서 worker exit를 확인. (엔진/시나리오 모델이 바뀐 브랜치를 받은 뒤엔 worker 재빌드 필수.)
- **status=0 + 비정상적으로 높은 RPS** = HTTP 도달 전 실패(connection refused / URL parse / DNS). 시나리오 URL에 host가 있는지, 타겟이 살아있는지, env가 비어 `${BASE_URL}`이 unresolved인지 점검.
- **포트 선점(5173 / 8080)** → 다른 터미널/이전 프로세스가 살아있으면 stale 번들 서빙. `ss -ltnp | grep -E ':5173|:8080'`(RHEL은 `lsof` 대신 `ss`가 기본)로 PID 찾아 정리 후 재시작.
- **다른 호스트에서 UI에 접속하려는 경우** → controller/Vite는 기본 `127.0.0.1` 바인드라 로컬 전용이다. 원격 접속이 필요하면 바인드 주소를 `0.0.0.0`으로 바꾸고 firewalld에 포트를 연다: `sudo firewall-cmd --add-port=8080/tcp --permanent && sudo firewall-cmd --reload`. (사내 정책에 따라 SELinux도 고려.)

로컬 dev 진단은 `dev-doctor` 스킬로 자동화할 수 있다.

# RHEL 폐쇄망(air-gapped/DMZ) 설치·실행 매뉴얼

인터넷이 안 되는 폐쇄망(또는 패키지 미러만 있는 반(半)연결망)에 Handicap을 설치하는 절차. 일반 설치(인터넷 가능)는 [install-rhel.md](install-rhel.md) 참고 — 이 문서는 그걸 전제로 **차이나는 부분만** 다룬다.

> 핵심 결론 먼저: Handicap은 **Rust 바이너리 2개 + 정적 UI**라 런타임 풋프린트가 아주 작다. 폐쇄망 머신엔 **Rust·Node·protoc·cargo/npm 레지스트리가 전부 불필요**(모두 빌드타임 도구). 그래서 폐쇄망 설치의 정석은 **"연결된 머신에서 빌드 → 산출물만 반입"** 이다(§2). 정책상 폐쇄망 안에서 소스 빌드를 강제하는 경우만 오프라인 의존성을 동봉한다(§3·§4).

---

## 0. 먼저 — DMZ 인바운드 걱정은 거의 없음 (트래픽 방향)

부하 테스트 도구라 트래픽 방향이 "요청 송신은 자유, 수신(인바운드) 설정은 어렵다"는 제약과 **정확히 맞는다.**

| 트래픽 | 방향 | 외부 인바운드 필요? | 비고 |
|---|---|---|---|
| **부하 트래픽** (엔진/워커 → 타겟 API) | 아웃바운드 | ❌ | 도구가 하는 일 그 자체 |
| **워커 → 컨트롤러 gRPC** | 워커가 **다이얼**(client) | ❌ | subprocess 모드는 같은 호스트 loopback(`127.0.0.1:8081`), K8s 모드는 클러스터 내부 |
| **브라우저 → 컨트롤러 :8080** (웹 콘솔) | 인바운드 | ⚠️ 유일 | SSH 터널로 우회 가능 |

근거(코드):
- 워커가 gRPC **클라이언트**다 — `crates/worker-core/src/client.rs`의 `Channel::from_shared(controller_url).connect()`. 연결을 *거는* 쪽이 워커이므로 워커에 인바운드 포트를 열 필요가 없다.
- 컨트롤러 기본 바인드는 **둘 다 loopback** — REST `127.0.0.1:8080`, gRPC `127.0.0.1:8081`(`crates/controller/src/main.rs`). 기본값으로 두면 외부에 노출조차 안 된다.
- TLS는 전부 **rustls**(`reqwest`/`kube` 모두 `rustls-tls`, openssl 미사용) — 런타임 OpenSSL 동적 의존 없음.

**웹 콘솔 접근은 인바운드 방화벽을 열지 말고 SSH 로컬 포워딩으로** (운영 머신에 이미 열려 있을 SSH만 사용):
```bash
# 로컬 PC에서
ssh -L 8080:127.0.0.1:8080 <user>@<dmz-host>
# 브라우저: http://127.0.0.1:8080
```
컨트롤러를 기본값(`127.0.0.1` 바인드)으로 띄우면 8080 인바운드 룰이 **전혀 불필요**하다. 굳이 직접 노출해야 하면 그때만 `--rest 0.0.0.0:8080` + `firewall-cmd --add-port=8080/tcp`.

---

## 1. 설치 전략 결정

| 경로 | 언제 | 폐쇄망에 필요한 것 | 난이도 |
|---|---|---|---|
| **§2 빌드 머신 → 산출물 반입** (권장) | 같은 RHEL major/arch의 인터넷 연결 머신이 하나라도 있을 때 | **바이너리 2개 + ui-dist만** (Rust·Node·protoc 전부 불필요) | ★ 가장 쉬움 |
| **§3 사내 미러로 폐쇄망 빌드** | Nexus/Artifactory/Satellite 같은 사내 미러가 있을 때 | 툴체인 + 미러 설정 | ★★ |
| **§4 완전 오프라인 소스 빌드** | 연결 머신·미러 모두 없고, 정책상 in-place 빌드 강제 | 툴체인 + vendor + pnpm store 전부 동봉 | ★★★ |

배포 형태와 무관하게(VM 바이너리든 K8s든) 위 셋 중 하나로 **산출물/이미지**를 만든다. 배포는 §5(VM)·§6(K8s).

---

## 2. (권장) 연결된 빌드 머신에서 빌드 → 산출물 반입

### 2.1 빌드 (인터넷 연결된 RHEL 머신)

[install-rhel.md](install-rhel.md) §2의 툴체인 설치 후, **release** 빌드 + UI 빌드:
```bash
cd handicap
cargo build --release -p handicap-controller --bin controller
cargo build --release -p handicap-worker     --bin worker
just ui-install && just ui-build        # = pnpm install --frozen-lockfile && pnpm build → ui/dist
```

> 빌드 머신은 **타겟과 같은 RHEL major + 같은 CPU arch**가 가장 안전하다(아래 2.4 이식 주의).

### 2.2 반입 — 옮길 건 딱 3개

```
target/release/controller     # 컨트롤러 바이너리
target/release/worker          # 워커 바이너리 (컨트롤러가 subprocess로 spawn)
ui/dist/                       # 정적 UI (pnpm build 결과)
```
폐쇄망 머신엔 **소스도, 마이그레이션 .sql도 필요 없다** — 마이그레이션은 `include_str!`로 바이너리에 임베드돼 첫 실행 시 자동 적용된다(`crates/controller/src/store/mod.rs`). DB(`handicap.db`)는 첫 실행에서 자동 생성된다.

매체 반입 예 — 스테이징 후 한 tar로 (§2.3 배치와 동일하게):
```bash
# 빌드 머신, repo 루트에서
mkdir -p out
cp target/release/controller target/release/worker out/
cp -r ui/dist out/ui-dist
tar czf handicap-dist.tgz -C out .     # out/{controller,worker,ui-dist/}
```

### 2.3 실행 (폐쇄망 머신, 단일 VM)

반입한 파일을 한 디렉터리에 풀고:
```bash
mkdir -p /opt/handicap /var/lib/handicap
# controller, worker, ui-dist/ 를 /opt/handicap 아래 배치

/opt/handicap/controller \
  --db /var/lib/handicap/handicap.db \      # 첫 실행 시 자동 생성·마이그레이션
  --worker-bin /opt/handicap/worker \       # 컨트롤러가 이 바이너리를 spawn (기본 worker-mode=subprocess)
  --ui-dir /opt/handicap/ui-dist \
  --rest 127.0.0.1:8080                      # 기본값. 외부 노출 대신 §0 SSH 터널로 접근
```
브라우저(또는 SSH 터널)로 `http://127.0.0.1:8080/` → 시나리오 생성·run·리포트.

> systemd 서비스로 상주시키려면 위 명령을 `ExecStart`로 감싸고 `WorkingDirectory=/opt/handicap`, 전용 유저로 돌린다. DB 디렉터리만 쓰기 권한이 있으면 된다.

### 2.4 바이너리 이식 주의

- **CPU arch 일치**: x86_64 ↔ x86_64, aarch64 ↔ aarch64.
- **glibc 호환**: RHEL 10에 올릴 거면 RHEL 10(또는 더 낮은 RHEL)에서 빌드한다. *낮은→높은*은 forward-compat로 동작하지만 *높은→낮은*(예: RHEL 10에서 빌드해 RHEL 9에 반입)은 `GLIBC_x.xx not found`로 깨진다. 같은 major면 안전.
- **OpenSSL 불필요**: rustls라 런타임에 `libssl`/`libcrypto` 동적 의존이 없다 → 폐쇄망에 OpenSSL dev/런타임을 따로 안 깔아도 된다.
- arch/glibc가 완전히 다른 환경이면 정적 musl 빌드(`rustup target add x86_64-unknown-linux-musl` → `cargo build --release --target x86_64-unknown-linux-musl`)로 glibc 의존을 제거할 수 있으나, 같은 RHEL major면 불필요하다.

---

## 3. (대안 A) 사내 미러로 폐쇄망에서 빌드

Nexus/Artifactory/Satellite 등 사내 미러가 있으면 폐쇄망에서도 평소처럼 빌드된다 — 각 패키지 매니저를 미러로 돌리기만 하면 된다.

- **dnf**: `/etc/yum.repos.d/`의 `baseurl`을 사내 미러로. CRB/EPEL 대신 protoc는 §install-rhel §2.2 GitHub zip 방식이 더 간단할 수 있다.
- **cargo (crates.io)**: `~/.cargo/config.toml`
  ```toml
  [source.crates-io]
  replace-with = "internal"
  [source.internal]
  registry = "sparse+https://<nexus-host>/repository/cargo/"
  ```
- **rustup 툴체인**: `export RUSTUP_DIST_SERVER=https://<mirror>/rust-static` `RUSTUP_UPDATE_ROOT=https://<mirror>/rustup`
- **pnpm/npm**: `ui/.npmrc`에 `registry=https://<nexus-host>/repository/npm/`

이후는 [install-rhel.md](install-rhel.md) §2~§4 그대로.

---

## 4. (대안 B) 완전 오프라인 소스 빌드 (vendor 동봉)

연결 머신·미러 모두 없고 폐쇄망 안에서 소스로 빌드해야 할 때. **연결된 머신에서 의존성을 미리 받아 동봉**한다.

### 4.1 소스 반입 (git bundle)
[install-rhel.md](install-rhel.md) §1의 `git bundle` 방식 그대로 (remote 없음).

### 4.2 시스템 패키지(RPM) 오프라인
연결된 동일-RHEL 머신에서:
```bash
dnf download --resolve --alldeps --destdir ./rpms \
  gcc gcc-c++ make pkgconf-pkg-config unzip
```
폐쇄망에서:
```bash
sudo dnf install --disablerepo='*' ./rpms/*.rpm
```

### 4.3 Rust 툴체인 오프라인
가장 간단한 방법은 연결 머신의 `~/.rustup` + `~/.cargo`를 통째로 옮기는 것:
```bash
# 연결 머신
tar czf rust-toolchain.tgz -C "$HOME" .rustup .cargo
# 폐쇄망
tar xzf rust-toolchain.tgz -C "$HOME"
. "$HOME/.cargo/env"      # PATH에 ~/.cargo/bin 추가
```
> 빌드 머신의 `~/.cargo/config.toml`에 사내 미러(`replace-with`) 설정이 남아 있으면 §4.5의 repo-로컬 vendor redirect를 가린다 — 반입 후 `~/.cargo/config.toml`에 `[source.*]` 블록이 있는지 확인하고 있으면 제거한다(툴체인은 `~/.cargo/bin` + `~/.rustup`만 있으면 동작).

### 4.4 protoc 오프라인
[install-rhel.md](install-rhel.md) §2.2의 **GitHub 릴리스 zip** 경로(리포 의존 0). zip을 반입해 `/usr/local`에 풀면 끝.

### 4.5 cargo 크레이트 vendoring

> 전제: §4.4 protoc 반입이 끝나 있어야 한다 — `crates/proto/build.rs`(tonic-build)가 **빌드 타임에 system protoc를 호출**하며, protoc는 크레이트가 아니라 시스템 바이너리라 `cargo vendor`로 동봉되지 않는다.

연결 머신, repo 루트에서:
```bash
mkdir -p .cargo
cargo vendor --locked vendor >> .cargo/config.toml   # 출력된 [source.*] 블록이 crates.io를 vendor/로 치환
```
`vendor/` 디렉터리와 `.cargo/config.toml`을 repo와 함께 반입. 폐쇄망에서:
```bash
cargo build --release --offline -p handicap-controller --bin controller
cargo build --release --offline -p handicap-worker     --bin worker
```

### 4.6 UI 오프라인
가장 쉬운 길은 **연결 머신에서 `ui/dist`만 빌드해 반입**(§2.2와 동일) — 그러면 폐쇄망에 Node가 아예 필요 없다. 폐쇄망에서 UI를 직접 빌드해야 한다면:
```bash
# 연결 머신: 락파일 기준으로 store만 채움
cd ui && pnpm fetch
# 폐쇄망: 오프라인 설치 후 빌드 (Node ≥20 필요 — install-rhel §2.5)
cd ui && pnpm install --offline --frozen-lockfile && pnpm build
```

> `just`는 선택이다 — `Justfile`은 얇은 래퍼라 위처럼 raw `cargo`/`pnpm` 명령을 직접 써도 된다. 굳이 쓰려면 §4.5 vendor에 포함되거나 연결 머신에서 `cargo install just` 후 바이너리만 반입.

---

## 5. 배포 — 단일 VM (바이너리)

§2.3 또는 §4의 빌드 결과를 그대로 실행. 워커는 컨트롤러가 subprocess로 spawn하므로 별도 프로세스를 띄울 필요 없다(기본 `--worker-mode subprocess`). 콘솔 접근은 §0 SSH 터널.

---

## 6. (선택) 배포 — K8s (Helm)

이미지를 사내 레지스트리로 반입한 뒤 Helm으로 배포한다.

### 6.1 이미지 반입
```bash
# 연결 머신에서 빌드(단일 이미지·2 바이너리) 후 저장
docker save handicap:<tag> -o handicap-image.tar
# 폐쇄망 노드/레지스트리에서
docker load -i handicap-image.tar
docker tag handicap:<tag> <internal-registry>/handicap:<tag>
docker push <internal-registry>/handicap:<tag>
```

### 6.2 Helm values 오버라이드
`deploy/helm/handicap/values.yaml` 기준:
```yaml
image:
  repository: <internal-registry>/handicap   # 기본 handicap → 사내 레지스트리
  tag: <tag>
  pullPolicy: IfNotPresent                    # 폐쇄망 필수 — Always면 외부 pull 시도
worker:
  image: ""                                   # 비우면 컨트롤러와 동일 이미지 사용(단일 이미지)
```
```bash
just deploy-kind        # 또는 helm upgrade --install ... -f values.yaml
kubectl -n handicap port-forward svc/handicap-handicap-controller 8080:8080
```
워커는 컨트롤러가 K8s Indexed Job으로 띄우고, Job Pod가 컨트롤러 gRPC로 **다이얼백**한다(`--controller-grpc-url`, Helm이 클러스터 내부 주소로 설정). 외부 인바운드 불필요.

---

## 7. 트러블슈팅 (폐쇄망 특이)

- **`GLIBC_x.xx not found` / `version ... not found`** → 빌드 머신 glibc가 타겟보다 높음. 같은(또는 더 낮은) RHEL major에서 재빌드하거나 musl 정적 빌드(§2.4).
- **`cargo build`가 crates.io에 접속 시도** → §4.5 vendor 누락 또는 `--offline` 빠짐. `.cargo/config.toml`의 `[source.crates-io] replace-with`와 `vendor/` 동봉 확인 후 `--offline`.
- **`pnpm install`이 레지스트리 접속 시도** → `--offline` 빠졌거나 store 미동봉. §4.6대로 `pnpm fetch`로 store를 채워 반입하거나, 아예 `ui/dist`만 반입(권장).
- **K8s Pod가 `ImagePullBackOff`** → `pullPolicy`가 `Always`이거나 `image.repository`가 외부. §6.2대로 `IfNotPresent` + 사내 레지스트리.
- **콘솔이 외부에서 안 열림** → 의도된 동작(기본 `127.0.0.1` 바인드). §0 SSH 터널을 쓰거나, 정말 노출이 필요하면 `--rest 0.0.0.0:8080` + firewalld.
- 그 외 공통 footgun(워커 미빌드로 run이 `running`+0req, `--bin controller` 누락, 포트 선점 등) → [install-rhel.md](install-rhel.md) §6.

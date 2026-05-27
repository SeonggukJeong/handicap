# Handicap

사내 QA·운영팀을 위한 부하 테스트 도구. REST API를 대상으로, **QA는 드래그-드롭으로 시나리오를 만들고**, **개발자는 같은 시나리오를 YAML/DSL로 편집** 한다 (두 뷰가 같은 모델의 양방향 sync). LoadRunner/JMeter를 사내에서 대체하는 것이 목표.

**상태: Slice 1(backend skeleton) 구현 완료.** 디자인 문서 → `docs/superpowers/specs/`. 구현 계획 → `docs/superpowers/plans/`. 결정 기록 → `docs/adr/`.

Slice 1 결과: REST API(`/scenarios`, `/runs`, `/runs/{id}/metrics`) + gRPC Coordinator(bidi stream) + SQLite store + subprocess-spawn worker가 wiremock 타겟에 대해 end-to-end 동작. UI·K8s·라이브 대시보드·ramp-up·multi-step은 후속 슬라이스.

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

# 슬라이스 1 acceptance
just build && just lint && just test     # 18 tests must pass
```

`rust-toolchain.toml`이 stable 채널을 고정하므로 `cargo` 호출만 해도 올바른 toolchain을 잡는다.

## 검증 자동화 (git pre-commit hook)

`.git/hooks/pre-commit`이 모든 커밋에 대해 `cargo fmt --check + cargo build --workspace + cargo test --workspace`를 실행한다 (워크스페이스가 coherent하지 않으면 per-crate 모드로 fallback). hook은 git common dir에 있어 모든 worktree에 적용된다. 새 머신에서는 `chmod +x .git/hooks/pre-commit`이 한 번 필요할 수 있다.

`--no-verify`로 hook 우회 금지 (사용자 명시 요청 없이는). 회귀가 생긴 채로 커밋이 들어가면 후속 작업이 모두 빨갛게 됨.

## 디렉토리 (MVP 계획)

```
crates/
  engine/        Rust 부하 생성 엔진 (라이브러리)
  controller/    Rust 바이너리, 워커 오케스트레이션, HTTP API 서빙
  worker/        Rust 바이너리, 컨트롤러 지시로 시나리오 실행
  proto/         gRPC 정의 (controller↔worker)
ui/              TypeScript/React 웹앱 (Vite + React Flow + Monaco)
deploy/
  helm/          K8s 배포용 Helm chart
  kind/          로컬 kind cluster 설정
docs/
  superpowers/specs/   설계 문서
  adr/                 결정 기록 (MADR 포맷)
```

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

## 코딩 컨벤션

- **Rust**: `cargo fmt`, `cargo clippy -- -D warnings`, 테스트 `cargo test`. workspace `members = ["crates/*"]` glob — 새 crate는 `crates/<name>/Cargo.toml`만 만들면 자동 인식.
- **TypeScript**: prettier + eslint, 테스트 vitest

## Slice 1에서 배운 함정들

- **axum 0.8 path syntax**: `/scenarios/:id` 아님, `/scenarios/{id}`. 0.7 문서/예제 검색하면 함정.
- **serde_yaml 0.9 + externally-tagged enum w/ map variants**: derive(Serialize, Deserialize)가 round-trip 안 됨. `Assertion::Status(u16)` 같은 enum은 손수 `Serialize`/`Deserialize` 구현해서 `{key: value}` 맵 형태로 처리. (`crates/engine/src/scenario.rs::Assertion` 참고.)
- **mpsc 플러셔 종료**: 워커 self-cloned `Sender`를 가진 flusher 태스크는 `is_closed()`로 종료 감지가 안 된다 (자기 자신이 살아있으니까). 메인 루프가 끝나면 `flusher.abort()` 후 `flusher.await.ok()`. (`crates/engine/src/runner.rs::run_scenario` 참고.)
- **tonic `Channel::from_shared` 오류 타입**: `tonic::transport::Error` 아니라 `tonic::codegen::http::uri::InvalidUri`. WorkerError에 따로 variant 필요.
- **tokio JoinHandle drop ≠ abort**: handle을 drop해도 spawn된 task는 detached로 계속 돈다. 종료시키려면 명시적으로 `.abort()`.

## 새로운 아키텍처 결정이 생기면

## 새로운 아키텍처 결정이 생기면

`docs/adr/`에 새 ADR 파일 추가 (다음 번호 사용, MADR 포맷). 이 CLAUDE.md의 "알아둘 결정들" 목록에도 한 줄 추가.

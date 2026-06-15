# 0039 — 라이트 Windows 데스크톱 배포: 단일 self-contained `.exe`(→ Tauri 옵션), Flutter/RN 거절

- Status: accepted (방향 확정 — 구현은 roadmap 후보, 미착수)
- Date: 2026-06-16

## Context

핸디캡의 1차 사용자는 사내 QA(ADR-0001)이고 배포 타깃은 사내 K8s(ADR-0006)다. 그러나
**"가볍게 쓰는 사람"**(K8s 없이 자기 Windows PC에서 소규모 스모크 테스트를 돌리고 싶은
운영자·기획자)을 위해 **Windows에서 쉽게 실행되는 데스크톱 형태**가 필요하다는 요구가 나왔다.
처음 제안은 Flutter / React Native 같은 크로스플랫폼 프레임워크였다.

현재 형상(루트 CLAUDE.md "한 줄 아키텍처"):

- UI = **React + TypeScript**, 핵심 부품이 **React Flow**(드래그-드롭 캔버스, ADR-0003),
  **Monaco**(YAML/DSL 에디터), **Zustand**(양방향 sync store, ADR-0015) — 전부 DOM/웹 기술.
- 엔진 = **Rust** controller + worker(ADR-0004). controller가 정적 UI를 서빙하고
  (`--ui-dir ui/dist`) HTTP API를 노출. 로컬 dev는 **subprocess 워커**로 돈다(ADR-0019).

즉 UI 자산이 이미 웹이고, 엔진이 이미 Rust 네이티브 바이너리로 빌드된다. Flutter(Dart)·
React Native(모바일·no-DOM)는 이 자산을 **버리고 다시 쓰게** 만든다 — React Flow/Monaco에
직접 대응물이 없다. 셸을 새로 고르기 전에, "이미 가진 것을 그대로 감싸는" 길을 택한다.

## Decision

### 권장 경로: 옵션 A(단일 self-contained `.exe`) → 필요 시 옵션 B(Tauri)

**옵션 A — 단일 self-contained Windows 실행 파일 (1차 목표, 프레임워크 없음).**

controller(+임베드 UI 에셋 + subprocess로 spawn하는 worker)를 하나의 Windows `.exe`로 묶고,
실행하면 `http://localhost:8080`을 기본 브라우저로 연다.

- Rust는 `x86_64-pc-windows-msvc` 타깃으로 깔끔히 크로스컴파일된다.
- **이미 존재하는 `SubprocessDispatcher`**(로컬 dev 모드, `crates/controller/src/dispatcher/
  subprocess.rs`)가 controller가 같은 머신에서 `worker`를 spawn하고 `--controller
  http://127.0.0.1:8081`로 register시키는 흐름을 제공한다 — 즉 "K8s 없는 자체 완결 모드"의
  절반이 로컬 dev 형태로 이미 깔려 있다. 데스크톱 번들은 이 모드를 패키징하는 일이다.
- UI는 빌드 산출물(`ui/dist`)을 controller가 그대로 서빙(현행과 동일).

**옵션 B — Tauri 래퍼 (네이티브 앱 경험이 필요해지면).**

기존 웹 UI를 *그대로* 네이티브 창에 감싼다(UI 리라이트 0). 이 repo에 자연스러운 이유:

- Tauri는 **Rust 기반** → 엔진과 같은 언어. controller를 별도 프로세스가 아니라 Tauri의 Rust
  백엔드에 **in-process로 임베드**하는 선택지가 열린다.
- Electron 대비 바이너리/메모리가 가볍고, 네이티브 인스톨러·창·파일 다이얼로그(시나리오·리포트
  열기/저장)를 덤으로 얻는다.

옵션 A로 먼저 "더블클릭 → 바로 사용"을 확보하고, 네이티브 앱 느낌(인스톨러·창·메뉴)이
필요할 때 B로 감싼다. **어떤 셸을 고르든 진짜 일거리는 "K8s 없이 도는 자체 완결 로컬 모드"**
(단일 바이너리 번들, Windows `%APPDATA%` 기본 경로, 단일 워커)이며 이는 셸 선택과 독립이다.

### 거절: Flutter / React Native

UI(React Flow·Monaco·Zustand)는 DOM/웹 기술이다. Flutter는 Dart 전면 리라이트를 강요하고
(React Flow/Monaco 대응물 없음), React Native는 DOM이 없어 같은 웹 컴포넌트를 못 올린다
(RN Windows도 이런 데스크톱 개발도구용으로 미성숙). 둘 다 **기존 UI 자산 폐기 + ADR-0003/0015
양방향 sync 재구현**을 의미 → 비용 대비 이득 없음.

## 관련 검토: LAN 분산 워커 (Controller PC가 다른 PC에 부하 분산)

추가 질문 — "Windows로 설치했을 때, controller 역할 PC가 네트워크상의 다른 Windows PC에게
부하를 발생시키게 할 수 있는가?" 코드 확인 결과 **프로토콜 수준은 이미 지원, 운영 격차 3가지가
남는다.** (이 항은 *feasibility 기록*이며 아직 스코프/구현 결정은 아니다.)

- **이미 됨 (pull 모델, ADR-0010)**: 워커가 controller를 dial한다 — `worker --controller
  http://<controller-ip>:8081`(`crates/worker/src/main.rs`). gRPC bidi 스트림
  (`proto/coordinator.proto`)은 네트워크 투명이라, PC-B의 worker를 PC-A의 controller로 향하게
  하면 로컬 subprocess 워커와 **동일하게 register → shard 배정 → 실행**된다. shard 분배는
  컨트롤러 권위(`grpc/shard.rs` `shard_split`, ADR-0027), 멀티워커 fan-out·메트릭 머지·
  `dropped` 합산 인프라(ADR-0027/0038)도 그대로 재사용된다.
- **격차 ① 바인딩/방화벽**: controller gRPC는 기본 `127.0.0.1:8081`(localhost 전용,
  `crates/controller/src/main.rs`). 다른 PC에서 도달하려면 `0.0.0.0:8081`(또는 특정
  인터페이스) 바인딩 + Windows 방화벽 인바운드 허용이 필요.
- **격차 ② 오케스트레이션(원격 워커를 *누가 띄우나*)**: 현재 dispatcher는 subprocess(로컬
  spawn)·K8s Job 둘뿐(ADR-0019). 원격 Windows PC엔 ⓐ 새 `RemoteDispatcher`(SSH/WinRM/경량
  에이전트로 원격 `worker.exe` 기동) 또는 ⓑ 각 PC에서 수동 실행이 필요. 단 현 모델은 워커를
  **run마다 spawn하며 시작 시 `run_id`를 박는다** → "상시 대기 에이전트 풀"(run_id 없이 붙어
  대기하다 배정) 모델은 컨트롤 플레인 소폭 변경이 필요하다.
- **격차 ③ 보안**: controller↔worker 채널엔 **TLS/인증이 없다**(사내·신뢰 네트워크 가정).
  같은 LAN이면 충분하나, 머신 경계를 넘기면 mTLS(tonic+rustls) 추가 권장.

요약: LAN 분산은 **"세 번째 dispatcher 변종 + 바인딩 + 인증"**이지 재아키텍처가 아니다 —
빌딩블록은 ADR-0019(dispatcher 추상화)·ADR-0027/0038(fan-out)에 이미 있다. 데스크톱 라이트
모드가 단일 PC를 넘어 확장돼야 할 때 별도 ADR로 스코프한다.

## Consequences

- **방향만 확정, 코드 변경 0**(이 ADR은 기록). 구현은 roadmap 후보로 미착수.
- 옵션 A는 새 빌드 타깃(`x86_64-pc-windows-msvc`)·번들링·Windows 기본 경로(DB/리포트
  `%APPDATA%`) 작업이 주이고, 엔진/UI 로직 변경은 최소(현 로컬 dev 모드 패키징에 가깝다).
- 단일 PC 부하 한도(단일 워커, fan-out 없음)는 "라이트 사용자 소규모 테스트" 범위에 충분.
  본격 부하·멀티워커는 기존 K8s 경로(ADR-0027) 유지. 한도는 구현 시 문서화.
- LAN 분산은 별도 결정으로 분리(위 §관련 검토) — 필요 시 RemoteDispatcher + 바인딩 + mTLS로
  스코프.

## Alternatives considered

1. **Electron 래퍼**: 옵션 A/B와 같은 "웹 UI 재사용"이 되지만 Tauri 대비 바이너리/메모리가
   무겁고 엔진(Rust)과 언어가 갈린다 — in-process 임베드 이점이 없다. Tauri를 우선.
2. **Flutter / React Native**: §거절 참조 — UI 전면 리라이트, React Flow/Monaco 대응물 부재,
   RN no-DOM. 비채택.
3. **PWA(설치형 웹앱)만**: 셸 없이 브라우저 "설치"만으로도 일부 충족되나, 로컬 controller/
   worker 바이너리 동봉·기동(자체 완결 모드의 본질)을 PWA가 대신 못 한다 — 결국 옵션 A의
   `.exe` 번들이 필요. PWA는 보완재이지 대체재 아님.

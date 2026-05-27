# 0010. Controller ↔ Worker: gRPC bidi stream, 워커 pull/등록 모델

- **상태**: Accepted
- **날짜**: 2026-05-27

## Context

컨트롤러와 워커(N개)가 작업 분배와 메트릭 전송을 양방향으로 한다. 통신 모델은 K8s 환경에서 동적으로 변하는 워커 수, 높은 메트릭 처리량, 운영 부담을 모두 고려해야 한다.

## Decision Drivers

- 양방향 통신 (작업 ↑, 메트릭 ↓)
- 워커 동적 추가·제거 (HPA로 수가 변함)
- 메트릭 전송 효율 (높은 throughput, 작은 메시지 다수)
- K8s service discovery와의 정합성
- 외부 의존성 최소화 (MVP overengineering 회피)

## Considered Options

1. **gRPC bidi stream, 워커가 pull/등록** — 워커가 Controller Service DNS로 연결 → 자기 등록 → stream 유지
2. **HTTP polling** — 워커가 주기적 GET (작업 받기) / POST (메트릭 전송)
3. **Message queue (NATS/Redis Stream)** — 양쪽 다 큐 클라이언트
4. **Controller push** — 컨트롤러가 워커 Pod IP를 알아내서 직접 gRPC 호출

## Decision

**옵션 1: gRPC bidi stream, 워커 pull/등록.** tonic(Rust)으로 양방향 스트림 구현. 워커는 `controller.handicap.svc.cluster.local` 하나만 알면 됨.

## Consequences

**Positive**
- 워커가 컨트롤러를 찾는 방향(반대 X) → K8s Service DNS만으로 해결, 컨트롤러는 워커 IP를 알 필요 없음
- 메트릭 stream은 backpressure가 gRPC 레벨에서 자연스러움
- 외부 MQ 의존 없음 — Pod 2종(컨트롤러, 워커)만 관리

**Negative / Trade-offs**
- 영구 stream → 워커 갑자기 죽거나 네트워크 끊기면 재연결·재등록 로직 필요
- gRPC 디버깅이 HTTP REST보다 까다로움 (grpcurl 등 도구 학습)
- proto 변경 시 양쪽 빌드 동시 처리 필요 — `crates/proto`로 분리해 buf/tonic-build로 관리

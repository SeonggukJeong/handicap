# 0002. 프로토콜 범위: REST API/JSON 우선

- **상태**: Accepted
- **날짜**: 2026-05-27

## Context

JMeter의 UI가 비대해진 가장 큰 원인은 모든 프로토콜(HTTP, JDBC, SOAP, JMS, FTP, …)을 한 트리에 욱여넣은 것이다. 우리는 첫 1년은 의도적으로 좁고 깊게 가야 한다. 사내 사용 사례가 어떤 프로토콜에 집중되어 있는지 확인 필요.

## Decision Drivers

- 사내 테스트 대상의 95%가 어떤 형태인가
- 엔진 단순성 (HTTP 비동기 외 다른 stateful 프로토콜은 추가 복잡도)
- UI 복잡도 (각 프로토콜은 별도 노드 타입·폼·검증을 요구)
- 향후 확장 여지

## Considered Options

1. **REST API (HTTP/JSON) 중심** — 멀티스텝 + 토큰 인증
2. **REST + WebSocket/SSE** — 채팅·실시간 서비스 포함
3. **내부 RPC/gRPC** — .proto 다루고 스트리밍 고려
4. **다 다루기** — JMeter 답습

## Decision

**옵션 1: REST API (HTTP/JSON) 중심.** 사내 우선순위가 명확히 여기에 있고, MVP 범위가 가장 명확해진다. 멀티스텝 흐름·토큰 인증·동적 변수 정도까지만 지원.

## Consequences

**Positive**
- 엔진은 단일 프로토콜(HTTP) async 구현만 신경쓰면 됨 — `reqwest`/`hyper` 충분
- UI도 "HTTP 요청 노드" 한 종류만 잘 만들면 됨
- LoadRunner급 리포트 같은 차별점에 자원을 더 쓸 수 있음

**Negative / Trade-offs**
- WebSocket·gRPC가 필요한 팀은 당분간 다른 도구 사용
- 후속 단계에서 프로토콜 추가 시, 시나리오 모델이 HTTP에만 편향되지 않게 처음부터 추상화 신경써야 함
- 메시지 큐(MQTT 등) 테스트는 아예 범위 밖

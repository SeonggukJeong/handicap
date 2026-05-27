# 0012. 워커가 메트릭을 시간 윈도우별로 사전 집계

- **상태**: Accepted
- **날짜**: 2026-05-27

## Context

워커당 RPS가 수천~수만에 이를 수 있다. 매 HTTP 응답마다 raw 샘플 1개를 컨트롤러로 보내면 (a) gRPC 네트워크 대역폭 폭증, (b) 컨트롤러 처리·SQLite 쓰기 병목, (c) 메트릭 row 수 폭발. JMeter가 raw로 처리해 대규모 테스트에서 흔히 겪는 문제.

## Decision Drivers

- 네트워크 효율 (워커 ↔ 컨트롤러 gRPC 트래픽)
- 컨트롤러·SQLite 쓰기 부담
- 리포트에 필요한 정밀도 (percentile은 유지해야 LoadRunner 대체 가능)
- 워커 메모리 사용량

## Considered Options

1. **워커가 시간 윈도우(1s)별 통계 집계 후 전송** — count, sum, sum_sq, HDR histogram, status code 분포, 에러 카운트
2. **워커가 raw 샘플 그대로 전송** — 가장 단순, 가장 비싼
3. **워커가 평균·percentile만 전송** — count·sum 손실, 다중 워커 결과 머지 불가능
4. **컨트롤러 측에서 raw 받아 집계** — 옵션 2의 변형, 컨트롤러 부하 큼

## Decision

**옵션 1: 1초 윈도우별 워커 측 사전 집계.** 응답시간은 HDR Histogram(hdrhistogram-rs)으로 표현 — percentile 정확도를 유지하면서 직렬화 크기는 수 KB.

## Consequences

**Positive**
- 네트워크·컨트롤러 부하가 raw 대비 ~1000배 감소 (1초당 메시지 1개 per 워커)
- HDR Histogram은 머지 가능(다중 워커) → 컨트롤러에서 워커별 통계를 그대로 합치면 됨
- 1초 단위 시계열 그래프는 보통 충분 (사용자 인터뷰 기준)

**Negative / Trade-offs**
- 워커 메모리 사용 — HDR Histogram per (endpoint × 1초 윈도우). 시나리오 종류가 늘어나면 메모리 증가, 윈도우 끝나면 즉시 컨트롤러로 flush해서 완화
- **raw per-request 정보 손실** — "어느 한 요청이 왜 5초 걸렸나" 디버깅 못함. 후속 단계에서 옵션으로 OpenTelemetry trace export 추가 가능
- 1초보다 짧은 spike (예: 100ms 동안 RPS 급락)는 그래프에서 안 보임 — 후속 단계에서 윈도우 크기 옵션화 가능

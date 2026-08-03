# 0051. 실행 중 진행 차트 — in-run 1s windows의 클라이언트 표시 허용

- **상태**: Accepted
- **날짜**: 2026-08-03

## Context

ADR-0009는 MVP에서 라이브 대시보드를 제외하며 후속 한도를 "옵션 2 정도(진행률·현재 RPS·에러 카운트 수치만, 차트는 종료 후)"로 남겼다. 도그푸딩에서 그 한도의 비용이 드러났다: run 진행 중 Run 상세엔 누적 평균 카드뿐이라, 사람이 계속 지켜보지 않으면 부하가 어떻게 변했는지(ramp-up 상승·정체·에러 시작 시점) 알 수 없다. 한편 데이터는 이미 전부 있다 — 워커가 1s 윈도우를 사전 집계(ADR-0012)해 컨트롤러 SQLite에 영속하고, UI는 `/api/runs/{id}/metrics`를 이미 1초마다 폴링 중이며, 리포트용 recharts도 이미 번들에 있다.

## Decision

**이미 수집·영속되고 이미 폴링 중인 1s windows의 클라이언트 표시(in-run 진행 차트)를 허용한다.** 이는 ADR-0009의 "후속은 옵션 2 정도" 한 줄을 supersede하는 확장이다(차트가 실행 중에 뜬다). ADR-0009의 나머지는 전부 유지: WebSocket/SSE·서버 push·시계열 DB·전용 라이브 대시보드·APM 대체는 계속 비목표다. 이 기능은 신규 데이터 경로도 신규 라이브러리도 만들지 않는다 — 서버/proto/스토어 0-diff.

구현: `liveBySecond` 순수 헬퍼(스텝 간 합산·후미 1초 트림 — 멀티워커 도착 skew가 유일한 부분합 벡터, 엔진 flush는 완성 초만 전송) + `RunDetailPage` else 가지에 `TimeSeriesChart` 2종(RPS·에러). 설계: `docs/superpowers/specs/2026-08-03-live-rps-chart-design.md`.

## Consequences

**Positive**: 실행 중 궤적 가시성(자리 비움 후 복귀 시 전체 이력) · 에러 시작 시점의 실시간 파악(중단 판단) · 라이브·리포트가 같은 1s windows 기반이라 사후 분석과 연속.

**Negative / Trade-offs**: 최신 1초는 트림되어 표시가 1초 늦다 · 트래픽 정체 시 마지막 실데이터 1초가 숨는다(stall 배너가 상보) · 레이턴시(p50/p95) 라이브는 여전히 불가(windows에 없음 — 수요 확인 후 별도 결정).

# 0017. MVP 리포트 스코프

- **상태**: Accepted
- **날짜**: 2026-05-27

## Context

[ADR-0009](0009-no-live-dashboard-mvp.md)가 라이브 대시보드를 빼면서 "종료 후 리포트의 깊이가 LoadRunner 대비 핵심 차별점" 이라고 못박았다. 다만 LoadRunner급 깊이(트랜잭션 분해·run간 비교·SLA 등)를 MVP 1단계에 다 넣으면 ADR-0008(수직 슬라이스) 정신에 어긋난다. MVP 리포트 범위를 명시한다.

## Decision Drivers

- MVP 수직 슬라이스의 1단계 정신 (얕더라도 전 레이어 동작)
- "JMeter 보다 의미 있게 좋다" 인상의 최저선
- 후속 단계 (3단계)에서 LoadRunner급으로 확장 가능한 구조

## Considered Options

1. **최소 (단순 통계만)** — 총 RPS, 평균 응답시간, 에러율, 종료 메시지
2. **MVP 기본 (시계열 + 분포)** — 옵션 1 + 1s 해상도 시계열 그래프 + 스텝별 + status 분포
3. **확장 (run간 비교·SLA)** — 옵션 2 + 두 run 비교 차트 + SLA pass/fail 판정
4. **풀 (트랜잭션 분해 등)** — LoadRunner급, MVP에 부담

## Decision

**옵션 2: MVP 기본.** JMeter HTML 리포트보다 한 단계 위, LoadRunner의 1/3 수준. 옵션 3·4는 후속 단계.

### MVP 리포트 IN
- 요약 카드: 총 요청·총 에러·전체 RPS·전체 p50/p95/p99 응답시간·duration
- 시계열 그래프 (1초 해상도): RPS, p95 응답시간, 에러 카운트 — 각각 라인 차트
- 스텝별 통계 테이블: 위 메트릭을 각 시나리오 스텝별로
- HTTP status code 분포: 막대 차트
- 시나리오 snapshot (실행 시점 YAML)
- 실행 메타: run config(VU·ramp-up·duration), 시작·종료 시각

### MVP 리포트 OUT (후속 단계)
- run 간 비교 (회귀 차트) — 3단계
- SLA 정의·pass/fail — 3단계
- 트랜잭션 시간 분해 (DNS·TCP·TLS·TTFB·다운로드) — 후속
- 워터폴 뷰 (VU별 iteration 타임라인) — 후속
- 백분위 분포 히스토그램 (전체 응답시간 분포) — 후속
- CSV·Excel export — 후속 (JSON 다운로드는 MVP 포함)

## Consequences

**Positive**
- HDR Histogram 기반이라 percentile 정확도는 1단계부터 유지 (확장 시 알고리즘 재설계 불필요)
- 1초 해상도 시계열로 부하 변화 패턴 관찰 가능
- 스텝별 분리로 어느 엔드포인트가 느린지 즉시 판단 가능

**Negative / Trade-offs**
- "어떤 한 요청이 5초 걸렸나" 같은 디버깅은 MVP에서 불가능 (raw 샘플 없음 — ADR-0012)
- run 간 비교는 사용자가 두 리포트를 직접 두 탭에 열어 비교해야 함 — 3단계까지 수동
- SLA 자동 판정은 CI 통합에 필요한데 MVP에는 없음 → CI 통합은 후속 단계

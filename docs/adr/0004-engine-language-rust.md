# 0004. 엔진 언어: Rust

- **상태**: Accepted
- **날짜**: 2026-05-27

## Context

부하 생성 엔진의 VU 밀도(머신당 동시 시나리오 수)와 메모리 풋프린트가 도구의 운영 비용과 분산 워커 수를 결정한다. 1년 차 목표는 단일 머신 1만 VU, 분산으로 20만 RPS.

## Decision Drivers

- 단일 머신 VU 밀도 (메모리 풋프린트, async runtime 효율)
- 시작 시간 (워커 Pod 자주 띄웠다 내림)
- 개발 생산성과 인력 가용성
- async I/O 생태계 성숙도

## Considered Options

1. **Rust** — `tokio` async, 작은 메모리 풋프린트, 예측가능 성능. 사례: oha, Drill
2. **Go** — goroutine은 가볍지만 Rust보다 메모리 풋프린트 큼. 사례: k6, Vegeta. 개발 속도 빠름
3. **Node.js/TypeScript** — 엔진·UI 동일 언어. VU 밀도는 Go의 1/5 수준
4. **Java/Kotlin (JVM)** — JMeter 계보. 메모리 풋프린트 크고 시작 느림

## Decision

**옵션 1: Rust.** 단일 머신 1만+ VU 목표 달성 가능성 가장 높고, 워커 Pod 시작·메모리 효율이 분산 운영에서 누적 비용 차이가 큼. tokio + reqwest 조합이 부하 생성 도구에서 충분히 검증됨.

## Consequences

**Positive**
- 같은 H/W에서 Go·Node 대비 더 많은 VU. 분산 워커 수도 줄어듦
- 워커 Pod startup이 빠름 (수십 ms) — 짧은 테스트도 부담 없이 분산 실행 가능
- panic·OOM 같은 런타임 사고가 적음 → 장시간 부하 테스트 신뢰성

**Negative / Trade-offs**
- 개발 속도가 Go보다 느림. 첫 MVP 도달까지 더 걸릴 수 있음
- async/`Pin`/`Send` 패턴 학습 곡선 — 팀에 Rust 경험자가 필요
- 한국 시장 Rust 엔지니어 풀이 Go·Node보다 좁음 (채용 시 고려)

# 0016. VU 실행 모델: VU 1개당 tokio task 1개

- **상태**: Accepted
- **날짜**: 2026-05-27

## Context

Worker가 N개의 VU를 동시 실행할 때 OS 스레드·async task·작업 큐 중 무엇을 단위로 할지 결정. 단일 머신 1만 VU 목표(ADR-0006)에서 이 선택이 성능 한계를 좌우.

## Decision Drivers

- 단일 머신 1만 VU 메모리 풋프린트
- 시나리오 실행 모델의 단순성 (스텝 사이 await가 자연스러운가)
- 스케줄러 fairness (한 느린 VU가 다른 VU를 막지 않는가)
- 컨텍스트 스위치 비용

## Considered Options

1. **VU 1개 = tokio task 1개** — async task가 한 시나리오 사이클을 순차 실행
2. **OS 스레드 1개 = VU 1개** — JMeter 스타일, 1만 VU = 1만 스레드 (불가능)
3. **Work-stealing pool** — 고정 N개 worker에 시나리오 step을 큐로 분배
4. **GoRoutine 스타일 가벼운 그린스레드** — Rust에서는 tokio task가 가장 가까움 (옵션 1과 동일)

## Decision

**옵션 1: VU 1개당 tokio task 1개.** 시나리오 = `async fn run(vu_id, ctx) { ... }`. tokio scheduler가 task를 OS 스레드 N개에 분배.

## Consequences

**Positive**
- tokio task는 메모리 풋프린트 작음 (~수 KB) → 1만 VU 무리 없음
- 시나리오 코드가 자연스러움 (스텝 사이에 `await`, 변수 추출 등이 그냥 보임)
- think time(`tokio::time::sleep`)이 OS 스레드 점유하지 않음
- VU별 컨텍스트(추출 변수, iter 카운트)가 task-local로 자연스럽게 격리

**Negative / Trade-offs**
- VU 수가 task 수와 동치 → 동시 1만 task 깨어나면 tokio scheduler에 burst 부담. ramp-up으로 완화
- 한 VU 안에서 blocking syscall(예: 동기 파일 I/O)이 들어가면 thread pool 전체 영향 → 시나리오 실행 코드에 blocking 금지 강제
- 후속 단계에서 시나리오 안에 사용자 정의 코드 허용 시 blocking 호출 검출 필요

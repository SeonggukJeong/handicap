# 0006. 배포 타겟: upstream Kubernetes

- **상태**: Accepted
- **날짜**: 2026-05-27

## Context

분산 워커 아키텍처가 1순위급 요구사항이고(단일 머신 한계로 20만 RPS 불가능), 사내 인프라가 Kubernetes를 도입 예정. 컨트롤러 1대 + 워커 N대를 어떤 형태로 배포할지 결정 필요.

## Decision Drivers

- 사내 표준 인프라와의 정합성
- 워커 수평 확장 자동화 가능 여부
- 다중 환경(dev/staging/prod) 분리 용이성
- 운영 부담 (모니터링, 로그 수집, 시크릿 관리)

## Considered Options

1. **upstream Kubernetes** — 컨트롤러=Deployment, 워커=Job 또는 Deployment, Helm chart 배포
2. **Docker Compose / VM 수동** — 가볍지만 워커 자동 스케일·다중 환경 분리 수동
3. **단일 노드 (한 프로세스)** — MVP는 가능하지만 본질 요구(분산) 충족 불가
4. **하이브리드: UI는 상시, 워커는 온디맨드 클라우드 VM** — 비용 최적이지만 운영 복잡

## Decision

**옵션 1: upstream Kubernetes.** 사내 K8s 도입 후 워커 수평 확장·환경 분리·표준 모니터링이 그대로 가능. Helm chart 한 번 작성으로 dev/staging/prod 모두 커버.

## Consequences

**Positive**
- 사내 K8s 도입과 동시에 즉시 운영 환경으로 승격 가능
- HPA/KEDA로 워커 수 자동 조정 가능성 열림
- Prometheus·로그 수집 같은 K8s 표준 ecosystem 활용

**Negative / Trade-offs**
- K8s 학습 곡선 (팀 일부에게 필요)
- 사내 K8s 도입 전까지는 ADR-0007 (kind)로 우회
- **로컬 일상 dev에서는 K8s 띄우지 않음** — 매 코드 변경마다 이미지 빌드·`kubectl apply` 사이클은 너무 느림. CLAUDE.md의 dev 모드 표 참조.

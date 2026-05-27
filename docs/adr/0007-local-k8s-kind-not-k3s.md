# 0007. 로컬 K8s: kind (k3s 거절)

- **상태**: Accepted
- **날짜**: 2026-05-27

## Context

ADR-0006이 upstream Kubernetes를 프로덕션 타겟으로 정했지만 사내 K8s는 아직 미도입. 그때까지 통합 테스트·CI에서 사용할 로컬 K8s 환경이 필요하다. dev 일상 작업은 K8s 없이 cargo run으로 진행(ADR-0006 참조)하므로, 여기서 결정하는 것은 "manifest·Helm 검증용 로컬 K8s".

## Decision Drivers

- 사내 upstream K8s와의 동작 호환성
- CI 환경에서 사용 용이성
- 멀티 노드 시뮬레이션 가능성
- 떴다 내렸다 속도 (CI cycle time)

## Considered Options

1. **kind** — Docker 컨테이너 안에서 upstream K8s 실행. K8s 프로젝트 자체가 CI에 사용. CNCF 컨포먼스
2. **k3s** — Rancher의 경량 K8s 배포판. 단일 바이너리, SQLite 백엔드, Traefik·ServiceLB 기본 탑재
3. **minikube** — 오래된 기본 선택. VM 또는 Docker 드라이버
4. **Docker Desktop K8s** — 개발자별 GUI 의존, CI 부적합

## Decision

**옵션 1: kind.** 우리 프로덕션 타겟은 사내 **upstream** K8s이고, kind는 upstream을 그대로 컨테이너에 띄운 것이라 매니페스트가 사내 K8s와 1:1 호환. CI에서도 그대로 사용 가능. 멀티노드도 설정 한 줄.

## Consequences

**Positive**
- 로컬 통합 테스트에서 통과한 매니페스트는 사내 K8s에서도 거의 그대로 동작
- CI에서 kind를 띄워 e2e 테스트 수행 가능
- kind는 K8s 프로젝트의 공식 CI 도구라 장기 지원 확실

**Negative / Trade-offs**
- Docker 필수 (대부분 dev 환경에 이미 있음)
- k3s의 "단일 바이너리 어플라이언스 배포" 옵션은 포기 — 우리 도구가 VM 1대에 자기 자신을 K8s 없이 설치하는 시나리오는 지원 안 함
- 메모리 풋프린트는 k3s가 더 가벼움 — 단 통합 테스트에서만 띄우므로 일상 부담은 아님

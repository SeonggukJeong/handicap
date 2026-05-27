# 0003. UI 모델: GUI ↔ Code 양방향 sync

- **상태**: Accepted
- **날짜**: 2026-05-27

## Context

원래 요구사항이 "비개발자(QA)도 사용 가능 + 개발자도 원하는대로 스크립트 가능". 이 두 요구를 어떻게 UI에 담느냐가 이 프로젝트의 본질적 차별점이고, 가장 까다로운 설계 문제다.

## Decision Drivers

- QA의 진입 장벽 (학습 곡선)
- 개발자가 복잡한 흐름 제어(loop, conditional, parallel)를 표현할 수 있는가
- 같은 시나리오를 QA와 개발자가 함께 다룰 수 있는가 (둘이 따로 만들면 동기화 지옥)
- 구현 비용

## Considered Options

1. **A. Postman 스타일** — 폼 기반 스텝 목록 + 개발자용 인라인 pre/post 스크립트
2. **B. n8n 스타일** — 드래그-드롭 노드 그래프 + 노드별 코드 패널
3. **C. 양방향 sync** — GUI와 YAML/DSL이 같은 모델의 두 뷰, 한쪽 수정하면 반대쪽 즉시 반영
4. **B + C 하이브리드** — C의 아키텍처(같은 모델의 두 뷰) + B의 UX(드래그-드롭 캔버스)

## Decision

**옵션 4: B + C 하이브리드.** 양방향 sync 아키텍처 위에 드래그-드롭 노드 캔버스를 GUI 뷰로 얹는다. 코드 뷰는 YAML 기반 DSL을 Monaco 에디터로 제공.

## Consequences

**Positive**
- QA는 노드 캔버스만 봄, 개발자는 코드만 봄, 동일 산출물
- 복잡한 흐름(loop·conditional·parallel)을 노드 그래프로 시각화 가능
- 시나리오 파일이 텍스트(YAML)라 git diff·코드 리뷰·CI 친화

**Negative / Trade-offs**
- **양방향 sync 엔진이 가장 어려운 구현 부분.** 시나리오 모델을 매우 신중히 설계해야 한다 — GUI에서만 표현 가능한 것도, 코드에서만 가능한 것도 있으면 sync가 깨진다.
- "canonical model is the YAML schema" 원칙을 처음부터 못 박고, GUI는 그 model의 strict view여야 함
- 노드 종류·필드 종류 추가할 때마다 두 뷰 모두 손봐야 함

# 0015. 양방향 sync 구현: Zustand store + Zod 검증 + YAML AST round-trip

- **상태**: Accepted
- **날짜**: 2026-05-27

## Context

[ADR-0003](0003-ui-model-gui-code-bidirectional-sync.md)이 GUI ↔ Code 양방향 sync를 결정. 실제 구현 방식은 별도 결정 필요: canonical state를 어디에 두고, 두 뷰를 어떻게 묶고, YAML 코멘트·키 순서 보존을 어떻게 처리할지.

## Decision Drivers

- 단일 진실 소스 (state divergence가 sync를 깨는 가장 흔한 원인)
- 타입 안전성 (React Flow와 Monaco 둘 다에서 같은 모델 사용)
- YAML 코멘트·키 순서 보존 (개발자의 주석은 가치 있음)
- 사용자 입력 막힘 방지 (validation으로 모든 키스트로크 막으면 안 됨)

## Considered Options

1. **Zustand + Zod + `yaml` 패키지 Document API** — store 단일, AST round-trip
2. **YAML 문자열을 state로** — 매 키스트로크 parse, 단순하지만 비효율
3. **JSON in-memory만, YAML은 export 시점에만 생성** — 코멘트·키 순서 완전 손실
4. **immer + Yjs (CRDT)** — 협업 편집 가능하지만 MVP overengineering

## Decision

**옵션 1.**
- **Zustand**: 단일 store, 모든 컴포넌트가 selector로 구독
- **Zod**: 시나리오 schema 정의 — TypeScript 타입 + 런타임 validation 동시
- **`yaml` 패키지 Document API**: AST 노드 단위 업데이트, 코멘트·키 순서 보존
- Monaco 편집은 **300ms 디바운스**, validation 실패 시 inline 에러 표시 (store 미반영)
- 모든 스텝에 **stable ULID** 부여 (편집·재정렬에도 ID 추적)

## Consequences

**Positive**
- State 분기 불가능 — store가 단일 진실
- Zod schema 하나가 TypeScript 컴파일 타입과 런타임 validation을 동시 제공
- 코멘트가 GUI 편집을 거쳐도 대부분 보존 (yaml AST 부분 업데이트)
- 디바운스로 빠른 입력 막힘 없음, 잠시 invalid 상태 허용

**Negative / Trade-offs**
- Document API가 일반 `JSON.parse` 보다 복잡 — 학습 곡선
- 코멘트가 "지워진 키 옆"에 있던 경우는 100% 보존 불가 — 알려진 한계로 문서화
- Zustand는 React 외부에서 못 씀 — 만약 헤드리스 CLI 모드가 필요해지면 시나리오 model을 별도 framework-agnostic 코어 라이브러리로 분리해야 함

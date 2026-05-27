# 0005. UI 스택: TypeScript + React

- **상태**: Accepted
- **날짜**: 2026-05-27

## Context

웹 UI는 두 가지 까다로운 요구가 있다: (1) 드래그-드롭 노드 캔버스 (시나리오 빌더), (2) 코드 에디터 (YAML/DSL). ADR-0003의 양방향 sync는 두 컴포넌트가 같은 model state를 정확히 공유해야 함을 의미한다.

## Decision Drivers

- 드래그-드롭 노드 그래프 라이브러리 가용성
- 코드 에디터 라이브러리 가용성
- 타입 안전성 (양방향 sync 같은 까다로운 상태 동기화는 타입 도움 필요)
- 팀·시장 인력 풀

## Considered Options

1. **TypeScript + React** — React Flow (노드 캔버스), Monaco (코드 에디터), Vite
2. **Vue 3** — 비슷한 도구 가능하지만 React Flow급 라이브러리 부재
3. **Svelte/SvelteKit** — 가볍고 빠르지만 노드 캔버스 생태계 빈약
4. **Next.js** — React 위 SSR 추가. SPA 충분, SSR 불필요

## Decision

**옵션 1: TypeScript + React, Vite 빌드.** React Flow가 사실상 노드 캔버스 표준이고, Monaco가 코드 에디터 표준. 두 핵심 컴포넌트의 검증된 라이브러리가 모두 React 우선.

## Consequences

**Positive**
- React Flow + Monaco를 그대로 활용, 핵심 UI 컴포넌트를 처음부터 만들 필요 없음
- TypeScript로 시나리오 모델·sync 로직 타입 강제 → 양방향 sync 버그 컴파일 단계에서 잡힘
- 한국 시장 React 인력 풀이 가장 넓음

**Negative / Trade-offs**
- SPA 번들 크기 관리 필요 (Monaco가 무거움 — lazy load 권장)
- React 18+ concurrent rendering에서 sync 타이밍 이슈 가능 — 모델 store(Zustand/Jotai) 신중히 선택

# Architecture Decision Records

이 디렉토리는 Handicap의 아키텍처·설계 결정을 기록합니다. 포맷은 [MADR](https://adr.github.io/madr/) 변형.

## 인덱스

| # | 제목 | 상태 |
|---|---|---|
| [0001](0001-target-user-internal-qa.md) | 1차 사용자: 사내 QA | Accepted |
| [0002](0002-protocol-scope-rest-api-first.md) | 프로토콜 범위: REST API/JSON 우선 | Accepted |
| [0003](0003-ui-model-gui-code-bidirectional-sync.md) | UI 모델: GUI ↔ Code 양방향 sync | Accepted |
| [0004](0004-engine-language-rust.md) | 엔진 언어: Rust | Accepted |
| [0005](0005-ui-stack-typescript-react.md) | UI 스택: TypeScript + React | Accepted |
| [0006](0006-deployment-target-upstream-k8s.md) | 배포 타겟: upstream Kubernetes | Accepted |
| [0007](0007-local-k8s-kind-not-k3s.md) | 로컬 K8s: kind (k3s 거절) | Accepted |
| [0008](0008-mvp-strategy-vertical-slice.md) | MVP 전략: 수직 슬라이스 | Accepted |
| [0009](0009-no-live-dashboard-mvp.md) | MVP에 라이브 대시보드 없음 | Accepted |
| [0010](0010-controller-worker-grpc-pull.md) | Controller ↔ Worker: gRPC bidi, 워커 pull/등록 | Accepted |
| [0011](0011-mvp-storage-sqlite.md) | MVP 저장소: SQLite (PostgreSQL 마이그레이션 경로) | Accepted |
| [0012](0012-worker-side-metric-aggregation.md) | 워커가 메트릭 사전 집계 (1초 윈도우, HDR Histogram) | Accepted |
| [0013](0013-scenario-runconfig-separation.md) | Scenario와 Run Config 분리 | Accepted |
| [0014](0014-template-notation.md) | 변수·env·시스템 변수 표기 분리 (`{{}}` vs `${}`) | Accepted |
| [0015](0015-bidirectional-sync-impl.md) | 양방향 sync 구현: Zustand + Zod + YAML AST | Accepted |
| [0016](0016-vu-execution-model-task-per-vu.md) | VU 실행 모델: tokio task per VU | Accepted |
| [0017](0017-mvp-report-scope.md) | MVP 리포트 스코프 (시계열 + 스텝별 + status 분포) | Accepted |
| [0018](0018-vu-scoped-cookie-jar.md) | VU별 자동 cookie jar (세션 + 토큰 둘 다 지원) | Accepted |
| [0019](0019-worker-dispatcher-abstraction.md) | Worker dispatcher 추상화 (subprocess local-dev / K8s Job prod) | Accepted |
| [0020](0020-control-flow-loop-node.md) | 첫 제어 흐름 노드: loop (재귀 스텝 트리, 단일 레벨, repeat-count) | Accepted |
| [0021](0021-loop-metric-breakdown.md) | loop 메트릭 breakdown: per-run cap + overflow sentinel, counts-only | Accepted |
| [0022](0022-data-driven-datasets.md) | Data-driven 데이터셋: 독립 리소스 + 서버 파싱 + 바인딩/주입 | Accepted |
| [0023](0023-conditional-node.md) | Conditional 노드: 평탄 if/elif/else + 재귀 조건 트리 + lenient 평가 | Accepted |
| [0024](0024-run-presets-independent-resource.md) | Run 프리셋: scenario-scoped 독립 리소스 + Profile 재사용 | Accepted |
| [0025](0025-environments-resource.md) | 환경(Environments): env-namespace 전용 top-level 재사용 리소스 | Accepted |
| [0026](0026-scenario-editor-test-run.md) | 시나리오 에디터 test-run: 컨트롤러 in-process 단일패스 trace | Accepted |
| [0027](0027-multi-worker-fanout.md) | 멀티 워커 fan-out: 계획된 분산 실행 (컨트롤러 권위 + per-run 상태머신) | Accepted |
| [0028](0028-run-level-slo-criteria.md) | Run-level SLO/pass-fail criteria (리포트 verdict) | Accepted |
| [0029](0029-json-body-type-cast-injection.md) | JSON Body 타입 캐스트 주입 (`{{var:num}}`/`{{var:bool}}`) | Accepted |
| [0030](0030-run-comparison-report-export.md) | Run 비교 + 리포트 Export (CSV/XLSX) | Accepted |
| [0031](0031-open-loop-arrival-rate-execution-model.md) | Open-loop / Arrival-rate 실행 모델 | Accepted |

## 새 ADR 추가 절차

1. 다음 번호로 새 파일: `NNNN-kebab-case-title.md`
2. 아래 템플릿 복사
3. 이 README 인덱스에 한 줄 추가
4. CLAUDE.md "알아둘 결정들" 에도 한 줄 추가
5. 결정이 다른 ADR을 무효화하면 그 ADR 상태를 `Superseded by ADR-NNNN`으로 변경

## 템플릿

```markdown
# NNNN. {짧은 제목}

- **상태**: Proposed | Accepted | Deprecated | Superseded by ADR-NNNN
- **날짜**: YYYY-MM-DD

## Context

왜 이 결정이 필요했나? (2-3 문장)

## Decision Drivers

- 평가 기준 1
- 평가 기준 2

## Considered Options

1. **옵션 A** — 짧은 설명
2. **옵션 B** — 짧은 설명
3. **옵션 C** — 짧은 설명

## Decision

**옵션 X 선택.** 이유 한두 문장.

## Consequences

**Positive**
- 좋은 결과

**Negative / Trade-offs**
- 감수해야 할 비용
```

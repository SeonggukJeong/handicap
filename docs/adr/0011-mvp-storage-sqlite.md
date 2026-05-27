# 0011. MVP 저장소: SQLite (PostgreSQL 마이그레이션 경로 명시)

- **상태**: Accepted
- **날짜**: 2026-05-27

## Context

컨트롤러가 저장해야 하는 데이터: (1) 시나리오 YAML, (2) run 메타데이터, (3) run당 집계 메트릭(워커가 사전 집계해서 보낸 것 — ADR-0012), (4) 리포트 인덱스. MVP는 단일 컨트롤러 가정.

## Decision Drivers

- 운영 부담 (외부 DB Pod 추가 여부)
- 단일 컨트롤러 HA 필요 여부 (MVP는 불필요)
- 메트릭 쓰기 throughput
- 마이그레이션 가능성 (성장 시 더 큰 DB로)

## Considered Options

1. **SQLite (컨트롤러 내장, sqlx)** — 외부 의존 없음, 파일 기반
2. **PostgreSQL** — 견고, HA 가능, 별도 Pod
3. **etcd / K8s ConfigMap** — 시나리오만 가능, run/메트릭에는 부적합
4. **저장 없음 (메모리)** — 컨트롤러 재시작 시 휘발, 부적합

## Decision

**옵션 1: SQLite (sqlx 사용).** PV(Persistent Volume)에 DB 파일 마운트. 향후 PostgreSQL로 마이그레이션 시 sqlx의 DB 추상화로 코드 변경 최소화.

## Consequences

**Positive**
- 외부 DB Pod 없음, MVP 단순 (Pod 2종으로 끝)
- 백업은 PV snapshot 또는 파일 복사
- sqlx는 PostgreSQL과 SQLite 모두 지원 → 마이그레이션 트리거 시 쿼리 호환성만 점검

**Negative / Trade-offs**
- **컨트롤러 HA 불가능** — 컨트롤러 Pod이 다운되면 진행 중 run은 잃음 (MVP 수용)
- 동시 쓰기 1개 제한 (WAL 모드로 완화 가능)
- 메트릭 row 수가 클 경우 성능 저하 — ADR-0012가 워커 측 사전 집계로 row 수를 윈도우당 1개로 줄여 완화
- **마이그레이션 트리거 조건** (이 ADR에서 명시): (a) 컨트롤러 HA 필요, (b) run당 메트릭 row 수가 10만 초과, (c) 다중 컨트롤러 가능성 — 이 중 하나 충족 시 PostgreSQL로 이전

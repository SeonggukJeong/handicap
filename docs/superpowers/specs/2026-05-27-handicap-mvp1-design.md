# Handicap MVP 1단계 — 설계 명세

- **상태**: 작성 진행 중 (섹션 1–2 완료)
- **날짜**: 2026-05-27
- **대상 범위**: MVP 1단계 (수직 슬라이스 전략, [ADR-0008](../../adr/0008-mvp-strategy-vertical-slice.md))
- **참조**: 전반 결정은 [ADR 인덱스](../../adr/README.md)

이 문서는 **MVP 1단계** 만의 설계다. 후속 단계(노드 종류 확장, 분산 자동화, 리포트 깊이 등)는 각자 별도 설계 문서를 가진다.

---

## 목차

1. 아키텍처 개요
2. 시나리오 데이터 모델 *(TODO)*
3. Rust 엔진 구조 *(TODO)*
4. 웹 UI 구조 *(TODO)*
5. 리포트 *(TODO)*
6. MVP 1단계 완료 기준 *(TODO)*

---

## 1. 아키텍처 개요

### 1.1 컴포넌트 다이어그램

```mermaid
flowchart TD
  subgraph Browser["Browser — QA / 개발자"]
    UI["Web UI (React SPA)<br/>React Flow + Monaco + Zustand"]
  end

  subgraph K8s["Kubernetes (kind/k3s dev · 사내 K8s prod)"]
    subgraph Ctrl["Controller Pod (1 replica)"]
      API["HTTP API<br/>axum"]
      Coord["Worker Coordinator<br/>gRPC server (tonic)"]
      K8sC["K8s Client<br/>kube-rs"]
      Store[("SQLite<br/>(sqlx, PV mount)")]
      Report["Reporter<br/>(HTML/JSON 생성)"]
    end

    subgraph Worker["Worker Pod (MVP=1, later=N)"]
      Sched["VU Scheduler"]
      Exec["HTTP Executor<br/>reqwest"]
      Agg["Metric Aggregator<br/>HDR Histogram, 1s window"]
    end
  end

  Target[("System Under Test<br/>사내 REST API")]

  UI -- "HTTPS REST + 진행률 폴링" --> API
  API <--> Store
  Report --> Store
  Coord <-- "gRPC bidi stream<br/>작업 ↑ · 메트릭 ↓" --> Agg
  K8sC -- "K8s API<br/>(Job 생성/삭제)" --> Worker
  Sched --> Exec
  Exec --> Agg
  Exec -- "HTTP" --> Target
```

### 1.2 컴포넌트 책임

| 컴포넌트 | 책임 | 책임 아닌 것 |
|---|---|---|
| **Web UI** (React SPA, Controller가 정적 서빙) | 시나리오 빌더(드래그-드롭 + YAML 양방향 sync), 실행 트리거, 진행률 폴링, 리포트 표시 | 부하 생성 |
| **Controller Pod** (Rust, 1 replica) | 시나리오 저장, run 오케스트레이션, 워커 lifecycle 관리, 메트릭 머지·저장, 리포트 생성 | 직접 부하 생성 |
| **Worker Pod** (Rust, MVP=1) | VU 스케줄링, HTTP 요청 실행, 응답 검증·변수 추출, 1초 윈도우 메트릭 집계 → 컨트롤러로 stream | 시나리오 저장, 리포트 생성 |
| **SQLite** (Controller 내장, PV) | 시나리오 YAML, run 메타, 워커가 보낸 집계 메트릭, 리포트 인덱스 | raw per-request 샘플 (ADR-0012 참조) |
| **K8s API** | 워커 Pod/Job 라이프사이클 | 비즈니스 로직 |

### 1.3 대표 실행 흐름

```
1. QA가 UI에서 시나리오 작성 → "Save"
   UI ─REST(POST /scenarios)─> Controller ─> SQLite

2. QA가 "Run with 100 VUs" 클릭
   UI ─REST(POST /runs)─> Controller
   Controller: SQLite에 run 레코드 생성 (status=pending)
   Controller ─K8s API─> Worker Job 생성

3. Worker Pod 시작 (Rust 바이너리)
   Worker ─gRPC connect─> controller.handicap.svc.cluster.local
   Worker가 자기 등록 (capacity 선언)

4. Controller가 작업 분배
   Controller ─gRPC stream─> Worker (시나리오 YAML, VU 수, ramp-up, duration)
   Controller: run status=running

5. Worker가 실행 (수십 초~수십 분)
   Worker (VU 1..N) ─HTTP─> Target API
   Worker: 1초마다 집계 메시지(HDR Histogram + status 분포 + 에러 카운트)
   Worker ─gRPC stream─> Controller (메트릭 메시지)

6. UI 폴링이 진행률 표시
   UI ─REST(GET /runs/:id)─> Controller ─> {status, progress%, current_rps}

7. Worker가 duration 끝나면 자체 종료
   Controller ─K8s API─> Job 삭제 (cleanup)
   Controller: run status=completed

8. Controller의 Reporter가 SQLite 데이터로 HTML 리포트 생성
   UI ─REST(GET /runs/:id/report)─> Controller ─> HTML
```

### 1.4 경계와 프로토콜

| 경계 | 프로토콜 | 근거 |
|---|---|---|
| Browser ↔ Controller | HTTPS REST + 1초 간격 폴링 | WebSocket 안 씀 ([ADR-0009](../../adr/0009-no-live-dashboard-mvp.md)). 폴링이면 충분 |
| Controller ↔ Worker | gRPC bidirectional stream (tonic) | [ADR-0010](../../adr/0010-controller-worker-grpc-pull.md) — 워커가 pull/등록 |
| Worker ↔ Target | HTTP/1.1 (또는 HTTP/2) | 테스트 대상 서비스 프로토콜 그대로 (reqwest 기본) |
| Controller ↔ K8s API | kube-rs | Job 리소스 CRUD |

### 1.5 MVP 1단계 In / Out

**IN — MVP 1단계에 포함**
- 시나리오 노드 1종: `HTTP request` (method, URL, headers, body, basic assertion: status code)
- 변수: env vars + 한 응답에서 JSON path로 값 추출 → 다음 요청에서 사용
- 실행: 컨트롤러 1 + 워커 1, k3s/kind 단일 노드에서 1k VU
- 메트릭: 1초 윈도우 RPS, 응답시간 p50/p95/p99, status code 분포, 에러 카운트
- UI: 드래그-드롭 캔버스 (1종 노드만), YAML 뷰, 양방향 sync, run 시작·진행률·리포트 페이지
- 저장: SQLite (컨트롤러 내장)
- 배포: Helm chart 1개, kind 단일 노드에서 동작

**OUT — 명시적으로 후속 단계**
- 다른 노드 종류 (POST 변형, loop, conditional, parallel) — 2단계
- 멀티 워커 + 자동 스케일(HPA) — 3단계
- LoadRunner급 리포트 깊이 (트랜잭션 분해·run 간 비교·SLA pass/fail) — 3단계
- 라이브 대시보드 ([ADR-0009](../../adr/0009-no-live-dashboard-mvp.md))
- WebSocket·gRPC·기타 프로토콜 ([ADR-0002](../../adr/0002-protocol-scope-rest-api-first.md))
- 인증·RBAC·멀티테넌트 (MVP는 네트워크 격리에 의존)
- 시크릿 관리 (env vars로 충분)

### 1.6 이 섹션에서 새로 결정된 사항

이 섹션 작업 중 다음 ADR이 추가되었다:
- [ADR-0010](../../adr/0010-controller-worker-grpc-pull.md) — gRPC bidi stream + 워커 pull/등록
- [ADR-0011](../../adr/0011-mvp-storage-sqlite.md) — SQLite (PostgreSQL 마이그레이션 경로 명시)
- [ADR-0012](../../adr/0012-worker-side-metric-aggregation.md) — 워커 측 1초 윈도우 집계, HDR Histogram

---

## 2. 시나리오 데이터 모델

### 2.1 핵심 원칙

**하나의 canonical model. GUI와 YAML은 그 모델의 두 뷰일 뿐, 어느 쪽도 진실의 단독 소유자가 아니다.** 이 원칙이 깨지면 sync는 결국 깨진다. 구체적 구현은 [ADR-0015](../../adr/0015-bidirectional-sync-impl.md).

### 2.2 Scenario vs Run Config (분리)

[ADR-0013](../../adr/0013-scenario-runconfig-separation.md) 에 따라 분리한다.

| 개념 | 무엇인가 | 누가 만드나 | 어디 저장 |
|---|---|---|---|
| **Scenario** | "VU 한 명이 무엇을 하는가" — HTTP 스텝·변수·추출 | QA가 GUI로 (개발자는 YAML로) | YAML, git |
| **Run Config** | "몇 명, 얼마나 빠르게, 얼마나 오래" — VU·ramp-up·duration·env | QA가 실행 다이얼로그에서 | DB (runs 테이블) |
| **Run** | 실제 실행 인스턴스 | 시스템 | DB + 메트릭 |

### 2.3 Scenario 스키마 (canonical YAML)

```yaml
version: 1
name: "User login then fetch profile"
variables:
  base_url: "https://api.internal.example.com"
steps:
  - id: "login"               # stable ULID (모델 ↔ 캔버스 매칭)
    name: "Login"
    type: http
    request:
      method: POST
      url: "{{base_url}}/auth/login"
      headers:
        Content-Type: application/json
      body:
        json:
          username: "${USERNAME}"
          password: "${PASSWORD}"
    assert:
      - status: 200
    extract:
      - var: token
        from: body
        path: "$.access_token"

  - id: "profile"
    name: "Get profile"
    type: http
    request:
      method: GET
      url: "{{base_url}}/users/me"
      headers:
        Authorization: "Bearer {{token}}"
    assert:
      - status: 200
```

MVP 필드 참조:

- `version`: 스키마 버전 (integer)
- `name`: 사람이 읽는 시나리오 이름
- `variables`: 시나리오 전체 기본 변수 map
- `steps[]`: 순차 실행 스텝 배열 (loop/conditional은 후속 단계)
- `steps[].id`: stable ULID, 자동 생성
- `steps[].type`: MVP는 `http`만
- `steps[].request.body`: `json` / `form` / `raw` 중 택일
- `steps[].assert[]`: MVP는 `status: <code>` 만
- `steps[].extract[]`: `from = body | header | status`; `path`는 JSONPath(body) 또는 헤더 이름

### 2.4 Run Config 스키마

```yaml
scenario_id: "01HX..."
profile:
  vus: 100
  ramp_up_seconds: 30
  duration_seconds: 300
env:
  BASE_URL: "https://staging.internal.example.com"
  USERNAME: "loadtest_user_${vu_id}"
  PASSWORD: "..."
```

### 2.5 변수·env·시스템 변수 표기

[ADR-0014](../../adr/0014-template-notation.md).

| 표기 | 의미 | 평가 시점 |
|---|---|---|
| `{{var}}` | `scenario.variables` 또는 extract된 흐름 변수 | 매 요청 직전, VU별 컨텍스트 |
| `${ENV}` | run config env var | run 시작 시 한 번 |
| `${ENV:-default}` | env var, 없으면 default | run 시작 시 한 번 |
| `${vu_id}` | 시스템: VU 순번 | 매 VU 시작 |
| `${iter_id}` | 시스템: VU의 iteration 순번 | 매 iteration |

### 2.6 GUI ↔ 모델 매핑

| 모델 요소 | 캔버스에서 |
|---|---|
| `scenario.variables` | 좌측 패널 Variables 섹션, 키-값 폼 |
| `scenario.steps[i]` | 캔버스 노드 1개 (id 기준) |
| `steps[i].name` | 노드 라벨 |
| `steps[i].type` | 노드 색상/아이콘 (MVP는 모두 `http` 동일) |
| `steps[i+1].id` | 노드 i에서 그어진 화살표의 대상 |
| 선택된 노드 | 우측 인스펙터에 request/assert/extract 폼 |
| `extract[].var` | 노드 우상단 "exports: token" 뱃지 |

후속 단계의 `loop`/`conditional` 노드는 모델에 `type: loop` 추가, 내부 `do: [...]` 중첩 — 캔버스에서는 컨테이너 노드로 시각화.

### 2.7 양방향 sync 메커니즘

[ADR-0015](../../adr/0015-bidirectional-sync-impl.md) 결정:

- **Zustand** 단일 store가 canonical state
- **Zod** schema로 TypeScript 타입과 런타임 validation 동시
- **`yaml` 패키지 Document API** 로 AST 기반 round-trip (코멘트·키 순서 보존)
- Monaco 편집은 **300ms 디바운스**, validation 실패 시 inline 에러 (store 미반영, 자유 편집 허용)
- 모든 스텝에 **stable ULID** — 편집·재정렬에도 노드 추적

### 2.8 알려진 MVP 한계

- YAML 코멘트가 "지워진 키 옆"에 있던 경우는 GUI 편집 후 손실 가능
- GUI가 표현하지 못하는 unknown 필드는 strict validation으로 거부 (k6 같은 자유 JS는 불가능)
- Binary body (파일 업로드) 미지원 — 후속 단계

### 2.9 SQLite 스키마 (MVP)

```sql
-- 시나리오 (YAML이 진실, DB는 캐시 + 검색용)
CREATE TABLE scenarios (
  id          TEXT PRIMARY KEY,        -- ULID
  name        TEXT NOT NULL,
  yaml        TEXT NOT NULL,           -- canonical YAML
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  version     INTEGER NOT NULL         -- 낙관적 락
);

-- run config + 실행 인스턴스
CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  scenario_id     TEXT NOT NULL REFERENCES scenarios(id),
  scenario_yaml   TEXT NOT NULL,       -- 실행 시점 snapshot
  profile_json    TEXT NOT NULL,       -- vus, ramp_up, duration
  env_json        TEXT NOT NULL,
  status          TEXT NOT NULL,       -- pending|running|completed|failed|aborted
  started_at      INTEGER,
  ended_at        INTEGER,
  created_at      INTEGER NOT NULL
);

-- 워커가 보낸 1초 윈도우 집계 메트릭
CREATE TABLE run_metrics (
  run_id           TEXT NOT NULL REFERENCES runs(id),
  ts_second        INTEGER NOT NULL,   -- unix timestamp, 1초 정렬
  step_id          TEXT NOT NULL,      -- scenario step id, 또는 "_all"
  count            INTEGER NOT NULL,
  error_count      INTEGER NOT NULL,
  hdr_histogram    BLOB NOT NULL,      -- HDR Histogram 직렬화 (응답시간 µs)
  status_counts    TEXT NOT NULL,      -- JSON: {"200": 950, "500": 50}
  PRIMARY KEY (run_id, ts_second, step_id)
);
```

`runs.scenario_yaml`을 snapshot으로 두는 이유: 시나리오가 수정돼도 과거 run 결과의 해석이 깨지지 않음 (git commit과 같은 원리).

### 2.10 이 섹션에서 추가된 ADR

- [ADR-0013](../../adr/0013-scenario-runconfig-separation.md) — Scenario / Run Config 분리
- [ADR-0014](../../adr/0014-template-notation.md) — 변수·env·시스템 변수 표기 분리
- [ADR-0015](../../adr/0015-bidirectional-sync-impl.md) — Zustand + Zod + YAML AST round-trip

## 3. Rust 엔진 구조

*(TODO)*

## 4. 웹 UI 구조

*(TODO)*

## 5. 리포트

*(TODO)*

## 6. MVP 1단계 완료 기준

*(TODO)*

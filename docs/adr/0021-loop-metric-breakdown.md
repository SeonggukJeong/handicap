# ADR-0021 — loop 메트릭 breakdown: per-run cap + overflow sentinel, counts-only

* Status: Accepted
* Date: 2026-05-29
* Deciders: handicap maintainers
* Tags: metrics, report, engine, proto, controller, ui

## Context

Slice 7-1은 loop 노드의 리포트에 **반복 인덱스별(per-`loop_index`) 요청·오류 수** breakdown을
추가한다. loop body 안의 HTTP 스텝은 `step_id`로만 집계되었기 때문에 "몇 번째 반복에서 오류가
많았는가"가 리포트에서 보이지 않았다. 이 breakdown을 추가하면서 (a) 집계 카디널리티 폭발 방지
(반복 횟수 × VU × 스텝 수), (b) 레이턴시 집계는 기존 HDR Histogram으로 충분하므로 counts-only
유지, (c) DB 스키마 변경 최소화 등 세 가지를 동시에 만족하는 설계 정책이 필요했다.

설계 명세: `docs/superpowers/specs/2026-05-29-slice-7-loop-node-design.md` §7.

## Decision Drivers

- loop body 안의 특정 반복이 반복적으로 오류를 내는 패턴을 리포트에서 즉시 식별할 수 있어야 한다.
- 집계 카디널리티: `(step_id, loop_index)` 쌍이 per-run `cap`으로 상한이 정해진 상태에서만
  허용 — cap 초과는 DB 행과 네트워크 페이로드를 무한 증가시키지 않는다.
- counts-only (요청·오류 수): 레이턴시 breakdown은 HDR Histogram이 이미 담당하므로 중복 집계
  불필요.
- `runs.profile_json` 저장 방식 덕분에 `runs` 테이블 스키마 변경 없이 새 profile 필드를
  `#[serde(default)]`만으로 도입할 수 있어야 한다.
- Migration은 NEW TABLE(`CREATE TABLE IF NOT EXISTS`)만으로 idempotent 하게 처리할 것
  (Slice-6 `ALTER TABLE ADD COLUMN` idempotency 함정 재발 방지).

## Considered Options

1. **per-run cap + `u32::MAX` overflow sentinel + counts-only** (채택)
   — cap이 0이면 비활성, default 256, max 10000. `loop_index >= cap`은 `u32::MAX` sentinel
   버킷으로 접힘. controller/report는 cap 값을 모르고 sentinel만 `null`로 변환.

2. **cap 없이 모두 수집, DB에 그대로 INSERT**
   — 100회 반복 × 200 VU × 5 스텝 = 100,000 행/run. DB 크기와 gRPC 페이로드를 통제할 방법이
   없음.

3. **고정 cap, 설정 불가 (예: 항상 256)**
   — 운영자가 디버깅용으로 큰 cap이 필요할 때 코드 변경이 필요. ADR-0013(Scenario/RunConfig
   분리) 방향과 어긋남.

4. **counts 대신 full HDR Histogram per loop_index**
   — 카디널리티 × BLOB 크기가 옵션 2보다 훨씬 크고, 기존 step-level HDR가 이미 레이턴시를
   커버하므로 중복 가치가 없음.

## Decision

**옵션 1 선택 (per-run cap + u32::MAX overflow sentinel + counts-only).**

### 파이프라인

```
RunDialog(loop_breakdown_cap)
  → REST POST /api/runs (profile.loop_breakdown_cap)
  → proto Profile.loop_breakdown_cap (u32)
  → engine Aggregator: per-(step_id, loop_index) counts
      loop_index >= cap → sentinel u32::MAX 버킷으로 fold
  → MetricFlush.loop_stats (Vec<LoopStat>)
  → gRPC MetricBatch.loop_stats (delta, NOT cumulative)
  → controller run_loop_metrics 테이블 UPSERT-accumulate
  → GET /api/runs/{id}/report → ReportStep.loop_breakdown
      sentinel u32::MAX → loop_index: null (JSON)
  → UI StepStatsTable 접히는 drill-down
      loop_index: null → "그 외 (상한 초과)" 행 렌더
```

### cap 정책

| 값 | 의미 |
|---|---|
| 0 | breakdown 비활성화 (zero-cost — Aggregator에서 분기 건너뜀) |
| 1–10000 | 해당 수까지 loop_index별 버킷 수집 |
| >10000 | controller에서 400 BadRequest (클라이언트 게이트) |

default: 256 (`#[serde(default = "default_loop_breakdown_cap")]`).

### DB

`run_loop_metrics (run_id TEXT, step_id TEXT, loop_index INTEGER, req_count INTEGER, err_count INTEGER,
PRIMARY KEY (run_id, step_id, loop_index))`.

Migration 0003: `CREATE TABLE IF NOT EXISTS run_loop_metrics (...)` — idempotent. `runs` 테이블
무변경 (profile은 `profile_json` 컬럼에 JSON으로 저장, 기존 행은 `#[serde(default)]`로
`loop_breakdown_cap = 256` 역직렬화).

### 성능

A/B 처리량(SCENARIO_KIND=loop, 200 VUs × 20s, 1KB body): cap=0(off) → 19,086 RPS, p50/p95/p99
= 9/18/26ms; cap=256(on) → 21,254 RPS, p50/p95/p99 = 8/16/23ms. breakdown ON은 run-to-run
변동(±5–7%) 범위 내로 회귀 없음. 이유: flat/cap=0 path는 분기 하나로 zero-cost; in-loop cost는
HashMap 증감 1회, HTTP RTT(≥8ms)에 비해 무시 가능. ADR-0020의 `Box::pin` 오버헤드와 마찬가지로
측정 불가 수준.

## Consequences

**Positive**
- loop body 안의 특정 반복 인덱스에서 오류가 집중되는 패턴을 리포트 드릴다운으로 즉시 식별.
- cap = 0으로 breakdown을 완전히 끄면 engine/gRPC/DB 모두 기존과 동일 path — 성능 영향 없음.
- sentinel 패턴 덕분에 controller는 cap 값을 알 필요가 없고, UI는 `loop_index: null`만 처리.
- `runs` 테이블 스키마 불변 — 기존 운영 DB에서 controller 재시작만으로 기능 활성화.
- `CREATE TABLE IF NOT EXISTS` migration은 무한 재실행해도 안전.

**Negative / Trade-offs**
- cap > 256으로 올리면 DB 행·gRPC 페이로드 크기가 선형 증가. 운영자 책임 (max 10000으로 클라이언트 게이트).
- counts-only: 반복 인덱스별 레이턴시 분포는 알 수 없음. 이 use case는 후속 슬라이스에서 별도
  결정 필요 시 추가.
- overflow sentinel(`u32::MAX`)이 DB/gRPC에 구체적 값으로 노출되어 소비자가 sentinel 의미를
  알아야 한다 — controller의 변환 로직(`u32::MAX → null`) 없이 DB를 직접 읽으면 오해할 수 있음.

## 명시적 연기 (Out of scope)

- **반복 인덱스별 레이턴시 분포** — counts-only로 시작, 필요 시 후속 슬라이스.
- **data-driven loop의 breakdown** — `loop_index`가 아닌 row key 기반 breakdown은 루프 모델
  확장(ADR-0020 "data-driven loop" 연기 항목) 이후.

## Links

- ADR-0020 (control-flow loop 노드) — 이 결정의 전제
- ADR-0012 (워커 메트릭 집계) — 기존 HDR Histogram 파이프라인
- ADR-0017 (MVP 리포트 스코프) — 추가된 loop breakdown은 이 스코프의 확장
- Spec `docs/superpowers/specs/2026-05-29-slice-7-loop-node-design.md` §7 (breakdown 상세),
  §8 (counts-only 및 cap 정책 근거)

# Run 목록 stall 배지 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** run 목록(`ScenarioRunsPage`)의 각 running run 옆에 "⚠ 정지 의심" advisory 배지를 띄워 G1b mid-run stall 감지를 목록까지 확장한다.

**Architecture:** 서버는 runs DTO에 raw `last_metric_ts`(마지막 메트릭 윈도의 wall-clock unix초)를 **목록 경로에서만** 실어 주고(read-path 쿼리 1개 + DTO 필드 1개·engine/proto/migration 0), 클라는 G1b의 임계값(`runStall.ts`)을 재사용하는 순수 헬퍼 `classifyRunStall`로 startup/midrun을 판정해 배지를 렌더한다. advisory-only(run status 절대 불변).

**Tech Stack:** Rust(axum/sqlx, controller) + TypeScript/React(Zod, React Query v5, vitest/RTL).

**관련 문서:** spec `docs/superpowers/specs/2026-06-23-run-list-stall-badge-design.md`(R-id 척추 R1–R10). 선행 G1b `docs/superpowers/specs/2026-06-23-run-stall-advisory-design.md`.

## Global Constraints

이 섹션은 **모든 task에 암묵 적용**된다(spec에서 verbatim).

- **advisory-only(R9)**: run status·report·DB는 절대 변경하지 않는다. 자동 fail은 G1a A/B 소관.
- **engine·worker·proto·migration 0 변경**: 새 read-path 쿼리 + DTO 필드 + UI만. `run_metrics`/`runs`/`ts_second`는 기존 자산.
- **`last_metric_ts`는 목록 경로 전용(FIX-3)**: `list_for_scenario`만 채운다. 단건 GET·run 생성 응답은 `None`(상세 화면은 `useRunMetrics`로 자체 stall 계산 — 무소비). 단건용 단일 store 쿼리는 두지 않는다.
- **임계값 단일 소스(R5)**: `STARTUP_STALL_MS=15_000`/`MIDRUN_STALL_MS=120_000`은 `ui/src/api/runStall.ts`에만. backend 임계 상수·CLI flag 없음.
- **wire 양쪽 동시(R1↔R2)**: Rust DTO 필드(`Option<i64>`)와 UI Zod(`z.number().int().nullish()`)는 같은 브랜치에서 머지(한쪽만 머지 = 드리프트). 서버 None→`null` 직렬화(`skip_serializing_if` 없음)라 `.nullish()`.
- **신규 사용자노출 문구는 `ko.runStall.*` 카탈로그 경유(R10, ADR-0035)**: 하드코딩 영어 0(`title` 포함). G1b `ko.runDetail.midRunStall`와 별도 네임스페이스(다른 표면·문구).
- **라이브 검증 필수(R1·R2·R4)**: 새 DTO 필드가 목록 응답 경로 = S-D 갭. 머지 전 `/live-verify`.
- **게이트·훅**: cargo-영향 커밋은 전체 워크스페이스 게이트(미사용 fn·RED-only 단독 커밋 불가 → green fold). UI 커밋은 `pnpm lint && pnpm test && pnpm build`. **tdd-guard**: `ui/src` non-test 편집 전 *test-path 파일*(`__tests__/*.test.tsx`)을 먼저 편집해 pending diff 생성. Rust는 인라인 `#[cfg(test)]` 있는 파일이라 자동 통과. **spec-review-guard**: plan에 `REVIEW-GATE: APPROVED` 마커 있어야 `ui/src`·`crates/*/src` 편집 허용.

---

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `crates/controller/src/store/metrics.rs` | `last_metric_ts_by_scenario` read-path 쿼리 + 단위테스트 | 1 |
| `crates/controller/src/api/runs.rs` | `RunResponse.last_metric_ts` 필드 + `to_response` arity + 3 호출부 배선 + 단위테스트 | 1 |
| `ui/src/api/runStall.ts` | `classifyRunStall` 코어 추출 + `computeRunStall` 위임 | 2 |
| `ui/src/api/__tests__/runStall.test.ts` | `classifyRunStall` 단위 + `computeRunStall` 회귀 보존 | 2 |
| `ui/src/api/schemas.ts` | `RunSchema.last_metric_ts` Zod 필드 | 3 |
| `ui/src/api/hooks.ts` | `runsRefetchInterval` 헬퍼 + `useScenarioRuns` 폴링 배선 | 3 |
| `ui/src/api/__tests__/runsRefetchInterval.test.ts` | 폴링 predicate 단위 | 3 |
| `ui/src/pages/ScenarioRunsPage.tsx` | Status 칼럼 배지 + `classifyRunStall` 호출 | 3 |
| `ui/src/pages/__tests__/ScenarioRunsPage.test.tsx` | 배지 RTL(midrun/startup 출현·healthy/terminal 미출현) | 3 |
| `ui/src/i18n/ko.ts` | `ko.runStall.*` 문구 | 3 |

---

## Task 1: Backend 신호 — `last_metric_ts` (R1·R3·R4·R9)

**Files:**
- Modify: `crates/controller/src/store/metrics.rs` (새 fn + 테스트)
- Modify: `crates/controller/src/api/runs.rs:32` (DTO 필드), `:1171` (`to_response`), `:900`/`:908`/`:1133` (호출부), 테스트 모듈

**Interfaces:**
- Produces: `pub async fn last_metric_ts_by_scenario(db: &Db, scenario_id: &str) -> sqlx::Result<HashMap<String, i64>>` — running run id → MAX(ts_second). running 아님/메트릭 0이면 맵에 부재.
- Produces: `RunResponse.last_metric_ts: Option<i64>` (JSON `last_metric_ts`, None→`null`). `fn to_response(r: runs::RunRow, last_metric_ts: Option<i64>) -> RunResponse`.

> 이 task는 한 green 커밋(Rust). 미사용 fn 단독 커밋 불가 → store fn + DTO + 핸들러 배선 + 테스트를 한 번에.

- [ ] **Step 1: store 쿼리 fn 작성** (`crates/controller/src/store/metrics.rs`, 기존 `summary` fn 아래에 추가)

```rust
/// running run의 마지막 메트릭 윈도 wall-clock unix초(MAX(ts_second))를 scenario 단위로
/// 한 번에. running 서브쿼리로 좁혀 동적 IN-바인딩을 피한다. running run이 0이거나 그 run의
/// 메트릭이 0이면 맵에 부재(→ 핸들러가 None). G1b 목록 stall 배지의 raw 신호(advisory-only).
pub async fn last_metric_ts_by_scenario(
    db: &Db,
    scenario_id: &str,
) -> sqlx::Result<HashMap<String, i64>> {
    let rows = sqlx::query(
        "SELECT run_id, MAX(ts_second) AS last_ts \
         FROM run_metrics \
         WHERE run_id IN (SELECT id FROM runs WHERE scenario_id = ? AND status = 'running') \
         GROUP BY run_id",
    )
    .bind(scenario_id)
    .fetch_all(db)
    .await?;
    let mut map = HashMap::new();
    for r in rows {
        let run_id: String = r.get("run_id");
        let last_ts: i64 = r.get("last_ts");
        map.insert(run_id, last_ts);
    }
    Ok(map)
}
```

- [ ] **Step 2: store 단위테스트 작성** (`metrics.rs` `#[cfg(test)] mod tests` 안, 기존 `pool()` 헬퍼 재사용)

```rust
#[tokio::test]
async fn last_metric_ts_by_scenario_returns_max_for_running_only() {
    let db = pool().await;
    sqlx::query(
        "INSERT INTO scenarios(id, name, yaml, created_at, updated_at, version) \
         VALUES(?,?,?,?,?,?)",
    )
    .bind("S1")
    .bind("t")
    .bind("version: 1\nname: t\nsteps: []\n")
    .bind(1_i64)
    .bind(1_i64)
    .bind(1_i64)
    .execute(&db)
    .await
    .unwrap();

    // RUN_R: running + 메트릭(ts 100,250) / RUN_T: completed + 메트릭(999, 제외) / RUN_N: running + 메트릭 0(부재)
    for (id, status) in [("RUN_R", "running"), ("RUN_T", "completed"), ("RUN_N", "running")] {
        sqlx::query(
            "INSERT INTO runs(id, scenario_id, scenario_yaml, profile_json, env_json, status, created_at) \
             VALUES(?,?,?,?,?,?,?)",
        )
        .bind(id)
        .bind("S1")
        .bind("version: 1\nname: t\nsteps: []\n")
        .bind("{}")
        .bind("{}")
        .bind(status)
        .bind(1_i64)
        .execute(&db)
        .await
        .unwrap();
    }
    insert_batch(
        &db,
        &[
            MetricRow { run_id: "RUN_R".into(), ts_second: 100, step_id: "s".into(), worker_id: "".into(), count: 5, error_count: 0, hdr_histogram: vec![], status_counts: "{}".into() },
            MetricRow { run_id: "RUN_R".into(), ts_second: 250, step_id: "s".into(), worker_id: "".into(), count: 3, error_count: 0, hdr_histogram: vec![], status_counts: "{}".into() },
            MetricRow { run_id: "RUN_T".into(), ts_second: 999, step_id: "s".into(), worker_id: "".into(), count: 1, error_count: 0, hdr_histogram: vec![], status_counts: "{}".into() },
        ],
    )
    .await
    .unwrap();

    let map = last_metric_ts_by_scenario(&db, "S1").await.unwrap();
    assert_eq!(map.get("RUN_R"), Some(&250)); // MAX over windows, running
    assert_eq!(map.get("RUN_T"), None); // terminal 제외(running 서브쿼리)
    assert_eq!(map.get("RUN_N"), None); // running이나 메트릭 0 → 부재
    assert_eq!(map.len(), 1);
}
```

- [ ] **Step 3: 테스트 RED 확인** (DTO 배선 전엔 컴파일은 되고 store fn만 테스트)

Run: `cargo test -p handicap-controller last_metric_ts_by_scenario`
Expected: PASS (이 fn은 독립). 만약 컴파일 에러면 import(`HashMap`/`Row`는 이미 metrics.rs에 있음) 확인.

- [ ] **Step 4: DTO 필드 추가** (`crates/controller/src/api/runs.rs`, `RunResponse` struct `:32`, `verdict` 필드 바로 아래)

```rust
    /// A4a SLO verdict(완료 run, criteria 있을 때만 non-null). 목록 배지용.
    pub verdict: Option<crate::report::Verdict>,
    /// 마지막 메트릭 윈도의 wall-clock unix초(running run 진행 stall 판정용, G1b 목록 배지).
    /// running이 아니거나 메트릭 0이면 None. advisory-only — list 경로만 채운다(FIX-3).
    pub last_metric_ts: Option<i64>,
```

- [ ] **Step 5: `to_response` arity 변경** (`runs.rs:1171`)

```rust
fn to_response(r: runs::RunRow, last_metric_ts: Option<i64>) -> RunResponse {
    RunResponse {
        id: r.id,
        scenario_id: r.scenario_id,
        scenario_yaml: r.scenario_yaml,
        status: r.status,
        profile: r.profile,
        env: r.env,
        started_at: r.started_at,
        ended_at: r.ended_at,
        created_at: r.created_at,
        message: r.message,
        verdict: r.verdict,
        last_metric_ts,
    }
}
```

- [ ] **Step 6: `create`·`get` 호출부 — None 전달** (`runs.rs:900`, `:908`)

`create`(`:900` 부근, 마지막 줄): `Ok((StatusCode::CREATED, Json(to_response(row, None))))`
`get`(`:908` 부근, 마지막 줄): `Ok(Json(to_response(row, None)))`

- [ ] **Step 7: `list_for_scenario` 호출부 — 맵 조회 + running만 채움** (`runs.rs:1123` 본문)

```rust
    let rows = runs::list_by_scenario(&state.db, &scenario_id).await?;
    let last_ts =
        crate::store::metrics::last_metric_ts_by_scenario(&state.db, &scenario_id).await?;
    Ok(Json(RunListResponse {
        runs: rows
            .into_iter()
            .map(|r| {
                let lt = if matches!(r.status, RunStatus::Running) {
                    last_ts.get(&r.id).copied()
                } else {
                    None
                };
                to_response(r, lt)
            })
            .collect(),
    }))
```

(`RunStatus`는 `use crate::store::runs::{self, Profile, RunStatus};`로 이미 in scope.)

> **R4 핸들러 분기는 별도 단위테스트를 두지 않는다(검토 F1/F2 회피, 의도적).** `to_response`의 `last_metric_ts` 필드-세팅은 `RunResponse`가 `Default`를 안 가져 **컴파일러가 강제**(필드 누락 시 빌드 실패)하고, list 클로저의 `matches!(r.status, RunStatus::Running)` 분기는 자명하다. 실제 검증 가치(running→number·non-running→null)는 **라이브(Task 4)** 가 실 목록 응답에서 양 arm을 확인해 닫는다(B6 verdict-badge 슬라이스와 동일 DTO-필드 검증 패턴 — 격리 핸들러 테스트는 full `AppState`+coordinator+`Profile` 17-필드 리터럴+FK 시드가 필요해 3줄 map 클로저에 불비례). store 쿼리(Step 2)가 R3을, 라이브가 R1·R4를 닫는다.

- [ ] **Step 8: 전체 빌드/테스트 GREEN 확인**

Run: `cargo build -p handicap-worker && cargo test -p handicap-controller last_metric_ts_by_scenario`
Expected: store 테스트 PASS + 전체 컴파일 성공(DTO 필드·`to_response` arity·3 호출부 배선). (워커 먼저 빌드 = cold-build flake 예방, 루트 CLAUDE.md.)

- [ ] **Step 9: Commit** (foreground, 단일 호출, 파이프 금지)

```bash
git add crates/controller/src/store/metrics.rs crates/controller/src/api/runs.rs
git commit -m "feat(controller): runs DTO last_metric_ts (목록 stall 신호, list-only)"
```

직후 `git log -1 --oneline`로 landed 확인.

---

## Task 2: UI 헬퍼 — `classifyRunStall` 코어 추출 (R5·R6)

**Files:**
- Modify: `ui/src/api/runStall.ts`
- Test: `ui/src/api/__tests__/runStall.test.ts` (기존 G1b 테스트에 `classifyRunStall` 케이스 추가)

**Interfaces:**
- Consumes: `STARTUP_STALL_MS`/`MIDRUN_STALL_MS`/`RunStall`/`NONE`(기존), `RunStatus`(`./schemas`).
- Produces: `export function classifyRunStall(status: RunStatus, startedMs: number, lastMetricTs: number | null, nowMs: number): RunStall` — startup/midrun 임계값·kind 단일 소스. `computeRunStall`(상세, 시그니처 불변)이 이걸로 위임.

> UI task — **test-path 파일을 먼저 편집**(tdd-guard). `runStall.test.ts`에 `classifyRunStall` describe를 추가하는 것이 첫 편집.

- [ ] **Step 1: 실패 테스트 먼저** (`ui/src/api/__tests__/runStall.test.ts` — 파일 끝에 새 describe 추가, **기존 `computeRunStall` describe는 그대로 둔다**)

```ts
import { classifyRunStall, computeRunStall, MIDRUN_STALL_MS, STARTUP_STALL_MS } from "../runStall";
// (위 import 줄에 classifyRunStall을 추가)

describe("classifyRunStall (목록 직접 진입점)", () => {
  const NOW = 1_000_000_000_000;
  const NOW_SEC = Math.floor(NOW / 1000);

  it("비-running → none", () => {
    expect(classifyRunStall("completed", NOW - 1_000, null, NOW)).toEqual({ kind: "none", silentSeconds: 0 });
  });
  it("running + lastMetricTs null + STARTUP 초과 → startup", () => {
    expect(classifyRunStall("running", NOW - 20_000, null, NOW).kind).toBe("startup");
  });
  it("running + lastMetricTs null + STARTUP 미만 → none", () => {
    expect(classifyRunStall("running", NOW - 3_000, null, NOW).kind).toBe("none");
  });
  it("running + lastMetricTs 최근(침묵 2s) → none", () => {
    expect(classifyRunStall("running", NOW - 1_000, NOW_SEC - 2, NOW).kind).toBe("none");
  });
  it("MIDRUN 경계: 침묵 120s none, 121s midrun(silentSeconds=121)", () => {
    expect(classifyRunStall("running", NOW - 1_000, NOW_SEC - 120, NOW).kind).toBe("none");
    const r = classifyRunStall("running", NOW - 1_000, NOW_SEC - 121, NOW);
    expect(r).toEqual({ kind: "midrun", silentSeconds: 121 });
  });
});
```

- [ ] **Step 2: 테스트 RED 확인**

Run: `cd ui && pnpm test runStall`
Expected: FAIL (`classifyRunStall is not a function` / import 에러).

- [ ] **Step 3: `classifyRunStall` 추출 + `computeRunStall` 위임** (`ui/src/api/runStall.ts`)

`import type { Run, WindowSummary } from "./schemas";` 줄에 `RunStatus`를 추가(`Run`은 type, `RunStatus`도 type):
```ts
import type { Run, RunStatus, WindowSummary } from "./schemas";
```

기존 `computeRunStall` 함수를 아래로 교체(코어 추출 + 위임):
```ts
/**
 * stall 판정 코어(백엔드 무관). startup/midrun 임계값·kind의 단일 소스.
 * - lastMetricTs === null: 메트릭 없음 → startup 후보(시작 후 STARTUP_STALL_MS 초과 시 startup).
 * - lastMetricTs !== null: 마지막 메트릭(wall-clock unix초) 이후 MIDRUN_STALL_MS 초과 침묵 → midrun.
 * 상세(`computeRunStall`)·목록(`ScenarioRunsPage`)이 공유한다.
 */
export function classifyRunStall(
  status: RunStatus,
  startedMs: number,
  lastMetricTs: number | null,
  nowMs: number,
): RunStall {
  if (status !== "running") return NONE;
  if (lastMetricTs === null) {
    return nowMs - startedMs > STARTUP_STALL_MS ? { kind: "startup", silentSeconds: 0 } : NONE;
  }
  const silence = Math.floor(nowMs / 1000) - lastMetricTs;
  return silence * 1000 > MIDRUN_STALL_MS ? { kind: "midrun", silentSeconds: silence } : NONE;
}

/**
 * run의 진행 stall 상태를 순수 계산한다(상세 화면 — 메트릭 윈도 입력).
 * 메트릭 미도착(windows===undefined)이면 판정하지 않는다(첫 RTT 배너 플래시 방지).
 * 그 외는 windows에서 totalCount/maxTs를 도출해 classifyRunStall로 위임.
 */
export function computeRunStall(
  run: Pick<Run, "status" | "started_at" | "created_at">,
  windows: readonly WindowSummary[] | undefined,
  nowMs: number,
): RunStall {
  if (run.status !== "running") return NONE;
  if (windows === undefined) return NONE;

  const totalCount = windows.reduce((acc, w) => acc + w.count, 0);
  let maxTs = 0;
  for (const w of windows) if (w.ts_second > maxTs) maxTs = w.ts_second;

  return classifyRunStall(
    run.status,
    run.started_at ?? run.created_at,
    totalCount > 0 ? maxTs : null,
    nowMs,
  );
}
```

(`STARTUP_STALL_MS`/`MIDRUN_STALL_MS`/`RunStall`/`RunStallKind`/`NONE` export·정의는 그대로 유지.)

- [ ] **Step 4: 테스트 GREEN 확인 (신규 + 기존 회귀)**

Run: `cd ui && pnpm test runStall`
Expected: PASS — 신규 `classifyRunStall` describe + **기존 `computeRunStall` 10케이스 전부**(위임 후 동작 불변, R6).

- [ ] **Step 5: UI 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0, 전체 테스트 PASS, `tsc -b`+vite build 성공.

- [ ] **Step 6: Commit**

```bash
git add ui/src/api/runStall.ts ui/src/api/__tests__/runStall.test.ts
git commit -m "refactor(ui): classifyRunStall 코어 추출(상세/목록 stall 단일 소스)"
```

---

## Task 3: UI 통합 — Zod + 폴링 + 배지 + ko (R2·R7·R8·R10)

**Files:**
- Modify: `ui/src/api/schemas.ts:181` (`RunSchema`)
- Modify: `ui/src/api/hooks.ts:114` (`runsRefetchInterval` + `useScenarioRuns`)
- Test: `ui/src/api/__tests__/runsRefetchInterval.test.ts` (신규)
- Modify: `ui/src/pages/ScenarioRunsPage.tsx` (배지)
- Test: `ui/src/pages/__tests__/ScenarioRunsPage.test.tsx` (배지 RTL)
- Modify: `ui/src/i18n/ko.ts` (`ko.runStall`)

**Interfaces:**
- Consumes: `classifyRunStall`(Task 2), `RunSchema.last_metric_ts`(이 task).
- Produces: `export function runsRefetchInterval(data: { runs: { status: RunStatus }[] } | undefined): number | false`. `ko.runStall.{badge, badgeTitleMidrun, badgeTitleStartup}`.

> UI task — **test-path 파일 먼저**(tdd-guard): `runsRefetchInterval.test.ts`(신규) + `ScenarioRunsPage.test.tsx` 편집이 첫 diff. 그래야 `schemas.ts`/`hooks.ts`/`ScenarioRunsPage.tsx`/`ko.ts` 편집이 unblock.

- [ ] **Step 1: 폴링 predicate 실패 테스트** (`ui/src/api/__tests__/runsRefetchInterval.test.ts` 신규)

```ts
import { describe, expect, it } from "vitest";
import { runsRefetchInterval } from "../hooks";

describe("runsRefetchInterval", () => {
  it("데이터 없음 → false", () => {
    expect(runsRefetchInterval(undefined)).toBe(false);
  });
  it("running 없음 → false", () => {
    expect(runsRefetchInterval({ runs: [{ status: "completed" }, { status: "failed" }] })).toBe(false);
  });
  it("running 있음 → 5000", () => {
    expect(runsRefetchInterval({ runs: [{ status: "completed" }, { status: "running" }] })).toBe(5000);
  });
});
```

- [ ] **Step 2: 배지 RTL 실패 테스트** (`ui/src/pages/__tests__/ScenarioRunsPage.test.tsx`)

먼저 `makeRun` 헬퍼(`:180`)에 `lastMetricTs` 4번째 인자 추가(기존 3-인자 호출 호환):
```ts
function makeRun(id: string, status: string, createdAt: number, lastMetricTs: number | null = null) {
  return {
    id,
    scenario_id: "S1",
    scenario_yaml: SCENARIO_YAML,
    status,
    profile: { vus: 2, ramp_up_seconds: 0, duration_seconds: 5, loop_breakdown_cap: 256 },
    env: {},
    started_at: createdAt,
    ended_at: createdAt + 1,
    created_at: createdAt,
    last_metric_ts: lastMetricTs,
  };
}
```

파일 끝에 배지 describe 추가:
```ts
describe("ScenarioRunsPage — stall 배지 (G1b 목록)", () => {
  it("running + 오래된 last_metric_ts → 정지 의심 배지(midrun)", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockApiRuns([makeRun("RUN1", "running", Date.now() - 5_000, nowSec - 300)]);
    renderPageWithCompare();
    expect(await screen.findByText(/정지 의심/)).toBeInTheDocument();
  });

  it("running + 메트릭 0 + 시작 후 오래 → 정지 의심 배지(startup)", async () => {
    mockApiRuns([makeRun("RUN1", "running", Date.now() - 30_000, null)]);
    renderPageWithCompare();
    expect(await screen.findByText(/정지 의심/)).toBeInTheDocument();
  });

  it("running + 최근 last_metric_ts → 배지 없음(healthy)", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockApiRuns([makeRun("RUN1", "running", Date.now() - 5_000, nowSec - 2)]);
    renderPageWithCompare();
    await screen.findByLabelText(ko.report.selectRunAria("RUN1"));
    expect(screen.queryByText(/정지 의심/)).toBeNull();
  });

  it("terminal run → 배지 없음", async () => {
    mockApiRuns([makeRun("C1", "completed", Date.now() - 30_000, null)]);
    renderPageWithCompare();
    await screen.findByLabelText(ko.report.selectRunAria("C1"));
    expect(screen.queryByText(/정지 의심/)).toBeNull();
  });
});
```

(`ko.report.selectRunAria(id)`는 모든 행 체크박스의 aria-label — running 행도 렌더되므로 `findByLabelText`로 렌더 settle 후 부재 단언.)

- [ ] **Step 3: 테스트 RED 확인**

Run: `cd ui && pnpm test runsRefetchInterval ScenarioRunsPage`
Expected: FAIL (`runsRefetchInterval` 미정의 / 배지 텍스트 없음).

- [ ] **Step 4: Zod 필드 추가** (`ui/src/api/schemas.ts`, `RunSchema`의 `verdict` 줄 아래)

```ts
  // A4a SLO verdict, 완료 시 영속(목록 배지). 서버 None→null이라 .nullish().
  verdict: VerdictSchema.nullish(),
  // G1b 목록 stall 배지: 마지막 메트릭 윈도 wall-clock unix초. running list 경로만 number,
  // 그 외/메트릭0은 서버에서 null. 서버 항상-직렬화(skip_serializing_if 없음)라 .nullish().
  last_metric_ts: z.number().int().nullish(),
```

- [ ] **Step 5: 폴링 predicate + 배선** (`ui/src/api/hooks.ts`)

`useScenarioRuns`(`:114`) 위에 헬퍼 추가:
```ts
/** 목록에 running run이 있으면 5s 폴링(stall 배지 신선도 — frozen last_metric_ts 오탐 방지),
 *  없으면 정지. 임계 120s ≫ 5s라 healthy 오탐 구조적 불가. G1b 목록 배지. */
export function runsRefetchInterval(
  data: { runs: { status: RunStatus }[] } | undefined,
): number | false {
  return data?.runs.some((r) => r.status === "running") ? 5000 : false;
}
```

`useScenarioRuns`에 `refetchInterval` 추가:
```ts
export function useScenarioRuns(scenarioId: string | undefined) {
  return useQuery({
    queryKey: scenarioId ? queryKeys.scenarioRuns(scenarioId) : ["scenarios", "missing", "runs"],
    queryFn: () => api.listRunsForScenario(scenarioId!),
    enabled: Boolean(scenarioId),
    refetchInterval: (q) => runsRefetchInterval(q.state.data),
  });
}
```

(`RunStatus`는 `hooks.ts`에 이미 import됨 — `const TERMINAL: ReadonlyArray<RunStatus>` 사용 중. 없으면 `import type { RunStatus } from "./schemas";` 추가.)

- [ ] **Step 6: ko 문구 추가** (`ui/src/i18n/ko.ts`, `runDetail:` 블록 *뒤*에 새 네임스페이스 — 또는 알파벳/논리 위치 자유)

```ts
  runStall: {
    badge: "정지 의심",
    badgeTitleMidrun: (d: string) => `${d} 진행 없음 — 워커가 멈췄을 수 있어요`,
    badgeTitleStartup: "부하 시작 전 — 워커가 멈췄을 수 있어요",
  },
```

- [ ] **Step 7: 배지 렌더** (`ui/src/pages/ScenarioRunsPage.tsx`)

import 추가:
```ts
import { classifyRunStall } from "../api/runStall";
```

`allRuns.map((r) => { ... })` 본문에서 `normalised`/`env` 옆에 stall 계산:
```ts
const normalised = normalizeProfile(r.profile);
const env = envValueToRecord(r.env);
const stall = classifyRunStall(r.status, r.started_at ?? r.created_at, r.last_metric_ts ?? null, now);
```

Status 칼럼(`<StatusBadge status={r.status} />` 셀)을 배지 포함으로:
```tsx
<td className="py-3 pr-4">
  <StatusBadge status={r.status} />
  {stall.kind !== "none" && (
    <span
      className="ml-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800"
      title={
        stall.kind === "midrun"
          ? ko.runStall.badgeTitleMidrun(formatDurationKo(stall.silentSeconds))
          : ko.runStall.badgeTitleStartup
      }
    >
      ⚠ {ko.runStall.badge}
    </span>
  )}
</td>
```

(`now`·`formatDurationKo`는 이미 import/계산됨 — `now = useNow(hasRunning ? 1000 : null)`, `formatDurationKo` import `:6`.)

- [ ] **Step 8: 테스트 GREEN 확인**

Run: `cd ui && pnpm test runsRefetchInterval ScenarioRunsPage runStall`
Expected: 신규 배지 4케이스 + predicate 3케이스 PASS, 기존 ScenarioRunsPage 테스트(retry/compare/verdict/elapsed/empty) 전부 PASS(회귀 0 — terminal 행 `last_metric_ts:null`이라 배지 없음).

> **참고(FR1·무해)**: 기존 *running-row* fixture 2개(compare 테스트 `R1` created_at=300·elapsed 테스트 `RUN1` started_at=`Date.now()-90_000`)는 `last_metric_ts:null`+오래된 `started_at`이라 이제 **startup 배지("정지 의심")가 DOM에 렌더**된다. 두 테스트 모두 배지 부재를 단언하지 않으므로(체크박스 disabled·경과 텍스트만 검사) **PASS 유지** — 구현자가 그 배지를 보고 당황하지 말 것(의도된 부수효과, 회귀 아님).

- [ ] **Step 9: UI 게이트(전체)**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0(`--max-warnings=0`), 전체 PASS, `tsc -b`+build 성공. (`pnpm test` 인자 없이 전체 1회 — targeted green ≠ full green, ui/CLAUDE.md.)

- [ ] **Step 10: Commit**

```bash
git add ui/src/api/schemas.ts ui/src/api/hooks.ts ui/src/api/__tests__/runsRefetchInterval.test.ts ui/src/pages/ScenarioRunsPage.tsx ui/src/pages/__tests__/ScenarioRunsPage.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): 목록 stall 배지 + last_metric_ts Zod + running 폴링 (G1b)"
```

---

## Task 4: 라이브 검증 (R1·R2·R4 — S-D 갭) — 커밋 없음

> 새 DTO 필드가 **목록 응답 경로**에 실리므로 RTL fixture(absent-not-null)가 못 잡는 S-D 갭. 머지 전 실 백엔드로 `last_metric_ts`(running=number·terminal=null)와 실 `RunListSchema` 파싱을 확인한다. `/live-verify` 스킬로 스택 기동.

- [ ] **Step 1: 라이브 스택 기동** — `/live-verify`(워크트리 자체 바이너리 + 50ms responder + 격리 DB). 먼저 `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller`, 상대경로 `./target/debug/controller --db /tmp/stall-badge.db --ui-dir ui/dist …`.

- [ ] **Step 2: running run 목록 응답에 `last_metric_ts`(number)** — 시나리오 생성 → run 생성(closed-loop, 메트릭이 흐르게 짧은 think-time 없이) → 메트릭 1초+ 흐른 뒤:
```
curl -s http://127.0.0.1:8080/api/scenarios/<sid>/runs | python3 -c "import sys,json; d=json.load(sys.stdin); [print(r['id'], r['status'], r['last_metric_ts']) for r in d['runs']]"
```
Expected: running run은 `last_metric_ts`가 number(최근 unix초), terminal run은 `null`.

- [ ] **Step 3: 실 `RunListSchema` 파싱(S-D)** — 위 응답 JSON을 `ui/src/api/__tests__/`에 throwaway 테스트로 저장 → `readFileSync` + `RunListSchema.safeParse`(실패 시 `r.error.issues` throw) → 돌리고 삭제(커밋 안 함). 또는 Playwright로 `/scenarios/<sid>/runs` 진입 후 콘솔 Zod 0 확인. (`.nullish()`↔서버-null 미스매치 차단.)

- [ ] **Step 4: 배지 표면(선택, Playwright)** — `kill -STOP <worker pid>`로 메트릭 침묵 유발 후 목록 페이지에서 배지 출현 확인(120s 대기는 RTL이 이미 증명 — 라이브는 **신호 배선+Zod**가 목적이라 배지 타이밍 자체는 필수 아님). 정리: `.playwright-mcp` + 루트 png 삭제.

- [ ] **Step 5: 결과를 finish-slice 라이브검증 노트로** — `last_metric_ts` running=number/terminal=null + Zod 통과를 build-log에 기록.

---

## Self-Review (작성자 체크)

**1. Spec coverage** — R1(Task1 Step4·DTO + Task4 라이브)·R2(Task3 Step4·Zod)·R3(Task1 Step1-2·store fn+test)·R4(Task1 Step7·list 배선; 핸들러 분기는 Task4 라이브가 running=number/terminal=null로 검증·필드-세팅은 컴파일러 강제)·R5(Task2 Step3·classifyRunStall)·R6(Task2 Step4·computeRunStall 회귀)·R7(Task3 Step7·배지+Step2 RTL)·R8(Task3 Step5·runsRefetchInterval+Step1 test)·R9(Global Constraints·Task1 None 전달·grep)·R10(Task3 Step6·ko.runStall). 전부 task 매핑됨.

**2. Placeholder scan** — 모든 코드 step에 실제 코드 포함, TBD/TODO 없음.

**3. Type consistency** — `classifyRunStall(status, startedMs, lastMetricTs, nowMs)` 시그니처가 Task2 정의 ↔ Task3 호출(`r.status, r.started_at ?? r.created_at, r.last_metric_ts ?? null, now`) 일치. `runsRefetchInterval(data)` Task3 정의 ↔ test 호출 일치. `to_response(row, Option<i64>)` Task1 정의 ↔ 3 호출부 일치. `last_metric_ts` 필드명 Rust(`Option<i64>`)↔Zod(`z.number().int().nullish()`)↔fixture(`last_metric_ts`) 일치.

<!-- REVIEW-GATE: APPROVED -->

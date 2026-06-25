# 곡선 fan-out 워커 표시 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** closed-loop VU 곡선 fan-out run(N≥2)의 RunDetailPage에서 워커 수와 per-worker active-VU 분해(합계↔워커별 토글)를 보여준다 — 데이터는 `run_active_vu_metrics`에 이미 있고, controller read-path + UI만 손댄다.

**Architecture:** 새 store 읽기 `active_vu_by_worker`(non-SUM, legacy `''` 제외)를 추가하고, `build_report`에 9번째 슬라이스 인자로 per-worker 행을 받아 `ReportJson.active_vu_by_worker`(distinct non-empty worker ≥2일 때만 채움, `skip_serializing_if`로 비면 생략)를 emit한다. caller `build_report_for_run`이 `is_vu_curve()`일 때만 fetch(곡선 한정·비-곡선 쿼리 skip). UI `ActiveVuChart`가 `byWorker` prop을 받아 `[합계|워커별]` 토글 + per-worker 라인 + 캡션을 렌더한다.

**Tech Stack:** Rust(axum/sqlx/serde) controller · React/TS + Zod + Recharts UI.

## Global Constraints

이 슬라이스의 모든 task에 적용 (spec §2/§5에서 verbatim):

- **migration 0 · proto 0 · engine 0 · worker 0** — 변경은 `crates/controller/src`(read-path) + `ui/`(+docs)만 (R11). `git diff --name-only master..HEAD`에 `.sql`/`crates/engine`/`crates/worker`/`crates/proto`/`.proto`가 보이면 안 됨.
- **기존 모든 리포트 byte-identical** — 단일워커·비-곡선·fixed run은 `active_vu_by_worker`가 빈 Vec → `skip_serializing_if="Vec::is_empty"`로 직렬화 생략 → 기존 JSON·기존 `active_vu_series`(SUM) read·골든 fixture(`testdata/compare_golden.json`) 전부 무변경 (R4).
- **워커 수 N은 `active_vu_by_worker` 단일 소스** — 별도 count 필드/쿼리 금지; UI는 `byWorker.length`로만 N을 도출 (R5).
- **모든 신규 사용자 문구는 `ko.ts` 경유** (ADR-0035, R10) — 신규 컴포넌트에 인라인 한국어/영어 리터럴 0.
- **Zod는 `.optional()` + 소비처 `?? []`** (repo 선례 `active_vu_series`/`if_breakdown`; top-level `.default()`는 `request<T>` 누출 위험 — ui/CLAUDE.md) (R6).
- **곡선 한정은 caller(`build_report_for_run`)가 `is_vu_curve()`로 게이트**, build_report 내부 게이트는 **distinct non-empty worker_id ≥ 2** 하나뿐 (R3).

---

## Task A: Controller read-path (store fn + report field/gate + caller)

**Files:**
- Modify: `crates/controller/src/store/metrics.rs` (신규 `active_vu_by_worker` fn + 인라인 test)
- Modify: `crates/controller/src/report.rs` (신규 `WorkerActiveVuSeries` struct + `ReportJson.active_vu_by_worker` 필드 + `build_report` 9번째 인자 + 게이트 + 인라인 test 2개; 기존 build_report 호출부 26곳 trailing `&[]`)
- Modify: `crates/controller/src/api/runs.rs:921` (`build_report_for_run` fetch + 9번째 인자 전달 — 27번째 호출부)
- Modify: `crates/controller/src/export.rs:487` (`report_with_steps` `ReportJson` 리터럴에 `active_vu_by_worker: vec![]`)

**Interfaces:**
- Produces (Task B가 와이어로 소비):
  - `ReportJson.active_vu_by_worker: Vec<WorkerActiveVuSeries>` (snake_case JSON 키 `active_vu_by_worker`, 비면 생략)
  - `WorkerActiveVuSeries { worker_id: String, samples: Vec<ActiveVuSample> }` where `ActiveVuSample { ts_second: i64, desired: u32, actual: u32 }`
- Consumes (기존): `crate::store::metrics::ActiveVuRow { run_id: String, ts_second: i64, desired: i64, actual: i64, worker_id: String }` (재사용), `RunRow.profile.is_vu_curve() -> bool`.

- [ ] **Step 1: Write the failing store test**

`crates/controller/src/store/metrics.rs` 의 `#[cfg(test)] mod tests`(파일 끝, line ~425) 안에 추가:

```rust
    #[tokio::test]
    async fn active_vu_by_worker_groups_per_worker_and_excludes_legacy() {
        let db = pool().await;
        // run_active_vu_metrics는 FK 없음(migration 0016) — 직접 insert.
        insert_active_vu_batch(
            &db,
            &[
                ActiveVuRow { run_id: "R1".into(), ts_second: 100, desired: 3, actual: 2, worker_id: "w-1".into() },
                ActiveVuRow { run_id: "R1".into(), ts_second: 100, desired: 2, actual: 2, worker_id: "w-0".into() },
                ActiveVuRow { run_id: "R1".into(), ts_second: 101, desired: 4, actual: 4, worker_id: "w-0".into() },
                // legacy backfill sentinel (migration 0018) — must be excluded.
                ActiveVuRow { run_id: "R1".into(), ts_second: 100, desired: 9, actual: 9, worker_id: "".into() },
            ],
        )
        .await
        .unwrap();

        let rows = active_vu_by_worker(&db, "R1").await.unwrap();
        // '' excluded; ordered by worker_id then ts_second.
        assert_eq!(rows.len(), 3);
        assert_eq!((rows[0].worker_id.as_str(), rows[0].ts_second), ("w-0", 100));
        assert_eq!((rows[1].worker_id.as_str(), rows[1].ts_second), ("w-0", 101));
        assert_eq!((rows[2].worker_id.as_str(), rows[2].ts_second), ("w-1", 100));
    }
```

- [ ] **Step 2: Run the store test to verify it fails**

Run: `cargo test -p handicap-controller active_vu_by_worker_groups_per_worker --lib`
Expected: FAIL — `cannot find function active_vu_by_worker in this scope` (compile error).

- [ ] **Step 3: Implement the store fn**

`crates/controller/src/store/metrics.rs`, 기존 `active_vu_series`(line ~405) 바로 아래(같은 `pub async fn` 형제로) 추가:

```rust
/// Per-worker active-VU rows (NOT SUM-merged), for the curve fan-out breakdown.
/// Excludes the legacy `''` worker_id (migration 0018 backfill / SUM-read output) —
/// production ingest always writes a non-empty worker_id. Ordered worker_id, ts_second.
pub async fn active_vu_by_worker(db: &Db, run_id: &str) -> sqlx::Result<Vec<ActiveVuRow>> {
    let rows = sqlx::query(
        "SELECT ts_second, worker_id, desired, actual \
         FROM run_active_vu_metrics WHERE run_id = ? AND worker_id <> '' \
         ORDER BY worker_id, ts_second",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| ActiveVuRow {
            run_id: run_id.to_string(),
            ts_second: r.get("ts_second"),
            worker_id: r.get("worker_id"),
            desired: r.get("desired"),
            actual: r.get("actual"),
        })
        .collect())
}
```

- [ ] **Step 4: Run the store test to verify it passes**

Run: `cargo test -p handicap-controller active_vu_by_worker_groups_per_worker --lib`
Expected: PASS.

- [ ] **Step 5: Write the failing report tests**

`crates/controller/src/report.rs` 의 `#[cfg(test)] mod tests` 안(예: 기존 `build_report_attaches_active_vu_series_without_polluting_summary` 근처)에 추가:

```rust
    #[test]
    fn build_report_attaches_active_vu_by_worker_for_multiworker() {
        use crate::store::metrics::ActiveVuRow;
        let r = run_row();
        let yaml = r.scenario_yaml.clone();
        // Two workers; rows intentionally out of worker order to verify sorting.
        let by_worker = vec![
            ActiveVuRow { run_id: r.id.clone(), ts_second: 100, desired: 2, actual: 2, worker_id: "w-1".into() },
            ActiveVuRow { run_id: r.id.clone(), ts_second: 100, desired: 3, actual: 1, worker_id: "w-0".into() },
            ActiveVuRow { run_id: r.id.clone(), ts_second: 101, desired: 3, actual: 3, worker_id: "w-0".into() },
        ];
        let rep = build_report(&r, &yaml, &[], &[], &[], &[], &[], &[], &by_worker);
        assert_eq!(rep.active_vu_by_worker.len(), 2);
        assert_eq!(rep.active_vu_by_worker[0].worker_id, "w-0"); // sorted
        assert_eq!(rep.active_vu_by_worker[0].samples.len(), 2);
        assert_eq!(
            (rep.active_vu_by_worker[0].samples[0].desired, rep.active_vu_by_worker[0].samples[0].actual),
            (3, 1)
        );
        assert_eq!(rep.active_vu_by_worker[1].worker_id, "w-1");
    }

    #[test]
    fn build_report_no_active_vu_by_worker_for_single_or_none() {
        use crate::store::metrics::ActiveVuRow;
        let r = run_row();
        // Single worker -> distinct < 2 -> empty.
        let one = vec![ActiveVuRow { run_id: r.id.clone(), ts_second: 100, desired: 1, actual: 1, worker_id: "w-0".into() }];
        let rep = build_report(&r, "", &[], &[], &[], &[], &[], &[], &one);
        assert!(rep.active_vu_by_worker.is_empty());
        // No rows (non-curve caller passes &[]) -> empty (byte-identical default).
        let none = build_report(&r, "", &[], &[], &[], &[], &[], &[], &[]);
        assert!(none.active_vu_by_worker.is_empty());
    }
```

> Note: build_report 내부 게이트는 `is_vu_curve`가 아니라 distinct≥2 하나뿐이므로 이 테스트들은 곡선 profile이 필요 없다(곡선 한정은 caller가 담당, Step 9에서 검증). `run_row()` 기본 profile 그대로 사용.

- [ ] **Step 6: Run the report tests to verify they fail (compile error)**

Run: `cargo test -p handicap-controller build_report_attaches_active_vu_by_worker --lib`
Expected: FAIL — `no field active_vu_by_worker on type ReportJson` and `build_report` takes 8 args, not 9 (compile errors). 이는 정상 RED(필드/인자 미존재).

- [ ] **Step 7: Add the struct, field, 9th param, and gate**

7a. `crates/controller/src/report.rs` — `ActiveVuSample` struct(line ~177) 아래에 신규 struct 추가:

```rust
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct WorkerActiveVuSeries {
    pub worker_id: String,
    pub samples: Vec<ActiveVuSample>,
}
```

7b. `ReportJson` struct(line ~13) — `active_vu_series`(line 33) 와 `connection`(line 34) **사이**에 필드 추가:

```rust
    #[serde(default)]
    pub active_vu_series: Vec<ActiveVuSample>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub active_vu_by_worker: Vec<WorkerActiveVuSeries>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<ConnectionStats>,
```

7c. `build_report` 시그니처(line ~412) — `active_vu` 인자 뒤에 9번째 인자 추가:

```rust
pub fn build_report(
    run: &RunRow,
    scenario_yaml: &str,
    rows: &[WindowWithHdr],
    loops: &[LoopMetricRow],
    branches: &[IfBranchRow],
    groups: &[GroupMetricRow],
    phases: &[PhaseMetricRow],
    active_vu: &[crate::store::metrics::ActiveVuRow],
    active_vu_by_worker: &[crate::store::metrics::ActiveVuRow],
) -> ReportJson {
```

7d. `build_report` 본문 — 기존 `active_vu_series` 매핑(line ~779) 바로 아래에 per-worker 도출 추가(`BTreeMap`은 이미 `use std::collections::BTreeMap;` line 11로 임포트됨):

```rust
    // Per-worker active-VU series. Curve fan-out only (caller passes &[] for non-curve);
    // populate ONLY when ≥2 distinct non-empty workers so single-worker stays byte-identical.
    // BTreeMap key = worker_id => deterministic sorted output (ordinal labels in UI).
    let worker_vu: Vec<WorkerActiveVuSeries> = {
        let mut by: BTreeMap<String, Vec<ActiveVuSample>> = BTreeMap::new();
        for r in active_vu_by_worker {
            if r.worker_id.is_empty() {
                continue; // defensive — query already excludes '' legacy rows.
            }
            by.entry(r.worker_id.clone()).or_default().push(ActiveVuSample {
                ts_second: r.ts_second,
                desired: r.desired as u32,
                actual: r.actual as u32,
            });
        }
        if by.len() >= 2 {
            by.into_iter()
                .map(|(worker_id, samples)| WorkerActiveVuSeries { worker_id, samples })
                .collect()
        } else {
            Vec::new()
        }
    };
```

7e. `build_report`의 `ReportJson { … }` 리터럴(line ~788) — `active_vu_series` 와 `connection` 사이에 필드 추가:

```rust
        active_vu_series,
        active_vu_by_worker: worker_vu,
        connection,
```

7f. **기존 build_report 호출부 전부에 trailing `&[]` 추가** (컴파일러-driven, 26곳 in report.rs tests + Step 9의 runs.rs:933 = 27). 컴파일 에러를 따라 각 `build_report(…, &active_vu)` 또는 `build_report(…, &[])`의 끝에 `, &[]` 를 더한다. 예: `report.rs:1640` `build_report(&r, &yaml, &rows, &[], &[], &[], &[], &active)` → `…, &active, &[])`. (Step 5의 신규 테스트 2개는 이미 9-arg.)

7g. `crates/controller/src/export.rs:487` `report_with_steps`의 `ReportJson { … }` 리터럴 — `active_vu_series: vec![]`(line ~518) 바로 아래에 추가(`#[serde(default)]`는 struct 리터럴엔 무력 — 컴파일러가 강제):

```rust
            active_vu_series: vec![],
            active_vu_by_worker: vec![],
            connection: None,
```

- [ ] **Step 8: Run report tests + workspace build to verify**

Run: `cargo build -p handicap-worker --bin worker && cargo build --workspace --tests`
Expected: 0 errors (all 27 call sites + export literal updated).
Run: `cargo test -p handicap-controller build_report_attaches_active_vu_by_worker build_report_no_active_vu_by_worker --lib`
Expected: PASS.
Run: `cargo test -p handicap-controller build_report_attaches_active_vu_series_without_polluting_summary --lib`
Expected: PASS (byte-identical 기존 active_vu_series 테스트 — assertion 무수정, call에 `, &[]`만 추가).

- [ ] **Step 9: Wire the caller (curve-only fetch gate)**

`crates/controller/src/api/runs.rs` `build_report_for_run`(line ~921) — `active_vu` fetch(line 931) 아래에 gated fetch 추가하고 build_report 호출(line 933)에 9번째 인자 전달:

```rust
    let active_vu = crate::store::metrics::active_vu_series(db, run_id).await?;
    // Per-worker breakdown is curve-only — skip the query entirely for non-curve runs.
    let active_vu_by_worker = if row.profile.is_vu_curve() {
        crate::store::metrics::active_vu_by_worker(db, run_id).await?
    } else {
        Vec::new()
    };
    let scenario_yaml = row.scenario_yaml.clone();
    Ok(crate::report::build_report(
        &row,
        &scenario_yaml,
        &rows,
        &loops,
        &branches,
        &groups,
        &phases,
        &active_vu,
        &active_vu_by_worker,
    ))
```

- [ ] **Step 10: Run the full controller gate**

Run: `cargo build -p handicap-worker --bin worker && cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run -p handicap-controller`
Expected: 0 errors / 0 warnings / all tests pass (incl. existing report + export round-trip + golden compare — `testdata/compare_golden.json` deserializes fine because the new field is `#[serde(default)]`).

- [ ] **Step 11: Verify the no-engine/proto/migration invariant**

Run: `git status --porcelain` then confirm changed files are only under `crates/controller/src/{store/metrics.rs,report.rs,api/runs.rs,export.rs}`.
Expected: no `.sql`, no `crates/engine`, no `crates/worker`, no `crates/proto`, no `.proto`.

- [ ] **Step 12: Commit**

```bash
git add crates/controller/src/store/metrics.rs crates/controller/src/report.rs crates/controller/src/api/runs.rs crates/controller/src/export.rs
git commit -m "feat(report): per-worker active-VU breakdown for curve fan-out runs (R1-R4)"
```
(커밋은 `run_in_background:false` + timeout 600000ms 단일 호출, 폴링 금지.)

---

## Task B: UI (ActiveVuChart toggle + Zod + ko + wiring)

**Files:**
- Create: `ui/src/components/report/__tests__/ActiveVuChart.test.tsx`
- Modify: `ui/src/api/schemas.ts` (신규 `WorkerActiveVuSeriesSchema` + `ReportSchema.active_vu_by_worker`)
- Modify: `ui/src/i18n/ko.ts` (`report:` 네임스페이스 신규 5키)
- Modify: `ui/src/components/report/ActiveVuChart.tsx` (`byWorker` prop + 토글 + per-worker 라인 + 캡션)
- Modify: `ui/src/components/report/ReportView.tsx:182-184` (`byWorker` prop 주입)

**Interfaces:**
- Consumes (Task A 와이어): `report.active_vu_by_worker?: WorkerActiveVuSeries[]` where `WorkerActiveVuSeries = { worker_id: string; samples: ActiveVuSample[] }`.

> **tdd-guard 순서 함정** (ui/CLAUDE.md): ui/src(non-test) 편집 전에 pending test-path 파일이 있어야 한다 → **Step 1에서 테스트 파일을 가장 먼저** 만든다(import 미해결로 RED여도 무방).

- [ ] **Step 1: Write the failing RTL test**

`ui/src/components/report/__tests__/ActiveVuChart.test.tsx` (신규):

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ActiveVuChart } from "../ActiveVuChart";
import { ko } from "../../../i18n/ko";
import type { ActiveVuSample, WorkerActiveVuSeries } from "../../../api/schemas";

const merged: ActiveVuSample[] = [
  { ts_second: 100, desired: 5, actual: 4 },
  { ts_second: 101, desired: 5, actual: 5 },
];
const byWorker: WorkerActiveVuSeries[] = [
  { worker_id: "01HWORKERA000000000000000", samples: [{ ts_second: 100, desired: 3, actual: 2 }] },
  { worker_id: "01HWORKERB000000000000000", samples: [{ ts_second: 100, desired: 2, actual: 2 }] },
];

describe("ActiveVuChart", () => {
  it("single worker (byWorker empty): no toggle, no fanout caption", () => {
    render(<ActiveVuChart series={merged} byWorker={[]} width={400} height={200} />);
    expect(screen.getByRole("region", { name: ko.report.activeVuTitle })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ko.report.activeVuViewByWorker })).not.toBeInTheDocument();
    expect(screen.queryByText(ko.report.activeVuFanout(2))).not.toBeInTheDocument();
  });

  it("multi worker: toggle + fanout caption; 워커별 view shows ordinal labels with worker_id title", async () => {
    const user = userEvent.setup();
    render(<ActiveVuChart series={merged} byWorker={byWorker} width={400} height={200} />);
    // Caption shown in both views.
    expect(screen.getByText(ko.report.activeVuFanout(2))).toBeInTheDocument();
    // Default view = 합계 (no per-worker legend list yet).
    expect(screen.queryByText(ko.report.activeVuWorkerLabel(1))).not.toBeInTheDocument();
    // Switch to 워커별.
    await user.click(screen.getByRole("button", { name: ko.report.activeVuViewByWorker }));
    const w1 = screen.getByText(ko.report.activeVuWorkerLabel(1));
    const w2 = screen.getByText(ko.report.activeVuWorkerLabel(2));
    expect(w1).toBeInTheDocument();
    expect(w2).toBeInTheDocument();
    // R12: raw worker_id surfaced via title on the legend item.
    expect(w1.closest("li")).toHaveAttribute("title", "01HWORKERA000000000000000");
    expect(w2.closest("li")).toHaveAttribute("title", "01HWORKERB000000000000000");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && pnpm test ActiveVuChart`
Expected: FAIL — `ko.report.activeVuViewByWorker`/`activeVuFanout`/`activeVuWorkerLabel` undefined and/or `byWorker` prop not accepted.

- [ ] **Step 3: Add the Zod schema**

`ui/src/api/schemas.ts` — `ActiveVuSampleSchema`(line ~392)/`export type ActiveVuSample`(line 399) 아래에 추가:

```ts
export const WorkerActiveVuSeriesSchema = z
  .object({
    worker_id: z.string(),
    samples: z.array(ActiveVuSampleSchema),
  })
  .strict();
export type WorkerActiveVuSeries = z.infer<typeof WorkerActiveVuSeriesSchema>;
```

`ReportSchema`(line ~401) — `active_vu_series: z.array(ActiveVuSampleSchema).optional(),`(line 411) 바로 아래에 추가:

```ts
    active_vu_series: z.array(ActiveVuSampleSchema).optional(),
    active_vu_by_worker: z.array(WorkerActiveVuSeriesSchema).optional(),
```

- [ ] **Step 4: Add the ko.ts strings**

`ui/src/i18n/ko.ts` — `report:` 네임스페이스 안, 기존 `activeVuTitle`/`activeVuDesired`/`activeVuActual` 키 근처에 추가:

```ts
    activeVuViewTotal: "합계",
    activeVuViewByWorker: "워커별",
    activeVuViewToggleLabel: "VU 곡선 보기 방식",
    activeVuWorkerLabel: (n: number) => `워커 ${n}`,
    activeVuFanout: (n: number) => `${n}개 워커로 분산 실행`,
```

- [ ] **Step 5: Rewrite ActiveVuChart with the toggle**

`ui/src/components/report/ActiveVuChart.tsx` 전체 교체 (단일워커 분기는 기존 구조 그대로 = byte-identical):

```tsx
import { useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { ko } from "../../i18n/ko";
import type { ActiveVuSample, WorkerActiveVuSeries } from "../../api/schemas";

type Props = {
  series: ActiveVuSample[];
  byWorker?: WorkerActiveVuSeries[];
  width?: number;
  height?: number;
};

// fan-out N is small (2–4 typical); cycle a fixed palette.
const WORKER_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2"];

export function ActiveVuChart({ series, byWorker = [], width = 720, height = 220 }: Props) {
  const [byWorkerView, setByWorkerView] = useState(false);
  const multiWorker = byWorker.length >= 2;
  const t0 = series.length > 0 ? series[0].ts_second : 0;

  // Merged ("합계") data — unchanged from before.
  const totalData = series.map((s) => ({ x: s.ts_second - t0, desired: s.desired, actual: s.actual }));

  // Per-worker ("워커별") data: one row per elapsed second, d{i}/a{i} per worker.
  const perWorkerData = (() => {
    const byX = new Map<number, Record<string, number>>();
    byWorker.forEach((w, i) => {
      for (const s of w.samples) {
        const x = s.ts_second - t0;
        const row = byX.get(x) ?? { x };
        row[`d${i}`] = s.desired;
        row[`a${i}`] = s.actual;
        byX.set(x, row);
      }
    });
    return [...byX.values()].sort((a, b) => a.x - b.x);
  })();

  const showByWorker = multiWorker && byWorkerView;
  const btnBase = "px-2 py-0.5 border text-xs";

  return (
    <section aria-label={ko.report.activeVuTitle} className="mb-6">
      {multiWorker ? (
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold text-slate-700">{ko.report.activeVuTitle}</h4>
          <div role="group" aria-label={ko.report.activeVuViewToggleLabel}>
            <button
              type="button"
              aria-pressed={!byWorkerView}
              onClick={() => setByWorkerView(false)}
              className={`${btnBase} rounded-l ${!byWorkerView ? "bg-slate-700 text-white" : "bg-white text-slate-700"}`}
            >
              {ko.report.activeVuViewTotal}
            </button>
            <button
              type="button"
              aria-pressed={byWorkerView}
              onClick={() => setByWorkerView(true)}
              className={`${btnBase} rounded-r border-l-0 ${byWorkerView ? "bg-slate-700 text-white" : "bg-white text-slate-700"}`}
            >
              {ko.report.activeVuViewByWorker}
            </button>
          </div>
        </div>
      ) : (
        <h4 className="text-sm font-semibold text-slate-700 mb-2">{ko.report.activeVuTitle}</h4>
      )}
      {multiWorker ? <p className="text-xs text-slate-500 mb-1">{ko.report.activeVuFanout(byWorker.length)}</p> : null}
      {showByWorker ? (
        <LineChart width={width} height={height} data={perWorkerData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="x" label={{ value: "seconds", position: "insideBottom", offset: -4 }} />
          <YAxis label={{ value: "VU", angle: -90, position: "insideLeft" }} allowDecimals={false} />
          <Tooltip />
          <Legend />
          {byWorker.flatMap((w, i) => {
            const color = WORKER_COLORS[i % WORKER_COLORS.length];
            const name = ko.report.activeVuWorkerLabel(i + 1);
            return [
              <Line key={`d${i}`} type="linear" dataKey={`d${i}`} name={`${name} ${ko.report.activeVuDesired}`} stroke={color} strokeDasharray="4 2" dot={false} isAnimationActive={false} />,
              <Line key={`a${i}`} type="linear" dataKey={`a${i}`} name={`${name} ${ko.report.activeVuActual}`} stroke={color} dot={false} isAnimationActive={false} />,
            ];
          })}
        </LineChart>
      ) : (
        <LineChart width={width} height={height} data={totalData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="x" label={{ value: "seconds", position: "insideBottom", offset: -4 }} />
          <YAxis label={{ value: "VU", angle: -90, position: "insideLeft" }} allowDecimals={false} />
          <Tooltip />
          <Legend />
          <Line type="linear" dataKey="desired" name={ko.report.activeVuDesired} stroke="#94a3b8" strokeDasharray="4 2" dot={false} isAnimationActive={false} />
          <Line type="linear" dataKey="actual" name={ko.report.activeVuActual} stroke="#2563eb" dot={false} isAnimationActive={false} />
        </LineChart>
      )}
      {showByWorker ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 mt-1">
          {byWorker.map((w, i) => (
            <li key={w.worker_id} title={w.worker_id} className="flex items-center gap-1">
              <span aria-hidden="true" style={{ color: WORKER_COLORS[i % WORKER_COLORS.length] }}>■</span>
              {ko.report.activeVuWorkerLabel(i + 1)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 6: Wire ReportView to pass byWorker**

`ui/src/components/report/ReportView.tsx:182-184` 교체:

```tsx
      {report.active_vu_series && report.active_vu_series.length > 0 ? (
        <ActiveVuChart series={report.active_vu_series} byWorker={report.active_vu_by_worker ?? []} />
      ) : null}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd ui && pnpm test ActiveVuChart`
Expected: PASS (both cases).

- [ ] **Step 8: Run the full UI gate**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0 warnings / all tests pass / `tsc -b && vite build` 0 errors. (특히 `pnpm build`가 `.optional()` 타입과 `WorkerActiveVuSeries` import를 검증 — `request<T>` 누출 없음 확인.)

- [ ] **Step 9: Commit**

```bash
git add ui/src/api/schemas.ts ui/src/i18n/ko.ts ui/src/components/report/ActiveVuChart.tsx ui/src/components/report/ReportView.tsx ui/src/components/report/__tests__/ActiveVuChart.test.tsx
git commit -m "feat(ui): 합계/워커별 toggle + per-worker active-VU breakdown on ActiveVuChart (R5-R10,R12)"
```
(커밋은 `run_in_background:false` + timeout 600000ms 단일 호출, 폴링 금지. R2 직렬화(Task A)와 R6 수용(Task B)이 같은 계약이므로 Task A·B는 함께 master에 머지.)

---

## Live verification (머지 전 필수 — S-D 갭)

리포트-파싱 경로에 신규 필드(`active_vu_by_worker`)를 추가하므로 **라이브 run 1회 필수**(RTL fixture는 absent-not-null이라 서버 응답경로를 못 잡는다 — 루트 CLAUDE.md). `/live-verify`로:

1. 워크트리 자체 바이너리 빌드: `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller`. **UI 빌드 필요**(`cd ui && pnpm build`) — 백엔드-only 워크트리 아님.
2. controller 기동(격리 DB·`--ui-dir ui/dist` 포함·`--worker-capacity-vus 25`로 peak>cap→N=2 강제): `./target/debug/controller --db /tmp/cfwd.db --ui-dir ui/dist --worker-capacity-vus 25 …` + 50ms responder.
3. **곡선 fan-out run**(closed+curve, peak 50 > cap 25 → N=2): `POST /api/runs` `{"scenario_id":…,"profile":{"duration_seconds":0,"vu_stages":[{"target":10,"duration_seconds":3},{"target":50,"duration_seconds":4},{"target":0,"duration_seconds":3}]},"env":{}}` (closed-curve-sharding 레시피 재사용). 종료 후 `GET /api/runs/{id}/report` 응답에 `active_vu_by_worker`가 **2 워커** 배열로 존재하는지 확인(`python3`로 파싱: `len(active_vu_by_worker)==2`).
4. **단일워커 곡선 run**(peak 25 ≤ cap 25 → N=1)으로 `active_vu_by_worker` **부재**(키 생략) 교차확인 = byte-identical.
5. RunDetailPage(`/runs/{id}`) Playwright(인라인 `browser_evaluate`, filename 없음): 토글 `[합계|워커별]` 노출·캡션 "2개 워커로 분산 실행"·"워커별" 클릭→"워커 1"/"워커 2" 라벨·`browser_console_messages`(all 없이, fresh navigate 후)에 Zod 에러 0. 정리: `rm -rf .playwright-mcp` + 루트 png.

production diff가 read-path+UI라 라이브 생략 불가(spec §6).

## 마무리 (Task B 머지 후)

`/finish-slice`: build-log 한 단락 append · roadmap §B9 연기 항목(per-worker 지연 Scope 3·run 목록 배지·non-곡선 fan-out·worker_count override) 누적 + 이 슬라이스 완료 표시 · 루트 CLAUDE.md 상태줄 1줄 교체 · ui/CLAUDE.md 함정(곡선 fan-out 워커 분해는 `active_vu_by_worker` read + `ActiveVuChart` byWorker 단일 경로) · 메모리 · ff-merge(`git merge --ff-only worktree-curve-fanout-worker-display`) · `ExitWorktree(remove, discard_changes:true)`.

<!-- REVIEW-GATE: APPROVED -->

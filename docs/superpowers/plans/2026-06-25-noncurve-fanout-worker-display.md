# Fan-out 워커별 분해 표 (비-곡선 fan-out 워커 표시) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 종료된 fan-out run(워커 ≥2) 리포트에 워커별 부하/성능 분해 표(요청 수·오류·p50/p95/p99 지연)를 추가해 "몇 대로 돌았나 / 어느 워커가 straggler인가"에 답한다.

**Architecture:** 컨트롤러 `build_report`의 **기존 `run_metrics` 행 루프**에 worker_id 키 누적기를 더해(신규 SQL·fetch-gate 0) `ReportJson.worker_breakdown`을 emit하고, UI는 Zod 스키마 + 프레젠테이셔널 `WorkerBreakdownTable`로 렌더한다. 게이트는 distinct non-empty worker ≥2(곡선 포함 모든 fan-out), 미만이면 빈 Vec → `skip_serializing_if` → byte-identical.

**Tech Stack:** Rust(controller `report.rs`/`export.rs`, HDR Histogram, serde) + TypeScript/React(Zod, RTL, Tailwind).

## Global Constraints

- **proto · engine · worker · migration 0-diff.** 변경은 controller read-path(`report.rs` + 컴파일러-driven `export.rs` fixture) + `ui/`로 한정. (spec R9)
- **byte-identical when single-worker/legacy:** distinct non-empty worker_id `<2` → `worker_breakdown` 빈 Vec → `#[serde(default, skip_serializing_if = "Vec::is_empty")]`로 직렬화 생략 → 기존 리포트/CSV/XLSX/골든 fixture 무변경. (spec R4)
- **단일 워커 빌드 비용도 불변:** 값싼 worker_id 사전 스캔(HDR 디코드 없음)으로 `<2` 감지 시 per-worker 누적 0. 멀티워커만 행당 `merge_into` 1회 추가(**추가 HDR 디코드 0** — 메인 루프의 이미 디코드된 `h` 재사용). (spec R5)
- **지연 필드 타입 = `u64`** (f64 아님). `Percentiles`/`percentiles_of`/모든 sibling 리포트 지연 필드가 `u64`. (spec R2, 리뷰 F1)
- **신규 UI 문구 전부 `ko.ts` 경유**(ADR-0035) — 표 제목·열 헤더·`워커 N` 라벨·section aria-label. (spec R8)
- **와이어 1:1:** `WorkerBreakdown`(snake_case) ↔ Zod `WorkerBreakdownSchema`(`.strict()`) 필드별 일치. `skip_serializing_if` 필드라 Zod는 `.optional()`(`active_vu_by_worker` 패턴). (spec R10)
- **게이트는 worker 수만:** `is_vu_curve()`/`is_open_loop()` 분기 없음 — 곡선 fan-out도 표를 얻는다(active-VU 차트와 공존). (spec R1, 범위)
- ADR 신규 불필요(ADR-0027/0037 범위 내 additive read-path).

---

## File Structure

- **`crates/controller/src/report.rs`** — `WorkerBreakdown` struct + `ReportJson.worker_breakdown` 필드 + `build_report` 내 per-worker 누적/emit + 단위 테스트. (Task 1)
- **`crates/controller/src/export.rs`** — `report_with_steps` 테스트 fixture에 `worker_breakdown: vec![]` 추가(컴파일러-driven, 유일한 다른 `ReportJson` 리터럴). (Task 1)
- **`ui/src/api/schemas.ts`** — `WorkerBreakdownSchema` + `ReportSchema.worker_breakdown`. (Task 2)
- **`ui/src/components/report/WorkerBreakdownTable.tsx`** (신규) — 프레젠테이셔널 표(`length < 2`면 null). (Task 2)
- **`ui/src/components/report/__tests__/WorkerBreakdownTable.test.tsx`** (신규) — RTL. (Task 2)
- **`ui/src/components/report/ReportView.tsx`** — 표 슬롯 1줄 + import. (Task 2)
- **`ui/src/i18n/ko.ts`** — `ko.report.colWorker`/`colErrorRate`/`workerBreakdownLabel`/`workerBreakdownTitle`/`workerLabel`. (Task 2)

---

## Task 1: 컨트롤러 read-path — `worker_breakdown` 도출

**Files:**
- Modify: `crates/controller/src/report.rs` (struct `~:190` below `WorkerActiveVuSeries`, ReportJson field `~:35`, build_report loop `:463-506` + emit `~:821` + literal `~:847`, tests)
- Modify: `crates/controller/src/export.rs:519` (fixture 리터럴)

**Interfaces:**
- Produces: `pub struct WorkerBreakdown { worker_id: String, count: u64, errors: u64, p50_ms: u64, p95_ms: u64, p99_ms: u64 }` and `ReportJson.worker_breakdown: Vec<WorkerBreakdown>` — Task 2(UI Zod)가 이 와이어 형태를 1:1 미러.
- Consumes: 기존 `build_report` 인자 `rows: &[WindowWithHdr]`(worker_id 포함), helper `decode_hdr`/`merge_into`/`fresh_hist`/`percentiles_of`/`Percentiles::empty`.

- [ ] **Step 1: `WorkerBreakdown` struct 추가**

`crates/controller/src/report.rs`의 `WorkerActiveVuSeries`(`:186-190`) 바로 아래에 추가:

```rust
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct WorkerBreakdown {
    pub worker_id: String,
    pub count: u64,
    pub errors: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
}
```

- [ ] **Step 2: `ReportJson`에 필드 추가**

`crates/controller/src/report.rs`의 `ReportJson`에서 `active_vu_by_worker`(`:34-35`) 바로 아래에 추가:

```rust
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub worker_breakdown: Vec<WorkerBreakdown>,
```

- [ ] **Step 3: build_report — 사전 스캔 + 누적기 선언 (루프 *전*)**

`crates/controller/src/report.rs`에서 `let mut total_errors: u64 = 0;`(`:477`) 바로 아래, `for r in rows {`(`:479`) **직전**에 추가:

```rust
    // Per-worker breakdown (ALL fan-out: closed/open/curve). Pre-scan distinct non-empty
    // worker_ids so single-worker runs do ZERO extra per-worker work (byte-identical build
    // cost); only ≥2 -> accumulate below in the SAME loop (reuse the decoded `h`, no extra decode).
    let multi_worker = {
        let mut seen = std::collections::HashSet::new();
        for r in rows {
            if !r.worker_id.is_empty() {
                seen.insert(r.worker_id.as_str());
            }
        }
        seen.len() >= 2
    };
    struct WorkerAcc {
        count: u64,
        errors: u64,
        hist: Option<Histogram<u64>>, // None until the first decodable HDR blob
    }
    let mut worker_acc: BTreeMap<String, WorkerAcc> = BTreeMap::new();
```

- [ ] **Step 4: build_report — 루프 안에 per-worker 누적 추가**

`crates/controller/src/report.rs`의 기존 행 루프(`:479-506`)를 아래처럼 수정한다(추가 라인만 `// NEW` 표시 — 나머지는 그대로). count/errors는 행 본문에서, 지연 merge는 **기존 `if let Ok(Some(h))` 블록 안에서**(이미 디코드된 `h` 재사용):

```rust
    for r in rows {
        let sc = parse_status_counts(&r.status_counts);
        let acc = window_acc
            .entry((r.ts_second, r.step_id.clone()))
            .or_insert_with(|| WindowAcc {
                count: 0,
                error_count: 0,
                status: BTreeMap::new(),
                hist: None,
            });
        acc.count += r.count as u64;
        acc.error_count += r.error_count as u64;
        add_status(&mut acc.status, &sc);
        // NEW: per-worker count/errors (multi-worker fan-out only; '' legacy excluded)
        if multi_worker && !r.worker_id.is_empty() {
            let w = worker_acc.entry(r.worker_id.clone()).or_insert_with(|| WorkerAcc {
                count: 0,
                errors: 0,
                hist: None,
            });
            w.count += r.count as u64;
            w.errors += r.error_count as u64;
        }
        if let Ok(Some(h)) = decode_hdr(&r.hdr_histogram) {
            merge_into(&mut overall, &h);
            let step_h = per_step.entry(r.step_id.clone()).or_insert_with(fresh_hist);
            merge_into(step_h, &h);
            let win_h = acc.hist.get_or_insert_with(fresh_hist);
            merge_into(win_h, &h);
            // NEW: per-worker latency (reuse already-decoded `h`; tiny map -> 2nd .entry is cheap)
            if multi_worker && !r.worker_id.is_empty() {
                let w = worker_acc.entry(r.worker_id.clone()).or_insert_with(|| WorkerAcc {
                    count: 0,
                    errors: 0,
                    hist: None,
                });
                let wh = w.hist.get_or_insert_with(fresh_hist);
                merge_into(wh, &h);
            }
        }
        total_count += r.count as u64;
        total_errors += r.error_count as u64;
        add_status(&mut status_dist, &sc);
        let step_acc = per_step_count.entry(r.step_id.clone()).or_default();
        step_acc.0 += r.count as u64;
        step_acc.1 += r.error_count as u64;
        add_status(&mut step_acc.2, &sc);
    }
```

- [ ] **Step 5: build_report — emit `worker_breakdown` (루프 *후*)**

`crates/controller/src/report.rs`의 `worker_vu` 블록(`:800-821`) 바로 아래, `ReportJson {`(`:823`) 직전에 추가(`worker_acc`는 `!multi_worker`면 빈 맵 → 빈 Vec, 별도 게이트 불요):

```rust
    // BTreeMap -> worker_id ascending (UI renders ordinal labels in this order).
    let worker_breakdown: Vec<WorkerBreakdown> = worker_acc
        .into_iter()
        .map(|(worker_id, w)| {
            let p = w
                .hist
                .as_ref()
                .map(percentiles_of)
                .unwrap_or_else(Percentiles::empty);
            WorkerBreakdown {
                worker_id,
                count: w.count,
                errors: w.errors,
                p50_ms: p.p50_ms,
                p95_ms: p.p95_ms,
                p99_ms: p.p99_ms,
            }
        })
        .collect();
```

- [ ] **Step 6: build_report — `ReportJson` 리터럴에 필드 추가**

`crates/controller/src/report.rs`의 `ReportJson { ... }` 리터럴에서 `active_vu_by_worker: worker_vu,`(`:846`) 바로 아래에 추가:

```rust
        worker_breakdown,
```

- [ ] **Step 7: `export.rs` fixture에 필드 추가**

`crates/controller/src/export.rs`의 `report_with_steps` fixture에서 `active_vu_by_worker: vec![],`(`:519`) 바로 아래에 추가:

```rust
            worker_breakdown: vec![],
```

- [ ] **Step 8: 단위 테스트 추가 (report.rs `mod tests`)**

`crates/controller/src/report.rs`의 `mod tests` 안(기존 `build_report_attaches_active_vu_by_worker_for_multiworker` 근처)에 4개 추가. 헬퍼 `run_row()`/`win(...)`/`make_hdr_bytes(&[µs])`/9-arg `build_report(...)`는 기존 테스트와 동일:

```rust
    #[test]
    fn build_report_attaches_worker_breakdown_for_multiworker() {
        let r = run_row();
        // Same (ts,step), two workers, distinct counts + latencies; rows out of worker order.
        let rows = vec![
            WindowWithHdr {
                ts_second: 100,
                step_id: "s".into(),
                worker_id: "w-1".into(),
                count: 5,
                error_count: 1,
                status_counts: r#"{"200":4,"500":1}"#.into(),
                hdr_histogram: make_hdr_bytes(&[40_000, 40_000, 40_000, 40_000, 40_000]),
            },
            WindowWithHdr {
                ts_second: 100,
                step_id: "s".into(),
                worker_id: "w-0".into(),
                count: 3,
                error_count: 0,
                status_counts: r#"{"200":3}"#.into(),
                hdr_histogram: make_hdr_bytes(&[10_000, 10_000, 10_000]),
            },
        ];
        let yaml = r.scenario_yaml.clone();
        let rep = build_report(&r, &yaml, &rows, &[], &[], &[], &[], &[], &[]);
        assert_eq!(rep.worker_breakdown.len(), 2);
        // sorted by worker_id ascending
        assert_eq!(rep.worker_breakdown[0].worker_id, "w-0");
        assert_eq!(rep.worker_breakdown[0].count, 3);
        assert_eq!(rep.worker_breakdown[0].errors, 0);
        assert_eq!(rep.worker_breakdown[0].p99_ms, 10); // w-0 only saw 10ms
        assert_eq!(rep.worker_breakdown[1].worker_id, "w-1");
        assert_eq!(rep.worker_breakdown[1].count, 5);
        assert_eq!(rep.worker_breakdown[1].errors, 1);
        assert_eq!(rep.worker_breakdown[1].p99_ms, 40); // w-1 saw 40ms
        // aggregate summary still merges across workers (byte-identical behavior)
        assert_eq!(rep.summary.count, 8);
        assert_eq!(rep.summary.errors, 1);
        // typed round-trip
        let v = serde_json::to_value(&rep).unwrap();
        let _back: ReportJson = serde_json::from_value(v).unwrap();
    }

    #[test]
    fn build_report_omits_worker_breakdown_for_single_worker() {
        let r = run_row();
        // win() uses worker_id "w-0" -> single distinct worker.
        let rows = vec![
            win(100, "s", 3, 0, r#"{"200":3}"#, &[10_000, 10_000, 10_000]),
            win(101, "s", 2, 0, r#"{"200":2}"#, &[20_000, 20_000]),
        ];
        let yaml = r.scenario_yaml.clone();
        let rep = build_report(&r, &yaml, &rows, &[], &[], &[], &[], &[], &[]);
        assert!(rep.worker_breakdown.is_empty());
        // skip_serializing_if -> field absent (byte-identical)
        let v = serde_json::to_value(&rep).unwrap();
        assert!(v.get("worker_breakdown").is_none());
    }

    #[test]
    fn build_report_excludes_legacy_empty_worker_id_from_breakdown() {
        let r = run_row();
        // legacy '' sentinel only -> 0 distinct non-empty -> no breakdown.
        let rows = vec![WindowWithHdr {
            ts_second: 100,
            step_id: "s".into(),
            worker_id: "".into(),
            count: 4,
            error_count: 0,
            status_counts: r#"{"200":4}"#.into(),
            hdr_histogram: make_hdr_bytes(&[15_000, 15_000, 15_000, 15_000]),
        }];
        let yaml = r.scenario_yaml.clone();
        let rep = build_report(&r, &yaml, &rows, &[], &[], &[], &[], &[], &[]);
        assert!(rep.worker_breakdown.is_empty());
    }

    #[test]
    fn build_report_worker_breakdown_tolerates_bad_hdr_blob() {
        let r = run_row();
        let rows = vec![
            WindowWithHdr {
                ts_second: 100,
                step_id: "s".into(),
                worker_id: "w-0".into(),
                count: 2,
                error_count: 0,
                status_counts: r#"{"200":2}"#.into(),
                hdr_histogram: vec![0xff, 0xff, 0xff, 0xff], // undecodable
            },
            WindowWithHdr {
                ts_second: 100,
                step_id: "s".into(),
                worker_id: "w-1".into(),
                count: 3,
                error_count: 0,
                status_counts: r#"{"200":3}"#.into(),
                hdr_histogram: make_hdr_bytes(&[30_000, 30_000, 30_000]),
            },
        ];
        let yaml = r.scenario_yaml.clone();
        let rep = build_report(&r, &yaml, &rows, &[], &[], &[], &[], &[], &[]);
        assert_eq!(rep.worker_breakdown.len(), 2);
        // w-0: count counted despite bad blob, latency falls back to 0 (fail-soft)
        assert_eq!(rep.worker_breakdown[0].worker_id, "w-0");
        assert_eq!(rep.worker_breakdown[0].count, 2);
        assert_eq!(rep.worker_breakdown[0].p50_ms, 0);
        // w-1: normal
        assert_eq!(rep.worker_breakdown[1].count, 3);
        assert_eq!(rep.worker_breakdown[1].p50_ms, 30);
    }
```

- [ ] **Step 9: 테스트 RED→GREEN 확인**

워커 바이너리 워밍(cold-build flake 예방) 후 lib 단위 테스트만 실행:

```bash
cargo build -p handicap-worker
cargo test -p handicap-controller --lib breakdown
```
Expected: 신규 4개 전부 PASS(필터 `breakdown`은 신규 4개 + 기존 loop/if breakdown 테스트도 매치 — 신규 4개가 보이는지 확인). 필터 `worker_breakdown`은 4번째 `..._from_breakdown`를 놓치니 쓰지 말 것. 구현 전 임시로 돌리면 컴파일 에러(struct 부재) — Step 1-7을 먼저 적용.

- [ ] **Step 10: 워크스페이스 빌드·클리피·전체 테스트**

```bash
cargo build --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo nextest run -p handicap-controller
```
Expected: 0 에러/0 warning, 전부 PASS(기존 `build_report_merges_worker_windows`·`golden_summary_deltas_match` 포함 — `worker_breakdown`은 단일워커 golden fixture에서 빈 Vec→직렬화 생략→무영향).

- [ ] **Step 11: Commit**

```bash
git add crates/controller/src/report.rs crates/controller/src/export.rs
git commit -m "feat(controller): per-worker breakdown in build_report for fan-out runs

run_metrics already carries worker_id (migration 0008); accumulate
count/errors/HDR per worker in the existing build_report loop (no new SQL,
no fetch-gate). Gate >=2 distinct non-empty workers -> ReportJson.worker_breakdown,
else empty Vec (skip_serializing_if -> byte-identical). Single-worker runs do
zero extra per-worker work (pre-scan). proto/engine/worker/migration 0-diff.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01R3yxEaHpQeMVEp7AsKQabw"
```

---

## Task 2: UI — Zod 스키마 + `WorkerBreakdownTable` + ReportView 슬롯

**Files:**
- Create: `ui/src/components/report/__tests__/WorkerBreakdownTable.test.tsx`
- Create: `ui/src/components/report/WorkerBreakdownTable.tsx`
- Modify: `ui/src/api/schemas.ts` (`~:407` schema, `~:420` ReportSchema field)
- Modify: `ui/src/components/report/ReportView.tsx` (`~:187` slot + import)
- Modify: `ui/src/i18n/ko.ts` (`ko.report` 네임스페이스)

**Interfaces:**
- Consumes: Task 1의 와이어 `worker_breakdown: WorkerBreakdown[]`(snake_case, `u64`→`z.number()`).
- Produces: `WorkerBreakdownTable({ breakdown })` — `breakdown.length < 2`면 `null`.

- [ ] **Step 1: 실패하는 RTL 테스트 작성 (tdd-guard 위해 *가장 먼저*)**

> tdd-guard: `ui/src` 편집 전 pending test-path 파일이 필요하다 — 이 테스트 파일을 **먼저** 만들어 RED diff를 깐다(import 미해결 RED 무방). 이후 schemas/ko/component/ReportView 편집이 unblock된다.

`ui/src/components/report/__tests__/WorkerBreakdownTable.test.tsx` 생성:

```tsx
import { render, screen, within } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { WorkerBreakdownTable } from "../WorkerBreakdownTable";
import type { WorkerBreakdown } from "../../../api/schemas";

const rows: WorkerBreakdown[] = [
  { worker_id: "run-w0", count: 100, errors: 2, p50_ms: 10, p95_ms: 20, p99_ms: 30 },
  { worker_id: "run-w1", count: 50, errors: 0, p50_ms: 12, p95_ms: 25, p99_ms: 40 },
];

describe("WorkerBreakdownTable", () => {
  it("renders one row per worker with ordinal labels, worker_id title, and error rate", () => {
    render(<WorkerBreakdownTable breakdown={rows} />);
    const table = screen.getByRole("table");
    // ordinal labels
    expect(within(table).getByText("워커 1")).toBeInTheDocument();
    expect(within(table).getByText("워커 2")).toBeInTheDocument();
    // worker_id surfaced as the name cell's title (hover)
    expect(within(table).getByText("워커 1").closest("td")).toHaveAttribute("title", "run-w0");
    // request count + error rate (2/100 = 2.0%, 0/50 = 0.0%)
    expect(within(table).getByText("100")).toBeInTheDocument();
    expect(within(table).getByText("2.0%")).toBeInTheDocument();
    expect(within(table).getByText("0.0%")).toBeInTheDocument();
    // worker count carried in the heading
    expect(screen.getByRole("heading")).toHaveTextContent("워커별 분해 (2개 워커)");
  });

  it("renders nothing with fewer than 2 workers", () => {
    const { container } = render(<WorkerBreakdownTable breakdown={[rows[0]]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when empty", () => {
    const { container } = render(<WorkerBreakdownTable breakdown={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: 테스트 RED 확인**

```bash
cd ui && pnpm test WorkerBreakdownTable
```
Expected: FAIL — `Cannot find module "../WorkerBreakdownTable"` (컴포넌트 미생성).

- [ ] **Step 3: Zod 스키마 추가**

`ui/src/api/schemas.ts`의 `WorkerActiveVuSeriesSchema` 블록(`:401-407`) 바로 아래에 추가:

```ts
export const WorkerBreakdownSchema = z
  .object({
    worker_id: z.string(),
    count: z.number(),
    errors: z.number(),
    p50_ms: z.number(),
    p95_ms: z.number(),
    p99_ms: z.number(),
  })
  .strict();
export type WorkerBreakdown = z.infer<typeof WorkerBreakdownSchema>;
```

같은 파일 `ReportSchema`에서 `active_vu_by_worker: z.array(WorkerActiveVuSeriesSchema).optional(),`(`:420`) 바로 아래에 추가:

```ts
    worker_breakdown: z.array(WorkerBreakdownSchema).optional(),
```

- [ ] **Step 4: ko 문구 추가**

`ui/src/i18n/ko.ts`의 **`report` 네임스페이스**(`ko.ts:548-681`) 안, 기존 `colCount`(`:664`)·`colErrors`(`:663`) 근처에 추가(주의: `:706`은 *다른* `runDetail` 네임스페이스 — 거기 넣으면 `ko.report.colWorker`가 런타임 `undefined`):

```ts
    colWorker: "워커",
    colErrorRate: "오류율",
    workerBreakdownLabel: "워커별 분해",
    workerBreakdownTitle: (n: number) => `워커별 분해 (${n}개 워커)`,
    workerLabel: (n: number) => `워커 ${n}`,
```

> 주의: `colWorker`/`colErrorRate`/`workerBreakdownLabel`/`workerBreakdownTitle`/`workerLabel`이 `ko.report`에 이미 없는지 확인(중복 키면 `tsc -b` 에러). `colRequests`/`colErrors`/`glossary.p50/p95/p99`는 기존 키 재사용.

- [ ] **Step 5: `WorkerBreakdownTable` 컴포넌트 작성**

`ui/src/components/report/WorkerBreakdownTable.tsx` 생성(`StepStatsTable` 마크업·HelpTip 컨벤션 미러):

```tsx
import type { WorkerBreakdown } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";

type Props = { breakdown: WorkerBreakdown[] };

export function WorkerBreakdownTable({ breakdown }: Props) {
  // Server emits only when >=2 distinct workers; mirror that gate defensively.
  if (breakdown.length < 2) return null;
  return (
    <section aria-label={ko.report.workerBreakdownLabel} className="mb-6">
      <h3 className="text-lg font-semibold mb-2">
        {ko.report.workerBreakdownTitle(breakdown.length)}
      </h3>
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-slate-600">
          <tr>
            <th className="py-2 pr-4 font-medium">{ko.report.colWorker}</th>
            <th className="py-2 pr-4 font-medium">{ko.report.colRequests}</th>
            <th className="py-2 pr-4 font-medium">{ko.report.colErrors}</th>
            <th className="py-2 pr-4 font-medium">{ko.report.colErrorRate}</th>
            <th className="py-2 pr-4 font-medium">
              p50 ms<HelpTip label="p50 설명">{ko.glossary.p50}</HelpTip>
            </th>
            <th className="py-2 pr-4 font-medium">
              p95 ms<HelpTip label="p95 설명">{ko.glossary.p95}</HelpTip>
            </th>
            <th className="py-2 pr-4 font-medium">
              p99 ms<HelpTip label="p99 설명">{ko.glossary.p99}</HelpTip>
            </th>
          </tr>
        </thead>
        <tbody>
          {breakdown.map((w, i) => (
            <tr key={w.worker_id} className="border-b border-slate-100">
              <td className="py-2 pr-4 font-medium" title={w.worker_id}>
                {ko.report.workerLabel(i + 1)}
              </td>
              <td className="py-2 pr-4">{w.count}</td>
              <td className="py-2 pr-4">{w.errors}</td>
              <td className="py-2 pr-4">
                {w.count === 0 ? "—" : `${((w.errors / w.count) * 100).toFixed(1)}%`}
              </td>
              <td className="py-2 pr-4">{w.p50_ms}</td>
              <td className="py-2 pr-4">{w.p95_ms}</td>
              <td className="py-2 pr-4">{w.p99_ms}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 6: ReportView 슬롯 + import**

`ui/src/components/report/ReportView.tsx` 상단 import 블록에 추가:

```tsx
import { WorkerBreakdownTable } from "./WorkerBreakdownTable";
```

active-VU 차트 블록(`:182-187`) 바로 아래, `{report.latency ? (`(`:188`) 직전에 추가(컴포넌트가 `<2`면 null이라 항상 렌더 안전):

```tsx
      <WorkerBreakdownTable breakdown={report.worker_breakdown ?? []} />
```

- [ ] **Step 7: 테스트 GREEN 확인**

```bash
cd ui && pnpm test WorkerBreakdownTable
```
Expected: 3 테스트 PASS.

- [ ] **Step 8: 전체 UI 게이트 (lint + 전체 test + build)**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
```
Expected: lint 0 warning, 전체 test PASS(기존 `ReportView.test.tsx`/`RunDetailPage.test.tsx`/`schemas.test.ts`는 `worker_breakdown` `.optional()`이라 fixture 무수정·단일워커라 표 null → 무영향), `tsc -b`+vite build 성공.

> `pnpm test`(전체)를 반드시 — targeted green ≠ full green(다른 리포트 fixture 회귀 방어).

- [ ] **Step 9: Commit**

```bash
git add ui/src/api/schemas.ts ui/src/i18n/ko.ts ui/src/components/report/WorkerBreakdownTable.tsx ui/src/components/report/__tests__/WorkerBreakdownTable.test.tsx ui/src/components/report/ReportView.tsx
git commit -m "feat(ui): per-worker breakdown table on fan-out run reports

Renders worker count + per-worker requests/errors/error-rate/p50-p95-p99
for fan-out runs (worker_breakdown, >=2 workers). Curve runs show it
alongside the active-VU chart. Zod .optional() (skip_serializing_if) so
single-worker reports are unaffected.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01R3yxEaHpQeMVEp7AsKQabw"
```

---

## 라이브 검증 (머지 전 필수 — spec R11, S-D 갭)

production diff가 run-report 경로를 건드리므로 `/live-verify` 필수. `docs/superpowers/specs/2026-06-25-noncurve-fanout-worker-display-design.md` §10:

- 워크트리 자체 바이너리(`cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller`) + 50ms responder + 격리 DB. UI도 보려면 `ui/dist` 빌드.
- **2워커 고정-VU run**: capacity를 낮춰(`--worker-capacity-vus` 등 settings) `vus`가 `ceil(vus/cap)=2`가 되게 → 실 `/report`가 `ReportSchema.parse` 통과 + `worker_breakdown` 길이 2 + per-worker `count` 합 == `summary.count`.
- **2워커 open-loop run**: 동일하게 N=2 → `worker_breakdown` 길이 2.
- **단일워커 run**: `/report`에 `worker_breakdown` absent + 기존 리포트 byte-identical.
- Playwright(/runs/{N=2}): RunDetailPage "워커별 분해 (2개 워커)" 표·서수 라벨·`title=worker_id`·오류율·콘솔 Zod 0. 곡선 fan-out run이면 active-VU 차트와 표 공존 확인. **RTL/Playwright 다중매치 주의**: 곡선 run은 ActiveVuChart 범례(`<li>` "워커 N")와 표(`워커 N`)가 공존 → `within(table)`/`title`로 스코프(인덱스 기반 `<li>` 추출 금지 — ui/CLAUDE.md).
- 정리: `rm -rf .playwright-mcp` + 루트 png.

---

## Self-Review (작성자 체크리스트)

**1. Spec coverage:** R1(게이트 ≥2·곡선 포함)=Task1 Step3-5 / R2(필드·u64·UI 오류율)=Step1·Task2 Step5 / R3(기존 루프·신규 SQL 0)=Step4 / R4(byte-identical skip)=Step2·Step10·Step8 / R5(사전 스캔)=Step3 / R6(worker_id 정렬·서수 라벨)=Step5·Task2 / R7(UI `<2` null)=Task2 Step5 / R8(ko)=Task2 Step4 / R9(proto/engine/worker/migration 0)=Global·파일 목록 / R10(와이어 1:1)=Step1·Task2 Step3 / R11(라이브)=라이브 검증 / R12(핫경로 무변경)=Global. **갭 없음.**

**2. Placeholder scan:** 모든 step에 실제 코드/명령. TBD 없음.

**3. Type consistency:** `WorkerBreakdown`{worker_id,count,errors,p50_ms,p95_ms,p99_ms}가 Rust struct(Task1 Step1)·ReportJson 리터럴(Step6)·export fixture(Step7)·Zod(Task2 Step3)·컴포넌트 prop(Task2 Step5)에서 동일. 지연 `u64`↔`z.number()`. `worker_breakdown` 필드명 일관. `build_report` 9-arg 호출 시그니처 무변경(테스트도 9-arg).

---

REVIEW-GATE: APPROVED

# 레이턴시 분포 리포트 (분위 곡선 + 히스토그램) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 종료된 run 리포트에 run 전체 레이턴시 **분위 곡선**과 **로그-버킷 히스토그램**을 추가한다 — `build_report`가 이미 메모리에 머지해 둔 `overall` HDR 히스토그램에서 버려지던 분위/버킷을 추출해 emit하고 UI 차트 2개로 렌더.

**Architecture:** 엔진 `percentiles.rs`에 리포트 전용 순수 헬퍼 2개(`percentile_curve`/`log_buckets`) 추가(executor/aggregator 미사용 = 부하경로 byte-identical) → 컨트롤러 `build_report`가 `overall`에서 추출해 `ReportJson.latency: Option<LatencyDistribution>`(serde-default, 마이그레이션 0)로 emit → UI Zod(`.nullish()`) + Recharts 차트 2개 + ReportView 슬롯. proto·워커·`run_metrics` 테이블·마이그레이션 무변경.

**Tech Stack:** Rust(`hdrhistogram` 7.5.4, serde) / TypeScript(React, Zod, Recharts 2.x, vitest+RTL).

**Spec:** `docs/superpowers/specs/2026-06-05-latency-distribution-report-design.md` (spec-plan-reviewer 5건 반영 완료).

---

## 이 repo의 작업 규칙 (모든 task 공통)

- **pre-commit 훅은 비-`.md` 커밋마다 전체 workspace(`cargo fmt --check + build + clippy -D warnings + test --workspace`)를 돌린다 — 수 분 소요.** 그래서 dead-code-only(미사용 `pub` 헬퍼) 또는 RED-only 커밋은 게이트를 못 통과한다. **각 task는 테스트+구현을 하나의 green 커밋으로 fold**(로컬에서 RED→GREEN 확인하되 커밋은 1회).
- **cold-build flake**: 엔진/워커를 바꾼 커밋은 pre-commit `test --workspace`가 controller e2e에서 워커 바이너리 race로 flake날 수 있다(진짜 회귀 아님). 커밋 전 `cargo build -p handicap-worker && cargo build --workspace`로 warm한 뒤 커밋하고, flake나면 동일 커밋 재시도.
- **commit은 `run_in_background:false` + timeout 600000ms 단일 호출, 폴링 금지**(subagent 턴 truncate 방지). 커밋은 파이프(`| tail`) 없이 돌리고 직후 `git log -1`로 landed 확인.
- **UI 게이트는 훅이 안 돌린다** — UI를 만진 task는 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build`를 수동으로(전부 green이어야 함). `pnpm lint`는 `--max-warnings=0`.
- **tdd-guard**: `crates/*/src/*.rs`·`ui/src/*.{ts,tsx}` 편집은 디스크에 pending test 파일이 있어야 한다. 인라인 `#[cfg(test)]`가 *이미 있는* `.rs` 파일 편집은 자동 통과. 새 `.ts/.tsx` src 파일 Write는 같은 task의 `.test.ts(x)` 파일을 **먼저** 만들면 unblock된다. 각 task 스텝 순서가 이를 보장한다.
- 모든 명령은 repo 루트(`/Users/sgj/develop/handicap`) 기준.

---

## File Structure

| 파일 | 변경 | 책임 |
|---|---|---|
| `crates/engine/src/percentiles.rs` | Modify | 순수 헬퍼 `percentile_curve`/`log_buckets` + 상수 `CURVE_QUANTILES`/`HISTOGRAM_BINS` |
| `crates/engine/tests/percentiles_test.rs` | Modify (extend) | 두 헬퍼 유닛 테스트 |
| `crates/controller/src/report.rs` | Modify | `PercentilePoint`/`HistogramBucket`/`LatencyDistribution` 타입 + `ReportJson.latency` + `build_report` 배선 + 인라인 테스트 |
| `crates/controller/tests/report_test.rs` | Modify | 엔드포인트 응답에 `latency` 존재 단언 |
| `ui/src/api/schemas.ts` | Modify | `LatencyDistributionSchema` + `ReportSchema.latency` + 타입 export |
| `ui/src/api/__tests__/reportLatency.test.ts` | Create | 스키마 parse 테스트(object/null/absent) |
| `ui/src/components/report/format.ts` | Create | `formatLatency(us)` 포맷 헬퍼 |
| `ui/src/components/report/__tests__/format.test.ts` | Create | `formatLatency` 유닛 테스트 |
| `ui/src/components/report/PercentileCurveChart.tsx` | Create | 분위 곡선 LineChart(`type="linear"`) |
| `ui/src/components/report/__tests__/PercentileCurveChart.test.tsx` | Create | RTL 렌더 테스트 |
| `ui/src/components/report/LatencyHistogramChart.tsx` | Create | 로그-버킷 BarChart(카테고리축) |
| `ui/src/components/report/__tests__/LatencyHistogramChart.test.tsx` | Create | RTL 렌더 + empty-state 테스트 |
| `ui/src/components/report/ReportView.tsx` | Modify | 두 차트를 Errors 시계열 뒤·StatusDistribution 앞에 슬롯 |
| `ui/src/components/report/__tests__/ReportView.test.tsx` | Modify | latency 있음→두 region 렌더 / 없음→미렌더 |

---

## Task 1: 엔진 헬퍼 `percentile_curve` + `log_buckets`

**Files:**
- Modify: `crates/engine/src/percentiles.rs`
- Test: `crates/engine/tests/percentiles_test.rs` (이미 존재 — append)

- [ ] **Step 1: 실패 테스트 작성** — `crates/engine/tests/percentiles_test.rs`

먼저 1번 라인의 import를 교체:

```rust
use handicap_engine::percentiles::{
    CURVE_QUANTILES, HISTOGRAM_BINS, Percentiles, decode_hdr, log_buckets, merge_into,
    percentile_curve, percentiles_of,
};
```

파일 끝에 테스트 5개 append (`record_us` 헬퍼 재사용):

```rust
#[test]
fn percentile_curve_is_monotone_nondecreasing() {
    let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    record_us(&mut h, &(1..=1000).map(|i| i * 1_000).collect::<Vec<_>>());
    let curve = percentile_curve(&h, &CURVE_QUANTILES);
    assert_eq!(curve.len(), CURVE_QUANTILES.len());
    for (i, (q, _)) in curve.iter().enumerate() {
        assert_eq!(*q, CURVE_QUANTILES[i], "quantiles preserved in order");
    }
    for w in curve.windows(2) {
        assert!(w[1].1 >= w[0].1, "curve must be non-decreasing: {w:?}");
    }
    // p50 ~ 500ms = 500_000us (HDR 3-sigfig tolerance).
    let p50 = curve.iter().find(|(q, _)| *q == 0.50).unwrap().1;
    assert!((480_000..=520_000).contains(&p50), "p50_us={p50}");
}

#[test]
fn log_buckets_partition_sums_to_total() {
    let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    record_us(
        &mut h,
        &[500, 600, 700, 800, 900, 1_000, 2_000, 5_000, 50_000, 500_000],
    );
    let buckets = log_buckets(&h, HISTOGRAM_BINS);
    assert!(!buckets.is_empty());
    let sum: u64 = buckets.iter().map(|(_, _, c)| *c).sum();
    assert_eq!(sum, h.len(), "bucket counts must partition all samples");
    for (lo, hi, _) in &buckets {
        assert!(lo <= hi, "lower<=upper within a bucket");
    }
    for w in buckets.windows(2) {
        assert_eq!(w[0].1, w[1].0, "adjacent buckets share a boundary");
    }
}

#[test]
fn log_buckets_dense_low_latency_sums_exactly() {
    // 1000 samples packed at 1-3ms — the count_between double-count trap regime.
    let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    record_us(&mut h, &(0..1000).map(|i| 1_000 + (i % 2000)).collect::<Vec<_>>());
    let buckets = log_buckets(&h, HISTOGRAM_BINS);
    let sum: u64 = buckets.iter().map(|(_, _, c)| *c).sum();
    assert_eq!(sum, 1000);
}

#[test]
fn log_buckets_single_value_lands_in_one_bucket() {
    let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    record_us(&mut h, &[5_000, 5_000, 5_000]);
    let buckets = log_buckets(&h, HISTOGRAM_BINS);
    let nonzero: Vec<_> = buckets.iter().filter(|(_, _, c)| *c > 0).collect();
    assert_eq!(nonzero.len(), 1, "all identical samples in one bucket");
    assert_eq!(nonzero[0].2, 3);
}

#[test]
fn log_buckets_empty_and_curve_no_panic() {
    let h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    assert!(log_buckets(&h, HISTOGRAM_BINS).is_empty());
    let _ = percentile_curve(&h, &CURVE_QUANTILES); // empty → zeros, must not panic
}
```

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-engine --test percentiles_test`
Expected: 컴파일 에러(`cannot find function percentile_curve` / `log_buckets` / consts). 이게 RED.

- [ ] **Step 3: 헬퍼 구현** — `crates/engine/src/percentiles.rs`

파일 끝(`merge_into` 뒤)에 추가:

```rust
/// Quantiles for the report percentile-distribution curve. Bookended by q=0.0
/// (min recorded) and q=1.0 (max) so the chart shows the full spread.
pub const CURVE_QUANTILES: [f64; 11] =
    [0.0, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99, 0.999, 0.9999, 1.0];

/// Number of log-spaced display bins for the latency histogram.
pub const HISTOGRAM_BINS: usize = 40;

/// Value (microseconds) at each requested quantile, paired with the quantile.
/// Caller skips this when the histogram is empty (`h.len() == 0`).
pub fn percentile_curve(h: &Histogram<u64>, quantiles: &[f64]) -> Vec<(f64, u64)> {
    quantiles
        .iter()
        .map(|&q| (q, h.value_at_quantile(q)))
        .collect()
}

/// Log-spaced histogram buckets as `(lower_us, upper_us, count)`.
///
/// Counts are an EXACT partition of the recorded samples: each recorded HDR
/// sub-bucket (yielded once by `iter_recorded`) is assigned to exactly one bin
/// by its value, so the per-bin counts sum to `h.len()`. We deliberately do NOT
/// use `count_between` half-open subtraction — its inclusive boundaries snap to
/// HDR sub-bucket edges and double-count at fine resolution.
pub fn log_buckets(h: &Histogram<u64>, bins: usize) -> Vec<(u64, u64, u64)> {
    if h.len() == 0 || bins == 0 {
        return Vec::new();
    }
    let lo = h.min().max(1);
    let hi = h.max();
    if lo >= hi {
        // All samples share one equivalent value — single bucket.
        return vec![(lo, hi, h.len())];
    }
    let log_lo = (lo as f64).ln();
    let span = (hi as f64).ln() - log_lo;
    let edge = |i: usize| -> f64 { (log_lo + span * (i as f64) / (bins as f64)).exp() };

    let mut counts = vec![0u64; bins];
    for it in h.iter_recorded() {
        let c = it.count_since_last_iteration();
        if c == 0 {
            continue;
        }
        let v = it.value_iterated_to().max(1);
        let frac = ((v as f64).ln() - log_lo) / span;
        let j = (frac * bins as f64).floor() as isize;
        let j = j.clamp(0, bins as isize - 1) as usize;
        counts[j] += c;
    }

    (0..bins)
        .map(|i| (edge(i).round() as u64, edge(i + 1).round() as u64, counts[i]))
        .collect()
}
```

- [ ] **Step 4: GREEN 확인**

Run: `cargo test -p handicap-engine --test percentiles_test`
Expected: 모든 테스트 PASS (기존 6 + 신규 5).

- [ ] **Step 5: 게이트 + 커밋**

Run (warm + gate): `cargo build -p handicap-worker && cargo build --workspace && cargo clippy -p handicap-engine --all-targets -- -D warnings`
Expected: 에러 0.

커밋(foreground 단일 호출, 폴링 금지):

```bash
git add crates/engine/src/percentiles.rs crates/engine/tests/percentiles_test.rs
git commit -m "feat(engine): percentile_curve + log_buckets 리포트 헬퍼

overall HDR에서 분위 곡선(고정 11분위)·로그 버킷(iter_recorded 값-기준
정확 분할, Σ==len)을 추출하는 순수 헬퍼. executor/aggregator 미사용 =
부하경로 무변경. ADR 불필요(additive).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

직후 `git log -1 --stat`로 landed 확인.

---

## Task 2: 컨트롤러 `LatencyDistribution` 타입 + `build_report` 배선

**Files:**
- Modify: `crates/controller/src/report.rs`
- Test: `crates/controller/src/report.rs` (인라인 `#[cfg(test)] mod tests`) + `crates/controller/tests/report_test.rs`

- [ ] **Step 1: 실패 테스트 작성** — `crates/controller/src/report.rs` 인라인 `mod tests`

`mod tests` 안(예: `build_report_surfaces_dropped` 근처)에 추가:

```rust
    #[test]
    fn build_report_emits_latency_distribution() {
        let r = run_row();
        let rows = vec![
            win(100, "s", 3, 0, r#"{"200":3}"#, &[10_000, 20_000, 30_000]),
            win(101, "s", 2, 0, r#"{"200":2}"#, &[40_000, 50_000]),
        ];
        let yaml = r.scenario_yaml.clone();
        let rep = build_report(&r, &yaml, &rows, &[], &[]);

        let latency = rep.latency.as_ref().expect("latency present with samples");
        assert_eq!(latency.percentile_curve.len(), CURVE_QUANTILES.len());
        for (i, p) in latency.percentile_curve.iter().enumerate() {
            assert_eq!(p.quantile, CURVE_QUANTILES[i]);
        }
        for w in latency.percentile_curve.windows(2) {
            assert!(w[1].value_us >= w[0].value_us, "curve non-decreasing");
        }
        let total: u64 = latency.histogram.iter().map(|b| b.count).sum();
        assert_eq!(total, 5, "histogram partitions all 5 samples");

        // typed round-trip survives the new field.
        let v = serde_json::to_value(&rep).unwrap();
        let back: ReportJson = serde_json::from_value(v).unwrap();
        assert!(back.latency.is_some());
    }

    #[test]
    fn build_report_no_latency_without_samples() {
        let r = run_row();
        assert!(build_report(&r, "", &[], &[], &[]).latency.is_none());
    }
```

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-controller --lib report::tests::build_report_emits_latency_distribution`
Expected: 컴파일 에러(`no field latency on ReportJson` / `CURVE_QUANTILES` 미import). RED.

- [ ] **Step 3: 타입 + import + 배선 구현** — `crates/controller/src/report.rs`

(a) line 3 import 교체:

```rust
use handicap_engine::percentiles::{
    CURVE_QUANTILES, HISTOGRAM_BINS, Percentiles, decode_hdr, log_buckets, merge_into,
    percentile_curve, percentiles_of,
};
```

(b) `ReportStep` 정의 뒤(line 89 부근)에 새 타입 3개 추가:

```rust
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PercentilePoint {
    pub quantile: f64,
    pub value_us: u64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct HistogramBucket {
    pub lower_us: u64,
    pub upper_us: u64,
    pub count: u64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct LatencyDistribution {
    pub percentile_curve: Vec<PercentilePoint>,
    pub histogram: Vec<HistogramBucket>,
}
```

(c) `ReportJson`에 필드 추가 — `pub dropped: u64,`(line 22) 바로 뒤:

```rust
    #[serde(default)]
    pub latency: Option<LatencyDistribution>,
```

(d) `let overall_p = percentiles_of(&overall);`(line 282) 바로 뒤에 계산 추가:

```rust
    let latency = if overall.len() > 0 {
        Some(LatencyDistribution {
            percentile_curve: percentile_curve(&overall, &CURVE_QUANTILES)
                .into_iter()
                .map(|(quantile, value_us)| PercentilePoint { quantile, value_us })
                .collect(),
            histogram: log_buckets(&overall, HISTOGRAM_BINS)
                .into_iter()
                .map(|(lower_us, upper_us, count)| HistogramBucket {
                    lower_us,
                    upper_us,
                    count,
                })
                .collect(),
        })
    } else {
        None
    };
```

(e) `ReportJson { ... }` 반환 리터럴(line 343~363)의 `dropped: run.dropped as u64,`(line 362) 뒤에:

```rust
        latency,
```

- [ ] **Step 4: GREEN 확인**

Run: `cargo test -p handicap-controller --lib report::tests`
Expected: 신규 2개 포함 모든 report 유닛 테스트 PASS.

- [ ] **Step 5: 엔드포인트 round-trip 단언 추가** — `crates/controller/tests/report_test.rs`

`report_endpoint_returns_bundle_for_seeded_run`의 `let _typed: ReportJson = ...`(line 166) **앞에** 추가:

```rust
    // Latency distribution is emitted for a run with recorded samples.
    let latency = &json["latency"];
    assert!(latency.is_object(), "latency present");
    assert_eq!(latency["percentile_curve"].as_array().unwrap().len(), 11);
    assert!(!latency["histogram"].as_array().unwrap().is_empty());
```

- [ ] **Step 6: 전체 컨트롤러 테스트 + 게이트**

Run: `cargo test -p handicap-controller --lib report::tests && cargo test -p handicap-controller --test report_test`
Expected: PASS.
Run: `cargo build --workspace && cargo clippy -p handicap-controller --all-targets -- -D warnings`
Expected: 에러 0.

- [ ] **Step 7: 커밋**

cold-build flake 회피 위해 먼저: `cargo build -p handicap-worker && cargo build --workspace`

```bash
git add crates/controller/src/report.rs crates/controller/tests/report_test.rs
git commit -m "feat(controller): ReportJson.latency (분위 곡선 + 로그 히스토그램)

build_report가 이미 머지한 overall에서 LatencyDistribution을 추출해 emit.
샘플 0건이면 None(fail-soft). serde(default)라 골든 fixture·기존 행 호환,
마이그레이션 0·proto/워커 무변경.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

직후 `git log -1 --stat` 확인. flake(워커 ENOENT/SIGKILL/sigterm)면 동일 커밋 재시도.

---

## Task 3: UI Zod 스키마 + `formatLatency` 헬퍼

**Files:**
- Create: `ui/src/api/__tests__/reportLatency.test.ts`
- Create: `ui/src/components/report/__tests__/format.test.ts`
- Modify: `ui/src/api/schemas.ts`
- Create: `ui/src/components/report/format.ts`

- [ ] **Step 1: 실패 테스트 먼저 작성** (tdd-guard unblock) — 두 테스트 파일 Create

`ui/src/components/report/__tests__/format.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatLatency } from "../format";

describe("formatLatency", () => {
  it("formats sub-millisecond as µs", () => {
    expect(formatLatency(850)).toBe("850 µs");
  });
  it("formats single-digit ms with one decimal", () => {
    expect(formatLatency(1_200)).toBe("1.2 ms");
  });
  it("formats larger ms as integer", () => {
    expect(formatLatency(45_000)).toBe("45 ms");
  });
  it("formats seconds with one decimal", () => {
    expect(formatLatency(2_000_000)).toBe("2.0 s");
  });
});
```

`ui/src/api/__tests__/reportLatency.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ReportSchema } from "../schemas";

const base = {
  run: {
    id: "R",
    scenario_id: "S",
    status: "completed",
    profile: {},
    env: {},
    started_at: 100,
    ended_at: 102,
    created_at: 99,
  },
  scenario_yaml: "version: 1\nname: x\nsteps: []\n",
  summary: { count: 5, errors: 0, rps: 2.5, duration_seconds: 2, p50_ms: 20, p95_ms: 30, p99_ms: 30 },
  windows: [],
  steps: [],
  status_distribution: { "200": 5 },
  dropped: 0,
};

describe("ReportSchema latency", () => {
  it("parses a latency distribution object", () => {
    const r = ReportSchema.parse({
      ...base,
      latency: {
        percentile_curve: [{ quantile: 0.5, value_us: 20_000 }],
        histogram: [{ lower_us: 1_000, upper_us: 2_000, count: 5 }],
      },
    });
    expect(r.latency?.histogram[0].count).toBe(5);
    expect(r.latency?.percentile_curve[0].value_us).toBe(20_000);
  });
  it("accepts null latency (server None)", () => {
    const r = ReportSchema.parse({ ...base, latency: null });
    expect(r.latency ?? null).toBeNull();
  });
  it("accepts absent latency", () => {
    const r = ReportSchema.parse(base);
    expect(r.latency ?? null).toBeNull();
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test format reportLatency`
Expected: FAIL — `formatLatency`/`latency` 미존재(import 에러).

- [ ] **Step 3: `formatLatency` 헬퍼 작성** — `ui/src/components/report/format.ts` (Create)

```ts
/** Format a microsecond latency into a compact human string (µs / ms / s). */
export function formatLatency(us: number): string {
  if (!Number.isFinite(us) || us < 0) return "—";
  if (us < 1_000) return `${Math.round(us)} µs`;
  if (us < 1_000_000) {
    const ms = us / 1_000;
    return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  }
  return `${(us / 1_000_000).toFixed(1)} s`;
}
```

- [ ] **Step 4: Zod 스키마 작성** — `ui/src/api/schemas.ts` (Modify)

`ReportSummarySchema` 정의(line 165) **앞에** 추가:

```ts
export const PercentilePointSchema = z
  .object({
    quantile: z.number(),
    value_us: z.number().int().nonnegative(),
  })
  .strict();

export const HistogramBucketSchema = z
  .object({
    lower_us: z.number().int().nonnegative(),
    upper_us: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
  })
  .strict();

export const LatencyDistributionSchema = z
  .object({
    percentile_curve: z.array(PercentilePointSchema),
    histogram: z.array(HistogramBucketSchema),
  })
  .strict();
```

`ReportSchema` 객체의 `dropped: z.number(),`(line 227) 뒤에 추가:

```ts
    latency: LatencyDistributionSchema.nullish(),
```

파일의 report 타입 export 묶음(`export type Report = ...` line 231 부근) 끝에 추가:

```ts
export type LatencyDistribution = z.infer<typeof LatencyDistributionSchema>;
export type HistogramBucket = z.infer<typeof HistogramBucketSchema>;
export type PercentilePoint = z.infer<typeof PercentilePointSchema>;
```

> ⚠️ `.nullish()` 필수(`.optional()` 금지): 서버 `Option::None`이 `null`로 직렬화될 수 있다(`ui/CLAUDE.md` S-D 함정).

- [ ] **Step 5: GREEN 확인**

Run: `cd ui && pnpm test format reportLatency`
Expected: 모든 테스트 PASS.

- [ ] **Step 6: UI 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0 warning, 전체 test PASS, `tsc -b` clean.

```bash
git add ui/src/api/schemas.ts ui/src/api/__tests__/reportLatency.test.ts \
  ui/src/components/report/format.ts ui/src/components/report/__tests__/format.test.ts
git commit -m "feat(ui): LatencyDistribution Zod 스키마 + formatLatency 헬퍼

ReportSchema.latency(.nullish() — 서버 null 허용) + µs→사람단위 포맷터.
와이어 1:1(percentile_curve/histogram/value_us/lower_us/upper_us/count).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

직후 `git log -1 --stat` 확인.

---

## Task 4: `PercentileCurveChart` 컴포넌트

**Files:**
- Create: `ui/src/components/report/PercentileCurveChart.tsx`
- Create: `ui/src/components/report/__tests__/PercentileCurveChart.test.tsx`

- [ ] **Step 1: 실패 테스트 먼저 작성** — `__tests__/PercentileCurveChart.test.tsx` (Create)

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PercentileCurveChart } from "../PercentileCurveChart";

describe("PercentileCurveChart", () => {
  it("renders an SVG line chart for the percentile curve", () => {
    render(
      <PercentileCurveChart
        curve={[
          { quantile: 0.5, value_us: 20_000 },
          { quantile: 0.99, value_us: 80_000 },
          { quantile: 1.0, value_us: 120_000 },
        ]}
      />,
    );
    const region = screen.getByRole("region", { name: /Latency percentile curve/ });
    expect(region.querySelector("svg")).not.toBeNull();
    expect(region).toHaveTextContent("Latency by percentile");
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test PercentileCurveChart`
Expected: FAIL — 컴포넌트 미존재.

- [ ] **Step 3: 컴포넌트 작성** — `PercentileCurveChart.tsx` (Create)

```tsx
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import type { PercentilePoint } from "../../api/schemas";

type Props = {
  curve: PercentilePoint[];
  width?: number;
  height?: number;
};

const QUANTILE_LABEL: Record<string, string> = {
  "0": "min",
  "0.1": "p10",
  "0.25": "p25",
  "0.5": "p50",
  "0.75": "p75",
  "0.9": "p90",
  "0.95": "p95",
  "0.99": "p99",
  "0.999": "p99.9",
  "0.9999": "p99.99",
  "1": "max",
};

function labelFor(q: number): string {
  return QUANTILE_LABEL[String(q)] ?? `p${(q * 100).toFixed(2)}`;
}

export function PercentileCurveChart({ curve, width = 720, height = 220 }: Props) {
  // Categorical, evenly-spaced quantile axis so the tail (p99 → p99.99) reads
  // clearly. type="linear" — monotone smoothing would misrepresent the tail
  // (ui/CLAUDE.md repo trap, same as StageCurvePreview). y in milliseconds.
  const data = curve.map((p) => ({ label: labelFor(p.quantile), ms: p.value_us / 1_000 }));
  return (
    <section aria-label="Latency percentile curve" className="mb-6">
      <h4 className="text-sm font-semibold text-slate-700 mb-2">Latency by percentile</h4>
      <LineChart width={width} height={height} data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="label" />
        <YAxis label={{ value: "ms", angle: -90, position: "insideLeft" }} />
        <Tooltip />
        <Line type="linear" dataKey="ms" stroke="#2563eb" dot isAnimationActive={false} />
      </LineChart>
    </section>
  );
}
```

- [ ] **Step 4: GREEN 확인**

Run: `cd ui && pnpm test PercentileCurveChart`
Expected: PASS.

- [ ] **Step 5: UI 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm test PercentileCurveChart && pnpm build`
Expected: lint 0, 타깃 test PASS, `tsc -b` clean.

```bash
git add ui/src/components/report/PercentileCurveChart.tsx \
  ui/src/components/report/__tests__/PercentileCurveChart.test.tsx
git commit -m "feat(ui): PercentileCurveChart (분위 균등축 라인, type=linear)

min·p10·…·p99.99·max 카테고리 균등축 + y=ms. monotone 금지(꼬리 왜곡).
TimeSeriesChart 스타일(720×220, #2563eb, explicit size).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

직후 `git log -1 --stat` 확인.

---

## Task 5: `LatencyHistogramChart` 컴포넌트

**Files:**
- Create: `ui/src/components/report/LatencyHistogramChart.tsx`
- Create: `ui/src/components/report/__tests__/LatencyHistogramChart.test.tsx`

- [ ] **Step 1: 실패 테스트 먼저 작성** — `__tests__/LatencyHistogramChart.test.tsx` (Create)

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { LatencyHistogramChart } from "../LatencyHistogramChart";

describe("LatencyHistogramChart", () => {
  it("renders an SVG bar chart for non-empty buckets", () => {
    render(
      <LatencyHistogramChart
        buckets={[
          { lower_us: 1_000, upper_us: 2_000, count: 10 },
          { lower_us: 2_000, upper_us: 4_000, count: 25 },
          { lower_us: 4_000, upper_us: 8_000, count: 5 },
        ]}
      />,
    );
    const region = screen.getByRole("region", { name: /Latency histogram/ });
    expect(region.querySelector("svg")).not.toBeNull();
    expect(region).toHaveTextContent("Latency distribution");
  });

  it("shows empty-state text when no buckets", () => {
    render(<LatencyHistogramChart buckets={[]} />);
    expect(screen.getByText(/No latency data/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test LatencyHistogramChart`
Expected: FAIL — 컴포넌트 미존재.

- [ ] **Step 3: 컴포넌트 작성** — `LatencyHistogramChart.tsx` (Create)

```tsx
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import type { HistogramBucket } from "../../api/schemas";
import { formatLatency } from "./format";

type Props = {
  buckets: HistogramBucket[];
  width?: number;
  height?: number;
};

export function LatencyHistogramChart({ buckets, width = 720, height = 240 }: Props) {
  // Buckets are already log-spaced from the backend; render as a categorical bar
  // chart (equal-width bars) labelled by the bucket's lower edge. The log scale
  // is baked into the boundaries — do NOT use a Recharts log axis (finicky for bars).
  const data = buckets.map((b) => ({ label: formatLatency(b.lower_us), count: b.count }));
  const isEmpty = data.length === 0;
  return (
    <section aria-label="Latency histogram" className="mb-6">
      <h4 className="text-sm font-semibold text-slate-700 mb-2">Latency distribution</h4>
      {isEmpty ? (
        <p className="text-slate-500 text-sm italic">No latency data.</p>
      ) : (
        <BarChart width={width} height={height} data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="label" interval="preserveStartEnd" />
          <YAxis label={{ value: "count", angle: -90, position: "insideLeft" }} />
          <Tooltip />
          <Bar dataKey="count" fill="#16a34a" isAnimationActive={false} />
        </BarChart>
      )}
    </section>
  );
}
```

- [ ] **Step 4: GREEN 확인**

Run: `cd ui && pnpm test LatencyHistogramChart`
Expected: PASS (2 tests).

- [ ] **Step 5: UI 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm test LatencyHistogramChart && pnpm build`
Expected: lint 0, 타깃 test PASS, `tsc -b` clean.

```bash
git add ui/src/components/report/LatencyHistogramChart.tsx \
  ui/src/components/report/__tests__/LatencyHistogramChart.test.tsx
git commit -m "feat(ui): LatencyHistogramChart (로그-버킷 카테고리 바)

백엔드 로그 경계가 내장된 등폭 카테고리 바(x 라벨=formatLatency(lower_us)).
Recharts log축 회피. empty-state 포함. StatusDistribution 바 패턴.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

직후 `git log -1 --stat` 확인.

---

## Task 6: ReportView 슬롯 + 통합 테스트

**Files:**
- Modify: `ui/src/components/report/ReportView.tsx`
- Modify: `ui/src/components/report/__tests__/ReportView.test.tsx`

- [ ] **Step 1: 실패 테스트 작성** — `__tests__/ReportView.test.tsx` (Modify)

`describe("ReportView", …)` 블록 안(마지막 `it` 뒤)에 2개 추가:

```tsx
  it("renders latency charts when report.latency is present", () => {
    const report: Report = {
      ...FIXTURE,
      latency: {
        percentile_curve: [
          { quantile: 0.5, value_us: 10_000 },
          { quantile: 0.99, value_us: 90_000 },
          { quantile: 1.0, value_us: 120_000 },
        ],
        histogram: [
          { lower_us: 1_000, upper_us: 2_000, count: 8 },
          { lower_us: 2_000, upper_us: 4_000, count: 7 },
        ],
      },
    };
    render(<ReportView report={report} />);
    expect(screen.getByRole("region", { name: /Latency percentile curve/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Latency histogram/ })).toBeInTheDocument();
  });

  it("omits latency charts when report.latency is absent", () => {
    render(<ReportView report={FIXTURE} />);
    expect(screen.queryByRole("region", { name: /Latency percentile curve/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Latency histogram/ })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test ReportView`
Expected: 새 "renders latency charts…" FAIL(region 미존재), "omits…" PASS.

- [ ] **Step 3: 슬롯 배선** — `ui/src/components/report/ReportView.tsx` (Modify)

import 블록(line 16, `InsightPanel` import 뒤)에 추가:

```tsx
import { PercentileCurveChart } from "./PercentileCurveChart";
import { LatencyHistogramChart } from "./LatencyHistogramChart";
```

Errors/sec `TimeSeriesChart`(line 144~148) **뒤**, `<StatusDistribution …/>`(line 149) **앞**에 삽입:

```tsx
      {report.latency ? (
        <div>
          <h3 className="text-lg font-semibold mb-2">Latency</h3>
          <PercentileCurveChart curve={report.latency.percentile_curve} />
          <LatencyHistogramChart buckets={report.latency.histogram} />
        </div>
      ) : null}
```

- [ ] **Step 4: GREEN 확인**

Run: `cd ui && pnpm test ReportView`
Expected: 모든 ReportView 테스트 PASS.

- [ ] **Step 5: 전체 UI 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0, **전체** test PASS(타깃 green ≠ 전체 green — S-D 교훈), `tsc -b` clean.

```bash
git add ui/src/components/report/ReportView.tsx \
  ui/src/components/report/__tests__/ReportView.test.tsx
git commit -m "feat(ui): ReportView에 Latency 분포 섹션 슬롯

Errors 시계열 뒤·StatusDistribution 앞에 곡선+히스토그램(report.latency
있을 때만). 세 시계열 묶음 유지.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

직후 `git log -1 --stat` 확인.

---

## 최종 검증 (orchestrator, 머지 전)

- [ ] **전체 게이트 재확인**: `cargo build -p handicap-worker && cargo test --workspace`(0 fail) + `cd ui && pnpm lint && pnpm test && pnpm build`(전체 green).
- [ ] **라이브 run 1회** (S-D 교훈 — run 생성/응답 파싱은 RTL absent fixture로 안 잡힘; `dev-doctor` 스킬로 스택 기동 권장):
  - controller + worker 기동(`cargo build -p handicap-worker --bin worker` 먼저), 격리 DB. wiremock/echo 타깃에 `set_delay(5ms+)`로 p95>0 보장(localhost는 sub-ms라 분위가 0될 수 있음 — controller CLAUDE.md).
  - RunDialog로 run 1개 생성 → 종료 → Report 페이지에서 "Latency by percentile"·"Latency distribution" 두 차트가 렌더되는지 확인.
  - curl 대안: `GET /api/runs/{id}/report` 응답 JSON에 `latency.percentile_curve`(11점)·`latency.histogram`(≤40) 존재 + `ReportSchema` 통과 확인.
  - (Playwright 사용 시) 머지 전 `rm -rf .playwright-mcp` + 루트 png 정리(gitignore 안 됨, 루트 CLAUDE.md).
- [ ] **최종 whole-feature 리뷰**: `handicap-reviewer` 에이전트 — Rust `PercentilePoint`/`HistogramBucket`/`LatencyDistribution` ↔ Zod 와이어 1:1(필드명 snake_case·`value_us`/`lower_us`/`upper_us`), `.nullish()` 사용, `log_buckets` Σ==len 불변식, 부하경로 무변경 재확인.
- [ ] **머지**: `git -C /Users/sgj/develop/handicap merge --ff-only <branch>`(워크트리면 메인 경로로) → `ExitWorktree(remove, discard_changes:true)`.
- [ ] **문서 갱신**: roadmap §B7 "D. 레이턴시 히스토그램/분위 곡선" 완료 표시 + 루트 CLAUDE.md 상태 줄 + auto-memory 1줄. ADR 불필요(additive — spec 결론).

---

## Self-Review 노트 (작성자 체크 완료)

- **Spec 커버리지**: §3.2 곡선(Task 1·2·4) / §3.3 로그 버킷 iter_recorded 분할(Task 1·2·5) / §4 타입·배선·차트(Task 2·3·4·5·6) / §5 테스트(각 task) / §6 와이어 1:1·라이브 run(최종 검증) — 전부 매핑됨.
- **타입 일관**: `value_us`/`lower_us`/`upper_us`/`count`/`quantile`/`percentile_curve`/`histogram`/`latency`가 Rust 구조체(Task 2) ↔ Zod(Task 3) ↔ 컴포넌트 props(Task 4·5)에서 동일.
- **게이트 경계**: 각 task가 단일 green 커밋(dead-code/RED-only 단독 커밋 없음). Task 1·2는 Rust(pre-commit cargo 게이트), Task 3~6은 UI(수동 pnpm 게이트).

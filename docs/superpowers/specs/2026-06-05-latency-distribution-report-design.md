# 레이턴시 분포 리포트 (분위 곡선 + 히스토그램) — 설계

- **날짜**: 2026-06-05
- **출처**: 로드맵 §B7 "D. 레이턴시 히스토그램/분위 곡선 — 바로 다음 작은 슬라이스 후보" (A4 LoadRunner급 리포트 영역의 후속)
- **성격**: 리포트 깊이 확장. controller(리포트 빌드) + UI 중심, 엔진은 리포트용 순수 헬퍼만 추가.
- **ADR**: 불필요(additive, 새 아키텍처 결정 없음 — A4c와 동형). 비자명한 결정이 드러나면 그때 추가.

## 1. 목표 / 비목표

### 목표
종료된 run 리포트에 run 전체 레이턴시 분포를 두 가지로 시각화한다:
1. **분위 곡선** (percentile curve): x=분위, y=지연. 고정 p50/p95/p99가 숨기는 **꼬리 지연**(p99.9·p99.99)을 읽게 한다.
2. **레이턴시 히스토그램** (latency histogram): x=지연 구간(로그 간격), y=요청 수. 분포 **모양**(이중 봉우리 등)을 보여준다.

### 비목표 (이 슬라이스 밖, 연기)
- **step별 드릴다운**: `per_step` 머지 히스토그램은 이미 메모리에 있으나 v1은 run 전체만. step 셀렉터 UI + 페이로드 확장은 후속.
- **성공/오류 분리 히스토그램**: v1은 모든 요청(상태 무관, summary p50/p95/p99와 동일 모집단).
- **run 비교 곡선 오버레이**: 여러 run 곡선을 한 차트에 (로드맵 B7, A4b 비교 뷰 후속).
- **per-window 히스토그램**: 시간대별 분포 변화. v1은 run 전체 집계 1개.
- **진짜 로그 축**(Recharts `scale="log"`): 로그성은 백엔드 버킷 경계에 내장하고 축은 카테고리로 렌더(아래 §4.2 함정).
- **DB 캐싱**: 페이로드가 작아(곡선 11점 + 버킷 ≤40) on-demand 계산으로 충분. 새 테이블 없음.

## 2. 핵심 관찰: 데이터는 이미 있다

`crates/controller/src/report.rs`의 `build_report`는 run의 모든 워커·스텝·윈도 HDR BLOB을 디코드해 **run 전체 머지 히스토그램** `overall: Histogram<u64>`을 이미 in-memory로 만든다(`report.rs:222` 부근). 현재는 거기서 `percentiles_of(&overall)`로 **p50/p95/p99 3개만** 뽑고(`report.rs:282`) 나머지 분위/버킷은 버린다.

따라서 이 슬라이스는 **새 데이터 수집이 아니라, 이미 만들어진 `overall`에서 더 뽑아 emit**하는 것이다. 엔진 부하경로·워커·proto·`run_metrics` 테이블·마이그레이션 **전부 무변경**.

- HDR 단위: **마이크로초**, 범위 1µs–60s, 3 sigfig (`report.rs:166-168` 상수).
- 머지는 무손실(동일 bound)이라 `overall`은 run 전체 정확한 분포.

## 3. 데이터 표현 (와이어 포맷)

### 3.1 단위 결정: 마이크로초(u64)
새 두 구조는 **마이크로초 정수(u64)**로 값을 싣는다.
- 이유: HDR 네이티브 단위라 무손실. 기존 `_ms` 필드는 정수 ms floor라 저지연(예: 500µs=0.5ms)이 0으로 뭉개진다 — 로그 히스토그램의 저지연 끝과 곡선 저분위에서 해상도 손실.
- 기존 `p50_ms`/`p95_ms`/`p99_ms`(summary·windows·steps)는 **그대로 유지**(별개 필드, 변경 없음).
- UI가 사람 단위로 포맷(`formatLatency`).

### 3.2 분위 곡선
고정 분위 집합(엔진 상수):
```
CURVE_QUANTILES = [0.0, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99, 0.999, 0.9999, 1.0]   // 11점
```
각 분위 q에 대해 `value_at_quantile(q)` (µs). q=0.0→최소 기록값, q=1.0→최대.

### 3.3 히스토그램 (로그 간격 버킷)
목표 빈 수(엔진 상수) `HISTOGRAM_BINS = 40`.

**버킷 카운트는 반드시 iteration 기반 분할로 구한다 — `count_between`로 빼지 않는다.** `hdrhistogram::count_between(low, high)`는 inclusive이고 `low`/`high`를 각각 HDR 서브버킷 edge로 내림/올림 snap한다(7.5.4 `lib.rs:1426-1475`). 저지연에선 로그 경계 간격이 서브버킷 폭과 비슷해 `b[i+1]-1`과 `b[i+1]`이 같은 서브버킷에 떨어지고, 그 서브버킷이 인접 두 빈에 **모두** 포함돼 `Σ count > h.len()`이 된다 — 정수 경계 dedupe로도 못 막는다(>1µs 떨어진 경계도 같은 서브버킷일 수 있음).

올바른 방식(각 기록 서브버킷을 정확히 한 빈에 배정 → 정확 분할):
- `lo = max(1, h.min())`, `hi = h.max()` (둘 다 기록된 값, µs).
- 표시 경계(라벨용) `edge[i] = lo * (hi/lo)^(i/N)` (f64), i ∈ 0..=N → 로그 간격.
- `counts[0..N] = 0`. **`h.iter_recorded()`** 로 순회하며 각 항목의 대표값 `v = it.value_iterated_to()`, 카운트 `c = it.count_since_last_iteration()`에 대해 빈 인덱스 `j = clamp(floor(N · ln(v/lo) / ln(hi/lo)), 0, N-1)`, `counts[j] += c`.
- 버킷 i: `lower_us = round(edge[i])`, `upper_us = round(edge[i+1])`, `count = counts[i]`. (빈 카운트 0 버킷도 유지 — 축 안정.)
- **불변식**: 각 기록 서브버킷이 `iter_recorded`에서 정확히 한 번 yield되어 한 빈에만 더해지므로 Σ(버킷 count) == `h.len()` (총 기록 수) — 정확.
- 엣지: `h.is_empty()`→`[]`(호출자가 `None` emit), `lo==hi`(degenerate min==max)→단일 버킷 `[lo,hi]` count=총수. (NB: 동일 값을 여러 번 기록해도 HDR 서브버킷 bound 때문에 보통 `min<max`라 이 분기 대신 일반 루프를 타고 한 빈에 들어간다 — `clippy::len_zero` 회피 위해 `h.len()==0` 아닌 `h.is_empty()`.)

## 4. 컴포넌트 설계

### 4.1 엔진 헬퍼 — `crates/engine/src/percentiles.rs` (순수 추가)
`decode_hdr`/`percentiles_of`/`merge_into` 옆에 추가. **리포트 전용**(엔진 런타임/executor는 호출 안 함 — 부하경로 byte-identical).
```rust
pub const CURVE_QUANTILES: [f64; 11] =
    [0.0, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99, 0.999, 0.9999, 1.0];
pub const HISTOGRAM_BINS: usize = 40;

/// (quantile, value_us). 호출자가 h.len()==0 이면 호출하지 않는다.
pub fn percentile_curve(h: &Histogram<u64>, quantiles: &[f64]) -> Vec<(f64, u64)>;

/// (lower_us, upper_us, count). 빈→[], min==max→단일.
/// `iter_recorded()`로 각 기록 서브버킷을 값 기준 로그 빈에 배정(정확 분할,
/// Σcount==len). count_between 반열림 빼기 금지(§3.3 — 서브버킷 snap 이중카운트).
pub fn log_buckets(h: &Histogram<u64>, bins: usize) -> Vec<(u64, u64, u64)>;
```

### 4.2 컨트롤러 — `crates/controller/src/report.rs` (순수 추가)
```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PercentilePoint { pub quantile: f64, pub value_us: u64 }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistogramBucket { pub lower_us: u64, pub upper_us: u64, pub count: u64 }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LatencyDistribution {
    pub percentile_curve: Vec<PercentilePoint>,
    pub histogram: Vec<HistogramBucket>,
}

// ReportJson 에 추가:
#[serde(default)]
pub latency: Option<LatencyDistribution>,
```
`build_report`에서 `overall_p` 계산 직후:
```rust
let latency = if !overall.is_empty() {  // clippy::len_zero — len()>0 금지
    Some(LatencyDistribution {
        percentile_curve: percentile_curve(&overall, &CURVE_QUANTILES)
            .into_iter().map(|(q, v)| PercentilePoint { quantile: q, value_us: v }).collect(),
        histogram: log_buckets(&overall, HISTOGRAM_BINS)
            .into_iter().map(|(lo, hi, c)| HistogramBucket { lower_us: lo, upper_us: hi, count: c }).collect(),
    })
} else { None };
```
`#[serde(default)]`로 골든 fixture·기존 직렬화 리포트 호환. A4b `testdata/compare_golden.json`은 **full `ReportJson` 객체를 담지만** 무영향 — `ReportJson`이 `deny_unknown_fields`를 안 쓰고(`report.rs:8`) 새 필드가 `#[serde(default)]`라 `latency` 없는 fixture는 `None`으로 역직렬화되고, TS 비교 측은 `summary`만 읽는다. plan에서 round-trip 확인.

### 4.3 UI

#### Zod — `ui/src/api/schemas.ts`
```ts
const PercentilePointSchema = z.object({
  quantile: z.number(),
  value_us: z.number().int().nonnegative(),
}).strict();
const HistogramBucketSchema = z.object({
  lower_us: z.number().int().nonnegative(),
  upper_us: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
}).strict();
const LatencyDistributionSchema = z.object({
  percentile_curve: z.array(PercentilePointSchema),
  histogram: z.array(HistogramBucketSchema),
}).strict();
// ReportSchema 에:  latency: LatencyDistributionSchema.nullish(),
```
**`.nullish()` 필수** — 서버 `Option::None`이 `null`로 직렬화될 수 있고 `.optional()`은 `null`을 거부한다(S-D 회귀 교훈, `ui/CLAUDE.md`).

#### 차트 컴포넌트 (`ui/src/components/report/`)
TimeSeriesChart 스타일 그대로: 명시 width/height, `#2563eb`(라인)·`#16a34a`(바), `CartesianGrid strokeDasharray="3 3"`, `<Tooltip />`, `isAnimationActive={false}`, `<section aria-label className="mb-6">`. 헤더 태그는 `<h4>`로 통일(TimeSeriesChart와 동일; StatusDistribution의 `<h3>` 말고).

- **`PercentileCurveChart.tsx`** — `LineChart`. x=분위 라벨 **카테고리 균등축**(`XAxis dataKey="label" type="category"`), 라벨: `min·p10·p25·p50·p75·p90·p95·p99·p99.9·p99.99·max`. y=지연. **`<Line type="linear">` (monotone 금지)** — `ui/CLAUDE.md` repo trap: monotone는 piecewise를 부드럽게 왜곡해 꼭 드러내야 할 p99→p99.99 꼬리를 오도한다(S-D StageCurvePreview와 동일 규칙). Tooltip에 정확한 분위+`formatLatency(value_us)`. 균등 간격이라 꼬리가 또렷.
- **`LatencyHistogramChart.tsx`** — `BarChart`. x=버킷 **카테고리축**(틱 라벨=`formatLatency(lower_us)`, 경계가 이미 로그 간격→막대 등폭=표준 로그-binned 히스토그램). y=count. `<Bar dataKey="count" fill="#16a34a" />`. Tooltip: `[lower–upper] : count`.
  - ⚠️ **함정**: Recharts `scale="log"` 축은 bar 차트에서 까다롭다. 로그성은 백엔드 버킷 경계에 내장하고 축은 카테고리로 둔다(라벨 과밀 시 `interval`로 일부만 표시).

#### 포맷 헬퍼
`formatLatency(us: number): string` — `<1000`→`"850 µs"`, `<1_000_000`→`"1.2 ms"`, 그 이상→`"2.0 s"`. 공유 위치(예: `ui/src/components/report/format.ts` 또는 기존 유틸).

#### 슬롯 — `ui/src/components/report/ReportView.tsx`
ReportView는 TimeSeriesChart **3개**(Requests/sec `~134`, p95 `~139`, Errors/sec `~144`)를 연달아 렌더한 뒤 `StatusDistribution`(`~149`)을 그린다. "Latency distribution" 섹션(두 차트 세로 스택)을 **Errors/sec 차트 뒤·StatusDistribution 앞**(`~line 148`과 `149` 사이)에 삽입해 세 시계열을 한 묶음으로 유지한다. `report.latency`가 없으면(요청 0건) 섹션 전체 미렌더.

## 5. 테스트 전략

- **엔진 유닛** (`crates/engine/tests/percentiles_test.rs` — **이미 존재**, `record_us`/`serialize` 헬퍼 재사용해 append):
  - `percentile_curve`: 알려진 분포→알려진 분위 값, **단조 비감소**(non-decreasing — `value_at_quantile`는 인접 분위에 동일 값 반환 가능, strict 증가 단언 금지).
  - `log_buckets`: Σcount == 총 기록 수(정확 분할), 경계 단조, `min==max` 단일 버킷, 빈 히스토그램→`[]`. **특히 저지연 다수 샘플(서브버킷 폭~경계 간격)에서 Σcount==len 회귀 케이스** 포함.
- **컨트롤러** (`crates/controller/tests/report_test.rs`): round-trip(`to_value`/`from_value`) + 샘플 있을 때 `latency` Some(곡선 11점·버킷 ≤40·Σcount=총수), 샘플 없을 때 `None`.
- **UI (RTL)**: 두 차트 fixture 렌더(막대/점 존재 단언) + `ReportSchema` parse(`latency: null`→`undefined`, 정상 객체 둘 다).

## 6. 게이트 / 와이어 1:1

- Rust: `cargo fmt` + `cargo build --workspace` + `cargo clippy --workspace --all-targets -- -D warnings` + `cargo test --workspace` (pre-commit 훅).
- UI: `cd ui && pnpm lint && pnpm test && pnpm build` (수동 — 훅은 cargo만).
- **필드명 snake_case 1:1**: `latency`/`percentile_curve`/`histogram`/`quantile`/`value_us`/`lower_us`/`upper_us`/`count`. Rust 구조체 ↔ Zod 정확 대조(최종 handicap-reviewer).
- 머지 전 라이브 run 1회(RunDialog→리포트)로 새 섹션 렌더 + `latency` null/object 경로 확인(S-D 교훈: run 생성/응답 파싱은 RTL absent fixture로 안 잡힘).

## 7. 구현 순서 (plan에서 세분)

1. 엔진 헬퍼 `percentile_curve`/`log_buckets` + 유닛 테스트.
2. 컨트롤러 `LatencyDistribution` 타입 + `build_report` 배선 + round-trip 테스트.
3. UI Zod 스키마 + `formatLatency` + 두 차트 컴포넌트 + RTL.
4. ReportView 슬롯 + 라이브 검증.

(pre-commit 전체-게이트 때문에 dead-code/RED-only 단독 커밋 불가 — 헬퍼+테스트+배선을 green 커밋 단위로 묶는다. CLAUDE.md "검증 자동화" 참조.)

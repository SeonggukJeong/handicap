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
- `lo = max(1, h.min())`, `hi = h.max()` (둘 다 기록된 값, µs).
- 경계 `b[i] = round(lo * (hi/lo)^(i/N))`, i ∈ 0..=N → 로그 간격.
- 버킷 i = `[b[i], b[i+1])` 반열림, 마지막 버킷은 max 포함. count = `h.count_between(b[i], b[i+1]-1)` (마지막은 `..=hi`).
- **불변식**: Σ(버킷 count) == `h.len()` (총 기록 수).
- 엣지: `h.len()==0`→`[]`(호출자가 `None` emit), `lo==hi`(전부 동일값)→단일 버킷 `[lo,hi]` count=총수. 저지연서 정수 경계가 인접 중복(1,1,2,…)이면 **단조 증가로 dedupe**(빈 수 < 40 허용).

## 4. 컴포넌트 설계

### 4.1 엔진 헬퍼 — `crates/engine/src/percentiles.rs` (순수 추가)
`decode_hdr`/`percentiles_of`/`merge_into` 옆에 추가. **리포트 전용**(엔진 런타임/executor는 호출 안 함 — 부하경로 byte-identical).
```rust
pub const CURVE_QUANTILES: [f64; 11] =
    [0.0, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99, 0.999, 0.9999, 1.0];
pub const HISTOGRAM_BINS: usize = 40;

/// (quantile, value_us). 호출자가 h.len()==0 이면 호출하지 않는다.
pub fn percentile_curve(h: &Histogram<u64>, quantiles: &[f64]) -> Vec<(f64, u64)>;

/// (lower_us, upper_us, count). 빈→[], min==max→단일, 경계 단조 dedupe.
/// hdrhistogram `count_between`(inclusive) 사용. 없으면 iter 폴백.
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
let latency = if overall.len() > 0 {
    Some(LatencyDistribution {
        percentile_curve: percentile_curve(&overall, &CURVE_QUANTILES)
            .into_iter().map(|(q, v)| PercentilePoint { quantile: q, value_us: v }).collect(),
        histogram: log_buckets(&overall, HISTOGRAM_BINS)
            .into_iter().map(|(lo, hi, c)| HistogramBucket { lower_us: lo, upper_us: hi, count: c }).collect(),
    })
} else { None };
```
`#[serde(default)]`로 골든 fixture·기존 직렬화 리포트 호환. A4b `testdata/compare_golden.json`은 델타 전용이라 무영향(추가 필드는 무시) — plan에서 round-trip 확인.

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
TimeSeriesChart 스타일 그대로: 명시 width/height, `#2563eb`(라인)·`#16a34a`(바), `CartesianGrid strokeDasharray="3 3"`, `<Tooltip />`, `isAnimationActive={false}`, `<section aria-label className="mb-6">`.

- **`PercentileCurveChart.tsx`** — `LineChart`. x=분위 라벨 **카테고리 균등축**(`XAxis dataKey="label" type="category"`), 라벨: `min·p10·p25·p50·p75·p90·p95·p99·p99.9·p99.99·max`. y=지연. Tooltip에 정확한 분위+`formatLatency(value_us)`. 균등 간격이라 꼬리(p99→p99.99)가 또렷.
- **`LatencyHistogramChart.tsx`** — `BarChart`. x=버킷 **카테고리축**(틱 라벨=`formatLatency(lower_us)`, 경계가 이미 로그 간격→막대 등폭=표준 로그-binned 히스토그램). y=count. `<Bar dataKey="count" fill="#16a34a" />`. Tooltip: `[lower–upper] : count`.
  - ⚠️ **함정**: Recharts `scale="log"` 축은 bar 차트에서 까다롭다. 로그성은 백엔드 버킷 경계에 내장하고 축은 카테고리로 둔다(라벨 과밀 시 `interval`로 일부만 표시).

#### 포맷 헬퍼
`formatLatency(us: number): string` — `<1000`→`"850 µs"`, `<1_000_000`→`"1.2 ms"`, 그 이상→`"2.0 s"`. 공유 위치(예: `ui/src/components/report/format.ts` 또는 기존 유틸).

#### 슬롯 — `ui/src/components/report/ReportView.tsx`
"Latency distribution" 섹션(두 차트 세로 스택)을 **p95 TimeSeriesChart 뒤·StatusDistribution 앞**(현재 ~line 143–149 사이)에 삽입. `report.latency`가 없으면(요청 0건) 섹션 전체 미렌더.

## 5. 테스트 전략

- **엔진 유닛** (`crates/engine/tests/percentiles_test.rs`):
  - `percentile_curve`: 알려진 분포→알려진 분위 값, 단조 증가.
  - `log_buckets`: Σcount == 총 기록 수, 경계 단조, `min==max` 단일 버킷, 빈 히스토그램→`[]`, 저지연 dedupe.
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

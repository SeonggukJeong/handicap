# B6: status-class criteria + per-window 최소 RPS — 설계

- 날짜: 2026-06-06
- 영역: A4 (LoadRunner급 리포트 깊이) / roadmap §B6 (A4a 연기 항목)
- 출처: roadmap §B6 — A4a(`2026-06-03-a4a-slo-pass-fail-criteria-design.md`, ADR-0028)가 명시적으로 연기한 두 criterion 종류.
- 선행: A4a(run-level SLO verdict) 머지 완료. 이 슬라이스는 A4a의 fixed-field `Criteria` + 일반형 `Verdict` 출력을 그대로 확장한다.

## 1. 목표 한 줄

종료된 run의 SLO verdict가 **(1) 생 4xx/5xx 응답**(`error_rate`가 status assertion 없이는 못 잡는 한계, A4a §9)과 **(2) 정상상태 throughput 붕괴**(per-window 최소 RPS, A4a의 평균-기반 `min_rps`가 못 잡는 mid-run dip)를 잡도록 criterion 종류를 넓힌다.

## 2. 범위

### IN

- status-class criteria 4종: `max_4xx_rate` / `max_5xx_rate`(분수) + `max_4xx_count` / `max_5xx_count`(절대수). `status_distribution`(이미 리포트에 있음) 기반.
- per-window 최소 RPS criterion: `min_window_rps` + 수식자 `rps_warmup_seconds`(앞 N초 제외). per-second 총 RPS의 최소값 기반.
- 평가 함수 `evaluate_criteria` 확장(시그니처에 `status_dist` + `windows` 추가).
- `validate_run_config`(runs + presets 공유 게이트)에 신규 필드 검증.
- RunDialog SLO 입력 + ReportView verdict 패널이 신규 행을 렌더.

### OUT (연기 — roadmap §B6에 잔류)

- **일반 연산자 모델**(`{metric, op, threshold}` 자유 조합) — 입력 리팩터. 이 슬라이스는 fixed-field 유지(YAGNI; A4a §10 출력은 이미 일반형이라 후속이 안전).
- **run 목록 pass/fail 배지** — 영속화(`verdict_json` + 완료 시 평가 + migration) 필요. 별개 성격(가시성).
- **step-level criteria** — step_id 셀렉터 + 중첩 매칭.
- **2xx/3xx 클래스 criterion** — 신호 가치 낮음(성공/리다이렉트는 보통 게이트 대상 아님). 필요 시 동형 추가.
- **open-loop stages ramp 길이 자동 prefill** — UI는 closed-loop `ramp_up_seconds`만 prefill. open-loop은 사용자가 warmup 수동 입력 + 힌트(§8.2). 컨트롤러/UI 모두 stage 곡선을 해석하지 않는다.

> **rate 분모는 insights와 통일**(spec-review MAJOR-1 반영): `4xx_rate`/`5xx_rate`의 분모는 `summary.count`가 아니라 **HTTP 응답 수(status 1–5, transport 실패 `"0"` 제외)** 로, A4c `insights.rs::status_class`(`:121-125`)와 **동일 정의**다 — 같은 리포트의 InsightPanel·VerdictPanel에 "4xx 비율"이 두 숫자로 안 갈리게. 두 정의가 갈라지지 않도록 **공유 순수 헬퍼**로 단일화(§5.1).

## 3. 핵심 결정 (확정 — brainstorming 2026-06-06)

| 결정 | 값 | 이유 |
|---|---|---|
| criterion 모델 형태 | **A4a fixed-field 유지** (필드별 `Option`) | 일반 연산자 리팩터는 별개 슬라이스. 출력은 이미 일반형(`CriterionResult`)이라 후속 호환. |
| status-class 표현 | **rate + count 둘 다** (4xx/5xx 각각) | 사용자 확정 — rate는 고처리량 blip 내성, count(`==0`)는 "무조건 0 5xx" 고전 게이트. 둘 다 제공. |
| 클래스 분류 | `status_distribution` 키 prefix: `'4'`→4xx, `'5'`→5xx | transport 실패 `"0"`·`"2"`/`"3"`은 어느 클래스도 아님. |
| rate 분모 | **HTTP 응답 수**(status 1–5, `"0"` 제외) = `insights total_http` | insights `status_class`와 동일 정의 → 한 리포트 두 패널 숫자 통일(공유 헬퍼, §5.1). `error_rate`(분자=엔진 실패, status 무관)와 분모를 맞춰도 실익 없음(분자가 다름). |
| per-window 윈도 정책 | **경계 부분초 제외 + warmup trim** (첫·마지막 second 항상 제외, 추가로 앞 warmup초) | ramp 자동제외(B)는 open-loop stages 곡선 해석이 필요해 살집·위험. 사용자 warmup이 closed/open 균일 처리 + 컨트롤러가 곡선 무지. 첫 부분초 항상 제외라 warmup=0도 안전(spec-review MAJOR-2 반영). |
| 평가 불가(윈도 부족) | **criterion skip** (행 미생성, FAIL 아님) | 짧은 run·과대 warmup으로 eligible 윈도 0개면 "데이터 부족"이지 위반 아님 — 건강한 run을 거짓 FAIL 안 함(spec-review MAJOR-2). 전부 skip되면 verdict=None(N-3). |
| warmup prefill | **UI가 `ramp_up_seconds`로 prefill** (closed) | closed-loop 무설정 정합. open-loop stages는 수동(컨트롤러/UI 곡선 해석 회피). |
| 평가 위치 | **A4a와 동일** `build_report` on-demand (B2) | 마이그레이션·완료-훅 0. status_dist·windows가 이미 그 시점 scope에 있음(검증: `report.rs:372`). |
| 저장 | `Profile.criteria`(profile_json, `#[serde(default)]`) | A4a와 동일. 마이그레이션 0, 프리셋 자동 캡처. |

## 4. 데이터 모델 (controller)

`crates/controller/src/store/runs.rs`의 `Criteria`에 6개 필드 추가(A4a 패턴 미러):

```rust
pub struct Criteria {
    // … A4a 기존 5필드: max_p50_ms / max_p95_ms / max_p99_ms / max_error_rate / min_rps …

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_4xx_rate: Option<f64>,   // 분수 0.0..=1.0 (UI %)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_5xx_rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_4xx_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_5xx_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_window_rps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rps_warmup_seconds: Option<u32>, // min_window_rps 수식자 — None = 0
}
```

- **`has_any()` 갱신**: 4 status 필드 + `min_window_rps`를 OR에 추가. **`rps_warmup_seconds`는 제외** — 기준(criterion)이 아니라 수식자라, 그것만 Some이면 verdict를 만들지 않는다. (N-3)
- 마이그레이션 0(`profile_json` `#[serde(default)]`, 기존 행 None). proto/엔진/워커 무변경. 프리셋(`run_presets.profile_json`)이 같은 `Profile` 직렬화라 저장/prefill 자동 포함(A4a 이음새 재사용).

## 5. 평가 (`evaluate_criteria` 확장 — 순수 함수)

`crates/controller/src/report.rs`. **시그니처 변경**(현재 `(&Criteria, &ReportSummary)`):

```rust
pub fn evaluate_criteria(
    c: &crate::store::runs::Criteria,
    s: &ReportSummary,
    status_dist: &BTreeMap<String, u64>,
    windows: &[ReportWindow],
) -> Verdict
```

`Verdict` / `CriterionResult` 타입은 **무변경**(이미 일반형, `report.rs:116/122`). 새 행은 기존 `metric: String` / `direction: String` 계약에 그대로 얹는다.

### 5.1 status-class 평가 (insights와 공유 헬퍼 — MAJOR-1)

분류·분모 정의가 `insights.rs::status_class`(`:121-137`)와 **단일 소스**가 되도록, 두 모듈이 쓰는 순수 헬퍼를 `report.rs`에 추출하고 `insights.rs`를 그 헬퍼로 리팩터(같은 `total_http` 분모를 두 번 정의하지 않음):
```rust
/// 특정 클래스(prefix '4'/'5')의 응답 수.
pub(crate) fn status_class_count(status_dist: &BTreeMap<String, u64>, first: char) -> u64 {
    status_dist.iter().filter(|(k, _)| k.starts_with(first)).map(|(_, v)| *v).sum()
}
/// HTTP 응답 총수(키 첫 글자 '1'..='5'; transport 실패 "0" 제외) — insights total_http와 동일.
pub(crate) fn http_response_total(status_dist: &BTreeMap<String, u64>) -> u64 {
    status_dist.iter()
        .filter(|(k, _)| matches!(k.chars().next(), Some('1'..='5')))
        .map(|(_, v)| *v).sum()
}
```
> `insights.rs:121-125`의 인라인 `total_http`·`class_count`를 이 두 헬퍼 호출로 교체 → InsightPanel·VerdictPanel의 "4xx 비율"이 **구조적으로 동일**(divergence 불가). 패리티 회귀 테스트로 락인.

- **rate** (`max_4xx_rate`/`max_5xx_rate`): `total = http_response_total(status_dist)`; `actual = if total == 0 { 0.0 } else { status_class_count(.., '4'|'5') as f64 / total as f64 }`, `passed = actual <= threshold`, direction `"max"`, metric `"4xx_rate"`/`"5xx_rate"`. (HTTP 응답 0 → 0.0.)
- **count** (`max_4xx_count`/`max_5xx_count`): `actual = status_class_count(..) as f64`(N-1 f64 캐스트 계약), `threshold = t as f64`, `passed = actual <= threshold`, direction `"max"`, metric `"4xx_count"`/`"5xx_count"`.

### 5.2 per-window 최소 RPS 평가 (경계 제외 + skip-on-부족 — MAJOR-2)

순수 헬퍼(테스트 가능):
```rust
/// per-second 총 RPS(그 ts_second의 모든 step count 합)의 정상상태 최소값.
/// **첫·마지막 second(경계 부분초)를 항상 제외**하고, 추가로 앞 `warmup`초를 제외한다.
/// eligible 윈도가 없으면(짧은 run·과대 warmup) None → criterion skip(평가 불가).
fn min_window_rps(windows: &[ReportWindow], warmup_seconds: u32) -> Option<f64> {
    let mut by_sec: BTreeMap<i64, u64> = BTreeMap::new();
    for w in windows {
        *by_sec.entry(w.ts_second).or_default() += w.count;
    }
    let first = *by_sec.keys().next()?;          // None if no windows
    let last = *by_sec.keys().next_back()?;
    let lo = first + warmup_seconds as i64;
    by_sec
        .iter()
        // 경계 부분초 제외: first < ts < last. 추가로 ts >= first + warmup.
        .filter(|(&ts, _)| ts > first && ts < last && ts >= lo)
        .map(|(_, &c)| c as f64)
        .min_by(|a, b| a.partial_cmp(b).unwrap())  // u64→f64라 NaN 없음
}
```
배선(`min_window_rps` criterion Some일 때):
- `warmup = c.rps_warmup_seconds.unwrap_or(0)`.
- `match min_window_rps(windows, warmup)`:
  - `Some(actual)` → metric `"min_window_rps"`, direction `"min"`, `passed = actual >= threshold` 행 생성.
  - `None` → **행 미생성(criterion skip)** — eligible 윈도가 없어 평가 불가. **FAIL 아님**(건강한 run을 윈도 수 부족만으로 떨구지 않음).

> **윈도 정책 (N-4, MAJOR-2 반영)**: **첫·마지막 second를 항상 제외**(둘 다 보통 부분초 — run이 second 중간에 시작·종료). 그래서 `warmup=0`(closed-loop `ramp_up_seconds=0`의 자연값)에서도 첫 부분초 거짓-저RPS가 안 샌다. `warmup`은 그 위에 추가로 앞 N초를 더 제외(ramp 구간). eligible 0개(예: 윈도 < 3초, 또는 warmup ≥ run 길이) → criterion skip. 평가 가능한 정상상태 second가 1개라도 있으면 그 최소를 본다. 컨트롤러는 ramp 곡선을 해석하지 않는다.

> **skip이 verdict를 비우면 verdict=None (N-3 보존)**: `min_window_rps`가 유일한 활성 기준인데 skip되면 결과 행이 0개가 된다. `evaluate_criteria` 결과의 `criteria`가 비면 `build_report`는 `verdict=Some(빈 PASS)`가 아니라 **`None`** 으로 둔다(§6) — A4a의 "빈 PASS 금지"(N-3) 유지.

### 5.3 출력 순서 (고정 — 결정적 테스트)

`p50_ms, p95_ms, p99_ms, error_rate, 4xx_rate, 5xx_rate, 4xx_count, 5xx_count, rps, min_window_rps`. 활성(Some) 기준만 행 생성. `Verdict.passed = 모든 행 AND`. (UI는 자유 재정렬 가능하나 백엔드는 이 순서로 emit.)

## 6. 리포트 배선 (B2, on-demand)

`build_report`의 verdict 계산(`report.rs:372-375`)만 인자 추가 — `status_dist`·`windows` 모두 그 시점 scope에 있다(각각 `:380`/`:379`의 `derive_insights` 호출에서 이미 borrow, ReportJson move 전):

```rust
let verdict = match (run.status, run.profile.criteria.as_ref()) {
    (RunStatus::Completed, Some(c)) if c.has_any() => {
        let v = evaluate_criteria(c, &summary, &status_dist, &windows);
        // 모든 활성 기준이 skip(per-window 데이터 부족)되면 빈 PASS 대신 None (N-3).
        if v.criteria.is_empty() { None } else { Some(v) }
    }
    _ => None,
};
```
`ReportJson.verdict` 필드·`GET /api/runs/{id}/report` 핸들러·`build_report` 시그니처 **무변경**. (A4a는 활성 기준이 항상 행을 만들어 empty가 불가능했으나, B6의 per-window skip이 empty 경로를 열어 `is_empty()` 가드 추가.)

## 7. 검증 (`validate_criteria` 헬퍼)

`crates/controller/src/api/runs.rs`의 **`validate_criteria()` 헬퍼**(`:43-55`, `validate_run_config`가 `:167-168`에서 호출 — runs 생성 + preset 저장 공유). 신규 필드 검증을 이 헬퍼에 추가. 위반 = `ApiError::BadRequest`(400), A4a와 일관:
- `max_4xx_rate`/`max_5xx_rate` Some이면 `0.0..=1.0` + 유한(NaN/inf 거부) — `max_error_rate` 검증 패턴 복제.
- `min_window_rps` Some이면 `>= 0.0` + 유한 — `min_rps` 패턴 복제.
- `max_4xx_count`/`max_5xx_count`(u64)·`rps_warmup_seconds`(u32)는 타입이 음수·비유한을 막으므로 추가 검증 불필요.

## 8. UI

### 8.1 와이어 스키마 — `ui/src/api/schemas.ts`

- **`CriteriaSchema`(`:37`)에 6필드 추가**(`ProfileSchema.criteria`가 이걸 `.nullish()`로 품음 `:67` — 입력·prefill·preset 경로 자동 통과):
  ```ts
  max_4xx_rate: z.number().min(0).max(1).optional(),
  max_5xx_rate: z.number().min(0).max(1).optional(),
  max_4xx_count: z.number().int().nonnegative().optional(),
  max_5xx_count: z.number().int().nonnegative().optional(),
  min_window_rps: z.number().nonnegative().optional(),
  rps_warmup_seconds: z.number().int().nonnegative().optional(),
  ```
- **`CriterionResultSchema`(`:212`)·`VerdictSchema`(`:219`)는 무변경** — `metric: z.string()`이라 신규 metric 행이 자동 통과. (출력 스키마 변경 0 = A4a §10 일반형 출력의 배당금.)

### 8.2 입력 — `ui/src/components/RunDialog.tsx`

SLO 기준 섹션(접이식 `sloOpen`)에 입력 추가. A4a가 `buildCriteria()`(`:269-277`)를 `buildProfile()`(`:279-287`) 안에 중앙화해 submit(`:670`)·preset(`currentInput`→`:292`)이 한 경로를 공유 — **A4a SF-3(2-site)는 이미 해소**, `buildCriteria()` 한 곳만 편집.
- **신규 state**(`:97-103` 옆): `max4xxPct`/`max5xxPct`(% string), `max4xxCount`/`max5xxCount`, `minWindowRps`, `rpsWarmup`. error_rate처럼 rate는 % 입출력.
- **`buildCriteria()`**: rate는 `Number(pct)/100`, 나머지는 `Number(...)`(빈칸=미설정). (`maxErrPct` 변환 패턴 복제.)
- **`criteriaHasValue()`(`:47-54`)**: 6필드 추가 → seed된 신규 criteria가 SLO 섹션 자동 펼침(`useState(()=>criteriaHasValue(initC))`).
- **preset-load 경로(`loadPreset()`, `:140-200`)에 신규 state setter 추가**(기존 `setMaxErrPct` 옆). **`useEffect` reset이 아니다** — 이 repo 불변식 "RunDialog prefill = reseed-by-key, **reseed effect 없음**"(ui/CLAUDE.md). prefill(초기값)은 `useState(initC?.… )`로, preset 명시 로드는 `loadPreset` imperative 경로로 — 새 `useEffect`를 추가하지 말 것.
- **warmup prefill (closed-loop만)**: `min_window_rps` 활성화 시 `rpsWarmup`을 폼 `rampUp`(`:92`)으로 prefill — **단 closed-loop일 때만**. open-loop(stages)은 `rampUp=0`이라 0을 적극 주입하면 ramp 구간이 평가에 포함돼 거의 항상 FAIL(spec-review MINOR) → **open-loop이면 prefill 생략(빈칸) + "오픈루프는 ramp 길이를 warmup으로 설정" 힌트**. 컨트롤러/UI 곡선 해석 없음(§3).
- **검증**: rate %는 0–100, `min_window_rps ≥ 0`. 범위밖이면 입력 비활성/배너(기존 SLO 입력 UX 재사용) — 최종 권위는 백엔드 `validate_criteria`.

### 8.3 출력 — `ui/src/components/report/VerdictPanel.tsx`

행 렌더는 이미 일반(`verdict.criteria` 순회)이나 **VerdictPanel은 무변경이 아니다** — `METRIC_LABEL`(`:3-9`)과 `fmt()`(`:11-15`) 둘 다 확장한다. 현재 `fmt()`는 `error_rate`/`rps`만 특수 처리하고 **나머지 전부 `${v} ms`**(`:14`) → 신규 metric을 분기 안 넣으면 count/rps에 잘못된 `" ms"`가 붙는다(spec-review MINOR).
- **`METRIC_LABEL` 추가**: `4xx_rate`→"4xx 비율", `5xx_rate`→"5xx 비율", `4xx_count`→"4xx 수", `5xx_count`→"5xx 수", `min_window_rps`→"최소 구간 RPS".
- **`fmt()` 분기 추가**: `*_rate`→`%`(×100), `*_count`→정수(`" ms"` 금지), `min_window_rps`→1자리 소수(`rps`와 동형).
- direction `"max"`→`≤`, `"min"`→`≥`(기존 매핑 재사용).
- 미지의 metric은 raw 문자열 라벨 fallback(`?? r.metric`, `:43`) 유지(전방호환).

## 9. A4a 한계와의 관계

- A4a §9: `error_rate` = 엔진 실패(transport + status assertion 불일치 + extract 실패) 비율. status assertion 없으면 생 4xx/5xx를 못 잡음. **이 슬라이스의 `5xx_rate`/`5xx_count`가 정확히 그 갭을 푼다** — status assertion 없이도 응답 코드 기반 게이트.
- `min_window_rps`는 A4a `min_rps`(평균)와 별개 metric으로 공존 — 평균은 정상이나 mid-run 몇 초 dip은 per-window가 잡는다.

## 10. 테스트 계획

- **엔진/워커/proto/migration**: 변경 없음(테스트 없음).
- **controller unit**(`report.rs` `#[cfg(test)]`):
  - `status_class_count`/`http_response_total`: `"404"/"403"`→4xx 합, `"500"`→5xx; `http_response_total`은 `"0"`(transport) 제외·`"2"/"3"/"4"/"5"` 포함. **insights 패리티**: 같은 `status_distribution`으로 `derive_insights`의 status_class `pct`와 `evaluate_criteria`의 `*_rate` actual이 **동일**(divergence 방지 회귀).
  - status-class rate: `http_response_total==0`→0.0; 경계(`class/total == threshold` → pass). count: `max_5xx_count:0` 기준 1건이라도 있으면 fail.
  - `min_window_rps` 헬퍼: 다초 윈도 최소 정확; **첫·마지막 second 제외**(부분초); warmup이 앞 N초 추가 제외; **eligible 0개(윈도 < 3초 또는 warmup 과대)→`None`(skip, FAIL 아님)**; 멀티-step 윈도 합산(같은 ts_second 여러 step → 합); warmup=0에서 첫 부분초가 결과에 안 섞임.
  - `evaluate_criteria`: 신규 4+1 metric 활성/일부 fail; 고정 출력 순서(§5.3); 기존 A4a 행과 공존; **per-window skip 시 그 행 미생성**(행 수 검증).
  - `has_any`: 신규 기준만 Some→true; `rps_warmup_seconds`만 Some→**false**(N-3).
  - `build_report`: completed+신규 criteria→`Some(verdict)` 신규 행 포함; **`min_window_rps`만 설정 + 짧은 run(skip)→`verdict=None`**(빈 PASS 아님, N-3).
  - `validate_criteria`: rate 범위밖/NaN, `min_window_rps` 음수/NaN 거부; 정상 통과.
- **UI(vitest/RTL)**:
  - RunDialog: 신규 입력→`POST` 본문 criteria 포함; rate %↔분수; warmup prefill(`rampUp` 반영); preset prefill round-trip. **SLO 섹션 접힘이라 입력 만지는 테스트는 먼저 펼침**(ui/CLAUDE.md A4a follow-up 함정).
  - VerdictPanel: 신규 metric 행 라벨·단위·`≤`/`≥` 렌더.
  - schemas: criteria 6필드 round-trip; verdict 신규 metric 행 파싱.
- **게이트**: `cargo build/clippy/test --workspace`(pre-commit) + `cd ui && pnpm lint && pnpm test && pnpm build`(수동). **라이브 run 1회**(머지 전): 시나리오에 5xx 유도 stub + ramp 있는 run → `/report.verdict`에 신규 행 + per-window 평가 확인(S-D 갭: 응답-파싱 경로는 RTL absent-fixture로 안 잡힘).

## 11. 영향 받는 파일(예상)

### 프로덕션
- `crates/controller/src/store/runs.rs` — `Criteria` 6필드 + `has_any` 갱신.
- `crates/controller/src/report.rs` — `evaluate_criteria` 시그니처+arm, `status_class_count`/`http_response_total`/`min_window_rps` 헬퍼(pub(crate)), `build_report:372` 배선(skip→empty→None 가드).
- `crates/controller/src/insights.rs` — `status_class`의 인라인 `total_http`/`class_count`를 `report.rs` 공유 헬퍼 호출로 교체(MAJOR-1 패리티 — 순수 리팩터, 출력 동일).
- `crates/controller/src/api/runs.rs` — `validate_criteria()` 헬퍼에 신규 검증.
- `ui/src/api/schemas.ts` — `CriteriaSchema` 6필드.
- `ui/src/components/RunDialog.tsx` — 입력 6종 + state + `buildCriteria`/`criteriaHasValue`/`loadPreset` 동기화/closed-loop warmup prefill(useEffect 추가 금지).
- `ui/src/components/report/VerdictPanel.tsx` — `METRIC_LABEL` + `fmt()` 분기 추가(count에 `" ms"` 금지).

### 시그니처 변경으로 갱신 필요한 호출처 (컴파일 캐스케이드, N-5)
`evaluate_criteria`에 인자 2개가 늘어 기존 호출처가 전부 컴파일 에러:
- `report.rs:373` — `build_report` 배선 사이트(§6, `&status_dist, &windows` 추가).
- `report.rs`의 `evaluate_criteria` 단위테스트 호출 4곳(`:704/:715/:729/:739` 부근) — status-class/per-window 기준이 없는 테스트는 `&BTreeMap::new(), &[]` 전달(신규 행 0).

### 무변경
마이그레이션 · proto · 엔진 · 워커 · `ReportJson`/`Verdict`/`CriterionResult` 구조 · `ui/src/api/runPrefill.ts` · `VerdictSchema`/`CriterionResultSchema`.

## 12. ADR

신규 ADR 불필요 — **ADR-0028(A4a) 갱신**: 같은 결정 계열(run-level SLO criteria)의 입력 확장이며, 핵심 결정(profile_json 스냅샷, completed-only on-demand verdict, 고정 per-metric 모델, 일반형 출력)은 불변. 갱신 내용: status-class(rate+count, **rate 분모=HTTP 응답 수 `total_http`, transport `"0"` 제외 — insights와 공유 헬퍼**) + per-window 최소 RPS(**경계 부분초 제외 + warmup trim, eligible 부족 시 criterion skip**) criterion 추가. CLAUDE.md "알아둘 결정들" ADR-0028 줄에 1구 추가.

## 13. 리뷰 반영 (2026-06-06 spec-plan-reviewer)

`spec-plan-reviewer`가 모든 인용 라인을 CONFIRMED(정확)했고, 아래 findings를 반영:
- **MAJOR-1 (rate 분모 불일치)**: `4xx_rate`/`5xx_rate` 분모를 `summary.count`→**`total_http`(insights와 동일)** 로 변경 + 두 모듈이 쓰는 **공유 순수 헬퍼**로 단일화(§2 노트/§3/§5.1/§11). 한 리포트 InsightPanel·VerdictPanel "4xx 비율" 두 숫자 모순 제거.
- **MAJOR-2 (per-window 거짓 FAIL)**: 윈도 정책을 **첫·마지막 second 항상 제외**로 바꿔 warmup=0 부분초 거짓-저RPS 차단, eligible 0개는 **actual=0 FAIL→criterion skip**으로 변경(짧은 run·과대 warmup이 건강한 run을 안 떨굼), 전부 skip 시 **verdict=None**(N-3 보존)(§3/§5.2/§6/§10).
- **MINOR (open-loop warmup)**: open-loop은 warmup 0-prefill 생략 + 힌트(§8.2).
- **MINOR (라벨 정정)**: §7 "`validate_run_config`"→**`validate_criteria()` 헬퍼**; §8.2 "reset effect `:161-167`"→**`loadPreset()` 경로(useEffect 아님)** + 추가 금지 명시.
- **MINOR (VerdictPanel)**: "패널 무변경" 오독 방지 — `fmt()`가 `${v} ms` fallback이라 count/rate **분기 추가 필수**임을 §8.3에 명시(VerdictPanel은 변경 대상).

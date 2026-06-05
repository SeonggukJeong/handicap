# B6 status-class + per-window RPS criteria Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 종료된 run의 SLO verdict에 status-class(4xx/5xx의 rate+count)와 per-window 최소 RPS criterion을 추가한다.

**Architecture:** A4a(ADR-0028)의 fixed-field `Criteria` + 일반형 `Verdict` 출력을 그대로 확장한다. controller `report.rs`에 순수 헬퍼 3종(`status_class_count`/`http_response_total`/`min_window_rps`)을 두고 `evaluate_criteria` 시그니처를 `(&Criteria, &ReportSummary, &BTreeMap, &[ReportWindow])`로 넓힌다. `insights.rs`의 분모 정의를 같은 헬퍼로 통일(divergence 방지). UI는 `CriteriaSchema` 6필드 + RunDialog 입력 + VerdictPanel 라벨/포맷만. **엔진·워커·proto·마이그레이션 무변경, 출력 스키마(`Verdict`/`CriterionResult`) 무변경.**

**Tech Stack:** Rust(controller, serde, BTreeMap), TypeScript/React(Zod, vitest/RTL).

**Spec:** `docs/superpowers/specs/2026-06-06-b6-status-class-window-rps-criteria-design.md`.

**커밋 규율(루트 CLAUDE.md):** pre-commit이 비-`.md`마다 전체 `cargo build/clippy/test --workspace`를 돌린다 — **RED-only 커밋·미사용 헬퍼 단독 커밋은 게이트에 막힌다. 각 Task는 로컬에서 RED→GREEN 확인 후 단일 green 커밋**으로 fold. `git commit`은 `run_in_background:false` + 파이프 없이, 직후 `git log -1 --oneline`로 확인. cold-build flake(e2e 워커 race)나면 `cargo build -p handicap-worker && cargo build --workspace` 후 warm 재시도. **UI Task는 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build` 수동 실행**(cargo 훅은 UI를 안 본다).

**머지 순서 주의:** parallel-node worktree도 `insights.rs`를 건드린다(`collect_unconditional`에 `Parallel` arm 추가). B6의 `insights.rs` 변경은 `status_class`의 분모 계산부(다른 함수)라 충돌 위험 낮음. B6는 **격리된 worktree**(`superpowers:using-git-worktrees`)에서 진행하고, 머지 시 `insights.rs` 충돌이 나면 두 변경(arm 추가 + 헬퍼 호출)을 둘 다 보존.

---

## File Structure

**Backend (controller):**
- `crates/controller/src/store/runs.rs` — `Criteria` 6필드 + `has_any` 갱신 (Task 1).
- `crates/controller/src/report.rs` — 순수 헬퍼 3종 + `evaluate_criteria` 확장 + `build_report` 배선 (Task 2).
- `crates/controller/src/insights.rs` — `status_class`를 공유 헬퍼로 dedup (Task 3).
- `crates/controller/src/api/runs.rs` — `validate_criteria` 신규 검증 (Task 4).

**UI:**
- `ui/src/api/schemas.ts` — `CriteriaSchema` 6필드 (Task 5).
- `ui/src/components/RunDialog.tsx` — 입력 6종 + state + buildCriteria/criteriaHasValue/loadPreset/warmup prefill (Task 6).
- `ui/src/components/report/VerdictPanel.tsx` — `METRIC_LABEL` + `fmt()` 분기 (Task 7).

각 파일은 기존 inline `#[cfg(test)]`(Rust) / `*.test.tsx`(UI)에 테스트를 추가하므로 tdd-guard는 자동 통과(테스트를 먼저 작성).

---

## Task 1: `Criteria` 6필드 + `has_any` (store/runs.rs)

**Files:**
- Modify: `crates/controller/src/store/runs.rs:48-73` (`Criteria` 구조체 + `has_any`)
- Test: `crates/controller/src/store/runs.rs`의 기존 `#[cfg(test)] mod tests`

- [ ] **Step 1: 실패 테스트 작성** (`runs.rs`의 `mod tests` 끝에 추가)

```rust
    #[test]
    fn has_any_reflects_new_status_and_window_fields() {
        // 신규 status-class / per-window 기준이 has_any를 켠다.
        assert!(Criteria { max_5xx_rate: Some(0.01), ..Default::default() }.has_any());
        assert!(Criteria { max_4xx_count: Some(0), ..Default::default() }.has_any());
        assert!(Criteria { min_window_rps: Some(1.0), ..Default::default() }.has_any());
        // rps_warmup_seconds는 수식자 — 그것만으론 verdict를 만들지 않는다(N-3).
        assert!(!Criteria { rps_warmup_seconds: Some(5), ..Default::default() }.has_any());
        assert!(!Criteria::default().has_any());
    }

    #[test]
    fn criteria_new_fields_serde_round_trip() {
        let c = Criteria {
            max_4xx_rate: Some(0.1),
            max_5xx_rate: Some(0.0),
            max_4xx_count: Some(3),
            max_5xx_count: Some(0),
            min_window_rps: Some(50.0),
            rps_warmup_seconds: Some(5),
            ..Default::default()
        };
        let j = serde_json::to_string(&c).unwrap();
        let back: Criteria = serde_json::from_str(&j).unwrap();
        assert_eq!(c, back);
        // None 필드는 직렬화에서 생략(skip_serializing_if).
        let empty = serde_json::to_string(&Criteria::default()).unwrap();
        assert_eq!(empty, "{}");
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cargo test -p handicap-controller --lib store::runs`
Expected: FAIL — `max_5xx_rate` 등 필드 미정의(컴파일 에러).

- [ ] **Step 3: 필드 추가** (`runs.rs`의 `Criteria` 구조체, `min_rps` 필드 `:61` 다음 줄에 추가)

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_4xx_rate: Option<f64>, // 분수 0.0..=1.0 (UI %), 분모=HTTP 응답 수
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_5xx_rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_4xx_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_5xx_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_window_rps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rps_warmup_seconds: Option<u32>, // min_window_rps 수식자 — None = 0. has_any에 미포함.
```

- [ ] **Step 4: `has_any` 갱신** (`runs.rs:66-72`의 `has_any` body를 교체)

```rust
    pub fn has_any(&self) -> bool {
        self.max_p50_ms.is_some()
            || self.max_p95_ms.is_some()
            || self.max_p99_ms.is_some()
            || self.max_error_rate.is_some()
            || self.min_rps.is_some()
            || self.max_4xx_rate.is_some()
            || self.max_5xx_rate.is_some()
            || self.max_4xx_count.is_some()
            || self.max_5xx_count.is_some()
            || self.min_window_rps.is_some()
        // 주의: rps_warmup_seconds는 의도적으로 제외(수식자, spec §4 N-3).
    }
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cargo test -p handicap-controller --lib store::runs`
Expected: PASS (신규 2개 + 기존 전부).

- [ ] **Step 6: 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace   # warm (cold-build flake 회피)
git add crates/controller/src/store/runs.rs
git commit -m "feat(controller): Criteria에 status-class + per-window RPS 필드 6종

max_4xx/5xx_rate(분수) + max_4xx/5xx_count(u64) + min_window_rps + 수식자
rps_warmup_seconds. has_any는 신규 기준 5개 포함, rps_warmup_seconds 제외(수식자).
profile_json serde default라 마이그레이션 0. ADR-0028 확장(B6).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 2: 헬퍼 3종 + `evaluate_criteria` 확장 + `build_report` 배선 (report.rs)

> **단일 커밋 필수**: `evaluate_criteria` 시그니처에 인자 2개를 더하면 호출처(빌드 사이트 1 + 단위테스트 4)가 전부 컴파일 에러다. 헬퍼·평가·배선·호출처 수정을 **한 green 커밋**으로 fold.

**Files:**
- Modify: `crates/controller/src/report.rs` — 헬퍼(`evaluate_criteria` 앞 `:129`), `evaluate_criteria`(`:131-178`), `build_report` verdict 배선(`:372-375`), 테스트 호출처(`:704/:715/:729/:739`)
- Test: `report.rs`의 기존 `#[cfg(test)] mod tests`

- [ ] **Step 1: 실패 테스트 작성** (`report.rs`의 `mod tests`에 추가 — `summary`/`run_row` 헬퍼는 기존, `win` 헬퍼는 신규)

```rust
    // ReportWindow 빌더(per-window RPS 테스트용). 이름은 `rwin` — 기존 `win`(report.rs:455)은
    // 6-인자 `WindowWithHdr` 빌더라 같은 이름이면 E0428(중복 정의). 절대 `win`으로 쓰지 말 것.
    fn rwin(ts: i64, count: u64) -> ReportWindow {
        ReportWindow {
            ts_second: ts,
            step_id: "s".to_string(),
            count,
            error_count: 0,
            status_counts: BTreeMap::new(),
            p50_ms: 0,
            p95_ms: 0,
            p99_ms: 0,
        }
    }
    fn dist(pairs: &[(&str, u64)]) -> BTreeMap<String, u64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn http_response_total_excludes_transport_zero() {
        let d = dist(&[("0", 5), ("200", 10), ("301", 2), ("404", 3), ("500", 1)]);
        assert_eq!(http_response_total(&d), 16); // 10+2+3+1, "0" 제외
        assert_eq!(status_class_count(&d, '4'), 3);
        assert_eq!(status_class_count(&d, '5'), 1);
    }

    #[test]
    fn status_class_rate_uses_http_total_denominator() {
        // 5xx rate = 10 / (90+10) = 0.1 > 0.05 → fail
        let c = Criteria { max_5xx_rate: Some(0.05), ..Default::default() };
        let d = dist(&[("200", 90), ("500", 10)]);
        let v = evaluate_criteria(&c, &summary(100, 0, 100.0, 5, 5), &d, &[]);
        assert_eq!(v.criteria[0].metric, "5xx_rate");
        assert!((v.criteria[0].actual - 0.1).abs() < 1e-9);
        assert!(!v.criteria[0].passed);
    }

    #[test]
    fn status_class_rate_zero_http_is_zero() {
        // transport 실패만 → http_total 0 → rate 0.0 → max_5xx_rate:0.0 통과
        let c = Criteria { max_5xx_rate: Some(0.0), ..Default::default() };
        let d = dist(&[("0", 5)]);
        let v = evaluate_criteria(&c, &summary(5, 5, 5.0, 0, 0), &d, &[]);
        assert!(v.criteria[0].passed);
        assert_eq!(v.criteria[0].actual, 0.0);
    }

    #[test]
    fn status_class_count_strict_zero_fails_on_any() {
        let c = Criteria { max_5xx_count: Some(0), ..Default::default() };
        let d = dist(&[("200", 10), ("500", 1)]);
        let v = evaluate_criteria(&c, &summary(11, 1, 11.0, 5, 5), &d, &[]);
        assert_eq!(v.criteria[0].metric, "5xx_count");
        assert_eq!(v.criteria[0].actual, 1.0);
        assert!(!v.criteria[0].passed);
    }

    #[test]
    fn min_window_rps_excludes_boundaries_and_sums_steps() {
        // 경계초(0,3=999) 제외, sec1의 두 step(40+60=100), sec2=200 → min 100.
        let w = vec![rwin(0, 999), rwin(1, 40), rwin(1, 60), rwin(2, 200), rwin(3, 999)];
        assert_eq!(super::min_window_rps(&w, 0), Some(100.0));
    }

    #[test]
    fn min_window_rps_warmup_skips_leading_seconds() {
        // secs 0..5(각 100,10,20,30,40,100). 경계 0,5 제외. warmup 2 → ts>=2 → {2,3,4}=20,30,40 → 20.
        let w = vec![rwin(0, 100), rwin(1, 10), rwin(2, 20), rwin(3, 30), rwin(4, 40), rwin(5, 100)];
        assert_eq!(super::min_window_rps(&w, 0), Some(10.0)); // {1,2,3,4}
        assert_eq!(super::min_window_rps(&w, 2), Some(20.0)); // {2,3,4}
    }

    #[test]
    fn min_window_rps_insufficient_windows_is_none() {
        assert_eq!(super::min_window_rps(&[], 0), None);
        assert_eq!(super::min_window_rps(&[rwin(5, 100)], 0), None); // 1초
        assert_eq!(super::min_window_rps(&[rwin(0, 100), rwin(1, 50)], 0), None); // 2초(경계만)
    }

    #[test]
    fn min_window_rps_criterion_skipped_when_insufficient() {
        // min_window_rps만 설정 + 윈도 부족 → 행 미생성(skip), FAIL 아님.
        let c = Criteria { min_window_rps: Some(1.0), ..Default::default() };
        let v = evaluate_criteria(&c, &summary(0, 0, 0.0, 0, 0), &BTreeMap::new(), &[]);
        assert!(v.criteria.is_empty());
    }

    #[test]
    fn evaluate_criteria_output_order_is_fixed() {
        let c = Criteria {
            max_p50_ms: Some(1000),
            max_error_rate: Some(1.0),
            max_4xx_rate: Some(1.0),
            max_5xx_rate: Some(1.0),
            max_4xx_count: Some(999),
            max_5xx_count: Some(999),
            min_rps: Some(0.0),
            min_window_rps: Some(0.0),
            ..Default::default()
        };
        let d = dist(&[("200", 30)]);
        let w = vec![rwin(0, 10), rwin(1, 20), rwin(2, 30)]; // eligible {1}=20 → min_window_rps 행 생성
        let v = evaluate_criteria(&c, &summary(30, 0, 30.0, 1, 1), &d, &w);
        let metrics: Vec<&str> = v.criteria.iter().map(|r| r.metric.as_str()).collect();
        assert_eq!(
            metrics,
            vec![
                "p50_ms", "error_rate", "4xx_rate", "5xx_rate", "4xx_count", "5xx_count",
                "rps", "min_window_rps"
            ]
        );
    }

    #[test]
    fn build_report_verdict_none_when_only_window_rps_and_short_run() {
        let mut run = run_row(); // Completed
        run.profile.criteria = Some(Criteria { min_window_rps: Some(1.0), ..Default::default() });
        // 빈 rows → 윈도 0개 → min_window_rps skip → criteria 빈 → verdict None(N-3).
        assert!(build_report(&run, "", &[], &[], &[]).verdict.is_none());
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cargo test -p handicap-controller --lib report`
Expected: FAIL — `http_response_total`/`status_class_count`/`min_window_rps` 미정의 + `evaluate_criteria` 인자 수 불일치(컴파일 에러).

- [ ] **Step 3: 헬퍼 3종 추가** (`report.rs`의 `evaluate_criteria` **앞**, `CriterionResult` 정의 `:128` 다음에 삽입)

```rust
/// 특정 클래스(prefix '4'/'5')의 응답 수.
pub(crate) fn status_class_count(status_dist: &BTreeMap<String, u64>, first: char) -> u64 {
    status_dist
        .iter()
        .filter(|(k, _)| k.starts_with(first))
        .map(|(_, v)| *v)
        .sum()
}

/// HTTP 응답 총수(키 첫 글자 '1'..='5'; transport 실패 "0" 제외).
/// insights status_class와 동일 분모 — Task 3에서 insights가 이 함수를 재사용한다.
pub(crate) fn http_response_total(status_dist: &BTreeMap<String, u64>) -> u64 {
    status_dist
        .iter()
        .filter(|(k, _)| matches!(k.chars().next(), Some('1'..='5')))
        .map(|(_, v)| *v)
        .sum()
}

/// per-second 총 RPS(그 ts_second의 모든 step count 합)의 정상상태 최소값.
/// 첫·마지막 second(경계 부분초)를 항상 제외하고, 추가로 앞 `warmup`초를 제외한다.
/// eligible 윈도가 없으면(짧은 run·과대 warmup) None → criterion skip(평가 불가).
fn min_window_rps(windows: &[ReportWindow], warmup_seconds: u32) -> Option<f64> {
    let mut by_sec: BTreeMap<i64, u64> = BTreeMap::new();
    for w in windows {
        *by_sec.entry(w.ts_second).or_default() += w.count;
    }
    let first = *by_sec.keys().next()?;
    let last = *by_sec.keys().next_back()?;
    let lo = first + warmup_seconds as i64;
    by_sec
        .iter()
        .filter(|(&ts, _)| ts > first && ts < last && ts >= lo)
        .map(|(_, &c)| c as f64)
        .min_by(|a, b| a.partial_cmp(b).unwrap())
}
```

- [ ] **Step 4: `evaluate_criteria` 시그니처 + arm 확장** (`report.rs:131`)

시그니처를 교체:
```rust
pub fn evaluate_criteria(
    c: &crate::store::runs::Criteria,
    s: &ReportSummary,
    status_dist: &BTreeMap<String, u64>,
    windows: &[ReportWindow],
) -> Verdict {
```

`if let Some(t) = c.max_error_rate { ... }` 블록(`:152-165`)과 `if let Some(t) = c.min_rps { ... }` 블록(`:166-174`) **사이**에 status-class를 삽입:
> **출력 순서 주의(spec §5.3 + order 테스트)**: 결과 행은 **rate 먼저(4xx_rate, 5xx_rate), 그 다음 count(4xx_count, 5xx_count)** 순서여야 한다 — 그래서 **두 패스**로 push한다(한 루프에서 클래스별 rate+count를 같이 push하면 `4xx_rate, 4xx_count, 5xx_rate, 5xx_count`가 나와 order 테스트가 깨진다).

```rust
    // status-class rate(분모=HTTP 응답 수, transport "0" 제외) — 4xx, 5xx 순.
    let http_total = http_response_total(status_dist);
    for (first, rate_t, metric) in [
        ('4', c.max_4xx_rate, "4xx_rate"),
        ('5', c.max_5xx_rate, "5xx_rate"),
    ] {
        if let Some(t) = rate_t {
            let class = status_class_count(status_dist, first);
            let actual = if http_total == 0 {
                0.0
            } else {
                class as f64 / http_total as f64
            };
            criteria.push(CriterionResult {
                metric: metric.to_string(),
                direction: "max".to_string(),
                threshold: t,
                actual,
                passed: actual <= t,
            });
        }
    }
    // status-class count — 4xx, 5xx 순.
    for (first, count_t, metric) in [
        ('4', c.max_4xx_count, "4xx_count"),
        ('5', c.max_5xx_count, "5xx_count"),
    ] {
        if let Some(t) = count_t {
            let (threshold, actual) = (t as f64, status_class_count(status_dist, first) as f64);
            criteria.push(CriterionResult {
                metric: metric.to_string(),
                direction: "max".to_string(),
                threshold,
                actual,
                passed: actual <= threshold,
            });
        }
    }
```

`if let Some(t) = c.min_rps { ... }` 블록(`:166-174`) **다음**, `let passed = ...`(`:176`) **앞**에 per-window를 삽입:
```rust
    // per-window 최소 RPS: 정상상태 윈도의 최소 RPS ≥ threshold. eligible 부족이면 skip(행 미생성).
    if let Some(t) = c.min_window_rps {
        let warmup = c.rps_warmup_seconds.unwrap_or(0);
        if let Some(actual) = min_window_rps(windows, warmup) {
            criteria.push(CriterionResult {
                metric: "min_window_rps".to_string(),
                direction: "min".to_string(),
                threshold: t,
                actual,
                passed: actual >= t,
            });
        }
    }
```

- [ ] **Step 5: `build_report` verdict 배선** (`report.rs:372-375` 교체)

```rust
    // completed + 활성 criteria일 때만 verdict (spec §6). RunStatus는 Copy.
    let verdict = match (run.status, run.profile.criteria.as_ref()) {
        (RunStatus::Completed, Some(c)) if c.has_any() => {
            let v = evaluate_criteria(c, &summary, &status_dist, &windows);
            // 모든 활성 기준이 skip(per-window 데이터 부족)되면 빈 PASS 대신 None(N-3).
            if v.criteria.is_empty() { None } else { Some(v) }
        }
        _ => None,
    };
```

- [ ] **Step 6: 기존 테스트 호출처 4곳 갱신** (`report.rs`의 `evaluate_*` 테스트)

`evaluate_criteria(&c, &summary(...))` 호출 4곳(`:704/:715/:729/:739`)에 빈 status_dist·windows를 추가:
- `:704` → `evaluate_criteria(&c, &summary(1000, 10, 200.0, 300, 400), &BTreeMap::new(), &[])`
- `:715` → `evaluate_criteria(&c, &summary(100, 0, 50.0, 300, 400), &BTreeMap::new(), &[])`
- `:729` → `evaluate_criteria(&c, &summary(0, 0, 0.0, 0, 0), &BTreeMap::new(), &[])`
- `:739` → `evaluate_criteria(&c, &summary(0, 0, 0.0, 0, 0), &BTreeMap::new(), &[])`

(`BTreeMap`은 `mod tests`의 `use super::*`로 이미 in-scope — `report.rs:9`에서 import.)

- [ ] **Step 7: 테스트 통과 확인 (전체 controller)**

Run: `cargo test -p handicap-controller --lib report`
Expected: PASS (신규 10개 + 기존 evaluate/build_report 테스트 전부).
그 다음 Run: `cargo clippy -p handicap-controller --all-targets -- -D warnings`
Expected: 경고 0 (신규 헬퍼는 evaluate_criteria가 사용 → dead_code 없음).

- [ ] **Step 8: 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace
git add crates/controller/src/report.rs
git commit -m "feat(controller): evaluate_criteria에 status-class + per-window RPS arm

순수 헬퍼 status_class_count/http_response_total(insights와 공유 예정)/min_window_rps
추가. status-class rate 분모=HTTP 응답 수(transport \"0\" 제외), per-window는 경계
부분초 제외 + warmup trim + eligible 부족 시 criterion skip(거짓 FAIL 방지). build_report
는 전 기준 skip 시 verdict None(N-3). 출력 순서 고정. 시그니처 인자 2개 추가로 호출처
4곳 갱신. ADR-0028 확장(B6).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 3: insights `status_class` dedup → 공유 헬퍼 (insights.rs)

> MAJOR-1 패리티: InsightPanel·VerdictPanel "4xx 비율"이 갈라지지 않게 같은 헬퍼로 단일화. 순수 리팩터(출력 동일).

**Files:**
- Modify: `crates/controller/src/insights.rs:121-132` (`status_class`의 인라인 `total_http`/`class_count`)
- Test: `report.rs` 또는 `insights.rs`의 `mod tests` (패리티 회귀)

- [ ] **Step 1: 패리티 테스트 작성** (`report.rs`의 `mod tests`에 추가 — 두 모듈이 같은 분모를 쓰는지 락인)

```rust
    #[test]
    fn evaluate_5xx_rate_matches_insights_status_class_pct() {
        // 같은 status_distribution에서 evaluate_criteria의 5xx_rate actual과
        // insights status_class의 pct(5xx)가 동일해야 한다(공유 헬퍼).
        let d = dist(&[("0", 7), ("200", 80), ("404", 5), ("500", 15)]);
        let c = Criteria { max_5xx_rate: Some(1.0), ..Default::default() };
        let v = evaluate_criteria(&c, &summary(107, 22, 107.0, 5, 5), &d, &[]);
        let rate = v.criteria.iter().find(|r| r.metric == "5xx_rate").unwrap().actual;

        // insights status_class 분모/분자와 동일: 15 / (80+5+15) = 15/100
        let total = http_response_total(&d);
        let cls = status_class_count(&d, '5');
        assert_eq!(total, 100);
        assert!((rate - cls as f64 / total as f64).abs() < 1e-9);
    }
```

- [ ] **Step 2: 테스트 통과 확인 (현재도 PASS여야 함 — 분모 정의가 이미 동일)**

Run: `cargo test -p handicap-controller --lib report::tests::evaluate_5xx_rate_matches_insights`
Expected: PASS (Task 2가 이미 같은 정의를 씀 — 이 테스트는 회귀 가드).

- [ ] **Step 3: insights.rs를 공유 헬퍼로 교체** (`insights.rs:121-132`)

현재:
```rust
    let total_http: u64 = status_distribution
        .iter()
        .filter(|(k, _)| matches!(k.chars().next(), Some('1'..='5')))
        .map(|(_, v)| *v)
        .sum();
    if total_http > 0 {
        for (class, first, sev) in [("4xx", '4', "warning"), ("5xx", '5', "critical")] {
            let class_count: u64 = status_distribution
                .iter()
                .filter(|(k, _)| k.starts_with(first))
                .map(|(_, v)| *v)
                .sum();
```
교체:
```rust
    let total_http = crate::report::http_response_total(status_distribution);
    if total_http > 0 {
        for (class, first, sev) in [("4xx", '4', "warning"), ("5xx", '5', "critical")] {
            let class_count = crate::report::status_class_count(status_distribution, first);
```
(나머지 `if class_count > 0 { ... pct = class_count as f64 / total_http as f64 ... }`는 그대로.)

- [ ] **Step 4: 전체 controller 테스트 (insights 출력 무변경 확인)**

Run: `cargo test -p handicap-controller --lib insights`
Expected: PASS — 기존 `status_class` 인사이트 테스트 전부 통과(헬퍼는 동일 값을 반환).

- [ ] **Step 5: 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace
git add crates/controller/src/insights.rs crates/controller/src/report.rs
git commit -m "refactor(controller): insights status_class를 report 공유 헬퍼로 dedup

total_http/class_count 인라인 계산을 report::http_response_total/status_class_count
호출로 교체 — VerdictPanel 4xx/5xx rate와 InsightPanel status_class가 같은 분모를
쓰도록 단일 소스화(divergence 방지). 출력 무변경, 패리티 회귀 테스트 추가.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 4: `validate_criteria` 신규 검증 (api/runs.rs)

**Files:**
- Modify: `crates/controller/src/api/runs.rs:43-55` (`validate_criteria`)
- Test: `api/runs.rs`의 기존 `#[cfg(test)] mod tests` (`:693-` 의 `validate_criteria_*` 옆)

- [ ] **Step 1: 실패 테스트 작성** (`api/runs.rs`의 `mod tests`에 추가)

```rust
    #[test]
    fn validate_criteria_rejects_bad_status_rate_and_window_rps() {
        use crate::store::runs::Criteria; // 기존 validate_criteria_* 테스트와 동일(함수-로컬 use)
        // 4xx/5xx rate 범위 밖
        assert!(validate_criteria(&Criteria { max_5xx_rate: Some(1.5), ..Default::default() }).is_err());
        assert!(validate_criteria(&Criteria { max_4xx_rate: Some(-0.1), ..Default::default() }).is_err());
        assert!(validate_criteria(&Criteria { max_5xx_rate: Some(f64::NAN), ..Default::default() }).is_err());
        // min_window_rps 음수/비유한
        assert!(validate_criteria(&Criteria { min_window_rps: Some(-1.0), ..Default::default() }).is_err());
        assert!(validate_criteria(&Criteria { min_window_rps: Some(f64::INFINITY), ..Default::default() }).is_err());
        // 정상값 통과(rate 0..1, count 임의 u64, warmup 임의 u32)
        assert!(validate_criteria(&Criteria {
            max_4xx_rate: Some(0.0),
            max_5xx_rate: Some(0.05),
            max_4xx_count: Some(0),
            max_5xx_count: Some(100),
            min_window_rps: Some(50.0),
            rps_warmup_seconds: Some(5),
            ..Default::default()
        })
        .is_ok());
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cargo test -p handicap-controller --lib api::runs`
Expected: FAIL — `max_5xx_rate: Some(1.5)`가 아직 검증 안 돼 통과(`is_err()` 실패).

- [ ] **Step 3: 검증 추가** (`api/runs.rs`의 `validate_criteria`, `min_rps` 블록 `:49-53` 다음, `Ok(())` `:54` 앞에 삽입)

```rust
    for (name, r) in [
        ("max_4xx_rate", c.max_4xx_rate),
        ("max_5xx_rate", c.max_5xx_rate),
    ] {
        if let Some(r) = r {
            if !r.is_finite() || !(0.0..=1.0).contains(&r) {
                return Err(format!("criteria.{name} must be between 0.0 and 1.0"));
            }
        }
    }
    if let Some(r) = c.min_window_rps {
        if !r.is_finite() || r < 0.0 {
            return Err("criteria.min_window_rps must be >= 0".into());
        }
    }
```
(`max_4xx_count`/`max_5xx_count`(u64)·`rps_warmup_seconds`(u32)는 타입이 음수·비유한을 막아 추가 검증 불필요.)

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo test -p handicap-controller --lib api::runs`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace
git add crates/controller/src/api/runs.rs
git commit -m "feat(controller): validate_criteria가 status-rate·min_window_rps 검증

max_4xx/5xx_rate는 0..=1 + 유한, min_window_rps는 >=0 + 유한(max_error_rate/min_rps
패턴 복제). count(u64)·warmup(u32)은 타입으로 충분. 위반=BadRequest. B6.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 5: `CriteriaSchema` 6필드 (UI schemas.ts)

> **게이트(매 UI Task 커밋 전):** `cd ui && pnpm lint && pnpm test && pnpm build`. 단일파일 빠른 반복은 `pnpm test schemas`(`--` 없이). `pnpm build`(`tsc -b`)만 Zod `.optional()` 누출을 잡는다.

**Files:**
- Modify: `ui/src/api/schemas.ts:37-43` (`CriteriaSchema`)
- Test: `ui/src/api/__tests__/schemas.test.ts` (이미 존재 — 새 `describe` 블록 추가, 새 파일 생성 금지)

- [ ] **Step 1: 실패 테스트 작성** (`ui/src/api/__tests__/schemas.test.ts`에 `describe` 블록 추가)

`CriteriaSchema`가 이 파일에 import돼 있지 않으면 상단 import에 추가(`import { CriteriaSchema } from "../schemas";`). 그 다음:
```ts
describe("CriteriaSchema status-class + window fields", () => {
  it("parses the 6 new fields", () => {
    const r = CriteriaSchema.safeParse({
      max_4xx_rate: 0.1, max_5xx_rate: 0, max_4xx_count: 3, max_5xx_count: 0,
      min_window_rps: 50, rps_warmup_seconds: 5,
    });
    expect(r.success).toBe(true);
  });
  it("rejects out-of-range rate", () => {
    expect(CriteriaSchema.safeParse({ max_5xx_rate: 1.5 }).success).toBe(false);
  });
  it("rejects non-integer count", () => {
    expect(CriteriaSchema.safeParse({ max_5xx_count: 1.5 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test schemas`
Expected: FAIL — 신규 필드 파싱 시 `max_4xx_rate`가 unknown으로 strip되거나(통과해버림) count 정수 검증 부재.

- [ ] **Step 3: 필드 추가** (`schemas.ts`의 `CriteriaSchema`, `min_rps` `:42` 다음 줄)

```ts
  max_4xx_rate: z.number().min(0).max(1).optional(),
  max_5xx_rate: z.number().min(0).max(1).optional(),
  max_4xx_count: z.number().int().nonnegative().optional(),
  max_5xx_count: z.number().int().nonnegative().optional(),
  min_window_rps: z.number().nonnegative().optional(),
  rps_warmup_seconds: z.number().int().nonnegative().optional(),
```
(`CriterionResultSchema`/`VerdictSchema`는 `metric: z.string()`이라 **무변경** — 신규 metric 행 자동 통과.)

- [ ] **Step 4: 게이트**

Run: `cd ui && pnpm test schemas && pnpm build`
Expected: 테스트 PASS + `tsc -b` clean.

- [ ] **Step 5: 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build && cd ..
cargo build -p handicap-worker && cargo build --workspace
git add ui/src/api/schemas.ts ui/src/api/__tests__/schemas.test.ts
git commit -m "feat(ui): CriteriaSchema에 status-class + window RPS 6필드

max_4xx/5xx_rate(0..1) + max_4xx/5xx_count(int) + min_window_rps + rps_warmup_seconds.
ProfileSchema.criteria(.nullish)가 품어 prefill/preset 자동 통과. CriterionResult/
Verdict 출력 스키마는 metric:string이라 무변경. B6.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 6: RunDialog 입력 6종 + state + buildCriteria/loadPreset/warmup prefill

**Files:**
- Modify: `ui/src/components/RunDialog.tsx` — state(`:97-103`), `criteriaHasValue`(`:47-56`), `sloActiveCount`(`:213`), `buildCriteria`(`:269-277`), `loadPreset`(`:161-167`), SLO 입력 JSX(`:480-535`)
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`(기존 — `describe` 추가)

- [ ] **Step 1: 실패 테스트 작성** (`ui/src/components/__tests__/RunDialog.test.tsx`에 추가)

> 실제 헬퍼 사용: `renderDialog(hasLoop)`(`:21`) + `jsonResponse({...})` + POST 캡처(`fetchMock.mock.calls.find(...)` → `JSON.parse((call![1] as RequestInit).body as string)`) — `:64-107`의 "posts env entries" 테스트와 동일 패턴. SLO 섹션은 접힘이라 먼저 펼친다. `aria-label`은 Step 3의 input과 1:1.

```tsx
it("submits status-class and window-rps criteria with % conversion", async () => {
  fetchMock.mockImplementation(() =>
    jsonResponse({
      id: "R1", scenario_id: "S1", scenario_yaml: "version: 1\nname: t\nsteps: []\n",
      status: "pending", profile: { vus: 2, ramp_up_seconds: 0, duration_seconds: 5 },
      env: {}, started_at: null, ended_at: null, created_at: 1,
    }),
  );
  const user = userEvent.setup();
  const { onCreated } = renderDialog(false);

  await user.click(screen.getByRole("button", { name: /SLO 기준/ })); // 접힌 섹션 펼침
  await user.type(screen.getByLabelText("Max 5xx rate"), "2");        // 2% → 0.02
  await user.type(screen.getByLabelText("Max 5xx count"), "0");
  await user.type(screen.getByLabelText("Min window RPS"), "50");

  await user.click(screen.getByRole("button", { name: /^Run$/ }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("R1"));

  const call = fetchMock.mock.calls.find(
    ([url, init]) =>
      typeof url === "string" &&
      url.endsWith("/api/runs") &&
      (init as RequestInit | undefined)?.method === "POST",
  );
  const body = JSON.parse((call![1] as RequestInit).body as string);
  expect(body.profile.criteria.max_5xx_rate).toBeCloseTo(0.02);
  expect(body.profile.criteria.max_5xx_count).toBe(0);
  expect(body.profile.criteria.min_window_rps).toBe(50);
});

it("prefills rps_warmup_seconds from ramp when min_window_rps set (closed-loop)", async () => {
  const user = userEvent.setup();
  renderDialog(false);

  const rampInput = screen.getByLabelText(/Ramp-up/);
  await user.clear(rampInput);
  await user.type(rampInput, "3");

  await user.click(screen.getByRole("button", { name: /SLO 기준/ })); // 펼침
  expect(screen.getByLabelText("RPS warmup seconds")).toHaveValue(null); // 처음 비어있음
  await user.type(screen.getByLabelText("Min window RPS"), "50");
  // 빈 warmup이 ramp(3)으로 prefill (type=number라 toHaveValue는 숫자 3).
  expect(screen.getByLabelText("RPS warmup seconds")).toHaveValue(3);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test RunDialog`
Expected: FAIL — `Max 5xx rate` 라벨/입력 부재.

- [ ] **Step 3: state + 헬퍼 + JSX 추가**

(a) **state**(`:103`의 `minRps` 다음):
```tsx
  const [max4xxPct, setMax4xxPct] = useState(
    initC?.max_4xx_rate != null ? String(initC.max_4xx_rate * 100) : "",
  );
  const [max5xxPct, setMax5xxPct] = useState(
    initC?.max_5xx_rate != null ? String(initC.max_5xx_rate * 100) : "",
  );
  const [max4xxCount, setMax4xxCount] = useState(numToStr(initC?.max_4xx_count));
  const [max5xxCount, setMax5xxCount] = useState(numToStr(initC?.max_5xx_count));
  const [minWindowRps, setMinWindowRps] = useState(numToStr(initC?.min_window_rps));
  const [rpsWarmup, setRpsWarmup] = useState(numToStr(initC?.rps_warmup_seconds));
```

(b) **`criteriaHasValue`**(`:48-55`의 OR 조건에 추가):
```tsx
      c.min_rps != null ||
      c.max_4xx_rate != null ||
      c.max_5xx_rate != null ||
      c.max_4xx_count != null ||
      c.max_5xx_count != null ||
      c.min_window_rps != null)
```

(c) **`sloActiveCount`**(`:213`의 배열에 추가):
```tsx
  const sloActiveCount = [
    maxP50, maxP95, maxP99, maxErrPct, minRps,
    max4xxPct, max5xxPct, max4xxCount, max5xxCount, minWindowRps,
  ].filter((s) => s.trim() !== "").length;
```

(d) **`buildCriteria`**(`:275`의 `min_rps` 다음, `return` 앞):
```tsx
    if (max4xxPct.trim() !== "") c.max_4xx_rate = Number(max4xxPct) / 100;
    if (max5xxPct.trim() !== "") c.max_5xx_rate = Number(max5xxPct) / 100;
    if (max4xxCount.trim() !== "") c.max_4xx_count = Number(max4xxCount);
    if (max5xxCount.trim() !== "") c.max_5xx_count = Number(max5xxCount);
    if (minWindowRps.trim() !== "") c.min_window_rps = Number(minWindowRps);
    if (rpsWarmup.trim() !== "") c.rps_warmup_seconds = Number(rpsWarmup);
```

(e) **`loadPreset`**(`:166`의 `setMinRps` 다음 — **useEffect 아님, imperative 경로**):
```tsx
      setMax4xxPct(pc?.max_4xx_rate != null ? String(pc.max_4xx_rate * 100) : "");
      setMax5xxPct(pc?.max_5xx_rate != null ? String(pc.max_5xx_rate * 100) : "");
      setMax4xxCount(numToStr(pc?.max_4xx_count));
      setMax5xxCount(numToStr(pc?.max_5xx_count));
      setMinWindowRps(numToStr(pc?.min_window_rps));
      setRpsWarmup(numToStr(pc?.rps_warmup_seconds));
```
> ui/CLAUDE.md 불변식: RunDialog prefill은 reseed-by-key — **`useEffect` reset을 추가하지 말 것**. 초기값은 위 `useState(initC?.…)`로, preset 명시 로드는 이 `loadPreset` 경로로만.

(f) **JSX**(`:534`의 Min RPS `</label>` 다음, `:535`의 `</div>` 앞에 5개 `<label>` 추가):
```tsx
            <label className="block text-sm">
              <span className="text-slate-600">Max 4xx rate (%)</span>
              <input type="number" min="0" max="100" step="any" aria-label="Max 4xx rate"
                className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                value={max4xxPct} onChange={(e) => setMax4xxPct(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="text-slate-600">Max 5xx rate (%)</span>
              <input type="number" min="0" max="100" step="any" aria-label="Max 5xx rate"
                className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                value={max5xxPct} onChange={(e) => setMax5xxPct(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="text-slate-600">Max 4xx count</span>
              <input type="number" min="0" aria-label="Max 4xx count"
                className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                value={max4xxCount} onChange={(e) => setMax4xxCount(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="text-slate-600">Max 5xx count</span>
              <input type="number" min="0" aria-label="Max 5xx count"
                className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                value={max5xxCount} onChange={(e) => setMax5xxCount(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="text-slate-600">Min window RPS</span>
              <input type="number" min="0" step="any" aria-label="Min window RPS"
                className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                value={minWindowRps}
                onChange={(e) => {
                  setMinWindowRps(e.target.value);
                  // closed-loop warmup prefill: 처음 값 입력 시 빈 warmup을 ramp로 채움.
                  if (e.target.value.trim() !== "" && rpsWarmup.trim() === "" && loadModel === "closed") {
                    setRpsWarmup(String(rampUp));
                  }
                }} />
            </label>
            <label className="block text-sm">
              <span className="text-slate-600">RPS warmup (s)</span>
              <input type="number" min="0" aria-label="RPS warmup seconds"
                className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                value={rpsWarmup} onChange={(e) => setRpsWarmup(e.target.value)} />
            </label>
```
> warmup prefill은 **closed-loop만**(`loadModel === "closed"`). open-loop은 `rampUp=0`이라 0을 주입하면 ramp 구간이 평가에 섞여 거짓 FAIL — open-loop은 사용자가 수동 입력(spec §8.2). (open-loop에서 `RPS warmup` 라벨 옆에 "오픈루프는 ramp 길이를 입력" 힌트를 줄지는 구현 재량 — 최소안은 prefill만 생략.)

- [ ] **Step 4: 게이트**

Run: `cd ui && pnpm test RunDialog && pnpm build`
Expected: 신규 테스트 PASS + `tsc -b` clean. (입력 추가는 additive라 tsc 캐스케이드 없음.)

- [ ] **Step 5: 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build && cd ..
cargo build -p handicap-worker && cargo build --workspace
git add ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(ui): RunDialog SLO 섹션에 status-class + window RPS 입력 6종

max 4xx/5xx rate(%↔분수) + 4xx/5xx count + min window RPS + RPS warmup(s).
buildCriteria/criteriaHasValue/sloActiveCount/loadPreset 동기화. closed-loop만
warmup을 ramp로 prefill(open-loop은 거짓 FAIL 방지 위해 수동). useEffect 미추가
(reseed-by-key 불변식). B6.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 7: VerdictPanel 라벨 + fmt 분기 (UI)

**Files:**
- Modify: `ui/src/components/report/VerdictPanel.tsx:3-15` (`METRIC_LABEL` + `fmt`)
- Test: `ui/src/components/report/__tests__/VerdictPanel.test.tsx`(이미 존재 — `describe` 블록 추가)

- [ ] **Step 1: 실패 테스트 작성** (`ui/src/components/report/__tests__/VerdictPanel.test.tsx`에 `describe` 추가)

> 이 파일은 이미 `render`/`screen`/`VerdictPanel`을 import한다(있는 것 재사용, 새 파일 생성 금지). 없는 헬퍼만 추가. 아래 `cr` 헬퍼와 `describe` 블록을 append:
```tsx
const cr = (metric: string, direction: "max" | "min", threshold: number, actual: number, passed: boolean) =>
  ({ metric, direction, threshold, actual, passed });

describe("VerdictPanel new metric rows", () => {
  it("renders status-class rate as % and count as integer, window rps with ≥", () => {
    render(
      <VerdictPanel verdict={{ passed: false, criteria: [
        cr("5xx_rate", "max", 0.05, 0.1, false),
        cr("4xx_count", "max", 0, 3, false),
        cr("min_window_rps", "min", 50, 42.5, false),
      ]}} />,
    );
    expect(screen.getByText("5xx 비율")).toBeInTheDocument();
    expect(screen.getByText(/10\.00%/)).toBeInTheDocument();      // actual 0.1 → 10.00%
    expect(screen.getByText("4xx 수")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();             // count, " ms" 없음
    expect(screen.queryByText("3 ms")).not.toBeInTheDocument();
    expect(screen.getByText("최소 구간 RPS")).toBeInTheDocument();
    expect(screen.getByText(/≥/)).toBeInTheDocument();            // min direction
    expect(screen.getByText("42.5")).toBeInTheDocument();          // 1자리
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test VerdictPanel`
Expected: FAIL — "5xx 비율" 라벨 없음(raw "5xx_rate") + count에 " ms" 붙음.

- [ ] **Step 3: `METRIC_LABEL` + `fmt` 확장** (`VerdictPanel.tsx:3-15`)

`METRIC_LABEL`에 추가:
```tsx
const METRIC_LABEL: Record<string, string> = {
  p50_ms: "p50",
  p95_ms: "p95",
  p99_ms: "p99",
  error_rate: "Error rate",
  rps: "RPS",
  "4xx_rate": "4xx 비율",
  "5xx_rate": "5xx 비율",
  "4xx_count": "4xx 수",
  "5xx_count": "5xx 수",
  min_window_rps: "최소 구간 RPS",
};
```
`fmt` 교체:
```tsx
function fmt(metric: string, v: number): string {
  if (metric === "error_rate" || metric === "4xx_rate" || metric === "5xx_rate")
    return `${(v * 100).toFixed(2)}%`;
  if (metric === "rps" || metric === "min_window_rps") return v.toFixed(1);
  if (metric === "4xx_count" || metric === "5xx_count") return String(v);
  return `${v} ms`; // p50/p95/p99
}
```

- [ ] **Step 4: 게이트**

Run: `cd ui && pnpm test VerdictPanel && pnpm build`
Expected: PASS + `tsc -b` clean.

- [ ] **Step 5: 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build && cd ..
cargo build -p handicap-worker && cargo build --workspace
git add ui/src/components/report/VerdictPanel.tsx ui/src/components/report/__tests__/VerdictPanel.test.tsx
git commit -m "feat(ui): VerdictPanel이 status-class·window RPS 행 라벨/단위 렌더

METRIC_LABEL에 4xx/5xx 비율·수·최소 구간 RPS 추가, fmt에 rate(%)·count(정수,
\" ms\" 금지)·min_window_rps(1자리) 분기. 미지 metric은 raw 라벨 fallback. B6.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## 머지 전 최종 검증

1. **전체 게이트**: `cargo build/clippy/test --workspace` green + `cd ui && pnpm lint && pnpm test && pnpm build` green(전체 `pnpm test`, 단일파일 아님 — S-D 갭).
2. **handicap-reviewer**로 whole-feature 리뷰(와이어 1:1: Rust `Criteria`/`Verdict` ↔ Zod `CriteriaSchema`/`VerdictSchema`, 분모 패리티, per-window skip 동작).
3. **라이브 run 1회**(S-D 갭 — 응답-파싱 경로는 RTL absent-fixture로 안 잡힘): controller + worker 띄우고(`cargo build -p handicap-worker` 먼저), 5xx 유도 stub(예: python echo가 500 반환) + ramp 있는 closed-loop 시나리오로 SLO 기준(max_5xx_rate / min_window_rps + warmup) 설정해 run 생성 → `/report.verdict`에 신규 행이 뜨고 per-window가 평가되는지(또는 짧은 run에서 skip되는지) 확인. `dev-doctor` 스킬로 로컬 스택 진단 가능.
4. **머지**: master에 rebase 후 `git -C <메인> merge --ff-only <branch>`(루트 CLAUDE.md 토폴로지) → `ExitWorktree(remove, discard_changes:true)`. `insights.rs`가 parallel과 겹치면 두 변경 모두 보존.
5. **문서**: ADR-0028 갱신(status-class 분모=total_http, per-window skip) + 루트 CLAUDE.md "알아둘 결정들" ADR-0028 줄 1구 + roadmap §B6에서 두 항목 "완료" 표시.

---

## Self-Review 체크 (작성자)

- **Spec 커버리지**: §4 데이터모델→T1; §5.1 status-class+공유헬퍼→T2/T3; §5.2 per-window→T2; §6 배선→T2; §7 검증→T4; §8.1 schemas→T5; §8.2 RunDialog→T6; §8.3 VerdictPanel→T7; §10 테스트→각 T. 빠짐 없음.
- **타입 일관성**: Rust `Criteria` 필드명(`max_4xx_rate`/`max_5xx_rate`/`max_4xx_count`/`max_5xx_count`/`min_window_rps`/`rps_warmup_seconds`) = Zod 키 = metric 문자열(`4xx_rate`/`5xx_rate`/`4xx_count`/`5xx_count`/`min_window_rps`) 1:1. 헬퍼명 `status_class_count`/`http_response_total`/`min_window_rps`는 T2 정의 = T3 호출 일치.
- **placeholder**: 없음(모든 코드 블록 실제).

## 리뷰 반영 (2026-06-06 spec-plan-reviewer)

per-window 산술(전 케이스)·`build_report` 배선·헬퍼 가시성·serde round-trip·라인 앵커는 CONFIRMED. 아래 6건 반영(앞 2개는 구현 즉시 깨지는 hard blocker):
- **CRITICAL-1**: 테스트 `ReportWindow` 빌더 이름 `win`→**`rwin`** — 기존 `win`(report.rs:455)은 6-인자 `WindowWithHdr` 빌더라 E0428 중복정의. T2 전 호출처 rename.
- **CRITICAL-2**: status-class 출력 순서 — 단일 루프(클래스별 rate+count)는 `4xx_rate,4xx_count,5xx_rate,5xx_count`를 내 order 테스트(spec §5.3)와 불일치 → **rate-pass + count-pass 2패스**로 분리해 `4xx_rate,5xx_rate,4xx_count,5xx_count` 보장.
- **MAJOR-3**: T6 테스트의 가짜 헬퍼(`renderRunDialog`/`lastPostBody`) → 실제 `renderDialog(false)` + `jsonResponse` + `fetchMock.mock.calls.find`/`JSON.parse(body)` 패턴(`:64-107`)으로 재작성 + warmup prefill 테스트 구체화.
- **MINOR-4**: T4 테스트에 `use crate::store::runs::Criteria;`(함수-로컬) 추가.
- **MINOR-5**: UI 테스트 3종 경로를 `__tests__/` 서브디렉토리로 정정(이미 존재 — 새 `describe` 추가, 파일 생성 금지), import `../schemas`·`../VerdictPanel`.
- **MINOR-6**: T6 warmup-prefill stub 테스트를 실제 단언으로 채움.

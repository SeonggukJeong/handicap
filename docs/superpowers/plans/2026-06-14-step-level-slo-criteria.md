# Step-level + 일반 연산자 SLO criteria Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 종료된 run 리포트의 SLO verdict가 특정 http 스텝(loop/if/parallel 중첩 포함)을 기준으로도 pass/fail을 판정하게 한다 — 가산 `Vec<Criterion>{metric,op,threshold,target}` 리스트, 8 metric × max/min, target=http-leaf step_id 필수.

**Architecture:** 기존 fixed-field `Criteria`를 **그대로 두고** `step_criteria: Vec<Criterion>`을 가산. 평가는 리포트 경로(`evaluate_criteria`가 `&[ReportStep]`을 새로 받아 step 행을 append)만 — 엔진·워커·proto·migration **무변경**. `profile_json` serde-default + `skip_serializing_if="Vec::is_empty"`로 migration-0·빈 리스트 byte-identical. 입력 검증은 범위(순수 `validate_criteria` 확장) + target 존재(시나리오 http-leaf 대조, 4개 호출부).

**Tech Stack:** Rust(axum controller, serde, hdrhistogram) + TypeScript/React(Zod, vitest). 설계 = `docs/superpowers/specs/2026-06-14-step-level-slo-criteria-design.md`.

**Commit/gate 주의(이 repo):**
- pre-commit은 cargo-영향 커밋마다 전체 workspace 게이트(수 분) → **Task 1–4(Rust)는 각각 green 커밋**, dead-code·RED-only 단독 커밋 금지(헬퍼+테스트+배선을 한 커밋으로 fold). 커밋은 `run_in_background:false` 단일 호출, 파이프(`| tail`) 금지(exit code 마스킹).
- UI 커밋(Task 5–7)은 UI 게이트(`pnpm lint && pnpm test && pnpm build`)만 — cargo skip. **머지 전 인자 없는 전체 `pnpm test` 1회**(타깃 필터만으론 타 파일 red 누락).
- TDD-guard: `store/runs.rs`·`report.rs`·`api/runs.rs`는 이미 인라인 `#[cfg(test)]`라 편집 자동통과. 새 UI 컴포넌트는 `*.test.tsx`를 **먼저** 만들어 unblock.
- 새 `Option`/`Vec` 서버 필드 Zod: `skip_serializing_if` 있으면 `.optional()`(absent), 없으면 `.nullish()`(null). `step_criteria`·`CriterionResult.target` 둘 다 `skip_serializing_if` → `.optional()`/`.nullish()`(아래 명시).

---

## File Structure

**Rust (controller, 무 migration/proto):**
- `crates/controller/src/store/runs.rs` — `Criterion` 구조체 신규 + `Criteria.step_criteria` 필드 + `has_any()` 확장 (Task 1).
- `crates/controller/src/report.rs` — `CriterionResult.target` 필드 + 6 in-function 리터럴 `target: None` (Task 1) + `evaluate_criteria(&steps)` 시그니처 + step 행 평가 (Task 2).
- `crates/controller/src/insights.rs:330`, `crates/controller/src/store/schedules.rs:617` — `CriterionResult` 테스트 리터럴 `target: None` (Task 1, 컴파일러-driven).
- `crates/controller/src/api/runs.rs` — `validate_criteria` step 범위 확장 (Task 3) + `collect_http_step_ids`/`validate_step_criteria_targets` 신규 + run-create 배선 (Task 4).
- `crates/controller/src/api/presets.rs` (create+update), `api/schedules.rs` (gate), `schedule/runner.rs` (fire) — target 검증 배선 (Task 4).

**UI:**
- `ui/src/api/schemas.ts` — `CriterionSchema` + `CriteriaSchema.step_criteria` + `CriterionResultSchema.target` (Task 5).
- `ui/src/components/profileForm.ts` — `StepCriterionDraft` 타입 + `CriteriaState.stepCriteria` + `criteriaStateFrom`/`criteriaHasValue`/`criteriaActiveCount`/`buildCriteria` (Task 5).
- `ui/src/components/StepCriteriaFields.tsx` — 신규 행 편집기 (Task 6).
- `ui/src/components/RunDialog.tsx`, `ui/src/components/ScheduleForm.tsx` — stepCriteria state + `<StepCriteriaFields>` 배선 + ScheduleForm scenario-change reset (Task 6).
- `ui/src/components/report/VerdictPanel.tsx` (steps prop + target 렌더 + key), `ui/src/components/VerdictBadge.tsx` (key), `ui/src/components/report/ReportView.tsx` (steps 전달) (Task 7).

---

## Task 1: Rust 입력/출력 모델 (Criterion·step_criteria·CriterionResult.target)

**Files:**
- Modify: `crates/controller/src/store/runs.rs:51-90`
- Modify: `crates/controller/src/report.rs:171-177` (struct) + `:229,249,270,286,296,308` (리터럴)
- Modify: `crates/controller/src/insights.rs:330`, `crates/controller/src/store/schedules.rs:617` (테스트 리터럴)

- [ ] **Step 1: `Criterion` 구조체 + `step_criteria` 필드 (store/runs.rs)**

`crates/controller/src/store/runs.rs`의 `Criteria` 구조체 바로 위에 추가:

```rust
/// step-level criterion (spec §2.1). metric×op(max/min)를 특정 http-leaf step에 적용.
/// target은 v1 필수(step-level 전용); 모델은 일반형 유지 → optional relax가 순수 가산.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Criterion {
    pub metric: String,    // p50_ms|p95_ms|p99_ms|error_rate|4xx_rate|5xx_rate|4xx_count|5xx_count
    pub op: String,        // "max" | "min" (→ 출력 direction)
    pub threshold: f64,    // rate 0.0..=1.0, ms/count >= 0
    pub target: String,    // http-leaf step_id
}
```

`Criteria` 구조체의 마지막 필드(`rps_warmup_seconds`) 뒤에 추가:

```rust
    /// step-level criteria (spec §2.1). 빈 리스트면 직렬화 생략 → migration-0·byte-identical.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub step_criteria: Vec<Criterion>,
```

`Criteria::has_any()`의 마지막 줄(`|| self.min_window_rps.is_some()`) 뒤, `// 주의:` 주석 위에 추가:

```rust
            || !self.step_criteria.is_empty()
```

- [ ] **Step 2: `CriterionResult.target` 필드 (report.rs)**

`crates/controller/src/report.rs`의 `CriterionResult` struct(:171)에 `passed` 뒤 필드 추가:

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>, // step_id; fixed-field run-level 행은 None
```

- [ ] **Step 3: 8개 `CriterionResult { … }` 리터럴에 `target: None` (컴파일러-driven)**

`report.rs`의 `evaluate_criteria` 안 6곳(`push_max` 클로저 ~229, error_rate ~249, 4xx/5xx rate 루프 ~270, 4xx/5xx count 루프 ~286, rps ~296, min_window_rps ~308)의 각 `CriterionResult { … }` 마지막에 `target: None,` 추가. 그리고 report.rs 밖 2곳: `crates/controller/src/insights.rs:330`, `crates/controller/src/store/schedules.rs:617`의 `CriterionResult { … }` 테스트 리터럴에도 `target: None,` 추가. (`cargo build`가 "missing field `target`"로 전부 잡는다.)

- [ ] **Step 4: 실패하는 테스트 작성 (store/runs.rs 인라인 `mod tests`)**

`crates/controller/src/store/runs.rs`의 `#[cfg(test)] mod tests`에 추가:

```rust
#[test]
fn criterion_serde_round_trip_and_skip_when_empty() {
    // 빈 step_criteria는 직렬화에서 생략(byte-identical) — 키가 없어야 한다.
    let c = Criteria::default();
    let v = serde_json::to_value(&c).unwrap();
    assert!(v.get("step_criteria").is_none(), "빈 step_criteria는 생략되어야 한다");

    // 비어있지 않으면 round-trip.
    let c2 = Criteria {
        step_criteria: vec![Criterion {
            metric: "p95_ms".into(),
            op: "max".into(),
            threshold: 300.0,
            target: "STEP01".into(),
        }],
        ..Default::default()
    };
    let json = serde_json::to_string(&c2).unwrap();
    let back: Criteria = serde_json::from_str(&json).unwrap();
    assert_eq!(c2, back);
    assert!(c2.has_any(), "step_criteria만 있어도 has_any는 true");
}
```

- [ ] **Step 5: 테스트 실행 → 통과 확인**

Run: `cargo test -p handicap-controller --lib store::runs::tests::criterion_serde_round_trip_and_skip_when_empty`
Expected: PASS. (Step 1–3을 한 커밋에 fold해야 컴파일된다 — Step 4가 GREEN.)

- [ ] **Step 6: 전체 게이트 + 커밋 (foreground, 파이프 없음)**

Run: `cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run -p handicap-controller`
Expected: PASS (clippy 0, 기존 verdict/리포트 테스트 무회귀 — 리터럴 None은 출력 byte-identical: `skip_serializing_if`로 생략).

```bash
git add crates/controller/src/store/runs.rs crates/controller/src/report.rs crates/controller/src/insights.rs crates/controller/src/store/schedules.rs
git commit -m "feat(controller): SLO step-criteria 모델 (Criterion·step_criteria·CriterionResult.target)"
```

---

## Task 2: `evaluate_criteria` step 행 평가

**Files:**
- Modify: `crates/controller/src/report.rs:217` (시그니처) + 본문 끝(`let passed = …` 직전) + `:552` (호출) + 테스트 호출부 10곳 (966·982·996·1006·1130·1144·1156·1203·1222·1575)

- [ ] **Step 1: 실패하는 테스트 작성 (report.rs 인라인 `mod tests`)**

`report.rs`의 `#[cfg(test)] mod tests`에 추가. 헬퍼 `step(...)`로 `ReportStep`을 만든다(기존 테스트의 `ReportStep` 생성 패턴 참고 — 필드: step_id/count/error_count/status_counts/p50_ms/p95_ms/p99_ms/loop_breakdown/download):

```rust
fn rstep(id: &str, count: u64, errors: u64, p95: u64, status: &[(&str, u64)]) -> ReportStep {
    ReportStep {
        step_id: id.into(),
        count,
        error_count: errors,
        status_counts: status.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
        p50_ms: 0,
        p95_ms: p95,
        p99_ms: 0,
        loop_breakdown: vec![],
        download: None,
    }
}

#[test]
fn step_criteria_pass_fail_skip_and_order() {
    let c = Criteria {
        max_p95_ms: Some(500), // fixed-field 1개(target=None, 먼저 나온다)
        step_criteria: vec![
            Criterion { metric: "p95_ms".into(), op: "max".into(), threshold: 200.0, target: "A".into() }, // PASS(150<=200)
            Criterion { metric: "error_rate".into(), op: "max".into(), threshold: 0.1, target: "B".into() }, // FAIL(0.5>0.1)
            Criterion { metric: "p95_ms".into(), op: "max".into(), threshold: 50.0, target: "MISSING".into() }, // skip
        ],
        ..Default::default()
    };
    let steps = vec![
        rstep("A", 10, 0, 150, &[("200", 10)]),
        rstep("B", 10, 5, 9, &[("200", 5), ("500", 5)]),
    ];
    let v = evaluate_criteria(&c, &summary(20, 5, 20.0, 9, 150), &BTreeMap::new(), &[], &steps);
    // fixed-field p95(target None) 먼저, 그 뒤 step 행 입력 순서(A, B) — MISSING은 skip.
    assert_eq!(v.criteria.len(), 3);
    assert_eq!(v.criteria[0].target, None);
    assert_eq!(v.criteria[1].target.as_deref(), Some("A"));
    assert!(v.criteria[1].passed);
    assert_eq!(v.criteria[2].target.as_deref(), Some("B"));
    assert!(!v.criteria[2].passed);
    assert!(!v.passed); // B FAIL → 전체 FAIL
}

#[test]
fn step_criteria_status_class_rate_denominator_excludes_transport_zero() {
    // 4xx_rate 분모 = http 응답(1..=5), transport "0" 제외 (run-level과 동일).
    let c = Criteria {
        step_criteria: vec![Criterion {
            metric: "4xx_rate".into(), op: "max".into(), threshold: 0.5, target: "A".into(),
        }],
        ..Default::default()
    };
    let steps = vec![rstep("A", 4, 0, 1, &[("404", 2), ("200", 2), ("0", 100)])];
    let v = evaluate_criteria(&c, &summary(4, 0, 4.0, 1, 1), &BTreeMap::new(), &[], &steps);
    assert_eq!(v.criteria.len(), 1);
    assert_eq!(v.criteria[0].actual, 0.5); // 2/(2+2), "0"=100 제외
    assert!(v.criteria[0].passed); // 0.5 <= 0.5
}

#[test]
fn step_criteria_zero_count_step_is_skipped() {
    let c = Criteria {
        step_criteria: vec![Criterion {
            metric: "p95_ms".into(), op: "max".into(), threshold: 1.0, target: "A".into(),
        }],
        ..Default::default()
    };
    let steps = vec![rstep("A", 0, 0, 0, &[])]; // count==0 → 미실행 → skip
    let v = evaluate_criteria(&c, &summary(0, 0, 0.0, 0, 0), &BTreeMap::new(), &[], &steps);
    assert!(v.criteria.is_empty()); // 행 0개 → build_report가 verdict None으로
}
```

(주의: `summary(...)` 헬퍼는 기존 테스트에 있다 — 시그니처 `summary(count, errors, rps, p95, ...)`를 기존 사용처에서 그대로 차용.)

- [ ] **Step 2: 테스트 실행 → 컴파일 실패 확인**

Run: `cargo test -p handicap-controller --lib report::tests::step_criteria_pass_fail_skip_and_order 2>&1 | head -20`
Expected: FAIL — `evaluate_criteria` takes 4 args, not 5 (시그니처 미변경).

- [ ] **Step 3: `evaluate_criteria` 시그니처 + step 평가 구현**

`report.rs:217` 시그니처에 `steps` 파라미터 추가:

```rust
pub fn evaluate_criteria(
    c: &crate::store::runs::Criteria,
    s: &ReportSummary,
    status_dist: &BTreeMap<String, u64>,
    windows: &[ReportWindow],
    steps: &[ReportStep],
) -> Verdict {
```

본문 끝, `let passed = criteria.iter().all(|r| r.passed);` **직전**에 step 평가 루프 추가:

```rust
    // step-level criteria (spec §3.3) — fixed-field 행 뒤에 입력 순서대로 append.
    for sc in &c.step_criteria {
        let Some(step) = steps.iter().find(|s| s.step_id == sc.target) else {
            continue; // 미존재 스텝 → skip (거짓 FAIL 금지)
        };
        if step.count == 0 {
            continue; // 실행 0회 → skip
        }
        let actual = match sc.metric.as_str() {
            "p50_ms" => step.p50_ms as f64,
            "p95_ms" => step.p95_ms as f64,
            "p99_ms" => step.p99_ms as f64,
            "error_rate" => step.error_count as f64 / step.count as f64,
            "4xx_rate" | "5xx_rate" => {
                let first = if sc.metric.starts_with('4') { '4' } else { '5' };
                let total = http_response_total(&step.status_counts);
                if total == 0 {
                    0.0
                } else {
                    status_class_count(&step.status_counts, first) as f64 / total as f64
                }
            }
            "4xx_count" => status_class_count(&step.status_counts, '4') as f64,
            "5xx_count" => status_class_count(&step.status_counts, '5') as f64,
            _ => continue, // 검증으로 도달 불가(방어)
        };
        let passed = if sc.op == "min" {
            actual >= sc.threshold
        } else {
            actual <= sc.threshold
        };
        criteria.push(CriterionResult {
            metric: sc.metric.clone(),
            direction: sc.op.clone(),
            threshold: sc.threshold,
            actual,
            passed,
            target: Some(sc.target.clone()),
        });
    }
```

- [ ] **Step 4: `build_report` 호출 + 테스트 호출부 10곳 업데이트**

`report.rs:552` 프로덕션 호출에 `&steps` 추가:

```rust
            let v = evaluate_criteria(c, &summary, &status_dist, &windows, &steps);
```

테스트 호출부 10곳(966·982·996·1006·1130·1144·1156·1203·1222·1575)의 `evaluate_criteria(&c, …, &w?)` 끝에 step 인자를 추가 — step을 안 쓰는 fixed-field 테스트는 `&[]`. (`cargo build`의 "expected 5 arguments"가 전부 잡는다.)

- [ ] **Step 5: 테스트 실행 → 통과**

Run: `cargo test -p handicap-controller --lib report::tests::step_criteria 2>&1 | tail -20`
Expected: 3 step_criteria 테스트 PASS + 기존 evaluate_criteria 테스트 무회귀.

- [ ] **Step 6: 전체 게이트 + 커밋 (foreground)**

Run: `cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run -p handicap-controller`
Expected: PASS.

```bash
git add crates/controller/src/report.rs
git commit -m "feat(controller): evaluate_criteria가 step 행 평가 (target별, 미실행 skip)"
```

---

## Task 3: `validate_criteria` step 범위 검증

**Files:**
- Modify: `crates/controller/src/api/runs.rs:45-72` (`validate_criteria` 끝, `Ok(())` 직전)

- [ ] **Step 1: 실패하는 테스트 작성 (api/runs.rs 인라인 `mod tests`)**

`api/runs.rs`의 `#[cfg(test)] mod tests`에 추가:

```rust
#[test]
fn validate_criteria_step_ranges() {
    use crate::store::runs::{Criteria, Criterion};
    let mk = |metric: &str, op: &str, threshold: f64| Criteria {
        step_criteria: vec![Criterion {
            metric: metric.into(), op: op.into(), threshold, target: "A".into(),
        }],
        ..Default::default()
    };
    // 정상
    assert!(validate_criteria(&mk("p95_ms", "max", 300.0)).is_ok());
    assert!(validate_criteria(&mk("error_rate", "min", 0.0)).is_ok());
    // 미지원 metric
    assert!(validate_criteria(&mk("rps", "max", 1.0)).is_err());
    // 미지원 op
    assert!(validate_criteria(&mk("p95_ms", "lt", 1.0)).is_err());
    // rate > 1
    assert!(validate_criteria(&mk("4xx_rate", "max", 1.5)).is_err());
    // 음수 ms
    assert!(validate_criteria(&mk("p95_ms", "max", -1.0)).is_err());
    // NaN
    assert!(validate_criteria(&mk("p95_ms", "max", f64::NAN)).is_err());
    // 빈 target
    assert!(validate_criteria(&Criteria {
        step_criteria: vec![Criterion { metric: "p95_ms".into(), op: "max".into(), threshold: 1.0, target: "  ".into() }],
        ..Default::default()
    }).is_err());
}
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cargo test -p handicap-controller --lib api::runs::tests::validate_criteria_step_ranges 2>&1 | tail -20`
Expected: FAIL (현재 검증이 step_criteria를 안 본다 → 미지원 metric 등이 Ok).

- [ ] **Step 3: `validate_criteria`에 step 루프 추가**

`api/runs.rs`의 `validate_criteria` 함수, 마지막 `Ok(())` **직전**에 추가:

```rust
    const STEP_METRICS: [&str; 8] = [
        "p50_ms", "p95_ms", "p99_ms", "error_rate",
        "4xx_rate", "5xx_rate", "4xx_count", "5xx_count",
    ];
    for (i, sc) in c.step_criteria.iter().enumerate() {
        if !STEP_METRICS.contains(&sc.metric.as_str()) {
            return Err(format!(
                "criteria.step_criteria[{i}].metric '{}'은 지원하지 않습니다",
                sc.metric
            ));
        }
        if sc.op != "max" && sc.op != "min" {
            return Err(format!(
                "criteria.step_criteria[{i}].op은 'max' 또는 'min'이어야 합니다"
            ));
        }
        if !sc.threshold.is_finite() {
            return Err(format!("criteria.step_criteria[{i}].threshold가 유효하지 않습니다"));
        }
        let is_rate = matches!(sc.metric.as_str(), "error_rate" | "4xx_rate" | "5xx_rate");
        if is_rate {
            if !(0.0..=1.0).contains(&sc.threshold) {
                return Err(format!(
                    "criteria.step_criteria[{i}].threshold는 0.0..=1.0이어야 합니다 (rate)"
                ));
            }
        } else if sc.threshold < 0.0 {
            return Err(format!("criteria.step_criteria[{i}].threshold는 0 이상이어야 합니다"));
        }
        if sc.target.trim().is_empty() {
            return Err(format!("criteria.step_criteria[{i}].target(step_id)가 비어 있습니다"));
        }
    }
```

- [ ] **Step 4: 테스트 실행 → 통과**

Run: `cargo test -p handicap-controller --lib api::runs::tests::validate_criteria_step_ranges 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: 전체 게이트 + 커밋 (foreground)**

Run: `cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run -p handicap-controller`
Expected: PASS.

```bash
git add crates/controller/src/api/runs.rs
git commit -m "feat(controller): validate_criteria가 step_criteria 범위 검증"
```

---

## Task 4: target 존재 검증 (`collect_http_step_ids`·`validate_step_criteria_targets`) + 4 호출부 배선

**Files:**
- Modify: `crates/controller/src/api/runs.rs` (헬퍼 2개 + `create` 배선)
- Modify: `crates/controller/src/api/presets.rs` (create 캡처 + update 신규 fetch)
- Modify: `crates/controller/src/api/schedules.rs` (gate 캡처)
- Modify: `crates/controller/src/schedule/runner.rs` (fire 배선)

- [ ] **Step 1: 실패하는 테스트 작성 (api/runs.rs 인라인 `mod tests`)**

```rust
#[test]
fn validate_step_criteria_targets_checks_http_leaf_existence() {
    use crate::store::runs::{Criteria, Criterion, Profile};
    // 중첩(loop do:) http leaf까지 잡혀야 한다.
    let yaml = r#"
version: 1
name: t
steps:
  - id: 0AAAAAAAAAAAAAAAAAAAAAAAA1
    type: http
    name: top
    request: { method: GET, url: "http://x/a" }
  - id: 0AAAAAAAAAAAAAAAAAAAAAAAA2
    type: loop
    name: lp
    repeat: 2
    do:
      - id: 0AAAAAAAAAAAAAAAAAAAAAAAA3
        type: http
        name: inner
        request: { method: GET, url: "http://x/b" }
"#;
    // Profile은 Default derive가 없다 — 15-필드 리터럴 헬퍼(api/runs.rs::tests의
    // `think_profile` 패턴). criteria만 의미가 있고 나머지는 최소 유효값.
    fn profile_with(criteria: Option<Criteria>) -> Profile {
        Profile {
            vus: 1,
            ramp_up_seconds: 0,
            duration_seconds: 1,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            data_binding: None,
            criteria,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
            measure_phases: false,
            vu_stages: None,
            ramp_down: None,
        }
    }
    let mk = |target: &str| {
        profile_with(Some(Criteria {
            step_criteria: vec![Criterion {
                metric: "p95_ms".into(), op: "max".into(), threshold: 1.0, target: target.into(),
            }],
            ..Default::default()
        }))
    };
    // 최상위 http leaf OK
    assert!(validate_step_criteria_targets(&mk("0AAAAAAAAAAAAAAAAAAAAAAAA1"), yaml).is_ok());
    // 중첩 http leaf OK
    assert!(validate_step_criteria_targets(&mk("0AAAAAAAAAAAAAAAAAAAAAAAA3"), yaml).is_ok());
    // loop 컨테이너 id는 http leaf 아님 → 거부
    assert!(validate_step_criteria_targets(&mk("0AAAAAAAAAAAAAAAAAAAAAAAA2"), yaml).is_err());
    // 없는 id → 거부
    assert!(validate_step_criteria_targets(&mk("NOPE"), yaml).is_err());
    // step_criteria 비면 시나리오 파싱 없이 Ok(빈 yaml이어도)
    assert!(validate_step_criteria_targets(&profile_with(None), "").is_ok());
}
```

(`Profile` 필드는 store/runs.rs:93-129 기준 15개 — 새 필드가 추가됐으면 컴파일러가 missing field로 잡는다.)

- [ ] **Step 2: 테스트 실행 → 컴파일 실패 확인**

Run: `cargo test -p handicap-controller --lib api::runs::tests::validate_step_criteria_targets_checks_http_leaf_existence 2>&1 | head -15`
Expected: FAIL — `validate_step_criteria_targets` / `collect_http_step_ids` 미정의.

- [ ] **Step 3: 헬퍼 2개 구현 (api/runs.rs)**

`api/runs.rs` 상단 `use`에 추가(이미 일부 import돼 있으면 중복 회피): `use handicap_engine::{Scenario, Step};`. `validate_criteria` 근처에 추가:

```rust
/// 시나리오 트리에서 http-leaf step_id를 수집(중첩 loop/if/parallel 하강).
/// container 노드 id(loop/if/parallel)는 제외 — ReportStep latency가 없어 target 불가.
/// `api/scenarios.rs::validate_parallel_branch_names`의 walk를 미러(세 번째 시나리오-walk 사이트).
fn collect_http_step_ids(steps: &[Step], out: &mut std::collections::HashSet<String>) {
    for step in steps {
        match step {
            Step::Http(h) => {
                out.insert(h.id.clone());
            }
            Step::Loop(l) => collect_http_step_ids(&l.do_, out),
            Step::If(i) => {
                collect_http_step_ids(&i.then_, out);
                for e in &i.elif {
                    collect_http_step_ids(&e.then_, out);
                }
                collect_http_step_ids(&i.else_, out);
            }
            Step::Parallel(p) => {
                for b in &p.branches {
                    collect_http_step_ids(&b.steps, out);
                }
            }
        }
    }
}

/// step-level criteria의 target이 시나리오의 실제 http-leaf step_id인지 검증(spec §4.2).
/// step_criteria가 비면 시나리오 파싱 없이 Ok(무비용·하위호환). `validate_criteria`와
/// 같은 `Result<(), String>` 계약 — 호출부가 `.map_err(ApiError::BadRequest)?`.
pub(crate) fn validate_step_criteria_targets(
    profile: &crate::store::runs::Profile,
    scenario_yaml: &str,
) -> Result<(), String> {
    let Some(criteria) = &profile.criteria else {
        return Ok(());
    };
    if criteria.step_criteria.is_empty() {
        return Ok(());
    }
    let sc = Scenario::from_yaml(scenario_yaml).map_err(|e| format!("시나리오 파싱 실패: {e}"))?;
    let mut ids = std::collections::HashSet::new();
    collect_http_step_ids(&sc.steps, &mut ids);
    for criterion in &criteria.step_criteria {
        if !ids.contains(&criterion.target) {
            return Err(format!(
                "criteria target '{}'은 시나리오의 http 스텝이 아닙니다",
                criterion.target
            ));
        }
    }
    Ok(())
}
```

- [ ] **Step 4: 테스트 실행 → 통과**

Run: `cargo test -p handicap-controller --lib api::runs::tests::validate_step_criteria_targets_checks_http_leaf_existence 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: run-create 배선 (api/runs.rs::create)**

`create`의 `validate_run_config` 호출 다음 줄에 추가:

```rust
    let validated_meta = validate_run_config(&state, &body.profile).await?;
    validate_step_criteria_targets(&body.profile, &scenario.yaml).map_err(ApiError::BadRequest)?;
```

- [ ] **Step 6: preset create 배선 (api/presets.rs::create) — 폐기 scenario 캡처**

`presets.rs::create`의 첫 부분을 다음으로:

```rust
    let scenario = scenarios::get(&state.db, &scenario_id)
        .await?
        .ok_or(ApiError::NotFound)?;
```

`validate_run_config` 호출 뒤에:

```rust
    crate::api::runs::validate_run_config(&state, &body.profile).await?;
    crate::api::runs::validate_step_criteria_targets(&body.profile, &scenario.yaml)
        .map_err(ApiError::BadRequest)?;
```

- [ ] **Step 7: preset update 배선 (api/presets.rs::update) — 신규 scenario fetch**

`presets.rs::update`의 name 검증 뒤, `validate_run_config` 전에 preset → scenario fetch 추가:

```rust
    let preset = presets::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    let scenario = scenarios::get(&state.db, &preset.scenario_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    crate::api::runs::validate_run_config(&state, &body.profile).await?;
    crate::api::runs::validate_step_criteria_targets(&body.profile, &scenario.yaml)
        .map_err(ApiError::BadRequest)?;
```

(`presets::get`이 `scenarios`/`presets` import를 요구하면 파일 상단 `use`를 확인. `PresetRow.scenario_id` 필드 존재 — presets.rs:12.)

- [ ] **Step 8: schedule gate 배선 (api/schedules.rs::gate) — 폐기 scenario 캡처**

`schedules.rs::gate`의 시나리오 fetch를 캡처로 바꾸고 검증 추가:

```rust
    let scenario = scenarios::get(&state.db, &body.scenario_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    // run/preset과 공유하는 권위 게이트(데이터셋/open-loop 검증).
    crate::api::runs::validate_run_config(state, &body.profile).await?;
    crate::api::runs::validate_step_criteria_targets(&body.profile, &scenario.yaml)
        .map_err(ApiError::BadRequest)?;
```

(gate가 create+update 공유라 한 곳 수정으로 둘 다 커버.)

- [ ] **Step 9: schedule fire 배선 (schedule/runner.rs) — 발사마다 재검증**

`runner.rs`의 `validate_run_config` 성공(`Ok(m) => m`) 이후, `spawn_run` 호출 **전**에 target 재검증 추가(이미 fetch된 `scenario` 보유):

```rust
        if let Err(e) = validate_step_criteria_targets(&sched.profile, &scenario.yaml) {
            let d = format!("검증 실패: {e}");
            record(state, &sched.id, "error", None, None, Some(&d), adv_next, adv_enabled, now_ms).await;
            summary.errored += 1;
            continue;
        }
```

`runner.rs` 상단 `use crate::api::runs::{spawn_run, validate_run_config};`에 `validate_step_criteria_targets` 추가.

- [ ] **Step 10: 통합 테스트 — preset update target 거부 (api/presets 또는 신규 tests 파일)**

기존 controller 통합 테스트 패턴(`make_app` + `NoopDispatcher`)을 차용해, 시나리오 생성 → 그 시나리오의 http step_id로 step_criteria preset 저장 성공, 없는 target으로 400 거부를 단언하는 통합 테스트 1개 추가(`crates/controller/tests/`에 신규 또는 기존 presets 테스트에 가산). 핵심 단언:

```rust
// 존재하지 않는 target → 400
let bad = json!({ "name": "p", "profile": { "vus": 1, "duration_seconds": 1,
    "criteria": { "step_criteria": [{ "metric": "p95_ms", "op": "max", "threshold": 1.0, "target": "NOPE" }] } },
    "env": {} });
let resp = /* POST /api/scenarios/{id}/presets */;
assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
```

- [ ] **Step 11: 전체 게이트 + 커밋 (foreground)**

Run: `cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run -p handicap-controller`
Expected: PASS (4 호출부 컴파일 + target 검증 테스트 green).

```bash
git add crates/controller/src/api/runs.rs crates/controller/src/api/presets.rs crates/controller/src/api/schedules.rs crates/controller/src/schedule/runner.rs crates/controller/tests/
git commit -m "feat(controller): step-criteria target 존재 검증 (run-create·preset·schedule·fire)"
```

---

## Task 5: UI Zod + profileForm 게이트

**Files:**
- Modify: `ui/src/api/schemas.ts:37-95`
- Modify: `ui/src/components/profileForm.ts`
- Test: `ui/src/api/__tests__/schemas.test.ts`, `ui/src/components/__tests__/profileForm.test.ts`

- [ ] **Step 1: Zod 스키마 추가 (schemas.ts)**

`CriteriaSchema` 위에 `CriterionSchema` 추가:

```ts
export const CriterionSchema = z.object({
  metric: z.string(),
  op: z.enum(["max", "min"]),
  threshold: z.number(),
  target: z.string().min(1),
});
export type Criterion = z.infer<typeof CriterionSchema>;
```

`CriteriaSchema`의 `rps_warmup_seconds` 줄 뒤에 추가(서버 `skip_serializing_if="Vec::is_empty"` → 빈 리스트 생략 → `.optional()`):

```ts
  step_criteria: z.array(CriterionSchema).optional(),
```

`CriterionResultSchema`의 `passed` 뒤에 추가(서버 `skip_serializing_if` → absent거나 string → nullish 안전):

```ts
  target: z.string().nullish(),
```

- [ ] **Step 2: profileForm 타입·헬퍼 갱신 (profileForm.ts)**

`CriteriaState` 타입 위에 추가:

```ts
export type StepCriterionDraft = {
  target: string;
  metric: string;
  op: "max" | "min";
  threshold: string; // rate metric은 % 표시(저장은 분수)
};

const RATE_METRICS = new Set(["error_rate", "4xx_rate", "5xx_rate"]);
```

`CriteriaState`에 필드 **하나만** 추가(⚠ `rpsWarmup`는 이미 있다 — profileForm.ts:16, 재추가 금지):

```ts
  stepCriteria: StepCriterionDraft[];
```

`EMPTY_CRITERIA`에 추가: `stepCriteria: [],` (`rpsWarmup: ""`는 이미 :30에 있음).

`criteriaStateFrom`의 return 객체 끝(기존 `rpsWarmup: numToStr(...)` :48 **뒤**)에 **stepCriteria만** 추가(⚠ `rpsWarmup` 줄 재작성 금지 — 중복 키 → `pnpm lint --max-warnings=0` 실패):

```ts
    stepCriteria: (c?.step_criteria ?? []).map((r) => ({
      target: r.target,
      metric: r.metric,
      op: r.op,
      threshold: RATE_METRICS.has(r.metric) ? String(r.threshold * 100) : String(r.threshold),
    })),
```

`criteriaHasValue`를 교체(stepCriteria가 배열이라 `Object.values(s).some(v=>v.trim())`가 깨진다):

```ts
export function criteriaHasValue(s: CriteriaState): boolean {
  const { stepCriteria, ...rest } = s;
  if (stepCriteria.length > 0) return true;
  return Object.values(rest).some((v) => v.trim() !== "");
}
```

`criteriaActiveCount`의 return을 `+ s.stepCriteria.length`:

```ts
  ].filter((v) => v.trim() !== "").length + s.stepCriteria.length;
```

`buildCriteria`의 `rps_warmup_seconds` 줄 뒤, `return` 전에 추가:

```ts
  const steps = s.stepCriteria
    .filter((r) => r.target.trim() !== "" && r.threshold.trim() !== "")
    .map((r) => ({
      metric: r.metric,
      op: r.op,
      target: r.target,
      threshold: RATE_METRICS.has(r.metric) ? Number(r.threshold) / 100 : Number(r.threshold),
    }));
  if (steps.length > 0) c.step_criteria = steps;
```

(이로써 step-only criteria도 `c`에 `step_criteria` 키가 생겨 `Object.keys(c).length > 0` 게이트를 통과 → 반환 non-undefined.)

- [ ] **Step 3: 실패하는 테스트 작성 (profileForm.test.ts)**

```ts
import { buildCriteria, criteriaActiveCount, criteriaHasValue, EMPTY_CRITERIA } from "../profileForm";

test("step-only criteria builds with % conversion and step_criteria key", () => {
  const s = {
    ...EMPTY_CRITERIA,
    stepCriteria: [
      { target: "A", metric: "p95_ms", op: "max" as const, threshold: "300" },
      { target: "B", metric: "5xx_rate", op: "max" as const, threshold: "2" }, // 2% → 0.02
    ],
  };
  const c = buildCriteria(s);
  expect(c).toBeDefined();
  expect(c!.step_criteria).toEqual([
    { target: "A", metric: "p95_ms", op: "max", threshold: 300 },
    { target: "B", metric: "5xx_rate", op: "max", threshold: 0.02 },
  ]);
  expect(criteriaHasValue(s)).toBe(true);
  expect(criteriaActiveCount(s)).toBe(2);
});

test("empty rows are dropped from build", () => {
  const s = { ...EMPTY_CRITERIA, stepCriteria: [{ target: "", metric: "p95_ms", op: "max" as const, threshold: "" }] };
  expect(buildCriteria(s)).toBeUndefined();
});
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `cd ui && pnpm test profileForm`
Expected: 새 2 테스트 + 기존 profileForm 테스트 PASS. (`schemas.test.ts`도 필요 시 step_criteria/target 파싱 케이스 1개 추가.)

- [ ] **Step 5: UI 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: PASS (tsc-b 포함 — `Criterion` 타입·CriteriaState 변경이 RunDialog/ScheduleForm을 깨지 않는지; 아직 stepCriteria를 criteriaState 객체에 안 넣었으면 `criteriaState` 리터럴이 `stepCriteria` 누락으로 TS 에러 → Task 6에서 채운다. **이 Task에서 RunDialog/ScheduleForm의 `criteriaState` 리터럴에 `stepCriteria: []`를 임시로 넣어 빌드 통과**시키고 Task 6에서 state로 교체).

```bash
git add ui/src/api/schemas.ts ui/src/components/profileForm.ts ui/src/api/__tests__/schemas.test.ts ui/src/components/__tests__/profileForm.test.ts ui/src/components/RunDialog.tsx ui/src/components/ScheduleForm.tsx
git commit -m "feat(ui): step_criteria Zod + profileForm 빌드/게이트 (CriterionSchema·% 변환)"
```

---

## Task 6: `StepCriteriaFields` 컴포넌트 + RunDialog/ScheduleForm 배선

**Files:**
- Create: `ui/src/components/StepCriteriaFields.tsx`
- Test: `ui/src/components/__tests__/StepCriteriaFields.test.tsx`
- Modify: `ui/src/components/RunDialog.tsx`, `ui/src/components/ScheduleForm.tsx`

- [ ] **Step 1: pending 테스트 먼저 작성 (TDD-guard unblock + 실제 테스트)**

`ui/src/components/__tests__/StepCriteriaFields.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StepCriteriaFields } from "../StepCriteriaFields";

const opts = [
  { id: "A", label: "login (GET /a)" },
  { id: "B", label: "feed (GET /b)" },
];

test("add appends a default row and remove drops it", async () => {
  const user = userEvent.setup();
  let rows: any[] = [];
  const onChange = (r: any[]) => { rows = r; };
  const { rerender } = render(<StepCriteriaFields value={rows} options={opts} onChange={onChange} />);
  await user.click(screen.getByRole("button", { name: "+ 스텝 기준 추가" }));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ target: "A", metric: "p95_ms", op: "max", threshold: "" });
  rerender(<StepCriteriaFields value={rows} options={opts} onChange={onChange} />);
  await user.click(screen.getByRole("button", { name: "스텝 기준 1 삭제" }));
  expect(rows).toHaveLength(0);
});

test("rate metric shows % unit, latency shows ms", () => {
  const { rerender } = render(
    <StepCriteriaFields value={[{ target: "A", metric: "5xx_rate", op: "max", threshold: "2" }]} options={opts} onChange={() => {}} />,
  );
  expect(screen.getByText("%")).toBeInTheDocument();
  rerender(
    <StepCriteriaFields value={[{ target: "A", metric: "p95_ms", op: "max", threshold: "300" }]} options={opts} onChange={() => {}} />,
  );
  expect(screen.getByText("ms")).toBeInTheDocument();
});

test("no http steps shows guidance", () => {
  render(<StepCriteriaFields value={[]} options={[]} onChange={() => {}} />);
  expect(screen.getByText(/http 스텝이 있는 시나리오/)).toBeInTheDocument();
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cd ui && pnpm test StepCriteriaFields`
Expected: FAIL — 모듈 미존재.

- [ ] **Step 3: 컴포넌트 구현 (StepCriteriaFields.tsx)**

```tsx
import type { StepCriterionDraft } from "./profileForm";

const METRICS: { value: string; label: string; unit: "ms" | "%" | "" }[] = [
  { value: "p50_ms", label: "p50(ms)", unit: "ms" },
  { value: "p95_ms", label: "p95(ms)", unit: "ms" },
  { value: "p99_ms", label: "p99(ms)", unit: "ms" },
  { value: "error_rate", label: "에러율(%)", unit: "%" },
  { value: "4xx_rate", label: "4xx 비율(%)", unit: "%" },
  { value: "5xx_rate", label: "5xx 비율(%)", unit: "%" },
  { value: "4xx_count", label: "4xx 수", unit: "" },
  { value: "5xx_count", label: "5xx 수", unit: "" },
];

export type StepOption = { id: string; label: string };

type Props = {
  value: StepCriterionDraft[];
  options: StepOption[];
  onChange: (rows: StepCriterionDraft[]) => void;
};

/** 스텝별 SLO 기준 행 편집기(프레젠테이셔널). collapsible wrapper는 부모 소유. */
export function StepCriteriaFields({ value, options, onChange }: Props) {
  const update = (i: number, patch: Partial<StepCriterionDraft>) =>
    onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i));
  const add = () =>
    onChange([
      ...value,
      { target: options[0]?.id ?? "", metric: "p95_ms", op: "max", threshold: "" },
    ]);

  return (
    <div className="mt-3">
      <div className="mb-1 text-sm font-medium text-slate-600">스텝별 기준 (선택)</div>
      {options.length === 0 ? (
        <p className="text-xs text-slate-500">
          http 스텝이 있는 시나리오에서만 추가할 수 있습니다.
        </p>
      ) : (
        <>
          {value.map((row, i) => {
            const unit = METRICS.find((m) => m.value === row.metric)?.unit ?? "";
            return (
              <div
                key={i}
                role="group"
                aria-label={`스텝 기준 ${i + 1}`}
                className="mb-2 flex items-center gap-2"
              >
                <select
                  aria-label={`스텝 ${i + 1}`}
                  className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
                  value={row.target}
                  onChange={(e) => update(i, { target: e.target.value })}
                >
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`지표 ${i + 1}`}
                  className="rounded border border-slate-300 px-2 py-1 text-sm"
                  value={row.metric}
                  onChange={(e) => update(i, { metric: e.target.value })}
                >
                  {METRICS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`연산자 ${i + 1}`}
                  className="rounded border border-slate-300 px-2 py-1 text-sm"
                  value={row.op}
                  onChange={(e) => update(i, { op: e.target.value as "max" | "min" })}
                >
                  <option value="max">≤</option>
                  <option value="min">≥</option>
                </select>
                <input
                  type="number"
                  min="0"
                  {...(unit === "%" ? { max: "100" } : {})}
                  step="any"
                  aria-label={`임계값 ${i + 1}`}
                  className="w-24 rounded border border-slate-300 px-2 py-1 text-sm"
                  value={row.threshold}
                  onChange={(e) => update(i, { threshold: e.target.value })}
                />
                {unit && <span className="text-xs text-slate-500">{unit}</span>}
                <button
                  type="button"
                  aria-label={`스텝 기준 ${i + 1} 삭제`}
                  className="shrink-0 text-slate-400 hover:text-red-600"
                  onClick={() => remove(i)}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="text-sm text-blue-600 hover:underline"
            onClick={add}
          >
            + 스텝 기준 추가
          </button>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 테스트 실행 → 통과**

Run: `cd ui && pnpm test StepCriteriaFields`
Expected: 3 테스트 PASS.

- [ ] **Step 5: RunDialog 배선**

`RunDialog.tsx`에서:
1. import 추가: `import { StepCriteriaFields, type StepOption } from "./StepCriteriaFields";`, `import { flattenHttpSteps } from "../scenario/model";`, profileForm import에 `type StepCriterionDraft` 추가.
2. criteria useState 블록(`rpsWarmup` 다음)에 추가: `const [stepCriteria, setStepCriteria] = useState<StepCriterionDraft[]>(initCriteria.stepCriteria);`
3. preset-load 핸들러(line ~183, `criteriaStateFrom(prof.criteria)` 사용처)에서 다른 setter들과 함께 `setStepCriteria(pc.stepCriteria);` 추가.
4. `criteriaState` 객체 리터럴(line ~241)에 `stepCriteria,` 추가(Task 5에서 임시로 넣은 `stepCriteria: []`를 state로 교체).
5. step 옵션 메모:

```tsx
  const stepOptions = useMemo<StepOption[]>(() => {
    if (!scenario) return [];
    return flattenHttpSteps(scenario.steps).map((s) => ({
      id: s.id,
      label: `${s.name || s.id} (${s.request.method} ${s.request.url || "—"})`,
    }));
  }, [scenario]);
```

6. **RunDialog엔 `sloOpen`이 없다 — `advancedOpen`을 쓰고 `<CriteriaFields>`는 bare 엘리먼트다**(RunDialog.tsx:118 `advancedOpen`, :536 bare `<CriteriaFields value={criteriaState} onChange={setCriteria} />`, `{advancedOpen && (<>…</>)}` 블록 안 `ko.runDialog.sectionSlo` 헤딩 아래). 그 bare `<CriteriaFields …>` **바로 다음 줄**에 한 줄 삽입(sloOpen 래핑 금지 — 이미 advancedOpen 블록 안):

```tsx
            <CriteriaFields value={criteriaState} onChange={setCriteria} />
            <StepCriteriaFields value={stepCriteria} options={stepOptions} onChange={setStepCriteria} />
```

- [ ] **Step 6: ScheduleForm 배선 (+ scenario-change reset)**

`ScheduleForm.tsx`에서 RunDialog와 동일하게 1–5 적용하되:
- step 옵션은 `parsedScenario`에서: `if (!parsedScenario) return []; return flattenHttpSteps(parsedScenario.steps).map(...)` (deps `[parsedScenario]`).
- SLO 렌더는 ScheduleForm엔 **실제로** `{sloOpen && <CriteriaFields value={criteriaState} onChange={setCriteria} />}`(ScheduleForm.tsx:361)가 있다 → 다음으로 교체:

```tsx
        {sloOpen && (
          <>
            <CriteriaFields value={criteriaState} onChange={setCriteria} />
            <StepCriteriaFields value={stepCriteria} options={stepOptions} onChange={setStepCriteria} />
          </>
        )}
```

- 시나리오 드롭다운(`value={scenarioId}` `<select>`, ScheduleForm.tsx:255-258)의 `onChange`에서 `setScenarioId(...)`와 함께 **`setStepCriteria([])`** 추가 — 시나리오가 바뀌면 dangling target 행을 비운다(DataBindingPanel reseed 선례). (RunDialog은 `scenario` prop + key-remount이라 reset 불요.)

- [ ] **Step 7: UI 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: PASS (전체 `pnpm test` — RunDialog/ScheduleForm 테스트 무회귀, tsc-b clean).

```bash
git add ui/src/components/StepCriteriaFields.tsx ui/src/components/__tests__/StepCriteriaFields.test.tsx ui/src/components/RunDialog.tsx ui/src/components/ScheduleForm.tsx
git commit -m "feat(ui): StepCriteriaFields 행 편집기 + RunDialog/ScheduleForm 배선"
```

---

## Task 7: VerdictPanel/VerdictBadge step 렌더 + key 충돌 수정

**Files:**
- Modify: `ui/src/components/report/VerdictPanel.tsx`
- Modify: `ui/src/components/VerdictBadge.tsx:43-48`
- Modify: `ui/src/components/report/ReportView.tsx:146`
- Test: `ui/src/components/report/__tests__/VerdictPanel.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성 (VerdictPanel.test.tsx)**

```tsx
test("renders step target name and avoids duplicate-metric key collision", () => {
  const verdict = {
    passed: false,
    criteria: [
      { metric: "p95_ms", direction: "max" as const, threshold: 500, actual: 100, passed: true },
      { metric: "p95_ms", direction: "max" as const, threshold: 200, actual: 150, passed: true, target: "A" },
      { metric: "p95_ms", direction: "max" as const, threshold: 50, actual: 300, passed: false, target: "B" },
    ],
  };
  const steps = new Map([["A", { name: "login" }], ["B", { name: "feed" }]]);
  render(<VerdictPanel verdict={verdict} steps={steps} />);
  expect(screen.getByText(/login/)).toBeInTheDocument();
  expect(screen.getByText(/feed/)).toBeInTheDocument();
  // 3행이 모두 렌더(key 충돌 없으면 row 3개 — p95_ms ×3)
  expect(screen.getAllByText(/p95/).length).toBeGreaterThanOrEqual(3);
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cd ui && pnpm test VerdictPanel`
Expected: FAIL — `steps` prop 미지원 + target 미렌더.

- [ ] **Step 3: VerdictPanel 구현 (prop optional + target + key)**

`VerdictPanel.tsx`를 다음으로:

```tsx
import type { Verdict } from "../../api/schemas";
import { METRIC_LABEL, fmt } from "./verdictFormat";

type StepMeta = Map<string, { name: string }>;

export function VerdictPanel({ verdict, steps }: { verdict: Verdict; steps?: StepMeta }) {
  return (
    <section aria-label="SLO verdict" className="mb-6 rounded border p-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-lg font-semibold mb-2">SLO</h3>
        <span
          className={[
            "inline-block rounded px-2 py-0.5 text-xs font-medium",
            verdict.passed ? "bg-emerald-200 text-emerald-900" : "bg-red-200 text-red-900",
          ].join(" ")}
        >
          {verdict.passed ? "PASS" : "FAIL"}
        </span>
      </div>
      <table className="text-sm">
        <thead>
          <tr className="text-left text-slate-500">
            <th className="pr-4">Metric</th>
            <th className="pr-4">Threshold</th>
            <th className="pr-4">Actual</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {verdict.criteria.map((r, idx) => {
            const stepName = r.target ? (steps?.get(r.target)?.name ?? r.target) : null;
            return (
              <tr key={`${r.metric}-${r.target ?? ""}-${idx}`}>
                <td className="pr-4">
                  {stepName && <span className="text-slate-400">{stepName} · </span>}
                  {METRIC_LABEL[r.metric] ?? r.metric}
                </td>
                <td className="pr-4">
                  {r.direction === "max" ? "≤" : "≥"} {fmt(r.metric, r.threshold)}
                </td>
                <td className="pr-4">{fmt(r.metric, r.actual)}</td>
                <td
                  className={r.passed ? "text-emerald-700" : "text-red-700"}
                  title={r.passed ? "pass" : "fail"}
                >
                  {r.passed ? "✓" : "✗"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 4: VerdictBadge key 충돌 수정**

`VerdictBadge.tsx`의 `failed.map((c) => (` 를 `failed.map((c, idx) => (`로, `key={c.metric}`를 `key={`${c.metric}-${c.target ?? ""}-${idx}`}`로 변경. (배지는 step명 plumbing 없이 raw — 본문 `{METRIC_LABEL[c.metric] ?? c.metric}` 유지, step 행은 target id가 표시 안 되지만 key 충돌만 해소 = 의도된 degrade.)

- [ ] **Step 5: ReportView가 stepMeta 전달**

`ReportView.tsx:146` `{report.verdict ? <VerdictPanel verdict={report.verdict} /> : null}` 를:

```tsx
      {report.verdict ? <VerdictPanel verdict={report.verdict} steps={stepMeta} /> : null}
```

(`stepMeta`는 `Map<string,{id,name,method,url}>` — `{name}` 구조 호환.)

- [ ] **Step 6: 테스트 실행 → 통과**

Run: `cd ui && pnpm test VerdictPanel`
Expected: 새 테스트 + 기존 VerdictPanel 테스트(verdict-only, steps 미주입) 무회귀 PASS.

- [ ] **Step 7: UI 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: PASS.

```bash
git add ui/src/components/report/VerdictPanel.tsx ui/src/components/VerdictBadge.tsx ui/src/components/report/ReportView.tsx ui/src/components/report/__tests__/VerdictPanel.test.tsx
git commit -m "feat(ui): VerdictPanel step명 렌더 + VerdictPanel/Badge key 충돌 수정"
```

---

## Task 8: 라이브 검증 (머지 전 필수 — 커밋 없음)

**Files:** 없음(검증만; 발견 시 fix 커밋).

- [ ] **Step 1: 빌드 + 격리 DB로 controller/worker 기동**

```bash
cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller
cd ui && pnpm build && cd ..
./target/debug/controller --db /tmp/slo-step.db --ui-dir ui/dist
```

(별도 터미널/`!` 프리픽스. python `ThreadingHTTPServer` 200-responder + 5ms 지연으로 p95>0 보장 — localhost RTT는 µs라 p95_ms=0 함정.)

- [ ] **Step 2: step-criteria run 1회 (UI 또는 curl)**

http 스텝 1개 시나리오 생성 → RunDialog SLO 섹션에서 그 스텝에 `p95_ms ≤ 1` (FAIL 유도) + `error_rate ≤ 1.0`(PASS) step 기준 추가 → run. 종료 후 `/report` 확인:
- `verdict.criteria`에 `target` 있는 행이 입력 순서로 존재, FAIL 행 `passed:false`.
- VerdictPanel에 step명 + ✓/✗.
- 실 `/report` JSON을 `ReportSchema.parse`(throwaway `__tests__/` 테스트 또는 콘솔)로 파싱 확인(`.nullish()` target).

- [ ] **Step 3: byte-identical 확인**

step_criteria **없는** run 1회 → `/report` JSON에 `verdict.criteria[].target` 키가 없고(생략), `criteria.step_criteria` 키 없음(profile_json 생략). 기존 fixed-field-only verdict와 출력 동일.

- [ ] **Step 4: 정리**

Playwright 사용 시 `rm -rf .playwright-mcp` + 루트 png. `/tmp/slo-step.db` 삭제.

---

## Self-Review (작성자 체크 — 이미 반영)

- **Spec 커버리지**: §2(모델)=T1, §3(평가)=T2, §4.1(범위)=T3, §4.2(target)=T4, §5.1(Zod/profileForm)=T5, §5.2(StepCriteriaFields+배선)=T6, §5.3(VerdictPanel/Badge)=T7, §7(라이브)=T8. 전부 매핑.
- **타입 일관성**: Rust `Criterion{metric,op,threshold,target}` ↔ Zod `CriterionSchema` 동일 키. `evaluate_criteria` 5-arg가 T2 이후 모든 호출부 일관. `StepCriterionDraft`(profileForm) ↔ `StepOption`(컴포넌트) 분리(draft=값, option=picker). `CriterionResult.target: Option<String>` ↔ Zod `.nullish()`.
- **placeholder 스캔**: 없음 — 모든 코드 step에 실제 코드. (T4 Step 10 통합 테스트·T8 라이브는 기존 패턴 차용 지시 + 핵심 단언 제공.)
- **게이트 경계**: T1–4 cargo(각 green, 리터럴/시그니처 churn은 컴파일러-driven으로 한 커밋에 fold), T5–7 UI. T5에서 RunDialog/ScheduleForm `criteriaState` 리터럴에 `stepCriteria: []` 임시 삽입 → T6에서 state 교체(빌드 끊김 방지).

# A4a: SLO / Pass-Fail Criteria 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 종료된 run의 리포트에 run-level SLO 기준(p50/p95/p99·error_rate·min_rps) pass/fail 판정을 붙인다.

**Architecture:** criteria를 `store::runs::Profile`(profile_json)에 스냅샷 저장 — 마이그레이션·proto·엔진·워커 무변경. `build_report`가 completed run에 한해 on-demand로 verdict 계산(`ReportJson.verdict`). UI는 RunDialog 입력 + 리포트 verdict 패널. 출력 모델(`Verdict`/`CriterionResult`)은 향후 A2(일반 연산자)·step-level이 재사용하도록 일반형.

**Tech Stack:** Rust(controller, serde/sqlx) + TypeScript/React(Zod, vitest/RTL).

**Spec:** `docs/superpowers/specs/2026-06-03-a4a-slo-pass-fail-criteria-design.md`

---

## 사전 준비 (orchestrator, 구현 전 1회)

이 슬라이스는 새 `.claude/worktrees/a4a-slo` 워크트리에서 subagent-driven으로 진행한다. 워크트리는 `node_modules`·`target`가 비어 있으므로 **첫 subagent 띄우기 전에** baseline을 깐다:

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/a4a-slo
cd ui && pnpm install            # pnpm 전역 store라 수초
cd .. && cargo build -p handicap-controller
```

- 모든 subagent prompt 첫 줄에 `cd /Users/sgj/develop/handicap/.claude/worktrees/a4a-slo` 명시.
- 백엔드 파일(`store/runs.rs`·`report.rs`·`api/runs.rs`)은 전부 인라인 `#[cfg(test)] mod tests`가 디스크에 이미 있어 tdd-guard 자동 통과. 테스트 파일(`tests/*.rs`)·UI `*.test.ts(x)` 편집도 통과. 새 UI 컴포넌트(`VerdictPanel.tsx`)는 **테스트 파일을 먼저** 만들어 unblock(Task 7).
- 커밋은 비-`.md` 변경마다 전체 workspace cargo 훅이 도므로 `run_in_background`로.

---

## Task 1: `Criteria` 모델 + `Profile.criteria` 필드

`Criteria` 구조체와 `has_any()`를 추가하고 `Profile`에 `criteria` 필드를 단다. `Profile`이 `Default`를 파생하지 않으므로 기존 `Profile { … }` 리터럴 7곳에 `criteria: None`을 명시해야 컴파일된다(spec §13/SF-1).

**Files:**
- Modify: `crates/controller/src/store/runs.rs` (Criteria + has_any + Profile.criteria + 테스트 + 리터럴 :292)
- Modify: `crates/controller/src/store/presets.rs:194`, `crates/controller/src/grpc/coordinator.rs:969`, `crates/controller/src/api/runs.rs:358`, `crates/controller/src/report.rs:298`, `crates/controller/tests/crash_recovery_test.rs:28`, `crates/controller/tests/report_test.rs:70` (각 `criteria: None`)

- [ ] **Step 1: `store/runs.rs`의 `#[cfg(test)] mod tests`에 실패 테스트 추가**

```rust
    #[test]
    fn criteria_has_any_reflects_fields() {
        assert!(!Criteria::default().has_any());
        assert!(
            Criteria {
                max_p95_ms: Some(500),
                ..Default::default()
            }
            .has_any()
        );
        assert!(
            Criteria {
                min_rps: Some(100.0),
                ..Default::default()
            }
            .has_any()
        );
    }

    #[test]
    fn profile_without_criteria_field_deserializes_to_none() {
        // pre-A4a profile_json 행에는 criteria 키가 없다 — 하위 호환.
        let json = r#"{"vus":1,"ramp_up_seconds":0,"duration_seconds":2,"loop_breakdown_cap":256,"data_binding":null}"#;
        let p: Profile = serde_json::from_str(json).unwrap();
        assert!(p.criteria.is_none());
    }

    #[test]
    fn profile_with_criteria_round_trips() {
        let p = Profile {
            vus: 1,
            ramp_up_seconds: 0,
            duration_seconds: 2,
            loop_breakdown_cap: 256,
            data_binding: None,
            criteria: Some(Criteria {
                max_p95_ms: Some(500),
                max_error_rate: Some(0.01),
                ..Default::default()
            }),
        };
        let s = serde_json::to_string(&p).unwrap();
        let back: Profile = serde_json::from_str(&s).unwrap();
        assert_eq!(p.criteria, back.criteria);
    }
```

- [ ] **Step 2: 컴파일 실패 확인**

Run: `cargo test -p handicap-controller criteria 2>&1 | head`
Expected: FAIL — `cannot find type Criteria` / `Profile` 에 `criteria` 필드 없음.

- [ ] **Step 3: `Criteria` + `has_any` 추가, `Profile`에 필드 추가** (`store/runs.rs`)

`default_loop_cap()` 아래, `Profile` 정의 위에 추가:

```rust
/// run-level SLO 기준. 모든 필드 Option — Some이면 활성 기준 1개. 전부 None이면 기준 없음.
/// (A2 일반 연산자/step-level은 후속; 출력 `Verdict`만 미리 일반형 — spec §10.)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Criteria {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_p50_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_p95_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_p99_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_error_rate: Option<f64>, // 분수 0.0..=1.0 (UI는 %로 입출력)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_rps: Option<f64>,
}

impl Criteria {
    /// 활성 기준이 하나라도 있는가. 전부 None이면 verdict를 만들지 않는다(spec §6).
    pub fn has_any(&self) -> bool {
        self.max_p50_ms.is_some()
            || self.max_p95_ms.is_some()
            || self.max_p99_ms.is_some()
            || self.max_error_rate.is_some()
            || self.min_rps.is_some()
    }
}
```

`Profile`의 `data_binding` 필드 아래에 추가:

```rust
    #[serde(default)]
    pub data_binding: Option<crate::binding::DataBinding>,
    #[serde(default)]
    pub criteria: Option<Criteria>,
```

- [ ] **Step 4: `Profile { … }` 리터럴 7곳에 `criteria: None` 추가**

각 사이트의 `data_binding: …` 줄 바로 아래에 `criteria: None,`:
- `crates/controller/src/store/runs.rs` `criteria_*` 테스트 위의 `profile` 리터럴(원래 :292 부근, `data_binding: None,` 다음)
- `crates/controller/src/store/presets.rs` `fn profile()` (:194)
- `crates/controller/src/grpc/coordinator.rs` `seed_run`의 `runs::Profile` (:969)
- `crates/controller/src/api/runs.rs` `fn unique_profile()` (:358, `data_binding: Some(…)` 닫는 줄 다음)
- `crates/controller/src/report.rs` `fn run_row()` (:298)
- `crates/controller/tests/crash_recovery_test.rs` `fn profile()` (:28)
- `crates/controller/tests/report_test.rs` (:70)

> 확인: `grep -rn "Profile {" crates/controller/ | grep -v "pb::Profile\|pub struct"` 로 빠진 곳 없는지 재점검. `pb::Profile`(api/runs.rs:179)은 proto라 무관.

- [ ] **Step 5: 테스트 통과 확인**

Run: `cargo test -p handicap-controller 2>&1 | tail -20`
Expected: PASS (criteria 3개 포함 전부 green, 컴파일 OK).

- [ ] **Step 6: 커밋**

```bash
git add crates/controller/
git commit -m "feat(controller): Criteria model + Profile.criteria (profile_json, no migration)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `evaluate_criteria` 순수 함수 + `Verdict`/`CriterionResult`

run-level criteria를 summary에 대해 평가하는 순수 함수. 결정적이라 단위 테스트가 쉽다.

**Files:**
- Modify: `crates/controller/src/report.rs` (Verdict, CriterionResult, evaluate_criteria + 테스트)

- [ ] **Step 1: `report.rs`의 `#[cfg(test)] mod tests`에 실패 테스트 추가**

`mod tests` 상단 `use` 에 `Criteria` 추가: `use crate::store::runs::{Criteria, Profile, RunStatus};`. 그리고:

```rust
    fn summary(count: u64, errors: u64, rps: f64, p95: u64, p99: u64) -> ReportSummary {
        ReportSummary {
            count,
            errors,
            rps,
            duration_seconds: 1,
            p50_ms: 0,
            p95_ms: p95,
            p99_ms: p99,
        }
    }

    #[test]
    fn evaluate_all_pass() {
        let c = Criteria {
            max_p95_ms: Some(500),
            max_error_rate: Some(0.05),
            min_rps: Some(100.0),
            ..Default::default()
        };
        let v = evaluate_criteria(&c, &summary(1000, 10, 200.0, 300, 400));
        assert!(v.passed);
        assert_eq!(v.criteria.len(), 3);
    }

    #[test]
    fn evaluate_fails_when_one_breaches() {
        let c = Criteria {
            max_p95_ms: Some(200),
            ..Default::default()
        };
        let v = evaluate_criteria(&c, &summary(100, 0, 50.0, 300, 400));
        assert!(!v.passed);
        assert_eq!(v.criteria[0].metric, "p95_ms");
        assert_eq!(v.criteria[0].direction, "max");
        assert!(!v.criteria[0].passed);
    }

    #[test]
    fn evaluate_error_rate_count_zero_is_zero() {
        let c = Criteria {
            max_error_rate: Some(0.0),
            ..Default::default()
        };
        // 0 errors / 0 count => 0.0 <= 0.0 → pass
        assert!(evaluate_criteria(&c, &summary(0, 0, 0.0, 0, 0)).passed);
    }

    #[test]
    fn evaluate_min_rps_zero_fails() {
        let c = Criteria {
            min_rps: Some(1.0),
            ..Default::default()
        };
        // rps 0.0 < 1.0 → fail (degenerate 0-throughput completed run)
        assert!(!evaluate_criteria(&c, &summary(0, 0, 0.0, 0, 0)).passed);
    }
```

- [ ] **Step 2: 컴파일 실패 확인**

Run: `cargo test -p handicap-controller evaluate 2>&1 | head`
Expected: FAIL — `cannot find function evaluate_criteria` / `Verdict`.

- [ ] **Step 3: `Verdict`/`CriterionResult`/`evaluate_criteria` 구현** (`report.rs`)

`ReportStep` 등 struct 정의 근처(파일 상단 struct 블록)에 추가:

```rust
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct Verdict {
    pub passed: bool, // 모든 활성 기준 AND
    pub criteria: Vec<CriterionResult>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CriterionResult {
    pub metric: String,    // "p50_ms" | "p95_ms" | "p99_ms" | "error_rate" | "rps"
    pub direction: String, // "max" | "min"
    pub threshold: f64,    // 정수 ms 기준도 f64로 (A2 출력 shape 공유, spec §5/N-1)
    pub actual: f64,
    pub passed: bool,
}

/// 순수: 입력만으로 결정적. 활성(Some) 기준만 결과 행을 만든다.
pub fn evaluate_criteria(c: &crate::store::runs::Criteria, s: &ReportSummary) -> Verdict {
    let mut criteria = Vec::new();

    let mut push_max = |metric: &str, threshold: Option<u64>, actual: u64| {
        if let Some(t) = threshold {
            let (threshold, actual) = (t as f64, actual as f64);
            criteria.push(CriterionResult {
                metric: metric.to_string(),
                direction: "max".to_string(),
                threshold,
                actual,
                passed: actual <= threshold,
            });
        }
    };
    push_max("p50_ms", c.max_p50_ms, s.p50_ms);
    push_max("p95_ms", c.max_p95_ms, s.p95_ms);
    push_max("p99_ms", c.max_p99_ms, s.p99_ms);
    drop(push_max); // criteria 가변 차용 해제

    if let Some(t) = c.max_error_rate {
        let actual = if s.count == 0 {
            0.0
        } else {
            s.errors as f64 / s.count as f64
        };
        criteria.push(CriterionResult {
            metric: "error_rate".to_string(),
            direction: "max".to_string(),
            threshold: t,
            actual,
            passed: actual <= t,
        });
    }
    if let Some(t) = c.min_rps {
        criteria.push(CriterionResult {
            metric: "rps".to_string(),
            direction: "min".to_string(),
            threshold: t,
            actual: s.rps,
            passed: s.rps >= t,
        });
    }

    let passed = criteria.iter().all(|r| r.passed);
    Verdict { passed, criteria }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo test -p handicap-controller evaluate 2>&1 | tail`
Expected: PASS (4개 evaluate_* green).

- [ ] **Step 5: 커밋**

```bash
git add crates/controller/src/report.rs
git commit -m "feat(controller): evaluate_criteria pure fn + Verdict/CriterionResult

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `build_report`에 verdict 배선 + `ReportJson.verdict`

completed run + 활성 criteria일 때만 verdict를 붙인다. 비완료·기준없음·all-None은 `None`.

**Files:**
- Modify: `crates/controller/src/report.rs` (ReportJson.verdict + build_report tail + 테스트)

- [ ] **Step 1: 실패 테스트 추가** (`report.rs` `mod tests`)

```rust
    #[test]
    fn build_report_attaches_verdict_for_completed_with_criteria() {
        let mut run = run_row(); // status = Completed
        run.profile.criteria = Some(Criteria {
            max_p95_ms: Some(1000),
            ..Default::default()
        });
        let rep = build_report(&run, "", &[], &[], &[]);
        let v = rep.verdict.expect("verdict present");
        assert_eq!(v.criteria.len(), 1);
        assert!(v.passed); // 빈 윈도 → p95 0 <= 1000
    }

    #[test]
    fn build_report_no_verdict_when_not_completed() {
        let mut run = run_row();
        run.status = RunStatus::Aborted;
        run.profile.criteria = Some(Criteria {
            max_p95_ms: Some(1000),
            ..Default::default()
        });
        assert!(build_report(&run, "", &[], &[], &[]).verdict.is_none());
    }

    #[test]
    fn build_report_no_verdict_when_criteria_all_none() {
        let mut run = run_row();
        run.profile.criteria = Some(Criteria::default()); // 활성 0개
        assert!(build_report(&run, "", &[], &[], &[]).verdict.is_none());
    }
```

- [ ] **Step 2: 컴파일 실패 확인**

Run: `cargo test -p handicap-controller build_report_attaches_verdict 2>&1 | head`
Expected: FAIL — `ReportJson` 에 `verdict` 필드 없음.

- [ ] **Step 3: `ReportJson`에 필드 추가 + build_report tail 수정** (`report.rs`)

`ReportJson` struct 끝에 추가:

```rust
    pub if_breakdown: Vec<IfBreakdown>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<Verdict>,
}
```

`build_report` 끝의 `ReportJson { … }` 반환 literal 직전에서 `summary`를 별도 바인딩으로 추출하고 verdict 계산. 즉 기존:

```rust
        summary: ReportSummary {
            count: total_count,
            errors: total_errors,
            rps,
            duration_seconds,
            p50_ms: overall_p.p50_ms,
            p95_ms: overall_p.p95_ms,
            p99_ms: overall_p.p99_ms,
        },
```

를 반환 literal 위로 끌어올린다. 반환 literal 바로 앞에:

```rust
    let summary = ReportSummary {
        count: total_count,
        errors: total_errors,
        rps,
        duration_seconds,
        p50_ms: overall_p.p50_ms,
        p95_ms: overall_p.p95_ms,
        p99_ms: overall_p.p99_ms,
    };
    // completed + 활성 criteria일 때만 verdict (spec §6). RunStatus는 Copy.
    let verdict = match (run.status, run.profile.criteria.as_ref()) {
        (RunStatus::Completed, Some(c)) if c.has_any() => Some(evaluate_criteria(c, &summary)),
        _ => None,
    };

    ReportJson {
        run: ReportRun { /* 기존 그대로 */ },
        scenario_yaml: scenario_yaml.to_string(),
        summary,
        windows,
        steps,
        status_distribution: status_dist,
        if_breakdown,
        verdict,
    }
```

> `run.status`는 `RunStatus`(`Copy` 파생, store/runs.rs:7)라 `match (run.status, …)`가 값으로 동작. `RunStatus`가 이미 `mod tests`에서 import돼 있고 build_report 본문에선 `use crate::store::runs::RunStatus;`가 파일 상단에 있는지 확인(없으면 `crate::store::runs::RunStatus::Completed`로 fully-qualify).

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo test -p handicap-controller build_report 2>&1 | tail`
Expected: PASS (기존 build_report_* + 신규 3개 green).

- [ ] **Step 5: 커밋**

```bash
git add crates/controller/src/report.rs
git commit -m "feat(controller): attach verdict to report for completed runs (B2 on-demand)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `validate_run_config` criteria 검증

error_rate·min_rps 범위/유한성 검증. DB 불필요한 순수 헬퍼로 빼서 단위 테스트.

**Files:**
- Modify: `crates/controller/src/api/runs.rs` (validate_criteria 헬퍼 + validate_run_config 호출 + 테스트)

- [ ] **Step 1: 실패 테스트 추가** (`api/runs.rs` `#[cfg(test)] mod tests`)

```rust
    #[test]
    fn validate_criteria_accepts_valid_and_empty() {
        use crate::store::runs::Criteria;
        assert!(validate_criteria(&Criteria::default()).is_ok());
        assert!(validate_criteria(&Criteria {
            max_p95_ms: Some(500),
            max_error_rate: Some(0.01),
            min_rps: Some(100.0),
            ..Default::default()
        })
        .is_ok());
    }

    #[test]
    fn validate_criteria_rejects_bad_error_rate() {
        use crate::store::runs::Criteria;
        assert!(validate_criteria(&Criteria {
            max_error_rate: Some(1.5),
            ..Default::default()
        })
        .is_err());
        assert!(validate_criteria(&Criteria {
            max_error_rate: Some(f64::NAN),
            ..Default::default()
        })
        .is_err());
    }

    #[test]
    fn validate_criteria_rejects_negative_rps() {
        use crate::store::runs::Criteria;
        assert!(validate_criteria(&Criteria {
            min_rps: Some(-1.0),
            ..Default::default()
        })
        .is_err());
    }
```

- [ ] **Step 2: 컴파일 실패 확인**

Run: `cargo test -p handicap-controller validate_criteria 2>&1 | head`
Expected: FAIL — `cannot find function validate_criteria`.

- [ ] **Step 3: `validate_criteria` 헬퍼 추가 + `validate_run_config`에서 호출** (`api/runs.rs`)

`loop_cap_ok` 근처(프로덕션 영역)에 추가:

```rust
/// run-level criteria 검증(spec §7). DB 불필요 — 순수. 위반은 BadRequest 메시지.
pub(crate) fn validate_criteria(c: &crate::store::runs::Criteria) -> Result<(), String> {
    if let Some(r) = c.max_error_rate {
        if !r.is_finite() || !(0.0..=1.0).contains(&r) {
            return Err("criteria.max_error_rate must be between 0.0 and 1.0".into());
        }
    }
    if let Some(r) = c.min_rps {
        if !r.is_finite() || r < 0.0 {
            return Err("criteria.min_rps must be >= 0".into());
        }
    }
    Ok(())
}
```

`validate_run_config` 안, `loop_cap_ok` 검사 블록 바로 다음에:

```rust
    if let Some(c) = &profile.criteria {
        validate_criteria(c).map_err(ApiError::BadRequest)?;
    }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo test -p handicap-controller validate_criteria 2>&1 | tail`
Expected: PASS (3개 green).

- [ ] **Step 5: 커밋**

```bash
git add crates/controller/src/api/runs.rs
git commit -m "feat(controller): validate criteria in shared run-config gate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

> 백엔드 완료. 여기서 `cargo test -p handicap-controller 2>&1 | tail` 전체 green 확인 후 UI로.

---

## Task 5: UI Zod 스키마 — `ProfileSchema.criteria` + `ReportSchema.verdict`

와이어 1:1. `ReportSchema`는 `.strict()`라 backend `verdict`를 받으려면 스키마에 키가 **반드시** 있어야 한다(spec §8.1/SF-2). `ProfileSchema`는 plain `z.object`라 키가 없으면 criteria를 조용히 strip하므로 추가 필요(SF-5).

**Files:**
- Modify: `ui/src/api/schemas.ts`
- Test: `ui/src/api/__tests__/schemas.test.ts`

- [ ] **Step 1: 실패 테스트 추가** (`schemas.test.ts`)

파일 상단 import에 `ProfileSchema`, `ReportSchema`, `VerdictSchema` 포함(없으면 추가). 그리고:

```ts
  it("ProfileSchema carries criteria, undefined when absent", () => {
    const p = ProfileSchema.parse({
      vus: 1,
      duration_seconds: 2,
      criteria: { max_p95_ms: 500, max_error_rate: 0.01 },
    });
    expect(p.criteria?.max_p95_ms).toBe(500);
    expect(ProfileSchema.parse({ vus: 1, duration_seconds: 2 }).criteria).toBeUndefined();
  });

  it("ReportSchema accepts verdict and tolerates its absence", () => {
    const base = {
      run: {
        id: "r1",
        scenario_id: "s1",
        status: "completed",
        profile: {},
        env: {},
        started_at: 100,
        ended_at: 102,
        created_at: 99,
      },
      scenario_yaml: "version: 1\nname: x\nsteps: []\n",
      summary: { count: 0, errors: 0, rps: 0, duration_seconds: 0, p50_ms: 0, p95_ms: 0, p99_ms: 0 },
      windows: [],
      steps: [],
      status_distribution: {},
    };
    expect(ReportSchema.parse(base).verdict).toBeUndefined();
    const withV = ReportSchema.parse({
      ...base,
      verdict: {
        passed: false,
        criteria: [
          { metric: "p95_ms", direction: "max", threshold: 500, actual: 800, passed: false },
        ],
      },
    });
    expect(withV.verdict?.passed).toBe(false);
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm vitest run src/api/__tests__/schemas.test.ts 2>&1 | tail -15`
Expected: FAIL — `verdict`가 strict ReportSchema에서 unrecognized key, 또는 `VerdictSchema` import 실패.

- [ ] **Step 3: 스키마 추가** (`schemas.ts`)

`ProfileSchema` 정의 **위**에 `CriteriaSchema` 추가:

```ts
export const CriteriaSchema = z.object({
  max_p50_ms: z.number().int().nonnegative().optional(),
  max_p95_ms: z.number().int().nonnegative().optional(),
  max_p99_ms: z.number().int().nonnegative().optional(),
  max_error_rate: z.number().min(0).max(1).optional(), // 분수 (UI 입출력은 %)
  min_rps: z.number().nonnegative().optional(),
});
export type Criteria = z.infer<typeof CriteriaSchema>;
```

`ProfileSchema`의 `data_binding` 줄 아래에:

```ts
  data_binding: DataBindingSchema.nullish(),
  criteria: CriteriaSchema.nullish(),
});
```

`ReportSchema` 정의 **위**에 verdict 스키마:

```ts
export const CriterionResultSchema = z.object({
  metric: z.string(),
  direction: z.enum(["max", "min"]),
  threshold: z.number(),
  actual: z.number(),
  passed: z.boolean(),
});
export const VerdictSchema = z.object({
  passed: z.boolean(),
  criteria: z.array(CriterionResultSchema),
});
export type Verdict = z.infer<typeof VerdictSchema>;
```

`ReportSchema`의 `if_breakdown` 줄 아래에:

```ts
    if_breakdown: z.array(IfBreakdownSchema).optional(),
    verdict: VerdictSchema.nullish(),
  })
  .strict();
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm vitest run src/api/__tests__/schemas.test.ts 2>&1 | tail`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add ui/src/api/schemas.ts ui/src/api/__tests__/schemas.test.ts
git commit -m "feat(ui): Zod ProfileSchema.criteria + ReportSchema.verdict (wire 1:1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: RunDialog SLO 기준 입력 (양쪽 profile 생성 지점)

5개 선택적 입력. error_rate는 %로 입출력, 분수로 저장. **profile 생성 지점이 2곳**(submit + preset `currentInput`)이라 둘 다 criteria를 넣어야 한다(spec §8.2/SF-3). prefill(초기 seed + preset 로드)도 반영.

**Files:**
- Modify: `ui/src/components/RunDialog.tsx`
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`

- [ ] **Step 1: 실패 테스트 추가** (`RunDialog.test.tsx`)

기존 테스트의 render/mock 패턴(mutation/`createRun` mock, RTL `render`)을 그대로 따른다. 핵심 단언:

```ts
  it("includes criteria in the run POST body with error_rate as a fraction", async () => {
    // 기존 테스트처럼 RunDialog 렌더 + createRun(or mutation) mock.
    // p95 입력에 "500", Max error rate (%) 입력에 "1" 입력 후 Run 클릭.
    // 단언: 전달된 profile.criteria === { max_p95_ms: 500, max_error_rate: 0.01 }
  });

  it("omits criteria when all SLO inputs are empty", async () => {
    // SLO 입력 비운 채 Run → profile.criteria === undefined
  });
```

라벨 텍스트는 Step 3에서 추가하는 입력 라벨과 일치시킨다(예: `Max p95 (ms)`, `Max error rate (%)`). mock 호출 인자에서 `profile.criteria`를 꺼내 단언.

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm vitest run src/components/__tests__/RunDialog.test.tsx 2>&1 | tail -15`
Expected: FAIL — SLO 입력 라벨이 없음 / criteria가 본문에 없음.

- [ ] **Step 3: RunDialog에 입력 state + 헬퍼 + 양쪽 site + prefill**

`useState` 블록(`const [loopCap, …]` 근처)에 추가. 초기값은 `initial?.profile.criteria`에서 seed:

```ts
  const initC = initial?.profile.criteria ?? undefined;
  const numToStr = (n?: number) => (n == null ? "" : String(n));
  const [maxP50, setMaxP50] = useState(numToStr(initC?.max_p50_ms));
  const [maxP95, setMaxP95] = useState(numToStr(initC?.max_p95_ms));
  const [maxP99, setMaxP99] = useState(numToStr(initC?.max_p99_ms));
  const [maxErrPct, setMaxErrPct] = useState(
    initC?.max_error_rate != null ? String(initC.max_error_rate * 100) : "",
  );
  const [minRps, setMinRps] = useState(numToStr(initC?.min_rps));
```

`currentInput`/submit 위에 criteria 빌더(컴포넌트 함수 본문 안, `import type { Criteria } from "../api/schemas";` 추가):

```ts
  function buildCriteria(): Criteria | undefined {
    const c: Criteria = {};
    if (maxP50.trim() !== "") c.max_p50_ms = Number(maxP50);
    if (maxP95.trim() !== "") c.max_p95_ms = Number(maxP95);
    if (maxP99.trim() !== "") c.max_p99_ms = Number(maxP99);
    if (maxErrPct.trim() !== "") c.max_error_rate = Number(maxErrPct) / 100;
    if (minRps.trim() !== "") c.min_rps = Number(minRps);
    return Object.keys(c).length > 0 ? c : undefined;
  }
```

`currentInput()`의 profile에 `criteria: buildCriteria(),` 추가:

```ts
      profile: {
        vus,
        duration_seconds: duration,
        ramp_up_seconds: rampUp,
        loop_breakdown_cap: hasLoop ? loopCap : 0,
        data_binding: binding ?? undefined,
        criteria: buildCriteria(),
      },
```

submit `mutation.mutate` 의 profile에도 동일하게 `criteria: buildCriteria(),` 추가(두 군데 모두!).

preset 로드 핸들러(`setLoopCap(prof.loop_breakdown_cap);` 다음 줄)에 criteria 입력 갱신:

```ts
      setLoopCap(prof.loop_breakdown_cap);
      const pc = prof.criteria ?? undefined;
      setMaxP50(numToStr(pc?.max_p50_ms));
      setMaxP95(numToStr(pc?.max_p95_ms));
      setMaxP99(numToStr(pc?.max_p99_ms));
      setMaxErrPct(pc?.max_error_rate != null ? String(pc.max_error_rate * 100) : "");
      setMinRps(numToStr(pc?.min_rps));
```

폼 JSX(loop cap 입력 근처, env/binding 패널 위)에 "SLO 기준" 섹션. 각 입력은 빈 칸 허용(number지만 빈 값 위해 text+inputMode 또는 value/onChange로 string state):

```tsx
      <fieldset className="mt-3 border-t pt-3">
        <legend className="text-sm font-medium">SLO 기준 (선택)</legend>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm">
            Max p50 (ms)
            <input className="border px-2 py-1 w-full" inputMode="numeric"
              value={maxP50} onChange={(e) => setMaxP50(e.target.value)} />
          </label>
          <label className="text-sm">
            Max p95 (ms)
            <input className="border px-2 py-1 w-full" inputMode="numeric"
              value={maxP95} onChange={(e) => setMaxP95(e.target.value)} />
          </label>
          <label className="text-sm">
            Max p99 (ms)
            <input className="border px-2 py-1 w-full" inputMode="numeric"
              value={maxP99} onChange={(e) => setMaxP99(e.target.value)} />
          </label>
          <label className="text-sm">
            Max error rate (%)
            <input className="border px-2 py-1 w-full" inputMode="decimal"
              value={maxErrPct} onChange={(e) => setMaxErrPct(e.target.value)} />
          </label>
          <label className="text-sm">
            Min RPS
            <input className="border px-2 py-1 w-full" inputMode="decimal"
              value={minRps} onChange={(e) => setMinRps(e.target.value)} />
          </label>
        </div>
      </fieldset>
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm vitest run src/components/__tests__/RunDialog.test.tsx 2>&1 | tail`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(ui): SLO criteria inputs in RunDialog (run + preset, %->fraction)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: 리포트 verdict 패널 (`VerdictPanel` + ReportView 배선)

`StatusBadge`는 5개 RunStatus만 받는 닫힌 컴포넌트라 재사용 불가 — 같은 Tailwind 이디엄의 **새** PASS/FAIL 배지를 만든다(spec §8.3/SF-4). 새 컴포넌트라 **테스트 파일을 먼저** 만들어 tdd-guard unblock.

**Files:**
- Create: `ui/src/components/report/__tests__/VerdictPanel.test.tsx`
- Create: `ui/src/components/report/VerdictPanel.tsx`
- Modify: `ui/src/components/report/ReportView.tsx`
- Modify: `ui/src/components/report/__tests__/ReportView.test.tsx`

- [ ] **Step 1: 새 테스트 파일 작성** (`VerdictPanel.test.tsx`)

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { VerdictPanel } from "../VerdictPanel";

describe("VerdictPanel", () => {
  it("renders PASS with the metric label", () => {
    render(
      <VerdictPanel
        verdict={{
          passed: true,
          criteria: [{ metric: "p95_ms", direction: "max", threshold: 500, actual: 300, passed: true }],
        }}
      />,
    );
    expect(screen.getByText("PASS")).toBeInTheDocument();
    expect(screen.getByText("p95")).toBeInTheDocument();
  });

  it("renders FAIL and formats error_rate as percent", () => {
    render(
      <VerdictPanel
        verdict={{
          passed: false,
          criteria: [
            { metric: "error_rate", direction: "max", threshold: 0.01, actual: 0.05, passed: false },
          ],
        }}
      />,
    );
    expect(screen.getByText("FAIL")).toBeInTheDocument();
    expect(screen.getByText("5.00%")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm vitest run src/components/report/__tests__/VerdictPanel.test.tsx 2>&1 | tail`
Expected: FAIL — `Cannot find module '../VerdictPanel'`.

- [ ] **Step 3: `VerdictPanel.tsx` 생성 + ReportView 배선**

`ui/src/components/report/VerdictPanel.tsx`:

```tsx
import type { Verdict } from "../../api/schemas";

const METRIC_LABEL: Record<string, string> = {
  p50_ms: "p50",
  p95_ms: "p95",
  p99_ms: "p99",
  error_rate: "Error rate",
  rps: "RPS",
};

function fmt(metric: string, v: number): string {
  if (metric === "error_rate") return `${(v * 100).toFixed(2)}%`;
  if (metric === "rps") return v.toFixed(1);
  return `${v} ms`;
}

export function VerdictPanel({ verdict }: { verdict: Verdict }) {
  return (
    <div className="mb-4 rounded border p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-semibold">SLO</span>
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
          {verdict.criteria.map((r) => (
            <tr key={r.metric}>
              <td className="pr-4">{METRIC_LABEL[r.metric] ?? r.metric}</td>
              <td className="pr-4">
                {r.direction === "max" ? "≤" : "≥"} {fmt(r.metric, r.threshold)}
              </td>
              <td className="pr-4">{fmt(r.metric, r.actual)}</td>
              <td className={r.passed ? "text-emerald-700" : "text-red-700"}>
                {r.passed ? "✓" : "✗"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

`ReportView.tsx`: import 추가 `import { VerdictPanel } from "./VerdictPanel";`. JSX의 header(`<DownloadJsonButton …/>`가 든 div) 닫은 직후, `<Summary …/>` 위에:

```tsx
      {report.verdict ? <VerdictPanel verdict={report.verdict} /> : null}
      <Summary summary={report.summary} />
```

- [ ] **Step 4: VerdictPanel 테스트 통과 확인**

Run: `cd ui && pnpm vitest run src/components/report/__tests__/VerdictPanel.test.tsx 2>&1 | tail`
Expected: PASS.

- [ ] **Step 5: ReportView에 "verdict 없으면 패널 미렌더" 단언 추가** (`ReportView.test.tsx`)

기존 ReportView 테스트의 report fixture(verdict 키 없음)를 사용해 한 줄 추가:

```ts
  it("renders no SLO panel when report has no verdict", () => {
    // 기존 테스트와 동일하게 ReportView 렌더(verdict 없는 fixture).
    expect(screen.queryByText("PASS")).not.toBeInTheDocument();
    expect(screen.queryByText("FAIL")).not.toBeInTheDocument();
  });
```

Run: `cd ui && pnpm vitest run src/components/report/__tests__/ReportView.test.tsx 2>&1 | tail`
Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
git add ui/src/components/report/
git commit -m "feat(ui): SLO verdict panel on report page (new PASS/FAIL badge)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: ADR-0028 + CLAUDE.md + roadmap

문서. `.md`-only라 pre-commit cargo 훅 skip.

**Files:**
- Create: `docs/adr/0028-run-level-slo-criteria.md`
- Modify: `CLAUDE.md` ("알아둘 결정들"에 1줄)
- Modify: `docs/roadmap.md` (A4a 완료 표기 + §B 연기 항목)

- [ ] **Step 1: ADR-0028 작성** (MADR 포맷)

`docs/adr/0028-run-level-slo-criteria.md`:

```markdown
# 0028. Run-level SLO/pass-fail criteria (리포트 verdict)

- 상태: 채택
- 날짜: 2026-06-03

## 맥락

ADR-0017이 "run간 비교·SLA는 후속"으로 연기. A4a로 SLA(pass/fail)를 실현.
리포트는 "무엇이 일어났나"는 답하지만 "합격인가"는 못 답함.

## 결정

- run-level criteria만(p50/p95/p99·error_rate·min_rps). step-level/status-class는 후속.
- criteria를 `store::runs::Profile`(profile_json)에 스냅샷 저장 — 마이그레이션·proto·엔진·워커 무변경. 프리셋 자동 포함.
- completed run에 한해 `build_report`가 on-demand로 verdict 계산(B2). 멀티워커 finalize 경로 미접촉, 완료-시점 race 없음.
- 고정 per-metric 모델, 출력(`Verdict`/`CriterionResult`)은 A2 일반 연산자/step-level 대비 일반형.
- error_rate = 엔진 `error_count`(transport+assertion+extract 실패) / count. 생 4xx/5xx는 status assertion 없으면 미포함 — 한계 문서화, status-class 후속의 근거.

## 결과

- 도구가 "차트 뷰어"→"릴리스 게이트"로. run 목록 배지·step-level·status-class·run 비교(A4b)·요약(A4c)은 후속.
```

- [ ] **Step 2: CLAUDE.md "알아둘 결정들"에 1줄 추가**

`- **0027** 멀티 워커 fan-out …` 줄 아래:

```markdown
- **0028** Run-level SLO criteria: profile_json 스냅샷 저장(마이그레이션·proto·워커 무변경) + completed-only on-demand verdict(B2) + 고정 per-metric 모델(일반형 출력) + error_rate=엔진 실패 비율. run 목록 배지·step/status-class·run 비교는 후속
```

- [ ] **Step 3: roadmap.md 갱신**

`### A4. LoadRunner급 리포트 깊이` 항목에 진행 표기 추가(A4a 완료, A4b/A4c 후속). §B(연기 항목)에 A4a 출처로:
- run 목록 pass/fail 배지(영속화 필요)
- step-level criteria
- status-class criteria(생 5xx_count)
- per-window 최소 RPS
- 일반 연산자 모델

- [ ] **Step 4: 커밋**

```bash
git add docs/adr/0028-run-level-slo-criteria.md CLAUDE.md docs/roadmap.md
git commit -m "docs: ADR-0028 run-level SLO criteria + roadmap/CLAUDE.md

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 최종 검증 게이트 (머지 전)

- [ ] `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo test --workspace 2>&1 | tail -20` — 전부 green
- [ ] `cd ui && pnpm lint && pnpm test && pnpm build` — lint 0 warn, 테스트 green, `tsc -b` clean
- [ ] `grep -rn '^<<<<<<<\|^>>>>>>>' **/*.md` — conflict marker 0
- [ ] 최종 whole-feature 리뷰는 `handicap-reviewer` 에이전트로 — 특히 UI Zod ↔ 엔진 serde 와이어 1:1(criteria 필드명·verdict shape·`.strict()` 결합), deferral 추적, 게이트 재확인.

## 머지

master rebase 후 ff-merge(remote 없음): `git checkout master && git merge --ff-only a4a-slo`. 세션 중 master 전진 시 `git rebase master` 후 ff. 워크트리 정리는 `ExitWorktree`(머지 확인 후 `discard_changes: true`).

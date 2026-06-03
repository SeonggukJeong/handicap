# A4c Actionable Report Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 종료된 run 리포트 최상단에 결정론적 actionable 인사이트 패널을 붙이고(백엔드 파생), XLSX export에 Insights 시트를 추가한다.

**Architecture:** 컨트롤러 `build_report`가 이미 만든 `summary`/`steps`/`status_distribution`/`verdict`/`windows` + 파싱한 `scenario_yaml`에서 순수 함수 `derive_insights`(신규 `insights.rs`)가 구조화된 `Vec<Insight>`를 만들어 `ReportJson.insights`에 싣는다. UI는 그 구조를 한국어로 렌더만 한다(`InsightPanel`). 엔진·워커·proto·DB 마이그레이션 무변경.

**Tech Stack:** Rust(controller, serde, hdrhistogram 무관), `handicap_engine::{Scenario, Step}`(시나리오 파싱), `rust_xlsxwriter`(export), TypeScript/React + Zod + vitest/RTL(UI).

**Spec:** `docs/superpowers/specs/2026-06-03-a4c-actionable-report-summary-design.md`

---

## 커밋 경계 / TDD 가드 (orchestrator 필독)

이 repo의 pre-commit 훅은 **비-`.md` 커밋마다 `cargo build/clippy/test --workspace` 전체**를 돌린다(수 분). 그래서:

- **각 task = 하나의 green 커밋.** RED 테스트만 따로 커밋 불가(`test --workspace` 게이트), 미사용 헬퍼만 따로 커밋 불가(`clippy -D warnings` dead_code). 로컬에선 RED→GREEN 확인하되 **커밋은 task당 1회**.
- **implementer의 commit은 단일 FOREGROUND blocking 호출**(`run_in_background: false`, `timeout: 600000`)로 시키고 **폴링 금지**(A4b 교훈 — background-commit+poll가 subagent 턴을 truncate). orchestrator 자신의 후속 커밋만 background 허용.
- **커밋은 파이프 없이**(`| tail` 금지 — exit code 마스킹), 직후 `git log -1`로 landed 확인.
- **TDD 가드 keepalive(Task 1 한정)**: Task 1은 신규 `crates/controller/src/insights.rs`를 Write하고 `lib.rs`를 편집한다. 둘 다 디스크에 inline `#[cfg(test)]`가 *아직* 없어 PreToolUse 가드가 막는다. **orchestrator가 Task 1 착수 전에 `crates/controller/tests/_tdd_keepalive.rs`에 `#[test] fn _k() {}` 한 줄을 깔아** 컨트롤러 crate src 편집을 unblock하고, implementer에겐 **명시 경로로만 `git add`**(절대 `-A` 금지)시킨다. **Task 1 커밋 직후 `rm crates/controller/tests/_tdd_keepalive.rs`**(커밋 안 됨). Task 2~8은 `insights.rs`/`report.rs`/`export.rs`가 이미 inline 테스트를 가져 자동 통과 → keepalive 불필요.
- **UI(Task 9)는 cargo 훅을 거치지만 UI 게이트는 수동**: 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build`를 반드시 따로 돌린다(`pnpm lint`는 `--max-warnings=0`).

## File Structure

- **Create** `crates/controller/src/insights.rs` — `Insight` 구조체 + `derive_insights`(순수) + `order_rank`/`collect_unconditional` 헬퍼 + inline `#[cfg(test)] mod tests`. 유일 책임: ReportJson 파생 인사이트 계산.
- **Modify** `crates/controller/src/lib.rs` — `pub mod insights;` 추가.
- **Modify** `crates/controller/src/report.rs` — `ReportJson`에 `#[serde(default)] pub insights: Vec<crate::insights::Insight>` + `build_report`에서 `derive_insights` 호출 + 리터럴에 `insights,`.
- **Modify** `crates/controller/src/export.rs` — 테스트 헬퍼 리터럴에 `insights: vec![]`(Task 1) + `report_to_xlsx`에 Insights 시트(Task 8).
- **Modify** `ui/src/api/schemas.ts` — `InsightSchema` + `ReportSchema.insights`.
- **Create** `ui/src/components/report/InsightPanel.tsx` — 순수 렌더러.
- **Create** `ui/src/components/report/__tests__/InsightPanel.test.tsx` — RTL.
- **Modify** `ui/src/components/report/ReportView.tsx` — `<InsightPanel>` 마운트.
- **Modify(문서, 별도 .md 커밋 가능)** `crates/controller/CLAUDE.md` — "build_report는 YAML walk 안 함" 불변식에 insights.rs 예외 추가(Task 1과 함께 또는 마지막에).

`api/runs.rs`는 **무변경**(`build_report_for_run` → `build_report`로 insights가 자동 전파, JSON/CSV/XLSX 라우트 그대로).

---

### Task 1: 백엔드 스캐폴드 + `slowest_step` 인사이트

**Files:**
- Create: `crates/controller/src/insights.rs`
- Modify: `crates/controller/src/lib.rs:10`
- Modify: `crates/controller/src/report.rs` (ReportJson 구조체 ~line 9-19, build_report literal ~line 331)
- Modify: `crates/controller/src/export.rs:341` (테스트 헬퍼 리터럴)

- [ ] **Step 1: keepalive 확인 (orchestrator)** — `crates/controller/tests/_tdd_keepalive.rs`가 깔려 있는지 확인(`#[test] fn _k() {}`). 없으면 생성.

- [ ] **Step 2: `insights.rs` 작성 (함수 + slowest_step + 정렬 + 빈/slowest 테스트)**

```rust
//! Deterministic, rule-based actionable insights derived from a built report.
//! Pure: backend computes structured insights; the UI renders the prose.
//! Spec: docs/superpowers/specs/2026-06-03-a4c-actionable-report-summary-design.md
use crate::report::{ReportStep, ReportSummary, ReportWindow, Verdict};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
// NOTE: `use handicap_engine::{Scenario, Step};` 와 `use std::collections::BTreeSet;`
// 는 Task 6(no_request_step)에서야 처음 쓰인다 — 여기 넣으면 Task 1~5 커밋이
// pre-commit `clippy --workspace -- -D warnings`(unused-imports)로 거부된다.
// 그 두 import는 Task 6 Step 3에서 함께 추가한다.

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Insight {
    pub kind: String,
    pub severity: String, // "critical" | "warning" | "info"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metric: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_seconds: Option<i64>,
}

impl Insight {
    fn new(kind: &str, severity: &str) -> Self {
        Insight {
            kind: kind.to_string(),
            severity: severity.to_string(),
            step_id: None,
            metric: None,
            value: None,
            pct: None,
            count: None,
            status_class: None,
            window_seconds: None,
        }
    }
}

/// Global emit order = the spec §5 table row index (already severity-sorted).
/// status_class is split: 5xx (critical) sorts with slo_failure, 4xx (warning)
/// with the warnings. Lower rank first.
fn order_rank(i: &Insight) -> u8 {
    match (i.kind.as_str(), i.status_class.as_deref()) {
        ("slo_failure", _) => 1,
        ("status_class", Some("5xx")) => 2,
        ("no_request_step", _) => 3,
        ("error_hotspot", _) => 4,
        ("status_class", Some("4xx")) => 5,
        ("status_temporal", _) => 6,
        ("slowest_step", _) => 7,
        ("slo_pass", _) => 8,
        _ => 99,
    }
}

pub fn derive_insights(
    summary: &ReportSummary,
    steps: &[ReportStep],
    windows: &[ReportWindow],
    status_distribution: &BTreeMap<String, u64>,
    verdict: Option<&Verdict>,
    scenario_yaml: &str,
) -> Vec<Insight> {
    let mut out: Vec<Insight> = Vec::new();

    // slowest_step: step with max p95 (first on tie — steps are sorted by step_id).
    let mut slowest: Option<&ReportStep> = None;
    for s in steps {
        if slowest.is_none_or(|cur| s.p95_ms > cur.p95_ms) {
            slowest = Some(s);
        }
    }
    if let Some(s) = slowest {
        let mut ins = Insight::new("slowest_step", "info");
        ins.step_id = Some(s.step_id.clone());
        ins.metric = Some("p95_ms".to_string());
        ins.value = Some(s.p95_ms as f64);
        out.push(ins);
    }

    let _ = (summary, windows, status_distribution, verdict, scenario_yaml); // wired in later tasks

    out.sort_by_key(order_rank);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::report::ReportStep;

    fn step(id: &str, p95: u64) -> ReportStep {
        ReportStep {
            step_id: id.to_string(),
            count: 1,
            error_count: 0,
            status_counts: BTreeMap::new(),
            p50_ms: 1,
            p95_ms: p95,
            p99_ms: p95,
            loop_breakdown: vec![],
        }
    }
    fn summary() -> ReportSummary {
        ReportSummary { count: 0, errors: 0, rps: 0.0, duration_seconds: 1, p50_ms: 0, p95_ms: 0, p99_ms: 0 }
    }

    #[test]
    fn empty_when_no_signal() {
        let got = derive_insights(&summary(), &[], &[], &BTreeMap::new(), None, "");
        assert!(got.is_empty());
    }

    #[test]
    fn slowest_step_picks_max_p95() {
        let steps = vec![step("a", 50), step("b", 120), step("c", 90)];
        let got = derive_insights(&summary(), &steps, &[], &BTreeMap::new(), None, "");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].kind, "slowest_step");
        assert_eq!(got[0].step_id.as_deref(), Some("b"));
        assert_eq!(got[0].value, Some(120.0));
    }
}
```

> `Option::is_none_or`은 Rust 1.82+ (MSRV 1.85 OK). 없으면 `slowest.map_or(true, |cur| ...)`로 대체.

- [ ] **Step 3: `lib.rs`에 모듈 등록** — `crates/controller/src/lib.rs:9`(`pub mod report;`) 바로 위/아래에 한 줄 추가(알파벳 순서상 `grpc` 다음):

```rust
pub mod insights;
```

- [ ] **Step 4: `ReportJson`에 `insights` 필드 추가** — `crates/controller/src/report.rs`의 `ReportJson`(현재 `verdict` 필드 아래, line ~17-18):

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<Verdict>,
    #[serde(default)]
    pub insights: Vec<crate::insights::Insight>,
```

> **F1(BLOCKER)**: `#[serde(default)]` 필수 — `testdata/compare_golden.json`엔 `insights` 키가 없고 `export.rs` 골든 테스트가 `ReportJson`으로 역직렬화한다. 빠지면 "missing field `insights`"로 RED. (`skip_serializing_if` 없이 항상 `[]` emit.)

- [ ] **Step 5: `build_report`에서 호출 + 리터럴에 추가** — `report.rs`의 `let verdict = match ...;`(line ~329) 다음, `ReportJson {` 리터럴 직전에 삽입. `summary`/`steps`/`windows`/`status_dist`/`verdict`는 아직 owned 상태라 **리터럴로 move되기 전에** 빌려 계산한다(`derive_insights`는 전부 `&`를 받음):

```rust
    let insights = crate::insights::derive_insights(
        &summary, &steps, &windows, &status_dist, verdict.as_ref(), scenario_yaml,
    );
```

> `status_dist`는 build_report의 변수명(리터럴에서 `status_distribution: status_dist`로 move). move 전에 `&status_dist`로 빌리면 borrow 충돌 없음.

그리고 `ReportJson { ... verdict, }` 리터럴의 `verdict,` 다음 줄에:

```rust
        verdict,
        insights,
    }
```

- [ ] **Step 6: `export.rs` 테스트 헬퍼 리터럴 수정 (F2)** — `crates/controller/src/export.rs`의 `report_with_steps`(line ~341) `ReportJson { ... verdict: None, }` 리터럴에 추가:

```rust
            verdict: None,
            insights: vec![],
        }
```

- [ ] **Step 7: 로컬 RED→GREEN + clippy 확인** (clippy 필수 — pre-commit이 `--workspace -- -D warnings`라 unused-import/unused-var를 커밋 시점에 거부; `cargo test`/`build`는 deny 안 함)

Run:
```
cargo test -p handicap-controller insights:: -- --nocapture
cargo clippy -p handicap-controller --all-targets -- -D warnings
```
Expected: `empty_when_no_signal`, `slowest_step_picks_max_p95` PASS. clippy 0 warning(미사용 import 없음 — Step 2 import가 전부 signature/test에서 사용됨).

- [ ] **Step 8: keepalive 제거 후 커밋 (orchestrator: foreground 단일 호출)**

```bash
rm -f crates/controller/tests/_tdd_keepalive.rs
git add crates/controller/src/insights.rs crates/controller/src/lib.rs \
        crates/controller/src/report.rs crates/controller/src/export.rs
git commit -m "feat(report): A4c insights scaffold + slowest_step (ReportJson.insights)"
git log -1 --oneline
```

Expected: pre-commit 전체 게이트 통과, 커밋 landed.

---

### Task 2: `slo_failure` / `slo_pass`

**Files:**
- Modify: `crates/controller/src/insights.rs` (`derive_insights` 본문 + tests)

- [ ] **Step 1: 실패 테스트 추가** (insights.rs `mod tests`에):

```rust
    fn verdict(passed: bool, fails: usize) -> Verdict {
        use crate::report::CriterionResult;
        let mut criteria = vec![];
        for i in 0..(fails + 1) {
            criteria.push(CriterionResult {
                metric: format!("m{i}"),
                direction: "max".to_string(),
                threshold: 1.0,
                actual: if i < fails { 2.0 } else { 0.0 },
                passed: i >= fails,
            });
        }
        Verdict { passed, criteria }
    }

    #[test]
    fn slo_failure_counts_failed_criteria() {
        let v = verdict(false, 2);
        let got = derive_insights(&summary(), &[], &[], &BTreeMap::new(), Some(&v), "");
        let f = got.iter().find(|i| i.kind == "slo_failure").expect("slo_failure");
        assert_eq!(f.severity, "critical");
        assert_eq!(f.count, Some(2));
    }

    #[test]
    fn slo_pass_when_passed() {
        let v = verdict(true, 0);
        let got = derive_insights(&summary(), &[], &[], &BTreeMap::new(), Some(&v), "");
        let p = got.iter().find(|i| i.kind == "slo_pass").expect("slo_pass");
        assert_eq!(p.severity, "info");
        assert!(got.iter().all(|i| i.kind != "slo_failure"));
    }
```

- [ ] **Step 2: 실패 확인** — Run: `cargo test -p handicap-controller insights::tests::slo_ ` → FAIL (slo_failure/slo_pass 없음).

- [ ] **Step 3: 구현** — `derive_insights`의 `let _ = (...)` 줄 위에, slowest_step push 다음에 추가(그리고 `let _ = (...)`에서 `verdict` 제거):

```rust
    // slo_failure / slo_pass
    if let Some(v) = verdict {
        if v.passed {
            out.push(Insight::new("slo_pass", "info"));
        } else {
            let failed = v.criteria.iter().filter(|c| !c.passed).count() as u64;
            let mut ins = Insight::new("slo_failure", "critical");
            ins.count = Some(failed);
            out.push(ins);
        }
    }
```

`let _ = (...)` 줄을 `let _ = (summary, windows, status_distribution, scenario_yaml);`로 갱신(verdict 제거).

- [ ] **Step 4: 통과 + clippy 확인** — Run: `cargo test -p handicap-controller insights::` → 모든 insights 테스트 PASS. 이어 `cargo clippy -p handicap-controller --all-targets -- -D warnings` → 0 warning(커밋 게이트 선제).

- [ ] **Step 5: 커밋** (foreground 단일):

```bash
git add crates/controller/src/insights.rs
git commit -m "feat(report): A4c slo_failure/slo_pass insights"
git log -1 --oneline
```

---

### Task 3: `error_hotspot`

**Files:**
- Modify: `crates/controller/src/insights.rs`

- [ ] **Step 1: 실패 테스트 추가**:

```rust
    fn step_err(id: &str, errors: u64) -> ReportStep {
        let mut s = step(id, 10);
        s.error_count = errors;
        s
    }

    #[test]
    fn error_hotspot_picks_top_error_share() {
        let steps = vec![step_err("a", 100), step_err("b", 900)];
        let mut s = summary();
        s.errors = 1000;
        let got = derive_insights(&s, &steps, &[], &BTreeMap::new(), None, "");
        let h = got.iter().find(|i| i.kind == "error_hotspot").expect("hotspot");
        assert_eq!(h.severity, "warning");
        assert_eq!(h.step_id.as_deref(), Some("b"));
        assert_eq!(h.count, Some(900));
        assert!((h.pct.unwrap() - 0.9).abs() < 1e-9);
    }

    #[test]
    fn no_error_hotspot_when_zero_errors() {
        let got = derive_insights(&summary(), &[step("a", 10)], &[], &BTreeMap::new(), None, "");
        assert!(got.iter().all(|i| i.kind != "error_hotspot"));
    }
```

- [ ] **Step 2: 실패 확인** — Run: `cargo test -p handicap-controller insights::tests::error_hotspot` / `::no_error_hotspot` → FAIL.

- [ ] **Step 3: 구현** (slo 블록 다음에):

```rust
    // error_hotspot: step holding the largest share of engine errors.
    // NOTE: error_count counts engine failures (failed assert / extract / transport),
    // NOT raw 4xx/5xx. Independent of status_class.
    if summary.errors > 0 {
        let mut top: Option<&ReportStep> = None;
        for s in steps {
            if s.error_count > 0 && top.is_none_or(|cur| s.error_count > cur.error_count) {
                top = Some(s);
            }
        }
        if let Some(s) = top {
            let mut ins = Insight::new("error_hotspot", "warning");
            ins.step_id = Some(s.step_id.clone());
            ins.pct = Some(s.error_count as f64 / summary.errors as f64);
            ins.count = Some(s.error_count);
            out.push(ins);
        }
    }
```

`let _ = (...)`에서 `summary` 제거 → `let _ = (windows, status_distribution, scenario_yaml);`.

- [ ] **Step 4: 통과 + clippy 확인** — Run: `cargo test -p handicap-controller insights::` → PASS. 이어 `cargo clippy -p handicap-controller --all-targets -- -D warnings` → 0 warning(커밋 게이트 선제).

- [ ] **Step 5: 커밋**:

```bash
git add crates/controller/src/insights.rs
git commit -m "feat(report): A4c error_hotspot insight"
git log -1 --oneline
```

---

### Task 4: `status_class` (4xx/5xx, status 0 분모 제외)

**Files:**
- Modify: `crates/controller/src/insights.rs`

- [ ] **Step 1: 실패 테스트 추가**:

```rust
    fn dist(pairs: &[(&str, u64)]) -> BTreeMap<String, u64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn status_class_emits_4xx_and_5xx() {
        let d = dist(&[("200", 800), ("404", 100), ("500", 100)]);
        let got = derive_insights(&summary(), &[], &[], &d, None, "");
        let five = got.iter().find(|i| i.kind == "status_class" && i.status_class.as_deref() == Some("5xx")).unwrap();
        assert_eq!(five.severity, "critical");
        assert_eq!(five.count, Some(100));
        assert!((five.pct.unwrap() - 0.1).abs() < 1e-9); // 100/1000
        let four = got.iter().find(|i| i.kind == "status_class" && i.status_class.as_deref() == Some("4xx")).unwrap();
        assert_eq!(four.severity, "warning");
    }

    #[test]
    fn status_class_excludes_status_0_from_denominator() {
        // 900 transport failures (status 0) + 100 real responses, 50 of them 5xx.
        let d = dist(&[("0", 900), ("200", 50), ("500", 50)]);
        let got = derive_insights(&summary(), &[], &[], &d, None, "");
        let five = got.iter().find(|i| i.status_class.as_deref() == Some("5xx")).unwrap();
        // pct over HTTP responses (100), not all attempts (1000): 50/100 = 0.5.
        assert!((five.pct.unwrap() - 0.5).abs() < 1e-9);
    }
```

- [ ] **Step 2: 실패 확인** — Run: `cargo test -p handicap-controller insights::tests::status_class` → FAIL.

- [ ] **Step 3: 구현** (error_hotspot 블록 다음에):

```rust
    // status_class: HTTP 4xx/5xx share. Denominator = HTTP responses only
    // (keys starting 1..5); the "0" transport-failure bucket is excluded from
    // both classification and denominator (engine failures are error_count's job).
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
            if class_count > 0 {
                let mut ins = Insight::new("status_class", sev);
                ins.status_class = Some(class.to_string());
                ins.pct = Some(class_count as f64 / total_http as f64);
                ins.count = Some(class_count);
                out.push(ins);
            }
        }
    }
```

`let _ = (...)`에서 `status_distribution` 제거 → `let _ = (windows, scenario_yaml);`.

- [ ] **Step 4: 통과 + clippy 확인** — Run: `cargo test -p handicap-controller insights::` → PASS. 이어 `cargo clippy -p handicap-controller --all-targets -- -D warnings` → 0 warning(커밋 게이트 선제).

- [ ] **Step 5: 커밋**:

```bash
git add crates/controller/src/insights.rs
git commit -m "feat(report): A4c status_class insight (4xx/5xx, status-0 excluded)"
git log -1 --oneline
```

---

### Task 5: `status_temporal` (후반부 5xx)

**Files:**
- Modify: `crates/controller/src/insights.rs`

- [ ] **Step 1: 실패 테스트 추가**:

```rust
    fn win(ts: i64, status: &[(&str, u64)]) -> ReportWindow {
        ReportWindow {
            ts_second: ts,
            step_id: "a".to_string(),
            count: 1,
            error_count: 0,
            status_counts: status.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
            p50_ms: 1,
            p95_ms: 1,
            p99_ms: 1,
        }
    }

    #[test]
    fn status_temporal_emits_when_5xx_is_late() {
        // run spans ts 0..10; 5xx first at ts 9 (> midpoint 5).
        let windows = vec![
            win(0, &[("200", 5)]),
            win(9, &[("500", 3)]),
            win(10, &[("500", 2)]),
        ];
        let got = derive_insights(&summary(), &[], &windows, &BTreeMap::new(), None, "");
        let t = got.iter().find(|i| i.kind == "status_temporal").expect("temporal");
        assert_eq!(t.severity, "warning");
        assert_eq!(t.status_class.as_deref(), Some("5xx"));
        assert_eq!(t.window_seconds, Some(2)); // 10 - 9 + 1
    }

    #[test]
    fn no_status_temporal_when_5xx_early() {
        let windows = vec![win(0, &[("500", 5)]), win(10, &[("200", 5)])];
        let got = derive_insights(&summary(), &[], &windows, &BTreeMap::new(), None, "");
        assert!(got.iter().all(|i| i.kind != "status_temporal"));
    }

    #[test]
    fn no_status_temporal_single_second() {
        let windows = vec![win(7, &[("500", 5)])]; // max_ts == min_ts
        let got = derive_insights(&summary(), &[], &windows, &BTreeMap::new(), None, "");
        assert!(got.iter().all(|i| i.kind != "status_temporal"));
    }
```

- [ ] **Step 2: 실패 확인** — Run: `cargo test -p handicap-controller insights::tests::status_temporal insights::tests::no_status_temporal` → FAIL.

- [ ] **Step 3: 구현** (status_class 블록 다음에):

```rust
    // status_temporal: 5xx that appears late. Interval = [min_ts, max_ts] over
    // windows that actually have data. Emit only when the first 5xx second is
    // strictly past the midpoint (early 5xx is already covered by status_class).
    {
        let mut sec_5xx: BTreeMap<i64, u64> = BTreeMap::new();
        let mut min_ts = i64::MAX;
        let mut max_ts = i64::MIN;
        for w in windows {
            min_ts = min_ts.min(w.ts_second);
            max_ts = max_ts.max(w.ts_second);
            let c: u64 = w
                .status_counts
                .iter()
                .filter(|(k, _)| k.starts_with('5'))
                .map(|(_, v)| *v)
                .sum();
            if c > 0 {
                *sec_5xx.entry(w.ts_second).or_insert(0) += c;
            }
        }
        if !sec_5xx.is_empty() && max_ts > min_ts {
            let t_first = *sec_5xx.keys().next().expect("non-empty");
            let midpoint = min_ts as f64 + (max_ts - min_ts) as f64 / 2.0;
            if (t_first as f64) > midpoint {
                let mut ins = Insight::new("status_temporal", "warning");
                ins.status_class = Some("5xx".to_string());
                ins.window_seconds = Some(max_ts - t_first + 1);
                out.push(ins);
            }
        }
    }
```

`let _ = (...)` 줄 제거(`windows` 사용됨; `scenario_yaml`은 Task 6에서 사용 — `let _ = scenario_yaml;`만 남김).

- [ ] **Step 4: 통과 + clippy 확인** — Run: `cargo test -p handicap-controller insights::` → PASS. 이어 `cargo clippy -p handicap-controller --all-targets -- -D warnings` → 0 warning(커밋 게이트 선제).

- [ ] **Step 5: 커밋**:

```bash
git add crates/controller/src/insights.rs
git commit -m "feat(report): A4c status_temporal insight (late 5xx)"
git log -1 --oneline
```

---

### Task 6: `no_request_step` (시나리오 walk, fail-soft)

**Files:**
- Modify: `crates/controller/src/insights.rs`

- [ ] **Step 1: 실패 테스트 추가**. ULID는 Crockford(`I/L/O/U` 금지) 주의 — 여기선 http step id를 평이한 문자열로 쓰는 시나리오 YAML을 인라인 작성:

```rust
    const YAML_TOP_AND_IF: &str = r#"
version: 1
name: t
steps:
  - type: http
    id: top1
    name: top1
    request: { method: GET, url: "http://x/1" }
  - type: http
    id: top2
    name: top2
    request: { method: GET, url: "http://x/2" }
  - type: if
    id: if1
    name: if1
    cond: { left: "a", op: eq, right: "b" }
    then:
      - type: http
        id: only_in_then
        name: only_in_then
        request: { method: GET, url: "http://x/3" }
"#;

    #[test]
    fn no_request_step_flags_unconditional_only() {
        // metrics recorded for top1 only → top2 missing (unconditional → flagged),
        // only_in_then missing (inside if branch → NOT flagged).
        let steps = vec![step("top1", 10)];
        let got = derive_insights(&summary(), &steps, &[], &BTreeMap::new(), None, YAML_TOP_AND_IF);
        let flagged: Vec<&str> = got
            .iter()
            .filter(|i| i.kind == "no_request_step")
            .map(|i| i.step_id.as_deref().unwrap())
            .collect();
        assert_eq!(flagged, vec!["top2"]);
    }

    #[test]
    fn no_request_step_skipped_on_unparseable_yaml() {
        // empty yaml errors → no_request_step silently skipped (other insights survive).
        let got = derive_insights(&summary(), &[step("a", 10)], &[], &BTreeMap::new(), None, "");
        assert!(got.iter().all(|i| i.kind != "no_request_step"));
        assert!(got.iter().any(|i| i.kind == "slowest_step")); // still computed
    }

    #[test]
    fn no_data_run_flags_unconditional_steps() {
        // spec §5 edge: 0 requests recorded, no verdict → top-level steps all flagged,
        // and no slowest_step (no metrics).
        let got = derive_insights(&summary(), &[], &[], &BTreeMap::new(), None, YAML_TOP_AND_IF);
        let flagged: Vec<&str> = got
            .iter()
            .filter(|i| i.kind == "no_request_step")
            .map(|i| i.step_id.as_deref().unwrap())
            .collect();
        assert_eq!(flagged, vec!["top1", "top2"]); // only_in_then excluded (if branch)
        assert!(got.iter().all(|i| i.kind != "slowest_step"));
    }
```

> loop 본문(무조건, repeat≥1)은 flagged, if 분기는 not — 위 테스트는 if-제외를 검증한다. loop 케이스를 더 굳히려면 별도 YAML로 한 테스트 추가 가능(optional).

- [ ] **Step 2: 실패 확인** — Run: `cargo test -p handicap-controller insights::tests::no_request_step` → FAIL.

- [ ] **Step 3: import 추가 + 구현** — 먼저 `insights.rs` 상단 import에 **Task 1에서 미뤄둔 두 줄을 추가**(여기서 처음 쓰여 unused-import 안 됨):

```rust
use handicap_engine::{Scenario, Step};
use std::collections::BTreeSet;
```

그다음 `derive_insights` 본문 끝(`out.sort_by_key` 직전)에 추가하고, 파일 하단(`#[cfg(test)]` 위)에 헬퍼 함수 추가:

```rust
    // no_request_step: unconditionally-reached http steps that recorded nothing.
    // Fail-soft: empty/invalid scenario_yaml just skips this kind.
    if let Ok(sc) = Scenario::from_yaml(scenario_yaml) {
        let present: BTreeSet<&str> = steps.iter().map(|s| s.step_id.as_str()).collect();
        let mut expected: Vec<String> = Vec::new();
        collect_unconditional(&sc.steps, false, &mut expected);
        expected.sort();
        expected.dedup();
        for id in expected {
            if !present.contains(id.as_str()) {
                let mut ins = Insight::new("no_request_step", "warning");
                ins.step_id = Some(id);
                out.push(ins);
            }
        }
    }
```

헬퍼(파일 하단, `derive_insights` 밖):

```rust
/// Collect ids of http steps that ALWAYS run: top-level + loop bodies (repeat>=1).
/// if/elif/else branch steps are excluded — 0 requests there is expected (branch
/// not taken), not a defect.
fn collect_unconditional(steps: &[Step], conditional: bool, out: &mut Vec<String>) {
    for s in steps {
        match s {
            Step::Http(h) => {
                if !conditional {
                    out.push(h.id.clone());
                }
            }
            Step::Loop(l) => {
                let cond = conditional || l.repeat == 0;
                collect_unconditional(&l.do_, cond, out);
            }
            Step::If(i) => {
                collect_unconditional(&i.then_, true, out);
                for e in &i.elif {
                    collect_unconditional(&e.then_, true, out);
                }
                collect_unconditional(&i.else_, true, out);
            }
        }
    }
}
```

`let _ = scenario_yaml;`(Task 5에서 남긴 줄)을 **삭제**(빈 `let _ = ();`로 만들지 말 것 — `clippy::let_unit_value` 발동) — 이제 `scenario_yaml`이 사용됨.

- [ ] **Step 4: 통과 + clippy 확인** — Run: `cargo test -p handicap-controller insights::` → PASS. 이어 `cargo clippy -p handicap-controller --all-targets -- -D warnings` → 0 warning(커밋 게이트 선제, 미사용 import 0).

- [ ] **Step 5: 커밋**:

```bash
git add crates/controller/src/insights.rs
git commit -m "feat(report): A4c no_request_step insight (unconditional steps, fail-soft)"
git log -1 --oneline
```

---

### Task 7: 정렬·capability 교차 테스트

**Files:**
- Modify: `crates/controller/src/insights.rs` (tests only)

- [ ] **Step 1: 교차 테스트 추가**:

```rust
    #[test]
    fn insights_deterministic_order() {
        // all kinds present → assert the interleaved (severity,row) order.
        let steps = vec![step_err("a", 50)];
        let mut s = summary();
        s.errors = 50;
        let d = dist(&[("200", 100), ("404", 20), ("500", 30)]);
        let windows = vec![win(0, &[("200", 1)]), win(9, &[("500", 1)])];
        let v = verdict(false, 1);
        let got = derive_insights(&s, &steps, &windows, &d, Some(&v), "");
        let order: Vec<(&str, Option<&str>)> =
            got.iter().map(|i| (i.kind.as_str(), i.status_class.as_deref())).collect();
        assert_eq!(
            order,
            vec![
                ("slo_failure", None),
                ("status_class", Some("5xx")),
                ("error_hotspot", None),
                ("status_class", Some("4xx")),
                ("status_temporal", Some("5xx")),
                ("slowest_step", None),
            ]
        );
    }

    #[test]
    fn error_heavy_run_yields_at_least_three() {
        // capability check: errors via failing asserts (error_count), 5xx, slow step.
        let steps = vec![step_err("a", 200)];
        let mut s = summary();
        s.errors = 200;
        let d = dist(&[("200", 800), ("500", 200)]);
        let got = derive_insights(&s, &steps, &[], &d, None, "");
        assert!(got.len() >= 3, "error-heavy run should surface >=3 insights, got {}", got.len());
    }

    #[test]
    fn all_pass_run_has_slowest_and_slo_pass() {
        // spec §5 edge: clean run (no errors/4xx/5xx) + passing verdict → exactly
        // slowest_step + slo_pass, NOT padded to 3.
        let steps = vec![step("a", 80)];
        let v = verdict(true, 0);
        let got = derive_insights(&summary(), &steps, &[], &BTreeMap::new(), Some(&v), "");
        let kinds: Vec<&str> = got.iter().map(|i| i.kind.as_str()).collect();
        assert_eq!(kinds, vec!["slowest_step", "slo_pass"]); // order_rank 7 then 8
    }
```

- [ ] **Step 2: 실패→통과 + clippy 확인** — Run: `cargo test -p handicap-controller insights::` → PASS (정렬/capability/all-pass 모두 만족; 실패 시 order_rank/누락 점검). 이어 `cargo clippy -p handicap-controller --all-targets -- -D warnings` → 0 warning.

- [ ] **Step 3: 커밋**:

```bash
git add crates/controller/src/insights.rs
git commit -m "test(report): A4c insight order + error-heavy capability (>=3)"
git log -1 --oneline
```

---

### Task 8: XLSX Insights 시트

**Files:**
- Modify: `crates/controller/src/export.rs` (`report_to_xlsx` + tests)

- [ ] **Step 1: 실패 테스트 추가** (export.rs `mod tests` 끝에):

```rust
    #[test]
    fn xlsx_has_insights_sheet() {
        use calamine::{Data, Reader, Xlsx, open_workbook_from_rs};
        use std::io::Cursor;
        let mut r = report_with_steps(vec![step("a", 10, 50)]);
        r.insights = vec![crate::insights::Insight {
            kind: "slowest_step".into(),
            severity: "info".into(),
            step_id: Some("a".into()),
            metric: Some("p95_ms".into()),
            value: Some(50.0),
            pct: None,
            count: None,
            status_class: None,
            window_seconds: None,
        }];
        let bytes = report_to_xlsx(&r);
        let mut wb: Xlsx<Cursor<Vec<u8>>> = open_workbook_from_rs(Cursor::new(bytes)).unwrap();
        let ws = wb.worksheet_range("Insights").expect("Insights sheet");
        assert_eq!(ws.get_value((0, 0)), Some(&Data::String("kind".into())));
        assert_eq!(ws.get_value((1, 0)), Some(&Data::String("slowest_step".into())));
        assert_eq!(ws.get_value((1, 4)), Some(&Data::Float(50.0)));
    }
```

> `crate::insights::Insight`의 필드가 전부 `pub`이라 테스트에서 리터럴 구성 가능. `report_with_steps`는 Task 1에서 `insights: vec![]`로 초기화됨.

- [ ] **Step 2: 실패 확인** — Run: `cargo test -p handicap-controller xlsx_has_insights_sheet` → FAIL ("Insights sheet" 없음).

- [ ] **Step 3: 구현** — `report_to_xlsx`의 `// --- Branches sheet ---` 블록(`export.rs:300-316`) 다음, `wb.save_to_buffer()` 직전에:

```rust
    // --- Insights sheet (only if present) ---
    if !report.insights.is_empty() {
        let ws = wb.add_worksheet();
        ws.set_name("Insights").expect("sheet name");
        for (c, h) in [
            "kind",
            "severity",
            "step_id",
            "metric",
            "value",
            "pct",
            "count",
            "status_class",
            "window_seconds",
        ]
        .iter()
        .enumerate()
        {
            ws.write_string(0, c as u16, *h).expect("w");
        }
        for (i, ins) in report.insights.iter().enumerate() {
            let r = (i + 1) as u32;
            ws.write_string(r, 0, &ins.kind).expect("w");
            ws.write_string(r, 1, &ins.severity).expect("w");
            if let Some(v) = &ins.step_id {
                ws.write_string(r, 2, v).expect("w");
            }
            if let Some(v) = &ins.metric {
                ws.write_string(r, 3, v).expect("w");
            }
            if let Some(v) = ins.value {
                ws.write_number(r, 4, v).expect("w");
            }
            if let Some(v) = ins.pct {
                ws.write_number(r, 5, v).expect("w");
            }
            if let Some(v) = ins.count {
                ws.write_number(r, 6, v as f64).expect("w");
            }
            if let Some(v) = &ins.status_class {
                ws.write_string(r, 7, v).expect("w");
            }
            if let Some(v) = ins.window_seconds {
                ws.write_number(r, 8, v as f64).expect("w");
            }
        }
    }
```

- [ ] **Step 4: 통과 + clippy 확인** — Run: `cargo test -p handicap-controller export::` → PASS(`xlsx_has_insights_sheet` 포함, 기존 export 테스트 무회귀). 이어 `cargo clippy -p handicap-controller --all-targets -- -D warnings` → 0 warning.

- [ ] **Step 5: 커밋**:

```bash
git add crates/controller/src/export.rs
git commit -m "feat(export): A4c Insights sheet in single-run XLSX"
git log -1 --oneline
```

---

### Task 9: UI — Zod 스키마 + InsightPanel + ReportView 배선

**Files:**
- Modify: `ui/src/api/schemas.ts`
- Create: `ui/src/components/report/InsightPanel.tsx`
- Create: `ui/src/components/report/__tests__/InsightPanel.test.tsx`
- Modify: `ui/src/components/report/ReportView.tsx`

- [ ] **Step 1: Zod 스키마 추가** — `schemas.ts`의 `VerdictSchema`/`export type Verdict` 다음에:

```ts
export const InsightSchema = z.object({
  kind: z.string(),
  severity: z.enum(["critical", "warning", "info"]),
  step_id: z.string().optional(),
  metric: z.string().optional(),
  value: z.number().optional(),
  pct: z.number().optional(),
  count: z.number().int().nonnegative().optional(),
  status_class: z.string().optional(),
  window_seconds: z.number().int().optional(),
});
export type Insight = z.infer<typeof InsightSchema>;
```

그리고 `ReportSchema`의 `.strict()` 객체 안 `verdict: VerdictSchema.nullish(),` 다음 줄에 추가(F3 — strict 객체라 반드시 키 등록):

```ts
    verdict: VerdictSchema.nullish(),
    insights: z.array(InsightSchema).optional(),
```

- [ ] **Step 2: `InsightPanel.tsx` 작성**:

```tsx
import type { Insight } from "../../api/schemas";

type StepMeta = { id: string; name: string; method: string; url: string };
type Props = { insights: Insight[]; meta: Map<string, StepMeta> };

const SEV_CLASS: Record<string, string> = {
  critical: "border-red-300 bg-red-50 text-red-800",
  warning: "border-amber-300 bg-amber-50 text-amber-800",
  info: "border-slate-300 bg-slate-50 text-slate-700",
};

function pctStr(v: number | undefined): string {
  return v === undefined ? "" : `${(v * 100).toFixed(1)}%`;
}

function message(i: Insight, meta: Map<string, StepMeta>): string {
  const name = (id?: string) => (id ? (meta.get(id)?.name ?? id) : "");
  // Pin locale so comma grouping is deterministic regardless of CI ICU build
  // (RTL asserts "1,203건" / "1,240ms").
  const n = (v: number | undefined) => (v ?? 0).toLocaleString("en-US");
  switch (i.kind) {
    case "slo_failure":
      return `SLO 실패: ${i.count ?? 0}개 기준 미달`;
    case "slo_pass":
      return "모든 SLO 기준 통과";
    case "status_class":
      return `${i.status_class}가 응답의 ${pctStr(i.pct)} (${n(i.count)}건)`;
    case "status_temporal":
      return `5xx가 마지막 ${i.window_seconds ?? 0}초에 처음 등장`;
    case "no_request_step":
      return `스텝 ${name(i.step_id)}에 요청이 기록되지 않음`;
    case "error_hotspot":
      return `스텝 ${name(i.step_id)}이(가) 에러의 ${pctStr(i.pct)} (${n(i.count)}건)`;
    case "slowest_step":
      return `스텝 ${name(i.step_id)}이(가) p95 ${n(i.value)}ms로 가장 느림`;
    default:
      return i.kind;
  }
}

export function InsightPanel({ insights, meta }: Props) {
  if (insights.length === 0) return null;
  return (
    <section aria-label="Insights" className="mb-6">
      <h3 className="text-lg font-semibold mb-2">핵심 인사이트</h3>
      <ul className="space-y-1">
        {insights.map((i, idx) => (
          <li
            key={`${i.kind}-${i.step_id ?? i.status_class ?? idx}`}
            data-testid="insight"
            className={[
              "rounded border px-3 py-1.5 text-sm",
              SEV_CLASS[i.severity] ?? SEV_CLASS.info,
            ].join(" ")}
          >
            {message(i, meta)}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 3: RTL 테스트 작성** — `ui/src/components/report/__tests__/InsightPanel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { InsightPanel } from "../InsightPanel";
import type { Insight } from "../../../api/schemas";

const meta = new Map([["s1", { id: "s1", name: "checkout", method: "GET", url: "/c" }]]);

describe("InsightPanel", () => {
  it("renders nothing when empty", () => {
    const { container } = render(<InsightPanel insights={[]} meta={new Map()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a message per kind, resolving step name from meta", () => {
    const insights: Insight[] = [
      { kind: "slo_failure", severity: "critical", count: 2 },
      { kind: "status_class", severity: "critical", status_class: "5xx", pct: 0.12, count: 1203 },
      { kind: "slowest_step", severity: "info", step_id: "s1", metric: "p95_ms", value: 1240 },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/SLO 실패: 2개 기준 미달/)).toBeInTheDocument();
    expect(screen.getByText(/5xx가 응답의 12\.0% \(1,203건\)/)).toBeInTheDocument();
    expect(screen.getByText(/checkout.*p95 1,240ms로 가장 느림/)).toBeInTheDocument();
  });

  it("preserves backend order", () => {
    const insights: Insight[] = [
      { kind: "slo_failure", severity: "critical", count: 1 },
      { kind: "slowest_step", severity: "info", step_id: "s1", value: 10 },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    const items = screen.getAllByTestId("insight").map((e) => e.textContent);
    expect(items[0]).toMatch(/SLO 실패/);
    expect(items[1]).toMatch(/가장 느림/);
  });
});
```

- [ ] **Step 4: `ReportView.tsx` 배선** — import 추가 + 패널 마운트. `import { VerdictPanel } from "./VerdictPanel";` 아래에:

```tsx
import { InsightPanel } from "./InsightPanel";
```

그리고 `{report.verdict ? <VerdictPanel verdict={report.verdict} /> : null}`(line ~126) **바로 위**에:

```tsx
      <InsightPanel insights={report.insights ?? []} meta={stepMeta} />
      {report.verdict ? <VerdictPanel verdict={report.verdict} /> : null}
```

- [ ] **Step 5: UI 게이트 (수동, 필수)**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0 warning, vitest PASS(InsightPanel 3 tests + 기존), `tsc -b` clean.

- [ ] **Step 6: 커밋** (cargo 훅도 돌지만 변경은 UI뿐 — foreground 단일):

```bash
git add ui/src/api/schemas.ts ui/src/components/report/InsightPanel.tsx \
        ui/src/components/report/__tests__/InsightPanel.test.tsx \
        ui/src/components/report/ReportView.tsx
git commit -m "feat(ui): A4c InsightPanel at top of report + Insight Zod schema"
git log -1 --oneline
```

---

### Task 10: CLAUDE.md 함정 노트 갱신 (docs, 별도 .md 커밋)

**Files:**
- Modify: `crates/controller/CLAUDE.md`

- [ ] **Step 1: 불변식 예외 추가** — `crates/controller/CLAUDE.md`의 "리포트 step 라벨링은 controller가 아니라 UI" 항목(build_report가 YAML walk 안 한다는 노트) 뒤에 한 줄 추가:

```markdown
- **예외: `insights.rs`(A4c)는 `build_report` 경로에서 `Scenario::from_yaml`을 호출한다** — `no_request_step` 인사이트가 "기대 http 스텝 목록"을 알아야 해서. **fail-soft**(`if let Ok(sc) = ...`, 빈/잘못된 YAML이면 그 인사이트만 skip, report shape 무변경)이고 격리돼 있다. 새 `Step` 종류를 추가하면 `collect_unconditional`(insights.rs)의 walk도 갱신.
```

- [ ] **Step 2: 커밋** (md-only → cargo 게이트 skip):

```bash
git add crates/controller/CLAUDE.md
git commit -m "docs: note insights.rs exception to build_report no-YAML-walk invariant"
git log -1 --oneline
```

---

## Self-Review 체크 (작성자 수행)

- **Spec coverage**: §4 모델→Task1, §5 6종 인사이트→Task1-6, §5 정렬→Task1(order_rank)+Task7, §6 렌더→Task9, §7 XLSX→Task8, §8 테스트→각 task inline+Task9 RTL, §10 영향영역(F1/F2/F3)→Task1+Task9, R1/M4(insights.rs/fail-soft)→Task6+Task10. 누락 없음.
- **CSV/compare export 무변경**: 의도대로 Task에 없음(spec §2 OUT).
- **Type 일관성**: Rust `Insight`(kind/severity/step_id/metric/value/pct/count/status_class/window_seconds) ↔ TS `InsightSchema` 1:1, `derive_insights` 6-arg 시그니처가 Task1-6 내내 동일, `order_rank` 키가 Task별 추가 kind와 정합.
- **Placeholder 없음**: 모든 Step에 실제 코드/명령/기대출력.
```

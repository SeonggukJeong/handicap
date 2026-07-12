# open-loop-slot-sizing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** open-loop 슬롯 사이징·포화 인사이트를 "요청당 평균 지연" 기반에서 **반복 점유시간(실측)** 기반으로 교정하고, cause 귀속을 2-way(slots/sut)로 재설계한다 (spec `docs/superpowers/specs/2026-07-12-open-loop-slot-sizing-design.md`, ADR-0046).

**Architecture:** 서버(`insights.rs`)는 포화 중 항등식 `hold = max_in_flight ÷ 달성 도착률`로 점유시간을 자기측정해 `recommended = ceil(target × hold)`를 산출하고, 달성/목표 도착률을 신규 Insight 필드 2개로 UI에 내려준다. UI 헬퍼는 prior 포화 run에서 hold를 복원(ⓐ)하거나 per-step p50 walk(ⓑ)·수동(ⓒ)·test-run 실측(ⓓ)으로 hold를 얻어 같은 공식을 적용한다. 엔진/proto/migration 0-diff.

**Tech Stack:** Rust(controller — insights/report/export) + TypeScript/React(sizing.ts·SlotSizingHelper·WorkerSizingHelper·InsightPanel·ko.ts) + vitest/RTL + cargo nextest.

## Global Constraints

- **spec R-id가 정규** — 각 task 머리의 "충족 R"이 추적 키. spec: `docs/superpowers/specs/2026-07-12-open-loop-slot-sizing-design.md`.
- **엔진(`crates/engine`)·proto·migration·`ui/src/components/openLoopChecks.ts`·`validate_run_config` 절대 무변경** (R11).
- **Insight 와이어**: 신규 필드는 `onset_second` **뒤** append(선언순=INSIGHT_COLUMNS 순 계약, `export.rs:86-88`), serde `skip_serializing_if = "Option::is_none"`, UI Zod `.optional()`(B7-C: skip→absent→optional — `.nullish()` 금지).
- **`recommended_workers`는 필드 유지·모든 경로 None** (R4 — 와이어/export 호환).
- **한국어 문구는 전부 `ko.ts` 경유**(ADR-0035), 변수 뒤 조사는 `(으)로` 병기형, "무엇을 얼마로 바꿔라"를 수치와 함께 명시(전문가/초보자 공용 — 사용자 요구 2026-07-12).
- **UI 게이트**: 각 UI task 끝에 `cd ui && pnpm lint && pnpm test && pnpm build` (lint는 `--max-warnings=0`, build가 최종 타입 게이트). **cargo task 끝에 `cargo build --workspace && cargo clippy --workspace -- -D warnings && cargo nextest run`**.
- 커밋은 각 task 끝 단일 FOREGROUND 호출(`run_in_background` 금지, timeout 600000ms), `git commit … | tail` 파이프 금지, `--no-verify` 금지.
- 리포트 파일(.md)은 워크트리 루트에 쓰지 말 것 — `.superpowers/sdd/` 사용, `git add`는 명시 경로만.

---

### Task 1: 와이어 계약 — Insight 신규 필드 2개 + export 15열 + UI Zod (충족 R: R5)

**Files:**
- Modify: `crates/controller/src/insights.rs` (Insight struct ~L20-63, `Insight::new` ~L44-63)
- Modify: `crates/controller/src/export.rs` (INSIGHT_COLUMNS ~L89-103, `insight_csv_cells` ~L106-125, `write_insight_xlsx_row` ~L128-170)
- Modify: `ui/src/api/schemas.ts` (`InsightSchema` ~L374-389)
- Test: `crates/controller/src/insights.rs` 인라인 + `crates/controller/src/export.rs` 인라인

**Interfaces:**
- Produces: `Insight.achieved_per_sec: Option<f64>`, `Insight.target_per_sec: Option<f64>` (Task 2가 채우고 Task 4·5가 소비), UI `Insight` 타입에 동명 optional 필드.

- [ ] **Step 1: Insight struct에 필드 2개 + new() 초기화 (RED 유도용 테스트 먼저)**

`crates/controller/src/insights.rs`의 인라인 `mod tests` 끝에 실패 테스트 추가:

```rust
    #[test]
    fn insight_new_fields_serialize_when_some_and_omit_when_none() {
        let mut ins = Insight::new("load_gen_saturated", "warning");
        let none_json = serde_json::to_value(&ins).unwrap();
        assert!(none_json.get("achieved_per_sec").is_none(), "None → 키 생략");
        assert!(none_json.get("target_per_sec").is_none());
        ins.achieved_per_sec = Some(2.5);
        ins.target_per_sec = Some(20.0);
        let some_json = serde_json::to_value(&ins).unwrap();
        assert_eq!(some_json["achieved_per_sec"], 2.5);
        assert_eq!(some_json["target_per_sec"], 20.0);
    }
```

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-controller insight_new_fields` → 컴파일 에러(필드 없음).

- [ ] **Step 3: struct·new() 구현**

`onset_second` 필드 선언 **바로 뒤**(struct 마지막)에:

```rust
    /// 달성 도착률(반복/초) — open-loop 포화 인사이트에서 계산 가능할 때만 Some. (ADR-0046 R5)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub achieved_per_sec: Option<f64>,
    /// 목표 도착률(반복/초, 곡선이면 peak) — 위와 동일 조건. (ADR-0046 R5)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_per_sec: Option<f64>,
```

`Insight::new`의 리터럴 끝(`onset_second: None,` 뒤)에 `achieved_per_sec: None,`·`target_per_sec: None,` 추가.

- [ ] **Step 4: export 4표면 — INSIGHT_COLUMNS 15열 + 두 행-writer**

`INSIGHT_COLUMNS`를 `[&str; 15]`로, 배열 끝에 `"achieved_per_sec", "target_per_sec"` append. 주석의 "이 13열은" → "이 15열은". `insight_csv_cells`의 vec 끝에 `f(ins.achieved_per_sec), f(ins.target_per_sec),` 추가(주석 "13개"→"15개"). `write_insight_xlsx_row` 끝에:

```rust
    if let Some(v) = ins.achieved_per_sec {
        ws.write_number(row, c(13), v).expect("w");
    }
    if let Some(v) = ins.target_per_sec {
        ws.write_number(row, c(14), v).expect("w");
    }
```

(주석 "13개 타입별 셀"→"15개".)

- [ ] **Step 5: UI Zod** — `ui/src/api/schemas.ts`의 `InsightSchema`에서 `onset_second` 줄 뒤에:

```ts
  achieved_per_sec: z.number().optional(),
  target_per_sec: z.number().optional(),
```

- [ ] **Step 5b: export.rs Insight exhaustive 리터럴 3곳 갱신** — `crate::insights::Insight { … }` 전체-필드 리터럴(export.rs 683·701·920행 부근 — 984/989/1027의 `..insight()` spread는 무접촉)이 필드 2개 추가로 컴파일 실패한다. 683·920은 `achieved_per_sec: None, target_per_sec: None,` 추가. **701의 합성 행은 기존 주석 의도("모든 열 writer 운동")대로 `achieved_per_sec: Some(2.5), target_per_sec: Some(20.0),`로 채우고 그 테스트의 CSV/XLSX 셀 기대값(구 13셀 가정)을 15셀로 갱신**(repo exhaustive-literal 함정 클래스).

- [ ] **Step 6: GREEN 확인** — `cargo test -p handicap-controller insight_new_fields` PASS, `cargo test -p handicap-controller insight_columns_are_single_source` PASS(헤더≡const 자동), `cargo build --workspace && cargo clippy --workspace -- -D warnings && cargo nextest run` 전부 green, `cd ui && pnpm lint && pnpm test && pnpm build` green.

- [ ] **Step 7: Commit**

```bash
git add crates/controller/src/insights.rs crates/controller/src/export.rs ui/src/api/schemas.ts
git commit -m "feat(controller,ui): Insight에 achieved/target_per_sec 필드 additive — 와이어 계약 (R5)"
```

---

### Task 2: 서버 공식 — 실측 점유시간 required + cause 2-way + fallback (충족 R: R1, R2, R3, R4, R13)

**Files:**
- Modify: `crates/controller/src/insights.rs` (dropped 블록 L213-271 재작성 + `scheduled_arrivals` 신규 + 시그니처 10번째 인자 교체 + 인라인 테스트 전면 갱신)
- Modify: `crates/controller/src/report.rs` (derive_insights 호출부 L767-783 + `build_report_sizing_*` 테스트 2건)

**Interfaces:**
- Consumes: Task 1의 두 필드.
- Produces: `pub(crate) fn scheduled_arrivals(target_rps: Option<u32>, stages: Option<&[handicap_engine::Stage]>, duration_actual: f64) -> Option<f64>`; `derive_insights` 10번째 인자가 `worker_count_current: u32` → `scheduled_arrivals: Option<f64>`로 **교체**(인자 수 10 유지).

- [ ] **Step 1: 신규 산식 실패 테스트 작성** — insights.rs `mod tests`에 (기존 헬퍼 `summary()`/`dist()` 등 재사용, 파일 상단 테스트 헬퍼 시그니처 확인 후 맞출 것):

```rust
    #[test]
    fn scheduled_arrivals_fixed_curve_and_truncated() {
        use handicap_engine::Stage;
        // 고정: target × duration
        assert_eq!(scheduled_arrivals(Some(20), None, 15.0), Some(300.0));
        // 곡선(spec §4.1 fixture): 0→10 램프 10s(사다리꼴 50) + 10 유지 10s(100) = 150
        let stages = vec![
            Stage { target: 10, duration_seconds: 10 },
            Stage { target: 10, duration_seconds: 10 },
        ];
        assert_eq!(scheduled_arrivals(None, Some(&stages), 20.0), Some(150.0));
        // 절단: 15s에서 끊으면 50 + 10×5 = 100
        assert_eq!(scheduled_arrivals(None, Some(&stages), 15.0), Some(100.0));
        // open-loop 아님 → None
        assert_eq!(scheduled_arrivals(None, None, 15.0), None);
    }

    #[test]
    fn saturated_slots_uses_measured_hold() {
        // spec R1 fixture (라이브 Run C 재현): target 20·M 3·dropped 260·15s
        // scheduled 300 → achieved (300-260)/15 = 2.667/s → ceil(20×3/2.667) = 23
        let mut s = summary();
        s.duration_seconds = 15;
        let got = derive_insights(
            &s, &[], &[], &BTreeMap::new(), None, "", 260,
            Some(3), Some(20), Some(300.0),
        );
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.cause.as_deref(), Some("slots"));
        assert_eq!(ins.recommended, Some(23.0));
        assert_eq!(ins.target_per_sec, Some(20.0));
        let a = ins.achieved_per_sec.unwrap();
        assert!((a - 40.0 / 15.0).abs() < 1e-9, "achieved={a}");
        assert_eq!(ins.recommended_workers, None);
    }

    #[test]
    fn sut_takes_priority_over_slots() {
        // sut_stress(5xx≥1%)면 achieved와 무관하게 cause=sut·recommended None (R3·R13 우선순위)
        let mut s = summary();
        s.duration_seconds = 15;
        let d = dist(&[("200", 80), ("500", 20)]); // 5xx 20% ≥ 1%
        let got = derive_insights(&s, &[], &[], &d, None, "", 260, Some(3), Some(20), Some(300.0));
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.cause.as_deref(), Some("sut"));
        assert_eq!(ins.recommended, None);
        assert_eq!(ins.target_per_sec, Some(20.0)); // 필드는 sut arm에도 실림
        assert!(ins.achieved_per_sec.is_some());
        assert_eq!(ins.recommended_workers, None);
    }

    #[test]
    fn saturated_clamps_recommended_when_achieved_zero() {
        // dropped ≥ scheduled → achieved 0 → recommended = 10_000 클램프 (R13)
        let mut s = summary();
        s.duration_seconds = 15;
        let got = derive_insights(
            &s, &[], &[], &BTreeMap::new(), None, "", 300,
            Some(3), Some(20), Some(300.0),
        );
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.cause.as_deref(), Some("slots"));
        assert_eq!(ins.recommended, Some(10_000.0));
    }

    #[test]
    fn saturated_falls_back_when_inputs_missing() {
        // target/M/scheduled 중 하나라도 None → emit + cause None + 신규 필드 None (fallback arm 계승)
        let got = derive_insights(&summary(), &[], &[], &BTreeMap::new(), None, "", 5, None, None, None);
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.cause, None);
        assert_eq!(ins.recommended, None);
        assert_eq!(ins.achieved_per_sec, None);
        assert_eq!(ins.target_per_sec, None);
        assert_eq!(ins.recommended_workers, None);
    }

    #[test]
    fn no_cause_is_ever_loadgen() {
        // R3: loadgen 생성 경로 부재 — 대표 slots/sut/fallback 3경로에서 단언 (위 테스트들과 중복이지만 명시 가드)
        let mut s = summary();
        s.duration_seconds = 15;
        for (dropped, m, t, sch) in [
            (260u64, Some(3), Some(20), Some(300.0)),
            (5, None, None, None),
        ] {
            let got = derive_insights(&s, &[], &[], &BTreeMap::new(), None, "", dropped, m, t, sch);
            assert!(got.iter().all(|i| i.cause.as_deref() != Some("loadgen")));
        }
    }
```

주의: `summary()` 헬퍼가 `duration_seconds`를 이미 갖는지 확인하고(ReportSummary 필드) fixture를 맞출 것. `dist()` 헬퍼 시그니처는 기존 테스트(예: L744 부근) 참조.

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-controller insights` → `scheduled_arrivals` 미정의 + 시그니처 불일치로 컴파일 에러.

- [ ] **Step 3: `scheduled_arrivals` 구현** (insights.rs, `derive_insights` 위에):

```rust
/// Open-loop run이 `duration_actual`초 동안 스케줄한 도착(반복) 총수. 고정 rate =
/// target × duration; 곡선 = 0-start piecewise-linear 램프(엔진 runner.rs::rate_at 미러 —
/// private라 재구현, 테스트 fixture가 의미 고정)의 사다리꼴 적분을 duration_actual에서
/// 절단(끝을 지나면 마지막 target 유지). 어느 쪽도 없으면(비-open-loop) None. (ADR-0046 R2)
pub(crate) fn scheduled_arrivals(
    target_rps: Option<u32>,
    stages: Option<&[handicap_engine::Stage]>,
    duration_actual: f64,
) -> Option<f64> {
    if let Some(stages) = stages.filter(|s| !s.is_empty()) {
        let mut total = 0.0f64;
        let mut seg_start = 0.0f64;
        let mut prev = 0.0f64;
        for st in stages {
            let span = f64::from(st.duration_seconds);
            let target = f64::from(st.target);
            let seg_end = seg_start + span;
            if duration_actual >= seg_end {
                total += (prev + target) / 2.0 * span; // 전체 stage
            } else if duration_actual > seg_start && span > 0.0 {
                let t = duration_actual - seg_start; // 부분 stage: t 지점 rate까지 선형 적분
                let rate_at_t = prev + (target - prev) * (t / span);
                return Some(total + (prev + rate_at_t) / 2.0 * t);
            } else {
                return Some(total);
            }
            seg_start = seg_end;
            prev = target;
        }
        if duration_actual > seg_start {
            total += prev * (duration_actual - seg_start); // 곡선 끝 이후: 마지막 target 유지
        }
        return Some(total);
    }
    target_rps.map(|t| f64::from(t) * duration_actual)
}
```

`use handicap_engine::Stage;`가 이미 스코프에 없으면 fully-qualified로 두거나 import 추가(컨트롤러는 이미 `handicap_engine` 의존).

- [ ] **Step 4: `derive_insights` 시그니처·dropped 블록 재작성**

시그니처(L86-97): 10번째 `worker_count_current: u32` → `scheduled_arrivals: Option<f64>`로 교체. 함수 위 "10 인자" 주석을 새 인자 구성에 맞게 갱신. dropped 블록(L213-271) 전체를 다음으로 교체:

```rust
    // load_gen_saturated: open-loop run이 요청한 도착률을 못 냈다(슬롯 부족으로
    // 발사 못한 반복 = dropped). dropped는 open-loop 스케줄러만 증가시키므로
    // (closed-loop은 항상 0) `dropped > 0`이 자동으로 open-loop에 한정된다.
    // 사이징(ADR-0046): 포화 중엔 M개 슬롯이 상시 사용 중이므로 반복 점유시간이
    // hold = M ÷ 달성 도착률로 자기측정된다(think·멀티스텝·분기 자동 반영).
    // required = ceil(target × hold). 관측 천장 value = peak 초당 요청 수(기존 의미 유지).
    if dropped > 0 {
        let mut by_sec: BTreeMap<i64, u64> = BTreeMap::new();
        for w in windows {
            *by_sec.entry(w.ts_second).or_insert(0) += w.count;
        }
        let peak = by_sec
            .values()
            .copied()
            .max()
            .unwrap_or_else(|| summary.rps.round() as u64);
        let mut ins = Insight::new("load_gen_saturated", "warning");
        ins.value = Some(peak as f64);
        ins.count = Some(dropped);
        ins.onset_second = saturation_onset(&by_sec, peak);

        match (target_rps, max_in_flight, scheduled_arrivals) {
            (Some(target), Some(m), Some(scheduled)) => {
                let duration = summary.duration_seconds.max(1) as f64;
                let achieved = ((scheduled - dropped as f64) / duration).max(0.0);
                ins.target_per_sec = Some(f64::from(target));
                ins.achieved_per_sec = Some(achieved);
                // sut 판정이 우선(R3·R13): 서버 열화면 슬롯 증설 권장 자체가 유해.
                if sut_stress(status_distribution, windows) {
                    ins.cause = Some("sut".to_string());
                } else {
                    ins.cause = Some("slots".to_string());
                    // achieved 0(dropped ≥ scheduled)이면 validate 상한(10_000,
                    // api/runs.rs:290)으로 클램프 — "권장 불능"이 아니라 상한 신호.
                    let required = if achieved > 0.0 {
                        (f64::from(target) * f64::from(m) / achieved).ceil()
                    } else {
                        10_000.0
                    };
                    ins.recommended = Some(required.clamp(1.0, 10_000.0));
                }
            }
            // fallback: 구식 run/profile 부재(테스트 fixture 포함) — 인사이트는 emit하되
            // cause/recommended/신규 필드 전부 None (기존 `_ => {}` 폴백 계승).
            _ => {}
        }
        out.push(ins);
    }
```

`recommended_workers` 계산 블록·loadgen arm은 위 교체로 소멸. `Insight.recommended_workers` 필드 주석을 "// DEPRECATED(ADR-0046): 사후 산출 제거 — 항상 None. 워커 텔레메트리 도입 시 재사용(roadmap §B20)."으로 교체. `recommended` 필드의 doc 주석도 새 공식으로 갱신(`ceil(target × mean_sec)` → `ceil(target_eff × M ÷ achieved_arrival_rate)`). `cause` 필드 주석에서 loadgen 설명 제거(2-way). `sut_stress` 함수 doc 주석("슬롯 충분 arm 안에서만 호출, CC2")을 "sut 판정이 항상 선평가(ADR-0046)"로 갱신.

- [ ] **Step 5: 기존 인라인 테스트 갱신 (같은 커밋)**

  - **기계적 call site**: `derive_insights(` 호출 ~29곳(삭제분 제외)의 10번째 인자 — `1`/`worker_count` 값 → 대응 `scheduled_arrivals` 값. 비포화(dropped=0)·비관련 테스트는 전부 `None`. 포화 테스트는 각 fixture의 `Some(target×duration)`.
  - **삭제/대체**: `saturated_loadgen_when_slots_sufficient`·`saturated_loadgen_recommends_more_workers`·`saturated_peak_zero_omits_worker_rec`·`saturated_m_le_current_omits_worker_rec`·`sut_stress_only_inside_slots_sufficient_arm` 삭제(위 Step 1 신규 테스트가 대체 — CC2 invariant는 "sut 선평가"로 의도적 반전, spec §4.1).
  - **재작성**: `saturated_slots_recommends_when_underprovisioned` → Step 1의 `saturated_slots_uses_measured_hold`가 대체하므로 삭제. `saturated_small_required_rounds_up_to_one` → 새 공식으로: target 1·M 10_000·dropped 1·duration 15·scheduled Some(15.0) → achieved (15−1)/15≈0.933 → ceil(1×10_000/0.933)=10_715 → **클램프 10_000** … 이 케이스는 클램프 테스트와 중복이므로 대신 하한 검증으로: target 1·M 1·dropped 1·duration 100·scheduled Some(100.0) → achieved 0.99 → ceil(1×1/0.99)=2 → `recommended=Some(2.0)`·`>=1` 단언(`.clamp(1.0, …)` 하한 커버).
  - **유지+인자만**: `saturated_sizing_falls_back_when_max_in_flight_absent`(M None → fallback — 10번째 인자 `Some(…)`로 줘도 fallback인지 단언), `load_gen_saturated_when_dropped`·`no_saturation_when_dropped_zero`·`insights_deterministic_order` 등은 10번째 인자 `None`으로 교체(기대값 무변경 — fallback arm). `saturated_sizing_falls_back_when_latency_zero`는 mean 개념이 사라졌으므로 삭제(Step 1 `saturated_falls_back_when_inputs_missing`가 대체).

- [ ] **Step 6: report.rs 호출부 + 테스트 2건**

호출부(L767-783): 마지막 인자 `run.profile.worker_count.unwrap_or(1)` →

```rust
        crate::insights::scheduled_arrivals(
            run.profile.target_rps,
            run.profile.stages.as_deref(),
            summary.duration_seconds as f64,
        ),
```

(주의: `run.profile.stages`는 `Option<Vec<handicap_engine::Stage>>` — `.as_deref()`로 `Option<&[Stage]>`.)

테스트 재산정(`run_row()`는 started 100_000·ended 102_000 → summary.duration_seconds=2 — 실 fixture에서 확인 후 다르면 아래 숫자를 공식 `ceil(target×M÷((scheduled−dropped)÷dur))`로 재계산):
  - `build_report_sizing_slots_recommendation`: target 10_000·M 100·dropped 200·dur 2 → scheduled 20_000·achieved 9_900 → `recommended = Some(102.0)` (ceil(10_000×100/9_900)=ceil(101.01)). 주석도 새 공식으로 갱신. `achieved_per_sec`/`target_per_sec` Some 단언 추가.
  - `build_report_sizing_uses_stages_peak`: stages [{4000,10},{12000,10}]·dur 2(절단!) → scheduled = (0+800)/2×2 = **800**·achieved (800−50)/2=375 → `recommended = Some(3200.0)` (ceil(12_000×100/375)). target_eff=peak 12_000 → `target_per_sec = Some(12000.0)` 단언 추가(유효목표 도출이 여전히 report.rs 책임임을 락인).

- [ ] **Step 7: GREEN 확인** — `cargo build --workspace && cargo clippy --workspace -- -D warnings && cargo nextest run` 전부 green (UI 무접촉이라 pnpm 게이트 생략 가능하나 pre-commit이 cargo 게이트를 돌림).

- [ ] **Step 8: Commit**

```bash
git add crates/controller/src/insights.rs crates/controller/src/report.rs
git commit -m "feat(controller): 포화 인사이트를 실측 점유시간 기반으로 — cause 2-way·recommended_workers 제거 (R1-R4,R13)"
```

---

### Task 3: sizing.ts 순수 계산 + WorkerSizingHelper 단위 정합 (충족 R: R6, R7, R10)

**Files:**
- Modify: `ui/src/components/sizing.ts`
- Modify: `ui/src/components/WorkerSizingHelper.tsx`
- Modify: `ui/src/i18n/ko.ts` (`workerSizing` 블록)
- Test: `ui/src/components/__tests__/sizing.test.ts`(기존 — 실제 파일명은 `ls ui/src/components/__tests__/`로 확인), `ui/src/components/__tests__/WorkerSizingHelper.test.tsx`(존재 시 갱신)

**Interfaces:**
- Consumes: `Step` 타입(`../scenario/model`), 기존 `targetRpsValid`.
- Produces: `iterationHoldMs(steps: ReadonlyArray<Step>, perStepP50: ReadonlyMap<string, number>, fallbackMs: number): number`; `recommendWorkers(target: number, priorAchievedPerSec: number, priorWorkerCount: number): WorkerSizingResult | null`(2번째 인자 의미 교체); `pickLatestFixedOpenRun(runs: Run[]): Run | null` — Task 4가 `iterationHoldMs` 소비.

- [ ] **Step 1: 실패 테스트 작성** — 기존 sizing 테스트 파일에 추가:

```ts
import { iterationHoldMs, pickLatestFixedOpenRun, recommendWorkers } from "../sizing";
import type { Step } from "../../scenario/model";

const http = (id: string, think?: { min_ms: number; max_ms: number }): Step =>
  ({ type: "http", id, name: id, request: { method: "GET", url: "/x" },
     ...(think ? { think_time: think } : {}) }) as unknown as Step;

describe("iterationHoldMs (R7)", () => {
  const p50 = new Map([["a", 100], ["b", 200]]);
  it("flat: Σ(p50 + think평균), 미관측 스텝은 fallback", () => {
    // a=100 + think(500+1500)/2=1000 → 1100; b=200; c(미관측)=fallback 50 → 합 1350
    const steps = [http("a", { min_ms: 500, max_ms: 1500 }), http("b"), http("c")];
    expect(iterationHoldMs(steps, p50, 50)).toBe(1350);
  });
  it("loop: repeat 배수", () => {
    const steps = [{ type: "loop", id: "L", name: "L", repeat: 3, do: [http("a")] } as unknown as Step];
    expect(iterationHoldMs(steps, p50, 50)).toBe(300);
  });
  it("if/parallel: 분기 max", () => {
    const ifStep = { type: "if", id: "I", name: "I", cond: {}, then: [http("a")], elif: [], else: [http("b")] } as unknown as Step;
    expect(iterationHoldMs([ifStep], p50, 50)).toBe(200); // max(100, 200)
    const par = { type: "parallel", id: "P", name: "P", branches: [
      { name: "x", steps: [http("a")] }, { name: "y", steps: [http("b")] },
    ] } as unknown as Step;
    expect(iterationHoldMs([par], p50, 50)).toBe(200);
  });
  it("http leaf 0개면 0", () => expect(iterationHoldMs([], p50, 50)).toBe(0));
});

describe("recommendWorkers (R10 — 달성 도착률 분모)", () => {
  it("ceil(target × wc ÷ achieved)", () => {
    expect(recommendWorkers(60, 12, 2)).toEqual({ recommendedWorkers: 10 });
  });
  it("achieved<=0/무효면 null", () => {
    expect(recommendWorkers(60, 0, 2)).toBeNull();
    expect(recommendWorkers(60, NaN, 2)).toBeNull();
  });
});

describe("pickLatestFixedOpenRun (R10 — 곡선 prior 제외)", () => {
  it("target_rps 있는 completed run만", () => {
    const runs = [
      { id: "1", status: "completed", created_at: 1, profile: { vus: 0, target_rps: 10 } },
      { id: "2", status: "completed", created_at: 2, profile: { vus: 0, stages: [{ target: 5, duration_seconds: 10 }] } },
    ] as never[];
    expect(pickLatestFixedOpenRun(runs)?.id).toBe("1"); // 곡선(2)은 제외
  });
});
```

(캐스트는 기존 sizing 테스트 파일의 fixture 관행에 맞출 것 — 기존 파일이 완전 Run fixture 헬퍼를 갖고 있으면 그걸 재사용.)

- [ ] **Step 2: RED 확인** — `cd ui && pnpm test sizing` → 미정의 import 실패.

- [ ] **Step 3: sizing.ts 구현**

```ts
/** 반복 1회 점유시간(ms) 추정 — iterationTimeUpperBoundSeconds(openLoopChecks.ts:27) 구조 미러.
 *  용도가 다르다: 그쪽은 상한(스텝 timeout·think max, inert_slots 경고용), 이쪽은 추정
 *  (관측 p50 ?? fallback + think 평균 (min+max)/2, 슬롯 권장용). http leaf 0개면 0(호출부 skip).
 *  ADR-0046 R7. */
export function iterationHoldMs(
  steps: ReadonlyArray<Step>,
  perStepP50: ReadonlyMap<string, number>,
  fallbackMs: number,
): number {
  let total = 0;
  for (const s of steps) {
    if (s.type === "http") {
      const lat = perStepP50.get(s.id) ?? fallbackMs;
      const think = s.think_time ? (s.think_time.min_ms + s.think_time.max_ms) / 2 : 0;
      total += lat + think;
    } else if (s.type === "loop") {
      total += s.repeat * iterationHoldMs(s.do, perStepP50, fallbackMs);
    } else if (s.type === "parallel") {
      let mx = 0;
      for (const b of s.branches) {
        mx = Math.max(mx, iterationHoldMs(b.steps, perStepP50, fallbackMs));
      }
      total += mx;
    } else {
      // if — 단일 분기만 실행 → max 분기 (iterationTimeUpperBoundSeconds와 동일 정책)
      let mx = iterationHoldMs(s.then, perStepP50, fallbackMs);
      for (const e of s.elif) {
        mx = Math.max(mx, iterationHoldMs(e.then, perStepP50, fallbackMs));
      }
      mx = Math.max(mx, iterationHoldMs(s.else, perStepP50, fallbackMs));
      total += mx;
    }
  }
  return total;
}
```

`import type { Step } from "../scenario/model";` 추가(파일 상단 — openLoopChecks.ts와 동일 소스). `recommendSlots`의 doc 주석을 "동시 슬롯 ≈ 도착률 × **반복 1회 점유시간**"으로, insights.rs 참조 주석을 새 공식(`ceil(target_eff × M ÷ achieved)` — 사후는 실측, 사전은 hold 추정, 같은 Little's law)으로 갱신 — **구현식 `ceil(target × latencyMs/1000)`은 무변경**(파라미터 의미만 hold로). `recommendWorkers`를 위 Interfaces 시그니처로 교체(분모=달성 도착률, doc: ADR-0046 단위 통일·구 요청-peak 혼용 제거). `pickLatestFixedOpenRun` 신규(기존 `pickLatestOpenRun` 바로 아래):

```ts
/** 워커 앵커용: 가장 최근 종료된 '고정 rate' open-loop run(target_rps 있음)만.
 *  곡선 prior는 달성 도착률 산출에 stages 적분이 필요해 제외(ADR-0046 §7 연기). */
export function pickLatestFixedOpenRun(runs: Run[]): Run | null {
  let best: Run | null = null;
  for (const r of runs) {
    if (r.status !== "completed") continue;
    if (r.profile.target_rps == null) continue;
    if (best === null || r.created_at > best.created_at) best = r;
  }
  return best;
}
```

`peakThroughput`은 **유지**(spec §4.5 — export 심볼·기존 테스트 무변경, 관측 peak 표시 용도 존치).

- [ ] **Step 4: WorkerSizingHelper 앵커 교체**

`usePriorOpenRunWorkerAnchor`를:

```ts
type WorkerAnchor = {
  achievedPerSec: number;
  priorTarget: number;
  dropped: number;
  priorWorkerCount: number;
};

/** 최근 종료 '고정 rate' open-loop run에서 달성 도착률 앵커 도출(ADR-0046 R10).
 *  achieved = prior_target − dropped/duration. 곡선 prior는 제외(pickLatestFixedOpenRun).
 *  duration<=0 또는 achieved<=0이면 null. */
function usePriorOpenRunWorkerAnchor(scenarioId: string | undefined): WorkerAnchor | null {
  const runs = useScenarioRuns(scenarioId);
  const latest = useMemo(
    () => pickLatestFixedOpenRun((runs.data?.runs ?? []) as Run[]),
    [runs.data],
  );
  const report = useRunReport(latest?.id, Boolean(latest));
  const dropped = report.data?.dropped ?? 0;
  const duration = report.data?.summary.duration_seconds ?? 0;
  const priorTarget = latest?.profile.target_rps ?? 0;
  const priorWorkerCount = latest?.profile.worker_count ?? 1;
  return useMemo(() => {
    if (duration <= 0 || priorTarget <= 0) return null;
    const achievedPerSec = Math.max(0, priorTarget - dropped / duration);
    if (achievedPerSec <= 0) return null;
    return { achievedPerSec, priorTarget, dropped, priorWorkerCount };
  }, [duration, priorTarget, dropped, priorWorkerCount]);
}
```

본문: `recommendWorkers(Number(targetRps), anchor.achievedPerSec, anchor.priorWorkerCount)`. strongBasis/weakBasis 호출을 새 시그니처에 맞춤(아래 ko). result 표시 블록에 **항상** 슬롯-분할 경고 1줄 추가(R10):

```tsx
              <p className="text-xs text-slate-500 mt-1">{ko.workerSizing.slotSplitNote}</p>
```

- [ ] **Step 5: ko.workerSizing 문구** (도착률 언어 + 신규 키):

```ts
    strongBasis: (wc: number, achieved: number, dropped: number) =>
      `지난 run이 워커 ${wc}대로 초당 ~${achieved}회 반복까지만 시작했어요(유실 ${dropped}건) → 워커당 초당 ~${Math.round(
        achieved / wc,
      )}회가 한계예요.`,
    weakBasis: (wc: number, target: number) =>
      `지난 run은 워커 ${wc}대로 목표(초당 ${target}회 반복)를 유실 없이 소화했어요 — 한계까진 안 밀어서 워커당 진짜 천장은 아직 몰라요.`,
    slotSplitNote:
      "워커를 늘려도 동시 슬롯 총량(max_in_flight)은 워커별로 나눠져요 — 슬롯 부족(포화 인사이트 cause=slots)이 원인이면 max_in_flight부터 올리세요.",
```

(`strongBasis`/`weakBasis` 호출부: strong은 `Math.round(anchor.achievedPerSec)`, weak은 `anchor.priorTarget` 전달. 기존 다른 키(help/recommend/…)는 무변경 — "RPS" 표기가 남는 키의 전면 개명은 슬라이스 ②.)

- [ ] **Step 6: 기존 WorkerSizingHelper·sizing 테스트 갱신** — 앵커 fixture에 `profile.target_rps`·`summary.duration_seconds` 필수화, `recommendWorkers` 기존 케이스를 새 분모 의미로 재산정, 문구 단언을 새 카피로. `pnpm test`가 지목하는 실패를 전부 이 task 안에서 green으로.

- [ ] **Step 7: GREEN + 게이트** — `cd ui && pnpm lint && pnpm test && pnpm build` 전부 green.

- [ ] **Step 8: Commit**

```bash
git add ui/src/components/sizing.ts ui/src/components/WorkerSizingHelper.tsx ui/src/i18n/ko.ts ui/src/components/__tests__/
git commit -m "feat(ui): iterationHoldMs walk + 워커 사이징 달성-도착률 분모·슬롯분할 경고 (R6,R7,R10)"
```

---

### Task 4: SlotSizingHelper 앵커 재설계 ⓐ~ⓓ (충족 R: R8, R9, R12 일부)

**Files:**
- Modify: `ui/src/components/SlotSizingHelper.tsx` (전면 — 165줄)
- Modify: `ui/src/components/LoadModelFields.tsx` (SlotSizingHelper 마운트 2곳에 `scenario` prop)
- Modify: `ui/src/i18n/ko.ts` (`slotSizing` 블록)
- Test: `ui/src/components/__tests__/SlotSizingHelper.test.tsx`(존재 확인 — 없으면 신규; RunDialog/LoadModelFields 테스트의 `vi.mock` 스텁은 무변경)

**Interfaces:**
- Consumes: Task 3 `iterationHoldMs`, Task 1 UI `Insight` 필드, 기존 `recommendSlots`/`useTestRun`/`useRunReport`.
- Produces: `SlotSizingHelper` props에 `scenario?: Scenario | null` 추가(optional — 미전달 호출부는 ⓑ skip으로 하위호환).

- [ ] **Step 1: 실패 RTL 테스트 작성** — 4앵커 경로+우선순위(파일이 없으면 신규 생성; React Query 훅은 `vi.mock("../../api/hooks", async (importOriginal) => ({...spread, useScenarioRuns: vi.fn(), useRunReport: vi.fn(), useTestRun: vi.fn(), useScenario: vi.fn()}))` factory-spread — 커스텀 에러클래스/실헬퍼 보존 관행):

  - ⓐ: prior report에 `insights: [{kind:"load_gen_saturated", cause:"slots", achieved_per_sec: 2.667, recommended: 23, ...}]` + prior run `profile.max_in_flight: 3`, 현재 target "20" → hold=3/2.667≈1.125s → `recommendSlots(20, 1125)` = ceil(22.5)=23 표시(**R9 parity: 서버 recommended 23과 동일값**) + "직전 run 실측 점유시간 기반" 문구. 현재 target을 "40"으로 → 45 표시(hold 재사용 스케일 단언).
  - ⓑ: insights 없음(또는 cause=sut)·scenario 2-step(p50 각 100/200) + summary.mean_ms fallback → hold 300ms → target 20 → 6 표시.
  - ⓑ 무효: `steps[]` p50 전부 0·mean_ms 0 → hold 0 → ⓒ(수동 입력)로 폴백 렌더.
  - ⓒ: prior 없음 + 수동 "1100" 입력 → target 20 → 22 표시, 라벨 "반복 1회 예상 시간(ms)".
  - ⓓ: 측정 클릭 → `testRun.mutate`가 `apply_think_time: true` 포함해 호출됨 단언 + `trace.total_ms: 1105` → hold 직접 → 23 표시.

- [ ] **Step 2: RED 확인** — `cd ui && pnpm test SlotSizingHelper`.

- [ ] **Step 3: SlotSizingHelper 구현**

Props에 `scenario?: Scenario | null` 추가(`import type { Scenario } from "../scenario/model";`). 앵커 훅 교체:

```ts
type SlotAnchor =
  | { kind: "insight"; holdMs: number } // ⓐ 직전 포화 run 실측 hold 복원
  | { kind: "walk"; holdMs: number }; // ⓑ per-step p50 + think 평균 walk

/** 최근 종료 open-loop run에서 반복 점유시간(hold) 앵커 도출(ADR-0046 R8).
 *  ⓐ 포화(cause=slots) 인사이트의 실측 achieved_per_sec + prior max_in_flight로
 *  hold = M ÷ achieved 복원(목표-독립 — 현재 목표가 달라도 정확, R9 parity).
 *  ⓑ 아니면 scenario walk(iterationHoldMs, p50 ?? mean_ms). hold<=0이면 null. */
function usePriorOpenRunAnchor(
  scenarioId: string | undefined,
  scenario: Scenario | null | undefined,
): SlotAnchor | null {
  const runs = useScenarioRuns(scenarioId);
  const latest = useMemo(
    () => pickLatestOpenRun((runs.data?.runs ?? []) as Run[]),
    [runs.data],
  );
  const report = useRunReport(latest?.id, Boolean(latest));
  const priorMif = latest?.profile.max_in_flight ?? null;
  return useMemo(() => {
    const rep = report.data;
    if (!rep) return null;
    const sat = rep.insights?.find((i) => i.kind === "load_gen_saturated");
    if (
      sat?.cause === "slots" &&
      sat.achieved_per_sec != null &&
      sat.achieved_per_sec > 0 &&
      priorMif != null &&
      priorMif > 0
    ) {
      return { kind: "insight", holdMs: (priorMif / sat.achieved_per_sec) * 1000 };
    }
    if (scenario) {
      const p50 = new Map(rep.steps.map((s) => [s.step_id, s.p50_ms] as const));
      const hold = iterationHoldMs(scenario.steps, p50, rep.summary.mean_ms);
      if (hold > 0) return { kind: "walk", holdMs: hold };
    }
    return null;
  }, [report.data, priorMif, scenario]);
}
```

본문 배선: `const anchor = usePriorOpenRunAnchor(scenarioId, scenario);` — 지연 소스 precedence를 hold 단위로 통일: `holdMs = anchor?.holdMs ?? (수동 estMs > 0 ? estMs : measuredHold)`. 측정 경로: `runMeasure`가 `testRun.mutate({ scenario_yaml: yaml, env, apply_think_time: true })`, `measuredHold = trace && !trace.truncated && trace.total_ms > 0 ? trace.total_ms : null`(÷R 제거 — `measuredR`은 `measured(req, ms)` 안내 문구용으로만 유지하되 ms 인자는 hold로). `result = holdMs != null ? recommendSlots(targetNum, holdMs) : null`(함수 무변경 — R6). 앵커 안내문: `anchor.kind === "insight"` → `ko.slotSizing.fromSaturatedRun`, `"walk"` → `ko.slotSizing.fromPriorRunWalk(Math.round(anchor.holdMs))`.

- [ ] **Step 4: ko.slotSizing 키 갱신**

```ts
    estMs: "반복 1회 예상 시간(ms) — 모든 스텝 응답 + 생각 시간 포함",
    fromSaturatedRun:
      "직전 실행이 포화였어요 — 그 실행의 실측 반복 점유시간 기준이라 가장 정확한 추정이에요.",
    fromPriorRunWalk: (holdMs: number) =>
      `지난 실행의 스텝별 응답시간으로 계산한 반복 1회 ~${holdMs}ms 기준 추정이에요.`,
    measured: (req: number, holdMs: number) => `측정됨: 요청 ${req}개 · 반복 1회 ~${holdMs}ms`,
    formula: (targetRps: number, holdMs: number, n: number) =>
      `목표 도착 초당 ${targetRps}회 × 반복 1회 ${holdMs}ms ≈ 동시 ${n}슬롯`,
    formulaPeak: (targetRps: number, holdMs: number, n: number) =>
      `최고 단계 목표 초당 ${targetRps}회 × 반복 1회 ${holdMs}ms ≈ 동시 ${n}슬롯`,
```

(`fromPriorRun` 키는 소비처가 사라지므로 제거 — `grep -n "fromPriorRun" ui/src`로 잔존 0 확인. `help` 등 "RPS" 잔존 키의 전면 개명은 슬라이스 ② — 단 `estMs`처럼 **의미가 바뀐** 키는 지금 갱신.)

- [ ] **Step 5: LoadModelFields 마운트 2곳** — `<SlotSizingHelper …>` (open+fixed arm·open+curve arm 둘 다)에 `scenario={sizingScenario ?? null}` 전달(599행 VuSizingHelper의 기존 패턴과 동일).

- [ ] **Step 6: GREEN + 전체 게이트** — `cd ui && pnpm lint && pnpm test && pnpm build`.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/SlotSizingHelper.tsx ui/src/components/LoadModelFields.tsx ui/src/i18n/ko.ts ui/src/components/__tests__/
git commit -m "feat(ui): 슬롯 헬퍼 앵커 재설계 — 포화 run 실측 hold 복원·walk·측정=total_ms (R8,R9)"
```

---

### Task 5: 포화 인사이트 문구 2-way + fallback + roadmap 연기 (충족 R: R12, R13 문구)

**Files:**
- Modify: `ui/src/i18n/ko.ts` (`saturation` 블록·`insightActions.load_gen_saturated`)
- Modify: `ui/src/components/report/InsightPanel.tsx` (`actionFor`)
- Modify: `ui/src/components/report/__tests__/InsightPanel.test.tsx` (loadgen 케이스 3곳 등)
- Modify: `docs/roadmap.md` (§B20 신설)

**Interfaces:**
- Consumes: Task 1 `Insight.achieved_per_sec`/`target_per_sec`, Task 2 서버 의미(2-way).

- [ ] **Step 1: 실패 테스트** — InsightPanel.test.tsx: slots 인사이트 fixture `{kind:"load_gen_saturated", cause:"slots", recommended: 23, target_per_sec: 20, achieved_per_sec: 2.7, count: 260, value: 3}` → 행동 문구에 "초당 20회"·"2.7회"·"~17"(유실)·"23"이 모두 포함 단언; sut fixture → "서버" + "보류" 문구; cause 없음 → fallback 문구(워커 CPU 언급 없음); recommended 10000 → 상한 문구 포함.

- [ ] **Step 2: RED 확인** — `pnpm test InsightPanel`.

- [ ] **Step 3: ko.ts 재작성** (`saturation` 블록 전체 교체 + fallback):

```ts
  // 사이징 권장(load_gen_saturated cause 분기, ADR-0046 2-way). 조사 병기((으)로 등, ADR-0035).
  saturation: {
    slots: (target: string, achieved: string, lost: string, rec: string) =>
      `목표는 초당 ${target}회 반복(시나리오 실행) 시작이었는데 실제로는 초당 ${achieved}회만 시작됐어요` +
      `(초당 ~${lost}회 유실). 동시 실행 수(max_in_flight)가 부족한 것이니 최소 ~${rec}(으)로 올려 다시 실행하세요. ` +
      `(곡선 run은 최고 단계 기준·상한 추정)`,
    slotsAtCap:
      `권장값이 단일 run 슬롯 상한(10,000)에 도달했어요 — 달성률이 매우 낮아 정확한 추정이 어려워요. ` +
      `반복 1회 시간(생각 시간·스텝 수)을 줄이거나 목표를 낮춰 다시 측정하세요.`,
    sut:
      `대상 서버(SUT)가 응답 열화 신호를 보여요(에러·지연 상승) — 지금 슬롯·부하를 늘리면 서버만 더 힘들어져요. ` +
      `서버 용량·설정부터 점검한 뒤 다시 실행하세요.`,
  },
```

`insightActions.load_gen_saturated` → `"동시 실행 수(max_in_flight)를 늘려 다시 실행하세요. 에러·지연이 함께 높으면 대상 서버 한계일 수 있어요."` (구 "워커 CPU" 제거). `loadgen`/`loadgenWithWorkers` 키 삭제.

- [ ] **Step 4: InsightPanel `actionFor` 교체**

```ts
// 도착률 표시: 소수 1자리, 정수면 정수로 (초보자 가독).
function rate(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function actionFor(i: Insight): string | undefined {
  if (i.kind === "load_gen_saturated") {
    if (i.cause === "slots") {
      const x = i.target_per_sec;
      const y = i.achieved_per_sec;
      if (x != null && y != null && i.recommended != null) {
        const base = ko.saturation.slots(rate(x), rate(y), rate(Math.max(0, x - y)), n(i.recommended));
        return i.recommended >= 10_000 ? `${base} ${ko.saturation.slotsAtCap}` : base;
      }
      return ko.insightActions.load_gen_saturated; // 방어(신규 필드 부재 — 구식 리포트)
    }
    if (i.cause === "sut") return ko.saturation.sut;
    return ko.insightActions.load_gen_saturated; // 폴백(cause None)
  }
  return ACTIONS[i.kind];
}
```

(loadgen 분기·`recommended_workers` 소비 제거 — `grep -n "recommended_workers\|loadgen" ui/src/components` 잔존 0 확인, `schemas.ts`의 필드 자체는 유지.)

- [ ] **Step 5: roadmap §B20 신설** — `docs/roadmap.md`의 §B 말미에 불릿 append(단일 라인 유지 — 필요 시 python splice, 루트 CLAUDE.md 규칙): 슬라이스 ②(open-loop 목표 라벨 개명 "도착률(초당 반복)"·"≈ 요청 N/s" 환산·리포트 목표/달성 도착률 표기·ko "RPS" 잔존 키 스윕), loadgen cause 재도입(워커 CPU 텔레메트리 proto 필요), per-second dropped 시리즈(곡선 required 정밀화), 곡선 prior run 워커 앵커(UI 적분 복제 필요). 출처: ADR-0046·spec §7.

- [ ] **Step 6: GREEN + 게이트** — `cd ui && pnpm lint && pnpm test && pnpm build`.

- [ ] **Step 7: Commit**

```bash
git add ui/src/i18n/ko.ts ui/src/components/report/InsightPanel.tsx ui/src/components/report/__tests__/InsightPanel.test.tsx docs/roadmap.md
git commit -m "feat(ui): 포화 인사이트 문구 2-way — 목표/달성 도착률 수치 명시·loadgen 제거 (R12,R13)"
```

---

### Task 6: 라이브 검증 (충족 R: R14, R3 라이브) — orchestrator 직접

**Files:** 없음(검증 전용 — production diff 0).

- [ ] **Step 1: 스택 기동** — `/live-verify` 레시피(워크트리 자체 바이너리·격리 DB `/tmp/olss.db`·`responder.py 9999 100`). `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller` 후 `./target/debug/controller --db /tmp/olss.db`(백엔드-only, `--ui-dir` 생략).

- [ ] **Step 2: 3-run 실측** (2026-07-12 재현 세션 레시피 — 시나리오 2종: 2-스텝 각 100ms / 1-스텝+`think_time {min_ms:1000, max_ms:1000}`; 모두 target 20·15s):
  - think 시나리오·슬롯 3 → 리포트 인사이트 `cause=slots`·`recommended≈23`·`achieved_per_sec≈2.7`·`target_per_sec=20`·`recommended_workers` 부재.
  - think 시나리오·슬롯 23(권장 적용) → 포화 인사이트 없음·`summary.rps≈20`.
  - 2-스텝·슬롯 3 → `recommended≈5`(achieved≈12/s).

- [ ] **Step 3: UI 라이브 1회** (S-D 갭 — Zod 신규 필드 응답 경로): `cd ui && pnpm build` 후 controller `--ui-dir ui/dist`로 재기동, Playwright로 run 상세 진입 → 포화 인사이트 행동 문구에 목표/달성/권장 수치 표시 확인 + `browser_console_messages({level:'error'})` Zod 0. RunDialog 슬롯 헬퍼(ⓐ 경로 — 직전 포화 run 존재 상태)가 23 표시 확인.

- [ ] **Step 4: 정리** — 프로세스 kill·`/tmp/olss*` 삭제·`.playwright-mcp` 정리·`git status --porcelain` 잔류 0.

- [ ] **Step 5: 결과를 최종 리뷰 패키지에 기록** (`.superpowers/sdd/` 아래 — 워크트리 루트 금지).

---

## Self-Review 체크 (plan 작성자 완료)

- spec R1-R14 ↔ Task 매핑: R1·R2·R3·R4·R13→T2, R5→T1, R6·R7·R10→T3, R8·R9→T4, R12→T4(헬퍼 문구)+T5(인사이트 문구), R11→각 task 게이트(전체 스위트)+Global Constraints, R14→T6. 누락 없음.
- 타입 일관성: `scheduled_arrivals(Option<u32>, Option<&[Stage]>, f64) -> Option<f64>`(T2 정의·report.rs 소비), `iterationHoldMs(ReadonlyArray<Step>, ReadonlyMap<string,number>, number) -> number`(T3 정의·T4 소비), `recommendWorkers(number, number, number)`(T3 정의·소비 동일 task), Insight 필드명 `achieved_per_sec`/`target_per_sec`(T1 정의·T2 생산·T4/T5 소비) 일치.
- placeholder 없음(모든 코드 스텝에 실코드), 커밋 경계 = spec §8과 일치.

<!-- REVIEW-GATE: APPROVED -->

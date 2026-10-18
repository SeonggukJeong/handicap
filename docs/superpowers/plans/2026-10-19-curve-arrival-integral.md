# open-loop 곡선 누적 도착 역산 (§B34) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** open-loop 곡선 모드의 k번째 도착 시도를 `t_k = Λ⁻¹(k+½)`(Λ = ∫rate) 절대 시각에 두어, 발생 요청 수가 ∫rate ±½가 되게 한다(완만한 곡선·fan-out으로 작아진 워커 몫에서 도착 대부분이 사라지는 §B34 버그 해소).

**Architecture:** `crates/engine/src/runner.rs`에 순수 구조체 `ArrivalSchedule`(stage별 선형 구간 + 단조 커서로 Λ⁻¹ 평가)을 추가하고(Task 1), `run_scenario_open_loop`의 곡선 분기에서 "순간 레이트 역수 + 100ms poll-step"을 `tick`(drop 포함 시도 순번) 기반 `curve_time(tick)`으로 교체한다(Task 2). 고정 `target_rps` 경로는 산술 그대로. 문서(engine CLAUDE.md·ADR-0032 주석)는 Task 3.

**Tech Stack:** Rust(edition 2024), tokio, wiremock(통합 테스트). 새 의존성 없음.

**Spec:** `docs/superpowers/specs/2026-10-18-curve-arrival-integral-design.md` (spec-plan-reviewer APPROVE, 2라운드 — 커밋 `a1737764`)

**Plan review:** spec-plan-reviewer clean APPROVE (2라운드 — R1 반영 5·기각 1, 상세 "## 리뷰 기록". 리뷰어가 스크래치 복사본에 plan 코드를 적용해 1.99.1로 clippy·`10 passed`·`12 passed`·이빨 실증 2건을 실측).

REVIEW-GATE: APPROVED

**plan 작성 시 사전 실측(가설 아님 — 그래도 구현 시 Step의 실행 명령을 그대로 재실행할 것)**: §3.2 알고리즘을 Python으로 1:1 옮긴 시뮬레이션(`sim.py`, 세션 scratchpad)으로 Task 1의 모든 기대값을 확인했다 — (b) 표 10곡선 + Task 2 통합 곡선 4개 + zero-dur 곡선, 모두 개수 = Λ(T) 반올림(예 `[{5,10}]`→25, `[{7,3}]`(Λ=10.5)→10, `[{1000,2},{1000,6}]`→7000), (c③) 1000-stage 곡선 N=14989회 호출의 scans = **15988 ≤ 15989**(=N+segs), 커서를 매 호출 0으로 되돌리는 고의 회귀 시 scans = **7,506,490**(RED), (a) 최대 오차 1.8e-15, (e) `time_at(19.5)`=3.5528·`time_at(20.5)`=None, (f) 1.05, (d) 2.4472, zero-dur 0.05, soak 3점 상대오차 0. Task 2 통합 곡선의 마지막 도착 시각은 deadline보다 50ms 이상 앞이다(`[{5,4}]` 3.899/4·`[{10,3}]` 2.950/3·`[{0,1},{10,2}]` 2.949/3·`[{10,1},{10,1},{0,1}]` 2.684/3·`[{50,2}]` 1.990/2) — 단 기존 `[{100,1},{100,1}]`은 1.995/2(5ms)라 지터 시 149건이 될 수 있어 허용 폭 [147,151]이 그 여유를 덮는다. 라이브 run 페이로드는 `crates/controller/src/api/runs.rs`(곡선 모드는 `duration_seconds > 0`이면 400)·`store/runs.rs` `Profile`(`duration_seconds`는 serde default 없음 = 필수 키)을 읽어 확정했다.

## Global Constraints

- **엔진만 바꾼다**: proto·controller·worker·UI·migration **코드** 0-diff (spec §2 비목표·§7). 문서는 예외 — Task 3이 `crates/controller/CLAUDE.md`의 낡은 근거 한 구절을 고친다.
- **고정 `target_rps` 경로 byte-identical**: `fixed_interval` 선계산(`Duration::from_nanos((1_000_000_000u64 / u64::from(target_rps)).max(1))`)과 `next += fixed_interval` 산술을 그대로 둔다(spec §3.3, G3). closed-loop(`run_scenario`)·VU 곡선(`run_scenario_vu_curve`)·슬롯 풀/drop/yield/메트릭 무변경.
- **`rate_at`은 지우지 않는다** — VU 곡선(`run_scenario_vu_curve`)이 계속 쓴다(spec §3.3). 기존 `rate_at_piecewise_linear` 테스트 무수정.
- **`tick` ≠ `arrival_counter`**: 곡선 스케줄은 drop 포함 시도 순번 `tick`으로 구동한다. `arrival_counter`(발사만, `iter_id`)는 지금처럼 `iter_id` 용도로만(spec §3.3).
- **위상 `+½`**: 질의는 항상 `time_at(k as f64 + 0.5)`. `k+1`(floor) 금지(spec §3.1 — 정수 Λ에서 마지막 도착이 deadline에 걸려 1건 손실).
- 커밋 메시지는 `-F <파일>`(`.superpowers/sdd/commit-msg-task<N>.txt` — 이 디렉토리는 gitignore), 끝에 `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. `git commit … | tail` 파이프·`--no-verify` 금지. `git add`는 파일 경로를 명시하고 직후 `git diff --cached --name-only`로 staged 확인, 커밋 후 `git log -1 --oneline`로 landed 확인.
- cargo-영향 커밋은 pre-commit이 전체 workspace 게이트(fmt·build·clippy `-D warnings`·nextest·doctest)를 돈다 — 수 분. implementer는 **단일 FOREGROUND 호출(timeout 600000ms)**로 커밋한다(background+poll 금지).
- **워크트리 격리 세션의 Bash 가드**: git 명령은 항상 **단독 호출**(`cd … && git …`·`;`/`|` 섞인 복합·heredoc 본문에 `git`이 든 명령은 거부된다). 커밋 메시지·스크립트는 Write 도구로 파일을 만든 뒤 사용. cargo 명령 뒤 `; echo exit=$?`는 허용.
- 줄번호는 이 plan에 박지 않는다 — 편집 위치는 `grep -n "<앵커 문자열>"`로 그때 찾는다(Task 1이 `runner.rs`를 ~170줄 늘린다).

## Review Focus

1. **워커 몫이 0이 된 곡선**(fan-out 정수 분할로 모든 stage target이 0 — 예: target 1을 워커 2개로 나눔) → 도착 0, deadline에서 `Ok` 정상 종료, NaN/패닉 없음. 고정 경로라면 `.max(1)`이 0을 1로 바꾸지만 곡선은 0이 그대로 내려온다. → Task 1 `arrival_schedule_empty_or_all_zero_curve_has_no_arrivals` + Task 2 `curve_all_zero_share_fires_nothing_and_ends_at_deadline`.
2. **`duration_seconds: 0` stage**(컨트롤러는 거부하지만 엔진 직접 호출·옛 profile에서 도달 가능) → `rate_at`의 span 0처럼 레이트 점프로 취급, 구조에 inf/NaN 없음. → Task 1 `arrival_schedule_zero_duration_stage_is_a_rate_jump`.
3. **소크 규모 입력**(target 상한 1,000,000 × 24h ramp, Λ ≈ 4.3e10) → 도착 시각이 유한하고 해석해와 상대오차 ≤ 1e-9. → Task 1 `arrival_schedule_is_precise_at_soak_scale`.
4. **Λ(T)가 정수가 아닌 곡선**(`[{7,3}]`, Λ=10.5) → 개수는 Λ의 ±½ 안. → Task 1 `arrival_schedule_count_rounds_cumulative_area` 표의 `st(7, 3)` 행.
5. **슬롯 포화(곡선 모드 drop)** → drop도 스케줄 슬롯을 소비해 `count + dropped ≈ Λ`, drop 폭주 없음. → Task 2 `curve_drop_consumes_schedule_slot`(+ 이빨 실증).

---

## 사전 준비 (orchestrator — Task 1 디스패치 *전*, 엔진 커밋 전에만 가능)

라이브 US2 A/B(spec §6.3)용 **수정 전** 바이너리를 확보한다. 워크트리의 엔진 코드가 아직 master와 같을 때만 의미가 있다.

- [ ] **Step 1: 엔진 코드가 master 기준선과 같은지 확인**

Run: `git diff --stat 68498991 HEAD -- crates/`
Expected: 출력 없음(이 브랜치의 커밋은 docs뿐). 출력이 있으면 STOP — 이미 엔진 커밋이 들어간 것이니 아래 "재확보 불가 시" 참조.

- [ ] **Step 2: 워크트리 바이너리 빌드**

Run: `cargo build -p handicap-worker --bin worker ; echo exit=$?`
Run: `cargo build -p handicap-controller --bin controller ; echo exit=$?`
Expected: 둘 다 `exit=0`.

- [ ] **Step 3: `/tmp/curve-arrival-prefix/`로 복사**

Run: `mkdir -p /tmp/curve-arrival-prefix`
Run: `cp target/debug/controller target/debug/worker /tmp/curve-arrival-prefix/`
Run: `ls -la /tmp/curve-arrival-prefix`
Expected: `controller`·`worker` 두 실행 파일.

**재확보 불가 시**(재부팅으로 `/tmp`가 비었고 엔진 커밋이 이미 있음): 메인 체크아웃(master, 머지 전이면 수정 전 엔진)에서 빌드해야 하는데 워크트리 격리 세션은 메인 체크아웃 명령을 거부한다 → 사용자에게 `! cd /Users/sgj/develop/handicap && cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller && mkdir -p /tmp/curve-arrival-prefix && cp target/debug/controller target/debug/worker /tmp/curve-arrival-prefix/` 실행을 요청한다.

---

### Task 1: `ArrivalSchedule` — Λ⁻¹ 단조 커서 (순수 단위, 미배선)

**Files:**
- Modify: `crates/engine/src/runner.rs` — `fn rate_at` 정의 바로 아래(다음 항목 `/// Closed-loop VU curve (spec §4)` doc 주석 *앞*)에 `Seg`·`ArrivalSchedule` 추가
- Test: `crates/engine/src/runner.rs` 의 기존 `#[cfg(test)] mod tests`(`fn rate_at_piecewise_linear` 가 있는 모듈) 끝에 테스트 추가

**Interfaces:**
- Consumes: `Stage { target: u32, duration_seconds: u32 }`(같은 파일, `Copy`·`Debug`).
- Produces (Task 2가 사용 — 모두 모듈 private):
  - `struct ArrivalSchedule` / `fn ArrivalSchedule::new(stages: &[Stage]) -> ArrivalSchedule`
  - `fn ArrivalSchedule::time_at(&mut self, m: f64) -> Option<f64>` — Λ(t)=m 인 최소 t(초, `started_at` 기준). 호출마다 m 비감소 전제. 도달 불가(빈 stages·곡선이 0으로 끝나 m > 총면적)면 `None`.
  - 테스트 전용: `#[cfg(test)] scans: u64` 필드, `segs: Vec<Seg>` 필드(`Seg.slope`·`Seg.area` 읽음).
  - Task 1은 `#[cfg_attr(not(test), allow(dead_code))]`를 `Seg`·`ArrivalSchedule`·`impl` 3곳에 단다(아직 프로덕션 미사용 — 없으면 clippy `-D warnings`의 dead_code로 커밋 불가). **Task 2가 3곳 모두 제거한다.**

- [ ] **Step 1: 실패하는 단위 테스트 작성**

`runner.rs`의 `mod tests` 안, `fn rate_at_piecewise_linear` 테스트 함수의 닫는 `}` 뒤(모듈 닫는 `}` 앞)에 추가:

```rust
    fn st(target: u32, duration_seconds: u32) -> Stage {
        Stage {
            target,
            duration_seconds,
        }
    }

    /// 독립 기준 Λ(Σdur): 구현의 `cum0`을 재사용하지 않고 stage별 사다리꼴을 따로 합한다
    /// (같은 오류를 같이 품지 않도록 — spec §6.1 b).
    fn lambda_ref(stages: &[Stage]) -> f64 {
        let mut prev = 0.0_f64;
        let mut sum = 0.0_f64;
        for s in stages {
            let t = f64::from(s.target);
            sum += (prev + t) / 2.0 * f64::from(s.duration_seconds);
            prev = t;
        }
        sum
    }

    /// [0, T=Σdur)에 드는 도착 시도 수 — 스케줄러 곡선 분기와 같은 질의(k+½).
    fn arrivals_before_end(stages: &[Stage]) -> u64 {
        let end: f64 = stages.iter().map(|s| f64::from(s.duration_seconds)).sum();
        let mut sched = ArrivalSchedule::new(stages);
        let mut k = 0u64;
        while let Some(t) = sched.time_at(k as f64 + 0.5) {
            if t >= end {
                break;
            }
            k += 1;
        }
        k
    }

    #[test]
    fn arrival_schedule_matches_closed_form_on_single_ramp() {
        // [{5,10}]: rate(t)=t/2 → Λ(t)=t²/4 → Λ⁻¹(m)=√(4m). (§6.1 a)
        let mut s = ArrivalSchedule::new(&[st(5, 10)]);
        for k in 0..25u64 {
            let m = k as f64 + 0.5;
            let got = s.time_at(m).expect("within the curve");
            assert!((got - (4.0 * m).sqrt()).abs() < 1e-9, "k={k} got={got}");
        }
    }

    #[test]
    fn arrival_schedule_count_rounds_cumulative_area() {
        // (§6.1 b) 곡선마다 [0, Σdur)의 도착 수가 독립 Λ(Σdur)의 ±½ 안.
        // 바깥은 배열(by-ref 순회만 하므로 vec!이면 clippy::useless_vec — -D warnings).
        let curves: [Vec<Stage>; 10] = [
            vec![st(5, 10)],                                 // §B34 재현 1 (Λ=25)
            vec![st(10, 6)],                                 // §B34 재현 2 / 2워커 몫 (Λ=30)
            vec![st(20, 6)],                                 // §B34 재현 3 (Λ=60)
            vec![st(20, 1), st(20, 7)],                      // §B34 대조 (Λ=150)
            vec![st(100, 1), st(100, 1)],                    // ramp + hold
            vec![st(0, 1), st(10, 2)],                       // 선행 0 hold
            vec![st(10, 1), st(10, 1), st(0, 1)],            // 0으로 끝나는 ramp-down
            vec![st(30, 2), st(10, 3), st(50, 1), st(0, 2)], // 상승/하강 다구간
            vec![st(7, 3)],                                  // 비정수 Λ=10.5 (Review Focus 4)
            vec![st(1000, 2), st(1000, 6)],                  // US2 고레이트 곡선 (Λ=7000)
        ];
        for c in &curves {
            let want = lambda_ref(c);
            let got = arrivals_before_end(c) as f64;
            assert!(
                (got - want).abs() <= 0.5,
                "curve={c:?} got={got} Λ={want}"
            );
        }
    }

    #[test]
    fn arrival_schedule_cursor_is_monotone_and_matches_fresh() {
        // (§6.1 c ①②) 연속 결과 비감소 + 재사용 인스턴스 == 매번 fresh 인스턴스(낡은 커서 검출).
        // 면적 190, 꼬리 rate 20 → k≥190은 곡선 끝 이후 연장 구간까지 지난다.
        let c = [st(30, 2), st(10, 3), st(50, 1), st(0, 2), st(20, 2)];
        let mut reused = ArrivalSchedule::new(&c);
        let mut prev = 0.0_f64;
        for k in 0..200u64 {
            let m = k as f64 + 0.5;
            let r = reused.time_at(m);
            let fresh = ArrivalSchedule::new(&c).time_at(m);
            assert_eq!(r, fresh, "k={k}");
            let t = r.expect("tail rate 20 keeps arrivals reachable");
            assert!(t >= prev, "k={k}: {t} < {prev}");
            prev = t;
        }
    }

    #[test]
    fn arrival_schedule_scan_count_is_amortized_constant() {
        // (§6.1 c ③, G2) 1000-stage 곡선(10↔20 rps 교대, 각 1s, 면적 14990)을 끝 근처까지 질의.
        // 총 구간 검사 수 ≤ 호출 수 + stage 수. 커서를 매 호출 처음부터 훑으면 ~7.5M으로 RED.
        let c: Vec<Stage> = (0..1000)
            .map(|i| st(if i % 2 == 0 { 10 } else { 20 }, 1))
            .collect();
        let n = (lambda_ref(&c) - 1.0).floor() as u64;
        let mut s = ArrivalSchedule::new(&c);
        for k in 0..n {
            assert!(s.time_at(k as f64 + 0.5).is_some(), "k={k}");
        }
        let bound = n + s.segs.len() as u64;
        assert!(
            s.scans <= bound,
            "scans={} > N+segs={bound}: cursor rescans from the start (G2 regression)",
            s.scans
        );
    }

    #[test]
    fn arrival_schedule_skips_zero_rate_hold() {
        // (§6.1 d) 선행 0 hold는 Λ가 평평 → 첫 도착은 hold 뒤.
        let mut s = ArrivalSchedule::new(&[st(0, 2), st(10, 2)]);
        let t = s.time_at(0.5).expect("second stage has area");
        assert!(t >= 2.0, "first arrival must land after the 0-rate hold, got {t}");
    }

    #[test]
    fn arrival_schedule_exhausts_when_curve_ends_at_zero() {
        // (§6.1 e) 면적 20, 꼬리 rate 0 → 20번째 이후 도달 불가.
        let mut s = ArrivalSchedule::new(&[st(10, 2), st(0, 2)]);
        let t = s.time_at(19.5).expect("inside the ramp-down");
        assert!(t < 4.0, "{t}");
        assert_eq!(s.time_at(20.5), None);
    }

    #[test]
    fn arrival_schedule_extends_past_end_at_last_target() {
        // (§6.1 f) 면적 5, 끝 이후는 rate_at처럼 마지막 target(10) 유지 → 1 + 0.5/10.
        let mut s = ArrivalSchedule::new(&[st(10, 1)]);
        let t = s.time_at(5.5).expect("tail rate 10");
        assert!((t - 1.05).abs() < 1e-12, "{t}");
    }

    #[test]
    fn arrival_schedule_empty_or_all_zero_curve_has_no_arrivals() {
        // (§6.1 g) 빈 stages + (Review Focus 1) fan-out 정수 분할로 몫이 0이 된 곡선.
        assert_eq!(ArrivalSchedule::new(&[]).time_at(0.5), None);
        assert_eq!(
            ArrivalSchedule::new(&[st(0, 5), st(0, 3)]).time_at(0.5),
            None
        );
    }

    #[test]
    fn arrival_schedule_zero_duration_stage_is_a_rate_jump() {
        // (Review Focus 2) 0-dur stage = rate_at의 span 0처럼 점프, area 0, inf/NaN 없음.
        // 점프 후 10 rps × 2s → Λ=20, 첫 도착 0.5/10.
        let c = [st(10, 0), st(10, 2)];
        let mut s = ArrivalSchedule::new(&c);
        assert!(s.segs.iter().all(|g| g.slope.is_finite() && g.area.is_finite()));
        let t = s.time_at(0.5).expect("second stage has area");
        assert!((t - 0.05).abs() < 1e-12, "{t}");
        assert_eq!(arrivals_before_end(&c), 20);
    }

    #[test]
    fn arrival_schedule_is_precise_at_soak_scale() {
        // (Review Focus 3) target 상한 1M × 24h ramp: Λ(t)=(1e6/86400)/2·t², 총면적 4.32e10.
        let mut s = ArrivalSchedule::new(&[st(1_000_000, 86_400)]);
        // `_f64` 접미 필수 — 없으면 `m`이 {float}로 남아 `.sqrt()`가 E0689(plan 리뷰 R1 실측).
        for m in [0.5_f64, 1e6 + 0.5, 4.32e10 - 0.5] {
            let want = (2.0 * m * 86_400.0 / 1e6).sqrt();
            let got = s.time_at(m).expect("within the curve");
            assert!(
                got.is_finite() && (got - want).abs() <= want * 1e-9,
                "m={m} got={got} want={want}"
            );
        }
    }
```

- [ ] **Step 2: 테스트가 컴파일 실패로 RED인지 확인**

Run: `cargo test -p handicap-engine --lib arrival_schedule ; echo exit=$?`
Expected: 컴파일 에러 `cannot find type \`ArrivalSchedule\`` (또는 `failed to resolve`), `exit=101`.

- [ ] **Step 3: `Seg`·`ArrivalSchedule` 구현**

`grep -n "^fn rate_at" crates/engine/src/runner.rs`로 위치를 찾고, `rate_at` 함수의 닫는 `}` 바로 뒤(빈 줄 하나 두고, `/// Closed-loop VU curve (spec §4)` doc 주석 앞)에 삽입:

```rust

/// One stage of the open-loop curve as a linear-rate segment (§B34):
/// `r(t) = r0 + slope·(t − t0)` on `[t0, t0 + dur]`, `cum0` = Λ(t0), `area` = ∫ over the stage.
#[cfg_attr(not(test), allow(dead_code))] // Task 2 wires it into run_scenario_open_loop
#[derive(Debug, Clone, Copy)]
struct Seg {
    t0: f64,
    dur: f64,
    r0: f64,
    slope: f64,
    cum0: f64,
    area: f64,
}

/// Inverse of the cumulative arrival curve Λ(t) = ∫₀ᵗ rate_at(stages, s) ds, evaluated
/// with a monotone cursor (§B34): the k-th arrival attempt fires at Λ⁻¹(k + ½), so
/// [0, T) holds Λ(T) arrivals rounded (|error| ≤ ½). Same curve as `rate_at`; 0-rate
/// stretches are skipped by the inverse itself. Callers must pass non-decreasing `m`.
#[cfg_attr(not(test), allow(dead_code))] // Task 2 wires it into run_scenario_open_loop
struct ArrivalSchedule {
    segs: Vec<Seg>,
    /// Index of the first segment that may still contain `m` — only ever moves forward,
    /// so a whole run advances it at most `segs.len()` times (amortized O(1) per arrival).
    cursor: usize,
    end_t: f64,
    end_cum: f64,
    /// Last target: past the curve's end `rate_at` holds it, and so does the inverse.
    tail_rate: f64,
    /// Segments inspected by `time_at` (test-only lock on the amortized-O(1) cursor, G2).
    #[cfg(test)]
    scans: u64,
}

#[cfg_attr(not(test), allow(dead_code))] // Task 2 wires it into run_scenario_open_loop
impl ArrivalSchedule {
    fn new(stages: &[Stage]) -> Self {
        let mut segs = Vec::with_capacity(stages.len());
        let mut t0 = 0.0_f64;
        let mut cum0 = 0.0_f64;
        let mut r0 = 0.0_f64;
        for stage in stages {
            let dur = f64::from(stage.duration_seconds);
            let target = f64::from(stage.target);
            // A 0-duration stage (controller-rejected; defensive here) is a pure rate jump
            // like `rate_at`'s span-0 case: no area, slope 0 so no inf/NaN enters the table.
            let (slope, area) = if dur > 0.0 {
                ((target - r0) / dur, (r0 + target) / 2.0 * dur)
            } else {
                (0.0, 0.0)
            };
            segs.push(Seg {
                t0,
                dur,
                r0,
                slope,
                cum0,
                area,
            });
            t0 += dur;
            cum0 += area;
            r0 = target;
        }
        Self {
            segs,
            cursor: 0,
            end_t: t0,
            end_cum: cum0,
            tail_rate: r0,
            #[cfg(test)]
            scans: 0,
        }
    }

    /// Smallest t (seconds since `started_at`) with Λ(t) = `m`; `None` if unreachable
    /// (empty stages, or the curve ends at rate 0 and `m` exceeds its total area).
    fn time_at(&mut self, m: f64) -> Option<f64> {
        while let Some(seg) = self.segs.get(self.cursor).copied() {
            #[cfg(test)]
            {
                self.scans += 1;
            }
            if seg.area > 0.0 && m <= seg.cum0 + seg.area {
                let delta = (m - seg.cum0).max(0.0);
                if delta == 0.0 {
                    return Some(seg.t0);
                }
                // slope/2·τ² + r0·τ = Δ in the cancellation-free form — one expression for
                // rising, falling and flat segments. Δ ≤ area keeps the discriminant ≥ target²,
                // so `max(0, ·)` only guards float noise; denominator > 0 because Δ > 0.
                let disc = (seg.r0 * seg.r0 + 2.0 * seg.slope * delta).max(0.0);
                let tau = 2.0 * delta / (seg.r0 + disc.sqrt());
                return Some(seg.t0 + tau.min(seg.dur));
            }
            self.cursor += 1;
        }
        if self.tail_rate > 0.0 {
            Some(self.end_t + (m - self.end_cum).max(0.0) / self.tail_rate)
        } else {
            None
        }
    }
}
```

- [ ] **Step 4: 단위 테스트 GREEN 확인**

Run: `cargo test -p handicap-engine --lib arrival_schedule ; echo exit=$?`
Expected: `test result: ok. 10 passed`(arrival_schedule_* 10개), `exit=0`.

Run: `cargo test -p handicap-engine --lib rate_at_piecewise_linear ; echo exit=$?`
Expected: `1 passed`, `exit=0`(무수정 확인).

- [ ] **Step 5: 이빨 실증 — 커서 회귀 시 c③ RED**

`time_at` 본문 첫 줄(`while let Some(seg) = …` 앞)에 임시로 `self.cursor = 0;` 한 줄을 넣는다.

Run: `cargo test -p handicap-engine --lib arrival_schedule ; echo exit=$?`
Expected: `arrival_schedule_scan_count_is_amortized_constant` **만** FAIL(메시지 `scans=7506490 > N+segs=15989` 근처 수치), 나머지 9개 pass(특히 `…matches_fresh`는 pass — ②만으로는 이 회귀를 못 잡는다는 spec §6.1 c의 주장을 실측), `exit=101`.

그 한 줄을 지우고:

Run: `cargo test -p handicap-engine --lib arrival_schedule ; echo exit=$?`
Expected: `10 passed`, `exit=0`.

Run: `git diff --stat`
Expected: `crates/engine/src/runner.rs`만 변경. (임시 줄이 남지 않았는지 `grep -n "self.cursor = 0" crates/engine/src/runner.rs` → 출력 없음.)

- [ ] **Step 6: clippy·fmt 사전 확인**

Run: `cargo fmt -p handicap-engine -- --check ; echo exit=$?`
Expected: `exit=0`(실패면 `cargo fmt -p handicap-engine` 후 재확인).

Run: `cargo clippy -p handicap-engine --all-targets -- -D warnings ; echo exit=$?`
Expected: `exit=0`(dead_code 경고 없음 — `cfg_attr` 3곳 덕분).

- [ ] **Step 7: 커밋**

Write 도구로 `.superpowers/sdd/commit-msg-task1.txt`:

```
feat(engine): ArrivalSchedule — open-loop 곡선 누적 도착 역산 Λ⁻¹ (§B34, 미배선)

k번째 도착 시도 = Λ⁻¹(k+½), Λ=∫rate_at. stage별 선형 구간 + 단조 커서
(도착당 amortized O(1), #[cfg(test)] scans로 잠금). 0-rate 구간은 역함수가
건너뛰고, 0으로 끝나는 곡선은 소진 시 None. 단위 테스트 10개(해석해 대조·
개수=Λ 반올림·단조/fresh 일치·검사 수 상한·0 hold·소진·끝 이후 연장·
빈/전부 0·0-dur·소크 규모). 스케줄러 배선은 다음 커밋.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Run: `git add crates/engine/src/runner.rs`
Run: `git diff --cached --name-only`
Expected: `crates/engine/src/runner.rs` 한 줄.
Run (FOREGROUND, timeout 600000): `git commit -F .superpowers/sdd/commit-msg-task1.txt`
Run: `git log -1 --oneline`
Expected: 방금 메시지 제목.

---

### Task 2: 스케줄러 곡선 분기를 `ArrivalSchedule`로 교체 + 엔진 통합 테스트

**Files:**
- Modify: `crates/engine/src/runner.rs` — `run_scenario_open_loop` 곡선 분기(앵커 `const RATE_EPS: f64 = 1e-9;`)·루프 끝 `next += interval;`·`RunPlan.stages` doc 주석(앵커 `scheduler drives arrivals at`)·Task 1의 `cfg_attr` 3곳 제거
- Test: `crates/engine/tests/open_loop.rs` — 헬퍼 2개 + 테스트 7개 추가, 기존 `open_loop_stages_curve_runs_and_drops_nothing_when_capacity_ample` 단언 강화

**Interfaces:**
- Consumes: Task 1의 `ArrivalSchedule::new(&[Stage])`·`time_at(&mut self, f64) -> Option<f64>`.
- Produces: 공개 API 무변경(`run_scenario_open_loop` 시그니처·`RunPlan` 필드 동일).

- [ ] **Step 1: 통합 테스트 헬퍼 + 새 테스트 작성**

`crates/engine/tests/open_loop.rs` 상단 `use` 블록의 `use std::time::Duration;`을 다음으로 바꾼다:

```rust
use std::time::{Duration, Instant};
```

`use handicap_engine::{…}` 줄은 그대로 두고, 파일 끝에 추가:

```rust
// ── §B34 curve-arrival-integral: 곡선 도착 수 = ∫rate (±1) ─────────────────────

fn st(target: u32, duration_seconds: u32) -> Stage {
    Stage {
        target,
        duration_seconds,
    }
}

/// 곡선 모드 RunPlan: duration == Σ stage durations (워커 불변식), target_rps 없음.
fn curve_plan(stages: Vec<Stage>, max_in_flight: u32) -> RunPlan {
    let secs: u64 = stages.iter().map(|s| u64::from(s.duration_seconds)).sum();
    RunPlan {
        target_rps: None,
        stages: Some(stages),
        ..plan(1, max_in_flight, secs)
    }
}

/// 곡선 run 1회: (요청 수, dropped, 경과, 결과). 시나리오는 http 스텝 1개라 요청 수 = 발사 수.
async fn run_curve(
    stages: Vec<Stage>,
    max_in_flight: u32,
    delay: Duration,
) -> (
    u64,
    u64,
    Duration,
    Result<(), handicap_engine::EngineError>,
) {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_delay(delay))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let started = Instant::now();
    let h = tokio::spawn(run_scenario_open_loop(
        scenario(&format!("{}/", server.uri())),
        curve_plan(stages, max_in_flight),
        tx,
        CancellationToken::new(),
    ));
    let mut count = 0u64;
    let mut dropped = 0u64;
    while let Some(f) = rx.recv().await {
        count += f.windows.iter().map(|w| w.count).sum::<u64>();
        dropped += f.dropped;
    }
    let res = h.await.unwrap();
    (count, dropped, started.elapsed(), res)
}

#[tokio::test]
async fn curve_slow_ramp_from_zero_fires_cumulative_area() {
    // 0→5 rps / 4s, Λ=10. 수정 전: rate(0.1)=0.125 → 8s 간격 → ~1건.
    let (count, dropped, _, res) = run_curve(vec![st(5, 4)], 50, Duration::ZERO).await;
    res.unwrap();
    assert_eq!(dropped, 0, "ample pool");
    assert!((9..=11).contains(&count), "Λ=10, got {count}");
}

#[tokio::test]
async fn curve_short_ramp_fires_cumulative_area() {
    // 0→10 rps / 3s, Λ=15. 수정 전 ~1건.
    let (count, dropped, _, res) = run_curve(vec![st(10, 3)], 50, Duration::ZERO).await;
    res.unwrap();
    assert_eq!(dropped, 0, "ample pool");
    assert!((14..=16).contains(&count), "Λ=15, got {count}");
}

#[tokio::test]
async fn curve_leading_zero_hold_then_ramp_fires_cumulative_area() {
    // 0 hold 1s → 0→10 / 2s, Λ=10. 수정 전 poll이 ~1.0s에 깨어 rate≈0 → 수 초 간격 → ~1건.
    let (count, dropped, _, res) =
        run_curve(vec![st(0, 1), st(10, 2)], 50, Duration::ZERO).await;
    res.unwrap();
    assert_eq!(dropped, 0, "ample pool");
    assert!((9..=11).contains(&count), "Λ=10, got {count}");
}

#[tokio::test]
async fn curve_ending_at_zero_drains_tail_and_ends_at_deadline() {
    // 0→10 / 1s, hold 10 / 1s, 10→0 / 1s: Λ=20. 꼬리 소진 후 deadline(3s)까지 대기 후 정상 종료.
    let (count, dropped, elapsed, res) = tokio::time::timeout(
        Duration::from_secs(15),
        run_curve(vec![st(10, 1), st(10, 1), st(0, 1)], 50, Duration::ZERO),
    )
    .await
    .expect("run must end near its 3s deadline");
    res.unwrap();
    assert_eq!(dropped, 0, "ample pool");
    assert!((19..=21).contains(&count), "Λ=20, got {count}");
    assert!(elapsed >= Duration::from_secs(3), "ended early: {elapsed:?}");
}

#[tokio::test]
async fn curve_all_zero_share_fires_nothing_and_ends_at_deadline() {
    // Review Focus 1: fan-out 정수 분할로 이 워커 몫이 전부 0인 곡선.
    let (count, dropped, elapsed, res) = tokio::time::timeout(
        Duration::from_secs(15),
        run_curve(vec![st(0, 2)], 8, Duration::ZERO),
    )
    .await
    .expect("run must end near its 2s deadline");
    res.unwrap();
    assert_eq!((count, dropped), (0, 0));
    assert!(elapsed >= Duration::from_secs(2), "ended early: {elapsed:?}");
}

#[tokio::test]
async fn curve_drop_consumes_schedule_slot() {
    // 0→50 / 2s (Λ=50), 슬롯 1개·응답 200ms → 대부분 drop. drop도 스케줄 슬롯 하나를
    // 소비하므로 시도 수(count + dropped) ≈ Λ. 스케줄을 발사 수(arrival_counter)로 구동하면
    // drop 뒤 next가 과거에 머물러 drop이 폭주한다(Review Focus 5).
    let (count, dropped, _, res) =
        run_curve(vec![st(50, 2)], 1, Duration::from_millis(200)).await;
    res.unwrap();
    assert!(dropped > 0, "1 slot × 200ms must drop (dropped={dropped})");
    let attempts = count + dropped;
    assert!(
        (49..=51).contains(&attempts),
        "Λ=50 attempts, got count={count} + dropped={dropped} = {attempts}"
    );
}

#[tokio::test]
async fn curve_cancel_during_zero_hold_aborts_promptly() {
    // 긴 0 구간(30s) 중 cancel: poll-step이 없으니 대기 select의 cancel 분기가 유일한 경로.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(32);
    let cancel = CancellationToken::new();
    let c2 = cancel.clone();
    let h = tokio::spawn(run_scenario_open_loop(
        scenario(&format!("{}/", server.uri())),
        curve_plan(vec![st(0, 30), st(10, 1)], 8),
        tx,
        cancel,
    ));
    tokio::time::sleep(Duration::from_millis(300)).await;
    c2.cancel();
    let res = tokio::time::timeout(Duration::from_secs(5), async {
        while rx.recv().await.is_some() {}
        h.await.unwrap()
    })
    .await
    .expect("cancel must return within 5s");
    assert!(matches!(res, Err(handicap_engine::EngineError::Aborted)));
}
```

기존 `open_loop_stages_curve_runs_and_drops_nothing_when_capacity_ample`의 단언

```rust
    assert!(total > 30, "expected curve to drive requests, got {total}");
```

을 다음으로 바꾼다(회귀 가드 — 수정 전에도 통과 가능, spec §6.2):

```rust
    // Λ = 0→100/1s (50) + hold 100/1s (100) = 150 (§B34).
    assert!((147..=151).contains(&total), "Λ=150, got {total}");
```

- [ ] **Step 2: 수정 전 코드에서 RED 실증**

Run: `cargo test -p handicap-engine --test open_loop curve_ ; echo exit=$?`
Expected (src 미수정 상태): 필터 `curve_`는 새 7개 + 기존 `open_loop_stages_curve_runs_and_drops_nothing_when_capacity_ample` = **8개**를 돈다. `curve_slow_ramp_from_zero_fires_cumulative_area`·`curve_short_ramp_fires_cumulative_area`·`curve_leading_zero_hold_then_ramp_fires_cumulative_area` 3개가 **FAIL**(메시지의 `got` ≈ 1~2 — plan 리뷰 실측 1·2·1), `exit=101`. 나머지(`…ending_at_zero…`·`…all_zero_share…`·`…drop_consumes…`·`…cancel…`·기존 곡선 테스트)는 수정 전 결과가 pass/fail 어느 쪽이든 무방하다(spec §6.2 — RED 요구 대상 아님; 리뷰 실측 `ending_at_zero` 17·`drop_consumes` 48로 FAIL, 기존 곡선 테스트 pass). **세 테스트의 실측 `got` 값을 커밋 메시지용으로 기록**한다. 셋 중 하나라도 pass면 STOP — 테스트가 버그를 못 보는 것이니 보고.

Run: `cargo test -p handicap-engine --test open_loop open_loop_stages_curve_runs ; echo exit=$?`
Expected: pass(강화된 [147,151]은 수정 전에도 통과 가능 — spec §6.2). fail이면 실측값을 기록하고 Step 3 후 재확인(수정 후 pass면 OK).

- [ ] **Step 3: 스케줄러 곡선 분기 교체**

(a) `grep -n "const RATE_EPS: f64 = 1e-9;" crates/engine/src/runner.rs`로 위치 확인 후, 아래 **old** 블록(Rate epsilon 주석부터 `let interval = match &curve { … };` 끝까지)을 **new** 블록으로 Edit 한다.

old:

```rust
    // Rate epsilon: below this the curve is effectively zero (a `{0, d}` hold or the
    // ramp-down tail) — fire nothing, just poll. Low-but-positive rates (e.g. 0.5 rps
    // = 2s interval) take the normal 1/rate path (no interval cap — capping distorts rate).
    const RATE_EPS: f64 = 1e-9;
    let curve = plan.stages.clone();
    // Fixed-rate interval (S-C): precomputed integer nanos → byte-identical when curve is None.
    let fixed_interval = Duration::from_nanos((1_000_000_000u64 / u64::from(target_rps)).max(1));
    let mut next = started_at;
    loop {
        if cancel.is_cancelled() || exhausted.load(Ordering::Relaxed) || Instant::now() >= deadline
        {
            break;
        }
        let now = Instant::now();
        if now < next {
            // Clamp the wait to the run deadline so curve-derived large intervals
            // (e.g. 1/tiny_rate at the start of a ramp) don't block past deadline.
            let wait = next.min(deadline).saturating_duration_since(now);
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = cancel.cancelled() => break,
            }
            continue;
        }
        // Per-iteration interval: fixed (byte-identical) or curve-derived.
        // For curves, evaluate the rate at the *scheduled* tick time (`next`), not `now`.
        // Using `now` causes tiny-rate intervals (e.g. 1/0.24 ≈ 4s) early in a ramp,
        // because `now` lags behind the scheduled tick slightly. Evaluating at `next`
        // (which is `≥ started_at`) gives the intended piecewise-linear rate.
        let interval = match &curve {
            None => fixed_interval,
            Some(stages) => {
                let next_elapsed = next.saturating_duration_since(started_at).as_secs_f64();
                let rate = rate_at(stages, next_elapsed);
                if rate <= RATE_EPS {
                    // Zero-rate region: no arrival, no drop. Poll-step with the SAME
                    // cancel-aware select so cancel/deadline stay responsive.
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                        _ = cancel.cancelled() => break,
                    }
                    next = Instant::now();
                    continue;
                }
                Duration::from_secs_f64(1.0 / rate)
            }
        };
```

new:

```rust
    // Fixed-rate interval (S-C): precomputed integer nanos → byte-identical when curve is None.
    let fixed_interval = Duration::from_nanos((1_000_000_000u64 / u64::from(target_rps)).max(1));
    // Curve mode (§B34): the k-th arrival *attempt* fires at the absolute time Λ⁻¹(k + ½),
    // Λ(t) = ∫rate_at(stages). 0-rate stretches are skipped by the inverse itself (no
    // poll-step); once no attempt remains before the deadline, `next` parks at `deadline`.
    // No empty-stages filter: `Some(vec![])` → `time_at` None → deadline, the same
    // observable behavior as before (the worker maps empty proto stages to None anyway).
    let mut schedule = plan.stages.as_deref().map(ArrivalSchedule::new);
    // Attempt index including drops — NOT `arrival_counter` (fired only, = iter_id). A
    // dropped attempt consumes its schedule slot, like the fixed path's `next += fixed_interval`;
    // driving the schedule by fired count would pin `next` in the past and storm drops.
    let mut tick: u64 = 0;
    let duration_secs = plan.duration.as_secs_f64();
    let curve_time = move |schedule: &mut ArrivalSchedule, k: u64| -> Instant {
        match schedule.time_at(k as f64 + 0.5) {
            Some(s) if s < duration_secs => started_at + Duration::from_secs_f64(s),
            _ => deadline,
        }
    };
    let mut next = match schedule.as_mut() {
        None => started_at,
        Some(s) => curve_time(s, 0),
    };
    loop {
        if cancel.is_cancelled() || exhausted.load(Ordering::Relaxed) || Instant::now() >= deadline
        {
            break;
        }
        let now = Instant::now();
        if now < next {
            // Clamp the wait to the run deadline (curve mode parks `next` at `deadline`
            // once its arrivals are exhausted, e.g. a curve ending at rate 0).
            let wait = next.min(deadline).saturating_duration_since(now);
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = cancel.cancelled() => break,
            }
            continue;
        }
```

(b) 루프 끝의 `next += interval;`(`grep -n "        next += interval;" crates/engine/src/runner.rs` — 1건)을 Edit:

old:

```rust
        next += interval;
    }
```

new:

```rust
        match schedule.as_mut() {
            None => next += fixed_interval,
            Some(s) => {
                tick += 1;
                next = curve_time(s, tick);
            }
        }
    }
```

(c) `RunPlan.stages` doc 주석(`grep -n "scheduler drives arrivals at" crates/engine/src/runner.rs`) Edit:

old:

```rust
    /// Open-loop multi-stage rate curve (S-D). `Some(non-empty)` → the open-loop
    /// scheduler drives arrivals at `rate_at(stages, elapsed)` instead of the fixed
    /// `target_rps`. `None` → fixed rate (byte-identical to S-C). The worker sets
```

new:

```rust
    /// Open-loop multi-stage rate curve (S-D). `Some(non-empty)` → the open-loop
    /// scheduler fires the k-th arrival attempt at Λ⁻¹(k + ½), Λ = ∫`rate_at(stages)`
    /// (`ArrivalSchedule`, §B34), instead of the fixed `target_rps`. `None` → fixed
    /// rate (byte-identical to S-C). The worker sets
```

(d) Task 1의 `cfg_attr` 3줄 제거: `grep -n "Task 2 wires it into run_scenario_open_loop" crates/engine/src/runner.rs` → 3건. 각 줄 `#[cfg_attr(not(test), allow(dead_code))] // Task 2 wires it into run_scenario_open_loop`를 통째로 삭제(Edit 3회).

- [ ] **Step 4: 잔재 확인**

Run: `grep -n "RATE_EPS\|let curve = \|from_millis(100)\|Task 2 wires\|next += interval" crates/engine/src/runner.rs`
Expected: 출력 없음. (`rate_at`은 `fn rate_at` 정의·VU 곡선 호출·단위 테스트에 남는다 — `grep -c "rate_at(" crates/engine/src/runner.rs`가 0이 아님을 확인.)

- [ ] **Step 5: 통합·단위 테스트 GREEN**

Run: `cargo test -p handicap-engine --test open_loop ; echo exit=$?`
Expected: 기존 5개 + 새 7개 = `12 passed`, `exit=0`.

Run: `cargo test -p handicap-engine --lib ; echo exit=$?`
Expected: 전부 pass, `exit=0`.

Run: `cargo test -p handicap-engine --test think_time ; echo exit=$?`
Expected: 전부 pass(open-loop 진입점을 직접 타는 기존 테스트 — G3 회귀 가드), `exit=0`.

- [ ] **Step 6: 이빨 실증 — drop이 스케줄 슬롯을 소비하지 않으면 RED**

Step 3(b)에서 넣은 `next = curve_time(s, tick);`를 임시로 `next = curve_time(s, arrival_counter);`로 바꾼다.

Run: `cargo test -p handicap-engine --test open_loop curve_drop_consumes_schedule_slot ; echo exit=$?`
Expected: FAIL(`attempts`가 51을 크게 넘음 — drop 폭주), `exit=101`. (빌드가 `unused variable: tick`/`value assigned is never read` 경고를 낼 수 있으나 테스트 빌드는 진행된다.)

원래대로 `next = curve_time(s, tick);`로 되돌린다.

Run: `cargo test -p handicap-engine --test open_loop curve_drop_consumes_schedule_slot ; echo exit=$?`
Expected: pass, `exit=0`.

Run: `grep -n "curve_time(s, arrival_counter)" crates/engine/src/runner.rs`
Expected: 출력 없음.

- [ ] **Step 7: fmt·clippy**

Run: `cargo fmt -p handicap-engine -- --check ; echo exit=$?`
Expected: `exit=0`(실패면 `cargo fmt -p handicap-engine` 후 재확인).

Run: `cargo clippy -p handicap-engine --all-targets -- -D warnings ; echo exit=$?`
Expected: `exit=0`.

- [ ] **Step 8: 커밋**

Write 도구로 `.superpowers/sdd/commit-msg-task2.txt`(Step 2에서 기록한 수정 전 실측값을 `<a>`·`<b>`·`<c>` 자리에 숫자로 채운다):

```
fix(engine): open-loop 곡선 도착을 누적 역산 Λ⁻¹(k+½)로 — 저레이트 무부하 해소 (§B34)

곡선 모드 다음 도착 = 1/rate_at(next) 국소 근사 → 레이트 0 근처 출발에서 첫 간격이
발산해 완만한 곡선·fan-out으로 작아진 워커 몫의 도착 대부분이 사라졌다(0→5/10s 기대
25 → 실측 1). ArrivalSchedule로 k번째 시도를 Λ⁻¹(k+½) 절대 시각에 두고, drop 포함
시도 순번 tick으로 구동(arrival_counter와 분리 — drop도 슬롯 소비). poll-step·
RATE_EPS 제거(0 구간은 역함수가 건너뛰고 소진 시 next=deadline). 고정 target_rps
경로 산술 무변경.

통합 테스트 7개: 수정 전 RED 실측 [{5,4}] got=<a>·[{10,3}] got=<b>·
[{0,1},{10,2}] got=<c> → 수정 후 ∫rate ±1. 0 꼬리 소진·전부 0 몫·drop 슬롯 소비
(arrival_counter 구동 시 RED 실증)·0 hold 중 cancel. 기존 곡선 테스트 단언을
total>30 → [147,151]로 강화.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Run: `git add crates/engine/src/runner.rs crates/engine/tests/open_loop.rs`
Run: `git diff --cached --name-only`
Expected: 두 파일.
Run (FOREGROUND, timeout 600000): `git commit -F .superpowers/sdd/commit-msg-task2.txt`
Run: `git log -1 --oneline`
Expected: 방금 메시지 제목.

---

### Task 3: 문서 — engine CLAUDE.md 함정 정정 + ADR-0032 절 단위 해소 주석

**Files:**
- Modify: `crates/engine/CLAUDE.md` — "## 다단계 ramp 곡선" 절의 첫 세 불릿(앵커 `interval 산출만 주입`·`` `rate_at`는 반드시 ``·`RATE_EPS(1e-9)`)
- Modify: `docs/adr/0032-multi-stage-open-loop-rate-curve.md` — 헤더 상태 줄 + 본문 괄호 주석 7곳(spec §3.4의 6곳 + 60행 "next+=interval" — plan 리뷰 R4가 낡는 문장 추가 발견)
- Modify: `crates/controller/CLAUDE.md` — LAN L4 불릿의 "`runner.rs:774 clamp(0,)` poll-흡수" 근거 문구(문서-only, controller 코드 0-diff 유지)

**Interfaces:**
- Consumes: Task 2의 테스트명 `curve_drop_consumes_schedule_slot`(CLAUDE.md가 가리킴), Task 1의 `ArrivalSchedule`.
- Produces: 없음(문서).

규칙(`docs/dev/root-doc-maintenance.md` §ADR 상태 갱신 규약): **ADR은 본문 재작성 금지 — 원문 문장 끝에 괄호 주석만 덧붙인다.** engine CLAUDE.md는 함정 노트라 사실이 바뀌면 문장을 교체한다(spec §3.4). 주석 날짜 `<D>` = 이 커밋을 만드는 날 — `date +%F`로 얻어 아래 모든 `<D>` 자리에 그 값을 쓴다. 규약은 주석마다 `docs/build-log.md:<줄>` 포인터를 요구하지만 그 단락은 `/finish-slice`가 만든다 → 여기선 헤더+본문 주석 8곳 모두에 자리표시 `BUILDLOG-PTR`를 그대로 쓰고, **`/finish-slice`가 build-log 단락을 쓴 직후 `BUILDLOG-PTR` 8곳을 실제 `docs/build-log.md:<줄>`로 치환**한다(아래 "완료 기록" 참조 — 치환 누락은 `grep -c BUILDLOG-PTR`가 0이 아니므로 기계적으로 보인다).

- [ ] **Step 1: engine CLAUDE.md 세 불릿 교체**

`grep -n "interval 산출만 주입\|rate_at\`는 반드시\|RATE_EPS(1e-9)" crates/engine/CLAUDE.md` → 3줄(연속). 세 줄을 통째로 다음 세 줄로 Edit:

```markdown
- **open-loop 곡선은 `run_scenario_open_loop`에 다음 도착 시각 산출만 주입 — 루프 body는 S-C와 동일** (S-D, §B34 갱신): 곡선이 정하는 건 다음 `next`뿐이고, 슬롯 try_recv→spawn / drop+yield 루프 body는 무변경. closed-loop 회귀 0 구조적 보장.
- **곡선 도착 = 누적 도착 역산 `t_k = Λ⁻¹(k+½)`(`ArrivalSchedule`), 순간 레이트 역수 `1/rate_at(next)` 금지** (curve-arrival-integral, §B34): 국소 근사는 레이트 0 근처에서 출발하면 첫 간격이 발산해, 완만한 곡선·fan-out으로 작아진 워커 몫에서 도착 대부분을 잃었다(0→5/10s 기대 25 → 실측 1 — S-D의 "`next` 기준 평가"는 `now` 대비 개선일 뿐 이걸 못 막았다). 절대 시각 스케줄이라 `next += interval` 부동소수 드리프트도 없다. **`tick`(drop 포함 시도 순번) ≠ `arrival_counter`(발사만, `iter_id`)** — 스케줄을 발사 수로 구동하면 drop 뒤 `next`가 과거에 머물러 drop이 폭주한다(`tests/open_loop.rs::curve_drop_consumes_schedule_slot`). 커서는 앞으로만 움직여 도착당 amortized O(1)(`#[cfg(test)] scans` 상한 테스트가 잠금). `+½` 위상을 `k+1`로 바꾸면 정수 Λ에서 마지막 도착이 deadline에 걸려 1건 손실.
- **0-레이트 구간은 Λ⁻¹이 건너뛴다 — poll-step 없음, 도착 소진 시 `next = deadline`** (curve-arrival-integral, S-D poll-step 대체): `{0,d}` hold·0으로 끝나는 꼬리는 `time_at`이 다음 양(+) 구간 시각 또는 `None`(→deadline)을 돌려주고, 기존 `now < next` 대기(deadline clamp + cancel select)가 그대로 잔다(cancel 응답성도 그 select가 보장). 대가: unique 데이터셋 소진 감지가 다음 예약 도착/deadline까지 늦어질 수 있다(요청 수·메트릭 동일, 종료 시각만). `rate_at`은 이제 VU 곡선(`run_scenario_vu_curve`)만 쓴다.
```

Run: `grep -n "RATE_EPS\|poll-step 100ms" crates/engine/CLAUDE.md`
Expected: 출력 없음.

- [ ] **Step 2: ADR-0032 헤더 상태 줄**

`docs/adr/0032-multi-stage-open-loop-rate-curve.md`의 `- 상태: 채택`(3행)을 Edit:

```markdown
- 상태: 채택 · §4 스케줄러 알고리즘 절 단위 해소 — 순간-레이트 역수(`1/rate_at(next)`) + poll-step을 누적 도착 역산 `Λ⁻¹(k+½)`로 교체(<D> `curve-arrival-integral`, spec `docs/superpowers/specs/2026-10-18-curve-arrival-integral-design.md`, BUILDLOG-PTR). 곡선의 의미(§3, 0에서 시작하는 piecewise-linear)는 불변.
```

- [ ] **Step 3: ADR-0032 본문 괄호 주석 7곳 (원문 무수정, 줄 끝에 덧붙이기만)**

각 Edit의 old는 원문 줄 그대로, new는 원문 + 괄호 주석이다. 모든 주석은 `<D>`·slug·`BUILDLOG-PTR`를 함께 단다(규약 — 해소 날짜 + slug + 근거 포인터).

① §4 "next 기준" 문단 끝(53행):
old: `와야 하는가"를 계산해야 ramp-up 처음부터 정확한 레이트가 나온다.`
new: `와야 하는가"를 계산해야 ramp-up 처음부터 정확한 레이트가 나온다. (→ <D> \`curve-arrival-integral\`로 대체: 이 국소 근사도 레이트 0 근처 출발에선 첫 간격이 발산했다 — 다음 도착은 이제 Λ⁻¹(k+½), \`rate_at\` 미사용, BUILDLOG-PTR)`

② poll-step 문단 끝(57행):
old: `run 종료를 블록하지 않는다.`
new: `run 종료를 블록하지 않는다. (→ <D> \`curve-arrival-integral\`로 poll-step 제거: 0 구간은 Λ⁻¹이 건너뛰고 소진 시 next=deadline. deadline clamp는 유지, BUILDLOG-PTR)`

③ "interval 계산 부분만 교체" 문단(60행) — plan 리뷰 R4 추가:
old: `body(슬롯 try_recv → spawn / drop+yield / next+=interval) 구조는 S-C와 동일하다.`
new: `body(슬롯 try_recv → spawn / drop+yield / next+=interval) 구조는 S-C와 동일하다. (→ <D> \`curve-arrival-integral\`: 곡선 모드는 이제 interval이 아니라 절대 시각 \`next = started_at + Λ⁻¹(tick+½)\`(남은 도착이 없으면 \`deadline\`)을 정한다 — 루프 body 구조 동일 원칙은 유지, BUILDLOG-PTR)`

④ §4 끝(65행):
old: `정확 적분(trapezoid 면적 역산)/Poisson 분포는 v1 외 연기.`
new: `정확 적분(trapezoid 면적 역산)/Poisson 분포는 v1 외 연기. (→ 정확 적분은 <D> \`curve-arrival-integral\`로 해소, BUILDLOG-PTR. Poisson은 여전히 연기)`

⑤ §결과 "비직관적"(107행):
old: `  그러면 ramp-start ~1 arrival 버그가 재현된다(engine CLAUDE.md 함정으로 기록).`
new: `  그러면 ramp-start ~1 arrival 버그가 재현된다(engine CLAUDE.md 함정으로 기록). (→ <D> \`curve-arrival-integral\`로 해소: next 기준 평가 자체가 사라짐, BUILDLOG-PTR)`

⑥ §결과 drop 직후 저도착(109행) — **해소 아님**:
old: `  잠시 실제 도착률이 목표보다 낮을 수 있다(정확 적분으로 해소 가능, 연기).`
new: `  잠시 실제 도착률이 목표보다 낮을 수 있다(정확 적분으로 해소 가능, 연기). (→ 정확 적분 도입(<D> \`curve-arrival-integral\`) 후에도 유지 — drop은 스케줄 슬롯을 소비한다(의도, 그 spec §3.3). 놓친 도착을 되살리지 않는다, BUILDLOG-PTR)`

⑦ §연기 "정확 적분 스케줄러"(119행):
old: `  pre-computed lookup).`
new: `  pre-computed lookup). (→ <D> \`curve-arrival-integral\`로 해소 — trapezoid 역산 + 단조 커서, BUILDLOG-PTR)`

(위 new 문자열의 `` \` ``는 마크다운 백틱 그대로 쓰라는 뜻 — 실제 파일엔 백슬래시 없이 `` ` ``.)

Run: `grep -c "curve-arrival-integral" docs/adr/0032-multi-stage-open-loop-rate-curve.md`
Expected: `8`(헤더 1 + 본문 7).

Run: `grep -c "BUILDLOG-PTR" docs/adr/0032-multi-stage-open-loop-rate-curve.md`
Expected: `8`.

Run: `git diff -U0 docs/adr/0032-multi-stage-open-loop-rate-curve.md`
Expected: 모든 `-` 줄이 대응하는 `+` 줄의 **접두**(원문 보존)이다 — 원문 단어가 바뀐 줄이 없어야 한다(헤더 3행 `- 상태: 채택`도 `- 상태: 채택 · …`의 접두라 같은 규칙을 만족).

- [ ] **Step 4: controller CLAUDE.md의 낡은 근거 문구 교체**

`crates/controller/CLAUDE.md`의 LAN L4 불릿은 곡선 0-share가 무해한 근거로 이제 존재하지 않는 poll-step을 든다(plan 리뷰 R4). 결론(무해)은 그대로, 근거만 바꾼다. 함정 노트라 문장 교체가 규약에 맞다.

Run: `grep -c "poll-흡수라 무해" crates/controller/CLAUDE.md`
Expected: `1`.

Edit:
old: `곡선 \`stage.target\`→\`proportional_split\`(0-share는 엔진 \`runner.rs:774 clamp(0,)\` poll-흡수라 무해·합=stage.target)`
new: `곡선 \`stage.target\`→\`proportional_split\`(0-share는 엔진 곡선 스케줄러가 \`ArrivalSchedule::time_at\` None → \`next = deadline\`으로 도착 0·deadline 정상 종료라 무해[curve-arrival-integral 갱신 — 구 근거 poll-흡수는 제거됨]·합=stage.target)`

(백슬래시 규칙은 Step 3과 같다.)

Run: `git diff --stat`
Expected: `crates/engine/CLAUDE.md`·`crates/controller/CLAUDE.md`·`docs/adr/0032-multi-stage-open-loop-rate-curve.md` 세 파일만(전부 `.md` — pre-commit cargo 게이트 skip).

- [ ] **Step 5: 커밋 (docs-only → pre-commit fast-path)**

Write 도구로 `.superpowers/sdd/commit-msg-task3.txt`:

```
docs: §B34 곡선 누적 도착 역산 — engine/controller CLAUDE.md 함정 정정·ADR-0032 절 단위 해소 주석

engine CLAUDE.md S-D 절: next 기준 순간 레이트·poll-step 서술을 Λ⁻¹(k+½)·tick≠
arrival_counter·0 구간 건너뜀으로 교체. controller CLAUDE.md L4: 곡선 0-share 무해
근거를 poll-흡수 → time_at None/next=deadline으로. ADR-0032: 헤더 요약 + 본문 괄호
주석 7곳(원문 무수정 — §결과의 drop 직후 저도착은 정확 적분 후에도 유지로 표기).
build-log 포인터는 BUILDLOG-PTR 자리표시 — /finish-slice가 줄번호로 치환.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Run: `git add crates/engine/CLAUDE.md crates/controller/CLAUDE.md docs/adr/0032-multi-stage-open-loop-rate-curve.md`
Run: `git diff --cached --name-only`
Expected: 세 파일.
Run (FOREGROUND, timeout 600000): `git commit -F .superpowers/sdd/commit-msg-task3.txt`
Run: `git log -1 --oneline`

---

## 최종 리뷰 (orchestrator — Task 3 후)

- `handicap-reviewer` 전체 브랜치 리뷰(BASE = Task 1 디스패치 직전 커밋 `<plan 커밋 SHA>` — `git log --oneline master..HEAD`로 확인, `HEAD~1` 금지). 엔진·동시성 경로라 `model: opus`.
- 보안 게이트: `/finish-slice` §0의 grep을 직접 돌려 판정(이 diff는 `runner.rs`만이라 무매치 예상이지만 예측 말고 grep이 지배).

## 라이브 검증 (orchestrator — 최종 리뷰 APPROVE 후, `/live-verify`)

spec §6.3. responder 50ms, 시나리오는 http 스텝 **1개**(→ `summary.count` = 도착 수). run은 `POST /api/runs {"scenario_id":…,"profile":<아래>,"env":{}}`, 결과는 `GET /api/runs/{id}/report`의 `summary.count`와 **최상위** `dropped`(`report.rs` `ReportJson.dropped`).

**페이로드 주의(코드로 확인)**: 곡선 모드는 `duration_seconds > 0`이면 400이고(`api/runs.rs`), `duration_seconds`는 serde default가 없어 키 자체는 필수다(`store/runs.rs` `Profile`) → 곡선은 `"duration_seconds":0`을 명시한다.

| US | profile | 바이너리 | 통과 신호 |
|---|---|---|---|
| US1 | `{"stages":[{"target":5,"duration_seconds":10}],"max_in_flight":50,"duration_seconds":0}` | 수정 후 | count ∈ [24,26], dropped 0 |
| US1 | `{"stages":[{"target":10,"duration_seconds":6}],"max_in_flight":50,"duration_seconds":0}` | 수정 후 | count ∈ [29,31], dropped 0 |
| US1 | `{"stages":[{"target":20,"duration_seconds":6}],"max_in_flight":50,"duration_seconds":0}` | 수정 후 | count ∈ [59,61], dropped 0 |
| US1 | 위 + `"worker_count":2` | 수정 후 | count ∈ [58,62], dropped 0 |
| US1 | `{"stages":[{"target":20,"duration_seconds":1},{"target":20,"duration_seconds":7}],"max_in_flight":50,"duration_seconds":0}` | 수정 후 | count ∈ [149,151], dropped 0 |
| US1 | 위 + `"worker_count":2` | 수정 후 | count ∈ [148,152], dropped 0 |
| US1 | `{"target_rps":20,"max_in_flight":50,"duration_seconds":8}` | 수정 전 → 수정 후 | 둘 다 ≈160, 같은 범위 |
| US1 | `{"vus":2,"duration_seconds":5}` | 수정 전 → 수정 후 | 둘 다 RPS 정상 범위(50ms → ~40 RPS), 같은 범위 |
| US2 | `{"stages":[{"target":1000,"duration_seconds":2},{"target":1000,"duration_seconds":6}],"max_in_flight":200,"duration_seconds":0}` | 수정 전 → (≥15s 간격) → 수정 후 | 둘 다 count ∈ [6930,7070]·dropped 0, 수정 후 count ≥ 수정 전 × 0.99 |

- **수정 전 실행**: `/tmp/curve-arrival-prefix/controller --worker-bin /tmp/curve-arrival-prefix/worker --db /tmp/curve-arrival-prefix.db …`(`--worker-bin` 기본값이 cwd-상대 `target/debug/worker`라 명시 필수). **수정 후**: 워크트리 root에서 fresh 빌드(`cargo build -p handicap-worker --bin worker` + `cargo build -p handicap-controller --bin controller`) 후 `./target/debug/controller --db /tmp/curve-arrival-post.db …`. UI 0-diff라 `--ui-dir`는 생략(없는 경로면 fail-fast).
- 8080 점유자가 이 repo 것이 아닐 수 있다 — 기동 전 `lsof -i :8080` + `lsof -a -p <PID> -d cwd -Fn`로 확인, 남의 것이면 `--rest 127.0.0.1:8099 --grpc 127.0.0.1:8098`.
- US2는 HTTP/1.0 responder라 요청마다 새 커넥션 — 두 7000-연결 run 사이 **15초 이상** 간격(macOS ephemeral 포트·TIME_WAIT).
- 결과 표(실측 count/dropped)는 build-log 단락에 그대로 옮긴다(`/finish-slice`).

## 완료 기록

`/finish-slice`가 한다(spec §3.4 마지막 줄): build-log 단락(라이브 표 포함)·roadmap §B34 상태·현황판 부하모델 행·루트 CLAUDE 상태줄·메모리. **이 슬라이스 고유 1스텝**: build-log 단락을 쓴 직후 그 단락 첫 줄 번호 `L`을 `grep -n`으로 얻어 ADR-0032의 `BUILDLOG-PTR` 8곳을 `` `docs/build-log.md:L` ``로 치환(Edit `replace_all`) → `grep -c BUILDLOG-PTR docs/adr/0032-multi-stage-open-loop-rate-curve.md`가 `0`이어야 머지. 그 뒤 ff-merge.

## 리뷰 기록

- plan R1 (spec-plan-reviewer, APPROVE-WITH-FIXES — 워크스페이스 스크래치 복사본에 plan 코드를 적용·1.99.1로 실빌드·실테스트): 반영 5 — (1) soak 테스트 `0.5_f64`(E0689 실측) (2) Task 2 신규 주석 `next += fixed_interval`로(Step 4 잔재 grep 자기모순) (3) ADR 주석마다 build-log 포인터 → `BUILDLOG-PTR` + finish-slice 치환 스텝 (4) 낡는 문장 2곳 추가(ADR 60행 ③·controller CLAUDE.md L4) (5) Step 2 필터가 기존 곡선 테스트 포함 8개임을 명시. **기각 1** — (6) 곡선 통합 테스트 하한 완화(Λ−3) 제안: spec §6.2가 ±1을 정했고(순수 개수 오차 ½ + deadline 직전 지터 1건), 리뷰어 자신의 스트레스 실측(12코어에 CPU 버너 14개 + 테스트 바이너리 4병렬)에서 8개 전부 매회 통과, 상한은 스케줄이 결정해 지터로 넘을 수 없음 → 완화는 이빨만 줄인다. CI에서 하한 flake가 실측되면 그때 그 테스트만 완화.
- plan R2: clean **APPROVE**. NIT 1(ADR 주석 ③의 `next = Λ⁻¹(tick+½)` 축약 → `started_at + …`/`deadline`) 반영.

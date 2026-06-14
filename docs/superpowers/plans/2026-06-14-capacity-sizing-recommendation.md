# 용량 사이징 권장 (`load_gen_saturated` enrich, Little's Law) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** open-loop run이 목표 도착률을 못 냈을 때(`dropped > 0`) 기존 `load_gen_saturated` 인사이트에 Little's Law 사이징 권장(권장 `max_in_flight` + slots/capacity 원인 힌트)을 덧붙인다.

**Architecture:** 순수 읽기경로 가산. `derive_insights`(컨트롤러)가 `summary.p50_ms`(지연 프록시)·설정 `max_in_flight`·유효 목표(`target_rps` or stages-peak)로 `required = ceil(target × p50_sec)`를 산출하고, `max_in_flight`와 비교해 slots(권장값 제시)/capacity(올려도 무익)/폴백(판별 불가)으로 분기한다. `Insight` 구조체에 `recommended`/`cause` optional 필드 2개를 가산하고 UI가 cause로 행동 줄을 분기 렌더한다. **엔진·워커·proto·migration·골든 fixture 무변경. `dropped == 0` → 리포트 byte-identical.**

**Tech Stack:** Rust(controller `insights.rs`/`report.rs`/`export.rs`) + TypeScript/React(`schemas.ts` Zod / `ko.ts` / `InsightPanel.tsx`).

**Spec:** `docs/superpowers/specs/2026-06-14-capacity-sizing-recommendation-design.md`

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `crates/controller/src/insights.rs` | 인사이트 파생 로직 | `Insight` 2필드 + `derive_insights` 시그니처 +2 + 사이징 계산 + 단위 테스트 |
| `crates/controller/src/report.rs` | 리포트 빌드(유일 prod 호출부) | `derive_insights` 호출에 `max_in_flight`·유효목표 주입 + 배선 테스트 |
| `crates/controller/src/export.rs` | XLSX export(컴파일러-강제 struct 리터럴) | `Insight {…}` 리터럴에 `recommended: None, cause: None` |
| `ui/src/api/schemas.ts` | 응답 Zod 스키마 | `InsightSchema`에 `recommended`/`cause` `.optional()` |
| `ui/src/i18n/ko.ts` | 한국어 문구 카탈로그 | `saturation.slots`(함수)·`saturation.capacity` |
| `ui/src/components/report/InsightPanel.tsx` | 인사이트 렌더 | `n()` 모듈 호이스트 + `actionFor()` cause 분기 + JSX 교체 |
| `ui/src/components/report/__tests__/InsightPanel.test.tsx` | 렌더 테스트 | slots/capacity/폴백 케이스 |

**커밋 경계 (repo 게이트 제약):** pre-commit이 cargo-영향 커밋마다 전체 워크스페이스를 돌려 dead-code/RED 단독 커밋이 불가하므로 **Task 1은 헬퍼+로직+호출부+테스트를 한 green 커밋으로 fold**(spec §9.1). Task 2(UI)는 별도 커밋. tdd-guard: `insights.rs`/`report.rs`/`export.rs`는 디스크에 인라인 `#[cfg(test)] mod tests`가 이미 있어 편집이 자동 통과(keepalive stub 불요).

---

## Task 1: Rust 백엔드 — `Insight` 필드 + 사이징 로직 + 배선 (한 green 커밋)

**Files:**
- Modify: `crates/controller/src/insights.rs` (`Insight` struct + `Insight::new` + `derive_insights` + tests)
- Modify: `crates/controller/src/report.rs:557-565` (호출부) + 테스트 추가
- Modify: `crates/controller/src/export.rs:498-508` (struct 리터럴)

> **TDD 주의**: `derive_insights` 시그니처를 바꾸면 22개 테스트 호출부 + export.rs 리터럴이 동시에 컴파일 에러를 낸다(컴파일러-강제). 그래서 strict RED→GREEN을 파일 단위로 못 쪼갠다 — **구조체/시그니처/로직/호출부 갱신을 먼저 컴파일-green으로 만든 뒤, 새 테스트로 동작을 검증**한다. 전체를 한 커밋으로.

- [ ] **Step 1: `Insight` 구조체에 필드 2개 + `Insight::new` 초기화 추가**

`crates/controller/src/insights.rs` — `window_seconds` 필드 바로 뒤(현 `:26` 다음)에 추가:

```rust
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_seconds: Option<i64>,
    /// 권장 max_in_flight (slot-bound일 때만 Some, 정수값). Little's Law: ceil(target × p50_sec).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended: Option<f64>,
    /// 사이징 원인: "slots"(max_in_flight 올려라) | "capacity"(CPU/SUT 한계). None = 판별 불가.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
```

`Insight::new`(현 `:29-42`)의 `window_seconds: None,` 뒤에 추가:

```rust
            window_seconds: None,
            recommended: None,
            cause: None,
```

- [ ] **Step 2: `derive_insights` 시그니처에 파라미터 2개 + 사이징 계산 추가**

`crates/controller/src/insights.rs` — 시그니처(현 `:63-71`)의 `dropped: u64,` 뒤에 두 줄 추가:

```rust
    scenario_yaml: &str,
    dropped: u64,
    max_in_flight: Option<u32>,
    target_rps: Option<u32>,
) -> Vec<Insight> {
```

기존 `if dropped > 0 { … }` 블록(현 `:193-207`)을 통째로 아래로 교체(앞부분 peak 계산은 동일, `out.push(ins);` 전에 사이징 추가):

```rust
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

        // Little's Law 사이징: 목표 도착률을 관측(중앙값) 지연에서 내려면 필요한 동시 슬롯.
        // p50==0(localhost sub-ms) 또는 profile 부재 → 판별 불가(cause None, A9 폴백).
        let l_sec = summary.p50_ms as f64 / 1000.0;
        let required: Option<u64> = if l_sec > 0.0 {
            target_rps.map(|t| ((t as f64) * l_sec).ceil().max(1.0) as u64)
        } else {
            None
        };
        match (required, max_in_flight) {
            (Some(req), Some(m)) if (m as u64) < req => {
                // 슬롯이 목표에 수학적으로 부족 → 올리는 게 해법.
                ins.cause = Some("slots".to_string());
                ins.recommended = Some(req as f64);
            }
            (Some(_), Some(_)) => {
                // 슬롯은 충분했는데 포화 → 한계는 워커 CPU/대상 서버. 올려도 무익.
                ins.cause = Some("capacity".to_string());
            }
            _ => {} // 폴백: cause/recommended None 유지
        }
        out.push(ins);
    }
```

- [ ] **Step 3: 모든 컴파일러-강제 사이트 갱신 (prod 호출부 + export 리터럴 + 22 테스트 호출부)**

(a) `crates/controller/src/report.rs:557-565` 호출부를 교체:

```rust
    let insights = crate::insights::derive_insights(
        &summary,
        &steps,
        &windows,
        &status_dist,
        verdict.as_ref(),
        scenario_yaml,
        run.dropped as u64,
        run.profile.max_in_flight,
        run.profile.target_rps.or_else(|| {
            run.profile
                .stages
                .as_ref()
                .and_then(|s| s.iter().map(|st| st.target).max())
        }),
    );
```

(b) `crates/controller/src/export.rs:498-508`의 `Insight {…}` 리터럴에 두 필드 추가(`window_seconds: None,` 뒤):

```rust
            status_class: None,
            window_seconds: None,
            recommended: None,
            cause: None,
        }];
```

(c) `crates/controller/src/insights.rs`의 `#[cfg(test)] mod tests` 안 **모든** `derive_insights(...)` 호출(22곳, 현 `:278`부터)의 닫는 괄호 직전에 `, None, None`을 추가한다. 기존 호출은 `…, "", 0)` / `…, "", 5)` / `…, "", 7)` 등 `dropped` 인자로 끝나므로 → `…, "", 0, None, None)` 형태로. 빠진 곳이 없는지 다음으로 교차검증:

```bash
grep -c 'derive_insights' crates/controller/src/insights.rs   # 호출 총수 확인
```

- [ ] **Step 4: 워밍 빌드 + 컴파일 green 확인**

cold-build flake 회피로 워커를 먼저 워밍한 뒤 워크스페이스 빌드:

```bash
cargo build -p handicap-worker && cargo build --workspace 2>&1 | tail -20
```
Expected: 에러 0(경고도 없어야 clippy 게이트 통과). `missing field` 에러가 나면 빠뜨린 struct 리터럴/호출부가 있는 것.

- [ ] **Step 5: 새 단위 테스트 작성 (insights.rs)**

`crates/controller/src/insights.rs`의 `mod tests` 끝(마지막 테스트 `saturation_falls_back_to_summary_rps` ~`:701` 뒤)에 추가:

```rust
    #[test]
    fn saturated_slots_recommends_when_underprovisioned() {
        // target 10000 RPS at p50=50ms → required = ceil(10000*0.05) = 500;
        // max_in_flight=100 < 500 → slots, recommended=500. value/count(A9)는 불변.
        let mut s = summary();
        s.p50_ms = 50;
        let windows = vec![win_count(0, "a", 120)];
        let got = derive_insights(
            &s, &[], &windows, &BTreeMap::new(), None, "", 7, Some(100), Some(10_000),
        );
        let ins = got
            .iter()
            .find(|i| i.kind == "load_gen_saturated")
            .expect("load_gen_saturated present");
        assert_eq!(ins.cause.as_deref(), Some("slots"));
        assert_eq!(ins.recommended, Some(500.0));
        assert_eq!(ins.count, Some(7)); // dropped 불변
        assert_eq!(ins.value, Some(120.0)); // peak 불변
    }

    #[test]
    fn saturated_capacity_when_slots_sufficient() {
        // 같은 target/지연, max_in_flight=2000 ≥ 500 → 슬롯 충분 → capacity, recommended None.
        let mut s = summary();
        s.p50_ms = 50;
        let got = derive_insights(
            &s, &[], &[], &BTreeMap::new(), None, "", 7, Some(2000), Some(10_000),
        );
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.cause.as_deref(), Some("capacity"));
        assert_eq!(ins.recommended, None);
    }

    #[test]
    fn saturated_sizing_falls_back_when_latency_zero() {
        // p50==0(localhost sub-ms) → 판별 불가 → cause None. 인사이트 자체는 emit.
        let s = summary(); // p50_ms = 0
        let got = derive_insights(
            &s, &[], &[], &BTreeMap::new(), None, "", 7, Some(100), Some(10_000),
        );
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.cause, None);
        assert_eq!(ins.recommended, None);
        assert_eq!(ins.count, Some(7)); // A9 필드는 그대로 present
    }

    #[test]
    fn saturated_sizing_falls_back_when_max_in_flight_absent() {
        // max_in_flight None → 분류 불가(폴백). (prod 불가 케이스지만 방어.)
        let mut s = summary();
        s.p50_ms = 50;
        let got = derive_insights(
            &s, &[], &[], &BTreeMap::new(), None, "", 7, None, Some(10_000),
        );
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.cause, None);
        assert_eq!(ins.recommended, None);
    }

    #[test]
    fn saturated_small_required_rounds_up_to_one() {
        // 작은 target×지연(0.5)이 0으로 *내림*되지 않고 ceil로 1이 됨(required≥1, 0 권장 방지).
        // target=10, p50=50ms → 10*0.05=0.5 → ceil → 1. max_in_flight=0 < 1 → slots, recommended 1.0.
        // (.max(1.0)는 target=0 같은 불가-입력 방어 — 이 테스트가 검증하는 건 ceil 올림.)
        let mut s = summary();
        s.p50_ms = 50;
        let got = derive_insights(
            &s, &[], &[], &BTreeMap::new(), None, "", 7, Some(0), Some(10),
        );
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.cause.as_deref(), Some("slots"));
        assert_eq!(ins.recommended, Some(1.0));
    }
```

- [ ] **Step 6: 새 배선 테스트 작성 (report.rs)**

> **기존 A9 배선 테스트가 이미 있다**: `build_report_surfaces_saturation_insight`(현 `:1476`) · `build_report_no_saturation_when_not_dropped`(현 `:1502`, dropped=0 → `load_gen_saturated` 부재 = byte-identical 회귀 가드). **dropped=0 회귀는 이 기존 테스트가 커버하므로 새로 만들지 않는다.** 새 사이징 테스트 2개를 이 기존 saturation 테스트들 **바로 옆**(현 `:1507` 근처, `build_report_no_saturation_when_not_dropped` 뒤)에 두어 지역성을 유지한다.

`win`(6-인자 `WindowWithHdr` 빌더, µs 샘플) + `run_row()`(기본 profile) 재사용:

```rust
    #[test]
    fn build_report_sizing_slots_recommendation() {
        // open-loop: target 10000, max_in_flight=100(<500 needed at p50=50ms), dropped>0
        // → load_gen_saturated에 cause="slots", recommended=500.
        let mut run = run_row();
        run.profile.target_rps = Some(10_000);
        run.profile.max_in_flight = Some(100);
        run.dropped = 200;
        // 50ms(=50_000µs) 샘플 100개 → overall p50_ms ≈ 50.
        let rows = vec![win(100, "s", 100, 0, r#"{"200":100}"#, &[50_000; 100])];
        let rep = build_report(&run, "", &rows, &[], &[], &[], &[], &[]);
        let ins = rep
            .insights
            .iter()
            .find(|i| i.kind == "load_gen_saturated")
            .expect("saturation insight");
        assert_eq!(ins.cause.as_deref(), Some("slots"));
        assert_eq!(ins.recommended, Some(500.0));
        assert_eq!(ins.count, Some(200));
    }

    #[test]
    fn build_report_sizing_uses_stages_peak() {
        // target_rps 없음, stages-peak=12000 주입 → required=ceil(12000*0.05)=600.
        // max_in_flight=100 < 600 → slots, recommended=600. (유효목표 산출=report.rs 책임.)
        let mut run = run_row();
        run.profile.target_rps = None;
        run.profile.stages = Some(vec![
            handicap_engine::Stage { target: 4000, duration_seconds: 10 },
            handicap_engine::Stage { target: 12000, duration_seconds: 10 },
        ]);
        run.profile.max_in_flight = Some(100);
        run.dropped = 50;
        let rows = vec![win(100, "s", 100, 0, r#"{"200":100}"#, &[50_000; 100])];
        let rep = build_report(&run, "", &rows, &[], &[], &[], &[], &[]);
        let ins = rep
            .insights
            .iter()
            .find(|i| i.kind == "load_gen_saturated")
            .expect("saturation insight");
        assert_eq!(ins.recommended, Some(600.0));
        assert_eq!(ins.cause.as_deref(), Some("slots"));
    }
```

(dropped=0 → 포화 인사이트 부재는 기존 `build_report_no_saturation_when_not_dropped`(`:1502`)가 이미 검증 — 중복 추가 금지.)

- [ ] **Step 7: 컨트롤러 테스트 실행 → green 확인**

```bash
cargo build -p handicap-worker && cargo nextest run -p handicap-controller 2>&1 | tail -25
```
(nextest 미설치면 `cargo test -p handicap-controller`.) Expected: 새 7개 테스트 + 기존 전부 PASS, 0 fail. 신규 = `saturated_*`(5, insights.rs) + `build_report_sizing_*`(2, report.rs). 기존 A9 `build_report_no_saturation_when_not_dropped`도 계속 PASS(회귀 가드).

- [ ] **Step 8: clippy 게이트 확인**

```bash
cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -15
```
Expected: 경고 0.

- [ ] **Step 9: 커밋 (foreground, 파이프 금지)**

```bash
git add crates/controller/src/insights.rs crates/controller/src/report.rs crates/controller/src/export.rs
git commit -m "feat(controller): load_gen_saturated 사이징 권장(Little's Law)

dropped>0일 때 max_in_flight vs ceil(target×p50)로 slots(권장값)/
capacity(올려도 무익)/폴백 분기. Insight에 recommended/cause 2필드 가산,
유효목표는 report.rs에서 target_rps or stages-peak 주입. p50==0 폴백.
엔진·워커·proto·migration 무변경, dropped==0 byte-identical.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
커밋 후 `git log -1 --stat`로 landed 확인(파이프로 git exit code 마스킹 금지 — 루트 CLAUDE.md).

---

## Task 2: UI — Zod 필드 + 문구 + cause 분기 렌더

**Files:**
- Modify: `ui/src/api/schemas.ts:335-345` (`InsightSchema`)
- Modify: `ui/src/i18n/ko.ts:308-318` (`saturation` 키)
- Modify: `ui/src/components/report/InsightPanel.tsx` (`n()` 호이스트 + `actionFor` + JSX)
- Modify: `ui/src/components/report/__tests__/InsightPanel.test.tsx`

> tdd-guard: 이 task는 `__tests__/InsightPanel.test.tsx`(pending test 파일)를 먼저 갱신하므로 src 편집이 자연히 unblock된다.

- [ ] **Step 1: 실패 테스트 작성 (InsightPanel.test.tsx)**

`ui/src/components/report/__tests__/InsightPanel.test.tsx`의 `describe` 끝(현 `:69` `});` 앞)에 추가. **폴백(cause 없음)은 기존 테스트 `:50` `load_gen_saturated 헤드라인과 다음 행동을 렌더한다`가 이미 커버**(cause 없는 fixture → A9 일반 행동 줄 `/대상 서버의 한계, 아니면 테스트 도구/`)하므로 새로 안 만든다 — slots/capacity 2개만:

```tsx
  it("load_gen_saturated slots — 권장 max_in_flight를 행동 줄에 렌더", () => {
    const insights: Insight[] = [
      {
        kind: "load_gen_saturated",
        severity: "warning",
        value: 7500,
        count: 320,
        cause: "slots",
        recommended: 500,
      },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/초당 최대 7,500건.*못 보낸 요청이 320건/)).toBeInTheDocument();
    expect(screen.getByText(/최소 ~500로 올려/)).toBeInTheDocument();
  });

  it("load_gen_saturated capacity — 올려도 안 늘어요 행동 줄", () => {
    const insights: Insight[] = [
      { kind: "load_gen_saturated", severity: "warning", value: 9000, count: 12, cause: "capacity" },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/max_in_flight를 올려도 처리량은 안 늘어요/)).toBeInTheDocument();
  });
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
cd ui && pnpm test InsightPanel 2>&1 | tail -20
```
Expected: 새 2개 FAIL(slots/capacity 문구 미존재 — `cause`/`recommended`가 아직 InsightSchema에 없어 타입/런타임 미반영). 기존 6개는 PASS.

- [ ] **Step 3: `InsightSchema`에 Zod 필드 2개 추가**

`ui/src/api/schemas.ts`의 `InsightSchema`(현 `:335-345`)에서 `window_seconds` 줄 뒤에 추가:

```ts
  status_class: z.string().optional(),
  window_seconds: z.number().int().optional(),
  recommended: z.number().optional(),
  cause: z.string().optional(),
});
```
(백엔드 `skip_serializing_if`로 None은 생략되므로 **`.optional()`**, `.nullish()` 아님 — controller/ui CLAUDE.md.)

- [ ] **Step 4: `ko.ts`에 `saturation` 문구 추가**

`ui/src/i18n/ko.ts`의 `insightActions: { … }` 닫는 `},`(현 `:318`) 뒤, `} as const;` 앞에 추가(`insightActions.load_gen_saturated`는 폴백으로 유지):

```ts
  },
  // 사이징 권장(load_gen_saturated cause 분기) — slots는 권장 max_in_flight 숫자를 받는다.
  saturation: {
    slots: (rec: string) =>
      `동시 실행 수(max_in_flight)가 목표에 비해 작아요 — 최소 ~${rec}로 올려 다시 실행하세요. ` +
      `(에러·지연이 함께 높으면 대상 서버가 한계라 슬롯만 늘려선 처리량이 안 늘 수 있어요.)`,
    capacity:
      `동시 실행 수(max_in_flight)는 목표에 충분했어요 — 한계는 테스트 도구(워커 CPU)나 ` +
      `대상 서버입니다. max_in_flight를 올려도 처리량은 안 늘어요.`,
  },
} as const;
```

- [ ] **Step 5: `InsightPanel.tsx` — `n()` 호이스트 + `actionFor` + JSX 교체**

(a) `message()` 내부(현 `:24`)의 `const n = …`를 제거하고 **모듈 스코프**로 호이스트(현 `:18` `pctStr` 옆):

```ts
function pctStr(v: number | undefined): string {
  return v === undefined ? "" : `${(v * 100).toFixed(1)}%`;
}

// 천단위 구분 — locale 고정(CI ICU 빌드 무관, RTL "1,203건" 단언).
function n(v: number | undefined): string {
  return (v ?? 0).toLocaleString("en-US");
}
```
그리고 `message()` 안의 `const n = (v…) => …;` 줄을 삭제(본문은 이미 `n(...)` 호출이라 무변경).

(b) `message()` 함수 뒤에 `actionFor` 추가:

```ts
function actionFor(i: Insight): string | undefined {
  if (i.kind === "load_gen_saturated") {
    if (i.cause === "slots") return ko.saturation.slots(n(i.recommended));
    if (i.cause === "capacity") return ko.saturation.capacity;
    return ko.insightActions.load_gen_saturated; // 폴백(A9 일반)
  }
  return ACTIONS[i.kind];
}
```

(c) 렌더(현 `:62-68`)의 행동 줄을 `actionFor(i)`로 교체:

```tsx
            <div>{message(i, meta)}</div>
            {(() => {
              const action = actionFor(i);
              return action ? (
                <div className="mt-0.5 text-xs opacity-90">
                  <span aria-hidden="true">→ </span>
                  {action}
                </div>
              ) : null;
            })()}
```

- [ ] **Step 6: 테스트 통과 확인**

```bash
cd ui && pnpm test InsightPanel 2>&1 | tail -20
```
Expected: 8개 전부 PASS(기존 6 + 신규 2: slots/capacity).

- [ ] **Step 7: 전체 UI 게이트 (lint + 전체 test + build)**

```bash
cd ui && pnpm lint && pnpm test 2>&1 | tail -15 && pnpm build 2>&1 | tail -15
```
Expected: lint 경고 0(`--max-warnings=0`), 전체 스위트 PASS(다른 파일 회귀 없음 — `pnpm test InsightPanel` 단독 green ≠ 전체 green, 루트/ui CLAUDE.md), `tsc -b` 0 에러(Zod nested-default 누출 등).

- [ ] **Step 8: 커밋 (foreground, 파이프 금지)**

```bash
git add ui/src/api/schemas.ts ui/src/i18n/ko.ts ui/src/components/report/InsightPanel.tsx ui/src/components/report/__tests__/InsightPanel.test.tsx
git commit -m "feat(ui): load_gen_saturated 사이징 권장 렌더(cause 분기)

InsightSchema recommended/cause(.optional()) + ko.saturation.slots/capacity
+ InsightPanel actionFor(cause로 행동 줄 분기, n() 모듈 호이스트). 폴백은
A9 일반 문구 유지. slots=권장 max_in_flight 숫자, capacity=올려도 무익.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
커밋 후 `git log -1 --stat` 확인.

---

## Task 3: 라이브 검증 + 머지

**TDD/게이트로 안 잡히는 것**: 실제 open-loop run의 `/report` JSON에 사이징이 와이어로 실리는지 + 실브라우저 InsightPanel 두 줄 렌더 + p50>0 보장(localhost sub-ms 함정). spec §6.4.

- [ ] **Step 1: 워크트리 자체 바이너리 빌드 (stale 메인 바이너리 회피)**

워크트리 root에서(절대경로 메인 바이너리 금지 — 루트 CLAUDE.md):

```bash
cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller && (cd ui && pnpm build)
```

- [ ] **Step 2: 지연 있는 responder + controller 기동**

`p50_ms > 0`을 보장하려면 responder가 **수십 ms 인공 지연**을 줘야 한다(0ms면 §2.4 폴백이라 권장이 안 뜸 — Slice 5 함정). python `ThreadingHTTPServer` 200-responder에 `time.sleep(0.05)`(50ms) 추가해 기동(루트 CLAUDE.md "RPS로 수동 검증" 레시피). 격리 DB로 controller 기동:

```bash
./target/debug/controller --db /tmp/sizing-live.db --ui-dir ui/dist
```

- [ ] **Step 3: slots 케이스 — 작은 max_in_flight로 open-loop run**

curl로 시나리오 생성(50ms responder url) + open-loop run(`target_rps` 높게, `max_in_flight` 작게 — 예 `target_rps:2000, max_in_flight:20`, `duration_seconds`). run 종료 후 `/report` JSON 확인:

```bash
curl -s localhost:8080/api/runs/<run_id>/report | python3 -c "import sys,json; r=json.load(sys.stdin); print([i for i in r['insights'] if i['kind']=='load_gen_saturated'])"
```
Expected: `cause:"slots"`, `recommended ≈ target × p50_sec`(예 2000×0.05=100 근처), `count`=dropped(>0), `value`=peak.

- [ ] **Step 4: capacity 케이스 — 충분한 max_in_flight로 같은 목표 재실행**

같은 목표에 `max_in_flight`를 크게(≥required, 예 `max_in_flight:500`) 잡아 다시 run. responder 지연이 슬롯을 채워 여전히 `dropped>0`이면(또는 SUT가 못 따라가면) → `cause:"capacity"`, `recommended` 부재 확인. (dropped가 0이 되면 인사이트 자체가 없으니, capacity를 보려면 지연/목표를 조정해 슬롯은 남되 처리량이 목표 미달이 되게 — responder 지연을 키워 SUT-bound 유발.)

- [ ] **Step 5: 실브라우저 InsightPanel 확인 (Playwright)**

run 상세 리포트 페이지에서 `browser_evaluate`(인라인, `filename` 없이 — 루트 CLAUDE.md)로 InsightPanel 카드 텍스트를 추출: slots run이면 "최소 ~N로 올려" 두 줄 + 앰버 카드, 콘솔 Zod 에러 0. closed-loop run(또는 dropped=0)은 사이징 줄 부재.

- [ ] **Step 6: 정리 + 머지**

`rm -rf .playwright-mcp` + 루트 png 정리(머지 전 untracked 잔류 방지). 메인 클린·ff 가능 확인 후:

```bash
git -C /Users/sgj/develop/handicap merge --ff-only worktree-capacity-sizing-insight
```
(사전 `git -C /Users/sgj/develop/handicap merge-base --is-ancestor master worktree-capacity-sizing-insight` + `status --porcelain -uno` 클린 확인. 세션 중 master 전진 시 rebase 후 ff.) 머지 확인 후 `ExitWorktree(remove, discard_changes:true)`.

---

## Self-Review 체크 (작성자)

- **Spec 커버리지**: §3 트리거/계산 → Task1 Step2; §3.3 필드 → Step1; §4 UI 문구 → Task2 Step4-5; §5 파일표(insights/report/export/schemas/ko/InsightPanel) → 전부 매핑; §6 불변식 → 기존 `build_report_no_saturation_when_not_dropped`(byte-identical 회귀 가드, 재사용)·폴백(기존 UI 테스트 `:50`); §7 테스트 → Task1 Step5-6, Task2 Step1; §7.4 라이브 → Task3. **export.rs(reviewer 추가) 커버됨**(Task1 Step3b).
- **Placeholder 스캔**: 모든 코드 스텝에 실제 코드 블록·정확 경로·기대 출력 포함. 없음.
- **타입 일관성**: `recommended: Option<f64>`(Rust) ↔ `z.number().optional()`(Zod) ↔ `i.recommended`(TS); `cause: Option<String>`/`"slots"`/`"capacity"` ↔ `z.string().optional()` ↔ `i.cause==="slots"`; `derive_insights(...)` 인자 순서 `… dropped, max_in_flight, target_rps`가 Task1 Step2 시그니처 ↔ Step3a 호출부 ↔ Step5 테스트 호출 전부 일치; `ko.saturation.slots(rec: string)` ↔ `actionFor`의 `ko.saturation.slots(n(i.recommended))` 일치.

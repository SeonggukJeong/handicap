# report-advice-noise Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** run 종료 리포트의 조언 표면 밀도를 줄이고(고정 보일러플레이트 삭제 + 해석·조치문 접이식), 느린-스텝 인사이트에 실질성 게이트를 넣어 1~2ms 격차를 "병목"이라 부르지 않게 한다.

**Architecture:** 발행 여부 판정(게이트)은 **서버**(`insights.rs`)에 둬 export 4표면·비교 뷰·내러티브 `bottleneck_step`까지 자동 일관시키고, 접기·토글·문구는 **UI**에 둔다. `narrative.events`는 렌더처가 사라지므로 와이어에서도 제거한다.

**Tech Stack:** Rust(controller: `insights.rs`/`validity.rs`/`export.rs`/`report.rs`) + React/TS(`ui/src/components/report/`, Zod `schemas.ts`, `ko.ts`)

**Spec:** `docs/superpowers/specs/2026-07-29-report-advice-noise-design.md` (rev3, `spec-plan-reviewer` **APPROVE**)

## Global Constraints

- **US 스파인**: 이 slice의 US 4개는 spec 앞머리 `사용자 스토리 (US)` 블록이 정본. 매 task brief에 그 블록을 첨부한다(ADR-0048).
- **모든 사용자 노출 한국어는 `ko.ts` 경유** (ADR-0035). `aria-label`도 사용자 노출 문구다. 단 `InsightPanel.message()`의 **선재** 인라인 리터럴은 이번 범위 밖(spec §10-B) — 신규·변경 문구만 카탈로그로 옮긴다.
- **조사는 병기형** (`(으)로`/`(이)가`) — 변수 뒤 조사 고정 금지.
- **게이트 상수 값(변경 금지)**: `TAU_SLOW_GAP_MS = 20`, `TAU_SLOW_RATIO = 1.5`.
- **localStorage 키(변경 금지)**: `handicap:report:insight-actions:v1`, 기본값 `false`(숨김).
- **`Insight` 구조체 신규 필드는 맨 끝에만** — `export.rs:87-88` 주석이 "구조체 필드 순서 == `INSIGHT_COLUMNS` 순서"를 계약으로 못박는다.
- **`runner_up`은 top을 인덱스로 제외한 나머지의 최대** — 값으로 제외하면 spec이 기각한 대안 (b)가 되어 동률 top에서 잘못 발행된다.
- **tdd-guard**: `ui/src/**/*.{ts,tsx}`(`ko.ts` 포함)·`crates/*/src` 편집 전에 작업트리에 pending 테스트 파일이 있어야 한다. **각 task의 첫 스텝은 반드시 테스트 파일 편집**이다.
- **검증 게이트**: Rust = `cargo fmt --check && cargo clippy -- -D warnings && cargo nextest run` / UI = `pnpm lint && pnpm test && pnpm build`. 게이트 판정은 파이프 없이 `; echo exit=$?`로 종료코드를 명시 캡처한다(`| tail`은 실패를 마스킹).
- **각 task는 독립 green 커밋**. 게이트만 넣고 테스트 복구를 다음 task로 미루면 그 커밋이 red가 되어 이 규칙이 깨진다.

## File Structure

| 파일 | 책임 | task |
|---|---|---|
| `crates/controller/src/insights.rs` | 게이트 상수·발행 판정·`runner_up_ms` 필드 | T1 |
| `crates/controller/src/export.rs` | `INSIGHT_COLUMNS` 16열·두 공유 writer·XLSX Summary | T1(리터럴)·T2(열)·T4(row 9) |
| `crates/controller/src/validity.rs` | `Narrative`에서 `events` 제거 | T4 |
| `crates/controller/src/report.rs` | events 단언 1건 제거 | T4 |
| `ui/src/components/report/ValidityBanner.tsx` | 유효성 + 해석 **병합** 블록(접이식) | T3 |
| `ui/src/components/report/NarrativeBlock.tsx` | **삭제** | T3 |
| `ui/src/components/report/ReportView.tsx` | 렌더 순서·prop 배선 | T3 |
| `ui/src/report/insightPrefs.ts` | **신규** — 조치문 표시 설정 영속(fail-soft) | T5 |
| `ui/src/components/report/InsightPanel.tsx` | 조치문 분류·토글(T5) · 느린-스텝 문구(T6) | T5·T6 |
| `ui/src/api/schemas.ts` | Zod: `NarrativeSchema.events` 제거(T4)·`InsightSchema.runner_up_ms`(T6) | T4·T6 |
| `ui/src/i18n/ko.ts` | 문구 신규 2·변경 2·삭제 17키 | T3·T5·T6 |

---

### Task 1: 서버 게이트 + `runner_up_ms` (+ RED 복구 6건)

**Files:**
- Modify: `crates/controller/src/insights.rs` (구조체 `:9-48`, `Insight::new` `:50-70`, 게이트 `:145-158`, 상수 `:311-313` 근처, 테스트 `:497-1419`)
- Modify: `crates/controller/src/validity.rs:284-302` (테스트 헬퍼 `insight()`)
- Modify: `crates/controller/src/export.rs:780`, `:801`, `:1038` (완전 리터럴 3곳)

**Interfaces:**
- Produces: `Insight.runner_up_ms: Option<f64>` — `slowest_step`에서만 `Some`. T2가 export 열로, T6이 UI 문구로 소비.
- Produces: `slowest_step` 발행 조건 = `gap >= 20 && top >= 1.5 * runner_up` (T6 문구가 이 값을 전제).

- [ ] **Step 1: 게이트 경계 테스트를 먼저 작성** (`insights.rs`의 `mod tests` 안, 기존 `slowest_step_picks_max_p95` 아래)

```rust
    /// §8.1 게이트 경계 — 발행/미발행 양쪽을 잠근다. p95 목록으로 스텝을 만들어
    /// `slowest_step` 인사이트만 뽑는다.
    fn slowest_of(p95s: &[u64]) -> Option<Insight> {
        let steps: Vec<ReportStep> = p95s
            .iter()
            .enumerate()
            .map(|(i, p)| step(&format!("s{i}"), *p))
            .collect();
        derive_insights(
            &summary(),
            &steps,
            &[],
            &BTreeMap::new(),
            None,
            "",
            0,
            None,
            None,
            None,
        )
        .into_iter()
        .find(|i| i.kind == "slowest_step")
    }

    #[test]
    fn slowest_step_gate_boundaries() {
        // ── 발행 ──
        let e = slowest_of(&[210, 50, 45]).expect("격차 160≥20 · 210≥1.5×50");
        assert_eq!(e.value, Some(210.0));
        assert_eq!(e.runner_up_ms, Some(50.0));
        assert!(slowest_of(&[20, 0]).is_some(), "격차 경계 정확(20==20)");
        assert!(slowest_of(&[90, 60]).is_some(), "배수 경계 정확(90==1.5×60)");

        // runner_up 0 — 곱셈 형태라 0-나눗셈이 구조적으로 없다
        let z = slowest_of(&[300, 0]).expect("runner_up 0이어도 발행");
        assert_eq!(z.runner_up_ms, Some(0.0));
        assert!(z.value.unwrap().is_finite(), "NaN/Infinity 금지");

        // ── 미발행 ──
        assert!(slowest_of(&[3, 2, 1]).is_none(), "격차 1ms — US4 원문 케이스");
        assert!(slowest_of(&[210, 190, 180]).is_none(), "배수 1.105 미달");
        assert!(slowest_of(&[19, 0]).is_none(), "격차 경계 −1");
        assert!(slowest_of(&[89, 60]).is_none(), "배수 경계 −1");
        assert!(slowest_of(&[500]).is_none(), "스텝 1개 — 2위 부재");
        assert!(
            slowest_of(&[120, 120, 40]).is_none(),
            "D10 판별자: runner_up을 값이 아닌 *인덱스*로 제외해야 미발행. \
             값으로 제외하면 runner_up=40이 되어 잘못 발행된다"
        );
    }
```

- [ ] **Step 2: 테스트가 컴파일 실패하는지 확인**

Run: `cargo test -p handicap-controller --lib insights:: 2>&1 | tail -20; echo exit=$?`
Expected: FAIL — `no field 'runner_up_ms' on type 'Insight'`

- [ ] **Step 3: `Insight`에 필드 추가 + `Insight::new` 갱신**

구조체 `:9-48`의 **맨 끝 필드 뒤**에 추가:

```rust
    /// 2위 스텝의 p95(ms) — `slowest_step`에서만 Some.
    /// UI가 격차·배수를 로직 복제 없이 표시하기 위한 값(spec §4.2).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runner_up_ms: Option<f64>,
```

`Insight::new`(`:50-70`)의 리터럴 끝에 `runner_up_ms: None,` 추가.

- [ ] **Step 4: 나머지 완전 리터럴 3곳에 `runner_up_ms: None` 추가**

`validity.rs:284-302`의 `insight()` 헬퍼, `export.rs:780`, `export.rs:801`, `export.rs:1038`의 `insight()` 헬퍼.
(`export.rs:1060`·`:1103`·`:1108`·`:1146`은 `..insight(…)` **spread**라 손대지 않는다.)

- [ ] **Step 5: 게이트 상수 추가**

`insights.rs`의 기존 `TAU_5XX`/`TAU_LAT`/`TAU_SPAN` 블록(`:311-313`) 바로 아래:

```rust
/// 느린-스텝 인사이트 실질성 게이트 (spec §4.1 D2/D10).
const TAU_SLOW_GAP_MS: u64 = 20; // 2위 스텝과의 p95 절대 격차 하한
const TAU_SLOW_RATIO: f64 = 1.5; // 2위 스텝 대비 배수 하한
```

- [ ] **Step 6: 게이트 구현** — `derive_insights`의 `:145-158` 블록을 통째로 교체

```rust
    // slowest_step: 실질성 게이트(spec §4.1). top과 2위의 p95 격차가 절대·상대
    // 하한을 모두 넘을 때만 발행한다. 동률 top은 gap==0이라 미발행이며 이는
    // 의도된 동작이다(D10 — 똑같이 느린 두 스텝 중 하나를 지목하는 건 오도).
    //
    // runner_up은 top을 **인덱스로** 제외한 나머지의 최대다. 값으로 제외하면
    // (`p95 != top`) 동률 top에서 3위가 runner_up이 되어 잘못 발행된다.
    let mut top_idx: Option<usize> = None;
    for (i, s) in steps.iter().enumerate() {
        if top_idx.is_none_or(|cur| s.p95_ms > steps[cur].p95_ms) {
            top_idx = Some(i);
        }
    }
    if let Some(ti) = top_idx {
        let top = &steps[ti];
        let runner_up = steps
            .iter()
            .enumerate()
            .filter_map(|(i, s)| (i != ti).then_some(s.p95_ms))
            .max();
        if let Some(ru) = runner_up {
            let gap = top.p95_ms.saturating_sub(ru);
            // 곱셈 형태 — 나눗셈이면 ru==0에서 0-나눗셈이 된다.
            let ratio_ok = top.p95_ms as f64 >= TAU_SLOW_RATIO * ru as f64;
            if gap >= TAU_SLOW_GAP_MS && ratio_ok {
                let mut ins = Insight::new("slowest_step", "info");
                ins.step_id = Some(top.step_id.clone());
                ins.metric = Some("p95_ms".to_string());
                ins.value = Some(top.p95_ms as f64);
                ins.runner_up_ms = Some(ru as f64);
                out.push(ins);
            }
        }
    }
```

- [ ] **Step 7: 새 테스트 통과 확인**

Run: `cargo test -p handicap-controller --lib insights::tests::slowest_step_gate_boundaries 2>&1 | tail -20; echo exit=$?`
Expected: PASS

- [ ] **Step 8: 게이트로 RED가 된 기존 테스트 6건 복구**

각 테스트의 **픽스처를 올린다**. 단언을 약화(개수 하향·항목 삭제)하지 말 것 — 전부 의도가 살아 있는 테스트다.

| 테스트 | 변경 |
|---|---|
| `slowest_step_picks_max_p95` (`:624-642`) | steps → `vec![step("a", 50), step("b", 210), step("c", 90)]` · `assert_eq!(got[0].value, Some(120.0))`(`:641`) → `Some(210.0)` · `assert_eq!(got[0].runner_up_ms, Some(90.0))` 추가 |
| `slowest_step_first_on_tie` (`:884-901`) | **개명** `slowest_step_suppressed_on_tie` · 픽스처 `[100, 100]` 유지 · 본문을 `assert!(got.iter().all(\|i\| i.kind != "slowest_step"), "동률 top은 미발행(D10)")`로 교체 |
| `insights_deterministic_order` (`:818-844`) | steps → `vec![step_err("a", 50), step("b", 40)]` · 기대 배열의 `("slowest_step", None)` rank-8 항 **그대로 보존** |
| `all_pass_run_has_slowest_and_slo_pass` (`:862-881`) | steps → `vec![step("a", 80), step("b", 40)]` · `kinds == ["slowest_step", "slo_pass"]` 보존 |
| `error_heavy_run_yields_at_least_three` (`:846-859`) | steps → `vec![step_err("a", 200), step("b", 40)]` · `got.len() >= 3` **유지** |
| `no_request_step_skipped_on_unparseable_yaml` (`:770-787`) | steps → `&[step("a", 10), step("b", 40)]` · `:786`의 slowest_step 존재 단언 유지 |

> **주의**: `step_err(id, errors)`(`:573-577`)는 **p95를 10으로 하드코딩**한다. 그래서 위 3·5번은 p95를 명시한 두 번째 스텝 `step("b", 40)`이 필요하다(격차 30 ✓ · 40 ≥ 1.5×10 ✓).

- [ ] **Step 9: controller 전체 테스트 통과 확인**

Run: `cargo test -p handicap-controller 2>&1 | tail -30; echo exit=$?`
Expected: 0 failed

- [ ] **Step 10: 이빨 실증 — D10 판별자가 실제로 (b)를 잡는지**

`Step 6`의 `filter_map`을 일시적으로 `(s.p95_ms != top.p95_ms).then_some(s.p95_ms)`(=기각안 b)로 바꾼다.
Run: `cargo test -p handicap-controller --lib insights::tests::slowest_step_gate_boundaries 2>&1 | tail -20; echo exit=$?`
Expected: **FAIL** — `[120,120,40]` 단언이 깨져야 한다. 확인 후 **원복**하고 다시 PASS 확인.

- [ ] **Step 11: 게이트 통과 후 커밋**

Run: `cargo fmt && cargo clippy -p handicap-controller --all-targets -- -D warnings 2>&1 | tail -20; echo exit=$?`

```bash
git add crates/controller/src/insights.rs crates/controller/src/validity.rs crates/controller/src/export.rs
git commit -m "feat(insights): 느린-스텝 실질성 게이트 + runner_up_ms

격차 >= 20ms AND top >= 1.5 x runner_up일 때만 slowest_step 발행.
runner_up은 top을 인덱스로 제외한 나머지의 최대(값 제외는 동률에서 오발행).
동률 top은 gap==0이라 미발행 — 의도된 동작(spec D10).
게이트로 RED가 된 기존 테스트 6건은 픽스처를 올려 의도 보존."
```

---

### Task 2: export 16열 + 문서 정정

**Files:**
- Modify: `crates/controller/src/export.rs` (`INSIGHT_COLUMNS` `:89-105`, `insight_csv_cells` `:108-128`, `write_insight_xlsx_row` `:132-`, 주석 `:86-88`·`:107`·`:130-131`, 테스트 `:1070`·`:1123`)
- Modify: `crates/controller/CLAUDE.md` (`INSIGHT_COLUMNS: [&str;13]` → 16)

**Interfaces:**
- Consumes: `Insight.runner_up_ms` (T1)
- Produces: CSV/XLSX 16번째 열 `runner_up_ms` — 단일/비교 × CSV/XLSX 4표면 공통

- [ ] **Step 1: 하드코딩 CSV 헤더 2건을 먼저 갱신 (RED 유도)**

`export.rs:1070`(`report_insights_csv_header_and_rows`)과 `:1123`(`comparison_insights_csv_long_format`)의 기대 문자열 **끝**에 `,runner_up_ms` 추가.

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-controller --lib export:: 2>&1 | tail -20; echo exit=$?`
Expected: FAIL — 헤더 불일치 2건

- [ ] **Step 3: `INSIGHT_COLUMNS` 확장**

`:89`의 `[&str; 15]` → `[&str; 16]`, 배열 **맨 끝**에 `"runner_up_ms",` 추가.

- [ ] **Step 4: 두 공유 writer에 셀 추가**

`insight_csv_cells`(`:108-128`) 벡터 **끝**에 `f(ins.runner_up_ms),`.

`write_insight_xlsx_row`(`:132-`) **끝**에 (기존 14블록과 **동일 형태** — `.expect("w");` 필수):

```rust
    if let Some(v) = ins.runner_up_ms {
        ws.write_number(row, c(15), v).expect("w");
    }
```

- [ ] **Step 5: XLSX 16번째 열 테스트 추가**

`xlsx_insights_sheet`류 기존 테스트에 헤더·값·빈-셀 단언을 덧붙인다:

```rust
        // 16번째 열 runner_up_ms (col 15 = P)
        assert_eq!(
            ws.get_value((0, 15)),
            Some(&Data::String("runner_up_ms".into()))
        );
        // slowest_step 행은 runner_up_ms 보유
        assert_eq!(ws.get_value((1, 15)), Some(&Data::Float(90.0)));
        // 사이징 행은 None → 미기록(None 또는 Empty 양쪽 허용)
        assert!(matches!(ws.get_value((2, 15)), None | Some(Data::Empty)));
```

> 픽스처의 `slowest_step` 인사이트에 `runner_up_ms: Some(90.0)`을 설정해야 한다(`export.rs:780`/`:801` 리터럴 중 해당 행).

- [ ] **Step 6: 주석·문서 갱신**

- `export.rs:86-88` 주석 "이 15열은" → "이 16열은"
- `export.rs:107` "15개 CSV 셀로" → "16개 CSV 셀로"
- `export.rs:130-131` "15개 타입별 셀을" → "16개 타입별 셀을"
- `crates/controller/CLAUDE.md`의 `INSIGHT_COLUMNS: [&str;13]` → `[&str;16]` (**현 시점에도 stale이었다** — 실제 15였다)

- [ ] **Step 7: 통과 확인 + 커밋**

Run: `cargo test -p handicap-controller 2>&1 | tail -20; echo exit=$?` → 0 failed
Run: `cargo fmt && cargo clippy -p handicap-controller --all-targets -- -D warnings 2>&1 | tail -10; echo exit=$?`

```bash
git add crates/controller/src/export.rs crates/controller/CLAUDE.md
git commit -m "feat(export): INSIGHT_COLUMNS 16열 — runner_up_ms

공유 writer 2곳(insight_csv_cells/write_insight_xlsx_row)에 셀 1개씩 추가해
단일/비교 x CSV/XLSX 4표면에 동시 반영. CLAUDE.md의 [&str;13] stale 정정."
```

---

### Task 3: 유효성·해석 병합 블록 (UI)

**Files:**
- Modify: `ui/src/components/report/ValidityBanner.tsx` (전면)
- Delete: `ui/src/components/report/NarrativeBlock.tsx`
- Delete: `ui/src/components/report/__tests__/NarrativeBlock.test.tsx`
- Modify: `ui/src/components/report/ReportView.tsx:160-164`
- Modify: `ui/src/components/report/__tests__/ValidityBanner.test.tsx`, `__tests__/ReportView.test.tsx` (`:379` 순서 테스트, `:392` 형제 테스트)
- Modify: `ui/src/i18n/ko.ts` (`narrative.eventsHeading`·`narrative.event` 14키·`narrative.sectionAria` 삭제)
- Modify: `ui/CLAUDE.md:169` (order 절 + `NarrativeBlock` 언급)

**Interfaces:**
- Produces: `ValidityBanner({ validity, narrative })` — T4가 `narrative.events` 제거 시 이 컴포넌트를 손대지 않아도 되게 events를 여기서 이미 안 읽는다.

- [ ] **Step 1: 병합 불변식 테스트를 먼저 작성** (`__tests__/ValidityBanner.test.tsx`)

> **이 task 시점엔 `Narrative` 타입에 `events`가 아직 필수다**(제거는 T4). 따라서 아래 픽스처에는 `events: []`를 넣어야 `tsc -b`가 통과한다 — T4 Step 1이 이 줄들을 걷어낸다. `pnpm test`(esbuild)는 이걸 안 잡고 `pnpm build`만 잡으니 Step 9 게이트까지 돌릴 것.

```tsx
  it("suspect면 상세가 펼쳐지고 can/cannot이 유효성 region 안에 딱 한 번 있다", () => {
    render(
      <ValidityBanner
        validity={{ level: "suspect", reasons: [{ kind: "zero_requests", severity: "critical" }] }}
        narrative={{
          events: [],
          can_claim: ["client_reachability_issue"],
          cannot_claim: ["production_identity"],
        }}
      />,
    );
    // 픽스처 조건: suspect(기본 펼침) + can_claim 비지 않음 — 둘 중 하나라도
    // 빠지면 canHeading이 0개가 되어 이 단언이 공허해진다.
    const headings = screen.getAllByText(ko.narrative.canHeading);
    expect(headings).toHaveLength(1);
    const region = screen.getByRole("region", { name: ko.validity.bannerAria });
    expect(region).toContainElement(headings[0]);
  });

  it("limited면 상세가 접혀 있다", () => {
    render(
      <ValidityBanner
        validity={{ level: "limited", reasons: [{ kind: "no_response_validation", severity: "warning" }] }}
        narrative={{ events: [], can_claim: ["throughput_measured"], cannot_claim: ["production_identity"] }}
      />,
    );
    expect(screen.queryByText(ko.narrative.canHeading)).toBeNull();
    expect(screen.getByRole("button", { name: ko.narrative.title })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("ok면 블록 자체를 안 그린다 (US1 — 0줄)", () => {
    const { container } = render(
      <ValidityBanner validity={{ level: "ok", reasons: [] }} narrative={{ events: [], can_claim: [], cannot_claim: [] }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("validity 부재(구식 리포트)면 미렌더 — 가짜 ok 금지", () => {
    const { container } = render(<ValidityBanner validity={undefined} narrative={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("narrative가 없으면 토글도 안 뜬다", () => {
    render(
      <ValidityBanner
        validity={{ level: "limited", reasons: [{ kind: "no_response_validation", severity: "warning" }] }}
        narrative={undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: ko.narrative.title })).toBeNull();
  });
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test ValidityBanner 2>&1 | tail -20; echo exit=$?`
Expected: FAIL (prop `narrative` 미지원 / ok가 렌더됨)

- [ ] **Step 3: `ValidityBanner`를 병합 블록으로 재작성**

```tsx
import { useState } from "react";
import type { Narrative, Validity, ValidityReason } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { floorPct } from "./format";
import { Callout } from "../ui/Callout";

// wire fraction 0–1 → display digits (기존 유지)
function pctDigits(fraction: number): string {
  return floorPct(fraction * 100).replace(/%$/, "");
}

function reasonText(r: ValidityReason): string {
  switch (r.kind) {
    case "zero_requests":
      return ko.validity.reason.zero_requests;
    case "transport_heavy":
      return ko.validity.reason.transport_heavy(
        pctDigits(r.pct ?? 0),
        (r.count ?? 0).toLocaleString("en-US"),
      );
    case "silent_http_errors":
      return ko.validity.reason.silent_http_errors;
    case "no_response_validation":
      return ko.validity.reason.no_response_validation;
    case "load_not_delivered":
      return ko.validity.reason.load_not_delivered;
    default:
      return r.kind;
  }
}

const LEVEL_VARIANT: Record<Validity["level"], "info" | "warn" | "error"> = {
  ok: "info",
  limited: "warn",
  suspect: "error",
};

const CAN_LABELS: Record<string, string | undefined> = ko.narrative.can;
const CANNOT_LABELS: Record<string, string | undefined> = ko.narrative.cannot;

function label(map: Record<string, string | undefined>, code: string): string {
  return map[code] ?? code;
}

function ClaimList({ heading, codes, map }: {
  heading: string;
  codes: string[];
  map: Record<string, string | undefined>;
}) {
  if (codes.length === 0) return null;
  return (
    <div className="mt-2">
      <h4 className="mb-1 text-sm font-semibold">{heading}</h4>
      <ul className="list-disc space-y-0.5 pl-5">
        {codes.map((code) => (
          <li key={code}>{label(map, code)}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 시험 유효성 + 결과 해석 병합 블록 (spec §5.1).
 * `ok`는 미렌더(US1 0줄), `limited`는 상세 접힘, `suspect`는 상세 펼침.
 * 접힘 상태는 **영속하지 않는다** — 영속시키면 suspect 경고를 영구히 숨길 수 있다.
 */
export function ValidityBanner({
  validity,
  narrative,
}: {
  validity?: Validity | null;
  narrative?: Narrative | null;
}) {
  const [open, setOpen] = useState(validity?.level === "suspect");

  // `ok`면 reasons 유무와 무관하게 미렌더 — 서버 불변식(validity.rs:131-137)이
  // ok ⟺ reasons 0을 보장한다. `!validity`(구식 리포트)도 미렌더(가짜 ok 금지).
  if (!validity || validity.level === "ok") return null;

  const hasDetail =
    (narrative?.can_claim.length ?? 0) > 0 || (narrative?.cannot_claim.length ?? 0) > 0;

  return (
    <Callout
      variant={LEVEL_VARIANT[validity.level]}
      role="region"
      aria-label={ko.validity.bannerAria}
      title={ko.validity.title}
      className="mb-6"
    >
      {validity.reasons.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5">
          {validity.reasons.map((r, idx) => (
            <li key={`${r.kind}-${idx}`}>{reasonText(r)}</li>
          ))}
        </ul>
      ) : null}
      {hasDetail ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="mt-2 text-xs underline"
          >
            <span aria-hidden="true">{open ? "▾ " : "▸ "}</span>
            {ko.narrative.title}
          </button>
          {open ? (
            <div>
              <ClaimList
                heading={ko.narrative.canHeading}
                codes={narrative?.can_claim ?? []}
                map={CAN_LABELS}
              />
              <ClaimList
                heading={ko.narrative.cannotHeading}
                codes={narrative?.cannot_claim ?? []}
                map={CANNOT_LABELS}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </Callout>
  );
}
```

> **a11y**: 토글은 가시 텍스트(`ko.narrative.title` = "결과 해석")를 가지므로 `aria-label`을 **붙이지 않는다** — 붙이면 접근명이 가시 텍스트를 덮어써 WCAG 2.5.3 위반이다. caret은 `aria-hidden`(`Section.tsx:52`·`InsightPanel.tsx:101` 관행).

- [ ] **Step 4: `NarrativeBlock` 삭제 + `ReportView` 배선**

```bash
rm ui/src/components/report/NarrativeBlock.tsx ui/src/components/report/__tests__/NarrativeBlock.test.tsx
```

`ReportView.tsx`: `NarrativeBlock` import 제거, `:160-164`를

```tsx
      {/* spec §5.1: 유효성+해석 병합 → Verdict → Insight */}
      <ValidityBanner validity={report.validity} narrative={report.narrative} />
      {report.verdict ? <VerdictPanel verdict={report.verdict} steps={stepMeta} /> : null}
      <InsightPanel insights={report.insights ?? []} meta={stepMeta} />
```

- [ ] **Step 5: `ko.narrative` 정리**

`ko.ts:1064-1107`에서 **삭제**: `sectionAria`, `eventsHeading`, `event`(14키 블록 전체).
**존치**: `title`("결과 해석" — 이제 토글 라벨), `canHeading`, `cannotHeading`, `can`, `cannot`.

- [ ] **Step 6: `ReportView.test.tsx` 갱신**

`:379` 순서 테스트를 병합 후 구조로 재작성(유효성 region → Verdict → Insight), `:392` 형제 테스트("old reports omit validity/narrative")의 `ko.narrative.sectionAria` 참조 제거.

- [ ] **Step 7: `ui/CLAUDE.md:169` 갱신**

같은 불릿의 **두 곳**을 고친다:
- order: `Banner→Narrative→Verdict→Insight` → `ValidityBanner(유효성+해석 병합)→Verdict→Insight`
- `ValidityBadge/Banner/NarrativeBlock must not render ok` → `NarrativeBlock`은 삭제됐고 규칙이 "키 부재 시 미렌더"에서 **"키 부재 ∨ level==ok 시 미렌더"**로 확장됨을 반영

- [ ] **Step 8: 이빨 실증 — 병합 불변식**

`ValidityBanner`에서 `<ClaimList heading={ko.narrative.canHeading} …>`를 일시 제거 → 병합 불변식 테스트 FAIL 확인 → 원복 → PASS.

- [ ] **Step 9: 게이트 + 커밋**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/report-advice-noise/ui && pnpm lint; echo lint=$?; pnpm test; echo test=$?; pnpm build; echo build=$?`

```bash
git add -A ui/src/components/report ui/src/i18n/ko.ts ui/CLAUDE.md
git commit -m "feat(report): 유효성·해석 블록 병합 + ok는 미렌더

NarrativeBlock 삭제, ValidityBanner가 can/cannot을 접이식 상세로 흡수.
ok는 블록 자체 미렌더(US1 0줄), limited 접힘, suspect 펼침.
접힘 상태 비영속 — 영속시키면 suspect 경고를 영구 은닉 가능.
ko.narrative의 sectionAria/eventsHeading/event(14키) 삭제."
```

---

### Task 4: `narrative.events` 와이어 제거

**Files:**
- Modify: `crates/controller/src/validity.rs` (`:33-38`, `:151-167`, `:177-187`, `:253-257`, `:566-620`, `:744-751`)
- Modify: `crates/controller/src/export.rs:471-473`, `:705-`, `:736-745`
- Modify: `crates/controller/src/report.rs:2322-2327`
- Modify: `ui/src/api/schemas.ts:419-423`
- Modify: `ui/src/api/__tests__/schemas.test.ts`, `ui/src/components/report/__tests__/ReportView.test.tsx`, `ui/src/pages/__tests__/RunDetailPage.test.tsx` (픽스처)

- [ ] **Step 1: 테스트부터 — events 참조 제거 (RED 유도)**

Rust: `validity.rs:566-620`의 events 테스트 3건(`events_validity_first_then_insights_max_5`·`events_dedup_multiple_no_request_step`·`events_status_class_codes`) 삭제, `:744-751`의 `n.events.is_empty()` 항 제거, `export.rs:736-745` 리터럴에서 `events` 제거 + `:705-`의 row 9 단언 제거·테스트명 `xlsx_summary_includes_validity_rows`로 개명, `report.rs:2322-2327`의 `assert!(rep.narrative.events…)` **블록만** 제거.

> **`report.rs`의 `:2329`·`:2335`·`:2357`·`:2363`·`:2383`은 절대 건드리지 말 것** — 전부 `can_claim`/`cannot_claim` 골든(`sut_capacity`·`production_identity`·`throughput_measured`·`functional_correctness`)이고 spec D4가 "무변경"으로 못박았다. `.events`는 `report.rs` 전체에 `:2324` 한 곳뿐이다.

TS: `schemas.test.ts`의 픽스처 `events` + `parsed.narrative?.events` 단언 제거, `ReportView.test.tsx`·`RunDetailPage.test.tsx`·**`ValidityBanner.test.tsx`(T3이 넣어둔 `events: []`)** 픽스처의 `events` 제거.

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-controller 2>&1 | tail -20; echo exit=$?` (아직 필드가 있어 컴파일은 되나 삭제한 테스트만 사라진 상태)
Run: `cd ui && pnpm build 2>&1 | tail -20; echo exit=$?` — 픽스처에서 `events`를 지웠으므로 **필수 필드 누락**으로 tsc FAIL

- [ ] **Step 3: Rust 필드·계산 제거**

- `validity.rs:33-38` `Narrative`에서 `pub events: Vec<String>,` 삭제
- `validity.rs:151-167` `insight_event_code` 함수 **전체** 삭제 (남기면 dead_code → `-D warnings`)
- `validity.rs:177-187` events 계산 블록 삭제. **`push_unique`는 존치**(can/cannot에서 계속 사용), **`insights` 파라미터도 존치**(`:222-235`가 사용)
- `validity.rs:253-257` 반환 리터럴에서 `events,` 줄 삭제
- `export.rs:471-473` XLSX Summary row 9(`narrative_events_count`) 삭제 — row 9는 Summary 시트 **마지막** 행(다음은 Steps 시트 `:475-`)이라 인덱스 시프트 없음. `:459`·`:706` 주석의 "rows 7–9" → "rows 7–8"

- [ ] **Step 4: Zod 갱신**

`schemas.ts:419-423`의 `NarrativeSchema`에서 `events: z.array(z.string()),` 제거.

- [ ] **Step 5: 게이트 + 커밋**

Run: `cargo test -p handicap-controller 2>&1 | tail -20; echo exit=$?` → 0 failed
Run: `cargo fmt && cargo clippy -p handicap-controller --all-targets -- -D warnings 2>&1 | tail -10; echo exit=$?`
Run: `cd ui && pnpm lint; echo lint=$?; pnpm test; echo test=$?; pnpm build; echo build=$?`

```bash
git add crates/controller/src ui/src
git commit -m "refactor(narrative): events 필드 제거 — 렌더처가 0

주요 사건 목록은 배너 reason과 인사이트 종류를 코드로 재진술한 것이라
고유 정보가 0이었다(spec D6). 필드/계산/insight_event_code/ko 14키/
XLSX narrative_events_count 행/Zod까지 제거.
report.rs의 can_claim/cannot_claim 골든 5건은 무변경(D4)."
```

---

### Task 5: 인사이트 조치문 토글

**Files:**
- Create: `ui/src/report/insightPrefs.ts`
- Create: `ui/src/report/__tests__/insightPrefs.test.ts`
- Modify: `ui/src/components/report/InsightPanel.tsx` (`actionFor` `:60-80`, 렌더 `:82-111`)
- Modify: `ui/src/components/report/__tests__/InsightPanel.test.tsx` (`:37-50`, `:52-63`, `:65-71`, `:112-119`)
- Modify: `ui/src/i18n/ko.ts` (`ko.report.insightActionsToggle` 신규)

**Interfaces:**
- Produces: `readShowInsightActions(): boolean` / `writeShowInsightActions(v: boolean): void`

- [ ] **Step 1: prefs 테스트 작성** (`ui/src/report/__tests__/insightPrefs.test.ts`)

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { readShowInsightActions, writeShowInsightActions } from "../insightPrefs";

describe("insightPrefs", () => {
  beforeEach(() => window.localStorage.clear());

  it("기본값은 숨김(false)", () => {
    expect(readShowInsightActions()).toBe(false);
  });

  it("쓰고 읽으면 유지된다", () => {
    writeShowInsightActions(true);
    expect(readShowInsightActions()).toBe(true);
  });

  it("malformed 값은 기본값으로 폴백하고 throw하지 않는다", () => {
    window.localStorage.setItem("handicap:report:insight-actions:v1", "{nope");
    expect(() => readShowInsightActions()).not.toThrow();
    expect(readShowInsightActions()).toBe(false);
  });
});
```

- [ ] **Step 2: 기존 InsightPanel 테스트 4건을 토글 ON 전제로 갱신**

`:37-50`·`:52-63`·`:112-119`: 단언 전에 토글을 켠다.

```tsx
    await userEvent.setup().click(screen.getByRole("checkbox", { name: ko.report.insightActionsToggle }));
```

`:65-71`(`queryByText(/→/)).toBeNull()`)은 **기본 숨김이면 공허해지므로** 토글 ON 상태에서 다시 세운다 — "slo_pass·미지 kind엔 토글을 켜도 조치 줄이 없다".

추가로 D7 회귀 가드(**두 단언이 짝이어야 한다**):

```tsx
  it("기본(숨김)에서 일반 안내는 감추되 계산된 권장치는 남긴다", () => {
    render(<InsightPanel insights={[statusClass5xx, saturatedWithSlots]} meta={new Map()} />);
    // 일반 코칭은 숨김
    expect(screen.queryByText(new RegExp(ko.insightActions.status_class))).toBeNull();
    // 측정값 기반 권장치는 항상 표시 — 이 단언이 없으면 "조치문 렌더를 통째로
    // 지워도 통과"하는 공허한 테스트가 된다
    expect(screen.getByText(/max_in_flight/)).toBeInTheDocument();
  });
```

- [ ] **Step 3: RED 확인**

Run: `cd ui && pnpm test InsightPanel 2>&1 | tail -20; echo exit=$?` → FAIL (토글 체크박스 없음)
Run: `cd ui && pnpm test insightPrefs 2>&1 | tail -20; echo exit=$?` → FAIL (모듈 없음)

- [ ] **Step 4: prefs 모듈 작성**

```ts
// ui/src/report/insightPrefs.ts
const KEY = "handicap:report:insight-actions:v1";

/**
 * 인사이트 일반 안내(조치문) 표시 여부. 기본값 false(숨김) — 전문가에게 조용한
 * 기본값이 이 기능의 헤드라인이다. malformed·접근 실패는 기본값으로 폴백(throw 금지).
 */
export function readShowInsightActions(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
}

export function writeShowInsightActions(v: boolean): void {
  try {
    window.localStorage.setItem(KEY, v ? "true" : "false");
  } catch {
    // 저장 실패는 무시 — 표시 설정 소실은 기능에 영향 없음
  }
}
```

- [ ] **Step 5: `actionFor`를 분류 반환으로 변경**

```tsx
type Action = { text: string; computed: boolean };

// computed=true는 측정값·계산된 권장치(ko.saturation.*)라 토글과 무관하게 항상 표시한다.
// sut arm은 "슬롯을 늘리지 말라"는 역방향 경고라 숨기면 위험하다.
function actionFor(i: Insight): Action | undefined {
  if (i.kind === "load_gen_saturated") {
    if (i.cause === "slots") {
      const x = i.target_per_sec;
      const y = i.achieved_per_sec;
      if (x != null && y != null && i.recommended != null) {
        const base = ko.saturation.slots(
          rate(x),
          rate(y),
          rate(Math.max(0, x - y)),
          n(i.recommended),
        );
        return {
          text: i.recommended >= 10_000 ? `${base} ${ko.saturation.slotsAtCap}` : base,
          computed: true,
        };
      }
      return { text: ko.insightActions.load_gen_saturated, computed: false };
    }
    if (i.cause === "sut") return { text: ko.saturation.sut, computed: true };
    return { text: ko.insightActions.load_gen_saturated, computed: false };
  }
  const t = ACTIONS[i.kind];
  return t ? { text: t, computed: false } : undefined;
}
```

- [ ] **Step 6: 토글 + 조건부 렌더 배선**

`InsightPanel` 본문 상단:

```tsx
  const [showGeneric, setShowGeneric] = useState(readShowInsightActions);
```

`PageSection` **첫 자식**으로(제목 `<h3>` 안이 아니라 — heading 안 대화형 요소 금지):

```tsx
      <div className="mb-2 flex justify-end">
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={showGeneric}
            onChange={(e) => {
              setShowGeneric(e.target.checked);
              writeShowInsightActions(e.target.checked);
            }}
          />
          {ko.report.insightActionsToggle}
        </label>
      </div>
```

조치 줄 렌더(`:97-105`)를:

```tsx
            {(() => {
              const action = actionFor(i);
              if (!action || (!action.computed && !showGeneric)) return null;
              return (
                <div className="mt-0.5 text-xs opacity-90">
                  <span aria-hidden="true">→ </span>
                  {action.text}
                </div>
              );
            })()}
```

- [ ] **Step 7: ko 신규 키**

`ko.report`에 `insightActionsToggle: "조치 안내 보기",` 추가.
**충돌 스윕**: `grep -n '"[^"]*조치 안내' ui/src/i18n/ko.ts` → 자기 자신 1건만이어야 한다.

- [ ] **Step 8: 이빨 실증 — D7 짝 단언**

`actionFor`의 `sut` arm을 일시 `computed: false`로 → Step 2의 D7 테스트가 FAIL 하는지 확인 → 원복 → PASS.

- [ ] **Step 9: 게이트 + 커밋**

Run: `cd ui && pnpm lint; echo lint=$?; pnpm test; echo test=$?; pnpm build; echo build=$?`

```bash
git add ui/src/report ui/src/components/report/InsightPanel.tsx ui/src/components/report/__tests__/InsightPanel.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(report): 인사이트 조치문 패널 단위 토글 (기본 숨김·영속)

ko.insightActions(일반 코칭 7종)만 토글 뒤로 숨기고 ko.saturation.*
(측정값+권장 max_in_flight, sut 역방향 경고)는 항상 표시.
설정은 handicap:report:insight-actions:v1에 fail-soft 영속."
```

---

### Task 6: 느린-스텝 문구 정직화

**Files:**
- Modify: `ui/src/api/schemas.ts:380-397` (`InsightSchema.runner_up_ms`)
- Modify: `ui/src/i18n/ko.ts` (`ko.report.slowestStep` 신규 · `ko.insightActions.slowest_step` 변경 · `ko.narrative.can.bottleneck_step` 변경)
- Modify: `ui/src/components/report/InsightPanel.tsx` (`message()` `:42-43`)
- Modify: `ui/src/components/report/__tests__/InsightPanel.test.tsx`

- [ ] **Step 1: 문구 테스트 작성**

```tsx
  it("느린 스텝은 격차와 배수를 함께 말한다", () => {
    render(
      <InsightPanel
        insights={[{ kind: "slowest_step", severity: "info", step_id: "a", metric: "p95_ms", value: 210, runner_up_ms: 50 }]}
        meta={new Map()}
      />,
    );
    const line = screen.getByTestId("insight");
    // 보간 소실을 잡기 위해 렌더된 *숫자*를 직접 확인한다 —
    // ko.report.slowestStep(...)을 기대값으로 쓰면 자기참조라 카피 변이를 못 잡는다.
    expect(line).toHaveTextContent("160"); // 210 − 50
    expect(line).toHaveTextContent("4.2"); // 210 ÷ 50
  });

  it("2위가 0ms면 배수를 말하지 않는다 (Infinity 금지)", () => {
    render(
      <InsightPanel
        insights={[{ kind: "slowest_step", severity: "info", step_id: "a", metric: "p95_ms", value: 300, runner_up_ms: 0 }]}
        meta={new Map()}
      />,
    );
    const line = screen.getByTestId("insight");
    expect(line).toHaveTextContent("300");
    expect(line.textContent).not.toContain("Infinity");
  });

  it("병목이라 단정하지 않는다", () => {
    expect(ko.insightActions.slowest_step).not.toContain("병목");
    expect(ko.narrative.can.bottleneck_step).not.toContain("병목");
  });
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test InsightPanel 2>&1 | tail -20; echo exit=$?`
Expected: FAIL (`runner_up_ms`가 타입에 없음 / "병목" 포함)

- [ ] **Step 3: Zod 필드 추가**

`schemas.ts:380-397`의 `InsightSchema` **끝**에 `runner_up_ms: z.number().optional(),`
(Rust가 `skip_serializing_if`라 **omit**이지 null이 아니다 — `.nullish()` 아님)

- [ ] **Step 4: ko 갱신**

```ts
    // ko.report에 추가 — ko.insight* 접두는 이미 셋(insightCompare/insightLabels/
    // insightActions)이라 새 ko.insight 네임스페이스는 오참조 위험이 크다.
    slowestStep: (name: string, ms: string, gap: string, ratio: string | null) =>
      ratio === null
        ? `스텝 ${name}이(가) p95 ${ms}ms — 2위 스텝보다 ${gap}ms 느립니다`
        : `스텝 ${name}이(가) p95 ${ms}ms — 2위 스텝보다 ${gap}ms 느립니다(${ratio}배)`,
```

`ko.insightActions.slowest_step` → `"다른 스텝보다 뚜렷하게 느립니다 — 스텝 표를 내보내 개발팀과 공유하세요."`
`ko.narrative.can.bottleneck_step` → `"상대적으로 느린 스텝을 식별할 수 있습니다"`

- [ ] **Step 5: `message()` slowest_step arm 교체**

```tsx
    case "slowest_step": {
      const ru = i.runner_up_ms;
      const v = i.value ?? 0;
      // 구식 리포트(필드 부재)는 기존 문구로 폴백
      if (ru == null) return `스텝 ${name(i.step_id)}이(가) p95 ${n(i.value)}ms로 가장 느림`;
      const gap = Math.max(0, v - ru);
      // ru === 0이면 v/ru가 Infinity가 되므로 배수를 생략한다
      const ratio = ru > 0 ? (v / ru).toFixed(1) : null;
      return ko.report.slowestStep(name(i.step_id), n(v), n(Math.round(gap)), ratio);
    }
```

- [ ] **Step 6: 이빨 실증 — Infinity 가드**

`ratio` 계산에서 `ru > 0 ?` 가드를 일시 제거 → "Infinity 금지" 테스트 FAIL 확인 → 원복 → PASS.

- [ ] **Step 7: 게이트 + 커밋**

Run: `cd ui && pnpm lint; echo lint=$?; pnpm test; echo test=$?; pnpm build; echo build=$?`

```bash
git add ui/src/api/schemas.ts ui/src/i18n/ko.ts ui/src/components/report/InsightPanel.tsx ui/src/components/report/__tests__/InsightPanel.test.tsx
git commit -m "feat(report): 느린-스텝 문구 정직화 — 격차·배수 진술

'이 API가 병목입니다'(증명되지 않은 인과 주장) 제거. 게이트가 증명하는
범위(2위 대비 격차·배수)만 진술. runner_up_ms=0이면 배수 생략(Infinity 방지)."
```

---

## 라이브 검증 (머지 전 필수)

`/live-verify`로 스택을 띄우고 spec §9 표를 그대로 수행한다. **`responder`에 스텝별 지연 분기 필요**(`/fast` 즉시, `/slow` 200ms) — 격차 없는 run과 큰 run 두 종류가 있어야 US4가 검증된다.

- run 생성/리포트 파싱 경로 변경(Zod 2건)이라 S-D 갭에 해당 → **라이브 필수**. RTL 픽스처는 서버가 실제로 보내는 형태(필드 omit)를 재현하지 못한다.
- 마운트 화면: `ValidityBanner`/`InsightPanel`은 `ReportView` → `RunDetailPage.tsx:237` **한 곳**뿐. 비교 뷰(`ScenarioComparePage`)는 `InsightCompareMatrix`만 쓰므로 **게이트 파급(CSV/XLSX/매트릭스)만** 확인 대상.

## 최종 리뷰

- `handicap-reviewer` APPROVE — 서버 게이트 ↔ UI 표시 ↔ export 3표면의 **교차-task 일관성**(per-task 리뷰가 원리적으로 못 보는 영역).
- **보안 게이트**: `finish-slice §0`의 grep을 **직접 실행**해 판정한다. 무매치 예상이지만 예상은 게이트가 아니다.

<!-- REVIEW-GATE 마커는 spec-plan-reviewer가 이 plan에 clean APPROVE를 준 뒤에만 추가한다. -->


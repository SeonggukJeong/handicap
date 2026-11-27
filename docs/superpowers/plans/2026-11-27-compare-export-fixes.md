# compare-export-fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 비교·내보내기·인쇄에 남은 결함 일곱을 고친다(B1–B7). B8은 실측으로 「결함 아님」 — 코드 변경 없음.

**Architecture:** 결함마다 그 자리만 고친다. 서버는 `crates/controller/src/export.rs` 한 파일(도우미 셋 추가), 화면은 `ui/src/compare`·`ui/src/components/compare`, 인쇄는 `ui/src/print`. 와이어·DB·proto·엔진 무접촉.

**Tech Stack:** Rust(`rust_xlsxwriter`·`csv`·테스트는 `calamine`), TypeScript/React(vitest + RTL).

REVIEW-GATE: APPROVED

**Spec:** `docs/superpowers/specs/2026-11-27-compare-export-fixes-design.md` — 구현자는 자기 task의 R절과 앞머리 `사용자 스토리 (US)` 블록(B1–B8 재현/기대)을 함께 읽는다.

## Global Constraints

- 워크트리 `/Users/sgj/develop/handicap/.claude/worktrees/compare-export-fixes`(브랜치 `worktree-compare-export-fixes`)에서만 작업한다. 이 세션 종류는 `cd … && git …`·`;`/`|` 복합·heredoc 속 `git`을 거부한다 — git은 단독 호출, 커밋 메시지는 Write 도구로 만든 파일을 `git commit -F <파일>`로.
- 커밋·게이트 명령에 `| tail`/`| head` 금지, `--no-verify` 금지. 커밋 뒤 `git log -1 --oneline`로 들어갔는지 본다.
- `export.rs`를 건드리는 커밋은 cargo 게이트가 수 분 걸린다 — 단일 foreground 호출(timeout 600000ms), 그동안 다른 `cargo` 금지.
- `ui/src`를 건드리는 커밋은 UI 게이트(`pnpm lint && pnpm test && pnpm build`)가 돈다. 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build`를 직접 돌려 통과를 본다.
- **tdd-guard**: production 코드(`crates/*/src`·`ui/src`의 비-테스트)를 고치기 전에 실패하는 테스트가 먼저 있어야 한다. 모든 task의 Step 1은 테스트다. Rust는 같은 파일 `#[cfg(test)] mod tests` 안에 먼저 쓴다.
- 테스트 기대값은 리터럴로 적는다(≈ 금지). 화면 문구는 `ko.ts`를 거친다(이번엔 새 문구 없음).
- 「되돌려 확인」: Step에 그렇게 적힌 테스트는 고친 뒤 production 변경을 잠깐 되돌려 RED를 보고, 원복해 GREEN을 본다. 결과(RED 메시지 한 줄)를 리포트에 적는다.
- 한도 이하·안 잘린 입력의 출력 바이트는 그대로다 — 기존 테스트의 기대값을 고치면 안 된다(고쳐야 통과한다면 STOP하고 보고). 예외는 task가 파일·줄로 이름 붙인 것뿐이다(Task 4·5·6의 「기존 테스트 손보기」 목록).
- 변호 주석 금지: 결함을 「알려진 한계」로 설명하는 주석을 새로 쓰지 않는다.

## Review Focus

spec이 말하지 않았지만 사용자가 만날 입력. 각 줄의 테스트는 소유 task에 들어 있다.

1. **스텝 id가 정확히 32,767자**(한도 경계) — 잘리지 않고 그대로 나가야 한다. → Task 1 Step 1.
2. **멀티바이트 글자(한글) 40,000자 id** — 바이트가 아니라 글자 수로 잘라야 하고 글자 중간에서 자르면 패닉한다. → Task 1 Step 1.
3. **스텝 id가 `-5`·`+1`처럼 숫자로 보이는 글자** — id 칸이므로 `'`가 붙어야 하고, 같은 행의 숫자 칸은 바이트 그대로여야 한다. → Task 2 Step 1(행 전체를 리터럴로 비교).
4. **준비 스텝 p95가 정확히 60,000**(칸 경계) — `≥` 비교라 잘림으로 처리. 59,999는 안 잘림. → Task 3 Step 1, Task 4 Step 1.
5. **한쪽 run에만 `stats`가 있는 비교 인쇄**(옛 run + 새 run) — 각 쪽이 제 출처를 쓰고 패닉·NaN이 없어야 한다. → Task 5 Step 1.

---

### Task 1: XLSX 글자 칸을 자르는 쓰기 도우미로 통일 (R1 / B1)

**Files:**
- Modify: `crates/controller/src/export.rs` (비-테스트 부분의 모든 글자 칸 쓰기 + `mod tests`)

**Interfaces:**
- Produces(이 파일 안, 비공개):
  - `fn put_text(ws: &mut Worksheet, row: u32, col: u16, s: &str)` — `xlsx_text(s)`로 자르고 `write_string(...).expect("w")`.
  - `fn setup_label(sid: &str, suffix: &str) -> String` — `sid`를 앞 `32_767 − suffix.chars().count()` 글자로 자른 뒤 `suffix`를 붙인다. Task 3이 이 함수를 쓴다.
- 기존 `xlsx_text(s: &str) -> &str`(앞 32,767 글자)는 그대로 둔다.

- [ ] **Step 1: 실패하는 테스트를 `mod tests`에 쓴다**

기존 도우미(`report_with_steps`·`step`·`report_with_setup`·`setup_step_report`·`read_xlsx`·`insight`)를 쓴다. 테스트 넷:

```rust
#[test]
fn xlsx_single_export_survives_overlong_ids() {
    use calamine::{Data, Reader};
    let long: String = std::iter::repeat_n('가', 40_000).collect();
    let cut: String = long.chars().take(32_767).collect();
    let mut r = report_with_setup();
    r.steps[0].step_id = long.clone();
    r.setup.as_mut().unwrap().steps[0].step_id = long.clone();
    r.windows = vec![ReportWindow { step_id: long.clone(), /* 나머지 칸은 4544줄 근처 기존 테스트의 값과 같은 꼴 */ }];
    r.if_breakdown = vec![IfBreakdown {
        step_id: long.clone(),
        branches: vec![IfBranchBucket { branch: "then".into(), count: 1 }],
    }];
    let mut ins = insight("slowest_step", "info");
    ins.step_id = Some(long.clone());
    r.insights = vec![ins];
    let mut rd = read_xlsx(report_to_xlsx(&r, None)); // 패닉하지 않는다
    for sheet in ["Steps", "Windows", "Branches", "Insights", "Setup"] {
        let ws = rd.worksheet_range(sheet).unwrap();
        assert!(
            ws.cells().any(|(_, _, v)| v == &Data::String(cut.clone())),
            "{sheet}에 32,767자로 잘린 id 칸이 있어야 한다"
        );
        assert!(
            !ws.cells().any(|(_, _, v)| matches!(v, Data::String(s) if s.chars().count() > 32_767)),
            "{sheet}"
        );
    }
}

#[test]
fn xlsx_comparison_export_survives_overlong_ids() {
    // 본 스텝 id와 준비 스텝 id가 40,000자인 리포트 둘(run id "r1"·"r2")로 comparison_to_xlsx(&[a, b], 0).
    // 패닉하지 않고, "Steps"·"Step stats" 시트 첫 칸에 32,767자로 잘린 id가 있다.
    // "Setup" 시트: 첫 칸이 " p95_ms"로 끝나는 행과 " error_count"로 끝나는 행이 각각 있고,
    // 둘 다 정확히 32,767자이며 서로 다르다.
}

#[test]
fn xlsx_text_keeps_exact_limit_untouched() {
    let exact: String = std::iter::repeat_n('a', 32_767).collect();
    assert_eq!(xlsx_text(&exact), exact);
    let over: String = std::iter::repeat_n('a', 32_768).collect();
    assert_eq!(xlsx_text(&over).chars().count(), 32_767);
}

#[test]
fn setup_label_keeps_suffix() {
    assert_eq!(setup_label("abc", " p95_ms"), "abc p95_ms");
    let long: String = std::iter::repeat_n('가', 40_000).collect();
    let l = setup_label(&long, " error_count");
    assert_eq!(l.chars().count(), 32_767);
    assert!(l.ends_with(" error_count"));
    assert_eq!(l.chars().take(32_755).collect::<String>(), long.chars().take(32_755).collect::<String>());
}
```

`ReportWindow`의 나머지 칸은 `grep -n 'ReportWindow {' crates/controller/src/export.rs`로 찾은 기존 테스트 리터럴을 복사해 채운다. 둘째 테스트의 본문은 주석대로 구현자가 쓴다(첫째 테스트와 같은 꼴).

- [ ] **Step 2: 실패 확인**

Run: `cargo nextest run -p handicap-controller export::tests::xlsx_ export::tests::setup_label`
Expected: `setup_label`은 컴파일 실패(함수 없음). 그것을 임시 주석 처리하면 `xlsx_single_export_survives_overlong_ids`·`xlsx_comparison_export_survives_overlong_ids`가 `expect("w")` 패닉으로 FAIL, `xlsx_text_keeps_exact_limit_untouched`는 PASS(지금도 맞는 동작의 고정용). 패닉 메시지 한 줄을 리포트에 적는다 — 이것이 B1의 「실측」이다.

- [ ] **Step 3: 도우미 둘을 더하고 모든 글자 칸 쓰기를 `put_text`로 바꾼다**

- `put_text`·`setup_label`을 `xlsx_text` 바로 아래에 둔다.
- `#[cfg(test)]` 앞의 모든 `ws.write_string(r, c, X).expect("w")`(여러 줄로 꺾인 것 포함)를 `put_text(ws, r, c, X)`로 바꾼다. 리터럴 머리 칸도 바꾼다. `format!(...)`을 넘기던 곳은 `&format!(...)`.
- 남기는 것: `write_delta_cell` 안의 세 줄(`write_string_with_format` 둘 + `write_string` 하나)과 `put_text` 본문 한 줄.
- `write_step_stat_labels`도 `put_text`를 쓴다(안의 `xlsx_text(sid)` 직접 호출은 없어진다).
- 비교 `Setup` 시트의 `format!("{sid} p95_ms")`·`format!("{sid} error_count")`는 `setup_label(&sid, " p95_ms")`·`setup_label(&sid, " error_count")`.
- `mod tests`의 `step_stats_labels_truncate_overlong_step_id` 위 주석(「Steps 시트는 같은 입력에서 먼저 패닉한다 … 연기」)은 이제 거짓이다 — 주석 두 줄을 지운다(테스트 본문은 그대로).

- [ ] **Step 4: 기계 확인 — 도우미 밖에 글자 쓰기가 남지 않았다**

Run: `awk '/^#\[cfg\(test\)\]/{exit} {print}' crates/controller/src/export.rs | grep -c 'write_string'`
Expected: `5` (baseline `561eaf84`에서는 `80`). 다섯 = `put_text` 본문 1 + `write_delta_cell` 3 + 주석 1(「neutral은 plain write_string」). 다섯이 아니면 같은 명령에서 `-c`를 `-n`으로 바꿔 남은 줄을 보고 고친다. `put_text`의 문서 주석에는 `write_string`이라는 낱말을 쓰지 않는다(수가 6이 된다). rustfmt가 `put_text` 본문을 두 줄로 꺾어 수가 달라지면 그 사실과 남은 줄 목록을 리포트에 적는다.

- [ ] **Step 5: 통과 확인**

Run: `cargo fmt --all` → `cargo clippy -p handicap-controller --all-targets -- -D warnings` → `cargo nextest run -p handicap-controller export::`
Expected: 전부 PASS. 기존 XLSX·CSV 테스트의 기대값은 하나도 고치지 않았다.

- [ ] **Step 6: 되돌려 확인**

`put_text` 본문의 `xlsx_text(s)`를 `s`로 잠깐 바꾼다 → `xlsx_single_export_survives_overlong_ids`가 FAIL(패닉)인지 본다 → 원복 → PASS.

- [ ] **Step 7: 커밋** — `fix(controller): XLSX 글자 칸을 Excel 한도(32,767자)로 자른다 — 긴 스텝 id에서 내보내기 실패 (§B100 (1)·§B89 (3))`

---

### Task 2: CSV 사용자 글자 칸의 수식 글자 막기 (R2 / B2)

**Files:**
- Modify: `crates/controller/src/export.rs`

**Interfaces:**
- Produces(비공개): `fn csv_text(s: &str) -> std::borrow::Cow<'_, str>` — 첫 글자가 `=`·`+`·`-`·`@`·`\t`·`\r`이면 `'`를 앞에 붙인 `Owned`, 아니면 `Borrowed`. 빈 글자는 그대로.

- [ ] **Step 1: 실패하는 테스트**

```rust
#[test]
fn csv_text_guards_formula_leads() {
    for (input, want) in [
        ("=1+1", "'=1+1"),
        ("+1", "'+1"),
        ("-5", "'-5"),
        ("@SUM(A1)", "'@SUM(A1)"),
        ("\tx", "'\tx"),
        ("\rx", "'\rx"),
        ("login", "login"),
        ("a=b", "a=b"),
        ("", ""),
    ] {
        assert_eq!(csv_text(input), want, "{input:?}");
    }
}

#[test]
fn csv_step_id_cells_are_guarded() {
    let mut r = report_with_setup();
    r.steps[0].step_id = "=1+1".into();
    r.setup.as_mut().unwrap().steps[0].step_id = "-5".into();
    let csv = String::from_utf8(report_to_csv(&r)).unwrap();
    let lines: Vec<&str> = csv.lines().collect();
    assert!(lines[1].starts_with("'=1+1,"), "{}", lines[1]);
    // 숫자 칸은 그대로: 같은 리포트를 id만 "a"로 둔 것과 첫 칸 뒤가 같다
    let plain = String::from_utf8(report_to_csv(&report_with_setup())).unwrap();
    assert_eq!(&lines[1]["'=1+1".len()..], &plain.lines().nth(1).unwrap()["a".len()..]);
    let h = lines.iter().position(|l| l.starts_with("setup_step_id")).unwrap();
    assert!(lines[h + 1].starts_with("'-5,"), "{}", lines[h + 1]);
    // 둘째 스텝·둘째 준비 스텝 행은 바이트 그대로
    assert!(lines[2].starts_with("b,"));
}

#[test]
fn insight_csv_step_id_is_guarded() {
    let mut r = report_with_steps(vec![step("a", 1, 1)]);
    let mut ins = insight("slowest_step", "info");
    ins.step_id = Some("@x".into());
    r.insights = vec![ins];
    let single = String::from_utf8(report_to_insights_csv(&r)).unwrap();
    assert!(single.lines().nth(1).unwrap().contains(",'@x,"), "{single}");
    let multi = String::from_utf8(comparison_to_insights_csv(&[r])).unwrap();
    assert!(multi.lines().nth(1).unwrap().contains(",'@x,"), "{multi}");
}
```

- [ ] **Step 2: 실패 확인** — Run: `cargo nextest run -p handicap-controller export::tests::csv_text export::tests::csv_step_id export::tests::insight_csv_step_id`. Expected: 컴파일 실패(`csv_text` 없음).

- [ ] **Step 3: `csv_text`를 더하고 세 칸에 적용**

적용 칸(spec R2 그대로, 다른 칸은 건드리지 않는다): `report_to_csv`의 스텝 행 `s.step_id`, 같은 함수 준비 블록의 `st.step_id`, `insight_csv_cells`의 `ins.step_id`. 숫자 칸·`"*"` 행·run id·`step:{sid}:{metric}`에는 적용하지 않는다.

- [ ] **Step 4: 통과 확인** — `cargo fmt --all` → clippy(위와 같은 명령) → `cargo nextest run -p handicap-controller export::`. 기존 CSV 테스트 기대값 무수정.

- [ ] **Step 5: 되돌려 확인** — 세 적용 칸을 하나씩 잠깐 뺀다: 스텝 행 → `csv_step_id_cells_are_guarded`의 첫 단언 FAIL, 준비 블록 → 같은 테스트의 `'-5,` 단언 FAIL, `insight_csv_cells` → `insight_csv_step_id_is_guarded` FAIL. 각각 원복.

- [ ] **Step 6: 커밋** — `fix(controller): CSV 스텝 id 칸이 수식 글자로 시작하면 ' 를 붙인다 (§B100 (3))`

---

### Task 3: 비교 XLSX 준비 스텝 p95에 60초 칸 규칙 (R3 서버 / B3)

**Files:**
- Modify: `crates/controller/src/export.rs` (`comparison_to_xlsx`의 `Setup` 시트 블록)

**Interfaces:**
- Consumes: `cap_ms(ms: u64) -> (u64, bool)`, `delta_of(metric, base: MetricVal, val: MetricVal) -> Delta`, `MetricVal { v: f64, us: Option<u64>, cut: bool }`, `setup_label`(Task 1).

- [ ] **Step 1: 실패하는 테스트**

`abc_setup_reports()`(기존 도우미) 또는 `report_with_setup()` 둘로 만든 비교에서 준비 스텝 하나의 `p95_ms`를 바꿔 가며 `comparison_to_xlsx(&reports, 0)`의 `Setup` 시트를 읽는다. 표(기준 run 값 → 비교 run 값 ⇒ 비교 run 값 칸 / Δ 칸):

| 기준 p95 | 비교 p95 | 기준 값 칸 | 비교 값 칸 | Δ 칸 글자 |
|---|---|---|---|---|
| 200 | 60030 | `200` | `60000` | `"▲ —"` |
| 60030 | 200 | `60000` | `200` | `"▼ —"` |
| 60030 | 60100 | `60000` | `60000` | `"—"` |
| 200 | 60000 | `200` | `60000` | `"▲ —"` |
| 200 | 59999 | `200` | `59999` | `"▲ +29899.5%"` |

Δ 칸 글자는 `delta_cell_text`(`export.rs` 134줄 근처)가 쓰는 것이다: 잘림이면 나쁨 `"▲ —"`·좋음 `"▼ —"`·중립 `"—"`, 아니면 `format_pct`. 마지막 행은 지금도 같은 글자다(바뀌지 않음을 고정). 값 칸은 숫자 칸(`Data::Float`)으로 비교한다.

테스트 이름: `comparison_xlsx_setup_p95_caps_60s`.

- [ ] **Step 2: 실패 확인** — Run: `cargo nextest run -p handicap-controller export::tests::comparison_xlsx_setup_p95_caps_60s`. Expected: 첫 행에서 FAIL(값 칸이 `60030`). 이것이 B3 서버 쪽 「실측」.

- [ ] **Step 3: 구현**

`Setup` 시트 블록의 행 표를 p95 행이 잘림 여부를 함께 들고 다니게 바꾼다: p95 값 = `cap_ms(st.p95_ms)`의 `(값, 잘림)`, Δ = `delta_of("p95_ms", MetricVal { v, us: None, cut }, …)`. `setup_ok`·`setup_failed`·`error_count` 행은 지금처럼 `delta(metric, b, x)`. 행 표의 타입을 어떻게 바꿀지는 구현자 몫(예: 값 벡터를 `Vec<Option<(f64, bool)>>`로, p95가 아닌 행은 `false`).

- [ ] **Step 4: 통과 확인** — fmt → clippy → `cargo nextest run -p handicap-controller export::`. 기존 `Setup` 시트 테스트(60초 미만 값) 기대값 무수정.

- [ ] **Step 5: 되돌려 확인** — `cap_ms` 적용을 잠깐 빼면 새 테스트가 FAIL → 원복.

- [ ] **Step 6: 커밋** — `fix(controller): 비교 XLSX 준비 스텝 p95에 60초 칸 규칙 (§B100 (1))`

---

### Task 4: 비교 화면 — 준비 스텝 60초 칸 + 오류율 퍼센트 글자 (R3 화면·R5 / B3·B5)

**Files:**
- Modify: `ui/src/compare/compareReports.ts` (`setupRows`)
- Modify: `ui/src/components/compare/CompareMatrix.tsx` (`CellContent`)
- Test: `ui/src/compare/__tests__/compareReports.test.ts`, `ui/src/components/compare/__tests__/CompareMatrix.test.tsx`

**Interfaces:**
- Consumes: `computeDeltaCapped(metric, base: {v, cut}, val: {v, cut})`, `CAP_US`(`ui/src/components/report/format.ts`), `floorPct(pct: number)`(같은 파일).
- `Cell` 타입은 그대로다(`time?: { us: number }`).

- [ ] **Step 1: 실패하는 테스트**

`compareReports.test.ts`의 `describe("compareReports setup rows")`에 더한다(그 블록의 기존 fixture 도우미를 쓴다). 준비 스텝 p95 행(`metric === "p95_ms"`)의 칸:

| 기준 p95 | 비교 p95 | 기준 칸 | 비교 칸 |
|---|---|---|---|
| 200 | 60030 | `{ value: 200, delta: null }`(`time` 없음) | `value: 60000`, `time: { us: 60_000_000 }`, `delta: { pct: null, polarity: "bad", capped: true }` |
| 60030 | 200 | `value: 60000`, `time: { us: 60_000_000 }` | `value: 200`, `time` 없음, `delta: { pct: null, polarity: "good", capped: true }` |
| 60030 | 60100 | `value: 60000` + `time` | `value: 60000` + `time`, `delta: { pct: null, polarity: "neutral", capped: true }` |
| 200 | 60000 | (첫 행과 같다) | 첫 행과 같다 |
| 200 | 59999 | `{ value: 200, delta: null }` | `value: 59999`, `time` 없음, `delta.capped === false`, `delta.pct`는 `298.995`(= (59999 − 200) / 200), `polarity: "bad"` |

`setup_errors` 행은 `time`이 없고 지금 기대값 그대로다.

`CompareMatrix.test.tsx`에 더한다:

```tsx
it("오류율 칸은 퍼센트 글자", () => {
  // summary error_rate 행의 칸 값 [0, 0.0123001230012, 0.0001]로 렌더
  // 기대: 「0.0%」, 「1.2%」, 「<0.1%」가 보이고 "0.0123"으로 시작하는 글자는 없다
});
it("준비 스텝 잘린 p95 칸은 「≥ 60,000」, 안 잘린 칸은 정수 글자", () => {
  // setup 행: 칸 [{ value: 200, delta: null }, { value: 60000, time: { us: 60_000_000 }, delta: { pct: null, polarity: "bad", capped: true } }]
  // 기대: 「200」과 ko.report.stats.capped 글자(「≥ 60,000」 — 가운데는 U+00A0)가 보인다. 「200.000」·「µs」는 없다.
});
```

기존 테스트 파일의 `result` fixture 만드는 방식을 따른다. 기대 글자는 `ko` 카탈로그 값을 import해 쓰지 말고 리터럴로, 가운데 공백은 이스케이프 `"≥\u00a060,000"`로 적는다(편집기가 보통 공백으로 바꾸지 못하게).

**기존 테스트 손보기(이 task가 허용하는 예외, 이것뿐)**: `CompareMatrix.test.tsx` 338줄 fixture가 `error_rate` 칸에 비율이 아닌 값 `cell(10), cell(11)`을 준다(`grep -n 'cell(10), cell(11)' ui/src/components/compare/__tests__/CompareMatrix.test.tsx`). 그 `return row(m, [cell(10), cell(11)])`는 다른 지표의 기본값이기도 하므로 건드리지 말고, 그 위에 `if (m === "error_rate") return row(m, [cell(0.1), cell(0.11)]);`를 더한 뒤 394줄 기대를 `"10"` → `"10.0%"`로 바꾼다.

- [ ] **Step 2: 실패 확인** — Run: `cd ui && pnpm vitest run src/compare/__tests__/compareReports.test.ts src/components/compare/__tests__/CompareMatrix.test.tsx`. Expected: 새 테스트 FAIL(값 60030 그대로 / `0.0123001230012` 그대로). `준비 스텝 잘린 p95 칸` 테스트는 `CellContent`가 이미 `time`을 읽으므로 지금도 통과할 수 있다 — 통과하면 그 사실을 리포트에 적는다(고정용).

- [ ] **Step 3: 구현**

- `setupRows`: p95 행만 `p95_ms >= 60000`이면 `{ v: 60000, cut: true }`로 보고 변화율은 `computeDeltaCapped`, 그 칸에 `time: { us: CAP_US }`. 안 잘린 칸은 `time`을 싣지 않는다. 다른 행(`setup_ok`·`setup_failed`·`setup_errors`)은 지금 `computeDelta` 그대로.
- `CellContent`: `metric === "error_rate"`이고 값이 있으면 `floorPct(cell.value * 100)`.

- [ ] **Step 4: 통과 확인** — 위 vitest 명령 PASS, 이어서 `cd ui && pnpm lint && pnpm test && pnpm build`.

- [ ] **Step 5: 되돌려 확인** — `setupRows`의 잘림 가지를 잠깐 빼면 표 첫 행 테스트가 FAIL, `CellContent`의 `error_rate` 가지를 빼면 오류율 테스트가 FAIL → 원복.

- [ ] **Step 6: 커밋** — `fix(ui): 비교 화면 준비 스텝 60초 칸 · 오류율을 퍼센트 글자로 (§B100 (1))`

---

### Task 5: 비교 인쇄 99%·95%·평균을 `stats`에서 (R4 / B4)

**Files:**
- Modify: `ui/src/print/compare/change.ts` (`SPECS`의 `p99_ms`·`p95_ms`·`mean_ms`)
- Modify: `ui/src/print/compare/dumbbell.ts` (`measuredOf`의 95% 가지)
- Test: `ui/src/print/compare/__tests__/change.test.ts`, `ui/src/print/compare/__tests__/dumbbell.test.ts`

**Interfaces:**
- Consumes: `CAP_US`(`ui/src/components/report/format.ts` — `change.ts`는 이미 import, `dumbbell.ts`는 import를 더한다), `mkStats(over)`(`__tests__/fixtures.ts` — 기본값 `p95_us 95_000`·`p99_us 99_000`·`mean_us 50_000`), `metricRows(...)`·`buildDumbbell(...)`(시그니처 무변경).
- 값 식(spec R4): `stats`가 있으면 `stats.p99_us / 1000`·`stats.p95_us / 1000`·`stats.mean_us / 1000`, 잘림은 `p99_us >= CAP_US`·`p95_us >= CAP_US`·`stats.capped`. 없으면 지금 식.

- [ ] **Step 1: 실패하는 테스트**

`change.test.ts`(파일 머리의 `BEFORE`·`AFTER`·`OPTS`·`row` 도우미를 쓴다):

```ts
it("95% 행은 stats의 µs로 계산한다 — 정수 칸으로는 「비슷」인 차이", () => {
  const before = { ...BEFORE, p95_ms: 100, stats: mkStats({ p95_us: 100_000 }) } as Summary;
  const after = { ...AFTER, p95_ms: 105, stats: mkStats({ p95_us: 105_400 }) } as Summary;
  const r = row(metricRows(before, after, OPTS), "p95_ms");
  expect(r.cls).toBe("worse");
  expect(r.pct).toBeCloseTo(0.054, 9);
  expect(r.before).toBe(100);
  expect(r.after).toBe(105.4);
});
it("99%·평균 행도 stats에서 읽는다", () => {
  // p99: 정수 칸 100·105, stats.p99_us 100_000·105_400 → cls "worse", after 105.4
  // mean: 정수 칸 100·105, stats.mean_us 100_000·105_400 → cls "worse", after 105.4
});
it("stats가 한쪽에만 있으면 각 쪽이 제 출처를 쓴다", () => {
  // before: stats 없음, p95_ms 100 / after: p95_ms 105, stats.p95_us 105_400
  // → before 100, after 105.4, cls "worse", pct는 유한한 수
});
it("stats가 둘 다 없으면 정수 칸 그대로", () => {
  // p95_ms 100 → 105 → cls "similar" (지금 동작)
});
it("잘림은 정수 칸이 아니라 stats의 µs로 본다", () => {
  // before: p95_ms 1000, stats.p95_us 1_000_000 / after: p95_ms 60000(정수 칸은 잘림처럼 보임), stats.p95_us 59_999_000
  // → 잘림 아님: r.pct가 null이 아니고 toBeCloseTo(58.999, 9), changeText는 「변화율 계산 불가」가 아니다
  // (고치기 전에는 p95_ms >= 60000이라 잘림 처리 → pct null — 되돌려 확인에 쓴다)
});
```

`metricRows(before, after, opts)` 시그니처는 `change.ts` 248줄 그대로다.

**기존 테스트 손보기(이 task가 허용하는 예외)** — R4 뒤에는 `stats`가 있는 요약의 99%·95%·평균이 `stats`에서 오므로, 정수 칸과 `stats`를 서로 다른 값으로 주던 fixture는 **입력을 맞춘다(기대값은 고치지 않는다)**. 규칙: `stats`를 붙일 때 `p95_us = p95_ms × 1000`·`p99_us = p99_ms × 1000`·`mean_us = mean_ms × 1000`. 알려진 곳(2026-11-27 손으로 추적, vitest로는 미확인):
- `change.test.ts`의 `withStats`(297줄 근처): 셋째 인자(정수 칸 덮어쓰기)를 적용한 뒤 그 요약의 정수 칸에서 위 세 µs 값을 만들어 `mkStats`에 넣게 바꾼다(둘째 인자 `over`가 그 뒤에 덮는다). 이것으로 「평균: 잘린 쪽(capped) 30000 ↔ 안 잘린 40000은 방향 모름」·「평균: 1000 → 잘린 30000은 나빠짐」·「평균 글자: capped인 쪽만 「이상」」이 제 이름대로의 입력을 받는다.
- `headline.test.ts` 「p90·최대 행이 나빠져도 머리 건수·글자는 두 행이 없을 때와 같다」: `statB`·`statA`의 `mkStats`에 그 요약(`plainB`·`plainA`)의 세 정수 칸 × 1000을 더한다.
- `headline.test.ts` 「반면 문장: 값이 같아도 잘림 때문에 나빠진 평균은 「늘었습니다」」: 두 쪽 `mkStats`에 `mean_us: 30_000_000`·`p99_us: 1_840_000`과 각자의 `p95_us`(`2_400_000`·`1_600_000`)를 더한다.
- 전체 `pnpm test`에서 더 깨지는 테스트가 나오면: fixture가 정수 칸과 `stats`를 다른 값으로 주고 있으면 같은 규칙으로 입력을 맞추고 리포트에 파일·테스트 이름을 적는다. 입력이 이미 맞는데 깨지면 STOP.
- 손본 뒤 `headline.test.ts`에 단언 하나를 더한다: B4 값(`p95_ms` 100·105, `stats.p95_us` 100_000·105_400, 다른 지표는 같음)으로 만든 `metricRows`를 `buildHeadline`에 넣으면 나빠진 지표 수가 1이다(정수 칸 식이면 0) — 머리말이 µs 값을 따른다는 고정.

`dumbbell.test.ts`: 기존 테스트가 쓰는 run 모델 만들기 도우미로, 한 단계의 정수 `p95Ms` 100·105와 `stats.p95_us` 100_000·105_400을 준 before/after → `buildDumbbell(…, "p95")`의 그 행 `afterMs`가 `105.4`이고 `cls`가 `"worse"`다(`DbClass = "better" | "worse" | "similar"`). `stats`가 없는 단계는 `afterMs`가 `105`.

- [ ] **Step 2: 실패 확인** — Run: `cd ui && pnpm vitest run src/print/compare/__tests__/change.test.ts src/print/compare/__tests__/dumbbell.test.ts`. Expected: 첫 테스트가 `cls` `"similar"`로 FAIL — B4의 「실측」.

- [ ] **Step 3: 구현** — 위 값 식대로 `SPECS` 세 항목의 `value`·`cut`과 `measuredOf`의 95% 반환을 고친다. 글자 형식 함수는 건드리지 않는다.

- [ ] **Step 4: 통과 확인** — 위 vitest PASS → `cd ui && pnpm lint && pnpm test && pnpm build`. 깨지는 테스트는 Step 1의 「기존 테스트 손보기」 규칙으로만 다룬다(입력 정합 — 기대값·스냅샷을 고쳐야 한다면 STOP).

- [ ] **Step 5: 되돌려 확인** — `p95_ms` 항목의 `value`를 정수 칸 식으로 잠깐 되돌리면 첫 테스트와 머리말 단언이 FAIL, `cut`만 되돌리면 「잘림은 정수 칸이 아니라…」가 FAIL, `measuredOf`를 되돌리면 덤벨 테스트가 FAIL → 각각 원복.

- [ ] **Step 6: 커밋** — `fix(ui): 비교 인쇄 99%·95%·평균 행과 95% 덤벨을 stats(µs)에서 읽는다 (§B100 (1))`

---

### Task 6: 인쇄 응답 시간 글자 — 60초 미만은 「59.9초」까지 (R6 / B6)

**Files:**
- Modify: `ui/src/print/format.ts` (`fmtMs`만)
- Test: `ui/src/print/__tests__/format.test.ts`

- [ ] **Step 1: 실패하는 테스트** — `describe("fmtMs")`에 더한다:

```ts
it.each([
  [59_950, "59.9초"],
  [59_999, "59.9초"],
  [59_949, "59.9초"],
  [59_900, "59.9초"],
  [60_000, "60초 이상"],
])("60초 경계 %d → %s", (ms, out) => {
  expect(fmtMs(ms)).toBe(out);
});
it("fmtDurMs는 그대로 반올림한다", () => {
  expect(fmtDurMs(59_950)).toBe("60.0초");
});
```

**기존 테스트 손보기(이 task가 허용하는 예외, 세 줄뿐 — `grep -n '60\.0초' ui/src/print/__tests__/format.test.ts`의 `fmtMs` 줄)**: 고치려는 결함을 기대값으로 박아 둔 줄이다. ① 표의 `[59950, "60.0초"]` 행은 지운다(새 표가 대신한다). ② `expect(fmtMs(59998)).toBe("60.0초")`와 ③ `expect(fmtMs(59998.207)).toBe("60.0초")`는 기대를 `"59.9초"`로 바꾸고 줄은 남긴다(「60초 칸이 아님」을 여전히 증명한다). 같은 grep에 나오는 `fmtDurMs` 줄은 건드리지 않는다. 글자 「60초 이상」·「N초」는 `ko.ts`의 `capSec`·`sec`와 같다.

- [ ] **Step 2: 실패 확인** — Run: `cd ui && pnpm vitest run src/print/__tests__/format.test.ts`. Expected: 새 표의 59_950·59_999 두 행만 FAIL(받은 값 `"60.0초"`).

- [ ] **Step 3: 구현** — `fmtMs`: `ms >= 60000`은 지금대로. 그 밖에는 `fmtDurMs(ms)`가 `fmtDurMs(60000)`과 같은 글자면 `fmtDurMs(59900)`을 돌려준다. `fmtDurMs`는 건드리지 않는다.

- [ ] **Step 4: 통과 확인** — 위 vitest PASS → `cd ui && pnpm lint && pnpm test && pnpm build`.

- [ ] **Step 5: 되돌려 확인** — 새 가지를 빼면 두 행 FAIL → 원복.

- [ ] **Step 6: 커밋** — `fix(ui): 인쇄 응답 시간 59,950–59,999ms가 「60.0초」로 찍히지 않게 (§B100 (1))`

---

### Task 7: 좁은 창에서 비교 화면이 페이지를 밀지 않게 + 이름 칸 왼쪽 고정 (R7 / B7)

**시각 기준 = 목업 `docs/superpowers/mockups/2026-11-27-compare-narrow.html`의 「안 C」**(사용자 선택 2026-11-27). 그 파일의 `.scroll`·`.trunc`·`.C …` CSS가 기준이다 — 「참고용」이 아니다. 목업의 숫자·run 이름·머리 줄은 꾸민 것이고 기준은 표와 그래프 상자의 배치·치수다.

**Files:**
- Modify: `ui/src/components/compare/CompareMatrix.tsx` (표 감싸는 상자, 이름 칸, 값 칸, 구획 머리 행)
- Modify: `ui/src/components/compare/CompareOverlaySection.tsx` (그래프마다 감싸는 상자)
- Test: `ui/src/components/compare/__tests__/CompareMatrix.test.tsx`, `ui/src/components/compare/__tests__/CompareOverlaySection.test.tsx`

**목업 → Tailwind 대응(이대로 쓴다. 숫자는 Step 5 실측에서만 바꾼다):**

| 목업 CSS | 실제 |
|---|---|
| `.scroll { overflow-x: auto }` | `<table>`을 감싸는 `<div className="overflow-x-auto">` |
| `.C .trunc { width: 7rem }` + `.trunc`(block·overflow hidden·ellipsis·nowrap) | 이름 칸 안 글자를 `<span className="block truncate w-28 lg:w-44">`로 감싼다(7rem / 넓은 화면 11rem — 칸의 `pr-4` 1rem을 더해 12rem). **펼친 통계 행**의 이름 칸은 `pl-4`가 더 있으므로 `<span className="block truncate w-24 lg:w-40">`(1rem씩 작게 — 펼쳐도 열 폭이 그대로다) |
| `.C th:first-child, .C td.name { position: sticky; left: 0; background: #f8fafc; box-shadow: 1px 0 0 #e2e8f0 }` | 머리 줄의 빈 첫 `<th>`와 모든 이름 `<td>`(본 행·펼친 통계 행·판정 행)에 `sticky left-0 bg-slate-50 shadow-[1px_0_0_#e2e8f0]`. 바탕은 페이지 바탕과 같은 `bg-slate-50`이다(`ui/index.html`의 `<body class="bg-slate-50 …">` — 흰색을 쓰면 이름 열만 밝은 띠가 된다). `dark:` 변형은 넣지 않는다: 페이지 바탕에 다크 변형이 없어 OS 다크 모드에서도 slate-50이다 |
| `th, td { white-space: nowrap }` | 값 `<td>` 전부(본 행·펼친 통계 행·판정 행)와 run 머리 `<th>`에 `whitespace-nowrap`. run 라벨은 200자까지 들어온다(`crates/controller/src/api/runs.rs`의 라벨 검증) — 머리 단추 안의 라벨 글자를 `<span className="truncate max-w-[12rem]" title={전체 라벨}>`로 감싸 한 줄 말줄임한다(색 네모·「(base)」는 그 밖에 둔다) |
| `.C tr.sec th > div { position: sticky; left: 12px; display: inline-block }` | 구획 머리 행(`colSpan` `<th>`) 안의 `<div className="flex items-center gap-2">`를 `inline-flex … sticky left-3`으로 — 옆으로 밀어도 구획 제목과 「응답 시간 통계 더 보기」 단추가 보인다. 그 `<th>`의 바탕(`bg-slate-50`)은 그대로 |

- 이름 `<td>`의 `break-all`은 뺀다. `title`은 지금처럼 `<td>`에 둔다.
- `<colgroup>`의 이름 열은 `<col className="lg:w-48" />`로 바꾼다(지우지 않는다). 넓은 화면에서는 지금처럼 12rem으로 묶여 남는 폭이 run 열로 가고, `lg` 미만에서는 폭 지정이 없어 안쪽 `span`(7rem)이 정한다. `col` 개수는 그대로다(기존 테스트 `colgroup col` 개수 = run 수 + 1).

- [ ] **Step 1: 실패하는 테스트(jsdom — 구조만)**

`CompareMatrix.test.tsx`:
- `<table>`의 부모 요소가 `overflow-x-auto` 클래스를 가진다.
- 300자 스텝 id 행: 이름 `<td>`가 `sticky`·`left-0` 클래스를 갖고 `title`이 300자 전체이며, 그 안에 `truncate` 클래스 요소가 있고 그 글자가 300자 전체다. `break-all` 클래스는 없다.
- 펼친 통계 행(단추를 눌러 `open`)의 이름 `<td>`도 `sticky`이고 안에 `truncate` 요소가 있다.
- 값 `<td>` 하나(예: `p50_ms` 행 둘째 칸)가 `whitespace-nowrap`을 가진다.
- 200자 run 라벨: 머리 칸 안에 `truncate` 클래스 요소가 있고 그 `title`이 200자 전체다.

`CompareOverlaySection.test.tsx`:
- 그래프(`role="region"`)마다 `closest(".overflow-x-auto")`가 있고, 그래프가 둘이면 그 상자도 서로 다른 둘이다(조상 하나가 둘을 다 감싸는 것으로 통과하지 못하게).

- [ ] **Step 2: 실패 확인** — Run: `cd ui && pnpm vitest run src/components/compare/__tests__/CompareMatrix.test.tsx src/components/compare/__tests__/CompareOverlaySection.test.tsx`. Expected: 새 테스트 FAIL.

- [ ] **Step 3: 구현** — 위 대응 표대로. `CompareOverlaySection`에서는 `CompareTimeSeriesChart`를 `<div className="overflow-x-auto">`로 감싸고 `key`를 감싸는 쪽으로 옮긴다. 그래프 `width`(720)는 건드리지 않는다.

- [ ] **Step 4: 통과 확인** — 위 vitest PASS → `cd ui && pnpm lint && pnpm test && pnpm build`. 기존 `CompareMatrix` 테스트의 `names()` 도우미는 `td.textContent`를 읽으므로 안쪽 `span`이 생겨도 그대로 통과해야 한다.

- [ ] **Step 5: 라이브 실측 + 목업 대조(이 task의 권위 — jsdom은 치수를 모른다)**

`.claude/skills/live-verify/SKILL.md` §1대로 워크트리 바이너리 + 응답기(지연 20ms) + 격리 DB `/tmp/cef.db`를 띄운다(포트는 `lsof -nP -iTCP:<포트> -sTCP:LISTEN` 출력이 비었는지 읽고). 시나리오 둘:
- **긴 이름**: 스텝 셋(보통 id 하나, `L` 300개 id 하나, `=1+1` id 하나 — 이름 300자) + run 3개(각 3초). 390 폭 기준용.
- **보통 이름**: 스텝 셋 모두 ULID id·짧은 이름 + run 3개(라벨 없음 또는 짧은 라벨). 여기에 200자 라벨 run 하나를 더 만들어 라벨 행에만 쓴다(1440 전후 대조에는 넣지 않는다). 1440 폭 전후 대조용(300자 id가 있으면 고치기 전 표가 이름 열에 남는 폭을 다 줘서 전후가 원래 다르다).

고치기 **전** 값: 390 × 844·긴 이름은 spec B7 실측(`scrollWidth` 768·`clientWidth` 379, 표 오른쪽 끝 457, 그래프 오른쪽 끝 768, 이름 칸 폭 29, 300자 id 칸 높이 6017). 1440 × 900·보통 이름의 「전」 값(각 열 폭, `p50_ms` 행 높이)은 orchestrator가 이 task 디스패치 전에 Task 6까지의 `ui/dist`로 재서 brief에 값으로 넘긴다(Task 1–6은 표 배치를 건드리지 않는다).

재는 스니펫(`browser_evaluate`, `filename` 없이):

```js
() => {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const boxes = [...document.querySelectorAll(".overflow-x-auto")];
  const inBox = (el) => boxes.some((b) => b !== el && b.contains(el));
  const over = [...document.querySelectorAll("body *")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.right > vw + 1 && !inBox(el);
  });
  const box = document.querySelector("table").parentElement;
  const rows = [...document.querySelectorAll("table tbody tr")].filter((tr) => tr.querySelector("td"));
  const h = (tr) => Math.round(tr.getBoundingClientRect().height);
  box.scrollLeft = 120;
  const name = rows[1].querySelector("td");
  const stuck = Math.round(name.getBoundingClientRect().left - box.getBoundingClientRect().left);
  box.scrollLeft = 0;
  return {
    vw, scrollWidth: de.scrollWidth,
    outside: over.map((el) => el.tagName + "." + String(el.className).slice(0, 40)),
    rowHeights: [...new Set(rows.map(h))],
    nameCellWidth: Math.round(name.getBoundingClientRect().width),
    nameLeftAfterScroll120: stuck,
    p50Height: h(rows[1]),
    colWidths: [...rows[1].children].map((td) => Math.round(td.getBoundingClientRect().width)),
  };
}
```

통과 기준:

| 창·시나리오 | 무엇 | 통과 |
|---|---|---|
| 390 × 844 · 긴 이름 · 통계 접힘/펼침 | `scrollWidth === vw` | 참 |
| 〃 | `outside` | 빈 배열 |
| 〃 | `rowHeights` | 값 하나뿐이거나 1px 차이 둘(목업 실측: 37·38) — 300자 id 행도 한 줄 |
| 〃 | `nameCellWidth` | 접힘·펼침 모두 128(7rem + 1rem — 목업 실측 128) |
| 〃 | `nameLeftAfterScroll120` | 0(이름 칸이 왼쪽에 남는다 — 목업 실측 0) |
| 〃 | 옆으로 민 상태(`scrollLeft` 120) 스크린샷 | 값 글자가 이름 칸 뒤로 비쳐 보이지 않는다(이름 칸 바탕 불투명), 행 아래 선이 이름 칸에서 끊겨 보이지 않는다, 구획 제목·단추가 보인다 |
| 〃 | 목업 「안 C」 틀과 실제 화면을 나란히 스크린샷(처음 상태 + 민 상태) | 표 배치·줄 높이·경계선이 같다. 다른 점은 그 자리에서 목록으로 만들어 고친다 |
| 390 · 유지 구간(상승 시간·앞부분 버림)을 준 run | run 머리 칸 아랫줄(날짜 + 부하 요약 + 유지 구간 꼬리) | 줄바꿈 없이 한 줄이고 표는 상자 안에서만 밀린다(`outside` 빈 배열). 그 열 폭을 리포트에 적는다 — 목업의 아랫줄은 실제보다 짧게 꾸몄다 |
| 390·1440 · run 하나의 라벨이 200자 | run 머리 칸 | 라벨이 한 줄 말줄임(최대 12rem), 그 열이 다른 run 열보다 12rem 넘게 넓어지지 않는다 |
| 1440 × 900 · 보통 이름 · 접힘/펼침 | `colWidths`·`p50Height` | orchestrator가 넘긴 「전」 값과 같다 |
| 1440 × 900 · 긴 이름 | 300자 id 행 | 한 줄 말줄임, 표가 페이지 폭 안 |
| 390 · 인사이트가 있는 run | `InsightCompareMatrix` | `outside`에 나오면 같은 `overflow-x-auto` 상자를 씌우고 테스트를 더한다. 안 나오면 손대지 않고 「안 넘침」과 잰 값을 적는다. 인사이트는 open-loop로 슬롯을 모자라게 준 run(예: `target_rps` 200·`max_in_flight` 1)으로 만든다 |

숫자를 바꿨으면 최종 값과 잰 표를 리포트에 적는다. 끝나면 SKILL §4대로 정리(`pkill -f "target/debug/controller --db /tmp/cef.db"`, `.playwright-mcp/` 삭제, `git status --porcelain`에 untracked 0).

- [ ] **Step 6: 커밋** — `fix(ui): 좁은 창에서 비교 표·겹쳐 보기 그래프가 페이지를 밀지 않게 · 이름 칸 왼쪽 고정·한 줄 말줄임 (§B100 (1))`

---

## 구현 뒤(파이프라인 4–6단계 — task가 아니다)

- **최종 리뷰**: `handicap-reviewer`(BASE = `561eaf84` 다음 커밋부터). 초점: 「옛 동작의 부수효과에 기대던 소비자」 — `fmtMs`를 읽는 인쇄 표·문장 전부(`verdict.ts`·`sentences.ts`·`StepCodeTable`·`change.ts`·`dumbbell.ts`), `metricRows`를 읽는 `buildHeadline`·`cmpSummaryLines`, `setupRows` 칸을 읽는 곳.
- **보안**: `security-reviewer` 필수(spec §4 — CSV 수식 글자, 내보내기).
- **라이브 검증**(spec §5 표): B1 32,768자 id 실제 내보내기, B2 `=1+1` id CSV 바이트, B3 가능하면 실제 60초 준비 스텝, B4·B5 비교 화면·비교 인쇄, B8 확인만 — 300자 이름 run의 인쇄 PDF 한 장 + 준비 스텝 긴 이름(`SetupPrintTable`) + 비교 인쇄 요약판의 긴 이름(`.p-cmp-clamp1/2`). **B8 확인에서 「…」가 안 보이는 표가 나오면 이 슬라이스에서 고치지 않고 §B에 적는다.**
- **마무리 기록**(`/finish-slice`): 새 §B 번호는 `grep -n '^### B' docs/roadmap.md`의 마지막 + 1. §B100 (1)·(3)과 §B89 (3)의 해당 항목에 해소 표시, 「인쇄 통계 표의 긴 단계 이름」은 「결함 아님 — 실측」으로. 다음 릴리즈 노트 줄: CSV의 `'` 접두, 비교 화면 오류율 글자, 비교 인쇄 판정이 달라질 수 있음.

# per-step Δ 비교 XLSX Steps 시트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 비교 XLSX(`comparison_to_xlsx`)의 Steps 시트에 step별 p95 baseline-상대 Δ 열을 추가해, 화면 `CompareMatrix`에 이미 있는 per-step Δ를 export에서도 색·글리프로 보이게 한다.

**Architecture:** `crates/controller/src/export.rs`의 `comparison_to_xlsx` Steps 시트 루프(현 321–343) 한 곳만 변경한다. Summary Δ(288–319)와 **같은 헬퍼·같은 Format**(`delta`/`delta_cell_text`/`fmt_bad`/`fmt_good`)을 재사용하되, 셀 emit 여부(presence)는 화면 `compareReports.ts:62-75` step 행을 미러한다 — baseline·candidate 둘 다 그 스텝을 가질 때만 Δ 셀을 쓰고, 하나라도 없으면 블랭크. 신규 헬퍼·proto·migration·SQL·UI·CSV·단일-run XLSX 변경 0.

**Tech Stack:** Rust, `rust_xlsxwriter` 0.79.4(쓰기), `calamine` 0.26(테스트 읽기).

## Global Constraints

- **parity 계약 = `compareReports.ts:62-75`(Summary 아님)**: absent-baseline(baseline이 그 스텝 없음) → 화면 블랭크 → export도 **블랭크**. `unwrap_or(0.0)`로 "신규"를 내면 화면↔export parity(ADR-0030)가 깨진다. present-but-zero(스텝은 있고 p95=0)일 때만 "신규"/"동일".
- **`base`/`val`은 `Option<f64>`**(`.map(|s| s.p95_ms as f64)`, **`unwrap_or` 금지**). Δ 셀은 `(Some(b), Some(v))`일 때만 기록.
- **`dcol`은 비-baseline run마다 무조건 +1**(조건부 기록과 분리). 결합하면 N≥3에서 열이 밀려 헤더와 어긋난다.
- **기존 Steps 값 셀 byte-identical**: 값 열(col `1..=N`)은 무변경, Δ 열만 뒤에 추가.
- **calamine은 fill/font 색 미노출** → 테스트는 Δ *문자열*·블랭크만 단언. polarity→Format은 코드리뷰가 보증.
- **단일 green 커밋**: 헬퍼 재사용이라 신규 헬퍼 0 → TDD RED를 로컬에서 확인하되 커밋은 1회(RED-only 커밋은 `test --workspace` 게이트가 막음).
- **커밋은 `export.rs`(cargo-영향) 변경이라 FULL cargo workspace 게이트가 돈다(수 분)** — 단일 FOREGROUND blocking 호출(`run_in_background:false`, timeout 600000ms), 폴링 금지, 파이프 금지.

---

## Task 1: Steps 시트에 per-step p95 Δ 열 추가

**Files:**
- Modify: `crates/controller/src/export.rs:321-343` (Steps 시트 루프 — 프로덕션 변경)
- Test: `crates/controller/src/export.rs` `#[cfg(test)] mod tests` (인라인 — `comparison_xlsx_roundtrips`(716) 확장 + 신규 `comparison_xlsx_steps_delta`)

**Interfaces:**
- Consumes (모두 export.rs 내 기존):
  - `delta(metric: &str, base: f64, val: f64) -> Delta` (22) — `"p95_ms"`는 `lower_is_better` 집합(23)에 포함.
  - `delta_cell_text(d: &Delta, value: f64) -> String` (48) — pct None(base=0)이면 `value>0?"신규":"동일"`, polarity 글리프 prepend.
  - `Polarity` enum (7): `Good`/`Bad`/`Neutral`.
  - `fmt_bad`/`fmt_good`: `comparison_to_xlsx` 진입부(267–272)에 이미 생성된 지역 변수(Steps 루프에서 참조만).
  - `ReportStep` 필드(report.rs:98): `step_id: String`, `p95_ms: u64`.
- Produces: 새 함수/타입 없음. `comparison_to_xlsx`의 Steps 시트 출력에 Δ 열만 추가.

- [ ] **Step 1: 테스트 작성 — `comparison_xlsx_roundtrips`(716)에 Steps Δ 단언 추가**

`comparison_xlsx_roundtrips` 본문 끝(현재 마지막 단언 `assert_eq!(sum.get_value((2, 3)), …"▲ +50.0%"…)` 직후, 함수 닫는 `}` 전)에 추가:

```rust
        // Steps 시트: A·B 둘 다 step "s"를 가짐. row1 = "s",
        // col1 = A p95 = 100, col2 = B p95 = 150, Δ start = 1+N = 3 → Δ%B col3.
        let st = wb.worksheet_range("Steps").unwrap();
        assert_eq!(st.get_value((1, 1)), Some(&Data::Float(100.0)));
        assert_eq!(st.get_value((1, 2)), Some(&Data::Float(150.0)));
        assert_eq!(
            st.get_value((1, 3)),
            Some(&Data::String("▲ +50.0%".into()))
        );
```

(`wb`/`Data`는 이 테스트가 이미 import·바인딩함. `worksheet_range`는 owned `Range`를 반환하므로 `sum` 보유 후 재호출 OK.)

- [ ] **Step 2: 테스트 작성 — 신규 `comparison_xlsx_steps_delta`(presence·정렬)**

`comparison_xlsx_roundtrips` 함수 *뒤*에 새 `#[test]` 추가:

```rust
    #[test]
    fn comparison_xlsx_steps_delta() {
        use calamine::{Data, Reader, Xlsx, open_workbook_from_rs};
        use std::io::Cursor;
        // A = baseline(idx0), B(idx1), C(idx2).
        // 스텝 이름을 알파벳순으로 둬 union sort 후 행 인덱스를 고정한다.
        let mut a = report_with_steps(vec![
            step("b_align", 1, 100),      // A·C에 있고 B엔 없음 → 정렬 테스트
            step("c_candabsent", 1, 100), // A·B에 있고 C엔 없음 → candidate-absent
            step("d_newbase0", 1, 0),     // A에 p95=0(present-but-zero), C는 >0
        ]);
        a.run.id = "A".into();
        let mut b = report_with_steps(vec![step("c_candabsent", 1, 100)]);
        b.run.id = "B".into();
        let mut c = report_with_steps(vec![
            step("a_absentbase", 1, 80), // C에만 있음(A 없음) → absent-baseline
            step("b_align", 1, 200),
            step("d_newbase0", 1, 50),
        ]);
        c.run.id = "C".into();
        let bytes = comparison_to_xlsx(&[a, b, c], 0);
        let mut wb: Xlsx<Cursor<Vec<u8>>> = open_workbook_from_rs(Cursor::new(bytes)).unwrap();
        let st = wb.worksheet_range("Steps").unwrap();
        // 열: step_id=0, A=1, B=2, C=3; delta_start = 1+3 = 4 → Δ%B=4, Δ%C=5.
        // 행(union sort): a_absentbase=1, b_align=2, c_candabsent=3, d_newbase0=4.
        let blank = |v: Option<&Data>| matches!(v, None | Some(Data::Empty));

        // row1 a_absentbase: A 없음·C=80, base=None → Δ 둘 다 블랭크
        // (unwrap_or(0.0)였다면 Δ%C가 "▲ 신규" → 이 단언이 회귀 가드).
        assert!(blank(st.get_value((1, 1))));
        assert_eq!(st.get_value((1, 3)), Some(&Data::Float(80.0)));
        assert!(blank(st.get_value((1, 4))));
        assert!(blank(st.get_value((1, 5))));

        // row2 b_align: A=100·B 없음·C=200 → 정렬: Δ%B(4) 블랭크, Δ%C(5)="▲ +100.0%"
        // (B의 블랭크가 C의 Δ를 col4로 당기지 않음 = Finding 2 가드).
        assert_eq!(st.get_value((2, 1)), Some(&Data::Float(100.0)));
        assert!(blank(st.get_value((2, 2))));
        assert_eq!(st.get_value((2, 3)), Some(&Data::Float(200.0)));
        assert!(blank(st.get_value((2, 4))));
        assert_eq!(
            st.get_value((2, 5)),
            Some(&Data::String("▲ +100.0%".into()))
        );

        // row3 c_candabsent: A=100·B=100·C 없음 → C 값 셀·Δ%C 블랭크.
        assert!(blank(st.get_value((3, 3))));
        assert!(blank(st.get_value((3, 5))));

        // row4 d_newbase0: A=0(present)·C=50 → present-but-zero → Δ%C="▲ 신규"
        // (row1 absent=블랭크와 대조: present-but-zero만 "신규").
        assert_eq!(st.get_value((4, 1)), Some(&Data::Float(0.0)));
        assert_eq!(st.get_value((4, 5)), Some(&Data::String("▲ 신규".into())));
    }
```

- [ ] **Step 3: 테스트 실행 → RED 확인**

Run: `cargo nextest run -p handicap-controller export::tests::comparison_xlsx_steps_delta export::tests::comparison_xlsx_roundtrips`
Expected: 두 테스트 **FAIL** — 현 Steps 시트는 Δ 열이 없어 `get_value((1,3))`/`((2,5))`/`((4,5))`가 블랭크(`None`/`Empty`)라 문자열 단언이 실패(`comparison_xlsx_steps_delta`는 `(1,5)`/`(3,5)` 블랭크 단언은 통과하나 `(2,5)`/`(4,5)` 문자열 단언에서 실패). 컴파일은 통과(기존 헬퍼만 사용).

- [ ] **Step 4: 프로덕션 구현 — Steps 루프 교체(321–343)**

현 블록(321–343):
```rust
    // Steps: union of step_ids (sorted), columns = run p95.
    let ws = wb.add_worksheet();
    ws.set_name("Steps").expect("name");
    ws.write_string(0, 0, "step_id").expect("w");
    for (i, r) in reports.iter().enumerate() {
        ws.write_string(0, (1 + i) as u16, &r.run.id).expect("w");
    }
    let mut step_ids: Vec<String> = reports
        .iter()
        .flat_map(|r| r.steps.iter().map(|s| s.step_id.clone()))
        .collect();
    step_ids.sort();
    step_ids.dedup();
    for (ri, sid) in step_ids.iter().enumerate() {
        let row = (ri + 1) as u32;
        ws.write_string(row, 0, sid).expect("w");
        for (i, r) in reports.iter().enumerate() {
            if let Some(st) = r.steps.iter().find(|s| &s.step_id == sid) {
                ws.write_number(row, (1 + i) as u16, st.p95_ms as f64)
                    .expect("w");
            }
        }
    }
```

아래로 교체:
```rust
    // Steps: union of step_ids (sorted), columns = run p95, then per-step p95 Δ.
    // Δ presence는 compareReports.ts step 행(62-75) 미러: baseline·candidate 둘 다
    // 그 스텝을 가질 때만 Δ 셀 기록(하나라도 없으면 블랭크). absent-baseline은
    // 화면이 블랭크라 export도 블랭크 — unwrap_or(0.0)로 "신규"를 내면 parity 깨짐.
    let ws = wb.add_worksheet();
    ws.set_name("Steps").expect("name");
    ws.write_string(0, 0, "step_id").expect("w");
    for (i, r) in reports.iter().enumerate() {
        ws.write_string(0, (1 + i) as u16, &r.run.id).expect("w");
    }
    let steps_delta_start = (1 + reports.len()) as u16;
    {
        let mut col = steps_delta_start;
        for (i, r) in reports.iter().enumerate() {
            if i != baseline_idx {
                ws.write_string(0, col, format!("\u{0394}% {}", r.run.id))
                    .expect("w");
                col += 1;
            }
        }
    }
    let mut step_ids: Vec<String> = reports
        .iter()
        .flat_map(|r| r.steps.iter().map(|s| s.step_id.clone()))
        .collect();
    step_ids.sort();
    step_ids.dedup();
    for (ri, sid) in step_ids.iter().enumerate() {
        let row = (ri + 1) as u32;
        ws.write_string(row, 0, sid).expect("w");
        // baseline p95 (그 스텝이 있을 때만 Some — absent면 None, unwrap_or 금지).
        let base = reports[baseline_idx]
            .steps
            .iter()
            .find(|s| &s.step_id == sid)
            .map(|s| s.p95_ms as f64);
        for (i, r) in reports.iter().enumerate() {
            if let Some(st) = r.steps.iter().find(|s| &s.step_id == sid) {
                ws.write_number(row, (1 + i) as u16, st.p95_ms as f64)
                    .expect("w");
            }
        }
        // Δ 셀: 비-baseline run마다 dcol 무조건 전진, 기록은 base·val 둘 다 Some일 때만.
        let mut dcol = steps_delta_start;
        for (i, r) in reports.iter().enumerate() {
            if i != baseline_idx {
                let val = r
                    .steps
                    .iter()
                    .find(|s| &s.step_id == sid)
                    .map(|s| s.p95_ms as f64);
                if let (Some(b), Some(v)) = (base, val) {
                    let d = delta("p95_ms", b, v);
                    let text = delta_cell_text(&d, v);
                    match d.polarity {
                        Polarity::Bad => ws.write_string_with_format(row, dcol, &text, &fmt_bad),
                        Polarity::Good => ws.write_string_with_format(row, dcol, &text, &fmt_good),
                        Polarity::Neutral => ws.write_string(row, dcol, &text),
                    }
                    .expect("w");
                }
                dcol += 1;
            }
        }
    }
```

- [ ] **Step 5: 테스트 실행 → GREEN 확인**

Run: `cargo nextest run -p handicap-controller export::tests::comparison_xlsx_steps_delta export::tests::comparison_xlsx_roundtrips`
Expected: 두 테스트 **PASS**.

- [ ] **Step 6: export 모듈 + 전체 컨트롤러 회귀 확인**

Run: `cargo nextest run -p handicap-controller export::`
Expected: export 테스트 전부 PASS(특히 `xlsx_roundtrips_summary_and_steps`(618 단일-run, 무변경)·`comparison_xlsx_has_insights_sheet`(918)·`golden_summary_deltas_match`(577) 회귀 없음).

Run: `cargo build -p handicap-worker && cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run -p handicap-controller`
Expected: 빌드·clippy(-D warnings) 깨끗, 컨트롤러 nextest 전부 PASS. (워커 선빌드 = e2e 워커 race 워밍, 루트 CLAUDE.md.)

- [ ] **Step 7: 커밋(단일 green, FOREGROUND blocking)**

명시 경로만 stage(`-A` 금지), 파이프 금지, `run_in_background:false`·timeout 600000ms 단일 호출:
```bash
git add crates/controller/src/export.rs
git commit -m "feat(export): 비교 XLSX Steps 시트 per-step p95 Δ 열

comparison_to_xlsx Steps 시트에 비-baseline run마다 Δ% 열 추가.
delta/delta_cell_text/fmt_bad/fmt_good 재사용(신규 헬퍼 0). presence는
compareReports.ts step 행 미러: base/val Option, 둘 다 Some일 때만 Δ 기록
(absent-baseline→블랭크, present-but-zero→신규)로 화면↔export parity 유지.
dcol 비-baseline run마다 무조건 전진(N≥3 열정렬). 기존 값 셀 byte-identical.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J2fxVzp4gMbtANyGJG8LzV"
```
커밋 후 `git log -1 --format="%H %s"`로 landed 확인(파이프 없이).

---

## Review & 검증 (orchestrator 담당 — 구현 task 밖)

- **최종 리뷰**: 단일-task plan이라 per-task 리뷰 = whole-branch 리뷰 = 동일 diff → **`handicap-reviewer` 1회**로 충족(1M 세션이므로 `model: opus` 명시 디스패치). wire 1:1·byte-identical 불변식·`compareReports.ts` presence parity·`dcol` 정렬·calamine 색-미독 정합을 본다. 리뷰 패키지 BASE = implementer 디스패치 직전 커밋(spec/plan docs 커밋 위).
- **code-quality 리뷰**: diff가 export read-path(engine/proto/migration/template/cast/env-dataset 무관)라 **path-gate 무매치 → Sonnet**.
- **보안 게이트**: diff가 요청실행/템플릿/캐스트/env·dataset 바인딩/업로드/trace-body 뷰어 무관 → **security-reviewer N/A**(예: predecessor xlsx-delta 슬라이스도 N/A).
- **라이브 검증**: `ReportJson`→바이트 순수 직렬화·Zod 미파싱(S-D 갭 부재) → **WAIVED**(predecessor와 동일). 대신 finish-stage 1회 **헤드리스 styles.xml sanity**(상시 테스트 아님): 비교 XLSX 직렬화 후 `unzip -p x.xlsx xl/styles.xml`로 `patternType="solid"`+`<fgColor rgb="FFFFC7CE"/>`(악화)·`FFC6EFCE`(개선)·font `FF9C0006`/`FF006100`, `sharedStrings.xml`의 `▲`/`▼` 글리프가 Steps Δ 셀에 실제로 참조되는지 1회 확인(Summary가 이미 같은 Format을 써 styles.xml은 동일할 수 있으나 Steps Δ 셀의 Format 참조를 확인).

## Self-Review (작성자 체크)

- **Spec coverage**: spec §3(레이아웃·Δ start=1+N), §4(Option base/val·둘 다 Some일 때 기록), §4.1(5케이스 중 4를 `comparison_xlsx_steps_delta`가 단언; 5번째 present-zero baseline·candidate v=0→"동일"은 Neutral 경로라 `delta_cell_text_mirrors_deltachip`(804)가 이미 잠금 — Steps 루프는 그 헬퍼로 forward만), §4.2(dcol 무조건 전진), §5(byte-identical 값 셀·N=1 0열·fmt 재사용), §6(roundtrip 확장 + 3-run steps_delta 4케이스), §7 트랩 — 전부 Task 1 Step 1·2·4 코드에 반영. §8(ADR 없음)·§9(백로그)는 코드 변경 없음.
- **Placeholder scan**: 모든 Step에 실제 코드/명령/기대결과 명시. 플레이스홀더 없음.
- **Type consistency**: `steps_delta_start: u16`, `base`/`val`: `Option<f64>`, `delta(&str,f64,f64)->Delta`, `delta_cell_text(&Delta,f64)->String`, `Polarity::{Bad,Good,Neutral}` — Step 4 코드와 테스트(Step 1·2) 전부 일치. 테스트 `blank` 클로저는 `Option<&Data>`(calamine `get_value` 반환형)과 매치.

<!-- spec·plan 둘 다 spec-plan-reviewer clean APPROVE 통과(2026-06-26). -->
<!-- REVIEW-GATE: APPROVED -->


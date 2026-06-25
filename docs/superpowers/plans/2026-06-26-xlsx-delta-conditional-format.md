# 비교 XLSX Δ 조건부 서식 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 비교 XLSX(`comparison_to_xlsx`)의 Summary 시트 Δ 열에 polarity 배경색 + ▲/▼ 글리프 + % 텍스트를 입혀 비교 UI(`CompareMatrix`)의 Δ 시각을 export에 대칭으로 옮긴다.

**Architecture:** 단일 파일(`crates/controller/src/export.rs`) 표현-only 변경. Δ 루프가 기존 `delta()`(공식 0-diff)를 호출해 얻은 `{pct, polarity}`를 새 순수 헬퍼 `delta_cell_text`/`format_pct`로 셀 문자열화하고, polarity별 `rust_xlsxwriter::Format`(옅은 fill) 3종으로 색칠해 `write_string_with_format`로 쓴다. `delta()`·골든 fixture·metric 방향·CSV·단일-run XLSX·다른 시트는 무변경.

**Tech Stack:** Rust, `rust_xlsxwriter` 0.79.4(셀 서식·정식 dep), `calamine`(테스트 읽기·dev dep).

## Global Constraints

- **단일 파일 `crates/controller/src/export.rs`만 변경.** 엔진/proto/migration/UI/CSV/단일-run XLSX/Steps·Runs·Insights 시트·Summary 비-Δ 셀 = 0-diff (spec R6/R7/§7).
- **`delta()`(export.rs:22-37)·`summary_metric`·`SUMMARY_METRICS`(export.rs:57)·`testdata/compare_golden.json`·`golden_summary_deltas_match` 0-diff** — 이 기능은 표현-only, 데이터 공식 무변경.
- **Fill 색 = Excel 옅은 fill:** bad = bg `0xFFC7CE` + font `0x9C0006`, good = bg `0xC6EFCE` + font `0x006100`, neutral = fill 없음(plain `write_string`).
- **`set_background_color`만으로 solid fill**(0.79.4 `format.rs:1646` fn·doc "pattern 미정의 시 solid 기본") — `set_pattern(Solid)` 불요.
- **UI `DeltaChip`(CompareMatrix.tsx:12-49) 1:1 미러:** bad=`▲`, good=`▼`, neutral=글리프 없음. 텍스트 = `pct None(base=0)` → `value>0?"신규":"동일"` / else `format_pct` = `{부호}{pct*100을 소수1자리}%`(부호 = `pct>=0?"+":""`).
- **base=0 셀도 쓴다**(현재 `if let Some(p)`로 빈 셀 → 이제 "신규"/"동일", spec R3). 이 한 케이스만 빈→텍스트, 나머지는 number→색칠 문자열.
- **커밋 1회(green).** 게이트(`cargo clippy -D warnings` dead_code + `cargo test`)가 헬퍼-only/RED-only 커밋을 막으므로 헬퍼+배선+테스트를 한 green 커밋으로 fold(로컬에서 RED→GREEN 확인하되 커밋은 1회). `bundle` feature 무관(`comparison_to_xlsx`는 비-bundle 함수) → 기본 워크스페이스 게이트로 충분.

---

### Task 1: Δ 셀 polarity 색 + ▲/▼ 글리프 (단일 green 커밋)

**Files:**
- Modify: `crates/controller/src/export.rs`
  - import 라인 `export.rs:4` (`Color`, `Format` 추가)
  - 헬퍼 `format_pct`/`delta_cell_text` 삽입 (`delta` 함수 뒤, `export.rs:37`과 `summary_metric`(39) 사이)
  - `comparison_to_xlsx` 진입부 Format 3종 (`export.rs:237` `let mut wb = Workbook::new();` 뒤)
  - Δ 쓰기 루프 교체 (`export.rs:269-277`)
  - 단위 테스트 + `comparison_xlsx_roundtrips` 확장 (`mod tests`, `export.rs:466-` 내)

**Interfaces:**
- Consumes: 기존 `delta(metric, base, val) -> Delta`(export.rs:22), `summary_metric(&ReportSummary, metric) -> f64`(export.rs:40), `Delta { pct: Option<f64>, polarity: Polarity }`(export.rs:15-19), `Polarity { Good, Bad, Neutral }`(export.rs:7-13). 전부 무변경 재사용.
- Produces: `format_pct(pct: f64) -> String`, `delta_cell_text(d: &Delta, value: f64) -> String` (export-private 순수 헬퍼 — 이 슬라이스 외부 소비자 없음).

---

- [ ] **Step 1: import에 `Color`, `Format` 추가**

`export.rs:4`를 교체:

```rust
use rust_xlsxwriter::{Color, Format, Workbook, Worksheet};
```

(현재: `use rust_xlsxwriter::{Workbook, Worksheet};`)

- [ ] **Step 2: 실패하는 테스트 작성 (헬퍼 단위 + 비교 roundtrip Δ-문자열)**

`mod tests`(export.rs:466-) 안에 단위 테스트 2개를 추가(예: `comparison_xlsx_roundtrips`(691) 뒤). `use super::*`가 이미 있어 `delta_cell_text`/`format_pct`/`Delta`/`Polarity` 접근 가능:

```rust
    #[test]
    fn format_pct_mirrors_ui() {
        assert_eq!(format_pct(0.5), "+50.0%");
        assert_eq!(format_pct(-0.029), "-2.9%");
        assert_eq!(format_pct(0.0), "+0.0%");
        assert_eq!(format_pct(1.0), "+100.0%");
    }

    #[test]
    fn delta_cell_text_mirrors_deltachip() {
        use Polarity::*;
        // 일반 pct + 글리프
        assert_eq!(
            delta_cell_text(&Delta { pct: Some(0.5), polarity: Bad }, 150.0),
            "▲ +50.0%"
        );
        assert_eq!(
            delta_cell_text(&Delta { pct: Some(-0.182), polarity: Good }, 9.0),
            "▼ -18.2%"
        );
        // 동률(val==base) → Neutral, 글리프 없음
        assert_eq!(
            delta_cell_text(&Delta { pct: Some(0.0), polarity: Neutral }, 100.0),
            "+0.0%"
        );
        // base=0 → "신규"/"동일" (골든 fixture 미커버 분기 — spec §5.1 nit)
        assert_eq!(
            delta_cell_text(&Delta { pct: None, polarity: Good }, 9.0),
            "▼ 신규"
        );
        assert_eq!(
            delta_cell_text(&Delta { pct: None, polarity: Bad }, 5.0),
            "▲ 신규"
        );
        assert_eq!(
            delta_cell_text(&Delta { pct: None, polarity: Neutral }, 0.0),
            "동일"
        );
    }
```

그리고 `comparison_xlsx_roundtrips`(export.rs:674-691)의 마지막 단언(`assert_eq!(sum.get_value((2, 2)), Some(&Data::Float(150.0)));`, line 690) **바로 뒤**에 Δ 셀 문자열 단언을 추가:

```rust
        // Δ 열(col 3 = delta_start = 1 metric + 2 run 값 뒤). p95 100→150:
        // lower_is_better, val>base → Bad, pct=+50.0% → "▲ +50.0%".
        assert_eq!(
            sum.get_value((2, 3)),
            Some(&calamine::Data::String("▲ +50.0%".into()))
        );
```

(`comparison_xlsx_roundtrips`는 이미 `use calamine::{Data, ...}`를 함수 상단에 `use`하므로 `Data::String("▲ +50.0%".into())`로 써도 됨 — 위 정규화 경로 `calamine::Data::String`는 명시형. 둘 중 하나로 일관되게.)

- [ ] **Step 3: 테스트 실행 → 실패 확인**

Run:
```bash
cargo test -p handicap-controller export
```
Expected: `format_pct_mirrors_ui`·`delta_cell_text_mirrors_deltachip`는 컴파일 에러(`cannot find function delta_cell_text`/`format_pct`), `comparison_xlsx_roundtrips`는 Δ 셀이 아직 `Data::Float(0.5)`라 새 단언에서 FAIL. (컴파일 에러로 전체가 안 돌면 그 자체가 RED 신호.)

- [ ] **Step 4: 헬퍼 `format_pct`/`delta_cell_text` 추가**

`delta` 함수(export.rs:37 `}`) **뒤**, `summary_metric`(line 39) **앞**에 삽입:

```rust
/// pct 분수를 UI `formatPct`(CompareMatrix.tsx:12-14)와 동일하게: 부호 + 소수1자리 + '%'.
/// 음수 pct는 자체 '-'를 가지므로 양수/0에만 '+'를 붙인다.
fn format_pct(pct: f64) -> String {
    let sign = if pct >= 0.0 { "+" } else { "" };
    format!("{sign}{:.1}%", pct * 100.0)
}

/// 비교 Δ 셀 텍스트(글리프 + %)를 UI `DeltaChip`(CompareMatrix.tsx:17-49)과 1:1로 생성.
/// pct None(base=0) → value>0 ? "신규" : "동일". 글리프: Bad=▲, Good=▼, Neutral=없음.
fn delta_cell_text(d: &Delta, value: f64) -> String {
    let base = match d.pct {
        None => {
            if value > 0.0 {
                "신규".to_string()
            } else {
                "동일".to_string()
            }
        }
        Some(p) => format_pct(p),
    };
    match d.polarity {
        Polarity::Bad => format!("▲ {base}"),
        Polarity::Good => format!("▼ {base}"),
        Polarity::Neutral => base,
    }
}
```

- [ ] **Step 5: Format 3종 + Δ 루프 교체**

(a) `comparison_to_xlsx`(export.rs:236) 진입부 — `let mut wb = Workbook::new();`(line 237) **뒤**에 삽입:

```rust
    // Δ 셀 polarity 색(Excel 옅은 fill). set_background_color만으로 solid(0.79.4 기본).
    // 1회 생성·재사용(루프마다 재생성 금지). neutral은 plain write_string(fill 없음).
    let fmt_bad = Format::new()
        .set_background_color(Color::RGB(0xFFC7CE))
        .set_font_color(Color::RGB(0x9C0006));
    let fmt_good = Format::new()
        .set_background_color(Color::RGB(0xC6EFCE))
        .set_font_color(Color::RGB(0x006100));
```

(b) Δ 쓰기 루프(export.rs:269-277) **전체**를 교체:

```rust
        let mut dcol = delta_start;
        for (i, r) in reports.iter().enumerate() {
            if i != baseline_idx {
                let val = summary_metric(&r.summary, metric);
                let d = delta(metric, base, val);
                let text = delta_cell_text(&d, val);
                match d.polarity {
                    Polarity::Bad => ws.write_string_with_format(row, dcol, &text, &fmt_bad),
                    Polarity::Good => ws.write_string_with_format(row, dcol, &text, &fmt_good),
                    Polarity::Neutral => ws.write_string(row, dcol, &text),
                }
                .expect("w");
                dcol += 1;
            }
        }
```

(교체 전 원본은 `if let Some(p) = delta(...).pct { ws.write_number(row, dcol, p)... }` — base=0이면 빈 셀이었다. 새 코드는 항상 셀을 쓴다 = spec R3.)

- [ ] **Step 6: 테스트 실행 → 통과 확인**

Run:
```bash
cargo test -p handicap-controller export
```
Expected: PASS. `format_pct_mirrors_ui`·`delta_cell_text_mirrors_deltachip`·`comparison_xlsx_roundtrips`(기존 run-값 단언 `(2,1)=100.0`·`(2,2)=150.0` + 새 `(2,3)="▲ +50.0%"`) 전부 green. `golden_summary_deltas_match`·`csv_has_header_and_one_row_per_step`·`xlsx_roundtrips_summary_and_steps`(단일-run) 등 기존 테스트도 green(byte-identical 경로 무변경).

- [ ] **Step 7: 워크스페이스 게이트 확인 (커밋 전)**

Run (cold-build flake 예방 워밍 포함):
```bash
cargo build -p handicap-worker && cargo build --workspace && cargo clippy -p handicap-controller --all-targets -- -D warnings
```
Expected: 0 에러/0 경고. 특히 `delta_cell_text`/`format_pct`가 production(Δ 루프)에서 호출되므로 dead_code 경고 없음. (clippy `-D warnings`가 헬퍼 미사용을 잡지 않음을 확인.)

- [ ] **Step 8: 커밋 (단일 green, 파이프 없이, foreground)**

`git commit`은 `run_in_background:false` 단일 호출(폴링 금지), 파이프 없이(exit code 가시성). pre-commit이 전체 워크스페이스 cargo 게이트를 수 분 돌린다.

```bash
git add crates/controller/src/export.rs
git commit -m "$(cat <<'EOF'
feat(export): 비교 XLSX Δ 셀 polarity 색 + ▲/▼ 글리프 (화면↔export 대칭)

비교 XLSX Summary 시트 Δ 열을 생 decimal → polarity 배경색(Excel 옅은
fill)+▲/▼ 글리프+% 문자열로. UI CompareMatrix DeltaChip 1:1 미러
(악화 빨강 ▲ / 개선 초록 ▼ / 동률 회색, base=0 신규/동일).
delta()·골든 fixture·metric 방향·CSV·단일-run XLSX·기타 시트 0-diff.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

커밋 직후 `git log -1 --stat`으로 landed 확인(`export.rs` 1파일만 변경).

---

## Self-Review (작성자 체크)

**1. Spec coverage:**
- R1(Δ 색+글리프) → Step 5(b) 루프. R2(DeltaChip 미러) → Step 4 헬퍼 + Step 2 단위. R3(base=0 셀) → Step 5(b) 항상-쓰기 + Step 2 None 분기 단위. R4(`delta_cell_text` 순수) → Step 4. R5(Format 3종·확정 API) → Step 5(a). R6/R7(byte-identical·0-diff) → Step 6에서 기존 테스트 green으로 확인 + Global Constraints. R8(헤더 무변경) → Δ 루프만 교체(header 라인 256 미접촉). 라이브 WAIVED(spec §5.2) — Task 없음(production diff = export.rs read-path·S-D 갭 부재).
- 모든 R 커버됨. 갭 없음.

**2. Placeholder scan:** TBD/TODO/"적절히 처리" 없음. 모든 step에 실제 코드/명령/기대출력.

**3. Type consistency:** `format_pct(f64)->String`·`delta_cell_text(&Delta, f64)->String` Step 2(호출)↔Step 4(정의) 시그니처 일치. `Delta`/`Polarity`/`summary_metric`/`delta` 전부 기존 export.rs 심볼(무변경). `write_string_with_format`/`write_string`/`Color::RGB`/`Format`/`set_background_color`/`set_font_color` 전부 rust_xlsxwriter 0.79.4 검증됨(spec §6).

## 리뷰 이력

spec-plan-reviewer(2026-06-26): substantive 이슈 0 — float 포맷·타입·rust_xlsxwriter 0.79.4 API·borrow/lifetime·`(2,3)` roundtrip·게이트 boundary·byte-identical 전부 file:line 검증 통과. 지적된 cosmetic line-citation 2건(`mod tests` 466·`set_background_color` 1646) 수정 반영 후 잔여 차단 이슈 없음.

<!-- REVIEW-GATE: APPROVED -->

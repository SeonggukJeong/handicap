# 비교 XLSX Δ 조건부 서식 (배경색 + ▲/▼ 글리프)

- 날짜: 2026-06-26
- 상태: 설계 (구현 전)
- 관련: [ADR-0030](../../adr/0030-run-comparison-report-export.md)(Run 비교 + 리포트 export·하이브리드·골든 fixture TS↔Rust 패리티), `crates/controller/CLAUDE.md`(리포트 export §·골든 fixture 계약), `ui/CLAUDE.md`(비교 매트릭스·색 단언 jsdom 함정), compare-view-depth spec §7(이 항목의 출처 연기), `docs/roadmap.md`(§B7 next-up shortlist #1)
- **범위 = 비교 XLSX(`comparison_to_xlsx`)의 Summary 시트 Δ 열에 polarity 색(배경 fill) + ▲/▼ 글리프 + % 텍스트를 입혀, 방금 비교 UI(`CompareMatrix`)에 넣은 baseline-상대 Δ polarity 시각을 화면↔export 대칭으로 완성한다.** 표현(presentation)-only — `delta()` 로직·골든 fixture·metric 방향·CSV는 0-diff.

## 1. 배경 & 동기

compare-view-depth(2026-06-25)에서 비교 UI `CompareMatrix`의 Δ 칩이 baseline-상대 polarity를 시각화하게 됐다(`ui/src/components/compare/CompareMatrix.tsx:17-49` `DeltaChip`): 악화=빨강 `▲`, 개선=초록 `▼`, 동률=회색(글리프 없음), 색 단독 금지(글리프+가시 % 동반). 그 spec §7은 **XLSX Δ 조건부 서식**을 명시적으로 연기했고, roadmap §B7 next-up shortlist #1로 올라와 있다.

현재 비교 XLSX(`comparison_to_xlsx`, `crates/controller/src/export.rs:236-343`)의 Summary 시트는 Δ 열을 **포맷 없는 생 decimal**로 쓴다(`export.rs:272-273` `write_number(row, dcol, p)` — `p`는 pct 분수, 예 `0.5`). 색도 글리프도 % 포맷도 없어, 화면에서 한눈에 보이는 "이 후보가 baseline 대비 좋아졌나/나빠졌나"가 export에선 사라진다. 이 슬라이스는 그 갭을 닫는다.

**비-목표:** `delta()` 공식/polarity 규칙 변경·metric 방향(lower-is-better 집합)·`SUMMARY_METRICS` 순서·골든 fixture 변경·CSV export 변경·단일-run XLSX(`report_to_xlsx`) 변경·Steps/Runs/Insights 시트 변경·엔진/proto/migration/UI 변경.

## 2. 사용자 결정 (이 설계 세션에서 확정)

1. **Δ 셀 인코딩 = 배경 fill + ▲/▼ 글리프 문자열** (폰트색-only·숫자-유지 대안 기각). 색+글리프+값 3채널 중복 = Excel a11y 최강이고 UI ▲/▼를 거의 그대로 미러. 대가: Δ 셀이 숫자가 아닌 문자열(정렬 불가)이지만 비교 Summary는 5행 고정표라 무의미.
2. **Fill 색 = Excel 표준 옅은 fill**: 악화=옅은 빨강 `#FFC7CE`+진한 빨강 글자 `#9C0006`, 개선=옅은 초록 `#C6EFCE`+진한 초록 글자 `#006100`, 동률=fill 없음. (UI 동일 채도 red-600/green-600 fill 대안 기각 — 옅은 fill이 스프레드시트 가독성↑.)
3. **CSV는 XLSX 전용 — `comparison_to_csv` byte-identical 유지**(기계 파싱 대상·색 없음·roadmap 제목도 "XLSX 색"). Δ를 raw `{p:.6}` 그대로.

## 3. 요구사항 (R-번호)

### 핵심
- **R1 — Δ 셀 polarity 색 + 글리프.** `comparison_to_xlsx`의 Summary 시트 Δ 열(`export.rs:269-277` 루프)에서 각 Δ 셀을 polarity별 배경 fill + ▲/▼ 글리프 + % 텍스트 문자열로 쓴다. polarity·pct·base는 **기존 `delta()`(export.rs:22-37)를 그대로** 호출해 얻는다(공식 0-diff).
- **R2 — UI `DeltaChip` 1:1 미러.** 셀 텍스트·글리프 규칙이 `CompareMatrix.tsx:17-49`와 동일:
  - `pct == None`(base=0) → `value > 0 ? "신규" : "동일"` (UI line 22-24).
  - 그 외 → `formatPct(pct)` = `{부호}{pct*100을 소수1자리}%` (UI line 12-14: `sign = pct>=0?"+":""`, `(pct*100).toFixed(1)`).
  - 글리프: `Polarity::Bad` → `▲` 접두, `Polarity::Good` → `▼` 접두, `Polarity::Neutral` → 글리프 없음 (UI line 29-48).
  - 예: p95 100→150 ⇒ pct `0.5`·Bad ⇒ `"▲ +50.0%"`(빨강 fill). rps 0→N ⇒ pct None·value>0·Good ⇒ `"▼ 신규"`(초록 fill). error_rate 0→N ⇒ Bad ⇒ `"▲ 신규"`(빨강 fill). val==base ⇒ pct `Some(0.0)`·Neutral ⇒ `"+0.0%"`(fill 없음).
- **R3 — base=0 셀도 쓴다(빈→텍스트, 의도된 동작 변경).** 현재 루프는 `if let Some(p) = …pct`라 base=0(pct None)이면 **빈 셀**을 남긴다(`export.rs:272`). UI는 base=0에 "신규"/"동일"을 보이므로 이제 **항상 셀을 쓴다**. 이 한 케이스만 빈-셀→텍스트로 바뀌고, 나머지는 number→색칠 문자열로 바뀐다.
- **R4 — `delta_cell_text(d: &Delta, value: f64) -> String` 순수 헬퍼.** R2의 텍스트+글리프 규칙을 캡슐화한 export-private 순수 함수. 단위 테스트가 전 분기(Bad/Good/Neutral·신규/동일·부호·소수1자리)를 잠근다. `format_pct(pct: f64) -> String`(부호+`{:.1}%`)은 별도 헬퍼 또는 인라인.
- **R5 — polarity별 `rust_xlsxwriter::Format` 3종.** `comparison_to_xlsx` 진입부에서 1회 생성·재사용(루프마다 재생성 금지): bad(빨강 fill+글자), good(초록 fill+글자), neutral(fill 없음=plain `write_string`). Δ 쓰기는 `write_string_with_format(row, dcol, &text, &fmt)`(neutral은 plain `write_string`). **fill 표현 확정(0.79.4 소스 검증)**: `Format::new().set_background_color(Color::RGB(0xFFC7CE)).set_font_color(Color::RGB(0x9C0006))` — `set_background_color`(format.rs:1646)만으로 solid fill(doc "If a pattern hasn't been defined then a solid fill pattern is used as the default"), `set_pattern(FormatPattern::Solid)` **불요**. `Color::RGB(u32)`(color.rs:142)·`set_font_color`(format.rs:945)·`write_string_with_format`(worksheet.rs:2842) 전부 0.79.4 존재. `use rust_xlsxwriter::{…, Color, Format}` 추가(현 `export.rs:4`는 `{Workbook, Worksheet}`만).

### 보조
- **R6 — CSV·단일-run·기타 시트 byte-identical.** `comparison_to_csv`(export.rs:175-207)·`report_to_xlsx`(단일-run, Δ 없음)·비교 XLSX의 Steps/Runs/Insights 시트·Summary 시트의 비-Δ 셀(metric 라벨·run 값 number)은 **무변경**. 비교 XLSX에서 바뀌는 건 Summary 시트 Δ 열 셀뿐.
- **R7 — `delta()`/골든 fixture/metric 방향 0-diff.** `testdata/compare_golden.json`·`golden_summary_deltas_match`(export.rs)·`compareReports.ts::computeDelta`(TS)·`SUMMARY_METRICS`·lower-is-better 집합 전부 무변경. 데이터 parity 계약 그대로(이 기능은 표현-only).
- **R8 — Δ 헤더 무변경.** Summary 헤더 `Δ% {run_id}`(export.rs:256) 유지(셀이 이미 %를 담아도 헤더는 그대로).

## 4. 아키텍처

### 4.1 변경 지점 (단일 파일 `crates/controller/src/export.rs`)

| 항목 | 위치 | 변경 |
|---|---|---|
| `delta_cell_text`/`format_pct` | export.rs 상단(`delta` 인근) | 신규 export-private 순수 헬퍼 |
| polarity Format 3종 | `comparison_to_xlsx` 진입부(`export.rs:237` 인근) | 신규(1회 생성) |
| Δ 쓰기 루프 | `export.rs:269-277` | `write_number(pct)` → `delta()` 호출 → `delta_cell_text` + polarity Format으로 `write_string_with_format`; base=0도 씀(R3) |

### 4.2 Δ 쓰기 루프 (변경 후 의사코드)

```rust
// 진입부(1회):
let fmt_bad = Format::new().set_background_color(Color::RGB(0xFFC7CE)).set_font_color(Color::RGB(0x9C0006)) /* + solid pattern if 필요 */;
let fmt_good = Format::new().set_background_color(Color::RGB(0xC6EFCE)).set_font_color(Color::RGB(0x006100)) /* + solid pattern if 필요 */;
// neutral = plain write_string (fill 없음)

// 루프(export.rs:269-277 대체):
let mut dcol = delta_start;
for (i, r) in reports.iter().enumerate() {
    if i != baseline_idx {
        let val = summary_metric(&r.summary, metric);
        let d = delta(metric, base, val);           // 기존 공식 그대로(R7)
        let text = delta_cell_text(&d, val);         // R2/R4
        match d.polarity {
            Polarity::Bad => ws.write_string_with_format(row, dcol, &text, &fmt_bad),
            Polarity::Good => ws.write_string_with_format(row, dcol, &text, &fmt_good),
            Polarity::Neutral => ws.write_string(row, dcol, &text),
        }.expect("w");
        dcol += 1;
    }
}
```

### 4.3 `delta_cell_text` (의사코드)

```rust
fn format_pct(pct: f64) -> String {
    let sign = if pct >= 0.0 { "+" } else { "" }; // 음수는 자체 '-' 보유
    format!("{sign}{:.1}%", pct * 100.0)
}

fn delta_cell_text(d: &Delta, value: f64) -> String {
    let base = match d.pct {
        None => if value > 0.0 { "신규".to_string() } else { "동일".to_string() }, // base=0
        Some(p) => format_pct(p),
    };
    match d.polarity {
        Polarity::Bad => format!("▲ {base}"),
        Polarity::Good => format!("▼ {base}"),
        Polarity::Neutral => base,
    }
}
```

(UI는 글리프와 텍스트를 공백 없이 붙이지만[`▲{text}`], 셀 가독성을 위해 `"▲ "` 한 칸을 둔다 — 의도된 사소한 비대칭. 글리프·텍스트·polarity 규칙 자체는 1:1.)

## 5. 테스트 전략

### 5.1 단위 (`crates/controller`, pre-commit cargo 게이트 내)
- **`delta_cell_text` 전 분기**: Bad/Good/Neutral × {일반 pct·base=0(신규/동일)·동률(+0.0%)}, 부호(`+`/`-`), 소수 1자리. 예: `(Bad, Some(0.5), 150.0)`→`"▲ +50.0%"`, `(Good, None, 9.0)`→`"▼ 신규"`, `(Neutral, Some(0.0), 100.0)`→`"+0.0%"`, `(Neutral, None, 0.0)`→`"동일"`.
- **`comparison_xlsx_roundtrips` 확장(또는 신규 테스트)**: calamine으로 Δ 셀 **문자열** 단언(baseline 100→cand 150 p95 ⇒ Δ 열 셀 = `"▲ +50.0%"`). 기존 run-값 셀(p95 base=100·cand=150 number) 단언은 Δ가 문자열이 돼도 다른 열이라 **그대로 green**(export.rs:675-691 — run-값 열만 읽음, Δ 열 미독). 회귀 확인 필수.
- **fill 색은 calamine으로 미검증**(값 리더라 셀 fill 노출 안 함) → polarity→Format 매핑은 **헬퍼 단위 테스트 + 코드리뷰**로 보증(jsdom에서 색/툴팁 단언 불가와 같은 선례, `ui/CLAUDE.md`). styles.xml unzip 검사는 과설계라 비채택.
- **골든 fixture 테스트 green 유지**: `golden_summary_deltas_match`는 `delta()` 무변경이라 통과(R7).

### 5.2 라이브 검증
- export는 run-생성/엔진/Zod-파싱 경로가 아니라 `ReportJson`→바이트 순수 직렬화(S-D 갭 부재 — 파일 다운로드, Zod 미파싱) → **라이브 검증 WAIVED 예상**. finish 단계 nice-to-have로 실제 비교 XLSX 1개를 내려받아 색/글리프 렌더를 **수동 1회 열어보기**(셀 텍스트는 calamine 단위가 커버, 시각 fill만 육안).

## 6. 에러 처리 / 외부 라이브러리 주의
- **rust_xlsxwriter 0.79.4 fill API (확정·R5 참조)**: `set_background_color`(0.79.4 `format.rs:1646`)만으로 solid fill(doc "pattern 미정의 시 solid 기본") — `set_pattern(FormatPattern::Solid)` 불요. `Color::RGB(u32)`·`set_font_color`·`write_string_with_format`·`Format` 모두 0.79.4 존재. `rust_xlsxwriter`는 정식 dep(dev 아님 — `crates/controller/CLAUDE.md` "rust_xlsxwriter는 정식 dep여야 한다", `Cargo.toml:30`).
- **`write_string_with_format` 실패**: 기존 코드 컨벤션대로 `.expect("w")`(export.rs 전반이 동일 — 비교 export는 in-memory 버퍼라 실패는 프로그래밍 오류).

## 7. byte-identical 불변식 요약

| 대상 | 불변식 | 근거 |
|---|---|---|
| `comparison_to_csv` 전체 | **byte-identical** | 무변경 (R6) |
| `report_to_xlsx`(단일-run) | **byte-identical** | Δ 없음, 무변경 (R6) |
| 비교 XLSX Steps/Runs/Insights 시트 | **byte-identical** | 무변경 (R6) |
| 비교 XLSX Summary 비-Δ 셀(metric·run 값) | **byte-identical** | 무변경 (R6) |
| `delta()`·골든 fixture·metric 방향·CSV `delta_pct` | **0-diff** | 표현-only (R7) |
| 비교 XLSX Summary Δ 셀 | 변경(number→색칠 문자열·base=0 빈→텍스트) | 이 기능 본체 (R1-R3) |

## 8. parity / drift 노트
- `delta_cell_text`/`format_pct`는 UI `formatPct`+신규/동일을 미러하는 **표현 헬퍼**(골든 fixture 비관할). Rust↔TS drift 위험 낮음(부호+소수1자리%). **알려진 사소 차**: Rust `{:.1}`(round-half-to-even)과 JS `toFixed(1)`이 정확히 `.x5` tie에서 갈릴 수 있으나, 데이터 parity(골든)는 hard contract 그대로이고 표현 문자열은 비관할이라 무해. 로undtrip 테스트는 tie 안 나는 값(100→150=+50.0% 정확)으로.
- **새 골든 fixture 불필요**(데이터 공식 무변경). UI↔Rust 표현 문자열 parity는 "코드리뷰 by inspection" 수준(데이터 parity와 분리).

## 9. 미해결 / 연기
- per-step Δ(Steps 시트엔 Δ 없음 — 향후 별도)·active-VU 비교 오버레이·색각 보조(추가 텍스처/패턴)·UI `CompareMatrix` 헤더 색 스와치(이미 compare-view-polish에서 완료) — 본 슬라이스 밖.
- Δ 셀을 숫자로 유지하면서 색만 입히는 변형(정렬 가능) — 사용자가 글리프 포함 문자열을 택해 비채택(§2.1).

## 10. ADR 영향
- 신규 ADR 불필요 — **ADR-0030(Run 비교 + 리포트 export) 범위 내 additive**(하이브리드 export의 XLSX 표현 강화, 골든 fixture 데이터 계약 불변). ADR-0030 인덱스/본문 갱신 불요(표현 디테일은 build-log/spec이 단일 소스).

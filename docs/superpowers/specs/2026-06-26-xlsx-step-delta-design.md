# per-step Δ 조건부 서식 (비교 XLSX Steps 시트) — 설계

- 날짜: 2026-06-26
- 상태: 설계
- 출처: `2026-06-26-xlsx-delta-conditional-format-design.md` §9 연기 항목 "per-step Δ(Steps 시트엔 Δ 없음 — 향후 별도)" / roadmap shortlist #2
- 범위 결정(ADR): ADR-0030(Run 비교 + 리포트 export) 범위 내 additive, 새 ADR 불필요(§8)

## 1. 배경 · 목표

직전 슬라이스(xlsx-delta-conditional-format)는 비교 XLSX **Summary** 시트의 Δ 열에 baseline-상대 polarity 시각(악화 `▲`/개선 `▼`·옅은 fill·% 문자열)을 입혀 화면 `CompareMatrix` ↔ export를 대칭화했다. 그 슬라이스는 **Steps 시트는 손대지 않고** §9로 연기했다 — 비교 XLSX의 Steps 시트는 step별 p95를 run 열로 나열만 할 뿐 Δ 열이 없다.

**중요(spec-plan-reviewer 적발)**: 화면 `CompareMatrix`는 **이미 step별 p95 Δ 칩을 렌더한다** — `ui/src/compare/compareReports.ts:62-75`의 step 행이 `computeDelta("p95_ms", base, value)`를 계산하고 `CompareMatrix.tsx`의 `DeltaChip`(18)이 그린다. 즉 **화면에는 step Δ가 있고 비교 XLSX에만 없다**. 따라서 이 슬라이스의 본질은 "export를 *기존 화면 Steps Δ*에 맞춰 따라잡게" 하는 것이고, **Steps Δ의 parity 계약은 Summary가 아니라 `compareReports.ts`의 step 행 로직**이다(absent 처리가 Summary와 다름 — §4.1).

이 슬라이스는 **비교 XLSX의 Steps 시트에도 step별 p95 Δ 열**을 더해, "어느 스텝이 baseline 대비 느려졌나/빨라졌나"를 export에서 색·글리프로 바로 보이게 한다. 시각 표현(글리프·Format·% 문자열)은 Summary Δ와 **같은 헬퍼·같은 Format**(`delta`/`delta_cell_text`/`fmt_bad`/`fmt_good`)을 재사용하되, **셀 emit 여부(presence)는 `compareReports.ts` step 행을 미러**한다(새 헬퍼 0).

목표:
- Steps 시트 각 비-baseline run에 `Δ% {run_id}` 열 추가(step별 p95 baseline-상대).
- 시각 표현은 Summary Δ와 1:1(악화 `▲`+`#FFC7CE`/`#9C0006`, 개선 `▼`+`#C6EFCE`/`#006100`, 동률 plain).
- 기존 Steps 값 셀(step별 run p95)은 **byte-identical**(열 *추가*만, 기존 셀 무변경).

비목표:
- p50/p99 per-step Δ, per-step error-rate Δ — **백로그**(§9).
- 단일-run XLSX·CSV·Summary/Runs/Insights 시트·proto·migration·UI — **0-diff**.

## 2. 범위

| 영역 | 변경 |
|---|---|
| `crates/controller/src/export.rs` `comparison_to_xlsx` **Steps 시트 루프**(현 321–343) | Δ 열 추가(유일한 프로덕션 변경) |
| `export.rs` 테스트(`comparison_xlsx_roundtrips` 정상 Δ 확장 **+** 신규 `comparison_xlsx_steps_delta` presence·정렬) | Steps Δ 셀 단언 추가 |
| 그 외 전부 | **0-diff** |

명시적 0-diff: `delta()`(22)·`format_pct`(41)·`delta_cell_text`(48)·`Polarity`(7)·`SUMMARY_METRICS`(84)·`fmt_bad`/`fmt_good`(267–272 — 이미 함수 진입부에 생성됨, 재사용)·`comparison_to_csv`·`report_to_xlsx`(단일-run)·Summary/Runs/Insights 시트·`testdata/compare_golden.json`·`golden_summary_deltas_match`·`runs.rs` 라우트·proto·migration·`ui/`.

**`ui/`가 0-diff인 이유**: 화면 Steps Δ는 *이미 존재*한다(`compareReports.ts`/`CompareMatrix.tsx`). 이 슬라이스는 export를 그 기존 UI 동작에 맞추는 것이라 UI 변경이 없다 — UI를 바꾸는 게 아니라 export가 UI를 따라간다.

## 3. Steps 시트 레이아웃

Summary 시트(288–319)의 "값 열 전부 → Δ 열 전부(grouped)" 패턴을 그대로 미러한다.

현재(열):
```
step_id | run0 | run1 | … | runN-1
```
변경 후:
```
step_id | run0 | run1 | … | runN-1 | Δ% {비-base run0} | Δ% {비-base run1} | …
```

열 인덱스(현 루프와 동일 + Δ):
- col 0 = `step_id`
- col `1 + i` (i ∈ 0..N) = run i의 그 스텝 p95(number) — **현행 그대로, 무변경**
- Δ 시작 = `1 + N` (N = `reports.len()`). 비-baseline run마다 1열, `reports` 순서대로.
- Δ 헤더 = `format!("\u{0394}% {}", r.run.id)` (Summary 291과 동일 표현).

행: 현행 그대로 — 모든 run의 step_id union을 `sort()`+`dedup()`한 정렬 목록(328–333), 각 step_id가 1행.

## 4. Δ 계산 · 셀 표현 — `compareReports.ts` step 행을 미러 (신규 헬퍼 0)

parity 계약은 `compareReports.ts:62-75`다. 그 로직을 Rust로 1:1 옮긴다:

```ts
// compareReports.ts — step 행 (참조)
const baseStep = reports[baselineIdx].steps.find((s) => s.step_id === sid);
const base = baseStep ? baseStep.p95_ms : null;            // ① absent baseline → null
const st = r.steps.find((s) => s.step_id === sid);
const value = st ? st.p95_ms : null;                       // ② absent candidate → null
if (i === baselineIdx || value === null || base === null)  // ③ 둘 중 하나라도 null → delta 없음(블랭크)
  return { value, delta: null };
return { value, delta: computeDelta("p95_ms", base, value) };  // ④ 둘 다 present → Δ
```

export Steps 루프(각 step 행 `sid`, 각 비-baseline run `r`):
- `base: Option<f64>` = `reports[baseline_idx].steps.iter().find(|s| s.step_id == *sid).map(|s| s.p95_ms as f64)` — **`unwrap_or(0.0)` 금지**(①: absent → `None`).
- `val: Option<f64>` = `r.steps.iter().find(|s| s.step_id == *sid).map(|s| s.p95_ms as f64)` (②).
- **둘 다 `Some`일 때만** Δ 셀 기록(③ `value !== null && base !== null` 미러). 하나라도 `None`이면 Δ 셀 **블랭크**(미기록).
- 둘 다 `Some(b)`/`Some(v)`: `let d = delta("p95_ms", b, v);` (④ — `"p95_ms"`는 `delta()`(23)의 `lower_is_better` 집합 포함) → `let text = delta_cell_text(&d, v);` → polarity → Format(Summary 310–315 동일 match: `Bad`→`&fmt_bad`, `Good`→`&fmt_good`, `Neutral`→plain `write_string`).

### 4.1 absent vs present-but-zero (Summary가 아니라 `compareReports.ts`와 동일)

화면 Steps Δ는 **세 경우를 구분**하고, export도 정확히 따라야 한다:

| baseline 스텝 | candidate 스텝 | 화면 `DeltaChip` | export Steps Δ 셀 |
|---|---|---|---|
| **absent**(`base=None`) | present | **블랭크**(`delta=null`→`DeltaChip` 18 `return null`) | **블랭크**(미기록) |
| present | **absent**(`val=None`) | **블랭크** | **블랭크** |
| present, **p95=0** | present, v>0 | `▲ 신규`(`pct=null`→`CompareMatrix.tsx:22-24` `value>0?"신규":"동일"`) | `▲ 신규`(`delta_cell_text` 49–56 동일) |
| present, p95=0 | present, v=0 | `동일`(Neutral) | `동일` |
| present, b>0 | present, v | 정상 Δ(글리프+%) | 정상 Δ |

> 표의 "화면" 글리프는 *의미*(신규/동일/Δ·polarity) 대조용이다. 글리프-텍스트 사이 공백은 화면(`▲신규`, `CompareMatrix.tsx:32` `▲{text}`)과 export(`▲ 신규`, `delta_cell_text` `▲ {base}`)가 다르지만 이는 **Summary에도 이미 있는 pre-existing 차이**(Summary export `▲ +50.0%` vs 화면 `▲+50.0%`)라 본 슬라이스 범위 밖 — export는 기존 Summary export 포맷을 그대로 따른다.

**핵심 — Summary와 다르다**: Summary의 `base`는 항상 number(`summaryValue`는 null 미반환), Steps의 `base`는 absent면 `null`이다. 그래서 absent-baseline은 Summary면 base=0→"신규"지만 Steps면 **블랭크**다(`compareReports.ts:72` `base === null` 가드). `unwrap_or(0.0)`로 absent를 0으로 접으면 화면(블랭크)↔export("▲ 신규")가 어긋나 ADR-0030 screen↔export parity가 깨진다(spec-plan-reviewer 적발). present-but-zero(스텝은 있고 p95=0)일 때만 "신규"/"동일"이고, 이는 화면과 동일하다(localhost sub-ms p95_ms=0은 이 칸 — absent와 구별됨).

### 4.2 Δ 열 인덱스 — 비-baseline run마다 무조건 전진 (off-by-one 가드)

Δ 값 셀은 §4 ③에 따라 **조건부 기록**(블랭크 가능)이지만, **각 비-baseline run의 Δ 열은 헤더(행 0)에서 고정 예약**되므로 열 카운터는 기록 여부와 **무관하게** 비-baseline run마다 1씩 전진해야 한다. Summary(304–318)는 Δ를 무조건 기록해 `dcol += 1`이 항상 도달하지만, Steps는 블랭크가 생기므로 `dcol += 1`을 `if let Some` *밖*(비-baseline run 루프 본문)에 둔다 — 또는 `dcol = delta_start + (현재까지 비-baseline run 수)`로 run 인덱스에서 직접 도출. **결합하면**(앞선 비-baseline run이 스텝을 빠뜨릴 때) 뒤 run들의 Δ 열이 한 칸씩 밀려 헤더와 어긋난다. N≥3(비-baseline ≥2)에서만 발현하고 `resolve_comparison`이 run ≤5를 허용하므로 실경로 도달 가능 → §6의 3-run 정렬 테스트로 잠근다.

## 5. 불변식

- **기존 Steps 값 셀 byte-identical**: 값 열(col 1..=N) 기록 코드는 무변경, Δ 열만 뒤에 *추가*. 같은 입력에 기존 값 셀 바이트 동일.
- **N=1이면 Δ 열 0개**: Δ 헤더/셀 루프는 `i != baseline_idx`만 쓰므로 run 1개면 0열(Summary 289–295와 동형). 단 `comparison_to_xlsx`는 `resolve_comparison`이 run ≥2를 강제하므로 실경로상 N≥2.
- **`fmt_bad`/`fmt_good` 재생성 없음**: 이미 함수 진입부(267–272)에 1회 생성. Steps 루프는 그 참조만 사용(Summary와 공유).

## 6. 테스트

- **정상 Δ(roundtrip 확장)**: `comparison_xlsx_roundtrips`(716)는 step "s"(A p95=100, B p95=150) 2-run을 이미 만든다. Steps 시트 단언 추가 — `Steps` row 1 = step "s": col 1 = `Float(100.0)`, col 2 = `Float(150.0)`, col 3(Δ start=`1+N`=3) = `String("▲ +50.0%")`.
- **신규 테스트 `comparison_xlsx_steps_delta` — presence·alignment(§4.1·§4.2 잠금)**. 3-run(A=base, B, C) fixture로 네 케이스를 한 시트에서 검증:
  - **absent-baseline → 블랭크**: A에 없고 C에 있는 스텝 → 그 행의 Δ%C 셀이 **블랭크**(`matches!(get_value, None | Some(Data::Empty))` — 701 패턴). `unwrap_or(0.0)`였다면 `▲ 신규`가 나오므로 이 단언이 회귀 가드.
  - **present-but-zero → 신규**: A에 있고 p95=0인 스텝, C는 p95>0 → Δ%C = `String("▲ 신규")`(absent와 *구별*됨을 같은 테스트가 대조).
  - **candidate-absent → 블랭크**: A·B에 있고 C에 없는 스텝 → 그 행 C 값 셀·Δ%C 셀 둘 다 블랭크.
  - **열 정렬(Finding 2)**: A·C에 있고 **B에는 없는** 스텝 → Δ%B(col `delta_start`)는 블랭크, Δ%C(col `delta_start+1`)는 정상 Δ 문자열이 **올바른 열**에 위치(B의 블랭크가 C의 Δ를 한 칸 당기지 않음). `get_value((row, delta_start))` 블랭크 **그리고** `get_value((row, delta_start+1))` = 기대 Δ 문자열 둘 다 단언해야 정렬 회귀를 잡는다(2-run으론 불가).
- calamine `worksheet_range("Steps")` + `get_value((row,col))`(727 패턴). calamine은 값 리더라 **fill/font 색 단언 불가** — 문자열·블랭크만 단언, polarity→Format 매핑은 `delta_cell_text_mirrors_deltachip`(748)+코드리뷰가 보증(Summary와 동일 정책). presence 로직(`compareReports.ts` 미러)은 공유 fixture가 없으므로 위 테스트 + 코드리뷰(화면 step 행과 1:1 대조)가 parity 보증.
- **헬퍼 parity는 기존 테스트가 이미 락**: `golden_summary_deltas_match`(577)·`delta_cell_text_mirrors_deltachip`(748)·`format_pct_mirrors_ui`(740)가 `delta`/`delta_cell_text`/`format_pct`를 검증. Steps는 같은 헬퍼의 *새 호출처*일 뿐이라 골든 fixture 변경·재생성 불필요.
- **finish-stage 1회 헤드리스 sanity(상시 테스트 아님)**: 비교 XLSX 직렬화 후 `unzip -p x.xlsx xl/styles.xml`로 `patternType="solid"`+`<fgColor rgb="FFFFC7CE"/>`(악화)·`<fgColor rgb="FFC6EFCE"/>`(개선)·font `FF9C0006`/`FF006100`, `sharedStrings.xml`의 `▲`/`▼` 글리프 확인(Summary Δ 슬라이스 finish 절차 재사용). Summary가 이미 같은 Format을 쓰므로 styles.xml은 변동 없을 수 있으나, Steps Δ 셀이 그 Format을 실제로 참조하는지 1회 확인.

## 7. 함정 / 리뷰 주의 (controller/CLAUDE.md 기존 노트 적용)

- **Steps Δ parity 계약 = `compareReports.ts:62-75`(Summary 아님)**: absent-baseline은 화면이 **블랭크**라 export도 블랭크 — `unwrap_or(0.0)`로 "신규"를 내면 parity 깨짐(§4.1). present-but-zero일 때만 "신규"/"동일".
- **`dcol`은 비-baseline run마다 무조건 전진**(기록 여부와 분리) — §4.2. 조건부 기록과 결합하면 N≥3에서 열 밀림.
- `set_background_color`만으로 solid fill(0.79.4 기본) — `set_pattern(Solid)` 불요(이미 Summary가 그러함).
- calamine fill/font 색 미노출 → roundtrip은 Δ *문자열*·블랭크만 단언.
- Δ 열 시작 인덱스 = `1 + reports.len()` (값 열 N개 뒤). off-by-one 주의 — Summary `delta_start`(288)와 동일 산식.
- `p95_ms`는 `u64`(report.rs:104) → `as f64` 캐스트(현 339·Summary 동형).
- `comparison_to_xlsx`는 export 전용·`ReportJson` 순수 함수 — 새 집계/fetch/SQL 0.

## 8. ADR 영향

없음. ADR-0030(Run 비교 + 리포트 export) 범위 내 additive 표현 변경. Summary Δ 슬라이스와 동일 판정.

## 9. 미해결 / 연기 (백로그 → roadmap §B)

사용자 결정(2026-06-26): "p95-only 채택, 나머지 백로그".
- **per-step p50/p99 Δ**(latency depth) — Steps 값 섹션을 p50/p95/p99로 확장(현 단일 p95 열 대체 → byte-identical 깨짐, ~3× 폭). 별도 슬라이스.
- **per-step error-rate Δ**(regression lens) — step별 errors/count Δ(현재 Steps 시트에 error-rate 미노출). 별도 슬라이스.
- 위 둘은 Steps 시트 구조를 step×run 행렬에서 step×(run×metric)로 바꾸는 더 큰 재설계라 독립 scoping 필요.

## 10. 산출물

- 프로덕션: `export.rs::comparison_to_xlsx` Steps 시트 루프에 Δ 열(헤더 + 셀) 추가.
- 테스트: Steps Δ 셀 단언 — 정상 Δ(roundtrip 확장) + 신규 `comparison_xlsx_steps_delta`(absent-baseline 블랭크·present-but-zero 신규·candidate-absent 블랭크·3-run 열정렬).
- 단일 green 커밋(헬퍼 재사용이라 신규 헬퍼 없음 → TDD RED→GREEN을 한 커밋으로 fold, controller/CLAUDE.md "RED-only 커밋 불가" 게이트 정합).

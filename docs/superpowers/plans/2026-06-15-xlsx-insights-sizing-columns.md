# XLSX Insights 사이징 권장 3열 추가 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 단일-run XLSX export의 `Insights` 시트에 사이징 권장 3열(`recommended`/`cause`/`recommended_workers`)을 추가해, 화면(`InsightPanel`)에만 뜨던 `load_gen_saturated` 처방을 XLSX 다운로드에도 1:1로 싣는다.

**Architecture:** 순수 가산·읽기경로·backend-only. 추가할 데이터는 이미 `ReportJson.insights[].{recommended,cause,recommended_workers}`에 존재(A9 사이징 권장 + ADR-0038 worker_count 추천이 계산·직렬화 완료). 이 슬라이스는 그 필드를 `crates/controller/src/export.rs`의 `report_to_xlsx` Insights 시트 writer에서 **셀로 쓰기만** 한다. 새 계산·새 데이터 흐름 0.

**Tech Stack:** Rust, `rust_xlsxwriter`(쓰기), `calamine`(테스트 라운드트립 읽기). 단일 파일 `crates/controller/src/export.rs`.

**Spec:** `docs/superpowers/specs/2026-06-15-xlsx-insights-sizing-columns-design.md`

---

## File Structure

단일 파일만 수정한다. 새 파일 없음.

| 파일 | 책임 | 변경 |
|---|---|---|
| `crates/controller/src/export.rs` | 리포트 → CSV/XLSX 직렬화. `report_to_xlsx`의 Insights 시트 블록(`:318-364`)이 인사이트를 행으로 쓴다. | 헤더 배열에 3개 append + 행 writer에 conditional 3줄 + 인라인 테스트 `xlsx_has_insights_sheet`(`:494`) 확장 |

**무변경(명시)**: 엔진·워커·proto·migration·`Insight` 구조체(`insights.rs`)·`derive_insights`·`report.rs`·UI·Zod(`ui/src/api/schemas.ts`)·ko.ts·CSV export(`report_to_csv`/`comparison_to_csv`)·비교 XLSX(`comparison_to_xlsx`)·사이징 수식(p50 parity). append-only.

**TDD 가드 메모**: `export.rs`는 인라인 `#[cfg(test)] mod tests`를 이미 디스크에 갖고 있어 `.claude/hooks/tdd-guard.sh`가 자동 통과(루트 CLAUDE.md "인라인 test 자동통과"). keepalive 불필요. 테스트와 프로덕션 코드가 같은 파일이라 한 파일만 편집한다.

**커밋 경계 메모**: 루트 CLAUDE.md "RED 테스트만 커밋 = test 게이트 실패 / 미사용 코드만 = clippy dead_code" — 그래서 **테스트 확장 + 프로덕션 writer를 하나의 green 커밋으로 fold**한다(로컬에선 RED→GREEN 확인하되 커밋 1회). Task 1이 그 단일 커밋.

---

## Task 1: XLSX Insights 시트에 사이징 3열 추가 (test+impl 단일 커밋)

**Files:**
- Modify: `crates/controller/src/export.rs` — 헤더 배열 `:322-332`, 행 writer `:338-363`, 인라인 테스트 `:494-521`

- [ ] **Step 1: 테스트 확장 (RED) — `xlsx_has_insights_sheet`에 사이징 행 + 단언 추가**

`crates/controller/src/export.rs`의 `xlsx_has_insights_sheet`(현 `:494-521`)를 아래로 **교체**한다. 변경점: ① `r.insights` 벡터에 `load_gen_saturated` 행을 **추가**(세 사이징 필드를 모두 Some으로 — export writer를 한 행에서 모두 운동시키는 계약 테스트; 실제 인사이트의 slots⊕capacity 배타성은 `insights.rs` 불변식이라 export 관심사 아님), ② 새 헤더 3셀 + 사이징 행 3셀 + 빈-셀 불변식 단언 추가.

```rust
    #[test]
    fn xlsx_has_insights_sheet() {
        use calamine::{Data, Reader, Xlsx, open_workbook_from_rs};
        use std::io::Cursor;
        let mut r = report_with_steps(vec![step("a", 10, 50)]);
        r.insights = vec![
            crate::insights::Insight {
                kind: "slowest_step".into(),
                severity: "info".into(),
                step_id: Some("a".into()),
                metric: Some("p95_ms".into()),
                value: Some(50.0),
                pct: None,
                count: None,
                status_class: None,
                window_seconds: None,
                recommended: None,
                cause: None,
                recommended_workers: None,
            },
            // 사이징 3필드를 모두 채운 합성 행: 세 새 열 writer를 모두 운동시킨다.
            // (실제 인사이트는 recommended[slots] ⊕ recommended_workers[capacity]로 배타적이지만,
            //  그 배타성은 insights.rs의 불변식이지 export writer의 관심사가 아니다.)
            crate::insights::Insight {
                kind: "load_gen_saturated".into(),
                severity: "warning".into(),
                step_id: None,
                metric: None,
                value: Some(1200.0),
                pct: None,
                count: Some(8181),
                status_class: None,
                window_seconds: None,
                recommended: Some(106.0),
                cause: Some("slots".into()),
                recommended_workers: Some(6.0),
            },
        ];
        let bytes = report_to_xlsx(&r);
        let mut wb: Xlsx<Cursor<Vec<u8>>> = open_workbook_from_rs(Cursor::new(bytes)).unwrap();
        let ws = wb.worksheet_range("Insights").expect("Insights sheet");
        // 기존 헤더/데이터 단언 (유지)
        assert_eq!(ws.get_value((0, 0)), Some(&Data::String("kind".into())));
        assert_eq!(
            ws.get_value((1, 0)),
            Some(&Data::String("slowest_step".into()))
        );
        assert_eq!(ws.get_value((1, 4)), Some(&Data::Float(50.0)));
        // 새 헤더 3열 (col 9/10/11 = J/K/L)
        assert_eq!(ws.get_value((0, 9)), Some(&Data::String("recommended".into())));
        assert_eq!(ws.get_value((0, 10)), Some(&Data::String("cause".into())));
        assert_eq!(
            ws.get_value((0, 11)),
            Some(&Data::String("recommended_workers".into()))
        );
        // 사이징 행(벡터 인덱스 1 → 시트 row 2)의 새 3열 값
        assert_eq!(ws.get_value((2, 9)), Some(&Data::Float(106.0)));
        assert_eq!(ws.get_value((2, 10)), Some(&Data::String("slots".into())));
        assert_eq!(ws.get_value((2, 11)), Some(&Data::Float(6.0)));
        // 빈-셀 불변식: slowest_step 행(row 1)은 사이징 필드 None → 미기록.
        // calamine은 used-range 안의 미기록 셀을 None 또는 Data::Empty로 돌려준다(둘 다 허용).
        assert!(matches!(ws.get_value((1, 9)), None | Some(Data::Empty)));
        assert!(matches!(ws.get_value((1, 10)), None | Some(Data::Empty)));
        assert!(matches!(ws.get_value((1, 11)), None | Some(Data::Empty)));
    }
```

- [ ] **Step 2: 테스트가 실패하는지 확인 (RED)**

Run: `cargo test -p handicap-controller --lib export::tests::xlsx_has_insights_sheet`
Expected: **FAIL** — 새 헤더 단언 `assert_eq!(ws.get_value((0, 9)), Some(&Data::String("recommended".into())))`에서 패닉(아직 9열을 안 써서 `(0,9)`가 `None`/`Empty`). (프로덕션 writer가 아직 9열 미기록.)

- [ ] **Step 3: 헤더 3개 추가 (프로덕션)**

`report_to_xlsx`의 Insights 헤더 배열(현 `:322-332`)을 아래로 교체 — 3개 append(9 → 12). `recommended`/`cause`/`recommended_workers`는 `Insight` 구조체 필드 선언 순서(insights.rs 29/32/36) → col 9/10/11.

```rust
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
            "recommended",
            "cause",
            "recommended_workers",
        ]
        .iter()
        .enumerate()
        {
            ws.write_string(0, c as u16, *h).expect("w");
        }
```

- [ ] **Step 4: 행 writer 3줄 추가 (프로덕션)**

행 loop(현 `:338-363`)의 마지막 `if let Some(v) = ins.window_seconds { … }` 블록 **직후**, 닫는 `}`(행 loop 끝) **앞**에 conditional 3줄을 추가한다. 기존 idiom 그대로(`recommended`/`recommended_workers`는 `f64`→`write_number`, `cause`는 `String`→`write_string`에 `&ins.cause`로 차용).

```rust
            if let Some(v) = ins.window_seconds {
                ws.write_number(r, 8, v as f64).expect("w");
            }
            if let Some(v) = ins.recommended {
                ws.write_number(r, 9, v).expect("w");
            }
            if let Some(v) = &ins.cause {
                ws.write_string(r, 10, v).expect("w");
            }
            if let Some(v) = ins.recommended_workers {
                ws.write_number(r, 11, v).expect("w");
            }
```

(위 블록은 기존 `window_seconds` 줄을 앵커로 보여준 것 — `window_seconds` 줄은 이미 있으니 그 아래 3개 `if let`만 새로 넣으면 된다.)

- [ ] **Step 5: 테스트 통과 확인 (GREEN) + clippy**

Run: `cargo test -p handicap-controller --lib export::tests::xlsx_has_insights_sheet`
Expected: **PASS**.

Run: `cargo clippy -p handicap-controller --all-targets -- -D warnings`
Expected: 경고 0(pre-commit clippy 게이트 선제 통과 — 새 `if let`은 dead-code 아님, 단순 가산).

- [ ] **Step 6: 커밋 (test+impl 단일 green 커밋)**

먼저 cold-build 워커 race 예방 차 워커 워밍(루트 CLAUDE.md): `cargo build -p handicap-worker`.
그다음 명시 경로로만 add(절대 `-A` 금지) + 파이프 없는 단일 커밋(파이프는 git exit code 마스킹). subagent라면 commit은 `run_in_background:false` + timeout 600000ms 단일 foreground 호출(폴링 금지).

```bash
cargo build -p handicap-worker
git add crates/controller/src/export.rs
git commit -m "feat(export): XLSX Insights 시트에 사이징 권장 3열(recommended/cause/recommended_workers)

A9 load_gen_saturated 인사이트가 계산해 화면엔 뜨던 사이징 처방을
단일-run XLSX export에도 1:1로 싣는다. 순수 가산(export.rs 한 파일),
Insight 구조체·UI/Zod·CSV·비교 XLSX 무변경, p50 parity 유지.

Spec: docs/superpowers/specs/2026-06-15-xlsx-insights-sizing-columns-design.md"
```

(pre-commit이 cargo-영향 커밋이라 전체 워크스페이스 게이트를 수 분 돌린다 — 정상. 완료 후 `git log -1`로 landed 확인.)

- [ ] **Step 7: 커밋 landed 확인**

Run: `git log -1 --stat`
Expected: 커밋이 보이고 `crates/controller/src/export.rs` 1파일 변경.

---

## Task 2: 문서 갱신 (roadmap §A9 완료줄 + §B 연기 누적 + build-log)

**Files:**
- Modify: `docs/roadmap.md` (§A9 현재상태/완료줄 + §B 연기 항목)
- Modify: `docs/build-log.md` (완료 한 단락 append)

> 이 태스크는 코드 머지 후(또는 머지 직전) 수행. docs-only라 pre-commit fast-path(수초).

- [ ] **Step 1: build-log에 완료 단락 append**

`docs/build-log.md` 끝에 한 단락 추가(아래는 초안 — 실제 커밋 SHA·게이트 수치로 채울 것):

```markdown
## XLSX Insights 사이징 3열 (A9 정밀화 스코프 A, 2026-06-15)

`load_gen_saturated` 인사이트의 사이징 처방(`recommended`/`cause`/`recommended_workers`)을
단일-run XLSX `Insights` 시트에 3열로 노출 — 화면(`InsightPanel`)엔 이미 뜨지만 export엔
빠져 있던 완성도 갭을 메움. 순수 가산·backend-only(`crates/controller/src/export.rs` 한 파일):
헤더 9→12, 행 writer conditional 3줄, calamine 라운드트립 테스트 확장. 데이터는 이미
`ReportJson.insights[]`에 존재(A9 사이징 권장 + ADR-0038)해 새 계산 0. 엔진·워커·proto·
migration·`Insight` 구조체·UI/Zod·ko.ts·CSV·비교 XLSX·사이징 수식(p50 parity) 전부 무변경.
spec/plan `2026-06-15-xlsx-insights-sizing-columns*`. ADR 불필요(ADR-0028/0030 범위 내 additive).
연기 → roadmap §A9: mean 프록시 전면 업그레이드(C)·per-window dropped·원인 자동 귀속·CSV/비교 인사이트.
```

- [ ] **Step 2: roadmap §A9에 완료 한 줄 + 연기 항목 누적**

`docs/roadmap.md` §A9(라인 106 부근 제목줄 + 본문) 및 §현재 상태(라인 17 부근)에:
- §A9 제목줄에 "XLSX Insights 사이징 3열" 완료 추가.
- §A9 본문에 완료 불릿 1줄 추가(build-log 요지 한 줄 + spec/plan 파일명).
- **연기 항목 갱신**: A9 사이징 권장 불릿(라인 108)의 "XLSX recommended/cause 열" 연기 항목을 ✅ 완료 표기로 바꾸고, 새 연기로 **mean 프록시 전면 일관 업그레이드(C)**를 명시 추가(사용자 2026-06-15 "쓸만한 아이디어, 후속 기록"): "post-run `insights.rs` `required` + create-time `sizing.ts` `recommendSlots`를 둘 다 mean으로(parity 보존) + `ReportSummary.mean_ms` 노출 — backend+UI 크로스커팅, 별도 슬라이스". per-window dropped·원인 자동 귀속은 기존 연기 유지.

(정확한 줄 편집은 구현 세션에서 그 시점의 roadmap 상태를 읽어 적용 — 위는 무엇을 바꿀지의 명세.)

- [ ] **Step 3: docs 커밋**

```bash
git add docs/roadmap.md docs/build-log.md
git commit -m "docs: XLSX Insights 사이징 3열 완료 기록 + mean 프록시 업그레이드(C) 연기 누적"
git log -1 --stat
```

---

## 머지 / 마무리 (구현 세션)

Task 1·2 커밋 후 `/finish-slice` 또는 루트 CLAUDE.md "git 토폴로지" 절차로 master ff-merge:
- 라이브 검증 **불요**(spec §5): run-생성·report-파싱·엔진 경로 무변경, calamine 라운드트립 단위 테스트가 직렬화 계약. *선택* 스팟체크: 포화 run 1개 `report.xlsx`의 Insights 시트 J/K/L 열 확인.
- 워크트리 안에서 마무리: `git -C /Users/sgj/develop/handicap merge --ff-only worktree-a9-insight-refinement`(메인 클린·ff 가능 사전확인) → `ExitWorktree(remove, discard_changes:true)`.
- 머지 전 `.playwright-mcp`/루트 png 잔류 없음 확인(이 슬라이스는 Playwright 미사용이라 해당 없음).

---

## Self-Review (작성자 체크)

- **Spec coverage**: §3.1 헤더 → Task1 Step3 ✓ / §3.2 행 writer → Task1 Step4 ✓ / §3.3 테스트 → Task1 Step1 ✓ / §4 무변경 → File Structure 표·커밋 메시지에 명시 ✓ / §5 게이트·라이브불요 → Task1 Step5·마무리절 ✓ / §6 연기 → Task2 Step2 ✓ / §7 단일 green 커밋 → 커밋 경계 메모·Task1 Step6 ✓.
- **Placeholder scan**: 모든 코드 블록은 실제 코드(헤더 배열 전문·writer 3줄·테스트 전문). docs 초안은 "실제 SHA/수치로 채울 것"으로 명시(plan 자체의 placeholder 아님 — 구현 시점 산출물).
- **Type consistency**: `recommended: Option<f64>`→`write_number(r,9,v)`, `cause: Option<String>`→`write_string(r,10,v)`(`&ins.cause`), `recommended_workers: Option<f64>`→`write_number(r,11,v)`. 테스트 단언 타입(`Data::Float`/`Data::String`)과 일치. 행 인덱스: 벡터[1]→시트 row 2 일관(헤더 row 0, 인사이트 i→row i+1).

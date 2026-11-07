# 터미널 운영 모니터 원거리 가독성 (tui-readability) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `handicap-tui` 모니터 화면이 GUI 전시 화면처럼 멀리서 읽히게 — 칸 높이를 채우는 여러 줄 막대 + 기준선, 블록 문자 큰 응답 시간(L/M/S 단계), 굵은 선/반 칸 블록 테두리(`b` 키·설정 파일 기억), 선택 칸 흰 바탕 제목, 느림·실패 바탕 물들이기.

**Architecture:** `crates/tui/src/view/`에 순수 함수 모듈 셋(`graph.rs` 막대·기준선 기하, `bigfont.rs` 큰 글꼴, `tier.rs` 단계 결정)을 더하고 `monitor.rs`의 칸 그리기를 S(1a 배치 기반)·L/M(새 배치) 두 갈래로 나눈다. 뷰 모델(`model.rs`)은 미리 계산한 한 줄 글리프 대신 막대 판정·응답 시간과 칸 설정값을 넘긴다. 테두리 취향은 새 `prefs.rs`가 `$XDG_CONFIG_HOME/handicap/tui.json`에 읽고 쓴다. 컨트롤러·GUI는 0-diff.

**Tech Stack:** Rust(edition 2024, tui crate `rust-version = "1.88"`), ratatui 0.30(crossterm), serde/serde_json, tempfile.

**Spec:** `docs/superpowers/specs/2026-11-08-tui-readability-design.md` (합의 목업 `docs/superpowers/specs/2026-11-08-tui-readability-mockups/00-final-agreed.png`). 상위 설계 `docs/superpowers/specs/2026-11-07-tui-monitor-design.md` §5.1을 개정한다.

REVIEW-GATE: APPROVED

## Global Constraints

- 변경 범위는 `crates/tui/**`와 문서뿐 — `crates/controller`·`ui/`·proto·마이그레이션 0-diff.
- tui crate `rust-version = "1.88"`: `u64::is_multiple_of` 등 1.88에 없는 API 금지(기존 `judge.rs` 주석 참조). clippy `-D warnings`.
- 사용자 노출 한국어 문구는 `crates/tui/src/text.rs` 한 곳에.
- 크기 단계는 **설정(`timeout_seconds`·`display_items` 설정 여부·`show_latency_stats`)과 칸 크기로만** 정한다 — 점검 값·상태를 입력으로 받지 않는다(spec §2 반목표 1, §4.1).
- 1a 규칙 유지: 칸 최소 24×6·`TooSmall`, 상태 판정(`judge.rs`), 시각 줄(`axis.rs`), 문구 줄임(통째 단위), 막대 1개 = 1글자 칸.
- 색 상수는 1a `monitor.rs`/`model.rs`의 것을 재사용(`C_TEXT #f2f5f8`, `C_FAIL #ef4444`, `COLOR_GRAY_BAR #475569` 등).
- 커밋 메시지 끝 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`(구현 모델 이름 그대로). 메시지는 `-F <파일>`.

## Review Focus

1. **선택 칸 + 아주 긴 제목 + 좁은 L/M 칸**: `▶ 제목` 흰 바탕이 상태 문구를 덮거나 칸 밖으로 넘치면 안 된다 — 제목만 `…`로 줄고 상태 문구는 통째 남는다. → Task 4 테스트 `lm_long_title_selected_keeps_state_label`.
2. **기준선이 그래프 최대 이상 / 아주 낮음 / 내림으로 같은 줄**: 최대 이상은 맨 윗줄, 0에 가까운 값은 맨 아랫줄, 같은 줄 둘은 높은 쪽 색·숫자 하나. → Task 1 `threshold_rows_clamp_and_dedupe`.
3. **`bar_count`가 결과 수·막대 영역보다 작거나 큼**: 막대는 오른쪽 끝부터, 시각 줄도 같은 범위. → Task 2 `s_bars_right_aligned_with_axis`.
4. **터미널 크기 변경으로 단계가 S↔M↔L로 바뀜**: 같은 화면 객체로 크기만 바꿔 그려도 깨지지 않는다(겹침·넘침 없음). → Task 4 `lm_resize_sweep_no_overflow`.
5. **설정 파일이 디렉터리이거나 이상한 값(`{"border":"weird"}`)**: 기본값으로 시작, 저장은 실패해도 세션 유지. → Task 6 `prefs_bad_inputs_fall_back`.

---

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `crates/tui/src/view/model.rs` (수정) | `Bar`를 판정 종류+응답 시간으로, `PanelView`에 설정값 추가, S 줄 배정 `panel_rows_s` | 1, 2 |
| `crates/tui/src/view/graph.rs` (새) | 막대 열 글리프(여러 줄·무늬), 기준선 줄·숫자 열 기하, 그래프 그리기 | 1, 2 |
| `crates/tui/src/view/bigfont.rs` (새) | 3×5 점 글꼴, 폭 계산, L/M 줄 문자열 | 3 |
| `crates/tui/src/view/tier.rs` (새) | 기준 폭·예약 줄 수·칸 단계·보드 단계 | 3 |
| `crates/tui/src/view/monitor.rs` (수정) | 칸 그리기 S/LM 분기, 테두리 2모양, 선택 표시, 바탕 물들이기, `render_with_keys -> bool` | 2, 4, 5, 6 |
| `crates/tui/src/prefs.rs` (새) | `BorderStyle`·`Prefs`, 설정 파일 경로·읽기·쓰기 | 6 |
| `crates/tui/src/app.rs` (수정) | `b`/`ㅠ` 키, `Action::ToggleBorder`, 칸이 그려졌을 때만 적용·저장 | 6 |
| `crates/tui/src/text.rs` (수정) | 키 조각·도움말 줄 | 6 |
| `crates/tui/tests/view_test.rs`, `app_test.rs`, 새 `prefs_test.rs` | 테스트 | 1–6 |
| `docs/dev/tui-monitor.md`, `docs/adr/0055-tui-monitor.md`, `docs/superpowers/specs/2026-11-07-tui-monitor-design.md` | 매뉴얼·ADR 덧붙임·상위 spec 개정 표시 | 7 |

테스트 명령(전 task 공통): `cargo test -p handicap-tui` · `cargo clippy -p handicap-tui --all-targets -- -D warnings` · `cargo fmt -p handicap-tui --check`. 구현 subagent는 커밋·검증을 **단일 foreground 호출(600000ms)**로(루트 CLAUDE.md). `tdd-guard`: src 편집 전에 그 task의 실패 테스트가 먼저 있어야 한다(각 task Step 1).

---

### Task 1: 뷰 모델 — 막대 판정·응답 시간 + 그래프 순수 함수 (US2 기반)

spec §5.1·§5.3·§5.4 기하, §5.6.

**Files:**
- Modify: `crates/tui/src/view/model.rs` (`Bar`, `bar_of`, `PanelView`, `panel_view`)
- Create: `crates/tui/src/view/graph.rs`, `crates/tui/src/view/mod.rs`에 `pub mod graph;`
- Modify: `crates/tui/src/view/monitor.rs` — 막대 줄은 당분간 `graph::column(.., rows=1, ..)[0]`로 한 줄 그리기(임시 — Task 2가 교체, 차이는 Step 3 참고)
- Test: `crates/tui/tests/view_test.rs`

**Interfaces:**
- Produces (model.rs):
  ```rust
  #[derive(Debug, Clone, Copy, PartialEq, Eq)]
  pub enum BarKind { Empty, Ok { latency_ms: u64 }, Fail, ConfigError, Upstream, Skipped }
  pub struct Bar { pub kind: BarKind, pub color: Color, pub at_ms: Option<i64> } // glyph 필드 삭제
  #[derive(Debug, Clone, PartialEq, Eq)]
  pub struct ThresholdView { pub ms: u32, pub color: Color }
  // PanelView 추가 필드:
  pub graph_max_ms: u32, pub thresholds: Vec<ThresholdView>, pub timeout_seconds: u32,
  pub n_display_items: usize, pub show_stats: bool, // n_display_items = min(display_items.len(), 2)
  ```
  `color`는 1a와 같다(Ok = `bar_color`, Fail = `#ef4444`, ConfigError/Upstream/Skipped = `#475569`, Empty = `Color::Reset`). `n_display_items` = `p.display_items.len().min(2)`(설정 기준), `show_stats` = `board.config.show_latency_stats`.
- Produces (graph.rs):
  ```rust
  /// 막대 한 개의 열 — index 0 = 맨 아래 줄. None = 빈 글자 칸.
  pub fn column(bar: &Bar, rows: u16, graph_max_ms: u32, x: usize) -> Vec<Option<char>>;
  /// (아래에서부터 줄 번호, 기준선) — 같은 줄이면 높은 기준선만, 아래→위 순.
  pub fn threshold_rows(th: &[ThresholdView], graph_max_ms: u32, rows: u16) -> Vec<(u16, ThresholdView)>;
  /// 숫자 열 폭(0 = 열 없음). draw=false거나 기준선 없음 → 0. 열을 두면 막대 폭 < MIN_BAR_W(12)일 때 0.
  pub fn label_width(th: &[ThresholdView], inner_w: u16, draw: bool) -> u16;
  pub const MIN_BAR_W: u16 = 12;
  pub const MIN_THRESHOLD_ROWS: u16 = 3;
  ```
  `column` 규칙(`max` = `graph_max_ms.max(1)` — 0 나눗셈 방지, 1a `model.rs`의 `.max(1)`과 같다): Ok → 높이 단계 `e = round(min(ms, max)/max × rows×8)`, 최소 1; 아래 `e/8`줄 `█`, 그 위 `e%8`이 0이 아니면 `▁▂▃▄▅▆▇`[e%8−1]. Fail/ConfigError → 전 줄, 줄 `r`에서 `(x + r) % 3 == 0`이면 `▒` 아니면 `█`(빗금 — 맨 위 표시 없음; 이 `%` 비교는 clippy `manual_is_multiple_of`에 걸리므로 `judge.rs`의 `with_commas`처럼 `#[allow(clippy::manual_is_multiple_of)]` + rust-version 1.88 주석). Upstream → `max(1, round(rows×8×0.12))`단계 Ok와 같은 글리프. Skipped → 맨 아래 줄 `·`만(나머지 None — 1a와 같은 글자, spec §5.3 "1a가 이미 쓰는 모호 폭 문자 안에서"). Empty → 전부 None. `threshold_rows`: `rows == 0`이면 빈 목록, 아니면 줄 = `min(floor(ms/max × rows), rows−1)`(내림 — 반올림 아님). 숫자 글자 = `judge::format_stat_num(ms)`(천 단위 쉼표), 열 폭 = `max(가장 넓은 숫자, 4)`.
  색 상수: `monitor.rs`의 `C_*`를 `pub(crate) const`로 바꿔 `graph.rs`가 `super::monitor::C_*`로 쓴다(중복 정의 금지).
- **테스트 픽스처 기본값(이후 모든 task가 기대는 값 — 여기서 고정)**: `view_test.rs`의 `view()`는 새 필드를 `timeout_seconds: 5, graph_max_ms: 2000, thresholds: vec![], show_stats: true, n_display_items: 0`로 채운다(1a `PanelConfig::default()`의 `graph_max_ms` 2000과 같고, `timeout_seconds` 5는 1a 픽스처 `check_budget_seconds` 5와 같다).

- [ ] **Step 1: 실패 테스트 작성** (`view_test.rs`; 기존 `build_panels_bars_glyphs_and_colors`는 아래 첫 테스트로 대체, `view()`·`Bar {..}` 픽스처는 새 필드로 갱신)

```rust
#[test]
fn build_panels_bars_kinds_and_colors() {
    // 1a 픽스처 그대로(bar_count 10, graph_max 800, 기준선 500 #f59e0b, ok 100·ok 700·fail·config_error)
    // bars[0].kind == BarKind::Empty, bars[6].kind == BarKind::Ok{latency_ms:100} 초록,
    // bars[7] Ok{700} #f59e0b, bars[8] Fail #ef4444, bars[9] ConfigError #475569
    // 그리고 PanelView: graph_max_ms == 800, thresholds == [ThresholdView{ms:500, color: Rgb(f5,9e,0b)}],
    // timeout_seconds == p.timeout_seconds, n_display_items == 0, show_stats == true
}
#[test]
fn column_heights_scale_with_latency() {
    let b = |ms| Bar { kind: BarKind::Ok { latency_ms: ms }, color: Color::Green, at_ms: Some(0) };
    // rows 4 (=32단계), max 1000
    assert_eq!(column(&b(1), 4, 1000, 0), vec![Some('▁'), None, None, None]); // 최소 1단계
    assert_eq!(column(&b(500), 4, 1000, 0), vec![Some('█'), Some('█'), None, None]); // 16단계
    assert_eq!(column(&b(531), 4, 1000, 0), vec![Some('█'), Some('█'), Some('▁'), None]); // 17단계
    assert_eq!(column(&b(9999), 4, 1000, 0), vec![Some('█'); 4]); // 최대 초과 자름
}
#[test]
fn column_fail_full_height_stripes_no_mark() {
    // Fail rows 6: 모든 줄 Some('█') 또는 Some('▒'), x=0에서 r%3==0 줄이 '▒', 'x'/'✖' 없음
    // x=1이면 '▒' 줄이 한 칸 어긋난다(대각선)
}
#[test]
fn column_upstream_low_and_skipped_mark() { /* Upstream rows 5 → 높이 5단계(round(40×0.12)=5) → [Some('▅'),None..]; Skipped → [Some('·'),None..] */ }
#[test]
fn threshold_rows_clamp_and_dedupe() {
    let t = |ms, c| ThresholdView { ms, color: c };
    // rows 5, max 1000: 700→줄3, 1200(최대 이상)→줄4(맨 위), 1→줄0
    // 내림으로 같은 줄: rows 3, 700·750 → 줄2 하나, 그 기준선은 750(높은 쪽)
    // rows 0 → 빈 목록(패닉 없음)
}
#[test]
fn label_width_rules() {
    // [700] → 4 (max(3,4)); [700, 1200] → 5; draw=false → 0; inner_w 16에서 열 5면 막대 10 < 12 → 0
}
```

- [ ] **Step 2: 실패 확인** — `cargo test -p handicap-tui --test view_test` → 컴파일 오류(`BarKind`·`graph` 없음).
- [ ] **Step 3: 구현** — 위 Interfaces 그대로. `monitor.rs`의 `Row::Bars`는 `graph::column(b, 1, v.graph_max_ms, i)[0].unwrap_or(' ')`로 한 줄 그리기(Task 2가 교체 — 이 사이 모양은 1a와 조금 다르다: 실패 막대 일부 `▒`, 설정 오류 무늬, 확인 못 함 `▁`. 화면 단언이 이 차이로 깨지면 새 모양으로 갱신). `render_monitor_contains` 등 `Bar {glyph}` 쓰던 기존 테스트 픽스처는 `kind`로 바꾼다(단언 의미 유지).
- [ ] **Step 4: 통과 확인** — `cargo test -p handicap-tui` 전체 PASS + clippy·fmt.
- [ ] **Step 5: 커밋** — `git add crates/tui` → `git commit -F <msg>` (`refactor(tui): 막대 뷰 모델을 판정·응답 시간으로 + 그래프 순수 함수`).

---

### Task 2: S 단계 — 여러 줄 막대·기준선·숫자 열·오른쪽 정렬 (US2)

spec §4.3, §5.2, §5.4(그리기 조건·점선·숫자 열·`(ms)`), §5.5.

**Files:**
- Modify: `crates/tui/src/view/model.rs` (`panel_rows` → `panel_rows_s`), `crates/tui/src/view/graph.rs` (`render_graph`), `crates/tui/src/view/monitor.rs` (`render_panel` S 경로)
- Test: `crates/tui/tests/view_test.rs`

**Interfaces:**
- Consumes: Task 1 `column`·`threshold_rows`·`label_width`·`MIN_THRESHOLD_ROWS`.
- Produces:
  ```rust
  // model.rs — 1a panel_rows 대체. Row::Bars는 한 번 나오고 그 높이가 두 번째 값.
  pub fn panel_rows_s(inner_h: u16, has_reason_small: bool, has_consecutive: bool,
                      stats_row: bool, n_display: usize) -> (Vec<Row>, u16);
  // graph.rs — area = 막대 영역 전체(숫자 열 포함 폭, 높이 = 막대 줄 수).
  // 반환 = 막대들이 놓인 가로 범위(시각 줄이 같은 범위에 그린다).
  pub fn render_graph(f: &mut Frame, area: Rect, v: &PanelView, draw_thresholds: bool,
                      label_w: u16, bg: Option<Color>) -> Rect;
  ```
  `panel_rows_s`: 1a 우선순위(상태 > 막대 > 시각 > 연속 실패 > 사유 작은 줄 > 평균·최대 > 표시 값)로 줄을 고르되 막대는 1줄로 세고, 남는 줄 수를 막대 높이에 더한다. 호출부는 `stats_row = v.show_stats`, `n_display = 설정된 display_items 개수(min 2)`를 넘긴다 — **설정 기준**이라 값이 없는 상태(통계 없음·확인 중의 표시 값)엔 그 줄이 빈 줄로 자리를 지킨다(spec §4.3 끝 두 문장). (Task 1의 `PanelView.n_display_items`가 그 개수. Task 3·4의 "display_items 설정 여부"는 `n_display_items > 0`.)
  S 경로: `draw_thresholds` = 최악 경우 막대 줄 수(`panel_rows_s(inner_h, true, true, v.show_stats, v.n_display_items).1`) ≥ `MIN_THRESHOLD_ROWS`. 막대 폭 `W = inner_w − (label_w + 1 if label_w>0)`, 보이는 막대 = 최신 `min(len, W)`개를 `W` 영역 **오른쪽 끝**에. 점선 `╌`는 기준선 줄에서 `W` 전체 중 막대 글리프가 없는 글자 칸에만, 색 = 그 기준선. 숫자는 굵게, 열 안 오른쪽 정렬. 시각 줄: `axis_line`을 보이는 막대 슬롯에 대해 만들고 반환 범위 x에 그리며, `label_w>0`이면 시각 줄의 숫자 열 아래에 `(ms)`(색 `C_AXIS`) 오른쪽 정렬.

- [ ] **Step 1: 실패 테스트 작성**

```rust
#[test]
fn panel_rows_s_gives_leftover_to_bars() {
    // (이 task의 렌더 테스트는 아래 'S 크기 고정' 규칙을 따른다)
    // inner 10, 다른 줄 없음·stats → (vec![Status, Bars, Axis, Stats], 7)
    // inner 4, 연속 실패 → 1a와 같은 줄(Status, Consecutive, Bars, Axis) 막대 1줄
    // inner 6, stats_row=true, 표시 값 2 → Status·Bars·Axis·Stats·Display0·? 우선순위대로, 남는 줄 없음이면 막대 1
}
#[test]
fn s_bars_have_height_variation() {
    // 80×11 1칸(안쪽 78×7, S), graph_max 1000, 막대 ok 100·500·1000
    // 버퍼에서 막대 영역 열 3개의 '█' 개수가 서로 다르고 증가한다
}
#[test]
fn s_threshold_line_and_label_column() {
    // 기준선 700 #facc15, 1200 #f97316, graph_max 1500, 막대 영역 ≥3줄
    // 기준선 줄에 '╌'가 있고 그 색이 기준선 색, 막대가 있는 글자 칸에는 '╌' 없음
    // 숫자 열에 "1,200"·"700"이 굵게 그 색, 시각 줄 오른쪽에 "(ms)"
}
#[test]
fn s_no_thresholds_when_worst_case_rows_below_3() {
    // 경계 높이 고정: show_stats on·표시 값 없음이면 정상 막대 = 안쪽−3, 최악 = 안쪽−5.
    // 안쪽 7(TestBackend 80×11): 정상 막대 4줄(≥3)인데 최악 2줄(<3) → 정상 상태에서도 '╌'·숫자 열·(ms) 없음
    // (실제 줄 수로 판정하게 바꾸면 정상 화면에 숫자 열이 생겨 RED — 고의 회귀로 실증)
}
#[test]
fn s_state_change_keeps_label_column() {
    // 안쪽 8(TestBackend 80×12): 최악 3줄 → 정상·연속 실패 두 화면 모두 숫자 열 있음, 숫자 열 x와 최신 막대 x가 같다
    // 안쪽 7: 두 화면 모두 숫자 열 없음, 최신 막대 x가 같다
}
#[test]
fn s_bars_right_aligned_with_axis() {
    // bar_count 10, 결과 1개 → 막대가 막대 영역 오른쪽 끝 글자 칸, 시각 눈금(5 또는 8글자)이 그 칸에서 끝남
    //   (bar_count 1이면 보이는 슬롯 1칸이라 axis_marks가 눈금을 못 그린다 — axis.rs `w < ll`)
    // bar_count 300 > W → W개만, 최신이 오른쪽 끝
}
#[test]
fn s_stats_row_kept_blank_when_no_stats() {
    // S 크기, show_stats=true, 결과가 전부 확인 못 함(stats None·실패 줄 없음) → 평균·최대 자리 줄이 빈 줄로 남고 막대 높이는 정상 때와 같다
}
#[test]
fn s_display_rows_reserved_by_config() {
    // S 크기, display_items 2개 설정: 정상(값 있음)과 확인 중(값 없음) 두 화면의 막대 높이가 같다
}
```

**S 크기 고정**: 이 task의 렌더 테스트는 Task 4 뒤에도 **S로 남는 크기**를 쓴다 — 칸 안쪽 높이 ≤ 9(M은 통계 없이도 10줄 예약)면 어떤 설정에서도 S다. 예: `TestBackend` 80×11에 1칸 → 칸 80×9 → 안쪽 78×7. 각 테스트는 S임을 "위 테두리 줄에 제목이 있다"(S 배치 표지 — L·M은 제목이 머리 줄)로 함께 단언한다.

- [ ] **Step 2: 실패 확인** — `cargo test -p handicap-tui --test view_test` → `panel_rows_s` 없음 등 FAIL.
- [ ] **Step 3: 구현** — Interfaces 그대로. 기존 `panel_rows_priority`·`render_min_panel_keeps_axis`·`render_nine_panels_at_minimum`은 새 함수·오른쪽 정렬에 맞게 고치되 **1a 최소 크기(24×6)에서 상태·막대·시각이 보이는** 단언은 유지.
- [ ] **Step 4: 통과 확인** — 전체 PASS + clippy·fmt.
- [ ] **Step 5: 커밋** — `feat(tui): 칸 높이를 채우는 여러 줄 막대·기준선·숫자 열`.

---

### Task 3: 큰 글꼴과 단계 결정 (US1 기반, 순수 함수)

spec §4.1 단계 규칙, §4.2 큰 글꼴 문자 집합·허용 폭.

**Files:**
- Create: `crates/tui/src/view/bigfont.rs`, `crates/tui/src/view/tier.rs`, `view/mod.rs`에 `pub mod bigfont; pub mod tier;`(통합 테스트가 쓰므로 `pub`)
- Test: `crates/tui/tests/view_test.rs` (또는 새 `crates/tui/tests/tier_test.rs`)

**Interfaces:**
- Produces (bigfont.rs):
  ```rust
  #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
  pub enum Tier { S, M, L } // Ord: S < M < L
  pub fn supported(s: &str) -> bool;            // 모든 글자가 글꼴에 있음
  pub fn width(s: &str, tier: Tier) -> usize;   // S면 표시 폭(1a text_width)
  pub fn rows(s: &str, tier: Tier) -> Vec<String>; // L 5줄 / M 3줄, 각 줄 길이 == width
  ```
  글꼴: 높이 5점. 숫자 0–9·영문 대문자 A–Z·`-`·`:`는 폭 3점, `,`·`.`은 1점, 공백은 2점(재량: 글리프 모양). 글자 사이 1점. L = 점 1개 → `██`(2칸)×1줄; M = 점 1개 → 1칸×반 줄(위 점·아래 점 → `▀`·`▄`·`█`·공백, 5점 높이 + 빈 1점 = 3줄). `width("30,000", M) == 5×3 + 1 + 5 == 21`, `width("30,000", L) == 2×21 == 42`.
- Produces (tier.rs):
  ```rust
  pub struct TierInput { pub timeout_seconds: u32, pub has_display_items: bool, pub show_stats: bool } // has_display_items = PanelView.n_display_items > 0
  pub const MIN_BAR_ROWS: u16 = 3;
  pub const MIN_DISPLAY_W: u16 = 6;
  pub const UNIT_W: u16 = 3; // " ms"
  pub fn reference_text(timeout_seconds: u32) -> String;       // judge::format_stat_num(timeout×1000)
  pub fn reference_width(timeout_seconds: u32, tier: Tier) -> u16; // bigfont::width + UNIT_W
  pub fn reserved_rows(tier: Tier, show_stats: bool) -> u16;   // 1 + (5|3) + 1 + 1 + 1 + stats + MIN_BAR_ROWS
  /// inner = 테두리 안쪽(폭·높이). L·M은 좌우 여백 1씩 뺀 폭으로 잰다.
  pub fn panel_tier(inner_w: u16, inner_h: u16, p: &TierInput) -> Tier;
  pub fn board_tier(inners: &[(u16, u16)], ps: &[TierInput]) -> Tier; // 최소, 빈 목록 = S
  ```
  `panel_tier`: L부터 — `usable = inner_w − 2`, `need_w = reference_width + (if has_display_items {1 + MIN_DISPLAY_W} else {0})`, `usable ≥ need_w && inner_h ≥ reserved_rows` 이면 그 단계; 아니면 M; 아니면 S. **입력에 점검 값·상태가 없다**(시그니처로 강제).

- [ ] **Step 1: 실패 테스트 작성**

```rust
#[test]
fn bigfont_widths_and_rows() {
    assert_eq!(width("30,000", Tier::M), 21);
    assert_eq!(width("30,000", Tier::L), 42);
    assert!(supported("HTTP 503") && supported("1,407") && !supported("요청 실패") && !supported("—") && !supported("ms"));
    let r = rows("1", Tier::M); assert_eq!(r.len(), 3); assert!(r.iter().all(|l| l.chars().count() == 3));
    let r = rows("1", Tier::L); assert_eq!(r.len(), 5); assert!(r.iter().all(|l| l.chars().count() == 6));
}
#[test]
fn tier_is_fixed_by_config_not_value() {
    // 반목표 1 회귀 가드: timeout 30, display 없음, stats on.
    // inner_w를 "`2`(1글자)라면 L이 들어가지만 `30,000`은 L이 안 들어가는" 값으로: usable 30 → inner_w 32, inner_h 13
    let p = TierInput { timeout_seconds: 30, has_display_items: false, show_stats: true };
    assert_eq!(panel_tier(32, 13, &p), Tier::M);
    // 고의 회귀 실증(Step 2b): panel_tier가 reference 대신 실제 값 "2"로 폭을 재게 바꾸면 이 단언이 L로 RED
}
#[test]
fn tier_reserves_fail_rows_and_stats() {
    // reserved_rows(M, true) == 11, reserved_rows(L, true) == 13, reserved_rows(M, false) == 10
    // inner_h 10·stats on → M 불가(11 필요) → S
}
#[test]
fn tier_display_items_need_left_area() {
    // timeout 30, M: reference_width 24 → display 있으면 usable ≥ 31 필요
    // inner_w 32(usable 30) → display 없으면 M, 있으면 S
}
#[test]
fn board_tier_takes_minimum() { /* 칸 셋 중 하나만 S면 S; 빈 목록 S */ }
#[test]
fn six_panels_at_112x31_and_180x50() {
    // spec US1 관찰 기준: layout(112×31, 6)의 칸 안쪽으로 board_tier(timeout 5·30 섞음, stats on) == M
    // layout(180×50, 6) → L
}
```

- [ ] **Step 2: 실패 확인** — 컴파일 오류(모듈 없음).
- [ ] **Step 2b: 회귀 가드 이빨 실증** — Step 3 구현 뒤, `panel_tier`의 폭 계산을 임시로 `bigfont::width("2", tier)`로 바꿔 `tier_is_fixed_by_config_not_value`가 RED인지 확인 → 원복 → GREEN. 결과를 커밋 메시지 본문 한 줄로 남긴다.
- [ ] **Step 3: 구현** — Interfaces 그대로.
- [ ] **Step 4: 통과 확인** — 전체 PASS + clippy·fmt.
- [ ] **Step 5: 커밋** — `feat(tui): 큰 글꼴과 설정 기반 크기 단계`.

---

### Task 4: L·M 단계 칸 배치 (US1)

spec §4.2 전부(머리 줄·큰 값 블록·허용 폭·폴백·화면 표시 값 왼쪽·사유/연속 줄·막대·시각·평균), 좌우 여백 1.

**Files:**
- Modify: `crates/tui/src/view/monitor.rs` (`render_with_keys`가 `board_tier`를 한 번 구해 칸마다 `render_panel_lm`/`render_panel_s`로 분기)
- Test: `crates/tui/tests/view_test.rs`

**Interfaces:**
- Consumes: Task 2 `render_graph`, Task 3 `Tier`·`board_tier`·`reference_width`·`bigfont::{supported,width,rows}`.
- Produces: `fn render_panel_lm(f, rect, v, selected, tier)`(비공개). 테두리는 1a 그대로(Task 5가 모양·바탕 인자를 더한다).
  규칙(spec §4.2):
  - 안쪽 x = `inner.x + 1`, 사용 폭 `usable = inner.width − 2`.
  - 줄 0 머리: 제목(굵게, `C_TEXT`) 왼쪽 · 상태 문구 오른쪽(1a `state_color`·굵게). 사이 1칸 이상, 모자라면 제목만 `fit`(Task 5의 `▶ ` 접두 2칸까지 포함해 잴 것). 상태 문구 + 1이 `usable`보다 넓으면(예: 제한 시간 ≤ 9초인 M 칸 usable 20에 `– 확인 불가 · 점검 꺼짐` 23칸) 제목을 빼고 `fit(상태 문구, usable)`. 위 테두리엔 제목을 쓰지 않는다.
  - 줄 1..=B(블록, L 5 / M 3): 큰 값. 응답 시간(`BigValue::Text`이고 상태 Ok/Slow, 끝이 ` ms`)은 숫자부를 `bigfont::rows`로 오른쪽 끝 − `UNIT_W` 에서 끝나게, `ms`는 블록 마지막 줄 오른쪽 끝(굵게). 실패류(`BigValue::Reason`의 `Split.fixed`/`Detail.big`)는 `supported` && `width ≤ 허용 폭`이면 큰 글꼴로 오른쪽 끝까지. 허용 폭 = 응답 시간: `reference_width − UNIT_W`(숫자부) / 실패류: `v.n_display_items > 0`이면 `reference_width`, 아니면 `usable`. 그 외(`—`·한글·`NotContained`·넘침)는 블록 가운데 줄에 1a `big_fit(v, 허용 폭)` 굵게 오른쪽 정렬. 색 1a `big_color`.
  - 화면 표시 값: `v.display`의 k번째(최대 2)를 블록 줄 k+1의 x = `inner.x+1`에 `fit(값, usable − reference_width − 1)`(첫 값 `C_TEXT` 굵게, 둘째 `C_SOFT`).
  - 블록 아래: 사유 작은 줄(있으면) → 연속 실패 줄(있으면) → 막대 영역(남는 줄 − 시각 1 − stats(`show_stats`면 1)) → 시각 → 평균·최대(값 없으면 빈 줄). L·M에선 `draw_thresholds = true`(Task 3이 막대 ≥3 보장).
  - 선택 칸: 이 task에선 1a처럼 `BorderType::Thick`(Task 5가 흰 바탕 제목으로 교체).

- [ ] **Step 1: 실패 테스트 작성**

```rust
#[test]
fn lm_six_panels_112x31_big_digits_and_few_blank_rows() {
    // US1 관찰 기준: 112×31, 6칸(정상 3·느림 1·실패 HTTP 503 1·실패 한글 사유 1), stats on, 각 칸 결과 30개 고르게
    // 정상/느림 칸: 블록 줄(머리 줄 다음 3줄)마다 큰 글꼴 문자(▀▄█)가 있다
    // "빈 줄" 정의 = 칸 안쪽에서 **막대 영역 밖**의 공백뿐인 줄(막대 영역 = 블록·사유/연속 줄 다음부터 시각 줄 전까지 — 낮은 막대 위 빈 공간은 빈 줄이 아니다). 정상/느림 칸에서 ≤ 1.
}
#[test]
fn lm_tier_same_for_small_and_large_latency() {
    // spec §8 반목표 1 렌더 수준: TestBackend 34×17 1칸 → 안쪽 32×13, timeout 30, display 없음, stats on, **graph_max_ms 60,000**(29,871 ms 막대가 3.5줄이라 블록 바로 아래 막대 맨 윗줄이 비어 "그다음 줄엔 큰 글꼴 문자 없음" 단언이 막대 `█`와 섞이지 않는다)
    // 응답 2 ms 화면과 29,871 ms 화면 모두 머리 줄 다음 정확히 3줄이 큰 글꼴 줄이고 그다음 줄엔 큰 글꼴 문자가 없다(M)
    // (값 기준 단계로 바꾸면 2 ms 화면이 L(5줄)이 되어 RED — 고의 회귀로 실증)
}
#[test]
fn lm_fail_rows_do_not_change_tier() {
    // 같은 34×17·timeout 30: 정상(413 ms)과 연속 실패(HTTP 503 + 사유 작은 줄 + 연속 줄) 두 화면 모두 큰 글꼴 3줄(M), 머리 줄 y 같음
}
#[test]
fn lm_stats_row_blank_when_no_stats() {
    // L/M 크기, show_stats on, 결과 전부 확인 못 함 → 평균·최대 자리(맨 아래 안쪽 줄)가 공백, 막대 영역 높이는 정상 화면과 같다
}
#[test]
fn lm_http_503_big_without_display_items() {
    // timeout 5, display_items 없음, M: 블록 3줄에 큰 글꼴 'HTTP 503'(rows("HTTP 503", M)과 같은 문자열이 그 줄들에)
}
#[test]
fn lm_reason_over_reference_is_plain_with_display_items() {
    // display_items 1개 설정 + 같은 'HTTP 503'(reference_width 넘음) → 블록 가운데 줄에 일반 글자 "HTTP 503"
}
#[test]
fn lm_korean_reason_and_dash_plain_on_middle_row() {
    // '요청 실패' → 블록 가운데 줄 일반 글자, 확인 중('—') → 가운데 줄; 블록 위·아래 줄 위치(머리·막대 시작 y)는 정상 칸과 같다
}
#[test]
fn lm_display_values_left_area_fixed() {
    // 112×31 6칸, timeout 30, **칸 인덱스 0(1열)** — `layout()` 폭이 37·37·38이라 3열(인덱스 2·5)은 안쪽 36 → 자리 9라 안 잘린다
    // 1·2열: 왼쪽 자리 = usable 33 − 기준 폭 24 − 1 = 8. 표시 값 "정상 영업"(폭 9)
    // 응답 2 ms 화면과 1,407 ms 화면 모두 "정상 영…"(잘림)으로 같다
    // (실제 값 폭으로 자리를 재면 2 ms 화면에서 안 잘려 RED — 고의 회귀로 실증)
}
#[test]
fn lm_latency_over_reference_is_plain() {
    // timeout 5, 응답 12,345 ms(흐름 합계) → 큰 글꼴 아님, 가운데 줄 "12,345 ms"
}
#[test]
fn lm_long_title_selected_keeps_state_label() {
    // Review Focus 1: 아주 긴 제목 + 선택 + 좁은 M 칸 → 상태 문구 통째, 제목 '…', 칸 밖 글자 없음
}
#[test]
fn lm_resize_sweep_no_overflow() {
    // Review Focus 4 / US3: 칸 수 1..=9 × 크기 {칸 최소 크기, 80×24, 112×31, 140×40, 180×50, 200×60}로 그려
    // ① 패닉 없음 ② `layout()` 각 칸 사각형의 모서리·변 글자 칸이 테두리 문자 그대로(덮어쓰기 없음)
    // ③ 각 칸 상태 문구가 통째로(또는 머리 줄 규칙대로 fit) 보임 ④ 머리 줄에 점검 상태, 맨 아래 줄이 키 안내 줄
}
```

- [ ] **Step 2: 실패 확인** — 렌더가 아직 S뿐이라 FAIL.
- [ ] **Step 3: 구현** — Interfaces 그대로. 기존 S 경로는 `board_tier == S`일 때만.
- [ ] **Step 4: 통과 확인** — 전체 PASS + clippy·fmt. 이 task에서 단계가 S→L/M으로 바뀌어 깨질 것으로 예상되는 1a 테스트와 지킬 불변식(갱신 내역은 커밋 본문에 나열):
  - `colors_match_gui`(80×24가 L이 됨 — 행 2가 머리 줄): 상태 문구 = `state_color`, 큰 값 = `big_color`, 테두리 = `border_color` 대응을 **새 위치**에서 단언.
  - `render_axis_shows_bar_times`(M, 보이는 막대 22~23개): "시각 줄 눈금 = 보이는 가장 오래된·최신 막대의 실제 시각"을 보이는 범위에 맞춰 단언.
  - `narrow_three_column_panel_keeps_max_number`: 평균·최대 줄이 최대 숫자를 통째 보존(픽스처 `show_stats: true`).
  - `render_monitor_contains`·`long_title_gets_ellipsis`·`not_contained_keeps_quote_and_tail`·`consecutive_degrades_to_short_form`·`stats_degrade_by_whole_segments`·`render_min_panel_keeps_axis`·`render_nine_panels_at_minimum`: 1a 규칙(통째 줄임·따옴표·꼬리 보존·최소 크기에서 상태/막대/시각)이 검사 대상이면 **S 크기로 고정**해 그대로 두고, 아니면 L/M에서 같은 의미로 갱신.
- [ ] **Step 5: 커밋** — `feat(tui): L·M 단계 칸 배치 — 큰 응답 시간·화면 표시 값·여백`.

---

### Task 5: 테두리 2모양·선택 칸 흰 바탕 제목·바탕 물들이기 (US1·US4 화면)

spec §6(테두리 모양·선택·배경).

**Files:**
- Create: `crates/tui/src/prefs.rs`의 `BorderStyle`만 먼저(Task 6이 파일 입출력 추가), `lib.rs`에 `pub mod prefs;`
- Modify: `crates/tui/src/view/monitor.rs` (`MonitorScreen.border`, 테두리 그리기, 선택 표시, 바탕), `crates/tui/src/app.rs` (`monitor_screen`이 `border` 채움 — 기본 `Heavy`)
- Test: `crates/tui/tests/view_test.rs`

**Interfaces:**
- Produces:
  ```rust
  // prefs.rs
  #[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "snake_case")]
  pub enum BorderStyle { #[default] Heavy, Block }
  impl BorderStyle { pub fn toggled(self) -> Self; }
  // monitor.rs
  pub struct MonitorScreen { /* 1a 필드 */ pub border: BorderStyle }
  ```
  - 테두리: 모든 칸 같은 모양, 색 1a `border_color`. Heavy = ratatui `BorderType::Thick`. Block = ratatui `BorderType::QuadrantOutside`(`▛▀▜ ▌▐ ▙▄▟`, `.title()` 지원 — S 단계 테두리 제목에 필요). 그 변형이 없으면 직접 그린다.
  - 선택: 테두리 차이 없음. L·M = 머리 줄 제목을 `"▶ " + 제목`으로, 스타일 fg `#0b0f14`·bg `C_TEXT`·굵게. S = 위 테두리의 ` 제목 `을 같은 스타일 `" ▶ 제목 "`으로.
  - 바탕: `Slow` = 최신 막대 색, `Fail` = `#ef4444` — **둘 다** 그 색을 칸 바탕 `#0b0f14`에 섞은 어두운 색(섞는 비율 재량, 기준 0.15 — 원색 그대로 칠하지 않는다)으로 **테두리 안쪽 전체**(빈 글자 칸 포함) bg. 다른 상태 None. 그 위 글자·막대·점선은 fg만 바꾸고 bg는 칸 바탕 유지. `render_panel_lm`·S 경로에 `border: BorderStyle`·`bg: Option<Color>` 인자를 더한다.

- [ ] **Step 1: 실패 테스트 작성**

```rust
#[test]
fn border_styles_heavy_and_block() {
    // 같은 화면을 border Heavy/Block으로: Heavy → '┏' 개수 == 칸 수, Block → '▛' 개수 == 칸 수, '┌' 없음
}
#[test]
fn selected_panel_is_inverted_title_not_border() {
    // L/M: 선택 칸 머리 줄에 "▶ 로그인" — 그 글자 칸 bg == Rgb(f2,f5,f8), 비선택 칸 제목 bg != 그 색
    // S(작은 화면): 위 테두리 줄에 "▶ 로그인" 같은 스타일
    // 선택·비선택 칸 테두리 글자가 같다(모두 '┏')
}
#[test]
fn tint_slow_and_fail_only() {
    // 느림·실패 칸 안쪽 빈 글자 칸 bg가 Some(섞은 색)이고 서로 다르며, 정상 칸 안쪽 bg는 Reset
    // 실패 칸 안 기준선 숫자 글자 칸 bg == 그 칸 바탕(숫자가 바탕 위에 보인다)
}
```

- [ ] **Step 2: 실패 확인** — `MonitorScreen.border`·`prefs` 없음 → FAIL.
- [ ] **Step 3: 구현** — Interfaces 그대로. `render_monitor_contains`의 1a 단언("선택 칸 하나만 `┏`")은 새 규칙(모든 칸 `┏`, 선택은 `▶`)으로 갱신.
- [ ] **Step 4: 통과 확인** — 전체 PASS + clippy·fmt.
- [ ] **Step 5: 커밋** — `feat(tui): 굵은 선/반 칸 블록 테두리·흰 바탕 선택 제목·느림·실패 바탕`.

---

### Task 6: 테두리 기억(설정 파일)·`b` 키·키 줄·도움말 (US3·US4)

spec §6(기억 규칙 전부), §7(키 줄·도움말 순서).

**Files:**
- Modify: `crates/tui/src/prefs.rs`(입출력), `crates/tui/src/app.rs`, `crates/tui/src/text.rs`, `crates/tui/src/view/monitor.rs`(`render_with_keys -> bool`, 키 줄), `crates/tui/src/view/overlay.rs`(필요 시)
- Create: `crates/tui/tests/prefs_test.rs`
- Test: `crates/tui/tests/app_test.rs`, `crates/tui/tests/view_test.rs`

**Interfaces:**
- Consumes: Task 5 `BorderStyle`, `MonitorScreen.border`.
- Produces:
  ```rust
  // prefs.rs
  #[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(default)] // 모르는 키는 무시 — wire.rs의 deny_unknown_fields를 일부러 따르지 않는다(spec §6)
  pub struct Prefs { pub border: BorderStyle }
  pub enum Loaded { Missing, Ok(Prefs), Invalid(String) } // Invalid = 경고 문구
  pub fn config_dir_from(xdg: Option<OsString>, home: Option<OsString>) -> Option<PathBuf>; // logging::state_dir_from과 같은 판정, ".config"/"handicap"
  pub fn config_dir() -> Option<PathBuf>; // config_dir_from(env XDG_CONFIG_HOME, env HOME)
  pub fn prefs_path() -> Option<PathBuf>; // config_dir()?.join("tui.json")
  pub fn load(path: &Path) -> Loaded;     // NotFound → Missing, 그 외 읽기 오류·JSON 오류(알 수 없는 enum 값 포함) → Invalid
  pub fn save(path: &Path, p: &Prefs) -> std::io::Result<()>; // create_dir_all + tempfile::NamedTempFile::new_in(dir) + write + persist
  // app.rs
  Action::ToggleBorder // Monitor 화면에서 'b'(normalize_char: 'ㅠ' → 'b')
  // monitor.rs
  pub fn render_with_keys(f: &mut Frame, s: &MonitorScreen, bar: KeyBar) -> bool; // 칸을 그렸으면 true(TooSmall이면 false)
  ```
  - App: 시작 시 `prefs_path()` → `load` → `Missing`이면 조용히 기본, `Invalid(m)`면 `tracing::warn!`, 경로 없음이면 `tracing::info!` 한 번(메모리만). `App.border` 보관, `MonitorScreen.border`에 넣는다.
  - App은 마지막 그리기 결과를 `panels_drawn: Cell<bool>`에 저장(`draw_with`의 `Screen::Monitor` 갈래에서 `render_with_keys` 반환값). 판정은 순수 함수 `pub fn toggle_allowed(screen: &Screen, panels_drawn: bool) -> bool`(= `matches!(screen, Screen::Monitor) && panels_drawn`)로 빼서 테스트한다. `apply(ToggleBorder)`는 `toggle_allowed`일 때만 `border = border.toggled()` + 경로가 있으면 `save`(실패 → `tracing::warn!`, 세션 유지).
  - text.rs: `KEYS_BORDER = "b 테두리"`(키 줄: 이동 · [Tab] · **b 테두리** · ? 도움말 · q 종료). `HELP_KEYS`는 8줄, **맨 앞** `("Ctrl + + / −", "글자 크기(터미널 기능) · 고정은 자동 시작 줄 --zoom=1.6")`, `("b", "테두리 모양 바꾸기(굵은 선 ↔ 반 칸 블록, 기억됨)")`는 `?` 줄 앞.

- [ ] **Step 1: 실패 테스트 작성**

```rust
// prefs_test.rs
#[test] fn prefs_round_trip() { /* save(Block) → load == Ok(Prefs{border: Block}); 디렉터리 자동 생성 */ }
#[test] fn prefs_missing_is_silent_default() { /* 없는 경로 → Loaded::Missing */ }
#[test] fn prefs_bad_inputs_fall_back() {
    // Review Focus 5: 깨진 JSON → Invalid, {"border":"weird"} → Invalid, {"border":"block","future":1} → Ok(Block)(모르는 키 무시)
    // 경로가 디렉터리 → load Invalid, save Err (패닉 없음)
}
#[test] fn config_dir_from_rules() {
    // (Some("/x"), _) → /x/handicap; (None|Some(""), Some("/h")) → /h/.config/handicap; (None, None) → None
}
// app_test.rs
#[test] fn b_and_hangul_toggle_border_on_monitor_only() {
    // handle_key(Monitor, 'b') == ToggleBorder, 'ㅠ' == ToggleBorder, 'B'(Caps) == ToggleBorder
    // Help·QuitConfirm·Error·Usage에서 'b' → ToggleBorder 아님
}
#[test] fn toggle_allowed_only_when_panels_drawn() {
    // (Monitor, true) → true; (Monitor, false: TooSmall) → false; (Help, true) → false
}
// view_test.rs
#[test] fn render_with_keys_reports_panels_drawn() { /* 정상 크기 true, TooSmall false */ }
#[test] fn key_bar_has_border_key() { /* 80열: "←↑↓→ 칸 이동  b 테두리  ? 도움말  q 종료"; 좁으면 앞 조각부터 빠지고 'q 종료' 남음 */ }
#[test] fn help_zoom_row_first_and_survives_small_height() {
    // 도움말 첫 키 줄이 "Ctrl + + / −"; 1a help_tiny_height 테스트 높이에서 키 줄이 하나라도 남으면 그것이 zoom 줄
}
```

`toggle_allowed`가 판정을 덮고, 실제 저장 여부(작은 화면에서 `b` 눌러도 파일 불변)는 라이브 검증 US4 행이 확인한다.

- [ ] **Step 2: 실패 확인** — FAIL(함수·액션 없음).
- [ ] **Step 3: 구현** — Interfaces 그대로. 1a `help_*`·`bottom_key_bar_*`·`key_bar_drops_whole_segments` 테스트의 기대 문자열을 새 조각·줄에 맞게 갱신(줄 빼기 규칙 단언은 유지).
- [ ] **Step 4: 통과 확인** — 전체 PASS + clippy·fmt.
- [ ] **Step 5: 커밋** — `feat(tui): b 키 테두리 전환·설정 파일 기억·도움말 글자 크기 안내`.

---

### Task 7: 문서 — 매뉴얼·ADR 덧붙임·상위 spec 개정 표시

spec §7(매뉴얼·ADR).

**Files:**
- Modify: `docs/dev/tui-monitor.md`, `docs/adr/0055-tui-monitor.md`, `docs/superpowers/specs/2026-11-07-tui-monitor-design.md`

- [ ] **Step 1: 매뉴얼** — 자동 시작 예시 `Exec=gnome-terminal --full-screen -- …`를 `Exec=gnome-terminal --full-screen --zoom=1.6 -- …`로, 바로 아래 "글자 크기 고르기: 전체화면에서 `Ctrl`+`+`/`Ctrl`+`−`(원래대로 `Ctrl`+`0`)로 보기 좋은 크기를 찾고 그 배율을 `--zoom=`에 적는다(터미널은 확대 값을 기억하지 않는다). 6칸이면 1920×1080에서 1.6 안팎." 새 절 "테두리 모양": `b` 키, 선택은 `~/.config/handicap/tui.json`(`XDG_CONFIG_HOME`이 있으면 그 아래 `handicap/tui.json`)에 저장, 파일을 지우면 기본(굵은 선). 실기 확인 항목(전체화면에서 `Ctrl`±·`--zoom` 동작)에 한 줄.
- [ ] **Step 2: ADR-0055 덧붙임** — `## Decision` 끝에 불릿 하나: "**모니터 화면 가독성(2026-11-08 tui-readability 개정)**: 화면 *표현*은 GUI 전시 화면을 따른다(칸 높이를 채우는 막대·기준선·큰 응답 시간). 큰 값 크기는 GUI처럼 가장 넓은 값(제한 시간) 기준으로 설정·화면 크기에서만 정한다. 글자 크기 자체는 터미널 글꼴(`--zoom`)에 맡긴다. TUI 첫 저장 설정 파일(`~/.config/handicap/tui.json`, 테두리 모양)." — 18행 "GUI 전용 표시 로직 … 이식하지 않는다" 문장 끝에 "(표현 일부는 2026-11-08 개정 — 아래)" 추가.
- [ ] **Step 3: 상위 spec** — `2026-11-07-tui-monitor-design.md` §5.1 제목 아래 한 줄: "> 2026-11-08 [tui-readability](2026-11-08-tui-readability-design.md)가 칸 배치·막대·기준선·테두리·선택 표시를 개정했다 — 충돌 시 그 문서가 우선."
- [ ] **Step 4: 커밋** — docs-only(fast-path). `docs(tui): 원거리 가독성 매뉴얼·ADR-0055 덧붙임`.

---

## 라이브 검증 (파이프라인 5단계 — 이 plan의 task 아님, 머지 전 필수)

spec §8 라이브 항. 하네스는 1a의 것(브레인스토밍 세션 scratchpad `lv/`의 `gen.py`·`responder.py`·`matrix.sh` — 다음 세션엔 scratchpad가 바뀌므로 `docs/superpowers/specs/2026-11-08-tui-readability-mockups/README.md`와 1a build-log를 보고 다시 만든다). 추가: 응답기에 50~1,500 ms 무작위 지연 경로, `gen.py`에 기준선 2~3개·`display_items`·`show_latency_stats` 옵션.

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 6칸(정상·느림·HTTP 503·한글 사유·표시 값 2개 칸) 112×31 / 180×50 tmux 캡처 | 112×31 = M(3줄 큰 숫자), 180×50 = L(5줄), 정상·느림 칸 빈 줄 ≤ 1, 느림·실패 바탕색 |
| US2 | 무작위 지연 응답기 + 기준선 700/1200, graph_max 1500 | 막대 높이 제각각, 점선·숫자 열·`(ms)`, 넘은 막대 기준선 색, 응답기 503 전환 시 빨강 빗금 전체 높이(맨 위 표시 없음) |
| US3 | 같은 TUI를 tmux `resize-window`로 80×24→112×31→180×50→칸 최소 크기 | 각 크기에서 다시 배치, 겹침·넘침 없음 + 칸 1~9개 × 크기 매트릭스 전부(사용자 지시) |
| US4 | `b` 두 번·종료·재시작, 작은 화면(TooSmall)에서 `b` | 즉시 모양 전환, 재시작 후 유지, `tui.json` 내용, TooSmall에서 파일 불변, 선택 칸 `▶` 흰 바탕 |

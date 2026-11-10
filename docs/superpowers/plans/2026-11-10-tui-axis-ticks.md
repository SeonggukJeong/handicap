# 시각 줄 중간 눈금 (tui-axis-ticks) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 터미널 모니터 시각 줄에서 자리가 있으면 중간 시각 눈금이 보이고, 각 중간 눈금의 `▲`가 그 시각의 막대를 정확히 가리키게 한다.

**Architecture:** 순수 함수 `axis_marks`(`crates/tui/src/view/axis.rs`)의 **중간 눈금 부분만** 다시 쓴다 — 양 끝 눈금·`Mark` 구조·`axis_line`·렌더(`monitor.rs` `render_axis_row`)는 그대로. 중간 눈금 `text`가 `▲`로 시작하고 `start`가 그 막대 열이 된다.

**Tech Stack:** Rust(edition 2024, MSRV 1.85 — `rust-version` 1.88이라 `is_multiple_of` 금지, 기존 코드 주석 참조), ratatui `TestBackend`.

**Spec:** `docs/superpowers/specs/2026-11-10-tui-axis-ticks-design.md` (§2 규칙 1–5가 정본 — 구현자는 반드시 읽는다).

## Global Constraints

- 간격 상수 `G = 2` = 기존 `MIN_GAP`(`axis.rs:11`) 그대로.
- 중간 눈금 = `"▲"` + 그 막대의 시각 글자, 폭 `m = 1 + 시각 글자 길이`. `▲`(U+25B2)는 막대 열 = `Mark.start`.
- 양 끝 눈금(왼쪽·오른쪽)엔 `▲` 없음, 위치 규칙 불변(`axis.rs:20-46` 현행).
- 이웃 글자 비교는 **`▲`를 뺀 시각 글자**로.
- `crates/tui` 밖 0-diff. `Mark { start: u16, text: String }` 필드 불변.

## Review Focus

1. 결과가 몇 개뿐이라 왼쪽 눈금이 폭 끝으로 밀린 경우(`f > w − ll`) — 오른쪽·중간 눈금 없음(패닉·폭 밖 금지). → 기존 `axis_few_results_clamped`·sweep이 덮음.
2. 폭이 정확히 `n·m + (n+1)·G` 경계(±1)인 경우 — 마지막 중간 눈금이 오른쪽 눈금과 2칸 이상 떨어짐. → sweep 폭 1–120 1칸 단위 + 단언 ②.
3. 분 형식 + 촘촘한 간격에서 이웃 같은 분 — 개수 축소 후 고른 간격, 빈칸 없음. → Step 1 테스트 `axis_minute_dense_reduces_evenly`.
4. 오른쪽에 숫자 열 `(ms)`가 있는 칸 — 중간 눈금이 막대 범위 밖으로 안 나감. → Step 1 렌더 테스트(기준선 있는 6칸).
5. `u16`/`usize` 뺄셈 넘침 — `free`·나머지 계산에서 `saturating_sub` 또는 오른쪽 눈금 존재 전제(`free ≥ G`)로 보장. → sweep(빈 슬롯 0..=w 전 조합)이 패닉으로 잡음.

---

### Task 1: 중간 눈금 규칙 + 테스트 + 문서

**Files:**
- Modify: `crates/tui/src/view/axis.rs:48-76` (중간 눈금 부분 — `// 중간:` 주석부터 `marks.extend(right);`(77) 직전까지; 모듈 머리 주석·`MIN_GAP` 주석 갱신)
- Test: `crates/tui/tests/view_test.rs` (시각 줄 섹션 `// ---------- 시각 줄 ----------` ~510–680, 렌더 섹션 `render_axis_shows_bar_times` 721 근처)
- Modify(docs): `docs/dev/tui-monitor.md:90`, `docs/superpowers/specs/2026-11-07-tui-monitor-design.md:140,143`, `docs/superpowers/specs/2026-11-08-tui-readability-design.md:89` 및 §5.5(`grep -n "### 5.5" …`)

**Interfaces:**
- Consumes: 없음.
- Produces: `pub fn axis_marks(times: &[Option<i64>], label: &dyn Fn(i64) -> String) -> Vec<Mark>` — 시그니처 불변. 반환 순서 = 왼쪽 → 중간들 → 오른쪽(있으면).

- [ ] **Step 1: 실패하는 테스트 작성** (`view_test.rs`, 기존 `series`·`lab5`·`lab8`·`BASE` 헬퍼 재사용)

새 테스트 — 기대값은 orchestrator가 스펙 규칙을 독립 시뮬레이션해 얻은 값(아래 "근거")이다. 구현 결과가 다르면 **STOP**하고 보고(산술을 다시 확인 — 임의로 기대값을 고치지 말 것).

```rust
fn starts(m: &[Mark]) -> Vec<u16> { m.iter().map(|k| k.start).collect() }

#[test]
fn axis_middle_appears_at_30_cols() {
    // 재현: 6칸 배치 막대 30칸, 초 형식, 1초 간격.
    let m = axis_marks(&series(30, 0, 1000), &lab8);
    assert_eq!(starts(&m), vec![0, 11, 22], "{m:?}");
    assert_eq!(m[1].text, format!("▲{}", lab8(BASE + 11_000)));
}

#[test]
fn axis_middle_even_at_60_cols() {
    let m = axis_marks(&series(60, 0, 1000), &lab8);
    assert_eq!(starts(&m), vec![0, 13, 26, 39, 52], "{m:?}");
}

#[test]
fn axis_middle_with_leading_empty_slots() {
    // US3: 앞 30슬롯 빈칸.
    let m = axis_marks(&series(60, 30, 1000), &lab8);
    assert_eq!(starts(&m), vec![30, 41, 52], "{m:?}");
    assert_eq!(m[1].text, format!("▲{}", lab8(BASE + 11_000)));
}

#[test]
fn axis_minute_dense_reduces_evenly() {
    // 순수 함수 — lab5 주입으로 분 형식 강제. n_max 13 → 8, n_max 23 → 15.
    let m = axis_marks(&series(120, 0, 5000), &lab5);
    assert_eq!(starts(&m), vec![0, 12, 25, 38, 51, 64, 77, 90, 103, 115], "{m:?}");
    let texts: Vec<&str> = m.iter().map(|k| k.text.as_str()).collect();
    assert_eq!(
        texts,
        vec!["10:00", "▲10:01", "▲10:02", "▲10:03", "▲10:04", "▲10:05", "▲10:06", "▲10:07", "▲10:08", "10:09"]
    );
    // 개별 제외(고르게 놓은 23개에서 같은 분만 빼기)도 15개를 남기므로 개수만으론 못 잡는다 — 시작 열을 고정.
    let m = axis_marks(&series(200, 0, 5000), &lab5);
    assert_eq!(
        starts(&m),
        vec![0, 12, 25, 38, 51, 63, 75, 87, 99, 111, 123, 135, 147, 159, 171, 183, 195],
        "{m:?}"
    );
}
```

근거: 값은 스펙 §2 규칙 1–5의 **독립 재도출 두 번**(orchestrator 시뮬레이션 + plan 리뷰어의 별도 시뮬레이션)이 일치한 것이다 — 이 plan이 정본(시뮬레이션 스크립트는 세션 scratchpad라 다음 세션엔 없다).

`axis_invariants_sweep`(604) 갱신:
- 폭 범위 `1..=60` → `1..=120`.
- 눈금 분류는 **위치로**: `m[0]` = 왼쪽, `m.last()`가 `w`에서 끝나고 `m.len() ≥ 2`면 오른쪽, 그 사이 = 중간.
- 기존 "자기 막대" 단언(`641` `(s..e).any(…)`)을 분기: 양 끝은 기존 단언 유지 + `!text.starts_with('▲')`; 중간은 `text.starts_with('▲')` 이고 `label(t[s].unwrap()) == text['▲' 뒤]`.
- 이웃 글자 비교(`assert_ne!(p.text, k.text)`)를 `▲`를 뺀 글자 비교로.
- 간격 `s >= pe + 2` 유지(모든 이웃).
- 추가 ⑥ 최대성: `kind`가 0(1초) 또는 1(5초)이고 라벨이 `lab8`이며 오른쪽 눈금이 있을 때, 중간 눈금 수 == `(free − 2) / (m + 2)` (`free` = 오른쪽 시작 − 왼쪽 끝, `m` = 9).
- 추가 ⑦ 중간 눈금이 1개 이상이면 이웃 간격(`다음.start − 앞 끝`) 전부의 max − min ≤ 1.

렌더 테스트 `render_axis_middle_tick_points_at_bar` (기존 `render_axis_shows_bar_times` 패턴): 6칸 보드 `board(panels, false)`(통계 끔 → 시각 줄 = 칸의 `r.y + r.height − 2` 행, 기존 테스트와 같음), `panel` ×6, `bar_count` 60, `interval_seconds` 1, 각 칸 기준선 **2개 = 1000 ms·1500 ms**(`view_test.rs:250` 근처 `Threshold { … }` 생성 방식 재사용 — 숫자 열 폭이 `"1,500"` 5글자가 되어 막대가 정확히 30칸 = 재현 폭: 120×30 6칸 = 칸 40×14, 사용 폭 36(`monitor.rs:435`) − (5 + 1)), 결과 60개 1초 간격, `render_buf(120, 30, …)`, `layout(Rect::new(0,0,120,30), 6)`의 칸마다:
- 시각 줄 행 텍스트에 `▲`가 1개 이상 있다.
- `re` = 그 행에서 `format_hms(최신 at_ms)` 글자가 끝나는 열(= 막대 범위 오른쪽 끝, 최신 막대 열 = `re − 1`). 각 `▲` 열 `x`에 대해 `format_hms(최신 at_ms − (re − 1 − x) × 1000)` == `▲` 뒤 8글자.
- 같은 행에 `(ms)`가 있고, 마지막 `▲` 눈금 끝 + 2 ≤ 오른쪽 눈금 시작.

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cargo nextest run -p handicap-tui -E 'test(/axis/)'`
Expected: FAIL — `axis_middle_appears_at_30_cols`(눈금 2개), `axis_middle_even_at_60_cols`, `axis_middle_with_leading_empty_slots`, `axis_minute_dense_reduces_evenly`, `axis_invariants_sweep`(▲ 없음), `render_axis_middle_tick_points_at_bar`(▲ 없음). 기존 테스트 중 위 6개 외 실패가 있으면 기록.

- [ ] **Step 3: `axis_marks` 중간 눈금 구현** (`axis.rs`)

스펙 §2 규칙 1–5 그대로:
1. `right`가 `None`이면 중간 없음 → `marks` 반환(현행 `limit = w` 분기 제거).
2. `free = right.start − left_end`, `m = 1 + 시각 글자 길이`(왼쪽 눈금 글자 길이 사용 — 같은 형식), `n_max = (free − G) / (m + G)`.
3. `n`을 `n_max`부터 0까지 내리며: 남는 칸 `free − n·m`을 `n+1`로 나눈 몫 + 나머지는 앞(왼쪽) 간격부터 1칸씩 → 시작 열 계산 → 각 열의 `times[col]` 시각 글자로 줄을 만들어(규칙 2로 늘 `Some`이지만 패닉 없이 처리: `None`이면 그 `n`은 불채택하고 다음 `n`으로 — `unwrap`/`unwrap_or_default` 금지) 이웃(왼쪽 → 중간들 → 오른쪽) 시각 글자가 모두 다르면 채택.
4. 채택한 중간 눈금을 `Mark { start: col as u16, text: format!("▲{t}") }`로 넣고 `marks.extend(right)`.

`MIN_GAP` 주석을 "눈금끼리 최소 간격(칸) — 모든 이웃에 같게"로, 모듈 머리 주석에 "중간 눈금 = `▲` + 시각, `▲`가 그 막대 열(tui-axis-ticks 스펙 §2)" 한 줄.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo fmt -p handicap-tui` (pre-commit `fmt --check` 대비).
Run: `cargo nextest run -p handicap-tui` → Expected: 전부 PASS.
Run: `cargo clippy -p handicap-tui --all-targets -- -D warnings` → Expected: 경고 0.
Run: `TZ=UTC cargo nextest run -p handicap-tui -E 'test(/axis/)'` → Expected: PASS(렌더 테스트가 `format_hms`=Local로 기대값을 구하는지 확인 — `crates/tui/CLAUDE.md` KST/UTC 함정).

- [ ] **Step 5: 이빨 실증 두 건** (결과를 리포트에 기록, 끝나면 반드시 원복)

순서를 지킬 것(작업본을 먼저 백업 — `git checkout`/`stash` 금지):
(a) ① `mkdir -p .superpowers/sdd` 다음 `cp crates/tui/src/view/axis.rs .superpowers/sdd/axis.rs.work`(gitignore 경로) ② `git show HEAD:crates/tui/src/view/axis.rs > crates/tui/src/view/axis.rs`(HEAD = 이 커밋 전 옛 본문; 리다이렉트가 거부되면 백업 파일 + Edit 도구로 옛 중간 눈금 부분을 되살린다) ③ `cargo nextest run -p handicap-tui -E 'test(axis_middle_appears_at_30_cols)'` → Expected: FAIL(시작 열 `[0, 22]`) ④ `cp .superpowers/sdd/axis.rs.work crates/tui/src/view/axis.rs`.
(b) 규칙 3의 축소를 "충돌 시 곧장 `n = 1`"로 고의 변경 → `axis_minute_dense_reduces_evenly` FAIL 확인(120칸 `[0, 57, 115]`) → Edit로 원복.
원복 후 Step 4 명령 재실행 → PASS.

- [ ] **Step 6: 문서**

- `docs/dev/tui-monitor.md:90`: "점검이 밀리거나 끊긴 구간은 눈금 간격이 고르지 않게 보인다" → "점검이 밀리거나 끊긴 구간은 눈금 사이 시각 차이가 고르지 않다"로 교체, 그 앞에 "양 끝 사이 눈금은 `▲`로 시작하며 `▲` 바로 위 막대가 그 시각의 막대다." 한 문장.
- 1a spec `:140` 중간 눈금 서술 끝에 "(중간 눈금 규칙은 2026-11-10 [tui-axis-ticks](2026-11-10-tui-axis-ticks-design.md) §2가 개정 — `▲` 표시·고른 배치)" 추가, `:143` "눈금 간격이 고르지 않다" → "눈금 사이 시각 차이가 고르지 않다".
- readability spec `:89`와 §5.5의 "1a `axis_marks` 그대로" 뒤에 "(중간 눈금은 tui-axis-ticks가 개정)".

- [ ] **Step 7: 커밋** (단일 FOREGROUND 호출, timeout 600000 — 파이프 금지)

```bash
git add crates/tui/src/view/axis.rs crates/tui/tests/view_test.rs docs/dev/tui-monitor.md docs/superpowers/specs/2026-11-07-tui-monitor-design.md docs/superpowers/specs/2026-11-08-tui-readability-design.md
git diff --cached --name-only
git commit -F <scratchpad>/msg.txt     # 제목: "fix(tui): 시각 줄 중간 눈금 — 고른 배치 + ▲ 막대 표시"; 본문에 고친 기존 단언 목록; Co-Authored-By 트레일러
git log -1 --oneline
```

---

### Task 2: 라이브 검증 (orchestrator — 코드 변경 없음)

스펙 §5 그대로 tmux python 드라이버를 **새 세션 scratchpad에 다시 작성**(진단 세션 스크립트는 남아 있지 않다): `crates/tui/tests/fixtures/smoke_bundle.json`을 읽어 `BASE_URL`·`interval_seconds`·칸 수(id `01J0000000000000000000PN{NN}`)·기준선을 바꿔 쓰고, `ThreadingHTTPServer`(`request_queue_size = 64`) 응답기가 100·200·400·800·1200·1600·2000·300·50·1000 ms를 순서대로 지연하며 (도착 시각, 지연)을 로그, `tmux new -d -s … -x W -y H ./target/debug/handicap-tui board.json` → 대기 → `capture-pane -p` → `q`,`y`로 종료. `XDG_CONFIG_HOME`/`XDG_STATE_HOME`은 scratchpad로 격리, `graph_max_ms`는 기본 2000. 워크트리 자체 바이너리 `./target/debug/handicap-tui`(먼저 `cargo build -p handicap-tui`).

- [ ] **US1**: 120×30 6칸(기준선 2개)·160×45 9칸 → 중간 눈금 존재, 겹침·잘림 없음, `(ms)`와 안 겹침. 80×24 9칸 → 겹침·잘림 없음만.
- [ ] **US2**: 1칸 120×30, `graph_max_ms` 2000 → `▲` 열 막대 높이 ms 환산 ↔ 응답기 로그(순서로 대응) 1/8칸 안 일치, `▲` 뒤 시각 ↔ 로그 시각 1초 안.
- [ ] **US3**: 시작 직후(막대 절반쯤) 1칸 캡처 → 중간 눈금 존재.
- [ ] **극단값**: 24열 칸 최소 폭 겹침 없음 · 1칸(기준선 없음)·`bar_count` 300·5초·폭 ≥ 205, 결과 200개(약 17분, 백그라운드) → `HH:MM` 형식·겹침 없음·이웃 글자 다름·간격 고름.
- [ ] 결과(통과 신호 표, US별)를 build-log 단락용으로 기록.

REVIEW-GATE: APPROVED

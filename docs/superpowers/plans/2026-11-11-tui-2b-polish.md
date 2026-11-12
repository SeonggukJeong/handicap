# 값 고르기 소형 보완 (tui-2b-polish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 터미널 모니터 `handicap-tui`에서 ① 아주 크거나 작은 수를 골라도 조건이 저장되고 ② 조건 칸의 긴 `대상`이 여러 줄로 읽히고 ③ 하위 화면이 칸·상태를 못 찾으면 빈 화면 대신 안내가 보이게 한다.

**Architecture:** 세 변경 모두 `crates/tui` 안의 순수 함수 + 그리기 연결이다. ① `pick::number_text`(새 순수 함수)를 `visit_f64`가 쓴다. ② `view::edit::cond_form_height`(새 순수 함수)가 조건 칸 높이를 정하고 `render_cond_form`이 같은 줄 계산으로 대상의 이어지는 줄을 그린다. ③ `App::draw_sub`의 화면별 갈래가 "그렸는가"를 돌려주고, 못 그렸으면 `view::inspect::render_missing`을 부른다.

**Tech Stack:** Rust(edition 2024, `crates/tui`의 `rust-version` 1.88), ratatui `TestBackend`. 테스트는 `crates/tui/tests/*.rs`(통합 테스트 — 공개 API만 쓴다).

REVIEW-GATE: APPROVED

(`spec-plan-reviewer` — spec 3라운드·plan 2라운드 clean APPROVE, 2026-11-11. 리뷰어가 Task 1·2의 코드와 테스트를 저장소 사본에 적용해 `cargo test -p handicap-tui`·clippy 통과와 회귀 실증 변이의 RED를 확인했다.)

**Spec:** `docs/superpowers/specs/2026-11-11-tui-2b-polish-design.md` — §2(동작 규칙)가 정본이다. 구현자는 맡은 task의 §2 절과 §6(테스트)을 반드시 읽는다. US 블록은 spec의 `## 사용자 스토리 (US)` 절(매 brief에 첨부).

## Global Constraints

- `crates/tui` 밖 0-diff(`Cargo.toml`·`Cargo.lock` 포함). 새 의존성 없음.
- 한 줄에 들어가는 `대상`·정상 경로의 하위 화면은 **변경 전과 글자까지 같다** — 기존 테스트를 고쳐서 통과시키지 않는다(고쳐야 하면 STOP하고 보고).
- 원격 문자열(`대상`)은 폭을 재기 **전에** `inspect::sanitize`(`crates/tui/CLAUDE.md`).
- 폭·높이 뺄셈은 `saturating_sub`. 테스트 스윕은 폭 1칸 단위.
- 값을 품는 타입에 derive `Debug`를 새로 달지 않는다.
- **cloud 컨테이너 환경**: `cargo-nextest`가 없다 — pre-commit이 `cargo test --workspace`로 대신한다(수 분). 커밋은 한 번에 하나, `| tail`·`| head` 금지, 판정은 `; echo exit=$?` 뒤 `git log -1`. `~/.cargo/config.toml`의 `[profile.dev] debug = false`(디스크 한도 때문)를 지우지 않는다. `pnpm build`는 돌리지 않는다(OOM — 이 슬라이스는 `ui/` 무접촉).
- 작업 위치: `/home/user/handicap`, 브랜치 `ccr-7683ac09-t7d25q`(워크트리 없음). subagent prompt 첫 줄은 `cd /home/user/handicap`.
- 커밋 전에 `cargo fmt -p handicap-tui`(pre-commit이 `fmt --check`로 거절한다 — plan의 조각도 그대로 붙이면 줄 길이에 걸릴 수 있다).
- 기대값이 구현 결과와 다르면 기대값을 고치지 말고 **STOP → 재현 → 보고**(§2.1 표는 실행으로 확인한 값이다 — spec §11 ①).

## Review Focus

1. `number_text`가 §2.1-3·-4 두 표와 글자까지 같고, 모든 결과가 `str::parse::<f64>()`로 **`serde_json`이 읽은 값**과 같은 수로 돌아오는가.
2. 조건 칸 높이를 정하는 쪽(`cond_form_height`)과 그리는 쪽(`render_cond_form`)의 줄 수가 같은가 — 어긋나면 목록 줄이 가려지거나 빈 줄이 남는다.
3. 잘린 대상의 마지막 줄이 실제로 `…`로 끝나는가(`fit`은 폭 안의 글자에 `…`를 붙이지 않는다 — 남은 글자 전체를 넘겨야 한다).
4. `fw < 8`·폭 1~12열·높이 1~8줄에서 패닉이 없는가(`wrap_width(s, 0)`은 글자마다 한 줄).
5. `draw_sub`의 모든 "그리지 않고 돌아오는" 갈래가 `false`를 돌려주는가 — 하나라도 `true`면 빈 화면이 남는다. 정상 경로가 `false`를 돌려주면 정상 화면 위에 안내가 덮인다.
6. 대체 화면 키 줄이 키 동작과 맞는가(창이 열린 편집 화면에서 `Esc 뒤로`라고 쓰면 틀린다).

---

### Task 1: 숫자 글자 — `pick::number_text`

**Spec:** §2.1, §6 `pick_test`. **US:** US1.

**Files:**
- Test: `crates/tui/tests/pick_test.rs`(끝에 새 섹션 `// ---------- tui-2b-polish: 숫자 글자 ----------`. 기존 도우미 `resp`(19)·`default_condition` 사용 예는 `default_condition_table`(501)을 본다)
- Modify: `crates/tui/src/pick.rs` — `PickValue::Number` 주석(34), `visit_f64`(275), 새 `pub fn number_text`

**Interfaces:**
- Produces: `pub fn number_text(v: f64) -> String` (`handicap_tui::pick::number_text`).

- [ ] **Step 1: 실패하는 테스트 작성** (`pick_test.rs`)

```rust
// ---------- tui-2b-polish: 숫자 글자 ----------

/// 본문 `{"v":<lit>}`의 `$.v` 줄 → (값 목록에 보이는 글자, 기본 조건의 비교값).
fn number_of(lit: &str) -> (String, String) {
    let l = value_list(&resp(200, &[], &format!("{{\"v\":{lit}}}")), false, 64);
    let row = l
        .rows
        .iter()
        .find(|r| matches!(&r.kind, RowKind::Body { path } if path == "$.v"))
        .unwrap_or_else(|| panic!("{lit}: no $.v row"));
    (row.shown(), default_condition("S1", row).cond.value)
}

/// spec §2.1-3 — `serde_json`이 정확히 읽는 글자. GUI `String(JSON.parse(x))`와 같은 글자
/// (마지막 행만 뜻대로 다르다 — 정수 꼴은 본문 값 그대로).
const EXACT: &[(&str, &str)] = &[
    ("1e300", "1e+300"),
    ("2.5e-300", "2.5e-300"),
    ("5e-324", "5e-324"),
    ("1.7976931348623157e308", "1.7976931348623157e+308"),
    ("1e21", "1e+21"),
    ("1e20", "100000000000000000000"),
    ("1e299", "1e+299"),
    ("1.0", "1"),
    ("1.5", "1.5"),
    ("1e5", "100000"),
    ("1E5", "100000"),
    ("18446744073709551616", "18446744073709552000"),
    ("1e-6", "0.000001"),
    ("1e-7", "1e-7"),
    ("0.00000123", "0.00000123"),
    ("1.5e-7", "1.5e-7"),
    ("-1e300", "-1e+300"),
    ("-2.5e-10", "-2.5e-10"),
    ("-0.0", "0"),
    ("0.0", "0"),
    ("100.25", "100.25"),
    ("3.0e2", "300"),
    ("0.1", "0.1"),
    ("12345678901234567890", "12345678901234567890"),
];

/// spec §2.1-4 — `serde_json`(float_roundtrip 꺼짐)이 한 끝자리 다르게 읽는 글자: 서버가 읽은 값의 글자.
/// 이 표가 RED가 되면 `serde_json` 읽기가 바뀐 것(spec §9 첫 항목의 해소 신호) — 표를 고치지 말고 보고.
const MISREAD: &[(&str, &str)] = &[
    ("1.5e-300", "1.4999999999999998e-300"),
    ("9.720979928970337e2", "972.0979928970336"),
    ("4.5e250", "4.4999999999999993e+250"),
];

#[test]
fn number_text_tables() {
    for (lit, want) in EXACT.iter().chain(MISREAD) {
        let (shown, value) = number_of(lit);
        assert_eq!(shown, *want, "shown for {lit}");
        assert_eq!(value, *want, "condition value for {lit}");
    }
}

#[test]
fn number_text_reads_back_as_server_value() {
    // 서버: 실제 값 = serde_json이 읽은 f64, 비교값 = str::parse(`parse_finite`) → `==`.
    for (lit, text) in EXACT.iter().chain(MISREAD) {
        let server: f64 = serde_json::from_str(lit).unwrap();
        let back: f64 = text.parse().unwrap_or_else(|_| panic!("{text} not a number"));
        assert_eq!(back, server, "{lit} -> {text}");
    }
}

#[test]
fn number_text_is_short() {
    use handicap_tui::pick::number_text;
    for v in [
        f64::MAX,
        f64::MIN,
        f64::MIN_POSITIVE,
        -f64::MIN_POSITIVE,
        5e-324,
        -5e-324,
        -1.2345678901234567e-100,
        -0.0000012345678901234567,
        1.2345678901234567e20,
    ] {
        let t = number_text(v);
        assert!(t.len() <= 26, "{t} is {} chars", t.len());
        assert_eq!(t.parse::<f64>().unwrap(), v, "{t}");
    }
    assert_eq!(number_text(0.0), "0");
    assert_eq!(number_text(-0.0), "0");
}
```

`value_list`·`default_condition`·`RowKind`는 파일 머리에서 이미 `use`한다(`pick_test.rs:12-16`). `serde_json`은 `crates/tui`의 의존성이다(`crates/tui/Cargo.toml:27`) — 통합 테스트에서 그대로 쓴다.

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-tui --test pick_test number_text 2>&1; echo exit=$?`
Expected: 컴파일 실패(`number_text` 없음).

- [ ] **Step 3: 구현** (`crates/tui/src/pick.rs`)

```rust
/// `f64` → JavaScript `String(number)` 표기 규칙의 글자(tui-2b-polish spec §2.1-2).
/// 0은 `0`, 십진 지수 −6..=20은 지수 없는 십진, 그 밖은 `{가수}e{+|-}{지수}`.
pub fn number_text(v: f64) -> String {
    if v == 0.0 {
        return "0".to_string();
    }
    let sci = format!("{v:e}");
    let Some((mant, exp)) = sci.split_once('e') else {
        return sci;
    };
    let Ok(e) = exp.parse::<i32>() else {
        return sci;
    };
    if (-6..=20).contains(&e) {
        format!("{v}")
    } else if e >= 0 {
        format!("{mant}e+{e}")
    } else {
        format!("{mant}e{e}")
    }
}
```

`visit_f64`: `Ok(Node::Num(format!("{v}")))` → `Ok(Node::Num(number_text(v)))`.
`PickValue::Number` 주석: `/// 숫자 글자 — 정수는 그대로, 그 밖은 JavaScript \`String(number)\` 표기 규칙(\`number_text\`).`

- [ ] **Step 4: GREEN 확인**

Run: `cargo test -p handicap-tui --test pick_test 2>&1; echo exit=$?`
Expected: exit=0, 기존 테스트 전부 통과(기존 테스트를 고쳤다면 STOP).

- [ ] **Step 5: 회귀 실증**

`visit_f64`를 잠시 `format!("{v}")`로 되돌려 `number_text_tables`가 `1e300` 행에서 RED인 것을 확인하고 원복한다(보고에 RED 출력 한 줄 인용).

- [ ] **Step 6: 커밋**

`git add crates/tui/src/pick.rs crates/tui/tests/pick_test.rs` → `git diff --cached --name-only` → `git commit -F <메시지 파일>; echo exit=$?`(FOREGROUND 600000ms) → `git log -1 --oneline`.
메시지 제목: `fix(tui): 큰·작은 수의 숫자 글자 — 지수 표기로 줄여 저장 거절 해소`

---

### Task 2: 조건 칸 `대상` 줄바꿈

**Spec:** §2.2, §6 `edit_view_test`·`values_view_test`. **US:** US2.

**Files:**
- Test: `crates/tui/tests/edit_view_test.rs`(도우미 `form`(281)·`draw_form`(75)·`buffer_text`(18), 기존 `cond_form_does_not_hide_selected_row`(644)가 본보기), `crates/tui/tests/values_view_test.rs`(도우미 `fix`(99)·`draw`(80))
- Modify: `crates/tui/src/view/edit.rs` — `cond_form_lines`(233)·`render_list_with_form`(275 줄의 높이 계산)·`render_cond_form`(418~, 대상 줄 428–431), `crates/tui/src/view/values.rs` — `use`(10)·높이 계산(155)

**Interfaces:**
- Produces: `pub fn cond_form_height(v: &CondFormView, body_w: u16, body_h: u16) -> u16` (`handicap_tui::view::edit`). `cond_form_lines`는 `edit.rs` 안의 비공개 함수로 남는다(값 = 필수 줄 + 받은 값·안내 줄, 지금과 같다).

**설계(정본은 spec §2.2):**

```rust
/// 대상 줄을 줄바꿈하는 최소 값 칸 폭(spec §2.2-2) — 이보다 좁으면 지금처럼 한 줄.
const TARGET_WRAP_MIN_W: usize = 8;
/// 대상의 이어지는 줄은 위 목록에 이만큼이 남는 한도까지만 늘린다(spec §2.2-4).
const FORM_LIST_KEEP: u16 = 3;

/// `sanitize`한 대상 글자를 값 칸 폭 `fw`로 나눈 줄들(좁으면 한 줄).
fn target_rows(target: &str, fw: usize) -> Vec<String> {
    let s = sanitize(target);
    if fw < TARGET_WRAP_MIN_W {
        return vec![s];
    }
    wrap_width(&s, fw)
}

/// 조건 칸 높이(spec §2.2-4) — `body_w`·`body_h` = 화면 body 크기.
pub fn cond_form_height(v: &CondFormView, body_w: u16, body_h: u16) -> u16 {
    let now = cond_form_lines(v);
    let fw = cond_form_value_width(body_w);
    let more = target_rows(v.target, fw).len().saturating_sub(1);
    let extra = u16::try_from(more).unwrap_or(u16::MAX);
    let room = body_h.saturating_sub(FORM_LIST_KEEP).saturating_sub(now);
    now.saturating_add(extra.min(room)).min(body_h)
}
```

`render_cond_form`(대상 줄 부분 — `fw`·`label_w`·`text_style`은 기존 지역 변수):

```rust
let (show_received, show_hint) = extras_shown(v, usize::from(area.height));
let extras = usize::from(show_received) + usize::from(show_hint);
let fixed = usize::from(cond_form_base(v)) + extras;
let spare = usize::from(area.height).saturating_sub(fixed);
let rows = target_rows(v.target, fw);
let shown = 1 + rows.len().saturating_sub(1).min(spare);
for (i, row) in rows.iter().take(shown).enumerate() {
    // 다 못 보이면 마지막 줄은 남은 글자 전체를 `fit` — `…`로 맺는다(spec §2.2-5).
    let t = if i + 1 == shown && shown < rows.len() {
        fit(&rows[i..].concat(), fw)
    } else {
        fit(row, fw)
    };
    let label = if i == 0 {
        form_label(text::COND_FORM_TARGET, label_w)
    } else {
        Span::raw(" ".repeat(label_w))
    };
    lines.push(Line::from(vec![label, Span::styled(t, text_style)]));
}
```

- `extras_shown` 호출이 지금은 대상 줄 **뒤**(433)에 있다 — 대상 줄 앞으로 옮기고 뒤쪽의 같은 호출은 지운다(값은 같다).
- `shown == 1 && rows.len() > 1`이면 `fit(&rows.concat(), fw)` = 지금의 `fit(&sanitize(v.target), fw)`와 같다(한 줄 대상·낮은 화면에서 글자까지 같음 — Global Constraints).
- 호출 2곳: `render_list_with_form`의 `cond_form_lines(fv).min(body.height)` → `cond_form_height(fv, body.width, body.height)`. `values.rs:155`의 `usize::from(cond_form_lines(fv)).min(bh)` → `usize::from(cond_form_height(fv, body.width, body.height))`(`use`도 바꾼다).
- `edit.rs`의 `use super::{fit, text_width};`(14)에 `wrap_width`를 더한다(`fit`·`sanitize`는 이미 있다).

- [ ] **Step 1: 실패하는 테스트 작성**

`edit_view_test.rs`에 새 섹션(`// ---------- tui-2b-polish: 대상 줄바꿈 ----------`). 필요한 단언(spec §6 ①–⑥ — 테스트 이름은 자유, 단언은 전부):

1. `cond_form_target_wraps_fully`: ASCII 500자 경로(`format!("$.{}", "abcdefghi.".repeat(50))`는 502자 — 앞 500자로 자른다. 줄 순서가 바뀐 것을 잡게 마디마다 번호를 섞어도 좋다. 리뷰어 실측: 80×24·`form()` 도우미에서 값 칸 69칸·대상 8줄이 전부 보인다)를 `target`으로 한 `CondFormView`를 `render_list_with_form`으로 80×24에 그린다. 화면에서 `대상` 라벨 줄부터 `규칙` 라벨 줄 전까지의 줄들에서 값 칸 글자(라벨 칸 뒤)를 뽑아 `trim_end` 후 이으면 원래 글자와 같다.
2. `cond_form_target_ellipsis_when_short`: 같은 조건 칸을 높이 24 → 5로 1줄씩 줄이며 그린다. 높이마다: 패닉 없음 · `규칙` 라벨 줄이 보임(필수 줄, 본문이 필수 줄보다 낮은 높이는 지금 동작과 같은지만 — 한 줄 대상 조건 칸과 같은 줄에 `규칙`이 보이면 통과) · 대상이 다 안 보이는 높이에서는 **마지막 대상 줄이 `…`로 끝난다**. 스윕 안에 `…`가 나오는 높이가 **1개 이상** 있음을 따로 단언한다(공허 방지).
3. `cond_form_keeps_selected_row_with_long_target`: 12줄 목록(커서 11)을 `render_list_with_form`으로, 높이 8..=24에서 대상이 짧은 조건 칸과 500자 조건 칸 각각 그린다 — 짧은 쪽에서 고른 줄(`▶`+`조건-12`)이 보이는 높이에서는 긴 쪽에서도 보이고 `대상` 줄보다 위다.
4. `cond_form_width_sweep`: 폭 1..=120 × 높이 {6, 10, 24}에서 500자 대상·한글 경로 대상(`"$.가나다라마바사아자차".repeat(20)`) 패닉 없음(전 폭). 줄 위치 단언은 **라벨이 온전한 폭에서만**: 화면 폭 13..=18(값 칸 폭 `cond_form_value_width(w)`가 2..=7 — 8 미만)에서는 대상 줄이 1줄(`규칙` 줄이 `대상` 줄 바로 다음 — `받은 값` 없는 조건 칸으로), 폭 19(값 칸 8)에서는 대상이 2줄 이상. 폭 12 이하는 라벨 자체가 줄어 줄을 못 찾으므로 패닉 없음만 본다.
5. `cond_form_wide_and_bidi`: 한글 경로가 화면 폭을 넘지 않는다(각 줄 `width(line) <= w` — 기존 `width` 도우미(37)) · 대상의 **둘째 줄 이후 자리**(값 칸 폭보다 뒤 — 예: 80열에서 100번째 글자)에 `\u{202E}`를 넣으면 `\u{FFFD}`가 `대상` 라벨 줄이 아닌 **이어지는 줄**에 보인다(긍정 단언 — 한 줄 대상의 같은 단언은 기존 `remote_strings_sanitized`가 이미 한다) · 한글 경로가 잘리는 높이에서 마지막 대상 줄이 `…`로 끝난다.
6. `cond_form_height_matches_drawn`: 화면 80열 × 본문 높이 {5, 8, 12, 21}(화면 높이가 아니다 — 무입력 안내 줄 때문에 화면 높이 ↔ body 높이가 일정하지 않으니 `sub_layout`으로 그 body 높이가 되는 화면 높이를 찾아 쓴다. 리뷰어 실측: 7·11·15·24) × 대상 길이 {10, 70, 200, 500} × (받은 값·안내 있음/없음)에서 `render_list_with_form`으로 그린 뒤 — body 높이는 `sub_layout(Rect::new(0,0,w,h)).body.height`. 조건 칸 영역 = body 맨 아래 `cond_form_height(v, body_w, body_h)`줄(조건 칸은 늘 그 자리에 놓이므로 **"`대상` 줄부터 body 끝까지 줄 수 == 높이"는 구조상 늘 참 — 그것만 재면 공허하다**). 그래서 그 영역 안에서: ⓐ **빈 줄이 없다**(모든 줄에 공백 아닌 글자 — 그리는 쪽이 줄을 덜 그리면 빈 줄이 남는다) ⓑ 영역의 첫 줄에 `대상` 라벨, 영역 안에 `규칙` 라벨 줄(높이가 모자라 필수 줄이 잘리면 여기서 걸린다) ⓒ 대상이 다 들어가는 조합(높이 21)에서는 `대상` 줄 수 == `wrap` 줄 수(값 칸 69칸 기준 `ceil(길이/69)`). body 높이가 필수 줄보다 낮은 조합은 표에서 뺀다(지금 동작 그대로 — 단언 2가 본다).
7. 짧은 대상(`"status"`)의 `cond_form_height` == 변경 전 값(필수 줄 + 받은 값·안내)임을 3~4가지 조합으로.

`values_view_test.rs`: `values_form_long_target`: 값 목록 화면(`fix(...)` + `form: Some(&fv)`, `received`·`hint` 있는 조건 칸)에서 ASCII 500자 대상 → 80×24에서 `대상` 라벨 줄부터 `받은 값` 라벨 줄 전까지의 값 칸 글자를 이으면 원래 글자와 같고(spec §6 ① — 두 화면 각각) 고른 줄(커서 줄)이 보인다 · 높이 6..=24 스윕에서 패닉 없음, 제목 줄(`— 값 고르기`)이 조건 칸이 body 전체를 덮지 않는 높이에서 보인다.

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-tui --test edit_view_test --test values_view_test 2>&1; echo exit=$?`
Expected: 컴파일 실패(`cond_form_height` 없음).

- [ ] **Step 3: 구현** — 위 "설계"대로.

- [ ] **Step 4: GREEN 확인**

Run: `cargo test -p handicap-tui 2>&1; echo exit=$?` → exit=0. 기존 테스트(`cond_form_layout`·`cond_form_received_and_hint`·`cond_form_does_not_hide_selected_row`·`render_sweep_no_panic`·`width_sweep_no_panic` 등)를 고치지 않았는지 `git diff --stat`으로 확인(테스트 파일은 추가만).

- [ ] **Step 5: 회귀 실증 3건**

① `render_cond_form`의 마지막 줄을 `fit(row, fw)`로 바꾸면(남은 글자 대신 그 줄만) 단언 2의 `…` 긍정 단언이 RED ② `cond_form_height`에서 `room`을 `body_h.saturating_sub(now)`로 바꾸면(목록 3줄 미보장) **단언 3이 RED**(화면 80열·높이 8~12에서 고른 줄이 사라진다 — 리뷰어 계산: 높이 12면 body 9·필수 4·이어지는 줄 7, 맞는 `room` = 2·바꾼 `room` = 5) ③ `render_cond_form`의 `spare`에 `.min(1)`을 붙이면(높이는 그대로인데 대상을 2줄만 그림) **단언 6 ⓐ가 RED**(빈 줄). 각각 확인 후 원복(보고에 RED 출력 인용).

- [ ] **Step 6: 커밋**

`git add crates/tui/src/view/edit.rs crates/tui/src/view/values.rs crates/tui/tests/edit_view_test.rs crates/tui/tests/values_view_test.rs` → staged 확인 → 커밋(FOREGROUND 600000ms) → `git log -1 --oneline`.
메시지 제목: `feat(tui): 조건 칸 대상 줄바꿈 — 긴 경로를 끝까지, 목록 3줄은 남긴다`

---

### Task 3: 칸·상태를 못 찾은 하위 화면

**Spec:** §2.3, §6 `inspect_test`·`app_test`. **US:** US3.

**Files:**
- Test: `crates/tui/tests/inspect_test.rs`(도우미 `draw`(45)·`head`(71)), `crates/tui/tests/app_test.rs`(`edit_keys_per_mode`(2088)와 최상위 도우미 `ui_with`(862)가 본보기 — 1493의 `ui`는 함수 안에 든 도우미라 밖에서 못 쓴다)
- Modify: `crates/tui/src/text.rs`(`KEYS_BACK`(499) 근처에 `SUB_MISSING`), `crates/tui/src/view/inspect.rs`(`render_frame`(67) 아래에 `render_missing`), `crates/tui/src/app.rs`(`draw_sub`(3848)·`draw_values`(3934)·`draw_edit`(3996), 새 `pub fn missing_keys`를 `edit_keys`(2804) 아래에)

**Interfaces:**
- Produces: `pub const SUB_MISSING: &str`(`text`), `pub fn render_missing(f: &mut Frame, head: &HeaderView, keys: &[&str])`(`view::inspect`), `pub fn missing_keys(screen: &Screen, ui: Option<&EditUi>, quit_confirm: bool) -> Vec<&'static str>`(`app`).

**설계(정본은 spec §2.3):**

```rust
// text.rs
pub const SUB_MISSING: &str = "이 칸을 찾을 수 없습니다 — Esc로 돌아가세요";

// view/inspect.rs — 틀(맨 위 줄·키 줄) + body 첫 줄부터 안내(흐리게, 좁으면 줄바꿈).
pub fn render_missing(f: &mut Frame, head: &HeaderView, keys: &[&str]) {
    let body = render_frame(f, head, keys);
    let w = usize::from(body.width).saturating_sub(1);
    if w == 0 {
        return;
    }
    let muted = Style::default().fg(color(C_MUTED));
    for (i, l) in wrap_width(text::SUB_MISSING, w)
        .into_iter()
        .take(usize::from(body.height))
        .enumerate()
    {
        let row = Rect::new(body.x, body.y.saturating_add(i as u16), body.width, 1);
        put(f, row, Line::from(Span::styled(format!(" {l}"), muted)));
    }
}

// app.rs — 대체 화면 키 줄(spec §2.3-3).
pub fn missing_keys(screen: &Screen, ui: Option<&EditUi>, quit_confirm: bool) -> Vec<&'static str> {
    if quit_confirm {
        return vec![text::KEYS_CONFIRM_YES, text::KEYS_CONFIRM_CANCEL];
    }
    match ui {
        // 편집 화면에서 창이 열려 있으면 키가 창으로 먼저 간다 — 그 창의 키 줄.
        Some(ui) if is_edit_screen(screen) && ui.overlay.is_some() => {
            edit_keys(screen, ui, None, false)
        }
        _ => vec![text::KEYS_BACK],
    }
}
```

`draw_sub` 구조(본문 갈래를 `bool`을 돌려주는 메서드로 — 이름은 `draw_sub_screen`):

```rust
fn draw_sub(&self, f: &mut ratatui::Frame, screen: &Screen, quit_confirm: bool) {
    let Some(head) = self.monitor_screen().map(|m| m.header()) else {
        return;
    };
    if self.running.is_none() {
        return;
    }
    if !self.draw_sub_screen(f, screen, &head, quit_confirm) {
        let keys = missing_keys(screen, self.views.edit.as_ref(), quit_confirm);
        render_missing(f, &head, &fit_keys(&keys, f.area().width));
    }
}
```

- `draw_sub_screen`·`draw_values`·`draw_edit`는 `-> bool`. **그리기 함수(`render_*`)를 부른 갈래만 `true`**, 지금 `return;`인 곳과 `_ => {}`는 전부 `false`. 지금 코드의 해당 줄(`grep -n`으로 다시 확인할 것 — `awk 'NR>=3848 && NR<=4150 && /return;|_ => \{\}/ {print NR": "$0}' crates/tui/src/app.rs`): `draw_sub` 3869·3872·3896·3899·3906·3929, `draw_values` 3936·3939·3942, `draw_edit` 3999·4028(바로 위 `if let Some(..) = self.settings_view(w)`가 그렸으면 `true`, 못 그렸으면 `false`)·4031·4041·4056·4145. `draw_sub` 머리의 3850·3853(머리 줄·세션 없음)은 대상이 아니다 — 그대로 `return;`.
- `draw_edit` 맨 위의 `self.menu_rows.borrow_mut().clear()`는 그대로(대체 화면에서 클릭 영역이 빈다 — spec §2.3-5).
- 키 동작(`handle_key`·`edit_key`·`sub_screen_key`)은 건드리지 않는다.
- `QuitConfirm(inner)` → `draw_sub(.., true)` → 위에 확인창을 그리는 지금 흐름은 그대로다(`draw_sub`를 부르는 쪽은 안 바꾼다).

- [ ] **Step 1: 실패하는 테스트 작성**

`inspect_test.rs`:
- `render_missing_shows_guidance`: 80×24에서 `text::SUB_MISSING`이 한 줄에 보이고, 맨 위 줄(머리 줄 — 기존 `head()`의 제목 글자)이 있고, 넘긴 키 줄(`&[text::KEYS_BACK]`)이 맨 아래 줄에 보인다.
- `render_missing_wraps_and_survives_small`: 40×10에서는 안내가 보이고(한 줄), 20×6에서는 화면의 body 줄들을 `trim` 후 이으면 `SUB_MISSING`의 글자가 순서대로 들어 있다(줄바꿈 — 넓은 글자의 둘째 칸 공백은 `crates/tui/CLAUDE.md` TestBackend 함정대로 건너뛴다. 어려우면 "첫 낱말 `이 칸을`과 마지막 낱말 `돌아가세요`가 서로 다른 줄에 보인다"로). 폭 1..=30 × 높이 1..=8 스윕 패닉 없음.

`app_test.rs`:
- `missing_keys_branches`: ① `quit_confirm = true` → `[KEYS_CONFIRM_YES, KEYS_CONFIRM_CANCEL]`(ui 유무·화면 무관 — `Screen::Errors`·`Screen::Values` 둘 다) ② 편집 화면 5종(`Settings`·`EditList`·`EnvVars`·`ScenarioVars`·`Values`) + 창 열림(`Overlay::Input` 등 기존 도우미로 만들 수 있는 것) → `edit_keys(screen, ui, None, false)`와 같다, 그리고 그 결과가 `[KEYS_BACK]`이 **아니다**(공허 방지) ③ 편집 화면 + 창 없음 → `[KEYS_BACK]` ④ 편집 화면 아님(`Errors`·`Record`·`Body`) + ui 있고 창 열림 → `[KEYS_BACK]` ⑤ ui 없음 → `[KEYS_BACK]` ⑥ `저장 중` 창(`Overlay::Saving`) → 빈 목록(지금 `edit_keys`와 같다).

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-tui --test inspect_test --test app_test 2>&1; echo exit=$?`
Expected: 컴파일 실패(`render_missing`·`missing_keys`·`SUB_MISSING` 없음).

- [ ] **Step 3: 구현** — 위 "설계"대로. `app.rs`에 `render_missing`의 `use`를 더한다(`render_body`·`render_errors`를 들여오는 `use crate::view::inspect::{…}` 줄 — `grep -n 'render_errors' crates/tui/src/app.rs`로 찾는다). `inspect.rs`의 `use super::{fit, key_bar, text_width};`(14)에 `wrap_width`를 더한다. `put`은 `inspect.rs`의 지역 함수(26), `color`·`C_MUTED`는 `render_frame`(67)이 이미 쓰는 이름이다.

- [ ] **Step 4: GREEN + 전수 확인**

Run: `cargo test -p handicap-tui 2>&1; echo exit=$?` → exit=0.
전수 확인(보고에 출력 첨부): `awk '/fn draw_sub_screen/,/^    }$/' crates/tui/src/app.rs | grep -n 'return;'` → 0건(전부 `return false;`/`return true;`), `draw_values`·`draw_edit`도 같은 방식으로. `grep -n 'fn draw_sub_screen\|fn draw_values\|fn draw_edit' crates/tui/src/app.rs`의 세 시그니처가 `-> bool`.

- [ ] **Step 5: 정상 경로가 `true`를 돌려주는지 전수 확인**

정상 갈래가 `false`를 돌려주면 정상 화면 위에 안내가 덮인다 — 단위 테스트가 못 잡는다(`save_flow_test`는 화면을 그리지 않는다). 두 겹으로 막는다: ① **정적 확인**(보고에 표로): `draw_sub_screen`·`draw_values`·`draw_edit`에서 `render_errors`·`render_record`·`render_body`·`render_values`·`render_edit_menu`(2곳)·`render_list_with_form`·`render_vars`(2곳)를 부르는 **9곳 각각**에 대해 그 호출 뒤 그 갈래가 `true`로 끝나는 줄 번호를 적는다(`grep -n 'render_errors(\|render_record(\|render_body(\|render_values(\|render_edit_menu(\|render_list_with_form(\|render_vars(' crates/tui/src/app.rs`). ② **라이브**(마무리 단계 — spec §7 "US3(정상 경로)" 행): 하위 화면 8종을 한 번씩 열어 `SUB_MISSING` 글자가 **없음**을 확인.

- [ ] **Step 6: 커밋**

`git add crates/tui/src/text.rs crates/tui/src/view/inspect.rs crates/tui/src/app.rs crates/tui/tests/inspect_test.rs crates/tui/tests/app_test.rs` → staged 확인 → 커밋(FOREGROUND 600000ms) → `git log -1 --oneline`.
메시지 제목: `feat(tui): 칸·상태를 못 찾은 하위 화면에 안내 — 빈 화면 대신`

---

### Task 4: 상위 문서 개정

**Spec:** §5. 문서만(`crates/` 무접촉 — pre-commit cargo 건너뜀).

**Files:**
- Modify: `docs/superpowers/specs/2026-11-11-tui-2b-add-from-response-design.md` — §2.4 "숫자 글자" 불릿(110), §3.2(162~), §10 "아주 크거나 작은 소수" 줄(312)
- Modify: `docs/dev/tui-monitor.md` §4-3(조건 칸 설명 — `grep -n '4-3' docs/dev/tui-monitor.md`)
- Modify: `crates/tui/CLAUDE.md` — 새 함정 1줄(아래)

- [ ] **Step 1**: tui-2b 설계 §2.4 불릿을 "숫자 글자는 [tui-2b-polish 설계](2026-11-11-tui-2b-polish-design.md) §2.1 — `serde_json`이 읽은 값에 JavaScript `String(number)` 표기 규칙"으로 바꾸고, 옛 문장(가장 짧은 십진 표기·GUI와 글자가 다를 수 있는 값)은 지운다. §3.2에 "`대상`이 길면 여러 줄(tui-2b-polish §2.2)" 한 줄. §10의 "아주 크거나 작은 소수" 줄에 취소선 + `→ tui-2b-polish로 해소`.
- [ ] **Step 2**: `docs/dev/tui-monitor.md` §4-3의 조건 칸 설명에 운영자 문장 한 줄: 대상이 길면 여러 줄로 이어지고, 화면이 낮아 다 못 보이면 `…`로 끝난다. 아주 크거나 작은 수는 `1e+300`처럼 줄여 채운다.
- [ ] **Step 3**: `crates/tui/CLAUDE.md` 끝에 1줄 — `- **\`serde_json\`은 \`float_roundtrip\` 없이 일부 소수를 한 끝자리 다르게 읽는다(\`1.5e-300\`·\`972.0979928970337\`) — 숫자 글자의 기준은 본문 글자가 아니라 serde가 읽은 값, GUI 글자와 비교하는 테스트는 정확히 읽는 값으로** (tui-2b-polish): 서버 판정도 그 값으로 한다(roadmap 새 §B의 선재 버그).`
- [ ] **Step 4**: 커밋 — `docs(tui): tui-2b-polish — 상위 설계·매뉴얼·함정 개정`.

---

## 마무리 (plan task 밖 — 슬라이스 파이프라인 4~6단계)

- **최종 리뷰**: `handicap-reviewer`(BASE = Task 1 직전 커밋). 초점: Review Focus 6항 + "옛 숫자 글자에 기대던 소비자"(`grep -rn 'PickValue::Number' crates/tui`).
- **보안 게이트**: `finish-slice` §0 grep을 직접 돌린다 + working-rules §3("값을 새 sink로 옮기는가").
- **라이브 검증**: spec §7 표 전부(tmux — `crates/tui/CLAUDE.md` 라이브 함정). US3의 대체 화면 자체는 라이브 없음(사용자 승인) — 대신 "US3(정상 경로)" 행으로 하위 화면 8종에 안내가 **안** 뜨는 것을 본다(환경 변수 화면 13번은 환경이 붙은 칸에서만 열린다 — 라이브 보드에 그런 칸을 하나 둔다). 모니터 화면 무변경 근거를 build-log에.
- **마무리 기록**(`/finish-slice`): build-log 단락 · roadmap §B52 (2) 해소 3줄 취소선 · **새 §B 블록**(번호 = `grep -n '^### B' docs/roadmap.md` 마지막 + 1 — 머리에 로컬(맥) ff-merge 절차[선례 §B52 (0)], "선재 버그: `serde_json` 소수 읽기 → GUI에서 만든 `=`·`≠`·`∈` 숫자 조건 오판정"[spec §9 첫 항목 — 해소 경로 `float_roundtrip` 별도 슬라이스], 사용자 결정 줄[2026-11-11: B 묶음·빈 화면 포함·US3 단위 테스트만]) · 현황판 · 루트 상태 줄 · spec 상태 줄. cloud는 master에 합치지 않는다 — 지정 브랜치 push까지.

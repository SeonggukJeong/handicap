# tui-2b-width-number Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TUI의 표시 폭 재기를 ratatui가 그리는 폭 하나로 통일하고(US1), 낮은 화면의 선택 창·대체 화면을 보완하고(US2·US3), 조건 칸이 프레임마다 대상 전체를 훑지 않게 하고, 모니터의 숫자 글자를 컨트롤러 한 곳에서 GUI `String(v)`와 같게 만든다(US4·US5).

**Architecture:**
- 숫자 글자(묶음 C): 컨트롤러 `monitor::number`(새 파일)에 `float_text`·`number_text`. 서버 판정(`monitor/check.rs`)의 두 곳과 TUI `pick::number_text`가 그것을 쓴다. 기대 글자는 node `String(v)`로 만든 골든 픽스처(`testdata/number_text_golden.json`)가 지킨다.
- 폭 재기(묶음 B): `crates/tui/src/view/mod.rs`에 글자 묶음과 칸 수를 내는 `cells` 하나. `text_width`·`fit`·`wrap_width`·`values::fit_head`가 그것만 쓴다. `edit::wrap_measured` 삭제.
- 낮은 화면: 선택 창 높이 규칙을 `view/settings.rs`의 순수 도우미로 빼고, 값 목록 화면이 제목 줄 자리에 머리 한 줄을 그린다. 대체 화면은 잘리면 `…`. 조건 칸 `target_rows`는 줄 수 상한을 받는다.

**Tech Stack:** Rust(controller·tui, ratatui 0.30.2, `unicode-segmentation` 1.x, `serde_json` 1.0.150 `float_roundtrip`) · node(픽스처 생성 1회).

REVIEW-GATE: PENDING

**Spec:** `docs/superpowers/specs/2026-11-12-tui-2b-width-number-design.md` (APPROVED — 리뷰 2라운드). 구현자는 자기 task가 가리키는 spec 절을 함께 읽는다. US 블록은 spec 앞머리 `사용자 스토리 (US)`.

## Global Constraints

- **0-diff**: `crates/engine`·`crates/proto`·`crates/worker`·`crates/worker-core`·`ui/`·`desktop/`·`deploy/`. 확인: `git diff --stat <base>..HEAD -- crates/engine crates/proto crates/worker crates/worker-core ui desktop deploy`가 비어 있다(`<base>` = 이 plan을 실은 커밋).
- 와이어(REST·proto)·DB·보드 파일 모양 무변경. 바뀌는 것은 숫자 글자와 화면 줄뿐이다.
- 이 저장소는 **cloud 세션**에서 구현한다: `cargo-nextest` 없음 → 테스트는 `cargo test`. `pnpm build`는 메모리 부족으로 세션을 죽인다 — `ui/`를 건드리지 않으므로 돌리지 않는다. 디스크가 빠듯하다 — `CARGO_TARGET_DIR`를 따로 만들지 말고 workspace `target/`만 쓴다.
- 커밋: 단일 FOREGROUND 호출(timeout 600000ms), `| tail`·`| head` 금지, 판정은 `; echo exit=$?`, 뒤에 `git log -1 --oneline`으로 확인. `--no-verify` 금지. pre-commit이 workspace 전체 `fmt --check`·build·clippy `-D warnings`·`cargo test --workspace`를 돈다(수 분) — 그동안 다른 `cargo` 금지.
- 커밋 메시지 끝 두 줄(그대로): `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_019DFYqLn2pR43LWdZdgqf2b` — 구현 subagent는 자기 harness가 지정한 귀속 줄을 쓴다.
- `tdd-guard`: `crates/*/src`를 고치기 전에 테스트 변경이 먼저 있어야 한다(`crates/<x>/tests/*.rs` 수정, 또는 그 src 파일에 `#[cfg(test)]`가 이미 있거나 이번 편집이 넣음). 각 task의 Step 순서가 그 순서다 — 바꾸지 않는다.
- 이 plan의 줄번호는 참고다. 고치기 전에 `grep -n`으로 다시 찾는다.
- Write/Edit 도구가 `\u{…}` 꼴이 아닌 이스케이프를 실제 글자로 바꿀 수 있다 — 테스트의 특수 글자는 **Rust 이스케이프(`"\u{2764}\u{FE0F}"`)로만** 적는다. 커밋 전 금지 글자(제어·방향 제어) 확인: `git diff --cached | grep '^+' | python3 -I -c "import sys;s=sys.stdin.read();print([hex(ord(c)) for c in s if (ord(c)<0x20 and c not in '\n\t') or 0x7f<=ord(c)<=0x9f or ord(c) in (0x61c,0x200e,0x200f,0x2028,0x2029) or 0x202a<=ord(c)<=0x202e or 0x2066<=ord(c)<=0x2069])"` → `[]`.
- 리포트는 `.superpowers/sdd/`에만 쓴다. 저장소 루트에 `.md`를 만들거나 `git add`하지 않는다.
- 기존 테스트가 RED가 되면 기대값을 바로 고치지 않는다. 이 plan이 "고친다"고 적은 테스트(Task 4의 2개)만 고치고, 그 밖은 STOP → 왜 깨졌는지 보고한다.

## Review Focus

- **Task 1**(판정 글자 — path-gate, code-quality는 Opus): `=`·`≠`·`∈`·크기 비교 결과가 전후 같은가, `포함`만 바뀌는가(spec §2.5-6). 가림 경로(인증 헤더·비밀 이름)가 숫자 글자 변경과 무관한가. 골든 픽스처가 공허하지 않은가(임시 본문에서 RED 실증).
- **Task 3**(폭 재기): 불변식 테스트가 `Buffer::set_stringn`의 실제 칸 수와 대조하는가, 회귀 실증 2건(옛 `text_width`·옛 `wrap_width`)을 했는가, 입력줄 코드(`input.rs`·`settings.rs` `col_w`·`window`)를 건드리지 않았는가, 속도 전후 수치.
- **Task 4**: "머리가 보이면 안내도 보인다"(tui-2b-secrets §2.4)가 모든 폭·높이에서 유지되는가.
- **Task 5**: 상한을 건 결과가 화면에 보이는 줄에서 전과 같은가.

---

### Task 1: 컨트롤러 숫자 글자 + 골든 픽스처 + 판정 글자 (US4)

spec §2.5-1·-2·-3·-4·-6, §6 "숫자 글자".

**Files:**
- Create: `testdata/number_text_golden.mjs`, `testdata/number_text_golden.json`, `crates/controller/tests/monitor_number_test.rs`, `crates/controller/src/monitor/number.rs`
- Modify: `crates/controller/src/monitor/mod.rs`(`pub mod number;`), `crates/controller/src/monitor/check.rs`

- [ ] **Step 1: 픽스처 생성 스크립트**. `testdata/number_text_golden.mjs`를 아래 내용 그대로 만든다.

```js
// 모니터 숫자 글자 골든 픽스처 — JavaScript `String(number)`(V8)의 글자.
// 만들기: node testdata/number_text_golden.mjs > testdata/number_text_golden.json
// 읽는 곳: crates/controller/src/monitor/number.rs 테스트(`float_text`가 같은 글자를 내는지).
// 줄 모양: ["f64 비트(16진 16자)", "기대 글자"]. 난수는 고정 씨앗이라 다시 만들어도 같은 파일이다.
let s = 0x9e3779b97f4a7c15n;
const M = (1n << 64n) - 1n;
const next = () => {
  s ^= s >> 12n;
  s ^= (s << 25n) & M;
  s ^= s >> 27n;
  return (s * 0x2545f4914f6cdd1dn) & M;
};
const view = new DataView(new ArrayBuffer(8));
const rows = [];
const seen = new Set();
const pushBits = (bits) => {
  view.setBigUint64(0, bits);
  const v = view.getFloat64(0);
  if (!Number.isFinite(v)) return;
  const hex = bits.toString(16).padStart(16, "0");
  if (seen.has(hex)) return;
  seen.add(hex);
  rows.push([hex, String(v)]);
};
const pushNum = (v) => {
  view.setFloat64(0, v);
  pushBits(view.getBigUint64(0));
};
// 1) 경계값 — 표기 갈래가 바뀌는 자리와 양 끝.
for (const v of [
  0, -0, 1, -1, 100, 0.5, 0.1, 0.3, 1 / 3, -1.5, 100.25, 1e5, 123456.789,
  1e20, 1e21, 1e22, 123456789012345680000, 999999999999999900000, -1e21,
  1e-6, 1e-7, 1.5e-7, 0.000001234, -1e-7, 1.5e-6,
  2 ** 53, 2 ** 53 + 2, 2 ** 63, 2 ** 64, 1e300, 2.5e-300, 1.5e-300, 4.5e250,
  972.0979928970337, 1658206780088562.3, 5e-324, 2.2250738585072014e-308,
  1.7976931348623157e308, -1.7976931348623157e308,
]) pushNum(v);
// 2) 임의 비트 500.
for (let i = 0; i < 500; i++) pushBits(next());
// 3) 동률 구간 500 — 2^50~2^51은 간격이 0.25라 x.25·x.75에서 가장 짧은 자릿수가 둘이고 값이 그 가운데다.
for (let i = 0; i < 500; i++) {
  const k = 2 ** 50 + Number(next() % (1n << 50n));
  pushNum(k + (i % 2 === 0 ? 0.25 : 0.75));
}
// 4) 짧은 소수 300 — 사람이 적는 값(자릿수 8 이하 × 10^-30..29).
for (let i = 0; i < 300; i++) {
  const e = Number(next() % 60n) - 30;
  pushNum(Number(`${next() % 100000000n}e${e}`));
}
process.stdout.write("[\n" + rows.map((r) => JSON.stringify(r)).join(",\n") + "\n]\n");
```

- [ ] **Step 2: 픽스처 만들기**. `node testdata/number_text_golden.mjs > testdata/number_text_golden.json`. 확인: `wc -l testdata/number_text_golden.json` → 1341(줄 1,339 + 대괄호 2), `sha256sum` → `2aec5569815016a5c30ed38e4129329dd16d6ec241851766f95630d2c68c824d`(설계 시점 node v22 실측 — 다르면 STOP, 스크립트를 글자 그대로 옮겼는지 본다). 한 번 더 만들어 `cmp`로 같은지 본다.

- [ ] **Step 3: 테스트 + 임시 본문(RED)**. **먼저** 통합 테스트 파일 `crates/controller/tests/monitor_number_test.rs`를 아래 내용으로 만든다(`monitor/mod.rs`에는 `#[cfg(test)]`가 없어서, `tests/` 아래의 새 테스트 파일이 있어야 tdd-guard가 `mod.rs` 편집을 통과시킨다). 그다음 `crates/controller/src/monitor/number.rs`를 만들되 `number_text`는 Step 4의 것 그대로, `float_text`의 본문만 일단 옛 표기(`serde_json::Number::from_f64(v).map_or_else(|| v.to_string(), |n| n.to_string())`)로 둔다. `monitor/mod.rs`에 `pub mod number;`(알파벳 순서 — `config`와 `record` 사이).

```rust
//! 모니터 숫자 글자(`monitor::number`) — node `String(v)`로 만든 골든 픽스처와 대조
//! (spec `2026-11-12-tui-2b-width-number-design.md` §2.5·§6).

use handicap_controller::monitor::number::{float_text, number_text};

const GOLDEN: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../testdata/number_text_golden.json"
));

fn golden() -> Vec<(u64, String)> {
    let rows: Vec<(String, String)> = serde_json::from_str(GOLDEN).unwrap();
    rows.into_iter()
        .map(|(hex, want)| (u64::from_str_radix(&hex, 16).unwrap(), want))
        .collect()
}

#[test]
fn float_text_matches_javascript_string() {
    let rows = golden();
    assert!(rows.len() >= 1300, "픽스처가 비었다: {}", rows.len());
    for (bits, want) in rows {
        let v = f64::from_bits(bits);
        assert_eq!(float_text(v), want, "bits {bits:016x}");
    }
}

#[test]
fn float_text_reads_back_as_same_value() {
    for (bits, want) in golden() {
        let v = f64::from_bits(bits);
        if v == 0.0 {
            continue;
        }
        let back: f64 = want.parse().unwrap();
        assert_eq!(back.to_bits(), bits, "{want}");
    }
}

#[test]
fn number_text_keeps_integers_and_rewrites_floats() {
    let n = |lit: &str| number_text(&serde_json::from_str::<serde_json::Number>(lit).unwrap());
    // 정수로 읽힌 값은 본문 글자 그대로(2^53 넘는 값도).
    assert_eq!(n("12345678901234567890"), "12345678901234567890");
    assert_eq!(n("9007199254740993"), "9007199254740993");
    assert_eq!(n("-5"), "-5");
    // u64를 넘는 정수 꼴은 소수로 읽힌다 → JavaScript 표기.
    assert_eq!(n("18446744073709551616"), "18446744073709552000");
    // spec §2.5-4.
    assert_eq!(n("1.0"), "1");
    assert_eq!(n("1E5"), "100000");
    assert_eq!(n("1e16"), "10000000000000000");
    assert_eq!(n("1.2345678901234568e20"), "123456789012345680000");
    assert_eq!(n("0.000001"), "0.000001");
    assert_eq!(n("1e-7"), "1e-7");
    assert_eq!(n("1e21"), "1e+21");
    assert_eq!(n("-0.0"), "0");
    assert_eq!(n("100.25"), "100.25");
    assert_eq!(n("1658206780088562.3"), "1658206780088562.2");
}

#[test]
fn float_text_non_finite_does_not_panic() {
    assert_eq!(float_text(f64::NAN), "NaN");
    assert_eq!(float_text(f64::INFINITY), "inf");
    assert_eq!(float_text(f64::NEG_INFINITY), "-inf");
}
```

  실행: `cargo test -p handicap-controller --test monitor_number_test`. 기대: `float_text_matches_javascript_string`·`number_text_keeps_integers_and_rewrites_floats` **RED**(임시 본문이 `1.0`·`1e-6` 꼴을 낸다), 나머지 둘 GREEN. RED가 아니면 STOP(픽스처가 공허하다).

- [ ] **Step 4: `number.rs` 구현(GREEN)**. 본문을 아래로 바꾼다(설계 시점에 scratch에서 clippy `-D warnings` 통과 + node `String(v)`와 499,853개 값 일치 확인).

```rust
//! 모니터가 숫자를 글자로 바꾸는 한 곳 — JavaScript `String(number)`와 같은 글자
//! (spec `2026-11-12-tui-2b-width-number-design.md` §2.5). 서버 판정(`check.rs`)과 TUI 값 고르기가 같이 쓴다.

/// 정수로 읽힌 값(`i64`·`u64`)은 본문 글자 그대로, 그 밖은 [`float_text`].
pub fn number_text(n: &serde_json::Number) -> String {
    if n.is_i64() || n.is_u64() {
        return n.to_string();
    }
    match n.as_f64() {
        Some(v) => float_text(v),
        None => n.to_string(),
    }
}

/// 유한한 `f64` → JavaScript `String(number)`의 글자. 0·−0은 `0`. `NaN`·무한대는 Rust 표기 그대로
/// (JSON 본문에서는 나오지 않는다).
pub fn float_text(v: f64) -> String {
    if v == 0.0 {
        return "0".to_string();
    }
    let Some(n) = serde_json::Number::from_f64(v) else {
        return v.to_string();
    };
    let raw = n.to_string();
    js_notation(&raw).unwrap_or(raw)
}

/// `serde_json`의 소수 글자(`-1.25e+20`·`1e-6`·`100000.0` — 가장 짧은 왕복 자릿수)를 자릿수 열과
/// 십진 지수로 읽어 JavaScript 표기로 다시 적는다. 모양을 못 읽으면 `None`(호출 쪽이 원래 글자를 쓴다).
fn js_notation(raw: &str) -> Option<String> {
    let (neg, body) = match raw.strip_prefix('-') {
        Some(b) => (true, b),
        None => (false, raw),
    };
    let (mant, exp) = match body.split_once(['e', 'E']) {
        Some((m, e)) => (m, e.strip_prefix('+').unwrap_or(e).parse::<i64>().ok()?),
        None => (body, 0),
    };
    let (int_part, frac_part) = mant.split_once('.').unwrap_or((mant, ""));
    let all_digits = int_part
        .bytes()
        .chain(frac_part.bytes())
        .all(|b| b.is_ascii_digit());
    if int_part.is_empty() || !all_digits {
        return None;
    }
    let all = format!("{int_part}{frac_part}");
    let lead = all.len() - all.trim_start_matches('0').len();
    let digits = all.trim_start_matches('0').trim_end_matches('0');
    if digits.is_empty() {
        return Some("0".to_string());
    }
    // 값 = 0.{digits} × 10^n, 자릿수 k개.
    let n = i64::try_from(int_part.len()).ok()? - i64::try_from(lead).ok()? + exp;
    let k = i64::try_from(digits.len()).ok()?;
    let zeros = |c: i64| "0".repeat(usize::try_from(c).unwrap_or(0));
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    if (k..=21).contains(&n) {
        out.push_str(digits);
        out.push_str(&zeros(n - k));
    } else if (1..=21).contains(&n) {
        let (a, b) = digits.split_at(usize::try_from(n).ok()?);
        out.push_str(a);
        out.push('.');
        out.push_str(b);
    } else if (-5..=0).contains(&n) {
        out.push_str("0.");
        out.push_str(&zeros(-n));
        out.push_str(digits);
    } else {
        let e = n - 1;
        let (a, b) = digits.split_at(1);
        out.push_str(a);
        if !b.is_empty() {
            out.push('.');
            out.push_str(b);
        }
        out.push('e');
        out.push(if e < 0 { '-' } else { '+' });
        out.push_str(&e.abs().to_string());
    }
    Some(out)
}
```

  실행: `cargo test -p handicap-controller --test monitor_number_test` → 4개 GREEN.

- [ ] **Step 5: `check.rs` 테스트(RED)**. `check.rs`의 `#[cfg(test)] mod tests`(`cond_float_exact_read` 근처 — `grep -n 'fn cond_float_exact_read' crates/controller/src/monitor/check.rs`)에 추가. 조건 테스트의 도우미 `t_body`·`judge_c`·`one_step`·`cond`는 그 모듈에 있다. 표시 값 도우미 `ditem`·`dpanel`은 `display_values_table`이 있는 테스트 모듈에 있다(`grep -n 'fn ditem\|fn dpanel\|fn display_values_table' crates/controller/src/monitor/check.rs`) — 표시 값 테스트 둘은 그쪽에 넣는다.
  - `cond_number_text_is_js_notation`: 본문 `{"v":1.0}`·`{"v":1E5}`·`{"v":1e16}`·`{"v":0.000001}`·`{"v":-0.0}`·`{"v":12345678901234567890}`마다 `≠ <본문 글자>` 조건을 건다 → `Verdict::Fail`이고 `reason`이 차례로 `1`·`100000`·`10000000000000000`·`0.000001`·`0`·`12345678901234567890`.
  - `cond_number_ops_unchanged_by_notation`: 본문 `{"v":1.0}`에 `= 1`·`= 1.0`·`∈ 1, 2`·`≥ 1`·`≤ 1.0`·`값 있음`(`Op::NotEmpty`)·`키 있음`(`Op::Exists`)이 전부 `Verdict::Ok`, `≠ 1.0`은 `Fail`. 본문 `{"v":1e16}`에 `= 10000000000000000`·`= 1e16`·`> 9000000000000000` 전부 `Ok`.
  - `cond_contains_sees_new_number_text`: 본문 `{"v":1.0}`에 `포함 ".0"`(`Op::Contains`, 값 `.0`) → `Fail`(spec §2.5-6 — 판정이 바뀌는 유일한 갈래), `포함 "1"` → `Ok`. 본문 `{"v":1e16}`에 `포함 "e+"` → `Fail`, `포함 "0000"` → `Ok`.
  - `display_number_text_is_js_notation`: `display_values`로 본문 `{"a":1.0,"b":1e16,"c":0.000001,"d":100.25,"e":12345678901234567890}`의 `$.a`..`$.e` → `1`·`10000000000000000`·`0.000001`·`100.25`·`12345678901234567890`(표시 값은 칸당 2개까지면 패널을 나눠 호출).
  - `non_number_values_keep_engine_text`: 본문 `{"s":"1.0","arr":[1.0,2],"o":{"k":1.0},"t":true,"n":null}` — `$.s` 표시 값 `1.0`(문자열은 그대로), `$.arr` → `[1.0,2]`, `$.o` → `{"k":1.0}`(배열·객체 안쪽은 그대로 — spec §9), `$.t` → `true`.

  실행: `cargo test -p handicap-controller --lib monitor::check`. 기대: `cond_number_text_is_js_notation`·`cond_contains_sees_new_number_text`·`display_number_text_is_js_notation` **RED**, `cond_number_ops_unchanged_by_notation`·`non_number_values_keep_engine_text` GREEN(전후 같아야 하는 것들 — 지금 GREEN임을 확인해 둔다).

- [ ] **Step 6: `check.rs` 배선(GREEN)**. `stringify` 호출 두 곳(`grep -n 'stringify(&v)' crates/controller/src/monitor/check.rs` → `text: stringify(&v),`와 `shown(&stringify(&v))`)을 새 비공개 도우미로 바꾼다.

```rust
/// 받은 값의 글자 — 숫자는 `monitor::number`(GUI `String(v)`와 같은 글자), 그 밖은 엔진 `stringify`.
fn value_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Number(n) => super::number::number_text(n),
        other => stringify(other),
    }
}
```

  실행: `cargo test -p handicap-controller --lib monitor` → 전부 GREEN. 그다음 `cargo test -p handicap-controller`·`cargo test -p handicap-tui`(TUI의 서버 연동 테스트가 옛 글자를 단언하면 여기서 드러난다 — 드러나면 STOP·보고).

- [ ] **Step 7: 게이트 + 커밋**. `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings; echo exit=$?`. `git add testdata/number_text_golden.mjs testdata/number_text_golden.json crates/controller/tests/monitor_number_test.rs crates/controller/src/monitor/number.rs crates/controller/src/monitor/mod.rs crates/controller/src/monitor/check.rs` → `git diff --cached --name-only`로 6개 확인 → 커밋 `feat(controller): 모니터 숫자 글자를 한 곳에서 — GUI String(v)와 같은 표기 (tui-2b-width-number §2.5)`.

---

### Task 2: TUI 숫자 글자가 컨트롤러 함수를 쓴다 (US5)

spec §2.5-3·-5, §6 "숫자 글자"의 TUI 줄.

**Files:**
- Modify: `crates/tui/tests/pick_test.rs`, `crates/tui/src/pick.rs`

- [ ] **Step 1: 테스트(RED)**. `crates/tui/tests/pick_test.rs`의 `EXACT` 표(`grep -n 'const EXACT' crates/tui/tests/pick_test.rs`)에 행을 추가한다 — `("1658206780088562.3", "1658206780088562.2")`·`("1130439128653781.25", "1130439128653781.2")`·`("1486072376365191.75", "1486072376365191.8")`·`("1e16", "10000000000000000")`. 그리고 새 테스트 `number_text_same_as_server`: `EXACT`의 모든 행에서 `number_of(lit).0` == `handicap_controller::monitor::number::number_text(&serde_json::from_str::<serde_json::Number>(lit).unwrap())`.
  실행: `cargo test -p handicap-tui --test pick_test number_text`. 기대: `number_text_tables`가 `1658206780088562.3`·`1130439128653781.25` 행에서 **RED**(지금 TUI는 `…562.3`·`…781.3`), `number_text_same_as_server`도 같은 행에서 RED. `…191.75` 행과 `1e16` 행은 전후 GREEN(대조군).
- [ ] **Step 2: 구현(GREEN)**. `crates/tui/src/pick.rs`의 `number_text`(`grep -n 'pub fn number_text' crates/tui/src/pick.rs`) 본문을 `handicap_controller::monitor::number::float_text(v)` 호출 한 줄로 바꾼다. 문서 주석은 "컨트롤러 `monitor::number::float_text` — 서버 판정·표시 값과 같은 글자(spec tui-2b-width-number §2.5)"로. `Node`의 숫자 글자 주석(`grep -n '숫자 글자' crates/tui/src/pick.rs`)도 맞춘다. `visit_u64`·`visit_i64`는 그대로.
  실행: `cargo test -p handicap-tui --test pick_test` → 전부 GREEN(`number_text_is_short`·`number_text_reads_back_as_server_value` 포함).
- [ ] **Step 3: 게이트 + 커밋**. `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings; echo exit=$?`, `cargo test -p handicap-tui`. 커밋 `feat(tui): 숫자 글자를 컨트롤러 함수로 — 반올림 동률 끝자리가 GUI와 같다 (tui-2b-width-number §2.5)`.

---

### Task 3: 폭 재기 통일 (US1)

spec §2.1 전체, §6 "폭 재기".

**Files:**
- Modify: `crates/tui/Cargo.toml`, `Cargo.lock`(자동), `crates/tui/src/view/mod.rs`, `crates/tui/src/view/values.rs`, `crates/tui/src/view/edit.rs`, `crates/tui/tests/values_view_test.rs`, `crates/tui/tests/inspect_test.rs`
- 건드리지 않는다: `crates/tui/src/input.rs`, `view/settings.rs`의 `col_w`·`window`(입력줄 — spec §9).

- [ ] **Step 1: 의존 선언**. `crates/tui/Cargo.toml` `[dependencies]`의 `ratatui = "0.30"` 아래에 `unicode-segmentation = "1"`. `cargo build -p handicap-tui` → `git diff Cargo.lock`이 `handicap-tui`의 의존 목록에 `"unicode-segmentation",` 한 줄만 더하는지 확인(새 `[[package]]`가 생기면 STOP).
- [ ] **Step 2: 소비처 렌더 테스트(일부 RED)** — `crates/tui/tests/`.
  - `values_view_test.rs` `value_column_aligned_for_odd_width_targets`: 줄 3개 — 대상 `"\u{644}\u{627}key"`(람-알레프)·`"\u{FF76}\u{FF9E}key"`(반각 가타카나+탁점)·`"plain"`, 받은 값은 서로 다른 ASCII(`v1`·`v2`·`v3`). 80×14로 그려 **버퍼 칸 좌표로** 각 줄에서 받은 값 첫 글자 칸의 x를 구해 셋이 같은지 단언(줄 문자열 인덱스가 아니라 `buf[(x, y)].symbol()`을 훑는다 — 넓은 글자의 둘째 칸은 공백이다, `crates/tui/CLAUDE.md`). 기대: 지금 **RED**(옛 `text_width`는 람-알레프를 1칸·반각 탁점을 2칸으로 잰다 — 그린 칸은 2·3).
  - `values_view_test.rs` `long_target_with_emoji_keeps_column`: 대상 `format!("data.{}\u{2764}\u{FE0F}.leaf", "a".repeat(300))`와 `"short"` 두 줄 — 받은 값 열 x가 같고 첫 줄이 `▶ …`로 시작. 폭 60..=100 스윕. 기대: 지금 일부 폭에서 RED(옛 `fit_head`는 `❤️`를 1칸으로 센다).
  - `values_view_test.rs` `choice_head_rows_fit_width`: 선택 창 머리가 `format!("{}\u{2764}\u{FE0F}{}", "a".repeat(n), "b".repeat(40))`(n = 60..=80)일 때 80×14로 그려, 머리 줄들(앞 공백 2칸을 떼고 `trim_end`)을 이어 붙이면 원문과 같고 `…`가 없다. 기대: 지금 일부 n에서 RED(줄이 1칸 넘쳐 끝 글자가 잘린다).
  - `inspect_test.rs` `body_lines_fit_width_with_emoji`: `handicap_tui::inspect::body_lines`(공개 — `grep -n 'pub fn body_lines' crates/tui/src/inspect.rs`)에 본문 `{"k":"<❤️ 40개>"}`를 넣고 폭 20..=40에서 각 `BodyLine.text`를 `ratatui::buffer::Buffer::set_stringn`으로 그린 칸 수가 폭 이하. 기대: 지금 RED.
  실행: `cargo test -p handicap-tui --test values_view_test --test inspect_test`. RED/GREEN을 테스트별로 적어 둔다. 넷 다 GREEN이면 STOP(테스트가 공허하다).
- [ ] **Step 3: 불변식 테스트 + 속도 기준선** — `crates/tui/src/view/mod.rs` 끝에 아래 인라인 테스트 모듈을 넣는다(이 편집이 `#[cfg(test)]`를 넣으므로 tdd-guard를 통과한다). 옛 구현에 대고 돈다.

```rust
#[cfg(test)]
mod tests {
    use super::values::fit_head;
    use super::*;
    use unicode_segmentation::UnicodeSegmentation;
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;
    use ratatui::style::Style;

    /// ratatui가 실제로 쓰는 칸 수.
    fn drawn(s: &str) -> usize {
        let mut buf = Buffer::empty(Rect::new(0, 0, 200, 1));
        usize::from(buf.set_stringn(0, 0, s, usize::MAX, Style::default()).0)
    }

    const POOL: &[&str] = &[
        "a",
        "한",
        "\u{2764}\u{FE0F}",
        "\u{2764}",
        "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}",
        "\u{1F44D}\u{1F3FD}",
        "e\u{301}",
        "\u{644}\u{627}",
        "\u{1F1F0}\u{1F1F7}",
        "\u{FF76}\u{FF9E}",
        "1\u{FE0F}\u{20E3}",
        "\u{FFFD}",
        "\u{1112}\u{1161}\u{11AB}",
    ];

    fn samples() -> Vec<String> {
        let mut v = Vec::new();
        for a in POOL {
            v.push((*a).to_string());
            for b in POOL {
                v.push(format!("{a}{b}"));
                for c in POOL {
                    v.push(format!("{a}{b}{c}"));
                }
            }
        }
        v
    }

    #[test]
    fn width_is_what_ratatui_draws() {
        for s in samples() {
            assert_eq!(text_width(&s), drawn(&s), "{s:?}");
        }
    }

    #[test]
    fn fit_and_fit_head_stay_within_width() {
        for s in samples() {
            for w in 0..=12 {
                assert!(drawn(&fit(&s, w)) <= w, "fit {s:?} w{w}");
                assert!(drawn(&fit_head(&s, w)) <= w, "fit_head {s:?} w{w}");
                if text_width(&s) <= w {
                    assert_eq!(fit(&s, w), s);
                    assert_eq!(fit_head(&s, w), s);
                } else if w > 0 {
                    assert!(fit(&s, w).ends_with('…'), "fit {s:?} w{w}");
                    assert!(fit_head(&s, w).starts_with('…'), "fit_head {s:?} w{w}");
                }
            }
        }
    }

    #[test]
    fn wrap_rows_fit_and_join_back() {
        for s in samples() {
            for w in 1..=12 {
                let rows = wrap_width(&s, w);
                assert_eq!(rows.concat(), s, "{s:?} w{w}");
                for r in &rows {
                    let single = r.graphemes(true).filter(|g| drawn(g) > 0).count() <= 1;
                    assert!(drawn(r) <= w || single, "{s:?} w{w} row {r:?}");
                }
            }
        }
        assert_eq!(wrap_width("", 5), vec![String::new()]);
        assert_eq!(wrap_width("ab", 0), vec!["a".to_string(), "b".to_string()]);
    }
}
```

  같은 모듈에 속도 테스트도 넣는다.

```rust
    /// 속도 기준선·확인(spec §2.1-10) — `cargo test -p handicap-tui --release --lib perf_width -- --ignored --nocapture`.
    #[test]
    #[ignore = "수동 측정"]
    fn perf_width() {
        let unit = "abc 한글 \u{2764}\u{FE0F} {\"key\": 12345.678} ";
        let s = unit.repeat(1024 * 1024 / unit.len());
        let t = std::time::Instant::now();
        let rows = wrap_width(&s, 80);
        let wrap = t.elapsed();
        let t = std::time::Instant::now();
        let mut n = 0;
        for _ in 0..10 {
            n += text_width(&s);
        }
        let width = t.elapsed();
        let t = std::time::Instant::now();
        let mut m = 0;
        for r in rows.iter().take(30_000) {
            m += fit(r, 40).len() + text_width(r);
        }
        let per_row = t.elapsed();
        println!("perf_width wrap={wrap:?} text_width_x10={width:?} rows={} per_row={per_row:?} ({n} {m})", rows.len());
    }
```

  실행 1: `cargo test -p handicap-tui --lib view::tests`. 기대(옛 구현): `width_is_what_ratatui_draws` **RED**(람-알레프·반각 탁점), `wrap_rows_fit_and_join_back` **RED**(`❤️`), `fit_and_fit_head_stay_within_width` **RED**.
  실행 2: `cargo test -p handicap-tui --release --lib perf_width -- --ignored --nocapture` → **옛 구현의 세 수치를 리포트에 적는다**(기준선).
- [ ] **Step 4: 구현(GREEN)**.
  - `view/mod.rs`: `text_width`·`fit`·`wrap_width`를 아래로 바꾸고 `cells`를 추가한다. `use ratatui::text::Span;`이 더 안 쓰이면 지운다(`key_bar`·`centered`는 그대로).

```rust
use ratatui::buffer::CellWidth;
use unicode_segmentation::UnicodeSegmentation;

/// 글자 묶음과 그 칸 수 — ratatui `Buffer::set_stringn`과 같은 규칙: 제어 문자가 든 묶음은 0칸(그려지지 않는다),
/// 그 밖은 `CellWidth::cell_width`. 폭을 재거나 자르는 코드는 전부 이것만 쓴다.
pub(crate) fn cells(s: &str) -> impl DoubleEndedIterator<Item = (&str, usize)> {
    s.graphemes(true).map(|g| {
        let w = if g.contains(char::is_control) {
            0
        } else {
            usize::from(g.cell_width())
        };
        (g, w)
    })
}

/// 문자열의 표시 폭(셀 수) — 화면에 그려지는 칸 수와 같다.
pub(crate) fn text_width(s: &str) -> usize {
    cells(s).map(|(_, w)| w).sum()
}

/// 표시 폭 `w`에 맞게 자른다. 잘리면 끝에 `…`(1칸) — 글자 묶음은 쪼개지 않는다.
pub(crate) fn fit(s: &str, w: usize) -> String {
    if text_width(s) <= w {
        return s.to_string();
    }
    if w == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut used = 0;
    for (g, gw) in cells(s) {
        if used + gw > w - 1 {
            break;
        }
        used += gw;
        out.push_str(g);
    }
    out.push('…');
    out
}

/// 표시 폭 `w` 행들로 글자 묶음 단위로 자른다. 폭 0 묶음은 줄을 바꾸지 않는다.
pub(crate) fn wrap_width(s: &str, w: usize) -> Vec<String> {
    let mut rows = Vec::new();
    let mut cur = String::new();
    let mut used = 0;
    for (g, gw) in cells(s) {
        if gw > 0 && used + gw > w && !cur.is_empty() {
            rows.push(std::mem::take(&mut cur));
            used = 0;
        }
        cur.push_str(g);
        used += gw;
    }
    rows.push(cur);
    rows
}
```

  - `view/values.rs` `fit_head`를 아래로(옛 "경계의 폭 0 글자 버리기" 보정 삭제). `use super::{cells, fit, text_width, wrap_width};`로 import.

```rust
/// 넘치면 **앞**을 `…`로 줄인다(끝의 키 이름이 보이게). 글자 묶음은 쪼개지 않는다.
pub fn fit_head(s: &str, w: usize) -> String {
    if text_width(s) <= w {
        return s.to_string();
    }
    if w == 0 {
        return String::new();
    }
    let mut tail: Vec<&str> = Vec::new();
    let mut used = 0;
    for (g, gw) in cells(s).rev() {
        if used + gw > w - 1 {
            break;
        }
        used += gw;
        tail.push(g);
    }
    let mut out = String::from("…");
    out.extend(tail.into_iter().rev());
    out
}
```

  - `view/edit.rs`: `wrap_measured`를 지우고 `target_rows`를 "`fw < TARGET_WRAP_MIN_W`면 한 줄, 아니면 `wrap_width(&s, fw)`"로 줄인다(`text_width(&s) <= fw` 조기 반환과 줄 폭 재검사 삭제 — spec §2.1-7). 주석의 `wrap_measured` 언급도 정리.
  실행: `cargo test -p handicap-tui` 전체 + `TZ=UTC cargo test -p handicap-tui`. Step 2·3의 RED가 전부 GREEN, 기존 테스트 전부 GREEN(`cond_form_target_keeps_text_when_widths_disagree` 등 U+FE0F·ZWJ·피부색 테스트 포함). 기존 테스트가 깨지면 STOP·보고.
- [ ] **Step 5: 회귀 실증**(고의 회귀 → RED → 원복 → GREEN, 결과를 리포트에):
  1. `text_width`를 옛 구현(`Span::raw(s.to_string()).width()`)으로 → `width_is_what_ratatui_draws` RED.
  2. `wrap_width`를 글자 단위(`s.chars()` + 글자 하나 폭)로 → `wrap_rows_fit_and_join_back` RED.
  원복 뒤 `git diff`에 실증 흔적이 없는지 확인.
- [ ] **Step 6: 속도 확인**. `cargo test -p handicap-tui --release --lib perf_width -- --ignored --nocapture` → 새 수치. 세 수치 중 하나라도 기준선의 **1.5배를 넘으면 STOP**(spec §2.1-10). 전후 수치를 리포트에 적는다(설계 시점 scratch 실측 — 새 구현: 1 MiB 줄바꿈 약 19ms, `text_width` 10회 약 144ms).
- [ ] **Step 7: 전수 확인 + 게이트 + 커밋**. `grep -rn 'encode_utf8' crates/tui/src` → `input.rs` 1줄·`view/settings.rs` 1줄(`col_w`)만 남는다. `grep -rn 'wrap_measured' crates/tui` → 0줄. `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings; echo exit=$?`. 커밋 `feat(tui): 폭 재기를 ratatui가 그리는 폭 하나로 — 글자 묶음 단위 (tui-2b-width-number §2.1)`.

---

### Task 4: 낮은 화면의 선택 창 머리 한 줄 (US2)

spec §2.2, §6 "선택 창 머리".

**Files:**
- Modify: `crates/tui/tests/values_view_test.rs`, `crates/tui/src/view/settings.rs`, `crates/tui/src/view/values.rs`

- [ ] **Step 1: 테스트(RED)** — `crates/tui/tests/values_view_test.rs`. 기존 도우미 `fix`·`rv`·`draw`·`choice`·`note_choice`를 쓴다. 본문 높이 = 그린 높이 − 2(`draw(w, h, …)`의 `h`가 터미널 높이).
  - `choice_head_line_at_low_height`: 안내 없는 선택 창(머리 `"hdrmark  =  \"OK\""`), 폭 80, 터미널 높이 3..=9(본문 1..=7 — 높이 10부터는 무입력 안내 줄이 본문을 한 줄 더 가져가 본문 = 높이 − 3이다). 높이마다 (머리 글자 `hdrmark` 보임, 제목 접미 `— 값 고르기` 보임, `▶ status` 보임, 선택 두 줄 보임)을 구해 spec §2.2 첫 표와 대조: 본문 5 이상 = 머리·제목·목록·선택 / **본문 4 = 머리·목록·선택, 제목 없음** / **본문 3 = 머리·선택, 제목 없음** / 본문 2 = 선택만 / 본문 1 = 고른 선택 줄만.
  - `choice_head_line_needs_note_visible`: 안내 있는 선택 창(`note_choice`), 같은 스윕 — 본문 6 이상 그대로 / **본문 5 = 머리·목록·선택·안내, 제목 없음** / 본문 4 = 제목·목록·선택(머리 없음·안내 없음) / 본문 3 = 제목·선택.
  - `no_choice_keeps_title`: 선택 창이 없으면 터미널 높이 3..=9 모두 제목이 보인다. `Confirm`·`Notice` 창(1줄)은 본문 2 이상(터미널 높이 4..=9)에서 제목이 보인다(본문 1은 창 한 줄뿐 — 지금 동작).
  - `choice_head_line_long_and_sanitized`: 머리 1,000자(`"T".repeat(1000)`)·제어 문자가 든 머리(`"a\u{1b}[31mb  =  1"`)를 본문 3·4에서 — 머리 줄이 `…`로 끝나고 그 줄의 그린 폭 ≤ 화면 폭, `\u{FFFD}`가 보인다.
  - **기존 테스트 2개를 고친다**(spec §6): `choice_note_outlives_head_sweep`의 끝 단언 `note_only >= 4 * 91`을 지우고, 대신 "본문 5(터미널 높이 7)이고 폭 30 이상이면 `note && hd`"를 세어 `>= 4 * 91`로 단언한다(`if hd { assert!(note, …) }`는 **그대로 둔다**). `choice_note_only_at_body_height_five`는 `assert_eq!(first_head, first_note, …)`로 바꾸고 이름을 `choice_note_and_head_first_at_body_height_five`로, 주석도 맞춘다.
  실행: `cargo test -p handicap-tui --test values_view_test choice`. 기대: 새 테스트 중 `choice_head_line_at_low_height`·`choice_head_line_needs_note_visible`·`choice_head_line_long_and_sanitized`와 고친 두 테스트 **RED**, `no_choice_keeps_title` GREEN.
- [ ] **Step 2: 구현(GREEN)**.
  - `view/settings.rs`: 높이 규칙을 순수 도우미로 뺀다. `overlay_rows`의 Choice 갈래가 `head_min`·`bh >= 5` 대신 이것을 쓴다(동작 불변 — 반환 모양도 그대로).

```rust
/// 선택 창 안내 줄이 나오는 최소 본문 높이.
pub(crate) const CHOICE_NOTE_MIN: usize = 5;

/// 선택 창 줄들에 머리가 들어가는 최소 본문 높이 — 안내가 있으면 한 줄 늦다(안내가 머리보다 오래 남는다).
pub(crate) fn choice_head_min(has_note: bool) -> usize {
    if has_note { 6 } else { 5 }
}

/// 선택 창 줄들에 머리가 못 들어가는 높이에서 값 목록 화면이 제목 줄 자리에 그리는 머리 한 줄
/// (spec tui-2b-width-number §2.2). 안내가 있는 선택 창은 안내가 그려지는 높이에서만 — 머리가 보이면 안내도 보인다.
pub(crate) fn choice_head_line(
    overlay: Option<&OverlayView>,
    w: usize,
    bh: usize,
) -> Option<Line<'static>> {
    let Some(OverlayView::Choice { head, note, .. }) = overlay else {
        return None;
    };
    if bh >= choice_head_min(note.is_some()) || (note.is_some() && bh < CHOICE_NOTE_MIN) {
        return None;
    }
    // 머리는 최대 64KB 값일 수 있다 — 한 줄에 넉넉한 만큼만 잘라 `sanitize`한다.
    let mut it = head.chars();
    let short: String = it.by_ref().take((w + 1).saturating_mul(4)).collect();
    let mut s = sanitize(&short);
    if it.next().is_some() {
        s.push('…');
    }
    Some(Line::from(Span::styled(
        fit(&format!("  {s}"), w),
        Style::default().fg(color(C_TEXT)),
    )))
}
```

  - `view/values.rs` `render_values`: 제목 줄을 그리는 자리(`put(f, row(0), title_line);` — `grep -n 'title_line' crates/tui/src/view/values.rs`)에서, 조건 칸이 없고(`v.form.is_none()`) `choice_head_line(v.overlay.as_ref(), w, bh)`가 `Some`이면 그 줄을 제목 대신 그린다. 그 밖은 지금 그대로.
  실행: `cargo test -p handicap-tui` 전체 → GREEN.
- [ ] **Step 3: 회귀 실증**. `choice_head_line`의 `(note.is_some() && bh < CHOICE_NOTE_MIN)` 조건을 빼면 `choice_note_outlives_head_sweep`의 `머리는 보이는데 안내가 없다`가 RED인지 확인하고 원복.
- [ ] **Step 4: 게이트 + 커밋**. `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings; echo exit=$?`, `TZ=UTC cargo test -p handicap-tui`. 커밋 `feat(tui): 낮은 화면의 선택 창 — 제목 줄 자리에 고른 값 한 줄 (tui-2b-width-number §2.2)`.

---

### Task 5: 대체 화면 안내 `…` + 조건 칸 대상 줄 수 상한 (US3 · US: N/A)

spec §2.3·§2.4, §6 "대체 화면"·"조건 칸". Task 3 뒤에 한다(`wrap_width`가 새 재기여야 한다).

**Files:**
- Modify: `crates/tui/tests/inspect_test.rs`, `crates/tui/src/view/inspect.rs`, `crates/tui/src/view/edit.rs`

- [ ] **Step 1: 대체 화면 테스트(RED)** — `crates/tui/tests/inspect_test.rs`(`render_missing_wraps_and_survives_small` 옆, 같은 도우미 `draw`·`head`). `render_missing_ellipsis_when_cut`: 폭 20·40·80 × 본문 1줄·2줄·넉넉한 높이(터미널 높이 = 본문 + 2). 안내(`text::SUB_MISSING`)를 `폭 − 1`칸으로 줄바꿈한 줄 수가 본문 높이보다 많으면 마지막 본문 줄이 `…`로 끝나고(`trim_end` 뒤), 아니면 본문 어디에도 `…`가 없다. 80열은 본문 1줄에서도 `…` 없음. 기대: 20열·40열의 본문 1줄(20열은 2줄도)에서 **RED**.
- [ ] **Step 2: 대체 화면 구현(GREEN)** — `view/inspect.rs` `render_missing`: 줄바꿈한 줄 `rows`와 `h = body.height`에서 `n = rows.len().min(h)`줄을 그리되, `n < rows.len()`이면 마지막 줄을 `fit(&rows[n - 1..].concat(), w)`로(spec §2.3). 실행: `cargo test -p handicap-tui --test inspect_test render_missing` → GREEN(기존 두 테스트 포함).
- [ ] **Step 3: 조건 칸 테스트** — `crates/tui/src/view/edit.rs` 끝에 인라인 `#[cfg(test)] mod tests`(`target_rows`가 비공개다). **편집 순서**: ① 테스트 모듈을 넣는 편집이 먼저다(이 편집이 `#[cfg(test)]`를 넣어 tdd-guard를 통과한다 — `edit.rs`에는 아직 인라인 테스트가 없다) ② 그다음 `target_rows`의 **시그니처만** 바꾼다: `fn target_rows(target: &str, fw: usize, max_rows: usize) -> (Vec<String>, bool)` — 본문은 일단 상한을 무시하고 전체를 줄바꿈해 `(rows, false)`를 돌려주게 두고, 두 호출 쪽(`cond_form_height`·`render_cond_form`)은 `.0`만 쓰게 맞춘다(동작 불변). 테스트:
  - `target_rows_prefix_equals_full`: 대상(ASCII 60자 · 500자 · 100,000자 · `❤️`가 섞인 2,000자) × `fw` 8·20·69 × `max_rows` 1·3·10에서, `target_rows(t, fw, max_rows).0`의 앞 `max_rows`줄 == `wrap_width(&sanitize(t), fw)`의 앞 `max_rows`줄.
  - `target_rows_cut_inside_cluster`: 예산 경계가 묶음 가운데에 오는 대상 둘에서 위와 같은 단언(앞 `max_rows`줄이 같다) — ⓐ `"a"` + `"\u{2764}\u{FE0F}"` 반복(예산이 짝수라 경계가 `\u{2764}`와 `\u{FE0F}` 사이) ⓑ ZWJ 가족 이모지 `"\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}"` 반복(글자 7개에 2칸 — 예산이 상한 줄 바로 뒤에서 떨어진다). `fw` 20·69 × `max_rows` 3·10.
  - `target_rows_does_not_scan_whole_target`: 1 MiB 대상(`"a".repeat(1 << 20)`), `fw = 69`, `max_rows = 24` → 돌려준 줄들의 글자 수 합 ≤ `(24 + 1) * 69 * 4`, 둘째 값(잘림) `true`. 짧은 대상은 `false`.
  - `target_rows_narrow_is_single_row`: `fw < 8`이면 한 줄(기존 동작).
  실행: `cargo test -p handicap-tui --lib view::edit`. 기대: `target_rows_does_not_scan_whole_target` **RED**, 나머지 GREEN.
- [ ] **Step 4: 조건 칸 구현(GREEN)** — `target_rows`: 대상의 앞 `(max_rows + 1) × max(fw, 1) × 4`글자만(`saturating_*`, `char_indices().nth(예산)`으로 자른다 — `received_head`와 같은 방식) `sanitize`·줄바꿈하고 잘랐는지를 돌려준다. `cond_form_height`는 상한 `usize::from(body_h)`, `render_cond_form`은 `usize::from(area.height)`. 그리기에서 "다 못 보이는 마지막 줄"의 조건을 `shown < rows.len() || cut`으로 넓히고, `cut`이면 이어 붙인 글자 끝에 `…`을 붙인 뒤 `fit`한다(spec §2.4-3). 실행: `cargo test -p handicap-tui` 전체 → GREEN(`cond_form_target_*`·`values_form_long_target`·`cond_form_height` 테스트가 그대로 통과해야 한다 — 깨지면 STOP).
- [ ] **Step 5: 비용 측정(1회)**. 인라인 테스트 모듈에 `#[ignore = "수동 측정"] fn perf_cond_form()`을 넣는다 — 1 MiB 대상으로 `target_rows(t, 69, 24)`를 1,000번 부른 시간과, 참조로 `wrap_width(&sanitize(t), 69)`(옛 경로 1회분)를 10번 부른 시간을 출력. `cargo test -p handicap-tui --release --lib perf_cond_form -- --ignored --nocapture` → 수치를 리포트에 적는다(build-log에 옮긴다).
- [ ] **Step 6: 게이트 + 커밋**. `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings; echo exit=$?`, `TZ=UTC cargo test -p handicap-tui`. 커밋 `feat(tui): 대체 화면 안내가 잘리면 … · 조건 칸이 대상 전체를 훑지 않는다 (tui-2b-width-number §2.3·§2.4)`.

---

### Task 6: 문서 (orchestrator가 직접 — 구현 task 뒤)

spec §5.

- [ ] `docs/superpowers/specs/2026-11-11-tui-2b-polish-design.md`: §2.1 머리·§2.2-1의 폭 재기 보정 줄·§9의 해당 한계 줄에 "→ tui-2b-width-number §2.5 / §2.1" 표시(지우지 않는다).
- [ ] `crates/tui/CLAUDE.md`: "`wrap_width`는 글자 하나씩 폭을 더하고 `fit`은 줄 전체 폭을 잰다…" 줄을 새 기준 한 줄로 교체 — "폭은 `view::cells`(글자 묶음 × ratatui `cell_width`) 하나로 잰다 — 글자 하나씩·문자열 전체(`Span::width`)로 재면 `❤️`·람-알레프·반각 탁점에서 그린 칸과 어긋난다, 불변식 테스트는 `Buffer::set_stringn`의 x와 대조 (tui-2b-width-number)". 구현 중 새로 배운 함정이 있으면 한 줄씩.
- [ ] `crates/controller/CLAUDE.md` 운영 모니터 절: "모니터가 숫자를 글자로 바꾸는 곳은 `monitor::number` 하나(서버 판정·표시 값·TUI) — GUI `String(v)`와 같은 글자, 골든 픽스처 `testdata/number_text_golden.json`(node로 재생성). 엔진 `stringify`는 다른 표기 그대로 (tui-2b-width-number)".
- [ ] `docs/dev/tui-monitor.md` §4-3: 숫자가 서버 표시 값과 같은 글자라는 것·터미널 높이 5–6줄의 선택 창 한 줄을 한 문장씩.
- [ ] `just doc-budget`(있으면) — root `CLAUDE.md`는 finish-slice에서 상태 줄만.

## 구현 뒤 (orchestrator — task 아님)

1. 전수 확인(직접 재실행): Global Constraints의 0-diff 명령 · `grep -rn 'encode_utf8' crates/tui/src`(2줄) · `grep -rn 'stringify' crates/controller/src`(import 1 + `value_text` 안 1 + `datasets` 테스트 이름 1) · `cargo test --workspace` · `TZ=UTC cargo test -p handicap-tui`.
2. 최종 리뷰: `handicap-reviewer`(초점 — 옛 숫자 글자·옛 폭 재기의 부수효과에 기대던 소비자: GUI가 서버 표시 값·사유 글자를 다시 해석하는 곳이 있는가[`grep -rn 'display\b\|reason' ui/src/monitor ui/src/components/monitor`], TUI `marks`·`judge`가 숫자 글자를 비교하는 곳이 있는가). `security-reviewer`: spec §8대로 판정 경로를 건드렸으므로 돌린다 + `finish-slice` §0 grep 직접 실행.
3. 라이브 검증: spec §7 표 전부(tmux + 응답기, `crates/tui/CLAUDE.md`의 tmux 함정). 칸 1–9 × 80×24·160×50 전후 화면 비교는 **이 plan의 base 커밋에서 빌드한 바이너리의 캡처**와 새 바이너리의 캡처를 글자 단위로 비교한다(base 바이너리는 Task 1 시작 전에 `cp target/debug/handicap-tui <scratch>/tui-base`로 떠 둔다). GUI 대조는 `ui/src/monitor/conditions.ts` `defaultCondition`을 esbuild로 묶어 node로(`pnpm build` 금지).
4. `/finish-slice`: build-log 단락(증명된 US / 못 한 US·속도 전후 수치·cloud에서 못 한 검증), roadmap `§B56`(번호는 `grep -n '^### B' docs/roadmap.md`로 다시 확인) — (0) 로컬 머지 절차 · 사용자 결정 줄(spec §10) · 판단과 비용 · 연기(spec §9) · **릴리즈 노트 한 줄**("소수 값에 `포함` 조건을 단 칸은 판정이 바뀔 수 있다 — 서버가 숫자를 `1.0`이 아니라 `1`로, `1e+16`이 아니라 `10000000000000000`으로 적는다. 화면 표시 값도 같은 글자로 바뀐다."), §B52 (2)·§B53 (1)(2)의 해소 항목에 취소선 + ✅, 현황판·root 상태 줄.

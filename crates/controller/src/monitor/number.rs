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

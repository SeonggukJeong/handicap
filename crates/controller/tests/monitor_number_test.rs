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

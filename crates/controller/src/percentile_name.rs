//! 백분위 지표 이름 문법(`p<N>_ms`) — 정본 이름만 받는다.

/// 소수 3자리까지인가(허용 오차 식).
pub fn is_three_decimals(x: f64) -> bool {
    x.is_finite() && (x * 1000.0 - (x * 1000.0).round()).abs() < 1e-6
}

/// 유한·0 < n < 100·소수 3자리까지면 `round(n*1000)`.
pub fn to_milli(n: f64) -> Option<u32> {
    if !n.is_finite() || n <= 0.0 || n >= 100.0 || !is_three_decimals(n) {
        return None;
    }
    let m = (n * 1000.0).round();
    (m > 0.0 && m < 100_000.0).then_some(m as u32)
}

/// 정본 이름 `p{N}_ms`. `to_milli`가 None이면 `p{n}_ms`(검증을 거친 값만 들어온다).
pub fn percentile_metric_name(n: f64) -> String {
    let Some(m) = to_milli(n) else {
        return format!("p{n}_ms");
    };
    let (int, frac) = (m / 1000, m % 1000);
    if frac == 0 {
        format!("p{int}_ms")
    } else {
        let f = format!("{frac:03}");
        format!("p{int}.{}_ms", f.trim_end_matches('0'))
    }
}

/// 정본 이름만 `Some(N)`.
pub fn parse_percentile_metric(name: &str) -> Option<f64> {
    let mid = name.strip_prefix('p')?.strip_suffix("_ms")?;
    let (int, frac) = match mid.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (mid, None),
    };
    let int_ok = int == "0"
        || (!int.starts_with('0')
            && !int.is_empty()
            && int.len() <= 2
            && int.bytes().all(|b| b.is_ascii_digit()));
    if !int_ok {
        return None;
    }
    if let Some(f) = frac {
        if f.is_empty() || f.len() > 3 || !f.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
    }
    let n: f64 = mid.parse().ok()?;
    to_milli(n)?;
    (percentile_metric_name(n) == name).then_some(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn cases() -> Value {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/percentile_metric_cases.json"
        )))
        .expect("cases parse")
    }

    #[test]
    fn names_table() {
        let c = cases();
        for row in c["names"].as_array().unwrap() {
            let input = row["input"].as_str().unwrap();
            let want = row["percentile"].as_f64();
            assert_eq!(parse_percentile_metric(input), want, "{input}");
            if let Some(n) = want {
                assert_eq!(percentile_metric_name(n), input);
            }
        }
    }

    #[test]
    fn numbers_table() {
        let c = cases();
        for row in c["numbers"].as_array().unwrap() {
            let input = row["input"].as_str().unwrap();
            let got = input
                .parse::<f64>()
                .ok()
                .filter(|n| to_milli(*n).is_some())
                .map(percentile_metric_name);
            assert_eq!(got.as_deref(), row["name"].as_str(), "{input}");
        }
    }

    #[test]
    fn three_decimals() {
        assert!(is_three_decimals(1.005));
        assert!(is_three_decimals(0.5));
        assert!(is_three_decimals(60000.0));
        assert!(!is_three_decimals(1.0005));
    }
}

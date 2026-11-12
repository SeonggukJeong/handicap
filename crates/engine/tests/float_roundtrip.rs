//! serde_json이 자기가 쓴 소수를 정확히 되읽는지 — 이 테스트가 깨지면 `float_roundtrip` 기능이
//! 꺼진 것이다(spec §3, 루트 `Cargo.toml`·`desktop/src-tauri/Cargo.toml`).

#[test]
fn serde_json_reads_its_own_floats_exactly() {
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut checked = 0;
    while checked < 20_000 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        let v = f64::from_bits(x);
        if !v.is_finite() {
            continue;
        }
        checked += 1;
        let s = serde_json::to_string(&v).unwrap();
        let read = serde_json::from_str::<f64>(&s).unwrap();
        assert_eq!(read, s.parse::<f64>().unwrap(), "misread: {s}");
    }
}

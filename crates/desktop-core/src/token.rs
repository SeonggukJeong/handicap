//! 워커 접속 토큰 생성·검사.

/// 128비트 난수를 소문자 16진 32글자로.
pub fn generate_token<R: rand::RngCore + rand::CryptoRng>(rng: &mut R) -> String {
    let mut b = [0u8; 16];
    rng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// 쓸 수 있는 토큰의 최소 길이(= 생성 토큰 32글자, 128비트 이상 — spec R3).
pub const MIN_TOKEN_LEN: usize = 32;

/// 32글자 이상 ∧ 모두 ASCII 영숫자(spec R3 "128비트 이상, 영숫자"). 아니면 셸이 시작 때
/// 새로 만든다 — 손으로 고친 설정 파일의 공백·셸 특수문자가 부하기 PC용 명령에 실리지 않게.
pub fn is_usable_token(t: &str) -> bool {
    t.len() >= MIN_TOKEN_LEN && t.bytes().all(|b| b.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_32_lower_hex() {
        let t = generate_token(&mut rand::rngs::OsRng);
        assert_eq!(t.len(), 32);
        assert!(
            t.chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        );
    }
    #[test]
    fn tokens_differ() {
        assert_ne!(
            generate_token(&mut rand::rngs::OsRng),
            generate_token(&mut rand::rngs::OsRng)
        );
    }
    #[test]
    fn blank_tokens_unusable() {
        assert!(!is_usable_token(""));
        assert!(!is_usable_token("  \t"));
        assert!(!is_usable_token("x"), "너무 짧음");
    }
    #[test]
    fn short_or_non_alnum_tokens_unusable() {
        assert!(!is_usable_token("a b"));
        assert!(!is_usable_token("x;y"));
        assert!(!is_usable_token("1234"));
        assert!(!is_usable_token(&"a".repeat(31)), "31글자");
        assert!(!is_usable_token(&format!("{};", "a".repeat(32))));
        assert!(!is_usable_token(&format!("{} ", "a".repeat(32))));
        assert!(!is_usable_token(&"가".repeat(32)), "ASCII 아님");
    }
    #[test]
    fn generated_and_long_alnum_tokens_usable() {
        assert!(is_usable_token(&generate_token(&mut rand::rngs::OsRng)));
        assert!(is_usable_token(&"ab".repeat(16)));
        assert!(is_usable_token(&"Ab9".repeat(20)));
    }
}

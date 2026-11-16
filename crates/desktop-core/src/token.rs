//! 워커 접속 토큰 생성·검사.

/// 128비트 난수를 소문자 16진 32글자로.
pub fn generate_token<R: rand::RngCore + rand::CryptoRng>(rng: &mut R) -> String {
    let mut b = [0u8; 16];
    rng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn is_usable_token(t: &str) -> bool {
    !t.trim().is_empty()
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
        assert!(is_usable_token("x"));
    }
}

//! 부하기 접속 코드: 서버 PC가 만들어 부하기 PC에 붙여넣는 한 줄(IP 후보·포트·토큰 + 검사값).
use crate::token::is_usable_token;
use std::net::Ipv4Addr;

pub const MAX_CODE_IPS: usize = 16;
pub const MAX_CODE_LEN: usize = 4096;
pub const MAX_CODE_TOKEN_LEN: usize = 256;

#[derive(Clone, PartialEq)]
pub struct ConnectCode {
    pub ips: Vec<Ipv4Addr>,
    pub port: u16,
    pub token: String,
}

impl std::fmt::Debug for ConnectCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectCode")
            .field("ips", &self.ips)
            .field("port", &self.port)
            .field("token", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeError {
    Format,
    UnknownVersion,
}

impl std::fmt::Display for CodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CodeError::Format => f.write_str("접속 코드 형식이 아닙니다"),
            CodeError::UnknownVersion => {
                f.write_str("접속 코드 형식이 아닙니다 — 앱 버전이 다를 수 있습니다")
            }
        }
    }
}

impl std::error::Error for CodeError {}

/// CRC-32 IEEE(다항식 0xEDB88320, 비트 단위).
pub(crate) fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in bytes {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

/// 부하기가 접속을 시도해도 되는 주소인가(0.0.0.0/8·루프백·링크로컬·멀티캐스트·브로드캐스트 거절).
pub fn is_allowed_target_ip(ip: Ipv4Addr) -> bool {
    !(ip.octets()[0] == 0
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast())
}

/// 검사 없이 그대로 만든다(호출자가 주소를 거르고 `MAX_CODE_IPS`로 자른다).
pub fn encode(c: &ConnectCode) -> String {
    let mut v = vec![c.ips.len() as u8];
    for ip in &c.ips {
        v.extend_from_slice(&ip.octets());
    }
    v.extend_from_slice(&c.port.to_be_bytes());
    v.extend_from_slice(&(c.token.len() as u16).to_be_bytes());
    v.extend_from_slice(c.token.as_bytes());
    let crc = crc32(&v);
    v.extend_from_slice(&crc.to_be_bytes());
    let mut out = String::from("HANDICAP1-");
    for b in v {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if b.len() % 2 != 0 {
        return None;
    }
    let d = |c: u8| (c as char).to_digit(16).map(|v| v as u8);
    b.chunks(2)
        .map(|p| Some(d(p[0])? << 4 | d(p[1])?))
        .collect()
}

pub fn decode(raw: &str) -> Result<ConnectCode, CodeError> {
    use CodeError::{Format, UnknownVersion};
    if raw.len() > MAX_CODE_LEN {
        return Err(Format);
    }
    let rest = raw.trim().strip_prefix("HANDICAP").ok_or(Format)?;
    let (ver, body) = rest.split_once('-').ok_or(Format)?;
    if ver.is_empty() || !ver.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Format);
    }
    if ver != "1" {
        return Err(UnknownVersion);
    }
    let bytes = unhex(body).ok_or(Format)?;
    if bytes.len() < 4 {
        return Err(Format);
    }
    let (data, crc) = bytes.split_at(bytes.len() - 4);
    if crc32(data).to_be_bytes() != crc {
        return Err(Format);
    }
    let n = usize::from(*data.first().ok_or(Format)?);
    if !(1..=MAX_CODE_IPS).contains(&n) {
        return Err(Format);
    }
    let ips_end = 1 + 4 * n;
    if data.len() < ips_end + 4 {
        return Err(Format);
    }
    let ips: Vec<Ipv4Addr> = data[1..ips_end]
        .chunks(4)
        .map(|c| Ipv4Addr::new(c[0], c[1], c[2], c[3]))
        .collect();
    let port = u16::from_be_bytes([data[ips_end], data[ips_end + 1]]);
    let tlen = usize::from(u16::from_be_bytes([data[ips_end + 2], data[ips_end + 3]]));
    let tstart = ips_end + 4;
    if data.len() != tstart + tlen || tlen > MAX_CODE_TOKEN_LEN {
        return Err(Format);
    }
    let token = std::str::from_utf8(&data[tstart..]).map_err(|_| Format)?;
    if port == 0 || !is_usable_token(token) || !ips.iter().all(|ip| is_allowed_target_ip(*ip)) {
        return Err(Format);
    }
    Ok(ConnectCode {
        ips,
        port,
        token: token.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tok() -> String {
        "ab".repeat(16)
    }
    fn one() -> ConnectCode {
        ConnectCode {
            ips: vec![Ipv4Addr::new(192, 168, 0, 12)],
            port: 8081,
            token: tok(),
        }
    }
    fn payload(ips: &[[u8; 4]], n: u8, port: u16, token: &str) -> Vec<u8> {
        let mut v = vec![n];
        for ip in ips {
            v.extend_from_slice(ip);
        }
        v.extend_from_slice(&port.to_be_bytes());
        v.extend_from_slice(&(token.len() as u16).to_be_bytes());
        v.extend_from_slice(token.as_bytes());
        v
    }
    fn raw_code(mut bytes: Vec<u8>) -> String {
        let crc = crc32(&bytes);
        bytes.extend_from_slice(&crc.to_be_bytes());
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        format!("HANDICAP1-{hex}")
    }
    fn code_for(ips: &[[u8; 4]]) -> String {
        raw_code(payload(ips, ips.len() as u8, 8081, &tok()))
    }

    #[test]
    fn crc32_known_vector() {
        assert_eq!(crc32(b"123456789"), 0xCBF43926);
    }

    #[test]
    fn round_trip_one_and_sixteen_ips() {
        let sixteen = ConnectCode {
            ips: (1..=16).map(|i| Ipv4Addr::new(10, 0, 0, i)).collect(),
            port: 8081,
            token: tok(),
        };
        for c in [one(), sixteen] {
            let s = encode(&c);
            assert!(s.starts_with("HANDICAP1-"));
            assert!(
                s["HANDICAP1-".len()..]
                    .chars()
                    .all(|ch| ch.is_ascii_digit() || ('a'..='f').contains(&ch))
            );
            assert_eq!(decode(&s), Ok(c));
        }
    }

    #[test]
    fn every_single_char_change_is_rejected() {
        let s = encode(&one());
        let chars: Vec<char> = s.chars().collect();
        for i in 0..chars.len() {
            let mut c = chars.clone();
            if i < 10 {
                c[i] = 'X';
                if i == 8 {
                    c[i] = '2';
                    let r = decode(&c.iter().collect::<String>());
                    assert_eq!(r, Err(CodeError::UnknownVersion));
                    continue;
                }
            } else {
                let v = c[i].to_digit(16).unwrap();
                c[i] = char::from_digit((v + 1) % 16, 16).unwrap();
            }
            let r = decode(&c.iter().collect::<String>());
            assert!(r.is_err(), "position {i} change accepted");
        }
    }

    #[test]
    fn truncation_is_rejected() {
        let s = encode(&one());
        for n in [1, 2, 8] {
            assert_eq!(decode(&s[..s.len() - n]), Err(CodeError::Format));
        }
    }

    #[test]
    fn trims_surrounding_whitespace() {
        let s = encode(&one());
        assert_eq!(decode(&format!("  \n{s}\r\n\t")), Ok(one()));
        let mid = format!("{} {}", &s[..14], &s[14..]);
        assert_eq!(decode(&mid), Err(CodeError::Format));
    }

    #[test]
    fn uppercase_body_is_accepted() {
        let s = encode(&one());
        let up = format!("HANDICAP1-{}", s["HANDICAP1-".len()..].to_uppercase());
        assert_eq!(decode(&up), Ok(one()));
    }

    #[test]
    fn unknown_version_and_bad_prefix() {
        assert_eq!(decode("HANDICAP2-00"), Err(CodeError::UnknownVersion));
        for s in ["HANDICAP-00", "HANDICAPx-00", ""] {
            assert_eq!(decode(s), Err(CodeError::Format), "{s:?}");
        }
        let lower = encode(&one()).replacen("HANDICAP", "handicap", 1);
        assert!(lower.starts_with("handicap1-"));
        assert_eq!(decode(&lower), Err(CodeError::Format));
    }

    #[test]
    fn length_cap() {
        let s = encode(&one());
        let padded = format!("{s}{}", " ".repeat(MAX_CODE_LEN + 1 - s.len()));
        assert_eq!(padded.len(), MAX_CODE_LEN + 1);
        assert_eq!(decode(&padded), Err(CodeError::Format));
    }

    #[test]
    fn rejects_bad_fields() {
        let ip = [[192, 168, 0, 12]];
        let t = tok();
        assert_eq!(
            decode(&raw_code(payload(&[], 0, 8081, &t))),
            Err(CodeError::Format)
        );
        let many = vec![[10, 0, 0, 1]; 17];
        assert_eq!(
            decode(&raw_code(payload(&many, 17, 8081, &t))),
            Err(CodeError::Format)
        );
        assert_eq!(
            decode(&raw_code(payload(&ip, 1, 0, &t))),
            Err(CodeError::Format)
        );
        assert_eq!(
            decode(&raw_code(payload(&ip, 1, 8081, &"a".repeat(31)))),
            Err(CodeError::Format)
        );
        let semi = format!("{};", "a".repeat(31));
        assert_eq!(
            decode(&raw_code(payload(&ip, 1, 8081, &semi))),
            Err(CodeError::Format)
        );
        assert_eq!(
            decode(&raw_code(payload(&ip, 1, 8081, &"a".repeat(257)))),
            Err(CodeError::Format)
        );
        let mut extra = payload(&ip, 1, 8081, &t);
        extra.push(b'a');
        assert_eq!(decode(&raw_code(extra)), Err(CodeError::Format));
        let ok = decode(&raw_code(payload(&ip, 1, 8081, &"a".repeat(256)))).unwrap();
        assert_eq!(ok.token.len(), 256);
    }

    #[test]
    fn rejects_disallowed_target_ips() {
        for ip in [
            [127, 0, 0, 1],
            [0, 0, 0, 0],
            [0, 1, 2, 3],
            [169, 254, 169, 254],
            [224, 0, 0, 1],
            [255, 255, 255, 255],
        ] {
            assert_eq!(decode(&code_for(&[ip])), Err(CodeError::Format), "{ip:?}");
            assert_eq!(
                decode(&code_for(&[[10, 0, 0, 1], ip])),
                Err(CodeError::Format)
            );
        }
        assert!(decode(&code_for(&[[8, 8, 8, 8]])).is_ok());
    }

    #[test]
    fn debug_redacts_token() {
        let d = format!("{:?}", one());
        assert!(!d.contains(&tok()));
        assert!(d.contains("[REDACTED]"));
    }

    #[test]
    fn error_display_never_echoes_input() {
        let s = encode(&one());
        let mut c: Vec<char> = s.chars().collect();
        let last = c.len() - 1;
        c[last] = if c[last] == '0' { '1' } else { '0' };
        let bad: String = c.into_iter().collect();
        let msg = decode(&bad).unwrap_err().to_string();
        assert!(!msg.contains(&tok()));
        assert!(!msg.contains(&bad));
        assert!(!CodeError::UnknownVersion.to_string().contains(&tok()));
    }
}

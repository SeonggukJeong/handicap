//! 생성 변수 (spec 2026-07-24-dynamic-vars): variables 값의 두 형태(정적 문자열 | 생성기 맵)와
//! 반복-시드 평가. 검증은 wire-struct(GenSpecWire, deny_unknown_fields) + TryFrom 단일 경로 —
//! `Scenario::from_yaml`이 곧 authoring 게이트다(컨트롤러 별도 validator 없음).
use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use chrono::format::{Item, StrftimeItems};
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use rand::Rng;
use rand::rngs::StdRng;
use serde::de::{self, MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VarDecl {
    Static(String),
    Gen(GenSpec),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GenSpec {
    Date(DateGen),
    RandomInt(RandomIntGen),
    Uuid,
    RandomString(RandomStringGen),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DateGen {
    /// "unix" | "unix_ms" | 검증된 strftime. 기본 "%Y-%m-%d".
    pub format: String,
    /// 검증된 원문 보존(`^[+-]\d{1,9}[smhd]$`) — emit용. 초 환산은 offset_secs.
    pub offset: Option<String>,
    /// 검증된 IANA 이름 원문. None = 워커 로컬.
    pub tz: Option<String>,
    pub(crate) offset_secs: i64,
    pub(crate) tz_parsed: Option<Tz>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RandomIntGen {
    pub min: i64,
    pub max: i64,
    pub step: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RandomStringGen {
    pub length: u32,
}

/// 와이어 형태 — plain struct라 deny_unknown_fields가 확실히 동작(내부 태그 enum 미보증 함정 회피).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GenSpecWire {
    r#gen: String,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    offset: Option<String>,
    #[serde(default)]
    tz: Option<String>,
    #[serde(default)]
    min: Option<i64>,
    #[serde(default)]
    max: Option<i64>,
    #[serde(default)]
    step: Option<u32>,
    #[serde(default)]
    length: Option<u32>,
}

fn parse_offset_secs(s: &str) -> Option<i64> {
    let (sign, rest) = match s.as_bytes().first()? {
        b'+' => (1i64, &s[1..]),
        b'-' => (-1i64, &s[1..]),
        _ => return None,
    };
    if rest.len() < 2 {
        return None;
    }
    let (digits, unit) = rest.split_at(rest.len() - 1);
    if digits.is_empty() || digits.len() > 9 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: i64 = digits.parse().ok()?;
    let mult = match unit {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86400,
        _ => return None,
    };
    Some(sign * n * mult)
}

fn strftime_valid(f: &str) -> bool {
    StrftimeItems::new(f).all(|it| !matches!(it, Item::Error))
}

impl TryFrom<GenSpecWire> for GenSpec {
    type Error = String;
    fn try_from(w: GenSpecWire) -> Result<Self, String> {
        // per-gen 필드 allow-list: 다른 생성기의 키 혼입 거부 (spec §3).
        let deny = |cond: bool, msg: &str| if cond { Err(msg.to_string()) } else { Ok(()) };
        match w.r#gen.as_str() {
            "date" => {
                deny(
                    w.min.is_some() || w.max.is_some() || w.step.is_some() || w.length.is_some(),
                    "date 생성기는 min/max/step/length를 받지 않는다",
                )?;
                let format = w.format.unwrap_or_else(|| "%Y-%m-%d".to_string());
                if format != "unix" && format != "unix_ms" && !strftime_valid(&format) {
                    return Err(format!("잘못된 날짜 형식: {format}"));
                }
                let offset_secs = match &w.offset {
                    Some(o) => parse_offset_secs(o)
                        .ok_or_else(|| format!("잘못된 오프셋: {o} (예: +7d, -2h)"))?,
                    None => 0,
                };
                let tz_parsed = match &w.tz {
                    Some(t) => {
                        Some(Tz::from_str(t).map_err(|_| format!("알 수 없는 타임존: {t}"))?)
                    }
                    None => None,
                };
                Ok(GenSpec::Date(DateGen {
                    format,
                    offset: w.offset,
                    tz: w.tz,
                    offset_secs,
                    tz_parsed,
                }))
            }
            "random_int" => {
                deny(
                    w.format.is_some()
                        || w.offset.is_some()
                        || w.tz.is_some()
                        || w.length.is_some(),
                    "random_int 생성기는 format/offset/tz/length를 받지 않는다",
                )?;
                let (min, max) = match (w.min, w.max) {
                    (Some(a), Some(b)) => (a, b),
                    _ => return Err("random_int는 min·max가 필수".into()),
                };
                if min > max {
                    return Err(format!("min({min}) > max({max})"));
                }
                let step = w.step.unwrap_or(1);
                if step == 0 {
                    return Err("step은 1 이상".into());
                }
                Ok(GenSpec::RandomInt(RandomIntGen { min, max, step }))
            }
            "uuid" => {
                deny(
                    w.format.is_some()
                        || w.offset.is_some()
                        || w.tz.is_some()
                        || w.min.is_some()
                        || w.max.is_some()
                        || w.step.is_some()
                        || w.length.is_some(),
                    "uuid 생성기는 파라미터를 받지 않는다",
                )?;
                Ok(GenSpec::Uuid)
            }
            "random_string" => {
                deny(
                    w.format.is_some()
                        || w.offset.is_some()
                        || w.tz.is_some()
                        || w.min.is_some()
                        || w.max.is_some()
                        || w.step.is_some(),
                    "random_string 생성기는 length만 받는다",
                )?;
                let length = w.length.unwrap_or(8);
                if !(1..=64).contains(&length) {
                    return Err(format!("length는 1~64: {length}"));
                }
                Ok(GenSpec::RandomString(RandomStringGen { length }))
            }
            other => Err(format!("알 수 없는 생성기: {other}")),
        }
    }
}

impl<'de> Deserialize<'de> for VarDecl {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = VarDecl;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a string (static variable) or a map with `gen:` (generator)")
            }
            fn visit_str<E: de::Error>(self, s: &str) -> Result<VarDecl, E> {
                Ok(VarDecl::Static(s.to_string()))
            }
            fn visit_string<E: de::Error>(self, s: String) -> Result<VarDecl, E> {
                Ok(VarDecl::Static(s))
            }
            fn visit_map<M: MapAccess<'de>>(self, m: M) -> Result<VarDecl, M::Error> {
                let wire = GenSpecWire::deserialize(de::value::MapAccessDeserializer::new(m))?;
                GenSpec::try_from(wire)
                    .map(VarDecl::Gen)
                    .map_err(de::Error::custom)
            }
        }
        d.deserialize_any(V)
    }
}

impl Serialize for VarDecl {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            VarDecl::Static(v) => s.serialize_str(v),
            VarDecl::Gen(g) => g.serialize(s),
        }
    }
}

impl Serialize for GenSpec {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        // 필드 emit 규칙: gen 태그 + (date) format 항상·offset/tz는 Some만 /
        // (random_int) min·max 항상·step은 ≠1만 / (random_string) length 항상.
        match self {
            GenSpec::Date(g) => {
                let n = 2 + g.offset.is_some() as usize + g.tz.is_some() as usize;
                let mut m = s.serialize_map(Some(n))?;
                m.serialize_entry("gen", "date")?;
                m.serialize_entry("format", &g.format)?;
                if let Some(o) = &g.offset {
                    m.serialize_entry("offset", o)?;
                }
                if let Some(t) = &g.tz {
                    m.serialize_entry("tz", t)?;
                }
                m.end()
            }
            GenSpec::RandomInt(g) => {
                let n = 3 + (g.step != 1) as usize;
                let mut m = s.serialize_map(Some(n))?;
                m.serialize_entry("gen", "random_int")?;
                m.serialize_entry("min", &g.min)?;
                m.serialize_entry("max", &g.max)?;
                if g.step != 1 {
                    m.serialize_entry("step", &g.step)?;
                }
                m.end()
            }
            GenSpec::Uuid => {
                let mut m = s.serialize_map(Some(1))?;
                m.serialize_entry("gen", "uuid")?;
                m.end()
            }
            GenSpec::RandomString(g) => {
                let mut m = s.serialize_map(Some(2))?;
                m.serialize_entry("gen", "random_string")?;
                m.serialize_entry("length", &g.length)?;
                m.end()
            }
        }
    }
}

// ---- 평가 (파싱 시 검증 완료 → infallible) ----

pub(crate) fn eval_date(g: &DateGen, now_utc: DateTime<Utc>) -> String {
    let t = now_utc + chrono::Duration::seconds(g.offset_secs);
    match g.format.as_str() {
        "unix" => t.timestamp().to_string(),
        "unix_ms" => t.timestamp_millis().to_string(),
        f => match g.tz_parsed {
            Some(tz) => t.with_timezone(&tz).format(f).to_string(),
            None => t.with_timezone(&chrono::Local).format(f).to_string(),
        },
    }
}

pub(crate) fn eval_random_int(g: &RandomIntGen, rng: &mut StdRng) -> String {
    // i128 산술: min=i64::MIN·max=i64::MAX에서도 span이 u64에 정확히 담긴다.
    let span = (g.max as i128 - g.min as i128) as u64;
    let k = rng.gen_range(0..=span / g.step as u64);
    ((g.min as i128 + k as i128 * g.step as i128) as i64).to_string()
}

pub(crate) fn eval_uuid(rng: &mut StdRng) -> String {
    let mut b = [0u8; 16];
    rng.fill(&mut b[..]);
    b[6] = (b[6] & 0x0F) | 0x40; // version 4
    b[8] = (b[8] & 0x3F) | 0x80; // RFC 4122 variant
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0],
        b[1],
        b[2],
        b[3],
        b[4],
        b[5],
        b[6],
        b[7],
        b[8],
        b[9],
        b[10],
        b[11],
        b[12],
        b[13],
        b[14],
        b[15]
    )
}

const RS_CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";

pub(crate) fn eval_random_string(g: &RandomStringGen, rng: &mut StdRng) -> String {
    (0..g.length)
        .map(|_| RS_CHARS[rng.gen_range(0..RS_CHARS.len())] as char)
        .collect()
}

/// 반복 시드: 정적은 clone, 생성기는 지금 평가. 호출부(runner 3곳·trace 1곳)가
/// **생성기 전용** entropy rng를 넘긴다 — think rng 공유 금지 (spec §4).
pub fn seed_iter_vars(
    vars: &BTreeMap<String, VarDecl>,
    rng: &mut StdRng,
) -> BTreeMap<String, String> {
    let now = Utc::now();
    vars.iter()
        .map(|(k, d)| {
            let v = match d {
                VarDecl::Static(s) => s.clone(),
                VarDecl::Gen(GenSpec::Date(g)) => eval_date(g, now),
                VarDecl::Gen(GenSpec::RandomInt(g)) => eval_random_int(g, rng),
                VarDecl::Gen(GenSpec::Uuid) => eval_uuid(rng),
                VarDecl::Gen(GenSpec::RandomString(g)) => eval_random_string(g, rng),
            };
            (k.clone(), v)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use rand::SeedableRng;
    use std::collections::BTreeMap;

    fn parse(y: &str) -> Result<BTreeMap<String, VarDecl>, serde_yaml::Error> {
        serde_yaml::from_str(y)
    }

    // ---- serde: 하위호환 + round-trip ----
    #[test]
    fn static_string_roundtrips_as_plain_scalar() {
        let m = parse("a: hello\nb: \"{{x}}\"").unwrap();
        assert_eq!(m["a"], VarDecl::Static("hello".into()));
        let out = serde_yaml::to_string(&m).unwrap();
        assert!(
            !out.contains("gen:"),
            "정적 값은 plain string으로 emit: {out}"
        );
        assert_eq!(parse(&out).unwrap(), m); // value round-trip
    }
    #[test]
    fn gen_specs_roundtrip() {
        let y = "d: {gen: date, format: \"%Y-%m-%d\", offset: \"+7d\", tz: Asia/Seoul}\n\
                 q: {gen: random_int, min: 1000, max: 10000, step: 100}\n\
                 u: {gen: uuid}\n\
                 s: {gen: random_string, length: 12}";
        let m = parse(y).unwrap();
        let out = serde_yaml::to_string(&m).unwrap();
        assert_eq!(parse(&out).unwrap(), m);
    }
    #[test]
    fn date_defaults_applied() {
        let m = parse("d: {gen: date}").unwrap();
        match &m["d"] {
            VarDecl::Gen(GenSpec::Date(g)) => {
                assert_eq!(g.format, "%Y-%m-%d");
                assert_eq!(g.offset, None);
                assert_eq!(g.tz, None);
            }
            other => panic!("{other:?}"),
        }
    }

    // ---- 거부 매트릭스 (spec §3.1/§3 serde 규칙) ----
    #[test]
    fn rejection_matrix() {
        for bad in [
            "x: {gen: nope}",                       // 미지원 gen
            "x: {gen: date, foo: 1}",               // 미지 키 (deny_unknown_fields 경로)
            "x: {gen: uuid, length: 5}",            // cross-gen 키 (allow-list 경로)
            "x: {gen: random_int, min: 5, max: 1}", // min > max
            "x: {gen: random_int, min: 1, max: 2, step: 0}",
            "x: {gen: random_int, max: 9}", // min 누락
            "x: {gen: random_string, length: 0}",
            "x: {gen: random_string, length: 65}",
            "x: {gen: date, offset: \"7d\"}",       // 부호 없음
            "x: {gen: date, offset: \"+7w\"}",      // 미지 단위
            "x: {gen: date, tz: \"Mars/Olympus\"}", // 미지 IANA
            "x: {gen: date, format: \"%Q\"}",       // 잘못된 strftime
            "x: 5",                                 // 비-문자열 스칼라 (현행과 동일 거부)
        ] {
            assert!(parse(bad).is_err(), "should reject: {bad}");
        }
    }

    // ---- 평가 ----
    fn rng() -> rand::rngs::StdRng {
        rand::rngs::StdRng::seed_from_u64(42)
    }

    #[test]
    fn date_eval_format_offset_tz() {
        let g = |y: &str| match parse(y).unwrap().remove("d").unwrap() {
            VarDecl::Gen(GenSpec::Date(g)) => g,
            other => panic!("{other:?}"),
        };
        // 2026-07-24 15:00:00 UTC = 2026-07-25 00:00:00 KST
        let now = Utc.with_ymd_and_hms(2026, 7, 24, 15, 0, 0).unwrap();
        assert_eq!(
            eval_date(&g("d: {gen: date, tz: Asia/Seoul}"), now),
            "2026-07-25"
        );
        assert_eq!(eval_date(&g("d: {gen: date, tz: UTC}"), now), "2026-07-24");
        assert_eq!(
            eval_date(&g("d: {gen: date, offset: \"+7d\", tz: UTC}"), now),
            "2026-07-31"
        );
        assert_eq!(
            eval_date(
                &g("d: {gen: date, offset: \"-2h\", format: \"%H:%M\", tz: UTC}"),
                now
            ),
            "13:00"
        );
        assert_eq!(
            eval_date(&g("d: {gen: date, format: unix}"), now),
            now.timestamp().to_string()
        );
        assert_eq!(
            eval_date(&g("d: {gen: date, format: unix_ms, offset: \"+45s\"}"), now),
            (now.timestamp_millis() + 45_000).to_string()
        );
        assert_eq!(
            eval_date(
                &g("d: {gen: date, format: \"%Y년 %m월 %d일\", tz: UTC}"),
                now
            ),
            "2026년 07월 24일"
        );
    }
    #[test]
    fn random_int_stays_on_grid() {
        let g = RandomIntGen {
            min: 1005,
            max: 2000,
            step: 10,
        };
        let mut r = rng();
        for _ in 0..200 {
            let v: i64 = eval_random_int(&g, &mut r).parse().unwrap();
            assert!((1005..=1995).contains(&v), "{v}"); // 2000은 격자 밖(1005+99*10=1995)
            assert_eq!((v - 1005) % 10, 0, "{v}");
        }
        // step > max-min → 항상 min
        let g2 = RandomIntGen {
            min: 3,
            max: 5,
            step: 10,
        };
        assert_eq!(eval_random_int(&g2, &mut r), "3");
        // i64 극단 span 오버플로 없음
        let g3 = RandomIntGen {
            min: i64::MIN,
            max: i64::MAX,
            step: 1,
        };
        let _ = eval_random_int(&g3, &mut r);
    }
    #[test]
    fn uuid_v4_format_and_uniqueness() {
        let mut r = rng();
        let a = eval_uuid(&mut r);
        let b = eval_uuid(&mut r);
        let re = regex::Regex::new(
            r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        )
        .unwrap();
        assert!(re.is_match(&a), "{a}");
        assert_ne!(a, b);
    }
    #[test]
    fn random_string_length_and_charset() {
        let mut r = rng();
        let s = eval_random_string(&RandomStringGen { length: 64 }, &mut r);
        assert_eq!(s.len(), 64);
        assert!(
            s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()),
            "{s}"
        );
    }
    #[test]
    fn seed_iter_vars_mixes_static_and_generated_and_regenerates() {
        let m = parse("base: \"http://x\"\nu: {gen: uuid}").unwrap();
        let mut r = rng();
        let a = seed_iter_vars(&m, &mut r);
        let b = seed_iter_vars(&m, &mut r);
        assert_eq!(a["base"], "http://x");
        assert_eq!(b["base"], "http://x");
        assert_ne!(a["u"], b["u"], "반복마다 재평가");
    }
}

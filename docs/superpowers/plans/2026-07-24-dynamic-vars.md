# 생성 변수 (dynamic-vars) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시나리오 `variables` 값을 4종 생성기(날짜/시간·랜덤 정수[step 격자]·UUID·랜덤 문자열)로 선언 — 반복마다 평가, 사용은 `{{var}}` 그대로, GUI(변수 패널 C안)/YAML 양방향.

**Architecture:** 엔진 신규 모듈 `genvars.rs`(VarDecl/GenSpec + wire-struct+`TryFrom` 검증 + 평가)를 `Scenario.variables: BTreeMap<String, VarDecl>`로 통합, 반복 시드 4곳(`runner.rs` 3 + `trace.rs` 1)을 `seed_iter_vars`로 교체. 검증은 parse-don't-validate(`Scenario::from_yaml`=게이트, 컨트롤러 src 0-diff). UI는 `genVars.ts`(Zod+요약+샘플) + `yamlDoc`/store 편집 + VariablesPanel C안(요약 행+그 자리 펼침).

**Tech Stack:** Rust(serde_yaml 0.9·chrono·chrono-tz·rand) / TS(Zod·zustand·yaml Document API·RTL).

**Spec:** `docs/superpowers/specs/2026-07-24-dynamic-vars-design.md` — 모든 요구/불변식의 정본. 아래 Global Constraints는 그 요약이다.

## Global Constraints

- **파라미터·검증 표 (spec §3.1 verbatim)**: `date`: `format` strftime 또는 `unix`/`unix_ms`(기본 `"%Y-%m-%d"`) · `offset` `^[+-]\d{1,9}[smhd]$` · `tz` IANA(생략=워커 로컬). `random_int`: `min ≤ max`(i64) · `step ≥ 1`(u32, 기본 1) · 값 집합 `{min + k·step ≤ max}` 균등, anchor=min. `uuid`: v4 소문자 하이픈, 수동 구현(**`uuid` crate 추가 금지** — rng 16바이트 + `b[6]=(b[6]&0x0F)|0x40; b[8]=(b[8]&0x3F)|0x80`). `random_string`: `length` 1..=64(기본 8), 문자군 `[a-z0-9]`.
- **평가 = 반복 시드 시점 1회** (같은 반복 내 스텝 간 값 공유). 우선순위 생성/정적 < 데이터셋 < extract (시드 직후 데이터셋 overlay — 기존 코드 무변경으로 성립).
- **생성기 rng는 전용 entropy rng** (`StdRng::from_entropy()`) — think rng(`think_seed`)와 절대 공유 금지 (난수열 교란·의도치 않은 재현성).
- **byte-identical**: 정적-only 시나리오는 파싱·재직렬화(plain string emit)·실행 전 경로 불변. `template.rs`·`cast.rs`·proto·migration·controller src·worker src **0-diff** (엔진 재컴파일만).
- **미지 키 거부 2경로 필수 + 이빨 실증**: `{gen: date, foo: 1}`(deny_unknown_fields) · `{gen: uuid, length: 5}`(TryFrom allow-list) — 각각 고의 회귀→RED→원복→GREEN.
- **UI 문구·aria-label 전부 `ko.ts` 경유**(ADR-0035), aria-label ⊇ 보이는 텍스트(WCAG 2.5.3). GUI 날짜 변수 생성 시 `tz` 항상 명시(기본 `Asia/Seoul`); "워커 로컬" 선택 = tz 키 제거.
- **게이트**: cargo `fmt`/`clippy -D warnings`/`nextest`+doctest, UI `pnpm lint`(--max-warnings=0)+`pnpm test`(전체)+`pnpm build`(`tsc -b` — union 리플·ES2022 lib은 build만 잡음). 게이트 판정은 파이프 없이 `; echo exit=$?`.
- **tdd-guard**: 각 task 첫 스텝은 테스트 파일 편집(Rust는 인라인 `#[cfg(test)]` 포함 파일 생성으로 충족).
- **Zod**: `GenSpecModel`은 model(authoring) 스키마 — 멤버 `.strict()`, cross-field 검증은 **union 레벨 `.superRefine`**(멤버에 붙이면 discriminatedUnion 거부 — BodyModel 함정). `.default()` 중첩 누출 금지.
- 커밋은 task마다 1개, cargo-영향 커밋은 `run_in_background` + 이후 `git log -1` 확인, `| tail` 금지.

---

### Task 1: 엔진 `genvars.rs` — VarDecl/GenSpec 모델·serde·검증·평가 (자족 모듈)

**Files:**
- Create: `crates/engine/src/genvars.rs`
- Modify: `crates/engine/src/lib.rs` (`mod genvars;` + `pub use genvars::{GenSpec, VarDecl, seed_iter_vars};` — 기존 re-export 블록 형식 따름)
- Modify: `crates/engine/Cargo.toml` (`[dependencies]`에 `chrono.workspace = true`, `chrono-tz.workspace = true` — 워크스페이스 루트 `Cargo.toml:16-17`에 이미 정의됨)
- Modify: 워크스페이스 루트 `Cargo.toml` — `chrono`/`chrono-tz`가 `[workspace.dependencies]`에 있는지 확인(현재 controller가 쓰므로 있음; 없으면 추가)

**Interfaces (Produces — Task 2/3이 소비):**
```rust
pub enum VarDecl { Static(String), Gen(GenSpec) }        // Debug+Clone+PartialEq+Eq, 수동 Serialize/Deserialize
pub enum GenSpec { Date(DateGen), RandomInt(RandomIntGen), Uuid, RandomString(RandomStringGen) }
pub struct DateGen { pub format: String, pub offset: Option<String>, pub tz: Option<String>,
                     pub(crate) offset_secs: i64, pub(crate) tz_parsed: Option<chrono_tz::Tz> }
pub struct RandomIntGen { pub min: i64, pub max: i64, pub step: u32 }
pub struct RandomStringGen { pub length: u32 }
pub fn seed_iter_vars(vars: &BTreeMap<String, VarDecl>, rng: &mut StdRng) -> BTreeMap<String, String>
```
`Scenario`는 이 task에서 **건드리지 않는다**(Task 2) — 모듈은 자기 테스트로 독립 green.

- [ ] **Step 1: 테스트 먼저 — `genvars.rs`를 테스트 모듈 포함으로 생성 (RED)**

파일 하단 `#[cfg(test)] mod tests`에 아래 배터리를 먼저 쓰고, 타입/함수는 컴파일 최소 스텁으로 시작한다(tdd-guard는 인라인 `#[cfg(test)]` 포함 파일이면 통과).

```rust
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
        assert!(!out.contains("gen:"), "정적 값은 plain string으로 emit: {out}");
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
        match &m["d"] { VarDecl::Gen(GenSpec::Date(g)) => {
            assert_eq!(g.format, "%Y-%m-%d");
            assert_eq!(g.offset, None);
            assert_eq!(g.tz, None);
        }, other => panic!("{other:?}") }
    }

    // ---- 거부 매트릭스 (spec §3.1/§3 serde 규칙) ----
    #[test]
    fn rejection_matrix() {
        for bad in [
            "x: {gen: nope}",                          // 미지원 gen
            "x: {gen: date, foo: 1}",                  // 미지 키 (deny_unknown_fields 경로)
            "x: {gen: uuid, length: 5}",               // cross-gen 키 (allow-list 경로)
            "x: {gen: random_int, min: 5, max: 1}",    // min > max
            "x: {gen: random_int, min: 1, max: 2, step: 0}",
            "x: {gen: random_int, max: 9}",            // min 누락
            "x: {gen: random_string, length: 0}",
            "x: {gen: random_string, length: 65}",
            "x: {gen: date, offset: \"7d\"}",          // 부호 없음
            "x: {gen: date, offset: \"+7w\"}",         // 미지 단위
            "x: {gen: date, tz: \"Mars/Olympus\"}",    // 미지 IANA
            "x: {gen: date, format: \"%Q\"}",          // 잘못된 strftime
            "x: 5",                                    // 비-문자열 스칼라 (현행과 동일 거부)
        ] {
            assert!(parse(bad).is_err(), "should reject: {bad}");
        }
    }

    // ---- 평가 ----
    fn rng() -> rand::rngs::StdRng { rand::rngs::StdRng::seed_from_u64(42) }

    #[test]
    fn date_eval_format_offset_tz() {
        let g = |y: &str| match parse(y).unwrap().remove("d").unwrap() {
            VarDecl::Gen(GenSpec::Date(g)) => g, other => panic!("{other:?}"),
        };
        // 2026-07-24 15:00:00 UTC = 2026-07-25 00:00:00 KST
        let now = Utc.with_ymd_and_hms(2026, 7, 24, 15, 0, 0).unwrap();
        assert_eq!(eval_date(&g("d: {gen: date, tz: Asia/Seoul}"), now), "2026-07-25");
        assert_eq!(eval_date(&g("d: {gen: date, tz: UTC}"), now), "2026-07-24");
        assert_eq!(eval_date(&g("d: {gen: date, offset: \"+7d\", tz: UTC}"), now), "2026-07-31");
        assert_eq!(eval_date(&g("d: {gen: date, offset: \"-2h\", format: \"%H:%M\", tz: UTC}"), now), "13:00");
        assert_eq!(eval_date(&g("d: {gen: date, format: unix}"), now), now.timestamp().to_string());
        assert_eq!(eval_date(&g("d: {gen: date, format: unix_ms, offset: \"+45s\"}"), now),
                   (now.timestamp_millis() + 45_000).to_string());
        assert_eq!(eval_date(&g("d: {gen: date, format: \"%Y년 %m월 %d일\", tz: UTC}"), now), "2026년 07월 24일");
    }
    #[test]
    fn random_int_stays_on_grid() {
        let g = RandomIntGen { min: 1005, max: 2000, step: 10 };
        let mut r = rng();
        for _ in 0..200 {
            let v: i64 = eval_random_int(&g, &mut r).parse().unwrap();
            assert!((1005..=1995).contains(&v), "{v}"); // 2000은 격자 밖(1005+99*10=1995)
            assert_eq!((v - 1005) % 10, 0, "{v}");
        }
        // step > max-min → 항상 min
        let g2 = RandomIntGen { min: 3, max: 5, step: 10 };
        assert_eq!(eval_random_int(&g2, &mut r), "3");
        // i64 극단 span 오버플로 없음
        let g3 = RandomIntGen { min: i64::MIN, max: i64::MAX, step: 1 };
        let _ = eval_random_int(&g3, &mut r);
    }
    #[test]
    fn uuid_v4_format_and_uniqueness() {
        let mut r = rng();
        let a = eval_uuid(&mut r);
        let b = eval_uuid(&mut r);
        let re = regex::Regex::new(
            r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$").unwrap();
        assert!(re.is_match(&a), "{a}");
        assert_ne!(a, b);
    }
    #[test]
    fn random_string_length_and_charset() {
        let mut r = rng();
        let s = eval_random_string(&RandomStringGen { length: 64 }, &mut r);
        assert_eq!(s.len(), 64);
        assert!(s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()), "{s}");
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
```

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-engine genvars 2>&1; echo exit=$?` → 컴파일 실패 또는 FAIL.

- [ ] **Step 3: 구현** — 같은 파일 상단에 전체 구현:

```rust
//! 생성 변수 (spec 2026-07-24-dynamic-vars): variables 값의 두 형태(정적 문자열 | 생성기 맵)와
//! 반복-시드 평가. 검증은 wire-struct(GenSpecWire, deny_unknown_fields) + TryFrom 단일 경로 —
//! `Scenario::from_yaml`이 곧 authoring 게이트다(컨트롤러 별도 validator 없음).
use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use chrono::format::{Item, StrftimeItems};
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use rand::rngs::StdRng;
use rand::Rng;
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
pub struct RandomIntGen { pub min: i64, pub max: i64, pub step: u32 }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RandomStringGen { pub length: u32 }

/// 와이어 형태 — plain struct라 deny_unknown_fields가 확실히 동작(내부 태그 enum 미보증 함정 회피).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GenSpecWire {
    gen: String,
    #[serde(default)] format: Option<String>,
    #[serde(default)] offset: Option<String>,
    #[serde(default)] tz: Option<String>,
    #[serde(default)] min: Option<i64>,
    #[serde(default)] max: Option<i64>,
    #[serde(default)] step: Option<u32>,
    #[serde(default)] length: Option<u32>,
}

fn parse_offset_secs(s: &str) -> Option<i64> {
    let (sign, rest) = match s.as_bytes().first()? {
        b'+' => (1i64, &s[1..]),
        b'-' => (-1i64, &s[1..]),
        _ => return None,
    };
    if rest.len() < 2 { return None; }
    let (digits, unit) = rest.split_at(rest.len() - 1);
    if digits.is_empty() || digits.len() > 9 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: i64 = digits.parse().ok()?;
    let mult = match unit { "s" => 1, "m" => 60, "h" => 3600, "d" => 86400, _ => return None };
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
        match w.gen.as_str() {
            "date" => {
                deny(w.min.is_some() || w.max.is_some() || w.step.is_some() || w.length.is_some(),
                     "date 생성기는 min/max/step/length를 받지 않는다")?;
                let format = w.format.unwrap_or_else(|| "%Y-%m-%d".to_string());
                if format != "unix" && format != "unix_ms" && !strftime_valid(&format) {
                    return Err(format!("잘못된 날짜 형식: {format}"));
                }
                let offset_secs = match &w.offset {
                    Some(o) => parse_offset_secs(o).ok_or_else(|| format!("잘못된 오프셋: {o} (예: +7d, -2h)"))?,
                    None => 0,
                };
                let tz_parsed = match &w.tz {
                    Some(t) => Some(Tz::from_str(t).map_err(|_| format!("알 수 없는 타임존: {t}"))?),
                    None => None,
                };
                Ok(GenSpec::Date(DateGen { format, offset: w.offset, tz: w.tz, offset_secs, tz_parsed }))
            }
            "random_int" => {
                deny(w.format.is_some() || w.offset.is_some() || w.tz.is_some() || w.length.is_some(),
                     "random_int 생성기는 format/offset/tz/length를 받지 않는다")?;
                let (min, max) = match (w.min, w.max) {
                    (Some(a), Some(b)) => (a, b),
                    _ => return Err("random_int는 min·max가 필수".into()),
                };
                if min > max { return Err(format!("min({min}) > max({max})")); }
                let step = w.step.unwrap_or(1);
                if step == 0 { return Err("step은 1 이상".into()); }
                Ok(GenSpec::RandomInt(RandomIntGen { min, max, step }))
            }
            "uuid" => {
                deny(w.format.is_some() || w.offset.is_some() || w.tz.is_some()
                     || w.min.is_some() || w.max.is_some() || w.step.is_some() || w.length.is_some(),
                     "uuid 생성기는 파라미터를 받지 않는다")?;
                Ok(GenSpec::Uuid)
            }
            "random_string" => {
                deny(w.format.is_some() || w.offset.is_some() || w.tz.is_some()
                     || w.min.is_some() || w.max.is_some() || w.step.is_some(),
                     "random_string 생성기는 length만 받는다")?;
                let length = w.length.unwrap_or(8);
                if !(1..=64).contains(&length) { return Err(format!("length는 1~64: {length}")); }
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
                GenSpec::try_from(wire).map(VarDecl::Gen).map_err(de::Error::custom)
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
                if let Some(o) = &g.offset { m.serialize_entry("offset", o)?; }
                if let Some(t) = &g.tz { m.serialize_entry("tz", t)?; }
                m.end()
            }
            GenSpec::RandomInt(g) => {
                let n = 3 + (g.step != 1) as usize;
                let mut m = s.serialize_map(Some(n))?;
                m.serialize_entry("gen", "random_int")?;
                m.serialize_entry("min", &g.min)?;
                m.serialize_entry("max", &g.max)?;
                if g.step != 1 { m.serialize_entry("step", &g.step)?; }
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
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    )
}

const RS_CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";

pub(crate) fn eval_random_string(g: &RandomStringGen, rng: &mut StdRng) -> String {
    (0..g.length).map(|_| RS_CHARS[rng.gen_range(0..RS_CHARS.len())] as char).collect()
}

/// 반복 시드: 정적은 clone, 생성기는 지금 평가. 호출부(runner 3곳·trace 1곳)가
/// **생성기 전용** entropy rng를 넘긴다 — think rng 공유 금지 (spec §4).
pub fn seed_iter_vars(vars: &BTreeMap<String, VarDecl>, rng: &mut StdRng) -> BTreeMap<String, String> {
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
```

`regex`는 이미 engine dev-dependency가 아니면 uuid 테스트에서 `regex::Regex` 사용을 위해 `[dev-dependencies]` 확인(엔진 `[dependencies]`에 `regex` 이미 있음 — `Cargo.toml:14` — 그대로 사용).

- [ ] **Step 4: GREEN + 이빨 실증** — `cargo test -p handicap-engine genvars 2>&1; echo exit=$?` → 전부 PASS. 이빨: `GenSpecWire`의 `#[serde(deny_unknown_fields)]` 한 줄을 임시 제거 → `rejection_matrix`의 `{gen: date, foo: 1}` 케이스 FAIL 확인 → 원복 GREEN. `TryFrom`의 uuid `deny(...)` 한 줄 임시 무력화 → `{gen: uuid, length: 5}` FAIL 확인 → 원복 GREEN. (두 경로 각각.)

- [ ] **Step 5: fmt/clippy 후 커밋** — `cargo fmt && cargo clippy -p handicap-engine -- -D warnings 2>&1; echo exit=$?` → `git add crates/engine/src/genvars.rs crates/engine/src/lib.rs crates/engine/Cargo.toml Cargo.toml && git commit`(background, 이후 `git log -1` 확인) — `feat(engine): genvars 모듈 — VarDecl/GenSpec serde·검증·평가 (dynamic-vars T1)`.

---

### Task 2: `Scenario.variables` 통합 + 반복 시드 4곳 배선

**Files:**
- Modify: `crates/engine/src/scenario.rs:16` (variables 타입), `crates/engine/src/runner.rs:387-397`·`:1077-1125`·`:1478`(시드 3곳+rng), `crates/engine/src/trace.rs:251`(시드 1곳+rng)
- Test: `crates/engine/tests/genvars_wiring.rs` (신규), `crates/engine/src/scenario.rs` 테스트 모듈(round-trip 추가)

**Interfaces:**
- Consumes: Task 1의 `VarDecl`/`seed_iter_vars`.
- Produces: `Scenario.variables: BTreeMap<String, VarDecl>` — Task 3(컨트롤러 게이트 테스트)·워커는 재컴파일만.

- [ ] **Step 1: 테스트 먼저 — `tests/genvars_wiring.rs` (RED)**

`tests/think_time.rs`의 `Mode`/`count_all` 하니스를 미러하되 **요청 관찰**로: wiremock `server.received_requests()`로 실제 나간 쿼리 값을 검사한다.

```rust
// 3개 부하 진입점(run_scenario/run_scenario_vu_curve/run_scenario_open_loop) 각각이
// 생성기를 시드하는지 — 한 진입점만 테스트하면 나머지 배선 누락이 green(레포 함정).
use handicap_engine::{MetricFlush, RampDown, RunPlan, Scenario, Stage,
    run_scenario, run_scenario_open_loop, run_scenario_vu_curve};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

#[derive(Clone, Copy)]
enum Mode { Closed, Curve, Open }

const TWO_STEP: &str = "version: 1
name: g
variables:
  oid: {gen: uuid}
  qty: {gen: random_int, min: 1000, max: 2000, step: 100}
steps:
  - id: \"01HX0000000000000000000001\"
    name: a
    type: http
    request: { method: GET, url: \"{URI}/a?oid={{oid}}&qty={{qty}}\" }
  - id: \"01HX0000000000000000000002\"
    name: b
    type: http
    request: { method: GET, url: \"{URI}/b?oid={{oid}}\" }
";

async fn run_and_collect(mode: Mode, dur_ms: u64) -> Vec<HashMap<String, String>> {
    let server = MockServer::start().await;
    Mock::given(method("GET")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
    let yaml = TWO_STEP.replace("{URI}", &server.uri());
    let scenario = Arc::new(Scenario::from_yaml(&yaml).unwrap());
    let mut plan = RunPlan {
        vus: 1, ramp_up: Duration::ZERO, duration: Duration::from_millis(dur_ms),
        env: Default::default(), loop_breakdown_cap: 0, vu_offset: 0, data_bindings: vec![],
        http_timeout: Duration::from_secs(30), think_time: None, think_seed: None,
        target_rps: None, max_in_flight: None, stages: None, measure_phases: false,
        vu_stages: None, ramp_down: RampDown::Graceful, graceful_ramp_down: None,
    };
    match mode {
        Mode::Closed => {}
        Mode::Curve => plan.vu_stages = Some(vec![Stage { target: 1, duration_seconds: 1 }]),
        Mode::Open => { plan.target_rps = Some(20); plan.max_in_flight = Some(4); plan.vus = 0; }
    }
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let cancel = CancellationToken::new();
    let h = match mode {
        Mode::Closed => tokio::spawn(run_scenario(scenario, plan, tx, cancel)),
        Mode::Curve => tokio::spawn(run_scenario_vu_curve(scenario, plan, tx, cancel)),
        Mode::Open => tokio::spawn(run_scenario_open_loop(scenario, plan, tx, cancel)),
    };
    while rx.recv().await.is_some() {}
    h.await.unwrap().unwrap();
    server.received_requests().await.unwrap().iter().map(|r| {
        let mut q: HashMap<String, String> = r.url.query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        q.insert("__path".into(), r.url.path().to_string());
        q
    }).collect()
}

fn assert_generated(reqs: &[HashMap<String, String>]) {
    assert!(reqs.len() >= 2, "at least one full iteration");
    let uuid_re = regex::Regex::new(
        r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$").unwrap();
    for r in reqs {
        assert!(uuid_re.is_match(&r["oid"]), "리터럴 {{{{oid}}}}가 아니라 생성 값이어야: {:?}", r);
        if r["__path"] == "/a" {
            let q: i64 = r["qty"].parse().unwrap();
            assert!((1000..=2000).contains(&q) && (q - 1000) % 100 == 0, "{q}");
        }
    }
    // 같은 반복의 a/b는 같은 oid 공유: /a 직후 /b가 오는 쌍 검사(1 VU 순차라 인접).
    let pair = reqs.windows(2).find(|w| w[0]["__path"] == "/a" && w[1]["__path"] == "/b");
    if let Some(w) = pair { assert_eq!(w[0]["oid"], w[1]["oid"], "반복 내 값 공유"); }
    // 반복 간 재평가: 서로 다른 oid가 존재(uuid 충돌 확률 0에 수렴).
    let oids: std::collections::HashSet<_> = reqs.iter()
        .filter(|r| r["__path"] == "/a").map(|r| r["oid"].clone()).collect();
    if reqs.iter().filter(|r| r["__path"] == "/a").count() >= 2 {
        assert!(oids.len() >= 2, "반복마다 새 값이어야: {oids:?}");
    }
}

#[tokio::test]
async fn closed_loop_seeds_generators() { assert_generated(&run_and_collect(Mode::Closed, 500).await); }
#[tokio::test]
async fn vu_curve_seeds_generators() { assert_generated(&run_and_collect(Mode::Curve, 1000).await); }
#[tokio::test]
async fn open_loop_seeds_generators() { assert_generated(&run_and_collect(Mode::Open, 700).await); }

#[tokio::test]
async fn trace_rows_regenerate_per_row() {
    // trace_scenario_rows: 행마다 trace_once → 생성기 행별 재평가 (spec §4).
    // steps: []라 HTTP 서버 불필요 — final_vars(시드 종점)로 단언.
    use handicap_engine::{TraceOptions, trace_scenario_rows};
    let scenario = Scenario::from_yaml(
        "version: 1\nname: t\nvariables:\n  oid: {gen: uuid}\nsteps: []").unwrap();
    let opts = TraceOptions {
        env: Default::default(),
        max_requests: 10,
        max_wall: Duration::from_secs(5),
        apply_think_time: false,
    };
    let rt = trace_scenario_rows(&scenario, &opts,
        &[(0, Default::default()), (1, Default::default())]).await;
    assert_eq!(rt.rows.len(), 2);
    assert_ne!(rt.rows[0].trace.final_vars["oid"], rt.rows[1].trace.final_vars["oid"]);
}
```

wiremock `received_requests`는 기본 기록 활성(`MockServer::start`). `TraceOptions`/`trace_scenario_rows`/`RowsTrace`는 이미 pub 재수출(controller `test_runs.rs:8`이 import).

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-engine --test genvars_wiring 2>&1; echo exit=$?` → 컴파일 에러(variables 타입 불일치) = RED.

- [ ] **Step 3: 배선 구현**

`scenario.rs:16`:
```rust
use crate::genvars::VarDecl;
// ...
    #[serde(default)]
    pub variables: BTreeMap<String, VarDecl>,
```

`runner.rs` run_vu(387 인근): think_rng 생성 직후에 추가·시드 교체:
```rust
    // 생성기 전용 rng — think_rng와 분리 (spec §4: 난수열 교란·의도치 않은 재현성 방지).
    let mut gen_rng = StdRng::from_entropy();
    let mut iter_id: u32 = 0;
    while Instant::now() < deadline {
        // ...
        let mut iter_vars: BTreeMap<String, String> =
            crate::genvars::seed_iter_vars(&scenario.variables, &mut gen_rng);
```

`runner.rs` run_vu_curve(1077 인근): 동일 패턴 — per-VU `gen_rng` 1개(park를 넘어 지속, think_rng와 같은 수명), `:1125` 시드 교체.

`runner.rs` run_arrival(1478): 함수 서두에 지역 rng(arrival=1 반복이므로 per-arrival 생성이 곧 per-iteration):
```rust
    let mut gen_rng = StdRng::from_entropy();
    let mut iter_vars: BTreeMap<String, String> =
        crate::genvars::seed_iter_vars(&scenario.variables, &mut gen_rng);
```

`trace.rs` trace_once(251):
```rust
    let mut gen_rng = rand::rngs::StdRng::from_entropy();
    let mut iter_vars: BTreeMap<String, String> =
        crate::genvars::seed_iter_vars(&scenario.variables, &mut gen_rng);
    for (k, v) in seed_vars { /* 기존 데이터셋 overlay 루프 무변경 — 우선순위 생성<데이터셋 */ }
```
(trace.rs에 `use rand::SeedableRng;` 필요 여부는 컴파일러가 알려줌.)

이후 `cargo build --workspace 2>&1; echo exit=$?`로 **컴파일 리플 전수 수정**: `scenario.variables`를 `BTreeMap<String,String>`로 다루던 엔진/워커/컨트롤러 코드·테스트(예: 문자열 insert하는 fixture)는 `VarDecl::Static(...)` 또는 YAML 경유로 교체. e2e/통합 테스트는 전부 YAML 문자열이라 무변경 예상 — 컴파일러가 최종 판정.

Step 1의 `todo!` trace 테스트를 실제 `trace_scenario_rows`(또는 공개 wrapper — `crates/engine/src/trace.rs`에서 `pub` 시그니처 확인) 호출로 완성: uuid 변수 1개 + http 1스텝 시나리오, 2행 데이터셋 seed로 두 행 trace의 요청 URL 속 oid 상이 단언.

- [ ] **Step 4: round-trip·정적 golden 테스트 추가 (scenario.rs 테스트 모듈)**

```rust
#[test]
fn static_only_scenario_serializes_without_gen_keys() {
    let s = Scenario::from_yaml(FIXTURE).unwrap(); // 기존 fixture = 정적 변수만
    let out = s.to_yaml().unwrap();
    assert!(!out.contains("gen:"));
    assert_eq!(Scenario::from_yaml(&out).unwrap(), s);
}
#[test]
fn generator_scenario_roundtrips() {
    let y = "version: 1\nname: g\nvariables:\n  d: {gen: date, offset: \"+7d\", tz: Asia/Seoul}\nsteps: []";
    let s = Scenario::from_yaml(y).unwrap();
    assert_eq!(Scenario::from_yaml(&s.to_yaml().unwrap()).unwrap(), s);
}
```

- [ ] **Step 5: GREEN** — `cargo nextest run -p handicap-engine 2>&1; echo exit=$?` 전체 PASS + `cargo test -p handicap-engine --doc`.
- [ ] **Step 6: 전체 워크스페이스 게이트 후 커밋** — `cargo fmt && cargo build --workspace && cargo clippy --workspace -- -D warnings && cargo nextest run 2>&1; echo exit=$?` → 커밋 `feat(engine): variables VarDecl 통합 + 4 시드 사이트 생성기 배선 (dynamic-vars T2)` (background).

---

### Task 3: 컨트롤러 게이트 통합 테스트 (src 0-diff)

**Files:**
- Test: `crates/controller/tests/scenario_genvars_gate_test.rs` (신규 — `scenario_branch_validation_test.rs`의 앱 부트스트랩/요청 헬퍼 미러)

**Interfaces:** Consumes Task 2 (`from_yaml`이 생성기 검증 포함). 컨트롤러 src 변경 **0** — 테스트가 그걸 증명한다.

- [ ] **Step 1: 테스트 작성 (RED 아님 주의 — Task 2가 이미 기능 완성이라 이 테스트는 즉시 GREEN이어야 정상. 목적 = 게이트 회귀 락인)**

케이스(각각 독립 `#[tokio::test]`, 기존 파일의 create-scenario 헬퍼 재사용):
- `POST /api/scenarios` body에 `variables: {x: {gen: date, foo: 1}}` → **400** + 본문에 에러 문구.
- `{gen: uuid, length: 5}` → 400 · `{gen: random_int, min: 5, max: 1}` → 400 · `{gen: date, tz: Mars/Olympus}` → 400 · `{gen: date, offset: "7d"}` → 400.
- 유효 생성기 4종 전부 담은 시나리오 → **200/201** + `GET /api/scenarios/{id}`의 `yaml`에 `gen:` 보존.
- `POST /api/test-runs`에 `{gen: nope}` 시나리오 → **422**.
- `PUT /api/scenarios/{id}`로 잘못된 생성기 업데이트 → 400 (update 게이트 `scenarios.rs:198`).

- [ ] **Step 2: GREEN 확인** — `cargo nextest run -p handicap-controller --test scenario_genvars_gate_test 2>&1; echo exit=$?`. 이빨 실증: Task 1의 `deny_unknown_fields`를 임시 제거하고 이 테스트만 재실행 → `{gen: date, foo: 1}` 케이스 FAIL 확인 → 원복.
- [ ] **Step 3: 커밋** — `test(controller): 생성기 authoring 게이트 400/422 락인 (dynamic-vars T3)` (background).

---

### Task 4: UI `genVars.ts` 모듈 + 모델 union (컴파일 리플 최소 어댑터)

**Files:**
- Create: `ui/src/scenario/genVars.ts`, `ui/src/scenario/__tests__/genVars.test.ts`
- Modify: `ui/src/scenario/model.ts:403` (variables union), `ui/src/components/scenario/VariablesPanel.tsx` (string-가정 2지점 어댑터), `ui/src/i18n/ko.ts` (`ko.editor`에 요약·배지 키)

**Interfaces (Produces — Task 5/6이 소비):**
```ts
export const GenSpecModel: z.ZodType<GenSpec>  // discriminatedUnion("gen") + union-level superRefine
export type GenSpec = { gen: "date"; format?: string; offset?: string; tz?: string }
  | { gen: "random_int"; min: number; max: number; step?: number }
  | { gen: "uuid" } | { gen: "random_string"; length?: number };
export type VarDeclValue = string | GenSpec;
export function isGenSpec(v: VarDeclValue): v is GenSpec;
export function genTypeLabel(spec: GenSpec): string;          // ko 경유 배지 문구
export function genSummary(spec: GenSpec): string;            // "오늘+7일 · Asia/Seoul" 등 (ko 경유)
export function declSearchText(v: VarDeclValue): string;      // 검색 매치 대상 (정적=값, 생성기=요약)
export type SamplePreview = { kind: "ok"; text: string } | { kind: "unsupported" };
export function sampleFor(spec: GenSpec, now?: Date): SamplePreview;
export const DATE_FORMAT_PRESETS: { value: string; labelKey: ... }[]; // %Y-%m-%d/%Y-%m-%dT%H:%M:%S/unix/unix_ms
```

- [ ] **Step 1: 테스트 먼저 (`genVars.test.ts`, RED)** — 배터리:
  - `GenSpecModel` 수용: 유효 4종(기본값 생략형 포함) / 거부: 미지 키(strict)·`min>max`(superRefine)·`step:0`·`length:0|65`·offset 형식(`7d`·`+7w`) — **union 멤버가 아니라 union 레벨 superRefine임을 파괴 테스트로**: 거부 케이스가 `safeParse.success===false`.
  - `sampleFor`: `{gen:"date", format:"%Y-%m-%d", tz:"UTC", offset:"+7d"}` + 주입 `now`(예: `new Date(Date.UTC(2026,6,24,15,0,0))`) → `"2026-07-31"`; `%Y년 %m월 %d일` → `"2026년 07월 24일"`(tz UTC); `%H:%M` offset `-2h` → `"13:00"`; `unix`/`unix_ms` → epoch 문자열; **부분집합 밖 `%j`** → `{kind:"unsupported"}`; `random_int` 샘플은 격자 소속; `uuid` 샘플 v4 regex; `random_string` 길이·문자군.
  - `genSummary`: `{gen:"date",offset:"+7d",tz:"Asia/Seoul"}` → `"오늘+7일 · Asia/Seoul"`(d→일/h→시간/m→분/s→초 변환·offset 없음=`"오늘"`·tz 없음=ko.editor 워커 로컬 문구), `random_int` step≠1 → `"1000 ~ 10000 · 100 단위"`·step 1 → `"1 ~ 100"`, uuid/random_string 요약.
  - `declSearchText`: 정적=값 그대로 / 생성기=요약.

- [ ] **Step 2: RED 확인** — `pnpm test genVars 2>&1; echo exit=$?`.

- [ ] **Step 3: 구현 `genVars.ts`**

핵심 코드(전체 — Zod·strftime 부분집합·Intl tz):

```ts
import { z } from "zod";
import { ko } from "../i18n/ko";

export const OFFSET_RE = /^[+-]\d{1,9}[smhd]$/;

const DateGenModel = z.object({
  gen: z.literal("date"),
  format: z.string().optional(),
  offset: z.string().regex(OFFSET_RE, "offset").optional(),
  tz: z.string().optional(),
}).strict();
const RandomIntGenModel = z.object({
  gen: z.literal("random_int"),
  min: z.number().int(),
  max: z.number().int(),
  step: z.number().int().min(1).optional(),
}).strict();
const UuidGenModel = z.object({ gen: z.literal("uuid") }).strict();
const RandomStringGenModel = z.object({
  gen: z.literal("random_string"),
  length: z.number().int().min(1).max(64).optional(),
}).strict();

// cross-field(min≤max)는 union 레벨 superRefine — 멤버에 붙이면 ZodEffects라
// discriminatedUnion이 거부한다 (BodyModel/StepModel 함정).
export const GenSpecModel = z
  .discriminatedUnion("gen", [DateGenModel, RandomIntGenModel, UuidGenModel, RandomStringGenModel])
  .superRefine((v, ctx) => {
    if (v.gen === "random_int" && v.min > v.max)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "min > max", path: ["min"] });
  });
export type GenSpec = z.infer<typeof GenSpecModel>;
export type VarDeclValue = string | GenSpec;

export function isGenSpec(v: VarDeclValue): v is GenSpec {
  return typeof v !== "string";
}

const OFFSET_UNIT_KO: Record<string, string> = { d: "일", h: "시간", m: "분", s: "초" };

export function offsetKo(offset: string | undefined): string {
  if (!offset) return ko.editor.genDateToday;                 // "오늘"
  const unit = offset[offset.length - 1];
  return `${ko.editor.genDateToday}${offset.slice(0, -1)}${OFFSET_UNIT_KO[unit] ?? unit}`;
}
export function genTypeLabel(spec: GenSpec): string {
  switch (spec.gen) {
    case "date": return ko.editor.genTypeDate;
    case "random_int": return ko.editor.genTypeRandomInt;
    case "uuid": return ko.editor.genTypeUuid;
    case "random_string": return ko.editor.genTypeRandomString;
  }
}

export function genSummary(spec: GenSpec): string {
  switch (spec.gen) {
    case "date":
      return `${offsetKo(spec.offset)} · ${spec.tz ?? ko.editor.genTzWorkerLocal}`;
    case "random_int": {
      const base = `${spec.min} ~ ${spec.max}`;
      const step = spec.step ?? 1;
      return step === 1 ? base : `${base} · ${step} ${ko.editor.genStepUnit}`;
    }
    case "uuid": return ko.editor.genTypeUuid;
    case "random_string": return `${ko.editor.genTypeRandomString} · ${spec.length ?? 8}`;
  }
}

export function declSearchText(v: VarDeclValue): string {
  return isGenSpec(v) ? genSummary(v) : v;
}

// ---- 샘플 미리보기: strftime 부분집합 (spec §6.3 — %Y %y %m %d %H %M %S %s %%만; 밖이면 unsupported) ----
type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function partsIn(tz: string | undefined, at: Date): Parts {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, // undefined = 브라우저 로컬 ("워커 로컬" 근사 — spec §6.3)
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(at)) p[part.type] = part.value;
  return { year: +p.year, month: +p.month, day: +p.day,
           hour: +p.hour % 24, minute: +p.minute, second: +p.second };
}

const OFFSET_SECS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function offsetSeconds(offset: string | undefined): number {
  if (!offset || !OFFSET_RE.test(offset)) return 0;
  const sign = offset[0] === "-" ? -1 : 1;
  return sign * Number(offset.slice(1, -1)) * OFFSET_SECS[offset[offset.length - 1]];
}

export function formatStrftimeSubset(fmt: string, p: Parts, epochSecs: number): string | null {
  let out = "";
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== "%") { out += fmt[i]; continue; }
    const c = fmt[++i];
    const pad = (n: number, w: number) => String(n).padStart(w, "0");
    switch (c) {
      case "Y": out += String(p.year); break;
      case "y": out += pad(p.year % 100, 2); break;
      case "m": out += pad(p.month, 2); break;
      case "d": out += pad(p.day, 2); break;
      case "H": out += pad(p.hour, 2); break;
      case "M": out += pad(p.minute, 2); break;
      case "S": out += pad(p.second, 2); break;
      case "s": out += String(epochSecs); break;
      case "%": out += "%"; break;
      default: return null; // 부분집합 밖 — 거짓 미리보기 금지
    }
  }
  return out;
}

export function sampleFor(spec: GenSpec, now: Date = new Date()): SamplePreview {
  switch (spec.gen) {
    case "date": {
      const at = new Date(now.getTime() + offsetSeconds(spec.offset) * 1000);
      const fmt = spec.format ?? "%Y-%m-%d";
      if (fmt === "unix") return { kind: "ok", text: String(Math.floor(at.getTime() / 1000)) };
      if (fmt === "unix_ms") return { kind: "ok", text: String(at.getTime()) };
      const tz = spec.tz; // undefined → 브라우저 로컬
      const text = formatStrftimeSubset(fmt, partsIn(tz, at), Math.floor(at.getTime() / 1000));
      return text === null ? { kind: "unsupported" } : { kind: "ok", text };
    }
    case "random_int": {
      const step = spec.step ?? 1;
      const k = Math.floor(Math.random() * (Math.floor((spec.max - spec.min) / step) + 1));
      return { kind: "ok", text: String(spec.min + k * step) };
    }
    case "uuid": {
      const b = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      const h = b.map((x) => x.toString(16).padStart(2, "0"));
      return { kind: "ok", text: `${h.slice(0,4).join("")}-${h.slice(4,6).join("")}-${h.slice(6,8).join("")}-${h.slice(8,10).join("")}-${h.slice(10).join("")}` };
    }
    case "random_string": {
      const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
      const n = spec.length ?? 8;
      return { kind: "ok", text: Array.from({ length: n },
        () => chars[Math.floor(Math.random() * chars.length)]).join("") };
    }
  }
}
```

`ko.ts`(`ko.editor`)에 신규 키: `genTypeDate: "날짜"`, `genTypeRandomInt: "랜덤 정수"`, `genTypeUuid: "UUID"`, `genTypeRandomString: "랜덤 문자열"`, `genDateToday: "오늘"`, `genTzWorkerLocal: "워커 로컬"`, `genStepUnit: "단위"`, `genSamplePrefix: "예:"`, `genSampleUnsupported: "미리보기 불가 — 실행 시 적용"` — **기존 카탈로그와 양방향 부분문자열 충돌 grep 필수**(`toHaveTextContent` 부분매칭 함정 — thinkboard-defaults).

- [ ] **Step 4: `model.ts` union + 어댑터**

```ts
// model.ts:403
variables: z.record(z.string(), z.union([z.string(), GenSpecModel])).default({}),
```
`VariablesPanel.tsx`의 string-가정 2지점을 어댑터로(이 task에선 **표시만** — 편집기는 Task 6):
- declared 행 구성(`:103`): `value`가 `isGenSpec`이면 `kind:"declared-gen"` 행 variant(요약 문자열만 들고 감) — 렌더는 임시로 `<span className="text-xs text-slate-500">{genSummary(v)}</span>`(textarea 미렌더·rename/×/사용처는 동일).
- `matchesRow`(`:241`): `r.value.toLowerCase()` → `declSearchText(v).toLowerCase()`.
`tsc -b`가 잡는 그 밖의 리플은 그 자리에서 수정(사전 조사상 없음 — scanVars/DataBindingPanel/InsertTemplateModal은 키만 소비).

- [ ] **Step 5: GREEN + 전체 게이트** — `pnpm test genVars`·`pnpm test`(전체)·`pnpm lint`·`pnpm build` 각각 `; echo exit=$?`. build가 union 리플의 최종 판정.
- [ ] **Step 6: 커밋** — `feat(ui): genVars 모듈(Zod·요약·샘플 부분집합)+variables 모델 union (dynamic-vars T4)`.

---

### Task 5: yamlDoc/store 편집 경로 — `setVariableGen` (스칼라↔맵)

**Files:**
- Modify: `ui/src/scenario/yamlDoc.ts` (Edit union `:39` 인근 + applyEdit `:156` 인근), `ui/src/scenario/store.ts` (액션)
- Test: `ui/src/scenario/__tests__/yamlDoc.test.ts`(기존 파일에 추가 — 실제 경로는 `ls ui/src/scenario/__tests__/`로 확인), store 테스트 파일

**Interfaces:**
- Produces: Edit `{ type: "setVariableGen"; key: string; spec: GenSpec }` · store `setVariableGen(key: string, spec: GenSpec): void` (기존 `setVariable`/`removeVariable`/`renameVariable`과 동일한 dispatch 게이트 — `yamlError!==null`이면 no-op).

- [ ] **Step 1: 테스트 먼저 (RED)** — 케이스:
  - `setVariableGen("d", {gen:"date",format:"%Y-%m-%d",tz:"Asia/Seoul"})` → yamlText에 `gen: date` 포함 + `parseScenarioDoc` round-trip에서 `model.variables.d`가 GenSpec.
  - 생성기 → `setVariable("d","v")` → 스칼라 복귀(맵 키 잔존 없음).
  - 생성기 파라미터 변경(`setVariableGen` 재호출) → 값 갱신.
  - `removeVariable`/`renameVariable`이 생성기 행에서 동작(rename은 in-place 키 rename이라 값 맵 노드·주석 보존 — 기존 (a) 패스).
  - 같은 spec 객체로 2회 호출해도 앵커/별칭(`&`/`*`) 미발생(`yamlText`에 `&` 부재 — `doc.createNode`를 호출마다 새로).
  - 다른 변수의 주석이 보존됨(targeted edit).
- [ ] **Step 2: RED 확인** — `pnpm test yamlDoc 2>&1; echo exit=$?`.
- [ ] **Step 3: 구현**

```ts
// Edit union에 추가
| { type: "setVariableGen"; key: string; spec: GenSpec }
// applyEdit
case "setVariableGen": {
  ensureMap(doc, ["variables"]);
  // spec은 GenSpecModel 통과형 — undefined 필드 제거 후 createNode(호출마다 새로: 앵커 함정)
  const clean = Object.fromEntries(Object.entries(edit.spec).filter(([, v]) => v !== undefined));
  doc.setIn(["variables", edit.key], doc.createNode(clean));
  return;
}
```
store: `setVariableGen(key, spec) { dispatch(set, get, { type: "setVariableGen", key, spec }); }` (기존 `setVariable` 이웃에, 타입 시그니처 포함).
- [ ] **Step 4: GREEN + 게이트** — `pnpm test`(전체)+`lint`+`build` `; echo exit=$?`.
- [ ] **Step 5: 커밋** — `feat(ui): setVariableGen 편집 경로 — 스칼라↔맵 왕복·주석 보존 (dynamic-vars T5)`.

---

### Task 6: VariablesPanel C안 — 요약 행 + 그 자리 펼침 편집기

**Files:**
- Create: `ui/src/components/scenario/GenVarEditor.tsx`(펼침 편집기 서브컴포넌트), `ui/src/components/scenario/useIntPairDraft.ts`(min/max 짝 draft 훅)
- Modify: `ui/src/components/scenario/VariablesPanel.tsx`, `ui/src/i18n/ko.ts`
- Test: `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx`(기존 확장), `__tests__/GenVarEditor.test.tsx`(신규)

**Interfaces:**
- Consumes: Task 4 `genVars.ts` 전부, Task 5 `setVariableGen`.
- Produces: 사용자-가시 C안 UI — 이후 task 없음(Task 7이 스모크만).

**UI 계약 (목업 v2 = 시각 정본, spec §6.1–6.3):**
- 모든 declared 행에 ▸/▾ 토글(버튼, aria-label = `ko.editor.varExpandAria(name)` — 보이는 caret은 aria-hidden). 펼침 상태는 컴포넌트 로컬 `Set<string>`(영속화 없음).
- 정적 행: 접힘에도 값 textarea 노출(현행 유지) — 펼치면 타입 select가 textarea 위에 추가.
- 생성기 행 접힘: `[▸ 이름 · 타입 배지 · ×]` + `[요약 · 예: 샘플]` + 사용처. 배지 스타일 `rounded bg-indigo-50 px-1.5 text-xs text-indigo-600`(기존 amber 배지 이디엄 미러) + `title`.
- 생성기 행 펼침: `GenVarEditor` — 타입 select(값: static/date/random_int/uuid/random_string, **즉시 커밋**) + 타입별 필드 + 샘플 줄(`ko.editor.genSamplePrefix` + `sampleFor` — unsupported면 `genSampleUnsupported` 문구).
- 타입 전환 기본 스펙: date=`{gen:"date", format:"%Y-%m-%d", tz:"Asia/Seoul"}`(**tz 명시 — spec §6.4**) · random_int=`{gen:"random_int", min:1, max:100}` · uuid=`{gen:"uuid"}` · random_string=`{gen:"random_string", length:8}` · static 전환=`setVariable(key, "")`.
- 날짜 필드: 형식 프리셋 `Select`(`DATE_FORMAT_PRESETS` + `직접 입력…`; YAML의 비-프리셋 format은 직접 입력으로 표시·값 보존) + 직접 입력 시 형식 문자열 `Input`(draft·blur 커밋) + 오프셋 `Input`(draft·blur — `OFFSET_RE` 불합격이면 revert) + 타임존 `Select`(Asia/Seoul/UTC/워커 로컬 — 워커 로컬=tz 키 제거, **즉시 커밋**).
- 랜덤 정수: 최소/최대는 `useIntPairDraft`(아래) · 단위는 단독 draft-blur(정수·≥1 아니면 revert). 랜덤 문자열: 길이 draft-blur(1~64 밖 revert).
- `yamlError !== null` → 모든 신규 입력·select·토글 중 **편집 어포던스만** disabled(접기/펼치기 토글은 읽기 전용 크롬이라 활성 유지 — think-time-defaults S1 이디엄).
- 검색(`matchesRow`)은 Task 4의 `declSearchText` 유지. rename ✎/사용처/×/미정의 ⚠/추출 덮어씀 배지 전부 기존 동작 보존(기존 테스트 무수정 통과가 그 증거).
- 신규 문구·aria 전부 ko 경유, aria ⊇ 보이는 텍스트.

**`useIntPairDraft`** — `useThinkTimePair`(`useThinkTimePair.ts`)의 **상태기계 계약을 미러**한 정수쌍 훅(그 훅은 `ThinkTime{min_ms,max_ms}`+`{0,0}` 특수 의미론에 결합돼 직접 재사용 불가 — 미러 근거를 파일 헤더 주석에 명시):
- 시그니처: `useIntPairDraft({ value: {min,max} | null, resetKey, onCommit(min,max) }) => { minProps, maxProps }` — `minProps/maxProps = {value,onChange,onBlur,ref}` 스프레드.
- **`relatedTarget` partner-hold**: blur 시 `partner.current !== null && e.relatedTarget === partner.current`면 커밋 보류(`!== null` 체크가 load-bearing — 없으면 미마운트 시 null===null로 전 커밋 소실, useThinkTimePair 함정 그대로).
- 커밋 규칙: 둘 다 유효 정수 && min≤max → commit / 아니면 draft 보존 no-op(빈 칸 revert 금지 — S-B 가드).
- 재시드 dep은 **원시값**(`value?.min`, `value?.max`, `resetKey`) — 객체 dep 금지(행 표 함정).

- [ ] **Step 1: 테스트 먼저 (RED)** — `GenVarEditor.test.tsx` + `VariablesPanel.test.tsx` 확장:
  - 생성기 행 접힘 렌더: 배지·요약·샘플(`예:`) 존재, textarea 부재. 정적 행: 기존 단언 무수정 통과.
  - ▸ 클릭 → 펼침: 타입 select·필드 렌더. 다시 클릭 → 접힘.
  - 타입 전환 static→date: `setVariableGen` 호출 payload에 `tz:"Asia/Seoul"` 포함(정확 `toEqual`). date→static: `setVariable(key,"")`.
  - 형식 프리셋 변경 즉시 커밋 / 직접 입력 format blur 커밋 / 오프셋 `+7x` blur → revert(커밋 미발생).
  - min/max 쌍: **실제 포커스 이동으로**(`user.click`으로 min→max 이동 — `fireEvent.blur`는 relatedTarget:null이라 hold 경로를 못 밟음) `1000`·`2000` 입력 → blur 후 `setVariableGen`이 `{min:1000,max:2000}` 1회 — **이빨 실증**: hold 게이트를 임시 제거해 `{min:1000,max:100}`(중간쌍 revert) RED 확인 → 원복 GREEN. 픽스처는 중간쌍이 `min>max`가 되는 값(1000>100)으로.
  - 샘플: `%j` format → `미리보기 불가` 문구.
  - `yamlError` 세팅 후(`setPendingYamlText`+`commitPendingYaml` 경로) 편집 disabled·토글 활성.
  - 동일 문구 충돌: 배지/요약에 쓰인 신규 ko 값이 기존 값과 양방향 부분문자열 충돌 없는지 grep 스텝(테스트 아님 — 커밋 전 체크리스트).
- [ ] **Step 2: RED 확인** — `pnpm test GenVarEditor 2>&1; echo exit=$?` / `pnpm test VariablesPanel`.
- [ ] **Step 3: 구현** — 위 UI 계약대로. `GenVarEditor`는 `Input`/`Select` 프리미티브(`size="sm"` 밀도)·`ui/` 디자인 시스템 사용. 행 레이아웃은 기존 `flex flex-wrap items-center gap-x-2 gap-y-1` 이디엄. 펼침 편집기 컨테이너는 목업의 `bg-slate-50 border rounded p-2` 등가(`genfields`). 구조 골격:

```tsx
// GenVarEditor.tsx — 펼침 편집기. 커밋은 전부 부모 콜백(store 직접 접근 금지 — 프레젠테이셔널).
type VarKind = "static" | GenSpec["gen"];
export function GenVarEditor({ name, value, disabled, onCommitGen, onCommitStatic }: {
  name: string;
  value: VarDeclValue;
  disabled: boolean;                       // yamlError !== null
  onCommitGen: (spec: GenSpec) => void;    // = store.setVariableGen(name, spec)
  onCommitStatic: (v: string) => void;     // = store.setVariable(name, v)
}) {
  const kind: VarKind = isGenSpec(value) ? value.gen : "static";
  const spec = isGenSpec(value) ? value : null;
  const changeKind = (k: VarKind) => {     // 타입 select 즉시 커밋 + 기본 스펙 (UI 계약)
    if (k === kind) return;
    if (k === "static") return onCommitStatic("");
    onCommitGen(
      k === "date" ? { gen: "date", format: "%Y-%m-%d", tz: "Asia/Seoul" }
      : k === "random_int" ? { gen: "random_int", min: 1, max: 100 }
      : k === "uuid" ? { gen: "uuid" }
      : { gen: "random_string", length: 8 });
  };
  // date: 프리셋 Select(즉시 커밋) / 커스텀 format Input(draft·blur — GenSpecModel.safeParse
  //   불합격이면 revert) / offset Input(draft·blur — OFFSET_RE 불합격 revert) /
  //   tz Select(즉시 커밋 — "워커 로컬"이면 spec에서 tz 키 제거)
  // random_int: useIntPairDraft({ value: {min: spec.min, max: spec.max}, resetKey: name,
  //   onCommit: (min, max) => onCommitGen({ ...spec, min, max }) }) 스프레드 + step 단독 draft-blur
  // random_string: length 단독 draft-blur (1~64 밖 revert)
  // 샘플 줄: const s = sampleFor(spec) → ok ? `${ko.editor.genSamplePrefix} ${s.text}`
  //   : ko.editor.genSampleUnsupported
  return (/* 위 계약·주석대로 필드 렌더 — 각 입력 aria-label은 ko.editor.genField*(name) */);
}
```

`VariablesPanel` 통합: declared 행에 `expanded: Set<string>` 로컬 상태 + caret 버튼(`aria-expanded`), 펼침 시 `<GenVarEditor …/>` 렌더(정적 행은 기존 textarea **위**에 타입 select만 추가된 형태 = GenVarEditor의 static kind 렌더가 textarea 포함). Task 4의 임시 요약-only 렌더를 접힘 상태 정식 렌더(배지+요약+샘플)로 교체.
- [ ] **Step 4: GREEN + 전체 게이트** — `pnpm test`(전체)+`lint`+`build` `; echo exit=$?` (전체 스위트 — 패널 확장이 기존 페이지 테스트를 깨지 않는지).
- [ ] **Step 5: 커밋** — `feat(ui): 변수 패널 C안 — 생성기 요약 행+그 자리 펼침 편집기 (dynamic-vars T6)`.

---

### Task 7: 페이지 통합 스모크 + YAML 왕복 락인

**Files:**
- Test: `ui/src/pages/__tests__/ScenarioNewPage.genvars.test.tsx`(신규 — 기존 `ScenarioNewPage` 테스트 하니스 미러) 또는 기존 파일 확장

**Interfaces:** Consumes 전부. 신규 src 0 — 통합 락인만.

- [ ] **Step 1: 테스트** —
  - 스토어에 생성기 YAML `loadFromString` → 패널에 4종 행(배지) 렌더 + `yamlText` round-trip 유지.
  - 패널에서 변수 추가→date 전환→`yamlText`에 `gen: date`·`tz: Asia/Seoul` 포함(모델 경유 — Monaco 불신 함정 회피, 저장경로 검증은 라이브에서).
  - `/scenarios/new`·`/scenarios/{id}` 두 하니스 각각 1케이스(마운트 경로별 — [[live-verify-all-mount-paths]] 미러).
- [ ] **Step 2: GREEN + 최종 전체 게이트** — UI 3종 + `cargo nextest run` 전체 `; echo exit=$?`.
- [ ] **Step 3: 커밋** — `test(ui): 생성 변수 페이지 스모크 + YAML 왕복 락인 (dynamic-vars T7)`.

---

## 구현 후 파이프라인 (plan 밖 — orchestrator 체크리스트)

1. **최종 리뷰**: `handicap-reviewer` APPROVE + **`security-reviewer` 필수**(diff가 `trace.rs`·시나리오 파싱 접촉 — spec §7, finish-slice §0 grep이 확인).
2. **라이브 검증** `/live-verify` — spec §9 US 표 그대로(로깅 에코 서버로 US1/US3 와이어, test-run trace로 US2, 에디터 양 진입 화면에서 US4). 컨트롤러는 워크트리 상대경로 바이너리·8080 점유 확인.
3. `/finish-slice` — build-log·roadmap-status·상태줄·메모리(archive) 기록, ADR 필요 여부 판단(§3 모델 확장은 ADR-0013/0014 범위 내 additive — 신규 ADR 불필요로 제안, 이견 시 리뷰에서).

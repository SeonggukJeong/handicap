// pick-array (spec 2026-10-17): 게이트·평가·왕복. 판정 벡터는 testdata/pick_array_vectors.json —
// UI vitest(pickArray.test.ts·pickArrayVectors.test.ts)가 같은 파일을 읽어 양방향 lockstep.
use std::collections::{BTreeMap, HashSet};

use handicap_engine::{GenSpec, VarDecl, parse_positions, seed_iter_vars};
use rand::SeedableRng;
use rand::rngs::StdRng;
use serde::Deserialize;
use serde_json::Value;

const VECTORS: &str = include_str!("../../../testdata/pick_array_vectors.json");

#[derive(Deserialize)]
struct Vectors {
    positions: Vec<PosVec>,
    generators: Vec<GenVec>,
}
#[derive(Deserialize)]
struct PosVec {
    text: String,
    length: u32,
    expect: String,
    #[serde(default)]
    set: Vec<u32>,
}
#[derive(Deserialize)]
struct GenVec {
    yaml: String,
    expect: String,
}

fn vectors() -> Vectors {
    serde_json::from_str(VECTORS).unwrap()
}

#[test]
fn positions_vectors() {
    for v in vectors().positions {
        let got = parse_positions(&v.text, v.length);
        match v.expect.as_str() {
            "accept" => assert_eq!(got.as_deref(), Ok(&v.set[..]), "text={:?}", v.text),
            "reject" => assert!(got.is_err(), "should reject {:?}, got {got:?}", v.text),
            other => panic!("unknown expect {other}"),
        }
    }
}

#[test]
fn generator_vectors() {
    for v in vectors().generators {
        let got = serde_yaml::from_str::<VarDecl>(&v.yaml);
        match v.expect.as_str() {
            "accept" => assert!(got.is_ok(), "should accept {}: {:?}", v.yaml, got.err()),
            // known_divergence: 엔진(serde_yaml)은 `1e3`을 실수로 읽어 거부한다(UI yaml 패키지는 정수 1000으로 수용 — spec §4.1).
            "reject" | "known_divergence" => assert!(got.is_err(), "should reject {}", v.yaml),
            other => panic!("unknown expect {other}"),
        }
    }
}

#[test]
fn positions_over_4096_chars_rejected_and_at_limit_accepted() {
    // "1, " 반복으로 정확히 4096자 / 4097자 — 길이 상한 판정은 문법보다 먼저.
    let at = format!("{}1", "1, ".repeat(1365)); // 1365*3 + 1 = 4096
    assert_eq!(at.len(), 4096);
    assert_eq!(parse_positions(&at, 10).unwrap(), vec![1]);
    let over = format!("{at} ");
    assert_eq!(over.len(), 4097);
    assert!(parse_positions(&over, 10).is_err());
}

fn one(spec: &str) -> BTreeMap<String, VarDecl> {
    serde_yaml::from_str(&format!("x: {spec}")).unwrap()
}

fn eval(m: &BTreeMap<String, VarDecl>, rng: &mut StdRng) -> Vec<Value> {
    serde_json::from_str(&seed_iter_vars(m, rng)["x"]).unwrap()
}

#[test]
fn eval_respects_count_range_and_candidates() {
    let m = one(r#"{gen: pick_array, length: 30, min: 2, max: 3, positions: "1-5, 8, 12-20"}"#);
    let cand: HashSet<usize> = [1, 2, 3, 4, 5, 8, 12, 13, 14, 15, 16, 17, 18, 19, 20]
        .iter()
        .map(|p| p - 1)
        .collect();
    let mut rng = StdRng::seed_from_u64(7);
    let mut counts = HashSet::new();
    let mut distinct = HashSet::new();
    for _ in 0..400 {
        let arr = eval(&m, &mut rng);
        assert_eq!(arr.len(), 30);
        let picked: Vec<usize> = (0..30).filter(|&i| arr[i] == Value::Bool(true)).collect();
        for (i, v) in arr.iter().enumerate() {
            if !picked.contains(&i) {
                assert_eq!(v, &Value::Bool(false), "비선택 자리는 rest");
            }
        }
        assert!((2..=3).contains(&picked.len()), "{picked:?}");
        assert!(picked.iter().all(|i| cand.contains(i)), "{picked:?}");
        counts.insert(picked.len());
        distinct.insert(picked);
    }
    assert_eq!(
        counts,
        HashSet::from([2, 3]),
        "k가 [min,max] 양 끝을 모두 낸다"
    );
    assert!(distinct.len() > 50, "반복마다 다른 배열");
}

#[test]
fn eval_clamps_max_to_candidates_and_zero_count() {
    let m = one(r#"{gen: pick_array, length: 10, min: 1, max: 10, positions: "1-3"}"#);
    let mut rng = StdRng::seed_from_u64(1);
    let mut max_seen = 0;
    for _ in 0..200 {
        let n = eval(&m, &mut rng)
            .iter()
            .filter(|v| **v == Value::Bool(true))
            .count();
        assert!((1..=3).contains(&n));
        max_seen = max_seen.max(n);
    }
    assert_eq!(max_seen, 3);
    let z = one("{gen: pick_array, length: 5, min: 0, max: 0}");
    assert_eq!(eval(&z, &mut rng), vec![Value::Bool(false); 5]);
}

#[test]
fn eval_preserves_value_types_including_null() {
    let mut rng = StdRng::seed_from_u64(3);
    let nums = eval(
        &one("{gen: pick_array, length: 4, min: 2, max: 2, pick: 1, rest: 0}"),
        &mut rng,
    );
    assert_eq!(nums.iter().filter(|v| **v == 1).count(), 2);
    assert_eq!(nums.iter().filter(|v| **v == 0).count(), 2);
    let strs = eval(
        &one(r#"{gen: pick_array, length: 4, min: 1, max: 1, pick: "True", rest: "False"}"#),
        &mut rng,
    );
    assert_eq!(strs.iter().filter(|v| **v == "True").count(), 1);
    assert_eq!(strs.iter().filter(|v| **v == "False").count(), 3);
    // 명시 null은 기본(false)으로 떨어지지 않는다 (spec §4.1 — round-trip만으로는 공허)
    let nul = eval(
        &one(r#"{gen: pick_array, length: 3, min: 1, max: 1, pick: "Y", rest: null}"#),
        &mut rng,
    );
    assert_eq!(nul.iter().filter(|v| v.is_null()).count(), 2);
    assert_eq!(nul.iter().filter(|v| **v == "Y").count(), 1);
    let f = eval(
        &one("{gen: pick_array, length: 2, min: 2, max: 2, pick: 1.5}"),
        &mut rng,
    );
    assert_eq!(f, vec![Value::from(1.5), Value::from(1.5)]);
}

#[test]
fn roundtrip_preserves_string_vs_typed_values() {
    for spec in [
        r#"{gen: pick_array, length: 30, min: 2, max: 3, positions: "1-5, 8"}"#,
        r#"{gen: pick_array, length: 4, min: 1, max: 2, pick: "True", rest: "1"}"#,
        "{gen: pick_array, length: 4, min: 1, max: 2, pick: 1, rest: null}",
        "{gen: pick_array, length: 4, min: 1, max: 2, pick: true, rest: false}",
        "{gen: pick_array, length: 10, min: 1, max: 1, positions: 8}",
        "{gen: pick_array, length: 10, min: 1, max: 1, positions: 0x8}",
    ] {
        let m = one(spec);
        let out = serde_yaml::to_string(&m).unwrap();
        let back: BTreeMap<String, VarDecl> = serde_yaml::from_str(&out).unwrap();
        assert_eq!(back, m, "spec={spec} out={out}");
    }
    // 방출 순서·생략 규칙: 기본 생략 필드는 키 자체가 없다 ("pick"은 "gen: pick_array"에도 있으므로 키 형태로 검사)
    let out = serde_yaml::to_string(&one("{gen: pick_array, length: 10, min: 1, max: 3}")).unwrap();
    assert!(
        !out.contains("positions:") && !out.contains("pick:") && !out.contains("rest:"),
        "{out}"
    );
    let g = out.find("gen").unwrap();
    let l = out.find("length").unwrap();
    let mi = out.find("min").unwrap();
    let ma = out.find("max").unwrap();
    assert!(g < l && l < mi && mi < ma, "{out}");
}

#[test]
fn candidates_accessor_full_range_when_positions_absent() {
    match &one("{gen: pick_array, length: 4, min: 1, max: 2}")["x"] {
        VarDecl::Gen(GenSpec::PickArray(g)) => assert_eq!(g.candidates(), &[1, 2, 3, 4]),
        other => panic!("{other:?}"),
    }
}

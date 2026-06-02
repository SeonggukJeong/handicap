//! `unique` policy contract: each row handed out at most once via a shared
//! worker-local cursor, then `None` (no wrap). (spec §2, §4.1)
use handicap_engine::{BindingPolicy, DataSet};
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::AtomicU64;

fn rows(n: usize) -> Vec<BTreeMap<String, String>> {
    (0..n)
        .map(|i| {
            let mut m = BTreeMap::new();
            m.insert("tok".to_string(), format!("t{i}"));
            m
        })
        .collect()
}

#[test]
fn unique_consumes_each_row_once_then_returns_none() {
    let ds = DataSet {
        policy: BindingPolicy::Unique,
        seed: 0,
        rows: rows(4),
    };
    let c = AtomicU64::new(0);
    let got: Vec<Option<usize>> = (0..6).map(|i| ds.select_index(i, 0, Some(&c))).collect();
    assert_eq!(
        got,
        vec![Some(0), Some(1), Some(2), Some(3), None, None],
        "unique must return 0..len then None forever (no wrap)"
    );
}

#[test]
fn unique_two_vus_never_get_the_same_row() {
    let ds = DataSet {
        policy: BindingPolicy::Unique,
        seed: 0,
        rows: rows(3),
    };
    let c = AtomicU64::new(0);
    let mut seen = HashSet::new();
    for _iter in 0..3 {
        for vu in 0..2u32 {
            if let Some(idx) = ds.select_index(vu, 0, Some(&c)) {
                assert!(seen.insert(idx), "row {idx} handed out twice");
            }
        }
    }
    assert_eq!(seen.len(), 3, "all 3 unique rows consumed exactly once");
}

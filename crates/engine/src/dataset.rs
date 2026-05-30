//! Data-driven binding: an in-memory dataset plus the policy that decides which
//! row a given (vu_id, iter_id) sees. Rows arrive from the controller with
//! mappings already applied — keys are flow-var names, not source columns
//! (spec §2 "mapping-agnostic worker"). Indexing is deterministic so a run's
//! report reproduces the exact sequence (spec §11).
use std::collections::BTreeMap;

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingPolicy {
    /// Fixed row per VU for the whole run: `idx = vu_id % rows`.
    PerVu,
    /// Worker-local monotonic counter, advanced once per VU iteration.
    IterSequential,
    /// Deterministic PRNG keyed by (seed, vu_id, iter_id) per iteration.
    IterRandom,
}

/// One run's bound dataset. `rows` is non-empty (the controller's validation
/// gate rejects empty datasets, spec §11) but `select_index` defends anyway.
#[derive(Debug)]
pub struct DataSet {
    pub policy: BindingPolicy,
    pub seed: u32,
    pub rows: Vec<BTreeMap<String, String>>,
}

impl DataSet {
    /// Row index for this (vu_id, iter_id). `counter` is the shared
    /// worker-local sequential counter (Some only for `IterSequential`);
    /// `select_index` does the `fetch_add` so the increment happens exactly
    /// once per iteration at the call site.
    pub fn select_index(
        &self,
        vu_id: u32,
        iter_id: u32,
        counter: Option<&std::sync::atomic::AtomicU64>,
    ) -> usize {
        let len = self.rows.len();
        debug_assert!(len > 0, "DataSet::select_index on empty rows");
        match self.policy {
            BindingPolicy::PerVu => (vu_id as usize) % len,
            BindingPolicy::IterSequential => {
                let c = counter.expect("IterSequential requires a shared counter");
                (c.fetch_add(1, std::sync::atomic::Ordering::Relaxed) as usize) % len
            }
            BindingPolicy::IterRandom => {
                let mixed = mix(self.seed, vu_id, iter_id);
                let mut rng = StdRng::seed_from_u64(mixed);
                rng.gen_range(0..len)
            }
        }
    }
}

/// Mix (seed, vu_id, iter_id) into a u64 RNG seed via splitmix64 rounds.
/// Direct XOR-then-modulo would stripe (spec §4); a full mix de-correlates
/// adjacent ids so consecutive iterations don't walk the dataset in lockstep.
/// Note: `seed` and `vu_id` are folded through the same initial addition, so
/// they are not independently decomposable — but for the actual usage (a fixed
/// per-run seed with distinct vu_ids) this produces no intra-run collisions.
fn mix(seed: u32, vu_id: u32, iter_id: u32) -> u64 {
    let mut z = seed as u64;
    z = splitmix64(z.wrapping_add(vu_id as u64));
    splitmix64(z.wrapping_add(iter_id as u64))
}

fn splitmix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    fn rows(n: usize) -> Vec<BTreeMap<String, String>> {
        (0..n)
            .map(|i| {
                let mut m = BTreeMap::new();
                m.insert("user".to_string(), format!("u{i}"));
                m
            })
            .collect()
    }

    #[test]
    fn per_vu_is_fixed_and_wraps() {
        let ds = DataSet {
            policy: BindingPolicy::PerVu,
            seed: 0,
            rows: rows(3),
        };
        assert_eq!(ds.select_index(1, 0, None), ds.select_index(1, 99, None));
        assert_eq!(ds.select_index(1, 0, None), 1);
        assert_eq!(ds.select_index(4, 0, None), 1);
    }

    #[test]
    fn iter_sequential_advances_once_per_call_and_wraps() {
        let ds = DataSet {
            policy: BindingPolicy::IterSequential,
            seed: 0,
            rows: rows(2),
        };
        let c = AtomicU64::new(0);
        assert_eq!(ds.select_index(0, 0, Some(&c)), 0);
        assert_eq!(ds.select_index(0, 1, Some(&c)), 1);
        assert_eq!(ds.select_index(0, 2, Some(&c)), 0); // wrap
    }

    #[test]
    fn iter_random_is_deterministic_for_same_inputs() {
        let ds = DataSet {
            policy: BindingPolicy::IterRandom,
            seed: 42,
            rows: rows(5),
        };
        let a = ds.select_index(3, 7, None);
        let b = ds.select_index(3, 7, None);
        assert_eq!(a, b, "same (seed,vu,iter) must reproduce the same index");
        assert!(a < 5);
    }

    #[test]
    fn iter_random_varies_across_iterations() {
        let ds = DataSet {
            policy: BindingPolicy::IterRandom,
            seed: 1,
            rows: rows(50),
        };
        let seq: Vec<usize> = (0..10).map(|i| ds.select_index(0, i, None)).collect();
        let distinct: std::collections::HashSet<_> = seq.iter().collect();
        assert!(
            distinct.len() > 1,
            "random policy should not be constant: {seq:?}"
        );
    }
}

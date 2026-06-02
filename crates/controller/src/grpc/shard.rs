//! Pure fan-out arithmetic: how many workers, and how the VU range splits
//! across them. Deterministic and tonic-free so it unit-tests in isolation.
//! (A3a spec §2.1, §3.2.)

/// Number of workers for a run: `ceil(total_vus / capacity)`, at least 1.
/// `capacity == 0` is treated as 1 (defensive — the CLI default is 2000).
pub fn worker_count(total_vus: u32, capacity: u32) -> u32 {
    let cap = capacity.max(1);
    total_vus.div_ceil(cap).max(1)
}

/// VU slice for shard `i` of `n`: contiguous, disjoint, summing to `total_vus`.
/// The first `total_vus % n` shards get one extra VU. Returns `(vu_offset, vu_count)`.
pub fn shard_split(total_vus: u32, n: u32, i: u32) -> (u32, u32) {
    debug_assert!(n >= 1, "shard_split needs n >= 1");
    debug_assert!(i < n, "shard index out of range");
    let base = total_vus / n;
    let rem = total_vus % n;
    let extra = if i < rem { 1 } else { 0 };
    let vu_count = base + extra;
    let vu_offset = i * base + i.min(rem);
    (vu_offset, vu_count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_count_ceils_and_floors_at_one() {
        assert_eq!(worker_count(2000, 2000), 1);
        assert_eq!(worker_count(2001, 2000), 2);
        assert_eq!(worker_count(1, 2000), 1);
        assert_eq!(worker_count(5000, 2000), 3);
        assert_eq!(worker_count(10, 0), 10); // capacity 0 → treated as 1
        assert_eq!(worker_count(0, 2000), 1); // never 0 (vus>0 enforced upstream anyway)
    }

    #[test]
    fn shard_split_is_contiguous_disjoint_and_sums() {
        // V=2, N=2 → (0,1),(1,1)
        assert_eq!(shard_split(2, 2, 0), (0, 1));
        assert_eq!(shard_split(2, 2, 1), (1, 1));
        // V=5, N=2 → (0,3),(3,2)  (first shard gets the remainder)
        assert_eq!(shard_split(5, 2, 0), (0, 3));
        assert_eq!(shard_split(5, 2, 1), (3, 2));
    }

    #[test]
    fn shard_split_covers_range_exactly_for_many_shapes() {
        for &(v, n) in &[(7u32, 3u32), (10, 4), (1, 1), (100, 7), (3, 5)] {
            let n_eff = n.min(v).max(1); // when n>v, trailing shards get 0 count
            let mut covered = vec![false; v as usize];
            let mut total = 0u32;
            for i in 0..n {
                let (off, cnt) = shard_split(v, n, i);
                total += cnt;
                for k in off..off + cnt {
                    assert!(!covered[k as usize], "overlap at vu {k} (v={v},n={n})");
                    covered[k as usize] = true;
                }
            }
            assert_eq!(total, v, "counts must sum to total (v={v},n={n})");
            assert!(covered.iter().all(|&c| c), "gap in coverage (v={v},n={n})");
            let _ = n_eff;
        }
    }
}

//! Pure fan-out arithmetic: how many workers, and how the VU range splits
//! across them. Deterministic and tonic-free so it unit-tests in isolation.
//! (A3a spec §2.1, §3.2.)

/// Number of workers for a run: `ceil(total_vus / capacity)`, at least 1.
/// `capacity == 0` is treated as 1 (defensive — the CLI default is 2000).
pub fn worker_count(total_vus: u32, capacity: u32) -> u32 {
    let cap = capacity.max(1);
    total_vus.div_ceil(cap).max(1)
}

/// Per-worker dataset slice. `unique` partitions the dataset into disjoint
/// contiguous shards (`shard_split`); replicated policies (per_vu / iter_*) give
/// every worker the same `(0, total)`. Returns `(offset, count)` as u64.
/// Caller guarantees `total <= u32::MAX` for unique (validation gate). (spec §4.4)
pub fn dataset_slice(
    is_unique: bool,
    total: u64,
    shard_count: u32,
    shard_index: u32,
) -> (u64, u64) {
    if is_unique {
        let (offset, count) = shard_split(total as u32, shard_count, shard_index);
        (offset as u64, count as u64)
    } else {
        (0, total)
    }
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

/// Total achievable VUs across `caps`: `Σ caps[i].max(1)` (0 floored to 1,
/// matching `worker_count`'s `capacity.max(1)`). Saturating to avoid u32
/// overflow on pathological caps. Used by the pool capacity guard (spec R6/R7).
pub fn achievable_capacity(caps: &[u32]) -> u32 {
    caps.iter()
        .fold(0u32, |acc, &c| acc.saturating_add(c.max(1)))
}

/// Distribute `total_vus` across `caps.len()` workers, never exceeding any
/// worker's capacity (`caps[i].max(1)`). Starts from the even `shard_split`
/// distribution, reclaims overflow from over-cap workers, and redistributes it
/// (in index order) to workers with remaining slack. When no cap binds the
/// result is byte-identical to `shard_split`'s per-worker counts (spec R5).
/// When `Σ caps.max(1) >= total_vus` the returned vector sums to `total_vus`;
/// otherwise it fills each worker to its cap and sums to less (the caller reads
/// that shortfall as "achievable < requested"). Deterministic. (spec R1.)
pub fn capacity_split(total_vus: u32, caps: &[u32]) -> Vec<u32> {
    let n = caps.len();
    if n == 0 {
        return Vec::new();
    }
    // 1. Even start — identical to shard_split's per-worker counts (R5).
    let mut alloc: Vec<u32> = (0..n as u32)
        .map(|i| shard_split(total_vus, n as u32, i).1)
        .collect();
    // 2. Reclaim overflow from over-cap workers.
    let mut overflow: u32 = 0;
    for (a, &c) in alloc.iter_mut().zip(caps.iter()) {
        let cap = c.max(1);
        if *a > cap {
            overflow += *a - cap;
            *a = cap;
        }
    }
    // 3. Redistribute overflow into under-cap workers in index order. One pass
    //    suffices: when Σcap >= total, total slack >= overflow.
    for (a, &c) in alloc.iter_mut().zip(caps.iter()) {
        if overflow == 0 {
            break;
        }
        let cap = c.max(1);
        let add = (cap - *a).min(overflow);
        *a += add;
        overflow -= add;
    }
    alloc
}

/// Distribute `total` across `weights` proportionally (largest-remainder, ties
/// broken by ascending index). Σ == total, deterministic. When all weights are
/// equal the result equals `shard_split`'s per-worker counts (front-loaded
/// remainder) — byte-identical construction (spec R2/R7). Zero shares ARE
/// allowed (a small weight may round to 0); used for open-loop **curve**
/// stage.target where the engine polls a zero-rate stage. (spec §4.2.)
pub fn proportional_split(total: u32, weights: &[u32]) -> Vec<u32> {
    let n = weights.len();
    if n == 0 {
        return Vec::new();
    }
    let sum_w: u64 = weights.iter().map(|&w| w as u64).sum();
    if sum_w == 0 {
        // defensive: degenerate weights → even split
        return (0..n as u32)
            .map(|i| shard_split(total, n as u32, i).1)
            .collect();
    }
    let total64 = total as u64;
    let mut alloc: Vec<u32> = Vec::with_capacity(n);
    let mut rems: Vec<(u64, usize)> = Vec::with_capacity(n); // (fractional remainder, index)
    let mut assigned: u64 = 0;
    for (i, &w) in weights.iter().enumerate() {
        let num = total64 * w as u64;
        let q = num / sum_w;
        alloc.push(q as u32);
        assigned += q;
        rems.push((num % sum_w, i));
    }
    let mut rem_units = total64 - assigned; // < n
    // largest remainder first; ascending index on ties (front-loaded like shard_split)
    rems.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    for &(_, i) in rems.iter() {
        if rem_units == 0 {
            break;
        }
        alloc[i] += 1;
        rem_units -= 1;
    }
    alloc
}

/// Like `proportional_split` but every worker gets **at least 1** (no zero
/// share), used for open-loop **fixed** `target_rps`: the engine clamps a
/// zero-rate fixed worker to >=1 rps (`runner.rs:1093` `.max(1)`), so a 0-share
/// would over-fire. Caller guarantees `total >= n` via the rate-bound
/// `pool_worker_cap = min(max_in_flight, rate_peak)` (N <= rate_peak <= total);
/// if `total < n` (or weights sum 0) it falls back to `proportional_split`
/// (defensive). Σ == total, uniform weights == `shard_split`. (spec §3.4/§4.2.)
pub fn proportional_split_min1(total: u32, weights: &[u32]) -> Vec<u32> {
    let n = weights.len();
    if n == 0 {
        return Vec::new();
    }
    let sum_w: u64 = weights.iter().map(|&w| w as u64).sum();
    if (total as usize) < n || sum_w == 0 {
        return proportional_split(total, weights);
    }
    // base 1 each, distribute the remaining (total - n) proportionally.
    let extra = proportional_split(total - n as u32, weights);
    extra.iter().map(|&e| e + 1).collect()
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
    fn dataset_slice_unique_partitions_disjoint() {
        // unique: disjoint contiguous shards summing to total.
        assert_eq!(dataset_slice(true, 5, 2, 0), (0, 3));
        assert_eq!(dataset_slice(true, 5, 2, 1), (3, 2));
        // replicated (per_vu / iter_*): every worker gets the whole count at offset 0.
        assert_eq!(dataset_slice(false, 5, 2, 0), (0, 5));
        assert_eq!(dataset_slice(false, 5, 2, 1), (0, 5));
    }

    #[test]
    fn achievable_capacity_sums_with_floor() {
        assert_eq!(achievable_capacity(&[5, 5]), 10);
        assert_eq!(achievable_capacity(&[0, 0, 0]), 3); // 0 floored to 1 each
        assert_eq!(achievable_capacity(&[]), 0);
    }

    #[test]
    fn capacity_split_equals_even_when_slack() {
        // No cap binds → must be byte-identical to shard_split's per-worker counts,
        // including the front-loaded remainder (first total%n shards get +1).
        for &(total, n) in &[(2u32, 2u32), (5, 2), (7, 3), (10, 4), (1, 1), (100, 7)] {
            let caps = vec![u32::MAX; n as usize]; // huge caps → never binds
            let even: Vec<u32> = (0..n).map(|i| shard_split(total, n, i).1).collect();
            assert_eq!(capacity_split(total, &caps), even, "total={total} n={n}");
        }
        // explicit remainder shapes
        assert_eq!(capacity_split(5, &[1000, 1000]), vec![3, 2]);
        assert_eq!(capacity_split(7, &[1000, 1000, 1000]), vec![3, 2, 2]);
    }

    #[test]
    fn capacity_split_respects_caps_and_sums() {
        // even 15/15 would overflow worker A (cap 5) → water-fill 5/25.
        let out = capacity_split(30, &[5, 1000]);
        assert_eq!(out, vec![5, 25]);
        assert_eq!(out.iter().sum::<u32>(), 30);
        // contiguous disjoint offsets via cumulative sum
        let mut off = 0u32;
        for (i, &c) in out.iter().enumerate() {
            assert!(c <= [5, 1000][i].max(1));
            off += c;
        }
        assert_eq!(off, 30);
    }

    #[test]
    fn capacity_split_floors_zero_to_one() {
        // cap 0 is treated as 1 (defensive, matches worker_count).
        let out = capacity_split(3, &[0, 0, 0]);
        assert_eq!(out, vec![1, 1, 1]);
    }

    #[test]
    fn capacity_split_short_pool_fills_to_cap() {
        // Σcap (10) < total (30): fill each to cap, sum < total (achievable signal).
        let out = capacity_split(30, &[5, 5]);
        assert_eq!(out, vec![5, 5]);
        assert_eq!(out.iter().sum::<u32>(), 10);
    }

    #[test]
    fn capacity_split_empty_is_empty() {
        assert!(capacity_split(10, &[]).is_empty());
    }

    #[test]
    fn proportional_split_sums_and_is_deterministic() {
        // 비례·Σ==total·결정적
        assert_eq!(proportional_split(30, &[5, 25]), vec![5, 25]);
        assert_eq!(proportional_split(10, &[5, 25]), vec![2, 8]);
        // 0-share 허용(작은 weight가 0으로 반올림): 곡선 stage용
        assert_eq!(proportional_split(3, &[1, 25]), vec![0, 3]);
        for &(total, ref w) in &[(7u32, vec![1u32, 1, 1]), (100, vec![3, 7, 11])] {
            assert_eq!(proportional_split(total, w).iter().sum::<u32>(), total);
        }
        assert!(proportional_split(10, &[]).is_empty());
    }

    #[test]
    fn proportional_split_equals_shard_split_when_uniform() {
        // 균등 weights → shard_split per-worker(앞 total%n개 +1)와 동일 (R7 byte-identical)
        for &(total, n) in &[(5u32, 2u32), (7, 3), (10, 4), (1, 1), (100, 7)] {
            let w = vec![1u32; n as usize];
            let even: Vec<u32> = (0..n).map(|i| shard_split(total, n, i).1).collect();
            assert_eq!(proportional_split(total, &w), even, "total={total} n={n}");
        }
        assert_eq!(proportional_split(5, &[1, 1]), vec![3, 2]);
        assert_eq!(proportional_split(7, &[1, 1, 1]), vec![3, 2, 2]);
    }

    #[test]
    fn proportional_split_min1_floors_each_at_one() {
        // 이질 cap·저 rate: 순수 비례면 [0,3]이지만 min1은 0-share 금지 → [1,2]
        assert_eq!(proportional_split_min1(3, &[1, 25]), vec![1, 2]);
        let out = proportional_split_min1(3, &[2, 8]);
        assert!(out.iter().all(|&r| r >= 1), "every worker >= 1: {out:?}");
        assert_eq!(out.iter().sum::<u32>(), 3);
        // total < n → 방어 fallback(proportional_split, 0 허용)
        assert_eq!(
            proportional_split_min1(1, &[1, 1]),
            proportional_split(1, &[1, 1])
        );
    }

    #[test]
    fn proportional_split_min1_equals_shard_split_when_uniform() {
        for &(total, n) in &[(5u32, 2u32), (7, 3), (10, 4), (1, 1)] {
            let w = vec![1u32; n as usize];
            let even: Vec<u32> = (0..n).map(|i| shard_split(total, n, i).1).collect();
            assert_eq!(
                proportional_split_min1(total, &w),
                even,
                "total={total} n={n}"
            );
        }
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

use std::borrow::Cow;

use handicap_controller::sample::{
    Resolved, Sample, SplitHist, decode_row, run_is_split, window_hist_per_window,
};
use handicap_controller::store::metrics::WindowWithHdr;
use hdrhistogram::Histogram;
use hdrhistogram::serialization::{Serializer, V2Serializer};

fn hist(values: &[u64]) -> Histogram<u64> {
    let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    for v in values {
        h.record(*v).unwrap();
    }
    h
}

fn blob(values: &[u64]) -> Vec<u8> {
    let h = hist(values);
    let mut out = Vec::new();
    V2Serializer::new().serialize(&h, &mut out).unwrap();
    out
}

/// 한 행을 자리에 넣는다. 실패 BLOB이 비어 있지 않을 때만 raw를 넘긴다.
fn feed<'r>(sh: &mut SplitHist<'r>, all: &'r [u8], failed: Option<&'r [u8]>) -> bool {
    let Some(row) = decode_row(all, failed) else {
        return false;
    };
    let raw = match failed {
        Some(f) if !f.is_empty() => Some((all, f)),
        _ => None,
    };
    sh.add(&row, raw);
    true
}

fn same(a: &Histogram<u64>, b: &Histogram<u64>) {
    assert_eq!(a.len(), b.len());
    assert_eq!(a.min(), b.min());
    assert_eq!(a.max(), b.max());
    assert_eq!(a.value_at_quantile(0.5), b.value_at_quantile(0.5));
    assert!((a.mean() - b.mean()).abs() < 1e-9);
}

fn win(all: Vec<u8>, failed: Option<Vec<u8>>) -> WindowWithHdr {
    WindowWithHdr {
        ts_second: 0,
        step_id: "s".into(),
        worker_id: "w".into(),
        count: 1,
        error_count: 0,
        status_counts: "{}".into(),
        hdr_histogram: all,
        failed_hdr_histogram: failed,
    }
}

#[test]
fn sample_block_wire_shape() {
    use handicap_controller::sample::SampleBlock;
    let b = SampleBlock {
        selected: Sample::Passed,
        default: Sample::Passed,
        split: true,
    };
    assert_eq!(
        serde_json::to_value(b).unwrap(),
        serde_json::json!({"selected": "passed", "default": "passed", "split": true})
    );
    let d = SampleBlock::default();
    assert_eq!(
        (d.selected, d.default, d.split),
        (Sample::All, Sample::All, false)
    );
}

#[test]
fn run_is_split_cases() {
    assert!(run_is_split(&[
        win(vec![], Some(vec![])),
        win(vec![], Some(blob(&[5])))
    ]));
    assert!(!run_is_split(&[win(vec![], None), win(vec![], None)]));
    assert!(!run_is_split(&[
        win(vec![], Some(vec![])),
        win(vec![], None)
    ]));
    assert!(!run_is_split(&[]));
}

#[test]
fn passed_equals_recording_passed_values_only() {
    let (a1, f1) = (blob(&[40_000, 41_000, 2_000]), blob(&[2_000]));
    let (a2, f2) = (blob(&[39_000]), Vec::new());
    let mut sh = SplitHist::default();
    assert!(feed(&mut sh, &a1, Some(&f1)));
    assert!(feed(&mut sh, &a2, Some(&f2)));
    let want = hist(&[40_000, 41_000, 39_000]);
    let r = sh.resolve(Sample::Passed);
    same(r.hist().unwrap(), &want);
    assert_eq!(sh.resolve(Sample::Failed).hist().unwrap().len(), 1);
    assert_eq!(sh.resolve(Sample::All).hist().unwrap().len(), 4);
    same(&sh.into_hist(Sample::Passed).unwrap(), &want);
}

#[test]
fn no_failures_borrows() {
    let a = blob(&[40_000, 41_000]);
    let mut sh = SplitHist::default();
    feed(&mut sh, &a, Some(&[]));
    match sh.resolve(Sample::Passed) {
        Resolved::Hist(Cow::Borrowed(h)) => assert_eq!(h.len(), 2),
        _ => panic!("expected a borrowed histogram"),
    }
}

#[test]
fn all_failed_is_empty() {
    let (a, f) = (blob(&[2_000]), blob(&[2_000]));
    let mut sh = SplitHist::default();
    feed(&mut sh, &a, Some(&f));
    assert!(sh.resolve(Sample::Passed).is_empty_sample());
    assert!(sh.resolve(Sample::Failed).hist().is_some());
    assert!(sh.into_hist(Sample::Passed).is_none());
}

#[test]
fn all_not_sent_is_empty_for_every_sample() {
    let a = blob(&[]);
    assert!(!a.is_empty());
    let mut sh = SplitHist::default();
    feed(&mut sh, &a, Some(&[]));
    for s in [Sample::Passed, Sample::All, Sample::Failed] {
        assert!(sh.resolve(s).is_empty_sample(), "{s:?}");
    }
}

#[test]
fn never_fed_is_broken() {
    let sh = SplitHist::default();
    for s in [Sample::Passed, Sample::All, Sample::Failed] {
        assert!(matches!(sh.resolve(s), Resolved::Broken), "{s:?}");
        assert!(!sh.resolve(s).is_empty_sample());
    }
    assert!(SplitHist::default().into_hist(Sample::All).is_none());
}

#[test]
fn corrupt_all_blob_drops_row() {
    assert!(decode_row(b"garbage-bytes", None).is_none());
    assert!(decode_row(b"garbage-bytes", Some(&[])).is_none());
}

#[test]
fn corrupt_failed_blob_drops_row_but_not_when_unread() {
    let a = blob(&[40_000]);
    assert!(decode_row(&a, Some(b"garbage-bytes")).is_none());
    assert!(decode_row(&a, None).is_some());
}

#[test]
fn inconsistent_row_is_dropped_others_survive() {
    let (a1, f1) = (blob(&[40_000]), blob(&[40_000, 50_000]));
    let (a2, f2) = (blob(&[41_000, 2_000]), blob(&[2_000]));
    let mut sh = SplitHist::default();
    feed(&mut sh, &a1, Some(&f1));
    feed(&mut sh, &a2, Some(&f2));
    same(sh.resolve(Sample::Passed).hist().unwrap(), &hist(&[41_000]));
    same(&sh.into_hist(Sample::Passed).unwrap(), &hist(&[41_000]));
}

#[test]
fn only_inconsistent_rows_is_broken() {
    let (a1, f1) = (blob(&[40_000]), blob(&[40_000, 50_000]));
    let mut sh = SplitHist::default();
    feed(&mut sh, &a1, Some(&f1));
    assert!(matches!(sh.resolve(Sample::Passed), Resolved::Broken));
    assert!(sh.into_hist(Sample::Passed).is_none());
}

#[test]
fn inconsistent_row_plus_clean_not_sent_row_is_empty() {
    let (a1, f1) = (blob(&[40_000]), blob(&[40_000, 50_000]));
    let a3 = blob(&[]);
    let mut sh = SplitHist::default();
    feed(&mut sh, &a1, Some(&f1));
    feed(&mut sh, &a3, Some(&[]));
    assert!(sh.resolve(Sample::Passed).is_empty_sample());
}

#[test]
fn per_window_rule() {
    let all = blob(&[40_000, 2_000]);
    assert_eq!(window_hist_per_window(&all, None).unwrap().len(), 2);
    assert_eq!(window_hist_per_window(&all, Some(&[])).unwrap().len(), 2);
    let f = blob(&[2_000]);
    same(
        &window_hist_per_window(&all, Some(&f)).unwrap(),
        &hist(&[40_000]),
    );
    let all_failed = blob(&[2_000]);
    assert!(window_hist_per_window(&all_failed, Some(&f)).is_none());
    assert!(window_hist_per_window(b"garbage-bytes", None).is_none());
}

#[test]
fn fallback_keeps_clean_rows_values() {
    let (a1, f1) = (blob(&[40_000]), blob(&[40_000, 50_000]));
    let a2 = blob(&[39_000]);
    let (a3, f3) = (blob(&[41_000, 2_000]), blob(&[2_000]));
    let mut sh = SplitHist::default();
    feed(&mut sh, &a1, Some(&f1));
    feed(&mut sh, &a2, Some(&[]));
    feed(&mut sh, &a3, Some(&f3));
    let want = hist(&[39_000, 41_000]);
    same(sh.resolve(Sample::Passed).hist().unwrap(), &want);
    same(&sh.into_hist(Sample::Passed).unwrap(), &want);
}

fn blob_with(high: u64, sigfig: u8, values: &[u64]) -> Vec<u8> {
    let mut h = Histogram::<u64>::new_with_bounds(1, high, sigfig).unwrap();
    for v in values {
        h.record(*v).unwrap();
    }
    let mut out = Vec::new();
    V2Serializer::new().serialize(&h, &mut out).unwrap();
    out
}

#[test]
fn row_with_wider_header_but_values_in_range_is_kept() {
    let a = blob_with(120_000_000, 3, &[40_000]);
    let row = decode_row(&a, None).expect("in-range values must be kept");
    assert_eq!(row.all.len(), 1);
    let mut sh = SplitHist::default();
    sh.add(&row, None);
    assert_eq!(sh.resolve(Sample::All).hist().unwrap().len(), 1);
}

#[test]
fn row_above_the_fixed_range_is_dropped_not_panicking() {
    let a = blob_with(200_000_000, 3, &[70_000_000]);
    assert!(decode_row(&a, None).is_none());
    let ok = blob(&[40_000]);
    assert!(decode_row(&ok, Some(&a)).is_none());
}

#[test]
fn row_with_max_value_60s_is_kept() {
    let a = blob(&[60_000_000]);
    let f = blob(&[60_000_000]);
    let row = decode_row(&a, Some(&f)).expect("60_000_000 is the fixed top");
    let mut sh = SplitHist::default();
    sh.add(&row, Some((&a, &f)));
    assert_eq!(sh.resolve(Sample::All).hist().unwrap().len(), 1);
}

#[test]
fn failed_samples_without_raw_are_still_counted_as_failed() {
    let (a, f) = (blob(&[40_000, 2_000]), blob(&[2_000]));
    let row = decode_row(&a, Some(&f)).unwrap();
    let mut sh = SplitHist::default();
    sh.add(&row, None);
    assert_eq!(sh.resolve(Sample::Failed).hist().unwrap().len(), 1);
    same(sh.resolve(Sample::Passed).hist().unwrap(), &hist(&[40_000]));
}

#[test]
fn inconsistent_row_without_raw_makes_the_slot_broken() {
    let (a1, f1) = (blob(&[40_000]), blob(&[40_000, 50_000]));
    let a2 = blob(&[39_000]);
    let mut sh = SplitHist::default();
    sh.add(&decode_row(&a1, Some(&f1)).unwrap(), None);
    feed(&mut sh, &a2, Some(&[]));
    assert!(matches!(sh.resolve(Sample::Passed), Resolved::Broken));
}

#[test]
fn resolved_and_decoded_row_are_debug() {
    let a = blob(&[40_000]);
    let row = decode_row(&a, None).unwrap();
    let _ = format!("{row:?}");
    let _ = format!("{:?}", SplitHist::default().resolve(Sample::All));
}

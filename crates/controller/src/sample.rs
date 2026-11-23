//! 응답 시간 표본 계산의 단일 지점: 통과한 요청(전체 − 실패)·실패한 요청·모든 요청.
//!
//! 저장된 행은 전체 분포와(워커가 나눠 보낸 경우) 실패한 요청의 분포를 가진다.
//! 통과 분포는 합쳐진 전체에서 합쳐진 실패를 빼서 구한다. 뺄 수 없으면(있을 수 없는 상태)
//! 행 단위로 다시 계산하고, 그래도 안 되는 행만 버린다.

use std::borrow::Cow;

use handicap_engine::percentiles::decode_hdr;
use hdrhistogram::Histogram;
use serde::{Deserialize, Serialize};

use crate::store::metrics::WindowWithHdr;

const LOW: u64 = 1;
const HIGH: u64 = 60_000_000;
const SIGFIG: u8 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Sample {
    Passed,
    Failed,
    #[default]
    All,
}

/// 모든 행에 실패 칸이 있어야(NULL 없음) 나눌 수 있다. 빈 목록은 나눌 수 없다.
pub fn run_is_split(rows: &[WindowWithHdr]) -> bool {
    !rows.is_empty() && rows.iter().all(|r| r.failed_hdr_histogram.is_some())
}

fn empty_hist() -> Histogram<u64> {
    Histogram::new_with_bounds(LOW, HIGH, SIGFIG).expect("fixed bounds are valid")
}

pub struct DecodedRow {
    pub all: Histogram<u64>,
    /// 실패한 요청의 분포. 실패 칸을 읽지 않았거나 비어 있으면 None.
    pub failed: Option<Histogram<u64>>,
}

/// 한 행을 한 번 디코드한다. None = 그 행을 버린다(전체 BLOB이 깨졌거나, 실패 BLOB이 비어 있지 않은데 깨졌다).
/// `failed`에 None을 넘기면 실패 칸을 읽지 않는다(나눌 수 없는 run).
pub fn decode_row(all: &[u8], failed: Option<&[u8]>) -> Option<DecodedRow> {
    let all = decode_hdr(all).ok()?.unwrap_or_else(empty_hist);
    if all.high() > HIGH {
        return None;
    }
    let failed = match failed {
        None => None,
        Some(b) => {
            let h = decode_hdr(b).ok()?;
            if h.as_ref().is_some_and(|h| h.high() > HIGH) {
                return None;
            }
            h
        }
    };
    Some(DecodedRow { all, failed })
}

pub enum Resolved<'a> {
    /// 표본이 1개 이상
    Hist(Cow<'a, Histogram<u64>>),
    /// 행은 계산됐는데 그 표본에 해당하는 요청이 없다
    Empty,
    /// 계산된 행이 하나도 없다
    Broken,
}

impl Resolved<'_> {
    pub fn hist(&self) -> Option<&Histogram<u64>> {
        match self {
            Resolved::Hist(c) => Some(c),
            _ => None,
        }
    }

    pub fn is_empty_sample(&self) -> bool {
        matches!(self, Resolved::Empty)
    }
}

fn merge(slot: &mut Option<Histogram<u64>>, h: &Histogram<u64>) {
    slot.get_or_insert_with(empty_hist)
        .add(h)
        .expect("row histograms are within the fixed bounds");
}

/// `a − b`를 복사본에서 계산한다. `subtract`는 실패해도 이미 뺀 부분을 남기므로 원본에는 쓰지 않는다.
fn subtracted(a: &Histogram<u64>, b: &Histogram<u64>) -> Option<Histogram<u64>> {
    let mut c = a.clone();
    c.subtract(b).ok()?;
    Some(c)
}

/// 한 누적 자리(초·스텝 창, 스텝, 워커, 전체). `'r` = 행 BLOB의 수명.
#[derive(Default)]
pub struct SplitHist<'r> {
    all: Option<Histogram<u64>>,
    failed: Option<Histogram<u64>>,
    fed: bool,
    clean_rows: usize,
    fail_rows: Vec<(&'r [u8], &'r [u8])>,
}

impl<'r> SplitHist<'r> {
    /// 디코드된 행을 합친다. `raw`는 그 행에 실패 표본이 있을 때만 (전체 BLOB, 실패 BLOB)을 넘긴다.
    pub fn add(&mut self, row: &DecodedRow, raw: Option<(&'r [u8], &'r [u8])>) {
        self.fed = true;
        merge(&mut self.all, &row.all);
        match (&row.failed, raw) {
            (Some(f), Some(raw)) if !f.is_empty() => {
                merge(&mut self.failed, f);
                self.fail_rows.push(raw);
            }
            _ => self.clean_rows += 1,
        }
    }

    pub fn resolve(&self, s: Sample) -> Resolved<'_> {
        if !self.fed {
            return Resolved::Broken;
        }
        match s {
            Sample::All => borrowed(self.all.as_ref()),
            Sample::Failed => borrowed(self.failed.as_ref()),
            Sample::Passed => match (&self.all, &self.failed) {
                (Some(all), Some(failed)) => match subtracted(all, failed) {
                    Some(h) if h.is_empty() => Resolved::Empty,
                    Some(h) => Resolved::Hist(Cow::Owned(h)),
                    None => self.passed_by_rows(),
                },
                (all, _) => borrowed(all.as_ref()),
            },
        }
    }

    /// resolve와 같은 결과를 소유권으로. 빼기가 필요 없으면 복사 없이 옮긴다.
    pub fn into_hist(self, s: Sample) -> Option<Histogram<u64>> {
        if !self.fed {
            return None;
        }
        let keep = |h: Option<Histogram<u64>>| h.filter(|h| !h.is_empty());
        match s {
            Sample::All => keep(self.all),
            Sample::Failed => keep(self.failed),
            Sample::Passed if self.failed.is_none() => keep(self.all),
            Sample::Passed => match self.resolve(Sample::Passed) {
                Resolved::Hist(c) => Some(c.into_owned()),
                _ => None,
            },
        }
    }

    /// 합친 분포끼리 뺄 수 없을 때: 행마다 (전체 − 실패)를 따로 구해 못 되는 행만 버린다.
    fn passed_by_rows(&self) -> Resolved<'_> {
        let Some(mut acc) = self.all.clone() else {
            return Resolved::Broken;
        };
        for (a, _) in &self.fail_rows {
            match decode_hdr(a) {
                Ok(Some(h)) => {
                    if acc.subtract(&h).is_err() {
                        return Resolved::Broken;
                    }
                }
                Ok(None) => {}
                Err(_) => return Resolved::Broken,
            }
        }
        let mut survivors = self.clean_rows;
        for (a, f) in &self.fail_rows {
            let (Ok(Some(a)), Ok(Some(f))) = (decode_hdr(a), decode_hdr(f)) else {
                continue;
            };
            if let Some(h) = subtracted(&a, &f)
                && acc.add(&h).is_ok()
            {
                survivors += 1;
            }
        }
        if survivors == 0 {
            Resolved::Broken
        } else if acc.is_empty() {
            Resolved::Empty
        } else {
            Resolved::Hist(Cow::Owned(acc))
        }
    }
}

fn borrowed(h: Option<&Histogram<u64>>) -> Resolved<'_> {
    match h {
        Some(h) if !h.is_empty() => Resolved::Hist(Cow::Borrowed(h)),
        _ => Resolved::Empty,
    }
}

/// 계단용: 실패 칸이 있으면(Some) 통과 표본, 없으면 전체. 계산 실패·표본 0은 None.
pub fn window_hist_per_window(all: &[u8], failed: Option<&[u8]>) -> Option<Histogram<u64>> {
    let row = decode_row(all, failed)?;
    let mut sh = SplitHist::default();
    let raw = failed.map(|f| (all, f));
    sh.add(&row, raw);
    sh.into_hist(Sample::Passed)
}

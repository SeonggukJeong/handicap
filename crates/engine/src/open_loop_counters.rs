//! open-loop 초 단위 계수(계단 시험 a, spec §4.2). 스케줄 루프(`Launched`·`Dropped`)와
//! 도착 태스크(`Completed`)가 `std::sync::Mutex<OpenLoopCounters>` 하나에 기록하고,
//! 주기 flusher가 끝난 초만, 최종 flush가 나머지 전부를 꺼낸다. 내부 동기화는 없다 —
//! 호출자가 잠금을 잡고 부르며 `.await`를 넘겨 잡지 않는다.

use std::collections::BTreeMap;

use crate::aggregator::current_second;
use crate::runner::OpenLoopSecond;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CountKind {
    Launched,
    Completed,
    Dropped,
}

#[derive(Debug)]
pub(crate) struct OpenLoopCounters {
    seconds: BTreeMap<i64, OpenLoopSecond>,
    /// 0행 채우기의 첫 초(스케줄 t=0이 속한 초).
    start_second: i64,
    /// 지금까지 내보낸 가장 큰 초. 처음엔 `start_second - 1`.
    last_emitted: i64,
    /// 스케줄 루프가 끝난 초. 이 뒤의 빈 초는 0행으로 채우지 않는다.
    end_s: Option<i64>,
}

impl OpenLoopCounters {
    pub(crate) fn new(start_second: i64) -> Self {
        Self {
            seconds: BTreeMap::new(),
            start_second,
            last_emitted: start_second.saturating_sub(1),
            end_s: None,
        }
    }

    pub(crate) fn record_at(&mut self, ts: i64, kind: CountKind) {
        let e = self.seconds.entry(ts).or_insert(OpenLoopSecond {
            ts_second: ts,
            launched: 0,
            completed: 0,
            dropped: 0,
        });
        match kind {
            CountKind::Launched => e.launched += 1,
            CountKind::Completed => e.completed += 1,
            CountKind::Dropped => e.dropped += 1,
        }
    }

    /// 현재 초는 호출 시점(= 잠금 안)에 읽는다 — 이미 내보낸 초를 다시 만들지 않기 위해서다.
    pub(crate) fn record(&mut self, kind: CountKind) {
        self.record_at(current_second(), kind);
    }

    pub(crate) fn end_scheduler(&mut self, now_s: i64) {
        self.end_s = Some(now_s);
    }

    /// `ts < now_s`인 초만 꺼낸다. 스케줄러가 살아 있던 빈 초는 0행으로 채운다.
    pub(crate) fn drain_completed(&mut self, now_s: i64) -> Vec<OpenLoopSecond> {
        let rest = self.seconds.split_off(&now_s);
        let done = std::mem::replace(&mut self.seconds, rest);
        let fill_hi = now_s.saturating_sub(1).min(self.end_s.unwrap_or(i64::MAX));
        self.emit(done, fill_hi)
    }

    /// 최종: 남은 전부 + 스케줄러가 끝난 초까지 0행.
    pub(crate) fn drain_all(&mut self) -> Vec<OpenLoopSecond> {
        let done = std::mem::take(&mut self.seconds);
        let fill_hi = match self.end_s {
            Some(end) => end,
            None => done.keys().next_back().copied().unwrap_or(i64::MIN),
        };
        self.emit(done, fill_hi)
    }

    fn emit(
        &mut self,
        mut done: BTreeMap<i64, OpenLoopSecond>,
        fill_hi: i64,
    ) -> Vec<OpenLoopSecond> {
        let fill_lo = self.start_second.max(self.last_emitted.saturating_add(1));
        if fill_lo <= fill_hi {
            for ts in fill_lo..=fill_hi {
                done.entry(ts).or_insert(OpenLoopSecond {
                    ts_second: ts,
                    launched: 0,
                    completed: 0,
                    dropped: 0,
                });
            }
        }
        if let Some(&max_ts) = done.keys().next_back() {
            self.last_emitted = self.last_emitted.max(max_ts);
        }
        done.into_values().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now_second() -> i64 {
        current_second()
    }

    fn row(ts_second: i64, launched: u64, completed: u64, dropped: u64) -> OpenLoopSecond {
        OpenLoopSecond {
            ts_second,
            launched,
            completed,
            dropped,
        }
    }

    #[test]
    fn drain_completed_excludes_current_second() {
        let mut c = OpenLoopCounters::new(10);
        c.record_at(10, CountKind::Launched);
        c.record_at(11, CountKind::Dropped);
        assert_eq!(c.drain_completed(11), vec![row(10, 1, 0, 0)]);
        assert_eq!(c.drain_completed(12), vec![row(11, 0, 0, 1)]);
    }

    #[test]
    fn zero_fill_between_records() {
        let mut c = OpenLoopCounters::new(10);
        c.record_at(13, CountKind::Completed);
        let rows = c.drain_completed(15);
        let ts: Vec<i64> = rows.iter().map(|r| r.ts_second).collect();
        assert_eq!(ts, vec![10, 11, 12, 13, 14]);
        for r in &rows {
            if r.ts_second == 13 {
                assert_eq!(*r, row(13, 0, 1, 0));
            } else {
                assert_eq!(*r, row(r.ts_second, 0, 0, 0));
            }
        }
    }

    #[test]
    fn no_zero_fill_after_scheduler_end() {
        let mut c = OpenLoopCounters::new(10);
        c.end_scheduler(12);
        c.record_at(14, CountKind::Completed);
        let ts: Vec<i64> = c.drain_all().iter().map(|r| r.ts_second).collect();
        assert_eq!(ts, vec![10, 11, 12, 14]);
    }

    #[test]
    fn record_uses_clock_and_is_counted_once() {
        let mut c = OpenLoopCounters::new(now_second());
        c.record(CountKind::Launched);
        c.record(CountKind::Launched);
        let launched: u64 = c.drain_all().iter().map(|r| r.launched).sum();
        assert_eq!(launched, 2);
    }
}

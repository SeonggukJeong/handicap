//! 조건 반복 리포트 집계(loop-while-report) — 진입이 끝난 회차·방식 건수가 flush에 실린다.
use handicap_engine::{LOOP_EXIT_PASS_CAP, LoopExitOutcome, LoopExitStat};

#[test]
fn loop_exit_wire_values_are_fixed() {
    assert_eq!(LOOP_EXIT_PASS_CAP, 20);
    assert_eq!(LoopExitOutcome::Completed.as_wire(), 0);
    assert_eq!(LoopExitOutcome::Exhausted.as_wire(), 1);
    assert_eq!(LoopExitOutcome::Truncated.as_wire(), 2);
    let s = LoopExitStat {
        step_id: "l".into(),
        pass_bucket: 21,
        outcome: LoopExitOutcome::Truncated,
        count: 1,
        pass_sum: 500,
    };
    assert_eq!(s.pass_bucket, LOOP_EXIT_PASS_CAP + 1);
}

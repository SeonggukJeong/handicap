//! 조건 반복 응답 시간 분리(loop-while-latency-split).
use handicap_engine::{
    LOOP_SPLIT_PASS_SAMPLE_CAP, LoopSplitClass, PHASE_LOOP_CUT, PHASE_LOOP_CUT_ERR,
    PHASE_LOOP_FINAL, PHASE_LOOP_FINAL_ERR, PHASE_LOOP_RETRY, PHASE_LOOP_RETRY_ERR,
};

#[test]
fn loop_split_wire_names_are_fixed() {
    assert_eq!(LOOP_SPLIT_PASS_SAMPLE_CAP, 1024);
    assert_eq!(
        [PHASE_LOOP_FINAL, PHASE_LOOP_RETRY, PHASE_LOOP_CUT],
        ["loop_final", "loop_retry", "loop_cut"]
    );
    assert_eq!(
        [
            PHASE_LOOP_FINAL_ERR,
            PHASE_LOOP_RETRY_ERR,
            PHASE_LOOP_CUT_ERR
        ],
        ["loop_final_err", "loop_retry_err", "loop_cut_err"]
    );
    assert_eq!(LoopSplitClass::Ended.phase(), PHASE_LOOP_FINAL);
    assert_eq!(LoopSplitClass::Continued.phase(), PHASE_LOOP_RETRY);
    assert_eq!(LoopSplitClass::Cut.phase(), PHASE_LOOP_CUT);
    assert_eq!(LoopSplitClass::Cut.err_phase(), PHASE_LOOP_CUT_ERR);
}

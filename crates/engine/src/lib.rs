pub mod aggregator;
pub mod blank_guard;
mod cast;
pub mod condition;
mod conn_timing;
pub mod dataset;
pub mod error;
pub mod error_kind;
pub mod executor;
pub mod extract;
mod genvars;
pub mod pacing;
pub mod percentiles;
mod reqgen;
pub mod runner;
pub mod scenario;
pub mod template;
pub mod trace;

pub use aggregator::{
    ActiveVuSample, Aggregator, BranchStat, ErrorKindStat, GroupStat, LOOP_EXIT_PASS_CAP,
    LOOP_SPLIT_PASS_SAMPLE_CAP, LoopExitOutcome, LoopExitStat, LoopSplitClass, LoopStat,
    PHASE_LOOP_CUT, PHASE_LOOP_CUT_ERR, PHASE_LOOP_FINAL, PHASE_LOOP_FINAL_ERR, PHASE_LOOP_RETRY,
    PHASE_LOOP_RETRY_ERR, PhaseStat, StepWindow,
};
pub use blank_guard::{BLOCKED_ERROR, BlankTable, Blocked};
pub use condition::{BranchEval, LeafEval, eval_condition, explain_branches};
pub use dataset::{BindingPolicy, DataSet};
pub use error::{EngineError, Result};
pub use error_kind::{ErrorKind, classify_send_error};
pub use executor::{
    ExecOutcome, ExtractMode, VuClient, execute_step, execute_step_traced,
    execute_step_traced_with, execute_step_with,
};
pub use extract::{
    Filled, ResponseFacts, StrictOutcome, evaluate as evaluate_extracts, evaluate_lenient,
    evaluate_with_defaults, fill_missing_extracts, has_default,
};
pub use genvars::{
    GenSpec, PICK_ARRAY_MAX_LEN, POSITIONS_MAX_CHARS, PickArrayGen, RandomIntGen, RandomStringGen,
    Refresh, VarDecl, parse_positions, seed_iter_vars,
};
pub use pacing::{PaceOutcome, ThinkTime, pace};
pub use runner::{
    MetricFlush, RampDown, RunPlan, Stage, run_scenario, run_scenario_open_loop,
    run_scenario_vu_curve,
};
pub use scenario::{
    Assertion, Body, Branch, CompareOp, Condition, CookieJarMode, ElifBranch, HttpMethod, HttpStep,
    IfStep, LoopStep, ParallelStep, Request, Scenario, Step,
};
pub use template::{TemplateContext, render, render_collecting, render_lenient};
pub use trace::{
    BlockedInfo, HttpTrace, RowTrace, RowsTrace, ScenarioTrace, StepKind, StepTrace, TraceOptions,
    TracedRequest, TracedResponse, trace_scenario, trace_scenario_rows, trace_scenario_with_seed,
};

pub mod aggregator;
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
    ActiveVuSample, Aggregator, BranchStat, ErrorKindStat, GroupStat, LoopStat, PhaseStat,
    StepWindow,
};
pub use condition::eval_condition;
pub use dataset::{BindingPolicy, DataSet};
pub use error::{EngineError, Result};
pub use error_kind::{ErrorKind, classify_send_error};
pub use executor::{ExecOutcome, VuClient, execute_step, execute_step_traced};
pub use extract::{ResponseFacts, evaluate as evaluate_extracts};
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
    HttpTrace, RowTrace, RowsTrace, ScenarioTrace, StepKind, StepTrace, TraceOptions,
    TracedRequest, TracedResponse, trace_scenario, trace_scenario_rows, trace_scenario_with_seed,
};

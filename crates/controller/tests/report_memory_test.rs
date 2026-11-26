//! 리포트 생성 중 최대 메모리가 run 길이에 비례하지 않음을 잡는 회귀 테스트.
//! 전역 할당기가 최대치를 하나만 세므로 이 파일엔 `#[test]`가 하나뿐이다.

use handicap_controller::report::build_report;
use handicap_controller::stair::{StairConfig, StairInputs, build_stair_report, expand_stair};
use handicap_controller::store::metrics::WindowWithHdr;
use handicap_controller::store::open_loop::{OpenLoopSecondRow, WorkerStartRow};
use handicap_controller::store::runs::{
    LATENCY_RULE_LEGACY, Profile, RunRow, RunStatus, STATUS_RULE_LEGACY,
};
use hdrhistogram::Histogram;
use hdrhistogram::serialization::{Serializer, V2Serializer};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

const MIB: usize = 1024 * 1024;
const N_R: i64 = 60;
const REPORT_ABS: usize = 64 * MIB;
const REPORT_GROWTH: usize = 16 * MIB;
const N_S: i64 = 300;
const STAIR_ABS: usize = 32 * MIB;
const STAIR_GROWTH: usize = 8 * MIB;

static CUR: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

struct Counting;

fn add(n: usize) {
    let cur = CUR.fetch_add(n, Ordering::SeqCst) + n;
    PEAK.fetch_max(cur, Ordering::SeqCst);
}

// SAFETY: 모든 호출을 System에 그대로 위임하고 크기만 센다.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            add(layout.size());
        }
        p
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        CUR.fetch_sub(layout.size(), Ordering::SeqCst);
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = unsafe { System.realloc(ptr, layout, new_size) };
        if !p.is_null() {
            if new_size >= layout.size() {
                add(new_size - layout.size());
            } else {
                CUR.fetch_sub(layout.size() - new_size, Ordering::SeqCst);
            }
        }
        p
    }
}

#[global_allocator]
static A: Counting = Counting;

fn measure<T>(f: impl FnOnce() -> T) -> usize {
    let base = CUR.load(Ordering::SeqCst);
    PEAK.store(base, Ordering::SeqCst);
    let out = f();
    let peak = PEAK.load(Ordering::SeqCst);
    drop(out);
    peak - base
}

fn hdr(samples: &[u64]) -> Vec<u8> {
    let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    for &v in samples {
        h.record(v).unwrap();
    }
    let mut buf = Vec::new();
    V2Serializer::new().serialize(&h, &mut buf).unwrap();
    buf
}

fn report_rows(secs: i64) -> Vec<WindowWithHdr> {
    let mut rows = Vec::with_capacity(secs as usize * 10);
    for ts in 0..secs {
        for s in 0..10_u64 {
            let samples: Vec<u64> = (0..100_u64)
                .map(|i| 1_000 + (i * 997 + s * 31 + ts as u64 * 7) % 90_000)
                .collect();
            rows.push(WindowWithHdr {
                ts_second: ts,
                step_id: format!("s{s:02}"),
                worker_id: "w-0".into(),
                count: 100,
                error_count: 5,
                status_counts: r#"{"200":100}"#.into(),
                hdr_histogram: hdr(&samples),
                failed_hdr_histogram: Some(hdr(&samples[..5])),
            });
        }
    }
    rows
}

fn run_row() -> RunRow {
    RunRow {
        id: "R1".into(),
        scenario_id: "S1".into(),
        scenario_yaml: "version: 1\nname: x\nsteps: []\n".into(),
        profile: Profile {
            vus: 1,
            ramp_up_seconds: 0,
            duration_seconds: 2,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            data_binding: None,
            data_bindings: vec![],
            criteria: None,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
            measure_phases: false,
            vu_stages: None,
            ramp_down: None,
            graceful_ramp_down_seconds: None,
            connect_timeout_seconds: None,
            worker_count: None,
            apply_scenario_think_time: true,
            stair: None,
            steady: None,
        },
        env: serde_json::Value::Object(serde_json::Map::new()),
        status: RunStatus::Completed,
        started_at: Some(100_000),
        ended_at: Some(102_000),
        created_at: 99_000,
        message: None,
        dropped: 0,
        verdict: None,
        label: None,
        auto_stop: None,
        status_rule: STATUS_RULE_LEGACY,
        latency_rule: LATENCY_RULE_LEGACY,
    }
}

fn stair_profile() -> Profile {
    let c = StairConfig {
        targets: vec![10, 20, 30],
        ramp_seconds: 10,
        hold_seconds: 190,
        discard_seconds: 10,
        p99_cap_ms: None,
        auto_stop: None,
    };
    let mut p = run_row().profile;
    p.duration_seconds = 0;
    p.max_in_flight = Some(50);
    p.stages = Some(expand_stair(&c));
    p.stair = Some(c);
    p
}

fn stair_inputs(secs: i64) -> (Vec<WindowWithHdr>, StairInputs) {
    let mut rows = Vec::new();
    let mut open_loop = Vec::new();
    let mut starts = Vec::new();
    for (w, t0_ms) in [("w-a", 1_000_000_i64), ("w-b", 1_001_000_i64)] {
        starts.push(WorkerStartRow {
            worker_id: w.into(),
            started_at_ms: t0_ms,
        });
        let t0 = t0_ms.div_euclid(1000);
        for k in 0..secs {
            let ts = t0 + k;
            open_loop.push(OpenLoopSecondRow {
                worker_id: w.into(),
                ts_second: ts,
                launched: 10,
                completed: 10,
                dropped: 0,
            });
            let samples: Vec<u64> = (0..10_u64)
                .map(|j| 10_000 + (ts as u64 * 13 + j * 101) % 50_000)
                .collect();
            rows.push(WindowWithHdr {
                ts_second: ts,
                step_id: "s".into(),
                worker_id: w.into(),
                count: 10,
                error_count: 0,
                status_counts: r#"{"200":10}"#.into(),
                hdr_histogram: hdr(&samples),
                failed_hdr_histogram: None,
            });
        }
    }
    (
        rows,
        StairInputs {
            open_loop,
            starts,
            auto_stop: None,
        },
    )
}

fn report_peak(rows: &[WindowWithHdr]) -> usize {
    let run = run_row();
    let yaml = run.scenario_yaml.clone();
    measure(|| {
        build_report(
            &run,
            &yaml,
            rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &StairInputs::default(),
            &[],
            None,
            None,
            None,
        )
    })
}

fn stair_peak(secs: i64) -> usize {
    let profile = stair_profile();
    let (rows, inp) = stair_inputs(secs);
    measure(|| build_stair_report(&profile, 0, &rows, &inp))
}

#[test]
fn report_memory_does_not_scale_with_run_length() {
    let (r1, r2) = (report_rows(N_R), report_rows(2 * N_R));
    let p1 = report_peak(&r1);
    let p2 = report_peak(&r2);
    eprintln!("REPORT peak N={N_R}: {p1} B, 2N: {p2} B");
    let s1 = stair_peak(N_S);
    let s2 = stair_peak(2 * N_S);
    eprintln!("STAIR peak N={N_S}: {s1} B, 2N: {s2} B");
    assert!(
        p2 <= REPORT_ABS && p2.saturating_sub(p1) <= REPORT_GROWTH,
        "report peak grew with run length: N={p1} B, 2N={p2} B"
    );
    assert!(
        s2 <= STAIR_ABS && s2.saturating_sub(s1) <= STAIR_GROWTH,
        "stair report peak grew with run length: N={s1} B, 2N={s2} B"
    );
}

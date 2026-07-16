// run-level think time: with a fixed inter-iteration delay, fewer iterations run
// in a fixed window than with no delay. Uses a stub HTTP target.
use handicap_engine::{MetricFlush, RampDown, RunPlan, Scenario, ThinkTime, run_scenario};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

// ---- scenario default think time (R1/R3/R4/R5/R16) ----
use handicap_engine::{Stage, run_scenario_open_loop, run_scenario_vu_curve};

#[derive(Clone, Copy)]
enum Mode {
    Closed,
    Curve,
    Open,
}

/// 임의 시나리오 YAML(서버 uri 치환) + 임의 RunPlan으로 창(window) 안의 총 요청 수를 센다.
/// step_id에 무관하게 전부 합산한다(상속은 여러 스텝에 걸리므로).
/// `mode`가 **어느 엔진 진입점을 탈지**를 정한다 — closed/curve/open이 각각 다른 VU 루프
/// (`run_vu` / `run_vu_curve` / `run_arrival`)를 돌기 때문에, 이걸 안 갈라주면 곡선·open-loop
/// 테스트가 사실은 closed-loop만 검사한다(= 호출부를 빠뜨려도 green).
async fn count_all(
    mode: Mode,
    yaml_tpl: &str,
    dur_ms: u64,
    tweak: impl FnOnce(&mut RunPlan),
) -> u64 {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = yaml_tpl.replace("{URI}", &server.uri());
    let scenario = Arc::new(Scenario::from_yaml(&yaml).unwrap());
    let mut plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_millis(dur_ms),
        env: Default::default(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_bindings: vec![],
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
        stages: None,
        measure_phases: false,
        vu_stages: None,
        ramp_down: RampDown::Graceful,
        graceful_ramp_down: None,
    };
    tweak(&mut plan);
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let cancel = CancellationToken::new();
    // 세 진입점은 시그니처가 같아 JoinHandle 타입이 일치한다.
    let h = match mode {
        Mode::Closed => tokio::spawn(run_scenario(scenario, plan, tx, cancel)),
        Mode::Curve => tokio::spawn(run_scenario_vu_curve(scenario, plan, tx, cancel)),
        Mode::Open => tokio::spawn(run_scenario_open_loop(scenario, plan, tx, cancel)),
    };
    let mut total = 0u64;
    while let Some(f) = rx.recv().await {
        for w in f.windows {
            total += w.count;
        }
    }
    h.await.unwrap().unwrap();
    total
}

/// 1 http 스텝. `{DEFAULT}` 자리에 시나리오 기본값 블록(또는 빈 문자열), `{THINK}`에 스텝 think 블록.
const ONE_STEP: &str = "version: 1
name: t
{DEFAULT}steps:
  - type: http
    id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
    name: s
    request:
      method: GET
      url: {URI}/
{THINK}";

fn one_step(default_block: &str, think_block: &str) -> String {
    ONE_STEP
        .replace("{DEFAULT}", default_block)
        .replace("{THINK}", think_block)
}

const DEFAULT_200: &str = "default_think_time:\n  min_ms: 200\n  max_ms: 200\n";

#[tokio::test]
async fn scenario_default_think_time_paces_inheriting_steps() {
    // 기본값 없음: 600ms 창에 로컬 스텁 상대로 수십~수백 요청.
    let none = count_all(Mode::Closed, &one_step("", ""), 600, |_| {}).await;
    // 기본값 200ms: 스텝이 상속 → 요청 사이 200ms 대기 → 훨씬 적다(~3).
    let inherited = count_all(Mode::Closed, &one_step(DEFAULT_200, ""), 600, |_| {}).await;
    assert!(
        inherited < none / 10 && inherited > 0,
        "inherited={inherited} none={none}"
    );
}

#[tokio::test]
async fn zero_step_think_time_opts_out_of_scenario_default() {
    // 기본값 200ms + 그 스텝만 {0,0} → 대기 없음(상속 거부) → 기본값 없을 때와 같은 급.
    // (상속됐다면 ~3건까지 떨어진다 — 아래 하한은 그 10배 이상이라 여유가 크다.)
    let opted_out = count_all(
        Mode::Closed,
        &one_step(
            DEFAULT_200,
            "    think_time:\n      min_ms: 0\n      max_ms: 0\n",
        ),
        600,
        |_| {},
    )
    .await;
    let none = count_all(Mode::Closed, &one_step("", ""), 600, |_| {}).await;
    assert!(
        opted_out > none / 3,
        "opted_out={opted_out} none={none} (0/0은 대기 없음이어야 한다)"
    );
}

#[tokio::test]
async fn step_think_time_overrides_scenario_default() {
    // 기본값 200ms인데 스텝이 20ms를 명시 → 스텝 값이 이긴다 → 상속보다 훨씬 많이 돈다.
    let overridden = count_all(
        Mode::Closed,
        &one_step(
            DEFAULT_200,
            "    think_time:\n      min_ms: 20\n      max_ms: 20\n",
        ),
        600,
        |_| {},
    )
    .await;
    let inherited = count_all(Mode::Closed, &one_step(DEFAULT_200, ""), 600, |_| {}).await;
    assert!(
        overridden > inherited * 3,
        "overridden={overridden} inherited={inherited}"
    );
}

#[tokio::test]
async fn parallel_branch_ignores_scenario_default() {
    // 분기 안의 http 스텝: 기본값은 적용되지 않는다(R4).
    let par = "version: 1
name: t
{DEFAULT}steps:
  - type: parallel
    id: 01ARZ3NDEKTSV4RRFFQ69G5FAW
    name: p
    branches:
      - name: b1
        steps:
          - type: http
            id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
            name: s
            request:
              method: GET
              url: {URI}/
{THINK}";
    let with_default = count_all(
        Mode::Closed,
        &par.replace("{DEFAULT}", DEFAULT_200).replace("{THINK}", ""),
        600,
        |_| {},
    )
    .await;
    let no_default = count_all(
        Mode::Closed,
        &par.replace("{DEFAULT}", "").replace("{THINK}", ""),
        600,
        |_| {},
    )
    .await;
    // 기본값이 분기에 안 걸리므로 두 카운트가 같은 급이어야 한다(걸렸다면 ~3건으로 폭락한다).
    assert!(
        with_default > no_default / 3,
        "with_default={with_default} no_default={no_default} (분기엔 기본값 미적용이어야 한다)"
    );
    // 반면 분기 스텝에 **명시**하면 적용된다(현행 보존).
    let explicit = count_all(
        Mode::Closed,
        &par.replace("{DEFAULT}", "").replace(
            "{THINK}",
            "            think_time:\n              min_ms: 200\n              max_ms: 200\n",
        ),
        600,
        |_| {},
    )
    .await;
    assert!(
        explicit < no_default / 10 && explicit > 0,
        "explicit={explicit} no_default={no_default}"
    );
}

#[tokio::test]
async fn vu_curve_path_applies_scenario_default() {
    // R16: closed-loop VU 곡선은 `run_scenario_vu_curve` → `run_vu_curve`(run_vu 본문의
    // 의도적 복제)를 탄다. **Mode::Curve로 그 진입점을 직접 타야** 이 테스트가 의미를 갖는다
    // (Mode::Closed로 돌리면 vu_stages가 무시돼 closed-loop만 검사하는 가짜 green이 된다).
    let curve = |p: &mut RunPlan| {
        p.vus = 1;
        p.vu_stages = Some(vec![Stage {
            target: 1,
            duration_seconds: 1,
        }]);
    };
    let none = count_all(Mode::Curve, &one_step("", ""), 1000, curve).await;
    let inherited = count_all(Mode::Curve, &one_step(DEFAULT_200, ""), 1000, curve).await;
    assert!(
        inherited < none / 10 && inherited > 0,
        "vu_stages: inherited={inherited} none={none}"
    );
}

#[tokio::test]
async fn open_loop_applies_scenario_default() {
    // R3(open-loop): `run_scenario_open_loop` → `run_arrival`. 슬롯 1개 + 높은 목표 도착률 →
    // 슬롯 점유시간이 처리량을 지배한다. 기본값 200ms가 상속되면 반복이 200ms 이상 슬롯을
    // 잡아 완료 수가 급감한다. (Mode::Open 필수 — Closed면 target_rps가 무시된다.)
    let open = |p: &mut RunPlan| {
        p.target_rps = Some(50);
        p.max_in_flight = Some(1);
    };
    let none = count_all(Mode::Open, &one_step("", ""), 600, open).await;
    let inherited = count_all(Mode::Open, &one_step(DEFAULT_200, ""), 600, open).await;
    assert!(
        inherited < none / 5 && inherited > 0,
        "open-loop: inherited={inherited} none={none}"
    );
}

async fn count_requests(plan_think: Option<ThinkTime>, dur_ms: u64) -> u64 {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = format!(
        "version: 1\nname: t\nsteps:\n  - type: http\n    id: s\n    name: s\n    request:\n      method: GET\n      url: {}/\n",
        server.uri()
    );
    let scenario = Arc::new(Scenario::from_yaml(&yaml).unwrap());
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_millis(dur_ms),
        env: Default::default(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_bindings: vec![],
        http_timeout: Duration::from_secs(30),
        think_time: plan_think,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
        stages: None,
        measure_phases: false,
        vu_stages: None,
        ramp_down: RampDown::Graceful,
        graceful_ramp_down: None,
    };
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let cancel = CancellationToken::new();
    let h = tokio::spawn(run_scenario(scenario, plan, tx, cancel));
    let mut total = 0u64;
    while let Some(f) = rx.recv().await {
        for w in f.windows {
            if w.step_id == "s" {
                total += w.count;
            }
        }
    }
    h.await.unwrap().unwrap();
    total
}

#[tokio::test]
async fn run_level_think_time_reduces_iterations() {
    // No think time: many iterations against a localhost stub in ~600ms.
    let none = count_requests(None, 600).await;
    // 200ms inter-iteration pause: far fewer (~3-4) in the same window.
    let paced = count_requests(
        Some(ThinkTime {
            min_ms: 200,
            max_ms: 200,
        }),
        600,
    )
    .await;
    assert!(
        none > paced,
        "expected fewer paced iterations: none={none} paced={paced}"
    );
    assert!(paced >= 1, "at least one iteration must run");
}

// per-step think time fires after the step's request, every execution. With a
// fixed per-step delay, fewer total requests fit the window than without.
#[tokio::test]
async fn per_step_think_time_reduces_requests() {
    async fn count(per_step_ms: Option<u32>, dur_ms: u64) -> u64 {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let tt = per_step_ms
            .map(|m| format!("\n    think_time:\n      min_ms: {m}\n      max_ms: {m}"))
            .unwrap_or_default();
        let yaml = format!(
            "version: 1\nname: t\nsteps:\n  - type: http\n    id: s\n    name: s\n    request:\n      method: GET\n      url: {}/{}\n",
            server.uri(),
            tt
        );
        let scenario = Arc::new(Scenario::from_yaml(&yaml).unwrap());
        let plan = RunPlan {
            vus: 1,
            ramp_up: Duration::from_secs(0),
            duration: Duration::from_millis(dur_ms),
            env: Default::default(),
            loop_breakdown_cap: 0,
            vu_offset: 0,
            data_bindings: vec![],
            http_timeout: Duration::from_secs(30),
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
            measure_phases: false,
            vu_stages: None,
            ramp_down: RampDown::Graceful,
            graceful_ramp_down: None,
        };
        let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
        let h = tokio::spawn(run_scenario(scenario, plan, tx, CancellationToken::new()));
        let mut total = 0u64;
        while let Some(f) = rx.recv().await {
            for w in f.windows {
                if w.step_id == "s" {
                    total += w.count;
                }
            }
        }
        h.await.unwrap().unwrap();
        total
    }
    let none = count(None, 600).await;
    let paced = count(Some(200), 600).await;
    assert!(
        none > paced,
        "per-step pause should cut throughput: none={none} paced={paced}"
    );
    assert!(
        paced >= 1,
        "at least one paced request must run: paced={paced}"
    );
}

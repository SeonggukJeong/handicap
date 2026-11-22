//! 구간(section) 실행 — 지금은 VU당 한 번 도는 준비(`setup`) 하나.
//!
//! 구간의 요청 통계는 본 `Aggregator`와 별개의 `SectionStats`에만 쌓는다. 본 스텝의 요청 경로
//! (`runner::execute_steps`)는 이 모듈을 모른다.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hdrhistogram::Histogram;
use hdrhistogram::serialization::{Serializer, V2Serializer};
use rand::rngs::StdRng;
use tokio_util::sync::CancellationToken;

use crate::error::{EngineError, Result};
use crate::error_kind::ErrorKind;
use crate::executor::{ErrorClass, ExtractMode, VuClient, execute_step_with};
use crate::pacing::{PaceOutcome, ThinkTime, pace};
use crate::reqgen::ReqGen;
use crate::scenario::Step;
use crate::template::TemplateContext;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Section {
    Setup,
}

impl Section {
    pub fn as_str(self) -> &'static str {
        match self {
            Section::Setup => "setup",
        }
    }

    pub fn from_wire(s: &str) -> Option<Section> {
        match s {
            "setup" => Some(Section::Setup),
            _ => None,
        }
    }
}

/// 한 flush 구간의 스텝 통계 델타.
#[derive(Debug, Clone)]
pub struct SectionStepStat {
    pub section: Section,
    pub step_id: String,
    pub count: u64,
    pub error_count: u64,
    /// 0 = 전송 실패 (`StepWindow`와 같은 규칙).
    pub status_counts: HashMap<u16, u64>,
    /// 본 창과 같은 bound, 단위 µs.
    pub histogram: Histogram<u64>,
    pub failure_kinds: BTreeMap<&'static str, u64>,
}

impl SectionStepStat {
    fn new(section: Section, step_id: &str) -> Self {
        Self {
            section,
            step_id: step_id.to_string(),
            count: 0,
            error_count: 0,
            status_counts: HashMap::new(),
            histogram: Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).expect("valid bounds"),
            failure_kinds: BTreeMap::new(),
        }
    }

    /// 본 창(`StepWindow::serialize_histogram`)과 같은 직렬화.
    pub fn serialize_histogram(&self) -> Result<Vec<u8>> {
        let mut buf = Vec::new();
        V2Serializer::new()
            .serialize(&self.histogram, &mut buf)
            .map_err(|e| EngineError::Histogram(e.to_string()))?;
        Ok(buf)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SectionOutcome {
    pub section: Section,
    pub ok: u64,
    pub failed: u64,
    pub interrupted: u64,
    /// 이 구간에서 마지막으로 성공한 실행의 완료 epoch ms.
    pub last_done_ms: Option<i64>,
}

#[derive(Default)]
struct OutcomeAcc {
    ok: u64,
    failed: u64,
    interrupted: u64,
    last_done_ms: Option<i64>,
}

/// 본 `Aggregator`와 별도의 누적기. 준비가 있는 run만 만든다.
#[derive(Default)]
pub struct SectionStats {
    steps: HashMap<(Section, String), SectionStepStat>,
    outcomes: HashMap<Section, OutcomeAcc>,
}

pub type SharedSectionStats = Arc<Mutex<SectionStats>>;

impl SectionStats {
    fn step(&mut self, section: Section, step_id: &str) -> &mut SectionStepStat {
        self.steps
            .entry((section, step_id.to_string()))
            .or_insert_with(|| SectionStepStat::new(section, step_id))
    }

    pub fn record_request(
        &mut self,
        section: Section,
        step_id: &str,
        status: u16,
        latency: Duration,
        is_error: bool,
    ) {
        let us = (latency.as_micros().min(u64::MAX as u128) as u64).clamp(1, 60_000_000);
        let s = self.step(section, step_id);
        let _ = s.histogram.record(us);
        s.count += 1;
        if is_error {
            s.error_count += 1;
        }
        *s.status_counts.entry(status).or_insert(0) += 1;
    }

    pub fn record_failure_kind(&mut self, section: Section, step_id: &str, kind: &'static str) {
        *self
            .step(section, step_id)
            .failure_kinds
            .entry(kind)
            .or_insert(0) += 1;
    }

    pub fn record_ok(&mut self, section: Section, done_at_ms: i64) {
        let o = self.outcomes.entry(section).or_default();
        o.ok += 1;
        o.last_done_ms = Some(o.last_done_ms.map_or(done_at_ms, |m| m.max(done_at_ms)));
    }

    pub fn record_failed(&mut self, section: Section) {
        self.outcomes.entry(section).or_default().failed += 1;
    }

    pub fn record_interrupted(&mut self, section: Section) {
        self.outcomes.entry(section).or_default().interrupted += 1;
    }

    /// 쌓인 델타를 꺼내고 비운다. 세 수가 0이고 last_done이 없으면 outcome을 내지 않는다.
    pub fn drain(&mut self) -> (Vec<SectionStepStat>, Vec<SectionOutcome>) {
        let mut steps: Vec<SectionStepStat> = self.steps.drain().map(|(_, v)| v).collect();
        steps.sort_by(|a, b| a.step_id.cmp(&b.step_id));
        let outcomes = self
            .outcomes
            .drain()
            .filter(|(_, o)| o.ok + o.failed + o.interrupted > 0 || o.last_done_ms.is_some())
            .map(|(section, o)| SectionOutcome {
                section,
                ok: o.ok,
                failed: o.failed,
                interrupted: o.interrupted,
                last_done_ms: o.last_done_ms,
            })
            .collect();
        (steps, outcomes)
    }
}

/// 구간 한 번 실행의 결과.
#[derive(Debug)]
pub enum SectionRun {
    /// 끝까지 성공. 값 = 이 구간의 스텝들이 실제로 추출한 이름과 값.
    Done(BTreeMap<String, String>),
    /// 항상 `EngineError::SetupFailed`.
    Failed(EngineError),
    Deadline,
    Aborted,
}

fn lock(stats: &SharedSectionStats) -> std::sync::MutexGuard<'_, SectionStats> {
    stats.lock().unwrap_or_else(|e| e.into_inner())
}

/// 렌더 단계 엔진 오류 중 준비 실패로 분류하는 것: (종류, 변수 이름). 나머지는 `None`.
fn classify_engine_error(e: &EngineError) -> Option<(&'static str, Option<String>)> {
    match e {
        EngineError::UnknownVar(name) => Some(("unknown_var", Some(name.clone()))),
        EngineError::MalformedTemplate(_) => Some(("malformed_template", None)),
        EngineError::CastFailed { var, .. } => Some(("cast_failed", Some(var.clone()))),
        EngineError::ScenarioParse(_)
        | EngineError::Http(_)
        | EngineError::AllVusFailed { .. }
        | EngineError::Histogram(_)
        | EngineError::Io(_)
        | EngineError::ExtractFailed(_)
        | EngineError::SetupFailed { .. }
        | EngineError::Aborted => None,
    }
}

/// http 스텝 목록을 순서대로 한 번 실행한다. 첫 실패에서 멈춘다.
/// `vars`는 실행 중 추출을 받아 뒤 스텝이 읽을 수 있게 갱신된다(호출자가 사본을 넘긴다).
/// 요청 통계와 결과 수 ok/failed, deadline에 따른 interrupted는 이 함수가 `stats`에 기록한다.
/// 취소(`Aborted`)는 기록하지 않는다 — run이 끝나는 취소인지 호출자만 안다.
/// `Err`는 준비 실패로 분류하지 않는 엔진 오류다.
#[allow(clippy::too_many_arguments)]
#[allow(dead_code)] // Task 4가 호출부를 붙이면 제거한다
pub(crate) async fn run_section(
    section: Section,
    steps: &[Step],
    client: &VuClient,
    vars: &mut BTreeMap<String, String>,
    env: &BTreeMap<String, String>,
    vu_id: u32,
    iter_id: u32,
    deadline: Instant,
    cancel: &CancellationToken,
    rng: &mut StdRng,
    default_think: Option<ThinkTime>,
    req: &mut Option<ReqGen>,
    stats: &SharedSectionStats,
) -> Result<SectionRun> {
    let mut extracted_all = BTreeMap::new();
    for step in steps {
        // 구간 스텝은 http뿐이다(`SetupSection` 역직렬화가 보장).
        let Step::Http(http) = step else { continue };
        if Instant::now() >= deadline {
            lock(stats).record_interrupted(section);
            return Ok(SectionRun::Deadline);
        }
        if cancel.is_cancelled() {
            return Ok(SectionRun::Aborted);
        }
        if let Some(rg) = req.as_mut() {
            rg.refresh(&http.id, vars);
        }
        let result = {
            let ctx = TemplateContext {
                vars,
                env,
                vu_id,
                iter_id,
                loop_index: None,
            };
            execute_step_with(client, http, &ctx, ExtractMode::StrictNoDefaults).await
        };
        let failure: (&'static str, Option<String>) = match result {
            Err(e) => match classify_engine_error(&e) {
                Some(f) => f,
                None => return Err(e),
            },
            Ok(outcome) => {
                lock(stats).record_request(
                    section,
                    &outcome.step_id,
                    outcome.status,
                    outcome.latency,
                    outcome.error.is_some(),
                );
                if outcome.error.is_some() {
                    let kind = match (outcome.error_kind, outcome.error_class) {
                        (Some(k), _) => k.as_str(),
                        (None, Some(ErrorClass::ReadBody)) => "read_body",
                        (None, Some(ErrorClass::StatusAssert)) => "status_assert",
                        (None, Some(ErrorClass::Extract)) => "extract",
                        (None, Some(ErrorClass::Send) | None) => ErrorKind::Other.as_str(),
                    };
                    (kind, None)
                } else if outcome.extracted.values().any(String::is_empty) {
                    ("extract", None)
                } else {
                    if let Some(rg) = req.as_mut() {
                        rg.mark_written(outcome.extracted.keys());
                    }
                    vars.extend(outcome.extracted.clone());
                    extracted_all.extend(outcome.extracted);
                    if let Some(tt) = http.think_time.or(default_think) {
                        match pace(tt.sample(rng), deadline, cancel).await {
                            PaceOutcome::Slept => {}
                            PaceOutcome::Cancelled => return Ok(SectionRun::Aborted),
                            PaceOutcome::DeadlineReached => {
                                lock(stats).record_interrupted(section);
                                return Ok(SectionRun::Deadline);
                            }
                        }
                    }
                    continue;
                }
            }
        };
        let (kind, var) = failure;
        {
            let mut s = lock(stats);
            s.record_failure_kind(section, &http.id, kind);
            s.record_failed(section);
        }
        return Ok(SectionRun::Failed(EngineError::SetupFailed {
            step_id: http.id.clone(),
            kind,
            var,
        }));
    }
    lock(stats).record_ok(section, chrono::Utc::now().timestamp_millis());
    Ok(SectionRun::Done(extracted_all))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::safe_cause;
    use crate::scenario::CookieJarMode;
    use rand::SeedableRng;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const ID_A: &str = "01HX0000000000000000000001";
    const ID_B: &str = "01HX0000000000000000000002";

    fn steps(yaml: &str) -> Vec<Step> {
        serde_yaml::from_str(yaml).expect("steps yaml")
    }

    fn shared() -> SharedSectionStats {
        Arc::new(Mutex::new(SectionStats::default()))
    }

    struct Ran {
        run: SectionRun,
        vars: BTreeMap<String, String>,
        stats: SharedSectionStats,
    }

    async fn run_with(steps: &[Step], deadline: Instant, cancel: &CancellationToken) -> Ran {
        let client = VuClient::new(CookieJarMode::Off).unwrap();
        let mut vars = BTreeMap::new();
        let env = BTreeMap::new();
        let mut rng = StdRng::seed_from_u64(1);
        let mut req = None;
        let stats = shared();
        let run = run_section(
            Section::Setup,
            steps,
            &client,
            &mut vars,
            &env,
            0,
            0,
            deadline,
            cancel,
            &mut rng,
            None,
            &mut req,
            &stats,
        )
        .await
        .expect("no engine error");
        Ran { run, vars, stats }
    }

    async fn run_simple(steps: &[Step]) -> Ran {
        run_with(
            steps,
            Instant::now() + Duration::from_secs(60),
            &CancellationToken::new(),
        )
        .await
    }

    fn failed_parts(run: &SectionRun) -> (&str, &'static str, Option<&str>) {
        match run {
            SectionRun::Failed(EngineError::SetupFailed { step_id, kind, var }) => {
                (step_id.as_str(), *kind, var.as_deref())
            }
            other => panic!("expected Failed(SetupFailed), got {other:?}"),
        }
    }

    fn token_step(url: &str) -> String {
        format!(
            r#"
- type: http
  id: {ID_A}
  name: login
  request: {{ method: POST, url: "{url}/login" }}
  assert:
    - status: 200
  extract:
    - {{ from: body, var: token, path: "$.token" }}
"#
        )
    }

    #[test]
    fn drain_is_delta() {
        let mut s = SectionStats::default();
        s.record_request(Section::Setup, ID_A, 200, Duration::from_millis(5), false);
        s.record_request(Section::Setup, ID_A, 0, Duration::from_millis(7), true);
        s.record_failure_kind(Section::Setup, ID_A, "dns");
        s.record_ok(Section::Setup, 10);
        s.record_failed(Section::Setup);
        s.record_interrupted(Section::Setup);
        let (steps, outcomes) = s.drain();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].count, 2);
        assert_eq!(steps[0].error_count, 1);
        assert_eq!(steps[0].status_counts.get(&200), Some(&1));
        assert_eq!(steps[0].status_counts.get(&0), Some(&1));
        assert_eq!(steps[0].failure_kinds.get("dns"), Some(&1));
        assert_eq!(steps[0].histogram.len(), 2);
        assert!(!steps[0].serialize_histogram().unwrap().is_empty());
        assert_eq!(
            outcomes,
            vec![SectionOutcome {
                section: Section::Setup,
                ok: 1,
                failed: 1,
                interrupted: 1,
                last_done_ms: Some(10),
            }]
        );
        let (steps, outcomes) = s.drain();
        assert!(steps.is_empty());
        assert!(outcomes.is_empty());
    }

    #[test]
    fn no_outcome_when_all_zero() {
        let mut s = SectionStats::default();
        s.record_request(Section::Setup, ID_A, 200, Duration::from_millis(1), false);
        let (steps, outcomes) = s.drain();
        assert_eq!(steps.len(), 1);
        assert!(outcomes.is_empty());
    }

    #[test]
    fn last_done_is_max() {
        let mut s = SectionStats::default();
        s.record_ok(Section::Setup, 50);
        s.record_ok(Section::Setup, 30);
        let (_, outcomes) = s.drain();
        assert_eq!(outcomes[0].last_done_ms, Some(50));
        assert_eq!(outcomes[0].ok, 2);
    }

    #[test]
    fn section_wire_names_round_trip() {
        assert_eq!(Section::Setup.as_str(), "setup");
        assert_eq!(Section::from_wire("setup"), Some(Section::Setup));
        assert_eq!(Section::from_wire("main"), None);
    }

    #[tokio::test]
    async fn runs_steps_in_order_and_returns_extracts() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"token":"abc"}"#))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/me"))
            .and(header("authorization", "Bearer abc"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;
        let yaml = format!(
            r#"{}
- type: http
  id: {ID_B}
  name: me
  request:
    method: GET
    url: "{}/me"
    headers: {{ authorization: "Bearer {{{{token}}}}" }}
"#,
            token_step(&server.uri()),
            server.uri()
        );
        let ran = run_simple(&steps(&yaml)).await;
        match &ran.run {
            SectionRun::Done(m) => {
                assert_eq!(m.get("token").map(String::as_str), Some("abc"));
                assert_eq!(m.len(), 1);
            }
            other => panic!("expected Done, got {other:?}"),
        }
        assert_eq!(ran.vars.get("token").map(String::as_str), Some("abc"));
        let (st, outcomes) = lock(&ran.stats).drain();
        assert_eq!(st.len(), 2);
        assert!(st.iter().all(|s| s.count == 1));
        assert_eq!(outcomes[0].ok, 1);
        assert_eq!(outcomes[0].failed, 0);
        assert!(outcomes[0].last_done_ms.is_some());
    }

    #[tokio::test]
    async fn stops_at_first_failure() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/me"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let yaml = format!(
            r#"{}
- type: http
  id: {ID_B}
  name: me
  request: {{ method: GET, url: "{}/me" }}
"#,
            token_step(&server.uri()).replace(
                "extract:\n    - { from: body, var: token, path: \"$.token\" }",
                "extract: []"
            ),
            server.uri()
        );
        let ran = run_simple(&steps(&yaml)).await;
        let (step_id, kind, var) = failed_parts(&ran.run);
        assert_eq!(step_id, ID_A);
        assert_eq!(kind, "status_assert");
        assert_eq!(var, None);
        let received = server.received_requests().await.unwrap();
        assert!(received.iter().all(|r| r.url.path() != "/me"));
        let (st, outcomes) = lock(&ran.stats).drain();
        assert_eq!(st.len(), 1);
        assert_eq!(st[0].failure_kinds.get("status_assert"), Some(&1));
        assert_eq!(outcomes[0].failed, 1);
        assert_eq!(outcomes[0].ok, 0);
    }

    #[tokio::test]
    async fn null_or_empty_extract_fails_setup() {
        for body in [r#"{"token": null}"#, r#"{"token": ""}"#] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/login"))
                .respond_with(ResponseTemplate::new(200).set_body_string(body))
                .mount(&server)
                .await;
            let ran = run_simple(&steps(&token_step(&server.uri()))).await;
            let (_, kind, _) = failed_parts(&ran.run);
            assert_eq!(kind, "extract", "body {body}");
            assert!(ran.vars.is_empty());
        }
    }

    #[tokio::test]
    async fn default_is_not_used() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"other":1}"#))
            .mount(&server)
            .await;
        let yaml = token_step(&server.uri())
            .replace("path: \"$.token\" }", "path: \"$.token\", default: guest }");
        assert!(yaml.contains("default: guest"));
        let ran = run_simple(&steps(&yaml)).await;
        let (_, kind, _) = failed_parts(&ran.run);
        assert_eq!(kind, "extract");
        assert!(ran.vars.is_empty());
    }

    #[tokio::test]
    async fn unknown_var_names_the_var() {
        let yaml = format!(
            r#"
- type: http
  id: {ID_A}
  name: x
  request: {{ method: GET, url: "http://127.0.0.1:9/{{{{nope}}}}" }}
"#
        );
        let ran = run_simple(&steps(&yaml)).await;
        let (step_id, kind, var) = failed_parts(&ran.run);
        assert_eq!(step_id, ID_A);
        assert_eq!(kind, "unknown_var");
        assert_eq!(var, Some("nope"));
        let (st, outcomes) = lock(&ran.stats).drain();
        assert_eq!(st[0].failure_kinds.get("unknown_var"), Some(&1));
        assert_eq!(outcomes[0].failed, 1);
    }

    #[tokio::test]
    async fn transport_failure_uses_error_kind() {
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let yaml = format!(
            r#"
- type: http
  id: {ID_A}
  name: x
  request: {{ method: GET, url: "http://127.0.0.1:{port}/x" }}
"#
        );
        let ran = run_simple(&steps(&yaml)).await;
        let (_, kind, _) = failed_parts(&ran.run);
        assert_eq!(kind, ErrorKind::ConnectRefused.as_str());
        let (st, _) = lock(&ran.stats).drain();
        assert_eq!(st[0].status_counts.get(&0), Some(&1));
    }

    #[tokio::test]
    async fn deadline_before_step_is_interrupted() {
        let server = MockServer::start().await;
        let ran = run_with(
            &steps(&token_step(&server.uri())),
            Instant::now() - Duration::from_millis(1),
            &CancellationToken::new(),
        )
        .await;
        assert!(matches!(ran.run, SectionRun::Deadline));
        let (_, outcomes) = lock(&ran.stats).drain();
        assert_eq!(outcomes[0].interrupted, 1);
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancel_is_not_counted() {
        let server = MockServer::start().await;
        let cancel = CancellationToken::new();
        cancel.cancel();
        let ran = run_with(
            &steps(&token_step(&server.uri())),
            Instant::now() + Duration::from_secs(60),
            &cancel,
        )
        .await;
        assert!(matches!(ran.run, SectionRun::Aborted));
        let (st, outcomes) = lock(&ran.stats).drain();
        assert!(st.is_empty());
        assert!(outcomes.is_empty());
    }

    #[test]
    fn safe_cause_has_no_value() {
        let e = EngineError::SetupFailed {
            step_id: ID_A.to_string(),
            kind: "unknown_var",
            var: Some("nope".to_string()),
        };
        assert_eq!(
            safe_cause(&e).as_deref(),
            Some(format!("준비 스텝 {ID_A} 실패: unknown_var (nope)").as_str())
        );
        let e = EngineError::SetupFailed {
            step_id: ID_A.to_string(),
            kind: "extract",
            var: None,
        };
        assert_eq!(
            safe_cause(&e).as_deref(),
            Some(format!("준비 스텝 {ID_A} 실패: extract").as_str())
        );
    }
}

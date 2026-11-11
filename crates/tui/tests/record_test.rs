use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use handicap_controller::monitor::check::Verdict;
use handicap_tui::session::Session;
use handicap_tui::wire::StatusResponse;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

const TEMPLATE: &str = include_str!("fixtures/bundle_template.json");

/// 응답기는 503 고정 — 점검이 실패해 사유가 생긴다.
async fn target() -> MockServer {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&s)
        .await;
    s
}

fn bundle_for(server: &MockServer) -> String {
    TEMPLATE.replace("__BASE__", &server.uri())
}

fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, bytes).unwrap();
    p
}

/// `/status`에 첫 칸 결과가 생길 때까지(10 s 상한, 200 ms 간격).
async fn wait_for_result(s: &Session, id: &str) -> StatusResponse {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let st = s.api.status(id).await.unwrap();
        if !st.panels[0].results.is_empty() {
            return st;
        }
        assert!(Instant::now() < deadline, "no result within 10s");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn record_round_trips_real_controller_response() {
    let srv = target().await;
    let tmp = tempfile::tempdir().unwrap();
    let file = write(tmp.path(), "b.json", bundle_for(&srv).as_bytes());
    let dbdir = tempfile::tempdir().unwrap();
    let s = Session::start(&file, dbdir.path()).await.unwrap();
    let board = s.boards[0].id.clone();
    let st = wait_for_result(&s, &board).await;
    let panel = &st.panels[0];
    let r = panel.results.last().unwrap();
    let rec = s
        .api
        .record(&board, &panel.panel_id, r.at_ms)
        .await
        .unwrap();
    assert_eq!(rec.at_ms, r.at_ms);
    assert_eq!(rec.result.verdict, Verdict::Fail);
    assert!(rec.result.reason.is_some());
    assert_eq!(rec.limit_kb, 128);
    let trace = rec.trace.unwrap();
    assert_eq!(trace.steps.len(), 1);
    assert_eq!(trace.steps[0].step_id, "01J0000000000000000000ST01");
    assert_eq!(trace.steps[0].response.as_ref().unwrap().status, 503);
    assert!(rec.clipped.is_empty());
    s.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn record_unknown_round_is_404() {
    let srv = target().await;
    let tmp = tempfile::tempdir().unwrap();
    let file = write(tmp.path(), "b.json", bundle_for(&srv).as_bytes());
    let dbdir = tempfile::tempdir().unwrap();
    let s = Session::start(&file, dbdir.path()).await.unwrap();
    let board = s.boards[0].id.clone();
    let st = wait_for_result(&s, &board).await;
    let panel = st.panels[0].panel_id.clone();
    let e = s.api.record(&board, &panel, 1).await.unwrap_err();
    assert_eq!(e.status, Some(404));
    let at = st.panels[0].results.last().unwrap().at_ms;
    let e = s
        .api
        .record(&board, "01J0000000000000000000PN99", at)
        .await
        .unwrap_err();
    assert_eq!(e.status, Some(404));
    s.shutdown().await;
}

/// `/status`에 첫 칸 결과가 `n`개 이상 생길 때까지(20 s 상한, 200 ms 간격).
async fn wait_for_results(s: &Session, id: &str, n: usize) -> StatusResponse {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let st = s.api.status(id).await.unwrap();
        if st.panels[0].results.len() >= n {
            return st;
        }
        assert!(Instant::now() < deadline, "no {n} results within 20s");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn fetch_worker_answers_in_order_and_stops() {
    use handicap_tui::app::{FetchReq, Fetched, spawn_fetch_worker};
    use handicap_tui::inspect::{Reason, RecordLoad};
    use std::sync::mpsc::{RecvTimeoutError, channel};

    let srv = target().await;
    let tmp = tempfile::tempdir().unwrap();
    let file = write(tmp.path(), "b.json", bundle_for(&srv).as_bytes());
    let dbdir = tempfile::tempdir().unwrap();
    let s = Session::start(&file, dbdir.path()).await.unwrap();
    let board = s.boards[0].id.clone();
    let st = wait_for_results(&s, &board, 2).await;
    let panel = st.panels[0].panel_id.clone();
    let rs = &st.panels[0].results;
    let (at1, at2) = (rs[rs.len() - 2].at_ms, rs[rs.len() - 1].at_ms);

    let (tx, rx) = channel();
    let req = spawn_fetch_worker(&tokio::runtime::Handle::current(), s.api.clone(), tx);
    let mk = |at_ms| (board.clone(), panel.clone(), at_ms);
    let (b, p, a) = mk(at1);
    req.send(FetchReq::Reason {
        board_id: b,
        panel_id: p,
        at_ms: a,
    })
    .unwrap();
    let (b, p, a) = mk(at2);
    req.send(FetchReq::Record {
        board_id: b,
        panel_id: p,
        at_ms: a,
    })
    .unwrap();
    let (b, p, a) = mk(1);
    req.send(FetchReq::Reason {
        board_id: b,
        panel_id: p,
        at_ms: a,
    })
    .unwrap();

    // 동기 recv_timeout이 런타임 작업자 스레드를 막지 않게 blocking 스레드에서 받는다.
    let (rx, got) = tokio::task::spawn_blocking(move || {
        let got: Vec<Fetched> = (0..3)
            .map(|_| rx.recv_timeout(Duration::from_secs(5)).unwrap())
            .collect();
        (rx, got)
    })
    .await
    .unwrap();
    match &got[0] {
        Fetched::Reason {
            at_ms,
            reason: Reason::Known {
                reason: Some(_), ..
            },
            ..
        } => assert_eq!(*at_ms, at1),
        other => panic!("{other:?}"),
    }
    match &got[1] {
        Fetched::Record {
            at_ms,
            load: RecordLoad::Loaded(_),
            ..
        } => assert_eq!(*at_ms, at2),
        other => panic!("{other:?}"),
    }
    match &got[2] {
        Fetched::Reason {
            at_ms,
            reason: Reason::Gone,
            board_id,
            panel_id,
        } => {
            assert_eq!(*at_ms, 1);
            assert_eq!(board_id, &board);
            assert_eq!(panel_id, &panel);
        }
        other => panic!("{other:?}"),
    }
    drop(req);
    let end = tokio::task::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(2)))
        .await
        .unwrap();
    assert!(
        matches!(end, Err(RecvTimeoutError::Disconnected)),
        "{end:?}"
    );
    s.shutdown().await;
}

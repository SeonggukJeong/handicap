// spec §9.1 ①~⑤: reqwest 플래그/체인 거동을 실물로 핀 고정 — §3.1 규칙 1·2·4는
// 가설이고 이 테스트가 진실. 진단 출력에 reqwest Error의 Display/Debug 금지(Global).
use handicap_engine::{ErrorKind, classify_send_error};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn client(timeout_ms: u64, connect_timeout_ms: Option<u64>) -> reqwest::Client {
    let mut b = reqwest::Client::builder().timeout(Duration::from_millis(timeout_ms));
    if let Some(ct) = connect_timeout_ms {
        b = b.connect_timeout(Duration::from_millis(ct));
    }
    b.build().unwrap()
}

async fn send_err(c: &reqwest::Client, url: &str) -> reqwest::Error {
    c.get(url).send().await.expect_err("must fail")
}

#[tokio::test]
async fn refused_port_classifies_connect_refused() {
    // ① bind 후 drop한 포트 — OS가 RST로 거절.
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap();
    drop(l);
    let e = send_err(&client(2000, None), &format!("http://{addr}/")).await;
    assert_eq!(classify_send_error(&e), ErrorKind::ConnectRefused);
}

#[tokio::test]
async fn fresh_connection_rst_classifies_connection_reset() {
    // ② accept 직후 linger 0 close → RST (신선 커넥션).
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        let (s, _) = l.accept().await.unwrap();
        s.set_zero_linger().unwrap(); // non-deprecated equivalent of set_linger(Some(ZERO))
        // 요청 첫 바이트가 도착할 때까지 잠깐 읽어 RST가 요청 도중에 떨어지게.
        let mut s = s;
        let mut buf = [0u8; 1];
        let _ = s.read(&mut buf).await;
        drop(s);
    });
    let e = send_err(&client(2000, None), &format!("http://{addr}/")).await;
    assert_eq!(classify_send_error(&e), ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn keepalive_clean_close_classifies_connection_reset() {
    // ③ 사고 앵커 대표 형태(리뷰 R2): 1번째 요청 정상 keep-alive 응답 → 2번째 요청
    // head를 **읽은 뒤** clean close(FIN) → hyper "connection closed before message
    // completed"(규칙 4 문자열 경로 핀 — RST면 규칙 1로 빠져 이 경로를 검증 못 한다.
    // head 발신 전 절단은 hyper-util 투명 재시도라 flake — 리뷰 N5).
    // 서버측 전제(2번째 head 도착)는 JoinHandle로 본체에서 단언 — spawn 안 panic은
    // await 없이는 테스트를 못 떨어뜨린다(리뷰 P7).
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let srv = tokio::spawn(async move {
        let (mut s, _) = l.accept().await.unwrap();
        let mut buf = vec![0u8; 4096];
        // 1번째 요청 head 소비 후 keep-alive 200.
        let _ = s.read(&mut buf).await.unwrap();
        s.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n")
            .await
            .unwrap();
        // 2번째 요청 head 도착을 기다렸다가 응답 없이 clean close(drop=FIN).
        s.read(&mut buf).await.unwrap()
    });
    let c = client(2000, None);
    let url = format!("http://{addr}/");
    let ok = c.get(&url).send().await.unwrap();
    assert_eq!(ok.status().as_u16(), 200);
    drop(ok); // 응답 반환 → 커넥션이 풀로 돌아가 2번째 요청이 재사용 (리뷰 P7 부수)
    let e = send_err(&c, &url).await;
    let n = srv.await.unwrap();
    assert!(n > 0, "second request head must arrive before close");
    assert_eq!(classify_send_error(&e), ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn silent_server_classifies_timeout() {
    // ④ accept 후 무응답 + 짧은 전체-타임아웃 → is_timeout && !is_connect.
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut s, _) = l.accept().await.unwrap();
        let mut buf = vec![0u8; 4096];
        let _ = s.read(&mut buf).await;
        tokio::time::sleep(Duration::from_secs(10)).await;
    });
    let e = send_err(&client(500, None), &format!("http://{addr}/")).await;
    assert_eq!(classify_send_error(&e), ErrorKind::Timeout);
}

#[tokio::test]
async fn connect_stall_classifies_connect_timeout() {
    // ⑤ 비라우팅 IP + connect_timeout → is_connect && is_timeout (spec §9.1 ⑤).
    // 이 환경에서 즉시 unreachable이 나오면(분류가 ConnectTimeout이 아니면) skip 금지 —
    // 아래 backlog-포화 변형으로 교체한다(spec 결정):
    //   let sock = tokio::net::TcpSocket::new_v4().unwrap();
    //   sock.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    //   let l = sock.listen(1).unwrap();               // backlog 1, accept 안 함
    //   let addr = l.local_addr().unwrap();
    //   let _c1 = tokio::net::TcpStream::connect(addr).await.unwrap(); // backlog 점유
    //   let _c2 = tokio::net::TcpStream::connect(addr).await;          // 필요 여부 실측(backlog=1이면 _c1만으로 찰 수 있음 — 리뷰 P8)
    //   → 이후 connect가 SYN 대기에 걸림.
    // 채택안(비라우팅 IP vs backlog-포화)은 오케스트레이터가 디스패치 전 실측해
    // brief에 값으로 확정한다(리뷰 P8 — pre-warm 원칙).
    let e = send_err(&client(5000, Some(500)), "http://10.255.255.1:81/").await;
    assert_eq!(classify_send_error(&e), ErrorKind::ConnectTimeout);
}

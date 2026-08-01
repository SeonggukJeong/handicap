# E1 — transport 에러 taxonomy + 리포트 분류표 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-01-error-taxonomy-design.md` (영역 E — 이 plan은 §13의 **E1**만: §3.1–3.3 + §4(E1) + §5.2–5.3 + §7.1(error_kinds)·7.2·7.5(라벨 8종) + §9·§10의 E1 몫). E2(인사이트)·E3(connect_timeout)은 별도 plan.

**Goal:** send-실패를 8종 kind로 분류해 counts-only로 엔진→proto→DB→리포트→UI 분류표까지 운반한다 (US1·US4 분류부).

**Architecture:** `executor.rs` send-실패 arm 한 곳에서 `classify_send_error`로 분류 → `ExecOutcome.error_kind` → `runner.rs`의 유일 기록 지점에서 `Aggregator` 누적 → `MetricFlush.error_kind_stats`(branch_stats 동형 delta) → proto `MetricBatch.error_kind_stats=10` → `run_error_kind_metrics` UPSERT 가산 → `build_report` run-level 롤업 → `ReportJson.error_kinds`(비면 생략) → UI 분류표(비면 미렌더).

**Tech Stack:** Rust(edition 2024, MSRV 1.85) + reqwest 0.12(rustls-tls) + sqlx/SQLite + prost/tonic + React/TS + Zod.

## Global Constraints

- **와이어 kind 문자열 8종 verbatim**: `connect_refused` `connection_reset` `connect_timeout` `timeout` `dns` `tls` `local_port_exhaustion` `other` — proto/DB/report/Zod 전 레이어 계약(spec §3.1).
- **신규 의존 0**: rustls/hyper/socket2 직접 의존 추가 금지(spec 리뷰 R3/N4). tokio는 이미 engine dev-dep(`features=["full"]`).
- **최상위 `reqwest::Error`의 `Display`·`{:?}` Debug 사용 금지**(분류·테스트 진단 출력 포함) — 둘 다 URL(크레덴셜 가능)을 렌더(spec §3.1/§11, 리뷰 C3/N2). 체인 각 링크의 개별 `to_string()`만.
- **byte-identical**: transport 에러 0인 run은 전 레이어에서 현행과 동일(report JSON `error_kinds` 키 생략, UI 섹션 미렌더).
- **6 드레인 + 5 send-guard**(엔진 CLAUDE.md): 드레인 `runner.rs` 6곳, guard 5곳(open-loop final만 무가드). 워커 빈-배치 스킵 가드에도 새 항 필수.
- Rust 게이트: `cargo fmt` + `clippy -- -D warnings` + nextest + doctest(pre-commit이 강제). 인라인 코드도 clippy-clean(2-arm `match … _=>{}` 대신 `if let`).
- UI 게이트: `pnpm lint && pnpm test && pnpm build`(lint는 `--max-warnings=0`). Zod는 `.optional()`(`.nullish()` 금지 — 서버 `skip_serializing_if`라 null 불가, `schemas.ts:98-106` 규약). 문구는 `ko.ts` 카탈로그 경유(ADR-0035).
- 테스트 fixture ULID: `I/L/O/U` 금지 — `01HX0000000000000000000001`류 사용.
- `git commit`에 파이프 금지, cargo-영향 커밋은 수 분 소요.
- 회귀 가드 표방 테스트는 **고의 회귀→RED→원복→GREEN 실증**([[plan-mandated-vacuous-tests]]).

---

### Task 1: 엔진 `error_kind.rs` — ErrorKind enum + 분류 함수 + 실-reqwest 핀 테스트

**Files:**
- Create: `crates/engine/src/error_kind.rs`
- Modify: `crates/engine/src/lib.rs` (모듈 등록 + re-export)
- Test: `crates/engine/src/error_kind.rs` 인라인 `#[cfg(test)]` (합성 체인 단위) + Create: `crates/engine/tests/error_kind.rs` (실 reqwest 통합)

**Interfaces:**
- Produces: `pub enum ErrorKind { ConnectRefused, ConnectionReset, ConnectTimeout, Timeout, Dns, Tls, LocalPortExhaustion, Other }` + `ErrorKind::as_str(&self) -> &'static str` + `pub fn classify_send_error(e: &reqwest::Error) -> ErrorKind` + `pub(crate) fn io_kind_class(top: &(dyn std::error::Error + 'static)) -> Option<ErrorKind>` + `pub(crate) fn chain_messages(top: &(dyn std::error::Error + 'static)) -> Vec<String>` — Task 2가 `classify_send_error`/`ErrorKind`를, `lib.rs` re-export로 통합 테스트가 소비.

- [ ] **Step 1: 단위 테스트 먼저 (RED)** — `crates/engine/src/error_kind.rs`를 테스트 포함 골격으로 생성 (tdd-guard: 이 파일이 pending test):

```rust
//! Transport send-실패 분류 (spec 2026-08-01-error-taxonomy §3.1).
//!
//! 규칙 3~5는 best-effort 문자열 매치 — 미스매치는 `Other` 안전 폴백(오분류보다 미분류).
//! 체인 각 링크의 개별 `to_string()`만 사용한다. 최상위 `reqwest::Error`의
//! `Display`/`Debug`는 URL(크레덴셜 포함 가능)을 렌더하므로 절대 사용 금지.

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ErrorKind {
    ConnectRefused,
    ConnectionReset,
    ConnectTimeout,
    Timeout,
    Dns,
    Tls,
    LocalPortExhaustion,
    Other,
}

impl ErrorKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorKind::ConnectRefused => "connect_refused",
            ErrorKind::ConnectionReset => "connection_reset",
            ErrorKind::ConnectTimeout => "connect_timeout",
            ErrorKind::Timeout => "timeout",
            ErrorKind::Dns => "dns",
            ErrorKind::Tls => "tls",
            ErrorKind::LocalPortExhaustion => "local_port_exhaustion",
            ErrorKind::Other => "other",
        }
    }
}

/// 규칙 1: 선별적 io-kind 스캔 — kind가 매핑 4종인 **첫** io::Error만 채택,
/// 그 외 kind(예: DNS 아래 Other, rustls의 InvalidData)는 무시하고 계속 walk.
pub(crate) fn io_kind_class(top: &(dyn std::error::Error + 'static)) -> Option<ErrorKind> {
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(top);
    while let Some(e) = cur {
        if let Some(io) = e.downcast_ref::<std::io::Error>() {
            match io.kind() {
                std::io::ErrorKind::AddrNotAvailable => return Some(ErrorKind::LocalPortExhaustion),
                std::io::ErrorKind::ConnectionRefused => return Some(ErrorKind::ConnectRefused),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe => {
                    return Some(ErrorKind::ConnectionReset)
                }
                _ => {} // fall-through (리뷰 R1)
            }
        }
        cur = e.source();
    }
    None
}

/// 체인 각 링크의 개별 Display. `top` 자신도 포함하되, 호출부(`classify_send_error`)는
/// `e.source()`부터 넘겨 최상위 reqwest Display가 절대 섞이지 않게 한다.
pub(crate) fn chain_messages(top: &(dyn std::error::Error + 'static)) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(top);
    while let Some(e) = cur {
        out.push(e.to_string());
        cur = e.source();
    }
    out
}

pub fn classify_send_error(e: &reqwest::Error) -> ErrorKind {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt;

    /// 합성 체인 노드: 임의 메시지 + 임의 source.
    #[derive(Debug)]
    struct Node(String, Option<Box<dyn std::error::Error + 'static>>);
    impl fmt::Display for Node {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(f, "{}", self.0)
        }
    }
    impl std::error::Error for Node {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.1.as_deref()
        }
    }
    fn io_node(kind: std::io::ErrorKind, inner: Option<Box<dyn std::error::Error + 'static>>) -> Box<dyn std::error::Error + 'static> {
        match inner {
            Some(i) => Box::new(std::io::Error::new(kind, i)),
            None => Box::new(std::io::Error::new(kind, "x")),
        }
    }

    #[test]
    fn io_kind_maps_the_three_families() {
        assert_eq!(
            io_kind_class(&*io_node(std::io::ErrorKind::AddrNotAvailable, None)),
            Some(ErrorKind::LocalPortExhaustion)
        );
        assert_eq!(
            io_kind_class(&*io_node(std::io::ErrorKind::ConnectionRefused, None)),
            Some(ErrorKind::ConnectRefused)
        );
        assert_eq!(
            io_kind_class(&*io_node(std::io::ErrorKind::ConnectionReset, None)),
            Some(ErrorKind::ConnectionReset)
        );
        assert_eq!(
            io_kind_class(&*io_node(std::io::ErrorKind::BrokenPipe, None)),
            Some(ErrorKind::ConnectionReset)
        );
    }

    #[test]
    fn io_kind_falls_through_unmapped_kinds() {
        // DNS 실패 형태: ConnectError("dns error") 아래 io::Error(Other) 아래엔 아무것도 없음
        // → 비매핑 kind를 지나쳐 계속 walk, 매치 없으면 None (리뷰 R1의 결정적 분기).
        let inner = io_node(std::io::ErrorKind::ConnectionRefused, None);
        let outer = io_node(std::io::ErrorKind::Other, Some(inner));
        assert_eq!(io_kind_class(&*outer), Some(ErrorKind::ConnectRefused));
        let lone = io_node(std::io::ErrorKind::Other, None);
        assert_eq!(io_kind_class(&*lone), None);
    }

    #[test]
    fn chain_messages_collects_each_link_only() {
        let chain = Node(
            "outer msg".into(),
            Some(Box::new(Node("inner msg".into(), None))),
        );
        assert_eq!(chain_messages(&chain), vec!["outer msg".to_string(), "inner msg".to_string()]);
    }

    #[test]
    fn as_str_is_the_wire_contract() {
        // 8종 전부 — 와이어 계약 스냅샷 (변경 = 계약 위반)
        let all = [
            (ErrorKind::ConnectRefused, "connect_refused"),
            (ErrorKind::ConnectionReset, "connection_reset"),
            (ErrorKind::ConnectTimeout, "connect_timeout"),
            (ErrorKind::Timeout, "timeout"),
            (ErrorKind::Dns, "dns"),
            (ErrorKind::Tls, "tls"),
            (ErrorKind::LocalPortExhaustion, "local_port_exhaustion"),
            (ErrorKind::Other, "other"),
        ];
        for (k, s) in all {
            assert_eq!(k.as_str(), s);
        }
    }
}
```

- [ ] **Step 2: `lib.rs`에 모듈 등록 + re-export** — `pub mod error_kind;` + 기존 re-export 블록에 `pub use error_kind::{classify_send_error, ErrorKind};` 추가.

- [ ] **Step 3: RED 확인**

Run: `cargo test -p handicap-engine --lib error_kind`
Expected: `todo!()`는 이 테스트들이 안 부르므로 단위 4개는 PASS해야 정상 — 헬퍼가 이미 구현이라서. **RED는 다음 통합 테스트가 만든다** → Step 4로.

- [ ] **Step 4: 실-reqwest 통합 테스트 작성 (RED)** — `crates/engine/tests/error_kind.rs`:

```rust
// spec §9.1 ①~⑤: reqwest 플래그/체인 거동을 실물로 핀 고정 — §3.1 규칙 1·2·4는
// 가설이고 이 테스트가 진실. 진단 출력에 reqwest Error의 Display/Debug 금지(Global).
use handicap_engine::{classify_send_error, ErrorKind};
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
        s.set_linger(Some(Duration::from_secs(0))).unwrap();
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
```

- [ ] **Step 5: RED 확인**

Run: `cargo test -p handicap-engine --test error_kind`
Expected: FAIL — `classify_send_error`가 `todo!()`라 panic.

- [ ] **Step 6: `classify_send_error` 구현** — `todo!()` 교체:

```rust
pub fn classify_send_error(e: &reqwest::Error) -> ErrorKind {
    // 규칙 1 — 체인은 e.source()부터: 최상위 reqwest Display/Debug 비접촉.
    if let Some(src) = e.source() {
        if let Some(k) = io_kind_class(src) {
            return k;
        }
    }
    // 규칙 2 — 타임아웃 플래그.
    if e.is_timeout() {
        return if e.is_connect() {
            ErrorKind::ConnectTimeout
        } else {
            ErrorKind::Timeout
        };
    }
    let msgs = match e.source() {
        Some(src) => chain_messages(src),
        None => Vec::new(), // 비재시도 Canceled 등 source 없는 형태 → Other (리뷰 N5)
    };
    // 규칙 3 — DNS (hyper-util ConnectError Display 형식).
    if e.is_connect() && msgs.iter().any(|m| m.contains("dns error")) {
        return ErrorKind::Dns;
    }
    // 규칙 4 — keep-alive 조기 종료 (hyper Kind::IncompleteMessage의 Display).
    if msgs
        .iter()
        .any(|m| m.contains("connection closed before message completed"))
    {
        return ErrorKind::ConnectionReset;
    }
    // 규칙 5 — TLS (best-effort; rustls 다운캐스트 금지 — 직접 의존 없음, 리뷰 R3).
    if msgs.iter().any(|m| {
        let l = m.to_lowercase();
        l.contains("tls") || l.contains("certificate") || l.contains("handshake")
    }) {
        return ErrorKind::Tls;
    }
    ErrorKind::Other
}
```

`use std::error::Error;` (source() 트레이트 메서드) 필요.

- [ ] **Step 7: GREEN 확인**

Run: `cargo test -p handicap-engine --lib error_kind && cargo test -p handicap-engine --test error_kind`
Expected: 전부 PASS. ⑤가 `ConnectTimeout`이 아니면(환경 즉시-unreachable) 테스트 내 주석의 backlog-포화 변형으로 교체 후 재실행 — **skip 가드 추가 금지**(spec §9.1).

- [ ] **Step 8: 게이트 + 커밋**

Run: `cargo fmt && cargo clippy --workspace -- -D warnings`
```bash
git add crates/engine/src/error_kind.rs crates/engine/src/lib.rs crates/engine/tests/error_kind.rs
git commit -m "feat(engine): transport send-실패 8종 분류 classify_send_error (E1 Task 1)"
```

---

### Task 2: 엔진 — `ExecOutcome.error_kind` + 유일 기록 지점 + Aggregator + MetricFlush 6드레인/5가드

**Files:**
- Modify: `crates/engine/src/executor.rs` (ExecOutcome + send-실패 arm + 기존 구성 사이트들)
- Modify: `crates/engine/src/aggregator.rs` (누적 map + record/drain + `ErrorKindStat`)
- Modify: `crates/engine/src/runner.rs` (기록 지점 1곳 + MetricFlush 필드 + 드레인 6 + 가드 5)
- Modify: `crates/engine/src/lib.rs` (`ErrorKindStat` re-export)
- Test: `crates/engine/tests/error_kind_flush.rs` (신규) + `crates/engine/src/aggregator.rs` 인라인

**Interfaces:**
- Consumes: Task 1의 `ErrorKind`, `classify_send_error`.
- Produces: `ExecOutcome.error_kind: Option<ErrorKind>` / `Aggregator::record_error_kind(&mut self, step_id: &str, kind: ErrorKind)` / `Aggregator::drain_error_kind_deltas(&mut self) -> Vec<ErrorKindStat>` / `pub struct ErrorKindStat { pub step_id: String, pub kind: ErrorKind, pub count: u64 }` / `MetricFlush.error_kind_stats: Vec<ErrorKindStat>` — Task 3(워커 매핑)이 소비.

- [ ] **Step 1: aggregator 단위 테스트 먼저 (RED)** — `aggregator.rs` 기존 `#[cfg(test)]`에 추가 (`drain_branch_deltas` 테스트 인접):

```rust
#[test]
fn records_and_drains_error_kinds() {
    use crate::error_kind::ErrorKind;
    let mut a = Aggregator::new(0);
    a.record_error_kind("s1", ErrorKind::ConnectRefused);
    a.record_error_kind("s1", ErrorKind::ConnectRefused);
    a.record_error_kind("s2", ErrorKind::Timeout);
    let mut v = a.drain_error_kind_deltas();
    v.sort_by(|a, b| (&a.step_id, a.kind).cmp(&(&b.step_id, b.kind)));
    assert_eq!(v.len(), 2);
    assert_eq!((v[0].step_id.as_str(), v[0].kind, v[0].count), ("s1", ErrorKind::ConnectRefused, 2));
    assert_eq!((v[1].step_id.as_str(), v[1].kind, v[1].count), ("s2", ErrorKind::Timeout, 1));
    assert!(a.drain_error_kind_deltas().is_empty(), "drain resets");
}
```

- [ ] **Step 2: 3모드 flush 통합 테스트 작성 (RED)** — `crates/engine/tests/error_kind_flush.rs`. `crates/engine/tests/think_time.rs`의 `Mode`/헬퍼 패턴을 미러(세 진입점을 직접 spawn — closed-only로 짜면 곡선/open 배선 누락이 green, 엔진 CLAUDE.md 함정):

```rust
// error_kind_stats가 3 진입점 모두에서 flush로 나오는지 + 깨끗한 run은 빈 벡터인지.
use handicap_engine::{ErrorKind, MetricFlush, RampDown, RunPlan, Scenario, run_scenario};
use handicap_engine::{run_scenario_open_loop, run_scenario_vu_curve};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
enum Mode {
    Closed,
    Curve,
    Open,
}

const YAML_TPL: &str = "version: 1
name: ek
steps:
  - id: 01HX0000000000000000000001
    type: http
    name: hit
    request:
      method: GET
      url: {URI}
";

fn base_plan(dur_ms: u64) -> RunPlan {
    RunPlan {
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
    }
}
// ↑ 리터럴은 작성 시점 RunPlan 필드 전수(E3 전이라 connect_timeout 없음) —
// 컴파일 에러가 나면 `crates/engine/tests/think_time.rs`의 동일 리터럴을 정본으로 맞출 것.

/// 모든 flush를 **개별로** 수집한다 — concat하면 periodic/final 경로 구분이 사라져
/// 6드레인+5가드 회귀를 원리적으로 못 잡는다(리뷰 P5).
async fn collect_flushes(mode: Mode, url: &str, dur_ms: u64) -> Vec<MetricFlush> {
    let yaml = YAML_TPL.replace("{URI}", url);
    let scenario = Arc::new(Scenario::from_yaml(&yaml).unwrap());
    let mut plan = base_plan(dur_ms);
    if let Mode::Open = mode {
        plan.target_rps = Some(50);
        plan.max_in_flight = Some(4);
    }
    if let Mode::Curve = mode {
        // 타입·필드 정본: `runner.rs:31-34`의 `Stage` + `vu_curve.rs:28-49` `curve_plan` (리뷰 P1)
        plan.vu_stages = Some(vec![handicap_engine::Stage {
            target: 1,
            duration_seconds: (dur_ms / 1000).max(1) as u32,
        }]);
    }
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let cancel = CancellationToken::new();
    let h = match mode {
        Mode::Closed => tokio::spawn(run_scenario(scenario, plan, tx, cancel)),
        Mode::Curve => tokio::spawn(run_scenario_vu_curve(scenario, plan, tx, cancel)),
        Mode::Open => tokio::spawn(run_scenario_open_loop(scenario, plan, tx, cancel)),
    };
    let mut out = Vec::new();
    while let Some(f) = rx.recv().await {
        out.push(f);
    }
    h.await.unwrap().unwrap();
    out
}

fn kind_total(flushes: &[MetricFlush], kind: ErrorKind) -> u64 {
    flushes
        .iter()
        .flat_map(|f| f.error_kind_stats.iter())
        .filter(|s| s.kind == kind)
        .map(|s| s.count)
        .sum()
}

fn loaded_flushes(flushes: &[MetricFlush]) -> usize {
    flushes
        .iter()
        .filter(|f| !f.error_kind_stats.is_empty())
        .count()
}

fn refused_url() -> String {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap();
    drop(l);
    format!("http://{addr}/")
}

#[tokio::test]
async fn closed_loop_flushes_error_kinds_periodically() {
    // 3초 run: periodic(500ms 틱) + final 양쪽에 실려 ≥2 flush.
    // periodic 드레인을 지우면 final 1개로 줄어 RED (리뷰 P5 축 b).
    let flushes = collect_flushes(Mode::Closed, &refused_url(), 3000).await;
    assert!(kind_total(&flushes, ErrorKind::ConnectRefused) > 0);
    assert!(
        loaded_flushes(&flushes) >= 2,
        "expected error_kind_stats in >=2 flushes (periodic+final), got {}",
        loaded_flushes(&flushes)
    );
}

#[tokio::test]
async fn open_loop_flushes_error_kinds_periodically() {
    let flushes = collect_flushes(Mode::Open, &refused_url(), 3000).await;
    assert!(kind_total(&flushes, ErrorKind::ConnectRefused) > 0);
    assert!(loaded_flushes(&flushes) >= 2, "got {}", loaded_flushes(&flushes));
}

#[tokio::test]
async fn vu_curve_flushes_error_kinds_periodically() {
    let flushes = collect_flushes(Mode::Curve, &refused_url(), 3000).await;
    assert!(kind_total(&flushes, ErrorKind::ConnectRefused) > 0);
    assert!(loaded_flushes(&flushes) >= 2, "got {}", loaded_flushes(&flushes));
}

#[tokio::test]
async fn error_kind_totals_match_status0_window_counts() {
    // 불변식: send-실패 1건 = 윈도 status "0" 1건 = error_kind 1건.
    // 새 send-guard 항(`|| !error_kind_stats.is_empty()`)을 지우면 "윈도는 비었는데
    // 에러 delta만 있는" 틱(초 중간 틱)에서 드레인된 delta가 send 없이 버려져
    // 등식이 깨진다 — 가드 삭제 회귀의 결정적 검출 (리뷰 P5 축 a).
    let flushes = collect_flushes(Mode::Closed, &refused_url(), 3000).await;
    let kinds: u64 = flushes
        .iter()
        .flat_map(|f| f.error_kind_stats.iter())
        .map(|s| s.count)
        .sum();
    let status0: u64 = flushes
        .iter()
        .flat_map(|f| f.windows.iter())
        .map(|w| w.status_counts.get(&0).copied().unwrap_or(0))
        .sum();
    assert!(kinds > 0);
    assert_eq!(kinds, status0, "every classified failure must reach the wire exactly once");
}

#[tokio::test]
async fn short_run_final_flush_carries_error_kinds() {
    // 300ms run: 유의미한 periodic 틱 전에 종료 → final 드레인이 유일 경로.
    // final 드레인을 지우면 total 0으로 RED (리뷰 P5 축 c).
    let flushes = collect_flushes(Mode::Closed, &refused_url(), 300).await;
    assert!(kind_total(&flushes, ErrorKind::ConnectRefused) > 0);
}

#[tokio::test]
async fn clean_run_has_empty_error_kinds() {
    // wiremock 200 → error_kind_stats가 어떤 flush에도 실리면 안 됨 (byte-identical 축).
    use wiremock::matchers::method;
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let flushes = collect_flushes(Mode::Closed, &format!("{}/", server.uri()), 1000).await;
    assert_eq!(loaded_flushes(&flushes), 0, "clean run must not emit error_kind_stats");
}
```

- [ ] **Step 3: RED 확인**

Run: `cargo test -p handicap-engine --test error_kind_flush`
Expected: 컴파일 FAIL — `error_kind_stats` 필드·`record_error_kind` 부재.

- [ ] **Step 4: 구현 (컴파일러 따라가기)**

1. `aggregator.rs`: 필드 `error_kind_counts: HashMap<(String, ErrorKind), u64>`(`new()`에서 `HashMap::new()`), `use crate::error_kind::ErrorKind;`:

```rust
/// spec 2026-08-01 §3.3 — send-실패 kind 카운트(delta). branch_counts 동형.
pub fn record_error_kind(&mut self, step_id: &str, kind: ErrorKind) {
    *self
        .error_kind_counts
        .entry((step_id.to_string(), kind))
        .or_default() += 1;
}

pub fn drain_error_kind_deltas(&mut self) -> Vec<ErrorKindStat> {
    std::mem::take(&mut self.error_kind_counts)
        .into_iter()
        .map(|((step_id, kind), count)| ErrorKindStat { step_id, kind, count })
        .collect()
}
```

`ErrorKindStat`는 `BranchStat` 정의 인접에:

```rust
#[derive(Debug, Clone)]
pub struct ErrorKindStat {
    pub step_id: String,
    pub kind: ErrorKind,
    pub count: u64,
}
```

2. `executor.rs`: `ExecOutcome`에 `pub error_kind: Option<crate::error_kind::ErrorKind>,` 추가 → 컴파일러가 가리키는 **모든** 구성 사이트에 `error_kind: None` — 단 send-실패 arm(`executor.rs:283-293`)만:

```rust
Err(e) => Ok(ExecOutcome {
    step_id: step.id.clone(),
    status: 0,
    latency,
    download: None,
    dns: None,
    connect: None,
    wait: None,
    error: Some(e.to_string()),
    error_kind: Some(crate::error_kind::classify_send_error(&e)),
    extracted: BTreeMap::new(),
}),
```

`execute_step_traced`는 `HttpTrace` 반환이라 무변경 — send-실패 arm(`:438-447`)에 주석 1줄: `// 분류는 부하 경로 전용(ExecOutcome.error_kind) — trace 비대상, spec 2026-08-01 §2.`

3. `runner.rs` 유일 기록 지점 — `Step::Http` arm의 `a.record(...)` 직후(`:509` 블록 안, `measure_phases` 블록 앞):

```rust
if let Some(k) = outcome.error_kind {
    a.record_error_kind(&outcome.step_id, k);
}
```

4. `runner.rs` `MetricFlush`에 8번째 필드 `pub error_kind_stats: Vec<ErrorKindStat>,` + **드레인 6곳**(`:285/330/819/968/1295/1448` — periodic 드레인 튜플과 final 드레인 튜플 각각에 `drain_error_kind_deltas()` 추가, 리터럴에 배선) + **send-guard 5곳**(`|| !error_kind_stats.is_empty()` — open-loop final `:1448`만 무가드 유지). 줄번호는 이 필드 추가로 밀리므로 **기존 `drain_branch_deltas()` 호출부를 grep해 6곳 전부** 따라간다: `grep -n "drain_branch_deltas" crates/engine/src/runner.rs` → 6 사이트.
5. `lib.rs` re-export에 `ErrorKindStat` 추가 (`MetricFlush`가 나가는 블록과 동일).

- [ ] **Step 5: GREEN 확인**

Run: `cargo test -p handicap-engine`
Expected: 신규(aggregator 단위 1 + 통합 7) + 기존 전부 PASS (기존 `MetricFlush{}` 리터럴 전부가 컴파일러에 걸렸다가 `error_kind_stats: vec![]`로 해소됐는지 이 명령이 증명).

- [ ] **Step 6: 가드·드레인 이빨 실증 (고의 회귀 3종 → 각각 RED → 원복 → GREEN, 리뷰 P5)** — 회귀를 하나씩 적용·확인·원복:
  - (a) closed-loop **periodic send-guard**의 `|| !error_kind_stats.is_empty()` 항만 삭제 → `cargo test -p handicap-engine --test error_kind_flush error_kind_totals_match_status0_window_counts` **RED**(초-중간 틱에서 드레인-후-미송신 유실 → 등식 붕괴).
  - (b) closed-loop **periodic 드레인**에서 `drain_error_kind_deltas()`만 `vec![]`로 대체 → `closed_loop_flushes_error_kinds_periodically` **RED**(final 1 flush로 감소).
  - (c) closed-loop **final 드레인**에서 `vec![]` 대체 → `short_run_final_flush_carries_error_kinds` **RED**.
  세 축 중 RED가 안 나오는 축이 있으면 그 테스트의 기간/임계를 조정해 RED를 만든 뒤 원복 — **"3/3 RED 확인"을 커밋 메시지에 기록**.

- [ ] **Step 7: 게이트 + 커밋**

Run: `cargo fmt && cargo clippy --workspace -- -D warnings && cargo test -p handicap-engine`
```bash
git add crates/engine/src/executor.rs crates/engine/src/aggregator.rs crates/engine/src/runner.rs crates/engine/src/lib.rs crates/engine/tests/error_kind_flush.rs
git commit -m "feat(engine): ExecOutcome.error_kind + Aggregator 누적 + MetricFlush.error_kind_stats 6드레인/5가드 (E1 Task 2)"
```

---

### Task 3: proto `ErrorKindStat` + 워커 forwarder 매핑·스킵 가드

**Files:**
- Modify: `crates/proto/proto/coordinator.proto`
- Modify: `crates/worker/src/lib.rs`
- Test: `crates/worker/src/lib.rs` 인라인 `#[cfg(test)]`

**Interfaces:**
- Consumes: Task 2의 `MetricFlush.error_kind_stats`(engine `ErrorKindStat`).
- Produces: proto `ErrorKindStat{step_id=1, kind=2, count=3}` + `MetricBatch.error_kind_stats = 10` — Task 4(controller ingest)가 소비. 워커 내부 `fn error_kind_stats_to_proto(stats: Vec<handicap_engine::ErrorKindStat>) -> Vec<proto::ErrorKindStat>`.

- [ ] **Step 1: 매핑 단위 테스트 먼저 (RED)** — `crates/worker/src/lib.rs` 기존 `#[cfg(test)]`에:

```rust
#[test]
fn error_kind_stats_map_to_proto_wire_strings() {
    use handicap_engine::{ErrorKind, ErrorKindStat};
    let out = error_kind_stats_to_proto(vec![
        ErrorKindStat { step_id: "s1".into(), kind: ErrorKind::ConnectRefused, count: 3 },
        ErrorKindStat { step_id: "s2".into(), kind: ErrorKind::LocalPortExhaustion, count: 1 },
    ]);
    assert_eq!(out.len(), 2);
    assert_eq!((out[0].step_id.as_str(), out[0].kind.as_str(), out[0].count), ("s1", "connect_refused", 3));
    assert_eq!((out[1].step_id.as_str(), out[1].kind.as_str(), out[1].count), ("s2", "local_port_exhaustion", 1));
}
```

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-worker --lib` → 컴파일 FAIL(함수·proto 타입 부재).

- [ ] **Step 3: proto + 워커 구현**

1. `coordinator.proto` — `BranchStat`(:42-46) 인접에 메시지 추가, `MetricBatch`에 필드 10:

```proto
message ErrorKindStat {
  string step_id = 1;
  string kind = 2;      // "connect_refused"|"connection_reset"|"connect_timeout"|"timeout"|"dns"|"tls"|"local_port_exhaustion"|"other"
  uint64 count = 3;     // delta since last flush
}
```
```proto
  repeated ErrorKindStat error_kind_stats = 10;  // send-실패 분류 카운트 (delta, controller merges)
```

2. `crates/worker/src/lib.rs` — forwarder(`:311-415`)에서:

```rust
fn error_kind_stats_to_proto(
    stats: Vec<handicap_engine::ErrorKindStat>,
) -> Vec<crate::proto::ErrorKindStat> {
    stats
        .into_iter()
        .map(|s| crate::proto::ErrorKindStat {
            step_id: s.step_id,
            kind: s.kind.as_str().to_string(),
            count: s.count,
        })
        .collect()
}
```

(proto 모듈 경로는 파일 상단의 기존 `ActiveVuSample`/`BranchStat` import 방식을 따른다.) forwarder 본문에서 `let error_kind_stats = error_kind_stats_to_proto(flush.error_kind_stats);` 후 — **스킵 가드(`:388-397`)에 `&& error_kind_stats.is_empty()` 추가**(누락 = error_kind-only flush 유실, C1 동형 함정) + `MetricBatch` 리터럴(`:401-411`)에 `error_kind_stats,` 추가.

- [ ] **Step 4: GREEN + 워크스페이스 빌드**

Run: `cargo test -p handicap-worker --lib && cargo build --workspace`
Expected: PASS (proto 재생성 포함).

- [ ] **Step 5: 게이트 + 커밋**

Run: `cargo fmt && cargo clippy --workspace -- -D warnings`
```bash
git add crates/proto/proto/coordinator.proto crates/worker/src/lib.rs
git commit -m "feat(proto,worker): MetricBatch.error_kind_stats=10 + forwarder 매핑·스킵 가드 (E1 Task 3)"
```

---

### Task 4: controller — migration + `run_error_kind_metrics` UPSERT ingest + read

**Files:**
- Create: `crates/controller/src/store/migrations/0020_run_error_kind_metrics.sql` (**번호는 착수 시 `ls crates/controller/src/store/migrations/` + `grep -n "MIGRATION_SQL" crates/controller/src/store/mod.rs`로 현행 최대+1 재확인** — `/new-migration` 스킬 규약)
- Modify: `crates/controller/src/store/mod.rs` (include + 실행 순서 끝에 추가)
- Modify: `crates/controller/src/store/metrics.rs`
- Modify: `crates/controller/src/grpc/coordinator.rs`
- Test: `crates/controller/src/store/metrics.rs` 또는 기존 store 테스트 파일 패턴

**Interfaces:**
- Consumes: Task 3의 proto `MetricBatch.error_kind_stats`.
- Produces: `pub struct ErrorKindRow { pub run_id: String, pub step_id: String, pub kind: String, pub count: i64 }` + `pub async fn insert_error_kind_batch(db: &Db, rows: &[ErrorKindRow]) -> sqlx::Result<()>` + `pub async fn error_kind_breakdown(db: &Db, run_id: &str) -> sqlx::Result<Vec<ErrorKindRow>>` — Task 5가 소비.

- [ ] **Step 1: store 테스트 먼저 (RED)** — `metrics.rs`의 기존 store 단위 테스트 위치(파일 하단 `#[cfg(test)]` 또는 인접 테스트 관례)에:

```rust
#[tokio::test]
async fn error_kind_upsert_accumulates_deltas() {
    let db = pool().await; // 기존 헬퍼(`metrics.rs:454-458`) — in-memory + 마이그레이션 포함이라 신규 테이블 생성됨 (리뷰 P4)
    let r = |c: i64| ErrorKindRow {
        run_id: "r1".into(),
        step_id: "s1".into(),
        kind: "connect_refused".into(),
        count: c,
    };
    insert_error_kind_batch(&db, &[r(2)]).await.unwrap();
    insert_error_kind_batch(&db, &[r(3)]).await.unwrap(); // 두 번째 flush delta
    let rows = error_kind_breakdown(&db, "r1").await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].count, 5, "delta must accumulate on conflict");
    assert!(error_kind_breakdown(&db, "r2").await.unwrap().is_empty());
}
```


- [ ] **Step 2: RED 확인** — `cargo test -p handicap-controller error_kind_upsert` → 컴파일 FAIL.

- [ ] **Step 3: 구현**

1. migration SQL (0006 동형):

```sql
CREATE TABLE IF NOT EXISTS run_error_kind_metrics (
  run_id   TEXT    NOT NULL,
  step_id  TEXT    NOT NULL,
  kind     TEXT    NOT NULL,   -- spec 2026-08-01 §3.1 snake_case 8종
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, step_id, kind)
);
```

2. `store/mod.rs`: `const MIGRATION_SQL_0020: &str = include_str!("migrations/0020_run_error_kind_metrics.sql");` + 실행 체인 끝에 `sqlx::query(MIGRATION_SQL_0020).execute(&pool).await?; // migration 0020: run_error_kind_metrics` (번호는 Step 0 재확인 결과로).
3. `metrics.rs`: `ErrorKindRow` + `insert_error_kind_batch`(`insert_if_branch_batch` `:203-224` 동형 — 단일 tx, `ON CONFLICT(run_id,step_id,kind) DO UPDATE SET count = count + excluded.count`) + `error_kind_breakdown`(`SELECT step_id, kind, count FROM run_error_kind_metrics WHERE run_id = ? ORDER BY step_id, kind`).
4. `grpc/coordinator.rs`: branch ingest **블록은 `:1578-1593`**(`let branch_rows … if !branch_rows.is_empty() { if let Err … }`) — 삽입은 그 블록의 닫는 `}` **이후**(안쪽 아님 — 리뷰 P3). 이웃 3블록 동형으로 빈-배열 가드 + `run_id` 필드 포함(리뷰 P11):

```rust
let ek_rows: Vec<crate::store::metrics::ErrorKindRow> = batch
    .error_kind_stats
    .iter()
    .map(|s| crate::store::metrics::ErrorKindRow {
        run_id: batch.run_id.clone(),
        step_id: s.step_id.clone(),
        kind: s.kind.clone(),
        count: s.count as i64,
    })
    .collect();
if !ek_rows.is_empty() {
    if let Err(e) =
        crate::store::metrics::insert_error_kind_batch(&state.db, &ek_rows).await
    {
        warn!(run_id = %batch.run_id, error = %e, "error_kind metrics insert failed");
    }
}
```

(주변 branch 블록의 실제 변수명·`state` 접근 방식이 다르면 그쪽을 따른다.)

- [ ] **Step 4: GREEN 확인** — `cargo test -p handicap-controller error_kind_upsert` → PASS, 이어 `cargo test -p handicap-controller` 전체 회귀.

- [ ] **Step 5: 게이트 + 커밋**

```bash
git add crates/controller/src/store/migrations/0020_run_error_kind_metrics.sql crates/controller/src/store/mod.rs crates/controller/src/store/metrics.rs crates/controller/src/grpc/coordinator.rs
git commit -m "feat(controller): run_error_kind_metrics migration+UPSERT ingest+read (E1 Task 4)"
```

---

### Task 5: controller — `ReportJson.error_kinds` 롤업 + 배선

**Files:**
- Modify: `crates/controller/src/report.rs` (`ErrorKindCount` + `build_report` 10번째 인자 + 롤업)
- Modify: `crates/controller/src/api/runs.rs` (`build_report_for_run` `:1013` 배선)
- Modify: `build_report` 호출 테스트 전부(`grep -rn "build_report(" crates/controller` — `&[]` 추가, ~35곳)
- Test: `crates/controller/tests/report_test.rs`

**Interfaces:**
- Consumes: Task 4의 `error_kind_breakdown` → `&[ErrorKindRow]`.
- Produces: `#[derive(Debug, Serialize, Deserialize)] pub struct ErrorKindCount { pub kind: String, pub count: u64 }` + `ReportJson.error_kinds: Vec<ErrorKindCount>`(`#[serde(default, skip_serializing_if = "Vec::is_empty")]`) — Task 6(UI Zod)이 소비.

- [ ] **Step 1: 롤업 단위 테스트 먼저 (RED)** — **`crates/controller/src/report.rs` 인라인 `#[cfg(test)]`에** (리뷰 P2: `report_test.rs`는 axum app-레벨 e2e 파일이라 `build_report(...)` 직접 호출·헬퍼가 없다 — 최소-report 헬퍼 `run_row()`/`make_hdr_bytes()`와 ≈35개 `build_report` 호출부는 이 인라인 모듈이 정본):

```rust
#[test]
fn error_kinds_rollup_sorts_and_omits_when_empty() {
    // per-step rows → kind별 SUM, count desc → kind asc.
    let ek_row = |step: &str, kind: &str, count: i64| crate::store::metrics::ErrorKindRow {
        run_id: "r1".into(),
        step_id: step.into(),
        kind: kind.into(),
        count,
    };
    let rows = vec![
        ek_row("s1", "timeout", 5),
        ek_row("s2", "timeout", 5),          // 합산 10
        ek_row("s1", "connect_refused", 10), // 동률 → kind asc로 connect_refused 먼저
        ek_row("s1", "connection_reset", 1),
    ];
    // 이 모듈의 기존 최소 build_report 호출(run_row()/make_hdr_bytes() 사용례)을
    // 그대로 미러하되 error_kinds 인자만 `&rows`로 — 헬퍼 fn으로 감싼다.
    let report = minimal_report_with_error_kinds(&rows);
    assert_eq!(
        report
            .error_kinds
            .iter()
            .map(|e| (e.kind.as_str(), e.count))
            .collect::<Vec<_>>(),
        vec![("connect_refused", 10), ("timeout", 10), ("connection_reset", 1)]
    );
    // 빈 입력 → 필드 자체가 JSON에서 생략 (byte-identical 축).
    let empty = minimal_report_with_error_kinds(&[]);
    let json = serde_json::to_string(&empty).unwrap();
    assert!(!json.contains("error_kinds"), "empty must be omitted: {json}");
}
```

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-controller --lib error_kinds_rollup` → 컴파일 FAIL(`error_kinds` 필드·인자 부재).

- [ ] **Step 3: 구현**

1. `report.rs`:

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorKindCount {
    pub kind: String,
    pub count: u64,
}
```

`ReportJson`에 (`if_breakdown` 인접):

```rust
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub error_kinds: Vec<ErrorKindCount>,
```

`build_report` 시그니처에 `error_kinds: &[crate::store::metrics::ErrorKindRow],` (기존 `#[allow(clippy::too_many_arguments)]` 유지). 본문 롤업:

```rust
let mut kind_totals: BTreeMap<String, u64> = BTreeMap::new();
for r in error_kinds {
    *kind_totals.entry(r.kind.clone()).or_default() += r.count.max(0) as u64;
}
let mut error_kinds_rolled: Vec<ErrorKindCount> = kind_totals
    .into_iter()
    .map(|(kind, count)| ErrorKindCount { kind, count })
    .collect();
error_kinds_rolled.sort_by(|a, b| b.count.cmp(&a.count).then(a.kind.cmp(&b.kind)));
```

→ `ReportJson { …, error_kinds: error_kinds_rolled, … }`.

2. `api/runs.rs::build_report_for_run`: `let error_kinds = crate::store::metrics::error_kind_breakdown(db, run_id).await?;` + `build_report(...)` 호출에 `&error_kinds` 추가.
3. `grep -rn "build_report(" crates/controller`로 나머지 호출부(테스트 다수)에 `&[]` 추가 — 컴파일러가 전부 강제.

- [ ] **Step 4: e2e report smoke (spec §9.2 — 리뷰 P6)** — `crates/controller/tests/report_test.rs`에 1건: 이 파일의 기존 "run 생성 → 메트릭 삽입 → `GET /api/runs/{id}/report`" e2e 테스트 하나를 미러하되, 메트릭 삽입 단계에 `handicap_controller::store::metrics::insert_error_kind_batch`(통합 테스트 크레이트라 `crate::` 아님 — `report_test.rs:8` 관례; 또는 이 파일이 쓰는 coordinator `insert_batch` 경로에 `error_kind_stats` 포함 — 파일의 기존 삽입 방식이 정본)로 `[{step_id: <기존 fixture step>, kind: "connect_refused", count: 7}]`을 넣고, 응답 JSON에서 `error_kinds == [{"kind":"connect_refused","count":7}]` 단언. RED→구현이 아니라 Task 3~4 배선이 이미 끝난 상태의 통합 확인이므로 바로 GREEN이어야 한다 — FAIL이면 ingest/배선 회귀.

- [ ] **Step 5: GREEN + 전체 회귀** — `cargo test -p handicap-controller` → 전부 PASS(골든 fixture 무변경 = 빈 run 생략 증명).

- [ ] **Step 6: 게이트 + 커밋**

```bash
git add crates/controller/src/report.rs crates/controller/src/api/runs.rs crates/controller/tests/
git commit -m "feat(controller): ReportJson.error_kinds run-level 롤업 + e2e smoke (E1 Task 5)"
```

---

### Task 6: UI — Zod + `ErrorKindTable` 분류표 + ko 라벨 + RTL

**Files:**
- Modify: `ui/src/api/schemas.ts` (`ReportSchema` `.strict()` — 필드 미추가 시 신 서버 리포트가 **파싱 실패**하므로 이 task는 E1 필수)
- Create: `ui/src/components/report/ErrorKindTable.tsx`
- Modify: `ui/src/components/report/ReportView.tsx` (`StatusDistribution` 직후 삽입)
- Modify: `ui/src/i18n/ko.ts`
- Test: `ui/src/components/report/__tests__/ErrorKindTable.test.tsx` + `ReportView.test.tsx` fixture

**Interfaces:**
- Consumes: Task 5의 `error_kinds` JSON (absent 또는 `[{kind, count}]`).
- Produces: `ErrorKindCountSchema`, `<ErrorKindTable kinds={report.error_kinds ?? []} />`.

- [ ] **Step 1: RTL 테스트 먼저 (RED)** — `ErrorKindTable.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { ErrorKindTable } from "../ErrorKindTable";

describe("ErrorKindTable", () => {
  it("renders ko labels, counts and shares", () => {
    render(
      <ErrorKindTable
        kinds={[
          { kind: "connection_reset", count: 90 },
          { kind: "timeout", count: 10 },
        ]}
      />,
    );
    expect(screen.getByText("Transport 실패 분류")).toBeInTheDocument();
    expect(screen.getByText("연결 끊김(reset)")).toBeInTheDocument();
    expect(screen.getByText("90")).toBeInTheDocument();
    expect(screen.getByText("90.0%")).toBeInTheDocument();
    expect(screen.getByText("요청 타임아웃")).toBeInTheDocument();
  });

  it("renders nothing when empty (byte-identical axis)", () => {
    const { container } = render(<ErrorKindTable kinds={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("falls back to raw kind for unknown wire strings (forward-compat)", () => {
    render(<ErrorKindTable kinds={[{ kind: "quic_goaway", count: 1 }]} />);
    expect(screen.getByText("quic_goaway")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: RED 확인** — `cd ui && pnpm test ErrorKindTable` → FAIL(모듈 부재).

- [ ] **Step 3: 구현**

1. `schemas.ts` — `IfBreakdownSchema` 인접에:

```ts
export const ErrorKindCountSchema = z
  .object({ kind: z.string(), count: z.number() })
  .strict();
```

`ReportSchema`에 (`if_breakdown` 인접, **서버 `skip_serializing_if` = absent, null 불가 → `.optional()`**):

```ts
error_kinds: z.array(ErrorKindCountSchema).optional(),
```

2. `ko.ts` — `report` 카탈로그(기존 `statusDistributionLabel` 인접)에:

```ts
errorKinds: {
  title: "Transport 실패 분류",
  headerKind: "종류",
  headerCount: "건수",
  headerShare: "비율",
  labels: {
    connect_refused: "연결 거부",
    connection_reset: "연결 끊김(reset)",
    connect_timeout: "연결 수립 타임아웃",
    timeout: "요청 타임아웃",
    dns: "DNS 실패",
    tls: "TLS 실패",
    local_port_exhaustion: "테스터 포트 고갈",
    other: "기타",
  } as Record<string, string>,
},
```

3. `ErrorKindTable.tsx` (import 경로는 `StatusDistribution.tsx`/`ReportView.tsx`의 기존 패턴을 그대로):

```tsx
import { ko } from "../../i18n/ko";
import { PageSection } from "../ui/PageSection";

interface Props {
  kinds: { kind: string; count: number }[];
}

export function ErrorKindTable({ kinds }: Props) {
  if (kinds.length === 0) return null;
  const total = kinds.reduce((s, k) => s + k.count, 0);
  const t = ko.report.errorKinds;
  return (
    // className 미전달 = 기본 여백 유지 — 형제 StatusDistribution 관례 (리뷰 P9)
    <PageSection ariaLabel={t.title} title={t.title}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500">
            <th className="py-1 pr-4 font-medium">{t.headerKind}</th>
            <th className="py-1 pr-4 font-medium">{t.headerCount}</th>
            <th className="py-1 font-medium">{t.headerShare}</th>
          </tr>
        </thead>
        <tbody>
          {kinds.map((k) => (
            <tr key={k.kind} className="border-t border-gray-100">
              <td className="py-1 pr-4">{t.labels[k.kind] ?? k.kind}</td>
              <td className="py-1 pr-4 tabular-nums">{k.count.toLocaleString("en-US")}</td>
              <td className="py-1 tabular-nums">
                {total > 0 ? `${((k.count / total) * 100).toFixed(1)}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </PageSection>
  );
}
```

(`PageSection` prop 이름·헤딩 레벨은 실제 정의(`ui/src/components/ui/PageSection.tsx`)와 대조해 맞출 것 — `ReportView.tsx:196` 사용례가 정본. 표 셀 스타일은 `StatusDistribution`/`StepStatsTable`의 기존 클래스 관례가 있으면 그쪽을 따른다.)

4. `ReportView.tsx` — `:201` `StatusDistribution` 직후:

```tsx
<ErrorKindTable kinds={report.error_kinds ?? []} />
```

5. `ReportView.test.tsx` — 기존 fixture 하나에 `error_kinds: [{ kind: "timeout", count: 3 }]` 추가해 섹션 렌더 확인 1건 + 기본 fixture(필드 부재)에서 `queryByText("Transport 실패 분류")`가 null 확인 1건.

- [ ] **Step 4: GREEN + UI 게이트** — `cd ui && pnpm lint && pnpm test && pnpm build` (파이프 없이 `; echo exit=$?`로 종료코드 확인).

- [ ] **Step 5: 커밋**

```bash
git add ui/src/api/schemas.ts ui/src/i18n/ko.ts ui/src/components/report/ErrorKindTable.tsx ui/src/components/report/ReportView.tsx ui/src/components/report/__tests__/
git commit -m "feat(ui): 리포트 Transport 실패 분류표 + error_kinds Zod (E1 Task 6)"
```

---

### Task 7: 라이브 검증 (orchestrator 직접 — US1·US1'·회귀)

**Files:** 없음(검증만). `/live-verify` 스택 + spec §10 E1 행. **먼저 `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller` + `cd ui && pnpm build`**(UI 분류표 확인이 있으므로 stale `ui/dist` 함정 — `run-controller-with-ui`류는 dist가 *없을 때만* 빌드, 루트 CLAUDE.md; 브라우저 hard reload 포함 — 리뷰 P12).

- [ ] **Step 1: US1** — 격리 DB로 컨트롤러 기동, 시나리오 2스텝(정상 responder + `http://127.0.0.1:1/` 닫힌 포트), run 생성 → `GET /api/runs/{id}/report`(curl→python 직결)에서 `error_kinds`에 `connect_refused` count>0 + 정상 스텝 오염 없음 + UI 분류표 렌더 확인.
- [ ] **Step 2: US1'** — keep-alive 후 두 번째 요청 head를 읽고 close하는 responder(python, 아래)로 run → 분류표에 `connection_reset` count>0 (**`other`가 아님** — R2 실전 검증):

```python
# keepalive_close_responder.py — 첫 요청 200 keep-alive, 둘째 요청 head 수신 후 close
import socket
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 8111)); s.listen(64)
while True:
    c, _ = s.accept()
    try:
        c.recv(65536)
        c.sendall(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n")
        c.recv(65536)  # 2번째 요청 head 대기
    finally:
        c.close()      # 응답 없이 종료 → hyper IncompleteMessage
```

- [ ] **Step 3: 회귀** — 정상 200 responder run → report JSON에 `error_kinds` 키 **부재**(python `"error_kinds" not in json`) + UI에 분류표 섹션 없음 + 기존 섹션(status 분포·요약) 정상.
- [ ] **Step 4: US4 갈음 기록** — 라이브 유발 제외(머신 포트 고갈 위험), Task 1 단위 테스트 green을 근거로 build-log에 기록할 문구 준비(spec §10).

---

## Self-Review 체크 (plan 작성자 완료 표시)

- Spec 커버리지: §3.1(T1) §3.2–3.3(T2) §4-E1(T3) §5.2(T4) §5.3(T5) §7.1/7.2/7.5-라벨(T6) §9.1(T1·T2) §9.2-E1(T4 store 단위 + T5 인라인 롤업 + T5 Step 4 `report_test.rs` e2e smoke) §9.3-E1(T6) §10-E1(T7). §5.4·§7.3·§7.4·§5.1은 E2/E3 plan 몫(의도적 제외).
- 타입 일관성: `ErrorKindStat{step_id, kind: ErrorKind, count: u64}`(engine) vs proto `kind: String`(as_str 매핑, T3) vs DB/`ErrorKindRow.kind: String`(T4) vs `ErrorKindCount`(T5) vs Zod(T6) — 문자열 계약 8종은 Global Constraints가 단일 소스.
- 줄번호는 작성 시점 grep 실측(`runner.rs:509`·`:283-293`·`:1578-1593`·`:388-397` 등) — Task 2 이후 밀림은 각 step의 grep 지시가 흡수.

REVIEW-GATE: APPROVED

//! 데스크톱 부하기 연결 루프가 내는 상태 사건, 실패 이유 분류, 사건 → 상태 추적기, IP 탐침.
//! 전부 순수 로직이라 시계와 연결 함수를 주입받아 단위 테스트한다.

use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::StreamExt;
use futures::stream::FuturesUnordered;
use handicap_proto::AUTH_FAILED_REASON;

use crate::error::WorkerError;
use crate::reconnect::SCHEDULE;

/// 탐침 한 번(후보 하나)의 TCP 연결 상한.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
/// 수락된 세션이 끝난 뒤 「연결됨 · 대기」를 유지하는 시간.
pub const GRACE: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FailReason {
    Unreachable,
    AuthFailed,
    Rejected(String),
    Protocol,
}

/// 에러를 실패 이유로 분류한다.
pub fn classify(err: &WorkerError) -> FailReason {
    match err {
        WorkerError::Connect(_) | WorkerError::InvalidUri(_) | WorkerError::ConnectTimeout => {
            FailReason::Unreachable
        }
        other => match other.abort_reason() {
            Some(r) if r == AUTH_FAILED_REASON => FailReason::AuthFailed,
            Some(r) => FailReason::Rejected(r.to_string()),
            None => FailReason::Protocol,
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PoolEvent {
    Probing {
        candidates: usize,
    },
    AttemptFailed {
        reason: FailReason,
        retry_in: Duration,
    },
    Accepted {
        addr: SocketAddr,
    },
    SessionLost {
        reason: FailReason,
    },
    RunStarted {
        run_id: String,
        scenario_name: Option<String>,
    },
    RunEnded,
    Excluded,
}

pub type EventSink = Arc<dyn Fn(PoolEvent) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PoolState {
    Connecting,
    Idle {
        addr: SocketAddr,
    },
    Running {
        addr: SocketAddr,
        run_id: String,
        scenario_name: Option<String>,
    },
    Retrying {
        reason: FailReason,
        retry_at: Instant,
    },
    Excluded,
}

/// 사건을 받아 현재 상태를 계산한다. 시계는 호출자가 넘긴다.
pub struct StatusTracker {
    excluded: bool,
    /// 마지막으로 수락된 주소. `None`이면 수락된 적 없음.
    accepted_addr: Option<SocketAddr>,
    /// 수락·실행 중 상태(유예·실패 덧씌우기 전).
    base: PoolState,
    grace_until: Option<Instant>,
    last_fail: Option<(FailReason, Instant)>,
}

impl Default for StatusTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl StatusTracker {
    pub fn new() -> Self {
        Self {
            excluded: false,
            accepted_addr: None,
            base: PoolState::Connecting,
            grace_until: None,
            last_fail: None,
        }
    }

    pub fn apply(&mut self, ev: &PoolEvent, now: Instant) {
        if self.excluded {
            return;
        }
        match ev {
            PoolEvent::Probing { .. } => {}
            PoolEvent::Accepted { addr } => {
                self.accepted_addr = Some(*addr);
                self.base = PoolState::Idle { addr: *addr };
                self.grace_until = None;
                self.last_fail = None;
            }
            PoolEvent::RunStarted {
                run_id,
                scenario_name,
            } => {
                if let Some(addr) = self.accepted_addr {
                    self.base = PoolState::Running {
                        addr,
                        run_id: run_id.clone(),
                        scenario_name: scenario_name.clone(),
                    };
                    self.grace_until = None;
                    self.last_fail = None;
                }
            }
            PoolEvent::RunEnded | PoolEvent::SessionLost { .. } => {
                if self.accepted_addr.is_some() {
                    self.grace_until = Some(now + GRACE);
                    self.last_fail = None;
                }
            }
            PoolEvent::AttemptFailed { reason, retry_in } => {
                self.last_fail = Some((reason.clone(), now + *retry_in));
            }
            PoolEvent::Excluded => self.excluded = true,
        }
    }

    pub fn state(&self, now: Instant) -> PoolState {
        if self.excluded {
            return PoolState::Excluded;
        }
        if let (Some(until), Some(addr)) = (self.grace_until, self.accepted_addr)
            && now < until
        {
            return PoolState::Idle { addr };
        }
        if let Some((reason, retry_at)) = &self.last_fail {
            return PoolState::Retrying {
                reason: reason.clone(),
                retry_at: *retry_at,
            };
        }
        if self.grace_until.is_some() {
            return PoolState::Connecting;
        }
        self.base.clone()
    }
}

/// 데스크톱 재시도 간격: `SCHEDULE`를 따르되 끝 값을 반복한다(포기 없음).
pub fn desktop_retry_delay(attempt: usize) -> Duration {
    SCHEDULE[attempt.min(SCHEDULE.len() - 1)]
}

/// 배정 전 Abort 사유의 최대 글자 수.
pub const ABORT_REASON_MAX_CHARS: usize = 200;
/// 실행 시작 사건의 시나리오 이름 최대 글자 수.
pub const SCENARIO_NAME_MAX_CHARS: usize = 80;
/// 실행 시작 사건의 run id 최대 글자 수.
pub const RUN_ID_MAX_CHARS: usize = 64;

/// bidi 제어 글자(U+061C·200E/200F·202A–202E·2066–2069).
fn is_bidi_control(c: char) -> bool {
    matches!(
        c,
        '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
    )
}

/// 서버가 보낸 글자를 사건에 싣기 전에 다듬는다: 제어 글자(C0·DEL·C1, 줄바꿈·탭 포함)와
/// bidi 제어 글자를 U+FFFD로 바꾸고 글자(char) 단위로 `max_chars`까지 자른다.
pub fn sanitize_clip(s: &str, max_chars: usize) -> String {
    s.chars()
        .take(max_chars)
        .map(|c| {
            if c.is_control() || is_bidi_control(c) {
                '\u{FFFD}'
            } else {
                c
            }
        })
        .collect()
}

/// 모든 후보에 동시에 연결을 시도해 처음 성공한 주소를 돌려준다. 시도마다 `timeout` 상한.
pub async fn probe_first<F, Fut>(
    addrs: &[SocketAddr],
    timeout: Duration,
    connect: F,
) -> Option<SocketAddr>
where
    F: Fn(SocketAddr) -> Fut,
    Fut: Future<Output = bool>,
{
    let mut attempts: FuturesUnordered<_> = addrs
        .iter()
        .map(|&addr| {
            let fut = connect(addr);
            async move {
                match tokio::time::timeout(timeout, fut).await {
                    Ok(true) => Some(addr),
                    _ => None,
                }
            }
        })
        .collect();
    while let Some(res) = attempts.next().await {
        if res.is_some() {
            return res;
        }
    }
    None
}

/// 운영용 연결 함수: TCP 연결이 되면 `true`.
pub async fn tcp_reachable(addr: SocketAddr) -> bool {
    tokio::net::TcpStream::connect(addr).await.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn classify_maps_kinds() {
        let bad_uri = "http://[bad"
            .parse::<tonic::codegen::http::Uri>()
            .unwrap_err();
        assert_eq!(
            classify(&WorkerError::InvalidUri(bad_uri)),
            FailReason::Unreachable
        );
        assert_eq!(
            classify(&WorkerError::ConnectTimeout),
            FailReason::Unreachable
        );
        assert_eq!(
            classify(&WorkerError::AbortedBeforeAssignment {
                reason: AUTH_FAILED_REASON.to_string()
            }),
            FailReason::AuthFailed
        );
        let other = "run already started or fully sharded";
        assert_eq!(
            classify(&WorkerError::AbortedBeforeAssignment {
                reason: other.to_string()
            }),
            FailReason::Rejected(other.to_string())
        );
        let not_pool = "controller is not in pool mode";
        assert_eq!(
            classify(&WorkerError::AbortedBeforeAssignment {
                reason: not_pool.to_string()
            }),
            FailReason::Rejected(not_pool.to_string())
        );
        assert_eq!(classify(&WorkerError::NoAssignment), FailReason::Protocol);
        assert_eq!(classify(&WorkerError::SendFailed), FailReason::Protocol);
    }

    #[test]
    fn accepted_is_idle_with_addr() {
        let t0 = Instant::now();
        let mut t = StatusTracker::new();
        t.apply(
            &PoolEvent::Accepted {
                addr: addr("10.0.0.1:9"),
            },
            t0,
        );
        assert_eq!(
            t.state(t0),
            PoolState::Idle {
                addr: addr("10.0.0.1:9")
            }
        );
    }

    #[test]
    fn probing_changes_nothing() {
        let t0 = Instant::now();
        let mut t = StatusTracker::new();
        t.apply(&PoolEvent::Probing { candidates: 3 }, t0);
        assert_eq!(t.state(t0), PoolState::Connecting);
    }

    #[test]
    fn run_started_carries_last_accepted_addr() {
        let t0 = Instant::now();
        let mut t = StatusTracker::new();
        t.apply(
            &PoolEvent::Accepted {
                addr: addr("10.0.0.1:9"),
            },
            t0,
        );
        t.apply(
            &PoolEvent::RunStarted {
                run_id: "r1".into(),
                scenario_name: Some("s".into()),
            },
            t0,
        );
        assert_eq!(
            t.state(t0),
            PoolState::Running {
                addr: addr("10.0.0.1:9"),
                run_id: "r1".into(),
                scenario_name: Some("s".into())
            }
        );
    }

    #[test]
    fn first_failure_before_accept_is_retrying_immediately() {
        let t0 = Instant::now();
        let mut t = StatusTracker::new();
        t.apply(
            &PoolEvent::AttemptFailed {
                reason: FailReason::Unreachable,
                retry_in: secs(1),
            },
            t0,
        );
        assert_eq!(
            t.state(t0),
            PoolState::Retrying {
                reason: FailReason::Unreachable,
                retry_at: t0 + secs(1)
            }
        );
    }

    fn accepted_then(end: PoolEvent, t0: Instant) -> StatusTracker {
        let mut t = StatusTracker::new();
        t.apply(
            &PoolEvent::Accepted {
                addr: addr("10.0.0.1:9"),
            },
            t0,
        );
        t.apply(&end, t0);
        t
    }

    fn check_grace_to_retrying(end: PoolEvent) {
        let t0 = Instant::now();
        let mut t = accepted_then(end, t0);
        t.apply(
            &PoolEvent::AttemptFailed {
                reason: FailReason::Unreachable,
                retry_in: secs(2),
            },
            t0 + secs(1),
        );
        assert_eq!(
            t.state(t0 + secs(14)),
            PoolState::Idle {
                addr: addr("10.0.0.1:9")
            }
        );
        assert_eq!(
            t.state(t0 + secs(15)),
            PoolState::Retrying {
                reason: FailReason::Unreachable,
                retry_at: t0 + secs(3)
            }
        );
    }

    #[test]
    fn grace_after_run_end() {
        check_grace_to_retrying(PoolEvent::RunEnded);
    }

    #[test]
    fn grace_after_session_lost_expires_to_retrying() {
        check_grace_to_retrying(PoolEvent::SessionLost {
            reason: FailReason::Protocol,
        });
    }

    #[test]
    fn grace_expired_without_failure_is_connecting() {
        let t0 = Instant::now();
        let t = accepted_then(PoolEvent::RunEnded, t0);
        assert_eq!(t.state(t0 + secs(16)), PoolState::Connecting);
    }

    #[test]
    fn reaccept_within_grace_stays_idle() {
        let t0 = Instant::now();
        let mut t = accepted_then(
            PoolEvent::SessionLost {
                reason: FailReason::Protocol,
            },
            t0,
        );
        t.apply(
            &PoolEvent::AttemptFailed {
                reason: FailReason::Unreachable,
                retry_in: secs(1),
            },
            t0 + secs(1),
        );
        t.apply(
            &PoolEvent::Accepted {
                addr: addr("10.0.0.1:9"),
            },
            t0 + secs(5),
        );
        assert_eq!(
            t.state(t0 + secs(20)),
            PoolState::Idle {
                addr: addr("10.0.0.1:9")
            }
        );
    }

    #[test]
    fn run_started_before_accept_is_ignored() {
        let t0 = Instant::now();
        let mut t = StatusTracker::new();
        t.apply(
            &PoolEvent::RunStarted {
                run_id: "r".into(),
                scenario_name: None,
            },
            t0,
        );
        assert_eq!(t.state(t0), PoolState::Connecting);
    }

    #[test]
    fn run_end_or_session_lost_before_accept_changes_nothing() {
        let t0 = Instant::now();
        let retrying = PoolState::Retrying {
            reason: FailReason::Unreachable,
            retry_at: t0 + secs(1),
        };
        for ev in [
            PoolEvent::RunEnded,
            PoolEvent::SessionLost {
                reason: FailReason::Protocol,
            },
        ] {
            let mut t = StatusTracker::new();
            t.apply(
                &PoolEvent::AttemptFailed {
                    reason: FailReason::Unreachable,
                    retry_in: secs(1),
                },
                t0,
            );
            t.apply(&ev, t0);
            assert_eq!(t.state(t0), retrying);
            assert_eq!(t.state(t0 + secs(20)), retrying);
        }
        let mut t = StatusTracker::new();
        t.apply(&PoolEvent::RunEnded, t0);
        assert_eq!(t.state(t0 + secs(1)), PoolState::Connecting);
    }

    #[test]
    fn run_started_clears_grace_and_failure() {
        let t0 = Instant::now();
        let mut t = accepted_then(
            PoolEvent::SessionLost {
                reason: FailReason::Protocol,
            },
            t0,
        );
        t.apply(
            &PoolEvent::AttemptFailed {
                reason: FailReason::Unreachable,
                retry_in: secs(1),
            },
            t0 + secs(1),
        );
        t.apply(
            &PoolEvent::RunStarted {
                run_id: "r".into(),
                scenario_name: None,
            },
            t0 + secs(2),
        );
        let running = PoolState::Running {
            addr: addr("10.0.0.1:9"),
            run_id: "r".into(),
            scenario_name: None,
        };
        assert_eq!(t.state(t0 + secs(3)), running);
        assert_eq!(t.state(t0 + secs(20)), running);
    }

    #[test]
    fn excluded_is_final() {
        let t0 = Instant::now();
        let mut t = StatusTracker::new();
        t.apply(
            &PoolEvent::Accepted {
                addr: addr("10.0.0.1:9"),
            },
            t0,
        );
        t.apply(
            &PoolEvent::RunStarted {
                run_id: "r".into(),
                scenario_name: None,
            },
            t0,
        );
        t.apply(&PoolEvent::Excluded, t0);
        t.apply(&PoolEvent::RunEnded, t0);
        t.apply(
            &PoolEvent::Accepted {
                addr: addr("10.0.0.2:9"),
            },
            t0,
        );
        assert_eq!(t.state(t0), PoolState::Excluded);
        assert_eq!(t.state(t0 + secs(60)), PoolState::Excluded);
    }

    #[test]
    fn desktop_delay_never_gives_up() {
        let want = [1u64, 2, 4, 8];
        for i in 0..=100usize {
            assert_eq!(desktop_retry_delay(i), secs(want[i.min(3)]), "attempt {i}");
        }
    }

    #[test]
    fn sanitize_clip_respects_char_boundary() {
        assert_eq!(sanitize_clip("가나다라", 2), "가나");
        assert_eq!(sanitize_clip("ab", 5), "ab");
    }

    #[test]
    fn sanitize_clip_replaces_c0_c1_controls() {
        for c in [
            '\0', '\t', '\n', '\r', '\u{1b}', '\u{7f}', '\u{80}', '\u{85}', '\u{9f}',
        ] {
            assert_eq!(
                sanitize_clip(&format!("a{c}b"), 10),
                "a\u{FFFD}b",
                "U+{:04X}",
                c as u32
            );
        }
    }

    #[test]
    fn sanitize_clip_replaces_bidi_controls() {
        let bidi = [
            '\u{200E}', '\u{200F}', '\u{061C}', '\u{202A}', '\u{202B}', '\u{202C}', '\u{202D}',
            '\u{202E}', '\u{2066}', '\u{2067}', '\u{2068}', '\u{2069}',
        ];
        for c in bidi {
            assert_eq!(
                sanitize_clip(&format!("a{c}b"), 10),
                "a\u{FFFD}b",
                "U+{:04X}",
                c as u32
            );
        }
    }

    #[test]
    fn sanitize_clip_keeps_ordinary_text() {
        // ZWJ(U+200D)·U+2065(배정 안 됨, bidi 범위 밖)·한글·이모지는 그대로.
        let s = "가👩\u{200D}💻\u{2065}x";
        assert_eq!(sanitize_clip(s, 100), s);
    }

    #[test]
    fn sanitize_clip_counts_replacements_as_chars() {
        assert_eq!(sanitize_clip("\n\n\nabc", 4), "\u{FFFD}\u{FFFD}\u{FFFD}a");
    }

    #[tokio::test(start_paused = true)]
    async fn probe_picks_first_success() {
        let a = addr("10.0.0.1:9");
        let b = addr("10.0.0.2:9");
        let got = probe_first(&[a, b], PROBE_TIMEOUT, |x| async move { x == b }).await;
        assert_eq!(got, Some(b));
    }

    #[tokio::test(start_paused = true)]
    async fn probe_skips_blackhole() {
        let hole = addr("10.0.0.1:9");
        let ok = addr("10.0.0.2:9");
        let start = tokio::time::Instant::now();
        let got = probe_first(&[hole, ok], PROBE_TIMEOUT, |x| async move {
            if x == hole {
                std::future::pending::<bool>().await
            } else {
                true
            }
        })
        .await;
        assert_eq!(got, Some(ok));
        assert!(start.elapsed() < PROBE_TIMEOUT, "{:?}", start.elapsed());
    }

    #[tokio::test(start_paused = true)]
    async fn probe_all_fail_returns_none_within_timeout() {
        let a = addr("10.0.0.1:9");
        let b = addr("10.0.0.2:9");
        let start = tokio::time::Instant::now();
        let got = probe_first(&[a, b], PROBE_TIMEOUT, |x| async move {
            if x == a {
                std::future::pending::<bool>().await
            } else {
                false
            }
        })
        .await;
        assert_eq!(got, None);
        assert!(start.elapsed() <= PROBE_TIMEOUT + Duration::from_millis(10));
    }

    #[tokio::test(start_paused = true)]
    async fn probe_single_candidate() {
        let a = addr("10.0.0.1:9");
        assert_eq!(
            probe_first(&[a], PROBE_TIMEOUT, |_| async { true }).await,
            Some(a)
        );
        assert_eq!(
            probe_first(&[a], PROBE_TIMEOUT, |_| async { false }).await,
            None
        );
    }
}

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
                std::io::ErrorKind::AddrNotAvailable => {
                    return Some(ErrorKind::LocalPortExhaustion);
                }
                std::io::ErrorKind::ConnectionRefused => return Some(ErrorKind::ConnectRefused),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe => {
                    return Some(ErrorKind::ConnectionReset);
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
    use std::error::Error;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt;

    /// 합성 체인 노드: 임의 메시지 + 임의 source. 필드는 `Send + Sync` 바운드까지
    /// 갖는다 — `io::Error::new`(아래 `io_node`/falls-through 테스트)의
    /// `E: Into<Box<dyn Error + Send + Sync>>` 요구를 만족시켜야 `Node`를 그
    /// 인자로 쓸 수 있다(brief 원안은 `+ 'static`만이라 이 용도에 미달).
    #[derive(Debug)]
    struct Node(
        String,
        Option<Box<dyn std::error::Error + Send + Sync + 'static>>,
    );
    impl fmt::Display for Node {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(f, "{}", self.0)
        }
    }
    impl std::error::Error for Node {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            // `Option<&T>` coercion (dropping Send+Sync) doesn't happen implicitly
            // through `as_deref()`'s return position — coerce explicitly per-ref.
            self.1
                .as_deref()
                .map(|e| e as &(dyn std::error::Error + 'static))
        }
    }
    // `std::io::Error::new` requires `Send + Sync` on the inner cause (brief 원안의
    // `Box<dyn Error + 'static>`는 이 바운드를 만족 못 해 컴파일 실패 — Send+Sync로
    // 교정. 반환 참조는 여전히 `&(dyn Error + 'static)`로 auto-trait만 드롭돼 호출부
    // 시그니처는 brief 그대로.
    fn io_node(
        kind: std::io::ErrorKind,
        inner: Option<Box<dyn std::error::Error + Send + Sync + 'static>>,
    ) -> Box<dyn std::error::Error + Send + Sync + 'static> {
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
        // 함정(brief 원안 대비 수정): std `io::Error::source()`는
        // `Custom(c) => c.error.source()`로 위임한다(자기 자신의 cause를 그대로
        // 반환하지 않음 — rustlib std/io/error.rs 확인) — 그래서
        // `io::Error::new(Other, inner_io_error)`로 직접 중첩하면
        // `outer.source()`가 `inner_io_error`가 아니라 그 *grandchild*
        // (`inner_io_error.source()` = None)로 건너뛰어 버려 이 테스트의 의도
        // (비매핑 kind를 지나쳐 다음 링크에서 매치)를 검증할 수 없다. `Node`를
        // 중간 링크로 넣어 `outer.source() == Some(inner)`가 되도록 한다.
        let inner: Box<dyn std::error::Error + Send + Sync + 'static> = Box::new(
            std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "x"),
        );
        let link = Node("dns error".into(), Some(inner));
        let outer = std::io::Error::other(link);
        assert_eq!(io_kind_class(&outer), Some(ErrorKind::ConnectRefused));
        let lone = io_node(std::io::ErrorKind::Other, None);
        assert_eq!(io_kind_class(&*lone), None);
    }

    #[test]
    fn chain_messages_collects_each_link_only() {
        let chain = Node(
            "outer msg".into(),
            Some(Box::new(Node("inner msg".into(), None))),
        );
        assert_eq!(
            chain_messages(&chain),
            vec!["outer msg".to_string(), "inner msg".to_string()]
        );
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

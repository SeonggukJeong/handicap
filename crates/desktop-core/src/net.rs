//! LAN 접속 주소 후보 고르기.
use std::net::Ipv4Addr;

/// 사설 대역(입력 순서 유지)이 있으면 그것만, 없으면 루프백·링크로컬 제외 나머지.
pub fn candidate_ipv4s(addrs: &[Ipv4Addr]) -> Vec<Ipv4Addr> {
    let private: Vec<Ipv4Addr> = addrs.iter().copied().filter(|a| a.is_private()).collect();
    if !private.is_empty() {
        return private;
    }
    addrs
        .iter()
        .copied()
        .filter(|a| !a.is_loopback() && !a.is_link_local())
        .collect()
}

/// 이 PC 인터페이스의 IPv4 주소 전부(필터 전).
pub fn list_local_ipv4s() -> Vec<Ipv4Addr> {
    if_addrs::get_if_addrs()
        .map(|v| {
            v.into_iter()
                .filter_map(|i| match i.ip() {
                    std::net::IpAddr::V4(a) => Some(a),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr as A;

    #[test]
    fn private_only_in_input_order() {
        let v = candidate_ipv4s(&[
            A::new(127, 0, 0, 1),
            A::new(169, 254, 1, 2),
            A::new(8, 8, 8, 8),
            A::new(192, 168, 0, 12),
            A::new(10, 1, 2, 3),
            A::new(172, 20, 0, 1),
            A::new(172, 32, 0, 1),
        ]);
        assert_eq!(
            v,
            vec![
                A::new(192, 168, 0, 12),
                A::new(10, 1, 2, 3),
                A::new(172, 20, 0, 1)
            ]
        );
    }
    #[test]
    fn no_private_falls_back_to_non_loopback_non_linklocal() {
        assert_eq!(
            candidate_ipv4s(&[
                A::new(127, 0, 0, 1),
                A::new(169, 254, 3, 3),
                A::new(8, 8, 4, 4)
            ]),
            vec![A::new(8, 8, 4, 4)]
        );
    }
    #[test]
    fn none_left_is_empty() {
        assert!(candidate_ipv4s(&[A::new(127, 0, 0, 1), A::new(169, 254, 9, 9)]).is_empty());
    }
}

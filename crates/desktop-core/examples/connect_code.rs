//! 라이브 검증용 접속 코드 생성기: `connect_code <ip,ip,…> <port> <token>` (검사 없음).
use handicap_desktop_core::code::{ConnectCode, encode};
use std::net::Ipv4Addr;

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let parsed = (a.len() == 3)
        .then(|| {
            let ips: Option<Vec<Ipv4Addr>> = a[0].split(',').map(|s| s.parse().ok()).collect();
            Some((ips?, a[1].parse::<u16>().ok()?))
        })
        .flatten();
    let Some((ips, port)) = parsed else {
        eprintln!("사용법: connect_code <ip,ip,…> <port> <token>");
        std::process::exit(2);
    };
    println!(
        "{}",
        encode(&ConnectCode {
            ips,
            port,
            token: a[2].clone()
        })
    );
}

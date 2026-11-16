//! 데스크톱 셸의 순수 로직(Tauri 비의존 — 게이트가 nextest로 검증).
pub mod command;
pub mod config;
pub mod net;
pub mod token;

#[cfg(test)]
mod smoke {
    #[test]
    fn crate_links() {}
}

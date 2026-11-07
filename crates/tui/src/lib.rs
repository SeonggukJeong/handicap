//! `handicap-tui` — 운영 모니터 터미널 앱(ADR-0055). 컨트롤러를 in-process로 띄우고
//! 루프백 REST로 보드를 가져와 시작한다.

pub mod api;
pub mod cli;
pub mod logging;
pub mod session;
pub mod tempdb;
pub mod wire;

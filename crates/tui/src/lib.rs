//! `handicap-tui` — 운영 모니터 터미널 앱(ADR-0055). 컨트롤러를 in-process로 띄우고
//! 루프백 REST로 보드를 가져와 시작한다.

pub mod api;
pub mod app;
pub mod check_mode;
pub mod cli;
pub mod inspect;
pub mod judge;
pub mod logging;
pub mod names;
pub mod panel_settings;
pub mod poll;
pub mod prefs;
pub mod session;
pub mod shutdown;
pub mod tempdb;
pub mod terminal;
pub mod text;
pub mod view;
pub mod wire;
pub mod yaml_var;

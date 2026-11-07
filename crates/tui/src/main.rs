use std::process::ExitCode;

use handicap_tui::app;
use handicap_tui::check_mode;
use handicap_tui::cli::{self, Command};
use handicap_tui::logging::{self, LogLoc};
use handicap_tui::tempdb;
use handicap_tui::terminal::install_panic_hook;

/// 테스트 전용 — 다른 스레드의 패닉이 로그에만 남고 터미널·stderr을 건드리지 않음을 증명한다.
fn panic_selftest() -> ExitCode {
    let loc = match logging::init(&logging::state_dir(), "tui.log") {
        Ok(p) => LogLoc::Path(p),
        Err(e) => LogLoc::Unavailable(format!("{e:#}")),
    };
    install_panic_hook(std::thread::current().id(), loc);
    let _ = std::thread::spawn(|| panic!("selftest-panic-marker")).join();
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    // in-process 디스패처는 자기 실행 파일을 워커로 띄운다 — 워커 호출이면 여기서 끝난다.
    handicap_controller::in_process::run_worker_if_invoked();

    if std::env::var_os("HANDICAP_TUI_PANIC_SELFTEST").is_some_and(|v| v == "1") {
        return panic_selftest();
    }

    let cmd = match cli::parse(std::env::args_os()) {
        Ok(c) => c,
        Err(e) => e.exit(),
    };
    let (file, log_name, check) = match &cmd {
        Command::Run { file } => (Some(file.clone()), "tui.log", false),
        Command::Check { file } => (Some(file.clone()), "tui-check.log", true),
        Command::Usage => (None, "", false),
    };
    let log_loc = if file.is_some() {
        match logging::init(&logging::state_dir(), log_name) {
            Ok(p) => LogLoc::Path(p),
            Err(e) => LogLoc::Unavailable(format!("{e:#}")),
        }
    } else {
        LogLoc::Unavailable(String::new())
    };
    if file.is_some() {
        tempdb::sweep_stale(&tempdb::runtime_dir());
    }

    if let (true, Some(f)) = (check, &file) {
        return ExitCode::from(check_mode::run(f) as u8);
    }

    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("점검 엔진을 시작하지 못했습니다: {e}");
            return ExitCode::from(1);
        }
    };
    // 모든 패닉은 로그 파일로. UI 스레드(=이 메인 스레드) 패닉일 때만 터미널을 복구한다.
    install_panic_hook(std::thread::current().id(), log_loc.clone());
    ExitCode::from(app::run(&rt, file.as_deref(), log_loc) as u8)
}

use std::process::ExitCode;

use handicap_tui::app;
use handicap_tui::check_mode;
use handicap_tui::cli::{self, Command};
use handicap_tui::logging::{self, LogLoc};
use handicap_tui::tempdb;
use handicap_tui::terminal::{install_log_only_panic_hook, install_panic_hook};

/// 테스트 전용 — 다른 스레드의 패닉이 로그에만 남고 터미널·stderr을 건드리지 않음을 증명한다.
fn init_log(name: &str) -> LogLoc {
    let Some(dir) = logging::state_dir() else {
        return LogLoc::Unavailable("홈 디렉터리를 알 수 없습니다".to_string());
    };
    match logging::init(&dir, name) {
        Ok(p) => LogLoc::Path(p),
        Err(e) => LogLoc::Unavailable(format!("{e:#}")),
    }
}

/// 테스트 전용 — `check-main`: `--check` 모드의 메인 스레드 패닉은 stderr에 한 줄 남는다.
fn panic_selftest_check_main() -> ExitCode {
    let loc = init_log("tui-check.log");
    install_log_only_panic_hook(std::thread::current().id(), loc);
    panic!("selftest-check-main-marker");
}

fn panic_selftest() -> ExitCode {
    let loc = init_log("tui.log");
    install_panic_hook(std::thread::current().id(), loc);
    let _ = std::thread::spawn(|| panic!("selftest-panic-marker")).join();
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    // in-process 디스패처는 자기 실행 파일을 워커로 띄운다 — 워커 호출이면 여기서 끝난다.
    handicap_controller::in_process::run_worker_if_invoked();

    match std::env::var_os("HANDICAP_TUI_PANIC_SELFTEST") {
        Some(v) if v == "1" => return panic_selftest(),
        Some(v) if v == "check-main" => return panic_selftest_check_main(),
        _ => {}
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
        init_log(log_name)
    } else {
        LogLoc::Unavailable(String::new())
    };
    if file.is_some() {
        tempdb::sweep_stale(&tempdb::runtime_dir());
    }

    if let (true, Some(f)) = (check, &file) {
        // 복구할 터미널이 없다 — 모든 스레드 패닉을 로그에만 남긴다.
        install_log_only_panic_hook(std::thread::current().id(), log_loc.clone());
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
    let code = app::run(&rt, file.as_deref(), log_loc);
    // 멈춘 비동기 작업이 있어도 종료가 길어지지 않게 상한을 둔다.
    rt.shutdown_timeout(std::time::Duration::from_secs(2));
    ExitCode::from(code as u8)
}

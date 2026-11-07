use std::process::ExitCode;

use handicap_tui::check_mode;
use handicap_tui::cli::{self, Command};
use handicap_tui::logging::{self, LogLoc};
use handicap_tui::session::Session;
use handicap_tui::tempdb;

fn main() -> ExitCode {
    // in-process 디스패처는 자기 실행 파일을 워커로 띄운다 — 워커 호출이면 여기서 끝난다.
    handicap_controller::in_process::run_worker_if_invoked();

    let cmd = match cli::parse(std::env::args_os()) {
        Ok(c) => c,
        Err(e) => e.exit(),
    };
    let (file, log_name, check) = match &cmd {
        Command::Run { file } => (file.clone(), "tui.log", false),
        Command::Check { file } => (file.clone(), "tui-check.log", true),
        Command::Usage => {
            println!("사용법: handicap-tui [--check] <보드 파일.json>");
            return ExitCode::from(2);
        }
    };
    let _log_loc = match logging::init(&logging::state_dir(), log_name) {
        Ok(p) => LogLoc::Path(p),
        Err(e) => LogLoc::Unavailable(format!("{e:#}")),
    };
    tempdb::sweep_stale(&tempdb::runtime_dir());

    if check {
        return ExitCode::from(check_mode::run(&file) as u8);
    }

    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            println!("점검 엔진을 시작하지 못했습니다: {e}");
            return ExitCode::from(1);
        }
    };
    // 임시 동작(Task 7에서 대체): 세션을 띄워 보드 수만 출력하고 종료한다.
    rt.block_on(async {
        match Session::start(&file, &tempdb::runtime_dir()).await {
            Ok(s) => {
                println!("가져온 보드 {}개", s.boards.len());
                s.shutdown().await;
                ExitCode::SUCCESS
            }
            Err(e) => {
                println!("{}: {}", check_mode::stage_label(e.stage), e.message);
                ExitCode::from(1)
            }
        }
    })
}

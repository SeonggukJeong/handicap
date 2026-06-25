// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 멀티콜: `<exe> worker …`로 실행됐으면 워커로 동작 후 종료(GUI init 전).
    // in-process SubprocessDispatcher가 워커를 current_exe(=이 바이너리)로 self-spawn한다.
    handicap_controller::in_process::run_worker_if_invoked();
    desktop_lib::run()
}

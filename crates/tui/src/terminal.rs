//! 터미널 수명(raw mode·대체 화면·마우스)과 패닉 훅.

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, ThreadId};

use ratatui::crossterm::event::{DisableMouseCapture, EnableMouseCapture};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};

use crate::logging::LogLoc;
use crate::text;

/// 터미널을 이미 되돌렸는가 — 패닉 훅이 복구한 뒤 unwind 중 `Drop`이 또 보내
/// stderr의 "로그:" 줄을 덮어쓰는 일을 막는다.
static RESTORED: AtomicBool = AtomicBool::new(false);

fn restore() {
    if RESTORED.swap(true, Ordering::SeqCst) {
        return;
    }
    let mut out = io::stdout();
    let _ = execute!(out, DisableMouseCapture, LeaveAlternateScreen);
    let _ = disable_raw_mode();
}

pub struct TerminalGuard {
    _private: (),
}

impl TerminalGuard {
    pub fn enter() -> io::Result<TerminalGuard> {
        enable_raw_mode()?;
        let mut out = io::stdout();
        if let Err(e) = execute!(out, EnterAlternateScreen, EnableMouseCapture) {
            let _ = execute!(out, DisableMouseCapture, LeaveAlternateScreen);
            let _ = disable_raw_mode();
            return Err(e);
        }
        RESTORED.store(false, Ordering::SeqCst);
        Ok(TerminalGuard { _private: () })
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanicAction {
    RestoreAndPrint,
    LogOnly,
}

pub fn panic_action(current: ThreadId, ui: ThreadId) -> PanicAction {
    if current == ui {
        PanicAction::RestoreAndPrint
    } else {
        PanicAction::LogOnly
    }
}

/// 모든 패닉을 로그 파일에 남기고 기본 훅(터미널 출력)은 부르지 않는다.
/// UI 스레드 패닉일 때만 터미널을 복구하고 stderr에 한 줄 남긴다.
pub fn install_panic_hook(ui_thread: ThreadId, log: LogLoc) {
    std::panic::set_hook(Box::new(move |info| {
        tracing::error!("panic: {info}");
        if panic_action(thread::current().id(), ui_thread) == PanicAction::RestoreAndPrint {
            restore();
            eprintln!("{} {}", text::PANIC_EXIT, text::log_line(&log));
        }
    }));
}

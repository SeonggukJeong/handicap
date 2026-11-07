//! 인자 해석(`handicap-tui <file>` · `--check <file>` · `--version` · `--help`).

use std::ffi::OsString;
use std::path::PathBuf;

use clap::Parser;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Run { file: PathBuf },
    Check { file: PathBuf },
    Usage,
}

#[derive(Parser, Debug)]
#[command(
    name = "handicap-tui",
    version,
    about = "핸디캡 운영 모니터 — 보드 파일을 터미널에서 계속 점검합니다"
)]
struct Args {
    /// 화면 없이 모든 칸이 첫 결과를 낼 때까지 기다린 뒤 요약을 출력하고 종료합니다
    #[arg(long)]
    check: bool,
    /// 핸디캡 보드 파일(.json)
    file: Option<PathBuf>,
}

pub fn parse<I: IntoIterator<Item = OsString>>(args: I) -> Result<Command, clap::Error> {
    let a = Args::try_parse_from(args)?;
    Ok(match (a.file, a.check) {
        (Some(file), true) => Command::Check { file },
        (Some(file), false) => Command::Run { file },
        (None, _) => Command::Usage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(a: &[&str]) -> Result<Command, clap::Error> {
        parse(a.iter().map(OsString::from))
    }

    #[test]
    fn file_only_is_run() {
        assert_eq!(
            p(&["handicap-tui", "b.json"]).unwrap(),
            Command::Run {
                file: "b.json".into()
            }
        );
    }

    #[test]
    fn check_flag_is_check() {
        assert_eq!(
            p(&["handicap-tui", "--check", "b.json"]).unwrap(),
            Command::Check {
                file: "b.json".into()
            }
        );
    }

    #[test]
    fn no_args_is_usage() {
        assert_eq!(p(&["handicap-tui"]).unwrap(), Command::Usage);
    }

    #[test]
    fn version_is_display_version() {
        let e = p(&["handicap-tui", "--version"]).unwrap_err();
        assert_eq!(e.kind(), clap::error::ErrorKind::DisplayVersion);
    }
}

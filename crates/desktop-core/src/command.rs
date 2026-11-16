//! 다른 PC에서 붙일 부하기(워커) 명령 문자열.
use serde::{Deserialize, Serialize};
use std::net::Ipv4Addr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkerOs {
    Windows,
    Macos,
    Linux,
}

pub fn worker_command(
    os: WorkerOs,
    app_version: &str,
    ip: Ipv4Addr,
    port: u16,
    token: &str,
) -> String {
    let tail = format!("worker --controller http://{ip}:{port} --token {token}");
    match os {
        WorkerOs::Windows => format!(
            r".\Handicap_{app_version}_x64-portable.exe {tail} --worker-id $env:COMPUTERNAME"
        ),
        WorkerOs::Macos => format!(
            r#"/Applications/Handicap.app/Contents/MacOS/desktop {tail} --worker-id "$(hostname)""#
        ),
        WorkerOs::Linux => {
            format!(r#"./Handicap_{app_version}_amd64.AppImage {tail} --worker-id "$(hostname)""#)
        }
    }
}

pub fn current_os() -> WorkerOs {
    if cfg!(target_os = "windows") {
        WorkerOs::Windows
    } else if cfg!(target_os = "macos") {
        WorkerOs::Macos
    } else {
        WorkerOs::Linux
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_command() {
        assert_eq!(
            worker_command(
                WorkerOs::Windows,
                "0.15.0",
                "192.168.0.12".parse().unwrap(),
                8081,
                "tok"
            ),
            r".\Handicap_0.15.0_x64-portable.exe worker --controller http://192.168.0.12:8081 --token tok --worker-id $env:COMPUTERNAME"
        );
    }
    #[test]
    fn macos_command() {
        assert_eq!(
            worker_command(
                WorkerOs::Macos,
                "0.15.0",
                "10.0.0.5".parse().unwrap(),
                8093,
                "tok"
            ),
            r#"/Applications/Handicap.app/Contents/MacOS/desktop worker --controller http://10.0.0.5:8093 --token tok --worker-id "$(hostname)""#
        );
    }
    #[test]
    fn linux_command() {
        assert_eq!(
            worker_command(
                WorkerOs::Linux,
                "0.15.0",
                "10.0.0.5".parse().unwrap(),
                8081,
                "tok"
            ),
            r#"./Handicap_0.15.0_amd64.AppImage worker --controller http://10.0.0.5:8081 --token tok --worker-id "$(hostname)""#
        );
    }
    #[test]
    fn os_serde_lowercase() {
        assert_eq!(
            serde_json::to_string(&WorkerOs::Macos).unwrap(),
            r#""macos""#
        );
    }
}

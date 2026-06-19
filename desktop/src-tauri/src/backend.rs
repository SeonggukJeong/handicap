//! controller 실행 추상(R7) + 사이드카 구현(R3 Unix killpg / R12 Windows Job Object).
//! 셸(lib.rs)은 이 트레잇의 base_url()/shutdown()에만 의존 → 접근 2(in-process)는 backend 교체.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;

use anyhow::{Context, anyhow};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

use crate::launch::{self, HEALTH_POLL_ATTEMPTS, HEALTH_POLL_INTERVAL_MS, SpawnConfig};

/// controller 실행 백엔드 추상. v1=사이드카, 접근 2=in-process(후속).
pub trait ControllerBackend: Send + Sync {
    /// 창이 navigate할 베이스 URL(`http://127.0.0.1:<port>/`).
    fn base_url(&self) -> String;
    /// 종료 시 호출 — 프로세스 트리 정리.
    fn shutdown(&self);
}

/// OS별 자식 핸들(트리 종료용).
#[cfg(unix)]
struct ChildTree {
    pgid: i32, // process_group(0)로 child가 그룹 리더 → pgid == child pid
}
#[cfg(windows)]
struct ChildTree {
    _job: win32job::Job, // drop/close 시 KILL_ON_JOB_CLOSE로 트리 종료
}

pub struct SidecarBackend {
    port: u16,
    tree: Mutex<Option<ChildTree>>,
}

impl SidecarBackend {
    /// 사이드카 spawn → 로그에서 실제 REST 포트 파싱 → `/api/health`==`ok` 준비 대기 → 반환.
    /// 실패(포트 미검출/헬스 타임아웃)면 Err — 호출자가 창에 에러를 띄운다(navigate 금지).
    pub async fn start(sidecar: PathBuf, cfg: SpawnConfig) -> anyhow::Result<SidecarBackend> {
        let mut cmd = Command::new(&sidecar);
        cmd.args(cfg.to_args())
            .env("RUST_LOG", "info") // 포트 로그 라인 보장(R8)
            .env("NO_COLOR", "1") // ANSI 색상 억제 — tracing_subscriber는 TTY 감지 없이 ANSI ON(FINDING-1)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);

        // Unix: child를 자기 자신이 리더인 새 프로세스 그룹으로 → killpg가 손자 워커까지 도달(R3).
        #[cfg(unix)]
        cmd.process_group(0);

        let mut child = cmd
            .spawn()
            .with_context(|| format!("spawn {:?}", sidecar))?;
        let child_pid = child.id().ok_or_else(|| anyhow!("no child pid"))? as i32;

        // Windows: child를 Job에 배정(워커 spawn 전). 손자는 breakaway 미사용으로 자동 enrolled(R12).
        #[cfg(windows)]
        let tree = {
            // child.raw_handle()는 tokio Child의 inherent 메서드(AsRawHandle 트레잇 import 불요).
            let job = win32job::Job::create().context("create job")?;
            let mut info = job.query_extended_limit_info().context("query job")?;
            info.limit_kill_on_job_close();
            job.set_extended_limit_info(&mut info).context("set job")?;
            job.assign_process(child.raw_handle().ok_or_else(|| anyhow!("no handle"))? as isize)
                .context("assign job")?;
            ChildTree { _job: job }
        };
        #[cfg(unix)]
        let tree = ChildTree { pgid: child_pid };

        // stdout/stderr를 *지속* 드레인(파이프 버퍼 막힘 방지) + 첫 포트를 채널로 전달.
        // ChildStdout/ChildStderr는 서로 다른 타입이라 배열 불가 — 각각 개별 spawn.
        let (tx, rx) = oneshot::channel::<u16>();
        let tx = std::sync::Arc::new(Mutex::new(Some(tx)));

        macro_rules! spawn_drain {
            ($stream:expr) => {
                if let Some(s) = $stream {
                    let tx = tx.clone();
                    tokio::spawn(async move {
                        let mut lines = BufReader::new(s).lines();
                        while let Ok(Some(line)) = lines.next_line().await {
                            if let Some(p) = launch::parse_rest_port(&line) {
                                if let Some(sender) = tx.lock().unwrap().take() {
                                    let _ = sender.send(p);
                                }
                            }
                            // 계속 드레인(로그 폐기) — 멈추면 child가 파이프에 블록.
                        }
                    });
                }
            };
        }
        spawn_drain!(child.stdout.take());
        spawn_drain!(child.stderr.take());

        // 포트 대기(타임아웃).
        let port = tokio::time::timeout(
            std::time::Duration::from_millis(HEALTH_POLL_INTERVAL_MS * HEALTH_POLL_ATTEMPTS as u64),
            rx,
        )
        .await
        .map_err(|_| anyhow!("controller가 시간 내 REST 포트를 로그하지 않음"))?
        .map_err(|_| anyhow!("포트 채널 닫힘(controller 조기 종료?)"))?;

        // 헬스폴: 200 + 본문 "ok"만 준비로 인정(R8 — SPA fallback 200 false-positive 회피).
        let client = reqwest::Client::new();
        let url = launch::health_url(port);
        let mut ready = false;
        for _ in 0..HEALTH_POLL_ATTEMPTS {
            if let Ok(resp) = client.get(&url).send().await {
                if resp.status().is_success() {
                    if let Ok(body) = resp.text().await {
                        if body.trim() == "ok" {
                            ready = true;
                            break;
                        }
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(HEALTH_POLL_INTERVAL_MS)).await;
        }
        if !ready {
            // 정리 후 실패 — 좀비 방지.
            #[cfg(unix)]
            unsafe {
                libc::killpg(tree.pgid, libc::SIGKILL);
            }
            return Err(anyhow!("controller /api/health 준비 실패(포트 {port})"));
        }

        Ok(SidecarBackend {
            port,
            tree: Mutex::new(Some(tree)),
        })
    }
}

impl ControllerBackend for SidecarBackend {
    fn base_url(&self) -> String {
        launch::base_url(self.port)
    }

    fn shutdown(&self) {
        let Some(tree) = self.tree.lock().unwrap().take() else {
            return;
        };
        #[cfg(unix)]
        unsafe {
            // SIGTERM(워커 graceful) → 유예 → SIGKILL(controller는 시그널 핸들러 없음).
            libc::killpg(tree.pgid, libc::SIGTERM);
            std::thread::sleep(std::time::Duration::from_millis(500));
            libc::killpg(tree.pgid, libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            drop(tree); // Job 핸들 close → KILL_ON_JOB_CLOSE로 트리 종료.
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    /// process_group(0) + killpg가 *손자*까지 종료함을 가짜 트리로 검증(R3 메커니즘).
    #[tokio::test]
    async fn killpg_terminates_child_and_grandchild() {
        use std::process::Stdio;
        use tokio::process::Command;
        // 자식 sh가 손자 sleep을 낳고, 둘 다 같은 새 그룹.
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg("sleep 60 & echo started; wait")
            .stdout(Stdio::piped())
            .process_group(0);
        let mut child = cmd.spawn().unwrap();
        let pgid = child.id().unwrap() as i32;
        // 시작 대기
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        // killpg → 그룹 전체(자식 sh + 손자 sleep) 종료.
        unsafe {
            libc::killpg(pgid, libc::SIGKILL);
        }
        let status = tokio::time::timeout(std::time::Duration::from_secs(3), child.wait())
            .await
            .expect("child should die within 3s")
            .unwrap();
        assert!(!status.success() || status.code().is_none());
        // 손자 sleep이 같은 그룹이라 함께 종료됨(고아 0) — pgid로 추가 sleep 없음을 OS가 보장.
    }
}

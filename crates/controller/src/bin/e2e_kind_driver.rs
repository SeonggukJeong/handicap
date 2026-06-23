//! Host-side end-to-end driver for kind. Run via scripts/e2e-kind.sh.
//! Assumes the controller is reachable at $HANDICAP_BASE (default
//! http://127.0.0.1:8080) and that wiremock admin is reachable at
//! $WIREMOCK_ADMIN_BASE (default http://127.0.0.1:19001) via port-forward.
//! The worker (in-cluster) reaches wiremock at $WIREMOCK_CLUSTER_BASE
//! (default http://wiremock.handicap-test.svc.cluster.local:8080).
//!
//! Steps:
//!   1. Seed wiremock stubs via WIREMOCK_ADMIN_BASE
//!   2. POST /api/scenarios — 2-step scenario (login → profile)
//!   3. POST /api/runs — closed-loop VU curve (peak 50, cap 25 → N=2), env BASE_URL = wm_cluster
//!   4. Poll GET /api/runs/{id} every 1 s until terminal
//!   5. GET /api/runs/{id}/report — assert summary.count > 0, steps.len() == 2

use std::time::Duration;

use anyhow::{Context, bail};
use serde_json::{Value, json};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let base = std::env::var("HANDICAP_BASE").unwrap_or_else(|_| "http://127.0.0.1:8080".into());
    let wm_admin =
        std::env::var("WIREMOCK_ADMIN_BASE").unwrap_or_else(|_| "http://127.0.0.1:19001".into());
    let wm_cluster = std::env::var("WIREMOCK_CLUSTER_BASE")
        .unwrap_or_else(|_| "http://wiremock.handicap-test.svc.cluster.local:8080".into());

    let cli = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;

    println!("==> seeding wiremock stubs at {wm_admin}");
    seed_wiremock(&cli, &wm_admin).await?;

    println!("==> creating scenario");
    let scenario_yaml = r#"version: 1
name: kind-e2e
variables: {}
steps:
  - id: login
    name: Login
    type: http
    request:
      method: POST
      url: "${BASE_URL}/login"
      headers:
        Content-Type: application/json
      body:
        json:
          username: u
          password: p
    assert:
      - status: 200
    extract:
      - var: token
        from: body
        path: "$.token"
  - id: profile
    name: Profile
    type: http
    request:
      method: GET
      url: "${BASE_URL}/me"
      headers:
        Authorization: "Bearer {{token}}"
    assert:
      - status: 200
"#;

    let scen: Value = cli
        .post(format!("{base}/api/scenarios"))
        .json(&json!({"name": "kind-e2e", "yaml": scenario_yaml}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let scenario_id = scen["id"].as_str().context("scenario id")?.to_string();
    println!("    scenario id = {scenario_id}");

    println!("==> creating run");
    let run: Value = cli
        .post(format!("{base}/api/runs"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": {"duration_seconds": 0, "vu_stages": [{"target": 50, "duration_seconds": 10}]},
            "env": {"BASE_URL": wm_cluster},
        }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let run_id = run["id"].as_str().context("run id")?.to_string();
    println!("    run id = {run_id}");

    println!("==> polling for terminal");
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    let mut status = String::new();
    loop {
        if std::time::Instant::now() > deadline {
            bail!("run did not terminate within 120 s (last status = {status})");
        }
        let r: Value = cli
            .get(format!("{base}/api/runs/{run_id}"))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        status = r["status"].as_str().unwrap_or("").to_string();
        println!("    status = {status}");
        if matches!(status.as_str(), "completed" | "failed" | "aborted") {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    if status != "completed" {
        bail!("expected status=completed, got {status}");
    }

    println!("==> fetching report");
    let report: Value = cli
        .get(format!("{base}/api/runs/{run_id}/report"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let count = report["summary"]["count"]
        .as_i64()
        .context("summary.count")?;
    let steps_len = report["steps"].as_array().context("steps")?.len();
    if count == 0 {
        bail!("expected summary.count > 0");
    }
    if steps_len != 2 {
        bail!("expected 2 steps, got {steps_len}");
    }
    println!("==> OK: count={count} steps={steps_len}");
    Ok(())
}

async fn seed_wiremock(cli: &reqwest::Client, base: &str) -> anyhow::Result<()> {
    cli.post(format!("{base}/__admin/mappings"))
        .json(&json!({
            "request": {"method": "POST", "url": "/login"},
            "response": {"status": 200, "jsonBody": {"token": "abc"}}
        }))
        .send()
        .await?
        .error_for_status()?;
    cli.post(format!("{base}/__admin/mappings"))
        .json(&json!({
            "request": {"method": "GET", "url": "/me"},
            "response": {"status": 200, "jsonBody": {"id": 1}}
        }))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

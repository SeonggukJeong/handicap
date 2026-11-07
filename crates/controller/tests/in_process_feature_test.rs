#![cfg(feature = "in-process")]

use handicap_controller::in_process::{InProcessConfig, run_in_process};

#[tokio::test]
async fn in_process_available_without_bundle() {
    assert_eq!(InProcessConfig::default().rest.port(), 0);

    let tmp = tempfile::tempdir().unwrap();
    let cfg = InProcessConfig {
        db: Some(tmp.path().join("c.db").display().to_string()),
        scheduler_disabled: true,
        ..InProcessConfig::default()
    };
    let rc = run_in_process(cfg).await.unwrap();
    let url = format!("http://{}/api/health", rc.rest_addr());
    let resp = reqwest::get(&url).await.unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    rc.shutdown().await;
}

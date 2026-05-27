use serde::{Deserialize, Serialize};
use sqlx::Row;
use ulid::Ulid;

use super::Db;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Aborted,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Pending => "pending",
            RunStatus::Running => "running",
            RunStatus::Completed => "completed",
            RunStatus::Failed => "failed",
            RunStatus::Aborted => "aborted",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "pending" => RunStatus::Pending,
            "running" => RunStatus::Running,
            "completed" => RunStatus::Completed,
            "failed" => RunStatus::Failed,
            "aborted" => RunStatus::Aborted,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub vus: u32,
    #[serde(default)]
    pub ramp_up_seconds: u32,
    pub duration_seconds: u32,
}

pub struct RunRow {
    pub id: String,
    pub scenario_id: String,
    pub scenario_yaml: String,
    pub profile: Profile,
    pub env: serde_json::Value,
    pub status: RunStatus,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub created_at: i64,
}

pub async fn insert(
    db: &Db,
    scenario_id: &str,
    scenario_yaml: &str,
    profile: &Profile,
    env: &serde_json::Value,
) -> sqlx::Result<RunRow> {
    let id = Ulid::new().to_string();
    let now = now_ms();
    let profile_json = serde_json::to_string(profile).expect("serialize profile");
    let env_json = serde_json::to_string(env).expect("serialize env");
    sqlx::query(
        "INSERT INTO runs(id,scenario_id,scenario_yaml,profile_json,env_json,status,created_at) \
         VALUES(?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(scenario_id)
    .bind(scenario_yaml)
    .bind(&profile_json)
    .bind(&env_json)
    .bind(RunStatus::Pending.as_str())
    .bind(now)
    .execute(db)
    .await?;
    Ok(RunRow {
        id,
        scenario_id: scenario_id.to_string(),
        scenario_yaml: scenario_yaml.to_string(),
        profile: profile.clone(),
        env: env.clone(),
        status: RunStatus::Pending,
        started_at: None,
        ended_at: None,
        created_at: now,
    })
}

pub async fn get(db: &Db, id: &str) -> sqlx::Result<Option<RunRow>> {
    let row = sqlx::query(
        "SELECT id,scenario_id,scenario_yaml,profile_json,env_json,status,started_at,ended_at,created_at \
         FROM runs WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(r) = row else { return Ok(None) };
    let profile: Profile =
        serde_json::from_str(r.get::<String, _>("profile_json").as_str()).unwrap();
    let env: serde_json::Value =
        serde_json::from_str(r.get::<String, _>("env_json").as_str()).unwrap();
    let status =
        RunStatus::parse(r.get::<String, _>("status").as_str()).unwrap_or(RunStatus::Failed);
    Ok(Some(RunRow {
        id: r.get("id"),
        scenario_id: r.get("scenario_id"),
        scenario_yaml: r.get("scenario_yaml"),
        profile,
        env,
        status,
        started_at: r.get("started_at"),
        ended_at: r.get("ended_at"),
        created_at: r.get("created_at"),
    }))
}

pub async fn list_by_scenario(db: &Db, scenario_id: &str) -> sqlx::Result<Vec<RunRow>> {
    let rows = sqlx::query(
        "SELECT id,scenario_id,scenario_yaml,profile_json,env_json,status,started_at,ended_at,created_at \
         FROM runs WHERE scenario_id = ? ORDER BY created_at DESC",
    )
    .bind(scenario_id)
    .fetch_all(db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let profile: Profile =
            serde_json::from_str(r.get::<String, _>("profile_json").as_str()).unwrap();
        let env: serde_json::Value =
            serde_json::from_str(r.get::<String, _>("env_json").as_str()).unwrap();
        let status =
            RunStatus::parse(r.get::<String, _>("status").as_str()).unwrap_or(RunStatus::Failed);
        out.push(RunRow {
            id: r.get("id"),
            scenario_id: r.get("scenario_id"),
            scenario_yaml: r.get("scenario_yaml"),
            profile,
            env,
            status,
            started_at: r.get("started_at"),
            ended_at: r.get("ended_at"),
            created_at: r.get("created_at"),
        });
    }
    Ok(out)
}

pub async fn set_status(
    db: &Db,
    id: &str,
    status: RunStatus,
    started: Option<i64>,
    ended: Option<i64>,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE runs SET status = ?, started_at = COALESCE(?, started_at), ended_at = COALESCE(?, ended_at) WHERE id = ? AND status != 'aborted'",
    )
    .bind(status.as_str())
    .bind(started)
    .bind(ended)
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn mark_aborted(db: &Db, id: &str) -> sqlx::Result<()> {
    let now = now_ms();
    sqlx::query("UPDATE runs SET status = 'aborted', ended_at = ? WHERE id = ?")
        .bind(now)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

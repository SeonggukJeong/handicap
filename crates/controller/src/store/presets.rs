use serde::Serialize;
use sqlx::Row;
use ulid::Ulid;

use super::Db;
use super::runs::Profile;

/// One stored run preset (Profile + env), scoped to a scenario.
#[derive(Debug)]
pub struct PresetRow {
    pub id: String,
    pub scenario_id: String,
    pub name: String,
    pub profile: Profile,
    pub env: serde_json::Value,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A preset that references a given dataset — returned by the dataset DELETE
/// soft guard (spec §3 #14) so the UI can list what would break.
#[derive(Debug, Serialize)]
pub struct PresetRef {
    pub preset_id: String,
    pub name: String,
    pub scenario_id: String,
}

pub async fn insert(
    db: &Db,
    scenario_id: &str,
    name: &str,
    profile: &Profile,
    env: &serde_json::Value,
) -> sqlx::Result<PresetRow> {
    let id = Ulid::new().to_string();
    let now = super::now_ms();
    let profile_json = serde_json::to_string(profile).expect("serialize profile");
    let env_json = serde_json::to_string(env).expect("serialize env");
    sqlx::query(
        "INSERT INTO run_presets(id,scenario_id,name,profile_json,env_json,created_at,updated_at) \
         VALUES(?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(scenario_id)
    .bind(name)
    .bind(&profile_json)
    .bind(&env_json)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    Ok(PresetRow {
        id,
        scenario_id: scenario_id.to_string(),
        name: name.to_string(),
        profile: profile.clone(),
        env: env.clone(),
        created_at: now,
        updated_at: now,
    })
}

pub async fn get(db: &Db, id: &str) -> sqlx::Result<Option<PresetRow>> {
    let row = sqlx::query(
        "SELECT id,scenario_id,name,profile_json,env_json,created_at,updated_at \
         FROM run_presets WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(r) = row else { return Ok(None) };
    let profile: Profile =
        serde_json::from_str(r.get::<String, _>("profile_json").as_str()).unwrap();
    let env: serde_json::Value =
        serde_json::from_str(r.get::<String, _>("env_json").as_str()).unwrap();
    Ok(Some(PresetRow {
        id: r.get("id"),
        scenario_id: r.get("scenario_id"),
        name: r.get("name"),
        profile,
        env,
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    }))
}

pub async fn list_by_scenario(db: &Db, scenario_id: &str) -> sqlx::Result<Vec<PresetRow>> {
    let rows = sqlx::query(
        "SELECT id,scenario_id,name,profile_json,env_json,created_at,updated_at \
         FROM run_presets WHERE scenario_id = ? ORDER BY name",
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
        out.push(PresetRow {
            id: r.get("id"),
            scenario_id: r.get("scenario_id"),
            name: r.get("name"),
            profile,
            env,
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
        });
    }
    Ok(out)
}

/// Full-body replace. Returns `None` if no preset with `id` exists.
pub async fn update(
    db: &Db,
    id: &str,
    name: &str,
    profile: &Profile,
    env: &serde_json::Value,
) -> sqlx::Result<Option<PresetRow>> {
    let now = super::now_ms();
    let profile_json = serde_json::to_string(profile).expect("serialize profile");
    let env_json = serde_json::to_string(env).expect("serialize env");
    let res = sqlx::query(
        "UPDATE run_presets SET name = ?, profile_json = ?, env_json = ?, updated_at = ? \
         WHERE id = ?",
    )
    .bind(name)
    .bind(&profile_json)
    .bind(&env_json)
    .bind(now)
    .bind(id)
    .execute(db)
    .await?;
    if res.rows_affected() == 0 {
        return Ok(None);
    }
    get(db, id).await
}

pub async fn delete(db: &Db, id: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM run_presets WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Presets that reference `dataset_id` in any of their `profile_json` data
/// bindings (the `data_bindings` accessor folds the legacy single field, so both
/// shapes match). Used by the dataset DELETE soft guard (spec §3 #14).
pub async fn referencing_dataset(db: &Db, dataset_id: &str) -> sqlx::Result<Vec<PresetRef>> {
    let rows = sqlx::query("SELECT id,scenario_id,name,profile_json FROM run_presets")
        .fetch_all(db)
        .await?;
    let mut out = Vec::new();
    for r in rows {
        let pj: String = r.get("profile_json");
        if let Ok(profile) = serde_json::from_str::<Profile>(&pj) {
            if profile
                .data_bindings()
                .iter()
                .any(|b| b.dataset_id == dataset_id)
            {
                out.push(PresetRef {
                    preset_id: r.get("id"),
                    name: r.get("name"),
                    scenario_id: r.get("scenario_id"),
                });
            }
        }
    }
    Ok(out)
}

/// 시나리오 삭제 soft 409 카운트용.
pub async fn count_by_scenario(db: &Db, scenario_id: &str) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM run_presets WHERE scenario_id = ?")
        .bind(scenario_id)
        .fetch_one(db)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binding::{BindingPolicy, DataBinding, Mapping};
    use crate::store;
    use crate::store::runs::Profile;
    use handicap_engine::Scenario;

    async fn db_with_scenario() -> (Db, String) {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let yaml = "version: 1\nname: t\nsteps: []";
        let scenario: Scenario = serde_yaml::from_str(yaml).unwrap();
        let sc = store::scenarios::insert(&db, &scenario, yaml)
            .await
            .unwrap();
        (db, sc.id)
    }

    fn profile() -> Profile {
        Profile {
            vus: 3,
            ramp_up_seconds: 1,
            duration_seconds: 9,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            data_binding: None,
            data_bindings: vec![],
            criteria: None,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
            measure_phases: false,
            vu_stages: None,
            ramp_down: None,
            worker_count: None,
        }
    }

    #[tokio::test]
    async fn insert_get_list_update_delete_roundtrip() {
        let (db, scenario_id) = db_with_scenario().await;
        let env = serde_json::json!({ "BASE_URL": "http://x" });
        let row = insert(&db, &scenario_id, "smoke", &profile(), &env)
            .await
            .unwrap();

        let got = get(&db, &row.id).await.unwrap().expect("preset");
        assert_eq!(got.name, "smoke");
        assert_eq!(got.profile.vus, 3);
        assert_eq!(got.env, env);

        let listed = list_by_scenario(&db, &scenario_id).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, row.id);

        let mut p2 = profile();
        p2.vus = 10;
        let updated = update(&db, &row.id, "smoke2", &p2, &env)
            .await
            .unwrap()
            .expect("updated");
        assert_eq!(updated.name, "smoke2");
        assert_eq!(updated.profile.vus, 10);

        delete(&db, &row.id).await.unwrap();
        assert!(get(&db, &row.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn unique_scenario_name_is_enforced() {
        let (db, scenario_id) = db_with_scenario().await;
        let env = serde_json::json!({});
        insert(&db, &scenario_id, "dup", &profile(), &env)
            .await
            .unwrap();
        let err = insert(&db, &scenario_id, "dup", &profile(), &env)
            .await
            .expect_err("second insert with same (scenario_id,name) must fail");
        assert!(
            err.as_database_error()
                .map(|d| d.is_unique_violation())
                .unwrap_or(false),
            "expected a UNIQUE violation, got {err:?}"
        );
    }

    #[tokio::test]
    async fn update_missing_returns_none() {
        let (db, _scenario_id) = db_with_scenario().await;
        let out = update(&db, "nope", "x", &profile(), &serde_json::json!({}))
            .await
            .unwrap();
        assert!(out.is_none());
    }

    #[tokio::test]
    async fn referencing_dataset_finds_bound_presets() {
        let (db, scenario_id) = db_with_scenario().await;
        let mut bound = profile();
        bound.data_binding = Some(DataBinding {
            dataset_id: "DS1".into(),
            policy: BindingPolicy::PerVu,
            mappings: vec![Mapping::Column {
                var: "u".into(),
                column: "user".into(),
            }],
        });
        insert(&db, &scenario_id, "bound", &bound, &serde_json::json!({}))
            .await
            .unwrap();
        insert(
            &db,
            &scenario_id,
            "unbound",
            &profile(),
            &serde_json::json!({}),
        )
        .await
        .unwrap();

        let refs = referencing_dataset(&db, "DS1").await.unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].name, "bound");

        assert!(referencing_dataset(&db, "OTHER").await.unwrap().is_empty());
    }
}

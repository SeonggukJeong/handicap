//! op-config 상한의 코드-단일-소스(레지스트리) + 런타임 유효값(스냅샷).
//! 유효값 = DB 오버라이드(범위 내) ?? 시드(CLI 또는 코드 상수). spec R4/R7.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

use crate::grpc::coordinator::DEFAULT_WORKER_CAPACITY_VUS;

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Group {
    Limits,
    TestRun,
    Scheduler,
}

#[derive(Clone, Copy)]
pub struct SettingDef {
    pub key: &'static str,
    pub label: &'static str,
    pub group: Group,
    pub min: i64,
    pub max: i64,
    pub unit: &'static str,
    pub mutable: bool,
    /// 컴파일타임 fallback 기본값(CLI 미지정 시). CLI-시드 키는 main이 실제 값으로 덮음.
    pub default: i64,
}

/// 단일 소스. 새 knob = 여기 1행(+가변이면 결정 지점 1줄). spec R7.
pub static SETTINGS: &[SettingDef] = &[
    SettingDef {
        key: "worker_capacity_vus",
        label: "워커당 VU 수용량",
        group: Group::Limits,
        min: 1,
        max: 1_000_000,
        unit: "VU",
        mutable: true,
        default: DEFAULT_WORKER_CAPACITY_VUS as i64,
    },
    SettingDef {
        key: "dataset_max_rows",
        label: "반복 바인딩 데이터셋 최대 행 수",
        group: Group::Limits,
        min: 1,
        max: 100_000_000,
        unit: "행",
        mutable: true,
        default: 1_000_000,
    },
    SettingDef {
        key: "max_open_loop_worker_count",
        label: "열린 루프 워커 수 상한",
        group: Group::Limits,
        min: 1,
        max: 256,
        unit: "대",
        mutable: true,
        default: 64,
    },
    SettingDef {
        key: "max_data_bindings",
        label: "run당 데이터셋 바인딩 최대 개수",
        group: Group::Limits,
        min: 1,
        max: 64,
        unit: "개",
        mutable: true,
        default: 8,
    },
    SettingDef {
        key: "max_loop_breakdown_cap",
        label: "반복별 메트릭 상한의 최댓값",
        group: Group::Limits,
        min: 0,
        max: 1_000_000,
        unit: "회차",
        mutable: true,
        default: 10_000,
    },
    SettingDef {
        key: "max_test_run_requests",
        label: "테스트 실행 최대 요청 수",
        group: Group::TestRun,
        min: 1,
        max: 100_000,
        unit: "요청",
        mutable: true,
        default: 10_000,
    },
    // LAN 풀 하트비트 임계값(런타임 가변). 리퍼가 매 sweep 읽음. spec R1/R2.
    SettingDef {
        key: "pool_heartbeat_interval_seconds",
        label: "풀 하트비트 ping 주기",
        group: Group::Limits,
        min: 1,
        max: 3600,
        unit: "초",
        mutable: true,
        default: 10,
    },
    SettingDef {
        key: "pool_stale_timeout_seconds",
        label: "풀 워커 stale 타임아웃",
        group: Group::Limits,
        min: 2,
        max: 86400,
        unit: "초",
        mutable: true,
        default: 30,
    },
    // 읽기전용 표시(배포 변경). spec §3.5/§4.2.
    SettingDef {
        key: "trace_body_cap_bytes",
        label: "테스트 실행 응답 본문 캡",
        group: Group::TestRun,
        min: 0,
        max: i64::MAX,
        unit: "바이트",
        mutable: false,
        default: 1_048_576,
    }, // engine executor.rs:242 MAX_TRACE_BODY_BYTES (R7 예외 §5)
    SettingDef {
        key: "scheduler_tick_seconds",
        label: "스케줄러 점검 주기",
        group: Group::Scheduler,
        min: 0,
        max: i64::MAX,
        unit: "초",
        mutable: false,
        default: 30,
    },
    SettingDef {
        key: "pool_keepalive_seconds",
        label: "풀 gRPC keepalive (서버측)",
        group: Group::Limits,
        min: 0,
        max: i64::MAX,
        unit: "초",
        mutable: false,
        default: 20,
    }, // 컨트롤러 서버측 h2 keepalive(transport-baked). 워커 클라 keepalive는 별도 20s 상수(worker-core/client.rs) — R4/§5.
];

pub fn def(key: &str) -> Option<&'static SettingDef> {
    SETTINGS.iter().find(|d| d.key == key)
}

/// 검증(R2 단일 함수): 키 존재 + 가변 + [min,max]. REST PUT가 호출.
pub fn validate(key: &str, value: i64) -> Result<(), String> {
    let d = def(key).ok_or_else(|| format!("알 수 없는 설정 키: {key}"))?;
    if !d.mutable {
        return Err(format!(
            "'{}'은(는) 배포 설정이라 변경할 수 없습니다",
            d.label
        ));
    }
    if value < d.min || value > d.max {
        return Err(format!(
            "'{}' 값은 {}~{} 범위여야 합니다 (받음: {value})",
            d.label, d.min, d.max
        ));
    }
    Ok(())
}

/// R5: stale 타임아웃은 ping 주기보다 반드시 커야 한다(같거나 작으면 건강한 워커가
/// 매 sweep 조기 evict → idle flap·busy run 실패). PUT(결과 쌍)·DELETE(revert 후 쌍)·
/// startup(시드, main.rs)이 공유하는 단일 소스.
pub fn check_heartbeat_pair(interval: u64, stale: u64) -> Result<(), String> {
    if stale <= interval {
        return Err(format!(
            "stale 타임아웃({stale}초)은 ping 주기({interval}초)보다 커야 합니다 (먼저 stale를 올리세요)"
        ));
    }
    Ok(())
}

#[derive(Default)]
struct MutSnap {
    values: HashMap<&'static str, i64>, // 가변 키의 유효값
    overridden: HashSet<&'static str>,  // 활성 DB 오버라이드 키
}

/// 런타임 유효값 스냅샷. AppState가 들고 결정 지점이 accessor로 읽음.
/// `std::sync::RwLock` + read-into-local: 가드를 `.await` 너머로 들고 가지 않음(FR3).
#[derive(Clone)]
pub struct SettingsState {
    snap: Arc<RwLock<MutSnap>>,
    seeds: Arc<HashMap<&'static str, i64>>, // 가변 키 시드(복원·source용, 불변)
    readonly: Arc<HashMap<&'static str, i64>>, // 읽기전용 표시값(불변)
}

impl SettingsState {
    /// startup 빌더. `db_overrides`=DB 행, `cli_seeds`=CLI 유래 시드(capacity·dataset·tick).
    /// 범위밖/비가변 오버라이드는 skip+warn→시드(M3).
    pub fn build(db_overrides: &HashMap<String, i64>, cli_seeds: &[(&'static str, i64)]) -> Self {
        let seed_of = |key: &'static str, default: i64| -> i64 {
            cli_seeds
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| *v)
                .unwrap_or(default)
        };
        let mut values = HashMap::new();
        let mut overridden = HashSet::new();
        let mut seeds = HashMap::new();
        let mut readonly = HashMap::new();
        for d in SETTINGS {
            let seed = seed_of(d.key, d.default);
            if d.mutable {
                seeds.insert(d.key, seed);
                match db_overrides.get(d.key) {
                    Some(&v) if v >= d.min && v <= d.max => {
                        values.insert(d.key, v);
                        overridden.insert(d.key);
                    }
                    Some(&v) => {
                        tracing::warn!(
                            key = d.key,
                            value = v,
                            "범위 밖 설정 오버라이드 무시 → 시드 사용"
                        );
                        values.insert(d.key, seed);
                    }
                    None => {
                        values.insert(d.key, seed);
                    }
                }
            } else {
                readonly.insert(d.key, seed);
            }
        }
        // R5c (effective): a surviving DB override combined with a changed CLI seed can
        // produce stale <= interval even when each value is individually in range — the
        // main.rs seed-pair clamp only covers the CLI seeds. Cross-check the EFFECTIVE
        // pair here and clamp stale to interval+1 (warn) so the reaper never boots into
        // destructive flapping. (Seed-only case is already interval+1 here → no re-clamp,
        // no double-warn.)
        if let (Some(&interval), Some(&stale)) = (
            values.get("pool_heartbeat_interval_seconds"),
            values.get("pool_stale_timeout_seconds"),
        ) {
            if stale <= interval {
                let clamped = interval + 1;
                tracing::warn!(
                    interval = interval,
                    stale = stale,
                    clamped_to = clamped,
                    "유효 stale <= interval (오버라이드+시드 조합) — stale를 interval+1로 clamp"
                );
                values.insert("pool_stale_timeout_seconds", clamped);
            }
        }
        Self {
            snap: Arc::new(RwLock::new(MutSnap { values, overridden })),
            seeds: Arc::new(seeds),
            readonly: Arc::new(readonly),
        }
    }

    fn get(&self, key: &'static str) -> i64 {
        let g = self.snap.read().expect("settings RwLock poisoned");
        *g.values.get(key).expect("registry key missing in snapshot")
    }
    pub fn worker_capacity_vus(&self) -> u32 {
        self.get("worker_capacity_vus") as u32
    }
    pub fn dataset_max_rows(&self) -> u64 {
        self.get("dataset_max_rows") as u64
    }
    pub fn max_open_loop_worker_count(&self) -> u32 {
        self.get("max_open_loop_worker_count") as u32
    }
    pub fn max_data_bindings(&self) -> usize {
        self.get("max_data_bindings") as usize
    }
    pub fn max_loop_breakdown_cap(&self) -> u32 {
        self.get("max_loop_breakdown_cap") as u32
    }
    pub fn max_test_run_requests(&self) -> u32 {
        self.get("max_test_run_requests") as u32
    }
    pub fn pool_heartbeat_interval_seconds(&self) -> u64 {
        self.get("pool_heartbeat_interval_seconds") as u64
    }
    pub fn pool_stale_timeout_seconds(&self) -> u64 {
        self.get("pool_stale_timeout_seconds") as u64
    }
    /// 가변 키의 CLI/registry 시드(R5 DELETE-revert 교차검사용). 읽기전용/미지 키는 None.
    pub fn seed_of(&self, key: &str) -> Option<i64> {
        self.seeds.get(key).copied()
    }

    /// PUT 적용(검증은 호출 전 `validate`로 통과 가정). 스냅샷 갱신.
    pub fn apply_override(&self, key: &'static str, value: i64) {
        let mut g = self.snap.write().expect("settings RwLock poisoned");
        g.values.insert(key, value);
        g.overridden.insert(key);
    }
    /// DELETE 복원: 시드로 되돌리고 오버라이드 해제.
    pub fn revert(&self, key: &'static str) {
        let seed = *self.seeds.get(key).expect("mutable key missing seed");
        let mut g = self.snap.write().expect("settings RwLock poisoned");
        g.values.insert(key, seed);
        g.overridden.remove(key);
    }

    /// R1 응답 데이터(가변=스냅샷/읽기전용=readonly + 메타 + source). DTO 변환은 api/settings.rs.
    pub fn view(&self) -> Vec<SettingView> {
        let g = self.snap.read().expect("settings RwLock poisoned");
        SETTINGS
            .iter()
            .map(|d| {
                let (value, default, source) = if d.mutable {
                    let v = *g.values.get(d.key).expect("snapshot");
                    let seed = *self.seeds.get(d.key).expect("seed");
                    let src = if g.overridden.contains(d.key) {
                        "override"
                    } else {
                        "default"
                    };
                    (v, seed, src)
                } else {
                    let v = *self.readonly.get(d.key).expect("readonly");
                    (v, v, "readonly")
                };
                SettingView {
                    def: *d,
                    value,
                    default,
                    source,
                }
            })
            .collect()
    }

    // ----- 테스트 seam (N1) -----
    /// 전 키 시드 기본값.
    #[cfg(test)]
    pub fn seeded_for_test() -> Self {
        Self::build(&HashMap::new(), &[])
    }
    /// 특정 키 시드 override(capacity 등 N>1 유도용).
    #[cfg(test)]
    pub fn seeded_for_test_with(seeds: &[(&'static str, i64)]) -> Self {
        Self::build(&HashMap::new(), seeds)
    }
}

pub struct SettingView {
    pub def: SettingDef,
    pub value: i64,
    pub default: i64,
    pub source: &'static str,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_single_source() {
        // 키 중복 없음 + min<=max + 가변키는 [min,max] 안에 default.
        let mut seen = HashSet::new();
        for d in SETTINGS {
            assert!(seen.insert(d.key), "중복 키 {}", d.key);
            assert!(d.min <= d.max, "{} min>max", d.key);
            if d.mutable {
                assert!(
                    d.default >= d.min && d.default <= d.max,
                    "{} default 범위밖",
                    d.key
                );
            }
        }
    }

    #[test]
    fn effective_prefers_override() {
        let mut db = HashMap::new();
        db.insert("worker_capacity_vus".to_string(), 5000);
        let s = SettingsState::build(&db, &[]);
        assert_eq!(s.worker_capacity_vus(), 5000); // override 우선
        assert_eq!(s.max_data_bindings(), 8); // 미오버라이드 = 시드
    }

    #[test]
    fn cli_seed_overrides_registry_default() {
        let s = SettingsState::build(&HashMap::new(), &[("worker_capacity_vus", 3000)]);
        assert_eq!(s.worker_capacity_vus(), 3000);
    }

    #[test]
    fn out_of_range_override_falls_back_to_seed() {
        let mut db = HashMap::new();
        db.insert("max_open_loop_worker_count".to_string(), 99999); // max 256 초과
        let s = SettingsState::build(&db, &[]);
        assert_eq!(s.max_open_loop_worker_count(), 64); // skip→시드
    }

    #[test]
    fn out_of_range_override_falls_back_to_cli_seed_not_registry_default() {
        let mut db = HashMap::new();
        db.insert("max_open_loop_worker_count".to_string(), 99999); // max 256 초과 → skip
        // CLI seed 32 (registry default는 64) — skip 시 시드(=CLI 32)로 폴백해야 함.
        let s = SettingsState::build(&db, &[("max_open_loop_worker_count", 32)]);
        assert_eq!(s.max_open_loop_worker_count(), 32);
    }

    #[test]
    fn validate_rejects_immutable_and_out_of_range() {
        assert!(validate("trace_body_cap_bytes", 5).is_err()); // 비가변
        assert!(validate("nope", 5).is_err()); // 미지키
        assert!(validate("max_data_bindings", 0).is_err()); // min 1 미만
        assert!(validate("max_data_bindings", 8).is_ok());
    }

    #[test]
    fn apply_and_revert() {
        let s = SettingsState::seeded_for_test();
        s.apply_override("max_data_bindings", 20);
        assert_eq!(s.max_data_bindings(), 20);
        s.revert("max_data_bindings");
        assert_eq!(s.max_data_bindings(), 8);
    }

    #[test]
    fn view_reports_source_and_readonly() {
        let s = SettingsState::seeded_for_test();
        s.apply_override("dataset_max_rows", 500);
        let v = s.view();
        let ds = v.iter().find(|x| x.def.key == "dataset_max_rows").unwrap();
        assert_eq!(ds.value, 500);
        assert_eq!(ds.source, "override");
        let ro = v
            .iter()
            .find(|x| x.def.key == "trace_body_cap_bytes")
            .unwrap();
        assert_eq!(ro.source, "readonly");
        assert_eq!(ro.value, 1_048_576);
    }

    #[test]
    fn readonly_key_takes_cli_seed() {
        // scheduler_tick_seconds는 읽기전용 — CLI 시드가 표시값으로 들어가야 함(기본 30 대신 60).
        let s = SettingsState::build(&HashMap::new(), &[("scheduler_tick_seconds", 60)]);
        let v = s.view();
        let tick = v
            .iter()
            .find(|x| x.def.key == "scheduler_tick_seconds")
            .unwrap();
        assert_eq!(tick.value, 60);
        assert_eq!(tick.source, "readonly");
    }

    #[test]
    fn pool_heartbeat_keys_registered() {
        let i = def("pool_heartbeat_interval_seconds").expect("interval key");
        assert!(i.mutable && i.min == 1 && i.max == 3600 && i.default == 10);
        let s = def("pool_stale_timeout_seconds").expect("stale key");
        assert!(s.mutable && s.min == 2 && s.max == 86400 && s.default == 30);
        let k = def("pool_keepalive_seconds").expect("keepalive key");
        assert!(!k.mutable && k.default == 20);
    }

    #[test]
    fn check_heartbeat_pair_requires_stale_gt_interval() {
        assert!(check_heartbeat_pair(10, 30).is_ok());
        assert!(check_heartbeat_pair(10, 11).is_ok());
        assert!(check_heartbeat_pair(10, 10).is_err()); // equal → reject
        assert!(check_heartbeat_pair(10, 5).is_err()); // stale < interval → reject
    }

    #[test]
    fn build_clamps_effective_stale_le_interval() {
        // DB override stale=8 (in range) + CLI seed interval=10 → effective 8 <= 10 → clamp to 11.
        let mut db = HashMap::new();
        db.insert("pool_stale_timeout_seconds".to_string(), 8i64);
        let st = SettingsState::build(&db, &[("pool_heartbeat_interval_seconds", 10)]);
        assert_eq!(st.pool_heartbeat_interval_seconds(), 10);
        assert_eq!(st.pool_stale_timeout_seconds(), 11);
    }

    #[test]
    fn pool_heartbeat_accessors_and_seed() {
        let st = SettingsState::seeded_for_test();
        assert_eq!(st.pool_heartbeat_interval_seconds(), 10);
        assert_eq!(st.pool_stale_timeout_seconds(), 30);
        assert_eq!(st.seed_of("pool_stale_timeout_seconds"), Some(30));
        assert_eq!(st.seed_of("trace_body_cap_bytes"), None); // readonly → no seed
    }
}

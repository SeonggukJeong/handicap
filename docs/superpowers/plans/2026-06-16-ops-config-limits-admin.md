# 운영 상한 관리자 화면 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 산재한 op-config 상한을 `/settings` 한 화면에서 보고, 컨트롤러 per-request 상한 6종을 재배포 없이 DB 오버라이드로 조정한다(엔진 subprocess 상수·스케줄러는 읽기전용 표시).

**Architecture:** 코드 레지스트리(`static SETTINGS`)가 단일 소스 → 검증·DB 매핑·REST·UI 메타가 거기서 파생. 가변 6종은 `settings` 테이블 오버라이드(migration 0017)를 인메모리 스냅샷(`SettingsState`, `std::sync::RwLock`)에 얹어 결정 지점이 per-request로 읽음(유효값 = override ?? 시드). 오버라이드 0개면 byte-identical. 엔진·워커·proto 무변경.

**Tech Stack:** Rust(axum 0.8 + sqlx/SQLite), React/TS(Zod + React Query + vitest/RTL). spec: `docs/superpowers/specs/2026-06-16-ops-config-limits-admin-design.md`(R1–R12).

---

## 파일 구조 (생성/수정 + 책임)

**생성:**
- `crates/controller/src/settings.rs` — 레지스트리(`SETTINGS`·`SettingDef`·`SettingKind`·`Group`) + `SettingsState`(스냅샷·accessor·validate·view·set/revert·테스트 seam). **단일 책임: op-config 상한의 코드-단일-소스 + 런타임 유효값.**
- `crates/controller/src/store/settings.rs` — `load_overrides`/`upsert`/`delete`(raw DB I/O만).
- `crates/controller/src/api/settings.rs` — `GET/PUT/DELETE /api/settings` 핸들러 + `SettingDto`.
- `ui/src/pages/SettingsPage.tsx` — 관리 화면(가변 편집 섹션 + 읽기전용 섹션).
- `ui/src/pages/__tests__/SettingsPage.test.tsx` — RTL.

**수정:**
- `crates/controller/src/lib.rs` — `pub mod settings;` + `mod settings;`(store) 등록.
- `crates/controller/src/store/mod.rs` — migration 0017 const + execute, `pub mod settings;`.
- `crates/controller/src/app.rs` — `AppState`(`dataset_max_rows: u64` 제거 → `settings: SettingsState`) + `/api/settings` 라우트 3개.
- `crates/controller/src/main.rs` — startup에서 `SettingsState` 빌드(DB override + CLI 시드), coord에 capacity 미전달.
- `crates/controller/src/grpc/coordinator.rs` — `worker_capacity_vus` 필드 + `worker_count_for` 제거, `with_capacity`/`new` 조정.
- `crates/controller/src/api/runs.rs` — 6 결정 지점 + `state_with` 테스트 헬퍼 + 단위테스트.
- `crates/controller/src/api/test_runs.rs` — `State<AppState>` 추가, `max_test_run_requests` 읽기.
- `crates/controller/src/schedule/runner.rs` — AppState fixture(test_state).
- `crates/controller/src/dispatcher/k8s_spec.rs` — stale 주석.
- `crates/controller/tests/multi_worker_fanout_e2e.rs` — `boot()` 시그니처(+capacity 시드).
- `crates/controller/tests/data_binding_api_test.rs` — `:220` capacity 시드.
- (`grep -rn "AppState {" crates/controller/{src,tests}` ~42곳/19파일 — 컴파일러-driven.)
- `ui/src/lib/api.ts`(또는 `client.ts`) — `getSettings`/`putSetting`/`deleteSetting` + Zod `SettingSchema`.
- `ui/src/routes.tsx` — `/settings` 라우트.
- `ui/src/i18n/ko.ts` — `ko.opsSettings` 카탈로그.
- nav 컴포넌트(`grep`으로 EnvironmentsPage 링크 위치 확인) — 설정 링크.

**커밋 경계(전체-워크스페이스 게이트 대응)**: 신규 모듈 API는 **`pub`**(lib 공개 API라 결정 지점 미배선 상태에서도 dead_code 안 남 — Task 1·2 단독 green). AppState 필드 교체는 ~42 사이트를 동시에 깨므로 **Task 3 단일 컴파일러-driven green 커밋**.

---

## Task 1: 설정 레지스트리 + SettingsState (settings.rs)

**Files:**
- Create: `crates/controller/src/settings.rs`
- Modify: `crates/controller/src/lib.rs`(`pub mod settings;` 추가)

**충족 R**: R4(유효값=override??seed), R7(레지스트리 단일소스), R2(validate 로직), M3(범위밖 override skip→seed), N1(테스트 seam).

- [ ] **Step 1: lib.rs에 모듈 등록**

`crates/controller/src/lib.rs`의 기존 `pub mod …` 블록에 추가:
```rust
pub mod settings;
```

- [ ] **Step 2: settings.rs 작성 — 레지스트리 + 타입 + SettingsState + 인라인 테스트**

`crates/controller/src/settings.rs` 전체:
```rust
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
    SettingDef { key: "worker_capacity_vus", label: "워커당 VU 수용량", group: Group::Limits,
        min: 1, max: 1_000_000, unit: "VU", mutable: true, default: DEFAULT_WORKER_CAPACITY_VUS as i64 },
    SettingDef { key: "dataset_max_rows", label: "반복 바인딩 데이터셋 최대 행 수", group: Group::Limits,
        min: 1, max: 100_000_000, unit: "행", mutable: true, default: 1_000_000 },
    SettingDef { key: "max_open_loop_worker_count", label: "열린 루프 워커 수 상한", group: Group::Limits,
        min: 1, max: 256, unit: "대", mutable: true, default: 64 },
    SettingDef { key: "max_data_bindings", label: "run당 데이터셋 바인딩 최대 개수", group: Group::Limits,
        min: 1, max: 64, unit: "개", mutable: true, default: 8 },
    SettingDef { key: "max_loop_breakdown_cap", label: "반복별 메트릭 상한의 최댓값", group: Group::Limits,
        min: 0, max: 1_000_000, unit: "회차", mutable: true, default: 10_000 },
    SettingDef { key: "max_test_run_requests", label: "테스트 실행 최대 요청 수", group: Group::TestRun,
        min: 1, max: 100_000, unit: "요청", mutable: true, default: 10_000 },
    // 읽기전용 표시(배포 변경). spec §3.5/§4.2.
    SettingDef { key: "trace_body_cap_bytes", label: "테스트 실행 응답 본문 캡", group: Group::TestRun,
        min: 0, max: i64::MAX, unit: "바이트", mutable: false, default: 1_048_576 }, // engine executor.rs:242 MAX_TRACE_BODY_BYTES (R7 예외 §5)
    SettingDef { key: "scheduler_tick_seconds", label: "스케줄러 점검 주기", group: Group::Scheduler,
        min: 0, max: i64::MAX, unit: "초", mutable: false, default: 30 },
];

pub fn def(key: &str) -> Option<&'static SettingDef> {
    SETTINGS.iter().find(|d| d.key == key)
}

/// 검증(R2 단일 함수): 키 존재 + 가변 + [min,max]. REST PUT가 호출.
pub fn validate(key: &str, value: i64) -> Result<(), String> {
    let d = def(key).ok_or_else(|| format!("알 수 없는 설정 키: {key}"))?;
    if !d.mutable {
        return Err(format!("'{}'은(는) 배포 설정이라 변경할 수 없습니다", d.label));
    }
    if value < d.min || value > d.max {
        return Err(format!("'{}' 값은 {}~{} 범위여야 합니다 (받음: {value})", d.label, d.min, d.max));
    }
    Ok(())
}

#[derive(Default)]
struct MutSnap {
    values: HashMap<&'static str, i64>,   // 가변 키의 유효값
    overridden: HashSet<&'static str>,    // 활성 DB 오버라이드 키
}

/// 런타임 유효값 스냅샷. AppState가 들고 결정 지점이 accessor로 읽음.
/// `std::sync::RwLock` + read-into-local: 가드를 `.await` 너머로 들고 가지 않음(FR3).
#[derive(Clone)]
pub struct SettingsState {
    snap: Arc<RwLock<MutSnap>>,
    seeds: Arc<HashMap<&'static str, i64>>,    // 가변 키 시드(복원·source용, 불변)
    readonly: Arc<HashMap<&'static str, i64>>, // 읽기전용 표시값(불변)
}

impl SettingsState {
    /// startup 빌더. `db_overrides`=DB 행, `cli_seeds`=CLI 유래 시드(capacity·dataset·tick).
    /// 범위밖/비가변 오버라이드는 skip+warn→시드(M3).
    pub fn build(db_overrides: &HashMap<String, i64>, cli_seeds: &[(&'static str, i64)]) -> Self {
        let seed_of = |key: &'static str, default: i64| -> i64 {
            cli_seeds.iter().find(|(k, _)| *k == key).map(|(_, v)| *v).unwrap_or(default)
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
                    Some(&v) if v >= d.min && v <= d.max => { values.insert(d.key, v); overridden.insert(d.key); }
                    Some(&v) => { tracing::warn!(key = d.key, value = v, "범위 밖 설정 오버라이드 무시 → 시드 사용"); values.insert(d.key, seed); }
                    None => { values.insert(d.key, seed); }
                }
            } else {
                readonly.insert(d.key, seed);
            }
        }
        Self { snap: Arc::new(RwLock::new(MutSnap { values, overridden })),
            seeds: Arc::new(seeds), readonly: Arc::new(readonly) }
    }

    fn get(&self, key: &'static str) -> i64 {
        let g = self.snap.read().expect("settings RwLock poisoned");
        *g.values.get(key).expect("registry key missing in snapshot")
    }
    pub fn worker_capacity_vus(&self) -> u32 { self.get("worker_capacity_vus") as u32 }
    pub fn dataset_max_rows(&self) -> u64 { self.get("dataset_max_rows") as u64 }
    pub fn max_open_loop_worker_count(&self) -> u32 { self.get("max_open_loop_worker_count") as u32 }
    pub fn max_data_bindings(&self) -> usize { self.get("max_data_bindings") as usize }
    pub fn max_loop_breakdown_cap(&self) -> u32 { self.get("max_loop_breakdown_cap") as u32 }
    pub fn max_test_run_requests(&self) -> u32 { self.get("max_test_run_requests") as u32 }

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
        SETTINGS.iter().map(|d| {
            let (value, default, source) = if d.mutable {
                let v = *g.values.get(d.key).expect("snapshot");
                let seed = *self.seeds.get(d.key).expect("seed");
                let src = if g.overridden.contains(d.key) { "override" } else { "default" };
                (v, seed, src)
            } else {
                (*self.readonly.get(d.key).expect("readonly"), *self.readonly.get(d.key).expect("readonly"), "readonly")
            };
            SettingView { def: *d, value, default, source }
        }).collect()
    }

    // ----- 테스트 seam (N1) -----
    /// 전 키 시드 기본값.
    #[cfg(test)]
    pub fn seeded_for_test() -> Self { Self::build(&HashMap::new(), &[]) }
    /// 특정 키 시드 override(capacity 등 N>1 유도용).
    #[cfg(test)]
    pub fn seeded_for_test_with(seeds: &[(&'static str, i64)]) -> Self { Self::build(&HashMap::new(), seeds) }
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
                assert!(d.default >= d.min && d.default <= d.max, "{} default 범위밖", d.key);
            }
        }
    }

    #[test]
    fn effective_prefers_override() {
        let mut db = HashMap::new();
        db.insert("worker_capacity_vus".to_string(), 5000);
        let s = SettingsState::build(&db, &[]);
        assert_eq!(s.worker_capacity_vus(), 5000);          // override 우선
        assert_eq!(s.max_data_bindings(), 8);                // 미오버라이드 = 시드
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
        assert_eq!(s.max_open_loop_worker_count(), 64);     // skip→시드
    }

    #[test]
    fn validate_rejects_immutable_and_out_of_range() {
        assert!(validate("trace_body_cap_bytes", 5).is_err());      // 비가변
        assert!(validate("nope", 5).is_err());                       // 미지키
        assert!(validate("max_data_bindings", 0).is_err());          // min 1 미만
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
        let ro = v.iter().find(|x| x.def.key == "trace_body_cap_bytes").unwrap();
        assert_eq!(ro.source, "readonly");
        assert_eq!(ro.value, 1_048_576);
    }
}
```

- [ ] **Step 3: 빌드 + 테스트 (RED→GREEN 한 번에)**

Run: `cargo test -p handicap-controller settings:: 2>&1 | tail -20`
Expected: 위 7개 테스트 PASS. (`pub` API라 미배선 상태여도 dead_code 없음.)

- [ ] **Step 4: 커밋**

```bash
git add crates/controller/src/settings.rs crates/controller/src/lib.rs
git commit -m "feat(settings): op-config 상한 레지스트리 + SettingsState 스냅샷 (R4/R7)"
```
(cargo-영향 → 전체 게이트, `run_in_background:false` + timeout 600000ms 단일 호출, 폴링 금지. 직후 `git log -1`로 landed 확인.)

---

## Task 2: DB 저장소 + migration 0017 (store/settings.rs)

**Files:**
- Create: `crates/controller/src/store/settings.rs`
- Modify: `crates/controller/src/store/mod.rs`(`pub mod settings;` + migration 0017 const + execute)

**충족 R**: R8(migration 0017 멱등 + const/execute 양쪽), R3(delete), R4(load_overrides).

- [ ] **Step 1: store/mod.rs에 migration 0017 추가**

`crates/controller/src/store/mod.rs`의 const 블록 끝(`MIGRATION_SQL_0016` 정의 뒤)에:
```rust
const MIGRATION_SQL_0017: &str =
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)";
```
`connect()`의 `sqlx::query(MIGRATION_SQL_0016).execute(&pool).await?;` 바로 뒤에:
```rust
    sqlx::query(MIGRATION_SQL_0017).execute(&pool).await?;
```
같은 파일 `pub mod` 블록에:
```rust
pub mod settings;
```

- [ ] **Step 2: store/settings.rs 작성 (+ 인라인 테스트)**

`crates/controller/src/store/settings.rs` 전체:
```rust
//! `settings` 테이블 raw I/O. 범위 재검증은 여기 아님 — SettingsState::build(§4.1 M3).
use std::collections::HashMap;
use sqlx::Row;
use crate::store::Db;

/// value TEXT→i64. 파싱 실패는 skip+warn(스냅샷 빌더가 범위 재검증).
pub async fn load_overrides(db: &Db) -> sqlx::Result<HashMap<String, i64>> {
    let rows = sqlx::query("SELECT key, value FROM settings").fetch_all(db).await?;
    let mut out = HashMap::new();
    for r in rows {
        let key: String = r.get("key");
        let raw: String = r.get("value");
        match raw.parse::<i64>() {
            Ok(v) => { out.insert(key, v); }
            Err(_) => tracing::warn!(key, value = raw, "settings 오버라이드 파싱 실패 — 무시"),
        }
    }
    Ok(out)
}

pub async fn upsert(db: &Db, key: &str, value: i64, now_ms: i64) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key)
    .bind(value.to_string())
    .bind(now_ms)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn delete(db: &Db, key: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM settings WHERE key = ?").bind(key).execute(db).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;

    #[tokio::test]
    async fn upsert_load_delete_roundtrip() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        assert!(load_overrides(&db).await.unwrap().is_empty());
        upsert(&db, "max_data_bindings", 20, 1).await.unwrap();
        upsert(&db, "max_data_bindings", 30, 2).await.unwrap();   // 멱등 upsert
        let m = load_overrides(&db).await.unwrap();
        assert_eq!(m.get("max_data_bindings"), Some(&30));
        delete(&db, "max_data_bindings").await.unwrap();
        assert!(load_overrides(&db).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn migration_0017_is_idempotent() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        // connect()가 이미 0017 실행 → 두 번째 connect로 같은 풀이 아닌 새 풀이지만
        // CREATE IF NOT EXISTS라 재실행 무해. 같은 풀 재마이그레이션 가드는 connect 내부.
        sqlx::query(super::super::MIGRATION_SQL_0017).execute(&db).await.unwrap();
        upsert(&db, "x", 1, 1).await.unwrap(); // 테이블 존재 확인
    }
}
```
> `store::connect`/`Db` 시그니처는 기존 `store/mod.rs` 참고(인메모리 URL `sqlite::memory:`은 기존 store 테스트 패턴). `MIGRATION_SQL_0017`이 `mod.rs` private const면 테스트에서 `pub(crate)`로 올리거나 멱등 테스트는 `store::connect` 두 번 호출로 대체. `now_ms`는 호출자(REST)가 기존 헬퍼로 전달 — 저장소는 받기만.

- [ ] **Step 3: 빌드 + 테스트**

Run: `cargo test -p handicap-controller store::settings 2>&1 | tail -20`
Expected: 2 PASS. (`grep -c "MIGRATION_SQL_0017" crates/controller/src/store/mod.rs` = const 1 + execute 1 = 2 — R8 교차검증.)

- [ ] **Step 4: 커밋**

```bash
git add crates/controller/src/store/settings.rs crates/controller/src/store/mod.rs
git commit -m "feat(store): settings 오버라이드 테이블 + migration 0017 (R8/R3)"
```

---

## Task 3: AppState 교체 + 결정 지점 배선 + coord 정리 (가장 큰 컴파일러-driven 커밋)

**Files:**
- Modify: `crates/controller/src/app.rs`(AppState), `crates/controller/src/main.rs`(빌드/배선), `crates/controller/src/grpc/coordinator.rs`(필드/메서드 제거), `crates/controller/src/api/runs.rs`(6 결정 지점 + state_with + 단위테스트), `crates/controller/src/api/test_runs.rs`(State 추가), `crates/controller/src/schedule/runner.rs`(fixture), `crates/controller/src/dispatcher/k8s_spec.rs`(주석), `crates/controller/tests/multi_worker_fanout_e2e.rs`(boot), `crates/controller/tests/data_binding_api_test.rs`(:220), 그 외 ~42 AppState literal 사이트(컴파일러-driven).

**충족 R**: R5(byte-identical), R6(6 결정지점 강제), N1/N2/N3.

- [ ] **Step 1: AppState 필드 교체 (app.rs)**

`crates/controller/src/app.rs`의 `AppState`:
```rust
#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub coord: CoordinatorState,
    pub dispatcher: SharedDispatcher,
    pub ui_dir: Option<PathBuf>,
    pub settings: crate::settings::SettingsState,   // dataset_max_rows: u64 대체
    pub scheduler_tz: chrono_tz::Tz,
}
```
기존 `pub dataset_max_rows: u64` 줄 + 그 doc 주석 삭제.

- [ ] **Step 2: coord에서 capacity 권위 제거 (coordinator.rs)**

`crates/controller/src/grpc/coordinator.rs`:
- `pub worker_capacity_vus: u32` 필드 삭제(:130).
- `pub fn worker_count_for(&self, total_vus: u32) -> u32 { … }`(:153-154) 메서드 삭제.
- `pub fn with_capacity(db: Db, worker_capacity_vus: u32) -> Self`(:143) → capacity 인자 제거하거나 무시. **권장: `with_capacity` 제거하고 `new(db)`만 남김**(capacity는 이제 settings 권위). 호출부(main.rs:102, 테스트들)가 `new(db)`로 수렴.
- **import 정리(필수)**: `worker_count_for` 제거로 `coordinator.rs:22`의 `use crate::grpc::shard::{shard_split, worker_count};`에서 **`worker_count`가 미사용 → clippy `-D warnings` Task 3 게이트 실패**. `use crate::grpc::shard::shard_split;`로 트림.
- `DEFAULT_WORKER_CAPACITY_VUS`(:30) const는 **유지**(settings.rs가 시드 default로 참조 → dead 아님).

- [ ] **Step 3: 6 결정 지점 배선 (runs.rs / test_runs.rs)**

`crates/controller/src/api/runs.rs`:
- `:470` `(meta.row_count as u64) > state.dataset_max_rows` → `… > state.settings.dataset_max_rows()`.
- `:191` 리터럴 `64` 및 에러 문구 → `let cap = state.settings.max_open_loop_worker_count(); if w == 0 || w > cap { … format!("worker_count must be between 1 and {cap}") }`.
- `:397` `const MAX_BINDINGS: usize = 8;` 제거 → `let max_bindings = state.settings.max_data_bindings();` 후 `bindings.len() > max_bindings` 비교(에러 문구도 `{max_bindings}`).
- `:42` `loop_cap_ok(cap)` → 자유함수를 `fn loop_cap_ok(cap: u32, max: u32) -> bool { cap <= max }`로 인자화. 호출부(runs.rs:370 `validate_run_config` 내, `state` 보유)가 `loop_cap_ok(cap, state.settings.max_loop_breakdown_cap())`. **단위테스트 `validates_loop_breakdown_cap_bounds`(:947)도 새 시그니처로 함께 수정**(N3, 같은 커밋).
- **capacity 3 사이트(N1/C1)**:
  - `:237` `let capacity = state.coord.worker_capacity_vus;` → `let capacity = state.settings.worker_capacity_vus();`(curve stage 검증, 이하 비교 동일).
  - `:425` `state.coord.worker_count_for(profile.vus)` → `crate::grpc::shard::worker_count(profile.vus, state.settings.worker_capacity_vus())`.
  - `:603` `state.coord.worker_count_for(profile.vus)` → 동일 치환.

`crates/controller/src/api/test_runs.rs`:
- 핸들러 시그니처 `pub async fn create(Json(body): Json<TestRunRequest>)` → `pub async fn create(State(state): State<crate::app::AppState>, Json(body): Json<TestRunRequest>)`(axum 추출기 순서: State 먼저). `use axum::extract::State;` 추가.
- `:38` 기존 `body.max_requests < 1 || body.max_requests > MAX_MAX_REQUESTS` → **`< 1` 하한은 유지**하고 상한만 `> state.settings.max_test_run_requests()`로(즉 `body.max_requests < 1 || body.max_requests > state.settings.max_test_run_requests()`). `MAX_MAX_REQUESTS` const는 제거(시드는 settings.rs default 10_000이 소유 — 중복 제거). 거부는 기존 `ApiError::Unprocessable`(422) 유지.

`crates/controller/src/dispatcher/k8s_spec.rs:20`: 주석 "N from `CoordinatorState::worker_count_for`" → "N from `shard::worker_count` (capacity는 settings)".

- [ ] **Step 4: main.rs startup 배선**

`crates/controller/src/main.rs`:
- coord 생성: `CoordinatorState::with_capacity(db.clone(), args.worker_capacity_vus)`(:102) → `CoordinatorState::new(db.clone())`.
- AppState 빌드 전에:
```rust
    let overrides = handicap_controller::store::settings::load_overrides(&db).await?;
    let settings = handicap_controller::settings::SettingsState::build(
        &overrides,
        &[
            ("worker_capacity_vus", args.worker_capacity_vus as i64),
            ("dataset_max_rows", args.dataset_max_rows as i64),
            ("scheduler_tick_seconds", args.scheduler_tick_seconds as i64),
        ],
    );
```
- AppState literal(:133)에서 `dataset_max_rows: args.dataset_max_rows` 줄 → `settings,`.
- `--worker-capacity-vus`·`--dataset-max-rows` CLI arg는 **유지**(시드 소스 = byte-identical R5). `args.worker_capacity_vus`가 coord로 안 가도 settings 시드로 감.

- [ ] **Step 5: 테스트 seam + fixture 일괄 (N1/FR2)**

- `crates/controller/src/api/runs.rs`의 `state_with(db, capacity)`(:966): coord를 `new(db)`로, AppState `settings: SettingsState::seeded_for_test_with(&[("worker_capacity_vus", capacity)])`로. (호출자 전부 이 헬퍼 경유 — `unique_*`:1020/:1250가 cap=1·vus=2→N=2 그대로.)
- `crates/controller/src/schedule/runner.rs:278` fixture(`test_state`): `dataset_max_rows: 1_000_000` → `settings: SettingsState::seeded_for_test()`.
- `crates/controller/tests/multi_worker_fanout_e2e.rs`: **(이 task에서 가장 위험한 편집 — 신중히)** `boot()`(`fn boot(` 선언 :51)가 capacity-시드된 `SettingsState`를 받도록 시그니처 추가(예 `boot(db, coord, settings)`) 또는 boot 내부에서 `seeded_for_test_with`로 capacity 받기. 권위가 coord→settings로 옮겨가도 N=2는 REST `create`가 `AppState.settings.worker_capacity_vus()=1`을 runs.rs:603에서 읽어 `coord.enqueue(2)` → 공유 `coord` clone으로 gRPC 측 가시(spec §4.4 검증됨). `with_capacity(db,1)` 4곳(:105/:198/:309/:570)은 `CoordinatorState::new(db)` + `seeded_for_test_with(&[("worker_capacity_vus", 1)])`. (:442 capacity 2000 = default → `seeded_for_test()` 또는 명시 2000.) **Step 7 후 `two_worker_fanout_completes` 단독 재실행으로 N=2 흐름 확인 필수.**
- `crates/controller/tests/data_binding_api_test.rs:220`: `CoordinatorState::with_capacity(db.clone(), 1)` + 직접 AppState 리터럴 → `new(db)` + `settings: SettingsState::seeded_for_test_with(&[("worker_capacity_vus", 1)])`(N=2 유지, rows1<N2→400·"워커").
- **나머지 ~42 AppState literal**: `grep -rn "AppState {" crates/controller/{src,tests}`로 전부 찾아 `dataset_max_rows: …` 줄 → `settings: SettingsState::seeded_for_test()`(capacity 기본 2000). 컴파일러가 missing-field로 강제.

- [ ] **Step 6: R6 회귀 테스트 추가 (capacity 일관성)**

`crates/controller/src/api/runs.rs` 인라인 테스트:
```rust
#[tokio::test]
async fn lowered_capacity_settings_enforced_at_validation_and_dispatch() {
    // cap=2, vus=3 → N=ceil(3/2)=2. closed-loop curve가 cap 초과 stage면 거부.
    // (구체 단언: validate_run_config가 새 capacity로 N을 산출하는지 = state_with seam.)
    let db = store::connect("sqlite::memory:").await.unwrap();
    let state = state_with(db, 2); // seeded_for_test_with(worker_capacity_vus=2)
    // vu_curve stage target > 2 인 closed+curve run → 400 (runs.rs:237 경로)
    // …기존 vu_curve 검증 테스트 패턴 차용해 stage target 3으로 BadRequest 단언.
}
```
> 실제 단언은 기존 vu_curve/dispatch 테스트(`grep "vu_stages\|worker_count_for" crates/controller/src/api/runs.rs`)의 픽스처를 재사용. 핵심: capacity가 settings에서 오고 3 사이트 일관.

- [ ] **Step 7: 전체 빌드 + 테스트 (byte-identical 회귀 = R5)**

Run: `cargo build -p handicap-worker && cargo build --workspace --tests 2>&1 | tail -20`
Expected: 0 errors(missing-field 전부 해소).
Run: `cargo nextest run -p handicap-controller 2>&1 | tail -30`
Expected: 기존 run-create/test-run/preset/schedule/fanout/unique 테스트 전부 GREEN(R5) + 새 회귀 PASS.

- [ ] **Step 8: 커밋**

```bash
git add crates/controller/
git commit -m "refactor(controller): op-config 상한을 SettingsState로 — 6 결정지점 + capacity 단일권위 (R5/R6)"
```

---

## Task 4: REST `/api/settings` (api/settings.rs + 라우트)

**Files:**
- Create: `crates/controller/src/api/settings.rs`
- Modify: `crates/controller/src/app.rs`(라우트 3개), `crates/controller/src/api/mod.rs`(또는 lib) `pub mod settings;`
- Test: `crates/controller/tests/settings_api_test.rs`

**충족 R**: R1(GET), R2(PUT 검증/400), R3(DELETE 204).

- [ ] **Step 1: api/settings.rs 작성**

`crates/controller/src/api/settings.rs`:
```rust
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::app::AppState;
use crate::error::ApiError;
use crate::settings::{self, Group};

#[derive(Serialize)]
pub struct SettingDto {
    pub key: String,
    pub label: String,
    pub group: Group,
    pub value: i64,
    pub default: i64,
    pub min: i64,
    pub max: i64,
    pub unit: String,
    pub mutable: bool,
    pub source: String,
}

#[derive(Serialize)]
pub struct SettingsResponse { pub settings: Vec<SettingDto> }

#[derive(Deserialize)]
pub struct PutBody { pub value: i64 }

pub async fn list(State(state): State<AppState>) -> Json<SettingsResponse> {
    let settings = state.settings.view().into_iter().map(|v| SettingDto {
        key: v.def.key.to_string(), label: v.def.label.to_string(), group: v.def.group,
        value: v.value, default: v.default, min: v.def.min, max: v.def.max,
        unit: v.def.unit.to_string(), mutable: v.def.mutable, source: v.source.to_string(),
    }).collect();
    Json(SettingsResponse { settings })
}

pub async fn put(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(body): Json<PutBody>,
) -> Result<Json<SettingDto>, ApiError> {
    settings::validate(&key, body.value).map_err(ApiError::BadRequest)?;
    // &'static str 키 확보(레지스트리에서).
    let def = settings::def(&key).expect("validate passed");
    // sqlx::Error는 ApiError::Db(#[from])로 500 매핑 — bare `?`(ApiError::Internal은 anyhow::Error라 .to_string() 불가).
    crate::store::settings::upsert(&state.db, def.key, body.value, crate::store::now_ms()).await?;
    state.settings.apply_override(def.key, body.value);
    let dto = one_dto(&state, def.key);
    Ok(Json(dto))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<StatusCode, ApiError> {
    let def = settings::def(&key).ok_or_else(|| ApiError::BadRequest(format!("알 수 없는 설정 키: {key}")))?;
    if !def.mutable { return Err(ApiError::BadRequest(format!("'{}'은(는) 변경할 수 없습니다", def.label))); }
    crate::store::settings::delete(&state.db, def.key).await?;   // sqlx::Error → ApiError::Db(500), bare `?`
    state.settings.revert(def.key);
    Ok(StatusCode::NO_CONTENT)
}

fn one_dto(state: &AppState, key: &str) -> SettingDto {
    let v = state.settings.view().into_iter().find(|v| v.def.key == key).expect("key");
    SettingDto {
        key: v.def.key.to_string(), label: v.def.label.to_string(), group: v.def.group,
        value: v.value, default: v.default, min: v.def.min, max: v.def.max,
        unit: v.def.unit.to_string(), mutable: v.def.mutable, source: v.source.to_string(),
    }
}
```
> `ApiError` 변형명(`BadRequest`/`Internal`)·`now_ms` 헬퍼명은 기존 `error.rs`/`store`에서 확인해 정확히 맞춤(상이하면 그에 맞게). `api/mod.rs`에 `pub mod settings;` 등록.

- [ ] **Step 2: app.rs 라우트 등록**

`crates/controller/src/app.rs`의 `/api` router 빌드부에(environments 라우트 근처):
```rust
        .route("/settings", get(settings_api::list))
        .route("/settings/{key}", put(settings_api::put).delete(settings_api::delete))
```
`use crate::api::settings as settings_api;` 추가. **`app.rs:5`의 `use axum::routing::{get, post};` → `{get, post, put}`로 `put` 추가**(현재 `put` 없음 — `delete`는 `put(...).delete(...)` 체인 메서드라 import 불요).

- [ ] **Step 3: 통합 테스트**

`crates/controller/tests/settings_api_test.rs`:
```rust
// make_app 패턴은 기존 api_test.rs/environments 테스트 차용(NoopDispatcher + seeded settings).
// 검증: GET 레지스트리 행 + PUT 200/400(범위·비가변·미지키) + DELETE 204 revert + cap 강제.
```
구체 케이스(기존 `tests/environments_*` 또는 `api_test.rs`의 `make_app`/`TestApp` 헬퍼 재사용):
```rust
#[tokio::test]
async fn get_returns_registry_rows() { /* GET /api/settings → settings[] 에 worker_capacity_vus·trace_body_cap_bytes 존재, mutable 플래그 */ }
#[tokio::test]
async fn put_valid_then_get_reflects() { /* PUT max_data_bindings=20 → 200, GET value=20 source=override */ }
#[tokio::test]
async fn put_out_of_range_400() { /* PUT max_data_bindings=999 → 400 */ }
#[tokio::test]
async fn put_immutable_400() { /* PUT trace_body_cap_bytes=5 → 400 */ }
#[tokio::test]
async fn put_unknown_key_400() { /* PUT nope=5 → 400 */ }
#[tokio::test]
async fn delete_reverts_default() { /* PUT then DELETE → 204, GET value=default source=default */ }
#[tokio::test]
async fn lowered_worker_count_cap_enforced_on_run() { /* PUT max_open_loop_worker_count=2 → open-loop run worker_count=3 = 400 */ }
```
> 각 케이스는 `axum::body`/`tower::ServiceExt::oneshot` 또는 기존 테스트의 request 헬퍼로 구현(환경/시나리오 테스트 패턴 동일). `make_app`은 `SettingsState::seeded_for_test()`로 AppState 구성(이미 Task 3에서 helper 존재).

- [ ] **Step 4: 빌드 + 테스트 + 커밋**

Run: `cargo nextest run -p handicap-controller settings_api 2>&1 | tail -20` → 7 PASS.
```bash
git add crates/controller/
git commit -m "feat(api): GET/PUT/DELETE /api/settings (R1/R2/R3)"
```

---

## Task 5: UI — `/settings` 페이지 (client+Zod, SettingsPage, ko.ts, 라우트/nav)

**Files:**
- Modify: `ui/src/lib/api.ts`(또는 `client.ts`) — Zod + 3 클라 fn.
- Create: `ui/src/pages/SettingsPage.tsx`, `ui/src/pages/__tests__/SettingsPage.test.tsx`.
- Modify: `ui/src/routes.tsx`(라우트), `ui/src/i18n/ko.ts`(`ko.opsSettings`), nav 컴포넌트(링크).

**충족 R**: R1(Zod 수용), R9(섹션·설명·HelpTip·저장/복원), R11(범위 가드), R12(후속 run 안내).

- [ ] **Step 1: Zod + 클라 fn — 신규 `ui/src/api/settings.ts` (environments.ts 미러)**

> **파일 위치 정정**: 클라이언트는 도메인별 `ui/src/api/<domain>.ts` 컨벤션. `environments.ts`를 미러 — **plain `fetch` + 로컬 `errorMessage` 헬퍼 + `const BASE = "/api"`**(호출자는 `/settings` 전달, `/api`는 BASE가 붙임). `ui/src/lib/`·`client.ts`엔 environments fn이 없으니 거기 두지 말 것. `errorMessage`/`BASE` 시그니처는 `ui/src/api/environments.ts`에서 정확히 복사.

`ui/src/api/settings.ts`:
```ts
import { z } from "zod";
// errorMessage 헬퍼는 environments.ts와 동일 패턴(import 또는 로컬 복제 — 그 파일 따라).
const BASE = "/api";

export const SettingSchema = z.object({
  key: z.string(),
  label: z.string(),
  group: z.enum(["limits", "test_run", "scheduler"]),
  value: z.number(),
  default: z.number(),
  min: z.number(),
  max: z.number(),
  unit: z.string(),
  mutable: z.boolean(),
  source: z.enum(["override", "default", "readonly"]),
}).strict();
export type Setting = z.infer<typeof SettingSchema>;
const SettingsResponse = z.object({ settings: z.array(SettingSchema) }).strict();

export async function getSettings(): Promise<Setting[]> {
  const r = await fetch(`${BASE}/settings`);
  if (!r.ok) throw new Error(await errorMessage(r));
  return SettingsResponse.parse(await r.json()).settings;
}
export async function putSetting(key: string, value: number): Promise<Setting> {
  const r = await fetch(`${BASE}/settings/${key}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });
  if (!r.ok) throw new Error(await errorMessage(r));
  return SettingSchema.parse(await r.json());
}
export async function deleteSetting(key: string): Promise<void> {
  const r = await fetch(`${BASE}/settings/${key}`, { method: "DELETE" });
  if (!r.ok && r.status !== 204) throw new Error(await errorMessage(r));
}
```
> `.strict()`는 서버 `SettingDto`와 1:1(R1 seam) — 키 추가/누락 시 즉시 깨짐. `errorMessage`는 environments.ts가 쓰는 그 헬퍼 **단일-인자** `(res: Response): Promise<string>` 그대로(서버 `{error}` 본문 파싱). 2-인자로 부르지 말 것.

- [ ] **Step 1b: React Query 훅 (`ui/src/api/hooks.ts`)**

기존 `hooks.ts` 컨벤션대로 추가:
```ts
export const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: getSettings });
export const usePutSetting = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ key, value }: { key: string; value: number }) => putSetting(key, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }) });
};
export const useResetSetting = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (key: string) => deleteSetting(key),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }) });
};
```
> import 경로·`useQuery`/`useMutation` 시그니처는 기존 `hooks.ts`의 environments 훅을 그대로 미러(React Query v5 객체-인자 형태).

- [ ] **Step 2: ko.ts 카탈로그**

`ui/src/i18n/ko.ts`에 `opsSettings` 추가(설명 = spec §4.6 카피):
```ts
opsSettings: {
  title: "운영 상한",
  mutableSection: "조정 가능한 운영 상한",
  readonlySection: "배포 설정 (읽기 전용)",
  applyNote: "여기서 바꾼 값은 다음에 시작하는 run부터 적용됩니다(진행 중인 run엔 영향 없음).",
  save: "저장", reset: "기본값 복원",
  rangeHint: (min: number, max: number) => `허용 범위 ${min}~${max}`,
  defaultHint: (d: number | string) => `기본값 ${d}`,
  readonlyNote: "Helm/CLI 배포 설정으로 변경",
  outOfRange: "허용 범위를 벗어났습니다",
  desc: {
    worker_capacity_vus: "워커 한 대가 맡는 가상 사용자(VU) 수. 컨트롤러가 \"필요 워커 수 = 올림(총 VU ÷ 이 값)\"으로 몇 대 띄울지 계산합니다.",
    dataset_max_rows: "데이터셋을 \"반복마다\" 바인딩할 때 워커로 보낼 수 있는 최대 행 수. 워커 메모리를 지킵니다(VU별 바인딩은 미적용).",
    max_open_loop_worker_count: "열린 루프(도착률) run에서 지정 가능한 워커 수의 최댓값.",
    max_data_bindings: "한 run에 동시에 붙일 수 있는 독립 데이터셋 바인딩 개수.",
    max_loop_breakdown_cap: "loop 노드 메트릭을 \"회차별로\" 몇 개까지 집계할지 정하는 run 설정값의 허용 상한. 초과 회차는 \"상한 초과\" 한 칸으로 합쳐집니다.",
    max_test_run_requests: "에디터 \"미리 1회 실행\"이 한 번에 보낼 수 있는 최대 요청 수.",
    trace_body_cap_bytes: "테스트 실행 시 응답 본문을 최대 몇 바이트까지 보관할지(초과분 잘림).",
    scheduler_tick_seconds: "예약된 run을 얼마나 자주 점검할지(초).",
  },
  effect: {
    worker_capacity_vus: "⬆ 올리면 워커 한 대에 VU를 더 몰아 워커 수가 줄어듭니다(자원 절약). 너무 높이면 한 대가 과부하돼 부하 생성이 부정확해집니다.\n⬇ 내리면 워커를 더 많이 띄웁니다(분산↑·정확도↑). 대신 K8s Pod·프로세스가 늘어 클러스터 자원을 더 씁니다.",
    dataset_max_rows: "⬆ 올리면 더 큰 데이터셋을 반복 바인딩에 쓸 수 있습니다. 대신 워커 메모리 사용량이 커져 OOM 위험이 늘어납니다.\n⬇ 내리면 메모리는 안전하지만, 행이 많은 데이터셋 run은 \"행 수 초과\"로 거부됩니다.",
    max_open_loop_worker_count: "⬆ 올리면 매우 높은 목표 RPS를 더 많은 워커로 분산할 수 있습니다. 대신 한 번에 많은 워커 Pod가 떠 클러스터를 압박합니다.\n⬇ 내리면 안전하지만, 아주 높은 목표 RPS를 워커가 못 따라가 포화(요청 누락)될 수 있습니다.",
    max_data_bindings: "⬆ 올리면 더 복잡한 다중 데이터셋 시나리오가 가능합니다. 대신 워커의 다중 스트림 관리 부담이 커집니다.\n⬇ 내리면 단순·가볍지만, 바인딩이 많은 run은 거부됩니다.",
    max_loop_breakdown_cap: "⬆ 올리면 반복이 많은 loop도 회차별로 세밀히 볼 수 있습니다. 대신 저장·리포트 행(메트릭 양)이 늘어납니다.\n⬇ 내리면 메트릭은 가벼워지지만, 회차별 분해 해상도가 줄어듭니다.",
    max_test_run_requests: "⬆ 올리면 더 긴 시나리오를 미리 끝까지 실행해볼 수 있습니다. 대신 미리보기가 느려지고 대상 서버에 요청이 더 갑니다.\n⬇ 내리면 빠르고 가볍지만, 긴 시나리오는 앞부분까지만 미리 실행됩니다.",
  },
},
```

- [ ] **Step 3: SettingsPage.tsx**

`ui/src/pages/SettingsPage.tsx`(EnvironmentsPage 구조 미러 — React Query 훅 + 섹션 2개). 핵심 동작:
```tsx
// const { data: settings } = useSettings();  const putM = usePutSetting();  const resetM = useResetSetting();
// settings.filter(s=>s.mutable) → 편집 행 / .filter(s=>!s.mutable) → 읽기전용 행.
// 편집 행: 라벨 + ko.opsSettings.desc[s.key](항상보임) + <HelpTip>{effectBlocks(s.key)}</HelpTip>
//   + number input(draft state) + defaultHint/rangeHint + [저장](범위밖이면 disabled, R11) + [기본값 복원](s.source==="override"일 때만)
// 저장 = putM.mutate({key,value}); 복원 = resetM.mutate(key). (훅이 invalidate 처리.)
// 상단 applyNote(R12). 섹션 제목 mutableSection/readonlySection. 읽기전용 행은 값+단위 + readonlyNote.
```
완전 구현(요지 — 실제 코드는 EnvironmentsPage의 list/mutation/레이아웃 관용구를 따름):
- `const [drafts, setDrafts] = useState<Record<string, string>>({})` 로 행별 입력 버퍼(초기 = 현재 value).
- `const invalid = (s, draft) => { const n = Number(draft); return draft==="" || !Number.isInteger(n) || n < s.min || n > s.max; }` → 저장 disabled + `outOfRange` 안내(R11).
- **HelpTip 멀티라인(MUST — `\n` 붕괴 회피)**: `HelpTip`은 children을 inline `<span>`에 렌더라 리터럴 `\n`이 한 줄로 뭉친다(`HelpTip.tsx:30`, ui/CLAUDE.md). effect를 줄로 쪼개 블록으로:
```tsx
const effectBlocks = (key: string) =>
  ko.opsSettings.effect[key].split("\n").map((line, i) => (
    <span key={i} className="block">{line}</span>
  ));
```
- 저장 성공 토스트/에러 배너는 기존 페이지 패턴.

- [ ] **Step 4: 라우트 + nav**

- `ui/src/routes.tsx`: `"/"` 부모 라우트 children 배열에 **`{ path: "settings", element: <SettingsPage /> }`**(leading slash 없음 — environments 항목과 동일 형태) 추가. breadcrumb 패턴 동일.
- **`ko.ts`에 `ko.nav.settings: "운영 상한"` 추가**(Layout이 `ko.nav.*` 사용, `Layout.tsx:104-109`) — `ko.opsSettings.title` 아님.
- `ui/src/components/Layout.tsx`의 nav 링크 목록(environments 링크 근처)에 `to="/settings"` + `ko.nav.settings` 링크 추가.
- (`ko.test.ts:50` nav 키 리스트는 "잉여 키 허용"이라 새 키로 안 깨짐 — 확인.)

- [ ] **Step 5: RTL (SettingsPage.test.tsx)**

```tsx
// MSW 또는 fetch mock으로 getSettings fixture(가변+읽기전용 행) 제공.
// 케이스:
// 1) 두 섹션 렌더 + 가변 행에 desc 텍스트 존재 + 읽기전용 행에 readonlyNote.
// 2) 입력 편집 → 저장 클릭 → putSetting 호출(key,value).
// 3) override 행에서 기본값 복원 클릭 → deleteSetting 호출.
// 4) 범위 밖 값 입력 → 저장 버튼 disabled + outOfRange 안내(R11).
// 5) HelpTip(ⓘ) 열면 effect 텍스트 노출.
```
> fixture는 서버가 실제 보내는 `source:"readonly"`·`mutable:false` 등 **모든 필드 포함**(S-D 갭 — absent-not-null 회피; `SettingSchema.parse`가 통과해야 함).

- [ ] **Step 6: UI 게이트 + 커밋**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/ops-config-admin/ui && pnpm lint && pnpm test && pnpm build 2>&1 | tail -20`
Expected: lint 0 경고, RTL PASS, `tsc -b` clean.
```bash
git add ui/
git commit -m "feat(ui): /settings 운영 상한 관리 화면 (R9/R11/R12)"
```

---

## Task 6: 라이브 검증 + 최종 리뷰 + 마무리 (process)

- [ ] **Step 1: 라이브 검증 (`/live-verify`)** — spec §6 필수(새 `/api/settings` Zod 파싱 = S-D 갭). 워크트리 자체 바이너리로 controller+worker 기동 → ① `GET /api/settings` 응답이 UI `SettingsResponse.parse` 통과(브라우저 콘솔 Zod 0) ② `PUT /api/settings/max_open_loop_worker_count {value:2}` → open-loop `worker_count:3` run = 400(R6 강제) ③ `DELETE` 복원 후 통과 ④ readonly PUT = 400.
- [ ] **Step 2: `handicap-reviewer`** — 와이어 1:1(SettingDto serde ↔ Zod `.strict()`)·byte-identical(R5)·capacity 3-사이트·migration 0017 const/execute·deferral(§7) 검증.
- [ ] **Step 3: `/finish-slice`** — build-log 단락 + roadmap §B2'' "운영 상한 관리자 화면" 완료 이동(option-2 연기 누적) + 루트 CLAUDE 상태줄 교체 + 메모리 + ff-merge + ExitWorktree.

---

## Self-Review 결과 (작성자 체크)

- **Spec 커버리지**: R1→Task4·Task5Step1 / R2→Task1(validate)·Task4 / R3→Task2·Task4 / R4→Task1 / R5→Task3Step7 / R6→Task3Step3·6 / R7→Task1 / R8→Task2 / R9→Task5 / R10(엔진 무변경)→전 task 엔진 미수정 / R11→Task5Step3·5 / R12→Task5Step2(applyNote). 누락 없음.
- **타입 일관성**: `SettingsState`(snap/seeds/readonly)·accessor 6종·`view()`/`SettingView`·`validate`/`def`·`SettingDto`/`SettingSchema` 필드명 task 간 일치(`group` enum snake_case 양쪽, `source` 3-값).
- **Placeholder**: 통합/RTL 케이스는 "기존 헬퍼 재사용" 지시 + 케이스 목록 명시(코드 골격 제공) — 기존 `make_app`/EnvironmentsPage 관용구가 단일 소스라 복붙 대신 참조가 DRY. 결정 지점·레지스트리·store·REST·Zod·ko 카피는 완전 코드.
- **게이트 경계**: Task1·2는 `pub` API라 단독 green / Task3은 컴파일러-driven 단일 커밋 / Task4·5는 와이어 양쪽(함께 머지) / N3 loop_cap_ok 테스트는 같은 커밋 fold.

<!-- spec(4라운드)·plan(2라운드) 모두 spec-plan-reviewer clean APPROVE -->
REVIEW-GATE: APPROVED

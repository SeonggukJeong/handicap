# run-identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** run에 사용자 라벨(`runs.label`) + 자동 설정 요약을 도입해 목록·상세·비교·오버레이·export에서 run을 사람이 구분할 수 있게 한다 (spec: `docs/superpowers/specs/2026-08-09-run-identity-design.md`, 리뷰 3라운드 clean APPROVE).

**Architecture:** 서버(스토어→create/스케줄러/PUT→리포트/export) 먼저, UI(스키마·헬퍼→생성 경로→상세→목록→비교→검색) 나중 — 라벨 와이어가 전 표면의 전제라 phase가 순차다. 표시 폴백은 `runDisplayLabel = label ?? #끝6자` 단일 소스.

**Tech Stack:** Rust(axum·sqlx·rust_xlsxwriter) + React/TS(Zod·React Query·vitest/RTL).

## Global Constraints

- **라벨 규칙**: trim → 빈=None(제거), **문자 수**(`chars().count()`) 200 초과=400. 유니크 강제 없음. 스케줄러 경로만 truncate(`chars().take(200)`) — **바이트 슬라이스 `&s[..200]` 금지**(char-boundary panic).
- **Zod 2종 분기**(spec §5): `RunResponse.label`=plain Option→null→`.nullish()` / `ReportRun.label`=`#[serde(default, skip_serializing_if)]`→absent→`.optional()`. 혼동 금지.
- **byte-identical**: 무라벨 payload에 `label` 키 자체가 없어야 함(조건부 spread — `label: undefined` 금지). 무라벨 run 리포트 JSON 키셋 불변. 기본 URL(파라미터 0) byte-identical.
- **ko 카탈로그**(ADR-0035): 모든 사용자 노출 문구·aria는 `ko.ts` 경유. 신규↔기존 양방향 부분문자열 sweep. `ko.*(n)` 보간 단언엔 렌더 숫자 별도 단언 병기.
- **게이트**: UI task는 커밋 전 `pnpm lint && pnpm test && pnpm build`(전체), Rust task는 pre-commit cargo 게이트. 파이프 금지(`; echo exit=$?`). cargo-영향 커밋은 수 분 — 그동안 다른 cargo 호출 금지.
- **tdd-guard**: 각 task 첫 스텝은 테스트 편집(RED)이다 — production 편집을 먼저 두지 말 것.
- **orchestrator 사전 스텝(Task 1 디스패치 전)**: spec §14 클레임 레저 C1–C28을 **일괄 재실행** — 리뷰어 확인상 mismatch 0이어야 정상, 불일치가 나오면 STOP하고 원인 규명(레저 노이즈 아님).

---

### Task 1: 스토어 계층 — migration 0021 + `RunRow.label` + `insert` 6-param + `update_label`

**Files:**
- Modify: `crates/controller/src/store/mod.rs` (0021 가드 함수 + `connect()` 배선 — `ensure_runs_verdict_json` `:175-187` 미러)
- Modify: `crates/controller/src/store/runs.rs` (`RunRow` `:255-269`·`insert` `:271-310`·`get` `:311+`·목록 SELECT·신규 `update_label`·인라인 테스트)
- Modify (기계적 — `insert` 호출에 `None` 추가): `crates/controller/tests/crash_recovery_test.rs`(5곳) · `tests/export_routes_test.rs`(4곳) · `tests/dispatcher_subprocess_test.rs`(1곳) · `tests/report_test.rs`(1곳) · `src/schedule/runner.rs:404` · `src/grpc/coordinator.rs:1843,1970` · `src/store/schedules.rs:619` · `src/store/runs.rs:692,747`(bare) · `src/api/runs.rs:679`(프로덕션 — 이 task에선 `None`, Task 2가 실값 배선)
- Modify (기계적 — `RunRow` **리터럴**에 `label: None` 추가, 위 호출처 축과 별개): `crates/controller/src/report.rs:997`(`run_row()` 테스트 헬퍼 — Task 4 이전이지만 **이 task 스코프가 맞다**, RunRow 필드 추가가 깨뜨림)

**Interfaces:**
- US: US2·US4·US5의 저장 토대(단독 관찰 US 없음 — 전 task의 전제)
- Produces: `runs::insert(db, scenario_id, scenario_yaml, profile, env, label: Option<&str>) -> sqlx::Result<RunRow>` · `runs::update_label(db, id: &str, label: Option<&str>) -> sqlx::Result<Option<RunRow>>` · `RunRow.label: Option<String>`
- Consumes: 없음 (phase 1 선두)

- [ ] **Step 1: 실패 테스트 작성** — ① `store/runs.rs`의 기존 `#[cfg(test)] mod tests`에 추가. **시나리오 시드와 `Profile` 리터럴 둘 다 이 파일 기존 테스트(`:665-691`)에서 복사할 것** — `scenarios::insert`는 `(db, &Scenario, yaml)` 시그니처라 `serde_yaml::from_str` 선행이 필요하고, `Profile`은 **Default 미구현**이라 전 필드 명시 리터럴이어야 한다(아래 스니펫의 두 표기는 축약 — 실제 형태는 `:665-691` verbatim):

```rust
#[tokio::test]
async fn insert_and_update_label_round_trip() {
    let db = test_db().await;
    let yaml = "version: 1\nname: label-sc\nsteps: []";
    let scenario: Scenario = serde_yaml::from_str(yaml).unwrap(); // :665-667 이디엄
    let sc = scenarios::insert(&db, &scenario, yaml).await.unwrap();
    let profile = /* :670-691의 전-필드 Profile 리터럴 복사 (Default 없음) */;
    // 유라벨 insert → get 왕복
    let run = insert(&db, &sc.id, "y", &profile, &serde_json::json!({}), Some("커넥션 풀 2배 후"))
        .await.unwrap();
    assert_eq!(run.label.as_deref(), Some("커넥션 풀 2배 후"));
    let got = get(&db, &run.id).await.unwrap().unwrap();
    assert_eq!(got.label.as_deref(), Some("커넥션 풀 2배 후"));
    // 무라벨 insert → None
    let bare = insert(&db, &sc.id, "y", &profile, &serde_json::json!({}), None).await.unwrap();
    assert!(get(&db, &bare.id).await.unwrap().unwrap().label.is_none());
    // update_label: 설정 → 교체 → 제거(None) → 미존재 id는 Ok(None)
    let up = update_label(&db, &bare.id, Some("사후 라벨")).await.unwrap().unwrap();
    assert_eq!(up.label.as_deref(), Some("사후 라벨"));
    let cleared = update_label(&db, &bare.id, None).await.unwrap().unwrap();
    assert!(cleared.label.is_none());
    assert!(update_label(&db, "01NOPE", Some("x")).await.unwrap().is_none());
}
```

② `store/mod.rs`의 기존 `mod tests`에 **무조건** 멱등 테스트 추가 — 기존 `ensure_runs_verdict_json_is_idempotent`(`store/mod.rs:435`)를 이름만 바꿔 verbatim 미러(그 테스트의 "FIRST guard call…" 주석이 문서화한 호출-순서 미묘함까지 포함): `ensure_runs_label_is_idempotent` — 가드 2회 호출 후 Ok + 컬럼 존재 확인. 기존 멱등 테스트들(`:337`/`:435`/`:548`/`:610`)은 **`ensure_runs_label`을 실행하지 않으므로 통과 확인으로 대체 불가**(spec §12 의무).

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-controller --lib store::runs 2>&1 | tail -5; echo exit=$?` → `insert` 인자 개수/`update_label` 미정의 컴파일 에러 = RED.
- [ ] **Step 3: 구현** — ① `store/mod.rs`에 0021 가드(+`connect()`에서 `ensure_runs_verdict_json` 배선 직후 호출):

```rust
/// migration 0021: runs.label (nullable). 사용자 run 라벨(run-identity spec §3).
/// verdict_json(0012) 가드와 동형 — pragma로 가드, 별도 .sql 파일 없음.
async fn ensure_runs_label(db: &Db) -> anyhow::Result<()> {
    let has: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name = 'label'")
            .fetch_one(db)
            .await?;
    if has == 0 {
        sqlx::query("ALTER TABLE runs ADD COLUMN label TEXT").execute(db).await?;
    }
    Ok(())
}
```

② `RunRow`에 `pub label: Option<String>,`(verdict 필드 뒤). ③ `insert`: 6번째 파라미터 `label: Option<&str>`, INSERT 컬럼에 `label` 추가(`VALUES(?,?,?,?,?,?,?,?)` + `.bind(label)`), 반환 리터럴에 `label: label.map(str::to_string),`. ④ `get`·목록 쿼리 SELECT에 `label` 추가 + `RunRow` 매핑에 `label: r.get("label"),`. ⑤ `update_label`:

```rust
/// run 라벨 사후 편집(spec §4.3). None = 라벨 제거. 미존재 id → Ok(None) → 호출자 404.
pub async fn update_label(db: &Db, id: &str, label: Option<&str>) -> sqlx::Result<Option<RunRow>> {
    let n = sqlx::query("UPDATE runs SET label = ? WHERE id = ?")
        .bind(label)
        .bind(id)
        .execute(db)
        .await?
        .rows_affected();
    if n == 0 {
        return Ok(None);
    }
    get(db, id).await
}
```

⑥ 위 Files의 **전 호출 사이트에 `None` 부착**(컴파일러가 전부 지적 — `cargo build --workspace --tests`가 0 에러가 될 때까지).

- [ ] **Step 4: GREEN 확인** — `cargo build --workspace --tests 2>&1 | tail -3; echo exit=$?` 후 `cargo test -p handicap-controller --lib 2>&1 | tail -5; echo exit=$?` → PASS(Step 1의 round-trip + 멱등 테스트 둘 다).
- [ ] **Step 5: 커밋** — `git add -A && git commit -m "feat(store): runs.label 컬럼(0021)+insert/update_label"` (cargo 게이트 수 분 — FOREGROUND 600000ms).

### Task 2: create·스케줄러 라벨 관통 — `normalize_label` + `CreateRunRequest.label` + `spawn_run` 7-param + `RunResponse.label`

**Files:**
- Modify: `crates/controller/src/api/runs.rs` (`CreateRunRequest` `:25-30`·`RunResponse` `:33-52`·`spawn_run` `:651`·create 핸들러 `:941-965`·`to_response` `:1256`·신규 `normalize_label`+인라인 테스트)
- Modify: `crates/controller/src/schedule/runner.rs` (`:186` 발사 + `:404` 인라인 테스트 사이트 + `cron_due_fires_and_advances` `:347` 라벨 단언)
- Test: `crates/controller/tests/api_test.rs` (create-with-label 통합)

**Interfaces:**
- US: US2(생성 시 라벨 — 서버 절반)·US5(스케줄 자동 라벨)
- Consumes: Task 1 `runs::insert(…, label)`.
- Produces: `normalize_label(raw: Option<String>) -> Result<Option<String>, String>` · `spawn_run(state, scenario, profile, validated_metas, env, force, label: Option<&str>)` · `RunResponse.label: Option<String>`(plain — None→JSON null) · 스케줄 발사 run은 `label == Some(스케줄이름 trim·200자)`.

- [ ] **Step 1: 실패 테스트 작성** — ① `api/runs.rs` 인라인 `mod tests`에 normalize 표 테스트:

```rust
#[test]
fn normalize_label_table() {
    assert_eq!(normalize_label(None), Ok(None));
    assert_eq!(normalize_label(Some("".into())), Ok(None));
    assert_eq!(normalize_label(Some("  ".into())), Ok(None));
    assert_eq!(normalize_label(Some("  x  ".into())), Ok(Some("x".into())));
    let two_hundred: String = "가".repeat(200);
    assert_eq!(normalize_label(Some(two_hundred.clone())), Ok(Some(two_hundred)));
    assert!(normalize_label(Some("가".repeat(201))).is_err());
}
```

② `runner.rs` `cron_due_fires_and_advances`(`:361-363` — `run.scenario_id` 단언 옆)에 추가: `assert_eq!(run.label.as_deref(), Some("s"));`(insert_sched 헬퍼의 이름이 `"s"` — `:333`). ③ truncate 단위(runner.rs 인라인) — **반드시 프로덕션 헬퍼 `schedule_label`을 호출**할 것(식을 테스트 안에서 재계산하면 자기참조 공허 — [[plan-mandated-vacuous-tests]] 클래스):

```rust
#[test]
fn schedule_label_truncates_korean_without_panic() {
    let name = format!("  {}  ", "라".repeat(300));
    let label = schedule_label(&name); // 300자 한국어: 바이트 슬라이스였다면 panic
    assert_eq!(label.chars().count(), 200);
    assert_eq!(schedule_label("  nightly  "), "nightly"); // trim
}
``` ④ `tests/api_test.rs`에 통합(기존 `create_run` 헬퍼 `:43`과 같은 oneshot 이디엄, `serde_json::json!` body에 `"label": "  통합 라벨  "` 추가) — 201 응답 JSON `label == "통합 라벨"`(trim 확인) + `GET /api/runs/{id}` 재조회 동일 + **무라벨 생성 응답은 `label: null`**.

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-controller 2>&1 | tail -5; echo exit=$?` → 컴파일 에러(필드/함수 미정의) = RED.
- [ ] **Step 3: 구현** — ① `normalize_label`:

```rust
/// run 라벨 정규화(spec §3): trim → 빈=None, 문자 수 200 초과=Err(400 메시지).
/// create·PUT 공유. 스케줄러는 이 함수 대신 truncate(자동 경로는 400 불가).
fn normalize_label(raw: Option<String>) -> Result<Option<String>, String> {
    let Some(s) = raw else { return Ok(None) };
    let t = s.trim();
    if t.is_empty() {
        return Ok(None);
    }
    if t.chars().count() > 200 {
        return Err("라벨은 200자 이하여야 합니다".into());
    }
    Ok(Some(t.to_string()))
}
```

② `CreateRunRequest`에 `#[serde(default)] pub label: Option<String>,`. ③ `RunResponse`에 `pub label: Option<String>,` + `to_response`에 `label: r.label,`. ④ `spawn_run` 7번째 파라미터 `label: Option<&str>` → `runs::insert(…, label)`(Task 1에서 `None`이던 자리). ⑤ create 핸들러: `let label = normalize_label(body.label).map_err(ApiError::BadRequest)?;` 후 `spawn_run(…, q.force, label.as_deref())`. ⑥ `runner.rs`에 헬퍼 + 발사 지점(`:186`) 배선:

```rust
/// 스케줄 이름 → run 자동 라벨(spec §4.2): trim + 문자 수 200 truncate.
/// 자동 경로라 normalize_label(400 반환) 대신 클램프. &s[..200] 바이트 슬라이스 금지(panic).
fn schedule_label(name: &str) -> String {
    name.trim().chars().take(200).collect()
}
```

`let label = schedule_label(&sched.name);` → `spawn_run(…, false, Some(&label))`(빈 이름은 create가 non-empty 강제하므로 실전 None 불가 — `is_empty` 분기는 두지 않는다, YAGNI·create 검증이 상류 가드).

- [ ] **Step 4: GREEN 확인** — `cargo test -p handicap-controller 2>&1 | tail -5; echo exit=$?` → PASS.
- [ ] **Step 5: 커밋** — `git commit -m "feat(api): create/스케줄러 라벨 관통 + RunResponse.label"`.

### Task 3: `PUT /api/runs/{id}/label` 사후 편집 엔드포인트

**Files:**
- Modify: `crates/controller/src/api/runs.rs` (핸들러) · `crates/controller/src/app.rs` (라우트)
- Test: `crates/controller/tests/api_test.rs`

**Interfaces:**
- US: US4(사후 편집 — 서버 절반)
- Consumes: Task 1 `update_label` · Task 2 `normalize_label`·`RunResponse.label`.
- Produces: `PUT /api/runs/{id}/label` body `{"label": string|null}` → 200 `RunResponse` / 404 / 400.

- [ ] **Step 1: 실패 테스트 작성** — `tests/api_test.rs`: run 생성 후 ① `PUT {"label":"사후"}` → 200·응답 `label=="사후"`·GET 재조회 동일 ② `PUT {"label":null}` → 200·`label==null`(제거) ③ `PUT {"label":"가"×201}` → 400 ④ 미존재 id → 404. (oneshot PUT은 기존 abort POST `:96` 이디엄에서 method만 교체.)
- [ ] **Step 2: RED 확인** — 404(라우트 부재)로 FAIL.
- [ ] **Step 3: 구현** —

```rust
#[derive(Debug, serde::Deserialize)]
pub struct UpdateLabelRequest {
    #[serde(default)]
    pub label: Option<String>, // 키 부재·null 동일 = 라벨 제거 (spec §4.3)
}

pub async fn update_label(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateLabelRequest>,
) -> Result<Json<RunResponse>, ApiError> {
    let label = normalize_label(body.label).map_err(ApiError::BadRequest)?;
    let row = runs::update_label(&state.db, &id, label.as_deref())
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row, None)))
}
```

`app.rs`: 기존 `/runs/{id}/abort` 라우트 옆에 `.route("/runs/{id}/label", put(runs_api::update_label))` — **모듈 별칭 주의**: `app.rs:8-13`이 `runs as runs_api`로 임포트한다(`api::runs::` 직접 경로 아님). `put`은 `app.rs:5`에 이미 임포트됨.

- [ ] **Step 4: GREEN 확인** — `cargo test -p handicap-controller --test api_test 2>&1 | tail -5; echo exit=$?` → PASS. 전체 `cargo test -p handicap-controller`도 1회.
- [ ] **Step 5: 커밋** — `git commit -m "feat(api): PUT /api/runs/{id}/label 사후 편집"`.

### Task 4: `ReportRun.label` + 비교 XLSX Runs 시트 label 열

**Files:**
- Modify: `crates/controller/src/report.rs` (`ReportRun` `:55-64`·리터럴 `:949`)
- Modify: `crates/controller/src/export.rs` (픽스처 `:603`·Runs 시트 `:407-425`·라운드트립 테스트 `:901+`)

**Interfaces:**
- US: US1(비교 표면 와이어)·US6(XLSX Runs 시트 label 열)
- Consumes: Task 1 `RunRow.label`.
- Produces: `ReportRun.label: Option<String>`(`#[serde(default, skip_serializing_if = "Option::is_none")]` — 무라벨 absent) · Runs 시트 헤더 `["run_id","label","status","started_at","ended_at","count"]`.

- [ ] **Step 1: 실패 테스트 작성** — ① `report.rs` 인라인: 직렬화 2상태(**무라벨 run 리포트 JSON 키셋 불변**이 회귀 가드):

```rust
#[test]
fn report_run_label_serialization_two_states() {
    let mut rr = ReportRun {
        id: "r".into(), scenario_id: "s".into(), status: "completed".into(),
        profile: serde_json::Value::Null, env: serde_json::Value::Null,
        started_at: None, ended_at: None, created_at: 0, label: None,
    };
    let v = serde_json::to_value(&rr).unwrap();
    assert!(v.get("label").is_none(), "무라벨은 키 자체가 없어야(byte-identical)");
    rr.label = Some("라벨".into());
    assert_eq!(serde_json::to_value(&rr).unwrap()["label"], "라벨");
}
```

② `export.rs` 라운드트립에 **신규** Runs 시트 단언(기존 `comparison_xlsx_roundtrips`는 Summary/Steps만 — spec C28): calamine으로 `Runs` 시트 열어 헤더 6열 정확일치 + 유라벨 run 행 `label` 셀 문자열 + 무라벨 run 행 빈 문자열. 픽스처는 `report_with_steps` 기반 2-run(한쪽 `run.label = Some("기준 라벨")`).

- [ ] **Step 2: RED 확인** — 컴파일 에러(`label` 필드 부재) = RED.
- [ ] **Step 3: 구현** — ① `ReportRun`에 `#[serde(default, skip_serializing_if = "Option::is_none")] pub label: Option<String>,`. ② `report.rs:949` 리터럴에 `label: run.label.clone(),`. ③ `export.rs:603` 픽스처에 `label: None,`. ④ Runs 시트: 헤더 배열에 `"label"` 2번째 삽입 + 행 쓰기에 `ws.write_string(row, 1, r.run.label.as_deref().unwrap_or("")).expect("w");` — **뒤 열들 인덱스 +1**(status→2, started→3, ended→4, count→5).
- [ ] **Step 4: GREEN 확인** — `cargo test -p handicap-controller 2>&1 | tail -5; echo exit=$?` → PASS(골든 fixture `golden_summary_deltas_match` 포함 — `#[serde(default)]`라 무변경 통과가 곧 하위호환 증명).
- [ ] **Step 5: 커밋** — `git commit -m "feat(report/export): ReportRun.label + Runs 시트 label 열"`.

### Task 5: UI 스키마·표시 헬퍼 — `RunSchema.label`·`ReportRunSchema.label`·`runDisplayLabel`·`profileSummary` + ko

**Files:**
- Modify: `ui/src/api/schemas.ts` (`RunSchema` `:194-216`·`ReportRunSchema` `:379-390`)
- Modify: `ui/src/compare/runLabel.ts` · Create: `ui/src/runs/profileSummary.ts`
- Modify: `ui/src/i18n/ko.ts` (summary 템플릿 4종)
- Test: `ui/src/compare/__tests__/runLabel.test.ts`(신규) · `ui/src/runs/__tests__/profileSummary.test.ts`(신규) · 기존 스키마 파싱 테스트 파일이 있으면 거기, 없으면 `ui/src/api/__tests__/schemas.label.test.ts`(신규)

**Interfaces:**
- US: US1~US6 공통 토대(스키마 파싱·표시 폴백·설정 요약)
- Consumes: Task 2·4 와이어.
- Produces: `RunSchema.label: z.string().nullish()` · `ReportRunSchema.label: z.string().optional()` · `runDisplayLabel(id: string, label?: string | null): string` · `profileSummary(p: Pick<Profile, "vus" | "target_rps" | "stages" | "vu_stages" | "duration_seconds">): string` · `ko.runSummary.{closedFixed(vus,s), closedCurve(peak,s), openFixed(rps,s), openCurve(peak,s)}`.

- [ ] **Step 1: 실패 테스트 작성** — ① `runLabel.test.ts`: `runDisplayLabel("01ABCDEF", "내 라벨")==="내 라벨"` / `runDisplayLabel("01ABCDEF", null)==="#ABCDEF"` / `"  "`(공백 라벨)→`#끝6자` 폴백 / `runShortLabel` 기존 동작 불변. ② `profileSummary.test.ts` 모드 4종(각각 렌더 숫자 포함 단언 — `ko.*(n)` 자기참조 공허 방지):

```ts
it("closed+fixed", () => {
  const s = profileSummary({ vus: 20, duration_seconds: 60 });
  expect(s).toBe(ko.runSummary.closedFixed(20, 60));
  expect(s).toContain("20");
  expect(s).toContain("60");
});
it("closed+curve는 피크", () => {
  const s = profileSummary({
    vus: 0, duration_seconds: 0,
    vu_stages: [{ target: 10, duration_seconds: 30 }, { target: 50, duration_seconds: 30 }],
  });
  expect(s).toBe(ko.runSummary.closedCurve(50, 60));
});
// open+fixed(target_rps=100·duration 45) / open+curve(stages 피크 150) 동형 2건
```

③ 스키마: `RunSchema.parse`가 `label: null`·`label: "x"`·absent 전부 통과, `ReportRunSchema.parse`가 absent·`"x"` 통과(**`.strict()`라 이 키 추가 전엔 present가 fail — RED 신호**).

- [ ] **Step 2: RED 확인** — `pnpm test runLabel; echo exit=$?` 등 → 미정의/strict 거부 FAIL.
- [ ] **Step 3: 구현** — ① `RunSchema`에 `label: z.string().nullish(),`(서버 plain Option — null 옴), `ReportRunSchema`에 `label: z.string().optional(),`(skip_serializing_if — absent만). ② `runLabel.ts`:

```ts
/** 표시 폴백 단일 소스(run-identity spec §7): 라벨 있으면 라벨, 없으면 #끝6자. */
export function runDisplayLabel(id: string, label?: string | null): string {
  return label?.trim() ? label : runShortLabel(id);
}
```

③ `profileSummary.ts`:

```ts
import type { Profile } from "../api/schemas";
import { deriveLoadMode } from "../components/loadModel";
import { profileDurationSeconds } from "../api/runPrefill";
import { ko } from "../i18n/ko";

/** 압축 설정 요약(spec §8). 모드 판정은 deriveLoadMode 단일 소스, 강도 값은 모드별
 *  허용 직접 읽기(open rate는 profileVuDisplay가 안 준다 — spec C27). Math.max가
 *  안전한 근거: deriveLoadMode는 curve를 비어있지 않은 배열에서만 반환(loadModel.ts
 *  :179-180 — vuSortValue와 같은 불변식). */
export function profileSummary(
  p: Pick<Profile, "vus" | "target_rps" | "stages" | "vu_stages" | "duration_seconds">,
): string {
  const { loadModel, rateMode } = deriveLoadMode(p);
  const dur = profileDurationSeconds(p);
  if (loadModel === "open") {
    if (rateMode === "curve")
      return ko.runSummary.openCurve(Math.max(...(p.stages ?? []).map((s) => s.target)), dur);
    return ko.runSummary.openFixed(p.target_rps ?? 0, dur);
  }
  if (rateMode === "curve")
    return ko.runSummary.closedCurve(Math.max(...(p.vu_stages ?? []).map((s) => s.target)), dur);
  return ko.runSummary.closedFixed(p.vus, dur);
}
```

④ `ko.ts`에 `runSummary` 섹션(기존 어휘와 일치 — "곡선"·"최대"는 `RunVuCell` 문구, "고정"·"개방"은 모드 필터 칩과 대조 후 확정):

```ts
runSummary: {
  closedFixed: (vus: number, s: number) => `고정 ${vus} VU · ${s}s`,
  closedCurve: (peak: number, s: number) => `곡선 최대 ${peak} VU · ${s}s`,
  openFixed: (rps: number, s: number) => `개방 ${rps}/s · ${s}s`,
  openCurve: (peak: number, s: number) => `개방 곡선 최대 ${peak}/s · ${s}s`,
},
```

신규↔기존 카탈로그 양방향 부분문자열 sweep 실행(발견 시 §6 전체일치 정규식 단언으로 방어 기록).

- [ ] **Step 4: GREEN 확인** — `pnpm test; echo exit=$?`(전체) + `pnpm lint; echo exit=$?` + `pnpm build; echo exit=$?`.
- [ ] **Step 5: 커밋** — `git commit -m "feat(ui): label 스키마+runDisplayLabel+profileSummary"`.

### Task 6: UI 생성 경로 라벨 관통 — client 4계층 + RunDialog 입력 + 프리셋/retry/즉시재실행 승계

**Files:**
- Modify: `ui/src/api/client.ts` (`createRunImpl` `:47-57`·`api.createRun` `:242-247`) · `ui/src/api/hooks.ts` (`useCreateRun` `:149-167`) · `ui/src/api/runPrefill.ts` (`RunPrefill` `:67`)
- Modify: `ui/src/components/RunDialog.tsx` (라벨 state+입력·`loadPreset` `:330`·mutate 3곳 `:1206`/`:1222`/`:1288`)
- Modify: `ui/src/pages/ScenarioRunsPage.tsx` (`setPrefillState` `:104`/`:382`·즉시 재실행 `:396`) · `ui/src/pages/RunDetailPage.tsx` (**"동일 설정 즉시 재실행"** 버튼 mutate `:162` — "다시 실행"은 `:177`의 `<Link>`라 별개, 문구 grep 시 혼동 주의)
- Modify: `ui/src/i18n/ko.ts` (라벨 입력 라벨/placeholder)
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`(기존 파일 확장 — 정확 파일명은 `ls ui/src/components/__tests__/ | grep -i rundialog`로 확정) · `ui/src/pages/__tests__/ScenarioRunsPage.test.tsx`

**Interfaces:**
- US: US2(생성 시 라벨 — UI 절반, 라벨 승계 포함)
- Consumes: Task 5 `RunSchema.label`.
- Produces: `api.createRun(scenario_id, profile, env, opts?: { force?: boolean; label?: string })` · `useCreateRun` vars `{ scenarioId, profile, env, force?, label? }` · `RunPrefill = { profile; env; label?: string | null }`.
- **주의(리뷰어 당부)**: 4계층+제출 3곳은 **이 한 task에서 전부** — 쪼개면 풀-용량 clamp 경로가 라벨을 조용히 유실([[load-divergence-explain-confirm]] 클래스).

- [ ] **Step 1: 실패 테스트 작성** — RunDialog 테스트 파일에 추가:
  1. **payload 정확 단언(유라벨)**: 라벨 입력에 `"풀 2배"` 타이핑 → 실행 → fetch mock의 `/api/runs` body `JSON.parse` 후 `toEqual({ scenario_id, profile: expect.anything(), env: {}, label: "풀 2배" })`… 단 profile 비교는 기존 테스트의 정확-매치 이디엄을 따르되 **`label` 키는 exact**.
  2. **무라벨 byte-identical**: 라벨 미입력 제출 → body에 `expect(parsed).not.toHaveProperty("label")`.
  3. **clamp 경로 라벨 보존(이빨 의무)**: 첫 mutate가 `PoolCapacityError` throw하는 mock → 다이얼로그의 줄여진행 클릭 → **2번째 `/api/runs` 호출 body에 `label` 잔존** 단언. (기존 L3 테스트의 URL-필터 call-count 이디엄 재사용 — `url.includes("/api/runs")`.)
  4. **프리셋 no-clobber 2케이스**: 라벨 비어있을 때 프리셋 로드 → 라벨 입력값 = 프리셋 이름 / 라벨에 선입력 후 로드 → 안 덮임.
  5. **retry 프리필 승계**: `initial={ profile, env, label: "이전 라벨" }` → 라벨 입력 초기값 `"이전 라벨"`.
  6. ScenarioRunsPage: **즉시 재실행 라벨 승계** — 라벨 있는 run 행의 즉시 재실행 클릭 → mutate 페이로드 `label` 단언.
- [ ] **Step 2: RED 확인** — `pnpm test RunDialog; echo exit=$?` → FAIL(입력 부재·payload label 없음).
- [ ] **Step 3: 구현** — ① `client.ts`: `opts?: { force?: boolean; label?: string }` + `body: JSON.stringify({ scenario_id, profile, env, ...(opts?.label ? { label: opts.label } : {}) })`; `api.createRun` 시그니처 동기. ② `hooks.ts` mutationFn 객체에 `label?: string` + `api.createRun(scenarioId, profile, env, { force, label })`. ③ `RunPrefill`에 `label?: string | null`. ④ RunDialog: `const [label, setLabel] = useState(initial?.label ?? "");` — 모드 Segmented 아래·첫 섹션 위에 공통 렌더(간단/상세 게이트 밖):

```tsx
<label className="block">
  <span className="text-sm text-slate-600">{ko.runDialog.labelField}</span>
  <Input
    value={label}
    onChange={(e) => setLabel(e.target.value)}
    maxLength={200}
    placeholder={ko.runDialog.labelPlaceholder}
    aria-label={ko.runDialog.labelField}
  />
</label>
```

제출 3곳(`:1206` clamp·`:1222` force·`:1288` 일반) 모두 vars에 `...(label.trim() ? { label: label.trim() } : {})` 추가. `loadPreset`(`:330` `setPresetName(p.name)` 옆): `setLabel((cur) => (cur.trim() ? cur : p.name));`(no-clobber). ⑤ `ScenarioRunsPage`: `:104`/`:382` prefill 리터럴에 `label: target.label,`/`label: r.label,` · `:396` 즉시 재실행 vars에 `...(r.label ? { label: r.label } : {})`. ⑥ `RunDetailPage:162` 다시 실행 vars 동일 패턴. ⑦ ko: `runDialog.labelField: "라벨 (선택)"`·`labelPlaceholder: "예: 커넥션 풀 2배 후"`.

- [ ] **Step 4: 이빨 실증** — clamp 테스트: 구현에서 `:1206` vars의 label spread만 임시 제거 → 해당 테스트 RED 확인 → 원복 GREEN. 조건부-spread 테스트: `...(label.trim() ? …)`를 `label: label.trim() || undefined`로 임시 변경 → `not.toHaveProperty` RED 확인 → 원복.
- [ ] **Step 5: GREEN 확인** — `pnpm lint; echo exit=$?` + `pnpm test; echo exit=$?`(전체) + `pnpm build; echo exit=$?`.
- [ ] **Step 6: 커밋** — `git commit -m "feat(ui): run 생성 경로 라벨 관통(4계층+제출3곳+승계)"`.

### Task 7: RunDetail — 라벨 표시·편집 + 축약 통일 + 설정 요약 줄

**Files:**
- Modify: `ui/src/api/client.ts`(`updateRunLabel`) · `ui/src/api/hooks.ts`(`useUpdateRunLabel`)
- Modify: `ui/src/pages/RunDetailPage.tsx` (breadcrumb `:133`·h2 `:140`·헤더 아래 라벨 행+요약 줄)
- Modify: `ui/src/i18n/ko.ts`
- Test: `ui/src/pages/__tests__/RunDetailPage.test.tsx`(기존 확장)

**Interfaces:**
- US: US4(사후 편집 — 상세)·US6(상세 설정 요약 줄)
- Consumes: Task 3 PUT·Task 5 `runDisplayLabel`/`profileSummary`.
- Produces: `api.updateRunLabel(id: string, label: string | null): Promise<Run>` · `useUpdateRunLabel()`(mutationFn `{ id, scenarioId, label }` — onSuccess에서 `qc.invalidateQueries({ queryKey: queryKeys.run(id) })`(**prefix가 `runReport`까지 도달** — spec C24) + `qc.invalidateQueries({ queryKey: queryKeys.scenarioRuns(scenarioId) })`).

- [ ] **Step 1: 실패 테스트 작성** — ① breadcrumb: 라벨 run → `runDisplayLabel` 값(라벨 텍스트), 무라벨 → `#끝6자`(**앞8자 `#`+8 hex가 아닌** — 기존 단언 갱신). ② h2 스팬 `#끝6자`. ③ 라벨 행: 표시 + 연필 클릭 → input → 타이핑+Enter → `PUT /api/runs/{id}/label` fetch 단언 + invalidate 2키(query cache spy 또는 refetch 관찰 — 기존 파일의 mock 이디엄 사용). ESC 취소. ④ 요약 줄: `profileSummary` 값 + 렌더 숫자.
- [ ] **Step 2: RED 확인** — `pnpm test RunDetailPage; echo exit=$?` → FAIL.
- [ ] **Step 3: 구현** — ① `client.ts`:

```ts
updateRunLabel: (id: string, label: string | null) =>
  request(`/runs/${id}/label`, { method: "PUT", body: JSON.stringify({ label }) }, RunSchema),
```

② `hooks.ts`:

```ts
export function useUpdateRunLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, label }: { id: string; scenarioId: string; label: string | null }) =>
      api.updateRunLabel(id, label),
    onSuccess: (_run, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.run(vars.id) }); // prefix → report까지
      qc.invalidateQueries({ queryKey: queryKeys.scenarioRuns(vars.scenarioId) });
    },
  });
}
```

③ RunDetailPage: `:133` → `{ label: runDisplayLabel(r.id, r.label) }`(기존 `` `#${…}` `` 접두 **통째 제거** — `runShortLabel`이 `#` 포함, 리터럴 치환 시 `##`), `:140` → `{runShortLabel(r.id)}`. ④ h2 **밖 형제 행**(배지 형제 배치 캐넌)에 라벨 표시+편집(로컬 `draft` state·Enter/blur 커밋·ESC 취소·편집 버튼 aria = `가시텍스트 + " 편집"` 조립식) + 그 아래 `<p className="text-sm text-slate-500">{profileSummary(r.profile)}</p>`. 편집 실패는 `role="alert"` 배너. ⑤ ko: `runDetail.labelEdit`·`labelEmpty`·`labelSaveFail` 등.

- [ ] **Step 4: GREEN 확인** — `pnpm lint && pnpm test && pnpm build; echo exit=$?`(전체 — 축약 변경이 다른 파일 테스트를 깨는지 여기서 확인).
- [ ] **Step 5: 커밋** — `git commit -m "feat(ui): run 상세 라벨 표시/편집+축약 통일+설정 요약"`.

### Task 8: run 목록 라벨 열 + 인라인 편집

**Files:**
- Modify: `ui/src/pages/ScenarioRunsPage.tsx` (헤더 `:281-317`·행 `:319-417`) · `ui/src/i18n/ko.ts`
- Test: `ui/src/pages/__tests__/ScenarioRunsPage.test.tsx`

**Interfaces:**
- US: US4(사후 편집 — 목록)·US2/US5의 목록 관찰(라벨 열 표시)
- Consumes: Task 5 `runDisplayLabel` · Task 7 `useUpdateRunLabel`.
- Produces: "라벨" 열("비교" 뒤·"상태" 앞, **plain `<th>`** — `SortableTh`/`aria-sort` 비대상).

- [ ] **Step 1: 실패 테스트 작성** — ① 라벨 열 헤더 존재. ② 라벨 run 행 셀=라벨 텍스트, 무라벨 행 셀=muted `#끝6자`. ③ 셀 편집: 편집 버튼 클릭 → input 타이핑 → Enter → PUT fetch + **성공 후 draft 클리어**(이빨: invalidate 재페치로 서버가 *다른* 값을 돌려주는 mock → 셀이 서버 값 표시 — stale draft면 FAIL하는 구도). ④ 기존 열 단언들이 여전히 통과(role/name 쿼리라 시프트 무해 — 전체 스위트로 확인).
- [ ] **Step 2: RED 확인** — `pnpm test ScenarioRunsPage; echo exit=$?` → FAIL.
- [ ] **Step 3: 구현** — 헤더 `비교` th 뒤 `<th className="py-2 pr-4 font-medium">{ko.runFilter.labelCol}</th>`. 행에 셀: 행별 편집 state(`editing: string | null`(run id)+`draft: string`)는 페이지 레벨 1쌍(한 번에 한 행 편집 — SettingsPage per-key draft보다 단순·충분), 표시:

```tsx
<td className="py-3 pr-4">
  {editing === r.id ? (
    <Input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      maxLength={200}
      aria-label={ko.runFilter.labelEditAria(runDisplayLabel(r.id, r.label))}
      onKeyDown={(e) => {
        if (e.key === "Enter") commitLabel(r);
        if (e.key === "Escape") setEditing(null);
      }}
      onBlur={() => commitLabel(r)}
    />
  ) : (
    <button type="button" onClick={() => { setEditing(r.id); setDraft(r.label ?? ""); }}
      className="text-left hover:underline"
      aria-label={ko.runFilter.labelEditAria(runDisplayLabel(r.id, r.label))}>
      {r.label ? r.label : <span className="font-mono text-slate-400">{runShortLabel(r.id)}</span>}
    </button>
  )}
</td>
```

`commitLabel`: `updateLabel.mutate({ id: r.id, scenarioId: r.scenario_id, label: draft.trim() || null }, { onSuccess: () => setEditing(null) })` — **onSuccess에서 편집 종료=draft 폐기**(invalidate 재페치가 서버 값 렌더 — per-row stale draft 함정 회피). 실패 시 `role="alert"` 배너 + 편집 유지. ko: `runFilter.labelCol: "라벨"` + **함수형** `labelEditAria: (name: string) => \`${name} 라벨 편집\``(하드코딩 백틱 템플릿 금지 — 편집 input의 aria도 같은 함수 재사용, WCAG 2.5.3 조립식). `ko.*(n)` 자기참조 방지: aria 단언에 `runDisplayLabel` 결과 문자열 포함을 별도 단언.

- [ ] **Step 4: 이빨 실증** — onSuccess의 `setEditing(null)` 임시 제거 → ③ 테스트 RED → 원복 GREEN.
- [ ] **Step 5: GREEN 확인** — `pnpm lint && pnpm test && pnpm build; echo exit=$?`.
- [ ] **Step 6: 커밋** — `git commit -m "feat(ui): run 목록 라벨 열+인라인 편집"`.

### Task 9: 비교 표면 — `runLabels`→`runDisplayLabel` + `sublines` prop + 오버레이 범례

**Files:**
- Modify: `ui/src/pages/ScenarioComparePage.tsx` (`:148-155` 라벨 맵·sublines 계산·`:231` 전달)
- Modify: `ui/src/components/compare/CompareMatrix.tsx` (`:7-11` Props·`:137-152` 헤더)
- Modify: `ui/src/compare/overlaySeries.ts` (`:23`)
- Test: `ui/src/components/compare/__tests__/CompareMatrix.test.tsx` · `ui/src/compare/__tests__/overlaySeries.test.ts`

**Interfaces:**
- US: US1(비교 헤더·오버레이 식별)
- Consumes: Task 5 `runDisplayLabel`/`profileSummary`·`ReportRunSchema.label`.
- Produces: `CompareMatrix` **additive optional prop** `sublines?: Record<string, string>`(미전달=미렌더 — 기존 render 사이트 무churn) · `InsightCompareMatrix`는 labels 맵 경유 자동(코드 무변경).

- [ ] **Step 1: 실패 테스트 작성** — ① CompareMatrix: `sublines` 전달 시 열 헤더에 서브라인 텍스트 렌더 + **baseline 전환 버튼 accname에 서브라인 미합류**(`getByRole("button", { name: "#abc123" })` 정확 매치 성립) + 미전달 시 서브라인 부재. ② overlaySeries: `r.run.label` 있는 리포트 → `label`이 라벨 텍스트, 없으면 `#끝6자`. ③ ComparePage 레벨(기존 테스트 파일 있으면): 라벨 리포트 fixture로 헤더에 라벨 표시.
- [ ] **Step 2: RED 확인** — `pnpm test CompareMatrix; echo exit=$?` → FAIL.
- [ ] **Step 3: 구현** — ① `CompareMatrix` Props에 `sublines?: Record<string, string>;` — 헤더 `<th>` 안 버튼 **밖 형제**로:

```tsx
<th key={runId} className="py-2 pr-4 font-medium">
  <button …기존 그대로…>…</button>
  {sublines?.[runId] && (
    <div className="mt-0.5 text-xs font-normal text-slate-500">{sublines[runId]}</div>
  )}
</th>
```

② `ScenarioComparePage` — 라벨 맵(`:150-154`)을 리포트에서 도출: `labels[id] = runDisplayLabel(id, reports.find((x) => x.run.id === id)?.run.label)` — **useMemo dep에 `reports` 추가 필수**(`react-hooks/exhaustive-deps`=warn + `--max-warnings=0`이라 lint가 강제). 로딩-전 폴백 헤지는 불요 — `runLabels`는 `ScenarioCompareInner` 소속이라 loading/error early-return(`:56-83`) 뒤에만 렌더된다. sublines 계산(useMemo — 같은 `[reports]` dep):

```ts
const runSublines = useMemo(() => {
  const m: Record<string, string> = {};
  for (const rep of reports) {
    const parsed = ProfileSchema.safeParse(rep.run.profile); // run.profile은 z.unknown()
    const ts = new Date(rep.run.created_at).toLocaleString();
    m[rep.run.id] = parsed.success ? `${ts} · ${profileSummary(parsed.data)}` : ts; // fail-soft: 시각 단독
  }
  return m;
}, [reports]);
```

`<CompareMatrix … sublines={runSublines} />`. `InsightCompareMatrix`는 무변경(labels 맵으로 라벨만 자동). ③ `overlaySeries.ts:23` → `label: runDisplayLabel(r.run.id, r.run.label),`.

- [ ] **Step 4: 이빨 실증** — 서브라인 `<div>`를 버튼 **안**으로 임시 이동 → accname 정확-매치 테스트 RED → 원복 GREEN.
- [ ] **Step 5: GREEN 확인** — `pnpm lint && pnpm test && pnpm build; echo exit=$?`.
- [ ] **Step 6: 커밋** — `git commit -m "feat(ui): 비교 헤더 라벨+서브라인, 오버레이 범례 라벨"`.

### Task 10: 목록 검색 축 `q` — 술어·URL·초기화 게이트·입력

**Files:**
- Modify: `ui/src/runs/runFilterSort.ts` (`RunFilter` `:13-20`·`EMPTY_FILTER` `:28-35`·`filterRuns` `:109-120`·`parseRunControls` `:205`·`serializeRunControls` `:223`·`hasActiveControls` `:238`)
- Modify: `ui/src/components/RunListControls.tsx` (검색 입력) · `ui/src/i18n/ko.ts`
- Test: `ui/src/runs/__tests__/runFilterSort.test.ts`(기존 확장) · `ui/src/pages/__tests__/ScenarioRunsPage.test.tsx`

**Interfaces:**
- US: US3(검색으로 과거 run 되찾기)
- Consumes: Task 6에서 `RunSchema.label`이 이미 목록 데이터에 실려 옴.
- Produces: `RunFilter.q: string`.

- [ ] **Step 1: 실패 테스트 작성** — 술어 매트릭스: 라벨 부분일치(대소문자 무시)·id 부분일치(`"#a1b2c3"` 입력이 대문자 ULID에 매치 — `#` strip)·`"#"` 단독=전 행 통과·`q: "  "`=전 행 통과·무라벨 run은 라벨 매치 스킵(id로만). `hasActiveControls`: `q` trim-빈=false·값 있으면 true. URL: `q` 있는 round-trip(`parse(serialize(f)) == f`)·trim-빈이면 파라미터 부재(기본 URL byte-identical). RTL: 검색 입력 타이핑 → 행 필터 + 초기화 버튼 표시 → 클릭 → 전체 복귀.
- [ ] **Step 2: RED 확인** — `pnpm test runFilterSort; echo exit=$?` → FAIL(`q` 필드 부재 tsc 에러 포함 가능 — vitest transpile은 통과할 수 있으니 단언 FAIL 기준).
- [ ] **Step 3: 구현** — ① `RunFilter`에 `q: string;`·`EMPTY_FILTER`에 `q: "",`. ② `filterRuns`에(빈 판정 공유 정의 — spec §9):

```ts
const needle = f.q.trim().replace(/^#/, "").toLowerCase();
// return 내부 필터 체인에 추가:
if (needle !== "" && !matchesQ(r, needle)) return false;
```

```ts
/** q 술어(spec §9): 선행 # 1회 제거·소문자 부분일치를 label·full id 양쪽에. */
function matchesQ(r: Run, needle: string): boolean {
  if (r.label && r.label.toLowerCase().includes(needle)) return true;
  return r.id.toLowerCase().includes(needle);
}
```

③ `parseRunControls` filter에 `q: sp.get("q") ?? "",` · `serializeRunControls`에 `if (filter.q.trim() !== "") sp.set("q", filter.q);` · `hasActiveControls`에 `filter.q.trim() !== "" ||`. **세 지점 전부 `trim()` 기준 — 한 지점이라도 raw를 보면 공백 하나로 모순**(spec §9). ④ `RunListControls` 상단 flex 행에 — **`w-fit`/폭 래퍼 div 필수**(`Input` BASE가 `block w-full`이고 단순 문자열 연결이라 `className="w-48"`은 `w-full`에 진다 — 같은 파일 날짜 입력 2개(`:184-191`/`:193-201`)가 div 래퍼를 쓰는 이유):

```tsx
<div className="w-48">
  <Input
    compact
    value={filter.q}
    onChange={(e) => setFilter({ ...filter, q: e.target.value })}
    placeholder={ko.runFilter.searchPlaceholder}
    aria-label={ko.runFilter.searchLabel}
  />
</div>
```

⑤ ko: `runFilter.searchLabel: "라벨·ID 검색"`·`searchPlaceholder: "라벨·ID 검색"`.
⑥ **전 슬라이스 ko sweep(마지막 ko-터치 task라 여기서 전수·diff-스코프 — 선재 328+64건 때문에 트리 전체 grep은 판정 불가)**:

```bash
git diff $(git merge-base master HEAD)..HEAD -- ui/src \
  | grep '^+' | grep -v '^+++' \
  | grep -E '["`][^"`]*[가-힣]' | grep -v 'i18n/ko'
```

기대 **0줄**(기계 판정 — 파일타입 무관 `.ts`/`.tsx` 커버, 큰따옴표·백틱 두 arm 한 패스; spec §11 패턴은 큰따옴표-직후만 봐서 백틱 템플릿 하드코딩을 구조적으로 못 잡는다. 테스트 파일의 정당한 한국어 단언이 매치되면 그 줄만 개별 판정·record). + 신규↔기존 카탈로그 양방향 부분문자열 sweep.

- [ ] **Step 4: GREEN 확인** — `pnpm lint && pnpm test && pnpm build; echo exit=$?`.
- [ ] **Step 5: 커밋** — `git commit -m "feat(ui): run 목록 라벨·ID 검색 축(q)"`.

---

## 구현 후 게이트 (plan 밖 파이프라인 — 참조용)

1. **최종 whole-branch 리뷰**: `handicap-reviewer`(와이어 1:1·deferral·게이트 재확인). **보안 게이트는 `finish-slice §0` grep이 지배** — 라벨은 요청실행/템플릿/env·데이터셋/업로드/trace 비대상 예상이나 grep을 직접 돌려 판정. + [[security-gate-judgment-override]] 판단: 라벨은 **새 사용자 텍스트가 org-공유 run 레코드·export로 흐르는 새 sink**이므로 grep N/A여도 1분 재검토(React escape·XLSX 문자열 셀·`ko` 경유 확인이면 통과).
2. **라이브 검증**: spec §13 US 척추 표 그대로(`/live-verify` — US1~US6 + 무라벨 하위호환). run 생성/응답 파싱 경로라 **필수**.
3. **finish-slice**: ADR-0052 작성(+인덱스 한 줄)·roadmap §B 연기 기록(장문 메모·schedule_id·export 파일명·CSV 라벨·라벨 정렬)·build-log 단락·상태줄 교체.

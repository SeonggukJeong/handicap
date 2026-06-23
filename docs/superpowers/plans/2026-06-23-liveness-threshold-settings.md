# 라이브니스 grace 임계값 `/settings` 런타임 가변 (B2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** run-watchdog의 startup/backstop grace(A/B)를 CLI 전용 `OnceLock`에서 기존 `/settings` 레지스트리로 옮겨 런타임 가변으로 만들고, 클라 stall 임계값(C)을 `/settings`에 읽기전용으로 표시한다.

**Architecture:** L6 heartbeat 선례 1:1 — `SETTINGS` 레지스트리에 mutable 2행 추가 + 접근자 2개, `spawn_run`이 `OnceLock` 대신 `state.settings`에서 grace를 읽고 `OnceLock`을 제거, main.rs는 CLI 플래그를 `cli_seeds`로 라우팅. C는 클라 `runStall.ts` 상수를 단일소스로 `/settings` 페이지가 readonly 행 2개로 렌더(백엔드 무관).

**Tech Stack:** Rust(axum/sqlx controller), React/TS(SettingsPage + Zod), 기존 settings 레지스트리·watchdog 메커니즘.

## Global Constraints

- **Migration 0**: `settings` 테이블(migration 0017)이 이미 존재 — 신규 knob은 `SETTINGS` 코드 행. 새 마이그레이션 추가 금지.
- **Zod 0 / proto 0 / engine 0 / worker 0**: `SettingSchema.group` enum에 `"limits"` 존재·key/label generic → A/B DTO 무변경. C는 API/Zod 미경유. watchdog는 컨트롤러 전용.
- **`enqueue`/`run_watchdog` 시그니처 무변경**: spawn_run이 동일 `Duration` 2개를 계산해 전달(읽는 소스만 OnceLock→settings).
- **healthy byte-identical**: 설정 미변경 시 grace 기본 90/120 그대로 도출(R5).
- **ko 단일 소스(ADR-0035)**: 사용자 노출 문구는 `ko.opsSettings.*` 경유. 백엔드 SettingDef `label`은 한국어.
- **커밋 게이트**: 백엔드 커밋(Task 1·2)은 pre-commit이 전체 workspace cargo 게이트(수 분) 실행 — `git commit`은 `run_in_background:false` 단일 호출(폴링 금지), 파이프 없이. UI 커밋(Task 3)은 UI 게이트(`pnpm lint && pnpm test && pnpm build`).
- **A/B 범위**: 둘 다 min 10, max 3600, unit "초", mutable, default 90/120. pair 제약 없음(독립).

---

### Task 1: A/B 레지스트리 행 + 접근자 + 테스트 (backend, 단일 green 커밋)

**Files:**
- Modify: `crates/controller/src/settings.rs` (SETTINGS 2행 추가 ~line 111 뒤; 접근자 2개 ~line 289 뒤; 인라인 테스트 추가)
- Modify: `crates/controller/tests/settings_api_test.rs` (PUT/DELETE 라운드트립 테스트 추가)

**Interfaces:**
- Produces: `SettingsState::run_startup_grace_seconds(&self) -> u64`, `SettingsState::run_backstop_grace_seconds(&self) -> u64` (Task 2가 spawn_run에서 소비). 레지스트리 키 문자열 `"run_startup_grace_seconds"`/`"run_backstop_grace_seconds"`.

- [ ] **Step 1: 접근자 단위 테스트 작성 (RED)**

`crates/controller/src/settings.rs`의 `#[cfg(test)] mod tests` 안(기존 `out_of_range_override_falls_back_to_seed` 뒤)에 추가:

```rust
#[test]
fn run_grace_accessors_default_seed_override() {
    // 미설정 → 레지스트리 default 90/120
    let s = SettingsState::build(&HashMap::new(), &[]);
    assert_eq!(s.run_startup_grace_seconds(), 90);
    assert_eq!(s.run_backstop_grace_seconds(), 120);
    // CLI seed override
    let s = SettingsState::build(
        &HashMap::new(),
        &[
            ("run_startup_grace_seconds", 30),
            ("run_backstop_grace_seconds", 45),
        ],
    );
    assert_eq!(s.run_startup_grace_seconds(), 30);
    assert_eq!(s.run_backstop_grace_seconds(), 45);
    // DB override 우선
    let mut db = HashMap::new();
    db.insert("run_startup_grace_seconds".to_string(), 200);
    let s = SettingsState::build(&db, &[]);
    assert_eq!(s.run_startup_grace_seconds(), 200);
    // 범위 밖(max 3600 초과) → 시드(default 120)로 fallback
    let mut db = HashMap::new();
    db.insert("run_backstop_grace_seconds".to_string(), 99999);
    let s = SettingsState::build(&db, &[]);
    assert_eq!(s.run_backstop_grace_seconds(), 120);
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cargo test -p handicap-controller --lib settings::tests::run_grace_accessors_default_seed_override`
Expected: FAIL — `no method named run_startup_grace_seconds` (컴파일 에러).

- [ ] **Step 3: SETTINGS 2행 추가**

`crates/controller/src/settings.rs`의 `SETTINGS` 배열에서 `pool_stale_timeout_seconds` 행(끝 `},` ~line 111) 뒤, readonly `trace_body_cap_bytes` 행 앞에 삽입:

```rust
    // run 진행 라이브니스 watchdog grace(런타임 가변, B2). spawn_run이 run마다 읽음.
    SettingDef {
        key: "run_startup_grace_seconds",
        label: "Run 시작 grace (startup 라이브니스)",
        group: Group::Limits,
        min: 10,
        max: 3600,
        unit: "초",
        mutable: true,
        default: 90,
    },
    SettingDef {
        key: "run_backstop_grace_seconds",
        label: "Run 백스톱 grace (예상 종료 초과)",
        group: Group::Limits,
        min: 10,
        max: 3600,
        unit: "초",
        mutable: true,
        default: 120,
    },
```

- [ ] **Step 4: 접근자 2개 추가**

`crates/controller/src/settings.rs`의 `pool_stale_timeout_seconds(&self)` 접근자(~line 287-289) 뒤, `seed_of` 앞에 삽입:

```rust
    pub fn run_startup_grace_seconds(&self) -> u64 {
        self.get("run_startup_grace_seconds") as u64
    }
    pub fn run_backstop_grace_seconds(&self) -> u64 {
        self.get("run_backstop_grace_seconds") as u64
    }
```

- [ ] **Step 5: 단위 테스트 통과 확인**

Run: `cargo test -p handicap-controller --lib settings::tests`
Expected: PASS — `run_grace_accessors_default_seed_override` + 기존 `registry_is_single_source`(신규 행의 min<=max·default 범위 자동 검증) 포함 전부 green.

- [ ] **Step 6: API 라운드트립 테스트 작성**

`crates/controller/tests/settings_api_test.rs` 끝에 추가(기존 `make_app`/`send` 헬퍼 재사용):

```rust
/// A/B grace는 mutable + pair 제약 없음 — PUT 후 형제 키 불변, 범위밖 400, DELETE 복원.
#[tokio::test]
async fn put_delete_run_grace_roundtrip_sibling_unchanged() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);

    // PUT in-range → 200 override
    let (status, body) = send(
        &app,
        Method::PUT,
        "/api/settings/run_startup_grace_seconds",
        Some(json!({ "value": 45 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["value"], 45);
    assert_eq!(body["source"], "override");

    // 형제 키(run_backstop_grace_seconds) 불변 — pair 제약 없음
    let (status, body) = send(&app, Method::GET, "/api/settings", None).await;
    assert_eq!(status, StatusCode::OK);
    let items = body["settings"].as_array().unwrap();
    let backstop = items
        .iter()
        .find(|s| s["key"] == "run_backstop_grace_seconds")
        .expect("backstop row");
    assert_eq!(backstop["value"], 120, "형제 키 불변");
    assert_eq!(backstop["source"], "default");

    // 범위 밖(max 3600 초과) → 400
    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/settings/run_startup_grace_seconds",
        Some(json!({ "value": 99999 })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // DELETE → 204, 값이 시드(default 90)로 복원
    let (status, _) = send(
        &app,
        Method::DELETE,
        "/api/settings/run_startup_grace_seconds",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, body) = send(&app, Method::GET, "/api/settings", None).await;
    let startup = body["settings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["key"] == "run_startup_grace_seconds")
        .expect("startup row");
    assert_eq!(startup["value"], 90);
    assert_eq!(startup["source"], "default");
}
```

- [ ] **Step 7: API 테스트 통과 확인**

Run: `cargo test -p handicap-controller --test settings_api_test`
Expected: PASS — 새 테스트 + 기존 settings API 테스트 전부 green.

- [ ] **Step 8: 커밋 (foreground, 폴링 금지)**

```bash
git add crates/controller/src/settings.rs crates/controller/tests/settings_api_test.rs
git commit -m "feat(controller): run-liveness grace A/B settings 레지스트리 행+접근자 (B2 T1)"
```
직후 `git log -1 --oneline`로 landed 확인.

---

### Task 2: OnceLock → settings 스왑 + 제거 (backend, 단일 green 커밋)

**Files:**
- Modify: `crates/controller/src/api/runs.rs:683` (grace 읽기 소스 교체)
- Modify: `crates/controller/src/main.rs` (set_watchdog_grace 블록 181-190 제거; cli_seeds 2 entry 추가)
- Modify: `crates/controller/src/grpc/coordinator.rs` (OnceLock 필드 224·init 239·`set_watchdog_grace` 281-287·`watchdog_grace_config` 289-295·테스트 1704-1718 제거)

**Interfaces:**
- Consumes: Task 1의 `state.settings.run_startup_grace_seconds()`/`run_backstop_grace_seconds()`.

> **line 번호는 근사값 — 심볼로 찾을 것**: coordinator.rs의 fn/필드/테스트 위치는 편집 중 미세하게 이동할 수 있다. 인용한 line 번호 대신 심볼명(`watchdog_grace`/`set_watchdog_grace`/`watchdog_grace_config`/`watchdog_grace_defaults_then_overrides`)으로 찾아 편집하고, **Step 6의 R3 grep(`watchdog_grace`→0)**으로 완전 제거를 검증한다(미편집 enqueue 사이트 759/825/852도 근사값이나 손대지 않으므로 무관).

- [ ] **Step 1: spawn_run grace 읽기 소스 교체**

`crates/controller/src/api/runs.rs`의 spawn_run, line 683:

```rust
    let (startup_floor, backstop_grace) = state.coord.watchdog_grace_config();
```
를 다음으로 교체(앞뒤 `startup_grace`/`backstop_total` 도출은 그대로):

```rust
    let startup_floor =
        std::time::Duration::from_secs(state.settings.run_startup_grace_seconds());
    let backstop_grace =
        std::time::Duration::from_secs(state.settings.run_backstop_grace_seconds());
```

- [ ] **Step 2: main.rs set_watchdog_grace 블록 제거 + cli_seeds 추가**

`crates/controller/src/main.rs`에서 line 181-190 블록 전체 삭제:

```rust
    coord_state.set_watchdog_grace(
        std::time::Duration::from_secs(args.run_startup_grace_seconds),
        std::time::Duration::from_secs(args.run_backstop_grace_seconds),
    );
    let (su, bk) = coord_state.watchdog_grace_config();
    tracing::info!(
        startup_grace_s = su.as_secs(),
        backstop_grace_s = bk.as_secs(),
        "run-liveness watchdog configured"
    );
```

그리고 `SettingsState::build`의 `cli_seeds` 슬라이스(line 285 `("pool_keepalive_seconds", ...)` 뒤)에 2 entry 추가:

```rust
            ("run_startup_grace_seconds", args.run_startup_grace_seconds as i64),
            ("run_backstop_grace_seconds", args.run_backstop_grace_seconds as i64),
```

(CLI 플래그 정의 main.rs:104-110은 **유지** — seed 역할.)

그리고 제거한 startup 로그를 대체해, `let settings = ...build(...);`(~line 287, build 닫는 `;`) **직후**에 grace 값 로그 추가(L6 heartbeat seed 로그 선례·ops 가시성 보존):

```rust
    tracing::info!(
        startup_grace_s = settings.run_startup_grace_seconds(),
        backstop_grace_s = settings.run_backstop_grace_seconds(),
        "run-liveness watchdog grace (settings)"
    );
```

- [ ] **Step 3: coordinator.rs OnceLock 테스트 제거**

`crates/controller/src/grpc/coordinator.rs`의 인라인 테스트 `watchdog_grace_defaults_then_overrides`(line 1704-1718, `#[tokio::test]`부터 닫는 `}`까지) 전체 삭제.

- [ ] **Step 4: coordinator.rs OnceLock 필드·init·메서드 제거**

`crates/controller/src/grpc/coordinator.rs`에서 삭제:
- 필드 주석+선언(line 219-224, `/// CLI-seeded run-liveness grace...`부터 `watchdog_grace: Arc<OnceLock<...>>,`까지)
- `new()`의 init 라인(line 239 `watchdog_grace: Arc::new(OnceLock::new()),`)
- `set_watchdog_grace`(line 279-287, doc 주석 포함)
- `watchdog_grace_config`(line 289-295, doc 주석 포함)

- [ ] **Step 5: 워크스페이스 빌드 (워커 워밍 후)**

Run: `cargo build -p handicap-worker && cargo build --workspace`
Expected: PASS — `watchdog_grace`/`set_watchdog_grace`/`watchdog_grace_config` 참조 0이라 컴파일 green.

- [ ] **Step 6: R3 grep 불변식 확인**

Run: `grep -rn "watchdog_grace" crates/controller/src`
Expected: **0건**(심볼 완전 제거).

- [ ] **Step 7: 컨트롤러 테스트 통과 확인**

Run: `cargo nextest run -p handicap-controller`
Expected: PASS — 기존 watchdog 타이머 테스트(`enqueue`에 `Duration` 직접 주입)는 무변경 green, 제거한 OnceLock 테스트만 사라짐.

- [ ] **Step 8: 커밋 (foreground, 폴링 금지)**

```bash
git add crates/controller/src/api/runs.rs crates/controller/src/main.rs crates/controller/src/grpc/coordinator.rs
git commit -m "refactor(controller): watchdog grace OnceLock→settings 스왑·OnceLock 제거 (B2 T2)"
```
직후 `git log -1 --oneline`로 landed 확인.

---

### Task 3: UI — C readonly 행 + ko 문구 + RTL (UI-only, 단일 커밋)

**Files:**
- Modify: `ui/src/pages/__tests__/SettingsPage.test.tsx` (**먼저** — tdd-guard pending RED)
- Modify: `ui/src/i18n/ko.ts` (`opsSettings`에 A/B desc 2 + effect 2 + C 라벨 2 키)
- Modify: `ui/src/pages/SettingsPage.tsx` (C readonly 행 2개 주입)

**Interfaces:**
- Consumes: `ui/src/api/runStall.ts`의 `STARTUP_STALL_MS`(15_000)·`MIDRUN_STALL_MS`(120_000) (ms, 단일소스).
- Produces: `ko.opsSettings.runStartupStallLabel`·`runMidrunStallLabel`(C readonly 라벨)·`ko.opsSettings.desc.run_startup_grace_seconds`·`run_backstop_grace_seconds`·`ko.opsSettings.effect.run_startup_grace_seconds`·`run_backstop_grace_seconds`.

> **tdd-guard 순서 필수(ui/CLAUDE.md)**: Step 1(테스트 파일 편집)을 ko.ts/SettingsPage.tsx **앞에** 둬 pending RED diff를 만든다. 테스트 파일(`__tests__/*.test.tsx`)은 test-path라 항상 통과하고, 그 pending diff가 이후 src 편집을 unblock한다. import 미해결로 RED여도 무방.

- [ ] **Step 1: RTL 테스트 작성 (RED)**

`ui/src/pages/__tests__/SettingsPage.test.tsx`에 import 추가(파일 상단):

```tsx
import { STARTUP_STALL_MS, MIDRUN_STALL_MS } from "../../api/runStall";
```

그리고 `describe("SettingsPage", ...)` 안에 A/B mutable 행 fixture + 2 테스트 추가:

```tsx
const STARTUP_GRACE_ROW = {
  key: "run_startup_grace_seconds",
  label: "Run 시작 grace (startup 라이브니스)",
  group: "limits",
  value: 90,
  default: 90,
  min: 10,
  max: 3600,
  unit: "초",
  mutable: true,
  source: "default",
};

it("shows C stall thresholds as readonly rows sourced from runStall.ts", async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse(SETTINGS_RESPONSE));
  renderPage();

  // C 라벨(클라 리터럴) 렌더
  expect(await screen.findByText(ko.opsSettings.runMidrunStallLabel)).toBeInTheDocument();
  expect(screen.getByText(ko.opsSettings.runStartupStallLabel)).toBeInTheDocument();

  // 값은 runStall.ts 상수에서 직접(초 변환) — 120 초 / 15 초
  expect(
    screen.getByText(`${MIDRUN_STALL_MS / 1000} 초`),
  ).toBeInTheDocument();
  expect(
    screen.getByText(`${STARTUP_STALL_MS / 1000} 초`),
  ).toBeInTheDocument();
});

it("shows A/B grace as editable rows with description", async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({ settings: [STARTUP_GRACE_ROW, READONLY_ROW] }),
  );
  renderPage();

  // mutable 섹션에 A 라벨 + 설명
  expect(await screen.findByText("Run 시작 grace (startup 라이브니스)")).toBeInTheDocument();
  expect(
    screen.getByText(ko.opsSettings.desc.run_startup_grace_seconds),
  ).toBeInTheDocument();
  // 저장 버튼(편집 가능)
  expect(screen.getAllByRole("button", { name: ko.opsSettings.save }).length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test SettingsPage`
Expected: FAIL — `ko.opsSettings.runMidrunStallLabel` undefined / C 행 미렌더.

- [ ] **Step 3: ko.ts 문구 추가**

`ui/src/i18n/ko.ts`의 `opsSettings` 객체에 추가:

(a) top-level(예: `readonlyNote` 뒤)에 C 라벨 2개:
```ts
    runStartupStallLabel: "Run 시작 후 메트릭 미도착 경고 (advisory)",
    runMidrunStallLabel: "Run 진행 중 메트릭 침묵 경고 (advisory)",
```

(b) `desc` 객체에 A/B 2개(`pool_keepalive_seconds` 뒤):
```ts
      run_startup_grace_seconds:
        "등록 후 첫 메트릭(부하 시작)을 기다리는 최소 시간(초). 실제 적용값은 이 값과 HTTP 타임아웃+여유·선두 무부하 구간 중 큰 값입니다. 이 안에 부하가 안 잡히면 hung으로 보고 run을 실패 처리합니다.",
      run_backstop_grace_seconds:
        "run 예상 종료 시각을 넘어 완료를 기다리는 여유 시간(초). 이 시간을 넘기면 hung으로 보고 run을 실패 처리합니다.",
```

(c) `effect` 객체에 A/B 2개(`pool_stale_timeout_seconds` 뒤):
```ts
      run_startup_grace_seconds:
        "⬆ 올리면 느리게 시작하는 SUT·콜드스타트에 관대해집니다. 대신 정말 멈춘(hung) run을 늦게 감지합니다.\n⬇ 내리면 빨리 감지하지만, 정상이지만 느린 시작을 잘못 실패 처리할 수 있습니다(실제 적용값은 HTTP 타임아웃+15초 이상으로 보호).",
      run_backstop_grace_seconds:
        "⬆ 올리면 종료가 늦는 run에 관대해집니다. 대신 멈춘 run이 오래 남습니다.\n⬇ 내리면 멈춘 run을 빨리 정리하지만, 정상이지만 조금 늦게 끝나는 run을 잘못 실패 처리할 수 있습니다.",
```

- [ ] **Step 4: SettingsPage.tsx C readonly 행 주입**

`ui/src/pages/SettingsPage.tsx` 상단 import에 추가:
```tsx
import { STARTUP_STALL_MS, MIDRUN_STALL_MS } from "../api/runStall";
```

`SettingsPage` 컴포넌트 안에서 `const readonly = settings?.filter((s) => !s.mutable) ?? [];`(line 139)를 다음으로 교체:

```tsx
  // C(클라 stall advisory) 임계값 — 단일소스 = runStall.ts. /settings엔 읽기전용 표시만.
  const clientReadonly: Setting[] = [
    {
      key: "run_midrun_stall_seconds",
      label: ko.opsSettings.runMidrunStallLabel,
      group: "limits",
      value: MIDRUN_STALL_MS / 1000,
      default: MIDRUN_STALL_MS / 1000,
      min: 0,
      max: MIDRUN_STALL_MS / 1000,
      unit: "초",
      mutable: false,
      source: "readonly",
    },
    {
      key: "run_startup_stall_seconds",
      label: ko.opsSettings.runStartupStallLabel,
      group: "limits",
      value: STARTUP_STALL_MS / 1000,
      default: STARTUP_STALL_MS / 1000,
      min: 0,
      max: STARTUP_STALL_MS / 1000,
      unit: "초",
      mutable: false,
      source: "readonly",
    },
  ];
  const readonly = [...(settings?.filter((s) => !s.mutable) ?? []), ...clientReadonly];
```

(`Setting` 타입은 이미 `import type { Setting } from "../api/settings";`로 import됨 — line 6.)

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd ui && pnpm test SettingsPage`
Expected: PASS — C readonly 행 + A/B mutable 행 테스트 + 기존 테스트 green.

- [ ] **Step 6: 전체 UI 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: PASS — lint 0 경고, 전체 vitest green, `tsc -b` + vite build 성공.

- [ ] **Step 7: 커밋 (foreground)**

```bash
git add ui/src/pages/__tests__/SettingsPage.test.tsx ui/src/i18n/ko.ts ui/src/pages/SettingsPage.tsx
git commit -m "feat(ui): /settings에 라이브니스 grace A/B 편집행 + C stall 임계값 readonly 표시 (B2 T3)"
```
직후 `git log -1 --oneline`로 landed 확인.

---

## 최종 검증 (구현 후, orchestrator)

- **최종 리뷰**: `handicap-reviewer` APPROVE(와이어 1:1·repo 함정·OnceLock 제거 완전성·byte-identical-off). 보안 게이트는 `finish-slice §0` grep으로 판정(요청실행/템플릿/캐스트/env-dataset 바인딩/업로드/trace 무관 → security-reviewer N/A 예상).
- **라이브 검증(필수 — spawn_run 경로 변경)**: `/live-verify` 스택으로 — ① `GET /api/settings`에 A/B(mutable)+C(readonly) 4행 + 값 확인, ② `PUT /api/settings/run_backstop_grace_seconds {value:10}` → 짧은 duration hung run(`kill -STOP`)이 기본 120s 아닌 ~`duration+10`s에 Failed(사유 message), ③ PUT 후 `source:"override"` + (선택) 재기동 후 DB override 생존, ④ 설정 미변경 healthy run 정상 완료. (startup-A는 `http_timeout+15` 지배라 backstop-B로 설정-흐름 입증 — G1a 노트.)
- **게이트(orchestrator 직접 재실행)**: `cargo nextest run -p handicap-controller` + `cargo build --workspace` + `cd ui && pnpm lint && pnpm test && pnpm build`.

## Self-Review (작성자 체크)

- **Spec coverage**: §3.1(SETTINGS 행+접근자)=T1 / §3.2(spawn_run 읽기)=T2 / §3.3(OnceLock 제거)=T2 / §3.4(main.rs seed)=T2 / §3.5(future-runs 의미론, 기존 global applyNote가 이미 노출)=T2+ko / §3.6(A/B desc/effect)=T3 / §3.7(C readonly 행)=T3 / §3.8(migration0/Zod0)=Global Constraints. R1~R8 전부 매핑(R1/R2=T1 API테스트, R3=T2 grep, R4/R5=T2+live, R6/R7=T3 RTL, R8=Global). 갭 없음.
- **Placeholder scan**: 모든 step에 실제 코드/명령/기대출력. 없음.
- **Type consistency**: 접근자명 `run_startup_grace_seconds`/`run_backstop_grace_seconds`(T1 produces ↔ T2 consumes 일치). ko 키 `runStartupStallLabel`/`runMidrunStallLabel`·`desc`/`effect.run_*_grace_seconds`(T3 test ↔ ko ↔ SettingsPage 일치). 레지스트리 키 문자열 4종 일관.

<!-- REVIEW-GATE: APPROVED -->

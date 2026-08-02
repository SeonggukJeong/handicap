# error-taxonomy E3 — `connect_timeout` 노브 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** run 프로필에 opt-in `connect_timeout_seconds`를 추가해, connect 단계에서 막힌 요청을 전체-요청 `timeout`이 아닌 `connect_timeout` kind로 분리한다 (spec §13 E3 / US3).

**Architecture:** 새 집계 채널·migration·인사이트를 만들지 않는다. E1이 이미 출하한 `ErrorKind::ConnectTimeout` 분류 규칙(`error_kind.rs` 규칙 2: `is_timeout() && is_connect()`)에 **도달할 수 있게 하는 노브 하나**를 전 계층에 관통시키는 것이 전부다: UI 입력 → `store::Profile` → 검증 → proto `Profile` → 워커 → `RunPlan.connect_timeout` → `VuClient`의 `ClientBuilder::connect_timeout()`. 미설정이면 빌더 호출 자체가 없어 전 레이어 byte-identical.

**Tech Stack:** Rust (reqwest `ClientBuilder::connect_timeout`, prost/tonic, serde, axum) + TypeScript/React (Zod, RTL).

## Global Constraints

- **미설정(`None`) = byte-identical.** `connect_timeout`이 없으면 `ClientBuilder::connect_timeout()`을 **호출하지 않는다**. `Some(Duration::ZERO)`는 어떤 경로로도 만들어지면 안 된다 — reqwest가 0을 즉시-실패 타임아웃으로 설치한다(Task 2 Step 4의 `filter(|s| *s > 0)`가 방어선).
- **와이어 이름 고정**: proto/store/JSON = `connect_timeout_seconds` (u32, 초). 엔진 내부 = `connect_timeout: Option<Duration>`. UI 상태 = `connectTimeout: string`(빈 문자열 = 미설정).
- **`RunPlan`·`store::Profile`에 `Default`를 도입하지 않는다** — struct 리터럴의 컴파일러 강제가 이 레포의 필드-추가 가시성 관례(spec §3.4).
- **reqwest `Error`의 최상위 `Display`/`Debug`를 새로 호출하지 않는다** — URL(크레덴셜 포함 가능)을 렌더한다(엔진 CLAUDE.md). 테스트 진단 메시지에도 금지(kind만 assert).
- **UI 사용자 노출 문구는 `ui/src/i18n/ko.ts` 카탈로그 경유**(ADR-0035) — 라벨·검증문·hint 전부 ko 키로. (같은 파일에 raw 리터럴 선례가 있으나[`RunDialog.tsx:945-947` loopCap] 신규 문구는 카탈로그를 따른다.)
- 커밋 규칙: cargo-영향 커밋은 전체 workspace 게이트라 수 분 → `git commit`을 **단일 FOREGROUND 호출**로. `git commit … | tail`/`| head` 파이프 금지(종료코드 마스킹, git-guard deny). `--no-verify` 금지.

---

## 사용자 스토리 (US) — spec 원문 발췌

> **사고 앵커(원문)**: "부하 테스트 중 수신측 소켓 부족으로 오류 — 테스터엔 그냥 타임아웃·503만 보였고, 수신측 소켓 재사용 설정으로 해결하기까지 원인 파악이 너무 오래 걸렸다." (2026-08-01 사용자)

- **US3** *(이 슬라이스)*: QA가 타임아웃의 정체를 좁히기 위해 connect 타임아웃을 별도 설정하고 재실행한다 — 성공하면 connect 단계에서 막힌 요청이 `connect_timeout` 클래스로 분리돼 "서버가 연결 자체를 못 받는 상태"라는 결정적 신호를 본다(미설정 시 현행 거동·와이어 byte-identical).

이 슬라이스의 오라클은 US3 하나다. US1/US1'/US2/US4는 E1·E2에서 이미 라이브 PROVEN.

---

## 사전 실측 (orchestrator 확인 + spec-plan-reviewer 교차검증 완료)

구현자는 아래를 **확인된 사실**로 취급해도 된다. 1차 plan의 오측 4건은 리뷰에서 적발돼 정정됐다(아래 값이 정본).

| 사실 | 확인 방법 |
|---|---|
| `RunPlan` = `crates/engine/src/runner.rs:49-98` (spec의 `:277`은 stale) | `grep -rn "pub struct RunPlan" crates/` |
| **`RunPlan {` 리터럴 = 43곳**이 필드 추가 필요. 매치는 44지만 `crates/engine/tests/vu_curve.rs:354`는 `..curve_plan(…)` struct-update라 **면제**. 파일 = engine 테스트 **19개** + `crates/worker/tests/abort_and_env.rs` + `crates/worker/src/lib.rs` | `grep -rn "RunPlan {" crates/`, `sed -n '352,360p' crates/engine/tests/vu_curve.rs` |
| `VuClient::with_timeout(cookie_mode, timeout, measure_phases)` = `executor.rs:32`. 호출부 6곳 = `executor.rs:26`(`new`)·`:1532`·`:1549`(테스트), `runner.rs:396`·`:1118`·`:1279` | `grep -rn "with_timeout" crates/` |
| **`runner.rs:396`은 `async fn run_vu`(`:382`) 안, `:1118`은 `async fn run_vu_curve`(`:1099`) 안이고 두 함수 모두 `plan`이 스코프에 없다** — `http_timeout`/`measure_phases`는 **함수 파라미터**다. `plan`이 있는 곳은 open-loop `:1279`뿐(`let http_timeout = plan.http_timeout;` `:1267`) | `sed -n '378,400p;1095,1122p' crates/engine/src/runner.rs` |
| proto `Profile` 현재 최대 필드 번호 = **14** → 신규는 **15** | `sed -n '/^message Profile/,/^}/p' crates/proto/proto/coordinator.proto` |
| **`store::Profile {` 리터럴 churn = 23곳**(`crates/controller/src` 17 + `crates/controller/tests` 6). 1차 plan의 "72"는 오측(grep이 함수 시그니처 `-> Profile {`·`pb::Profile {`·struct-update `..ol_profile()`를 섞어 셌다), 2차의 "17"은 **스코프 누락**(`crates/controller/src/`만 봐서 통합테스트 타깃을 놓쳤다 — `--all-targets`는 컴파일한다). **스코프는 `crates/`로 볼 것.** 전수 목록은 Task 3 Step 6 | `grep -rn "Profile {" crates/controller/ \| grep -v "pb::\|v1::\|-> Profile {"` + 각 리터럴의 **depth-1** `..` 유무 확인(중첩 `Criteria { ..Default::default() }`에 속는다 — `store/runs.rs:923`이 그 예) |
| **`crates/controller/src/grpc/coordinator.rs:1918`이 `pb::Profile`을 14필드 전수 리터럴로 짓는다**(`..Default::default()` 없음) → proto 필드 추가 시 **컨트롤러 크레이트가 깨진다**. `crates/proto/tests/run_assignment_env_test.rs:16`·`:65`도 전수. 반면 `crates/proto/src/lib.rs`·`crates/worker/src/lib.rs`의 `pb::Profile` 리터럴은 전부 `..Default::default()` → 0-diff | `sed -n '1918,1935p' crates/controller/src/grpc/coordinator.rs` |
| `store::Profile.http_timeout_seconds`는 `#[serde(default = "default_http_timeout")]`(기본 30, `store/runs.rs:127-128`) → **항상 실값** = 교차검증에 "미설정" 분기 없음 | 파일 직접 확인 |
| `validate_run_config`의 http_timeout 검사 = `api/runs.rs:413-417`. 호출자 4곳(전부 비테스트) = `api/runs.rs:976`(POST /api/runs)·`api/presets.rs:84`·`:144`·`api/schedules.rs:182`·`schedule/runner.rs:142`(스케줄 발사 시 재검증) | `grep -rn "validate_run_config" crates/controller/src/` |
| **하위호환 안전**: 신규 필드라 기존 저장 `profile_json`엔 키가 없다 → `None` → 새 `if let Some(ct)` 블록 자체를 건너뜀 → 기존 프리셋·스케줄이 뒤늦게 400을 맞는 경로 **없음** | 위 4개 호출자 전수 확인 |
| store→proto `Profile` 매핑 **프로덕션 사이트 1곳** = `api/runs.rs:727-766`, 마지막 필드 `graceful_ramp_down_seconds: profile.graceful_ramp_down_seconds` (`:765`) | `grep -rn "v1::Profile {" crates/` |
| 워커 assignment→`RunPlan` = `crates/worker/src/lib.rs:233`, 마지막 필드 `graceful_ramp_down,` (`:297`) | `sed -n '233,298p' crates/worker/src/lib.rs` |
| 워커는 `http_timeout_seconds == 0 → 30` 방어 선례를 이미 갖는다(`lib.rs:243-249`) — 0 방어의 근거 | 파일 직접 확인 |
| UI `buildProfile` = `profileForm.ts:134`, `ProfileFormInput` = `:119-133`. **RunDialog와 ScheduleForm이 공유**. optional 필드 선례 `applyScenarioThink?`/`scenarioHasThink?` 존재 | `grep -rn "buildProfileShared" ui/src/` |
| **ScheduleForm은 `initial.profile`을 `buildProfileShared`로 통째 재구성한다**(`ScheduleForm.tsx:53`, `:244-254`) → 넘기지 않는 필드는 **편집 시 소실**. `connectTimeout`을 pass-through 안 하면 API로 설정된 스케줄의 값이 UI 편집 한 번에 사라진다 | `sed -n '48,60p;240,262p' ui/src/components/ScheduleForm.tsx` |
| `gracefulCap`이 "빈 문자열 = 미설정" string-draft 정본 선례(`RunDialog.tsx:101-105`, 프리셋 로더 `:304`) | `grep -n "gracefulCap" ui/src/components/RunDialog.tsx` |
| RunDialog 카운터 3종: `advancedActiveCount`(`:390`)·**`collapseHintCount`(`:393`)**·`detailedAppliedCount`(`:396-410`). `collapseHintCount`가 접힌 '판정·고급' 그룹의 hint를 만든다(`:836`) | `sed -n '388,412p' ui/src/components/RunDialog.tsx` |
| `RunDialog.tsx:1021-1031`의 검증-사유 목록은 **모든 항이 `(mode === "simple" \|\| !advancedOpen) &&`로 가드**된다(펼침 상태에선 인라인 에러와 중복되므로) | `sed -n '1014,1032p' ui/src/components/RunDialog.tsx` |
| `mode` 초기값(`:182-184`)은 `opensDetailed(initial.profile, initial.env)`면 `"detailed"`. `appliedDetail` 칩은 `mode === "simple"`일 때만 렌더(`:1004-1013`) → **프리필과 칩은 한 렌더에서 공존 불가** | 파일 직접 확인 |
| RTL 관례: `toDetailed(user)`(`RunDialog.test.tsx:79`)는 상세 라디오만 클릭 → 접힌 그룹은 `user.click(screen.getByRole("button", { name: /판정·고급/ }))`로 **한 번 더** 펼쳐야 한다(`:404`·`:432` 선례). payload는 `JSON.parse((call![1] as RequestInit).body as string)`(`:124-132`), 골든은 `DEFAULT_SIMPLE_PROFILE`(`:94`) | 파일 직접 확인 |
| controller 테스트 헬퍼 실명: `state_with(db, capacity).await`(`api/runs.rs:1374`)·`think_profile(…)`(`:1729`)·`ol_profile()`(`:1783`)·`closed_min()`(`:2585`)·`profile_fixture(\|p\| …)`(`store/runs.rs:519`). **"키 부재" 직렬화 테스트 선례** = `none_graceful_cap_omitted_from_json`(`store/runs.rs:1035-1043`) | `grep -n "fn state_with\|fn ol_profile\|fn closed_min\|fn think_profile" …` |
| **`ReportJson`(`report.rs:14-52`)엔 profile 필드가 없다** → 리포트 JSON으로 `connect_timeout_seconds` 부재를 확인하는 것은 **공허**. 확인은 `GET /api/runs/{id}`의 `profile`로 | `grep -n "pub struct ReportJson" -A 40 crates/controller/src/report.rs` |
| **비라우팅 IP `10.255.255.1:81`이 이 머신에서 결정적으로 connect-stall**(리뷰어 독립 실측: raw 소켓 >2.6초 무응답) → spec §9.1이 plan으로 미룬 "비라우팅 IP vs backlog-포화"는 **비라우팅 IP 확정** | `cargo test -p handicap-engine --test error_kind connect_stall` → `1 passed … 0.50s` |
| **E1이 `ErrorKind::ConnectTimeout` 분류 규칙과 통합 테스트 ⑤를 이미 출하**(`error_kind.rs:78-84`, `tests/error_kind.rs:97-116`, 재실행 통과 확인) → 이 슬라이스는 분류기를 건드리지 않는다 | 위 명령 |
| **대조군 `knob_off`는 공허하지 않다**: reqwest 0.12.28에서 전체-요청 타임아웃은 `error::request(TimedOut)`을 내고 그 체인엔 `hyper_util` connect 에러가 없어 `is_connect() == false` → 규칙 2 → `ErrorKind::Timeout` (리뷰어가 reqwest 소스로 확인) | 리뷰어 교차검증 |

---

## 이 slice에서 내린 결정 (리뷰 M1/M2/M3/M4 응답)

- **M1 — `http_timeout_seconds <= 1`이면 노브가 설정 불가**(`1..=600 ∩ < http_timeout` = ∅): **수용**. 입력을 `disabled`로 만들지 않는다 — 인라인 검증문("HTTP 타임아웃보다 작아야 합니다")이 이미 탈출구(=http_timeout을 올려라)를 알려주고, 무설명 disabled가 오히려 나쁘다. 기본 http_timeout이 30이라 실사용 빈도도 극히 낮다.
- **M2 — per-step timeout 한계**(spec §5.1 "명시" 요구): `HttpStep.timeout_seconds`(`scenario.rs:96`, 적용 `executor.rs:161`)가 run-level보다 짧으면 그 스텝에선 전체-타임아웃이 먼저 발화해 kind가 `timeout`으로 남는다. cross-field 검사는 run-level만 보증한다. → **Task 3 Step 4의 필드 doc-comment에 명시**하고 라이브 검증 표에 caveat 행으로 남긴다.
- **M3 — Zod 경계**: `.int().positive().optional()`(서버 1..=600 재현 안 함). 근거 = 같은 모양의 optional 노브 `graceful_ramp_down_seconds`가 쓰는 선례이고, 상한을 클라에 복제하면 서버와 드리프트한다. 실질 방어는 `connectTimeoutInvalid` 술어(1..600 + `< httpTimeout`)가 제출 전에 하고, 서버가 최종 권위다.
- **M4 — 프리셋 dirty 추적**(`currentProfileKey = JSON.stringify(buildProfile())`, `RunDialog.tsx:597`)은 `buildProfile`에 필드가 실리는 순간 **자동으로** 새 값을 반영한다. 별도 배선 불필요(리뷰어가 "빠진 배선점"으로 오해하지 않도록 기록).
- **spec §7.4 ①~⑤ ↔ 이 plan의 배선점 매핑**(리뷰 C4): spec① advancedPrefill → plan② · spec② 제출 게이트 → plan③ · spec③ detailedAppliedCount → plan④ · spec④ 프리셋 로더 → plan⑤ · spec⑤ 프리셋 술어 → plan⑤. plan은 여기에 **①(state+prefill)·⑥(`collapseHintCount`)·payload·입력 UI**를 더한다. ⑥은 spec에 없던 신규 발견(리뷰 R2).

---

## 파일 구조

| 파일 | 책임 | Task |
|---|---|---|
| `crates/engine/src/runner.rs` | `RunPlan.connect_timeout` + **9개 지점**(locals 3·시그니처 2·호출부 2·빌더 3 중 중복 제외) 스레딩 | 1 |
| `crates/engine/src/executor.rs` | `VuClient::with_timeout` 4번째 인자 + 조건부 빌더 체이닝 | 1 |
| `crates/engine/tests/connect_timeout_knob.rs` *(신규)* | 노브 ON/OFF가 kind를 가르는지 — US3 엔진-레벨 오라클 | 1 |
| `RunPlan {` 리터럴 43곳 (engine 테스트 19파일 + worker 2파일) | churn | 1 |
| `crates/proto/proto/coordinator.proto` | `Profile.connect_timeout_seconds = 15` | 2 |
| `crates/worker/src/lib.rs` | proto→`RunPlan` 매핑 + `Some(0)` 방어 | 2 |
| `crates/controller/src/grpc/coordinator.rs:1918`, `crates/proto/tests/run_assignment_env_test.rs:16,65` | 전수 prost 리터럴 churn | 2 |
| `crates/controller/src/store/runs.rs` | `Profile.connect_timeout_seconds` + 직렬화 테스트 | 3 |
| `crates/controller/src/api/runs.rs` | 검증 2규칙 + store→proto 매핑 | 3 |
| `store::Profile {` 리터럴 17곳 | churn | 3 |
| `ui/src/api/schemas.ts` · `profileForm.ts` · `RunDialog.tsx` · `ScheduleForm.tsx` · `i18n/ko.ts` | Zod + payload + 배선 6지점 + pass-through | 4 |

---

### Task 1: 엔진 — `RunPlan.connect_timeout` → `VuClient`

**Files:**
- Modify: `crates/engine/src/executor.rs:25-53`
- Modify: `crates/engine/src/runner.rs` — 9개 지점(Step 5에 전수)
- Create: `crates/engine/tests/connect_timeout_knob.rs`
- Modify (churn): `RunPlan {` 리터럴 43곳 — engine 테스트 19파일 + `crates/worker/tests/abort_and_env.rs:47,78` + `crates/worker/src/lib.rs:233`. `crates/engine/tests/vu_curve.rs:354`는 struct-update라 **면제**.

**Interfaces:**
- Produces: `RunPlan { …, pub connect_timeout: Option<Duration> }` — Task 2의 워커 매핑이 채운다.
- Produces: `VuClient::with_timeout(cookie_mode: CookieJarMode, timeout: Duration, measure_phases: bool, connect_timeout: Option<Duration>) -> Result<Self>`

- [ ] **Step 1: 실패하는 테스트 작성**

`crates/engine/tests/connect_timeout_knob.rs` 신규:

```rust
// spec 2026-08-01-error-taxonomy §3.4 (E3): RunPlan.connect_timeout이 VuClient의
// reqwest connect_timeout까지 도달해, connect 단계 정지를 전체-요청 `timeout`이 아닌
// `connect_timeout`으로 가르는지 핀 고정. 이 판별이 US3의 전부다.
// 진단 출력에 reqwest Error의 Display/Debug 금지(Global) — kind만 assert.
use handicap_engine::{ErrorKind, MetricFlush, RampDown, RunPlan, Scenario, run_scenario};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

// 비라우팅 IP — SYN에 응답이 없어 connect 단계에서 정지한다. 실측 확정:
// E1의 `tests/error_kind.rs::connect_stall_classifies_connect_timeout`이 같은 주소로
// 0.5초에 결정적 통과, raw 소켓으로 >2.6초 무응답 확인 → 아래 1초 임계는 안전.
// spec §9.1이 남긴 backlog-포화 대체안은 불필요.
const YAML: &str = "version: 1
name: ct
steps:
  - id: 01HX0000000000000000000001
    type: http
    name: stall
    request:
      method: GET
      url: http://10.255.255.1:81/
";

fn plan(http_timeout: Duration, connect_timeout: Option<Duration>) -> RunPlan {
    RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        // http_timeout(최대 5s)보다 길어야 노브 OFF 대조군에서도 실제 타임아웃이
        // 기록된다 — 짧으면 run deadline이 먼저 끊어 분포가 빈 채로 끝난다.
        duration: Duration::from_millis(6000),
        env: Default::default(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_bindings: vec![],
        http_timeout,
        think_time: None,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
        stages: None,
        measure_phases: false,
        vu_stages: None,
        ramp_down: RampDown::Graceful,
        graceful_ramp_down: None,
        connect_timeout,
    }
}

async fn kind_totals(
    http_timeout: Duration,
    connect_timeout: Option<Duration>,
) -> Vec<(ErrorKind, u64)> {
    let scenario = Arc::new(Scenario::from_yaml(YAML).unwrap());
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let h = tokio::spawn(run_scenario(
        scenario,
        plan(http_timeout, connect_timeout),
        tx,
        CancellationToken::new(),
    ));
    let mut totals: std::collections::BTreeMap<ErrorKind, u64> = Default::default();
    while let Some(f) = rx.recv().await {
        for s in &f.error_kind_stats {
            *totals.entry(s.kind).or_default() += s.count;
        }
    }
    h.await.unwrap().unwrap();
    totals.into_iter().collect()
}

#[tokio::test]
async fn knob_on_classifies_connect_timeout() {
    // connect 1s < 전체 3s → connect 타임아웃이 먼저 발화 → is_timeout && is_connect.
    // http_timeout을 3s로 둔 이유: Step 8의 고의 회귀(노브 무시) 시에도 6s run 안에서
    // 전체 타임아웃이 여유 있게 발화해 RED 분포가 결정적으로 [(Timeout, N)]이 된다
    // (5s면 마진 1s라 지터에 따라 []가 나와 예측이 어긋난다).
    let totals = kind_totals(Duration::from_secs(3), Some(Duration::from_secs(1))).await;
    let ct = totals
        .iter()
        .find(|(k, _)| *k == ErrorKind::ConnectTimeout)
        .map(|(_, c)| *c);
    assert!(
        ct.is_some_and(|c| c > 0),
        "connect_timeout이 집계돼야 한다. 실제 분포: {totals:?}"
    );
    assert!(
        !totals.iter().any(|(k, _)| *k == ErrorKind::Timeout),
        "노브 ON이면 일반 timeout으로 새면 안 된다. 실제 분포: {totals:?}"
    );
}

#[tokio::test]
async fn knob_off_classifies_plain_timeout() {
    // 대조군: 노브 없이 전체 타임아웃만 2s → 단계 불명 `timeout`.
    // spec 리뷰 R14: 전체-타임아웃이 먼저 터지면 is_connect가 성립하지 않는다.
    let totals = kind_totals(Duration::from_secs(2), None).await;
    let t = totals
        .iter()
        .find(|(k, _)| *k == ErrorKind::Timeout)
        .map(|(_, c)| *c);
    assert!(
        t.is_some_and(|c| c > 0),
        "노브 미설정이면 timeout이어야 한다. 실제 분포: {totals:?}"
    );
    assert!(
        !totals.iter().any(|(k, _)| *k == ErrorKind::ConnectTimeout),
        "노브 미설정인데 connect_timeout이 나오면 대조가 무의미. 실제 분포: {totals:?}"
    );
}
```

- [ ] **Step 2: 테스트가 컴파일 실패하는지 확인**

Run: `cargo test -p handicap-engine --test connect_timeout_knob 2>&1 | tail -20`
Expected: FAIL — `struct RunPlan has no field named connect_timeout`.

- [ ] **Step 3: `VuClient::with_timeout`에 4번째 인자 추가**

`crates/engine/src/executor.rs` — `new`(:25-27)와 `with_timeout`(:32-53):

```rust
    /// Back-compat constructor: 30s total request timeout, no phase instrumentation,
    /// no separate connect timeout. trace/test-run 경로(`trace.rs:153,187`)가 이걸
    /// 쓰므로 E3 노브는 그 경로에 자동으로 미적용된다(spec §2 Non-goal).
    pub fn new(cookie_mode: CookieJarMode) -> Result<Self> {
        Self::with_timeout(cookie_mode, Duration::from_secs(30), false, None)
    }

    /// Build a client with an explicit total request timeout and optional phase
    /// instrumentation. `run_vu`/`run_arrival`/`run_vu_curve` thread `RunPlan.http_timeout`,
    /// `RunPlan.measure_phases`, `RunPlan.connect_timeout`; `new` delegates here with
    /// the 30s default + off + None.
    ///
    /// `connect_timeout`이 `None`이면 `ClientBuilder::connect_timeout`을 **호출하지 않는다**
    /// — 미설정 run의 byte-identical 불변식(spec §8).
    pub fn with_timeout(
        cookie_mode: CookieJarMode,
        timeout: Duration,
        measure_phases: bool,
        connect_timeout: Option<Duration>,
    ) -> Result<Self> {
        let mut builder = reqwest::Client::builder()
            .timeout(timeout)
            .user_agent("handicap/0.1");
        if let Some(ct) = connect_timeout {
            builder = builder.connect_timeout(ct);
        }
        if let CookieJarMode::Auto = cookie_mode {
            let jar = Arc::new(Jar::default());
            builder = builder.cookie_provider(jar);
        }
        if measure_phases {
            builder = crate::conn_timing::install(builder);
        }
        let inner = builder.build()?;
        Ok(Self {
            inner,
            measure_phases,
        })
    }
```

`executor.rs:1532`·`:1549`의 테스트 호출에 `None` 4번째 인자 추가.

- [ ] **Step 4: `RunPlan`에 필드 추가**

`crates/engine/src/runner.rs` — `RunPlan`의 `graceful_ramp_down` 뒤(구조체는 `:49-98`):

```rust
    /// connect(TCP+TLS) 단계 전용 타임아웃 (E3, spec §3.4). `Some`이면
    /// `ClientBuilder::connect_timeout`으로 설치돼, connect에서 막힌 요청이
    /// 전체-요청 `timeout`이 아니라 `ErrorKind::ConnectTimeout`으로 분류된다.
    /// `None` = 미설정(오늘과 byte-identical — 빌더 호출 자체가 없음).
    /// 컨트롤러가 `connect_timeout_seconds < http_timeout_seconds`를 강제한다.
    pub connect_timeout: Option<Duration>,
```

- [ ] **Step 5: `runner.rs` 9개 지점 스레딩**

**중요**: `run_vu`·`run_vu_curve`는 `plan`을 스코프에 갖지 않는다 — `http_timeout`은 **함수 파라미터**다. 따라서 `plan.connect_timeout`을 함수 안에서 읽을 수 없고, `http_timeout`과 **똑같이** 파라미터로 흘려야 한다. 두 함수 모두 이미 `#[allow(clippy::too_many_arguments)]`가 붙어 있어(`:380`·`:1097`) 인자 추가로 새 lint가 뜨지 않는다.

| # | 위치 | 편집 |
|---|---|---|
| 1 | `runner.rs:157` 부근 (closed-loop 본문의 `let http_timeout = plan.http_timeout;` 옆) | `let connect_timeout = plan.connect_timeout;` 지역 바인딩 추가 |
| 2 | `runner.rs:784` 부근 (VU-curve 본문의 동일 지역 바인딩 옆) | 동일 |
| 3 | `runner.rs:1267` 부근 (open-loop 본문) | 동일 |
| 4 | `async fn run_vu(...)` 시그니처 `:382-395` | `measure_phases: bool,` 뒤에 `connect_timeout: Option<Duration>,` 파라미터 추가 |
| 5 | `async fn run_vu_curve(...)` 시그니처 `:1099-1115` | 동일 |
| 6 | `run_vu` 호출부 `:205-218` 부근 | 인자 `connect_timeout` 전달 |
| 7 | `run_vu_curve` 호출부 `:892-908` 부근 | 인자 `connect_timeout` 전달 |
| 8 | `runner.rs:396` (`run_vu` 본문 클라이언트 빌드) | `VuClient::with_timeout(scenario.cookie_jar, http_timeout, measure_phases, connect_timeout)?` |
| 9 | `runner.rs:1118` (`run_vu_curve` 본문) + `:1279` (open-loop, 여기만 `plan` 스코프 있음) | 동일하게 4번째 인자 |

정확한 줄번호는 편집 중 이동하므로 `grep -n "http_timeout" crates/engine/src/runner.rs`로 **`http_timeout`이 나오는 모든 지점을 정본으로 삼아 1:1 미러링**할 것 — `connect_timeout`은 `http_timeout`과 완전히 같은 경로를 탄다.

- [ ] **Step 6: `RunPlan {` 리터럴 43곳 churn**

Run: `cargo build --workspace --all-targets 2>&1 | grep "missing field \`connect_timeout\`" | wc -l`

0이 될 때까지 반복(한 번의 빌드는 lib/test 유닛을 다 못 볼 수 있다). 각 리터럴 마지막에 `connect_timeout: None,` 추가. `crates/engine/tests/vu_curve.rs:354`는 struct-update라 손대지 않는다.

`crates/engine/tests/error_kind_flush.rs:26-48` — E1이 남긴 주석("E3 전이라 connect_timeout 없음")도 함께 갱신:

```rust
        graceful_ramp_down: None,
        connect_timeout: None,
    }
}
// ↑ 리터럴은 작성 시점 RunPlan 필드 전수 — 컴파일 에러가 나면
// `crates/engine/tests/think_time.rs`의 동일 리터럴을 정본으로 맞출 것.
```

`crates/worker/src/lib.rs:233`의 `RunPlan {` 리터럴에도 지금은 `connect_timeout: None,`을 넣는다 — **Task 2가 실제 매핑으로 교체할 의도적 임시값**이다(커밋 메시지 본문에 명시해 bisect 시 최종 거동으로 오독되지 않게).

- [ ] **Step 7: 테스트 통과 확인**

Run: `cargo test -p handicap-engine --test connect_timeout_knob 2>&1 | tail -20`
Expected: PASS — 2 passed.

- [ ] **Step 8: 회귀 가드 이빨 실증 (고의 회귀 → RED → 원복 → GREEN)**

`plan-mandated-vacuous-tests` 규율. `runner.rs:396`(`run_vu`)의 4번째 인자를 `connect_timeout` → `None`으로 **일시 교체**:

Run: `cargo test -p handicap-engine --test connect_timeout_knob knob_on 2>&1 | tail -20`
Expected: **FAIL** — 첫 assert가 터진다. 분포는 `[(Timeout, N)]`(duration 6s > http_timeout 3s라 전체 타임아웃이 여유 있게 기록됨). 원복 후 재실행 → PASS. **RED 출력을 커밋 메시지 본문이나 리포트에 인용할 것** — 인용 없으면 실증 미완.

- [ ] **Step 9: 전체 게이트**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -20`
Expected: 경고 0.

Run: `cargo test --workspace 2>&1 | tail -30`
Expected: 전부 PASS (특히 `error_kind_flush`·`http_timeout`·`phase_breakdown`·`vu_curve`).

- [ ] **Step 10: 커밋**

```bash
git add crates/engine crates/worker
git commit -m "feat(engine): RunPlan.connect_timeout → VuClient 조건부 connect_timeout (E3 Task 1)

worker/src/lib.rs:233의 connect_timeout: None은 Task 2가 실제 proto 매핑으로
교체할 임시값이다(컴파일 유지용). 최종 거동 아님."
```

---

### Task 2: proto + 워커 매핑

**Files:**
- Modify: `crates/proto/proto/coordinator.proto` (`message Profile`, 필드 15)
- Modify: `crates/worker/src/lib.rs` (헬퍼 + `:233` 리터럴)
- Modify (전수 prost 리터럴 churn): `crates/controller/src/grpc/coordinator.rs:1918`, `crates/proto/tests/run_assignment_env_test.rs:16`, `:65`
- Test: `crates/worker/src/lib.rs` 인라인 `#[cfg(test)]`

**Interfaces:**
- Consumes: `RunPlan.connect_timeout: Option<Duration>` (Task 1)
- Produces: proto `Profile.connect_timeout_seconds: Option<u32>` — Task 3의 컨트롤러 매핑이 채운다.
- Produces: `fn proto_connect_timeout(p: &pb::Profile) -> Option<std::time::Duration>`

- [ ] **Step 1: 실패하는 테스트 작성**

`crates/worker/src/lib.rs`의 기존 `#[cfg(test)] mod tests` 안(`pb::Profile`을 쓰는 테스트가 `:762`부터 있고 전부 `..Default::default()` 관례):

```rust
    #[test]
    fn connect_timeout_maps_seconds_to_duration() {
        // E3: proto optional uint32 → Option<Duration> 직결.
        let p = pb::Profile {
            duration_seconds: 10,
            http_timeout_seconds: 30,
            connect_timeout_seconds: Some(3),
            ..Default::default()
        };
        assert_eq!(
            proto_connect_timeout(&p),
            Some(std::time::Duration::from_secs(3))
        );
    }

    #[test]
    fn connect_timeout_absent_maps_to_none() {
        // 구 컨트롤러(필드 부재) → None → 빌더 호출 없음(byte-identical).
        let p = pb::Profile {
            duration_seconds: 10,
            http_timeout_seconds: 30,
            ..Default::default()
        };
        assert_eq!(proto_connect_timeout(&p), None);
    }

    #[test]
    fn connect_timeout_zero_maps_to_none() {
        // Some(0)을 그대로 넘기면 reqwest가 "즉시 실패" 타임아웃을 설치해 모든 요청이
        // 깨진다. 컨트롤러가 0을 거부하지만 워커가 신뢰 경계 —
        // http_timeout_seconds==0 → 30 방어(lib.rs:243-249)와 같은 자리.
        let p = pb::Profile {
            duration_seconds: 10,
            http_timeout_seconds: 30,
            connect_timeout_seconds: Some(0),
            ..Default::default()
        };
        assert_eq!(proto_connect_timeout(&p), None);
    }
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cargo test -p handicap-worker connect_timeout 2>&1 | tail -20`
Expected: FAIL — `no field connect_timeout_seconds` / `cannot find function proto_connect_timeout`.

- [ ] **Step 3: proto 필드 추가**

`crates/proto/proto/coordinator.proto`의 `message Profile` 마지막 줄(`optional uint32 graceful_ramp_down_seconds = 14;`) 뒤:

```proto
  optional uint32 connect_timeout_seconds = 15;  // E3: connect 단계 전용 타임아웃(초); 부재 = 미설정
```

- [ ] **Step 4: 워커 매핑 헬퍼 + 리터럴 배선**

```rust
/// E3: proto `optional uint32`(초) → 엔진 `Option<Duration>`. 부재 = 미설정.
/// `Some(0)`은 `None`으로 접는다 — reqwest는 0을 즉시-실패 타임아웃으로 설치하므로
/// 신뢰 경계에서 막는다(`http_timeout_seconds == 0 → 30` 방어와 같은 이유).
fn proto_connect_timeout(p: &pb::Profile) -> Option<std::time::Duration> {
    p.connect_timeout_seconds
        .filter(|s| *s > 0)
        .map(|s| std::time::Duration::from_secs(u64::from(s)))
}
```

`graceful_ramp_down`과 같이 `RunPlan {` 리터럴 **위에서** 바인딩(부분 이동 제약):

```rust
    let connect_timeout = proto_connect_timeout(&profile);
```

Task 1이 넣은 `connect_timeout: None,`을 교체:

```rust
        graceful_ramp_down,
        // E3: connect 단계 전용 타임아웃. 부재/0 = None = 빌더 호출 없음(byte-identical).
        connect_timeout,
    };
```

- [ ] **Step 5: 전수 prost 리터럴 churn 3곳**

`..Default::default()` 없이 14필드를 다 쓰는 리터럴만 깨진다. `connect_timeout_seconds: None,` 추가:
- `crates/controller/src/grpc/coordinator.rs:1918` (**controller 크레이트** — 이걸 놓치면 workspace 빌드가 깨진다)
- `crates/proto/tests/run_assignment_env_test.rs:16`, `:65`

Run: `cargo build --workspace --all-targets 2>&1 | grep "missing field \`connect_timeout_seconds\`" | wc -l`
Expected: 0 (반복해서 0이 될 때까지).

- [ ] **Step 6: 테스트 통과 확인**

Run: `cargo test -p handicap-worker connect_timeout 2>&1 | tail -20`
Expected: PASS — 3 passed.

Run: `cargo test -p handicap-proto 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 7: 게이트 + 커밋**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -20`
Expected: 경고 0.

```bash
git add crates/proto crates/worker crates/controller
git commit -m "feat(proto,worker): Profile.connect_timeout_seconds=15 → RunPlan 매핑 + Some(0) 방어 (E3 Task 2)"
```

---

### Task 3: controller — store `Profile` + 검증 2규칙 + dispatch 매핑

**Files:**
- Modify: `crates/controller/src/store/runs.rs` (`Profile` struct + 직렬화 테스트)
- Modify: `crates/controller/src/api/runs.rs:413-418`(검증), `:765`(proto 매핑) + 검증 테스트
- Modify (churn **23곳** — `crates/controller/src` 17 + `crates/controller/tests` 6): Step 6의 전수 목록
- Test: `store/runs.rs` 인라인(직렬화) + `api/runs.rs` 인라인(검증)

**Interfaces:**
- Consumes: proto `Profile.connect_timeout_seconds: Option<u32>` (Task 2)
- Produces: `store::Profile.connect_timeout_seconds: Option<u32>` — `skip_serializing_if` → 미설정이면 JSON **키 부재**(null 아님) → Task 4 Zod가 `.optional()`인 근거.

- [ ] **Step 1: 실패하는 테스트 작성 (직렬화 — `store/runs.rs`)**

`crates/controller/src/store/runs.rs`의 `none_graceful_cap_omitted_from_json`(`:1035-1043`) 바로 뒤, 같은 `profile_fixture` 관례로:

```rust
    #[test]
    fn none_connect_timeout_omitted_from_json() {
        // skip_serializing_if → 키 부재(null 아님). UI Zod `.optional()`의 근거.
        let p = profile_fixture(|_| {}); // connect_timeout_seconds: None
        let j = serde_json::to_value(&p).unwrap();
        assert!(
            j.get("connect_timeout_seconds").is_none(),
            "None must be omitted (byte-identical)"
        );
    }

    #[test]
    fn profile_json_without_connect_timeout_deserializes() {
        // 하위호환: E3 이전에 저장된 profile_json엔 키가 없다.
        let p: Profile = serde_json::from_str(r#"{"duration_seconds":10}"#).unwrap();
        assert_eq!(p.connect_timeout_seconds, None);
    }
```

- [ ] **Step 2: 실패하는 테스트 작성 (검증 — `api/runs.rs`)**

기존 `validate_run_config` 테스트들과 같은 관례로. `state_with(db, capacity).await`(`:1374`)·`closed_min()`(`:2585`)를 쓰고, state 생성 2줄은 인접 `graceful_ramp_down_seconds` 테스트(`:2473-2541`)와 동일:

```rust
    #[tokio::test]
    async fn connect_timeout_zero_is_rejected() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 0).await;
        let mut p = closed_min();
        p.http_timeout_seconds = 30;
        p.connect_timeout_seconds = Some(0);
        let err = validate_run_config(&state, &p).await.unwrap_err();
        assert!(
            matches!(&err, ApiError::BadRequest(m) if m.contains("between 1 and 600")),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn connect_timeout_over_600_is_rejected() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 0).await;
        let mut p = closed_min();
        p.http_timeout_seconds = 600;
        p.connect_timeout_seconds = Some(601);
        let err = validate_run_config(&state, &p).await.unwrap_err();
        assert!(
            matches!(&err, ApiError::BadRequest(m) if m.contains("between 1 and 600")),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn connect_timeout_equal_to_http_timeout_is_rejected() {
        // 경계: 같아도 거부(< 강제). 어느 쪽이 먼저 발화할지 보장 못 하면 분류가 무의미.
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 0).await;
        let mut p = closed_min();
        p.http_timeout_seconds = 5;
        p.connect_timeout_seconds = Some(5);
        let err = validate_run_config(&state, &p).await.unwrap_err();
        assert!(
            matches!(&err, ApiError::BadRequest(m) if m.contains("less than http_timeout_seconds")),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn connect_timeout_below_http_timeout_is_accepted() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 0).await;
        let mut p = closed_min();
        p.http_timeout_seconds = 5;
        p.connect_timeout_seconds = Some(4);
        assert!(validate_run_config(&state, &p).await.is_ok());
    }

    #[tokio::test]
    async fn connect_timeout_absent_is_accepted() {
        // 미설정 = 오늘과 동일 경로(하위호환 — 기존 프리셋/스케줄이 400을 맞지 않는다).
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 0).await;
        let mut p = closed_min();
        p.connect_timeout_seconds = None;
        assert!(validate_run_config(&state, &p).await.is_ok());
    }
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `cargo test -p handicap-controller connect_timeout 2>&1 | tail -20`
Expected: FAIL — `no field connect_timeout_seconds on type Profile`.

- [ ] **Step 4: `store::Profile`에 필드 추가**

`crates/controller/src/store/runs.rs` — `graceful_ramp_down_seconds`(`:156-157`) 뒤, `worker_count`(`:161`) 앞:

```rust
    /// connect(TCP+TLS) 단계 전용 타임아웃(초) — E3, spec §3.4. absent = 미설정
    /// (오늘과 byte-identical). `validate_run_config`가 1..=600 이고
    /// `< http_timeout_seconds` 임을 강제한다. skip_serializing_if → UI Zod `.optional()`.
    ///
    /// 한계(spec §5.1 명시): per-step `HttpStep.timeout_seconds` 오버라이드가
    /// run-level `http_timeout_seconds`보다 짧으면 그 스텝에선 전체-요청 타임아웃이
    /// 먼저 발화해 kind가 `connect_timeout`이 아니라 `timeout`으로 남는다 —
    /// cross-field 검사는 run-level만 보증한다(스텝별 검사는 비목표).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect_timeout_seconds: Option<u32>,
```

- [ ] **Step 5: 검증 2규칙 + proto 매핑**

`crates/controller/src/api/runs.rs` — 기존 http_timeout 블록(`:413-417`) **바로 뒤**. 순서가 중요하다: 여기 도달한 시점에 `http_timeout_seconds`는 1..=600으로 검증된 실값이다(serde default 30이 항상 채움) → "미설정" 분기가 없다.

```rust
    if let Some(ct) = profile.connect_timeout_seconds {
        if !(1..=600).contains(&ct) {
            return Err(ApiError::BadRequest(
                "connect_timeout_seconds must be between 1 and 600".into(),
            ));
        }
        // http_timeout_seconds는 바로 위에서 1..=600으로 검증된 실값(serde default 30).
        // 같으면 어느 쪽이 먼저 발화할지 보장 못 하므로 < 를 강제한다.
        if ct >= profile.http_timeout_seconds {
            return Err(ApiError::BadRequest(
                "connect_timeout_seconds must be less than http_timeout_seconds".into(),
            ));
        }
    }
```

`api/runs.rs:765`의 `graceful_ramp_down_seconds: profile.graceful_ramp_down_seconds,` 뒤:

```rust
            connect_timeout_seconds: profile.connect_timeout_seconds,
```

- [ ] **Step 6: `store::Profile {` 리터럴 churn 23곳**

전수 목록(검증됨 — depth-1 struct-update `..ol_profile()` 사이트는 면제. **중첩 `Criteria { ..Default::default() }`에 속지 말 것** — `store/runs.rs:923`은 Profile 자체는 전수라 포함된다):

`crates/controller/src` — 17곳:

```
crates/controller/src/report.rs:1001
crates/controller/src/schedule/runner.rs:294
crates/controller/src/grpc/coordinator.rs:1821
crates/controller/src/grpc/coordinator.rs:1946
crates/controller/src/api/runs.rs:1393
crates/controller/src/api/runs.rs:1607
crates/controller/src/api/runs.rs:1679
crates/controller/src/api/runs.rs:1730
crates/controller/src/api/runs.rs:1784
crates/controller/src/api/runs.rs:2586
crates/controller/src/store/presets.rs:205
crates/controller/src/store/runs.rs:174
crates/controller/src/store/runs.rs:520
crates/controller/src/store/runs.rs:659
crates/controller/src/store/runs.rs:713
crates/controller/src/store/runs.rs:923
crates/controller/src/store/schedules.rs:347
```

`crates/controller/tests` — 6곳(**통합테스트 타깃. `--all-targets`가 컴파일하므로 반드시 포함**. `export_routes_test.rs`는 ADR-0030 export 패리티 표면이라 특히 중요):

```
crates/controller/tests/crash_recovery_test.rs:28
crates/controller/tests/dispatcher_subprocess_test.rs:53
crates/controller/tests/report_test.rs:77
crates/controller/tests/export_routes_test.rs:67
crates/controller/tests/export_routes_test.rs:207
crates/controller/tests/export_routes_test.rs:289
```

각 리터럴에 `connect_timeout_seconds: None,` 추가. Step 5에서 실값으로 배선한 proto 매핑(`api/runs.rs:765`)은 **덮어쓰지 말 것**.

Run: `cargo build --workspace --all-targets 2>&1 | grep "missing field \`connect_timeout_seconds\`" | wc -l`
Expected: 반복해서 0. (한 번의 빌드가 lib/test 유닛을 다 못 보므로 위 23곳을 다 고친 뒤에도 한 번 더 돌릴 것.) `git add crates/controller`가 `crates/controller/tests/`까지 포함하므로 커밋 범위는 그대로다.

- [ ] **Step 7: 테스트 통과 확인**

Run: `cargo test -p handicap-controller connect_timeout 2>&1 | tail -20`
Expected: PASS — 7 passed.

- [ ] **Step 8: 회귀 가드 이빨 실증**

Step 5의 **두 번째** `if` 블록(교차검증)을 일시 삭제:

Run: `cargo test -p handicap-controller connect_timeout_equal 2>&1 | tail -20`
Expected: **FAIL** — `called Result::unwrap_err() on an Ok value`. 원복 후 PASS. **RED 출력 인용 필수.**

- [ ] **Step 9: 전체 게이트**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -20`
Expected: 경고 0.

Run: `cargo test --workspace 2>&1 | tail -30`
Expected: 전부 PASS — 특히 골든 fixture(ADR-0030)와 preset/schedule 라운드트립(미설정이면 키 부재라 무변경).

- [ ] **Step 10: 커밋**

```bash
git add crates/controller
git commit -m "feat(controller): Profile.connect_timeout_seconds + 검증 2규칙 + dispatch 매핑 (E3 Task 3)"
```

---

### Task 4: UI — Zod + payload + RunDialog 배선 6지점 + ScheduleForm pass-through

**Files:**
- Modify: `ui/src/api/schemas.ts` (`ProfileSchema`, `:70-106`)
- Modify: `ui/src/components/profileForm.ts` — `ProfileFormInput` `:119-133` + `buildProfile` `:134-152`
- Modify: `ui/src/components/RunDialog.tsx` (배선 6지점 + 입력 UI)
- Modify: `ui/src/components/ScheduleForm.tsx` (pass-through + 교차검증 가드 — **입력 UI는 만들지 않는다**)
- Modify: `ui/src/i18n/ko.ts:197`, `:245`
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`, `ui/src/components/__tests__/profileForm.test.ts`, `ui/src/components/__tests__/ScheduleForm.test.tsx`

**Interfaces:**
- Consumes: 서버 JSON `connect_timeout_seconds?: number` (Task 3, absent이지 null 아님)
- Produces: `ProfileFormInput.connectTimeout?: string` — 빈 문자열/미전달 = 미설정 → **키 자체를 생략**(spread-conditional).

- [ ] **Step 1: 실패하는 테스트 작성**

`profileForm.test.ts` — payload 형태(기존 `apply_scenario_think_time` 관례 `:242/:246`가 정본). 팩토리는 `base(loadState, extra)`(`:218-229`)이고 **이미 내부에서 `buildProfile`을 호출**한다 — 감싸지 말 것:

```ts
  it("connectTimeout 미전달이면 connect_timeout_seconds 키를 생략한다", () => {
    const p = base(closedLoad);
    expect(p).not.toHaveProperty("connect_timeout_seconds");
  });

  it("connectTimeout 빈 문자열이면 키를 생략한다", () => {
    const p = base(closedLoad, { connectTimeout: "  " });
    expect(p).not.toHaveProperty("connect_timeout_seconds");
  });

  it("connectTimeout 값이 있으면 숫자로 싣는다", () => {
    const p = base(closedLoad, { connectTimeout: "3" });
    expect(p.connect_timeout_seconds).toBe(3);
  });
```

`RunDialog.test.tsx` — 헬퍼는 `renderDialog()`(`:51`)·`renderWithInitial(initial, opts?)`(`:495`), payload는 `:124-132`의 fetchMock 파싱 관례. **`toDetailed(user)`는 상세 라디오만 누른다 — 접힌 '판정·고급' 그룹을 한 번 더 눌러야 입력에 닿는다**(`:404`·`:432` 선례):

```tsx
  // ‼ 이 새 테스트들이 쓰는 프리필 fixture는 **모든 필드가 기본값**이어야 한다.
  // 다른 필드(예: http_timeout_seconds: 120)가 섞이면 advancedPrefill이 그 필드만으로
  // 이미 참이 돼 배선 ② 없이도 (a)가 통과한다 — ②의 유일한 가드가 공허해진다.
  // (T6 describe의 DEFAULT_SIMPLE_PROFILE은 POST 골든이라 재사용 금지: describe 스코프
  //  밖이고, 골든을 나중에 손보면 (a)의 의미가 조용히 바뀐다.)
  const ALL_DEFAULT_PREFILL: RunPrefill = {
    profile: {
      vus: 2,
      duration_seconds: 5,
      ramp_up_seconds: 0,
      loop_breakdown_cap: 256,
      http_timeout_seconds: 30,
      measure_phases: false,
      data_binding: null,
    },
    env: {},
  };

  it("값을 넣으면 payload에 connect_timeout_seconds가 실린다", async () => {
    // fetchMock은 beforeEach에서 mockReset만 되므로(:38) 구현을 주지 않으면 fetch가
    // undefined를 resolve해 mutation이 실패한다 — :103-132 관례를 통째로 따른다.
    fetchMock.mockImplementation(() =>
      jsonResponse({
        id: "R1",
        scenario_id: "S1",
        scenario_yaml: "version: 1\nname: t\nsteps: []\n",
        status: "pending",
        profile: { vus: 2, ramp_up_seconds: 0, duration_seconds: 5 },
        env: {},
        started_at: null,
        ended_at: null,
        created_at: 1,
      }),
    );
    const user = userEvent.setup();
    const { onCreated } = renderDialog();
    await toDetailed(user);
    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    await user.type(screen.getByLabelText(ko.loadModel.connectTimeout), "3");
    await user.click(screen.getByRole("button", { name: ko.runDialog.run }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("R1"));

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.endsWith("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.profile.connect_timeout_seconds).toBe(3);
  });

  it("http_timeout 이상이면 인라인 안내 + 제출 차단", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    await user.type(screen.getByLabelText(ko.loadModel.connectTimeout), "30"); // 기본 http_timeout=30
    // 펼친 상태이므로 인라인 p 하나만 — Callout 중복 없음(:1021-1031 가드).
    expect(screen.getByText(ko.validation.connectTimeout)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.runDialog.run })).toBeDisabled();
  });

  // (a) 프리필: mode가 detailed로 시작하고 그룹이 펼쳐지며 값이 채워진다 (배선 ①②⑤).
  //     appliedDetail 칩은 mode==="simple"에서만 렌더되므로 여기서 함께 단언할 수 없다.
  it("프리셋/초기값에 connect_timeout이 있으면 상세로 열리고 값이 채워진다", () => {
    renderWithInitial({
      ...ALL_DEFAULT_PREFILL,
      profile: { ...ALL_DEFAULT_PREFILL.profile, connect_timeout_seconds: 2 },
    });
    expect(screen.getByLabelText(ko.loadModel.connectTimeout)).toHaveValue(2);
  });

  // (b) ④ detailedAppliedCount 전용 RED — 칩은 간단 모드에서만 렌더되므로 되돌아와야 한다.
  //     renderDialog() 기본값에서 baseline은 0이라 타이핑 후 정확히 1.
  it("connect_timeout을 설정하고 간단 모드로 돌아오면 적용 수에 포함된다", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    await user.type(screen.getByLabelText(ko.loadModel.connectTimeout), "3");
    await user.click(screen.getByRole("radio", { name: /간단/ }));
    expect(screen.getByText(ko.runDialog.appliedDetail(1))).toBeInTheDocument();
  });

  // (c) ⑥ collapseHintCount — 접었을 때 값이 숨지 않는다는 보장.
  //     이 사용자가 반복 지적한 "접힌 섹션에 값이 숨는" 결함 클래스 (spec §7.4 R12).
  //     ‼ hint는 토글 버튼 **밖 형제 span**이다(`ui/Section.tsx:88-102` — accname 오염 방지
  //     의도적 설계). 버튼에 toHaveTextContent를 걸면 ⑥ 유무와 무관하게 실패해 가드가
  //     공허해진다. 반드시 getByText로 span 자체를 겨눌 것.
  it("connect_timeout을 설정하고 그룹을 접으면 접힘 힌트에 수가 잡힌다", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    await user.type(screen.getByLabelText(ko.loadModel.connectTimeout), "3");
    await user.click(screen.getByRole("button", { name: /판정·고급/ })); // 재조회 후 접기
    expect(screen.getByText(ko.runDialog.advancedSetHint(1))).toBeInTheDocument();
  });
```

`ScheduleForm.test.tsx` — Step 7의 pass-through·가드용 (구현 **전에** 쓴다). 실측한 스위트 관례: `wrap(ui)`로 감싸야 한다(`:8-11` — 컴포넌트가 `useScenario`를 쓰므로 bare `render`는 "No QueryClient set"으로 죽는다) · `submitting`은 **필수 prop** · profile 리터럴은 `as Profile` 캐스트(`:87-96`) · `trigger`는 `{ kind: "cron", cron_expr: "0 2 * * *" }`(`:97` — `once` 변형은 `run_at: number`이지 `at` 문자열이 아니다, `schemas.ts:131-134`) · 제출 단언 `onSubmit.mock.calls[0][0]`(`:59`) · httpTimeout 입력은 `aria-label`(`ScheduleForm.tsx:346`)로 접근.

**이 파일엔 `ko` import가 없다** — 새 테스트가 쓰므로 추가할 것: `import { ko } from "../../i18n/ko";`

```tsx
  it("저장된 connect_timeout_seconds가 편집 저장 라운드트립에서 보존된다", async () => {
    // pass-through가 없으면 buildProfileShared 재구성 과정에서 조용히 사라진다.
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={onSubmit}
        submitting={false}
        initial={{
          name: "nightly",
          scenario_id: "s1",
          profile: {
            vus: 1,
            duration_seconds: 5,
            ramp_up_seconds: 0,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            connect_timeout_seconds: 3,
          } as Profile,
          env: {},
          trigger: { kind: "cron", cron_expr: "0 2 * * *" },
          enabled: true,
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: /저장/ }));
    expect(onSubmit.mock.calls[0][0].profile.connect_timeout_seconds).toBe(3);
  });

  it("저장된 connect_timeout이 http_timeout 이상이면 저장을 막고 저장값을 밝힌다", async () => {
    // 이 폼엔 connect_timeout 입력이 없다 — 막기만 하면 사용자가 얼마로 올려야 할지
    // 알 수 없으므로 저장값(초)을 문구로 노출해야 한다.
    const user = userEvent.setup();
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={vi.fn()}
        submitting={false}
        initial={{
          name: "nightly",
          scenario_id: "s1",
          profile: {
            vus: 1,
            duration_seconds: 5,
            ramp_up_seconds: 0,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            connect_timeout_seconds: 5,
          } as Profile,
          env: {},
          trigger: { kind: "cron", cron_expr: "0 2 * * *" },
          enabled: true,
        }}
      />,
    );
    await user.clear(screen.getByLabelText(ko.loadModel.httpTimeout));
    await user.type(screen.getByLabelText(ko.loadModel.httpTimeout), "3");
    // http_timeout=3 자체는 유효(1..600)하고 hasLoop=false·bindingBlock.ok=true라
    // 이 사유가 목록의 유일한 항이다 = 비혼동.
    expect(screen.getByText(ko.validation.connectTimeoutStored(5))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /저장/ })).toBeDisabled();
  });
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/error-taxonomy-e3/ui && pnpm test -- RunDialog profileForm ScheduleForm; echo "exit=$?"`
Expected: FAIL — `ko.loadModel.connectTimeout` undefined / 라벨 못 찾음. (ScheduleForm 2건도 Step 1에서 작성했으므로 여기 RED에 포함된다.)

- [ ] **Step 3: Zod 스키마**

`ui/src/api/schemas.ts` — `graceful_ramp_down_seconds`(`:100`) 뒤:

```ts
  // connect 단계 전용 타임아웃(초, E3). 서버 #[serde(skip_serializing_if)] → absent → .optional()
  // (‼ .nullish() 아님 — null로는 오지 않는다). 상한은 서버 권위(1..=600) — 클라 복제는 드리프트.
  connect_timeout_seconds: z.number().int().positive().optional(),
```

- [ ] **Step 4: ko 카탈로그**

`ui/src/i18n/ko.ts` — `loadModel.httpTimeout`(`:197`) 뒤:

```ts
    connectTimeout: "연결 수립 타임아웃(초)",
    connectTimeoutHint: "비워두면 미설정 · connect 단계 정지를 요청 타임아웃과 구분해 분류합니다",
```

`validation.httpTimeout`(`:245`) 뒤:

```ts
    connectTimeout: "연결 수립 타임아웃은 1초 이상, HTTP 타임아웃보다 작아야 합니다.",
```

- [ ] **Step 5: `buildProfile` 배선 (spread-conditional)**

`ui/src/components/profileForm.ts` — `ProfileFormInput`에:

```ts
  /**
   * connect 단계 전용 타임아웃 draft(초). 빈 문자열/미전달 = 미설정 → 키 자체 생략.
   * RunDialog가 입력을 소유하고, ScheduleForm은 초기값을 pass-through만 한다.
   */
  connectTimeout?: string;
```

`buildProfile` 반환 객체에 — **`undefined` 대입이 아니라 spread-conditional**(그래야 객체 레벨 `not.toHaveProperty`가 정직해진다; `apply_scenario_think_time` 선례와 동형):

```ts
    // 빈칸/미전달이면 키 자체가 없다(byte-identical). undefined 대입이 아니라 spread —
    // 대입하면 키가 present-but-undefined로 남아 toHaveProperty가 참이 된다.
    ...(i.connectTimeout && i.connectTimeout.trim() !== ""
      ? { connect_timeout_seconds: Number(i.connectTimeout) }
      : {}),
```

- [ ] **Step 6: RunDialog 배선 6지점 + 입력 UI**

**① state + prefill** (`gracefulCap`:101-105 선례 — `httpTimeout`과 달리 **string draft**):

```tsx
  // 연결 수립 타임아웃(초, E3). string draft — 빈칸 = 미설정.
  const [connectTimeout, setConnectTimeout] = useState(
    initial?.profile.connect_timeout_seconds != null
      ? String(initial.profile.connect_timeout_seconds)
      : "",
  );
```

**② `advancedPrefill`** (`:152-166`) — http_timeout 절(`:161`) 뒤에 OR 항:

```tsx
      init?.profile.connect_timeout_seconds != null ||
```

**③ invalid 술어 + 제출 게이트** — `httpTimeoutInvalid`(`:375`) 뒤:

```tsx
  // 빈칸은 유효(미설정). 값이 있으면 1..600 정수 AND < httpTimeout.
  const connectTimeoutInvalid =
    connectTimeout.trim() !== "" &&
    (!Number.isInteger(Number(connectTimeout)) ||
      Number(connectTimeout) < 1 ||
      Number(connectTimeout) > 600 ||
      Number(connectTimeout) >= httpTimeout);
```

`!httpTimeoutInvalid`가 등장하는 **4곳 전부**(`:447`, `:455`, `:462`, `:470`)에 `&& !connectTimeoutInvalid` 합류. 그리고 `:1021-1031`의 검증-사유 목록에 — **인접 항과 동일한 가드를 반드시 유지**(펼친 상태에선 인라인 에러와 중복 렌더되고, 중복되면 `getByText`가 throw한다):

```tsx
          ...((mode === "simple" || !advancedOpen) && connectTimeoutInvalid
            ? [ko.validation.connectTimeout]
            : []),
```

**④ `detailedAppliedCount`** (`:396-410`) — `(httpTimeout !== 30 ? 1 : 0) +` 뒤:

```tsx
    (connectTimeout.trim() !== "" ? 1 : 0) +
```

**⑤ 프리셋 로더**(`:243` `setHttpTimeout(prof.http_timeout_seconds);` 뒤) + **프리셋 '비기본값 → 그룹 펼침' 술어**(`:280` `prof.http_timeout_seconds !== 30 ||` 뒤). ⑤는 `setAdvancedOpen(true)`로 **접힌 그룹을 펼치는** 술어다(모드 전환이 아니다 — 모드는 `:306`이 `advancedPrefill` 경유로 처리하므로 ②가 덮는다):

```tsx
      setConnectTimeout(
        prof.connect_timeout_seconds != null ? String(prof.connect_timeout_seconds) : "",
      );
```

```tsx
        prof.connect_timeout_seconds != null ||
```

**⑥ `collapseHintCount`** (`:393`) — **spec §7.4엔 없던 신규 배선점**. 이 카운터가 접힌 '판정·고급' 그룹의 hint(`:836`)를 만든다. 기존 주석의 제외 근거("타임아웃·루프캡은 항상 값이 있는 기본 입력이라 제외")는 **opt-in·기본 빈칸 노브엔 해당하지 않는다** — 빼면 값을 넣고 접었을 때 아무 표시 없이 숨는다(spec §7.4 R12가 이름 붙인 결함 클래스):

```tsx
  const collapseHintCount =
    sloActiveCount +
    (loadModel === "closed" ? pacingActiveCount : 0) +
    // E3: opt-in·기본 빈칸이라 httpTimeout/loopCap의 "항상 값 있음" 제외 근거가 안 통한다.
    (connectTimeout.trim() !== "" ? 1 : 0);
```

**payload**: `buildProfileShared({ … httpTimeout, connectTimeout, … })`(`:511-`)에 `connectTimeout` 추가.

**입력 UI**: httpTimeout `Field`(`:901-913`) 바로 뒤, 같은 `max-w-xs` 래퍼 안에:

```tsx
              <Field
                label={ko.loadModel.connectTimeout}
                htmlFor={connectTimeoutId}
                hint={ko.loadModel.connectTimeoutHint}
              >
                <Input
                  id={connectTimeoutId}
                  type="number"
                  min={1}
                  max={600}
                  value={connectTimeout}
                  onChange={(e) => setConnectTimeout(e.target.value)}
                  aria-invalid={connectTimeoutInvalid}
                  aria-describedby={connectTimeoutInvalid ? "connect-timeout-error" : undefined}
                />
              </Field>
```

`const connectTimeoutId = useId();`를 `httpTimeoutId`(`:227`) 옆에. 에러 문단은 `httpTimeoutInvalid` 문단(`:940-944`) 옆에:

```tsx
            {connectTimeoutInvalid && (
              <p id="connect-timeout-error" className="mb-3 text-red-600 text-sm">
                {ko.validation.connectTimeout}
              </p>
            )}
```

- [ ] **Step 7: ScheduleForm pass-through + 교차검증 가드 (입력 UI 없음)**

`ScheduleForm.tsx`는 `initial.profile`을 `buildProfileShared`로 통째 재구성하므로(`:244-254`), 넘기지 않으면 API로 설정된 값이 **편집 한 번에 소실**된다. `normalizeProfile`(=`ProfileSchema.parse`)은 Task 4 Step 3 이후 이 키를 보존하므로 `init?.connect_timeout_seconds`가 `number | undefined`로 들어온다. 폼 입력은 만들지 않되(spec §2 Non-goal) 값은 보존한다:

```tsx
  // E3: 폼 입력은 RunDialog만(spec §2 Non-goal). 단 여기서 넘기지 않으면
  // API로 설정된 스케줄의 connect_timeout_seconds가 편집 저장 시 소실되므로 pass-through.
  const connectTimeout =
    init?.connect_timeout_seconds != null ? String(init.connect_timeout_seconds) : "";
```

`buildProfileShared({ … })` 호출(`:245-253`)에 `connectTimeout` 추가.

**교차검증 가드 (필수 — pass-through가 만드는 새 막다른 길 차단).** ScheduleForm은 **자체 HTTP 타임아웃 입력**을 갖는다(state `:97`, UI `:341-350`, `httpTimeoutInvalid` `:224`, 게이트 `:234`, 사유 목록 `:443`). pass-through만 하면: API로 `connect_timeout_seconds=5`가 박힌 스케줄을 열어 HTTP 타임아웃을 3으로 낮추면 → 서버가 400 `must be less than http_timeout_seconds` → **이 폼엔 그 필드 입력이 없어 사용자가 고칠 수 없다**(보이지도 않는 값 때문에 저장이 막힌다). 값 소실을 막으려다 더 나쁜 결함을 넣는 셈이라, 저장 전에 클라가 잡고 **무엇 때문인지 말해준다**:

```tsx
  // pass-through된 connect_timeout이 현재 http_timeout과 모순이면 저장 전에 막고 이유를 밝힌다
  // (이 폼엔 해당 입력이 없어 서버 400을 받으면 사용자가 손쓸 방법이 없다).
  const connectTimeoutConflict =
    connectTimeout !== "" && Number(connectTimeout) >= httpTimeout;
```

`canSubmit`(`:228-242`)의 `!httpTimeoutInvalid`(`:234`) 뒤에 `&& !connectTimeoutConflict` 합류. 사유 목록(`:438-443`)의 `httpTimeoutInvalid` 항(`:443`) 뒤에 — **ScheduleForm의 목록은 의도적으로 무가드**다(접힘 섹션이 없어 중복 위험이 없다, `:437-438` 주석). RunDialog의 `(mode === "simple" || !advancedOpen) &&` 가드를 여기 복사하지 말 것:

```tsx
          ...(connectTimeoutConflict
            ? [ko.validation.connectTimeoutStored(Number(connectTimeout))]
            : []),
```

`ko.ts` `validation`에 추가(저장된 값을 **숫자로 노출**해야 사용자가 HTTP 타임아웃을 얼마로 올려야 하는지 안다):

```ts
    connectTimeoutStored: (n: number) =>
      `이 스케줄에 저장된 연결 수립 타임아웃(${n}초)보다 HTTP 타임아웃이 커야 합니다.`,
```

- [ ] **Step 8: 테스트 통과 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/error-taxonomy-e3/ui && pnpm test -- RunDialog profileForm ScheduleForm; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 9: 회귀 가드 이빨 실증 4건**

각 항목을 **하나씩** 일시 삭제 → 지정 테스트만 RED → 원복. 한 번에 여러 개 지우지 말 것(어느 가드가 물었는지 불분명해진다).

| # | 일시 삭제 대상 | RED가 되어야 할 테스트 | 예상 실패 |
|---|---|---|---|
| 1 | ⑥ `collapseHintCount`의 `connectTimeout` 항 | (c) | `hint={undefined}` → 힌트 span 미렌더 → `getByText` throw |
| 2 | ④ `detailedAppliedCount`의 `connectTimeout` 항 | (b) | `appliedDetail(1)` 대신 `appliedDetail(0)` |
| 3 | Step 7의 `buildProfileShared({…})` 호출에서 **`connectTimeout` 인자만** 삭제. **`const connectTimeout` 바인딩은 유지** — 같이 지우면 `connectTimeoutConflict`가 항상 false가 돼 #4 대상 테스트까지 RED가 되고 격리가 깨진다 | ScheduleForm 라운드트립 | `connect_timeout_seconds`가 `undefined ≠ 3` |
| 4 | Step 7의 `connectTimeoutConflict`(canSubmit + 사유 항) | ScheduleForm 막다른 길 가드 | 사유 문구 미렌더 → `getByText` throw |

Run(각 회차): `cd /Users/sgj/develop/handicap/.claude/worktrees/error-taxonomy-e3/ui && pnpm test -- RunDialog ScheduleForm; echo "exit=$?"`

4건 전부 원복 후 재실행 → `exit=0`. **4개 RED 출력 모두 인용할 것** — 인용 없으면 실증 미완.

- [ ] **Step 10: UI 게이트 3종 — 파이프 금지, 종료코드 명시 캡처**

`pnpm lint && pnpm test | tail`은 test 실패를 마스킹한 채 `&&` 후속으로 진행한다(레포 문서화 함정). 각각 따로:

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/error-taxonomy-e3/ui
pnpm lint; echo "lint exit=$?"
pnpm test; echo "test exit=$?"
pnpm build; echo "build exit=$?"
```

Expected: 셋 다 `exit=0`. `pnpm build`(`tsc -b && vite build`)가 최종 게이트.

- [ ] **Step 11: 커밋**

```bash
git add ui/
git commit -m "feat(ui): 연결 수립 타임아웃 입력 + Zod/payload/접힘힌트 배선 6지점 (E3 Task 4)"
```

---

## 라이브 검증 (US3) — 머지 전 필수

엔진·run 생성·리포트 파싱 경로를 전부 건드리므로 `/live-verify` 필수(생략 불가).

**워커 재빌드 필수** — 엔진 모델(`RunPlan`)이 바뀌었다. 워크트리 **자체** 바이너리로:

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/error-taxonomy-e3
cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller
cd ui && pnpm build && cd ..
./target/debug/controller --db /tmp/e3-live.db --ui-dir ui/dist --rest 127.0.0.1:8099 --grpc 127.0.0.1:8098
```

8080/8081 대신 8099/8098: 메인 체크아웃 dev 컨트롤러·사용자 자신의 프로세스와 충돌 방지(죽이기 전 `lsof` + `lsof -a -p <PID> -d cwd -Fn`으로 확인 — `ps -o cwd=`는 macOS 미지원).

**시나리오** (blackhole 스텝 — 실측 확인된 비라우팅 IP):

```yaml
version: 1
name: e3-connect-stall
steps:
  - id: 01HX0000000000000000000001
    type: http
    name: stall
    request:
      method: GET
      url: http://10.255.255.1:81/
```

| # | run 설정 | 통과 신호 |
|---|---|---|
| **US3** | `connect_timeout_seconds=2`, `http_timeout_seconds=10`, vus=1, duration=20 | 리포트 "Transport 실패 분류" 표에 **`연결 수립 타임아웃`(connect_timeout) count>0**, `요청 타임아웃`(timeout) 행 **부재** |
| **US3 대조** | 노브 미설정, `http_timeout_seconds=5`, vus=1, duration=20 | 같은 표에 **`요청 타임아웃`(timeout) count>0**, `connect_timeout` 행 **부재** — 이 대조가 성립해야 US3의 "결정적 신호"가 판별력을 갖는다(spec 리뷰 R14) |
| **검증 400** | `connect_timeout_seconds=10`, `http_timeout_seconds=10` | `POST /api/runs` → 400 `connect_timeout_seconds must be less than http_timeout_seconds` |
| **영속 왕복** | US3 run 생성 후 | `GET /api/runs/{id}` → `profile.connect_timeout_seconds == 2`. **리포트 JSON으로 확인하지 말 것** — `ReportJson`엔 profile 필드가 없어 공허하게 통과한다 |
| **회귀** | 정상 responder(think_time로 ~20 rps) + 노브 미설정 | 분류표 미렌더 · 리포트 JSON에 `error_kinds` 키 부재 · `GET /api/runs/{id}`의 `profile`에 `connect_timeout_seconds` 키 부재 |
| **UI 왕복** | RunDialog에서 2 입력 → 실행; 빈칸으로도 1회 | 제출 성공 + 위 영속 확인. 빈칸 제출 시 키 부재. **값 입력 후 '판정·고급' 그룹을 접었을 때 힌트에 수가 잡히는지**(배선 ⑥ 라이브 확인) |
| **caveat(수용, 유발 안 함)** | per-step `timeout_seconds` < run-level | 그 스텝은 `timeout`으로 남는다(spec §5.1 한계). 라이브 유발 대상 아님 — 필드 doc-comment로 기록됨 |

**주의(레포 함정)**: 정상 responder 회귀 run을 무제한으로 돌리면 로컬 ephemeral 포트를 고갈시켜 `local_port_exhaustion`을 자가 유발한다(E2 사고) — `think_time`으로 ~20 rps까지 낮출 것. blackhole run은 connect가 2초씩 걸려 자연히 저-RPS라 안전.

**주의**: `POST /api/runs` 응답은 멀티라인 `scenario_yaml`을 임베드하므로 셸 변수에 담아 파싱하지 말 것 — `curl … | python3 /tmp/parse.py` 직결 또는 `GET /api/scenarios/{id}/runs`로 재조회.

---

## 최종 리뷰 게이트

- `handicap-reviewer` APPROVE (Zod↔serde 와이어 1:1, deferral 추적, 게이트 재확인). 리뷰 BASE = implementer 디스패치 직전 커밋(`HEAD~1` 아님).
- **보안 게이트**: diff가 `crates/engine/src/executor.rs`(요청 실행)를 건드리므로 `finish-slice §0` grep이 매치할 가능성이 높다 → **grep을 직접 돌려 판정**하고, 매치하면 `security-reviewer` APPROVE 필수. 예상 완화: 에러 원문·URL을 어떤 새 sink에도 넣지 않고(kind enum만), 분류 코드 무변경, 신규 네트워크 목적지 없음(타임아웃 값 하나) — 그러나 **예측으로 스킵하지 말 것**(think-time-defaults 선례).

## Self-review 메모

- **spec §13 E3 커버리지**: §3.4 → Task 1 · §4(E3) → Task 2 · §5.1(검증 + **한계 명시**) → Task 3 · §7.1(Profile)·§7.4 → Task 4 · §9.1 ⑤ → **E1이 이미 출하**(재실행 확인) · §9.2 → Task 3 · §9.3 → Task 4 · §10 US3 → 라이브 절.
- **spec 대비 의도적 차이 4건**: ① "비라우팅 IP vs backlog-포화" → 실측으로 **비라우팅 IP 확정** ② spec의 line number 다수가 E1/E2 머지로 stale → 사전 실측 표가 정본 ③ spec §7.4의 배선 5지점에 **⑥ `collapseHintCount`** 추가(리뷰 R2 — spec이 놓친 실제 배선점) ④ spec §2가 ScheduleForm **입력**을 연기했으나 **pass-through + 교차검증 가드는 구현**한다(연기 대상은 입력이지 기존 값의 소실이 아니다 — 리뷰 R7. 가드까지 넣는 이유: pass-through만 하면 보이지 않는 저장값 때문에 저장이 막히고 사용자가 고칠 수 없는 막다른 길이 생긴다 — 리뷰 2차).
- **리뷰가 잡아낸 오측 6건**(모두 정정 반영): `store::Profile` churn 72→17→**23**(1차는 grep 오염, 2차는 **스코프 누락** — `crates/controller/src/`만 봐서 통합테스트 6곳을 놓쳤다. 같은 grep-스코프 실수가 이 plan에서만 세 번 반복됐다) · `RunPlan` churn 44→**43** · `runner.rs` 편집점 3→**9**(2곳은 `plan`이 스코프에 없음) · 누락된 전수 prost 리터럴 `grpc/coordinator.rs:1918`(Task 2의 `git add`에 controller 누락) · 테스트 (c)가 **hint를 버튼 안에서 찾아** ⑥ 유무와 무관하게 실패하던 공허 가드(hint는 `Section.tsx:88-102`에서 버튼 **밖 형제**) · ScheduleForm pass-through가 만든 막다른 길.
- **타입 일관성**: `connect_timeout`(engine `Option<Duration>`) / `connect_timeout_seconds`(proto·store·JSON `Option<u32>`) / `connectTimeout`(UI draft `string`) — 3계층 이름이 각 계층 관례를 따르고 Task 간 참조가 일치.

## 리뷰 이력

`spec-plan-reviewer` 5라운드: NEEDS-REWORK → APPROVE-WITH-FIXES ×3 → **clean APPROVE**(2026-08-02). 라운드별 finding 10 → 5 → 3 → 6 → 0. 반영 100%(기각 0건), 단 orchestrator가 리뷰어 주장도 매번 코드로 재검증했고 그 과정에서 리뷰어 오류 2건을 역으로 교정(`store/runs.rs:923` 면제 오판 → churn 16이 아니라 17, 이후 스코프 확장으로 최종 23).

**반복된 실패 모드 = grep 스코프·깊이**(도메인 노트 감): ① 오염된 매치(함수 시그니처 `-> Profile {`·다른 타입 `pb::Profile {`) ② 중첩 `..Default::default()`를 depth-1 struct-update로 오판(`store/runs.rs:923`) ③ 테스트 타깃 제외(`crates/controller/src/`만 봐서 `crates/controller/tests/` 6곳 누락 — `--all-targets`는 컴파일한다). 같은 실수가 한 plan에서 세 번 나왔다.

**설계 자체는 1라운드부터 무변경** — 레이어 계약·byte-identical 전략·슬라이스 크기는 처음부터 승인됐고, 다섯 라운드는 전부 *사실 정정*과 *테스트 이빨*에 쓰였다.

<!-- REVIEW-GATE: APPROVED -->

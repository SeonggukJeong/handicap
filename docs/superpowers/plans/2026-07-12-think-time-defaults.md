# think-time-defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시나리오에 기본 think time을 한 곳에 두고, 각 http 스텝이 (상속 / override / 이 스텝만 대기 없음) 중 하나를 고르게 한다 — 스텝마다 같은 값을 20–30번 입력·수정하던 도그푸딩 불편(§A12)의 해소.

**Architecture:** `Scenario.default_think_time: Option<ThinkTime>`를 추가하고, 엔진 인터프리터(`execute_steps` / `trace_steps`)가 `step.think_time.or(default_think)`로 해석한다. **parallel arm이 분기 재귀에 `None`을 넘겨** "분기 서브트리엔 기본값 미적용"을 구조적으로 강제한다(ADR-0033 그룹/페이지 레이턴시 오염 방지). 시나리오는 `RunAssignment.scenario_yaml`로 통째 전송되므로 **proto·컨트롤러·DB 0-diff**. UI는 읽기(normalize→Zod)·쓰기(Edit→yamlDoc) 왕복 + 왼쪽 패널 접이식 섹션 + 인스펙터 3상태 + **사전 사이징 워커 패리티**(기본값을 모르면 슬롯을 과소 추천해 실제 부하가 설정과 달라진다).

**Tech Stack:** Rust(engine: serde/tokio/wiremock), TypeScript/React(Zod + yaml Document API + Zustand + vitest/RTL).

**Spec:** `docs/superpowers/specs/2026-07-12-think-time-defaults-design.md` (spec-plan-reviewer clean APPROVE). **acceptance 정본은 spec §2 R표** — 이 plan의 각 task는 R-id를 참조한다.

## Global Constraints

- **워크트리**: 모든 작업은 `/Users/sgj/develop/handicap/.claude/worktrees/think-time-defaults`에서. 메인 체크아웃(`/Users/sgj/develop/handicap`)을 건드리지 말 것.
- **문구**: 신규·개명 UI 문구는 전부 `ui/src/i18n/ko.ts` 카탈로그 경유(ADR-0035). 컴포넌트에 한글 리터럴 0. 아래 §카피 표의 문자열을 **byte-exact**로 쓸 것.
- **tdd-guard**: `crates/*/src`·`ui/src` 편집 전에 작업트리에 pending 테스트가 있어야 한다 → **각 task는 테스트 파일 편집을 먼저** 한다(스텝 순서가 이미 그렇게 짜여 있음).
- **커밋**: `git commit`은 **foreground 단일 호출**(`run_in_background:false`, timeout 600000ms), 폴링 금지. `| tail`/`| head` 파이프 금지(종료코드 마스킹 — git-guard가 deny). `--no-verify` 금지.
- **cargo 게이트**: cargo-영향 커밋은 워크스페이스 전체 빌드+clippy+nextest를 돈다(수 분). 테스트와 구현을 **한 커밋에 green fold**할 것(RED-only 단독 커밋 불가).
- **리포트 파일 금지**: task 리포트 `.md`를 워크트리 루트에 쓰지 말 것. 필요하면 `.superpowers/sdd/`에만.
- **와이어 0-diff 불변식(R6)**: `crates/proto/`·`crates/controller/`·migration을 **한 줄도** 건드리지 않는다. 최종 `git diff master --stat`으로 검증한다.

## 카피 표 (ko.ts — byte-exact)

`ui/src/i18n/ko.ts`의 `editor` 블록에 **신규 키 8개**:

| 키 | 값 |
|---|---|
| `scenarioDefaultsTitle` | `시나리오 기본값` |
| `defaultThinkSetHint` | `설정됨` |
| `fieldDefaultThinkMin` | `기본 think 최솟값 (ms)` |
| `fieldDefaultThinkMax` | `기본 think 최댓값 (ms)` |
| `defaultThinkHint` | `모든 http 스텝이 요청 후 이만큼 쉽니다. 스텝에서 값을 입력하면 그 스텝만 그 값을 씁니다.` |
| `defaultThinkParallelHelpLabel` | `병렬 분기 미적용 설명` |
| `defaultThinkParallelHelp` | `병렬(parallel) 분기 안의 요청에는 기본값이 적용되지 않습니다. 병렬 분기는 브라우저가 페이지 리소스를 동시에 받는 구간이라 사람이 쉬는 자리가 아니고, 여기에 대기를 넣으면 그룹(페이지) 응답 시간 지표가 그만큼 부풀기 때문입니다. 그 분기 스텝에 think time을 직접 입력하면 그대로 적용됩니다.` |
| `stepNoWaitLabel` | `이 스텝은 대기 없음` |

**신규 함수형 키 1개**: `inheritedThink: (min: number, max: number) => \`시나리오 기본값 ${min}–${max}ms 상속 중\`` (하이픈은 **en dash `–`(U+2013)**, `wideChipThink`와 동일).

**신규 키 1개(분기 안내)**: `parallelNoDefaultNote` = `병렬 분기 내부 — 시나리오 기본값이 적용되지 않습니다. 대기가 필요하면 아래에 직접 입력하세요.` (`—`는 U+2014 em dash)

**개명 3개 — 값(문자열)만 바꾸고 키는 그대로**(소비처가 전부 심볼 참조라 churn 0):

| 키 | 기존 값 | 새 값 |
|---|---|---|
| `varsToggle` | `변수` | `변수·기본값` |
| `varsToggleAria` | `변수 패널 접기/펼치기` | `변수·기본값 패널 접기/펼치기` |
| `varsPanelAria` | `변수` | `변수·시나리오 기본값` |

**개명하지 않는 것**: `ko.editor.variablesTitle`(= `VariablesPanel.tsx:216`의 내부 섹션 h3/aria — 그 섹션은 여전히 "변수"만 담는다), `varsWideToggle`/`varsWideToggleAria`/`varsWideActiveTitle`(뷰 모드 이름 — 그대로).

---

## File Structure

| 파일 | 역할 | Task |
|---|---|---|
| `crates/engine/src/scenario.rs` | `Scenario.default_think_time` 필드(계약) | 1 |
| `crates/engine/src/runner.rs` | 부하 경로 해석 + parallel 배제 + 호출부 3곳 | 1 |
| `crates/engine/src/trace.rs` | test-run 경로 해석(쌍둥이) | 1 |
| `crates/engine/tests/think_time.rs` | 상속·override·0/0·parallel·open-loop·VU곡선 | 1 |
| `crates/engine/tests/trace_scenario.rs` | trace 상속(apply on/off) | 1 |
| `crates/engine/tests/proptests.rs` | 유일한 `Scenario {…}` 리터럴(필드 추가) | 1 |
| `ui/src/scenario/model.ts` | Zod 필드 + `isInsideParallelBranch` 헬퍼 | 2 |
| `ui/src/scenario/yamlDoc.ts` | **normalize 읽기 통과** + `setDefaultThinkTime` Edit | 2 |
| `ui/src/scenario/store.ts` | `setDefaultThinkTime` 액션 | 2 |
| `ui/src/components/sizing.ts` | `iterationHoldMs`에 기본값 반영(+분기 배제 미러) | 3 |
| `ui/src/components/openLoopChecks.ts` | 상한 계산 + `openLoopWarnings` 배선 | 3 |
| `ui/src/components/SlotSizingHelper.tsx` | 걷기 앵커 ⓑ 배선 | 3 |
| `ui/src/components/VuSizingHelper.tsx` | test-run에 `apply_think_time: true` | 3 |
| `ui/src/components/scenario/ScenarioDefaults.tsx` | **신규** — 왼쪽 패널 접이식 섹션 | 4 |
| `ui/src/components/scenario/EditorShell.tsx` | 섹션 마운트 | 4 |
| `ui/src/components/scenario/Inspector.tsx` | 상속 힌트·대기없음 체크박스·분기 안내 | 4 |
| `ui/src/i18n/ko.ts` | 카피(신규 10 + 개명 3) | 4 |

---

## Task 1: 엔진 — 계약 + 해석 + parallel 배제 (R1, R3, R4, R5, R16)

**Files:**
- Modify: `crates/engine/src/scenario.rs`(`Scenario` 구조체), `crates/engine/src/runner.rs`(`execute_steps` + 호출부 3곳), `crates/engine/src/trace.rs`(`trace_steps` + `trace_scenario`), `crates/engine/tests/proptests.rs:178`
- Test: `crates/engine/tests/think_time.rs`(확장), `crates/engine/tests/trace_scenario.rs`(확장), `crates/engine/src/scenario.rs` 인라인 `#[cfg(test)]`

**Interfaces:**
- Produces: `Scenario.default_think_time: Option<ThinkTime>` (YAML 키 `default_think_time`, `{min_ms, max_ms}` 맵). Task 2의 UI Zod가 같은 키·같은 모양을 소유한다.
- 해석 규칙(다른 task가 미러해야 함): http 스텝 = `step.think_time.or(default)`; parallel 분기 서브트리 = 기본값 미적용(분기 스텝의 명시값은 적용).

- [ ] **Step 1: `scenario.rs`에 round-trip 테스트를 먼저 추가 (RED)**

`crates/engine/src/scenario.rs`의 `#[cfg(test)] mod tests`에 (기존 `http_step_think_time_round_trips_and_omits_when_absent` 옆):

```rust
    #[test]
    fn scenario_default_think_time_round_trips_and_omits_when_absent() {
        let yaml = "version: 1
name: t
default_think_time:
  min_ms: 500
  max_ms: 1000
steps:
  - type: http
    id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
    name: s
    request:
      method: GET
      url: http://x/
";
        let s = Scenario::from_yaml(yaml).unwrap();
        assert_eq!(
            s.default_think_time,
            Some(ThinkTime {
                min_ms: 500,
                max_ms: 1000
            })
        );
        // round-trip: 재직렬화 → 재파싱해도 같은 값
        let s2 = Scenario::from_yaml(&s.to_yaml().unwrap()).unwrap();
        assert_eq!(s2.default_think_time, s.default_think_time);

        // 없으면 키 자체가 안 나간다(기존 시나리오 byte-identical)
        let bare = "version: 1
name: t
steps: []
";
        let b = Scenario::from_yaml(bare).unwrap();
        assert_eq!(b.default_think_time, None);
        assert!(!b.to_yaml().unwrap().contains("default_think_time"));
    }
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-engine --lib scenario_default_think_time`
Expected: FAIL — `no field 'default_think_time' on type 'Scenario'` (컴파일 에러)

- [ ] **Step 3: `Scenario`에 필드 추가**

`crates/engine/src/scenario.rs` — `cookie_jar`와 `steps` **사이**(키 순서 고정):

```rust
    #[serde(default = "default_cookie_jar")]
    pub cookie_jar: CookieJarMode,
    /// 시나리오 기본 think time. http 스텝에 `think_time`이 없으면 이 값을 상속하고,
    /// `{min_ms: 0, max_ms: 0}`이면 그 스텝만 대기 없음, 값이 있으면 override.
    /// **parallel 분기 서브트리에는 적용되지 않는다** — runner/trace의 Parallel arm이
    /// 분기 재귀에 `None`을 넘겨 구조적으로 강제한다(분기 = 동시 리소스 로딩이라 사람의
    /// 대기가 낄 자리가 아니고, 그룹/페이지 레이턴시 지표가 수면만큼 오염된다 — ADR-0033).
    /// 분기 스텝에 **명시된** `think_time`은 지금처럼 적용된다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_think_time: Option<ThinkTime>,
    pub steps: Vec<Step>,
```

`crates/engine/tests/proptests.rs:178`의 유일한 `Scenario { … }` 리터럴에 `default_think_time: None,` 추가(워크스페이스에 다른 리터럴 없음 — 나머지는 전부 YAML 파싱).

- [ ] **Step 4: 통과 확인**

Run: `cargo test -p handicap-engine --lib scenario_default_think_time`
Expected: PASS (1 passed)

- [ ] **Step 5: 부하 경로 테스트 추가 (RED)**

`crates/engine/tests/think_time.rs` — 파일 상단 기존 `count_requests` 헬퍼(1스텝·closed-loop) 옆에, YAML과 plan을 받는 범용 헬퍼 + 5개 테스트를 추가한다. `RunPlan` 필드는 기존 헬퍼의 리터럴을 그대로 복사해 쓰되 필요한 것만 바꾼다.

> **⚠ 진입점이 3개다 — 이걸 틀리면 R16/open-loop 테스트가 "절대 실패할 수 없는 테스트"가 된다.**
> `run_scenario`(`runner.rs:129`)는 **closed-loop 전용**이고 `vu_stages`/`target_rps`를 **무시**한다(디스패치하지 않는다). 워커가 셋 중 하나를 고른다(`worker/src/lib.rs:427`):
> `run_scenario`→`run_vu` / `run_scenario_vu_curve`(`:699`)→`run_vu_curve` / `run_scenario_open_loop`(`:1107`)→`run_arrival`.
> 세 함수의 시그니처는 **동일**(`Arc<Scenario>, RunPlan, mpsc::Sender<MetricFlush>, CancellationToken) -> Result<()>`)이므로 아래처럼 모드로 갈라 부른다. (`tests/vu_curve.rs:5`·`tests/open_loop.rs:5`가 이미 각 진입점을 직접 import하는 게 이 repo의 관행이다.)

```rust
use handicap_engine::{
    MetricFlush, RampDown, RunPlan, Scenario, Stage, ThinkTime, run_scenario,
    run_scenario_open_loop, run_scenario_vu_curve,
};

#[derive(Clone, Copy)]
enum Mode {
    Closed,
    Curve,
    Open,
}

/// 임의 시나리오 YAML(서버 uri 치환) + 임의 RunPlan으로 창(window) 안의 총 요청 수를 센다.
/// step_id에 무관하게 전부 합산한다(상속은 여러 스텝에 걸리므로).
/// `mode`가 **어느 엔진 진입점을 탈지**를 정한다 — closed/curve/open이 각각 다른 VU 루프
/// (`run_vu` / `run_vu_curve` / `run_arrival`)를 돌기 때문에, 이걸 안 갈라주면 곡선·open-loop
/// 테스트가 사실은 closed-loop만 검사한다(= 호출부를 빠뜨려도 green).
async fn count_all(mode: Mode, yaml_tpl: &str, dur_ms: u64, tweak: impl FnOnce(&mut RunPlan)) -> u64 {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = yaml_tpl.replace("{URI}", &server.uri());
    let scenario = Arc::new(Scenario::from_yaml(&yaml).unwrap());
    let mut plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_millis(dur_ms),
        env: Default::default(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_bindings: vec![],
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
        stages: None,
        measure_phases: false,
        vu_stages: None,
        ramp_down: RampDown::Graceful,
    };
    tweak(&mut plan);
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let cancel = CancellationToken::new();
    // 세 진입점은 시그니처가 같아 JoinHandle 타입이 일치한다.
    let h = match mode {
        Mode::Closed => tokio::spawn(run_scenario(scenario, plan, tx, cancel)),
        Mode::Curve => tokio::spawn(run_scenario_vu_curve(scenario, plan, tx, cancel)),
        Mode::Open => tokio::spawn(run_scenario_open_loop(scenario, plan, tx, cancel)),
    };
    let mut total = 0u64;
    while let Some(f) = rx.recv().await {
        for w in f.windows {
            total += w.count;
        }
    }
    h.await.unwrap().unwrap();
    total
}

/// 1 http 스텝. `{DEFAULT}` 자리에 시나리오 기본값 블록(또는 빈 문자열), `{THINK}`에 스텝 think 블록.
const ONE_STEP: &str = "version: 1
name: t
{DEFAULT}steps:
  - type: http
    id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
    name: s
    request:
      method: GET
      url: {URI}/
{THINK}";

fn one_step(default_block: &str, think_block: &str) -> String {
    ONE_STEP
        .replace("{DEFAULT}", default_block)
        .replace("{THINK}", think_block)
}

const DEFAULT_200: &str = "default_think_time:\n  min_ms: 200\n  max_ms: 200\n";

#[tokio::test]
async fn scenario_default_think_time_paces_inheriting_steps() {
    // 기본값 없음: 600ms 창에 로컬 스텁 상대로 수십~수백 요청.
    let none = count_all(Mode::Closed, &one_step("", ""), 600, |_| {}).await;
    // 기본값 200ms: 스텝이 상속 → 요청 사이 200ms 대기 → 훨씬 적다(~3).
    let inherited = count_all(Mode::Closed, &one_step(DEFAULT_200, ""), 600, |_| {}).await;
    assert!(
        inherited < none / 10 && inherited > 0,
        "inherited={inherited} none={none}"
    );
}

#[tokio::test]
async fn zero_step_think_time_opts_out_of_scenario_default() {
    // 기본값 200ms + 그 스텝만 {0,0} → 대기 없음(상속 거부) → 기본값 없을 때와 같은 급.
    // (상속됐다면 ~3건까지 떨어진다 — 아래 하한은 그 10배 이상이라 여유가 크다.)
    let opted_out = count_all(
        Mode::Closed,
        &one_step(DEFAULT_200, "    think_time:\n      min_ms: 0\n      max_ms: 0\n"),
        600,
        |_| {},
    )
    .await;
    let none = count_all(Mode::Closed, &one_step("", ""), 600, |_| {}).await;
    assert!(
        opted_out > none / 3,
        "opted_out={opted_out} none={none} (0/0은 대기 없음이어야 한다)"
    );
}

#[tokio::test]
async fn step_think_time_overrides_scenario_default() {
    // 기본값 200ms인데 스텝이 20ms를 명시 → 스텝 값이 이긴다 → 상속보다 훨씬 많이 돈다.
    let overridden = count_all(
        Mode::Closed,
        &one_step(DEFAULT_200, "    think_time:\n      min_ms: 20\n      max_ms: 20\n"),
        600,
        |_| {},
    )
    .await;
    let inherited = count_all(Mode::Closed, &one_step(DEFAULT_200, ""), 600, |_| {}).await;
    assert!(
        overridden > inherited * 3,
        "overridden={overridden} inherited={inherited}"
    );
}

#[tokio::test]
async fn parallel_branch_ignores_scenario_default() {
    // 분기 안의 http 스텝: 기본값은 적용되지 않는다(R4).
    let par = "version: 1
name: t
{DEFAULT}steps:
  - type: parallel
    id: 01ARZ3NDEKTSV4RRFFQ69G5FAW
    name: p
    branches:
      - name: b1
        steps:
          - type: http
            id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
            name: s
            request:
              method: GET
              url: {URI}/
{THINK}";
    let with_default = count_all(
        Mode::Closed,
        &par.replace("{DEFAULT}", DEFAULT_200).replace("{THINK}", ""),
        600,
        |_| {},
    )
    .await;
    let no_default = count_all(
        Mode::Closed,
        &par.replace("{DEFAULT}", "").replace("{THINK}", ""),
        600,
        |_| {},
    )
    .await;
    // 기본값이 분기에 안 걸리므로 두 카운트가 같은 급이어야 한다(걸렸다면 ~3건으로 폭락한다).
    assert!(
        with_default > no_default / 3,
        "with_default={with_default} no_default={no_default} (분기엔 기본값 미적용이어야 한다)"
    );
    // 반면 분기 스텝에 **명시**하면 적용된다(현행 보존).
    let explicit = count_all(
        Mode::Closed,
        &par.replace("{DEFAULT}", "")
            .replace("{THINK}", "            think_time:\n              min_ms: 200\n              max_ms: 200\n"),
        600,
        |_| {},
    )
    .await;
    assert!(
        explicit < no_default / 10 && explicit > 0,
        "explicit={explicit} no_default={no_default}"
    );
}

#[tokio::test]
async fn vu_curve_path_applies_scenario_default() {
    // R16: closed-loop VU 곡선은 `run_scenario_vu_curve` → `run_vu_curve`(run_vu 본문의
    // 의도적 복제)를 탄다. **Mode::Curve로 그 진입점을 직접 타야** 이 테스트가 의미를 갖는다
    // (Mode::Closed로 돌리면 vu_stages가 무시돼 closed-loop만 검사하는 가짜 green이 된다).
    let curve = |p: &mut RunPlan| {
        p.vus = 1;
        p.vu_stages = Some(vec![Stage {
            target: 1,
            duration_seconds: 1,
        }]);
    };
    let none = count_all(Mode::Curve, &one_step("", ""), 1000, curve).await;
    let inherited = count_all(Mode::Curve, &one_step(DEFAULT_200, ""), 1000, curve).await;
    assert!(
        inherited < none / 10 && inherited > 0,
        "vu_stages: inherited={inherited} none={none}"
    );
}

#[tokio::test]
async fn open_loop_applies_scenario_default() {
    // R3(open-loop): `run_scenario_open_loop` → `run_arrival`. 슬롯 1개 + 높은 목표 도착률 →
    // 슬롯 점유시간이 처리량을 지배한다. 기본값 200ms가 상속되면 반복이 200ms 이상 슬롯을
    // 잡아 완료 수가 급감한다. (Mode::Open 필수 — Closed면 target_rps가 무시된다.)
    let open = |p: &mut RunPlan| {
        p.target_rps = Some(50);
        p.max_in_flight = Some(1);
    };
    let none = count_all(Mode::Open, &one_step("", ""), 600, open).await;
    let inherited = count_all(Mode::Open, &one_step(DEFAULT_200, ""), 600, open).await;
    assert!(
        inherited < none / 5 && inherited > 0,
        "open-loop: inherited={inherited} none={none}"
    );
}
```

`curve`/`open` 클로저는 캡처가 없어 `Copy` → 두 번 넘겨도 된다. `use handicap_engine::Stage;`는 위 헬퍼 블록의 import에 이미 포함.

`Stage`는 `crates/engine/src/runner.rs:30`에 정의돼 있고(`target: u32`, `duration_seconds: u32`) `lib.rs`가 re-export한다 — 위 헬퍼 블록의 import에 이미 포함돼 있다.

- [ ] **Step 6: 실패 확인**

Run: `cargo test -p handicap-engine --test think_time`
Expected: FAIL — `default_think_time` 키가 `deny_unknown_fields`에 걸리거나(필드 추가 전이면) 상속이 없어 카운트 단언이 깨진다. (Step 3에서 필드는 이미 추가했으므로 여기선 **단언 실패**: `inherited`가 `none`과 같은 급.)

- [ ] **Step 7: `runner.rs` — 파라미터 + 해석 + parallel 배제 + 호출부 3곳**

`crates/engine/src/runner.rs`:

1. `execute_steps` 시그니처에 **마지막 파라미터**로 추가:

```rust
async fn execute_steps(
    client: &VuClient,
    steps: &[Step],
    iter_vars: &mut BTreeMap<String, String>,
    agg: &Arc<Mutex<Aggregator>>,
    deadline: Instant,
    env: &Arc<BTreeMap<String, String>>,
    vu_id: u32,
    iter_id: u32,
    loop_index: Option<u32>,
    cancel: &CancellationToken,
    rng: &mut StdRng,
    measure_phases: bool,
    /// 시나리오 기본 think time. http 스텝이 자기 `think_time`을 안 가지면 이 값을 쓴다.
    /// **Parallel arm은 분기 재귀에 `None`을 넘긴다**(spec R4).
    default_think: Option<ThinkTime>,
) -> Result<StepFlow> {
```

2. Http arm(현재 `if let Some(tt) = &http.think_time {`, ~`:502`) → `ThinkTime`이 `Copy`라 `.or()`가 그대로 된다:

```rust
                if let Some(tt) = http.think_time.or(default_think) {
                    match pace(tt.sample(rng), deadline, cancel).await {
                        PaceOutcome::Slept => {}
                        PaceOutcome::Cancelled => return Ok(StepFlow::Aborted),
                        PaceOutcome::DeadlineReached => return Ok(StepFlow::DeadlineReached),
                    }
                }
```

3. Loop arm(`:518`)·If arm(`:563`) 재귀: 마지막 인자로 **`default_think`** 전달.

4. Parallel arm(`:598`) 분기 재귀: 마지막 인자로 **`None`** 전달 + 주석:

```rust
                        let flow = Box::pin(execute_steps(
                            client,
                            &branch.steps,
                            &mut branch_vars,
                            agg,
                            deadline,
                            env,
                            vu_id,
                            iter_id,
                            loop_index,
                            cancel,
                            &mut branch_rng,
                            measure_phases,
                            // 시나리오 기본값은 분기 서브트리에 적용하지 않는다(spec R4):
                            // parallel = 동시 리소스 로딩 구간이라 사람의 대기가 낄 자리가 아니고,
                            // 그룹 시간(= 페이지 로드 시간, ADR-0033)이 수면만큼 오염된다.
                            // 분기 스텝에 명시된 think_time은 위 Http arm에서 그대로 적용된다.
                            None,
                        ))
```

5. **비재귀 호출부 3곳** — 전부 마지막 인자로 `scenario.default_think_time`:
   - `:384` `run_vu`(closed-loop)
   - `:1045` `run_vu_curve`(closed-loop VU 곡선 — `run_vu` 본문의 의도적 복제)
   - `:1393` `run_arrival`(open-loop)

- [ ] **Step 8: `trace.rs` — 같은 규칙(쌍둥이)**

`crates/engine/src/trace.rs`:
- `trace_steps` 시그니처에 마지막 파라미터 `default_think: Option<ThinkTime>` 추가(`#[allow(clippy::too_many_arguments)]` 이미 있음).
- Http arm(`:240` 근처): `if let Some(tt) = &http.think_time` → `if let Some(tt) = http.think_time.or(default_think)` (sleep 자체는 기존 `opts.apply_think_time` 게이트 안에 그대로).
- Loop·If 재귀: `default_think` 전달. **Parallel 분기 재귀(`:325` 근처): `None`** + runner와 같은 취지의 주석.
- `trace_scenario`(`:137` 근처 진입 `Box::pin(trace_steps(...))`): `scenario.default_think_time` 전달.
- `ThinkTime` import가 없으면 `use crate::pacing::ThinkTime;` 추가.

- [ ] **Step 9: trace 테스트 추가 (RED→GREEN)**

`crates/engine/tests/trace_scenario.rs`에 추가(파일 상단의 `opts(env, max_requests)` 헬퍼 재사용 — `apply_think_time: false`가 기본):

```rust
#[tokio::test]
async fn trace_applies_scenario_default_think_only_when_enabled() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = format!(
        r#"
version: 1
name: d
default_think_time:
  min_ms: 300
  max_ms: 300
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: a
    request: {{ method: GET, url: "{base}/a" }}
"#,
        base = server.uri()
    );
    let scenario = Scenario::from_yaml(&yaml).unwrap();

    // apply_think_time=false(기본) → 상속값도 재우지 않는다(현행 게이트 유지).
    let fast = trace_scenario(&scenario, &opts(BTreeMap::new(), 10)).await;
    assert!(fast.ok, "fast trace failed: {:?}", fast.error);
    assert!(fast.total_ms < 300, "fast.total_ms={}", fast.total_ms);

    // apply_think_time=true → 스텝이 상속한 300ms를 실제로 잔다.
    let mut o = opts(BTreeMap::new(), 10);
    o.apply_think_time = true;
    let slow = trace_scenario(&scenario, &o).await;
    assert!(slow.ok, "slow trace failed: {:?}", slow.error);
    assert!(slow.total_ms >= 300, "slow.total_ms={}", slow.total_ms);
}
```

- [ ] **Step 10: 전체 게이트 실행**

Run: `cargo fmt && cargo clippy --workspace --all-targets -- -D warnings && cargo test -p handicap-engine`
Expected: 전부 PASS (기존 엔진 테스트 + 신규 7개). clippy 경고 0.

- [ ] **Step 11: 커밋**

```bash
git add crates/engine/src/scenario.rs crates/engine/src/runner.rs crates/engine/src/trace.rs crates/engine/tests/think_time.rs crates/engine/tests/trace_scenario.rs crates/engine/tests/proptests.rs
git commit -m "feat(engine): 시나리오 기본 think time 상속 — 스텝 3상태·parallel 분기 배제 (R1/R3/R4/R5/R16)"
```
(foreground 단일 호출, 폴링 금지. cargo 게이트라 수 분 소요.)

---

## Task 2: UI 계약 — Zod + normalize 읽기 + Edit/store 쓰기 (R2, R14, R7 절반, R9 헬퍼)

**Files:**
- Modify: `ui/src/scenario/model.ts`, `ui/src/scenario/yamlDoc.ts`, `ui/src/scenario/store.ts`
- Test: `ui/src/scenario/__tests__/model.test.ts`(또는 기존 모델 테스트 파일), `ui/src/scenario/__tests__/yamlDoc.test.ts`

**Interfaces:**
- Consumes: Task 1의 YAML 키 `default_think_time: {min_ms, max_ms}`.
- Produces:
  - `ScenarioModel`에 `default_think_time?: ThinkTime` (`ui/src/scenario/model.ts`)
  - `isInsideParallelBranch(steps: ReadonlyArray<Step>, stepId: string): boolean`
  - store 액션 `setDefaultThinkTime(value: ThinkTime | undefined): void`
  - Task 3(사이징)·Task 4(UI 표면)가 위 셋을 소비한다.

- [ ] **Step 1: 왕복 테스트를 먼저 쓴다 (RED)**

`ui/src/scenario/__tests__/yamlDoc.test.ts`에 추가 — **읽기(normalize) 경로가 핵심**(이게 빠지면 write-only 버그):

```ts
import { useScenarioEditor } from "../store"; // 이미 import 되어 있으면 재사용

it("default_think_time을 파싱해 모델에 보존한다 (normalize 읽기 경로)", () => {
  const yaml = `version: 1
name: "demo"
default_think_time:
  min_ms: 500
  max_ms: 1000
steps: []
`;
  const r = parseScenarioDoc(yaml);
  expect("error" in r).toBe(false);
  if ("error" in r) return;
  expect(r.model.default_think_time).toEqual({ min_ms: 500, max_ms: 1000 });
});

it("setDefaultThinkTime이 YAML에 쓰이고 재파싱된 모델에 되읽힌다 (왕복)", () => {
  const store = useScenarioEditor.getState();
  store.loadFromString(`version: 1
name: "demo"
steps: []
`);
  useScenarioEditor.getState().setDefaultThinkTime({ min_ms: 500, max_ms: 1000 });
  const s1 = useScenarioEditor.getState();
  expect(s1.yamlText).toContain("default_think_time");
  expect(s1.model?.default_think_time).toEqual({ min_ms: 500, max_ms: 1000 });

  // 제거 → 키가 사라지고 모델도 undefined
  useScenarioEditor.getState().setDefaultThinkTime(undefined);
  const s2 = useScenarioEditor.getState();
  expect(s2.yamlText).not.toContain("default_think_time");
  expect(s2.model?.default_think_time).toBeUndefined();
});
```

같은 파일에 Zod 검증 4케이스(spec R2: 유효 / min>max / 600001 / absent):

```ts
const withDefault = (block: string) => `version: 1
name: "demo"
${block}steps: []
`;

it("default_think_time Zod: 유효/min>max/600001/absent", () => {
  // 유효
  const ok = parseScenarioDoc(withDefault("default_think_time:\n  min_ms: 500\n  max_ms: 1000\n"));
  expect("error" in ok).toBe(false);
  // min > max → 거부
  expect(
    "error" in parseScenarioDoc(withDefault("default_think_time:\n  min_ms: 900\n  max_ms: 100\n")),
  ).toBe(true);
  // max > 600000 → 거부
  expect(
    "error" in
      parseScenarioDoc(withDefault("default_think_time:\n  min_ms: 0\n  max_ms: 600001\n")),
  ).toBe(true);
  // absent → undefined (현행 시나리오 회귀 0)
  const bare = parseScenarioDoc(withDefault(""));
  expect("error" in bare).toBe(false);
  if ("error" in bare) return;
  expect(bare.model.default_think_time).toBeUndefined();
});
```

`isInsideParallelBranch` 테스트 — `ui/src/scenario/__tests__/model.test.ts`(없으면 신규 생성). 픽스처는 `sizing.test.ts`의 최소-캐스트 이디엄과 동형:

```ts
import { isInsideParallelBranch } from "../model";
import type { Step } from "../model";

const http = (id: string): Step =>
  ({
    type: "http",
    id,
    name: id,
    request: { method: "GET", url: "/x" },
  }) as unknown as Step;

it("isInsideParallelBranch: parallel 분기 내부만 true (loop/최상위는 false)", () => {
  const steps: Step[] = [
    http("top"),
    { type: "loop", id: "L", name: "L", repeat: 2, do: [http("inLoop")] } as unknown as Step,
    {
      type: "parallel",
      id: "P",
      name: "P",
      branches: [{ name: "b1", steps: [http("inBranch")] }],
    } as unknown as Step,
  ];
  expect(isInsideParallelBranch(steps, "top")).toBe(false);
  expect(isInsideParallelBranch(steps, "inLoop")).toBe(false);
  expect(isInsideParallelBranch(steps, "inBranch")).toBe(true);
  expect(isInsideParallelBranch(steps, "없는id")).toBe(false); // 못 찾으면 false
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-defaults/ui && pnpm test -- yamlDoc`
Expected: FAIL — `setDefaultThinkTime is not a function` / `model.default_think_time` undefined

- [ ] **Step 3: `model.ts` — Zod 필드 + 헬퍼**

```ts
export const ScenarioModel = z
  .object({
    version: z.literal(1),
    name: z.string().min(1, "name required"),
    cookie_jar: CookieJarMode.default("auto"),
    variables: z.record(z.string(), z.string()).default({}),
    default_think_time: ThinkTimeModel.optional(),
    steps: z.array(StepModel).default([]),
  })
  .strict();
```

헬퍼(파일 하단, `findStepById` 근처 — **재귀 arm 구성은 `findStepById`를 그대로 미러**할 것: 그게 현재 컴파일되는 형태다):

```ts
/** stepId가 parallel 분기 서브트리 안에 있으면 true(분기 안의 중첩 loop/if 포함).
 *  시나리오 기본 think time이 **적용되지 않는** 영역 판정 — 엔진 runner/trace의 Parallel arm이
 *  분기 재귀에 default를 넘기지 않는 규칙(spec R4)의 UI 미러. 못 찾으면 false. */
export function isInsideParallelBranch(
  steps: ReadonlyArray<Step>,
  stepId: string,
): boolean {
  const walk = (list: ReadonlyArray<Step>, inBranch: boolean): boolean | null => {
    for (const s of list) {
      if (s.id === stepId) return inBranch;
      if (s.type === "loop") {
        const r = walk(s.do, inBranch);
        if (r !== null) return r;
      } else if (s.type === "parallel") {
        for (const b of s.branches) {
          const r = walk(b.steps, true);
          if (r !== null) return r;
        }
      } else if (s.type === "if") {
        for (const list2 of [s.then, ...s.elif.map((e) => e.then), s.else]) {
          const r = walk(list2, inBranch);
          if (r !== null) return r;
        }
      }
    }
    return null;
  };
  return walk(steps, false) ?? false;
}
```

- [ ] **Step 4: `yamlDoc.ts` — 읽기 통과 + 쓰기 Edit**

**읽기(R14 — 이게 빠지면 write-only)**: `normalizeForModel`의 루트 out 객체에 한 줄:

```ts
  const out: Record<string, unknown> = {
    version: src.version,
    name: src.name,
    cookie_jar: src.cookie_jar ?? "auto",
    variables: src.variables ?? {},
    // 루트 allowlist다 — 새 최상위 키는 여기를 통과시켜야 Zod가 본다(없으면 write-only).
    default_think_time: src.default_think_time,
    steps: Array.isArray(src.steps) ? src.steps.map(normalizeStep) : [],
  };
```

**쓰기**: `Edit` 유니온에 추가(`ThinkTime` 타입 import 필요 — `import type { ThinkTime } from "./model";` 이미 있으면 재사용):

```ts
  | { type: "setDefaultThinkTime"; value: ThinkTime | undefined }
```

`applyEdit`에 arm 추가(`setCookieJar` arm 바로 아래):

```ts
    case "setDefaultThinkTime":
      if (edit.value === undefined) {
        doc.deleteIn(["default_think_time"]); // removeVariable arm과 같은 삭제 API
      } else {
        doc.setIn(["default_think_time"], {
          min_ms: edit.value.min_ms,
          max_ms: edit.value.max_ms,
        });
      }
      return;
```
(삭제 API가 `removeVariable` arm과 다르면 그쪽을 따를 것 — 실제 코드를 확인해 맞춘다.)

- [ ] **Step 5: `store.ts` — 액션**

인터페이스(`setCookieJar` 옆):

```ts
  /** 시나리오 기본 think time(모든 http 스텝이 상속; parallel 분기 제외). undefined → 키 제거. */
  setDefaultThinkTime(value: ThinkTime | undefined): void;
```

구현(`setCookieJar` 구현 옆):

```ts
  setDefaultThinkTime(value) {
    dispatch(set, get, { type: "setDefaultThinkTime", value });
  },
```

`useScenarioEditor` 셀렉터 매핑 목록(파일 하단 `setCookieJar: s.setCookieJar,` 근처)에도 `setDefaultThinkTime: s.setDefaultThinkTime,` 추가.

- [ ] **Step 6: 테스트 통과 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-defaults/ui && pnpm test -- yamlDoc model`
Expected: PASS (신규 4케이스 포함)

- [ ] **Step 7: 전체 UI 게이트**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-defaults/ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 PASS (lint는 `--max-warnings=0`)

- [ ] **Step 8: 커밋**

```bash
git add ui/src/scenario/model.ts ui/src/scenario/yamlDoc.ts ui/src/scenario/store.ts ui/src/scenario/__tests__
git commit -m "feat(ui): 시나리오 기본 think time 계약 — Zod + normalize 읽기 통과 + setDefaultThinkTime (R2/R14/R7)"
```

---

## Task 3: 사이징 패리티 — 기본값을 모르면 부하가 설정과 달라진다 (R15)

**Files:**
- Modify: `ui/src/components/sizing.ts`(`iterationHoldMs`), `ui/src/components/openLoopChecks.ts`(`iterationTimeUpperBoundSeconds` + `openLoopWarnings` 배선 `:89`), `ui/src/components/SlotSizingHelper.tsx`(배선 `:48`), `ui/src/components/VuSizingHelper.tsx`(test-run 페이로드 `:91`)
- Test: `ui/src/components/__tests__/sizing.test.ts`, `ui/src/components/__tests__/openLoopChecks.test.ts`, `ui/src/components/__tests__/SlotSizingHelper.test.tsx`, `ui/src/components/__tests__/VuSizingHelper.test.tsx`(없으면 생성)

**Interfaces:**
- Consumes: Task 2의 `Scenario.default_think_time`(Zod 모델). `SlotSizingHelper`/`openLoopWarnings`가 받는 `scenario`는 이미 이 모델 타입이라 필드가 자동으로 실린다.
- Produces: `iterationHoldMs(steps, perStepP50, fallbackMs, defaultThink?)`, `iterationTimeUpperBoundSeconds(steps, httpTimeoutSec, defaultThink?)` — **후행 optional**이라 기존 호출부/테스트는 그대로 green.

> **왜 필수인가**: `iterationHoldMs`는 ADR-0046의 걷기 앵커 ⓑ(= `recommendSlots`의 반복 점유시간)다. 상속 스텝의 대기를 0으로 계산하면 `max_in_flight`를 과소 추천 → 슬롯 부족 → 요청 드롭 → **사용자가 설정한 부하와 다른 부하가 조용히 나간다**(사용자 상시 규칙 위반).
> **함정**: 순수함수 테스트는 `defaultThink`를 직접 넘기므로 **배선을 잊어도 green**이다 → 아래 Step 1의 ②(배선 테스트)를 반드시 포함할 것.

- [ ] **Step 1: 테스트 먼저 (RED) — ① 순수함수 ② 배선 ③ 페이로드**

**① `ui/src/components/__tests__/sizing.test.ts`** — 파일 상단의 기존 `http(id, think?)` 헬퍼와 `p50` 맵(`a:100, b:200`)을 그대로 쓴다:

```ts
describe("iterationHoldMs — 시나리오 기본 think time (R15)", () => {
  const p50 = new Map([
    ["a", 100],
    ["b", 200],
  ]);
  it("상속 스텝엔 기본값 평균이 더해지고, 스텝 명시값이 이긴다", () => {
    const steps = [http("a"), http("b", { min_ms: 0, max_ms: 0 })];
    expect(iterationHoldMs(steps, p50, 50)).toBe(300); // 기본값 없음: 100 + 200
    // 기본값 200/400(평균 300): a는 상속(+300), b는 {0,0} 명시 → 대기 0
    expect(iterationHoldMs(steps, p50, 50, { min_ms: 200, max_ms: 400 })).toBe(600);
  });
  it("parallel 분기 안 스텝엔 기본값이 적용되지 않는다 (엔진 R4 미러)", () => {
    const par = {
      type: "parallel",
      id: "P",
      name: "P",
      branches: [{ name: "x", steps: [http("a")] }],
    } as unknown as Step;
    const steps = [par, http("b")];
    expect(iterationHoldMs(steps, p50, 50)).toBe(300); // 기본값 없음: max(a=100) + b=200
    // 기본값 500/500: 분기 a엔 미적용(100 유지), 최상위 b에만 +500 → 100 + 700 = 800
    expect(iterationHoldMs(steps, p50, 50, { min_ms: 500, max_ms: 500 })).toBe(800);
  });
});
```

**① + ② `ui/src/components/__tests__/openLoopChecks.test.ts`** — 파일 상단의 `http(over)`·`scenarioOf`·`base`(1 http leaf, `httpTimeoutSeconds: 1`, `targetRps: "10"`, `maxInFlight: "10000"`) 재사용:

```ts
describe("시나리오 기본 think time (R15)", () => {
  it("iterationTimeUpperBoundSeconds: 상한에 기본 think max를 더하되 분기엔 미적용", () => {
    // 상속: timeout 30s + 기본 think max 1000ms = 31
    expect(iterationTimeUpperBoundSeconds([http()], 30, { min_ms: 0, max_ms: 1000 })).toBe(31);
    // 스텝 명시 {0,0}이 이긴다 → 30
    expect(
      iterationTimeUpperBoundSeconds([http({ think_time: { min_ms: 0, max_ms: 0 } })], 30, {
        min_ms: 0,
        max_ms: 1000,
      }),
    ).toBe(30);
    // parallel 분기 안 스텝엔 미적용 → 30
    const par = {
      type: "parallel",
      branches: [{ name: "x", steps: [http()] }],
    } as unknown as Step;
    expect(iterationTimeUpperBoundSeconds([par], 30, { min_ms: 0, max_ms: 1000 })).toBe(30);
  });

  // ② 배선 — 이 테스트가 openLoopChecks.ts:89의 3번째 인자를 강제한다.
  //    (위 순수함수 테스트는 인자를 직접 주므로 배선을 잊어도 green이다.)
  it("배선: openLoopWarnings가 scenario.default_think_time을 상한에 반영한다", () => {
    // base(기본값 없음): T = 1s(timeout) → threshold = ceil(10 × 1) = 10
    expect(openLoopWarnings(base)).toContainEqual({
      kind: "inert_slots",
      maxInFlight: 10000,
      threshold: 10,
    });
    // 기본값 1000ms 상속: T = 1 + 1 = 2s → threshold = ceil(10 × 2) = 20
    const withDefault = openLoopWarnings({
      ...base,
      scenario: {
        steps: [http()],
        default_think_time: { min_ms: 0, max_ms: 1000 },
      } as unknown as Scenario,
    });
    expect(withDefault).toContainEqual({
      kind: "inert_slots",
      maxInFlight: 10000,
      threshold: 20,
    });
  });
});
```

**② `ui/src/components/__tests__/SlotSizingHelper.test.tsx`** — 기존 "ⓑ walk 앵커: per-step p50(100+200) → hold 300 → target 20 → 6" 테스트 **바로 아래**에 같은 픽스처의 기본값 변형을 추가한다(이 테스트가 `SlotSizingHelper.tsx:48`의 4번째 인자를 강제한다):

```tsx
it("ⓑ walk 앵커(R15 배선): 시나리오 기본 think time이 반복 점유시간에 반영된다", () => {
  const scenario = {
    steps: [http("a"), http("b")],
    default_think_time: { min_ms: 500, max_ms: 500 },
  } as unknown as Scenario;
  setHooks({
    runs: [openRun(100, null)],
    report: {
      insights: [],
      steps: [
        { step_id: "a", p50_ms: 100 },
        { step_id: "b", p50_ms: 200 },
      ],
      summary: { mean_ms: 999 },
    },
  });
  render(
    <SlotSizingHelper
      scenarioId="s1"
      scenario={scenario}
      env={{}}
      targetRps="20"
      onApply={vi.fn()}
    />,
  );
  // hold = (100+500) + (200+500) = 1300ms (기본값 없을 땐 300ms) → ceil(20 × 1.3) = 26
  expect(screen.getByText(/반복 1회 ~1300ms/)).toBeInTheDocument();
  expect(screen.getByText(/max_in_flight를 최소 ~26\(으\)로 설정하세요/)).toBeInTheDocument();
});
```

**③ `ui/src/components/__tests__/VuSizingHelper.test.tsx`** — 기존 "측정 버튼 → test-run 발사" 테스트의 `setHooks`/`mutate` 이디엄 재사용:

```tsx
it("측정은 apply_think_time: true로 발사한다 (SlotSizingHelper와 같은 앵커 정의)", async () => {
  const mutate = vi.fn();
  const user = userEvent.setup();
  setHooks({
    runs: [],
    yaml: "version: 1\nname: d\nsteps: []\n",
    testRun: { mutate, isPending: false, isError: false, data: undefined },
  });
  render(<VuSizingHelper scenarioId="s1" scenario={scenario} env={{}} onApply={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "test-run으로 측정" }));
  expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ apply_think_time: true }));
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-defaults/ui && pnpm test -- sizing openLoopChecks SlotSizingHelper VuSizingHelper`
Expected: FAIL — 4번째 인자를 안 받음 / threshold 불변 / 페이로드에 `apply_think_time` 없음

- [ ] **Step 3: `sizing.ts` — 파라미터 + 분기 배제 미러**

```ts
export function iterationHoldMs(
  steps: ReadonlyArray<Step>,
  perStepP50: ReadonlyMap<string, number>,
  fallbackMs: number,
  /** 시나리오 기본 think time — 스텝이 자기 think_time을 안 가지면 이걸 쓴다.
   *  parallel 분기 재귀엔 **넘기지 않는다**(엔진 R4 규칙 미러). */
  defaultThink?: ThinkTime,
): number {
  let total = 0;
  for (const s of steps) {
    if (s.type === "http") {
      const lat = perStepP50.get(s.id) ?? fallbackMs;
      const tt = s.think_time ?? defaultThink;
      const think = tt ? (tt.min_ms + tt.max_ms) / 2 : 0;
      total += lat + think;
    } else if (s.type === "loop") {
      total += s.repeat * iterationHoldMs(s.do, perStepP50, fallbackMs, defaultThink);
    } else if (s.type === "parallel") {
      // 시나리오 기본값은 분기 서브트리에 적용되지 않는다(엔진 runner/trace의 Parallel arm이
      // 분기 재귀에 None을 넘김 — spec R4). 분기 스텝의 명시 think_time은 위 http arm이 반영.
      let mx = 0;
      for (const b of s.branches) {
        mx = Math.max(mx, iterationHoldMs(b.steps, perStepP50, fallbackMs));
      }
      total += mx;
    } else {
      let mx = iterationHoldMs(s.then, perStepP50, fallbackMs, defaultThink);
      for (const e of s.elif) {
        mx = Math.max(mx, iterationHoldMs(e.then, perStepP50, fallbackMs, defaultThink));
      }
      mx = Math.max(mx, iterationHoldMs(s.else, perStepP50, fallbackMs, defaultThink));
      total += mx;
    }
  }
  return total;
}
```
**import 주의**: `sizing.ts`의 현행 import는 `import type { Step } from "../scenario/model";`다. `Scenario`를 추가하면 **미사용 타입 import**가 되어 `pnpm lint`(`--max-warnings=0`)가 실패한다 → `import type { Step, ThinkTime } from "../scenario/model";`로만 바꿀 것.

- [ ] **Step 4: `openLoopChecks.ts` — 파라미터 + 배선**

```ts
export function iterationTimeUpperBoundSeconds(
  steps: ReadonlyArray<Step>,
  httpTimeoutSec: number,
  /** 시나리오 기본 think time(상속 스텝의 상한에 max_ms를 더한다). parallel 분기 재귀엔 미전달 — 엔진 R4 미러. */
  defaultThink?: ThinkTime,
): number {
  let total = 0;
  for (const s of steps) {
    if (s.type === "http") {
      const stepTimeout = s.timeout_seconds ?? httpTimeoutSec;
      const thinkMs = (s.think_time ?? defaultThink)?.max_ms ?? 0;
      total += stepTimeout + thinkMs / 1000;
    } else if (s.type === "loop") {
      total += s.repeat * iterationTimeUpperBoundSeconds(s.do, httpTimeoutSec, defaultThink);
    } else if (s.type === "parallel") {
      let mx = 0;
      for (const b of s.branches) {
        mx = Math.max(mx, iterationTimeUpperBoundSeconds(b.steps, httpTimeoutSec)); // 분기엔 기본값 미적용
      }
      total += mx;
    } else {
      // if — 단일 분기만 실행 → 상한 = then/elif[].then/else 중 max (기존 로직 유지 + defaultThink 전달)
      let mx = iterationTimeUpperBoundSeconds(s.then, httpTimeoutSec, defaultThink);
      for (const e of s.elif) {
        mx = Math.max(mx, iterationTimeUpperBoundSeconds(e.then, httpTimeoutSec, defaultThink));
      }
      mx = Math.max(mx, iterationTimeUpperBoundSeconds(s.else, httpTimeoutSec, defaultThink));
      total += mx;
    }
  }
  return total;
}
```
**주의**: if arm의 기존 로직(then/elif/else max)을 지우지 말 것 — 지우면 `openLoopChecks.test.ts`의 기존 케이스(9/6/10초 기대)가 깨진다.

**배선(`:89` `openLoopWarnings` 내부)**:
```ts
    const T = iterationTimeUpperBoundSeconds(
      scenario.steps,
      httpTimeoutSeconds,
      scenario.default_think_time,
    );
```

- [ ] **Step 5: `SlotSizingHelper.tsx` 배선(`:48`) + `VuSizingHelper.tsx` 페이로드(`:91`)**

```ts
      const hold = iterationHoldMs(scenario.steps, p50, rep.summary.mean_ms, scenario.default_think_time);
```

```ts
  const runMeasure = () => {
    const yaml = scenarioQ.data?.yaml;
    if (!yaml) return;
    // SlotSizingHelper와 같은 앵커 정의: 반복 점유시간에는 think time이 포함된다.
    testRun.mutate({ scenario_yaml: yaml, env, apply_think_time: true });
  };
```

- [ ] **Step 6: 테스트 통과 + 전체 게이트**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-defaults/ui && pnpm test -- sizing openLoopChecks SlotSizingHelper VuSizingHelper && pnpm lint && pnpm test && pnpm build`
Expected: 전부 PASS (기존 `iterationHoldMs` 호출 5곳·`iterationTimeUpperBoundSeconds` 9곳은 후행 optional이라 무변경 green)

- [ ] **Step 7: 커밋**

```bash
git add ui/src/components/sizing.ts ui/src/components/openLoopChecks.ts ui/src/components/SlotSizingHelper.tsx ui/src/components/VuSizingHelper.tsx ui/src/components/__tests__
git commit -m "fix(ui): 사이징 워커가 시나리오 기본 think time을 반영 — 슬롯 과소추천/부하 divergence 방지 (R15)"
```

---

## Task 4: UI 표면 — 기본값 섹션 + 인스펙터 3상태 + 패널 개명 (R7, R8, R9, R11, R12, R17)

**Files:**
- Create: `ui/src/components/scenario/ScenarioDefaults.tsx`, `ui/src/components/scenario/__tests__/ScenarioDefaults.test.tsx`
- Modify: `ui/src/components/scenario/EditorShell.tsx`, `ui/src/components/scenario/Inspector.tsx`, `ui/src/i18n/ko.ts`
- Test: 위 신규 + `ui/src/components/scenario/__tests__/Inspector.test.tsx`, `ui/src/components/scenario/__tests__/EditorShell.test.tsx`(R17), `ui/src/components/scenario/__tests__/FlowOutline.test.tsx`(R11 lock-in)

**Interfaces:**
- Consumes: Task 2의 `model.default_think_time`, `setDefaultThinkTime`, `isInsideParallelBranch`.
- Produces: 사용자 표면(더 소비하는 task 없음).

> **⚠ 스텝 순서 고정**: `ui/src/i18n/ko.ts`는 **prod path**라(`tdd-guard.sh`가 `/ui/src/.+\.(ts|tsx)$`를 매칭) 작업트리에 pending 테스트가 없으면 편집이 **차단된다**. 그래서 **테스트 파일부터** 쓴다(Step 1) → 그다음 `ko.ts`(Step 2). 테스트가 아직 없는 `ko.editor.*` 키를 참조해 RED가 나는 건 정상이다.

- [ ] **Step 1: `ScenarioDefaults` 테스트 먼저 (RED)**

`ui/src/components/scenario/__tests__/ScenarioDefaults.test.tsx` — `Inspector.test.tsx`의 store 시딩 이디엄(`useScenarioEditor.getState().loadFromString(YAML)` + `render`)을 그대로 따른다:

```tsx
it("min/max를 입력하면 YAML에 default_think_time이 쓰이고, 비우면 사라진다", async () => {
  useScenarioEditor.getState().loadFromString(VALID_YAML);
  render(<ScenarioDefaults />);
  // 접이식이므로 먼저 펼친다(제목 버튼 클릭)
  await userEvent.click(screen.getByRole("button", { name: new RegExp(ko.editor.scenarioDefaultsTitle) }));
  const min = screen.getByLabelText(ko.editor.fieldDefaultThinkMin);
  const max = screen.getByLabelText(ko.editor.fieldDefaultThinkMax);
  fireEvent.change(min, { target: { value: "500" } });
  fireEvent.change(max, { target: { value: "1000" } });
  fireEvent.blur(max);
  expect(useScenarioEditor.getState().model?.default_think_time).toEqual({ min_ms: 500, max_ms: 1000 });
  expect(useScenarioEditor.getState().yamlText).toContain("default_think_time");

  fireEvent.change(min, { target: { value: "" } });
  fireEvent.change(max, { target: { value: "" } });
  fireEvent.blur(max);
  expect(useScenarioEditor.getState().model?.default_think_time).toBeUndefined();
  expect(useScenarioEditor.getState().yamlText).not.toContain("default_think_time");
});
```

- [ ] **Step 2: 카피 추가 (`ko.ts`)**

위 §카피 표의 신규 키 10개를 `ko.editor` 블록에 추가하고, 개명 3개(`varsToggle`/`varsToggleAria`/`varsPanelAria`)의 **값만** 교체한다. `variablesTitle`·`varsWide*`는 건드리지 않는다.

- [ ] **Step 3: `ScenarioDefaults.tsx` 구현**

`VariablesPanel` 아래에 놓일 **접이식 섹션**. 규칙:
- 루트: `<section className="shrink-0 …">` — **`shrink-0` 필수**(`VariablesPanel`이 `flex-1`이라 안 그러면 세로 공간을 다툰다).
- 제목 버튼: `aria-expanded`로 접힘/펼침(에디터의 `InspectorSection` 이디엄과 동일한 `▾`/`▸` + 제목). 기본 **접힘**, 값이 있으면 접힌 상태에 `ko.editor.defaultThinkSetHint`("설정됨") 힌트를 옆에 표시(사용자 선호: optional 섹션은 접이식 + 값 있으면 힌트).
- 내용: `Field label={ko.editor.fieldDefaultThinkMin}` + `Input numeric type="number" min={0} max={600000}` 2칸(min/max). **Inspector의 `commitThinkTime`과 동일한 draft + commit-on-blur 규칙**:
  - 두 칸 다 비면 → `setDefaultThinkTime(undefined)`(키 제거)
  - 정확히 한 칸만 비면 → no-op(입력 중)
  - 둘 다 유효(정수, `0 ≤ min ≤ max ≤ 600000`)면 → `setDefaultThinkTime({min_ms, max_ms})`
  - 그 외(NaN/범위밖/min>max) → 마지막 커밋값으로 draft 되돌리기
  - `model.default_think_time`이 바뀌면 draft 재시드(`useEffect`)
- 하단: `<p className="text-xs text-slate-500">{ko.editor.defaultThinkHint}</p>` + `<HelpTip label={ko.editor.defaultThinkParallelHelpLabel}>{ko.editor.defaultThinkParallelHelp}</HelpTip>`
- 스토어 접근: `const model = useScenarioEditor((s) => s.model); const setDefaultThinkTime = useScenarioEditor((s) => s.setDefaultThinkTime);`

- [ ] **Step 4: `EditorShell.tsx` 마운트**

```tsx
        {(varsWide || varsOpen) && (
          <aside
            role="complementary"
            aria-label={ko.editor.varsPanelAria}
            className={`flex min-h-0 flex-col gap-3 overflow-visible rounded-md border border-slate-200 bg-white p-3 ${wideOpen ? capClass : ""}`}
          >
            <VariablesPanel onJumpToStep={jumpToStep} />
            <ScenarioDefaults />
          </aside>
        )}
```
(`gap-3`은 두 섹션 간격 — 기존 클래스에 없으면 추가. `aria-label`은 개명된 `varsPanelAria` 값을 그대로 쓰므로 코드 변경 없음.)

- [ ] **Step 5: `Inspector.tsx` — 3상태 + 분기 안내 테스트 먼저 (RED)**

`Inspector.test.tsx`에 픽스처와 테스트 3개를 추가한다. 스텝 선택·섹션 펼치기는 이 파일의 기존 이디엄(`useScenarioEditor.getState().loadFromString(...)` + `select(id)`, 섹션 제목 버튼 클릭)을 따른다:

```tsx
const DEFAULTS_YAML = `version: 1
name: "demo"
default_think_time:
  min_ms: 500
  max_ms: 1000
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: POST
      url: "/login"
  - id: "01HX0000000000000000000020"
    name: "assets"
    type: parallel
    branches:
      - name: "b1"
        steps:
          - id: "01HX0000000000000000000021"
            name: "img"
            type: http
            request:
              method: GET
              url: "/img"
`;

async function openPacing(user: ReturnType<typeof userEvent.setup>) {
  const btn = screen.queryByRole("button", { name: new RegExp(ko.editor.sectionPacing) });
  if (btn && btn.getAttribute("aria-expanded") === "false") await user.click(btn);
}

it("상속 중이면 시나리오 기본값 힌트를 보여준다 (기본값 없으면 안 보여준다)", async () => {
  const user = userEvent.setup();
  act(() => {
    useScenarioEditor.getState().loadFromString(DEFAULTS_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000001");
  });
  render(<Inspector />);
  await openPacing(user);
  expect(screen.getByText(ko.editor.inheritedThink(500, 1000))).toBeInTheDocument();

  // 기본값이 없는 시나리오 → 힌트 없음(R10 회귀 0)
  act(() => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000001");
  });
  expect(screen.queryByText(/상속 중/)).not.toBeInTheDocument();
});

it("'이 스텝은 대기 없음' 체크 → think_time {0,0} + 입력 disabled, 해제 → 키 제거(상속 복귀)", async () => {
  const user = userEvent.setup();
  act(() => {
    useScenarioEditor.getState().loadFromString(DEFAULTS_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000001");
  });
  render(<Inspector />);
  await openPacing(user);

  await user.click(screen.getByLabelText(ko.editor.stepNoWaitLabel));
  const step = () =>
    useScenarioEditor
      .getState()
      .model!.steps.find((s) => s.id === "01HX0000000000000000000001") as { think_time?: unknown };
  expect(step().think_time).toEqual({ min_ms: 0, max_ms: 0 });
  expect(screen.getByLabelText(ko.editor.fieldThinkMin)).toBeDisabled();
  expect(screen.getByLabelText(ko.editor.fieldThinkMax)).toBeDisabled();

  await user.click(screen.getByLabelText(ko.editor.stepNoWaitLabel));
  expect(step().think_time).toBeUndefined();
  expect(screen.getByLabelText(ko.editor.fieldThinkMin)).not.toBeDisabled();
});

it("parallel 분기 내부 스텝엔 미적용 안내가 뜨고 상속 힌트는 숨는다", async () => {
  const user = userEvent.setup();
  act(() => {
    useScenarioEditor.getState().loadFromString(DEFAULTS_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000021"); // 분기 안 http
  });
  render(<Inspector />);
  await openPacing(user);
  expect(screen.getByText(ko.editor.parallelNoDefaultNote)).toBeInTheDocument();
  expect(screen.queryByText(ko.editor.inheritedThink(500, 1000))).not.toBeInTheDocument();
});
```
(`ko.editor.fieldThinkMin`/`fieldThinkMax`는 기존 키 — 인스펙터 min/max 입력의 라벨이다.)

- [ ] **Step 6: `Inspector.tsx` 구현**

페이싱(`sectionPacing`) 섹션 안:

```tsx
const model = useScenarioEditor((s) => s.model);
const defaultThink = model?.default_think_time;
const insideParallel = model ? isInsideParallelBranch(model.steps, step.id) : false;
const noWait = step.think_time?.min_ms === 0 && step.think_time?.max_ms === 0;
const inheriting = step.think_time === undefined;
```

- 체크박스(입력 위):
```tsx
<label className="flex items-center gap-2 text-xs text-slate-600">
  <input
    type="checkbox"
    checked={noWait}
    onChange={(e) => setStepField(step.id, ["think_time"], e.target.checked ? { min_ms: 0, max_ms: 0 } : undefined)}
  />
  {ko.editor.stepNoWaitLabel}
</label>
```
- min/max `Input`에 `disabled={noWait}` 추가.
- 힌트 영역:
```tsx
{insideParallel ? (
  <p className="text-xs text-amber-700">{ko.editor.parallelNoDefaultNote}</p>
) : inheriting && defaultThink ? (
  <p className="text-xs text-slate-500">{ko.editor.inheritedThink(defaultThink.min_ms, defaultThink.max_ms)}</p>
) : null}
<p className="text-xs text-slate-500">{ko.editor.thinkHint}</p>
```
(기본값이 없고 분기 밖이면 현행과 동일한 화면 — R10.)

- [ ] **Step 7: R11 lock-in + R17 패널 테스트**

`FlowOutline.test.tsx`(R11 — 구현 변경 0, 현행 `step.think_time !== undefined` 게이트를 못박는 lock-in):

```tsx
it("wide 칩은 스텝 명시값만 — 시나리오 기본값 상속 스텝엔 think 칩이 없다", () => {
  // default_think_time만 있고 스텝엔 think_time이 없는 시나리오를 로드 →
  // wide 아웃라인 렌더 → think 칩(ko.editor.wideChipThink 패턴) 부재 단언
  act(() => useScenarioEditor.getState().loadFromString(DEFAULTS_ONLY_YAML));
  render(<FlowOutline wide />);
  expect(screen.queryByText(/think \d+–\d+ms/)).not.toBeInTheDocument();
});
```

`EditorShell.test.tsx`(R17 — 개명된 패널이 두 섹션을 함께 담고 함께 접힌다):

```tsx
it("왼쪽 패널이 변수와 시나리오 기본값을 함께 담고, 토글로 함께 접힌다", async () => {
  const user = userEvent.setup();
  render(<EditorShell />); // 이 파일의 기존 렌더 이디엄 사용
  expect(screen.getByText(ko.editor.variablesTitle)).toBeInTheDocument();
  expect(screen.getByText(ko.editor.scenarioDefaultsTitle)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: ko.editor.varsToggleAria }));
  expect(screen.queryByText(ko.editor.variablesTitle)).not.toBeInTheDocument();
  expect(screen.queryByText(ko.editor.scenarioDefaultsTitle)).not.toBeInTheDocument();
});
```

- [ ] **Step 8: 게이트 + 한글 리터럴 0 확인**

Run:
```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-defaults/ui && pnpm lint && pnpm test && pnpm build
grep -nP '[가-힣]' src/components/scenario/ScenarioDefaults.tsx src/components/scenario/Inspector.tsx | grep -v '^\s*[0-9]*:\s*//' | grep -v '\*'
```
Expected: 게이트 전부 PASS. grep 결과 **0줄**(주석 제외 — 문구는 전부 `ko.*` 경유, R12). Inspector도 이번에 문구가 늘었으므로 함께 grep한다.

- [ ] **Step 9: 커밋**

```bash
git add ui/src/components/scenario/ScenarioDefaults.tsx ui/src/components/scenario/EditorShell.tsx ui/src/components/scenario/Inspector.tsx ui/src/i18n/ko.ts ui/src/components/scenario/__tests__
git commit -m "feat(ui): 시나리오 기본값 섹션 + 인스펙터 상속/대기없음/분기 안내 + 패널 개명 (R7/R8/R9/R11/R12/R17)"
```

---

## Task 5: 라이브 검증 (R13) — orchestrator 직접 수행

> subagent에 위임하지 말 것(절차적 curl+Playwright라 메인 세션이 더 안전·빠름). `/live-verify` 스킬 사용.

- [ ] **Step 1: 워크트리 자체 바이너리 빌드**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-defaults
cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller
cd ui && pnpm build && cd ..
```
**필수**: `Scenario`가 `deny_unknown_fields`라 **stale 워커**는 `default_think_time`이 든 YAML을 못 읽어 run이 즉시 failed되고, **stale 컨트롤러**는 `POST/PUT /api/scenarios`에서 **422로 저장 자체를 거부**한다.

- [ ] **Step 2: 스택 기동**

python `ThreadingHTTPServer` 200-responder + 격리 DB:
```bash
./target/debug/controller --db /tmp/think-defaults.db --ui-dir ui/dist
```

- [ ] **Step 3: RPS 실측 (기본값 상속)**

시나리오: 기본값 `min_ms: 500, max_ms: 500` + http 3스텝(전부 상속), run: `vus=2, duration_seconds=20`.
**단위 주의**: 리포트 `summary.rps`는 *요청*/초(`total_count/duration`)다.
기대: `rps ≈ VUs × 스텝수 ÷ (대기 스텝수 × think) = 2 × 3 ÷ (3 × 0.5) = **4.0**` (기본값 없을 때 대비 수백 배 하락).

- [ ] **Step 4: 0/0 opt-out 실측**

같은 시나리오에서 한 스텝만 `think_time: {min_ms: 0, max_ms: 0}` → 대기 지점 2곳 → 기대 `rps ≈ 2 × 3 ÷ (2 × 0.5) = **6.0**`.

- [ ] **Step 5: parallel 미적용 실측**

parallel 분기에 http 스텝을 둔 시나리오 + 기본값 500ms → 리포트의 그룹/페이지 레이턴시가 기본값만큼 늘지 **않음**을 확인(분기 스텝에 명시하면 늘어남).

- [ ] **Step 6: 에디터 GUI 왕복 (Playwright)**

에디터에서 "시나리오 기본값" 섹션 펼치기 → min/max 입력 → YAML 모달에 `default_think_time` 반영 확인 → **새로고침 후에도 값이 읽힘**(R14 write-only 회귀 방지) → 인스펙터에서 상속 힌트 확인 → parallel 분기 스텝에서 미적용 안내 확인 → 콘솔 앱 에러 0.

- [ ] **Step 7: 와이어 0-diff 최종 확인**

```bash
git diff master --stat -- crates/proto crates/controller
```
Expected: **출력 없음**(R6).

---

## 최종 리뷰 (orchestrator)

- `handicap-reviewer`(명시 `model: opus`) — 크로스커팅·repo 함정·**UI Zod ↔ engine serde 와이어 1:1 대조**(`default_think_time` 키/타입/optional 의미).
- `security-reviewer` path-gate: diff가 요청실행·템플릿/캐스트·env/데이터셋 바인딩·업로드파싱·trace/body 뷰어를 건드리는가? → **think time은 페이싱(sleep)만 건드리므로 무매치 예상 → N/A**. `/finish-slice` §0의 grep으로 확인할 것.
- 각 task의 code-quality 리뷰는 **엔진(Task 1)만 `model: opus`**(path-gate: `engine/`·동시성), Task 2–4는 Sonnet.

spec: `spec-plan-reviewer` clean APPROVE (4라운드 — 호출부 3곳·normalize 읽기·사이징 패리티·라이브 단위 교정).
plan: `spec-plan-reviewer` clean APPROVE (2라운드 — 진입점 3개 분기·빈 스텁 5개 실단언화·tdd-guard 순서·if arm 복원·import).

<!-- REVIEW-GATE: APPROVED -->

# 시나리오 에디터 test-run 설계 (후보 영역 C / spec §7 실현)

* Status: 설계 (구현 전). 신규 ADR-0026 예정.
* Date: 2026-06-01
* 관련 ADR: ADR-0013(Scenario↔Run config 분리), ADR-0014(변수 표기 `{{var}}`/`${ENV}`), ADR-0016(VU = tokio task), ADR-0019(워커 dispatcher 추상화 — subprocess/K8s Job), ADR-0025(환경 = env-namespace 재사용 리소스 + 클라 오버레이)
* 신규 ADR: ADR-0026 (test-run = ephemeral in-process 엔진 trace; 워커 격리 미사용 + 워커 경로 확장 이음새 + raw 응답 trace로 미래 extract-authoring 대비 + 의미검증에 422(신규 `ApiError::Unprocessable`, 레거시 400 유지))
* 로드맵: `docs/roadmap.md` §A6 후속("시나리오 에디터 환경 선택 test-run", spec §7). 영역 B(환경)가 깐 `<EnvironmentPicker>`/`resolveEnv` 재사용 이음새 위에 올라탄다.
* 원천: 환경 spec(`2026-05-31-global-variables-environments-design.md`) §7 "확장성" — "추후 시나리오 수정 화면에서 환경 선택 → 시나리오 1회 test-run 기능이 들어올 예정. v1 의 환경 선택 컴포넌트 + env 병합 유틸을 RunDialog 와 분리된 재사용 단위로 만들어, 그 기능이 그대로 끌어 쓰게 한다."

## 1. 개요 · 목표

**문제**: 시나리오를 편집(드래그-드롭 캔버스 또는 YAML)하는 도중, "이게 실제로 도는가 / URL·헤더·body가 맞게 해석되는가 / 내 `extract`·분기 조건이 의도대로 동작하는가"를 확인하려면 지금은 **저장 → runs 목록 → RunDialog → 부하 run 생성 → 종료 후 리포트**라는 무거운 왕복을 거쳐야 한다. 부하 리포트는 집계(RPS/percentile/status 분포)라 "이 요청이 정확히 뭘 보냈고 뭘 받았나"를 안 보여준다.

**목표**: 에디터를 **떠나지 않고** 현재 편집 중인 시나리오를 **1회 실행**해, **요청별 상세(trace)** 를 즉시 본다. 이것은 **부하 측정이 아니라 디버그 probe** 다. 1 VU · 시나리오 1회 통과.

**핵심 결정** (brainstorming 2026-06-01 확정):

- **성격 = 경량 스모크.** 1 VU, 시나리오 steps 1회 통과, ramp 없음. 결과는 집계 메트릭이 아니라 **순서 있는 요청별 trace**.
- **대상 = 현재 에디터 버퍼(미저장 포함).** `scenario_id`가 아니라 **inline 시나리오 YAML**을 백엔드로 보낸다. 저장 강제 없음(dirty 상태에서도 동작). → 백엔드 입력 계약이 `POST /api/runs`(scenario_id 기반)와 다르므로 **전용 ephemeral 엔드포인트**가 필요.
- **실행 = 컨트롤러 in-process(엔진 직접 호출), 동기 응답.** 컨트롤러가 이미 엔진 라이브러리를 링크하므로(§"기존 코드 사실") `trace_scenario`를 그 자리에서 호출해 **한 번의 HTTP 요청/응답**으로 trace를 돌려준다. 워커·gRPC·proto 무변경. (프로덕션 워커 격리(ADR-0019)는 수천 VU 부하 확장·크래시 격리가 목적이라 1 VU·1회 probe엔 해당 안 됨.)
- **저장 = 완전 ephemeral.** DB 저장 0, 새 테이블/마이그레이션 0. trace는 응답으로만 와서 에디터 안에 인라인 표시. runs 목록은 부하 테스트 기록으로 깨끗하게 유지.
- **요청 상한 = 사용자 설정값.** 큰 loop가 있는 시나리오는 스모크가 수백 요청을 낼 수 있어, **총 HTTP 호출 상한을 사용자가 지정**(기본 50)한다. 긴 시나리오를 끝까지 돌리려 cap을 올릴 수 있게 하되, 폭주 방지용 하드 상한을 둔다.
- **확장성 우선 설계.** (1) trace 캡처 함수는 **엔진 라이브러리**에 두어 컨트롤러(v1)와 미래 워커 경로가 같은 코드를 부르게 한다. (2) trace는 **raw 응답(body·headers·cookie)** 을 충분히 담아, 미래 "응답에서 extract 변수 지정" authoring 기능이 그대로 올라타게 한다(§8).

## 2. 기존 코드 사실 확인 (구현 전 코드 대조)

- ✅ **컨트롤러가 이미 엔진 크레이트를 링크.** `crates/controller/Cargo.toml`: `handicap-engine = { path = "../engine" }`. 이미 `handicap_engine::Scenario`/`Scenario::from_yaml`을 `api/scenarios.rs`·`store/scenarios.rs`에서 쓰고, `report.rs`가 `percentiles::*`를 쓴다. → in-process 엔진 호출은 의존성 차원에서 추가 비용 0.
- ✅ **`execute_step`이 이미 스텝별 trace 절반을 반환.** `crates/engine/src/executor.rs:32` `ExecOutcome { step_id, status, latency, error, extracted: BTreeMap<String,String> }`. `execute_step`(`executor.rs:69`)이 status·latency·assert 실패·추출 변수를 채운다. **단 응답 body/headers는 extract용으로 읽은 뒤 버린다**(`executor.rs:140` `body_bytes`) — trace는 이걸 보존해야 한다(§4, §5-1).
- ⚠️ **재귀 인터프리터는 `as-is` 재사용은 불가하나, "120행 재구현"은 과장 — 공유 헬퍼로 중복을 bound.** `runner.rs:282-404` `execute_steps(client, steps, iter_vars, agg, deadline, env, vu_id, iter_id, loop_index, cancel)`의 **제어 흐름 골격**(steps 순회 → http/loop/if arm; `Step::Loop`은 `0..repeat`+`loop_index` 재귀; `Step::If`는 분기 선택+라벨 후 재귀; http는 `iter_vars.extend(extracted)` 오버레이; `iter_vars`는 `scenario.variables` 시드, `runner.rs:236`)은 **부하·trace가 동일**하다. 부하 전용으로 묶인 건 ① `agg.lock().record(...)`/`record_branch(...)`, ② `deadline: Instant`(3곳 체크)+`StepFlow{Continue,DeadlineReached,Aborted}`, ③ `cancel` 뿐 — trace는 ①을 `Vec<StepTrace>` push, ②를 `max_requests`/wall-clock 천장+`truncated`로, ③ 없음으로 대체한다. **두 구현 경로**:
  - **경로 A(권장) — 독립 trace 인터프리터**: 골격을 별도 작성하되 ① **if 분기 선택+라벨 블록**(`runner.rs:353-379`, 가장 까다롭고 부하·trace 동일)을 공유 `fn select_branch(if_step, ctx) -> (&[Step], String)`로, ② 요청 빌드를 공유 헬퍼(§3-1 C-1 task 1)로 뽑으면 — **남는 중복은 ~40-50행 얇은 arm 배선**(분기 라벨 리터럴 `runner.rs:362-375`는 `select_branch`로 단일 출처화 → drift 0). **부하 hot path는 글자 그대로 무변경**(최대 안전, 이 repo의 처리량 A/B 문화 부합).
  - **경로 B — `execute_steps`를 sink+stop-policy로 제네릭화**: 인터프리터 1개가 두 sink(`record` vs `push`)와 stop-policy(deadline/cancel vs counter/ceiling)를 받음 → 중복 0. 단 hot-path 인터프리터를 건드려(제네릭/async-trait) **처리량 재검증 필수** + 제네릭+`Box::pin` 재귀의 추가 복잡도. 위험 대비 이득이 작아 v1은 **경로 A 채택**, B는 후속 리팩터 여지로만.
- ⚠️ **lenient 렌더러는 존재하나 "어떤 토큰이 미바인딩됐는지"는 안 알려준다.** `template.rs:33`의 `render_lenient`(미해결 토큰 → 빈 문자열, 절대 `Err` 안 냄; `eval_condition`이 이미 사용)는 bare `String`만 반환하고 미해결 토큰 목록을 버린다. strict `render`는 미바인딩 변수에 `EngineError::UnknownVar`. → test-run은 디버그라 **lenient 렌더**를 쓰지만, `StepTrace.unbound_vars`(§3-1)를 채우려면 **token-collecting render 변형이 신규로 필요**하다(§3-2, §9 C-1 별도 task — 공짜 아님).
- ✅ **`Scenario`는 5필드.** `scenario.rs:11-19` `Scenario { version: u32, name: String, variables: BTreeMap<String,String>(default), cookie_jar: CookieJarMode(default), steps: Vec<Step> }`, `Step` = `Http|Loop|If`(internally-tagged `#[serde(tag="type")]`). **`version`·`name`은 serde default가 없어 inline YAML에 반드시 포함**돼야 `from_yaml`이 통과(에디터 버퍼는 이미 둘을 담음 — 빈 steps만 비는 케이스). `trace_scenario`는 `VuClient` 생성 시 **`scenario.cookie_jar`를 존중**해야 한다(`runner.rs:229` `VuClient::new(scenario.cookie_jar)`와 동일 — 하드코딩 `Auto` 금지).
- ✅ **`<EnvironmentPicker>` + `resolveEnv` 재사용 이음새 완비(B-2).** `ui/src/components/EnvironmentPicker.tsx`(controlled: `selectedEnvId`/`baseVars`/`overrides`를 부모가 소유), `ui/src/api/envOverlay.ts::resolveEnv(base, overrides)`(override 승, 평탄 맵 반환), `useEnvironments()`/`useEnvironment(id)` 훅. RunDialog와 비결합이라 에디터가 그대로 import.
- ✅ **에디터 셸 구조.** `ui/src/components/scenario/EditorShell.tsx`는 3-컬럼 그리드(VariablesPanel | 캔버스/YAML | Inspector). `ui/src/pages/ScenarioEditPage.tsx`가 **현재 버퍼 `yamlText`(EditorShell `onChange`로 받음) + `dirty` 플래그**를 보유하고 Save/Back을 렌더. → test-run 버튼·EnvironmentPicker·결과 패널의 home은 `ScenarioEditPage`(버퍼를 가진 쪽).
- ⚠️ **에러 상태코드 — 이 엔드포인트는 의미 검증에 422를 쓴다(신규 `ApiError::Unprocessable` 변형 추가).** 현재 `error.rs:7-25` `ApiError`엔 422 변형이 없고, 기존 검증(`runs.rs`/`presets.rs`/`environments.rs`/`datasets.rs`)은 전부 **400**(`BadRequest`)이다. 그러나 axum `Json` 추출기는 이 엔드포인트에서도 **well-formed JSON·틀린 필드 타입 → 422**를 이미 낸다(기존 함정 "비문자열 env→422"가 이것). 핸들러가 의미 검증을 400으로 내면 같은 엔드포인트 안에서 400/422가 뒤섞여 더 모호해진다. → **`ApiError::Unprocessable`(422)을 신규 추가**하고, 이 엔드포인트의 **의미 검증(시나리오 YAML 파싱 실패·`max_requests` 범위 초과)을 422**로, malformed JSON 문법 오류만 axum 기본 400으로 둔다(RFC: 422 = well-formed but unprocessable content; axum 422와 일관). **레거시 엔드포인트는 400 유지**(교차 불일치는 의도된 분기 — controller `CLAUDE.md`에 기록). `Scenario::from_yaml` 실패는 현재 `ApiError::Scenario(EngineError)`→400(`error.rs:37`)이라, **test-run 핸들러는 `from_yaml` 에러를 `ApiError::Unprocessable`로 매핑**(`?` 자동 변환에 기대지 말 것 — 명시 `map_err`).
- ✅ **라우팅 패턴.** `app.rs`가 `.route("/scenarios", …)`·`.route("/scenarios/{id}", get/put)`(`app.rs:33-40`)를 가짐. (정정: axum 0.8/matchit 0.8에선 정적 세그먼트 `/scenarios/test-run`과 파라미터 `/scenarios/{id}`가 **panic 없이 공존**하고 정적이 우선이며, `/scenarios/{id}`는 POST 미등록이라 실제 충돌도 없다 — 즉 기술적 "충돌"은 아니다.) 그럼에도 ephemeral·scenario-less 성격을 분명히 하려 **top-level `POST /api/test-runs`**로 둔다(의미 명확화 + `{id}` 네임스페이스 비침범).

## 3. 백엔드 — 엔진 trace 인터프리터

**3-1. 새 엔진 trace 모듈** (`crates/engine/src/trace.rs`, `lib.rs`에 `pub mod trace;` + 재노출)

```
pub struct TraceOptions {
    pub env: BTreeMap<String, String>,
    pub max_requests: u32,   // 사용자 설정 호출 상한 (controller가 경계 검증)
}

pub struct ScenarioTrace {
    pub ok: bool,                    // 모든 http 스텝 error == None
    pub total_ms: u64,               // 전체 소요(벽시계)
    pub steps: Vec<StepTrace>,       // 실행 순서대로
    pub final_vars: BTreeMap<String, String>,  // 종료 시점 iter_vars(시드+extract)
    pub truncated: bool,             // max_requests 도달로 조기 종료
}

pub struct StepTrace {
    pub step_id: String,
    pub kind: StepKind,              // Http | Loop | If (표시·아이콘용)
    pub loop_index: Option<u32>,     // loop 본문 안에서 실행됐으면 0-based
    pub branch: Option<String>,      // if 노드 행에만: 선택된 분기("then"/"elif_{j}"/"else"/"none"). http 행은 None
    // http 스텝만 채워지는 필드:
    pub request: Option<TracedRequest>,   // 해석된 method/url/headers/body
    pub response: Option<TracedResponse>, // status/latency_ms/headers/set_cookie/body(트렁케이트)
    pub extracted: BTreeMap<String, String>,
    pub unbound_vars: Vec<String>,   // lenient 렌더에서 빈 값으로 떨어진 토큰 (§9 task 3 — render_collecting 필요; 연기 시 필드 생략)
    pub error: Option<String>,       // 연결 실패/타임아웃/assert 실패/body read 실패
}
```

- `pub async fn trace_scenario(scenario: &Scenario, opts: &TraceOptions) -> ScenarioTrace` — 단일 VU로 `scenario.steps`를 **1회** 통과. 제어 흐름 형태(loop `repeat` 재귀, if 분기 선택, `iter_vars` 오버레이)는 `execute_steps`를 따르되 **agg/deadline/cancel/StepFlow 없는 병렬 인터프리터**다(§2 ⚠️). **요청 카운터는 http leaf 실행 시에만 +1**(if·loop 노드 행은 카운트 안 함), `max_requests` 도달 시 즉시 중단 + `truncated = true`.
- **serde derive**: `ScenarioTrace`/`StepTrace`/`TracedRequest`/`TracedResponse`는 data-bearing map-shape enum이 아닌 평범한 struct + data-less `StepKind` enum이라 **`#[derive(Serialize, Deserialize)]`로 충분**(`Body`/`Assertion`/`Condition`의 수동 serde 함정 비해당 — `crates/engine/CLAUDE.md`). controller round-trip 테스트가 `from_value::<ScenarioTrace>`를 하므로 **Deserialize도 같이** 단다(`crates/controller/CLAUDE.md`).
- **`execute_step` 응답 캡처 — 순수 additive로**(구현 선택): trace는 해석된 요청 + 응답 body/headers가 필요하다. `execute_step`(`executor.rs:69-185`)은 요청 빌드(:74-115)와 응답 처리(:121-185)가 한 덩어리라 seam이 없다. 두 방안 — (a) `execute_step`에 trace 분기 추가(hot path가 같은 함수를 타 분기 비용·회귀 위험), (b) `execute_step_traced` 자매 함수. **권장 (b), 단 "`run_scenario` 무변경" 보장은 리팩터가 _순수 additive_(새 함수/헬퍼 추가)일 때만 성립** — 기존 `execute_step`을 `build_request()`+`handle_response()`로 _쪼개면_ hot path 호출부도 바뀌므로, 쪼개기보다 **요청 빌드 로직만 작은 헬퍼로 뽑아 두 진입점이 공유**하고 응답 캡처는 traced 쪽에만 더하는 형태로 한다(처리량 회귀 0 검증은 §7 회귀 가드).
- **lenient 렌더 + 미바인딩 수집**: trace 인터프리터는 `render_lenient`로 미바인딩 `{{var}}`/`${ENV}`를 빈 문자열로 둔다. `unbound_vars`(§3-1 struct)를 채우려면 **`template.rs`에 token-collecting 변형**(예: `render_collecting(input, ctx) -> (String, Vec<String>)`)을 신규 추가해 url/headers/body 렌더에 통과시켜야 한다 — 기존 `render_lenient`는 미해결 토큰 목록을 안 준다(§2 ⚠️). 이건 별도 엔진 작업이라 **§9 C-1의 명시 task**로 떼고, C-1 부담이 크면 **`unbound_vars`는 §10 후속으로 연기 가능**(연기 시 v1 trace는 해석된 빈 값만 보여줌).
- **if 노드 trace**: 분기 결정(`branch`)을 if 노드의 `StepTrace`로 1행 남기고(`kind=If`, `request/response=None`), 선택된 분기의 자식들은 그 뒤에 이어서 기록. `none`(조건 false + elif 모두 false + else 없음)도 그대로 기록 — 9d `record_branch` 레이블 규칙(`then`/`elif_{j}`/`else`/`none`)과 동일 의미.
- **loop 노드 trace**: loop 본문 자식은 각 반복마다 `loop_index`를 달아 기록. 호출 상한(`max_requests`)이 loop 폭주의 안전장치.
- **쿠키/세션**: 1 VU라 단일 `VuClient::new(scenario.cookie_jar)`(시나리오가 지정한 모드 존중, ADR-0018)로 전 스텝 공유 — 로그인→후속 호출 세션이 trace에서도 그대로 이어진다.

**3-2. 응답 body 트렁케이션**: `TracedResponse.body`는 **상한 N KB**(기본 16 KiB)까지만 담는다 + `body_truncated: bool`. 거대한 응답이 trace JSON을 폭발시키지 않게.

## 4. REST API — 신규 `POST /api/test-runs`

| 메서드 | 경로 | 동작 |
|---|---|---|
| POST | `/api/test-runs` | body `{ scenario_yaml, env, max_requests?, runner? }`. inline YAML 파싱 → `trace_scenario` in-process → `ScenarioTrace` JSON 동기 반환(200). 파싱 실패 → 422 + 메시지. |

- 신규 핸들러 `crates/controller/src/api/test_runs.rs`. `pub mod test_runs;`는 `api/mod.rs`에, 별칭 import `test_runs as test_runs_api`는 **`app.rs`**(§2 환경 spec의 파일 위치 분리 함정과 동일). `app.rs`에 `.route("/test-runs", post(test_runs_api::create))` 추가.
- DTO: `TestRunRequest { scenario_yaml: String, env: BTreeMap<String,String>, #[serde(default = "default_max_requests")] max_requests: u32, #[serde(default)] runner: Option<String> }`. `TestRunResponse`는 `ScenarioTrace`를 그대로 serde(엔진 타입에 serde derive 또는 controller-side DTO 매핑).
- **검증(controller)** — 의미 검증은 **422(`ApiError::Unprocessable` 신규)**, malformed JSON 문법만 axum 기본 400(§2):
  - `scenario_yaml` 파싱 → 실패 시 **422**(파서 메시지, `from_yaml` 에러를 `map_err`로 `Unprocessable`에 매핑). 빈 steps는 허용(빈 trace 반환).
  - `max_requests`: 1 ≤ n ≤ **하드 상한 10000**(폭주 방지, `loop_breakdown_cap` 선례). 범위 밖 → **422**. (well-formed JSON·틀린 타입(예: 문자열)은 axum 추출기가 자체 422.)
  - `runner`: v1은 `None`/`"controller"`만 의미 있음. 그 외 값은 **거부가 아니라 무시**(미래 호환 — 구버전 컨트롤러가 새 클라의 `runner`를 만나도 깨지지 않게)하고 항상 in-process 실행.
- **안전 천장(주 제한자 아님)**: 사용자가 cap을 올려 긴 시나리오를 끝까지 돌릴 수 있도록 전체 wall-clock 타임아웃은 **넉넉한 천장**(예: 120s)으로 둔다. 실제 제한은 ① `max_requests`, ② 요청별 client 30s 타임아웃(`VuClient`, `executor.rs:21`). 천장 초과 시 부분 trace + `truncated`.
- **proto·워커·runs 테이블·마이그레이션 전부 무변경.**

## 5. UI

**5-1. 에디터 결합** (`ScenarioEditPage` + 신규 결과 패널)

- `ScenarioEditPage`(현재 버퍼 `yamlText` 보유)에 **Test-run 컨트롤 영역** 추가:
  - **"Test run" 버튼** — 현재 `yamlText` + 병합 env + `max_requests`로 `POST /api/test-runs` 호출(React Query mutation). dirty(미저장)여도 동작.
  - **`<EnvironmentPicker>` 재사용**(B-2 컴포넌트 그대로) — `selectedEnvId`/`overrides`/`baseVars` 상태를 `ScenarioEditPage`가 소유, 제출 시 `resolveEnv(baseVars, overrides)`로 평탄 env 맵 생성. 환경 미선택 = override-only. (사소: picker가 "override (이 run 한정)"/"from {env}" 카피를 하드코딩(`EnvironmentPicker.tsx:104,65`) — test-run 맥락에서 "이 run 한정"이 약간 어색하나 구조 재사용엔 무해; 거슬리면 heading prop을 작게 추가.)
  - **요청 상한 입력** — 숫자 input(기본 50, 1~10000), `loop_breakdown_cap` 입력 UX 미러.
- **결과 패널**(신규 `TestRunPanel`, 에디터 하단 접이식): `ScenarioTrace.steps`를 실행 순서대로 카드/행으로:
  - http 행: method 뱃지 · 해석된 url · status 뱃지(2xx 초록/4xx·5xx·error 빨강) · latency_ms · 추출 변수 chips · 펼치면 요청 headers/body + 응답 headers/body.
  - if 행: 조건 요약 + 선택된 분기 라벨(`then`/`elif_n`/`else`/`(미매치)`), loop 자식엔 `#index` 라벨.
  - 미바인딩 변수(`unbound_vars`)는 앰버 경고, `truncated`면 "상한 도달 — 일부만 실행됨" 배너.
- **client/hooks**: `ui/src/api/testRuns.ts`(`TestRunResponse` Zod 스키마 + `createTestRun(body)`), `useTestRun()` mutation 훅. 주의: `client.ts::request<T>`는 **module-private**(`client.ts:30`, export 안 됨) — 공개 표면은 `api` 객체(`client.ts:123`)다. 따라서 `createTestRun`은 **`api` 객체에 메서드로 추가**하거나(established 패턴, `uploadDataset` 선례) `testRuns.ts`에 별도 fetch를 둔다. "`request` 재사용"은 문자 그대로는 불가.

**5-2. 표시용 렌더와의 관계**: 결과 패널의 "해석된 url"은 **서버 trace(`request.url`)** 가 권위 — UI `resolveForDisplay`(관대 표시기)와 별개로, 실제 엔진이 보낸 값을 그대로 보여준다(진단 정확도↑).

## 6. 검증 · 엣지 케이스

- **빈/파싱불가 YAML**: 파싱 불가 → 422 배너. 빈 steps → 빈 trace(정상 200, "실행할 스텝 없음"). (inline YAML엔 `version`+`name`이 있어야 파싱 통과 — §2 5필드.)
- **데이터셋 바인딩 없음(v1)**: 데이터셋 주입은 부하-run 프로파일(RunDialog `DataBindingPanel`) 관심사라 test-run UI에 없다. dataset-소스 `{{var}}`는 미바인딩(빈 값)으로 두고 `unbound_vars`에 표시. → **수동 변수 오버라이드**는 후속(§8-2).
- **민감값 마스킹 없음(v1)**: env·body·응답이 평문으로 trace에 담김(현 `runs.env_json`/리포트와 동일 수준). roadmap B1 후속.
- **큰 응답/큰 loop**: §3-2 body 트렁케이션 + §4 `max_requests` + wall-clock 천장으로 방어.
- **타임아웃/연결 실패**: 요청별 30s client 타임아웃 → 해당 스텝 `error`로 기록하고 trace는 계속(다음 스텝 진행). lenient라 run 자체는 안 죽음.
- **assert 실패**: `execute_step`이 이미 `error`에 "status X != Y"를 채움 → 그 스텝 빨강 표시, 후속 스텝은 계속 진행(스모크는 전체 흐름을 보는 게 목적).

## 7. 테스트 전략 (TDD)

**Rust (engine)**:
- `trace.rs` 단위: flat http 1회 통과 trace(요청/응답/추출 캡처); loop `repeat:N` → 자식이 N회 `loop_index` 0..N; if then/elif/else/none 분기별 `branch` 라벨; `max_requests` 도달 시 `truncated` + 부분 trace; lenient 미바인딩 → `unbound_vars` 채워지고 죽지 않음; body 트렁케이션.
- wiremock 통합: 멀티스텝 + extract 체이닝 + 쿠키 세션이 trace에 순서대로 잡히는지(기존 `executor`/multi-step 통합 패턴 재사용).
- **회귀 가드**: `run_scenario`(부하 hot path) 무변경 확인 — 기존 처리량/메트릭 테스트가 그대로 green.

**Rust (controller)**:
- `tests/test_runs_api_test.rs`: 정상 trace 200; 파싱불가 422; `max_requests` 경계(0/10001 → 422, 1/50/10000 OK); `runner` 알 수 없는 값 무시. (`ApiError::Unprocessable` → 422 매핑도 단위로.)
- **fixture ULID**는 Crockford base32(`I`/`L`/`O`/`U` 제외) — `crates/engine/CLAUDE.md` 함정.

**UI (vitest + RTL)**:
- `testRuns.ts` 스키마 round-trip + `data` null 방어.
- `ScenarioEditPage`/`TestRunPanel`: Test-run 클릭 → mutation 호출 페이로드(현재 yamlText + 병합 env + max_requests) 검증; trace 렌더(http 행 status/latency/추출, if 분기 라벨, 미바인딩 경고, truncated 배너); 422 에러 배너.
- `<EnvironmentPicker>` 재사용 — 기존 RTL 셀렉터(`select environment` 등) 그대로. `await findByRole("option", …)`로 `useEnvironments` settle 대기(B-2 함정).
- 게이트: `pnpm build`(`tsc -b`).

**프로세스**: TDD-guard — 새 `trace.rs`/`api/test_runs.rs`/`*.tsx`는 pending test 파일 먼저(루트 `CLAUDE.md`).

## 8. 확장성 (v1 미구현, 설계만 — 사용자 명시 요청)

1. **응답에서 extract 변수 지정(authoring)**: test-run 후 `TracedResponse`의 raw body/headers/set-cookie에서 사용자가 JSONPath/header/cookie 경로를 골라 **시나리오 스텝의 `extract` 규칙으로 써넣기**. trace가 `step_id` + raw 응답을 담으므로, "이 응답 → 이 스텝의 extract"로 매핑 가능 — v1의 trace 데이터 모델이 이 기능을 **이미 받칠 수 있게** 설계됨. (Inspector `ExtractEditor`에 "응답에서 추가" 진입점을 다는 식.)
2. **수동 변수 오버라이드**: test-run 시 `{{var}}`에 임시값 주입(데이터셋 없이 dataset-소스 변수·로그인 토큰 등을 테스트). `TestRunRequest`에 `var_overrides: map`을 더하고 `iter_vars` 시드에 얹는 작은 확장 — §6 "데이터셋 없음" 통증의 정공 해소.
3. **워커 경로(B)**: "특정 워커 vantage point에서 보내봐야" 하는 디버깅을 위해, 같은 `trace_scenario`를 **워커가 호출**하도록 전송 계층만 추가(새 proto trace 메시지 or 기존 스트림 재사용) + `TestRunRequest.runner` 필드 활성화. **UI 계약·엔진 trace 함수는 불변** — 순수 전송 추가. (brainstorming에서 사용자가 명시적으로 남겨둔 옵션.)

## 9. 슬라이스 분할 (구현 계획용)

위험이 **엔진 trace 인터프리터(신규 병렬 인터프리터 + 응답 캡처)** 와 **에디터 결과 패널(신규 UX)** 두 곳에 나뉘어, 영역 A/B 선례처럼 두 plan으로 나눈다. **C-1은 스펙 초안이 암시한 것보다 무겁다**(리뷰 S1/B2) — 아래 4개 task가 핵심:

- **C-1 — 엔진 trace + 컨트롤러 엔드포인트** (백엔드, UI 무변경):
  1. **요청 빌드 헬퍼 추출 + `execute_step_traced`** — `executor.rs`의 요청 빌드(url/headers/method/body 렌더, :74-115)만 작은 공유 헬퍼로 뽑고, 응답 body/headers 캡처는 traced 진입점에만 더한다(**순수 additive** — `run_scenario` hot path 호출부 무변경).
  2. **`trace_scenario` 독립 인터프리터**(`engine/src/trace.rs`, 경로 A) — `execute_steps`의 loop/if 골격을 agg/deadline/cancel 없이 별도 작성하되, **if 분기 선택+라벨을 공유 `select_branch()`로 추출**(`runner.rs:353-379`를 단일 출처화 → `execute_steps`도 이 헬퍼를 쓰게 리팩터; drift 0). 남는 trace-전용 코드는 ~40-50행 arm 배선. `Vec<StepTrace>` 누적, http leaf에서만 `max_requests` 카운트. trace 타입은 `derive(Serialize, Deserialize)`. (경로 B 제네릭화는 §2 ⚠️대로 후속 여지.)
  3. **(선택) `render_collecting`** — `unbound_vars`를 채우려면 `template.rs`에 token-collecting 렌더 변형 신규 추가(§3-1). **C-1 부담이 크면 이 task만 §10으로 연기**(연기 시 trace는 빈 값만, `unbound_vars` 필드 생략).
  4. **`api/test_runs.rs` + `ApiError::Unprocessable`(422)** — `error.rs`에 422 변형 신규 추가(§2) + controller `CLAUDE.md`에 "test-run만 의미검증 422, 레거시는 400" 의도된 분기 기록. `POST /api/test-runs`(파싱·범위 검증 → 422, `runner` 무시, wall-clock 천장) + 라우팅(`pub mod`은 `api/mod.rs`, 별칭 import는 `app.rs`).
  - **회귀 가드**: `run_scenario`(부하 hot path) 무변경 — 기존 처리량/메트릭 테스트 green 유지.
- **C-2 — 에디터 UI** (유일한 신규 UX): `ScenarioEditPage` Test-run 컨트롤 + `<EnvironmentPicker>` 재사용 + `TestRunPanel` 결과 렌더 + `api/testRuns.ts`/`useTestRun`. C-1의 응답 계약 소비.

## 10. 범위 밖 · 후속 (별도 spec/slice)

- **응답 기반 extract authoring / 수동 변수 오버라이드** — §8-1, §8-2. 본 slice는 trace 데이터 모델로 받칠 수 있게만 설계.
- **(조건부) 미바인딩 변수 표시(`unbound_vars`)** — C-1이 무거우면 §9 task 3(`template.rs` token-collecting 렌더 변형)을 여기로 연기. 연기 시 v1 trace는 해석된 빈 값만 보여주고 `unbound_vars` 필드는 생략.
- **워커 경로 실행 옵션(B)** — §8-3. `runner` 필드 자리만 비워둠.
- **민감값 마스킹** — env·trace 값 평문(현 수준). roadmap B1.
- **test-run 결과 저장/히스토리** — ephemeral 결정(완전 폐기). 필요해지면 별도.
- **다중 VU / 부하성 test-run** — 그건 기존 부하 run의 영역(RunDialog). test-run은 1 VU·1회 디버그로 고정.

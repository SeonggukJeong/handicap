# 시나리오 에디터 test-run 설계 (후보 영역 C / spec §7 실현)

* Status: 설계 (구현 전). 신규 ADR-0026 예정.
* Date: 2026-06-01
* 관련 ADR: ADR-0013(Scenario↔Run config 분리), ADR-0014(변수 표기 `{{var}}`/`${ENV}`), ADR-0016(VU = tokio task), ADR-0019(워커 dispatcher 추상화 — subprocess/K8s Job), ADR-0025(환경 = env-namespace 재사용 리소스 + 클라 오버레이)
* 신규 ADR: ADR-0026 (test-run = ephemeral in-process 엔진 trace; 워커 격리 미사용 + 워커 경로 확장 이음새 + raw 응답 trace로 미래 extract-authoring 대비)
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
- ✅ **재귀 인터프리터가 loop/if + 변수 오버레이를 이미 처리.** `runner.rs:282` `execute_steps(client, steps, iter_vars, agg, deadline, env, vu_id, iter_id, loop_index)` — `Step::Loop`은 `0..repeat` 재귀, `Step::If`는 `eval_condition`으로 분기 선택, http는 `iter_vars.extend(outcome.extracted)`로 오버레이. `iter_vars`는 `scenario.variables`로 시드(`runner.rs:236`). → trace 인터프리터는 이 제어 흐름을 **그대로 따르되 Aggregator 대신 `Vec<StepTrace>`에 기록**.
- ✅ **lenient 렌더러 존재.** `template.rs`의 `render_lenient`(미해결 토큰 → 빈 문자열, 절대 `Err` 안 냄; `eval_condition`이 이미 사용). strict `render`는 미바인딩 변수에 `EngineError::UnknownVar`. → test-run은 디버그라 **lenient 렌더**를 쓰고 미바인딩을 경고로 표시(§5-1).
- ✅ **`Scenario` 모양.** `scenario.rs:11` `Scenario { variables: BTreeMap<String,String>, steps: Vec<Step> }`, `Step` = `Http|Loop|If`(internally-tagged `#[serde(tag="type")]`).
- ✅ **`<EnvironmentPicker>` + `resolveEnv` 재사용 이음새 완비(B-2).** `ui/src/components/EnvironmentPicker.tsx`(controlled: `selectedEnvId`/`baseVars`/`overrides`를 부모가 소유), `ui/src/api/envOverlay.ts::resolveEnv(base, overrides)`(override 승, 평탄 맵 반환), `useEnvironments()`/`useEnvironment(id)` 훅. RunDialog와 비결합이라 에디터가 그대로 import.
- ✅ **에디터 셸 구조.** `ui/src/components/scenario/EditorShell.tsx`는 3-컬럼 그리드(VariablesPanel | 캔버스/YAML | Inspector). `ui/src/pages/ScenarioEditPage.tsx`가 **현재 버퍼 `yamlText`(EditorShell `onChange`로 받음) + `dirty` 플래그**를 보유하고 Save/Back을 렌더. → test-run 버튼·EnvironmentPicker·결과 패널의 home은 `ScenarioEditPage`(버퍼를 가진 쪽).
- ✅ **라우팅 패턴 + 충돌 주의.** `app.rs`가 `.route("/scenarios", …)`·`.route("/scenarios/{id}", get/put)`를 가짐. `POST /scenarios/test-run`은 `{id}` 자리와 겹칠 소지 → **top-level `POST /api/test-runs`**(ephemeral, scenario-less)로 둬 충돌 회피 + "전용 ephemeral 경로" 의미 명확화.

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
    pub unbound_vars: Vec<String>,   // lenient 렌더에서 빈 값으로 떨어진 토큰
    pub error: Option<String>,       // 연결 실패/타임아웃/assert 실패/body read 실패
}
```

- `pub async fn trace_scenario(scenario: &Scenario, opts: &TraceOptions) -> ScenarioTrace` — 단일 VU로 `scenario.steps`를 **1회** 통과. 제어 흐름(loop `repeat` 재귀, if 분기 선택, `iter_vars` 오버레이)은 `execute_steps`를 미러한다. **요청 카운터가 `max_requests`에 도달하면 즉시 중단**하고 `truncated = true`.
- **`execute_step` 확장 vs 자매 함수**(구현 선택): trace는 해석된 요청 + 응답 body/headers가 필요하다. 두 방안 — (a) `execute_step`에 trace-capture 경로를 추가(hot load 경로가 같은 함수를 쓰므로 분기 비용·회귀 위험), (b) `executor.rs`에 `execute_step_traced`(또는 내부 공유 헬퍼로 요청 빌드/응답 처리를 추출해 두 진입점이 공유). **권장 (b)**: `run_scenario`(부하 hot path)는 **무변경**으로 두어 처리량 회귀 0을 보장. 공유 가능한 부분(요청 빌드, JSON/form 렌더)은 헬퍼로 뽑아 중복 최소화.
- **lenient 렌더**: trace 인터프리터는 `render_lenient`를 써서 미바인딩 `{{var}}`/`${ENV}`를 빈 문자열로 두고, 어떤 토큰이 미바인딩됐는지 `unbound_vars`에 모은다(스모크가 죽지 않고 "왜 빈 값인지"를 보여줌).
- **if 노드 trace**: 분기 결정(`branch`)을 if 노드의 `StepTrace`로 1행 남기고(`kind=If`, `request/response=None`), 선택된 분기의 자식들은 그 뒤에 이어서 기록. `none`(조건 false + elif 모두 false + else 없음)도 그대로 기록 — 9d `record_branch` 레이블 규칙(`then`/`elif_{j}`/`else`/`none`)과 동일 의미.
- **loop 노드 trace**: loop 본문 자식은 각 반복마다 `loop_index`를 달아 기록. 호출 상한(`max_requests`)이 loop 폭주의 안전장치.
- **쿠키/세션**: 1 VU라 단일 `VuClient`(자동 cookie jar, ADR-0018)로 전 스텝 공유 — 로그인→후속 호출 세션이 trace에서도 그대로 이어진다.

**3-2. 응답 body 트렁케이션**: `TracedResponse.body`는 **상한 N KB**(기본 16 KiB)까지만 담는다 + `body_truncated: bool`. 거대한 응답이 trace JSON을 폭발시키지 않게.

## 4. REST API — 신규 `POST /api/test-runs`

| 메서드 | 경로 | 동작 |
|---|---|---|
| POST | `/api/test-runs` | body `{ scenario_yaml, env, max_requests?, runner? }`. inline YAML 파싱 → `trace_scenario` in-process → `ScenarioTrace` JSON 동기 반환(200). 파싱 실패 → 422 + 메시지. |

- 신규 핸들러 `crates/controller/src/api/test_runs.rs`. `pub mod test_runs;`는 `api/mod.rs`에, 별칭 import `test_runs as test_runs_api`는 **`app.rs`**(§2 환경 spec의 파일 위치 분리 함정과 동일). `app.rs`에 `.route("/test-runs", post(test_runs_api::create))` 추가.
- DTO: `TestRunRequest { scenario_yaml: String, env: BTreeMap<String,String>, #[serde(default = "default_max_requests")] max_requests: u32, #[serde(default)] runner: Option<String> }`. `TestRunResponse`는 `ScenarioTrace`를 그대로 serde(엔진 타입에 serde derive 또는 controller-side DTO 매핑).
- **검증(controller)**:
  - `scenario_yaml` 파싱 → 실패 시 422(파서 메시지). 빈 steps는 허용(빈 trace 반환).
  - `max_requests`: 1 ≤ n ≤ **하드 상한 10000**(폭주 방지, `loop_breakdown_cap` 선례). 범위 밖 → 422.
  - `runner`: v1은 `None`/`"controller"`만 의미 있음. 그 외 값은 **422가 아니라 무시**(미래 호환 — 구버전 컨트롤러가 새 클라의 `runner`를 만나도 깨지지 않게)하고 항상 in-process 실행.
- **안전 천장(주 제한자 아님)**: 사용자가 cap을 올려 긴 시나리오를 끝까지 돌릴 수 있도록 전체 wall-clock 타임아웃은 **넉넉한 천장**(예: 120s)으로 둔다. 실제 제한은 ① `max_requests`, ② 요청별 client 30s 타임아웃(`VuClient`, `executor.rs:21`). 천장 초과 시 부분 trace + `truncated`.
- **proto·워커·runs 테이블·마이그레이션 전부 무변경.**

## 5. UI

**5-1. 에디터 결합** (`ScenarioEditPage` + 신규 결과 패널)

- `ScenarioEditPage`(현재 버퍼 `yamlText` 보유)에 **Test-run 컨트롤 영역** 추가:
  - **"Test run" 버튼** — 현재 `yamlText` + 병합 env + `max_requests`로 `POST /api/test-runs` 호출(React Query mutation). dirty(미저장)여도 동작.
  - **`<EnvironmentPicker>` 재사용**(B-2 컴포넌트 그대로) — `selectedEnvId`/`overrides`/`baseVars` 상태를 `ScenarioEditPage`가 소유, 제출 시 `resolveEnv(baseVars, overrides)`로 평탄 env 맵 생성. 환경 미선택 = override-only.
  - **요청 상한 입력** — 숫자 input(기본 50, 1~10000), `loop_breakdown_cap` 입력 UX 미러.
- **결과 패널**(신규 `TestRunPanel`, 에디터 하단 접이식): `ScenarioTrace.steps`를 실행 순서대로 카드/행으로:
  - http 행: method 뱃지 · 해석된 url · status 뱃지(2xx 초록/4xx·5xx·error 빨강) · latency_ms · 추출 변수 chips · 펼치면 요청 headers/body + 응답 headers/body.
  - if 행: 조건 요약 + 선택된 분기 라벨(`then`/`elif_n`/`else`/`(미매치)`), loop 자식엔 `#index` 라벨.
  - 미바인딩 변수(`unbound_vars`)는 앰버 경고, `truncated`면 "상한 도달 — 일부만 실행됨" 배너.
- **client/hooks**: `ui/src/api/testRuns.ts`(`TestRunResponse` Zod 스키마 + bare-fetch `createTestRun(body)`), `useTestRun()` mutation 훅. 기존 `client.ts::request` 재사용(JSON POST).

**5-2. 표시용 렌더와의 관계**: 결과 패널의 "해석된 url"은 **서버 trace(`request.url`)** 가 권위 — UI `resolveForDisplay`(관대 표시기)와 별개로, 실제 엔진이 보낸 값을 그대로 보여준다(진단 정확도↑).

## 6. 검증 · 엣지 케이스

- **빈/파싱불가 YAML**: 파싱 불가 → 422 배너. 빈 steps → 빈 trace(정상 200, "실행할 스텝 없음").
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
- `tests/test_runs_api_test.rs`: 정상 trace 200; 파싱불가 422; `max_requests` 경계(0/10001 → 422, 1/50/10000 OK); `runner` 알 수 없는 값 무시.
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

위험이 **엔진 trace 인터프리터(신규 제어흐름 미러 + 응답 캡처)** 와 **에디터 결과 패널(신규 UX)** 두 곳에 나뉘어, 영역 A/B 선례처럼 두 plan으로 나눈다:

- **C-1 — 엔진 trace + 컨트롤러 엔드포인트** (백엔드, UI 무변경): `engine/src/trace.rs`(`trace_scenario`/`StepTrace`/`ScenarioTrace`) + `execute_step` 응답 캡처 확장(공유 헬퍼) + `api/test_runs.rs`(`POST /api/test-runs`, 검증·안전장치) + 라우팅. `run_scenario` 무변경 회귀 가드.
- **C-2 — 에디터 UI** (유일한 신규 UX): `ScenarioEditPage` Test-run 컨트롤 + `<EnvironmentPicker>` 재사용 + `TestRunPanel` 결과 렌더 + `api/testRuns.ts`/`useTestRun`. C-1의 응답 계약 소비.

## 10. 범위 밖 · 후속 (별도 spec/slice)

- **응답 기반 extract authoring / 수동 변수 오버라이드** — §8-1, §8-2. 본 slice는 trace 데이터 모델로 받칠 수 있게만 설계.
- **워커 경로 실행 옵션(B)** — §8-3. `runner` 필드 자리만 비워둠.
- **민감값 마스킹** — env·trace 값 평문(현 수준). roadmap B1.
- **test-run 결과 저장/히스토리** — ephemeral 결정(완전 폐기). 필요해지면 별도.
- **다중 VU / 부하성 test-run** — 그건 기존 부하 run의 영역(RunDialog). test-run은 1 VU·1회 디버그로 고정.

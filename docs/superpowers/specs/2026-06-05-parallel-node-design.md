# Parallel 노드 설계 (A2)

* Date: 2026-06-05
* Status: Draft (brainstorming 승인 완료, spec review 대기)
* 관련: ADR-0020(loop), ADR-0023(conditional), ADR-0016(VU 모델), ADR-0018(VU별 jar), ADR-0014(변수 표기)
* 로드맵: `docs/roadmap.md` §A2

## 1. 개요 · 목표

세 번째 control-flow 노드 `type: parallel` 을 추가한다. **한 VU가 한 iteration 안에서 여러 분기(branch)를 동시(concurrent) 실행**하고, 모두 끝나면(join) 다음 스텝으로 진행한다. loop(ADR-0020)/conditional(ADR-0023)이 깐 인프라(internally-tagged `Step` enum, 재귀 `execute_steps`, React Flow 컨테이너 노드, two-tier UI 게이트)를 재사용한다.

**왜**: 테스트 대상이 하이브리드 앱 + 웹뷰라, 브라우저가 페이지 로드 시 `/api/user`·`/api/feed`·`/api/notifications` 등을 **동시 fan-out** 하는 게 주력 부하다. 이걸 순차로 모델링하면 백엔드가 보는 동시성 버스트·커넥션 재사용·per-session 경합이 전부 틀어진다 — 그리고 **VU 수 증가로 대체 불가**(per-VU 병렬 ≠ 600 VU = 600 세션; 같은 세션/쿠키 jar·HTTP/2 커넥션을 공유하는 상관된 요청 묶음의 버스트가 필요). JMeter Parallel Controller / LoadRunner concurrent block의 관용구.

### 목표

- `type: parallel` 노드: 분기들을 동시 실행, **wait-all** join.
- 분기가 추출한 변수를 join 후 다운스트림에서 쓸 수 있게 한다(**merge-back**), 중복 변수명은 **분기 이름 네임스페이스**(`{{branch.var}}`)로 자동 분리.
- 캔버스 **세로 레인**(side-by-side) authoring + YAML 양방향 sync.
- 핵심 불변식: **엔진 부하경로(flat http) byte-identical**(parallel arm만 비용), **컨트롤러·proto·워커·마이그레이션 무변경**.

### 비목표 (이 슬라이스 밖, 명시적 연기)

- **그룹/페이지 레이턴시**(동시 호출의 max = 웹뷰 페이지 로드 KPI): 새 메트릭 파이프라인이 필요 → 별도 후속 슬라이스(로드맵 도출 순서 2단계). 이번엔 per-step 메트릭만.
- **중첩**(parallel↔loop/if 상호 1레벨): conditional의 9c처럼 별도 sub-slice. 이번 분기 본문은 http-only, parallel은 top-level only.
- **분기별 메트릭 breakdown**(per-branch 카운터/레이턴시): counts-only 카운터조차 이번엔 없음. 기존 per-step `step_id` 집계로 충분(각 분기 http leaf가 자기 행).
- **first-fail / race join**: wait-all만.
- **에러 시 분기 취소·타임아웃 정책의 노드 레벨 오버라이드**: per-step `timeout_seconds`(S-A) 재사용으로 충분.

## 2. 시나리오 모델

### 2.1 YAML 형태

```yaml
version: 1
name: webview-page-load
steps:
  - id: "01HX0000000000000000000001"
    name: login
    type: http
    request: { method: POST, url: "{{base_url}}/login" }
    extract:
      - { var: token, from: body, path: "$.token" }

  - id: "01HX0000000000000000000002"
    name: page-fanout
    type: parallel
    branches:
      - name: user
        steps:
          - id: "01HX0000000000000000000003"
            name: get-user
            type: http
            request: { method: GET, url: "{{base_url}}/api/user" }
            extract:
              - { var: id, from: body, path: "$.id" }
      - name: feed
        steps:
          - id: "01HX0000000000000000000004"
            name: get-feed
            type: http
            request: { method: GET, url: "{{base_url}}/api/feed" }
            extract:
              - { var: id, from: body, path: "$.feed_id" }

  - id: "01HX0000000000000000000005"
    name: combine
    type: http
    request:
      method: POST
      url: "{{base_url}}/combine"
      body:
        json: { user_id: "{{user.id}}", feed_id: "{{feed.id}}" }
```

두 분기 모두 `id` 를 extract 하지만, 다운스트림에서는 `{{user.id}}` / `{{feed.id}}` 로 갈린다 (§4).

### 2.2 엔진 타입 (`crates/engine/src/scenario.rs`)

```rust
pub enum Step {
    Http(HttpStep),
    Loop(LoopStep),
    If(IfStep),
    Parallel(ParallelStep),   // 신규
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ParallelStep {
    pub id: String,
    pub name: String,
    pub branches: Vec<Branch>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Branch {
    pub name: String,
    pub steps: Vec<Step>,
}
```

- `LoopStep`/`IfStep` 과 같은 **struct variant** → serde **derive 로 round-trip OK**. `Condition`/`Body`/`Assertion` 류의 map-shape 수동 serde **불필요**(키가 고정 필드라 `!variant` 태그 함정 없음). 새 enum이 아니라 새 struct variant이므로 engine CLAUDE.md의 "새 enum마다 수동 serde 확인" 함정에 해당 안 됨 — 단, round-trip 테스트로 명시 검증.
- 내부 태그 `#[serde(tag="type")]` 는 `deny_unknown_fields` 를 강제 안 하므로 `ParallelStep` 에 개별 `#[serde(deny_unknown_fields)]`(loop/if 패턴). `Branch` 는 `id` 없음(`ElifBranch` 처럼 — 메트릭 타깃이 아니라 그룹 라벨). 내부 http step 들은 각자 `id` 보유.
- 엔진 타입은 `Vec<Step>` 자유재귀 허용(중첩은 엔진이 막지 않음); **단일레벨(분기 http-only) 강제는 UI Zod**(loop/if와 동일한 "엔진 느슨 / UI strict" 분업).
- `Step::id()`/`Step::name()` match 에 `Parallel` arm 추가.

### 2.3 branch `name` 규칙

- **필수**(빈 문자열 불가 — UI Zod). 용도 3가지: ① 변수 네임스페이스 키(`{{name.var}}`), ② 캔버스 레인 라벨, ③ 향후 per-branch 메트릭 키.
- **노드 내 유니크**(UI Zod `superRefine`). 유니크라 네임스페이스가 분기 간 충돌 0 → merge 순서 무관(§4).
- 엔진은 name 유효성을 검증 안 함(lenient passthrough). 중복/빈 이름이 와도 죽지 않음 — 단지 네임스페이스가 겹치면 마지막 분기 delta가 이김(authoring 단계에서 UI가 막음).

## 3. 엔진 실행 (`runner.rs::execute_steps` 의 `Step::Parallel` arm)

### 3.1 동시성 프리미티브

`futures::future::join_all` 로 분기 future 들을 **한 VU 태스크 위에서 협력적 동시 실행**한다.

- `tokio::spawn` **안 씀**: spawn 은 `'static` + 모든 차용을 `Arc` 클론으로 요구. `join_all` 은 `&VuClient`·`&Arc<Mutex<Aggregator>>`·`&env`·`&CancellationToken` 을 그대로 공유 차용(여러 불변 차용)하므로 현 시그니처와 자연스럽게 맞물린다.
- **동시성 = 겹치는 in-flight**: 각 분기의 reqwest 호출이 `.await` 에서 양보하므로 여러 요청이 **동시에 in-flight** 된다(웹뷰 fan-out의 본질). OS 스레드 병렬이 아니라 I/O 동시성으로 충분 — 커넥션 풀이 N 동시 요청을 본다.
- **쿠키 jar 공유**: 분기들이 같은 `VuClient`(= 단일 cookie jar, ADR-0018)를 공유 → 동시 분기가 같은 세션을 공유(웹뷰와 1:1). reqwest jar 는 내부 `RwLock` 이라 동시 Set-Cookie 안전(같은 쿠키는 last-writer-wins, 현실적).
- **핫패스 보존**: flat http/loop/if 경로는 무영향. `Parallel` arm 만 `join_all` + 분기당 `iter_vars` clone 비용(노드 실행당 1회, HTTP round-trip 대비 무시 가능 — loop `Box::pin`·9d와 동일 결론). parallel 노드가 없는 시나리오는 **byte-identical**.
- 재귀: 분기 future 안에서 `execute_steps` 를 호출하므로 `Box::pin` 필요(loop/if arm과 동형 — 무한크기 future 회피).

### 3.2 변수 모델 — 스냅샷 + 네임스페이스 merge-back

현재 인터프리터는 iteration 내내 `iter_vars: &mut BTreeMap` 하나를 모든 스텝에 흘린다. 동시 분기는 이걸 `&mut` 로 공유 못 한다.

1. **진입 스냅샷**: arm 진입 시 `entry = iter_vars.clone()`.
2. **분기별 복제 실행**: 각 분기는 `let mut branch_vars = entry.clone()` 로 자기 복제본에서 `execute_steps` 실행(분기 내 extract 는 그 분기 복제본에만 쌓임, 분기 내 후속 스텝에 보임).
3. **wait-all join**: `join_all` 로 모든 분기 완료 대기, 각 분기의 최종 `branch_vars` + `StepFlow`/`Result` 수집.
4. **네임스페이스 delta merge**: 각 분기 `b` 에 대해, `branch_vars` 중 **진입 스냅샷 대비 신규/변경 키**(`entry.get(k) != Some(v)`)만 골라 `iter_vars.insert(format!("{branch_name}.{k}"), v)`. 즉 분기 **출력(extract)** 만 `{{branch.key}}` 로 노출.
   - parent 기존 키(`token` 등)는 **불변**: 분기가 `token` 을 덮어써도 `branch.token` 으로만 노출되고 parent `token` 은 원값 유지(놀람 없는 clobber 방지).
   - 분기 이름 유니크 → 네임스페이스 prefix 가 분기마다 달라 **merge 순서 무관**(결정적). 동시 실행이지만 결과는 완료 순서와 독립.

이 모델은 brainstorming "Model 1"(자동 네임스페이스). 중복 변수명이 분기마다 있어도 작성자가 리네임할 필요 없음.

### 3.3 join 의미 · 에러 전파 (lenient, 엔진 일관)

- **wait-all**: 한 분기가 일찍/늦게 끝나도 전부 기다린다.
- **HTTP 요청 실패**(connection refused/5xx/timeout 등)는 **에러 메트릭으로 기록되고 VU/노드를 안 죽인다** — 기존 `execute_step` 동작(`outcome.error` 기록, `Ok` 반환) 그대로. 실패해도 부하는 계속 걸려야 측정이 맞다.
- **진짜 엔진 에러**(template `UnknownVar`/`CastFailed`/header build = `Result::Err`): wait-all join **후** 수집한 결과에서 **첫 `Err` 를 전파** → iteration 실패(기존 동작과 일관 — flat 경로에서 template 에러가 VU 를 죽이는 것과 동일). 모든 형제를 기다린 뒤 전파하므로 wait-all 위배 없음.
- **cancel/deadline**: 분기 내부 `execute_steps` for-루프 머리가 이미 검사 → `StepFlow::Aborted`/`DeadlineReached` 반환. arm 은 수집한 `StepFlow` 중 `Aborted` 우선, 다음 `DeadlineReached`, 아니면 `Continue` 로 합성해 반환(우선순위: `Err` > `Aborted` > `DeadlineReached` > `Continue`).

### 3.4 think_time 상호작용

분기 안 per-step `think_time`(S-B)은 분기별 시드 rng 가 필요(동시 분기가 `run_vu` 의 단일 `&mut think_rng` 를 공유 못 함). 각 분기는 `StdRng::seed_from_u64(dataset::mix(think_seed, vu_id, iter_id ^ branch_idx))` 류로 독립 rng 를 만든다(시드 없으면 `from_entropy`). run-level think time 은 iteration 사이라 parallel 과 무관.

### 3.5 data-binding 상호작용

iteration 시작 시 dataset row 가 `iter_vars` 에 주입된 상태로 arm 에 진입 → 진입 스냅샷에 포함 → 각 분기가 읽음(자동). 특별 처리 없음.

### 3.6 closed/open-loop 양쪽 자동 지원

closed-loop(`run_vu`)·open-loop(`run_arrival`) 둘 다 `execute_steps` 를 거치므로 `Parallel` arm 하나로 양쪽 커버. open-loop 슬롯/스케줄러 무변경.

### 3.7 trace lockstep (`trace.rs::trace_steps`)

engine CLAUDE.md 함정: `execute_steps` 에 새 Step 종류를 더하면 `trace_steps` 도 lockstep 갱신. test-run trace 는 1-VU 단일패스라 **동시성 무의미** → 분기를 **순차** 실행(선언 순서)하되 동일 **네임스페이스 delta merge** 를 적용(다운스트림 trace 행이 `{{branch.var}}` 를 resolve 하도록). 각 분기 http 의 trace 행에 branch 라벨 부착(loop 의 `loop_index` 라벨과 유사한 위치). parallel 노드 자체는 별도 결정 행 없음(if 의 결정 행과 달리 분기 선택이 아니라 전부 실행).

## 4. 변수 네임스페이스 상세

- **구분자 = `.`**: `{{user.id}}`. 템플릿 파서(`template.rs`)는 `{{ }}` 사이 substring 을 `.trim()` 후 **flat 키로 그대로 lookup**(`ctx.vars.get(name)`) → `"user.id"` 키는 파서 무변경으로 동작(점은 키 문자일 뿐). 언더스코어(`user_id`)는 작성자가 flat 으로 쓰는 변수명과 충돌하므로 점을 택함.
- **UI 함정(스펙에 명시)**: 변수 스캔(`scanFlowVars`, 데이터바인딩 패널 + 미바인딩 표시)·`resolveForDisplay` 가 **점 포함 토큰**을 인식해야 한다 — 기존 `{{(\w+)}}` 스캔 정규식은 `.` 를 안 잡으므로 토큰 문자 클래스를 `[\w.]+`(또는 동등)로 확장. 엔진 `render_inner` 는 이미 임의 substring 을 키로 쓰므로 무변경.
- **inside-branch 는 flat**: 분기 내부 스텝은 자기 복제본의 flat 키(`{{id}}`)를 본다. 네임스페이스는 **노드 경계 밖**(join 후)에만 적용. 스코프 규칙: "분기 안에선 flat, 노드 다음부터 `branch.` prefix".

## 5. UI authoring (`ui/`)

### 5.1 Zod 모델 (`ui/src/scenario/model.ts`)

- `BranchModel = { name: string(min 1), steps: HttpStepModel[] }` (분기 http-only — 중첩 deferred).
- `ParallelStepModel = { id, name, type:"parallel", branches: BranchModel[] }`, branches `.min(1)`(시드는 2), 분기 `name` **노드 내 유니크**를 `superRefine`.
- `StepModel` 을 http|loop|if|**parallel** 4-way `discriminatedUnion("type")` 로 확장.
- 중첩 deferred 이므로 9c two-tier(`Nested*`)는 parallel 에 **불필요** — 분기 본문이 http-only라 자기참조 없음. (중첩 후속 슬라이스에서 parallel 을 two-tier 에 편입.)

### 5.2 캔버스 — 세로 레인 (side-by-side)

- 신규 `ParallelStepNode.tsx`: 헤더(`⇉ parallel · wait-all`) + N개 레인(열). 각 레인 = 분기 `name` 라벨 + 그 분기 http 스텝 세로 스택.
- 에미터: 기존 `measureStep`/`emitStep`(세로 적층) 과 **별도 가로 배치 경로** — 레인 폭 합 = 컨테이너 폭, 컨테이너 높이 = max(레인 높이). 각 레인 내부는 기존 세로 스택 재사용.
- 툴바 "+ Add parallel"(2 분기 + 분기당 http 1개 시드).

### 5.3 Inspector

- parallel 노드 선택 시: 분기 추가/삭제, 분기 `name` 편집(유니크 경고), 분기별 "+ Add step".
- `flattenHttpSteps`·`findStepSiblings`·`findStepById` 재귀를 `branches[].steps` 까지 하강(9c 가 loop/if 분기 하강을 이미 완전재귀로 했으므로 parallel 케이스 추가).

### 5.4 양방향 sync (`yamlDoc.ts`)

- `findStepPath` 가 `branches[].steps` 하강(do/then/else/elif[].then 에 branches 추가).
- `normalizeStep(parallel)`.
- Edit 변형 + store thin action: `addParallelStep`, `addBranch`, `removeBranch`, `addStepInBranch`, `setBranchName`.

## 6. 메트릭

**신규 파이프라인 없음.** 각 분기 http leaf 는 자기 `step_id` 로 기존 per-second 윈도 집계(`Aggregator::record`)에 기록 — 동시 기록은 공유 `Aggregator` Mutex 가 직렬화(안전, 짧은 임계구역). 리포트는 기존 `report.steps` 에 분기 http 가 그대로 행으로(라벨링은 UI). parallel 노드 자체엔 카운터 없음. 그룹 레이턴시(max)는 후속.

## 7. 슬라이스 분할

conditional 9a→9b 와 동형으로 **2 sub-slice**:

### P-a — 엔진 (model + arm + trace)
`Step::Parallel`/`ParallelStep`/`Branch` 타입 + serde round-trip + `Step::id/name` arm + `execute_steps` Parallel arm(join_all + 스냅샷/네임스페이스 merge + 에러 전파 + think rng) + `trace_steps` lockstep arm + 엔진 단위/통합 테스트. **컨트롤러·proto·워커·UI 무변경.** 부하경로 byte-identical 검증.

### P-b — UI authoring
Zod 4-way + `ParallelStepNode` 세로 레인 캔버스 + inspector 분기 CRUD + yamlDoc 양방향 sync + 점-토큰 스캔 확장 + UI 테스트 + 머지 전 라이브 run 1회.

## 8. 테스트 전략

**엔진(P-a):**
- `parallel_round_trips`(serde derive round-trip, 내부 http `type:` 태그 보존).
- 동시 실행: wiremock 에 분기별 지연 stub → 두 분기가 **동시 in-flight**(총 소요 ≈ max(분기), sum 아님)임을 시간으로 단언.
- 네임스페이스 merge: 두 분기가 같은 `id` extract → 다운스트림 스텝이 `{{b1.id}}`/`{{b2.id}}` 를 각각 다른 값으로 받음(echo 타깃으로 와이어 검증).
- 에러 lenient: 한 분기 connection refused → 형제 분기 완주 + VU 생존(`AllVusFailed` 미트리거), 에러 메트릭 기록.
- 진짜 엔진 에러 전파: 한 분기에 미바인딩 `{{x}}`(strict) → iteration `Err`(형제 대기 후).
- trace lockstep: `trace_scenario` 가 parallel 분기 http 행 + 네임스페이스 resolve.
- byte-identical: parallel 없는 기존 시나리오 출력 불변(회귀 가드).

**UI(P-b):** Zod 4-way round-trip(fast-check), 캔버스 레인 렌더(RTL), inspector 분기 CRUD + 유니크 경고, yamlDoc 양방향 sync, 점-토큰 스캔. 머지 전 controller+worker 라이브 run 1회(ProfileSchema 류 `null` 갭 차단 — S-D 교훈).

## 9. 게이트 / 와이어 1:1

- 엔진: `cargo fmt --check` + `cargo clippy -D warnings` + `cargo test --workspace`.
- UI: `pnpm lint && pnpm test && pnpm build`(`tsc -b`).
- 와이어 1:1: UI `ParallelStepModel`/`BranchModel` ↔ 엔진 `ParallelStep`/`Branch` 필드·중첩 구조 1:1(field명·`branches`·`name`·http-only 분기). handicap-reviewer 로 최종 대조.

## 10. 명시적 연기 (out of scope, 후속 슬라이스)

- 그룹/페이지 레이턴시(동시 호출 max) — 새 메트릭 파이프라인, 로드맵 도출 (2)단계.
- 중첩(parallel↔loop/if 상호 1레벨) — 9c식 별도 sub-slice(분기 본문 컨테이너 + parallel-in-loop/if).
- 분기별 메트릭 breakdown(per-branch 카운터/레이턴시).
- first-fail/race join, 노드 레벨 동시성 cap(분기는 정적 authored 라 N 유한 — cap 불필요), 분기 timeout 오버라이드(per-step `timeout_seconds` 재사용).

## 11. ADR

**ADR-0033 — Parallel 노드**: wait-all join + 분기 네임스페이스 merge-back(`{{branch.var}}`, delta-only) + top-level-only v1(중첩 deferred) + `join_all` 협력 동시성(공유 jar/client) + 메트릭 per-step 재사용(그룹 레이턴시 deferred) + 엔진/UI-only(컨트롤러·proto·워커·마이그레이션 무변경). CLAUDE.md "알아둘 결정들" + 로드맵 §A2 갱신.

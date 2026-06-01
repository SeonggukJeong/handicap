# ADR-0026 — 시나리오 에디터 test-run: 컨트롤러 in-process 단일패스 trace (ephemeral)

* Status: Accepted
* Date: 2026-06-01
* Deciders: handicap maintainers
* Tags: test-run, trace, engine, controller, scenario-editor, debug-probe

## Context

QA·개발자가 에디터에서 시나리오를 편집하는 동안, **부하 run을 띄우지 않고** "이 시나리오가
지금 어떻게 동작하나"를 한 번 돌려 보고 싶다. 부하 run(`POST /api/runs`)은 워커 디스패치 +
다중 VU + ramp + 1초 윈도우 집계라 무겁고, 결과가 **집계 메트릭**이라 "3번 스텝이 왜 404인가"
같은 **요청별 디버그**에 안 맞는다. 에디터에 경량 "test-run(스모크)" probe가 필요하다.

설계 명세: `docs/superpowers/specs/2026-06-01-scenario-editor-test-run-design.md`(roadmap 영역 C, spec §7 실현).
구현 계획(C-1 백엔드): `docs/superpowers/plans/2026-06-01-scenario-editor-test-run-c1-backend.md`.
영역 B(환경, ADR-0025)가 깐 클라이언트 오버레이 이음새(`resolveEnv`/`<EnvironmentPicker>`)를 재사용한다.

## Decision Drivers

- 결과 = **요청별 trace**(해석된 요청·원응답·추출 변수·미바인딩 경고·분기 결정), 집계 아님.
- 대상 = 현재 에디터 버퍼(미저장 inline YAML). 저장 강제 없음.
- 빠르고 가벼움: 1 VU, 시나리오 1회 통과, ramp/멀티VU/워커 없음.
- 부하 run 경로(`run_scenario`/`execute_steps`)를 **회귀 없이** 보존.
- ephemeral: DB·마이그레이션 0, 워커·proto 무변경.

## Considered Options

1. **컨트롤러 in-process 엔진 호출 + 신규 단일패스 trace 인터프리터** (채택)
   — `POST /api/test-runs`가 YAML 파싱 → 엔진 `trace_scenario`를 동기 호출 → `ScenarioTrace`
   JSON 반환. 워커·DB 안 거침. 부하 인터프리터를 미러하되 load machinery(Aggregator·deadline
   윈도우·CancellationToken) 제거.

2. **부하 run을 VUs=1·duration=짧게로 재사용**
   — 집계 메트릭만 나와 요청별 디버그 불가. 워커 디스패치·1초 윈도우 오버헤드. run 레코드 DB
   오염. 거절.

3. **워커 경로로 test-run 디스패치(B)**
   — 컨트롤러 in-process보다 멀티워커·격리에 유리하나 C-1엔 과함. `runner` 필드 자리만
   예약(후속). 거절(연기).

## Decision

**컨트롤러 in-process 단일패스 trace. ephemeral. 신규 엔진 `trace_scenario`.**

### API

- top-level `POST /api/test-runs`(`/scenarios/{id}` 충돌 회피). `State`/DB 안 받는 stateless 핸들러.
- 요청: `{ scenario_yaml, env?, max_requests?, runner? }`. `runner`는 워커 경로(B) 예약 — v1 무시.
- 응답 200: `ScenarioTrace`(아래). 의미 검증 실패 422.
- 상한: `max_requests`(기본 50, 1~10000 — 벗어나면 422) + wall-clock 천장 120s. 둘 중 먼저
  닿으면 `truncated = true` + 부분 trace. **요청 카운터는 http leaf에서만 증가**(if/loop 구조 행은 미카운트).

### `ScenarioTrace` 데이터 모델 (UI JSON 계약)

- `ScenarioTrace { ok, total_ms, steps: Vec<StepTrace>, final_vars, truncated, error }`.
- `StepTrace { step_id, kind: StepKind(Http|If), loop_index, branch, request, response, extracted, unbound_vars, error }`.
- `StepKind`는 데이터 없는 enum → `rename_all="lowercase"` derive(`"http"`/`"if"`). `TraceOptions`/
  `HttpTrace`는 내부 중간 타입이라 **비-serde**(Serialize/Deserialize 없음).
- **loop 노드는 자체 행을 안 만든다** — 자식(http/if)이 `loop_index`를 달고 행이 된다.
- **if 노드는 결정 행 1개**(`kind: If`, `branch`, request/response 없음) + 분기 자식 행들.

### 상태코드: 신규 `ApiError::Unprocessable`(422)

- 의미 검증(YAML 파싱 실패·`max_requests` 범위)에 422. axum `Json` 추출기가 이 엔드포인트에
  이미 422(필드 타입 오류)를 내므로 핸들러도 422로 맞춰 **엔드포인트 내부 일관**.
- **레거시 엔드포인트(runs/presets/environments/datasets)는 400(`BadRequest`) 유지** — 의도된 분기.
- `from_yaml` 에러는 `?`(→`ApiError::Scenario`→400)에 기대지 말고 명시 `map_err`로 422 매핑.

### lenient 렌더 + 미바인딩 수집(`render_collecting`)

- trace는 디버그라 **lenient 렌더**(미해결 토큰 → 빈 문자열, 절대 `Err` 안 냄)를 쓴다. 단 기존
  `render_lenient`는 미해결 토큰 목록을 버린다 → `template.rs`에 **신규 `render_collecting`**
  (lenient + 미해결 토큰명 수집) 추가. hot-path `render`/`render_lenient`는 시그니처 불변(컬렉터
  `&mut None` no-op).
- `unbound_vars`는 **url·헤더·body 렌더**에서 빈 값으로 떨어진 토큰을 보고(스텝별 order-preserving
  dedup).

### 부하 경로 보존

- `execute_step`(hot)은 byte-identical. trace는 **별도** `execute_step_traced`(lenient+수집,
  요청/응답 캡처, body 16 KiB 절단). 의도된 중복(strict-Result vs collecting-String 렌더 차이).
- if 분기 선택+라벨은 `runner::select_branch`(`pub(crate)`)로 **추출해 부하/trace가 공유** —
  분기 라벨(`then`/`elif_{j}`/`else`/`none`) single source of truth(9d와 일치).

### 조건 미바인딩 표시 (C-1 follow-up 확장)

- 명세 §3-2는 `unbound_vars`를 **요청 렌더**(url/headers/body)로 한정했으나, `if`/`elif`
  **조건 안에서만** 참조된 미바인딩 변수는 lenient 평가가 조용히 빈 문자열로 떨궈 분기를
  뒤집는데도 trace에 아무 표시가 없었다. → trace-only 수집기 `collect_if_condition_unbound`
  추가: if 노드의 `cond` + 모든 `elif.cond`를 walk하며 `render_collecting`으로 미바인딩 토큰을
  결정 행 `unbound_vars`에 채운다. `condition::eval_compare`의 렌더 지점을 미러(left 항상,
  right는 exists/empty 외). **부하 평가기(`eval_condition`)는 무변경** — trace 한정 확장.

## Consequences

**Positive**
- 요청별 디버그 가능(해석된 요청·원응답·추출·분기·미바인딩·조건 미바인딩까지).
- 부하 경로 0 회귀(`execute_step` byte-identical, `select_branch`는 behavior-preserving 추출).
- ephemeral이라 DB·워커·proto·마이그레이션 무변경.
- 클라 오버레이 이음새(ADR-0025) 재사용 — C-2 UI가 `<EnvironmentPicker>`/`resolveEnv` 그대로 사용.

**Negative / Trade-offs**
- trace 인터프리터가 `execute_steps`를 **두 번째로 구현** — 새 Step 종류/분기 라벨 추가 시
  `trace_steps`도 lockstep 갱신 필요(`select_branch` 공유로 라벨 drift는 막음).
- 컨트롤러 워커 스레드를 in-process로 최대 120s 점유(C-1 동기 설계의 의도된 한계).
- `execute_step_traced`가 `execute_step`의 의도된 중복 — 둘을 같이 유지해야 함.

## 명시적 연기 (Out of scope)

- **C-2 (UI)** — 에디터 Test-run 버튼 + `<EnvironmentPicker>` 재사용 + `TestRunPanel`(별도 plan).
- **워커 경로 runner(B)** — `runner` 필드 자리만 예약(spec §8-3).
- **응답에서 extract 변수 지정 authoring**(§8-1), **수동 변수 오버라이드**(§8-2).
- **데이터셋 바인딩** — dataset-소스 `{{var}}`는 미바인딩(빈 값)으로 두고 `unbound_vars`에 표시.
- **민감값 마스킹** — env·요청 값 평문 노출(기존 한계와 동일).

## Links

- ADR-0023 (conditional 노드) — `select_branch`/분기 라벨의 출처
- ADR-0024 (run 프리셋) / ADR-0025 (환경) — 클라 오버레이 이음새 재사용
- ADR-0013 (Scenario/RunConfig 분리) — 미저장 버퍼 inline 실행의 근거
- Spec `docs/superpowers/specs/2026-06-01-scenario-editor-test-run-design.md`
- Plan `docs/superpowers/plans/2026-06-01-scenario-editor-test-run-c1-backend.md`(C-1)

# 에디터 데이터셋 test-run — test-run에 서버측 데이터셋 바인딩(1행 선택 주입 + 순차 N행 검증) (§A12 도그푸딩 백로그)

- **날짜**: 2026-07-16
- **상태**: 설계 승인(사용자 2026-07-16) → spec-plan-reviewer 루프 대기
- **출처**: roadmap §A12 도그푸딩 백로그 "에디터 데이터셋 test-run"(마지막 잔여 항목). 데이터 기반 시나리오를 에디터에서 검증할 방법이 현재 전무 — 데이터셋 변수가 빈 문자열로 나가고 amber `unbound` 칩만 뜬다.
- **연관**: `2026-06-01-scenario-editor-test-run-design.md`(§6이 데이터셋을 v1 의도 제외·§8-2 var_overrides 후속안), ADR-0026(test-run in-process trace), ADR-0022(데이터셋 리소스·바인딩), `2026-07-16-dataset-preview-design.md`(rows API·`useDatasetRows`), `2026-06-15-multi-dataset-binding-design.md`(Vec 바인딩).
- **ADR**: **ADR-0047 신규** — test-run 데이터셋 주입을 서버측 바인딩(단일 요청·전역 상한·run 패리티)으로 결정, 클라 주도 N-요청(var_overrides 우회)은 기각. 초안 `docs/adr/0047-editor-test-run-dataset-binding.md` 동반.

---

## 1. 문제와 목표

시나리오가 데이터셋-소스 변수(`{{username}}` 등)를 참조하면 에디터 test-run은 그 변수를 빈 문자열로 렌더하고 `unbound_vars` 칩만 띄운다(바인딩이 run `Profile`에만 살아서 test-run 요청에 실릴 자리가 없음 — 기존 spec §6의 의도적 v1 제외). 그래서 데이터 기반 시나리오는 부하 run을 실제로 돌려보기 전엔 검증 불가다. 이 슬라이스는 test-run 요청에 optional 데이터셋 구성을 추가해 ① 특정 1행을 골라 단발 확인, ② 1 VU 순차로 전체/N행을 행별 ✓/✗ 검증을 가능하게 한다.

- **목표**: 위 두 모드를 실제 run과 같은 주입 세만틱(같은 행 → 같은 렌더 결과)으로 제공.
- **비목표(연기)**: §7 참조. 멀티 데이터셋 UI·var_overrides·정책 선택 UI·민감값 마스킹·프리셋 전환.

### 사용자 스토리 (US — 라이브 검증 체크리스트의 척추)

- **US1 특정 행 골라 단발 확인**: 시나리오 작성자(QA)로서, 데이터셋의 특정 행(예: 특이 케이스 계정인 17번 행)을 골라 그 값으로 test-run을 1회 돌려, 그 데이터로 시나리오 전체 흐름이 정상 동작하는지 즉시 확인하고 싶다.
- **US2 부하 전 데이터 품질 검증**: 부하 run 전에 데이터셋 전체(또는 앞 N행)를 1 VU로 행마다 1회씩 순차 실행해, 어떤 행이 시나리오를 깨뜨리는지 행별 ✓/✗로 확인하고 싶다. 실패 행이 있어도 끝까지 진행해 한 번에 전체 현황을 본다.
- **US3 설정 없는 빠른 시작**: 컬럼명=변수명이면 매핑 설정 없이 데이터셋만 고르고 바로 실행하고 싶다. 다르면 매핑 편집을 펼쳐 재지정한다.
- **US4 run과 일관된 세만틱**: test-run에서 검증한 구성이 실제 부하 run의 바인딩과 같은 주입 세만틱이길 기대한다 — test-run 통과 후 run에서 다르게 동작하면 신뢰가 깨진다.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST `dataset` 필드 없는 test-run 요청은 오늘과 거동·응답 byte-identical(기존 테스트 무수정 통과, `trace_scenario` 시그니처 무변경) | 기존 test_runs/trace 테스트 전부 무수정 green | |
| R2 | MUST `TestRunRequest`가 optional `dataset: TestRunDatasetConfig`(§4.2 형태 — `mode`, `bindings: Vec`, `start_row`, `row_limit`)를 수용하고 `Mapping` serde(`kind` 태그드 Column/Literal)를 그대로 재사용 | controller 단위: 신규 필드 역직렬화 + curl 왕복 | ✅ wire: UI Zod↔controller serde |
| R3 | MUST `mappings` **생략(None)**이면 서버가 모든 컬럼→동명 변수 자동 매핑을 **명시 Column 매핑으로 실체화**해 이후 검증·주입이 명시 매핑과 동일 경로를 타고, `mappings: []`(빈 배열 명시)는 422 — run 와이어의 "빈 매핑 = 주입 없음"(`runs.rs:443-446`)과 같은 모양이 다른 뜻이 되는 이중 계약 금지(자동은 run 와이어에 없는 test-run 전용 규약, §5 명문화) | controller 단위: 생략=자동 실체화/명시=대체/빈 배열=422 각 단언 | |
| R4 | MUST 주입 세만틱이 run을 미러(**parity 기준 = effective 매핑** — 자동은 R3 실체화 후 동일 경로): `iter_vars = scenario.variables + 행 매핑 결과`(충돌 시 데이터셋 우선), 행마다 iter_vars 리셋(추출 비누적), `vu_id=0`, `iter_id=반복 순번`(single_row=0, sequential=0..N-1 — `${iter_id}` 참조 시나리오는 실제 run의 iteration 번호와 다를 수 있음, §5 caveat) | engine 단위: 시드·리셋·iter_id 단언(run 쪽 `run_vu` 시드 순서와 대조 주석) | |
| R5 | MUST sequential 모드에서 cookie jar(VuClient)를 행 간 공유(클라이언트 1회 빌드 — 1 VU 순차 세만틱) | engine 단위: set-cookie 후 다음 행 요청에 쿠키 실림 단언 | |
| R6 | MUST `max_requests` 예산과 wall-clock 120s deadline을 모든 행에 걸쳐 단일 예산으로 공유 — 소진 시 그 지점에서 중단, 미실행 행은 응답 `rows`에 없음(마지막 행은 mid-cut 가능 → 그 행의 `trace.truncated=true`); **top-level `truncated` 단일 정의(이 절이 유일 소유)**: `truncated = (완료 반복 수 < 사용자 요청 구간(row_limit ?? 첫 바인딩 잔여)) ‖ 마지막 실행 행 mid-cut` — R18 clamp로 요청 구간이 축소된 경우 all-green이어도 true(→ R8 `ok=false`: "요청한 검증을 다 못 돌았다"가 의도), 요청 구간을 전부 완료했으면 마지막 행 종료와 동시에 예산이 정확 소진돼도 false | engine 단위: 예산 소진 케이스(행 경계·행 중간·정확 소진·clamp all-green) 단언 | |
| R7 | MUST `single_row` 응답은 기존 `ScenarioTrace` 형태 그대로(신규 필드 0 — **렌더러**(`TestRunPanel`/`TestFlowChips`) 무변경, 주입 값은 `final_vars`로 관찰 가능; `TestRunSection`의 응답 분기 배선은 R16 소관) | curl: 응답이 기존 `ScenarioTraceSchema`를 통과 | ✅ wire: 기존 응답 보존 |
| R8 | MUST `sequential` 응답은 `{ok, truncated, total_ms, rows: [{row_index, trace: ScenarioTrace}]}` — `ok = !truncated && 모든 rows[].trace.ok` | controller/engine 단위 + curl 왕복 | ✅ wire: UI Zod↔serde 신규 |
| R9 | MUST 검증 실패는 422 한국어 메시지: ① dataset_id 미존재 ② 명시 매핑의 컬럼 미존재 ③ `row_index` ≥ 해당 바인딩 row_count / `start_row` ≥ 첫 바인딩 row_count(R17 앵커 기준) ④ `row_limit < 1` ⑤ 바인딩 간 변수명 중복 — **자동 실체화(R3) 후 effective 매핑 기준**(auto-auto 충돌 포함; `collect_var_names`는 `&[&DataBinding]`(policy 필수)라 직접 재사용 불가 — 동등 로직을 effective `Vec<Mapping>` 위에, 형태는 plan 확정) ⑥ `bindings` 빈 배열 ⑦ `mappings: []` 빈 배열 명시(R3) ⑧ `bindings.len() >` run 생성 가드와 동일한 `settings.max_data_bindings()` 상한 ⑨ 모드-비관련 파라미터 지정(`single_row`의 `start_row`/`row_limit`, `sequential`의 `row_index`) ⑩ `single_row`인데 `row_index` 누락 | controller 단위 10케이스 + curl 대표 케이스 | |
| R10 | MUST sequential은 실패 행에서도 끝까지 진행(fail-fast 없음 — 중단 조건은 R6 상한뿐) | engine 단위: 실패 행 뒤 행도 실행됨 단언 | |
| R11 | MUST TestRunSection에 접이식 "데이터셋" 섹션(기본 접힘, 구성된 채 접히면 요약 힌트 — 기존 optional 섹션 이디엄): 데이터셋 Select·모드 라디오(특정 행/순차 검증)·행 선택·순차 파라미터(시작 행·행 수, 비움=전체)·매핑 요약+펼침 편집(Column만; 편집 행 전부 삭제 시 생략(None)으로 정규화 — 빈 배열 직렬화 금지, R3) | RTL: 섹션 렌더·구성→요청 페이로드 매핑 단언(빈 편집=필드 생략 포함) | |
| R12 | MUST 행 선택은 `DatasetRowsPreview`에 optional 선택 prop(예: `onSelectRow`)을 additive로 추가해 재사용 — DatasetsPage(미전달) 렌더·거동 무변경 | RTL: prop 미전달 시 기존 스냅샷/거동 동일 | |
| R13 | MUST 순차 결과 UI는 행 목록(행 번호·✓/✗·소요 ms) + 행 펼침 시 기존 `TestRunPanel` 스텝 렌더 재사용, 기본 펼침 = 첫 실패 행(없으면 첫 행), truncated면 "상한 도달로 N행 중 M행만 실행" 경고 | RTL: 목록·기본 펼침·경고 단언 | |
| R14 | SHOULD `TestFlowChips`는 순차 결과에서 현재 펼친 행의 trace를 미러 | RTL: 펼침 전환 시 칩 결과 변경 단언 | |
| R15 | SHOULD 순차 모드에서 예상 요청 수(행 수 × 정적 http leaf 수 — loop 반복 미반영 근사) > `max_requests`면 비차단 경고 힌트 | RTL: 힌트 표시 조건 단언 | |
| R16 | MUST UI Zod가 와이어와 1:1: 요청 `TestRunDatasetConfig` 직렬화 + 응답 `SequentialTrace` 파싱(서버 `Option`→`.nullable()` 함정 준수) | vitest 스키마 왕복 + 라이브 curl 응답 파싱 | ✅ wire: UI Zod↔serde |
| R17 | MUST 멀티 바인딩 세만틱(와이어 계층): 반복 i(0-based)에서 **첫 바인딩 행 = `start_row + i`(wrap 없음 — R18 clamp가 보장)**, 비-첫 바인딩 행 = `(start_row + i) % len_k`(run `iter_sequential`의 wrap 미러); single_row는 바인딩별 `row_index`. **응답·UI의 `row_index` = `start_row + i`**(첫 바인딩 행 번호 = 반복 앵커 — R8/R13의 행 번호 의미, wrap 없어 항상 유일) | engine/controller 단위: 2-바인딩(길이 상이) 케이스 단언(UI 노출은 §7 연기) | |
| R18 | MUST 서버가 sequential 반복 수를 `N = min(row_limit ?? (첫 바인딩 row_count − start_row), 첫 바인딩 row_count − start_row, max_requests)`로 clamp하고, 행 로드는 바인딩별 ≤ `min(len_k, N)`행(연속 range fetch 1–2회 — 전체 데이터셋 선로드 금지); clamp·예산으로 사용자 요청 구간을 못 돌면 truncated(정의는 **R6이 유일 소유**); 0-http-leaf 시나리오도 이 clamp로 행 수·응답 크기 유계 | controller/engine 단위: 1M-행 메타 가정 clamp·0-leaf 시나리오 유계 단언 | |

---

## 3. 핵심 통찰 (설계 근거)

1. **서버측 바인딩 채택, 클라 주도 기각(ADR-0047)**: 대안(기존 spec §8-2 `var_overrides`만 추가하고 UI가 rows API로 행을 가져와 N번 호출)은 백엔드가 수 줄이지만, N행이 N개 독립 요청이 되어 전역 상한이 없고(R6 불가 — 요청마다 wall-clock 120s씩), 매핑 적용이 TS에 중복돼 R4/US4 패리티가 약해진다. 서버측은 단일 요청·전역 예산·`apply_mappings`(이미 `pub`, `binding.rs`) 재사용으로 셋 다 구조적으로 보장.
2. **cookie jar 공유(R5)는 "1 VU 순차"의 정직한 미러**: 실제 run에서 1 VU가 iter_sequential로 돌면 jar가 iteration 간 유지된다(ADR-0018 per-VU jar). 행 간 세션 누적(예: 앞 행 로그인 쿠키)이 다음 행에 영향을 주는 것도 실 run과 동일하게 *보여야* 검증 도구로서 맞다. `trace_scenario`가 클라이언트를 호출마다 빌드하므로(`trace.rs:118`) 컨트롤러 루프가 아니라 **엔진 내 래퍼**(클라이언트 1회 빌드 + 행 루프)로 구현해야 R5·R6이 자연스럽다.
3. **single_row 응답을 기존 `ScenarioTrace`로 유지(R7)**: UI의 성숙한 렌더 경로(`TestRunPanel`·`TestFlowChips`)를 무변경 재사용하고 와이어 드리프트 면적을 sequential 신규 형태 하나로 제한한다. sequential의 행별 trace도 `ScenarioTrace`를 그대로 중첩(R8)해 스텝 렌더를 행 펼침에 재사용(R13).
4. **자동 same-name 매핑은 서버 소유 + 명시 매핑으로 실체화(R3)**: 클라가 자동 매핑을 계산해 보내면 curl 사용자·후속 클라이언트마다 재구현·드리프트 위험. 서버가 소유하되 신호는 **생략(None)**만 쓴다 — run 와이어에선 빈 `mappings: []`가 "주입 없음"(`runs.rs:443-446` load-bearing 주석)이라, 같은 모양에 "전 컬럼 자동 주입"을 얹으면 이중 계약이 된다(리뷰 HIGH finding). 그래서 test-run은 빈 배열 명시를 422로 거부하고, 자동(None)은 검증 전에 명시 Column 매핑으로 실체화해 이후 중복 검사(R9-⑤)·주입(R4)이 명시 경로와 완전 동일하게 돈다.
5. **정책(per_vu/iter_random/unique) 선택은 제공하지 않는다**: 4정책은 멀티 VU/iteration 분산 개념이라 1 VU 단일 패스 trace에선 무의미하거나(per_vu) 오해 소지(unique 파티셔닝은 워커 개념 전제). 로드맵 원문의 "1행 선택/순차 진행"이 test-run에 유의미한 부분집합이고, sequential은 iter_sequential(1 VU·단일 워커)과 정확히 일치한다.

---

## 4. 변경 상세

### 4.1 `crates/engine/src/trace.rs` — 충족 R: R1, R4, R5, R6, R10
- `trace_scenario` 본문에서 "클라이언트로 1패스 트레이스" 내부를 헬퍼(가칭 `trace_once(client, scenario, opts, seed_vars, iter_id, deadline, budget)`)로 추출. `trace_scenario`는 그 헬퍼를 seed 없음·iter_id 0으로 1회 호출 — 시그니처·거동 무변경(R1).
- 신규 `pub async fn trace_scenario_rows(scenario, opts, seeded_rows: &[(u64 /*row_index*/, BTreeMap<String,String>)]) -> RowsTrace`: `VuClient` 1회 빌드(R5), 단일 deadline + 공유 요청 예산(R6)으로 행 루프, 행마다 `iter_vars = scenario.variables + seed`(R4), 실패해도 계속(R10). `RowsTrace { ok, truncated, total_ms, rows: Vec<RowTrace { row_index, trace: ScenarioTrace }> }`(R8의 엔진측 절반).
- 예산 배선: 기존 `TraceState.requests` 카운트를 행 간 이월(다음 행 시작 전 잔여 0이면 중단·top-level truncated — 경계는 R6). 상태 소유: `steps`·행별 truncated는 per-row, `requests` 카운터·deadline은 행 간 공유 — `TraceState` 분해 형태는 plan에서 확정.
- 행 사이 추가 간격 없음: inter-iteration think time은 `Profile.think_time` 소관(run-config)이고 test-run엔 Profile이 없다. 시나리오 `default_think_time`은 per-step 상속이라 행 사이 간격과 무관 — `apply_think_time`은 지금처럼 per-step만.

### 4.2 `crates/controller/src/api/test_runs.rs` — 충족 R: R2, R3, R7, R8, R9, R17
- `TestRunRequest`에 `#[serde(default)] dataset: Option<TestRunDatasetConfig>`:
  ```rust
  pub struct TestRunDatasetConfig {
      pub mode: TestRunDatasetMode,          // "single_row" | "sequential" (snake_case)
      pub bindings: Vec<TestRunBinding>,     // 비면 422 (R9-⑥), 상한 = max_data_bindings (R9-⑧)
      #[serde(default)] pub start_row: Option<u64>,  // sequential 전용 (None=0; single_row에서 지정 시 422 — R9-⑨)
      #[serde(default)] pub row_limit: Option<u64>,  // sequential 전용, None=전체 (R18 clamp)
  }
  pub struct TestRunBinding {
      pub dataset_id: String,
      #[serde(default)] pub mappings: Option<Vec<Mapping>>, // None=자동 실체화, Some([])=422 (R3)
      #[serde(default)] pub row_index: Option<u64>, // single_row 필수 (R9-⑨/⑩)
  }
  ```
- 핸들러 순서: 자동 매핑 실체화(R3) → 검증(R9 — 존재/컬럼/범위/개수 상한/effective 중복) → R18 clamp 산출 → 행 로드(바인딩별 연속 range fetch 1–2회: 첫 바인딩 no-wrap 1회, 비-첫 wrap 시 tail+head 2회 — R17/R18) → `apply_mappings` 적용(R4 패리티) → single_row는 시드 1행으로 trace 후 기존 `Json<ScenarioTrace>` 반환(R7), sequential은 `trace_scenario_rows` 호출 후 신규 응답(R8).
- 응답 타입: 기존 `ScenarioTrace` | 신규 `SequentialTrace`(RowsTrace 직렬화) — 핸들러 리턴을 둘 다 표현 가능한 형태로(axum `Response` 분기 또는 untagged enum; plan에서 확정).

### 4.3 `ui/src/api/schemas.ts` · `client.ts` · `hooks.ts` — 충족 R: R16
- 요청: `TestRunDatasetConfig`/`TestRunBinding` 타입(직렬화 방향이라 Zod 불필수 — 기존 `createTestRun` 페이로드 타입 확장). 응답: `SequentialTraceSchema = {ok, truncated, total_ms, rows: [{row_index, trace: ScenarioTraceSchema}]}` 신규. `useTestRun`은 모드에 따라 파싱 스키마 선택(또는 union). 서버 `Option` → `.nullable()`.

### 4.4 `ui/src/components/scenario/TestRunSection.tsx`(+신규 하위 컴포넌트) — 충족 R: R11, R15
- 접이식 "데이터셋" 섹션(기존 optional 섹션 이디엄 — 기본 접힘·구성 시 요약 힌트): `useDatasets` 목록 Select, 모드 라디오, single_row = 행 번호 입력 + `DatasetRowsPreview` 클릭 선택(R12), sequential = 시작 행·행 수(비움=전체) + 예상 요청 수 경고 힌트(R15), 매핑 = "자동(컬럼명=변수명)" 요약 + 펼치면 컬럼→변수 Column 매핑 에디터(Literal 편집은 §7 — 시나리오 `variables:`가 리터럴을 이미 커버).

### 4.5 `ui/src/components/datasets/DatasetRowsPreview.tsx` — 충족 R: R12
- optional `onSelectRow?: (rowIndex: number) => void` + `selectedRow?: number` prop — 전달 시 행 클릭 선택·하이라이트, 미전달 시 기존과 동일(DatasetsPage 무영향).

### 4.6 `ui/src/components/scenario/TestRunPanel.tsx`(또는 인접 신규) — 충족 R: R13, R14
- sequential 결과용 행 목록 래퍼: 행 헤더(번호·✓/✗·ms) + 펼침 시 기존 스텝 렌더 재사용, 기본 펼침 = 첫 실패 행(없으면 첫 행), truncated 경고. `TestFlowChips`에 펼친 행 trace 전달(R14).

---

## 5. 무변경 / 불변식 (명시)

- **proto·worker·migration·store 스키마 0-diff** — 데이터 흐름이 컨트롤러 in-process에서 끝난다(ADR-0026 유지). run 경로(`spawn_run`·`binding.rs`의 기존 함수 시그니처)도 무변경(`apply_mappings`는 재사용만; `collect_var_names`는 시그니처 무변경 — effective 중복 검사는 test-run 쪽 동등 로직, R9-⑤).
- **`dataset` 필드 없는 test-run은 byte-identical**(R1) — `trace_scenario` 시그니처·거동, 기존 응답 형태(R7), UI의 데이터셋 미구성 경로 모두 오늘과 동일.
- **`DatasetRowsPreview` 기존 사용처(DatasetsPage) 무변경**(R12).
- 데이터셋 리소스 API(`GET /rows` 등)·엔진 `dataset.rs` 정책 코드 무변경.
- **run 와이어의 빈-매핑 의미 불변**: run `DataBinding`의 `mappings: []` = "주입 없음"은 그대로다(`runs.rs:443-446`). 자동 same-name은 test-run 전용 규약(생략=None 신호)이며 run 와이어엔 존재하지 않는다 — 두 엔드포인트가 같은 모양에 다른 뜻을 갖지 않도록 test-run은 빈 배열 명시를 422로 거부(R3).
- **`${iter_id}` parity caveat**: single_row는 `iter_id=0`으로 렌더되므로 `${iter_id}`를 참조하는 시나리오는 실제 run의 해당 iteration 번호와 다르게 렌더될 수 있다(sequential도 반복 순번 기준). "같은 행 → 같은 렌더"(US4)는 `${iter_id}` 비참조 시나리오 기준.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1 | 기존 test_runs/trace 테스트 무수정 green + `dataset` 없는 curl 응답 오늘과 동형 | ✅ |
| R2, R7, R8, R16 | 계약-먼저: Rust serde 단위 ↔ UI Zod vitest 왕복 + 라이브 curl 응답을 UI 스키마로 파싱(1:1 대조) | ✅ |
| R3, R4, R5, R6, R10, R17, R18 | engine/controller 단위 테스트(시드·jar·예산·계속 진행·행 산식·clamp) | |
| R9 | controller 단위 10케이스 + 라이브 curl 대표 422 | ✅ |
| R11–R15 | RTL/vitest + 라이브 Playwright | ✅ |
| **US1–US4** | **도그푸딩 체크리스트(라이브 필수)**: 로깅 echo 서버(와이어 grep — 주입 행 값이 *실제 전송*됐는지 리포트가 아닌 와이어로 확인)로 ① US1: 17번 행 선택 → 요청 바디에 그 행 값 grep ② US2: 실패 행 섞인 데이터셋 순차 → 행별 ✓/✗·계속 진행·truncated 케이스 ③ US3: 매핑 무설정 자동 주입 + 명시 매핑 재지정 ④ US4: 같은 데이터셋·같은 행으로 실제 run(1 VU) 생성 → echo 서버 와이어와 test-run 와이어 동일값 대조 — **전제**: run 쪽엔 자동 실체화와 동일 집합의 **명시 매핑**을 지정(run 와이어에 자동 규약 없음 — R3/§5), US4 체크는 실제 run을 돌리므로 워크트리에서 `cargo build -p handicap-worker --bin worker` 선행 | ✅ |

- 라이브 검증은 `/live-verify` 스택(워크트리 자체 바이너리 + 격리 DB). **주의**: live-verify 번들 `responder.py`는 요청을 안 찍는다 — 로깅 변형 사용(루트 CLAUDE.md 함정).

---

## 7. 의도적 연기 (roadmap §B에 누적)

- **멀티 데이터셋 UI**: 와이어(R17)는 Vec로 freeze, UI는 1개만 노출. 멀티 노출은 후속 소형(계약 무변경).
- **`var_overrides`(기존 spec §8-2)**: 데이터셋 없이 임시값 주입 — 독립 가치가 있으나 이번 스토리에 불필요(스코프 크리프 방지). 기존 §8-2 기록 유지.
- **Literal 매핑 편집 UI**: 와이어는 합법(R2), UI 편집은 Column만 — 리터럴은 시나리오 `variables:` 섹션이 이미 커버.
- **민감값 마스킹**: 데이터셋 값(비밀번호 컬럼 포함)이 test-run trace의 요청/응답/`final_vars`에 평문 노출 — 기존 env와 동일한 기존 상태의 확장이며, 일관 마스킹은 §B1 보안 하드닝 트랙 소유(부분 fix 금지 — 사용자 기결정).
- **검증 구성 → run 프리셋 전환 / 실패 행만 필터 / fail-fast 토글**: US에 없음, 수요 확인 후.

---

## 8. 구현 순서 (plan 입력)

1. **계약-먼저**: 엔진 `trace_scenario_rows` + 헬퍼 추출(R1 보존 확인) → controller `TestRunDatasetConfig` serde·검증·핸들러 분기(R2–R10, R17) — cargo 게이트 green 단위로 fold.
2. UI Zod/클라이언트(R16) + TestRunSection 데이터셋 섹션·행 선택 prop(R11, R12, R15).
3. 순차 결과 렌더(R13, R14).
4. 라이브 검증(§6 도그푸딩 체크리스트) → finish-slice(보안 게이트 §0: env/데이터셋 바인딩 + trace/body 뷰어 diff → `security-reviewer` 필수 예상).

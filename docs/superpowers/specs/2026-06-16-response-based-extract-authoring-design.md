# 응답기반 extract 작성 — test-run 응답에서 클릭해 extract 생성 (편의/QoL 트랙, roadmap §C 후속 8-1)

- **날짜**: 2026-06-16
- **상태**: 설계 승인(사용자 2026-06-16) → plan 대기
- **출처**: roadmap §A 영역 C "후속(연기) — 응답기반 extract authoring(§8-1)" + 사용자 요청(2026-06-16, "내부 테스트 단계 — 편리함에 집중"). **왜 지금**: 체이닝 요청(로그인→토큰 추출→다음 요청에 사용)은 현실 부하 시나리오 작성에서 가장 자주 막히는 지점인데, 지금은 JSONPath를 손으로 써야 한다. test-run 패널(C-2)이 이미 응답 본문을 보여주므로 그 위에 "이 필드 추출" 동선만 얹는 자연스러운 확장.
- **연관**: ADR-0026(시나리오 에디터 test-run), ADR-0015(에디터 양방향 sync), ADR-0014(변수 네임스페이스 `{{var}}`). C-2 spec `2026-06-01-scenario-editor-test-run-design.md`. 엔진 extract: `crates/engine/src/scenario.rs::Extract`, `crates/engine/src/extract.rs`(serde_json_path).
- **ADR**: 신규 불필요(ADR-0026 + ADR-0015 + ADR-0014 범위 내 additive). 엔진 extract 모델·UI ExtractModel·setStepExtract·yamlDoc edit이 전부 이미 존재 — 이 슬라이스는 그 위의 **UI 브릿지**뿐.

---

## 1. 문제와 목표

엔진은 extract 4종(`body` JSONPath / `header` / `cookie` / `status`)을 이미 실행하고, UI도 `ExtractModel` Zod + `HttpStepModel.extract` + `setStepExtract` 스토어 액션 + yamlDoc round-trip + Inspector 수동 편집기를 이미 갖췄다. 빠진 것은 **test-run 응답을 보면서 필드를 클릭해 extract를 만드는 동선**뿐 — 사용자는 응답 JSON을 눈으로 보면서도 JSONPath(`$.data.token`)를 손으로 타이핑해야 한다.

- **목표**: test-run 응답 패널의 본문 필드·헤더·쿠키·상태를 클릭해 그 스텝의 `extract`를 추가하고, 양방향 sync로 YAML·Inspector에 즉시 반영. 생성한 JSONPath는 엔진 `serde_json_path`가 그대로 받아들인다.
- **비목표(연기)**: §7 참조. 응답값 기반 자동완성 path 제안·정규식 extract·수동 변수 오버라이드·중복 var 자동 dedup·라이브 캡처 등.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST test-run 응답 본문이 **유효 JSON & 미잘림**이면 접이식 트리로 렌더하고, 각 **스칼라 leaf**에 "+추출" 컨트롤을 노출한다 | RTL: ResponseBodyTree가 leaf마다 +추출 버튼 렌더, 컨테이너 노드엔 없음 | |
| R2 | MUST 트리 노드 경로 → JSONPath 문자열을 **RFC 9535 = 엔진 `serde_json_path`와 lockstep**으로 생성한다: 식별자 키 `.key`, 특수문자 키 `['key']`(이스케이프: `'`→`\'`, `\`→`\\`, **모든 `< U+0020` 제어문자 → `\uXXXX`**), 배열 `[i]`, 루트 `$` | 단위: `jsonPath` 골든(식별자/특수문자/배열/루트/`'`·`\`/**탭 등 제어문자 키**) + 라이브에서 엔진 수용(R10) | ✅ 엔진이 소비(serde_json_path) — UI가 emit하는 path 포맷 계약 |
| R3 | MUST 응답 **헤더 행·각 Set-Cookie·상태 칩**에 추출 컨트롤을 노출해 `header`(name 정확)·`cookie`(`=` 앞 이름 파싱)·`status`(필드 없음) extract를 만든다 | RTL: 각 버튼 클릭→`onCreate`가 올바른 kind/필드로 호출 | ✅ 엔진 `Extract` 와이어(from/var/name) 1:1 |
| R4 | MUST 생성한 extract를 **producing 스텝의 `extract`**에 신규 스토어 액션 `addStepExtract`로 append → 기존 `setStepExtract` edit → yamlDoc 양방향 sync(ADR-0015), **미저장 버퍼**(edit·new 두 페이지)에서도 동작 | store 단위: addStepExtract가 모델 step.extract에 append; RTL: TestRunSection 경유 store 반영(YAML round-trip) | |
| R5 | MUST 본문이 **잘림(`body_truncated`) 또는 비-JSON**이면 트리를 끄고 raw + 수동 입력 안내를 보이며, 헤더/쿠키/상태 추출은 계속 가능하게 둔다 | RTL: truncated·비-JSON fixture에서 트리 없음 + 안내 문구, 헤더 버튼 존재 | |
| R6 | MUST 본문 +추출을 **스칼라 leaf로 한정**한다(객체/배열 컨테이너는 표시만 — 경로·값 모호성 회피) | RTL: 컨테이너 노드엔 +추출 없음 (R1과 동일 테스트로 확인) | |
| R7 | MUST 대상 `step_id`가 **현재 모델에 없으면**(트레이스 후 스텝 삭제/변경) no-op + 안내 — 잘못된 위치에 쓰지 않는다 | store/RTL: 미존재 id로 addStepExtract→모델 무변경 + 안내 | |
| R8 | MUST 인라인 확인행에 **편집 가능한 var 입력**(leaf 키/헤더명/쿠키명 sanitize 후보 prefill)을 두고, SHOULD **값 미리보기**를 보인다 | 단위: 변수명 sanitize 골든; RTL: 확인행에 var 입력·후보 prefill·(가능 시)값 표시 | |
| R9 | MUST 이 슬라이스는 **UI-only** — 엔진·proto·controller·migration·워커 무변경, 새 extract를 안 만들면 시나리오 YAML byte-identical | 머지 diff = `ui/` 한정; extract 추가 안 한 round-trip byte-identical | ✅ 무변경 불변식 |
| R10 | MUST 생성된 JSONPath가 **엔진 런타임에서 그대로 수용·클릭값으로 해석**된다 (R2의 end-to-end parity) | 라이브: 로그인→토큰 클릭→추출→재실행에서 `extracted` 값·다음 스텝 `{{var}}` 전달 | ✅ R2와 같은 계약의 런타임 검증 |
| R11 | SHOULD 변수명 확인은 **인라인 행**으로(중첩 Modal 금지) — 큰 본문 트리가 "전체 보기" 모달 안에 있을 때 Modal-내-Modal ESC 레이어링 함정(ui/CLAUDE.md HelpTip-in-Modal)을 회피 | 코드리뷰: 확인행이 `<Modal>` 중첩이 아님 | |

- **seam 주의**: 이 슬라이스엔 직렬화 와이어(proto/Zod↔serde/migration) **변경이 없다**. R2/R10의 `seam ✅`는 **UI가 emit하고 엔진이 소비하는 JSONPath 포맷 계약**(cross-language) — handicap-reviewer가 UI 생성 규칙 ↔ `serde_json_path` 수용 범위를 1:1 대조해야 한다. R3의 `seam ✅`는 생성 extract 객체가 엔진 `Extract`(`#[serde(tag="from")]`)·UI `ExtractModel`과 필드 1:1.

---

## 3. 핵심 통찰 (설계 근거)

1. **머신은 다 있다 — 브릿지만 만든다.** 엔진 `Extract`(각 변형 `deny_unknown_fields` — UI는 정확한 키만 emit하면 안전)/`extract.rs`, UI `ExtractModel`(`model.ts:45`)·`HttpStepModel.extract`(`model.ts:93`)·`setStepExtract`(`store.ts:63,233`)·yamlDoc `setStepExtract` edit(`yamlDoc.ts:416`, 빈 배열=deleteIn)·Inspector 수동 편집기가 전부 존재. 그래서 R9(UI-only·byte-identical)가 자연 성립하고, 신규 표면은 ① 트리/affordance 프레젠테이션 ② path/varname 순수 함수 ③ `addStepExtract` thin 액션 ④ TestRunPanel 배선뿐. (ui/CLAUDE.md "extract 키 보존" 노트는 Slice-3 시절이라 **stale** — Slice 4가 모델에 wired; 이 슬라이스에서 그 노트 정정.) **주석 보존 한정**: `addStepExtract`는 기존 edit처럼 `extract:` 노드를 통째로 재생성하므로 *형제* 주석은 유지되나 `extract:` 블록 *내부* 주석은 소실(기존 ExtractEditor와 동일 동작 — 허용).
2. **path-format parity가 유일한 진짜 위험(R2/R10).** UI가 만든 JSONPath를 엔진 `serde_json_path`가 거부하면(특히 특수문자 키 bracket-quote 이스케이프) 사용자는 "추출했는데 값이 안 옴"을 본다. RTL은 엔진을 안 도므로 못 잡는다(S-D 갭) → 골든 단위테스트(R2) + 라이브 end-to-end(R10) 둘 다 필요. 생성 규칙은 의도적으로 **보수적**: 스칼라 leaf만(R6), 식별자 키는 `.key`, 그 외 전부 `['…']` 이스케이프.
3. **잘림은 끄는 게 안전(R5).** `body_truncated`는 1 MiB 바이트 컷(`from_utf8_lossy`)이라 중간이 잘려 `JSON.parse`가 throw(부분 파싱이 아니라 실패) → 게이트 `JSON.parse 성공 && !truncated`가 곧 트리 표시 조건. 트리를 끄고 수동으로 유도하는 게 "안 떠야 할 때 뜨는 것"보다 안전. 헤더/쿠키/상태는 본문 잘림과 무관하니 계속 허용.
4. **인라인 확인행 > 팝오버/모달(R11).** 큰 본문은 기존 "전체 보기" 모달 안에서 트리를 보여주는데, 그 안에서 var 입력을 또 `<Modal>`로 띄우면 capture-phase ESC가 바깥 모달을 닫는 함정(ui/CLAUDE.md). 클릭한 필드 옆에 인라인으로 펼치는 확인행이면 인라인/모달 양쪽에서 동일하게 동작하고 함정도 없음.
5. **producing 스텝에 그냥 기록.** extract는 자기 스텝 응답에 대해 실행되므로 트레이스의 `step_id`가 곧 대상. parallel 분기 내부 스텝이면 엔진 기존 `{{branch.var}}` 네임스페이스 규칙(ADR-0033)이 그대로 — v1은 우리가 바꾸지 않고 그 스텝에 기록만 한다.
6. **명시 결정 3종(리뷰에서 확정).** ① **트레이스-vs-라이브 버퍼 발산**: 표시되는 트레이스는 과거 스냅샷이고 `addStepExtract`는 *현재* 모델에 쓴다 — 트레이스 후 그 스텝을 편집했어도 extract는 (var,from,path)뿐이라 응답값과 독립이므로 **step_id로 그냥 기록**(R7은 *삭제된* 스텝만 가드, 편집은 정상 동작). ② **중복 var**: v1은 같은 스텝에 동명 var가 이미 있어도 **append 허용**(엔진 `extract::evaluate`의 `BTreeMap` insert가 같은 var를 마지막 값으로 collapse — `extract:` 배열 끝에 append하므로 새 항목이 이김, Inspector에서 정리) — 소프트 경고는 §7 연기. ③ **루트 스칼라 응답**(`"abc"`/`42`): 단일 루트 leaf 노출(path `$`, var 기본 `value`) — `serde_json_path`가 `$`로 루트를 반환하므로 유효, 드물지만 무해.

---

## 4. 변경 상세

> 전부 `ui/src` 한정. 각 묶음 머리에 충족 R 태그.

### 4.1 `ui/src/scenario/jsonPath.ts` (신규, 순수) — 충족 R: R2, R8
- `segmentsToPath(segments: Segment[]): string` — `Segment = {kind:"key", key} | {kind:"index", index}`. 식별자(`/^[A-Za-z_][A-Za-z0-9_]*$/`) 키는 `.key`, 그 외 `['` + RFC 9535 single-quoted 이스케이프 + `']`, index는 `[i]`, 빈 segments는 `$`. 출력은 항상 `$` prefix.
  - **이스케이프(R2 CRITICAL — serde_json_path 0.7.2 검증)**: `\`→`\\`, `'`→`\'`, 그리고 **모든 `code point < 0x20`(탭·개행 등) → `\uXXXX`**(4-hex, 0-pad). 제어문자를 raw로 두면 `serde_json_path`가 `expected an ending quote`로 거부 → 추출이 조용히 미매치. 골든에 탭 키 포함: JSON 키 `"a<TAB>b"` → 출력 `$['a	b']`(리터럴 백슬래시-u-0009, raw 탭 아님).
- `suggestVarName(raw: string): string` — leaf 키/헤더명/쿠키명 → 비-`[A-Za-z0-9_]`를 `_`로, 선두 숫자면 `_` prefix, 빈 결과는 `"value"`.

### 4.2 `ui/src/components/scenario/ResponseBodyTree.tsx` (신규, 프레젠테이셔널) — 충족 R: R1, R6, R8, R11
- props: `value: unknown`(파싱된 JSON), `onCreate(extract: Extract): void`.
- 재귀 트리: 객체/배열은 접이식 노드(표시만), **스칼라(string/number/boolean/null) leaf만** `+추출`. leaf 클릭 → 그 행 아래 **인라인 확인행**(var `<input>` = `suggestVarName(key)` prefill + 경로 텍스트 `segmentsToPath(path)` + 값 미리보기 + 추가/취소). 추가 → `onCreate({var, from:"body", path})`.
- 루트가 스칼라면 단일 leaf(path `$`, var 기본 `value`).

### 4.3 `ui/src/components/scenario/TestRunPanel.tsx` — 충족 R: R1, R3, R4, R5, R7, R11
- `TestRunPanel`에 optional `onAddExtract?(stepId: string, extract: Extract): void` prop 추가(프레젠테이셔널 유지 — 부모가 store에 연결). `HttpRow`로 전달.
- `BodyBlock`/`BodyViewer` 강화: 응답 본문이 `JSON.parse` 성공 **&& !truncated**이면 트리 제공 — 짧은 본문(≤500자)은 인라인 트리(+`원본` 토글), 큰 본문은 기존 모달 툴바에 `트리` 토글 추가. truncated/비-JSON이면 트리 없음 + 안내 문구(헤더/쿠키/상태는 유지). (요청 본문엔 트리 미적용 — 응답 전용.)
- 응답 헤더 행·각 Set-Cookie 옆 작은 `추출` 버튼, 상태는 **펼친 응답 영역** 안의 별도 `상태 추출` 버튼(접힌 헤더 행은 toggle `<button>`이라 거기 칩 옆에 버튼을 넣으면 interactive 중첩 — 반드시 expanded `<div>` 안에) → 인라인 확인행 → `header`(name)/`cookie`(`=` 앞 파싱)/`status` extract 생성. (요청 헤더엔 없음.)
- 공유 인라인 확인행 컴포넌트(트리 leaf·헤더/쿠키/상태 공용): var 입력 + (선택)미리보기 + 추가/취소. **반드시 평범한 인라인 JSX** — `<Modal>`도 `<HelpTip>`도 쓰지 않는다(둘 다 capture-phase ESC 함정, ui/CLAUDE.md; 큰 본문 트리는 이미 `BodyViewer` 모달 *안*이라 중첩 Modal이면 ESC가 바깥 모달을 닫는다, R11).
- **`HeaderTable` 변형 주의**: `HeaderTable`(`:162`)은 요청·응답 헤더에 **공용**이다 — affordance는 **응답 측에만**(요청 헤더/요청 본문은 그대로). optional `onExtract?(name)` prop을 더해 응답 호출부만 전달하거나 응답 전용 래퍼를 둔다.
- **프롭 스레딩**: `onAddExtract`는 두 본문 마운트 지점으로 흐른다 — **짧은 본문(≤500자)은 `BodyBlock`이 `<pre>` 대신 `ResponseBodyTree`를 *직접* 마운트**(`BodyBlock`은 `:104-108`에서 `BodyViewer` 도달 *전에* early-return하므로 모달 경로로만 배선하면 짧은 본문 트리를 놓침), **긴 본문은 `BodyBlock → BodyViewer → ResponseBodyTree`**(모달). 헤더류는 `HttpRow → HeaderTable/Set-Cookie/상태버튼`. `HttpRow`는 현재 `{ step }`만 받으므로 prop 추가 필요 — 4-레벨 배선을 plan task가 예산에 넣을 것.
- `HttpRow`의 `onCreate(extract)` → `onAddExtract?.(step.step_id, extract)`. `if`/컨테이너 행(IfRow)엔 affordance 없음(응답 없음).

### 4.4 `ui/src/scenario/store.ts` (+ yamlDoc 재사용) — 충족 R: R4, R7
- 신규 액션 `addStepExtract(stepId, extract)`: **(a) pending YAML 버퍼 먼저 커밋** — Monaco YAML 뷰 편집 중이면 `pendingYamlText !== null`이라 `doc`/`model`이 stale; 먼저 `commitPendingYaml`(있으면)을 적용해 미커밋 키 입력 유실을 막는다(test-run 패널은 YAML 탭 아래에도 마운트라 debounce 윈도 클릭 가능). **단 커밋 후 `get().yamlError !== null`(버퍼가 파싱 불가)이면 commit이 stale `doc`을 그대로 둔 채 early-return하므로 → `addStepExtract`도 no-op + 안내**(파싱 안 되는 버퍼에 extract를 쓰면 stale doc 위에 써 사용자의 미커밋 입력을 덮어쓴다). (b) 정상이면 현재 `get().model`에서 `findStepById(steps, stepId)` 조회 → http 스텝이면 `[...step.extract, extract]`로 기존 `setStepExtract(stepId, …)` 호출(새 yamlDoc edit case 불필요 — replace edit 재사용), 미존재/비-http면 no-op(R7). 중복 var는 append 허용(§3 결정②). 액션 ref는 v5 stable(모듈 캡처).

### 4.5 `ui/src/components/scenario/TestRunSection.tsx` — 충족 R: R4
- `<TestRunPanel onAddExtract={(id, ex) => useScenarioEditor.getState().addStepExtract(id, ex)} … />` 배선(edit·new 두 페이지 공유, 같은 module-scoped store). 추가 직후 인라인 확인 피드백 1줄("추가됨 — Inspector·YAML에서 확인").

### 4.6 `ui/CLAUDE.md` — 충족 R: (문서 정정)
- "extract 키 보존(Slice 3)" 노트가 stale임을 정정(Slice 4가 `extract`를 모델에 wired, `addStepExtract`/응답기반 작성 추가). test-run 패널 섹션에 응답기반 extract 작성 함정 1–2줄 추가.

---

## 5. 무변경 / 불변식 (명시)

- **엔진·proto·controller·migration·워커 무변경** — 엔진 `Extract`/`extract.rs`/`serde_json_path`, 컨트롤러 `POST /api/test-runs` trace 엔드포인트, `ScenarioTraceSchema` 와이어 전부 그대로 소비만.
- **`setStepExtract` edit·yamlDoc round-trip 무변경** — `addStepExtract`는 기존 replace edit을 재사용(신규 edit case 0).
- **extract를 추가하지 않으면 시나리오 YAML byte-identical** (R9) — 트리/affordance는 읽기·표시일 뿐, 모델 mutation은 사용자가 "추가"를 누를 때만.
- **요청 본문/요청 헤더 표시 무변경** — affordance는 응답에만.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1 | RTL ResponseBodyTree: leaf마다 +추출, 컨테이너 없음 | |
| R2 | 단위 `jsonPath.test.ts` 골든: `$.data.token`·`$.items[0].sku`·`$['weird.key']`·`$['has space']`·`$['it\'s']`·**탭 등 제어문자 키 → `\uXXXX`**·루트 `$` | |
| R3 | RTL: 헤더/쿠키/상태 버튼→`onCreate`가 `{from:"header",name}`/`{from:"cookie",name}`/`{from:"status"}` 정확 | |
| R4 | store 단위 `addStepExtract`(append·미존재 no-op) + RTL TestRunSection→store 모델 반영(YAML에 `extract:`) | |
| R5 | RTL: `body_truncated`·비-JSON fixture→트리 없음+안내, 헤더 버튼 존재 | |
| R6 | RTL(R1과 동일): 컨테이너 노드 +추출 부재 | |
| R7 | store/RTL: 미존재 step_id→모델 무변경+안내 | |
| R8 | 단위 varname 골든 + RTL 확인행 prefill·값 표시 | |
| R9 | 머지 diff = `ui/` 한정 확인(엔진/proto/migration 0) | |
| R10 | **라이브**: 로그인 echo→토큰 필드 클릭→추출→YAML 확인→재실행 `extracted` 값·다음 스텝 `{{token}}` 전달; 특수문자 키 1건 포함 | ✅ |
| R11 | 코드리뷰: 확인행이 중첩 `<Modal>` 아님 | |

- **라이브 검증 필수**(R10): test-run·엔진 path 해석 경로 — RTL이 못 증명하는 **생성 JSONPath ↔ `serde_json_path` parity**가 핵심. `/live-verify` 스택(워크트리 자체 바이너리 + 50ms responder 대신 **에코 응답기**로 토큰을 본문에 실어 보내는 변형) + 2스텝 시나리오. (UI-only지만 엔진 path 수용을 닫아야 하므로 production diff 0이 아님 → waive 불가.)

---

## 7. 의도적 연기 (roadmap §C / §B10에 누적)

- **응답값 기반 path 자동완성/추천**: 클릭 없이 경로 타이핑 시 응답에서 매칭 제안 — 별도.
- **정규식 extract**: 엔진에 `from:"regex"` 변형 자체가 없음(추가는 엔진 슬라이스).
- **수동 변수 오버라이드(test-run)**: §8-2, 별도.
- **중복 var 자동 dedup / 충돌 경고**: v1은 append 허용(Inspector 정리). 소프트 경고는 후속.
- **컨테이너(객체/배열) 통째 추출**: serde_json_path가 객체도 반환하나 문자열화가 모호 → v1 스칼라 leaf만(R6).
- **parallel 분기 `{{branch.var}}` 인지 UX**: v1은 엔진 기존 규칙대로 기록만, 분기 네임스페이스 안내는 후속.
- **민감값 마스킹**: 추출 미리보기/값 표시에 비번·토큰 평문 노출 — 보안 트랙(§A10/§B1)과 함께.
- **라이브 캡처/프록시**: HAR import의 미래 라이브 캡처와 별개 트랙.

---

## 8. 구현 순서 (plan 입력)

> UI-only라 cargo 게이트 무관 — 커밋 경계는 `pnpm lint && pnpm test && pnpm build`. 순수 함수 먼저(테스트 self-unblock), 그 위에 프레젠테이션, 마지막에 배선·라이브.

1. **순수 코어** `jsonPath.ts`(segmentsToPath + suggestVarName) + 골든 단위테스트 (R2, R8).
2. **트리** `ResponseBodyTree.tsx` + 공유 인라인 확인행 + RTL (R1, R6, R8, R11).
3. **스토어** `addStepExtract` 액션 + 단위테스트 (R4, R7).
4. **배선** TestRunPanel `onAddExtract`/BodyBlock·BodyViewer 트리 토글/헤더·쿠키·상태 버튼 + TestRunSection 연결 + RTL (R1, R3, R4, R5, R7).
5. **문서** ui/CLAUDE.md 정정 + 함정 추가 (4.6).
6. **라이브 검증** `/live-verify` 2스텝 path parity (R10) → 머지 전 필수.

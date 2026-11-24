# 4xx·5xx를 기본 오류로 (http-error-default) 설계

- 날짜: 2026-11-24
- 상태: **②a 구현·최종 리뷰·라이브 끝 (2026-11-24, 코드 `58ed2318`..`2aac5fda`, ADR-0064, 판단·연기 roadmap §B93)** · ②b(에디터·안내) plan 검토 끝(2026-11-24, spec-plan-reviewer 2차 clean APPROVE — 이때 고친 spec은 §12 끝). spec은 spec-plan-reviewer 4차 clean APPROVE(처리 §12). plan: ②a `docs/superpowers/plans/2026-11-24-http-error-default-a.md` · ②b `docs/superpowers/plans/2026-11-24-http-error-default-b.md`.
- 유형: `user-path`
- 출처: roadmap §A17 진행 순서 ②. 사용자 순서 결정(2026-11-23): ① 통과/실패 분리 ✅ → **② 이 문서** → ③ 평균·백분위 판정 → ④ 그래프·내보내기. ①~④ 사이에는 릴리즈하지 않는다.
- 사용자 결정 (2026-11-24, 다시 묻지 않는다):
  - 기대 상태 코드를 **여러 개** 적을 수 있게 한다. 범위(`2xx`)는 받지 않는다.
  - US1–US5를 승인했다.
  - 목업 `2026-11-24-http-error-default-mockups/screens.html`을 승인했다.
  - **에디터가 만드는 새 http 스텝은 상태 코드 검사 없이 시작한다**(기본 규칙 「400 이상은 오류」). 템플릿 갤러리 예시의 `status: 200`은 그대로 둔다.
  - 구현 방식은 맡겼다. 작성자 판단은 §11에 있다.
- ADR: **ADR-0064 신설**(상태 코드 기본 규칙과 run별 규칙 번호).
- 슬라이스: **②a 판정(엔진·컨트롤러·리포트·인쇄) → ②b 에디터·안내 화면**(§10). 같은 spec이고 plan은 둘이다. 작업 브랜치는 `worktree-http-error-default` 하나에서 차례로 한다.

## 사용자 스토리 (US)

- **US1**: QA가 상태 코드 검사를 적지 않은 시나리오로 부하를 돌리는데 서버가 4xx·5xx를 낸다 — 성공하면 리포트의 오류 수·오류율이 그 응답만큼 오르고, 오류율 판정 기준을 걸었으면 실패로 나온다. 이 변경 전에 끝난 run의 숫자는 그대로다.
- **US2**: QA가 정상 응답이 둘 이상인 스텝(예: 200 또는 409)에 기대 상태 코드를 여러 개 적는다 — 성공하면 그 스텝은 적은 코드를 받을 때 통과하고 값 추출도 되며, 그 밖의 코드(500 등)는 오류로 센다.
- **US3**: QA가 상태 코드와 상관없이 진행해야 하는 스텝에 에디터에서 「상태 코드를 보지 않음」을 고른다 — 성공하면 그 스텝의 4xx·5xx는 오류로 세지 않고 값 추출도 되며, 리포트는 「이 스텝은 오류 응답을 받았지만 오류로 세지 않았다」고 알린다.
- **US4**: QA가 에디터에서 시나리오를 미리 실행한다 — 성공하면 스텝마다 부하 실행과 같은 판정이 나온다. 검사 없는 스텝이 404를 받으면 실패로 표시되고 이유 글이 보이며, 실행 전 신뢰도 점검도 새 규칙에 맞는 말로 나온다.
- **US5**: 운영자가 운영 모니터 보드를 본다 — 성공하면 상태 코드 검사가 없는 점검 스텝이 4xx·5xx를 받을 때 그 칸이 실패로 바뀌고 사유에 상태 코드가 나온다(GUI 보드와 터미널 모니터 둘 다).

슬라이스별 증명: ②a = US1 · US2(YAML로 적은 목록) · US3의 리포트 부분(YAML로 적은 `any`) · US5. ②b = US2·US3의 에디터 부분 · US4. 인쇄 보고서의 오류 분류(R25)는 US1 「리포트의 오류 수」에 속한다. 인쇄 보고서도 같은 run을 말하므로 숫자와 글이 화면과 같아야 한다.

## 1. 배경

### 1.1 지금 상태 (`86c845e2` 기준 — 확인 명령은 §9)

- **상태 코드 판정은 네 곳**이고 규칙은 모두 「적힌 값과 다르면 오류」다.
  - 엔진 부하 실행: `executor.rs:315`. 오류 분류는 `ErrorClass::StatusAssert`.
  - 엔진 traced 실행: `executor.rs:716`. 미리 실행·모니터·준비 스텝 trace가 이 경로를 쓴다.
  - 모니터 사유 분류: `monitor/check.rs:553` `status_mismatch`. `step_judge.rs`도 `classify`를 거쳐 이 함수를 쓴다.
  - 인쇄 분류: `ui/src/print/stepTable.ts:23` `classifyCell`. 「검사 없음 + 4xx·5xx」를 `uncounted`(오류에서 빠짐)로 판정한다. 이 판정을 쓰는 곳은 `stepStatus.ts`·`sentences.ts`·`components/StepCodeTable.tsx`·`components/TableNotes.tsx`·`compare/errorCells.ts`다. 글은 `ko.ts`의 「응답 코드 검사가 없어 오류에서 제외됐습니다」·「이 단계에 응답 코드 검사를 추가하길 권합니다」다.
  - 검사가 없는 스텝은 어떤 상태 코드든 통과다.
- **검사 모델은 값 하나다**: 엔진 `enum Assertion { Status(u16) }`(YAML `- status: 200`, 손으로 쓴 serde `scenario.rs:384–433`), 화면 `AssertionModel = { kind: "status", code }`. 검사 줄이 여럿이면 **모든 줄**을 만족해야 통과다. 그래서 서로 다른 코드를 두 줄 적으면 항상 실패한다.
- **에디터는 새 http 스텝에 `status: 200`을 넣는다**: `yamlDoc.ts`의 `defaultHttpStepNode`와 loop·if·parallel 뼈대 열 곳이다. 그래서 지금 구멍은 YAML로 직접 쓴 시나리오, HAR 가져오기(기본 `statusAssert=false`, `ScenarioImportPage.tsx:47`), 검사를 지운 스텝에 남아 있다.
- **오류가 난 스텝은 값을 추출하지 않는다**(`executor.rs:325·726`의 `error.is_none() && !step.extract`). 엄격 모드에서는 추출 기본값이 없으면 빈 값도 채우지 않는다(`extract.rs:436`). 그 결과는 이렇다.
  - 다음 스텝의 `{{var}}`가 `UnknownVar`가 되어 closed-loop·VU 곡선 VU가 끝난다(`runner.rs:377` `failed++`).
  - 모든 VU가 그렇게 끝나면 run이 `failed`다.
  - open-loop는 그 도착 하나만 버린다.
  - 조건 반복 본문은 너그러운 추출이라 빈 값으로 이어진다.
  - parallel 분기도 너그럽다.
  - 준비 스텝은 실패 종류로 남는다.
  - trace는 계속 간다.
- **리포트 유효성**(`validity.rs` `derive_validity`, 호출은 `report.rs:1504` 한 곳):
  - `silent_http_errors`: 4xx+5xx가 있는데 오류 수가 0일 때.
  - `no_response_validation`: 늘 실행되는 http 스텝 가운데 상태 코드 검사가 있는 스텝이 없고 판정 기준도 없을 때.
  - 리포트는 열 때마다 다시 만든다. 그래서 규칙을 바꾸면 옛 run의 유효성도 바뀐다.
- **범위가 적용되는 데이터**: 초별 창(`windows`)은 그림용이라 기준(`?basis=`) 범위 밖 행도 담는다(`report.rs:832`). `steps[].status_counts`·`status_distribution`·`summary.errors`는 범위 안 행만이다. 준비 구간 통계(`setup.steps[].status_counts`)는 범위와 무관하다.
- **준비 구간 실패 종류** 목록은 엔진 `section.rs:228–246`(`KIND_*`·`is_section_failure_kind`)에 있다. `ErrorClass::StatusAssert`는 `status_assert`가 된다. 본 스텝에는 종류별 집계가 없다.
- **화면**:
  - 에디터 `AssertEditor`(`Inspector.tsx:623`)는 코드 줄 목록과 추가 칸이다.
  - `FlowOutline` 칩 「검증 N」은 검사 줄 수를 센다.
  - 신뢰도 점검 A(`trust.ts`)는 「모든 http 스텝에 상태 코드 검사」가 있어야 통과다.
  - 신뢰도 「미리 실행 확인됨」 지문(`trustPrefs.ts` `canonStep`)에는 `assert`가 들어간다.
  - 미리 실행 결과(`TestRunPanel.tsx`), 모니터 미리보기(`PreviewResult.tsx`), 점검 기록(`CheckRecordDialog.tsx`)은 엔진 오류 글을 그대로 보인다. 이 셋 가운데 스텝 모델을 받는 것은 미리 실행뿐이다.
  - 표본 설명 `passedHelp`(`ko.ts:1300`)는 「상태 코드 검사가 없는 스텝에서는 4xx·5xx 응답도 통과로 셉니다」라고 쓴다.
  - 인쇄 `scenarioFacts.ts`는 검사 코드를 `statusCodes: number[]`로 모은다. `print/compare/fairness.ts`는 그 배열이 비었는지로 검사 추가·삭제·변경을 판단한다.
  - `monitor/conditions.ts`의 `kind: "status"`는 칸 성공 조건이다. 스텝 검사 모델과는 무관하다.
- **화면 Zod `ReportRunSchema`는 `.strict()`다**(`schemas.ts:669`). 서버가 `run`에 필드를 더하면 같은 커밋에서 Zod도 바꿔야 한다. 그러지 않으면 모든 리포트 파싱이 깨진다.
- 컨트롤러와 워커 사이에 판(version) 확인이 없다. `runs` 표에는 run이 어느 규칙으로 돌았는지 나타내는 칸이 없다. 마이그레이션은 0028이 마지막이다.

### 1.2 문제

검사를 빼먹으면 서버가 전부 500을 내도 오류율 0%·판정 통과로 나온다. k6·JMeter·LoadRunner의 HTTP 기본 동작은 400 이상을 실패로 본다. 신규 시스템 수용성 시험(roadmap §A16)에서 판정 기준을 믿으려면 「검사를 안 적은 스텝」이 구멍이어서는 안 된다.

## 2. 목표·비목표

- **목표**
  - 검사를 적지 않은 스텝의 400 이상 응답을 오류로 센다.
  - 정상 응답이 여럿인 스텝과 상태 코드가 상관없는 스텝을 각각 적을 길을 둔다.
  - 부하 실행·미리 실행·운영 모니터·인쇄 분류가 같은 규칙을 쓴다.
  - 옛 run의 리포트는 숫자도 경고도 그대로다.
- **비목표**
  - 범위 표기(`2xx`)
  - 본문 내용 검사
  - 본 스텝의 실패 종류별 집계
  - 기본 규칙을 끄는 전역·시나리오 설정
  - 컨트롤러↔워커 판 확인
- **하면 안 되는 것**
  1. 이 변경 전에 끝난 run의 리포트(화면·인쇄·비교·내보내기)의 숫자·유효성 글이 바뀐다.
  2. 검사 줄이 여럿인 기존 YAML의 뜻을 조용히 바꾼다.
  3. 「보지 않음」 스텝의 오류 응답이 리포트 어디에도 안 보인다.
  4. 규칙이 다른 두 run을 아무 알림 없이 비교한다.

## 3. 접근

| 안 | 내용 | 판단 |
|---|---|---|
| **가 (채택)** | 엔진 규칙을 바로 바꾼다(끄는 스위치 없음). 검사 표기를 넓힌다(값 하나·목록·`any`). run마다 규칙 번호를 저장해 리포트가 옛 run을 옛 규칙으로 읽는다. | 구멍을 실제로 닫고, 옛 run을 속이지 않는다. |
| 나 | 시나리오 맨 위에 `http_errors: fail\|pass`를 두고 기본을 `fail`로 한다. | 설정 하나로 예전 구멍이 통째로 돌아온다. 스텝마다 고르는 `any`가 같은 일을 더 좁게 한다. |
| 다 | 엔진은 그대로 두고 화면이 검사를 넣게 한다. | 에디터는 **이미** 새 스텝에 200을 넣는다(§1.1). 그래도 YAML·HAR·지운 검사의 구멍이 남았다. 사용자 문장 「기본으로 오류」와도 다르다. |

## 4. 요구사항

### 4.1 시나리오 표기 (엔진·화면 공통) — ②a

- **R1 표기 셋.** 검사 한 줄의 `status` 값은 셋 가운데 하나다.
  - 숫자 하나: `- status: 200`. 지금 그대로다.
  - 숫자 목록: `- status: [200, 409]`. 가운데 하나면 통과다. 빈 목록은 읽기 오류다. 같은 숫자가 겹쳐도 받는다.
  - 글자 `any`: `- status: any`. 상태 코드를 보지 않는다. 다른 글자는 읽기 오류다.
  - 엔진은 수동 serde를 유지하고 `visit_map` 안에서 값의 타입으로 갈래를 나눈다(untagged derive 금지 — `crates/engine/CLAUDE.md` serde enum 함정).
- **R2 쓰기.** 엔진은 숫자 하나를 숫자로, 둘 이상을 목록으로, 「보지 않음」을 `any`로 쓴다. 숫자 하나짜리 기존 YAML은 엔진 round-trip에서 글자 그대로다. `[200]`은 읽을 수 있고, 엔진이 다시 쓰면 `200`이 된다. 화면은 손대지 않은 스텝의 YAML을 다시 쓰지 않는다(`[200, 200]`도 그대로 남는다).
- **R3 범위.** 숫자는 100–599다. 화면(Zod)은 지금처럼 범위 밖을 거부한다. 엔진은 지금처럼 `u16`으로 읽는다(범위 검사를 새로 넣지 않는다).
- **R4 여러 줄.** 검사 줄이 여럿이면 지금처럼 **모든 줄**을 만족해야 통과다. `any` 줄은 늘 만족이다.

### 4.2 판정 규칙 (엔진) — ②a

- **R5 기본 규칙.** 상태 코드 검사 줄이 **하나도 없는** http 스텝은 응답 상태 코드가 400 이상이면 오류다. 399까지(1xx·2xx·3xx)는 통과다.
- **R6 검사가 있으면 검사를 따른다.** 검사 줄이 하나라도 있으면 기본 규칙을 적용하지 않는다. `status: 404`면 404가 통과이고 200이 오류다. `status: any`만 있으면 500도 통과다.
- **R7 판정 함수 하나.** 엔진에 `pub fn judge_status(asserts: &[Assertion], status: u16) -> StatusVerdict`(`Pass` / `Mismatch` / `DefaultRule`)를 둔다.
  - 엔진의 두 경로와 모니터 `status_mismatch`가 이 함수를 부른다.
  - 스텝 하나의 「`any`뿐인가」 판별(R14·R16·R22)도 엔진의 `pub fn status_unchecked(asserts) -> bool` 하나로 한다. 검사 줄이 하나 이상이고 모두 `any`일 때만 참이다(`[any, 200]`은 거짓, `[]`도 거짓).
  - 엔진 `Assertion`의 변형은 `Status(StatusExpect)` 하나로 두고, `enum StatusExpect { One(u16), AnyOf(Vec<u16>), Any }`로 표기를 나눈다. 두 함수는 `_` 갈래 없는 전수 match로 쓴다.
  - 응답 코드로 판정하는 자리(`executor.rs:315·716`, `check.rs:558`)는 **모두** `judge_status` 호출로 바꾼다. 새 표기를 말없이 지나치는 자리가 남지 않게 하기 위해서다.
  - **예외 — `insights.rs:747` `http_step_has_status_assert`**: 규칙 1 `no_response_validation` 전용이고 뜻은 「상태 코드 검사 줄이 하나라도 있다」다. 이 뜻을 그대로 지킨다(`Assertion` 변형이 `Status` 하나라 `!h.assert.is_empty()`와 같다). 두 함수로 바꾸지 않는다 — `status_unchecked`는 `[]`과 `[200]`을 가르지 못한다. 규칙 2 판별(R16)은 `status_unchecked`를 쓰는 별도 함수로 둔다.
  - 바꾼 뒤 `grep -rn "Assertion::Status" crates/*/src`에는 serde·두 함수·`insights.rs`의 위 함수·테스트만 남는다.
- **R8 오류의 뒷일은 지금의 검사 불일치와 같다.**
  - 값 추출을 건너뛰고, 오류 수에 들어가고, 응답 시간은 「실패한 요청」 표본(ADR-0063)에 들어간다.
  - 그 뒤의 흐름은 §1.1의 갈래를 그대로 탄다. 추출 값을 쓰는 다음 스텝이 있으면 VU가 끝날 수 있다는 점도 같다.
  - 새 갈래를 만들지 않는다.
- **R9 오류 글·분류.**
  - 기본 규칙 위반: 오류 글 `status <코드> (>= 400)`, 분류는 새 `ErrorClass::HttpStatus`.
  - 검사 불일치: 지금 글 `status 503 != 200`을 유지한다. 목록이면 `status 503 not in [200, 409]`이다.
  - 준비 구간 실패 종류에 `http_status`를 더한다. `status_assert`는 검사 불일치 전용으로 남는다.
  - 기본 규칙 위반 오류 글의 모양은 **화면 판별의 계약**이다(R21). 엔진 테스트와 화면 테스트가 같은 글을 고정한다.
- **R10 성능.** 검사 없는 스텝은 요청당 정수 비교가 한 번 늘 뿐이다. 목록 검사는 목록 길이만큼 비교하고 할당이 없다. `/perf-ab master`로 요청당 CPU를 잰다(working-rules §10).

### 4.3 run의 규칙 번호 (컨트롤러) — ②a

- **R11 저장.**
  - 마이그레이션 **0029**로 `runs.status_rule INTEGER NOT NULL DEFAULT 1`을 더한다. Rust 가드(`pragma_table_info`)로 멱등하게 하고 멱등 테스트를 둔다(`/new-migration`, `crates/controller/CLAUDE.md`).
  - `runs::insert`가 **2**를 적는다. API 생성과 스케줄러가 모두 `spawn_run` → `runs::insert` 하나를 지난다.
  - 1 = 「검사 없는 스텝은 무엇이든 통과」, 2 = 이 문서의 규칙이다.
  - `RunRow`를 읽는 SELECT 두 곳도 고친다.
- **R12 리포트.**
  - 리포트 JSON `run`에 `status_rule`(1|2)을 늘 싣는다. Rust `ReportRun`에는 `#[serde(default = "status_rule_legacy")]`를 단다(`fn status_rule_legacy() -> u8`가 상수 `STATUS_RULE_LEGACY = 1`을 돌려준다). 픽스처와 `testdata/compare_golden.json`이 그대로 읽혀야 하기 때문이다. R11의 칸 기본값과 insert 값도 같은 상수 둘(`STATUS_RULE_LEGACY = 1`, `STATUS_RULE_CURRENT = 2`)에서 온다.
  - 화면 `ReportRunSchema`에 `status_rule: z.union([z.literal(1), z.literal(2)])`를 **서버와 같은 커밋에** 더한다. `.default()`는 쓰지 않는다(ui/CLAUDE.md default 누출).
- **R13 옛 run 불변.** `status_rule = 1`인 run의 리포트는 유효성 사유·글·숫자가 이 변경 전과 같다. `derive_validity`의 규칙 1 갈래가 지금 코드 그대로이고, 인쇄 분류도 규칙 1 갈래가 지금 그대로다(R25).

### 4.4 리포트 유효성 (규칙 2인 run) — ②a

- **R14 「보지 않음」 스텝의 오류 응답.**
  - 새 사유 `status_unchecked_errors`(warning)를 **스텝마다 하나씩** 낸다. 조건은 검사가 `any`뿐인 http 스텝(준비 스텝 포함)이 받은 4xx+5xx 수가 0보다 클 때다.
  - `step_id`·`count`(그 수)를 채운다. 순서는 `count`가 큰 것부터다.
  - 본 스텝은 범위가 적용된 `steps[].status_counts`에서, 준비 스텝은 `setup.steps[].status_counts`에서 센다(`windows`는 쓰지 않는다 — §1.1).
  - `?sample=`은 개수에 영향이 없다.
  - 화면 글: 「상태 코드를 보지 않는 스텝 「<이름>」이 4xx·5xx 응답 N건을 받았습니다. 상태 코드로는 오류로 세지 않았습니다」. 「상태 코드로는」을 넣는 이유: `any` 스텝도 그 응답에서 값 추출이 실패하면 오류로 센다(`ErrorClass::Extract`). N건 가운데 몇 건이 그랬는지는 리포트에서 나눌 수 없다.
- **R15** 규칙 2에서는 `silent_http_errors`를 내지 않는다(R14가 대신한다).
- **R16 `no_response_validation`(규칙 2).** 늘 실행되는 http 스텝이 **모두** `any`이고 판정 기준도 없을 때만 낸다. 규칙 2 run의 화면 글은 「상태 코드 검사와 판정 기준이 없어 성공·실패를 확정할 수 없습니다」다. 규칙 1 run은 지금 글 그대로다(R13 — ②a plan 검토에서 정정, 2026-11-24).
- **R17 해석 문장.** `status_unchecked_errors`가 있으면 「할 수 없는 말」에 새 키 `unchecked_steps_error_free`(「상태 코드를 보지 않는 스텝이 정상 응답했다」)를 더한다.
- XLSX Summary의 `validity_reason_kinds`에는 새 kind가 실린다. 내보내기 코드는 바뀌지 않고 내용만 바뀐다.

### 4.5 화면 모델·리포트 글 — ②a

- **R19 화면 모델.**
  - 검사 한 줄은 `{ kind: "status", codes: number[] }`(길이 ≥ 1) 또는 `{ kind: "status_any" }`다.
  - YAML → 모델(`normalizeAssertion`)과 모델 → YAML(`setStepAssert`·`yamlDoc` 편집 타입·`store.setStepAssert` 시그니처)이 R1·R2를 따른다.
  - 빈 목록을 쓰면 지금처럼 `assert: []`가 남는다. 엔진은 이것을 검사 없음으로 읽는다.
  - ②a의 `AssertEditor`는 읽은 줄을 글(「200·409」·「보지 않음」)과 ×로 보이고, 추가 칸은 코드 하나짜리 줄을 더한다. 이것은 ②b의 R18이 바꿀 **임시 모양**이다.
- **R23 표본 설명.** `passedHelp`: 규칙 2인 run은 「오류로 세지 않은 요청입니다. 상태 코드 검사를 적지 않은 스텝은 400 이상 응답을 오류로 셉니다.」, 규칙 1인 run은 지금 글이다.
- ValidityBanner에 새 kind와 스텝 이름을 더한다. `ReportView`가 리포트의 시나리오에서 만든 스텝 이름표를 넘긴다(없으면 id).

### 4.6 모니터·인쇄·비교 — ②a

- **R24 모니터 사유.** `status_mismatch`가 `judge_status`를 부르므로 기본 규칙 위반도 사유가 `HTTP <코드>`가 된다. 터미널 모니터는 컨트롤러를 안에 품으므로 코드 변경 없이 같은 결과다.
- **R25 인쇄 분류.**
  - `scenarioFacts`가 검사를 `statusLines: Array<number[] | "any">`로 모은다. 기존 `statusCodes`는 없앤다.
  - `classifyCell`이 run의 `status_rule`을 받는다. 규칙 1 갈래는 지금 동작이다. 지금 `statusCodes`를 줄마다 하나씩으로 보면 같은 결과다.
  - 규칙 2 판정표:

| 스텝 검사 | 2xx·3xx | 4xx·5xx | 0(전송 실패) |
|---|---|---|---|
| 없음 | plain | **counted** | counted |
| 코드 줄(들) — 모든 줄에 들어 있음 (`any` 줄은 건너뛴다) | expected | expected | counted |
| 코드 줄(들) — 하나라도 빠짐 | counted | counted | counted |
| `any`뿐 | plain | 추출이 실패할 수 있으면 unknown, 아니면 uncounted | counted |
| 스텝을 못 찾음 | plain | unknown | counted |

  - 규칙 2인 run에서 「응답 코드 검사가 없어 오류에서 제외됐습니다」 글은 `any` 스텝에만 붙는다. 글은 「상태 코드를 보지 않도록 정한 단계라 오류에서 제외됐습니다」다. 「검사를 추가하길 권합니다」는 넣지 않는다(`any`는 일부러 고른 것 — 사용자 확인 2026-11-24).
  - `print/compare/fairness.ts`는 `statusLines`를 견준다. **두 run이 모두 규칙 1이면** 지금처럼 「추가·삭제」는 비었는지, 「변경」은 줄 내용(코드 집합·`any`)으로 판단한다(옛 run 글 불변). **그 밖에는 R28을 따른다**(②b).
- **R26 비교 알림.** 선택한 run들의 `status_rule`이 다르면 화면 비교에 `basisNotice`·`sampleNotice`와 같은 자리의 알림을 띄우고, 인쇄 비교에 한 줄을 더한다(②a는 표본 알림 줄 아래 — plan 판단). 글은 §6이다(②b에서 「선택한 run」 글로 바꾼다 — 사용자 결정 2026-11-24).
  - **인쇄 비교 보강(②b, 사용자 결정 2026-11-24)**: ②a는 알림 줄만 그려서, 같은 시나리오·같은 부하로 규칙만 다른 두 run이면 조건 카드가 모두 「같음」이고 머리말 「참고」 문장이 없다 — 머리말만 읽으면 「조건이 같은데 오류율이 0% → 100%」로 읽힌다. 그래서 ① 규칙 차이를 「다른 조건」 이름 목록(`diffNames`)에 넣어 머리말 「참고」 문장에 나오게 하고(run 상태 차이 `statusLines`와 같은 방식, `fairness.ts`), ② 조건 차이 표에 「오류 집계 규칙」 행을 규칙이 다를 때만 더하며(§6 글), ③ 카드 아래 알림 줄은 그대로 둔다.

### 4.7 에디터·안내 화면 — ②b

- **R18 「응답 검증」 구획.** 목업 1–3이 기준이다.
  - 세 방식 단추(「400 이상은 오류」·「적은 코드만 통과」·「보지 않음」)와 방식별 본문을 둔다. `Segmented`에 작은 크기 변형(`size="sm"`)을 더한다.
  - 「적은 코드만 통과」로 바꾸면 200이 하나 들어간다. 마지막 코드를 빼면 기본으로 돌아간다(`assert: []`). 편집 중에 겹치는 코드는 하나만 남긴다. 100–599 밖이면 「추가」를 누를 수 없다.
  - 머리 덧글: 기본 = 없음. 코드 = 「200, 409만 통과」(셋 이상이면 「200, 201 외 N개만 통과」). 보지 않음 = 주의색 「상태 코드를 보지 않음」.
  - 검사 줄이 둘 이상이면 단추 묶음 대신 알림과 「한 줄로 합치기」를 보인다(목업 3). 합치기는 모든 코드 줄의 코드를 합친 목록 한 줄을 만든다(지금 master 에디터의 「추가」가 코드마다 줄을 하나씩 더해서 생긴 여러 줄 — 그 사람의 뜻은 「이 가운데 하나면 통과」다). `any`가 섞였으면 `any`를 뺀다. 전부 `any`면 `any` 한 줄이다. 알림은 지금 무엇이 통과하는지를 사실대로 말하고, 단추 글은 합친 결과를 말한다(§6). 화면은 여러 줄을 새로 만들지 않는다(사용자 결정 2026-11-24 — 여러 줄은 읽기만 하고, 쓰기는 한 줄뿐).
- **R27 새 스텝은 검사 없이.** `defaultHttpStepNode`와 loop·if·parallel 뼈대 열 곳에서 `assert: [{ status: 200 }]`을 뺀다. 템플릿 갤러리(`templates.ts`)·스텝 템플릿 저장본·HAR 가져오기 「캡처된 상태 코드로 검증 추가」는 그대로다.
- **R20 스텝 목록 칩.** 목업 4다. 기본 = 칩 없음. 코드 = 「검증 200·409」(셋 이상이면 「검증 200 외 N」). 보지 않음 = 주의색 「상태 코드 안 봄」.
- **R21 이유 글.**
  - 목업 5다. 스텝 오류 글이 R9의 기본 규칙 모양(`status N (>= 400)`)이면 그 위에 설명을 보인다. 글: 「상태 코드 N을 받아 오류로 셌습니다. 검사를 따로 적지 않은 스텝은 400 이상을 오류로 봅니다. N이 정상이면 「응답 검증」에서 기대하는 코드에 N을 넣으세요.」
  - 판별은 `ui/src/scenario/`의 도우미 하나가 오류 글로 한다. 스텝 모델이나 와이어는 필요 없다.
  - 미리 실행(`TestRunPanel`)·모니터 미리보기(`PreviewResult`)·점검 기록(`CheckRecordDialog`) 세 곳이 이 도우미를 쓴다.
- **R22 신뢰도 점검 A.**
  - 실패 조건은 「`any`뿐인 http 스텝이 있음」이다. 글은 목업 6이다.
  - `noValidationAtAll`은 「http 스텝이 모두 `any`」다. 기본 스텝만 있는 시나리오는 점검 A 통과다.
  - 지문(`trustPrefs`)에 규칙 번호 상수를 넣는다. 그래서 모든 시나리오의 「미리 실행 확인됨」이 한 번 풀린다. 규칙이 바뀌었으니 다시 돌려 봐야 같은 결과인지 안다.
- **R28 인쇄 비교의 검사 차이는 검사 방식으로 견준다** (사용자 결정 2026-11-24 — ②a 라이브 뒤 정정. 「비었는지」로 견주면 검사 없음 → `any`가 「검사 추가됨」으로 나와, 실제로는 4xx·5xx를 그만 세어 오류율이 내려간 것을 「검사를 강화했다」로 잘못 설명한다).
  - 스텝마다 방식을 셋으로 나눈다: 검사 줄 없음 = 「400 이상은 오류」, 코드 줄이 하나라도 있음(`any` 줄이 섞여도) = 「적은 코드만 통과」, 줄이 모두 `any` = 「보지 않음」. 이름은 R18 방식 단추와 같다.
  - 방식이 다르면 「`${no}의 상태 코드 검사 방식 바뀜: 앞 → 뒤`」, 둘 다 「적은 코드만 통과」이고 코드 줄들(`any` 줄은 건너뜀 — 줄 순서와 줄 안의 코드 순서는 무관)이 다르면 「`${no}의 기대 코드 바뀜: 200 → 200·409`」, 같으면 줄을 내지 않는다. 줄 단위로 견주는 이유: 코드 줄 `[200]`·`[201]` 두 줄(항상 실패)과 `[200, 201]` 한 줄(둘 중 하나면 통과)은 코드 모음이 같아도 판정이 다르다(②b plan 검토에서 정정, 2026-11-24 — 옛 글 「코드 집합」). `${no}`는 인쇄 단계 번호(①·②…)다.
  - 두 run이 모두 규칙 1이면 지금 글(「추가됨·제거됨·바뀜」)을 그대로 쓴다(R13).
  - 규칙 1 run과 규칙 2 run을 견줄 때 두 run의 방식이 모두 「검사 없음」이면 줄을 내지 않는다(같은 시나리오에서 판정만 달라진 것은 R26 알림이 말한다). 규칙 1 run의 검사 없음은 「400 이상은 오류」가 아니므로 이 경우의 앞 방식 이름은 「검사 없음」이다.

## 5. 기존 사용자가 겪는 변화 (릴리즈 노트에 적는다)

1. 검사 없는 스텝이 4xx·5xx를 받던 시나리오는 다음 실행부터 오류율이 오른다. 끝난 run은 그대로다. 예약 실행·프리셋 실행도 같다.
2. **검사 없는 스텝이 4xx·5xx를 받으면 추출을 건너뛴다.** 그 값을 다음 스텝이 쓰면 그 VU가 멈춘다. 모든 VU가 멈추면 run이 실패한다. 예를 들어 로그인 스텝이 부하 중 가끔 401·429·503을 내는 경우다. 대처는 셋이다: 기대 코드를 적거나, 추출 기본값을 두거나, 「보지 않음」을 고른다.
3. 검사 없는 **준비 스텝**이 4xx·5xx를 받으면 준비 실패가 되어 그 VU는 본 스텝을 돌지 않는다.
4. 조건 반복으로 「준비될 때까지 404」를 기다리던 흐름은 그 스텝에 `status: [200, 404]`를 적는다.
5. 운영 모니터 보드: 검사 없는 점검 스텝이 4xx·5xx를 받으면 칸이 실패로 바뀐다. 칸 조건으로 「상태 코드 = 404」를 걸어 둔 보드는 시나리오 스텝에도 404를 적어야 한다.
6. 에디터에서 새로 만든 스텝은 상태 코드 검사 없이 시작한다. 201·204·302도 통과다.
7. 신뢰도 「미리 실행 확인됨」 표시가 모든 시나리오에서 한 번 풀린다.
8. LAN 부하기(풀 워커·데스크톱 부하기 모드)는 컨트롤러와 **같은 판**으로 올린다. 옛 판 부하기는 옛 규칙으로 돌고, 목록·`any` 표기를 읽지 못해 그 run이 실패한다.
9. 옛 판 handicap은 목록·`any` 표기가 든 시나리오 YAML·보드 파일을 읽지 못한다(시나리오 읽기 오류).

## 6. 화면에 보이는 글 (정본 — `ko.ts`로 간다)

| 자리 | 글 | 슬라이스 |
|---|---|---|
| 유효성 `status_unchecked_errors` | 상태 코드를 보지 않는 스텝 「<이름>」이 4xx·5xx 응답 N건을 받았습니다. 상태 코드로는 오류로 세지 않았습니다 | ②a |
| 유효성 `no_response_validation` (규칙 2 run만 — 규칙 1은 지금 글) | 상태 코드 검사와 판정 기준이 없어 성공·실패를 확정할 수 없습니다 | ②a |
| 해석 `unchecked_steps_error_free` | 상태 코드를 보지 않는 스텝이 정상 응답했다 | ②a |
| 준비 실패 종류 `http_status` | 상태 코드 400 이상 | ②a |
| 인쇄 `any` 스텝 제외 글 | 상태 코드를 보지 않도록 정한 단계라 오류에서 제외됐습니다 | ②a |
| 비교 알림 (②a 글 — ②b에서 아래 줄로 바꾼다) | 두 run이 오류를 세는 규칙이 다릅니다. 한쪽은 상태 코드 검사가 없는 스텝의 4xx·5xx를 오류로 세지 않았습니다 — 오류율을 그대로 견주지 마세요. | ②a |
| 비교 알림 (사용자 결정 2026-11-24) | 선택한 run 가운데 오류를 세는 규칙이 다른 run이 있습니다. 이 변경 전에 실행한 run은 상태 코드 검사가 없는 스텝의 4xx·5xx를 오류로 세지 않았습니다 — 오류율을 그대로 견주지 마세요. | ②b |
| 인쇄 비교 검사 방식 차이 (R28) | `${no}의 상태 코드 검사 방식 바뀜: <앞 방식> → <뒤 방식>` — 방식 이름은 「400 이상은 오류」·「적은 코드만 통과」·「보지 않음」 | ②b |
| 인쇄 비교 「다른 조건」 이름 (R26 보강 — 보고서 라벨은 「오류 집계 규칙」, 사용자 결정 2026-11-24. 알림 문장의 「오류를 세는 규칙」은 그대로) | 오류 집계 규칙 | ②b |
| 인쇄 비교 조건 차이 표 행 (R26 보강, 규칙이 다를 때만) | 행 이름 「오류 집계 규칙」 · 칸 「검사 없는 스텝은 모두 통과」(규칙 1) / 「검사 없는 스텝은 400 이상이 오류」(규칙 2) | ②b |
| 인쇄 비교 기대 코드 차이 (R28) | `${no}의 기대 코드 바뀜: 200 → 200·409` (코드는 `·`로 잇는다) | ②b |
| 임시 검사 줄 | 200·409 / 보지 않음 | ②a |
| 방식 단추 | 400 이상은 오류 / 적은 코드만 통과 / 보지 않음 | ②b |
| 방식 단추 묶음 이름(aria) | 상태 코드 검사 방식 | ②b |
| 기본 안내 | 따로 적지 않아도 400 이상(4xx·5xx) 응답은 오류로 셉니다. 399까지는 통과입니다. | ②b |
| 코드 안내 | 적은 코드 가운데 하나를 받으면 통과입니다. 그 밖의 코드는 오류로 셉니다. | ②b |
| 보지 않음 안내 | 이 스텝은 어떤 상태 코드를 받아도 오류로 세지 않습니다. 4xx·5xx를 받으면 리포트가 따로 알려 줍니다. | ②b |
| 코드 빼기(aria) | N 빼기 | ②b |
| 여러 줄 알림 (사용자 결정 2026-11-24 — 옛 조건 「줄의 코드가 모두 같으면 합칠 수 있다」는 `[200, 409]`/`[200]`처럼 200이면 통과하는 스텝을 「항상 실패」로 말했다) | 앞머리는 늘 「상태 코드 검사가 K줄입니다(a / b).」 뒤에 셋 가운데 하나: 모든 코드 줄에 함께 든 코드가 없으면 「줄을 모두 만족해야 통과라서 이 스텝은 항상 실패합니다.」(붉은색) · 있으면 「지금은 c만 통과합니다.」(주의색, c = 함께 든 코드를 `, `로 이음) · 코드 줄이 없으면(`any` 줄뿐) 「지금은 상태 코드를 보지 않습니다.」(주의색) | ②b |
| 합치기 단추 | 합친 결과(모든 코드 줄의 코드를 합친 한 줄)를 말한다. 코드 2개 이상: 「a, b 가운데 하나면 통과」로 합치기 · 코드 1개: 「a만 통과」로 합치기 · `any`: 「보지 않음」 한 줄로 합치기 | ②b |
| 신뢰도 A 실패 제목 / 이유 | 상태 코드를 보지 않는 스텝이 있습니다 / 이 스텝은 4xx·5xx가 와도 실패로 잡히지 않습니다 | ②b |
| 신뢰도 A 통과 | 모든 스텝이 오류 응답을 실패로 잡습니다 | ②b |

미리 실행 이유 글(R21)과 표본 설명(R23)은 본문에 적은 대로다.

## 7. 건드리는 곳·건드리지 않는 곳

- **②a**
  - **엔진**: `scenario.rs`(`Assertion` 표기·serde), `executor.rs`(`judge_status`·`status_unchecked`·두 경로·`ErrorClass::HttpStatus`), `section.rs`(`KIND_HTTP_STATUS`·종류 목록), `lib.rs` 공개.
  - **컨트롤러**: `store/mod.rs`·`store/runs.rs`(0029·insert·SELECT 두 곳), `report.rs`(`ReportRun.status_rule`·`derive_validity` 인자), `validity.rs`, `insights.rs`(`http_step_has_status_assert` 곁의 판별), `monitor/check.rs`.
  - **화면**: `api/schemas.ts`(`ReportRunSchema`·사유), `report/ReportView.tsx`(스텝 이름표 전달), `scenario/model.ts`·`yamlDoc.ts`·`store.ts`, `Inspector.tsx`(임시 `AssertEditor`), `FlowOutline.tsx`(칩이 새 모델을 읽게만), `trust.ts`·`trustPrefs.ts`(새 모델을 읽게만 — 판정 변경은 ②b), `report/ValidityBanner.tsx`·표본 설명, `print/scenarioFacts.ts`·`stepTable.ts`와 그 소비처·`compare/fairness.ts`, `compare/`(새 알림), `i18n/ko.ts`.
- **②b**: `Inspector.tsx`(R18), `ui/Segmented.tsx`, `FlowOutline.tsx`(R20), `yamlDoc.ts`(R27), `trust.ts`·`trustPrefs.ts`·`TrustBoard`(R22), `TestRunPanel.tsx`·`monitor/PreviewResult.tsx`·`monitor/CheckRecordDialog.tsx`(R21), `i18n/ko.ts`.
- **안 건드림**: proto(시나리오는 YAML 글자로 간다), 워커 코드, TUI 코드, CSV/XLSX 내보내기 코드, 판정 기준(`Criteria`), `monitor/conditions.ts`(칸 조건 — 스텝 검사와 무관), 템플릿 갤러리, HAR 가져오기.

## 8. 검증

- **엔진 단위**
  - R1·R2 표기 round-trip: 숫자 하나는 글자 그대로, `[200]` → `200`, 빈 목록·모르는 글자는 오류.
  - 속성 테스트: `crates/engine/tests/proptests.rs`의 검사 생성기(지금 `prop_map(Assertion::Status)`)에 목록·`any`를 더해 시나리오 round-trip이 새 표기도 덮게 한다.
  - `judge_status` 판정 표: 검사 없음 × 200·302·399·400·404·500, 숫자 하나, 목록, `any`, 여러 줄, `any` + 코드.
  - 두 경로가 같은 표를 통과한다. 오류면 추출하지 않는다. 준비 구간 종류는 `http_status`다.
  - 기본 규칙 오류 글을 고정한다(R9 계약).
- **기존 테스트 정리(②a)**: wiremock은 짝이 없으면 404를 준다. 그래서 검사 없는 스텝 + 일부 경로만 mock한 테스트와 일부러 4xx·5xx를 낸 테스트의 뜻이 바뀐다.
  - 대상은 `grep -rnE 'ResponseTemplate::new\((4|5)[0-9][0-9]\)' crates` 8곳(`engine/tests/{assertions,setup_steps,trace_rows,trace_setup_followups}.rs`, `section.rs:653`, `tui/tests/{check_mode,record}_test.rs`)과 `engine/tests/setup_steps.rs`의 `cause.contains("status_assert")`다. 짝 없는 경로를 쓰는 테스트는 plan 작성 때 전수 grep으로 찾는다.
  - 각 테스트를 「규칙 2로 기대를 고친다」 또는 「`any`를 적어 옛 뜻을 지킨다」로 판정한다.
  - `crates/tui/tests/judge_parity_test.rs`(`ko.ts` 글 대조)도 확인한다.
- **컨트롤러**
  - `status_rule = 1` 리포트 불변: 기존 유효성 테스트가 규칙 1로 그대로 통과한다. 되돌려 확인으로 규칙 갈래를 지우면 RED가 나와야 한다. 이 확인은 `http_step_has_status_assert`도 덮는다 — 그 함수를 `!status_unchecked(..)`로 바꾸면 `no_response_validation_when_no_assert_no_criteria`가 RED다.
  - R14–R16, 범위 적용: 유지 구간 리포트의 R14 수가 범위 안 수와 같다.
  - 0029 멱등, `insert`가 2를 적는지, golden 역직렬화.
- **화면**
  - ②a: 모델 ↔ YAML 변환(손대지 않은 스텝은 글자 그대로), 인쇄 판정표(규칙 1 = 지금 결과, 규칙 2 = §4.6 표), 비교 알림, 새 유효성 글.
  - ②b: 방식 전환, 합치기, 칩, 신뢰도 진리표, 이유 글 도우미(엔진과 같은 글 픽스처), 새 스텝에 `assert`가 없음.
- **성능**: `/perf-ab master` — 검사 없는 스텝 시나리오로 요청당 CPU를 잰다.
- **보안**: 오류 글에는 상태 코드와 적힌 코드만 싣는다(주소·본문 없음). `finish-slice` §0 grep을 돌린다.
- **라이브** — 엔진 변경이라 빌드 뒤 `cargo build -p handicap-worker`가 필수다. 미리 옛 바이너리로 run을 하나 만들어 둔 DB(규칙 1 run)를 쓴다.

| 슬라이스 | US | 절차 | 통과 신호 |
|---|---|---|---|
| ②a | US1 | 검사 없는 스텝 1개, 대상이 500, 오류율 기준을 건 run | 오류 수 = 요청 수, 판정 실패. 인쇄 보고서도 그 스텝을 오류로 센다. 옛 run(규칙 1)의 화면·인쇄 리포트는 숫자·글이 그대로다. |
| ②a | US1 변형 | 로그인(검사 없음, 401) → 다음 스텝이 추출 값 사용 | §5-2대로 VU가 멈추고 run 상태·메시지가 그 사실을 말한다(실측해 적는다). |
| ②a | US2 | YAML `status: [200, 409]`, 대상이 200·409·500 섞음 | 오류 수 = 500의 수. 409 응답에서 추출한 값을 다음 스텝이 쓴다. |
| ②a | US3(리포트) | YAML `status: any`, 대상이 404 | 오류 0. 유효성 띠에 R14 글과 스텝 이름. 비교에서 규칙 1 run과 견주면 알림이 뜬다. |
| ②a | US5 | 보드의 점검 스텝(검사 없음)이 503 | GUI 칸 실패·사유 「HTTP 503」. `handicap-tui`도 같다. 칸 그리기를 바꾸지 않으므로 칸 1–9 전수 검증은 하지 않고 근거를 build-log에 적는다. |
| ②b | US2·US3 | 에디터에서 방식 전환·코드 추가·보지 않음 → 저장 → 다시 열기 | YAML과 구획이 목업 1과 같고, 다시 열어도 같다. |
| ②b | US4 | 미리 실행(검사 없음 + 404) · 모니터 미리보기 · 점검 기록 · 신뢰도 판 | 세 화면에 이유 글이 나오고, 점검 A 글이 목업 6과 같다. |

- **②b 극단값**: 코드 12개(목업 2)·긴 스텝 이름·여러 줄 알림에서 구획·칩·알림의 겹침과 잘림을 실측한다. 「응답 검증」 구획이 마운트되는 모든 진입 화면에서 확인한다: 새 시나리오, 저장된 시나리오 편집, 준비 스텝, if·loop·parallel 안 스텝, 스텝 템플릿에서 넣은 스텝.

## 9. 사실 주장과 확인 명령

| 주장 | 명령 |
|---|---|
| 엔진의 상태 코드 판정 두 곳 | `grep -n "Assertion::Status(want)" crates/engine/src/executor.rs` |
| Rust에서 `Assertion::Status`를 읽는 곳 전부 | `grep -rn "Assertion::Status" crates` |
| `ErrorClass`를 읽는 곳(엔진뿐) | `grep -rn "ErrorClass::" crates` |
| 유효성의 두 사유 | `grep -n "silent_http_errors\|no_response_validation" crates/controller/src/validity.rs` |
| `derive_validity` 호출 한 곳 | `grep -rn "derive_validity(" crates/controller/src` |
| 화면에서 검사 표기·모델을 다루는 곳 전부 | 표 아래 명령 A (결과를 손으로 분류 — plan에 목록을 싣는다) |
| 인쇄 분류 | `grep -rn "classifyCell\|statusCodes" ui/src/print` |
| 새 스텝 기본 200 | `grep -n "status: 200" ui/src/scenario/yamlDoc.ts` |
| 컨트롤러↔워커 판 확인 없음 | `grep -n "version" crates/proto/proto/coordinator.proto` |
| `Segmented`에 크기 선택 없음 | `grep -nE "size\??:" ui/src/components/ui/Segmented.tsx` (0건) |
| `windows`는 범위 밖 행 포함 | `grep -n "그림용 창은 모든 행" crates/controller/src/report.rs` |
| TUI는 검사 모델을 읽지 않음 | `grep -rn "Assertion\|\.assert\b" crates/tui/src` |
| 마지막 마이그레이션 0028 | `grep -n "migration 0028" crates/controller/src/store/mod.rs` (1건) + `grep -c "migration 0029" crates/controller/src/store/mod.rs` (0) |
| `ReportRunSchema`는 strict | 표 아래 명령 B |
| 4xx·5xx를 일부러 내는 Rust 테스트 | 표 아래 명령 C (8곳) |
| 검사를 `_`·`matches!`로 읽는 자리 (바꾼 뒤 남는 것: serde·두 함수·`insights.rs` `http_step_has_status_assert`·테스트) | `grep -rn "Assertion::Status" crates/*/src` |

표 안에서는 `|`를 이스케이프해야 해서 아래 명령은 표 밖에 둔다. 그대로 복사해 쓴다.

```bash
# A
grep -rnE "assert|status:? *200|statusCodes" ui/src --include='*.ts' --include='*.tsx' | grep -v __tests__
# B
grep -n "ReportRunSchema" -A20 ui/src/api/schemas.ts | grep strict
# C
grep -rnE 'ResponseTemplate::new\((4|5)[0-9][0-9]\)' crates
```

## 10. 슬라이스 나누기

- **②a 판정**: §4.1–§4.6 (R1–R17, R19, R23–R26). 엔진 규칙이 바뀌는 순간 리포트·인쇄·비교가 사실대로 말해야 하므로 한 슬라이스에 묶는다. 에디터는 새 표기를 읽고 깨지지 않는 데까지만 한다(R19 임시 모양).
- **②b 에디터·안내**: §4.7 (R18, R20–R22, R27, R28) + R26 비교 알림 글 바꾸기(§6). ②a 위에서 한다.
- ②a ↔ ②b 사이에도 릴리즈하지 않는다(①~④ 규칙 안).

## 11. 작성자 판단 (사용자 확인 대상)

1. 「보지 않음」의 YAML 표기는 `status: any`다.
2. 3xx는 통과다(399까지). 엔진은 넘겨받기(redirect)를 reqwest 기본으로 따라가므로 3xx가 남는 일은 드물다.
3. 기본 규칙을 끄는 전역 설정을 두지 않는다(§3 나).
4. 검사 줄이 여럿인 YAML의 뜻(모두 만족)은 바꾸지 않고, 화면이 알린다.
5. 「보지 않음」 스텝이 있으면 신뢰도 점검 A는 실패(「보완 필요」)다. 일부러 고른 경우에도 남는다.
6. 준비 구간의 새 실패 종류 이름은 `http_status`, 글은 「상태 코드 400 이상」이다.
7. 옛 run을 가리는 방법은 `runs.status_rule` 칸이다. `profile_json` 안의 필드는 기각했다. 다시 실행 미리 채우기와 프리셋이 옛 run의 `profile`을 복사해서 새 run에 1이 실려 가기 때문이다.
8. 「적은 코드만 통과」를 처음 고르면 200이 들어간다.
9. `status_unchecked_errors`는 스텝마다 사유 하나다(`step_id` 칸을 쓴다).
10. 이유 글(R21)은 오류 글 모양으로 판별한다. 오류 글을 엔진·화면 테스트가 함께 고정하는 계약으로 삼는다.
11. 신뢰도 「미리 실행 확인됨」은 한 번 모두 풀린다(§5-7).
12. ②a ↔ ②b로 나눈다(검토 권고).

## 12. 검토 지적 처리

- **1차(NEEDS-REWORK)**: 아래 열한 건을 반영했다. 기각은 없다.
  1. §3 다·§1.1을 사실대로 고쳤다(기본 200 삽입, 판정 네 곳). 새 스텝 기본은 사용자 결정으로 정했다(R27).
  2. 인쇄 분류 묶음을 범위에 넣었다(R25 판정표).
  3. §5-2에 VU가 멈추는 경우를 넣고, 라이브에 US1 변형을 더했다.
  4. R14의 원천을 범위가 적용된 `steps[]`와 `setup.steps[]`로 바꿨다. 스텝마다 사유를 하나씩 낸다(스텝 이름 모순 해소).
  5. R24를 공유 함수로 바꿨다(R7). R21의 원천을 오류 글로 정했다.
  6. `ReportRunSchema.strict()`·golden·`#[serde(default)]`·SELECT 두 곳을 R11·R12에 적었다.
  7. `trustPrefs` 지문을 R22에 넣었다.
  8. 기존 테스트 정리를 §8에 넣었다.
  9. §9 명령을 전수 grep으로 바꿨다.
  10. `[200,200]`·빈 목록·XLSX 내용·비교 알림 자리를 정했다.
  11. 슬라이스를 둘로 나눴다.
- **2차(APPROVE-WITH-FIXES)**: 일곱 건을 모두 반영했다. 기각은 없다.
  1. serde `default`를 함수 경로와 상수로 바꿨다(R12).
  2. ValidityBanner가 받을 스텝 이름표를 `ReportView`가 넘긴다(§4.5·§7).
  3. R14 글을 「상태 코드로는 오류로 세지 않았습니다」로 바꿨다(추출 실패는 오류로 셀 수 있다).
  4. 엔진 모양을 `Status(StatusExpect)`로 정했다. 두 함수는 전수 match이고, 옛 `_`·`matches!` 자리를 모두 바꾼다(R7). proptests를 §8에 넣었다.
  5. R25 표에 「`any` 줄은 건너뛴다」를 넣고, `status_unchecked` 정의를 적었다.
  6. §9 명령을 표 밖으로 옮기고 따옴표를 붙였다.
  7. 줄 번호(325·726)와 마이그레이션 확인 명령을 고쳤다.
- **3차(APPROVE-WITH-FIXES)**: 한 건을 반영했다. `insights.rs:747`(규칙 1 전용 「검사 줄 있음」)은 두 함수로 바꾸지 않는 예외로 두었다(처방 a). §8 되돌려 확인이 이 자리도 덮는다고 적었다.
- **4차: clean APPROVE.**
- **②a plan 검토에서 고친 것(2026-11-24)**: R16의 글을 규칙 2 run에만 쓰도록 바꿨다. 「두 규칙에 다 맞게 고친다」가 R13·「하면 안 되는 것」①(옛 run 글 불변)과 부딪쳤기 때문이다.
- **②a 구현 뒤 사용자 결정(2026-11-24)**: ① 인쇄 비교의 검사 차이를 검사 방식으로 견준다(R28 신설 — 「비었는지」 규칙은 검사 없음 → `any`를 「검사 추가됨」으로 잘못 말했다). ② 비교 알림 글을 「선택한 run 가운데 …」로(화면 비교는 run을 여럿 보인다). ③ 인쇄 `any` 스텝 글에 「검사를 추가하길 권합니다」를 넣지 않는 것을 확인. ④ 인쇄 비교에서 규칙 차이를 「다른 조건」 목록과 조건 차이 표에도 넣는다(R26 보강 — ②a는 알림 줄만이라 머리말이 규칙 차이를 빠뜨렸다). ⑤ 리포트 `status_rule`의 Zod `.optional()`(plan 판단)은 그대로 둔다. ①·②·④는 ②b에서 구현한다.
- **②b plan 작성·검토에서 고친 것(2026-11-24)**: ① 화면은 상태 코드 검사를 한 줄로만 쓴다(사용자 결정). 여러 줄은 지금 master 에디터의 「추가」가 만든 기존 시나리오를 읽을 때만 나오고, 알림 + 합치기 하나로 다룬다(R18). ② 여러 줄 알림이 지금 무엇이 통과하는지 사실대로 말한다(§6 — 옛 조건은 200이면 통과하는 스텝을 「항상 실패」로 말했다). ③ R28의 「코드 집합」을 줄 단위로 바꿨다(`[200]`·`[201]` 두 줄과 `[200, 201]` 한 줄은 판정이 다르다). 추가 목업 `2026-11-24-http-error-default-mockups/screens-b.html`(좁은 칸 줄바꿈·여러 줄 알림 갈래·인쇄 비교 보강)은 사용자 확인 대기다.

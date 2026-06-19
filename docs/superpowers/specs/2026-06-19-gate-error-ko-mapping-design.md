# 게이트-에러 한국어 매핑 — Zod 검증 배너의 미커버 문구류 한국어화 (영역 U / U4 연기 항목)

> 시나리오 에디터 검증 배너(ValidationBanner)의 게이트 에러 한국어 매핑(`problems.ts::formatSegment`)을 확장해, 현재 영어 원문 fallback으로 떨어지는 Zod 에러 클래스(discriminator·enum·`.strict()` unrecognized-key·container/string `min(1)`)를 한국어로 매핑한다. **순수 UI·추가 전용.**

- **날짜**: 2026-06-19
- **상태**: 설계 승인(사용자 2026-06-19, spec-plan-reviewer APPROVE 2라운드) → plan 대기
- **출처**: roadmap §"U4 연기 항목"(line 108) — "Zod discriminator-mismatch·`.strict()` `Unrecognized key(s)`·컨테이너 `min(1)` 문구류가 다음 매핑 후보". **왜 지금**: ko.common 롤업·editor-ux-polish로 영역 U가 거의 완결됐고, 배너의 영어 잔존이 이 게이트 매핑 클래스에 마지막으로 남아 있음(half-mapped 배너 해소).
- **연관**: 부모 spec `2026-06-11-ux-beginner-friendly-redesign-design.md`(§5.4 검증 배너), `2026-06-12-ux-u4-validation-banner-testrun.md`(U4 — 게이트 매핑 메커니즘 도입), `2026-06-19-editor-ux-polish-design.md`(직전 U4 후속), ADR-0035(UI 문구 한국어 통일 + `ko.ts` 카탈로그).
- **ADR**: 신규 불필요 — ADR-0035 범위 내 additive(기존 게이트 매핑 클래스 추가). editor-ux-polish 선례와 동일.

---

## 1. 문제와 목표

`problems.ts::formatSegment`는 `parseScenarioDoc`(ScenarioModel)가 낸 `path: message; …` 문자열을 세그먼트별로 한국어로 매핑하고, 알아보지 못한 문구는 영어 원문을 그대로 둔다(spec 허용 fallback). 현재 매핑되는 클래스는 5개(`Required`·name-required·invalid-literal·invalid-type·duplicate-branch)뿐이고, **흔한 사용자 에러 다수가 영어로 샌다**: 잘못된 `type`/body `kind`/extract `from` 값(discriminator), 잘못된 `method`/`cookie_jar` 값(enum), 추출·조건 객체의 여분 키(`.strict()` unrecognized), 빈 컨테이너(`do: []` 등)·빈 추출값(`var: ""`)의 `min(1)`. QA 사용자가 읽는 배너가 영어/한국어 혼재(half-mapped) 상태다.

- **목표**: 위 4클래스(+enum)를 한국어로 매핑하되, 기존 매핑 메커니즘(중앙 `formatSegment` → `ko.editor.*` 카탈로그, path 원문, 미지 문구 영어 fallback)을 그대로 따르고 구체값(허용 목록·문제 키 이름)을 노출한다. **Zod 버전 드리프트 시 silent 영어 강등 대신 테스트가 빨개지도록** 실-Zod 가드를 붙인다.
- **비목표(연기)**: §7 참조. 배너 경로에서 도달 불가한 문구(제네릭 array `min(1)`)·명명 범위 밖 클래스(think-time refine·ULID regex·JSON cast)는 영어 fallback 유지.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

> 실측 Zod 3.25.76 문구를 기준으로 한다(이 워크트리 `ui/node_modules/zod`에서 직접 캡처 — §3.1). 모든 한국어 렌더 문구는 **제안값**이며, plan에서 최종 자구를 확정한다(의미는 R가 고정).

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | `MUST` discriminator 세그먼트(`<path>: Invalid discriminator value. Expected 'a' \| 'b'`)를 `ko.editor.gateInvalidChoice(path, allowed)` → `${path}: 값이 올바르지 않습니다 (허용: a, b)`로 매핑 | `problems.test.ts` 손-세그먼트 + 실-Zod(잘못된 `type`) 테스트 | |
| R2 | `MUST` enum 세그먼트(`<path>: Invalid enum value. Expected 'A' \| 'B', received 'x'`)를 `ko.editor.gateInvalidChoiceReceived(path, allowed, received)` → `${path}: 값이 올바르지 않습니다 (허용: A, B, 입력 x)`로 매핑 | 손-세그먼트 + 실-Zod(잘못된 `method`) 테스트 | |
| R3 | `MUST` unrecognized-key 세그먼트(`<path>: Unrecognized key(s) in object: 'x', 'y'`)를 `ko.editor.gateUnknownKeys(path, keys)` → `${path}: 알 수 없는 항목이 있습니다 (x, y)`로 매핑. **path는 항상 non-empty** — normalize 허용리스트가 root/step/request/think_time의 여분 키를 제거하므로 unrecognized는 passthrough 사이트(`extract[]` 원소·`cond`·`request.disabled`)에서만 발생(§3.5) | 손-세그먼트(키 1개·2개) + 실-Zod(extract 원소 여분 키 → `steps.0.extract.0`) 테스트 | |
| R4 | `MUST` string `min(1)` 세그먼트(`<path>: String must contain at least 1 character(s)`)를 `ko.editor.gateEmptyValue(path)` → `${path}: 값이 비어 있습니다`로 매핑 | 손-세그먼트 + 실-Zod(빈 extract `var`) 테스트 | |
| R5 | `MUST` 시나리오 트리의 커스텀 `min(1)`/numeric 문구 6종(`loop body needs at least one step`·`if branch needs at least one step`·`elif branch needs at least one step`·`parallel needs at least one branch`·`branch needs at least one step`·`repeat must be >= 1`)을 각각 한국어로 매핑(아래 §4.2 자구) | 손-세그먼트 6 + 실-Zod(빈 `do`·`repeat: 0`) 테스트 | |
| R6 | `MUST` 구체값 정규화 `normalizeList(s)`: 단일따옴표 제거 + ` \| `→`, ` (예: `'http' \| 'loop'`→`http, loop`, `'x', 'y'`→`x, y`). R1/R2의 allowed, R2의 received, R3의 keys에 적용 | `normalizeList` 단위 테스트 + R1–R3 렌더 결과에 따옴표·파이프 부재 | |
| R7 | `MUST` 모든 신규 한국어 문구는 `ko.editor.gate*` 카탈로그 함수 경유(ADR-0035). `model.ts`의 Zod 스키마 커스텀 메시지는 **건드리지 않는다**(중앙 매핑 유지) | `git diff`에 `ui/src/scenario/model.ts` 0 diff; 신규 문구 전부 `ko.ts` | |
| R8 | `MUST` 기존 동작 보존: 기존 5개 매핑(Required·name-required·invalid-literal·invalid-type·duplicate-branch)·미지 세그먼트 영어 fallback·`; ` split·path 원문 렌더가 회귀 없음 | 기존 `problems.test.ts` 전부 green + 미지 문구 fallback 테스트 유지 | |
| R9 | `MUST` 각 신규 클래스(R1–R5)마다 **실-Zod 드리프트 가드** 테스트: 실 fixture를 `parseScenarioDoc`에 통과시켜 해당 코드(invalid_union_discriminator·invalid_enum_value·unrecognized_keys·too_small)를 트리거하고 `formatGateMessages(parsed.error)`가 한국어 키를 포함(`toContain`). Zod 마이너 범프로 문구가 바뀌면 이 테스트가 빨개짐 | 실-Zod 테스트 5클래스 + `pnpm test` green | |
| R10 | `MUST` 프로덕션 와이어 byte-identical / UI-only: 엔진·proto·migration·controller·API·`model.ts` Zod 스키마 무변경. 머지 diff = `ui/`(+docs)만 | `git diff --stat` 경로 검사 + `pnpm build` green | |

- **`seam?`** 전부 비어 있음 — 이 슬라이스는 **계약 경계를 건드리지 않는다**. 이미 존재하는 Zod 에러 *문자열의 표시 형식*만 바꾼다(스키마·API·proto 불변). 이게 R10의 핵심이고, 이 슬라이스가 라이브 검증 면제 대상인 근거(§6).

---

## 3. 핵심 통찰 (설계 근거)

### 3.1 실측 Zod 문구가 정규식의 단일 소스 (R1–R6, R9)
정규식은 Zod가 내는 **정확한 문자열**에 의존하므로 추측 금지 — 이 워크트리 `ui/node_modules/zod`(3.25.76)에서 직접 캡처한 값을 기준으로 한다:

| 클래스 | Zod code | 실측 message | path 특이점 |
|---|---|---|---|
| discriminator | `invalid_union_discriminator` | `Invalid discriminator value. Expected 'http' \| 'loop' \| 'if' \| 'parallel'` | 객체 path + discriminator 키 (예: `steps.0.type`) |
| enum | `invalid_enum_value` | `Invalid enum value. Expected 'GET' \| 'POST' \| 'PUT', received 'foo'` | 필드 path (예: `steps.0.request.method`) |
| unrecognized | `unrecognized_keys` | `Unrecognized key(s) in object: 'bogus', 'other'` | 객체 path, **항상 non-empty**(도달 사이트 = passthrough만, §3.5) |
| string min | `too_small` | `String must contain at least 1 character(s)` | 필드 path (예: `steps.0.extract.0.var`) |
| array min(커스텀) | `too_small` | 커스텀 문구 **그대로**(`loop body needs at least one step` 등) | 컨테이너 path |
| num min(커스텀) | `too_small` | `repeat must be >= 1` | 필드 path |

`; ` split 안전성: 위 문구 모두 `; ` 미포함(discriminator=`. `·` \| `, unrecognized=`, `) → 기존 split-then-map 그대로 안전(R8). 정규식 캡처값(allowed/keys)은 `' | '`/`', '` 구분이라 `normalizeList`로 한 번에 정규화(R6).

### 3.2 model.ts를 안 건드리고 중앙 매핑하는 이유 (R7)
커스텀 `min(1)` 문구(`loop body needs…` 등)는 우리가 소유한 `model.ts` 리터럴이다. 두 선택지 — (a) `model.ts`에서 직접 한국어화 vs (b) `formatSegment`에서 영어 원문→한국어 매핑. **(b)를 택한다**: ADR-0035가 "UI 문구는 `ko.ts` 카탈로그 단일 소스"를 요구하고, 제네릭 Zod 기본 문구(`String must contain…`)는 어차피 우리가 소유하지 않아 매핑이 필수다 — 두 경로를 섞으면 한국어가 두 파일에 흩어진다. 매핑을 `formatSegment` 한 곳에 모으고 `ko.ts`로 통일(R7)하면 일관되고, `model.ts`는 0 diff(R10)다. 트레이드오프: `model.ts` 자구가 바뀌면 매핑이 빗나갈 수 있으나 — 그래서 R9 실-Zod 가드가 그 드리프트를 빨갛게 잡는다(silent 영어 fallback 강등 방지).

### 3.3 구체값 노출 = 더 실행가능 (R1–R3, R6)
배너는 YAML 편집을 유도하는 용도다. discriminator/enum의 **허용값 목록**과 unrecognized의 **문제 키 이름**을 노출하면 사용자가 무엇을 고쳐야 할지 바로 안다. 노출값은 사용자 자신의 입력(키 이름)이거나 스키마 상수(허용값)라 민감정보가 아니다. enum은 `received`까지 포함해 "무엇을 입력했고 무엇이 허용되는지" 둘 다 보여준다(기존 `gateInvalidType`과 같은 형식).

### 3.4 정규식 충돌 부재 (R1, R2, R8)
신규 정규식이 기존과 충돌하지 않음을 확인: enum `… : Invalid enum value. Expected X, received Y`는 기존 invalid-type `/^(.+): Expected (.+), received (.+)$/`에 매치되지 않는다(`: Expected ` 부분문자열 부재 — 콜론 뒤는 ` Invalid`). discriminator `Invalid discriminator value. Expected`는 invalid-literal `Invalid literal value, expected`와 어휘가 다르다. plan은 신규 패턴을 더 구체적인 것부터 배치하고, 충돌 부재를 테스트로 고정한다.

### 3.5 normalize 허용리스트가 unrecognized 도달 사이트를 제한한다 (R3, R9) ⟵ spec-plan-reviewer 검증
`parseScenarioDoc`는 Zod 전에 `normalizeForModel`/`normalizeStep`/`normalizeRequest`(`yamlDoc.ts:526-624`)를 돌리는데, 이들이 객체를 **고정 키 허용리스트로 재구성**한다(예: `normalizeForModel`은 `version/name/cookie_jar/variables/steps`만, `normalizeStep`(http)은 `id/name/type/request/assert/extract/…`만). 따라서 **root·step·request·think_time의 여분 키는 Zod에 닿기 전 제거**되고 그 레벨에선 `unrecognized_keys`가 절대 안 난다(reviewer가 실 파이프라인으로 확인: root `bogus_key` → 에러 없이 PARSE-OK). unrecognized가 실제 도달하는 곳은 normalize가 **그대로 통과시키는 passthrough 필드**뿐이다:
- `extract[]` 원소(`yamlDoc.ts:575` verbatim) → `steps.0.extract.0: Unrecognized key(s)…` ✅
- `cond`(`yamlDoc.ts:556` passthrough) → `steps.0.cond: Unrecognized key(s)…` ✅
- `request.disabled`(`yamlDoc.ts:613` passthrough) → `steps.0.request.disabled: Unrecognized key(s)…` ✅

세 사이트 모두 path가 **non-empty**다 → 최상위 빈-path 케이스는 **구조상 도달 불가**이므로 매핑/테스트에서 다루지 않는다(empty-path 분기·`(.*)` 불필요, 정규식은 다른 클래스와 동일하게 `(.+)`). R9 unrecognized fixture는 사용자-개연성이 가장 높은 **extract 원소 여분 키**를 쓴다.

---

## 4. 변경 상세

> 변경 파일은 단 3개: `ui/src/scenario/problems.ts`(매핑+정규화), `ui/src/i18n/ko.ts`(신규 게이트 키), `ui/src/scenario/__tests__/problems.test.ts`(테스트).

### 4.1 `ui/src/scenario/problems.ts` — 충족 R: R1–R6, R8
`formatSegment`에 신규 정규식 분기 추가(기존 분기 위/아래 배치는 §3.4 충돌부재 전제, 더 구체적인 패턴 우선). 신규 `normalizeList(s: string): string` 헬퍼(`s.replace(/'/g, "").replace(/ \| /g, ", ")`) 추가, R1/R2/R3 캡처값에 적용.

- discriminator: `/^(.+): Invalid discriminator value\. Expected (.+)$/` → `ko.editor.gateInvalidChoice(m[1], normalizeList(m[2]))`
- enum: `/^(.+): Invalid enum value\. Expected (.+), received (.+)$/` → `ko.editor.gateInvalidChoiceReceived(m[1], normalizeList(m[2]), normalizeList(m[3]))`
- unrecognized: `/^(.+): Unrecognized key\(s\) in object: (.+)$/` → `ko.editor.gateUnknownKeys(m[1], normalizeList(m[2]))` (도달 path 전부 non-empty, §3.5 — empty-path 분기 없음)
- string min: `/^(.+): String must contain at least 1 character\(s\)$/` → `ko.editor.gateEmptyValue(m[1])`
- 커스텀 6종: 정확-매치 정규식(또는 `path`/`message` 1회 분리 후 message 룩업) → 각 ko 키. 구현 형태(개별 정규식 vs 작은 룩업 테이블)는 plan에서 가독성 기준 선택.

### 4.2 `ui/src/i18n/ko.ts` — 충족 R: R1–R5, R7
`editor` 블록의 게이트 키 군(`gateRequired` 인근)에 신규 함수 추가(**자구 제안 — plan 확정**):
- `gateInvalidChoice: (path, allowed) => \`${path}: 값이 올바르지 않습니다 (허용: ${allowed})\``
- `gateInvalidChoiceReceived: (path, allowed, received) => \`${path}: 값이 올바르지 않습니다 (허용: ${allowed}, 입력 ${received})\``
- `gateUnknownKeys: (path, keys) => \`${path}: 알 수 없는 항목이 있습니다 (${keys})\`` (path 항상 non-empty, §3.5)
- `gateEmptyValue: (path) => \`${path}: 값이 비어 있습니다\``
- `gateLoopBodyMin: (path) => \`${path}: 루프 본문에 스텝이 최소 1개 필요합니다\``
- `gateIfBranchMin: (path) => \`${path}: if 분기에 스텝이 최소 1개 필요합니다\``
- `gateElifBranchMin: (path) => \`${path}: elif 분기에 스텝이 최소 1개 필요합니다\``
- `gateParallelBranchesMin: (path) => \`${path}: parallel 노드에 분기가 최소 1개 필요합니다\``
- `gateBranchStepsMin: (path) => \`${path}: 분기에 스텝이 최소 1개 필요합니다\``
- `gateRepeatMin: (path) => \`${path}: 반복 횟수는 1 이상이어야 합니다\``

### 4.3 `ui/src/scenario/__tests__/problems.test.ts` — 충족 R: R1–R6, R8, R9
- `formatGateMessages — Zod 원문 → 한국어 매핑` describe에 손-세그먼트 케이스 추가(신규 클래스 각각; unrecognized는 키 1개·2개 — empty-path는 §3.5로 도달 불가라 다루지 않음).
- `normalizeList` 단위 테스트(R6).
- 신규 describe `실-Zod 드리프트 가드 — 신규 클래스`: 각 클래스를 트리거하는 fixture를 `parseScenarioDoc`로 파싱→`formatGateMessages(parsed.error)`가 한국어 키 `toContain`. **fixture가 내는 실제 path는 구현 시 `parseScenarioDoc` 출력에서 캡처**(정규식은 path-agnostic `(.+)`라 매치엔 무관, 테스트 기대 문자열에만 실제 path 필요). **클래스별 트리거(reviewer 실-파이프라인 검증)**: discriminator=`type: bogus`(`steps.0.type`) · enum=잘못된 `method`(`steps.0.request.method`) · unrecognized=**extract 원소** 여분 키(`steps.0.extract.0` — root/step/request 여분 키는 normalize가 제거해 도달 불가, §3.5) · string-min=빈 extract `var`(`steps.0.extract.0.var`) · 커스텀=빈 `do`(`steps.0.do`)·`repeat: 0`(`steps.0.repeat`).

---

## 5. 무변경 / 불변식 (명시)

- **엔진·controller·proto·migration·worker 무변경** — UI-only(R10).
- **`ui/src/scenario/model.ts` 0 diff** — Zod 스키마·커스텀 메시지 불변(R7). 따라서 API로 나가는 시나리오 YAML·서버 검증 의미론도 불변.
- **프로덕션 와이어 byte-identical** — 사용자에게 보이는 *배너 텍스트*만 변한다. 기존 5개 매핑·미지 fallback·`; ` split·path 원문은 회귀 없음(R8).
- **도달 불가 문구는 매핑하지 않는다** — 배너 경로(`parseScenarioDoc`/ScenarioModel)에서 안 나오는 문구에 죽은 매핑을 추가하지 않는다(§7).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | `formatGateMessages` discriminator 손-세그먼트 + 실-Zod(잘못된 `type`) | |
| R2 | enum 손-세그먼트 + 실-Zod(잘못된 `method`) | |
| R3 | unrecognized 손-세그먼트(키1·키2) + 실-Zod(extract 원소 여분 키 → `steps.0.extract.0`) | |
| R4 | string-min 손-세그먼트 + 실-Zod(빈 extract `var`) | |
| R5 | 커스텀 6종 손-세그먼트 + 실-Zod(빈 `do`·`repeat: 0`) | |
| R6 | `normalizeList` 단위 테스트 + R1–R3 렌더에 따옴표/파이프 부재 | |
| R7 | `git diff` model.ts 0 diff; 신규 문구 전부 ko.ts | |
| R8 | 기존 `problems.test.ts` 전부 green + 미지 fallback 유지 | |
| R9 | 실-Zod 5클래스 테스트(zod-bump→red) | |
| R10 | `git diff --stat` = ui/(+docs)만; `pnpm lint && pnpm test && pnpm build` green | |

- **라이브 검증 불요(면제)**: run-생성·응답-파싱·엔진 경로 무변경(R10). 변경은 클라이언트 Zod 에러의 표시 형식뿐이고 `parseScenarioDoc`를 실 Zod로 통과시키는 R9 테스트가 그 경로를 결정적으로 커버한다(S-D 갭은 서버 응답경로 버그용 — 여기 해당 없음). build-log에 면제 근거 기록.

---

## 7. 의도적 연기 (roadmap §"U4 연기 항목"에 갱신)

- **제네릭 array `min(1)`**(`Array must contain at least 1 element(s)`): 배너 경로(ScenarioModel)에서 도달 불가 — 시나리오 트리의 모든 배열은 커스텀 메시지(R5)다. 이 문구는 `parseStepsFragment`(스텝 템플릿 삽입, ADR-0036)에서만 나오고 그 경로는 `formatGateMessages`를 안 거친다. 죽은 매핑 회피.
- **think-time refine**(`min_ms <= max_ms <= 600000`)·**ULID regex**(`step id must be a ULID`)·**JSON cast 에러**(ADR-0029 도메인): 명명된 3+1 클래스(discriminator/enum/strict/min) 밖. 영어 fallback 유지(spec 허용). 후속 후보.
- **제네릭 숫자 범위 문구**(`Number must be greater than or equal to N` / `Number must be less than or equal to N`): assert `code`(100–599)·`timeout_seconds`(1–600)·`think_time.min_ms`(≥0)에서 도달하는 too_small/too_big. 컨테이너 `min(1)`이 아닌 일반 범위라 명명 범위 밖 — 영어 fallback 유지. 후속 후보(reviewer F4 가시화).
- **조건 z.union 실패**(`<path>: Invalid input`): `ConditionModel`은 discriminatedUnion이 아니라 `z.union`(공통 discriminant 없음, `model.ts:123-129`)이라 잘못된 `op`·형태는 generic `Invalid input`을 낸다(노출할 구체값 없음). discriminator/enum 클래스가 아니므로 영어 fallback 유지. 후속 후보(reviewer F3 가시화).
- **path 한국어화/필드명 현지화**: path는 원문 dot-경로 유지(기존 컨벤션). 별도 작업.

---

## 8. 구현 순서 (plan 입력)

UI-only·추가 전용이라 **단일 green 커밋 1개**로 충분(cargo 게이트 미해당, ui-only는 pre-commit이 UI 게이트만 실행). TDD 순서:
1. `problems.test.ts`에 신규 손-세그먼트 + 실-Zod + `normalizeList` 테스트 추가(RED) — 동시에 `ko.ts` 키, `problems.ts` 매핑/헬퍼 구현(GREEN). 셋이 한 커밋(미사용 ko 키만·RED 테스트만 단독 커밋은 게이트상 무의미).
2. 실-Zod fixture의 실제 path는 구현 중 `parseScenarioDoc` 출력에서 캡처해 기대 문자열에 박는다.
3. `cd ui && pnpm lint && pnpm test && pnpm build` green 확인 후 커밋.
4. 최종 `handicap-reviewer`(와이어 1:1·정규식 충돌·fallback 보존·완성도). 보안 게이트는 path-gate(요청실행/템플릿/cast/env·dataset/업로드/trace-body) 미해당 → security-reviewer N/A.

# 현황판 기본값 인라인 편집 + `{0,0}` 표시 확산 (thinkboard-defaults)

- **날짜**: 2026-07-19
- **유형**: user-path (US1) + correctness-bug (US2) — UI-only. 엔진/컨트롤러/proto/서버 store/migration **0-diff**, 와이어 무변경.
- **출처**: think-time-dashboard(머지 `4ca2ccd`)가 낳은 후속 2건 — `roadmap-status.md` 추천 다음 작업 "**현황판 기본값 편집 + R1-a2 확산(묶음)**"(사용자 제안 2026-07-19).
- **선행**: think-time-dashboard(현황판·`scenario/thinkTime.ts` 판정 단일 소스·`resolveThinkDraft` 4분기 커밋 규칙) · think-time-defaults(루트 `default_think_time` 상속) · ADR-0033(parallel 분기 배제) · ADR-0035(ko 문구 카탈로그) · ADR-0044(FlowOutline)
- **brainstorming 결정(사용자 승인 2026-07-19)**: 편집기 형태=**상시 인라인**(표 위 요약 줄 승격) · 확산 방식=**공용 포매터 `formatThink` 추출**(표면별 국소 분기·표시 생략 기각) · `ScenarioDefaults` **존치** + 커밋 규칙 수렴 · ko 시그니처 `(min,max)`→`(formatted)` 변경 승인

## 사용자 스토리 (US)

- **US1**: QA가 현황판에서 전 스텝의 실효 대기를 훑다가 "기본값 자체를 바꿔야겠다"고 판단할 때 — 지금은 모달을 닫고 → 왼쪽 접힌 `시나리오 기본값` 섹션을 펼쳐 고치고 → 현황판을 다시 열어 결과를 확인해야 한다. 성공하면 현황판을 닫지 않고 상단에서 min/max를 고치고, 그 즉시 상속 행들의 `실효 대기` 열이 새 값으로 바뀌는 것을 같은 화면에서 본다.
- **US2** *(correctness-bug)*:
  - **재현**: ① 시나리오 기본값을 `0/0`으로 두고 스텝 인스펙터를 연다. ② 스텝에 `think_time: {min_ms: 0, max_ms: 0}`을 지정하고 `[스텝 넓게 보기]`로 본다.
  - **실측**: Inspector = "시나리오 기본값 **0–0ms** 상속 중", wide 칩 = "think **0–0ms**". 같은 상태를 현황판은 "**대기없음**"이라 부른다.
  - **기대**: **에디터의 세 표면(현황판·Inspector·`[스텝 넓게 보기]` 칩)** 이 같은 어휘. 엔진 `pace(0)`은 즉시 `Slept`를 반환하므로(`crates/engine/src/pacing.rs:56-57`) "0ms 대기"와 "대기없음"은 **구별 불가능한 동작**이다 — 두 문자열이 존재하면 QA가 어느 쪽이 진실인지 판단해야 한다.
  - 성공하면 재확인하러 현황판을 다시 열 필요 없이 **이 세 표면 어디서든** 같은 판정을 읽는다.

(행위자 = QA, ADR-0001 1차 사용자 · US 초안 사용자 승인 2026-07-19)

> **US2의 경계**: 성공 조건을 에디터 3표면으로 **의도적으로 좁혔다**. 에디터 밖에 같은 클래스의 비대칭이 하나 더 있고(아래 비목표 마지막 항목 — `scenarioHasThink`), 그건 부하 사이징 의미론을 건드리므로 이 슬라이스에서 다루지 않는다. US2 문장이 범위보다 넓으면 "다 고쳤다"는 착시가 생긴다.

**묶는 이유**: US1의 편집기가 들어가면 사용자가 **클릭 한 번으로**(기본값을 `0/0`으로) US2의 모순을 만들 수 있다. 실재하는 경로다 — 새 편집기에서 `0/0` 커밋 → `classifyThink`가 `inherited`로 분류(`thinkTime.ts:53`) → `Inspector.tsx:413`의 `inheriting && defaultThink`가 truthy 객체로 통과 → "0–0ms" 노출. 따로 내면 US1이 버그의 노출 빈도를 올린 채 착지한다.

## 배경 (현행 코드)

**판정은 이미 단일 소스, 표시는 아니다**

- `ui/src/scenario/thinkTime.ts`(120줄, 순수 모듈)가 `ThinkState` 5상태 판정(`classifyThink`)·행 조립(`buildThinkRows`)·4분기 커밋 규칙(`resolveThinkDraft`, `:67-78`)을 소유한다. 모듈 private `normalizeEffective`(`:33-35`)가 `{0,0} → undefined`(R1-a2)를 수행하지만 **`ThinkRow.effective` 안에만 갇혀 있다** — 문자열로 바꾸는 일은 소비처가 각자 한다.
- 그 결과 `{0,0}`을 문자열로 만드는 규칙이 **세 곳에 흩어져 있고 두 곳이 틀렸다**:
  | 위치 | 현재 코드 | `{0,0}` 결과 |
  |---|---|---|
  | `ThinkTimeBoard.tsx:33` `effectiveText` | `t === undefined ? thinkNoWait : thinkRange(...)` | "대기없음" ✅ |
  | `Inspector.tsx:415` | `ko.editor.inheritedThink(defaultThink.min_ms, defaultThink.max_ms)` | "시나리오 기본값 0–0ms 상속 중" ❌ |
  | `FlowOutline.tsx:171` | `ko.editor.wideChipThink(step.think_time.min_ms, step.think_time.max_ms)` | "think 0–0ms" ❌ |
- 해당 ko 함수: `ko.ts:599` `inheritedThink: (min, max) => \`시나리오 기본값 ${min}–${max}ms 상속 중\``, `ko.ts:462` `wideChipThink: (min, max) => \`think ${min}–${max}ms\``. 표시 헬퍼 `thinkNoWait`(`:619`)·`thinkRange`(`:620`)는 이미 있다.

**기본값 편집기의 현 위치**

- `ScenarioDefaults.tsx`(109줄) — 에디터 왼쪽 `<aside>`의 **기본 접힘** 섹션(제목 = `ko.editor.scenarioDefaultsTitle` `"시나리오 기본값"`, `ko.ts:513`). 현황판은 `Modal`이므로 **열려 있는 동안 이 섹션에 도달할 수 없다**(US1의 왕복이 여기서 발생). 두 컴포넌트는 **동시에 마운트**된다(`EditorShell.tsx:152` `<ScenarioDefaults />` · `:198` `<ThinkTimeBoard …/>`).
- 이 파일은 `resolveThinkDraft`가 추출되기 **전에** 쓰였고, 같은 4분기 규칙을 `commit()`(`:38-56`) 안에 **인라인 복제**하고 있다. think-time-dashboard Task 5는 Inspector·ThinkTimeBoard 두 소비처만 수렴시켰다 — 이것이 남은 마지막 사본이다.
- 입력 시드는 `defaultThink ? String(defaultThink.min_ms) : ""`(`:30-31`, `:34-35`) — **객체 truthy 검사**라 `{0,0}`에서도 안전하다. 이 형태를 원시값으로 그대로 옮기면 깨진다(R2-c).
- store 액션은 `setDefaultThinkTime(value: ThinkTime | undefined)`(`store.ts:54`/`:160`) — `dispatch` 경유라 `yamlError !== null`이면 자체 게이트로 무시되고(`store.ts:433`), 성공 시 `{doc, model, yamlText, yamlError}` 단일 `set`(`:437`).

**현황판의 요약 줄**

- `ThinkTimeBoard.tsx:255-257`이 읽기 전용 `<p data-testid="default-summary">`로 `defaultSummary(model?.default_think_time)`(`:37`)를 렌더한다. 3분기: `thinkBoardDefaultNone`(`ko.ts:622`) / `thinkBoardDefaultZero`(`:623`) / `thinkBoardDefaultSummary(min,max)`(`:621`). 이 `<p>`는 빈 상태 삼항(`:258`) **바깥**이다.
- 표 본체의 행 편집기(`BoardRow`)는 원시값 dep 재시드(`useEffect(..., [row.stepId, cfgMin, cfgMax])`, `:60-65`)와 `resolveThinkDraft` 커밋(`:69-85`)을 이미 쓴다 — 새 편집기가 따를 이디엄이다. 시드 표현식은 **`cfgMin === undefined ? "" : String(cfgMin)`**(`:63-64`)로, truthy가 아니라 `undefined` 비교다.
- 모달을 닫으면 `selected`·`bulkMin`·`bulkMax`만 리셋된다(`:208-216`) — 컴포넌트 자체는 항상 마운트되고 `Modal`만 `null`을 반환하기 때문이다.

## 범위 / 비목표

**범위**: `ui/src`만.
`scenario/thinkTime.ts`(`formatThink` 추가) · `i18n/ko.ts`(2함수 시그니처 변경 + 키 3개 추가/1개 개정/2개 삭제) · `components/scenario/ThinkTimeBoard.tsx`(요약 줄 → 편집 행) · `Inspector.tsx`(1줄) · `FlowOutline.tsx`(1줄) · `ScenarioDefaults.tsx`(커밋 수렴 — R4, 드롭 가능) · 각 테스트.

**비목표**:
- 엔진/컨트롤러/proto/서버 store/migration **0-diff**. 와이어(`think_time` 형식) 무변경.
- `Modal.tsx` **0-diff** · `EditorShell.tsx` **0-diff**(진입 버튼·마운트 이미 있음) · `store.ts` **0-diff**(기존 `setDefaultThinkTime` 재사용, 새 `Edit` 변형 없음).
- **표 열/행 추가 없음** — 편집기는 `<table>` **밖** 요약 줄이다. 유사-행으로 넣으면 `selectedIds`·`allChecked`·`toggleAll`·`parallelWithValue`가 전부 "기본값 행"을 스텝으로 세게 되어 선택 로직이 오염된다(brainstorming에서 기각한 형태).
- `ScenarioDefaults` **삭제하지 않는다** — 모달을 열지 않고 기본값만 만지는 경로가 살아 있어야 한다(roadmap 결정 "`ScenarioDefaults` 존치").
- 현황판 기본값 편집기에 병렬 `HelpTip` **중복 배치 없음** — `parallel_unset` 행 배지가 이미 같은 HelpTip을 달고 있다(`ThinkTimeBoard.tsx:124-128`).
- 기본값 편집기에 **`×` 되돌리기 버튼 없음**(행에는 `thinkBoardResetAria` `×`가 있다). 행의 `×`는 "**상속으로** 되돌리기"인데 기본값에는 상속할 상위가 없다 — 지우는 것과 의미가 다르므로 같은 어포던스를 쓰면 거짓말이 된다. 기본값의 clear 경로는 "두 칸 비우고 blur"뿐이고, 이는 `ScenarioDefaults`와 동일하다.
- undo 없음(코드베이스에 undo 인프라 없음) · 확인 다이얼로그 없음 — 기본값 변경의 결과는 **같은 화면 `실효 대기` 열에 즉시 보이는 것**이 안전장치다(US1의 관찰 자체).
- FlowOutline 칩의 **표시 조건은 안 바꾼다** — `step.think_time !== undefined`일 때만 칩이 뜨는 현행 유지(`FlowOutline.tsx:169`, 문자열만 교정). 상속 스텝에 칩을 새로 띄우는 것은 범위 밖.
- **`scenarioHasThink`의 `{0,0}` 비대칭은 이번에 고치지 않는다** (`ui/src/scenario/model.ts:284`): 이 함수는 `default_think_time != null`이면 `{0,0}`에도 `true`를 반환해 open-loop think 토글·"think time이 슬롯을 점유합니다" 안내(`ko.ts:226-230`)를 띄운다. R1이 `thinkTime.ts`에 세우는 "`{0,0}` ≡ `undefined`" 규칙과 어긋나므로 **실재하는 후속 결함**이지만, 고치면 open-loop **슬롯 사이징 의미론**이 바뀐다(ADR-0046/§B21 영역). **연기 조건**: 부하 모델 쪽 슬라이스에서 sizing 회귀 테스트와 함께 다룰 것 — 에디터 문구 슬라이스에 얹으면 라이브 검증 범위가 run 생성까지 번진다. build-log에 후속으로 기록한다.

## 요구사항

### R1 — 표시 단일 소스 `formatThink` (US2)

`thinkTime.ts`에 추가(판정 단일 소스 옆에 표시 단일 소스):

```ts
/** ThinkTime을 사람이 읽는 한 조각으로. {0,0}과 undefined는 엔진에서 구별 불가능한
 *  동작이므로(pacing.rs:56-57 — pace(0)은 즉시 Slept) 같은 문자열이어야 한다. */
export function formatThink(t: ThinkTime | undefined): string {
  return t === undefined || (t.min_ms === 0 && t.max_ms === 0)
    ? ko.editor.thinkNoWait
    : ko.editor.thinkRange(t.min_ms, t.max_ms);
}
```

> 인라인 주석의 `pacing.rs:56-57`은 기존 `thinkTime.ts:31` 주석과 **lockstep**이어야 한다(같은 파일에 서로 다른 참조가 공존하면 안 된다).

- **R1-a 경유 강제(ko 시그니처 변경)**: 소비처가 옛 `(min, max)` 호출로 되돌아가면 버그가 조용히 재발하므로, ko 두 함수를 **포맷된 문자열을 받도록** 바꿔 타입 레벨에서 막는다:
  - `ko.ts:599` → `inheritedThink: (formatted: string) => \`시나리오 기본값 ${formatted} 상속 중\``
  - `ko.ts:462` → `wideChipThink: (formatted: string) => \`think ${formatted}\``
  - **왜 ko.ts 안에서 분기하지 않는가**: `thinkTime.ts`가 이미 `ko.ts`를 import한다(`thinkTime.ts:1`; `ko.ts`는 import 0줄). ko.ts가 `formatThink`를 부르면 순환 import다. 방향은 `ko ← thinkTime ← 컴포넌트`로 고정한다.
  - 호출부 전수(grep 확인): `inheritedThink` = prod 1(`Inspector.tsx:415`) + 테스트 2(`Inspector.test.tsx:1327/1371`) · `wideChipThink` = prod 1(`FlowOutline.tsx:171`) + 테스트 1(`FlowOutline.test.tsx:527`). `tsc -b`가 누락을 잡는다.
- **R1-b 소비처 3곳**:
  1. `ThinkTimeBoard.tsx:33` 로컬 `effectiveText`를 **삭제**하고 `formatThink`를 직접 쓴다(`:178` 호출부). 동작 동일 — `effective`는 이미 `normalizeEffective`를 거쳐 오므로 `{0,0}`이 도달하지 않지만, 두 번째 방어선이자 사본 제거다.
  2. `Inspector.tsx:415` → `ko.editor.inheritedThink(formatThink(defaultThink))`.
  3. `FlowOutline.tsx:171` → `ko.editor.wideChipThink(formatThink(step.think_time))`.
- **R1-c 렌더 불변식**: `{0,0}`이 **아닌** 값에서는 세 표면의 출력이 **byte-identical**이어야 한다(기존 테스트가 회귀 가드 — `(500,1000)`·`(100,200)`은 호출 형태만 갱신되고 기대 문자열은 그대로).

### R2 — 현황판 기본값 인라인 편집기 (US1)

`ThinkTimeBoard.tsx`의 읽기 전용 `<p data-testid="default-summary">`(`:255-257`)를 편집 행으로 승격한다. `<table>` **바깥**, 표 바로 위.

**구성**: 라벨 + `Input numeric` min/max 2개 + `ms` 단위 + **상태 문구**.

- **R2-a 상태 문구**: `data-testid="default-summary"`를 **이 문구 span에 유지**한다(기존 테스트 앵커 보존).
  - `default_think_time === undefined` → `ko.editor.thinkBoardDefaultNone`
  - 그 외 → **`formatThink(def)`** → `{0,0}`이면 "대기없음", 아니면 "N–Mms"
  - `thinkBoardDefaultNone`은 라벨과의 중복을 피해 **`"없음 — 상속 스텝은 모두 대기없음"`으로 개정**한다. 이 문구가 "기본값 없음"과 "기본값 `{0,0}`"이 **실효로는 같다**는 사실을 그 자리에서 말해준다(`thinkTime.ts:47-52`가 근거 — `inherited_none`·`parallel_unset` 모두 실효 = 대기없음). **키 이름은 `thinkBoardDefaultNone` 그대로 유지**한다(값이 "없음의 결과"를 설명하게 됐지만, 키가 가리키는 *상태*는 여전히 "기본값 없음"이다 — 개명은 순가치 0의 diff).
  - `thinkBoardDefaultZero`(`ko.ts:623`)·`thinkBoardDefaultSummary`(`:621`)는 `formatThink`가 대체하므로 **삭제**한다. ko 테스트 2파일(`ko.test.ts`·`editorRedesignKeys.test.ts`) 어디에도 이 두 키가 없음을 grep으로 확인했다(`ko.test.ts:126-148`의 `ko.editor` 고정 리스트 루프에도 미포함) → 삭제 안전. 로컬 `defaultSummary`(`:37`)도 삭제된다.
- **R2-b 커밋**: `resolveThinkDraft(minDraft, maxDraft)` 4분기 → `clear`면 `setDefaultThinkTime(undefined)`, `commit`이면 `setDefaultThinkTime(value)`, `noop`은 아무것도 안 함, `revert`는 현재 `default_think_time`으로 draft 되돌리기. `onBlur`에서 호출.
- **R2-c draft 시드·재시드 (필수 — `{0,0}` 데이터 손실 방지)**:
  - dep은 **원시값** `[defMin, defMax]`(`defMin = model?.default_think_time?.min_ms`). 객체 `model.default_think_time`을 dep으로 쓰면 표 어느 행에서 한 번 커밋할 때마다 `model`이 새 객체로 교체되어 **입력 중이던 기본값 draft가 사라진다**(`BoardRow`가 이미 겪고 주석으로 남긴 함정 — `ThinkTimeBoard.tsx:57-59`).
  - 시드 표현식은 반드시 **`defMin === undefined ? "" : String(defMin)`** 형이다. `ScenarioDefaults`의 `defaultThink ? … : ""`(`:30-31`)는 **객체** truthy 검사라 안전하지만, 그 형태를 원시값에 그대로 옮기면 **`defMin === 0`이 falsy**라 기본값 `{0,0}`이 **빈 칸 2개**로 시드되고, 이어지는 blur가 `resolveThinkDraft` → `clear` → `setDefaultThinkTime(undefined)`로 **키를 지운다**. 이 슬라이스가 존재하는 이유인 `{0,0}`에서 스스로 데이터를 잃는 회귀다. 안전한 선례는 `BoardRow`의 `cfgMin === undefined ? "" : String(cfgMin)`(`:63-64`).
- **R2-d 게이트**: 두 입력 모두 `disabled={yamlError !== null}` — 표의 다른 편집 컨트롤과 동일(`disabled` 변수 재사용).
- **R2-e 즉시 반영(US1의 관찰)**: 커밋 → store 재파싱 → `model` 교체 → `rows = useMemo(..., [model])` 재계산 → `state`가 `inherited`인 행들의 `실효 대기` 열이 새 값으로. **추가 코드 없음** — 이 요구사항은 구현이 아니라 **테스트로 락인할 불변식**이다.
- **R2-f 모달 close 시 draft 리셋**: 기본값 min/max draft도 기존 `!open` 리셋 effect(`:208-216`)에 **편입**해 model에서 재시드한다. 이유: ESC/백드롭 종료는 포커스된 input이 조건부 렌더로 사라지며 **blur가 발화하지 않을 수 있고**(`ui/CLAUDE.md` 기록 함정), 그러면 commit도 revert도 없이 stale draft가 다음 오픈에 모델과 어긋나 보인다. `selected`/`bulkMin`/`bulkMax`와 동일한 처리다.
  - **deps에 `defMin`/`defMax`를 추가할 것 — `eslint-disable` 금지.** 현재 이 effect의 deps는 `[open]`이고 본문이 상수 setter만 부르기 때문에 exhaustive-deps를 만족한다. 재시드를 편입하면 두 원시값이 필수 dep이 되고, `ui/package.json:10`의 `eslint . --max-warnings=0` + `exhaustive-deps: "warn"`(`ui/eslint.config.js`의 `reactHooks.configs.recommended`) 조합에서 **경고 1건이 곧 게이트 실패**다. 본문 전체가 `if (!open) return` 가드 뒤라 열린 상태에서 dep이 변해도 no-op이므로 deps 추가가 안전한 해법이다(suppression으로 우회하면 R2-c의 재시드 의도까지 흐려진다).
- **R2-g 빈 상태에서도 표시**: `rows.length === 0`(스텝 0개)에서도 편집기는 보인다 — 교체 대상 `<p>`가 이미 빈 상태 삼항(`:258`) 바깥이므로 **그 위치를 유지**하면 된다. 스텝을 추가하기 전에 기본값을 정하는 순서가 자연스럽다.

**신규 ko 문자열 (전부 기존과 비충돌 — FR4)**

| 키 | 값 | 충돌 회피 |
|---|---|---|
| `thinkBoardDefaultLabel` | `"기본 think time"` | `scenarioDefaultsTitle`(`:513` `"시나리오 기본값"`)과 **다름** — 두 컴포넌트가 동시 마운트라 같은 문자열이면 `getByText` 다중매치 |
| `thinkBoardDefaultMinAria` | `"현황판 기본 대기 최솟값 (ms)"` | `fieldDefaultThinkMin`(`:515` `"기본 think 최솟값 (ms)"`)·`thinkBoardRowMinAria`(`:624`)·`thinkBoardBulkMinAria`(`:630`)와 **전부 다르고, 어느 쪽도 다른 쪽의 부분문자열이 아니다** |
| `thinkBoardDefaultMaxAria` | `"현황판 기본 대기 최댓값 (ms)"` | 위와 동일(`fieldDefaultThinkMax` `:516` 등) |

**`think` → `대기`로 바꾼 이유(부분문자열 회피)**: `"현황판 기본 think 최솟값 (ms)"`는 기존 `"기본 think 최솟값 (ms)"`의 **진부분문자열 관계**(superset)라, RTL `getByLabelText`(기본 exact)에서는 무충돌이지만 **Playwright `getByLabel`은 기본 substring 매칭**이라 옛 라벨로 조회하면 둘이 잡혀 strict-mode violation이 난다. 하필 L7이 aside를 펼친 채 두 편집기를 동시에 노출시키는 Playwright 스텝이라, **제품 결함이 아닌 이유로 거짓 FAIL**이 난다. `대기`로 바꾸면 어느 방향으로도 부분문자열이 아니므로 두 엔진 모두 안전하다. L7에서는 추가로 `{ exact: true }`를 명시한다(이중 안전장치).

### R3 — 두 편집기의 일관성 (US1)

`ScenarioDefaults` **존치**. 두 편집기 모두 store `setDefaultThinkTime`을 부르고 각자 재시드 effect를 가지므로 **동기화 코드는 0줄**이다. 한쪽에서 바꾼 값이 다른 쪽 입력에 시드된다(라이브 L7).

### R4 — 마지막 복제본 수렴 (정리 — 어느 US에도 매달리지 않음, **드롭 가능**)

`ScenarioDefaults.tsx::commit`(`:38-56`)의 인라인 4분기를 `resolveThinkDraft`로 교체한다.

- **동작 변화 0**: 두 구현의 trim 위치·분기 순서(both-empty→clear / one-empty→noop / 정수 ∧ `mn>=0` ∧ `mx>=mn` ∧ `mx<=600_000`→commit / else revert)·상한·revert 시드(caller-side `defaultThink`)가 **완전히 일치**함을 spec 리뷰에서 대조 확인했다.
- **사용자 관찰 가능한 변화가 없으므로 US 하위가 아니다.** 일정·리스크가 생기면 **잘라낸다** — 잘라낼 경우 `ScenarioDefaults.tsx::commit`에 `resolveThinkDraft`를 가리키는 주석만 남긴다.
- **이 task에 다른 finding을 접어 넣지 말 것** — 드롭 가능한 항목에 얹은 결정은 task와 함께 조용히 사라진다(직전 슬라이스 교훈).

## 테스트

> **이빨 실증 의무**: 회귀 가드를 표방하는 테스트(2·5·8·9)는 **고의 회귀 → RED 확인 → 원복 → GREEN**을 실제로 실행해 증명한다. 각 항목에 **RED 대상 단언**과 **주입할 회귀**를 명시했다 — 직전 슬라이스에서 plan이 verbatim 지시한 테스트 3건이 공허했던 클래스(단언 대상이 버그와 무관하게 안정 / 같은 행에 동일 문구 2개라 위치 의존 셀렉터가 오매핑을 통과 / 복합 조건의 다른 항이 이미 false)를 답습하지 않기 위해서다.

**단위 — `scenario/__tests__/thinkTime.test.ts` (기존 파일에 추가)**

1. `formatThink` 3분기: `undefined` → `thinkNoWait` / `{0,0}` → `thinkNoWait` / `{200,500}` → `thinkRange(200,500)`.
2. **동치 락인**: `expect(formatThink(undefined)).toBe(formatThink({min_ms:0, max_ms:0}))` — 두 반환값을 **서로 직접 비교**한다(각각을 리터럴 `"대기없음"`과 비교하면 한쪽만 틀려도 통과할 수 있다).
   - *RED 대상*: 이 단언. *주입할 회귀*: `formatThink`에서 `(t.min_ms === 0 && t.max_ms === 0)` 항을 제거.
3. 경계: `{0,1}`·`{1,0}`은 `thinkRange` 경로(0이 **둘 다**일 때만 대기없음).

**컴포넌트 — `ThinkTimeBoard.test.tsx` (기존 파일에 추가·갱신)**

4. **US1 핵심**: 기본값 min/max를 `200/500` → `1000/2000`으로 입력+blur → `state: "inherited"` 행(`로그인`)의 `실효 대기` 셀이 `1000–2000ms`로 바뀐다(**같은 render 안에서**, 모달 재오픈 없이).
5. **R2-a 회귀**: 기본값을 `0/0`으로 커밋 → `default-summary`가 `ko.editor.thinkNoWait`이고 상속 행 `실효 대기`도 `thinkNoWait`.
   - **셀렉터 주의**: "대기없음"이 화면에 여러 개 존재하므로 `getAllByText(...)[0]` **금지** — `getByTestId("default-summary")`와 행 스코프 `within(row("로그인")).getByTestId("effective")`로 각각 앵커.
   - *RED 대상*: **`getByTestId("default-summary")` 단언만**. 행 `실효 대기` 셀은 `normalizeEffective`(`thinkTime.ts:33-35`)가 상류에서 이미 `{0,0}→undefined`로 접어 넘기므로 `formatThink`의 `{0,0}` 분기를 지워도 **여전히 "대기없음"** 이다(그 단언은 US1 일관성 락인으로 유지하되 이빨 실증 대상이 아니다). *주입할 회귀*: 항목 2와 동일.
6. 빈 칸 2개 blur → `setDefaultThinkTime(undefined)` → `default-summary` = 개정된 `thinkBoardDefaultNone`, YAML에서 `default_think_time` 키 소멸.
7. 한 칸만 비우고 blur → **no-op**(draft 보존, 다른 칸 값 유지, YAML 무변화).
8. **R2-c 시드 회귀 (`{0,0}` 데이터 손실)**: `default_think_time: {0,0}` 픽스처를 로드 → 기본값 min/max 입력의 `value`가 각각 **`"0"`/`"0"`**(빈 문자열 아님)이고, 아무것도 안 친 채 blur해도 YAML의 `default_think_time`이 **살아 있다**.
   - *RED 대상*: `value === "0"` 단언 + blur 후 키 생존 단언. *주입할 회귀*: 시드를 `defMin ? String(defMin) : ""`(truthy 형)으로 교체.
9. **R2-c dep 회귀 (재시드로 인한 draft 유실)**: 기본값 입력에 `1000`을 친 상태에서(blur 전) **`주문` 행**(`think_time: {800,900}`가 픽스처에 실재 — `ThinkTimeBoard.test.tsx:9-53`)의 min을 `850`으로 바꾸고 blur → **실제 commit이 발생**(모델이 바뀜을 YAML로 확인)한 뒤에도 기본값 draft가 `1000`으로 살아 있다.
   - **대상 행을 `주문`으로 고정하는 이유**: 상속 행(`로그인`)은 draft 두 칸이 다 `""`라 min만 치고 blur하면 `resolveThinkDraft`가 **`noop`**(`thinkTime.ts:71`)을 반환해 `dispatch` 자체가 없다 → `model` 불변 → 객체 dep으로 되돌려도 재시드가 안 일어나 **RED가 안 뜬다**(공허해지는 경로).
   - *RED 대상*: 기본값 draft가 `"1000"`이라는 단언. *주입할 회귀*: dep을 `[model?.default_think_time]`(객체)로 교체.
10. `yamlError` 상태에서 두 입력이 `disabled`.
11. **R2-f**: 기본값 입력에 값을 친 뒤 blur 없이 모달을 닫고 다시 열면 draft가 model 값으로 재시드돼 있다.
12. **R2-g**: 스텝 0개 시나리오에서도 기본값 편집기가 렌더된다(빈 상태 문구와 **함께**).
13. 기존 `:159`(`"200–500ms"`)·`:165`(`thinkBoardDefaultZero`) 테스트를 새 문구 규칙으로 갱신.

**컴포넌트 — `Inspector.test.tsx` (기존 파일에 추가·갱신)**

14. **US2-①**: 기본값 `{0,0}` + 상속 스텝 선택 → `"시나리오 기본값 대기없음 상속 중"`이 보이고 `"0–0ms"`는 문서에 **없다**(negative 단언 포함).
15. 기존 `:1327`/`:1371`의 `(500, 1000)` 호출을 `inheritedThink(ko.editor.thinkRange(500, 1000))`로 갱신 — **기대 문자열은 불변**(R1-c).
16. 분기 안 스텝은 여전히 `parallelNoDefaultNote`(amber)가 우선 — 기본값이 `{0,0}`이어도 상속 안내로 바뀌지 않는다(직전 슬라이스 R1-c 불변식 유지).

**컴포넌트 — `FlowOutline.test.tsx` (기존 파일에 추가·갱신)**

17. **US2-②**: `[스텝 넓게 보기]`에서 `think_time: {0,0}` 스텝의 칩이 `"think 대기없음"`이고 `"think 0–0ms"`는 없다.
18. 기존 `:527`의 `(100, 200)` 호출을 `wideChipThink(ko.editor.thinkRange(100, 200))`로 갱신 — 기대 문자열 불변.
19. `think_time` 없는 스텝엔 칩이 **여전히 없다**(비목표 락인 — 표시 조건 무변경).

**컴포넌트 — `ScenarioDefaults.test.tsx` (기존 파일 — 변경 없이 통과해야 함)**

20. R4 수렴 후 기존 4분기 테스트(`:43` clear/commit · `:84` noop · `:108` revert · `:162` 재시드)가 **수정 없이** GREEN. 하나라도 손대야 한다면 그건 동작 변화이므로 수렴이 틀린 것이다.

**게이트**: `pnpm lint && pnpm test && pnpm build` 전부 green(파이프 없이 `; echo exit=$?`로 종료코드 명시 캡처 — `| tail`이 실패를 마스킹한 선례).

## 라이브 검증

production diff가 UI-only이고 run 생성/report 파싱/엔진 경로를 건드리지 않지만, **에디터 화면은 마운트 경로가 둘**이므로 양쪽에서 확인한다([[live-verify-all-mount-paths]] — `/scenarios/new`만 보고 `/scenarios/{id}`의 영구 부재를 놓친 선례).

| # | 화면 | 확인 |
|---|---|---|
| L1 | `/scenarios/new` | `⏱ 페이싱` → 기본값 min/max 입력 존재·편집 가능 |
| L2 | `/scenarios/{id}` | 동일(저장된 시나리오 경로) |
| L3 | 현황판 | 기본값 `200/500` → `1000/2000` 커밋 시 상속 행 `실효 대기`가 **모달을 닫지 않고** 갱신 (US1) |
| L4 | 현황판 → YAML 모달 | 커밋 결과가 `default_think_time`에 반영, 주석·형식 보존 |
| L5 | Inspector | 기본값 `0/0`일 때 "시나리오 기본값 **대기없음** 상속 중" (US2-①) |
| L6 | `[스텝 넓게 보기]` | `{0,0}` 스텝 칩 = "think **대기없음**" (US2-②) |
| L7 | `<aside>` 펼침 + 현황판 | 현황판에서 바꾼 값이 aside 입력에 시드(R3) **그리고** 두 편집기 동시 노출 상태에서 라벨 로케이터가 다중매치로 throw하지 않음(R2 신규 ko 비충돌). **로케이터는 `{ exact: true }`로 조회** — Playwright 기본 substring 매칭이 거짓 FAIL을 내지 않게 |
| L8 | 현황판 | 기본값 `{0,0}` 시나리오를 열었을 때 입력이 `0`/`0`으로 보이고, 만지지 않고 닫아도 YAML 키가 살아 있음 (R2-c) |

run 생성은 불필요(부하 경로 무변경) — 근거를 build-log에 남긴다.

## 리스크

- **ko 시그니처 변경의 파급**: 호출부는 prod 각 1곳 + 테스트 3곳뿐(전수 grep 완료). `tsc -b`가 누락을 잡는다.
- **`thinkBoardDefaultZero`/`Summary` 삭제**: 다른 참조 없음(ko 테스트 2파일 포함 grep 확인).
- **요약 줄 승격의 레이아웃**: 실제 폭 제약은 `Modal.tsx:76`의 `max-w-3xl`(768px) − 패널 패딩 ≈ **736px**이며, `라벨 + 입력2 + ms + 상태문구`는 그 폭에서 여유롭다. 표의 `table-fixed`(`:262`)는 편집기가 `<table>` 밖이므로 **이 행에 아무 제약도 주지 않는다**. 그래도 좁은 뷰포트 대비 `flex flex-wrap items-center gap-2`로 감싼다(`Modal.tsx` 0-diff 유지).

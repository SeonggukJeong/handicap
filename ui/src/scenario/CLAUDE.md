# 시나리오 모델 계층 (`ui/src/scenario/`) 함정

이 파일은 `ui/src/scenario/` 파일을 **Read 도구로 열 때** 자동 로드되는 2단계 중첩 CLAUDE.md다(Bash grep/cat로는 로드되지 않는다). 전역 규칙은 루트 `CLAUDE.md`, UI 공통은 `ui/CLAUDE.md`, 에디터 컴포넌트 함정은 `ui/src/components/scenario/CLAUDE.md` 참고.

> Zod 모델(`model.ts`)·캐스트(`cast.ts`)·변수 스캔(`scanVars.ts`)·YAML 문서(`yamlDoc.ts`)·store·검증 배너 매핑(`problems.ts`)을 다룬다. 실수 지점이 컴포넌트·pages에도 걸친 함정은 `ui/CLAUDE.md` 또는 `components/scenario/CLAUDE.md`에 남아 있다.

## 빌드·타입 게이트

- **검증 배너 게이트-에러 한국어 매핑(`problems.ts::formatSegment`) 확장 규칙** (게이트-에러 한국어 매핑): `parseScenarioDoc`/ScenarioModel가 낸 `path: message` 세그먼트를 한국어로 매핑하되 — ① 정규식은 **실측 Zod 문구**(현재 3.25.76, `node_modules/zod/v3/locales/en.js` + `helpers/util.js` `joinValues`)가 단일 소스(추측 금지), ② 모든 한국어는 `ko.editor.gate*` 카탈로그 경유(ADR-0035)·`model.ts` Zod 스키마/커스텀 메시지는 **안 건드린다**(커스텀 `min(1)` 문구도 model.ts 직접 한국어화 말고 영어→한국어 매핑 — 와이어 byte-identical 유지), ③ 신규 분기는 기존 분기 뒤·`return seg;` 앞(미지 세그먼트 영어 fallback 보존), enum `: Invalid enum value. Expected …`은 invalid-type `: Expected …`와 부분문자열로 비충돌, ④ **실-Zod 드리프트 가드 필수** — 손-세그먼트 단언뿐 아니라 실 fixture를 `parseScenarioDoc` 통과시켜 한국어 키 `toContain`(zod 범프로 문구 바뀌면 silent 영어강등 대신 red).
- **`BodyModel.superRefine`로 JSON 캐스트 검증** (0029): `cast.ts::jsonBodyCastErrors`가 json body value를 재귀 walk하며 미지원 캐스트 keyword(`:int` 등)·혼합 leaf 캐스트를 에러로. `discriminatedUnion`의 **멤버**가 아니라 **전체 union에 `.superRefine`**(멤버에 붙이면 ZodEffects라 discriminatedUnion이 거부). `type Body`는 ZodEffects infer라 union 타입 보존 — 소비처(`RequestModel.body`) 무영향. 검증은 `ScenarioModel.safeParse`(YAML↔모델 sync 시점, Monaco-time 아님) 경로에서 발동. 캐스트 없는 토큰·리터럴은 절대 flag 안 함(false-positive 금지). `trailingCast` regex는 콜론 뒤 공백 허용(`{{ age : int }}`도 미지원 keyword로 잡음) — 엔진 `parse_cast_leaf`의 `kw.trim()`과 lockstep. 한 가지 의도된 비대칭: 콜론 든 변수명(`{{a:b}}`)을 UI는 'unknown cast :b'로 막지만 엔진은 변수명 `a:b`(string 경로)로 취급 — **UI가 더 엄격한 방향(false-positive)이라 안전**(콜론 든 변수명은 비권장). 위험 방향(UI 통과·엔진 실패)은 없음.
- **`ConditionModel`은 모델 최초의 `z.lazy`** (Slice 9b): 재귀 `Condition`(leaf/all/any)을 `z.lazy`로 정의하되 **`discriminatedUnion`이 아니라 `z.union`** — 3 형태가 공통 discriminant 키가 없고 `left`/`all`/`any` 존재 여부로 구분된다. **명시적 `z.ZodType<Condition>` 주석을 안 달면 `tsc`가 `any`로 추론**한다. recursive 라 annotation 이 self-referential 타입을 끊어주는 역할.
- **두 계층 Zod 게이트(two-tier)는 `z.lazy` 자기참조 대신** (Slice 9c): 상호 1레벨 중첩 게이트를 `z.lazy(()=>StepModel)`로 구현하면 loop-in-loop/if-in-if 같은 동일 타입 무제한 중첩이 허용돼 §5 불변식이 깨진다. 대신 http-only `NestedLoopStepModel`/`NestedIfStepModel`/`NestedElifBranchModel`(1레벨 한정) + 최상위 `LoopStepModel`/`IfStepModel`(본문 = `http | 상대 Nested*` discriminatedUnion) 두 계층으로 허용 경로를 타입으로 못 박는다. `ConditionModel`의 기존 `z.lazy`는 건드리지 않음. 새 `z.ZodType` 주석 불필요(컴파일 클린).
- **`StepModel`은 이제 http|loop|if|parallel **4-way** discriminatedUnion + 분기명 유니크는 union 레벨 `.superRefine`** (A2 Parallel): `BranchModel{name,steps:z.array(HttpStepModel).min(1)}`(http-only) + `ParallelStepModel`(plain `.strict()` object — `branches:z.array(BranchModel).min(1)`). 분기명 유니크 검증은 `ParallelStepModel` *멤버*가 아니라 **`StepModel` 전체 union에 `.superRefine`**(멤버에 붙이면 ZodEffects라 discriminatedUnion 거부 — `BodyModel`/JSON-cast 패턴 동일, `s.type!=="parallel"` early-return). parallel은 어떤 `Nested*` union 멤버도 아니라 **top-level-only** 구조적 강제. `flattenHttpSteps`/`findStepById`/`siblingsOrNull`(`findStepSiblings` 백킹)/`searchSeq`(`findStepPath` 백킹)는 전부 `branches[].steps` 하강(trailing `else`(=if)는 `else if (s.type==="if")`로 narrow). `addBranch` store action은 `findStepById`(top-level `.find` 아님)로 노드 찾아 유니크 `branch{N}` 기본명 생성(superRefine 즉시 트립 방지).
- **`yaml`(1.2 core)은 `"0b101"`·`"+0x1F"`·`"-0x10"` 같은 문자열을 따옴표 없이 쓰는데 serde_yaml은 이를 정수로 읽는다** (pick-array): 엔진이 "문자열 vs 숫자"를 구분해 와이어로 내보내는 값(pick_array `pick`/`rest`)은 작성기에서 문자열 노드에 `Scalar.QUOTE_DOUBLE`을 강제(`yamlDoc.ts` `setVariableGen`). 반대 방향 발산(`01`=serde 문자열/yaml 정수, `1e3`)도 있어 손 편집 YAML은 완전 일치 불가 — `testdata/pick_array_vectors.json` `known_divergence`로 고정.

## 폼·입력 UX / 진단 표시 (RunDialog, RunDetail)

- **시나리오 최상위 키 추가는 3곳 세트 — Zod 모델(`model.ts`)·yamlDoc Edit variant·`normalizeForModel` allowlist(yamlDoc.ts)** (scenario-notes): `normalizeForModel`은 명시 필드 객체 리터럴이라 미등재 키는 `safeParse` 전에 조용히 drop → write-only(`setIn`은 되는데 `model.<key>`가 영원히 undefined). `ui/CLAUDE.md` §폼·입력 UX의 `normalizeRequest` passthrough(`KeyValueGrid` 2-맵 항목)와 같은 클래스(스코프만 request→시나리오 루트). plan file:line 포인터가 이 3번째 지점을 빠뜨려도 구조상 필수.

## 변수 스코프 판정 (`scanVars.ts`, `VariablesPanel`)

- **`{{var}}` 정의 여부는 위치에 따라 다르다 — 전역 집합으로 판정하면 틀린다** (parallel-var-scope 2026-07-19): 엔진은 parallel 분기의 extract를 `{branch}.{var}`로만 노출하므로, 분기 **밖** 다운스트림에서 bare `{{token}}`은 미정의(run이 `all VUs failed`로 죽는다)지만 그 분기 **안**에서는 정의다. 구 `undefinedVars`는 `collectProducedVars`(→`flattenHttpSteps`가 분기까지 하강)로 전역 판정해 이 결함을 못 봤다 → **`undefinedVarRefs`(위치 인식)로 대체**. 판정 규칙: 분기 B 서브트리 안 = 선언 ∪ flat extract ∪ **B 자신의** extract / 그 밖 = 선언 ∪ flat extract / namespaced(`{{B.v}}`)는 모든 위치에서 해석.
- **"B 자신의 extract" walker는 분기 서브트리를 재귀해야 한다** — 최상위 http만 보면 분기 안 `loop`/`if` 속 bare 참조가 전부 **오탐**(엔진 `output_var_names()`가 고친 것과 같은 실수).
- **참조 수집은 `buildVarRefIndex`를 본떠라(`collectBranchInternalRefs` 아님)** — 후자는 `flattenHttpSteps`만 돌아 `if`/`elif` **조건 오퍼랜드** 커버리지가 없다. 그걸 본뜨면 조건에서만 참조되는 미정의 이름을 조용히 놓쳐 구 `undefinedVars` 대비 **회귀**가 되는데 기존 테스트가 못 막는다.
- **"형제 분기" 판정엔 parallel 노드 identity가 필요하다 — "어떤 분기 안이냐"만 보면 틀린다** (fix-2 blocker, 최종 리뷰 적발): 서로 **다른** top-level parallel 노드는 순차 실행이라 앞 노드의 merge 결과가 뒷 노드 분기의 진입 스코프에 들어간다(`runner.rs` `entry = iter_vars.clone()`) → P2 분기 안에서 P1 분기의 extract를 참조하는 건 **실제로 정의돼 있다**. 노드 id 없이 "분기 안"만 보면 이걸 `sibling`으로 오분류해 "형제 분기의 값은 참조할 수 없습니다"(거짓)를 띄우고 동시에 "선언 추가"까지 숨겨 **사용자에게 남는 행동이 0**이 된다. `branchOwn`/`own`에 소유 노드 id를 실어 **같은 노드일 때만** `sibling`.
- **의도된 false-negative(조이지 말 것)**: 같은 parallel 노드 *안*에서 `{{B.v}}`를 참조하면 런타임엔 미해결(병합은 `join_all` 이후)이지만 현재는 **정의됨**으로 보고한다 — shadow 테스트가 이걸 고정한다.

## 데이터 바인딩 패널 (8c, `DataBindingPanel`)

- **`scanFlowVars`는 loop `do:` 배열 안까지 재귀 스캔해야 한다** (Slice 8c): url/headers/body 외에 loop 스텝 `do:` 배열의 중첩 http 스텝도 스캔하지 않으면, loop body 안의 `{{var}}`가 패널에서 안 보여 사용자가 매핑을 못 만든다. `flattenHttpSteps` 헬퍼(Slice 7)를 재사용해 먼저 평탄화한 뒤 스캔하면 중복 구현 없이 해결.

## 오프라인(CSP) · 테스트 인프라

- **다중 스텝을 한 번에 고치는 store 액션은 `dispatch` 전에 대상 id를 http leaf 집합과 교집합할 것 — `findStepPath`는 타입을 안 가린다** (think-time-dashboard): loop/if/parallel **컨테이너 id**가 섞여 들어오면 컨테이너 노드에 스텝 전용 키를 써버리고 `.strict()` Zod 재파싱이 실패하는데, `dispatch`는 `applyEdit`로 **doc을 이미 변형한 뒤** 실패 분기에서 `yamlError`만 세우므로 **doc은 변형됐는데 model/yamlText는 옛 상태인 divergence**가 남는다. `flattenHttpSteps(get().model.steps)`와 교집합하면 `model === null`도 빈 집합이 되어 자연히 no-op(=`renameVariable`식 clone→검증 패턴 없이 by-construction 보장). 또한 `applyEdit` 루프에서 `doc.createNode(value)`는 **id마다 새로** 호출할 것 — 호이스팅하면 `yaml` 라이브러리가 앵커/별칭(`&a1`/`*a1`)을 뿜어 YAML이 사람이 읽기 어려워진다(모델 단언으로는 안 보인다 — 파싱 시 별칭이 해소되므로).

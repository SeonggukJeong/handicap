# 에디터 변수 도구 A — 미정의 경고 + 사용→스텝 네비게이션 + flat 변수 rename (B13 tier C, 슬라이스 A)

- **날짜**: 2026-07-04
- **상태**: 설계 승인(사용자 2026-07-04) → plan 대기
- **출처**: roadmap §B13 tier C(변수 rename/bulk·미정의 경고·사용 힌트→네비게이션). 왜 지금: 아웃라인 재설계(1–3)·공간/이름 QoL 완결로 에디터 편집 UX가 성숙했고, 변수는 QA가 매일 만지지만 rename 수단이 없어 "새 키 추가+옛 키 삭제"로 모든 참조가 조용히 끊긴다. 참조만 있고 producer 없는 오타 변수를 잡아주는 것도 없다.
- **연관**: ADR-0044(에디터 아웃라인 `FlowOutline`), ADR-0014(`{{var}}` 흐름 변수 표기), ADR-0029(JSON 바디 `{{var:cast}}`), ADR-0033(parallel 분기 `{{branch.var}}` 네임스페이스), 2026-07-03-editor-space-qol(`jumpToStep`·스텝 네비 선례), 2026-07-04-editor-gate-errpct-fixes(yamlError 구조편집 게이트). 메모리 [[implementation-rigor-over-spec]].
- **후속 슬라이스 B**: **parallel-분기 변수 rename**(scope-aware — 분기 서브트리 bare + `{{branch.var}}` 재작성, 패널 `(branch,var)` identity). 이 슬라이스는 그 표면을 **비활성+노트**로 둔다(§7).
- **ADR**: 신규 불필요 — ADR-0014/0033/0044 범위 내 additive(같은 store·같은 모델 위 새 편집 액션+뷰). 모델(Zod)/proto/migration/YAML 직렬화 *형식* 무접촉(rename은 기존 문자열 내용만 재작성).

---

## 1. 문제와 목표

흐름 변수(`{{var}}`)는 선언(`scenario.variables`)·추출(`extract[].var`)에서 산출되고 url·헤더·바디·form·JSON leaf·`if` 조건 곳곳에서 raw 문자열로 참조된다. 그런데 ① VariablesPanel엔 **rename이 없어** 이름을 바꾸면 모든 참조가 조용히 끊긴다, ② **producer 없는 미정의/오타 변수를 잡아주는 것이 없다**, ③ "N개 스텝에서 사용" 힌트는 **표시-only라 그 스텝으로 갈 수 없다**. 게다가 `{{token:num}}`(ADR-0029 cast)이 어디서도 cast-suffix-strip 안 돼 `countFlowVarUsage`가 `"token:num"`을 키로 잡아 base `token`을 **"미사용"으로 오보**하는 잠복 버그가 있다(rename·경고·카운트가 전부 base 정규화에 의존하므로 토대로 함께 고친다).

- **목표**: ① **미정의 경고**(producer 없는 참조를 패널에서 ⚠ — parallel `{{branch.var}}` 완전 지원: 유효 네임스페이스 참조는 통과·당글링 `{{typo.sessionId}}`는 flag), ② 사용 카운트 **클릭→참조 스텝 순환 점프**(parallel 완전 지원), ③ **flat 변수 rename**(선언·비-parallel extract — 선언 키 + 모든 `extract[].var` + 모든 텍스트 참조[cast 보존] + 조건 오퍼랜드를 단일 원자·트랜잭셔널 편집으로). 공유 토대 = engine-충실 cast-base 파싱 + produced/namespaced/referenced 인덱스.
- **비목표(연기)**: §7 — **parallel-분기 변수 rename(슬라이스 B)**, bulk 편집, FlowOutline 스텝 배지, producer 스텝으로의 nav.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST 공유 순수 `splitFlowToken(inner) → {base, cast:string\|null}`은 trailing `:kw`를 **`kw ∈ {str,num,bool,json}`(엔진 `CAST_KEYWORDS`)일 때만** 분리(그 외 `:word`는 base의 일부 — 엔진이 `{{a:foo}}`를 변수명 `a:foo`로 보는 것과 충실)하고, `scanVars`의 참조 수집(`scanFlowVars`)·사용 카운트(`countFlowVarUsage`)가 이 base로 정규화한다. | `flowToken.test.ts`: `{{token:num}}`→base `token`·`{{count:foo}}`→base `count:foo`·공백·`:json`; `scanVars.test.ts`: `{{token:num}}`이 `token`(≥1)로 집계·`{{count:foo}}`는 `count:foo`로 | |
| R2 | MUST `collectProducedVars(scenario) → Set<string>` = `Object.keys(variables)` ∪ 전 http 스텝(`flattenHttpSteps`, parallel 분기 포함) `extract[].var`를 `scanVars.ts` 공유 export로 승격(현 `DataBindingPanel` 인라인 사본 대체). | `scanVars.test.ts`: 선언+추출 union·loop/if/parallel 내부 extract 포함 | |
| R3 | MUST `collectNamespacedProducers(scenario) → Set<string>`(각 parallel 분기 B의 http extract `var`마다 `${B.name}.${var}`)와 `buildVarRefIndex(scenario) → Map<refName, stepId[]>`(문서 순서·**조건 오퍼랜드 포함**·cast-정규화·bare와 `branch.var` 참조를 등장 형태 그대로 키)를 제공하고, 사용 카운트(=`ids.length`)가 이로부터 파생된다. | `scanVars.test.ts`: 분기 extract `s`가 `B.s` namespaced 생성·`buildVarRefIndex`가 `{{B.s}}`를 `B.s` 키·bare `{{x}}`를 `x` 키로 문서순 stepId·`{{a:num}}`→`a` | |
| R4 | MUST 미정의 집합 = `buildVarRefIndex.keys() − collectProducedVars − collectNamespacedProducers`(예약 시스템 감산 **없음** — `{{}}`는 flow 네임스페이스, `${vu_id}`는 별개 system 네임스페이스라 `{{vu_id}}`는 진짜 미정의 flow var). 이로써 유효 `{{B.s}}`는 미정의 아님·당글링 `{{typo.s}}`/bare `{{missing}}`은 미정의. | `scanVars.test.ts`: 유효 namespaced 미포함·당글링 namespaced 포함·bare 미정의 포함·`{{vu_id}}`(flow)는 미정의(감산 안 함) | |
| R5 | MUST VariablesPanel은 등장 변수를 **상태별 한 리스트**로: (a)선언(값 편집+제거+nav; rename 연필은 **flat non-shadow일 때만** — parallel 분기서도 추출되면 연필 없음, R9 권위), (b)flat-extract(비-parallel; rename 연필+nav, 값/제거 없음), (c)**parallel-extract**(`branch.var`로 표시·"분기" 배지+nav; **rename 없음**, 값/제거 없음), (d)미정의(⚠ "정의안됨"+nav; rename/값/제거 없음). 하단 두-칸 add row·`VarCheatSheet` 유지. | RTL: fixture(선언·flat-extract·parallel-extract·bare 미정의·당글링 namespaced)로 각 행 상태·affordance 게이트 | |
| R6 | MUST `yamlDoc`에 `renameVariable{oldName,newName}` Edit variant를 추가해 (a) `variables` 맵 키를 값·위치·주석 보존하여 rename(노드 조작 — `deleteIn+setIn` 금지), (b) 모든 `extract[].var===oldName`을 newName으로(구조적 타깃), (c) 모든 스칼라 문자열의 `{{oldName}}`/`{{oldName:cast}}`를 `splitFlowToken` base가 oldName과 정확일치할 때만 base를 newName으로(**cast·앞뒤 공백·나머지 byte 보존**, `{{oldNameX}}`/`{{B.oldName}}` 불매치), (d) 조건 오퍼랜드는 (c) 스칼라 패스에 자연 포함(`exists`/`empty`의 `right` 키 신규 생성 없음)한다. | `yamlDoc.rename.test.ts`: (a)–(d)·cast 보존·공백 보존·정확일치·헤더키 무오염·`{{B.old}}` 불매치·따옴표 보존 | |
| R7 | MUST rename 편집은 **트랜잭셔널**(`reparentStep` 선례 — doc clone→apply→검증 통과 시에만 커밋, 실패 시 롤백·`yamlError` 오염 없음)이고 `yamlError` 상태에서 게이트된다. | `store.renameVariable.test.ts`: happy·`yamlError` no-op·(invalid 유발 불가지만) 실패 경로 미오염 | |
| R8 | MUST store `renameVariable(oldName,newName)` 액션은 **flat 변수**(선언 또는 비-parallel extract)에만 적용 가능하고 다음이면 **no-op**: newName 공백/`/^[^\s{}:]+$/` 불일치, newName===oldName, newName이 시나리오에 이미 존재하는 distinct 참조/producer 이름(bare 또는 namespaced)과 충돌, 또는 oldName이 **parallel 분기에서도 추출됨**(shadow — 슬라이스 B). | `store.renameVariable.test.ts`: happy·충돌 no-op·빈/불법 no-op·self no-op·shadow no-op | |
| R9 | MUST rename 어퍼던스(인라인 연필 — 스텝명 편집과 동일 draft→Enter/blur 커밋·Escape 취소)는 **flat non-shadow producer 행**(선언·비-parallel extract·parallel 분기서 미추출)에만 렌더하고, parallel/shadow/미정의 행엔 없다(parallel/shadow 행은 "분기 변수" 배지+title로 rename 미지원 안내). 커밋 시 R8 검증 실패면 인라인 에러(`ko`)·미커밋. yamlError 시 연필 disabled. | RTL: flat 행만 연필·parallel/shadow/미정의 행 무연필·rename Enter 커밋·충돌 인라인 에러·yamlError disabled | |
| R10 | MUST 각 행의 사용 카운트는 참조≥1이면 버튼이고, 클릭은 그 identity의 stepId(문서 순서) 첫 스텝을 `select`+scrollIntoView, 재클릭 시 순환한다(참조 0은 비버튼 "미사용"). identity별 참조: flat=bare `{{name}}`; parallel=`{{branch.var}}` namespaced; 미정의=그 참조명. 점프는 `EditorShell`이 내려주는 `jumpToStep`. | RTL: 3-참조 identity 카운트 3회 클릭이 `select`를 stepId 순서로·4회째 순환·미사용 비버튼 | |
| R11 | MUST 미정의 경고는 **패널 내부 한정** — FlowOutline·기존 ValidationBanner 무변경(스텝-레벨 배지=§7 연기). | RTL: FlowOutline 테스트 무수정 green; diff에 `FlowOutline.tsx` 배지 추가 없음 | |
| R12 | MUST `DataBindingPanel`은 인라인 produced-set을 `collectProducedVars`로 교체(중복 제거)하되 기존 "uncovered var" false-alarm 가드(8c/다중바인딩) 동작 보존. | 기존 `DataBindingPanel` 테스트 무수정 green + 교체 diff | |
| R13 | MUST 기존 `scanFlowVars`·`countFlowVarUsage` 소비처(`DataBindingPanel`·`InsertTemplateModal`·VariablesPanel usage)는 R1 cast 정규화 외 동작 변화 없음(조건-오퍼랜드 제외 등 기존 의미 유지). | 기존 insertTemplate/dataBinding/scanVars 테스트 무수정 + 신규 cast 케이스 | |
| R14 | MUST 엔진/컨트롤러/proto/migration/모델(Zod schema)/YAML 직렬화 **형식** 0-diff — `ui/src` 밖 무접촉, `model.ts` 스키마·기존 store 액션 시그니처 무변경(추가만: `flowToken.ts`·`scanVars` export·`yamlDoc` Edit variant·store 액션·`EditorShell`→`VariablesPanel` prop). | diff 스코프 grep + 기존 model/yamlDoc/store 테스트 무수정 green | |
| R15 | MUST 신규 사용자 노출 문구(상태 라벨·"분기" 배지·미정의 경고·충돌 에러·rename aria 전부)는 `ko.ts`(ADR-0035), 인라인 한글/영어 0. | 하드코딩 sweep(`'"[^"]*[가-힣]'` + ternary-attr) + 리뷰 | |
| R16 | SHOULD 연기 항목(§7 — parallel rename[슬라이스 B]·bulk·스텝 배지·producer-nav·parallel-row 내부-분기 bare nav 보강)을 `docs/roadmap.md`에 등재. | roadmap.md diff | |

seam 없음 — 전 요구사항이 UI 렌더/로컬 편집 한정. rename은 기존 `{{var}}`/`extract.var`/선언 키의 *내용*만 재작성하므로 엔진이 읽는 와이어 *형식*은 불변(R6이 cast 접미를 byte-보존·base만 치환 → 엔진 파서 parity 자동 충족, 별도 TS↔Rust parity R 불요).

---

## 3. 핵심 통찰 (설계 근거)

1. **base 정규화는 engine-충실 단일 파서로(R1)**: rename의 참조-집합·미정의·카운트가 전부 "`{{token:num}}`의 base"에 선다. 현 세 정규식이 cast를 제각각(대부분 미처리) 다뤄 base 개념이 흩어져 있다. `splitFlowToken`은 `trailingCast`(임의 `:word`)와 달리 **`CAST_KEYWORDS`일 때만** 접미를 뗀다 — 엔진은 `{{count:foo}}`(foo∉keywords)를 변수명 `count:foo`로 보므로(`crates/engine/CLAUDE.md`), 임의 `:word`를 떼면 base가 엔진과 어긋나 힌트가 거짓말한다. `cast.ts`의 검증 로직은 그대로 두고(ADR-0029 엄격 실패 경로 회귀 위험) `flowToken.test.ts`가 `trailingCast`와의 keyword-일치 동치를 단언해 드리프트를 막는다.
2. **cast 컨텍스트 경계는 의도적 단순화(§5에 명문화)**: 엔진은 cast를 **JSON leaf에서만** 적용(url/header/form/raw/조건은 문자열, `{{age:num}}`=변수명 `age:num`). 이 도구는 base 규칙을 컨텍스트 무관 균일 적용(`:kw`는 어디서나 cast로 간주) — scan과 rename이 **같은 base 규칙**을 쓰는 일관성이, 드문 "URL에 cast" 오용을 엔진-정확히 반영하는 것보다 중요하다(그 오용은 이 도구 범위 밖). 이 경계를 §5에 문서화.
3. **rename은 두 편집 클래스의 동시 발화(R6)**: 텍스트 참조(`{{old}}`)는 `{{}}` 델리미터로 구분되는 스칼라 내 토큰 → 어느 스칼라든 안전 치환; producer 필드(`extract[].var`·선언 키)는 bare 이름 → **구조적 타깃**(any-scalar===old 금지 — ui/CLAUDE.md "id 키 일괄 교체 금지: 헤더에 id면 오염" 클래스). 둘이 한 Edit에서 함께 발화해야 참조가 안 끊긴다. base 정확일치(`{{ ws old (cast|경계) ws }}`, 나머지 byte 보존)로 엔진 parity가 자동 충족(§2 seam).
4. **flat rename만·shadow/parallel은 비활성(사용자 승인 슬라이스 A)**: parallel 분기 extract는 다운스트림에서 `{{branch.var}}`로 네임스페이스되고(runner.rs:636) 분기-스코프 bare 재작성이 필요해 scope-aware(슬라이스 B). 슬라이스 A는 rename을 **어떤 parallel 분기도 추출하지 않는 이름**(=global bare가 모호하지 않은 flat 변수)에 한정 → global bare 치환이 안전(shadow 없음·`{{B.old}}` producer 없음). shadow(같은 이름이 flat+분기 양쪽 producer)는 rename no-op+배지. 충돌은 "이미 존재하는 어떤 참조/producer 이름으로도 차단"(비-merge·예측 가능·되돌리기 = newName→oldName 재rename).
5. **미정의 경고는 conservative·parallel 완전 지원(R4)**: `{{}}`는 flow 네임스페이스라 `${vu_id}` system과 무관 → 예약 시스템 감산 없음(`{{vu_id}}`는 진짜 미정의 flow var). bare 참조는 branch-inclusive `collectProducedVars`(분기 extract bare 포함)로 해소해 분기 내부 bare를 false-flag 안 함(conservative); namespaced 참조는 `collectNamespacedProducers`(유효 `B.var`)로 해소 → 당글링 `{{typo.s}}`만 flag. 스코프 추적 불요.
6. **패널은 상태별 단일 리스트·parallel은 namespaced identity로 표시(R5)**: 분기 extract는 두 분기가 같은 이름을 뽑을 수 있어 `(branch,var)`로 구분 → `branch.var`로 표시(중복 방지). getSnapshot 함정 회피 위해 셀렉터 fallback은 모듈-스코프 상수(`EMPTY_VARS`/`EMPTY_STEPS`, ui/CLAUDE.md).

---

## 4. 변경 상세

### 4.1 `scenario/flowToken.ts`(신규) + `scenario/scanVars.ts` — 충족 R: R1, R2, R3, R4, R13
- **`flowToken.ts`(신규)**: `splitFlowToken(inner): {base; cast|null}` — trailing `:kw`(kw ∈ `CAST_KEYWORDS`=str/num/bool/json)만 분리(그 외 base 유지)·나머지 trim. 순수·무의존. (cast.ts의 `CAST_KEYWORDS`와 동일 목록 — 필요 시 공유 상수.)
- **`scanVars.ts`**: `FLOW_VAR_RE` 매치 캡처를 `splitFlowToken(...).base`로 정규화(R1) — `scanFlowVars`·`countFlowVarUsage` 양쪽(조건 포함/제외 기존 의미 유지, cast만 정규화). 신규 export:
  - `collectProducedVars(scenario): Set<string>`(선언 키 ∪ `flattenHttpSteps` extract var — 분기 포함)(R2).
  - `collectNamespacedProducers(scenario): Set<string>`(각 parallel 분기의 http extract `var`마다 `${branch.name}.${var}`)(R3/R4).
  - `parallelExtractNames(scenario): Set<string>`(parallel 분기서 추출되는 bare 이름 — R8 shadow 판정용).
  - `buildVarRefIndex(scenario): Map<string, string[]>`(`countFlowVarUsage`와 같은 조건-포함 트리 워크 재사용해 refName→문서순 stepId; 카운트는 `.length` 파생 — 중복 워커 금지)(R3/R10).
  - `undefinedVars(scenario): Set<string>` = `buildVarRefIndex.keys() − collectProducedVars − collectNamespacedProducers`(R4).
- **`cast.ts`**: `trailingCast`·검증 무변경. `flowToken.test.ts`가 keyword-일치 동치 단언.

### 4.2 `scenario/yamlDoc.ts` — 충족 R: R6, R7
- `Edit`에 `{type:"renameVariable", oldName, newName}` 추가. apply(트랜잭셔널 — `reparentStep`처럼 clone→검증):
  - (a) `variables` 맵의 `oldName` 키 존재 시 그 `Pair` key 스칼라를 `plainScalar(newName)`로 교체(값·주석·위치 보존; `renameScenarioYaml`/`reissueStepNode` 선례). `deleteIn+setIn` 금지.
  - (b) 전 스텝 트리 구조 순회로 `extract` 배열 각 항목 `var===oldName`→newName(bare-scalar-any-match 금지).
  - (c) `yaml` `visit`로 모든 스칼라 문자열 값에서 flow 토큰 base가 oldName과 정확일치하면 base만 newName으로 치환(cast·앞뒤 공백·나머지 byte 보존; `escapeRegExp(oldName)` 기반 `/\{\{(\s*)OLD(?=[:}\s])/` 형태로 trailing `\s*` 미소비[FR5]·`{{oldX}}`/`{{B.old}}` 불매치[base 정확일치]). map **키** 스칼라는 (a) 소유라 값-스코프.
  - (d) 조건 `left`/`right` 스칼라는 (c)에 자연 포함(치환만·`right` 키 신규 생성 없음).
- `escapeRegExp` 지역 헬퍼.

### 4.3 `scenario/store.ts` — 충족 R: R7, R8
- `renameVariable(oldName, newName)` 액션: ① `newName===oldName`/공백/`/^[^\s{}:]+$/` 불일치 → no-op, ② `oldName ∈ parallelExtractNames(model)`(shadow/parallel) → no-op, ③ 충돌집합 = `collectProducedVars(model)` ∪ `collectNamespacedProducers(model)` ∪ `buildVarRefIndex(model).keys()`, `newName ∈ 충돌 && newName!==oldName` → no-op, ④ 통과 시 **`reparentStep` 인라인 트랜잭셔널 패턴으로** rename 적용 — 제네릭 `dispatch`(store.ts:327-349, live doc in-place mutate·reparse 실패 시 롤백 없이 `yamlError` 오염 = **비트랜잭셔널**) **호출 금지**; 대신 `reparentStep`(store.ts:240-257)처럼 `yamlError` 체크 → `doc.clone()` → `applyEdit(clone, {renameVariable})` → reparse/검증 → 성공 시에만 model/yamlText 커밋·실패 시 반환(원본 doc 무오염). 이 인라인 `yamlError` 체크가 R7 게이트.

### 4.4 `components/scenario/VariablesPanel.tsx` — 충족 R: R5, R9, R10, R15
- 분석 레이어로 **통합 행 목록** 구성 — identity 분류: 선언(키) / flat-extract(비-parallel extract bare, `parallelExtractNames` 제외) / parallel-extract(`(branch,var)`→`branch.var` 표시) / 미정의(`undefinedVars`, bare 또는 당글링 namespaced). 렌더 게이트는 R5.
  - **선언 행**: 이름(연필 rename·flat non-shadow일 때만) · 값 `AutoGrowTextarea`(현행) · nav 카운트 · `×`.
  - **flat-extract 행**: 이름(연필 rename) · nav 카운트.
  - **parallel-extract 행**: `branch.var` · "분기" 배지(title=rename 미지원 안내·`ko`) · nav 카운트. 연필 없음.
  - **미정의 행**: 이름 · ⚠ "정의안됨" · nav 카운트. 연필 없음.
- 인라인 rename: 연필→draft input, Enter/blur 커밋, Escape 취소; 커밋 시 store와 동일 검증 선-실행해 실패면 인라인 에러(`ko`)·미커밋. yamlError 시 연필 disabled.
- nav 카운트: identity 참조(R10)≥1이면 `<button>`(클릭→로컬 cycle 인덱스→`onJumpToStep(refIds[i%n])`), 0이면 "미사용". 셀렉터 fallback=모듈 상수. 신규 문구 `ko.ts`.

### 4.5 `components/scenario/EditorShell.tsx` — 충족 R: R10
- 기존 `jumpToStep(id)`를 `VariablesPanel`에 `onJumpToStep` prop으로 전달(현재 미전달). wide 모드 밖/jsdom에서 `select()` 유효·`scrollIntoView` 옵셔널 no-op.

### 4.6 `i18n/ko.ts` — 충족 R: R15
- 신규 키: `variableExtracted`("추출됨")·`variableBranch`("분기")+분기행 rename-미지원 title·`variableUndefined`("정의안됨")·미정의 aria·`renameVariableAria(name)`·rename 입력 aria·`variableRenameCollision(name)`·`variableRenameInvalid`·nav 버튼 aria. 기존 `variableUsage(n)`/`variableUnused` 재사용.

### 4.7 `components/DataBindingPanel.tsx` — 충족 R: R12
- 인라인 `availableElsewhere`(produced-set)를 `collectProducedVars(scenario)` 호출로 교체. false-alarm 가드(형제 카드 union·8c) 동작 동일.

### 4.8 `docs/roadmap.md` — 충족 R: R16
- 연기 항목 등재 — Python 스플라이스 규칙 준수.

---

## 5. 무변경 / 불변식 (명시)

- `crates/**`·proto·migration·CSV/XLSX export 0-diff. `ui/src`의 `model.ts`(Zod schema)·기존 store 액션 시그니처·`reorder.ts`·`dropRules.ts`·`FlowOutline.tsx`(배지 미추가, R11) 무변경.
- rename은 기존 `{{var}}`/`extract.var`/선언 키 *내용*만 재작성 — YAML 출력 *형식*(들여쓰기·따옴표·주석·cast 접미)은 base 치환 지점 외 byte-identical. 엔진 와이어 형식 불변.
- **cast 컨텍스트 경계(의도적)**: base 정규화(`:kw`=cast)를 컨텍스트 무관 균일 적용 — 엔진은 JSON leaf에서만 cast하지만(§3-2), scan/rename 일관성을 위해 url/header 등에서도 `{{age:num}}`을 base `age`로 본다. 드문 "비-JSON에 cast" 오용은 이 도구 범위 밖(순개선 방향 — 실 버그인 JSON `{{token:num}}` 오보를 고침).
- `cast.ts`의 ADR-0029 검증·엄격 실패 경로 무변경(`splitFlowToken`은 병렬·동치 테스트 고정).
- 기존 `scanFlowVars`/`countFlowVarUsage` 소비처: cast 정규화(순개선) 외 불변(R13).
- 미정의 경고·nav는 순수 에디터-타임 정적 분석 — run/report/엔진 경로 무영향.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | `flowToken.test.ts`(cast keyword-only·비-keyword base 유지·공백·`trailingCast` 동치); `scanVars.test.ts` cast 케이스 | |
| R2·R3 | `scanVars.test.ts`: `collectProducedVars`(분기 포함 union)·`collectNamespacedProducers`(`B.var`)·`parallelExtractNames`·`buildVarRefIndex`(문서순·조건 포함·cast) | |
| R4 | `scanVars.test.ts`: `undefinedVars` — 유효 namespaced 미포함·당글링 namespaced 포함·bare 미정의·`{{vu_id}}`(flow) 미정의(감산 없음) | |
| R6 | `yamlDoc.rename.test.ts`: (a)–(d)·cast/공백 보존·정확일치·헤더키 무오염·`{{B.old}}` 불매치·따옴표 보존 | |
| R7·R8 | `store.renameVariable.test.ts`: happy·충돌·빈/불법·self·shadow·`yamlError` no-op·트랜잭셔널 미오염 | |
| R5·R9·R10 | `VariablesPanel.test.tsx`: 4상태 행·affordance 게이트(flat만 연필·parallel/미정의 무연필)·rename Enter/충돌 인라인 에러/yamlError disabled·nav 3회 클릭 순환 stepId `select`·미사용 비버튼 | |
| R11·R14 | 기존 FlowOutline/model/yamlDoc/store/dataBinding 테스트 무수정 green + diff 스코프 grep | |
| R12·R13 | 기존 DataBindingPanel/insertTemplate 테스트 무수정 + 신규 cast 케이스 | |
| R15 | 한글 하드코딩 sweep 2종 — orchestrator 직접 재실행 | |
| R16 | roadmap.md diff | |

- **라이브 검증**: run-생성/report-파싱/엔진 경로 **무접촉**(순수 에디터-타임) → `/live-verify` 백엔드 스택 **필수 아님**. 단 [[implementation-rigor-over-spec]]에 따라 **Playwright 시각 실측 필수**(`/scenarios/new`·클라이언트-only·vite dev): ① rename 연필→이름 변경 후 참조 스텝의 `{{new}}` 반영(YAML 모달/Inspector 실측·Monaco setValue 불가 함정=실 UI 구성) ② 미정의 변수 ⚠ 행 렌더 ③ parallel 시나리오에서 유효 `{{branch.var}}` 미경고 + 당글링 경고 ④ 사용 카운트 클릭→스텝 선택 실측. DOM-존재만으로 PASS 금지.
- 게이트: `pnpm lint && pnpm test && pnpm build`(전체). 보안 표면: rename이 템플릿/바인딩 문자열을 재작성 → finish-slice §0 grep이 `template`/바인딩 매치 트리거 가능 → 매치 시 `security-reviewer` APPROVE(SSRF/시크릿 아닌 순수 이름-치환 확인).

---

## 7. 의도적 연기 (roadmap §B에 누적 — R16)

- **parallel-분기 변수 rename(슬라이스 B)**: scope-aware — 분기 서브트리 내 bare `{{var}}` + 다운스트림 `{{branch.var}}` 재작성, 패널 `(branch,var)` identity로 rename 활성화. 이 슬라이스는 분기/shadow 행 rename을 비활성+배지로 둔다.
- **parallel-row 내부-분기 bare nav 보강**: 슬라이스 A의 parallel-row nav는 namespaced `{{branch.var}}` 참조만(분기 내부 bare `{{var}}` under-count) — 슬라이스 B에서 `(branch,var)` identity로 통합.
- **Bulk 편집**: `BulkEditPanel`+`kvBulk` 확장 별도 슬라이스.
- **FlowOutline 스텝-레벨 미정의 배지**: `buildVarRefIndex`가 var→stepId를 주므로 데이터는 있으나 FlowOutline 렌더 확장 별도 표면(R11 패널-only 유지).
- **producer 스텝으로의 nav**: 추출 변수 행에서 그 `extract` 스텝으로 점프 — 현재 nav는 참조(소비) 스텝만.
- **merge/오타-재연결 rename**: 미정의 참조를 기존 producer 이름에 붙이는 merge — 충돌 차단(R8) 정책과 상충하므로 비범위. dangling 참조는 Inspector에서 그 스텝 직접 편집.

---

## 8. 구현 순서 (plan 입력)

UI-only라 cargo 게이트는 매 커밋 skip(fast-path). 각 task 독립 green 커밋, **각 task는 테스트 파일 편집을 가장 먼저**(`tdd-guard`가 pending test 없는 `ui/src` 편집 차단 — import 미해결 RED 무방):

1. **분석 토대(R1·R2·R3·R4·R13)**: `flowToken.ts` + `scanVars.ts`(cast 정규화·`collectProducedVars`·`collectNamespacedProducers`·`parallelExtractNames`·`buildVarRefIndex`·`undefinedVars`) + `DataBindingPanel` produced-set 교체(R12) + `flowToken`/`scanVars` 테스트. 순수·고립 → 먼저.
2. **rename 편집 경로(R6·R7·R8)**: `yamlDoc` `renameVariable`(트랜잭셔널) + `store.renameVariable` 액션(flat/충돌/shadow/yamlError 게이트) + `yamlDoc.rename`/`store.renameVariable` 테스트.
3. **패널 통합 + rename UI + nav(R5·R9·R10·R11) + ko(R15)**: `VariablesPanel` 통합 행·인라인 rename·nav 버튼·상태 배지 + `EditorShell` `onJumpToStep` + ko 키 + `VariablesPanel` 테스트.
4. **roadmap 등재(R16)·한글 sweep(R15)·Playwright 시각 실측(§6)**.

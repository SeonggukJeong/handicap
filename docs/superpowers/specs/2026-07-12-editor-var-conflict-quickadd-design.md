# 에디터 변수 충돌 배지 + 미정의 변수 원클릭 선언 (에디터 변수 도구 후속)

- **날짜**: 2026-07-12
- **상태**: 설계 승인(사용자 2026-07-12, 시각 목업 — amber 배지·텍스트 링크 버튼 확정) → plan 대기
- **출처**: roadmap §A12 도그푸딩 백로그 "변수명 충돌 감지"(UI-only 소형) + 사용자 확장 요청(2026-07-12) "사용은 하고 있는데 추가는 안 한 변수도 원클릭으로 추가".
- **연관**: `2026-07-04-editor-var-tools-design.md`(변수 패널 4상태 행·scanVars 토대), `2026-07-04-editor-var-tools-b-design.md`(parallel shadow 배지), `2026-07-07-extract-var-name-visibility-design.md`(행 flex-wrap·min-w-[72px] 패턴).
- **ADR**: 신규 불필요 — 순수 UI 표시/편의 기능, ADR-0044(아웃라인 에디터)·ADR-0014(변수 표기) 범위 내. 모델/스토어 시그니처/와이어 0-diff.

---

## 1. 문제와 목표

**충돌 invisible**: 엔진은 매 반복 flow 변수를 `scenario.variables`로 시드하고(runner.rs:360), 스텝 extract가 같은 이름에 값을 쓰면 **그 스텝 이후부터 선언값이 조용히 덮어써진다**. 그런데 `VariablesPanel`은 선언된 이름의 flat-extract 행을 억제하므로(선언 행만 표시) 이 충돌이 에디터 어디에도 안 보인다 — 사용자가 "선언값이 왜 안 먹지"를 런타임에서야 발견한다. parallel 분기 extract 충돌은 이미 shadow 배지("이름 충돌")가 담당하지만, 그건 **덮어쓰지 않는** 이름-혼동 클래스(분기 extract는 `분기명.변수`로 네임스페이스 merge — runner.rs:638)라 별개다.

**미정의 수리 마찰**: `{{var}}` 참조만 있고 producer가 없는 변수는 ⚠ "정의안됨" 행으로 뜨지만, 고치려면 패널 하단 입력칸에 이름을 다시 타이핑해야 한다(오타 위험 + 2단계).

- **목표 1 (충돌 배지)**: 선언 변수가 비-parallel extract와 같은 이름이면 선언 행에 amber 배지 "추출 덮어씀" + title 설명을 표시한다. 비차단 정보성(합법 패턴 — 기본값+덮어쓰기 — 일 수도 있으므로 편집을 막지 않음).
- **목표 2 (원클릭 선언)**: ⚠ 미정의 행에 텍스트 링크 버튼 "선언 추가"를 두어 클릭 한 번으로 `variables:`에 빈 값으로 선언한다.
- **비목표(연기)**: §7 참조. 데이터셋 바인딩 충돌(C안)·배지 클릭 nav·FlowOutline 스텝 배지·검증 배너 통합 없음.

---

## 2. 요구사항 (정규 — R-id)

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법: 테스트명 또는 관찰) | seam? |
|---|---|---|---|
| R1 | MUST: `scanVars.ts`에 순수 헬퍼 `flatExtractNames(scenario): Set<string>` 추가 — 비-parallel 서브트리(최상위·loop `do`·if `then`/`elif[].then`/`else` 하강, parallel branches 미하강)의 http extract var 집합(선언 키 미포함) | scanVars 단위 테스트: loop/if 내 extract 포함·parallel 분기 extract 제외·선언-only 이름 제외 | scan↔rewrite 대칭 무관(읽기 전용) |
| R2 | MUST: `flatProducerNames`는 `선언 키 ∪ flatExtractNames`로 재표현(walker 단일화)하되 반환 집합은 기존과 동일 | 기존 `scanVars.test.ts` flatProducerNames 테스트 전부 green | |
| R3 | MUST: 선언 행에서 `flatExtractNames(model).has(name) \|\| collectNamespacedProducers(model).has(name)`이면 nameline에 amber 배지(`shrink-0 rounded bg-amber-50 px-1.5 text-xs text-amber-700` — 기존 "분기" 배지의 amber 판) + `title` 설명을 표시하고, 아니면 배지 부재 — 두 번째 항은 점 포함 선언(`brX.tok`)이 parallel merge 키(`분기명.변수`)와 동일한 케이스(진짜 덮어쓰기, 리뷰 F2)를 커버 | RTL: ① 선언+flat extract 동명 fixture 배지 존재+title ② extract 없는 선언 행 배지 부재 ③ 점 포함 선언 `brX.tok`+분기 brX extract tok fixture 배지 존재 | |
| R4 | MUST: **bare** 선언 변수가 **parallel 분기에서만** 추출되는 이름이면 amber 배지를 달지 않는다(분기 extract는 `분기명.변수`로 네임스페이스 merge라 bare 선언값을 덮지 않음 — namespaced 집합엔 `brX.tok`만 있어 bare `tok`은 R3 판정 미발동·이름 혼동은 parallel 행 shadow 배지가 기존대로 담당) | RTL: bare 선언+parallel-only extract fixture에서 amber 배지 부재 + parallel 행 shadow 배지 기존 단언 green | 엔진 merge 의미론(runner.rs:638)과 1:1 |
| R5 | MUST: ⚠ 미정의 행에 텍스트 링크 버튼 "선언 추가"(usage 버튼과 같은 `text-xs text-accent-600 hover:underline` 이디엄, `aria-label`은 이름 포함) — 클릭 시 `setVariable(name, "")` 1회 호출로 행이 선언 행으로 전이(빈 값 textarea). **검색어(query)는 클리어하지 않는다**(이름 불변이라 필터 매치 유지 — 하단 추가 경로의 `setQuery("")` 복사 금지) | RTL: 클릭 후 ⚠ 행 소멸·선언 행(값 textarea·× 버튼) 등장·YAML에 `name: ""` 반영·검색어 입력값 유지 | |
| R6 | MUST: "선언 추가" 버튼은 `yamlError !== null`이면 disabled(연필 버튼과 동일 게이트 — store dispatch no-op의 시각적 미러). **하단 "추가" 버튼도 같은 게이트를 fold**(`disabled={newKey.trim().length === 0 \|\| yamlError !== null}`) — 동일 store action의 두 진입점이 같은 게이트 표시를 갖도록(기존은 깨진 버퍼에서 silent no-op) | RTL: yamlError 상태에서 두 버튼 모두 `toBeDisabled` | |
| R7 | MUST: 점 포함 미정의 이름(`brX.tok` 등)에도 버튼을 균일 제공 — 엔진 변수 맵이 flat이라 리터럴 키 선언이 참조를 실제로 충족 | RTL: 점 포함 fixture에서 버튼 존재·클릭 시 `variables`에 리터럴 키 추가 | 엔진 flat 맵 lookup과 1:1 |
| R8 | MUST: "선언 추가" 클릭 시 열린 사용처 팝오버를 닫는다(`setUsageNav(null)`) — 행 unmount(`u:`→`d:` key 전이)로 anchor가 detach되는 것 방지(기존 검색 onChange state-hygiene과 동형) | RTL: 미정의 행 팝오버 열고 클릭 → 팝오버 소멸 | |
| R9 | MUST: 배지가 얹히는 선언 행 nameline을 적응형 줄바꿈으로 전환 — 컨테이너 `flex items-center gap-2` → `flex flex-wrap items-center gap-x-2 gap-y-1`, non-renamable 이름 span `min-w-0` → `min-w-[72px]`(extract-var-name-visibility R1/R2 패턴의 선언-행 확장; renamable 쪽 `nameCell`은 이미 min-w-[72px]) | RTL: 클래스 토큰 단언(`className.split(/\s+/)` membership — raw substring 금지) + 라이브 rect 실측 | |
| R10 | MUST: 새 문구 전부 `ko.editor.*` 카탈로그 경유(ADR-0035) — 배지 텍스트·title·버튼 텍스트·aria-label(조사는 `을(를)` 병기형) | grep: 컴포넌트에 한글 하드코딩 0(`'"[^"]*[가-힣]'` 패턴) | |
| R11 | MUST: 모델/스토어/Zod/yamlDoc/와이어 0-diff — 변경 파일은 `scanVars.ts`·`VariablesPanel.tsx`·`ko.ts`(+테스트)뿐 | `git diff --stat` 범위 확인 | |

---

## 3. 핵심 통찰 (설계 근거)

1. **배지 판정 = flat extract ∪ namespaced producer 리터럴 일치 (정확성)**: 엔진 우선순위는 선언 seed → (데이터셋 주입) → **extract 덮어쓰기**. parallel 분기 extract는 join 후 `분기명.변수` 네임스페이스 키로만 merge되어 **bare** 선언값을 건드리지 않는다 — bare 선언의 parallel 충돌에 amber "덮어씀" 배지를 달면 거짓말이고, 그 클래스는 shadow 배지("이름 충돌")가 정확한 의미로 담당한다. 단 **점 포함 선언**(`brX.tok` — R7 quick-add의 산출물일 수 있음)이 merge 키와 리터럴 동일하면 merge가 flat 맵의 그 키를 **실제로 덮어쓰므로**(runner.rs:638) `collectNamespacedProducers` 항이 필요하다(리뷰 F2 — 이게 없으면 §1이 겨냥한 클래스가 두 배지 시스템 모두에 invisible). 경고 문구가 런타임 사실과 1:1이어야 한다는 원칙(resolveForDisplay "진단 표시가 거짓말" 함정과 같은 정신). 문구는 단정형 대신 **조건형**("쓸 수 있습니다") — extract가 미도달 if 분기에만 있거나 JSONPath miss면 실제론 안 덮는데, 정적 분석(flatExtractNames는 if 분기 무조건 하강)은 이를 구분 못 하기 때문(리뷰 F3).
2. **배지는 비차단·비인터랙티브**: 선언+extract 동명은 "이터레이션 초반 기본값, 로그인 후 덮어쓰기" 같은 합법 패턴일 수 있어 편집/저장을 막지 않는다. 배지 클릭→추출 스텝 점프는 §B15 "producer 스텝 nav" 연기 항목과 겹쳐 이번엔 title 툴팁만.
3. **원클릭 선언이 기존 경로를 그대로 타는 이유 (안전)**: `setVariable(name, "")`은 하단 "추가" 버튼과 동일한 store action → dispatch 편집 게이트(yamlError 시 no-op)·yamlDoc `setIn(["variables", name])` 경유라 YAML 직렬화/인용/점 포함 키 처리가 전부 기존 검증된 경로. 새 edit 변형 0.
4. **점 포함 이름 균일 제공**: `{{brX.tok}}` 미정의는 대개 분기명 오타지만, 엔진 변수 맵은 flat(`BTreeMap<String,String>`)이라 리터럴 `brX.tok` 선언이 참조를 실제로 충족한다(동작함). 숨기면 "동작하는 수리를 도구가 막는" 과잉 개입 — 균일 제공하고 오타 수리는 사용자 판단.
5. **선언 행 nameline wrap 필요 (R9)**: extract-var-name-visibility가 단일 줄 행 3종만 flex-wrap으로 수리하고 선언 행은 `[이름][×]`뿐이라 no-wrap으로 남겼는데, 배지(~70px)를 얹으면 210px 열에서 같은 27px 압착 함정이 재발한다 — 같은 패턴(flex-wrap + min-w-[72px])의 선언-행 확장으로 선제 차단. 배지 없는 선언 행은 전부 한 줄에 들어가 wrap 미발동 = 시각 no-op.

---

## 4. 변경 상세

### 4.1 `ui/src/scenario/scanVars.ts` — 충족 R: R1, R2

- `flatExtractNames(scenario): Set<string>` 신규: `flatProducerNames`의 walker에서 선언 키 시드만 뺀 형태(최상위·loop `do`·if 3분기 하강, parallel 미하강, http `extract[].var` 수집).
- `flatProducerNames`를 `선언 키 ∪ flatExtractNames(scenario)`로 재표현 — walker 중복 제거, 반환값 동일(기존 테스트가 락인).

### 4.2 `ui/src/components/scenario/VariablesPanel.tsx` — 충족 R: R3–R9

- `rows` useMemo: `const flatEx = flatExtractNames(model)`·기존 `collectNamespacedProducers` 결과 추가 활용, declared 행에 `overwritten: flatEx.has(name) || namespaced.has(name)` 필드.
- 선언 행 nameline: `{row.overwritten && <span className="shrink-0 rounded bg-amber-50 px-1.5 text-xs text-amber-700" title={ko.editor.variableOverwrittenTitle}>{ko.editor.variableOverwritten}</span>}` — nameCell(또는 non-renamable span) 뒤·× 버튼 앞. 컨테이너 `flex flex-wrap items-center gap-x-2 gap-y-1`로 전환, non-renamable 이름 span `min-w-[72px]`(R9).
- 미정의 행: ⚠ 배지 뒤에 `<button type="button" aria-label={ko.editor.variableDeclareAddAria(row.name)} disabled={yamlError !== null} onClick={...}>` — `setUsageNav(null)` 후 `setVariable(row.name, "")`, query 미클리어(R5). className `shrink-0 text-xs text-accent-600 hover:underline disabled:opacity-40`.
- 하단 "추가" 버튼: `disabled`에 `|| yamlError !== null` fold(R6).

### 4.3 `ui/src/i18n/ko.ts` — 충족 R: R10

- `variableOverwritten: "추출 덮어씀"`, `variableOverwrittenTitle: "스텝 추출이 같은 이름에 값을 쓸 수 있습니다 — 추출이 실행된 이후 스텝은 선언값 대신 추출값을 봅니다"`(조건형 — §3.1/리뷰 F3), `variableDeclareAdd: "선언 추가"`, `variableDeclareAddAria: (name: string) => `${name}을(를) 변수로 선언`` (기존 `variable*` 키 군집 옆).

### 4.4 테스트 — 충족 R: 전 R

- `ui/src/scenario/__tests__/scanVars.test.ts`: `flatExtractNames` 단위(R1) + 기존 flatProducerNames green(R2).
- `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx`: R3~R8 RTL(§2 acceptance 열), R9 클래스 토큰 단언.
- **기존 단언 반전(명시적 변경 항목, 리뷰 F1)**: `VariablesPanel.test.tsx:695–697`이 non-renamable 선언 span의 `min-w-0` 포함·`min-w-[72px]` 부재를 락인 중(extract-var-name-visibility R2/R5의 "의도적 무변경" 락인) — R9가 이를 뒤집으므로 **같은 task에서 단언을 반전**하고 주석의 구 spec 인용을 이 spec으로 갱신. RED 시 회귀 오인 금지.
- **배지+non-renamable 동시 fixture**: 선언+flat extract+parallel extract 3중 동명(배지 ∧ renamable=false — 배지가 non-renamable span 옆에 얹히는 R9 최악 조합)을 R9 RTL fixture로 지정.

---

## 5. 무변경 / 불변식 (명시)

- 엔진/컨트롤러/proto/migration/`crates/**`: 0-diff. `store.ts`/`yamlDoc.ts`/`model.ts`/Zod: 0-diff(기존 `setVariable` 재사용).
- 기존 행 4종의 문구·shadow 배지·rename/usage 팝오버 *동작*: 불변(선언 행 nameline 클래스만 R9로 변경 — 배지 없으면 시각 no-op). 단 **기존 테스트 파일은 0-diff가 아니다** — `VariablesPanel.test.tsx:695–697` 락인 반전 필요(§4.4, 리뷰 F1).
- run 생성/리포트/test-run 경로: 무접촉 — **라이브 검증은 클라이언트-only**(`/scenarios/new`, 백엔드 불요).
- 하단 "추가" 버튼: disabled 게이트에 yamlError fold(R6)만 — 클릭 시 동작·store 경로는 무변경. 검색·varsWide/wideOpen 그리드 계약: 무변경.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1·R2 | scanVars 단위 테스트(신규 + 기존 green) | |
| R3·R4 | RTL: 동명 fixture 배지 존재/부재 4케이스(flat 충돌·무충돌·bare+parallel-only 부재·점 포함 선언+merge 키 일치 존재) | |
| R5·R7 | RTL: 클릭 → 행 전이·YAML 반영·검색어 유지(일반 이름 + 점 포함 이름) | |
| R6 | RTL: yamlError 상태에서 "선언 추가"·하단 "추가" 둘 다 disabled | |
| R8 | RTL: 팝오버 열림 → 클릭 → 소멸 | |
| R9 | RTL 클래스 토큰 + 라이브 Playwright rect(배지 행 이름 실폭 ≥ 72px·좁은 열에서 배지/이름 배치) | ✅ |
| R10 | 한글 하드코딩 grep(`'"[^"]*[가-힣]'`) 0건 (orchestrator 직접 재실행) | |
| R11 | `git diff --stat` 범위 + `pnpm lint && pnpm test && pnpm build` | |
| 종합 | 라이브 Playwright(`/scenarios/new` 클라-only): 충돌 배지 표시 실측·"선언 추가" 클릭→선언 행 전이 실측(스크린샷) | ✅ |

---

## 7. 의도적 연기 (roadmap 재보고 시 재평가)

- **C안 — 데이터셋 바인딩 ↔ 시나리오 producer 충돌 경고**: 에디터는 run-config 바인딩을 모르므로 표면은 RunDialog `DataBindingPanel`. 바인딩은 선언값을 덮고(주입이 seed 뒤), flat extract는 바인딩을 또 덮는(추출 스텝 이후) 2중 의미론이라 문구 설계 필요 — 사용자 결정(2026-07-12)으로 백로그. finish-slice 때 roadmap §B에 기록.
- **배지 클릭 → 추출(producer) 스텝 점프**: §B15 "producer 스텝 nav" 기존 연기 항목과 합류.
- **FlowOutline 스텝-레벨 배지**(추출 스텝 쪽 표시): §B15 기존 항목.
- **검증 배너(problems.ts) 통합**: 배너는 파싱/게이트 에러용 — 비차단 의미론 혼합 금지.
- **quick-add 후 값 textarea 자동 포커스**: 행 전이가 model 재파생 렌더라 로컬 state로 못 잡음 — 필요 보고 시 재평가.

---

## 8. 구현 순서 (plan 입력)

1. Task 1: `flatExtractNames` + `flatProducerNames` 재표현 — scanVars 테스트 먼저(RED) → 구현(GREEN).
2. Task 2: 충돌 배지(R3·R4·R9) — RTL 먼저 → `VariablesPanel.tsx`+`ko.ts` → `pnpm lint && pnpm test && pnpm build`.
3. Task 3: 원클릭 선언(R5~R8) — RTL 먼저 → 구현 → 전체 게이트.
4. 라이브 Playwright 실측(R9·종합) — 머지 전 orchestrator 직접 수행.

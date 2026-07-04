# 에디터 변수 도구 B — parallel-분기 변수 rename (scope-aware) 설계

- **날짜**: 2026-07-04
- **상태**: 설계 (spec)
- **선행**: 에디터 변수 도구 A(`2026-07-04-editor-var-tools-design.md`) §7 연기 항목. ADR-0044(에디터 아웃라인) 범위 내 — **ADR 신규 없음**.
- **성격**: UI-only. `crates`/proto/migration/`model.ts`(Zod)/YAML 직렬화 **형식** 0-diff. `ui/src` 안에서만.

## 1. 목표

슬라이스 A가 flat 변수(선언·비-parallel extract) rename을 구현하며 **parallel-분기 extract 변수는 rename 비활성 + "분기" 배지**로 남긴 것을, scope-aware rename으로 확장한다.

- **한 문장**: parallel 분기에서 추출되는 변수를, 그 분기 서브트리 안의 bare `{{var}}` 참조와 다운스트림 `{{branch.var}}` 네임스페이스 참조를 **branch-스코프로 정확히 재작성**하여 rename하고, VariablesPanel의 parallel 행을 `(branch, var)` identity로 승격해 rename·분기-내부 bare nav를 활성화한다.
- **비목표(연기)**: §7 — bulk 변수 편집(BulkEditPanel/kvBulk 확장), FlowOutline 스텝-레벨 미정의 배지, producer 스텝으로의 nav, shadow(이름 충돌) 변수의 position-aware rename, shadow flat+parallel의 flat-identity 행 복원.

### 사용자 결정 (brainstorming)

1. **범위**: parallel rename 코어만 + 그에 직결된 패널 `(branch,var)` identity 통합(= parallel 행 bare nav 갭 해소). bulk/스텝배지/producer-nav는 별 슬라이스.
2. **shadow 정책**: **보수적 — non-shadow만 rename 활성**. 분기 extract 이름이 declared/flat 변수와 안 겹칠 때만 연필. shadow 행은 배지 유지(+"이름 충돌" 안내). 다중-분기 동명(`B.s`/`C.s`)은 각각 rename 가능(shadow 아님).

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST parallel 행 identity = **branch-이름 네임스페이스**(`${branch.name}.${var}`) — 엔진 `runner.rs:638` `format!("{}.{}", branch.name, k)`와 정확히 일치(같은 이름 branch가 여러 parallel 노드에 있으면 하나의 identity로 합침). `scanVars.ts` 신규 구조적 export `parallelVarIdentities(scenario) → {branchName, varName, display, isShadow, branchRefIds, namespacedRefIds}[]`가 이를 제공하고, 문자열 `B.s`를 분해하지 않는다(branch/var 이름에 `.` 포함 가능). | `scanVars.test.ts`: 두 parallel 노드의 동명 branch `B`가 하나의 `B.s` identity·`.` 포함 var(`a.b`)의 display `B.a.b`·branchName/varName 구조 보존 | |
| R2 | MUST `flatProducerNames(scenario) → Set<string>` = 선언 키 ∪ **parallel 분기 밖** http 스텝(loop `do`/if `then`·`elif[].then`·`else`는 하강, parallel `branches`는 **미하강**)의 extract var. `isShadowName`은 parallel extract 이름이 이 집합에 속하면 true. | `scanVars.test.ts`: flat 스텝 extract 포함·parallel-only extract 미포함·loop/if 내부 flat extract 포함·다중-분기 동명은 non-shadow | |
| R3 | MUST `collectBranchInternalRefs(scenario) → Map<"B.s", string[]>` = 이름이 `B`인 모든 branch **서브트리 내부**에서 bare `{{s}}`(cast 정규화, `splitFlowToken` base)를 참조하는 문서순 stepId. `{{B.s}}`(namespaced) 참조·branch 밖 bare는 미포함. | `scanVars.test.ts`: 분기 내부 bare `{{s}}` stepId 수집·다운스트림 `{{B.s}}` 미포함·다른 분기 bare 미교차·cast `{{s:num}}`→`s` 정규화 | |
| R4 | MUST parallel 행의 **enriched nav refIds** = non-shadow면 `collectBranchInternalRefs("B.s")` ∪ 기존 `buildVarRefIndex.get("B.s")`(다운스트림 namespaced), shadow면 후자만(bare 모호 → 미부착, "hint must not lie"). 문서순·dedup(같은 스텝 1회). | `scanVars.test.ts`/RTL: non-shadow 행 nav가 분기-내부+다운스트림 둘 다·shadow 행은 namespaced만 | |
| R5 | MUST `yamlDoc`에 `{type:"renameParallelVar", branchName, oldName, newName}` Edit variant 추가: (a) 이름이 `branchName`인 **모든** top-level parallel branch(여러 parallel 노드에 동명 branch가 있으면 **전부**, 엔진 branch-이름 합침 §3-1) `steps` 서브트리에서 `extract[].var===oldName`→newName(**branch-스코프**, 전-트리 아님·bare-scalar-any-match 금지), (b) 그 **동명 branch 전부(여러 노드 포함)**의 각 `steps` 서브노드에 `visit(stepsNode,{Scalar})`로 bare `{{oldName}}`/`{{oldName:cast}}` base만 재작성(슬라이스 A와 동일 lookahead-대칭 정규식·`CAST_KEYWORDS` import·cast/공백/나머지 byte 보존·map 키 미오염), (c) 전-doc에서 `{{branchName.oldName}}`→`{{branchName.newName}}`(base `B.old` 정확일치 — `{{B.oldX}}`/`{{BX.old}}`/`{{B.old.z}}` 불매치·cast/공백/byte 보존). | `yamlDoc.renameParallel.test.ts`: (a) 이름-격리(**다른 이름** branch `C`의 동명 extract `s` 무오염)·**다중 노드 동명 branch 전부 적용**(두 parallel 노드의 branch `B` extract `s`·내부 bare 둘 다 재작성)·(b) 분기 내부 bare만·분기 밖 bare 무오염·(c) namespaced 정확일치·cast/따옴표/공백 보존·헤더/JSON 키 무오염 | |
| R6 | MUST rename edit은 **트랜잭셔널**(슬라이스 A/`reparentStep` 선례 — doc clone→apply→reparse/검증 통과 시에만 커밋, 실패 시 롤백·`yamlError` 무오염)이고 `yamlError` 상태에서 게이트된다. | `store.renameParallelVar.test.ts`: happy·`yamlError` no-op·롤백 시 원본 doc 무오염 | |
| R7 | MUST store `renameParallelVar(branchName, oldName, newName) → RenameVarError | null`(슬라이스 A 기존 타입 `RenameVarError`=`"self"|"invalid"|"shadow"|"collision"` 재사용, 검증 단일소스; `null`=성공·커밋됨). no-op 조건: ① newName===oldName → `"self"`; ② newName 공백/`/^[^\s{}:]+$/` 불일치 → `"invalid"`; ③ `oldName ∈ flatProducerNames`(shadow) → `"shadow"`(방어적, 패널이 애초 pencil 미표시); ④ `newName ∈ flatProducerNames`(into-shadow — 분기 bare `{{newName}}`가 모호해짐) → `"collision"`; ⑤ `${branchName}.${newName}`이 기존 distinct producer/참조로 존재(`collectNamespacedProducers` ∪ `buildVarRefIndex.keys()`) → `"collision"`; ⑥ **`newName`이 동명 branch 내부에서 이미 bare로 참조됨**(`collectBranchInternalRefs`의 `${branchName}.${newName}` 키 non-empty) → `"collision"`(슬라이스 A "이미 참조되는 이름으로 rename 차단" 불변식[`store.ts:157-161`]의 branch-스코프판 — bare-into-dangling merge 방지·되돌리기 대칭). 패널은 `"collision"`→충돌 메시지·그 외 non-null→invalid 메시지 매핑(슬라이스 A `commitRename` 동형)·self/shadow는 UI 도달 불가(self pre-guard·shadow pencil 부재). | `store.renameParallelVar.test.ts`: happy·self·invalid(빈/불법)·shadow·collision(into-shadow/namespaced 존재/**분기-내부 dangling bare**) | |
| R8 | MUST VariablesPanel의 **non-shadow parallel-extract 행**은 rename 연필(인라인 draft→Enter/blur 커밋·Escape 취소, 슬라이스 A `nameCell` 패턴)을 렌더하되 **var 부분만 편집**(`branchName.`은 고정 prefix 라벨) — commit 시 `renameParallelVar(branchName, oldVar, draft)`. 커밋 시 store 검증 실패면 인라인 에러(`ko`)·미커밋. `yamlError` 시 연필 disabled. | RTL: non-shadow parallel 행만 연필·branchName. prefix 고정·var-부분 편집·Enter 커밋·collision/invalid 인라인 에러·yamlError disabled | |
| R9 | MUST **shadow parallel-extract 행**은 연필 없음, "분기" 배지 유지하되 title을 "이름 충돌 — rename 불가" 안내(`ko`)로 명확화. | RTL: shadow 행 무연필·명확화된 title·nav(namespaced) 정상 | |
| R10 | MUST parallel 행의 사용 카운트 nav는 R4 enriched refIds를 소비(참조≥1이면 버튼·클릭→그 identity의 stepId 문서순 첫 스텝 select+scrollIntoView·재클릭 순환·0은 비버튼). flat/선언/미정의 행 nav는 슬라이스 A 동작 무변화. | RTL: non-shadow parallel 행 nav가 분기-내부→다운스트림 순 순환·shadow는 namespaced만·flat 행 회귀 없음 | |
| R11 | MUST 신규 사용자 노출 문구(shadow title·rename var-입력 aria·충돌/invalid 에러 라벨) 전부 `ko.ts`(ADR-0035), 인라인 한글/영어 0. | 하드코딩 sweep(`'"[^"]*[가-힣]'` + ternary-attr) + 리뷰 | |
| R12 | MUST 엔진/컨트롤러/proto/migration/모델(Zod)/YAML 직렬화 **형식** 0-diff — `ui/src` 밖 무접촉, `model.ts` 스키마·슬라이스 A 기존 store 액션 시그니처 무변경(추가만: `scanVars` 신규 export·`yamlDoc` Edit variant·store 액션·패널 렌더 분기). ADR 신규 없음. | diff 스코프 grep + 기존 model/yamlDoc/store/scanVars 테스트 무수정 green | |
| R13 | MUST 슬라이스 A 소비처(flat rename·flat/선언/미정의 행·nav·`DataBindingPanel`·`InsertTemplateModal`)는 동작 무변화 — 신규는 전부 additive. `collectNamespacedProducers`/`undefinedVars`/`renameVariable`(flat) 기존 시그니처·의미 불변. | 기존 scanVars/VariablesPanel/store.renameVariable/dataBinding 테스트 무수정 green | |
| R14 | SHOULD 비목표 연기 항목(§7)을 `docs/roadmap.md`에 등재. | roadmap.md diff | |

**seam 없음** — 전 요구사항이 UI 렌더/로컬 편집 한정. rename은 기존 `extract.var`/bare `{{}}`/namespaced `{{B.s}}` 참조의 *내용*만 재작성하므로 엔진이 읽는 와이어 *형식*은 불변(R5가 cast 접미·namespaced prefix를 byte-보존·base만 치환 → 엔진 파서 parity 자동 충족, 별도 TS↔Rust parity R 불요).

## 3. 핵심 통찰 (설계 근거)

1. **엔진 네임스페이스는 branch-이름 단일 키(R1)**: `runner.rs:638`이 `format!("{}.{}", branch.name, k)`로 다운스트림에 노출하므로 identity = `branch.name.var` 문자열이 엔진과 정확 대응한다. branch 이름 유니크는 **parallel 노드 내부에서만** 강제(UI Zod)라 서로 다른 parallel 노드가 같은 이름 branch를 가지면 엔진이 하나의 `B.s`로 합친다(last-write-wins in `iter_vars`) — 우리도 rename을 **branch 이름 기준**으로 모든 동명 branch에 적용해 엔진-충실을 유지한다(드문 케이스지만 rename이 엔진과 어긋나면 조용한 손상). `B.s` 문자열을 분해하지 않고 구조적 `{branchName, varName}`를 흘리는 이유 = branch/var 이름 모두 `.`을 포함할 수 있어(`var`는 `[^\s{}:]+`) 문자열 split이 모호하다.

2. **분기 clone-후-namespace-merge 의미가 scope-aware rename을 강제(R5)**: 각 분기는 entry `iter_vars`의 **clone** 위에서 실행(`runner.rs:594`)하고 extract 쓰기는 branch-local, 종료 후 `{{branch.var}}`로 merge된다(`runner.rs:638`). 따라서 분기 extract `s`를 rename하면 **두 참조 클래스**를 함께 재작성해야 참조가 안 끊긴다: (b) 분기 서브트리 안 bare `{{s}}`(branch-local 해소) + (c) 다운스트림 `{{branch.s}}`(namespace 해소). 슬라이스 A의 global bare 재작성은 다른 분기/flat의 동명 bare를 오염하므로 **branch-스코프 visit**(그 branch `steps` 서브노드에만 `visit`)이 필수다.

3. **보수적 non-shadow gate로 bare 재작성이 증명가능 안전(R2/R7 §②)**: non-shadow(`s ∉ flatProducerNames`)이면 분기의 `branch_vars = entry.clone()`에 `s`가 없어, 분기 안 모든 bare `{{s}}`가 (extract 전이면 undefined, 후면 branch-local) **오직 이 분기의 `(B,s)`에 귀속** → 서브트리 전역 bare 재작성이 안전(extract 전 undefined bare는 rename 후에도 undefined = 행동 보존). shadow이면 pre-extract bare가 entry `s`를 가리켜 위치 의존 → rename 비활성(사용자 결정). 다중-분기 동명(`s`가 여러 분기서 추출·flat 없음)은 non-shadow — 각 분기 서브트리가 disjoint라 branch-스코프 재작성이 자연히 격리(`B.s`/`C.s` 독립).

4. **충돌 정책은 슬라이스 A 미러 + into-shadow 추가(R7)**: A의 "이미 존재하는 어떤 참조/producer 이름으로도 차단"(비-merge·예측가능·되돌리기 대칭)을 namespaced 형(`${branchName}.${newName}`)에 적용하고, **into-shadow**(newName이 flat producer → rename 후 분기 bare `{{newName}}`가 다시 모호)를 추가 차단한다. 되돌리기 = newVar→oldVar 재rename(대칭).

5. **패널은 구조적 identity 소비·nav enrich(R4/R8/R10)**: 슬라이스 A의 parallel 행은 `collectNamespacedProducers`(문자열 set)를 순회했고 nav는 namespaced 참조만 봤다(분기-내부 bare non-navigable). B는 구조적 `parallelVarIdentities`를 순회해 shadow 판정·branch-내부 refIds를 함께 얻고, non-shadow 행의 nav를 `분기-내부 ∪ 다운스트림`으로 enrich해 갭을 해소한다. `collectNamespacedProducers`/`undefinedVars`는 무변경(R13) — B의 신규 분석은 additive.

6. **getSnapshot 함정 회피(슬라이스 A와 동일)**: 셀렉터는 `s.model` 전체 참조·파생은 `useMemo([model])` 1회·`model===null`이면 즉시 `[]`(ui/CLAUDE.md: 셀렉터 안 인라인 `?? {}` fallback 금지). 신규 분석도 이 메모 안에서 호출.

## 4. 변경 상세

### 4.1 `scenario/scanVars.ts` — 충족 R: R1, R2, R3, R4, R13
- **`flatProducerNames(scenario): Set<string>`(신규)**: 선언 키 ∪ parallel `branches`를 **미하강**하는 트리 워크(loop `do`/if `then`·`elif[].then`·`else` 하강)의 http extract var. (R2)
- **`collectBranchInternalRefs(scenario): Map<string, string[]>`(신규)**: 이름이 `B`인 모든 top-level parallel branch의 `steps` 서브트리에서 `buildVarRefIndex`와 동일한 참조 수집(url/header/body + 내부 컨테이너 재귀·cast 정규화)으로 **bare 이름**(`splitFlowToken` base에 `.` 없음)을 모아 `${B}.${bareName}` 키·문서순 stepId. 분기 내부에서 자기 extract는 항상 bare `{{s}}`로 참조되므로(namespaced `{{B.s}}`는 merge 후 다운스트림에만 존재) 이 함수는 **분기 내부 bare만** 담는다 — 다운스트림 namespaced는 기존 `buildVarRefIndex`가 담당(R4에서 합류). (R3)
- **`parallelVarIdentities(scenario): {branchName; varName; display; isShadow; branchRefIds; namespacedRefIds}[]`(신규 구조적)**: top-level parallel 노드의 각 branch × 각 http extract var마다 1행. `display=${branchName}.${varName}`·`isShadow=flatProducerNames.has(varName)`·`branchRefIds=collectBranchInternalRefs.get(display) ?? []`·`namespacedRefIds=buildVarRefIndex.get(display) ?? []`. 같은 `display` 중복은 dedup(동명 branch 여러 노드/여러 스텝에서 같은 var 추출). (R1/R4)
- 기존 `collectNamespacedProducers`·`undefinedVars`·`buildVarRefIndex`·`parallelExtractNames`·flat 관련 export **무변경**(R13). 신규 3함수만 추가.

### 4.2 `scenario/yamlDoc.ts` — 충족 R: R5, R6
- `Edit`에 `{type:"renameParallelVar", branchName, oldName, newName}` 추가. apply(트랜잭셔널 — clone→검증은 store가):
  - **(a)** `steps`를 하강(searchSeq 형)하며 top-level parallel 노드의 `branches[]` 중 `name===branchName`인 **모든** branch(여러 노드 포함)의 `steps`에만 `renameExtractVars(branchSteps, oldName, newName)` 적용(슬라이스 A `renameExtractVars` 재사용·branch-스코프).
  - **(b)** 그 **매칭 branch들 각각**의 `steps` 노드에 `visit(stepsNode, {Scalar})`로 슬라이스 A와 **동일한** `` `\{\{(\s*)${escapeRegExp(oldName)}(?=\s*\}\}|\s*:\s*(?:${CAST_KEYWORDS.join('|')})\s*\}\})` ``로 bare base만 치환(map 키 `key==="key"` skip). extract `var:` 스칼라는 `{{}}` 미포함이라 이 정규식에 미매치(안전).
  - **(c)** 전-doc `visit`로 namespaced base 치환: `` `\{\{(\s*)${escapeRegExp(branchName)}\.${escapeRegExp(oldName)}(?=\s*\}\}|\s*:\s*(?:${castAlt})\s*\}\})` `` → `{{ws${branchName}.${newName}`. base가 정확히 `B.old`일 때만(`{{B.oldX}}`/`{{B.old.z}}` 불매치 — lookahead가 `}}` 또는 `:cast}}` 경계 요구).
- `escapeRegExp` 기존 헬퍼 재사용. branch `steps` 노드 탐색 헬퍼(top-level parallel branches walk)는 지역.

### 4.3 `scenario/store.ts` — 충족 R: R6, R7
- `renameParallelVar(branchName, oldName, newName): RenameVarError | null` 액션: 슬라이스 A `renameVariable`의 **인라인 트랜잭셔널 패턴**(제네릭 `dispatch` 금지 — 비트랜잭셔널; `yamlError` 체크→`doc.clone()`→`applyEdit(clone, {renameParallelVar})`→reparse/검증→성공 시에만 커밋) 미러. 검증 순서 R7 §①~⑥. 통과 시 커밋, 실패 시 코드 반환·원본 무오염.
- 검증 헬퍼는 `parallelVarIdentities`/`flatProducerNames`/`buildVarRefIndex`/`collectBranchInternalRefs`(R7 §⑤ bare-into-dangling, 4.1) 재사용.

### 4.4 `components/scenario/VariablesPanel.tsx` — 충족 R: R8, R9, R10, R11
- `rows` useMemo에서 parallel 행 소스를 `collectNamespacedProducers` 순회 → **`parallelVarIdentities` 순회**로 교체. `VarRow`의 `parallel-extract` variant를 `{kind:"parallel-extract"; branchName; varName; display; isShadow; refIds}`로 확장(refIds=R4 enriched). declared/flat/undefined variant 무변경.
- 렌더:
  - **non-shadow parallel 행**: `branchName.` 고정 prefix span + var 부분 `nameCell`류 rename 연필(편집 시 draft input, commit→`renameParallelVar(branchName, varName, draft)`; 인라인 에러 `ko.editor.variableRenameCollision`/`variableRenameInvalid`; yamlError disabled). "분기" 배지 유지. nav 카운트(enriched refIds).
  - **shadow parallel 행**: 슬라이스 A 그대로(연필 없음) + 배지 title을 `ko.editor.variableBranchShadowTitle`("이름 충돌 — rename 불가")로. nav(namespaced) 정상.
- **편집 대상 식별은 판별(discriminated) 키로 — 문자열 display로 키하지 말 것(F1)**: flat 변수 이름이 리터럴 `B.s`일 수 있어(선언 키·`ExtractModel.var`=`z.string().min(1)`, charset 무제한) flat 행 `name==="B.s"`와 parallel 행 `display==="B.s"`(branch `B`·var `s`)가 **동시 렌더 가능** → `editing`을 `display`/`name` 문자열로 키하면 두 행이 동시에 편집모드로 들어가고 commit이 `renameVariable`/`renameParallelVar`를 못 가른다. `editing` state를 **`{kind:"flat"; name} | {kind:"parallel"; branchName; varName} | null`** 로 바꾸고 행 비교·commit 라우팅을 이 판별 키로 한다(React 렌더 key가 이미 `d:`/`f:`/`p:`/`u:` prefix인 것과 정합). **같은 collision이 `cycleRef`(nav 순환 인덱스, `VariablesPanel.tsx:36,89-91`)·`usageCell` aria에도 있으니** identity 키를 prefix형(`f:${name}`/`p:${display}`/…)으로 통일한다.
- **parallel commit은 별 핸들러**: 슬라이스 A `commitRename`(flat, `renameVariable` 호출)을 오버로드하지 말고 `commitRenameParallel(branchName, oldVar)`(→`renameParallelVar`)를 분리 — 에러 코드 매핑(`"collision"`→`variableRenameCollision`·`"invalid"`→`variableRenameInvalid`)은 재사용. self(`draft===oldVar`)/빈은 A처럼 커밋 전 no-op(취소), shadow는 pencil 미표시라 도달 불가(store §② 방어).
- 신규 문구 `ko.ts`.

### 4.5 `i18n/ko.ts` — 충족 R: R11
- 신규 키: `variableBranchShadowTitle`("이름 충돌 — 이름 바꾸기 불가", shadow 행 배지 title)·`variableBranchInfoTitle`(non-shadow 행 배지 title — 다운스트림 `{{분기명.변수}}` 네임스페이스 안내). 기존 `variableBranchTitle`(all-parallel "이름 바꾸기 미지원")은 non-shadow가 rename 가능해져 **제거**하고 위 두 title로 분기.
- rename 연필/입력 aria·충돌/invalid 에러(`renameVariableAria`·`variableRenameInputAria`·`variableRenameCollision`·`variableRenameInvalid`)는 인자가 string 보간이라 `display`를 넘겨 **재사용**(신규 aria 키 불요 — identity는 display 문자열이 운반).

## 5. 컨텍스트 경계 (의도적 단순화)

- **cast 경계는 슬라이스 A와 동일**: base 규칙(`:kw`는 어디서나 cast 간주)을 컨텍스트 무관 균일 적용 — scan과 rename이 같은 base 규칙을 쓰는 일관성이 우선(엔진은 cast를 JSON leaf에서만 적용하지만 이 도구 범위 밖). R5의 (b)/(c) 정규식이 슬라이스 A와 by-construction 대칭.
- **branch-이름 스코프의 다중-노드 합침**: 서로 다른 parallel 노드의 동명 branch는 하나의 identity로 rename됨(§3-1, 엔진-충실). 이는 드문 authoring이며, 원치 않으면 branch 이름을 구분해야 한다(도구 범위 밖).
- **shadow는 rename 비활성**(§2 결정). 분기 내부 bare가 flat/declared와 이름 충돌하면 위치 의존 모호 → 배지 유지.
- **F4(수용): namespaced nav의 분기-내부 mis-authored `{{B.s}}` 누출** — 분기가 자기 namespaced 형(`{{B.s}}`, merge 전엔 undefined)을 오작성하면 `namespacedRefIds`(=`buildVarRefIndex.get("B.s")`)에 그 내부 stepId가 낀다. nav가 실재 참조로 점프할 뿐이라 무해(드문 오작성) — 별도 필터 안 함.
- **F5(수용, 슬라이스 A와 동형): `parallelVarIdentities`의 identity 수집은 `flattenHttpSteps`(재귀)** — 엔진 `Branch::output_var_names`(`scenario.rs:153-167`)는 branch 직속 http만 보지만, UI Zod가 branch를 http-only(`BranchModel=z.array(HttpStepModel)`)로 강제하므로 재귀-vs-직속 차이는 유효 시나리오에서 발현 불가(중첩 branch YAML은 parse 실패→model=null→패널 빈). 슬라이스 A `collectNamespacedProducers`와 같은 패턴 — plan은 재귀에 identity를 의존하지 말 것.
- **F6(plan nicety): `buildVarRefIndex` 중복 계산** — 패널 useMemo가 이미 1회 계산(`VariablesPanel.tsx:44`), `parallelVarIdentities`가 내부에서 또 계산. 정확성 무관, plan에서 index를 인자로 threading 가능(선택).

## 6. 테스트 전략

- **`scanVars.test.ts`(확장)**: R1(동명-branch 합침·`.` 포함 var·구조 보존)·R2(flat vs parallel-only·loop/if 내부 flat·다중분기 non-shadow)·R3(분기 내부 bare·다운스트림 미포함·분기 미교차·cast 정규화)·R4(enriched refIds non-shadow/shadow).
- **`yamlDoc.renameParallel.test.ts`(신규)**: R5 (a)~(c) 각 클래스·branch-스코프 격리(다른 branch/flat 동명 무오염)·**다중 노드 동명 branch 전부 적용**(두 parallel 노드의 branch `B` extract+내부 bare 둘 다)·분기 밖 bare 무오염·namespaced 정확일치(`{{B.oldX}}`/`{{B.old.z}}` 불매치)·cast/따옴표/공백/헤더키/JSON키 보존.
- **`store.renameParallelVar.test.ts`(신규)**: R6(happy·yamlError no-op·롤백 무오염)·R7(invalid: 빈/불법/self/shadow; collision: into-shadow/namespaced 존재/동-branch 동명/**분기-내부 dangling bare**).
- **`VariablesPanel.test.tsx`(확장)**: R8(non-shadow 연필·prefix 고정·var 편집·Enter 커밋·인라인 에러·yamlError disabled)·R9(shadow 무연필·title)·R10(non-shadow nav 분기-내부→다운스트림 순환·shadow namespaced만·flat 회귀 없음).
- **회귀(R13)**: 기존 scanVars/VariablesPanel/store.renameVariable/dataBinding/insertTemplate 테스트 무수정 green.
- **라이브 검증**: 순수 에디터-타임 — 에디터는 client-only라 백엔드 불필요(슬라이스 A와 동일, vite dev `localhost:5173`). Playwright로 parallel 노드(branch `B`: `s` 추출·내부 bare `{{s}}`·다운스트림 `{{B.s}}`) 구성 → var rename `s`→`s2` → **스텝 폼 필드/파생 패널 상태**로 재작성 실측(Monaco `.view-line` read-miss 금지, ui/CLAUDE.md): 분기 스텝 필드 `{{s2}}`·다운스트림 `{{B.s2}}`·패널 행 `B.s2`·shadow 행 badge/pencil-부재.

## 7. 비목표 (연기)

- **bulk 변수 편집**(BulkEditPanel/kvBulk 확장) — 별 메커니즘·별 슬라이스.
- **FlowOutline 스텝-레벨 미정의 배지** — 패널 밖 표면(슬라이스 A R11이 패널-한정 유지).
- **producer 스텝으로의 nav** — 현 nav는 참조(consumer)로만.
- **shadow(이름 충돌) 변수의 position-aware rename** — 분기 내 참조 위치 분석 필요·correctness 위험·드문 authoring(사용자: non-shadow만).
- **shadow flat+parallel의 flat-identity 행 복원**(bare 참조 navigable화) — shadow 모호성을 다시 들여 보수성과 상충.
- **merge/오타-재연결 rename**(충돌 차단 정책과 상충) — A/B 공통 연기.

이상 §7은 `docs/roadmap.md` §B15(신규)에 등재(R14).

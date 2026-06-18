# 스텝 템플릿 관리 페이지 + 삽입 시 변수 파라미터화 — 재사용 라이브러리 편의 (QoL 트랙 §B10)

- **날짜**: 2026-06-18
- **상태**: 설계 승인(사용자 2026-06-18) → plan 대기
- **출처**: roadmap §B10/§B8 연기 항목. **왜 지금**: "내부 테스트 — 편리함에 집중" 단계. 팀 스텝-템플릿 라이브러리가 커지면 삽입 모달 내 최소 관리(삭제)만으론 부족하고(전용 페이지), 다른 시나리오에 삽입할 때 토큰이 대상 데이터 흐름과 어긋나는 마찰(파라미터화)을 해소한다.
- **연관**: `2026-06-12-step-templates-design.md`(v1, ADR-0036), `EnvironmentsPage.tsx`(관리 페이지 미러), `InsertTemplateModal.tsx`/`SaveTemplateDialog.tsx`(삽입/저장), `scanVars.ts`(토큰 스캔), `yamlDoc.ts`(`prepareTemplateInsertion`/`reissueStepIdsInFragment`).
- **ADR**: 신규 불필요(ADR-0036 범위 내 — 관리 페이지·파라미터화는 그 spec §B8/§B10에 명시된 연기 후속). UI-only·additive.

---

## 1. 문제와 목표

스텝 템플릿(ADR-0036) v1은 삽입 모달 안에서 목록/삭제만 제공하고, 삽입은 **as-is 복사**다. 라이브러리가 커지면 (a) 이름·설명 정리·미리보기·삭제를 할 전용 화면이 없고, (b) 한 시나리오에서 만든 템플릿을 다른 시나리오에 넣을 때 `{{token}}`/`${ENV}` 토큰이 대상 시나리오의 변수명과 안 맞아 손으로 고쳐야 한다.

- **목표**:
  1. `/templates` 관리 페이지(`EnvironmentsPage` 미러) — 목록 / 이름·설명 편집 / 읽기전용 스텝 미리보기 / 삭제.
  2. 삽입 시 **파라미터화 다이얼로그** — 템플릿의 `{{var}}`·`${ENV}` 토큰을 토큰별로 *그대로 유지 / 이름 재바인딩 / 리터럴로 교체*. **자동 추측 없음**(전부 기본 "유지").
- **비목표(연기)**: §7 참조. 본문(steps) 직접 편집·관리 페이지 내 생성·저장형 파라미터 스키마·컨테이너 내부 삽입 등.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

> UI-only 슬라이스라 스키마 계약 *변경*은 없다. 다만 R11/R12는 기존 엔진 `Vec<Step>` YAML 형식·editor Zod 모델과의 **형식 보존**(round-trip)이 load-bearing이라 `seam ✅`로 표시한다(계약이 바뀌지 않음을 보장).

### 관리 페이지 (A)

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance | seam? |
|---|---|---|---|
| R1 | MUST `/templates` 라우트 + 네비 링크(`ko.nav.stepTemplates`)를 추가하고(top-level peer라 **breadcrumb 없음** — `Breadcrumb.tsx`는 시나리오 하위페이지 전용, Environments/Datasets/Schedules/Settings 동일), 모든 스텝 템플릿을 표(이름·스텝 수·설명·수정시각·액션)로 나열한다. | RTL: `TemplatesPage` 마운트 시 `useStepTemplates` 목록 행 렌더; 라우트 존재(`routes.tsx`); breadcrumb 미사용. | |
| R2 | MUST 템플릿의 이름·설명을 편집 폼에서 수정하되, PUT 본문은 **기존 `steps_yaml`을 변경 없이 그대로 재전송**한다(본문은 페이지에서 편집 불가). 편집 진입은 `getStepTemplate(id)` imperative 로드(reseed-effect race 회피). | RTL: 이름만 바꿔 저장 → `updateStepTemplate` 인자의 `steps_yaml`이 로드값과 동일; 저장 후 미리보기 스텝 불변. | ✅ `StepTemplateBody` 기존 계약 재사용(무변경) |
| R3 | MUST 편집 패널에 **읽기전용 스텝 미리보기**(최상위 스텝마다 `{name} ({typeLabel})`, http는 method·url 요약)를 렌더하고, `parseStepsFragment` 실패 시 raw YAML 폴백. | RTL: 미리보기에 스텝명·타입 라벨·method/url 텍스트 존재. | |
| R4 | MUST 삭제는 `window.confirm` 후 무가드 DELETE(복사-스냅샷, ADR-0036) + 실패 시 `role="alert"` 배너. 확인 카피는 기존 `InsertTemplateModal`과 동일한 `ko.stepTemplates.deleteConfirm` 재사용(드리프트 방지). | RTL: confirm accept → `deleteStepTemplate` 호출·목록 invalidate; 에러 시 배너. | |
| R5 | MUST 관리 페이지에 템플릿 **생성 affordance를 두지 않는다**(생성은 스텝 컨텍스트가 필요해 에디터 `SaveTemplateDialog`에만 — `EnvironmentsPage`와 의도적 비대칭). | 코드: 페이지에 "새 템플릿"/create 경로 없음(리뷰 확인). | |
| R6 | MUST 이미 있는 이름으로 rename 시 409(`StepTemplateConflictError`)를 `role="alert"` 배너로 노출(덮어쓰기-병합 없음 — 다른 이름 선택 유도). | RTL: 중복 이름 PUT → 409 throw → 배너 문구. | |
| R7 | MUST 템플릿이 없을 때 `EmptyState`(에디터 "템플릿으로 저장" 안내)를 표시. | RTL: 빈 목록 → `ko.empty.stepTemplates` 렌더. | |

### 삽입 시 파라미터화 (B)

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance | seam? |
|---|---|---|---|
| R8 | MUST 순수 `scanTemplateTokens(stepsYaml) → {flow:string[], env:string[]}`가 **`parseDocument`+`visit`(yaml 패키지) 스칼라 경로**(Zod/ULID 게이트 우회 — `parseStepsFragment`은 비-ULID step-id 템플릿을 거부하므로 금지)로 `{{var}}`·`${NAME}`·`${NAME:-default}`를 두 네임스페이스로 스캔하되, **예약 시스템 변수(`vu_id`/`iter_id`/`loop_index` — `EnvironmentsPage.RESERVED` 재사용)는 env 목록에서 제외**(중복 제거, 발견 순). | unit: 혼합 본문 flow/env 정확 추출, `${A:-x}`는 `A`만, `${vu_id}` 제외, 중복 1회, 비-ULID step-id 본문도 스캔 성공. | |
| R9 | MUST 토큰이 있을 때 토큰별 치환 UI(flow/env 두 섹션)를 보이고, **각 토큰 기본값 = 그대로 유지**, 선택지 = 유지 / 다른 이름으로 / 값으로 교체. 예약 시스템 env 토큰은 행으로 노출하지 않는다(R8에서 제외). | RTL: 토큰 행 렌더, 기본 라디오=유지, 3택 동작, `${vu_id}` 행 부재. | |
| R10 | MUST 토큰이 **없는** 템플릿은 다이얼로그 없이 즉시 삽입(현 v1 경로). | RTL: 무토큰 템플릿 "삽입" → 폼 미표시, 곧장 `insertTemplateSteps`. | |
| R11 | MUST 순수 `applyTokenSubstitutions(stepsYaml, subs) → stepsYaml'`가 **YAML Document 스칼라 방문**으로 토큰 자리만 치환(주석·구조 보존; rename=괄호 유지 새 이름·env `:-default` 보존; literal=토큰 전체를 YAML-safe 스칼라로 — Document API set, 문자열 concat 금지). | unit: rename·literal·env-default·주석보존 골든. | ✅ 출력이 엔진 `Vec<Step>` serde + editor Zod 모두 round-trip |
| R12 | MUST (불변식) **전부-유지(identity) subs = no-op = 입력과 byte-identical**, 그리고 그 결과 삽입은 현재 v1 삽입과 동일 fragment. | unit: `applyTokenSubstitutions(y, allKeep) === y`; 회귀: identity 삽입 == 무파라미터 삽입. | ✅ byte-identical 보존 |
| R13 | MUST rename 타깃 검증(비어있지 않음; flow=`{`/`}` 금지; env=추가로 공백·`:` 금지) 위반 시 삽입 비활성 + 인라인 경고; rename 입력에 대상 시나리오의 **기존 변수명** datalist 힌트(flow=`scanFlowVars(model)`+`model.variables`, env=**신규 env 스캐너**[기존 없음 — `scanTemplateTokens`의 env 로직을 현 시나리오 steps에 적용, 예약 제외]; `model===null` 가드; best-effort·자동적용 아님). | RTL: 잘못된 이름→삽입 disabled; flow datalist에 `scanFlowVars` 이름 존재; `model===null`이면 힌트 없이 동작. | |
| R14 | MUST 파라미터화는 `InsertTemplateModal` **2-phase 단일 Modal**(목록↔폼 내용 교체)로 — **중첩 Modal 금지**(ESC 레이어링 함정, `ui/CLAUDE.md`). | 코드: 폼이 별도 `<Modal>`이 아니라 같은 Modal 내 분기; RTL ESC 1회 닫힘. | |
| R15 | MUST 신규 사용자노출 문구는 전부 `ko.ts` 경유(ADR-0035), 변수 든 문구는 `(으)로` 병기형. | 코드: 하드코딩 문구 0(리뷰); 변수 문구 RTL 정규식 `\(으\)로`. | |

- **seam 메모**: R2는 기존 `StepTemplateBody`(name/description/steps_yaml) 계약을 *변경 없이* 재사용(본문 보존 재전송). R11/R12는 새 와이어가 아니라 **기존 형식 보존**이 핵심 — 치환 출력이 (a) 삽입 시 editor Zod 모델, (b) 이후 run 시 엔진 `Vec<Step>` serde 양쪽을 통과해야 한다(R13 검증 + R11 YAML-safe set이 보장). 최종 `handicap-reviewer`가 골든 출력으로 양쪽 round-trip 확인.

---

## 3. 핵심 통찰 (설계 근거)

1. **자동 매핑이 위험의 핵심 → 전부 identity 기본**(R9, R12). 사용자 우려(2026-06-18): 재바인딩을 자동 추측하면 잘못 매핑될 수 있다. 그래서 다이얼로그는 *아무것도 추측하지 않고* 모든 토큰을 "유지"로 두며, 사용자가 토큰별로 명시 선택한다. 잘못된 걸 바로잡을 수단(재바인딩·리터럴)은 다 있지만 silently-wrong 경로 자체가 없다. datalist는 *힌트*일 뿐 자동적용 아님(R13).
2. **치환은 Document 레벨**(R11) — raw 문자열 regex 치환은 주석·키·구조를 오염시킨다. `reissueStepIdsInFragment`와 동형으로 `yaml` Document의 스칼라 노드만 방문해 토큰 자리를 바꾸면 주석/구조 보존 + literal은 Document API가 인용 처리해 YAML-safe(엔진 serde·editor Zod round-trip 보장).
3. **백엔드는 손대지 않는다** — CRUD(insert/get/list/update/delete) + REST + `stepTemplates.ts` 클라 + `useStepTemplates/Create/Update/Delete` 훅이 v1에서 이미 완비. 관리 페이지는 순수 소비처, 파라미터화는 삽입 전 클라 변환(서버 왕복 0).
4. **관리 페이지 = `EnvironmentsPage` 미러, 단 생성 없음**(R5) — 템플릿 생성은 스텝 컨텍스트(에디터 모델·선택)가 필요해 페이지에선 불가. v1의 에디터 `SaveTemplateDialog`가 유일 생성 경로로 남는다. 편집은 본문 전체 교체 PUT이지만 페이지는 메타만 바꾸고 본문은 보존-재전송(R2)해 "이름변경"에 한정.
5. **2-phase 단일 Modal**(R14) — `ui/CLAUDE.md`: Modal 안에 Modal을 넣으면 capture-phase ESC가 어긋난다. 그래서 파라미터 폼은 `InsertTemplateModal`의 두 번째 phase(내용 교체)로 둔다.

---

## 4. 변경 상세

> 전부 `ui/` — 충족 R 태그로 역추적.

### 4.1 순수 `ui/src/scenario/templateParams.ts` (신규) — 충족 R: `R8, R11, R12`
- `scanTemplateTokens(stepsYaml: string): { flow: string[]; env: string[] }` — **`parseDocument`+`visit`(yaml 패키지, 신규 `templateParams.ts`가 `yaml`에서 직접 import)로 스칼라만 방문**(Zod/ULID 게이트 우회 — `parseStepsFragment`은 비-ULID step-id 템플릿을 거부하므로 금지). flow=`scanVars`의 `{{ }}` 정규식 재사용, env=`\$\{\s*([^}:]+?)\s*(?::-[^}]*)?\}`. **예약 시스템 변수(`vu_id`/`iter_id`/`loop_index`)는 env에서 제외**. dedup·발견 순. (현 시나리오 datalist용 env 스캔도 이 env 로직 공유 — R13.)
  - **의도적 엣지(안전 방향)**: `${a:b}`(`:-` 아닌 bare 콜론) 형은 env 정규식이 매칭 안 해 스캔에서 누락 → 그 토큰은 identity(그대로) 유지. 엔진은 `a:b`를 통째 이름으로 보지만(template.rs:128), `validate_env`가 `:` 키를 거부하므로 이런 토큰은 raw-YAML/curl 작성에서만 발생하고, 실패 모드가 "재바인딩 미제공=안전 기본"이라 무해(UI가 엔진보다 보수적 = `ui/CLAUDE.md` JSON-cast 비대칭과 동류). 비목표.
- `Substitution = { kind: "keep" } | { kind: "rename"; to: string } | { kind: "literal"; value: string }`; `SubMap = { flow: Record<string,Substitution>; env: Record<string,Substitution> }`.
- `applyTokenSubstitutions(stepsYaml, subs): string` — `parseDocument` → `visit` 스칼라 → 각 스칼라 string에서 토큰을 찾아 치환(rename: `{{old}}`→`{{to}}`/`${OLD}`→`${TO}`·`:-default` 보존, literal: 토큰 매치 전체→value). 전부 keep이면 입력 그대로 반환(R12 — 변환 자체를 건너뛰어 직렬화 정규화도 회피).

### 4.2 `ui/src/components/scenario/InsertTemplateModal.tsx` — 충족 R: `R9, R10, R13, R14`
- phase state(`"list" | "params"`) + 선택 템플릿 보관. `handleInsert`: `getStepTemplate` → `scanTemplateTokens` → 토큰 0이면 기존 경로(`prepareTemplateInsertion`→`insertTemplateSteps`), 아니면 `phase="params"`.
- params phase: flow/env 섹션, 토큰별 라디오(유지/이름/리터럴) + 입력 + datalist 힌트(flow=`scanFlowVars(model)`+`model.variables`; env=신규 스캐너[기존 `${}` 스캐너 없음 — `scanTemplateTokens` env 로직 재사용, 예약 제외]). `model===null` 가드(`store.model: Scenario|null`). 확인 → `applyTokenSubstitutions` → 기존 prepare/insert 흐름. 검증 위반 시 확인 비활성.
- 기존 삭제 버튼은 유지(무해; 관리 페이지가 주 관리 표면 — §7 cleanup 후보).

### 4.3 `ui/src/pages/TemplatesPage.tsx` (신규) — 충족 R: `R1, R2, R3, R4, R6, R7`
- `EnvironmentsPage` 구조 미러: `<h2>{ko.nav.stepTemplates}</h2>` 헤더(**breadcrumb 없음**) + 목록 표 + 편집 폼(mode `none|edit`, **new 없음** R5) + `EmptyState`. `startEdit`=`qc.fetchQuery(getStepTemplate)`로 name/description/steps_yaml 로드. `save`=`updateStepTemplate({id,{name,description,steps_yaml:로드값}})` + `onError` 배너(409 포함 R6). 삭제는 `ko.stepTemplates.deleteConfirm` 재사용(R4). 미리보기=`parseStepsFragment(steps_yaml)`→스텝 요약(`SaveTemplateDialog.stepLabel` 패턴, http는 method/url 추가); 파싱 실패(비-ULID step-id 등) 시 raw YAML 폴백(R3).

### 4.4 `routes.tsx` · `Layout.tsx` — 충족 R: `R1`
- `{ path: "templates", element: <TemplatesPage /> }`; 네비 `<Link to="/templates">{ko.nav.stepTemplates}</Link>`. **breadcrumb 없음**(top-level peer — Environments/Datasets/Schedules/Settings와 동일; `Breadcrumb.tsx`는 시나리오 하위페이지 전용).

### 4.5 `ui/src/i18n/ko.ts` — 충족 R: `R15`
- `ko.nav.stepTemplates`, `ko.pages.stepTemplates*`, `ko.empty.stepTemplates*`(**기존 `ko.templates`=시나리오 시작 갤러리와 혼동 방지 위해 `stepTemplates` 접두**) + `ko.stepTemplates`에 관리(편집/미리보기; 삭제확인은 기존 `deleteConfirm` 재사용) + 파라미터화(섹션 제목·3택 라벨·datalist 안내·검증 경고) 문구 가산.

---

## 5. 무변경 / 불변식 (명시)

- **엔진·워커·proto·controller·migration·백엔드 라우트·`StepTemplateBody`/`stepTemplates.ts` 클라·훅 무변경** — 머지 diff = `ui/` 한정(+spec/plan docs).
- **무토큰 템플릿 삽입 = 현재 v1과 byte-identical**(R10) — 다이얼로그 미표시·기존 `prepareTemplateInsertion`/`insertTemplateSteps` 경로.
- **전부-유지(identity) 파라미터화 = no-op = byte-identical fragment**(R12).
- **예약 시스템 변수(`vu_id`/`iter_id`/`loop_index`)는 파라미터화 대상이 아니다**(R8 제외) — 엔진이 런타임 시스템 값으로 해석(`template.rs`)하므로 rename/literal로 덮으면 안 됨(`EnvironmentsPage.RESERVED` 의미론과 일치).
- `InsertTemplateModal`의 기존 삭제·목록 동작 보존(파라미터 phase는 가산).
- `SaveTemplateDialog`(에디터 생성 경로) 무변경.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1 | RTL `TemplatesPage` 목록 렌더 + 라우트 존재 | |
| R2 | RTL 이름만 수정 → PUT `steps_yaml`==로드값; 미리보기 불변 | |
| R3 | RTL 미리보기 스텝명·타입·method/url 텍스트 | |
| R4 | RTL confirm→delete 호출; 에러 배너 | |
| R5 | 코드 리뷰: create 경로 없음 | |
| R6 | RTL 중복 이름→409 배너 | |
| R7 | RTL 빈 목록→`ko.empty.stepTemplates` | |
| R8 | unit: 토큰 스캔(flow/env·default형·dedup) | |
| R9 | RTL: 토큰 행·기본 유지·3택 | |
| R10 | RTL: 무토큰→직접 삽입(폼 미표시) | |
| R11 | unit: rename/literal/env-default/주석보존 골든 | |
| R12 | unit: identity no-op == 입력; 회귀 identity 삽입==무파라미터 삽입 | |
| R13 | RTL: 잘못된 rename→삽입 disabled; datalist 힌트 | |
| R14 | RTL: 단일 Modal phase 교체; ESC 1회 닫힘 | |
| R15 | 코드 리뷰 + RTL `(으)로` 병기 정규식 | |

- **라이브 검증: waived.** production diff가 run-생성·report-파싱·엔진 경로를 **안 건드린다**(S-D 갭은 서버 응답 파싱 한정 — 이 슬라이스는 해당 경로 무변경). 삽입→치환 load-bearing 로직은 순수함수 unit + RTL로 결정적 커버. 머지 전 `pnpm lint && pnpm test && pnpm build` 전체 1회(부분 필터 green≠전체 green, `ui/CLAUDE.md`). 근거를 build-log에 명기.
- **보안**: 리터럴 치환은 Document API로 YAML-safe set(문자열 concat 금지, R11). 엔진/요청/env-binding diff 0이라 finish-slice §0 security-reviewer는 N/A 예상(grep이 최종 판정).

---

## 7. 의도적 연기 (roadmap §B8/§B10에 누적)

- **본문(steps_yaml) 직접 편집**: 페이지에서 raw YAML 편집은 editor Zod 엄격검증 우회·invalid 위험 → 본문 변경은 에디터 "템플릿으로 저장"(덮어쓰기)로. 필요 시 별도.
- **관리 페이지 내 생성**(R5): 스텝 컨텍스트 부재 — 에디터 생성 경로 유지.
- **저장형 파라미터 스키마**(함수 인자처럼 템플릿에 파라미터 정의 저장): v1은 *기존 토큰 스캔→치환*만. 더 무거운 모델.
- **컨테이너 내부 삽입**(loop/if/parallel 안으로)·**내장 템플릿**·**버전/히스토리**·**import/export**·**검색/태그**(§B8).
- **`InsertTemplateModal` 삭제 버튼 제거**(관리 페이지로 일원화): 무해 중복이라 이번엔 유지, 후속 정리.
- **literal이 JSON body 숫자/불리언으로 캐스트**: 치환은 문자열 leaf만(엔진 0029 `{{var:num}}` 캐스트와 직교) — 리터럴은 문자열로 들어감.

---

## 8. 구현 순서 (plan 입력)

> UI-only라 cargo 게이트 무관하나 `pnpm test`(green)·`tsc -b`(`pnpm build`)는 task별 통과. 순수함수→소비처 순(테스트 선행으로 tdd-guard 자연 충족).

1. **순수 `templateParams.ts`**(R8/R11/R12) + 단위테스트(골든·identity 불변식) — 소비처 전에 계약 고정.
2. **`InsertTemplateModal` 2-phase 파라미터화**(R9/R10/R13/R14) + RTL.
3. **`TemplatesPage` + 라우트/네비**(R1–R7, **breadcrumb 없음**) + RTL — `EnvironmentsPage` 미러. 신규 `queryKeys.stepTemplate(id)` 싱글톤 키 추가(imperative edit fetch용 — 현재 `queryKeys.stepTemplates()` 목록만 존재).
4. **`ko.ts` 문구**(R15)는 1–3과 함께 그 task에서 가산(분리 커밋 불요).
5. 머지 전 전체 `pnpm lint && pnpm test && pnpm build`.

# 준비 스텝 슬라이스 A2 (에디터·test-run 화면·실행 창 안내) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

REVIEW-GATE: APPROVED

**Goal:** QA가 YAML 없이 화면에서 준비 스텝을 만들고(본 스텝 → 「준비 스텝으로 옮기기」) 고치고, test-run·사이징·실행 창이 준비 스텝을 구분해 다루게 한다.

**Architecture:** `ui/`만 고친다. `yamlDoc.ts`의 스텝 찾기(`findStepPath`)가 `setup.steps`도 찾게 해서 기존 편집 Edit를 그대로 재사용하고, 구획 사이 이동만 새 Edit 하나로 더한다. 화면은 모델 헬퍼 `allSteps`/`setupSteps`/`isSetupStep`으로 준비 스텝을 본다. trace의 준비 표지는 서버가 이미 보내는 선택 키를 UI Zod에 더해 읽는다.

**Tech Stack:** TypeScript · React · Zustand · Zod · `yaml` Document API · vitest/RTL

**목업(시각 기준, 사용자 승인 2026-11-22):** `docs/superpowers/specs/2026-11-22-vu-setup-steps-a2-mockups/a2-screens.html` — 장면 1 아웃라인(「가」 상자 안이 채택), 2 Inspector, 3 test-run, 4 안내 상자, 5 모니터·현황판. **이 파일의 CSS·마크업이 화면의 시각 기준이다**: 바탕·테두리·글자 크기와 굵기·간격·칩 모양을 목업의 값 그대로 Tailwind 클래스로 옮긴다(목업의 `--a*`는 `accent-*`, `--s*`는 `slate-*`, `--am*`는 `amber-*`). 각 task의 「목업」 줄이 가리키는 장면을 열어 보고 구현한다. 목업과 이 plan의 글이 어긋나면 목업이 이긴다(문구만은 plan의 글자가 이긴다).

**Spec:** `docs/superpowers/specs/2026-11-22-vu-setup-steps-design.md` — §7-2(D13·D15·D14), §12. US 블록은 spec 머리(「사용자 스토리 (US)」). A2 UI 자리의 원천: `docs/superpowers/specs/2026-11-22-vu-setup-steps-a2-ui-steps-table.md`.

## Global Constraints

- `crates/`·proto·마이그레이션 **0-diff**. `ui/`만.
- 문구는 전부 `ui/src/i18n/ko.ts` 경유(ADR-0035). **화면 문구에 「로그인」을 쓰지 않는다**(사용자 결정). 아래 각 task의 문구는 글자 그대로 쓴다.
- 준비 스텝이 없는 시나리오: YAML 출력·화면·요청 페이로드가 지금과 같다(기존 테스트가 그대로 통과해야 한다).
- 「준비가 있는가」는 `setupSteps(model).length > 0`으로만 판단한다(`setup` 키 유무가 아니다).
- Zustand 셀렉터 안에서 `allSteps(model)`을 부르지 않는다(매번 새 배열 → 무한 리렌더). `s.model`을 고르고 `useMemo`로 만든다.
- 새 편집 어포던스는 `yamlError !== null`이면 `disabled`.
- 「준비」 표지는 공용 컴포넌트 `SetupBadge` 하나로 그린다(Task 3이 만든다 — `ui/src/components/scenario/SetupBadge.tsx`, 글자 `ko.editor.setupBadge` = `"준비"`, 모양은 목업의 `.badge`: `rounded bg-accent-100 px-1.5 py-px text-[11px] font-semibold text-accent-800 shrink-0`). 표지를 자리마다 다시 그리지 않는다.
- 놀라운 동작을 변호하는 주석을 쓰지 않는다(working-rules §7) — 고치거나 report에 적는다.
- 회귀 테스트는 되돌려 확인한다(고친 줄을 옛 상태로 → RED → 원복 → GREEN). 결과를 task report에 적는다.
- 테스트 파일은 `__tests__/` 안에만 둔다(밖의 `*.test.ts`는 돌지 않는다). 테스트 파일을 먼저 고친 뒤 src를 고친다(`tdd-guard`).
- 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build`. 커밋은 단일 foreground 호출, `| tail` 금지, `--no-verify` 금지. 커밋 메시지 끝에 저장소의 attribution 줄을 단다(디스패치 brief가 준다).
- task report는 `.superpowers/sdd/`에만 쓴다. 워크트리 루트에 `.md`를 만들거나 `git add`하지 않는다.

## Review Focus

1. **구획 이동 뒤 YAML을 서버가 읽는가** — `setup:` 키를 새로 만든 문서가 flow 표기(`setup: { steps: [ … ] }`)로 쓰이거나 `steps: []`만 남을 때 서버(serde_yaml)가 받는지. → Task 1 block 표기 테스트 + 라이브(저장 200).
2. **하나뿐인 본 스텝을 준비로 옮기기** — 화면에서 본 스텝 0개 시나리오를 만들 수 없어야 한다(run이 쉬지 않고 돈다). → Task 1 store 가드 + Task 3 잠긴 버튼. 손으로 쓴 본 스텝 0개 YAML은 아웃라인이 깨지지 않고 그린다 → Task 2.
3. **깨진 YAML 버퍼 중 옮기기 버튼** — 눌러도 조용히 사라지지 않고 잠겨 있는지. → Task 3.
4. **행 모드 test-run에서 준비가 실패** — `rows`가 비고 `setup_steps`만 있는 응답을 화면이 「실행할 스텝이 없습니다」로만 보이지 않는지. → Task 5.
5. **모니터 미리 실행의 준비 행에서 조건·표시 추가** — A2는 이 길을 열면 안 된다(spec D15). → Task 8.

## 파일 구조

| 파일 | 책임 | task |
|---|---|---|
| `ui/src/scenario/yamlDoc.ts` | `findStepPath`가 준비 스텝도 찾음 · `removeStep`의 `setup:` 키 정리 · Edit `moveStepSection` | 1 |
| `ui/src/scenario/store.ts` | `moveStepToSection` · think 일괄 편집·`addStepExtract`가 준비 스텝도 봄 | 1 |
| `ui/src/scenario/model.ts` | `isSetupStep` · `scenarioHasThink` | 1 |
| `ui/src/components/scenario/FlowOutline.tsx` | 준비 구획 행 | 2 |
| `ui/src/components/scenario/Inspector.tsx` | 준비 스텝 편집 · 옮기기 버튼 · 기본값 안내 | 3 |
| `ui/src/scenario/thinkTime.ts` · `components/scenario/YamlFileActions.tsx` | 현황판 행 · 「내용 있음」 | 4 |
| `ui/src/api/schemas.ts` · `TestRunPanel.tsx` · `SequentialRunPanel.tsx` · `TestRunSection.tsx` · `TestFlowChips.tsx` · `EditorShell.tsx` | trace 준비 표지 | 5 |
| `ui/src/components/run/sizing.ts` · `SlotSizingHelper.tsx` · `VuSizingHelper.tsx` | 준비를 뺀 반복 측정 | 6 |
| `ui/src/components/run/setupNotices.ts`(신규) · `SetupNotices.tsx`(신규) · `RunDialog.tsx` · `ScheduleForm.tsx` | 안내 네 종류 | 7 |
| `ui/src/components/monitor/PanelEditor.tsx` · `CheckRecordDialog.tsx` · `PreviewResult.tsx` | 준비 행 이름·표지, 추가 버튼 없음 | 8 |
| `ui/src/components/report/ReportView.tsx` · `print/scenarioFacts.ts` · `print/compare/fairness.ts` | 타임아웃 안내 · 대상 시스템 · 같은 시나리오 판정 | 9 |

테스트 픽스처 — 준비 스텝 1개 + 본 스텝 1개 시나리오(여러 task가 각자 파일에 둔다):

```yaml
version: 1
name: demo
setup:
  steps:
    - id: 01HZZZZZZZZZZZZZZZZZZZZZS1
      name: 준비 요청
      type: http
      request: { method: POST, url: "${BASE_URL}/auth" }
      assert: [ { status: 200 } ]
      extract: [ { var: token, from: body, path: "$.token" } ]
steps:
  - id: 01HZZZZZZZZZZZZZZZZZZZZZB1
    name: 조회
    type: http
    request: { method: GET, url: "${BASE_URL}/orders", headers: { Authorization: "Bearer {{token}}" } }
```

---

### Task 1: 준비 스텝 쓰기 경로 (yamlDoc · store · model)

**Files:**
- Modify: `ui/src/scenario/yamlDoc.ts` (`Edit` 타입, `applyEdit`의 `removeStep` 가지, `findStepPath`)
- Modify: `ui/src/scenario/store.ts` (`setStepsThinkTime`, `addStepExtract`, 새 액션)
- Modify: `ui/src/scenario/model.ts` (`scenarioHasThink`, 새 헬퍼)
- Test: `ui/src/scenario/__tests__/setupEdit.test.ts` (신규)

**Interfaces:**
- Consumes: `setupSteps(s)`, `allSteps(s)` (`model.ts`, A1).
- Produces:
  - `findStepPath(doc, stepId)` — `["setup","steps",i]`를 **먼저** 찾고 없으면 지금처럼 `["steps", …]`. (모듈 private 그대로. 이것만으로 `setStepField`·`setStepAssert`·`setStepExtract`·`setStepsThinkTime`·`removeStep`이 준비 스텝에 동작한다.)
  - `Edit`에 `{ type: "moveStepSection"; stepId: string; to: "setup" | "steps" }`.
  - `model.ts`: `export function isSetupStep(s: Scenario, stepId: string): boolean`.
  - store: `moveStepToSection(stepId: string, to: "setup" | "steps"): void`.

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `setupEdit.test.ts`. store를 `loadFromString(픽스처)`로 채우고 액션을 부른 뒤 `getState().yamlText`와 `getState().model`을 본다. `beforeEach`에서 store를 초기화한다(`store.test.ts`의 reset 헬퍼 방식).

  | 테스트 이름 | 단언 |
  |---|---|
  | `준비 스텝의 필드를 고치면 setup.steps에 반영된다` | `setStepField(S1, ["request","url"], "/x")` → `model.setup.steps[0].request.url === "/x"`, `model.steps[0]`는 그대로 |
  | `준비 스텝의 추출·검증을 고친다` | `setStepExtract(S1, [])` → `model.setup.steps[0].extract`가 `[]`; `setStepAssert(S1, [{kind:"status",code:201}])` → 반영 |
  | `마지막 준비 스텝을 지우면 setup 키가 사라진다` | `removeStep(S1)` → `yamlText`에 `/^setup:/m` 없음, `model.setup === undefined` |
  | `준비 스텝이 둘이면 하나를 지워도 setup이 남는다` | 준비 2개 픽스처에서 하나 삭제 → `model.setup.steps.length === 1` |
  | `본 스텝을 준비로 옮기면 setup 키가 steps 앞에 block 표기로 생긴다` | 준비 없는 2스텝 픽스처에서 `moveStepToSection(첫 스텝, "setup")` → `yamlText.indexOf("setup:") < yamlText.search(/^steps:/m)`, `yamlText`에 `setup: {`·`steps: [{` 없음, `model.setup.steps.map(id)`가 `[첫]`, `model.steps.map(id)`가 `[둘째]` |
  | `준비로 옮기면 준비 구획 끝에 붙는다` | 준비 S1 + 본 스텝 2개(B1·B2) 픽스처에서 `moveStepToSection(B1, "setup")` → `setup.steps` id 순서 `[S1, B1]`, `steps`는 `[B2]` |
  | `하나뿐인 본 스텝은 준비로 옮기지 않는다` | 픽스처(본 스텝 B1 하나)에서 `moveStepToSection(B1, "setup")` → `getState().model`이 같은 참조(`toBe`). 본 스텝 2개 픽스처에서는 옮겨진다(같은 테스트에서 대조) |
  | `손으로 쓴 flow 표기 setup에 옮겨도 block 표기로 쓰인다` | `setup: { steps: [] }`는 Zod가 받는 모양(빈 목록)이므로 `setup: { steps: [] }` + 본 스텝 2개 픽스처에서 첫 스텝을 옮김 → `yamlText`에 `setup: {` 없음, `setup:` 키가 하나뿐(`match(/^setup:/gm).length === 1`), `model.setup.steps.length === 1` |
  | `준비 스텝을 본 스텝으로 옮기면 steps 끝에 붙고 마지막이면 setup 키가 사라진다` | 픽스처에서 `moveStepToSection(S1, "steps")` → `model.steps.map(id)`가 `[B1, S1]`, `model.setup === undefined`, `yamlText`에 `/^setup:/m` 없음 |
  | `옮겨도 선택과 스텝 내용이 그대로다` | 옮기기 전 `select(B1)`; 옮긴 뒤 `selectedStepId === B1`이고 옮겨진 스텝의 `request`·`extract`가 `toEqual` 원본 |
  | `옮긴 스텝 안의 주석이 따라간다` | 스텝 맵 **안쪽** 줄 끝 주석(`url: "/a" # 메모`)이 든 픽스처 → 옮긴 뒤 `yamlText`에 `# 메모` 포함 |
  | `loop 안의 스텝·컨테이너·없는 id는 옮기지 않는다` | loop 픽스처에서 자식 http id, loop id, `"nope"` 각각 → `getState().model`이 호출 전과 **같은 참조**(`toBe`) |
  | `이미 그 구획에 있는 스텝은 옮기지 않는다` | `moveStepToSection(S1, "setup")`·`moveStepToSection(B1, "steps")` → 같은 참조 |
  | `깨진 YAML 버퍼 중에는 옮기지 않는다` | `setPendingYamlText("version: [")`+`commitPendingYaml()` 뒤 호출 → `yamlText`·`model` 불변 |
  | `think 일괄 편집이 준비 스텝에도 적용된다` | `setStepsThinkTime([S1, B1], {min_ms:1,max_ms:2})` → 두 스텝 모두 `think_time` 반영 |
  | `test-run의 +추출이 준비 스텝에 붙는다` | `addStepExtract(S1, {var:"x", from:"status"})` → `model.setup.steps[0].extract`에 2개 |
  | `준비 스텝을 고른 채 템플릿을 넣으면 본 스텝 끝에 들어간다` | `select(S1)` 뒤 `insertTemplateSteps(prepared)` → 새 스텝이 `model.steps`의 마지막, `model.setup.steps.length`는 그대로 (`insertSteps.test.ts`의 `prepared` 만드는 방식 사용) |
  | `scenarioHasThink는 준비 스텝의 think_time을 본다` | 준비 스텝에만 `think_time`이 있는 모델 → `true` |
  | `isSetupStep` | `isSetupStep(model, S1) === true`, `(model, B1) === false`, 준비 없는 모델 → `false` |

- [ ] **Step 2: 실패를 확인한다** — `cd ui && pnpm test setupEdit`. 기대: 위 테스트 대부분 FAIL(`moveStepToSection is not a function`, 준비 스텝 편집 무반영).

- [ ] **Step 3: `yamlDoc.ts`를 고친다**
  - `findStepPath`: `searchSeq(doc.getIn(["setup","steps"]), ["setup","steps"], stepId) ?? searchSeq(doc.getIn(["steps"]), ["steps"], stepId)`.
  - `removeStep` 가지: `deleteIn(path)` 뒤 `path[0] === "setup"`이고 `setup.steps`가 빈 seq면 `doc.deleteIn(["setup"])`.
  - `moveStepSection` 가지:
    - 원본 경로는 `findStepPath`. `to === "setup"`이면 경로가 정확히 `["steps", i]`(길이 2)일 때만, `to === "steps"`이면 `["setup","steps",i]`일 때만 진행한다(아니면 `return`).
    - 원본 seq에서 **노드 객체 그대로** `splice`로 떼어 대상 seq 끝에 `items.push`(새로 `createNode`하지 않는다 — 주석·표기 보존).
    - `to === "setup"`이고 `setup`이 이미 맵이면 그 맵을 다시 쓴다(`flow = false`, 안의 `steps`가 seq가 아니거나 빈 flow seq면 block seq로). `setup`이 없으면(또는 값이 `null`이면 그 Pair를 지우고): 루트 맵(`doc.contents`)의 `items`에서 key가 `steps`인 Pair의 인덱스를 찾아 그 **앞**에 `setup` Pair를 `splice`로 넣는다(값 = block 표기 맵 `{ steps: <block seq> }`, `flow = false`). `steps` Pair가 없으면 끝에 넣는다. 대상 seq가 빈 flow seq면 `ensureSeq`로 block으로 돌린다.
    - `to === "steps"`: `ensureSeq(doc, ["steps"])` 뒤 끝에 붙이고, `setup.steps`가 비면 `doc.deleteIn(["setup"])`.

- [ ] **Step 4: `model.ts`·`store.ts`를 고친다**
  - `isSetupStep`: `setupSteps(s).some((x) => x.id === stepId)`.
  - `scenarioHasThink`: `flattenHttpSteps(allSteps(sc))`.
  - `setStepsThinkTime`의 허용 집합과 `addStepExtract`의 스텝 찾기: `allSteps(model)` 기준.
  - `moveStepToSection`: `doc`·`model` 없거나 `yamlError !== null`이면 return. `to === "setup"`은 `model.steps.length > 1`이고 `model.steps.some((s) => s.id === stepId && s.type === "http")`일 때만(하나뿐인 본 스텝은 못 옮긴다), `to === "steps"`는 `isSetupStep(model, stepId)`일 때만. 적용은 `reparentStep`과 같은 방식(복제본에 `applyEdit` → `parseScenarioDoc(serializeDoc(clone))` 성공 시에만 `set`). 선택은 건드리지 않는다.
  - store 타입(`ScenarioEditorState`)에 액션 시그니처를 더한다.

- [ ] **Step 5: 통과를 확인한다** — `pnpm test setupEdit` PASS, 이어서 `pnpm test`(전체) PASS — 기존 `yamlDoc`·`store`·`insertSteps` 테스트가 그대로여야 한다.

- [ ] **Step 6: 되돌려 확인** — `findStepPath`의 `setup` 찾기를 지우면 「준비 스텝의 필드를 고치면…」이 RED, `removeStep`의 키 정리를 지우면 「마지막 준비 스텝을 지우면…」이 RED인지 보고 원복.

- [ ] **Step 7: 커밋** — `cd ui && pnpm lint && pnpm test && pnpm build` 뒤
  `git add ui/src/scenario/yamlDoc.ts ui/src/scenario/store.ts ui/src/scenario/model.ts ui/src/scenario/__tests__/setupEdit.test.ts`
  → `feat(ui): 준비 스텝 편집 경로 — 스텝 찾기·삭제·구획 사이 이동`

---

### Task 2: 아웃라인 준비 구획

**Files:**
- Modify: `ui/src/components/scenario/FlowOutline.tsx`
- Modify: `ui/src/i18n/ko.ts` (`editor.setupOutlineLine` 삭제, 새 키 둘)
- Test: `ui/src/components/scenario/__tests__/FlowOutline.setup.test.tsx` (A1 테스트를 바꾼다)

**Interfaces:**
- Consumes: store `select`, `selectedStepId`, `model`; `setupSteps`.
- 목업: 장면 1의 「가」.
- Produces: 준비 스텝 행 = `role="option"`, `aria-label={ko.editor.outlineRowAria(name)}`, `data-step-id={id}`를 **항상** 단다(`OutlineRow`는 넓게 보기·`onActivate`일 때만 다는데, 준비 행은 사용처 이동의 스크롤 대상이라 조건 없이 단다 — `EditorShell.jumpToStep`이 이 속성으로 찾는다), `aria-selected`.

문구(`ko.editor`):
- `setupSectionName`: `"준비 스텝"`
- `setupSectionNote`: `"— VU마다 한 번만 실행"` (구획의 접근 이름은 둘을 공백으로 이은 `준비 스텝 — VU마다 한 번만 실행`)
- `mainSectionTitle`: `"본 스텝 — 반복 실행"`

- [ ] **Step 1: 테스트를 바꿔 쓴다** — `FlowOutline.setup.test.tsx`

  | 테스트 이름 | 단언 |
  |---|---|
  | `준비 스텝이 있으면 구획 머리 줄 둘과 준비 행이 본 스텝 행보다 앞에 나온다` | `getByRole("group", { name: "준비 스텝 — VU마다 한 번만 실행" })`·`getByText("본 스텝 — 반복 실행")` 존재, 준비 행들이 그 group **안**에 있다(`within(group).getAllByRole("option")` 길이 = 준비 스텝 수), `getAllByRole("option")`의 `aria-label` 순서가 `[스텝: 준비 요청, 스텝: 조회]` |
  | `준비 스텝이 없으면 머리 줄이 없다` | `queryByRole("group", { name: "준비 스텝 — VU마다 한 번만 실행" })` 없음, `queryByText("본 스텝 — 반복 실행")` 없음 |
  | `준비 행을 누르면 선택된다` | 클릭 → `useScenarioEditor.getState().selectedStepId === S1`, 행 `aria-selected="true"` |
  | `준비 행에는 끌기 손잡이가 없다` | `within(준비 행).queryByRole("button")` 없음; 본 스텝 행에는 있음(같은 테스트에서 대조) |
  | `넓게 보기에서 준비 행을 누르면 onActivateStep이 불린다` | `<FlowOutline wide onActivateStep={spy} />` → 클릭 시 `spy`가 `S1`로 호출 |
  | `준비 행도 Enter로 선택된다` | 포커스 후 `{Enter}` → 선택 |
  | `본 스텝이 없고 준비 스텝만 있어도 그려진다` | 본 스텝 0개 픽스처(손으로 쓴 YAML) → 준비 행 1개 + 빈 목록 안내(`ko.editor.canvasEmpty`) |
  | `끌기 계산은 준비 스텝 id를 모른다`(고정 테스트 — 지금도 통과한다) | `resolveDrop(model.steps, B1, S1, "below")`가 `null`. 준비 행이 끌기에 등록되지 않는다는 보장은 위의 「끌기 손잡이가 없다」 테스트와 구현 규칙(`useSortable`·`useDroppable` 없음)이 맡는다 |
  | `A1의 읽기 전용 줄은 없다` | `queryByText(/YAML 보기에서 확인/)` 없음 |

- [ ] **Step 2: 실패 확인** — `pnpm test FlowOutline.setup`.

- [ ] **Step 3: 구현** — 목업 장면 1의 「가」. `FlowOutline`에서 `setupCount` 줄과 A1의 `<p>`를 지우고, `model`을 골라 `useMemo`로 `setupSteps`를 만든다. 본 스텝 목록 위에 준비 구획을 그린다:
  - 상자(목업 `.setup-box`): `<div role="group" aria-label={name + " " + note}>` — `mb-2.5 rounded-lg border border-accent-200 bg-accent-50 p-2`.
  - 머리 줄(목업 `.setup-box .sec-label`): `mb-1 px-0.5 text-[11px] font-semibold text-accent-800`에 이름, 이어서 `<span className="font-normal text-slate-600">`에 note.
  - 행: 새 컴포넌트 `SetupRow` — `OutlineRow`의 http leaf 가지와 **같은 클래스·같은 행 내용 컴포넌트(`RowContent`)·같은 선택/키보드 처리**를 쓰되 `useSortable`·`useDroppable`·끌기 손잡이·`SortableContext`가 없다(끄는 대상도 놓는 대상도 아니다 — 끌기 계산은 지금처럼 `model.steps`만 받는다). 행 바탕은 흰색 그대로(상자의 옅은 바탕 위에 흰 행).
  - 구획이 있을 때만 본 스텝 목록 위 머리 줄(목업 `.sec-label`): `mb-1 px-0.5 text-[11px] font-semibold text-slate-400`에 `mainSectionTitle`.
  - `ko.editor.setupOutlineLine`을 지운다(`grep -rn setupOutlineLine ui/src crates` → 0).

- [ ] **Step 4: 통과 확인** — `pnpm test FlowOutline` (기존 `FlowOutline.test.tsx` 포함).

- [ ] **Step 5: 커밋** — `feat(ui): 아웃라인에 준비 스텝 구획`

---

### Task 3: Inspector — 준비 스텝 편집·구획 옮기기

**Files:**
- Create: `ui/src/components/scenario/SetupBadge.tsx` (`export function SetupBadge(): JSX.Element` — Global Constraints의 모양)
- Modify: `ui/src/components/scenario/Inspector.tsx` (`Inspector`, `HttpStepInspector`, `ExtractEditor`)
- Modify: `ui/src/i18n/ko.ts`
- Test: `ui/src/components/scenario/__tests__/Inspector.setup.test.tsx` (신규)

**Interfaces:**
- 목업: 장면 2(세 상태).
- Consumes: Task 1의 `moveStepToSection`, `isSetupStep`; Task 2의 준비 행(테스트는 store `select`로 직접 고른다).
- Produces: `SetupBadge`(Task 4·5·8이 쓴다).

문구(`ko.editor`):
- `moveToSetup`: `"준비 스텝으로 옮기기"`
- `moveToMain`: `"본 스텝으로 옮기기"`
- `setupStepHint`: `"VU마다 한 번만 실행됩니다."` (앞에 `SetupBadge`가 붙는다)
- `setupBadge`: `"준비"`
- `setupDefaultUnused`: `"준비 스텝에서는 쓰이지 않습니다"`
- `moveToSetupOnlyMain`: `"본 스텝이 하나뿐이면 옮길 수 없습니다"`

- [ ] **Step 1: 실패하는 테스트** — `Inspector.setup.test.tsx` (`beforeEach`에 `localStorage.clear()`와 store reset)

  | 테스트 이름 | 단언 |
  |---|---|
  | `준비 스텝을 고르면 Inspector가 열리고 이름을 고치면 YAML에 반영된다` | `select(S1)` → 이름 입력에 `준비 요청`; 바꾸고 blur → `model.setup.steps[0].name`이 새 이름 |
  | `준비 스텝에는 ↑↓가 없고 안내 줄과 「본 스텝으로 옮기기」가 있다` | `queryByTitle(ko.common.moveUp)` 없음, 옮기기 줄 안에 `준비` 표지와 `getByText("VU마다 한 번만 실행됩니다.")`, `getByRole("button",{name:"본 스텝으로 옮기기"})` |
  | `「본 스텝으로 옮기기」를 누르면 본 스텝이 되고 버튼이 바뀐다` | 클릭 → `model.setup === undefined`, `model.steps`의 마지막 id가 S1, 같은 Inspector에 `준비 스텝으로 옮기기` 버튼과 ↑↓가 나타남 |
  | `최상위 본 http 스텝에는 「준비 스텝으로 옮기기」가 있다` | 본 스텝 2개 픽스처에서 `select(B1)` → 버튼 존재; 클릭 → `model.setup.steps` 끝에 B1 |
  | `loop 안의 http 스텝과 컨테이너에는 옮기기 버튼이 없다` | loop 픽스처: 자식 http 선택 → 두 버튼 모두 없음; loop 선택 → 없음 |
  | `깨진 YAML 버퍼 중에는 옮기기 버튼이 잠긴다` | 깨진 버퍼 커밋 뒤 버튼 `toBeDisabled()` |
  | `본 스텝이 하나뿐이면 「준비 스텝으로 옮기기」가 잠기고 이유가 보인다` | 본 스텝 1개 시나리오 → 버튼 `toBeDisabled()` + `getByText("본 스텝이 하나뿐이면 옮길 수 없습니다")`; 본 스텝 2개면 활성이고 이유 글 없음 |
  | `준비 스텝의 추출 기본값 칸 옆에 안 쓰인다는 안내가 나온다` | `default`가 선언된 추출을 가진 준비 스텝 → 추출 섹션을 펼치면 `getByText("준비 스텝에서는 쓰이지 않습니다")`; 같은 추출을 가진 본 스텝에서는 없음 |

- [ ] **Step 2: 실패 확인** — `pnpm test Inspector.setup`.

- [ ] **Step 3: 구현**
  - `Inspector()`: `steps` 셀렉터를 `model` 셀렉터 + `useMemo(() => (model ? allSteps(model) : EMPTY_STEPS), [model])`로 바꾼다. `topLevel` 판정은 `model.steps` 기준 그대로.
  - `HttpStepInspector`: `inSetup = isSetupStep(model, step.id)`, `topLevelMain = model.steps.some((s) => s.id === step.id)`. `inSetup`이면 `MoveButtons`를 그리지 않는다. 머리(`header`) 바로 아래에 한 줄(목업 장면 2의 `.moveline`): `inSetup`이면 `flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent-200 bg-accent-50 px-2 py-1.5` 안에 왼쪽 `<span className="text-xs text-accent-800">`(`SetupBadge` + 안내 글), 오른쪽 「본 스텝으로 옮기기」. `topLevelMain`이면 바탕 없는 `flex justify-end`에 「준비 스텝으로 옮기기」. 둘 다 아니면 줄 자체가 없다. 버튼은 기존 `SmallButton`. `disabled={yamlError !== null}`, 「준비 스텝으로 옮기기」는 `model.steps.length <= 1`일 때도 잠그고 그 아래에 `moveToSetupOnlyMain`을 보인다(`text-xs text-slate-500`).
  - `ExtractEditor`에 `inSetup: boolean` prop. 기본값 칸이 보이는 줄에서 `inSetup`이면 칸 옆에 안내 글(`text-xs text-amber-700`).
  - `isInsideParallelBranch(model.steps, …)` 호출은 그대로 둔다(준비 스텝은 못 찾아 `false`).

- [ ] **Step 4: 통과 확인** — `pnpm test Inspector` (기존 `Inspector.test.tsx`·`Inspector.sections.test.tsx` 포함).

- [ ] **Step 5: 되돌려 확인** — `Inspector()`의 스텝 찾기를 `model.steps`로 되돌리면 첫 테스트가 RED인지.

- [ ] **Step 6: 커밋** — `feat(ui): Inspector에서 준비 스텝 편집·구획 사이 옮기기`

---

### Task 4: 페이싱 현황판·파일 가져오기·스텝으로 가는 연결들

**Files:**
- Modify: `ui/src/scenario/thinkTime.ts` (`ThinkRow`, `buildThinkRows`), `ui/src/components/scenario/ThinkTimeBoard.tsx`
- Modify: `ui/src/components/scenario/YamlFileActions.tsx`
- Modify: `ui/src/scenario/problems.ts` (준비 스텝 항목을 스텝 연결로)
- Modify: `ui/src/i18n/ko.ts`
- Test: `ui/src/scenario/__tests__/problems.test.ts`, `ui/src/components/scenario/__tests__/ValidationBanner.setup.test.tsx`, `TrustBoard.test.tsx`, `ui/src/scenario/__tests__/thinkTime.test.ts`, `ui/src/components/scenario/__tests__/ThinkTimeBoard.test.tsx`, `YamlFileActions.test.tsx`, `EditorShell.test.tsx` (각각 케이스 추가)

**Interfaces:**
- Consumes: Task 1(think 일괄 편집이 준비 스텝에 적용), Task 2·3(준비 행 선택·Inspector).

목업: 장면 5의 현황판 — **표지의 모양과 행 순서만** 본다. 목업은 「위치」 칸을 따로 그렸지만 실제 현황판의 표 구조(칸·열)는 바꾸지 않는다: 표지는 이름 칸 안, 지금 경로 글자(`step-path`)가 있는 자리에 둔다. 새 문구 없음.

- [ ] **Step 1: 실패하는 테스트**

  | 파일 · 테스트 이름 | 단언 |
  |---|---|
  | `thinkTime.test.ts` · `준비 스텝이 현황판 행의 맨 앞에 준비 표시와 함께 나온다` | `buildThinkRows(model)`의 `[0]`이 `{stepId: S1, setup: true, path: "", insideParallel: false}`, `[1]`이 `{stepId: B1, setup: false}` |
  | `ThinkTimeBoard.test.tsx` · `준비 스텝 행에 「준비」 표지가 있다` | 준비 행 안에 `준비` 글자, 본 스텝 행에는 없음 |
  | `thinkTime.test.ts` · `준비 스텝도 시나리오 기본 think time을 상속한다` | `default_think_time`이 있는 모델 → `[0].state === "inherited"`, `effective` = 기본값 |
  | `ThinkTimeBoard.test.tsx` · `준비 스텝 행의 값을 고치면 그 스텝에 반영된다` | 준비 행(`stepId`로 특정)의 min/max 입력 후 포커스 이동 → `model.setup.steps[0].think_time` 반영 |
  | `YamlFileActions.test.tsx` · `준비 스텝만 있는 시나리오도 덮어쓰기 확인을 묻는다` | 본 스텝 0개·준비 1개 store에서 파일 가져오기 → `window.confirm` 호출됨 |
  | `problems.test.ts` · `준비 스텝의 주소 문제는 스텝으로 가는 항목이다` | 준비 스텝 주소가 빈 모델 → 그 항목이 `{ kind: "step", stepId: S1 }` (A1의 `plain` 기대를 바꾼다. id 겹침 항목은 `plain` 그대로) |
  | `ValidationBanner.setup.test.tsx` · `준비 스텝 항목을 누르면 그 스텝이 선택된다` | 항목 버튼 클릭 → `selectedStepId === S1` |
  | `TrustBoard.test.tsx` · `준비 스텝 이름을 누르면 onSelectStep이 그 id로 불린다` | 검증 없는 준비 스텝이 든 모델을 `evaluateTrust(model)`에 넣은 결과를 `report` prop으로 → 목록의 준비 스텝 버튼 클릭 → spy가 `S1`로 호출(이미 통과하면 고정 테스트로 남긴다) |
  | `EditorShell.test.tsx` · `변수 사용처에서 준비 스텝으로 이동하면 그 행이 선택되고 Inspector가 열린다` | 픽스처 로드 → 변수 패널의 `BASE_URL`/`token` 사용처 팝오버에서 준비 스텝 항목 클릭 → 아웃라인의 `스텝: 준비 요청` 행 `aria-selected="true"`, Inspector 이름 입력 값 `준비 요청` (이 파일의 기존 사용처 이동 테스트가 있으면 그 방식을 따른다. 없으면 `VarUsagePopover.test.tsx` 방식으로 팝오버를 연다) |

- [ ] **Step 2: 실패 확인** — `pnpm test thinkTime ThinkTimeBoard YamlFileActions problems ValidationBanner TrustBoard`.

- [ ] **Step 3: 구현**
  - `ThinkRow`에 `setup: boolean`을 더한다. `buildThinkRows`: 준비 스텝을 먼저 훑어 `setup: true`·`path: ""`로, 본 스텝은 `setup: false`로. `ThinkTimeBoard`: `row.setup`이면 이름 앞(경로 글자 자리)에 `SetupBadge`. `ThinkRow` 리터럴을 만드는 테스트는 `tsc -b`가 알려 준다(전부 `setup: false`).
  - `YamlFileActions`: `hasContent = (s.model ? allSteps(s.model).length : 0) > 0 || s.yamlError !== null`.
  - `problems.ts`: `urlProblems(setupSteps, true)`로 바꾸고 「A1에서 선택할 수 없으므로」 주석을 지운다(id 겹침 항목은 어느 스텝을 가리킬지 정할 수 없어 `plain` 그대로).

- [ ] **Step 4: 통과 확인** — 위 네 파일 + `pnpm test EditorShell`.

- [ ] **Step 5: 커밋** — `feat(ui): 페이싱 현황판·파일 가져오기·사용처 이동이 준비 스텝을 봄`

---

### Task 5: trace 준비 표지 — 스키마 · test-run 결과 · 흐름 칩

**Files:**
- Modify: `ui/src/api/schemas.ts` (`StepTraceSchema`, `ScenarioTraceSchema`, `SequentialTraceSchema` + 「전 필드 항상 emit」 주석 정정)
- Modify: `ui/src/components/scenario/TestRunPanel.tsx`, `SequentialRunPanel.tsx`, `TestRunSection.tsx`, `TestRunDatasetSection.tsx`, `TestFlowChips.tsx`, `EditorShell.tsx`
- Modify: `ui/src/i18n/ko.ts`
- Test: `ui/src/api/__tests__/`의 trace 스키마 테스트(있으면 그 파일, 없으면 `traceSetup.test.ts` 신규), `TestRunPanel.test.tsx`, `SequentialRunPanel.test.tsx`, `TestFlowChips.test.tsx`, `TestRunSection.test.tsx`, `TestRunSection.dataset.test.tsx`

**Interfaces:**
- 목업: 장면 3(흐름 칩·준비 성공·준비 실패·순차 모드).
- Produces:
  - `StepTrace.section?: string`(준비 행이면 `"setup"` — 다른 구간 이름이 와도 파싱이 깨지지 않게 글자로 읽는다) · `ScenarioTrace.setup_failed?: boolean` · `ScenarioTrace.setup_ms?: number` · `SequentialTrace.setup_steps?: StepTrace[]` · `SequentialTrace.setup_failed?: boolean` · `SequentialTrace.setup_ms?: number` — 전부 `.optional()`(서버는 없으면 키를 생략한다. `null`은 오지 않는다).
  - `TestFlowChips`에 선택 prop `setupCount?: number`(기본 0) — `steps`의 앞 `setupCount`개가 준비 스텝.
  - `TraceStepList`·`TestRunPanel`·`SequentialRunPanel`의 props는 그대로(`steps`에 준비 스텝을 포함해 넘긴다).

문구(`ko.editor`):
- (표지는 `SetupBadge` — Task 3)
- `testRunSetupCount`: `(n: number) => \`준비 ${n}\``
- `testRunSetupFailed`: `"준비 스텝이 실패해 본 스텝을 실행하지 않았습니다"`
- `seqSetupTitle`: `"준비 스텝 — 첫 행 앞에 한 번 실행"`

- [ ] **Step 1: 실패하는 테스트**

  | 파일 · 테스트 이름 | 단언 |
  |---|---|
  | 스키마 · `준비 표지가 든 단일 trace를 읽고 키를 버리지 않는다` | `steps[0]`에 `section:"setup"`, 루트에 `setup_ms: 41`이 든 객체 → `parse` 결과 `steps[0].section === "setup"`, `setup_ms === 41`, `setup_failed === undefined` |
  | 스키마 · `준비 키가 없는 trace도 읽는다` | 기존 모양 → 통과, `steps[0].section === undefined` |
  | 스키마 · `모르는 구간 이름이 와도 읽는다` | `section: "teardown"` → 통과, 값 보존 |
  | 스키마 · `행 모드의 setup_steps를 읽는다` | `rows: []`, `setup_steps: [행]`, `setup_failed: true` → `setup_steps.length === 1`, `setup_failed === true` |
  | `TestRunPanel` · `준비 행에만 「준비」 표지가 붙는다` | 준비 행 1 + 본 행 1 trace, `steps`에 두 스텝 → 준비 행 `li` 안에 `준비` 글자와 이름 `준비 요청`; 본 행 `li` 안에는 `준비` 표지 없음(`within`으로 각각) |
  | `TestRunPanel` · `머리의 스텝 수는 본 행만 세고 준비 수를 따로 적는다` | 머리 글 `toHaveTextContent(/1 steps · 준비 1$/)`; 준비 없는 trace는 `/2 steps$/`(준비 글자 없음) |
  | `TestRunPanel` · `준비 실패면 본 스텝을 실행하지 않았다고 알린다` | `setup_failed: true` trace → `getByText("준비 스텝이 실패해 본 스텝을 실행하지 않았습니다")`; `setup_failed` 없는 trace에서는 없음 |
  | `SequentialRunPanel` · `준비 행을 행 목록 위에 한 번 보인다` | `setup_steps` 1개 + `rows` 2개 → `getByText("준비 스텝 — 첫 행 앞에 한 번 실행")` 아래에 `준비 요청` 행; 행 펼침 안에는 준비 행 없음 |
  | `SequentialRunPanel` · `준비가 실패해 행이 없어도 준비 행과 실패 안내가 나온다` | `rows: []`, `setup_steps: [오류 행]`, `setup_failed: true` → 실패 문구 + 준비 행의 오류 글 |
  | `TestFlowChips` · `준비 칩이 앞에 「준비」 표지와 함께 나오고 본 칩과 구분된다` | `setupCount={1}`, `steps=[준비, 본]` → `data-testid="chip-strip-wrap"` 안의 첫 글자 조각이 `준비`(표지), 칩 버튼 순서 `[준비 요청, 조회]`, 두 칩 사이 구분자가 `→`가 아니라 `|`(`aria-hidden`) |
  | `TestFlowChips` · `setupCount가 없으면 지금과 같다` | 표지 `준비` 없음 |
  | `TestFlowChips` · `준비 칩도 결과 색을 받는다` | trace에 준비 행(200) → 준비 칩에 통과 아이콘 |
  | `TestRunSection` · `준비 스텝이 칩과 결과에 이름과 표지로 나온다` | `yamlText`=픽스처 → 실행 전 칩 `[준비 요청, 조회]`; 응답 mock(준비 행에 `section:"setup"` + 본 행) 뒤 결과 구역의 준비 행 `li` 안에 이름 `준비 요청`과 `준비` 표지 — 이 테스트는 응답이 스키마를 거치므로 스키마가 `section`을 버리면 RED다 |
  | `TestRunSection.dataset` · `행 모드 요청 수 안내는 준비 요청도 센다` | 준비 1 + 본 1 시나리오, 요청 상한 10, 행 10 → 「상한을 넘는다」 안내가 뜬다(10×1 + 1 > 10); 준비 없는 같은 조건에서는 안 뜬다(이 파일의 기존 상한 안내 케이스 방식) |
  | `TestRunSection` · `행 모드에서 준비 칩이 setup_steps의 결과를 받는다` | 순차 응답 mock(`setup_steps` 1, `rows` 1) + 행 펼침 → 준비 칩에 통과 아이콘 |

- [ ] **Step 2: 실패 확인** — `pnpm test TestRunPanel SequentialRunPanel TestFlowChips TestRunSection`과 스키마 테스트.

- [ ] **Step 3: 구현**
  - 스키마: `section: z.string().optional()`, `setup_failed: z.boolean().optional()`, `setup_ms: z.number().int().optional()`, `setup_steps: z.array(StepTraceSchema).optional()`. `SequentialTraceSchema` 위 주석의 「전 필드 항상 emit」을 사실에 맞게 고친다(준비 키 셋은 생략형).
  - `TestRunPanel`: `HttpRow`가 `step.section === "setup"`이면 이름 앞에 `SetupBadge`. 구분선(목업의 `.divide`)은 두 경우에만 그린다. ① `TraceStepList` 안에서 **바로 다음 행이 본 스텝 행인 준비 행** — 그 행의 `border-b border-slate-100`을 `border-b-2 border-accent-200`으로 **바꾼다**(두 테두리 클래스를 함께 두지 않는다). 준비 행만 있는 trace(단일 실행의 준비 실패)에는 구분선이 없다(목업의 준비 실패 장면). ② 순차 모드의 따로 그린 준비 목록 — 그 목록을 `<div className="mb-2.5 border-b-2 border-accent-200">`로 감싼다(행의 클래스는 건드리지 않는다). 머리의 수 = 준비 아닌 행 수, 준비 행이 있으면 ` · ` + `testRunSetupCount(n)`. `trace.setup_failed`면 `Callout variant="warn"`로 `testRunSetupFailed`(상한 안내 위).
  - `SequentialRunPanel`: `seq.setup_steps`가 있으면 행 목록 위에 제목 `seqSetupTitle` + 그 행들(`TraceStepList`에 `{ ok: !seq.setup_failed, total_ms: seq.setup_ms ?? 0, steps: seq.setup_steps, final_vars: {}, truncated: false, error: null }`을 넘긴다). `seq.setup_failed`면 같은 실패 `Callout`.
  - `TestRunSection`: 모델에서 `all = allSteps(model)`, `setupCount = setupSteps(model).length`. 칩·결과 패널에는 `all`, **`leafCount`는 본 스텝만**(`flattenHttpSteps(model.steps)` — 행마다 도는 요청 수). 준비 요청은 한 번뿐이지만 요청 상한에 들어가므로(spec D11) `TestRunDatasetSection`에 선택 prop `setupRequestCount?: number`(기본 0)를 더해 상한 안내의 계산을 `requestedRows * expectedLeafCount + setupRequestCount > maxRequests`로 한다. 행 모드 `chipTrace` = 펼친 행의 trace 앞에 `seqData.setup_steps`를 이어 붙인 것(펼친 행이 없으면 `setup_steps`만 든 trace, `setup_steps`도 없으면 `null`).
  - `TestFlowChips`: `setupCount > 0`이면 첫 칩 앞에 `SetupBadge`, `i === setupCount` 자리의 구분자는 `→` 대신 `|`(`px-0.5 text-slate-300`, `aria-hidden`).
  - `EditorShell`: 넓게 보기 칩 스트립에 `allSteps(model)`(memo)과 `setupCount`를 넘긴다.

- [ ] **Step 4: 통과 확인** — Step 2의 명령 + `pnpm test EditorShell chipResults`.

- [ ] **Step 5: 되돌려 확인** — 스키마에서 `section`을 지우면 스키마 테스트와 `TestRunSection`의 「이름과 표지로 나온다」가 RED인지, `setupRequestCount` 항을 지우면 「준비 요청도 센다」가 RED인지 보고 원복.

- [ ] **Step 6: 커밋** — `feat(ui): test-run 결과·흐름 칩에 준비 스텝 표지`

---

### Task 6: 사이징 도우미 — 준비를 뺀 반복 측정

**Files:**
- Modify: `ui/src/components/run/sizing.ts`, `SlotSizingHelper.tsx`, `VuSizingHelper.tsx`
- Test: `ui/src/components/run/__tests__/sizing.test.ts`, `SlotSizingHelper.test.tsx`, `VuSizingHelper.test.tsx`

**Interfaces:**
- Consumes: Task 5의 `ScenarioTrace.setup_ms`·`setup_failed`·`StepTrace.section`.
- Produces: `sizing.ts`에 `export function measuredIteration(trace: ScenarioTrace): { requests: number; holdMs: number } | null`
  - `trace.truncated` 또는 `trace.setup_failed`면 `null`.
  - `requests` = `section !== "setup"`이고 `response !== null`인 행 수.
  - `holdMs` = `max(0, total_ms − (setup_ms ?? 0))`.

- [ ] **Step 1: 실패하는 테스트**

  | 파일 · 테스트 이름 | 단언 |
  |---|---|
  | `sizing.test.ts` · `준비 행과 준비 시간을 뺀다` | 준비 행 1(응답 있음) + 본 행 2, `total_ms: 500`, `setup_ms: 200` → `{ requests: 2, holdMs: 300 }` |
  | 같은 파일 · `준비가 없으면 지금과 같다` | 본 행 2, `total_ms: 500` → `{ requests: 2, holdMs: 500 }` |
  | 같은 파일 · `잘렸거나 준비가 실패한 trace는 측정이 아니다` | `truncated: true` → `null`; `setup_failed: true` → `null` |
  | `SlotSizingHelper.test.tsx` · `준비가 있는 시나리오의 측정 점유 시간은 준비를 뺀 값이다` | test-run mock이 위 trace를 주면 화면의 측정 점유 시간 글에 `300`이 있고 `500`은 없다(이 파일의 기존 측정 케이스 단언 방식을 따른다) |
  | `VuSizingHelper.test.tsx` · `준비가 있는 시나리오의 반복당 요청 수·반복 시간은 준비를 뺀 값이다` | 같은 trace → 반복당 요청 수 `2`, 반복 시간 `300` 기준 값 |

- [ ] **Step 2: 실패 확인** — `pnpm test sizing SlotSizingHelper VuSizingHelper`.

- [ ] **Step 3: 구현** — `measuredIteration`을 더하고, 두 도우미의 `trace.steps.filter(…).length`·`trace.total_ms` 읽기를 이 함수 결과로 바꾼다. `measuredHold`가 `total_ms > 0`일 때만 값이던 규칙은 `holdMs > 0`으로 유지한다.

- [ ] **Step 4: 통과 확인** — Step 2 명령.

- [ ] **Step 5: 커밋** — `feat(ui): 사이징 도우미가 준비 스텝을 뺀 반복을 잰다`

---

### Task 7: 실행 창·스케줄 폼 안내 (D14)

**Files:**
- Create: `ui/src/components/run/setupNotices.ts`, `ui/src/components/run/SetupNotices.tsx`
- Modify: `ui/src/components/run/RunDialog.tsx`, `ScheduleForm.tsx`, `DataBindingPanel.tsx`(`per_vu` option 글자를 ko 키로), `ui/src/i18n/ko.ts`
- Test: `ui/src/components/run/__tests__/setupNotices.test.ts`(신규), `SetupNotices.test.tsx`(신규), `RunDialog.test.tsx`, `ScheduleForm.test.tsx`, `DataBindingPanel.test.tsx`

**Interfaces:**
- Produces:

  ```ts
  // setupNotices.ts
  export type SetupNotice =
    | { kind: "burst" }
    | { kind: "per_slot"; slots: number }
    | { kind: "shared_rows"; rows: number; units: number; unit: "vu" | "slot" }
    | { kind: "not_per_vu"; vars: string[] };

  export interface SetupNoticeInput {
    scenario: Scenario | null;
    loadModel: "closed" | "open";
    rateMode: "fixed" | "curve" | "stair"; // 폼의 타입 그대로. stair는 open-loop 전용
    vus: number | null;          // VU 고정
    rampUpSeconds: number | null;
    vuPeak: number | null;       // VU 곡선 최고점
    maxInFlight: number | null;  // open-loop 슬롯 수
    bindings: ReadonlyArray<DataBinding>;
    rowCounts: Readonly<Record<string, number>>; // dataset_id → 행 수(모르면 키 없음)
  }
  export function setupNotices(input: SetupNoticeInput): SetupNotice[];

  // SetupNotices.tsx — rowCounts는 컴포넌트가 useDatasets()로 채운다
  export function SetupNotices(props: Omit<SetupNoticeInput, "rowCounts">): JSX.Element | null;
  ```

- 목업: 장면 4(파란 안내 상자 — 제목 한 줄 + 목록).
- 판정 규칙(순서 = 반환 순서):
  1. `scenario`가 없거나 준비 스텝이 없으면 `[]`.
  2. `burst`: `loadModel === "closed" && rateMode === "fixed" && rampUpSeconds === 0`.
  3. `per_slot`: `loadModel === "open" && maxInFlight !== null` → `slots = maxInFlight`.
  4. `units` = VU 고정 `vus` / VU 곡선 `vuPeak` / open `maxInFlight`. `unit` = open이면 `"slot"`, 아니면 `"vu"`.
  5. `setupVars` = `scanFlowVars({ ...scenario, steps: [] })`(준비 스텝의 주소·헤더·본문이 참조하는 이름).
  6. `shared_rows`: `policy === "per_vu"`이고 `mappings` 중 `var`가 `setupVars`에 있는 바인딩마다, `rowCounts[dataset_id]`가 있고 `units !== null`이고 `rows < units`이면 하나씩.
  7. `not_per_vu`: `policy !== "per_vu"`인 바인딩들의 `mappings` 가운데 `var`가 `setupVars`에 있는 이름(바인딩·매핑 순서, 중복 제거)이 하나라도 있으면 하나.

문구(`ko.runDialog.setupNotice`):
- `title`: `"준비 스텝 안내"`
- `burst`: `"준비 스텝이 VU 수만큼 한꺼번에 나갑니다. 상승 시간을 두면 나눠서 나갑니다."`
- `perSlot`: `(n: number) => \`준비 스텝은 슬롯마다 한 번 실행됩니다. 슬롯이 ${n}개면 준비 스텝이 최대 ${n}번 나갑니다.\``
- `sharedRows`: `(rows: number, units: number, unit: "vu" | "slot")` → unit이 `vu`면 `` `데이터 ${rows}행을 VU ${units}개가 나눠 씁니다. 같은 행으로 준비 스텝이 여러 번 실행됩니다. 값 하나가 틀리면 그 행을 받은 VU가 모두 준비에 실패합니다.` ``, `slot`이면 두 군데의 「VU」를 「슬롯」으로.
- `notPerVu`: `(vars: string[])` → `` `준비 스텝은 VU마다 첫 반복의 값으로 한 번만 실행됩니다. ${이름들} 값이 VU마다 고정돼야 한다면 데이터셋 방식을 '${ko.binding.policyPerVu}'으로 두세요.` `` — `이름들` = 각 이름을 백틱으로 감싸 `, `로 이은 것. 조사를 변수 이름에 붙이지 않는다(영문 이름은 `josa`가 「(이)가」를 낸다).
- 새 키 `ko.binding.policyPerVu`: `"per_vu — VU마다 한 행 (고정)"` — 바인딩 방식 선택지(`DataBindingPanel.tsx`의 `<option value="per_vu">`)에 지금 박혀 있는 글자 그대로다. 그 `<option>`의 글자를 이 키 참조로 바꿔 선택지와 안내가 한 소스를 쓰게 한다(화면 글자 불변). `ko.binding`이 없으면 `ko.ts`에서 바인딩 문구가 모인 객체(`dupVar`가 있는 곳)에 둔다.

- [ ] **Step 1: 실패하는 테스트**

  | 파일 · 테스트 이름 | 단언 |
  |---|---|
  | `setupNotices.test.ts` · `준비 스텝이 없으면 안내가 없다` | 준비 없는 시나리오 + 모든 조건 참 → `[]`; `scenario: null` → `[]` |
  | · `VU 고정에 상승 시간 0이면 burst` | `[{kind:"burst"}]`; `rampUpSeconds: 5` → `[]`; VU 곡선 → `burst` 없음 |
  | · `open-loop이면 슬롯 수 안내` | `maxInFlight: 30` → `[{kind:"per_slot", slots:30}]`; `maxInFlight: null` → 없음; `loadModel:"open", rateMode:"stair"`도 같은 결과(`burst` 없음) |
  | · `준비 스텝이 쓰는 per_vu 데이터의 행이 VU보다 적으면 shared_rows` | 준비 스텝이 `{{user}}` 참조, `per_vu` 바인딩이 `user` 대고 행 5, `vus: 20`, `rampUpSeconds: 3` → `[{kind:"shared_rows", rows:5, units:20, unit:"vu"}]`; 행 20 → 없음; 행 수 모름(`rowCounts` 키 없음) → 없음 |
  | · `준비 스텝이 안 쓰는 변수만 대는 per_vu 바인딩은 세지 않는다` | 바인딩이 `other`만 → 없음 |
  | · `VU 곡선은 최고점, open-loop은 슬롯 수와 비교한다` | `vuPeak: 50`·행 10 → `units: 50, unit:"vu"`; open `maxInFlight: 8`·행 5 → `units: 8, unit:"slot"`(앞에 `per_slot`도 함께) |
  | · `per_vu가 아닌 바인딩의 변수를 준비 스텝이 쓰면 not_per_vu` | `iter_sequential` 바인딩이 `user`·`pw` 대고 준비가 둘 다 참조 → `{kind:"not_per_vu", vars:["user","pw"]}`; 준비가 안 쓰면 없음 |
  | · `본 스텝만 쓰는 변수는 준비가 쓰는 것으로 보지 않는다` | `{{user}}`가 본 스텝에만 → 없음 |
  | · `순서는 burst → per_slot → shared_rows → not_per_vu` | 여러 조건 동시 → `kind` 순서 단언 |
  | `SetupNotices.test.tsx` · `문구가 글자 그대로 나온다` | `burst` → `getByText("준비 스텝이 VU 수만큼 한꺼번에 나갑니다. 상승 시간을 두면 나눠서 나갑니다.")`; `per_slot` 30 → 글에 `30개`·`30번`; `shared_rows` slot → 글에 `슬롯 8개가 나눠`·`그 행을 받은 슬롯이 모두`; `not_per_vu` → 글에 `` `user`, `pw` 값이 VU마다 고정돼야 한다면 `` 와 `'per_vu — VU마다 한 행 (고정)'으로 두세요` (리터럴 문자열로 단언 — `ko.*(…)`를 기대값으로 쓰지 않는다) |
  | `DataBindingPanel.test.tsx` · `per_vu 선택지 글자는 그대로다` | 방식 select의 `per_vu` option 글이 `per_vu — VU마다 한 행 (고정)`(리터럴) |
  | `SetupNotices.test.tsx` · `안내가 없으면 아무것도 그리지 않는다` | 컨테이너가 비어 있음 |
  | `RunDialog.test.tsx` · `준비 스텝이 있는 시나리오는 기본 상태에서 burst 안내가 뜨고 상승 시간을 두면 사라진다` | 픽스처 시나리오로 열기 → 안내 글 존재; 상승 시간 입력에 5 → 없음 |
  | `RunDialog.test.tsx` · `준비 스텝이 없는 시나리오에는 안내 구역이 없다` | `queryByText("준비 스텝 안내")` 없음 |
  | `ScheduleForm.test.tsx` · `스케줄 폼에도 같은 안내가 뜬다` | 준비 있는 시나리오 선택 + VU 고정·상승 0 → burst 글 존재 |

- [ ] **Step 2: 실패 확인** — `pnpm test setupNotices SetupNotices`.

- [ ] **Step 3: 구현**
  - `setupNotices.ts`: 위 규칙.
  - `SetupNotices.tsx`: `useDatasets()`로 `rowCounts`(`id → row_count`)를 만들고 `setupNotices`를 불러, 결과가 비면 `null`, 아니면 `Callout variant="info" role="status" title={ko.runDialog.setupNotice.title}` 안에 `<ul>`로 한 줄씩.
  - `RunDialog`·`ScheduleForm`: **`scenario`에 준비 스텝이 있을 때만** `<SetupNotices … />`를 그린다(없으면 마운트하지 않는다 — 준비 없는 시나리오에서 데이터셋 조회가 새로 나가지 않게). 자리: `RunDialog`는 신뢰도 한 줄(`trust` `Callout`) 바로 위 — 간단·상세 모드 게이트 밖. `ScheduleForm`은 같은 성격의 `Callout`(파일의 `Callout variant="warn" role="status"` 자리) 바로 위. `vus`·`rampUp`은 폼의 숫자 상태 그대로, `maxInFlight`는 문자열 상태라 빈 칸·정수 아님이면 `null`로 넘긴다. `rateMode`는 폼 값 그대로(`stair` 포함). `vuPeak`는 폼이 가진 VU 곡선 단계 목표의 최댓값(단계가 없으면 `null`).

- [ ] **Step 4: 통과 확인** — Step 2 명령 + `pnpm test RunDialog ScheduleForm`(기존 케이스 전부 통과 — 호출 수를 세는 기존 테스트가 깨지면 준비 없는 시나리오에서 `SetupNotices`가 마운트된 것이다).

- [ ] **Step 5: 되돌려 확인** — `setupVars`를 `scanFlowVars(scenario)`(본 스텝 포함)로 바꾸면 「본 스텝만 쓰는 변수는…」이 RED인지.

- [ ] **Step 6: 커밋** — `feat(ui): 실행 창·스케줄 폼에 준비 스텝 안내 네 종류`

---

### Task 8: 모니터 — 준비 행 이름·표지, 추가 버튼 없음 (D15)

**Files:**
- Modify: `ui/src/components/monitor/PanelEditor.tsx`, `CheckRecordDialog.tsx`, `PreviewResult.tsx`, `ui/src/i18n/ko.ts`
- Test: `ui/src/components/monitor/__tests__/PreviewResult.test.tsx`, `CheckRecordDialog.test.tsx`, `ui/src/pages/__tests__/MonitorEditPage.test.tsx`, `ui/src/monitor/__tests__/groups.test.ts`

**Interfaces:**
- Consumes: Task 5의 `StepTrace.section`(모니터 스키마 `ui/src/api/monitors.ts`가 `ScenarioTraceSchema`를 재사용한다).
- `stepOptionsFor`(`ui/src/monitor/groups.ts`)와 `MonitorEditPage`의 호출은 **고치지 않는다** — 칸 대상 선택에 준비 스텝을 넣는 것은 다음 슬라이스(spec D15·§10-0).

문구(`ko.monitor`):
- (표지는 `SetupBadge` — Task 3)
- `setupNotAddable`: `"준비 스텝의 값은 아직 칸에 쓸 수 없습니다"`

- [ ] **Step 1: 실패하는 테스트**

  | 파일 · 테스트 이름 | 단언 |
  |---|---|
  | `PreviewResult` · `준비 행은 이름과 「준비」 표지로 나온다` | `stepNames`에 준비 스텝 이름, trace 첫 행 `section:"setup"` → 그 행에 `준비 요청`과 `준비` 표지; 본 행에는 표지 없음 |
  | `PreviewResult` · `준비 행에서는 조건·화면 추가를 낼 수 없고 안내가 나온다` | `onAddCondition`·`onAddDisplay`를 준 상태 → 그 행 안에 추가 버튼(이 파일의 기존 추가 테스트가 누르는 그 버튼) 없음 + `준비 스텝의 값은 아직 칸에 쓸 수 없습니다`(행에 펼침은 없다 — 추가할 수 없는 행은 지금처럼 본문을 글자로 보인다); 본 행에서는 버튼이 있고 눌러서 `onAddCondition`이 불린다(같은 테스트에서 대조) |
  | `CheckRecordDialog` · `준비 행의 이름을 찾는다` | 준비 스텝이 든 시나리오 YAML + 준비 행이 든 기록 → 행 이름이 스텝 id가 아니라 `준비 요청` |
  | `MonitorEditPage.test.tsx`(`ui/src/pages/__tests__/` — 칸 설정을 그리는 테스트 파일) · `응답 시간 기준 스텝 선택지에 준비 스텝이 없다` | 준비 스텝이 든 시나리오로 칸을 그림 → 「응답 시간 기준」 select의 option 글에 `조회`는 있고 `준비 요청`은 없다 |
  | 같은 파일 · `준비 스텝을 기준으로 걸어 둔 칸은 그 값이 이름으로 남는다` | `latency_source: {kind:"step", step_id: S1}`인 칸(TUI로 만든 경우) → select의 선택된 option이 value `step:S1`(이 select가 쓰는 값 꼴 그대로)이고 글에 `준비 요청`이 있다(지금은 raw id) — 선택값이 「전체」로 바뀌어 보이지 않는다 |
  | 같은 파일 · `준비 스텝을 가리키는 조건·표시 항목은 「스텝 없음」 경고가 없다` | 조건의 `step_id`가 S1인 칸 → 조건 줄의 스텝 없음 경고(기존 케이스가 단언하는 그 글) 없음; 없는 id면 경고 있음(대조) |
  | `groups` · `칸 스텝 선택지는 본 스텝만이다` | `stepOptionsFor(model.steps)`를 쓰는 지금 호출 방식 그대로 → 결과 id에 S1 없음(다음 슬라이스까지 유지되는 경계를 고정한다) |

- [ ] **Step 2: 실패 확인** — `pnpm test PreviewResult CheckRecordDialog MonitorEditPage groups`.

- [ ] **Step 3: 구현**
  - `CheckRecordDialog`: 이름표를 만드는 `flattenHttpSteps(parsed.model.steps)`를 `flattenHttpSteps(allSteps(parsed.model))`로.
  - `PanelEditor`: 지금 `steps` 한 목록이 이름표(`stepNames`)·조건/표시 항목의 「스텝 없음」 경고·**「응답 시간 기준 스텝」 선택지(`steps.map(…)`)와 `stepGone`**에 함께 쓰인다. 둘로 나눈다 — `namedSteps = flattenHttpSteps(allSteps(model))`는 `stepNames`와 조건·표시 항목의 경고에만. 기존 `steps`(본 스텝만)는 선택지와 `stepGone`에 그대로(`stepGone`은 「선택지에 없는 저장 값」이라는 뜻 그대로 둬야 그 값을 위한 따로 한 줄 `<option>`이 계속 나온다). 그 따로 한 줄의 글만 raw id 대신 `stepNames[id] ?? id`로. `stepOptions`(prop)와 그것으로 계산하는 `stepMissing`은 고치지 않는다(묶음 스텝 칸이 준비 스텝을 가리킬 때의 「스텝 없음」은 다음 슬라이스 — spec D15).
  - `PreviewResult`: `StepRow`의 `interactive`에 `s.section !== "setup"`을 더한다. 준비 행은 이름 앞에 `SetupBadge`(목업 장면 5), 행 머리 아래에 `setupNotAddable` 한 줄(밝은 바탕 `text-xs text-slate-600`). 칸 하나 보기·묶음 보기 둘 다 같은 `StepRow`를 지나므로 한 곳만 고치면 된다.

- [ ] **Step 4: 통과 확인** — Step 2 명령 + `pnpm test monitor`.

- [ ] **Step 5: 되돌려 확인** — `interactive`의 새 조건을 지우면 둘째 테스트가 RED인지.

- [ ] **Step 6: 커밋** — `feat(ui): 모니터 미리 실행·점검 기록에 준비 행 이름과 표지`

---

### Task 9: 리포트·인쇄 주변이 준비 스텝을 봄

**Files:**
- Modify: `ui/src/components/report/ReportView.tsx`(타임아웃 재정의 판정 한 줄), `ui/src/print/scenarioFacts.ts`(`readScenarioFacts`·`ScenarioFacts`), `ui/src/print/buildPrintDoc.ts`(대상 시스템 인자), `ui/src/print/compare/fairness.ts`(`stripScenarioNames`)
- Test: `ui/src/print/__tests__/scenarioFacts.test.ts`(기존 `toEqual({ ok: true, name: null, steps: [] })` 두 곳에 `setupSteps: []`를 더한다), `ui/src/print/__tests__/stepTable.test.ts`(`ScenarioFacts` 리터럴에 `setupSteps: []`), `ui/src/print/compare/__tests__/fairness.test.ts`, `ui/src/components/report/__tests__/`의 `ReportView` 테스트(타임아웃 안내를 다루는 파일)

**Interfaces:**
- `ScenarioFacts`(성공 꼴)에 `setupSteps: StepFacts[]`를 더한다. `steps`는 본 스텝만 **그대로**(스텝 표·비교의 스텝 수·스텝 차이가 이 목록을 읽는다). 「대상 시스템」만 둘을 이어 읽는다(`buildPrintDoc.ts`의 `targetSystems(…)` 호출 인자).
- 고치지 않는 것: `pages/RunDetailPage.tsx`의 `stepOrder`(실행 중 화면의 준비 진행은 슬라이스 B), `ReportView`의 `ifMeta`·`groupMeta`·loop 뷰(준비 구간에 if·loop이 없다).

- [ ] **Step 1: 실패하는 테스트**

  | 파일 · 테스트 이름 | 단언 |
  |---|---|
  | `scenarioFacts` · `준비 스텝의 사실은 setupSteps에 따로 담긴다` | 픽스처 → `facts.setupSteps.map(id)`가 `[S1]`, `facts.steps.map(id)`가 `[B1]`(그대로) |
  | `scenarioFacts` · `준비 스텝만 다른 호스트면 대상 시스템에 그 호스트가 나온다` | 준비 스텝 주소 `https://auth.example/…`, 본 스텝 `https://api.example/…` → `buildPrintDoc`이 낸 문서의 대상 시스템에 두 호스트 모두(`buildPrintDoc` 테스트의 기존 대상 시스템 단언 방식을 따른다) |
  | `scenarioFacts` · `setup이 없거나 모양이 이상해도 던지지 않는다` | `setup: null`·`setup: 3`·`setup: { steps: "x" }` → `ok: true`, `setupSteps`가 `[]`, 본 스텝은 그대로 |
  | `fairness` · `준비 스텝의 이름·메모만 다른 두 시나리오는 같은 시나리오다` | `stripScenarioNames`를 거친 두 객체가 `toEqual`(준비 스텝 `name`만 다름) |
  | `fairness` · `준비 스텝의 주소가 다르면 다른 시나리오다` | 준비 스텝 `request.url`이 다름 → `not.toEqual`(지금도 통과한다 — 고정 테스트) |
  | `ReportView` · `준비 스텝에만 타임아웃 재정의가 있어도 재정의 안내가 나온다` | 준비 스텝에 `timeout_seconds`, 본 스텝에는 없음 → 기존 「타임아웃 재정의」 안내 요소 존재(그 파일의 기존 케이스 단언 방식) |

- [ ] **Step 2: 실패 확인** — `pnpm test scenarioFacts fairness ReportView`.

- [ ] **Step 3: 구현**
  - `readScenarioFacts`: `setupSteps` 배열을 따로 만들어 `if (isObj(root.setup)) walk(root.setup.steps, setupSteps);`. 반환의 두 성공 꼴 모두에 `setupSteps`를 넣는다. `buildPrintDoc.ts`의 대상 시스템 인자를 `[...facts.setupSteps, ...facts.steps]`로. `ScenarioFacts` 리터럴을 만드는 테스트·코드는 `tsc -b`가 알려 준다.
  - `stripScenarioNames`: `setup`이 객체이고 `steps`가 있으면 `out.setup = { ...setup, steps: stripSteps(setup.steps) }`.
  - `ReportView`: 타임아웃 재정의 판정의 `flattenHttpSteps(parsed.model.steps)`를 `flattenHttpSteps(allSteps(parsed.model))`로.

- [ ] **Step 4: 통과 확인** — Step 2 명령 + `pnpm test print` + `pnpm build`(`ScenarioFacts` 리터럴을 만드는 다른 자리가 있으면 `tsc -b`가 알려 준다 — 전부 `setupSteps: []`).

- [ ] **Step 5: 커밋** — `feat(ui): 인쇄 대상 시스템·같은 시나리오 판정·타임아웃 안내가 준비 스텝을 봄`

---

## 구현 뒤 — orchestrator가 하는 일

1. **첫 화면 대조(Task 2·3 직후)**: 컨트롤러를 띄워 아웃라인 준비 구획과 Inspector 옮기기 줄을 스크린샷으로 찍어 목업(`docs/superpowers/specs/2026-11-22-vu-setup-steps-a2-mockups/a2-screens.html` 장면 1·2)과 **나란히** 대조한다 — 상자 바탕·테두리·머리 글자 색, 표지 모양, 옮기기 줄. 어긋나면 그 자리에서 고치고 다음 task로 간다. Task 5 뒤에도 장면 3을 같은 방식으로 한 번 대조한다.
2. **전수 명령 재실행**: `grep -rnE '\.steps\b|"steps"' ui/src --include='*.ts' --include='*.tsx'` — 분류표의 「A2」 줄이 전부 고쳐졌거나 이 plan의 「고치지 않는 것」에 있는지 대조.
3. **`handicap-reviewer`** 최종 리뷰(와이어 1:1 — trace 선택 키, 준비 없는 시나리오 불변). `finish-slice` §0 보안 grep — trace/body 뷰어(`TestRunPanel`·`PreviewResult`)를 건드리므로 `security-reviewer` 대상(살필 곳: 준비 행에서 조건·표시 추가가 막혔는지, 새로 값이 옮겨지는 sink가 없는지).
4. **라이브 검증**(`/live-verify`, 워크트리 자체 바이너리):

   | US | 절차 | 통과 신호 |
   |---|---|---|
   | US1 | 새 시나리오에서 본 스텝으로 「토큰 발급」·「조회」를 만들고 「준비 스텝으로 옮기기」 → 저장 → VU 20·30초 run | 저장 200(서버가 YAML을 읽음), 응답기가 센 발급 요청 = 20, 조회 전부 200, 리포트 「준비 스텝」 구획에 20건 |
   | US4 | 에디터에서 test-run | 준비 행이 앞에 「준비」 표지, 조회 요청 헤더에 토큰, 칩에 준비 구분. 발급을 실패시키면 「준비 스텝이 실패해…」 |
   | US4 | 데이터셋 순차 모드 test-run | 준비 행이 행 목록 위에 한 번 |
   | US5 | YAML 모달에서 `setup:`을 손으로 넣고 닫기 → 아웃라인 / 아웃라인에서 옮기기 → 저장 뒤 `GET /api/scenarios/{id}`의 `yaml` | 양쪽 반영, `setup:`이 `steps:` 앞, 마지막 준비 스텝을 본 스텝으로 옮기면 `setup:` 없음 |
   | 안내 | 실행 창과 스케줄 폼에서 네 조건을 하나씩 | 조건마다 그 안내만. 간단·상세 모드 둘 다 |
   | 사이징 | 느린 준비(2초) + 빠른 본 스텝 시나리오로 슬롯·VU 사이징 측정 | 측정 점유 시간이 준비 2초를 포함하지 않음 |
   | 모니터 | 준비 스텝 있는 시나리오로 보드 미리 실행·점검 기록 | 준비 행 이름·표지, 준비 행에 추가 버튼 없음 |
   | 극단값 | 준비 스텝 5개·이름 60자·주소 200자 | 아웃라인 준비 구획·Inspector 옮기기 줄·칩·test-run 머리에서 rect 겹침 0, 잘림은 `truncate`+`title`. 좁은 Inspector(약 294px)에서 버튼 줄이 넘치지 않음 |
   | 진입 화면 | `/scenarios/new`(템플릿 뒤)와 `/scenarios/{id}` 둘 다, 넓게 보기·스텝 편집 모달 | 준비 구획·옮기기·칩이 모두 동작 |
   | 불변 | 준비 없는 기존 시나리오를 열고 저장 | 저장 YAML이 글자 그대로, 화면에 준비 관련 글자 없음 |

5. **기록**(`/finish-slice`): build-log · roadmap 새 §B 블록(번호는 `grep -n '^### B' docs/roadmap.md`의 마지막 + 1) — 다음 슬라이스 「모니터 가림 문구 + 칸의 준비 스텝 선택」(사용자 결정: 문구가 있으면 가리고 없으면 안 가림 · 모든 스텝 · 위험해 보이면 미리 채움 · A2와 그 슬라이스 사이 릴리즈 금지), TUI·API로는 지금도 준비 스텝을 칸 대상으로 걸 수 있다는 것, `RunDetailPage` 준비 진행(슬라이스 B), 승인 문구 ④에서 바꾼 두 군데(방식 이름 = 바인딩 선택지 글자 그대로 · 「`user` 값이 … 한다면」), 묶음 스텝 칸이 준비 스텝을 가리킬 때의 「스텝 없음」(다음 슬라이스) · 현황판 · CLAUDE 상태줄 · 메모리.

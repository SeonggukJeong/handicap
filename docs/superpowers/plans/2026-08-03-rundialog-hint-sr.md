# rundialog-hint-sr Implementation Plan

<!-- REVIEW-GATE: APPROVED -->
<!-- spec 3R + plan 2R, spec-plan-reviewer clean APPROVE (2026-08-03) -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Field` 프리미티브에 `hintId` additive prop을 더해 RunDialog·LoadModelFields·ScheduleForm의 무음 hint 4곳을 `aria-describedby`로 스크린리더에 연결하고, 하드코딩 한국어 hint 리터럴 3건을 ko.ts 키 2종으로 수렴한다.

**Architecture:** spec = `docs/superpowers/specs/2026-08-03-rundialog-hint-sr-design.md` (리뷰 3R clean APPROVE). `Field`가 hint `<p>`에 caller-소유 id를 달아주면(errorId 선례와 대칭), 각 caller가 `aria-describedby = invalid ? "<error-id> ${hintId}" : hintId`로 배선한다(에러-먼저 낭독, hint 비소거 = US3). ScheduleForm 루프 집계 상한(#4)은 Field 밖 caller-렌더 `<span>`이라 id+describedby만 직접 배선.

**Tech Stack:** React 18 + TS + Tailwind, vitest + RTL + jest-dom(`toHaveAccessibleDescription` — 완전일치 비교), Playwright MCP(라이브).

## Global Constraints

- **UI-only**: `crates/`·payload 빌더(`buildProfile`/`profileForm`)·와이어 0-diff. hint 카피는 byte-그대로 이동만(변경 금지).
- **ko.ts 경유**(ADR-0035): 신규 사용자 노출 문구 하드코딩 금지.
- **게이트**: 각 task 커밋 전 `cd /Users/sgj/develop/handicap/.claude/worktrees/rundialog-hint-sr/ui && pnpm lint && pnpm test && pnpm build; echo exit=$?` — **파이프(`| tail` 등) 금지**, `exit=0` 확인. (pre-commit UI 게이트가 같은 체인을 다시 돈다.)
- **tdd-guard**: 각 task의 첫 편집은 반드시 테스트 파일(pending test를 만든 뒤 src 편집).
- **커밋**: `git add <파일들>` 후 `git diff --cached --name-only`로 staged 확인(빈-staged/케이스 미스매치 방어), `git commit`에 파이프 금지.
- **단일 파일 테스트 반복**: `pnpm test <이름>` (`--` 붙이면 전체 스위트가 돈다). 머지 전 인자 없는 전체 `pnpm test` 1회.
- 워크트리: `/Users/sgj/develop/handicap/.claude/worktrees/rundialog-hint-sr` (아래 모든 경로는 이 루트 기준).

---

### Task 1: `Field` 프리미티브 — `hintId` additive prop

**Files:**
- Modify: `ui/src/components/ui/Field.tsx` (40줄 전체가 §참고에 있음)
- Test: `ui/src/components/ui/__tests__/Field.test.tsx` (기존 3케이스 뒤에 2케이스 추가)

**Interfaces:**
- Produces: `Field` prop `hintId?: string` — 전달 시 hint `<p id={hintId}>`, 미전달 시 id 속성 자체 없음. Task 2·3이 이 prop을 소비한다. **계약**: `hintId`를 `aria-describedby`에 참조하는 caller는 `hint`를 무조건 렌더해야 함(조건부 hint + 상시 참조 = dangling reference).

- [ ] **Step 1: 실패하는 테스트 2건 추가** — `Field.test.tsx`의 `describe("Field", …)` 안, 기존 `error/errorId` 케이스(`:35-44`) 뒤에:

```tsx
  it("hintId를 주면 hint <p>가 그 id를 가져 aria-describedby 연결이 가능하다", () => {
    render(
      <Field label="연결" htmlFor="c" hint="힌트 문구" hintId="c-hint">
        <Input id="c" aria-describedby="c-hint" />
      </Field>,
    );
    expect(screen.getByText("힌트 문구").id).toBe("c-hint");
    expect(screen.getByLabelText("연결")).toHaveAccessibleDescription("힌트 문구");
  });
  it("hintId 미전달이면 hint <p>에 id 속성이 없다 (기존 소비처 DOM byte-identical 가드)", () => {
    render(
      <Field label="연결2" htmlFor="c2" hint="힌트 문구">
        <Input id="c2" />
      </Field>,
    );
    expect(screen.getByText("힌트 문구")).not.toHaveAttribute("id");
  });
```

- [ ] **Step 2: RED 확인** — `cd ui && pnpm test Field.test`
  기대: 신규 1번째 케이스 FAIL(`.id`가 `""` — prop이 아직 없음). 2번째는 현행 구현에서도 GREEN(원래 id 없음 — Step 5에서 이빨 실증).

- [ ] **Step 3: 구현** — `Field.tsx` props에 `hintId?: string` 추가(destructure `hint,` 뒤 `hintId,` / 타입 블록 `hint?: ReactNode;` 뒤), hint `<p>`에 `id={hintId}`:

```tsx
  hint?: ReactNode;
  /** hint <p>의 id — aria-describedby 연결용(errorId와 대칭).
      이 id를 describedby에 참조하는 caller는 hint를 무조건 렌더할 것(조건부 hint + 상시 참조 = dangling). */
  hintId?: string;
```

```tsx
      {hint != null && (
        <p id={hintId} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      )}
```

(기존 `:32`는 한 줄 `<p className=…>{hint}</p>` — id 추가로 prettier가 멀티라인으로 정리해도 무방.)

- [ ] **Step 4: GREEN 확인** — `pnpm test Field.test` 전부 PASS.

- [ ] **Step 5: 2번째 케이스 이빨 실증** — `Field.tsx`를 일시 변형 `id={hintId ?? "leaked-id"}` → `pnpm test Field.test`에서 2번째 케이스 FAIL 확인 → **원복** → GREEN 재확인. (미전달-시-무속성 가드가 실제로 물 수 있음을 증명.)

- [ ] **Step 6: 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/rundialog-hint-sr/ui && pnpm lint && pnpm test && pnpm build; echo exit=$?
cd /Users/sgj/develop/handicap/.claude/worktrees/rundialog-hint-sr
git add ui/src/components/ui/Field.tsx ui/src/components/ui/__tests__/Field.test.tsx
git diff --cached --name-only
git commit -m "feat(ui): Field hintId additive prop — hint <p> aria-describedby 연결 토대 (rundialog-hint-sr T1)"
```

---

### Task 2: RunDialog connect·loopCap 배선 + `ko.loadModel.loopCapHint`

**Files:**
- Modify: `ui/src/components/RunDialog.tsx:240-241`(useId 클러스터), `:942-958`(connect Field), `:962-977`(loopCap Field)
- Modify: `ui/src/i18n/ko.ts:202`(`loopCap:` 다음 줄에 키 추가)
- Test: `ui/src/components/__tests__/RunDialog.test.tsx` (신규 describe 1개 — 파일 말미)

**Interfaces:**
- Consumes: Task 1의 `Field.hintId`.
- Produces: `ko.loadModel.loopCapHint: string`(값 `"0 = 끄기 · 루프 스텝의 loop_index별 집계 상한"`) — Task 4(ScheduleForm)가 같은 키를 소비한다.

- [ ] **Step 1: 실패하는 테스트 3건 추가** — `RunDialog.test.tsx` 파일 말미(마지막 describe 뒤)에. connect·loopCap 입력은 **상세 모드 + 판정·고급 펼침** 둘 다 필요(선례 `:3364-3365`). `renderDialog()`는 `hasLoop` 기본 `true`(`:51`) — loopCap 게이트 자동 통과. 파일에 `ko`·`userEvent`·`screen` import 이미 있음(`:1-6`), `fireEvent` 불요(user.type 사용):

```tsx
describe("hint SR 연결 (rundialog-hint-sr)", () => {
  async function openDiag(user: ReturnType<typeof userEvent.setup>) {
    await toDetailed(user);
    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
  }
  it("connect timeout hint가 accessible description으로 낭독된다 (US1)", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDiag(user);
    expect(screen.getByLabelText(ko.loadModel.connectTimeout)).toHaveAccessibleDescription(
      ko.loadModel.connectTimeoutHint,
    );
  });
  it("loopCap hint가 accessible description으로 낭독된다 (US2)", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDiag(user);
    expect(screen.getByLabelText(ko.loadModel.loopCap)).toHaveAccessibleDescription(
      ko.loadModel.loopCapHint,
    );
  });
  it("invalid connect은 에러를 먼저, hint를 이어서 둘 다 낭독한다 (US3)", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDiag(user);
    const input = screen.getByLabelText(ko.loadModel.connectTimeout);
    await user.type(input, "60"); // http 기본 30 → connect 60 = invalid
    expect(input).toHaveValue(60); // 착지 확인 — sanitize가 지웠으면 아래가 공허해진다
    expect(input).toHaveAccessibleDescription(
      `${ko.validation.connectTimeout} ${ko.loadModel.connectTimeoutHint}`,
    );
  });
});
```

- [ ] **Step 2: RED 확인** — `pnpm test RunDialog.test`
  기대: 신규 3건 FAIL — ①③은 describedby가 hint를 안 가리켜 description 불일치, ②는 `toHaveAccessibleDescription(undefined)`가 인자 1개 있는 호출이라 no-arg 분기를 타지 않고 `equals("", undefined)` → false로 FAIL. 기존 케이스는 전부 GREEN 유지. **주의**: `ko.loadModel.loopCapHint`는 Step 3 전까지 tsc 에러이므로 Step 1~3 사이에 `pnpm build`를 돌리지 말 것(`pnpm test`는 esbuild transpile이라 무해).

- [ ] **Step 3: ko 키 추가** — `ko.ts:202` `loopCap: "루프 집계 상한",` 바로 다음 줄:

```ts
    loopCapHint: "0 = 끄기 · 루프 스텝의 loop_index별 집계 상한",
```

- [ ] **Step 4: 신규↔기존 카탈로그 양방향 부분문자열 충돌 검사** (spec §2.3, thinkboard-defaults 함정) — 워크트리 루트에서:

```bash
python3 - <<'EOF'
import re
src = open("ui/src/i18n/ko.ts", encoding="utf-8").read()
vals = set(re.findall(r'"([^"\n]{2,})"', src))
new = ["0 = 끄기 · 루프 스텝의 loop_index별 집계 상한",
       "동시 요청 상한 — 서비스가 목표 속도를 못 따라가면 초과분은 drop되어 리포트에 표시됩니다"]
for n in new:
    for v in vals:
        if v != n and (v in n or n in v):
            print("CONTAINS:", repr(v), "<->", repr(n))
EOF
```

기대 출력(orchestrator가 baseline에서 실측 — **정확히 이 6줄, 순서 무관**):

```
CONTAINS: '스텝' <-> '0 = 끄기 · 루프 스텝의 loop_index별 집계 상한'
CONTAINS: '동시 요청 상한' <-> '동시 요청 상한 — 서비스가 목표 속도를 못 따라가면 초과분은 drop되어 리포트에 표시됩니다'
CONTAINS: '목표' <-> '동시 요청 상한 — …'
CONTAINS: '요청' <-> '동시 요청 상한 — …'
CONTAINS: '동시' <-> '동시 요청 상한 — …'
CONTAINS: '리포트' <-> '동시 요청 상한 — …'
```

판정: 유의미한 충돌은 `'동시 요청 상한'`(기존 라벨 전체가 접두사 — spec §2.3에 문서화, 대응 = 완전일치 매처라 무해) 하나뿐이고, 나머지 5줄은 선재 단일-단어 값 조각(스텝·목표·요청·동시·리포트)이라 무해. **이 6줄 외 새 줄**이 나오면 STOP하고 orchestrator에 보고.

- [ ] **Step 5: RunDialog 배선** — `:240-241` useId 클러스터를:

```tsx
  const connectTimeoutId = useId();
  const connectTimeoutHintId = useId();
  const loopCapId = useId();
  const loopCapHintId = useId();
```

connect Field(`:942-958`)를:

```tsx
              <Field
                label={ko.loadModel.connectTimeout}
                htmlFor={connectTimeoutId}
                hint={ko.loadModel.connectTimeoutHint}
                hintId={connectTimeoutHintId}
              >
                <Input
                  id={connectTimeoutId}
                  type="number"
                  min={1}
                  max={600}
                  value={connectTimeout}
                  onChange={(e) => setConnectTimeout(e.target.value)}
                  placeholder={ko.loadModel.connectTimeoutPlaceholder}
                  aria-invalid={connectTimeoutInvalid}
                  aria-describedby={
                    connectTimeoutInvalid
                      ? `connect-timeout-error ${connectTimeoutHintId}`
                      : connectTimeoutHintId
                  }
                />
              </Field>
```

loopCap Field(`:962-977`, `{hasLoop && (…)}` 게이트 유지)를:

```tsx
              <Field
                label={ko.loadModel.loopCap}
                htmlFor={loopCapId}
                hint={ko.loadModel.loopCapHint}
                hintId={loopCapHintId}
              >
                <Input
                  id={loopCapId}
                  type="number"
                  min={0}
                  max={10000}
                  value={loopCap}
                  onChange={(e) => setLoopCap(Number(e.target.value))}
                  aria-invalid={loopCapInvalid}
                  aria-describedby={
                    loopCapInvalid ? `loop-cap-error ${loopCapHintId}` : loopCapHintId
                  }
                />
              </Field>
```

(하드코딩 hint 리터럴이 `ko.loadModel.loopCapHint`로 교체됨 — 이 파일에서 그 문구 grep 0이 되는 것이 DoD 일부.)

- [ ] **Step 6: GREEN 확인** — `pnpm test RunDialog.test` 전부 PASS (기존 케이스 포함 — 이 task는 `:1329`의 maxInFlight 단언을 건드리지 않고, maxInFlight 배선도 Task 3까지 없으므로 기존 GREEN 유지).

- [ ] **Step 7: 이빨 실증** — `RunDialog.tsx` connect Input의 `aria-describedby`를 일시적으로 원래 형태(`connectTimeoutInvalid ? "connect-timeout-error" : undefined`)로 되돌림 → US1·US3 케이스 FAIL 확인 → 원복 → GREEN. loopCap도 동일하게 `hintId={loopCapHintId}` 제거 → US2 케이스 FAIL → 원복 → GREEN.

- [ ] **Step 8: 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/rundialog-hint-sr/ui && pnpm lint && pnpm test && pnpm build; echo exit=$?
cd /Users/sgj/develop/handicap/.claude/worktrees/rundialog-hint-sr
git add ui/src/components/RunDialog.tsx ui/src/i18n/ko.ts ui/src/components/__tests__/RunDialog.test.tsx
git diff --cached --name-only
git commit -m "feat(ui): RunDialog connect·loopCap hint SR 연결 (US1·US3+US2 일부) — park 항목 해소 (rundialog-hint-sr T2)"
```

---

### Task 3: LoadModelFields maxInFlight 배선 + `ko.loadModel.maxInFlightHint` + 기존 단언 갱신(⑦)

**Files:**
- Modify: `ui/src/components/LoadModelFields.tsx:118-129`(`ids` 객체), `:667-684`(maxInFlight Field)
- Modify: `ui/src/i18n/ko.ts:194`(`maxInFlight:` 다음 줄에 키 추가)
- Test: `ui/src/components/__tests__/LoadModelFields.test.tsx`(신규 1건), `ui/src/components/__tests__/ScheduleForm.test.tsx`(신규 1건), `ui/src/components/__tests__/RunDialog.test.tsx:1329`(기존 단언 갱신)

**Interfaces:**
- Consumes: Task 1의 `Field.hintId`.
- Produces: `ko.loadModel.maxInFlightHint: string`(값 `"동시 요청 상한 — 서비스가 목표 속도를 못 따라가면 초과분은 drop되어 리포트에 표시됩니다"`). `LoadModelFields`의 maxInFlight 배선은 RunDialog·ScheduleForm 양 폼에 자동 적용.

- [ ] **Step 1: 실패하는 테스트 2건 추가** — ⑥a `LoadModelFields.test.tsx`(헬퍼 `renderFields = setup` 별칭 `:71`, `ko` import `:7` 기존):

```tsx
  it("open 모드 maxInFlight hint가 accessible description으로 낭독된다 (US2)", () => {
    renderFields({ loadModel: "open", rateMode: "fixed" });
    expect(screen.getByLabelText(ko.loadModel.maxInFlight)).toHaveAccessibleDescription(
      ko.loadModel.maxInFlightHint,
    );
  });
```

⑥b `ScheduleForm.test.tsx`(`wrap` 헬퍼 `:10-13`, `ko` import `:8` 기존 — open 전환은 라디오 accname `사용자 수 기준/도착률 기준`, `ko.ts:188-189`):

```tsx
  it("open 모드 maxInFlight hint가 aria-describedby로 연결된다 (US2, ScheduleForm 통합)", async () => {
    const user = userEvent.setup();
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={vi.fn()}
        submitting={false}
      />,
    );
    await user.click(screen.getByRole("radio", { name: /도착률 기준/ }));
    expect(screen.getByLabelText(ko.loadModel.maxInFlight)).toHaveAccessibleDescription(
      ko.loadModel.maxInFlightHint,
    );
  });
```

- [ ] **Step 2: RED 확인** — `pnpm test LoadModelFields` 및 `pnpm test ScheduleForm` — 신규 2건 FAIL(describedby가 hint 미참조 → description 불일치/빈 값).

- [ ] **Step 3: ko 키 추가** — `ko.ts:194` `maxInFlight: "동시 요청 상한",` 바로 다음 줄:

```ts
    maxInFlightHint:
      "동시 요청 상한 — 서비스가 목표 속도를 못 따라가면 초과분은 drop되어 리포트에 표시됩니다",
```

(prettier가 100자 초과로 줄바꿈하는 형태 — `connectTimeoutHint :199-200`과 동일 스타일.)

- [ ] **Step 4: LoadModelFields 배선** — `ids` 객체(`:118-129`)에 `maxInFlight: useId(),` 다음 줄 `maxInFlightHint: useId(),` 추가. maxInFlight Field(`:667-684`)를:

```tsx
            <Field
              label={ko.loadModel.maxInFlight}
              htmlFor={ids.maxInFlight}
              help={<HelpTip label="max in-flight 설명">{ko.glossary.maxInFlight}</HelpTip>}
              hint={ko.loadModel.maxInFlightHint}
              hintId={ids.maxInFlightHint}
            >
              <Input
                id={ids.maxInFlight}
                type="number"
                min={1}
                max={10000}
                value={maxInFlight}
                onChange={(e) => setMaxInFlight(e.target.value)}
                aria-invalid={errs.maxInFlightInvalid}
                aria-describedby={
                  errs.maxInFlightInvalid
                    ? `max-in-flight-error ${ids.maxInFlightHint}`
                    : ids.maxInFlightHint
                }
                numeric={numeric}
              />
            </Field>
```

- [ ] **Step 5: 기존 단언 ⑦ 갱신** — 이 시점에 `pnpm test RunDialog.test`를 돌리면 `:1329` `toHaveAttribute("aria-describedby", "max-in-flight-error")`가 **FAIL이어야 정상**(값이 `"max-in-flight-error :rN:"`으로 변함 — 게이트 인과의 실증). 확인 후 그 단언을 완전일치 유지 형태로 갱신(순서 이빨 보존 — `toContain`/정규식 완화 금지):

```tsx
    const hintEl = screen.getByText(ko.loadModel.maxInFlightHint);
    expect(maxInFlightInput).toHaveAttribute(
      "aria-describedby",
      `max-in-flight-error ${hintEl.id}`,
    );
```

- [ ] **Step 6: GREEN 확인** — `pnpm test LoadModelFields`, `pnpm test ScheduleForm`, `pnpm test RunDialog.test` 전부 PASS.

- [ ] **Step 7: 이빨 실증** — `LoadModelFields.tsx`의 describedby 병합을 일시 원복(`errs.maxInFlightInvalid ? "max-in-flight-error" : undefined`) + `hintId` 제거 → ⑥a·⑥b·⑦(갱신본) 3건 FAIL 확인 → 원복 → GREEN.

- [ ] **Step 8: 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/rundialog-hint-sr/ui && pnpm lint && pnpm test && pnpm build; echo exit=$?
cd /Users/sgj/develop/handicap/.claude/worktrees/rundialog-hint-sr
git add ui/src/components/LoadModelFields.tsx ui/src/i18n/ko.ts ui/src/components/__tests__/LoadModelFields.test.tsx ui/src/components/__tests__/ScheduleForm.test.tsx ui/src/components/__tests__/RunDialog.test.tsx
git diff --cached --name-only
git commit -m "feat(ui): maxInFlight hint SR 연결 — 양 폼 자동 적용 + :1329 완전일치 단언 갱신 (rundialog-hint-sr T3)"
```

---

### Task 4: ScheduleForm 루프 집계 상한(#4) 배선

**Files:**
- Modify: `ui/src/components/ScheduleForm.tsx:106`(useId 옆), `:394-403`(Input), `:404-406`(hint span)
- Test: `ui/src/components/__tests__/ScheduleForm.test.tsx` (신규 1건 — ⑥c)

**Interfaces:**
- Consumes: Task 2가 만든 `ko.loadModel.loopCapHint`.
- Produces: 없음(말단 배선).

- [ ] **Step 1: 실패하는 테스트 추가 (⑥c)** — **이 케이스만 fixture 비용이 다르다**(spec §3): ScheduleForm의 `hasLoop`은 prop이 아니라 fetch 파생(`ScheduleForm.tsx:70` — `useScenario` 응답 yaml 파싱). 전역 `beforeEach` fetch stub(`:15-23`)은 모든 요청에 `{scenarios: []}`를 줘 입력이 DOM에 없으므로, per-test URL 분기 stub + loop YAML + async 대기가 필요:

```tsx
  it("루프 시나리오 선택 시 loopCap hint가 aria-describedby로 연결된다 (#4, US2)", async () => {
    const user = userEvent.setup();
    const LOOP_YAML = [
      "version: 1",
      "name: loop-scn",
      "steps:",
      '  - id: "01HX0000000000000000000001"',
      "    name: L",
      "    type: loop",
      "    repeat: 2",
      "    do:",
      '      - id: "01HX0000000000000000000002"',
      "        name: ping",
      "        type: http",
      "        request:",
      "          method: GET",
      '          url: "/ping"',
    ].join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn((url: RequestInfo | URL) =>
        Promise.resolve(
          String(url).includes("/scenarios/s1")
            ? new Response(
                JSON.stringify({
                  id: "s1",
                  name: "loop-scn",
                  yaml: LOOP_YAML,
                  version: 1,
                  created_at: 1754200000000,
                  updated_at: 1754200000000,
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              )
            : new Response(JSON.stringify({ scenarios: [] }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
        ),
      ),
    );
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "loop-scn" }]}
        onSubmit={vi.fn()}
        submitting={false}
      />,
    );
    await user.selectOptions(screen.getByLabelText(/시나리오/), "s1");
    const input = await screen.findByLabelText(ko.loadModel.loopCap);
    expect(input).toHaveAccessibleDescription(ko.loadModel.loopCapHint);
  });
```

주의 2건 — `findByLabelText` 타임아웃의 원인 후보: ① **stub은 반드시 실제 `Response` 객체**여야 한다(위 코드가 이미 그렇다) — `api/client.ts:89`의 `request()`는 `resp.json()`이 아니라 **`resp.text()`**를 부르므로, 기존 전역 stub(`:15-23`)처럼 `{ ok, status, json }` plain 객체를 본뜨면 `resp.text is not a function`으로 쿼리가 reject되어 배선이 옳아도 영영 GREEN이 안 된다(그 전역 stub은 아무도 결과를 단언 안 해서 조용히 무해했던 것 — 정본 선례는 `RunDialog.test.tsx:44-49` `jsonResponse`). ② `ScenarioSchema`(`ui/src/api/schemas.ts:3-10`)는 **전 필드 필수**이고 `created_at`/`updated_at`은 **number(int)** — 문자열을 주면 Zod가 거부해 `hasLoop=false`로 남는다.

- [ ] **Step 2: RED 확인** — `pnpm test ScheduleForm` — 신규 케이스는 입력을 **찾고**(fixture가 옳으면 렌더됨) `toHaveAccessibleDescription`에서 FAIL(describedby 미배선 → description `""`). 만약 `findByLabelText` 타임아웃이면 fixture 결함(위 주의)이니 먼저 fixture를 고칠 것 — 이 단계에서 입력 발견까지 성공시켜 두면 이 테스트의 이빨이 "배선 유무"만 남는다.

- [ ] **Step 3: 배선** — `ScheduleForm.tsx:106` `const connectHintId = useId();` 다음 줄에 `const loopCapHintId = useId();`. `:394-403` `<Input`에 `aria-invalid={loopCapInvalid}` 다음 줄로 `aria-describedby={loopCapHintId}` 추가(상시 — 같은 폼 connect `:381`과 동일 거동, ScheduleForm은 인라인 에러 `<p>`가 없어 병합 불요). `:404-406` span을:

```tsx
            <span id={loopCapHintId} className="text-xs text-slate-500">
              {ko.loadModel.loopCapHint}
            </span>
```

(리터럴 → ko 키 교체 포함. `aria-label`(`:398`)·`<label>` 구조·시각 렌더 불변.)

- [ ] **Step 4: GREEN 확인** — `pnpm test ScheduleForm` 전부 PASS.

- [ ] **Step 5: 이빨 실증** — `aria-describedby={loopCapHintId}` 한 줄 일시 제거 → ⑥c FAIL → 원복 → GREEN.

- [ ] **Step 6: 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/rundialog-hint-sr/ui && pnpm lint && pnpm test && pnpm build; echo exit=$?
cd /Users/sgj/develop/handicap/.claude/worktrees/rundialog-hint-sr
git add ui/src/components/ScheduleForm.tsx ui/src/components/__tests__/ScheduleForm.test.tsx
git diff --cached --name-only
git commit -m "feat(ui): ScheduleForm loopCap hint SR 연결 (#4) — 두 폼 비대칭 종결 (rundialog-hint-sr T4)"
```

---

### Task 5: 전수 검증 + 라이브 검증 + 잔여 결함 roadmap 기록

**Files:**
- Modify: `docs/roadmap.md` (연기 항목 1줄 — a11y 폴리시 소형 목록, `:162` "헤더 접기 토글 aria-controls" 불릿과 같은 목록)
- 나머지는 검증-only (production 0-diff)

**Interfaces:**
- Consumes: Task 1~4 전부.

- [ ] **Step 1: DoD 전수 grep** (워크트리 루트):

```bash
grep -rn "0 = 끄기\|서비스가 목표 속도를 못 따라가면" ui/src/components/RunDialog.tsx ui/src/components/LoadModelFields.tsx ui/src/components/ScheduleForm.tsx
```

기대: **0건**(리터럴 3건 전부 ko 경유). 1건이라도 나오면 해당 task 미완.

```bash
git diff master...HEAD --stat -- crates/ desktop/ deploy/
git diff master...HEAD -- ui/src/components/profileForm.ts ui/src/components/RunDialog.tsx | grep -E "^[-+].*buildProfile" ; echo "buildProfile-diff exit=$?"
```

기대: crates/desktop/deploy **0-diff**, `buildProfile` 시그니처/로직 라인 diff **없음**(exit=1 = grep 무매치가 기대값).

- [ ] **Step 2: 전체 게이트 1회** — `cd ui && pnpm lint && pnpm test && pnpm build; echo exit=$?` → `exit=0`. (targeted green ≠ full green 방어.)

- [ ] **Step 3: 라이브 스택 기동** — 워크트리 자체 바이너리(스테일 방지)·전용 포트 8095/8094·격리 DB:

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/rundialog-hint-sr
cargo build -p handicap-controller --bin controller   # 워크트리 자체 바이너리 보장(baseline 있으면 수초 no-op)
cd ui && pnpm build && cd ..
./target/debug/controller --db /tmp/rundialog-hint-sr.db --ui-dir ui/dist --rest 127.0.0.1:8095 --grpc 127.0.0.1:8094 &
curl -s http://127.0.0.1:8095/api/scenarios   # {"scenarios":[]} 확인
```

loop 시나리오 생성(Task 4의 LOOP_YAML과 동일 구조를 파일로):

```bash
cat > /tmp/rundialog-hint-sr-loop.yaml <<'YAML'
version: 1
name: loop-scn
steps:
  - id: "01HX0000000000000000000001"
    name: L
    type: loop
    repeat: 2
    do:
      - id: "01HX0000000000000000000002"
        name: ping
        type: http
        request:
          method: GET
          url: "http://127.0.0.1:9/ping"
YAML
jq -Rs '{yaml:.}' /tmp/rundialog-hint-sr-loop.yaml | curl -sX POST http://127.0.0.1:8095/api/scenarios -H 'content-type: application/json' -d @-
```

(run을 실제로 돌리지 않으므로 url은 도달 불가여도 무방. 응답 파싱은 `GET /api/scenarios`에서 id 재조회 — 생성 응답 임베드 YAML 파싱 함정 회피.)

- [ ] **Step 4: Playwright — RunDialog (US1·US2·US3)** — `http://127.0.0.1:8095/scenarios/{id}/runs` → `실행하기` → 상세 모드 라디오 → `판정·고급` 토글 클릭. 단일 `browser_evaluate`로(트랜지언트 상태 1-call 원칙, **`useId`는 `:rN:` 형태라 `querySelector("#…")` SyntaxError — 반드시 `getElementById`**):

```js
() => {
  const byLabel = (t) => [...document.querySelectorAll("label")].find((l) => l.textContent.trim() === t);
  const resolve = (input) => (input.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean)
    .map((id) => ({ id, text: document.getElementById(id)?.textContent ?? null }));
  const connect = document.getElementById(byLabel("연결 수립 타임아웃(초)").htmlFor);
  const loopCap = document.getElementById(byLabel("루프 집계 상한").htmlFor);
  return { connect: resolve(connect), loopCap: resolve(loopCap) };
}
```

통과 신호: connect·loopCap 각각 `[{id, text: <hint 전문>}]` — text가 ko 카탈로그 문구와 전체일치. 이어 connect에 `60` 입력(기본 http 30 → invalid) 후 같은 evaluate 재실행 → connect가 **2원소**(`connect-timeout-error`의 에러 문구가 **먼저**, hint가 다음). US2 maxInFlight: `도착률 기준` 라디오 클릭 후 동일 resolve.

- [ ] **Step 5: Playwright — ScheduleForm (#4·⑥b·A/B)** — `http://127.0.0.1:8095/schedules` → **`새 스케줄` 버튼**(`ko.pages.newSchedule`, `SchedulesPage.tsx:125`) 클릭으로 폼 진입 → 시나리오 select에서 loop-scn 선택, `도착률 기준` 라디오 클릭 후 단일 evaluate(ScheduleForm의 loopCap·connect 입력은 wrapping label + `aria-label`이라 **byLabel 헬퍼가 아니라 aria-label 셀렉터**로 — live-verify-playwright.md의 라벨 래핑 함정):

```js
() => {
  const resolve = (input) => (input?.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean)
    .map((id) => ({ id, text: document.getElementById(id)?.textContent ?? null }));
  const byAria = (l) => document.querySelector(`input[aria-label="${l}"]`);
  const byLabel = (t) => [...document.querySelectorAll("label")].find((l) => l.textContent.trim() === t);
  const maxInFlight = document.getElementById(byLabel("동시 요청 상한").htmlFor); // Field 경로
  return {
    loopCap: resolve(byAria("루프 집계 상한")),        // #4 — hint 전문 1원소
    maxInFlight: resolve(maxInFlight),                  // ⑥b — hint 전문 1원소
    connect: resolve(byAria("연결 수립 타임아웃(초)")), // A/B 기준점(무변경) — hint 1원소 유지
  };
}
```

콘솔에 Zod 에러 0 확인(`browser_console_messages`).

- [ ] **Step 6: 정리** — `pgrep -f "target/debug/controller --db /tmp/rundialog-hint-sr.db" | xargs kill` (내가 띄운 프로세스만 지목 — bare `lsof -ti` 금지). `.playwright-mcp` 산출물 워크트리 잔존 시 삭제.

- [ ] **Step 7: 잔여 결함 roadmap 기록** — `docs/roadmap.md`의 a11y 폴리시 소형 연기 목록(`:162` `aria-controls` 불릿과 같은 리스트)에 추가:

```markdown
- **RunDialog think hint SR 미연결**: `RunDialog.tsx` think min/max의 `"min=max면 고정 지연"` hint `<p>`는 think-time-error와 삼항 배타 렌더라 rundialog-hint-sr의 `hintId` 상시-참조 계약에 안 맞아 스코프 아웃(spec §6) — 조건부 describedby 전환 설계 필요. a11y 폴리시 소형.
```

- [ ] **Step 8: 도메인 CLAUDE.md 갱신 (신규 함정 기록 + 기존 drift 정정)** — `ui/src/components/ui/CLAUDE.md`의 `Field` 불릿(`:10`)이 "기본은 `useId`로 라벨↔컨트롤·`aria-describedby` 자동 배선"이라 적고 있는데 실제 `Field.tsx`엔 그런 자동 배선이 없다(`htmlFor`/`errorId` 전부 caller 소유 — drift). 그 불릿의 해당 구절을 "라벨↔컨트롤(`htmlFor`)·에러(`errorId`)·hint(`hintId`) 연결은 전부 **caller-소유 id 주입** 계약"으로 정정하고, 같은 불릿 끝에 한 줄 추가:

```markdown
`hintId`(rundialog-hint-sr)도 동일 계약 — caller가 id를 소유하고 `aria-describedby`를 직접 배선하며, hintId를 describedby에 참조하는 caller는 hint를 **무조건 렌더**해야 한다(조건부 hint + 상시 참조 = dangling reference — RunDialog think hint가 이 이유로 스코프 아웃된 선례). 참고: `error`/`errorId` 경로는 현재 프로덕션 소비처 0건(3개 사이트 모두 에러 `<p>`를 Field **밖**에 두고 describedby를 직접 배선 — grep 2026-08-03).
```

- [ ] **Step 9: 커밋** (docs-only fast-path)

```bash
git add docs/roadmap.md ui/src/components/ui/CLAUDE.md
git diff --cached --name-only
git commit -m "docs: think hint 잔여 결함 roadmap 기록 + ui/CLAUDE.md Field hintId 계약·drift 정정 (rundialog-hint-sr T5)"
```

---

## Self-Review 결과 (plan 작성 후 자체 점검)

- **Spec coverage**: §2.1→T1, §2.2(connect·loopCap)→T2, §2.2(maxInFlight)+⑦→T3, §2.2b(#4)→T4, §2.3(ko 2키·리터럴 3건·충돌 검사)→T2 Step 3·4 + T3 Step 3, §3 테스트 ①②→T1 / ③④⑤→T2 / ⑥a·⑥b·⑦→T3 / ⑥c→T4, §4 라이브→T5, §6 잔여 결함 기록→T5 Step 7, §7 DoD grep→T5 Step 1. 갭 없음.
- **테스트 위치 규약**: 전부 기존 `__tests__/` 파일에 추가(vitest include 함정 없음).
- **Type consistency**: `hintId?: string`(T1) ↔ 소비처 전달 문자열(T2·T3) 일치. `ko.loadModel.loopCapHint`(T2 produce) ↔ T4 consume 일치.

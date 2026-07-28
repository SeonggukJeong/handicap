# trust-check-precision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Spec:** `docs/superpowers/specs/2026-07-28-trust-check-precision-design.md` (spec-plan-reviewer clean APPROVE, 커밋 `1583d0b`). US 블록은 spec 앞머리 `## 사용자 스토리 (US)` — task-brief마다 첨부.
>
> **Orchestrator 의무(구현 세션)**: ① 각 task brief의 "검증 의무"에 이빨 실증 스텝을 그대로 넣을 것(대화로만 전달하면 implementer에게 도달하지 않는다). ② Task 5 완료 후 §6 ko 충돌 대조를 **orchestrator가 직접** 재실행(아래 Global Constraints의 스크립트). ③ 완성도 grep(0-diff 확인)도 직접 재실행.

**Goal:** trust 점검의 문구·게이트를 정직하게 — B fail 문구를 위반 참조 위치(요청 표면=전멸 / cond-only=조용한 오분기)로 분기하고(US1), RunDialog B 억제를 "바인딩 존재"가 아니라 "공급 여부"로 판정하며(US2), C 점검이 선언-이름 충돌 dangling extract를 세게 한다(US3).

**Architecture:** 분석 토대(`scanVars.undefinedVarRefs`)에 위치 클래스를 additive로 실어 올리고(`hasStrictRef`), `trust.ts`가 B 전용 `vars`(이름+strict)를 운반, 공유 술어 `bFailMode`로 TrustBoard·RunDialog가 같은 판정을 쓴다. C는 `varRows` declared 행의 additive `overwrittenByFlat`로 모집단을 확장. 표시 밀도는 불변(D14 — 개수+링크), 진리표 불변, 서버 0-diff.

**Tech Stack:** TypeScript/React, vitest + RTL, Zustand store 무접촉.

## Global Constraints

- **ko 확정 문안(spec §6 — verbatim, 변경 금지)**:
  - `checkBFailWhyCond`: `이대로 부하를 걸면 조건이 빈 값으로 평가되어 의도한 분기를 타지 않습니다 — run은 실패 없이 끝나 결함이 숨습니다`
  - `runDialogBFailCond`: `이대로 실행하면 조건이 빈 값으로 평가되어 의도한 분기를 타지 않습니다`
  - 문구 단언은 **`getByText(전체 문자열)`(RTL 기본 exact)** 또는 키별 고유 조각(`checkBFailWhyCond` 꼬리 `— run은 실패 없이 끝나 결함이 숨습니다` / `runDialogBFailCond` 접두 `이대로 실행하면 조건이`)으로만 — 두 신규 문안이 25자 코어 `조건이 빈 값으로 평가되어 의도한 분기를 타지 않습니다`를 공유하므로 `toHaveTextContent(코어)`는 공허하다.
  - **충돌 대조(Task 5 후 orchestrator 직접)**: `ko.ts`의 신규 2값 ↔ 기존 한국어 리터럴 전체 양방향 부분문자열 대조(python으로 값 추출·양방향 `in` 검사, len≥6). spec 리뷰 시점 실측은 상호 포함 0건 — 문안이 한 글자라도 바뀌면 무효.
- **0-diff 불변(완성도 grep 대상)**: 서버·proto·migration·엔진(crates/**) · `VariablesPanel.tsx` · `DataBindingPanel.tsx` · `trustPrefs.ts` · `EditorShell.tsx` · `scanFlowVars`(함수) — `git diff $(git merge-base master HEAD) --stat`으로 확인(two-dot 금지).
- **진리표(전신 spec §5) 불변** — 등급 규칙 코드(`trust.ts`의 level 산출식) 무변경. C의 *입력*이 정확해져 기존 시나리오 등급이 `good→caution`/`caution→weak`로 움직이는 것은 의도됨(spec §4.2).
- **`TrustCheck.vars`는 필수 필드** — optional 금지(구성 사이트 전수 갱신을 `pnpm build`(tsc -b)가 강제; `pnpm test`는 못 잡는다).
- **tdd-guard**: 전 diff가 `ui/src/**`이므로 각 task의 **첫 스텝은 반드시 테스트 파일 편집**(test-path는 항상 허용). 직전 task 커밋 직후 트리는 clean — production 편집을 먼저 하면 `[tdd-guard] Blocked`.
- **spec-review-guard(리뷰 S3)**: 이 plan 파일 끝의 `REVIEW-GATE: APPROVED` 마커(리뷰어 clean APPROVE 후 orchestrator가 추가)가 없으면 `ui/src` 편집이 **첫 Edit부터 deny**된다 — 구현 세션 시작 시 마커 실존을 먼저 확인할 것(미통과 상태 마킹은 위조).
- **게이트 판정은 파이프 금지**: `pnpm lint` 등은 `; echo "exit=$?"`로 종료코드 명시 캡처(`| tail`은 실패 마스킹).
- **커밋은 단일 FOREGROUND Bash 호출(timeout 600000ms)** — pre-commit이 UI 게이트(lint+test 전체+build)를 돌린다. `git commit … | tail` 금지, `--no-verify` 금지. 커밋 후 `git log -1`로 landed 확인.
- 단일 파일 테스트 반복은 `pnpm test <이름>`(`--` 붙이면 전체 스위트가 돈다).

---

### Task 1: `scanVars.ts` — `UndefinedRef.hasStrictRef` (위치 클래스)

**Files:**
- Modify: `ui/src/scenario/scanVars.ts:244-257`(타입), `:327-345`(누적자/record), `:350-371`(judge), `:373-411`(walk 호출부), `:413-439`(out 조립)
- Test: `ui/src/scenario/__tests__/scanVars.test.ts` (append)

**Interfaces:**
- Consumes: 기존 `undefinedVarRefs(scenario)` — 시그니처 불변.
- Produces: `UndefinedRef.hasStrictRef: boolean` — 위반 참조 중 하나라도 http 요청 표면(url/헤더/바디)에 있으면 true, 전부 if/elif cond 오퍼랜드면 false. Task 3이 소비.

- [ ] **Step 1: 실패하는 테스트 작성** — `scanVars.test.ts` 맨 끝에 append:

```ts
describe("undefinedVarRefs — hasStrictRef (trust-check-precision US1)", () => {
  const T = "01HZZZZZZZZZZZZZZZZZZZZZT";
  const mkSc = (steps: unknown[]): Scenario =>
    ScenarioModel.parse({ version: 1, name: "t", cookie_jar: "auto", variables: {}, steps });
  const http = (id: string, url: string, extract: unknown[] = []) => ({
    id,
    name: "s",
    type: "http",
    request: { method: "GET", url, headers: {} },
    assert: [],
    extract,
  });

  it("요청 표면(url)에만 등장한 미정의 참조 → hasStrictRef=true", () => {
    const undef = undefinedVarRefs(mkSc([http(`${T}1`, "https://e.test/{{ghost}}")]));
    expect(undef.get("ghost")?.hasStrictRef).toBe(true);
  });

  it("if/elif cond에만 등장 → hasStrictRef=false (엔진 lenient — run은 완주)", () => {
    const undef = undefinedVarRefs(
      mkSc([
        {
          id: `${T}2`,
          name: "gate",
          type: "if",
          cond: { left: "{{seg}}", op: "eq", right: "x" },
          then: [http(`${T}3`, "https://e.test/a")],
          elif: [{ cond: { left: "{{seg2}}", op: "eq", right: "y" }, then: [http(`${T}4`, "https://e.test/b")] }],
          else: [],
        },
      ]),
    );
    expect(undef.get("seg")?.hasStrictRef).toBe(false);
    expect(undef.get("seg2")?.hasStrictRef).toBe(false);
  });

  it("cond와 url 양쪽(혼합) → true (전멸이 우선)", () => {
    const undef = undefinedVarRefs(
      mkSc([
        {
          id: `${T}5`,
          name: "gate",
          type: "if",
          cond: { left: "{{seg}}", op: "eq", right: "x" },
          then: [http(`${T}6`, "https://e.test/{{seg}}")],
          elif: [],
          else: [],
        },
      ]),
    );
    expect(undef.get("seg")?.hasStrictRef).toBe(true);
  });

  it("위치 축은 kind 축과 독립 — 형제 분기 url 참조는 kind=sibling·hasStrictRef=true", () => {
    const undef = undefinedVarRefs(
      mkSc([
        {
          id: `${T}7`,
          name: "par",
          type: "parallel",
          branches: [
            { name: "b1", steps: [http(`${T}8`, "https://e.test/a", [{ var: "tok", from: "body", path: "$.t" }])] },
            { name: "b2", steps: [http(`${T}9`, "https://e.test/{{tok}}")] },
          ],
        },
      ]),
    );
    const r = undef.get("tok");
    expect(r?.kind).toBe("sibling");
    expect(r?.hasStrictRef).toBe(true);
  });
});
```

주의: 이 파일 상단에 이미 `ScenarioModel`·`Scenario`·`undefinedVarRefs` import가 있는지 확인하고 없으면 기존 import 라인에 추가. ULID는 I/L/O/U 제외 26자 — 위 `${T}N` 조립이 26자가 되는지 확인(`T`가 25자 + 접미 1자).

- [ ] **Step 2: RED 확인** — `cd /Users/sgj/develop/handicap/.claude/worktrees/trust-check-precision/ui && pnpm test scanVars; echo "exit=$?"` → 신규 4케이스가 `hasStrictRef` undefined로 FAIL(기존 케이스는 green).

- [ ] **Step 3: 구현** — `scanVars.ts`:

```ts
// 타입(:244 부근)에 필드 추가:
export type UndefinedRef = {
  stepIds: string[];
  candidates: string[];
  kind: "downstream" | "sibling";
  /** 위반 참조 중 하나라도 http 요청 표면(url/헤더/바디 — strict 렌더 → VU 전멸)에 있으면 true.
   *  false = 전부 if/elif cond 오퍼랜드(lenient `""` 평가 — run은 완주, 분기 오분류). */
  hasStrictRef: boolean;
};
```

```ts
// 누적자(:327)에 sawStrict 추가:
const acc = new Map<
  string,
  { stepIds: string[]; sawDownstream: boolean; sawStrict: boolean; ownerNodeIds: Set<string> }
>();
const record = (
  name: string,
  stepId: string,
  insideBranch: boolean,
  ownerNodeId: string | null,
  strict: boolean,
): void => {
  let a = acc.get(name);
  if (!a) {
    a = { stepIds: [], sawDownstream: false, sawStrict: false, ownerNodeIds: new Set() };
    acc.set(name, a);
  }
  a.stepIds.push(stepId);
  if (strict) a.sawStrict = true;
  if (!insideBranch) a.sawDownstream = true;
  else if (ownerNodeId !== null) a.ownerNodeIds.add(ownerNodeId);
};
```

`judge`에 `strict: boolean` 매개변수 추가 — **내부 `record` 호출 2곳 모두** 그대로 전파(`:365` namespaced `record(name, stepId, false, null, strict)` 포함 — namespaced 정책 분기는 sibling/downstream 축의 일이지 위치 축과 무관, spec §3). 호출부: http arm(`:387`) `judge(refs, s.id, own, true)` / cond arm(`:404`) `judge(refs, s.id, own, false)`. out 조립(`:433`)에 `hasStrictRef: a.sawStrict` 추가.

- [ ] **Step 4: GREEN 확인** — `pnpm test scanVars; echo "exit=$?"` → 전체 PASS(기존 케이스 무수정 green = 판정 불변의 증거).

- [ ] **Step 5: 이빨 실증(회귀 가드 증명)** — cond arm 호출을 일시 `judge(refs, s.id, own, true)`로 바꾸고 `pnpm test scanVars` → "cond에만 등장" 케이스 **FAIL 확인** → 원복 → GREEN 재확인. production diff가 원복됐는지 `git diff ui/src/scenario/scanVars.ts`로 확인(의도한 구현만 남아야 함).

- [ ] **Step 6: 커밋** (FOREGROUND, timeout 600000ms)

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/trust-check-precision && git add ui/src/scenario/scanVars.ts ui/src/scenario/__tests__/scanVars.test.ts && git commit -m "feat(ui): undefinedVarRefs에 hasStrictRef 위치 클래스 — 요청 표면 vs cond-only (trust-check-precision T1)"
```

커밋 후 `git log -1`로 landed 확인.

---

### Task 2: `varRows.ts` — declared 행 `overwrittenByFlat`

**Files:**
- Modify: `ui/src/scenario/varRows.ts:13-21`(declared variant 타입), `:52-60`(push)
- Test: `ui/src/scenario/__tests__/varRows.test.ts` (append)

**Interfaces:**
- Consumes: 기존 `buildVarRows(model)` — 시그니처 불변.
- Produces: declared variant에 `overwrittenByFlat: boolean`(= `flatExtractNames`에 그 이름 존재). 기존 `overwritten`(flat ∪ namespaced) 불변. Task 3이 소비. **`VariablesPanel`은 새 필드를 읽지 않는다** — 렌더 byte-identical.

- [ ] **Step 1: 실패하는 테스트 작성** — `varRows.test.ts` 맨 끝에 append (파일 상단의 기존 fixture 헬퍼가 있으면 재사용하되, 없으면 아래 self-contained 형태):

```ts
describe("declared.overwrittenByFlat (trust-check-precision US3)", () => {
  const T = "01HZZZZZZZZZZZZZZZZZZZZZV";
  const mkSc = (over: Record<string, unknown>): Scenario =>
    ScenarioModel.parse({ version: 1, name: "t", cookie_jar: "auto", variables: {}, steps: [], ...over });
  const http = (id: string, extract: unknown[] = []) => ({
    id,
    name: "s",
    type: "http",
    request: { method: "GET", url: "https://e.test/a", headers: {} },
    assert: [],
    extract,
  });

  it("flat extract와 이름 충돌 → overwrittenByFlat=true (overwritten도 true)", () => {
    const rows = buildVarRows(
      mkSc({ variables: { tok: "" }, steps: [http(`${T}1`, [{ var: "tok", from: "body", path: "$.t" }])] }),
    );
    const d = rows.find((r) => r.kind === "declared" && r.name === "tok");
    expect(d).toMatchObject({ overwritten: true, overwrittenByFlat: true });
  });

  it("namespaced-only 충돌(선언명에 점) → overwrittenByFlat=false (overwritten은 true)", () => {
    const rows = buildVarRows(
      mkSc({
        variables: { "b1.tok": "" },
        steps: [
          {
            id: `${T}2`,
            name: "par",
            type: "parallel",
            branches: [{ name: "b1", steps: [http(`${T}3`, [{ var: "tok", from: "body", path: "$.t" }])] }],
          },
        ],
      }),
    );
    const d = rows.find((r) => r.kind === "declared" && r.name === "b1.tok");
    expect(d).toMatchObject({ overwritten: true, overwrittenByFlat: false });
  });

  it("무충돌 선언 → overwrittenByFlat=false", () => {
    const rows = buildVarRows(mkSc({ variables: { plain: "v" } }));
    const d = rows.find((r) => r.kind === "declared" && r.name === "plain");
    expect(d).toMatchObject({ overwritten: false, overwrittenByFlat: false });
  });
});
```

- [ ] **Step 2: RED 확인** — `pnpm test varRows; echo "exit=$?"` → 신규 3케이스 FAIL.

- [ ] **Step 3: 구현** — `varRows.ts` declared variant에 필드 추가 + push에 1줄:

```ts
| {
    kind: "declared";
    name: string;
    value: VarDeclValue;
    renamable: boolean;
    overwritten: boolean;
    /** flat extract(비-parallel 서브트리)가 이 이름을 덮어쓰는가 — trust C 확장 전용(spec P7).
     *  namespaced-overwrite는 제외(parallel-extract 행이 이미 세므로 이중 카운트 방지).
     *  패널은 이 필드를 읽지 않는다(렌더 byte-identical). */
    overwrittenByFlat: boolean;
    refIds: string[];
  }
```

push(`:52-60`)에 `overwrittenByFlat: flatEx.has(name),` 추가(기존 `overwritten` 줄 다음).

- [ ] **Step 4: GREEN + 패널 byte-identical 증거** — `pnpm test varRows; echo "exit=$?"` PASS 후 `pnpm test VariablesPanel; echo "exit=$?"` → **무수정 green**(새 필드가 렌더에 영향 없음의 증거).

- [ ] **Step 5: 커밋** (FOREGROUND, timeout 600000ms)

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/trust-check-precision && git add ui/src/scenario/varRows.ts ui/src/scenario/__tests__/varRows.test.ts && git commit -m "feat(ui): varRows declared 행에 overwrittenByFlat additive (trust-check-precision T2)"
```

---

### Task 3: `trust.ts` — `vars` 운반·`bFailMode`·C 모집단 확장 (+ 픽스처 스윕)

**Files:**
- Modify: `ui/src/scenario/trust.ts` (전체 100줄 파일 — 타입·evaluateTrust·신규 export)
- Modify: `ui/src/components/scenario/__tests__/TrustBoard.test.tsx:8-46` (픽스처에 `vars` 필수 필드 — **tsc -b가 강제**; Slice-9c "모델 widening은 나중 task 테스트 파일을 즉시 깬다" 함정의 선제 처리)
- Test: `ui/src/scenario/__tests__/trust.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 `UndefinedRef.hasStrictRef`, Task 2 `VarRow` declared `overwrittenByFlat`.
- Produces:
  - `TrustCheck.vars: Array<{ name: string; strict: boolean }>` — **필수 필드**. B만 채움(A·C는 `[]`).
  - `export function bFailMode(vars: Array<{ name: string; strict: boolean }>): "annihilation" | "misroute" | null` — 빈 입력 null·strict 하나라도 annihilation·전부 cond misroute. Task 4·5가 소비.

- [ ] **Step 1: 실패하는 테스트 작성** — `trust.test.ts` 맨 끝에 append (파일 상단의 기존 `sc`/`step`/`OK`/`DANGLING`/`UNDEF` 헬퍼 재사용, `bFailMode` import 추가):

```ts
describe("B vars 운반 + bFailMode (trust-check-precision US1·US2)", () => {
  it("B fail 시 vars에 이름·strict 운반 — url 참조는 strict:true", () => {
    const r = evaluateTrust(sc({ steps: [step(A, { ...UNDEF, assert: OK })] }));
    const b = r.checks.find((c) => c.id === "undefined_vars")!;
    expect(b.vars).toEqual([{ name: "nope", strict: true }]);
  });

  it("cond-only 미정의는 strict:false로 운반", () => {
    const r = evaluateTrust(
      sc({
        steps: [
          {
            id: A,
            name: "gate",
            type: "if",
            cond: { left: "{{seg}}", op: "eq", right: "x" },
            then: [step(B, { assert: OK })],
            elif: [],
            else: [],
          },
        ],
      }),
    );
    const b = r.checks.find((c) => c.id === "undefined_vars")!;
    expect(b.status).toBe("fail");
    expect(b.vars).toEqual([{ name: "seg", strict: false }]);
  });

  it("bFailMode 진리표: []→null / 전부 cond→misroute / 혼합→annihilation / 전부 strict→annihilation", () => {
    expect(bFailMode([])).toBeNull();
    expect(bFailMode([{ name: "a", strict: false }])).toBe("misroute");
    expect(bFailMode([{ name: "a", strict: false }, { name: "b", strict: true }])).toBe("annihilation");
    expect(bFailMode([{ name: "a", strict: true }])).toBe("annihilation");
  });

  it("vars 순서 = walker가 위반을 처음 만난 순서(문서순 결정론, spec §3)", () => {
    const r = evaluateTrust(
      sc({
        steps: [
          step(A, {
            assert: OK,
            request: { method: "GET", url: "https://e.test/{{first}}", headers: {} },
          }),
          step(B, {
            assert: OK,
            request: { method: "GET", url: "https://e.test/{{second}}", headers: {} },
          }),
        ],
      }),
    );
    const b = r.checks.find((c) => c.id === "undefined_vars")!;
    expect(b.vars).toEqual([
      { name: "first", strict: true },
      { name: "second", strict: true },
    ]);
  });

  it("A·C의 vars는 항상 빈 배열", () => {
    const r = evaluateTrust(sc({ steps: [step(A, DANGLING)] }));
    expect(r.checks.find((c) => c.id === "response_validation")!.vars).toEqual([]);
    expect(r.checks.find((c) => c.id === "broken_extract_chain")!.vars).toEqual([]);
  });
});

describe("C 모집단 확장 — 선언-충돌 dangling (trust-check-precision US3)", () => {
  const cOf = (r: ReturnType<typeof evaluateTrust>) =>
    r.checks.find((c) => c.id === "broken_extract_chain")!;

  it("선언 tok + extract tok + 무참조 → C fail·count 1 (기존엔 na — 두 표면 모순의 해소)", () => {
    const r = evaluateTrust(sc({ variables: { tok: "" }, steps: [step(A, { ...DANGLING, assert: OK })] }));
    expect(cOf(r).status).toBe("fail");
    expect(cOf(r).count).toBe(1);
  });

  it("선언-충돌 extract가 참조되면 pass — na가 아니고 분모가 3이 된다 (spec §4.2 na→pass 전이)", () => {
    const r = evaluateTrust(
      sc({
        variables: { tok: "" },
        steps: [
          step(A, { ...DANGLING, assert: OK }),
          step(B, {
            assert: OK,
            request: { method: "GET", url: "https://e.test/{{tok}}", headers: {} },
          }),
        ],
      }),
    );
    expect(cOf(r).status).toBe("pass");
    expect(r.applicable).toBe(3);
  });

  it("등급 파급(good→caution): A·B pass + 선언-충돌 dangling만으로 caution (spec §4.2)", () => {
    const r = evaluateTrust(sc({ variables: { tok: "" }, steps: [step(A, { ...DANGLING, assert: OK })] }));
    expect(r.level).toBe("caution");
  });

  it("등급 파급(caution→weak): 검증 전무 + 선언-충돌 dangling → 증폭 경유 weak", () => {
    const r = evaluateTrust(sc({ variables: { tok: "" }, steps: [step(A, DANGLING)] }));
    expect(r.noValidationAtAll).toBe(true);
    expect(r.level).toBe("weak");
  });

  it("선언명에 점(namespaced overwrite)은 declared 행 비카운트 — parallel-extract 행이 1개로 셈 (P7 이중 카운트 방지)", () => {
    const r = evaluateTrust(
      sc({
        variables: { "b1.tok": "" },
        steps: [
          {
            id: A,
            name: "par",
            type: "parallel",
            branches: [{ name: "b1", steps: [step(B, { ...DANGLING, assert: OK })] }],
          },
        ],
      }),
    );
    expect(cOf(r).status).toBe("fail");
    expect(cOf(r).count).toBe(1);
  });
});
```

- [ ] **Step 2: RED 확인** — `pnpm test trust; echo "exit=$?"` → 신규 케이스 FAIL(`vars` 부재·C na 등). `trustPrefs.test.ts`도 이름에 걸리면 함께 돌지만 무관-green.

- [ ] **Step 3: 구현** — `trust.ts`:

```ts
export interface TrustCheck {
  id: TrustCheckId;
  status: TrustCheckStatus;
  /** A 전용: 검증이 없는 http 스텝(문서순). B·C는 항상 빈 배열(spec D14). */
  steps: Array<{ id: string; name: string }>;
  /** B·C 전용: 걸린 변수 개수. A는 0. */
  count: number;
  /** B 전용: 미정의 변수 이름 + 위치 클래스(walker가 위반을 처음 만난 순서). A·C는 항상 [].
   *  UI 나열용이 아니다(D14 유지) — RunDialog 게이트(spec P5)와 문구 분기(P3)의 입력. 필수 필드(spec R2). */
  vars: Array<{ name: string; strict: boolean }>;
}

/** spec P3 공유 술어 — TrustBoard·RunDialog가 같은 판정을 쓴다(사본 금지). 빈 입력이면 null:
 *  의미는 호출부가 정한다(TrustBoard는 `c.vars`라 null≈B pass — §5.1이 폴백 정의,
 *  RunDialog는 `uncovered`라 null="바인딩이 전부 공급"·B는 여전히 fail일 수 있다). */
export function bFailMode(
  vars: Array<{ name: string; strict: boolean }>,
): "annihilation" | "misroute" | null {
  if (vars.length === 0) return null;
  return vars.some((v) => v.strict) ? "annihilation" : "misroute";
}
```

`evaluateTrust` 내부:
- A 두 arm과 C 두 arm에 `vars: []` 추가.
- B: `vars: [...undef].map(([name, r]) => ({ name, strict: r.hasStrictRef }))`.
- C 교체:

```ts
  // C — 패널 행 빌더가 단일 소스(D15). 모집단 = extract 행 + 선언-충돌 flat overwrite 행(spec §4.2).
  // 순수 미사용 선언(overwrittenByFlat 아님)은 C 밖 — 안 쓰는 선언은 끊긴 추출 체인이 아니다.
  const rows = buildVarRows(scenario);
  const extractRows = rows.filter(
    (r) => r.kind === "flat-extract" || r.kind === "parallel-extract",
  );
  const overwrittenDecl = rows.filter((r) => r.kind === "declared" && r.overwrittenByFlat);
  const cRows = [...extractRows, ...overwrittenDecl];
  const unused = cRows.filter((r) => r.refIds.length === 0);
  const c: TrustCheck =
    cRows.length === 0
      ? { id: "broken_extract_chain", status: "na", steps: [], count: 0, vars: [] }
      : {
          id: "broken_extract_chain",
          status: unused.length > 0 ? "fail" : "pass",
          steps: [],
          count: unused.length,
          vars: [],
        };
```

- [ ] **Step 4: TrustBoard.test.tsx 픽스처 스윕** — `vars` 필수화로 `tsc -b`가 깨는 손-구성 리포트를 같은 task에서 갱신: `GOOD`·`CAUTION`의 전 체크에 `vars: []`, `WEAK`의 B fail 체크에 `vars: [{ name: "ghost", strict: true }, { name: "ghost2", strict: true }]`(count 2와 정합 — 렌더 결과 불변이라 기존 단언 green 유지). 전수 확인: `grep -rn "undefined_vars\|broken_extract_chain" ui/src --include="*.test.ts*" -l`로 손-구성 `TrustCheck` 리터럴이 있는 다른 파일이 없는지 스윕(evaluateTrust 경유 파일은 무관).

- [ ] **Step 5: GREEN + 빌드 게이트** — `pnpm test trust; echo "exit=$?"` PASS → `pnpm test TrustBoard; echo "exit=$?"` PASS(픽스처 갱신만으로 기존 단언 green) → `pnpm build; echo "exit=$?"` PASS(필수 필드 누락 사이트 0 증명).

- [ ] **Step 6: 이빨 실증** — `cRows`에서 `...overwrittenDecl`을 일시 제거 → `pnpm test trust` → US3 케이스(fail·count 1)와 등급 파급 2케이스 **FAIL 확인** → 원복 → GREEN. `git diff ui/src/scenario/trust.ts`로 원복 확인.

- [ ] **Step 7: 커밋** (FOREGROUND, timeout 600000ms)

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/trust-check-precision && git add ui/src/scenario/trust.ts ui/src/scenario/__tests__/trust.test.ts ui/src/components/scenario/__tests__/TrustBoard.test.tsx && git commit -m "feat(ui): TrustCheck.vars 운반 + bFailMode 공유 술어 + C 선언-충돌 dangling 확장 (trust-check-precision T3, US3)"
```

---

### Task 4: `ko.checkBFailWhyCond` + TrustBoard B fail why 분기

**Files:**
- Modify: `ui/src/i18n/ko.ts` (`trust` 네임스페이스, `checkBFailWhy` 근처)
- Modify: `ui/src/components/scenario/TrustBoard.tsx:11-15`(FAIL_WHY 소비부)
- Test: `ui/src/components/scenario/__tests__/TrustBoard.test.tsx`

**Interfaces:**
- Consumes: Task 3 `bFailMode`, `TrustCheck.vars`.
- Produces: `ko.trust.checkBFailWhyCond`(Global Constraints의 확정 문안 verbatim). UI 계약: B fail 행의 why는 `bFailMode(c.vars) === "misroute"`일 때만 cond 문구, 그 외(`annihilation`·`null`)는 기존 `checkBFailWhy`.

- [ ] **Step 1: 실패하는 테스트 작성** — `TrustBoard.test.tsx`에 픽스처 2개 + 케이스 3개 append:

```ts
// 전부 cond-only(strict:false) — misroute 문구 분기용.
const WEAK_COND: TrustReport = {
  level: "weak",
  checks: [
    { id: "response_validation", status: "pass", steps: [], count: 0, vars: [] },
    {
      id: "undefined_vars",
      status: "fail",
      steps: [],
      count: 2,
      vars: [
        { name: "seg", strict: false },
        { name: "seg2", strict: false },
      ],
    },
    { id: "broken_extract_chain", status: "na", steps: [], count: 0, vars: [] },
  ],
  passed: 1,
  applicable: 2,
  failed: 1,
  noValidationAtAll: false,
};

// null 폴백 전용 — spec §7 예외: 이 픽스처 1개만 의도적으로 fail + vars: [].
const WEAK_EMPTY_VARS: TrustReport = {
  ...WEAK_COND,
  checks: WEAK_COND.checks.map((c) =>
    c.id === "undefined_vars" ? { ...c, vars: [] } : c,
  ),
};
```

```ts
describe("B fail why — 위치 분기 (trust-check-precision US1)", () => {
  it("전부 cond-only → misroute 문구·전멸 문구 부재 (교차-부재)", () => {
    board({ report: WEAK_COND });
    expect(screen.getByText(ko.trust.checkBFailWhyCond)).toBeInTheDocument();
    expect(screen.queryByText(ko.trust.checkBFailWhy)).toBeNull();
  });

  it("strict 포함 → 기존 전멸 문구·cond 문구 부재 (교차-부재)", () => {
    board({ report: WEAK }); // Task 3에서 vars strict:true로 채움
    expect(screen.getByText(ko.trust.checkBFailWhy)).toBeInTheDocument();
    expect(screen.queryByText(ko.trust.checkBFailWhyCond)).toBeNull();
  });

  it("방어: fail + 빈 vars → 기존 문구 폴백 (빈 문구 금지, spec §5.1)", () => {
    board({ report: WEAK_EMPTY_VARS });
    expect(screen.getByText(ko.trust.checkBFailWhy)).toBeInTheDocument();
  });
});
```

(`getByText(문자열)`은 RTL 기본 exact 전체일치 — 두 문안이 서로의 부분문자열이 아님은 spec §6 실측으로 확정. `toHaveTextContent` 금지.)

- [ ] **Step 2: RED 확인** — `pnpm test TrustBoard; echo "exit=$?"` → `checkBFailWhyCond` 부재(tsc는 아직 안 돌지만 vitest 런타임 undefined) 또는 문구 미렌더로 FAIL.

- [ ] **Step 3: ko 키 추가** — `ko.ts`의 `checkBFailWhy`(`:1568` 부근) **바로 다음 줄**에:

```ts
    /** B 위반 참조가 전부 if/elif cond일 때 — 엔진은 lenient(`""` 평가)라 run이 완주하고
     *  분기만 오분류된다(spec US1). strict 포함이면 기존 checkBFailWhy. 문안 확정: spec §6. */
    checkBFailWhyCond:
      "이대로 부하를 걸면 조건이 빈 값으로 평가되어 의도한 분기를 타지 않습니다 — run은 실패 없이 끝나 결함이 숨습니다",
```

- [ ] **Step 4: TrustBoard 분기 구현** — `TrustBoard.tsx`: `bFailMode` import 추가, fail 렌더(`:83` 부근)의 why 줄을:

```tsx
              {/* B는 위치 클래스로 결과가 갈린다(spec §5.1): misroute만 cond 문구,
                  annihilation·null(빈 vars 방어)은 기존 문구 — FAIL_WHY가 그 폴백. */}
              <p className="text-slate-600">
                {c.id === "undefined_vars" && bFailMode(c.vars) === "misroute"
                  ? ko.trust.checkBFailWhyCond
                  : FAIL_WHY[c.id]}
              </p>
```

`FAIL_WHY` Record 자체는 불변(B 엔트리 = `checkBFailWhy`가 곧 null 폴백).

**import 함정(리뷰 S1)**: `TrustBoard.tsx:4`는 `import type { … } from "../../scenario/trust"` — **타입 전용** import다. `bFailMode`를 그 라인에 끼우면 esbuild가 통째로 지워 런타임 `undefined`가 된다 — **별도의 값 import 라인**(`import { bFailMode } from "../../scenario/trust";`)을 새로 추가할 것.

- [ ] **Step 5: GREEN 확인** — `pnpm test TrustBoard; echo "exit=$?"` → 전체 PASS(기존 케이스 포함).

- [ ] **Step 6: 커밋** (FOREGROUND, timeout 600000ms)

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/trust-check-precision && git add ui/src/i18n/ko.ts ui/src/components/scenario/TrustBoard.tsx ui/src/components/scenario/__tests__/TrustBoard.test.tsx && git commit -m "feat(ui): TrustBoard B fail 문구 위치 분기 — cond-only는 오분기 문구 (trust-check-precision T4, US1)"
```

---

### Task 5: `ko.runDialogBFailCond` + RunDialog uncovered 게이트

**Files:**
- Modify: `ui/src/i18n/ko.ts` (`runDialogBFail` `:1591` 부근)
- Modify: `ui/src/components/RunDialog.tsx:357-362`(trust memo 근처에 신규 memo)·`:1044-1070`(Callout 분기·주석 교체)
- Test: `ui/src/components/__tests__/RunDialog.trust.test.tsx`

**Interfaces:**
- Consumes: Task 3 `bFailMode`·`TrustCheck.vars`, `bindings` state(`DataBinding.mappings[].var` — column·literal 공통).
- Produces: `ko.trust.runDialogBFailCond`(확정 문안 verbatim). UI 계약: `uncovered = B.vars − 바인딩 공급 이름` → annihilation=전멸 문구 / misroute=오분기 문구 / null=등급 한 줄.

- [ ] **Step 1: 실패하는 테스트 작성** — `RunDialog.trust.test.tsx`에 append. 기존 헬퍼(`sc`/`step`/`renderDialog`/`boundPrefill`) 재사용. cond-only 시나리오 헬퍼와 케이스 4개:

```ts
/** cond에만 미정의 {{seg}} — B fail(strict:false), 스텝 자체는 assert OK. */
const condOnlyScen = () =>
  sc({
    steps: [
      step(),
      {
        id: "01HZZZZZZZZZZZZZZZZZZZZZZB",
        name: "gate",
        type: "if",
        cond: { left: "{{seg}}", op: "eq", right: "x" },
        then: [step({ id: "01HZZZZZZZZZZZZZZZZZZZZZZC", name: "s-C" })],
        elif: [],
        else: [],
      },
    ],
  });

/** boundPrefill 변형 — 매핑 var만 바꾼다. */
const prefillSupplying = (varName: string): RunPrefill => ({
  profile: normalizeProfile({
    vus: 2,
    duration_seconds: 5,
    data_bindings: [
      {
        dataset_id: "DS1",
        policy: "per_vu",
        mappings: [{ kind: "column", var: varName, column: "c1" }],
      },
    ],
  }),
  env: {},
});
```

```ts
describe("RunDialog — uncovered 게이트 (trust-check-precision US1·US2)", () => {
  it("바인딩 없음 + cond-only 미정의 → misroute 문구(전멸 문구 부재)", () => {
    renderDialog(condOnlyScen());
    expect(screen.getByText(ko.trust.runDialogBFailCond)).toBeInTheDocument();
    expect(screen.queryByText(ko.trust.runDialogBFail)).toBeNull();
  });

  it("무관한 바인딩이 있어도 cond-only 미정의가 남으면 misroute 문구 — 등급 한 줄로 약화되지 않는다 (US2 본체)", () => {
    renderDialog(condOnlyScen(), prefillSupplying("username"));
    expect(screen.getByText(ko.trust.runDialogBFailCond)).toBeInTheDocument();
    // 자기참조 포맷터+failed 카운트 의존을 피해 관용구로(리뷰 N1) — 등급 한 줄 부재를 접두로 판정.
    expect(screen.queryByText(/시나리오 신뢰도/)).toBeNull();
  });

  it("부분 공급: strict(url)만 공급되고 cond 변수가 남으면 misroute — bFailMode 입력은 bVars가 아니라 uncovered (리뷰 M1: 하이브리드 오구현 적발)", () => {
    // B변수 2개(url {{ghost}}=strict + cond {{seg}}) 중 ghost만 바인딩 공급 → uncovered=[seg(cond)].
    // 올바른 구현 bFailMode(uncovered)=misroute. 오구현 `uncovered.length===0 ? null : bFailMode(bVars)`는
    // annihilation을 내 이 케이스만 가른다 — 다른 4케이스는 그 오구현도 통과한다.
    const mixedScen = sc({
      steps: [
        step({ request: { method: "GET", url: "https://e.test/{{ghost}}", headers: {} } }),
        {
          id: "01HZZZZZZZZZZZZZZZZZZZZZZB",
          name: "gate",
          type: "if",
          cond: { left: "{{seg}}", op: "eq", right: "x" },
          then: [step({ id: "01HZZZZZZZZZZZZZZZZZZZZZZC", name: "s-C" })],
          elif: [],
          else: [],
        },
      ],
    });
    renderDialog(mixedScen, prefillSupplying("ghost"));
    expect(screen.getByText(ko.trust.runDialogBFailCond)).toBeInTheDocument();
    expect(screen.queryByText(ko.trust.runDialogBFail)).toBeNull();
  });

  it("그 변수를 공급하는 바인딩이 생기면 등급 한 줄로 완화 (공급 여부가 판정 축)", () => {
    renderDialog(condOnlyScen(), prefillSupplying("seg"));
    expect(screen.getByText(ko.trust.runDialogLine(ko.trust.level.weak, 1))).toBeInTheDocument();
    expect(screen.queryByText(ko.trust.runDialogBFailCond)).toBeNull();
  });

  it("바인딩이 있어도 공급 안 되는 strict(url) 변수가 남으면 전멸 단정 유지", () => {
    const strictScen = sc({
      steps: [step({ request: { method: "GET", url: "https://e.test/{{ghost}}", headers: {} } })],
    });
    renderDialog(strictScen, prefillSupplying("username"));
    expect(screen.getByText(ko.trust.runDialogBFail)).toBeInTheDocument();
  });
});
```

기존 케이스 영향(리뷰가 실측 확정): 이 파일의 기존 2케이스는 **둘 다 수렴이라 무수정 green** — `:110`(url `{{nope}}`+프리필 없음 → uncovered 전체 → annihilation, 동일 문구)·`:123`(url `{{username}}`+`boundPrefill()`이 그 변수를 공급 → uncovered 빔 → 등급 한 줄, 동일). **갱신하지 말 것**(green 테스트를 "갱신"하면 수렴 증거가 사라진다).

- [ ] **Step 2: RED 확인** — `pnpm test RunDialog.trust; echo "exit=$?"` → 신규 케이스 FAIL.

- [ ] **Step 3: ko 키 추가** — `ko.ts` `runDialogBFail`(`:1591` 부근) 바로 다음 줄에:

```ts
    /** uncovered가 전부 cond-only일 때 — run은 완주하고 분기만 오분류(spec US2). 문안 확정: spec §6. */
    runDialogBFailCond: "이대로 실행하면 조건이 빈 값으로 평가되어 의도한 분기를 타지 않습니다",
```

- [ ] **Step 4: RunDialog 구현** — `trust` useMemo(`:359-361`) 아래에:

```tsx
  // B 억제는 "바인딩 존재"가 아니라 "공급 여부"(spec P5): uncovered = B.vars − 매핑 var.
  // 엔진이 바인딩 행 키를 렌더 전에 iter_vars에 넣으므로(runner.rs) 공급된 변수의 참조는
  // 실제로 해석된다 — 공급 안 된 변수가 남으면 결과 문구(전멸/오분기), 전부 공급이면 등급
  // 한 줄. cond-only 변수는 bindingBlock(scanFlowVars가 cond 미스캔)에 안 걸려 제출이
  // 허용되므로 이 줄이 유일한 경고다(soft, D2 — 막지 않고 말만 정확히 한다).
  const trustBMode = useMemo(() => {
    const bVars = trust?.checks.find((c) => c.id === "undefined_vars")?.vars ?? [];
    const supplied = new Set(bindings.flatMap((b) => b.mappings.map((m) => m.var)));
    return bFailMode(bVars.filter((v) => !supplied.has(v.name)));
  }, [trust, bindings]);
```

Callout(`:1044-1070`)의 기존 조건식·주석(`:1049-1059`)을 교체:

```tsx
              {trustBMode === "annihilation"
                ? ko.trust.runDialogBFail
                : trustBMode === "misroute"
                  ? ko.trust.runDialogBFailCond
                  : ko.trust.runDialogLine(ko.trust.level[trust.level], trust.failed)}
```

import에 `bFailMode` 추가(`:16`의 trust import 라인 — **값 import**라 그대로 끼워도 안전).

- [ ] **Step 5: GREEN + 전체 게이트** — `pnpm test RunDialog.trust; echo "exit=$?"` PASS → `pnpm test; echo "exit=$?"`(인자 없는 **전체**, targeted-green ≠ full-green) → `pnpm lint; echo "exit=$?"` → `pnpm build; echo "exit=$?"` 전부 PASS.

- [ ] **Step 6: 이빨 실증** — `trustBMode` 계산을 일시 구식(`trust.checks.find(...)?.status === "fail" && bindings.length === 0 ? "annihilation" : null` 상당)으로 되돌림 → `pnpm test RunDialog.trust` → US2 케이스("무관한 바인딩…misroute 유지")와 strict 케이스 **FAIL 확인** → 원복 → GREEN. `git diff ui/src/components/RunDialog.tsx`로 원복 확인.

- [ ] **Step 7: 커밋** (FOREGROUND, timeout 600000ms)

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/trust-check-precision && git add ui/src/i18n/ko.ts ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.trust.test.tsx && git commit -m "feat(ui): RunDialog B 억제를 바인딩 공급-여부 게이트로 정밀화 (trust-check-precision T5, US1·US2)"
```

---

### Task 6: 전신 spec 정정 각주 5곳 (docs-only, spec P9)

**Files:**
- Modify: `docs/superpowers/specs/2026-07-25-scenario-preflight-design.md` — `:181`·`:230`·`:428`·`:528`(§11.9)·`:530`(§11.10)

**Interfaces:** 코드 무접촉. tdd-guard·spec-review-guard 비발동(docs 경로).

- [ ] **Step 1: 같은-줄 append로 각주 5곳** — **새 줄 삽입 금지**(줄 수가 변하면 이 spec·다른 문서의 `:줄` 참조가 전부 stale). 각 대상 줄의 고유한 꼬리 조각을 `old_string`으로 잡아 Edit로 꼬리에 덧붙인다. **앵커 char-identity 경고(리뷰 S2, CLAUDE.md 반복 함정)**: 앵커를 손으로 타이핑하지 말고 **Read/`grep -n` 출력에서 복사**할 것 — `:181`은 곡선 따옴표(U+201C/U+201D, ASCII `"` 아님), `:230`은 `⟸`(U+27F8)·`①`(U+2460)·`—`(U+2014)+정렬용 다중 공백, `:428`은 em dash+곡선 따옴표를 포함한다(`:528`/`:530`은 평범한 한글+백틱). 0매치가 나면 앵커 바이트를 `python repr`로 확인:
  - `:181`(§4.2 blockquote "run이 전멸한다" 일반화) 꼬리에: ` **[정정 2026-07-28 trust-check-precision: 이 일반화는 요청 표면(url/헤더/바디)에만 참 — cond 오퍼랜드는 `render_lenient`라 run이 완주하고 분기만 오분류된다.]**`
  - `:230`(§5 코드블록 `weak ⟸ B fail (축 ① — 돌지 않는다)`) 꼬리에(코드블록 안이므로 플레인 텍스트): `   ← 정정 2026-07-28: 축①은 "의도대로 돌지 않는다"로 일반화(cond-only B fail은 죽지 않는다 — trust-check-precision)`
  - `:428`(§8 "'조용히 통과' 서사 금지") 꼬리에: ` **[정정 2026-07-28: cond-only 경로는 "조용한 오분기" 서사가 참 — trust-check-precision spec §6이 supersede.]**`
  - `:528`(§11.9) 꼬리에: ` **[정정 2026-07-28 trust-check-precision: "strict cond 렌더에서 죽는다"는 틀림 — cond는 `render_lenient`(condition.rs)라 run은 완주하고 분기만 오분류된다. 이 잔여 한계 자체는 그 spec이 해소(B 이름 운반 + 위치 인식 문구 + RunDialog 공급-여부 게이트).]**`
  - `:530`(§11.10) 꼬리에: ` **[해소 2026-07-28: trust-check-precision이 C 모집단을 declared∧overwrittenByFlat로 확장 — 행 정체성(D15)·패널 렌더는 불변.]**`

- [ ] **Step 2: 줄 수 불변 검증** — `git diff --stat docs/superpowers/specs/2026-07-25-scenario-preflight-design.md`가 `5 insertions(+), 5 deletions(-)`(순증 0)인지, `wc -l`이 편집 전과 같은지 확인.

- [ ] **Step 3: 커밋** (docs-only fast-path)

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/trust-check-precision && git add docs/superpowers/specs/2026-07-25-scenario-preflight-design.md && git commit -m "docs(spec): scenario-preflight 정정 각주 5곳 — cond lenient 사실 정정·§11.9/§11.10 해소 표시 (trust-check-precision T6, P9)"
```

---

## 구현 후 검증 (orchestrator 직접 — plan 밖 파이프라인 단계와 연결)

- [ ] **ko 충돌 대조 재실행** (Global Constraints — Task 5 뒤): 신규 2값 ↔ 기존 ko 한국어 리터럴 전수 양방향 포함 검사(len≥6) 스크립트를 스크래치패드에 쓰고 실행, 상호 포함 0건 확인.
- [ ] **0-diff 완성도 grep**: `git diff $(git merge-base master HEAD) --stat`에 crates/**·VariablesPanel·DataBindingPanel·trustPrefs·EditorShell 부재 확인.
- [ ] **최종 리뷰**: `handicap-reviewer`(+ `finish-slice` §0 보안 grep — 이 diff는 trace/body 뷰어·템플릿 실행 경로 무접촉이라 N/A 예상이나 **grep이 지배한다**).
- [ ] **라이브 검증**: spec §8 표(US1 시나리오 모양 고정 — if 밖 무조건 http + then/else 각각 http, `if_breakdown` 반대 분기 카운트 확인).

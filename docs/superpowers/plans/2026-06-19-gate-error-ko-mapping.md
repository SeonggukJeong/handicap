# 게이트-에러 한국어 매핑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시나리오 에디터 검증 배너가 영어로 새던 Zod 에러 클래스(discriminator·enum·`.strict()` unrecognized-key·`min(1)`/too_small)를 한국어로 매핑한다.

**Architecture:** `ui/src/scenario/problems.ts::formatSegment`(Zod 원문 세그먼트 → 한국어 + 영어 fallback)에 신규 정규식 분기를 추가하고, 한국어 문구는 `ui/src/i18n/ko.ts`의 `editor.gate*` 카탈로그로(ADR-0035). `model.ts` Zod 스키마는 안 건드린다(중앙 매핑). 각 클래스마다 손-세그먼트 테스트 + 실-Zod 드리프트 가드(실 fixture를 `parseScenarioDoc`로 통과시켜 한국어 매핑 확인)로 고정.

**Tech Stack:** TypeScript, Zod 3.25.76, Vitest (jsdom).

**Spec:** `docs/superpowers/specs/2026-06-19-gate-error-ko-mapping-design.md` (R1–R10). 설계 승인(사용자 2026-06-19) + spec-plan-reviewer APPROVE(2라운드).

## Global Constraints

- **UI-only·추가 전용**: 엔진·controller·proto·migration·worker 무변경. 변경 파일은 정확히 3개(`ui/src/i18n/ko.ts`·`ui/src/scenario/problems.ts`·`ui/src/scenario/__tests__/problems.test.ts`). 머지 diff = `ui/`(+docs)만 (R10).
- **`ui/src/scenario/model.ts` 0 diff**: Zod 스키마·커스텀 메시지 불변 → 와이어/API/서버검증 의미론 byte-identical (R7, R10).
- **모든 한국어는 `ko.editor.gate*` 함수 경유**(ADR-0035). path는 원문 dot-경로 유지(기존 컨벤션). 미지 세그먼트는 영어 원문 fallback 보존 (R8).
- **정규식은 실측 Zod 3.25.76 문구 기준**(spec §3.1). 추측 금지 — 실-Zod 테스트가 드리프트를 빨갛게 잡는다 (R9).
- **`unrecognized_keys`는 passthrough 사이트(`extract[]` 원소·`cond`·`request.disabled`)에서만 도달, path 항상 non-empty**(spec §3.5 — normalize 허용리스트가 root/step/request 여분 키를 제거). empty-path 분기 없음, 정규식 `(.+)`.
- **게이트 검증/커밋 함정(루트 CLAUDE.md)**: ui-only 커밋은 pre-commit이 `pnpm lint && pnpm test && pnpm build` UI 게이트만 실행(cargo skip). 커밋은 파이프(`| tail`) 없이 단일 호출 + 직후 `git log -1` 확인. `git add`는 명시 경로만(`-A` 금지).

---

### Task 1: 게이트-에러 한국어 매핑 추가 (단일 green 커밋)

> 이 repo의 게이트는 RED-only·미사용-헬퍼-only 단독 커밋이 불가하므로 **하나의 green 커밋으로 fold**(spec §8). TDD 순서는 task 내부에서: ko 키+헬퍼 선행(테스트 컴파일 가능) → 매핑 테스트 작성(RED) → formatSegment 배선(GREEN).

**Files:**
- Modify: `ui/src/i18n/ko.ts` (editor 블록, `gateDuplicateBranch` 다음 ~line 273에 신규 키 10개)
- Modify: `ui/src/scenario/problems.ts` (`normalizeList` export 추가 + `formatSegment`에 신규 분기 10개)
- Test: `ui/src/scenario/__tests__/problems.test.ts` (신규 describe 3개)

**Interfaces:**
- Consumes: 기존 `ko.editor.gate*`(gateRequired/gateNameRequired/gateInvalidLiteral/gateInvalidType/gateDuplicateBranch), `formatGateMessages`/`formatSegment`(problems.ts), `parseScenarioDoc`(yamlDoc.ts), `ULID_A`/`ULID_B`(테스트 상수).
- Produces: `ko.editor.gateInvalidChoice(path, allowed)`, `gateInvalidChoiceReceived(path, allowed, received)`, `gateUnknownKeys(path, keys)`, `gateEmptyValue(path)`, `gateLoopBodyMin(path)`, `gateIfBranchMin(path)`, `gateElifBranchMin(path)`, `gateParallelBranchesMin(path)`, `gateBranchStepsMin(path)`, `gateRepeatMin(path)` — 전부 `(...: string) => string`. `problems.ts` `export function normalizeList(s: string): string`.

---

- [ ] **Step 1: ko.editor 게이트 키 10개 추가 (R1–R5, R7)**

`ui/src/i18n/ko.ts`에서 `gateDuplicateBranch:` 정의 바로 다음(현재 ~line 273, 그 아래 `// ── Inspector 필드 라벨 ──` 주석 앞)에 삽입:

```ts
    gateInvalidChoice: (path: string, allowed: string) =>
      `${path}: 값이 올바르지 않습니다 (허용: ${allowed})`,
    gateInvalidChoiceReceived: (path: string, allowed: string, received: string) =>
      `${path}: 값이 올바르지 않습니다 (허용: ${allowed}, 입력 ${received})`,
    gateUnknownKeys: (path: string, keys: string) =>
      `${path}: 알 수 없는 항목이 있습니다 (${keys})`,
    gateEmptyValue: (path: string) => `${path}: 값이 비어 있습니다`,
    gateLoopBodyMin: (path: string) => `${path}: 루프 본문에 스텝이 최소 1개 필요합니다`,
    gateIfBranchMin: (path: string) => `${path}: if 분기에 스텝이 최소 1개 필요합니다`,
    gateElifBranchMin: (path: string) => `${path}: elif 분기에 스텝이 최소 1개 필요합니다`,
    gateParallelBranchesMin: (path: string) => `${path}: parallel 노드에 분기가 최소 1개 필요합니다`,
    gateBranchStepsMin: (path: string) => `${path}: 분기에 스텝이 최소 1개 필요합니다`,
    gateRepeatMin: (path: string) => `${path}: 반복 횟수는 1 이상이어야 합니다`,
```

- [ ] **Step 2: `normalizeList` 헬퍼 추가 + export (R6)**

`ui/src/scenario/problems.ts`에서 `formatSegment` 함수 **위**(혹은 파일 끝 export 영역)에 추가:

```ts
/** Zod의 따옴표·파이프 구분 목록(`'a' | 'b'` / `'x', 'y'`)을 사람이 읽는 콤마 목록으로.
 *  discriminator/enum 허용값·unrecognized 키 이름에 적용 (spec R6). */
export function normalizeList(s: string): string {
  return s.replace(/'/g, "").replace(/ \| /g, ", ");
}
```

(아직 `formatSegment`에서 호출하지 않아도 export + 테스트가 쓰므로 미사용 lint 에러 없음.)

- [ ] **Step 3: 신규 테스트 작성 — 손-세그먼트 + normalizeList + 실-Zod (R1–R6, R9)**

`ui/src/scenario/__tests__/problems.test.ts`의 import에 `normalizeList` 추가:

```ts
import { collectProblems, formatGateMessages, normalizeList } from "../problems";
```

파일 끝(마지막 `});` 다음)에 describe 3개 추가:

```ts
describe("formatGateMessages — 신규 게이트 클래스 (손-세그먼트)", () => {
  it("discriminator(invalid_union_discriminator)를 매핑한다", () => {
    expect(
      formatGateMessages(
        "steps.0.type: Invalid discriminator value. Expected 'http' | 'loop' | 'if' | 'parallel'",
      ),
    ).toEqual([ko.editor.gateInvalidChoice("steps.0.type", "http, loop, if, parallel")]);
  });

  it("enum(invalid_enum_value)을 매핑한다", () => {
    expect(
      formatGateMessages(
        "steps.0.request.method: Invalid enum value. Expected 'GET' | 'POST', received 'BOGUS'",
      ),
    ).toEqual([
      ko.editor.gateInvalidChoiceReceived("steps.0.request.method", "GET, POST", "BOGUS"),
    ]);
  });

  it("unrecognized_keys(키 1개·2개)를 매핑한다", () => {
    expect(
      formatGateMessages("steps.0.extract.0: Unrecognized key(s) in object: 'bogus'"),
    ).toEqual([ko.editor.gateUnknownKeys("steps.0.extract.0", "bogus")]);
    expect(
      formatGateMessages("steps.0.extract.0: Unrecognized key(s) in object: 'bogus', 'other'"),
    ).toEqual([ko.editor.gateUnknownKeys("steps.0.extract.0", "bogus, other")]);
  });

  it("string min(1)(빈 값)을 매핑한다", () => {
    expect(
      formatGateMessages("steps.0.extract.0.var: String must contain at least 1 character(s)"),
    ).toEqual([ko.editor.gateEmptyValue("steps.0.extract.0.var")]);
  });

  it("커스텀 컨테이너/숫자 min 문구 6종을 매핑한다", () => {
    expect(formatGateMessages("steps.0.do: loop body needs at least one step")).toEqual([
      ko.editor.gateLoopBodyMin("steps.0.do"),
    ]);
    expect(formatGateMessages("steps.0.then: if branch needs at least one step")).toEqual([
      ko.editor.gateIfBranchMin("steps.0.then"),
    ]);
    expect(
      formatGateMessages("steps.0.elif.0.then: elif branch needs at least one step"),
    ).toEqual([ko.editor.gateElifBranchMin("steps.0.elif.0.then")]);
    expect(formatGateMessages("steps.0.branches: parallel needs at least one branch")).toEqual([
      ko.editor.gateParallelBranchesMin("steps.0.branches"),
    ]);
    expect(
      formatGateMessages("steps.0.branches.0.steps: branch needs at least one step"),
    ).toEqual([ko.editor.gateBranchStepsMin("steps.0.branches.0.steps")]);
    expect(formatGateMessages("steps.0.repeat: repeat must be >= 1")).toEqual([
      ko.editor.gateRepeatMin("steps.0.repeat"),
    ]);
  });
});

describe("normalizeList", () => {
  it("따옴표 제거 + 파이프→콤마", () => {
    expect(normalizeList("'http' | 'loop' | 'if'")).toBe("http, loop, if");
    expect(normalizeList("'bogus', 'other'")).toBe("bogus, other");
    expect(normalizeList("'GET'")).toBe("GET");
  });
});

describe("실-Zod 드리프트 가드 — 신규 클래스 (parseScenarioDoc 경유)", () => {
  // 손-작성 문자열이 아니라 진짜 Zod가 만든 에러로 매핑을 고정 —
  // zod 마이너 범프로 문구가 바뀌면 이 테스트만 빨개진다(조용한 영어 fallback 강등 방지, spec R9).
  function gateError(yaml: string): string {
    const parsed = parseScenarioDoc(yaml);
    if (!("error" in parsed)) throw new Error("fixture must fail to parse");
    return parsed.error;
  }

  it("discriminator: 잘못된 type", () => {
    const err = gateError(`version: 1
name: s
steps:
  - type: bogus
    id: ${ULID_A}
    name: x
`);
    expect(formatGateMessages(err)).toContain(
      ko.editor.gateInvalidChoice("steps.0.type", "http, loop, if, parallel"),
    );
  });

  it("enum: 잘못된 method", () => {
    const err = gateError(`version: 1
name: s
steps:
  - type: http
    id: ${ULID_A}
    name: x
    request:
      method: BOGUS
      url: ""
`);
    expect(formatGateMessages(err)).toContain(
      ko.editor.gateInvalidChoiceReceived(
        "steps.0.request.method",
        "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
        "BOGUS",
      ),
    );
  });

  it("unrecognized: extract 원소 여분 키", () => {
    const err = gateError(`version: 1
name: s
steps:
  - type: http
    id: ${ULID_A}
    name: x
    request:
      method: GET
      url: ""
    extract:
      - var: v
        from: status
        bogus: 1
`);
    expect(formatGateMessages(err)).toContain(
      ko.editor.gateUnknownKeys("steps.0.extract.0", "bogus"),
    );
  });

  it("string min: 빈 extract var", () => {
    const err = gateError(`version: 1
name: s
steps:
  - type: http
    id: ${ULID_A}
    name: x
    request:
      method: GET
      url: ""
    extract:
      - var: ""
        from: status
`);
    expect(formatGateMessages(err)).toContain(
      ko.editor.gateEmptyValue("steps.0.extract.0.var"),
    );
  });

  it("커스텀: 빈 loop do", () => {
    const err = gateError(`version: 1
name: s
steps:
  - type: loop
    id: ${ULID_A}
    name: l
    repeat: 2
    do: []
`);
    expect(formatGateMessages(err)).toContain(ko.editor.gateLoopBodyMin("steps.0.do"));
  });

  it("커스텀: repeat 0", () => {
    const err = gateError(`version: 1
name: s
steps:
  - type: loop
    id: ${ULID_A}
    name: l
    repeat: 0
    do:
      - type: http
        id: ${ULID_B}
        name: inner
        request:
          method: GET
          url: ""
`);
    expect(formatGateMessages(err)).toContain(ko.editor.gateRepeatMin("steps.0.repeat"));
  });
});
```

- [ ] **Step 4: 테스트 실행 → RED 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/gate-error-ko/ui && pnpm test problems`
Expected: `normalizeList` describe는 PASS, 나머지 신규 테스트(손-세그먼트 + 실-Zod)는 FAIL — `formatSegment`가 아직 신규 분기가 없어 영어 원문을 그대로 반환(예: `["steps.0.type: Invalid discriminator value. ..."]` ≠ `[ko.editor.gateInvalidChoice(...)]`). 기존 테스트는 전부 PASS.

- [ ] **Step 5: `formatSegment`에 신규 분기 배선 (R1–R6, R8)**

`ui/src/scenario/problems.ts`의 `formatSegment` 함수에서 마지막 기존 분기(`gateDuplicateBranch`) 다음, **`return seg;` 바로 앞**에 삽입:

```ts
  m = /^(.+): Invalid discriminator value\. Expected (.+)$/.exec(seg);
  if (m) return ko.editor.gateInvalidChoice(m[1], normalizeList(m[2]));
  m = /^(.+): Invalid enum value\. Expected (.+), received (.+)$/.exec(seg);
  if (m) return ko.editor.gateInvalidChoiceReceived(m[1], normalizeList(m[2]), normalizeList(m[3]));
  m = /^(.+): Unrecognized key\(s\) in object: (.+)$/.exec(seg);
  if (m) return ko.editor.gateUnknownKeys(m[1], normalizeList(m[2]));
  m = /^(.+): String must contain at least 1 character\(s\)$/.exec(seg);
  if (m) return ko.editor.gateEmptyValue(m[1]);
  m = /^(.+): loop body needs at least one step$/.exec(seg);
  if (m) return ko.editor.gateLoopBodyMin(m[1]);
  m = /^(.+): if branch needs at least one step$/.exec(seg);
  if (m) return ko.editor.gateIfBranchMin(m[1]);
  m = /^(.+): elif branch needs at least one step$/.exec(seg);
  if (m) return ko.editor.gateElifBranchMin(m[1]);
  m = /^(.+): parallel needs at least one branch$/.exec(seg);
  if (m) return ko.editor.gateParallelBranchesMin(m[1]);
  m = /^(.+): branch needs at least one step$/.exec(seg);
  if (m) return ko.editor.gateBranchStepsMin(m[1]);
  m = /^(.+): repeat must be >= 1$/.exec(seg);
  if (m) return ko.editor.gateRepeatMin(m[1]);
```

> 순서 안전성(spec §3.4): enum 문구는 기존 invalid-type `/^(.+): Expected (.+), received (.+)$/`에 매치 안 됨(`: Expected ` 부재). discriminator는 invalid-literal과 어휘 상이. 충돌 없음 — 위 배치(기존 분기 뒤) 그대로 OK.

- [ ] **Step 6: 테스트 실행 → GREEN 확인 (R1–R6, R8, R9)**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/gate-error-ko/ui && pnpm test problems`
Expected: `problems.test.ts` 전부 PASS(기존 + 신규).
**실-Zod 테스트가 실패하면** = 실제 Zod 출력의 path/문구가 기대와 다름 → `parseScenarioDoc(<fixture>)`의 `.error`를 직접 찍어(예: 임시 `console.log(parsed.error)`) 실제 세그먼트 확인 후 **기대 문자열의 path만** 조정(정규식/매핑은 path-agnostic이라 불변). 조정 후 임시 로그 제거.

- [ ] **Step 7: 전체 UI 게이트 (R10)**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/gate-error-ko/ui && pnpm lint && pnpm test && pnpm build`
Expected: 셋 다 통과(`pnpm lint`=`--max-warnings=0`, `pnpm test`=전체 스위트, `pnpm build`=`tsc -b && vite build`). 실패 시 해당 게이트 메시지대로 수정.

- [ ] **Step 8: 커밋 (R10)**

```bash
git add ui/src/i18n/ko.ts ui/src/scenario/problems.ts ui/src/scenario/__tests__/problems.test.ts
git commit -m "feat(ui): map Zod gate-error classes to Korean in validation banner (R1-R10)

discriminator·enum·unrecognized-key·min(1)/too_small 세그먼트를 ko.editor.gate*로
매핑(+normalizeList). 실-Zod 드리프트 가드 포함. model.ts/와이어 무변경.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

파이프 없이 단일 호출. 직후 확인: `git log -1 --stat` (변경 파일이 정확히 위 3개 + 경로가 `ui/`만인지).

**Task 1 acceptance:** `pnpm lint && pnpm test && pnpm build` green · `git diff --stat master..HEAD`이 `ui/src/i18n/ko.ts`·`ui/src/scenario/problems.ts`·`ui/src/scenario/__tests__/problems.test.ts` 3개만(`model.ts` 0 diff) · 신규 10개 매핑 + 6개 실-Zod 가드 PASS.

---

## 최종 검증 / 마무리 (Task 1 이후, finish-slice가 수행)

- **최종 리뷰**: `handicap-reviewer` APPROVE(와이어 1:1·정규식 충돌·fallback 보존·완성도). 보안 게이트는 path-gate(요청실행/템플릿/cast/env·dataset/업로드/trace-body) **미해당** → `security-reviewer` N/A(finish-slice §0 grep이 매치 0).
- **라이브 검증 면제**: run-생성·응답-파싱·엔진 경로 무변경(R10), 실-Zod 테스트가 `parseScenarioDoc` 경로를 결정적으로 커버. build-log에 면제 근거 기록.
- **docs**: build-log 한 단락 append · roadmap "U4 연기 항목"(line 108)에서 해소된 3클래스 갱신(+ §7 신규 연기: 숫자 범위·`z.union Invalid input`) · 루트 CLAUDE.md 상태줄 교체 · 메모리.

---

## Self-Review (writing-plans)

**1. Spec coverage (R1–R10):**
- R1 discriminator → Step 1(gateInvalidChoice)+Step 5(정규식)+Step 3(손/실-Zod 테스트) ✓
- R2 enum → Step 1(gateInvalidChoiceReceived)+Step 5+Step 3 ✓
- R3 unrecognized(non-empty path만) → Step 1(gateUnknownKeys)+Step 5(`(.+)`)+Step 3(키1·2 + extract 원소 실-Zod) ✓
- R4 string-min → Step 1(gateEmptyValue)+Step 5+Step 3 ✓
- R5 커스텀 6종 → Step 1(6 키)+Step 5(6 정규식)+Step 3(손 6 + 실-Zod do/repeat) ✓
- R6 normalizeList → Step 2(export)+Step 3(단위 테스트)+Step 5(적용) ✓
- R7 ko 카탈로그·model.ts 0 diff → Global Constraints + Step 1(전부 ko) + Task acceptance(diff 검사) ✓
- R8 기존 동작·fallback 보존 → Step 6(기존 테스트 green)+Step 5(기존 분기 앞, return seg fallback 유지) ✓
- R9 실-Zod 드리프트 가드 → Step 3 실-Zod describe(5클래스/6 테스트) ✓
- R10 byte-identical/UI-only → Global Constraints + Step 7(build)+Step 8(diff 확인)+Task acceptance ✓

**2. Placeholder scan:** 코드 스텝 전부 실제 코드(ko 키 10개·헬퍼·정규식 10개·테스트 전문) 포함. "TBD"/"적절히 처리" 없음. ✓

**3. Type consistency:** ko 키 시그니처(Step 1) ↔ formatSegment 호출(Step 5) ↔ 테스트 기대(Step 3) 1:1 — `gateInvalidChoice(path, allowed)`·`gateInvalidChoiceReceived(path, allowed, received)`·`gateUnknownKeys(path, keys)`·`gateEmptyValue(path)`·6× `gate*Min(path)` 전부 일치. `normalizeList(s)` export(Step 2) ↔ import(Step 3) ↔ 호출(Step 5) 일치. ✓

---

<!-- REVIEW-GATE: APPROVED -->
spec-plan-reviewer clean APPROVE (2026-06-19) — plan을 실파일에 verbatim 적용해 RED(11/17)→GREEN(28/28)·build/lint exit 0 재현, 6개 실-Zod fixture가 단언대로 발화 확인 후 byte-identical 복원.

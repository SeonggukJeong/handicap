# genvar-preview-ux Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

REVIEW-GATE: APPROVED

**Goal:** 생성 변수(gen) 예시를 (이름·파라미터·틱)의 결정적 함수로 안정화하고(draft 즉시 반영 + ↻ 재추첨), 범위 입력에 native 구속·인라인 안내를 더하고, 변수 패널 gen 행 레이아웃(헤더 한 줄·요약/예시 2행·random_int 그리드)을 정돈한다.

**Spec:** `docs/superpowers/specs/2026-07-24-genvar-preview-ux-design.md` (US1~5 — spec 앞머리 US 블록이 오라클)

**Architecture:** 순수 헬퍼(`genVars.ts`: 시드 결정적 `samplePreview`·`genParamsSummary`·draft 유효성)를 먼저 세우고, 컴포넌트(`GenVarEditor`/`VariablesPanel`)는 그 헬퍼를 배선만 한다. 커밋 시점/값 의미론(F5 blur 정책)은 동작-보존 — 미리보기·안내는 draft에서 *도출*만 하고 store 쓰기 경로는 불변. 모델·store·yamlDoc·엔진 0-diff.

**Tech Stack:** React + TS + Tailwind, vitest + RTL. 신규 의존성 없음.

## Global Constraints

- **작업 위치**: 모든 명령은 `cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-preview-ux` 후 실행(서브에이전트 프롬프트 첫 줄에 명시). UI 명령은 그 아래 `ui/`에서.
- **게이트 판정은 파이프 금지**: `pnpm lint; echo lint=$?` / `pnpm test <파일필터>; echo test=$?` / `pnpm build; echo build=$?` — `| tail` 등 파이프는 실패를 마스킹한다. 단일 파일 반복은 `pnpm test GenVarEditor`(`--` 없이).
- **tdd-guard**: 각 Task의 첫 스텝은 반드시 테스트 파일 편집(pending test 생성) — 직전 task 커밋 직후 트리는 clean이라 production 첫-편집은 차단된다.
- **모든 사용자 노출 문구·aria-label은 `ko.ts` 경유**(ADR-0035). 신규 ko 키 7개의 값은 아래 표가 정본(verbatim):

| 키 | 값 |
|---|---|
| `genSampleRefreshAria` | `(name) => \`${name} 예시 다시 뽑기\`` |
| `genSampleRefreshTitle` | `"다시 뽑기 — 실행 시 반복마다 새 값이 생성됩니다"` |
| `genLengthInvalid` | `"1~64 사이 정수만 적용됩니다"` |
| `genStepInvalid` | `"단위는 1 이상 정수만 적용됩니다"` |
| `genIntInvalid` | `"정수만 입력할 수 있습니다"` |
| `genMinMaxConflict` | `"최소가 최대보다 커서 적용되지 않습니다"` |
| `genLengthSuffix` | `"자"` ("N자" 접미 — `genStepUnit` 선례와 동형) |

- **ko 충돌 검사(실행됨, 2026-07-24 오케스트레이터·Task 5에서 재실행)**: 신규↔신규 full-value 포함 0. 신규↔기존은 한 단어 라벨 값("최소"·"최대"·"단위"·"적용"·"실행"·"반복"·"—")이 신규 *문장*에 포함되는 방향만 존재하고, `genLengthSuffix`("자")는 1글자 접미라 기존 다수 값에 포함되는 같은 클래스(`genStepUnit` "단위"와 동일 취급 — 단독 단언 금지) → **단언 규칙**: 신규 문구는 항상 전문 exact(`getByText(ko.editor.genLengthInvalid)` 등)로 단언하고, 컨테이너 `toHaveTextContent`에 한 단어 라벨을 단독 사용하지 않는다. `genSampleRefreshTitle`의 "실행 시" 조각은 `genSampleUnsupported`와 공유 — 두 값 관련 단언은 전문/`/^…$/`만.
- **className 계약 단언은 `.split(/\s+/)` 토큰 membership** — raw `toContain`은 substring false-green.
- **blur 커밋 정책 동작-보존**: commit/revert/no-op 분기 변화 금지 — 기존 특성화 테스트(`GenVarEditor.test.tsx` min/max 짝-hold·revert 케이스) green 유지가 증명.
- **react-refresh**: 컴포넌트 파일(`GenVarEditor.tsx`/`VariablesPanel.tsx`)에서 비-컴포넌트 export 금지 — 순수 헬퍼는 `genVars.ts`에.
- **회귀 가드 표방 테스트는 이빨 실증**(고의 회귀→RED→원복→GREEN, 실행 로그를 task 보고에 포함) — Task 1 결정성·Task 3 안내 게이트가 대상.
- 각 Task 종료 = `pnpm lint`+targeted `pnpm test`+`pnpm build` 모두 exit 0 + 독립 커밋(FOREGROUND, timeout 600000ms).

---

### Task 1: genVars.ts — 시드 결정적 샘플·파라미터 요약·draft 유효성 헬퍼

**Files:**
- Modify: `ui/src/scenario/genVars.ts`
- Test: `ui/src/scenario/__tests__/genVars.test.ts`

**Interfaces (Produces — Task 2·3·4가 소비):**
```ts
export function canonicalGenKey(spec: GenSpec): string;
export function hashSeed(s: string): number;            // FNV-1a → uint32
export function seededRand(seed: number): () => number; // mulberry32
export function samplePreview(spec: GenSpec, name: string, tick: number): SamplePreview;
export function genParamsSummary(spec: GenSpec): string; // 타입명 없는 파라미터 요약
export function lengthDraftValue(s: string): number | null; // 비공백 & 정수 & 1..64 → n, else null
export function stepDraftValue(s: string): number | null;   // 비공백 & 정수 & >=1 → n, else null
export function sampleFor(spec: GenSpec, now?: Date, rand?: () => number): SamplePreview; // rand 기본 Math.random
export function declSearchText(v: VarDeclValue): string; // gen → `${genTypeLabel(v)} ${genParamsSummary(v)}`.trim()
// genSummary는 이 task에서 아직 유지(VariablesPanel 소비 잔존) — Task 4에서 제거
```

- [ ] **Step 1: 실패 테스트 작성** — `genVars.test.ts`에 아래를 추가하고, 기존 `genSummary` describe(현 `:105`~`:140`, 7단언)를 `genParamsSummary`로 재표적, `declSearchText returns the summary...` 케이스(현 `:78-81`)를 재작성:

```ts
// import에 canonicalGenKey, samplePreview, genParamsSummary, lengthDraftValue, stepDraftValue 추가
// + import에서 genSummary **제거** — 재표적 후 미참조 import는 `pnpm lint`(--max-warnings=0) 실패
//   + Task 4의 `grep genSummary → 0매치` 기대도 깨뜨린다

describe("samplePreview — 시드 결정적", () => {
  it("같은 (spec,name,tick)이면 어느 호출에서든 같은 텍스트", () => {
    const spec: GenSpec = { gen: "random_string", length: 12 };
    const a = samplePreview(spec, "sid", 0);
    const b = samplePreview(spec, "sid", 0);
    expect(a).toEqual(b);
    if (a.kind !== "ok") throw new Error("expected ok");
    expect(a.text).toHaveLength(12); // 길이 파라미터가 텍스트에 반영
  });

  it("tick이 바뀌면 랜덤 3종의 텍스트가 바뀐다", () => {
    for (const spec of [
      { gen: "random_string", length: 12 },
      { gen: "random_int", min: 1, max: 1000000 },
      { gen: "uuid" },
    ] as GenSpec[]) {
      const a = samplePreview(spec, "v", 0);
      const b = samplePreview(spec, "v", 1);
      expect(a).not.toEqual(b);
    }
  });

  it("random_int 샘플은 min..max 구간의 step 배수 지점", () => {
    const spec: GenSpec = { gen: "random_int", min: 10, max: 100, step: 10 };
    const s = samplePreview(spec, "n", 3);
    if (s.kind !== "ok") throw new Error("expected ok");
    const v = Number(s.text);
    expect(v).toBeGreaterThanOrEqual(10);
    expect(v).toBeLessThanOrEqual(100);
    expect((v - 10) % 10).toBe(0);
  });

  it("uuid 샘플은 8-4-4-4-12 v4 형식", () => {
    const s = samplePreview({ gen: "uuid" }, "u", 0);
    if (s.kind !== "ok") throw new Error("expected ok");
    expect(s.text).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("canonicalGenKey", () => {
  it("step 생략과 step:1은 같은 키(기본값 정규화)", () => {
    expect(canonicalGenKey({ gen: "random_int", min: 1, max: 9 })).toBe(
      canonicalGenKey({ gen: "random_int", min: 1, max: 9, step: 1 }),
    );
  });
  it("length 생략과 8은 같은 키", () => {
    expect(canonicalGenKey({ gen: "random_string" })).toBe(
      canonicalGenKey({ gen: "random_string", length: 8 }),
    );
  });
  it("파라미터가 다르면 키가 다르다", () => {
    expect(canonicalGenKey({ gen: "random_string", length: 8 })).not.toBe(
      canonicalGenKey({ gen: "random_string", length: 9 }),
    );
  });
});

describe("genParamsSummary (타입명 없는 요약)", () => {
  // 기존 genSummary describe의 date/int 기대값은 그대로, uuid/rs만 새 값
  it("date: offset+tz", () => {
    expect(genParamsSummary({ gen: "date", offset: "+7d", tz: "Asia/Seoul" })).toBe("오늘+7일 · Asia/Seoul");
  });
  it("date: offset 없음 → 오늘", () => {
    expect(genParamsSummary({ gen: "date", tz: "UTC" })).toBe("오늘 · UTC");
  });
  it("date: tz 없음 → 워커 로컬", () => {
    expect(genParamsSummary({ gen: "date" })).toBe("오늘 · 워커 로컬");
  });
  it("random_int: step!==1이면 단위 접미", () => {
    expect(genParamsSummary({ gen: "random_int", min: 1000, max: 10000, step: 100 })).toBe("1000 ~ 10000 · 100 단위");
  });
  it("random_int: step 1/생략은 접미 없음", () => {
    expect(genParamsSummary({ gen: "random_int", min: 1, max: 100 })).toBe("1 ~ 100");
    expect(genParamsSummary({ gen: "random_int", min: 1, max: 100, step: 1 })).toBe("1 ~ 100");
  });
  it("uuid: 빈 문자열(배지 단독)", () => {
    expect(genParamsSummary({ gen: "uuid" })).toBe("");
  });
  it("random_string: N자", () => {
    expect(genParamsSummary({ gen: "random_string" })).toBe("8자");
    expect(genParamsSummary({ gen: "random_string", length: 12 })).toBe("12자");
  });
});

describe("declSearchText (타입명 포함 — 검색 하위호환+개선)", () => {
  it("gen 값은 타입명+파라미터", () => {
    expect(declSearchText({ gen: "random_int", min: 1, max: 100 })).toBe("랜덤 정수 1 ~ 100");
    expect(declSearchText({ gen: "random_string", length: 12 })).toBe("랜덤 문자열 12자");
  });
  it("uuid는 매달린 공백 없이 타입명만", () => {
    expect(declSearchText({ gen: "uuid" })).toBe("UUID");
  });
});

describe("draft 유효성 헬퍼 (commit 술어와 동작 동일 — 특성화)", () => {
  it("lengthDraftValue: 1..64 정수만", () => {
    expect(lengthDraftValue("12")).toBe(12);
    expect(lengthDraftValue(" 8 ")).toBe(8);
    expect(lengthDraftValue("0")).toBeNull();
    expect(lengthDraftValue("-1")).toBeNull();
    expect(lengthDraftValue("65")).toBeNull();
    expect(lengthDraftValue("3.5")).toBeNull();
    expect(lengthDraftValue("")).toBeNull();
  });
  it("stepDraftValue: >=1 정수만", () => {
    expect(stepDraftValue("1")).toBe(1);
    expect(stepDraftValue("100")).toBe(100);
    expect(stepDraftValue("0")).toBeNull();
    expect(stepDraftValue("1.5")).toBeNull();
    expect(stepDraftValue("")).toBeNull();
  });
});
```

- [ ] **Step 2: RED 확인** — `cd ui && pnpm test genVars; echo test=$?` → FAIL(신규 export 미존재 TS/참조 에러). exit≠0 확인.

- [ ] **Step 3: 구현** — `genVars.ts`:
  - `sampleFor` 시그니처를 `(spec: GenSpec, now: Date = new Date(), rand: () => number = Math.random)`으로 확장하고 본문의 `Math.random()` 3곳(`:189,193,207`)을 `rand()`로 치환(다른 로직 불변).
  - 추가:

```ts
export function canonicalGenKey(spec: GenSpec): string {
  switch (spec.gen) {
    case "date":
      return `date:${spec.format ?? ""}:${spec.offset ?? ""}:${spec.tz ?? ""}`;
    case "random_int":
      return `ri:${spec.min}:${spec.max}:${spec.step ?? 1}`;
    case "uuid":
      return "uuid";
    case "random_string":
      return `rs:${spec.length ?? 8}`;
  }
}

// FNV-1a 32-bit — 시드 파생 전용(암호학적 용도 아님)
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32 — 결정적 PRNG(미리보기 전용)
export function seededRand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 예시 미리보기 단일 진입점 — (이름·파라미터·틱)의 순수 함수라 어느 마운트에서든 동일 텍스트.
 *  date 분기는 rand 미사용(시계 기반)이라 자연히 영향 없음. */
export function samplePreview(spec: GenSpec, name: string, tick: number): SamplePreview {
  return sampleFor(spec, new Date(), seededRand(hashSeed(`${name}|${canonicalGenKey(spec)}|${tick}`)));
}

/** 접힘 요약 줄용 — 타입명은 배지가 담당하므로 파라미터만. uuid는 빈 문자열(배지 단독). */
export function genParamsSummary(spec: GenSpec): string {
  switch (spec.gen) {
    case "date":
      return `${offsetKo(spec.offset)} · ${spec.tz ?? ko.editor.genTzWorkerLocal}`;
    case "random_int": {
      const base = `${spec.min} ~ ${spec.max}`;
      const step = spec.step ?? 1;
      return step === 1 ? base : `${base} · ${step} ${ko.editor.genStepUnit}`;
    }
    case "uuid":
      return "";
    case "random_string":
      return `${spec.length ?? 8}${ko.editor.genLengthSuffix}`;
  }
}

// commit 술어와 바이트 동일 규칙(동작-보존): Number() + isInteger + 범위 — 정규식 강화 금지
// (기존 commitLength/commitStep이 "5e0" 같은 지수 표기도 Number 경유로 수용하므로 그대로 미러)
export function lengthDraftValue(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= 64 ? n : null;
}
export function stepDraftValue(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 ? n : null;
}
```

  - `declSearchText`를 `isGenSpec(v) ? \`${genTypeLabel(v)} ${genParamsSummary(v)}\`.trim() : v`로 교체.
  - `ko.ts`에 `genLengthSuffix: "자"` 1키 추가(`genFieldLabelLength` 아래) — "N자" 요약의 단위 접미(하드코딩 스윕 통과용, ADR-0035).
  - `genSummary`는 **삭제하지 않는다**(VariablesPanel이 아직 소비 — Task 4에서 제거).

- [ ] **Step 4: GREEN 확인** — `pnpm test genVars; echo test=$?` → exit 0.

- [ ] **Step 5: 이빨 실증(결정성 테스트)** — `samplePreview` 본문을 일시 `sampleFor(spec)`(시드 없이)로 바꿔 `pnpm test genVars` → "같은 (spec,name,tick)" 케이스 **RED 확인** 후 원복 → GREEN. RED/GREEN 로그를 task 보고에 포함.

- [ ] **Step 6: 게이트+커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-preview-ux/ui
pnpm lint; echo lint=$?
pnpm test genVars; echo test=$?
pnpm build; echo build=$?
cd .. && git add ui/src/scenario/genVars.ts ui/src/scenario/__tests__/genVars.test.ts ui/src/i18n/ko.ts
git commit -m "feat(ui): gen 변수 시드 결정적 샘플·파라미터 요약 헬퍼 (genvar-preview-ux T1)"
```

**Acceptance:** 신규/재표적 테스트 green, `genSummary` 여전히 존재(컴파일 유지), 이빨 실증 로그, 세 게이트 exit 0.

---

### Task 2: 예시 안정화 배선 — GenSampleLine 시그니처·틱 lift·draft 미리보기·↻ (US1·US2)

**Files:**
- Modify: `ui/src/components/scenario/GenVarEditor.tsx`, `ui/src/components/scenario/VariablesPanel.tsx`, `ui/src/components/scenario/useIntPairDraft.ts`(export 1건), `ui/src/i18n/ko.ts`(2키)
- Test: `ui/src/components/scenario/__tests__/GenVarEditor.test.tsx`, `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `samplePreview`/`lengthDraftValue`/`stepDraftValue`, `useIntPairDraft`의 `parseValidInt`(이 task에서 `export function parseValidInt` — 구현 무변경).
- Produces:
```ts
export function GenSampleLine({ spec, name, tick }: { spec: GenSpec; name: string; tick: number }); // block truncate + title(전문)
// GenVarEditor 신규 필수 props: sampleTick: number; onSampleRefresh: () => void;
```

- [ ] **Step 1: 실패 테스트 작성** — `GenVarEditor.test.tsx`:
  - `setup` 헬퍼에 `sampleTick={0}` `onSampleRefresh={vi.fn()}` 추가(모든 기존 렌더 공통) — 기존 케이스는 이 갱신만으로 계속 green이어야 함(동작-보존).
  - 직접 `<GenVarEditor>` render/rerender 케이스(현 `:385`/`:395`, date rerender — **GenSampleLine 직접 렌더는 이 파일에 없음**, GenSampleLine은 GenVarEditor/VariablesPanel 경유 2곳뿐)에 필수 신규 props `sampleTick={0} onSampleRefresh={vi.fn()}` 추가. 그 케이스 제목의 stale "(US4)" 라벨은 이번 spec의 US4(min>max)와 혼동되지 않게 제거/개명.
  - 두 테스트 파일 모두 `import { samplePreview } from "../../../scenario/genVars";` 추가(`__tests__/` 기준 3단계 — production 파일의 2단계 경로 복사 금지, import-depth 함정).
  - 신규 케이스(결정적이라 **기대 텍스트를 `samplePreview`로 직접 계산해 exact 단언**):

```tsx
it("US1: 길이 draft 변경(blur 없이) 즉시 예시가 새 길이를 반영한다", () => {
  const spec: GenSpec = { gen: "random_string", length: 8 };
  setup(spec);
  const len = screen.getByRole("spinbutton", { name: ko.editor.genFieldLength("checkin") });
  fireEvent.change(len, { target: { value: "12" } });
  const expected = samplePreview({ gen: "random_string", length: 12 }, "checkin", 0);
  if (expected.kind !== "ok") throw new Error("expected ok");
  expect(screen.getByTitle(`${ko.editor.genSamplePrefix} ${expected.text}`)).toBeInTheDocument();
  expect(onCommitGen).not.toHaveBeenCalled(); // 커밋 경계는 여전히 blur(동작-보존)
});

it("US1: 무효 길이 draft(0)는 예시를 커밋값 기준으로 유지한다", () => {
  const spec: GenSpec = { gen: "random_string", length: 8 };
  setup(spec);
  fireEvent.change(screen.getByRole("spinbutton", { name: ko.editor.genFieldLength("checkin") }), {
    target: { value: "0" },
  });
  const expected = samplePreview(spec, "checkin", 0);
  if (expected.kind !== "ok") throw new Error("expected ok");
  expect(screen.getByTitle(`${ko.editor.genSamplePrefix} ${expected.text}`)).toBeInTheDocument();
});

it("US1: min/max draft 변경 즉시 예시가 새 구간을 반영한다", () => {
  const spec: GenSpec = { gen: "random_int", min: 1, max: 100 };
  setup(spec);
  fireEvent.change(screen.getByRole("spinbutton", { name: ko.editor.genFieldMin("checkin") }), {
    target: { value: "500" },
  });
  fireEvent.change(screen.getByRole("spinbutton", { name: ko.editor.genFieldMax("checkin") }), {
    target: { value: "600" },
  });
  const expected = samplePreview({ gen: "random_int", min: 500, max: 600 }, "checkin", 0);
  if (expected.kind !== "ok") throw new Error("expected ok");
  expect(screen.getByTitle(`${ko.editor.genSamplePrefix} ${expected.text}`)).toBeInTheDocument();
});

it("↻ 버튼: onSampleRefresh 호출 + aria/title 계약 + yamlError(disabled)에도 활성", () => {
  const spec: GenSpec = { gen: "random_string", length: 8 };
  const onSampleRefresh = vi.fn();
  render(
    <GenVarEditor name="checkin" value={spec} disabled={true} sampleTick={0}
      onSampleRefresh={onSampleRefresh} onCommitGen={vi.fn()} onCommitStatic={vi.fn()} />,
  );
  const btn = screen.getByRole("button", { name: ko.editor.genSampleRefreshAria("checkin") });
  expect(btn).toHaveAttribute("title", ko.editor.genSampleRefreshTitle);
  expect(btn).toBeEnabled(); // 미리보기-전용 로컬 조작 — 읽기 전용 크롬
  fireEvent.click(btn);
  expect(onSampleRefresh).toHaveBeenCalledTimes(1);
});
```

  - `VariablesPanel.test.tsx` 신규(US2 — store 시딩은 파일 내 기존 gen/declared 케이스의 이디엄 재사용):

```tsx
// 시딩 이디엄(파일 내 T6 describe의 GEN_SCENARIO와 동형 — loadFromString 후 render):
const RS_SCENARIO = `version: 1
name: t
cookie_jar: auto
variables:
  sid:
    gen: random_string
    length: 8
steps:
  - id: 01HX0000000000000000000001
    name: s
    type: http
    request:
      method: GET
      url: "/x?s={{sid}}"
      headers: {}
`;

it("US2: 검색 타이핑 등 무관 재렌더에 접힘 예시가 바뀌지 않는다(결정적 텍스트)", async () => {
  useScenarioEditor.getState().loadFromString(RS_SCENARIO);
  render(<VariablesPanel />);
  const expected = samplePreview({ gen: "random_string", length: 8 }, "sid", 0);
  if (expected.kind !== "ok") throw new Error("expected ok");
  const line = `${ko.editor.genSamplePrefix} ${expected.text}`;
  expect(screen.getByTitle(line)).toBeInTheDocument();
  await userEvent.setup().type(screen.getByPlaceholderText(ko.editor.varSearchPlaceholder), "si");
  expect(screen.getByTitle(line)).toBeInTheDocument(); // 동일 텍스트 그대로
});

it("US2: 펼침→↻→접힘 후에도 갱신된 예시가 유지된다(틱 lift)", async () => {
  useScenarioEditor.getState().loadFromString(RS_SCENARIO);
  render(<VariablesPanel />);
  const user = userEvent.setup();
  // sid 행 펼침 → ↻ 클릭 → 접힘
  await user.click(screen.getByRole("button", { name: ko.editor.varExpandAria("sid") }));
  await user.click(screen.getByRole("button", { name: ko.editor.genSampleRefreshAria("sid") }));
  await user.click(screen.getByRole("button", { name: ko.editor.varExpandAria("sid") }));
  const expected = samplePreview({ gen: "random_string", length: 8 }, "sid", 1);
  if (expected.kind !== "ok") throw new Error("expected ok");
  expect(screen.getByTitle(`${ko.editor.genSamplePrefix} ${expected.text}`)).toBeInTheDocument();
});
```

- [ ] **Step 2: RED 확인** — `pnpm test GenVarEditor; echo t1=$?` / `pnpm test VariablesPanel; echo t2=$?` → 둘 다 FAIL(신규 props/키 미존재).

- [ ] **Step 3: 구현**
  - `useIntPairDraft.ts`: `function parseValidInt` → `export function parseValidInt`(본문 무변경).
  - `ko.ts`: `genSampleRefreshAria`/`genSampleRefreshTitle` 추가(Global Constraints 표 verbatim).
  - `GenVarEditor.tsx`의 `GenSampleLine`:

```tsx
export function GenSampleLine({ spec, name, tick }: { spec: GenSpec; name: string; tick: number }) {
  const sample = samplePreview(spec, name, tick);
  const display =
    sample.kind === "ok" ? `${ko.editor.genSamplePrefix} ${sample.text}` : ko.editor.genSampleUnsupported;
  return (
    <span className="block min-w-0 truncate text-slate-400" title={display}>
      {display}
    </span>
  );
}
```

  - `GenVarEditor` props에 `sampleTick: number; onSampleRefresh: () => void` 추가. `previewSpec` 도출(컴포넌트 본문, 렌더 직전):

```tsx
const previewSpec: GenSpec | null = strSpec
  ? (() => {
      const n = lengthDraftValue(lengthDraft);
      return n === null ? strSpec : { ...strSpec, length: n };
    })()
  : intSpec
    ? {
        ...intSpec,
        ...(() => {
          const minN = parseValidInt(minProps.value);
          const maxN = parseValidInt(maxProps.value);
          return minN !== null && maxN !== null && minN <= maxN ? { min: minN, max: maxN } : {};
        })(),
        ...(() => {
          const st = stepDraftValue(stepDraft);
          return st !== null ? { step: st } : {};
        })(),
      }
    : spec; // date/uuid — draft 겹침 없음
```

  - 예시 줄(기존 `:348-352` 교체):

```tsx
{previewSpec && (
  <div className="flex items-center gap-1 text-xs">
    <GenSampleLine spec={previewSpec} name={name} tick={sampleTick} />
    <button
      type="button"
      aria-label={ko.editor.genSampleRefreshAria(name)}
      title={ko.editor.genSampleRefreshTitle}
      onClick={onSampleRefresh}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-accent-600"
    >
      <span aria-hidden="true">↻</span>
    </button>
  </div>
)}
```

    (↻는 `disabled` prop을 **받지 않는다** — 미리보기-전용, yamlError 중 활성. 히트영역 24px = varpanel-toggle-size 선례.)
  - `VariablesPanel.tsx`: `const [sampleTicks, setSampleTicks] = useState<Record<string, number>>({});` 추가. 접힘 분기 `<GenSampleLine spec={row.value} name={row.name} tick={sampleTicks[row.name] ?? 0} />`, `GenVarEditor`에 `sampleTick={sampleTicks[row.name] ?? 0}` `onSampleRefresh={() => setSampleTicks((prev) => ({ ...prev, [row.name]: (prev[row.name] ?? 0) + 1 }))}` 전달.

- [ ] **Step 4: GREEN 확인 + US2 이빨 실증** — `pnpm test GenVarEditor; echo t1=$?` / `pnpm test VariablesPanel; echo t2=$?` / `pnpm test ScenarioNewPage.genvars; echo t3=$?` → 모두 exit 0. 이빨: `samplePreview` 본문을 일시 무시드 `sampleFor(spec)`로 꺾어 **US2 검색 불변 테스트가 RED**임을 확인 후 원복 GREEN(T1의 단위 이빨과 별개 — US2 가드 자체의 비공허 증명, 로그 보고 포함).

- [ ] **Step 5: 게이트+커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-preview-ux/ui
pnpm lint; echo lint=$?
pnpm build; echo build=$?
cd .. && git add ui/src/components/scenario/GenVarEditor.tsx ui/src/components/scenario/VariablesPanel.tsx ui/src/components/scenario/useIntPairDraft.ts ui/src/i18n/ko.ts ui/src/components/scenario/__tests__/GenVarEditor.test.tsx ui/src/components/scenario/__tests__/VariablesPanel.test.tsx
git commit -m "feat(ui): gen 예시 시드 안정화 + draft 즉시 미리보기 + ↻ 다시 뽑기 (genvar-preview-ux T2)"
```

**Acceptance:** US1·US2 케이스 green(기대 텍스트 exact), 기존 min/max 짝-hold·revert 특성화 green(동작-보존 증명), 게이트 exit 0.

---

### Task 3: 입력 구속 + 인라인 안내 (US3·US4)

**Files:**
- Modify: `ui/src/components/scenario/GenVarEditor.tsx`, `ui/src/i18n/ko.ts`(4키)
- Test: `ui/src/components/scenario/__tests__/GenVarEditor.test.tsx`

**Interfaces:**
- Consumes: Task 1 `lengthDraftValue`/`stepDraftValue`, Task 2 `parseValidInt` export.
- Produces: DOM 계약만 — 길이 input `min=1 max=64 step=1`, 단위 input `min=1 step=1`, 무효 시 `aria-invalid` + `ko.editor.gen*Invalid`/`genMinMaxConflict` 전문.

- [ ] **Step 1: 실패 테스트 작성** — `GenVarEditor.test.tsx`:

```tsx
it("US3: 길이 input은 native 구속 속성(min/max/step)을 갖는다", () => {
  setup({ gen: "random_string", length: 8 });
  const len = screen.getByRole("spinbutton", { name: ko.editor.genFieldLength("checkin") });
  expect(len).toHaveAttribute("min", "1");
  expect(len).toHaveAttribute("max", "64");
  expect(len).toHaveAttribute("step", "1");
});

it("US3: 범위 밖 길이 draft는 그 자리에서 안내 + aria-invalid", () => {
  setup({ gen: "random_string", length: 8 });
  const len = screen.getByRole("spinbutton", { name: ko.editor.genFieldLength("checkin") });
  for (const bad of ["0", "-1", "65", "3.5"]) {
    fireEvent.change(len, { target: { value: bad } });
    expect(screen.getByText(ko.editor.genLengthInvalid)).toBeInTheDocument(); // 전문 exact
    expect(len).toHaveAttribute("aria-invalid", "true");
  }
  fireEvent.change(len, { target: { value: "12" } });
  expect(screen.queryByText(ko.editor.genLengthInvalid)).not.toBeInTheDocument();
  expect(len).not.toHaveAttribute("aria-invalid");
});

it("US3 특성화: 무효 길이는 blur 시 기존대로 revert되고 안내도 사라진다(정책 불변)", () => {
  setup({ gen: "random_string", length: 8 });
  const len = screen.getByRole("spinbutton", { name: ko.editor.genFieldLength("checkin") });
  fireEvent.change(len, { target: { value: "65" } });
  fireEvent.blur(len);
  expect(onCommitGen).not.toHaveBeenCalled();
  expect((len as HTMLInputElement).value).toBe("8"); // revert(기존 동작)
  expect(screen.queryByText(ko.editor.genLengthInvalid)).not.toBeInTheDocument();
});

it("단위(step) 무효 draft 안내 + min=1 속성", () => {
  setup({ gen: "random_int", min: 1, max: 100, step: 5 });
  const st = screen.getByRole("spinbutton", { name: ko.editor.genFieldStep("checkin") });
  expect(st).toHaveAttribute("min", "1");
  for (const bad of ["0", "-1", "1.5"]) {
    fireEvent.change(st, { target: { value: bad } });
    expect(screen.getByText(ko.editor.genStepInvalid)).toBeInTheDocument();
    expect(st).toHaveAttribute("aria-invalid", "true");
  }
});

it("최소/최대 비정수 draft는 per-field 안내", () => {
  setup({ gen: "random_int", min: 1, max: 100 });
  fireEvent.change(screen.getByRole("spinbutton", { name: ko.editor.genFieldMin("checkin") }), {
    target: { value: "abc" },
  });
  expect(screen.getByText(ko.editor.genIntInvalid)).toBeInTheDocument();
});

it("US4: min>max면 적용되지 않음 안내 + 양측 aria-invalid + describedby, blur해도 no-op(정책 불변)", () => {
  setup({ gen: "random_int", min: 1, max: 100 });
  const min = screen.getByRole("spinbutton", { name: ko.editor.genFieldMin("checkin") });
  const max = screen.getByRole("spinbutton", { name: ko.editor.genFieldMax("checkin") });
  fireEvent.change(min, { target: { value: "500" } });
  fireEvent.change(max, { target: { value: "200" } });
  const msg = screen.getByText(ko.editor.genMinMaxConflict); // 전문 exact
  expect(min).toHaveAttribute("aria-invalid", "true");
  expect(max).toHaveAttribute("aria-invalid", "true");
  expect(min.getAttribute("aria-describedby")).toBe(msg.id);
  fireEvent.blur(max); // relatedTarget=null → 짝-hold 미발동 → commit 경로 → min>max no-op
  expect(onCommitGen).not.toHaveBeenCalled();
  expect((min as HTMLInputElement).value).toBe("500"); // draft 보존(기존 동작)
  expect(screen.getByText(ko.editor.genMinMaxConflict)).toBeInTheDocument(); // 안내는 남는다
});
```

- [ ] **Step 2: RED 확인** — `pnpm test GenVarEditor; echo test=$?` → FAIL.

- [ ] **Step 3: 구현** — `ko.ts` 4키(표 verbatim) + `GenVarEditor.tsx`:
  - 파생 플래그(컴포넌트 본문):

```tsx
const lengthInvalid = strSpec !== null && lengthDraft.trim() !== "" && lengthDraftValue(lengthDraft) === null;
const stepInvalid = intSpec !== null && stepDraft.trim() !== "" && stepDraftValue(stepDraft) === null;
const minNotInt = intSpec !== null && minProps.value.trim() !== "" && parseValidInt(minProps.value) === null;
const maxNotInt = intSpec !== null && maxProps.value.trim() !== "" && parseValidInt(maxProps.value) === null;
const pairMin = parseValidInt(minProps.value);
const pairMax = parseValidInt(maxProps.value);
const minMaxConflict = intSpec !== null && pairMin !== null && pairMax !== null && pairMin > pairMax;
const minMaxConflictId = `genvar-minmax-conflict-${name}`;
```

  - 길이 Input에 `min={1} max={64} step={1} aria-invalid={lengthInvalid || undefined}` + `GenField` 안 Input 아래 `{lengthInvalid && <p className="mt-0.5 text-xs text-red-600">{ko.editor.genLengthInvalid}</p>}`.
  - 단위 Input에 `min={1} step={1} aria-invalid={stepInvalid || undefined}` + 동일 패턴 `genStepInvalid`.
  - 최소/최대 Input에 `aria-invalid={(minNotInt || minMaxConflict) || undefined}`(최대는 maxNotInt) + `aria-describedby={minMaxConflict ? minMaxConflictId : undefined}` + per-field `{minNotInt && <p …>{ko.editor.genIntInvalid}</p>}`(최대 동일).
  - intSpec 필드 컨테이너 **아래**(형제)에 `{minMaxConflict && <p id={minMaxConflictId} className="mt-0.5 text-xs text-red-600">{ko.editor.genMinMaxConflict}</p>}`.
  - commit 함수·`useIntPairDraft` 로직은 **무변경**(안내는 파생 표시만).

- [ ] **Step 4: GREEN + 이빨 실증** — `pnpm test GenVarEditor; echo test=$?` → 0. 이빨: `minMaxConflict` 게이트를 일시 `false &&`로 꺾어 US4 케이스 RED 확인 후 원복 GREEN(로그 보고 포함).

- [ ] **Step 5: 게이트+커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-preview-ux/ui
pnpm lint; echo lint=$?
pnpm build; echo build=$?
cd .. && git add ui/src/components/scenario/GenVarEditor.tsx ui/src/i18n/ko.ts ui/src/components/scenario/__tests__/GenVarEditor.test.tsx
git commit -m "feat(ui): gen 숫자 입력 native 구속 + 무효 draft 인라인 안내 (genvar-preview-ux T3)"
```

**Acceptance:** US3·US4 케이스 green(전문 exact 단언), blur 정책 특성화 green, 이빨 로그, 게이트 exit 0.

---

### Task 4: 레이아웃 — 배지 이동·요약/예시 2행·random_int 그리드·genSummary 제거 (US5)

**Files:**
- Modify: `ui/src/components/scenario/VariablesPanel.tsx`, `ui/src/components/scenario/GenVarEditor.tsx`, `ui/src/scenario/genVars.ts`(genSummary 제거)
- Test: `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx`, `ui/src/components/scenario/__tests__/GenVarEditor.test.tsx`, `ui/src/pages/__tests__/ScenarioNewPage.genvars.test.tsx`(stale 주석만)

**Interfaces:**
- Consumes: Task 1 `genParamsSummary`, Task 2 `GenSampleLine{spec,name,tick}`.
- Produces: DOM 구조 계약 — 헤더 행(li 첫 자식 div)에 `.bg-indigo-50` 배지 부재, 접힘 요약 줄 = 배지+파라미터(truncate+title), random_int 필드 컨테이너 = auto-fit 그리드.

- [ ] **Step 1: 실패 테스트 작성**
  - `VariablesPanel.test.tsx`(gen 변수 시딩은 기존 이디엄):

```tsx
it("US5: 타입 배지는 헤더 행이 아니라 요약 줄에 있다(배지로 인한 헤더 꺾임 원인 제거)", () => {
  // random_string 변수 sid 시딩 후:
  const li = screen.getByRole("button", { name: ko.editor.varExpandAria("sid") }).closest("li")!;
  const headerRow = li.firstElementChild!; // 밀집 행(토글+이름+연필+ml-auto 묶음)
  expect(headerRow.querySelector(".bg-indigo-50")).toBeNull();
  const badge = li.querySelector(".bg-indigo-50")!; // 요약 줄의 배지
  expect(badge).not.toBeNull();
  expect(badge.textContent).toBe(ko.editor.genTypeRandomString);
  expect(headerRow.contains(badge)).toBe(false);
});

it("US5: 요약 줄은 파라미터만(타입명 중복 없음) + title 전문, uuid는 배지 단독", () => {
  // sid(random_string length 12), oid(uuid) 시딩:
  expect(screen.getByText("12자")).toBeInTheDocument();
  expect(screen.getByText("12자").closest("[title]")!.getAttribute("title")).toBe("랜덤 문자열 · 12자");
  const uuidLi = screen.getByRole("button", { name: ko.editor.varExpandAria("oid") }).closest("li")!;
  expect(uuidLi.querySelector(".bg-indigo-50")!.closest("[title]")!.getAttribute("title")).toBe("UUID");
});
```

  - `GenVarEditor.test.tsx`(그리드 계약 — 토큰 단언):

```tsx
it("random_int 필드 컨테이너는 폭-적응 그리드, random_string 길이는 w-16 유지", () => {
  setup({ gen: "random_int", min: 1, max: 100 });
  const grid = screen
    .getByRole("spinbutton", { name: ko.editor.genFieldMin("checkin") })
    .closest("div.grid")!; // 그리드 전환 전(RED)엔 null → `!` deref throw = RED
  const tokens = grid.className.split(/\s+/);
  expect(tokens).toContain("grid");
  expect(tokens).toContain("grid-cols-[repeat(auto-fit,minmax(4.5rem,1fr))]");
});
```

- [ ] **Step 2: RED 확인** — `pnpm test VariablesPanel; echo t1=$?` / `pnpm test GenVarEditor; echo t2=$?` → FAIL.

- [ ] **Step 3: 구현**
  - `VariablesPanel.tsx`:
    - 헤더 행에서 타입 배지 블록(`{isGenSpec(row.value) && (<span … bg-indigo-50 …>…)}`, 현 `:309-316`) **삭제**(`덮어씀`/`×`의 `ml-auto` 묶음은 불변).
    - 접힘 gen 분기(현 `:345-349`)를 교체(파일 상단에 비-export 로컬 헬퍼 `genRowTitle` 추가 — react-refresh 무해):

```tsx
function genRowTitle(spec: GenSpec): string {
  const params = genParamsSummary(spec);
  return params === "" ? genTypeLabel(spec) : `${genTypeLabel(spec)} · ${params}`;
}
```

```tsx
) : isGenSpec(row.value) ? (
  <div className="flex min-w-0 flex-col gap-0.5 text-xs text-slate-500">
    <div className="flex min-w-0 items-center gap-x-1.5" title={genRowTitle(row.value)}>
      <span className="shrink-0 rounded bg-indigo-50 px-1.5 text-xs text-indigo-600">
        {genTypeLabel(row.value)}
      </span>
      {genParamsSummary(row.value) !== "" && (
        <span className="min-w-0 truncate">{genParamsSummary(row.value)}</span>
      )}
    </div>
    <GenSampleLine spec={row.value} name={row.name} tick={sampleTicks[row.name] ?? 0} />
  </div>
) : (
```

    - import에서 `genSummary` 제거, `genParamsSummary` 추가(`genTypeLabel`·`GenSpec` 유지).
  - `GenVarEditor.tsx` intSpec 컨테이너(현 `:291`): `className="flex flex-wrap items-end gap-x-2 gap-y-1"` → `className="grid grid-cols-[repeat(auto-fit,minmax(4.5rem,1fr))] items-end gap-x-2 gap-y-1"`, 안의 최소/최대(`className="w-20"`)·단위(`className="w-16"`) 고정폭 제거(셀이 폭 결정). **random_string 길이 필드(w-16)는 불변**.
  - `genVars.ts`: `genSummary` 함수 삭제.
  - `ScenarioNewPage.genvars.test.tsx` 현 `:126-128` 주석("배지는 header row(li의 첫 자식 div)에만 있다 … genSummary …")을 "배지는 접힘 요약 줄에 있다(li-스코프 querySelector라 위치 이동에도 유효)"로 갱신 — **코드/단언 무변경**(li-스코프라 이동 후에도 green이어야 함; red면 구현 오류).
  - `VariablesPanel.test.tsx` 기존 T6 describe(`:1120~`, "생성기 요약 행 + 그 자리 펼침 편집기")의 단언이 red면 새 구조(배지=요약 줄·요약=파라미터만) 기준으로 의미 보존 갱신 — date 요약 문자열("오늘+7일 · Asia/Seoul")과 샘플 텍스트는 불변이라 대부분 green 예상.

- [ ] **Step 4: GREEN + 스윕** —

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-preview-ux/ui
pnpm test VariablesPanel; echo t1=$?
pnpm test GenVarEditor; echo t2=$?
pnpm test ScenarioNewPage.genvars; echo t3=$?
pnpm test genVars; echo t4=$?
grep -rn "genSummary" src; echo grep=$?   # 기대 exit=1 (0매치 — 제거 완결)
```

- [ ] **Step 5: 게이트+커밋**

```bash
pnpm lint; echo lint=$?
pnpm build; echo build=$?
cd .. && git add ui/src/components/scenario/VariablesPanel.tsx ui/src/components/scenario/GenVarEditor.tsx ui/src/scenario/genVars.ts ui/src/components/scenario/__tests__/VariablesPanel.test.tsx ui/src/components/scenario/__tests__/GenVarEditor.test.tsx ui/src/pages/__tests__/ScenarioNewPage.genvars.test.tsx
git commit -m "feat(ui): gen 행 레이아웃 정돈 — 배지 요약줄 이동·2행 표시·int 그리드 (genvar-preview-ux T4)"
```

**Acceptance:** US5 구조 계약 green, `grep genSummary` 0매치, `ScenarioNewPage.genvars` 무수정-green, 게이트 exit 0.

---

### Task 5: 전수 게이트·스윕·충돌 검사 재실행 (검증-only, production 0-diff)

**Files:** 없음(검증만) — 발견 시 수정은 해당 파일 최소 diff + 이 task 커밋에 포함.

- [ ] **Step 1: full 게이트** —

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-preview-ux/ui
pnpm lint; echo lint=$?
pnpm test; echo test=$?      # 무인자 전체 — targeted-green ≠ full-green
pnpm build; echo build=$?
```

- [ ] **Step 2: 한글 하드코딩 스윕(diff 스코프)** —

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-preview-ux
git diff $(git merge-base master HEAD)..HEAD -- 'ui/src/components/**' 'ui/src/scenario/**' | grep -n '^+.*"[^"]*[가-힣]' ; echo sweep=$?
```

  기대: 테스트 파일의 기대값 리터럴·주석 외 production 추가분 0(`"12자"` 등 테스트 기대값은 허용, production은 `ko.ts` 경유 확인).

- [ ] **Step 3: ko 충돌 검사 재실행** — Global Constraints의 7키 **실값**으로 오케스트레이터 스크립트(python, 신규↔신규·신규↔기존 양방향 full-value 포함관계) 재실행 → 신규↔신규 0·신규↔기존은 단어-라벨 방향만임을 재확인, 결과를 task 보고에 붙인다.

- [ ] **Step 4: 스코프 확인+커밋(수정 발생 시에만)** —

```bash
git diff $(git merge-base master HEAD)..HEAD --stat   # ui/ + docs/ 외 0-diff 확인(엔진/컨트롤러/proto 무접촉)
```

**Acceptance:** full 3게이트 exit 0, 스윕/충돌/스코프 결과 보고.

---

## 라이브 검증 (파이프라인 5단계 — plan task 아님, 최종 리뷰 후 `/live-verify`)

에디터는 클라이언트-only(`/scenarios/new`는 백엔드 불요)지만 `/scenarios/{id}` 경로 검증에 controller 필요. US 척추(진입 화면 **2곳 모두**: `/scenarios/new`·`/scenarios/{id}` — live-verify-all-mount-paths):

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | random_string 변수 펼침 → 길이 스피너 ▲ 클릭 | 클릭 즉시 예시 텍스트가 새 길이(문자 수)로 변경(blur 불요) |
| US2 | 검색창에 타이핑·다른 행 펼침/접힘 | 접힘 예시 텍스트 불변(before/after 문자열 비교) |
| US3 | 길이 스피너 ▼ 연타 → `input.value` 확인; "0" 타이핑 | value가 1 밑으로 안 내려감; 0 입력 시 `genLengthInvalid` 전문 표시 |
| US4 | 최소 500·최대 200 입력 | `genMinMaxConflict` 전문 표시 + 두 입력 red 테두리(aria-invalid) |
| US5 | gen 변수 행 rect 실측 | 헤더 행에서 이름 `getBoundingClientRect().top` == × top(한 줄); 요약/예시 각 줄 truncate(스크롤 폭>클라이언트 폭 시 title 존재) |
| ↻ | 펼침 → ↻ 클릭 → 접기 | 예시가 바뀌고, 접힘 행에도 같은 텍스트 유지 |

주의: vite dev는 `localhost`로 navigate(IPv6 바인드), Monaco DOM read 불신 — 검증은 패널 DOM/폼 필드 기준.

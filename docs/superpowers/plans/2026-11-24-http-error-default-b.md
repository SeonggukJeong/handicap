# 4xx·5xx를 기본 오류로 ②b — 에디터·안내 (http-error-default-b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 에디터가 검사 방식 셋(「400 이상은 오류」·「적은 코드만 통과」·「보지 않음」)을 고르고 보이게 한다. 새 스텝은 검사 없이 시작한다. 미리 실행·모니터가 기본 규칙 오류의 이유를 말하고, 신뢰도 점검 A는 새 규칙으로 판정한다. 비교 알림과 인쇄 비교도 규칙 차이·검사 방식 차이를 사실대로 말한다.

**Architecture:**
- 화면 전용 슬라이스다. 엔진·컨트롤러·와이어는 바뀌지 않는다(②a가 끝냈다).
- 스텝 검사 모델(`Assertion[]`)을 읽는 판정을 순수 함수 모듈 `ui/src/scenario/statusMode.ts` 하나에 모은다. 에디터 구획·스텝 목록 칩·신뢰도 점검이 같이 쓴다.
- 기본 규칙 오류의 이유 글은 오류 글 모양(`status N (>= 400)`, ②a 계약)으로 판별한다. 도우미 하나와 작은 컴포넌트 하나를 세 화면이 쓴다.
- 인쇄 비교는 `fairness.ts` 안에서 run 규칙 번호를 보고 갈래를 나눈다. 두 run이 모두 규칙 1이면 지금 경로를 그대로 탄다.

**Tech Stack:** TypeScript/React · Zod · `yaml` Document API · Zustand · vitest+RTL · Tailwind.

**검토:** spec-plan-reviewer 1차 APPROVE-WITH-FIXES(12건 반영, 사용자 결정 「여러 줄은 읽기만·합치기 하나」 포함) → 2차 clean APPROVE (2026-11-24). 2차의 선택 지적 6건은 글 손질로 반영했다.

REVIEW-GATE: APPROVED

**Spec:** `docs/superpowers/specs/2026-11-24-http-error-default-design.md` — 이 plan은 §4.7(R18·R20–R22·R27·R28), R26 보강(인쇄 비교 「다른 조건」·조건 차이 표 행), §6의 ②b 글(비교 알림 「선택한 run」 글 포함)을 구현한다. ②a plan은 `docs/superpowers/plans/2026-11-24-http-error-default-a.md`.

## Global Constraints

- **production diff는 `ui/` 안에만 둔다.** `crates/`·proto·마이그레이션·`ui/src/api/schemas.ts`는 건드리지 않는다. 리포트 `status_rule`의 Zod `.optional()`은 그대로 둔다(사용자 결정 2026-11-24).
- 검사 방식 판정의 단일 소스는 `ui/src/scenario/statusMode.ts`다. 컴포넌트에서 `assert.length`·`kind === "status"`를 직접 세서 방식을 정하지 않는다.
- 「보지 않음뿐」 판정(`statusUnchecked`)은 엔진 `status_unchecked`와 같다: 검사 줄이 1개 이상이고 모두 `status_any`일 때만 참. `[]`는 거짓, `[any, 200]`도 거짓.
- 코드 목록 상한은 `model.ts`의 `MAX_STATUS_CODES`(64)를 import해서 쓴다. 숫자 64를 새로 적지 않는다.
- 화면 글은 spec §6 표와 이 plan의 「카피 정본」 절을 글자 그대로 쓴다. 숫자 뒤 조사는 `ui/src/i18n/josa.ts`의 `josa()`로 한다(404 → 「를」, 503 → 「을」). 「합류」 대신 「머지」, 번역투 명사구 금지(working-rules §8).
- 손대지 않은 스텝의 YAML은 다시 쓰지 않는다. 화면이 YAML을 쓰는 길은 `setStepAssert`(②a) 하나뿐이다.
- 깨진 YAML(`yamlError !== null`)에서는 새 편집 어포던스(방식 단추·코드 추가·빼기·합치기)를 모두 잠근다(`ui/src/components/scenario/CLAUDE.md` 편집 게이트).
- 두 run이 모두 규칙 1인 인쇄 비교의 글과 표는 이 변경 전과 같다(R13).
- 템플릿 갤러리(`templates.ts`)·스텝 템플릿·HAR 가져오기·`print/scenarioFacts.ts`·`print/stepTable.ts`는 바꾸지 않는다.
- 코드 주석으로 결함을 변호하지 않는다(working-rules §7). tdd-guard 때문에 task마다 **테스트 파일 편집이 먼저**다.
- 커밋은 task마다 하나, `cd ui && pnpm lint && pnpm test && pnpm build` 통과 뒤에 한다. `--no-verify`·파이프 커밋은 금지다.

## Review Focus

1. **좁은 Inspector에서 세 방식 단추가 넘치는 경우.** Inspector 카드 안쪽 폭은 약 268px인데, 세 글을 12px 한 줄로 쓰면 약 312px가 필요하다(목업은 360px 판). 기대 동작: 가로 스크롤 없이 단추 안에서 낱말 단위로 줄을 바꾼다. → Task 2의 `size="sm"` 클래스 계약(`[word-break:keep-all]`, `whitespace-nowrap` 없음) 테스트. 라이브에서 `scrollWidth <= clientWidth`를 잰다(마무리 4).
2. **손으로 쓴 검사 표기를 열 때**(`[200, 200]`·`[200]`·`any` 한 줄·`any` 두 줄·코드 줄 + `any` 줄). 기대 동작: 방식 판정이 맞고, 겹친 코드는 칩 하나로 보이며, 화면이 손대기 전에는 YAML이 그대로다. → Task 1 `statusMode` 표 · Task 2 「손대지 않은 스텝 YAML 불변」 테스트.
3. **추가 칸의 경계 입력**: 99·600·1.5·빈칸·이미 있는 코드·Enter 키·코드가 이미 64개. 기대 동작: 범위 밖·소수·빈칸·64개 상태에서는 「추가」가 눌리지 않고, 이미 있는 코드는 목록이 그대로이며, Enter는 「추가」와 같다. 65번째 코드를 쓰면 Zod가 거절해 `yamlError`가 생긴다. 그래서 상한은 단추에서 막아야 한다. → Task 2 테스트.
4. **깨진 YAML 상태의 「응답 검증」 구획.** 기대 동작: 단추·추가·빼기·합치기가 비활성이고, 눌러도 아무 일이 없다. → Task 2 테스트(`setPendingYamlText` + `commitPendingYaml`로 만든 상태).
5. **규칙이 섞인 인쇄 비교에서 앞뒤 순서가 바뀐 경우**(앞 run이 규칙 2, 뒤 run이 규칙 1). 기대 동작: 방식 이름이 각 run의 규칙으로 정해지고(규칙 1의 검사 없음 = 「검사 없음」), 「검사 없음」 ↔ 「400 이상은 오류」 쌍은 줄을 내지 않는다. 「다른 조건」·조건 차이 표 행도 양방향으로 나온다. → Task 5 테스트.

---

### Task 1: 검사 방식 도우미 + 신뢰도 점검 A + 지문 (R22)

**Files:**
- Create: `ui/src/scenario/statusMode.ts`
- Modify: `ui/src/scenario/trust.ts:59-71` (A 판정), `:108-110` (`noValidationAtAll`)
- Modify: `ui/src/scenario/trustPrefs.ts:84-95` (`executionFingerprint`)
- Modify: `ui/src/i18n/ko.ts:2381-2383` (`checkAFailTitle`·`checkAFailWhy`·`checkAPass`)
- Test: `ui/src/scenario/__tests__/statusMode.test.ts`(새 파일), `ui/src/scenario/__tests__/trust.test.ts`, `ui/src/scenario/__tests__/trustPrefs.test.ts`, `ui/src/components/scenario/__tests__/TrustBoard.test.tsx`, `ui/src/components/scenario/__tests__/EditorShell.trust.test.tsx`, `ui/src/components/run/__tests__/RunDialog.trust.test.tsx`(A 판정이 바뀌어 기대가 바뀌는 것만)

**Interfaces:**
- Produces (`ui/src/scenario/statusMode.ts`):
  - `export const EDITOR_STATUS_RULE = 2 as const` — 에디터가 다루는 시나리오의 판정 규칙 번호(서버 `STATUS_RULE_CURRENT`와 같은 값).
  - `export type StatusMode = { kind: "default" } | { kind: "codes"; codes: number[] } | { kind: "any" } | { kind: "multi"; lines: Assertion[] }`
  - `export function statusMode(asserts: ReadonlyArray<Assertion>): StatusMode` — 줄 0 → `default`. 줄 1이 코드 줄 → `codes`(겹친 코드는 처음 나온 순서로 하나씩만 남긴다). 줄 1이 `status_any` → `any`. 줄 2 이상 → `multi`(원본 줄 그대로).
  - `export function statusUnchecked(asserts: ReadonlyArray<Assertion>): boolean` — Global Constraints의 정의.
  - `export function mergeStatusLines(asserts: ReadonlyArray<Assertion>): Assertion[]` — R18 합치기(사용자 결정 2026-11-24: 늘 모두 합친다). 코드 줄들의 코드를 처음 나온 순서로 합쳐 겹침을 뺀 한 줄. `any` 줄은 뺀다. 코드 줄이 없고 `any` 줄만 있으면 `[{ kind: "status_any" }]`. 빈 입력이면 `[]`.
  - `export function passingCodes(asserts: ReadonlyArray<Assertion>): number[] | "any"` — 지금 통과하는 코드. 코드 줄이 하나도 없으면 `"any"`. 있으면 모든 코드 줄에 함께 든 코드(첫 코드 줄의 순서, 겹침 없음)이고, 빈 배열이면 항상 실패다(여러 줄 알림 세 갈래의 원천, spec §6).

- [ ] **Step 1: 실패하는 테스트 — `statusMode.test.ts`**

```ts
const one = (...codes: number[]): Assertion => ({ kind: "status", codes });
const any: Assertion = { kind: "status_any" };
// statusMode
expect(statusMode([])).toEqual({ kind: "default" });
expect(statusMode([one(200)])).toEqual({ kind: "codes", codes: [200] });
expect(statusMode([one(200, 409)])).toEqual({ kind: "codes", codes: [200, 409] });
expect(statusMode([one(200, 200)])).toEqual({ kind: "codes", codes: [200] });
expect(statusMode([any])).toEqual({ kind: "any" });
expect(statusMode([any, any])).toEqual({ kind: "multi", lines: [any, any] });
expect(statusMode([one(200), one(201)])).toEqual({ kind: "multi", lines: [one(200), one(201)] });
// statusUnchecked (엔진 status_unchecked와 같은 표)
expect(statusUnchecked([])).toBe(false); expect(statusUnchecked([one(200)])).toBe(false);
expect(statusUnchecked([any])).toBe(true); expect(statusUnchecked([any, any])).toBe(true);
expect(statusUnchecked([any, one(200)])).toBe(false);
// mergeStatusLines
expect(mergeStatusLines([one(200), one(201)])).toEqual([one(200, 201)]);
expect(mergeStatusLines([one(200, 409), one(409, 500)])).toEqual([one(200, 409, 500)]);
expect(mergeStatusLines([any, one(200)])).toEqual([one(200)]);
expect(mergeStatusLines([any, any])).toEqual([any]);
expect(mergeStatusLines([])).toEqual([]);
// passingCodes
expect(passingCodes([one(200), one(201)])).toEqual([]);
expect(passingCodes([one(200), one(200)])).toEqual([200]);
expect(passingCodes([one(200, 409), one(200)])).toEqual([200]);
expect(passingCodes([one(409, 200), one(200, 409, 500)])).toEqual([409, 200]);
expect(passingCodes([any, any])).toBe("any");
expect(passingCodes([any, one(200)])).toEqual([200]);
```

- [ ] **Step 2: 실패하는 테스트 — 신뢰도·지문**
  - `trust.test.ts`:
    - 검사 없는 http 스텝뿐인 시나리오 → A `pass`, `noValidationAtAll === false`.
    - 코드 검사 스텝 + `any` 스텝(이름 「상태 확인」) → A `fail`, `steps === [{id, name: "상태 확인"}]`(`any` 스텝만).
    - 모든 http 스텝이 `any` → A `fail`, `noValidationAtAll === true`.
    - `[any, 200]` 두 줄 스텝 → A에 들지 않는다.
    - 준비 스텝(`setup`)의 `any` 스텝도 A에 든다(`allSteps` 경유 — 지금 동작).
  - 기존 진리표 테스트는 「검사 없음」을 「`any`뿐」으로 바꿔 같은 등급 결과를 지킨다. 「검사 없음 = A 실패」를 고정하던 행은 위 첫 줄의 새 기대로 고친다. 리포트에 `테스트 | 이전 기대 | 새 기대` 표로 적는다.
  - `trustPrefs.test.ts`: `executionFingerprint(sc)`가 `|rule:2|`를 담는다(`v1|rule:2|jar:` 순서). 같은 시나리오로 지금 지문(이 변경 전 문자열)과 다르다는 것도 고정한다. 그래서 「미리 실행 확인됨」이 한 번 풀린다(spec §5-7).
  - `TrustBoard.test.tsx`: A 실패 제목·이유가 카피 정본 글(리터럴 문자열 하나 병기 — `ko.*` 자기참조만으로는 공허, ui/CLAUDE.md), 통과 글이 「모든 스텝이 오류 응답을 실패로 잡습니다」.

- [ ] **Step 3: 실패 확인** — `cd ui && pnpm test statusMode trust TrustBoard` FAIL(모듈 없음·기대 다름).

- [ ] **Step 4: 구현**
  - `statusMode.ts`: Interfaces대로. 겹침 제거는 `Set` 한 번이다.
  - `trust.ts`: `missing`을 `https.filter((s) => statusUnchecked(s.assert))`로 바꾼다. `noValidationAtAll = https.length > 0 && https.every((s) => statusUnchecked(s.assert))`. 변수 이름 `missing`·`withAssertCount`는 뜻에 맞게 바꾼다(예: `unchecked`). 낡은 주석 셋을 새 뜻으로 고친다: `TrustCheck.steps`(`:17` — 「상태 코드를 보지 않는 http 스텝」), A 판정 위(`:59` — 「모든 http 스텝이 status assert를 가져야 통과」), 증폭 조건 위(`:107-109` — 「검증 전무」 → 「http 스텝이 모두 상태 코드를 보지 않음」).
  - `trustPrefs.ts`: `executionFingerprint` 배열 둘째 자리에 `` `rule:${EDITOR_STATUS_RULE}` ``를 넣는다. 그 줄 위 주석에 이유 한 줄을 적는다(판정 규칙이 바뀌면 같은 시나리오도 다시 돌려 봐야 같은 결과인지 안다).
  - `ko.ts`: 카피 정본의 신뢰도 세 줄. `checkANa`는 그대로 둔다.

- [ ] **Step 5: 되돌려 확인** — 셋을 한 번씩 바꿔 RED인지 본 뒤 원복하고 결과를 리포트에 적는다.
  - `statusUnchecked`를 `asserts.every(a => a.kind === "status_any")`로 바꾼다(빈 배열이 참이 된다) → `statusUnchecked([])`·「검사 없는 스텝뿐 → A pass」가 RED.
  - 지문의 `rule:` 줄을 지운다 → 지문 테스트 RED.
  - `trust.ts`를 옛 식(`!s.assert.some(x => x.kind === "status")`)으로 되돌린다 → 새 A 테스트 RED.

- [ ] **Step 6: 확인** — `cd ui && pnpm lint && pnpm test && pnpm build` 0.

- [ ] **Step 7: 커밋** — `feat(ui): 신뢰도 점검 A를 「상태 코드를 보지 않는 스텝」으로 + 검사 방식 도우미`

---

### Task 2: 「응답 검증」 구획 — 세 방식 단추·코드 칩·여러 줄 합치기 (R18)

시각 기준은 목업 둘이다(working-rules §4 — 「참고용」 아님). `docs/superpowers/specs/2026-11-24-http-error-default-mockups/screens.html` 1–3과 추가 목업 `screens-b.html` 1–2(좁은 칸 줄바꿈, 항상 실패하지는 않는 여러 줄 알림·「검증 확인 필요」 칩)다. 두 목업이 다르면 `screens-b.html`이 이긴다. 구현자는 목업 CSS를 Tailwind로 옮기고 첫 렌더 뒤 대조한다.

**Files:**
- Create: `ui/src/components/scenario/AssertEditor.tsx` (지금 `Inspector.tsx:624-686`의 임시 `AssertEditor`를 옮겨 다시 쓴다)
- Modify: `ui/src/components/scenario/Inspector.tsx:411-420` (구획 머리 덧글·새 컴포넌트), `:33` (`assertionLabel` import가 안 쓰이면 지운다)
- Modify: `ui/src/components/ui/Segmented.tsx` (`size?: "md" | "sm"`)
- Modify: `ui/src/components/ui/Section.tsx:25·53` (card 갈래에만 `hintAlways?: boolean`·`hintTone?: "muted" | "warn"`)
- Modify: `ui/src/scenario/statusMode.ts` (`assertHeadHint` 추가)
- Modify: `ui/src/i18n/ko.ts` (카피 정본 「에디터」 줄들 · 안 쓰이게 된 `noAssertions`·`removeAssertion` 삭제 — Inspector 테스트를 다시 쓴 **뒤에** `grep -rn "noAssertions\|removeAssertion" ui/src crates`가 0인지 확인하고 지운다. 지금은 `Inspector.test.tsx:1781-1782`가 둘 다 쓴다)
- Test: `ui/src/components/scenario/__tests__/AssertEditor.test.tsx`(새 파일), `ui/src/components/ui/__tests__/Segmented.test.tsx`·`Section.test.tsx`(있는 파일에), `ui/src/scenario/__tests__/statusMode.test.ts`, `ui/src/components/scenario/__tests__/Inspector.test.tsx`(임시 모양을 보던 `:1769-1811`과 자리표시자 `"200"`을 보는 `:1886-1902`를 새 모양으로 다시 쓴다 — `:1813-1885`는 주소·캐스트 테스트라 대상이 아니다), `Inspector.sections.test.tsx:86`(응답 검증 구획의 `sectionCountHint(1)` 덧글 → 새 머리 덧글)

**Interfaces:**
- Consumes: Task 1 `statusMode`·`mergeStatusLines`·`passingCodes`. ②a `assertionLabel(a)`(여러 줄 알림 글의 줄 이름), `store.setStepAssert(stepId, asserts)`, `MAX_STATUS_CODES`.
- Produces:
  - `export function AssertEditor({ step }: { step: HttpStep }): JSX.Element` — store를 직접 읽는다(`setStepAssert`·`yamlError`). Inspector는 prop을 넘기지 않는다.
  - `export function assertHeadHint(asserts: ReadonlyArray<Assertion>): { text: string; tone: "muted" | "warn" } | null` (`statusMode.ts`) — `default` → `null`, `codes` → `muted` + `ko.editor.assertHeadCodes(codes)`, `any` → `warn` + `ko.editor.assertHeadAny`, `multi` → `warn` + `ko.editor.assertHeadMulti`.
  - `Segmented`의 `size?: "md" | "sm"`(기본 `md` — 지금 모든 호출부는 DOM이 그대로다). `sm`: 단추 `min-w-0 flex-1 px-1.5 py-1 text-xs leading-tight [word-break:keep-all]`. 묶음은 호출부가 `className="w-full"`만 준다(뿌리의 `inline-flex`와 `flex`를 함께 주면 스타일시트 순서로 `inline-flex`가 이긴다 — `w-full`만으로 inline-flex 상자가 늘어난다).
  - `Section` card 갈래: `hintAlways`가 참이면 열린 상태에서도 덧글을 보인다. 덧글 색은 `hintTone`을 줄 때만 바뀐다. `muted` → `text-slate-500`(목업 `.cnt`), `warn` → `text-amber-800`(목업 `--amber-tx` `#92400e`). 주지 않으면 지금 `text-slate-400` 그대로다. 덧글은 지금처럼 토글 단추 **밖** 형제다(R4 — 접근 이름 오염 금지).
  - 덧글은 `<legend>` 안에 있으므로, 열린 상태에서 보이면 fieldset(`group`)의 이름에 섞인다(「응답 검증 200만 통과」 — `Inspector.test.tsx:1779·1789·1896`의 `getByRole("group", { name: ko.editor.assertionsLegend })`가 깨진다). 그래서 `hintAlways`일 때 fieldset에 `aria-label`(호출부가 준 `aria-label`이 있으면 그것, 없고 `title`이 문자열이면 제목 글, 둘 다 아니면 달지 않는다 — 지금 그런 호출부는 없다)과, 덧글이 있으면 덧글 `<span id>`를 가리키는 `aria-describedby`를 단다. 두 prop이 없으면 지금 DOM과 같다.

- [ ] **Step 1: 실패하는 테스트 — `AssertEditor.test.tsx`** (store에 YAML을 올리고 스텝을 고른 뒤 그린다 — 기존 `Inspector.test.tsx`의 store 시드 패턴)
  - 기본(검사 없음): radiogroup 「상태 코드 검사 방식」에서 「400 이상은 오류」가 `aria-checked=true`이고, 기본 안내 글이 보인다.
  - 「적은 코드만 통과」를 누르면 YAML 그 스텝에 `- status: 200`이 생기고, 칩 「200」과 「200 빼기」 단추가 보인다.
  - 추가 칸에 409를 넣고 「추가」 → `status: [ 200, 409 ]`(②a의 flow 출력 모양). 같은 칸에 200을 넣고 「추가」 → 목록이 그대로다.
  - 추가 칸 경계: `99`·`600`·`1.5`·빈칸이면 「추가」 비활성. 칸에 `201`을 넣고 Enter → 추가된다. 코드가 64개(`MAX_STATUS_CODES`, 픽스처는 200–263 — 599가 들어 있으면 안 된다)인 스텝은 추가 칸에 **올바른 새 코드(예: 599)를 넣은 뒤에도** 「추가」가 비활성이고 Enter도 아무것도 쓰지 않는다(칸이 비어 있어서 비활성인 것과 가르기 위해서다).
  - 방식 오가기: `[201, 409]` 스텝에서 「보지 않음」 → 「적은 코드만 통과」를 차례로 누르면 YAML이 `status: [ 201, 409 ]`로 돌아온다. 화살표 키로 단추를 옮겨도 같다(`Segmented`는 화살표 키에서 `onChange`를 부른다). 코드를 기억한 적이 없는 스텝은 `[200]`이다.
  - 「200 빼기」·「409 빼기」로 마지막 코드까지 빼면 `assert: []`이고 「400 이상은 오류」가 선택된다.
  - 「보지 않음」 → `- status: any`, 주의색 안내 글(목업 1 다).
  - YAML `[200, 200]` 스텝을 열면 칩이 「200」 하나다. 이때 YAML은 그대로이고 dirty가 아니다.
  - 여러 줄: `- status: 200` / `- status: 201` 스텝 → radiogroup이 없고, 붉은 알림 「상태 코드 검사가 2줄입니다(200 / 201). 줄을 모두 만족해야 통과라서 이 스텝은 항상 실패합니다.」가 보인다. 「「200, 201 가운데 하나면 통과」로 합치기」를 누르면 `status: [ 200, 201 ]` 한 줄이 된다.
  - 여러 줄 갈래별 글(`screens-b.html` 2, 주의색):
    - `[200, 409]` / `[200]` → 「상태 코드 검사가 2줄입니다(200·409 / 200). 지금은 200만 통과합니다.」, 단추 「「200, 409 가운데 하나면 통과」로 합치기」.
    - `200` / `200` → 「… 지금은 200만 통과합니다.」, 단추 「「200만 통과」로 합치기」.
    - `any` / `any` → 「상태 코드 검사가 2줄입니다(보지 않음 / 보지 않음). 지금은 상태 코드를 보지 않습니다.」, 단추 「「보지 않음」 한 줄로 합치기」(누르면 `- status: any` 한 줄).
  - 깨진 YAML(`setPendingYamlText("steps: [")` + `commitPendingYaml()`): 방식 단추·추가·빼기·합치기가 모두 `disabled`다.
  - **손대지 않은 스텝 YAML 불변**: 두 스텝(`[200, 200]  # 둘`과 `any`) 가운데 하나만 방식을 바꿔도, 다른 스텝의 줄이 「손대지 않은 문서를 `String(parseDocument(src))`로 다시 쓴 결과」와 같고 주석이 남는다(②a Review Focus 3과 같은 기준).
- [ ] **Step 2: 실패하는 테스트 — 머리 덧글·프리미티브**
  - `statusMode.test.ts` `assertHeadHint`: `[]` → null, `[200]` → 「200만 통과」/muted, `[200,409]` → 「200, 409만 통과」, 12개 → 「200, 201 외 10개만 통과」, `any` → 「상태 코드를 보지 않음」/warn, 두 줄 → 「확인 필요」/warn.
  - `Inspector.sections.test.tsx`: 「응답 검증」 구획이 **열린** 상태에서도 「200, 409만 통과」 덧글이 보인다. 토글 단추의 접근 이름은 「응답 검증」뿐이고(`getByRole("button", { name: "응답 검증" })` 정확 매치), 구획 묶음의 이름도 「응답 검증」뿐이다(`getByRole("group", { name: "응답 검증" })` 정확 매치).
  - `Segmented.test.tsx`: `size="sm"` 단추 class 토큰(`.split(/\s+/)`)에 `text-xs`·`flex-1`·`[word-break:keep-all]`가 있고 `whitespace-nowrap`이 없다. `size` 없음 → 지금 토큰(`px-3.5`·`text-sm`)과 같다.
  - `Section.test.tsx`: card + `hintAlways` → 열린 상태에서 덧글이 있고, `getByRole("group", { name: 제목 })`이 정확히 맞으며 `aria-describedby`가 덧글을 가리킨다. `hintTone="muted"` → `text-slate-500`, `"warn"` → `text-amber-800`. prop 없음 → 열린 상태 덧글 없음, 닫힌 덧글은 `text-slate-400`(지금 동작).
- [ ] **Step 3: 실패 확인** — `cd ui && pnpm test AssertEditor statusMode Segmented Section Inspector` FAIL.
- [ ] **Step 4: 구현**
  - 레이아웃(목업 1–3): 작은 라벨 「상태 코드」(`text-xs text-slate-600`) → `Segmented size="sm" className="w-full"` → 방식별 본문.
    - 코드: 칩 줄(`flex flex-wrap gap-1.5`, 칩 = `rounded-full border border-slate-300 bg-white pl-2.5 pr-1 py-0.5 font-mono text-xs` + × 단추 `aria-label={ko.editor.assertRemoveCode(code)}`) → 추가 줄(`<div className="w-24"><Input numeric size="sm" type="number" placeholder=… /></div>` + 「추가」 단추) → 안내 글.
    - 보지 않음: 주의 안내 `rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-800`.
    - 여러 줄: 알림 + 합치기 단추 하나(사용자 결정 2026-11-24 — 화면은 여러 줄을 만들지 않고 읽기만 한다). 알림 글과 색은 `passingCodes`로 고른다. `[]`(항상 실패)는 오류 안내(`rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800`, 목업 3)이고, 코드가 있거나 `"any"`면 주의 안내(보지 않음과 같은 amber, `screens-b.html` 2)다. 합치기는 늘 `mergeStatusLines`다.
  - 방식 전환: 기본 → `[]`, 코드 → `[{ kind: "status", codes }]`, 보지 않음 → `[{ kind: "status_any" }]`. 이미 고른 방식을 다시 누르면 아무것도 쓰지 않는다. 코드 방식으로 돌아올 때의 `codes`는 이 스텝에서 마지막으로 본 비지 않은 코드 목록이다(스텝 id를 키로 하는 `useRef` 맵, 에디터에 되돌리기가 없어서 방식을 잘못 눌러도 목록을 잃지 않게). 없으면 `[200]`(spec §11-8).
  - 코드 편집은 늘 겹침 없는 목록으로 쓴다. 추가 가능 조건은 `Number.isInteger(n) && 100 <= n <= 599 && codes.length < MAX_STATUS_CODES`이고, 추가 칸 Enter도 같은 조건이다.
  - 여러 줄 알림의 줄 이름은 `assertionLabel`을 `" / "`로 잇는다. 합치기 단추 글은 `mergeStatusLines` 결과로 고른다(코드 1개 / 2개 이상 / `any`).
  - Inspector 구획: `hint={head?.text ?? null}`, `hintTone={head?.tone}`, `hintAlways`.
  - `yamlError !== null`이면 모든 편집 어포던스가 `disabled`다.
- [ ] **Step 5: 되돌려 확인** — 넷을 한 번씩 바꿔 RED인지 본 뒤 원복한다.
  - 추가 조건에서 `codes.length < MAX_STATUS_CODES`를 지운다 → 64개 테스트 RED.
  - `Section`의 `hintAlways` 갈래를 지운다 → 열린 상태 덧글 테스트 RED.
  - `hintAlways`일 때의 fieldset `aria-label`을 지운다 → 「group 이름 = 응답 검증」 테스트 RED.
  - 코드 기억 맵을 지워 늘 `[200]`을 쓰게 한다 → 방식 오가기 테스트 RED.
- [ ] **Step 6: 확인** — `cd ui && pnpm lint && pnpm test && pnpm build` 0.
- [ ] **Step 7: 커밋** — `feat(editor): 응답 검증 구획 — 세 방식·코드 여러 개·여러 줄 합치기`

---

### Task 3: 스텝 목록 칩 + 새 스텝은 검사 없이 (R20·R27)

**Files:**
- Modify: `ui/src/components/scenario/FlowOutline.tsx:220-242` (칩)
- Modify: `ui/src/scenario/yamlDoc.ts` — `defaultHttpStepNode`(`:833` 부근)와 뼈대 열 곳의 `assert: [{ status: 200 }]`(`grep -n "assert: \[{ status: 200 }\]" ui/src/scenario/yamlDoc.ts` — 지금 11줄. `:939`의 `status: 200`은 정규화 함수 주석의 입력 예시라 대상이 아니다)
- Modify: `ui/src/i18n/ko.ts` (`wideChipAssert` → 카피 정본 칩 셋)
- Test: `ui/src/components/scenario/__tests__/FlowOutline.test.tsx:555-575` 부근, `ui/src/scenario/__tests__/yamlDoc.test.ts`·`store.test.ts`, 새 스텝의 `status: 200`·`codes: [200]`을 기대하던 테스트(Step 3에서 실측해 모은다)

**Interfaces:**
- Consumes: Task 1 `statusMode`.
- Produces: 없음(화면·문서만).

- [ ] **Step 1: 실패하는 테스트**
  - 시각 기준: 목업 `screens.html` 4, 여러 줄 칩은 `screens-b.html` 2 아래 줄.
  - `FlowOutline.test.tsx`(넓은 화면): 검사 없는 스텝 → 검증 칩 없음. `[200, 409]` → 「검증 200·409」. 12개 → 「검증 200 외 11」. `any` → 「상태 코드 안 봄」이고 칩 class에 `text-amber-800`가 있다. 두 줄 → 「검증 확인 필요」(주의색).
  - 기대 글은 `ko.*`와 리터럴 하나를 함께 단언한다(자기참조 방지 — ui/CLAUDE.md).
  - `yamlDoc.test.ts`/`store.test.ts`: `addStep`·`addSetupStep`·loop·if·parallel 뼈대(열 곳 전부 — 위 grep 11줄의 각 갈래를 부르는 store 액션)로 만든 http 스텝에 `assert` 키가 없다(`YAML` 글자에 `assert:`가 없고 모델 `assert`가 `[]`).
  - `templates.ts`의 갤러리 예시는 여전히 `- status: 200`을 가진다(기존 템플릿 테스트가 그대로 통과).
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test FlowOutline yamlDoc store` FAIL.
- [ ] **Step 3: 구현**
  - 뼈대의 `assert` 키를 지운다(빈 배열로 남기지 않는다 — YAML에 `assert: []`가 생기지 않게).
  - 칩은 `statusMode`로 고른다. 칩 줄을 감싸는 조건 `(step.assert.length > 0 || …)`는 `mode.kind !== "default" || …`로 바꾼다.
  - 주의색 칩: `border-amber-300 bg-amber-50 text-amber-800`(목업 `.chip.warn` — `--amber-tx` `#92400e` = amber-800).
  - `pnpm test`를 전체로 한 번 돌려, 새 스텝 기본 200을 기대해 깨지는 테스트를 모은다. 각 테스트는 「새 기본(검사 없음)으로 기대를 고친다」 또는 「테스트 시나리오에 검사를 직접 적는다」로 판정하고, 리포트에 `테스트 | 판정 | 이유` 표로 적는다.
- [ ] **Step 4: 되돌려 확인** — `defaultHttpStepNode`에 `assert: [{ status: 200 }]`을 되살린다 → 새 스텝 테스트 RED. 원복한다.
- [ ] **Step 5: 확인** — `cd ui && pnpm lint && pnpm test && pnpm build` 0. `grep -n "assert: \[{ status: 200 }\]" ui/src/scenario/yamlDoc.ts`가 0줄이다(`defaultHttpStepNode` 위 주석의 「status 200 검증」 문구도 고친다).
- [ ] **Step 6: 커밋** — `feat(editor): 새 스텝은 상태 코드 검사 없이 + 스텝 목록 칩이 검사 방식을 보인다`

---

### Task 4: 기본 규칙 오류의 이유 글 — 미리 실행·모니터 미리보기·점검 기록 (R21)

**Files:**
- Create: `ui/src/scenario/statusExplain.ts`
- Create: `ui/src/components/response/DefaultRuleNote.tsx`
- Modify: `ui/src/components/scenario/TestRunPanel.tsx:134` (오류 글 위)
- Modify: `ui/src/components/monitor/PreviewResult.tsx:214-219` (오류 `dd` 안, 글 위)
- Modify: `ui/src/components/monitor/CheckRecordDialog.tsx:247` (오류 글 위)
- Modify: `ui/src/i18n/ko.ts` (`common.defaultRuleExplain`)
- Test: `ui/src/scenario/__tests__/statusExplain.test.ts`(새 파일), `TestRunPanel.test.tsx`·`PreviewResult.test.tsx`·`CheckRecordDialog.test.tsx`

**Interfaces:**
- Produces:
  - `export function defaultRuleCode(error: string | null | undefined): number | null` — 오류 글 전체가 `/^status (\d{3}) \(>= 400\)$/`와 맞을 때만 그 코드. 엔진 `status_error_text`의 기본 규칙 글(②a 계약 — `crates/engine/src/status_rule.rs` 테스트가 같은 글을 고정한다).
  - `export function DefaultRuleNote({ error }: { error: string | null | undefined }): JSX.Element | null` — 코드가 있으면 `<p>` 하나(`rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800`, 목업 5 `.why` — padding `6px 8px`), 없으면 `null`.

- [ ] **Step 1: 실패하는 테스트**
  - `statusExplain.test.ts`:
    - `"status 404 (>= 400)"` → 404, `"status 503 (>= 400)"` → 503.
    - `"status 503 != 200"`·`"status 503 not in [200, 409]"`·`"request timed out"`·`null`·`""`·`"xstatus 404 (>= 400)"`·`"status 404 (>= 400) extra"` → null.
    - 계약 고정: 엔진 테스트가 쓰는 글자 `"status 404 (>= 400)"`를 리터럴로 쓰고, 출처(`crates/engine/src/status_rule.rs`)를 테스트 이름이나 주석에 적는다.
  - `ko.common.defaultRuleExplain(404)` = 「상태 코드 404를 받아 오류로 셌습니다. 검사를 따로 적지 않은 스텝은 400 이상을 오류로 봅니다. 404가 정상이면 「응답 검증」에서 기대하는 코드에 404를 넣으세요.」, `(503)` = 「상태 코드 503을 받아 … 503이 정상이면 … 503을 넣으세요.」(조사 리터럴 단언).
  - 세 화면: 스텝 `error: "status 404 (>= 400)"`이면 설명 글이 보이고, 그 아래 원래 오류 글이 그대로 보인다(설명 `<p>`가 오류 글보다 문서 순서상 앞 — `compareDocumentPosition`). `error: "status 503 != 200"`이면 설명이 없다. `blocked`가 있는 스텝도 설명이 없다.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test statusExplain TestRunPanel PreviewResult CheckRecordDialog` FAIL.
- [ ] **Step 3: 구현** — Interfaces대로. 세 화면은 `traceErrorText`를 그리는 바로 앞에 `<DefaultRuleNote error={step.error} />`를 둔다. `blocked` 스텝은 `step.error`가 기본 규칙 글이 아니므로 따로 가르지 않는다. 테스트는 「blocked면 설명 없음」을 그대로 고정한다.
- [ ] **Step 4: 되돌려 확인** — 정규식의 `$`를 지운다 → `"… extra"` 테스트 RED. 원복한다.
- [ ] **Step 5: 확인** — `cd ui && pnpm lint && pnpm test && pnpm build` 0.
- [ ] **Step 6: 커밋** — `feat(ui): 검사 없는 스텝의 400 이상 오류에 이유 글 — 미리 실행·모니터`

---

### Task 5: 비교 — 알림 글·규칙 차이를 다른 조건으로·검사 방식 차이 (R26 보강·R28)

시각 기준은 `docs/superpowers/specs/2026-11-24-http-error-default-mockups/screens-b.html` 3–5다(머리말 「참고」 문장, 조건 차이 표 맨 끝 행, 시나리오 카드의 방식 차이 글, 비교 화면 알림 글). 인쇄 컴포넌트(`CondTable`·`FairCards`·`HeadlineBox`)의 마크업은 바꾸지 않는다. 모델(`fairness.ts`)이 행·이름·글을 더하면 목업처럼 그려진다.

**Files:**
- Modify: `ui/src/i18n/ko.ts:2198-2199` (`compare.statusRuleNotice` 글), `ko.print.cmp.fair`(`:2756` 부근 — 「다른 조건」 이름·방식 이름·두 줄 글), `ko.print.cmp.cond`(`:2802` 부근 — 표 행 이름·칸 글)
- Modify: `ui/src/print/compare/fairness.ts:272-321` (`stepDiffs`에 규칙 인자), `:325-333` (`compareScenario`), `:453-459` (`diffNames`), `:513-528` (조건 차이 표 행)
- Test: `ui/src/print/compare/__tests__/fairness.test.ts`, `ui/src/compare/__tests__/statusRuleNotice.test.ts`(`:8-9` 리터럴 `text`), `ui/src/print/compare/__tests__/headline.test.ts`(머리말 큰 글·「참고」 문장), `ui/src/print/compare/__tests__/CompareDocument.test.tsx:240-248`(옛 알림 글 리터럴), `ScenarioComparePage` 테스트(알림 글)

**Interfaces:**
- Consumes: `reportStatusRule(r)`(②a, `api/schemas.ts`), `StatusCheck`·`StepFacts.statusChecks`(②a, `print/scenarioFacts.ts`).
- Produces (`fairness.ts` 안, export는 테스트가 필요할 때만):
  - `type CheckMode = "legacyNone" | "default" | "codes" | "any"`
  - `function checkModeOf(checks: StatusCheck[], rule: 1 | 2): CheckMode` — 줄 0이면 규칙 1 → `legacyNone`, 규칙 2 → `default`. 코드 줄이 하나라도 있으면 `codes`, 줄이 모두 `"any"`면 `any`.
  - `stepDiffs(before, after, rules: { before: 1 | 2; after: 1 | 2 })`

- [ ] **Step 1: 실패하는 테스트 — 방식 차이 (R28)** (`fairness.test.ts`, 기존 `fair()` 도우미와 불변식 둘을 그대로 쓴다). 단계 번호는 `stepNo()`(`print/format.ts:129`)의 동그라미 숫자다(기존 `fairness.test.ts:439·455`와 같다). 카드 줄로 단언하면 `1곳 다름: ①의 …` 꼴이다.
  - 두 run 모두 규칙 1: `[]` → `[[200]]` = 「추가됨」, `[[200]]` → `[]` = 「제거됨」, `[[200]]` → `[[200,409]]` = 「바뀜」(지금 글 — R13 고정).
  - 두 run 모두 규칙 2:
    - `[]` → `["any"]` = 「①의 상태 코드 검사 방식 바뀜: 400 이상은 오류 → 보지 않음」.
    - `[]` → `[[200]]` = 「①의 상태 코드 검사 방식 바뀜: 400 이상은 오류 → 적은 코드만 통과」.
    - `[[200]]` → `[[200,409]]` = 「①의 기대 코드 바뀜: 200 → 200·409」.
    - `[[409,200]]` → `[[200,409]]` = 줄 없음(순서 무관).
    - `["any",[200]]` → `[[200]]` = 줄 없음(둘 다 「적은 코드만 통과」, `any` 줄은 건너뛴다).
    - `["any"]` → `["any"]` = 줄 없음.
  - 규칙 1(앞) ↔ 규칙 2(뒤): `[]` → `[]` = 줄 없음. `[]` → `[[200]]` = 「①의 상태 코드 검사 방식 바뀜: 검사 없음 → 적은 코드만 통과」. `[[200]]` → `[[200]]` = 줄 없음.
  - **순서 뒤집기**: 규칙 2(앞) ↔ 규칙 1(뒤): `[]` → `[]` = 줄 없음. `["any"]` → `[]` = 「①의 상태 코드 검사 방식 바뀜: 보지 않음 → 검사 없음」.
  - 줄 단위 견줌(spec R28 정정): `[[200],[201]]` → `[[200,201]]` = 「①의 기대 코드 바뀜: 200 / 201 → 200·201」(코드 줄마다 `·`, 줄 사이 ` / `. 코드는 YAML에 적힌 순서대로 보인다 — plan 판단).
- [ ] **Step 2: 실패하는 테스트 — 규칙 차이를 다른 조건으로 (R26 보강)**
  - 같은 시나리오·같은 부하에서 규칙만 1 ↔ 2: `diffNames`에 「오류 집계 규칙」이 있고, `anyDiff === true`다. 조건 차이 표에 행 `{ label: "오류 집계 규칙", before: "검사 없는 스텝은 모두 통과", after: "검사 없는 스텝은 400 이상이 오류", differs: true }`가 있다. 카드 넷은 모두 `same`이고, `statusRuleLine`은 그대로 글을 가진다.
  - 순서를 뒤집어도(2 ↔ 1) 이름이 있고, 칸 글이 서로 바뀐다.
  - 두 run 모두 1, 모두 2: 「오류 집계 규칙」 이름·행이 없다.
  - 규칙과 부하 조건·환경 변수가 함께 다를 때 `diffNames[0]`이 「오류 집계 규칙」이다(머리말 「참고」 문장은 앞의 두 이름만 쓰고 나머지는 「외 N개」로 접기 때문이다 — `headline.ts:224-226`).
  - 머리말(`headline.test.ts`): 규칙만 다른 두 run의 비교에서 `h.word === "참고용"`(큰 글이 「※ 참고용」으로 바뀐다 — `headline.ts:95-96`)이고, 「참고」 문장 조각에 「오류 집계 규칙」이 있다.
- [ ] **Step 3: 실패하는 테스트 — 알림 글** — `statusRuleNotice([rep(1), rep(2)])`(기존 `rep` 도우미 — `statusRuleNotice.test.ts:4`)가 카피 정본의 새 글이다. `:8-9`의 리터럴 `text`를 새 글로 바꾼다. `CompareDocument.test.tsx:248`의 리터럴도 새 글로 바꾼다. 비교 화면·인쇄 비교 알림 줄이 같은 글을 보인다.
- [ ] **Step 4: 실패 확인** — `cd ui && pnpm test fairness statusRuleNotice headline CompareDocument ScenarioComparePage` FAIL.
- [ ] **Step 5: 구현**
  - `buildFairness`가 `reportStatusRule(before.report)`·`reportStatusRule(after.report)`을 한 번 구해 `compareScenario` → `stepDiffs`에 넘긴다.
  - `stepDiffs`의 검사 차이 갈래:
    - 두 규칙이 모두 1이면 지금 세 갈래 코드를 그대로 쓴다.
    - 그 밖에는 `checkModeOf`로 앞·뒤 방식을 구한다. `{legacyNone, default}` 쌍은 줄을 내지 않는다. 방식이 다르면 `F.assertModeChanged(no, 앞 이름, 뒤 이름)`이다. 둘 다 `codes`이면 코드 줄만(`any` 줄 제외) `sameChecks`로 견주어 다를 때 `F.assertCodesChanged(no, 앞 글, 뒤 글)`이다. 그 밖에는 줄이 없다.
    - 줄의 `kind`는 지금처럼 `"assert"`라 조건 차이 표의 「시나리오 응답 코드 검사」 행이 따라온다.
  - 규칙이 다르면 `diffNames` **맨 앞**에 `F.statusRuleName`을 넣는다(`unshift` — 머리말 「참고」 문장이 앞의 두 이름만 쓰므로 가장 큰 설명이 접히지 않게). 이 때문에 규칙 1 ↔ 2 비교는 늘 `anyDiff`이고 머리말 큰 글이 「※ 참고용」이다(목업 `screens-b.html` 3 — 의도된 동작, §B에 적는다). 조건 차이 표의 **맨 끝**에 `addRow(C.statusRule, C.statusRuleText[ruleA], C.statusRuleText[ruleB], true, false)`를 넣는다(규칙이 다를 때만).
  - 알림 줄(`statusRuleLine`, `FairCards`)은 그대로 둔다.
- [ ] **Step 6: 되돌려 확인** — 셋을 한 번씩 바꿔 RED인지 본 뒤 원복한다.
  - `{legacyNone, default}` 쌍 건너뛰기를 지운다 → 「규칙 1 ↔ 2, `[]` → `[]` = 줄 없음」 RED.
  - 「두 규칙 모두 1」 갈래를 지워 늘 새 갈래를 타게 한다 → 규칙 1 고정 테스트 RED.
  - `diffNames`에 규칙 이름을 넣는 줄을 지운다 → R26 보강 테스트 RED. `unshift`를 `push`로 바꾼다 → `diffNames[0]` 테스트 RED.
- [ ] **Step 7: 확인** — `cd ui && pnpm lint && pnpm test && pnpm build` 0.
- [ ] **Step 8: 커밋** — `feat(compare): 규칙 차이를 다른 조건으로 + 인쇄 비교가 검사 방식으로 견준다`

---

## 카피 정본 (`ko.ts`, 글자 그대로)

| 키(제안) | 글 |
|---|---|
| `editor.assertStatusLabel` | 상태 코드 |
| `editor.assertModeAria` | 상태 코드 검사 방식 |
| `editor.assertModeDefault` / `assertModeCodes` / `assertModeAny` | 400 이상은 오류 / 적은 코드만 통과 / 보지 않음 |
| `editor.assertHintDefault` | 따로 적지 않아도 400 이상(4xx·5xx) 응답은 오류로 셉니다. 399까지는 통과입니다. |
| `editor.assertHintCodes` | 적은 코드 가운데 하나를 받으면 통과입니다. 그 밖의 코드는 오류로 셉니다. |
| `editor.assertHintAny` | 이 스텝은 어떤 상태 코드를 받아도 오류로 세지 않습니다. 4xx·5xx를 받으면 리포트가 따로 알려 줍니다. |
| `editor.assertCodePlaceholder` | 예: 201 |
| `editor.assertRemoveCode(n)` | `${n} 빼기` |
| `editor.assertHeadCodes(codes)` | 2개 이하: `${codes.join(", ")}만 통과` · 3개 이상: `${a}, ${b} 외 ${n - 2}개만 통과` |
| `editor.assertHeadAny` | 상태 코드를 보지 않음 |
| `editor.assertHeadMulti` | 확인 필요 |
| `editor.assertMultiFails(k, labels)` | `상태 코드 검사가 ${k}줄입니다(${labels}). 줄을 모두 만족해야 통과라서 이 스텝은 항상 실패합니다.` |
| `editor.assertMultiPassing(k, labels, codes)` | `상태 코드 검사가 ${k}줄입니다(${labels}). 지금은 ${codes.join(", ")}만 통과합니다.` |
| `editor.assertMultiAny(k, labels)` | `상태 코드 검사가 ${k}줄입니다(${labels}). 지금은 상태 코드를 보지 않습니다.` |
| `editor.assertMergeCodes(codes)` | 1개: `「${c}만 통과」로 합치기` · 2개 이상: `「${codes.join(", ")} 가운데 하나면 통과」로 합치기` |
| `editor.assertMergeAny` | 「보지 않음」 한 줄로 합치기 |
| `editor.chipAssertCodes(codes)` (`wideChipAssert` 대체) | 2개 이하: `검증 ${codes.join("·")}` · 3개 이상: `검증 ${codes[0]} 외 ${n - 1}` |
| `editor.chipAssertAny` | 상태 코드 안 봄 |
| `editor.chipAssertMulti` | 검증 확인 필요 |
| `trust.checkAFailTitle` | 상태 코드를 보지 않는 스텝이 있습니다 |
| `trust.checkAFailWhy` | 이 스텝은 4xx·5xx가 와도 실패로 잡히지 않습니다 |
| `trust.checkAPass` | 모든 스텝이 오류 응답을 실패로 잡습니다 |
| `common.defaultRuleExplain(n)` | `상태 코드 ${n}${josa(을/를)} 받아 오류로 셌습니다. 검사를 따로 적지 않은 스텝은 400 이상을 오류로 봅니다. ${n}${josa(이/가)} 정상이면 「응답 검증」에서 기대하는 코드에 ${n}${josa(을/를)} 넣으세요.` |
| `compare.statusRuleNotice` | 선택한 run 가운데 오류 집계 규칙이 다른 run이 있습니다. 이 변경 전에 실행한 run은 상태 코드 검사가 없는 스텝의 4xx·5xx를 오류로 세지 않았습니다 — 오류율을 그대로 견주지 마세요. |
| `print.cmp.fair.statusRuleName` | 오류 집계 규칙 |
| `print.cmp.fair.checkModeNames` | `legacyNone` 검사 없음 · `default` 400 이상은 오류 · `codes` 적은 코드만 통과 · `any` 보지 않음 |
| `print.cmp.fair.assertModeChanged(no, a, b)` | `${no}의 상태 코드 검사 방식 바뀜: ${a} → ${b}` |
| `print.cmp.fair.assertCodesChanged(no, a, b)` | `${no}의 기대 코드 바뀜: ${a} → ${b}` |
| `print.cmp.cond.statusRule` | 오류 집계 규칙 |
| `print.cmp.cond.statusRuleText` | `1` 검사 없는 스텝은 모두 통과 · `2` 검사 없는 스텝은 400 이상이 오류 |

사용자 결정(2026-11-24, 다시 묻지 않는다): 화면은 상태 코드 검사를 한 줄로만 쓴다. 여러 줄은 지금 master 에디터의 「추가」(`Inspector.tsx:693` — 코드마다 줄 하나)가 만든 기존 시나리오를 읽을 때만 나오고, 경고 + 합치기 하나(늘 모두 합침)로 다룬다. 엔진은 여러 줄을 지금처럼 읽는다.

plan 판단(마무리 §B에 「사용자 확인 대기」로 적는다 — 목업 `screens-b.html`에 그린 것):
- 머리 덧글: 코드 1개일 때 「200만 통과」. 여러 줄 스텝의 칩 「검증 확인 필요」.
- 합치기 단추 글: 코드 1개(「200만 통과」로)와 `any`(「「보지 않음」 한 줄로 합치기」).
- 여러 줄 알림 색: 항상 실패만 붉은색, 나머지는 주의색.
- 방식을 오갈 때 코드 목록을 기억했다가 되살린다(에디터에 되돌리기가 없어서). 기억은 `AssertEditor` 안이라 구획을 접거나 다른 스텝을 고르면 사라진다(`Section`은 열린 동안만 본문을 그린다 — `Section.tsx:59`). 넘어서려면 store로 옮긴다.
- 인쇄 비교: 검사 차이를 줄 단위로 견준다(spec R28 정정). 코드 줄이 여럿인 스텝의 기대 코드 표시는 줄 사이 ` / `이고, 코드는 적힌 순서로 보인다. 「오류 집계 규칙」 표 행은 맨 끝, 「다른 조건」 이름은 맨 앞이다. 그래서 규칙 1 ↔ 2 비교의 머리말 큰 글은 늘 「※ 참고용」이다.
- `Segmented size="sm"`은 목업의 `white-space: nowrap` 대신 낱말 단위로 줄을 바꾼다(Review Focus 1 — 좁은 Inspector).
- 「응답 검증」 머리 덧글을 열린 상태에서도 보인다(목업). 그래서 fieldset에 `aria-label`과 `aria-describedby`를 단다.

## 마무리 (task 밖 — orchestrator)

1. **최종 리뷰**: `handicap-reviewer`(BASE = 이 plan 커밋). 초점은 넷이다.
   - `statusMode`를 거치지 않고 검사 방식을 정하는 자리가 남았는가(`grep -rn "assert.length\|kind === \"status\"" ui/src --include='*.tsx' --include='*.ts' | grep -v __tests__`).
   - 손대지 않은 스텝의 YAML 불변.
   - 두 run이 모두 규칙 1인 인쇄 비교의 글이 그대로인가.
   - 옛 동작(새 스텝 = `status: 200`)에 기대던 다른 소비자(템플릿 저장·HAR·테스트 픽스처)가 없는가.
2. **보안**: `finish-slice` §0 grep으로 판단한다. 이유 글은 오류 글에서 숫자 하나만 꺼내 싣는다(주소·본문 없음). trace 뷰어 3곳을 건드리므로 grep이 걸리면 `security-reviewer`를 돌린다.
3. **perf**: 엔진·요청 경로 변경이 없어 `/perf-ab`는 하지 않는다. 근거를 build-log에 적는다.
4. **라이브**(`/live-verify`, spec §8 표의 ②b 행 + 극단값):
   - US2·US3: 방식 전환·코드 추가·보지 않음 → 저장 → 다시 열기. `GET /api/scenarios/{id}`의 `yaml`이 권위다(Monaco DOM 불신).
   - US4: 미리 실행(검사 없음 + 404)·모니터 미리보기·점검 기록·신뢰도 판.
   - 극단값: 코드 12개·64개(추가 비활성), 긴 스텝 이름, 여러 줄 알림. 세 방식 단추의 `scrollWidth <= clientWidth`와 단추 높이를 기본 Inspector 폭과 넓게 보기에서 잰다. Windows 1em 글꼴 흉내(`letter-spacing: 0.12em`)도 한 번.
   - 진입 화면 전부: 새 시나리오, 저장된 시나리오 편집, 준비 스텝, if·loop·parallel 안 스텝, 스텝 템플릿에서 넣은 스텝.
   - 인쇄 비교: 규칙 1 run ↔ 규칙 2 run(②a 라이브 DB 재사용 가능)에서 머리말 「참고」·조건 차이 표 행·검사 방식 줄.
5. **기록**: build-log 단락, roadmap §B 새 블록(번호는 `grep -n '^### B' docs/roadmap.md` 마지막+1). 넣을 것:
   - 위 plan 판단(사용자 확인 대기)
   - spec §6 여러 줄 알림 조건 정정
   - 릴리즈 노트 줄 추가분: 새 스텝은 검사 없이 시작 · 「미리 실행 확인됨」 한 번 풀림(§B93 (5)에 이어)
   - CLAUDE.md 상태줄 `최신 =` 교체, 현황판 전진. 머지는 사용자 지시를 따른다.

# timeout-knob-ui Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ScheduleForm에서 connect timeout을 설정·해제할 수 있게 하고, 명시 설정된 run-level 타임아웃 2종을 리포트/Run 상세에 조건부 한 줄로 노출한다.

**Architecture:** UI-only(서버/proto/migration 0-diff). 공유 토대(기본값 상수 `schemas.ts`·검증 술어 `profileForm.ts`·표시 게이트 헬퍼 `runPrefill.ts`)를 먼저 깔고, ScheduleForm 입력과 리포트 표면이 그것을 소비한다. 스펙: `docs/superpowers/specs/2026-08-03-timeout-knob-ui-design.md` (spec-plan-reviewer 3R clean APPROVE).

**Tech Stack:** React+TS, Zod(schemas.ts), vitest+RTL, ko 카탈로그(ADR-0035).

## Global Constraints

- **게이트**: 각 task 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build` green(`pnpm build`가 최종 — esbuild가 못 잡는 TS strict를 tsc -b가 잡는다). pre-commit 훅이 ui/ staged 시 같은 게이트를 다시 돈다 — **커밋은 단일 FOREGROUND 호출(timeout 600000ms)·파이프 금지**(`| tail`이 실패를 마스킹).
- **cargo 0-diff**: `.rs`·proto·migration·`Cargo.*` 절대 무접촉. `schemas.ts`는 상수 정의+`.default(상수)` 치환만(와이어 형상 무변경).
- **카피는 전부 `ko.ts` 경유**(ADR-0035) — 하드코딩 한국어/영어 aria-label 금지. 신규 키는 spec §5의 5개, 삭제 키는 `validation.connectTimeoutStored` 1개.
- **`30` 하드코딩 금지**: 소비처는 `DEFAULT_HTTP_TIMEOUT_SECONDS`(Task 1) — 전수 5곳은 spec §5·C18.
- **tdd-guard**: 각 task의 첫 편집은 반드시 테스트 파일(pending RED). src 편집이 먼저면 차단된다.
- **`pnpm test <이름>`으로 단일 파일 필터** — `--`를 붙이면 전체 스위트가 돈다(ui/CLAUDE.md).
- **전체일치 단언**: `appliedTimeoutsHttpDefault(n) ⊃ appliedTimeoutsHttp(n)` 부분문자열 포함관계 때문에 ①/② 분기 구별 단언은 `textContent` 정확 비교 또는 `/^…$/`(spec §5-①·§6).
- **이빨 실증**: 회귀 가드 표방 테스트는 고의 회귀→RED→원복→GREEN을 실행·기록(spec §6 — 주입 지점 유의: US2는 ScheduleForm 배선, builder가 아님).

---

### Task 1: 공유 토대 — 기본값 상수·검증 술어·표시 게이트 헬퍼 + RunDialog 기계 치환

**Files:**
- Modify: `ui/src/api/schemas.ts` (`:70` ProfileSchema **위**에 상수 — `.default()` 인자는 모듈 평가 시 즉시 평가라 아래 선언은 TDZ ReferenceError)
- Modify: `ui/src/api/runPrefill.ts` (헬퍼 추가)
- Modify: `ui/src/components/profileForm.ts` (술어 추가 + `:133-134` docstring 갱신)
- Modify: `ui/src/components/RunDialog.tsx` (`:124`·`:167`·`:291`·`:422` 상수 치환, `:389-394` 술어 호출 치환)
- Test: `ui/src/components/__tests__/profileForm.test.ts`, `ui/src/api/__tests__/runPrefill.test.ts`

**Interfaces:**
- Produces: `DEFAULT_HTTP_TIMEOUT_SECONDS: 30`(schemas.ts export) · `isConnectTimeoutDraftInvalid(draft: string, httpTimeout: number): boolean`(profileForm.ts export) · `appliedTimeoutKnobs(p: {http_timeout_seconds?: number; connect_timeout_seconds?: number | null}): {http: number; connect: number | null; show: boolean}`(runPrefill.ts export) — Task 2·3이 소비.

- [ ] **Step 1: 실패하는 유닛 테스트 먼저 (tdd-guard 언블록)**

`ui/src/components/__tests__/profileForm.test.ts` 기존 import에 `isConnectTimeoutDraftInvalid` 추가 후 파일 끝에:

```ts
describe("isConnectTimeoutDraftInvalid (timeout-knob-ui — RunDialog·ScheduleForm 공유 술어)", () => {
  it("빈/공백 draft는 유효(미설정)", () => {
    expect(isConnectTimeoutDraftInvalid("", 30)).toBe(false);
    expect(isConnectTimeoutDraftInvalid("  ", 30)).toBe(false);
  });
  it("1..=600 정수이면서 http보다 작으면 유효", () => {
    expect(isConnectTimeoutDraftInvalid("5", 30)).toBe(false);
    expect(isConnectTimeoutDraftInvalid("1", 2)).toBe(false);
    expect(isConnectTimeoutDraftInvalid("600", 601)).toBe(false);
  });
  it("http 이상·범위 밖·비정수는 invalid", () => {
    expect(isConnectTimeoutDraftInvalid("30", 30)).toBe(true); // == http도 invalid (< 강제)
    expect(isConnectTimeoutDraftInvalid("0", 30)).toBe(true);
    expect(isConnectTimeoutDraftInvalid("601", 700)).toBe(true);
    expect(isConnectTimeoutDraftInvalid("1.5", 30)).toBe(true);
  });
});
```

`ui/src/api/__tests__/runPrefill.test.ts` 기존 import에 `appliedTimeoutKnobs` 추가 후 파일 끝에:

```ts
describe("appliedTimeoutKnobs (timeout-knob-ui — spec §4 표시 게이트)", () => {
  it("둘 다 기본이면 show=false (필드 부재 raw profile 포함)", () => {
    expect(appliedTimeoutKnobs({ http_timeout_seconds: 30 })).toEqual({
      http: 30,
      connect: null,
      show: false,
    });
    expect(appliedTimeoutKnobs({})).toEqual({ http: 30, connect: null, show: false });
  });
  it("connect 설정 시 show=true·connect null-정규화 없음", () => {
    expect(appliedTimeoutKnobs({ http_timeout_seconds: 30, connect_timeout_seconds: 5 })).toEqual({
      http: 30,
      connect: 5,
      show: true,
    });
  });
  it("http만 비기본이어도 show=true·raw undefined http는 기본 정규화", () => {
    expect(appliedTimeoutKnobs({ http_timeout_seconds: 10 })).toEqual({
      http: 10,
      connect: null,
      show: true,
    });
    expect(appliedTimeoutKnobs({ connect_timeout_seconds: 5 })).toEqual({
      http: 30,
      connect: 5,
      show: true,
    });
  });
  it("connect null(서버 직렬화 아님·방어)은 미설정과 동일", () => {
    expect(appliedTimeoutKnobs({ http_timeout_seconds: 30, connect_timeout_seconds: null }).show).toBe(false);
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test profileForm; pnpm test runPrefill`
Expected: 두 파일 모두 FAIL — `isConnectTimeoutDraftInvalid`/`appliedTimeoutKnobs` export 없음(import 에러 또는 undefined 호출).

- [ ] **Step 3: 상수 — `ui/src/api/schemas.ts`**

`:70` `export const ProfileSchema` **바로 위**에:

```ts
/** run-level HTTP 타임아웃 기본값(초). 서버 store serde default와 lockstep
 *  (crates/controller/src/store/runs.rs Profile.http_timeout_seconds). */
export const DEFAULT_HTTP_TIMEOUT_SECONDS = 30;
```

`:75`(상수 삽입 후 줄 밀림 주의 — `grep -n "default(30)" ui/src/api/schemas.ts`로 재확정)의 `http_timeout_seconds: z.number().int().min(1).max(600).default(30)`을:

```ts
  http_timeout_seconds: z.number().int().min(1).max(600).default(DEFAULT_HTTP_TIMEOUT_SECONDS),
```

- [ ] **Step 4: 술어 — `ui/src/components/profileForm.ts`**

파일 끝(또는 `buildProfile` 아래)에:

```ts
/** connect timeout draft(문자열)의 폼-레벨 유효성 — RunDialog·ScheduleForm 공유(spec §3-2).
 *  빈/공백 문자열 = 미설정(유효 — buildProfile이 키를 생략한다). 서버
 *  validate_run_config(1..=600 ∧ < http_timeout)와 lockstep. true = invalid. */
export function isConnectTimeoutDraftInvalid(draft: string, httpTimeout: number): boolean {
  if (draft.trim() === "") return false;
  const n = Number(draft);
  return !Number.isInteger(n) || n < 1 || n > 600 || n >= httpTimeout;
}
```

같은 파일 `:133-134`의 stale docstring("RunDialog가 입력을 소유하고, ScheduleForm은 초기값을 pass-through만 한다")을:

```ts
  /**
   * connect 단계 전용 타임아웃 draft(초). 빈 문자열/미전달 = 미설정 → 키 자체 생략.
   * RunDialog·ScheduleForm 둘 다 입력을 소유한다(timeout-knob-ui).
   */
```

- [ ] **Step 5: 게이트 헬퍼 — `ui/src/api/runPrefill.ts`**

파일 상단 import에 `DEFAULT_HTTP_TIMEOUT_SECONDS` 추가(`./schemas`에서 — 이미 `./schemas` import 있음), 파일 끝에:

```ts
/** 적용 타임아웃 노브 표시 판정(spec §4). 입력을 느슨한 구조 타입으로 받는 이유:
 *  normalizeProfile 통과 Profile(http 항상 number)과 raw RunSchema.profile
 *  (중첩 .default() 누출 → number|undefined) 양쪽을 한 헬퍼로 수용해야 해서다
 *  (Pick<Profile,…>이면 raw 쪽에서 tsc -b가 깨진다 — ui/CLAUDE.md 누출 함정). */
export function appliedTimeoutKnobs(p: {
  http_timeout_seconds?: number;
  connect_timeout_seconds?: number | null;
}): { http: number; connect: number | null; show: boolean } {
  const http = p.http_timeout_seconds ?? DEFAULT_HTTP_TIMEOUT_SECONDS;
  const connect = p.connect_timeout_seconds ?? null;
  return { http, connect, show: connect != null || http !== DEFAULT_HTTP_TIMEOUT_SECONDS };
}
```

- [ ] **Step 6: GREEN 확인**

Run: `cd ui && pnpm test profileForm; pnpm test runPrefill`
Expected: PASS (기존 케이스 포함 전부).

- [ ] **Step 7: RunDialog 기계 치환 (동작 byte-identical)**

`ui/src/components/RunDialog.tsx`:
- `:34` `from "./profileForm"` import 목록에 `isConnectTimeoutDraftInvalid` 추가, `:13` `from "../api/schemas"` type-only import와 **별도로** 값 import가 필요하므로 `import { DEFAULT_HTTP_TIMEOUT_SECONDS } from "../api/schemas";` 추가(기존 `import type`은 값 import 불가 — 새 줄).
- `:124` `useState(initial?.profile.http_timeout_seconds ?? 30)` → `?? DEFAULT_HTTP_TIMEOUT_SECONDS`.
- `:167` `init.profile.http_timeout_seconds !== 30` → `!== DEFAULT_HTTP_TIMEOUT_SECONDS`.
- `:291` `prof.http_timeout_seconds !== 30` → 동일 치환.
- `:389-394`:

```ts
  const connectTimeoutInvalid = isConnectTimeoutDraftInvalid(connectTimeout, httpTimeout);
```

- `:422` `(httpTimeout !== 30 ? 1 : 0)` → `!== DEFAULT_HTTP_TIMEOUT_SECONDS`.

치환 후 전수 확인: `grep -rn "?? 30\|== 30" ui/src --include="*.tsx" --include="*.ts" | grep -v __tests__` → **ScheduleForm.tsx:97 한 곳만 남아야 함**(Task 2가 치환).

- [ ] **Step 8: 전체 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm test && pnpm build; echo exit=$?`
Expected: exit=0 (RunDialog 기존 테스트 전부 green = byte-identical 가드).

```bash
git add ui/src/api/schemas.ts ui/src/api/runPrefill.ts ui/src/components/profileForm.ts ui/src/components/RunDialog.tsx ui/src/components/__tests__/profileForm.test.ts ui/src/api/__tests__/runPrefill.test.ts
git commit -m "feat(ui): timeout-knob 공유 토대 — DEFAULT_HTTP_TIMEOUT_SECONDS 단일소스·connect 검증 술어·appliedTimeoutKnobs 게이트 (RunDialog 5곳 기계 치환)"
```

---

### Task 2: ScheduleForm connect timeout 입력·해제 (US1·US2)

**Files:**
- Modify: `ui/src/components/ScheduleForm.tsx` (`:1` react import에 `useId` 추가, `:97-101`·`:229-231`·`:242`·`:347-362` 뒤·`:453-454`)
- Modify: `ui/src/i18n/ko.ts` (`validation.connectTimeoutStored` 키 삭제 — `:251` 부근, `grep -n`으로 재확정)
- Test: `ui/src/components/__tests__/ScheduleForm.test.tsx`

**Interfaces:**
- Consumes: `isConnectTimeoutDraftInvalid`(Task 1, `./profileForm`) · `DEFAULT_HTTP_TIMEOUT_SECONDS`(Task 1, `../api/schemas`) · 기존 `ko.loadModel.connectTimeout{,Hint,Placeholder}`·`ko.validation.connectTimeout`.
- Produces: (없음 — leaf task)

- [ ] **Step 1: 테스트 먼저 — 기존 2건 재작성 + 신규 4건**

`ui/src/components/__tests__/ScheduleForm.test.tsx`:

(a) `:184` "저장된 connect_timeout_seconds가 편집 저장 라운드트립에서 보존된다" — 단언 유지, 주석만 교체:

```ts
  it("저장된 connect_timeout_seconds가 편집 저장 라운드트립에서 보존된다", async () => {
    // 입력이 init에서 시드되므로 무수정 저장 시 값이 그대로 실린다(구 pass-through의 의미 계승).
```

(b) `:214` "저장된 connect_timeout이 http_timeout 이상이면…" 케이스를 **통째 교체**(구 전제 "이 폼엔 입력이 없다"가 소멸):

```ts
  it("connect_timeout이 http_timeout 이상이면 저장을 막고 일반 검증 문구를 보인다", async () => {
    const user = userEvent.setup();
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={vi.fn()}
        submitting={false}
        initial={{
          name: "n",
          scenario_id: "s1",
          profile: {
            vus: 1,
            duration_seconds: 5,
            ramp_up_seconds: 0,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            connect_timeout_seconds: 5,
          } as Profile,
          env: {},
          trigger: { kind: "cron", cron_expr: "0 2 * * *" },
          enabled: true,
        }}
      />,
    );
    await user.clear(screen.getByLabelText(ko.loadModel.httpTimeout));
    await user.type(screen.getByLabelText(ko.loadModel.httpTimeout), "3");
    expect(screen.getByText(ko.validation.connectTimeout)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /저장/ })).toBeDisabled();
  });
```

(c) 신규 — US2 해제(시드 중간-상태 단언 필수, spec §6):

```ts
  it("US2: 시드된 connect_timeout을 비우고 저장하면 키 자체가 빠진다", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={onSubmit}
        submitting={false}
        initial={{
          name: "n",
          scenario_id: "s1",
          profile: {
            vus: 1,
            duration_seconds: 5,
            ramp_up_seconds: 0,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            connect_timeout_seconds: 3,
          } as Profile,
          env: {},
          trigger: { kind: "cron", cron_expr: "0 2 * * *" },
          enabled: true,
        }}
      />,
    );
    const input = screen.getByLabelText(ko.loadModel.connectTimeout);
    // 시드 실증 — 빈 칸이면 아래 not.toHaveProperty가 공허 통과한다(auto-seed 공허 클래스).
    expect(input).toHaveValue(3);
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: /저장/ }));
    expect(onSubmit.mock.calls[0][0].profile).not.toHaveProperty("connect_timeout_seconds");
  });
```

(d) 신규 — US1 설정 저장:

```ts
  it("US1: connect_timeout을 입력해 저장하면 숫자로 실린다", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    wrap(
      <ScheduleForm scenarioOptions={[{ id: "s1", name: "scn" }]} onSubmit={onSubmit} submitting={false} />,
    );
    await user.selectOptions(screen.getByLabelText("시나리오"), "s1");
    await user.type(screen.getByLabelText(ko.loadModel.connectTimeout), "5");
    await user.click(screen.getByRole("button", { name: /저장/ }));
    expect(onSubmit.mock.calls[0][0].profile.connect_timeout_seconds).toBe(5);
  });
```

**주의**: 신규-스케줄 폼의 필수 입력(name·trigger 등)이 비어 저장이 disabled일 수 있다 — 이 파일의 기존 "저장 성공" 테스트가 쓰는 최소 셋업 헬퍼/절차를 그대로 복사해 맞출 것(구체 셀렉터는 파일 상단 기존 케이스가 정본). 시나리오 select의 실제 aria-label도 기존 케이스에서 복사.

(e) 신규 — 비정수 draft("1.5" — "abc"는 HTML5 sanitize로 도달 불가, ui/CLAUDE.md):

```ts
  it("비정수 connect_timeout은 저장을 막는다", async () => {
    const user = userEvent.setup();
    wrap(<ScheduleForm scenarioOptions={[{ id: "s1", name: "scn" }]} onSubmit={vi.fn()} submitting={false} />);
    await user.type(screen.getByLabelText(ko.loadModel.connectTimeout), "1.5");
    expect(screen.getByText(ko.validation.connectTimeout)).toBeInTheDocument();
  });
```

(f) 신규 — hint a11y(spec §6 N6):

```ts
  it("connect_timeout 입력에 hint가 aria-describedby로 연결된다", () => {
    wrap(<ScheduleForm scenarioOptions={[{ id: "s1", name: "scn" }]} onSubmit={vi.fn()} submitting={false} />);
    expect(screen.getByLabelText(ko.loadModel.connectTimeout)).toHaveAccessibleDescription(
      ko.loadModel.connectTimeoutHint,
    );
  });
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test ScheduleForm`
Expected: 신규 4건 FAIL(입력 없음 — `getByLabelText(ko.loadModel.connectTimeout)` not found), (b) FAIL(구 문구 기대 제거로 신 문구 부재).

- [ ] **Step 3: ScheduleForm 구현**

`ui/src/components/ScheduleForm.tsx`:

① `:1` `import { useCallback, useId, useMemo, useState } from "react";` (useId 추가 — 이 폼 최초의 id, 하드코딩 금지·spec N3).
② `./profileForm` import(`:20` 부근)에 `isConnectTimeoutDraftInvalid` 추가. `:3` `import type ... from "../api/schemas"`와 별도로 `import { DEFAULT_HTTP_TIMEOUT_SECONDS } from "../api/schemas";` 추가.
③ `:97` `useState(init?.http_timeout_seconds ?? 30)` → `?? DEFAULT_HTTP_TIMEOUT_SECONDS`.
④ `:98-101`(주석 2줄 + const)을:

```ts
  // connect timeout 입력 draft. 빈 문자열 = 미설정(buildProfile이 키를 생략 — US2 해제 경로).
  const [connectTimeout, setConnectTimeout] = useState(
    init?.connect_timeout_seconds != null ? String(init.connect_timeout_seconds) : "",
  );
```

(reseed effect 금지 — `SchedulesPage.tsx:142` `key={editingId ?? "new"}` 리마운트가 시드를 보증, spec C15.)
⑤ 컴포넌트 본문(다른 `useId`류 훅 위치 — state 선언들 근처)에 `const connectHintId = useId();`.
⑥ `:229-231`(주석 + `connectTimeoutConflict`)을:

```ts
  const connectTimeoutInvalid = isConnectTimeoutDraftInvalid(connectTimeout, httpTimeout);
```

⑦ `:242` `!connectTimeoutConflict` → `!connectTimeoutInvalid`.
⑧ HTTP timeout 블록(`:347-362`) **바로 아래**에:

```tsx
      {/* Connect timeout (opt-in — 빈 칸 = 미설정) */}
      <div className="mb-3 max-w-xs">
        <label className="block text-sm">
          <span className="text-slate-600">{ko.loadModel.connectTimeout}</span>
          <Input
            type="number"
            min={1}
            max={600}
            aria-label={ko.loadModel.connectTimeout}
            placeholder={ko.loadModel.connectTimeoutPlaceholder}
            value={connectTimeout}
            onChange={(e) => setConnectTimeout(e.target.value)}
            className="mt-1"
            aria-invalid={connectTimeoutInvalid}
            aria-describedby={connectHintId}
          />
        </label>
        <p id={connectHintId} className="mt-1 text-xs text-slate-500">
          {ko.loadModel.connectTimeoutHint}
        </p>
      </div>
```

⑨ 막힘 사유 블록 `:453-454`의

```ts
          ...(connectTimeoutConflict
            ? [ko.validation.connectTimeoutStored(Number(connectTimeout))]
            : []),
```

을:

```ts
          ...(connectTimeoutInvalid ? [ko.validation.connectTimeout] : []),
```

⑩ `ui/src/i18n/ko.ts`에서 `connectTimeoutStored` 키(함수값, `:251` 부근) 삭제.

- [ ] **Step 4: GREEN + 전수 확인**

Run: `cd ui && pnpm test ScheduleForm; pnpm test ko` — Expected: PASS.
Run: `grep -rn "connectTimeoutStored" ui/src` — Expected: 0건(orphan 완전 제거).
Run: `grep -rn "?? 30\|== 30" ui/src --include="*.tsx" --include="*.ts" | grep -v __tests__` — Expected: 0건.

- [ ] **Step 5: 이빨 실증 — US2 배선 회귀(spec §6 주입 지점)**

`connectTimeout`을 일시적으로 Task 착수 전 형태(`const connectTimeout = init?... : "";` — setter 제거·onChange를 no-op `() => {}`로)로 되돌린다.
Run: `cd ui && pnpm test ScheduleForm; pnpm test profileForm`
Expected: **US2 테스트(c)와 US1 테스트(d)만 RED, `profileForm.test.ts`는 GREEN**(주입이 builder가 아니라 폼 배선임을 증명 — spec C19). 원복 후 재실행 GREEN. 결과(어느 테스트가 RED였는지)를 커밋 메시지 본문이나 SDD 노트에 1줄 기록.

- [ ] **Step 6: 전체 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm test && pnpm build; echo exit=$?` — Expected: exit=0.

```bash
git add ui/src/components/ScheduleForm.tsx ui/src/i18n/ko.ts ui/src/components/__tests__/ScheduleForm.test.tsx
git commit -m "feat(ui): ScheduleForm connect timeout 입력·해제 (US1·US2) — 술어 공유·hint a11y·connectTimeoutStored 은퇴"
```

---

### Task 3: 리포트 표면 — AppliedTimeouts 한 줄 + RunDetailPage li (US3)

**Files:**
- Create: `ui/src/components/report/AppliedTimeouts.tsx`
- Modify: `ui/src/components/report/ReportView.tsx` (`:1-33` import·`:37` 부근 useMemo·`:164` `<Summary>` 직전)
- Modify: `ui/src/pages/RunDetailPage.tsx` (`:260-273` `<ul>` 안)
- Modify: `ui/src/i18n/ko.ts` (`report:` 섹션 `:895-` 안에 5키 추가)
- Test: `ui/src/components/report/__tests__/AppliedTimeouts.test.tsx`(신규), `ui/src/pages/__tests__/RunDetailPage.test.tsx`(추가)

**Interfaces:**
- Consumes: `appliedTimeoutKnobs`·`DEFAULT_HTTP_TIMEOUT_SECONDS`(Task 1) · `flattenHttpSteps`(기존 `scenario/model`) · `parseScenarioDoc`(기존 — ReportView가 이미 import).
- Produces: `AppliedTimeouts({profile: Profile; hasStepTimeoutOverride: boolean})` 컴포넌트.

- [ ] **Step 1: 테스트 먼저 — AppliedTimeouts 신규 파일**

`ui/src/components/report/__tests__/AppliedTimeouts.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppliedTimeouts } from "../AppliedTimeouts";
import { ko } from "../../../i18n/ko";
import { normalizeProfile } from "../../../api/runPrefill";

function prof(over: Record<string, unknown>) {
  return normalizeProfile({ vus: 1, duration_seconds: 5, ...over });
}

describe("AppliedTimeouts (spec §4 — 명시 설정 시에만 한 줄)", () => {
  it("① connect만 설정: 기본값 병기 — 전체일치(부분문자열 함정 방어)", () => {
    render(
      <AppliedTimeouts profile={prof({ connect_timeout_seconds: 5 })} hasStepTimeoutOverride={false} />,
    );
    const line = screen.getByText(new RegExp(ko.report.appliedTimeoutsLead));
    // ①/②는 "(기본값)" 접미로만 갈리므로 textContent 정확 비교(spec §5-①).
    expect(line.textContent).toBe(
      `${ko.report.appliedTimeoutsLead} — ${ko.report.appliedTimeoutsHttpDefault(30)} · ${ko.report.appliedTimeoutsConnect(5)}`,
    );
    expect(line.textContent).toContain("5"); // 보간 소실 가드(공허 11호)
  });
  it("② 둘 다 설정: 두 세그먼트 숫자 — 전체일치", () => {
    render(
      <AppliedTimeouts
        profile={prof({ http_timeout_seconds: 10, connect_timeout_seconds: 5 })}
        hasStepTimeoutOverride={false}
      />,
    );
    const line = screen.getByText(new RegExp(ko.report.appliedTimeoutsLead));
    expect(line.textContent).toBe(
      `${ko.report.appliedTimeoutsLead} — ${ko.report.appliedTimeoutsHttp(10)} · ${ko.report.appliedTimeoutsConnect(5)}`,
    );
    expect(line.textContent).toContain("10");
  });
  it("③ http만 비기본: 요청 세그먼트만", () => {
    render(<AppliedTimeouts profile={prof({ http_timeout_seconds: 10 })} hasStepTimeoutOverride={false} />);
    expect(screen.getByText(new RegExp(ko.report.appliedTimeoutsLead)).textContent).toBe(
      `${ko.report.appliedTimeoutsLead} — ${ko.report.appliedTimeoutsHttp(10)}`,
    );
  });
  it("④ 둘 다 기본: 미렌더(0-diff)", () => {
    const { container } = render(<AppliedTimeouts profile={prof({})} hasStepTimeoutOverride={false} />);
    expect(container.firstChild).toBeNull();
    // 게이트는 노브 기준 — 오버라이드만 있고 노브 미설정이면 여전히 미렌더(꼬리는 부속, 단독 발화 금지).
    const { container: c2 } = render(<AppliedTimeouts profile={prof({})} hasStepTimeoutOverride={true} />);
    expect(c2.firstChild).toBeNull();
  });
  it("⑤ 스텝 오버라이드 꼬리: true면 존재·false면 부재", () => {
    render(
      <AppliedTimeouts profile={prof({ connect_timeout_seconds: 5 })} hasStepTimeoutOverride={true} />,
    );
    expect(screen.getByText(new RegExp(ko.report.appliedTimeoutsLead)).textContent).toContain(
      ko.report.appliedTimeoutsStepOverride,
    );
  });
});
```

(주의: `new RegExp(ko.report.appliedTimeoutsLead)` — "적용 타임아웃"엔 정규식 메타문자 없음. ko 값 변경 시 이 전제 재확인.)

`ui/src/pages/__tests__/RunDetailPage.test.tsx` — 이 파일의 기존 **비-terminal(running) fixture** 케이스를 찾아(profile `<ul>`을 이미 단언하는 케이스가 정본) 형제 케이스 추가:

```tsx
  it("실행 중 run의 raw profile 목록: 설정된 타임아웃 노브만 li로 (줄별 게이트)", async () => {
    // 기존 running-run 케이스의 fetch mock 셋업을 복사하되 profile에 connect_timeout_seconds: 5만 추가
    // (http_timeout_seconds: 30 = 기본 → http 줄은 부재해야 한다 — 줄별 게이트 회귀 가드).
    // …기존 셋업 복사…
    expect(await screen.findByText("connect_timeout = 5s")).toBeInTheDocument();
    expect(screen.queryByText(/http_timeout =/)).not.toBeInTheDocument();
  });
```

(기존 fixture 구조는 파일이 정본 — mock 셋업 이디엄을 그대로 따르고, 기본 run 케이스에서 두 li 모두 부재 단언도 기존 케이스에 1줄 추가.)

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test AppliedTimeouts; pnpm test RunDetailPage`
Expected: AppliedTimeouts 모듈 없음 FAIL · RunDetailPage 신규 케이스 FAIL(li 없음).

- [ ] **Step 3: ko 키 추가**

`ui/src/i18n/ko.ts` `report:` 섹션(`:895` 시작) 안에:

```ts
    appliedTimeoutsLead: "적용 타임아웃",
    appliedTimeoutsHttp: (n: number) => `요청 ${n}s`,
    appliedTimeoutsHttpDefault: (n: number) => `요청 ${n}s (기본값)`,
    appliedTimeoutsConnect: (n: number) => `연결 ${n}s`,
    appliedTimeoutsStepOverride: "일부 스텝은 자체 타임아웃 사용",
```

양방향 부분문자열 sweep(spec §5-①): `appliedTimeoutsHttpDefault(n) ⊃ appliedTimeoutsHttp(n)`는 알려진 불가피 쌍(전체일치 단언으로 방어 — Step 1) 외에 신규 5값 ↔ 기존 카탈로그 충돌이 없는지 `grep -n "적용 타임아웃\|일부 스텝은\|요청 .*s\|연결 .*s" ui/src/i18n/ko.ts`로 확인.

- [ ] **Step 4: AppliedTimeouts 구현**

`ui/src/components/report/AppliedTimeouts.tsx`:

```tsx
import type { Profile } from "../../api/schemas";
import { DEFAULT_HTTP_TIMEOUT_SECONDS } from "../../api/schemas";
import { appliedTimeoutKnobs } from "../../api/runPrefill";
import { ko } from "../../i18n/ko";

type Props = { profile: Profile; hasStepTimeoutOverride: boolean };

/** 명시 설정된 run-level 타임아웃 노브 한 줄(spec §4). 기본값 run은 미렌더(0-diff).
 *  꼬리 "일부 스텝은 자체 타임아웃 사용"은 오도 방지(per-step 오버라이드 존재 신호만 —
 *  값 노출은 비목표, store/runs.rs:162-165의 상호작용 문서 참조). */
export function AppliedTimeouts({ profile, hasStepTimeoutOverride }: Props) {
  const k = appliedTimeoutKnobs(profile);
  if (!k.show) return null;
  const parts = [
    k.http === DEFAULT_HTTP_TIMEOUT_SECONDS
      ? ko.report.appliedTimeoutsHttpDefault(k.http)
      : ko.report.appliedTimeoutsHttp(k.http),
    ...(k.connect != null ? [ko.report.appliedTimeoutsConnect(k.connect)] : []),
    ...(hasStepTimeoutOverride ? [ko.report.appliedTimeoutsStepOverride] : []),
  ];
  return (
    <p className="mb-4 text-sm text-slate-600">
      {ko.report.appliedTimeoutsLead} — {parts.join(" · ")}
    </p>
  );
}
```

- [ ] **Step 5: ReportView 배선**

`ui/src/components/report/ReportView.tsx`:
- import에 `AppliedTimeouts` 추가(형제 report 컴포넌트 블록).
- `groupMeta` useMemo(`:78-88`) 아래에:

```ts
  const hasStepTimeoutOverride = useMemo(() => {
    const parsed = parseScenarioDoc(report.scenario_yaml);
    // flattenHttpSteps는 loop/parallel/if 완전 재귀 — 중첩 오버라이드 포함(scenarioHasThink 선례).
    return "model" in parsed
      ? flattenHttpSteps(parsed.model.steps).some((s) => s.timeout_seconds != null)
      : false; // 파싱 실패 = 꼬리 생략(fail-soft, spec §10)
  }, [report.scenario_yaml]);
```

- `:164` `<Summary` 직전에:

```tsx
      <AppliedTimeouts profile={profile} hasStepTimeoutOverride={hasStepTimeoutOverride} />
```

- [ ] **Step 6: RunDetailPage li**

`ui/src/pages/RunDetailPage.tsx`:
- import 추가: `import { appliedTimeoutKnobs } from "../api/runPrefill";`(기존 runPrefill import 있으면 목록에 추가) · `import { DEFAULT_HTTP_TIMEOUT_SECONDS } from "../api/schemas";`.
- `<ul className="font-mono ...">`(`:260`) 안 `ramp_up` li(`:263`) 뒤에:

```tsx
              {(() => {
                const knobs = appliedTimeoutKnobs(r.profile);
                return (
                  <>
                    {knobs.http !== DEFAULT_HTTP_TIMEOUT_SECONDS && (
                      <li>http_timeout = {knobs.http}s</li>
                    )}
                    {knobs.connect != null && <li>connect_timeout = {knobs.connect}s</li>}
                  </>
                );
              })()}
```

(줄별 게이트 — spec §4: raw 목록은 기본값 병기 없음. `r.profile`은 raw(누출 `number|undefined`)지만 헬퍼가 느슨한 구조 타입이라 수용.)

- [ ] **Step 7: GREEN + 이빨 실증(렌더 게이트)**

Run: `cd ui && pnpm test AppliedTimeouts; pnpm test RunDetailPage; pnpm test ReportView`
Expected: PASS.
이빨: `AppliedTimeouts.tsx`의 `if (!k.show) return null;`을 일시 제거 → 케이스 ④ RED 확인 → 원복 GREEN. `appliedTimeoutKnobs`의 `!==`를 `===`로 일시 반전 → ③·④ RED 확인 → 원복.

- [ ] **Step 8: 전체 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm test && pnpm build; echo exit=$?` — Expected: exit=0.

```bash
git add ui/src/components/report/AppliedTimeouts.tsx ui/src/components/report/__tests__/AppliedTimeouts.test.tsx ui/src/components/report/ReportView.tsx ui/src/pages/RunDetailPage.tsx ui/src/pages/__tests__/RunDetailPage.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): 적용 타임아웃 사후 노출 (US3) — AppliedTimeouts 한 줄·RunDetailPage 줄별 li·스텝 오버라이드 꼬리"
```

---

### Task 4: 라이브 검증 (US1·US2·US3·US3' — `/live-verify`)

**Files:** (production 0-diff — 검증만. 산출물은 SDD 노트/finish-slice 기록용 결과 로그)

**Interfaces:**
- Consumes: Task 1–3 전부 머지된 워크트리 HEAD.

- [ ] **Step 1: 스택 기동** — `/live-verify` 스킬 레시피 기준 + spec §7 보강: 워크트리 자체 바이너리(`cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller`), `cd ui && pnpm build`로 dist 생성 후 `./target/debug/controller --db /tmp/timeout-knob-ui.db --ui-dir ui/dist --rest 127.0.0.1:8097 --grpc 127.0.0.1:8096 --scheduler-tick-seconds 5`(전용 포트 — 8080 선점 회피, tick 5s — 기본 30s 대기 단축). 200-responder(포트 충돌 없는 임의 포트) 준비. 시나리오 1개 생성(`POST /api/scenarios`).
- [ ] **Step 2: US1** — UI `/schedules`에서 스케줄 생성: connect 5s 입력 + `once` 근미래 트리거 + duration 30s 이상. 발사 대기(≤5s tick) 후 `GET /api/schedules/{id}`의 `last_run_id`로 run 조회 → `profile.connect_timeout_seconds === 5` 확인.
- [ ] **Step 3: US3'(보조)** — US1 run이 도는 동안 `/runs/{run_id}` 열람 → raw profile 목록에 `connect_timeout = 5s` li 렌더(스크린샷/DOM 텍스트), `http_timeout =` li **부재**(기본 30) 확인.
- [ ] **Step 4: US3** — run 종료 후 리포트: "적용 타임아웃 — 요청 30s (기본값) · 연결 5s" 라인 실렌더 + 대조 미설정 run(RunDialog로 1개 생성) 리포트에 라인 **부재** + 양쪽 콘솔 Zod 에러 0.
- [ ] **Step 5: US2** — 같은 스케줄 편집: connect 칸에 5가 시드돼 보이는지 → 비우고 `once` 재설정 저장 → `GET /api/schedules/{id}` profile에 키 부재 → 다음 발사 run profile에도 키 부재.
- [ ] **Step 6: 정리·기록** — 컨트롤러/responder 종료(`pgrep -f "target/debug/controller --db /tmp/timeout-knob-ui.db"`로 지목 kill), 결과를 US별 PROVEN/FAIL 표로 기록(finish-slice §4 build-log 입력).

---

## Self-Review 결과 (plan 저작 시 실행)

- **Spec coverage**: §3(입력·검증·주석·orphan·해제)→Task 2 / §4(헬퍼·컴포넌트·배선·li)→Task 1·3 / §5(상수·ko 5키·삭제 1키)→Task 1·2·3 / §6(테스트 전략 전 항목)→각 task Step 1·이빨 스텝 / §7→Task 4. 갭 없음.
- **Placeholder scan**: 코드 블록 전 스텝 실재. 단 RTL 신규 케이스 2곳(Task 2 (d)의 신규-폼 최소 셋업, Task 3 RunDetailPage mock 셋업)은 **기존 파일 이디엄 복사를 명시 지시** — 파일이 정본인 항목이라 인라인 복제보다 안전(기존 셀렉터/헬퍼 드리프트 방지).
- **Type consistency**: `isConnectTimeoutDraftInvalid(draft: string, httpTimeout: number)` Task 1 정의 = Task 2 소비. `appliedTimeoutKnobs` 반환 `{http, connect, show}` = Task 3 소비. `DEFAULT_HTTP_TIMEOUT_SECONDS` schemas.ts export = Task 1·2·3 import 경로(`../api/schemas`·`../../api/schemas`) 일치.

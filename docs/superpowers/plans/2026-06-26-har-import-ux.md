# HAR 가져오기 UX 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HAR 가져오기 화면에 요청 선택 툴바(전체 선택/해제·중복 해제)·중복 표시와, 옵트인 호스트→`${변수}` 치환 + 환경(Environment) 등록을 더해 가져오기 마찰을 줄인다.

**Architecture:** 전부 클라이언트 UI. 순수 헬퍼(`filters.ts` dedup, `harToScenario.ts` URL 치환, 신규 `hostEnv.ts`)에 로직을 두고 `ScenarioImportPage.tsx`가 상태·배선만. 유일한 서버 호출은 *기존* `POST /api/environments`(`useCreateEnvironment`). 엔진·proto·migration·`schemas.ts`(run 와이어) 0-diff.

**Tech Stack:** React + TS + Tailwind, Zustand 무관(이 페이지는 로컬 useState), `@tanstack/react-query`(env 등록만), vitest + React Testing Library, `yaml`(stringify).

스펙: `docs/superpowers/specs/2026-06-26-har-import-ux-design.md` (R1–R13).

## Global Constraints

- **UI-only.** `crates/**`·proto·migration·`ui/src/api/schemas.ts`(run 와이어) 0-diff. 서버 상호작용은 기존 `POST /api/environments`(`EnvironmentInput`/`EnvironmentSchema` 계약 무변경)뿐. (R12, spec §5)
- **모든 사용자-노출 문구는 `ko.import.*` 카탈로그 경유** — 버튼·배지·라벨·`aria-label`·배너 전부. 인라인 영어/한국어 리터럴 금지(ADR-0035, R13). 변수 치환 명사 뒤 조사는 `(으)로`/`은(는)` 병기형.
- **TDD 순서 — 테스트 파일을 *먼저* 편집**(pending RED diff)한 뒤 production `ui/src/**`를 편집한다. `tdd-guard`(루트 CLAUDE.md C-1)가 pending test-path diff 없으면 첫 src 편집을 막는다. (ui/CLAUDE.md "ui-only 슬라이스 tdd-guard" 함정)
- **빌드 게이트는 `pnpm build`(`tsc -b`)까지** — `pnpm test`(esbuild)는 TS strict·`import type` 깊이·discriminated-union narrowing을 안 잡는다. 머지 전 `pnpm lint && pnpm test && pnpm build` 전체 1회(`pnpm lint`=`--max-warnings=0`). (ui/CLAUDE.md)
- **단일 파일 테스트 반복은 `pnpm test <name>`(— `--` 붙이면 전체 스위트가 돌아 느림). 머지 전 인자 없는 `pnpm test` 전체 1회.** (ui/CLAUDE.md)
- 커밋은 docs/ui-only라 pre-commit cargo 게이트 skip(fast-path). 커밋은 파이프 없이 단일 호출 + 직후 `git log -1`로 landed 확인.

---

## File Structure

| 파일 | 책임 | 태스크 |
|---|---|---|
| `ui/src/import/filters.ts` (수정) | dedup 순수 헬퍼: `pathnameOf`(private)·`dedupKey`·`duplicateIndices`·`PreviewEntry` 타입 export | T1 |
| `ui/src/import/__tests__/filters.test.ts` (수정) | dedup 골든 | T1 |
| `ui/src/pages/ScenarioImportPage.tsx` (수정) | T2: 선택 툴바·중복 배지·요약 / T5: 호스트→env 섹션·배선 | T2, T5 |
| `ui/src/import/harToScenario.ts` (수정) | `parameterizeUrl`·`ConvertOptions.hostVars?`·`wireStep` 치환 | T3 |
| `ui/src/import/__tests__/harToScenario.test.ts` (수정) | 치환 골든(와이어-형) + off byte-identical | T3 |
| `ui/src/import/hostEnv.ts` (신규) | 호스트→env 순수 헬퍼 | T4 |
| `ui/src/import/__tests__/hostEnv.test.ts` (신규) | 헬퍼 단위 | T4 |
| `ui/src/pages/__tests__/ScenarioImportPage.test.tsx` (수정) | T2 툴바/배지/요약 + T5 env 섹션(QueryClientProvider 추가) | T2, T5 |
| `ui/src/i18n/ko.ts` (수정) | `ko.import.*` 신규 키 | T2, T5 |

---

## Task 1: filters.ts — dedup 순수 헬퍼 (R6)

**Files:**
- Modify: `ui/src/import/filters.ts`
- Test: `ui/src/import/__tests__/filters.test.ts`

**Interfaces:**
- Produces:
  - `export interface PreviewEntry { index: number; method: string; url: string }`
  - `export function dedupKey(method: string, url: string): string` — `METHOD pathname`, 쿼리·프래그먼트·호스트 무시.
  - `export function duplicateIndices(preview: readonly PreviewEntry[]): ReadonlySet<number>` — 그룹 2번째+ 의 `index`.

- [ ] **Step 1: 실패 테스트 작성** — `ui/src/import/__tests__/filters.test.ts`에 import를 보강하고 describe 블록 추가.

기존 import 줄에 `dedupKey, duplicateIndices, type PreviewEntry`를 `../filters`에서 추가로 가져온다(이미 다른 심볼을 import 중이면 같은 구문에 합칠 것). 파일 끝에 추가:

```ts
describe("dedupKey / duplicateIndices (R6)", () => {
  it("dedupKey: 쿼리스트링·프래그먼트·호스트를 무시하고 method+경로로 키", () => {
    expect(dedupKey("get", "https://a.com/api/users?page=1")).toBe(
      dedupKey("GET", "https://b.com/api/users?page=2#x"),
    );
  });

  it("dedupKey: method가 다르면 다른 키 (GET≠POST)", () => {
    expect(dedupKey("GET", "https://a.com/x")).not.toBe(dedupKey("POST", "https://a.com/x"));
  });

  it("dedupKey: 상대/파싱불가 URL도 쿼리 무시", () => {
    expect(dedupKey("GET", "/a?x=1")).toBe(dedupKey("GET", "/a?x=2"));
    expect(dedupKey("GET", "/a")).toBe(dedupKey("GET", "/a#frag"));
  });

  it("duplicateIndices: 그룹의 2번째+ index만 반환(첫 발생 제외)", () => {
    const preview: PreviewEntry[] = [
      { index: 0, method: "GET", url: "https://a.com/users?p=1" },
      { index: 2, method: "GET", url: "https://a.com/users?p=2" }, // dup of 0
      { index: 5, method: "POST", url: "https://a.com/users" }, // 다른 method
      { index: 7, method: "GET", url: "https://a.com/users" }, // dup of 0 (쿼리 무시)
    ];
    const dups = duplicateIndices(preview);
    expect([...dups].sort((x, y) => x - y)).toEqual([2, 7]);
    expect(dups.has(0)).toBe(false);
    expect(dups.has(5)).toBe(false);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd ui && pnpm test filters`
Expected: FAIL — `dedupKey is not a function` / `duplicateIndices is not exported`.

- [ ] **Step 3: 최소 구현** — `ui/src/import/filters.ts` 끝(혹은 `distinctHosts` 아래)에 추가:

```ts
export interface PreviewEntry {
  index: number;
  method: string;
  url: string;
}

// dedup용 경로 추출 — 절대 URL은 pathname, 파싱불가/상대 URL은 ?·# 앞까지(쿼리 무시 일관).
// (표시명용 pathOf/static-detection pathOf와 별개의 dedup-전용 헬퍼.)
function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : url.slice(0, cut);
  }
}

export function dedupKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${pathnameOf(url)}`;
}

// 입력(미리보기) 순서대로 그룹 첫 발생을 기록하고, 2번째+의 index를 모은다.
export function duplicateIndices(preview: readonly PreviewEntry[]): ReadonlySet<number> {
  const seen = new Set<string>();
  const dups = new Set<number>();
  for (const p of preview) {
    const k = dedupKey(p.method, p.url);
    if (seen.has(k)) dups.add(p.index);
    else seen.add(k);
  }
  return dups;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm test filters`
Expected: PASS (기존 filters 테스트 + 새 describe 전부 green).

- [ ] **Step 5: 커밋**

```bash
git add ui/src/import/filters.ts ui/src/import/__tests__/filters.test.ts
git commit -m "feat(import): dedupKey/duplicateIndices 순수 헬퍼 (R6)

method+경로(쿼리 무시) 기준 중복 판정 — 절대·상대 URL 일관."
```

---

## Task 2: ScenarioImportPage — 선택 툴바·중복 배지·요약 (R1–R5)

**Files:**
- Modify: `ui/src/pages/ScenarioImportPage.tsx`
- Modify: `ui/src/i18n/ko.ts` (`ko.import` 신규 키)
- Test: `ui/src/pages/__tests__/ScenarioImportPage.test.tsx`

**Interfaces:**
- Consumes: `duplicateIndices`, `PreviewEntry` (T1).
- Produces: 페이지 동작만(외부 시그니처 없음).

- [ ] **Step 1: ko 키 추가** — `ui/src/i18n/ko.ts`의 `import: { … }` 블록에 키 추가(기존 키 뒤, `toEditor` 다음):

```ts
    // 선택 툴바·중복 (Task 2)
    selectAll: "전체 선택",
    deselectAll: "전체 해제",
    dedup: "중복 해제",
    selectionSummary: (n: number, m: number, k: number) =>
      `선택 ${n} / 전체 ${m} · 중복 ${k} (method+경로 기준)`,
    dupBadge: "중복",
```

> `selectionSummary`의 `(method+경로 기준)` 인라인 문구가 R4의 "기준 명시"를 충족(별도 HelpTip 불필요).

- [ ] **Step 2: 실패 테스트 작성** — `ScenarioImportPage.test.tsx`에 중복 포함 HAR fixture + describe 추가.

파일 상단(HAR 상수 아래)에 추가:

```ts
// method+경로 중복이 있는 HAR: GET /a 두 번(쿼리만 다름) + POST /a 한 번.
const DUP_HAR = JSON.stringify({
  log: {
    entries: [
      { request: { method: "GET", url: "https://api.example.com/a?p=1", headers: [] }, response: { status: 200 } },
      { request: { method: "GET", url: "https://api.example.com/a?p=2", headers: [] }, response: { status: 200 } },
      { request: { method: "POST", url: "https://api.example.com/a", headers: [] }, response: { status: 200 } },
    ],
  },
});
```

`describe("ScenarioImportPage", …)` 안에 추가:

```ts
  it("R4/R5: 요약에 선택/전체/중복 수와 기준 문구, 중복 행에 배지", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(DUP_HAR));
    await screen.findByLabelText(ko.import.preview);
    // 3개 요청, 그 중 1개가 중복(2번째 GET /a)
    expect(screen.getByText(ko.import.selectionSummary(3, 3, 1))).toBeInTheDocument();
    // 중복 배지는 정확히 1개
    expect(screen.getAllByText(ko.import.dupBadge)).toHaveLength(1);
  });

  it("R2: 전체 해제 → YAML steps 0, R1: 전체 선택 → 복구", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(DUP_HAR));
    const preview = (await screen.findByLabelText(ko.import.preview)) as HTMLTextAreaElement;
    await user.click(screen.getByRole("button", { name: ko.import.deselectAll }));
    await waitFor(() => expect(preview.value).not.toContain("steps:"));
    await user.click(screen.getByRole("button", { name: ko.import.selectAll }));
    await waitFor(() =>
      expect((screen.getByLabelText(ko.import.preview) as HTMLTextAreaElement).value).toContain("/a"),
    );
  });

  it("R3: 중복 해제 → 그룹당 첫 요청만 남는다(2번째 GET /a 해제)", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(DUP_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByRole("button", { name: ko.import.dedup }));
    // 중복 해제 후 선택 2 / 전체 3 / 중복 1
    await waitFor(() =>
      expect(screen.getByText(ko.import.selectionSummary(2, 3, 1))).toBeInTheDocument(),
    );
  });
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `cd ui && pnpm test ScenarioImportPage`
Expected: FAIL — 요약 문구/버튼/배지 없음.

- [ ] **Step 4: 페이지 구현** — `ScenarioImportPage.tsx` 수정.

(a) import 보강:
```ts
import { type Har, type PreviewEntry, distinctHosts, duplicateIndices, entryHost, isStaticAsset } from "./filters";
```
> `previewEntries` 메모의 타입을 `PreviewEntry[]`로 맞춘다(기존 인라인 `{ url; method; index }[]` → `PreviewEntry[]`).

(b) `previewEntries` 메모 아래에 파생값·핸들러 추가:
```ts
  const dupSet = useMemo(() => duplicateIndices(previewEntries), [previewEntries]);
  const selectedCount = useMemo(
    () => previewEntries.filter((p) => !excludedIndices.has(p.index)).length,
    [previewEntries, excludedIndices],
  );

  const selectAll = () => setExcludedIndices(new Set());
  const deselectAll = () => setExcludedIndices(new Set(previewEntries.map((p) => p.index)));
  const dedup = () =>
    setExcludedIndices((prev) => {
      const next = new Set(prev);
      for (const i of duplicateIndices(previewEntries)) next.add(i);
      return next;
    });
```

(c) 요청 `<fieldset>`의 `<legend>` 다음, 목록 분기 위에 툴바 삽입:
```tsx
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-600">
                {ko.import.selectionSummary(selectedCount, previewEntries.length, dupSet.size)}
              </span>
              <span className="flex-1" />
              <Button variant="secondary" onClick={selectAll}>
                {ko.import.selectAll}
              </Button>
              <Button variant="secondary" onClick={deselectAll}>
                {ko.import.deselectAll}
              </Button>
              <Button variant="secondary" onClick={dedup} disabled={dupSet.size === 0}>
                {ko.import.dedup}
              </Button>
            </div>
```

(d) 각 요청 `<li>`의 라벨에 배지 추가(`<span className="truncate">` 다음):
```tsx
                      <span className="truncate">
                        {p.method} {p.url}
                      </span>
                      {dupSet.has(p.index) && (
                        <span className="shrink-0 rounded bg-amber-100 px-1 text-xs text-amber-700">
                          {ko.import.dupBadge}
                        </span>
                      )}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd ui && pnpm test ScenarioImportPage`
Expected: PASS (기존 + 신규 전부).

- [ ] **Step 6: 커밋**

```bash
git add ui/src/pages/ScenarioImportPage.tsx ui/src/pages/__tests__/ScenarioImportPage.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(import): 요청 선택 툴바·중복 배지·요약 (R1-R5)

전체 선택/해제·중복 해제(method+경로) 버튼 + 선택/중복 요약 + 중복 배지."
```

---

## Task 3: harToScenario.ts — URL 치환 (R9, R12)

**Files:**
- Modify: `ui/src/import/harToScenario.ts`
- Test: `ui/src/import/__tests__/harToScenario.test.ts`

**Interfaces:**
- Produces:
  - `export function parameterizeUrl(url: string, hostVars?: Record<string, string>): string`
  - `ConvertOptions.hostVars?: Record<string, string>` (optional 필드 추가)

- [ ] **Step 1: 실패 테스트 작성** — `harToScenario.test.ts`에 describe 추가(파일 끝).

import에 `parameterizeUrl`를 `../harToScenario`에서 추가로 가져온다.

```ts
describe("parameterizeUrl / hostVars (R9, R12)", () => {
  it("매핑된 호스트의 origin을 ${변수}로 치환, path·query 유지", () => {
    expect(parameterizeUrl("https://api.example.com/users?p=1", { "api.example.com": "BASE_URL" })).toBe(
      "${BASE_URL}/users?p=1",
    );
  });

  it("매핑에 없는 호스트·상대 URL은 불변", () => {
    expect(parameterizeUrl("https://cdn.x.com/a", { "api.example.com": "BASE_URL" })).toBe(
      "https://cdn.x.com/a",
    );
    expect(parameterizeUrl("/relative/path", { "api.example.com": "BASE_URL" })).toBe("/relative/path");
  });

  it("hostVars 미지정이면 불변(byte-identical)", () => {
    expect(parameterizeUrl("https://api.example.com/a")).toBe("https://api.example.com/a");
  });

  it("harToScenarioYaml: hostVars 주면 step url이 ${BASE_URL}/path 와이어-형", () => {
    const h = har([getEntry()]);
    const yaml = harToScenarioYaml(h, { ...DEFAULTS, hostVars: { "api.example.com": "BASE_URL" } });
    expect(yaml).toContain("url: ${BASE_URL}/users");
    // 와이어 구조 유지(파싱 + step 존재). (ui/CLAUDE.md "HAR import R2")
    const parsed = parseScenarioDoc(yaml);
    expect("model" in parsed).toBe(true);
  });

  it("harToScenarioYaml: hostVars 미지정이면 기존 절대 URL(byte-identical 경로)", () => {
    const h = har([getEntry()]);
    expect(harToScenarioYaml(h, DEFAULTS)).toContain("url: https://api.example.com/users");
  });
});
```

> `parseScenarioDoc`·`har`·`getEntry`·`DEFAULTS`는 이미 이 테스트 파일에 있다(상단 import/헬퍼 재사용).

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd ui && pnpm test harToScenario`
Expected: FAIL — `parameterizeUrl` 미export.

- [ ] **Step 3: 구현** — `harToScenario.ts` 수정.

(a) `ConvertOptions`에 optional 필드:
```ts
export interface ConvertOptions extends SelectOptions {
  headerMode: HeaderMode;
  statusAssert: boolean;
  name: string;
  hostVars?: Record<string, string>;
}
```

(b) `pathOf` 근처에 신규 순수 함수:
```ts
// 매핑된 호스트의 origin(scheme://host[:port])을 ${변수}로 치환. 미매핑·상대 URL은 불변.
export function parameterizeUrl(url: string, hostVars?: Record<string, string>): string {
  if (!hostVars) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const varName = hostVars[parsed.host];
  if (!varName) return url;
  return `\${${varName}}${parsed.pathname}${parsed.search}${parsed.hash}`;
}
```

(c) `wireStep`에서 url 산출을 치환 경유(표시명은 원본 path 유지):
```ts
function wireStep(entry: HarEntry, opts: ConvertOptions): Record<string, unknown> {
  const method = entry.request.method.toUpperCase();
  const rawUrl = entry.request.url;
  const url = parameterizeUrl(rawUrl, opts.hostVars);
  const request: Record<string, unknown> = {
    method,
    url,
    headers: foldHeaders(entry.request.headers, opts.headerMode),
  };
  const body = wireBody(entry.request.postData);
  if (body) request.body = body;
  const status = entry.response?.status;
  const assert = opts.statusAssert && typeof status === "number" ? [{ status }] : [];
  return {
    id: newStepId(),
    name: `${method} ${pathOf(rawUrl)}`,
    type: "http",
    request,
    assert,
    extract: [],
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm test harToScenario`
Expected: PASS (신규 + 기존 골든 전부 — `hostVars` optional이라 기존 `DEFAULTS` 호출 unchanged).

- [ ] **Step 5: 커밋**

```bash
git add ui/src/import/harToScenario.ts ui/src/import/__tests__/harToScenario.test.ts
git commit -m "feat(import): parameterizeUrl + ConvertOptions.hostVars (R9, R12)

매핑 호스트 origin을 \${변수}로 치환(와이어-형 유지). 미지정=byte-identical."
```

---

## Task 4: hostEnv.ts — 호스트→env 순수 헬퍼 (R8, R10, R11)

**Files:**
- Create: `ui/src/import/hostEnv.ts`
- Test: `ui/src/import/__tests__/hostEnv.test.ts`

**Interfaces:**
- Consumes: `PreviewEntry` (T1), `EnvironmentInput` (`../api/environments`).
- Produces:
  - `RESERVED: Set<string>` (`vu_id`/`iter_id`/`loop_index`)
  - `hostsByRequestCount(preview): string[]` — 요청 수 desc, 동률 first-seen.
  - `defaultHostVars(hosts: string[]): Record<string,string>` — `BASE_URL`, `BASE_URL_2`…
  - `originOf(host, preview): string` — first-seen origin.
  - `buildEnvInput(hostVars, preview, envName): EnvironmentInput`
  - `interface EnvValidation { ok; emptyHosts; dupNames; invalidHosts; reservedHosts; emptyEnvName }`
  - `validateEnv(hostVars, envName): EnvValidation` — `reservedHosts`는 `ok`에 영향 없음(soft).

- [ ] **Step 1: 실패 테스트 작성** — `ui/src/import/__tests__/hostEnv.test.ts` 생성:

```ts
import { describe, expect, it } from "vitest";
import type { PreviewEntry } from "../filters";
import {
  buildEnvInput,
  defaultHostVars,
  hostsByRequestCount,
  originOf,
  validateEnv,
} from "../hostEnv";

const preview: PreviewEntry[] = [
  { index: 0, method: "GET", url: "https://api.example.com/a" },
  { index: 1, method: "GET", url: "https://cdn.example.com/b" },
  { index: 2, method: "GET", url: "https://api.example.com/c" }, // api 2회
];

describe("hostEnv (R8/R10/R11)", () => {
  it("hostsByRequestCount: 요청 수 desc, 동률 first-seen", () => {
    expect(hostsByRequestCount(preview)).toEqual(["api.example.com", "cdn.example.com"]);
  });

  it("defaultHostVars: 첫 BASE_URL, 이후 BASE_URL_2…", () => {
    expect(defaultHostVars(["api.example.com", "cdn.example.com"])).toEqual({
      "api.example.com": "BASE_URL",
      "cdn.example.com": "BASE_URL_2",
    });
  });

  it("originOf: first-seen origin", () => {
    expect(originOf("api.example.com", preview)).toBe("https://api.example.com");
  });

  it("buildEnvInput: {name, vars:{변수명: origin}}", () => {
    const input = buildEnvInput(
      { "api.example.com": "BASE_URL", "cdn.example.com": "CDN" },
      preview,
      "  스테이징  ",
    );
    expect(input).toEqual({
      name: "스테이징",
      vars: { BASE_URL: "https://api.example.com", CDN: "https://cdn.example.com" },
    });
  });

  it("validateEnv: 정상이면 ok", () => {
    expect(validateEnv({ "a.com": "BASE_URL" }, "env").ok).toBe(true);
  });

  it("validateEnv: 빈/패턴위반/중복/빈환경이름이면 ok=false", () => {
    expect(validateEnv({ "a.com": "" }, "env").ok).toBe(false);
    expect(validateEnv({ "a.com": "1bad" }, "env").invalidHosts).toEqual(["a.com"]);
    expect(validateEnv({ "a.com": "X", "b.com": "X" }, "env").dupNames).toEqual(["X"]);
    expect(validateEnv({ "a.com": "BASE_URL" }, "   ").ok).toBe(false);
  });

  it("validateEnv: 예약어는 soft 경고지만 ok에 영향 없음", () => {
    const v = validateEnv({ "a.com": "vu_id" }, "env");
    expect(v.reservedHosts).toEqual(["a.com"]);
    expect(v.ok).toBe(true);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd ui && pnpm test hostEnv`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현** — `ui/src/import/hostEnv.ts` 생성:

```ts
import type { EnvironmentInput } from "../api/environments";
import type { PreviewEntry } from "./filters";

export const RESERVED = new Set(["vu_id", "iter_id", "loop_index"]);
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// previewEntries에 등장하는 호스트, 요청 수 desc·동률 first-seen.
export function hostsByRequestCount(preview: readonly PreviewEntry[]): string[] {
  const count = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  for (const p of preview) {
    let host: string;
    try {
      host = new URL(p.url).host;
    } catch {
      continue;
    }
    if (!firstSeen.has(host)) firstSeen.set(host, order++);
    count.set(host, (count.get(host) ?? 0) + 1);
  }
  return [...firstSeen.keys()].sort(
    (a, b) => (count.get(b)! - count.get(a)!) || (firstSeen.get(a)! - firstSeen.get(b)!),
  );
}

export function defaultHostVars(hosts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  hosts.forEach((h, i) => {
    out[h] = i === 0 ? "BASE_URL" : `BASE_URL_${i + 1}`;
  });
  return out;
}

export function originOf(host: string, preview: readonly PreviewEntry[]): string {
  for (const p of preview) {
    try {
      const u = new URL(p.url);
      if (u.host === host) return u.origin;
    } catch {
      // skip unparseable
    }
  }
  return "";
}

export function buildEnvInput(
  hostVars: Record<string, string>,
  preview: readonly PreviewEntry[],
  envName: string,
): EnvironmentInput {
  const vars: Record<string, string> = {};
  for (const [host, varName] of Object.entries(hostVars)) {
    vars[varName] = originOf(host, preview);
  }
  return { name: envName.trim(), vars };
}

export interface EnvValidation {
  ok: boolean;
  emptyHosts: string[];
  dupNames: string[];
  invalidHosts: string[];
  reservedHosts: string[];
  emptyEnvName: boolean;
}

export function validateEnv(hostVars: Record<string, string>, envName: string): EnvValidation {
  const entries = Object.entries(hostVars);
  const emptyHosts: string[] = [];
  const invalidHosts: string[] = [];
  const reservedHosts: string[] = [];
  const nameCount = new Map<string, number>();
  for (const [host, name] of entries) {
    const t = name.trim();
    if (t === "") emptyHosts.push(host);
    else if (!VAR_NAME_RE.test(t)) invalidHosts.push(host);
    else if (RESERVED.has(t)) reservedHosts.push(host);
    if (t !== "") nameCount.set(t, (nameCount.get(t) ?? 0) + 1);
  }
  const dupNames = [...nameCount.entries()].filter(([, c]) => c > 1).map(([n]) => n);
  const emptyEnvName = envName.trim() === "";
  const ok =
    entries.length > 0 &&
    emptyHosts.length === 0 &&
    invalidHosts.length === 0 &&
    dupNames.length === 0 &&
    !emptyEnvName;
  return { ok, emptyHosts, dupNames, invalidHosts, reservedHosts, emptyEnvName };
}
```

> `EnvironmentInput`은 `ui/src/api/environments.ts:29`에 `export type EnvironmentInput = { name: string; vars: Record<string,string> }`로 존재 — import 깊이는 `../api/environments`(테스트는 `../hostEnv`/`../filters`). (ui/CLAUDE.md "import type 깊이" 함정 주의.)

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm test hostEnv`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add ui/src/import/hostEnv.ts ui/src/import/__tests__/hostEnv.test.ts
git commit -m "feat(import): hostEnv 순수 헬퍼 — 변수명 도출·검증·env 입력 빌드 (R8/R10/R11)

예약어(vu_id 등)는 soft 경고(ok 불변), 빈/중복/패턴/빈환경이름은 ok=false."
```

---

## Task 5: ScenarioImportPage — 호스트→env 섹션 + 등록 배선 (R7–R11, R13)

**Files:**
- Modify: `ui/src/pages/ScenarioImportPage.tsx`
- Modify: `ui/src/i18n/ko.ts`
- Test: `ui/src/pages/__tests__/ScenarioImportPage.test.tsx`

**Interfaces:**
- Consumes: `hostsByRequestCount`/`defaultHostVars`/`buildEnvInput`/`validateEnv` (T4), `useCreateEnvironment` (`../api/hooks`).

- [ ] **Step 1: ko 키 추가** — `ko.ts` `import:` 블록에(Task 2 키 뒤):

```ts
    // 호스트→env (Task 5)
    hostToEnv: "호스트를 환경변수로 (선택)",
    hostToEnvHint: "호스트를 ${변수}로 바꾸기",
    varNameLabel: (host: string) => `${host} 변수명`,
    envNameLabel: "환경 이름",
    registerEnv: "환경으로 등록",
    envRegistered: (name: string) => `'${name}' 환경을 등록했습니다.`,
    varNameEmpty: "변수명을 입력하세요.",
    varNameDup: "변수명이 중복됩니다.",
    varNameInvalid: "변수명은 영문자·숫자·밑줄만 쓸 수 있고 숫자로 시작할 수 없습니다.",
    varNameReserved: (name: string) =>
      `'${name}'은(는) 예약어라 실행 시 시스템 값으로 채워집니다. 다른 이름을 권장합니다.`,
    envNameEmpty: "환경 이름을 입력하세요.",
```

> `hostToEnvHint`는 **쌍따옴표 문자열**이라 `${변수}`가 리터럴(템플릿 리터럴 아님 — 백틱 금지).

- [ ] **Step 2: 테스트 인프라 + 실패 테스트** — `ScenarioImportPage.test.tsx`.

(a) renderPage를 QueryClientProvider로 감싼다(페이지가 `useCreateEnvironment` 사용). import 추가 + `renderPage` 교체:
```ts
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// …
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/scenarios/import"]}>
        <Routes>
          <Route path="/scenarios/import" element={<ScenarioImportPage />} />
          <Route path="/scenarios/new" element={<div>NEW</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
```

(b) fetch stub helper(파일 상단, afterEach 부근):
```ts
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
```

(c) describe에 추가(단일 호스트 HAR fixture는 기존 `harFile()`의 `HAR`이 api+cdn 2호스트지만 cdn은 static로 제외됨 → preview엔 api만; 그래도 명시 단일-호스트 fixture를 둔다):
```ts
const SINGLE_HOST_HAR = JSON.stringify({
  log: { entries: [
    { request: { method: "GET", url: "https://api.example.com/users", headers: [] }, response: { status: 200 } },
  ] },
});

const TWO_HOST_HAR = JSON.stringify({
  log: { entries: [
    { request: { method: "GET", url: "https://api.example.com/users", headers: [] }, response: { status: 200 } },
    { request: { method: "GET", url: "https://auth.example.com/login", headers: [] }, response: { status: 200 } },
  ] },
});
```

```ts
  it("R7/R8: 단일 호스트 HAR에서 치환 켜면 BASE_URL 입력 1개", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(SINGLE_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    const varInput = screen.getByLabelText(ko.import.varNameLabel("api.example.com")) as HTMLInputElement;
    expect(varInput.value).toBe("BASE_URL");
  });

  it("R9: 치환 켜면 YAML url이 ${BASE_URL}/path", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(SINGLE_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    await waitFor(() =>
      expect((screen.getByLabelText(ko.import.preview) as HTMLTextAreaElement).value).toContain(
        "url: ${BASE_URL}/users",
      ),
    );
  });

  it("R8: 2-호스트면 변수명 2개(BASE_URL, BASE_URL_2)", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    expect((screen.getByLabelText(ko.import.varNameLabel("api.example.com")) as HTMLInputElement).value).toBe("BASE_URL");
    expect((screen.getByLabelText(ko.import.varNameLabel("auth.example.com")) as HTMLInputElement).value).toBe("BASE_URL_2");
  });

  it("R11: 빈 변수명이면 [환경으로 등록] 비활성 + 경고", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(SINGLE_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    const varInput = screen.getByLabelText(ko.import.varNameLabel("api.example.com"));
    await user.clear(varInput);
    expect(screen.getByRole("button", { name: ko.import.registerEnv })).toBeDisabled();
    expect(screen.getByText(ko.import.varNameEmpty)).toBeInTheDocument();
  });

  it("R11: 예약어(vu_id)면 soft 경고지만 등록은 활성", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(SINGLE_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    const varInput = screen.getByLabelText(ko.import.varNameLabel("api.example.com"));
    await user.clear(varInput);
    await user.type(varInput, "vu_id");
    expect(screen.getByText(ko.import.varNameReserved("vu_id"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.import.registerEnv })).toBeEnabled();
  });

  it("R10: [환경으로 등록] → POST /api/environments 페이로드 + 성공 표기", async () => {
    const user = userEvent.setup();
    let posted: unknown = null;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/environments") && init?.method === "POST") {
        posted = JSON.parse(String(init.body));
        return Promise.resolve(jsonResponse({ id: "E1", name: "api.example.com", vars: { BASE_URL: "https://api.example.com" }, created_at: 1, updated_at: 1 }, 201));
      }
      return Promise.resolve(jsonResponse({ environments: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(SINGLE_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    await user.click(screen.getByRole("button", { name: ko.import.registerEnv }));
    await waitFor(() => expect(posted).toEqual({ name: "api.example.com", vars: { BASE_URL: "https://api.example.com" } }));
    expect(await screen.findByText(ko.import.envRegistered("api.example.com"))).toBeInTheDocument();
  });

  it("R10: 409면 서버 메시지를 alert로", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/environments") && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ error: "같은 이름의 환경이 이미 있습니다" }, 409));
      }
      return Promise.resolve(jsonResponse({ environments: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(SINGLE_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    await user.click(screen.getByRole("button", { name: ko.import.registerEnv }));
    expect(await screen.findByRole("alert")).toHaveTextContent("같은 이름의 환경이 이미 있습니다");
  });
```

> 기본 envName = `inferName(parsed)` = single-host HAR엔 page title 없으니 첫 entry host `api.example.com`. 그래서 R10 페이로드 `name: "api.example.com"`.

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `cd ui && pnpm test ScenarioImportPage`
Expected: FAIL — env 섹션/등록 버튼 없음.

- [ ] **Step 4: 페이지 구현** — `ScenarioImportPage.tsx`.

(a) import 추가:
```ts
import { useCreateEnvironment } from "../api/hooks";
import { buildEnvInput, defaultHostVars, hostsByRequestCount, validateEnv } from "../import/hostEnv";
```

(b) 상태 + 파생(컴포넌트 본문, 기존 useState들 아래):
```ts
  const [hostVarsEnabled, setHostVarsEnabled] = useState(false);
  const [hostVarOverrides, setHostVarOverrides] = useState<Record<string, string>>({});
  const [envName, setEnvName] = useState("");
  const createEnv = useCreateEnvironment();

  const hostsOrdered = useMemo(() => hostsByRequestCount(previewEntries), [previewEntries]);
  const effectiveHostVars = useMemo(() => {
    const defaults = defaultHostVars(hostsOrdered);
    const out: Record<string, string> = {};
    for (const h of hostsOrdered) out[h] = hostVarOverrides[h] ?? defaults[h];
    return out;
  }, [hostsOrdered, hostVarOverrides]);
  const envValidation = useMemo(
    () => validateEnv(effectiveHostVars, envName),
    [effectiveHostVars, envName],
  );
```

(c) `yaml` 메모에 hostVars 추가:
```ts
  const yaml = useMemo(() => {
    if (!har) return "";
    return harToScenarioYaml(har, {
      headerMode,
      statusAssert,
      excludeStatic,
      includedHosts,
      excludedIndices,
      name,
      hostVars: hostVarsEnabled ? effectiveHostVars : undefined,
    });
  }, [har, headerMode, statusAssert, excludeStatic, includedHosts, excludedIndices, name, hostVarsEnabled, effectiveHostVars]);
```

(d) `onPick` 성공 분기에 리셋 추가(기존 `setExcludedIndices(new Set())` 옆):
```ts
      setHostVarsEnabled(false);
      setHostVarOverrides({});
      setEnvName(inferName(parsed));
```

(e) `registerEnv` 핸들러(다른 핸들러 옆):
```ts
  const registerEnv = () => {
    createEnv.mutate(buildEnvInput(effectiveHostVars, previewEntries, envName));
  };
```

(f) 호스트 fieldset과 요청 fieldset 사이(또는 요청 fieldset 뒤)에 새 섹션 — `previewEntries.length > 0`일 때:
```tsx
          {previewEntries.length > 0 && (
            <fieldset className="flex flex-col gap-2 rounded-md border border-slate-200 p-4 text-sm">
              <legend className="font-medium text-slate-700">{ko.import.hostToEnv}</legend>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={ko.import.hostToEnv}
                  checked={hostVarsEnabled}
                  onChange={(e) => setHostVarsEnabled(e.target.checked)}
                />
                {ko.import.hostToEnvHint}
              </label>
              {hostVarsEnabled && (
                <>
                  {hostsOrdered.map((h) => (
                    <label key={h} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600">{h}</span>
                      <span aria-hidden="true">→</span>
                      <input
                        aria-label={ko.import.varNameLabel(h)}
                        value={effectiveHostVars[h]}
                        onChange={(e) =>
                          setHostVarOverrides((p) => ({ ...p, [h]: e.target.value }))
                        }
                        className="w-40 rounded border border-slate-300 px-2 py-1 font-mono"
                      />
                    </label>
                  ))}
                  {envValidation.emptyHosts.length > 0 && (
                    <p className="text-xs text-red-600">{ko.import.varNameEmpty}</p>
                  )}
                  {envValidation.invalidHosts.length > 0 && (
                    <p className="text-xs text-red-600">{ko.import.varNameInvalid}</p>
                  )}
                  {envValidation.dupNames.length > 0 && (
                    <p className="text-xs text-red-600">{ko.import.varNameDup}</p>
                  )}
                  {envValidation.reservedHosts.map((h) => (
                    <p key={h} className="text-xs text-amber-700">
                      {ko.import.varNameReserved(effectiveHostVars[h])}
                    </p>
                  ))}
                  <label className="flex flex-col gap-1">
                    <span className="font-medium text-slate-700">{ko.import.envNameLabel}</span>
                    <input
                      aria-label={ko.import.envNameLabel}
                      value={envName}
                      onChange={(e) => setEnvName(e.target.value)}
                      className="rounded border border-slate-300 px-2 py-1"
                    />
                  </label>
                  {envValidation.emptyEnvName && (
                    <p className="text-xs text-red-600">{ko.import.envNameEmpty}</p>
                  )}
                  <div className="flex items-center gap-2">
                    <Button onClick={registerEnv} disabled={!envValidation.ok || createEnv.isPending}>
                      {createEnv.isPending ? ko.common.loading : ko.import.registerEnv}
                    </Button>
                    {createEnv.isSuccess && (
                      <span className="text-xs text-green-700">
                        {ko.import.envRegistered(createEnv.data.name)}
                      </span>
                    )}
                  </div>
                  {createEnv.isError && (
                    <p role="alert" className="text-xs text-red-600">
                      {(createEnv.error as Error).message}
                    </p>
                  )}
                </>
              )}
            </fieldset>
          )}
```

> `ko.common.loading`은 기존 키. `createEnv.data`는 `Environment`(`.name` 보유). `createEnv.error`는 `Error`(409 시 서버 `{error}` 메시지).

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd ui && pnpm test ScenarioImportPage`
Expected: PASS (기존 + 신규 전부).

- [ ] **Step 6: 커밋**

```bash
git add ui/src/pages/ScenarioImportPage.tsx ui/src/pages/__tests__/ScenarioImportPage.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(import): 호스트→환경변수 섹션 + 환경 등록 (R7-R11, R13)

옵트인 치환 + 호스트별 변수 매핑 + validateEnv 경고/예약어 soft 경고 + POST /api/environments."
```

---

## Task 6: R13 grep sweep + 전체 게이트

**Files:** (없음 — 검증 + 필요 시 ko 누락 수정)

- [ ] **Step 1: 인라인 문구 grep** — `ScenarioImportPage.tsx`에 ko를 안 거친 사용자-노출 리터럴이 없는지:

Run:
```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/har-import-ux
grep -nE '(aria-label|placeholder|title)="[^"]' ui/src/pages/ScenarioImportPage.tsx
grep -nE '(aria-label|title)=\{[^}]*"[A-Za-z]' ui/src/pages/ScenarioImportPage.tsx   # 삼항/보간 속성(ko-common 맹점)
grep -nE '>[A-Za-z가-힣][^<]*<' ui/src/pages/ScenarioImportPage.tsx | grep -v 'ko\.'
```
Expected: 사용자-노출 텍스트는 전부 `ko.import.*`/`ko.common.*` 경유(`{p.method} {p.url}` 같은 데이터·`aria-hidden` 장식 `→`는 예외). 누락 발견 시 ko로 옮기고 셀렉터 lockstep.

- [ ] **Step 2: 전체 게이트**

Run:
```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/har-import-ux/ui
pnpm lint && pnpm test && pnpm build
```
Expected: lint 0 warning, 전체 테스트 green, `tsc -b`+vite build 성공.

- [ ] **Step 3: (수정 있었으면) 커밋**

```bash
git add ui/
git commit -m "chore(import): R13 ko 잔존 문구 정리 + 전체 게이트 green"
```
> 1–2단계가 깨끗하면 이 태스크는 검증-only(커밋 없음).

---

## Self-Review (작성자 체크)

- **Spec 커버리지**: R1(전체선택 T2)·R2(전체해제 T2)·R3(중복해제 T2)·R4(요약 T2)·R5(배지 T2)·R6(dedup 헬퍼 T1)·R7(옵트인 T5)·R8(변수매핑 T4+T5)·R9(치환 T3)·R10(등록 T5)·R11(검증 T4+T5)·R12(byte-identical T3)·R13(grep T6). 전 R 매핑됨.
- **Placeholder**: 모든 step에 실제 코드/명령. TBD 없음.
- **타입 일관**: `PreviewEntry`(T1)를 T4·T5가 동일 사용. `ConvertOptions.hostVars?`(T3)·`EnvValidation`(T4) 시그니처 일관. `useCreateEnvironment`(`hooks.ts:286`)·`EnvironmentInput`(`environments.ts:29`) 실재.
- **함정 반영**: TDD 테스트-먼저(전 태스크)·`pnpm test <name>` 단일·머지 전 전체·QueryClientProvider(T5)·`hostToEnvHint` 쌍따옴표·예약어 soft(ok 불변).

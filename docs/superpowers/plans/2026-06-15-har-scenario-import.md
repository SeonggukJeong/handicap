# HAR → 시나리오 가져오기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 캡처된 HAR 파일을 handicap **와이어-형 시나리오 YAML**로 변환하는 클라이언트-온리 페이지(`/scenarios/import`)를 추가해, 복사하거나 편집기로 바로 보낼 수 있게 한다.

**Architecture:** 순수 변환 모듈(`src/import/`)이 HAR `log.entries[]`를 와이어-형 step 객체로 매핑하고 `yaml.stringify`로 직렬화한다(handicap의 `ScenarioModel`/`newStepId`/`parseScenarioDoc` 재사용 — 모델 fork 0). 그 위에 얇은 페이지(`ScenarioImportPage`)가 필터·옵션 UI를 얹고, "편집기로 보내기"는 라우터 state로 YAML을 `/scenarios/new`에 넘겨 기존 `chooseTemplate` 시드 경로를 재사용한다. 엔진·proto·migration·백엔드 라우트 변경 0.

**Tech Stack:** TypeScript · React 18 · Vite · React Router v6 · `yaml` ^2.6 · Zod ^3.23 · `ulid` · vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-06-15-har-scenario-import-design.md` (R-id 척추). 각 task는 인라인 acceptance에 충족 R-id를 단다.

**게이트 규칙 (전 task 공통):** UI-only. pre-commit이 `ui/`(non-`.md`) staged면 `pnpm lint && pnpm test && pnpm build`(UI 게이트)를 돌린다(cargo skip). `pnpm lint`는 `--max-warnings=0`이라 `react-hooks/exhaustive-deps` 경고도 실패 → effect deps를 정확히. 각 task는 **테스트 먼저**(tdd-guard: `ui/src/*` 편집 전 pending 테스트 파일 필요) + **단일 green 커밋**. 커밋 명령은 worktree 루트에서 실행하고 파이프 금지(루트 CLAUDE.md).

---

## File Structure

```
ui/src/import/
  filters.ts                         # HAR 1.2 타입 + 정적자산·호스트·선택 필터 (순수)        [신규]
  harToScenario.ts                   # parseHar + 와이어-형 변환 + inferName + YAML emit (순수) [신규]
  __tests__/filters.test.ts          # R5                                                       [신규]
  __tests__/harToScenario.test.ts    # R1·R2·R3·R4·R6·R7·R11·R12                                [신규]
ui/src/pages/
  ScenarioImportPage.tsx             # 페이지(드롭·필터·옵션·미리보기·복사·편집기로)            [신규]
  __tests__/ScenarioImportPage.test.tsx  # R4·R5·R6·R7·R10·R11 (UI) + R9 navigate              [신규]
  ScenarioNewPage.tsx                # ref-가드 import-시드 effect (R9 seam)                     [수정]
  ScenarioListPage.tsx               # "가져오기" 진입 버튼 (R8)                                 [수정]
ui/src/i18n/ko.ts                    # ko.import 네임스페이스                                    [수정]
ui/src/routes.tsx                    # /scenarios/import 라우트 (R8)                             [수정]
```

---

## Task 1: 변환 코어 (`src/import/filters.ts` + `harToScenario.ts`)

**Files:**
- Create: `ui/src/import/filters.ts`
- Create: `ui/src/import/harToScenario.ts`
- Test: `ui/src/import/__tests__/filters.test.ts`
- Test: `ui/src/import/__tests__/harToScenario.test.ts`

**충족 R:** R1·R2·R3·R4·R5·R6·R7·R11·R12.

- [ ] **Step 1: `filters.ts`의 테스트를 먼저 작성 (R5)**

Create `ui/src/import/__tests__/filters.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  type HarEntry,
  distinctHosts,
  entryHost,
  isStaticAsset,
  selectEntries,
} from "../filters";

function entry(url: string, mimeType = "application/json"): HarEntry {
  return {
    request: { method: "GET", url, headers: [] },
    response: { status: 200, content: { mimeType } },
  };
}

describe("filters", () => {
  it("isStaticAsset: 확장자 기준", () => {
    expect(isStaticAsset(entry("https://x.com/a.jpg"))).toBe(true);
    expect(isStaticAsset(entry("https://x.com/style.css?v=2"))).toBe(true);
    expect(isStaticAsset(entry("https://x.com/api/users"))).toBe(false);
  });

  it("isStaticAsset: 응답 content-type 기준", () => {
    expect(isStaticAsset(entry("https://x.com/img", "image/png"))).toBe(true);
    expect(isStaticAsset(entry("https://x.com/api", "application/json"))).toBe(false);
  });

  it("entryHost / distinctHosts: 순서 유지·중복 제거·파싱불가 null", () => {
    expect(entryHost(entry("https://a.com/x"))).toBe("a.com");
    expect(entryHost(entry("/relative"))).toBeNull();
    const hosts = distinctHosts([entry("https://a.com/1"), entry("https://b.com/2"), entry("https://a.com/3")]);
    expect(hosts).toEqual(["a.com", "b.com"]);
  });

  it("selectEntries: excludeStatic·includedHosts·excludedIndices 적용 + 순서 유지", () => {
    const entries = [
      entry("https://a.com/api/1"), // 0 keep
      entry("https://a.com/logo.png"), // 1 static
      entry("https://cdn.com/api/2"), // 2 host excluded
      entry("https://a.com/api/3"), // 3 index excluded
    ];
    const kept = selectEntries(entries, {
      excludeStatic: true,
      includedHosts: new Set(["a.com"]),
      excludedIndices: new Set([3]),
    });
    expect(kept.map((e) => e.request.url)).toEqual(["https://a.com/api/1"]);
  });

  it("selectEntries: includedHosts=null이면 모든 호스트(파싱불가 host 포함) 통과", () => {
    const entries = [entry("https://a.com/api"), entry("/relative")];
    const kept = selectEntries(entries, {
      excludeStatic: false,
      includedHosts: null,
      excludedIndices: new Set(),
    });
    expect(kept).toHaveLength(2);
  });

  it("selectEntries: includedHosts가 Set이어도 파싱불가(null host) 요청은 통과(미리보기와 일치)", () => {
    const entries = [entry("https://a.com/api"), entry("/relative")];
    const kept = selectEntries(entries, {
      excludeStatic: false,
      includedHosts: new Set(["a.com"]),
      excludedIndices: new Set(),
    });
    expect(kept).toHaveLength(2); // a.com + null-host 둘 다 keep
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd ui && pnpm test filters`
Expected: FAIL — `Failed to resolve import "../filters"` (모듈 없음).

- [ ] **Step 3: `filters.ts` 구현**

Create `ui/src/import/filters.ts`:

```ts
// HAR 1.2 (필요한 부분만). request.headers / postData.params는 배열이다.
export interface HarHeader {
  name: string;
  value: string;
}
export interface HarPostParam {
  name: string;
  value?: string;
}
export interface HarPostData {
  mimeType?: string;
  text?: string;
  params?: HarPostParam[];
}
export interface HarRequest {
  method: string;
  url: string;
  headers?: HarHeader[];
  postData?: HarPostData;
}
export interface HarResponse {
  status?: number;
  content?: { mimeType?: string };
}
export interface HarEntry {
  request: HarRequest;
  response?: HarResponse;
}
export interface HarPage {
  title?: string;
}
export interface Har {
  log: { entries: HarEntry[]; pages?: HarPage[] };
}

// 정적 리소스: 확장자 또는 응답 content-type.
const STATIC_EXT =
  /\.(jpe?g|png|gif|webp|svg|ico|bmp|css|m?js|woff2?|ttf|otf|eot|map|mp4|webm|mp3|wav|pdf)(\?|#|$)/i;
const STATIC_CT = /^(image\/|font\/|video\/|audio\/|text\/css|application\/javascript|text\/javascript)/i;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function isStaticAsset(entry: HarEntry): boolean {
  if (STATIC_EXT.test(pathOf(entry.request.url))) return true;
  return STATIC_CT.test(entry.response?.content?.mimeType ?? "");
}

export function entryHost(entry: HarEntry): string | null {
  try {
    return new URL(entry.request.url).host;
  } catch {
    return null;
  }
}

export function distinctHosts(entries: HarEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    const h = entryHost(e);
    if (h && !seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
  }
  return out;
}

export interface SelectOptions {
  excludeStatic: boolean;
  includedHosts: ReadonlySet<string> | null; // null = 모든 호스트
  excludedIndices: ReadonlySet<number>; // har.log.entries 기준 인덱스
}

export function selectEntries(entries: HarEntry[], opts: SelectOptions): HarEntry[] {
  return entries.filter((e, i) => {
    if (opts.excludedIndices.has(i)) return false;
    if (opts.excludeStatic && isStaticAsset(e)) return false;
    if (opts.includedHosts) {
      const h = entryHost(e);
      // 파싱불가(상대) URL = null host는 호스트 체크박스로 못 거르므로 항상 통과(미리보기와 일치).
      // 요청별 체크박스(excludedIndices)로만 제외 가능.
      if (h !== null && !opts.includedHosts.has(h)) return false;
    }
    return true;
  });
}
```

- [ ] **Step 4: filters 테스트 통과 확인**

Run: `cd ui && pnpm test filters`
Expected: PASS (5 tests).

- [ ] **Step 5: `harToScenario.ts`의 테스트 작성 (R1·R2·R3·R4·R6·R7·R11)**

Create `ui/src/import/__tests__/harToScenario.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseScenarioDoc } from "../../scenario/yamlDoc";
import type { Har } from "../filters";
import { type ConvertOptions, harToScenarioYaml, inferName, parseHar } from "../harToScenario";

const DEFAULTS: ConvertOptions = {
  excludeStatic: false,
  includedHosts: null,
  excludedIndices: new Set(),
  headerMode: "all",
  statusAssert: false,
  name: "Imported scenario",
};

function har(entries: Har["log"]["entries"], pages?: Har["log"]["pages"]): Har {
  return { log: { entries, pages } };
}

function getEntry(): Har["log"]["entries"][number] {
  return {
    request: {
      method: "GET",
      url: "https://api.example.com/users?page=1",
      headers: [
        { name: "accept", value: "application/json" },
        { name: "host", value: "api.example.com" },
        { name: ":authority", value: "api.example.com" },
      ],
    },
    response: { status: 200, content: { mimeType: "application/json" } },
  };
}

function jsonPostEntry(bodyText: string): Har["log"]["entries"][number] {
  return {
    request: {
      method: "POST",
      url: "https://api.example.com/login",
      headers: [{ name: "content-type", value: "application/json" }],
      postData: { mimeType: "application/json", text: bodyText },
    },
    response: { status: 201, content: { mimeType: "application/json" } },
  };
}

describe("harToScenarioYaml", () => {
  it("R1: 캡처 순서 step 목록 + name='METHOD path' + ULID id", () => {
    const yaml = harToScenarioYaml(har([getEntry()]), DEFAULTS);
    const r = parseScenarioDoc(yaml);
    expect("model" in r).toBe(true);
    if (!("model" in r)) return;
    const step = r.model.steps[0];
    expect(step.name).toBe("GET /users");
    expect(step.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(step.type).toBe("http");
  });

  it("R2: 출력은 와이어-형 (parseScenarioDoc 통과 + body 'json:'/assert '- status:' 리터럴)", () => {
    const yaml = harToScenarioYaml(har([jsonPostEntry('{"u":"a"}')]), { ...DEFAULTS, statusAssert: true });
    // 파싱 성공
    const r = parseScenarioDoc(yaml);
    expect("model" in r).toBe(true);
    // 와이어 구조 리터럴 (모델-형 {kind,value}/{kind,code}였다면 false-green이므로 직접 확인)
    expect(yaml).toMatch(/body:\s*\n\s*json:/);
    expect(yaml).toMatch(/assert:\s*\n\s*- status:/);
    expect(yaml).not.toContain("kind:");
  });

  it("R3: body 매핑 — json / json-cast-literal→raw / form-params / form-text / raw / none", () => {
    // json
    expect(harToScenarioYaml(har([jsonPostEntry('{"a":1}')]), DEFAULTS)).toMatch(/json:/);
    // json이지만 미지원 cast keyword(:int) 리터럴 → raw 폴백.
    // (표준 {{x:num}}/{{x:str}}/{{x:bool}} 단독값은 jsonBodyCastErrors가 유효로 봐 안 걸린다 — :int은 미지원이라 걸림)
    const castY = harToScenarioYaml(har([jsonPostEntry('{"t":"{{x:int}}"}')]), DEFAULTS);
    expect(castY).toMatch(/raw:/);
    expect(parseScenarioDoc(castY)).toHaveProperty("model"); // raw라 cast 검증 안 탐
    // form from params
    const formParams: Har = har([
      {
        request: {
          method: "POST",
          url: "https://x.com/f",
          headers: [],
          postData: {
            mimeType: "application/x-www-form-urlencoded",
            params: [{ name: "a", value: "1" }],
          },
        },
      },
    ]);
    expect(harToScenarioYaml(formParams, DEFAULTS)).toMatch(/form:/);
    // form from text (no params)
    const formText: Har = har([
      {
        request: {
          method: "POST",
          url: "https://x.com/f",
          headers: [],
          postData: { mimeType: "application/x-www-form-urlencoded", text: "a=1&b=2" },
        },
      },
    ]);
    const ft = harToScenarioYaml(formText, DEFAULTS);
    expect(ft).toMatch(/form:/);
    expect(ft).toContain("a:");
    // raw (text/plain)
    const rawE: Har = har([
      {
        request: {
          method: "POST",
          url: "https://x.com/r",
          headers: [],
          postData: { mimeType: "text/plain", text: "hello" },
        },
      },
    ]);
    expect(harToScenarioYaml(rawE, DEFAULTS)).toMatch(/raw:/);
    // none (GET, no postData) → body 키 없음
    expect(harToScenarioYaml(har([getEntry()]), DEFAULTS)).not.toMatch(/body:/);
  });

  it("R4: 헤더 모드 — all 유지 / strip-volatile / semantic-only, :의사헤더는 전모드 제거", () => {
    const all = parseScenarioDoc(harToScenarioYaml(har([getEntry()]), { ...DEFAULTS, headerMode: "all" }));
    if ("model" in all) {
      expect(all.model.steps[0].request.headers).toHaveProperty("accept");
      expect(all.model.steps[0].request.headers).toHaveProperty("host");
      expect(all.model.steps[0].request.headers).not.toHaveProperty(":authority"); // 전모드 제거
    }
    const strip = parseScenarioDoc(harToScenarioYaml(har([getEntry()]), { ...DEFAULTS, headerMode: "strip-volatile" }));
    if ("model" in strip) {
      expect(strip.model.steps[0].request.headers).not.toHaveProperty("host");
      expect(strip.model.steps[0].request.headers).toHaveProperty("accept");
    }
    const sem = parseScenarioDoc(harToScenarioYaml(har([getEntry()]), { ...DEFAULTS, headerMode: "semantic-only" }));
    if ("model" in sem) {
      expect(sem.model.steps[0].request.headers).toHaveProperty("accept");
      expect(sem.model.steps[0].request.headers).not.toHaveProperty("host");
    }
  });

  it("R6: statusAssert on→[{status}], off→[]", () => {
    const on = parseScenarioDoc(harToScenarioYaml(har([getEntry()]), { ...DEFAULTS, statusAssert: true }));
    if ("model" in on) expect(on.model.steps[0].assert).toEqual([{ kind: "status", code: 200 }]);
    const off = parseScenarioDoc(harToScenarioYaml(har([getEntry()]), DEFAULTS));
    if ("model" in off) expect(off.model.steps[0].assert).toEqual([]);
  });

  it("R1 폴백: 상대 URL이어도 크래시 없이 name=url 원문", () => {
    const rel: Har = har([{ request: { method: "GET", url: "/relative/path", headers: [] } }]);
    const yaml = harToScenarioYaml(rel, DEFAULTS);
    expect(yaml).toContain("GET /relative/path");
  });

  it("R7: inferName — page title > 첫 호스트 > 폴백", () => {
    expect(inferName(har([getEntry()], [{ title: "  쇼핑 흐름  " }]))).toBe("쇼핑 흐름");
    expect(inferName(har([getEntry()]))).toBe("api.example.com");
    expect(inferName(har([{ request: { method: "GET", url: "/rel", headers: [] } }]))).toBe("Imported scenario");
  });

  it("R11: parseHar — 깨진 JSON·빈 entries는 throw", () => {
    expect(() => parseHar("{not json")).toThrow();
    expect(() => parseHar(JSON.stringify({ log: { entries: [] } }))).toThrow();
    expect(parseHar(JSON.stringify(har([getEntry()]))).log.entries).toHaveLength(1);
  });
});
```

- [ ] **Step 6: 테스트가 실패하는지 확인**

Run: `cd ui && pnpm test harToScenario`
Expected: FAIL — `Failed to resolve import "../harToScenario"`.

- [ ] **Step 7: `harToScenario.ts` 구현**

Create `ui/src/import/harToScenario.ts`:

```ts
import { stringify } from "yaml";
import { jsonBodyCastErrors } from "../scenario/cast";
import { newStepId } from "../scenario/ulid";
import {
  type Har,
  type HarEntry,
  type HarPostData,
  type SelectOptions,
  selectEntries,
} from "./filters";

export type HeaderMode = "all" | "strip-volatile" | "semantic-only";

export interface ConvertOptions extends SelectOptions {
  headerMode: HeaderMode;
  statusAssert: boolean;
  name: string;
}

const VOLATILE = new Set([
  "host",
  "content-length",
  "connection",
  "accept-encoding",
  "proxy-connection",
]);

function isSemantic(lower: string): boolean {
  return (
    lower === "content-type" ||
    lower === "authorization" ||
    lower === "accept" ||
    lower.startsWith("x-")
  );
}

// HAR headers 배열 → wire map (중복 키 last-wins). :의사헤더는 전 모드 제거.
function foldHeaders(headers: HarEntry["request"]["headers"], mode: HeaderMode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    if (h.name.startsWith(":")) continue; // HTTP/2 pseudo-header — 전송 불가
    const lower = h.name.toLowerCase();
    if (mode === "strip-volatile" && VOLATILE.has(lower)) continue;
    if (mode === "semantic-only" && !isSemantic(lower)) continue;
    out[h.name] = h.value; // last-wins
  }
  return out;
}

function formRecord(post: HarPostData): Record<string, string> {
  const rec: Record<string, string> = {};
  if (post.params && post.params.length > 0) {
    for (const p of post.params) rec[p.name] = p.value ?? ""; // last-wins
    return rec;
  }
  for (const [k, v] of new URLSearchParams(post.text ?? "")) rec[k] = v;
  return rec;
}

// 와이어-형 body: {json|form|raw: value}. 모델-형(kind/value) 금지.
function wireBody(post: HarPostData | undefined): Record<string, unknown> | undefined {
  if (!post) return undefined;
  const mime = (post.mimeType ?? "").toLowerCase();
  const text = post.text ?? "";
  if (mime.includes("x-www-form-urlencoded")) return { form: formRecord(post) };
  if (mime.includes("json")) {
    try {
      const parsed: unknown = JSON.parse(text);
      // 미지원 cast keyword({{x:int}})·env-cast(${X:num})·혼합 리터럴이 있으면 BodyModel.superRefine이
      // 거부 → raw 폴백. (표준 {{x:num}}/{{x:str}}/{{x:bool}} 단독값은 유효라 안 걸려 json 유지)
      if (jsonBodyCastErrors(parsed).length === 0) return { json: parsed };
      return { raw: text };
    } catch {
      return { raw: text };
    }
  }
  return text.length > 0 ? { raw: text } : undefined;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function wireStep(entry: HarEntry, opts: ConvertOptions): Record<string, unknown> {
  const method = entry.request.method.toUpperCase();
  const url = entry.request.url;
  const request: Record<string, unknown> = {
    method,
    url,
    headers: foldHeaders(entry.request.headers, opts.headerMode),
  };
  const body = wireBody(entry.request.postData);
  if (body) request.body = body;
  const status = entry.response?.status;
  const assert = opts.statusAssert && typeof status === "number" ? [{ status }] : [];
  return { id: newStepId(), name: `${method} ${pathOf(url)}`, type: "http", request, assert, extract: [] };
}

export function parseHar(text: string): Har {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 파싱 실패: ${(e as Error).message}`);
  }
  const log = (json as { log?: { entries?: unknown } }).log;
  if (!log || !Array.isArray(log.entries)) throw new Error("log.entries 배열이 없습니다");
  if (log.entries.length === 0) throw new Error("HAR에 요청이 없습니다");
  return json as Har;
}

export function inferName(har: Har): string {
  const title = har.log.pages?.find((p) => p.title && p.title.trim())?.title?.trim();
  if (title) return title;
  for (const e of har.log.entries) {
    try {
      return new URL(e.request.url).host;
    } catch {
      // 파싱불가 URL은 건너뛰고 다음 entry
    }
  }
  return "Imported scenario";
}

export function harToScenarioYaml(har: Har, opts: ConvertOptions): string {
  const steps = selectEntries(har.log.entries, opts).map((e) => wireStep(e, opts));
  return stringify({ version: 1, name: opts.name, cookie_jar: "auto", variables: {}, steps });
}
```

- [ ] **Step 8: 전체 변환 테스트 통과 확인**

Run: `cd ui && pnpm test harToScenario filters`
Expected: PASS (filters 5 + harToScenario 8).

- [ ] **Step 9: 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm build`
Expected: 둘 다 통과(에러·경고 0).

```bash
git add ui/src/import
git commit -m "feat(ui): HAR→시나리오 와이어-YAML 변환 코어 (R1-R7,R11,R12)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

`git log -1`로 landed 확인(파이프 금지).

---

## Task 2: 가져오기 페이지 (`ScenarioImportPage.tsx` + `ko.import`)

**Files:**
- Modify: `ui/src/i18n/ko.ts` (`ko.import` 네임스페이스 추가 — 기존 객체 끝에)
- Create: `ui/src/pages/ScenarioImportPage.tsx`
- Test: `ui/src/pages/__tests__/ScenarioImportPage.test.tsx`

**충족 R:** R4(UI)·R5(UI)·R6(UI)·R7(UI)·R10·R11(UI). (R8 라우트·R9 핸드오프는 Task 3.)

- [ ] **Step 1: `ko.import` 카탈로그 추가**

Modify `ui/src/i18n/ko.ts` — 최상위 `export const ko = { ... }` 객체 안 임의 위치(끝 권장)에 새 키 `import` 추가. `import`는 객체 프로퍼티명으로 합법(예약어지만 멤버 접근/프로퍼티명은 허용):

```ts
  import: {
    title: "가져오기",
    intro:
      "캡처한 HAR 파일을 올리면 요청을 시나리오 스텝으로 변환합니다. (HTTP Toolkit·브라우저 DevTools 등에서 HAR로 내보내세요.)",
    chooseFile: "HAR 파일 선택",
    parseError: "HAR을 읽지 못했습니다",
    nameLabel: "시나리오 이름",
    excludeStatic: "정적 리소스(이미지·CSS·JS 등) 제외",
    headerMode: "헤더 처리",
    headerModeAll: "전부 유지",
    headerModeStrip: "자동·휘발성 헤더 제거",
    headerModeSemantic: "의미 헤더만",
    statusAssert: "캡처된 응답 상태코드로 검증(assert) 추가",
    hosts: "호스트",
    requests: "요청",
    preview: "변환된 시나리오 YAML",
    copy: "복사",
    toEditor: "편집기로 보내기",
  },
```

- [ ] **Step 2: 페이지 테스트 작성 (R4·R5·R6·R7·R10·R11)**

Create `ui/src/pages/__tests__/ScenarioImportPage.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScenarioImportPage } from "../ScenarioImportPage";
import { ko } from "../../i18n/ko";

const HAR = JSON.stringify({
  log: {
    pages: [{ title: "쇼핑 흐름" }],
    entries: [
      {
        request: { method: "GET", url: "https://api.example.com/users", headers: [{ name: "accept", value: "application/json" }] },
        response: { status: 200, content: { mimeType: "application/json" } },
      },
      {
        request: { method: "GET", url: "https://cdn.example.com/logo.png", headers: [] },
        response: { status: 200, content: { mimeType: "image/png" } },
      },
    ],
  },
});

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/scenarios/import"]}>
      <Routes>
        <Route path="/scenarios/import" element={<ScenarioImportPage />} />
        <Route path="/scenarios/new" element={<div>NEW</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function harFile(content = HAR): File {
  return new File([content], "flow.har", { type: "application/json" });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ScenarioImportPage", () => {
  it("R7: HAR 업로드 시 이름이 page title로 프리필되고 미리보기에 step이 뜬다", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile());
    const nameInput = await screen.findByLabelText(ko.import.nameLabel);
    await waitFor(() => expect((nameInput as HTMLInputElement).value).toBe("쇼핑 흐름"));
    const preview = screen.getByLabelText(ko.import.preview) as HTMLTextAreaElement;
    expect(preview.value).toContain("GET /users");
  });

  it("R5: 정적 리소스 제외(기본 ON)면 .png 요청이 미리보기에서 빠진다", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile());
    const preview = (await screen.findByLabelText(ko.import.preview)) as HTMLTextAreaElement;
    expect(preview.value).not.toContain("logo.png");
    // 토글 끄면 .png 포함
    await user.click(screen.getByLabelText(ko.import.excludeStatic));
    await waitFor(() => expect((screen.getByLabelText(ko.import.preview) as HTMLTextAreaElement).value).toContain("logo.png"));
  });

  it("R6: status assert 토글 시 미리보기에 status가 등장", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile());
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.statusAssert));
    await waitFor(() => expect((screen.getByLabelText(ko.import.preview) as HTMLTextAreaElement).value).toMatch(/- status:/));
  });

  it("R10: 복사 버튼이 클립보드에 YAML을 쓴다", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile());
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByRole("button", { name: ko.import.copy }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("GET /users"));
  });

  it("R11: 깨진 HAR이면 alert를 보여주고 크래시하지 않는다", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile("{not json"));
    expect(await screen.findByRole("alert")).toHaveTextContent(ko.import.parseError);
  });
});
```

> 참고: `navigator.clipboard` 모킹은 `userEvent.setup()` *뒤*에 두면 setup이 덮어쓴다(C-2 함정) — 위 테스트는 `setup()`이 각 it 안에서 먼저 호출되고 모킹은 클립보드 it에서 그 뒤에 설치된다. 순서를 지킬 것. `navigator.clipboard`는 `afterEach`의 `restoreAllMocks`로는 안 지워지므로, 다른 it에 영향 없도록 클립보드 it 안에서만 설치(`configurable: true`).

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd ui && pnpm test ScenarioImportPage`
Expected: FAIL — `Failed to resolve import "../ScenarioImportPage"`.

- [ ] **Step 4: `ScenarioImportPage.tsx` 구현**

Create `ui/src/pages/ScenarioImportPage.tsx`:

```tsx
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Breadcrumb } from "../components/Breadcrumb";
import { Button } from "../components/Button";
import { ko } from "../i18n/ko";
import { type Har, distinctHosts, entryHost, isStaticAsset } from "../import/filters";
import { type HeaderMode, harToScenarioYaml, inferName, parseHar } from "../import/harToScenario";

// jsdom의 File에는 Blob.text()가 없어 `await file.text()`가 throw한다(브라우저엔 있음).
// FileReader는 jsdom·브라우저 양쪽에서 동작 — 이 read가 기능 전체의 load-bearing I/O.
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsText(file);
  });
}

export function ScenarioImportPage() {
  const navigate = useNavigate();
  const [har, setHar] = useState<Har | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [headerMode, setHeaderMode] = useState<HeaderMode>("all");
  const [statusAssert, setStatusAssert] = useState(false);
  const [excludeStatic, setExcludeStatic] = useState(true);
  const [excludedHosts, setExcludedHosts] = useState<ReadonlySet<string>>(new Set());
  const [excludedIndices, setExcludedIndices] = useState<ReadonlySet<number>>(new Set());

  const hosts = useMemo(() => (har ? distinctHosts(har.log.entries) : []), [har]);
  const includedHosts = useMemo<ReadonlySet<string> | null>(
    () => (excludedHosts.size === 0 ? null : new Set(hosts.filter((h) => !excludedHosts.has(h)))),
    [hosts, excludedHosts],
  );

  // 미리보기 목록: static/host 필터 적용 후(요청별 체크박스 대상). 원본 인덱스 유지.
  const previewEntries = useMemo(() => {
    if (!har) return [] as { url: string; method: string; index: number }[];
    return har.log.entries
      .map((e, index) => ({ e, index }))
      .filter(({ e }) => !(excludeStatic && isStaticAsset(e)))
      .filter(({ e }) => {
        const h = entryHost(e);
        return h === null || !excludedHosts.has(h);
      })
      .map(({ e, index }) => ({ url: e.request.url, method: e.request.method, index }));
  }, [har, excludeStatic, excludedHosts]);

  const yaml = useMemo(() => {
    if (!har) return "";
    return harToScenarioYaml(har, { headerMode, statusAssert, excludeStatic, includedHosts, excludedIndices, name });
  }, [har, headerMode, statusAssert, excludeStatic, includedHosts, excludedIndices, name]);

  const onPick = async (file: File | null) => {
    if (!file) return;
    try {
      const parsed = parseHar(await readText(file));
      setHar(parsed);
      setParseError(null);
      setName(inferName(parsed));
      setExcludedHosts(new Set());
      setExcludedIndices(new Set());
    } catch (e) {
      setHar(null);
      setParseError((e as Error).message);
    }
  };

  const toggleHost = (host: string, checked: boolean) => {
    setExcludedHosts((prev) => {
      const next = new Set(prev);
      if (checked) next.delete(host);
      else next.add(host);
      return next;
    });
  };
  const toggleIndex = (index: number, checked: boolean) => {
    setExcludedIndices((prev) => {
      const next = new Set(prev);
      if (checked) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={[{ label: ko.nav.scenarios, to: "/" }, { label: ko.import.title }]} />
      <h2 className="text-xl font-semibold">{ko.import.title}</h2>
      <p className="text-sm text-slate-500">{ko.import.intro}</p>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-slate-700">{ko.import.chooseFile}</span>
        <input
          type="file"
          accept=".har,application/json"
          onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
        />
      </label>

      {parseError && (
        <p role="alert" className="text-sm text-red-600">
          {ko.import.parseError}: {parseError}
        </p>
      )}

      {har && (
        <>
          <fieldset className="flex flex-col gap-3 rounded-md border border-slate-200 p-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700">{ko.import.nameLabel}</span>
              <input
                aria-label={ko.import.nameLabel}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="rounded border border-slate-300 px-2 py-1"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={excludeStatic} onChange={(e) => setExcludeStatic(e.target.checked)} />
              {ko.import.excludeStatic}
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700">{ko.import.headerMode}</span>
              <select
                aria-label={ko.import.headerMode}
                value={headerMode}
                onChange={(e) => setHeaderMode(e.target.value as HeaderMode)}
                className="rounded border border-slate-300 px-2 py-1"
              >
                <option value="all">{ko.import.headerModeAll}</option>
                <option value="strip-volatile">{ko.import.headerModeStrip}</option>
                <option value="semantic-only">{ko.import.headerModeSemantic}</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={statusAssert} onChange={(e) => setStatusAssert(e.target.checked)} />
              {ko.import.statusAssert}
            </label>
          </fieldset>

          {hosts.length > 1 && (
            <fieldset className="flex flex-col gap-1 rounded-md border border-slate-200 p-4 text-sm">
              <legend className="font-medium text-slate-700">{ko.import.hosts}</legend>
              {hosts.map((h) => (
                <label key={h} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={h}
                    checked={!excludedHosts.has(h)}
                    onChange={(e) => toggleHost(h, e.target.checked)}
                  />
                  {h}
                </label>
              ))}
            </fieldset>
          )}

          <fieldset className="flex flex-col gap-1 rounded-md border border-slate-200 p-4 text-sm">
            <legend className="font-medium text-slate-700">{ko.import.requests}</legend>
            <ul className="flex flex-col gap-1">
              {previewEntries.map((p) => (
                <li key={p.index}>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label={`${p.method} ${p.url}`}
                      checked={!excludedIndices.has(p.index)}
                      onChange={(e) => toggleIndex(p.index, e.target.checked)}
                    />
                    <span className="truncate">
                      {p.method} {p.url}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">{ko.import.preview}</span>
            <textarea
              aria-label={ko.import.preview}
              readOnly
              value={yaml}
              rows={16}
              className="rounded border border-slate-300 p-2 font-mono text-xs"
            />
          </label>

          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(yaml)}>
              {ko.import.copy}
            </Button>
            <Button onClick={() => navigate("/scenarios/new", { state: { importedYaml: yaml } })}>
              {ko.import.toEditor}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
```

> **파일 읽기는 `readText`(FileReader)로** — 이 워크트리의 jsdom은 `File.prototype.text()`를 구현하지 않아 `await file.text()`가 throw한다(plan 리뷰에서 실측 확인). FileReader는 jsdom·브라우저 양쪽 동작. 테스트의 `user.upload`는 `UploadPanel`과 같은 *제스처*지만, UploadPanel은 바이트를 서버로 multipart 전송할 뿐 클라이언트에서 안 읽으므로 read 경로의 선례가 아니다 — `readText`가 load-bearing.

- [ ] **Step 5: 페이지 테스트 통과 확인**

Run: `cd ui && pnpm test ScenarioImportPage`
Expected: PASS (5 tests).

- [ ] **Step 6: 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm build`
Expected: 통과(경고 0).

```bash
git add ui/src/pages/ScenarioImportPage.tsx ui/src/pages/__tests__/ScenarioImportPage.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): HAR 가져오기 페이지 (필터·옵션·미리보기·복사, R4-R7,R10,R11)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

`git log -1` 확인.

---

## Task 3: 라우트 · 진입 버튼 · 편집기 핸드오프 (R8·R9)

**Files:**
- Modify: `ui/src/routes.tsx` (라우트 추가)
- Modify: `ui/src/pages/ScenarioListPage.tsx` ("가져오기" 버튼)
- Modify: `ui/src/pages/ScenarioNewPage.tsx` (ref-가드 import-시드 effect)
- Test: `ui/src/pages/__tests__/ScenarioImportPage.test.tsx` (R9 navigate 케이스 추가)
- Test: `ui/src/pages/__tests__/ScenarioNewPage.import.test.tsx` (신규 — R9 시드 + 회귀)

**충족 R:** R8·R9.

- [ ] **Step 1: R9 시드 테스트 + 회귀 테스트 작성**

Create `ui/src/pages/__tests__/ScenarioNewPage.import.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioNewPage } from "../ScenarioNewPage";
import { ko } from "../../i18n/ko";

// 스토어 reset 불필요: import-시드 테스트는 chooseTemplate→loadFromString이 store를
// 새로 덮어쓰고, 회귀 테스트는 갤러리 게이트(로컬 state seedYaml===null)라 store 내용과 무관.
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string | URL) =>
    Promise.resolve(
      new Response(JSON.stringify(String(url).endsWith("/api/environments") ? { environments: [] } : {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const IMPORTED = "version: 1\nname: 가져온 흐름\ncookie_jar: auto\nvariables: {}\nsteps:\n  - id: 01HX00000000000000000000ZZ\n    name: GET /users\n    type: http\n    request:\n      method: GET\n      url: https://api.example.com/users\n      headers: {}\n    assert: []\n    extract: []\n";

function renderWith(state: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[{ pathname: "/scenarios/new", state }]}>
        <Routes>
          <Route path="/scenarios/new" element={<ScenarioNewPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScenarioNewPage import 핸드오프 (R9)", () => {
  it("location.state.importedYaml이 있으면 갤러리를 건너뛰고 그 YAML로 에디터를 시드한다", async () => {
    renderWith({ importedYaml: IMPORTED });
    // 갤러리(템플릿 카드) 대신 에디터가 뜬다 — 시드된 step 이름이 캔버스 노드로
    expect(await screen.findByText("GET /users")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.create })).toBeInTheDocument();
    // 갤러리 region은 없다
    expect(screen.queryByRole("region", { name: ko.templates.galleryAria })).not.toBeInTheDocument();
  });

  it("회귀: state가 없으면 기존 템플릿 갤러리를 보여준다", async () => {
    renderWith(undefined);
    expect(await screen.findByRole("region", { name: ko.templates.galleryAria })).toBeInTheDocument();
  });
});
```

R9 navigate 케이스를 `ScenarioImportPage.test.tsx`에 추가(파일 끝 describe 안):

```tsx
  it("R9: 편집기로 보내기 → /scenarios/new로 navigate", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile());
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByRole("button", { name: ko.import.toEditor }));
    expect(await screen.findByText("NEW")).toBeInTheDocument();
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test ScenarioNewPage.import`
Expected: FAIL — `location.state.importedYaml`을 안 읽어 갤러리가 떠서 `findByText("GET /users")` 실패.

- [ ] **Step 3: `ScenarioNewPage.tsx`에 ref-가드 import-시드 effect 추가**

Modify `ui/src/pages/ScenarioNewPage.tsx`:

1. import 라인에 `useEffect`, `useLocation` 추가:
```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
```

2. 기존 `chooseTemplate`(plain 함수)을 `useCallback`으로 변환(setState 세터는 안정 → deps `[]`; exhaustive-deps 만족):
```ts
  const chooseTemplate = useCallback((yaml: string) => {
    useScenarioEditor.getState().loadFromString(yaml);
    const canonical = useScenarioEditor.getState().yamlText;
    setSeedYaml(yaml);
    setYamlText(canonical);
    setOriginalYaml(canonical);
  }, []);
```

3. 컴포넌트 본문 상단(`testRunRef` 선언 부근)에 import 시드 effect 추가:
```ts
  const location = useLocation();
  const importedYaml = (location.state as { importedYaml?: string } | null)?.importedYaml;
  const didImportSeed = useRef(false);
  useEffect(() => {
    if (importedYaml && !didImportSeed.current) {
      didImportSeed.current = true;
      chooseTemplate(importedYaml); // 갤러리 게이트(seedYaml===null)가 editor mount를 store 적재 뒤로 미룸
    }
  }, [importedYaml, chooseTemplate]);
```

> render-phase / `useState` lazy-init에 `loadFromString`를 넣지 말 것(StrictMode 이중호출 + render 부작용). `didImportSeed` ref가 StrictMode 이중-effect를 1회로 가드한다. `location.state`가 없으면 effect no-op → 기존 갤러리 흐름과 byte-identical(회귀 가드).

- [ ] **Step 4: ScenarioNewPage 테스트 통과 + 기존 갤러리 테스트 회귀 없음 확인**

Run: `cd ui && pnpm test ScenarioNewPage`
Expected: PASS — `ScenarioNewPage.import`(2) + 기존 `ScenarioNewPage.gallery`(5) + `ScenarioNewPage.testrun`/`.test.ts` 전부 green.

- [ ] **Step 5: 라우트 + 목록 진입 버튼 추가 (R8)**

Modify `ui/src/routes.tsx`:
1. import 추가: `import { ScenarioImportPage } from "./pages/ScenarioImportPage";`
2. children 배열에서 `{ path: "scenarios/new", ... }` 다음 줄에:
```ts
      { path: "scenarios/import", element: <ScenarioImportPage /> },
```

Modify `ui/src/pages/ScenarioListPage.tsx` — 헤더의 `<Link to="/scenarios/new">…</Link>`를 두 버튼으로:
```tsx
        <div className="flex items-center gap-2">
          <Link to="/scenarios/import">
            <Button variant="secondary">{ko.import.title}</Button>
          </Link>
          <Link to="/scenarios/new">
            <Button>{ko.pages.newScenario}</Button>
          </Link>
        </div>
```

- [ ] **Step 6: R9 navigate 테스트 + 전체 스위트 통과 확인**

Run: `cd ui && pnpm test ScenarioImportPage`
Expected: PASS (6 — 기존 5 + R9 navigate).

Run: `cd ui && pnpm test`
Expected: 전체 green(인자 없는 전체 1회 — ScenarioListPage·ScenarioNewPage 등 다른 파일 회귀 확인, ui/CLAUDE.md S-D 함정).

- [ ] **Step 7: 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm build`
Expected: 통과(경고 0).

```bash
git add ui/src/routes.tsx ui/src/pages/ScenarioListPage.tsx ui/src/pages/ScenarioNewPage.tsx ui/src/pages/__tests__/ScenarioNewPage.import.test.tsx ui/src/pages/__tests__/ScenarioImportPage.test.tsx
git commit -m "feat(ui): /scenarios/import 라우트·진입 버튼·편집기 핸드오프 (R8,R9)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

`git log -1` 확인.

---

## 완료 후

- 최종 리뷰: `handicap-reviewer`(크로스커팅·와이어 1:1 — 특히 R2 와이어-형 emit이 모델-형이 아닌지, exhaustive-deps 경고 0).
- 라이브 검증 **불요**(spec §6 — production diff가 `ui/`-only, run-생성/리포트-파싱/엔진 경로 무변경; R2를 골든 와이어-YAML + `parseScenarioDoc` 단위테스트로 닫음). 단 머지 전 인자 없는 `pnpm test` 1회 필수(Step 6).
- `/finish-slice`로 build-log·roadmap(라이브 캡처 미래 슬라이스·연기 항목 §7)·CLAUDE 상태줄·메모리 기록 → ff-merge.

---

<!-- spec-plan-reviewer: spec 3-round clean APPROVE + plan 2-round clean APPROVE (2026-06-15). -->
REVIEW-GATE: APPROVED
```

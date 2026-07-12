# HAR 가져오기 URL 안전 디코딩 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HAR 가져오기 시 URL 경로·쿼리의 percent-인코딩을 "전송 의미가 안 바뀌는 문자만" 디코딩해 시나리오 YAML·스텝 이름·미리보기를 사람이 읽는 형태로 만든다.

**Architecture:** 신규 순수 모듈 `ui/src/import/urlDecode.ts`(escape-run 단위 안전 디코딩, allow = 공백+비ASCII 가시 문자, 나머지는 원문 escape 슬라이스 보존) → `harToScenario.ts::wireStep`(스텝 URL·이름)과 `ScenarioImportPage.tsx`(미리보기 표시)에 배선. 엔진(reqwest WHATWG)이 전송 시 재인코딩하므로 와이어 바이트 불변. spec: `docs/superpowers/specs/2026-07-12-har-query-decode-design.md` (R1–R8이 정규 요구사항).

**Tech Stack:** TypeScript(strict) + vitest + RTL. 신규 의존성 0.

## Global Constraints

- **UI-only**: `crates/**`·proto·migration·`ui/src/api/**`(Zod)·와이어 포맷 0-diff (spec §5).
- **Referer/Origin 헤더 값·form/JSON 바디·`filters.ts` 로직은 무변경** (spec R7).
- escape가 없는 URL 입력엔 출력 byte-identical — 기존 ASCII-only 테스트 전부 무수정 green 유지 (spec §5).
- **tdd-guard**: 각 task에서 테스트 파일 편집을 src 편집보다 먼저 (pending test-path diff가 없으면 `ui/src` 편집이 차단됨 — ui/CLAUDE.md).
- 커밋 전 게이트: `cd ui && pnpm lint && pnpm test && pnpm build` (lint는 `--max-warnings=0`, build=`tsc -b`가 최종 게이트).
- implementer의 `git commit`은 단일 FOREGROUND 호출(`run_in_background:false`, timeout 600000ms), `| tail`/`| head` 파이프 금지, `--no-verify` 금지.
- 신규 사용자 노출 문구 없음(ko.ts 무변경 — 이 슬라이스는 데이터 변환·표시값만).
- subagent 리포트는 `.superpowers/sdd/` 경로에만, worktree 루트에 `.md` 쓰기·`git add` 금지.

---

### Task 1: `urlDecode.ts` — 안전 디코더 (spec R1–R5)

**Files:**
- Test: `ui/src/import/__tests__/urlDecode.test.ts` (신규 — **먼저 작성**)
- Create: `ui/src/import/urlDecode.ts`

**Interfaces:**
- Produces: `safeDecodeUrl(url: string): string`, `safeDecodeComponent(s: string): string` — 둘 다 named export, 순수·no-throw·멱등. Task 2·3이 `safeDecodeUrl`만 소비.

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/import/__tests__/urlDecode.test.ts` 신규:

```ts
import { describe, expect, it } from "vitest";
import { safeDecodeComponent, safeDecodeUrl } from "../urlDecode";

// spec 2026-07-12-har-query-decode-design.md §2 R1–R5 acceptance.
describe("safeDecodeUrl — 허용 집합 디코딩 (R1)", () => {
  it("한글 경로·쿼리를 디코딩한다", () => {
    expect(
      safeDecodeUrl("https://a.com/%EA%B2%80%EC%83%89/%EC%83%81%ED%92%88?%EC%B9%B4=%EC%8B%A0%EB%B0%9C"),
    ).toBe("https://a.com/검색/상품?카=신발");
  });

  it("%20을 공백으로 디코딩한다", () => {
    expect(safeDecodeUrl("/p?q=%ED%95%9C%20%EA%B8%80")).toBe("/p?q=한 글");
  });

  it("ASCII unreserved(%41%42%43)는 디코딩하지 않는다 — 리뷰 1R 제거", () => {
    const u = "https://a.com/q?v=%41%42%43";
    expect(safeDecodeUrl(u)).toBe(u);
  });
});

describe("safeDecodeUrl — 보존 (R2)", () => {
  it("중첩 URL의 구조 escape(%3A %2F %3F %3D %26)는 불변", () => {
    const u = "https://a.com/api?redirect=https%3A%2F%2Fb.com%2Fpath%3Fx%3D1%26y%3D2";
    expect(safeDecodeUrl(u)).toBe(u);
  });

  it("템플릿 토큰 문자(%7B %7D %24)는 불변 — {{/${ 생성 차단", () => {
    const u = "https://a.com/q?tpl=%7B%7Bu%7D%7D&d=%24%7Bv%7D";
    expect(safeDecodeUrl(u)).toBe(u);
  });

  it("리터럴 %25·%2B·raw +는 불변", () => {
    const u = "https://a.com/q?pct=100%25&plus=a%2Bb&raw=c+d";
    expect(safeDecodeUrl(u)).toBe(u);
  });

  it("혼합 run은 문자 단위 부분 디코딩 — 한글만 풀고 %26 보존", () => {
    expect(safeDecodeUrl("https://a.com/q?name=%EA%B9%80%26%EC%9D%B4")).toBe(
      "https://a.com/q?name=김%26이",
    );
  });

  it("보존 escape는 소문자 hex 원문 그대로(재작성 없음)", () => {
    const u = "https://a.com/q?p=%2fpath%3d1";
    expect(safeDecodeUrl(u)).toBe(u); // %2F·%3D로 대문자화되면 실패
  });

  it("비가시 문자(nbsp %C2%A0, zwsp %E2%80%8B)는 불변", () => {
    const u = "https://a.com/q?x=%C2%A0y&z=%E2%80%8B";
    expect(safeDecodeUrl(u)).toBe(u);
  });
});

describe("safeDecodeUrl — 경계 보존 (R3)", () => {
  it("authority의 escape는 불변, 경로만 디코딩", () => {
    expect(safeDecodeUrl("https://%ED%95%9C@h.com/p%ED%95%9C")).toBe(
      "https://%ED%95%9C@h.com/p한",
    );
  });

  it("#fragment는 불변", () => {
    expect(safeDecodeUrl("/p?q=%ED%95%9C#f%ED%95%9C")).toBe("/p?q=한#f%ED%95%9C");
  });

  it("${VAR} 프리픽스 입력(호스트 치환 출력)도 그대로 동작", () => {
    expect(safeDecodeUrl("${BASE_URL}/my?tab=%ED%99%88%20%EC%84%A4%EC%A0%95")).toBe(
      "${BASE_URL}/my?tab=홈 설정",
    );
  });

  it("상대 URL·escape 없는 입력은 byte-identical", () => {
    expect(safeDecodeUrl("/relative/path?a=1")).toBe("/relative/path?a=1");
    expect(safeDecodeUrl("https://api.example.com/users?page=1")).toBe(
      "https://api.example.com/users?page=1",
    );
  });
});

describe("safeDecodeUrl — 깨진 입력 (R4)", () => {
  it("유효 한글에 깨진 바이트가 인접한 run은 전체 보존(바이트 분할 안 함)", () => {
    const u = "https://a.com/q?bad=%EA%B9%80%FF";
    expect(safeDecodeUrl(u)).toBe(u);
  });

  it("잘린/깨진 escape(%2, %GG)는 불변·no-throw", () => {
    expect(safeDecodeUrl("/q?x=%2")).toBe("/q?x=%2");
    expect(safeDecodeUrl("/q?x=%GG")).toBe("/q?x=%GG");
  });
});

describe("safeDecodeUrl — 멱등 (R5)", () => {
  it("파일 내 전체 golden 입력 corpus에 재적용해도 불변 (의존성 0 property-over-corpus)", () => {
    // spec R5 acceptance의 "property"는 fast-check 추가 없이 corpus 전수로 해석(신규 의존성 0 제약).
    const corpus = [
      "https://a.com/%EA%B2%80%EC%83%89/%EC%83%81%ED%92%88?%EC%B9%B4=%EC%8B%A0%EB%B0%9C",
      "/p?q=%ED%95%9C%20%EA%B8%80",
      "https://a.com/q?v=%41%42%43",
      "https://a.com/api?redirect=https%3A%2F%2Fb.com%2Fpath%3Fx%3D1%26y%3D2",
      "https://a.com/q?tpl=%7B%7Bu%7D%7D&d=%24%7Bv%7D",
      "https://a.com/q?pct=100%25&plus=a%2Bb&raw=c+d",
      "https://a.com/q?name=%EA%B9%80%26%EC%9D%B4",
      "https://a.com/q?p=%2fpath%3d1",
      "https://a.com/q?x=%C2%A0y&z=%E2%80%8B",
      "https://%ED%95%9C@h.com/p%ED%95%9C",
      "/p?q=%ED%95%9C#f%ED%95%9C",
      "${BASE_URL}/my?tab=%ED%99%88%20%EC%84%A4%EC%A0%95",
      "/relative/path?a=1",
      "https://a.com/q?bad=%EA%B9%80%FF",
      "/q?x=%2",
      "/q?x=%GG",
    ];
    for (const u of corpus) {
      const once = safeDecodeUrl(u);
      expect(safeDecodeUrl(once)).toBe(once);
    }
  });
});

describe("safeDecodeComponent", () => {
  it("URL 구조 파싱 없이 문자열 전체에 run 치환을 적용한다", () => {
    expect(safeDecodeComponent("/%EA%B2%80%EC%83%89")).toBe("/검색");
    expect(safeDecodeComponent("a%2Fb")).toBe("a%2Fb");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test urlDecode`
Expected: FAIL — `Cannot find module '../urlDecode'` (또는 전 케이스 실패).

- [ ] **Step 3: 구현** — `ui/src/import/urlDecode.ts` 신규:

```ts
// HAR 가져오기 URL 안전 디코딩 (spec 2026-07-12-har-query-decode-design.md).
// 허용 = 공백(0x20)·비ASCII 가시 문자만 디코딩. 그 외 escape는 원문 텍스트 그대로 보존
// (구조·템플릿 문자를 못 만들므로 전송 바이트 불변 — 엔진 reqwest가 재인코딩).

const ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/g;
// 비ASCII 판정: 제어·포맷·구분자(보이지 않는 문자)는 YAML 유령문자 방지 위해 보존.
const INVISIBLE = /[\p{C}\p{Z}]/u;
const AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function decodeRun(run: string): string {
  const bytes = new Uint8Array(run.length / 3);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
  }
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return run; // 깨진 UTF-8 → run 전체 원문 보존 (R4)
  }
  let out = "";
  let byteIdx = 0;
  for (const ch of text) {
    const nBytes = encoder.encode(ch).length;
    const cp = ch.codePointAt(0) ?? 0;
    const allowed = cp === 0x20 || (cp >= 0x80 && !INVISIBLE.test(ch));
    // 비허용 문자는 run에서 그 문자의 원문 escape(바이트당 3글자)를 슬라이스 — hex 케이스 보존 (R2)
    out += allowed ? ch : run.slice(byteIdx * 3, (byteIdx + nBytes) * 3);
    byteIdx += nBytes;
  }
  return out;
}

// 연속 %XX run만 치환 — 그 외 문자는 절대 건드리지 않는다(잘린 escape·raw + 포함).
export function safeDecodeComponent(s: string): string {
  return s.replace(ESCAPE_RUN, decodeRun);
}

// scheme://authority 프리픽스와 #fragment를 보존하고 경로+쿼리에만 적용.
// new URL 재직렬화를 쓰지 않아 호스트 정규화 부수효과가 없고 상대·${VAR} URL도 균일 처리 (R3).
export function safeDecodeUrl(url: string): string {
  const hashIdx = url.indexOf("#");
  const frag = hashIdx === -1 ? "" : url.slice(hashIdx);
  const head = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const prefix = AUTHORITY.exec(head)?.[0] ?? "";
  return prefix + safeDecodeComponent(head.slice(prefix.length)) + frag;
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd ui && pnpm test urlDecode`
Expected: PASS (전 케이스).

- [ ] **Step 5: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/import/urlDecode.ts ui/src/import/__tests__/urlDecode.test.ts
git commit -m "feat(ui): HAR URL 안전 디코더 urlDecode.ts — allow-list 디코딩·원문 escape 보존 (R1-R5)"
```

---

### Task 2: `harToScenario.ts` 배선 — 스텝 URL·이름 (spec R6①②·R7·R8)

**Files:**
- Test: `ui/src/import/__tests__/harToScenario.test.ts` (신규 describe 추가 — **먼저 작성**)
- Modify: `ui/src/import/harToScenario.ts` (`wireStep`, 현재 141–165행 부근)

**Interfaces:**
- Consumes: `safeDecodeUrl(url: string): string` from `../urlDecode` (Task 1).
- Produces: 생성 YAML의 `steps[].request.url`·`steps[].name`이 디코딩 형태 — Task 3·5가 관찰.

- [ ] **Step 1: 실패하는 테스트 작성** — `harToScenario.test.ts` 말미에 신규 describe 추가:

```ts
describe("URL 안전 디코딩 (spec 2026-07-12, UD)", () => {
  const encodedEntry = {
    request: {
      method: "GET",
      // /검색?q=한 글&redirect=https://b.com/p — 한글·%20은 디코딩, 중첩 URL은 보존 대상
      url: "https://api.example.com/%EA%B2%80%EC%83%89?q=%ED%95%9C%20%EA%B8%80&redirect=https%3A%2F%2Fb.com%2Fp",
      headers: [],
    },
    response: { status: 200, content: { mimeType: "text/html" } },
  };

  function firstStep(yaml: string) {
    const r = parseScenarioDoc(yaml);
    expect("model" in r).toBe(true);
    if (!("model" in r)) throw new Error("unreachable");
    const s = r.model.steps[0];
    if (s.type !== "http") throw new Error("expected http step");
    return s;
  }

  it("UD-R6a: hostVars off — 스텝 URL이 안전 디코딩되고 중첩 URL은 보존", () => {
    const s = firstStep(harToScenarioYaml(har([encodedEntry]), DEFAULTS));
    expect(s.request.url).toBe(
      "https://api.example.com/검색?q=한 글&redirect=https%3A%2F%2Fb.com%2Fp",
    );
  });

  it("UD-R6a': hostVars on — ${VAR} 프리픽스 뒤 경로·쿼리 디코딩", () => {
    const s = firstStep(
      harToScenarioYaml(har([encodedEntry]), {
        ...DEFAULTS,
        hostVars: { "api.example.com": "BASE_URL" },
      }),
    );
    expect(s.request.url).toBe("${BASE_URL}/검색?q=한 글&redirect=https%3A%2F%2Fb.com%2Fp");
  });

  it("UD-R6b: 스텝 이름도 디코딩 — GET /검색", () => {
    const s = firstStep(harToScenarioYaml(har([encodedEntry]), DEFAULTS));
    expect(s.name).toBe("GET /검색");
  });

  it("UD-R7: %XX가 든 Referer 값은 인코딩 그대로(치환 시에도) — vacuous 방지 teeth", () => {
    const entry = {
      request: {
        method: "GET",
        url: "https://api.example.com/%EA%B2%80%EC%83%89",
        headers: [{ name: "Referer", value: "https://api.example.com/%ED%95%9C?q=%20" }],
      },
      response: { status: 200, content: { mimeType: "text/html" } },
    };
    // hostVars on: origin은 ${VAR}로 치환되지만 경로·쿼리 escape는 인코딩 유지
    const on = firstStep(
      harToScenarioYaml(har([entry]), { ...DEFAULTS, hostVars: { "api.example.com": "BASE_URL" } }),
    );
    expect(on.request.headers?.Referer).toBe("${BASE_URL}/%ED%95%9C?q=%20");
    // hostVars off: 값 전체 원문
    const off = firstStep(harToScenarioYaml(har([entry]), DEFAULTS));
    expect(off.request.headers?.Referer).toBe("https://api.example.com/%ED%95%9C?q=%20");
  });

  it("UD-R8a: 디코딩이 ': '(콜론+공백)를 만들어도 YAML 인용으로 round-trip", () => {
    // %3A(콜론)는 ASCII라 보존 — raw ':' + %20 조합으로만 ': ' 생성 가능 (spec §4.4)
    const entry = {
      request: { method: "GET", url: "https://x.com/p?q=key:%20val", headers: [] },
      response: { status: 200, content: { mimeType: "text/html" } },
    };
    const s = firstStep(harToScenarioYaml(har([entry]), DEFAULTS));
    expect(s.request.url).toBe("https://x.com/p?q=key: val");
  });

  it("UD-R8b: 보존된 #fragment 직전의 디코딩 공백도 YAML round-trip", () => {
    const entry = {
      request: { method: "GET", url: "https://x.com/p?q=%20#frag", headers: [] },
      response: { status: 200, content: { mimeType: "text/html" } },
    };
    const s = firstStep(harToScenarioYaml(har([entry]), DEFAULTS));
    expect(s.request.url).toBe("https://x.com/p?q= #frag");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test harToScenario`
Expected: 신규 describe **5케이스 FAIL**(인코딩 원문이 그대로 나옴) + **UD-R7은 처음부터 PASS**(불변식 teeth — `parameterizeRefHeaders`가 이미 이 값을 내며, 잘못된 배선[헤더까지 디코딩] 시에만 빨간불이 되는 회귀 가드다. FAIL로 만들려고 이 테스트를 고치지 말 것). 기존 케이스 전부 PASS.

- [ ] **Step 3: 배선** — `harToScenario.ts`:

import 추가(파일 상단, 기존 import 뒤):

```ts
import { safeDecodeUrl } from "./urlDecode";
```

`wireStep`의 두 줄 변경:

```ts
function wireStep(entry: HarEntry, opts: ConvertOptions): Record<string, unknown> {
  const method = entry.request.method.toUpperCase();
  const rawUrl = entry.request.url;
  const url = safeDecodeUrl(parameterizeUrl(rawUrl, opts.hostVars));
  // …(request/body/assert 조립 무변경)…
  return {
    id: newStepId(),
    name: `${method} ${safeDecodeUrl(pathOf(rawUrl))}`,
    // …이하 무변경…
  };
}
```

(`parameterizeUrl`·`pathOf`·`foldHeaders`·`parameterizeRefHeaders`·`wireBody`는 수정하지 않는다 — R7. 디코딩은 항상 wireStep 조립 지점에서만.)

- [ ] **Step 4: 통과 확인 (기존 포함 전체 파일)**

Run: `cd ui && pnpm test harToScenario`
Expected: PASS — 신규 6 + 기존 전부(ASCII-only 경로 byte-identical이라 무수정 green).

- [ ] **Step 5: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/import/harToScenario.ts ui/src/import/__tests__/harToScenario.test.ts
git commit -m "feat(ui): HAR 변환 스텝 URL·이름 안전 디코딩 배선 (R6①②/R7/R8)"
```

---

### Task 3: 미리보기 표시 디코딩 (spec R6③)

**Files:**
- Test: `ui/src/pages/__tests__/ScenarioImportPage.test.tsx` (케이스 추가 — **먼저 작성**)
- Modify: `ui/src/pages/ScenarioImportPage.tsx` (미리보기 `<li>` 렌더, 현재 271–291행 부근)

**Interfaces:**
- Consumes: `safeDecodeUrl` from `../import/urlDecode` (Task 1).
- Produces: 없음(표시 전용 — `previewEntries` 데이터·`dedupKey`·`buildEnvInput` 입력은 원문 유지).

- [ ] **Step 1: 실패하는 테스트 작성** — 기존 테스트 파일의 fixture 패턴(`harFile()` 헬퍼·`user.upload`)을 따라 케이스 추가:

```ts
it("UD-R6c: 미리보기 행 텍스트·체크박스 aria-label이 디코딩 표시", async () => {
  const user = userEvent.setup();
  renderPage();
  const encodedHar = JSON.stringify({
    log: {
      entries: [
        {
          request: {
            method: "GET",
            url: "https://api.example.com/%EA%B2%80%EC%83%89?q=%ED%95%9C%20%EA%B8%80",
            headers: [],
          },
          response: { status: 200, content: { mimeType: "text/html" } },
        },
      ],
    },
  });
  await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(encodedHar));
  // 행 텍스트와 체크박스 accname 둘 다 디코딩 형태 (인덱스 스코프 불필요 — 단일 행)
  expect(
    await screen.findByText("GET https://api.example.com/검색?q=한 글"),
  ).toBeInTheDocument();
  expect(
    screen.getByLabelText("GET https://api.example.com/검색?q=한 글"),
  ).toBeInTheDocument();
});
```

(`renderPage()`·`harFile(content)`는 파일 상단 기존 헬퍼 그대로 — `harFile`은 `content = HAR` 기본값의 문자열 인자를 받으므로 `harFile(encodedHar)`로 호출, 실측 확인 2026-07-12.)

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test ScenarioImportPage`
Expected: 신규 케이스 FAIL(인코딩 원문 표시), 기존 케이스 PASS.

- [ ] **Step 3: 표시 배선** — `ScenarioImportPage.tsx`:

import 추가:

```ts
import { safeDecodeUrl } from "../import/urlDecode";
```

미리보기 `<li>` 내부(표시·aria-label 두 곳만, `key={p.index}`·토글 로직 무변경):

```tsx
<input
  type="checkbox"
  aria-label={`${p.method} ${safeDecodeUrl(p.url)}`}
  checked={!excludedIndices.has(p.index)}
  onChange={(e) => toggleIndex(p.index, e.target.checked)}
/>
<span className="truncate">
  {p.method} {safeDecodeUrl(p.url)}
</span>
```

- [ ] **Step 4: 통과 확인**

Run: `cd ui && pnpm test ScenarioImportPage`
Expected: PASS — 신규 + 기존 전부(기존 fixture는 ASCII-only라 라벨 불변, 예: `getByLabelText("GET https://api.example.com/users")` 그대로 green).

- [ ] **Step 5: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/pages/ScenarioImportPage.tsx ui/src/pages/__tests__/ScenarioImportPage.test.tsx
git commit -m "feat(ui): HAR 가져오기 미리보기 URL 디코딩 표시 (R6③)"
```

---

### Task 4: 전체 게이트 스윕 (orchestrator 직접)

- [ ] **Step 1**: `cd ui && pnpm lint && pnpm test && pnpm build` — 인자 없는 전체 스위트(targeted-green ≠ full-green). Expected: 전부 PASS/성공.
- [ ] **Step 2**: 불변식 확인 — `git diff master --stat`가 `ui/src/import/`·`ui/src/pages/`·`docs/` 밖 파일 0건(특히 `crates/**`·`ui/src/api/**` 0-diff), `git diff master -- ui/src/import/filters.ts` 빈 출력.

### Task 5: 라이브 검증 — spec §6-3 (orchestrator 직접, `/live-verify`)

- [ ] **Step 1**: 워크트리에서 `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller`, `just ui-build` 후 `./target/debug/controller --db /tmp/har-decode.db --ui-dir ui/dist` + **로깅** echo responder(`print(f"REQ {self.command} {self.path}", flush=True)` — 번들 responder는 no-op이라 별도 변형) 기동.
- [ ] **Step 2**: 한글 경로·쿼리(`/검색?q=한 글` 인코딩형) 엔트리가 든 HAR 파일을 Playwright로 UI 업로드 → 미리보기 디코딩 표시 확인 → 시나리오 생성(호스트→env 매핑으로 responder 주소 주입 또는 URL을 responder로 향하게 한 HAR 사용).
- [ ] **Step 3**: run(또는 `POST /api/test-runs`) 실행 → responder 로그 REQ 라인에 `%EA%B2%80%EC%83%89`·`%ED%95%9C%20%EA%B8%80`(재인코딩 바이트) 도달 grep.
- [ ] **Step 4 (필수 비교군)**: 같은 경로를 **인코딩 원문 그대로** 넣은 대조 시나리오를 curl로 생성·실행 → 두 REQ 라인이 hex-케이스 무시 비교로 동일함을 확인 (spec §6-3 ②).
- [ ] **Step 5**: 프로세스 정리 + `/tmp/har-decode.db` 삭제, 결과를 브랜치 기록에 남김.

---

## Self-Review 노트 (plan 작성 시점)

- spec R1–R5→Task 1, R6①②·R7·R8→Task 2, R6③→Task 3, §5 불변식→Task 4, §6-3→Task 5 — 전 요구사항 task 매핑 확인.
- Task 2 Step 1의 `s.request.headers?.Referer` — `RequestModel.headers`는 `.default({})`라 Zod **output**은 required `Record<string,string>`이며 `?.`는 사실 불필요하지만 무해(컴파일·lint clean — `no-unnecessary-condition` 규칙 없음). 리뷰어가 "필요해서 썼다"는 근거로 오해하지 말 것(plan 리뷰 3R nit — 코드는 그대로 두면 됨).
- 타입 시그니처 일관: `safeDecodeUrl(url: string): string`을 Task 1 Produces에 정의, Task 2·3 Consumes가 동일 명칭 참조.

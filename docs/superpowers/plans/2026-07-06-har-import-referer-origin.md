# HAR 가져오기 Referer/Origin 헤더 호스트 치환 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HAR→시나리오 변환 시 `hostVars`(호스트→환경변수 매핑)가 켜져 있으면 스텝 URL뿐 아니라 `Referer`/`Origin` 헤더 값도 `${VAR}`로 자동 치환한다.

**Architecture:** `foldHeaders`(모드 필터링)는 무변경으로 두고, 접힌 헤더 맵을 받는 순수 후처리 함수 `parameterizeRefHeaders`를 `harToScenario.ts`에 추가해 `wireStep`에서 한 줄로 배선. Referer는 기존 `parameterizeUrl` 재사용(origin→`${VAR}`, 경로 보존), Origin은 별도 분기로 bare `${VAR}`(RFC 6454 — `parameterizeUrl`을 쓰면 `${VAR}/`가 되는 함정 회피).

**Tech Stack:** TypeScript + vitest (UI-only, `ui/src/import/` 순수 변환기 1파일 + 테스트).

**Spec:** `docs/superpowers/specs/2026-07-06-har-import-referer-origin-design.md` (R1–R7)

REVIEW-GATE: APPROVED

> spec·plan 둘 다 `spec-plan-reviewer` 첫 패스 clean APPROVE (2026-07-06, 동일 reviewer resume). 비차단 advisory 전건 반영: spec — Origin-with-path 규칙 pin·R2 단언 스코프; plan — Step 2 실패 모드 자구·RO-R2 Origin-with-path 락인 케이스.

## Global Constraints

- 작업 디렉토리: `/Users/sgj/develop/handicap/.claude/worktrees/har-referer-origin` (워크트리 — 메인 체크아웃 아님).
- **UI-only**: 엔진·컨트롤러·proto·migration·Zod 스키마(`model.ts`/`schemas.ts`)·store·`ko.ts` 전부 0-diff. 변경 파일은 정확히 2개 — `ui/src/import/harToScenario.ts` + `ui/src/import/__tests__/harToScenario.test.ts`.
- **tdd-guard**: `ui/src` production 편집 전 pending test 파일 필수 — 반드시 테스트 파일을 **먼저** 편집(Step 1이 Step 3보다 앞).
- **와이어-형 단언 함정**(ui/CLAUDE.md HAR import R2): `parseScenarioDoc` 통과만으론 와이어 정확성 증명 불가 — YAML 출력에 와이어 리터럴(`Referer: ${BASE_URL}/...`)을 직접 단언.
- 단일 파일 테스트 반복은 `pnpm test harToScenario` (**`--` 붙이면 전체 스위트가 돎** — ui/CLAUDE.md).
- 커밋: 단일 foreground blocking 호출(`run_in_background` 금지·타임아웃 600000ms), **`| tail`/`| head` 파이프 금지**, `--no-verify` 금지.
- full `pnpm test`에서 무관 파일 1개가 간헐 red면 그 파일 격리 실행(`pnpm test <file>`)으로 green 확인 → suite-wide flake 확정(ui/CLAUDE.md "비결정 테스트 격리 flake") → 커밋 재시도.

---

### Task 1: `parameterizeRefHeaders` — Referer/Origin 값 치환 + `wireStep` 배선

**Files:**
- Modify: `ui/src/import/harToScenario.ts` (신규 export 함수 + `wireStep` 1줄)
- Test: `ui/src/import/__tests__/harToScenario.test.ts` (신규 describe 1개)

**Interfaces:**
- Consumes: `parameterizeUrl(url: string, hostVars?: Record<string, string>): string` (기존, `harToScenario.ts:93` — 미매핑·파싱불가 시 원문 반환), `foldHeaders` (기존, 무변경), 테스트 헬퍼 `har()`/`DEFAULTS` (기존 테스트 파일 상단).
- Produces: `export function parameterizeRefHeaders(headers: Record<string, string>, hostVars?: Record<string, string>): Record<string, string>` — 후속 task 없음(단일 task).

- [ ] **Step 1: 실패하는 테스트 작성**

`ui/src/import/__tests__/harToScenario.test.ts` — ① 파일 상단 import 목록에 `parameterizeRefHeaders` 추가:

```ts
import {
  type ConvertOptions,
  harToScenarioYaml,
  inferName,
  parameterizeRefHeaders,
  parameterizeUrl,
  parseHar,
} from "../harToScenario";
```

② 파일 끝에 신규 describe 추가 (테스트명 접두 `RO-`는 기존 테스트의 원-spec R-id와 구분 — 신규 spec R1–R7 참조):

```ts
describe("Referer/Origin 호스트 치환 (spec 2026-07-06, RO-R1..R7)", () => {
  const HOSTS = { "api.example.com": "BASE_URL", "www.example.com": "BASE_URL_2" };

  it("RO-R1: Referer는 origin만 치환, path·query 보존", () => {
    expect(
      parameterizeRefHeaders({ Referer: "https://api.example.com/mypage?tab=1" }, HOSTS),
    ).toEqual({ Referer: "${BASE_URL}/mypage?tab=1" });
  });

  it("RO-R2: Origin은 정확히 ${VAR} — trailing slash 없음", () => {
    expect(parameterizeRefHeaders({ Origin: "https://api.example.com" }, HOSTS)).toEqual({
      Origin: "${BASE_URL}",
    });
    // 비정형 Origin(path 포함, RFC 6454 위반)도 파싱·매핑되면 bare ${VAR} — spec §4.1 pin
    expect(parameterizeRefHeaders({ Origin: "https://api.example.com/path" }, HOSTS)).toEqual({
      Origin: "${BASE_URL}",
    });
  });

  it("RO-R3: 값 자체 host 기준 각자 매핑, 미매핑 host·다른 이름은 불변", () => {
    expect(
      parameterizeRefHeaders(
        {
          Referer: "https://www.example.com/login",
          Origin: "https://www.example.com",
          "X-Callback-Url": "https://api.example.com/keep",
        },
        HOSTS,
      ),
    ).toEqual({
      Referer: "${BASE_URL_2}/login",
      Origin: "${BASE_URL_2}",
      "X-Callback-Url": "https://api.example.com/keep",
    });
    expect(parameterizeRefHeaders({ Referer: "https://google.com/search?q=x" }, HOSTS)).toEqual({
      Referer: "https://google.com/search?q=x",
    });
  });

  it("RO-R4: 파싱 불가 값(Origin: null·상대 URL)은 불변·no-throw", () => {
    expect(
      parameterizeRefHeaders({ Origin: "null", Referer: "/relative/path" }, HOSTS),
    ).toEqual({ Origin: "null", Referer: "/relative/path" });
  });

  it("RO-R5: hostVars 미지정이면 입력 그대로", () => {
    const input = { Referer: "https://api.example.com/a", Origin: "https://api.example.com" };
    expect(parameterizeRefHeaders(input)).toEqual(input);
  });

  it("RO-R6: 소문자 이름도 매칭 + 키 케이싱 보존", () => {
    expect(
      parameterizeRefHeaders(
        { referer: "https://api.example.com/a", origin: "https://api.example.com" },
        HOSTS,
      ),
    ).toEqual({ referer: "${BASE_URL}/a", origin: "${BASE_URL}" });
  });

  it("RO-R7: harToScenarioYaml 통합 — 와이어 리터럴 + parseScenarioDoc green", () => {
    const entry = {
      request: {
        method: "GET",
        url: "https://api.example.com/users?page=1",
        headers: [
          { name: "Referer", value: "https://api.example.com/mypage?tab=1" },
          { name: "Origin", value: "https://api.example.com" },
        ],
      },
      response: { status: 200, content: { mimeType: "application/json" } },
    };
    const yaml = harToScenarioYaml(har([entry]), {
      ...DEFAULTS,
      hostVars: { "api.example.com": "BASE_URL" },
    });
    expect(yaml).toContain("Referer: ${BASE_URL}/mypage?tab=1");
    expect(yaml).toContain("Origin: ${BASE_URL}");
    const r = parseScenarioDoc(yaml);
    expect("model" in r).toBe(true);
  });

  it("RO-R5b: hostVars 미지정이면 harToScenarioYaml 헤더 출력 byte-identical", () => {
    const entry = {
      request: {
        method: "GET",
        url: "https://api.example.com/users",
        headers: [{ name: "Referer", value: "https://api.example.com/prev" }],
      },
      response: { status: 200, content: { mimeType: "application/json" } },
    };
    const yaml = harToScenarioYaml(har([entry]), DEFAULTS);
    expect(yaml).toContain("Referer: https://api.example.com/prev");
    expect(yaml).not.toContain("${");
  });
});
```

주의: 단언 문자열은 전부 **일반 따옴표 문자열**(backtick 금지 — 템플릿 리터럴이면 `${BASE_URL}`이 보간돼 깨진다).

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/har-referer-origin/ui && pnpm test harToScenario`
Expected: FAIL — vite 5 SSR transform이 미존재 named export를 모듈 로드 시점에 거부(`SyntaxError: [vite] The requested module ... does not provide an export named 'parameterizeRefHeaders'`)해 **이 파일 전체가 red일 수 있음**(정상 — 기존 케이스 green은 Step 4에서 확인). RED 확인이 목적.

- [ ] **Step 3: 최소 구현**

`ui/src/import/harToScenario.ts` — ① `parameterizeUrl` 함수(:104) 바로 아래에 추가:

```ts
// fold 후 후처리: Referer/Origin 헤더 값의 매핑된 호스트를 ${변수}로 치환.
// Referer는 parameterizeUrl 규칙(경로·쿼리 보존), Origin은 bare ${VAR}
// (RFC 6454 — origin에 trailing slash가 붙으면 안 되므로 parameterizeUrl 재사용 불가).
// 미매핑 호스트·파싱 불가 값(Origin: null 등)·그 외 이름은 불변.
export function parameterizeRefHeaders(
  headers: Record<string, string>,
  hostVars?: Record<string, string>,
): Record<string, string> {
  if (!hostVars) return headers;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "referer") {
      out[name] = parameterizeUrl(value, hostVars);
    } else if (lower === "origin") {
      out[name] = originVar(value, hostVars) ?? value;
    } else {
      out[name] = value;
    }
  }
  return out;
}

function originVar(value: string, hostVars: Record<string, string>): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const varName = hostVars[parsed.host];
  if (!varName) return null;
  return `\${${varName}}`;
}
```

② `wireStep`의 headers 라인(:113)을 배선으로 교체:

```ts
  const request: Record<string, unknown> = {
    method,
    url,
    headers: parameterizeRefHeaders(
      foldHeaders(entry.request.headers, opts.headerMode),
      opts.hostVars,
    ),
  };
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/har-referer-origin/ui && pnpm test harToScenario`
Expected: PASS — 신규 8케이스 + 기존 전 케이스(특히 "R4: 헤더 모드"·"hostVars 미지정이면 기존 절대 URL") 모두 green.

- [ ] **Step 5: 전체 게이트**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/har-referer-origin/ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0 warning, full suite green(무관 파일 1개 간헐 red면 격리 실행으로 flake 판정 — Global Constraints), `tsc -b && vite build` 성공.

- [ ] **Step 6: 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/har-referer-origin
git add ui/src/import/harToScenario.ts ui/src/import/__tests__/harToScenario.test.ts
git commit -m "feat(ui): HAR 가져오기 Referer/Origin 헤더도 \${VAR} 호스트 치환

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

단일 foreground 호출(timeout 600000ms), 파이프 금지. 커밋 후 `git log -1`로 landed 확인.

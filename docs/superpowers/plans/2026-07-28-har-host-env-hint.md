# HAR host-환경 힌트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HAR 가져오기 페이지에서 감지된 host가 이미 등록된 환경에 있으면 안내를 표시하고 var 이름을 그 환경의 이름으로 프리필한다 (spec: `docs/superpowers/specs/2026-07-28-har-host-env-hint-design.md`, US1~4).

**Architecture:** 순수 함수 2종(`matchHostsToEnvs`·`resolveHostVars`, `ui/src/import/hostEnv.ts`) + 데이터 훅 1개(`useEnvironmentsWithVars`, `ui/src/api/hooks.ts`) + `ScenarioImportPage` 배선(프리필 memo 교체 + 안내 2표면). 서버/proto/store/migration 0-diff.

**Tech Stack:** React + TS, @tanstack/react-query v5.100.14 (`useQueries` + `combine`), vitest RTL, ko.ts 카탈로그(ADR-0035).

## Global Constraints

- **어휘**: 사용자 노출 문구의 명사는 "환경" — "세트" 금지 (spec 배경·C3).
- **byte-exact ko 신규 키 3개** (spec R7 — 이 값 그대로):
  - `hostRegisteredIn: (env: string, varName: string) => \`'${env}' 환경에 ${varName}(으)로 등록됨\``
  - `hostRegisteredMore: (n: number) => \`외 ${n}개 환경\``
  - `hostsRegisteredSummary: (n: number) => \`호스트 ${n}개가 이미 환경에 등록돼 있습니다\``
- **매치 판정**: 순수 origin 값만 — `new URL(value)` 성공 && `pathname === "/" && search === "" && hash === ""` && `origin === originOf(host, preview)` (spec R2).
- **fan-out 상한 K=20**: 목록을 `updated_at` desc 정렬 후 상위 20개만 단건 fetch (spec R1).
- **dedupe 두 집합**: `overrideNames`(후보 차단 전용) vs `usedByPrefill`(프리필 배정명) — `defaults[h]`는 `usedByPrefill`만 검사, `BASE_URL_{k}`는 k=2부터 두 집합 모두 회피 (spec R3).
- **게이트 명령은 파이프 금지** — `pnpm lint; echo exit=$?` 식으로 종료코드 명시 캡처. `pnpm test <이름>`은 `--` 없이(單파일 필터).
- **tdd-guard**: 각 task의 첫 스텝은 반드시 테스트 파일 편집(작업트리 clean 직후 production 편집은 차단됨).
- **같은-화면 substring 쌍**: `ko.import.hosts`("호스트") ⊂ `hostsRegisteredSummary` — 이 화면 테스트에서 "호스트" 단언에 `toHaveTextContent`/정규식 부분매칭 금지(exact `getByText` 또는 스코프 한정) (spec R7).
- UI 변경 커밋 전 게이트: `pnpm lint && pnpm test && pnpm build` 전부 green (마지막 task에서 전체 1회 — targeted green ≠ full green).

---

### Task 1: 매칭·프리필 순수 함수 (`matchHostsToEnvs` + `resolveHostVars`)

**Files:**
- Modify: `ui/src/import/hostEnv.ts` (현재 90줄 — `RESERVED`/`VAR_NAME_RE`/`hostsByRequestCount`/`defaultHostVars`/`originOf` 기존)
- Test: `ui/src/import/__tests__/hostEnv.test.ts` (기존 파일 — 케이스 추가)

**Interfaces:**
- Consumes: 기존 `originOf(host, preview)`, `defaultHostVars(hosts)`, `RESERVED`, module-private `VAR_NAME_RE`, `import type { Environment } from "../api/environments"` (파일에 `EnvironmentInput` import 선례 있음), `import type { PreviewEntry } from "./filters"`.
- Produces (Task 2·3이 사용):
  ```ts
  export interface HostEnvMatch { envId: string; envName: string; varName: string }
  export function matchHostsToEnvs(
    hosts: string[],
    preview: readonly PreviewEntry[],
    envs: readonly Environment[],
  ): Record<string, HostEnvMatch[]>;
  export function resolveHostVars(
    hostsOrdered: string[],
    matches: Record<string, HostEnvMatch[]>,
    overrides: Record<string, string>,
  ): Record<string, string>;
  ```

- [ ] **Step 1: 실패하는 단위 테스트 작성** — `hostEnv.test.ts`에 아래 케이스 추가 (import에 `matchHostsToEnvs, resolveHostVars, type HostEnvMatch` 추가 — 아직 없어 컴파일 RED)

```ts
// 픽스처 헬퍼 (테스트 파일 로컬)
const env = (id: string, name: string, vars: Record<string, string>, updated = 1): Environment => ({
  id, name, vars, created_at: 1, updated_at: updated,
});
const pv = (...urls: string[]): PreviewEntry[] =>
  urls.map((url, index) => ({ url, method: "GET", index }));

describe("matchHostsToEnvs", () => {
  const preview = pv("https://api.example.com/users", "https://cdn.example.com/a.js");
  const hosts = ["api.example.com", "cdn.example.com"];

  it("origin 정확 일치만 매치 — 값 후행 슬래시는 흡수", () => {
    const out = matchHostsToEnvs(hosts, preview, [
      env("E1", "스테이징", { BASE_URL: "https://api.example.com/" }),
    ]);
    expect(out["api.example.com"]).toEqual([
      { envId: "E1", envName: "스테이징", varName: "BASE_URL" },
    ]);
    expect(out["cdn.example.com"]).toBeUndefined();
  });

  it("경로/쿼리/해시 붙은 값·URL 파싱 불가 값은 제외", () => {
    const out = matchHostsToEnvs(hosts, preview, [
      env("E1", "경로", { A: "https://api.example.com/api" }),
      env("E2", "쿼리", { B: "https://api.example.com/?x=1" }),
      env("E3", "해시", { C: "https://api.example.com/#f" }),
      env("E4", "비URL", { D: "그냥 문자열" }),
    ]);
    expect(out).toEqual({});
  });

  it("다중 매치는 updated_at desc → 이름 asc 정렬", () => {
    const out = matchHostsToEnvs(hosts, preview, [
      env("E1", "b-old", { X: "https://api.example.com" }, 10),
      env("E2", "a-new", { Y: "https://api.example.com" }, 20),
      env("E3", "a-old", { Z: "https://api.example.com" }, 10),
    ]);
    expect(out["api.example.com"].map((m) => m.envId)).toEqual(["E2", "E3", "E1"]);
  });

  it("한 환경 안 다중 일치는 var 이름 asc 첫 1건", () => {
    const out = matchHostsToEnvs(hosts, preview, [
      env("E1", "s", { ZZZ: "https://api.example.com", AAA: "https://api.example.com" }),
    ]);
    expect(out["api.example.com"]).toEqual([{ envId: "E1", envName: "s", varName: "AAA" }]);
  });

  it("빈 envs → 빈 결과", () => {
    expect(matchHostsToEnvs(hosts, preview, [])).toEqual({});
  });
});

describe("resolveHostVars", () => {
  const m = (varName: string): HostEnvMatch[] => [{ envId: "E1", envName: "s", varName }];

  it("우선순위: override > 매치 > 기본", () => {
    expect(
      resolveHostVars(["a.com", "b.com", "c.com"], { "b.com": m("API_URL") }, { "a.com": "MINE" }),
    ).toEqual({ "a.com": "MINE", "b.com": "API_URL", "c.com": "BASE_URL_3" });
  });

  it("매치 0건·override 0건 → defaultHostVars와 동일 (R8)", () => {
    expect(resolveHostVars(["a.com", "b.com"], {}, {})).toEqual({
      "a.com": "BASE_URL",
      "b.com": "BASE_URL_2",
    });
  });

  it("두 행 같은 매치명 → 뒤 행은 defaults 폴백 (FR1)", () => {
    const matches = { "a.com": m("BASE_URL"), "b.com": m("BASE_URL") };
    expect(resolveHostVars(["a.com", "b.com"], matches, {})).toEqual({
      "a.com": "BASE_URL",
      "b.com": "BASE_URL_2",
    });
  });

  it("뒤 행 override + 앞 행 같은 이름 매치 → 앞 행 defaults 폴백 (MF1 시드)", () => {
    expect(
      resolveHostVars(["a.com", "b.com"], { "a.com": m("API_URL") }, { "b.com": "API_URL" }),
    ).toEqual({ "a.com": "BASE_URL", "b.com": "API_URL" });
  });

  it("stale override(목록 밖 host)는 이름 예약 안 함", () => {
    expect(
      resolveHostVars(["a.com"], { "a.com": m("API_URL") }, { "gone.com": "API_URL" }),
    ).toEqual({ "a.com": "API_URL" });
  });

  it("매치 0건 + override가 다른 행 기본명과 충돌 → 기본명 유지 (R8 byte-identical)", () => {
    expect(resolveHostVars(["a.com", "b.com"], {}, { "b.com": "BASE_URL" })).toEqual({
      "a.com": "BASE_URL",
      "b.com": "BASE_URL",
    });
  });

  it("기본명까지 점유되면 BASE_URL_{k} k=2부터 첫 미사용", () => {
    // 앞 행 매치가 뒤 행 기본명(BASE_URL_2)을 점유 → 뒤 행은 BASE_URL_3
    const matches = { "a.com": m("BASE_URL_2") };
    expect(resolveHostVars(["a.com", "b.com"], matches, {})).toEqual({
      "a.com": "BASE_URL_2",
      "b.com": "BASE_URL_3",
    });
  });

  it("자격 미달 매치명(형식 위반·예약어)은 프리필 제외", () => {
    expect(resolveHostVars(["a.com"], { "a.com": m("my-var") }, {})).toEqual({
      "a.com": "BASE_URL",
    });
    expect(resolveHostVars(["a.com"], { "a.com": m("vu_id") }, {})).toEqual({
      "a.com": "BASE_URL",
    });
  });

  it("override 빈 문자열도 override로 존중 (기존 ?? 시맨틱)", () => {
    expect(resolveHostVars(["a.com"], { "a.com": m("API_URL") }, { "a.com": "" })).toEqual({
      "a.com": "",
    });
  });
});
```

주의: `Environment`/`PreviewEntry` 타입 import 깊이는 `__tests__/`에서 한 단계 더 — `import type { Environment } from "../../api/environments";` / `import type { PreviewEntry } from "../filters";` (기존 hostEnv.test.ts의 import 깊이를 기준으로 맞출 것 — `import type` 오경로는 vitest green·`tsc -b`만 red).

- [ ] **Step 2: 실패 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/har-host-env-hint/ui && pnpm test hostEnv; echo exit=$?`
Expected: FAIL (export 없음 — import 에러 또는 undefined 호출)

- [ ] **Step 3: 구현** — `hostEnv.ts`에 추가 (파일 상단 import에 `Environment` 타입 추가)

```ts
import type { Environment, EnvironmentInput } from "../api/environments";
```

```ts
export interface HostEnvMatch {
  envId: string;
  envName: string;
  varName: string;
}

// 순수 origin 값만 매치 후보 — 경로/쿼리/해시가 붙은 값은 프리필 시
// ${VAR}${pathname}이 이중 경로로 해석되므로 매치 자체에서 제외한다 (spec R2).
function pureOrigin(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.pathname !== "/" || u.search !== "" || u.hash !== "") return null;
  return u.origin;
}

export function matchHostsToEnvs(
  hosts: string[],
  preview: readonly PreviewEntry[],
  envs: readonly Environment[],
): Record<string, HostEnvMatch[]> {
  const sorted = [...envs].sort(
    (a, b) => b.updated_at - a.updated_at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const out: Record<string, HostEnvMatch[]> = {};
  for (const host of hosts) {
    const origin = originOf(host, preview);
    if (origin === "") continue;
    const ms: HostEnvMatch[] = [];
    for (const e of sorted) {
      // 와이어는 BTreeMap이라 이미 사전순이지만 순서를 가정하지 않고 명시 정렬 (spec R2)
      const hit = Object.keys(e.vars)
        .sort()
        .find((v) => pureOrigin(e.vars[v]) === origin);
      if (hit !== undefined) ms.push({ envId: e.id, envName: e.name, varName: hit });
    }
    if (ms.length > 0) out[host] = ms;
  }
  return out;
}

export function resolveHostVars(
  hostsOrdered: string[],
  matches: Record<string, HostEnvMatch[]>,
  overrides: Record<string, string>,
): Record<string, string> {
  const defaults = defaultHostVars(hostsOrdered);
  // pre-pass: 현재 host의 override 값은 프리필 후보를 차단한다(재작성은 없음).
  // stale override(목록 밖 host)는 시드하지 않는다 (spec R3 MF1).
  const overrideNames = new Set<string>();
  for (const h of hostsOrdered) {
    const o = overrides[h];
    if (o !== undefined) overrideNames.add(o);
  }
  const usedByPrefill = new Set<string>();
  const out: Record<string, string> = {};
  for (const h of hostsOrdered) {
    const o = overrides[h];
    if (o !== undefined) {
      out[h] = o;
      continue;
    }
    const cand = matches[h]?.[0]?.varName;
    let name: string;
    if (
      cand !== undefined &&
      VAR_NAME_RE.test(cand) &&
      !RESERVED.has(cand) &&
      !overrideNames.has(cand) &&
      !usedByPrefill.has(cand)
    ) {
      name = cand;
    } else if (!usedByPrefill.has(defaults[h])) {
      // override와의 충돌은 일부러 막지 않는다 — 기존-가시 충돌(validateEnv dup)이고,
      // 막으면 매치 0건 경로가 개명돼 R8 byte-identical이 깨진다 (spec R3).
      name = defaults[h];
    } else {
      let k = 2;
      while (usedByPrefill.has(`BASE_URL_${k}`) || overrideNames.has(`BASE_URL_${k}`)) k++;
      name = `BASE_URL_${k}`;
    }
    usedByPrefill.add(name);
    out[h] = name;
  }
  return out;
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/har-host-env-hint/ui && pnpm test hostEnv; echo exit=$?`
Expected: PASS (exit=0)

- [ ] **Step 5: dedupe 이빨 실증 (고의 회귀→RED→원복→GREEN)** — `resolveHostVars`에서 pre-pass 시드 루프를 임시 주석 처리 → `pnpm test hostEnv` → "MF1 시드" 케이스가 RED인지 확인 → 원복 → GREEN 재확인. 이어 `usedByPrefill.add(name)` 줄을 임시 제거 → "FR1"·"k=2" 케이스 RED 확인 → 원복 → GREEN. 결과(어느 케이스가 각각 RED였는지)를 커밋 메시지 본문이 아니라 구현 보고에 기록.

- [ ] **Step 6: 커밋**

```bash
git add ui/src/import/hostEnv.ts ui/src/import/__tests__/hostEnv.test.ts
git commit -m "feat(ui): HAR host-환경 매칭·프리필 순수 함수 (matchHostsToEnvs·resolveHostVars)"
```

---

### Task 2: `useEnvironmentsWithVars` 훅 + 페이지 프리필 배선

**Files:**
- Modify: `ui/src/api/hooks.ts` (`useEnvironment` 부근, `useQueries`·`listEnvironments`·`getEnvironment`·`queryKeys` 전부 기존 import/정의 재사용)
- Modify: `ui/src/pages/ScenarioImportPage.tsx` (`effectiveHostVars` memo 교체 + 훅·매치 memo 추가 — 현재 92–98행 부근)
- Test: `ui/src/pages/__tests__/ScenarioImportPage.test.tsx` (baseline fetch stub + 신규 케이스)

**Interfaces:**
- Consumes: Task 1의 `matchHostsToEnvs`·`resolveHostVars`, 기존 `queryKeys.environments()`/`queryKeys.environment(id)`/`listEnvironments`/`getEnvironment`/`Environment`.
- Produces (Task 3이 사용): `useEnvironmentsWithVars(enabled: boolean): Environment[]` (hooks.ts), 페이지의 `hostMatches: Record<string, HostEnvMatch[]>` memo.

- [ ] **Step 1: baseline fetch stub + 실패하는 RTL 테스트 작성** — `ScenarioImportPage.test.tsx`에 추가.

먼저 **파일 공통 baseline stub**(신규 훅이 HAR 로드 시 무조건 `GET /api/environments`를 발화 — 없으면 기존 ~22개 미모킹 테스트가 undici 상대경로 reject로 전멸, ui/CLAUDE.md "무조건 발화하는 React Query 훅" 함정). 기존 `afterEach`(line 74 부근, `vi.unstubAllGlobals()` 포함) 옆에:

```ts
beforeEach(() => {
  // 신규 useEnvironmentsWithVars가 HAR 로드 시 무조건 GET /api/environments를 발화 —
  // 개별 테스트의 vi.stubGlobal이 이 baseline을 덮어쓴다.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(jsonResponse({ environments: [] }))),
  );
});
```

(vitest import 라인에 `beforeEach` 추가. 기존 2개 fetch-스텁 테스트는 테스트 본문에서 자체 `vi.stubGlobal`로 baseline을 교체하므로 무영향.)

이어 신규 픽스처 + 케이스. **`TWO_HOST_HAR`는 신규 선언 금지 — 기존 픽스처(test:90, `api.example.com/users`+`auth.example.com/login` 동일 2-host·비정적)를 그대로 재사용**(중복 `const` 선언은 파일 전체 SyntaxError):

```ts
const STAGING_ENV = {
  id: "E10",
  name: "스테이징",
  vars: { API_HOST: "https://api.example.com" },
  created_at: 1,
  updated_at: 5,
};

// 목록+단건을 함께 스텁하는 헬퍼 — 힌트 계열 케이스 공용 (mock 반환 = call-count 단언용)
function stubEnvFetch(envs: (typeof STAGING_ENV)[]) {
  const fetchMock = vi.fn((url: string) => {
    const s = String(url);
    const single = envs.find((e) => s.endsWith(`/api/environments/${e.id}`));
    if (single) return Promise.resolve(jsonResponse(single));
    return Promise.resolve(
      jsonResponse({
        environments: envs.map(({ id, name, created_at, updated_at, vars }) => ({
          id, name, created_at, updated_at, var_count: Object.keys(vars).length,
        })),
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
```

```ts
describe("host-환경 힌트: 프리필", () => {
  it("US2: 매치된 host의 var 입력이 기존 환경 이름으로 프리필", async () => {
    const user = userEvent.setup();
    stubEnvFetch([STAGING_ENV]);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    // 매치 settle 후: api 행 = API_HOST(매치), auth 행 = BASE_URL_2(기본 유지)
    expect(await screen.findByDisplayValue("API_HOST")).toBeInTheDocument();
    expect(screen.getByDisplayValue("BASE_URL_2")).toBeInTheDocument();
  });

  it("US2: YAML 미리보기 토큰이 프리필 이름 사용", async () => {
    const user = userEvent.setup();
    stubEnvFetch([STAGING_ENV]);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    await screen.findByDisplayValue("API_HOST");
    const preview = screen.getByLabelText(ko.import.preview) as HTMLTextAreaElement;
    expect(preview.value).toContain("${API_HOST}");
  });

  it("US3: 사용자 override는 매치 프리필이 덮지 않음", async () => {
    const user = userEvent.setup();
    stubEnvFetch([STAGING_ENV]);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    // 매치가 실제로 도착·프리필됐음을 먼저 증명 — 없으면 프리필이 통째로 죽어도 green (이빨)
    await screen.findByDisplayValue("API_HOST");
    const apiInput = screen.getByLabelText(ko.import.varNameLabel("api.example.com"));
    await user.clear(apiInput);
    await user.type(apiInput, "MINE");
    expect(screen.getByDisplayValue("MINE")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("API_HOST")).not.toBeInTheDocument();
  });

  it("US4: 환경 fetch 실패 시 기본 프리필·흐름 정상 (fail-soft)", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("boom"))));
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    expect(await screen.findByDisplayValue("BASE_URL")).toBeInTheDocument();
    expect(screen.getByDisplayValue("BASE_URL_2")).toBeInTheDocument();
    // 에러 배너 없음 (기존 parseError alert만 role=alert)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("R1: fan-out 상한 K=20 — 21개 환경이면 단건 GET 정확히 20회, 최고(最古) 1개 탈락", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 21 }, (_, i) => ({
      id: `E${i}`,
      name: `env${i}`,
      vars: { API_HOST: `https://other${i}.example.com` }, // 키는 STAGING_ENV와 동일(타입 추론 일치 — tsc -b), origin은 매치 무관 host라 힌트 간섭 없음
      created_at: 1,
      updated_at: i, // E0이 가장 오래됨 → 상위 20개에서 탈락
    }));
    const fetchMock = stubEnvFetch(many);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await waitFor(() => {
      const singles = fetchMock.mock.calls.filter(([u]) =>
        /\/api\/environments\/E\d+$/.test(String(u)),
      );
      expect(singles.length).toBe(20);
    });
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).endsWith("/api/environments/E0")),
    ).toBe(false);
  });
});
```

주의: `renderPage`의 QueryClient는 `retry: false`라 fail-soft 케이스가 재시도 대기 없이 settle. `findByDisplayValue`(비동기 settle 대기)를 첫 단언으로, 그 뒤 동기 쿼리(CI flake 클래스 — "await 직후 동기 getBy"는 같은 커밋 요소만).

- [ ] **Step 2: 실패 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/har-host-env-hint/ui && pnpm test ScenarioImportPage; echo exit=$?`
Expected: 신규 5케이스 FAIL (프리필 미배선 — `API_HOST` displayValue 부재·K=20은 단건 GET 0회로 waitFor 타임아웃), 기존 케이스는 baseline stub 하에 전부 PASS 유지

- [ ] **Step 3: 훅 구현** — `hooks.ts`의 `useEnvironment` 아래에 추가

```ts
// settle된 환경만 모은다 — 쿼리별 에러 격리(부분 결과 허용, spec R6 fail-soft).
// 모듈 스코프 정의: 인라인이면 combine identity가 매 렌더 바뀌어 내부 memo가 무효
// (참조 자체는 replaceEqualDeep이 지켜주지만 재계산 낭비, spec R1).
const combineEnvironments = (
  results: Array<{ data: Environment | undefined }>,
): Environment[] => results.flatMap((r) => (r.data !== undefined ? [r.data] : []));

const ENV_FANOUT_CAP = 20;

export function useEnvironmentsWithVars(enabled: boolean): Environment[] {
  const list = useQuery({
    // 공유 useEnvironments()와 같은 queryKey — 캐시 공유, 시그니처는 비접촉 (spec R1)
    queryKey: queryKeys.environments(),
    queryFn: listEnvironments,
    enabled,
  });
  const topK = [...(list.data ?? [])]
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, ENV_FANOUT_CAP);
  return useQueries({
    queries: topK.map((s) => ({
      queryKey: queryKeys.environment(s.id),
      queryFn: () => getEnvironment(s.id),
      enabled,
    })),
    combine: combineEnvironments,
  });
}
```

hooks.ts엔 `Environment` 타입 import가 **없다**(실측 — `hooks.ts:13-20`은 `EnvironmentInput` 타입 + 함수 5개만): `import type { Environment } from "./environments";` 추가 필수. `combine`의 구조적 파라미터 타입 `Array<{ data: Environment | undefined }>`는 contravariant 호환으로 **그대로 컴파일된다**(리뷰 실측 — react-query가 `queryFn`에서 `TQueryFnData=Environment`를 추론). 굳이 `UseQueryResult<Environment, Error>[]`로 바꾸려면 그 타입 import도 함께 추가할 것.

- [ ] **Step 4: 페이지 배선** — `ScenarioImportPage.tsx`

import 추가:

```ts
import { useCreateEnvironment, useEnvironmentsWithVars } from "../api/hooks";
import {
  buildEnvInput,
  defaultHostVars, // ← resolveHostVars가 내부 사용으로 흡수되면 이 import는 제거
  hostsByRequestCount,
  matchHostsToEnvs,
  resolveHostVars,
  validateEnv,
} from "../import/hostEnv";
```

`hostsOrdered` memo(92행) 아래에서 기존 `effectiveHostVars` memo(93–98행)를 교체:

```ts
const envsWithVars = useEnvironmentsWithVars(har !== null);
const hostMatches = useMemo(
  () => matchHostsToEnvs(hostsOrdered, previewEntries, envsWithVars),
  [hostsOrdered, previewEntries, envsWithVars],
);
const effectiveHostVars = useMemo(
  () => resolveHostVars(hostsOrdered, hostMatches, hostVarOverrides),
  [hostsOrdered, hostMatches, hostVarOverrides],
);
```

(`defaultHostVars` 직접 호출이 페이지에서 사라지면 import에서 제거 — `pnpm lint` unused가 잡는다.)

- [ ] **Step 5: 통과 확인 (파일 전체 — 기존 케이스 포함)**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/har-host-env-hint/ui && pnpm test ScenarioImportPage; echo exit=$?`
Expected: PASS (exit=0) — 신규 4 + 기존 전부

- [ ] **Step 6: 커밋**

```bash
git add ui/src/api/hooks.ts ui/src/pages/ScenarioImportPage.tsx ui/src/pages/__tests__/ScenarioImportPage.test.tsx
git commit -m "feat(ui): 환경 vars fan-out 훅 + HAR import 프리필 배선 (useEnvironmentsWithVars)"
```

---

### Task 3: 안내 2표면 (행별 + 발견성) + ko 키 + 전체 게이트

**Files:**
- Modify: `ui/src/i18n/ko.ts` (`ko.import` 블록 — `envRegistered` 부근)
- Modify: `ui/src/pages/ScenarioImportPage.tsx` (호스트→환경변수 fieldset JSX)
- Test: `ui/src/pages/__tests__/ScenarioImportPage.test.tsx`

**Interfaces:**
- Consumes: Task 2의 `hostMatches`, Task 1의 `HostEnvMatch`, 신규 ko 키 3개(Global Constraints의 byte-exact 정의).
- Produces: 최종 UI — 추가 export 없음.

- [ ] **Step 1: 실패하는 RTL 테스트 작성** — `ScenarioImportPage.test.tsx`에 추가 (ko 키 미존재로 컴파일/단언 RED)

```ts
describe("host-환경 힌트: 안내", () => {
  it("US1-①: 발견성 한 줄 — 체크박스 꺼진 상태에서도, 매치 있을 때만", async () => {
    const user = userEvent.setup();
    stubEnvFetch([STAGING_ENV]);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    // 체크박스를 켜지 않은 상태에서 표시 (exact getByText — "호스트" 부분매칭 금지, spec R7)
    expect(await screen.findByText(ko.import.hostsRegisteredSummary(1))).toBeInTheDocument();
    // 렌더된 숫자를 별도 단언 (ko 보간 자기참조 함정 — 11호 클래스)
    expect(screen.getByText(ko.import.hostsRegisteredSummary(1)).textContent).toContain("1");
    expect(screen.getByLabelText(ko.import.hostToEnv)).not.toBeChecked();
  });

  it("US1-①: 매치 0건이면 발견성 줄 부재", async () => {
    const user = userEvent.setup();
    renderPage(); // baseline stub = 환경 0개
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    // n-무관 부재 단언 — n=1 고정이면 "호스트 0개…" 렌더 회귀가 false PASS (R7 "호스트" 부분매칭 회피 위해 꼬리 고정)
    expect(screen.queryByText(/이미 환경에 등록돼 있습니다$/)).not.toBeInTheDocument();
  });

  it("US1-②: 행별 안내 — 환경명·var이름 표시, 체크박스 켠 뒤", async () => {
    const user = userEvent.setup();
    stubEnvFetch([STAGING_ENV]);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    const hint = await screen.findByText(ko.import.hostRegisteredIn("스테이징", "API_HOST"));
    // 보간 실존 별도 단언 (자기참조 회피)
    expect(hint.textContent).toContain("스테이징");
    expect(hint.textContent).toContain("API_HOST");
  });

  it("US1-②: 다중 매치 꼬리 '외 N개 환경' (N = 전체-1)", async () => {
    const user = userEvent.setup();
    const OLDER_ENV = {
      id: "E11",
      name: "개발",
      vars: { API_HOST: "https://api.example.com" },
      created_at: 1,
      updated_at: 2, // STAGING_ENV(5)보다 과거 → 안내는 스테이징 기준
    };
    stubEnvFetch([STAGING_ENV, OLDER_ENV]);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    const hint = await screen.findByText(
      (t) => t.includes(ko.import.hostRegisteredIn("스테이징", "API_HOST")),
    );
    expect(hint.textContent).toContain(ko.import.hostRegisteredMore(1));
    expect(hint.textContent).toContain("1");
  });

  it("US3: 안내가 있어도 이름 수정·등록 버튼 동작 불변", async () => {
    const user = userEvent.setup();
    stubEnvFetch([STAGING_ENV]);
    renderPage();
    await user.upload(screen.getByLabelText(ko.import.chooseFile), harFile(TWO_HOST_HAR));
    await screen.findByLabelText(ko.import.preview);
    await user.click(screen.getByLabelText(ko.import.hostToEnv));
    const apiInput = await screen.findByLabelText(ko.import.varNameLabel("api.example.com"));
    await user.clear(apiInput);
    await user.type(apiInput, "OTHER");
    expect(screen.getByRole("button", { name: ko.import.registerEnv })).toBeEnabled();
    // 안내는 등록 사실(불변)을 계속 표시
    expect(screen.getByText(ko.import.hostRegisteredIn("스테이징", "API_HOST"))).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/har-host-env-hint/ui && pnpm test ScenarioImportPage; echo exit=$?`
Expected: 신규 5케이스 FAIL (ko 키 부재 — TS/런타임 에러)

- [ ] **Step 3: ko 키 추가** — `ko.ts`의 `ko.import` 블록, `envRegistered` 아래 (Global Constraints의 byte-exact 값 그대로):

```ts
hostRegisteredIn: (env: string, varName: string) => `'${env}' 환경에 ${varName}(으)로 등록됨`,
hostRegisteredMore: (n: number) => `외 ${n}개 환경`,
hostsRegisteredSummary: (n: number) => `호스트 ${n}개가 이미 환경에 등록돼 있습니다`,
```

- [ ] **Step 4: JSX 배선** — `ScenarioImportPage.tsx` 호스트→환경변수 fieldset:

① react import에 `Fragment` 추가. ② 발견성 줄 — 체크박스 `<label>` 바로 다음, `{hostVarsEnabled && …}` 앞에:

```tsx
{Object.keys(hostMatches).length > 0 && (
  <p className="text-xs text-slate-500">
    {ko.import.hostsRegisteredSummary(Object.keys(hostMatches).length)}
  </p>
)}
```

③ 행별 안내 — `hostsOrdered.map`의 `<label key={h}>`를 `<Fragment key={h}>`로 감싸고 안내 `<p>`는 **label 밖 형제**(라벨 안이면 클릭이 입력을 포커스 — spec R4):

```tsx
{hostsOrdered.map((h) => (
  <Fragment key={h}>
    <label className="flex items-center gap-2">
      {/* 기존 행 내용 그대로 (span host · → · Input) — key만 Fragment로 이동 */}
    </label>
    {hostMatches[h] && (
      <p className="text-xs text-slate-500">
        {ko.import.hostRegisteredIn(hostMatches[h][0].envName, hostMatches[h][0].varName)}
        {hostMatches[h].length > 1 &&
          ` · ${ko.import.hostRegisteredMore(hostMatches[h].length - 1)}`}
      </p>
    )}
  </Fragment>
))}
```

- [ ] **Step 5: 통과 확인 (파일 전체)**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/har-host-env-hint/ui && pnpm test ScenarioImportPage; echo exit=$?`
Expected: PASS (exit=0)

- [ ] **Step 6: ko 신규 키 유일성·충돌 확인** (기계 검증 — spec R7)

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/har-host-env-hint
grep -c "환경에 .*(으)로 등록됨" ui/src/i18n/ko.ts   # expect 1
grep -c "외 \${n}개 환경" ui/src/i18n/ko.ts          # expect 1
grep -c "이미 환경에 등록돼 있습니다" ui/src/i18n/ko.ts  # expect 1
```

양방향 substring 알려진 쌍(스펙 기측정): "환경"(전 카탈로그 클래스·비문제), "호스트" ⊂ `hostsRegisteredSummary`(같은 화면 — 테스트에서 exact 매칭만 사용했는지 이 파일 신규 단언 재확인).

- [ ] **Step 7: 전체 게이트 (파이프 금지·개별 exit 캡처)**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/har-host-env-hint/ui
pnpm lint; echo lint_exit=$?
pnpm test; echo test_exit=$?
pnpm build; echo build_exit=$?
```

Expected: 세 exit 모두 0 (full `pnpm test` — targeted green ≠ full green).

- [ ] **Step 8: 커밋**

```bash
git add ui/src/i18n/ko.ts ui/src/pages/ScenarioImportPage.tsx ui/src/pages/__tests__/ScenarioImportPage.test.tsx
git commit -m "feat(ui): HAR import host-환경 안내 2표면 (행별 + 발견성, ko 3키)"
```

---

## 라이브 검증 (plan 밖 — 파이프라인 5단계)

구현 task가 아니라 슬라이스 파이프라인의 별도 단계: spec "라이브 검증" US 앵커 표(US1~4)를 `/live-verify` 스택으로 실측. 주의(스펙 엣지): 매치 없는 행도 dedupe 폴백으로 이름이 한 번 바뀔 수 있음 — 결함 오판 금지. 진입 경로는 `/scenarios/import` 단일.

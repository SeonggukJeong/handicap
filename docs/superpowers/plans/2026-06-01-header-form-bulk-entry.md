# Header / Form-Body 편집 UX 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시나리오 에디터 Inspector의 HTTP 스텝 Headers/Form-body 입력을 2열 그리드 + "Bulk Edit" 토글(Postman식 전체 교체) + 자주 쓰는 헤더 피커(메뉴 + datalist 자동완성)로 개선한다.

**Architecture:** 순수 UI 변경(와이어/모델/백엔드 무변경). 거의 동일했던 `HeadersEditor`/`FormBodyField`를 공유 `KeyValueGrid`로 통합하고, 파싱/포맷은 순수 함수 `kvBulk.ts`로 분리. 편집은 `ExtractEditor`의 로컬 draft + onBlur 커밋 패턴을 따르고, 기존 `setStepField(stepId, path, value)` 경로로 그대로 커밋한다.

**Tech Stack:** Vite + React 18 + TS(strict) + Tailwind + Zustand + Zod. 테스트 vitest + @testing-library/react. 게이트 `pnpm test` + `pnpm build`(`tsc -b && vite build`).

**스펙:** `docs/superpowers/specs/2026-06-01-header-form-bulk-entry-design.md` (spec-plan-reviewer APPROVED-WITH-CHANGES, 모든 지적 반영됨).

**계획 검토:** spec-plan-reviewer(2026-06-01) APPROVED-WITH-CHANGES — `kvBulk` round-trip을 Node 실행 검증(전 케이스 통과), 라인범위·F1 grep·TDD 순서·`useId`/React18 확인. 반영: Finding 2(포커스 이동 = 명시적 연기, self-review 정정)·Finding 3(value placeholder 공유 → aria-label 조회 주석)·Finding 6(Task 4 `fireEvent` top-level import).

---

## 핵심 규약 (모든 task 공통)

- **작업 디렉토리는 항상 `ui/`** — 명령은 `cd /Users/sgj/develop/handicap/ui && ...`.
- **게이트는 수동 UI 게이트**: production 커밋 전 `cd ui && pnpm test` (그 task의 테스트) 그리고 최종 task에서 `pnpm build`. git pre-commit hook은 cargo만 돌린다(Rust 무변경이라 통과하지만 느림) — UI 타입 에러는 **`pnpm build`(`tsc -b`)에서만** 잡히므로 최종 task에서 반드시 실행.
- **TDD 순서 = guard 해제**: 각 task는 **테스트 파일을 먼저** 만든다(test-path 파일이 디스크에 있으면 `.claude/hooks/tdd-guard.sh`가 같은 디렉토리 src 편집을 허용). Task 5는 기존 `Inspector.test.tsx`(이미 test-path)를 편집하므로 자동 해제.
- **`git add`는 명시 경로만** (절대 `git add -A` 금지 — `.claire/`/`.clone/`/`.playwright-mcp/` 미추적 디렉토리 휩쓸림 방지).
- **커밋 메시지 trailer**: 끝에 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **`userEvent`**: 매 `it`마다 `const user = userEvent.setup()`. 리터럴 `{`/`[`는 `{{`/`[[`로 이스케이프(ui/CLAUDE.md). 본 plan의 테스트는 `{{token}}`을 **textarea에 직접 타이핑하지 않고** 객체 리터럴/`fireEvent`로 주입해 이 함정을 피한다.

---

## File Structure

| 파일 | 책임 | task |
|---|---|---|
| `ui/src/scenario/kvBulk.ts` (신규) | `parseBulk`/`formatEntries` 순수 함수(헤더 `:` / 폼 `=`·`&`·urlencoded) | 1 |
| `ui/src/scenario/__tests__/kvBulk.test.ts` (신규) | 위 단위 테스트 + round-trip | 1 |
| `ui/src/scenario/commonHeaders.ts` (신규) | `COMMON_HEADERS` 데이터 + `findCommonHeader` | 2 |
| `ui/src/scenario/__tests__/commonHeaders.test.ts` (신규) | 위 테스트 | 2 |
| `ui/src/components/scenario/BulkEditPanel.tsx` (신규) | Bulk textarea + Apply/Cancel + skip 힌트 | 3 |
| `ui/src/components/scenario/__tests__/BulkEditPanel.test.tsx` (신규) | 위 RTL 테스트 | 3 |
| `ui/src/components/scenario/KeyValueGrid.tsx` (신규) | 2열 그리드 + draft/commit + add-row + Bulk 토글 + 피커(메뉴+datalist) | 4 |
| `ui/src/components/scenario/__tests__/KeyValueGrid.test.tsx` (신규) | 위 RTL 테스트 | 4 |
| `ui/src/components/scenario/Inspector.tsx` (수정: `HeadersEditor` 181–247 / `FormBodyField` 324–385) | `KeyValueGrid`로 교체 | 5 |
| `ui/src/components/scenario/__tests__/Inspector.test.tsx` (수정: 437–472) | placeholder·2-textbox 회귀 테스트 재작성 | 5 |
| `ui/CLAUDE.md` (수정) | 새 함정 노트 | 6 |

---

## Task 1: `kvBulk.ts` — 파싱/포맷 순수 함수

**Files:**
- Create: `ui/src/scenario/kvBulk.ts`
- Test: `ui/src/scenario/__tests__/kvBulk.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/scenario/__tests__/kvBulk.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseBulk, formatEntries } from "../kvBulk";

describe("parseBulk — header", () => {
  it("splits on first colon, trims, keeps colons in value", () => {
    const { entries } = parseBulk("Content-Type: application/json\nX-Url: http://x", "header");
    expect(entries).toEqual({ "Content-Type": "application/json", "X-Url": "http://x" });
  });

  it("skips blank lines (uncounted) and counts separator-less / empty-key lines", () => {
    const { entries, skipped } = parseBulk("A: 1\n\nnoseparator\n: emptykey\nB: 2", "header");
    expect(entries).toEqual({ A: "1", B: "2" });
    expect(skipped).toBe(2);
  });

  it("dedupes last-wins", () => {
    const { entries } = parseBulk("A: 1\nA: 2", "header");
    expect(entries).toEqual({ A: "2" });
  });

  it("does NOT url-decode header values", () => {
    const { entries } = parseBulk("X: a%20b+c", "header");
    expect(entries).toEqual({ X: "a%20b+c" });
  });
});

describe("parseBulk — form", () => {
  it("splits pairs on \\n AND &, each on first '='", () => {
    const { entries } = parseBulk("a=1\nb=2&c=3", "form");
    expect(entries).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("keeps base64 '==' padding (first '=' split, then decode is no-op)", () => {
    const { entries } = parseBulk("token=YWJj==", "form");
    expect(entries).toEqual({ token: "YWJj==" });
  });

  it("url-decodes %XX and + -> space", () => {
    const { entries } = parseBulk("name=John+Doe&city=New%20York", "form");
    expect(entries).toEqual({ name: "John Doe", city: "New York" });
  });

  it("preserves an invalid % sequence verbatim (no throw)", () => {
    const { entries } = parseBulk("x=100%done", "form");
    expect(entries).toEqual({ x: "100%done" });
  });
});

describe("formatEntries <-> parseBulk round-trip", () => {
  it("header round-trips (incl. ':' in value)", () => {
    const m = { "Content-Type": "application/json", Authorization: "Bearer {{token}}", "X-Url": "http://x" };
    expect(parseBulk(formatEntries(m, "header"), "header").entries).toEqual(m);
  });

  it("form round-trips literal values: interior space, %, +, &, =", () => {
    const m = { auth: "Bearer {{token}}", pct: "a%20b", plus: "c+d", amp: "x&y", eq: "k=v" };
    expect(parseBulk(formatEntries(m, "form"), "form").entries).toEqual(m);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/sgj/develop/handicap/ui && pnpm test src/scenario/__tests__/kvBulk.test.ts`
Expected: FAIL — `Failed to resolve import "../kvBulk"` / `parseBulk is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `ui/src/scenario/kvBulk.ts`:

```ts
export type BulkFormat = "header" | "form";

export interface ParseResult {
  entries: Record<string, string>;
  /** Count of separator-less or empty-key lines ignored (blank lines are NOT counted). */
  skipped: number;
}

// Decode one urlencoded token: '+' -> space, then percent-decode.
// `decodeURIComponent` throws on a malformed `%` sequence — preserve verbatim.
function decodeFormToken(s: string): string {
  const plusDecoded = s.replace(/\+/g, " ");
  try {
    return decodeURIComponent(plusDecoded);
  } catch {
    return plusDecoded;
  }
}

export function parseBulk(text: string, format: BulkFormat): ParseResult {
  const out: Record<string, string> = {};
  let skipped = 0;
  const rawPairs = format === "form" ? text.split(/[\n&]/) : text.split(/\n/);
  const sep = format === "form" ? "=" : ":";
  for (const raw of rawPairs) {
    const line = raw.trim();
    if (line === "") continue; // blank: silently skipped, not counted
    const at = line.indexOf(sep);
    if (at < 0) {
      skipped++;
      continue;
    }
    let key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (format === "form") {
      key = decodeFormToken(key);
      value = decodeFormToken(value);
    }
    if (key === "") {
      skipped++;
      continue;
    }
    out[key] = value; // last-wins
  }
  return { entries: out, skipped };
}

// Escape only the chars that would break a round-trip through parseBulk(form).
// `%` MUST be escaped first so our own added escapes are not re-encoded.
// `=` is structural only in the KEY (value uses first-'=' split, so trailing '=' is safe).
function escapeFormToken(s: string, isKey: boolean): string {
  let out = s
    .replace(/%/g, "%25")
    .replace(/\+/g, "%2B")
    .replace(/&/g, "%26")
    .replace(/\n/g, "%0A");
  if (isKey) out = out.replace(/=/g, "%3D");
  // leading/trailing spaces -> %20 (parse trims tokens); interior spaces stay raw.
  out = out.replace(/^ +/, (m) => "%20".repeat(m.length)).replace(/ +$/, (m) => "%20".repeat(m.length));
  return out;
}

export function formatEntries(entries: Record<string, string>, format: BulkFormat): string {
  const pairs = Object.entries(entries);
  if (format === "form") {
    return pairs.map(([k, v]) => `${escapeFormToken(k, true)}=${escapeFormToken(v, false)}`).join("\n");
  }
  return pairs.map(([k, v]) => `${k}: ${v}`).join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/sgj/develop/handicap/ui && pnpm test src/scenario/__tests__/kvBulk.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
cd /Users/sgj/develop/handicap
git add ui/src/scenario/kvBulk.ts ui/src/scenario/__tests__/kvBulk.test.ts
git commit -m "$(cat <<'EOF'
feat(ui): kvBulk — header/form bulk parse+format pure fns

parseBulk(header= first-colon, form= \n/& + first-'=' + urlencoded decode),
formatEntries with minimal structural escaping for form round-trip.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `commonHeaders.ts` — 큐레이션 데이터 + 조회

**Files:**
- Create: `ui/src/scenario/commonHeaders.ts`
- Test: `ui/src/scenario/__tests__/commonHeaders.test.ts`

> **§5 큐레이션 목록은 placeholder** — 사용자가 사내 최종본을 주면 `COMMON_HEADERS` 배열만 교체. `Cookie`는 의도적 제외(ADR-0018 자동 cookie jar).

- [ ] **Step 1: Write the failing test**

Create `ui/src/scenario/__tests__/commonHeaders.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { COMMON_HEADERS, findCommonHeader } from "../commonHeaders";

describe("commonHeaders", () => {
  it("includes core headers with seed values and excludes Cookie", () => {
    const byName = Object.fromEntries(COMMON_HEADERS.map((h) => [h.name, h.value]));
    expect(byName["Content-Type"]).toBe("application/json");
    expect(byName["Authorization"]).toBe("Bearer {{token}}");
    expect(byName["Cookie"]).toBeUndefined();
  });

  it("findCommonHeader matches case-insensitively, trims, returns the canonical entry", () => {
    expect(findCommonHeader("content-type")).toEqual({ name: "Content-Type", value: "application/json" });
    expect(findCommonHeader("  AUTHORIZATION ")).toEqual({ name: "Authorization", value: "Bearer {{token}}" });
    expect(findCommonHeader("X-Not-A-Common-Header")).toBeUndefined();
    expect(findCommonHeader("")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/sgj/develop/handicap/ui && pnpm test src/scenario/__tests__/commonHeaders.test.ts`
Expected: FAIL — cannot resolve `../commonHeaders`.

- [ ] **Step 3: Write minimal implementation**

Create `ui/src/scenario/commonHeaders.ts`:

```ts
export interface CommonHeader {
  name: string;
  value: string;
}

// Placeholder curation (spec §5). Cookie is intentionally excluded (ADR-0018:
// per-VU automatic cookie jar manages the session; a manual Cookie header misleads).
export const COMMON_HEADERS: CommonHeader[] = [
  { name: "Content-Type", value: "application/json" },
  { name: "Accept", value: "application/json" },
  { name: "Authorization", value: "Bearer {{token}}" },
  { name: "Accept-Encoding", value: "gzip, deflate" },
  { name: "Accept-Language", value: "en-US" },
  { name: "Cache-Control", value: "no-cache" },
  { name: "User-Agent", value: "handicap-loadtest" },
  { name: "X-Request-Id", value: "{{requestId}}" },
  { name: "Origin", value: "" },
  { name: "Referer", value: "" },
];

/** Case-insensitive, trimmed lookup. Used for datalist value-seeding only — the
 *  stored key remains the literal the user typed/picked (no case normalization). */
export function findCommonHeader(name: string): CommonHeader | undefined {
  const lower = name.trim().toLowerCase();
  if (lower === "") return undefined;
  return COMMON_HEADERS.find((h) => h.name.toLowerCase() === lower);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/sgj/develop/handicap/ui && pnpm test src/scenario/__tests__/commonHeaders.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/sgj/develop/handicap
git add ui/src/scenario/commonHeaders.ts ui/src/scenario/__tests__/commonHeaders.test.ts
git commit -m "$(cat <<'EOF'
feat(ui): commonHeaders data + findCommonHeader (case-insensitive)

Placeholder curation; Cookie excluded (ADR-0018 auto cookie jar).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `BulkEditPanel` — 벌크 textarea (Postman 전체 교체)

**Files:**
- Create: `ui/src/components/scenario/BulkEditPanel.tsx`
- Test: `ui/src/components/scenario/__tests__/BulkEditPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `ui/src/components/scenario/__tests__/BulkEditPanel.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { BulkEditPanel } from "../BulkEditPanel";

describe("BulkEditPanel", () => {
  it("prepopulates the textarea with current entries (Postman style)", () => {
    render(
      <BulkEditPanel
        entries={{ "Content-Type": "application/json", Accept: "*/*" }}
        format="header"
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const ta = screen.getByLabelText("bulk edit text") as HTMLTextAreaElement;
    expect(ta.value).toBe("Content-Type: application/json\nAccept: */*");
  });

  it("Apply replaces the whole set (deleted lines are dropped)", async () => {
    const onApply = vi.fn();
    render(
      <BulkEditPanel
        entries={{ A: "1", B: "2" }}
        format="header"
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    );
    const ta = screen.getByLabelText("bulk edit text");
    // Replace the whole content with a single line (use fireEvent to avoid
    // userEvent key-descriptor parsing of ':' / braces).
    fireEvent.change(ta, { target: { value: "A: 9\nC: 3" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith({ A: "9", C: "3" }); // B dropped
  });

  it("shows a skip hint for separator-less lines", () => {
    render(<BulkEditPanel entries={{}} format="header" onApply={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("bulk edit text"), { target: { value: "A: 1\ngarbage" } });
    expect(screen.getByText(/1개 건너뜀/)).toBeInTheDocument();
  });

  it("form Apply decodes urlencoded values", async () => {
    const onApply = vi.fn();
    render(<BulkEditPanel entries={{}} format="form" onApply={onApply} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("bulk edit text"), {
      target: { value: "name=John+Doe&city=New%20York" },
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith({ name: "John Doe", city: "New York" });
  });

  it("Cancel calls onCancel and not onApply", async () => {
    const onApply = vi.fn();
    const onCancel = vi.fn();
    render(<BulkEditPanel entries={{}} format="header" onApply={onApply} onCancel={onCancel} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/sgj/develop/handicap/ui && pnpm test src/components/scenario/__tests__/BulkEditPanel.test.tsx`
Expected: FAIL — cannot resolve `../BulkEditPanel`.

- [ ] **Step 3: Write minimal implementation**

Create `ui/src/components/scenario/BulkEditPanel.tsx`:

```tsx
import { useState } from "react";
import { parseBulk, formatEntries, type BulkFormat } from "../../scenario/kvBulk";

interface BulkEditPanelProps {
  entries: Record<string, string>;
  format: BulkFormat;
  onApply: (next: Record<string, string>) => void;
  onCancel: () => void;
}

export function BulkEditPanel({ entries, format, onApply, onCancel }: BulkEditPanelProps) {
  const [text, setText] = useState(() => formatEntries(entries, format));
  const { entries: parsed, skipped } = parseBulk(text, format);
  const hint =
    format === "form"
      ? "한 줄에 key=value, 또는 a=1&b=2 처럼 &로 연결. urlencoded 값은 자동으로 디코딩됩니다."
      : "한 줄에 Header: Value.";

  return (
    <div className="flex flex-col gap-1 min-w-0" aria-label="bulk edit">
      <textarea
        aria-label="bulk edit text"
        className="w-full min-w-0 h-32 border border-slate-300 rounded px-2 py-1 text-xs font-mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <p className="text-xs text-slate-400">{hint}</p>
      {skipped > 0 && <p className="text-xs text-amber-700">구분자 없는 줄 {skipped}개 건너뜀</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className="shrink-0 px-2 py-1 text-xs border border-slate-300 rounded"
          onClick={() => onApply(parsed)}
        >
          Apply
        </button>
        <button
          type="button"
          className="shrink-0 px-2 py-1 text-xs border border-slate-300 rounded"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/sgj/develop/handicap/ui && pnpm test src/components/scenario/__tests__/BulkEditPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/sgj/develop/handicap
git add ui/src/components/scenario/BulkEditPanel.tsx ui/src/components/scenario/__tests__/BulkEditPanel.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): BulkEditPanel — Postman-style full-replace textarea

Prepopulates from current entries; Apply replaces the whole map; skip hint
for separator-less lines; form values url-decoded.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `KeyValueGrid` — 2열 그리드 + draft/commit + add-row + Bulk 토글 + 피커

**Files:**
- Create: `ui/src/components/scenario/KeyValueGrid.tsx`
- Test: `ui/src/components/scenario/__tests__/KeyValueGrid.test.tsx`

**핵심 동작(스펙 §3-1/§4/§6):**
- 로컬 `rows: {key,value}[]` draft. 키스트로크는 로컬만, **onBlur/구조변경 시 `toRecord` 커밋**.
- **재시드 키 = `resetKey`(=step.id)**, `entries` deep-compare 금지(R2).
- `toRecord`: 빈 key 행은 **커밋 map에서 제외**(행 자체는 draft에 유지), dedupe last-wins.
- `commonKeys` 있으면: `자주 쓰는 헤더 ▾` 메뉴(신뢰 경로) + key 칸 `<datalist>` 자동완성(best-effort, 값 시드, **빈 value일 때만**).
- 메뉴 pick: 같은 key(대소문자 무시) 존재 + value 비어있으면 시드, value 차 있으면 **no-op**(A3), 없으면 행 추가.

> **연기(deferred — UX polish, 리뷰 Finding 2)**: 스펙 §3-1 "Enter-add 후 다음 행 key 포커스"·§6 "메뉴 pick 후 value 칸 포커스"의 **포커스 이동은 v1에서 구현하지 않는다**. load-bearing 아님(테스트 없음)이고, 참조한 `EnvironmentPicker` add-row UX에도 포커스 관리가 없다. Enter-to-add 자체는 동작(필드 clear). 후속에서 `useRef`로 추가 가능 — 누락이 아니라 의도적 연기.
> **value 입력 placeholder 공유 주의(리뷰 Finding 3)**: 기존 행과 add-row의 value `<input>`이 같은 `placeholder`(="value")를 가진다. 테스트는 **aria-label**(`${itemLabel} value ${idx}` / `new ${itemLabel} value`)로만 행을 조회할 것 — `getByPlaceholderText("value")`는 다중 매치로 throw.

- [ ] **Step 1: Write the failing test**

Create `ui/src/components/scenario/__tests__/KeyValueGrid.test.tsx`:

```tsx
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { useState } from "react";
import { KeyValueGrid } from "../KeyValueGrid";
import { COMMON_HEADERS } from "../../../scenario/commonHeaders";

function Harness(props: {
  initial?: Record<string, string>;
  withCommon?: boolean;
  format?: "header" | "form";
}) {
  const [entries, setEntries] = useState<Record<string, string>>(props.initial ?? {});
  return (
    <>
      <KeyValueGrid
        entries={entries}
        onChange={setEntries}
        resetKey="step-1"
        bulkFormat={props.format ?? "header"}
        itemLabel="header"
        keyPlaceholder="Header"
        valuePlaceholder="value"
        emptyText="No headers"
        commonKeys={props.withCommon ? COMMON_HEADERS : undefined}
      />
      <pre data-testid="dump">{JSON.stringify(entries)}</pre>
    </>
  );
}

const dump = () => JSON.parse(screen.getByTestId("dump").textContent || "{}");

describe("KeyValueGrid — grid editing", () => {
  it("adds a row via the two-field add row", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText("new header key"), "X-Custom");
    await user.type(screen.getByLabelText("new header value"), "abc");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(dump()).toEqual({ "X-Custom": "abc" });
  });

  it("commits an edited value on blur (not before)", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ A: "1" }} />);
    const value = screen.getByLabelText("header value 0");
    await user.clear(value);
    await user.type(value, "2");
    expect(dump()).toEqual({ A: "1" }); // not committed yet
    await user.tab(); // blur
    expect(dump()).toEqual({ A: "2" });
  });

  it("renames a key on blur", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ A: "1" }} />);
    const key = screen.getByLabelText("header key 0");
    await user.clear(key);
    await user.type(key, "B");
    await user.tab();
    expect(dump()).toEqual({ B: "1" });
  });

  it("removes a row", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ A: "1", B: "2" }} />);
    await user.click(screen.getByRole("button", { name: "Remove header A" }));
    expect(dump()).toEqual({ B: "2" });
  });

  it("dedupes duplicate keys last-wins on commit", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ A: "1" }} />);
    await user.type(screen.getByLabelText("new header key"), "A");
    await user.type(screen.getByLabelText("new header value"), "2");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(dump()).toEqual({ A: "2" });
  });

  it("each row exposes exactly two textboxes with min-w-0 (overflow guard)", async () => {
    render(<Harness initial={{ A: "1" }} />);
    const row = screen.getByRole("button", { name: "Remove header A" }).closest("li")!;
    const inputs = within(row).getAllByRole("textbox");
    expect(inputs).toHaveLength(2);
    inputs.forEach((i) => expect(i).toHaveClass("min-w-0"));
  });
});

describe("KeyValueGrid — bulk edit toggle", () => {
  it("opens prepopulated and Apply replaces the whole map", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ A: "1", B: "2" }} />);
    await user.click(screen.getByRole("button", { name: "Bulk Edit" }));
    const ta = screen.getByLabelText("bulk edit text") as HTMLTextAreaElement;
    expect(ta.value).toBe("A: 1\nB: 2");
    // fireEvent (top-level import) to avoid userEvent ':' descriptor parsing.
    fireEvent.change(ta, { target: { value: "A: 9" } });
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(dump()).toEqual({ A: "9" });
    expect(screen.queryByLabelText("bulk edit text")).not.toBeInTheDocument(); // closed
  });
});

describe("KeyValueGrid — common-header picker", () => {
  it("menu pick adds a row with seeded value", async () => {
    const user = userEvent.setup();
    render(<Harness withCommon />);
    await user.click(screen.getByRole("button", { name: /자주 쓰는 헤더/ }));
    await user.click(screen.getByRole("option", { name: "Content-Type" }));
    expect(dump()).toEqual({ "Content-Type": "application/json" });
  });

  it("menu pick does NOT clobber a non-empty existing value (A3)", async () => {
    const user = userEvent.setup();
    render(<Harness withCommon initial={{ "Content-Type": "text/plain" }} />);
    await user.click(screen.getByRole("button", { name: /자주 쓰는 헤더/ }));
    await user.click(screen.getByRole("option", { name: "Content-Type" }));
    expect(dump()).toEqual({ "Content-Type": "text/plain" });
  });

  it("menu pick seeds value when existing value is empty", async () => {
    const user = userEvent.setup();
    render(<Harness withCommon initial={{ "Content-Type": "" }} />);
    await user.click(screen.getByRole("button", { name: /자주 쓰는 헤더/ }));
    await user.click(screen.getByRole("option", { name: "Content-Type" }));
    expect(dump()).toEqual({ "Content-Type": "application/json" });
  });

  it("typing a known header name into the add-row key seeds the value (onChange branch)", async () => {
    const user = userEvent.setup();
    render(<Harness withCommon />);
    await user.type(screen.getByLabelText("new header key"), "Accept");
    expect(screen.getByLabelText("new header value")).toHaveValue("application/json");
  });

  it("does not render the picker menu when commonKeys is absent", () => {
    render(<Harness />);
    expect(screen.queryByRole("button", { name: /자주 쓰는 헤더/ })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/sgj/develop/handicap/ui && pnpm test src/components/scenario/__tests__/KeyValueGrid.test.tsx`
Expected: FAIL — cannot resolve `../KeyValueGrid`.

- [ ] **Step 3: Write minimal implementation**

Create `ui/src/components/scenario/KeyValueGrid.tsx`:

```tsx
import { useEffect, useId, useState } from "react";
import type { BulkFormat } from "../../scenario/kvBulk";
import { findCommonHeader, type CommonHeader } from "../../scenario/commonHeaders";
import { BulkEditPanel } from "./BulkEditPanel";

interface Row {
  key: string;
  value: string;
}

interface KeyValueGridProps {
  entries: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  /** Re-seed drafts only when this changes (pass step.id) — NOT on every entries change. */
  resetKey: string;
  bulkFormat: BulkFormat;
  /** Singular noun for aria-labels, e.g. "header" / "form field". */
  itemLabel: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  emptyText?: string;
  /** When provided, enables the "자주 쓰는 헤더" menu + key-field datalist seeding. */
  commonKeys?: CommonHeader[];
}

function toRows(entries: Record<string, string>): Row[] {
  return Object.entries(entries).map(([key, value]) => ({ key, value }));
}

function toRecord(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k === "") continue; // empty-key rows are excluded from the committed map (kept in draft)
    out[k] = r.value; // last-wins
  }
  return out;
}

export function KeyValueGrid({
  entries,
  onChange,
  resetKey,
  bulkFormat,
  itemLabel,
  keyPlaceholder,
  valuePlaceholder,
  emptyText,
  commonKeys,
}: KeyValueGridProps) {
  const [rows, setRows] = useState<Row[]>(() => toRows(entries));
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const datalistId = useId();
  const hasCommon = !!commonKeys && commonKeys.length > 0;

  // Re-seed drafts ONLY when the selected step changes (mirror ExtractEditor).
  // Re-seeding on an `entries` deep-compare would clobber in-progress edits (spec R2).
  useEffect(() => {
    setRows(toRows(entries));
    setNewKey("");
    setNewValue("");
    setBulkOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const commit = (next: Row[]) => {
    setRows(next);
    onChange(toRecord(next));
  };
  const commitRows = () => onChange(toRecord(rows)); // onBlur — rows already reflects keystrokes

  const updateValue = (idx: number, value: string) => {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, value } : r)));
  };

  const updateKey = (idx: number, key: string) => {
    setRows((rs) =>
      rs.map((r, i) => {
        if (i !== idx) return r;
        const match = hasCommon ? findCommonHeader(key) : undefined;
        const value = match && r.value.trim() === "" ? match.value : r.value; // best-effort seed
        return { ...r, key, value };
      }),
    );
  };

  const onNewKeyChange = (key: string) => {
    setNewKey(key);
    if (hasCommon) {
      const match = findCommonHeader(key);
      if (match && newValue.trim() === "") setNewValue(match.value); // best-effort seed
    }
  };

  const addRow = () => {
    const k = newKey.trim();
    if (!k) return;
    commit([...rows, { key: k, value: newValue }]);
    setNewKey("");
    setNewValue("");
  };

  const pickCommon = (h: CommonHeader) => {
    const idx = rows.findIndex((r) => r.key.trim().toLowerCase() === h.name.toLowerCase());
    if (idx >= 0) {
      if (rows[idx].value.trim() !== "") return; // A3: don't clobber a user value
      commit(rows.map((r, i) => (i === idx ? { ...r, value: h.value } : r)));
    } else {
      commit([...rows, { key: h.name, value: h.value }]);
    }
  };

  if (bulkOpen) {
    return (
      <BulkEditPanel
        entries={toRecord(rows)}
        format={bulkFormat}
        onApply={(next) => {
          commit(toRows(next));
          setBulkOpen(false);
        }}
        onCancel={() => setBulkOpen(false)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex gap-2 justify-end">
        {hasCommon && <CommonHeaderMenu options={commonKeys!} onPick={pickCommon} />}
        <button
          type="button"
          className="shrink-0 px-2 py-1 text-xs border border-slate-300 rounded"
          onClick={() => setBulkOpen(true)}
        >
          Bulk Edit
        </button>
      </div>

      {hasCommon && (
        <datalist id={datalistId}>
          {commonKeys!.map((h) => (
            <option key={h.name} value={h.name} />
          ))}
        </datalist>
      )}

      <ul className="flex flex-col gap-1">
        {rows.map((r, idx) => (
          <li key={idx} className="flex gap-2 items-center">
            <input
              aria-label={`${itemLabel} key ${idx}`}
              list={hasCommon ? datalistId : undefined}
              className="w-32 min-w-0 border border-slate-300 rounded px-2 py-1 text-xs font-mono"
              value={r.key}
              onChange={(e) => updateKey(idx, e.target.value)}
              onBlur={commitRows}
            />
            <span className="text-slate-400 text-xs">=</span>
            <input
              aria-label={`${itemLabel} value ${idx}`}
              className="flex-1 min-w-0 border border-slate-300 rounded px-2 py-1 text-xs"
              placeholder={valuePlaceholder}
              value={r.value}
              onChange={(e) => updateValue(idx, e.target.value)}
              onBlur={commitRows}
            />
            <button
              type="button"
              aria-label={`Remove ${itemLabel} ${r.key}`}
              className="text-slate-500 hover:text-red-600 shrink-0"
              onClick={() => commit(rows.filter((_, i) => i !== idx))}
            >
              ×
            </button>
          </li>
        ))}
        {rows.length === 0 && (
          <li className="text-xs text-slate-400 italic">{emptyText ?? "No entries"}</li>
        )}
      </ul>

      <div className="flex gap-2 mt-1">
        <input
          aria-label={`new ${itemLabel} key`}
          list={hasCommon ? datalistId : undefined}
          className="w-32 min-w-0 border border-slate-300 rounded px-2 py-1 text-xs font-mono"
          placeholder={keyPlaceholder}
          value={newKey}
          onChange={(e) => onNewKeyChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addRow();
          }}
        />
        <span className="text-slate-400 text-xs">=</span>
        <input
          aria-label={`new ${itemLabel} value`}
          className="flex-1 min-w-0 border border-slate-300 rounded px-2 py-1 text-xs"
          placeholder={valuePlaceholder}
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addRow();
          }}
        />
        <button
          type="button"
          className="shrink-0 px-2 py-1 text-xs border border-slate-300 rounded disabled:opacity-50"
          disabled={!newKey.trim()}
          onClick={addRow}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function CommonHeaderMenu({
  options,
  onPick,
}: {
  options: CommonHeader[];
  onPick: (h: CommonHeader) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="shrink-0 px-2 py-1 text-xs border border-slate-300 rounded"
        onClick={() => setOpen((o) => !o)}
      >
        자주 쓰는 헤더 ▾
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label="자주 쓰는 헤더"
          className="absolute right-0 z-10 mt-1 max-h-60 w-56 overflow-auto bg-white border border-slate-300 rounded shadow text-xs"
        >
          {options.map((h) => (
            <li key={h.name}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="block w-full text-left px-3 py-1 hover:bg-slate-100 font-mono"
                onClick={() => {
                  setOpen(false);
                  onPick(h);
                }}
              >
                {h.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/sgj/develop/handicap/ui && pnpm test src/components/scenario/__tests__/KeyValueGrid.test.tsx`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
cd /Users/sgj/develop/handicap
git add ui/src/components/scenario/KeyValueGrid.tsx ui/src/components/scenario/__tests__/KeyValueGrid.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): KeyValueGrid — shared 2-col grid + bulk toggle + header picker

Local draft + onBlur commit (ExtractEditor pattern), re-seed by resetKey
(not entries), editable key+value, dedupe last-wins, empty-key rows excluded.
commonKeys enables 자주 쓰는 헤더 menu (no-clobber) + datalist seed (best-effort).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `HeadersEditor`/`FormBodyField` 교체 + 회귀 테스트 재작성 (F1)

**Files:**
- Modify: `ui/src/components/scenario/Inspector.tsx` (`HeadersEditor` 181–247, `FormBodyField` 324–385)
- Modify: `ui/src/components/scenario/__tests__/Inspector.test.tsx` (437–472)

> **F1**: 기존 회귀 테스트는 `getByPlaceholderText("Header-Name")`와 "행에 textbox 1개" 가정에 의존 → placeholder가 `Header`로 바뀌고 행에 textbox가 2개가 되므로 **반드시 재작성**. (이 두 테스트 외에 header/form 마크업을 건드리는 테스트는 없음 — 확인 완료.)

- [ ] **Step 1: Rewrite the regression tests first (failing against current code)**

In `ui/src/components/scenario/__tests__/Inspector.test.tsx`, replace the two `it(...)` blocks inside `describe("Inspector — narrow-column overflow guard (#1)", ...)` (currently lines ~437–472) with:

```tsx
  it("keeps Headers row inputs/buttons shrinkable so the Request fieldset can't overflow", async () => {
    const user = userEvent.setup();
    loadAndSelect();
    render(<Inspector />);

    // The Request fieldset is a flex item in the narrow aside; min-w-0 lets it shrink.
    expect(screen.getByPlaceholderText("Header").closest("fieldset")).toHaveClass("min-w-0");

    // Two-field add row.
    const addKey = screen.getByPlaceholderText("Header");
    expect(addKey).toHaveClass("min-w-0");
    const addBtn = within(addKey.closest("div")!).getByRole("button", { name: "Add" });
    expect(addBtn).toHaveClass("shrink-0");

    // Add a non-common header (avoids datalist value-seeding) so a value row renders.
    await user.type(addKey, "X-Custom");
    await user.click(addBtn);
    const removeBtn = screen.getByRole("button", { name: "Remove header X-Custom" });
    const row = removeBtn.closest("li")!;
    const inputs = within(row).getAllByRole("textbox");
    expect(inputs).toHaveLength(2); // key + value
    inputs.forEach((i) => expect(i).toHaveClass("min-w-0"));
    expect(removeBtn).toHaveClass("shrink-0");
  });

  it("keeps form-body row inputs/buttons shrinkable too", async () => {
    const user = userEvent.setup();
    loadAndSelect();
    render(<Inspector />);

    await user.selectOptions(screen.getByDisplayValue("none"), "form");
    const addField = screen.getByPlaceholderText("field");
    expect(addField).toHaveClass("min-w-0");
    expect(within(addField.closest("div")!).getByRole("button", { name: "Add" })).toHaveClass(
      "shrink-0",
    );
  });
```

- [ ] **Step 2: Run the rewritten tests to verify they FAIL against current code**

Run: `cd /Users/sgj/develop/handicap/ui && pnpm test src/components/scenario/__tests__/Inspector.test.tsx -t "overflow guard"`
Expected: FAIL — `Unable to find an element with the placeholder text of: Header` (current code still uses `Header-Name` + single-input rows).

- [ ] **Step 3: Rewrite `HeadersEditor` and `FormBodyField` to use `KeyValueGrid`**

In `ui/src/components/scenario/Inspector.tsx`:

First add imports near the top (after the existing model imports, around line 14):

```tsx
import { KeyValueGrid } from "./KeyValueGrid";
import { COMMON_HEADERS } from "../../scenario/commonHeaders";
```

Replace the entire `HeadersEditor` function (181–247) with:

```tsx
function HeadersEditor({ step }: { step: HttpStep }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  return (
    <div className="min-w-0">
      <div className="text-xs font-semibold text-slate-600 mb-1">Headers</div>
      <KeyValueGrid
        entries={step.request.headers ?? {}}
        onChange={(next) => setStepField(step.id, ["request", "headers"], next)}
        resetKey={step.id}
        bulkFormat="header"
        itemLabel="header"
        keyPlaceholder="Header"
        valuePlaceholder="value"
        emptyText="No headers"
        commonKeys={COMMON_HEADERS}
      />
    </div>
  );
}
```

Replace the entire `FormBodyField` function (324–385) with:

```tsx
function FormBodyField({ step }: { step: HttpStep }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const body = step.request.body;
  const map = body?.kind === "form" ? body.value : {};
  return (
    <KeyValueGrid
      entries={map ?? {}}
      onChange={(next) => setStepField(step.id, ["request", "body"], { form: next })}
      resetKey={step.id}
      bulkFormat="form"
      itemLabel="form field"
      keyPlaceholder="field"
      valuePlaceholder="value"
      emptyText="No fields"
    />
  );
}
```

> M1: `step.request.headers ?? {}` is required — `RequestModel.headers` has `.default({})` so its inferred type widens to `Record<string,string> | undefined` under `tsc -b` (caught only by `pnpm build`).

- [ ] **Step 4: Run the rewritten tests to verify they PASS**

Run: `cd /Users/sgj/develop/handicap/ui && pnpm test src/components/scenario/__tests__/Inspector.test.tsx`
Expected: PASS (whole Inspector suite green — the extract/condition tests are untouched).

- [ ] **Step 5: Commit**

```bash
cd /Users/sgj/develop/handicap
git add ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/__tests__/Inspector.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): Inspector Headers/Form-body use KeyValueGrid

HeadersEditor/FormBodyField now wrap the shared grid (bulk + header picker).
Rewrite the two narrow-column overflow-guard tests for the new placeholder
("Header") and two-textbox rows (F1).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 전체 게이트 + 함정 노트

**Files:**
- Modify: `ui/CLAUDE.md`

- [ ] **Step 1: Run the full UI test suite**

Run: `cd /Users/sgj/develop/handicap/ui && pnpm test`
Expected: PASS — all suites green (new kvBulk/commonHeaders/BulkEditPanel/KeyValueGrid + existing Inspector/RunDialog/etc.).

- [ ] **Step 2: Run the type/build gate (catches tsc-only errors like the `.default({})` leak)**

Run: `cd /Users/sgj/develop/handicap/ui && pnpm build`
Expected: PASS — `tsc -b` clean, `vite build` produces `dist/`. If `tsc -b` errors on `Record<string,string> | undefined` at `HeadersEditor`, confirm the `?? {}` from Task 5 Step 3 is present.

- [ ] **Step 3: Add the trap note to `ui/CLAUDE.md`**

In `ui/CLAUDE.md`, under the `## 폼·입력 UX / 진단 표시 (RunDialog, RunDetail)` section, append:

```markdown
- **`KeyValueGrid`는 Headers/Form-body 공유 KV 편집기 (2열 그리드 + Bulk Edit + 헤더 피커)** (Header/Form 벌크): `HeadersEditor`/`FormBodyField`가 이걸 감싼다. 로컬 `rows` draft + **onBlur 커밋**(ExtractEditor 패턴), 재시드 키는 **`resetKey`(=step.id)**뿐 — `entries` deep-compare로 재시드하면 self-commit re-derive가 진행 중 편집을 리셋한다. `toRecord`는 빈 key 행을 **커밋 map에서만 제외**(행은 draft 유지). **그리드 입력은 리터럴, 벌크(form)만 urlencoded 디코딩**(`kvBulk.ts`) — 그리드 값을 디코딩하면 `+`/`%` 든 리터럴 `{{var}}`가 깨진다. 헤더 값 시드: 메뉴(`자주 쓰는 헤더 ▾`, 신뢰 경로, value 비었을 때만·no-clobber)와 key 칸 `<datalist>`(best-effort — jsdom·일부 브라우저는 pick이 onChange 안 쏨). 벌크 테스트는 `:`·`{{}}` 입력에 `userEvent.type` 대신 `fireEvent.change`(키 디스크립터 함정 회피). Headers는 `step.request.headers ?? {}`로 넘겨야 함(`.default({})` 누출, `tsc -b`만 잡음).
```

- [ ] **Step 4: Commit**

```bash
cd /Users/sgj/develop/handicap
git add ui/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(ui): KeyValueGrid 함정 노트 (draft/commit·resetKey·디코딩 비대칭)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Final verification (evidence before done)**

Run: `cd /Users/sgj/develop/handicap/ui && pnpm test && pnpm build`
Expected: both PASS. Record the test count + build success in the completion report.

---

## Self-Review (writer)

**1. Spec coverage:**
- §1/§3-1 2열 그리드 + draft/commit + editable key → Task 4. ✅ (단 "Enter-add 후 다음 행 포커스"는 **연기** — Finding 2, UX polish)
- §1/§3-2 Bulk Edit Postman 전체 교체 → Task 3 + Task 4 토글. ✅
- §3-3 `commonHeaders.ts` + `findCommonHeader` → Task 2. ✅
- §4 파싱/포맷(header `:`, form `\n`/`&`/`=`/urlencoded, round-trip escape) → Task 1. ✅
- §5 큐레이션 placeholder + Cookie 제외 → Task 2. ✅
- §6 메뉴(no-clobber) + datalist 시드(best-effort) → Task 4. ✅ (단 "pick 후 value 칸 포커스"는 **연기** — Finding 2, UX polish)
- §3-4/M1 `?? {}` 누출 → Task 5 Step 3 + Task 6 build gate. ✅
- §8 F1 회귀 재작성 → Task 5. ✅; R4 round-trip 케이스(공백·%·+) → Task 1 round-trip test. ✅; M3 `{`/`:` 이스케이프 → fireEvent 사용. ✅; M5 2-textbox getAllByRole → Task 4/5 tests. ✅; R1 datalist onChange-branch only → Task 4 test. ✅
- §7 non-goals(JSON/raw 무변경, 대소문자 미정규화, 멀티값 미지원, 백엔드 무변경) — 계획이 건드리지 않음. ✅

**2. Placeholder scan:** 코드 placeholder 없음. §5 큐레이션은 의도된 placeholder 데이터(스펙 명시) — Task 2에 실제 기본 목록이 들어가 컴파일/동작함, "TODO" 아님.

**3. Type consistency:** `parseBulk`/`formatEntries`/`BulkFormat`(Task 1) ↔ `BulkEditPanel`(Task 3) ↔ `KeyValueGrid`(Task 4) 시그니처 일치. `CommonHeader`/`findCommonHeader`/`COMMON_HEADERS`(Task 2) ↔ 사용처 일치. `KeyValueGrid` props(`entries/onChange/resetKey/bulkFormat/itemLabel/keyPlaceholder/valuePlaceholder/emptyText/commonKeys`) ↔ Task 5 wrapper 호출 일치. aria-label 규약(`${itemLabel} key ${idx}` 등) ↔ 테스트 셀렉터 일치.

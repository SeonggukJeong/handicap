# Test Run 본문 뷰어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** test-run 결과의 HTTP 요청/응답 본문을 인라인은 앞 500자 미리보기로만 보여주고, 전체는 복사·JSON 포맷·줄바꿈 토글이 달린 모달에서 보게 한다.

**Architecture:** 엔진 응답 캡 상수(`MAX_TRACE_BODY_BYTES`)를 16 KiB→1 MiB로 올려 모달이 더 큰 본문을 받게 한다(와이어/스키마 무변경). UI는 (a) 코드베이스 최초의 접근성 모달 프리미티브 `Modal.tsx`, (b) 요청·응답 공용 `BodyBlock`(짧으면 인라인, 길면 500자 미리보기+모달)을 추가하고 `TestRunPanel.HttpRow`의 두 `<pre>`를 교체한다.

**Tech Stack:** Rust(engine, `wiremock` 테스트) / React+TS(`createPortal`, Tailwind, vitest+RTL+user-event).

**근거 spec:** `docs/superpowers/specs/2026-06-03-test-run-body-viewer-design.md` (spec-reviewer APPROVE-WITH-FIXES 반영 완료).

---

## 실행 전 (워크트리/베이스라인)

- 이 작업은 엔진(Rust) + UI 둘 다 건드린다. repo 컨벤션상 `.claude/worktrees/<name>` 워크트리에서 진행(`superpowers:using-git-worktrees`).
- **fresh 워크트리면** subagent 띄우기 전에 baseline부터: `cd ui && pnpm install` + `cargo build -p handicap-worker && cargo build --workspace`(cold-build flake 예방, 루트 CLAUDE.md). 메인 체크아웃에서 진행하면 이미 깔려 있음.
- **커밋 함정(루트 CLAUDE.md)**: 비-`.md` 커밋마다 pre-commit이 전체 cargo workspace(build+clippy+test, e2e 포함)를 돌려 수 분 걸린다. UI-only 변경도 동일. `git commit`은 파이프(`| tail`) 없이 돌리고 직후 `git log -1`로 landed 확인. implementer subagent의 commit은 **foreground 단일 호출**(`run_in_background:false`, timeout 600000ms, 폴링 금지).
- **UI 게이트는 hook이 안 돌린다**: UI를 만진 task는 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build`를 **직접** 돌린다(`pnpm test`=esbuild는 TS-strict를 못 잡고, `pnpm lint`=`--max-warnings=0`는 hook에 없음).

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `crates/engine/src/executor.rs` | trace 응답 캡 | `MAX_TRACE_BODY_BYTES` 16 KiB→1 MiB + doc 주석 + 인라인 테스트 2개 |
| `ui/src/components/Modal.tsx` | 접근성 모달 프리미티브(portal/Escape/focus-trap/restore) | **신규** |
| `ui/src/components/__tests__/Modal.test.tsx` | Modal 동작 테스트 | **신규** |
| `ui/src/components/scenario/TestRunPanel.tsx` | `INLINE_PREVIEW_CHARS` + `BodyBlock` + `BodyViewer` + `HttpRow` 배선 | 수정 |
| `ui/src/components/scenario/__tests__/TestRunPanel.test.tsx` | 미리보기/모달/토글/복사/배너 테스트 | 수정 |

proto·controller·worker·`ui/src/api/schemas.ts`·DB 마이그레이션 **무변경**. `docs/roadmap.md`는 spec 단계에서 이미 갱신됨 — **plan에서 건드리지 말 것**.

---

## Task 1: 엔진 응답 캡 16 KiB → 1 MiB

**Files:**
- Modify: `crates/engine/src/executor.rs:229-230` (const + doc), `crates/engine/src/executor.rs` 내 `#[cfg(test)] mod tests` (테스트 2개 추가)

테스트 하네스: 같은 모듈의 기존 테스트가 `wiremock`(`MockServer::start()`, `Mock::given(method("GET")).and(path(...)).respond_with(ResponseTemplate::new(...))`)과 `execute_step_traced(&client, &step, &ctx)`를 쓴다(예: `executor.rs:735-774`). `MAX_TRACE_BODY_BYTES`는 같은 파일 모듈 상수라 테스트에서 그대로 참조 가능.

- [ ] **Step 1: 실패 테스트 2개 추가**

`#[cfg(test)] mod tests` 안(기존 `traced_step_*` 테스트들 근처)에 추가. `MockServer`/`Mock`/`method`/`path`/`ResponseTemplate`/`empty_env`/`VuClient`/`TemplateContext`/`HttpStep`/`Request`/`HttpMethod`/`DisabledRows`는 그 모듈이 이미 import/사용 중.

```rust
    #[tokio::test]
    async fn traced_body_under_cap_is_not_truncated() {
        // 17 KiB ASCII — old 16 KiB cap WOULD truncate (RED), 1 MiB cap does not.
        let big = "a".repeat(17 * 1024);
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/big"))
            .respond_with(ResponseTemplate::new(200).set_body_string(big.clone()))
            .mount(&server)
            .await;
        let step = HttpStep {
            id: "01HX0000000000000000000021".into(),
            name: "big".into(),
            request: Request {
                method: HttpMethod::Get,
                url: format!("{}/big", server.uri()),
                headers: BTreeMap::new(),
                body: None,
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![],
            timeout_seconds: None,
        };
        let vars = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let client = VuClient::new(crate::scenario::CookieJarMode::Off).unwrap();
        let t = execute_step_traced(&client, &step, &ctx).await;
        let resp = t.response.expect("response captured");
        assert!(!resp.body_truncated, "17 KiB must fit under the 1 MiB cap");
        assert_eq!(resp.body.len(), 17 * 1024);
    }

    #[tokio::test]
    async fn traced_body_over_cap_is_truncated() {
        // cap + 1 KiB ASCII — must truncate at the cap, byte-length robust to U+FFFD.
        let big = "a".repeat(MAX_TRACE_BODY_BYTES + 1024);
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/huge"))
            .respond_with(ResponseTemplate::new(200).set_body_string(big))
            .mount(&server)
            .await;
        let step = HttpStep {
            id: "01HX0000000000000000000022".into(),
            name: "huge".into(),
            request: Request {
                method: HttpMethod::Get,
                url: format!("{}/huge", server.uri()),
                headers: BTreeMap::new(),
                body: None,
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![],
            timeout_seconds: None,
        };
        let vars = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let client = VuClient::new(crate::scenario::CookieJarMode::Off).unwrap();
        let t = execute_step_traced(&client, &step, &ctx).await;
        let resp = t.response.expect("response captured");
        assert!(resp.body_truncated, "body over cap must be truncated");
        // from_utf8_lossy can add a U+FFFD (3 bytes) at the boundary → not strict ==.
        assert!(resp.body.len() <= MAX_TRACE_BODY_BYTES + 2);
    }
```

- [ ] **Step 2: 테스트 실행 → RED 확인**

Run: `cargo test -p handicap-engine traced_body_under_cap_is_not_truncated`
Expected: FAIL — 현재 16 KiB 캡이라 17 KiB 본문이 `body_truncated == true`로 잘려 `assert!(!resp.body_truncated)`가 깨진다. (`traced_body_over_cap_is_truncated`는 이미 PASS — 경계 회귀 가드.)

- [ ] **Step 3: 캡 상수 + doc 주석 변경**

`crates/engine/src/executor.rs:229-230`:
```rust
/// Response bodies larger than this are truncated in the trace (UI display cap).
const MAX_TRACE_BODY_BYTES: usize = 16 * 1024;
```
→
```rust
/// Response bodies larger than this are truncated in the trace. UI display cap:
/// the editor shows a short inline preview and the full body in a modal. Per-step,
/// so worst-case trace memory ≈ max_requests × this. Future: expose via an options
/// menu (see docs/roadmap.md §B2'' "운영 상한 관리자 화면").
const MAX_TRACE_BODY_BYTES: usize = 1024 * 1024;
```

- [ ] **Step 4: 테스트 실행 → GREEN 확인**

Run: `cargo test -p handicap-engine traced_body_`
Expected: 두 테스트 모두 PASS.

- [ ] **Step 5: warm 빌드 후 커밋 (single foreground commit)**

cold-build flake 예방(루트 CLAUDE.md): 먼저 `cargo build -p handicap-worker && cargo build --workspace`로 warm.
```bash
git add crates/engine/src/executor.rs
git commit -m "feat(engine): trace 응답 캡 16 KiB→1 MiB (MAX_TRACE_BODY_BYTES)"
```
직후 `git log -1 --oneline`로 landed 확인. pre-commit이 전체 workspace를 돌리므로 수 분 소요 — 폴링 말고 단일 blocking 호출.

---

## Task 2: 접근성 모달 프리미티브 `Modal.tsx`

**Files:**
- Create: `ui/src/components/__tests__/Modal.test.tsx`
- Create: `ui/src/components/Modal.tsx`

**TDD-guard 순서**: 새 src 파일 `Modal.tsx`는 pending test-path 파일이 있어야 Write가 통과한다 → **테스트 파일 먼저**.

- [ ] **Step 1: 테스트 파일 작성(아직 `Modal.tsx` 없음 → import 에러로 RED)**

`ui/src/components/__tests__/Modal.test.tsx`:
```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "../Modal";

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          onClose();
        }}
        title="본문"
      >
        <p>modal content</p>
      </Modal>
    </div>
  );
}

describe("Modal", () => {
  it("renders nothing until opened, then shows a labelled dialog", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "open" }));
    const dialog = screen.getByRole("dialog", { name: "본문" });
    expect(within(dialog).getByText("modal content")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "open" }));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on backdrop click but not on panel click", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "open" }));
    // panel click does not close
    await user.click(screen.getByText("modal content"));
    expect(onClose).not.toHaveBeenCalled();
    // explicit close button closes
    await user.click(screen.getByRole("button", { name: "닫기" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the trigger after close", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "open" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });
});
```

- [ ] **Step 2: 테스트 실행 → RED 확인**

Run: `cd ui && pnpm test -- Modal`
Expected: FAIL — `Cannot find module '../Modal'`(파일 없음).

- [ ] **Step 3: `Modal.tsx` 구현**

`ui/src/components/Modal.tsx`:
```tsx
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Accessible modal dialog: portal into document.body, Escape + backdrop-click to
 * close, focus trap, and focus restore to the previously-focused element.
 * `onClose` is held in a ref so the open-effect runs only on `open` toggles
 * (no re-subscribe / focus jump on every parent render).
 */
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab" && panel) {
        const focusable = panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg bg-white shadow-xl outline-none"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100"
          >
            ✕
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 4: 테스트 실행 → GREEN 확인**

Run: `cd ui && pnpm test -- Modal`
Expected: 4 테스트 PASS.

- [ ] **Step 5: UI 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0 warning, 테스트 all pass, `tsc -b` clean.
```bash
git add ui/src/components/Modal.tsx ui/src/components/__tests__/Modal.test.tsx
git commit -m "feat(ui): 접근성 모달 프리미티브 Modal (portal/Escape/focus-trap/restore)"
```
foreground 단일 호출 + `git log -1` 확인.

---

## Task 3: `BodyBlock` 미리보기 + 모달 뷰어 + `HttpRow` 배선

**Files:**
- Modify: `ui/src/components/scenario/__tests__/TestRunPanel.test.tsx` (테스트 추가)
- Modify: `ui/src/components/scenario/TestRunPanel.tsx` (import + `INLINE_PREVIEW_CHARS` + `BodyBlock` + `BodyViewer` + `HttpRow` 2곳 교체)

`TestRunPanel.test.tsx`가 이미 있어 `TestRunPanel.tsx` 편집은 TDD-guard unblock. **테스트 먼저** 추가.

http 행은 기본 접혀 있어(`HttpRow`의 `open` state) 본문은 행을 클릭해 펼친 뒤 보인다 — 새 테스트는 url 텍스트를 클릭해 펼친다.

- [ ] **Step 1: 실패 테스트 추가**

`TestRunPanel.test.tsx` 상단 import에 `within`, `userEvent` 추가하고(기존 `import { render, screen } from "@testing-library/react";` → `import { render, screen, within } from "@testing-library/react";` + `import userEvent from "@testing-library/user-event";`), `describe` 블록 안에 helper + 테스트 추가:

```tsx
  // jsdom has no navigator.clipboard and it's read-only → install a configurable mock.
  function mockClipboard() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    return writeText;
  }

  function httpTrace(resp: Partial<ScenarioTrace["steps"][number]["response"]> & { body: string }, reqBody?: string): ScenarioTrace {
    return {
      ok: true,
      total_ms: 1,
      truncated: false,
      error: null,
      final_vars: {},
      steps: [
        {
          step_id: "01HX0000000000000000000031",
          kind: "http",
          loop_index: null,
          branch: null,
          request: { method: "GET", url: "http://api/x", headers: {}, body: reqBody ?? null },
          response: {
            status: 200,
            latency_ms: 1,
            headers: {},
            set_cookies: [],
            body_truncated: false,
            ...resp,
          },
          extracted: {},
          unbound_vars: [],
          error: null,
        },
      ],
    };
  }

  async function expandRow(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByText("http://api/x"));
  }

  it("shows a short response body inline without a 전체 보기 button", async () => {
    const user = userEvent.setup();
    render(<TestRunPanel trace={httpTrace({ body: "short body" })} />);
    await expandRow(user);
    expect(screen.getByText("short body")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "전체 보기" })).not.toBeInTheDocument();
  });

  it("previews a long response body and opens the full body in a modal", async () => {
    const user = userEvent.setup();
    const long = "x".repeat(600);
    render(<TestRunPanel trace={httpTrace({ body: long })} />);
    await expandRow(user);
    // inline preview is the first 500 chars + ellipsis, not the full body
    expect(screen.getByText(`${"x".repeat(500)}…`)).toBeInTheDocument();
    expect(screen.queryByText(long)).not.toBeInTheDocument();
    // open modal → full body present
    await user.click(screen.getByRole("button", { name: "전체 보기" }));
    const dialog = screen.getByRole("dialog", { name: "응답 본문" });
    expect(within(dialog).getByText(long)).toBeInTheDocument();
  });

  it("offers a JSON format toggle only for valid JSON bodies", async () => {
    const user = userEvent.setup();
    const json = JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ id: i, name: "row" })));
    render(<TestRunPanel trace={httpTrace({ body: json })} />);
    await expandRow(user);
    await user.click(screen.getByRole("button", { name: "전체 보기" }));
    const dialog = screen.getByRole("dialog", { name: "응답 본문" });
    const fmt = within(dialog).getByRole("button", { name: "JSON 포맷" });
    await user.click(fmt);
    // pretty-printed output contains indentation newlines
    expect(within(dialog).getByText(/\n  /)).toBeInTheDocument();
  });

  it("has no JSON format toggle for a non-JSON body", async () => {
    const user = userEvent.setup();
    render(<TestRunPanel trace={httpTrace({ body: "x".repeat(600) })} />);
    await expandRow(user);
    await user.click(screen.getByRole("button", { name: "전체 보기" }));
    const dialog = screen.getByRole("dialog", { name: "응답 본문" });
    expect(within(dialog).queryByRole("button", { name: "JSON 포맷" })).not.toBeInTheDocument();
  });

  it("copies the displayed body text", async () => {
    const writeText = mockClipboard();
    const user = userEvent.setup();
    const long = "x".repeat(600);
    render(<TestRunPanel trace={httpTrace({ body: long })} />);
    await expandRow(user);
    await user.click(screen.getByRole("button", { name: "전체 보기" }));
    const dialog = screen.getByRole("dialog", { name: "응답 본문" });
    await user.click(within(dialog).getByRole("button", { name: "복사" }));
    expect(writeText).toHaveBeenCalledWith(long);
  });

  it("shows the truncated banner in the modal when body_truncated", async () => {
    const user = userEvent.setup();
    render(<TestRunPanel trace={httpTrace({ body: "x".repeat(600), body_truncated: true })} />);
    await expandRow(user);
    await user.click(screen.getByRole("button", { name: "전체 보기" }));
    const dialog = screen.getByRole("dialog", { name: "응답 본문" });
    expect(within(dialog).getByText(/잘림/)).toBeInTheDocument();
  });

  it("previews and modals a long request body too", async () => {
    const user = userEvent.setup();
    const longReq = "r".repeat(600);
    render(<TestRunPanel trace={httpTrace({ body: "ok" }, longReq)} />);
    await expandRow(user);
    await user.click(screen.getByRole("button", { name: "전체 보기" }));
    expect(screen.getByRole("dialog", { name: "요청 본문" })).toBeInTheDocument();
  });
```

`vi`를 import에 추가: 기존 `import { describe, expect, it } from "vitest";` → `import { describe, expect, it, vi } from "vitest";`.

- [ ] **Step 2: 테스트 실행 → RED 확인**

Run: `cd ui && pnpm test -- TestRunPanel`
Expected: 새 테스트 FAIL(아직 BodyBlock/모달 없음 — "전체 보기" 버튼·dialog 없음). 기존 3개는 그대로 PASS.

- [ ] **Step 3: `TestRunPanel.tsx` 구현**

(a) import 교체 — 파일 상단:
```tsx
import { useMemo, useState } from "react";
import type { ScenarioTrace, StepTrace } from "../../api/schemas";
import { findStepById, isIfStep, summarizeCondition, type Step } from "../../scenario/model";
import { Modal } from "../Modal";
```
(`react`에 `useMemo` 추가, `../Modal` import 추가.)

(b) 파일 상단(첫 컴포넌트 위)에 상수 + 두 컴포넌트 추가:
```tsx
// Future: expose via an options menu (docs/roadmap.md §B2''). JS string units (UTF-16
// code points), distinct from the engine's byte cap.
const INLINE_PREVIEW_CHARS = 500;

/** Modal content: full body + copy / JSON-format / word-wrap toolbar. Only mounts
 *  when the modal is open, so JSON.parse runs at most once per open (memoized). */
function BodyViewer({ body, truncated }: { body: string; truncated: boolean }) {
  const [formatted, setFormatted] = useState(false);
  const [wrap, setWrap] = useState(true);
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return null;
    }
  }, [body]);
  const text = formatted && pretty != null ? pretty : body;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {truncated && (
        <div className="rounded bg-amber-100 px-3 py-2 text-xs text-amber-800">
          1 MiB에서 잘림 — 실제 응답은 더 큼
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => navigator.clipboard?.writeText(text)}
          className="rounded bg-slate-200 px-2 py-0.5 text-xs hover:bg-slate-300"
        >
          복사
        </button>
        {pretty != null && (
          <button
            type="button"
            aria-pressed={formatted}
            onClick={() => setFormatted((f) => !f)}
            className="rounded bg-slate-200 px-2 py-0.5 text-xs hover:bg-slate-300"
          >
            {formatted ? "원본" : "JSON 포맷"}
          </button>
        )}
        <button
          type="button"
          aria-pressed={wrap}
          onClick={() => setWrap((w) => !w)}
          className="rounded bg-slate-200 px-2 py-0.5 text-xs hover:bg-slate-300"
        >
          {wrap ? "줄바꿈: 켜짐" : "줄바꿈: 꺼짐"}
        </button>
      </div>
      <pre
        className={[
          "min-h-0 flex-1 overflow-auto rounded bg-slate-50 p-3 text-xs",
          wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
        ].join(" ")}
      >
        {text}
      </pre>
    </div>
  );
}

/** Request/response body block: inline-full when short, else a 500-char preview
 *  with a "전체 보기" button that opens the full body in a modal. */
function BodyBlock({
  body,
  truncated = false,
  label,
}: {
  body: string;
  truncated?: boolean;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  if (!body) return null;
  const isLong = body.length > INLINE_PREVIEW_CHARS || truncated;
  if (!isLong) {
    return (
      <pre className="mb-2 whitespace-pre-wrap break-all rounded bg-white p-2 text-xs">{body}</pre>
    );
  }
  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs text-slate-500">
          {label} · {body.length.toLocaleString()}자{truncated ? " (잘림)" : ""}
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded bg-slate-200 px-2 py-0.5 text-xs hover:bg-slate-300"
        >
          전체 보기
        </button>
      </div>
      <pre className="whitespace-pre-wrap break-all rounded bg-white p-2 text-xs">
        {body.slice(0, INLINE_PREVIEW_CHARS)}…
      </pre>
      <Modal open={open} onClose={() => setOpen(false)} title={label}>
        <BodyViewer body={body} truncated={truncated} />
      </Modal>
    </div>
  );
}
```

(c) `HttpRow`의 요청 본문 블록 교체 — 현재:
```tsx
              {req.body && (
                <pre className="mb-2 whitespace-pre-wrap break-all rounded bg-white p-2 text-xs">
                  {req.body}
                </pre>
              )}
```
→
```tsx
              {req.body && <BodyBlock body={req.body} label="요청 본문" />}
```

(d) `HttpRow`의 응답 본문 블록 교체 — 현재:
```tsx
              <pre className="whitespace-pre-wrap break-all rounded bg-white p-2 text-xs">
                {resp.body}
                {resp.body_truncated ? "\n… (truncated)" : ""}
              </pre>
```
→
```tsx
              <BodyBlock body={resp.body} truncated={resp.body_truncated} label="응답 본문" />
```

- [ ] **Step 4: 테스트 실행 → GREEN 확인**

Run: `cd ui && pnpm test -- TestRunPanel`
Expected: 기존 3 + 신규 7 테스트 모두 PASS.

- [ ] **Step 5: UI 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0 warning, 테스트 all pass, `tsc -b` clean.
```bash
git add ui/src/components/scenario/TestRunPanel.tsx ui/src/components/scenario/__tests__/TestRunPanel.test.tsx
git commit -m "feat(ui): test-run 본문 인라인 500자 미리보기 + 전체 보기 모달(복사/JSON 포맷/줄바꿈)"
```
foreground 단일 호출 + `git log -1` 확인.

---

## 완료 후

- 전체 게이트 재확인: `cargo test -p handicap-engine` + `cd ui && pnpm lint && pnpm test && pnpm build`.
- 수동 점검(선택, `dev-doctor`로 스택 기동): 시나리오 에디터에서 큰 응답을 내는 타겟으로 test-run → 인라인 500자 미리보기 + "전체 보기" 모달(복사/포맷/줄바꿈) 동작 확인.
- 브랜치 마무리: 루트 CLAUDE.md git 토폴로지(remote 없음 → `git -C <메인> merge --ff-only <branch>` 후 `ExitWorktree`).
- ADR 불필요(ADR-0026 범위 내 additive UI + 엔진 상수 1개, 와이어 무변경).

## Self-Review 결과 (작성자 체크)

- **Spec 커버리지**: §4.1 캡 상향→Task1 / §4.2 Modal→Task2 / §4.3 BodyBlock·BodyViewer(복사/포맷/줄바꿈/배너)→Task3 / §4.4 HttpRow 배선(요청+응답)→Task3 / §6 테스트(엔진 boundary `<=cap+2`, clipboard 모킹, tsc-b·lint 게이트, TDD-guard 순서)→각 Task에 반영 / §7 roadmap=이미 반영(plan은 건드리지 않음). 누락 없음.
- **Placeholder 스캔**: TBD/"적절히 처리" 류 없음 — 모든 코드 step에 실제 코드 포함.
- **타입 일관성**: `Modal` props(`open/onClose/title/children`)·`BodyBlock`(`body/truncated?/label`)·`BodyViewer`(`body/truncated`)가 정의처와 호출처에서 일치. `INLINE_PREVIEW_CHARS` 단일 정의. 테스트의 `dialog` aria-label("응답 본문"/"요청 본문")이 `BodyBlock` `label` prop과 일치.

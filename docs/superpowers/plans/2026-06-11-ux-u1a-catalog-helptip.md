# U1a — 메시지 카탈로그 + HelpTip + 용어 사전 (+ Summary 최소 소비처) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** UX 재설계(영역 U)의 기반 인프라 — 한국어 메시지 카탈로그(`ko.ts`)·용어 사전·접근성 HelpTip 컴포넌트를 만들고, 최소 소비처로 리포트 Summary 카드의 p50/p95/p99에 도움말을 부착한다.

**Architecture:** spec `docs/superpowers/specs/2026-06-11-ux-beginner-friendly-redesign-design.md` §2(공통 인프라) + §7.2 일부. 순수 UI-only(엔진·컨트롤러·proto·migration 무변경) — 신규 `ui/src/i18n/ko.ts`(typed 상수, 라이브러리 없음) + 신규 `ui/src/components/HelpTip.tsx`(클릭 토글 popover, hover 전용 금지) + `Summary.tsx` 카드 3개에 부착. ADR-0035(UI 문구 정책) 동반.

**Tech Stack:** React 18 + TS + Tailwind, vitest + RTL. 신규 의존성 0.

**워크트리·게이트 주의 (orchestrator):**
- 실행은 `.claude/worktrees/<name>` 워크트리에서 (`EnterWorktree`, `worktree.baseRef: head`). 새 워크트리엔 `ui/node_modules`가 없으니 첫 task 전 `cd ui && pnpm install`.
- pre-commit hook은 비-`.md` 커밋마다 전체 cargo workspace를 돌린다(수 분) — 각 task는 RED→GREEN 확인 후 **하나의 green 커밋**(RED 단독 커밋 금지). implementer의 커밋은 **foreground 단일 호출**(`run_in_background: false`, timeout 600000ms), 폴링 금지.
- UI 게이트(`pnpm lint && pnpm test && pnpm build`)는 hook이 안 돌리므로 각 task에서 수동.
- TDD guard: 새 src 파일(`ko.ts`, `HelpTip.tsx`)은 디스크에 pending test 파일이 있어야 Write 가능 — 각 task의 Step 1(테스트 먼저)이 자연히 unblock.

---

### Task 1: 메시지 카탈로그 `ko.ts` + 용어 사전

**Files:**
- Test: `ui/src/i18n/__tests__/ko.test.ts` (신규 — vitest include가 `src/**/__tests__/**`만 잡으므로 반드시 `__tests__/` 안)
- Create: `ui/src/i18n/ko.ts`

- [ ] **Step 1: 실패하는 테스트 작성** (먼저 — TDD guard unblock)

`ui/src/i18n/__tests__/ko.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ko } from "../ko";

describe("ko 카탈로그", () => {
  it("glossary 14개 핵심 용어가 전부 비어 있지 않은 문자열이다", () => {
    const required = [
      "vu",
      "rps",
      "p50",
      "p95",
      "p99",
      "rampUp",
      "closedLoop",
      "openLoop",
      "thinkTime",
      "maxInFlight",
      "slo",
      "scenario",
      "step",
      "run",
    ] as const;
    for (const key of required) {
      const value = ko.glossary[key];
      expect(value, `glossary.${key}`).toBeTypeOf("string");
      expect(value.length, `glossary.${key}`).toBeGreaterThan(0);
    }
  });

  it("백분위 용어 설명은 '낮을수록 좋음' 방향성을 포함한다", () => {
    for (const key of ["p50", "p95", "p99"] as const) {
      expect(ko.glossary[key]).toContain("낮을수록 좋");
    }
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test ko` (주의: `--` 붙이면 전체 스위트가 돈다)
Expected: FAIL — `Cannot find module '../ko'` 류

- [ ] **Step 3: 구현**

`ui/src/i18n/ko.ts`:

```ts
/**
 * UI 한국어 메시지 카탈로그 (ADR-0035).
 * - 신규·변경 문구는 이 카탈로그 경유로 작성한다 (기존 미변경 문구의 소급 추출은 비목표).
 * - 기술 고유명사(VU, RPS, p95, cron, YAML)는 원어 유지 + 설명 병기.
 * - i18n 라이브러리 없음 — 나중에 en.ts + 컨텍스트 스위치를 더할 수 있는 구조만 유지.
 * - 용어 정의(glossary)는 전 화면 HelpTip의 단일 소스 — 화면마다 설명이 달라지면 안 된다.
 */
export const ko = {
  glossary: {
    vu: "동시 사용자(VU) — 동시에 요청을 보내는 가상 사용자 수입니다.",
    rps: "RPS — 초당 요청 수(Requests Per Second)입니다.",
    p50: "p50(중앙값) — 전체 요청의 50%가 이 시간 안에 응답했다는 뜻입니다. 낮을수록 좋습니다.",
    p95: "p95 — 전체 요청의 95%가 이 시간 안에 응답했다는 뜻입니다(꼬리 지연). 낮을수록 좋습니다.",
    p99: "p99 — 전체 요청의 99%가 이 시간 안에 응답했다는 뜻입니다(최악에 가까운 지연). 낮을수록 좋습니다.",
    rampUp: "점진 시작(ramp-up) — 부하를 0에서 목표치까지 서서히 올리는 시간입니다.",
    closedLoop:
      "사용자 수 기준(closed-loop) — 가상 사용자 N명이 각자 응답을 받은 뒤 다음 요청을 보내는 방식입니다. 일반 시나리오에 적합합니다.",
    openLoop:
      "요청 속도 기준(open-loop) — 응답 속도와 무관하게 목표 RPS로 요청을 발사하는 방식입니다. 처리량 한계 측정에 적합합니다.",
    thinkTime: "think time — 실제 사용자처럼 요청 사이에 쉬는 시간입니다.",
    maxInFlight:
      "동시 요청 상한(max in-flight) — 동시에 진행 중일 수 있는 요청 수의 상한입니다. 서버가 목표 속도를 못 따라가면 초과분은 drop으로 집계됩니다.",
    slo: "합격 기준(SLO) — 응답시간·에러율 등의 임계값입니다. 설정하면 run 종료 시 합격/불합격을 자동 판정합니다.",
    scenario: "시나리오 — 부하를 줄 API 요청 흐름의 정의입니다.",
    step: "스텝 — 부하 중 반복 실행될 HTTP 요청 1개입니다.",
    run: "실행(run) — 시나리오에 부하 설정을 적용해 한 번 돌린 기록입니다.",
  },
} as const;
```

- [ ] **Step 4: GREEN 확인**

Run: `cd ui && pnpm test ko`
Expected: PASS (2 tests)

- [ ] **Step 5: 커밋** (foreground 단일 호출 — cargo hook이 수 분 돈다)

```bash
git add ui/src/i18n/ko.ts ui/src/i18n/__tests__/ko.test.ts
git commit -m "feat(ui): 한국어 메시지 카탈로그 ko.ts + 용어 사전 (U1a, ADR-0035)"
```

---

### Task 2: `<HelpTip>` 공유 컴포넌트

**Files:**
- Test: `ui/src/components/__tests__/HelpTip.test.tsx` (신규)
- Create: `ui/src/components/HelpTip.tsx`

- [ ] **Step 1: 실패하는 테스트 작성**

`ui/src/components/__tests__/HelpTip.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import userEvent from "@testing-library/user-event";
import { HelpTip } from "../HelpTip";

describe("HelpTip", () => {
  it("기본은 닫힘 — 버튼만 보이고 popover는 없다", () => {
    render(<HelpTip label="p95 설명">정의</HelpTip>);
    const btn = screen.getByRole("button", { name: "p95 설명" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("클릭으로 열리고 다시 클릭하면 닫힌다", async () => {
    const user = userEvent.setup();
    render(<HelpTip label="p95 설명">전체 요청의 95%</HelpTip>);
    const btn = screen.getByRole("button", { name: "p95 설명" });
    await user.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("note")).toHaveTextContent("전체 요청의 95%");
    await user.click(btn);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("ESC로 닫힌다", async () => {
    const user = userEvent.setup();
    render(<HelpTip label="설명">내용</HelpTip>);
    await user.click(screen.getByRole("button", { name: "설명" }));
    expect(screen.getByRole("note")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("바깥 클릭(pointerdown)으로 닫힌다", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <HelpTip label="설명">내용</HelpTip>
        <button type="button">다른 버튼</button>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "설명" }));
    expect(screen.getByRole("note")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "다른 버튼" }));
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("aria-controls가 열린 popover의 id와 연결된다", async () => {
    const user = userEvent.setup();
    render(<HelpTip label="설명">내용</HelpTip>);
    const btn = screen.getByRole("button", { name: "설명" });
    await user.click(btn);
    const note = screen.getByRole("note");
    expect(note.getAttribute("id")).toBeTruthy();
    expect(btn).toHaveAttribute("aria-controls", note.getAttribute("id"));
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test HelpTip`
Expected: FAIL — `Cannot find module '../HelpTip'` 류

- [ ] **Step 3: 구현**

`ui/src/components/HelpTip.tsx`:

```tsx
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * ⓘ 클릭 토글 도움말 popover (spec 2026-06-11 UX §2.2, ADR-0035).
 * hover 전용 금지 — 터치·키보드 접근성. ESC/바깥 pointerdown으로 닫힘.
 * 용어 설명 본문은 ko.ts glossary를 children으로 넘겨 단일 소스를 유지한다.
 */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-block">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 align-middle text-[10px] leading-none text-slate-500 hover:bg-slate-100"
      >
        ?
      </button>
      {open && (
        <span
          id={id}
          role="note"
          className="absolute left-0 top-5 z-20 block w-56 whitespace-normal rounded-md border border-slate-200 bg-white p-2 text-left text-xs font-normal text-slate-700 shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  );
}
```

- [ ] **Step 4: GREEN 확인**

Run: `cd ui && pnpm test HelpTip`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```bash
git add ui/src/components/HelpTip.tsx ui/src/components/__tests__/HelpTip.test.tsx
git commit -m "feat(ui): HelpTip 클릭 토글 도움말 popover (U1a)"
```

---

### Task 3: Summary 카드 p50/p95/p99에 HelpTip 부착 (최소 소비처)

**Files:**
- Modify(Test): `ui/src/components/report/__tests__/Summary.test.tsx`
- Modify: `ui/src/components/report/Summary.tsx`

- [ ] **Step 1: 실패하는 테스트 추가** — `Summary.test.tsx`의 기존 import에 `userEvent` 추가:

```tsx
import userEvent from "@testing-library/user-event";
```

describe 블록 끝에 추가:

```tsx
  it("p50/p95/p99 카드에 도움말 버튼이 있고 클릭하면 용어 설명이 열린다", async () => {
    const user = userEvent.setup();
    render(<Summary summary={baseSummary} />);
    expect(screen.getByRole("button", { name: "p50 설명" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "p99 설명" })).toBeInTheDocument();
    expect(screen.queryByRole("note")).toBeNull();
    await user.click(screen.getByRole("button", { name: "p95 설명" }));
    expect(screen.getByRole("note")).toHaveTextContent("95%");
  });

  it("도움말이 없는 카드(Total requests 등)엔 도움말 버튼이 없다", () => {
    render(<Summary summary={baseSummary} />);
    expect(screen.queryByRole("button", { name: "Total requests 설명" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Errors 설명" })).toBeNull();
  });
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test Summary`
Expected: 새 테스트 2개 FAIL (`Unable to find ... role "button" name "p50 설명"`), 기존 5개 PASS

- [ ] **Step 3: 구현** — `Summary.tsx`를 다음으로 수정 (카드 배열에 optional `help` 추가 + 라벨 행에 HelpTip):

```tsx
import type { ReportSummary } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";

type Props = {
  summary: ReportSummary;
  dropped?: number;
  targetRps?: number | null;
};

export function Summary({ summary, dropped, targetRps }: Props) {
  const cards: Array<{ label: string; value: string; help?: string }> = [
    { label: "Total requests", value: summary.count.toLocaleString() },
    { label: "Errors", value: summary.errors.toLocaleString() },
    { label: "Avg RPS", value: summary.rps.toFixed(1) },
    { label: "Duration", value: `${summary.duration_seconds}s` },
    { label: "p50", value: `${summary.p50_ms} ms`, help: ko.glossary.p50 },
    { label: "p95", value: `${summary.p95_ms} ms`, help: ko.glossary.p95 },
    { label: "p99", value: `${summary.p99_ms} ms`, help: ko.glossary.p99 },
  ];

  if (targetRps != null) {
    const droppedCount = dropped ?? 0;
    const total = droppedCount + summary.count;
    const dropRate = total === 0 ? 0 : droppedCount / total;
    const dropPct = (dropRate * 100).toFixed(1);
    cards.push(
      { label: "Target RPS", value: targetRps.toLocaleString() },
      {
        label: "Dropped",
        value: `${droppedCount.toLocaleString()} (${dropPct}%)`,
      },
    );
  }

  const gridColsClass = targetRps != null ? "md:grid-cols-9" : "md:grid-cols-7";

  return (
    <section aria-label="Report summary" className="mb-6">
      <h3 className="text-lg font-semibold mb-2">Summary</h3>
      <div className={`grid grid-cols-3 ${gridColsClass} gap-3 text-sm`}>
        {cards.map((c) => (
          <div key={c.label} className="border border-slate-200 rounded-md p-3 bg-white">
            <div className="text-slate-500 text-xs">
              {c.label}
              {c.help && <HelpTip label={`${c.label} 설명`}>{c.help}</HelpTip>}
            </div>
            <div className="text-lg font-semibold">{c.value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: GREEN 확인**

Run: `cd ui && pnpm test Summary`
Expected: PASS (7 tests — 기존 5 + 신규 2, 기존 단언 무수정)

- [ ] **Step 5: 커밋**

```bash
git add ui/src/components/report/Summary.tsx ui/src/components/report/__tests__/Summary.test.tsx
git commit -m "feat(ui): Summary p50/p95/p99 카드에 용어 도움말 부착 (U1a 최소 소비처)"
```

---

### Task 4: 전체 UI 게이트

- [ ] **Step 1: lint + 전체 테스트 + 빌드** (targeted green ≠ full green — ui/CLAUDE.md)

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 경고 0 / 전체 스위트 PASS / `tsc -b` + vite build 성공

- [ ] **Step 2: 실패 시** — 원인 수정 후 해당 task 커밋에 fold(amend 금지 — 새 fix 커밋), 재실행.

(이 task는 커밋 없음 — 게이트 확인만. 실패 fix가 생기면 그 fix만 커밋.)

---

### Task 5: ADR-0035 + CLAUDE.md 인덱스 (docs-only 커밋 — cargo hook fast-path)

**Files:**
- Create: `docs/adr/0035-ui-korean-copy-message-catalog.md`
- Modify: `CLAUDE.md` ("알아둘 결정들" 인덱스에 한 줄)

- [ ] **Step 1: ADR 작성**

`docs/adr/0035-ui-korean-copy-message-catalog.md`:

```markdown
# 0035 — UI 문구: 한국어 통일 + 메시지 카탈로그(ko.ts) 경유

- Status: accepted
- Date: 2026-06-11

## Context and Problem Statement

UI 문구가 한영 혼용("New run" 제목 + "부하 모델" 레이블 + 영/한 섞인 검증 메시지)이고, 1차 사용자(사내 QA)는 부하테스트 전문 용어(VU, p95, open-loop)를 설명 없이 마주친다. 2026-06-11 UX 재설계 brainstorming에서 언어 정책 결정이 필요했다.

## Considered Options

1. 한국어 통일 + 신규 문구만 카탈로그 경유 (채택)
2. i18n 라이브러리 전면 도입 + 언어 토글 즉시 제공
3. 영어 통일

## Decision Outcome

옵션 1 채택:

- **신규·변경 UI 문구는 한국어로 작성.** 기술 고유명사(VU, RPS, p50/p95/p99, cron, YAML 등)는 원어 유지 + 첫 등장 지점에 설명(HelpTip ⓘ).
- **신규·변경 문구는 `ui/src/i18n/ko.ts` typed 상수 카탈로그 경유.** 용어 정의는 `ko.glossary`가 전 화면의 단일 소스.
- **i18n 라이브러리·언어 토글·기존 문구 소급 추출은 비목표**(YAGNI). 카탈로그 구조만으로 나중에 `en.ts` + 컨텍스트 스위치를 점진 도입 가능. 반쪽 토글(새 문구만 전환)은 한영이 뒤섞여 더 나쁘므로, 토글 도입 시점에 소급 추출을 함께 한다.

옵션 2 기각: 전 컴포넌트 문자열 추출이라는 큰 기계적 작업 + 이후 모든 슬라이스 2개 언어 유지보수를 지금 지불할 가치가 없음(사내 단일 테넌트, 1차 사용자가 한국어 화자). 옵션 3 기각: 1차 사용자(QA)의 진입 장벽이 목표와 정면 충돌.

## Consequences

- 이후 모든 UI 슬라이스는 새 사용자-노출 문구를 `ko.ts`에 추가하고 import해서 쓴다(인라인 한국어 리터럴 지양 — 용어 설명은 반드시 glossary 참조).
- 출처: UX 재설계 spec `docs/superpowers/specs/2026-06-11-ux-beginner-friendly-redesign-design.md` §1.3·§2.
```

- [ ] **Step 2: CLAUDE.md 인덱스 한 줄 추가** — "알아둘 결정들" 목록 끝(0034 다음)에:

```markdown
- **0035** UI 문구: 한국어 통일 + `ko.ts` 메시지 카탈로그 경유 (고유명사 원어 병기 + HelpTip, i18n 라이브러리·토글 비목표)
```

- [ ] **Step 3: conflict marker 점검 + 커밋**

```bash
grep -rn '^<<<<<<<\|^>>>>>>>' docs/adr/0035-ui-korean-copy-message-catalog.md CLAUDE.md || echo CLEAN
git add docs/adr/0035-ui-korean-copy-message-catalog.md CLAUDE.md
git commit -m "docs(adr): 0035 UI 문구 한국어 통일 + ko.ts 카탈로그 정책 (U1a)"
```

---

### 머지 전 체크리스트 (orchestrator)

- [ ] `cd ui && pnpm lint && pnpm test && pnpm build` 전체 green (Task 4에서 확인했어도 마지막 커밋 후 1회 더)
- [ ] 라이브 확인 1회: controller+UI 띄우고(`just run-controller-with-ui` — dist stale이면 `just ui-build` 먼저) 기존 run 리포트 열어 p95 ⓘ 클릭 → 설명 popover, ESC 닫힘, 콘솔 에러 0 (인라인 `browser_snapshot`/`browser_evaluate` — `filename` 저장 금지, Playwright cwd 함정)
- [ ] 최종 handicap-reviewer (U1a diff 전체)
- [ ] master ff-merge (워크트리 안에서면 `git -C /Users/sgj/develop/handicap merge --ff-only <branch>`) → `ExitWorktree(remove, discard_changes: true)`
- [ ] build-log 한 단락 append + roadmap 영역 U 상태 갱신 (docs-only 커밋, master 직접)

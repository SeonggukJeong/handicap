# 결과화면 폴리시 (반응형 그래프 + 다운로드 드롭다운 메뉴) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 결과/리포트 화면(`ReportView`)의 차트를 콘텐츠 폭을 채우는 반응형으로 바꾸고, 4개 다운로드 버튼을 단일 접근성 드롭다운 메뉴 + 초보자용 포맷 설명 HelpTip으로 묶는다.

**Architecture:** 순수 UI 변경(`ui/` 한정). 5종 차트를 기존 `StageCurvePreview` 패턴(`width&&height`면 bare 차트, 아니면 `ResponsiveContainer`)으로 전환. `DownloadJsonButton` 컴포넌트의 JSON 저장 로직을 `downloadJson` 헬퍼로 추출하고, 새 `DownloadMenu`(WAI-ARIA 메뉴버튼)가 4개 다운로드 액션을 담는다. 백엔드·proto·migration·`schemas.ts`·리포트 파싱 0-diff.

**Tech Stack:** React 18 + TypeScript(strict) + Tailwind + recharts + vitest/RTL + `@testing-library/user-event` v14.

## Global Constraints

- **spec**: `docs/superpowers/specs/2026-06-26-result-screen-polish-design.md` (R1–R10 척추). 모든 task는 이 R-id를 충족한다.
- **UI-only**: `crates/`·`*.proto`·`*.sql`·`ui/src/api/schemas.ts` **0-diff**. 다운로드 형식/엔드포인트/파일명/MIME/JSON 직렬화 **byte-identical**(R6·R10).
- **문구는 `ko.ts` 경유**(ADR-0035, R9): 사용자 노출 한국어는 전부 `ko.report.download*`. 포맷명 `JSON`/`CSV`/`XLSX`는 고유명사라 리터럴 유지.
- **게이트**: 각 task 커밋 전 `cd ui && pnpm test <파일>`로 해당 테스트 green 확인; 마지막에 `pnpm lint && pnpm test && pnpm build` 전체.
- **tdd-guard**(루트 C-1): `ui/src/**` non-test 편집 전 *pending test-path 파일*이 있어야 한다 → **각 task는 테스트 파일을 먼저** 편집/생성한다.
- **함정**: `pnpm test`(esbuild)는 통과해도 `tsc -b`(`pnpm build`)만 잡는 타입 에러가 있다 — 머지 전 `pnpm build` 필수. ResponsiveContainer는 jsdom에서 size 0이라 bare 차트 테스트는 **`width`와 `height` 둘 다** 넘겨야 한다(게이트 `width!=null && height!=null`). RTL `getByRole("button",{name})`는 정규화 full-match — 트리거 caret `▾`는 `aria-hidden` span에 넣어 accessible name을 라벨과 일치시킨다.

---

### Task 1: 5종 차트 반응형 전환 (R1, R2, R3)

**Files:**
- Modify: `ui/src/components/report/TimeSeriesChart.tsx`, `ActiveVuChart.tsx`, `PercentileCurveChart.tsx`, `LatencyHistogramChart.tsx`, `StatusDistribution.tsx`
- Test (edit): `ui/src/components/report/__tests__/PercentileCurveChart.test.tsx`, `LatencyHistogramChart.test.tsx`, `StatusDistribution.test.tsx`

**Interfaces:**
- Produces: 5종 차트가 `width?: number`/`height?: number`를 **기본값 없이** 받아, 둘 다 있으면 bare 차트·아니면 `ResponsiveContainer width="100%" height={그 차트 고정 height}`로 렌더. (`ReportView`는 size 미전달 → 반응형. `TimeSeriesChart`/`ActiveVuChart` 테스트는 이미 `width=400 height=200` 전달.)
- Heights: TimeSeries/ActiveVu/Percentile = **220**, LatencyHistogram/StatusDistribution = **240**.

- [ ] **Step 1: 테스트 파일 3개에 `width`+`height` 추가 (tdd-guard 선행 + 기본값 제거 대비)**

`PercentileCurveChart.test.tsx` — 두 `it` 모두(line 8, 23)의 `<PercentileCurveChart curve={...} />`에 `width={400} height={200}` 추가. 예 (첫 it):
```tsx
      <PercentileCurveChart
        width={400}
        height={200}
        curve={[
          { quantile: 0.5, value_us: 20_000 },
          { quantile: 0.99, value_us: 80_000 },
          { quantile: 1.0, value_us: 120_000 },
        ]}
      />,
```
둘째 it(line 23)도 동일하게 `width={400} height={200}` 추가.

`LatencyHistogramChart.test.tsx`:
- line 6 it: `<LatencyHistogramChart buckets={[...]} />` → `<LatencyHistogramChart width={400} height={200} buckets={[...]} />`.
- line 26 it: `<LatencyHistogramChart buckets={[{ lower_us: 1_000, upper_us: 2_000, count: 10 }]} />` → 같은 곳에 `width={400} height={200}` 추가.
- line 21 it(빈 buckets `[]` → `<p>`): **수정 금지**.

`StatusDistribution.test.tsx`:
- line 6 it: `<StatusDistribution distribution={{ "200": 950, "500": 50 }} />` → `<StatusDistribution width={400} height={200} distribution={{ "200": 950, "500": 50 }} />`.
- line 13 it(빈 `{}` → `<p>`): **수정 금지**.

- [ ] **Step 2: 테스트 실행 — 현재 src로도 green (기본값 override일 뿐)**

Run: `cd ui && pnpm test PercentileCurveChart LatencyHistogramChart StatusDistribution`
Expected: PASS (구 src는 width 기본값 720을 400으로 override할 뿐 bare 차트 유지).

- [ ] **Step 3: `TimeSeriesChart.tsx` 반응형 전환**

import에 `ResponsiveContainer` 추가:
```tsx
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
```
함수 시그니처에서 기본값 제거 + 차트 const 추출 + 반응형 분기:
```tsx
export function TimeSeriesChart({ title, data, yLabel, width, height }: Props) {
  // ts_second is unix epoch. Subtract the first one so the X axis reads as elapsed seconds.
  const t0 = data.length > 0 ? data[0].ts_second : 0;
  const series = data.map((p) => ({ x: p.ts_second - t0, y: p.value }));
  const chart = (
    <LineChart width={width} height={height} data={series}>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey="x" label={{ value: "seconds", position: "insideBottom", offset: -4 }} />
      <YAxis label={{ value: yLabel, angle: -90, position: "insideLeft" }} />
      <Tooltip />
      <Line type="monotone" dataKey="y" stroke="#2563eb" dot={false} isAnimationActive={false} />
    </LineChart>
  );
  return (
    <section aria-label={ko.report.timeSeriesAria(title)} className="mb-6">
      <h4 className="text-sm font-semibold text-slate-700 mb-2">{title}</h4>
      {width != null && height != null ? (
        chart
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          {chart}
        </ResponsiveContainer>
      )}
    </section>
  );
}
```
(`Props`의 `width?`/`height?`는 이미 optional — 시그니처 destructure에서 `= 720`/`= 220`만 제거.)

- [ ] **Step 4: `ActiveVuChart.tsx` 반응형 전환 (2-variant 단일 래핑)**

import에 `ResponsiveContainer` 추가:
```tsx
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
```
시그니처에서 `width = 720, height = 220` → `width, height`. 그리고 `showByWorker ? <LineChart…> : <LineChart…>` 두 변형을 `const chart`로 추출한 뒤(각 `<LineChart width={width} height={height} …>`), 기존 그 JSX 위치를 반응형 분기로 교체:
```tsx
  const chart = showByWorker ? (
    <LineChart width={width} height={height} data={perWorkerData}>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey="x" label={{ value: "seconds", position: "insideBottom", offset: -4 }} />
      <YAxis label={{ value: "VU", angle: -90, position: "insideLeft" }} allowDecimals={false} />
      <Tooltip />
      <Legend />
      {byWorker.flatMap((_w, i) => {
        const color = WORKER_COLORS[i % WORKER_COLORS.length];
        const name = ko.report.activeVuWorkerLabel(i + 1);
        return [
          <Line key={`d${i}`} type="linear" dataKey={`d${i}`} name={`${name} ${ko.report.activeVuDesired}`} stroke={color} strokeDasharray="4 2" dot={false} isAnimationActive={false} />,
          <Line key={`a${i}`} type="linear" dataKey={`a${i}`} name={`${name} ${ko.report.activeVuActual}`} stroke={color} dot={false} isAnimationActive={false} />,
        ];
      })}
    </LineChart>
  ) : (
    <LineChart width={width} height={height} data={totalData}>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey="x" label={{ value: "seconds", position: "insideBottom", offset: -4 }} />
      <YAxis label={{ value: "VU", angle: -90, position: "insideLeft" }} allowDecimals={false} />
      <Tooltip />
      <Legend />
      <Line type="linear" dataKey="desired" name={ko.report.activeVuDesired} stroke="#94a3b8" strokeDasharray="4 2" dot={false} isAnimationActive={false} />
      <Line type="linear" dataKey="actual" name={ko.report.activeVuActual} stroke="#2563eb" dot={false} isAnimationActive={false} />
    </LineChart>
  );
```
그리고 `return (<section …>` 안에서 헤더(toolbar/h4)·caption 다음의 `{showByWorker ? <LineChart…> : <LineChart…>}` 블록을:
```tsx
      {width != null && height != null ? (
        chart
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          {chart}
        </ResponsiveContainer>
      )}
```
로 교체(그 아래 `{showByWorker ? <ul …legend…> : null}`은 그대로 둔다).

- [ ] **Step 5: `PercentileCurveChart.tsx` 반응형 전환 (height 220)**

import에 `ResponsiveContainer` 추가. `width = 720, height = 220` → `width, height`. `data` 계산 뒤 `const chart = (<LineChart width={width} height={height} data={data}>…</LineChart>)`로 추출하고 `<section>` 안 `<LineChart>`를:
```tsx
      {width != null && height != null ? (
        chart
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          {chart}
        </ResponsiveContainer>
      )}
```
로 교체.

- [ ] **Step 6: `LatencyHistogramChart.tsx` 반응형 전환 (height 240, 빈-상태 `<p>` 미래핑)**

import에 `ResponsiveContainer` 추가. `width = 720, height = 240` → `width, height`. `const chart = (<BarChart width={width} height={height} data={data}>…</BarChart>)`로 추출. `isEmpty` 삼항의 **else 가지만** 교체:
```tsx
      {isEmpty ? (
        <p className="text-slate-500 text-sm italic">{ko.report.noLatencyData}</p>
      ) : width != null && height != null ? (
        chart
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          {chart}
        </ResponsiveContainer>
      )}
```

- [ ] **Step 7: `StatusDistribution.tsx` 반응형 전환 (height 240, 빈-상태 `<p>` 미래핑)**

import에 `ResponsiveContainer` 추가. `width = 480, height = 240` → `width, height`. `const chart = (<BarChart width={width} height={height} data={data}>…</BarChart>)`로 추출. `isEmpty` 삼항 else 가지만:
```tsx
      {isEmpty ? (
        <p className="text-slate-500 text-sm italic">{ko.report.noStatusData}</p>
      ) : width != null && height != null ? (
        chart
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          {chart}
        </ResponsiveContainer>
      )}
```

- [ ] **Step 8: 차트 + ReportView 테스트 green 확인 (teeth: 테스트의 width 제거 시 RED)**

Run: `cd ui && pnpm test TimeSeriesChart ActiveVuChart PercentileCurveChart LatencyHistogramChart StatusDistribution ReportView`
Expected: PASS. (`ReportView.test`는 차트를 `region`(section)으로 단언하므로 반응형이어도 green. Teeth 확인: PercentileCurveChart 테스트에서 `width=400 height=200`를 잠시 지우면 svg/p50 단언이 FAIL → 복원.)

- [ ] **Step 9: Commit**

```bash
git add ui/src/components/report/TimeSeriesChart.tsx ui/src/components/report/ActiveVuChart.tsx ui/src/components/report/PercentileCurveChart.tsx ui/src/components/report/LatencyHistogramChart.tsx ui/src/components/report/StatusDistribution.tsx ui/src/components/report/__tests__/PercentileCurveChart.test.tsx ui/src/components/report/__tests__/LatencyHistogramChart.test.tsx ui/src/components/report/__tests__/StatusDistribution.test.tsx
git commit -m "feat(result-screen): 리포트 차트 5종 반응형 전환(콘텐츠 폭 채움)"
```

---

### Task 2: `downloadJson` 헬퍼 추출 (R7)

**Files:**
- Create: `ui/src/api/downloadJson.ts`
- Create (test): `ui/src/api/__tests__/downloadJson.test.ts`

**Interfaces:**
- Produces: `export async function downloadJson(filename: string, data: unknown): Promise<void>` — `JSON.stringify(data, null, 2)`를 picker(있으면)→blob-URL anchor(폴백, 1s 후 revoke)로 저장. (`ui/src/api/__tests__/` 디렉터리가 없으면 생성; vitest include는 `src/**/__tests__/**`라 위치 필수.)

- [ ] **Step 1: 헬퍼 테스트 작성(RED — 모듈 미존재). 동작 4케이스 이전 + revoke 신규**

Create `ui/src/api/__tests__/downloadJson.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { downloadJson } from "../downloadJson";

// jsdom does not implement URL.createObjectURL / revokeObjectURL.
if (typeof URL.createObjectURL === "undefined") {
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn(), writable: true });
}
if (typeof URL.revokeObjectURL === "undefined") {
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), writable: true });
}

type PickerWindow = Window & {
  showSaveFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle>;
};

describe("downloadJson", () => {
  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as PickerWindow).showSaveFilePicker;
  });

  it("uses showSaveFilePicker when available and bypasses the blob URL path", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const createWritable = vi.fn().mockResolvedValue({ write, close });
    const picker = vi.fn().mockResolvedValue({ createWritable });
    (window as PickerWindow).showSaveFilePicker = picker;

    await downloadJson("report.json", { hello: "world" });

    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: "report.json" }));
    expect(write).toHaveBeenCalledWith(JSON.stringify({ hello: "world" }, null, 2));
    expect(close).toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("falls back to a blob URL anchor click when showSaveFilePicker is unavailable", async () => {
    await downloadJson("report.json", { hello: "world" });
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it("does not fall back when the user cancels the picker (AbortError)", async () => {
    const abortError = Object.assign(new Error("cancelled"), { name: "AbortError" });
    (window as PickerWindow).showSaveFilePicker = vi.fn().mockRejectedValue(abortError);
    await downloadJson("report.json", { hello: "world" });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("falls back to blob URL when showSaveFilePicker fails with a non-Abort error", async () => {
    (window as PickerWindow).showSaveFilePicker = vi.fn().mockRejectedValue(new Error("denied"));
    await downloadJson("report.json", { hello: "world" });
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it("revokes the blob URL after a delay (no leak)", async () => {
    vi.useFakeTimers();
    try {
      await downloadJson("report.json", { hello: "world" });
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: 테스트 실행 — RED**

Run: `cd ui && pnpm test downloadJson`
Expected: FAIL — `Failed to resolve import "../downloadJson"`.

- [ ] **Step 3: 헬퍼 구현**

Create `ui/src/api/downloadJson.ts`:
```ts
type PickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandle>;
};

// Save via File System Access API when available — bypasses the browser
// download manager (Chrome Safe Browsing online check blocks downloads when
// the host is offline, an actual air-gapped scenario, ADR-0001). Returns true
// if handled (success OR user cancelled); false if the API is missing or threw.
async function saveViaPicker(filename: string, json: string): Promise<boolean> {
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (typeof picker !== "function") return false;
  try {
    const handle = await picker({
      suggestedName: filename,
      types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(json);
    await writable.close();
    return true;
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") return true; // user cancelled
    return false;
  }
}

function saveViaBlobUrl(filename: string, json: string): void {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the browser has time to read the blob bytes.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** Save `data` as a pretty-printed JSON file. Extracted from the former
 *  DownloadJsonButton so menu items (and any caller) can invoke it directly. */
export async function downloadJson(filename: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  const saved = await saveViaPicker(filename, json);
  if (!saved) saveViaBlobUrl(filename, json);
}
```

- [ ] **Step 4: 테스트 green**

Run: `cd ui && pnpm test downloadJson`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/downloadJson.ts ui/src/api/__tests__/downloadJson.test.ts
git commit -m "feat(result-screen): JSON 저장 로직 downloadJson 헬퍼로 추출"
```

---

### Task 3: `DownloadMenu` 접근성 드롭다운 (R5)

**Files:**
- Create: `ui/src/components/DownloadMenu.tsx`
- Create (test): `ui/src/components/__tests__/DownloadMenu.test.tsx`

**Interfaces:**
- Produces: `export type DownloadMenuItem = { label: string; onSelect: () => void }`; `export function DownloadMenu({ label, items }: { label: string; items: DownloadMenuItem[] })`. 트리거 `aria-haspopup="menu"`+`aria-expanded`(accessible name = `label`, caret는 `aria-hidden`); 팝오버 `<ul role="menu">`·항목 `<button role="menuitem">`. 키보드 열기→첫 항목 포커스, ↑/↓ 이동, Enter/Space 실행+닫기, ESC 닫기+트리거 포커스 복귀, 바깥 pointerdown/Tab 닫기.

- [ ] **Step 1: 컴포넌트 테스트 작성(RED)**

Create `ui/src/components/__tests__/DownloadMenu.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { DownloadMenu } from "../DownloadMenu";

function setup() {
  const onA = vi.fn();
  const onB = vi.fn();
  render(
    <DownloadMenu
      label="내려받기"
      items={[
        { label: "A", onSelect: onA },
        { label: "B", onSelect: onB },
      ]}
    />,
  );
  return { onA, onB };
}

describe("DownloadMenu", () => {
  it("renders a closed menu-button trigger", () => {
    setup();
    const trigger = screen.getByRole("button", { name: "내려받기" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });

  it("opens on click and reveals the items", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "내려받기" }));
    expect(screen.getByRole("button", { name: "내려받기" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  });

  it("calls onSelect and closes when an item is clicked", async () => {
    const user = userEvent.setup();
    const { onA } = setup();
    await user.click(screen.getByRole("button", { name: "내려받기" }));
    await user.click(screen.getByRole("menuitem", { name: "A" }));
    expect(onA).toHaveBeenCalledOnce();
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });

  it("opens via keyboard (ArrowDown) and focuses the first item", async () => {
    const user = userEvent.setup();
    setup();
    screen.getByRole("button", { name: "내려받기" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    expect(screen.getByRole("menuitem", { name: "A" })).toHaveFocus();
  });

  it("moves focus with ArrowDown / ArrowUp", async () => {
    const user = userEvent.setup();
    setup();
    screen.getByRole("button", { name: "내려받기" }).focus();
    await user.keyboard("{ArrowDown}"); // open + focus A
    await user.keyboard("{ArrowDown}"); // focus B
    expect(screen.getByRole("menuitem", { name: "B" })).toHaveFocus();
    await user.keyboard("{ArrowUp}"); // focus A
    expect(screen.getByRole("menuitem", { name: "A" })).toHaveFocus();
  });

  it("activates an item with Enter and closes", async () => {
    const user = userEvent.setup();
    const { onA } = setup();
    screen.getByRole("button", { name: "내려받기" }).focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(onA).toHaveBeenCalledOnce();
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    setup();
    const trigger = screen.getByRole("button", { name: "내려받기" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Escape}");
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    expect(trigger).toHaveFocus();
  });

  it("closes on outside pointer down", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <DownloadMenu label="내려받기" items={[{ label: "A", onSelect: vi.fn() }]} />
        <button>바깥</button>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "내려받기" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "바깥" }));
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 테스트 실행 — RED**

Run: `cd ui && pnpm test DownloadMenu`
Expected: FAIL — `Failed to resolve import "../DownloadMenu"`.

- [ ] **Step 3: 컴포넌트 구현**

Create `ui/src/components/DownloadMenu.tsx`:
```tsx
import { useEffect, useRef, useState } from "react";

export type DownloadMenuItem = { label: string; onSelect: () => void };

/** WAI-ARIA menu-button: a trigger that opens a `role="menu"` popover of
 *  download actions. Keyboard: ArrowDown/Up/Enter/Space open & navigate,
 *  Enter/Space activates, Escape closes and returns focus to the trigger.
 *  Outside pointerdown / Tab also close. Menu behaviour only — actions and any
 *  error surface belong to the consumer (the items' onSelect). */
export function DownloadMenu({ label, items }: { label: string; items: DownloadMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Close when a pointer goes down outside the menu (mirrors usePopover).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Move DOM focus to the active item while open.
  useEffect(() => {
    if (open && activeIndex >= 0) itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  function closeAndFocusTrigger() {
    setOpen(false);
    setActiveIndex(-1);
    triggerRef.current?.focus();
  }

  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex(0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex(items.length - 1);
    }
  }

  function onItemKeyDown(e: React.KeyboardEvent, i: number) {
    const n = items.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i - 1 + n) % n);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(n - 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeAndFocusTrigger();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      items[i].onSelect();
      closeAndFocusTrigger();
    } else if (e.key === "Tab") {
      setOpen(false);
      setActiveIndex(-1);
    }
  }

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          setActiveIndex(-1);
        }}
        onKeyDown={onTriggerKeyDown}
        className="inline-flex items-center gap-1 rounded bg-slate-700 px-3 py-1.5 text-sm text-white hover:bg-slate-800"
      >
        {label}
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul
          role="menu"
          className="absolute right-0 z-20 mt-1 min-w-[8rem] rounded-md border border-slate-200 bg-white py-1 shadow-lg"
        >
          {items.map((item, i) => (
            <li role="none" key={item.label}>
              <button
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                role="menuitem"
                type="button"
                tabIndex={-1}
                onClick={() => {
                  item.onSelect();
                  closeAndFocusTrigger();
                }}
                onKeyDown={(e) => onItemKeyDown(e, i)}
                className="block w-full px-4 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none"
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```
(`React.KeyboardEvent`는 전역 React 네임스페이스로 해결 — `RunDetailPage.tsx`의 `React.ReactNode`와 동일하게 별도 import 불필요.)

- [ ] **Step 4: 테스트 green + lint**

Run: `cd ui && pnpm test DownloadMenu`
Expected: PASS (8 tests).
Run: `cd ui && pnpm lint`
Expected: 0 warnings (ref-콜백이 값을 반환하지 않게 `{ itemRefs.current[i] = el; }` 블록 형태 유지).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/DownloadMenu.tsx ui/src/components/__tests__/DownloadMenu.test.tsx
git commit -m "feat(result-screen): 접근성 드롭다운 DownloadMenu 컴포넌트"
```

---

### Task 4: `ReportView` 헤더 재구성 + `DownloadJsonButton` 제거 + ko 키 (R3, R4, R6, R7, R8, R9)

**Files:**
- Modify: `ui/src/components/report/ReportView.tsx`
- Modify: `ui/src/i18n/ko.ts` (report 블록)
- Modify (test): `ui/src/components/report/__tests__/ReportView.test.tsx`
- Delete: `ui/src/components/report/DownloadJsonButton.tsx`, `ui/src/components/report/__tests__/DownloadJsonButton.test.tsx`
- Modify (comment only): `ui/src/pages/__tests__/RunDetailPage.test.tsx:9`

**Interfaces:**
- Consumes: `DownloadMenu`/`DownloadMenuItem`(Task 3), `downloadJson`(Task 2), `HelpTip`(기존), `downloadFile`/`api.report{Csv,Xlsx,InsightsCsv}Url`(기존), `ko.report.download*`(이 task).

- [ ] **Step 1: `ReportView.test.tsx` 갱신(RED, tdd-guard 선행 — test-path를 가장 먼저) — 다운로드 메뉴/HelpTip 단언으로 교체**

> **순서 주의(tdd-guard)**: Task 4는 *반드시 이 test-path 편집을 먼저* 한다 — 그래야 이후 `ko.ts`·`ReportView.tsx`(watched non-test) 편집이 `[tdd-guard] Blocked` 안 된다(`ui/CLAUDE.md` 트랩). 이 테스트는 Step 2에서 추가할 `ko.report.download*` 키를 참조하지만, Step 1 시점엔 런타임 `undefined`라도 무해(테스트는 RED 예정·tdd-guard는 타입체크 안 함; `pnpm build`는 Step 6에서만).

(a) line 1 주석 reword:
```tsx
// jsdom doesn't implement createObjectURL; provide a no-op for the blob download path to run.
```
(b) import 추가(`ko`, `downloadJson` mock):
```tsx
import { ko } from "../../../i18n/ko";
vi.mock("../../../api/downloadJson", () => ({ downloadJson: vi.fn().mockResolvedValue(undefined) }));
import { downloadJson } from "../../../api/downloadJson";
```
(기존 `vi.mock("../../../api/download", …)` + `import { downloadFile }`는 유지.)

(c) line 112 단언 교체 — `Download JSON` 버튼 → 메뉴 트리거:
```tsx
    expect(screen.getByRole("button", { name: ko.report.downloadMenu })).toBeInTheDocument();
```
(d) `describe("CSV/XLSX download buttons", …)` 블록(line 183–233) **전체**를 아래로 교체:
```tsx
  describe("download menu", () => {
    it("collapses the 4 downloads into a single menu", async () => {
      const user = userEvent.setup();
      render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
      const trigger = screen.getByRole("button", { name: ko.report.downloadMenu });
      expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
      await user.click(trigger);
      expect(screen.getAllByRole("menuitem")).toHaveLength(4);
    });

    it("downloads CSV with the existing args", async () => {
      const user = userEvent.setup();
      vi.mocked(downloadFile).mockClear();
      render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
      await user.click(screen.getByRole("button", { name: ko.report.downloadMenu }));
      await user.click(screen.getByRole("menuitem", { name: "CSV" }));
      expect(downloadFile).toHaveBeenCalledWith(
        api.reportCsvUrl(FIXTURE.run.id),
        `run-${FIXTURE.run.id}-report.csv`,
        "text/csv",
      );
    });

    it("downloads XLSX with the existing args", async () => {
      const user = userEvent.setup();
      vi.mocked(downloadFile).mockClear();
      render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
      await user.click(screen.getByRole("button", { name: ko.report.downloadMenu }));
      await user.click(screen.getByRole("menuitem", { name: "XLSX" }));
      expect(downloadFile).toHaveBeenCalledWith(
        api.reportXlsxUrl(FIXTURE.run.id),
        `run-${FIXTURE.run.id}-report.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
    });

    it("downloads insights CSV with the existing args", async () => {
      const user = userEvent.setup();
      vi.mocked(downloadFile).mockClear();
      render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
      await user.click(screen.getByRole("button", { name: ko.report.downloadMenu }));
      await user.click(screen.getByRole("menuitem", { name: ko.report.downloadInsightsCsv }));
      expect(downloadFile).toHaveBeenCalledWith(
        api.reportInsightsCsvUrl(FIXTURE.run.id),
        `run-${FIXTURE.run.id}-insights.csv`,
        "text/csv",
      );
    });

    it("downloads JSON via the downloadJson helper", async () => {
      const user = userEvent.setup();
      vi.mocked(downloadJson).mockClear();
      render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
      await user.click(screen.getByRole("button", { name: ko.report.downloadMenu }));
      await user.click(screen.getByRole("menuitem", { name: "JSON" }));
      expect(downloadJson).toHaveBeenCalledWith(`run-${FIXTURE.run.id}.json`, FIXTURE);
    });

    it("shows an error alert when downloadFile rejects", async () => {
      const user = userEvent.setup();
      vi.mocked(downloadFile).mockRejectedValueOnce(new Error("network error"));
      render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
      await user.click(screen.getByRole("button", { name: ko.report.downloadMenu }));
      await user.click(screen.getByRole("menuitem", { name: "CSV" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("network error");
    });

    it("explains each format in a help tip", async () => {
      const user = userEvent.setup();
      render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
      await user.click(screen.getByRole("button", { name: ko.report.downloadHelpAria }));
      const note = screen.getByRole("note");
      expect(note).toHaveTextContent(ko.report.downloadHelp.json);
      expect(note).toHaveTextContent(ko.report.downloadHelp.csv);
      expect(note).toHaveTextContent(ko.report.downloadHelp.xlsx);
      expect(note).toHaveTextContent(ko.report.downloadHelp.insights);
    });
  });
```

- [ ] **Step 2: `ko.ts`에 download 키 추가**

`ui/src/i18n/ko.ts`에서 `    reportTitle: "리포트",`(report 블록, line ~591) 바로 뒤에 추가:
```ts
    reportTitle: "리포트",
    downloadMenu: "내려받기",
    downloadHelpAria: "파일 형식 설명",
    downloadInsightsCsv: "인사이트 CSV",
    downloadHelp: {
      json: "원시 전체 데이터 — 프로그램·재분석용",
      csv: "표 형식 요약 — 엑셀·구글시트로 열기",
      xlsx: "엑셀 통합문서 — 서식 포함",
      insights: "자동 분석 결과만 표로",
    },
```

- [ ] **Step 3: 테스트 실행 — RED**

Run: `cd ui && pnpm test ReportView`
Expected: FAIL (`ReportView.tsx` 재구성 전이라 메뉴/HelpTip 미렌더 — `getByRole("button",{name:"내려받기"})` 없음 등).

- [ ] **Step 4: `ReportView.tsx` 헤더 재구성**

import 교체: `DownloadJsonButton` 삭제, `DownloadMenu`·`downloadJson`·`HelpTip` 추가:
```tsx
import { DownloadMenu } from "../DownloadMenu";
import { downloadJson } from "../../api/downloadJson";
import { HelpTip } from "../HelpTip";
```
(기존 `import { DownloadJsonButton } from "./DownloadJsonButton";` 라인 제거. `downloadFile`/`api`/`ko`/`useState`는 그대로.)

헤더 블록(현 line 88–132, `<div className="flex items-center justify-between mb-4">` … `</div>`)에서 다운로드 버튼 묶음(`<div className="flex items-center gap-2"> … </div>`)을 교체:
```tsx
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-semibold">{ko.report.reportTitle}</h3>
        <div className="flex items-center gap-1">
          <DownloadMenu
            label={ko.report.downloadMenu}
            items={[
              {
                label: "JSON",
                onSelect: () => void downloadJson(`run-${report.run.id}.json`, report),
              },
              {
                label: "CSV",
                onSelect: () =>
                  downloadFile(
                    api.reportCsvUrl(report.run.id),
                    `run-${report.run.id}-report.csv`,
                    "text/csv",
                  ).catch((e) => setDlErr((e as Error).message)),
              },
              {
                label: "XLSX",
                onSelect: () =>
                  downloadFile(
                    api.reportXlsxUrl(report.run.id),
                    `run-${report.run.id}-report.xlsx`,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                  ).catch((e) => setDlErr((e as Error).message)),
              },
              {
                label: ko.report.downloadInsightsCsv,
                onSelect: () =>
                  downloadFile(
                    api.reportInsightsCsvUrl(report.run.id),
                    `run-${report.run.id}-insights.csv`,
                    "text/csv",
                  ).catch((e) => setDlErr((e as Error).message)),
              },
            ]}
          />
          <HelpTip label={ko.report.downloadHelpAria}>
            <span className="block">
              <b>JSON</b> — {ko.report.downloadHelp.json}
            </span>
            <span className="block">
              <b>CSV</b> — {ko.report.downloadHelp.csv}
            </span>
            <span className="block">
              <b>XLSX</b> — {ko.report.downloadHelp.xlsx}
            </span>
            <span className="block">
              <b>{ko.report.downloadInsightsCsv}</b> — {ko.report.downloadHelp.insights}
            </span>
          </HelpTip>
        </div>
      </div>
```
(아래 `{dlErr && (<p role="alert" …>다운로드 실패: {dlErr}</p>)}` 배너는 그대로 유지.)

- [ ] **Step 5: `DownloadJsonButton` 삭제 + 잔존 주석 reword**

```bash
git rm ui/src/components/report/DownloadJsonButton.tsx ui/src/components/report/__tests__/DownloadJsonButton.test.tsx
```
`ui/src/pages/__tests__/RunDetailPage.test.tsx:9` 주석에서 `DownloadJsonButton`을 제거(폴리필은 유지). 예:
```tsx
// jsdom does not implement URL.createObjectURL — the report's blob download path needs it.
```

- [ ] **Step 6: 테스트 green + grep-0 + 전체 게이트**

Run: `cd ui && pnpm test ReportView RunDetailPage`
Expected: PASS.
Run: `cd ui && grep -rn DownloadJsonButton src` → 출력 없음(0).
Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0 warnings · 전체 test PASS · build 성공(`tsc -b` clean).

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/report/ReportView.tsx ui/src/i18n/ko.ts ui/src/components/report/__tests__/ReportView.test.tsx ui/src/pages/__tests__/RunDetailPage.test.tsx
git rm --cached ui/src/components/report/DownloadJsonButton.tsx ui/src/components/report/__tests__/DownloadJsonButton.test.tsx 2>/dev/null || true
git commit -m "feat(result-screen): 다운로드 4버튼→드롭다운 메뉴+포맷 HelpTip, DownloadJsonButton 제거"
```

---

### Task 5: 라이브 검증 (R1, R4, R5, R6, R8) + 마무리 게이트

**Files:** 없음(검증만).

- [ ] **Step 1: 워크트리 자체 바이너리 + 리포트 있는 run 준비**

`/live-verify`로 워크트리-상대 controller/worker + 50ms responder + 격리 DB로 run 1개(가능하면 `measure_phases:true`·다단계 stages로 차트가 풍부하게) 생성해 terminal까지.

- [ ] **Step 2: Playwright 헤드리스 검증**

`/runs/{id}` 진입 후(인라인 `browser_evaluate`, 저장경로 의존 회피):
- **R1**: 시계열 차트 컨테이너/SVG 폭이 콘텐츠 폭(~1104px)에 근접(좌측 dead space 없음). 예: `document.querySelector('section[aria-label*="초당 요청"] svg')`의 `getBoundingClientRect().width`가 700보다 충분히 큰지.
- **R4/R5**: `내려받기 ▾` 트리거 클릭 → `menuitem` 4개 노출; 키보드 ArrowDown→첫 항목 포커스; ESC→닫힘+트리거 포커스.
- **R6**: 한 항목(예: CSV) 실제 다운로드가 동작(파일 저장 or blob anchor) · JSON 항목도 동작.
- **R8**: `파일 형식 설명` ⓘ(? 버튼) 클릭 → 4개 포맷 설명 노출.
- **console Zod/에러 0**(fresh navigate 후 `browser_console_messages` — `all` 없이).

- [ ] **Step 3: 정리 + diff 불변식 확인**

`rm -rf .playwright-mcp` + 루트 png 정리. `git diff --name-only master..HEAD`가 `ui/src`·`docs`만(R10) — `schemas.ts`/`crates/`/`.proto`/`.sql` 0-diff 재확인.

---

## Self-Review

**1. Spec coverage:**
- R1 차트 반응형 → Task 1 + 라이브 Step 2. R2 width/height optional·게이트·children 단일 → Task 1. R3 ReportView width-free → Task 4(ReportView.tsx 재구성 시 차트 호출 무변경; 이미 width-free). R4 단일 메뉴·평면버튼 제거 → Task 4(ReportView.test 단언 + ReportView.tsx 재구성). R5 DownloadMenu a11y → Task 3. R6 byte-identical 다운로드 → Task 4(items 인자·ReportView.test 단언). R7 downloadJson 추출·버튼 제거·주석 reword·grep-0 → Task 2 + Task 4(삭제·주석 reword·grep). R8 HelpTip 4포맷 → Task 4(ko 키·HelpTip 렌더·ReportView.test 단언). R9 ko 경유·인라인 영어 은퇴 → Task 4(ko 키·헤더 재구성). R10 0-diff → Task 5 Step 3.
- 갭 없음.

**2. Placeholder scan:** 모든 코드 블록은 실제 코드(생략·TBD 없음). 차트 5종은 동일 패턴이라 Task 1에 각 파일별 정확한 edit 명시.

**3. Type consistency:** `DownloadMenuItem = {label, onSelect}`(Task 3) ↔ ReportView `items`(Task 4) 일치. `downloadJson(filename, data)`(Task 2) ↔ ReportView 호출·테스트 mock 일치. `ko.report.downloadMenu`/`downloadHelpAria`/`downloadInsightsCsv`/`downloadHelp.{json,csv,xlsx,insights}`(정의 Task 4 Step 2·참조 Step 1) ↔ ReportView·테스트 참조 일치. 차트 `width?`/`height?` optional 유지(시그니처 무변경 — 기본값만 제거).

**4. 커밋 경계:** 각 task = 독립 green 커밋. Task 4가 `DownloadJsonButton` 삭제와 ReportView 전환을 같은 커밋에 묶어 dangling import 없음(green 보장).

REVIEW-GATE: APPROVED

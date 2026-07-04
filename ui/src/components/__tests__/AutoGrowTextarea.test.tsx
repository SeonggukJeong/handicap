import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutoGrowTextarea } from "../AutoGrowTextarea";

describe("AutoGrowTextarea", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("renders a textarea with the value and a stable accessible name", () => {
    render(<AutoGrowTextarea value="hello" aria-label="v" onChange={() => {}} />);
    const ta = screen.getByRole("textbox", { name: "v" });
    expect(ta).toHaveValue("hello");
    expect(ta.tagName).toBe("TEXTAREA");
  });

  it("forwards onChange edits", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AutoGrowTextarea value="" aria-label="v" onChange={onChange} />);
    await user.type(screen.getByRole("textbox", { name: "v" }), "x");
    expect(onChange).toHaveBeenCalled();
  });

  it("is full-width and merges a caller className (no resize handle)", () => {
    render(<AutoGrowTextarea value="" aria-label="v" className="border" onChange={() => {}} />);
    const ta = screen.getByRole("textbox", { name: "v" });
    expect(ta).toHaveClass("w-full"); // 전폭
    expect(ta).toHaveClass("resize-none"); // 사용자 리사이즈 핸들 없음(자동 성장)
    expect(ta).toHaveClass("border"); // caller className 병합
  });

  it("E: 캡 미만 값은 세로 스크롤바 없음 — overflow-y-auto 제거, overflowY=hidden", () => {
    render(<AutoGrowTextarea value="short" aria-label="v" onChange={() => {}} />);
    const ta = screen.getByRole("textbox", { name: "v" }) as HTMLTextAreaElement;
    expect(ta).not.toHaveClass("overflow-y-auto"); // A의 styled 바가 1줄에서 노출되던 원인 제거
    expect(ta).toHaveClass("resize-none");
    expect(ta).toHaveClass("max-h-40");
    // jsdom scrollHeight=0 → full(0) ≤ MAX(160) → overflowY="hidden"
    expect(ta.style.overflowY).toBe("hidden");
  });

  it("폭이 바뀌면(예: 변수 넓게 보기) value 불변이어도 높이를 재계산한다 (ResizeObserver)", () => {
    // 좁을 때 2줄이던 값이 열이 넓어져 1줄로 재배치돼도 높이가 2줄로 stale하던 버그(#varsWide).
    let roCallback: ResizeObserverCallback | undefined;
    const observed: Element[] = [];
    class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        roCallback = cb;
      }
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);

    render(<AutoGrowTextarea value="http://127.0.0.1:9999" aria-label="v" onChange={() => {}} />);
    const ta = screen.getByRole("textbox", { name: "v" }) as HTMLTextAreaElement;
    // 폭 변경을 관찰하도록 textarea가 ResizeObserver에 등록됨
    expect(observed).toContain(ta);

    // 넓어져 같은 값이 1줄로 재배치됨 → scrollHeight 축소(jsdom은 layout이 없어 수동 주입)
    Object.defineProperty(ta, "scrollHeight", { configurable: true, value: 28 });
    roCallback?.([{ contentRect: { width: 756 } } as ResizeObserverEntry], {} as ResizeObserver);
    // value 변경 없이 폭 변경만으로 높이가 1줄(28px)로 재계산됨
    expect(ta.style.height).toBe("28px");
    expect(ta.style.overflowY).toBe("hidden");
  });
});

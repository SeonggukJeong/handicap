import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNow } from "../useNow";

afterEach(() => vi.useRealTimers());

describe("useNow", () => {
  it("intervalMs마다 현재 시각으로 갱신된다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { result } = renderHook(() => useNow(1000));
    expect(result.current).toBe(1_000_000);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBe(1_003_000);
  });

  it("intervalMs=null이면 틱 없이 mount 시각 고정", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const { result } = renderHook(() => useNow(null));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(2_000_000);
  });

  it("unmount 시 interval을 정리한다", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = renderHook(() => useNow(1000));
    unmount();
    expect(spy).toHaveBeenCalled();
  });
});

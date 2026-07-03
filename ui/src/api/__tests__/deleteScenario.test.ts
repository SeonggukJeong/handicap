import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../client";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("api.deleteScenario", () => {
  it("204 → {deleted:true}, force 시 쿼리 포함", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const result = await api.deleteScenario("S1", true);
    expect(result).toEqual({ deleted: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/scenarios/S1?force=true");
    expect(init.method).toBe("DELETE");
  });

  it("force 미지정이면 쿼리 없음", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await api.deleteScenario("S1");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/api/scenarios/S1");
    expect(url).not.toContain("force");
  });

  it("soft 409(숫자 카운트) → {deleted:false, refs}", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "참조", runs: 2, presets: 1, schedules: 0 }, 409),
    );
    const result = await api.deleteScenario("S1");
    expect(result).toEqual({
      deleted: false,
      refs: { runs: 2, presets: 1, schedules: 0 },
    });
  });

  it("hard 409(문자열 error만) → ApiError throw", async () => {
    // 호출마다 fresh Response — 한 Response 재사용은 두 번째 res.json()이
    // consumed body로 떨어져 단언이 약해진다
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: "실행 중 run" }, 409)),
    );
    await expect(api.deleteScenario("S1")).rejects.toThrowError(
      expect.objectContaining({ message: "실행 중 run" }) as Error,
    );
    await expect(
      api.deleteScenario("S1").catch((e) => Promise.reject(e instanceof ApiError)),
    ).rejects.toBe(true);
  });

  it("기타 비-2xx → ApiError throw", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "nf" }, 404));
    await expect(api.deleteScenario("S1")).rejects.toBeInstanceOf(ApiError);
  });
});

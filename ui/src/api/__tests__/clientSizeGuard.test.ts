import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../client";

describe("시나리오 저장 2MiB 사전 가드 (spec R6)", () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("2MiB 이상 body → fetch 없이 한국어 한도 에러 (create/update)", async () => {
    const huge = "a".repeat(2 * 1024 * 1024); // JSON 래퍼 오버헤드로 body는 확실히 >= 2MiB
    await expect(api.createScenario(huge)).rejects.toThrow("저장 한도");
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(api.updateScenario("SC1", huge, 1)).rejects.toThrow("저장 한도");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("한도 미만 body → 가드 통과, fetch 발생", async () => {
    await api.createScenario("version: 1").catch(() => {
      // 응답 파싱 실패는 이 테스트 무관 — fetch 호출 여부만 본다
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

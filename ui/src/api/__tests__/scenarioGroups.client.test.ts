import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../client";

function mockFetch(body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
afterEach(() => vi.unstubAllGlobals());

const scenario = {
  id: "01",
  name: "n",
  yaml: "version: 1\n",
  version: 1,
  created_at: 0,
  updated_at: 0,
  group: null,
};

function sentBody(fn: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string);
}

describe("scenario group wire", () => {
  it("createScenario omits the group key when none is given", async () => {
    const fn = mockFetch(scenario);
    await api.createScenario("y");
    expect("group" in sentBody(fn)).toBe(false);
  });

  it("createScenario omits the group key for null", async () => {
    const fn = mockFetch(scenario);
    await api.createScenario("y", null);
    expect("group" in sentBody(fn)).toBe(false);
  });

  it("createScenario sends the group when given", async () => {
    const fn = mockFetch(scenario);
    await api.createScenario("y", "G");
    expect(sentBody(fn).group).toBe("G");
  });

  it("assignScenarioGroup always sends the group key, null included", async () => {
    const fn = mockFetch({ updated: 1 });
    const res = await api.assignScenarioGroup(["a"], null);
    expect(res).toEqual({ updated: 1 });
    expect(String(fn.mock.calls[0][0])).toContain("/api/scenario-groups/assign");
    expect((fn.mock.calls[0][1] as RequestInit).method).toBe("POST");
    const body = sentBody(fn);
    expect("group" in body).toBe(true);
    expect(body).toEqual({ scenario_ids: ["a"], group: null });
  });

  it("renameScenarioGroup posts from/to", async () => {
    const fn = mockFetch({ updated: 2 });
    const res = await api.renameScenarioGroup("A", "B");
    expect(res).toEqual({ updated: 2 });
    expect(String(fn.mock.calls[0][0])).toContain("/api/scenario-groups/rename");
    expect(sentBody(fn)).toEqual({ from: "A", to: "B" });
  });
});

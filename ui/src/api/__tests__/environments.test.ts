import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  EnvironmentSchema,
  EnvironmentSummarySchema,
  listEnvironments,
  createEnvironment,
} from "../environments";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("environments schemas", () => {
  it("parses a full environment (vars present)", () => {
    const e = EnvironmentSchema.parse({
      id: "01J",
      name: "staging",
      vars: { BASE_URL: "http://s", API_KEY: "k" },
      created_at: 1,
      updated_at: 2,
    });
    expect(e.vars.BASE_URL).toBe("http://s");
  });

  it("parses a summary (var_count, no vars)", () => {
    const s = EnvironmentSummarySchema.parse({
      id: "01J",
      name: "staging",
      var_count: 2,
      created_at: 1,
      updated_at: 2,
    });
    expect(s.var_count).toBe(2);
  });
});

describe("environments client", () => {
  it("listEnvironments unwraps the {environments:[...]} envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        environments: [{ id: "1", name: "s", var_count: 0, created_at: 1, updated_at: 1 }],
      }),
    );
    const out = await listEnvironments();
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("s");
  });

  it("createEnvironment surfaces the server error message on 409", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "같은 이름의 환경이 이미 있습니다" }, 409),
    );
    await expect(createEnvironment({ name: "dup", vars: {} })).rejects.toThrow(/이미 있습니다/);
  });
});

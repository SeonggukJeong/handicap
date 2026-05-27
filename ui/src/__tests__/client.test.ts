import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../api/client";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.listScenarios", () => {
  it("GETs /api/scenarios and parses the result", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ scenarios: [] }));
    const out = await api.listScenarios();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/scenarios");
    expect(init.method).toBe("GET");
    expect(out.scenarios).toEqual([]);
  });
});

describe("api.createScenario", () => {
  it("POSTs the yaml as JSON body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          id: "x",
          name: "n",
          yaml: "y",
          version: 1,
          created_at: 0,
          updated_at: 0,
        },
        201,
      ),
    );
    await api.createScenario("y");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ yaml: "y" });
  });
});

describe("api.updateScenario", () => {
  it("PUTs yaml + version", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "x", name: "n", yaml: "y", version: 2, created_at: 0, updated_at: 0 }),
    );
    await api.updateScenario("x", "y", 1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/scenarios/x");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ yaml: "y", version: 1 });
  });
});

describe("error handling", () => {
  it("throws ApiError with parsed message on 4xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad yaml" }, 400));
    await expect(api.createScenario("x")).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      message: "bad yaml",
    });
  });

  it("falls back to status text on non-JSON error body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("kaboom", { status: 500, headers: { "content-type": "text/plain" } }),
    );
    await expect(api.getRun("x")).rejects.toBeInstanceOf(ApiError);
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTestRun } from "../hooks";

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

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const TRACE = {
  ok: true,
  total_ms: 5,
  truncated: false,
  error: null,
  final_vars: {},
  steps: [],
};

describe("useTestRun", () => {
  it("POSTs scenario_yaml + env + max_requests to /api/test-runs and parses the trace", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(TRACE)));
    const { result } = renderHook(() => useTestRun(), { wrapper });

    result.current.mutate({
      scenario_yaml: "version: 1\nname: s\nsteps: []\n",
      env: { BASE_URL: "http://x" },
      max_requests: 25,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/test-runs$/);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      scenario_yaml: "version: 1\nname: s\nsteps: []\n",
      env: { BASE_URL: "http://x" },
      max_requests: 25,
    });
  });

  it("surfaces a 422 as an error", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: "scenario parse: bad" }, 422)),
    );
    const { result } = renderHook(() => useTestRun(), { wrapper });
    result.current.mutate({ scenario_yaml: "nonsense", env: {} });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

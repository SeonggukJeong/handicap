import { describe, it, expect, vi, afterEach } from "vitest";
import { api, PoolCapacityError } from "../client";

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockFetch(status: number, body: unknown) {
  global.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

// Full valid Run fixture — RunSchema requires scenario_yaml, started_at, ended_at, created_at
// (copied from ScenarioRunsPage.test.tsx runRow pattern)
const SCENARIO_YAML =
  "version: 1\nname: demo\ncookie_jar: auto\nvariables: {}\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";

const FULL_RUN_FIXTURE = {
  id: "r1",
  scenario_id: "s1",
  scenario_yaml: SCENARIO_YAML,
  status: "pending",
  profile: { vus: 20, duration_seconds: 5, ramp_up_seconds: 0, loop_breakdown_cap: 256 },
  env: {},
  started_at: null,
  ended_at: null,
  created_at: 1,
};

describe("api.createRun pool capacity 409", () => {
  it("throws PoolCapacityError carrying the numbers on 409", async () => {
    mockFetch(409, { achievable_vus: 10, requested_vus: 20 });
    await expect(
      api.createRun("s1", { vus: 20, duration_seconds: 5 } as never, {}),
    ).rejects.toMatchObject({ achievable_vus: 10, requested_vus: 20 });
    await expect(
      api.createRun("s1", { vus: 20, duration_seconds: 5 } as never, {}),
    ).rejects.toBeInstanceOf(PoolCapacityError);
  });

  it("appends ?force=true when opts.force is set", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify(FULL_RUN_FIXTURE), { status: 201 }));
    global.fetch = spy as unknown as typeof fetch;
    await api.createRun("s1", { vus: 20, duration_seconds: 5 } as never, {}, { force: true });
    expect(String((spy.mock.calls[0] as unknown[])[0])).toContain("?force=true");
  });
});

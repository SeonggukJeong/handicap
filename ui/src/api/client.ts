import { z } from "zod";
import {
  ApiErrorSchema,
  MetricSummarySchema,
  RunListSchema,
  RunSchema,
  ScenarioListSchema,
  ScenarioSchema,
  type Profile,
} from "./schemas";

const BASE = "/api";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  init: RequestInit | undefined,
  parser: z.ZodType<T>,
): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await resp.text();
  if (!resp.ok) {
    let msg = text;
    try {
      const parsed = ApiErrorSchema.parse(JSON.parse(text));
      msg = parsed.error;
    } catch {
      // body is not in expected error shape — fall through with raw text.
    }
    throw new ApiError(resp.status, msg || `${resp.status} ${resp.statusText}`);
  }
  if (text.length === 0) {
    // For void responses; not used in slice 2 but cheap to allow.
    return parser.parse(undefined);
  }
  const json = JSON.parse(text);
  return parser.parse(json);
}

export const api = {
  listScenarios: () => request("/scenarios", { method: "GET" }, ScenarioListSchema),
  getScenario: (id: string) =>
    request(`/scenarios/${encodeURIComponent(id)}`, { method: "GET" }, ScenarioSchema),
  createScenario: (yaml: string) =>
    request("/scenarios", { method: "POST", body: JSON.stringify({ yaml }) }, ScenarioSchema),
  updateScenario: (id: string, yaml: string, version: number) =>
    request(
      `/scenarios/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify({ yaml, version }) },
      ScenarioSchema,
    ),
  listRunsForScenario: (id: string) =>
    request(`/scenarios/${encodeURIComponent(id)}/runs`, { method: "GET" }, RunListSchema),
  createRun: (scenario_id: string, profile: Profile, env: Record<string, unknown>) =>
    request(
      "/runs",
      { method: "POST", body: JSON.stringify({ scenario_id, profile, env }) },
      RunSchema,
    ),
  getRun: (id: string) => request(`/runs/${encodeURIComponent(id)}`, { method: "GET" }, RunSchema),
  getRunMetrics: (id: string) =>
    request(`/runs/${encodeURIComponent(id)}/metrics`, { method: "GET" }, MetricSummarySchema),
  abortRun: (id: string) =>
    request(`/runs/${encodeURIComponent(id)}/abort`, { method: "POST" }, z.object({}).passthrough()),
};

import { z } from "zod";
import {
  ApiErrorSchema,
  DatasetListSchema,
  DatasetPreviewSchema,
  DatasetSchema,
  MetricSummarySchema,
  ReportSchema,
  RunListSchema,
  RunSchema,
  ScenarioListSchema,
  ScenarioSchema,
  ScenarioTraceSchema,
  type Dataset,
  type DatasetPreview,
  type Profile,
  type Run,
} from "./schemas";
import { ko } from "../i18n/ko";

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

export class PoolCapacityError extends Error {
  constructor(
    public readonly achievable_vus: number,
    public readonly requested_vus: number,
  ) {
    super(ko.capacityGuard.shortError(achievable_vus));
    this.name = "PoolCapacityError";
  }
}

async function createRunImpl(
  scenario_id: string,
  profile: Profile,
  env: Record<string, string>,
  opts?: { force?: boolean },
): Promise<Run> {
  const res = await fetch(`${BASE}/runs${opts?.force ? "?force=true" : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario_id, profile, env }),
  });
  const text = await res.text();
  if (res.status === 409) {
    const body = JSON.parse(text) as { achievable_vus?: unknown; requested_vus?: unknown };
    if (typeof body.achievable_vus === "number" && typeof body.requested_vus === "number") {
      throw new PoolCapacityError(body.achievable_vus, body.requested_vus);
    }
  }
  if (!res.ok) {
    let msg = text;
    try {
      msg = ApiErrorSchema.parse(JSON.parse(text)).error;
    } catch {
      // raw text
    }
    throw new ApiError(res.status, msg || `${res.status} ${res.statusText}`);
  }
  return RunSchema.parse(JSON.parse(text));
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

// FormData 업로드용: content-type을 설정하지 않는다(브라우저가 boundary 포함해 자동 설정).
async function requestMultipart<T>(path: string, fd: FormData, parser: z.ZodType<T>): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, { method: "POST", body: fd }); // headers 미지정 = JSON 강제 안 함
  const text = await resp.text();
  if (!resp.ok) {
    let msg = text;
    try {
      const parsed = ApiErrorSchema.parse(JSON.parse(text));
      msg = parsed.error;
    } catch {
      // non-JSON / unexpected error shape — fall through with raw text.
    }
    throw new ApiError(resp.status, msg || `${resp.status} ${resp.statusText}`);
  }
  return parser.parse(JSON.parse(text));
}

export type DatasetUploadOptions = {
  name?: string;
  header?: boolean;
  delimiter?: string;
  encoding?: string;
  sheet?: string;
};

export type PresetRef = { preset_id: string; name: string; scenario_id: string };
export type DeleteDatasetResult = { deleted: true } | { deleted: false; presets: PresetRef[] };

/** DELETE a dataset. 204 → deleted. Soft 409 (only presets reference it) →
 *  {deleted:false, presets}. Hard 409 (active run) or other error → throws. */
async function deleteDatasetImpl(id: string, force: boolean): Promise<DeleteDatasetResult> {
  const res = await fetch(
    `${BASE}/datasets/${encodeURIComponent(id)}${force ? "?force=true" : ""}`,
    { method: "DELETE" },
  );
  if (res.status === 204) return { deleted: true };
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    if (Array.isArray((body as { presets?: unknown }).presets)) {
      return { deleted: false, presets: (body as { presets: PresetRef[] }).presets };
    }
    throw new ApiError(
      409,
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : "conflict",
    );
  }
  throw new ApiError(res.status, `${res.status} ${res.statusText}`);
}

export type ScenarioDeleteRefs = { runs: number; presets: number; schedules: number };
export type DeleteScenarioResult = { deleted: true } | { deleted: false; refs: ScenarioDeleteRefs };

/** DELETE a scenario. 204 → deleted. Soft 409 (참조 카운트 포함) →
 *  {deleted:false, refs}. Hard 409 (활성 run — 문자열 error만)·기타 비-2xx → throws.
 *  판별자: soft 409 본문에만 숫자 runs/presets/schedules 키가 있다 (deleteDatasetImpl 미러). */
async function deleteScenarioImpl(id: string, force: boolean): Promise<DeleteScenarioResult> {
  const res = await fetch(
    `${BASE}/scenarios/${encodeURIComponent(id)}${force ? "?force=true" : ""}`,
    { method: "DELETE" },
  );
  if (res.status === 204) return { deleted: true };
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    const b = body as { runs?: unknown; presets?: unknown; schedules?: unknown; error?: unknown };
    if (
      typeof b.runs === "number" &&
      typeof b.presets === "number" &&
      typeof b.schedules === "number"
    ) {
      return {
        deleted: false,
        refs: { runs: b.runs, presets: b.presets, schedules: b.schedules },
      };
    }
    throw new ApiError(409, typeof b.error === "string" ? b.error : "conflict");
  }
  const body = await res.json().catch(() => ({}) as Record<string, unknown>);
  const msg = (body as { error?: unknown }).error;
  throw new ApiError(res.status, typeof msg === "string" ? msg : `${res.status} ${res.statusText}`);
}

function buildDatasetForm(file: File, opts?: DatasetUploadOptions): FormData {
  const fd = new FormData();
  fd.append("file", file);
  if (opts?.name) fd.append("name", opts.name);
  if (opts?.header !== undefined) fd.append("header", String(opts.header));
  if (opts?.delimiter) fd.append("delimiter", opts.delimiter);
  if (opts?.encoding) fd.append("encoding", opts.encoding);
  if (opts?.sheet) fd.append("sheet", opts.sheet);
  return fd;
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
  createRun: (
    scenario_id: string,
    profile: Profile,
    env: Record<string, string>,
    opts?: { force?: boolean },
  ) => createRunImpl(scenario_id, profile, env, opts),
  createTestRun: (body: {
    scenario_yaml: string;
    env: Record<string, string>;
    max_requests?: number;
    apply_think_time?: boolean;
  }) => request("/test-runs", { method: "POST", body: JSON.stringify(body) }, ScenarioTraceSchema),
  getRun: (id: string) => request(`/runs/${encodeURIComponent(id)}`, { method: "GET" }, RunSchema),
  getRunMetrics: (id: string) =>
    request(`/runs/${encodeURIComponent(id)}/metrics`, { method: "GET" }, MetricSummarySchema),
  getRunReport: (id: string) =>
    request(`/runs/${encodeURIComponent(id)}/report`, { method: "GET" }, ReportSchema),
  abortRun: (id: string) =>
    request(
      `/runs/${encodeURIComponent(id)}/abort`,
      { method: "POST" },
      z.object({}).passthrough(),
    ),
  listDatasets: () => request("/datasets", { method: "GET" }, DatasetListSchema),
  getDataset: (id: string) =>
    request(`/datasets/${encodeURIComponent(id)}`, { method: "GET" }, DatasetSchema),
  uploadDataset: (file: File, opts?: DatasetUploadOptions): Promise<Dataset> =>
    requestMultipart("/datasets", buildDatasetForm(file, opts), DatasetSchema),
  previewDataset: (file: File, opts?: DatasetUploadOptions): Promise<DatasetPreview> =>
    requestMultipart("/datasets/preview", buildDatasetForm(file, opts), DatasetPreviewSchema),
  deleteDataset: (id: string, force = false): Promise<DeleteDatasetResult> =>
    deleteDatasetImpl(id, force),
  deleteScenario: (id: string, force = false): Promise<DeleteScenarioResult> =>
    deleteScenarioImpl(id, force),

  // File download URL builders — return raw URL strings (do NOT go through request()).
  reportCsvUrl: (runId: string) => `${BASE}/runs/${encodeURIComponent(runId)}/report.csv`,
  reportXlsxUrl: (runId: string) => `${BASE}/runs/${encodeURIComponent(runId)}/report.xlsx`,
  compareCsvUrl: (scenarioId: string, runIds: string[], baseline: string) =>
    `${BASE}/scenarios/${encodeURIComponent(scenarioId)}/runs/compare.csv?run_ids=${runIds.map(encodeURIComponent).join(",")}&baseline=${encodeURIComponent(baseline)}`,
  compareXlsxUrl: (scenarioId: string, runIds: string[], baseline: string) =>
    `${BASE}/scenarios/${encodeURIComponent(scenarioId)}/runs/compare.xlsx?run_ids=${runIds.map(encodeURIComponent).join(",")}&baseline=${encodeURIComponent(baseline)}`,
  reportInsightsCsvUrl: (runId: string) =>
    `${BASE}/runs/${encodeURIComponent(runId)}/report-insights.csv`,
  compareInsightsCsvUrl: (scenarioId: string, runIds: string[], baseline: string) =>
    `${BASE}/scenarios/${encodeURIComponent(scenarioId)}/runs/compare-insights.csv?run_ids=${runIds.map(encodeURIComponent).join(",")}&baseline=${encodeURIComponent(baseline)}`,
};

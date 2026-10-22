import { z } from "zod";
import { ApiError } from "./client";
import { ScenarioTraceSchema } from "./schemas";
import { newStepId } from "../scenario/ulid";

const BASE = "/api/monitor-boards";

// Wire contract mirrors crates/controller/src/monitor/{config,check}.rs and
// api/monitor_boards.rs 1:1. Option fields serialize as JSON null (never
// omitted) -> .nullable(). No .default() anywhere (ui/CLAUDE.md leak trap).

export const FontScaleSchema = z.enum(["small", "medium", "large", "xlarge"]);
export type FontScale = z.infer<typeof FontScaleSchema>;

export const BlinkSchema = z.enum(["off", "fail", "slow_and_fail"]);
export type Blink = z.infer<typeof BlinkSchema>;

export const LatencySourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("total") }),
  z.object({ kind: z.literal("step"), step_id: z.string() }),
]);
export type LatencySource = z.infer<typeof LatencySourceSchema>;

export const ThresholdSchema = z.object({ ms: z.number().int(), color: z.string() });
export type Threshold = z.infer<typeof ThresholdSchema>;

export const ConditionSourceSchema = z.enum(["body", "header", "status", "body_text"]);
export type ConditionSource = z.infer<typeof ConditionSourceSchema>;
export const ConditionOpSchema = z.enum([
  "exists",
  "not_empty",
  "eq",
  "ne",
  "contains",
  "gt",
  "lt",
]);
export type ConditionOp = z.infer<typeof ConditionOpSchema>;

export const ConditionSchema = z.object({
  step_id: z.string(),
  source: ConditionSourceSchema,
  path: z.string(),
  op: ConditionOpSchema,
  value: z.string(),
  ignore_case: z.boolean(),
  trim: z.boolean(),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const PanelConfigSchema = z.object({
  id: z.string(),
  title: z.string(),
  scenario_id: z.string(),
  environment_id: z.string().nullable(),
  interval_seconds: z.number().int(),
  timeout_seconds: z.number().int(),
  latency_source: LatencySourceSchema,
  thresholds: z.array(ThresholdSchema),
  bar_count: z.number().int(),
  graph_max_ms: z.number().int(),
  conditions: z.array(ConditionSchema),
});
export type PanelConfig = z.infer<typeof PanelConfigSchema>;

export const BoardConfigSchema = z.object({
  font_scale: FontScaleSchema,
  blink: BlinkSchema,
  panels: z.array(PanelConfigSchema),
});
export type BoardConfig = z.infer<typeof BoardConfigSchema>;

export const CheckResultSchema = z.object({
  at_ms: z.number(),
  verdict: z.enum(["ok", "fail", "config_error"]),
  latency_ms: z.number().nullable(),
  reason: z.string().nullable(),
  detail: z.string().nullable(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const BoardSchema = z.object({
  id: z.string(),
  name: z.string(),
  config: BoardConfigSchema,
  enabled: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type Board = z.infer<typeof BoardSchema>;

const BoardListSchema = z.object({ boards: z.array(BoardSchema) });

export const PanelStatusSchema = z.object({
  panel_id: z.string(),
  results: z.array(CheckResultSchema),
  consecutive_fail: z.number().int(),
  fail_since_ms: z.number().nullable(),
  running: z.boolean(),
});

export const StatusSchema = z.object({
  now_ms: z.number(),
  board_updated_at: z.number(),
  enabled: z.boolean(),
  started_at_ms: z.number().nullable(),
  panels: z.array(PanelStatusSchema),
});
export type BoardStatus = z.infer<typeof StatusSchema>;

export const PreviewSchema = z.object({
  trace: ScenarioTraceSchema.nullable(),
  result: CheckResultSchema,
});
export type PreviewResult = z.infer<typeof PreviewSchema>;

export type BoardInput = { name: string; config: BoardConfig };

/** New panel with Global Constraints defaults; id is client-issued. */
export function newPanel(): PanelConfig {
  return {
    id: newStepId(),
    title: "",
    scenario_id: "",
    environment_id: null,
    interval_seconds: 10,
    timeout_seconds: 5,
    latency_source: { kind: "total" },
    thresholds: [],
    bar_count: 60,
    graph_max_ms: 2000,
    conditions: [],
  };
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as unknown;
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      return body.error;
    }
  } catch {
    // non-JSON body
  }
  return `HTTP ${res.status}`;
}

async function fail(res: Response): Promise<never> {
  throw new ApiError(res.status, await errorMessage(res));
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

const idUrl = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

export async function listBoards(): Promise<Board[]> {
  const res = await fetch(BASE);
  if (!res.ok) return fail(res);
  return BoardListSchema.parse(await res.json()).boards;
}

export async function getBoard(id: string): Promise<Board> {
  const res = await fetch(idUrl(id));
  if (!res.ok) return fail(res);
  return BoardSchema.parse(await res.json());
}

export async function createBoard(input: BoardInput): Promise<Board> {
  const res = await fetch(BASE, jsonInit("POST", input));
  if (!res.ok) return fail(res);
  return BoardSchema.parse(await res.json());
}

export async function updateBoard(id: string, input: BoardInput): Promise<Board> {
  const res = await fetch(idUrl(id), jsonInit("PUT", input));
  if (!res.ok) return fail(res);
  return BoardSchema.parse(await res.json());
}

export async function deleteBoard(id: string): Promise<void> {
  const res = await fetch(idUrl(id), { method: "DELETE" });
  if (!res.ok) return fail(res);
}

export async function startBoard(id: string): Promise<Board> {
  const res = await fetch(`${idUrl(id)}/start`, { method: "POST" });
  if (!res.ok) return fail(res);
  return BoardSchema.parse(await res.json());
}

export async function stopBoard(id: string): Promise<Board> {
  const res = await fetch(`${idUrl(id)}/stop`, { method: "POST" });
  if (!res.ok) return fail(res);
  return BoardSchema.parse(await res.json());
}

/** Per-request bound for status polls: a hung request must count as a failure. */
export const STATUS_TIMEOUT_MS = 3000;

/**
 * `signal` (React Query's) cancels on unmount; the request is additionally
 * aborted after `timeoutMs`, because an interval refetch re-uses an in-flight
 * promise — one request that never settles would otherwise stop all polling
 * and freeze the wall on its last (possibly green) state (US5).
 */
export async function getBoardStatus(
  id: string,
  signal?: AbortSignal,
  timeoutMs: number = STATUS_TIMEOUT_MS,
): Promise<BoardStatus> {
  const ctrl = new AbortController();
  const forward = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  else signal?.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${idUrl(id)}/status`, { signal: ctrl.signal });
    if (!res.ok) return await fail(res);
    return StatusSchema.parse(await res.json());
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}

export async function previewCheck(panel: PanelConfig): Promise<PreviewResult> {
  const res = await fetch(`${BASE}/preview-check`, jsonInit("POST", panel));
  if (!res.ok) return fail(res);
  return PreviewSchema.parse(await res.json());
}

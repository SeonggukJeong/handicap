import { z } from "zod";

const BASE = "/api";

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as unknown;
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      return body.error;
    }
  } catch {
    /* non-JSON */
  }
  return `HTTP ${res.status}`;
}

export const PoolWorkerSummarySchema = z.object({
  worker_id: z.string(),
  hostname: z.string(),
  capacity_vus: z.number(),
  busy: z.boolean(),
  run_id: z.string().nullable(),
  last_seen_secs_ago: z.number(),
  drained: z.boolean(),
  capacity_override: z.number().nullable(),
  label: z.string().nullable(),
});
export type PoolWorkerSummary = z.infer<typeof PoolWorkerSummarySchema>;

export const PoolWorkersResponseSchema = z.object({
  pool_mode: z.boolean(),
  workers: z.array(PoolWorkerSummarySchema),
  heartbeat_interval_seconds: z.number(),
  stale_timeout_seconds: z.number(),
});
export type PoolWorkersResponse = z.infer<typeof PoolWorkersResponseSchema>;

export async function listPoolWorkers(): Promise<PoolWorkersResponse> {
  const res = await fetch(`${BASE}/pool/workers`);
  if (!res.ok) throw new Error(`pool workers ${res.status}`);
  return PoolWorkersResponseSchema.parse(await res.json());
}

export async function patchPoolWorker(
  id: string,
  body: { drained?: boolean; capacity_override?: number | null; label?: string | null },
): Promise<PoolWorkerSummary> {
  const res = await fetch(`${BASE}/pool/workers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return PoolWorkerSummarySchema.parse(await res.json());
}

export async function excludePoolWorker(id: string, reason: string): Promise<void> {
  const res = await fetch(`${BASE}/pool/workers/${encodeURIComponent(id)}/exclude`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
}

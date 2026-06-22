import { z } from "zod";

const BASE = "/api";

export const PoolWorkerSummarySchema = z.object({
  worker_id: z.string(),
  hostname: z.string(),
  capacity_vus: z.number(),
  busy: z.boolean(),
  run_id: z.string().nullable(),
  last_seen_secs_ago: z.number(),
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

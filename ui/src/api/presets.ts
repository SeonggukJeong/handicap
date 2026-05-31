import { z } from "zod";
import { ProfileSchema, type Profile } from "./schemas";

const BASE = "/api";

export const PresetSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  vus: z.number().int(),
  duration_seconds: z.number().int(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type PresetSummary = z.infer<typeof PresetSummarySchema>;

export const PresetSchema = z.object({
  id: z.string(),
  scenario_id: z.string(),
  name: z.string(),
  profile: ProfileSchema,
  // Backend stores env as a JSON object; decode with envValueToRecord for prefill.
  env: z.unknown(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Preset = z.infer<typeof PresetSchema>;

const PresetListSchema = z.object({ presets: z.array(PresetSummarySchema) });

/**
 * Body for create/update — env is always string→string (API boundary).
 *
 * WHY NOT z.infer<typeof PresetSchema>: PresetSchema.profile nests ProfileSchema,
 * whose nested .default() fields (ramp_up_seconds, loop_breakdown_cap) leak
 * `number | undefined` into the inferred output, so Preset["profile"] is NOT
 * assignable to the standalone `Profile`. PresetInput.profile uses `Profile`
 * directly (clean numbers from form state or normalizeProfile()). Do not
 * "simplify" to a z.infer-derived type — pnpm test won't catch it, only
 * pnpm build (tsc -b). See ui/CLAUDE.md "Zod 중첩 .default() input 타입 누출".
 */
export type PresetInput = { name: string; profile: Profile; env: Record<string, string> };

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

export async function listPresets(scenarioId: string): Promise<PresetSummary[]> {
  const res = await fetch(`${BASE}/scenarios/${encodeURIComponent(scenarioId)}/presets`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return PresetListSchema.parse(await res.json()).presets;
}

export async function getPreset(id: string): Promise<Preset> {
  const res = await fetch(`${BASE}/presets/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return PresetSchema.parse(await res.json());
}

export async function createPreset(scenarioId: string, input: PresetInput): Promise<Preset> {
  const res = await fetch(`${BASE}/scenarios/${encodeURIComponent(scenarioId)}/presets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return PresetSchema.parse(await res.json());
}

export async function updatePreset(id: string, input: PresetInput): Promise<Preset> {
  const res = await fetch(`${BASE}/presets/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return PresetSchema.parse(await res.json());
}

export async function deletePreset(id: string): Promise<void> {
  const res = await fetch(`${BASE}/presets/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await errorMessage(res));
}

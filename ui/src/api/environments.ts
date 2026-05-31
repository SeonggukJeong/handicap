import { z } from "zod";

const BASE = "/api";

export const EnvironmentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  var_count: z.number().int(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type EnvironmentSummary = z.infer<typeof EnvironmentSummarySchema>;

// z.record(z.string(), z.string()) infers cleanly to Record<string,string> — NO
// nested .default() leak here (cf. ProfileSchema), so Environment["vars"] is usable
// directly. See ui/CLAUDE.md "Zod 중첩 .default() input 타입 누출" — N/A here. (Use the
// TWO-ARG form to match the codebase: model.ts / schemas.ts all spell it this way.)
export const EnvironmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  vars: z.record(z.string(), z.string()),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

const EnvironmentListSchema = z.object({ environments: z.array(EnvironmentSummarySchema) });

export type EnvironmentInput = { name: string; vars: Record<string, string> };

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

export async function listEnvironments(): Promise<EnvironmentSummary[]> {
  const res = await fetch(`${BASE}/environments`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return EnvironmentListSchema.parse(await res.json()).environments;
}

export async function getEnvironment(id: string): Promise<Environment> {
  const res = await fetch(`${BASE}/environments/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return EnvironmentSchema.parse(await res.json());
}

export async function createEnvironment(input: EnvironmentInput): Promise<Environment> {
  const res = await fetch(`${BASE}/environments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return EnvironmentSchema.parse(await res.json());
}

export async function updateEnvironment(id: string, input: EnvironmentInput): Promise<Environment> {
  const res = await fetch(`${BASE}/environments/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return EnvironmentSchema.parse(await res.json());
}

export async function deleteEnvironment(id: string): Promise<void> {
  const res = await fetch(`${BASE}/environments/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await errorMessage(res));
}

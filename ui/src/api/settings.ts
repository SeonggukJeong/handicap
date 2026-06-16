import { z } from "zod";

const BASE = "/api";

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

export const SettingSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    group: z.enum(["limits", "test_run", "scheduler"]),
    value: z.number(),
    default: z.number(),
    min: z.number(),
    max: z.number(),
    unit: z.string(),
    mutable: z.boolean(),
    source: z.enum(["override", "default", "readonly"]),
  })
  .strict();
export type Setting = z.infer<typeof SettingSchema>;

const SettingsResponse = z.object({ settings: z.array(SettingSchema) }).strict();

export async function getSettings(): Promise<Setting[]> {
  const r = await fetch(`${BASE}/settings`);
  if (!r.ok) throw new Error(await errorMessage(r));
  return SettingsResponse.parse(await r.json()).settings;
}

export async function putSetting(key: string, value: number): Promise<Setting> {
  const r = await fetch(`${BASE}/settings/${key}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });
  if (!r.ok) throw new Error(await errorMessage(r));
  return SettingSchema.parse(await r.json());
}

export async function deleteSetting(key: string): Promise<void> {
  const r = await fetch(`${BASE}/settings/${key}`, { method: "DELETE" });
  if (!r.ok && r.status !== 204) throw new Error(await errorMessage(r));
}

import { z } from "zod";

const BASE = "/api";

export const StepTemplateSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  step_count: z.number().int(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type StepTemplateSummary = z.infer<typeof StepTemplateSummarySchema>;

export const StepTemplateSchema = StepTemplateSummarySchema.extend({
  steps_yaml: z.string(),
});
export type StepTemplate = z.infer<typeof StepTemplateSchema>;

const StepTemplateListSchema = z.object({ templates: z.array(StepTemplateSummarySchema) });

export type StepTemplateInput = { name: string; description: string; steps_yaml: string };

/** 409 (같은 이름 존재). 서버 ConflictJson 본문 {error, id}의 id로 덮어쓰기 PUT 가능.
 *  conflictId null = pre-check race 백스톱의 plain Conflict(드묾) — 덮어쓰기 불가, 메시지만. */
export class StepTemplateConflictError extends Error {
  constructor(
    public readonly conflictId: string | null,
    message: string,
  ) {
    super(message);
    this.name = "StepTemplateConflictError";
  }
}

async function raise(res: Response): Promise<never> {
  let msg = `HTTP ${res.status}`;
  let conflictId: string | null = null;
  try {
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body.error === "string") msg = body.error;
    if (typeof body.id === "string") conflictId = body.id;
  } catch {
    // non-JSON body
  }
  if (res.status === 409) throw new StepTemplateConflictError(conflictId, msg);
  throw new Error(msg);
}

export async function listStepTemplates(): Promise<StepTemplateSummary[]> {
  const res = await fetch(`${BASE}/step-templates`);
  if (!res.ok) await raise(res);
  return StepTemplateListSchema.parse(await res.json()).templates;
}

export async function getStepTemplate(id: string): Promise<StepTemplate> {
  const res = await fetch(`${BASE}/step-templates/${encodeURIComponent(id)}`);
  if (!res.ok) await raise(res);
  return StepTemplateSchema.parse(await res.json());
}

export async function createStepTemplate(input: StepTemplateInput): Promise<StepTemplate> {
  const res = await fetch(`${BASE}/step-templates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) await raise(res);
  return StepTemplateSchema.parse(await res.json());
}

export async function updateStepTemplate(
  id: string,
  input: StepTemplateInput,
): Promise<StepTemplate> {
  const res = await fetch(`${BASE}/step-templates/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) await raise(res);
  return StepTemplateSchema.parse(await res.json());
}

export async function deleteStepTemplate(id: string): Promise<void> {
  const res = await fetch(`${BASE}/step-templates/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) await raise(res);
}

import {
  ScheduleSchema,
  ScheduleListSchema,
  ScheduleEventsSchema,
  PreviewNextSchema,
  type Schedule,
  type ScheduleSummary,
  type ScheduleEvent,
  type Trigger,
  type Profile,
} from "./schemas";

const BASE = "/api";

/** 요청 트리거(응답 Trigger와 동형 — discriminated union). */
export type TriggerInput = Trigger;

export type ScheduleInput = {
  name: string;
  scenario_id: string;
  profile: Profile;
  env: Record<string, string>;
  trigger: TriggerInput;
  enabled: boolean;
};

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

export async function listSchedules(): Promise<ScheduleSummary[]> {
  const res = await fetch(`${BASE}/schedules`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return ScheduleListSchema.parse(await res.json()).schedules;
}

export async function getSchedule(id: string): Promise<Schedule> {
  const res = await fetch(`${BASE}/schedules/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return ScheduleSchema.parse(await res.json());
}

export async function createSchedule(input: ScheduleInput): Promise<Schedule> {
  const res = await fetch(`${BASE}/schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return ScheduleSchema.parse(await res.json());
}

export async function updateSchedule(id: string, input: ScheduleInput): Promise<Schedule> {
  const res = await fetch(`${BASE}/schedules/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return ScheduleSchema.parse(await res.json());
}

export async function deleteSchedule(id: string): Promise<void> {
  const res = await fetch(`${BASE}/schedules/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await errorMessage(res));
}

export async function scheduleEvents(id: string): Promise<ScheduleEvent[]> {
  const res = await fetch(`${BASE}/schedules/${encodeURIComponent(id)}/events`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return ScheduleEventsSchema.parse(await res.json()).events;
}

export async function previewNext(trigger: TriggerInput, count: number): Promise<number[]> {
  const res = await fetch(`${BASE}/schedules/preview-next`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trigger, count }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return PreviewNextSchema.parse(await res.json()).next;
}

import type { TriggerInput } from "../api/schedules";

export type TriggerMode = "once" | "daily" | "weekly" | "interval" | "advanced";
export type IntervalUnit = "minutes" | "hours";

export type BuilderState = {
  mode: TriggerMode;
  time: string; // "HH:mm" (daily/weekly)
  days: number[]; // 0=Sun..6=Sat (weekly)
  everyN: number; // interval
  unit: IntervalUnit;
  raw: string; // advanced raw cron
  runAtLocal: string; // datetime-local "YYYY-MM-DDTHH:mm" (once)
};

const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

/** 빌더 상태 → 제출용 TriggerInput. 미완성(빈 time·요일 없음·빈 raw 등)이면 null. */
export function compileTrigger(s: BuilderState): TriggerInput | null {
  switch (s.mode) {
    case "once": {
      if (!s.runAtLocal) return null;
      const ms = new Date(s.runAtLocal).getTime();
      return Number.isFinite(ms) ? { kind: "once", run_at: ms } : null;
    }
    case "daily": {
      const hm = parseTime(s.time);
      if (!hm) return null;
      return { kind: "cron", cron_expr: `${hm.m} ${hm.h} * * *` };
    }
    case "weekly": {
      const hm = parseTime(s.time);
      if (!hm || s.days.length === 0) return null;
      const days = [...s.days].sort((a, b) => a - b).join(",");
      return { kind: "cron", cron_expr: `${hm.m} ${hm.h} * * ${days}` };
    }
    case "interval": {
      if (!Number.isInteger(s.everyN) || s.everyN < 1) return null;
      const expr = s.unit === "minutes" ? `*/${s.everyN} * * * *` : `0 */${s.everyN} * * *`;
      return { kind: "cron", cron_expr: expr };
    }
    case "advanced": {
      const raw = s.raw.trim();
      return raw === "" ? null : { kind: "cron", cron_expr: raw };
    }
  }
}

function parseTime(t: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

/** 목록 요약(best-effort). 프리셋 모양은 친근하게, 나머지는 raw cron. */
export function describeTrigger(t: TriggerInput): string {
  if (t.kind === "once") return `1회: ${new Date(t.run_at).toLocaleString()}`;
  const e = t.cron_expr.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(\d+) (\d+) \* \* \*$/.exec(e))) return `매일 ${pad(m[2])}:${pad(m[1])}`;
  if ((m = /^(\d+) (\d+) \* \* ([\d,]+)$/.exec(e))) {
    const labels = m[3]
      .split(",")
      .map((d) => DAY_LABELS[Number(d) % 7] ?? d)
      .join(",");
    return `매주 ${labels} ${pad(m[2])}:${pad(m[1])}`;
  }
  if ((m = /^\*\/(\d+) \* \* \* \*$/.exec(e))) return `${m[1]}분마다`;
  if ((m = /^0 \*\/(\d+) \* \* \*$/.exec(e))) return `${m[1]}시간마다`;
  return `cron: ${e}`;
}

function pad(n: string): string {
  return n.padStart(2, "0");
}

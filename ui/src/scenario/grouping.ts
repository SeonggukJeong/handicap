import { isForbiddenTextChar } from "./jsonPath";

export const MAX_GROUP_CHARS = 40;
export const MAX_ASSIGN = 500;

export type Grouped<T> = { groups: { name: string; items: T[] }[]; ungrouped: T[] };

const byKo = (a: string, b: string) => a.localeCompare(b, "ko");

export function groupScenarios<T extends { group?: string | null }>(
  list: readonly T[],
): Grouped<T> {
  const map = new Map<string, T[]>();
  const ungrouped: T[] = [];
  for (const item of list) {
    const g = item.group;
    if (!g) {
      ungrouped.push(item);
      continue;
    }
    const bucket = map.get(g);
    if (bucket) bucket.push(item);
    else map.set(g, [item]);
  }
  const groups = [...map.keys()].sort(byKo).map((name) => ({ name, items: map.get(name)! }));
  return { groups, ungrouped };
}

export function groupNames(list: readonly { group?: string | null }[]): string[] {
  const set = new Set<string>();
  for (const item of list) if (item.group) set.add(item.group);
  return [...set].sort(byKo);
}

export function filterScenarios<T extends { name: string; group?: string | null }>(
  list: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...list];
  return list.filter(
    (s) => s.name.toLowerCase().includes(q) || (s.group ?? "").toLowerCase().includes(q),
  );
}

export type GroupNameCheck =
  | { ok: true; value: string | null }
  | { ok: false; reason: "too_long" | "forbidden" };

const TRIM_RE = /^[\p{White_Space}\u{FEFF}]+|[\p{White_Space}\u{FEFF}]+$/gu;

export function validateGroupName(input: string): GroupNameCheck {
  const value = input.replace(TRIM_RE, "");
  if (value === "") return { ok: true, value: null };
  const chars = [...value];
  if (chars.length > MAX_GROUP_CHARS) return { ok: false, reason: "too_long" };
  if (chars.some((ch) => isForbiddenTextChar(ch) || ch === "\u{FEFF}"))
    return { ok: false, reason: "forbidden" };
  return { ok: true, value };
}

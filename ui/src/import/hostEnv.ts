import type { EnvironmentInput } from "../api/environments";
import type { PreviewEntry } from "./filters";

export const RESERVED = new Set(["vu_id", "iter_id", "loop_index"]);
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// previewEntries에 등장하는 호스트, 요청 수 desc·동률 first-seen.
export function hostsByRequestCount(preview: readonly PreviewEntry[]): string[] {
  const count = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  for (const p of preview) {
    let host: string;
    try {
      host = new URL(p.url).host;
    } catch {
      continue;
    }
    if (!firstSeen.has(host)) firstSeen.set(host, order++);
    count.set(host, (count.get(host) ?? 0) + 1);
  }
  return [...firstSeen.keys()].sort(
    (a, b) => count.get(b)! - count.get(a)! || firstSeen.get(a)! - firstSeen.get(b)!,
  );
}

export function defaultHostVars(hosts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  hosts.forEach((h, i) => {
    out[h] = i === 0 ? "BASE_URL" : `BASE_URL_${i + 1}`;
  });
  return out;
}

export function originOf(host: string, preview: readonly PreviewEntry[]): string {
  for (const p of preview) {
    try {
      const u = new URL(p.url);
      if (u.host === host) return u.origin;
    } catch {
      // skip unparseable
    }
  }
  return "";
}

export function buildEnvInput(
  hostVars: Record<string, string>,
  preview: readonly PreviewEntry[],
  envName: string,
): EnvironmentInput {
  const vars: Record<string, string> = {};
  for (const [host, varName] of Object.entries(hostVars)) {
    vars[varName] = originOf(host, preview);
  }
  return { name: envName.trim(), vars };
}

export interface EnvValidation {
  ok: boolean;
  emptyHosts: string[];
  dupNames: string[];
  invalidHosts: string[];
  reservedHosts: string[];
  emptyEnvName: boolean;
}

export function validateEnv(hostVars: Record<string, string>, envName: string): EnvValidation {
  const entries = Object.entries(hostVars);
  const emptyHosts: string[] = [];
  const invalidHosts: string[] = [];
  const reservedHosts: string[] = [];
  const nameCount = new Map<string, number>();
  for (const [host, name] of entries) {
    const t = name.trim();
    if (t === "") emptyHosts.push(host);
    else if (!VAR_NAME_RE.test(t)) invalidHosts.push(host);
    else if (RESERVED.has(t)) reservedHosts.push(host);
    if (t !== "") nameCount.set(t, (nameCount.get(t) ?? 0) + 1);
  }
  const dupNames = [...nameCount.entries()].filter(([, c]) => c > 1).map(([n]) => n);
  const emptyEnvName = envName.trim() === "";
  const ok =
    entries.length > 0 &&
    emptyHosts.length === 0 &&
    invalidHosts.length === 0 &&
    dupNames.length === 0 &&
    !emptyEnvName;
  return { ok, emptyHosts, dupNames, invalidHosts, reservedHosts, emptyEnvName };
}

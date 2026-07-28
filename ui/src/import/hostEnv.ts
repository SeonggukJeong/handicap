import type { Environment, EnvironmentInput } from "../api/environments";
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

export interface HostEnvMatch {
  envId: string;
  envName: string;
  varName: string;
}

// 순수 origin 값만 매치 후보 — 경로/쿼리/해시가 붙은 값은 프리필 시
// ${VAR}${pathname}이 이중 경로로 해석되므로 매치 자체에서 제외한다 (spec R2).
// S-I1: non-special scheme(mysql:// 등)은 URL.origin이 문자열 "null"이라, 서로 다른
// non-special 값끼리 거짓 동치가 난다 — http(s)만 pure-origin 후보로 인정한다.
function pureOrigin(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.pathname !== "/" || u.search !== "" || u.hash !== "") return null;
  return u.origin;
}

export function matchHostsToEnvs(
  hosts: string[],
  preview: readonly PreviewEntry[],
  envs: readonly Environment[],
): Record<string, HostEnvMatch[]> {
  // S-I2: host마다 preview 전체를 재파싱(originOf)하면 O(hosts×entries) —
  // 대형 HAR(2만+ 엔트리) × K=20 fan-out에서 분 단위 메인스레드 블록이 된다.
  // 1패스로 host→origin 맵을 만들어 O(entries)로 낮춘다 (host별 first-seen,
  // originOf와 동일 시맨틱). S-I1의 http(s) 필터도 맵 생성 지점에서 함께 적용 —
  // non-special scheme(origin="null" 문자열) host는 맵에 아예 안 들어가
  // pureOrigin의 non-special 값과 거짓 동치될 여지가 원천 차단된다.
  const originByHost = new Map<string, string>();
  for (const p of preview) {
    let u: URL;
    try {
      u = new URL(p.url);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (u.host === "" || originByHost.has(u.host)) continue;
    originByHost.set(u.host, u.origin);
  }

  const sorted = [...envs].sort(
    (a, b) => b.updated_at - a.updated_at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const out: Record<string, HostEnvMatch[]> = {};
  for (const host of hosts) {
    const origin = originByHost.get(host);
    if (!origin || host === "") continue;
    const ms: HostEnvMatch[] = [];
    for (const e of sorted) {
      // 와이어는 BTreeMap이라 이미 사전순이지만 순서를 가정하지 않고 명시 정렬 (spec R2)
      const hit = Object.keys(e.vars)
        .sort()
        .find((v) => pureOrigin(e.vars[v]) === origin);
      if (hit !== undefined) ms.push({ envId: e.id, envName: e.name, varName: hit });
    }
    if (ms.length > 0) out[host] = ms;
  }
  return out;
}

export function resolveHostVars(
  hostsOrdered: string[],
  matches: Record<string, HostEnvMatch[]>,
  overrides: Record<string, string>,
): Record<string, string> {
  const defaults = defaultHostVars(hostsOrdered);
  // pre-pass: 현재 host의 override 값은 프리필 후보를 차단한다(재작성은 없음).
  // stale override(목록 밖 host)는 시드하지 않는다 (spec R3 MF1).
  const overrideNames = new Set<string>();
  for (const h of hostsOrdered) {
    const o = overrides[h];
    if (o !== undefined) overrideNames.add(o);
  }
  const usedByPrefill = new Set<string>();
  const out: Record<string, string> = {};
  for (const h of hostsOrdered) {
    const o = overrides[h];
    if (o !== undefined) {
      out[h] = o;
      continue;
    }
    const cand = matches[h]?.[0]?.varName;
    let name: string;
    if (
      cand !== undefined &&
      VAR_NAME_RE.test(cand) &&
      !RESERVED.has(cand) &&
      !overrideNames.has(cand) &&
      !usedByPrefill.has(cand)
    ) {
      name = cand;
    } else if (!usedByPrefill.has(defaults[h])) {
      // override와의 충돌은 일부러 막지 않는다 — 기존-가시 충돌(validateEnv dup)이고,
      // 막으면 매치 0건 경로가 개명돼 R8 byte-identical이 깨진다 (spec R3).
      name = defaults[h];
    } else {
      let k = 2;
      while (usedByPrefill.has(`BASE_URL_${k}`) || overrideNames.has(`BASE_URL_${k}`)) k++;
      name = `BASE_URL_${k}`;
    }
    usedByPrefill.add(name);
    out[h] = name;
  }
  return out;
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

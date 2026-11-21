import type { Run } from "../../api/schemas";

export type RunMeta = Pick<Run, "id" | "status" | "started_at" | "ended_at" | "created_at"> & {
  label: string | null;
  message: string | null;
};

export const toRunMeta = (
  r: Pick<Run, "id" | "status" | "started_at" | "ended_at" | "created_at" | "label" | "message">,
): RunMeta => ({
  id: r.id,
  status: r.status,
  started_at: r.started_at,
  ended_at: r.ended_at,
  created_at: r.created_at,
  label: r.label ?? null,
  message: r.message ?? null,
});

export type PairResult =
  | { kind: "ok"; before: RunMeta; after: RunMeta; candidates: RunMeta[] }
  | { kind: "tooFew" }
  | { kind: "foreign" }
  | { kind: "notTerminal" };

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "aborted"]);

function compareMeasured(x: RunMeta, y: RunMeta): number {
  const xs = x.started_at ?? x.created_at;
  const ys = y.started_at ?? y.created_at;
  if (xs !== ys) return xs - ys;
  if (x.created_at !== y.created_at) return x.created_at - y.created_at;
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
}

export function orderByMeasured(x: RunMeta, y: RunMeta): [RunMeta, RunMeta] {
  return compareMeasured(x, y) <= 0 ? [x, y] : [y, x];
}

export function resolvePair(a: {
  runIds: string[];
  pairParam: string | null;
  baseline: string | null;
  scenarioRuns: RunMeta[];
}): PairResult {
  const ids = Array.from(new Set(a.runIds));
  if (ids.length < 2) return { kind: "tooFew" };

  const byId = new Map(a.scenarioRuns.map((r) => [r.id, r]));
  const candidates: RunMeta[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) return { kind: "foreign" };
    candidates.push(r);
  }

  let pair: [RunMeta, RunMeta] | null = null;
  if (a.pairParam) {
    const [p, q, ...rest] = a.pairParam.split(",");
    const rp = byId.get(p);
    const rq = byId.get(q);
    if (rest.length === 0 && p !== q && rp && rq && ids.includes(p) && ids.includes(q)) {
      pair = [rp, rq];
    }
  }
  if (!pair) {
    if (candidates.length === 2) {
      pair = [candidates[0], candidates[1]];
    } else {
      const sorted = [...candidates].sort(compareMeasured);
      const base =
        (a.baseline !== null && candidates.find((r) => r.id === a.baseline)) || sorted[0];
      const rest = sorted.filter((r) => r.id !== base.id);
      pair = [base, rest[rest.length - 1]];
    }
  }

  const [before, after] = orderByMeasured(pair[0], pair[1]);
  if (!TERMINAL.has(before.status) || !TERMINAL.has(after.status)) return { kind: "notTerminal" };
  return { kind: "ok", before, after, candidates };
}

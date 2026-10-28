import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { MIN_FIT, nextSearch, type ScaleSearch } from "./display";

/** One probe's measurement at scale `fit` (Infinity needs = it fits). */
export type ProbeReport = {
  fit: number;
  /** Scale this probe needs (Infinity = it fits at `fit`). */
  need: number;
  /** Extra scale the reason lines need (Infinity = all fit). */
  reasonNeed: number;
  /** Extra scale the split-row probe lines need (Infinity = all fit). */
  splitNeed: number;
};

const SEARCH_START: ScaleSearch = { lo: MIN_FIT, hi: 1, cand: 1, done: false };

/**
 * One board text scale fixed by settings only (spec §7.3 축소 비율은 설정으로
 * 고정). Invisible size probes lay out worst-case settings text at `cand` and
 * `report` what they need; once every probe has reported for `cand`, a binary
 * search over [MIN_FIT, 1] moves on (wrapping makes the need non-linear, so a
 * single proportional step can overshoot). When `scaleKey` changes the search
 * restarts. Live results must never reach the key or the probes, and the
 * panels only take `fit` once the search is done.
 *
 * The reason line's own scale (`reasonFit`, R18) is read from the probes'
 * measurements after the search is done — so probes must re-measure on the
 * render where `done` turns true (pass it to memoized probes as a prop).
 * The split row's scale (`splitFit`, spec §6.2 `--split-fit`) is read the same
 * way, so one item panel never shrinks the other panels' text (D2.17).
 *
 * Search state lives in refs: measuring happens after paint, and chaining
 * layout-effect updates hits React's nested-update limit (#185).
 */
export function useScaleSearch(
  scaleKey: string,
  probeCount: number,
): {
  fit: number;
  reasonFit: number;
  splitFit: number;
  cand: number;
  done: boolean;
  report: (id: string, r: ProbeReport) => void;
} {
  const [fit, setFit] = useState(1);
  const [search, setSearch] = useState<ScaleSearch>(SEARCH_START);
  const searchRef = useRef(search);
  searchRef.current = search;
  const probeOk = useRef(new Map<string, boolean>());
  const [reasonFit, setReasonFit] = useState(1);
  const reasonNeeds = useRef(new Map<string, number>());
  const [splitFit, setSplitFit] = useState(1);
  const splitNeeds = useRef(new Map<string, number>());
  const countRef = useRef(probeCount);
  countRef.current = probeCount;

  const report = useCallback((id: string, r: ProbeReport) => {
    const cur = searchRef.current;
    if (r.fit !== cur.cand) return;
    if (cur.done) {
      reasonNeeds.current.set(id, r.reasonNeed);
      splitNeeds.current.set(id, r.splitNeed);
      if (reasonNeeds.current.size >= countRef.current) {
        const next = Math.min(1, ...reasonNeeds.current.values());
        setReasonFit((prev) => (Math.abs(prev - next) < 0.0001 ? prev : next));
      }
      if (splitNeeds.current.size >= countRef.current) {
        const next = Math.min(1, ...splitNeeds.current.values());
        setSplitFit((prev) => (Math.abs(prev - next) < 0.0001 ? prev : next));
      }
      return;
    }
    probeOk.current.set(id, !Number.isFinite(r.need));
    if (probeOk.current.size < countRef.current) return;
    const ok = [...probeOk.current.values()].every(Boolean);
    probeOk.current.clear();
    const next = nextSearch(cur, ok);
    searchRef.current = next;
    setSearch(next);
    if (next.done) setFit(next.lo);
  }, []);

  useLayoutEffect(() => {
    probeOk.current.clear();
    reasonNeeds.current.clear();
    splitNeeds.current.clear();
    searchRef.current = SEARCH_START;
    setSearch(SEARCH_START);
  }, [scaleKey]);

  return { fit, reasonFit, splitFit, cand: search.cand, done: search.done, report };
}

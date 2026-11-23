import { sampleNotice } from "../../compare/sampleNotice";
import { ko } from "../../i18n/ko";
import { formatDurationKo } from "../../i18n/duration";
import type { Profile } from "../../api/schemas";
import { profileDurationSeconds, seedBindingsFrom } from "../../api/runPrefill";
import { deriveLoadMode, fixedTarget } from "../../components/run/loadModel";
import { conditionsBox, rampSeconds } from "../conditions";
import { stepNo } from "../format";
import type { StepFacts } from "../scenarioFacts";
import { expandCriteria } from "../verdict";
import type { RunModel } from "./runModel";

export type FairKey = "load" | "env" | "scenario" | "criteria";
export type FairCard = { key: FairKey; title: string; same: boolean; line: string };
export type CondRow = { label: string; before: string; after: string; differs: boolean };
export type Fairness = {
  cards: FairCard[];
  statusLines: string[];
  anyDiff: boolean;
  diffNames: string[];
  criteriaSame: boolean;
  oneLine: string;
  condRows: CondRow[];
  /** 두 측정의 응답 시간 표본이 달라 숫자를 그대로 비교하기 어렵다는 안내. */
  sampleLine: string | null;
};

const F = ko.print.cmp.fair;
const C = ko.print.cmp.cond;
const L = ko.print.conditions.labels;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** null·undefined·키 없음은 같고, 객체 키 순서는 무시하며, 배열 순서는 유지한다. */
export function deepEqualLoose(a: unknown, b: unknown): boolean {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqualLoose(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!deepEqualLoose(a[k], b[k])) return false;
    return true;
  }
  return Object.is(a, b);
}

function omitNameNotes(o: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) if (k !== "name" && k !== "notes") out[k] = v;
  return out;
}

function stripSteps(v: unknown): unknown {
  return Array.isArray(v) ? v.map(stripStep) : v;
}

function stripStep(s: unknown): unknown {
  if (!isObj(s)) return s;
  const out = omitNameNotes(s);
  for (const k of ["do", "then", "else"]) if (k in out) out[k] = stripSteps(out[k]);
  if (Array.isArray(out.elif)) {
    out.elif = out.elif.map((e) =>
      isObj(e) && "then" in e ? { ...e, then: stripSteps(e.then) } : e,
    );
  }
  if (Array.isArray(out.branches)) {
    out.branches = out.branches.map((b) =>
      isObj(b) && "steps" in b ? { ...b, steps: stripSteps(b.steps) } : b,
    );
  }
  return out;
}

/** 최상위와 단계 객체의 name·notes만 지운다. 그 밖의 name(본문 필드·값 꺼내기·분기 이름)은 동작을 바꾸므로 남긴다. */
export function stripScenarioNames(yamlObj: unknown): unknown {
  if (!isObj(yamlObj)) return yamlObj;
  const out = omitNameNotes(yamlObj);
  if ("steps" in out) out.steps = stripSteps(out.steps);
  if (isObj(out.setup) && "steps" in out.setup) {
    out.setup = { ...out.setup, steps: stripSteps(out.setup.steps) };
  }
  return out;
}

type ItemKey =
  | "model"
  | "size"
  | "duration"
  | "ramp"
  | "basis"
  | "think"
  | "timeout"
  | "connect"
  | "maxInFlight"
  | "workers"
  | "data"
  | "stair";

const ITEM_ORDER: ItemKey[] = [
  "model",
  "size",
  "duration",
  "ramp",
  "basis",
  "think",
  "timeout",
  "connect",
  "maxInFlight",
  "workers",
  "data",
  "stair",
];

const NAMED_PROFILE_KEYS = [
  "vus",
  "target_rps",
  "stages",
  "vu_stages",
  "duration_seconds",
  "ramp_up_seconds",
  "think_time",
  "http_timeout_seconds",
  "connect_timeout_seconds",
  "max_in_flight",
  "worker_count",
  "stair",
  "steady",
  "criteria",
  "think_seed",
  "data_binding",
  "data_bindings",
];

function sizeValue(p: Profile): unknown {
  const { loadModel, rateMode } = deriveLoadMode(p);
  if (rateMode === "stair") return p.stair?.targets;
  if (loadModel === "closed") return rateMode === "curve" ? p.vu_stages : p.vus;
  return rateMode === "curve" ? p.stages : fixedTarget(p);
}

export function basisCondText(m: RunModel): string | null {
  const b = m.report.basis;
  if (!b) return null;
  return b.selected === "steady"
    ? C.basisSteady(b.config.ramp_seconds, b.config.discard_seconds)
    : C.basisWhole;
}

function itemValues(p: Profile, workers: number, basis: string | null): Record<ItemKey, unknown> {
  const { loadModel, rateMode } = deriveLoadMode(p);
  return {
    model: `${loadModel}/${rateMode}`,
    size: sizeValue(p),
    duration: profileDurationSeconds(p),
    ramp: rampSeconds(p),
    basis: basis ?? C.basisWhole,
    think: p.think_time,
    timeout: p.http_timeout_seconds,
    connect: p.connect_timeout_seconds,
    maxInFlight: p.max_in_flight,
    workers,
    data: seedBindingsFrom(p),
    stair: p.stair,
  };
}

function otherValues(p: Profile): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(p)) if (!NAMED_PROFILE_KEYS.includes(k)) out[k] = v;
  return out;
}

function sizeName(a: Profile, b: Profile): string {
  const ma = deriveLoadMode(a).loadModel;
  const mb = deriveLoadMode(b).loadModel;
  if (ma === "closed" && mb === "closed") return F.sizeClosed;
  if (ma === "open" && mb === "open") return F.sizeOpen;
  return F.sizeMixed;
}

function itemLabel(key: ItemKey, size: string): string {
  switch (key) {
    case "model":
      return L.model;
    case "size":
      return size;
    case "duration":
      return L.duration;
    case "ramp":
      return L.ramp;
    case "basis":
      return F.basis;
    case "think":
      return L.think;
    case "timeout":
      return L.timeout;
    case "connect":
      return F.connect;
    case "maxInFlight":
      return F.maxInFlight;
    case "workers":
      return L.workers;
    case "data":
      return F.data;
    case "stair":
      return F.stair;
  }
}

type ConditionsBox = ReturnType<typeof conditionsBox>;

function boxOf(m: RunModel): ConditionsBox {
  return conditionsBox({
    profileRaw: m.report.run.profile,
    workerBreakdownLen: m.report.worker_breakdown?.length ?? 0,
    envCount: Object.keys(m.env).length,
  });
}

function itemText(
  box: ConditionsBox,
  p: Profile,
  key: ItemKey,
  basis: string | null,
): string | null {
  const boxRow = (label: string): string | null =>
    box.ok ? (box.rows.find((r) => r.label === label)?.value ?? null) : null;
  switch (key) {
    case "model":
      return boxRow(L.model);
    case "size":
      return boxRow(L.size);
    case "duration":
      return boxRow(L.duration);
    case "ramp":
      return boxRow(L.ramp);
    case "basis":
      return basis;
    case "think":
      return boxRow(L.think);
    case "timeout":
      return boxRow(L.timeout);
    case "workers":
      return boxRow(L.workers);
    case "connect":
      return p.connect_timeout_seconds != null ? formatDurationKo(p.connect_timeout_seconds) : null;
    case "maxInFlight":
      return p.max_in_flight != null ? C.inFlight(p.max_in_flight) : null;
    case "data": {
      const b = seedBindingsFrom(p);
      return b.length > 0
        ? C.dataLine(b.length, b.map((x) => C.policyNames[x.policy]).join(C.policyJoin))
        : null;
    }
    case "stair":
      return p.stair
        ? C.stairLine(p.stair.targets.length, formatDurationKo(p.stair.hold_seconds))
        : null;
  }
}

function joinNames(names: string[]): { head: string; rest: number } {
  return { head: names.slice(0, 2).join(F.itemJoin), rest: Math.max(0, names.length - 2) };
}

type StepDiff = { kind: "steps" | "request" | "assert" | "extract"; text: string };

function sameSet(a: number[], b: number[]): boolean {
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function stepDiffs(before: StepFacts[], after: StepFacts[]): StepDiff[] {
  const out: StepDiff[] = [];
  const bIdx = new Map(before.map((s, i) => [s.id, i]));
  const aIdx = new Map(after.map((s, i) => [s.id, i]));
  const commonB = before.filter((s) => aIdx.has(s.id)).map((s) => s.id);
  const commonA = after.filter((s) => bIdx.has(s.id)).map((s) => s.id);
  if (commonB.some((id, i) => id !== commonA[i])) {
    out.push({ kind: "steps", text: F.stepReordered });
  }
  for (const s of before) {
    if (!aIdx.has(s.id)) {
      out.push({ kind: "steps", text: F.stepRemoved(stepNo(bIdx.get(s.id) ?? 0)) });
    }
  }
  after.forEach((s, i) => {
    const no = stepNo(i);
    const prev = bIdx.has(s.id) ? before[bIdx.get(s.id) ?? 0] : undefined;
    if (!prev) {
      out.push({ kind: "steps", text: F.stepAdded(no) });
      return;
    }
    if (prev.method !== s.method || prev.url !== s.url) {
      out.push({ kind: "request", text: F.stepRequest(no) });
    }
    if (prev.statusCodes.length === 0 && s.statusCodes.length > 0) {
      out.push({ kind: "assert", text: F.assertAdded(no) });
    } else if (prev.statusCodes.length > 0 && s.statusCodes.length === 0) {
      out.push({ kind: "assert", text: F.assertRemoved(no) });
    } else if (!sameSet(prev.statusCodes, s.statusCodes)) {
      out.push({ kind: "assert", text: F.assertChanged(no) });
    }
    if (!prev.fallibleExtract && s.fallibleExtract) {
      out.push({ kind: "extract", text: F.extractAdded(no) });
    } else if (prev.fallibleExtract && !s.fallibleExtract) {
      out.push({ kind: "extract", text: F.extractRemoved(no) });
    }
  });
  return out;
}

type ScenarioResult = { readable: false } | { readable: true; diffs: StepDiff[]; other: boolean };

function compareScenario(before: RunModel, after: RunModel): ScenarioResult {
  if (before.yamlObj === null || after.yamlObj === null) return { readable: false };
  const diffs =
    before.facts.ok && after.facts.ok ? stepDiffs(before.facts.steps, after.facts.steps) : [];
  const other =
    diffs.length === 0 &&
    !deepEqualLoose(stripScenarioNames(before.yamlObj), stripScenarioNames(after.yamlObj));
  return { readable: true, diffs, other };
}

function criteriaMap(m: RunModel): Map<string, number> {
  return new Map(
    expandCriteria(m.criteria).map((c) => [`${c.metric}|${c.target ?? ""}|${c.op}`, c.threshold]),
  );
}

function envDiffKeys(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.filter((k) => Object.hasOwn(a, k) !== Object.hasOwn(b, k) || a[k] !== b[k]);
}

function statusLine(m: RunModel, side: string): string | null {
  if (m.meta.status === "failed") return F.failed(side);
  if (m.meta.status !== "aborted") return null;
  const { started_at: s, ended_at: e } = m.meta;
  return F.aborted(side, s !== null && e !== null ? formatDurationKo((e - s) / 1000) : null);
}

export function buildFairness(before: RunModel, after: RunModel): Fairness {
  const pa = before.profile;
  const pb = after.profile;
  const profileReadable = pa !== null && pb !== null;

  const boxA = boxOf(before);
  const boxB = boxOf(after);
  const basisA = basisCondText(before);
  const basisB = basisCondText(after);
  const anyBasis = basisA !== null || basisB !== null;
  const basisTextA = anyBasis ? (basisA ?? C.basisWhole) : null;
  const basisTextB = anyBasis ? (basisB ?? C.basisWhole) : null;

  const load = ((): { card: FairCard; differs: Set<ItemKey>; other: boolean; size: string } => {
    if (!profileReadable) {
      return {
        card: { key: "load", title: F.titles.load, same: false, line: F.unreadable },
        differs: new Set(),
        other: false,
        size: F.sizeMixed,
      };
    }
    const size = sizeName(pa, pb);
    const va = itemValues(pa, before.workers, basisA);
    const vb = itemValues(pb, after.workers, basisB);
    const differs = new Set<ItemKey>();
    for (const k of ITEM_ORDER) if (!deepEqualLoose(va[k], vb[k])) differs.add(k);
    if (va.model !== vb.model) differs.add("size");
    const other = !deepEqualLoose(otherValues(pa), otherValues(pb));
    const names = ITEM_ORDER.filter((k) => differs.has(k)).map((k) => itemLabel(k, size));
    if (other) names.push(F.other);
    const same = names.length === 0;
    const { head, rest } = joinNames(names);
    const line = same
      ? [itemText(boxB, pb, "model", basisTextB), itemText(boxB, pb, "size", basisTextB)]
          .filter((s): s is string => s !== null)
          .join(F.itemJoin)
      : F.loadDiff(head, rest);
    return { card: { key: "load", title: F.titles.load, same, line }, differs, other, size };
  })();

  const envKeys = envDiffKeys(before.env, after.env);
  const envSame = envKeys.length === 0;
  const envCard: FairCard = {
    key: "env",
    title: F.titles.env,
    same: envSame,
    line: envSame
      ? F.envSame(Object.keys(after.env).length)
      : F.envDiff(
          envKeys.length,
          envKeys.slice(0, 2).join(F.keyJoin),
          Math.max(0, envKeys.length - 2),
        ),
  };

  const sc = compareScenario(before, after);
  const scenarioOf = (same: boolean, line: string): FairCard => ({
    key: "scenario",
    title: F.titles.scenario,
    same,
    line,
  });
  let scenarioCard: FairCard;
  if (!sc.readable) {
    scenarioCard = scenarioOf(false, F.scenarioUnreadable);
  } else if (sc.diffs.length > 0) {
    scenarioCard = scenarioOf(
      false,
      F.scenarioDiff(sc.diffs.length, sc.diffs[0]?.text ?? "", sc.diffs.length - 1),
    );
  } else if (sc.other) {
    scenarioCard = scenarioOf(false, F.scenarioOther);
  } else {
    scenarioCard = scenarioOf(true, F.scenarioSame(after.facts.ok ? after.facts.steps.length : 0));
  }

  const ca = criteriaMap(before);
  const cb = criteriaMap(after);
  let criteriaCard: FairCard;
  if (!profileReadable) {
    criteriaCard = { key: "criteria", title: F.titles.criteria, same: false, line: F.unreadable };
  } else if ((ca.size === 0) !== (cb.size === 0)) {
    criteriaCard = {
      key: "criteria",
      title: F.titles.criteria,
      same: false,
      line: F.criteriaOneSided,
    };
  } else {
    let n = 0;
    for (const k of new Set([...ca.keys(), ...cb.keys()])) if (ca.get(k) !== cb.get(k)) n += 1;
    criteriaCard = {
      key: "criteria",
      title: F.titles.criteria,
      same: n === 0,
      line: n === 0 ? F.criteriaSame(ca.size) : F.criteriaDiff(n),
    };
  }

  const cards = [load.card, envCard, scenarioCard, criteriaCard];
  const statusLines = [
    statusLine(before, ko.print.cmp.star.before),
    statusLine(after, ko.print.cmp.star.after),
  ].filter((s): s is string => s !== null);
  const diffNames = cards.filter((c) => !c.same).map((c) => c.title);
  if (statusLines.length > 0) diffNames.push(F.statusName);

  const condRows: CondRow[] = [];
  const addRow = (
    label: string,
    b: string | null,
    a: string | null,
    differs: boolean,
    optional: boolean,
  ) => {
    if (optional && b === null && a === null) return;
    const before = b ?? C.none;
    const after = a ?? C.none;
    const needsTag = differs && before === after && before !== C.differs;
    condRows.push({ label, before, after: needsTag ? after + C.differsTag : after, differs });
  };
  if (pa && pb) {
    const optional = new Set<ItemKey>([
      "ramp",
      "basis",
      "think",
      "connect",
      "maxInFlight",
      "workers",
      "data",
      "stair",
    ]);
    for (const k of ITEM_ORDER) {
      addRow(
        itemLabel(k, load.size),
        itemText(boxA, pa, k, basisTextA),
        itemText(boxB, pb, k, basisTextB),
        load.differs.has(k),
        optional.has(k),
      );
    }
    if (load.other) addRow(F.other, C.differs, C.differs, true, false);
  } else {
    addRow(
      ko.print.conditions.title,
      pa ? C.none : C.unreadable,
      pb ? C.none : C.unreadable,
      !(pa === null && pb === null),
      false,
    );
  }
  const envAfterCount = Object.keys(after.env).length;
  addRow(
    C.envCount,
    C.count(Object.keys(before.env).length),
    envSame ? C.count(envAfterCount) : C.envCountDiff(envAfterCount, envKeys.length),
    !envSame,
    false,
  );
  if (profileReadable) {
    addRow(C.criteriaCount, C.count(ca.size), C.count(cb.size), !criteriaCard.same, false);
  }
  if (sc.readable) {
    const kinds: Array<[StepDiff["kind"], string]> = [
      ["steps", C.scenarioKinds.steps],
      ["request", C.scenarioKinds.request],
      ["assert", C.scenarioKinds.assert],
      ["extract", C.scenarioKinds.extract],
    ];
    for (const [kind, label] of kinds) {
      const n = sc.diffs.filter((d) => d.kind === kind).length;
      if (n > 0) addRow(label, C.differs, C.differs, true, false);
    }
    if (sc.other) addRow(C.scenarioKinds.other, C.differs, C.differs, true, false);
  }

  const same = cards.filter((c) => c.same).map((c) => c.title);
  const diff = cards.filter((c) => !c.same).map((c) => c.title);
  return {
    cards,
    statusLines,
    anyDiff: diffNames.length > 0,
    diffNames,
    criteriaSame: criteriaCard.same,
    oneLine: F.oneLine(same, diff),
    condRows,
    sampleLine: sampleNotice([before.report, after.report]),
  };
}

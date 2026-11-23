// 준비 스텝 결과 절의 순수 모델(b2 spec §3.2–§3.3).

import { ko } from "../i18n/ko";
import { joinParts, plain, strong, type LinePart } from "../i18n/lineParts";
import type { ReportSetup } from "../api/schemas";
import { fmtCount } from "./format";
import { requestLine } from "./redact";
import type { StepFacts } from "./scenarioFacts";

const K = ko.print.setup;

export type SetupRow = {
  stepId: string;
  no: number;
  name: string;
  requestLine: string | null;
  count: number;
  errors: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  codes: { label: string; count: number }[];
};

export type SetupPrintModel = {
  open: boolean;
  ok: number;
  failed: number;
  interrupted: number;
  lead: LinePart[];
  rows: SetupRow[];
  kindsLine: string | null;
};

function leadParts(s: ReportSetup, open: boolean): LinePart[] {
  const v = open ? K.open : K.closed;
  const total = s.ok + s.failed + s.interrupted;
  const n = (x: number): string => `${fmtCount(x)}${v.unit}`;
  const head: LinePart[] = [plain(v.prefix)];
  if (s.failed === 0 && s.interrupted === 0) {
    head.push(strong(n(s.ok)), plain(`${v.ga}${K.doneAll}`));
  } else {
    head.push(plain(`${n(total)}${K.of}`), strong(n(s.ok)));
    if (s.failed > 0) {
      head.push(
        plain(`${v.ga}${K.doneThenFail}`),
        strong(`${n(s.failed)}${v.ga} ${K.failedWord}`, "bad"),
        plain(`${K.failedEnd}${v.failedSentence}`),
      );
    } else {
      head.push(plain(`${v.ga}${K.done}`));
    }
    if (s.interrupted > 0) head.push(plain(`${n(s.interrupted)}${v.eun}${K.interrupted}`));
  }
  head.push(plain(v.tail));
  return joinParts(head);
}

const codeOrder = (a: string, b: string): number => {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
};

function kindsLineOf(s: ReportSetup): string | null {
  const total = new Map<string, number>();
  for (const st of s.steps) {
    for (const [kind, n] of Object.entries(st.failure_kinds)) {
      if (n > 0) total.set(kind, (total.get(kind) ?? 0) + n);
    }
  }
  if (total.size === 0) return null;
  const labels = ko.report.errorKinds.labels;
  const parts = Array.from(total.keys())
    .sort()
    .map((kind) =>
      K.kindCount(Object.hasOwn(labels, kind) ? labels[kind] : kind, fmtCount(total.get(kind)!)),
    );
  return `${K.kindsLead}${parts.join(K.kindsSep)}`;
}

export function buildSetupModel(a: {
  setup: ReportSetup;
  facts: StepFacts[];
  open: boolean;
}): SetupPrintModel {
  const { setup, facts, open } = a;
  const byId = new Map(facts.map((f) => [f.id, f]));
  const rows: SetupRow[] = setup.steps.map((st, i) => {
    const f = byId.get(st.step_id);
    const measured = st.count > 0;
    return {
      stepId: st.step_id,
      no: i + 1,
      name: f && f.name !== "" ? f.name : st.step_id,
      requestLine: f ? requestLine(f.method, f.url) : null,
      count: st.count,
      errors: st.errors,
      p50Ms: measured ? st.p50_ms : null,
      p95Ms: measured ? st.p95_ms : null,
      maxMs: measured ? st.max_ms : null,
      codes: Object.entries(st.status_counts)
        .sort(([x], [y]) => codeOrder(x, y))
        .map(([code, count]) => ({
          label: code === "0" ? ko.print.table.none : code,
          count,
        })),
    };
  });
  return {
    open,
    ok: setup.ok,
    failed: setup.failed,
    interrupted: setup.interrupted,
    lead: leadParts(setup, open),
    rows,
    kindsLine: kindsLineOf(setup),
  };
}

import { useState } from "react";
import type { ReportSetup } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { MixedSampleBadge } from "./MixedSampleBadge";

type Props = {
  setup: ReportSetup;
  stepMeta: Map<string, { name: string }>;
  loadModel: "vu" | "open";
  /** open-loop이고 리포트에 유지 구간 기준(basis)이 있을 때만 true. */
  steadyNote: boolean;
  /** 응답 시간 표본을 나눈 run이면 이 구획의 값이 실패한 요청도 포함함을 표지로 알린다. */
  mixedSample?: boolean;
};

const fmt = (n: number) => n.toLocaleString("en-US");

/** 실패 종류 글자 → 한국어 이름. 표에 없는 글자(프로토타입 이름 포함)는 그대로. */
function kindLabel(k: string): string {
  const labels: Record<string, string> = ko.report.errorKinds.labels;
  return Object.hasOwn(labels, k) ? labels[k] : k;
}

export function SetupSection({ setup, stepMeta, loadModel, steadyNote, mixedSample }: Props) {
  const t = ko.report.setup;
  const open = loadModel === "open";
  const [expanded, setExpanded] = useState(setup.failed > 0);

  const kinds = new Map<string, number>();
  for (const s of setup.steps)
    for (const [k, n] of Object.entries(s.failure_kinds)) kinds.set(k, (kinds.get(k) ?? 0) + n);

  return (
    <section aria-label={t.title} className="mb-6">
      <div className="flex flex-wrap items-center gap-x-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="text-left text-sm font-semibold text-slate-700 hover:underline"
        >
          <span aria-hidden="true">{expanded ? "▾" : "▸"} </span>
          {t.headline(setup.steps.length, setup.ok, open)}
        </button>
        {mixedSample && <MixedSampleBadge />}
      </div>
      {setup.failed > 0 && (
        <p className="mt-1 text-sm text-amber-800">
          {open ? t.warnOpen(setup.failed) : t.warnVu(setup.failed)}
        </p>
      )}
      {expanded && (
        <div className="mt-2">
          {setup.interrupted > 0 && (
            <p className="mb-2 text-sm text-slate-600">{t.interrupted(setup.interrupted, open)}</p>
          )}
          <table aria-label={t.stepsLabel} className="min-w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-600">
              <tr>
                <th className="py-2 pr-4 font-medium">{ko.report.colStep}</th>
                <th className="py-2 pr-4 font-medium">{ko.report.colRequests}</th>
                <th className="py-2 pr-4 font-medium">{ko.report.colErrors}</th>
                <th className="py-2 pr-4 font-medium">p50 ms</th>
                <th className="py-2 pr-4 font-medium">p95 ms</th>
                <th className="py-2 pr-4 font-medium">{t.colMax}</th>
                <th className="py-2 font-medium">{t.colStatus}</th>
              </tr>
            </thead>
            <tbody>
              {setup.steps.map((s) => {
                const name = stepMeta.get(s.step_id)?.name ?? s.step_id;
                return (
                  <tr key={s.step_id} className="border-b border-slate-100">
                    <td className="max-w-[16rem] py-2 pr-4 font-medium">
                      <span className="block truncate" title={name}>
                        {name}
                      </span>
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{fmt(s.count)}</td>
                    <td className="py-2 pr-4 tabular-nums">{fmt(s.errors)}</td>
                    <td className="py-2 pr-4 tabular-nums">{s.p50_ms}</td>
                    <td className="py-2 pr-4 tabular-nums">{s.p95_ms}</td>
                    <td className="py-2 pr-4 tabular-nums">{s.max_ms}</td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs">
                        {Object.entries(s.status_counts).map(([code, n]) => (
                          <span key={code} className="whitespace-nowrap">{`${code}: ${n}`}</span>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {kinds.size > 0 && (
            <div className="mt-3">
              <h4 className="mb-1 text-sm font-semibold text-slate-700">{t.failureKinds}</h4>
              <ul className="list-disc space-y-0.5 pl-5 text-sm">
                {[...kinds].map(([k, n]) => (
                  <li key={k}>{`${kindLabel(k)}: ${n}`}</li>
                ))}
              </ul>
            </div>
          )}
          {steadyNote && <p className="mt-3 text-xs text-slate-500">{t.steadyNote}</p>}
        </div>
      )}
    </section>
  );
}

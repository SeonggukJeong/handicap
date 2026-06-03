import type { Insight } from "../../api/schemas";

type StepMeta = { id: string; name: string; method: string; url: string };
type Props = { insights: Insight[]; meta: Map<string, StepMeta> };

const SEV_CLASS: Record<string, string> = {
  critical: "border-red-300 bg-red-50 text-red-800",
  warning: "border-amber-300 bg-amber-50 text-amber-800",
  info: "border-slate-300 bg-slate-50 text-slate-700",
};

function pctStr(v: number | undefined): string {
  return v === undefined ? "" : `${(v * 100).toFixed(1)}%`;
}

function message(i: Insight, meta: Map<string, StepMeta>): string {
  const name = (id?: string) => (id ? (meta.get(id)?.name ?? id) : "");
  // Pin locale so comma grouping is deterministic regardless of CI ICU build
  // (RTL asserts "1,203건" / "1,240ms").
  const n = (v: number | undefined) => (v ?? 0).toLocaleString("en-US");
  switch (i.kind) {
    case "slo_failure":
      return `SLO 실패: ${i.count ?? 0}개 기준 미달`;
    case "slo_pass":
      return "모든 SLO 기준 통과";
    case "status_class":
      return `${i.status_class}가 응답의 ${pctStr(i.pct)} (${n(i.count)}건)`;
    case "status_temporal":
      return `5xx가 마지막 ${i.window_seconds ?? 0}초에 처음 등장`;
    case "no_request_step":
      return `스텝 ${name(i.step_id)}에 요청이 기록되지 않음`;
    case "error_hotspot":
      return `스텝 ${name(i.step_id)}이(가) 에러의 ${pctStr(i.pct)} (${n(i.count)}건)`;
    case "slowest_step":
      return `스텝 ${name(i.step_id)}이(가) p95 ${n(i.value)}ms로 가장 느림`;
    default:
      return i.kind;
  }
}

export function InsightPanel({ insights, meta }: Props) {
  if (insights.length === 0) return null;
  return (
    <section aria-label="Insights" className="mb-6">
      <h3 className="text-lg font-semibold mb-2">핵심 인사이트</h3>
      <ul className="space-y-1">
        {insights.map((i, idx) => (
          <li
            key={`${i.kind}-${i.step_id ?? i.status_class ?? idx}`}
            data-testid="insight"
            className={[
              "rounded border px-3 py-1.5 text-sm",
              SEV_CLASS[i.severity] ?? SEV_CLASS.info,
            ].join(" ")}
          >
            {message(i, meta)}
          </li>
        ))}
      </ul>
    </section>
  );
}

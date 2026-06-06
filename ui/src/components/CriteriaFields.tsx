import type { CriteriaState } from "./profileForm";

type Field = { key: keyof CriteriaState; label: string; max?: string; step?: string };

const FIELDS: Field[] = [
  { key: "maxP50", label: "Max p50 (ms)" },
  { key: "maxP95", label: "Max p95 (ms)" },
  { key: "maxP99", label: "Max p99 (ms)" },
  { key: "maxErrPct", label: "Max error rate (%)", max: "100", step: "any" },
  { key: "minRps", label: "Min RPS", step: "any" },
  { key: "max4xxPct", label: "Max 4xx rate (%)", max: "100", step: "any" },
  { key: "max5xxPct", label: "Max 5xx rate (%)", max: "100", step: "any" },
  { key: "max4xxCount", label: "Max 4xx count" },
  { key: "max5xxCount", label: "Max 5xx count" },
  { key: "minWindowRps", label: "Min window RPS", step: "any" },
  { key: "rpsWarmup", label: "RPS warmup (s)" },
];

type Props = {
  value: CriteriaState;
  onChange: (key: keyof CriteriaState, val: string) => void;
};

/** SLO 기준 입력 그리드(프레젠테이셔널). collapsible wrapper는 부모 소유. */
export function CriteriaFields({ value, onChange }: Props) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {FIELDS.map((f) => (
        <label key={f.key} className="block text-sm">
          <span className="text-slate-600">{f.label}</span>
          <input
            type="number"
            min="0"
            {...(f.max ? { max: f.max } : {})}
            {...(f.step ? { step: f.step } : {})}
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
            value={value[f.key]}
            onChange={(e) => onChange(f.key, e.target.value)}
          />
        </label>
      ))}
    </div>
  );
}

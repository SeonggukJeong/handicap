import type { StepCriterionDraft } from "./profileForm";

const METRICS: { value: string; label: string; unit: "ms" | "%" | "" }[] = [
  { value: "p50_ms", label: "p50(ms)", unit: "ms" },
  { value: "p95_ms", label: "p95(ms)", unit: "ms" },
  { value: "p99_ms", label: "p99(ms)", unit: "ms" },
  { value: "error_rate", label: "에러율(%)", unit: "%" },
  { value: "4xx_rate", label: "4xx 비율(%)", unit: "%" },
  { value: "5xx_rate", label: "5xx 비율(%)", unit: "%" },
  { value: "4xx_count", label: "4xx 수", unit: "" },
  { value: "5xx_count", label: "5xx 수", unit: "" },
];

export type StepOption = { id: string; label: string };

type Props = {
  value: StepCriterionDraft[];
  options: StepOption[];
  onChange: (rows: StepCriterionDraft[]) => void;
};

/** 스텝별 SLO 기준 행 편집기(프레젠테이셔널). collapsible wrapper는 부모 소유. */
export function StepCriteriaFields({ value, options, onChange }: Props) {
  const update = (i: number, patch: Partial<StepCriterionDraft>) =>
    onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i));
  const add = () =>
    onChange([
      ...value,
      { target: options[0]?.id ?? "", metric: "p95_ms", op: "max", threshold: "" },
    ]);

  return (
    <div className="mt-3">
      <div className="mb-1 text-sm font-medium text-slate-600">스텝별 기준 (선택)</div>
      {options.length === 0 ? (
        <p className="text-xs text-slate-500">
          http 스텝이 있는 시나리오에서만 추가할 수 있습니다.
        </p>
      ) : (
        <>
          {value.map((row, i) => {
            const unit = METRICS.find((m) => m.value === row.metric)?.unit ?? "";
            return (
              <div
                key={i}
                role="group"
                aria-label={`스텝 기준 ${i + 1}`}
                className="mb-2 flex items-center gap-2"
              >
                <select
                  aria-label={`스텝 ${i + 1}`}
                  className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
                  value={row.target}
                  onChange={(e) => update(i, { target: e.target.value })}
                >
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`지표 ${i + 1}`}
                  className="rounded border border-slate-300 px-2 py-1 text-sm"
                  value={row.metric}
                  onChange={(e) => update(i, { metric: e.target.value })}
                >
                  {METRICS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`연산자 ${i + 1}`}
                  className="rounded border border-slate-300 px-2 py-1 text-sm"
                  value={row.op}
                  onChange={(e) => update(i, { op: e.target.value as "max" | "min" })}
                >
                  <option value="max">≤</option>
                  <option value="min">≥</option>
                </select>
                <input
                  type="number"
                  min="0"
                  {...(unit === "%" ? { max: "100" } : {})}
                  step="any"
                  aria-label={`임계값 ${i + 1}`}
                  className="w-24 rounded border border-slate-300 px-2 py-1 text-sm"
                  value={row.threshold}
                  onChange={(e) => update(i, { threshold: e.target.value })}
                />
                {unit && <span className="text-xs text-slate-500">{unit}</span>}
                <button
                  type="button"
                  aria-label={`스텝 기준 ${i + 1} 삭제`}
                  className="shrink-0 text-slate-400 hover:text-red-600"
                  onClick={() => remove(i)}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button type="button" className="text-sm text-blue-600 hover:underline" onClick={add}>
            + 스텝 기준 추가
          </button>
        </>
      )}
    </div>
  );
}

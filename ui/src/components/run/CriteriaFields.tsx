import { useId } from "react";
import { ko } from "../../i18n/ko";
import {
  MAX_PERCENTILE_ROWS,
  NEW_PERCENTILE_ROW,
  type CriteriaErrors,
  type CriteriaState,
  type PercentileDraft,
  type StringCriteriaKey,
} from "./profileForm";

type Field = { key: StringCriteriaKey; label: string; max?: string; step?: string };

const FIELDS: Field[] = [
  { key: "maxMean", label: ko.criteria.meanLabel, max: "60000", step: "any" },
  { key: "maxMax", label: ko.criteria.maxLabel, max: "60000", step: "any" },
  { key: "maxP50", label: "최대 p50(ms)" },
  { key: "maxP95", label: "최대 p95(ms)" },
  { key: "maxP99", label: "최대 p99(ms)" },
  { key: "maxErrPct", label: "최대 에러율(%)", max: "100", step: "any" },
  { key: "minRps", label: "최소 RPS", step: "any" },
  { key: "max4xxPct", label: "최대 4xx 비율(%)", max: "100", step: "any" },
  { key: "max5xxPct", label: "최대 5xx 비율(%)", max: "100", step: "any" },
  { key: "max4xxCount", label: "최대 4xx 수" },
  { key: "max5xxCount", label: "최대 5xx 수" },
  { key: "minWindowRps", label: "최소 윈도 RPS", step: "any" },
  { key: "rpsWarmup", label: "RPS 워밍업(초)" },
];

type Props = {
  value: CriteriaState;
  errors: CriteriaErrors;
  onChange: (key: StringCriteriaKey, val: string) => void;
  onPercentilesChange: (rows: PercentileDraft[]) => void;
};

const NUM = "rounded border border-slate-300 px-2 py-1 text-sm";

/** SLO 기준 입력 그리드(프레젠테이셔널). collapsible wrapper는 부모 소유. */
export function CriteriaFields({ value, errors, onChange, onPercentilesChange }: Props) {
  const uid = useId();
  const fieldErr = (key: StringCriteriaKey): string | undefined =>
    key === "maxMean" ? errors.maxMean : key === "maxMax" ? errors.maxMax : undefined;
  const rows = value.percentiles;
  const updateRow = (i: number, patch: Partial<PercentileDraft>) =>
    onPercentilesChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const full = rows.length >= MAX_PERCENTILE_ROWS;
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        {FIELDS.map((f) => {
          const err = fieldErr(f.key);
          const errId = `${uid}-${f.key}`;
          return (
            <div key={f.key}>
              <label className="block text-sm">
                <span className="text-slate-600">{f.label}</span>
                <input
                  type="number"
                  min="0"
                  {...(f.max ? { max: f.max } : {})}
                  {...(f.step ? { step: f.step } : {})}
                  {...(err ? { "aria-invalid": true, "aria-describedby": errId } : {})}
                  className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                  value={value[f.key]}
                  onChange={(e) => onChange(f.key, e.target.value)}
                />
              </label>
              {err && (
                <p id={errId} className="mt-1 text-xs text-red-600">
                  {err}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-slate-500">{ko.criteria.meanHelp}</p>

      <div className="mt-3">
        <div className="mb-1 text-sm font-medium text-slate-600">
          {ko.criteria.percentilesTitle}
        </div>
        {rows.map((row, i) => {
          const e = errors.percentiles[i] ?? {};
          return (
            <div key={i} className="mb-2">
              <div className="flex items-center gap-2">
                <span className="text-sm">p</span>
                <input
                  type="number"
                  step="any"
                  aria-label={ko.criteria.percentileAria(i + 1)}
                  {...(e.p ? { "aria-invalid": true, "aria-describedby": `${uid}-pp${i}` } : {})}
                  className={`w-[72px] ${NUM}`}
                  value={row.p}
                  onChange={(ev) => updateRow(i, { p: ev.target.value })}
                />
                <span className="text-sm">≤</span>
                <input
                  type="number"
                  min="0"
                  max="60000"
                  step="any"
                  aria-label={ko.criteria.percentileMsAria(i + 1)}
                  {...(e.ms ? { "aria-invalid": true, "aria-describedby": `${uid}-pm${i}` } : {})}
                  className={`w-24 ${NUM}`}
                  value={row.ms}
                  onChange={(ev) => updateRow(i, { ms: ev.target.value })}
                />
                <span className="text-xs text-slate-500">ms</span>
                <button
                  type="button"
                  aria-label={ko.criteria.removePercentile(i + 1)}
                  className="shrink-0 text-slate-400 hover:text-red-600"
                  onClick={() => onPercentilesChange(rows.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
              {e.p && (
                <p id={`${uid}-pp${i}`} className="text-xs text-red-600">
                  {e.p}
                </p>
              )}
              {e.ms && (
                <p id={`${uid}-pm${i}`} className="text-xs text-red-600">
                  {e.ms}
                </p>
              )}
            </div>
          );
        })}
        {errors.percentilesList && (
          <p className="mb-1 text-xs text-red-600" id={`${uid}-pl`}>
            {errors.percentilesList}
          </p>
        )}
        <button
          type="button"
          disabled={full}
          aria-describedby={errors.percentilesList ? `${uid}-pl` : undefined}
          className="text-sm text-accent-600 hover:underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline"
          onClick={() => onPercentilesChange([...rows, NEW_PERCENTILE_ROW])}
        >
          {ko.criteria.addPercentile}
        </button>
        {full && <span className="ml-2 text-xs text-slate-500">{ko.criteria.maxRowsHint}</span>}
      </div>
    </>
  );
}

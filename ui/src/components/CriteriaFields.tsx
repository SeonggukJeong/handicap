import type { CriteriaState } from "./profileForm";

// stepCriteria(array)는 이 string-input 그리드 대상이 아니다 — Task 6의 별도 에디터가 렌더.
type StringCriteriaKey = Exclude<keyof CriteriaState, "stepCriteria">;
type Field = { key: StringCriteriaKey; label: string; max?: string; step?: string };

const FIELDS: Field[] = [
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

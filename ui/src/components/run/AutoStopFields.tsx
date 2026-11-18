import { useId } from "react";
import { ko } from "../../i18n/ko";
import { Input } from "../ui/Input";
import type { StairDraft } from "./stair";

type ErrKey = "emErrorPct" | "emP99Ms" | "emSeconds" | "emMinRequests";

type Props = {
  value: StairDraft;
  onChange: (next: StairDraft) => void;
  errors: Partial<Record<ErrKey, string>>;
};

/** 계단 자동 정지 상자. 기본 켜짐 보호 장치라 접지 않고 항상 보인다. */
export function AutoStopFields({ value, onChange, errors }: Props) {
  const id = useId();
  const set = (patch: Partial<StairDraft>) => onChange({ ...value, ...patch });
  const k = ko.loadModel;
  const num = (
    key: ErrKey,
    field: "emErrorPct" | "emP99Ms" | "emSeconds" | "emMinRequests",
    aria: string,
    widthClass: string,
    attrs: { min: number; max?: number; step?: string },
  ) => (
    // 폭은 래퍼 div에: Input 자체의 w-full이 직접 건 w-* 클래스를 이긴다.
    <div className={`${widthClass} shrink-0`}>
      <Input
        type="number"
        compact
        numeric
        {...attrs}
        aria-label={aria}
        value={value[field]}
        disabled={!value.emOn}
        onChange={(e) => set({ [field]: e.target.value } as Partial<StairDraft>)}
        aria-invalid={errors[key] !== undefined}
        aria-describedby={errors[key] ? `${id}-${key}-error` : undefined}
      />
    </div>
  );
  const errorKeys = (["emErrorPct", "emP99Ms", "emSeconds", "emMinRequests"] as const).filter(
    (key) => errors[key] !== undefined,
  );

  return (
    <fieldset className="mb-3 max-w-2xl rounded-md border border-slate-200 p-3">
      <legend className="px-1 text-sm font-medium text-slate-700">{k.stairAutoStopLegend}</legend>

      <label id={`${id}-sat-label`} className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={value.satOn}
          onChange={(e) => set({ satOn: e.target.checked })}
        />
        {k.stairAutoStopSat}
      </label>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-sat-label`}
        className="mb-3 ml-6 mt-1 space-y-1"
      >
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="radio"
            name={`${id}-sat`}
            checked={value.satMode === "two_fails"}
            disabled={!value.satOn}
            onChange={() => set({ satMode: "two_fails" })}
          />
          {k.stairAutoStopSatTwoFails}
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="radio"
            name={`${id}-sat`}
            checked={value.satMode === "first_fail"}
            disabled={!value.satOn}
            onChange={() => set({ satMode: "first_fail" })}
          />
          {k.stairAutoStopSatFirstFail}
        </label>
        {value.satOn && value.satMode === "first_fail" && (
          <p className="ml-6 text-xs text-amber-700">⚠ {k.stairAutoStopSatFirstFailWarn}</p>
        )}
      </div>

      <div role="group" aria-labelledby={`${id}-em-label`}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-700">
          <label id={`${id}-em-label`} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={value.emOn}
              onChange={(e) => set({ emOn: e.target.checked })}
            />
            {k.stairAutoStopEm}
          </label>
          <span aria-hidden="true">{k.stairAutoStopEmLead}</span>
          {num("emErrorPct", "emErrorPct", k.stairAutoStopEmErrorPctAria, "w-16", {
            min: 0,
            max: 100,
            step: "any",
          })}
          <span aria-hidden="true">{k.stairAutoStopEmPctUnit}</span>
          {num("emP99Ms", "emP99Ms", k.stairAutoStopEmP99Aria, "w-24", { min: 1, max: 600000 })}
          <span aria-hidden="true">{k.stairAutoStopEmMsUnit}</span>
          {num("emSeconds", "emSeconds", k.stairAutoStopEmSecondsAria, "w-16", { min: 1, max: 60 })}
          <span aria-hidden="true">{k.stairAutoStopEmSecondsUnit}</span>
        </div>
        <div className="ml-6 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-700">
          <span aria-hidden="true">{k.stairAutoStopEmMinLead}</span>
          {num("emMinRequests", "emMinRequests", k.stairAutoStopEmMinAria, "w-20", {
            min: 1,
            max: 100000,
          })}
          <span aria-hidden="true">{k.stairAutoStopEmMinTail}</span>
        </div>
        <p className="ml-6 mt-1 text-xs text-slate-500">
          <span aria-hidden="true">ⓘ </span>
          {k.stairAutoStopEmHelp}
        </p>
      </div>
      {errorKeys.map((key) => (
        <p key={key} id={`${id}-${key}-error`} className="ml-6 mt-1 text-sm text-red-600">
          {errors[key]}
        </p>
      ))}

      {(value.satOn || value.emOn) && (
        <p className="mt-3 text-xs text-amber-700">⚠ {k.stairAutoStopFinalWarn}</p>
      )}
    </fieldset>
  );
}

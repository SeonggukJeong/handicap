import type { KeyboardEvent } from "react";

type Option<T extends string> = { value: T; label: string; disabled?: boolean };

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className = "",
  busy,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<Option<T>>;
  ariaLabel: string;
  className?: string;
  busy?: boolean;
}) {
  const idx = options.findIndex((o) => o.value === value);
  const stopIdx = options[idx]?.disabled ? options.findIndex((o) => !o.disabled) : idx;
  function step(dir: 1 | -1) {
    const n = options.length;
    for (let k = 1; k < n; k++) {
      const next = options[(idx + dir * k + n * k) % n];
      if (!next.disabled) {
        onChange(next.value);
        return;
      }
    }
  }
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      step(-1);
    }
  }
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-busy={busy ? true : undefined}
      onKeyDown={onKeyDown}
      className={`inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5 ${className}`}
    >
      {options.map((o) => {
        const active = o.value === value;
        const tabStop = options.indexOf(o) === stopIdx;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={tabStop ? 0 : -1}
            disabled={o.disabled}
            aria-disabled={o.disabled ? true : undefined}
            onClick={() => onChange(o.value)}
            className={`rounded-md px-3.5 py-1 text-sm font-semibold transition-colors ${
              active
                ? "bg-accent-600 text-white shadow-sm"
                : o.disabled
                  ? "cursor-not-allowed text-slate-400"
                  : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

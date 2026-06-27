import type { ReactNode } from "react";

export function Section({
  index,
  title,
  badge,
  help,
  divider,
  collapsible,
  open,
  onToggle,
  hint,
  children,
}: {
  index?: number;
  title: ReactNode;
  badge?: ReactNode;
  help?: ReactNode;
  divider?: boolean;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  const numberBadge =
    index != null ? (
      <span
        className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-600 text-xs font-bold text-white"
        aria-hidden="true"
      >
        {index}
      </span>
    ) : null;

  const titleRow = (
    <span className="flex items-center gap-2">
      {numberBadge}
      <span className="text-sm font-semibold text-slate-800">{title}</span>
      {badge}
    </span>
  );

  return (
    <fieldset className={`mb-4 ${divider ? "border-t border-slate-200 pt-3" : ""}`}>
      <legend className="text-sm font-medium">
        {collapsible ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="flex items-center gap-2 text-slate-700 hover:underline"
          >
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
            {titleRow}
            {!open && hint != null ? (
              <span className="text-xs font-normal text-slate-500">{hint}</span>
            ) : null}
          </button>
        ) : (
          <span className="flex items-center gap-2">
            {titleRow}
            {help}
          </span>
        )}
      </legend>
      {(!collapsible || open) && <div className="mt-2">{children}</div>}
    </fieldset>
  );
}

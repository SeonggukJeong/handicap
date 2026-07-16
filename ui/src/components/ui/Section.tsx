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
  variant,
  "aria-label": ariaLabel,
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
  variant?: "card";
  "aria-label"?: string;
  children?: ReactNode;
}) {
  if (variant === "card") {
    // 에디터 카드 캐넌 — 구 Inspector InspectorSection과 1:1 (spec §4.2 리터럴 계약).
    // index/badge/help/divider는 카드 경로에서 무시(R2). 본문은 래퍼 없이 직접(fieldset flex gap이 간격 소유).
    return (
      <fieldset
        aria-label={ariaLabel}
        className="flex flex-col gap-2 min-w-0 border border-slate-200 rounded p-3"
      >
        <legend
          className={`px-1 text-xs font-semibold text-slate-600${
            collapsible ? " flex items-center gap-1" : ""
          }`}
        >
          {collapsible ? (
            <>
              <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                className="hover:underline"
              >
                <span aria-hidden="true">{open ? "▾" : "▸"}</span> {title}
              </button>
              {!open && hint != null && <span className="font-normal text-slate-400">{hint}</span>}
            </>
          ) : (
            title
          )}
        </legend>
        {(!collapsible || open) && children}
      </fieldset>
    );
  }

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
    <fieldset
      aria-label={ariaLabel}
      className={`mb-4 ${divider ? "border-t border-slate-200 pt-3" : ""}`}
    >
      <legend className="text-sm font-medium">
        {collapsible ? (
          // R4: hint는 버튼 밖 형제 — accname은 제목만(값 따라 변하는 hint가 이름을 오염하지 않게).
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              className="flex items-center gap-2 text-slate-700 hover:underline"
            >
              <span aria-hidden="true">{open ? "▾" : "▸"}</span>
              {titleRow}
            </button>
            {!open && hint != null ? (
              <span className="text-xs font-normal text-slate-500">{hint}</span>
            ) : null}
          </span>
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

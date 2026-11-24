import { useId, type ReactNode } from "react";

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
  hintAlways,
  hintTone,
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
  /** card 전용 — 열린 상태에서도 덧글을 보인다. */
  hintAlways?: boolean;
  /** card 전용 — 덧글 색. 주지 않으면 text-slate-400. */
  hintTone?: "muted" | "warn";
  "aria-label"?: string;
  children?: ReactNode;
}) {
  const hintId = useId();
  if (variant === "card") {
    const showHint = hintAlways ? hint != null : !open && hint != null;
    const hintColor =
      hintTone === "muted"
        ? "text-slate-500"
        : hintTone === "warn"
          ? "text-amber-800"
          : "text-slate-400";
    // 덧글이 legend 안에서 열린 채 보이면 묶음 이름에 섞이므로 이름은 따로 고정하고 덧글은 설명으로 잇는다.
    const groupLabel = ariaLabel ?? (hintAlways && typeof title === "string" ? title : undefined);
    // 에디터 카드 캐넌 — 구 Inspector InspectorSection과 1:1 (spec §4.2 리터럴 계약).
    // index/badge/help/divider는 카드 경로에서 무시(R2). 본문은 래퍼 없이 직접(fieldset flex gap이 간격 소유).
    return (
      <fieldset
        aria-label={hintAlways ? groupLabel : ariaLabel}
        aria-describedby={hintAlways && showHint ? hintId : undefined}
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
              {showHint && (
                <span id={hintAlways ? hintId : undefined} className={`font-normal ${hintColor}`}>
                  {hint}
                </span>
              )}
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
      className={`mb-4 min-w-0 ${divider ? "border-t border-slate-200 pt-3" : ""}`}
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

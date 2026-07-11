import type { ReactNode } from "react";

// 표시(결과·리포트) 화면 섹션 캐넌 — 폼 fieldset용 Section과 별개 프리미티브 (spec 2026-07-11 design-system-deep).
export function PageSection({
  ariaLabel,
  title,
  sub = false,
  className,
  children,
}: {
  ariaLabel: string;
  title: ReactNode;
  sub?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section aria-label={ariaLabel} className={className ?? "mb-6"}>
      {sub ? (
        <h4 className="text-sm font-semibold text-slate-700 mb-2">{title}</h4>
      ) : (
        <h3 className="text-lg font-semibold mb-2">{title}</h3>
      )}
      {children}
    </section>
  );
}

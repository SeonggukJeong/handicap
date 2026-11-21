import type { ReactNode } from "react";

// 표시(결과·리포트) 화면 섹션 캐넌 — 폼 fieldset용 Section과 별개 프리미티브 (spec 2026-07-11 design-system-deep).
export function PageSection({
  ariaLabel,
  title,
  sub = false,
  className,
  titleAside,
  children,
}: {
  ariaLabel: string;
  title: ReactNode;
  sub?: boolean;
  className?: string;
  /** 제목의 형제로 그린다(제목 접근명에 섞이지 않는다). */
  titleAside?: ReactNode;
  children?: ReactNode;
}) {
  const heading = sub ? (
    <h4 className={`text-sm font-semibold text-slate-700${titleAside ? "" : " mb-2"}`}>{title}</h4>
  ) : (
    <h3 className={`text-lg font-semibold${titleAside ? "" : " mb-2"}`}>{title}</h3>
  );
  return (
    <section aria-label={ariaLabel} className={className ?? "mb-6"}>
      {titleAside ? (
        <div className="mb-2 flex flex-wrap items-center gap-x-2">
          {heading}
          {titleAside}
        </div>
      ) : (
        heading
      )}
      {children}
    </section>
  );
}

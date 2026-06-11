import { Link } from "react-router-dom";
import { ko } from "../i18n/ko";

export type Crumb = { label: string; to?: string };

/** 상위 복귀 길찾기 (U2, spec §3.3). 마지막 항목 = 현재 페이지(aria-current="page", 링크 아님). */
export function Breadcrumb({ items }: { items: Crumb[] }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label={ko.breadcrumb.ariaLabel} className="mb-2 text-sm text-slate-500">
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${i}-${c.label}`} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden="true">›</span>}
              {!last && c.to ? (
                <Link to={c.to} className="hover:underline hover:text-slate-700">
                  {c.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  className={last ? "text-slate-700" : undefined}
                >
                  {c.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

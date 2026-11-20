import { Link } from "react-router-dom";
import { ko } from "../i18n/ko";

export type Crumb = { label: string; to?: string };

/**
 * 상위 복귀 길찾기 (U2, spec §3.3). 마지막 항목 = 현재 페이지(aria-current="page", 링크 아님).
 * 한 줄 고정 — 항목들이 남는 폭을 고르게 나눠 갖고(짧은 항목은 제 폭 그대로), 넘치는 항목은
 * 말줄임 + title.
 */
export function Breadcrumb({ items }: { items: Crumb[] }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label={ko.breadcrumb.ariaLabel} className="mb-2 text-sm text-slate-500">
      <ol className="grid grid-flow-col auto-cols-[minmax(0,max-content)] items-center justify-start gap-1">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${i}-${c.label}`} className="flex min-w-0 items-center gap-1">
              {i > 0 && <span aria-hidden="true">›</span>}
              {!last && c.to ? (
                <Link
                  to={c.to}
                  title={c.label}
                  className="truncate hover:underline hover:text-slate-700"
                >
                  {c.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  title={c.label}
                  className={last ? "truncate text-slate-700" : "truncate"}
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

import { Fragment, type ReactNode } from "react";

export function HeaderTable({
  title,
  rows,
  action,
  expanded,
}: {
  title: string;
  rows: [string, string][];
  action?: {
    label: string;
    ariaLabelFor: (rowKey: string) => string;
    onClick: (rowKey: string) => void;
  };
  /** Content shown in a full-width row right under the row with `rowKey` — e.g. the
   *  confirm box for that row's action, so it appears next to the button that opened it. */
  expanded?: { rowKey: string; content: ReactNode };
}) {
  if (rows.length === 0) return null;
  const cols = action ? 3 : 2;
  return (
    <div className="mb-2">
      <div className="text-xs font-medium text-slate-500">{title}</div>
      <table className="min-w-full text-xs">
        <tbody>
          {rows.map(([k, v]) => (
            <Fragment key={k}>
              <tr>
                <td className="py-0.5 pr-3 font-mono text-slate-600 align-top">{k}</td>
                <td className="py-0.5 font-mono break-all">{v}</td>
                {action && (
                  <td className="py-0.5 pl-2 align-top">
                    <button
                      type="button"
                      aria-label={action.ariaLabelFor(k)}
                      onClick={() => action.onClick(k)}
                      className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] hover:bg-slate-300"
                    >
                      {action.label}
                    </button>
                  </td>
                )}
              </tr>
              {expanded?.rowKey === k && (
                <tr>
                  <td colSpan={cols} className="pb-1">
                    {expanded.content}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

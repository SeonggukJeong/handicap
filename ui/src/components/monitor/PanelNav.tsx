import type { PanelConfig } from "../../api/monitors";
import { ko } from "../../i18n/ko";

/** 설정 화면 오른쪽 고정 칸 목록 — 항목 클릭 시 그 칸으로 점프(펼침·스크롤·포커스는 부모). */
export function PanelNav({
  panels,
  expanded,
  errors,
  onJump,
  onJumpActions,
}: {
  panels: PanelConfig[];
  expanded: Set<string>;
  errors: Record<string, string>;
  onJump: (id: string) => void;
  onJumpActions: () => void;
}) {
  return (
    <nav
      aria-label={ko.monitor.navTitle}
      className="rounded-md border border-slate-200 bg-white p-3"
    >
      <h3 className="mb-2 text-xs font-semibold text-slate-500">{ko.monitor.navTitle}</h3>
      <ul className="flex flex-col gap-1">
        {panels.map((p, i) => {
          const open = expanded.has(p.id);
          const err = errors[p.id] !== undefined;
          return (
            <li key={p.id}>
              <button
                type="button"
                aria-current={open ? "true" : undefined}
                onClick={() => onJump(p.id)}
                className={`flex w-full items-baseline gap-1 border-l-4 px-2 py-1 text-left text-sm ${
                  open
                    ? "border-accent-500 bg-accent-50 font-medium text-slate-900"
                    : "border-transparent text-slate-700 hover:bg-slate-50"
                }`}
              >
                <span className="shrink-0">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate">
                  {p.title.trim() || ko.monitor.noTitle}
                </span>
                {err && (
                  <>
                    <span className="shrink-0 text-red-700" aria-hidden="true">
                      ⚠
                    </span>
                    <span className="sr-only"> {ko.monitor.navPanelError}</span>
                  </>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={onJumpActions}
        className="mt-3 w-full rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-700 hover:bg-slate-50"
      >
        {ko.monitor.navJumpActions}
      </button>
    </nav>
  );
}

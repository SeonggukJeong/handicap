import type { CheckGroup, PanelConfig } from "../../api/monitors";
import { ko } from "../../i18n/ko";
import { navSegments } from "../../monitor/groups";

/** 설정 화면 오른쪽 고정 칸 목록 — 항목 클릭 시 그 칸으로 점프(펼침·스크롤·포커스는 부모).
 *  점검 묶음 칸들은 연한 상자(머리 `시나리오 이름 · N초`)로 감싸고, 번호는 화면 자리대로 이어 붙인다. */
export function PanelNav({
  panels,
  groups = [],
  scenarioNames = {},
  expanded,
  errors,
  onJump,
  onJumpActions,
}: {
  panels: PanelConfig[];
  groups?: CheckGroup[];
  scenarioNames?: Record<string, string>;
  expanded: Set<string>;
  errors: Record<string, string>;
  onJump: (id: string) => void;
  onJumpActions: () => void;
}) {
  const item = (i: number) => {
    const p = panels[i];
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
          <span className="min-w-0 flex-1 truncate">{p.title.trim() || ko.monitor.noTitle}</span>
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
  };

  return (
    <nav
      aria-label={ko.monitor.navTitle}
      className="rounded-md border border-slate-200 bg-white p-3"
    >
      <h3 className="mb-2 text-xs font-semibold text-slate-500">{ko.monitor.navTitle}</h3>
      <ul className="flex flex-col gap-1">
        {navSegments(panels).map((seg) => {
          const g = seg.groupId === null ? undefined : groups.find((x) => x.id === seg.groupId);
          if (!g) return seg.indices.map(item);
          const head = `${scenarioNames[g.scenario_id] ?? ko.monitor.noScenario} · ${ko.monitor.summaryInterval(g.interval_seconds)}`;
          return (
            <li key={`${g.id}-${seg.indices[0]}`}>
              <div
                role="group"
                aria-label={head}
                className="rounded-md border border-accent-200 bg-accent-50/50 px-1 pb-0.5 pt-1"
              >
                <div className="truncate px-1 pb-1 text-xs font-semibold text-accent-500">
                  {head}
                </div>
                <ul className="flex flex-col gap-1">{seg.indices.map(item)}</ul>
              </div>
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

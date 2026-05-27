import type { Tab } from "../../scenario/store";

interface TabBarProps {
  active: Tab;
  onChange: (tab: Tab) => void;
}

export function TabBar({ active, onChange }: TabBarProps) {
  return (
    <div role="tablist" className="flex border-b border-slate-200">
      <TabButton label="Canvas" tab="canvas" active={active} onChange={onChange} />
      <TabButton label="YAML" tab="yaml" active={active} onChange={onChange} />
    </div>
  );
}

interface TabButtonProps {
  label: string;
  tab: Tab;
  active: Tab;
  onChange: (tab: Tab) => void;
}

function TabButton({ label, tab, active, onChange }: TabButtonProps) {
  const isActive = active === tab;
  return (
    <button
      role="tab"
      aria-selected={isActive}
      type="button"
      onClick={() => onChange(tab)}
      className={
        "px-4 py-2 text-sm font-medium border-b-2 -mb-px " +
        (isActive
          ? "border-slate-900 text-slate-900"
          : "border-transparent text-slate-500 hover:text-slate-800")
      }
    >
      {label}
    </button>
  );
}

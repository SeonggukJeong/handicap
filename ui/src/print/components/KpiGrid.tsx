import type { KpiCard } from "../verdict";

export function KpiGrid({ kpis }: { kpis: KpiCard[] }) {
  return (
    <div className="p-kpis">
      {kpis.map((k) => (
        <div key={k.key} className={k.bad ? "p-kpi p-kpi--bad" : "p-kpi"}>
          <div className="p-kpi-label">{k.label}</div>
          <div className="p-kpi-value">
            {k.value}
            {k.unit && <small>{` ${k.unit}`}</small>}
          </div>
          <div className="p-kpi-explain">{k.explain}</div>
          <div className={k.bad ? "p-kpi-target p-bad" : "p-kpi-target"}>{k.target}</div>
        </div>
      ))}
    </div>
  );
}

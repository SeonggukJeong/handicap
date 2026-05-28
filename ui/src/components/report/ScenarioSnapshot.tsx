import { useState } from "react";

type Props = { yaml: string };

export function ScenarioSnapshot({ yaml }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Scenario snapshot" className="mb-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-sm font-semibold text-slate-700 hover:underline"
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} Scenario YAML (run-time snapshot)
      </button>
      {open && (
        <pre className="mt-2 p-3 bg-slate-50 border border-slate-200 rounded text-xs font-mono whitespace-pre overflow-x-auto">
          {yaml}
        </pre>
      )}
    </section>
  );
}

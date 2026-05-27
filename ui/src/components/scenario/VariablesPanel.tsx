import { useState } from "react";
import { useScenarioEditor } from "../../scenario/store";

export function VariablesPanel() {
  const variables = useScenarioEditor((s) => s.model?.variables ?? {});
  const setVariable = useScenarioEditor((s) => s.setVariable);
  const removeVariable = useScenarioEditor((s) => s.removeVariable);

  const [newKey, setNewKey] = useState("");
  const entries = Object.entries(variables);

  return (
    <section aria-label="Variables" className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-slate-700">Variables</h3>
      <ul className="flex flex-col gap-2">
        {entries.map(([key, value]) => (
          <li key={key} className="flex items-center gap-2">
            <span className="font-mono text-xs text-slate-600 w-24 truncate" title={key}>
              {key}
            </span>
            <input
              className="flex-1 border border-slate-300 rounded px-2 py-1 text-sm"
              value={value}
              onChange={(e) => setVariable(key, e.target.value)}
            />
            <button
              type="button"
              onClick={() => removeVariable(key)}
              aria-label={`Remove variable ${key}`}
              className="text-slate-500 hover:text-red-600 text-sm"
            >
              ×
            </button>
          </li>
        ))}
        {entries.length === 0 && (
          <li className="text-xs text-slate-400 italic">No variables</li>
        )}
      </ul>

      <div className="flex gap-2">
        <input
          className="flex-1 border border-slate-300 rounded px-2 py-1 text-sm font-mono"
          placeholder="new_var"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <button
          type="button"
          onClick={() => {
            const k = newKey.trim();
            if (!k) return;
            setVariable(k, "");
            setNewKey("");
          }}
          disabled={newKey.trim().length === 0}
          className="px-2 py-1 text-sm border border-slate-300 rounded disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </section>
  );
}

import { useState } from "react";
import { useEnvironments } from "../api/hooks";
import type { EnvEntry } from "../api/envOverlay";
import { ko } from "../i18n/ko";

type Props = {
  /** Currently selected environment id, or null for "(없음)". Owned by the parent. */
  selectedEnvId: string | null;
  onSelect: (id: string | null) => void;
  /** The selected env's vars (base layer), fetched by the parent via useEnvironment.
   *  `{}` when no env is selected or while the fetch is in flight. */
  baseVars: Record<string, string>;
  /** Editable per-run override rows. Owned by the parent (so it can resolveEnv at submit). */
  overrides: EnvEntry[];
  onOverridesChange: (next: EnvEntry[]) => void;
};

export function EnvironmentPicker({
  selectedEnvId,
  onSelect,
  baseVars,
  overrides,
  onOverridesChange,
}: Props) {
  const environments = useEnvironments();
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const selectedName = environments.data?.find((e) => e.id === selectedEnvId)?.name;
  const overrideKeys = new Set(overrides.map((o) => o.key.trim()).filter(Boolean));

  function seedOverride(key: string, value: string) {
    // Belt-and-suspenders: the "override" button is already hidden once a base key
    // is overridden (see the base-list render below), so this guard is effectively
    // unreachable from the UI — it just makes seedOverride idempotent if called
    // programmatically. The add-row can still append a duplicate key freely; that's
    // fine — resolveEnv is last-wins.
    if (overrideKeys.has(key)) return;
    onOverridesChange([...overrides, { key, value }]);
  }

  return (
    <section aria-label={ko.runDialog.envVarsRegion} className="mb-3">
      <div className="flex items-center gap-2 mb-2">
        <label className="text-sm text-slate-600" htmlFor="env-select">
          환경
        </label>
        <select
          id="env-select"
          aria-label={ko.runDialog.envSelectAria}
          className="border border-slate-300 rounded px-2 py-1 text-sm"
          value={selectedEnvId ?? ""}
          onChange={(e) => onSelect(e.target.value || null)}
        >
          <option value="">(없음)</option>
          {environments.data?.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </div>

      {selectedEnvId && (
        <div className="mb-2">
          <p className="text-xs text-slate-500 mb-1">
            {ko.runDialog.envBaseFrom(selectedName ?? "환경")}
          </p>
          <ul className="flex flex-col gap-1">
            {Object.entries(baseVars).map(([k, v]) => {
              const overridden = overrideKeys.has(k);
              return (
                <li key={k} className="flex items-center gap-2 text-sm">
                  <span
                    className={`w-40 font-mono ${overridden ? "line-through text-slate-400" : ""}`}
                  >
                    {k}
                  </span>
                  <span className="text-slate-400">=</span>
                  <span
                    className={`flex-1 min-w-0 truncate ${overridden ? "line-through text-slate-400" : "text-slate-600"}`}
                  >
                    {v}
                  </span>
                  {overridden ? (
                    <span className="text-xs text-amber-700 shrink-0">재정의됨</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => seedOverride(k, v)}
                      className="text-xs text-slate-600 hover:text-slate-900 shrink-0 border border-slate-300 rounded px-1"
                    >
                      {ko.runDialog.envOverrideBtn}
                    </button>
                  )}
                </li>
              );
            })}
            {Object.keys(baseVars).length === 0 && (
              <li className="text-xs text-slate-400 italic">{ko.runDialog.envBaseNoVars}</li>
            )}
          </ul>
        </div>
      )}

      <h4 className="text-sm font-semibold text-slate-700 mb-2">
        {selectedEnvId ? ko.runDialog.envHeadingOverride : ko.runDialog.envHeading}
      </h4>
      <ul className="flex flex-col gap-2">
        {overrides.map((entry, idx) => {
          const shadowsBase = selectedEnvId != null && entry.key.trim() in baseVars;
          return (
            <li key={idx} className="flex items-center gap-2">
              <input
                aria-label={ko.runDialog.envKeyAria(idx)}
                className="w-40 min-w-0 border border-slate-300 rounded px-2 py-1 text-sm font-mono"
                value={entry.key}
                onChange={(e) =>
                  onOverridesChange(
                    overrides.map((p, i) => (i === idx ? { ...p, key: e.target.value } : p)),
                  )
                }
              />
              <span className="text-slate-400 text-sm">=</span>
              <input
                aria-label={ko.runDialog.envValueAria(idx)}
                className="flex-1 min-w-0 border border-slate-300 rounded px-2 py-1 text-sm"
                value={entry.value}
                onChange={(e) =>
                  onOverridesChange(
                    overrides.map((p, i) => (i === idx ? { ...p, value: e.target.value } : p)),
                  )
                }
              />
              {shadowsBase && (
                <span className="text-xs text-amber-700 shrink-0">{entry.key.trim()} 재정의</span>
              )}
              <button
                type="button"
                onClick={() => onOverridesChange(overrides.filter((_, i) => i !== idx))}
                aria-label={ko.runDialog.envRemoveAria(String(entry.key || idx))}
                className="text-slate-500 hover:text-red-600 text-sm shrink-0"
              >
                ×
              </button>
            </li>
          );
        })}
        {overrides.length === 0 && (
          <li className="text-xs text-slate-400 italic">{ko.runDialog.envNoVars}</li>
        )}
      </ul>

      <div className="flex items-center gap-2 mt-2">
        <input
          aria-label={ko.runDialog.envNewKeyAria}
          className="w-40 min-w-0 border border-slate-300 rounded px-2 py-1 text-sm font-mono"
          placeholder="BASE_URL"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <span className="text-slate-400 text-sm">=</span>
        <input
          aria-label={ko.runDialog.envNewValueAria}
          className="flex-1 min-w-0 border border-slate-300 rounded px-2 py-1 text-sm"
          placeholder="http://localhost:9090"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
        />
        <button
          type="button"
          onClick={() => {
            const k = newKey.trim();
            if (!k) return;
            onOverridesChange([...overrides, { key: k, value: newValue }]);
            setNewKey("");
            setNewValue("");
          }}
          disabled={newKey.trim().length === 0}
          className="px-2 py-1 text-sm border border-slate-300 rounded disabled:opacity-50 shrink-0"
        >
          {ko.common.add}
        </button>
      </div>
    </section>
  );
}

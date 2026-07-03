import { useMemo, useState } from "react";
import { useScenarioEditor } from "../../scenario/store";
import { ko } from "../../i18n/ko";
import { VarCheatSheet } from "./VarCheatSheet";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { Input } from "../ui/Input";
import { countFlowVarUsage } from "../../scenario/scanVars";

// 셀렉터 fallback은 안정 참조여야 한다 — 인라인 `?? {}`는 매 스냅샷 새 객체라
// model=null 동안 useSyncExternalStore 무한 리렌더(getSnapshot 캐싱 경고)
const EMPTY_VARS: Record<string, string> = {};

export function VariablesPanel() {
  const model = useScenarioEditor((s) => s.model);
  const variables = useScenarioEditor((s) => s.model?.variables ?? EMPTY_VARS);
  const setVariable = useScenarioEditor((s) => s.setVariable);
  const removeVariable = useScenarioEditor((s) => s.removeVariable);

  const [newKey, setNewKey] = useState("");
  const entries = Object.entries(variables);
  // 사용 힌트(R4): 모델 변경마다 1회 도출(셀렉터 안 인라인 스캔 금지 — getSnapshot 함정).
  const usage = useMemo(
    () => (model ? countFlowVarUsage(model) : new Map<string, number>()),
    [model],
  );

  return (
    <section aria-label={ko.editor.variablesTitle} className="flex flex-col gap-3">
      <div className="flex items-center">
        <h3 className="text-sm font-semibold text-slate-700">{ko.editor.variablesTitle}</h3>
        <VarCheatSheet />
      </div>
      <ul className="flex flex-col gap-3">
        {entries.map(([key, value]) => {
          const n = usage.get(key) ?? 0;
          return (
            <li key={key} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span
                  className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600"
                  title={key}
                >
                  {key}
                </span>
                <button
                  type="button"
                  onClick={() => removeVariable(key)}
                  aria-label={ko.editor.removeVariableAria(key)}
                  className="shrink-0 text-slate-500 hover:text-red-600 text-sm"
                >
                  ×
                </button>
              </div>
              <AutoGrowTextarea
                aria-label={ko.editor.variableValueAria(key)}
                className="border border-slate-300 rounded px-2 py-1 text-sm font-mono"
                value={value}
                onChange={(e) => setVariable(key, e.target.value)}
              />
              <span className="text-xs text-slate-400">
                {n === 0 ? ko.editor.variableUnused : ko.editor.variableUsage(n)}
              </span>
            </li>
          );
        })}
        {entries.length === 0 && (
          <li className="text-xs text-slate-400 italic">{ko.editor.variablesEmpty}</li>
        )}
      </ul>

      <div className="flex gap-2">
        <div className="flex-1 min-w-0">
          <Input
            className="min-w-0 font-mono"
            placeholder="new_var"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
        </div>
        <button
          type="button"
          onClick={() => {
            const k = newKey.trim();
            if (!k) return;
            setVariable(k, "");
            setNewKey("");
          }}
          disabled={newKey.trim().length === 0}
          className="shrink-0 px-2 py-1 text-sm border border-slate-300 rounded disabled:opacity-50"
        >
          {ko.editor.variablesAdd}
        </button>
      </div>
    </section>
  );
}

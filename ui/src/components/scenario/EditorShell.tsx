import { useEffect, useRef } from "react";
import { useScenarioEditor } from "../../scenario/store";
import { CanvasView } from "./CanvasView";
import { Inspector } from "./Inspector";
import { MonacoYamlView } from "./MonacoYamlView";
import { TabBar } from "./TabBar";
import { VariablesPanel } from "./VariablesPanel";

interface EditorShellProps {
  initialYaml: string;
  onChange?: (yaml: string) => void;
}

export function EditorShell({ initialYaml, onChange }: EditorShellProps) {
  const loadFromString = useScenarioEditor((s) => s.loadFromString);
  const activeTab = useScenarioEditor((s) => s.activeTab);
  const setActiveTab = useScenarioEditor((s) => s.setActiveTab);
  const yamlText = useScenarioEditor((s) => s.yamlText);

  const initialRef = useRef(initialYaml);
  useEffect(() => {
    loadFromString(initialRef.current);
  }, [loadFromString]);

  useEffect(() => {
    onChange?.(yamlText);
  }, [yamlText, onChange]);

  return (
    <div className="grid grid-cols-[240px_1fr_320px] gap-4 min-h-[520px]">
      <div className="border border-slate-200 rounded-md p-3 bg-white">
        <VariablesPanel />
      </div>

      <div className="flex flex-col">
        <TabBar active={activeTab} onChange={setActiveTab} />
        <div className="flex-1 mt-3">
          {activeTab === "canvas" ? <CanvasView /> : <MonacoYamlView />}
        </div>
      </div>

      <div className="border border-slate-200 rounded-md p-3 bg-white">
        {activeTab === "canvas" ? (
          <Inspector />
        ) : (
          <div className="text-xs text-slate-400 italic">
            Switch to the Canvas tab to inspect a step.
          </div>
        )}
      </div>
    </div>
  );
}

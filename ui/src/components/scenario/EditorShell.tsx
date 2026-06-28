import { useEffect, useRef, useState } from "react";
import { useScenarioEditor } from "../../scenario/store";
import { ko } from "../../i18n/ko";
import { FlowOutline } from "./FlowOutline";
import { Inspector } from "./Inspector";
import { MonacoYamlView } from "./MonacoYamlView";
import { Modal } from "../Modal";
import { ValidationBanner } from "./ValidationBanner";
import { VariablesPanel } from "./VariablesPanel";

export function EditorShell({
  initialYaml,
  onChange,
}: {
  initialYaml: string;
  onChange?: (yaml: string) => void;
}) {
  const loadFromString = useScenarioEditor((s) => s.loadFromString);
  const yamlText = useScenarioEditor((s) => s.yamlText);
  const commitPendingYaml = useScenarioEditor((s) => s.commitPendingYaml);

  const [yamlOpen, setYamlOpen] = useState(false);
  const [varsOpen, setVarsOpen] = useState(true);

  const initialRef = useRef(initialYaml);
  useEffect(() => {
    loadFromString(initialRef.current);
  }, [loadFromString]);
  useEffect(() => {
    onChange?.(yamlText);
  }, [yamlText, onChange]);

  const closeYaml = () => {
    commitPendingYaml(); // 디바운스 윈도 중 닫기 시 마지막 편집 flush (R8)
    setYamlOpen(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <ValidationBanner onOpenYaml={() => setYamlOpen(true)} />
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={ko.editor.varsToggleAria}
          onClick={() => setVarsOpen((v) => !v)}
          className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100"
        >
          ☰ {ko.editor.varsToggle}
        </button>
        <button
          type="button"
          aria-label={ko.editor.openYaml}
          onClick={() => setYamlOpen(true)}
          className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100"
        >
          <span aria-hidden="true">{"</>"}</span> {ko.editor.openYaml}
        </button>
      </div>
      <div
        data-testid="editor-grid"
        className={`grid gap-4 min-h-[680px] ${varsOpen ? "grid-cols-[210px_minmax(260px,300px)_1fr]" : "grid-cols-[minmax(260px,300px)_1fr]"}`}
      >
        {varsOpen && (
          <aside
            role="complementary"
            aria-label={ko.editor.varsPanelAria}
            className="rounded-md border border-slate-200 bg-white p-3"
          >
            <VariablesPanel />
          </aside>
        )}
        <div className="rounded-md border border-slate-200 bg-white p-3 overflow-auto">
          <FlowOutline />
        </div>
        <div className="rounded-md border border-slate-200 bg-white p-3">
          <Inspector />
        </div>
      </div>
      <Modal open={yamlOpen} onClose={closeYaml} title={ko.editor.yamlModalTitle}>
        <MonacoYamlView />
      </Modal>
    </div>
  );
}

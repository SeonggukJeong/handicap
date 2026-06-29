import { useRef, useState, type ChangeEvent } from "react";
import { useScenarioEditor } from "../../scenario/store";
import { parseScenarioDoc } from "../../scenario/yamlDoc";
import { downloadYaml } from "../../api/downloadJson";
import { sanitizeFilename } from "../../api/sanitizeFilename";
import { readTextFile } from "../../api/readTextFile";
import { ko } from "../../i18n/ko";

const BTN = "rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100";

export function YamlFileActions() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const onExport = async () => {
    const s = useScenarioEditor.getState();
    const text = s.pendingYamlText ?? s.yamlText;
    // Derive the filename from the exact bytes being saved (not s.model, which
    // can lag the buffer during the debounce window or when invalid).
    const parsed = parseScenarioDoc(text);
    const name = "model" in parsed ? parsed.model.name : undefined;
    const filename = `${sanitizeFilename(name) || "scenario"}.yaml`;
    await downloadYaml(filename, text);
  };

  const onImportClick = () => {
    setReadError(null);
    fileInputRef.current?.click();
  };

  const onFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file (re-fires change)
    if (!file) return;
    let content: string;
    try {
      content = await readTextFile(file);
    } catch (err) {
      setReadError((err as Error).message);
      return;
    }
    const s = useScenarioEditor.getState();
    const hasContent = (s.model?.steps?.length ?? 0) > 0 || s.yamlError !== null;
    if (hasContent && !window.confirm(ko.editor.importReplaceConfirm)) return;
    s.loadFromString(content);
  };

  return (
    <div className="mb-2 flex items-center gap-2">
      <button
        type="button"
        className={BTN}
        aria-label={ko.editor.importYamlAria}
        onClick={onImportClick}
      >
        {ko.editor.importYaml}
      </button>
      <button
        type="button"
        className={BTN}
        aria-label={ko.editor.exportYamlAria}
        onClick={() => void onExport()}
      >
        {ko.editor.exportYaml}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".yaml,.yml"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => void onFileChange(e)}
      />
      {readError !== null && (
        <p role="alert" className="text-xs text-red-600">
          {ko.editor.importReadError(readError)}
        </p>
      )}
    </div>
  );
}

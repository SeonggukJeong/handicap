import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import Editor, { loader } from "@monaco-editor/react";
import { useScenarioEditor } from "../../scenario/store";

// Register Monaco workers as same-origin module workers. This must happen
// BEFORE any editor mounts, so we do it at module scope. Air-gapped runtime
// constraint: workers must be bundled (not CDN-loaded).
//
// Some Chrome versions wrap module workers as blob: URLs — that is why
// index.html's CSP includes `worker-src 'self' blob:`.
if (typeof self !== "undefined") {
  (
    self as unknown as { MonacoEnvironment: monaco.Environment }
  ).MonacoEnvironment = {
    getWorker(_workerId: string, _label: string): Worker {
      return new editorWorker() as Worker;
    },
  };
}

// Force @monaco-editor/react to use our bundled monaco. Without this it
// fetches monaco from JSDelivr at runtime, which breaks air-gapped staging
// and violates our default-src 'self' CSP.
loader.config({ monaco });

const DEBOUNCE_MS = 300;

// Module-level timer ref so the test export shares state with itself between calls.
// This helper is exported ONLY for tests — it mirrors the component's onChange
// debounce logic without requiring a mounted component (Monaco is expensive).
// The component's timerRef (useRef) is the production-path source of truth.
let _testTimerHandle: ReturnType<typeof setTimeout> | null = null;
// eslint-disable-next-line react-refresh/only-export-components
export function __test_handleChangeForTests(next: string): void {
  const state = useScenarioEditor.getState();
  state.setPendingYamlText(next);
  if (_testTimerHandle !== null) clearTimeout(_testTimerHandle);
  _testTimerHandle = setTimeout(() => {
    useScenarioEditor.getState().commitPendingYaml();
    _testTimerHandle = null;
  }, DEBOUNCE_MS);
}

export function MonacoYamlView() {
  const yamlText = useScenarioEditor((s) => s.yamlText);
  const pendingYamlText = useScenarioEditor((s) => s.pendingYamlText);
  const yamlError = useScenarioEditor((s) => s.yamlError);
  const setPendingYamlText = useScenarioEditor((s) => s.setPendingYamlText);
  const commitPendingYaml = useScenarioEditor((s) => s.commitPendingYaml);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const visibleText = pendingYamlText ?? yamlText;

  const onChange = (next: string | undefined) => {
    if (next === undefined) return;
    setPendingYamlText(next);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      commitPendingYaml();
      timerRef.current = null;
    }, DEBOUNCE_MS);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-[400px] border border-slate-200 rounded-md overflow-hidden">
        <Editor
          height="100%"
          defaultLanguage="yaml"
          value={visibleText}
          onChange={onChange}
          options={{
            minimap: { enabled: false },
            wordWrap: "on",
            fontSize: 13,
            tabSize: 2,
            scrollBeyondLastLine: false,
            renderWhitespace: "selection",
          }}
        />
      </div>
      {yamlError !== null && (
        <p className="mt-2 text-xs text-red-600 font-mono">
          YAML invalid: {yamlError}
        </p>
      )}
    </div>
  );
}

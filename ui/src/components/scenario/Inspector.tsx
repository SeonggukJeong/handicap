import { useEffect, useMemo, useState } from "react";
import { useScenarioEditor } from "../../scenario/store";
import type { Assertion, Extract, HttpMethod, Step } from "../../scenario/model";

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const BODY_KINDS = ["none", "json", "form", "raw"] as const;
type BodyKind = (typeof BODY_KINDS)[number];

export function Inspector() {
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const steps = useScenarioEditor((s) => s.model?.steps ?? []);
  const select = useScenarioEditor((s) => s.select);

  const step = useMemo(
    () => steps.find((s) => s.id === selectedStepId) ?? null,
    [steps, selectedStepId],
  );

  useEffect(() => {
    if (selectedStepId !== null && step === null) select(null);
  }, [selectedStepId, step, select]);

  if (step === null) {
    return (
      <aside aria-label="Inspector" className="text-sm text-slate-400 italic">
        Select a step in the canvas to edit its details.
      </aside>
    );
  }

  return <StepInspector step={step} />;
}

interface StepInspectorProps {
  step: Step;
}

function StepInspector({ step }: StepInspectorProps) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const setStepAssert = useScenarioEditor((s) => s.setStepAssert);
  const removeStep = useScenarioEditor((s) => s.removeStep);
  const moveStep = useScenarioEditor((s) => s.moveStep);
  const steps = useScenarioEditor((s) => s.model?.steps ?? []);

  const index = steps.findIndex((s) => s.id === step.id);

  return (
    <aside aria-label="Inspector" className="flex flex-col gap-4 text-sm">
      <header className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-700">Step</h3>
        <div className="flex gap-1">
          <SmallButton
            onClick={() => moveStep(step.id, Math.max(0, index - 1))}
            disabled={index === 0}
            label="↑"
            title="Move up"
          />
          <SmallButton
            onClick={() => moveStep(step.id, Math.min(steps.length - 1, index + 1))}
            disabled={index === steps.length - 1}
            label="↓"
            title="Move down"
          />
          <SmallButton
            onClick={() => removeStep(step.id)}
            label="Delete"
            title="Delete step"
            danger
          />
        </div>
      </header>

      <Field label="Name">
        <input
          className="w-full border border-slate-300 rounded px-2 py-1"
          value={step.name}
          onChange={(e) => setStepField(step.id, ["name"], e.target.value || "Untitled")}
        />
      </Field>

      <fieldset className="flex flex-col gap-2 border border-slate-200 rounded p-3">
        <legend className="px-1 text-xs font-semibold text-slate-600">Request</legend>
        <Field label="Method">
          <select
            className="border border-slate-300 rounded px-2 py-1"
            value={step.request.method}
            onChange={(e) =>
              setStepField(step.id, ["request", "method"], e.target.value as HttpMethod)
            }
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <Field label="URL">
          <input
            className="w-full border border-slate-300 rounded px-2 py-1 font-mono text-xs"
            value={step.request.url}
            onChange={(e) => setStepField(step.id, ["request", "url"], e.target.value)}
          />
        </Field>
        <HeadersEditor step={step} />
        <BodyEditor step={step} />
      </fieldset>

      <AssertEditor step={step} setStepAssert={setStepAssert} />
      <ExtractEditor step={step} />
    </aside>
  );
}

function HeadersEditor({ step }: { step: Step }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const [newKey, setNewKey] = useState("");

  const entries = Object.entries(step.request.headers ?? {});

  const replace = (next: Record<string, string>) => {
    setStepField(step.id, ["request", "headers"], next);
  };

  return (
    <div>
      <div className="text-xs font-semibold text-slate-600 mb-1">Headers</div>
      <ul className="flex flex-col gap-1">
        {entries.map(([k, v]) => (
          <li key={k} className="flex gap-2 items-center">
            <span className="font-mono text-xs text-slate-600 w-32 truncate" title={k}>
              {k}
            </span>
            <input
              className="flex-1 border border-slate-300 rounded px-2 py-1 text-xs"
              value={v}
              onChange={(e) => {
                const next = { ...step.request.headers, [k]: e.target.value };
                replace(next);
              }}
            />
            <button
              type="button"
              aria-label={`Remove header ${k}`}
              className="text-slate-500 hover:text-red-600"
              onClick={() => {
                const next = { ...step.request.headers };
                delete next[k];
                replace(next);
              }}
            >
              ×
            </button>
          </li>
        ))}
        {entries.length === 0 && (
          <li className="text-xs text-slate-400 italic">No headers</li>
        )}
      </ul>
      <div className="flex gap-2 mt-1">
        <input
          className="flex-1 border border-slate-300 rounded px-2 py-1 text-xs font-mono"
          placeholder="Header-Name"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <button
          type="button"
          className="px-2 py-1 text-xs border border-slate-300 rounded disabled:opacity-50"
          disabled={!newKey.trim()}
          onClick={() => {
            const k = newKey.trim();
            if (!k || k in (step.request.headers ?? {})) return;
            replace({ ...step.request.headers, [k]: "" });
            setNewKey("");
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function BodyEditor({ step }: { step: Step }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);

  const kind: BodyKind = step.request.body?.kind ?? "none";

  const setKind = (k: BodyKind) => {
    if (k === "none") {
      setStepField(step.id, ["request", "body"], undefined);
      return;
    }
    // YAML representation: body: { json: ... } not { kind: 'json', value: ... }
    const value: unknown = k === "json" ? {} : k === "form" ? {} : "";
    setStepField(step.id, ["request", "body"], { [k]: value });
  };

  return (
    <div>
      <div className="text-xs font-semibold text-slate-600 mb-1">Body</div>
      <select
        className="border border-slate-300 rounded px-2 py-1 text-sm mb-2"
        value={kind}
        onChange={(e) => setKind(e.target.value as BodyKind)}
      >
        {BODY_KINDS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      {kind === "json" && <JsonBodyField step={step} />}
      {kind === "form" && <FormBodyField step={step} />}
      {kind === "raw" && <RawBodyField step={step} />}
    </div>
  );
}

function JsonBodyField({ step }: { step: Step }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const body = step.request.body;
  const initial =
    body?.kind === "json" ? JSON.stringify(body.value, null, 2) : "{}";
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Reset local textarea only when the user switches to a different step,
    // not on every body change (which would overwrite in-progress edits).
    setText(body?.kind === "json" ? JSON.stringify(body.value, null, 2) : "{}");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id]);

  const commit = () => {
    try {
      const parsed = JSON.parse(text);
      setError(null);
      setStepField(step.id, ["request", "body"], { json: parsed });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      <textarea
        className="w-full h-32 border border-slate-300 rounded px-2 py-1 text-xs font-mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        spellCheck={false}
      />
      {error && <p className="text-xs text-red-600">JSON: {error}</p>}
    </div>
  );
}

function FormBodyField({ step }: { step: Step }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const body = step.request.body;
  const map = body?.kind === "form" ? body.value : {};
  const entries = Object.entries(map);
  const [newKey, setNewKey] = useState("");

  const replace = (next: Record<string, string>) => {
    setStepField(step.id, ["request", "body"], { form: next });
  };

  return (
    <div>
      <ul className="flex flex-col gap-1">
        {entries.map(([k, v]) => (
          <li key={k} className="flex gap-2 items-center">
            <span className="font-mono text-xs text-slate-600 w-32 truncate">{k}</span>
            <input
              className="flex-1 border border-slate-300 rounded px-2 py-1 text-xs"
              value={v}
              onChange={(e) => replace({ ...map, [k]: e.target.value })}
            />
            <button
              type="button"
              aria-label={`Remove form field ${k}`}
              className="text-slate-500 hover:text-red-600"
              onClick={() => {
                const next = { ...map };
                delete next[k];
                replace(next);
              }}
            >
              ×
            </button>
          </li>
        ))}
        {entries.length === 0 && (
          <li className="text-xs text-slate-400 italic">No fields</li>
        )}
      </ul>
      <div className="flex gap-2 mt-1">
        <input
          className="flex-1 border border-slate-300 rounded px-2 py-1 text-xs font-mono"
          placeholder="field"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <button
          type="button"
          className="px-2 py-1 text-xs border border-slate-300 rounded disabled:opacity-50"
          disabled={!newKey.trim()}
          onClick={() => {
            const k = newKey.trim();
            if (!k || k in map) return;
            replace({ ...map, [k]: "" });
            setNewKey("");
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function RawBodyField({ step }: { step: Step }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const body = step.request.body;
  const value = body?.kind === "raw" ? body.value : "";
  return (
    <textarea
      className="w-full h-24 border border-slate-300 rounded px-2 py-1 text-xs font-mono"
      value={value}
      onChange={(e) => setStepField(step.id, ["request", "body"], { raw: e.target.value })}
      spellCheck={false}
    />
  );
}

function AssertEditor({
  step,
  setStepAssert,
}: {
  step: Step;
  setStepAssert: (id: string, asserts: ReadonlyArray<Assertion>) => void;
}) {
  const [newCode, setNewCode] = useState("");
  return (
    <fieldset className="flex flex-col gap-2 border border-slate-200 rounded p-3">
      <legend className="px-1 text-xs font-semibold text-slate-600">Assertions</legend>
      <ul className="flex flex-col gap-1">
        {step.assert.map((a, idx) => (
          <li key={`${a.kind}-${a.code}-${idx}`} className="flex items-center gap-2 text-xs">
            <span className="font-mono text-slate-600 w-16">status</span>
            <input
              type="number"
              min={100}
              max={599}
              className="w-24 border border-slate-300 rounded px-2 py-1"
              value={a.code}
              onChange={(e) => {
                const code = Number(e.target.value);
                if (!Number.isFinite(code)) return;
                const next = [...step.assert];
                next[idx] = { kind: "status", code };
                setStepAssert(step.id, next);
              }}
            />
            <button
              type="button"
              aria-label={`Remove assertion ${idx}`}
              className="text-slate-500 hover:text-red-600"
              onClick={() => {
                setStepAssert(
                  step.id,
                  step.assert.filter((_, i) => i !== idx),
                );
              }}
            >
              ×
            </button>
          </li>
        ))}
        {step.assert.length === 0 && (
          <li className="text-xs text-slate-400 italic">No assertions</li>
        )}
      </ul>
      <div className="flex gap-2">
        <input
          type="number"
          placeholder="200"
          min={100}
          max={599}
          className="w-24 border border-slate-300 rounded px-2 py-1 text-xs"
          value={newCode}
          onChange={(e) => setNewCode(e.target.value)}
        />
        <button
          type="button"
          className="px-2 py-1 text-xs border border-slate-300 rounded disabled:opacity-50"
          disabled={!newCode}
          onClick={() => {
            const code = Number(newCode);
            if (!Number.isFinite(code) || code < 100 || code > 599) return;
            setStepAssert(step.id, [...step.assert, { kind: "status", code }]);
            setNewCode("");
          }}
        >
          Add
        </button>
      </div>
    </fieldset>
  );
}

// Draft type mirrors Extract but allows empty strings during editing.
type DraftExtract =
  | { var: string; from: "body"; path: string }
  | { var: string; from: "header"; name: string }
  | { var: string; from: "cookie"; name: string }
  | { var: string; from: "status" };

function draftFromExtract(e: Extract): DraftExtract {
  return e as DraftExtract;
}

function ExtractEditor({ step }: { step: Step }) {
  const setStepExtract = useScenarioEditor((s) => s.setStepExtract);

  // Local drafts let us show in-progress rows before they pass Zod validation.
  const [drafts, setDrafts] = useState<DraftExtract[]>(() =>
    step.extract.map(draftFromExtract),
  );

  // Reset drafts when the selected step changes.
  useEffect(() => {
    setDrafts(step.extract.map(draftFromExtract));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id]);

  // Push valid rows to the store after every draft change.
  const commitDrafts = (next: DraftExtract[]) => {
    // Rows that satisfy Zod (var non-empty + required second field non-empty).
    const valid = next.filter((d) => {
      if (!d.var) return false;
      if (d.from === "body") return d.path.length > 0;
      if (d.from === "header" || d.from === "cookie") return d.name.length > 0;
      return true; // status needs no extra field
    }) as Extract[];
    setStepExtract(step.id, valid);
  };

  const setRow = (idx: number, next: DraftExtract) => {
    const list = drafts.slice();
    list[idx] = next;
    setDrafts(list);
    commitDrafts(list);
  };

  const remove = (idx: number) => {
    const list = drafts.filter((_, i) => i !== idx);
    setDrafts(list);
    setStepExtract(step.id, list as Extract[]);
  };

  const append = () => {
    const list: DraftExtract[] = [...drafts, { var: "", from: "body", path: "$." }];
    setDrafts(list);
    // Don't commit yet — the new row is empty and won't pass validation.
  };

  return (
    <fieldset
      className="flex flex-col gap-2 border border-slate-200 rounded p-3"
      aria-label="Extracts"
    >
      <legend className="px-1 text-xs font-semibold text-slate-600">Extracts</legend>
      <ul className="flex flex-col gap-2">
        {drafts.map((x, idx) => (
          <li key={idx} className="flex flex-wrap gap-2 items-center text-xs">
            <input
              placeholder="var"
              className="border border-slate-300 rounded px-2 py-1 font-mono w-24"
              value={x.var}
              onChange={(e) => setRow(idx, { ...x, var: e.target.value })}
            />
            <select
              aria-label={`extract-from-${idx}`}
              className="border border-slate-300 rounded px-2 py-1"
              value={x.from}
              onChange={(e) => {
                const from = e.target.value as Extract["from"];
                if (from === "body") setRow(idx, { var: x.var, from, path: "$." });
                else if (from === "header") setRow(idx, { var: x.var, from, name: "" });
                else if (from === "cookie") setRow(idx, { var: x.var, from, name: "" });
                else setRow(idx, { var: x.var, from: "status" });
              }}
            >
              <option value="body">body</option>
              <option value="header">header</option>
              <option value="cookie">cookie</option>
              <option value="status">status</option>
            </select>
            {x.from === "body" && (
              <input
                placeholder="$.path"
                className="border border-slate-300 rounded px-2 py-1 font-mono flex-1 min-w-[120px]"
                value={x.path}
                onChange={(e) => setRow(idx, { ...x, path: e.target.value })}
              />
            )}
            {(x.from === "header" || x.from === "cookie") && (
              <input
                placeholder={x.from === "header" ? "header name" : "cookie name"}
                className="border border-slate-300 rounded px-2 py-1 font-mono flex-1 min-w-[120px]"
                value={x.name}
                onChange={(e) => setRow(idx, { ...x, name: e.target.value })}
              />
            )}
            {x.from === "status" && (
              <span className="text-slate-400 italic flex-1">no extra field</span>
            )}
            <button
              type="button"
              aria-label={`Remove extract ${idx}`}
              className="text-slate-500 hover:text-red-600"
              onClick={() => remove(idx)}
            >
              ×
            </button>
          </li>
        ))}
        {drafts.length === 0 && (
          <li className="text-xs text-slate-400 italic">No extracts</li>
        )}
      </ul>
      <button
        type="button"
        className="self-start px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
        onClick={append}
      >
        Add
      </button>
    </fieldset>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-slate-600">{label}</span>
      {children}
    </label>
  );
}

function SmallButton({
  onClick,
  label,
  title,
  disabled,
  danger,
}: {
  onClick: () => void;
  label: string;
  title: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={
        "px-2 py-1 text-xs border rounded disabled:opacity-40 " +
        (danger
          ? "border-red-300 text-red-700 hover:bg-red-50"
          : "border-slate-300 text-slate-700 hover:bg-slate-100")
      }
    >
      {label}
    </button>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useScenarioEditor } from "../../scenario/store";
import type { Body, HttpMethod, Step } from "../../scenario/model";

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
    let next: Body;
    if (k === "json") next = { kind: "json", value: {} };
    else if (k === "form") next = { kind: "form", value: {} };
    else next = { kind: "raw", value: "" };
    // YAML representation: body: { json: ... } not { kind: 'json', value: ... }
    const yamlShape: Record<string, unknown> = {};
    yamlShape[k] = next.value;
    setStepField(step.id, ["request", "body"], yamlShape);
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

  // Keep textarea in sync if the step changes from elsewhere.
  useEffect(() => {
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
  setStepAssert: (id: string, asserts: ReadonlyArray<{ kind: "status"; code: number }>) => void;
}) {
  const [newCode, setNewCode] = useState("");
  return (
    <fieldset className="flex flex-col gap-2 border border-slate-200 rounded p-3">
      <legend className="px-1 text-xs font-semibold text-slate-600">Assertions</legend>
      <ul className="flex flex-col gap-1">
        {step.assert.map((a, idx) => (
          <li key={idx} className="flex items-center gap-2 text-xs">
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

import { useState } from "react";
import { useCreateRun } from "../api/hooks";
import { Button } from "./Button";

type Props = {
  scenarioId: string;
  onCreated: (runId: string) => void;
  onCancel: () => void;
};

type EnvEntry = { key: string; value: string };

export function RunDialog({ scenarioId, onCreated, onCancel }: Props) {
  const [vus, setVus] = useState(2);
  const [duration, setDuration] = useState(5);
  const [rampUp, setRampUp] = useState(0);
  const [loopCap, setLoopCap] = useState(256);
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>([]);
  const [newEnvKey, setNewEnvKey] = useState("");
  const [newEnvValue, setNewEnvValue] = useState("");
  const mutation = useCreateRun();

  const rampInvalid = rampUp > duration;
  const loopCapInvalid = loopCap < 0 || loopCap > 10000;
  const canSubmit = vus >= 1 && duration >= 1 && !rampInvalid && !loopCapInvalid && !mutation.isPending;

  const env: Record<string, string> = {};
  for (const { key, value } of envEntries) {
    const k = key.trim();
    if (k) env[k] = value;
  }

  return (
    <div className="border border-slate-200 rounded-md p-4 bg-white">
      <h3 className="text-lg font-semibold mb-3">New run</h3>
      <div className="grid grid-cols-3 gap-4 mb-3">
        <label className="block text-sm">
          <span className="text-slate-600">VUs</span>
          <input
            type="number"
            min={1}
            value={vus}
            onChange={(e) => setVus(Number(e.target.value))}
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block text-sm">
          <span className="text-slate-600">Duration (s)</span>
          <input
            type="number"
            min={1}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block text-sm">
          <span className="text-slate-600">Ramp-up (s)</span>
          <input
            type="number"
            min={0}
            value={rampUp}
            onChange={(e) => setRampUp(Number(e.target.value))}
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
            aria-invalid={rampInvalid}
            aria-describedby={rampInvalid ? "ramp-up-error" : undefined}
          />
        </label>
      </div>

      <div className="mb-3">
        <label className="block text-sm">
          Loop breakdown cap
          <input
            type="number"
            min={0}
            max={10000}
            aria-label="loop breakdown cap"
            value={loopCap}
            onChange={(e) => setLoopCap(Number(e.target.value))}
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
          />
          <span className="text-xs text-slate-500">0 = 끄기 · 루프 스텝의 loop_index별 집계 상한</span>
        </label>
      </div>

      {rampInvalid && (
        <p id="ramp-up-error" className="mb-3 text-red-600 text-sm">
          Ramp-up must be ≤ duration.
        </p>
      )}

      <section aria-label="Environment variables" className="mb-3">
        <h4 className="text-sm font-semibold text-slate-700 mb-2">Env</h4>
        <ul className="flex flex-col gap-2">
          {envEntries.map((entry, idx) => (
            <li key={idx} className="flex items-center gap-2">
              <input
                aria-label={`env key ${idx}`}
                className="w-40 border border-slate-300 rounded px-2 py-1 text-sm font-mono"
                value={entry.key}
                onChange={(e) =>
                  setEnvEntries((prev) =>
                    prev.map((p, i) => (i === idx ? { ...p, key: e.target.value } : p)),
                  )
                }
              />
              <span className="text-slate-400 text-sm">=</span>
              <input
                aria-label={`env value ${idx}`}
                className="flex-1 border border-slate-300 rounded px-2 py-1 text-sm"
                value={entry.value}
                onChange={(e) =>
                  setEnvEntries((prev) =>
                    prev.map((p, i) => (i === idx ? { ...p, value: e.target.value } : p)),
                  )
                }
              />
              <button
                type="button"
                onClick={() =>
                  setEnvEntries((prev) => prev.filter((_, i) => i !== idx))
                }
                aria-label={`Remove env ${entry.key || idx}`}
                className="text-slate-500 hover:text-red-600 text-sm"
              >
                ×
              </button>
            </li>
          ))}
          {envEntries.length === 0 && (
            <li className="text-xs text-slate-400 italic">No env vars</li>
          )}
        </ul>

        <div className="flex items-center gap-2 mt-2">
          <input
            aria-label="new env key"
            className="w-40 border border-slate-300 rounded px-2 py-1 text-sm font-mono"
            placeholder="BASE_URL"
            value={newEnvKey}
            onChange={(e) => setNewEnvKey(e.target.value)}
          />
          <span className="text-slate-400 text-sm">=</span>
          <input
            aria-label="new env value"
            className="flex-1 border border-slate-300 rounded px-2 py-1 text-sm"
            placeholder="http://localhost:9090"
            value={newEnvValue}
            onChange={(e) => setNewEnvValue(e.target.value)}
          />
          <button
            type="button"
            onClick={() => {
              const k = newEnvKey.trim();
              if (!k) return;
              setEnvEntries((prev) => [...prev, { key: k, value: newEnvValue }]);
              setNewEnvKey("");
              setNewEnvValue("");
            }}
            disabled={newEnvKey.trim().length === 0}
            className="px-2 py-1 text-sm border border-slate-300 rounded disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </section>

      {mutation.error && (
        <p className="mb-3 text-red-600 text-sm">{(mutation.error as Error).message}</p>
      )}

      <div className="flex gap-2">
        <Button
          onClick={() =>
            mutation.mutate(
              {
                scenarioId,
                profile: {
                  vus,
                  duration_seconds: duration,
                  ramp_up_seconds: rampUp,
                  loop_breakdown_cap: loopCap,
                },
                env,
              },
              { onSuccess: (run) => onCreated(run.id) },
            )
          }
          disabled={!canSubmit}
        >
          {mutation.isPending ? "Starting…" : "Run"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

import { useState } from "react";
import { useCreateRun } from "../api/hooks";
import { Button } from "./Button";

type Props = {
  scenarioId: string;
  onCreated: (runId: string) => void;
  onCancel: () => void;
};

export function RunDialog({ scenarioId, onCreated, onCancel }: Props) {
  const [vus, setVus] = useState(2);
  const [duration, setDuration] = useState(5);
  const mutation = useCreateRun();

  return (
    <div className="border border-slate-200 rounded-md p-4 bg-white">
      <h3 className="text-lg font-semibold mb-3">New run</h3>
      <div className="grid grid-cols-2 gap-4 mb-3">
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
      </div>

      {mutation.error && (
        <p className="mb-3 text-red-600 text-sm">{(mutation.error as Error).message}</p>
      )}

      <div className="flex gap-2">
        <Button
          onClick={() =>
            mutation.mutate(
              {
                scenarioId,
                profile: { vus, duration_seconds: duration, ramp_up_seconds: 0 },
                env: {},
              },
              { onSuccess: (run) => onCreated(run.id) },
            )
          }
          disabled={mutation.isPending || vus < 1 || duration < 1}
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

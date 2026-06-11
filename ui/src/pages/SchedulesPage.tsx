import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  queryKeys,
  useSchedules,
  useScenarios,
  useCreateSchedule,
  useUpdateSchedule,
  useDeleteSchedule,
} from "../api/hooks";
import { getSchedule, type ScheduleInput } from "../api/schedules";
import { describeTrigger } from "../components/triggerCron";
import { ScheduleForm, type ScenarioOption } from "../components/ScheduleForm";
import { ScheduleEventTimeline } from "../components/ScheduleEventTimeline";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { ko } from "../i18n/ko";

const STATUS_STYLE: Record<string, string> = {
  fired: "bg-green-100 text-green-800",
  skipped_overlap: "bg-amber-100 text-amber-800",
  missed: "bg-orange-100 text-orange-800",
  error: "bg-red-100 text-red-800",
};

type ScheduleFormInitial = NonNullable<React.ComponentProps<typeof ScheduleForm>["initial"]>;

export function SchedulesPage() {
  const list = useSchedules();
  const scenarios = useScenarios();
  const createSchedule = useCreateSchedule();
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();
  const qc = useQueryClient();

  const [mode, setMode] = useState<"none" | "new" | "edit">("none");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editInitial, setEditInitial] = useState<ScheduleFormInitial | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [delError, setDelError] = useState<string | null>(null);

  // useScenarios() returns {scenarios:[…]} wrapper — unwrap .scenarios (CRITICAL).
  const scenarioOptions: ScenarioOption[] = (scenarios.data?.scenarios ?? []).map((s) => ({
    id: s.id,
    name: s.name,
  }));

  function startNew() {
    setMode("new");
    setEditingId(null);
    setEditInitial(null);
    setFormError(null);
  }

  // Imperative load on Edit (mirrors EnvironmentsPage.startEdit) — avoids a reseed-effect race.
  const startEdit = async (id: string) => {
    setFormError(null);
    try {
      const s = await qc.fetchQuery({
        queryKey: queryKeys.schedule(id),
        queryFn: () => getSchedule(id),
      });
      setEditInitial({
        name: s.name,
        scenario_id: s.scenario_id,
        profile: s.profile,
        env: s.env,
        trigger: s.trigger,
        enabled: s.enabled,
      });
      setEditingId(id);
      setMode("edit");
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  function handleSubmit(input: ScheduleInput) {
    setFormError(null);
    const done = {
      onSuccess: () => setMode("none"),
      onError: (e: Error) => setFormError(e.message),
    };
    if (mode === "edit" && editingId) {
      updateSchedule.mutate({ id: editingId, input }, done);
    } else {
      createSchedule.mutate(input, done);
    }
  }

  const toggleEnabled = async (id: string) => {
    setDelError(null);
    try {
      const full = await qc.fetchQuery({
        queryKey: queryKeys.schedule(id),
        queryFn: () => getSchedule(id),
      });
      const input: ScheduleInput = {
        name: full.name,
        scenario_id: full.scenario_id,
        profile: full.profile,
        env: full.env,
        trigger: full.trigger,
        enabled: !full.enabled,
      };
      updateSchedule.mutate({ id, input }, { onError: (e) => setDelError((e as Error).message) });
    } catch (e) {
      setDelError((e as Error).message);
    }
  };

  function handleDelete(id: string) {
    setDelError(null);
    if (!window.confirm("이 스케줄을 삭제할까요? (예약/반복 발사가 중단됩니다)")) return;
    deleteSchedule.mutate(id, { onError: (e) => setDelError((e as Error).message) });
  }

  const submitting = createSchedule.isPending || updateSchedule.isPending;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold">{ko.nav.schedules}</h2>
        {mode === "none" && <Button onClick={startNew}>{ko.pages.newSchedule}</Button>}
      </div>

      {mode !== "none" && (
        <section
          aria-label="schedule form"
          className="mb-8 border border-slate-200 rounded-md p-4 bg-white"
        >
          <h3 className="text-md font-semibold mb-3">
            {mode === "edit" ? ko.pages.editSchedule : ko.pages.newSchedule}
          </h3>
          {formError && (
            <p role="alert" className="mb-2 text-sm text-red-600">
              {formError}
            </p>
          )}
          <ScheduleForm
            key={editingId ?? "new"}
            scenarioOptions={scenarioOptions}
            onSubmit={handleSubmit}
            submitting={submitting}
            initial={mode === "edit" && editInitial ? editInitial : undefined}
            onCancel={() => setMode("none")}
          />
          {mode === "edit" && editingId && <ScheduleEventTimeline scheduleId={editingId} />}
        </section>
      )}

      {delError && (
        <p role="alert" className="mb-4 text-sm text-red-600">
          삭제 실패: {delError}
        </p>
      )}

      <section aria-label="schedule list">
        {list.isLoading && <p className="text-slate-500">Loading…</p>}
        {list.error && (
          <p className="text-red-600">Failed to load: {(list.error as Error).message}</p>
        )}
        {list.data && list.data.length === 0 && mode === "none" && (
          <EmptyState
            body={ko.empty.schedules}
            action={
              <button
                type="button"
                onClick={startNew}
                className="text-slate-700 underline hover:text-slate-900"
              >
                {ko.empty.schedulesCta} →
              </button>
            }
          />
        )}
        {list.data && list.data.length > 0 && (
          <table className="min-w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-600">
              <tr>
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Trigger</th>
                <th className="py-2 pr-4">Next run</th>
                <th className="py-2 pr-4">Last status</th>
                <th className="py-2 pr-4">Enabled</th>
                <th className="py-2 pr-4"></th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id} className="border-b border-slate-100">
                  <td className="py-2 pr-4 font-medium">{s.name}</td>
                  <td className="py-2 pr-4">{describeTrigger(s.trigger)}</td>
                  <td className="py-2 pr-4 text-slate-500">
                    {s.next_run_at ? new Date(s.next_run_at).toLocaleString() : "—"}
                  </td>
                  <td className="py-2 pr-4">
                    {s.last_status ? (
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[s.last_status] ?? "bg-slate-100 text-slate-700"}`}
                      >
                        {s.last_status}
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    <button
                      type="button"
                      aria-label={`toggle enabled ${s.name}`}
                      onClick={() => void toggleEnabled(s.id)}
                      className="text-slate-700 hover:underline"
                      disabled={updateSchedule.isPending}
                    >
                      {s.enabled ? "✓ 켜짐" : "꺼짐"}
                    </button>
                  </td>
                  <td className="py-2 pr-4 flex gap-2">
                    <Button variant="secondary" onClick={() => void startEdit(s.id)}>
                      Edit
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => handleDelete(s.id)}
                      disabled={deleteSchedule.isPending}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

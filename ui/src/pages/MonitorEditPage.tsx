import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEnvironments, useScenarios } from "../api/hooks";
import {
  createBoard,
  deleteBoard,
  getBoard,
  newPanel,
  startBoard,
  stopBoard,
  updateBoard,
  type Blink,
  type Board,
  type BoardConfig,
  type DisplayStyle,
  type FontScale,
  type PanelConfig,
} from "../api/monitors";
import { ApiError } from "../api/client";
import { Button } from "../components/Button";
import { PanelEditor } from "../components/monitor/PanelEditor";
import { Callout } from "../components/ui/Callout";
import { Field } from "../components/ui/Field";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { ko } from "../i18n/ko";
import { enterFullscreen, exitFullscreen } from "../monitor/fullscreen";
import { MONITOR_LIST_KEY, monitorKey } from "../monitor/keys";

const MAX_PANELS = 9;

export function MonitorEditPage() {
  const { id } = useParams();
  const query = useQuery({
    queryKey: id ? monitorKey(id) : ["monitor-board", "none"],
    queryFn: () => getBoard(id!),
    enabled: Boolean(id),
    staleTime: 10_000,
  });

  if (!id) return <BoardForm key="new" initial={null} />;
  if (query.isLoading) return <p className="text-sm text-slate-500">{ko.monitor.loading}</p>;
  if (query.error) {
    if (query.error instanceof ApiError && query.error.status === 404) {
      return <p className="text-sm text-slate-500">{ko.monitor.notFound}</p>;
    }
    const msg = (query.error as Error).message;
    return (
      <Callout variant="error" role="alert">
        {ko.monitor.loadError(msg)}
      </Callout>
    );
  }
  if (!query.data) return <p className="text-sm text-slate-500">{ko.monitor.notFound}</p>;
  return <BoardForm key={query.data.id} initial={query.data} />;
}

const snapshot = (name: string, config: BoardConfig) => JSON.stringify({ name, config });

function BoardForm({ initial }: { initial: Board | null }) {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const scenarios = useScenarios();
  const environments = useEnvironments();

  const [board, setBoard] = useState<Board | null>(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [config, setConfig] = useState<BoardConfig>(
    () =>
      initial?.config ?? {
        font_scale: "large",
        display_style: "border",
        blink: "fail",
        panels: [newPanel()],
      },
  );
  const [baseline, setBaseline] = useState(() =>
    initial ? snapshot(initial.name, initial.config) : "",
  );
  const [error, setError] = useState<string | null>(
    () => (location.state as { startError?: string } | null)?.startError ?? null,
  );
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scenarioErr, setScenarioErr] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const dirty = snapshot(name, config) !== baseline;

  const adopt = (b: Board) => {
    setBoard(b);
    setName(b.name);
    setConfig(b.config);
    setBaseline(snapshot(b.name, b.config));
    qc.setQueryData(monitorKey(b.id), b);
    void qc.invalidateQueries({ queryKey: MONITOR_LIST_KEY });
  };

  const setPanel = (i: number, next: PanelConfig) =>
    setConfig((c) => ({ ...c, panels: c.panels.map((p, k) => (k === i ? next : p)) }));

  const valid = (): boolean => {
    const ok = config.panels.every((p) => p.scenario_id !== "");
    setScenarioErr(!ok);
    return ok;
  };

  const persist = async (always: boolean): Promise<Board> => {
    const input = { name, config };
    if (!board) return createBoard(input);
    if (always || dirty) return updateBoard(board.id, input);
    return board;
  };

  const onSave = async () => {
    setError(null);
    setSaved(false);
    if (!valid()) return;
    setBusy(true);
    try {
      const wasNew = !board;
      const b = await persist(true);
      adopt(b);
      setSaved(true);
      if (wasNew) navigate(`/monitors/${b.id}`, { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onStart = async () => {
    setError(null);
    setSaved(false);
    // Validate first (sync) so a rejected click never requests fullscreen; the
    // request is still made before the first await, so the gesture stays valid.
    if (!valid()) return;
    enterFullscreen();
    setBusy(true);
    let createdId: string | null = null;
    try {
      const wasNew = !board;
      const b = await persist(false);
      adopt(b);
      if (wasNew) createdId = b.id;
      const started = await startBoard(b.id);
      adopt(started);
      // Back from the display page must not reopen an empty "new" form.
      if (wasNew) navigate(`/monitors/${b.id}`, { replace: true });
      navigate(`/monitors/${started.id}/display`);
    } catch (e) {
      exitFullscreen();
      const msg = (e as Error).message;
      setError(msg);
      // Leave the "new" route (a retry must not re-create); the remounted form
      // reads the error from location state.
      if (createdId) {
        navigate(`/monitors/${createdId}`, { replace: true, state: { startError: msg } });
      }
    } finally {
      setBusy(false);
    }
  };

  const onStop = async () => {
    if (!board) return;
    setError(null);
    setBusy(true);
    try {
      const b = await stopBoard(board.id);
      setBoard(b);
      qc.setQueryData(monitorKey(b.id), b);
      void qc.invalidateQueries({ queryKey: MONITOR_LIST_KEY });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!board) return;
    setError(null);
    setBusy(true);
    try {
      await deleteBoard(board.id);
      qc.removeQueries({ queryKey: monitorKey(board.id) });
      void qc.invalidateQueries({ queryKey: MONITOR_LIST_KEY });
      navigate("/monitors");
    } catch (e) {
      setError((e as Error).message);
      setConfirmDelete(false);
      setBusy(false);
    }
  };

  return (
    <div>
      <h2 className="mb-6 text-lg font-semibold">{name.trim() || ko.monitor.newBoard}</h2>

      <div className="mb-6 grid gap-x-4 rounded-md border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={ko.monitor.boardName} htmlFor="monitor-name">
          <Input id="monitor-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={ko.monitor.fontScale} htmlFor="monitor-font">
          <Select
            id="monitor-font"
            value={config.font_scale}
            onChange={(e) => setConfig({ ...config, font_scale: e.target.value as FontScale })}
          >
            {Object.entries(ko.monitor.fontScaleOptions).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={ko.monitor.displayStyle} htmlFor="monitor-style">
          <Select
            id="monitor-style"
            value={config.display_style}
            onChange={(e) =>
              setConfig({ ...config, display_style: e.target.value as DisplayStyle })
            }
          >
            {Object.entries(ko.monitor.displayStyleOptions).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={ko.monitor.blink} htmlFor="monitor-blink">
          <Select
            id="monitor-blink"
            value={config.blink}
            onChange={(e) => setConfig({ ...config, blink: e.target.value as Blink })}
          >
            {Object.entries(ko.monitor.blinkOptions).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="flex flex-col gap-4">
        {config.panels.map((p, i) => (
          <PanelEditor
            key={p.id}
            panel={p}
            index={i}
            scenarios={scenarios.data?.scenarios ?? []}
            environments={environments.data ?? []}
            scenarioError={scenarioErr}
            canRemove={config.panels.length > 1}
            onChange={(next) => setPanel(i, next)}
            onRemove={() =>
              setConfig((c) => ({ ...c, panels: c.panels.filter((_, k) => k !== i) }))
            }
          />
        ))}
      </div>
      <div className="mt-3">
        <Button
          variant="secondary"
          type="button"
          disabled={config.panels.length >= MAX_PANELS}
          onClick={() => setConfig((c) => ({ ...c, panels: [...c.panels, newPanel()] }))}
        >
          {ko.monitor.addPanel}
        </Button>
      </div>

      {error && (
        <Callout variant="error" role="alert" className="mt-4">
          {error}
        </Callout>
      )}
      {saved && (
        <p role="status" className="mt-4 text-sm text-emerald-700">
          {ko.monitor.saved}
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button variant="secondary" type="button" disabled={busy} onClick={onSave}>
          {ko.monitor.save}
        </Button>
        <Button type="button" disabled={busy} onClick={onStart}>
          {ko.monitor.start}
        </Button>
        {board?.enabled && (
          <Button variant="secondary" type="button" disabled={busy} onClick={onStop}>
            {ko.monitor.stop}
          </Button>
        )}
        {board && !confirmDelete && (
          <Button
            variant="danger"
            type="button"
            className="ml-auto"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            {ko.monitor.deleteBoard}
          </Button>
        )}
      </div>

      {board && confirmDelete && (
        <div
          role="group"
          aria-label={ko.monitor.deleteBoard}
          className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          <span>{ko.monitor.deleteConfirm(board.name)}</span>
          <Button variant="danger" type="button" disabled={busy} onClick={onDelete}>
            {ko.monitor.deleteConfirmOk}
          </Button>
          <Button variant="secondary" type="button" onClick={() => setConfirmDelete(false)}>
            {ko.monitor.cancel}
          </Button>
        </div>
      )}
    </div>
  );
}

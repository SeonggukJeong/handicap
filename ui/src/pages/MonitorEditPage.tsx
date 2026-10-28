import { useEffect, useRef, useState } from "react";
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
import { PanelNav } from "../components/monitor/PanelNav";
import { Callout } from "../components/ui/Callout";
import { Field } from "../components/ui/Field";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { ko } from "../i18n/ko";
import { enterFullscreen, exitFullscreen } from "../monitor/fullscreen";
import { MONITOR_LIST_KEY, monitorKey } from "../monitor/keys";
import { parsePanelError } from "../monitor/panelErrors";

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

type NavState = { startError?: string; expanded?: string[] };

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
        show_latency_stats: true,
        display_style: "border",
        blink: "fail",
        panels: [newPanel()],
      },
  );
  const [baseline, setBaseline] = useState(() =>
    initial ? snapshot(initial.name, initial.config) : "",
  );
  const [error, setError] = useState<string | null>(
    () => (location.state as NavState | null)?.startError ?? null,
  );
  // Per-panel error reasons keyed by panel id. A remount after a failed first start
  // restores the panel mark from the carried `startError`.
  const [panelErrors, setPanelErrors] = useState<Record<string, string>>(() => {
    const pe = parsePanelError((location.state as NavState | null)?.startError ?? "");
    const pid = pe ? config.panels[pe.index]?.id : undefined;
    return pe && pid ? { [pid]: pe.reason } : {};
  });
  // Expanded panel cards. An existing board opens fully collapsed; a new board opens
  // its default panel. A remount after the first save carries the set via router state.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const carried = (location.state as NavState | null)?.expanded;
    if (carried) return new Set([...carried, ...Object.keys(panelErrors)]);
    return initial ? new Set() : new Set([config.panels[0].id]);
  });
  // Router state is only a one-shot hand-off; clear it so a reload falls back to the defaults.
  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only hand-off
  }, []);
  const togglePanel = (pid: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(pid)) next.add(pid);
      return next;
    });
  // Nav jump: expand first, then (after that render commits) scroll to the card and focus its toggle.
  const pendingJump = useRef<string | null>(null);
  const jumpToPanel = (pid: string) => {
    pendingJump.current = pid;
    setExpanded((s) => new Set(s).add(pid));
  };
  useEffect(() => {
    const pid = pendingJump.current;
    if (!pid) return;
    pendingJump.current = null;
    const card = document.getElementById(`panel-${pid}`);
    card?.scrollIntoView({ block: "start" });
    card?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.focus();
  }, [expanded]);
  const jumpToActions = () =>
    document.getElementById("monitor-actions")?.scrollIntoView({ block: "start" });
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

  const setPanel = (i: number, next: PanelConfig) => {
    const pid = config.panels[i]?.id;
    if (pid)
      setPanelErrors((m) => {
        if (!(pid in m)) return m;
        const rest = { ...m };
        delete rest[pid];
        return rest;
      });
    setConfig((c) => ({ ...c, panels: c.panels.map((p, k) => (k === i ? next : p)) }));
  };

  // Marks panels with errors and opens them so the reason is visible.
  const markPanels = (errs: Record<string, string>) => {
    setPanelErrors(errs);
    const ids = Object.keys(errs);
    if (ids.length) setExpanded((s) => new Set([...s, ...ids]));
  };

  // A server 400 whose message names a panel (`칸 N: …`) marks that panel.
  const markFromServer = (e: unknown) => {
    if (!(e instanceof ApiError) || e.status !== 400) return;
    const pe = parsePanelError(e.message);
    const pid = pe ? config.panels[pe.index]?.id : undefined;
    if (pe && pid) markPanels({ [pid]: pe.reason });
  };

  const valid = (): boolean => {
    const missing = config.panels.filter((p) => p.scenario_id === "");
    const ok = missing.length === 0;
    setScenarioErr(!ok);
    markPanels(Object.fromEntries(missing.map((p) => [p.id, ko.monitor.scenarioRequired])));
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
    setPanelErrors({});
    setSaved(false);
    if (!valid()) return;
    setBusy(true);
    try {
      const wasNew = !board;
      const b = await persist(true);
      adopt(b);
      setSaved(true);
      if (wasNew) {
        navigate(`/monitors/${b.id}`, {
          replace: true,
          state: { expanded: [...expanded] } satisfies NavState,
        });
      }
    } catch (e) {
      setError((e as Error).message);
      markFromServer(e);
    } finally {
      setBusy(false);
    }
  };

  const onStart = async () => {
    setError(null);
    setPanelErrors({});
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
      markFromServer(e);
      // Leave the "new" route (a retry must not re-create); the remounted form
      // reads the error from location state.
      if (createdId) {
        navigate(`/monitors/${createdId}`, {
          replace: true,
          state: { startError: msg, expanded: [...expanded] } satisfies NavState,
        });
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
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_14rem] lg:gap-6">
      <div className="min-w-0">
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

        <div className="flex flex-col gap-2">
          {config.panels.map((p, i) => (
            <PanelEditor
              key={p.id}
              panel={p}
              index={i}
              scenarios={scenarios.data?.scenarios ?? []}
              environments={environments.data ?? []}
              scenarioError={scenarioErr}
              canRemove={config.panels.length > 1}
              expanded={expanded.has(p.id)}
              error={panelErrors[p.id]}
              onToggle={() => togglePanel(p.id)}
              onChange={(next) => setPanel(i, next)}
              onRemove={() => {
                setConfig((c) => ({ ...c, panels: c.panels.filter((_, k) => k !== i) }));
                setExpanded((s) => {
                  const next = new Set(s);
                  next.delete(p.id);
                  return next;
                });
              }}
            />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            type="button"
            disabled={config.panels.length >= MAX_PANELS}
            onClick={() => {
              const np = newPanel();
              setConfig((c) => ({ ...c, panels: [...c.panels, np] }));
              setExpanded((s) => new Set(s).add(np.id));
            }}
          >
            {ko.monitor.addPanel}
          </Button>
          <Button
            variant="secondary"
            type="button"
            onClick={() => setExpanded(new Set(config.panels.map((p) => p.id)))}
          >
            {ko.monitor.expandAll}
          </Button>
          <Button variant="secondary" type="button" onClick={() => setExpanded(new Set())}>
            {ko.monitor.collapseAll}
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

        <div id="monitor-actions" className="mt-6 flex flex-wrap items-center gap-3">
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
      <aside className="hidden lg:block">
        <div className="sticky top-4 self-start">
          <PanelNav
            panels={config.panels}
            expanded={expanded}
            errors={panelErrors}
            onJump={jumpToPanel}
            onJumpActions={jumpToActions}
          />
        </div>
      </aside>
    </div>
  );
}

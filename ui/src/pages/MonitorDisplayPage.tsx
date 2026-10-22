import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getBoard, getBoardStatus, stopBoard, type Blink } from "../api/monitors";
import { enterFullscreen, exitFullscreen, isFullscreen } from "../monitor/fullscreen";
import { ApiError } from "../api/client";
import { MonitorPanel, PanelProbe, type PanelMeasure } from "../components/monitor/MonitorPanel";
import { StripCard } from "../components/monitor/StripCard";
import {
  FONT_SCALE,
  focusLayout,
  gridFor,
  panelState,
  type FocusLayout,
  type PanelState,
} from "../monitor/logic";
import { COLOR, MIN_FIT, nextSearch, requiredFit, type ScaleSearch } from "../monitor/display";
import { formatHms } from "../monitor/time";
import { MONITOR_LIST_KEY, monitorKey } from "../monitor/keys";
import { ko } from "../i18n/ko";

const SEARCH_START: ScaleSearch = { lo: MIN_FIT, hi: 1, cand: 1, done: false };

/** Consecutive failed status polls after which the server counts as down. */
const SERVER_DOWN_AFTER = 3;

const isNotFound = (e: unknown) => e instanceof ApiError && e.status === 404;

/** Mouse idle time in fullscreen before the cursor hides (spec 7.6). */
const CURSOR_HIDE_MS = 3000;

const FONT_FAMILY = '"Pretendard", "Noto Sans KR", system-ui, sans-serif';

/** Which panel states blink for a board setting (spec 7.5). Config/stale never blink. */
function blinks(mode: Blink, state: PanelState): boolean {
  if (mode === "off") return false;
  return state === "fail" || (mode === "slow_and_fail" && state === "slow");
}

function FullScreenMessage({ children }: { children: ReactNode }) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center font-bold"
      style={{ background: COLOR.bg, color: COLOR.muted, fontFamily: FONT_FAMILY, fontSize: "3vw" }}
    >
      {children}
    </div>
  );
}

function ToolButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded border border-slate-600 bg-slate-800/90 px-3 py-1.5 text-slate-100 hover:bg-slate-700 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function MonitorDisplayPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [failedPolls, setFailedPolls] = useState(0);
  const [full, setFull] = useState(isFullscreen);
  const [cursorIdle, setCursorIdle] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  // One text scale for the whole board (spec §7.3 극단값 표시 정책), fixed by the
  // settings and the viewport only (축소 비율은 설정으로 고정). Invisible size
  // probes lay out each panel's worst-case settings text; when settings or the
  // viewport change, a binary search over [MIN_FIT, 1] finds the largest scale
  // at which every probe fits (wrapping makes the need non-linear, so a single
  // proportional step can overshoot). Live results never feed it, and the panels
  // only take the result once the search is done.
  const [fit, setFit] = useState(1);
  const [search, setSearch] = useState<ScaleSearch>(SEARCH_START);
  const searchRef = useRef(search);
  searchRef.current = search;
  const probeOk = useRef(new Map<string, boolean>());
  // Reason line's own scale (R18), read from the probes once the search is done.
  const [reasonFit, setReasonFit] = useState(1);
  const reasonNeeds = useRef(new Map<string, number>());
  const probeCount = useRef(0);
  const [viewport, setViewport] = useState(() => `${window.innerWidth}x${window.innerHeight}`);
  useEffect(() => {
    const onResize = () => setViewport(`${window.innerWidth}x${window.innerHeight}`);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const onProbe = useCallback((id: string, m: PanelMeasure) => {
    const cur = searchRef.current;
    if (m.fit !== cur.cand) return;
    if (cur.done) {
      reasonNeeds.current.set(id, m.reasonNeed);
      if (reasonNeeds.current.size < probeCount.current) return;
      const r = Math.min(1, ...reasonNeeds.current.values());
      setReasonFit((prev) => (Math.abs(prev - r) < 0.0001 ? prev : r));
      return;
    }
    probeOk.current.set(id, !Number.isFinite(requiredFit(m)));
    if (probeOk.current.size < probeCount.current) return;
    const ok = [...probeOk.current.values()].every(Boolean);
    probeOk.current.clear();
    const next = nextSearch(cur, ok);
    searchRef.current = next;
    setSearch(next);
    if (next.done) setFit(next.lo);
  }, []);

  const boardQ = useQuery({
    queryKey: monitorKey(id),
    queryFn: () => getBoard(id),
    retry: (count, err) => !isNotFound(err) && count < 1,
  });

  const statusQ = useQuery({
    queryKey: ["monitorStatus", id],
    queryFn: async ({ signal }) => {
      try {
        // bounded by STATUS_TIMEOUT_MS: a timed-out poll counts as a failure
        const s = await getBoardStatus(id, signal);
        setFailedPolls(0);
        return s;
      } catch (e) {
        if (!isNotFound(e)) setFailedPolls((n) => n + 1);
        throw e;
      }
    },
    // Poll every second, also when hidden (otherwise stale detection stops), and
    // never retry: the screen counts failures itself (spec §7.4).
    refetchInterval: (q) => (isNotFound(q.state.error) ? false : 1000),
    refetchIntervalInBackground: true,
    retry: false,
  });

  const status = statusQ.data;
  const board = boardQ.data;
  const boardFetching = boardQ.isFetching;
  const boardNotFound = isNotFound(boardQ.error);
  const refetchBoard = boardQ.refetch;
  const refetchStatus = statusQ.refetch;
  const statusTick = statusQ.dataUpdatedAt;
  const statusBoardUpdatedAt = status?.board_updated_at;
  const boardUpdatedAt = board?.updated_at;

  // Settings saved elsewhere -> re-read the board config (US4). Also retries a
  // board load that failed while the status endpoint answers.
  useEffect(() => {
    if (statusBoardUpdatedAt === undefined || boardFetching || boardNotFound) return;
    if (boardUpdatedAt !== statusBoardUpdatedAt) void refetchBoard();
  }, [
    statusTick,
    statusBoardUpdatedAt,
    boardUpdatedAt,
    boardFetching,
    boardNotFound,
    refetchBoard,
  ]);

  // Fullscreen state follows the browser (ESC is handled natively).
  useEffect(() => {
    const sync = () => setFull(isFullscreen());
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  // F toggles; any mouse button exits (never mere movement); no context menu in
  // fullscreen. isFullscreen() is read live so a stale render can't misjudge.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // e.code covers Korean IME, where e.key is "ㄹ"/"Process".
      if (e.key !== "f" && e.key !== "F" && e.code !== "KeyF") return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (isFullscreen()) exitFullscreen();
      else enterFullscreen();
    };
    const onDown = () => {
      if (isFullscreen()) exitFullscreen();
    };
    const onContext = (e: MouseEvent) => {
      if (isFullscreen()) e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("contextmenu", onContext);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("contextmenu", onContext);
    };
  }, []);

  // Cursor hides after CURSOR_HIDE_MS without movement while fullscreen.
  useEffect(() => {
    if (!full) {
      setCursorIdle(false);
      return;
    }
    let timer = setTimeout(() => setCursorIdle(true), CURSOR_HIDE_MS);
    const onMove = () => {
      setCursorIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setCursorIdle(true), CURSOR_HIDE_MS);
    };
    document.addEventListener("mousemove", onMove);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousemove", onMove);
    };
  }, [full]);

  const serverDown = failedPolls >= SERVER_DOWN_AFTER;
  const fontScale = board ? FONT_SCALE[board.config.font_scale] : 1;
  const views = (board?.config.panels ?? []).map((p) => {
    const ps = status?.panels.find((x) => x.panel_id === p.id);
    const latest = ps && ps.results.length > 0 ? ps.results[ps.results.length - 1] : undefined;
    const state: PanelState = status
      ? panelState({
          latest,
          nowMs: status.now_ms,
          startedAtMs: status.started_at_ms,
          enabled: status.enabled,
          serverDown,
          intervalSec: p.interval_seconds,
          timeoutSec: p.timeout_seconds,
          thresholds: p.thresholds,
        })
      : serverDown
        ? "stale"
        : "pending";
    return { p, ps, latest, state };
  });
  // Settings + viewport only — never live results (spec §7.3).
  const scaleKey = [
    viewport,
    full ? "full" : "win",
    fontScale,
    ...(board?.config.panels ?? []).map((p) => `${p.id}|${p.title}|${p.timeout_seconds}`),
  ].join("\n");
  probeCount.current = board?.config.panels.length ?? 0;
  useLayoutEffect(() => {
    probeOk.current.clear();
    reasonNeeds.current.clear();
    searchRef.current = SEARCH_START;
    setSearch(SEARCH_START);
  }, [scaleKey]);

  if (isNotFound(statusQ.error) || boardNotFound) {
    return <FullScreenMessage>{ko.monitor.notFound}</FullScreenMessage>;
  }
  if (!board) {
    return (
      <FullScreenMessage>
        {boardQ.error ? ko.monitor.loadError(boardQ.error.message) : ko.monitor.loading}
      </FullScreenMessage>
    );
  }

  const panels = board.config.panels;
  const intervals = new Set(panels.map((p) => p.interval_seconds));
  const sameInterval = intervals.size <= 1;

  let lastAt: number | null = null;
  for (const ps of status?.panels ?? []) {
    const r = ps.results[ps.results.length - 1];
    if (r && (lastAt === null || r.at_ms > lastAt)) lastAt = r.at_ms;
  }
  const lastCheck =
    lastAt === null ? ko.monitor.lastCheckNone : ko.monitor.lastCheck(formatHms(lastAt));
  const headerRight =
    sameInterval && panels.length > 0
      ? `${lastCheck} · ${ko.monitor.everyN(panels[0].interval_seconds)}`
      : lastCheck;

  const gridOf = (n: number): React.CSSProperties => {
    const { cols, rows } = gridFor(n);
    return {
      display: "grid",
      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      gap: "1vw",
    };
  };
  const gridStyle: React.CSSProperties = { ...gridOf(panels.length), padding: "1vw" };
  const layout: FocusLayout =
    board.config.display_style === "focus"
      ? focusLayout(views.map((v) => v.state))
      : { kind: "grid" };
  const mainStyle: React.CSSProperties =
    layout.kind === "focus"
      ? {
          display: "grid",
          gap: "1vw",
          padding: "1vw",
          ...(layout.side === "right"
            ? { gridTemplateColumns: "3fr 1fr", gridTemplateRows: "minmax(0, 1fr)" }
            : { gridTemplateRows: "3fr 1fr", gridTemplateColumns: "minmax(0, 1fr)" }),
        }
      : gridStyle;
  const renderPanel = (v: (typeof views)[number]) => (
    <MonitorPanel
      key={v.p.id}
      panel={v.p}
      status={v.ps}
      state={v.state}
      fontScale={fontScale}
      blinkOn={blinks(board.config.blink, v.state)}
      showInterval={!sameInterval}
      fit={fit}
      reasonFit={reasonFit}
      displayStyle={board.config.display_style}
    />
  );

  return (
    <div
      data-testid="monitor-display"
      className="fixed inset-0 flex flex-col overflow-hidden"
      style={{
        background: COLOR.bg,
        color: COLOR.text,
        fontFamily: FONT_FAMILY,
        cursor: full && cursorIdle ? "none" : undefined,
      }}
    >
      <header
        className="flex shrink-0 items-baseline justify-between gap-[2vw] whitespace-nowrap"
        style={{
          padding: "0.8vw 1.6vw",
          fontSize: `${+(2.4 * fontScale).toFixed(3)}vw`,
          color: COLOR.muted,
          borderBottom: "0.15vw solid #1f2a36",
        }}
      >
        <span className="min-w-0 truncate font-bold" style={{ color: COLOR.text }}>
          {board.name}
        </span>
        <span className="flex shrink-0 items-baseline gap-[1.2vw]">
          {serverDown && (
            <span className="font-bold" style={{ color: COLOR.fail }}>
              {ko.monitor.serverDown}
            </span>
          )}
          <span>{headerRight}</span>
        </span>
      </header>
      <main className="relative min-h-0 flex-1" style={mainStyle}>
        {layout.kind === "focus" ? (
          <>
            <div className="min-h-0 min-w-0" style={gridOf(layout.big.length)}>
              {layout.big.map((i) => renderPanel(views[i]))}
            </div>
            <div
              className="min-h-0 min-w-0"
              style={{
                display: "grid",
                gap: "1vw",
                ...(layout.side === "right"
                  ? {
                      gridTemplateColumns: "minmax(0, 1fr)",
                      gridTemplateRows: `repeat(${layout.strip.length}, minmax(0, 1fr))`,
                    }
                  : {
                      gridTemplateRows: "minmax(0, 1fr)",
                      gridTemplateColumns: `repeat(${layout.strip.length}, minmax(0, 1fr))`,
                    }),
              }}
            >
              {layout.strip.map((i) => (
                <StripCard
                  key={views[i].p.id}
                  panel={views[i].p}
                  state={views[i].state}
                  latest={views[i].latest}
                  fontScale={fontScale}
                  blinkOn={blinks(board.config.blink, views[i].state)}
                />
              ))}
            </div>
          </>
        ) : (
          views.map(renderPanel)
        )}
        {/* Size probes: the same grid, invisible, outside the panels. */}
        <div
          aria-hidden="true"
          className="pointer-events-none invisible absolute inset-0"
          style={gridStyle}
        >
          {panels.map((p) => (
            <PanelProbe
              key={p.id}
              panel={p}
              fontScale={fontScale}
              fit={search.cand}
              onMeasure={onProbe}
            />
          ))}
        </div>
      </main>
      {/* Windowed only: its own strip below the grid (in flow), so it never
          covers a panel; fullscreen has no toolbar and the grid takes it all. */}
      {!full && (
        <div
          data-testid="monitor-toolbar"
          className="flex shrink-0 items-center justify-end gap-2 text-sm"
          style={{ padding: "0 1vw 1vw" }}
        >
          <ToolButton onClick={() => enterFullscreen()}>{ko.monitor.toolbarFullscreen}</ToolButton>
          <ToolButton onClick={() => navigate(`/monitors/${id}`)}>
            {ko.monitor.toolbarSettings}
          </ToolButton>
          {status?.enabled !== false && (
            <ToolButton
              disabled={stopBusy}
              onClick={() => {
                // Polling continues after the stop; the next status shows stale_off.
                setStopError(null);
                setStopBusy(true);
                void stopBoard(id)
                  .then(
                    (b) => {
                      // Keep the settings page (same cache entry) from showing a stale "on".
                      qc.setQueryData(monitorKey(id), b);
                      void qc.invalidateQueries({ queryKey: MONITOR_LIST_KEY });
                      // Don't abort an in-flight poll (it would count as a failed poll).
                      return refetchStatus({ cancelRefetch: false });
                    },
                    (e: unknown) => setStopError(e instanceof Error ? e.message : String(e)),
                  )
                  .finally(() => setStopBusy(false));
              }}
            >
              {ko.monitor.stop}
            </ToolButton>
          )}
          {stopError && (
            <span role="alert" className="self-center text-red-300">
              {ko.monitor.stopError(stopError)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

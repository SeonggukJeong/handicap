import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getBoard, getBoardStatus, stopBoard, type Blink } from "../api/monitors";
import { enterFullscreen, exitFullscreen, isFullscreen } from "../monitor/fullscreen";
import { ApiError } from "../api/client";
import { MonitorPanel } from "../components/monitor/MonitorPanel";
import { FONT_SCALE, gridFor, panelState, type PanelState } from "../monitor/logic";
import { COLOR } from "../monitor/display";
import { formatHms } from "../monitor/time";
import { monitorKey } from "../monitor/keys";
import { ko } from "../i18n/ko";

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
  const [failedPolls, setFailedPolls] = useState(0);
  const [full, setFull] = useState(isFullscreen);
  const [cursorIdle, setCursorIdle] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

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

  const serverDown = failedPolls >= SERVER_DOWN_AFTER;
  const fontScale = FONT_SCALE[board.config.font_scale];
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

  const { cols, rows } = gridFor(panels.length);

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
      <main
        className="min-h-0 flex-1"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          gap: "1vw",
          padding: "1vw",
        }}
      >
        {panels.map((p) => {
          const ps = status?.panels.find((x) => x.panel_id === p.id);
          const latest =
            ps && ps.results.length > 0 ? ps.results[ps.results.length - 1] : undefined;
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
          return (
            <MonitorPanel
              key={p.id}
              panel={p}
              status={ps}
              state={state}
              fontScale={fontScale}
              blinkOn={blinks(board.config.blink, state)}
              showInterval={!sameInterval}
            />
          );
        })}
      </main>
      {!full && (
        <div className="fixed bottom-4 right-4 flex gap-2 text-sm">
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
                    () => refetchStatus(),
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

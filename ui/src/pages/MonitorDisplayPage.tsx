import { useEffect, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getBoard, getBoardStatus } from "../api/monitors";
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

const FONT_FAMILY = '"Pretendard", "Noto Sans KR", system-ui, sans-serif';

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

export function MonitorDisplayPage() {
  const { id = "" } = useParams();
  const [failedPolls, setFailedPolls] = useState(0);

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
      className="fixed inset-0 flex flex-col overflow-hidden"
      style={{ background: COLOR.bg, color: COLOR.text, fontFamily: FONT_FAMILY }}
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
              blinkOn={false}
              showInterval={!sameInterval}
            />
          );
        })}
      </main>
    </div>
  );
}

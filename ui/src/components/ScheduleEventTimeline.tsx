import { Link } from "react-router-dom";
import { useScheduleEvents } from "../api/hooks";
import { ko } from "../i18n/ko";
import { VerdictBadge } from "./VerdictBadge";

const KIND_STYLE: Record<string, string> = {
  fired: "bg-green-100 text-green-800",
  skipped_overlap: "bg-amber-100 text-amber-800",
  missed: "bg-orange-100 text-orange-800",
  error: "bg-red-100 text-red-800",
};

type Props = { scheduleId: string };

export function ScheduleEventTimeline({ scheduleId }: Props) {
  const events = useScheduleEvents(scheduleId);

  return (
    <section aria-label={ko.schedule.eventsAria} className="mt-4">
      <h4 className="text-sm font-semibold text-slate-700 mb-2">이벤트 이력</h4>
      {events.isLoading && <p className="text-slate-500 text-sm">{ko.common.loading}</p>}
      {events.error && (
        <p role="alert" className="text-red-600 text-sm">
          이벤트 로드 실패: {(events.error as Error).message}
        </p>
      )}
      {events.data && events.data.length === 0 && (
        <p className="text-slate-400 text-sm">아직 발사 이력이 없습니다.</p>
      )}
      {events.data && events.data.length > 0 && (
        <ul className="flex flex-col gap-2">
          {events.data.map((e) => (
            <li key={e.id} className="flex items-start gap-2 text-sm">
              <span
                className={`rounded px-1.5 py-0.5 text-xs ${KIND_STYLE[e.kind] ?? "bg-slate-100 text-slate-700"}`}
              >
                {e.kind}
              </span>
              <span className="text-slate-500 whitespace-nowrap">
                {new Date(e.at).toLocaleString()}
              </span>
              {e.run_id && (
                <Link to={`/runs/${e.run_id}`} className="text-accent-600 hover:underline">
                  리포트 →
                </Link>
              )}
              {e.run_id && <VerdictBadge verdict={e.verdict} />}
              {e.detail && <span className="text-slate-600">{e.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

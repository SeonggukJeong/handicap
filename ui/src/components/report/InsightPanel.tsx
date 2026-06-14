import type { Insight } from "../../api/schemas";
import { ko } from "../../i18n/ko";

// `as const` 객체는 string 키 인덱싱이 안 되므로 lookup용 넓힌 뷰를 한 번 만든다.
const ACTIONS: Record<string, string | undefined> = ko.insightActions;

type StepMeta = { id: string; name: string; method: string; url: string };
type Props = { insights: Insight[]; meta: Map<string, StepMeta> };

const SEV_CLASS: Record<string, string> = {
  critical: "border-red-300 bg-red-50 text-red-800",
  warning: "border-amber-300 bg-amber-50 text-amber-800",
  info: "border-slate-300 bg-slate-50 text-slate-700",
};

function pctStr(v: number | undefined): string {
  return v === undefined ? "" : `${(v * 100).toFixed(1)}%`;
}

// 천단위 구분 — locale 고정(CI ICU 빌드 무관, RTL "1,203건" 단언).
function n(v: number | undefined): string {
  return (v ?? 0).toLocaleString("en-US");
}

function message(i: Insight, meta: Map<string, StepMeta>): string {
  const name = (id?: string) => (id ? (meta.get(id)?.name ?? id) : "");
  switch (i.kind) {
    case "slo_failure":
      return `SLO 실패: ${i.count ?? 0}개 기준 미달`;
    case "slo_pass":
      return "모든 SLO 기준 통과";
    case "status_class":
      return `${i.status_class}가 응답의 ${pctStr(i.pct)} (${n(i.count)}건)`;
    case "status_temporal":
      return `5xx가 마지막 ${i.window_seconds ?? 0}초에 처음 등장`;
    case "no_request_step":
      return `스텝 ${name(i.step_id)}에 요청이 기록되지 않음`;
    case "error_hotspot":
      return `스텝 ${name(i.step_id)}이(가) 에러의 ${pctStr(i.pct)} (${n(i.count)}건)`;
    case "slowest_step":
      return `스텝 ${name(i.step_id)}이(가) p95 ${n(i.value)}ms로 가장 느림`;
    case "load_gen_saturated":
      return `목표한 부하를 다 걸지 못했어요 — 초당 최대 ${n(i.value)}건까지만 보냈고, 보내려다 못 보낸 요청이 ${n(i.count)}건 있어요`;
    default:
      return i.kind;
  }
}

function actionFor(i: Insight): string | undefined {
  if (i.kind === "load_gen_saturated") {
    if (i.cause === "slots") return ko.saturation.slots(n(i.recommended));
    if (i.cause === "capacity") return ko.saturation.capacity;
    return ko.insightActions.load_gen_saturated; // 폴백(A9 일반)
  }
  return ACTIONS[i.kind];
}

export function InsightPanel({ insights, meta }: Props) {
  if (insights.length === 0) return null;
  return (
    <section aria-label="Insights" className="mb-6">
      <h3 className="text-lg font-semibold mb-2">핵심 인사이트</h3>
      <ul className="space-y-1">
        {insights.map((i, idx) => (
          <li
            key={`${i.kind}-${i.step_id ?? i.status_class ?? idx}`}
            data-testid="insight"
            className={[
              "rounded border px-3 py-1.5 text-sm",
              SEV_CLASS[i.severity] ?? SEV_CLASS.info,
            ].join(" ")}
          >
            <div>{message(i, meta)}</div>
            {(() => {
              const action = actionFor(i);
              return action ? (
                <div className="mt-0.5 text-xs opacity-90">
                  <span aria-hidden="true">→ </span>
                  {action}
                </div>
              ) : null;
            })()}
          </li>
        ))}
      </ul>
    </section>
  );
}

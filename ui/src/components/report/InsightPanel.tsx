import type { Insight } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { PageSection } from "../ui/PageSection";
import { floorPct } from "./format";

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
  return v === undefined ? "" : floorPct(v * 100);
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
    case "load_gen_saturated": {
      const head =
        `목표한 부하를 다 걸지 못했어요 — 초당 최대 ${n(i.value)}건까지만 보냈어요` +
        `(= 이 구성의 지속 가능한 최대 RPS). 보내려다 못 보낸 요청이 ${n(i.count)}건 있어요`;
      return i.onset_second != null ? `${head} (약 ${i.onset_second}초 지점부터 포화)` : head;
    }
    default:
      return i.kind;
  }
}

// 도착률 표시: 소수 1자리, 정수면 정수로 (초보자 가독).
function rate(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function actionFor(i: Insight): string | undefined {
  if (i.kind === "load_gen_saturated") {
    if (i.cause === "slots") {
      const x = i.target_per_sec;
      const y = i.achieved_per_sec;
      if (x != null && y != null && i.recommended != null) {
        const base = ko.saturation.slots(
          rate(x),
          rate(y),
          rate(Math.max(0, x - y)),
          n(i.recommended),
        );
        return i.recommended >= 10_000 ? `${base} ${ko.saturation.slotsAtCap}` : base;
      }
      return ko.insightActions.load_gen_saturated; // 방어(신규 필드 부재 — 구식 리포트)
    }
    if (i.cause === "sut") return ko.saturation.sut;
    return ko.insightActions.load_gen_saturated; // 폴백(cause None)
  }
  return ACTIONS[i.kind];
}

export function InsightPanel({ insights, meta }: Props) {
  if (insights.length === 0) return null;
  return (
    <PageSection ariaLabel={ko.report.insightsLabel} title={ko.report.insightsTitle}>
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
    </PageSection>
  );
}

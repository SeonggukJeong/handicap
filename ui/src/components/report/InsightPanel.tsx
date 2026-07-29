import { useState } from "react";
import type { Insight } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { readShowInsightActions, writeShowInsightActions } from "../../report/insightPrefs";
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
    case "slowest_step": {
      const ru = i.runner_up_ms;
      const v = i.value ?? 0;
      // 구식 리포트(필드 부재)는 기존 문구로 폴백
      if (ru == null) return `스텝 ${name(i.step_id)}이(가) p95 ${n(i.value)}ms로 가장 느림`;
      const gap = Math.max(0, v - ru);
      // ru === 0이면 v/ru가 Infinity가 되므로 배수를 생략한다
      const ratio = ru > 0 ? (v / ru).toFixed(1) : null;
      return ko.report.slowestStep(name(i.step_id), n(v), n(Math.round(gap)), ratio);
    }
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

type Action = { text: string; computed: boolean };

// computed=true는 측정값·계산된 권장치(ko.saturation.*)라 토글과 무관하게 항상 표시한다.
// sut arm은 "슬롯을 늘리지 말라"는 역방향 경고라 숨기면 위험하다.
function actionFor(i: Insight): Action | undefined {
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
        return {
          text: i.recommended >= 10_000 ? `${base} ${ko.saturation.slotsAtCap}` : base,
          computed: true,
        };
      }
      return { text: ko.insightActions.load_gen_saturated, computed: false }; // 방어(신규 필드 부재 — 구식 리포트)
    }
    if (i.cause === "sut") return { text: ko.saturation.sut, computed: true };
    return { text: ko.insightActions.load_gen_saturated, computed: false }; // 폴백(cause None)
  }
  const genericAction = ACTIONS[i.kind];
  return genericAction ? { text: genericAction, computed: false } : undefined;
}

export function InsightPanel({ insights, meta }: Props) {
  const [showGeneric, setShowGeneric] = useState(readShowInsightActions);
  if (insights.length === 0) return null;
  return (
    <PageSection ariaLabel={ko.report.insightsLabel} title={ko.report.insightsTitle}>
      {/* PageSection의 title(h3)이 이미 mb-2로 아래쪽 간격을 준다 — 여기서 또 mb-2를
          주면 제목↔토글 사이 간격이 이중으로 쌓인다(리뷰 finding). 단일 간격만 유지. */}
      <div className="flex justify-end">
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={showGeneric}
            onChange={(e) => {
              setShowGeneric(e.target.checked);
              writeShowInsightActions(e.target.checked);
            }}
          />
          {ko.report.insightActionsToggle}
        </label>
      </div>
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
              if (!action || (!action.computed && !showGeneric)) return null;
              return (
                <div className="mt-0.5 text-xs opacity-90">
                  <span aria-hidden="true">→ </span>
                  {action.text}
                </div>
              );
            })()}
          </li>
        ))}
      </ul>
    </PageSection>
  );
}

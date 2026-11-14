import { ko } from "../../i18n/ko";
import { PageSection } from "../ui/PageSection";
import { floorPct } from "./format";
import type { LoopExitRow, LoopExitRowKind, LoopExitView } from "./loopExitView";

// 막대 바탕(slate-100) 대비 3:1 이상 — 라이브 실측으로 정함(2026-11-14). 바꿀 때는 테스트의 대비 단언을 함께 본다.
const FILL: Record<LoopExitRowKind, string> = {
  first: "#475569", // slate-600 — 차분한 색
  retried: "#ea580c", // orange-600 — 주의
  exhausted: "#b91c1c", // red-700 — 경고
  truncated: "#7f8ea3", // slate-400과 500 사이 — 바탕 대비 3:1
};

function rowLabel(r: LoopExitRow): string {
  const t = ko.report.loopExit;
  if (r.kind === "exhausted") return t.rowExhausted;
  if (r.kind === "truncated") return t.rowTruncated;
  return r.pass === null ? t.rowOver : t.rowNth(r.pass);
}

/** 막대 접근 이름에 넣을 분류 글자. 중단·마치지 못함 줄은 라벨이 곧 분류라 빈 문자열. */
function kindLabel(k: LoopExitRowKind): string {
  const t = ko.report.loopExit;
  if (k === "first") return t.kindFirst;
  if (k === "retried") return t.kindRetried;
  return "";
}

export function LoopExitPanel({ views }: { views: LoopExitView[] }) {
  if (views.length === 0) return null;
  const t = ko.report.loopExit;
  const n = (v: number) => v.toLocaleString("en-US");
  const kinds = new Set(views.flatMap((v) => v.rows.map((r) => r.kind)));
  return (
    <PageSection ariaLabel={t.panelLabel} title={t.panelTitle}>
      {views.map((v) => (
        <div key={v.stepId} className="mb-4 last:mb-0">
          <h4 className="mb-2 break-words text-sm font-semibold">
            {t.panelHeading(v.name, n(v.entered))}
          </h4>
          <div className="space-y-1">
            {v.rows.map((r) => {
              const label = rowLabel(r);
              const pct = floorPct(r.pct);
              return (
                <div key={`${r.kind}-${r.pass ?? "x"}`}>
                  <div className="flex items-center gap-3 text-sm">
                    <div
                      data-testid="loop-exit-row-label"
                      className="w-24 shrink-0 whitespace-nowrap"
                    >
                      {label}
                    </div>
                    <div
                      role="img"
                      aria-label={t.barLabel(label, kindLabel(r.kind), n(r.count), pct)}
                      className="h-4 min-w-0 flex-1 overflow-hidden rounded bg-slate-100"
                    >
                      <span
                        className="block h-full"
                        style={{ width: `${r.pct}%`, backgroundColor: FILL[r.kind] }}
                      />
                    </div>
                    <div className="w-36 shrink-0 whitespace-nowrap text-right tabular-nums">
                      {t.rowValue(n(r.count), pct)}
                    </div>
                  </div>
                  {r.kind === "exhausted" && (
                    <p className="ml-[108px] text-xs text-slate-500">
                      {v.maxPasses === null
                        ? t.exhaustedNoteNoMax
                        : t.exhaustedNote(n(v.maxPasses))}
                    </p>
                  )}
                  {r.kind === "truncated" && (
                    <p className="ml-[108px] text-xs text-slate-500">{t.truncatedNote}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        {(["first", "retried", "exhausted", "truncated"] as const)
          .filter((k) => kinds.has(k))
          .map((k) => (
            <li key={k} className="flex items-center whitespace-nowrap">
              <span
                aria-hidden="true"
                className="mr-1 inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: FILL[k] }}
              />
              {k === "first"
                ? t.legendFirst
                : k === "retried"
                  ? t.legendRetried
                  : k === "exhausted"
                    ? t.rowExhausted
                    : t.rowTruncated}
            </li>
          ))}
      </ul>
    </PageSection>
  );
}

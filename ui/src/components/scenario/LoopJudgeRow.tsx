import type { StepTrace } from "../../api/schemas";
import { ko } from "../../i18n/ko";

const CHIP = "inline-block rounded px-2 py-0.5 text-xs font-medium break-all";

/** loop 판정 한 줄: `{loop 이름} · {n회차} · {again/done/exhausted 문구}`.
 *  시험 실행 패널·모니터 기록·미리 실행이 공유(IfRow와 같은 칩 이디엄). */
export function LoopJudgeRow({
  step,
  loopName,
  maxPasses,
}: {
  step: StepTrace;
  loopName: string;
  maxPasses: number | undefined;
}) {
  const pass = (step.loop_index ?? 0) + 1;
  const e = ko.editor;
  let text: string;
  let cls: string;
  if (step.branch === "again") {
    text = e.loopJudgeAgain;
    cls = "bg-violet-100 text-violet-800";
  } else if (step.branch === "exhausted") {
    text = e.loopJudgeExhausted(maxPasses ?? pass);
    cls = "bg-amber-100 text-amber-800";
  } else {
    text = e.loopJudgeDone;
    cls = "bg-violet-100 text-violet-800";
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={`${CHIP} bg-violet-200 text-violet-900`}>{loopName}</span>
      <span className="text-xs text-slate-400" aria-hidden="true">
        ·
      </span>
      <span className="text-xs text-slate-600">{e.loopJudgePass(pass)}</span>
      <span className="text-xs text-slate-400" aria-hidden="true">
        ·
      </span>
      <span className={`${CHIP} ${cls}`}>{text}</span>
    </div>
  );
}

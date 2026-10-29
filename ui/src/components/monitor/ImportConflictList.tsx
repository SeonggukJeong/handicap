import type { BoardAnalysis } from "../../api/monitorTransfer";
import { ko } from "../../i18n/ko";

/** 겹침 줄 목록 — analyze 결과와 import 409 본문이 같은 모양이라 공용. conflict 보드만 그린다. */
export function ImportConflictList({ boards }: { boards: BoardAnalysis[] }) {
  const t = ko.monitor.transfer;
  const lines: string[] = [];
  for (const b of boards) {
    if (!b.conflict) continue;
    if (b.exists) lines.push(t.conflictBoard(b.name));
    for (const s of b.scenarios) {
      if (s.state === "different") lines.push(t.conflictScenario(s.name, b.name));
    }
    for (const e of b.environments) {
      if (e.state === "different") lines.push(t.conflictEnv(e.name, b.name));
    }
  }
  return (
    <ul className="max-h-64 list-disc space-y-1 overflow-auto pl-5 text-sm" tabIndex={0}>
      {lines.map((l, i) => (
        <li key={i} className="break-words">
          {l}
        </li>
      ))}
    </ul>
  );
}

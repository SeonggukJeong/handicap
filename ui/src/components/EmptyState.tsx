import type { ReactNode } from "react";

/** 빈 상태 3요소(무엇 + 언제 + 다음 행동) 공통 래퍼 (U2, spec §3.2). */
export function EmptyState({ body, action }: { body: string; action?: ReactNode }) {
  return (
    <div className="text-sm text-slate-500">
      <p>{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

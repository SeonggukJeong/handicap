import type { ReactNode } from "react";
import { Badge } from "./Badge";

export function Field({
  label,
  htmlFor,
  recommended,
  help,
  hint,
  hintId,
  error,
  errorId,
  children,
}: {
  label: ReactNode;
  htmlFor: string;
  recommended?: ReactNode;
  help?: ReactNode;
  hint?: ReactNode;
  /** hint <p>의 id — aria-describedby 연결용(errorId와 대칭).
      이 id를 describedby에 참조하는 caller는 hint를 무조건 렌더할 것(조건부 hint + 상시 참조 = dangling). */
  hintId?: string;
  error?: ReactNode;
  errorId?: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-3">
      {/* Badge/HelpTip은 <label htmlFor> *밖* 형제 — label 안에 넣으면 컨트롤 accname 오염(U3). */}
      <div className="mb-1 flex items-center gap-1.5 text-sm text-slate-700">
        <label htmlFor={htmlFor}>{label}</label>
        {recommended != null && <Badge tone="accent">{recommended}</Badge>}
        {help}
      </div>
      {children}
      {hint != null && (
        <p id={hintId} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      )}
      {error != null && (
        <p id={errorId} className="mt-1 text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

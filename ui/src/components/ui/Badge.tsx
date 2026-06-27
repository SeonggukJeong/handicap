import type { ReactNode } from "react";

const TONES = {
  neutral: "bg-slate-100 text-slate-600",
  accent: "bg-accent-50 text-accent-700",
  required: "bg-slate-800 text-white",
  optional: "bg-slate-100 text-slate-500",
  warn: "bg-amber-100 text-amber-800",
} as const;

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: keyof typeof TONES;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

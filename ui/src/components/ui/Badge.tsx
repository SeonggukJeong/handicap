import type { ReactNode } from "react";

const TONES = {
  neutral: "bg-slate-100 text-slate-600",
  accent: "bg-accent-50 text-accent-700",
  required: "bg-slate-800 text-white",
  optional: "bg-slate-100 text-slate-500",
  warn: "bg-amber-100 text-amber-800",
} as const;

// 리터럴 맵 필수 — `font-${weight}` 템플릿은 Tailwind JIT가 클래스를 못 봄 (spec R2).
const WEIGHTS = {
  semibold: "font-semibold",
  medium: "font-medium",
} as const;

export function Badge({
  tone = "neutral",
  weight = "semibold",
  className,
  children,
}: {
  tone?: keyof typeof TONES;
  weight?: keyof typeof WEIGHTS;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs ${WEIGHTS[weight]} ${TONES[tone]}${className ? ` ${className}` : ""}`}
    >
      {children}
    </span>
  );
}

import type { ReactNode } from "react";

const VARIANTS = {
  info: "border-accent-200 bg-accent-50 text-accent-800",
  warn: "border-amber-300 bg-amber-50 text-amber-800",
  error: "border-red-200 bg-red-50 text-red-700",
} as const;

export function Callout({
  variant = "info",
  role,
  title,
  className,
  children,
}: {
  variant?: keyof typeof VARIANTS;
  role?: string;
  title?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role={role}
      className={`rounded-md border p-2 text-sm ${VARIANTS[variant]} ${className ?? ""}`}
    >
      {title != null && <p className="mb-1 font-medium">{title}</p>}
      {children}
    </div>
  );
}

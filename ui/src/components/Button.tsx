import { type ButtonHTMLAttributes, type ReactNode } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
  children: ReactNode;
};

const STYLES: Record<NonNullable<Props["variant"]>, string> = {
  primary: "bg-accent-600 text-white hover:bg-accent-700 disabled:bg-accent-300",
  secondary:
    "bg-white text-slate-900 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400",
  danger: "bg-red-600 text-white hover:bg-red-500 disabled:bg-red-300",
};

export function Button({ variant = "primary", className, children, ...rest }: Props) {
  return (
    <button
      {...rest}
      className={[
        "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors",
        STYLES[variant],
        className ?? "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

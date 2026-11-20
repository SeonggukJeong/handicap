import { type ButtonHTMLAttributes, type ReactNode } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
  /** "sm" = 띠·툴바 안의 낮은 버튼. 없으면 기존 크기. */
  size?: "sm";
  children: ReactNode;
};

const PAD = { md: "px-4 py-2", sm: "px-3 py-1.5" } as const;

const STYLES: Record<NonNullable<Props["variant"]>, string> = {
  primary: "bg-accent-600 text-white hover:bg-accent-700 disabled:bg-accent-300",
  secondary:
    "bg-white text-slate-900 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400",
  danger: "bg-red-600 text-white hover:bg-red-500 disabled:bg-red-300",
};

export function Button({ variant = "primary", size, className, children, ...rest }: Props) {
  return (
    <button
      {...rest}
      className={[
        `inline-flex items-center justify-center rounded-md ${PAD[size ?? "md"]} text-sm font-medium transition-colors`,
        STYLES[variant],
        className ?? "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

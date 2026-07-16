import { forwardRef, type InputHTMLAttributes } from "react";

const BASE =
  "block w-full rounded-md border border-slate-300 px-2 text-slate-900 " +
  "focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/30 " +
  "aria-[invalid=true]:border-red-400 aria-[invalid=true]:ring-red-400/30 " +
  "disabled:bg-slate-50 disabled:text-slate-400";

const PAD = { normal: "py-1", compact: "py-0.5" } as const;
const SIZE = { md: "text-sm", sm: "text-xs" } as const;

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  numeric?: boolean;
  size?: "sm";
  compact?: boolean;
};

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { className, numeric, size, compact, ...rest },
  ref,
) {
  const base = `${BASE} ${PAD[compact ? "compact" : "normal"]} ${SIZE[size ?? "md"]}${
    numeric ? " tabular-nums" : ""
  }`;
  return <input ref={ref} className={`${base} ${className ?? ""}`} {...rest} />;
});

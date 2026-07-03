import { forwardRef, type InputHTMLAttributes } from "react";

const BASE =
  "block w-full rounded-md border border-slate-300 px-2 py-1 text-slate-900 " +
  "focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/30 " +
  "aria-[invalid=true]:border-red-400 aria-[invalid=true]:ring-red-400/30 " +
  "disabled:bg-slate-50 disabled:text-slate-400";

const SIZE = { md: "text-sm", sm: "text-xs" } as const;

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  numeric?: boolean;
  size?: "sm";
};

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { className, numeric, size, ...rest },
  ref,
) {
  const base = `${BASE} ${SIZE[size ?? "md"]}${numeric ? " tabular-nums" : ""}`;
  return <input ref={ref} className={`${base} ${className ?? ""}`} {...rest} />;
});

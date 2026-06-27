import { forwardRef, type InputHTMLAttributes } from "react";

const BASE =
  "block w-full rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900 " +
  "focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/30 " +
  "aria-[invalid=true]:border-red-400 aria-[invalid=true]:ring-red-400/30 " +
  "disabled:bg-slate-50 disabled:text-slate-400";

type Props = InputHTMLAttributes<HTMLInputElement> & { numeric?: boolean };

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { className, numeric, ...rest },
  ref,
) {
  const base = numeric ? `${BASE} tabular-nums` : BASE;
  return <input ref={ref} className={`${base} ${className ?? ""}`} {...rest} />;
});

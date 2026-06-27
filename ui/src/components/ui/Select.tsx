import { forwardRef, type SelectHTMLAttributes } from "react";

const BASE =
  "block w-full rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900 " +
  "focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/30 " +
  "disabled:bg-slate-50 disabled:text-slate-400";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={`${BASE} ${className ?? ""}`} {...rest}>
        {children}
      </select>
    );
  },
);

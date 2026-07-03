import { forwardRef, type SelectHTMLAttributes } from "react";

const BASE =
  "block w-full rounded-md border border-slate-300 px-2 py-1 text-slate-900 " +
  "focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/30 " +
  "disabled:bg-slate-50 disabled:text-slate-400";

const SIZE = { md: "text-sm", sm: "text-xs" } as const;

type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & { size?: "sm" };

export const Select = forwardRef<HTMLSelectElement, Props>(function Select(
  { className, children, size, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={`${BASE} ${SIZE[size ?? "md"]} ${className ?? ""}`} {...rest}>
      {children}
    </select>
  );
});

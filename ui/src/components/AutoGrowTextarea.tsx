import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

/**
 * Controlled textarea that grows to fit its content (1 row when short, taller as
 * the value wraps) so long values — JWT tokens, URLs, JSON — are fully visible.
 * Caps at `max-h-40` then scrolls internally. jsdom reports scrollHeight 0, so the
 * auto-grow is a no-op in tests (value/onChange still work); the visual height is
 * verified live.
 */
export function AutoGrowTextarea({
  value,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      className={`block w-full resize-none overflow-y-auto max-h-40 ${className ?? ""}`}
      {...rest}
    />
  );
}

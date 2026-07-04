import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";
import { Textarea } from "./ui/Textarea";

/**
 * Controlled textarea that grows to fit its content (1 row when short, taller as
 * the value wraps) so long values — JWT tokens, URLs, JSON — are fully visible.
 * Caps at `max-h-40` then scrolls internally. jsdom reports scrollHeight 0, so the
 * auto-grow is a no-op in tests (value/onChange still work); the visual height is
 * verified live. Composes the `Textarea` primitive (accent focus ring).
 */
export function AutoGrowTextarea({
  value,
  className,
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "size"> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const full = el.scrollHeight;
    const MAX = 160; // max-h-40
    el.style.height = `${Math.min(full, MAX)}px`;
    el.style.overflowY = full > MAX ? "auto" : "hidden"; // 캡 넘칠 때만 스크롤(1줄=바 없음)
  }, [value]);
  return (
    <Textarea
      ref={ref}
      value={value}
      rows={1}
      className={`resize-none max-h-40 ${className ?? ""}`}
      {...rest}
    />
  );
}

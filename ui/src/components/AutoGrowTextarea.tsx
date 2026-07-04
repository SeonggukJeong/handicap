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
    const MAX = 160; // max-h-40
    const resize = () => {
      el.style.height = "auto";
      const full = el.scrollHeight;
      el.style.height = `${Math.min(full, MAX)}px`;
      el.style.overflowY = full > MAX ? "auto" : "hidden"; // 캡 넘칠 때만 스크롤(1줄=바 없음)
    };
    resize();
    // 폭이 바뀌면(예: 변수 넓게 보기 토글로 열이 넓어짐) 같은 값이 더 적은/많은 줄로
    // 재배치되므로 높이를 다시 계산한다. value만 dep면 폭 변화에 안 따라와 좁을 때의
    // 여러 줄 높이가 stale하게 남는다(#varsWide). 높이 자체를 바꾸면 ResizeObserver가
    // 또 발화하므로 *너비*가 실제로 바뀔 때만 재계산해 되먹임 루프를 막는다.
    let lastWidth = -1;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w !== lastWidth) {
        lastWidth = w;
        resize();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
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

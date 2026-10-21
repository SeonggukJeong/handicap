import { useLayoutEffect, useRef, type CSSProperties } from "react";

/**
 * One line of text at `fontSize` that never overflows its width: when the
 * natural line is wider than the box, the font is scaled down just enough
 * (extreme values only — e.g. a long fixed reason or `600,000 ms` in a 3x3
 * panel). Font size is applied through the DOM so React never resets it.
 */
export function FitLine({
  text,
  fontSize,
  className = "",
  style,
}: {
  text: string;
  fontSize: string;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.fontSize = fontSize;
      const natural = el.scrollWidth;
      const box = el.clientWidth;
      if (box > 0 && natural > box + 0.5) {
        el.style.fontSize = `calc(${fontSize} * ${((box / natural) * 0.98).toFixed(4)})`;
      }
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    // Re-fit when the box resizes or the inherited --fit changes the height.
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, fontSize]);
  return (
    <div ref={ref} className={`overflow-hidden whitespace-nowrap ${className}`} style={style}>
      {text}
    </div>
  );
}

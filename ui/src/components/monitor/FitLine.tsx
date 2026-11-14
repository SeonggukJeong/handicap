import type { CSSProperties } from "react";

/**
 * One line of text that never wraps. It does not scale itself: the panel
 * measures every `[data-fit-line]` and, when one is wider than its box, asks the
 * board for a smaller uniform scale (spec §7.3 — all panels share one scale).
 * Below the scale floor the overflow ends in `…` rather than being cut.
 */
export function FitLine({
  text,
  fontSize,
  className = "",
  style,
  title,
}: {
  text: string;
  fontSize: string;
  className?: string;
  style?: CSSProperties;
  /** 잘렸을 때 전체 글자를 볼 수 있는 툴팁(선택). */
  title?: string;
}) {
  return (
    <div
      data-fit-line=""
      title={title}
      className={`overflow-hidden text-ellipsis whitespace-nowrap ${className}`}
      style={{ ...style, fontSize }}
    >
      {text}
    </div>
  );
}

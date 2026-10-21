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
}: {
  text: string;
  fontSize: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      data-fit-line=""
      className={`overflow-hidden text-ellipsis whitespace-nowrap ${className}`}
      style={{ ...style, fontSize }}
    >
      {text}
    </div>
  );
}

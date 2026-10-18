/** HelpTip popover 폭(px) — 기존 `w-56`과 같은 값. */
export const TIP_WIDTH_PX = 224;
const MARGIN = 8;
const GAP = 4;

/** HelpTip popover의 fixed 좌표(spec §3.1). 기본은 앵커 아래·좌단 정렬, 우단을 넘치면
 *  앵커 우단 정렬(기존 right-0 edge-flip과 같은 의미), 좌우는 8px 여백 clamp. 아래 공간이
 *  부족하면 위로, 둘 다 부족하면 뷰포트 하단에 맞춘다(top 최소 8). VarUsagePopover
 *  `computePos`와 같은 이디엄 — 순수 함수라 레이아웃 없는 jsdom에서도 단위 테스트한다. */
export function computeTipPos(
  anchor: { top: number; bottom: number; left: number; right: number },
  popH: number,
  vp: { width: number; height: number },
): { top: number; left: number } {
  let left =
    anchor.left + TIP_WIDTH_PX > vp.width - MARGIN ? anchor.right - TIP_WIDTH_PX : anchor.left;
  left = Math.max(MARGIN, Math.min(left, vp.width - TIP_WIDTH_PX - MARGIN));
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - popH;
  let top: number;
  if (below + popH <= vp.height - MARGIN) top = below;
  else if (above >= MARGIN) top = above;
  else top = vp.height - popH - MARGIN;
  return { top: Math.max(MARGIN, top), left };
}

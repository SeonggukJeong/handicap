import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { computeTipPos, TIP_WIDTH_PX } from "../helpTipPos";

// clientWidth/Height는 페이지 스크롤바를 제외 — jsdom 등 0을 주는 환경은 inner*로 폴백(HelpTip과 같다).
const viewport = () => ({
  width: document.documentElement.clientWidth || window.innerWidth,
  height: document.documentElement.clientHeight || window.innerHeight,
});

/**
 * `Segmented` 선택지 설명 툴팁. HelpTip 패널과 같은 모양·자리 계산(`computeTipPos`)이고,
 * 가장 가까운 `[role=dialog][aria-modal=true]`(없으면 body)에 portal로 그린다.
 * 설명은 단추의 `aria-describedby`가 가리키는 숨은 글자가 읽어 주므로 `aria-hidden`이다.
 * 마우스가 단추에서 툴팁으로 옮겨 가도 열려 있도록 포인터 이벤트는 호출자가 받는다.
 */
export function OptionTip({
  anchor,
  children,
  onPointerEnter,
  onPointerLeave,
}: {
  anchor: HTMLElement;
  children: ReactNode;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const panelRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState(() =>
    computeTipPos(anchor.getBoundingClientRect(), 0, viewport()),
  );

  // 실측 높이로 위/아래 뒤집기 재계산(페인트 전).
  useLayoutEffect(() => {
    const h = panelRef.current?.getBoundingClientRect().height ?? 0;
    setPos(computeTipPos(anchor.getBoundingClientRect(), h, viewport()));
  }, [anchor]);

  const container =
    anchor.closest<HTMLElement>('[role="dialog"][aria-modal="true"]') ?? document.body;
  return createPortal(
    <span
      ref={panelRef}
      role="tooltip"
      aria-hidden="true"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={{ position: "fixed", top: pos.top, left: pos.left, width: TIP_WIDTH_PX, zIndex: 60 }}
      className="block whitespace-normal rounded-md border border-slate-200 bg-white p-2 text-left text-xs font-normal text-slate-700 shadow-lg"
    >
      {children}
    </span>,
    container,
  );
}

import { useEffect, useRef, useState } from "react";

/** 클릭 토글 popover 공통 로직 — ESC/외부 pointerdown 닫힘 + 뷰포트 우단 edge-flip.
 *  소비처: VerdictBadge(FAIL 사유). HelpTip은 2026-10-18부터 portal+fixed 자체 로직
 *  (HelpTip.tsx — 좁은 overflow 열 클립·Modal ESC 레이어링 해소)이라 이 훅을 쓰지 않는다.
 *
 *  주의(U1a 기록): Modal.tsx의 capture-phase keydown이 stopPropagation()하므로
 *  Modal 내부에서는 이 훅의 ESC 닫힘이 동작하지 않는다 — 현 소비처 VerdictBadge는 Modal 밖.
 *  Modal 안에서 쓰려면 HelpTip처럼 window capture로 ESC를 먼저 받을 것. */
export function usePopover(widthPx: number) {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  function toggle() {
    if (!open && rootRef.current) {
      const r = rootRef.current.getBoundingClientRect();
      setAlignRight(r.left + widthPx + 8 > window.innerWidth);
    }
    setOpen((v) => !v);
  }

  return { open, alignRight, rootRef, toggle };
}

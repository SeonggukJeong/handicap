import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { findStepById, summarizeCondition, type Step } from "../../scenario/model";
import { METHOD_BADGE } from "./methodBadge";
import { ko } from "../../i18n/ko";

const POPOVER_WIDTH = 240;
const POPOVER_MAX_H = 256; // max-h-64 와 lockstep

function computePos(anchor: HTMLElement) {
  const r = anchor.getBoundingClientRect();
  const left =
    r.left + POPOVER_WIDTH > window.innerWidth ? Math.max(8, r.right - POPOVER_WIDTH) : r.left;
  const below = r.bottom + 4;
  // 하단 넘치고 위에 공간 있으면 앵커 위로 flip (R2 하단 edge-flip, F3)
  const top =
    below + POPOVER_MAX_H > window.innerHeight && r.top > POPOVER_MAX_H
      ? r.top - 4 - POPOVER_MAX_H
      : below;
  return { top, left };
}

/** 변수 "N개 스텝에서 사용" 클릭 시 뜨는 사용처 목록 팝오버(#3) — 순환-nav 대체.
 *  Task 4가 변수 컬럼을 overflow-auto로 만들면 absolute 위치는 클리핑되므로
 *  Modal.tsx와 같은 패턴으로 fixed + createPortal(document.body)에 그린다.
 *  항목 클릭은 onJump만 부르고 팝오버는 유지(분기 usages 사이 이동) — 바깥
 *  pointerdown/ESC/바깥 스크롤만 onClose. */
export function VarUsagePopover({
  anchor,
  refIds,
  steps,
  selectedStepId,
  onJump,
  onClose,
}: {
  anchor: HTMLElement;
  refIds: string[];
  steps: Step[];
  selectedStepId: string | null;
  onJump: (id: string) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => computePos(anchor));
  useLayoutEffect(() => setPos(computePos(anchor)), [anchor]);
  // Modal.tsx와 동일 패턴: onClose를 ref에 보관해 매 렌더 새 클로저가 와도
  // 아래 리스너 effect는 anchor 변경 시에만 재구독(불필요한 churn 방지).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !anchor.contains(t)) onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    const onScroll = (e: Event) => {
      if (!panelRef.current?.contains(e.target as Node)) onCloseRef.current(); // 팝오버 내부 스크롤은 무시(F2)
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={ko.editor.varUsageListAria}
      style={{ position: "fixed", top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
      className="z-50 max-h-64 overflow-auto rounded-md border border-slate-200 bg-white p-1 text-xs shadow-lg"
    >
      {refIds.map((id) => {
        const s = findStepById(steps, id);
        const active = id === selectedStepId;
        return (
          <button
            key={id}
            type="button"
            role="menuitem"
            aria-current={active ? "true" : undefined}
            onClick={() => onJump(id)}
            className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-slate-100 ${active ? "bg-accent-50 text-accent-700" : "text-slate-700"}`}
          >
            {s?.type === "http" && (
              <span
                className={`shrink-0 rounded px-1 font-mono text-[10px] ${METHOD_BADGE[s.request.method] ?? "bg-slate-100 text-slate-600"}`}
              >
                {s.request.method}
              </span>
            )}
            {s?.type === "if" && (
              <span className="shrink-0 rounded bg-slate-100 px-1 font-mono text-[10px] text-slate-500">
                IF
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">
              {s ? (s.type === "if" ? summarizeCondition(s.cond) : s.name) : id}
            </span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

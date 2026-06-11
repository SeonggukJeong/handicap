import { useEffect, useId, useRef, useState, type ReactNode } from "react";

const POPOVER_WIDTH_PX = 224; // w-56 — 클래스와 lockstep

/**
 * 도움말(?) 버튼 클릭 토글 popover (spec 2026-06-11 UX §2.2, ADR-0035).
 * hover 전용 금지 — 터치·키보드 접근성. ESC/바깥 pointerdown으로 닫힘.
 * 용어 설명 본문은 ko.ts glossary를 children으로 넘겨 단일 소스를 유지한다.
 * children은 인라인 콘텐츠만(popover가 <span>이라 블록 요소 중첩 금지).
 * 열 때 뷰포트 우단을 넘치면 right-0로 자동 정렬(edge-flip).
 */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const id = useId();
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

  return (
    <span ref={rootRef} className="relative inline-block">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          if (!open && rootRef.current) {
            const r = rootRef.current.getBoundingClientRect();
            setAlignRight(r.left + POPOVER_WIDTH_PX + 8 > window.innerWidth);
          }
          setOpen((v) => !v);
        }}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 align-middle text-[10px] leading-none text-slate-500 hover:bg-slate-100"
      >
        ?
      </button>
      {open && (
        <span
          id={id}
          role="note"
          className={`absolute top-5 z-20 block w-56 whitespace-normal rounded-md border border-slate-200 bg-white p-2 text-left text-xs font-normal text-slate-700 shadow-lg ${alignRight ? "right-0" : "left-0"}`}
        >
          {children}
        </span>
      )}
    </span>
  );
}

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import { computeTipPos, TIP_WIDTH_PX } from "./helpTipPos";

const stop = (e: SyntheticEvent) => e.stopPropagation();
// clientWidth/Height는 페이지 스크롤바를 제외 — tip이 스크롤바 밑에 깔리지 않게.
// jsdom 등 0을 주는 환경은 inner*로 폴백.
const viewport = () => ({
  width: document.documentElement.clientWidth || window.innerWidth,
  height: document.documentElement.clientHeight || window.innerHeight,
});

/**
 * 도움말(?) 버튼 클릭 토글 popover (spec 2026-06-11 UX §2.2, ADR-0035).
 * hover 전용 금지 — 터치·키보드 접근성. 용어 설명 본문은 ko.ts glossary를 children으로
 * 넘겨 단일 소스를 유지한다. children은 인라인 콘텐츠만(popover가 <span>).
 *
 * popover는 portal + position:fixed(spec 2026-10-18 §3) — 좁은 `overflow-auto` 열(변수 목록
 * 등)에 잘리지 않는다. 컨테이너는 가장 가까운 `[role=dialog][aria-modal=true]`(모달 안이면
 * aria-modal 범위 안에 남아 SR이 읽는다) 또는 body. 전제: 그 컨테이너엔 transform/filter/
 * contain이 없다(있으면 fixed가 그 박스 기준이 된다 — Modal.tsx 패널은 해당 없음).
 * 닫힘: 버튼 재클릭 · 바깥 pointerdown · ESC(window capture라 Modal의 document capture보다
 * 먼저 — 모달 안에서도 tip만 닫는다) · 바깥 스크롤 · 리사이즈.
 */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  // null = 닫힘. 열 때 1회 계산해 둔다(렌더 중 ref 읽기 금지).
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);
  const id = useId();
  const open = container !== null;

  // 실측 높이로 위/아래 뒤집기 재계산(페인트 전).
  useLayoutEffect(() => {
    if (!open || !rootRef.current) return;
    const h = panelRef.current?.getBoundingClientRect().height ?? 0;
    setPos(computeTipPos(rootRef.current.getBoundingClientRect(), h, viewport()));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setContainer(null);
    const inPanel = (t: EventTarget | null) =>
      t instanceof Node && panelRef.current !== null && panelRef.current.contains(t);
    const inRoot = (t: EventTarget | null) =>
      t instanceof Node && rootRef.current !== null && rootRef.current.contains(t);
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    }
    function onPointerDown(e: PointerEvent) {
      if (!inPanel(e.target) && !inRoot(e.target)) close();
    }
    function onScroll(e: Event) {
      if (!inPanel(e.target)) close();
    }
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setContainer(null);
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    setPos(computeTipPos(root.getBoundingClientRect(), 0, viewport()));
    setContainer(root.closest<HTMLElement>('[role="dialog"][aria-modal="true"]') ?? document.body);
  };

  return (
    <span ref={rootRef} className="inline-block">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-describedby={open ? id : undefined}
        onClick={toggle}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 align-middle text-[10px] leading-none text-slate-500 hover:bg-slate-100"
      >
        ?
      </button>
      {container &&
        createPortal(
          <span
            ref={panelRef}
            id={id}
            role="note"
            onClick={stop}
            onMouseDown={stop}
            onPointerDown={stop}
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              width: TIP_WIDTH_PX,
              maxHeight: "calc(100vh - 16px)",
              overflowY: "auto",
              zIndex: 60,
            }}
            className="block whitespace-normal rounded-md border border-slate-200 bg-white p-2 text-left text-xs font-normal text-slate-700 shadow-lg"
          >
            {children}
          </span>,
          container,
        )}
    </span>
  );
}

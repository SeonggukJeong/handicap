import { useEffect, useRef, useState } from "react";

export type DownloadMenuItem = { label: string; onSelect: () => void };

/** WAI-ARIA menu-button: a trigger that opens a `role="menu"` popover of
 *  download actions. Keyboard: ArrowDown/Up/Enter/Space open & navigate,
 *  Enter/Space activates, Escape closes and returns focus to the trigger.
 *  Outside pointerdown / Tab also close. Menu behaviour only — actions and any
 *  error surface belong to the consumer (the items' onSelect). */
export function DownloadMenu({ label, items }: { label: string; items: DownloadMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Close when a pointer goes down outside the menu (mirrors usePopover).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Move DOM focus to the active item while open.
  useEffect(() => {
    if (open && activeIndex >= 0) itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  function closeAndFocusTrigger() {
    setOpen(false);
    setActiveIndex(-1);
    triggerRef.current?.focus();
  }

  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex(0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex(items.length - 1);
    }
  }

  function onItemKeyDown(e: React.KeyboardEvent, i: number) {
    const n = items.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i - 1 + n) % n);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(n - 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeAndFocusTrigger();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      items[i].onSelect();
      closeAndFocusTrigger();
    } else if (e.key === "Tab") {
      setOpen(false);
      setActiveIndex(-1);
    }
  }

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          setActiveIndex(-1);
        }}
        onKeyDown={onTriggerKeyDown}
        className="inline-flex items-center gap-1 rounded bg-slate-700 px-3 py-1.5 text-sm text-white hover:bg-slate-800"
      >
        {label}
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul
          role="menu"
          className="absolute right-0 z-20 mt-1 min-w-[8rem] rounded-md border border-slate-200 bg-white py-1 shadow-lg"
        >
          {items.map((item, i) => (
            <li role="none" key={item.label}>
              <button
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                role="menuitem"
                type="button"
                tabIndex={-1}
                onClick={() => {
                  item.onSelect();
                  closeAndFocusTrigger();
                }}
                onKeyDown={(e) => onItemKeyDown(e, i)}
                className="block w-full px-4 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none"
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

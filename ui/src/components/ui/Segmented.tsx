import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { OptionTip } from "./OptionTip";

type Option<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
  description?: ReactNode;
};

/** 마우스가 단추와 툴팁 둘 다에서 떠난 뒤 닫기까지(그 사이 다시 들어가면 취소). */
const CLOSE_DELAY_MS = 120;

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className = "",
  busy,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<Option<T>>;
  ariaLabel: string;
  className?: string;
  busy?: boolean;
}) {
  const baseId = useId();
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const closeTimer = useRef<number | null>(null);
  // 한 번에 하나만 — 열린 선택지와 그 단추(portal 앵커).
  const [open, setOpen] = useState<{ value: T; anchor: HTMLElement } | null>(null);
  const tipOpen = open !== null;

  const idx = options.findIndex((o) => o.value === value);
  const stopIdx = options[idx]?.disabled ? options.findIndex((o) => !o.disabled) : idx;

  const clearTimer = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const openTip = (v: T, anchor: HTMLElement) => {
    clearTimer();
    setOpen({ value: v, anchor });
  };
  const closeTip = () => {
    clearTimer();
    setOpen(null);
  };
  const scheduleClose = () => {
    clearTimer();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpen(null);
    }, CLOSE_DELAY_MS);
  };

  useEffect(() => clearTimer, []);

  // Esc·스크롤·리사이즈 리스너는 툴팁이 열려 있을 때만 단다(열린 모달의 Esc를 가로채지 않게).
  useEffect(() => {
    if (!tipOpen) return;
    const close = () => {
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
      setOpen(null);
    };
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    }
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [tipOpen]);

  function step(dir: 1 | -1) {
    const n = options.length;
    for (let k = 1; k < n; k++) {
      const next = options[(idx + dir * k + n * k) % n];
      if (!next.disabled) {
        onChange(next.value);
        buttons.current.get(next.value)?.focus();
        return;
      }
    }
  }
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      step(-1);
    }
  }
  const openOption = open ? options.find((o) => o.value === open.value) : undefined;
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-busy={busy ? true : undefined}
      onKeyDown={onKeyDown}
      className={`inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5 ${className}`}
    >
      {options.map((o) => {
        const active = o.value === value;
        const tabStop = options.indexOf(o) === stopIdx;
        const hasTip = o.description !== undefined && o.description !== null;
        const descId = `${baseId}-${o.value}-desc`;
        return (
          <Fragment key={o.value}>
            <button
              ref={(el) => {
                if (el) buttons.current.set(o.value, el);
                else buttons.current.delete(o.value);
              }}
              type="button"
              role="radio"
              aria-checked={active}
              aria-describedby={hasTip ? descId : undefined}
              tabIndex={tabStop ? 0 : -1}
              disabled={o.disabled}
              aria-disabled={o.disabled ? true : undefined}
              onClick={() => onChange(o.value)}
              onPointerEnter={hasTip ? (e) => openTip(o.value, e.currentTarget) : undefined}
              onPointerLeave={hasTip ? scheduleClose : undefined}
              onFocus={
                hasTip
                  ? (e) => {
                      if (e.currentTarget.matches(":focus-visible"))
                        openTip(o.value, e.currentTarget);
                    }
                  : undefined
              }
              onBlur={hasTip ? closeTip : undefined}
              className={`rounded-md px-3.5 py-1 text-sm font-semibold transition-colors ${
                active
                  ? "bg-accent-600 text-white shadow-sm"
                  : o.disabled
                    ? "cursor-not-allowed text-slate-400"
                    : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {o.label}
            </button>
            {hasTip && (
              <span id={descId} hidden>
                {o.description}
              </span>
            )}
          </Fragment>
        );
      })}
      {open && openOption && (
        <OptionTip anchor={open.anchor} onPointerEnter={clearTimer} onPointerLeave={scheduleClose}>
          {openOption.description}
        </OptionTip>
      )}
    </div>
  );
}

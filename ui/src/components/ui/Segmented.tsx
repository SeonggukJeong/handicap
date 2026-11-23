import {
  Fragment,
  useCallback,
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
  const group = useRef<HTMLDivElement>(null);
  // Esc로 초점 툴팁을 닫은 단추 — 그 뒤 마우스로 다시 연 툴팁은 마우스가 떠나면 닫혀야 한다.
  const escDismissed = useRef<T | null>(null);
  // 한 번에 하나만 — 열린 선택지와 그 단추(portal 앵커).
  const [open, setOpen] = useState<{ value: T; anchor: HTMLElement } | null>(null);
  // 열린 값이 아직 설명 있는 선택지로 남아 있을 때만 툴팁이 그려지고 리스너가 달린다.
  const openOption = open ? options.find((o) => o.value === open.value) : undefined;
  const tipOpen = openOption?.description !== undefined && openOption.description !== null;

  const idx = options.findIndex((o) => o.value === value);
  const stopIdx = options[idx]?.disabled ? options.findIndex((o) => !o.disabled) : idx;

  const clearTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const openTip = (v: T, anchor: HTMLElement) => {
    clearTimer();
    setOpen({ value: v, anchor });
  };
  // v를 주면 그 선택지의 툴팁만 닫는다(다른 단추의 마우스·초점 툴팁은 건드리지 않는다).
  const closeTip = useCallback(
    (v?: T) => {
      clearTimer();
      setOpen((cur) => (v === undefined || cur?.value === v ? null : cur));
    },
    [clearTimer],
  );
  // 그 단추가 키보드 초점(:focus-visible)을 쥐고 있으면 마우스가 떠나도 닫지 않는다 — Esc로 닫은 단추는 예외.
  const scheduleClose = (v: T) => {
    const b = buttons.current.get(v);
    if (
      escDismissed.current !== v &&
      b &&
      document.activeElement === b &&
      b.matches(":focus-visible")
    )
      return;
    clearTimer();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpen((cur) => (cur?.value === v ? null : cur));
    }, CLOSE_DELAY_MS);
  };

  useEffect(() => clearTimer, [clearTimer]);

  // Esc·스크롤·리사이즈 리스너는 툴팁이 열려 있을 때만 단다(열린 모달의 Esc를 가로채지 않게).
  useEffect(() => {
    if (!tipOpen) return;
    const close = () => closeTip();
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape") return;
      const inside = group.current?.contains(document.activeElement) ?? false;
      if (inside) {
        e.stopPropagation();
        escDismissed.current =
          [...buttons.current].find(([, el]) => el === document.activeElement)?.[0] ?? null;
      }
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
  }, [tipOpen, closeTip]);

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
  return (
    <div
      ref={group}
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
              onPointerLeave={hasTip ? () => scheduleClose(o.value) : undefined}
              onFocus={
                hasTip
                  ? (e) => {
                      if (escDismissed.current === o.value) escDismissed.current = null;
                      if (e.currentTarget.matches(":focus-visible"))
                        openTip(o.value, e.currentTarget);
                    }
                  : undefined
              }
              onBlur={
                hasTip
                  ? () => {
                      if (escDismissed.current === o.value) escDismissed.current = null;
                      closeTip(o.value);
                    }
                  : undefined
              }
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
      {open && tipOpen && (
        <OptionTip
          anchor={open.anchor}
          onPointerEnter={clearTimer}
          onPointerLeave={() => scheduleClose(open.value)}
        >
          {openOption.description}
        </OptionTip>
      )}
    </div>
  );
}

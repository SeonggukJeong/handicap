// 쪽 나누기 틀: 숨은 측정 시트 → 높이(mm) → 쪽 배치 → A4 쪽. 보고서 종류와 무관한 공용 껍데기.
import { useEffect, useRef, useState, type ReactNode } from "react";
import "./print.css";
import type { Heights } from "./buildPrintDoc";
import { pxToMm, type PageItem } from "./paginate";

export type { Heights };

export type PagedProps = {
  /** 이 값의 identity가 바뀌면 다시 잰다. */
  layoutKey: object;
  /** 숨은 측정 시트 안에 그릴 내용 — 높이를 잴 요소에 data-measure="<id>". */
  sheet: ReactNode;
  place: (h: Heights) => { pages: PageItem[][]; level: number };
  /** `.p-page` 안쪽 전부(꼬리말 포함)를 돌려준다. */
  renderPage: (items: PageItem[], ctx: { n: number; total: number; level: number }) => ReactNode;
  onLevel?: (level: number) => void;
};

type Layout = { key: object; pages: PageItem[][]; level: number };

const SHEET_STYLE = {
  position: "absolute",
  left: "-10000px",
  top: 0,
  width: "180mm",
  visibility: "hidden",
} as const;

function measureHeights(sheet: HTMLElement): Heights {
  const h: Heights = new Map();
  for (const el of sheet.querySelectorAll<HTMLElement>("[data-measure]")) {
    const id = el.getAttribute("data-measure");
    if (id) h.set(id, pxToMm(el.getBoundingClientRect().height));
  }
  return h;
}

export function PagedDocument({ layoutKey, sheet, place, renderPage, onLevel }: PagedProps) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const placeRef = useRef(place);
  const onLevelRef = useRef(onLevel);
  useEffect(() => {
    placeRef.current = place;
    onLevelRef.current = onLevel;
  });
  // layoutKey가 바뀌면 이전 배치는 낡았다 → 다시 측정 시트를 그린다.
  const current = layout && layout.key === layoutKey ? layout : null;

  useEffect(() => {
    let alive = true;
    void Promise.resolve(document.fonts?.ready).then(() => {
      const el = sheetRef.current;
      if (!alive || !el) return;
      const placed = placeRef.current(measureHeights(el));
      setLayout({ key: layoutKey, ...placed });
    });
    return () => {
      alive = false;
    };
  }, [layoutKey]);

  useEffect(() => {
    if (current) onLevelRef.current?.(current.level);
  }, [current]);

  if (!current) {
    return (
      <div className="p-doc" data-layout-ready="false">
        <div ref={sheetRef} className="p-sheet" aria-hidden="true" style={SHEET_STYLE}>
          {sheet}
        </div>
      </div>
    );
  }

  const total = current.pages.length;
  return (
    <div className="p-doc" data-layout-ready="true">
      {current.pages.map((items, i) => {
        const n = i + 1;
        return (
          <div key={i} className={n === total ? "p-page p-page--last" : "p-page"}>
            {renderPage(items, { n, total, level: current.level })}
          </div>
        );
      })}
    </div>
  );
}

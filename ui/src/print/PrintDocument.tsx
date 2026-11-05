// 보고서 문서 렌더: 숨은 측정 시트 → 높이(mm) → 쪽 배치(순수 함수) → A4 쪽. spec §9.
import { useEffect, useRef, useState, type ReactNode } from "react";
import "./print.css";
import {
  standardBlocks,
  summaryBlocks,
  summaryRows,
  type Heights,
  type PrintDoc,
  type PrintKind,
} from "./buildPrintDoc";
import {
  PAGE_BODY_MM,
  chooseSummaryLevel,
  paginate,
  pxToMm,
  type Block,
  type LadderLevel,
  type PageItem,
} from "./paginate";
import { LEGEND_SHORT } from "./stepStatus";
import { ReportHeader } from "./components/ReportHeader";
import { VerdictSection } from "./components/VerdictSection";
import { KpiGrid } from "./components/KpiGrid";
import { AppendixTable, AppendixTitle, OtherCriteria } from "./components/OtherCriteriaTable";
import { StepTable, StepTableTitle, type TableItem } from "./components/StepCodeTable";
import { CalloutLine, Callouts, FoldNotes, Legend, UnreadableNote } from "./components/TableNotes";
import { ErrorChart } from "./components/ErrorChart";
import { ConditionsSection } from "./components/ConditionsSection";
import { GlossarySection } from "./components/GlossarySection";
import { SignatureBlock } from "./components/SignatureBlock";
import { PageFooter } from "./components/PageFooter";

type Props = { doc: PrintDoc; kind: PrintKind; onLadder?: (level: LadderLevel) => void };

type Layout = { doc: PrintDoc; kind: PrintKind; pages: PageItem[][]; level: LadderLevel };

const SHEET_STYLE = {
  position: "absolute",
  left: "-10000px",
  top: 0,
  width: "180mm",
  visibility: "hidden",
} as const;

const SUMMARY_LEVELS: LadderLevel[] = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/** 이 판(kind)에서 쓰일 수 있는 블록 전부(요약판은 사다리 모든 단계의 합집합) — 측정 시트 목록. */
function sheetBlocks(doc: PrintDoc, kind: PrintKind): Block[] {
  const empty: Heights = new Map();
  if (kind === "standard") return standardBlocks(doc, empty);
  const seen = new Set<string>();
  const out: Block[] = [];
  for (const l of SUMMARY_LEVELS) {
    for (const b of summaryBlocks(doc, empty, l)) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      out.push(b);
    }
  }
  return out;
}

function AtomicContent({ id, doc }: { id: string; doc: PrintDoc }): ReactNode {
  switch (id) {
    case "header":
      return <ReportHeader doc={doc} />;
    case "verdict:full":
      return <VerdictSection doc={doc} short={false} />;
    case "verdict:short":
      return <VerdictSection doc={doc} short />;
    case "kpis":
      return <KpiGrid kpis={doc.kpis} />;
    case "other:standard":
      return <OtherCriteria rows={doc.otherRows} mode="standard" />;
    case "other:summary3":
      return <OtherCriteria rows={doc.otherRows} mode="summary3" />;
    case "other:summary1":
      return <OtherCriteria rows={doc.otherRows} mode="summary1" />;
    case "other:line":
      return <OtherCriteria rows={doc.otherRows} mode="line" />;
    case "legend:full":
      return <Legend items={doc.legend} />;
    case "legend:short":
      return <Legend items={[LEGEND_SHORT]} />;
    case "callouts:full":
      return <Callouts doc={doc} />;
    case "callouts:line":
      return <CalloutLine doc={doc} />;
    case "notes:fold":
      return <FoldNotes notes={doc.table.foldNotes} />;
    case "notes:unreadable":
      return <UnreadableNote />;
    case "chart":
      return <ErrorChart doc={doc} />;
    case "conditions":
      return <ConditionsSection doc={doc} />;
    case "glossary":
      return <GlossarySection doc={doc} />;
    case "signature":
      return <SignatureBlock />;
    default:
      return null;
  }
}

function Atomic({ id, doc, measure }: { id: string; doc: PrintDoc; measure?: boolean }) {
  return (
    <div className={`p-block p-block--${id.split(":")[0]}`} data-measure={measure ? id : undefined}>
      <AtomicContent id={id} doc={doc} />
    </div>
  );
}

const stepItems = (doc: PrintDoc): TableItem[] => doc.ranked.map((row) => ({ kind: "step", row }));

/** 요약판 표 항목: 상위 행 + (있으면) 나머지 한 줄 — `summaryBlocks`의 rowsMm 순서와 같다. */
function summaryItems(doc: PrintDoc, level: LadderLevel): TableItem[] {
  const { shown, remainderLine } = summaryRows(doc, level);
  const items: TableItem[] = shown.map((row) => ({ kind: "step", row }));
  if (remainderLine !== null)
    items.push({ kind: "remainder", line: remainderLine, shown: shown.length });
  return items;
}

/** 측정 시트의 단계 표: 모든 행 + 요약판이면 서로 다른 나머지 줄(8·6·4행 기준) 전부. */
function sheetTableItems(doc: PrintDoc, kind: PrintKind): TableItem[] {
  const items = stepItems(doc);
  if (kind === "summary") {
    const seen = new Set<number>();
    for (const l of [0, 7, 8] as LadderLevel[]) {
      const { shown, remainderLine } = summaryRows(doc, l);
      if (remainderLine === null || seen.has(shown.length)) continue;
      seen.add(shown.length);
      items.push({ kind: "remainder", line: remainderLine, shown: shown.length });
    }
  }
  return items;
}

function MeasureSheet({ doc, kind }: { doc: PrintDoc; kind: PrintKind }) {
  return (
    <>
      {sheetBlocks(doc, kind).map((b) => {
        if (b.kind === "atomic") return <Atomic key={b.id} id={b.id} doc={doc} measure />;
        if (b.id === "appendix") {
          return (
            <div key={b.id}>
              <AppendixTitle continued={false} measure />
              <AppendixTable rows={doc.otherRows} from={0} to={doc.otherRows.length} measure />
            </div>
          );
        }
        return (
          <div key={b.id}>
            <StepTableTitle continued={false} measure />
            <StepTable columns={doc.table.columns} items={sheetTableItems(doc, kind)} measure />
          </div>
        );
      })}
    </>
  );
}

function measureHeights(sheet: HTMLElement): Heights {
  const h: Heights = new Map();
  for (const el of sheet.querySelectorAll<HTMLElement>("[data-measure]")) {
    const id = el.getAttribute("data-measure");
    if (id) h.set(id, pxToMm(el.getBoundingClientRect().height));
  }
  return h;
}

function place(
  doc: PrintDoc,
  kind: PrintKind,
  h: Heights,
): { pages: PageItem[][]; level: LadderLevel } {
  if (kind === "standard") {
    const r = paginate(standardBlocks(doc, h), PAGE_BODY_MM);
    if (r.oversized.length > 0) {
      console.warn(`[print] blocks taller than one page: ${r.oversized.join(", ")}`);
    }
    return { pages: r.pages, level: 0 };
  }
  const r = chooseSummaryLevel((l) => summaryBlocks(doc, h, l), PAGE_BODY_MM);
  if (!r.fits) {
    console.warn(
      `[print] summary does not fit one page (level ${r.level}, ${r.pages.length} pages)`,
    );
  }
  return { pages: r.pages, level: r.level };
}

function PageView(props: {
  doc: PrintDoc;
  items: PageItem[];
  tableItems: TableItem[];
  n: number;
  total: number;
}) {
  const { doc, items, tableItems, n, total } = props;
  return (
    <div className={n === total ? "p-page p-page--last" : "p-page"}>
      {items.map((it) => {
        if (it.kind === "atomic") return <Atomic key={it.id} id={it.id} doc={doc} />;
        if (it.id === "appendix") {
          return (
            <div key={`${it.id}:${it.from}`}>
              <AppendixTitle continued={it.continued} />
              <AppendixTable rows={doc.otherRows} from={it.from} to={it.to} />
            </div>
          );
        }
        return (
          <div key={`${it.id}:${it.from}`}>
            <StepTableTitle continued={it.continued} />
            <StepTable columns={doc.table.columns} items={tableItems.slice(it.from, it.to)} />
          </div>
        );
      })}
      <PageFooter doc={doc} n={n} total={total} />
    </div>
  );
}

export function PrintDocument({ doc, kind, onLadder }: Props) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  // doc·kind가 바뀌면 이전 배치는 낡았다 → 다시 측정 시트를 그린다.
  const current = layout && layout.doc === doc && layout.kind === kind ? layout : null;

  useEffect(() => {
    let alive = true;
    void Promise.resolve(document.fonts?.ready).then(() => {
      const sheet = sheetRef.current;
      if (!alive || !sheet) return;
      const placed = place(doc, kind, measureHeights(sheet));
      setLayout({ doc, kind, ...placed });
    });
    return () => {
      alive = false;
    };
  }, [doc, kind]);

  useEffect(() => {
    if (current) onLadder?.(current.level);
  }, [current, onLadder]);

  if (!current) {
    return (
      <div className="p-doc" data-layout-ready="false">
        <div ref={sheetRef} className="p-sheet" aria-hidden="true" style={SHEET_STYLE}>
          <MeasureSheet doc={doc} kind={kind} />
        </div>
      </div>
    );
  }

  const tableItems = kind === "summary" ? summaryItems(doc, current.level) : stepItems(doc);
  return (
    <div className="p-doc" data-layout-ready="true">
      {current.pages.map((items, i) => (
        <PageView
          key={i}
          doc={doc}
          items={items}
          tableItems={tableItems}
          n={i + 1}
          total={current.pages.length}
        />
      ))}
    </div>
  );
}

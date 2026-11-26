// 보고서 문서 렌더: 숨은 측정 시트 → 높이(mm) → 쪽 배치(순수 함수) → A4 쪽. spec §9.
import { useMemo, useRef, type ReactNode } from "react";
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
import { LatencyChart } from "./components/LatencyChart";
import { ErrorChart } from "./components/ErrorChart";
import { ConditionsSection } from "./components/ConditionsSection";
import { GlossarySection } from "./components/GlossarySection";
import {
  StairHeadline,
  StairPrintTable,
  StairStop,
  StairTableTitle,
  StairUnitsNote,
  StairWarnings,
} from "./components/StairPrintTable";
import { SpeedBandTable, SpeedNotes, SpeedTableTitle } from "./components/SpeedBandTable";
import { SetupPrintTable, SetupTableTitle } from "./components/SetupPrintTable";
import { StatsNote, StatsPrintTable, StatsTableTitle } from "./components/StatsPrintTable";
import { StepLatencyRows, StepLatencyTitle } from "./components/StepLatencyAppendix";
import { ko } from "../i18n/ko";
import { SignatureBlock } from "./components/SignatureBlock";
import { PageFooter } from "./components/PageFooter";
import { PagedDocument } from "./PagedDocument";

type Props = { doc: PrintDoc; kind: PrintKind; onLadder?: (level: LadderLevel) => void };

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
    case "stair:stop":
      return doc.stair ? <StairStop stair={doc.stair} /> : null;
    case "stair:headline":
      return doc.stair ? <StairHeadline stair={doc.stair} /> : null;
    case "stair:headline:short":
      return doc.stair ? <StairHeadline stair={doc.stair} short /> : null;
    case "stair:warnings":
      return doc.stair ? <StairWarnings stair={doc.stair} /> : null;
    case "stair:units":
      return doc.stair ? <StairUnitsNote /> : null;
    case "other:standard":
      return (
        <OtherCriteria
          rows={doc.otherRows}
          mode="standard"
          appendixRef={ko.print.section.appendixRef(doc.appendixNo.other)}
        />
      );
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
    case "setup:kinds":
      return doc.setup?.kindsLine ? <p className="p-setup-kinds">{doc.setup.kindsLine}</p> : null;
    case "stats:note":
      return doc.stats?.cappedNote ? <StatsNote text={ko.print.stats.cappedNote} /> : null;
    case "speed:notes":
      return doc.speed ? <SpeedNotes model={doc.speed} /> : null;
    case "chart":
      return <ErrorChart doc={doc} />;
    case "chart:latency":
      return <LatencyChart doc={doc} />;
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
              <AppendixTitle continued={false} measure no={doc.appendixNo.other} />
              <AppendixTable rows={doc.otherRows} from={0} to={doc.otherRows.length} measure />
            </div>
          );
        }
        if (b.id === "steplat") {
          if (!doc.stepLat) return null;
          return (
            <div key={b.id}>
              <StepLatencyTitle
                model={doc.stepLat}
                title={ko.print.section.appendixStepLat(doc.appendixNo.stepLat)}
                continued={false}
                measure
              />
              <StepLatencyRows
                model={doc.stepLat}
                chart={doc.chart}
                from={0}
                to={doc.stepLat.pairs.length}
                measure
              />
            </div>
          );
        }
        if (b.id === "stair" && doc.stair) {
          return (
            <div key={b.id}>
              <StairTableTitle continued={false} measure />
              <StairPrintTable stair={doc.stair} from={0} to={doc.stair.steps.length} measure />
            </div>
          );
        }
        if (b.id === "speed") {
          if (!doc.speed || !doc.sectionNo.speed) return null;
          return (
            <div key={b.id}>
              <SpeedTableTitle title={doc.sectionNo.speed} continued={false} measure />
              <SpeedBandTable
                title={doc.sectionNo.speed}
                model={doc.speed}
                from={0}
                to={doc.speed.rows.length}
                measure
              />
            </div>
          );
        }
        if (b.id === "stats") {
          if (!doc.stats || !doc.sectionNo.stats) return null;
          return (
            <div key={b.id}>
              <StatsTableTitle
                title={doc.sectionNo.stats}
                caption={doc.stats.caption}
                continued={false}
                measure
              />
              <StatsPrintTable
                title={doc.sectionNo.stats}
                model={doc.stats}
                from={0}
                to={doc.stats.rows.length + 1}
                measure
              />
            </div>
          );
        }
        if (b.id === "setup") {
          if (!doc.setup || !doc.sectionNo.setup) return null;
          return (
            <div key={b.id}>
              <SetupTableTitle
                title={doc.sectionNo.setup}
                lead={doc.setup.lead}
                continued={false}
                measure
              />
              <SetupPrintTable
                title={doc.sectionNo.setup}
                model={doc.setup}
                from={0}
                to={doc.setup.rows.length}
                measure
              />
            </div>
          );
        }
        return (
          <div key={b.id}>
            <StepTableTitle continued={false} measure />
            <StepTable
              columns={doc.table.columns}
              items={sheetTableItems(doc, kind)}
              measure
              sample={doc.sample}
            />
          </div>
        );
      })}
    </>
  );
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

function PageBody(props: {
  doc: PrintDoc;
  items: PageItem[];
  tableItems: TableItem[];
  n: number;
  total: number;
}) {
  const { doc, items, tableItems, n, total } = props;
  return (
    <>
      {items.map((it) => {
        if (it.kind === "atomic") return <Atomic key={it.id} id={it.id} doc={doc} />;
        if (it.id === "appendix") {
          return (
            <div key={`${it.id}:${it.from}`}>
              <AppendixTitle continued={it.continued} no={doc.appendixNo.other} />
              <AppendixTable rows={doc.otherRows} from={it.from} to={it.to} />
            </div>
          );
        }
        if (it.id === "steplat") {
          if (!doc.stepLat) return null;
          return (
            <div key={`${it.id}:${it.from}`}>
              <StepLatencyTitle
                model={doc.stepLat}
                title={ko.print.section.appendixStepLat(doc.appendixNo.stepLat)}
                continued={it.continued}
              />
              <StepLatencyRows model={doc.stepLat} chart={doc.chart} from={it.from} to={it.to} />
            </div>
          );
        }
        if (it.id === "stair" && doc.stair) {
          return (
            <div key={`${it.id}:${it.from}`}>
              <StairTableTitle continued={it.continued} />
              <StairPrintTable stair={doc.stair} from={it.from} to={it.to} />
            </div>
          );
        }
        if (it.id === "speed") {
          if (!doc.speed || !doc.sectionNo.speed) return null;
          return (
            <div key={`${it.id}:${it.from}`}>
              <SpeedTableTitle title={doc.sectionNo.speed} continued={it.continued} />
              <SpeedBandTable
                title={doc.sectionNo.speed}
                model={doc.speed}
                from={it.from}
                to={it.to}
              />
            </div>
          );
        }
        if (it.id === "stats") {
          if (!doc.stats || !doc.sectionNo.stats) return null;
          return (
            <div key={`${it.id}:${it.from}`}>
              <StatsTableTitle
                title={doc.sectionNo.stats}
                caption={doc.stats.caption}
                continued={it.continued}
              />
              <StatsPrintTable
                title={doc.sectionNo.stats}
                model={doc.stats}
                from={it.from}
                to={it.to}
              />
            </div>
          );
        }
        if (it.id === "setup") {
          if (!doc.setup || !doc.sectionNo.setup) return null;
          return (
            <div key={`${it.id}:${it.from}`}>
              <SetupTableTitle
                title={doc.sectionNo.setup}
                lead={doc.setup.lead}
                continued={it.continued}
              />
              <SetupPrintTable
                title={doc.sectionNo.setup}
                model={doc.setup}
                from={it.from}
                to={it.to}
              />
            </div>
          );
        }
        return (
          <div key={`${it.id}:${it.from}`}>
            <StepTableTitle continued={it.continued} />
            <StepTable
              columns={doc.table.columns}
              items={tableItems.slice(it.from, it.to)}
              sample={doc.sample}
            />
          </div>
        );
      })}
      <PageFooter doc={doc} n={n} total={total} />
    </>
  );
}

export function PrintDocument({ doc, kind, onLadder }: Props) {
  const layoutKey = useMemo(() => ({ doc, kind }), [doc, kind]);
  // 쪽마다 다시 만들지 않는다: 표준판은 doc당 1번, 요약판은 doc당 단계별 1번.
  const standardItems = useMemo(() => stepItems(doc), [doc]);
  const summaryCache = useRef<{ doc: PrintDoc | null; byLevel: Map<number, TableItem[]> }>({
    doc: null,
    byLevel: new Map(),
  });
  const tableItemsFor = (level: number): TableItem[] => {
    if (kind !== "summary") return standardItems;
    const cache = summaryCache.current;
    if (cache.doc !== doc) {
      cache.doc = doc;
      cache.byLevel = new Map();
    }
    let items = cache.byLevel.get(level);
    if (!items) {
      items = summaryItems(doc, level as LadderLevel);
      cache.byLevel.set(level, items);
    }
    return items;
  };
  return (
    <PagedDocument
      layoutKey={layoutKey}
      sheet={<MeasureSheet doc={doc} kind={kind} />}
      place={(h) => place(doc, kind, h)}
      renderPage={(items, { n, total, level }) => (
        <PageBody doc={doc} items={items} tableItems={tableItemsFor(level)} n={n} total={total} />
      )}
      onLevel={onLadder as ((level: number) => void) | undefined}
    />
  );
}

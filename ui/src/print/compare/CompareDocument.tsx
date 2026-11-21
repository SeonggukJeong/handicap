// 비교 보고서 문서 렌더: 공용 쪽 나누기 틀(PagedDocument) 위에 블록 목록(buildCompareDoc)을 그린다. spec §8·§10.
import { useMemo, type ReactNode } from "react";
import type { Heights } from "../buildPrintDoc";
import { PAGE_BODY_MM, chooseSummaryLevel, paginate, type PageItem } from "../paginate";
import { PagedDocument } from "../PagedDocument";
import { SignatureBlock } from "../components/SignatureBlock";
import {
  CMP_LAST_LEVEL,
  compareSheetBlocks,
  compareStandardBlocks,
  compareSummaryBlocks,
  sectionNo,
  type CompareDoc,
} from "./buildCompareDoc";
import { CompareFooter } from "./components/CompareFooter";
import { CompareHeader } from "./components/CompareHeader";
import { CondTable, CondTitle } from "./components/CondTable";
import { FairCards } from "./components/FairCards";
import { HeadlineHeading, VerdictRow } from "./components/HeadlineBox";
import { IssuesBox } from "./components/IssuesBox";
import { KpiCompareTable, KpiNote } from "./components/KpiCompareTable";

type Kind = "standard" | "summary";
type Props = { doc: CompareDoc; kind: Kind; onLadder?: (level: number) => void };

const ISSUES_PREFIX = "cmp:issues:";

function AtomicContent({ id, doc, kind }: { id: string; doc: CompareDoc; kind: Kind }): ReactNode {
  const no = sectionNo(kind);
  const clamp = kind === "summary";
  if (id.startsWith(ISSUES_PREFIX)) {
    const max = Number(id.slice(ISSUES_PREFIX.length));
    return <IssuesBox doc={doc} no={no.issues} max={max} summary={clamp} />;
  }
  switch (id) {
    case "cmp:header":
      return <CompareHeader doc={doc} clamp={clamp} />;
    case "cmp:headline":
      return <HeadlineHeading no={no.overview} />;
    case "cmp:lines:full":
      return <VerdictRow doc={doc} short={false} clamp={clamp} />;
    case "cmp:lines:short":
      return <VerdictRow doc={doc} short clamp={clamp} />;
    case "cmp:cards":
      return <FairCards doc={doc} line={false} clamp={clamp} />;
    case "cmp:cards:line":
      return <FairCards doc={doc} line clamp={clamp} />;
    case "cmp:kpi:bars":
      return <KpiCompareTable doc={doc} no={no.kpi} bars />;
    case "cmp:kpi:plain":
      return <KpiCompareTable doc={doc} no={no.kpi} bars={false} />;
    case "cmp:kpi:note":
      return <KpiNote doc={doc} clamp={clamp} />;
    case "signature":
      return <SignatureBlock />;
    default:
      return null;
  }
}

/** 블록 위 간격(padding-top)을 고르는 클래스 — 측정 시트와 쪽이 같은 규칙을 쓴다. */
function blockClass(id: string): string {
  if (id === "signature") return "p-block";
  if (id === "cmp:header") return "p-block p-block--header";
  if (id === "cmp:kpi:note") return "p-block p-cmp-b--note";
  if (id.startsWith(ISSUES_PREFIX)) return "p-block p-cmp-b--section";
  const name = id.split(":")[1];
  return name === "headline" || name === "kpi"
    ? "p-block p-cmp-b--section"
    : `p-block p-cmp-b--${name}`;
}

function Atomic(props: { id: string; doc: CompareDoc; kind: Kind; measure?: boolean }) {
  const { id, doc, kind, measure } = props;
  return (
    <div className={blockClass(id)} data-measure={measure ? id : undefined}>
      <AtomicContent id={id} doc={doc} kind={kind} />
    </div>
  );
}

function MeasureSheet({ doc, kind }: { doc: CompareDoc; kind: Kind }) {
  const no = sectionNo(kind);
  return (
    <>
      {compareSheetBlocks(doc, kind).map((b) => {
        if (b.kind === "atomic")
          return <Atomic key={b.id} id={b.id} doc={doc} kind={kind} measure />;
        return (
          <div key={b.id}>
            <CondTitle no={no.cond ?? ""} continued={false} measure />
            <CondTable
              rows={doc.fairness.condRows}
              from={0}
              to={doc.fairness.condRows.length}
              measure
            />
          </div>
        );
      })}
    </>
  );
}

function place(doc: CompareDoc, kind: Kind, h: Heights): { pages: PageItem[][]; level: number } {
  if (kind === "standard") {
    const r = paginate(compareStandardBlocks(doc, h), PAGE_BODY_MM);
    if (r.oversized.length > 0) {
      console.warn(`[print] blocks taller than one page: ${r.oversized.join(", ")}`);
    }
    return { pages: r.pages, level: 0 };
  }
  const r = chooseSummaryLevel(
    (l) => compareSummaryBlocks(doc, h, l),
    PAGE_BODY_MM,
    CMP_LAST_LEVEL,
  );
  if (!r.fits) {
    console.warn(
      `[print] summary does not fit one page (level ${r.level}, ${r.pages.length} pages)`,
    );
  }
  return { pages: r.pages, level: r.level };
}

function PageBody(props: {
  doc: CompareDoc;
  kind: Kind;
  items: PageItem[];
  n: number;
  total: number;
}) {
  const { doc, kind, items, n, total } = props;
  const cond = sectionNo(kind).cond ?? "";
  return (
    <>
      {items.map((it) => {
        if (it.kind === "atomic") return <Atomic key={it.id} id={it.id} doc={doc} kind={kind} />;
        return (
          <div key={`${it.id}:${it.from}`}>
            <CondTitle no={cond} continued={it.continued} />
            <CondTable rows={doc.fairness.condRows} from={it.from} to={it.to} />
          </div>
        );
      })}
      <CompareFooter doc={doc} n={n} total={total} />
    </>
  );
}

export function CompareDocument({ doc, kind, onLadder }: Props) {
  const layoutKey = useMemo(() => ({ doc, kind }), [doc, kind]);
  return (
    <PagedDocument
      layoutKey={layoutKey}
      sheet={<MeasureSheet doc={doc} kind={kind} />}
      place={(h) => place(doc, kind, h)}
      renderPage={(items, { n, total }) => (
        <PageBody doc={doc} kind={kind} items={items} n={n} total={total} />
      )}
      onLevel={onLadder}
    />
  );
}

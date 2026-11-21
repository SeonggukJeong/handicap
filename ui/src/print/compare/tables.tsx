// 표 블록 id → 제목·표·절 번호 정의. 측정 시트와 쪽 렌더가 같은 정의를 쓴다.
import type { JSX } from "react";
import type { CmpTableId, CompareDoc, SectionNos } from "./buildCompareDoc";
import { CondTable, CondTitle } from "./components/CondTable";
import { DumbbellTable, DumbbellTitle } from "./components/DumbbellTable";
import { ErrorChangeTable, ErrorTitle } from "./components/ErrorChangeTable";

export type CmpTableDef = {
  rowCount: (doc: CompareDoc) => number;
  Title: (p: { no: string; continued: boolean; measure?: boolean }) => JSX.Element;
  Table: (p: { doc: CompareDoc; from: number; to: number; measure?: boolean }) => JSX.Element;
  no: (n: SectionNos) => string;
};

const cond: CmpTableDef = {
  rowCount: (doc) => doc.fairness.condRows.length,
  Title: CondTitle,
  Table: ({ doc, from, to, measure }) => (
    <CondTable rows={doc.fairness.condRows} from={from} to={to} measure={measure} />
  ),
  no: (n) => n.cond ?? "",
};

const db: CmpTableDef = {
  rowCount: (doc) => doc.dumbbell.rows.length,
  Title: DumbbellTitle,
  Table: ({ doc, from, to, measure }) => (
    <DumbbellTable model={doc.dumbbell} from={from} to={to} measure={measure} />
  ),
  no: (n) => n.dumbbell ?? "",
};

const err: CmpTableDef = {
  rowCount: (doc) => doc.errors.rows.length,
  Title: ErrorTitle,
  Table: ({ doc, from, to, measure }) => (
    <ErrorChangeTable model={doc.errors} from={from} to={to} measure={measure} />
  ),
  no: (n) => n.errors ?? "",
};

export const CMP_TABLES: Record<CmpTableId, CmpTableDef> = {
  "cmp:cond": cond,
  "cmp:db": db,
  "cmp:err": err,
};

/** 알려진 표 id의 정의. 모르는 id는 null. */
export function cmpTable(id: string): CmpTableDef | null {
  return Object.hasOwn(CMP_TABLES, id) ? CMP_TABLES[id as CmpTableId] : null;
}

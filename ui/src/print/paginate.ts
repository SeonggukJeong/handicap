// 쪽 배치 · 요약판 사다리 선택 (순수 함수, spec §9).

export const PAGE_BODY_MM = 259;
export const PX_PER_MM = 96 / 25.4;
export const pxToMm = (px: number): number => px / PX_PER_MM;

export type Block =
  | { kind: "atomic"; id: string; heightMm: number }
  | { kind: "table"; id: string; titleMm: number; headerMm: number; rowsMm: number[] };

export type PageItem =
  | { kind: "atomic"; id: string }
  | { kind: "tableSlice"; id: string; from: number; to: number; continued: boolean };

export type LadderLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export function totalHeight(blocks: Block[]): number {
  let sum = 0;
  for (const b of blocks) {
    if (b.kind === "atomic") sum += b.heightMm;
    else sum += b.titleMm + b.headerMm + b.rowsMm.reduce((a, r) => a + r, 0);
  }
  return sum;
}

export function paginate(
  blocks: Block[],
  bodyMm: number,
): { pages: PageItem[][]; oversized: string[] } {
  const pages: PageItem[][] = [[]];
  const oversized: string[] = [];
  let used = 0;
  let forceBreak = false;

  const current = (): PageItem[] => pages[pages.length - 1]!;
  const newPage = () => {
    pages.push([]);
    used = 0;
    forceBreak = false;
  };
  // 새 항목 배치 전: 강제 줄바꿈 처리, 안 들어가면 (쪽이 비어있지 않을 때) 새 쪽.
  const ensureRoom = (need: number) => {
    if (forceBreak) newPage();
    if (used + need > bodyMm && current().length > 0) newPage();
  };

  for (const b of blocks) {
    if (b.kind === "atomic") {
      ensureRoom(b.heightMm);
      current().push({ kind: "atomic", id: b.id });
      used += b.heightMm;
      if (b.heightMm > bodyMm) {
        oversized.push(b.id);
        forceBreak = true;
      }
      continue;
    }
    const head = b.titleMm + b.headerMm;
    if (b.rowsMm.length === 0) {
      ensureRoom(head);
      current().push({ kind: "tableSlice", id: b.id, from: 0, to: 0, continued: false });
      used += head;
      if (head > bodyMm) {
        oversized.push(b.id);
        forceBreak = true;
      }
      continue;
    }
    let from = 0;
    while (from < b.rowsMm.length) {
      const first = b.rowsMm[from]!;
      ensureRoom(head + first);
      let to = from + 1;
      let sliceUsed = used + head + first;
      if (head + first > bodyMm) {
        oversized.push(b.id);
        // 최소 1행만 단독 조각
      } else {
        while (to < b.rowsMm.length && sliceUsed + b.rowsMm[to]! <= bodyMm) {
          sliceUsed += b.rowsMm[to]!;
          to++;
        }
      }
      current().push({ kind: "tableSlice", id: b.id, from, to, continued: from > 0 });
      used = sliceUsed;
      from = to;
      if (from < b.rowsMm.length) {
        forceBreak = true;
      } else if (head + first > bodyMm) {
        forceBreak = true;
      }
    }
  }

  if (pages.length > 1 && current().length === 0) pages.pop();
  return { pages, oversized };
}

export function chooseSummaryLevel(
  blocksAt: (level: LadderLevel) => Block[],
  bodyMm: number,
): { level: LadderLevel; pages: PageItem[][]; fits: boolean } {
  let last: { level: LadderLevel; pages: PageItem[][]; fits: boolean } | null = null;
  for (let l = 0; l <= 8; l++) {
    const level = l as LadderLevel;
    const { pages } = paginate(blocksAt(level), bodyMm);
    last = { level, pages, fits: pages.length === 1 };
    if (last.fits) return last;
  }
  return last!;
}

import {
  findStepById,
  findStepSiblings,
  isIfStep,
  isLoopStep,
  isParallelStep,
  type Step,
} from "./model";

// 컨테이너 "밴드"(자식 시퀀스) 좌표계 — 경계 넘는 드롭의 합법성 판정 단일 소스(spec R2).
// band 키는 yamlDoc 경로·엔진 elif 0-based와 1:1: "do"/"then"/"elif_{i}"/"else"/"branch_{i}".
export type BandRef = { parentId: string | null; band: string };
export const TOP_BAND: BandRef = { parentId: null, band: "top" };

export function bandKey(ref: BandRef): string {
  return ref.parentId === null ? "top" : `${ref.parentId}:${ref.band}`;
}

export type BandEntry = { ref: BandRef; children: ReadonlyArray<Step> };

/** 트리의 전 밴드 열거. if의 else는 비어 있어도 등록 — 빈 else가 placeholder
 *  드롭 타깃(spec 케이스 12; else만 min(1)이 아닌 유일한 밴드). */
export function enumerateBands(steps: ReadonlyArray<Step>): BandEntry[] {
  const out: BandEntry[] = [{ ref: TOP_BAND, children: steps }];
  const walk = (list: ReadonlyArray<Step>) => {
    for (const s of list) {
      if (isLoopStep(s)) {
        out.push({ ref: { parentId: s.id, band: "do" }, children: s.do });
        walk(s.do);
      } else if (isIfStep(s)) {
        out.push({ ref: { parentId: s.id, band: "then" }, children: s.then });
        walk(s.then);
        s.elif.forEach((e, i) => {
          out.push({ ref: { parentId: s.id, band: `elif_${i}` }, children: e.then });
          walk(e.then);
        });
        out.push({ ref: { parentId: s.id, band: "else" }, children: s.else });
        walk(s.else);
      } else if (isParallelStep(s)) {
        s.branches.forEach((b, i) => {
          out.push({ ref: { parentId: s.id, band: `branch_${i}` }, children: b.steps });
          walk(b.steps);
        });
      }
    }
  };
  walk(steps);
  return out;
}

export function findParentBand(steps: ReadonlyArray<Step>, stepId: string): BandRef | null {
  for (const b of enumerateBands(steps)) {
    if (b.children.some((c) => c.id === stepId)) return b.ref;
  }
  return null;
}

export function bandChildren(steps: ReadonlyArray<Step>, ref: BandRef): ReadonlyArray<Step> | null {
  const k = bandKey(ref);
  const found = enumerateBands(steps).find((e) => bandKey(e.ref) === k);
  return found ? found.children : null;
}

/** 행 id → 그 행이 속한 bandKey. dragStart 1회 계산해 충돌 후보 필터가
 *  프레임마다 트리를 재탐색하지 않게 한다(N2 — ref로 전달). */
export function bandIndex(steps: ReadonlyArray<Step>): Map<string, string> {
  const m = new Map<string, string>();
  for (const b of enumerateBands(steps)) {
    for (const c of b.children) m.set(c.id, bandKey(b.ref));
  }
  return m;
}

/** 드래그 서브트리에 중첩 컨테이너가 있는가 — 목적지 타입 규칙과 곱해지는
 *  깊이 조건(spec §3-2: 전-http loop만 if 분기로, 전-http-분기 if만 loop do로). */
export function hasNestedContainer(step: Step): boolean {
  if (isLoopStep(step)) return step.do.some((c) => c.type !== "http");
  if (isIfStep(step))
    return (
      step.then.some((c) => c.type !== "http") ||
      step.elif.some((e) => e.then.some((c) => c.type !== "http")) ||
      step.else.some((c) => c.type !== "http")
    );
  if (isParallelStep(step)) return true; // parallel은 어차피 밴드 진입 불가(방어)
  return false;
}

function subtreeIds(step: Step): Set<string> {
  const out = new Set<string>([step.id]);
  const add = (list: ReadonlyArray<Step>) =>
    list.forEach((c) => subtreeIds(c).forEach((id) => out.add(id)));
  if (isLoopStep(step)) add(step.do);
  else if (isIfStep(step)) {
    add(step.then);
    step.elif.forEach((e) => add(e.then));
    add(step.else);
  } else if (isParallelStep(step)) step.branches.forEach((b) => add(b.steps));
  return out;
}

function bandAccepts(steps: ReadonlyArray<Step>, ref: BandRef, dragged: Step): boolean {
  if (ref.parentId === null) return true; // 최상위 = 전 유형
  const parent = findStepById(steps, ref.parentId);
  if (!parent) return false;
  if (isParallelStep(parent)) return dragged.type === "http"; // 레인 = http만
  if (dragged.type === "http") return true; // http는 모든 밴드
  if (dragged.type === "parallel") return false; // parallel = 최상위-only
  const parentIsTop = steps.some((s) => s.id === parent.id);
  if (!parentIsTop) return false; // 중첩 컨테이너 밴드 = http만 (깊이 2 상한)
  if (isLoopStep(parent)) return dragged.type === "if" && !hasNestedContainer(dragged);
  if (isIfStep(parent)) return dragged.type === "loop" && !hasNestedContainer(dragged);
  return false;
}

/** dragStart에 1회 계산하는 합법 드롭 밴드 집합(bandKey). 자기 밴드는 항상
 *  포함(그룹내 재정렬 보존). 소스 규칙: min(1) 밴드(do/then/elif_j/branch_i —
 *  model.ts:139-210)의 마지막 자식은 경계 밖 금지(else·최상위 소스 예외, spec §3-3). */
export function legalTargetBands(steps: ReadonlyArray<Step>, activeId: string): Set<string> {
  const out = new Set<string>();
  const dragged = findStepById(steps, activeId);
  const own = findParentBand(steps, activeId);
  if (!dragged || !own) return out;
  out.add(bandKey(own));
  const siblings = findStepSiblings(steps, activeId);
  const min1Source = own.parentId !== null && own.band !== "else";
  if (min1Source && siblings.length === 1) return out;
  const excluded = subtreeIds(dragged);
  for (const b of enumerateBands(steps)) {
    if (b.ref.parentId !== null && excluded.has(b.ref.parentId)) continue;
    if (bandAccepts(steps, b.ref, dragged)) out.add(bandKey(b.ref));
  }
  return out;
}

/** 포인터 충돌 후보 필터(순수): droppable id 중 합법 밴드의 행 +
 *  합법 빈-밴드 placeholder(`band:{parentId}:{band}`)만. 불법 밴드는 여기서
 *  제외돼 over가 절대 잡히지 않는다 = 불법 드롭 구조 차단(spec R3). */
export function filterDropCandidates(
  ids: ReadonlyArray<string>,
  legal: ReadonlySet<string>,
  index: ReadonlyMap<string, string>,
): string[] {
  return ids.filter((id) => {
    const ph = /^band:([^:]+):(.+)$/.exec(id);
    if (ph) return legal.has(`${ph[1]}:${ph[2]}`);
    const k = index.get(id);
    return k !== undefined && legal.has(k);
  });
}

/** 키보드(포인터 좌표 없음) 후보 — 기존 형제-그룹 제한 그대로(spec R3:
 *  키보드 re-parent는 비목표, 절반-동작 방지). */
export function keyboardCandidateIds(
  steps: ReadonlyArray<Step>,
  activeId: string,
  ids: ReadonlyArray<string>,
): string[] {
  const sib = new Set(findStepSiblings(steps, activeId).map((s) => s.id));
  return ids.filter((id) => sib.has(id));
}

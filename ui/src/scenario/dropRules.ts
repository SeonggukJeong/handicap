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

/** 준비 구획(`setup.steps`) 밴드. 최상위 본 스텝(TOP_BAND)과 키가 다르다. */
export const SETUP_BAND: BandRef = { parentId: null, band: "setup" };
/** 빈 준비 구획의 놓을 자리 id. */
export const SETUP_DROP_ID = "band:setup";
/** 본 스텝이 0개일 때의 놓을 자리 id. */
export const TOP_DROP_ID = "band:top";

export function bandKey(ref: BandRef): string {
  if (ref.parentId === null) return ref.band === "setup" ? "setup" : "top";
  return `${ref.parentId}:${ref.band}`;
}

/** 놓을 자리 id 만들기 — 부모 없는 밴드는 고정 id, 그 밖은 `band:{parentId}:{band}`. */
export function dropId(ref: BandRef): string {
  if (ref.parentId === null) return ref.band === "setup" ? SETUP_DROP_ID : TOP_DROP_ID;
  return `band:${ref.parentId}:${ref.band}`;
}

/** 놓을 자리 id 읽기 — 놓을 자리 id가 아니면 null(행 id). */
export function parseDropId(id: string): BandRef | null {
  if (id === SETUP_DROP_ID) return SETUP_BAND;
  if (id === TOP_DROP_ID) return TOP_BAND;
  const m = /^band:([^:]+):(.+)$/.exec(id);
  return m ? { parentId: m[1], band: m[2] } : null;
}

export type BandEntry = { ref: BandRef; children: ReadonlyArray<Step> };

/** 트리의 전 밴드 열거. if의 else는 비어 있어도 등록 — 빈 else가 placeholder
 *  드롭 타깃(spec 케이스 12; else만 min(1)이 아닌 유일한 밴드). 준비 밴드도
 *  비어 있어도 항상 등록한다(빈 준비 구획이 놓을 자리). */
export function enumerateBands(
  steps: ReadonlyArray<Step>,
  setup: ReadonlyArray<Step> = [],
): BandEntry[] {
  const out: BandEntry[] = [
    { ref: TOP_BAND, children: steps },
    { ref: SETUP_BAND, children: setup },
  ];
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
  walk(setup);
  return out;
}

export function findParentBand(
  steps: ReadonlyArray<Step>,
  stepId: string,
  setup: ReadonlyArray<Step> = [],
): BandRef | null {
  for (const b of enumerateBands(steps, setup)) {
    if (b.children.some((c) => c.id === stepId)) return b.ref;
  }
  return null;
}

export function bandChildren(
  steps: ReadonlyArray<Step>,
  ref: BandRef,
  setup: ReadonlyArray<Step> = [],
): ReadonlyArray<Step> | null {
  const k = bandKey(ref);
  const found = enumerateBands(steps, setup).find((e) => bandKey(e.ref) === k);
  return found ? found.children : null;
}

/** 행 id → 그 행이 속한 bandKey. dragStart 1회 계산해 충돌 후보 필터가
 *  프레임마다 트리를 재탐색하지 않게 한다(N2 — ref로 전달). */
export function bandIndex(
  steps: ReadonlyArray<Step>,
  setup: ReadonlyArray<Step> = [],
): Map<string, string> {
  const m = new Map<string, string>();
  for (const b of enumerateBands(steps, setup)) {
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
  if (ref.parentId === null && ref.band === "setup") return dragged.type === "http"; // 준비 = http만
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
export function legalTargetBands(
  steps: ReadonlyArray<Step>,
  activeId: string,
  setup: ReadonlyArray<Step> = [],
): Set<string> {
  const out = new Set<string>();
  const dragged = findStepById([...setup, ...steps], activeId);
  const own = findParentBand(steps, activeId, setup);
  if (!dragged || !own) return out;
  out.add(bandKey(own));
  const siblings = bandChildren(steps, own, setup) ?? [];
  const min1Source = own.parentId !== null && own.band !== "else";
  if (min1Source && siblings.length === 1) return out;
  const excluded = subtreeIds(dragged);
  for (const b of enumerateBands(steps, setup)) {
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
    const ph = parseDropId(id);
    if (ph) return legal.has(bandKey(ph));
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
  setup: ReadonlyArray<Step> = [],
): string[] {
  const inSetup = setup.some((s) => s.id === activeId);
  const sibs = inSetup ? setup : findStepSiblings(steps, activeId);
  const sib = new Set(sibs.map((s) => s.id));
  return ids.filter((id) => sib.has(id));
}

/** 준비 구획 놓을 자리(빈 준비 구획)가 열려 있는 영역 높이·들어 올림 문턱(px). */
export const SETUP_ZONE_REACH_PX = 24;
export const SETUP_ZONE_LIFT_PX = 8;

/** 빈 준비 구획의 놓을 자리가 열려 있는가. 두 값 모두 목록 내용 좌표(내용 맨 위 = 0, 아래로 +).
 *  포인터가 맨 위 영역 안이고, 집은 자리보다 문턱 넘게 위로 끌어 올렸을 때만 연다. */
export function setupZoneOpen(pointerY: number, grabY: number): boolean {
  return pointerY < SETUP_ZONE_REACH_PX && grabY - pointerY > SETUP_ZONE_LIFT_PX;
}

/** 빈 준비 구획의 놓을 자리가 열려 있는가: 준비가 비어 있고, 합법 목적지에 준비 밴드가 있고,
 *  맨 위 영역에 들어왔을 때만. 키보드로 집은 경우는 호출부가 grabY=null로 걸러 부르지 않는다. */
export function showSetupZone(a: {
  setupCount: number;
  legal: ReadonlySet<string> | null;
  pointerY: number;
  grabY: number;
}): boolean {
  return (
    a.setupCount === 0 &&
    a.legal !== null &&
    a.legal.has(bandKey(SETUP_BAND)) &&
    setupZoneOpen(a.pointerY, a.grabY)
  );
}

/** 놓는 순간 결정: 놓을 자리가 (놓는 순간의 포인터 위치로) 열려 있으면 over와 무관하게 준비로,
 *  닫혀 있는데 over가 낡은 준비 놓을 자리면 무시, 그 밖엔 기존 resolveDrop.
 *  dnd-kit의 over는 충돌 계산보다 늦게 갱신되므로 over만 믿으면 막 열리고 닫힌 직후에 어긋난다. */
export function setupDropDecision(a: {
  open: boolean;
  overId: string | null;
}): "setup" | "none" | "resolve" {
  if (a.open) return "setup";
  return a.overId === SETUP_DROP_ID ? "none" : "resolve";
}

/** 준비 놓을 자리가 이번 충돌 계산의 대상인가. dnd-kit은 over를 overId가 바뀔 때만 다시 찾으므로
 *  droppable이 등록·측정되기 전에 그 id를 돌려주면 over가 null로 굳는다 — 준비될 때까지 "none"(행으로도 새지 않게). */
export function setupZoneCollision(a: {
  open: boolean;
  registered: boolean;
  measured: boolean;
}): "normal" | "none" | "zone" {
  if (!a.open) return "normal";
  return a.registered && a.measured ? "zone" : "none";
}

/** 본 스텝이 0개일 때, 준비 스텝을 끄는 동안 본 스텝 자리의 놓을 자리를 그릴지. */
export function showTopZone(a: { mainCount: number; draggingSetupStep: boolean }): boolean {
  return a.mainCount === 0 && a.draggingSetupStep;
}

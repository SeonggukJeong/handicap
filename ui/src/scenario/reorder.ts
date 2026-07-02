import type { Step } from "./model";
import { findStepSiblings } from "./model";
import { bandChildren, bandKey, findParentBand } from "./dropRules";

// 그룹내 정렬만 (컨테이너 경계 넘기 = 슬라이스 3). over가 같은 형제 그룹에
// 없으면(다른 컨테이너로 드롭) null = no-op.
export function computeReorder(
  siblingIds: string[],
  activeId: string,
  overId: string | null,
): number | null {
  if (overId === null || activeId === overId) return null;
  const idx = siblingIds.indexOf(overId);
  if (idx === -1) return null; // over가 이 그룹 밖
  if (siblingIds.indexOf(activeId) === -1) return null; // active가 이 그룹 밖
  return idx;
}

/** 드래그 종료 이벤트에서 moveStep 인자를 순수하게 도출한다.
 *  active가 속한 형제 그룹 안에서의 재정렬만 허용(그룹 경계 = no-op). */
export function resolveDragEnd(
  steps: Step[],
  activeId: string,
  overId: string | null,
): { stepId: string; toIndex: number } | null {
  const siblings = findStepSiblings(steps, activeId);
  const siblingIds = (siblings ?? steps).map((s) => s.id);
  const toIndex = computeReorder(siblingIds, activeId, overId);
  return toIndex === null ? null : { stepId: activeId, toIndex };
}

export type DropResolution =
  | { kind: "move"; stepId: string; toIndex: number }
  | {
      kind: "reparent";
      stepId: string;
      target: { parentId: string | null; band: string; index: number };
    };

/** 경계-넘기 드롭 해석(spec R4). 같은 밴드 = 기존 computeReorder 결과 verbatim
 *  (half 무시 — 슬라이스 1 재정렬 byte-identical, 리뷰 핀 N1). 교차 밴드 = over 행의
 *  above/below로 앞/뒤 인덱스. placeholder(`band:{parentId}:{band}`) = index 0.
 *  합법성은 상류(충돌 후보 필터)가 보장 — 이 함수는 기계적 해석만. */
export function resolveDrop(
  steps: Step[],
  activeId: string,
  overId: string | null,
  half: "above" | "below" | null,
): DropResolution | null {
  if (overId === null) return null;
  const ph = /^band:([^:]+):(.+)$/.exec(overId);
  if (ph) {
    return {
      kind: "reparent",
      stepId: activeId,
      target: { parentId: ph[1], band: ph[2], index: 0 },
    };
  }
  const ownBand = findParentBand(steps, activeId);
  const overBand = findParentBand(steps, overId);
  if (ownBand === null || overBand === null) return null;
  if (bandKey(ownBand) === bandKey(overBand)) {
    const sibIds = (bandChildren(steps, ownBand) ?? []).map((s) => s.id);
    const toIndex = computeReorder(sibIds, activeId, overId);
    return toIndex === null ? null : { kind: "move", stepId: activeId, toIndex };
  }
  const children = bandChildren(steps, overBand) ?? [];
  const overIdx = children.findIndex((s) => s.id === overId);
  if (overIdx === -1) return null;
  const index = half === "below" ? overIdx + 1 : overIdx;
  return {
    kind: "reparent",
    stepId: activeId,
    target: {
      parentId: overBand.parentId,
      band: overBand.parentId === null ? "top" : overBand.band,
      index,
    },
  };
}

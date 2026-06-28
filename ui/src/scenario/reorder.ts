import type { Step } from "./model";
import { findStepSiblings } from "./model";

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
